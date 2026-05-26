// ==UserScript==
// @name         AIM Quick Mission Editor
// @namespace    http://tampermonkey.net/
// @version      0.1
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Quick_Mission_Editor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Quick_Mission_Editor.user.js
// @description  Bulk-reorder mission instructions via React fiber walk. Ctrl+Click handles to select, Enter to open the move dialog.
// @author       Payden (port of coworker's ReactFiber Mission Editor v19.5)
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// AIM Quick Mission Editor — v0.1 (port of coworker's ReactFiber script)
// Hotkeys: Ctrl+Click drag handle (select) · Enter (open move dialog) · Esc (cancel)
// Log tag: [AIM MB EDITOR]
//
// How it works:
//   Walks React's fiber tree to find Percepto's own reorderInstructions(from, to)
//   function on the context provider, then calls it directly — bypasses the
//   whole react-beautiful-dnd synthetic-drag mess. Genuinely clever; preserved
//   from the original.
//
// v0.1 changes vs the original v19.5:
//   1. @updateURL + @downloadURL → Tampermonkey auto-update works now
//   2. IS_TOP gate → handlers only in the React iframe, no double-fire
//   3. Control Panel integration (REGISTER + master toggle)
//   4. Idempotency guard on the console.log hijack (no wrapper stacking)
//   5. Ant Design input guard (.ant-input / .ant-select / role="textbox")
//      for Enter + Esc — previously fired through Percepto's Ant inputs
//   6. Single log tag [AIM MB EDITOR] (was drifting [AQME] / [AIM Quick…])
//   7. MutationObserver as PRIMARY reorder-completion signal (console.log
//      hijack kept as fallback). If Percepto ever drops the "Reordering
//      instructions:" log line, 200-item moves no longer silently degrade
//      to 10 minutes of 3-second timeouts.
//   8. Abort after 3 consecutive failures — prevents the "burn through every
//      remaining item firing error toasts" scenario when state goes bad.
//   9. Pre-move snapshot stashed at window.__aqme_lastSnapshot so a
//      coworker-yelled-at-you scenario has at least a manual recovery path.

(function () {
    'use strict';

    const SCRIPT_ID = 'aim-quick-mission-editor';
    const SCRIPT_VERSION = '0.1';
    const TAG = '[AIM MB EDITOR]';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const IS_TOP = window === window.top;

    // Cross-frame guard. The React app + draggable list only exist in the
    // iframe context where Percepto mounts react-pages. TOP-frame doesn't
    // see any of it, and running handlers there would double-fire Enter
    // and Esc on every keypress.
    if (IS_TOP) return;

    // Idempotency: avoid double-init if the script re-runs (Tampermonkey
    // update, manual reinject, etc.). Without this, the console.log shim
    // stacks and the launcher elements would duplicate.
    if (window.__aqme_initialized) {
        console.log(`${TAG} v${SCRIPT_VERSION} re-init blocked (already initialized)`);
        return;
    }
    window.__aqme_initialized = true;

    // Keep a clean reference to original console.log for our own logging,
    // and patch console.log ONCE as a fallback reorder-completion signal.
    const _origLog = console.log.bind(console);
    if (!window.__aqme_logPatched) {
        const _previousLog = console.log;
        console.log = function (...args) {
            if (typeof args[0] === 'string' && args[0].includes('Reordering instructions:')) {
                try { window.__aqme_onReorder && window.__aqme_onReorder(args[0]); } catch (e) {}
            }
            return _previousLog.apply(console, args);
        };
        window.__aqme_logPatched = true;
    }

    // ── Control Panel integration ───────────────────────────────────────
    let controlChannel = null;
    let controlPanelDetected = false;
    let masterEnabled = true;

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { return; }
        controlChannel.onmessage = (ev) => {
            controlPanelDetected = true;
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') {
                registerWithControlPanel();
            } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                if (msg.toggleId === 'master') {
                    masterEnabled = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (typeof updateLauncherVisibility === 'function') updateLauncherVisibility();
                }
            }
            // No HOTKEY_FIRED — Enter/Esc are modifier-less and not appropriate
            // to register as Control Panel hotkeys (they'd collide with
            // everything). The script owns its own listeners with strict
            // input guards.
        };
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Quick Mission Editor',
            description: 'Bulk-reorder mission instructions via Ctrl+Click + Enter.',
            version: SCRIPT_VERSION,
            group: 'Mission Bank Macros', scope: 'mission-bank', priority: 10,
            toggles: [{ id: 'master', label: 'Enable', type: 'boolean', default: true, master: true }],
            hotkeys: [], // Enter/Esc owned by the script directly
        });
    }

    setupControlPanel();
    registerWithControlPanel();

    // ── Page-readiness watcher ──────────────────────────────────────────
    function waitForPage(cb) {
        if (!location.href.includes('mission-bank')) return;
        const check = () => document.querySelector('[data-rfd-droppable-id="droppable"]');
        if (check()) { cb(); return; }
        const observer = new MutationObserver(() => {
            if (check()) { observer.disconnect(); clearInterval(poll); cb(); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const poll = setInterval(() => {
            if (check()) { clearInterval(poll); observer.disconnect(); cb(); }
        }, 300);
    }

    // ── Strict typing-target guard (Ant Design aware) ───────────────────
    // Percepto uses Ant Design inputs that don't always render as native
    // <input>. Without these checks, Enter fires the modal mid-text-entry
    // and Esc blows away your selection unexpectedly.
    function isTypingTarget(el) {
        if (!el) return false;
        const t = el.tagName;
        if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
        if (el.isContentEditable) return true;
        if (el.getAttribute && el.getAttribute('role') === 'textbox') return true;
        if (el.closest && el.closest('.ant-input, .ant-select, .ant-select-selection-search-input')) return true;
        return false;
    }

    // ── Main init ───────────────────────────────────────────────────────
    let updateLauncherVisibility = null;

    function init() {
        if (!location.href.includes('mission-bank')) return;

        // Tear down any leftover UI from a prior page (or stale install).
        ['aqme-hud', 'aqme-launcher', 'aqme-bubble-bar', 'aqme-info-tooltip', 'aqme-toast', 'aqme-input-overlay'].forEach(id => {
            const el = document.getElementById(id); if (el) el.remove();
        });

        let selectedGroups = [];
        let isBusy = false;
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        function flatIds() { return selectedGroups.flatMap(g => g.ids); }

        function getFiber(el) {
            const key = Object.keys(el).find(k =>
                k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
            );
            return key ? el[key] : null;
        }

        function findReorderFn() {
            const draggable = document.querySelector('[data-rfd-draggable-id]');
            if (!draggable) return null;
            const fiber = getFiber(draggable);
            if (!fiber) return null;
            let node = fiber, depth = 0;
            while (node && depth < 80) {
                if (node.memoizedProps?.value &&
                    typeof node.memoizedProps.value.reorderInstructions === 'function') {
                    return node.memoizedProps.value.reorderInstructions;
                }
                node = node.return; depth++;
            }
            return null;
        }

        function getAllDraggables() {
            return [...document.querySelectorAll('[data-rfd-draggable-id]')];
        }
        function getIndexById(id) {
            return getAllDraggables().findIndex(el => el.getAttribute('data-rfd-draggable-id') === id);
        }

        function resolveRangeInput(raw) {
            const str = raw.trim();
            const all = getAllDraggables();
            if (/^\d+$/.test(str)) {
                const n = parseInt(str, 10);
                if (n < 1 || n > all.length) return null;
                return [all[n - 1].getAttribute('data-rfd-draggable-id')];
            }
            const m = str.match(/^(\d+)\s*[-–]\s*(\d+)$/);
            if (m) {
                let lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
                if (lo > hi) [lo, hi] = [hi, lo];
                if (lo < 1 || hi > all.length) return null;
                return all.slice(lo - 1, hi).map(el => el.getAttribute('data-rfd-draggable-id'));
            }
            return null;
        }

        // Wait for a reorder to actually take effect. PRIMARY signal:
        // MutationObserver on the droppable — observes the real DOM
        // reorder, not a side-channel log line. FALLBACK: the console.log
        // hijack (which fires if Percepto's log line still exists). Whichever
        // fires first wins. If neither fires within `ms`, resolves false.
        function waitForReorder(movedId, expectedIdx, ms = 3000) {
            return new Promise(resolve => {
                let done = false;
                let obs = null;
                let timer = null;
                const finish = (ok) => {
                    if (done) return;
                    done = true;
                    try { if (obs) obs.disconnect(); } catch (e) {}
                    clearTimeout(timer);
                    window.__aqme_onReorder = null;
                    resolve(ok);
                };
                timer = setTimeout(() => finish(false), ms);
                const droppable = document.querySelector('[data-rfd-droppable-id="droppable"]');
                if (droppable) {
                    obs = new MutationObserver(() => {
                        if (getIndexById(movedId) === expectedIdx) finish(true);
                    });
                    obs.observe(droppable, { childList: true, subtree: false });
                    // Check immediately in case the reorder happened before
                    // we attached the observer (microtask race).
                    if (getIndexById(movedId) === expectedIdx) finish(true);
                }
                // Console.log fallback — fires if Percepto still logs "Reordering instructions:"
                window.__aqme_onReorder = () => finish(true);
            });
        }

        function mergeConsecutiveGroups() {
            if (selectedGroups.length < 2) return;
            const merged = [];
            let run = [...selectedGroups[0].ids];
            for (let i = 1; i < selectedGroups.length; i++) {
                const g = selectedGroups[i];
                if (run.length >= 1 && g.ids.length === 1) {
                    const prevIdx = getIndexById(run[run.length - 1]);
                    const curIdx = getIndexById(g.ids[0]);
                    if (curIdx === prevIdx + 1) { run.push(g.ids[0]); continue; }
                }
                merged.push(makeAutoGroup(run)); run = [...g.ids];
            }
            merged.push(makeAutoGroup(run));
            selectedGroups = merged;
        }

        function makeAutoGroup(ids) {
            if (ids.length === 1) {
                const idx = getIndexById(ids[0]);
                return { ids, label: idx >= 0 ? `#${idx + 1}` : ids[0].slice(0, 8) };
            }
            const lo = getIndexById(ids[0]);
            const hi = getIndexById(ids[ids.length - 1]);
            return { ids, label: `#${lo + 1}–#${hi + 1}` };
        }

        function addGroup(ids, label) {
            const existing = new Set(flatIds());
            const newIds = ids.filter(id => !existing.has(id));
            if (newIds.length === 0) return 0;
            selectedGroups.push({ ids: newIds, label });
            mergeConsecutiveGroups();
            return newIds.length;
        }

        function removeGroup(group) {
            selectedGroups = selectedGroups.filter(g => g !== group);
            mergeConsecutiveGroups();
        }

        function getScrollContainer() {
            const d = document.querySelector('[data-rfd-droppable-id="droppable"]');
            if (!d) return null;
            let el = d.parentElement;
            while (el && el !== document.body) {
                const s = getComputedStyle(el);
                if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
                el = el.parentElement;
            }
            return null;
        }
        function scrollToEl(el, offset = 120) {
            if (!el) return Promise.resolve();
            return new Promise(resolve => {
                const container = getScrollContainer();
                if (container) {
                    const cRect = container.getBoundingClientRect();
                    const eRect = el.getBoundingClientRect();
                    container.scrollTo({ top: Math.max(0, container.scrollTop + (eRect.top - cRect.top) - offset), behavior: 'smooth' });
                } else {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                setTimeout(resolve, 150);
            });
        }

        let dropMarker = null;
        function showDropMarker(afterEl) {
            removeDropMarker();
            if (!afterEl) return;
            dropMarker = document.createElement('div');
            Object.assign(dropMarker.style, {
                height: '3px', background: '#00e676', boxShadow: '0 0 10px #00e676',
                borderRadius: '2px', margin: '2px 0', pointerEvents: 'none',
            });
            afterEl.insertAdjacentElement('afterend', dropMarker);
        }
        function removeDropMarker() { if (dropMarker) { dropMarker.remove(); dropMarker = null; } }

        function flashGreen(el) {
            if (!el) return;
            const inner = el.querySelector('.mission-instruction-item');
            if (!inner) return;
            inner.style.transition = 'background 0.1s';
            inner.style.background = 'rgba(0,230,118,0.15)';
            setTimeout(() => { inner.style.background = ''; setTimeout(() => { inner.style.transition = ''; }, 300); }, 500);
        }

        function showToast(msg, color = '#00bcd4', duration = 2200) {
            const old = document.getElementById('aqme-toast'); if (old) old.remove();
            const toast = document.createElement('div');
            toast.id = 'aqme-toast';
            Object.assign(toast.style, {
                position: 'fixed', top: '24px', left: '50%', transform: 'translateX(-50%)',
                background: '#1a1a1a', border: `1px solid ${color}`, borderRadius: '8px',
                padding: '10px 20px', color: '#fff', fontSize: '13px', fontWeight: '600',
                fontFamily: "'Lato',sans-serif", zIndex: '999999',
                boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                opacity: '0', transition: 'opacity 0.2s ease', pointerEvents: 'none',
            });
            toast.textContent = msg;
            document.body.appendChild(toast);
            requestAnimationFrame(() => {
                toast.style.opacity = '1';
                setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
            });
        }

        function clearHighlights() {
            document.querySelectorAll('[data-rfd-draggable-id]').forEach(el => {
                el.style.outline = ''; el.style.outlineOffset = '';
            });
        }
        function applyHighlights(ids, activeId) {
            clearHighlights();
            ids.forEach(id => {
                const el = document.querySelector(`[data-rfd-draggable-id="${id}"]`);
                if (!el) return;
                el.style.outline = id === activeId ? '2px solid #00e676' : '2px solid #00bcd4';
                el.style.outlineOffset = '-2px';
            });
        }

        const bubbleStyle = document.createElement('style');
        bubbleStyle.textContent = `
            .aqme-bubble { display:inline-flex; align-items:center; gap:4px; background:#222; border:1px solid #444;
                border-radius:20px; padding:3px 10px; font-size:11px; font-weight:600; color:#fff;
                cursor:default; transition:border-color 0.15s; white-space:nowrap; max-width:200px; }
            .aqme-bubble:hover { border-color:#00bcd4; }
            .aqme-bubble .aqme-bx { display:none; cursor:pointer; color:#ff5252; font-size:13px;
                line-height:1; padding:0 2px; margin-left:2px; }
            .aqme-bubble:hover .aqme-bx { display:inline; }
            .aqme-bubble-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#00bcd4; font-weight:700; }
            .aqme-bubble-count { color:#888; font-size:10px; flex-shrink:0; }
        `;
        document.head.appendChild(bubbleStyle);

        function makeBubbleEl(group, onRemove) {
            const b = document.createElement('span');
            b.className = 'aqme-bubble';
            b.title = group.ids.length > 1 ? `${group.ids.length} instructions` : group.label;
            const lbl = document.createElement('span');
            lbl.className = 'aqme-bubble-label';
            lbl.textContent = group.label;
            const bx = document.createElement('span');
            bx.className = 'aqme-bx';
            bx.textContent = '×';
            bx.addEventListener('click', e => { e.stopPropagation(); onRemove(group); });
            b.appendChild(lbl);
            if (group.ids.length > 1) {
                const cnt = document.createElement('span');
                cnt.className = 'aqme-bubble-count';
                cnt.textContent = `×${group.ids.length}`;
                b.appendChild(cnt);
            }
            b.appendChild(bx);
            return b;
        }

        const bubbleBar = document.createElement('div');
        bubbleBar.id = 'aqme-bubble-bar';
        Object.assign(bubbleBar.style, {
            position: 'fixed', bottom: '114px', left: '50%', transform: 'translateX(-50%)',
            display: 'none', flexWrap: 'wrap', gap: '6px',
            justifyContent: 'center', alignItems: 'center',
            maxWidth: '560px', zIndex: '99997',
            padding: '6px 10px',
            background: 'rgba(20,20,20,0.9)',
            border: '1px solid #2a2a2a',
            borderRadius: '10px',
            backdropFilter: 'blur(6px)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            fontFamily: "'Lato','Segoe UI',sans-serif",
        });
        document.body.appendChild(bubbleBar);

        function refreshBubbleBar() {
            bubbleBar.innerHTML = '';
            if (selectedGroups.length === 0) { bubbleBar.style.display = 'none'; return; }
            bubbleBar.style.display = 'flex';
            selectedGroups.forEach(group => {
                bubbleBar.appendChild(makeBubbleEl(group, g => {
                    if (isBusy) return;
                    g.ids.forEach(id => {
                        const el = document.querySelector(`[data-rfd-draggable-id="${id}"]`);
                        if (el) { el.style.outline = ''; el.style.outlineOffset = ''; }
                    });
                    removeGroup(g);
                    refreshBubbleBar();
                    const total = flatIds().length;
                    if (total === 0) { hud.style.display = 'none'; }
                    else { setHUD(`${total} instruction${total > 1 ? 's' : ''} selected`, 'Press Enter to begin', '#00bcd4'); }
                }));
            });
        }

        const hud = document.createElement('div');
        hud.id = 'aqme-hud';
        Object.assign(hud.style, {
            position: 'fixed', bottom: '68px', left: '50%', transform: 'translateX(-50%)',
            background: '#1a1a1a', color: '#fff', border: '1px solid #2a2a2a',
            borderRadius: '10px', padding: '14px 18px', zIndex: '99999',
            fontFamily: "'Lato','Segoe UI',sans-serif", pointerEvents: 'none',
            display: 'none', minWidth: '260px', maxWidth: '360px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.7)',
        });
        const hudTitle = document.createElement('div');
        Object.assign(hudTitle.style, { fontSize: '10px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px' });
        hudTitle.textContent = 'AIM Quick Mission Editor';
        const hudBody = document.createElement('div');
        Object.assign(hudBody.style, { fontSize: '15px', fontWeight: '700', color: '#fff', marginBottom: '2px', lineHeight: '1.3' });
        const hudSub = document.createElement('div');
        Object.assign(hudSub.style, { fontSize: '12px', color: '#fff', marginTop: '4px' });
        const hudProgress = document.createElement('div');
        Object.assign(hudProgress.style, { marginTop: '10px', height: '3px', background: '#2a2a2a', borderRadius: '2px', overflow: 'hidden', display: 'none' });
        const hudProgressBar = document.createElement('div');
        Object.assign(hudProgressBar.style, { height: '100%', background: '#00bcd4', borderRadius: '2px', transition: 'width 0.3s ease', width: '0%' });
        hudProgress.appendChild(hudProgressBar);
        const hudDivider = document.createElement('div');
        Object.assign(hudDivider.style, { borderTop: '1px solid #2a2a2a', margin: '10px 0 8px' });
        const hudHint = document.createElement('div');
        Object.assign(hudHint.style, { fontSize: '11px', color: '#aaa', lineHeight: '1.6' });
        hudHint.innerHTML = `<span style="color:#00bcd4;font-weight:700;">Ctrl+Click</span> handle &nbsp;·&nbsp; <span style="color:#00bcd4;font-weight:700;">Enter</span> to start &nbsp;·&nbsp; <span style="color:#00bcd4;font-weight:700;">Esc</span> to cancel`;
        hud.appendChild(hudTitle); hud.appendChild(hudBody); hud.appendChild(hudSub);
        hud.appendChild(hudProgress); hud.appendChild(hudDivider); hud.appendChild(hudHint);
        document.body.appendChild(hud);

        function setHUD(body, sub, subColor = '#fff', progress = null, total = null) {
            hudBody.textContent = body; hudSub.textContent = sub; hudSub.style.color = subColor;
            if (progress !== null && total !== null) {
                hudProgress.style.display = 'block';
                hudProgressBar.style.width = `${(progress / total) * 100}%`;
            } else { hudProgress.style.display = 'none'; }
            hud.style.display = 'block';
        }

        const launcher = document.createElement('div');
        launcher.id = 'aqme-launcher';
        Object.assign(launcher.style, {
            position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
            background: '#1a1a1a', border: '1px solid #333', borderRadius: '10px',
            padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '8px',
            zIndex: '99998', boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            userSelect: 'none', fontFamily: "'Lato','Segoe UI',sans-serif",
        });
        const bolt = document.createElement('div');
        bolt.innerHTML = `<svg width="12" height="18" viewBox="0 0 12 20" fill="none"><path d="M7 0L0 11H5.5L4.5 20L12 8.5H6.5L7 0Z" fill="#00bcd4"/></svg>`;
        Object.assign(bolt.style, { display: 'flex', alignItems: 'center' });
        const launcherLabel = document.createElement('div');
        Object.assign(launcherLabel.style, { fontSize: '11px', fontWeight: '700', color: '#fff', letterSpacing: '0.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' });
        launcherLabel.textContent = 'Quick Mission Editor';
        const launcherDivider = document.createElement('div');
        Object.assign(launcherDivider.style, { width: '1px', height: '14px', background: '#333' });
        const infoBtn = document.createElement('div');
        infoBtn.textContent = 'i';
        Object.assign(infoBtn.style, {
            width: '18px', height: '18px', borderRadius: '50%', border: '1px solid #444', color: '#aaa',
            fontSize: '11px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', transition: 'color 0.2s, border-color 0.2s', flexShrink: '0',
        });
        launcher.appendChild(bolt); launcher.appendChild(launcherLabel);
        launcher.appendChild(launcherDivider); launcher.appendChild(infoBtn);
        document.body.appendChild(launcher);

        // Wire launcher visibility to master toggle. Exposed as a module-
        // scope reference (updateLauncherVisibility) so the BroadcastChannel
        // handler above can call it on SET_TOGGLE.
        updateLauncherVisibility = () => {
            launcher.style.display = masterEnabled ? 'flex' : 'none';
            if (!masterEnabled) {
                hud.style.display = 'none';
                bubbleBar.style.display = 'none';
                clearHighlights();
                removeDropMarker();
                selectedGroups = [];
            }
        };
        updateLauncherVisibility();

        const infoTooltip = document.createElement('div');
        infoTooltip.id = 'aqme-info-tooltip';
        Object.assign(infoTooltip.style, {
            position: 'fixed', bottom: '68px', left: '50%', transform: 'translateX(-50%)',
            background: '#1a1a1a', border: '1px solid #333', borderRadius: '10px', padding: '18px 22px',
            color: '#fff', fontSize: '12px', lineHeight: '1.8', zIndex: '999999', width: '340px',
            boxShadow: '0 8px 28px rgba(0,0,0,0.8)', display: 'none',
            fontFamily: "'Lato','Segoe UI',sans-serif", pointerEvents: 'none',
        });
        infoTooltip.innerHTML = `
  <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:14px;display:flex;align-items:center;gap:8px;">
    <span style="color:#00bcd4;">⚡</span> How to use
  </div>
  <div style="color:#00bcd4;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px;">1 · Select</div>
  <div style="color:#fff;margin-bottom:12px;font-size:12px;">
    Hold <span style="background:#2a2a2a;padding:1px 6px;border-radius:3px;font-weight:700;color:#00bcd4;">Ctrl</span>
    and click the <span style="color:#00bcd4;font-weight:700;">⠿</span> drag handle to pick individual instructions.
    Consecutive picks are grouped into a range automatically.
    <br><br>
    <em>Or</em> press <span style="background:#2a2a2a;padding:1px 6px;border-radius:3px;font-weight:700;color:#00bcd4;">Enter</span>
    to open the modal and type a range like
    <span style="background:#2a2a2a;padding:1px 6px;border-radius:3px;font-weight:700;color:#00bcd4;">153-197</span>.
  </div>
  <div style="color:#00bcd4;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px;">2 · Move</div>
  <div style="color:#fff;margin-bottom:12px;font-size:12px;">
    In the modal, set the target position and click <span style="background:#2a2a2a;padding:1px 6px;border-radius:3px;font-weight:700;color:#00bcd4;">Move ⚡</span>.
  </div>
  <div style="color:#00bcd4;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px;">3 · Cancel</div>
  <div style="color:#fff;font-size:12px;">Press <span style="background:#2a2a2a;padding:1px 6px;border-radius:3px;font-weight:700;color:#00bcd4;">Esc</span> at any time.</div>`;

        infoBtn.addEventListener('mouseenter', () => { infoBtn.style.color = '#00bcd4'; infoBtn.style.borderColor = '#00bcd4'; infoTooltip.style.display = 'block'; });
        infoBtn.addEventListener('mouseleave', () => { infoBtn.style.color = '#aaa'; infoBtn.style.borderColor = '#444'; infoTooltip.style.display = 'none'; });
        document.body.appendChild(infoTooltip);

        const modalBubbleStyleEl = document.createElement('style');
        modalBubbleStyleEl.id = 'aqme-modal-bubble-style';
        modalBubbleStyleEl.textContent = `
            .aqme-mbubble { display:inline-flex; align-items:center; gap:3px; background:#222; border:1px solid #444;
                border-radius:20px; padding:2px 8px; font-size:11px; font-weight:600; color:#fff;
                cursor:default; transition:border-color 0.15s; white-space:nowrap; max-width:180px; }
            .aqme-mbubble:hover { border-color:#00bcd4; }
            .aqme-mbubble .aqme-mbx { display:none; cursor:pointer; color:#ff5252; font-size:13px; line-height:1; padding:0 1px; margin-left:2px; }
            .aqme-mbubble:hover .aqme-mbx { display:inline; }
            .aqme-mbubble-label { color:#00bcd4; font-weight:700; overflow:hidden; text-overflow:ellipsis; }
            .aqme-mbubble-count { color:#888; font-size:10px; flex-shrink:0; }
            .aqme-modal-empty { color:#555; font-size:11px; font-style:italic; }
        `;
        document.head.appendChild(modalBubbleStyleEl);

        // ── Position + range modal ───────────────────────────────────────
        function showPositionInput(initialGroups, total, onConfirm, onCancel) {
            const old = document.getElementById('aqme-input-overlay'); if (old) old.remove();

            let pendingGroups = initialGroups.map(g => ({ ids: [...g.ids], label: g.label }));

            function pendingFlatIds() { return pendingGroups.flatMap(g => g.ids); }

            function mergeModalConsecutive() {
                if (pendingGroups.length < 2) return;
                const merged = [];
                let run = [...pendingGroups[0].ids];
                for (let i = 1; i < pendingGroups.length; i++) {
                    const g = pendingGroups[i];
                    if (g.ids.length === 1 && run.length >= 1) {
                        const prevIdx = getIndexById(run[run.length - 1]);
                        const curIdx = getIndexById(g.ids[0]);
                        if (curIdx === prevIdx + 1) { run.push(g.ids[0]); continue; }
                    }
                    merged.push(makeAutoGroup(run)); run = [...g.ids];
                }
                merged.push(makeAutoGroup(run));
                pendingGroups = merged;
            }

            const overlay = document.createElement('div');
            overlay.id = 'aqme-input-overlay';
            Object.assign(overlay.style, {
                position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                background: 'rgba(0,0,0,0.55)', zIndex: '1000000',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: "'Lato','Segoe UI',sans-serif",
            });

            const box = document.createElement('div');
            Object.assign(box.style, {
                background: '#1a1a1a', border: '1px solid #333', borderRadius: '12px',
                padding: '28px 32px', minWidth: '360px', maxWidth: '460px',
                boxShadow: '0 12px 40px rgba(0,0,0,0.8)',
                display: 'flex', flexDirection: 'column', gap: '16px',
            });

            const title = document.createElement('div');
            Object.assign(title.style, { fontSize: '14px', fontWeight: '700', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' });
            title.innerHTML = `<span style="color:#00bcd4;">⚡</span> Move instructions`;

            const modalBubbleWrap = document.createElement('div');
            Object.assign(modalBubbleWrap.style, {
                display: 'flex', flexWrap: 'wrap', gap: '5px',
                background: '#111', border: '1px solid #2a2a2a', borderRadius: '8px',
                padding: '8px 10px', minHeight: '36px', transition: 'border-color 0.2s',
            });

            const selCount = document.createElement('div');
            Object.assign(selCount.style, { fontSize: '11px', color: '#555', textAlign: 'right', marginTop: '-10px' });

            function renderModalBubbles() {
                modalBubbleWrap.innerHTML = '';
                if (pendingGroups.length === 0) {
                    const empty = document.createElement('span');
                    empty.className = 'aqme-modal-empty';
                    empty.textContent = 'No instructions selected';
                    modalBubbleWrap.appendChild(empty);
                    selCount.textContent = '';
                    return;
                }
                pendingGroups.forEach(group => {
                    const b = document.createElement('span');
                    b.className = 'aqme-mbubble';
                    b.title = group.ids.length > 1 ? `${group.ids.length} instructions` : group.label;
                    const lbl = document.createElement('span'); lbl.className = 'aqme-mbubble-label'; lbl.textContent = group.label;
                    const bx = document.createElement('span'); bx.className = 'aqme-mbx'; bx.textContent = '×';
                    bx.addEventListener('click', e => {
                        e.stopPropagation();
                        pendingGroups = pendingGroups.filter(g => g !== group);
                        renderModalBubbles();
                        syncBubbleBarFromPending();
                    });
                    b.appendChild(lbl);
                    if (group.ids.length > 1) {
                        const cnt = document.createElement('span'); cnt.className = 'aqme-mbubble-count'; cnt.textContent = `×${group.ids.length}`;
                        b.appendChild(cnt);
                    }
                    b.appendChild(bx);
                    modalBubbleWrap.appendChild(b);
                });
                const n = pendingFlatIds().length;
                selCount.textContent = `${n} instruction${n > 1 ? 's' : ''} queued`;
                selCount.style.color = '#00bcd4';
            }

            function syncBubbleBarFromPending() {
                bubbleBar.innerHTML = '';
                if (pendingGroups.length === 0) { bubbleBar.style.display = 'none'; return; }
                bubbleBar.style.display = 'flex';
                pendingGroups.forEach(group => {
                    bubbleBar.appendChild(makeBubbleEl(group, g => {
                        pendingGroups = pendingGroups.filter(pg => pg !== g);
                        renderModalBubbles();
                        syncBubbleBarFromPending();
                    }));
                });
            }

            renderModalBubbles();
            syncBubbleBarFromPending();

            const rangeSeparator = document.createElement('div');
            Object.assign(rangeSeparator.style, { borderTop: '1px solid #2a2a2a', paddingTop: '4px' });
            const rangeLabel = document.createElement('div');
            Object.assign(rangeLabel.style, { fontSize: '10px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' });
            rangeLabel.textContent = 'Add by range (e.g. 153-197 or 42)';

            const rangeRow = document.createElement('div');
            Object.assign(rangeRow.style, { display: 'flex', gap: '8px' });

            const rangeInput = document.createElement('input');
            rangeInput.type = 'text'; rangeInput.placeholder = 'e.g. 153-197';
            Object.assign(rangeInput.style, {
                flex: '1', background: '#111', border: '1px solid #444', borderRadius: '6px',
                color: '#fff', fontSize: '14px', fontWeight: '600', padding: '7px 10px',
                outline: 'none', fontFamily: "'Lato','Segoe UI',sans-serif",
            });
            rangeInput.addEventListener('focus', () => { rangeInput.style.borderColor = '#00bcd4'; });
            rangeInput.addEventListener('blur', () => { rangeInput.style.borderColor = '#444'; });

            const rangeBtn = document.createElement('button');
            rangeBtn.textContent = 'Add';
            Object.assign(rangeBtn.style, {
                background: '#222', border: '1px solid #444', borderRadius: '6px',
                color: '#00bcd4', fontSize: '12px', fontWeight: '700', padding: '7px 14px',
                cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: "'Lato',sans-serif",
            });

            const rangeError = document.createElement('div');
            Object.assign(rangeError.style, { fontSize: '11px', color: '#ff5252', minHeight: '16px', marginTop: '-4px' });

            function flushRangeInput() {
                const raw = rangeInput.value.trim();
                if (!raw) return;
                const ids = resolveRangeInput(raw);
                if (!ids) return;
                const str = raw.trim();
                const isRange = /^(\d+)\s*[-–]\s*(\d+)$/.test(str);
                const label = isRange ? `#${str.replace(/\s*[-–]\s*/, '–#')}` : `#${str}`;
                const existing = new Set(pendingFlatIds());
                const newIds = ids.filter(id => !existing.has(id));
                if (newIds.length === 0) return;
                pendingGroups.push({ ids: newIds, label });
                mergeModalConsecutive();
                rangeInput.value = '';
                renderModalBubbles();
                syncBubbleBarFromPending();
            }

            function applyRange() {
                const raw = rangeInput.value.trim();
                if (!raw) return;
                const ids = resolveRangeInput(raw);
                if (!ids) {
                    rangeError.textContent = `Invalid range — must be within 1–${total}`;
                    rangeInput.style.borderColor = '#ff5252';
                    setTimeout(() => { rangeInput.style.borderColor = '#444'; rangeError.textContent = ''; }, 1800);
                    return;
                }
                const str = raw.trim();
                const isRange = /^(\d+)\s*[-–]\s*(\d+)$/.test(str);
                const label = isRange ? `#${str.replace(/\s*[-–]\s*/, '–#')}` : `#${str}`;
                const existing = new Set(pendingFlatIds());
                const newIds = ids.filter(id => !existing.has(id));
                if (newIds.length === 0) {
                    rangeError.textContent = 'Already in selection';
                    setTimeout(() => { rangeError.textContent = ''; }, 1500);
                    return;
                }
                pendingGroups.push({ ids: newIds, label });
                mergeModalConsecutive();
                rangeError.textContent = '';
                rangeInput.value = '';
                renderModalBubbles();
                syncBubbleBarFromPending();
                modalBubbleWrap.style.borderColor = '#00e676';
                setTimeout(() => { modalBubbleWrap.style.borderColor = '#2a2a2a'; }, 600);
                rangeInput.focus();
            }

            rangeBtn.addEventListener('click', applyRange);
            rangeInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyRange(); }
                if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            });
            rangeRow.appendChild(rangeInput); rangeRow.appendChild(rangeBtn);

            const posSeparator = document.createElement('div');
            Object.assign(posSeparator.style, { borderTop: '1px solid #2a2a2a', paddingTop: '4px' });
            const posLabel = document.createElement('div');
            Object.assign(posLabel.style, { fontSize: '10px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' });
            posLabel.textContent = `Insert after position (0 = before everything, max ${total})`;

            const posInput = document.createElement('input');
            posInput.type = 'number'; posInput.min = '0'; posInput.max = String(total); posInput.placeholder = '0';
            Object.assign(posInput.style, {
                flex: '1', background: '#111', border: '1px solid #444', borderRadius: '6px',
                color: '#fff', fontSize: '18px', fontWeight: '700', padding: '8px 12px',
                outline: 'none', fontFamily: "'Lato','Segoe UI',sans-serif", width: '100%', boxSizing: 'border-box',
            });
            posInput.addEventListener('focus', () => { posInput.style.borderColor = '#00bcd4'; });
            posInput.addEventListener('blur', () => { posInput.style.borderColor = '#444'; });
            posInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); confirm(); }
                if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            });

            const btnRow = document.createElement('div');
            Object.assign(btnRow.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            Object.assign(cancelBtn.style, {
                background: 'transparent', border: '1px solid #444', borderRadius: '6px',
                color: '#aaa', fontSize: '12px', padding: '7px 16px', cursor: 'pointer', fontFamily: "'Lato',sans-serif",
            });

            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = 'Move ⚡';
            Object.assign(confirmBtn.style, {
                background: '#00bcd4', border: 'none', borderRadius: '6px',
                color: '#000', fontSize: '12px', fontWeight: '700', padding: '7px 16px',
                cursor: 'pointer', fontFamily: "'Lato',sans-serif",
            });

            btnRow.appendChild(cancelBtn); btnRow.appendChild(confirmBtn);

            box.appendChild(title);
            box.appendChild(modalBubbleWrap);
            box.appendChild(selCount);
            box.appendChild(rangeSeparator);
            box.appendChild(rangeLabel);
            box.appendChild(rangeRow);
            box.appendChild(rangeError);
            box.appendChild(posSeparator);
            box.appendChild(posLabel);
            box.appendChild(posInput);
            box.appendChild(btnRow);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            setTimeout(() => { if (pendingGroups.length === 0) rangeInput.focus(); else posInput.focus(); }, 50);

            function confirm() {
                flushRangeInput();
                if (pendingGroups.length === 0) {
                    modalBubbleWrap.style.borderColor = '#ff5252';
                    setTimeout(() => { modalBubbleWrap.style.borderColor = '#2a2a2a'; }, 800);
                    return;
                }
                const val = parseInt(posInput.value, 10);
                if (isNaN(val) || val < 0 || val > total) {
                    posInput.style.borderColor = '#ff5252';
                    setTimeout(() => { posInput.style.borderColor = '#444'; }, 800);
                    posInput.focus(); return;
                }
                overlay.remove();
                onConfirm(pendingGroups.flatMap(g => g.ids), val);
            }

            function cancel() {
                flushRangeInput();
                overlay.remove();
                onCancel(pendingGroups);
            }

            confirmBtn.addEventListener('click', confirm);
            cancelBtn.addEventListener('click', cancel);
            overlay.addEventListener('mousedown', e => { if (e.target === overlay) cancel(); });
        }

        // ── Queue processor ──────────────────────────────────────────────
        async function processQueue(ids, insertAfterPos) {
            // Snapshot the current order so we have a manual recovery record
            // if the queue corrupts state mid-loop. Coworker yells at you →
            // open DevTools → read window.__aqme_lastSnapshot → manually
            // restore. Cheap insurance for a destructive op.
            const snapshot = getAllDraggables().map(el => el.getAttribute('data-rfd-draggable-id'));
            window.__aqme_lastSnapshot = snapshot;
            _origLog(`${TAG} pre-move snapshot saved (${snapshot.length} items) to window.__aqme_lastSnapshot`);

            isBusy = true;
            selectedGroups = []; refreshBubbleBar();
            const total = ids.length;
            let placementIndex = insertAfterPos;
            let consecutiveErrors = 0;
            const MAX_CONSECUTIVE_ERRORS = 3;

            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                applyHighlights(ids.slice(i), id);
                const dragEl = document.querySelector(`[data-rfd-draggable-id="${id}"]`);
                const name = dragEl?.querySelector('.mission-instruction-item__title__name')?.textContent?.trim() || id;
                setHUD(`Moving: ${name}`, `${i + 1} of ${total}`, '#fff', i, total);
                await scrollToEl(dragEl, 150);

                const fromIndex = getIndexById(id);
                if (fromIndex < 0) {
                    consecutiveErrors++;
                    showToast(`⚠️ Not found: ${name} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`, '#ff5252', 2500);
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { abortQueue('not found'); return; }
                    continue;
                }

                const targetIdx = fromIndex < placementIndex ? placementIndex - 1 : placementIndex;
                _origLog(`${TAG} reorderInstructions("${name}", ${fromIndex} → ${targetIdx})`);

                const reorderFn = findReorderFn();
                if (!reorderFn) {
                    showToast('⚠️ reorderInstructions not found — aborting', '#ff5252', 4000);
                    abortQueue('no reorderFn');
                    return;
                }

                const reorderPromise = waitForReorder(id, targetIdx, 3000);
                try {
                    reorderFn(fromIndex, targetIdx);
                } catch (e) {
                    consecutiveErrors++;
                    _origLog(`${TAG} reorderFn threw:`, e.message);
                    showToast(`⚠️ Error: ${e.message} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`, '#ff5252', 3000);
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { abortQueue('repeated errors'); return; }
                    continue;
                }

                const ok = await reorderPromise;
                if (!ok) {
                    consecutiveErrors++;
                    _origLog(`${TAG} reorder timeout for "${name}"`);
                    showToast(`⚠️ Reorder timed out: ${name} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`, '#ff5252', 3000);
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { abortQueue('repeated timeouts'); return; }
                    continue;
                }

                consecutiveErrors = 0; // success — reset the strike counter
                placementIndex = targetIdx + 1;
                const movedEl = document.querySelector(`[data-rfd-draggable-id="${id}"]`);
                flashGreen(movedEl); showDropMarker(movedEl);
                await sleep(50);
            }

            clearHighlights(); removeDropMarker();
            setHUD('✓ All done!', `${total} instruction${total > 1 ? 's' : ''} moved`, '#00e676');
            hudProgress.style.display = 'none';
            showToast(`⚡ ${total} instructions moved`, '#00e676', 3000);
            setTimeout(() => { hud.style.display = 'none'; isBusy = false; }, 3500);
        }

        function abortQueue(reason) {
            _origLog(`${TAG} aborting queue: ${reason}`);
            showToast(`⚠️ Aborted (${reason}). Snapshot at window.__aqme_lastSnapshot.`, '#ff5252', 5000);
            clearHighlights();
            removeDropMarker();
            hud.style.display = 'none';
            isBusy = false;
        }

        // ── Ctrl+Click ───────────────────────────────────────────────────
        document.addEventListener('click', function (e) {
            if (!masterEnabled) return;
            if (!e.ctrlKey) return;
            const handle = e.target.closest('.mission-instruction-item__drag');
            if (!handle) return;
            e.preventDefault(); e.stopPropagation();
            if (isBusy) return;
            const draggable = handle.closest('[data-rfd-draggable-id]');
            if (!draggable) return;
            const id = draggable.getAttribute('data-rfd-draggable-id');

            const existingGroup = selectedGroups.find(g => g.ids.includes(id));
            if (existingGroup) {
                if (existingGroup.ids.length === 1) {
                    removeGroup(existingGroup);
                } else {
                    const idx = existingGroup.ids.indexOf(id);
                    const before = existingGroup.ids.slice(0, idx);
                    const after = existingGroup.ids.slice(idx + 1);
                    selectedGroups = selectedGroups.filter(g => g !== existingGroup);
                    if (before.length) selectedGroups.push(makeAutoGroup(before));
                    if (after.length) selectedGroups.push(makeAutoGroup(after));
                }
                draggable.style.outline = ''; draggable.style.outlineOffset = '';
                refreshBubbleBar();
                const total = flatIds().length;
                if (total === 0) { hud.style.display = 'none'; return; }
                setHUD(`${total} instruction${total > 1 ? 's' : ''} selected`, 'Press Enter to begin', '#00bcd4');
                return;
            }

            if (selectedGroups.length === 0) showToast('⚡ Ctrl+Click more handles · Enter to start', '#00bcd4', 3000);
            const idx = getIndexById(id);
            addGroup([id], idx >= 0 ? `#${idx + 1}` : id.slice(0, 8));
            draggable.style.outline = '2px solid #00bcd4'; draggable.style.outlineOffset = '-2px';
            refreshBubbleBar();

            const total = flatIds().length;
            setHUD(`${total} instruction${total > 1 ? 's' : ''} selected`, 'Press Enter to begin', '#00bcd4');
            hudProgress.style.display = 'none';
        }, true);

        // ── Enter ───────────────────────────────────────────────────────
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            if (!masterEnabled) return;
            if (isBusy) return;
            // Ant-aware input guard — blocks Enter while typing in Ant inputs,
            // selects, content-editables, role="textbox" divs, etc. Without
            // this, Enter in a Percepto search/dropdown opens the move modal.
            if (isTypingTarget(document.activeElement)) return;
            const total = getAllDraggables().length;
            const pendingGroups = selectedGroups.map(g => ({ ids: [...g.ids], label: g.label }));
            selectedGroups = []; clearHighlights(); refreshBubbleBar();
            showPositionInput(
                pendingGroups, total,
                (finalIds, pos) => { applyHighlights(finalIds, finalIds[0]); processQueue(finalIds, pos); },
                (savedGroups) => {
                    selectedGroups = savedGroups;
                    applyHighlights(flatIds(), null);
                    refreshBubbleBar();
                    const n = flatIds().length;
                    if (n > 0) setHUD(`${n} instruction${n > 1 ? 's' : ''} selected`, 'Press Enter to begin', '#00bcd4');
                }
            );
        });

        // ── Escape ───────────────────────────────────────────────────────
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (!masterEnabled) return;
            if (isBusy || document.getElementById('aqme-input-overlay')) return;
            if (isTypingTarget(document.activeElement)) return;
            selectedGroups = []; clearHighlights(); removeDropMarker(); refreshBubbleBar();
            hud.style.display = 'none';
            showToast('Cancelled', '#888', 1500);
        });

        _origLog(`${TAG} v${SCRIPT_VERSION} loaded`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => waitForPage(init));
    } else {
        waitForPage(init);
    }
})();
