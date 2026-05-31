// ==UserScript==
// @name         Latest - AIM Map Nav
// @namespace    http://tampermonkey.net/
// @version      0.1
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Map_Nav.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Map_Nav.user.js
// @description  Keyboard nav for the Percepto map. WASD pan, Q/E zoom out/in. Hold Shift for sprint (3x), Ctrl for precise (0.3x). Always-on globally; standard input guards skip when typing. Registers with AIM Control Panel under "Map Nav" with master + pan + zoom toggles.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// v0.1 design
// ===========
// Bindings:
//   W/A/S/D = pan up/left/down/right
//   Q       = zoom out
//   E       = zoom in
//   Shift   = sprint (3x speed)
//   Ctrl    = precise (0.3x speed)
//
// Always-on globally — NOT gated on edit mode. The standard input guard
// skips when focus is in an INPUT/TEXTAREA/SELECT/contentEditable/Ant
// input/role=textbox so typing zone names never accidentally pans.
//
// Architecture:
//   - Runs in both TOP + IFRAME; only the frame with the Leaflet map
//     applies motion (getLeafletMap() returns null in TOP). Keys fire
//     in whichever frame has focus; mostly users have focus on the map
//     iframe while panning.
//   - Pressed keys tracked in a Set. requestAnimationFrame ticks while
//     any motion key is held → smooth ~60fps pan. Zoom throttled to one
//     step per 200ms (otherwise OS keydown auto-repeat at ~30Hz would
//     burn through zoom levels in a quarter-second).
//   - Modifiers (shift/ctrl) tracked via separate keydown/keyup on
//     ShiftLeft/Right + ControlLeft/Right codes so a press-and-hold of
//     Shift mid-pan changes speed without needing a fresh WASD keydown.
//   - blur event clears all pressed state so a tab-away mid-W doesn't
//     leave the map panning forever.
//
// Leaflet detection: walks .leaflet-container elements for an attached
// map object. Prefers `__aim_map__` (set by Map Styler via prototype
// patch), falls back to property scan. Self-contained — doesn't require
// Map Styler to be installed, but uses its hint when present.
//
// Log tag: [AIM NAV]

(function () {
    'use strict';

    const TAG = '[AIM NAV]';
    const SCRIPT_VERSION = '0.1';
    const IS_TOP = window === window.top;
    const FRAME = IS_TOP ? 'TOP' : 'IFRAME';

    console.log(`${TAG} v${SCRIPT_VERSION} init (${FRAME})`);

    // ------- Tunables -------
    const PAN_SPEED = 8;             // px per frame at base (60fps → ~480 px/s)
    const ZOOM_STEP_BASE = 0.5;      // Leaflet zoom levels per tick at base
    const ZOOM_STEP_SPRINT = 1.0;
    const ZOOM_STEP_PRECISE = 0.25;
    const SPRINT_MULT = 3;
    const PRECISE_MULT = 0.3;
    const ZOOM_INTERVAL_MS = 200;    // throttle zoom to 5/sec at base

    // ------- State -------
    let masterEnabled = true;
    let panEnabled = true;
    let zoomEnabled = true;

    const motion = new Set();        // 'w','a','s','d','q','e'
    let shiftHeld = false;
    let ctrlHeld = false;
    let rafId = null;
    let lastZoomAt = 0;

    // ------- Leaflet map detection -------
    let leafletMapRef = null;

    function looksLikeLeafletMap(v) {
        return v && typeof v === 'object'
            && typeof v.panBy === 'function'
            && typeof v.zoomIn === 'function'
            && typeof v.zoomOut === 'function'
            && typeof v.getContainer === 'function'
            && typeof v.getCenter === 'function';
    }

    function getLeafletMap() {
        if (leafletMapRef && leafletMapRef._container && document.body.contains(leafletMapRef._container)) {
            return leafletMapRef;
        }
        leafletMapRef = null;
        const containers = document.querySelectorAll('.leaflet-container');
        for (const container of containers) {
            // Prefer hints set by other AIM scripts.
            const hints = [container.__aim_map__, container._leaflet_map, container._leaflet];
            for (const c of hints) {
                if (looksLikeLeafletMap(c)) { leafletMapRef = c; return c; }
            }
            // Enumerable property scan.
            for (const k in container) {
                try {
                    const v = container[k];
                    if (looksLikeLeafletMap(v)) { leafletMapRef = v; return v; }
                } catch (e) {}
            }
            // Non-enumerable fallback.
            try {
                for (const k of Object.getOwnPropertyNames(container)) {
                    try {
                        const v = container[k];
                        if (looksLikeLeafletMap(v)) { leafletMapRef = v; return v; }
                    } catch (e) {}
                }
            } catch (e) {}
        }
        return null;
    }

    // ------- Input guard -------
    function shouldGate(e) {
        const t = e.target;
        if (!t) return false;
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (t.isContentEditable) return true;
        if (t.classList && (
            t.classList.contains('ant-input') ||
            t.classList.contains('ant-select') ||
            t.classList.contains('ant-select-selection-search-input')
        )) return true;
        if (t.getAttribute && t.getAttribute('role') === 'textbox') return true;
        return false;
    }

    // ------- rAF tick -------
    function tick() {
        if (!motion.size) { rafId = null; return; }
        const map = getLeafletMap();
        if (map) {
            const mult = shiftHeld ? SPRINT_MULT : (ctrlHeld ? PRECISE_MULT : 1);

            // Pan
            if (panEnabled) {
                let dx = 0, dy = 0;
                if (motion.has('w')) dy -= PAN_SPEED * mult;
                if (motion.has('s')) dy += PAN_SPEED * mult;
                if (motion.has('a')) dx -= PAN_SPEED * mult;
                if (motion.has('d')) dx += PAN_SPEED * mult;
                if (dx || dy) {
                    try { map.panBy([dx, dy], { animate: false, noMoveStart: true }); }
                    catch (e) {}
                }
            }

            // Zoom — throttled. zoomIn beats zoomOut on the same tick.
            if (zoomEnabled) {
                const now = performance.now();
                if (now - lastZoomAt >= ZOOM_INTERVAL_MS) {
                    const step = shiftHeld ? ZOOM_STEP_SPRINT
                                : (ctrlHeld ? ZOOM_STEP_PRECISE : ZOOM_STEP_BASE);
                    if (motion.has('e')) {
                        try { map.zoomIn(step, { animate: false }); lastZoomAt = now; }
                        catch (e) {}
                    } else if (motion.has('q')) {
                        try { map.zoomOut(step, { animate: false }); lastZoomAt = now; }
                        catch (e) {}
                    }
                }
            }
        }
        rafId = requestAnimationFrame(tick);
    }

    function startTick() {
        if (rafId != null) return;
        rafId = requestAnimationFrame(tick);
    }

    // ------- Key handling -------
    const KEY_CODES = {
        'KeyW': 'w', 'KeyA': 'a', 'KeyS': 's', 'KeyD': 'd',
        'KeyQ': 'q', 'KeyE': 'e',
    };
    const MOD_CODES_SHIFT = new Set(['ShiftLeft', 'ShiftRight']);
    const MOD_CODES_CTRL = new Set(['ControlLeft', 'ControlRight']);

    function onKeyDown(e) {
        // Track modifiers regardless of master/gate state so the speed
        // multiplier updates instantly when user holds Shift mid-pan.
        if (MOD_CODES_SHIFT.has(e.code)) { shiftHeld = true; return; }
        if (MOD_CODES_CTRL.has(e.code))  { ctrlHeld = true;  return; }

        if (!masterEnabled) return;
        if (shouldGate(e)) return;

        const mapped = KEY_CODES[e.code];
        if (!mapped) return;

        // Gate per-feature toggle.
        const isPan = (mapped === 'w' || mapped === 'a' || mapped === 's' || mapped === 'd');
        const isZoom = (mapped === 'q' || mapped === 'e');
        if (isPan && !panEnabled) return;
        if (isZoom && !zoomEnabled) return;

        motion.add(mapped);
        startTick();
        // Stop the browser from also acting on the key (no native browser
        // shortcut binds these, but prevents Percepto handlers from racing).
        try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
    }

    function onKeyUp(e) {
        if (MOD_CODES_SHIFT.has(e.code)) { shiftHeld = false; return; }
        if (MOD_CODES_CTRL.has(e.code))  { ctrlHeld = false;  return; }
        const mapped = KEY_CODES[e.code];
        if (mapped) motion.delete(mapped);
    }

    function onBlur() {
        // Tab-away mid-W → no keyup fires. Clear everything so the map
        // doesn't keep panning when focus returns.
        motion.clear();
        shiftHeld = false;
        ctrlHeld = false;
        if (rafId != null) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = null; }
    }

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);

    // ------- Control Panel integration -------
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-map-nav';
    let controlChannel = null;

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} control channel unavailable:`, e); return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') {
                registerWithControlPanel();
            } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                const v = msg.value !== undefined ? msg.value : msg.enabled;
                if (msg.toggleId === 'master')  masterEnabled = !!v;
                else if (msg.toggleId === 'pan')  panEnabled  = !!v;
                else if (msg.toggleId === 'zoom') zoomEnabled = !!v;
            }
        };
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        try {
            controlChannel.postMessage({
                type: 'REGISTER',
                scriptId: SCRIPT_ID,
                name: 'Map Nav',
                version: SCRIPT_VERSION,
                toggles: [
                    { id: 'master', label: 'Enable Map Nav (WASD pan · Q/E zoom)', type: 'boolean', default: true, master: true },
                    { id: 'pan',    label: 'WASD pan',                              type: 'boolean', default: true },
                    { id: 'zoom',   label: 'Q/E zoom (out/in)',                     type: 'boolean', default: true },
                ],
                hotkeys: [],
            });
        } catch (e) {}
    }

    setupControlPanel();
    registerWithControlPanel();

    console.log(`${TAG} v${SCRIPT_VERSION} ready (${FRAME}) — WASD pan · Q/E zoom · Shift sprint · Ctrl precise`);
})();
