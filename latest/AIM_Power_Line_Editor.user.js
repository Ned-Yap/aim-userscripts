// ==UserScript==
// @name         Latest - AIM Power Line Editor
// @namespace    http://tampermonkey.net/
// @version      0.10
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Power_Line_Editor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Power_Line_Editor.user.js
// @description  Power Lines editor. ⚡ at bottom of map-tools (below gear). M1 ⚡ toggles a small icon-button strip below it (+D, +T, plus ✓/✗ when changes pending). M2 ⚡ toggles edit mode. Master + edit-mode toggles also live in the gear dropdown. Drives Map Styler v34.44+ over AIM_POWER_LINE_EDIT channel.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// v0.9 design
// ===========
// ⚡ button: always positioned as the LAST child of .map-tools so it sits
//   BELOW the AIM Controls gear button. v0.8 had it injected via
//   appendChild but Control Panel's gear button injected later sometimes
//   put ⚡ second-to-last. v0.9 uses a MutationObserver-driven reorder
//   to keep ⚡ at the bottom no matter what.
//
// Small icon strip below ⚡ (M1 toggles open/close):
//   +D  Add distribution line   (yellow border)
//   +T  Add transmission line   (red border)
//   ✓   Commit all              (green, only when any dirty count > 0)
//   ✗   Discard all             (red, only when any dirty count > 0)
// Each button is 30x30 with a hover tooltip carrying full help text.
// Strip is persistent (localStorage) — stays open across reloads until
// user M1 ⚡ to close.
//
// M2 (right-click) on ⚡ = toggle edit mode (the most common quick action).
//
// In the AIM Controls gear dropdown: Power Lines section with just
// {master, edit-mode} toggles. The action buttons live in the floating
// strip, not in the dropdown — keeps the dropdown short and the strip
// is faster to reach for repeated actions.
//
// Log tag: [AIM PLE]

(function () {
    'use strict';

    const TAG = '[AIM PLE]';
    const SCRIPT_VERSION = '0.10';
    const IS_TOP = window === window.top;
    const FRAME = IS_TOP ? 'TOP' : 'IFRAME';

    // Persistent state (localStorage, shared across @name).
    const EDIT_STORAGE_KEY = 'aim-ple-edit-enabled';
    const STRIP_STORAGE_KEY = 'aim-ple-strip-open';
    function readBool(key) {
        try { return localStorage.getItem(key) === 'true'; }
        catch (e) { return false; }
    }
    function writeBool(key, on) {
        try { localStorage.setItem(key, on ? 'true' : 'false'); }
        catch (e) {}
    }

    // ------- Channels -------
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
                    renderUI();
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

    // ------- State -------
    let masterEnabled = true;
    let editEnabled = readBool(EDIT_STORAGE_KEY);
    let stripOpen = readBool(STRIP_STORAGE_KEY);

    function setEditEnabled(on, opts) {
        opts = opts || {};
        if (on === editEnabled) return;
        editEnabled = on;
        writeBool(EDIT_STORAGE_KEY, on);
        setStylerEditMode(on);
        if (on) {
            installClickInterceptor();
            requestStatus();
        } else {
            uninstallClickInterceptor();
            if (status.vertexEditActive) sendPle({ type: 'EXIT_VERTEX_EDIT', save: false });
        }
        renderUI();
        // Echo to Control Panel so the gear-menu checkbox stays in sync.
        if (!opts.fromControlPanel && controlChannel) {
            try {
                controlChannel.postMessage({
                    type: 'SET_TOGGLE', scriptId: SCRIPT_ID, toggleId: 'edit-mode',
                    value: on, enabled: on,
                });
            } catch (e) {}
        }
    }

    function setStripOpen(on) {
        if (on === stripOpen) return;
        stripOpen = on;
        writeBool(STRIP_STORAGE_KEY, on);
        renderUI();
    }

    // ------- Control Panel -------
    function handleControlMessage(ev) {
        const msg = ev.data || {};
        if (msg.type === 'REQUEST_REGISTRATIONS') {
            registerWithControlPanel();
        } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
            const v = msg.value !== undefined ? msg.value : msg.enabled;
            if (msg.toggleId === 'master') {
                masterEnabled = !!v;
                renderUI();
            } else if (msg.toggleId === 'edit-mode') {
                setEditEnabled(!!v, { fromControlPanel: true });
            }
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
                { id: 'edit-mode', label: 'Edit mode (M1 lines · M2 ⚡ to toggle)', type: 'boolean', default: false },
            ],
            hotkeys: [],
        });
    }

    // ------- M1 click on power lines (vertex edit) -------
    let clickInterceptorInstalled = false;
    let lastClickAt = 0;

    function onLineClick(e) {
        if (!editEnabled || !masterEnabled) return;
        if (e.button !== 0) return;
        if (status.vertexEditActive) return;
        if (status.drawModeActive) return;
        const t = e.target;
        if (!t || !t.closest) return;
        // v0.10: detect BOTH file-line paths (data-kml-pm-idx) and
        // pending-add green-line paths (data-kml-added-idx). Route to
        // the right ENTER_VERTEX_EDIT payload so Map Styler can pick
        // the matching enterVertexEdit / enterAddedVertexEdit handler.
        const path = t.closest('path[data-buffer-kind^="kml-"][data-kml-pm-idx], path[data-buffer-kind^="kml-"][data-kml-added-idx]');
        if (!path) return;
        const kind = path.getAttribute('data-buffer-kind') || '';
        const m = kind.match(/^kml-(distro|trans)$/);
        if (!m) return;
        const kmlType = m[1];
        const pmIdxAttr = path.getAttribute('data-kml-pm-idx');
        const addedIdxAttr = path.getAttribute('data-kml-added-idx');
        const now = Date.now();
        if (now - lastClickAt < 250) return;
        lastClickAt = now;
        e.preventDefault();
        e.stopPropagation();
        if (addedIdxAttr !== null) {
            const addedIdx = parseInt(addedIdxAttr, 10);
            if (!Number.isFinite(addedIdx)) return;
            sendPle({ type: 'ENTER_VERTEX_EDIT', kmlType, addedIdx });
        } else {
            const pmIdx = parseInt(pmIdxAttr, 10);
            if (!Number.isFinite(pmIdx)) return;
            sendPle({ type: 'ENTER_VERTEX_EDIT', kmlType, pmIdx });
        }
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

    // ------- ⚡ button + strip -------
    const BUTTON_CLASS = 'aim-ple-button';
    const STRIP_CLASS = 'aim-ple-strip';
    let buttonEl = null;
    let stripEl = null;
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

    // Always keep ⚡ as the LAST child of .map-tools (i.e. below the gear).
    // Control Panel sometimes injects gear after PLE, which would otherwise
    // leave ⚡ stuck between Layers and Gear.
    function ensureLastChild() {
        const tools = findToolsBar();
        if (!tools || !buttonEl) return;
        if (tools.lastElementChild !== buttonEl) {
            tools.appendChild(buttonEl); // appendChild moves the element if already a child
        }
    }

    function injectButton() {
        const tools = findToolsBar();
        if (!tools) return false;
        if (buttonEl && tools.contains(buttonEl)) {
            ensureLastChild();
            return true;
        }
        const wrapper = document.createElement('div');
        // z-index:2147483647 keeps ⚡ + child strip above the AIM Control
        // Panel dropdown (z-index:100000) so they're never hidden behind it.
        wrapper.innerHTML = `
            <div class="ant-dropdown-trigger map-tools__button pr-dropdown ${BUTTON_CLASS}"
                 title="Power Lines · M1 toggle strip · M2 toggle edit"
                 style="cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;user-select:none;z-index:2147483647;isolation:isolate">
                <span class="aim-ple-icon" style="font-size:18px;line-height:1">⚡</span>
            </div>
        `;
        const el = wrapper.firstElementChild;
        tools.appendChild(el);
        buttonEl = el;
        swallowMouseEvents(buttonEl);
        buttonEl.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            setStripOpen(!stripOpen);
        });
        buttonEl.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            setEditEnabled(!editEnabled);
        });
        createStrip();
        renderUI();
        console.log(`${TAG} v${SCRIPT_VERSION} button injected into .map-tools`);
        return true;
    }

    function watchToolsBar() {
        const obs = new MutationObserver(() => {
            if (buttonEl && !document.body.contains(buttonEl)) {
                buttonEl = null;
                stripEl = null;
                injectButton();
            } else if (!buttonEl) {
                injectButton();
            } else {
                ensureLastChild();
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

    function createStrip() {
        if (stripEl || !buttonEl) return;
        stripEl = document.createElement('div');
        stripEl.className = STRIP_CLASS;
        // Vertical strip directly below ⚡, right-aligned with the button.
        // Each icon button is the same 30x30 size as the toolbar buttons.
        // The strip extends DOWNWARD from ⚡ into the empty bottom-right
        // map area (⚡ is already the last toolbar button → nothing below).
        stripEl.style.cssText = [
            'position:absolute',
            'top:calc(100% + 4px)',
            'right:0',
            'display:none',
            'flex-direction:column',
            'gap:4px',
            'z-index:2147483647',
            'pointer-events:auto',
        ].join(';');
        swallowMouseEvents(stripEl);
        buttonEl.appendChild(stripEl);
    }

    function iconBtn(glyph, title, onClick, opts) {
        opts = opts || {};
        const b = document.createElement('button');
        b.type = 'button';
        b.title = title;
        b.innerHTML = glyph;
        b.style.cssText = [
            'width:30px', 'height:30px',
            'border-radius:4px',
            `background:${opts.bg || 'rgba(54,54,54,0.95)'}`,
            `border:1px solid ${opts.border || 'rgba(255,255,255,0.18)'}`,
            `color:${opts.color || '#e6e6e6'}`,
            'cursor:pointer',
            'font-size:14px', 'font-weight:600',
            'line-height:1',
            'display:flex', 'align-items:center', 'justify-content:center',
            'padding:0',
            'box-shadow:0 2px 6px rgba(0,0,0,0.4)',
        ].join(';');
        const hoverBg = opts.hoverBg || 'rgba(75,75,75,0.95)';
        const baseBg = opts.bg || 'rgba(54,54,54,0.95)';
        b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
        b.addEventListener('mouseleave', () => { b.style.background = baseBg; });
        b.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            try { onClick(e); } catch (err) { console.warn(`${TAG} icon handler threw:`, err); }
        });
        return b;
    }

    // Render: ⚡ visual state + strip contents.
    function renderUI() {
        if (!buttonEl) return;
        // ⚡ visual
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
            ? 'Power Lines: edit mode ON · M1 to toggle action strip · M2 to disable edit'
            : 'Power Lines: edit mode OFF · M1 to toggle action strip · M2 to enable edit';

        // Dirty count badge
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

        // Strip
        if (!stripEl) return;
        stripEl.style.display = (stripOpen && masterEnabled) ? 'flex' : 'none';
        if (!stripOpen || !masterEnabled) {
            stripEl.innerHTML = '';
            return;
        }
        stripEl.innerHTML = '';

        // + D: Add distribution line. Yellow border to match distro line color.
        stripEl.appendChild(iconBtn(
            '<span style="color:#ffd96b">+</span><span style="font-size:10px;margin-left:1px">D</span>',
            'Add distribution line — click map to add vertices, Save in the green floating toolbar, Esc cancels',
            () => sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'distro' }),
            { border: 'rgba(255,217,107,0.55)' }
        ));
        // + T: Add transmission line. Red border to match trans line color.
        stripEl.appendChild(iconBtn(
            '<span style="color:#ff8585">+</span><span style="font-size:10px;margin-left:1px">T</span>',
            'Add transmission line — click map to add vertices, Save in the green floating toolbar, Esc cancels',
            () => sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'trans' }),
            { border: 'rgba(255,133,133,0.55)' }
        ));

        // ✓ Commit all and ✗ Discard all — ONLY when there's something pending
        if (totalDirty > 0) {
            const parts = [];
            if (status.distroCount > 0) parts.push(`${status.distroCount} distro`);
            if (status.transCount > 0) parts.push(`${status.transCount} trans`);
            const summary = parts.join(' + ');
            stripEl.appendChild(iconBtn(
                '✓',
                `Commit all pending changes to GitHub (${summary})`,
                () => {
                    if (status.distroCount > 0) sendPle({ type: 'COMMIT_KML', kmlType: 'distro' });
                    if (status.transCount > 0) sendPle({ type: 'COMMIT_KML', kmlType: 'trans' });
                },
                { bg: 'rgba(40,80,40,0.95)', hoverBg: 'rgba(60,140,60,0.95)', border: '#5fff5f', color: '#5fff5f' }
            ));
            stripEl.appendChild(iconBtn(
                '✗',
                `Discard ALL pending changes (${summary}). Has a confirm prompt.`,
                () => {
                    if (status.distroCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'distro' });
                    if (status.transCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'trans' });
                },
                { bg: 'rgba(80,40,40,0.95)', hoverBg: 'rgba(140,60,60,0.95)', border: '#ff5050', color: '#ff8585' }
            ));
        }
    }

    // ------- Init -------
    function init() {
        setupChannels();
        registerWithControlPanel();
        if (IS_TOP) {
            console.log(`${TAG} v${SCRIPT_VERSION} ready (TOP — no ⚡ in this frame)`);
            return;
        }
        ensureButton();
        if (editEnabled) {
            setStylerEditMode(true);
            installClickInterceptor();
        }
        setTimeout(requestStatus, 800);
        console.log(`${TAG} v${SCRIPT_VERSION} ready (${FRAME}) — edit ${editEnabled ? 'ON' : 'OFF'} · strip ${stripOpen ? 'OPEN' : 'CLOSED'}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
