// ==UserScript==
// @name         Latest - AIM Map Nav
// @namespace    http://tampermonkey.net/
// @version      0.3
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Map_Nav.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Map_Nav.user.js
// @description  Keyboard nav for the Percepto map. WASD pan / Q-E zoom out-in (always-on). ALT for sprint (3x). SPACE = zoom-to-fit entire site setup. Shift/Ctrl + nav keys pass through to existing macros (Shift+D Delete etc.) and browser shortcuts. Input-guarded so typing is unaffected. Control Panel: master + pan + zoom + space toggles.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// v0.3 design
// ===========
// Bindings (always-on, NOT modal):
//   W/A/S/D       = pan up/left/down/right
//   Q             = zoom out
//   E             = zoom in
//   Alt + WASD/QE = sprint (3x pan, 1.0 zoom-levels)
//   Space         = zoom-to-fit entire site setup
//
// IMPORTANT: Shift + ANY nav key bypasses Map Nav and falls through to
// the existing macros (Shift+D Delete, Shift+S/A/R/B/C, etc.). Ctrl +
// ANY nav key also falls through — Ctrl+W close-tab, Ctrl+S save,
// Ctrl+D bookmark, Ctrl+Q close-window are all browser-level and we
// must NOT intercept them.
//
// History: v0.1 was always-on WASD with Shift sprint — Shift+letter
// macros all broke. v0.2 was hold-Space-to-engage modal — user found it
// awkward (holding Space + Shift + WASD ergonomically painful, slip-off
// triggered the old Shift+letter macros anyway). v0.3 keeps WASD/QE
// always-on but routes Shift/Ctrl out of Map Nav so the macros never
// collide. Sprint moves to Alt, which doesn't collide with anything
// the user has bound.
//
// Architecture:
//   - Motion keys (WASD/QE) added to a Set on keydown, removed on
//     keyup. requestAnimationFrame tick while any held → smooth ~60fps
//     pan. Zoom throttled to one step per 200ms (OS auto-repeat at
//     ~30Hz would otherwise burn 30 levels/sec).
//   - Alt modifier tracked via AltLeft/AltRight keydown/keyup so the
//     speed multiplier updates instantly mid-pan.
//   - Shift/Ctrl checked PER EVENT (e.shiftKey / e.ctrlKey) — if true
//     on a motion-key event, we return early without preventDefault,
//     leaving the macro / browser shortcut path untouched.
//   - Space → fitMapToSiteSetup: walks map.eachLayer for any layer with
//     getLatLng or getLatLngs (Percepto's markers + polygons + our
//     KML SVG paths if they happen to be Leaflet layers), unions
//     bounds, fitBounds with padding.
//   - blur clears state so tab-away doesn't strand a panning map.
//
// Leaflet detection: walks .leaflet-container elements. Prefers
// __aim_map__ (Map Styler's hint), falls back to property scan.
//
// Log tag: [AIM NAV]

(function () {
    'use strict';

    const TAG = '[AIM NAV]';
    const SCRIPT_VERSION = '0.3';
    const IS_TOP = window === window.top;
    const FRAME = IS_TOP ? 'TOP' : 'IFRAME';

    console.log(`${TAG} v${SCRIPT_VERSION} init (${FRAME})`);

    // ------- Tunables -------
    const PAN_SPEED = 8;             // px per frame at base (60fps → ~480 px/s)
    const ZOOM_STEP_BASE = 0.5;      // Leaflet zoom levels per tick at base
    const ZOOM_STEP_SPRINT = 1.0;
    const SPRINT_MULT = 3;
    const ZOOM_INTERVAL_MS = 200;    // throttle zoom to 5/sec at base
    const FIT_PADDING_PX = 60;

    // ------- State -------
    let masterEnabled = true;
    let panEnabled = true;
    let zoomEnabled = true;
    let spaceEnabled = true;

    const motion = new Set();        // 'w','a','s','d','q','e'
    let altHeld = false;             // v0.3: Alt = sprint (no Shift/Ctrl)
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
            const mult = altHeld ? SPRINT_MULT : 1;

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
                    const step = altHeld ? ZOOM_STEP_SPRINT : ZOOM_STEP_BASE;
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

    // ------- Zoom-to-fit (Space) -------
    // Walk every Leaflet layer with location data; union their bounds;
    // fitBounds with padding. Skips tile layers (no getLatLng/getLatLngs).
    // KML lines rendered as raw SVG (Map Styler does this) won't show up
    // here — Percepto's own markers/polygons usually cover the site
    // extent though, so this is a reasonable proxy for "entire site setup".
    function fitMapToSiteSetup() {
        const map = getLeafletMap();
        if (!map) return false;
        let L;
        try { L = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).L; }
        catch (e) { return false; }
        if (!L || typeof L.latLngBounds !== 'function') return false;

        const bounds = L.latLngBounds([]);
        const flattenLatLngs = (arr, out) => {
            if (!arr) return;
            if (Array.isArray(arr)) { arr.forEach(x => flattenLatLngs(x, out)); return; }
            if (arr && typeof arr.lat === 'number' && typeof arr.lng === 'number') out.push(arr);
        };

        try {
            map.eachLayer(layer => {
                try {
                    if (typeof layer.getLatLng === 'function') {
                        const ll = layer.getLatLng();
                        if (ll && typeof ll.lat === 'number') bounds.extend(ll);
                    } else if (typeof layer.getLatLngs === 'function') {
                        const out = [];
                        flattenLatLngs(layer.getLatLngs(), out);
                        out.forEach(p => bounds.extend(p));
                    }
                } catch (e) {}
            });
        } catch (e) {
            console.warn(`${TAG} fitMapToSiteSetup: eachLayer failed:`, e);
            return false;
        }

        if (!bounds.isValid()) {
            console.log(`${TAG} fitMapToSiteSetup: no valid bounds (no markers/polygons on map yet?)`);
            return false;
        }
        try {
            map.fitBounds(bounds, { padding: [FIT_PADDING_PX, FIT_PADDING_PX], animate: true, maxZoom: 20 });
            return true;
        } catch (e) { return false; }
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
    const MOD_CODES_ALT = new Set(['AltLeft', 'AltRight']);

    function onKeyDown(e) {
        // Track Alt (sprint modifier) regardless of master/gate state.
        if (MOD_CODES_ALT.has(e.code)) { altHeld = true; return; }

        if (!masterEnabled) return;
        if (shouldGate(e)) return;

        // v0.3: Shift + ANY nav key → pass through to existing macros.
        // Ctrl + ANY nav key → pass through to browser shortcuts. Never
        // preventDefault when these modifiers are held.
        if (e.shiftKey || e.ctrlKey || e.metaKey) return;

        // Space → zoom-to-fit entire site setup. One-shot, not held.
        if (e.code === 'Space') {
            if (!spaceEnabled) return;
            const did = fitMapToSiteSetup();
            // Only swallow Space when we actually had a map to act on,
            // otherwise let it pass through (might be a real user
            // intention elsewhere). preventDefault prevents browser
            // page-scroll-down on Space.
            if (did) { try { e.preventDefault(); e.stopPropagation(); } catch (err) {} }
            return;
        }

        const mapped = KEY_CODES[e.code];
        if (!mapped) return;

        // Gate per-feature toggle.
        const isPan = (mapped === 'w' || mapped === 'a' || mapped === 's' || mapped === 'd');
        const isZoom = (mapped === 'q' || mapped === 'e');
        if (isPan && !panEnabled) return;
        if (isZoom && !zoomEnabled) return;

        motion.add(mapped);
        startTick();
        try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
    }

    function onKeyUp(e) {
        if (MOD_CODES_ALT.has(e.code)) { altHeld = false; return; }
        const mapped = KEY_CODES[e.code];
        if (mapped) motion.delete(mapped);
    }

    function onBlur() {
        // Tab-away mid-W → no keyup fires. Clear everything so the map
        // doesn't keep panning when focus returns.
        motion.clear();
        altHeld = false;
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
                if (msg.toggleId === 'master')      masterEnabled = !!v;
                else if (msg.toggleId === 'pan')    panEnabled    = !!v;
                else if (msg.toggleId === 'zoom')   zoomEnabled   = !!v;
                else if (msg.toggleId === 'space')  spaceEnabled  = !!v;
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
                    { id: 'master', label: 'Enable Map Nav', type: 'boolean', default: true, master: true },
                    { id: 'pan',    label: 'WASD pan (Alt for sprint)',     type: 'boolean', default: true },
                    { id: 'zoom',   label: 'Q/E zoom (Alt for sprint)',     type: 'boolean', default: true },
                    { id: 'space',  label: 'Space = zoom-to-fit site',      type: 'boolean', default: true },
                ],
                hotkeys: [],
            });
        } catch (e) {}
    }

    setupControlPanel();
    registerWithControlPanel();

    console.log(`${TAG} v${SCRIPT_VERSION} ready (${FRAME}) — WASD pan · Q/E zoom · Alt sprint · Space = fit site · Shift/Ctrl pass through`);
})();
