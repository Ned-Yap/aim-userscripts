// ==UserScript==
// @name         Latest - AIM Map Nav
// @namespace    http://tampermonkey.net/
// @version      0.9
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Map_Nav.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Map_Nav.user.js
// @description  Keyboard nav for the Percepto map. WASD pan / Q-E zoom out-in (always-on). ALT for sprint (3x). SPACE = zoom-to-fit entire site setup. Other Shift/Ctrl + nav keys pass through to existing macros (Shift+D Delete etc.) and browser shortcuts. For zoom-into-area use Leaflet's native Shift+drag box-zoom. Input-guarded so typing is unaffected.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// v0.7 design
// ===========
// Bindings (always-on, NOT modal):
//   W/A/S/D       = pan up/left/down/right
//   Q             = zoom out
//   E             = zoom in
//   Alt + WASD/QE = sprint (3x pan, 1.0 zoom-levels)
//   Space         = zoom-to-fit entire site setup
//
// For zoom-into-an-area use Leaflet's native Shift+drag box-zoom.
// Map Nav used to have a Shift+Space cursor-zoom (v0.4-v0.6) but the
// native box-zoom is strictly better — drop in v0.7.
//
// IMPORTANT: Shift + ANY nav key bypasses Map Nav and falls through to
// the existing macros (Shift+D Delete, Shift+S/A/R/B/C, etc.). Ctrl +
// ANY nav key also falls through — Ctrl+W close-tab, Ctrl+S save,
// Ctrl+D bookmark, Ctrl+Q close-window are all browser-level and we
// must NOT intercept them.
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
//     getLatLng or getLatLngs (Percepto's markers + polygons), unions
//     bounds, fitBounds with padding. When invoked from TOP, forwarded
//     to iframe via AIM_MAP_NAV_FORWARD channel for state consistency.
//   - blur clears state so tab-away doesn't strand a panning map.
//
// Leaflet detection: walks .leaflet-container elements in the local
// document AND in same-origin iframe contentDocuments. Critical for
// the TOP frame to find the map (Percepto's map lives in an iframe).
// Without this, keydown in TOP would no-op until the user manually
// clicks the map (which shifts focus to the iframe). Prefers
// __aim_map__ hint set by Map Styler, falls back to property scan.
//
// Log tag: [AIM NAV]

(function () {
    'use strict';

    const TAG = '[AIM NAV]';
    const SCRIPT_VERSION = '0.9';
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

    function findMapInDoc(doc) {
        if (!doc || typeof doc.querySelectorAll !== 'function') return null;
        let containers;
        try { containers = doc.querySelectorAll('.leaflet-container'); }
        catch (e) { return null; }
        for (const container of containers) {
            // Prefer hints set by other AIM scripts.
            const hints = [container.__aim_map__, container._leaflet_map, container._leaflet];
            for (const c of hints) {
                if (looksLikeLeafletMap(c)) return c;
            }
            for (const k in container) {
                try {
                    const v = container[k];
                    if (looksLikeLeafletMap(v)) return v;
                } catch (e) {}
            }
            try {
                for (const k of Object.getOwnPropertyNames(container)) {
                    try {
                        const v = container[k];
                        if (looksLikeLeafletMap(v)) return v;
                    } catch (e) {}
                }
            } catch (e) {}
        }
        return null;
    }

    function getLeafletMap() {
        // Cached + still attached → reuse.
        if (leafletMapRef && leafletMapRef._container) {
            const c = leafletMapRef._container;
            // Check both the local document AND any same-origin iframe doc.
            if (document.body.contains(c)) return leafletMapRef;
            try {
                const iframes = document.querySelectorAll('iframe');
                for (const f of iframes) {
                    try {
                        if (f.contentDocument && f.contentDocument.contains(c)) return leafletMapRef;
                    } catch (e) {}
                }
            } catch (e) {}
        }
        leafletMapRef = null;

        // Local document first.
        let m = findMapInDoc(document);
        if (m) { leafletMapRef = m; return m; }

        // v0.5: walk same-origin iframes too. Fixes the "WASD doesn't
        // work until I M1-click the map" bug — when focus is on the
        // TOP frame, keydown fires here but the map lives inside the
        // iframe. Without this walk, getLeafletMap returns null in TOP
        // and motion silently no-ops. Same-origin only (Percepto's
        // iframe is same-domain so this is fine).
        try {
            const iframes = document.querySelectorAll('iframe');
            for (const f of iframes) {
                let doc = null;
                try { doc = f.contentDocument; } catch (e) {}
                if (!doc) continue;
                m = findMapInDoc(doc);
                if (m) { leafletMapRef = m; return m; }
            }
        } catch (e) {}

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

    // v0.7: zoomInCloseAtCursor + cursor tracking removed. Use Leaflet's
    // built-in Shift+drag box-zoom instead (strictly better UX).

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
        // v0.8: preventDefault on Alt so the browser doesn't focus the menu
        // bar and steal keyboard focus from the map — that's what made Alt +
        // diagonal (e.g. W+A) hang until a mouse click-drag restored focus.
        // Gated on masterEnabled so we only claim Alt when nav is actually on.
        if (MOD_CODES_ALT.has(e.code)) {
            altHeld = true;
            if (masterEnabled) { try { e.preventDefault(); } catch (err) {} }
            return;
        }

        if (!masterEnabled) return;
        // Release the keys while the Site Setup Generator is dragging an FFZ
        // preview (it claims Q/E to rotate + WASD shouldn't pan). The flag is
        // set on the page window by AIM Asset Inspector during a drag.
        try { if (window.__AIM_FFZ_DRAG) return; } catch (e) {}
        if (shouldGate(e)) return;

        // v0.3: Shift + ANY nav key → pass through to existing macros
        // (Shift+D Delete, Shift+A Altitude, …) and Leaflet's native
        // Shift+drag box-zoom. Ctrl + ANY nav key → pass through to
        // browser shortcuts (Ctrl+W close-tab, Ctrl+S save, …). Never
        // preventDefault when these modifiers are held.
        if (e.shiftKey || e.ctrlKey || e.metaKey) return;

        // Space → zoom-to-fit entire site setup. One-shot, not held.
        // v0.6: forward from TOP to iframe for consistency (also avoids
        // any iframe-vs-TOP state divergence on which layers are present).
        if (e.code === 'Space') {
            if (!spaceEnabled) return;
            try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
            if (IS_TOP && navChannel) {
                try { navChannel.postMessage({ type: 'SPACE_FIT' }); } catch (err) {}
            } else {
                fitMapToSiteSetup();
            }
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
        if (MOD_CODES_ALT.has(e.code)) {
            altHeld = false;
            // v0.8: also clear motion on Alt-up. While Alt is held some
            // browsers drop the keyup for the OTHER keys, so a diagonal could
            // leave w/a/s/d stuck in the Set; clearing here guarantees the map
            // stops when the user lets go of the sprint modifier.
            motion.clear();
            if (masterEnabled) { try { e.preventDefault(); } catch (err) {} }
            return;
        }
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
                    { id: 'space',  label: 'Space = zoom-to-fit site',     type: 'boolean', default: true },
                ],
                hotkeys: [],
            });
        } catch (e) {}
    }

    setupControlPanel();
    registerWithControlPanel();

    // ------- Cross-frame forwarding -------
    // When TOP catches Space (zoom-to-fit), forward to iframe so the
    // iframe handles using its own map state. v0.6 originally added
    // this for Shift+Space's cursor-zoom (TOP's cursor tracker goes
    // stale once the cursor enters the iframe area). v0.7 dropped
    // Shift+Space entirely in favor of Leaflet's native Shift+drag
    // box-zoom, but kept the channel for plain Space to keep behavior
    // consistent regardless of which frame has focus.
    const NAV_FORWARD_CHANNEL = 'AIM_MAP_NAV_FORWARD';
    let navChannel = null;
    try { navChannel = new BroadcastChannel(NAV_FORWARD_CHANNEL); }
    catch (e) { console.warn(`${TAG} nav forward channel unavailable:`, e); }
    if (navChannel && !IS_TOP) {
        navChannel.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type === 'SPACE_FIT') fitMapToSiteSetup();
        };
    }

    console.log(`${TAG} v${SCRIPT_VERSION} ready (${FRAME}) — WASD pan · Q/E zoom · Alt sprint · Space = fit site · Shift/Ctrl pass through (use Shift+drag for box-zoom)`);
})();
