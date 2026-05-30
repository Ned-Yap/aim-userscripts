// ==UserScript==
// @name         Latest - AIM Power Line Editor
// @namespace    http://tampermonkey.net/
// @version      0.1
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
    const SCRIPT_VERSION = '0.1';
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
    // Floating panel anchored to the map's left edge, vertically
    // centered upper portion. Lives in document.body so it sits above
    // every Percepto layer including the leaflet container.
    //
    // Collapsed: just the master ⚡ button + (if dirty) a count badge.
    // Expanded: master + dirty badge + a vertical strip of action buttons.
    //
    // Only IFRAME hosts the toolbar (the map lives in the iframe; the
    // TOP frame has no map to edit). TOP frame still listens on the PLE
    // channel for status if we ever need it, but doesn't render UI.
    const TOOLBAR_ID = 'aim-ple-toolbar';
    let toolbarEl = null;

    function injectToolbarOnce() {
        if (toolbarEl && document.body && document.body.contains(toolbarEl)) return;
        if (!document.body) return;
        // Avoid duplicate injection if both contexts somehow inject.
        const existing = document.getElementById(TOOLBAR_ID);
        if (existing) { toolbarEl = existing; renderToolbar(); return; }
        toolbarEl = document.createElement('div');
        toolbarEl.id = TOOLBAR_ID;
        toolbarEl.style.cssText = [
            'position:fixed',
            'left:12px',
            'top:50%',
            'transform:translateY(-50%)',
            'z-index:99998', // below the Map Styler vertex-edit toolbar (99999)
            'display:flex',
            'flex-direction:column',
            'align-items:center',
            'gap:6px',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'font-size:12px',
            'user-select:none',
        ].join(';');
        document.body.appendChild(toolbarEl);
        renderToolbar();
    }

    // Re-inject if Percepto/React tears it out. Cheap MutationObserver
    // on body looking only for our id disappearing.
    function watchToolbar() {
        const obs = new MutationObserver(() => {
            if (toolbarEl && !document.body.contains(toolbarEl)) {
                toolbarEl = null;
                injectToolbarOnce();
            } else if (!toolbarEl) {
                injectToolbarOnce();
            }
        });
        if (document.body) obs.observe(document.body, { childList: true, subtree: false });
    }

    function btn(label, title, onClick, opts) {
        opts = opts || {};
        const b = document.createElement('button');
        b.type = 'button';
        b.title = title;
        b.innerHTML = label;
        b.style.cssText = [
            `width:${opts.width || 40}px`,
            `height:${opts.height || 40}px`,
            'border-radius:6px',
            `background:${opts.bg || 'rgba(31,34,40,0.92)'}`,
            `border:1px solid ${opts.border || 'rgba(255,255,255,0.18)'}`,
            `color:${opts.color || '#e6e6e6'}`,
            'cursor:pointer',
            'font-size:18px',
            'line-height:1',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
            'backdrop-filter:blur(4px)',
            '-webkit-backdrop-filter:blur(4px)',
            'padding:0',
        ].join(';');
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(e); });
        // Prevent Leaflet from interpreting clicks on the toolbar as map clicks.
        ['mousedown', 'mouseup', 'dblclick', 'pointerdown', 'pointerup'].forEach(ev => {
            b.addEventListener(ev, (e) => e.stopPropagation());
        });
        return b;
    }

    // Render the toolbar contents from current state. Cheap to call —
    // wipes innerHTML and rebuilds. Called on master toggle + STATUS arrival.
    function renderToolbar() {
        if (!toolbarEl) return;
        // Stop Leaflet getting any toolbar event regardless of which child fires it.
        ['mousedown', 'mouseup', 'click', 'dblclick',
         'pointerdown', 'pointerup', 'wheel', 'contextmenu'].forEach(ev => {
            toolbarEl.addEventListener(ev, (e) => e.stopPropagation());
        });
        toolbarEl.innerHTML = '';
        const totalDirty = status.distroCount + status.transCount;

        // Master ⚡ button — always visible.
        const masterBtn = btn(
            '⚡',
            masterOn ? 'Power Lines edit mode — click to disable' : 'Power Lines edit mode — click to enable',
            () => setMaster(!masterOn),
            {
                width: 44, height: 44,
                bg: masterOn ? 'rgba(20,210,220,0.92)' : 'rgba(31,34,40,0.92)',
                border: masterOn ? '#7adfe6' : 'rgba(255,255,255,0.18)',
                color: masterOn ? '#0a1a1d' : '#e6e6e6',
            }
        );
        // Dirty-count badge on the master button (always visible if > 0).
        if (totalDirty > 0) {
            const badge = document.createElement('span');
            badge.textContent = String(totalDirty);
            badge.style.cssText = [
                'position:absolute',
                'top:-6px',
                'right:-6px',
                'min-width:18px',
                'height:18px',
                'border-radius:9px',
                'background:#ffd96b',
                'color:#000',
                'font-size:11px',
                'font-weight:700',
                'display:flex',
                'align-items:center',
                'justify-content:center',
                'padding:0 5px',
                'box-shadow:0 1px 3px rgba(0,0,0,0.6)',
                'pointer-events:none',
            ].join(';');
            masterBtn.style.position = 'relative';
            masterBtn.appendChild(badge);
        }
        toolbarEl.appendChild(masterBtn);

        if (!masterOn) return;

        // Visual separator (subtle line)
        const sep = document.createElement('div');
        sep.style.cssText = 'width:24px;height:1px;background:rgba(255,255,255,0.15);margin:2px 0';
        toolbarEl.appendChild(sep);

        // Add Line — distro
        toolbarEl.appendChild(btn(
            '+<span style="font-size:10px;margin-left:1px">D</span>',
            'Add new distribution line (click map to add vertices, Esc cancels)',
            () => sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'distro' })
        ));
        // Add Line — trans
        toolbarEl.appendChild(btn(
            '+<span style="font-size:10px;margin-left:1px">T</span>',
            'Add new transmission line (click map to add vertices, Esc cancels)',
            () => sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'trans' })
        ));

        // Commit per type — only show if there are dirty ops for that type.
        if (status.distroCount > 0) {
            toolbarEl.appendChild(btn(
                `☁<span style="font-size:9px;margin-left:1px">D</span>`,
                `Commit ${status.distroCount} pending distro change${status.distroCount === 1 ? '' : 's'} to GitHub`,
                () => sendPle({ type: 'COMMIT_KML', kmlType: 'distro' }),
                { bg: 'rgba(95,255,95,0.18)', border: '#5fff5f', color: '#5fff5f' }
            ));
        }
        if (status.transCount > 0) {
            toolbarEl.appendChild(btn(
                `☁<span style="font-size:9px;margin-left:1px">T</span>`,
                `Commit ${status.transCount} pending trans change${status.transCount === 1 ? '' : 's'} to GitHub`,
                () => sendPle({ type: 'COMMIT_KML', kmlType: 'trans' }),
                { bg: 'rgba(95,255,95,0.18)', border: '#5fff5f', color: '#5fff5f' }
            ));
        }

        // Discard — shown if anything is dirty. Confirms via Map Styler's
        // own discardCommitOps which has its own confirm() prompt.
        if (totalDirty > 0) {
            toolbarEl.appendChild(btn(
                '✗',
                `Discard ALL pending changes (${totalDirty})`,
                () => {
                    if (status.distroCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'distro' });
                    if (status.transCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'trans' });
                },
                { bg: 'rgba(255,80,80,0.18)', border: '#ff8585', color: '#ff8585' }
            ));
        }

        // Status footer (current edit indicator)
        if (status.vertexEditActive) {
            const ind = document.createElement('div');
            ind.textContent = `editing ${status.vertexEditType} #${status.vertexEditPmIdx}`;
            ind.style.cssText = 'color:#7adfe6;font-size:10px;text-align:center;max-width:80px;line-height:1.2;margin-top:4px';
            toolbarEl.appendChild(ind);
        } else if (status.drawModeActive) {
            const ind = document.createElement('div');
            ind.textContent = `drawing ${status.drawModeType}`;
            ind.style.cssText = 'color:#5fff5f;font-size:10px;text-align:center;max-width:80px;line-height:1.2;margin-top:4px';
            toolbarEl.appendChild(ind);
        }
    }

    // ------- Init -------
    function init() {
        if (IS_TOP) {
            // TOP has no map to edit and no toolbar to render. Still set
            // up the channels so status messages don't trigger errors.
            setupChannels();
            console.log(`${TAG} v${SCRIPT_VERSION} ready (TOP — no toolbar in this frame)`);
            return;
        }
        setupChannels();
        injectToolbarOnce();
        watchToolbar();
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
