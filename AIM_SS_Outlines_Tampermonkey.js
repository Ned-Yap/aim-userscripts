// ==UserScript==
// @name         AIM Map Styler
// @namespace    http://tampermonkey.net/
// @version      30.1
// @description  Adds buffers/outlines to map lines and enforces line thicknesses. Toggle with Shift+O.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    const TRIGGER_KEY_CODE = 'KeyO';
    const CONTEXT = window === window.top ? "TOP" : "IFRAME";
    const CHANNEL_NAME = "AIM_STYLER_CHANNEL";
    const FRAME_ID = `${CONTEXT}@${location.pathname}${location.search ? '?' + location.search.slice(0, 40) : ''}`;
    const TAG = `[AIM STYLER ${FRAME_ID}]`;

    console.log(`${TAG} 🎨 Initializing...`);

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
    const SCRIPT_VERSION = '30.1';
    // Schema: each category owns its own sub-toggles (shielding, edit-mode,
    // hide-native, force-thickness). No global masters for those — each
    // category controls what applies to itself. Shielding's visual styling
    // (color/opacity/distance) lives in Advanced as a shared knob since
    // toggles in different categories share the same shielding appearance.
    const TOGGLES = [
        { id: 'master', label: 'Show Overlays (Master)', type: 'boolean', default: false, master: true },
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
                { id: 'asset.fill', label: 'Show asset fill', type: 'boolean', default: true },
                { id: 'asset.force-thickness', label: 'Force line thickness', type: 'boolean', default: true },
                { id: 'asset.edit-mode', label: 'Show in edit mode', type: 'boolean', default: true },
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
                { id: 'fp.color', label: 'Buffer color', type: 'color', default: '#1ca0de' },
                { id: 'fp.opacity', label: 'Buffer opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.5, unit: 'fill' },
                { id: 'fp.65ft-band', label: 'Show 65ft outer band', type: 'boolean', default: true },
                { id: 'fp.65ft-distance', label: '65ft band distance', type: 'number',
                  min: 5, max: 500, step: 1, default: 65, unit: 'ft' },
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
            if (isWhiteAsset) {
                if (toggleState['asset.show']) {
                    line.style.fillOpacity = toggleState['asset.fill'] === false ? '0' : '';
                } else {
                    line.style.fillOpacity = '';
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
                band65.setAttribute('stroke', toggleState['fp.color'] || '#1ca0de');
                // Outer band ~45% the inner band's opacity, so it reads as a
                // softer extension rather than competing with the 40ft fill.
                const fpOp = Number(toggleState['fp.opacity']);
                const baseOp = isNaN(fpOp) ? 0.5 : fpOp;
                band65.setAttribute('stroke-opacity', String(baseOp * 0.45));
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
        // 6. Violation dots — assets within Xft of FFZ/FP main line.
        renderViolations(globalBaseWidth, lineThickness, standardRatio);
        // 7. Round altitude + make values copyable in altitude popups.
        enhanceAltitudePopups();
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
        // Restore asset fill-opacity we may have zeroed.
        document.querySelectorAll(WHITE_ASSET_SELECTOR).forEach(el => { el.style.fillOpacity = ''; });
    }

    // 50ms quiet-after-last-mutation, 150ms hard cap. The hard cap matters
    // during page load / zoom when mutations are continuous and a plain
    // debounce would defer forever. 150 (was 500) trades a bit more CPU
    // for a snappier feel while editing zones.
    const debouncedUpdate = debounce(runUpdate, UPDATE_DELAY_MS, 150);
    const observerConfig = { attributes: true, childList: true, subtree: true, attributeFilter: ['d', 'stroke', 'stroke-width', 'class'] };

    let mapPaneWaitTimer = null;

    function setActiveState(newState) {
        if (isActive === newState) return;
        isActive = newState;
        if (isActive) {
            attachObserverWhenReady();
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
        // events to our observer target). 1.5s is invisible to users but
        // negligible CPU (runUpdate is a few ms when there's nothing to do).
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (!isActive) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
                return;
            }
            runUpdate();
        }, 1500);
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
                    setActiveState(!!newVal);
                } else if (isActive && prev !== newVal) {
                    runUpdate();
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
    }

    setupControlPanel();
    registerWithControlPanel();
    installListener();
    if (isActive) setActiveState(true);

})();