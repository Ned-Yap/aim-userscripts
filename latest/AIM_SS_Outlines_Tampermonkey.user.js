// ==UserScript==
// @name         Latest - AIM Map Styler
// @namespace    http://tampermonkey.net/
// @version      34.80
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_SS_Outlines_Tampermonkey.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_SS_Outlines_Tampermonkey.user.js
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
// @connect      api.github.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @run-at       document-end
// ==/UserScript==

(function() {
    const TRIGGER_KEY_CODE = 'KeyO';
    const CONTEXT = window === window.top ? "TOP" : "IFRAME";
    const CHANNEL_NAME = "AIM_STYLER_CHANNEL";
    const FRAME_ID = `${CONTEXT}@${location.pathname}${location.search ? '?' + location.search.slice(0, 40) : ''}`;
    const TAG = `[AIM STYLER ${FRAME_ID}]`;
    // SCRIPT_VERSION moved UP here in v34.39 so the init log (which uses
    // it) doesn't hit a const TDZ. v34.38 had it declared after the log
    // line — broken on every load with "Cannot access 'SCRIPT_VERSION'
    // before initialization". See [[feedback-perf-shield-tdz-pattern]]
    // and [[feedback-always-update-memory-after-ship]] — any const
    // referenced from init must be declared at top of IIFE.
    // Bump this whenever the @version header changes — it's what the
    // control panel displays so you can verify which version is loaded.
    const SCRIPT_VERSION = '34.80';

    console.log(`${TAG} 🎨 Initializing v${SCRIPT_VERSION}...`);

    const stateChannel = new BroadcastChannel(CHANNEL_NAME);
    stateChannel.onmessage = (event) => {
        const d = event.data || {};
        if (d.action === "TOGGLE") setActiveState(d.state);
        // The map iframe is the only frame that fetches asset data, so it
        // broadcasts the discovered equipment set; every frame adopts it and
        // re-registers so the panel schema is identical across frames (same
        // scriptId → last register wins, so they MUST agree). See
        // applyEquipFromBroadcast.
        else if (d.action === "ASSET_EQUIP") applyEquipFromBroadcast(d);
    };

    // --- AIM Control Panel integration ---
    // Registers with AIM_Control_Panel.js for centralized toggle/hotkey UI.
    // Backwards-compatible: if the control panel isn't loaded, the script still
    // works on its own with Shift+O.
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-styler';
    // Schema: each category owns its own sub-toggles (shielding, edit-mode,
    // hide-native, force-thickness). No global masters for those — each
    // category controls what applies to itself. Shielding's visual styling
    // (color/opacity/distance) lives in Advanced as a shared knob since
    // toggles in different categories share the same shielding appearance.
    // --- Asset state styling (v34.70) ---
    // Assets render as white SVG polygons that carry NO state info. Their
    // state (Normal / Empty / Unshielded / Unreachable / HY / Inactive) lives
    // in /map_objects — derived from the asset's subtype (custom.poi_type_str,
    // the text after " - ", e.g. "battery - empty") plus the is_unshielded
    // flag. When "Color assets by state" is on we fetch the entity list once
    // per site, geometry-match each white path to its asset (point-in-polygon
    // on the path centroid), tag it data-aim-asset-state, and style it
    // per-state instead of with the single uniform white-asset look.
    const ASSET_STATE_ORDER = ['Normal', 'Empty', 'Unshielded', 'Unreachable', 'HY', 'Inactive'];
    const ASSET_STATE_DEFAULTS = {
        // Normal = the build-to-it good state — pink, solid, with a subtle
        // fill so healthy assets pop against the dashed problem states.
        'Normal':      { color: '#ff5fb0', width: 10, dashed: false, fill: true,  fillColor: '#ff5fb0', opacity: 0.25 },
        'Empty':       { color: '#cfcfcf', width: 10, dashed: true,  fill: false, fillColor: '#cfcfcf', opacity: 0.25 },
        'Unshielded':  { color: '#ff5722', width: 10, dashed: true,  fill: false, fillColor: '#ff5722', opacity: 0.25 },
        'Unreachable': { color: '#ffffff', width: 10, dashed: true,  fill: false, fillColor: '#ffffff', opacity: 0.25 },
        'HY':          { color: '#22d3ee', width: 10, dashed: false, fill: false, fillColor: '#22d3ee', opacity: 0.25 },
        'Inactive':    { color: '#ffa040', width: 10, dashed: true,  fill: false, fillColor: '#ffa040', opacity: 0.25 },
    };
    // Used for any state we discover at runtime that isn't in the fixed list
    // above (e.g. midstream / T&D taxonomies) — gray dashed, no panel row.
    const ASSET_STATE_FALLBACK = { color: '#9aa0a6', width: 10, dashed: true, fill: false, fillColor: '#9aa0a6', opacity: 0.25 };
    const stateSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const MAP_OBJECTS_URL = 'https://percepto.app/map_objects/?getPoiMapObjectsAsList=true&site_id=';
    // Builds the per-state Control Panel rows appended to the Assets category.
    function buildAssetStateToggles() {
        const out = [
            { type: 'header', label: 'Color assets by state' },
            { id: 'asset.by-state', label: 'Color assets by state (overrides white)', type: 'boolean', default: false },
            // Asset state/equipment is cached per site at load; after editing an
            // asset in Percepto this re-fetches so its color/visibility updates.
            { id: 'asset-refresh', label: '↻ Refresh asset data (after edits)', type: 'button', action: 'refresh-asset-data' },
        ];
        ASSET_STATE_ORDER.forEach(state => {
            const slug = stateSlug(state);
            const d = ASSET_STATE_DEFAULTS[state];
            out.push({ type: 'header', label: `· ${state}` });
            out.push({ id: `astate.${slug}.show`, label: `${state} — show on map`, type: 'boolean', default: true });
            out.push({ id: `astate.${slug}.color`, label: `${state} outline color`, type: 'color', default: d.color });
            out.push({ id: `astate.${slug}.width`, label: `${state} outline width`, type: 'number',
                      min: 1, max: 20, step: 1, default: d.width, unit: 'px' });
            out.push({ id: `astate.${slug}.dashed`, label: `${state} dashed`, type: 'boolean', default: d.dashed });
            out.push({ id: `astate.${slug}.fill`, label: `${state} show fill`, type: 'boolean', default: d.fill });
            out.push({ id: `astate.${slug}.fill-color`, label: `${state} fill color`, type: 'color', default: d.fillColor });
            out.push({ id: `astate.${slug}.opacity`, label: `${state} fill opacity`, type: 'number',
                      min: 0.05, max: 1, step: 0.05, default: d.opacity, unit: 'fill' });
        });
        return out;
    }

    // Equipment types (battery / v-well / h-well / sat / …) are the HEAD of
    // the subtype before " - ". They vary per site, so the show/hide
    // checkboxes are built dynamically: fetchAssetStates discovers the set on
    // the loaded site, stores it here, and re-registers with the Control Panel
    // so the panel renders one checkbox per type. Each entry: { name, slug }.
    let assetEquipTypes = [];
    // Builds the per-equipment-type "show" checkboxes appended to the Assets
    // category. Empty until a site's assets have loaded.
    function buildAssetEquipToggles() {
        if (!assetEquipTypes.length) return [];
        const out = [{ type: 'header', label: 'Show equipment types' }];
        assetEquipTypes.forEach(eq => {
            out.push({ id: `aeq.${eq.slug}.show`, label: `${eq.name} — show on map`, type: 'boolean', default: true });
        });
        return out;
    }

    const TOGGLES = [
        { id: 'master', label: 'Show all overlays', type: 'boolean', default: true, master: true },
        {
            type: 'category',
            id: 'fp-cat',
            label: 'Flight Path',
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
                { id: 'fp.show-vertices', label: 'Show flight-path vertex dots', type: 'boolean', default: false },
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
            id: 'ffz-cat',
            label: 'Free Fly Zone',
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
            label: 'Assets',
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
                ...buildAssetStateToggles(),
            ],
        },
        {
            type: 'category',
            id: 'altitude-cat',
            label: 'Altitude markers',
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
            label: 'Distribution lines',
            meta: '(yellow — KML)',
            master: { id: 'distro.show', default: true },
            children: [
                { id: 'distro.outline', label: 'Show outlines', type: 'boolean', default: true },
                { id: 'distro.color', label: 'Outline color', type: 'color', default: '#ffd700' },
                { id: 'distro.opacity', label: 'Outline opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.9, unit: 'fill' },
                { id: 'distro.thickness', label: 'Outline thickness', type: 'number',
                  min: 1, max: 12, step: 1, default: 3, unit: 'px' },
                { type: 'header', label: 'Edit mode' },
                { id: 'distro.edit-mode', label: 'Enable right-click actions', type: 'boolean', default: false },
                { id: 'distro.show-hidden', label: 'Show my hidden lines (dashed)', type: 'boolean', default: false },
                { id: 'distro.hidden-color', label: 'Hidden color', type: 'color', default: '#888888' },
                { id: 'distro-clear-hides', label: 'Clear all my local hides', type: 'button', action: 'clear-hides-distro' },
                { id: 'distro-unhide-file', label: 'Unhide all file-hidden lines', type: 'button', action: 'unhide-file-distro' },
                { type: 'header', label: 'Pending commits to GitHub' },
                { id: 'distro-add-new', label: 'Add new line (draw on map)', type: 'button', action: 'add-new-distro' },
                { id: 'distro-commit', label: 'Commit pending changes', type: 'button', action: 'commit-distro' },
                { id: 'distro-discard-commits', label: 'Discard pending commits', type: 'button', action: 'discard-commits-distro' },
                { type: 'header', label: 'KML data tools' },
                { id: 'distro-split', label: 'Split multi-segment lines (one-time)', type: 'button', action: 'split-distro' },
            ],
        },
        {
            type: 'category',
            id: 'trans-cat',
            label: 'Transmission lines',
            meta: '(red — KML · taller / more hazardous)',
            master: { id: 'trans.show', default: true },
            children: [
                { id: 'trans.outline', label: 'Show outlines', type: 'boolean', default: true },
                { id: 'trans.color', label: 'Outline color', type: 'color', default: '#ff3030' },
                { id: 'trans.opacity', label: 'Outline opacity', type: 'number',
                  min: 0.05, max: 1, step: 0.05, default: 0.9, unit: 'fill' },
                { id: 'trans.thickness', label: 'Outline thickness', type: 'number',
                  min: 1, max: 12, step: 1, default: 4, unit: 'px' },
                { type: 'header', label: 'Edit mode' },
                { id: 'trans.edit-mode', label: 'Enable right-click actions', type: 'boolean', default: false },
                { id: 'trans.show-hidden', label: 'Show my hidden lines (dashed)', type: 'boolean', default: false },
                { id: 'trans.hidden-color', label: 'Hidden color', type: 'color', default: '#888888' },
                { id: 'trans-clear-hides', label: 'Clear all my local hides', type: 'button', action: 'clear-hides-trans' },
                { id: 'trans-unhide-file', label: 'Unhide all file-hidden lines', type: 'button', action: 'unhide-file-trans' },
                { type: 'header', label: 'Pending commits to GitHub' },
                { id: 'trans-add-new', label: 'Add new line (draw on map)', type: 'button', action: 'add-new-trans' },
                { id: 'trans-commit', label: 'Commit pending changes', type: 'button', action: 'commit-trans' },
                { id: 'trans-discard-commits', label: 'Discard pending commits', type: 'button', action: 'discard-commits-trans' },
                { type: 'header', label: 'KML data tools' },
                { id: 'trans-split', label: 'Split multi-segment lines (one-time)', type: 'button', action: 'split-trans' },
            ],
        },
        {
            type: 'category',
            id: 'ortho-cat',
            label: 'Orthomosaic',
            meta: '(brightness)',
            master: { id: 'ortho.show', default: true },
            children: [
                { id: 'ortho.brightness', label: 'Brightness', type: 'number',
                  min: 0.2, max: 1.0, step: 0.05, default: 1.0, unit: '×' },
            ],
        },
        {
            type: 'category',
            id: 'validator-cat',
            label: 'Coverage Validator',
            meta: '(on-demand · 200ft FAA rule)',
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
            // Independent of the FFZ/FP Coverage Validator above: this one
            // tests ASSETS. An asset is "shielded" if its centroid sits
            // within (power-line radius + asset radius) of any power-line
            // KML — default 200 + 200 = 400 ft. Assets beyond that get a
            // high-contrast pin (color configurable) so we know which ones the
            // SS Generator must build FFZs on. Power-line KMLs are the only
            // shielding source.
            type: 'category',
            id: 'asset-validator-cat',
            label: 'Asset Shielding Check',
            meta: '(on-demand · finds Unshielded assets)',
            master: { id: 'asset-validator.show', default: true },
            children: [
                { id: 'asset-validator.powerline-radius', label: 'Power-line radius', type: 'number',
                  min: 0, max: 1000, step: 10, default: 200, unit: 'ft' },
                { id: 'asset-validator.asset-radius', label: 'Asset radius', type: 'number',
                  min: 0, max: 1000, step: 10, default: 200, unit: 'ft' },
                { id: 'asset-validator.pin-color', label: 'Pin / ring color', type: 'color', default: '#ff1493' },
                { id: 'asset-validator.skip-unshielded', label: 'Skip already-Unshielded assets', type: 'boolean', default: true },
                { id: 'asset-validator-run', label: 'Run asset check', type: 'button', action: 'run-asset-validator' },
                { id: 'asset-validator-clear', label: 'Clear asset pins', type: 'button', action: 'clear-asset-validator' },
                { id: 'asset-validator.show-dismissed', label: 'Show dismissed pins', type: 'boolean', default: false },
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
        { id: 'kick-styler', label: 'Kick styler (re-init when stuck)', default: 'Shift+K' },
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
    // v3 (Map Styler 34.29+): cache entries now carry the resolved
    // filename (e.g. "1596-distro.kml" vs "1596-Distro.kml" vs ".kmz")
    // so subsequent commits/splits hit the same file the fetch resolved.
    // v2 (34.21): features carry pmIdx + visible.
    // Bumping skips old cache entries; small refetch cost on first load.
    const KML_CACHE_PREFIX = 'aim-kml-cache-v3-';
    const KML_PENDING_PREFIX = 'aim-kml-pending-'; // suffixed with `${siteID}-${type}` — LOCAL HIDES ONLY, never commits
    const KML_COMMIT_OPS_PREFIX = 'aim-kml-commit-ops-'; // suffixed with `${siteID}-${type}` — commit-bound ops (delete/modify/add)
    const GITHUB_API_BASE = 'https://api.github.com';
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
    let warmupRunsRemaining = 0; // first-render watchdog counter (see attachObserverWhenReady)
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
    // kmlResolvedPath: { [`${siteID}|${type}`]: 'siteID-Type.kml' } — the
    // actual filename the multi-candidate fetcher resolved to. Used by
    // commit/split so writes target the same file that was read. Filled
    // from cache on load and from a successful 200 on fetch.
    const kmlResolvedPath = {};
    const KML_TYPES = ['distro', 'trans'];
    const kmlKey = (siteID, type) => `${siteID}|${type}`;
    // Asset-state cache for "Color assets by state". Holds the type-3 asset
    // polygons (lat/lng) + derived state for the CURRENT site only. Fetched
    // lazily from /map_objects (cookie auth) the first time runUpdate needs
    // it with by-state on; re-fetched when the site changes. polys[] entries:
    // { state, coords:[{lat,lng}...], cLat, cLng }.
    let assetStateData = { siteID: null, polys: [], loading: false, failed: false };
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
    // Asset Shielding Check shares validatorState.results (each entry tagged
    // kind:'gap' | 'asset') so it reuses the same persistence + pin-click +
    // render machinery, but keeps its own last-run summary for the console.
    let assetValidatorLastRun = null;
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

        // 3b. ASSET STATE — lazy-fetch entity data + tag each white asset
        // path with its state so the per-line loop can style it per-state.
        // Runs after the buffer wipe (above) and before the loop creates new
        // buffers, so querySelectorAll(WHITE_ASSET_SELECTOR) sees only native
        // asset paths, never our clones. We re-match every run (cheap: dozens
        // of paths × point-in-polygon) rather than tag once — runUpdate only
        // re-fires on zoom/pan/mutation, which is exactly when a path's `d`
        // could have been read mid-animation, so re-matching self-corrects any
        // stale projection. We only OVERWRITE a tag on a positive match, so a
        // transient (data still loading) never blanks an existing tag.
        //
        // We need entity data whenever Assets are shown — by-state coloring
        // uses it, the per-state/equipment hide filters use it, and we also
        // fetch once per site (even with nothing engaged) so the equipment
        // checkboxes can populate the panel. Fetch is cached + idempotent per
        // site, so calling it each run is cheap.
        const assetByStateOn = !!(toggleState['asset.show'] && toggleState['asset.by-state']);
        const assetDataWanted = !!toggleState['asset.show'];
        if (assetDataWanted) {
            const sid = getCurrentSiteID();
            const needFetch = sid && (assetStateData.siteID !== sid
                || (!assetStateData.loading && !assetStateData.polys.length && !assetStateData.failed));
            // Only the iframe fetches (it owns the map + the cookie-auth'd
            // same-origin context); it broadcasts the equipment set to TOP.
            if (needFetch && CONTEXT === 'IFRAME') fetchAssetStates(sid);
            const stMap = getLeafletMap();
            if (stMap && assetStateData.siteID === sid && assetStateData.polys.length) {
                document.querySelectorAll(WHITE_ASSET_SELECTOR).forEach(p => {
                    if (p.hasAttribute(CUSTOM_BUFFER_ATTR)) return; // never tag our own clones
                    const a = matchPathAsset(p, stMap);
                    if (a) {
                        if (a.state) p.setAttribute('data-aim-asset-state', a.state);
                        if (a.equip) p.setAttribute('data-aim-asset-equip', a.equip);
                    }
                });
            }
        }

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

            // Per-state asset styling. Non-null only for a white asset that
            // we've tagged with a state while "Color assets by state" is on.
            // When null, assets fall back to the uniform asset.* settings.
            const assetState = (assetByStateOn && isWhiteAsset)
                ? line.getAttribute('data-aim-asset-state') : null;
            const assetStyle = assetState ? assetStateStyle(assetState) : null;

            // --- Asset hide filter (per-state + per-equipment "show" boxes) ---
            // Independent of by-state coloring: an asset box (and its halo)
            // disappears when its STATE or its EQUIPMENT type is unchecked.
            // display is always reset to '' when not hiding — including when
            // the whole Assets category is off — so nothing stays stuck hidden.
            if (isWhiteAsset) {
                let hide = false;
                if (toggleState['asset.show']) {
                    const sTag = line.getAttribute('data-aim-asset-state');
                    const eTag = line.getAttribute('data-aim-asset-equip');
                    hide = (!!sTag && toggleState[`astate.${stateSlug(sTag)}.show`] === false)
                        || (!!eTag && toggleState[`aeq.${eTag}.show`] === false);
                }
                line.style.display = hide ? 'none' : '';
                if (hide) return; // skip styling + buffer creation for hidden assets
            }

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
                    if (assetStyle) {
                        // Per-state: state color + optional dashed outline.
                        // strokeOpacity left at full so the state color reads true.
                        line.style.stroke = assetStyle.color || '';
                        line.style.strokeOpacity = '';
                        line.style.strokeDasharray = assetStyle.dashed ? assetDash(assetStyle.width) : '';
                    } else {
                        line.style.stroke = toggleState['asset.line-color'] || '';
                        const op = Number(toggleState['asset.line-opacity']);
                        line.style.strokeOpacity = isNaN(op) ? '' : String(op);
                        line.style.strokeDasharray = '';
                    }
                } else {
                    line.style.stroke = '';
                    line.style.strokeOpacity = '';
                    line.style.strokeDasharray = '';
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
            if (assetStyle) {
                // Per-state width wins over the global force-thickness setting.
                if (currentAttrWidth !== String(assetStyle.width)) {
                    line.setAttribute('stroke-width', String(assetStyle.width));
                }
            } else if (wantForce) {
                if (currentAttrWidth !== String(lineThickness)) {
                    line.setAttribute('stroke-width', lineThickness);
                }
            } else if ((isBlueFlight || isSolidGreen || isWhiteAsset)
                       && !isNaN(originalWidth) && currentAttrWidth !== String(originalWidth)) {
                // Revert anything we previously forced (global thickness OR a
                // now-disabled per-state width) back to the native width.
                line.setAttribute('stroke-width', String(originalWidth));
            }

            // --- Asset fill override ---
            // Only acts when asset.show is on. If the category master is off,
            // we leave the host app's default fill alone (restore empty style).
            // When asset.fill is on, applies user-chosen fill color + opacity.
            if (isWhiteAsset) {
                if (toggleState['asset.show']) {
                    // Per-state fill when tagged; otherwise the uniform asset.* fill.
                    const fillOn = assetStyle ? assetStyle.fill : (toggleState['asset.fill'] !== false);
                    if (!fillOn) {
                        line.style.fillOpacity = '0';
                        line.style.fill = '';
                    } else {
                        line.style.fill = (assetStyle ? assetStyle.fillColor : toggleState['asset.fill-color']) || '';
                        const fo = assetStyle ? assetStyle.fillOpacity : Number(toggleState['asset.fill-opacity']);
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
                // Per-state assets tint their halo to the state color so the
                // buffer reads as the same category at a glance.
                bufferStroke = assetStyle ? (assetStyle.color || '#ffffff') : (toggleState['asset.color'] || '#ffffff');
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
        // 11b. Full ortho hide — remove COG layers to kill their tile storm.
        applyOrthoVisibility();
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
    let perfHideSatellite = false;     // mirrors AIM Perf Shield toggle state
    // Ortho low-res lives in Perf Shield (v1.7+) — moved there for
    // discoverability since it's a performance lever, not a style choice.
    // Map Styler still implements the actual cap (it owns the ortho tile
    // layer) but reads the user preference from these locals, which Perf
    // Shield drives via PERF_TOGGLE messages on AIM_CONTROL_CHANNEL.
    let perfOrthoLowRes = false;
    let perfOrthoLowResZoom = 15;
    // Full ortho hide (v34.78). Distinct from low-res: this REMOVES the
    // orthomosaic COG layers from the map entirely so their tiles stop
    // being fetched. On sites that stack dozens of COG ortho layers (e.g.
    // 1153 — ~50 layers), that tile storm is the real cause of the freeze
    // when a heavy mission opens and zooms in. Driven by Perf Shield's
    // "Hide orthomosaic imagery" toggle (PERF_TOGGLE key 'hide-ortho').
    let perfHideOrtho = false;
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
        /user_tile_\d+/i,           // Percepto site-ortho identifier (cloudfront COG)
        /cog\/tiles\/.*\.tif/i,     // generic COG tile-server URL with .tif source
        // DroneDeploy-hosted orthomosaics — on many sites these are the
        // BULK of the ortho layers (e.g. 1153 stacks ~40 of them) and the
        // patterns above miss them entirely (no user_tile / no .tif). Path
        // always carries `/orthomosaic/`, so target that to stay precise
        // and avoid catching any non-ortho dronedeploy layer.
        /dronedeploy\.com\/.*\/orthomosaic\//i,
    ];
    const _seenOrthoUrls = new Set();
    function applyOrthoSettings() {
        const masterOn = toggleState['ortho.show'] !== false;
        if (!masterOn) { restoreOrthoSettings(); return; }
        const brightness = Number(toggleState['ortho.brightness']);
        // Low-res cap is driven by Perf Shield (see perfOrthoLowRes decl).
        const lowRes = perfOrthoLowRes === true;
        const maxZoom = Number(perfOrthoLowResZoom) || 15;
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

    // Full ortho hide: remove the orthomosaic COG layers from the map so
    // Leaflet stops fetching their tiles altogether. We can't use
    // display:none — the browser still fetches <img> tiles inside a hidden
    // container, so the network storm (the actual freeze on COG-heavy
    // sites) would continue. removeLayer is the only thing that truly
    // stops it. We stash the removed layer refs so toggling the option
    // back off re-adds them (no page reload needed). The heartbeat re-runs
    // this so any ortho layer Percepto adds later (e.g. on nav) also gets
    // removed while the toggle is on.
    const _aimRemovedOrtho = new Set();
    function applyOrthoVisibility() {
        const map = getLeafletMap();
        if (!map || typeof map.eachLayer !== 'function') return;
        try {
            if (perfHideOrtho) {
                // Collect first, then remove — never mutate during eachLayer.
                const toRemove = [];
                map.eachLayer(layer => {
                    if (!layer || !layer._url || typeof layer._url !== 'string') return;
                    if (_ORTHO_URL_PATTERNS.some(p => p.test(layer._url))) toRemove.push(layer);
                });
                toRemove.forEach(layer => {
                    try { map.removeLayer(layer); _aimRemovedOrtho.add(layer); } catch (e) {}
                });
                if (toRemove.length) {
                    console.log(`${TAG} hide-ortho: removed ${toRemove.length} ortho layer(s) — tile fetches stopped (${_aimRemovedOrtho.size} stashed)`);
                }
            } else if (_aimRemovedOrtho.size) {
                restoreOrthoVisibility();
            }
        } catch (e) {
            console.warn(`${TAG} applyOrthoVisibility failed:`, e);
        }
    }

    // Re-add every ortho layer we removed. Called when the user turns the
    // hide off, and from cleanup() so deactivating the styler never strands
    // the user with missing imagery they can't get back without a reload.
    function restoreOrthoVisibility() {
        const map = getLeafletMap();
        if (!map) { _aimRemovedOrtho.clear(); return; }
        let restored = 0;
        _aimRemovedOrtho.forEach(layer => {
            try {
                if (typeof map.hasLayer === 'function' && map.hasLayer(layer)) return; // already back
                map.addLayer(layer);
                restored++;
            } catch (e) {}
        });
        _aimRemovedOrtho.clear();
        if (restored) console.log(`${TAG} hide-ortho OFF: restored ${restored} ortho layer(s)`);
    }

    // Apply the three Map-performance levers (satellite hide, ortho low-res,
    // ortho hide) WITHOUT requiring the styler master to be active. Each
    // underlying function is idempotent and reads live perf flags + handles
    // its own restore branch, so it's safe to call from here AND from
    // runUpdate. This is what lets the perf toggles work when Outlines is off.
    function applyPerfMapSettings() {
        try { applyMapBackgroundVisibility(); } catch (e) {}
        try { applyOrthoSettings(); } catch (e) {}
        try { applyOrthoVisibility(); } catch (e) {}
    }

    // Independent keep-alive: while any Map-performance lever is ON and the
    // styler is NOT active (so runUpdate's heartbeat isn't running), re-apply
    // on a slow tick. Catches ortho/satellite layers Percepto adds later (on
    // pan / mission open / nav) and re-suppresses any it re-adds. When the
    // styler IS active, runUpdate already does this every heartbeat, so we
    // skip to avoid doubling the work.
    setInterval(() => {
        try {
            if (!isActive && (perfHideOrtho || perfHideSatellite || perfOrthoLowRes)) {
                applyPerfMapSettings();
            }
        } catch (e) {}
    }, 1500);

    // Debug hook (v34.80): read this instance's live perf state + force-apply
    // from the console. Exposed on unsafeWindow so it's reachable cross-frame:
    //   document.querySelector('iframe').contentWindow.__aim_styler_debug()
    //   document.querySelector('iframe').contentWindow.__aim_styler_applyPerf()
    try {
        const _g = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
        _g.__aim_styler_debug = function () {
            const map = getLeafletMap();
            let orthoOnMap = 0, satOnMap = 0;
            if (map && typeof map.eachLayer === 'function') map.eachLayer(l => {
                if (l && l._url) {
                    if (_ORTHO_URL_PATTERNS.some(p => p.test(l._url))) orthoOnMap++;
                    if (_SAT_URL_PATTERNS.some(p => p.test(l._url))) satOnMap++;
                }
            });
            return { frame: FRAME_ID, version: SCRIPT_VERSION, isActive,
                perfHideOrtho, perfHideSatellite, perfOrthoLowRes,
                mapFound: !!map, orthoOnMap, satOnMap, removedStash: _aimRemovedOrtho.size };
        };
        _g.__aim_styler_applyPerf = function () { applyPerfMapSettings(); return _g.__aim_styler_debug(); };
    } catch (e) {}

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
        const verts = document.querySelectorAll('.map-marker__flight-path-vertex');
        if (!masterOn) {
            el.textContent = '';
            // Restore any inline display we forced
            verts.forEach(d => d.style.removeProperty('display'));
            return;
        }

        // Note: previous versions auto-showed vertices when EDIT_MODE_SELECTOR
        // matched anything. That selector is too broad — it picks up the
        // always-present native FFZ + FP dashed outlines (every site has
        // dozens), so `inEditMode` evaluated true permanently and dots were
        // never hidden. Until we identify a tighter "is the user editing
        // RIGHT NOW" signal, the toggle is the sole control: ON = always
        // show, OFF = always hide (except red/error variants).
        const show = toggleState['fp.show-vertices'] === true;

        const color = toggleState['fp.vertex-color'] || '#1ca0de';
        const sizeRaw = Number(toggleState['fp.vertex-size']);
        const size = isNaN(sizeRaw) ? 10 : sizeRaw;
        const margin = size / 2;

        if (show) {
            // Render all vertex dots at the user's color + size. Class-selector
            // CSS is enough here because we're not trying to override anything
            // critical — Percepto's defaults give visible dots, we just tweak
            // size/color on top.
            el.textContent = `
                .map-marker__flight-path-vertex {
                    width: ${size}px !important;
                    height: ${size}px !important;
                    margin-left: -${margin}px !important;
                    margin-top: -${margin}px !important;
                    background-color: ${color} !important;
                }
            `;
            verts.forEach(d => d.style.removeProperty('display'));
        } else {
            // HIDE PATH — bulletproof. Class-selector CSS was losing the
            // specificity/source-order battle against Percepto's own rules
            // (computed `display: flex` was sticking despite our class CSS
            // having !important). Switch to per-element inline `display: none`
            // with !important priority. Inline style beats any class selector,
            // period. Keeps red/disconnect/error variants visible via the
            // attribute-substring check on className.
            el.textContent = ''; // class-selector CSS no longer needed for hide
            verts.forEach(d => {
                const cls = (typeof d.className === 'string') ? d.className
                    : (d.className && d.className.baseVal) || '';
                if (/disconnect|error|invalid|warning/i.test(cls)) {
                    // Always-visible variant — make sure no forced hide lingers.
                    d.style.removeProperty('display');
                } else {
                    d.style.setProperty('display', 'none', 'important');
                }
            });
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

    // ============================================================
    // ASSET STATE — fetch /map_objects, classify, geometry-match
    // ============================================================

    // Title-case an unknown modifier so it reads cleanly in logs.
    function prettyState(s) {
        s = String(s || '').trim();
        if (!s) return '';
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // Ray-casting point-in-polygon on lat/lng. Ported from the Asset
    // Inspector's hit-test — same algorithm so matches agree across scripts.
    function pointInPolygon(lat, lng, poly) {
        if (!poly || poly.length < 3) return false;
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].lng, yi = poly[i].lat;
            const xj = poly[j].lng, yj = poly[j].lat;
            const intersect = ((yi > lat) !== (yj > lat))
                && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // Derive a single state for a type-3 asset. Precedence is safety-first so
    // a glance surfaces the worst problem: Unreachable > Unshielded > Empty >
    // Inactive > HY > Normal. State text lives in custom.poi_type_str as
    // " - "-separated modifiers ("battery - empty"); is_unshielded is also an
    // independent boolean flag, honored even when the subtype omits it.
    function classifyAssetState(e) {
        const sub = (e && e.custom && e.custom.poi_type_str) ? String(e.custom.poi_type_str) : '';
        const mods = sub.split(' - ').slice(1).map(s => s.trim().toLowerCase()).filter(Boolean);
        const has = (k) => mods.indexOf(k) !== -1;
        if (has('unreachable')) return 'Unreachable';
        if ((e && e.is_unshielded) || has('unshielded')) return 'Unshielded';
        if (has('empty')) return 'Empty';
        if (has('inactive')) return 'Inactive';
        if (has('hy')) return 'HY';
        if (mods.length) return prettyState(mods[0]); // unknown modifier — best effort
        return 'Normal';
    }

    // Equipment type = the HEAD of the subtype before " - " (e.g.
    // "battery - empty" → "battery", "v-well" → "v-well"). Hyphens inside the
    // equipment name are preserved because we split on " - " (space-dash-space)
    // only. Assets with no subtype bucket as "Other". Returns { name, slug }.
    function classifyAssetEquipment(e) {
        const sub = (e && e.custom && e.custom.poi_type_str) ? String(e.custom.poi_type_str) : '';
        const head = sub.split(' - ')[0].trim();
        const name = head ? prettyState(head) : 'Other';
        return { name, slug: stateSlug(name) };
    }

    // Resolve the effective style for a state from the per-state toggles,
    // falling back to ASSET_STATE_DEFAULTS (or the gray fallback for states
    // with no Control Panel row, e.g. midstream taxonomies).
    function assetStateStyle(state) {
        const slug = stateSlug(state);
        const def = ASSET_STATE_DEFAULTS[state] || ASSET_STATE_FALLBACK;
        const get = (suffix, d) => {
            const v = toggleState[`astate.${slug}.${suffix}`];
            return v === undefined ? d : v;
        };
        const w = Number(get('width', def.width));
        const fo = Number(get('opacity', def.opacity));
        return {
            color: get('color', def.color),
            width: isNaN(w) ? def.width : w,
            dashed: !!get('dashed', def.dashed),
            fill: get('fill', def.fill) !== false,
            fillColor: get('fill-color', def.fillColor),
            fillOpacity: isNaN(fo) ? def.opacity : fo,
        };
    }

    // SVG dash pattern scaled to the line width so it reads at any thickness.
    function assetDash(width) {
        const w = Number(width) || 10;
        return `${Math.max(6, w * 1.4).toFixed(1)},${Math.max(4, w * 1.0).toFixed(1)}`;
    }

    // Fetch the current site's type-3 assets (cookie auth, no PAT). Self-
    // contained — does not depend on the Asset Inspector being installed.
    // Stores polygons + derived state in assetStateData, clears stale path
    // tags, and re-renders when done. Idempotent per site while in flight.
    function fetchAssetStates(siteID, force) {
        if (!siteID) return;
        if (!force && assetStateData.siteID === siteID
            && (assetStateData.loading || assetStateData.polys.length || assetStateData.failed)) return;
        assetStateData = { siteID, polys: [], loading: true, failed: false };
        // New data incoming — drop existing tags so paths re-match.
        try {
            document.querySelectorAll('[data-aim-asset-state],[data-aim-asset-equip]')
                .forEach(p => { p.removeAttribute('data-aim-asset-state'); p.removeAttribute('data-aim-asset-equip'); });
        } catch (e) {}
        fetch(MAP_OBJECTS_URL + encodeURIComponent(siteID), { credentials: 'include' })
            .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
            .then(data => {
                const list = Array.isArray(data) ? data : ((data && data.results) || []);
                const polys = [];
                const equipByName = new Map(); // name → slug, de-duped + ordered by count
                const equipCount = {};
                list.forEach(e => {
                    if (!e || e.type !== 3) return;
                    const raw = Array.isArray(e.coords) ? e.coords
                              : (Array.isArray(e.points) ? e.points : []);
                    const pts = raw.filter(c => c && typeof c.lat === 'number' && typeof c.lng === 'number');
                    if (pts.length < 3) return;
                    let sLat = 0, sLng = 0;
                    pts.forEach(p => { sLat += p.lat; sLng += p.lng; });
                    const eq = classifyAssetEquipment(e);
                    equipByName.set(eq.name, eq.slug);
                    equipCount[eq.name] = (equipCount[eq.name] || 0) + 1;
                    polys.push({
                        state: classifyAssetState(e),
                        equip: eq.slug,
                        coords: pts,
                        cLat: sLat / pts.length,
                        cLng: sLng / pts.length,
                    });
                });
                // Ignore a stale response if the user navigated away mid-flight.
                if (getCurrentSiteID() !== siteID) {
                    assetStateData = { siteID: null, polys: [], loading: false, failed: false };
                    return;
                }
                assetStateData = { siteID, polys, loading: false, failed: false };
                // Publish the discovered equipment set (most-common first) and
                // re-register so the panel shows a checkbox per type. Seed
                // toggleState so hiding works before the panel echoes values.
                const newEquip = [...equipByName.keys()]
                    .sort((a, b) => (equipCount[b] - equipCount[a]) || a.localeCompare(b))
                    .map(name => ({ name, slug: equipByName.get(name) }));
                const sig = newEquip.map(e => e.slug).join('|');
                const prevSig = assetEquipTypes.map(e => e.slug).join('|');
                if (sig !== prevSig) {
                    assetEquipTypes = newEquip;
                    newEquip.forEach(e => {
                        const k = `aeq.${e.slug}.show`;
                        if (toggleState[k] === undefined) toggleState[k] = true;
                    });
                    registerWithControlPanel(); // pushes the new schema to the panel
                }
                console.log(`${TAG} asset-state: loaded ${polys.length} asset polygons for site ${siteID} (${newEquip.length} equipment types)`);
                if (isActive) runUpdate();
            })
            .catch(err => {
                assetStateData = { siteID, polys: [], loading: false, failed: true };
                console.warn(`${TAG} asset-state: fetch failed for site ${siteID}:`, err);
            });
    }

    // Layer-point centroid of an SVG asset path → lat/lng. Leaflet draws path
    // `d` coordinates in the overlay pane's layer-point space, so we average
    // the vertices and convert back with the live map. Returns null on a path
    // we can't parse or before the map is ready.
    function pathCentroidLatLng(path, map) {
        const d = path.getAttribute('d') || '';
        const nums = d.match(/-?\d+(?:\.\d+)?/g);
        if (!nums || nums.length < 4) return null;
        let sx = 0, sy = 0, n = 0;
        for (let i = 0; i + 1 < nums.length; i += 2) {
            const x = parseFloat(nums[i]), y = parseFloat(nums[i + 1]);
            if (isNaN(x) || isNaN(y)) continue;
            sx += x; sy += y; n++;
        }
        if (!n) return null;
        try { return map.layerPointToLatLng({ x: sx / n, y: sy / n }); }
        catch (e) { return null; }
    }

    // Match a white asset path to its asset: containment first, then nearest-
    // centroid (covers self-intersecting "bowtie" assets where ray-casting on
    // the raw polygon can miss). Returns { state, equip } or null if nothing
    // loaded / unparseable.
    function matchPathAsset(path, map) {
        const polys = assetStateData.polys;
        if (!polys.length) return null;
        const ll = pathCentroidLatLng(path, map);
        if (!ll) return null;
        for (let i = 0; i < polys.length; i++) {
            if (pointInPolygon(ll.lat, ll.lng, polys[i].coords)) return polys[i];
        }
        let best = null, bestD = Infinity;
        for (let i = 0; i < polys.length; i++) {
            const dLat = polys[i].cLat - ll.lat, dLng = polys[i].cLng - ll.lng;
            const dd = dLat * dLat + dLng * dLng;
            if (dd < bestD) { bestD = dd; best = polys[i]; }
        }
        return best || null;
    }

    // The registration schema = static TOGGLES with the dynamically-discovered
    // equipment checkboxes spliced into the Assets category. Posted to the
    // Control Panel on every register; the panel only re-renders when the
    // equipment set actually changes (it signatures the payload).
    function buildRegistrationToggles() {
        const extra = buildAssetEquipToggles();
        if (!extra.length) return TOGGLES;
        return TOGGLES.map(cat => (cat && cat.id === 'asset-cat')
            ? { ...cat, children: [...cat.children, ...extra] }
            : cat);
    }

    // True if the user has unchecked any state or equipment "show" box — i.e.
    // an asset hide filter is engaged. Drives whether we need entity data even
    // when by-state coloring is off.
    function anyAssetHidden() {
        for (const k in toggleState) {
            if (toggleState[k] !== false) continue;
            if ((k.indexOf('astate.') === 0 || k.indexOf('aeq.') === 0) && k.endsWith('.show')) return true;
        }
        return false;
    }

    // Adopt an equipment set broadcast by the map iframe (cross-frame sync so
    // every frame registers an identical schema). No-op if it's for a
    // different site or matches what we already have.
    function applyEquipFromBroadcast(d) {
        if (!d || d.siteID !== getCurrentSiteID()) return;
        const equip = Array.isArray(d.equip) ? d.equip : [];
        const sig = equip.map(e => e.slug).join('|');
        const prevSig = assetEquipTypes.map(e => e.slug).join('|');
        if (sig === prevSig) return;
        assetEquipTypes = equip;
        equip.forEach(e => { const k = `aeq.${e.slug}.show`; if (toggleState[k] === undefined) toggleState[k] = true; });
        registerWithControlPanel();
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
            // Patch MULTIPLE prototype methods so we capture the map reference
            // for already-created maps too — not just freshly-constructed ones.
            // Diagnosed 2026-05-20: in stuck-state recovery, Percepto's map was
            // already initialized before our `initialize` patch took effect, and
            // the map instance was unreachable from the DOM (likely held in a
            // WeakMap / closure). Hooking commonly-called methods like
            // `getPane`, `addLayer`, `invalidateSize` etc. means the next time
            // Percepto does ANY map operation, we capture `this` and stash it
            // on the container as `__aim_map__`.
            const methodsToHook = ['initialize', 'getPane', 'addLayer', 'invalidateSize', 'setView', 'panTo', '_animateZoom'];
            methodsToHook.forEach(method => {
                if (typeof L.Map.prototype[method] !== 'function') return;
                const orig = L.Map.prototype[method];
                L.Map.prototype[method] = function(...args) {
                    try {
                        if (this && this._container && !this._container.__aim_map__) {
                            this._container.__aim_map__ = this;
                        }
                    } catch (e) {}
                    return orig.apply(this, args);
                };
            });
            leafletPatched = true;
            console.log(`${TAG} patched L.Map prototype methods (${methodsToHook.length} hooks)`);
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
            // Enumerable property iteration (covers most cases)
            for (const k in container) {
                try {
                    const v = container[k];
                    if (looksLikeLeafletMap(v)) {
                        console.log(`${TAG} captured Leaflet map via container.${k}`);
                        leafletMapRef = v; return v;
                    }
                } catch (e) {}
            }
            // Non-enumerable property iteration (fallback — diagnosed
            // 2026-05-20 stuck state had no enumerable map-like prop)
            try {
                for (const k of Object.getOwnPropertyNames(container)) {
                    try {
                        const v = container[k];
                        if (looksLikeLeafletMap(v)) {
                            console.log(`${TAG} captured Leaflet map via non-enumerable container.${k}`);
                            leafletMapRef = v; return v;
                        }
                    } catch (e) {}
                }
            } catch (e) {}
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
        // v34.53: removed the CDN_FRESHNESS_WINDOW_MS skip — no longer
        // needed now that we fetch via api.github.com (always fresh,
        // not cached at the GitHub CDN). Always do the network fetch
        // so coworkers' changes propagate as soon as they happen.
        if (!kmlFeatures[key]) {
            const cached = gmGet(KML_CACHE_PREFIX + key, null);
            if (cached && Array.isArray(cached.features)) {
                kmlFeatures[key] = cached.features;
                if (cached.path) kmlResolvedPath[key] = cached.path;
                console.log(`${TAG} KML ${key} loaded from cache (${cached.features.length} features, path: ${cached.path || '?'})`);
            }
        }

        // In-memory cache from TOKEN_VALUE broadcast, falling back to our own
        // GM storage (per-script — only useful if we wrote it ourselves).
        const token = cachedToken || gmGet(TOKEN_KEY, '');
        if (!token) {
            if (!warnedNoToken) {
                warnedNoToken = true;
                console.warn(`${TAG} no GitHub token cached yet — waiting for TOKEN_VALUE from control panel (will auto-retry when it arrives)`);
                if (controlChannel) controlChannel.postMessage({ type: 'REQUEST_TOKEN' });
            }
            return;
        }
        warnedNoToken = false;
        if (typeof GM_xmlhttpRequest !== 'function') {
            console.warn(`${TAG} GM_xmlhttpRequest unavailable — script grants may need re-approval after update`);
            return;
        }

        kmlFetching.add(key);

        // Multi-candidate filename fallback. GitHub raw URLs are case-
        // sensitive and we accept either .kml or .kmz. Try lowercase first
        // (matches the 1595/1597 convention) and capitalize-first as a
        // forgiveness layer; .kml before .kmz since plain XML is cheaper
        // than unzipping. First successful 200 wins; resolved filename is
        // tracked in kmlResolvedPath[key] so commits/splits hit the same
        // file the fetch resolved.
        const cap = type.charAt(0).toUpperCase() + type.slice(1);
        const candidates = [
            { name: `${siteID}-${type}.kml`, ext: 'kml' },
            { name: `${siteID}-${cap}.kml`, ext: 'kml' },
            { name: `${siteID}-${type}.kmz`, ext: 'kmz' },
            { name: `${siteID}-${cap}.kmz`, ext: 'kmz' },
        ];

        // v34.53: fetch via api.github.com Contents endpoint instead of
        // raw.githubusercontent.com. The raw CDN has a ~5min cache that
        // ignored cache-buster query strings, causing stale content to
        // overwrite local cache after a commit. api.github.com returns
        // fresh content every time. Rate limit: 5000/hr per PAT —
        // realistic team usage is ~200-300/day, no concern.
        //
        // Response is JSON: { content: base64string, encoding: 'base64',
        // sha, size, ... }. We decode .content to get the raw bytes,
        // then either parse XML (for .kml) or feed to JSZip (for .kmz).
        const tryFetch = (i) => {
            if (i >= candidates.length) {
                kmlFetching.delete(key);
                kmlMissing.add(key);
                console.log(`${TAG} no ${type} KML for site ${siteID} — none of: ${candidates.map(c => c.name).join(', ')}`);
                return;
            }
            const c = candidates[i];
            const url = `${GITHUB_API_BASE}/repos/${KMLS_REPO}/contents/${encodeURIComponent(c.name)}?ref=${KMLS_BRANCH}`;
            const opts = {
                method: 'GET',
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                },
                timeout: 15000,
                onload: (resp) => {
                    if (resp.status === 200) {
                        let json;
                        try { json = JSON.parse(resp.responseText); }
                        catch (e) {
                            kmlFetching.delete(key);
                            console.error(`${TAG} ${type} KML parse-JSON failed for ${c.name}:`, e);
                            return;
                        }
                        const b64 = (json && json.content) ? String(json.content).replace(/\s/g, '') : '';
                        if (!b64) {
                            kmlFetching.delete(key);
                            console.warn(`${TAG} ${type} KML response missing .content for ${c.name}`);
                            return;
                        }
                        kmlResolvedPath[key] = c.name;
                        if (c.ext === 'kmz') {
                            // Decode base64 → ArrayBuffer for JSZip.
                            let bin;
                            try { bin = atob(b64); }
                            catch (e) {
                                kmlFetching.delete(key);
                                console.error(`${TAG} KMZ atob failed for ${c.name}:`, e);
                                return;
                            }
                            const buf = new Uint8Array(bin.length);
                            for (let j = 0; j < bin.length; j++) buf[j] = bin.charCodeAt(j);
                            parseKMZAndStore(buf.buffer, key, siteID, type, c.name);
                        } else {
                            kmlFetching.delete(key);
                            let xmlText;
                            try {
                                // Decode base64 → UTF-8 text. atob gives a binary
                                // string; TextDecoder converts to proper UTF-8.
                                const bin = atob(b64);
                                const buf = new Uint8Array(bin.length);
                                for (let j = 0; j < bin.length; j++) buf[j] = bin.charCodeAt(j);
                                xmlText = new TextDecoder('utf-8').decode(buf);
                            } catch (e) {
                                console.error(`${TAG} KML atob/decode failed for ${c.name}:`, e);
                                return;
                            }
                            try {
                                const features = parseKML(xmlText);
                                kmlFeatures[key] = features;
                                gmSet(KML_CACHE_PREFIX + key, { features, at: Date.now(), path: c.name });
                                console.log(`${TAG} ${type} KML for site ${siteID} loaded (${features.length} features, source: ${c.name})`);
                                // v34.54: drop any stale commitOps entries from GM
                                // storage whose pmIdx no longer references a real
                                // line. Prevents the next commit from silently
                                // no-op'ing on a stale mark from a previous session.
                                const pruned = pruneStaleOps(siteID, type);
                                if (pruned.dropped > 0) {
                                    showKMLToast(`Dropped ${pruned.dropped} stale pending ${type} mark${pruned.dropped === 1 ? '' : 's'} on load (line${pruned.dropped === 1 ? '' : 's'} no longer exist${pruned.dropped === 1 ? 's' : ''}).`, 6000);
                                }
                                if (isActive) runUpdate();
                            } catch (e) {
                                console.error(`${TAG} KML parse failed for ${key}:`, e);
                            }
                        }
                    } else if (resp.status === 404) {
                        // Quiet on intermediate 404s; only log the final one.
                        tryFetch(i + 1);
                    } else if (resp.status === 401 || resp.status === 403) {
                        kmlFetching.delete(key);
                        console.warn(`${TAG} ${type} KML fetch denied (${resp.status}) — check your PAT in AIM Controls`);
                    } else {
                        kmlFetching.delete(key);
                        console.warn(`${TAG} ${type} KML fetch HTTP ${resp.status} (candidate ${c.name})`);
                    }
                },
                onerror: () => {
                    kmlFetching.delete(key);
                    console.warn(`${TAG} ${type} KML fetch network error (candidate ${c.name})`);
                },
                ontimeout: () => {
                    kmlFetching.delete(key);
                    console.warn(`${TAG} ${type} KML fetch timed out (candidate ${c.name})`);
                },
            };
            console.log(`${TAG} fetching ${type} KML for site ${siteID} — trying ${c.name} via api.github.com`);
            try {
                GM_xmlhttpRequest(opts);
            } catch (e) {
                kmlFetching.delete(key);
                console.error(`${TAG} ${type} KML fetch threw on ${c.name}:`, e);
            }
        };

        tryFetch(0);
    }

    // Parses an in-memory KMZ ArrayBuffer (ZIP containing .kml + optional
    // resource files) using JSZip. Picks doc.kml when present, else the
    // first .kml entry. Result flows through parseKML() like a plain
    // .kml fetch.
    function parseKMZAndStore(arrayBuffer, key, siteID, type, sourceName) {
        const Z = (typeof JSZip !== 'undefined') ? JSZip
            : (typeof unsafeWindow !== 'undefined' && unsafeWindow.JSZip) ? unsafeWindow.JSZip
            : (typeof window !== 'undefined' && window.JSZip) ? window.JSZip
            : null;
        if (!Z) {
            kmlFetching.delete(key);
            console.error(`${TAG} JSZip not loaded — cannot parse KMZ ${sourceName}. Reload the page; if the issue persists, check Tampermonkey grants on this script.`);
            return;
        }
        Z.loadAsync(arrayBuffer).then(zip => {
            const kmlEntries = Object.values(zip.files).filter(f => /\.kml$/i.test(f.name) && !f.dir);
            if (!kmlEntries.length) {
                throw new Error('KMZ contains no .kml file');
            }
            const doc = kmlEntries.find(f => /(^|\/)doc\.kml$/i.test(f.name)) || kmlEntries[0];
            return doc.async('string').then(text => {
                const features = parseKML(text);
                kmlFeatures[key] = features;
                gmSet(KML_CACHE_PREFIX + key, { features, at: Date.now(), path: sourceName });
                console.log(`${TAG} ${type} KMZ for site ${siteID} loaded (${features.length} features, source: ${sourceName}, entry: ${doc.name})`);
                kmlFetching.delete(key);
                if (isActive) runUpdate();
            });
        }).catch(e => {
            kmlFetching.delete(key);
            console.error(`${TAG} KMZ unzip/parse failed for ${sourceName}:`, e);
        });
    }

    // KML parser. Walks every <Placemark> and extracts either a LineString
    // or a Polygon (outerBoundaryIs/LinearRing). Coordinates are KML-format
    // "lng,lat[,alt] lng,lat[,alt] …" — note lng comes first.
    //
    // Each feature carries `pmIdx` (the placemark's 0-based position in the
    // file) and `visible` (from <visibility>, KML defaults to 1). These let
    // E1 hide/show actions reference the right placemark when committing
    // back to GitHub. A single placemark with MultiGeometry can produce
    // multiple features that share the same pmIdx — hide acts on ALL of
    // them, which is the intended behavior.
    //
    // Returns: [{ type: 'line'|'polygon', coords: [{lat, lng}, ...], pmIdx, visible }, ...]
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
        const placemarks = doc.querySelectorAll('Placemark');
        placemarks.forEach((pm, pmIdx) => {
            // KML spec: <visibility> default is 1. Only "0" hides.
            // :scope avoids matching nested <visibility> inside a Style.
            let visible = true;
            const visEl = pm.querySelector(':scope > visibility');
            if (visEl && visEl.textContent.trim() === '0') visible = false;
            pm.querySelectorAll('LineString > coordinates').forEach(c => {
                const coords = parseCoords(c.textContent);
                if (coords.length >= 2) out.push({ type: 'line', coords, pmIdx, visible });
            });
            pm.querySelectorAll('Polygon > outerBoundaryIs > LinearRing > coordinates').forEach(c => {
                const coords = parseCoords(c.textContent);
                if (coords.length >= 3) out.push({ type: 'polygon', coords, pmIdx, visible });
            });
        });
        return out;
    }

    // ============================================================
    // KML EDITING (E1 — hide/show)
    //
    // Pending changes are persisted per-site, per-type in GM storage so a
    // refresh doesn't lose mid-session edits. Format: object keyed by
    // placemark index, value is the DESIRED final visibility (boolean).
    // An entry only exists when desired ≠ file state — if the user toggles
    // a line back to its file state, the entry is deleted, NOT set to its
    // current visibility.
    //
    //   { "5": false, "12": true }
    //     ^ placemark 5 should end up hidden in the committed file
    //                      ^ placemark 12 should end up visible
    //
    // Commit flow (per type):
    //   1. GET /repos/.../contents/<siteID>-<type>.kml via Contents API
    //      — returns content (base64) + sha
    //   2. Parse XML, walk placemarks, apply each pending entry
    //      (insert <visibility>0/1</visibility> as child of Placemark)
    //   3. PUT with { message, content (base64), sha }
    //      — GitHub returns 409 if sha is stale (someone else pushed first)
    //   4. On 200: clear pending for that type + force-refetch
    //   5. On 409: leave pending intact, warn user
    // ============================================================

    function pendingKey(siteID, type) {
        return `${KML_PENDING_PREFIX}${siteID}-${type}`;
    }

    function getPending(siteID, type) {
        if (!siteID) return {};
        const v = gmGet(pendingKey(siteID, type), null);
        return (v && typeof v === 'object') ? v : {};
    }

    function setPending(siteID, type, obj) {
        if (!siteID) return;
        gmSet(pendingKey(siteID, type), obj || {});
    }

    function pendingCount(siteID, type) {
        return Object.keys(getPending(siteID, type)).length;
    }

    // Combine the file's stored visibility with any pending override. Used
    // by the renderer to decide visible vs ghost-render vs skip, and by the
    // right-click menu to know which action label to show ("Hide" vs "Unhide").
    function effectiveVisible(siteID, type, pmIdx, fileVisible) {
        const p = getPending(siteID, type);
        const key = String(pmIdx);
        return Object.prototype.hasOwnProperty.call(p, key) ? !!p[key] : !!fileVisible;
    }

    // User chose Hide/Unhide on a placemark. Update pending so the desired
    // state matches what the user just asked for; clear the pending entry
    // if that state matches the file's stored visibility (no-op edit).
    function setDesiredVisibility(siteID, type, pmIdx, fileVisible, desiredVisible) {
        const p = getPending(siteID, type);
        const key = String(pmIdx);
        if (!!desiredVisible === !!fileVisible) {
            delete p[key];
        } else {
            p[key] = !!desiredVisible;
        }
        setPending(siteID, type, p);
    }

    // "Clear all my hides for this site" button handler. Resets local
    // pending state for one category to empty + re-renders so any
    // hidden lines come back. Local-only — no GitHub roundtrip.
    function clearLocalHides(type) {
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded.', 3000); return; }
        const before = pendingCount(siteID, type);
        if (before === 0) {
            showKMLToast(`No local ${type} hides to clear.`, 2500);
            return;
        }
        setPending(siteID, type, {});
        showKMLToast(`Cleared ${before} local ${type} hide${before === 1 ? '' : 's'}.`, 3500);
        if (isActive) runUpdate();
    }

    // "Unhide all file-hidden lines" — durable workaround for broken KML
    // exports (e.g. site 1598-distro.kml shipped with <visibility>0</>
    // on every placemark, a Google Earth export artifact). Walks the
    // parsed features for one category, finds every placemark with
    // file-visibility=false, sets a pending override = true so they
    // render. Local-only (no GitHub roundtrip) — matches the existing
    // hide/show pattern. Idempotent: re-running does nothing if there
    // are no file-hidden lines left to flip.
    function unhideAllFileHidden(type) {
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded.', 3000); return; }
        const key = `${siteID}|${type}`;
        const features = kmlFeatures[key];
        if (!features || features.length === 0) {
            showKMLToast(`No ${type} KML loaded yet.`, 3000);
            return;
        }
        // Collect unique placemark indices where the file says visible=false.
        // Multiple features can share a pmIdx (a MultiGeometry placemark);
        // we only need one entry per pmIdx in pending.
        const fileHiddenIdx = new Set();
        features.forEach(f => {
            if (f.visible === false && f.pmIdx != null) fileHiddenIdx.add(f.pmIdx);
        });
        if (fileHiddenIdx.size === 0) {
            showKMLToast(`No file-hidden ${type} lines on this site.`, 3000);
            return;
        }
        const p = getPending(siteID, type);
        let flipped = 0;
        fileHiddenIdx.forEach(pmIdx => {
            const k = String(pmIdx);
            // If already overridden to visible, leave it. Otherwise set to true.
            if (p[k] !== true) {
                p[k] = true;
                flipped++;
            }
        });
        setPending(siteID, type, p);
        showKMLToast(`Unhid ${flipped} file-hidden ${type} line${flipped === 1 ? '' : 's'} (local override).`, 4000);
        if (isActive) runUpdate();
    }

    // ============================================================
    // Commit-bound ops state (E2 delete, E3 modify, E4 add)
    //
    // SEPARATE store from getPending() — those are LOCAL HIDES,
    // never commit. The schema here is richer because each op has
    // its own payload:
    //
    //   {
    //     ops:   { <pmIdx>: { op:'delete' }
    //              <pmIdx>: { op:'modify', coords:[[lng,lat,alt?],...] } },
    //     added: [ { name, coords:[[lng,lat,alt?],...] }, ... ]
    //   }
    //
    // Lines marked here are NOT hidden from the user — they render
    // with op-specific visual treatment (red strikethrough for
    // delete, yellow for modify, green for added) so the user can
    // see what they're about to commit.
    // ============================================================
    function commitOpsKey(siteID, type) {
        return `${KML_COMMIT_OPS_PREFIX}${siteID}-${type}`;
    }

    function emptyCommitOps() { return { ops: {}, added: [] }; }

    function getCommitOps(siteID, type) {
        if (!siteID) return emptyCommitOps();
        const v = gmGet(commitOpsKey(siteID, type), null);
        if (!v || typeof v !== 'object') return emptyCommitOps();
        return {
            ops: (v.ops && typeof v.ops === 'object') ? v.ops : {},
            added: Array.isArray(v.added) ? v.added : [],
        };
    }

    function setCommitOps(siteID, type, obj) {
        if (!siteID) return;
        gmSet(commitOpsKey(siteID, type), obj || emptyCommitOps());
        // Notify Power Line Editor so its dirty-count badge stays current.
        // Wrapped in try/catch because broadcastPowerLineStatus is hoisted
        // but the channel may not be set up yet during very early calls.
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    function commitOpsCount(siteID, type) {
        const co = getCommitOps(siteID, type);
        return Object.keys(co.ops).length + co.added.length;
    }

    function summarizeCommitOps(co) {
        const deleteCount = Object.values(co.ops).filter(o => o.op === 'delete').length;
        const modifyCount = Object.values(co.ops).filter(o => o.op === 'modify').length;
        const addCount = co.added.length;
        const parts = [];
        if (deleteCount) parts.push(`${deleteCount} delete${deleteCount === 1 ? '' : 's'}`);
        if (modifyCount) parts.push(`${modifyCount} modif${modifyCount === 1 ? 'ication' : 'ications'}`);
        if (addCount) parts.push(`${addCount} new line${addCount === 1 ? '' : 's'}`);
        return { parts, text: parts.join(' · '), total: deleteCount + modifyCount + addCount };
    }

    function getOpForPlacemark(siteID, type, pmIdx) {
        const co = getCommitOps(siteID, type);
        return co.ops[String(pmIdx)] || null;
    }

    // Returns the coords array the renderer + commit pipeline should use
    // for a given placemark. Priority order:
    //   1. Active vertex-edit session (live drag → instant feedback)
    //   2. Previously-saved modify op (still pending commit)
    //   3. Original file coords (default)
    // Output is always [{lat,lng}, ...] (Leaflet-friendly internal format).
    function effectiveCoordsForFeature(siteID, type, pmIdx, originalCoords) {
        if (vertexEditState && vertexEditState.type === type && vertexEditState.pmIdx === pmIdx) {
            return vertexEditState.currentCoords;
        }
        const op = getOpForPlacemark(siteID, type, pmIdx);
        if (op && op.op === 'modify' && Array.isArray(op.coords)) {
            return op.coords.map(c => ({ lat: c[1], lng: c[0] }));
        }
        return originalCoords;
    }

    // ============================================================
    // Vertex edit session state (E3)
    //
    // Only one line can be vertex-edited at a time across both types.
    // Active shape:
    //   { type, pmIdx,
    //     originalCoords: [{lat,lng}, ...],   // snapshot at entry
    //     currentCoords:  [{lat,lng}, ...],   // mutated by drag
    //     handles:        [L.Marker, ...],    // one per vertex
    //     toolbarEl:      HTMLDivElement }    // floating Save/Discard
    // ============================================================
    let vertexEditState = null;

    // ============================================================
    // Draw new line session state (E4)
    //
    // Click-to-add-vertex mode. Only one drawing session at a time.
    // Active shape:
    //   { type,
    //     coords: [[lng,lat], ...],           // KML order — append on click
    //     clickHandler, escHandler,           // for cleanup on exit
    //     toolbarEl: HTMLDivElement }
    // ============================================================
    let drawingState = null;

    // ============================================================
    // Snap-to-vertex (Phase 3b, v34.63)
    //
    // While dragging a vertex (in vertex-edit) or clicking to place a
    // vertex (in draw mode), if the candidate position is within
    // SNAP_TOLERANCE_PX of an EXISTING power-line vertex (any type,
    // file or pending-add, EXCEPT the line being edited / drawn),
    // override to that vertex's exact coord and show a yellow ring
    // marker at the snap target so the user knows it's locked in.
    //
    // Cleared on dragend / click / exit / explicit clearSnapIndicator.
    // ============================================================
    const SNAP_TOLERANCE_PX = 10;
    let snapIndicator = null;

    function clearSnapIndicator() {
        if (!snapIndicator) return;
        try { snapIndicator.remove(); } catch (e) {}
        snapIndicator = null;
    }

    function showSnapIndicator(map, latlng) {
        if (!map || !latlng) return;
        let L;
        try { L = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).L; } catch (e) { return; }
        if (!L || typeof L.marker !== 'function' || typeof L.divIcon !== 'function') return;
        clearSnapIndicator();
        // v34.65: darker, more saturated purple (#9333ea, Tailwind
        // purple-600) for stronger contrast against satellite + cyan
        // handles. Double-layered glow uses the lighter tint for visibility.
        const icon = L.divIcon({
            html: '<div style="width:28px;height:28px;border-radius:50%;border:3px solid #9333ea;background:rgba(147,51,234,0.32);box-shadow:0 0 12px rgba(192,132,252,0.95),0 0 22px rgba(147,51,234,0.65);box-sizing:border-box;pointer-events:none"></div>',
            className: 'aim-snap-indicator',
            iconSize: [34, 34],
            iconAnchor: [17, 17],
        });
        try {
            snapIndicator = L.marker([latlng.lat, latlng.lng], { icon, interactive: false, zIndexOffset: 2000, keyboard: false });
            snapIndicator.addTo(map);
        } catch (e) {}
    }

    // Find the nearest snap target within SNAP_TOLERANCE_PX of srcLatLng.
    // Considers BOTH vertices and points along segments (perpendicular
    // foot, clamped to segment). Returns {lat,lng} or null. Vertex hits
    // win ties because the segment test excludes endpoints (t in (0,1)).
    //
    // excludeKey selects the "self" to skip:
    //   'file:<type>:<pmIdx>'    → currently-editing this file line, skip
    //   'added:<type>:<addedIdx>'→ currently-editing this pending-add line, skip
    //   'draw'                   → currently drawing a NEW line, skip its own coords
    //   null                     → no exclusion (rare)
    function findSnapCandidate(srcLatLng, excludeKey) {
        const map = getLeafletMap();
        if (!map || typeof map.latLngToContainerPoint !== 'function') return null;
        const siteID = getCurrentSiteID();
        if (!siteID) return null;
        let L;
        try { L = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).L; } catch (e) { return null; }
        if (!L || typeof L.latLng !== 'function') return null;

        let srcPx;
        try { srcPx = map.latLngToContainerPoint(L.latLng(srcLatLng.lat, srcLatLng.lng)); }
        catch (e) { return null; }

        let best = null;
        let bestDist = SNAP_TOLERANCE_PX + 0.0001;

        const testVertex = (lat, lng) => {
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            try {
                const px = map.latLngToContainerPoint(L.latLng(lat, lng));
                const d = Math.hypot(px.x - srcPx.x, px.y - srcPx.y);
                if (d < bestDist) { bestDist = d; best = { lat, lng }; }
            } catch (e) {}
        };

        // v34.66: also test point-to-segment (perpendicular foot,
        // clamped to (0,1)). Endpoints (t=0 / t=1) excluded because
        // they're vertices and testVertex already covers them — keeps
        // vertex snaps winning over segment snaps near endpoints.
        const testSegment = (lat1, lng1, lat2, lng2) => {
            if (!Number.isFinite(lat1) || !Number.isFinite(lng1)) return;
            if (!Number.isFinite(lat2) || !Number.isFinite(lng2)) return;
            try {
                const pa = map.latLngToContainerPoint(L.latLng(lat1, lng1));
                const pb = map.latLngToContainerPoint(L.latLng(lat2, lng2));
                const dx = pb.x - pa.x, dy = pb.y - pa.y;
                const len2 = dx * dx + dy * dy;
                if (len2 < 1e-6) return; // degenerate — covered by vertex test
                const t = ((srcPx.x - pa.x) * dx + (srcPx.y - pa.y) * dy) / len2;
                if (t <= 0 || t >= 1) return; // foot outside segment
                const fx = pa.x + t * dx, fy = pa.y + t * dy;
                const d = Math.hypot(fx - srcPx.x, fy - srcPx.y);
                if (d < bestDist) {
                    bestDist = d;
                    const ll = map.containerPointToLatLng([fx, fy]);
                    best = { lat: ll.lat, lng: ll.lng };
                }
            } catch (e) {}
        };

        // Walk a line's coords once: hit every vertex AND every segment.
        const testLine = (coords) => {
            if (!Array.isArray(coords) || coords.length === 0) return;
            for (let i = 0; i < coords.length; i++) {
                const c = coords[i];
                const lat = Array.isArray(c) ? c[1] : (c && c.lat);
                const lng = Array.isArray(c) ? c[0] : (c && c.lng);
                testVertex(lat, lng);
                if (i < coords.length - 1) {
                    const n = coords[i + 1];
                    const nlat = Array.isArray(n) ? n[1] : (n && n.lat);
                    const nlng = Array.isArray(n) ? n[0] : (n && n.lng);
                    testSegment(lat, lng, nlat, nlng);
                }
            }
        };

        ['distro', 'trans'].forEach((type) => {
            // File lines — use effective (post-modify) coords so snap
            // matches what's actually rendered.
            const features = kmlFeatures[kmlKey(siteID, type)] || [];
            features.forEach((f) => {
                if (!f || f.type !== 'line') return;
                if (excludeKey === `file:${type}:${f.pmIdx}`) return;
                // Skip file lines marked for deletion — they're being
                // removed; snapping to them creates orphaned references.
                const co0 = getCommitOps(siteID, type);
                const op0 = co0.ops && co0.ops[String(f.pmIdx)];
                if (op0 && op0.op === 'delete') return;
                testLine(effectiveCoordsForFeature(siteID, type, f.pmIdx, f.coords));
            });
            // Pending-add (green) lines.
            const co = getCommitOps(siteID, type);
            (co.added || []).forEach((added, i) => {
                if (excludeKey === `added:${type}:${i}`) return;
                testLine(added.coords);
            });
        });

        // In-progress draw line — its own coords are skipped if we're
        // the one drawing (excludeKey === 'draw').
        if (drawingState && excludeKey !== 'draw') {
            testLine(drawingState.coords);
        }

        return best;
    }

    function markPlacemarkForDelete(siteID, type, pmIdx) {
        const co = getCommitOps(siteID, type);
        co.ops[String(pmIdx)] = { op: 'delete' };
        setCommitOps(siteID, type, co);
    }

    function unmarkPlacemarkOp(siteID, type, pmIdx) {
        const co = getCommitOps(siteID, type);
        delete co.ops[String(pmIdx)];
        setCommitOps(siteID, type, co);
    }

    // ============================================================
    // CONVERT (distro ↔ trans) + MERGE (combine segments)
    //
    // Both reduce to the existing commit-ops model — no new commit-pipeline
    // code is needed (applyCommitOpsToKML already does modify → delete →
    // append-added):
    //   convert = delete op on the source type + an `added` line on the
    //             OTHER type (cross-file; the strip's ✓ commits both because
    //             each type's dirty count > 0; a missing target KML is
    //             create-on-save'd by commitPendingOps).
    //   merge   = N delete ops + 1 `added` line, all within ONE type.
    //
    // parseKML keeps only lat/lng (drops per-vertex altitude), so both emit
    // 2D [[lng,lat],…] lines — consistent with how draw mode + modify ops
    // already store coords.
    // ============================================================
    function otherType(type) { return type === 'distro' ? 'trans' : 'distro'; }

    // Effective (post-modify) coords for a FILE line as KML-order
    // [[lng,lat],…]. null if the pmIdx has no line feature (polygon, or a
    // stale index after the file changed underneath us).
    function lineCoordsKmlOrder(siteID, type, pmIdx) {
        const features = kmlFeatures[kmlKey(siteID, type)] || [];
        const f = features.find(ff => ff && ff.type === 'line' && ff.pmIdx === pmIdx);
        if (!f) return null;
        const eff = effectiveCoordsForFeature(siteID, type, pmIdx, f.coords);
        if (!Array.isArray(eff) || eff.length < 2) return null;
        return eff.map(c => [c.lng, c.lat]);
    }

    // ref = { pmIdx } for a file line, or { addedIdx } for a pending-add line.
    function convertLine(fromType, ref) {
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded.', 3000); return; }
        const toType = otherType(fromType);

        // Pending-add (green) line → just move the entry between the two
        // added arrays; it never existed on disk so no delete op is needed.
        if (ref && Number.isFinite(ref.addedIdx)) {
            // Tear down any active edit on this added line first — the splice
            // shifts indices and a stale vertexEditState would point wrong.
            if (vertexEditState && vertexEditState.isAdded && vertexEditState.type === fromType) {
                exitVertexEdit({ save: false, silent: true });
            }
            const coFrom = getCommitOps(siteID, fromType);
            const item = coFrom.added && coFrom.added[ref.addedIdx];
            if (!item) { showKMLToast(`Pending ${fromType} line not found — may have changed.`, 4000); return; }
            coFrom.added.splice(ref.addedIdx, 1);
            setCommitOps(siteID, fromType, coFrom);
            const coTo = getCommitOps(siteID, toType);
            coTo.added.push({ name: item.name, coords: item.coords });
            setCommitOps(siteID, toType, coTo);
            showKMLToast(`Converted pending line "${item.name || '(unnamed)'}" ${fromType} → ${toType}. Commit both with ✓.`, 5500);
            if (isActive) runUpdate();
            try { broadcastPowerLineStatus(); } catch (e) {}
            return;
        }

        // File line → delete on source, add (same geometry) on target.
        const pmIdx = ref && ref.pmIdx;
        if (!Number.isFinite(pmIdx)) return;
        const coords = lineCoordsKmlOrder(siteID, fromType, pmIdx);
        if (!coords) { showKMLToast(`Couldn't read ${fromType} line #${pmIdx} geometry — convert aborted.`, 5000); return; }
        markPlacemarkForDelete(siteID, fromType, pmIdx);
        const coTo = getCommitOps(siteID, toType);
        const name = `Converted from ${fromType} #${pmIdx} (${new Date().toISOString().substring(0, 10)})`;
        coTo.added.push({ name, coords });
        setCommitOps(siteID, toType, coTo);
        const extra = kmlExistenceState(siteID, toType) === 'missing'
            ? ` (a ${toType} KML will be created on commit)` : '';
        showKMLToast(`Converting ${fromType} #${pmIdx} → ${toType}${extra}. Commit both with ✓.`, 6000);
        if (isActive) runUpdate();
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    // --- Merge selection state (session-only, single type, file lines only) ---
    // { type:'distro'|'trans', pms:[pmIdx,…] }
    let mergeSelection = null;

    function isMergeSelected(type, pmIdx) {
        return !!(mergeSelection && mergeSelection.type === type && mergeSelection.pms.indexOf(pmIdx) !== -1);
    }

    function clearMergeSelection(opts) {
        if (!mergeSelection) return;
        mergeSelection = null;
        if (!(opts && opts.silent) && isActive) runUpdate();
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    function toggleMergeSelect(type, pmIdx) {
        const siteID = getCurrentSiteID();
        if (!siteID) return;
        if (!Number.isFinite(pmIdx)) return;
        // Can't merge across types — they live in separate files.
        if (mergeSelection && mergeSelection.type !== type) {
            showKMLToast(`Merge works within ONE type. Finish or clear the ${mergeSelection.type} selection first.`, 5000);
            return;
        }
        // A line already marked for deletion can't be a merge source.
        const op = getOpForPlacemark(siteID, type, pmIdx);
        if (op && op.op === 'delete') {
            showKMLToast(`${type} #${pmIdx} is marked for deletion — unmark it before merging.`, 5000);
            return;
        }
        if (!mergeSelection) mergeSelection = { type, pms: [] };
        const i = mergeSelection.pms.indexOf(pmIdx);
        if (i === -1) mergeSelection.pms.push(pmIdx);
        else mergeSelection.pms.splice(i, 1);
        if (mergeSelection.pms.length === 0) mergeSelection = null;
        const n = mergeSelection ? mergeSelection.pms.length : 0;
        showKMLToast(
            n >= 2 ? `${n} ${type} lines selected — click ⛓✓ in the strip to merge.`
            : (n === 1 ? `1 ${type} line selected — pick at least one more connected line.` : 'Merge selection cleared.'),
            3000
        );
        if (isActive) runUpdate();
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    // Two [lng,lat] points within ~1 m? Snapped/split-shared endpoints are
    // byte-identical; this tolerance only forgives floating dust.
    function llClose(a, b) {
        const dLat = (a[1] - b[1]) * 111320;
        const dLng = (a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180);
        return (dLat * dLat + dLng * dLng) < 1.0; // < 1 m
    }

    // Chain segments end-to-end into one ordered polyline. Returns the merged
    // [[lng,lat],…] or null if they don't form ONE connected path (gap or
    // branch leaves a segment unattached). Reverses segments as needed and
    // dedupes the shared vertex at each join.
    function chainSegments(segs) {
        if (!segs.length) return null;
        const used = new Array(segs.length).fill(false);
        let chain = segs[0].slice();
        used[0] = true;
        let remaining = segs.length - 1;
        let progress = true;
        while (remaining > 0 && progress) {
            progress = false;
            for (let i = 0; i < segs.length; i++) {
                if (used[i]) continue;
                const s = segs[i];
                const sHead = s[0], sTail = s[s.length - 1];
                const cHead = chain[0], cTail = chain[chain.length - 1];
                if (llClose(cTail, sHead)) chain = chain.concat(s.slice(1));
                else if (llClose(cTail, sTail)) chain = chain.concat(s.slice().reverse().slice(1));
                else if (llClose(cHead, sTail)) chain = s.slice(0, -1).concat(chain);
                else if (llClose(cHead, sHead)) chain = s.slice().reverse().slice(0, -1).concat(chain);
                else continue;
                used[i] = true;
                remaining--;
                progress = true;
            }
        }
        return remaining === 0 ? chain : null;
    }

    function performMerge() {
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded.', 3000); return; }
        if (!mergeSelection || mergeSelection.pms.length < 2) {
            showKMLToast('Select at least two connected lines first.', 3500);
            return;
        }
        const type = mergeSelection.type;
        const pms = mergeSelection.pms.slice();
        const segs = [];
        for (let j = 0; j < pms.length; j++) {
            const c = lineCoordsKmlOrder(siteID, type, pms[j]);
            if (!c) { showKMLToast(`Couldn't read ${type} line #${pms[j]} — merge aborted.`, 5000); return; }
            segs.push(c);
        }
        const merged = chainSegments(segs);
        if (!merged) {
            showKMLToast(`These ${pms.length} ${type} lines don't connect end-to-end into a single line (gap or branch). Select only segments that join.`, 8000);
            return;
        }
        // Tear down any vertex edit on this type before queuing deletes.
        if (vertexEditState && vertexEditState.type === type) exitVertexEdit({ save: false, silent: true });
        const co = getCommitOps(siteID, type);
        pms.forEach(pmIdx => { co.ops[String(pmIdx)] = { op: 'delete' }; });
        const name = `Merged ${type} line (${pms.length} segments, ${new Date().toISOString().substring(0, 10)})`;
        co.added.push({ name, coords: merged });
        setCommitOps(siteID, type, co);
        clearMergeSelection({ silent: true });
        showKMLToast(`Merged ${pms.length} ${type} lines into one (${merged.length} vertices). Commit with ✓.`, 6000);
        if (isActive) runUpdate();
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    function clearAllCommitOps(siteID, type) {
        setCommitOps(siteID, type, emptyCommitOps());
    }

    // After ANY successful commit/split PUT, refresh local state from
    // the xmlText we just sent — NOT from a refetch.
    //
    // Why: fetchKMLForSite() pulls via raw.githubusercontent.com, which
    // has a 5-min CDN cache. Two commits in quick succession would see
    // the second refetch return the FIRST commit's content (cached),
    // so the user's second change appears to revert until the cache
    // expires. Diagnosed 2026-05-21 from a vertex-edit double-commit
    // round trip — line snapped back to the first-edit position.
    //
    // We already have the authoritative bytes (GitHub accepted them),
    // so parse them here. Other tabs / users still get the cached
    // version until edge TTL expires — that's a Percepto-wide limit
    // we can't fix from a userscript.
    function applyCommittedXmlToLocalState(siteID, type, xmlText) {
        const k = kmlKey(siteID, type);
        const beforeCount = (kmlFeatures[k] || []).length;
        try {
            const features = parseKML(xmlText);
            kmlFeatures[k] = features;
            const path = kmlResolvedPath[k] || `${siteID}-${type}.kml`;
            gmSet(KML_CACHE_PREFIX + k, { features, at: Date.now(), path });
            kmlMissing.delete(k);
            console.log(`${TAG} applyCommittedXmlToLocalState[${k}]: features ${beforeCount} → ${features.length}`);
            return true;
        } catch (e) {
            // Shouldn't happen — we just built this XML ourselves. Fall
            // back to forced refetch (CDN-stale risk accepted) so the
            // render at least gets SOMETHING.
            console.warn(`${TAG} post-commit local parse failed; falling back to refetch:`, e);
            delete kmlFeatures[k];
            gmSet(KML_CACHE_PREFIX + k, null);
            kmlMissing.delete(k);
            fetchKMLForSite(siteID, true);
            return false;
        }
    }

    function discardCommitOps(type) {
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded.', 3000); return; }
        const count = commitOpsCount(siteID, type);
        if (count === 0) {
            showKMLToast(`No pending ${type} commits to discard.`, 2500);
            return;
        }
        if (!confirm(`Discard ${count} pending ${type} commit${count === 1 ? '' : 's'}?\n\nNothing will be sent to GitHub.`)) return;
        // v34.56: if there's an active vertex edit OR draw mode on this
        // type, tear it down before clearing ops. Otherwise the floating
        // Save/Discard toolbar + the cyan handles would be left stranded
        // pointing at a line that no longer exists (especially bad for
        // added lines — the line itself is in commitOps.added and
        // disappears when we clear it).
        if (vertexEditState && vertexEditState.type === type) {
            exitVertexEdit({ save: false, silent: true });
        }
        if (drawingState && drawingState.type === type) {
            exitDrawMode({ silent: true });
        }
        clearAllCommitOps(siteID, type);
        showKMLToast(`Discarded ${count} pending ${type} commit${count === 1 ? '' : 's'}.`, 3500);
        if (isActive) runUpdate();
    }

    // --- KML edit UI: right-click context menu + toast ---
    const KML_CTX_MENU_ID = 'aim-kml-ctx-menu';
    const KML_TOAST_ID = 'aim-kml-toast';
    // Outside-click listener for the open menu. Tracked module-level so
    // closeKMLContextMenu always cleans it up (otherwise it'd leak across
    // open/close cycles). Set by showKMLContextMenu after a setTimeout(0)
    // to avoid catching the SAME contextmenu's mousedown.
    let kmlMenuOutsideListener = null;

    function closeKMLContextMenu() {
        const m = document.getElementById(KML_CTX_MENU_ID);
        if (m) m.remove();
        if (kmlMenuOutsideListener) {
            document.removeEventListener('mousedown', kmlMenuOutsideListener, true);
            kmlMenuOutsideListener = null;
        }
    }

    function showKMLContextMenu(x, y, type, pmIdx, isCurrentlyVisible, fileVisible) {
        closeKMLContextMenu();
        const siteID = getCurrentSiteID();
        if (!siteID) return;
        const menu = document.createElement('div');
        menu.id = KML_CTX_MENU_ID;
        menu.style.cssText = `
            position:fixed;left:${x}px;top:${y}px;z-index:99999;
            background:#1f2228;border:1px solid rgba(20,210,220,0.5);border-radius:6px;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
            padding:4px 0;min-width:180px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;
        `;
        const header = document.createElement('div');
        header.style.cssText = 'padding:4px 12px;color:#7adfe6;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:2px';
        header.textContent = `${type === 'distro' ? 'Distribution' : 'Transmission'} · line #${pmIdx}`;
        menu.appendChild(header);

        const action = document.createElement('button');
        action.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 12px;background:transparent;border:none;color:#e6e6e6;cursor:pointer;font:inherit';
        action.onmouseenter = () => { action.style.background = 'rgba(20,210,220,0.15)'; };
        action.onmouseleave = () => { action.style.background = 'transparent'; };
        action.textContent = isCurrentlyVisible ? '🚫  Hide line (local only)' : '👁  Unhide line (local only)';
        action.onclick = (e) => {
            e.stopPropagation();
            const desired = !isCurrentlyVisible;
            setDesiredVisibility(siteID, type, pmIdx, fileVisible, desired);
            const count = pendingCount(siteID, type);
            showKMLToast(
                `${desired ? 'Unhid' : 'Hid'} ${type} line #${pmIdx}. ${count} hide${count === 1 ? '' : 's'} on this site.`,
                3500
            );
            closeKMLContextMenu();
            if (isActive) runUpdate();
        };
        menu.appendChild(action);

        // Separator before commit-bound actions so the user sees the
        // visual break between local (cheap) and commit (canonical) ops.
        const sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:4px 0';
        menu.appendChild(sep);

        const opNow = getOpForPlacemark(siteID, type, pmIdx);
        const isMarkedDelete = opNow && opNow.op === 'delete';
        const isMarkedModify = opNow && opNow.op === 'modify';

        // Delete row — always shown. v34.65: previously hidden when
        // a modify op was pending ("revert first, then delete"), but
        // that left users stuck if they wanted to abandon their edits
        // AND delete the line. Now Mark for Deletion is always reachable;
        // when a modify is pending the action discards it and replaces
        // with the delete op (mutual exclusion is preserved — one op
        // per placemark — but the user gets there in one click).
        const deleteAction = document.createElement('button');
        deleteAction.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 12px;background:transparent;border:none;color:#ff8585;cursor:pointer;font:inherit';
        deleteAction.onmouseenter = () => { deleteAction.style.background = 'rgba(255,80,80,0.18)'; };
        deleteAction.onmouseleave = () => { deleteAction.style.background = 'transparent'; };
        if (isMarkedDelete) {
            deleteAction.textContent = '↩  Unmark for deletion';
            deleteAction.onclick = (e) => {
                e.stopPropagation();
                unmarkPlacemarkOp(siteID, type, pmIdx);
                const count = commitOpsCount(siteID, type);
                showKMLToast(`Unmarked ${type} line #${pmIdx}. ${count} pending commit${count === 1 ? '' : 's'}.`, 3500);
                closeKMLContextMenu();
                if (isActive) runUpdate();
            };
        } else if (isMarkedModify) {
            deleteAction.textContent = '🗑  Mark for deletion (discards pending edits)';
            deleteAction.onclick = (e) => {
                e.stopPropagation();
                markPlacemarkForDelete(siteID, type, pmIdx);
                const count = commitOpsCount(siteID, type);
                showKMLToast(`Marked ${type} line #${pmIdx} for deletion — your pending vertex edits were discarded. ${count} pending commit${count === 1 ? '' : 's'}.`, 6000);
                closeKMLContextMenu();
                if (isActive) runUpdate();
            };
        } else {
            deleteAction.textContent = '🗑  Mark for deletion (commits to GitHub)';
            deleteAction.onclick = (e) => {
                e.stopPropagation();
                markPlacemarkForDelete(siteID, type, pmIdx);
                const count = commitOpsCount(siteID, type);
                showKMLToast(`Marked ${type} line #${pmIdx} for deletion. ${count} pending commit${count === 1 ? '' : 's'} — review and commit from the panel.`, 5000);
                closeKMLContextMenu();
                if (isActive) runUpdate();
            };
        }
        menu.appendChild(deleteAction);

        // Vertex-edit row — hidden when marked for deletion (no point
        // editing what we're deleting). When a modify is already saved,
        // show both "Edit again" and "Revert" options.
        if (!isMarkedDelete) {
            const editVertAction = document.createElement('button');
            editVertAction.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 12px;background:transparent;border:none;color:#ffd96b;cursor:pointer;font:inherit';
            editVertAction.onmouseenter = () => { editVertAction.style.background = 'rgba(255,217,107,0.18)'; };
            editVertAction.onmouseleave = () => { editVertAction.style.background = 'transparent'; };
            editVertAction.textContent = isMarkedModify
                ? '✏️  Edit vertices again'
                : '✏️  Edit vertices (commits to GitHub)';
            editVertAction.onclick = (e) => {
                e.stopPropagation();
                closeKMLContextMenu();
                enterVertexEdit(type, pmIdx);
            };
            menu.appendChild(editVertAction);

            if (isMarkedModify) {
                const revertAction = document.createElement('button');
                revertAction.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 12px;background:transparent;border:none;color:#ffd96b;cursor:pointer;font:inherit';
                revertAction.onmouseenter = () => { revertAction.style.background = 'rgba(255,217,107,0.18)'; };
                revertAction.onmouseleave = () => { revertAction.style.background = 'transparent'; };
                revertAction.textContent = '↩  Revert vertex edits';
                revertAction.onclick = (e) => {
                    e.stopPropagation();
                    unmarkPlacemarkOp(siteID, type, pmIdx);
                    const count = commitOpsCount(siteID, type);
                    showKMLToast(`Reverted ${type} #${pmIdx} vertex edits. ${count} pending commit${count === 1 ? '' : 's'}.`, 3500);
                    closeKMLContextMenu();
                    if (isActive) runUpdate();
                };
                menu.appendChild(revertAction);
            }
        }

        document.body.appendChild(menu);
        // Reposition if off-screen to the right or bottom.
        const r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 4}px`;
        if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 4}px`;

        // Close on outside click — registered on next tick so the same right
        // click that opened the menu doesn't also close it. Skip the close
        // when the mousedown lands INSIDE the menu (was the v34.23 bug:
        // mousedown on the action button fired in capture phase BEFORE the
        // button's click event, removing the menu and never letting the
        // click run, so action.onclick never logged).
        setTimeout(() => {
            kmlMenuOutsideListener = (e) => {
                if (menu.contains(e.target)) return;
                closeKMLContextMenu();
            };
            document.addEventListener('mousedown', kmlMenuOutsideListener, true);
        }, 0);
    }

    function showKMLToast(text, durationMs) {
        const existing = document.getElementById(KML_TOAST_ID);
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = KML_TOAST_ID;
        toast.textContent = text;
        // v34.62: bottom:170px (was 80px) so the toast clears the draw
        // and vertex-edit toolbars (both at bottom:100px, ~55px tall).
        // Previously the toast stacked directly behind/over them on enter.
        toast.style.cssText = `
            position:fixed;bottom:170px;left:50%;transform:translateX(-50%);
            background:rgba(15,18,22,0.95);color:#e6e6e6;
            padding:10px 18px;border-radius:6px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            z-index:99999;border:1px solid rgba(20,210,220,0.5);
            pointer-events:none;max-width:80vw;text-align:center;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
        `;
        document.body.appendChild(toast);
        setTimeout(() => { try { toast.remove(); } catch (e) {} }, durationMs || 3000);
    }

    // Single delegated contextmenu handler on window (capture phase so Leaflet
    // doesn't swallow it first). Filters for our tagged SVG paths; bails when
    // the matching type's edit-mode toggle is OFF so right-clicks on KML
    // lines still go through to Leaflet's normal behavior when not editing.
    function installKMLEditHandlers() {
        window.addEventListener('contextmenu', (e) => {
            // Skip synthetic events (e.isTrusted=false). The Altitude and
            // Ruler scripts dispatch synthetic 'contextmenu' as part of
            // Pin & Clean cleanup — those are meant for Leaflet's vertex
            // delete handler, not for us. Without this guard, dropping a
            // pin over a KML line in edit mode would pop the hide/delete
            // menu unexpectedly.
            if (!e.isTrusted) return;
            const t = e.target;
            if (!t || typeof t.getAttribute !== 'function') return;
            const path = (typeof t.closest === 'function') ? t.closest('path[data-kml-type]') : null;
            if (!path) return;
            const type = path.getAttribute('data-kml-type');
            if (!type) return;
            if (toggleState[`${type}.edit-mode`] !== true) return;
            const siteID = getCurrentSiteID();
            if (!siteID) return;
            // E4: pending-add lines have data-kml-added-idx instead of pmIdx.
            // Route to their own menu (only Discard, since the line doesn't
            // exist in the file yet).
            const addedIdxStr = path.getAttribute('data-kml-added-idx');
            if (addedIdxStr !== null) {
                const addedIdx = parseInt(addedIdxStr, 10);
                if (isNaN(addedIdx)) return;
                e.preventDefault();
                e.stopPropagation();
                showAddedLineContextMenu(e.clientX, e.clientY, type, addedIdx);
                return;
            }
            const pmIdx = parseInt(path.getAttribute('data-kml-pm-idx'), 10);
            if (isNaN(pmIdx)) return;
            e.preventDefault();
            e.stopPropagation();
            const features = kmlFeatures[kmlKey(siteID, type)] || [];
            const f = features.find(ff => ff.pmIdx === pmIdx);
            if (!f) return;
            const cur = effectiveVisible(siteID, type, pmIdx, f.visible);
            showKMLContextMenu(e.clientX, e.clientY, type, pmIdx, cur, f.visible);
        }, true);
    }

    // --- Commit pending changes to GitHub via Contents API ---
    //
    // RESERVED FOR FUTURE PHASES (E2 delete, E3 vertex edit, E4 add line).
    // E1 (current) intentionally does NOT commit hide/show to GitHub —
    // local hides are a per-user view filter, the KML stays canonical
    // ~100% of real-world infrastructure. The pipeline below
    // (commitKMLChanges → applyPendingToKML → putKMLToGitHub) is the
    // exact write-back plumbing E2/E3/E4 will use for actual KML data
    // changes, so it stays in place. No UI path reaches it in v34.26+.
    function commitKMLChanges(type) {
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded — open a site first.', 3000); return; }
        const pending = getPending(siteID, type);
        const count = Object.keys(pending).length;
        if (count === 0) {
            showKMLToast(`No pending ${type} changes.`, 2500);
            return;
        }
        const token = cachedToken || gmGet(TOKEN_KEY, '');
        if (!token) {
            showKMLToast('No GitHub token — set one in AIM Controls first.', 4500);
            return;
        }
        if (typeof GM_xmlhttpRequest !== 'function') {
            showKMLToast('Tampermonkey grants need re-approval — open the script in Tampermonkey.', 6000);
            return;
        }
        showKMLToast(`Committing ${count} ${type} change${count === 1 ? '' : 's'}…`, 8000);
        const path = kmlResolvedPath[kmlKey(siteID, type)] || `${siteID}-${type}.kml`;
        const url = `${GITHUB_API_BASE}/repos/${KMLS_REPO}/contents/${encodeURIComponent(path)}?ref=${KMLS_BRANCH}`;
        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                },
                timeout: 15000,
                onload: (resp) => {
                    if (resp.status !== 200) {
                        if (resp.status === 401 || resp.status === 403) {
                            showKMLToast('GitHub denied read access — check your PAT scope.', 6000);
                        } else if (resp.status === 404) {
                            showKMLToast(`File ${path} not found on GitHub.`, 5000);
                        } else {
                            showKMLToast(`Commit GET failed: HTTP ${resp.status}.`, 5000);
                        }
                        console.warn(`${TAG} commit GET HTTP ${resp.status}:`, (resp.responseText || '').substring(0, 400));
                        return;
                    }
                    let json;
                    try { json = JSON.parse(resp.responseText); }
                    catch (e) {
                        showKMLToast('Commit failed: unexpected GitHub response.', 5000);
                        console.error(`${TAG} commit GET JSON parse failed:`, e);
                        return;
                    }
                    const sha = json && json.sha;
                    const b64 = (json && json.content) ? String(json.content).replace(/\s/g, '') : '';
                    if (!sha || !b64) {
                        showKMLToast('Commit failed: missing sha/content from GitHub.', 5000);
                        return;
                    }
                    let xmlText;
                    try { xmlText = atob(b64); }
                    catch (e) {
                        showKMLToast('Commit failed: cannot decode GitHub content.', 5000);
                        console.error(`${TAG} atob failed:`, e);
                        return;
                    }
                    let mutated;
                    try { mutated = applyPendingToKML(xmlText, pending); }
                    catch (e) {
                        showKMLToast(`Commit failed: ${e.message || 'XML mutation error'}.`, 6000);
                        console.error(`${TAG} applyPendingToKML failed:`, e);
                        return;
                    }
                    putKMLToGitHub(siteID, type, mutated, sha, count, pending, token);
                },
                onerror: () => showKMLToast('Commit failed: network error.', 5000),
                ontimeout: () => showKMLToast('Commit failed: timed out.', 5000),
            });
        } catch (e) {
            showKMLToast(`Commit threw: ${e.message}.`, 5000);
            console.error(`${TAG} commit GET threw:`, e);
        }
    }

    // Mutate the KML XML so each pending placemark gets the desired
    // <visibility> child. Inserts a new <visibility> if absent; updates
    // the existing one otherwise. Re-serializes and returns the string.
    function applyPendingToKML(xmlText, pending) {
        const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('XML parse error');
        const placemarks = doc.querySelectorAll('Placemark');
        const NS = 'http://www.opengis.net/kml/2.2';
        Object.keys(pending).forEach(key => {
            const idx = parseInt(key, 10);
            if (isNaN(idx) || idx < 0 || idx >= placemarks.length) return;
            const pm = placemarks[idx];
            const desired = !!pending[key];
            let visEl = pm.querySelector(':scope > visibility');
            if (!visEl) {
                visEl = doc.createElementNS(NS, 'visibility');
                pm.insertBefore(visEl, pm.firstChild);
            }
            visEl.textContent = desired ? '1' : '0';
        });
        return new XMLSerializer().serializeToString(doc);
    }

    function putKMLToGitHub(siteID, type, xmlText, sha, count, pendingSnapshot, token) {
        const path = kmlResolvedPath[kmlKey(siteID, type)] || `${siteID}-${type}.kml`;
        const url = `${GITHUB_API_BASE}/repos/${KMLS_REPO}/contents/${encodeURIComponent(path)}`;
        // btoa needs binary string; encode UTF-8 first so non-ASCII names
        // (rare in current KMLs but legal in the spec) round-trip cleanly.
        let contentB64;
        try {
            const utf8 = new TextEncoder().encode(xmlText);
            let bin = '';
            for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
            contentB64 = btoa(bin);
        } catch (e) {
            showKMLToast('Commit failed: cannot encode XML.', 5000);
            console.error(`${TAG} btoa failed:`, e);
            return;
        }
        const numHidden = Object.values(pendingSnapshot).filter(v => v === false).length;
        const numShown = count - numHidden;
        const parts = [];
        if (numHidden) parts.push(`hide ${numHidden}`);
        if (numShown) parts.push(`unhide ${numShown}`);
        const message = `[AIM site ${siteID}] ${type}: ${parts.join(' · ')}`;
        try {
            GM_xmlhttpRequest({
                method: 'PUT',
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                },
                data: JSON.stringify({ message, content: contentB64, sha, branch: KMLS_BRANCH }),
                timeout: 20000,
                onload: (resp) => {
                    if (resp.status === 200 || resp.status === 201) {
                        setPending(siteID, type, {});
                        showKMLToast(`✓ Committed ${count} ${type} change${count === 1 ? '' : 's'}.`, 4000);
                        applyCommittedXmlToLocalState(siteID, type, xmlText);
                        if (isActive) runUpdate();
                    } else if (resp.status === 409) {
                        showKMLToast('Conflict: file changed on GitHub since you opened it. Your pending changes are kept — refresh the page and try Commit again.', 9000);
                    } else if (resp.status === 401 || resp.status === 403) {
                        showKMLToast('GitHub denied write — your PAT needs contents:write scope on aim-userscripts-data.', 9000);
                    } else if (resp.status === 422) {
                        showKMLToast('GitHub rejected the write (422 — branch protection?). See console.', 6000);
                        console.warn(`${TAG} commit PUT 422:`, (resp.responseText || '').substring(0, 600));
                    } else {
                        showKMLToast(`Commit failed: HTTP ${resp.status}.`, 5000);
                        console.warn(`${TAG} commit PUT HTTP ${resp.status}:`, (resp.responseText || '').substring(0, 600));
                    }
                },
                onerror: () => showKMLToast('Commit failed: network error during PUT.', 5000),
                ontimeout: () => showKMLToast('Commit failed: PUT timed out.', 5000),
            });
        } catch (e) {
            showKMLToast(`Commit PUT threw: ${e.message}.`, 5000);
            console.error(`${TAG} commit PUT threw:`, e);
        }
    }

    // One-time per file: walks every placemark and splits any LineString
    // with 3+ vertices (= 2+ segments) into N-1 single-segment placemarks,
    // each preserving the parent's name + styleUrl. Single-segment lines
    // pass through unchanged. After this, every right-click acts on a
    // single segment instead of a half-mile of placemark.
    //
    // Refuses to run if pending hide/unhide changes exist for this type —
    // those reference the OLD pmIdx values and would silently apply to
    // different placemarks after the split. User must commit or clear
    // pending first.
    //
    // Single commit message: "[AIM site <id>] <type>: split N placemarks into M segments".
    function splitMultiSegmentPlacemarks(type) {
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded — open a site first.', 3000); return; }
        const pCount = pendingCount(siteID, type);
        if (pCount > 0) {
            showKMLToast(`Refusing to split: ${pCount} pending ${type} hide${pCount === 1 ? '' : 's'}. Clear them first (the split would shift placemark indices).`, 9000);
            return;
        }
        const cCount = commitOpsCount(siteID, type);
        if (cCount > 0) {
            showKMLToast(`Refusing to split: ${cCount} pending ${type} commit${cCount === 1 ? '' : 's'}. Commit or discard them first (the split would shift placemark indices).`, 9000);
            return;
        }
        const token = cachedToken || gmGet(TOKEN_KEY, '');
        if (!token) { showKMLToast('No GitHub token — set one in AIM Controls first.', 4500); return; }
        if (typeof GM_xmlhttpRequest !== 'function') {
            showKMLToast('Tampermonkey grants need re-approval — open the script in Tampermonkey.', 6000);
            return;
        }
        // Resolved path comes from the multi-candidate fetcher — guarantees
        // we hit the same file the user is currently viewing. Fall back to
        // lowercase .kml (the convention) if nothing's been resolved yet
        // (rare: user clicked Split before KML loaded).
        const path = kmlResolvedPath[kmlKey(siteID, type)] || `${siteID}-${type}.kml`;
        if (/\.kmz$/i.test(path)) {
            showKMLToast(`Split doesn't support .kmz yet (current file is ${path}). Convert to .kml first via Google Earth, push the .kml, then retry.`, 9000);
            return;
        }
        if (!confirm(`Split all multi-segment ${type} lines in site ${siteID} into single-segment placemarks?\n\nThis is a one-time, repo-wide change to ${path}. File size will grow ~3-4× but every right-click after this will act on a single segment instead of a whole multi-vertex line.\n\nProceed?`)) {
            return;
        }
        showKMLToast(`Reading ${type} KML…`, 8000);
        const url = `${GITHUB_API_BASE}/repos/${KMLS_REPO}/contents/${encodeURIComponent(path)}?ref=${KMLS_BRANCH}`;
        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                },
                timeout: 15000,
                onload: (resp) => {
                    if (resp.status !== 200) {
                        showKMLToast(`Split GET failed: HTTP ${resp.status}.`, 5000);
                        console.warn(`${TAG} split GET HTTP ${resp.status}:`, (resp.responseText || '').substring(0, 400));
                        return;
                    }
                    let json;
                    try { json = JSON.parse(resp.responseText); }
                    catch (e) { showKMLToast('Split failed: bad GitHub response.', 5000); return; }
                    const sha = json && json.sha;
                    const b64 = (json && json.content) ? String(json.content).replace(/\s/g, '') : '';
                    if (!sha || !b64) { showKMLToast('Split failed: missing sha/content.', 5000); return; }
                    let xmlText;
                    try { xmlText = atob(b64); } catch (e) { showKMLToast('Split failed: decode error.', 5000); return; }
                    let result;
                    try { result = doSplitKML(xmlText); }
                    catch (e) {
                        showKMLToast(`Split failed: ${e.message}.`, 6000);
                        console.error(`${TAG} doSplitKML failed:`, e);
                        return;
                    }
                    if (result.splitCount === 0) {
                        showKMLToast(`No multi-segment ${type} lines to split — file is already segment-level.`, 5000);
                        return;
                    }
                    showKMLToast(`Splitting ${result.splitCount} placemark${result.splitCount === 1 ? '' : 's'} → ${result.newCount} segments…`, 8000);
                    const message = `[AIM site ${siteID}] ${type}: split ${result.splitCount} placemark${result.splitCount === 1 ? '' : 's'} into ${result.newCount} segments`;
                    putSplitToGitHub(siteID, type, result.xml, sha, message, token, result);
                },
                onerror: () => showKMLToast('Split failed: network error during GET.', 5000),
                ontimeout: () => showKMLToast('Split failed: GET timed out.', 5000),
            });
        } catch (e) {
            showKMLToast(`Split GET threw: ${e.message}.`, 5000);
            console.error(`${TAG} split GET threw:`, e);
        }
    }

    // Walks the KML, finds every Placemark with a LineString of N ≥ 3
    // coordinates, replaces it with N-1 sibling Placemarks (each a 2-vertex
    // LineString). Preserves the original's <name>, <styleUrl>, and
    // <visibility>. Returns { xml, splitCount, newCount } where splitCount
    // is the number of original placemarks split and newCount is the total
    // number of new placemarks created (sum of N-1 across all splits).
    //
    // Single-segment LineStrings, Polygons, and anything else pass through
    // unchanged.
    function doSplitKML(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('XML parse error');
        const NS = 'http://www.opengis.net/kml/2.2';
        const placemarks = Array.from(doc.querySelectorAll('Placemark'));
        let splitCount = 0;
        let newCount = 0;
        placemarks.forEach(pm => {
            // Only act on placemarks whose geometry is a single LineString
            // with 3+ coords. MultiGeometry, Polygons, single-segment lines
            // are left alone.
            const lineStrings = pm.querySelectorAll(':scope > LineString');
            if (lineStrings.length !== 1) return;
            // Also bail if MultiGeometry is present (mixed structures get
            // skipped — user can convert manually if needed).
            if (pm.querySelector(':scope > MultiGeometry')) return;
            const coordEl = lineStrings[0].querySelector(':scope > coordinates');
            if (!coordEl) return;
            const triplets = (coordEl.textContent || '').trim().split(/\s+/).filter(Boolean);
            if (triplets.length < 3) return; // already a single segment
            // Source attributes we want to clone onto each new placemark.
            const nameEl = pm.querySelector(':scope > name');
            const styleUrlEl = pm.querySelector(':scope > styleUrl');
            const visEl = pm.querySelector(':scope > visibility');
            const nameText = nameEl ? nameEl.textContent : 'Untitled Path';
            const styleUrlText = styleUrlEl ? styleUrlEl.textContent : '';
            const visText = visEl ? visEl.textContent : '';
            const parent = pm.parentNode;
            const nextSibling = pm.nextSibling;
            // Build N-1 new placemarks just BEFORE removing the original,
            // so insertion order matches the original's position in <Document>.
            const created = [];
            for (let i = 0; i < triplets.length - 1; i++) {
                const np = doc.createElementNS(NS, 'Placemark');
                // <name> "Original name (seg 1/4)" so the split is traceable.
                const nm = doc.createElementNS(NS, 'name');
                nm.textContent = `${nameText} (seg ${i + 1}/${triplets.length - 1})`;
                np.appendChild(nm);
                if (styleUrlText) {
                    const su = doc.createElementNS(NS, 'styleUrl');
                    su.textContent = styleUrlText;
                    np.appendChild(su);
                }
                if (visText) {
                    const v = doc.createElementNS(NS, 'visibility');
                    v.textContent = visText;
                    np.appendChild(v);
                }
                const ls = doc.createElementNS(NS, 'LineString');
                const tess = doc.createElementNS(NS, 'tessellate');
                tess.textContent = '1';
                ls.appendChild(tess);
                const cd = doc.createElementNS(NS, 'coordinates');
                cd.textContent = `${triplets[i]} ${triplets[i + 1]}`;
                ls.appendChild(cd);
                np.appendChild(ls);
                created.push(np);
            }
            // Insert all new placemarks where the original was.
            created.forEach(np => parent.insertBefore(np, nextSibling));
            parent.removeChild(pm);
            splitCount++;
            newCount += created.length;
        });
        return { xml: new XMLSerializer().serializeToString(doc), splitCount, newCount };
    }

    function putSplitToGitHub(siteID, type, xmlText, sha, message, token, result) {
        const path = kmlResolvedPath[kmlKey(siteID, type)] || `${siteID}-${type}.kml`;
        const url = `${GITHUB_API_BASE}/repos/${KMLS_REPO}/contents/${encodeURIComponent(path)}`;
        let contentB64;
        try {
            const utf8 = new TextEncoder().encode(xmlText);
            let bin = '';
            for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
            contentB64 = btoa(bin);
        } catch (e) {
            showKMLToast('Split failed: cannot encode XML.', 5000);
            return;
        }
        try {
            GM_xmlhttpRequest({
                method: 'PUT',
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                },
                data: JSON.stringify({ message, content: contentB64, sha, branch: KMLS_BRANCH }),
                timeout: 30000,
                onload: (resp) => {
                    if (resp.status === 200 || resp.status === 201) {
                        showKMLToast(`✓ Split ${result.splitCount} ${type} placemark${result.splitCount === 1 ? '' : 's'} into ${result.newCount} segments.`, 6000);
                        // Split shifts every placemark's pmIdx — clear any
                        // stale local hides since stored indices would now
                        // reference different placemarks.
                        setPending(siteID, type, {});
                        applyCommittedXmlToLocalState(siteID, type, xmlText);
                        if (isActive) runUpdate();
                    } else if (resp.status === 409) {
                        showKMLToast('Split conflict: file changed on GitHub since GET. Refresh and try again.', 9000);
                    } else if (resp.status === 401 || resp.status === 403) {
                        showKMLToast('GitHub denied write — your PAT needs contents:write scope.', 9000);
                    } else {
                        showKMLToast(`Split failed: HTTP ${resp.status}.`, 5000);
                        console.warn(`${TAG} split PUT HTTP ${resp.status}:`, (resp.responseText || '').substring(0, 600));
                    }
                },
                onerror: () => showKMLToast('Split failed: network error during PUT.', 5000),
                ontimeout: () => showKMLToast('Split failed: PUT timed out.', 5000),
            });
        } catch (e) {
            showKMLToast(`Split PUT threw: ${e.message}.`, 5000);
            console.error(`${TAG} split PUT threw:`, e);
        }
    }

    // ============================================================
    // Commit-bound ops → GitHub (E2 delete, E3 modify, E4 add)
    //
    // commitPendingOps(type)
    //   GET current KML from GitHub (for the SHA optimistic lock) →
    //   applyCommitOpsToKML(xml, ops) mutates the DOM →
    //   putCommitOpsToGitHub(...) PUTs the mutated content back →
    //   on success: clear commit-ops, clear local-hides (indices
    //   shifted), force-refetch + re-render.
    //
    // Confirmation: a confirm() up front summarizing the batch so the
    // user knows what's about to be committed canonically.
    // ============================================================
    // v34.49: cache of {sha, xmlText} from the most recent successful PUT
    // per (siteID|type). Lets back-to-back commits skip the GET round-trip
    // entirely AND avoid the api.github.com stale-SHA window that was
    // throwing 409 Conflict on the user's "add → commit → delete → add
    // → commit" sequence. On 409 from a cached-SHA PUT, the cache is
    // invalidated and the user retries (which goes through the full
    // GET → PUT path again).
    const committedKmlCache = {};

    // v34.54: prune stale ops with pmIdx out of range for the current
    // file. commitOps persists across sessions in GM storage; if user
    // marked a line for delete in session A, then another commit (by
    // them or a coworker) reduced the placemark count below that pmIdx,
    // session B's commit attempt would silently no-op (out-of-bounds
    // skip in applyCommitOpsToKML). Validate up front + drop stale,
    // tell the user what happened.
    function pruneStaleOps(siteID, type) {
        const co = getCommitOps(siteID, type);
        const features = kmlFeatures[kmlKey(siteID, type)];
        if (!features) return { dropped: 0 }; // can't validate without features
        // Highest valid pmIdx is the largest pmIdx present in features
        // (NOT features.length-1, because a Placemark with no LineString /
        // Polygon contributes no feature even though it occupies an index).
        let maxPmIdx = -1;
        features.forEach(f => { if (typeof f.pmIdx === 'number' && f.pmIdx > maxPmIdx) maxPmIdx = f.pmIdx; });
        let dropped = 0;
        Object.keys(co.ops).forEach(k => {
            const idx = parseInt(k, 10);
            if (isNaN(idx) || idx > maxPmIdx) {
                console.warn(`${TAG} dropping stale pending op for ${type} pmIdx=${k} (max valid=${maxPmIdx})`);
                delete co.ops[k];
                dropped++;
            }
        });
        if (dropped > 0) setCommitOps(siteID, type, co);
        return { dropped, maxPmIdx };
    }

    function commitPendingOps(type) {
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded — open a site first.', 3000); return; }

        // v34.54: prune stale ops first.
        const pruned = pruneStaleOps(siteID, type);
        if (pruned.dropped > 0) {
            showKMLToast(`Dropped ${pruned.dropped} stale pending ${type} mark${pruned.dropped === 1 ? '' : 's'} (line${pruned.dropped === 1 ? '' : 's'} no longer exist${pruned.dropped === 1 ? 's' : ''} — file changed since marked). Mark again to retry.`, 8000);
        }

        const co = getCommitOps(siteID, type);
        const summary = summarizeCommitOps(co);
        if (summary.total === 0) {
            showKMLToast(`No pending ${type} commits.`, 2500);
            return;
        }
        const token = cachedToken || gmGet(TOKEN_KEY, '');
        if (!token) {
            showKMLToast('No GitHub token — set one in AIM Controls first.', 4500);
            return;
        }
        if (typeof GM_xmlhttpRequest !== 'function') {
            showKMLToast('Tampermonkey grants need re-approval — open the script in Tampermonkey.', 6000);
            return;
        }
        if (!confirm(`Commit ${summary.text} to GitHub?\n\nThis updates the canonical ${type} KML for ALL coworkers. Continue?`)) {
            return;
        }
        showKMLToast(`Committing ${summary.text}…`, 8000);
        const k = kmlKey(siteID, type);

        // Cache-fast path: if we have a recent {sha, xmlText} from this
        // session's prior commit, skip the GET. Mutates the cached XML
        // directly with the new ops, then PUTs with the cached SHA.
        const cached = committedKmlCache[k];
        if (cached && cached.sha && cached.xmlText) {
            let mutated;
            try { mutated = applyCommitOpsToKML(cached.xmlText, co); }
            catch (e) {
                showKMLToast(`Commit failed: ${e.message || 'XML mutation error'}.`, 6000);
                console.error(`${TAG} applyCommitOpsToKML failed (cached path):`, e);
                return;
            }
            console.log(`${TAG} commit-ops fast path: using cached SHA ${cached.sha.substring(0, 7)} (no GET)`);
            putCommitOpsToGitHub(siteID, type, mutated, cached.sha, token, summary.text);
            return;
        }

        // Slow path: GET fresh from GitHub.
        const path = kmlResolvedPath[k] || `${siteID}-${type}.kml`;
        const url = `${GITHUB_API_BASE}/repos/${KMLS_REPO}/contents/${encodeURIComponent(path)}?ref=${KMLS_BRANCH}`;
        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    // Defense in depth against any intermediate cache returning
                    // a stale GET response — though api.github.com generally
                    // honors these without help.
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                },
                timeout: 15000,
                onload: (resp) => {
                    if (resp.status !== 200) {
                        if (resp.status === 401 || resp.status === 403) {
                            showKMLToast('GitHub denied read access — check your PAT scope.', 6000);
                        } else if (resp.status === 404) {
                            // File doesn't exist yet. If we're only ADDING
                            // lines (no delete/modify against existing
                            // placemarks), this is the "drew on a site with
                            // no KML" case — create the file from a blank
                            // skeleton WITH the drawn lines, PUT with NO sha.
                            // v34.69: makes Save self-heal instead of dead-
                            // ending at 404 (covers a pending line drawn
                            // before the file existed, or a declined/failed
                            // create-on-draw prompt).
                            if (co.added && co.added.length) {
                                try {
                                    const skeleton = buildEmptyKML(siteID, type);
                                    const mutated = applyCommitOpsToKML(skeleton, co);
                                    kmlMissing.delete(k);
                                    console.log(`${TAG} commit-ops: ${path} missing → creating it with ${co.added.length} drawn line(s)`);
                                    // sha undefined → JSON.stringify omits it → GitHub creates the file.
                                    putCommitOpsToGitHub(siteID, type, mutated, undefined, token, summary.text);
                                } catch (e) {
                                    showKMLToast(`Create-on-save failed: ${e.message || 'XML error'}.`, 6000);
                                    console.error(`${TAG} commit-ops create-on-404 failed:`, e);
                                }
                                return;
                            }
                            showKMLToast(`File ${path} not found on GitHub.`, 5000);
                        } else {
                            showKMLToast(`Commit GET failed: HTTP ${resp.status}.`, 5000);
                        }
                        console.warn(`${TAG} commit-ops GET HTTP ${resp.status}:`, (resp.responseText || '').substring(0, 400));
                        return;
                    }
                    let json;
                    try { json = JSON.parse(resp.responseText); }
                    catch (e) {
                        showKMLToast('Commit failed: unexpected GitHub response.', 5000);
                        console.error(`${TAG} commit-ops GET JSON parse failed:`, e);
                        return;
                    }
                    const sha = json && json.sha;
                    const b64 = (json && json.content) ? String(json.content).replace(/\s/g, '') : '';
                    if (!sha || !b64) {
                        showKMLToast('Commit failed: missing sha/content from GitHub.', 5000);
                        return;
                    }
                    let xmlText;
                    try { xmlText = atob(b64); }
                    catch (e) {
                        showKMLToast('Commit failed: cannot decode GitHub content.', 5000);
                        console.error(`${TAG} commit-ops atob failed:`, e);
                        return;
                    }
                    let mutated;
                    try { mutated = applyCommitOpsToKML(xmlText, co); }
                    catch (e) {
                        showKMLToast(`Commit failed: ${e.message || 'XML mutation error'}.`, 6000);
                        console.error(`${TAG} applyCommitOpsToKML failed:`, e);
                        return;
                    }
                    putCommitOpsToGitHub(siteID, type, mutated, sha, token, summary.text);
                },
                onerror: () => showKMLToast('Commit failed: network error.', 5000),
                ontimeout: () => showKMLToast('Commit failed: timed out.', 5000),
            });
        } catch (e) {
            showKMLToast(`Commit threw: ${e.message}.`, 5000);
            console.error(`${TAG} commit-ops GET threw:`, e);
        }
    }

    // Mutates the DOM:
    //   delete ops → removes the Placemark at pmIdx
    //   modify ops → replaces the LineString coordinates (E3, future)
    //   added items → appends new Placemark to the first Document/Folder (E4, future)
    //
    // Delete ordering: sort descending by index so removing one does
    // NOT shift the indices of the remaining deletes still to apply.
    function applyCommitOpsToKML(xmlText, co) {
        const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('XML parse error');
        const placemarks = Array.from(doc.querySelectorAll('Placemark'));
        const beforeCount = placemarks.length;
        const beforeLen = xmlText.length;
        console.log(`${TAG} applyCommitOpsToKML: ${beforeCount} placemarks, ${beforeLen} chars, ops=`, JSON.parse(JSON.stringify(co)));

        // 1. Apply modify ops first (before deletes shift the indices).
        Object.keys(co.ops).forEach(key => {
            const op = co.ops[key];
            if (op.op !== 'modify') return;
            const idx = parseInt(key, 10);
            if (isNaN(idx) || idx < 0 || idx >= placemarks.length) return;
            const pm = placemarks[idx];
            const coordsEl = pm.querySelector('LineString > coordinates');
            if (!coordsEl) {
                console.warn(`${TAG} modify pmIdx=${idx}: no LineString>coordinates found, skipping`);
                return;
            }
            const text = (op.coords || []).map(c => {
                const lng = Number(c[0]), lat = Number(c[1]);
                const alt = (c[2] !== undefined && c[2] !== null) ? Number(c[2]) : null;
                return alt !== null ? `${lng},${lat},${alt}` : `${lng},${lat}`;
            }).join(' ');
            coordsEl.textContent = text;
            console.log(`${TAG} modify pmIdx=${idx}: ${op.coords.length} verts written`);
        });

        // 2. Apply delete ops, descending order so live placemarks
        //    array indices stay valid for the remaining deletes.
        const deleteIdxs = Object.keys(co.ops)
            .filter(k => co.ops[k].op === 'delete')
            .map(k => parseInt(k, 10))
            .filter(n => !isNaN(n) && n >= 0 && n < placemarks.length)
            .sort((a, b) => b - a);
        const droppedIdxs = Object.keys(co.ops)
            .filter(k => co.ops[k].op === 'delete')
            .map(k => parseInt(k, 10))
            .filter(n => isNaN(n) || n < 0 || n >= placemarks.length);
        if (droppedIdxs.length > 0) {
            console.warn(`${TAG} delete: ${droppedIdxs.length} pmIdx values out of bounds (max=${placemarks.length - 1}):`, droppedIdxs);
        }
        let removed = 0;
        deleteIdxs.forEach(idx => {
            const pm = placemarks[idx];
            if (pm && pm.parentNode) {
                pm.parentNode.removeChild(pm);
                removed++;
                console.log(`${TAG} delete pmIdx=${idx}: removed (parent=${pm.parentNode && pm.parentNode.nodeName})`);
            } else {
                console.warn(`${TAG} delete pmIdx=${idx}: SKIPPED (pm=${!!pm}, hasParent=${!!(pm && pm.parentNode)})`);
            }
        });
        if (removed !== deleteIdxs.length) {
            console.warn(`${TAG} delete: requested ${deleteIdxs.length} removals, actually removed ${removed}`);
        }

        // 3. Apply added placemarks — append into the first Document
        //    (or Folder, or root kml element if no container).
        if (co.added && co.added.length) {
            const NS = 'http://www.opengis.net/kml/2.2';
            const container = doc.querySelector('Document') || doc.querySelector('Folder') || doc.documentElement;
            co.added.forEach(item => {
                if (!item || !Array.isArray(item.coords) || item.coords.length < 2) return;
                const pm = doc.createElementNS(NS, 'Placemark');
                if (item.name) {
                    const nameEl = doc.createElementNS(NS, 'name');
                    nameEl.textContent = String(item.name);
                    pm.appendChild(nameEl);
                }
                const ls = doc.createElementNS(NS, 'LineString');
                const coordsEl = doc.createElementNS(NS, 'coordinates');
                coordsEl.textContent = item.coords.map(c => {
                    const lng = Number(c[0]), lat = Number(c[1]);
                    const alt = (c[2] !== undefined && c[2] !== null) ? Number(c[2]) : null;
                    return alt !== null ? `${lng},${lat},${alt}` : `${lng},${lat}`;
                }).join(' ');
                ls.appendChild(coordsEl);
                pm.appendChild(ls);
                container.appendChild(pm);
            });
        }

        const out = new XMLSerializer().serializeToString(doc);
        const afterCount = (out.match(/<Placemark[\s>]/g) || []).length;
        console.log(`${TAG} applyCommitOpsToKML: serialized ${out.length} chars, ${afterCount} Placemarks (was ${beforeCount}, delta ${afterCount - beforeCount})`);
        return out;
    }

    function putCommitOpsToGitHub(siteID, type, xmlText, sha, token, summaryText) {
        const path = kmlResolvedPath[kmlKey(siteID, type)] || `${siteID}-${type}.kml`;
        const url = `${GITHUB_API_BASE}/repos/${KMLS_REPO}/contents/${encodeURIComponent(path)}`;
        let contentB64;
        try {
            const utf8 = new TextEncoder().encode(xmlText);
            let bin = '';
            for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
            contentB64 = btoa(bin);
        } catch (e) {
            showKMLToast('Commit failed: cannot encode XML.', 5000);
            console.error(`${TAG} commit-ops btoa failed:`, e);
            return;
        }
        const message = `[AIM site ${siteID}] ${type}: ${summaryText}`;
        try {
            GM_xmlhttpRequest({
                method: 'PUT',
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                },
                data: JSON.stringify({ message, content: contentB64, sha, branch: KMLS_BRANCH }),
                timeout: 20000,
                onload: (resp) => {
                    if (resp.status === 200 || resp.status === 201) {
                        clearAllCommitOps(siteID, type);
                        // After a structural change (delete/add), placemark
                        // indices shift — any stored local hides on this
                        // type now reference different lines. Safer to
                        // clear them than to silently mis-hide.
                        const hideCount = pendingCount(siteID, type);
                        if (hideCount > 0) {
                            setPending(siteID, type, {});
                            showKMLToast(`✓ Committed ${summaryText}. ${hideCount} local hide${hideCount === 1 ? '' : 's'} cleared (line indices shifted).`, 6000);
                        } else {
                            showKMLToast(`✓ Committed ${summaryText}.`, 4000);
                        }
                        applyCommittedXmlToLocalState(siteID, type, xmlText);
                        // v34.49: cache the new SHA + xmlText so the next
                        // commit can skip GET entirely. The PUT response
                        // includes content.sha (the post-write SHA).
                        try {
                            const respJson = JSON.parse(resp.responseText);
                            const newSha = respJson && respJson.content && respJson.content.sha;
                            if (newSha) {
                                committedKmlCache[kmlKey(siteID, type)] = { sha: newSha, xmlText };
                                console.log(`${TAG} commit-ops cached new SHA ${newSha.substring(0, 7)} for ${type}`);
                            }
                        } catch (e) {
                            console.warn(`${TAG} commit-ops: could not parse PUT response for SHA cache:`, e);
                        }
                        // v34.51: fire runUpdate immediately AND a second
                        // one after 250ms. The render uses a debounced
                        // MutationObserver — a single runUpdate sometimes
                        // gets coalesced with Leaflet's own SVG updates
                        // and the wipe-rebuild misses the stale deleted
                        // path. A second pass guarantees the user-visible
                        // state catches up to kmlFeatures.
                        if (isActive) {
                            console.log(`${TAG} commit-ops: firing runUpdate (isActive=${isActive})`);
                            runUpdate();
                            setTimeout(() => {
                                console.log(`${TAG} commit-ops: firing safety-net runUpdate`);
                                if (isActive) runUpdate();
                            }, 250);
                        } else {
                            console.warn(`${TAG} commit-ops: NOT firing runUpdate, isActive=false`);
                        }
                    } else if (resp.status === 409) {
                        // v34.49: cached SHA may be stale (someone else committed
                        // OR rare api.github.com eventual-consistency window).
                        // Invalidate so next retry does a fresh GET.
                        delete committedKmlCache[kmlKey(siteID, type)];
                        showKMLToast('Conflict: file changed on GitHub since you opened it. Your pending changes are kept — try Commit again (cache cleared, next attempt will re-fetch).', 9000);
                    } else if (resp.status === 401 || resp.status === 403) {
                        showKMLToast('GitHub denied write — your PAT needs contents:write scope on aim-userscripts-data.', 9000);
                    } else if (resp.status === 422) {
                        showKMLToast('GitHub rejected the write (422 — branch protection?). See console.', 6000);
                        console.warn(`${TAG} commit-ops PUT 422:`, (resp.responseText || '').substring(0, 600));
                    } else {
                        showKMLToast(`Commit failed: HTTP ${resp.status}.`, 5000);
                        console.warn(`${TAG} commit-ops PUT HTTP ${resp.status}:`, (resp.responseText || '').substring(0, 600));
                    }
                },
                onerror: () => showKMLToast('Commit failed: network error during PUT.', 5000),
                ontimeout: () => showKMLToast('Commit failed: PUT timed out.', 5000),
            });
        } catch (e) {
            showKMLToast(`Commit PUT threw: ${e.message}.`, 5000);
            console.error(`${TAG} commit-ops PUT threw:`, e);
        }
    }

    // ============================================================
    // E3 — Vertex edit (in-map drag handles for individual vertices)
    //
    // Entry: enterVertexEdit(type, pmIdx) — drops L.Marker handles on
    // each vertex of the chosen line, plus a floating Save/Discard
    // toolbar. The line renders YELLOW (modify visual) for as long
    // as it has a pending modify op.
    //
    // Drag → vertexEditState.currentCoords[i] updates → runUpdate
    // re-projects via effectiveCoordsForFeature so the line follows
    // the handles in real time.
    //
    // Save → writes { op:'modify', coords:[[lng,lat],...] } into the
    // commit-ops store. The next "Commit pending changes" click on
    // the panel batches it with any other ops and PUTs to GitHub.
    //
    // Only one line at a time can be in vertex-edit; entering a new
    // session auto-discards any in-progress one (without saving).
    // ============================================================

    // v34.57: shared vertex-handle helpers used by both enterVertexEdit
    // and enterAddedVertexEdit, plus the in-place add/delete vertex paths.
    //
    // Two kinds of handles:
    //   Real (cyan filled, 12x12): one per vertex in currentCoords.
    //     Drag → updates that vertex. M2 (right-click) → deletes vertex.
    //   Midpoint ghost (dim cyan, 9x9): one between each pair of adjacent
    //     vertices. Click → inserts a new real vertex at the midpoint
    //     position; user can then drag it where they want.
    //
    // rebuildVertexHandles wipes both arrays and rebuilds from
    // currentCoords. Called from enter*, vertex-delete, midpoint-click.
    // rebuildMidpointPositions just repositions existing midpoint markers
    // (cheaper) — used after a real-handle drag so midpoints follow.
    function updateVertexEditToolbarLabel() {
        if (!vertexEditState || !vertexEditState.toolbarEl) return;
        const label = vertexEditState.toolbarEl.querySelector('span');
        if (!label) return;
        label.textContent = vertexEditState.isAdded
            ? `Editing new ${vertexEditState.type} line "${vertexEditState.addedName}" · ${vertexEditState.currentCoords.length} vertices`
            : `Editing ${vertexEditState.type} #${vertexEditState.pmIdx} · ${vertexEditState.currentCoords.length} vertices`;
    }

    function rebuildMidpointPositions() {
        if (!vertexEditState || !vertexEditState.midhandles) return;
        vertexEditState.midhandles.forEach((marker, i) => {
            const a = vertexEditState.currentCoords[i];
            const b = vertexEditState.currentCoords[i + 1];
            if (!a || !b) return;
            try { marker.setLatLng([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2]); } catch (e) {}
        });
    }

    function rebuildVertexHandles() {
        if (!vertexEditState) return;
        const map = getLeafletMap();
        if (!map) return;
        let L;
        try { L = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).L; } catch (e) { return; }
        if (!L || typeof L.marker !== 'function' || typeof L.divIcon !== 'function') return;

        // Wipe current handles
        (vertexEditState.handles || []).forEach(h => { try { h.remove(); } catch (e) {} });
        (vertexEditState.midhandles || []).forEach(h => { try { h.remove(); } catch (e) {} });
        vertexEditState.handles = [];
        vertexEditState.midhandles = [];

        const realIcon = L.divIcon({
            html: '<div style="width:12px;height:12px;border-radius:50%;background:#14d2dc;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.6);cursor:move"></div>',
            className: 'aim-vertex-handle',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
        });
        const ghostIcon = L.divIcon({
            html: '<div style="width:9px;height:9px;border-radius:50%;background:rgba(20,210,220,0.45);border:1.5px solid rgba(255,255,255,0.65);cursor:copy" title="Click to add a vertex here"></div>',
            className: 'aim-vertex-midhandle',
            iconSize: [13, 13],
            iconAnchor: [6.5, 6.5],
        });

        // Real handles — one per vertex.
        vertexEditState.currentCoords.forEach((coord) => {
            const marker = L.marker([coord.lat, coord.lng], { icon: realIcon, draggable: true, zIndexOffset: 1000 });
            marker.addTo(map);
            marker.on('drag', (e) => {
                if (!vertexEditState) return;
                const curIdx = vertexEditState.handles.indexOf(e.target);
                if (curIdx < 0) return;
                const ll = e.target.getLatLng();
                let lat = ll.lat, lng = ll.lng;
                // v34.63 Phase 3b: snap to nearby other-line vertex.
                // Self-line excluded so a vertex can't snap to a different
                // vertex of the same line being edited.
                const excludeKey = vertexEditState.isAdded
                    ? `added:${vertexEditState.type}:${vertexEditState.addedIdx}`
                    : `file:${vertexEditState.type}:${vertexEditState.pmIdx}`;
                const snap = findSnapCandidate({ lat, lng }, excludeKey);
                const map = getLeafletMap();
                if (snap) {
                    lat = snap.lat; lng = snap.lng;
                    try { e.target.setLatLng([lat, lng]); } catch (err) {}
                    if (map) showSnapIndicator(map, snap);
                } else {
                    clearSnapIndicator();
                }
                vertexEditState.currentCoords[curIdx] = { lat, lng };
                // v34.60: reposition midpoints DURING drag, not just on
                // dragend. Otherwise the adjacent ghost handles appear
                // "stuck" at the old midpoints and snap into place when
                // you drop the vertex. Just setLatLng per midhandle —
                // no marker recreation, cheap enough for 60fps drag.
                rebuildMidpointPositions();
                if (isActive) runUpdate();
            });
            marker.on('dragend', () => { clearSnapIndicator(); });
            marker.on('contextmenu', () => {
                if (!vertexEditState) return;
                if (vertexEditState.currentCoords.length <= 2) {
                    showKMLToast('Cannot delete vertex — a line needs at least 2 vertices. Discard the whole line instead.', 5000);
                    return;
                }
                const curIdx = vertexEditState.handles.indexOf(marker);
                if (curIdx < 0) return;
                vertexEditState.currentCoords.splice(curIdx, 1);
                rebuildVertexHandles();
                showKMLToast(`Vertex deleted — ${vertexEditState.currentCoords.length} left.`, 3500);
                updateVertexEditToolbarLabel();
                if (isActive) runUpdate();
            });
            // v34.61 Phase 3a: Ctrl+click a handle → branch a new line
            // starting at this vertex. Saves any current edits to the
            // parent line first, then enters draw mode seeded at the
            // vertex's current position. Same kmlType as parent (user
            // can change later if needed — usually they're branching
            // distro-from-distro or trans-from-trans).
            marker.on('click', (e) => {
                if (!vertexEditState) return;
                const oe = e && e.originalEvent;
                if (!oe || !oe.ctrlKey) return;
                const curIdx = vertexEditState.handles.indexOf(e.target);
                if (curIdx < 0) return;
                const src = vertexEditState.currentCoords[curIdx];
                if (!src || !Number.isFinite(src.lat) || !Number.isFinite(src.lng)) return;
                const seedCoord = { lat: src.lat, lng: src.lng };
                const parentType = vertexEditState.type;
                try { if (L.DomEvent) L.DomEvent.stop(oe); } catch (err) {}
                // Save current line's edits before branching out so the
                // user doesn't lose any drag/insert work they did.
                exitVertexEdit({ save: true, silent: true });
                enterDrawMode(parentType, seedCoord);
                showKMLToast(`Branching new ${parentType} line from vertex ${curIdx + 1}. Click to add vertices, then ✓ Save.`, 5000);
            });
            vertexEditState.handles.push(marker);
        });

        // Ghost midpoint handles — one between each pair of adjacent vertices.
        for (let i = 0; i < vertexEditState.currentCoords.length - 1; i++) {
            const a = vertexEditState.currentCoords[i];
            const b = vertexEditState.currentCoords[i + 1];
            const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
            const marker = L.marker([mid.lat, mid.lng], { icon: ghostIcon, zIndexOffset: 800 });
            marker.addTo(map);
            marker.on('click', () => {
                if (!vertexEditState) return;
                const curIdx = vertexEditState.midhandles.indexOf(marker);
                if (curIdx < 0) return;
                const a2 = vertexEditState.currentCoords[curIdx];
                const b2 = vertexEditState.currentCoords[curIdx + 1];
                if (!a2 || !b2) return;
                // Insert new vertex at the midpoint of segment (curIdx, curIdx+1)
                // → goes into currentCoords at position (curIdx + 1).
                const newVert = { lat: (a2.lat + b2.lat) / 2, lng: (a2.lng + b2.lng) / 2 };
                vertexEditState.currentCoords.splice(curIdx + 1, 0, newVert);
                rebuildVertexHandles();
                showKMLToast(`Vertex inserted — ${vertexEditState.currentCoords.length} now. Drag the new cyan handle to position.`, 4500);
                updateVertexEditToolbarLabel();
                if (isActive) runUpdate();
            });
            vertexEditState.midhandles.push(marker);
        }
    }

    function enterVertexEdit(type, pmIdx) {
        if (vertexEditState) exitVertexEdit({ save: false, silent: true });
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded.', 3000); return; }
        const features = kmlFeatures[kmlKey(siteID, type)];
        if (!features) { showKMLToast('KML not loaded yet — try again in a moment.', 3500); return; }
        const feature = features.find(f => f.pmIdx === pmIdx && f.type === 'line');
        if (!feature) {
            showKMLToast('Vertex edit is only supported on line features.', 4000);
            return;
        }
        const map = getLeafletMap();
        if (!map) { showKMLToast('Map not ready — try again in a moment.', 3000); return; }
        let L;
        try { L = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).L; } catch (e) { L = null; }
        if (!L || typeof L.marker !== 'function' || typeof L.divIcon !== 'function') {
            showKMLToast('Leaflet not available — cannot add drag handles.', 4000);
            return;
        }
        // Use already-modified coords as the starting point if a modify op
        // exists, so re-edit picks up where the user left off (not a reset
        // to original).
        const startCoords = effectiveCoordsForFeature(siteID, type, pmIdx, feature.coords);
        vertexEditState = {
            type, pmIdx,
            originalCoords: feature.coords.map(c => ({ lat: c.lat, lng: c.lng })),
            currentCoords: startCoords.map(c => ({ lat: c.lat, lng: c.lng })),
            handles: [],
            toolbarEl: null,
        };
        // v34.57: delegate handle creation to rebuildVertexHandles
        // (shared with enterAddedVertexEdit + add/delete-vertex paths).
        // Builds both real cyan handles AND ghost midpoint handles.
        vertexEditState.handles = [];
        vertexEditState.midhandles = [];
        rebuildVertexHandles();
        buildVertexEditToolbar();
        showKMLToast(`Editing ${type} line #${pmIdx} — drag handles · click a dim midpoint to add vertex · M2 a handle to delete · Ctrl+click a handle to branch a new line · Save/Discard from toolbar.`, 7500);
        if (isActive) runUpdate();
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    // E4.1 (v34.47) — Vertex edit for a saved-but-uncommitted "green" line
    // that lives in commitOps.added (not in the original KML). Same UX as
    // enterVertexEdit, but reads coords from co.added[addedIdx] and writes
    // them back there on Save (not into co.ops as a modify).
    //
    // Live-drag feedback: when this is active, the render loop pulls coords
    // from vertexEditState.currentCoords instead of co.added[addedIdx].coords
    // (see the `co.added.forEach` block in shieldingFeaturePointsInSVG —
    // it checks vertexEditState.isAdded before reading from the array).
    function enterAddedVertexEdit(type, addedIdx) {
        if (vertexEditState) exitVertexEdit({ save: false, silent: true });
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded.', 3000); return; }
        const co = getCommitOps(siteID, type);
        const added = co.added && co.added[addedIdx];
        if (!added || !Array.isArray(added.coords) || added.coords.length < 2) {
            showKMLToast('Pending-add line not found or invalid.', 4000);
            return;
        }
        const map = getLeafletMap();
        if (!map) { showKMLToast('Map not ready — try again in a moment.', 3000); return; }
        let L;
        try { L = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).L; } catch (e) { L = null; }
        if (!L || typeof L.marker !== 'function' || typeof L.divIcon !== 'function') {
            showKMLToast('Leaflet not available — cannot add drag handles.', 4000);
            return;
        }
        // co.added stores [[lng,lat],...] (KML order). Convert to {lat,lng}
        // for the handle math (same shape file lines use).
        const startCoords = added.coords.map(c => ({ lat: c[1], lng: c[0] }));
        vertexEditState = {
            type,
            addedIdx,
            isAdded: true,
            addedName: added.name || '(unnamed)',
            originalCoords: startCoords.map(c => ({ lat: c.lat, lng: c.lng })),
            currentCoords: startCoords.map(c => ({ lat: c.lat, lng: c.lng })),
            handles: [],
            toolbarEl: null,
        };
        // v34.57: delegate handle creation to rebuildVertexHandles.
        vertexEditState.handles = [];
        vertexEditState.midhandles = [];
        rebuildVertexHandles();
        buildVertexEditToolbar();
        showKMLToast(`Editing new ${type} line "${vertexEditState.addedName}" — drag handles · click a dim midpoint to add vertex · M2 a handle to delete · Ctrl+click a handle to branch a new line · Save/Discard.`, 7500);
        if (isActive) runUpdate();
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    function buildVertexEditToolbar() {
        if (!vertexEditState) return;
        const tb = document.createElement('div');
        tb.id = 'aim-vertex-edit-toolbar';
        tb.style.cssText = `
            position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
            background:#1f2228;border:2px solid #14d2dc;border-radius:8px;
            padding:10px 16px;z-index:99999;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;display:flex;align-items:center;gap:12px;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
        `;
        const label = document.createElement('span');
        // v34.47: handle pending-add lines too. They have addedIdx
        // (and isAdded) instead of pmIdx — show "new <type> '<name>'".
        label.textContent = vertexEditState.isAdded
            ? `Editing new ${vertexEditState.type} line "${vertexEditState.addedName}" · ${vertexEditState.currentCoords.length} vertices`
            : `Editing ${vertexEditState.type} #${vertexEditState.pmIdx} · ${vertexEditState.currentCoords.length} vertices`;
        label.style.cssText = 'color:#7adfe6;font-weight:600';
        tb.appendChild(label);
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '✓ Save edits';
        saveBtn.style.cssText = 'padding:7px 14px;background:#5fff5f;color:#000;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700';
        saveBtn.onclick = () => exitVertexEdit({ save: true });
        tb.appendChild(saveBtn);
        const discardBtn = document.createElement('button');
        discardBtn.textContent = '✗ Discard';
        discardBtn.style.cssText = 'padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
        discardBtn.onclick = () => exitVertexEdit({ save: false });
        tb.appendChild(discardBtn);
        document.body.appendChild(tb);
        vertexEditState.toolbarEl = tb;
    }

    function exitVertexEdit(opts) {
        if (!vertexEditState) return;
        const save = !!(opts && opts.save);
        const silent = !!(opts && opts.silent);
        const { type, pmIdx, addedIdx, isAdded, addedName,
                currentCoords, originalCoords, handles, midhandles, toolbarEl } = vertexEditState;
        if (save) {
            // Skip writing a no-op modify if nothing actually moved (within
            // tolerance — float drift from drag-end serialization shouldn't
            // create a phantom commit).
            const changed = currentCoords.length !== originalCoords.length ||
                            currentCoords.some((c, i) =>
                                Math.abs(c.lat - originalCoords[i].lat) > 1e-9 ||
                                Math.abs(c.lng - originalCoords[i].lng) > 1e-9);
            if (changed) {
                const siteID = getCurrentSiteID();
                const co = getCommitOps(siteID, type);
                if (isAdded) {
                    // v34.47: pending-add line edit → write coords back to
                    // co.added[addedIdx]. The line stays in co.added (still
                    // green/pending). Commit pushes the new coords to GitHub.
                    if (co.added && co.added[addedIdx]) {
                        co.added[addedIdx].coords = currentCoords.map(c => [c.lng, c.lat]);
                        setCommitOps(siteID, type, co);
                    }
                    const count = commitOpsCount(siteID, type);
                    if (!silent) showKMLToast(`Saved vertex edits to new ${type} line "${addedName}". ${count} pending commit${count === 1 ? '' : 's'} — commit from the panel.`, 5500);
                } else {
                    // v34.65: don't blow away a pending delete op with a
                    // modify. Previously this silently overwrote co.ops[pmIdx]
                    // so a "Mark for deletion" set during the same vertex
                    // edit session would vanish when the user hit Save.
                    const existingOp = co.ops[String(pmIdx)];
                    if (existingOp && existingOp.op === 'delete') {
                        if (!silent) showKMLToast(`${type} #${pmIdx} is marked for deletion — vertex edits discarded. Unmark deletion first if you want to keep edits.`, 6500);
                    } else {
                        co.ops[String(pmIdx)] = {
                            op: 'modify',
                            coords: currentCoords.map(c => [c.lng, c.lat]),
                        };
                        setCommitOps(siteID, type, co);
                        const count = commitOpsCount(siteID, type);
                        if (!silent) showKMLToast(`Saved vertex edits to ${type} #${pmIdx}. ${count} pending commit${count === 1 ? '' : 's'} — commit from the panel.`, 5500);
                    }
                }
            } else {
                if (!silent) showKMLToast(`No vertex changes to save.`, 2500);
            }
        } else {
            if (!silent) showKMLToast(`Discarded vertex edits.`, 3000);
        }
        handles.forEach(h => { try { h.remove(); } catch (e) {} });
        // v34.57: also remove ghost midpoint handles
        (midhandles || []).forEach(h => { try { h.remove(); } catch (e) {} });
        if (toolbarEl) { try { toolbarEl.remove(); } catch (e) {} }
        vertexEditState = null;
        clearSnapIndicator();
        if (isActive) runUpdate();
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    // ============================================================
    // E4 — Draw new line (click-to-add-vertex mode)
    //
    // Entry: enterDrawMode(type) — attaches Leaflet click handler to
    // the map; each click appends [lng,lat] to drawingState.coords.
    // Floating toolbar shows running vertex count + Save/Undo/Cancel.
    // Esc cancels.
    //
    // Save → opens a name input modal → on confirm, appends
    //   { name, coords:[[lng,lat],...] } to commitOps.added.
    // The next "Commit pending changes" batches it with any other ops.
    //
    // Drawing-in-progress line renders dashed-green (preview).
    // Saved-but-pending added lines render solid green.
    // Only one drawing session at a time across both types.
    // ============================================================
    function enterDrawMode(type, seedCoord) {
        if (drawingState) exitDrawMode({ silent: true });
        if (vertexEditState) exitVertexEdit({ save: false, silent: true });
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded.', 3000); return; }
        const map = getLeafletMap();
        if (!map || typeof map.on !== 'function') { showKMLToast('Map not ready.', 3000); return; }
        drawingState = { type, coords: [], clickHandler: null, escHandler: null, toolbarEl: null, seeded: false };
        // v34.61 Phase 3a: branch-from-vertex. If a seedCoord is provided,
        // push it as the first vertex of the new line so the line starts
        // attached to the source vertex. drawingState.seeded marks the
        // branch flavor for the toolbar label.
        if (seedCoord && Number.isFinite(seedCoord.lat) && Number.isFinite(seedCoord.lng)) {
            drawingState.coords.push([seedCoord.lng, seedCoord.lat]);
            drawingState.seeded = true;
        }
        const onClick = (e) => {
            if (!drawingState) return;
            const ll = e.latlng;
            if (!ll) return;
            let lat = ll.lat, lng = ll.lng;
            // v34.63 Phase 3b: snap click placement to nearby vertex.
            // Excludes our own in-progress draw line.
            const snap = findSnapCandidate({ lat, lng }, 'draw');
            if (snap) { lat = snap.lat; lng = snap.lng; }
            clearSnapIndicator();
            drawingState.coords.push([lng, lat]);
            updateDrawToolbar();
            if (isActive) runUpdate();
        };
        try { map.on('click', onClick); } catch (e) {}
        drawingState.clickHandler = onClick;
        // v34.63 Phase 3b: live snap-preview during draw — show the
        // yellow ring under the cursor when within tolerance so the
        // user knows their next click will snap.
        const onMove = (e) => {
            if (!drawingState) return;
            const ll = e.latlng;
            if (!ll) return;
            const snap = findSnapCandidate({ lat: ll.lat, lng: ll.lng }, 'draw');
            const m = getLeafletMap();
            if (snap && m) showSnapIndicator(m, snap);
            else clearSnapIndicator();
        };
        try { map.on('mousemove', onMove); } catch (e) {}
        drawingState.moveHandler = onMove;
        const onEsc = (e) => { if (e.key === 'Escape') exitDrawMode({ silent: false }); };
        window.addEventListener('keydown', onEsc, true);
        drawingState.escHandler = onEsc;
        // Crosshair cursor so it's obvious clicks are being captured
        const container = map.getContainer ? map.getContainer() : null;
        if (container) container.style.cursor = 'crosshair';
        buildDrawToolbar();
        if (drawingState.seeded && isActive) runUpdate();
        // v34.46: removed the showKMLToast announcement — the floating
        // green draw-toolbar (with vertex count + Save/Undo/Cancel) is
        // already on-screen and tells the user the same thing without
        // covering the map. User feedback: "I like the green one better".
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    function buildDrawToolbar() {
        if (!drawingState) return;
        const tb = document.createElement('div');
        tb.id = 'aim-draw-toolbar';
        tb.style.cssText = `
            position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
            background:#1f2228;border:2px solid #5fff5f;border-radius:8px;
            padding:10px 16px;z-index:99999;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;display:flex;align-items:center;gap:12px;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
        `;
        const label = document.createElement('span');
        label.id = 'aim-draw-label';
        const initN = drawingState.coords.length;
        label.textContent = drawingState.seeded
            ? `Branching new ${drawingState.type} line · ${initN} vertex${initN === 1 ? '' : 'es'}${initN < 2 ? ' (need ≥2 — click to add)' : ''}`
            : `Drawing ${drawingState.type} line · 0 vertices (need ≥2)`;
        label.style.cssText = 'color:#5fff5f;font-weight:600';
        tb.appendChild(label);
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '✓ Save';
        saveBtn.setAttribute('data-role', 'save');
        saveBtn.style.cssText = 'padding:7px 14px;background:#5fff5f;color:#000;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700;opacity:0.4';
        saveBtn.disabled = true;
        saveBtn.onclick = () => finishDrawing();
        tb.appendChild(saveBtn);
        const undoBtn = document.createElement('button');
        undoBtn.textContent = '↶ Undo vertex';
        undoBtn.style.cssText = 'padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
        undoBtn.onclick = () => {
            if (!drawingState || drawingState.coords.length === 0) return;
            drawingState.coords.pop();
            updateDrawToolbar();
            if (isActive) runUpdate();
        };
        tb.appendChild(undoBtn);
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '✗ Cancel';
        cancelBtn.style.cssText = 'padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
        cancelBtn.onclick = () => exitDrawMode({ silent: false });
        tb.appendChild(cancelBtn);
        document.body.appendChild(tb);
        drawingState.toolbarEl = tb;
    }

    function updateDrawToolbar() {
        if (!drawingState || !drawingState.toolbarEl) return;
        const n = drawingState.coords.length;
        const label = drawingState.toolbarEl.querySelector('#aim-draw-label');
        if (label) {
            const verb = drawingState.seeded ? 'Branching new' : 'Drawing';
            label.textContent = `${verb} ${drawingState.type} line · ${n} vertex${n === 1 ? '' : 'es'}${n < 2 ? ' (need ≥2)' : ''}`;
        }
        const saveBtn = drawingState.toolbarEl.querySelector('button[data-role="save"]');
        if (saveBtn) {
            saveBtn.disabled = n < 2;
            saveBtn.style.opacity = saveBtn.disabled ? '0.4' : '1';
            saveBtn.style.cursor = saveBtn.disabled ? 'not-allowed' : 'pointer';
        }
    }

    function finishDrawing() {
        if (!drawingState || drawingState.coords.length < 2) return;
        const type = drawingState.type;
        const coords = drawingState.coords.slice();
        showNameInputModal(type, (name) => {
            if (name === null) return; // user cancelled the name modal
            const siteID = getCurrentSiteID();
            if (!siteID) { showKMLToast('No site loaded — drawing discarded.', 4000); exitDrawMode({ silent: true }); return; }
            const co = getCommitOps(siteID, type);
            const finalName = (name && name.trim()) || `New ${type} line (added ${new Date().toISOString().substring(0, 10)})`;
            co.added.push({ name: finalName, coords });
            setCommitOps(siteID, type, co);
            const count = commitOpsCount(siteID, type);
            showKMLToast(`Added new ${type} line "${finalName}". ${count} pending commit${count === 1 ? '' : 's'} — commit from the panel.`, 6000);
            exitDrawMode({ silent: true });
        });
    }

    function exitDrawMode(opts) {
        if (!drawingState) return;
        const silent = !!(opts && opts.silent);
        const { clickHandler, moveHandler, escHandler, toolbarEl } = drawingState;
        const map = getLeafletMap();
        if (map && clickHandler) { try { map.off('click', clickHandler); } catch (e) {} }
        if (map && moveHandler) { try { map.off('mousemove', moveHandler); } catch (e) {} }
        if (escHandler) { try { window.removeEventListener('keydown', escHandler, true); } catch (e) {} }
        if (toolbarEl) { try { toolbarEl.remove(); } catch (e) {} }
        const container = map && map.getContainer ? map.getContainer() : null;
        if (container) container.style.cursor = '';
        if (!silent) showKMLToast('Drawing cancelled.', 2500);
        drawingState = null;
        clearSnapIndicator();
        if (isActive) runUpdate();
        try { broadcastPowerLineStatus(); } catch (e) {}
    }

    // Small modal for naming a newly-drawn line. Optional input;
    // callback receives the entered string (possibly empty, never
    // trimmed) on Save, or null on Cancel. Enter saves, Esc cancels.
    function showNameInputModal(type, callback) {
        const existing = document.getElementById('aim-name-modal');
        if (existing) existing.remove();
        const backdrop = document.createElement('div');
        backdrop.id = 'aim-name-modal';
        backdrop.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,0,0.55);
            z-index:99999;display:flex;align-items:center;justify-content:center;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        `;
        const box = document.createElement('div');
        box.style.cssText = `
            background:#1f2228;border:2px solid #14d2dc;border-radius:8px;
            padding:22px;min-width:360px;max-width:80vw;color:#e6e6e6;
            box-shadow:0 8px 28px rgba(0,0,0,0.6);
        `;
        const title = document.createElement('div');
        title.textContent = `Name for the new ${type} line (optional):`;
        title.style.cssText = 'margin-bottom:10px;color:#7adfe6;font-size:13px;text-transform:uppercase;letter-spacing:0.5px';
        box.appendChild(title);
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = `e.g. Mainline 3940 spur`;
        input.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 10px;background:#0f1216;border:1px solid #3a3f48;border-radius:4px;color:#e6e6e6;font:inherit;font-size:14px;margin-bottom:16px';
        box.appendChild(input);
        const helper = document.createElement('div');
        helper.style.cssText = 'font-size:11px;color:#888;margin-bottom:14px';
        helper.textContent = 'Leave blank to auto-name. Enter to save, Esc to cancel.';
        box.appendChild(helper);
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'padding:8px 16px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
        cancelBtn.onclick = () => { try { backdrop.remove(); } catch (e) {} callback(null); };
        btns.appendChild(cancelBtn);
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save line';
        saveBtn.style.cssText = 'padding:8px 16px;background:#5fff5f;color:#000;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700';
        saveBtn.onclick = () => { const v = input.value; try { backdrop.remove(); } catch (e) {} callback(v); };
        btns.appendChild(saveBtn);
        box.appendChild(btns);
        backdrop.appendChild(box);
        document.body.appendChild(backdrop);
        setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
        });
    }

    // Right-click on a pending-add line — only option is Discard
    // (no hide/delete/modify since the line doesn't exist on disk yet).
    function showAddedLineContextMenu(x, y, type, addedIdx) {
        closeKMLContextMenu();
        const siteID = getCurrentSiteID();
        if (!siteID) return;
        const co = getCommitOps(siteID, type);
        const item = co.added[addedIdx];
        if (!item) return;
        const menu = document.createElement('div');
        menu.id = KML_CTX_MENU_ID;
        menu.style.cssText = `
            position:fixed;left:${x}px;top:${y}px;z-index:99999;
            background:#1f2228;border:1px solid rgba(95,255,95,0.5);border-radius:6px;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
            padding:4px 0;min-width:200px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;
        `;
        const header = document.createElement('div');
        header.style.cssText = 'padding:4px 12px;color:#5fff5f;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:2px';
        header.textContent = `NEW ${type === 'distro' ? 'Distribution' : 'Transmission'} line (pending)`;
        menu.appendChild(header);
        const nameLine = document.createElement('div');
        nameLine.style.cssText = 'padding:4px 12px;color:#9ad;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:2px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        nameLine.textContent = item.name || '(no name)';
        menu.appendChild(nameLine);
        const discardAction = document.createElement('button');
        discardAction.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 12px;background:transparent;border:none;color:#ff8585;cursor:pointer;font:inherit';
        discardAction.onmouseenter = () => { discardAction.style.background = 'rgba(255,80,80,0.18)'; };
        discardAction.onmouseleave = () => { discardAction.style.background = 'transparent'; };
        discardAction.textContent = '🗑  Discard this new line';
        discardAction.onclick = (e) => {
            e.stopPropagation();
            const co2 = getCommitOps(siteID, type);
            co2.added.splice(addedIdx, 1);
            setCommitOps(siteID, type, co2);
            const count = commitOpsCount(siteID, type);
            showKMLToast(`Discarded new ${type} line. ${count} pending commit${count === 1 ? '' : 's'}.`, 3500);
            closeKMLContextMenu();
            if (isActive) runUpdate();
        };
        menu.appendChild(discardAction);
        document.body.appendChild(menu);
        const r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 4}px`;
        if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 4}px`;
        setTimeout(() => {
            kmlMenuOutsideListener = (e) => {
                if (menu.contains(e.target)) return;
                closeKMLContextMenu();
            };
            document.addEventListener('mousedown', kmlMenuOutsideListener, true);
        }, 0);
    }

    // Converts the current site's KML features into SVG-user-space point
    // arrays using the Leaflet map's projection. Returns [] if the map
    // isn't available yet (the next runUpdate will retry).
    // Cached per-tick by callers if they need it twice.
    function shieldingFeaturePointsInSVG(type) {
        const siteID = getCurrentSiteID();
        if (!siteID) return [];
        const features = kmlFeatures[kmlKey(siteID, type)] || [];
        const co = getCommitOps(siteID, type);
        const hasDrawing = drawingState && drawingState.type === type && drawingState.coords.length >= 2;
        // Bail only if there's truly nothing to render — file empty AND
        // no pending-add lines AND no drawing in progress.
        if (!features.length && !co.added.length && !hasDrawing) return [];
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
        const projectCoords = (coordsArr) => {
            // latLngToContainerPoint = pixel offset from the map container's
            // top-left, accounting for all current pan/zoom. Add container's
            // screen position, then invert SVG CTM to land in SVG user space.
            const pts = [];
            for (let i = 0; i < coordsArr.length; i++) {
                const c = coordsArr[i];
                let cp;
                try { cp = map.latLngToContainerPoint([c.lat, c.lng]); } catch (e) { continue; }
                if (!cp) continue;
                const svgPt = svg.createSVGPoint();
                svgPt.x = cRect.left + cp.x;
                svgPt.y = cRect.top + cp.y;
                const p = svgPt.matrixTransform(inv);
                pts.push({ x: p.x, y: p.y });
            }
            return pts;
        };
        const out = [];
        // 1. File features (with effective coords from active edit / saved modify)
        features.forEach(f => {
            const coords = effectiveCoordsForFeature(siteID, type, f.pmIdx, f.coords);
            const pts = projectCoords(coords);
            if (pts.length >= 2) out.push({
                type: f.type, points: pts,
                pmIdx: f.pmIdx, visible: f.visible,
            });
        });
        // 2. Pending-add lines from commitOps.added. v34.47: if THIS
        // added line is currently in vertex edit, pull coords from
        // vertexEditState.currentCoords for live-drag visual feedback.
        co.added.forEach((added, addedIdx) => {
            if (!Array.isArray(added.coords) || added.coords.length < 2) return;
            let coords;
            if (vertexEditState && vertexEditState.isAdded &&
                vertexEditState.type === type && vertexEditState.addedIdx === addedIdx) {
                coords = vertexEditState.currentCoords;
            } else {
                coords = added.coords.map(c => ({ lat: c[1], lng: c[0] }));
            }
            const pts = projectCoords(coords);
            if (pts.length >= 2) out.push({
                type: 'line', points: pts,
                addedIdx, visible: true,
            });
        });
        // 3. Drawing in progress (preview)
        if (hasDrawing) {
            const coords = drawingState.coords.map(c => ({ lat: c[1], lng: c[0] }));
            const pts = projectCoords(coords);
            if (pts.length >= 2) out.push({
                type: 'line', points: pts,
                drawing: true, visible: true,
            });
        }
        return out;
    }

    // Leaflet creates the overlay-pane <svg> LAZILY — only when the first
    // vector layer (Path/Polyline/Polygon) is added to the map. On a site
    // with zero native Percepto entities (a brand-new site that's just
    // ortho + power lines, e.g. 1591) Percepto adds no vector layer, so
    // Leaflet never builds the SVG and our KML shielding has nowhere to
    // draw — every renderShielding() bails at the `if (!svg) return`.
    // (Diagnosed 2026-06-08: KML loaded 827 features but rendered nothing
    // until the user dropped an FFZ, which created the SVG.) Fix: force
    // Leaflet to make its SVG renderer ourselves. L.svg().addTo(map) builds
    // the <svg><g></g> structure synchronously and keeps its transform /
    // viewBox synced on zoom/pan, so the existing getScreenCTM +
    // latLngToContainerPoint projection keeps working unchanged.
    function ensureOverlaySvg() {
        if (document.querySelector('.leaflet-overlay-pane svg')) return true;
        const map = getLeafletMap();
        if (!map) return false;
        let L;
        try { L = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).L; } catch (e) { L = null; }
        if (!L || typeof L.svg !== 'function') return false;
        try {
            L.svg().addTo(map);
            console.log(`${TAG} created overlay-pane SVG renderer (site has no native vector layers yet)`);
        } catch (e) {
            console.error(`${TAG} failed to force overlay-pane SVG:`, e);
            return false;
        }
        return !!document.querySelector('.leaflet-overlay-pane svg');
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
        // If we have features to draw but Leaflet hasn't made the overlay
        // SVG (entity-less site), make it ourselves before querying for it.
        const haveFeatures = KML_TYPES.some(t => (kmlFeatures[kmlKey(siteID, t)] || []).length > 0);
        if (haveFeatures) ensureOverlaySvg();
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
        // E1 editing state — only relevant when at least one of edit-mode
        // or show-hidden is on. pointer-events stays 'none' otherwise so
        // Leaflet's own interaction (drag-pan over an empty area) isn't
        // intercepted by our overlay paths.
        const editMode = toggleState[`${type}.edit-mode`] === true;
        const showHidden = toggleState[`${type}.show-hidden`] === true;
        const siteID = getCurrentSiteID();
        feats.forEach(f => {
            // E4: pending-add lines and drawing-in-progress preview render
            // ahead of all the file-feature visual logic (no pmIdx, no hide
            // check). Always visible.
            if (f.addedIdx !== undefined || f.drawing) {
                const d = pointsToPathD(f.points, false);
                if (!d) return;
                const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                p.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
                p.setAttribute('data-buffer-kind', `kml-${type}`);
                p.setAttribute('data-kml-type', type);
                p.setAttribute('d', d);
                p.setAttribute('fill', 'none');
                p.setAttribute('stroke', '#5fff5f');
                p.setAttribute('stroke-linejoin', 'round');
                p.setAttribute('stroke-linecap', 'round');
                if (f.addedIdx !== undefined) {
                    // Saved pending-add → solid green, slightly thicker
                    p.setAttribute('data-kml-added-idx', String(f.addedIdx));
                    p.setAttribute('stroke-opacity', '0.95');
                    p.setAttribute('stroke-width', String(thickness + 1));
                    // v34.59: ALWAYS clickable — these are transient user-
                    // drawn lines that haven't been committed yet. There's
                    // no scenario where the user wants them un-interactive
                    // (M1 = edit vertices, M2 = discard menu). Previously
                    // gated on editMode but green lines silently lost
                    // clickability in some setups even with edit mode on
                    // (yellow lines worked from the same render — root
                    // cause unclear, this is the brute-force fix).
                    p.setAttribute('class', 'leaflet-interactive');
                    p.setAttribute('pointer-events', 'visibleStroke');
                } else {
                    // Drawing-in-progress preview → dashed green, no right-click
                    p.setAttribute('stroke-opacity', '0.85');
                    p.setAttribute('stroke-width', String(thickness));
                    p.setAttribute('stroke-dasharray', '6 4');
                    p.setAttribute('pointer-events', 'none');
                }
                if (g.firstChild) g.insertBefore(p, g.firstChild);
                else g.appendChild(p);
                return;
            }
            const isVis = effectiveVisible(siteID, type, f.pmIdx, f.visible);
            const commitOp = getOpForPlacemark(siteID, type, f.pmIdx);
            // Marked-for-commit lines ALWAYS render (even if user has them
            // locally hidden) — otherwise they'd commit a delete on something
            // they can't see, which is dangerous. Override hide for them.
            if (!isVis && !showHidden && !commitOp) return;
            const d = pointsToPathD(f.points, f.type === 'polygon');
            if (!d) return;
            const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            p.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
            p.setAttribute('data-buffer-kind', `kml-${type}`);
            p.setAttribute('data-kml-type', type);
            p.setAttribute('data-kml-pm-idx', String(f.pmIdx));
            p.setAttribute('d', d);
            p.setAttribute('fill', 'none');
            if (commitOp && commitOp.op === 'delete') {
                // Marked for deletion → red, thicker, dashed strikethrough.
                // Distinct from local-hide (gray dash) so the user can
                // tell at a glance which is which.
                p.setAttribute('stroke', '#ff3838');
                p.setAttribute('stroke-opacity', '0.95');
                p.setAttribute('stroke-width', String(thickness + 2));
                p.setAttribute('stroke-dasharray', '10 4');
            } else if (commitOp && commitOp.op === 'modify') {
                // Modified vertices → yellow/amber, slightly thicker, solid.
                // Distinct from delete (red dashed) and hide (gray dashed).
                p.setAttribute('stroke', '#ffd96b');
                p.setAttribute('stroke-opacity', '0.95');
                p.setAttribute('stroke-width', String(thickness + 1));
            } else if (!isVis) {
                // Ghost-render: dashed in the user's hidden-color over the
                // line's true placement. Width matches normal thickness so
                // the right-click hit-target is identical to a visible
                // line. Default color is gray; user can tweak per-category.
                const hiddenColor = toggleState[`${type}.hidden-color`] || '#888888';
                p.setAttribute('stroke', hiddenColor);
                p.setAttribute('stroke-opacity', '0.7');
                p.setAttribute('stroke-width', String(thickness));
                p.setAttribute('stroke-dasharray', '6 6');
            } else {
                p.setAttribute('stroke', stroke);
                p.setAttribute('stroke-opacity', opStr);
                p.setAttribute('stroke-width', String(thickness));
            }
            // Merge selection wins over every other state — bright magenta,
            // thick, solid — so the user can see exactly which lines will be
            // stitched together when they hit ⛓✓.
            if (isMergeSelected(type, f.pmIdx)) {
                p.setAttribute('stroke', '#ff5cf0');
                p.setAttribute('stroke-opacity', '1');
                p.setAttribute('stroke-width', String(thickness + 3));
                p.removeAttribute('stroke-dasharray');
            }
            p.setAttribute('stroke-linejoin', 'round');
            p.setAttribute('stroke-linecap', 'round');
            // Leaflet sets `pointer-events: none` on the overlay-pane SVG by
            // default. Its own interactive paths use the `leaflet-interactive`
            // class which has a CSS rule `pointer-events: visibleStroke` —
            // overriding the parent's none. Without this class our paths
            // inherit none and right-clicks fall through to Leaflet's own
            // canvas/path under us. Only add it when in edit mode so we
            // don't intercept Leaflet's drag-pan otherwise.
            if (editMode) {
                p.setAttribute('class', 'leaflet-interactive');
                p.setAttribute('pointer-events', 'visibleStroke');
            } else {
                p.setAttribute('pointer-events', 'none');
            }
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
        const segments = buildShieldingSegments(siteID, map);
        if (!segments.length) {
            console.warn(`${TAG} validator: no shielding loaded for site ${siteID}`);
            validatorState.lastRun = { error: 'No shielding KMLs loaded for this site', at: Date.now() };
            runUpdate();
            return;
        }

        const thresholdFt = Number(toggleState['validator.distance']) || 200;
        const thresholdPx = ftToPx(map, thresholdFt);
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
                kind: 'gap',
                number: i + 1,
                midLat: mid.lat,
                midLng: mid.lng,
                segments: segsLL,
                dismissed: false,
            };
        });

        // Replace ONLY the FFZ/FP gap pins; leave Asset Shielding Check pins
        // (kind:'asset') untouched so the two tests stay independent.
        validatorState.results = results.concat(validatorState.results.filter(r => r.kind === 'asset'));
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
        const before = validatorState.results.length;
        // Clear gap pins only — keep Asset Shielding Check pins (kind:'asset').
        validatorState.results = validatorState.results.filter(r => r.kind === 'asset');
        validatorState.lastRun = null;
        saveValidatorResults();
        console.log(`${TAG} validator: cleared ${before - validatorState.results.length} pin(s)`);
        runUpdate();
    }

    // ----- Shared shielding/geometry helpers (used by both Coverage Validator
    // and Asset Shielding Check) -----

    // Power-line KMLs as LINE SEGMENTS in layer-point space. Measuring against
    // segments (not just vertices) is what stopped the validator from falsely
    // flagging points near the MIDDLE of a long two-vertex segment (v32.2 bug).
    function buildShieldingSegments(siteID, map) {
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
                // KML LinearRing repeats its first point as the last, so the
                // loop above naturally closes the ring — no extra segment.
            });
        });
        return segments;
    }

    // Feet → layer-point pixels at the map's current center. Web Mercator scale
    // varies with latitude, but within one site the variation is negligible.
    function ftToPx(map, ft) {
        const centerLL = map.getCenter();
        const latPerFt = 1 / 362776; // 1 deg lat ≈ 362,776 ft
        const lpA = map.latLngToLayerPoint(centerLL);
        const lpB = map.latLngToLayerPoint({ lat: centerLL.lat + ft * latPerFt, lng: centerLL.lng });
        return Math.hypot(lpB.x - lpA.x, lpB.y - lpA.y);
    }

    // Fetch every asset (type 3) with its name + polygon centroid. Independent
    // of the "color assets by state" feature so the Asset Shielding Check works
    // whether or not that toggle is on. Cookie auth, same endpoint.
    function fetchAssetCentroids(siteID) {
        return fetch(MAP_OBJECTS_URL + encodeURIComponent(siteID), { credentials: 'include' })
            .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
            .then(data => {
                const list = Array.isArray(data) ? data : ((data && data.results) || []);
                const out = [];
                list.forEach(e => {
                    if (!e || e.type !== 3) return;
                    const raw = Array.isArray(e.coords) ? e.coords
                              : (Array.isArray(e.points) ? e.points : []);
                    const pts = raw.filter(c => c && typeof c.lat === 'number' && typeof c.lng === 'number');
                    if (pts.length < 3) return;
                    let sLat = 0, sLng = 0;
                    pts.forEach(p => { sLat += p.lat; sLng += p.lng; });
                    // Already-Unshielded per Percepto's own data: the is_unshielded
                    // flag OR "...- Unshielded" in the subtype string (poi_type_str).
                    const sub = (e.custom && e.custom.poi_type_str) ? String(e.custom.poi_type_str) : '';
                    out.push({
                        name: e.name || (e.custom && e.custom.name) || `asset ${e.id}`,
                        cLat: sLat / pts.length,
                        cLng: sLng / pts.length,
                        alreadyUnshielded: !!e.is_unshielded || /unshielded/i.test(sub),
                    });
                });
                return out;
            });
    }

    // Asset Shielding Check: an asset is "shielded" if its centroid sits within
    // (power-line radius + asset radius) ft of any power-line KML — default
    // 200 + 200 = 400 ft. Assets beyond that are flagged Unshielded so we know
    // which ones the SS Generator must build FFZs on. Power-line KMLs are the
    // only shielding source. Fully independent of the FFZ/FP Coverage Validator.
    async function runAssetCoverageValidator() {
        const map = getLeafletMap();
        if (!map) {
            const containers = document.querySelectorAll('.leaflet-container');
            console.warn(`${TAG} asset-validator: Leaflet map not accessible (patched=${leafletPatched}, .leaflet-container count=${containers.length})`);
            assetValidatorLastRun = { error: 'Leaflet map not accessible — see console for diagnostics', at: Date.now() };
            return;
        }
        const siteID = getCurrentSiteID();
        if (!siteID) {
            assetValidatorLastRun = { error: 'No site ID in URL', at: Date.now() };
            return;
        }

        const segments = buildShieldingSegments(siteID, map);
        if (!segments.length) {
            console.warn(`${TAG} asset-validator: no shielding loaded for site ${siteID}`);
            assetValidatorLastRun = { error: 'No power-line KMLs loaded for this site', at: Date.now() };
            runUpdate();
            return;
        }

        let assets;
        try {
            assets = await fetchAssetCentroids(siteID);
        } catch (err) {
            console.warn(`${TAG} asset-validator: asset fetch failed for site ${siteID}:`, err);
            assetValidatorLastRun = { error: 'Asset fetch failed — see console', at: Date.now() };
            return;
        }
        // The user may have navigated away while the fetch was in flight.
        if (getCurrentSiteID() !== siteID) return;
        if (!assets.length) {
            console.warn(`${TAG} asset-validator: no assets found on site ${siteID}`);
            assetValidatorLastRun = { error: 'No assets found on this site', at: Date.now() };
            runUpdate();
            return;
        }

        const plRadiusFt = Number(toggleState['asset-validator.powerline-radius']);
        const assetRadiusFt = Number(toggleState['asset-validator.asset-radius']);
        const thresholdFt = (isFinite(plRadiusFt) ? plRadiusFt : 200)
                          + (isFinite(assetRadiusFt) ? assetRadiusFt : 200);
        const thresholdPx = ftToPx(map, thresholdFt);
        const t2 = thresholdPx * thresholdPx;
        const ftPerPx = thresholdPx > 0 ? thresholdFt / thresholdPx : 0;

        // Skip assets Percepto already marks Unshielded (no point re-flagging
        // what we already know) — on by default, toggleable in the panel.
        const skipUnshielded = toggleState['asset-validator.skip-unshielded'] !== false;

        const startTime = Date.now();
        const unshielded = [];
        let skipped = 0;
        const allDistances = []; // every asset's nearest-line distance, for calibration
        assets.forEach(a => {
            let lp;
            try { lp = map.latLngToLayerPoint([a.cLat, a.cLng]); } catch (e) { return; }
            let best2 = Infinity;
            for (let j = 0; j < segments.length; j++) {
                const s = segments[j];
                const d2 = pointToSegmentDist2(lp.x, lp.y, s.ax, s.ay, s.bx, s.by);
                if (d2 < best2) best2 = d2;
            }
            const distFt = Math.round(Math.sqrt(best2) * ftPerPx);
            const skip = skipUnshielded && a.alreadyUnshielded;
            if (skip) skipped++;
            allDistances.push({ name: a.name, distFt, skip, far: best2 > t2 });
            if (!skip && best2 > t2) unshielded.push({ a, distFt });
        });

        // Full distance spread (farthest first) so the threshold can be tuned
        // when a run flags nothing — "all shielded" alone hides whether 400ft
        // was generous (everything sits at 50ft) or tight (farthest is 390ft).
        // Mark assets skipped for being already-Unshielded with a ⊘.
        allDistances.sort((x, y) => y.distFt - x.distFt);
        console.log(`${TAG} asset-validator: nearest-power-line distance for all ${allDistances.length} assets (farthest first, threshold ${thresholdFt}ft, ${segments.length} line segs${skipped ? `, ${skipped} skipped as already-Unshielded` : ''}):`);
        allDistances.forEach(d => console.log(`${TAG} asset-validator:   ${d.skip ? '⊘' : (d.far ? '✗' : '✓')} ${d.distFt}ft  ${d.name}${d.skip ? '  (already Unshielded)' : ''}`));

        // Asset pin numbers live in a separate range (1000+) so they never
        // collide with gap pins (1..N); label shows a clean 1..M sequence.
        const ASSET_NUM_BASE = 1000;
        const assetResults = unshielded.map((u, i) => ({
            kind: 'asset',
            number: ASSET_NUM_BASE + i + 1,
            label: String(i + 1),
            midLat: u.a.cLat,
            midLng: u.a.cLng,
            assetName: u.a.name,
            distFt: u.distFt,
            thresholdFt,
            dismissed: false,
        }));

        // Replace ONLY asset pins; leave FFZ/FP gap pins untouched.
        validatorState.results = validatorState.results.filter(r => r.kind !== 'asset').concat(assetResults);
        assetValidatorLastRun = {
            count: assetResults.length,
            total: assets.length,
            skipped,
            at: Date.now(),
            durationMs: Date.now() - startTime,
        };
        saveValidatorResults();
        const skipNote = skipped ? ` (${skipped} skipped as already-Unshielded)` : '';
        if (assetResults.length === 0) {
            console.log(`${TAG} asset-validator: ✓ all ${assets.length - skipped} checked assets shielded (centroid within ${thresholdFt}ft of a power line)${skipNote} (${assetValidatorLastRun.durationMs}ms)`);
        } else {
            console.warn(`${TAG} asset-validator: ${assetResults.length}/${assets.length - skipped} checked assets UNSHIELDED (centroid >${thresholdFt}ft from any power line)${skipNote} in ${assetValidatorLastRun.durationMs}ms`);
            assetResults.forEach(r => console.warn(`${TAG} asset-validator:   • ${r.assetName} — nearest power line ${r.distFt}ft`));
        }
        runUpdate();
    }

    function clearAssetCoverageValidator() {
        const before = validatorState.results.length;
        validatorState.results = validatorState.results.filter(r => r.kind !== 'asset');
        assetValidatorLastRun = null;
        saveValidatorResults();
        console.log(`${TAG} asset-validator: cleared ${before - validatorState.results.length} pin(s)`);
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

    // True if a #rgb / #rrggbb color is light enough that black text reads
    // better than white on it (per-channel luminance > ~0.6). Used to keep the
    // asset pin number legible for any user-picked color.
    function isLightColor(hex) {
        if (typeof hex !== 'string') return false;
        let h = hex.replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (h.length !== 6) return false;
        const r = parseInt(h.slice(0, 2), 16) / 255;
        const g = parseInt(h.slice(2, 4), 16) / 255;
        const b = parseInt(h.slice(4, 6), 16) / 255;
        return (0.299 * r + 0.587 * g + 0.114 * b) > 0.6;
    }

    function renderValidatorPins() {
        // Either test's master being on is enough to draw — each result is
        // filtered per-kind inside the loop by its own show toggle.
        if (!toggleState['validator.show'] && !toggleState['asset-validator.show']) return;
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

        const gapThresholdFt = Number(toggleState['validator.distance']) || 200;

        validatorState.results.forEach(r => {
            // Per-kind: asset pins (orange, centroid + stored threshold) vs
            // FFZ/FP gap pins (red, outline + the live validator.distance).
            const isAsset = r.kind === 'asset';
            if (isAsset && !toggleState['asset-validator.show']) return;
            if (!isAsset && !toggleState['validator.show']) return;
            const showDismissed = isAsset
                ? !!toggleState['asset-validator.show-dismissed']
                : !!toggleState['validator.show-dismissed'];
            if (r.dismissed && !showDismissed) return;

            const thresholdFt = isAsset ? (Number(r.thresholdFt) || 400) : gapThresholdFt;
            const latOffsetDeg = thresholdFt / 362776;
            // Asset pin/ring color is user-controllable (defaults to a high-
            // contrast magenta that reads on both tan pads and dark imagery).
            const assetColor = toggleState['asset-validator.pin-color'] || '#ff1493';
            const ringColor = isAsset ? assetColor : '#ff0033';
            const pinFill = isAsset ? assetColor : '#cc0029';
            // Asset pins use a dark outline (not white) for contrast on light
            // pads, and run a bit larger so the number stays legible.
            const pinStroke = isAsset ? '#111111' : '#ffffff';
            const pinLabel = (r.label != null) ? String(r.label) : String(r.number);

            const c = latLngToSVG(r.midLat, r.midLng);
            const c2 = latLngToSVG(r.midLat + latOffsetDeg, r.midLng);
            const radiusUnits = Math.hypot(c2.x - c.x, c2.y - c.y);
            const pinR = Math.max(isAsset ? 13 : 8, radiusUnits * (isAsset ? 0.10 : 0.07));

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
                    hl.setAttribute('stroke', ringColor);
                    hl.setAttribute('stroke-opacity', '0.85');
                    hl.setAttribute('stroke-width', String(Math.max(4, pinR * 0.7)));
                    hl.setAttribute('stroke-linecap', 'round');
                    hl.setAttribute('stroke-linejoin', 'round');
                    hl.setAttribute('pointer-events', 'none');
                    g.appendChild(hl);
                }

                // 2. Coverage circle (translucent, dashed border) — radius is
                //    the gap threshold (200ft) for gaps, or the asset shielding
                //    threshold (centroid radius, default 400ft) for assets.
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute(CUSTOM_BUFFER_ATTR, 'true');
                circle.setAttribute('data-buffer-kind', 'validator-coverage');
                circle.setAttribute('cx', String(c.x));
                circle.setAttribute('cy', String(c.y));
                circle.setAttribute('r', String(radiusUnits));
                circle.setAttribute('fill', ringColor);
                circle.setAttribute('fill-opacity', isAsset ? '0.10' : '0.08');
                circle.setAttribute('stroke', ringColor);
                circle.setAttribute('stroke-opacity', isAsset ? '0.85' : '0.45');
                circle.setAttribute('stroke-width', String(Math.max(isAsset ? 2 : 1, radiusUnits * (isAsset ? 0.022 : 0.015))));
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
                pin.setAttribute('fill', pinFill);
                pin.setAttribute('stroke', pinStroke);
                pin.setAttribute('stroke-opacity', '1');
            }
            pin.setAttribute('stroke-width', String(Math.max(1.5, pinR * (isAsset ? 0.28 : 0.2))));
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
            // Number stays legible on any user-picked fill: black on light
            // pins, white on dark ones (asset pins only — gap pins are fixed).
            const numFill = r.dismissed ? '#ddd'
                : (isAsset ? (isLightColor(pinFill) ? '#111111' : '#ffffff') : '#ffffff');
            text.setAttribute('fill', numFill);
            text.setAttribute('fill-opacity', r.dismissed ? '0.7' : '1');
            text.setAttribute('font-size', String(pinR * 1.25));
            text.setAttribute('font-weight', 'bold');
            text.setAttribute('font-family', 'sans-serif');
            text.setAttribute('pointer-events', 'none');
            text.textContent = pinLabel;
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
        // Clear any inline `display: none` we forced on vertex dots so
        // Percepto's natives become visible again when the styler deactivates.
        document.querySelectorAll('.map-marker__flight-path-vertex').forEach(d => {
            d.style.removeProperty('display');
        });
        // Restore the satellite base tile layer if we hid it.
        restoreMapBackground();
        // Restore ortho brightness + native zoom if we changed them.
        restoreOrthoSettings();
        // Re-add any ortho COG layers we removed for the full hide.
        restoreOrthoVisibility();
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

    // v34.40 — auto-kick safety net for the "stuck after refresh" bug
    // documented in project-stuck-after-refresh memory. After ACTIVATED,
    // schedule a one-shot check; if Leaflet tile layers haven't rendered
    // by the time it fires, auto-fire the Kick that the user would
    // otherwise have to trigger via Shift+K. One auto-kick per page load
    // to prevent infinite loops if the kick itself doesn't recover.
    let stuckCheckTimer = null;
    let autoKickFiredThisLoad = false;
    const STUCK_CHECK_DELAY_MS = 4000;

    function detectStuckRender() {
        if (!isActive) return false;
        // Map ref still null after activation → very likely stuck
        const map = getLeafletMap();
        if (!map) return true;
        // Leaflet tile pane should have at least one layer by now
        const tilePane = document.querySelector('.leaflet-tile-pane');
        if (!tilePane) return true;
        const layers = tilePane.querySelectorAll('.leaflet-layer');
        if (layers.length === 0) return true;
        // Bonus signal: if we have KML features loaded for this site AND
        // the relevant category is configured to render, we should see
        // at least one of our SVG paths. Absence = render loop broken.
        const sid = getCurrentSiteID();
        if (sid) {
            const expectingRender = KML_TYPES.some(t => {
                const feats = kmlFeatures[kmlKey(sid, t)];
                if (!feats || feats.length === 0) return false;
                return toggleState[`${t}.show`] !== false
                    && toggleState[`${t}.outline`] !== false;
            });
            if (expectingRender) {
                const overlays = document.querySelectorAll('path[data-buffer-kind^="kml-"]');
                if (overlays.length === 0) return true;
            }
        }
        return false;
    }

    function scheduleStuckCheckAfterActivation() {
        // Only one auto-kick per page load. If user manually Shift+K's
        // after we've fired, that's fine — but we don't keep trying.
        if (autoKickFiredThisLoad) return;
        if (stuckCheckTimer) { clearTimeout(stuckCheckTimer); stuckCheckTimer = null; }
        stuckCheckTimer = setTimeout(() => {
            stuckCheckTimer = null;
            if (!isActive || autoKickFiredThisLoad) return;
            if (!detectStuckRender()) return;
            autoKickFiredThisLoad = true;
            console.warn(`${TAG} 🦵 auto-kick — stuck render detected ${STUCK_CHECK_DELAY_MS}ms post-activation (no tile layers / no overlays despite features loaded)`);
            performKick('auto: stuck render detected');
        }, STUCK_CHECK_DELAY_MS);
    }

    // Shared Kick implementation — used by Shift+K hotkey AND by the
    // v34.40 auto-kick safety net. Extracted from the old inline hotkey
    // handler so both paths use the exact same recovery sequence.
    function performKick(reason) {
        const wasActive = isActive || toggleState.master !== false;
        console.log(`${TAG} 🦵 Kick — forcing re-init (wasActive=${wasActive}, reason: ${reason})`);
        setActiveState(false);
        leafletMapRef = null;
        observerTarget = null;
        warmupRunsRemaining = 10;
        if (!wasActive) return;
        setTimeout(() => {
            console.log(`${TAG} 🦵 Kick — re-activating + nudging Leaflet to capture map ref`);
            setActiveState(true);
            // Dispatch resize so Leaflet's _onResize fires invalidateSize
            // on every existing map → our patched method captures the map ref.
            try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            // After the capture, force tile layers to redraw. v34.18 testing
            // showed map ref captures fine but ortho tiles don't render
            // until user manually zooms — Leaflet's tile pipeline needs an
            // explicit redraw() to re-fetch/re-render.
            setTimeout(() => {
                const map = getLeafletMap();
                if (!map || typeof map.eachLayer !== 'function') return;
                try { map.invalidateSize(); } catch (e) {}
                let redrawn = 0;
                map.eachLayer(layer => {
                    if (layer && typeof layer.redraw === 'function' && layer._url) {
                        try { layer.redraw(); redrawn++; } catch (e) {}
                    }
                });
                console.log(`${TAG} 🦵 Kick — forced redraw on ${redrawn} tile layer(s)`);
                // Also force-refresh the cached asset state/equipment data —
                // users reach for Shift+K after editing an asset and expect
                // its color/visibility to update. (IFRAME owns the fetch.)
                if (CONTEXT === 'IFRAME') {
                    const sid = getCurrentSiteID();
                    if (sid) fetchAssetStates(sid, true);
                }
                runUpdate();
            }, 200);
        }, 100);
    }

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
            if (stuckCheckTimer) { clearTimeout(stuckCheckTimer); stuckCheckTimer = null; }
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
            // TOP frame caps at 5 attempts (1s) because Percepto's Leaflet
            // map is always in the IFRAME — TOP retrying for 30s is just
            // noise. IFRAME keeps the full 30s budget because its first-load
            // can take ~7s on some pages.
            const cap = (CONTEXT === 'TOP') ? 5 : 150;
            if (attempt > cap) {
                if (CONTEXT === 'TOP') {
                    console.log(`${TAG} no map-pane in TOP frame after ${cap} tries — that's expected; map lives in iframe.`);
                } else {
                    console.warn(`${TAG} gave up waiting for .leaflet-map-pane after 30s`);
                }
                return;
            }
            mapPaneWaitTimer = setTimeout(() => attachObserverWhenReady(attempt + 1), 200);
            return;
        }
        mapPaneWaitTimer = null;
        if (observer) observer.disconnect();
        console.log(`${TAG} 🟢 ACTIVATED (map-pane found on attempt ${attempt + 1})`);
        // v34.40: arm the stuck-render auto-kick safety net (one-shot per
        // page load). Detects the "stuck after refresh" symptom — tile
        // layers/overlays not rendering despite activation — and silently
        // recovers via a single auto-Kick. See detectStuckRender() above.
        scheduleStuckCheckAfterActivation();
        observerTarget = container;
        observer = new MutationObserver(debouncedUpdate);
        observer.observe(container, observerConfig);
        // First-render watchdog: after attach, run runUpdate up to N times
        // unconditionally (bypass hash check) so we recover from the case
        // where the very first runUpdate fires before Leaflet's overlay-pane
        // SVG is mounted. Without this, the first run produces ourN=0,
        // lastUpdateHash captures that state, and every subsequent heartbeat
        // matches the hash and skips — leaving overlays absent indefinitely.
        // Symptom that motivated this: laptop sleep + regular page refresh
        // produced exactly this stuck state. 10 ticks × 3s = 30s warmup.
        warmupRunsRemaining = 10;
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
            // Warmup: bypass hash check until we've run at least N times
            // post-activation, so a too-early first render that produced
            // ourN=0 doesn't lock us into a stuck state.
            if (warmupRunsRemaining > 0) {
                warmupRunsRemaining--;
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

    // Asset lockdown via CSS pointer-events.
    //
    // v34.29 and earlier used a capture-phase event handler that called
    // stopImmediatePropagation on mousedown/click of asset paths. Two bugs:
    //   - Map pan didn't work over assets (mousedown was killed, so Leaflet
    //     never started the pan drag).
    //   - Pin-drop tools couldn't fire INSIDE assets (the host app's click
    //     handler on the map container never received the event — we'd
    //     stopped propagation).
    //
    // The new approach: inject a CSS rule that sets `pointer-events: none`
    // on white asset paths when body has the `aim-asset-locked` class.
    // Clicks pass through to the map underneath, so pan + pin-drop work.
    // The asset's own Leaflet click handler doesn't fire because no events
    // reach the element at all. Shift held temporarily removes the body
    // class (re-enables events) so the user can still click the asset to
    // interact with it.
    //
    // Tradeoff: hover events also don't fire while locked → tooltips don't
    // appear → Copy Asset Name (Shift+Ctrl+Q) doesn't see a tooltip unless
    // the user moves the cursor across the asset while Shift is held.
    // Acceptable for E1; document in CHANGELOG.
    const ASSET_LOCK_STYLE_ID = 'aim-asset-lock-css';
    const ASSET_LOCK_CSS = `
        body.aim-asset-locked path.leaflet-interactive[stroke="#ffffff"] {
            pointer-events: none !important;
        }
    `;
    const ASSET_LOCK_BODY_CLASS = 'aim-asset-locked';
    let shiftIsHeld = false;

    function ensureAssetLockStyle() {
        if (document.getElementById(ASSET_LOCK_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = ASSET_LOCK_STYLE_ID;
        style.textContent = ASSET_LOCK_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    function applyAssetLockClass() {
        if (!document.body) return;
        const locked = toggleState['asset.locked'] === true && !shiftIsHeld;
        document.body.classList.toggle(ASSET_LOCK_BODY_CLASS, locked);
    }

    function installAssetLockHandler() {
        if (window.aimAssetLockInstalled) return;
        window.aimAssetLockInstalled = true;
        ensureAssetLockStyle();
        // Track Shift modifier — when held, lift the lock so the user can
        // click through to the asset for interaction. Capture phase so we
        // catch it regardless of focus target. Re-applies the class on
        // every transition.
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Shift' && !shiftIsHeld) {
                shiftIsHeld = true;
                applyAssetLockClass();
            }
        }, true);
        window.addEventListener('keyup', (e) => {
            if (e.key === 'Shift' && shiftIsHeld) {
                shiftIsHeld = false;
                applyAssetLockClass();
            }
        }, true);
        // If focus leaves the window mid-shift, we may miss the keyup and
        // be stuck in shift-held state. Reset on blur as a safety net.
        window.addEventListener('blur', () => {
            if (shiftIsHeld) {
                shiftIsHeld = false;
                applyAssetLockClass();
            }
        }, true);
        applyAssetLockClass();
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
                // IDEMPOTENT no-op for duplicate broadcasts. Control Panel
                // runs in both TOP and IFRAME, and re-broadcasts every
                // toggle's value to a script on each REGISTER — so each
                // SET_TOGGLE typically arrives 2-4×. Without this guard,
                // every duplicate ran the special-case logic below (e.g.
                // applyAssetLockClass), wrote toggleState, and could
                // cascade through Map Styler ↔ Perf Shield broadcasts.
                // See [[feedback-set-toggle-handlers-must-be-idempotent]].
                if (newVal === prev) return;
                toggleState[msg.toggleId] = newVal;
                // E1 auto-on coupling: when edit-mode for a KML type flips
                // ON, auto-flip show-hidden ON too so the user can see what
                // they've hidden (otherwise they'd flip a line invisible
                // and have nothing to right-click for "Unhide"). We don't
                // auto-flip OFF when edit-mode leaves — the user might want
                // to keep ghosting on while not actively editing.
                if ((msg.toggleId === 'distro.edit-mode' || msg.toggleId === 'trans.edit-mode')
                    && newVal === true && prev !== true) {
                    const type = msg.toggleId.split('.')[0];
                    const hiddenKey = `${type}.show-hidden`;
                    if (toggleState[hiddenKey] !== true) {
                        toggleState[hiddenKey] = true;
                        // Echo back so the panel checkbox + GM storage update.
                        controlChannel.postMessage({
                            type: 'SET_TOGGLE', scriptId: SCRIPT_ID,
                            toggleId: hiddenKey, value: true, enabled: true,
                        });
                    }
                }
                // Asset lock toggled — apply/remove the body class immediately
                // so the user sees the pointer-events effect without waiting
                // for the next runUpdate or interaction.
                if (msg.toggleId === 'asset.locked') {
                    applyAssetLockClass();
                }
                // Color-by-state flipped on → kick off the entity fetch now so
                // the styling appears without waiting for another interaction.
                // (Tags are re-matched every runUpdate, so no clearing needed on
                // flip-off; the runUpdate below repaints with coloring removed.)
                if (msg.toggleId === 'asset.by-state' && newVal) {
                    const sid = getCurrentSiteID();
                    if (sid) fetchAssetStates(sid, true);
                }
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
            } else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === SCRIPT_ID && CONTEXT === 'IFRAME') {
                // Button-type controls in the panel broadcast this when clicked.
                // Two gates here:
                //   1. CONTEXT === 'IFRAME' — TOP doesn't render anything; running
                //      actions there at best wastes CPU and at worst (split) fires
                //      confirm() + GitHub PUT twice.
                //   2. document.hasFocus() — BroadcastChannel delivers to EVERY
                //      open AIM tab in the same origin, not just the one the
                //      user clicked in. Without this gate, clicking Split on
                //      site 1597 in Tab A would fire confirm()/run on Tab B's
                //      open site 1599 too. Only the focused tab handles the
                //      action; all other tabs silently ignore.
                if (!document.hasFocus()) {
                    console.log(`${TAG} TRIGGER_ACTION ${msg.actionId} arrived but tab is not focused — ignoring (cross-tab broadcast).`);
                    return;
                }
                if (msg.actionId === 'run-validator') runCoverageValidator();
                else if (msg.actionId === 'clear-validator') clearCoverageValidator();
                else if (msg.actionId === 'run-asset-validator') runAssetCoverageValidator();
                else if (msg.actionId === 'clear-asset-validator') clearAssetCoverageValidator();
                else if (msg.actionId === 'clear-hides-distro') clearLocalHides('distro');
                else if (msg.actionId === 'clear-hides-trans') clearLocalHides('trans');
                else if (msg.actionId === 'unhide-file-distro') unhideAllFileHidden('distro');
                else if (msg.actionId === 'unhide-file-trans') unhideAllFileHidden('trans');
                else if (msg.actionId === 'split-distro') splitMultiSegmentPlacemarks('distro');
                else if (msg.actionId === 'split-trans') splitMultiSegmentPlacemarks('trans');
                else if (msg.actionId === 'commit-distro') commitPendingOps('distro');
                else if (msg.actionId === 'commit-trans') commitPendingOps('trans');
                else if (msg.actionId === 'discard-commits-distro') discardCommitOps('distro');
                else if (msg.actionId === 'discard-commits-trans') discardCommitOps('trans');
                else if (msg.actionId === 'add-new-distro') enterDrawMode('distro');
                else if (msg.actionId === 'add-new-trans') enterDrawMode('trans');
                else if (msg.actionId === 'refresh-asset-data') {
                    const sid = getCurrentSiteID();
                    if (sid) { console.log(`${TAG} asset-state: manual refresh requested`); fetchAssetStates(sid, true); }
                }
            } else if (msg.type === 'PERF_TOGGLE') {
                // Driven by AIM Performance Shield. Mirror its state, then
                // apply IMMEDIATELY — independent of the styler master. These
                // are performance levers and must work even when the user has
                // the Outlines master OFF (which is exactly the case that made
                // them look broken: they used to gate on `if (isActive)
                // runUpdate()`, so a styler-off page silently ignored them).
                // applyPerfMapSettings() calls the underlying appliers, which
                // are idempotent and handle both the ON and OFF (restore)
                // branches, so we don't need the old `else restore…` calls.
                if (msg.key === 'hide-satellite') {
                    const next = !!msg.value;
                    if (next !== perfHideSatellite) { perfHideSatellite = next; applyPerfMapSettings(); }
                } else if (msg.key === 'ortho-lowres') {
                    const next = !!msg.value;
                    if (next !== perfOrthoLowRes) { perfOrthoLowRes = next; applyPerfMapSettings(); }
                } else if (msg.key === 'ortho-lowres-zoom') {
                    const n = Number(msg.value);
                    if (!isNaN(n) && n !== perfOrthoLowResZoom) { perfOrthoLowResZoom = n; applyPerfMapSettings(); }
                } else if (msg.key === 'hide-ortho') {
                    const next = !!msg.value;
                    if (next !== perfHideOrtho) { perfHideOrtho = next; applyPerfMapSettings(); }
                }
            } else if (msg.type === 'HOTKEY_FIRED' && msg.scriptId === SCRIPT_ID) {
                // Same cross-tab gate as TRIGGER_ACTION: hotkeys pressed in
                // one AIM tab shouldn't toggle styler / kick / etc. in every
                // other open AIM tab. Only the focused tab handles the key.
                if (!document.hasFocus()) {
                    return;
                }
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
                } else if (msg.hotkeyId === 'kick-styler') {
                    // Recovery hotkey for the "stuck after refresh" state.
                    // Background:
                    // - v34.17 cleared cached state + re-activated. In stuck
                    //   state the Leaflet map instance is unreachable from the
                    //   DOM (held in a WeakMap/closure) and our `initialize`
                    //   patch can't capture already-created maps.
                    // - v34.18 expanded patchLeafletMap to hook MULTIPLE
                    //   prototype methods (getPane, addLayer, invalidateSize…)
                    //   so any map operation captures `this` onto the container.
                    //   Kick dispatches a synthetic window resize → Leaflet's
                    //   _onResize calls invalidateSize → our patch captures.
                    // - v34.40 extracted the recovery sequence into performKick()
                    //   so the new auto-kick safety net can use the same code path.
                    performKick('manual via Shift+K');
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
            toggles: buildRegistrationToggles(),
            hotkeys: HOTKEYS,
        });
        // Keep TOP's schema in sync: whenever the iframe (which owns the data)
        // registers and has a discovered equipment set, broadcast it so other
        // frames adopt the same schema. Idempotent on the receiving side.
        if (CONTEXT === 'IFRAME' && assetEquipTypes.length) {
            try {
                stateChannel.postMessage({
                    action: 'ASSET_EQUIP', siteID: getCurrentSiteID(), equip: assetEquipTypes,
                });
            } catch (e) {}
        }
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
    installKMLEditHandlers();
    // Power Line Editor bridge — the editor lives in its own script
    // (AIM_Power_Line_Editor.user.js) and owns the floating toolbar +
    // M1 click detection. All the actual edit + commit code stays here
    // (it's tightly coupled with rendering + commit pipeline). The
    // editor drives us via these messages; we push status updates so
    // its dirty-count badge stays in sync.
    //
    //   editor → styler:
    //     ENTER_VERTEX_EDIT { kmlType, pmIdx }
    //     ENTER_DRAW_MODE   { kmlType }
    //     EXIT_VERTEX_EDIT  { save?: bool }     // explicit exit
    //     COMMIT_KML        { kmlType }
    //     DISCARD_OPS       { kmlType }
    //     REQUEST_STATUS
    //   styler → editor:
    //     STATUS { siteID, distroCount, transCount,
    //              vertexEditActive, drawModeActive,
    //              vertexEditType?, vertexEditPmIdx? }
    //
    // Status is broadcast on REQUEST_STATUS and on any state change
    // (setCommitOps, enterVertexEdit, exitVertexEdit, enterDrawMode,
    // exitDrawMode, commit success/failure).
    //
    // TDZ NOTE: `let powerLineEditorChannel` is declared HERE (before
    // setupPowerLineEditorBridge() is called), not below. Function
    // declarations hoist but `let` does NOT — without this ordering,
    // the BroadcastChannel assignment inside the bridge fn hits TDZ.
    // Same pattern as feedback_perf_shield_tdz_pattern memory.
    let powerLineEditorChannel = null;
    setupKmlDataResponder();
    setupPowerLineEditorBridge();
    function broadcastPowerLineStatus() {
        if (!powerLineEditorChannel) return;
        const siteID = getCurrentSiteID();
        powerLineEditorChannel.postMessage({
            type: 'STATUS',
            siteID,
            distroCount: siteID ? commitOpsCount(siteID, 'distro') : 0,
            transCount: siteID ? commitOpsCount(siteID, 'trans') : 0,
            vertexEditActive: !!vertexEditState,
            vertexEditType: vertexEditState ? vertexEditState.type : null,
            vertexEditPmIdx: vertexEditState ? vertexEditState.pmIdx : null,
            drawModeActive: !!drawingState,
            drawModeType: drawingState ? drawingState.type : null,
            mergeSelCount: mergeSelection ? mergeSelection.pms.length : 0,
            mergeSelType: mergeSelection ? mergeSelection.type : null,
        });
    }
    // Reports whether the canonical KML for this site+type exists in the
    // repo, based on state we already loaded at site nav (no network call):
    //   'exists'  — features are loaded (file present, even if it has 0 lines)
    //   'missing' — every filename candidate 404'd (kmlMissing set)
    //   'unknown' — not fetched / settled yet (in flight or never tried)
    function kmlExistenceState(siteID, type) {
        const key = kmlKey(siteID, type);
        if (Array.isArray(kmlFeatures[key])) return 'exists';
        if (kmlMissing.has(key)) return 'missing';
        return 'unknown';
    }

    // Guards in-flight create so a double-press of +D/+T doesn't PUT twice.
    const kmlCreating = new Set();

    // Builds a minimal, valid skeleton KML for a brand-new power-line layer.
    // Empty <Document> — applyCommitOpsToKML appends drawn <Placemark>s
    // straight into it, so no commit-path change is needed. The <Style> is
    // cosmetic (only seen if the file is opened in Google Earth; our render
    // uses the per-category toggle colors and ignores styleUrl).
    function buildEmptyKML(siteID, type) {
        const label = type === 'trans' ? 'Transmission' : 'Distribution';
        const styleId = type === 'trans' ? 'rline' : 'yline';
        const color = type === 'trans' ? 'ff3030ff' : 'ff00ffff'; // KML is aabbggrr
        return `<?xml version='1.0' encoding='utf-8'?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Site ${siteID} - ${label} Power Lines</name>
    <Style id="${styleId}">
      <LineStyle>
        <color>${color}</color>
        <width>6.0</width>
      </LineStyle>
    </Style>
  </Document>
</kml>
`;
    }

    // Creates an empty KML in the data repo (Contents API PUT with NO sha —
    // that's how GitHub creates a new file). On success, seeds local state
    // as if the file had loaded empty and runs onReady (used to enter draw
    // mode). Lives here in Map Styler because it owns the token + commit
    // infra; PLE only sends the ENTER_DRAW_MODE that triggers it.
    function createEmptyKML(siteID, type, onReady) {
        const key = kmlKey(siteID, type);
        if (kmlCreating.has(key)) { showKMLToast(`Already creating the ${type} KML…`, 3000); return; }
        const token = cachedToken || gmGet(TOKEN_KEY, '');
        if (!token) { showKMLToast('No GitHub token — set one in AIM Controls first.', 4500); return; }
        if (typeof GM_xmlhttpRequest !== 'function') {
            showKMLToast('Tampermonkey grants need re-approval — open the script in Tampermonkey.', 6000);
            return;
        }
        const path = `${siteID}-${type}.kml`;
        const url = `${GITHUB_API_BASE}/repos/${KMLS_REPO}/contents/${encodeURIComponent(path)}`;
        const xmlText = buildEmptyKML(siteID, type);
        let contentB64;
        try {
            const utf8 = new TextEncoder().encode(xmlText);
            let bin = '';
            for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
            contentB64 = btoa(bin);
        } catch (e) {
            showKMLToast('Create failed: cannot encode XML.', 5000);
            console.error(`${TAG} createEmptyKML btoa failed:`, e);
            return;
        }
        kmlCreating.add(key);
        showKMLToast(`Creating empty ${type} KML (${path})…`, 8000);
        try {
            GM_xmlhttpRequest({
                method: 'PUT',
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                },
                // No `sha` → create. branch pins it to main.
                data: JSON.stringify({ message: `[AIM site ${siteID}] ${type}: create empty power-line KML`, content: contentB64, branch: KMLS_BRANCH }),
                timeout: 20000,
                onload: (resp) => {
                    kmlCreating.delete(key);
                    if (resp.status === 200 || resp.status === 201) {
                        // Seed local state so the rest of the pipeline treats
                        // the file as loaded-and-empty.
                        kmlFeatures[key] = [];
                        kmlResolvedPath[key] = path;
                        kmlMissing.delete(key);
                        gmSet(KML_CACHE_PREFIX + key, { features: [], at: Date.now(), path });
                        // Cache the new SHA so the first real commit can skip
                        // the GET (same fast-path the commit code uses).
                        try {
                            const respJson = JSON.parse(resp.responseText);
                            const newSha = respJson && respJson.content && respJson.content.sha;
                            if (newSha) committedKmlCache[key] = { sha: newSha, xmlText };
                        } catch (e) { /* non-fatal — commit will GET the sha */ }
                        showKMLToast(`✓ Created empty ${type} KML for site ${siteID}. Draw your lines, then click ✓ to commit.`, 6000);
                        console.log(`${TAG} created empty ${type} KML at ${path} (HTTP ${resp.status})`);
                        if (isActive) runUpdate();
                        try { broadcastPowerLineStatus(); } catch (e2) {}
                        if (typeof onReady === 'function') { try { onReady(); } catch (e3) { console.warn(`${TAG} createEmptyKML onReady threw:`, e3); } }
                    } else if (resp.status === 422) {
                        // 422 = file already exists. Someone created it (or a
                        // race). Treat as success-ish: clear missing + refetch.
                        kmlMissing.delete(key);
                        delete kmlFeatures[key];
                        showKMLToast(`A ${type} KML already exists now — reloading it.`, 5000);
                        fetchKMLForSite(siteID, true);
                    } else if (resp.status === 401 || resp.status === 403) {
                        showKMLToast(`Create denied (${resp.status}) — your PAT may lack write access to the data repo.`, 7000);
                        console.warn(`${TAG} createEmptyKML denied ${resp.status}`);
                    } else {
                        showKMLToast(`Create failed (HTTP ${resp.status}).`, 6000);
                        console.warn(`${TAG} createEmptyKML HTTP ${resp.status}: ${resp.responseText && resp.responseText.slice(0, 200)}`);
                    }
                },
                onerror: () => {
                    kmlCreating.delete(key);
                    showKMLToast(`Create failed: network error.`, 5000);
                    console.warn(`${TAG} createEmptyKML network error`);
                },
                ontimeout: () => {
                    kmlCreating.delete(key);
                    showKMLToast(`Create timed out — check your connection and try again.`, 5000);
                    console.warn(`${TAG} createEmptyKML timed out`);
                },
            });
        } catch (e) {
            kmlCreating.delete(key);
            showKMLToast('Create failed to start.', 4000);
            console.error(`${TAG} createEmptyKML threw:`, e);
        }
    }

    // Called when +D/+T asks to draw. If the canonical KML doesn't exist
    // yet, warn the user (so they can upload a real one first) and offer to
    // create a blank file to draw into. Returns true if draw mode was
    // entered (or scheduled to enter after create); false if we blocked it.
    function enterDrawModeChecked(type, seedCoord) {
        const siteID = getCurrentSiteID();
        if (!siteID) { showKMLToast('No site loaded — open a site first.', 3000); return false; }
        const state = kmlExistenceState(siteID, type);
        if (state === 'exists') { enterDrawMode(type, seedCoord); return true; }
        if (state === 'unknown') {
            // Not settled yet — kick a fetch and ask the user to retry in a
            // moment rather than guessing wrong about existence.
            fetchKMLForSite(siteID, true);
            showKMLToast(`Still checking the repo for a ${type} KML — press +${type === 'trans' ? 'T' : 'D'} again in a second.`, 4000);
            return false;
        }
        // state === 'missing' → prompt.
        const label = type === 'trans' ? 'transmission' : 'distribution';
        const ok = confirm(
            `No ${label} power-line KML exists for this site yet (${siteID}-${type}.kml).\n\n` +
            `If you already have power lines for this area, upload the KML to the data repo first, then reopen the site.\n\n` +
            `Click OK to create a new EMPTY ${label} KML now and start drawing.\n` +
            `Click Cancel to stop.`
        );
        if (!ok) { showKMLToast(`No ${label} KML created. Upload one, then reopen the site.`, 5000); return false; }
        createEmptyKML(siteID, type, () => enterDrawMode(type, seedCoord));
        return true;
    }

    function setupPowerLineEditorBridge() {
        try { powerLineEditorChannel = new BroadcastChannel('AIM_POWER_LINE_EDIT'); }
        catch (e) { console.warn(`${TAG} PLE channel unavailable:`, e); return; }
        powerLineEditorChannel.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type === 'REQUEST_STATUS') { broadcastPowerLineStatus(); return; }
            // Only the frame that actually has the Leaflet map should act
            // on commands. v34.48 fix: `isActive` is NOT a sufficient
            // gate — TOP frame auto-activates via the 1.5s safety timer
            // even though it has no map-pane. The real gate is
            // `getLeafletMap()` returning non-null — only true in iframe.
            if (!isActive) {
                if (m.type !== 'STATUS') console.log(`${TAG} PLE bridge: dropping ${m.type} (isActive=false)`);
                return;
            }
            if (!getLeafletMap()) {
                if (m.type !== 'STATUS') console.log(`${TAG} PLE bridge: dropping ${m.type} (no Leaflet map — likely TOP frame)`);
                return;
            }
            if (m.type !== 'STATUS') console.log(`${TAG} PLE bridge: handling ${m.type}`, m);
            try {
                if (m.type === 'ENTER_VERTEX_EDIT' && m.kmlType) {
                    // v34.47: addedIdx for pending-add (green) lines,
                    // pmIdx for file lines. Mutually exclusive.
                    if (Number.isFinite(m.addedIdx)) {
                        enterAddedVertexEdit(m.kmlType, m.addedIdx);
                    } else if (Number.isFinite(m.pmIdx)) {
                        enterVertexEdit(m.kmlType, m.pmIdx);
                    }
                } else if (m.type === 'EXIT_VERTEX_EDIT') {
                    exitVertexEdit({ save: !!m.save });
                } else if (m.type === 'ENTER_DRAW_MODE' && m.kmlType) {
                    // v34.61: optional seedCoord {lat,lng} for branching
                    // (Phase 3a). When present, draw mode pre-seeds
                    // vertex 0 at that coord so the new line starts
                    // attached to the source vertex.
                    // v34.68: gate on KML existence. If no canonical KML for
                    // this site+type, warn + offer to create a blank one to
                    // draw into (so committing drawn lines doesn't later 404).
                    enterDrawModeChecked(m.kmlType, m.seedCoord || null);
                } else if (m.type === 'CONVERT_LINE' && m.kmlType) {
                    // Convert one line to the OTHER power-line type. File line
                    // (pmIdx) → delete on source + added on target. Pending-add
                    // line (addedIdx) → move between added arrays.
                    convertLine(m.kmlType, Number.isFinite(m.addedIdx)
                        ? { addedIdx: m.addedIdx } : { pmIdx: m.pmIdx });
                } else if (m.type === 'TOGGLE_MERGE_SELECT' && m.kmlType && Number.isFinite(m.pmIdx)) {
                    toggleMergeSelect(m.kmlType, m.pmIdx);
                } else if (m.type === 'PERFORM_MERGE') {
                    performMerge();
                } else if (m.type === 'CLEAR_MERGE_SELECTION') {
                    clearMergeSelection();
                } else if (m.type === 'COMMIT_KML' && m.kmlType) {
                    // v34.46: was commitKMLChanges (legacy hide-only path);
                    // commitPendingOps is the ops-aware fn that handles
                    // modify/delete/added. Was silently saying "no pending
                    // changes" for newly-added lines.
                    // A commit may shift pmIdx (structural delete/add), so any
                    // lingering merge selection on this type is now ambiguous —
                    // clear it so highlights can't point at the wrong line.
                    if (mergeSelection && mergeSelection.type === m.kmlType) clearMergeSelection({ silent: true });
                    commitPendingOps(m.kmlType);
                } else if (m.type === 'DISCARD_OPS' && m.kmlType) {
                    discardCommitOps(m.kmlType);
                } else if (m.type === 'DISCARD_ADDED_LINE' && m.kmlType && Number.isFinite(m.addedIdx)) {
                    // v34.64: PLE delete-mode + click on a green pending-add
                    // line. Discard outright (splice from co.added) — there's
                    // no "mark for deletion" stage for pending-adds.
                    //
                    // CRITICAL: exit ANY active added-line vertex edit first
                    // because the splice shifts subsequent indices and a
                    // stale vertexEditState.addedIdx would point to the
                    // wrong line on the next interaction.
                    const siteID = getCurrentSiteID();
                    if (siteID) {
                        if (vertexEditState && vertexEditState.isAdded) {
                            exitVertexEdit({ save: false, silent: true });
                        }
                        const co = getCommitOps(siteID, m.kmlType);
                        const target = co.added && co.added[m.addedIdx];
                        if (target) {
                            const name = target.name || '(unnamed)';
                            co.added.splice(m.addedIdx, 1);
                            setCommitOps(siteID, m.kmlType, co);
                            const count = commitOpsCount(siteID, m.kmlType);
                            showKMLToast(`Discarded pending ${m.kmlType} line "${name}". ${count} pending commit${count === 1 ? '' : 's'}.`, 4500);
                            if (isActive) runUpdate();
                            try { broadcastPowerLineStatus(); } catch (e2) {}
                        } else {
                            showKMLToast(`Pending ${m.kmlType} line at index ${m.addedIdx} not found — may have already been discarded.`, 4000);
                        }
                    }
                } else if (m.type === 'MARK_LINE_FOR_DELETE' && m.kmlType && Number.isFinite(m.pmIdx)) {
                    // v34.55: PLE's delete-line-mode → M1 on a power
                    // line dispatches this instead of ENTER_VERTEX_EDIT.
                    // Calls the existing markPlacemarkForDelete which
                    // queues an op + flips render to red dashed.
                    const siteID = getCurrentSiteID();
                    if (siteID) {
                        markPlacemarkForDelete(siteID, m.kmlType, m.pmIdx);
                        const count = commitOpsCount(siteID, m.kmlType);
                        showKMLToast(`Marked ${m.kmlType} #${m.pmIdx} for deletion. ${count} pending — click ✓ in the strip to commit.`, 4500);
                        if (isActive) runUpdate();
                        try { broadcastPowerLineStatus(); } catch (e2) {}
                    }
                }
            } catch (e) {
                console.warn(`${TAG} PLE command failed (${m.type}):`, e);
            }
        };
    }

    // KML data sharing — other AIM scripts (Asset Inspector's Site Setup
    // Analyzer) need access to the parsed KML features we've already
    // loaded. Rather than have each script re-fetch from GitHub, expose
    // the in-memory data on a dedicated channel.
    //   REQUEST_KML_FEATURES { siteID }
    //     → KML_FEATURES_RESPONSE { siteID, distro: [feat,…], trans: [feat,…] }
    // Both sides early-out if siteID mismatches their current site, so a
    // request fired before a site nav doesn't pollute the response.
    function setupKmlDataResponder() {
        let chan;
        try { chan = new BroadcastChannel('AIM_KML_DATA'); }
        catch (e) { console.warn(`${TAG} KML data channel unavailable:`, e); return; }
        chan.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type !== 'REQUEST_KML_FEATURES') return;
            const reqSite = m.siteID;
            if (!reqSite) return;
            // Only respond if we have data for the requested site —
            // avoids the asker getting empty arrays from another tab on
            // a different site.
            const distro = kmlFeatures[`${reqSite}|distro`] || [];
            const trans = kmlFeatures[`${reqSite}|trans`] || [];
            if (distro.length === 0 && trans.length === 0) return;
            chan.postMessage({
                type: 'KML_FEATURES_RESPONSE',
                siteID: reqSite,
                distro,
                trans,
                fromVersion: SCRIPT_VERSION,
            });
        };
    }

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
        // Any in-progress vertex edit OR draw mode belongs to the
        // previous site — bail out silently so handles/clicks don't
        // linger and accidentally save against the wrong KML on the
        // new site.
        if (vertexEditState) exitVertexEdit({ save: false, silent: true });
        if (drawingState) exitDrawMode({ silent: true });
        // Merge selection holds pmIdx values for the OLD site — drop it.
        if (mergeSelection) clearMergeSelection({ silent: true });
        // v34.49: invalidate the SHA cache — it's keyed by siteID|type,
        // so technically it's safe to keep, but better to drop on site
        // nav so a stale entry can never apply to the wrong site.
        Object.keys(committedKmlCache).forEach(k => { delete committedKmlCache[k]; });
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