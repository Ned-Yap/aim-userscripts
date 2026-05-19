// ==UserScript==
// @name         AIM Map Styler
// @namespace    http://tampermonkey.net/
// @version      34.12
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_SS_Outlines_Tampermonkey.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_SS_Outlines_Tampermonkey.user.js
// @description  Adds buffers/outlines to map lines and enforces line thicknesses. Toggle with Shift+O. Loads per-site shielding KMLs from a private GitHub repo.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @run-at       document-end
// ==/UserScript==

(function() {
    const TRIGGER_KEY_CODE = 'KeyO';
    const CONTEXT = window === window.top ? "TOP" : "IFRAME";
    const CHANNEL_NAME = "AIM_STYLER_CHANNEL";
    const FRAME_ID = `${CONTEXT}@${location.pathname}${location.search ? '?' + location.search.slice(0, 40) : ''}`;
    const TAG = `[AIM STYLER ${FRAME_ID}]`;

    console.log(`${TAG} 🎨 Initializing v${ '34.12' }...`);

    const stateChannel = new BroadcastChannel(CHANNEL_NAME);
    stateChannel.onmessage = (event) => {
        if (event.data.action === "TOGGLE") setActiveState(event.data.state);
    };

    // --- AIM Control Panel integration ---
    // Registers with AIM_Control_Panel.js for centralized toggle/hotkey UI.
    // Backwards-compatible: if the control panel isn't loaded, the script still
    // works on its own with Shift+O.
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-styler';
    // Bump this whenever the @version header changes — it's what the control
    // panel displays next to the script name so you can verify which version
    // is actually loaded in Tampermonkey.
    const SCRIPT_VERSION = '34.12';
    // Schema: each category owns its own sub-toggles (shielding, edit-mode,
    // hide-native, force-thickness). No global masters for those — each
    // category controls what applies to itself. Shielding's visual styling
    // (color/opacity/distance) lives in Advanced as a shared knob since
    // toggles in different categories share the same shielding appearance.
    const TOGGLES = [
        { id: 'master', label: 'Show Overlays (Master)', type: 'boolean', default: true, master: true },
        {
            type: 'category',
            id: 'ffz-cat',
            label: 'Free Fly Zone (FFZ) - Overlays',
            meta: '(green)',
            master: { id: 'ffz.show', default: true },
            children: [
                { id: 'ffz.buffer', label: 'Show buffer', type: 'boolean', default: true },
                { id: 'ffz.distance', label: 'Buffer distance', type: 'number',
                  min: 5, max: 500, step: 1, default: 15, unit: 'ft' },
                { id: 'ffz.color', label: 'Buffer color', type: 'color', default: '#5fff5f' },
                { id: 'ffz.opacity', label: 'Buffer opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.4, unit: 'fill' },
                { id: 'ffz.line-color', label: 'Line color (override)', type: 'color', default: '#5fff5f' },
                { id: 'ffz.line-opacity', label: 'Line opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 1, unit: 'fill' },
                { id: 'ffz.force-thickness', label: 'Force line thickness', type: 'boolean', default: true },
                { id: 'ffz.edit-mode', label: 'Show in edit mode', type: 'boolean', default: true },
                { id: 'ffz.shielding', label: 'Show shielding (200ft)', type: 'boolean', default: false },
                { id: 'ffz.violations', label: 'Flag violations (assets within Xft)', type: 'boolean', default: true },
                { id: 'ffz.violation-distance', label: 'Violation distance', type: 'number',
                  min: 1, max: 100, step: 1, default: 15, unit: 'ft' },
                { id: 'ffz.hide-native', label: 'Hide native (green / dashed FFZ)', type: 'boolean', default: true },
            ],
        },
        {
            type: 'category',
            id: 'asset-cat',
            label: 'Asset - Overlays',
            meta: '(white)',
            master: { id: 'asset.show', default: true },
            children: [
                { id: 'asset.buffer', label: 'Show buffer', type: 'boolean', default: true },
                { id: 'asset.distance', label: 'Buffer distance', type: 'number',
                  min: 5, max: 500, step: 1, default: 15, unit: 'ft' },
                { id: 'asset.color', label: 'Buffer color', type: 'color', default: '#ffffff' },
                { id: 'asset.opacity', label: 'Buffer opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.4, unit: 'fill' },
                { id: 'asset.line-color', label: 'Line color (override)', type: 'color', default: '#ffffff' },
                { id: 'asset.line-opacity', label: 'Line opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 1, unit: 'fill' },
                { id: 'asset.fill', label: 'Show asset fill', type: 'boolean', default: true },
                { id: 'asset.fill-color', label: 'Fill color', type: 'color', default: '#ffffff' },
                { id: 'asset.fill-opacity', label: 'Fill opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 1, unit: 'fill' },
                { id: 'asset.force-thickness', label: 'Force line thickness', type: 'boolean', default: true },
                { id: 'asset.edit-mode', label: 'Show in edit mode', type: 'boolean', default: true },
                { id: 'asset.locked', label: 'Lock assets (Shift+click to interact)', type: 'boolean', default: false },
            ],
        },
        {
            type: 'category',
            id: 'fp-cat',
            label: 'Flight Path (FP) - Overlays',
            meta: '(blue)',
            master: { id: 'fp.show', default: true },
            children: [
                { id: 'fp.buffer', label: 'Show buffer', type: 'boolean', default: true },
                { id: 'fp.distance', label: 'Buffer distance', type: 'number',
                  min: 5, max: 500, step: 1, default: 40, unit: 'ft' },
                { id: 'fp.color', label: '40ft buffer color', type: 'color', default: '#1ca0de' },
                { id: 'fp.opacity', label: '40ft buffer opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.5, unit: 'fill' },
                { id: 'fp.line-color', label: 'Line color (override)', type: 'color', default: '#1ca0de' },
                { id: 'fp.line-opacity', label: 'Line opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 1, unit: 'fill' },
                { id: 'fp.65ft-band', label: 'Show 65ft outer band', type: 'boolean', default: true },
                { id: 'fp.65ft-distance', label: '65ft band distance', type: 'number',
                  min: 5, max: 500, step: 1, default: 65, unit: 'ft' },
                { id: 'fp.65ft-color', label: '65ft band color', type: 'color', default: '#1ca0de' },
                { id: 'fp.65ft-opacity', label: '65ft band opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.225, unit: 'fill' },
                { id: 'fp.show-vertices', label: 'Always show vertex dots (off: only while editing)', type: 'boolean', default: false },
                { id: 'fp.vertex-color', label: 'Vertex dot color', type: 'color', default: '#1ca0de' },
                { id: 'fp.vertex-size', label: 'Vertex dot size', type: 'number',
                  min: 2, max: 20, step: 1, default: 10, unit: 'px' },
                { id: 'fp.force-thickness', label: 'Force line thickness', type: 'boolean', default: true },
                { id: 'fp.shielding', label: 'Show shielding (200ft)', type: 'boolean', default: false },
                { id: 'fp.violations', label: 'Flag violations (assets within Xft of main line)', type: 'boolean', default: true },
                { id: 'fp.violation-distance', label: 'Violation distance', type: 'number',
                  min: 1, max: 100, step: 1, default: 15, unit: 'ft' },
                { id: 'fp.hide-native', label: 'Hide native (blue gradient / dashed FP)', type: 'boolean', default: true },
            ],
        },
        {
            type: 'category',
            id: 'altitude-cat',
            label: 'Altitude marker shield',
            meta: '(purple)',
            master: { id: 'altitude.show', default: true },
            children: [
                { id: 'altitude.shield', label: 'Show shield circle', type: 'boolean', default: true },
                { id: 'altitude.distance', label: 'Distance multiplier', type: 'number',
                  min: 0.5, max: 3, step: 0.1, default: 1.0, unit: '× 200ft' },
                { id: 'altitude.color', label: 'Color', type: 'color', default: '#8a2be2' },
                { id: 'altitude.opacity', label: 'Opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.15, unit: 'fill' },
            ],
        },
        {
            type: 'category',
            id: 'distro-cat',
            label: 'Distribution Lines (User KML)',
            meta: '(yellow)',
            master: { id: 'distro.show', default: true },
            children: [
                { id: 'distro.outline', label: 'Show outlines', type: 'boolean', default: true },
                { id: 'distro.color', label: 'Outline color', type: 'color', default: '#ffd700' },
                { id: 'distro.opacity', label: 'Outline opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.9, unit: 'fill' },
                { id: 'distro.thickness', label: 'Outline thickness', type: 'number',
                  min: 1, max: 12, step: 1, default: 3, unit: 'px' },
            ],
        },
        {
            type: 'category',
            id: 'trans-cat',
            label: 'Transmission Lines (User KML)',
            meta: '(red — taller / more hazardous)',
            master: { id: 'trans.show', default: true },
            children: [
                { id: 'trans.outline', label: 'Show outlines', type: 'boolean', default: true },
                { id: 'trans.color', label: 'Outline color', type: 'color', default: '#ff3030' },
                { id: 'trans.opacity', label: 'Outline opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.9, unit: 'fill' },
                { id: 'trans.thickness', label: 'Outline thickness', type: 'number',
                  min: 1, max: 12, step: 1, default: 4, unit: 'px' },
            ],
        },
        {
            type: 'category',
            id: 'validator-cat',
            label: 'Coverage Validator',
            meta: '(200ft FAA rule — on-demand)',
            master: { id: 'validator.show', default: true },
            children: [
                { id: 'validator.distance', label: 'Required coverage', type: 'number',
                  min: 50, max: 500, step: 10, default: 200, unit: 'ft' },
                { id: 'validator.sample-spacing', label: 'Sample every', type: 'number',
                  min: 2, max: 50, step: 1, default: 10, unit: 'ft' },
                { id: 'validator-run', label: 'Run coverage check', type: 'button', action: 'run-validator' },
                { id: 'validator-clear', label: 'Clear pins', type: 'button', action: 'clear-validator' },
                { id: 'validator.show-dismissed', label: 'Show dismissed pins', type: 'boolean', default: false },
            ],
        },
        {
            type: 'category',
            id: 'ortho-cat',
            label: 'Orthomosaic',
            meta: '(brightness + perf)',
            master: { id: 'ortho.show', default: true },
            children: [
                { id: 'ortho.brightness', label: 'Brightness', type: 'number',
                  min: 0.2, max: 1.0, step: 0.05, default: 1.0, unit: '×' },
                { id: 'ortho.low-res', label: 'Low-res mode (perf)', type: 'boolean', default: false },
                { id: 'ortho.max-zoom', label: 'Low-res cap zoom', type: 'number',
                  min: 10, max: 20, step: 1, default: 15 },
            ],
        },
        {
            type: 'advanced',
            id: 'styler-advanced',
            label: 'Advanced',
            children: [
                { id: 'line-thickness', label: 'Line thickness', type: 'number',
                  min: 1, max: 20, step: 1, default: 10, unit: 'px' },
                {
                    id: 'standard-ratio', label: 'Buffer scale reference', type: 'select',
                    options: [
                        { value: 1.2, label: 'Tight (~10ft)' },
                        { value: 1.8, label: 'Default (~15ft)' },
                        { value: 3.6, label: 'Medium (~30ft)' },
                        { value: 7.8, label: 'Wide (~65ft)' },
                    ],
                    default: 1.8,
                },
                // Shielding's visual styling — shared across FFZ.shielding and
                // FP.shielding so toggling shielding for both gets the same look.
                { id: 'shielding.color', label: 'Shielding color', type: 'color', default: '#ff8c00' },
                { id: 'shielding.opacity', label: 'Shielding opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.15, unit: 'fill' },
                { id: 'shielding.distance', label: 'Shielding distance', type: 'number',
                  min: 0.5, max: 3, step: 0.1, default: 1.0, unit: '× 200ft' },
            ],
        },
    ];
    const HOTKEYS = [
        { id: 'toggle-master', label: 'Toggle overlays', default: 'Shift+O' },
    ];
    // Flatten advanced AND category groups so every leaf setting (and each
    // category's master checkbox) gets an entry in toggleState. Without this,
    // category children stay undefined at init — runUpdate then evaluates
    // wantXXX as falsy and renders nothing until the user manually toggles
    // every setting (which populates them one at a time via SET_TOGGLE).
    function flattenToggles(arr) {
        const out = [];
        (arr || []).forEach(t => {
            if (!t) return;
            if ((t.type === 'advanced' || t.type === 'category') && Array.isArray(t.children)) {
                if (t.type === 'category' && t.master && t.master.id) {
                    out.push({ id: t.master.id, default: t.master.default });
                }
                t.children.forEach(c => { if (c && c.id) out.push(c); });
            } else if (t.id) {
                out.push(t);
            }
        });
        return out;
    }
    const toggleState = {};
    flattenToggles(TOGGLES).forEach(t => { toggleState[t.id] = t.default; });
    let controlChannel = null;
    // True once we've received any message on the control channel — means the
    // panel is loaded and routing hotkeys for us. We then skip our own
    // keydown handler to avoid double-toggling.
    let controlPanelDetected = false;

    // --- Selectors ---
    const GREEN_BUFFER_SELECTOR = 'path.leaflet-interactive[stroke="var(--color-green)"][stroke-opacity="0.4"]';
    const SOLID_GREEN_SELECTOR = 'path.leaflet-interactive[stroke="var(--color-green)"][stroke-opacity="1"]';
    const WHITE_ASSET_SELECTOR = 'path.leaflet-interactive[stroke="#ffffff"]';
    const BLUE_FLIGHT_PATH_SELECTOR = 'path.leaflet-interactive[stroke="#1ca0de"][stroke-opacity="1"]';
    
    const ORIGINAL_BLUE_BUFFER_SELECTOR = 'path[stroke="#1ca0de"][stroke-opacity="0.4"]'; 
    const BLACK_DASHED_FP_SELECTOR = 'path[stroke="#000000"][stroke-dasharray="8 12"]'; 
    const BLACK_DASHED_FFZ_SELECTOR = 'path[stroke="#000000"][stroke-dasharray="5 15"]';

    const EDIT_MODE_SELECTOR = 'path.leaflet-interactive[stroke="#000000"][stroke-dasharray]';

    const ALL_TARGETS_SELECTOR = `${SOLID_GREEN_SELECTOR}, ${WHITE_ASSET_SELECTOR}, ${BLUE_FLIGHT_PATH_SELECTOR}, ${EDIT_MODE_SELECTOR}`;
    const CUSTOM_BUFFER_ATTR = 'data-custom-buffer-v24';

    // --- KML / Shielding ---
    const TOKEN_KEY = 'aim-github-token';
    const KMLS_REPO = 'Ned-Yap/aim-userscripts-data';
    const KMLS_BRANCH = 'main';
    const KML_CACHE_PREFIX = 'aim-kml-cache-'; // suffixed with siteID
    const SITE_ID_RE = /#\/site\/(\d+)\//;

    // --- Settings ---
    const LINE_THICKNESS = 10; // Target for Green and Blue solid lines
    const UPDATE_DELAY_MS = 50;
    // Houston-style fallback. When no legacy native buffer (>12) exists,
    // derive globalBaseWidth from the line itself instead of from the host app's
    // modern native buffer (which represents a metric distance and scales
    // aggressively with zoom — multiplying it produced runaway halos).
    // 1.8 matches the legacy buffer:line ratio on working sites (~18 : 10).
    const BUFFER_TO_LINE_RATIO = 1.8;

    // --- State ---
    let isActive = false;
    let observer = null;
    let observerTarget = null; // node the observer is currently attached to
    let heartbeatInterval = null; // periodic runUpdate fallback (see attachObserverWhenReady)
    // Fingerprint of relevant state at the end of the last successful runUpdate.
    // Heartbeat compares the current fingerprint against this and skips the
    // wipe+rebuild entirely if nothing has changed. Massive CPU savings on
    // dense sites where idle heartbeat would otherwise rebuild hundreds of
    // SVG elements 20 times/min for no visual change.
    let lastUpdateHash = null;

    // KML / shielding state — keyed by `${siteID}|${type}` where type is
    // 'distro' or 'trans'. Each entry holds an array of parsed features.
    //
    // kmlFeatures: { [`${siteID}|${type}`]: [{ type: 'line'|'polygon', coords: [{lat,lng}, ...] }] }
    // kmlFetching: Set of `${siteID}|${type}` keys currently in flight
    // kmlMissing:  Set of `${siteID}|${type}` keys we already 404'd on this session
    const kmlFeatures = {};
    const kmlFetching = new Set();
    const kmlMissing = new Set();
    const KML_TYPES = ['distro', 'trans'];
    const kmlKey = (siteID, type) => `${siteID}|${type}`;
    // Tracks whether we've already warned about no-token in the current
    // session, so we don't spam (each panel-driven SET_TOGGLE echo
    // triggered a render → fetch attempt → warn). Cleared whenever a
    // token actually arrives.
    let warnedNoToken = false;

    // Coverage Validator state — persisted to GM storage per-site so pins
    // survive reloads and site navigation. Each result holds the FULL list
    // of failing samples (segments) so we can draw the red highlight along
    // the unshielded portion of the FFZ/FP outline, plus a midpoint for
    // the numbered pin and dismissed flag for click-to-dismiss workflow.
    const validatorState = {
        // [{ number, midLat, midLng, segments: [{lat,lng}], dismissed }]
        results: [],
        lastRun: null,
    };
    const VALIDATOR_CACHE_PREFIX = 'aim-validator-';
    let leafletMapRef = null; // cached Leaflet map instance once we find it
    let leafletPatched = false; // true once we've monkey-patched L.Map.initialize
    // GM storage is per-script in Tampermonkey, so the token saved by the
    // control panel can't be read from here directly. We get it via the
    // control channel (TOKEN_VALUE message) and cache it in memory.
    let cachedToken = '';

    // --- Utility ---
    // Debounce with a maxWait safety net. Plain debounce starves under a
    // continuous mutation storm (e.g. Leaflet loading tiles + redrawing
    // during zoom) — the timer keeps resetting and the wrapped function
    // never actually runs. maxWait guarantees we fire at least every
    // maxWait ms even when calls keep coming in.
    function debounce(func, delay, maxWait) {
        let timeout;
        let firstCallTime = null;
        return function(...args) {
            const now = Date.now();
            if (firstCallTime === null) firstCallTime = now;
            clearTimeout(timeout);
            if (maxWait != null && now - firstCallTime >= maxWait) {
                firstCallTime = null;
                func.apply(this, args);
                return;
            }
            timeout = setTimeout(() => {
                firstCallTime = null;
                func.apply(this, args);
            }, delay);
        };
    }

    // --- Core Logic ---
    function runUpdate() {
        if (!isActive) return;

        // Self-healing: if Leaflet (or the host app's React) replaced the map-pane
        // node we attached to, our observer is on a detached element and
        // future mutations won't fire. Detect and re-attach.
        if (observerTarget && !document.body.contains(observerTarget)) {
            console.log(`${TAG} observer target detached — re-attaching`);
            if (observer) { observer.disconnect(); observer = null; }
            observerTarget = null;
            attachObserverWhenReady();
            // attachObserverWhenReady will call runUpdate again itself, so
            // bail out of this stale invocation.
            return;
        }

        // Read dynamic settings (may have been changed via the control panel).
        // Fall back to compile-time constants if a user pref is missing.
        const lineThickness = Number(toggleState['line-thickness']) || LINE_THICKNESS;
        const standardRatio = Number(toggleState['standard-ratio']) || BUFFER_TO_LINE_RATIO;
        const shieldingMult = Number(toggleState['shielding.distance']) || 1.0;
        // No global shielding toggle anymore — each category (FFZ, FP) has
        // its own .shielding sub-toggle, checked inside the per-line loop.

        // 1. WIPE CLEAN old buffers FIRST.
        // Must happen before the reference search: custom green buffers carry
        // stroke="var(--color-green)" and would otherwise be picked up as
        // reference elements, locking globalBaseWidth to the previous run's
        // value and creating a feedback loop (visible as runaway buffer sizes
        // during zoom mutation storms).
        document.querySelectorAll(`[${CUSTOM_BUFFER_ATTR}="true"]`).forEach(el => el.remove());

        let globalBaseWidth = null;
        let nativeBuffers = [];

        // 2. ROBUST REFERENCE SEARCH (only native elements remain at this point)
        const allGreen = document.querySelectorAll('path.leaflet-interactive[stroke="var(--color-green)"]');
        allGreen.forEach(el => {
            const w = parseFloat(el.getAttribute('stroke-width'));
            // If width > 12 (arbitrary threshold, solid line is 10), it's likely a buffer
            if (w > 12) {
                globalBaseWidth = w;
                nativeBuffers.push(el);
            }
        });

        // Backup 1: Blue Gradient
        if (!globalBaseWidth) {
            const blueRef = document.querySelector(ORIGINAL_BLUE_BUFFER_SELECTOR);
            if (blueRef) {
                globalBaseWidth = parseFloat(blueRef.getAttribute('stroke-width'));
                nativeBuffers.push(blueRef);
            }
        }

        // Still hide modern native buffers (opacity 0.4) even when we don't
        // use their width — they'd otherwise capture pointer events.
        document.querySelectorAll(GREEN_BUFFER_SELECTOR).forEach(el => nativeBuffers.push(el));

        // Backup 2: derive width from the line itself.
        // Used on sites (e.g. Houston) where neither legacy native buffers
        // (>12) nor blue gradient buffers exist. Avoids depending on
        // the host app's modern native buffer, whose width represents a metric
        // distance and scales aggressively with zoom.
        if (!globalBaseWidth) {
            globalBaseWidth = lineThickness * standardRatio;
        }

        // 3. Hide (or restore) the host app's native distractions per-category.
        // FFZ.hide-native covers the green native buffer + the dashed FFZ.
        // FP.hide-native covers the blue gradient + the dashed flight path.
        // Assets have no native distraction to hide.
        // Hide-native only applies if the category master is also on. If
        // the user disables FFZ entirely, we restore the host app's natives.
        const ffzHide = (toggleState['ffz.show'] && toggleState['ffz.hide-native']) ? 'none' : '';
        const fpHide = (toggleState['fp.show'] && toggleState['fp.hide-native']) ? 'none' : '';
        document.querySelectorAll(BLACK_DASHED_FFZ_SELECTOR).forEach(el => { el.style.display = ffzHide; });
        nativeBuffers.forEach(el => { el.style.display = ffzHide; }); // collected greens
        document.querySelectorAll(ORIGINAL_BLUE_BUFFER_SELECTOR).forEach(el => { el.style.display = fpHide; });
        document.querySelectorAll(BLACK_DASHED_FP_SELECTOR).forEach(el => { el.style.display = fpHide; });

        // 4. REBUILD & ENFORCE
        const lines = document.querySelectorAll(ALL_TARGETS_SELECTOR);
        lines.forEach(line => {
            const isSolidGreen = line.matches(SOLID_GREEN_SELECTOR);
            const isWhiteAsset = line.matches(WHITE_ASSET_SELECTOR);
            const isBlueFlight = line.matches(BLUE_FLIGHT_PATH_SELECTOR);
            const isEditMode = line.matches(EDIT_MODE_SELECTOR);

            // Per-line decisions (independent — no early-return that would
            // disable one buffer because another is off).
            const isEditAsset = isEditMode && line.classList.contains('asset');
            const isEditNonAsset = isEditMode && !line.classList.contains('asset');
            // Each rendered element is gated by: (1) its category master
            // (e.g. ffz.show) AND (2) its specific sub-toggle (e.g. ffz.buffer).
            // The category master turns the ENTIRE category off; sub-toggles
            // turn individual elements within the category off.
            //
            // Edit-mode buffers belong to the category being edited:
            //   asset class → asset.show && asset.edit-mode
            //   everything else (FFZ, possibly FP edit lines) → ffz.show && ffz.edit-mode
            const want40 = (isSolidGreen && toggleState['ffz.show'] && toggleState['ffz.buffer']) ||
                           (isWhiteAsset && toggleState['asset.show'] && toggleState['asset.buffer']) ||
                           (isBlueFlight && toggleState['fp.show'] && toggleState['fp.buffer']) ||
                           (isEditAsset && toggleState['asset.show'] && toggleState['asset.edit-mode']) ||
                           (isEditNonAsset && toggleState['ffz.show'] && toggleState['ffz.edit-mode']);
            const want65 = isBlueFlight && toggleState['fp.show'] && toggleState['fp.65ft-band'];
            // Shielding is per-category. Assets don't get shielding; edit
            // assets don't either. Edit-zone lines inherit FFZ shielding.
            const wantShield = (isSolidGreen && toggleState['ffz.show'] && toggleState['ffz.shielding']) ||
                               (isBlueFlight && toggleState['fp.show'] && toggleState['fp.shielding']) ||
                               (isEditNonAsset && toggleState['ffz.show'] && toggleState['ffz.shielding']);
            const wantForce = (isSolidGreen && toggleState['ffz.show'] && toggleState['ffz.force-thickness']) ||
                              (isWhiteAsset && toggleState['asset.show'] && toggleState['asset.force-thickness']) ||
                              (isBlueFlight && toggleState['fp.show'] && toggleState['fp.force-thickness']);
            // Asset fill applies regardless of buffer toggle — user might want
            // outlines without fill even when halos are off.
            const wantAssetFillOverride = isWhiteAsset;

            // --- Line color / opacity override (runs every iteration,
            // before the early-return below, so it applies / clears even
            // when no other category sub-toggle is active).
            // Inline-style overrides the visible stroke without touching the
            // stroke ATTRIBUTE (so our other selectors that match on stroke
            // value still work). Cleared when the category master is off so
            // the host's native color returns.
            if (isSolidGreen) {
                if (toggleState['ffz.show']) {
                    line.style.stroke = toggleState['ffz.line-color'] || '';
                    const op = Number(toggleState['ffz.line-opacity']);
                    line.style.strokeOpacity = isNaN(op) ? '' : String(op);
                } else {
                    line.style.stroke = '';
                    line.style.strokeOpacity = '';
                }
            } else if (isWhiteAsset) {
                if (toggleState['asset.show']) {
                    line.style.stroke = toggleState['asset.line-color'] || '';
                    const op = Number(toggleState['asset.line-opacity']);
                    line.style.strokeOpacity = isNaN(op) ? '' : String(op);
                } else {
                    line.style.stroke = '';
                    line.style.strokeOpacity = '';
                }
            } else if (isBlueFlight) {
                if (toggleState['fp.show']) {
                    line.style.stroke = toggleState['fp.line-color'] || '';
                    const op = Number(toggleState['fp.line-opacity']);
                    line.style.strokeOpacity = isNaN(op) ? '' : String(op);
                } else {
                    line.style.stroke = '';
                    line.style.strokeOpacity = '';
                }
            }

            if (!want40 && !want65 && !wantShield && !wantForce && !wantAssetFillOverride) return;

            let currentAttrWidth = line.getAttribute('stroke-width');
            let originalWidth = parseFloat(line.getAttribute('data-original-width'));
            if (isNaN(originalWidth)) {
                originalWidth = parseFloat(currentAttrWidth) || 3;
                line.setAttribute('data-original-width', originalWidth);
            }

            // --- Force line thickness (per-category) ---
            if (wantForce) {
                if (currentAttrWidth !== String(lineThickness)) {
                    line.setAttribute('stroke-width', lineThickness);
                }
            } else if ((isBlueFlight || isSolidGreen || isWhiteAsset) && originalWidth !== lineThickness) {
                // Revert anything we previously forced.
                if (currentAttrWidth === String(lineThickness)) {
                    line.setAttribute('stroke-width', String(originalWidth));
                }
            }

            // --- Asset fill override ---
            // Only acts when asset.show is on. If the category master is off,
            // we leave the host app's default fill alone (restore empty style).
            // When asset.fill is on, applies user-chosen fill color + opacity.
            if (isWhiteAsset) {
                if (toggleState['asset.show']) {
                    if (toggleState['asset.fill'] === false) {
                        line.style.fillOpacity = '0';
                        line.style.fill = '';
                    } else {
                        line.style.fill = toggleState['asset.fill-color'] || '';
                        const fo = Number(toggleState['asset.fill-opacity']);
                        line.style.fillOpacity = isNaN(fo) ? '' : String(fo);
                    }
                } else {
                    line.style.fillOpacity = '';
                    line.style.fill = '';
                }
            }

            // --- Compute buffer attrs for this line type ---
            // Computed even when want40 is false, because 65ft and shielding
            // derive their widths from finalBufferWidth (where applicable).
            // ft → SVG user units: 1ft ≈ baseWidth/31.5 (empirically measured).
            // Buffer extends distance ft on each side of the line, so total
            // band width = 2 × distance × baseWidth / 31.5.
            const baseW = globalBaseWidth || (lineThickness * standardRatio);
            const ftToUnits = (ft) => 2 * ft * baseW / 31.5;
            let bufferStroke = null;
            let bufferOpacity;
            let finalBufferWidth;
            const readOpacity = (key, fallback) => {
                const v = Number(toggleState[key]);
                return String(isNaN(v) ? fallback : v);
            };
            if (isEditMode) {
                // Edit-mode buffers inherit colors from the per-category settings
                // — asset-class edit lines use asset.color, others use ffz.color.
                if (line.classList.contains('asset')) {
                    bufferStroke = toggleState['asset.color'] || '#ffffff';
                    bufferOpacity = readOpacity('asset.opacity', 0.4);
                    finalBufferWidth = ftToUnits(Number(toggleState['asset.distance']) || 15);
                } else {
                    bufferStroke = toggleState['ffz.color'] || '#5fff5f';
                    bufferOpacity = readOpacity('ffz.opacity', 0.4);
                    finalBufferWidth = ftToUnits(Number(toggleState['ffz.distance']) || 15);
                }
            } else if (isBlueFlight) {
                bufferStroke = toggleState['fp.color'] || '#1ca0de';
                bufferOpacity = readOpacity('fp.opacity', 0.5);
                finalBufferWidth = ftToUnits(Number(toggleState['fp.distance']) || 40);
            } else if (isWhiteAsset) {
                bufferStroke = toggleState['asset.color'] || '#ffffff';
                bufferOpacity = readOpacity('asset.opacity', 0.4);
                finalBufferWidth = ftToUnits(Number(toggleState['asset.distance']) || 15);
            } else {
                // solid green (FFZ)
                bufferStroke = toggleState['ffz.color'] || '#5fff5f';
                bufferOpacity = readOpacity('ffz.opacity', 0.4);
                finalBufferWidth = ftToUnits(Number(toggleState['ffz.distance']) || 15);
            }

            // --- 40ft buffer (standard) ---
            if (want40) {
                const buffer = line.cloneNode(true);
                buffer.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
                buffer.style.pointerEvents = 'none';
                buffer.setAttribute('fill', 'none');
                buffer.removeAttribute('stroke-dasharray');
                buffer.removeAttribute('data-original-width');
                buffer.removeAttribute('aria-describedby');
                // Clear inline stroke/opacity inherited from the line — we set
                // those via inline style for our line-color overrides, and
                // inline style would otherwise win over our setAttribute calls.
                buffer.style.stroke = '';
                buffer.style.strokeOpacity = '';
                if (bufferStroke) buffer.setAttribute('stroke', bufferStroke);
                buffer.setAttribute('stroke-opacity', bufferOpacity);
                buffer.setAttribute('stroke-width', String(finalBufferWidth));
                if (line.parentNode) line.parentNode.insertBefore(buffer, line.parentNode.firstChild);
            }

            // --- 65ft outer band (flight paths) ---
            // Inherits FP color, rendered fainter than the 40ft inner band so
            // visually you see darker inner + lighter outer. Distance is its
            // own configurable knob (fp.65ft-distance).
            if (want65) {
                const band65 = line.cloneNode(true);
                band65.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
                band65.setAttribute('data-buffer-kind', 'flight-65ft');
                band65.style.pointerEvents = 'none';
                band65.setAttribute('fill', 'none');
                band65.removeAttribute('stroke-dasharray');
                band65.removeAttribute('data-original-width');
                band65.removeAttribute('aria-describedby');
                // Clear inherited inline stroke styles (see 40ft block).
                band65.style.stroke = '';
                band65.style.strokeOpacity = '';
                // 65ft band has its own color + opacity controls; fall back to
                // fp.color / fp.opacity*0.45 (the old shared behavior) if the
                // user hasn't customized the 65ft-specific values.
                const band65Color = toggleState['fp.65ft-color'] || toggleState['fp.color'] || '#1ca0de';
                band65.setAttribute('stroke', band65Color);
                const band65OpRaw = Number(toggleState['fp.65ft-opacity']);
                let band65Op;
                if (!isNaN(band65OpRaw)) {
                    band65Op = band65OpRaw;
                } else {
                    const fpOp = Number(toggleState['fp.opacity']);
                    const baseOp = isNaN(fpOp) ? 0.5 : fpOp;
                    band65Op = baseOp * 0.45;
                }
                band65.setAttribute('stroke-opacity', String(band65Op));
                band65.setAttribute('stroke-width', String(ftToUnits(Number(toggleState['fp.65ft-distance']) || 65)));
                if (line.parentNode) line.parentNode.insertBefore(band65, line.parentNode.firstChild);
            }

            // --- Shielding buffer (200ft, orange) ---
            // A wide, very-transparent orange band at the 200ft boundary.
            // Sized as standard_buffer × (200/standard_distance) × user_ratio,
            // so it scales with zoom the same way as the 40/65 bands.
            if (wantShield) {
                const shielding = line.cloneNode(true);
                shielding.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
                shielding.setAttribute('data-buffer-kind', 'shielding');
                shielding.style.pointerEvents = 'none';
                shielding.setAttribute('fill', 'none');
                shielding.removeAttribute('stroke-dasharray');
                shielding.removeAttribute('data-original-width');
                // Clear inherited inline stroke styles (see 40ft block).
                shielding.style.stroke = '';
                shielding.style.strokeOpacity = '';
                shielding.removeAttribute('aria-describedby');
                shielding.setAttribute('stroke', toggleState['shielding.color'] || '#ff8c00');
                const shOp = Number(toggleState['shielding.opacity']);
                shielding.setAttribute('stroke-opacity', String(isNaN(shOp) ? 0.15 : shOp));
                // FFZ shielding is computed from baseWidth so it stays at
                // ~200ft regardless of the user's FFZ buffer distance setting.
                // Other categories still derive from finalBufferWidth (their
                // standard is a known constant — 40ft for flight paths, 15ft
                // for everything else).
                let shieldingWidth;
                if (isSolidGreen) {
                    const baseW = globalBaseWidth || (lineThickness * standardRatio);
                    shieldingWidth = 2 * 200 * baseW / 31.5 * shieldingMult;
                } else {
                    const distMultiplier = isBlueFlight ? 5 : 13.3;
                    shieldingWidth = finalBufferWidth * distMultiplier * shieldingMult;
                }
                shielding.setAttribute('stroke-width', String(shieldingWidth));
                if (line.parentNode) line.parentNode.insertBefore(shielding, line.parentNode.firstChild);
            }
        });

        // 5. Altitude-marker purple shield circles.
        renderAltitudeShields(globalBaseWidth, lineThickness, standardRatio);
        // 6. KML shielding overlays (loaded async — render whatever's currently in kmlFeatures).
        renderShielding();
        // 7. Violation dots — assets within Xft of FFZ/FP.
        renderViolations(globalBaseWidth, lineThickness, standardRatio);
        // 8. Coverage Validator pins (re-projected from stored lat/lng).
        renderValidatorPins();
        // 9. Round altitude + make values copyable in altitude popups.
        enhanceAltitudePopups();
        // 10. Toggle satellite base tiles on/off per user preference.
        applyMapBackgroundVisibility();
        // 11. Orthomosaic brightness + low-res cap (perf optimization).
        applyOrthoSettings();
        // 12. Flight-path vertex dots: hide / resize / recolor via CSS.
        applyVertexStyle();

        // Mark current state as rendered. Heartbeat compares against this
        // and skips re-running if nothing changed since.
        lastUpdateHash = computeUpdateHash();
    }

    // Hides/restores the Leaflet satellite base tile layer. Driven by the
    // AIM Performance Shield's "Hide satellite base tiles" toggle, which
    // broadcasts PERF_TOGGLE messages on the AIM_CONTROL_CHANNEL. The
    // implementation lives here (not in Perf Shield) because we already
    // have a robust Leaflet map reference via getLeafletMap().
    //
    // Heuristic for "is this a satellite layer": tile URLs commonly contain
    // identifiable strings (esri, arcgis, world_imagery, mapbox.satellite,
    // bing, virtualearth, google satellite, generic /satellite|aerial|imagery).
    // Orthomosaics are typically served from the host app's own CDN with
    // site/user identifiers in the URL — they should NOT match these patterns.
    //
    // We use `_container.style.display = 'none'` (not setOpacity(0)) so the
    // browser skips the tile-image paint entirely. Cache _aimHidden on the
    // layer so we know to restore. Errors are swallowed — if Leaflet internals
    // change, we fail open (no hide, visible satellite).
    let perfHideSatellite = false; // mirrors AIM Perf Shield toggle state
    const _SAT_URL_PATTERNS = [
        /esri/i, /arcgis/i, /world_?imagery/i,
        /mapbox.*satellite/i, /tiles?\.virtualearth/i,
        /google.*satellite/i, /bing/i,
        /\/satellite\//i, /\/aerial\//i, /\/imagery\//i,
        /maptiler.*satellite/i,
        // HERE Maps — Percepto's actual base map. Template URLs contain
        // `{type}` literally, so /satellite/i above doesn't match. Targeting
        // the API host catches both the imagery layer and the labels overlay
        // (Percepto loads both as separate tile layers).
        /maps\.hereapi\.com/i,
    ];
    // Tracks URLs we've already logged so the per-runUpdate sweep doesn't
    // spam the console with the same diagnostic line every tick.
    const _seenTileLayerUrls = new Set();
    function applyMapBackgroundVisibility() {
        const hide = perfHideSatellite === true;
        const map = getLeafletMap();
        if (!map || typeof map.eachLayer !== 'function') return;
        try {
            let matchedAny = false;
            map.eachLayer(layer => {
                if (!layer || !layer._url || typeof layer._url !== 'string') return;
                const url = layer._url;
                // Diagnostic: print every unique tile layer URL once. Helps
                // identify Percepto's actual satellite provider when our
                // built-in patterns don't match. Always logs (not just when
                // hide is on) so user can see candidates in the console.
                if (!_seenTileLayerUrls.has(url)) {
                    _seenTileLayerUrls.add(url);
                    console.log(`${TAG} tile layer present: ${url}`);
                }
                const isSatellite = _SAT_URL_PATTERNS.some(p => p.test(url));
                if (!isSatellite) return;
                matchedAny = true;
                const container = layer._container;
                if (!container) return;
                if (hide) {
                    if (!layer._aimHidden) {
                        layer._aimHidden = true;
                        layer._aimOrigDisplay = container.style.display;
                        container.style.display = 'none';
                        console.log(`${TAG} hiding satellite base: ${url}`);
                    }
                } else if (layer._aimHidden) {
                    container.style.display = layer._aimOrigDisplay || '';
                    layer._aimHidden = false;
                }
            });
            // Diagnostic: warn ONCE per session if hide is on, we've seen
            // at least one tile layer, but none matched our satellite
            // patterns. Flags the case where the provider URL isn't in
            // _SAT_URL_PATTERNS. The seenTileLayers guard avoids a false
            // alarm when applyMapBackgroundVisibility runs BEFORE Leaflet
            // has added the host's tile layers (we're just too early — not
            // a pattern miss).
            if (hide && !matchedAny && _seenTileLayerUrls.size > 0 && !applyMapBackgroundVisibility._warnedNoMatch) {
                applyMapBackgroundVisibility._warnedNoMatch = true;
                console.warn(`${TAG} hide-satellite is ON but no tile layer matched satellite URL patterns. See "tile layer present:" lines above and share the satellite URL so we can add the pattern.`);
            }
        } catch (e) {
            console.warn(`${TAG} applyMapBackgroundVisibility failed:`, e);
        }
    }

    // Restore satellite visibility on any layer we hid. Called from cleanup()
    // when the styler deactivates so the user doesn't see a blank map after
    // turning the master off.
    function restoreMapBackground() {
        const map = getLeafletMap();
        if (!map || typeof map.eachLayer !== 'function') return;
        try {
            map.eachLayer(layer => {
                if (layer && layer._aimHidden && layer._container) {
                    layer._container.style.display = layer._aimOrigDisplay || '';
                    layer._aimHidden = false;
                }
            });
        } catch (e) {}
    }

    // Orthomosaic customizations: brightness filter + low-res tile cap.
    // Identifies ortho TileLayers by URL pattern (Percepto's COG-backed
    // tiles use `user_tile_<siteID>_…` identifiers + cloudfront `/cog/tiles/`
    // paths). Apply runs from runUpdate so toggle changes settle within one
    // heartbeat cycle.
    //
    // Brightness: CSS `filter: brightness(X)` on the layer's `_container`.
    // GPU-accelerated, near-zero runtime cost.
    //
    // Low-res cap: set `layer.options.maxNativeZoom = N`. Leaflet then caps
    // tile fetches at zoom N and auto-upsamples (blurrier but ~10× fewer
    // tile requests at deep zoom). `layer.redraw()` flushes existing tiles.
    // Original `maxNativeZoom` is cached on the layer as `_aimOrigMaxNativeZoom`
    // so we can restore.
    const _ORTHO_URL_PATTERNS = [
        /user_tile_\d+/i,           // Percepto site-ortho identifier
        /cog\/tiles\/.*\.tif/i,     // generic COG tile-server URL with .tif source
    ];
    const _seenOrthoUrls = new Set();
    function applyOrthoSettings() {
        const masterOn = toggleState['ortho.show'] !== false;
        if (!masterOn) { restoreOrthoSettings(); return; }
        const brightness = Number(toggleState['ortho.brightness']);
        const lowRes = toggleState['ortho.low-res'] === true;
        const maxZoom = Number(toggleState['ortho.max-zoom']) || 15;
        const map = getLeafletMap();
        if (!map || typeof map.eachLayer !== 'function') return;
        try {
            map.eachLayer(layer => {
                if (!layer || !layer._url || typeof layer._url !== 'string') return;
                const url = layer._url;
                if (!_ORTHO_URL_PATTERNS.some(p => p.test(url))) return;
                if (!_seenOrthoUrls.has(url)) {
                    _seenOrthoUrls.add(url);
                    console.log(`${TAG} ortho layer detected: ${url.substring(0, 120)}…`);
                }
                // Brightness
                const container = layer._container;
                if (container) {
                    const desiredFilter = (!isNaN(brightness) && brightness !== 1.0) ? `brightness(${brightness})` : '';
                    if (container.style.filter !== desiredFilter) {
                        container.style.filter = desiredFilter;
                    }
                }
                // Low-res cap
                if (layer.options && layer.options) {
                    if (layer._aimOrigMaxNativeZoom === undefined) {
                        layer._aimOrigMaxNativeZoom = layer.options.maxNativeZoom !== undefined
                            ? layer.options.maxNativeZoom
                            : null;
                    }
                    const desiredMaxZoom = lowRes ? maxZoom : layer._aimOrigMaxNativeZoom;
                    const current = layer.options.maxNativeZoom !== undefined ? layer.options.maxNativeZoom : null;
                    if (desiredMaxZoom !== current) {
                        if (desiredMaxZoom === null) {
                            delete layer.options.maxNativeZoom;
                        } else {
                            layer.options.maxNativeZoom = desiredMaxZoom;
                        }
                        try { if (typeof layer.redraw === 'function') layer.redraw(); } catch (e) {}
                        console.log(`${TAG} ortho maxNativeZoom: ${desiredMaxZoom === null ? 'native' : desiredMaxZoom}`);
                    }
                }
            });
        } catch (e) {
            console.warn(`${TAG} applyOrthoSettings failed:`, e);
        }
    }

    function restoreOrthoSettings() {
        const map = getLeafletMap();
        if (!map || typeof map.eachLayer !== 'function') return;
        try {
            map.eachLayer(layer => {
                if (!layer || !layer._url || !_ORTHO_URL_PATTERNS.some(p => p.test(layer._url))) return;
                if (layer._container) layer._container.style.filter = '';
                if (layer._aimOrigMaxNativeZoom !== undefined) {
                    if (layer._aimOrigMaxNativeZoom === null) {
                        delete layer.options.maxNativeZoom;
                    } else {
                        layer.options.maxNativeZoom = layer._aimOrigMaxNativeZoom;
                    }
                    try { if (typeof layer.redraw === 'function') layer.redraw(); } catch (e) {}
                    delete layer._aimOrigMaxNativeZoom;
                }
            });
        } catch (e) {}
    }

    // Flight-path vertex dot styling. Percepto renders FP vertices as
    // `<div class="map-marker__flight-path-vertex …">` icons in
    // .leaflet-marker-pane with inline width/height/margin styles. Our
    // injected stylesheet wins via !important and persists across
    // Percepto's re-renders (CSS rules don't need re-application like
    // inline styles do). One style tag per page; content updated as the
    // user changes the FP vertex toggles.
    const FP_VERTEX_STYLE_ID = 'aim-fp-vertex-style';
    function applyVertexStyle() {
        let el = document.getElementById(FP_VERTEX_STYLE_ID);
        if (!el) {
            el = document.createElement('style');
            el.id = FP_VERTEX_STYLE_ID;
            (document.head || document.documentElement).appendChild(el);
        }
        const masterOn = toggleState['fp.show'] !== false;
        if (!masterOn) { el.textContent = ''; return; }

        // Auto-detect edit mode: Percepto signals it via black-dashed lines
        // on the canvas (FFZ or FP). If ANY edit-mode line exists, vertices
        // become visible automatically so the user can grab them. computeUpdateHash
        // already includes editN, so toggling in/out of edit mode triggers a
        // runUpdate → applyVertexStyle re-evaluation within ~50ms.
        const inEditMode = document.querySelector(EDIT_MODE_SELECTOR) !== null;
        const alwaysShow = toggleState['fp.show-vertices'] === true;
        const show = alwaysShow || inEditMode;

        const color = toggleState['fp.vertex-color'] || '#1ca0de';
        const sizeRaw = Number(toggleState['fp.vertex-size']);
        const size = isNaN(sizeRaw) ? 10 : sizeRaw;
        const margin = size / 2;

        if (show) {
            // Render all vertex dots at the user's color + size.
            el.textContent = `
                .map-marker__flight-path-vertex {
                    width: ${size}px !important;
                    height: ${size}px !important;
                    margin-left: -${margin}px !important;
                    margin-top: -${margin}px !important;
                    background-color: ${color} !important;
                }
            `;
        } else {
            // Hide all vertex dots EXCEPT disconnected/error variants
            // (Percepto signals those with modifier classes containing
            // "disconnect", "error", "invalid", or "warning"). Specificity
            // bumped to .class.class to beat Percepto's CSS — single-class
            // selectors were getting overridden by their own rules.
            el.textContent = `
                .map-marker__flight-path-vertex.map-marker__flight-path-vertex {
                    display: none !important;
                }
                .map-marker__flight-path-vertex[class*="disconnect" i],
                .map-marker__flight-path-vertex[class*="error" i],
                .map-marker__flight-path-vertex[class*="invalid" i],
                .map-marker__flight-path-vertex[class*="warning" i] {
                    display: block !important;
                }
            `;
        }
    }

    // Cheap fingerprint of inputs that affect what runUpdate draws.
    // Sub-millisecond on typical sites (a few querySelectorAll calls +
    // small JSON.stringify). Heartbeat uses this to skip the ~50–150ms
    // wipe+rebuild cycle when nothing has changed. Mutation-triggered
    // (debounced) updates bypass the check — if the observer fired,
    // something probably changed even if our hash doesn't capture it.
    function computeUpdateHash() {
        if (!isActive) return null;
        try {
            const ffzN  = document.querySelectorAll(SOLID_GREEN_SELECTOR).length;
            const asN   = document.querySelectorAll(WHITE_ASSET_SELECTOR).length;
            const fpN   = document.querySelectorAll(BLUE_FLIGHT_PATH_SELECTOR).length;
            const editN = document.querySelectorAll(EDIT_MODE_SELECTOR).length;
            const sid   = getCurrentSiteID() || '';
            const distroN = (kmlFeatures[kmlKey(sid, 'distro')] || []).length;
            const transN  = (kmlFeatures[kmlKey(sid, 'trans')]  || []).length;
            const valN    = validatorState.results.length;
            const dismN   = validatorState.results.filter(r => r.dismissed).length;
            const map = getLeafletMap();
            const zoom = map && typeof map.getZoom === 'function' ? map.getZoom() : 0;
            // Count OUR rendered overlays. If Percepto's React wiped them
            // between heartbeats but native element counts didn't change,
            // the hash would otherwise match and we'd skip the rebuild,
            // leaving KML/buffers/shielding invisible until something else
            // moved. Including our own count forces a rebuild on every wipe.
            // (Cheap: one querySelectorAll on an indexed attribute.)
            const ourN = document.querySelectorAll(`[${CUSTOM_BUFFER_ATTR}="true"]`).length;
            // toggleState is small (~50 keys × ~30 chars) so JSON.stringify
            // costs ~0.5ms — still vastly cheaper than rebuilding overlays.
            const tHash = JSON.stringify(toggleState);
            return `${ffzN}|${asN}|${fpN}|${editN}|${distroN}|${transN}|${valN}|${dismN}|${ourN}|${zoom}|${tHash}`;
        } catch (e) {
            return null; // any error → force run (safe default)
        }
    }

    // ============================================================
    // KML / SHIELDING — fetch, parse, render
    // ============================================================

    function getCurrentSiteID() {
        const m = (location.hash || '').match(SITE_ID_RE);
        return m ? m[1] : null;
    }

    // GM storage helpers. Returns def if GM is unavailable (script grants
    // may not have been re-confirmed by the user after an update).
    function gmGet(key, def) {
        try { if (typeof GM_getValue === 'function') return GM_getValue(key, def); } catch (e) {}
        return def;
    }
    function gmSet(key, value) {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch (e) {}
    }

    // Reaches into page context (via unsafeWindow) and patches L.Map.initialize
    // so every map created from this point on registers itself onto its
    // container. Idempotent. Once patched, getLeafletMap() can read the map
    // off the .leaflet-container DOM element.
    //
    // If a map already exists when we patch, we won't capture it via this
    // hook — getLeafletMap() also tries a couple of fallback access patterns
    // for that case.
    function patchLeafletMap() {
        if (leafletPatched) return true;
        let L;
        try { L = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).L; } catch (e) { return false; }
        if (!L || !L.Map || !L.Map.prototype) return false;
        try {
            const orig = L.Map.prototype.initialize;
            L.Map.prototype.initialize = function(...args) {
                const r = orig.apply(this, args);
                try { if (this._container) this._container.__aim_map__ = this; } catch (e) {}
                return r;
            };
            leafletPatched = true;
            console.log(`${TAG} patched L.Map.initialize`);
            return true;
        } catch (e) {
            console.warn(`${TAG} L.Map patch failed:`, e);
            return false;
        }
    }

    // Returns the Leaflet map instance or null. Tries (in order):
    //   1. Cached ref (validated still in DOM)
    //   2. Container .__aim_map__ from our prototype patch
    //   3. Container _leaflet_map (set by some Leaflet wrappers)
    //   4. Walks own properties of the container for one with the FULL map API
    //   5. Walks ALL .leaflet-container nodes (covers iframe / multi-map cases)
    //
    // The walk requires multiple methods to avoid latching onto a stripped
    // Leaflet helper that has e.g. latLngToLayerPoint but not distance().
    function looksLikeLeafletMap(v) {
        return v && typeof v === 'object'
            && typeof v.latLngToLayerPoint === 'function'
            && typeof v.latLngToContainerPoint === 'function'
            && typeof v.layerPointToLatLng === 'function'
            && typeof v.distance === 'function'
            && typeof v.getContainer === 'function';
    }

    function getLeafletMap() {
        if (leafletMapRef && leafletMapRef._container && document.body.contains(leafletMapRef._container)) {
            return leafletMapRef;
        }
        leafletMapRef = null;
        const containers = document.querySelectorAll('.leaflet-container');
        for (const container of containers) {
            const candidates = [container.__aim_map__, container._leaflet_map, container._leaflet];
            for (const c of candidates) {
                if (looksLikeLeafletMap(c)) { leafletMapRef = c; return c; }
            }
            for (const k in container) {
                try {
                    const v = container[k];
                    if (looksLikeLeafletMap(v)) {
                        console.log(`${TAG} captured Leaflet map via container.${k}`);
                        leafletMapRef = v; return v;
                    }
                } catch (e) {}
            }
        }
        return null;
    }

    // Fetches the KML for the current site (or a passed-in siteID) using
    // GM_xmlhttpRequest with the user's PAT. Result is parsed and stored
    // in kmlFeatures[siteID]; if successful, schedules a runUpdate so the
    // new shielding renders without waiting for the next mutation.
    //
    // Caching: parsed features are persisted via GM storage so subsequent
    // page loads start from cache. The network fetch still runs in the
    // background and refreshes the cache on success.
    // Fetches BOTH distro and trans KMLs for a site (parallel requests).
    // No-op for any type already loaded, in flight, or known-missing — unless
    // `force` is true (used after a token change or manual refresh).
    function fetchKMLForSite(siteID, force) {
        if (!siteID) return;
        KML_TYPES.forEach(type => fetchOneKML(siteID, type, force));
    }

    function fetchOneKML(siteID, type, force) {
        const key = kmlKey(siteID, type);
        if (kmlFetching.has(key)) return;
        if (kmlMissing.has(key) && !force) return;
        if (kmlFeatures[key] && !force) return;

        // Try cache first so we render immediately while the network fetch runs.
        if (!kmlFeatures[key]) {
            const cached = gmGet(KML_CACHE_PREFIX + key, null);
            if (cached && Array.isArray(cached.features)) {
                kmlFeatures[key] = cached.features;
                console.log(`${TAG} KML ${key} loaded from cache (${cached.features.length} features)`);
            }
        }

        // In-memory cache from TOKEN_VALUE broadcast, falling back to our own
        // GM storage (per-script — only useful if we wrote it ourselves).
        const token = cachedToken || gmGet(TOKEN_KEY, '');
        if (!token) {
            // Warn + request token only ONCE per token-lost period. The panel
            // echoes SET_TOGGLE messages for every toggle on REGISTER, each
            // of which triggers a render → fetch attempt → would-be-warning,
            // so this used to spam ~14 lines + 14 REQUEST_TOKEN messages
            // every panel registration.
            if (!warnedNoToken) {
                warnedNoToken = true;
                console.warn(`${TAG} no GitHub token cached yet — waiting for TOKEN_VALUE from control panel (will auto-retry when it arrives)`);
                if (controlChannel) controlChannel.postMessage({ type: 'REQUEST_TOKEN' });
            }
            return;
        }
        warnedNoToken = false; // reset for next token-lost period
        if (typeof GM_xmlhttpRequest !== 'function') {
            console.warn(`${TAG} GM_xmlhttpRequest unavailable — script grants may need re-approval after update`);
            return;
        }

        kmlFetching.add(key);
        const url = `https://raw.githubusercontent.com/${KMLS_REPO}/${KMLS_BRANCH}/${siteID}-${type}.kml`;
        console.log(`${TAG} fetching ${type} KML for site ${siteID}`);
        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 15000,
                onload: (resp) => {
                    kmlFetching.delete(key);
                    if (resp.status === 200) {
                        try {
                            const features = parseKML(resp.responseText);
                            kmlFeatures[key] = features;
                            gmSet(KML_CACHE_PREFIX + key, { features, at: Date.now() });
                            console.log(`${TAG} ${type} KML for site ${siteID} loaded (${features.length} features)`);
                            if (isActive) runUpdate();
                        } catch (e) {
                            console.error(`${TAG} KML parse failed for ${key}:`, e);
                        }
                    } else if (resp.status === 404) {
                        kmlMissing.add(key);
                        console.log(`${TAG} no ${type} KML for site ${siteID} (404) — that type has no shielding configured here`);
                    } else if (resp.status === 401) {
                        console.warn(`${TAG} ${type} KML fetch unauthorized (401) — check your PAT in AIM Controls`);
                    } else {
                        console.warn(`${TAG} ${type} KML fetch HTTP ${resp.status}`);
                    }
                },
                onerror: () => {
                    kmlFetching.delete(key);
                    console.warn(`${TAG} ${type} KML fetch network error`);
                },
                ontimeout: () => {
                    kmlFetching.delete(key);
                    console.warn(`${TAG} ${type} KML fetch timed out`);
                },
            });
        } catch (e) {
            kmlFetching.delete(key);
            console.error(`${TAG} ${type} KML fetch threw:`, e);
        }
    }

    // KML parser. Walks every <Placemark> and extracts either a LineString
    // or a Polygon (outerBoundaryIs/LinearRing). Coordinates are KML-format
    // "lng,lat[,alt] lng,lat[,alt] …" — note lng comes first.
    // Returns: [{ type: 'line'|'polygon', coords: [{lat, lng}, ...] }, ...]
    function parseKML(xmlText) {
        const out = [];
        const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.querySelector('parsererror')) {
            throw new Error('KML XML parse error');
        }
        const parseCoords = (text) => {
            const pts = [];
            if (!text) return pts;
            text.trim().split(/\s+/).forEach(triplet => {
                const parts = triplet.split(',');
                if (parts.length < 2) return;
                const lng = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                if (isFinite(lat) && isFinite(lng)) pts.push({ lat, lng });
            });
            return pts;
        };
        // LineStrings (any depth — handles MultiGeometry too)
        doc.querySelectorAll('LineString > coordinates').forEach(c => {
            const coords = parseCoords(c.textContent);
            if (coords.length >= 2) out.push({ type: 'line', coords });
        });
        // Polygons — outer boundary only (we don't render holes for shielding)
        doc.querySelectorAll('Polygon > outerBoundaryIs > LinearRing > coordinates').forEach(c => {
            const coords = parseCoords(c.textContent);
            if (coords.length >= 3) out.push({ type: 'polygon', coords });
        });
        return out;
    }

    // Converts the current site's KML features into SVG-user-space point
    // arrays using the Leaflet map's projection. Returns [] if the map
    // isn't available yet (the next runUpdate will retry).
    // Cached per-tick by callers if they need it twice.
    function shieldingFeaturePointsInSVG(type) {
        const siteID = getCurrentSiteID();
        if (!siteID) return [];
        const features = kmlFeatures[kmlKey(siteID, type)];
        if (!features || !features.length) return [];
        const map = getLeafletMap();
        if (!map || typeof map.latLngToContainerPoint !== 'function') return [];
        const container = map.getContainer ? map.getContainer() : document.querySelector('.leaflet-container');
        if (!container) return [];
        const svg = document.querySelector('.leaflet-overlay-pane svg');
        if (!svg) return [];
        let ctm;
        try { ctm = svg.getScreenCTM(); } catch (e) { return []; }
        if (!ctm) return [];
        const inv = ctm.inverse();
        const cRect = container.getBoundingClientRect();
        const out = [];
        features.forEach(f => {
            const pts = [];
            for (let i = 0; i < f.coords.length; i++) {
                const c = f.coords[i];
                // latLngToContainerPoint = pixel offset from the map container's
                // top-left, accounting for all current pan/zoom. Add container's
                // screen position, then invert SVG CTM to land in SVG user space.
                let cp;
                try { cp = map.latLngToContainerPoint([c.lat, c.lng]); } catch (e) { continue; }
                if (!cp) continue;
                const svgPt = svg.createSVGPoint();
                svgPt.x = cRect.left + cp.x;
                svgPt.y = cRect.top + cp.y;
                const p = svgPt.matrixTransform(inv);
                pts.push({ x: p.x, y: p.y });
            }
            if (pts.length >= 2) out.push({ type: f.type, points: pts });
        });
        return out;
    }

    function renderShielding() {
        const siteID = getCurrentSiteID();
        if (!siteID) return;
        // Lazy-fetch if any type isn't loaded yet.
        const needsFetch = KML_TYPES.some(t => {
            const k = kmlKey(siteID, t);
            return !kmlFeatures[k] && !kmlFetching.has(k) && !kmlMissing.has(k);
        });
        if (needsFetch) fetchKMLForSite(siteID);
        const svg = document.querySelector('.leaflet-overlay-pane svg');
        if (!svg) return;
        const g = svg.querySelector('g');
        if (!g) return;
        // Render distro first then trans, so trans paints on top — matches
        // its higher-priority/more-dangerous status.
        KML_TYPES.forEach(type => renderShieldingType(type, g));
    }

    function renderShieldingType(type, g) {
        if (!toggleState[`${type}.show`] || !toggleState[`${type}.outline`]) return;
        const feats = shieldingFeaturePointsInSVG(type);
        if (!feats.length) return;
        const defaults = type === 'trans'
            ? { color: '#ff3030', opacity: 0.9, thickness: 4 }
            : { color: '#ffd700', opacity: 0.9, thickness: 3 };
        const stroke = toggleState[`${type}.color`] || defaults.color;
        const opacity = Number(toggleState[`${type}.opacity`]);
        const opStr = String(isNaN(opacity) ? defaults.opacity : opacity);
        const thickness = Number(toggleState[`${type}.thickness`]) || defaults.thickness;
        feats.forEach(f => {
            const d = pointsToPathD(f.points, f.type === 'polygon');
            if (!d) return;
            const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            p.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
            p.setAttribute('data-buffer-kind', `kml-${type}`);
            p.setAttribute('d', d);
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', stroke);
            p.setAttribute('stroke-opacity', opStr);
            p.setAttribute('stroke-width', String(thickness));
            p.setAttribute('stroke-linejoin', 'round');
            p.setAttribute('stroke-linecap', 'round');
            p.setAttribute('pointer-events', 'none');
            // Insert at the start of the group so shielding renders UNDER
            // the FFZ/FP/asset outlines.
            if (g.firstChild) g.insertBefore(p, g.firstChild);
            else g.appendChild(p);
        });
    }

    function pointsToPathD(pts, closed) {
        if (!pts || !pts.length) return '';
        let d = `M ${pts[0].x} ${pts[0].y}`;
        for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
        if (closed) d += ' Z';
        return d;
    }

    // Squared distance from point (px,py) to line segment (ax,ay)→(bx,by).
    // Squared because we compare against a squared threshold — saves a sqrt
    // per call, and the inner validator loop runs millions of times on big
    // missions. Standard "project onto segment, clamp to endpoints" formula.
    function pointToSegmentDist2(px, py, ax, ay, bx, by) {
        const abx = bx - ax, aby = by - ay;
        const abLen2 = abx * abx + aby * aby;
        if (abLen2 === 0) {
            const dx = px - ax, dy = py - ay;
            return dx * dx + dy * dy;
        }
        let t = ((px - ax) * abx + (py - ay) * aby) / abLen2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const cx = ax + t * abx, cy = ay + t * aby;
        const dx = px - cx, dy = py - cy;
        return dx * dx + dy * dy;
    }

    // ============================================================
    // COVERAGE VALIDATOR — on-demand check that every flight path
    // segment and FFZ perimeter point has shielding (distro OR trans
    // KML) within the FAA-required distance (default 200ft).
    //
    // Algorithm:
    //   1. Walk every FFZ outline + FP main line, sampling along each
    //   2. For each sample, find min distance (haversine, via Leaflet
    //      map.distance) to ANY shielding point
    //   3. Group contiguous failing samples into "gaps"
    //   4. Drop a numbered red pin at the midpoint of each gap
    //
    // Results are stored as lat/lng so they persist across zoom/pan
    // and the regular wipe & rebuild cycle (renderValidatorPins is
    // called on every runUpdate tick and re-projects).
    // ============================================================
    function runCoverageValidator() {
        const map = getLeafletMap();
        if (!map) {
            // Diagnose: did the prototype patch run? Are there .leaflet-container
            // nodes at all? This message is the next thing we follow when it fires.
            const containers = document.querySelectorAll('.leaflet-container');
            console.warn(`${TAG} validator: Leaflet map not accessible (patched=${leafletPatched}, .leaflet-container count=${containers.length})`);
            validatorState.lastRun = { error: 'Leaflet map not accessible — see console for diagnostics', at: Date.now() };
            return;
        }
        const siteID = getCurrentSiteID();
        if (!siteID) {
            validatorState.lastRun = { error: 'No site ID in URL', at: Date.now() };
            return;
        }

        // Build shielding as LINE SEGMENTS in layer-point space (not just
        // vertices). v32.2 measured distance vertex-to-vertex which falsely
        // flagged spots that are right next to a power line but far from
        // either endpoint of the line — e.g. anywhere along the middle of
        // a 1000ft segment that's drawn as just two endpoints in the KML.
        const segments = []; // [{ ax, ay, bx, by }] — layer-point coords
        KML_TYPES.forEach(t => {
            const feats = kmlFeatures[kmlKey(siteID, t)] || [];
            feats.forEach(f => {
                const lps = [];
                for (let i = 0; i < f.coords.length; i++) {
                    try { lps.push(map.latLngToLayerPoint([f.coords[i].lat, f.coords[i].lng])); } catch (e) {}
                }
                for (let i = 0; i < lps.length - 1; i++) {
                    segments.push({ ax: lps[i].x, ay: lps[i].y, bx: lps[i+1].x, by: lps[i+1].y });
                }
                // KML LinearRing already repeats its first point as the last,
                // so the loop above naturally closes the ring. No extra
                // closing segment needed.
            });
        });
        if (!segments.length) {
            console.warn(`${TAG} validator: no shielding loaded for site ${siteID}`);
            validatorState.lastRun = { error: 'No shielding KMLs loaded for this site', at: Date.now() };
            runUpdate();
            return;
        }

        const thresholdFt = Number(toggleState['validator.distance']) || 200;
        // Convert threshold from feet → layer-point units at this map state.
        // Use a small latitude offset at the map's current center as the
        // reference: same trick as renderValidatorPins. Web Mercator's scale
        // varies with latitude, but within a single site the variation is
        // negligible.
        const centerLL = map.getCenter();
        const latPerFt = 1 / 362776; // 1 deg lat ≈ 362,776 ft
        const lpA = map.latLngToLayerPoint(centerLL);
        const lpB = map.latLngToLayerPoint({ lat: centerLL.lat + thresholdFt * latPerFt, lng: centerLL.lng });
        const thresholdPx = Math.hypot(lpB.x - lpA.x, lpB.y - lpA.y);
        const t2 = thresholdPx * thresholdPx;

        const targetEls = document.querySelectorAll(`${SOLID_GREEN_SELECTOR}, ${BLUE_FLIGHT_PATH_SELECTOR}`);
        if (!targetEls.length) {
            console.warn(`${TAG} validator: no flight paths or FFZs to check`);
            validatorState.lastRun = { error: 'No flight paths or FFZs on this map', at: Date.now() };
            runUpdate();
            return;
        }

        const startTime = Date.now();
        const gaps = [];
        targetEls.forEach(el => {
            const total = el.getTotalLength();
            if (!total) return;
            const sampleCount = Math.min(2000, Math.max(50, Math.round(total / 3)));
            let currentGap = null;

            for (let i = 0; i <= sampleCount; i++) {
                const t = total * i / sampleCount;
                let sp;
                try { sp = el.getPointAtLength(t); } catch (e) { continue; }
                // sp is already in layer-point coords — same space as our
                // segments. Compute point-to-segment distance directly.
                let isFailing = true;
                for (let j = 0; j < segments.length; j++) {
                    const seg = segments[j];
                    if (pointToSegmentDist2(sp.x, sp.y, seg.ax, seg.ay, seg.bx, seg.by) <= t2) {
                        isFailing = false; break;
                    }
                }
                if (isFailing) {
                    if (!currentGap) currentGap = { samples: [] };
                    currentGap.samples.push({ x: sp.x, y: sp.y });
                } else if (currentGap) {
                    gaps.push(currentGap);
                    currentGap = null;
                }
            }
            if (currentGap) gaps.push(currentGap);
        });

        // For each gap: store ALL failing samples as lat/lng (used for the
        // red highlight that traces the failing portion of the outline) plus
        // a midpoint for the numbered pin.
        const results = gaps.map((g, i) => {
            const segsLL = g.samples.map(s => {
                const ll = map.layerPointToLatLng({ x: s.x, y: s.y });
                return { lat: ll.lat, lng: ll.lng };
            });
            const mid = segsLL[Math.floor(segsLL.length / 2)];
            return {
                number: i + 1,
                midLat: mid.lat,
                midLng: mid.lng,
                segments: segsLL,
                dismissed: false,
            };
        });

        validatorState.results = results;
        validatorState.lastRun = {
            count: results.length,
            at: Date.now(),
            durationMs: Date.now() - startTime,
        };
        saveValidatorResults();
        if (results.length === 0) {
            console.log(`${TAG} validator: ✓ no coverage gaps found (${validatorState.lastRun.durationMs}ms)`);
        } else {
            console.warn(`${TAG} validator: found ${results.length} coverage gap(s) in ${validatorState.lastRun.durationMs}ms — click a pin to dismiss after visual confirmation`);
        }
        runUpdate();
    }

    function clearCoverageValidator() {
        const had = validatorState.results.length;
        validatorState.results = [];
        validatorState.lastRun = null;
        saveValidatorResults();
        console.log(`${TAG} validator: cleared ${had} pin(s)`);
        runUpdate();
    }

    // Single document-level click delegate that handles ALL validator pin
    // clicks regardless of how often the SVG gets wiped & rebuilt. The pin
    // element re-creation cycle was making per-element listeners unreliable
    // (a click landing on a brand-new pin between rebuilds sometimes didn't
    // fire, suspected Leaflet's own capture handling). Delegating to a
    // stable parent (document, capture phase) is bullet-proof.
    let validatorDelegateInstalled = false;
    function installValidatorClickDelegate() {
        if (validatorDelegateInstalled) return;
        validatorDelegateInstalled = true;
        // Use both `click` and `pointerdown` so we don't lose dismissals
        // when Leaflet's own click/drag detection eats one but not the
        // other. Pointerdown fires earlier in the lifecycle and isn't
        // affected by Leaflet's "did the mouse move between down and up?"
        // drag-detection logic. Debounce so one physical click that
        // arrives via both paths only acts once.
        let lastDismissAt = 0;
        const handle = (e) => {
            const t = e.target;
            if (!t || !t.getAttribute) return;
            const attr = t.getAttribute('data-validator-number');
            if (attr == null) return;
            const num = parseInt(attr, 10);
            if (isNaN(num)) return;
            const now = Date.now();
            if (now - lastDismissAt < 300) return;
            lastDismissAt = now;
            e.stopPropagation();
            e.preventDefault();
            console.log(`${TAG} validator: pin ${num} hit via ${e.type}`);
            dismissValidatorPin(num);
        };
        document.addEventListener('click', handle, true);
        document.addEventListener('pointerdown', handle, true);
    }

    function dismissValidatorPin(number) {
        const r = validatorState.results.find(x => x.number === number);
        if (!r) {
            console.warn(`${TAG} validator: pin ${number} not in results (have: ${validatorState.results.map(x => x.number).join(',') || 'none'})`);
            return;
        }
        r.dismissed = !r.dismissed;
        saveValidatorResults();
        const total = validatorState.results.length;
        const remaining = validatorState.results.filter(x => !x.dismissed).length;
        console.log(`${TAG} validator: pin ${number} ${r.dismissed ? 'dismissed' : 'restored'} (${remaining}/${total} remaining)`);
        runUpdate();
    }

    // Persistence: store per-site so each Percepto site keeps its own
    // results. Reloads and site navigation both restore on demand.
    function saveValidatorResults() {
        const sid = getCurrentSiteID();
        if (!sid) return;
        gmSet(VALIDATOR_CACHE_PREFIX + sid, validatorState.results);
    }
    function loadValidatorResults() {
        const sid = getCurrentSiteID();
        if (!sid) { validatorState.results = []; return; }
        const saved = gmGet(VALIDATOR_CACHE_PREFIX + sid, null);
        validatorState.results = Array.isArray(saved) ? saved : [];
        if (validatorState.results.length) {
            console.log(`${TAG} validator: restored ${validatorState.results.length} pin(s) for site ${sid} from cache`);
        }
    }

    function renderValidatorPins() {
        if (!toggleState['validator.show']) return;
        if (!validatorState.results.length) return;
        const map = getLeafletMap();
        if (!map || typeof map.latLngToContainerPoint !== 'function') return;
        const container = map.getContainer ? map.getContainer() : document.querySelector('.leaflet-container');
        if (!container) return;
        const svg = document.querySelector('.leaflet-overlay-pane svg');
        if (!svg) return;
        const g = svg.querySelector('g');
        if (!g) return;
        let ctm;
        try { ctm = svg.getScreenCTM(); } catch (e) { return; }
        if (!ctm) return;
        const inv = ctm.inverse();
        const cRect = container.getBoundingClientRect();

        const latLngToSVG = (lat, lng) => {
            const cp = map.latLngToContainerPoint([lat, lng]);
            const sp = svg.createSVGPoint();
            sp.x = cRect.left + cp.x;
            sp.y = cRect.top + cp.y;
            return sp.matrixTransform(inv);
        };

        const thresholdFt = Number(toggleState['validator.distance']) || 200;
        const latOffsetDeg = thresholdFt / 362776;
        const showDismissed = !!toggleState['validator.show-dismissed'];

        validatorState.results.forEach(r => {
            if (r.dismissed && !showDismissed) return;

            const c = latLngToSVG(r.midLat, r.midLng);
            const c2 = latLngToSVG(r.midLat + latOffsetDeg, r.midLng);
            const radiusUnits = Math.hypot(c2.x - c.x, c2.y - c.y);
            const pinR = Math.max(8, radiusUnits * 0.07);

            // Active pins get the full visual (red highlight + coverage
            // circle). Dismissed pins (only shown when showDismissed=true)
            // get just a small gray marker so the user can see what they've
            // already cleared and click to un-dismiss.
            if (!r.dismissed) {
                // 1. Red polyline tracing the actual unshielded portion of
                //    the FFZ/FP outline — built from the failing samples.
                if (r.segments && r.segments.length >= 2) {
                    const pts = r.segments.map(s => latLngToSVG(s.lat, s.lng));
                    const d = pointsToPathD(pts, false);
                    const hl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    hl.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
                    hl.setAttribute('data-buffer-kind', 'validator-highlight');
                    hl.setAttribute('d', d);
                    hl.setAttribute('fill', 'none');
                    hl.setAttribute('stroke', '#ff0033');
                    hl.setAttribute('stroke-opacity', '0.85');
                    hl.setAttribute('stroke-width', String(Math.max(4, pinR * 0.7)));
                    hl.setAttribute('stroke-linecap', 'round');
                    hl.setAttribute('stroke-linejoin', 'round');
                    hl.setAttribute('pointer-events', 'none');
                    g.appendChild(hl);
                }

                // 2. 200ft coverage circle (translucent red, dashed border)
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
                circle.setAttribute('data-buffer-kind', 'validator-coverage');
                circle.setAttribute('cx', String(c.x));
                circle.setAttribute('cy', String(c.y));
                circle.setAttribute('r', String(radiusUnits));
                circle.setAttribute('fill', '#ff0033');
                circle.setAttribute('fill-opacity', '0.08');
                circle.setAttribute('stroke', '#ff0033');
                circle.setAttribute('stroke-opacity', '0.45');
                circle.setAttribute('stroke-width', String(Math.max(1, radiusUnits * 0.015)));
                circle.setAttribute('stroke-dasharray', `${radiusUnits * 0.04} ${radiusUnits * 0.04}`);
                circle.setAttribute('pointer-events', 'none');
                g.appendChild(circle);
            }

            // 3. Pin marker (always rendered when shown). Clickable to
            //    dismiss / un-dismiss. Coverage circle is pass-through so
            //    map interactions in that area still work.
            const pin = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            pin.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
            pin.setAttribute('data-buffer-kind', 'validator-pin');
            pin.setAttribute('data-validator-number', String(r.number));
            pin.setAttribute('cx', String(c.x));
            pin.setAttribute('cy', String(c.y));
            pin.setAttribute('r', String(pinR));
            if (r.dismissed) {
                pin.setAttribute('fill', '#666');
                pin.setAttribute('fill-opacity', '0.55');
                pin.setAttribute('stroke', '#aaa');
                pin.setAttribute('stroke-opacity', '0.8');
            } else {
                pin.setAttribute('fill', '#cc0029');
                pin.setAttribute('stroke', '#ffffff');
                pin.setAttribute('stroke-opacity', '1');
            }
            pin.setAttribute('stroke-width', String(Math.max(1.5, pinR * 0.2)));
            // Set pointer-events both as SVG attribute AND as inline CSS so
            // nothing — neither Leaflet's class-based pointer-events styling
            // nor a stylesheet — can override the hit area. Click/dismiss
            // is handled by document-level delegate (installValidatorClickDelegate).
            pin.setAttribute('pointer-events', 'all');
            pin.style.pointerEvents = 'all';
            pin.style.cursor = 'pointer';
            g.appendChild(pin);

            // 4. Number text (pointer-events none so clicks go to the pin)
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
            text.setAttribute('data-buffer-kind', 'validator-num');
            text.setAttribute('x', String(c.x));
            text.setAttribute('y', String(c.y));
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'central');
            text.setAttribute('fill', r.dismissed ? '#ddd' : '#ffffff');
            text.setAttribute('fill-opacity', r.dismissed ? '0.7' : '1');
            text.setAttribute('font-size', String(pinR * 1.25));
            text.setAttribute('font-weight', 'bold');
            text.setAttribute('font-family', 'sans-serif');
            text.setAttribute('pointer-events', 'none');
            text.textContent = String(r.number);
            g.appendChild(text);
        });
    }

    // --- Violation detection ---
    // Samples each FFZ / FP path and each asset path, BBox-prunes pairs that
    // can't possibly be within threshold, then min-distance scans survivors.
    // Drops a red SVG circle at the closest point on the asset for each
    // (source, asset) pair that violates. Requires asset.show on — the dot
    // sits visually on/near the asset and is meaningless without it.
    //
    // Known limitation: distance is outline-to-outline. If an FFZ fully
    // contains a small asset and the outlines are >threshold apart, the
    // asset won't be flagged. In practice mis-drawn FFZs around assets
    // are still close enough to flag; revisit if this gets reported.
    function renderViolations(globalBaseWidth, lineThickness, standardRatio) {
        if (!toggleState['asset.show']) return;
        const ffzOn = toggleState['ffz.show'] && toggleState['ffz.violations'];
        const fpOn = toggleState['fp.show'] && toggleState['fp.violations'];
        if (!ffzOn && !fpOn) return;
        const svg = document.querySelector('.leaflet-overlay-pane svg');
        if (!svg) return;
        const g = svg.querySelector('g');
        if (!g) return;
        const assetEls = document.querySelectorAll(WHITE_ASSET_SELECTOR);
        if (!assetEls.length) return;

        const baseW = globalBaseWidth || (lineThickness * standardRatio);
        // ftToOneSide: ft → user units for a point-to-point distance (NOT a
        // band width). Buffer code uses 2 × ft × baseW / 31.5 because that's
        // the total band straddling the line; here we want the half-distance.
        const ftToOneSide = (ft) => ft * baseW / 31.5;
        const SAMPLES = 60;

        const assetSamples = [];
        assetEls.forEach(el => {
            const pts = samplePath(el, SAMPLES);
            if (pts.length) assetSamples.push({ el, points: pts, bbox: bboxOf(pts) });
        });
        if (!assetSamples.length) return;

        const dotR = Math.max(3, baseW * 0.45);
        if (ffzOn) {
            const t = ftToOneSide(Number(toggleState['ffz.violation-distance']) || 15);
            document.querySelectorAll(SOLID_GREEN_SELECTOR).forEach(src => {
                checkAndMark(src, assetSamples, t, dotR, g);
            });
        }
        if (fpOn) {
            const t = ftToOneSide(Number(toggleState['fp.violation-distance']) || 15);
            document.querySelectorAll(BLUE_FLIGHT_PATH_SELECTOR).forEach(src => {
                checkAndMark(src, assetSamples, t, dotR, g);
            });
        }
        // Note: there used to be a 'kml.violations' check here (assets within
        // Xft of shielding). That was the wrong semantic — the FAA rule is the
        // opposite: flight paths must STAY WITHIN 200ft of shielding. That's
        // now the Coverage Validator feature (separate category, on-demand).
    }

    function checkAndMarkPoints(srcPts, assetSamples, threshold, dotR, g) {
        if (!srcPts || !srcPts.length) return;
        const srcBBox = bboxOf(srcPts);
        const t2 = threshold * threshold;
        for (let a = 0; a < assetSamples.length; a++) {
            const { points: aPts, bbox: aBBox } = assetSamples[a];
            if (!bboxesOverlap(srcBBox, aBBox, threshold)) continue;
            let minD2 = Infinity, hit = null;
            for (let i = 0; i < srcPts.length; i++) {
                const sp = srcPts[i];
                for (let j = 0; j < aPts.length; j++) {
                    const dx = sp.x - aPts[j].x;
                    const dy = sp.y - aPts[j].y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < minD2) { minD2 = d2; hit = aPts[j]; }
                }
            }
            if (minD2 < t2 && hit) placeViolationDot(g, hit.x, hit.y, dotR);
        }
    }

    function samplePath(pathEl, count) {
        const out = [];
        try {
            const total = pathEl.getTotalLength();
            if (!total) return out;
            for (let i = 0; i <= count; i++) {
                const p = pathEl.getPointAtLength(total * i / count);
                out.push({ x: p.x, y: p.y });
            }
        } catch (e) { /* path not measurable (e.g. detached) */ }
        return out;
    }

    function bboxOf(pts) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return { minX, minY, maxX, maxY };
    }

    function bboxesOverlap(a, b, pad) {
        return !(a.maxX + pad < b.minX || b.maxX + pad < a.minX ||
                 a.maxY + pad < b.minY || b.maxY + pad < a.minY);
    }

    function checkAndMark(src, assetSamples, threshold, dotR, g) {
        const srcPts = samplePath(src, 60);
        if (!srcPts.length) return;
        const srcBBox = bboxOf(srcPts);
        const t2 = threshold * threshold;
        for (let a = 0; a < assetSamples.length; a++) {
            const { points: aPts, bbox: aBBox } = assetSamples[a];
            if (!bboxesOverlap(srcBBox, aBBox, threshold)) continue;
            let minD2 = Infinity, hit = null;
            for (let i = 0; i < srcPts.length; i++) {
                const sp = srcPts[i];
                for (let j = 0; j < aPts.length; j++) {
                    const dx = sp.x - aPts[j].x;
                    const dy = sp.y - aPts[j].y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < minD2) { minD2 = d2; hit = aPts[j]; }
                }
            }
            if (minD2 < t2 && hit) {
                placeViolationDot(g, hit.x, hit.y, dotR);
            }
        }
    }

    function placeViolationDot(g, x, y, r) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
        dot.setAttribute('data-buffer-kind', 'violation');
        dot.setAttribute('cx', String(x));
        dot.setAttribute('cy', String(y));
        dot.setAttribute('r', String(r));
        dot.setAttribute('fill', '#ff0033');
        dot.setAttribute('fill-opacity', '0.9');
        dot.setAttribute('stroke', '#ffffff');
        dot.setAttribute('stroke-width', String(Math.max(1, r * 0.25)));
        dot.setAttribute('stroke-opacity', '0.95');
        dot.setAttribute('pointer-events', 'none');
        g.appendChild(dot);
    }

    function renderAltitudeShields(globalBaseWidth, lineThickness, standardRatio) {
        // Both the category master AND the shield sub-toggle must be on.
        if (!toggleState['altitude.show']) return;
        if (!toggleState['altitude.shield']) return;
        const svg = document.querySelector('.leaflet-overlay-pane svg');
        if (!svg) return;
        const g = svg.querySelector('g');
        if (!g) return;
        // Markers are <img>s with file names like altitude-shadow-*.svg or
        // altitude-marker-*.svg — both put up by the Absolute Altitude tool.
        const markers = document.querySelectorAll('img.leaflet-marker-icon[src*="altitude"]');
        if (!markers.length) return;
        let ctm;
        try { ctm = svg.getScreenCTM(); } catch (e) { return; }
        if (!ctm) return;
        const inv = ctm.inverse();

        // Convert "ft" to SVG user units using the same scale that drives the
        // line buffers. Empirical: at standardRatio=1.8, baseWidth (=18 units)
        // renders as ~31.5ft total band width at typical working zoom. So 1ft
        // ≈ baseWidth/31.5 user units. The user-facing 'Shielding distance'
        // multiplier compensates for zoom-driven drift if measurements drift.
        const FT_PER_BASEWIDTH = 31.5;
        const baseWidth = globalBaseWidth || (lineThickness * standardRatio);
        const altMult = Number(toggleState['altitude.distance']) || 1.0;
        const radius = baseWidth * (200 / FT_PER_BASEWIDTH) * altMult;
        const fillColor = toggleState['altitude.color'] || '#8a2be2';
        const fillOpacity = Number(toggleState['altitude.opacity']);
        const opacity = isNaN(fillOpacity) ? 0.15 : fillOpacity;
        // Stroke is a touch more opaque so the edge stays visible even at low
        // fill values; capped at 1.
        const strokeOpacity = Math.min(opacity * 2.5, 1);

        markers.forEach(marker => {
            const rect = marker.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            // Pin tip is the bottom-center of the icon — that's where the GPS
            // coord lives. Use it as the circle center to avoid offset.
            const pt = svg.createSVGPoint();
            pt.x = rect.left + rect.width / 2;
            pt.y = rect.bottom;
            const p = pt.matrixTransform(inv);

            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
            circle.setAttribute('data-buffer-kind', 'altitude-shield');
            circle.setAttribute('cx', String(p.x));
            circle.setAttribute('cy', String(p.y));
            circle.setAttribute('r', String(radius));
            circle.setAttribute('fill', fillColor);
            circle.setAttribute('fill-opacity', String(opacity));
            circle.setAttribute('stroke', fillColor);
            circle.setAttribute('stroke-opacity', String(strokeOpacity));
            circle.setAttribute('stroke-width', '2');
            circle.setAttribute('pointer-events', 'none');
            g.insertBefore(circle, g.firstChild);
        });
    }

    function enhanceAltitudePopups() {
        // The Absolute Altitude tool renders popups with .map-tools__altitude.
        // the host app's DOM may wrap the altitude/coords text in spans we don't
        // know about, so don't try to surgically replace text nodes — extract
        // the values via regex over the full text, then rebuild the popup's
        // inner DOM from scratch with our two copy-to-clipboard links.
        // Marked with data-aim-enhanced to avoid re-processing every tick.
        document.querySelectorAll('.map-tools__altitude:not([data-aim-enhanced])').forEach(popup => {
            const fullText = popup.textContent || '';
            const altMatch = fullText.match(/([\d.]+)\s*ft/);
            const coordMatch = fullText.match(/(-?\d+\.\d{3,}),\s*(-?\d+\.\d{3,})/);
            if (!altMatch && !coordMatch) return;
            popup.setAttribute('data-aim-enhanced', 'true');

            // Preserve the GPS marker icon if present, then wipe and rebuild.
            const iconClone = popup.querySelector('img') ? popup.querySelector('img').cloneNode(true) : null;
            popup.innerHTML = '';

            if (altMatch) {
                const rounded = Math.round(parseFloat(altMatch[1]));
                const altLabel = document.createElement('span');
                altLabel.className = 'map-tools__altitude__label';
                altLabel.textContent = 'Altitude:';
                popup.appendChild(altLabel);
                popup.appendChild(document.createTextNode(' '));
                popup.appendChild(makeCopyLink(rounded + ' ft', String(rounded), 'Click to copy altitude'));
            }
            if (coordMatch) {
                const coordsText = coordMatch[1] + ', ' + coordMatch[2];
                const coordsDiv = document.createElement('div');
                coordsDiv.className = 'map-tools__altitude__coords';
                if (iconClone) coordsDiv.appendChild(iconClone);
                coordsDiv.appendChild(makeCopyLink(coordsText, coordsText, 'Click to copy GPS coordinates'));
                popup.appendChild(coordsDiv);
            }
        });
    }

    function makeCopyLink(displayText, copyText, title) {
        const link = document.createElement('a');
        link.textContent = displayText;
        link.href = '#';
        link.title = title;
        link.style.cssText = 'color:inherit;text-decoration:underline;cursor:pointer';
        link.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(copyText).then(() => flashCopyFeedback(link));
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = copyText;
                    ta.style.cssText = 'position:fixed;opacity:0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    flashCopyFeedback(link);
                }
            } catch (err) { console.warn(`${TAG} copy failed`, err); }
        });
        return link;
    }

    function flashCopyFeedback(link) {
        const original = link.textContent;
        link.textContent = '✓ copied';
        setTimeout(() => { link.textContent = original; }, 900);
    }

    function cleanup() {
        console.log(`${TAG} Cleaning up visuals...`);
        document.querySelectorAll(`[${CUSTOM_BUFFER_ATTR}="true"]`).forEach(el => el.remove());
        // Restore everything we may have hidden via Hide Native Distractions.
        document.querySelectorAll(ORIGINAL_BLUE_BUFFER_SELECTOR).forEach(el => el.style.display = '');
        document.querySelectorAll(BLACK_DASHED_FP_SELECTOR).forEach(el => el.style.display = '');
        document.querySelectorAll(BLACK_DASHED_FFZ_SELECTOR).forEach(el => el.style.display = '');
        document.querySelectorAll(GREEN_BUFFER_SELECTOR).forEach(el => el.style.display = '');
        // Restore any line widths we forced (now also covers white assets).
        document.querySelectorAll(`${SOLID_GREEN_SELECTOR}, ${BLUE_FLIGHT_PATH_SELECTOR}, ${WHITE_ASSET_SELECTOR}`).forEach(el => {
            const orig = parseFloat(el.getAttribute('data-original-width'));
            if (!isNaN(orig)) el.setAttribute('stroke-width', String(orig));
        });
        // Restore asset fill-opacity + fill color we may have set.
        document.querySelectorAll(WHITE_ASSET_SELECTOR).forEach(el => {
            el.style.fillOpacity = '';
            el.style.fill = '';
        });
        // Restore line stroke colors / opacities we overrode via inline style.
        document.querySelectorAll(`${SOLID_GREEN_SELECTOR}, ${BLUE_FLIGHT_PATH_SELECTOR}, ${WHITE_ASSET_SELECTOR}`).forEach(el => {
            el.style.stroke = '';
            el.style.strokeOpacity = '';
        });
        // Remove the FP vertex CSS override so Percepto's native styling returns.
        const vStyle = document.getElementById(FP_VERTEX_STYLE_ID);
        if (vStyle) vStyle.remove();
        // Restore the satellite base tile layer if we hid it.
        restoreMapBackground();
        // Restore ortho brightness + native zoom if we changed them.
        restoreOrthoSettings();
    }

    // 50ms quiet-after-last-mutation, 300ms hard cap. Tuning history:
    // 500 → 150 (snappier edits, more CPU) → 300 (heavier sites were
    // spending too much time rebuilding overlays during zoom/pan storms;
    // 300ms cap halves the rebuild frequency during continuous mutation
    // with imperceptible UX cost — combined with the hash-based skip
    // check in runUpdate it materially reduces CPU on dense sites).
    const debouncedUpdate = debounce(runUpdate, UPDATE_DELAY_MS, 300);
    const observerConfig = { attributes: true, childList: true, subtree: true, attributeFilter: ['d', 'stroke', 'stroke-width', 'class'] };

    let mapPaneWaitTimer = null;

    function setActiveState(newState) {
        if (isActive === newState) return;
        isActive = newState;
        if (isActive) {
            // Try to grab the Leaflet map's prototype now so any future maps
            // register themselves. Existing maps fall through to fallback
            // detection in getLeafletMap().
            patchLeafletMap();
            attachObserverWhenReady();
            // Kick off the KML fetch for whatever site we're currently on.
            // No-op if no site ID, no token, or already cached.
            const sid = getCurrentSiteID();
            if (sid) fetchKMLForSite(sid);
        } else {
            console.log(`${TAG} 🔴 DEACTIVATED`);
            if (mapPaneWaitTimer) { clearTimeout(mapPaneWaitTimer); mapPaneWaitTimer = null; }
            if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
            if (observer) { observer.disconnect(); observer = null; }
            observerTarget = null;
            cleanup();
        }
    }

    // On reload, the styler activates before the host app's React has mounted the
    // map. If we attach the observer to document.body fallback, later mutations
    // sometimes don't fire reliably for the map-pane subtree — so the user
    // ends up having to tinker with toggles to force a fresh runUpdate.
    // Instead: poll until .leaflet-map-pane exists, THEN attach the observer
    // and run the first update. Cheap (every 200ms, max 30s).
    function attachObserverWhenReady(attempt = 0) {
        if (!isActive) return; // deactivated while waiting
        const container = document.querySelector('.leaflet-map-pane')
            || document.querySelector('.leaflet-overlay-pane');
        if (!container) {
            if (attempt > 150) {
                console.warn(`${TAG} gave up waiting for .leaflet-map-pane after 30s`);
                return;
            }
            mapPaneWaitTimer = setTimeout(() => attachObserverWhenReady(attempt + 1), 200);
            return;
        }
        mapPaneWaitTimer = null;
        if (observer) observer.disconnect();
        console.log(`${TAG} 🟢 ACTIVATED (map-pane found on attempt ${attempt + 1})`);
        observerTarget = container;
        observer = new MutationObserver(debouncedUpdate);
        observer.observe(container, observerConfig);
        runUpdate();
        // Heartbeat: re-run periodically so buffers catch up even if the
        // MutationObserver misses a relevant change (the host app's React can
        // re-mount subtrees in patterns that don't reliably bubble childList
        // events to our observer target). 3s is the safety-net cadence —
        // most "missed" changes self-correct via the next user interaction's
        // mutation, so a slower heartbeat is fine. Combined with the
        // hash-based no-op check in runUpdate, idle CPU cost is negligible.
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (!isActive) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
                return;
            }
            // Defense-in-depth: if Percepto's React detached the node our
            // observer was attached to, we wouldn't have received any
            // mutation events for the new subtree. Force a runUpdate so its
            // built-in self-heal re-attaches the observer (and re-renders).
            // This bypasses the hash check below.
            if (observerTarget && !document.body.contains(observerTarget)) {
                runUpdate();
                return;
            }
            // Hash-based no-op: if relevant inputs (line counts, zoom,
            // KML feature counts, toggles, validator results, OUR overlay
            // count) match the last render, skip the wipe+rebuild. Mutation
            // observer catches actual changes; heartbeat is just the safety net.
            if (computeUpdateHash() === lastUpdateHash) return;
            runUpdate();
        }, 3000);
    }

    function toggleStyler() {
        const newState = !isActive;
        setActiveState(newState);
        stateChannel.postMessage({ action: "TOGGLE", state: newState });
    }

    function installListener() {
        window.addEventListener('keydown', function(e) {
            // Defer to the control panel's hotkey router once it's announced
            // itself — prevents Shift+O double-firing (control panel toggles,
            // then our own listener toggles again, net no change).
            if (controlPanelDetected) return;
            var el = e.target;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
                el.isContentEditable || el.closest('.ant-input') || el.closest('.ant-select') ||
                el.getAttribute('role') === 'textbox') return;

            if (e.shiftKey && (e.code === TRIGGER_KEY_CODE || e.key === 'O' || e.key === 'o')) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                toggleStyler();
            }
        }, true);
    }

    // Asset lockdown click/mousedown interceptor. Installed unconditionally
    // (one set of listeners per page) but only swallows events when the
    // `asset.locked` toggle is on AND the user isn't holding Shift (the
    // per-asset bypass). Capture phase so we run before Leaflet's bubble
    // handlers — once we stopPropagation it's as if the click never happened
    // as far as Leaflet / the host app is concerned.
    function installAssetLockHandler() {
        if (window.aimAssetLockInstalled) return;
        window.aimAssetLockInstalled = true;
        const handler = (e) => {
            if (toggleState['asset.locked'] !== true) return;
            if (e.shiftKey) return; // bypass
            const t = e.target;
            if (!t || !t.closest) return;
            if (t.closest('path.leaflet-interactive[stroke="#ffffff"]')) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        };
        // mousedown is what Leaflet actually uses for selection; click is
        // included as belt-and-suspenders.
        document.addEventListener('mousedown', handler, true);
        document.addEventListener('click', handler, true);
    }

    function setupControlPanel() {
        try {
            controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME);
        } catch (e) {
            console.warn(`${TAG} control channel unavailable:`, e);
            return;
        }
        controlChannel.onmessage = (ev) => {
            controlPanelDetected = true;
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') {
                registerWithControlPanel();
            } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                const newVal = msg.value !== undefined ? msg.value : msg.enabled;
                const prev = toggleState[msg.toggleId];
                toggleState[msg.toggleId] = newVal;
                if (msg.toggleId === 'master') {
                    // Only log when the value actually transitions. The Control
                    // Panel re-broadcasts SET_TOGGLE on every REGISTER from any
                    // script — with several scripts × TOP+IFRAME contexts, that's
                    // dozens of redundant arrivals per page load. setActiveState
                    // is idempotent so calling it repeatedly is fine; we just
                    // don't want to log every one.
                    if (!!newVal !== !!prev) {
                        console.log(`${TAG} SET_TOGGLE master=${!!newVal}`);
                    }
                    setActiveState(!!newVal);
                } else if (isActive && prev !== newVal) {
                    runUpdate();
                }
            } else if (msg.type === 'REFETCH_KMLS') {
                // Control panel just stored a new token (or the user clicked
                // refresh). Drop missing-cache entries for all types and
                // re-fetch for the current site.
                kmlMissing.clear();
                const sid = getCurrentSiteID();
                if (sid) {
                    KML_TYPES.forEach(t => { delete kmlFeatures[kmlKey(sid, t)]; });
                    fetchKMLForSite(sid, true);
                }
            } else if (msg.type === 'TOKEN_VALUE') {
                // Control panel handed us the PAT (either on our REQUEST_TOKEN,
                // or proactively after the user saved a new one). Cache in
                // memory and kick off a fetch if we don't have data yet.
                const prev = cachedToken;
                cachedToken = msg.token || '';
                if (cachedToken && cachedToken !== prev) {
                    const sid = getCurrentSiteID();
                    if (sid) fetchKMLForSite(sid, true);
                }
            } else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === SCRIPT_ID) {
                // Button-type controls in the panel broadcast this when clicked.
                if (msg.actionId === 'run-validator') runCoverageValidator();
                else if (msg.actionId === 'clear-validator') clearCoverageValidator();
            } else if (msg.type === 'PERF_TOGGLE' && msg.key === 'hide-satellite') {
                // Driven by AIM Performance Shield. Mirror its state, then
                // re-run so the satellite layer hides/shows immediately.
                const next = !!msg.value;
                if (next !== perfHideSatellite) {
                    perfHideSatellite = next;
                    if (isActive) runUpdate();
                    else if (!next) restoreMapBackground();
                }
            } else if (msg.type === 'HOTKEY_FIRED' && msg.scriptId === SCRIPT_ID) {
                if (msg.hotkeyId === 'toggle-master') {
                    const next = !isActive;
                    toggleState.master = next;
                    setActiveState(next);
                    // Persist via control panel so the toggle reflects too.
                    controlChannel.postMessage({
                        type: 'SET_TOGGLE', scriptId: SCRIPT_ID, toggleId: 'master', enabled: next,
                    });
                    // Note: control panel will echo this back to us, but our
                    // SET_TOGGLE handler is idempotent.
                }
            }
        };
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER',
            scriptId: SCRIPT_ID,
            name: 'Outlines',
            description: 'Horizontal safety buffers (FFZs, assets, flight paths)',
            version: SCRIPT_VERSION,
            frame: FRAME_ID,
            toggles: TOGGLES,
            hotkeys: HOTKEYS,
        });
        // Also ask for the PAT — the control panel responds with TOKEN_VALUE
        // if it has one. (The panel also auto-sends on REGISTER, but asking
        // explicitly covers the case where this script loaded first.)
        controlChannel.postMessage({ type: 'REQUEST_TOKEN' });
        // Ask Perf Shield to replay its current state — covers the case where
        // this script loaded after Perf Shield broadcast initial values.
        controlChannel.postMessage({ type: 'REQUEST_PERF_SETTINGS' });
    }

    setupControlPanel();
    registerWithControlPanel();
    installListener();
    installAssetLockHandler();

    // Safety net: if no SET_TOGGLE for `master` arrives shortly after
    // registration, auto-activate. Symptom this prevents: when the Control
    // Panel's GM storage gets wiped (browsing-data clear, etc.) the panel
    // sometimes doesn't echo SET_TOGGLE for the master and the styler stays
    // dormant — KMLs load but nothing renders, satellite stays visible.
    // Only fires if the user hasn't explicitly turned master off (we'd see
    // that as toggleState.master === false from an arrived SET_TOGGLE).
    setTimeout(() => {
        if (!isActive && toggleState.master !== false) {
            console.log(`${TAG} master SET_TOGGLE not received within 1.5s — auto-activating (schema default)`);
            setActiveState(true);
        }
    }, 1500);

    // Detect site navigation (the host app is a hash-routed SPA — the styler
    // stays loaded across site changes, so we have to spot the hash change
    // ourselves and re-fetch the appropriate KML and reload validator pins).
    let lastSiteID = getCurrentSiteID();
    window.addEventListener('hashchange', () => {
        const sid = getCurrentSiteID();
        if (sid === lastSiteID) return;
        lastSiteID = sid;
        loadValidatorResults();
        if (isActive && sid) {
            console.log(`${TAG} site changed to ${sid} — fetching KML`);
            fetchKMLForSite(sid);
            runUpdate();
        }
    });

    // Restore any previously-saved validator pins for the current site so
    // they appear immediately when the styler activates.
    loadValidatorResults();
    // Wire up the click-to-dismiss handler once, against document.
    installValidatorClickDelegate();

    if (isActive) setActiveState(true);

})();