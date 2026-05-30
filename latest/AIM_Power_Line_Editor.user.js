// ==UserScript==
// @name         Latest - AIM Power Line Editor
// @namespace    http://tampermonkey.net/
// @version      0.2
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Power_Line_Editor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Power_Line_Editor.user.js
// @description  Floating left-edge toolbar to enter Power Lines edit mode. M1 click any power line → drops vertex handles via Map Styler's existing vertex-edit. Add Line / Commit / Discard buttons + dirty-count badge. Drives Map Styler v34.44+ over AIM_POWER_LINE_EDIT channel.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// What this is
// ============
// A separate-from-Map-Styler editor for KML power lines. Map Styler already
// has the full back-end (enterVertexEdit, enterDrawMode, commitKMLChanges,
// commitOps queue, GitHub PUT pipeline) — this script is the discoverable
// UX layer on top:
//   - Floating ⚡ master toggle on the map's left edge, always visible
//   - When ON, expands a strip of edit buttons (Add Line, Commit, Discard)
//     and starts capturing M1 clicks on power-line SVG paths
//   - M1 on a line → calls Map Styler's enterVertexEdit via channel
//   - When OFF, M1 passes through normally — no behavior change vs today
//   - Dirty-count badge stays in sync via STATUS broadcasts from Styler
//
// All state lives in Map Styler. This script holds NO commit ops, no KML
// data, no GitHub talk. It's purely UI + click detection + channel I/O.
// Log tag: [AIM PLE]

(function () {
    'use strict';

    const TAG = '[AIM PLE]';
    const SCRIPT_VERSION = '0.2';
    const IS_TOP = window === window.top;
    const FRAME = IS_TOP ? 'TOP' : 'IFRAME';

    // Persistent master toggle in localStorage so the editor remembers
    // it was ON across reloads. NOT GM_setValue — we want it shared
    // across @name (so Latest + future prod versions see the same state).
    const MASTER_STORAGE_KEY = 'aim-ple-master';
    function readMaster() {
        try { return localStorage.getItem(MASTER_STORAGE_KEY) === 'true'; }
        catch (e) { return false; }
    }
    function writeMaster(on) {
        try { localStorage.setItem(MASTER_STORAGE_KEY, on ? 'true' : 'false'); }
        catch (e) {}
    }

    // ------- Channel I/O -------
    const PLE_CHANNEL_NAME = 'AIM_POWER_LINE_EDIT';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const MAP_STYLER_SCRIPT_ID = 'aim-map-styler';

    let pleChannel = null;
    let controlChannel = null;
    let status = {
        siteID: null,
        distroCount: 0,
        transCount: 0,
        vertexEditActive: false,
        vertexEditType: null,
        vertexEditPmIdx: null,
        drawModeActive: false,
        drawModeType: null,
    };

    function setupChannels() {
        try { pleChannel = new BroadcastChannel(PLE_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} PLE channel unavailable:`, e); }
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} control channel unavailable:`, e); }
        if (pleChannel) {
            pleChannel.onmessage = (ev) => {
                const m = ev.data || {};
                if (m.type === 'STATUS') {
                    status = { ...status, ...m };
                    renderToolbar();
                }
            };
        }
    }

    function sendPle(payload) {
        if (!pleChannel) return;
        try { pleChannel.postMessage(payload); } catch (e) {}
    }
    function requestStatus() { sendPle({ type: 'REQUEST_STATUS' }); }

    // Flip Map Styler's per-category edit-mode toggles via the existing
    // Control Panel SET_TOGGLE mechanism. Map Styler already listens for
    // these on AIM_CONTROL_CHANNEL — no new code in Styler needed for
    // toggle flipping. Also persists into Control Panel prefs so the
    // toggle UI in the gear menu stays in sync.
    function setStylerEditMode(on) {
        if (!controlChannel) return;
        ['distro.edit-mode', 'trans.edit-mode'].forEach(toggleId => {
            try {
                controlChannel.postMessage({
                    type: 'SET_TOGGLE',
                    scriptId: MAP_STYLER_SCRIPT_ID,
                    toggleId,
                    value: on,
                    enabled: on,
                });
            } catch (e) {}
        });
    }

    // ------- Master toggle state -------
    let masterOn = readMaster();

    function setMaster(on) {
        if (on === masterOn) return;
        masterOn = on;
        writeMaster(on);
        setStylerEditMode(on);
        if (on) {
            installClickInterceptor();
            requestStatus();
        } else {
            uninstallClickInterceptor();
            // If a vertex edit or draw was in progress, exit it cleanly
            // so the user isn't left with stranded handles.
            if (status.vertexEditActive) sendPle({ type: 'EXIT_VERTEX_EDIT', save: false });
            // Drawing mode: no "exit without saving" message yet; user can
            // press Esc which Styler's handler picks up.
        }
        renderToolbar();
    }

    // ------- M1 click interceptor -------
    // Power-line paths in Map Styler are tagged with data-buffer-kind=
    // "kml-distro" / "kml-trans" and data-kml-pm-idx="N". We capture
    // M1 (button 0) clicks at the document level, find the matching
    // path via e.target.closest, and dispatch a vertex-edit command.
    //
    // Capture phase + a `pointerdown` AND `click` pair: Leaflet
    // sometimes eats one or the other depending on what tool is active.
    // Pair-with-debounce gives us a safety net.
    let clickInterceptorInstalled = false;
    let lastClickAt = 0;

    function onLineClick(e) {
        if (!masterOn) return;
        if (e.button !== 0) return;
        // Don't intercept while a vertex-edit is already active — the
        // user is dragging handles, clicks elsewhere should be ignored
        // OR Leaflet's own drag finish (which arrives as a click). The
        // vertex-edit's own Save/Discard buttons live in a separate
        // floating toolbar (built by Map Styler), so we don't conflict.
        if (status.vertexEditActive) return;
        if (status.drawModeActive) return;
        const t = e.target;
        if (!t || !t.closest) return;
        const path = t.closest('path[data-buffer-kind^="kml-"][data-kml-pm-idx]');
        if (!path) return;
        const kind = path.getAttribute('data-buffer-kind') || '';
        const m = kind.match(/^kml-(distro|trans)$/);
        if (!m) return;
        const kmlType = m[1];
        const pmIdx = parseInt(path.getAttribute('data-kml-pm-idx'), 10);
        if (!Number.isFinite(pmIdx)) return;
        const now = Date.now();
        if (now - lastClickAt < 250) return; // debounce pointerdown+click pair
        lastClickAt = now;
        e.preventDefault();
        e.stopPropagation();
        sendPle({ type: 'ENTER_VERTEX_EDIT', kmlType, pmIdx });
    }

    function installClickInterceptor() {
        if (clickInterceptorInstalled) return;
        // Capture phase: get the event before Leaflet's own handlers.
        document.addEventListener('click', onLineClick, true);
        document.addEventListener('pointerdown', onLineClick, true);
        clickInterceptorInstalled = true;
    }

    function uninstallClickInterceptor() {
        if (!clickInterceptorInstalled) return;
        document.removeEventListener('click', onLineClick, true);
        document.removeEventListener('pointerdown', onLineClick, true);
        clickInterceptorInstalled = false;
    }

    // ------- Toolbar UI -------
    // v0.2: ⚡ button injected into Percepto's `.map-tools` strip (the
    // top-right vertical column of map controls). Mirrors the AIM Control
    // Panel's gear-button injection pattern so it sits naturally alongside
    // the other map tools — same classes, same look, same z-index.
    //
    // When master is ON, a sub-panel appears directly BELOW the ⚡ button
    // (position:absolute, top:calc(100% + 6px), right:0). The sub-panel
    // STAYS OPEN as long as master is ON — unlike the Control Panel
    // dropdown, this isn't dismissed by clicking the map. Click ⚡ again
    // to close.
    //
    // Only IFRAME injects + hosts the toolbar (map lives in the iframe;
    // TOP frame has no `.map-tools` to inject into).
    const BUTTON_CLASS = 'aim-ple-button';
    const PANEL_ID = 'aim-ple-panel';
    let buttonEl = null;
    let panelEl = null;
    let injectTries = 0;
    const INJECT_MAX_TRIES = 60;
    const INJECT_RETRY_MS = 500;

    function findToolsBar() { return document.querySelector('.map-tools'); }

    function swallowMouseEvents(el) {
        ['click', 'dblclick', 'mousedown', 'mouseup',
         'pointerdown', 'pointerup', 'pointermove',
         'wheel', 'contextmenu', 'touchstart', 'touchend'].forEach(evt => {
            el.addEventListener(evt, (e) => e.stopPropagation(), false);
        });
    }

    function injectButton() {
        const tools = findToolsBar();
        if (!tools) return false;
        if (buttonEl && tools.contains(buttonEl)) return true;
        // Match the existing .map-tools__button look. Use the same class
        // soup the host app's other tools use so styling comes for free.
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="ant-dropdown-trigger map-tools__button pr-dropdown ${BUTTON_CLASS}"
                 title="Power Lines edit mode"
                 style="cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;user-select:none">
                <span class="aim-ple-icon" style="font-size:18px;line-height:1;color:#e6e6e6">⚡</span>
            </div>
        `;
        const el = wrapper.firstElementChild;
        tools.appendChild(el);
        buttonEl = el;
        swallowMouseEvents(buttonEl); // prevent map-zoom on accidental dblclick
        buttonEl.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            setMaster(!masterOn);
        });
        // Build panel inside the button so it positions relative to it.
        createPanel();
        renderButtonState();
        console.log(`${TAG} button injected into .map-tools`);
        return true;
    }

    function watchToolsBar() {
        const obs = new MutationObserver(() => {
            if (buttonEl && !document.body.contains(buttonEl)) {
                buttonEl = null; panelEl = null;
                injectButton();
            } else if (!buttonEl) {
                injectButton();
            }
        });
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
    }

    function ensureButton() {
        if (injectButton()) { watchToolsBar(); return; }
        injectTries++;
        if (injectTries < INJECT_MAX_TRIES) setTimeout(ensureButton, INJECT_RETRY_MS);
        else console.warn(`${TAG} gave up injecting after ${INJECT_MAX_TRIES} tries — .map-tools not found`);
    }

    function createPanel() {
        if (panelEl || !buttonEl) return;
        panelEl = document.createElement('div');
        panelEl.id = PANEL_ID;
        // Sub-panel positioned below the ⚡ button. Display toggled via
        // renderButtonState() based on masterOn.
        panelEl.style.cssText = [
            'position:absolute', 'top:calc(100% + 6px)', 'right:0',
            'background:rgba(40,40,40,0.92)', 'color:#e6e6e6',
            'backdrop-filter:blur(4px)', '-webkit-backdrop-filter:blur(4px)',
            'border:1px solid rgba(255,255,255,0.18)', 'border-radius:6px',
            'box-shadow:0 6px 22px rgba(0,0,0,0.55)',
            'z-index:100000', 'padding:6px',
            'display:none', // shown via renderButtonState
            'flex-direction:column', 'gap:5px', 'align-items:stretch',
            'min-width:140px',
            'font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'cursor:default',
        ].join(';');
        swallowMouseEvents(panelEl); // panel clicks must NOT zoom the map
        buttonEl.appendChild(panelEl);
    }

    function btn(label, title, onClick, opts) {
        opts = opts || {};
        const b = document.createElement('button');
        b.type = 'button';
        b.title = title;
        b.innerHTML = label;
        b.style.cssText = [
            'width:100%',
            'min-height:30px',
            'padding:5px 10px',
            'border-radius:4px',
            `background:${opts.bg || 'rgba(255,255,255,0.06)'}`,
            `border:1px solid ${opts.border || 'rgba(255,255,255,0.18)'}`,
            `color:${opts.color || '#e6e6e6'}`,
            'cursor:pointer',
            'font:inherit',
            'text-align:left',
            'display:flex',
            'align-items:center',
            'gap:8px',
        ].join(';');
        // Click handler — capture+stop so Leaflet can't eat it. The panel
        // already swallows propagation up to the map; this guarantees the
        // button's own onClick fires regardless.
        b.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            try { onClick(e); } catch (err) { console.warn(`${TAG} btn handler threw:`, err); }
        });
        // Hover affordance.
        const baseBg = opts.bg || 'rgba(255,255,255,0.06)';
        const hoverBg = opts.hoverBg || 'rgba(255,255,255,0.12)';
        b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
        b.addEventListener('mouseleave', () => { b.style.background = baseBg; });
        return b;
    }

    // ⚡ button visual state: dim when off, cyan-tinted when on. Also
    // pokes the dirty-count badge onto the icon when there are pending
    // edits, regardless of master state (so user sees uncommitted work).
    function renderButtonState() {
        if (!buttonEl) return;
        const icon = buttonEl.querySelector('.aim-ple-icon');
        if (icon) {
            icon.style.color = masterOn ? 'rgb(20,210,220)' : '#e6e6e6';
            icon.style.textShadow = masterOn ? '0 0 6px rgba(20,210,220,0.7)' : 'none';
        }
        // Dirty-count badge in the corner of the button.
        let badge = buttonEl.querySelector('.aim-ple-badge');
        const totalDirty = status.distroCount + status.transCount;
        if (totalDirty > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'aim-ple-badge';
                badge.style.cssText = [
                    'position:absolute', 'top:-4px', 'right:-4px',
                    'min-width:16px', 'height:16px', 'border-radius:8px',
                    'background:#ffd96b', 'color:#000',
                    'font-size:10px', 'font-weight:700',
                    'display:flex', 'align-items:center', 'justify-content:center',
                    'padding:0 4px',
                    'box-shadow:0 1px 3px rgba(0,0,0,0.6)',
                    'pointer-events:none',
                ].join(';');
                buttonEl.appendChild(badge);
            }
            badge.textContent = String(totalDirty);
        } else if (badge) {
            badge.remove();
        }
        renderPanelContents();
    }

    function renderPanelContents() {
        if (!panelEl) return;
        panelEl.style.display = masterOn ? 'flex' : 'none';
        if (!masterOn) { panelEl.innerHTML = ''; return; }
        panelEl.innerHTML = '';

        const header = document.createElement('div');
        header.textContent = 'Power Lines';
        header.style.cssText = 'color:rgb(20,210,220);font-weight:600;padding:2px 4px 4px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:2px';
        panelEl.appendChild(header);

        // Add Line — distro
        panelEl.appendChild(btn(
            '<span style="color:#ffd96b">+</span> Add distro line',
            'Click map to add vertices. Esc cancels. Save via Map Styler\'s floating toolbar.',
            () => sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'distro' })
        ));
        // Add Line — trans
        panelEl.appendChild(btn(
            '<span style="color:#ff8585">+</span> Add trans line',
            'Click map to add vertices. Esc cancels. Save via Map Styler\'s floating toolbar.',
            () => sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'trans' })
        ));

        // Commit per type — only show if there are dirty ops for that type.
        if (status.distroCount > 0) {
            panelEl.appendChild(btn(
                `<span style="color:#5fff5f">☁</span> Commit distro (${status.distroCount})`,
                `Commit ${status.distroCount} pending distribution change${status.distroCount === 1 ? '' : 's'} to GitHub`,
                () => sendPle({ type: 'COMMIT_KML', kmlType: 'distro' }),
                { bg: 'rgba(95,255,95,0.10)', border: 'rgba(95,255,95,0.4)', hoverBg: 'rgba(95,255,95,0.20)' }
            ));
        }
        if (status.transCount > 0) {
            panelEl.appendChild(btn(
                `<span style="color:#5fff5f">☁</span> Commit trans (${status.transCount})`,
                `Commit ${status.transCount} pending transmission change${status.transCount === 1 ? '' : 's'} to GitHub`,
                () => sendPle({ type: 'COMMIT_KML', kmlType: 'trans' }),
                { bg: 'rgba(95,255,95,0.10)', border: 'rgba(95,255,95,0.4)', hoverBg: 'rgba(95,255,95,0.20)' }
            ));
        }

        // Discard — shown if anything is dirty.
        const totalDirty = status.distroCount + status.transCount;
        if (totalDirty > 0) {
            panelEl.appendChild(btn(
                `<span style="color:#ff8585">✗</span> Discard all (${totalDirty})`,
                `Discard ALL pending changes (${totalDirty}). Has its own confirm prompt.`,
                () => {
                    if (status.distroCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'distro' });
                    if (status.transCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'trans' });
                },
                { bg: 'rgba(255,80,80,0.10)', border: 'rgba(255,133,133,0.4)', hoverBg: 'rgba(255,80,80,0.20)' }
            ));
        }

        // Status footer.
        if (status.vertexEditActive) {
            const ind = document.createElement('div');
            ind.textContent = `▸ editing ${status.vertexEditType} #${status.vertexEditPmIdx}`;
            ind.style.cssText = 'color:#7adfe6;font-size:11px;padding:4px 6px 2px;border-top:1px solid rgba(255,255,255,0.08);margin-top:2px';
            panelEl.appendChild(ind);
        } else if (status.drawModeActive) {
            const ind = document.createElement('div');
            ind.textContent = `▸ drawing ${status.drawModeType}`;
            ind.style.cssText = 'color:#5fff5f;font-size:11px;padding:4px 6px 2px;border-top:1px solid rgba(255,255,255,0.08);margin-top:2px';
            panelEl.appendChild(ind);
        } else {
            const hint = document.createElement('div');
            hint.textContent = 'M1 on any line to edit vertices';
            hint.style.cssText = 'color:#888;font-size:10px;padding:4px 6px 2px;border-top:1px solid rgba(255,255,255,0.08);margin-top:2px;font-style:italic';
            panelEl.appendChild(hint);
        }
    }

    // Wrapper used by external state changes (master flip, STATUS arrival,
    // setMaster). Same name as before so init/setMaster don't need updating.
    function renderToolbar() { renderButtonState(); }

    // ------- Init -------
    function init() {
        if (IS_TOP) {
            // TOP has no map to edit and no .map-tools to inject into.
            // Still set up the channels so status messages don't error.
            setupChannels();
            console.log(`${TAG} v${SCRIPT_VERSION} ready (TOP — no UI in this frame)`);
            return;
        }
        setupChannels();
        ensureButton();
        // If the master was ON before reload, restore the click interceptor
        // and tell Map Styler to flip its edit-mode toggles back on.
        if (masterOn) {
            setStylerEditMode(true);
            installClickInterceptor();
        }
        // Ask for current dirty counts so the badge is accurate on load.
        // Use a small delay to let Map Styler finish its own init first.
        setTimeout(requestStatus, 800);
        console.log(`${TAG} v${SCRIPT_VERSION} ready (${FRAME}) — master ${masterOn ? 'ON' : 'OFF'}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
