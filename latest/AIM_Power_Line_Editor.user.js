// ==UserScript==
// @name         Latest - AIM Power Line Editor
// @namespace    http://tampermonkey.net/
// @version      0.8
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Power_Line_Editor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Power_Line_Editor.user.js
// @description  Power Lines editing UX layer. Registers with AIM Control Panel as a regular script (Edit mode toggle + Add Line / Commit / Discard buttons live inside the gear dropdown). ⚡ in the map-tools strip is a visual state indicator + M2 quick-toggle for edit mode. Drives Map Styler v34.44+ over AIM_POWER_LINE_EDIT channel.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// What this is — v0.8 (post-redesign)
// ===================================
// All Power Lines controls live inside the AIM Control Panel dropdown
// (gear icon → Power Lines section). No more floating panel. Reasons:
//   - Eliminates positioning fights with Percepto's right-side toolbar
//     and the Control Panel dropdown itself.
//   - Matches the existing pattern every other AIM script uses.
//   - Auto-collapses when user clicks elsewhere (Control Panel handles).
//
// The ⚡ button in .map-tools stays as a:
//   - Visual state indicator (orange + green glow when edit mode ON;
//     greyscale when OFF).
//   - M2 (right-click) quick-toggle for edit mode (no need to open
//     the gear dropdown for the most common action).
//   - M1 (left-click) is a no-op — controls live in the gear dropdown.
//
// All commit / draw / vertex-edit state still lives in Map Styler.
// This script:
//   1. Owns the Control Panel registration (toggles + button actions)
//   2. Owns the ⚡ button (visual state + M2 quick-toggle)
//   3. Owns M1-on-power-line click detection
//   4. Routes all commands to Map Styler via AIM_POWER_LINE_EDIT
//
// Log tag: [AIM PLE]

(function () {
    'use strict';

    const TAG = '[AIM PLE]';
    const SCRIPT_VERSION = '0.8';
    const IS_TOP = window === window.top;
    const FRAME = IS_TOP ? 'TOP' : 'IFRAME';

    // Edit mode persists across reloads via localStorage (shared across @name).
    const EDIT_STORAGE_KEY = 'aim-ple-edit-enabled';
    function readEditEnabled() {
        try { return localStorage.getItem(EDIT_STORAGE_KEY) === 'true'; }
        catch (e) { return false; }
    }
    function writeEditEnabled(on) {
        try { localStorage.setItem(EDIT_STORAGE_KEY, on ? 'true' : 'false'); }
        catch (e) {}
    }

    // ------- Channel setup -------
    const PLE_CHANNEL_NAME = 'AIM_POWER_LINE_EDIT';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-power-line-editor';
    const MAP_STYLER_SCRIPT_ID = 'aim-map-styler';

    let pleChannel = null;
    let controlChannel = null;
    let status = {
        siteID: null,
        distroCount: 0,
        transCount: 0,
        vertexEditActive: false,
        drawModeActive: false,
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
                    renderButtonState();
                }
            };
        }
        if (controlChannel) {
            controlChannel.onmessage = handleControlMessage;
        }
    }

    function sendPle(payload) {
        if (!pleChannel) return;
        try { pleChannel.postMessage(payload); } catch (e) {}
    }
    function requestStatus() { sendPle({ type: 'REQUEST_STATUS' }); }

    // Flip Map Styler's per-category edit-mode toggles via the existing
    // Control Panel SET_TOGGLE mechanism. Map Styler listens on the
    // CONTROL channel for these and updates internally.
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

    // ------- Edit mode state -------
    let masterEnabled = true;
    let editEnabled = readEditEnabled();

    function setEditEnabled(on, opts) {
        opts = opts || {};
        if (on === editEnabled) return;
        editEnabled = on;
        writeEditEnabled(on);
        setStylerEditMode(on);
        if (on) {
            installClickInterceptor();
            requestStatus();
        } else {
            uninstallClickInterceptor();
            if (status.vertexEditActive) sendPle({ type: 'EXIT_VERTEX_EDIT', save: false });
        }
        renderButtonState();
        // Tell Control Panel about the new state so its checkbox stays in sync
        // (someone could toggle it via M2 on ⚡ while the panel is open).
        if (!opts.fromControlPanel && controlChannel) {
            try {
                controlChannel.postMessage({
                    type: 'SET_TOGGLE',
                    scriptId: SCRIPT_ID,
                    toggleId: 'edit-mode',
                    value: on,
                    enabled: on,
                });
            } catch (e) {}
        }
    }

    // ------- Control Panel registration + message handling -------
    function handleControlMessage(ev) {
        const msg = ev.data || {};
        if (msg.type === 'REQUEST_REGISTRATIONS') {
            registerWithControlPanel();
        } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
            const v = msg.value !== undefined ? msg.value : msg.enabled;
            if (msg.toggleId === 'master') {
                masterEnabled = !!v;
                renderButtonState();
            } else if (msg.toggleId === 'edit-mode') {
                setEditEnabled(!!v, { fromControlPanel: true });
            }
        } else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === SCRIPT_ID) {
            // Only IFRAME (which has the map) actually fires actions.
            if (!IS_TOP) handleAction(msg.actionId);
        }
    }

    function handleAction(actionId) {
        switch (actionId) {
            case 'add-distro':   sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'distro' }); break;
            case 'add-trans':    sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'trans' }); break;
            case 'commit-distro': sendPle({ type: 'COMMIT_KML', kmlType: 'distro' }); break;
            case 'commit-trans':  sendPle({ type: 'COMMIT_KML', kmlType: 'trans' }); break;
            case 'discard-all':
                if (status.distroCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'distro' });
                if (status.transCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'trans' });
                break;
            default:
                console.warn(`${TAG} unknown action: ${actionId}`);
        }
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER',
            scriptId: SCRIPT_ID,
            name: 'Power Lines',
            version: SCRIPT_VERSION,
            toggles: [
                { id: 'master', label: 'Enable Power Line Editor', type: 'boolean', default: true, master: true },
                { id: 'edit-mode', label: 'Edit mode (M1 lines to edit · M2 ⚡ to toggle)', type: 'boolean', default: false },
                { type: 'header', label: 'Add' },
                { id: 'add-distro', label: '+ Add distribution line', type: 'button', action: 'add-distro' },
                { id: 'add-trans',  label: '+ Add transmission line',  type: 'button', action: 'add-trans' },
                { type: 'header', label: 'Commit / Discard' },
                { id: 'commit-distro', label: '☁ Commit distro changes', type: 'button', action: 'commit-distro' },
                { id: 'commit-trans',  label: '☁ Commit trans changes',  type: 'button', action: 'commit-trans' },
                { id: 'discard-all',   label: '✗ Discard all pending',    type: 'button', action: 'discard-all' },
            ],
            hotkeys: [],
        });
    }

    // ------- M1 click interceptor on power-line paths -------
    let clickInterceptorInstalled = false;
    let lastClickAt = 0;

    function onLineClick(e) {
        if (!editEnabled || !masterEnabled) return;
        if (e.button !== 0) return;
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
        if (now - lastClickAt < 250) return;
        lastClickAt = now;
        e.preventDefault();
        e.stopPropagation();
        sendPle({ type: 'ENTER_VERTEX_EDIT', kmlType, pmIdx });
    }

    function installClickInterceptor() {
        if (clickInterceptorInstalled) return;
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

    // ------- ⚡ button in .map-tools -------
    const BUTTON_CLASS = 'aim-ple-button';
    let buttonEl = null;
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
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="ant-dropdown-trigger map-tools__button pr-dropdown ${BUTTON_CLASS}"
                 title="Power Lines: M2 (right-click) to toggle edit mode · controls in AIM gear menu"
                 style="cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;user-select:none">
                <span class="aim-ple-icon" style="font-size:18px;line-height:1">⚡</span>
            </div>
        `;
        const el = wrapper.firstElementChild;
        tools.appendChild(el);
        buttonEl = el;
        swallowMouseEvents(buttonEl);
        // M1: no-op for now (could be made to open Control Panel + scroll
        // to Power Lines section later — for now just a visual indicator).
        buttonEl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
        // M2: quick-toggle edit mode. Most common action; bypasses needing
        // to open the gear menu.
        buttonEl.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            setEditEnabled(!editEnabled);
        });
        renderButtonState();
        console.log(`${TAG} v${SCRIPT_VERSION} button injected into .map-tools`);
        return true;
    }

    function watchToolsBar() {
        const obs = new MutationObserver(() => {
            if (buttonEl && !document.body.contains(buttonEl)) {
                buttonEl = null;
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

    // ⚡ visual state.
    //   editEnabled ON  → native orange ⚡ + neon-green glow + larger
    //   editEnabled OFF → greyscale ⚡ + no glow + standard size
    // Dirty-count badge shows regardless so uncommitted work is always
    // visible. Wider tooltip describes both M2 toggle + gear-menu controls.
    function renderButtonState() {
        if (!buttonEl) return;
        const icon = buttonEl.querySelector('.aim-ple-icon');
        if (icon) {
            if (editEnabled) {
                icon.style.filter = 'none';
                icon.style.fontSize = '22px';
                icon.style.textShadow = [
                    '0 0 8px  rgba(57,255,20,0.95)',
                    '0 0 18px rgba(57,255,20,0.70)',
                    '0 0 32px rgba(57,255,20,0.40)',
                ].join(', ');
            } else {
                icon.style.filter = 'grayscale(1) brightness(0.65)';
                icon.style.fontSize = '18px';
                icon.style.textShadow = 'none';
            }
        }
        buttonEl.title = editEnabled
            ? 'Power Lines edit mode: ON · M2 to disable · controls in AIM gear menu'
            : 'Power Lines edit mode: OFF · M2 to enable · controls in AIM gear menu';
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
    }

    // ------- Init -------
    function init() {
        setupChannels();
        registerWithControlPanel();
        if (IS_TOP) {
            // TOP frame has no .map-tools (map lives in iframe) — skip
            // ⚡ injection but keep channels/registration alive so the
            // Control Panel sees us regardless of which frame it lives in.
            console.log(`${TAG} v${SCRIPT_VERSION} ready (TOP — no ⚡ in this frame)`);
            return;
        }
        ensureButton();
        if (editEnabled) {
            setStylerEditMode(true);
            installClickInterceptor();
        }
        setTimeout(requestStatus, 800);
        console.log(`${TAG} v${SCRIPT_VERSION} ready (${FRAME}) — edit ${editEnabled ? 'ON' : 'OFF'}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
