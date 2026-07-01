// ==UserScript==
// @name         Latest - AIM Mission Bank Tools
// @namespace    http://tampermonkey.net/
// @version      1.64
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Mission_Bank_Tools.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Mission_Bank_Tools.user.js
// @description  Mission Bank Tools — SUM button opens an all-missions Summary panel with per-mission stats, sortable columns, drill-down detail view, CSV/TSV/JSON/HTML export. First feature: Mission Summary panel.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// AIM Mission Bank Tools — v0.6
// Features:
//   - Mission Summary panel (SUM button)            — features.csv #48
//   - Right-click mission inspector                  — features.csv #50
//
// v0.6 changes (NEW: right-click mission inspector):
//   - Plain right-click on any mission row in Percepto's `.missions-list`
//     sidebar opens a floating popup with mission stats, flight-phase
//     breakdown, and step-type counts. "Open in SUM" jumps to the
//     drill-down view inside the Summary panel for the full step list.
//   - Shift+right-click bypasses MBT entirely so coworkers can still use
//     Chrome's native menu ("Open Link in New Tab", "Copy Link", etc.).
//   - Event delegation on the iframe document so React rebuilds of
//     `ul.missions-list__items` don't kill the handler.
//   - Mission ID parsed from the `<a href>` (`/mission-bank/<id>` regex);
//     data reuses the existing missionsBySite cache and fetches if cold.
//   - Popup is draggable (pointer events with setPointerCapture), has a
//     close X, click-to-copy stat cards, and stays clamped inside the
//     viewport even on near-edge clicks.
//
// v0.5 changes (SUM placement polish):
//   - SUM no longer crowds the same row as "MISSIONS" title + "+ New
//     Mission". A dedicated `aim-mb-toolbar-row` div is injected as a
//     sibling immediately AFTER `.missions-list__header`. SUM lives in
//     there, and future MBT buttons can join the same row (flex/gap
//     layout, left-aligned).
//   - Header-rebuild detection now keys off the toolbar row, not the
//     header itself.
//
// v0.4 changes (SUM-placement fix + sandbox window.open fix):
//   - Floating fallback removed entirely. v0.3 dropped a floating button
//     on the first interval tick (before React had mounted
//     `.missions-list__header`), then never replaced it because the
//     "already injected" early-return short-circuited future ticks.
//     Now we wait for the real header to exist and inject there only.
//   - TOP-context injection fully gated: the hashchange handler used
//     to fire runSumInjection in TOP too, which produced a second
//     floating button. runSumInjection now early-returns unless we're
//     in IFRAME.
//   - Detail-view Google Maps links open via window.top.open(...) so
//     the sandboxed iframe doesn't block the popup (the iframe lacks
//     allow-popups; the top frame doesn't).
//   - Header-rebuilt resilience: each tick checks `header.contains(btn)`
//     so a React re-render that wipes our button gets re-injected
//     instead of being permanently lost.
//
// v0.3 changes (real-world testing pass):
//   - SUM injection: correct selector `.missions-list__header`, inserted
//     next to `.missions-list__new-button` reusing its className for
//     native Ant Design styling. Recursive iframe walk removed (script
//     is @match'd into the iframe directly; recursion was producing
//     two SUM buttons).
//   - Panel title shows actual site name (read from
//     `.ant-select-selection-item` in top frame), not site ID.
//   - Sticky toolbar + footer: panel body restructured to flex column
//     so only the table scrolls. Toolbar (search/columns/unit/settings)
//     and footer (exports) stay pinned during scroll.
//   - Pointer-event drag + resize with setPointerCapture: no more
//     "lose-the-mouse" off-corner dropouts.
//   - Menus (Columns ▾ + Settings ⚙) appended to document.body with
//     position:fixed so they don't get clipped by the panel and don't
//     get destroyed by re-renders. Both gained explicit close (✕) buttons.
//   - Settings input no longer steals focus on each keystroke: search
//     field auto-focus removed; menus survive re-renders so the user
//     can keep typing in them.
//   - Detail view: unit toggle (mi/km), click-to-copy numeric stat
//     cards, location cells are Google-Maps links (left-click opens,
//     right-click copies coords), bold-colored step rows for navigate
//     (neon green) and snapshot (orange), step-type display tidied
//     (cameraSelect → Thermal On/Off; gemMode → GEM On/Off), step
//     counts card auto-builds from all distinct types in the mission.
//   - fmtPct adds a space before % per user spec.
//
// Architecture mirrors Asset Inspector's SUM panel:
//   - SUM button injected on Mission Bank toolbar
//   - Floating draggable/resizable panel with sortable table of missions
//   - Click row → master-detail swap to drill-down view (back button
//     restores table at scroll position)
//   - Columns toggle ▾ menu — visibility persisted in GM storage
//   - Default sort: Flight Distance DESC (longest first — clusters
//     user's multi-missions at top per their build pattern)
//   - Settings cog → adjustable battery-to-flights thresholds
//   - Exports: CSV / TSV / JSON (visible cols only, excluding Active
//     which is panel-only)
//
// Data: /available_app/?site_id=X&type=1 (cookie auth, no PAT needed).
// One fetch per site returns everything: instructions, app_data stats,
// site_name, robot_type_names, etc. Cached per-site in memory.
//
// Bracketed log tag: [AIM MB TOOLS]

(function () {
    'use strict';

    // --- AIM Pilot mode guard: stay fully inert when a pilot/regulator has
    // turned on Pilot mode in the Control Panel (shared localStorage flag). No
    // observers/intervals/hotkeys/DOM injection start past this point. Toggling
    // Pilot mode reloads the page, so this re-evaluates cleanly each load. ---
    try {
        if (localStorage.getItem('aim-mode') !== 'full') {
            console.log('[AIM MB TOOLS] Lite mode — CSM tool inert, init skipped.');
            return;
        }
    } catch (e) {}

    const SCRIPT_ID = 'aim-mission-bank-tools';
    const SCRIPT_VERSION = '1.64';
    // Debug flag — set window.__AIM_MB_DEBUG = true in DevTools to enable
    // verbose [edit], [queue], [fiber] logs. Off by default for speed.
    const DEBUG = () => !!(window.__AIM_MB_DEBUG || (window.top && window.top.__AIM_MB_DEBUG));
    const dlog = (...args) => { if (DEBUG()) console.log(...args); };
    const TAG = '[AIM MB TOOLS]';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const CONTEXT = window === window.top ? 'TOP' : 'IFRAME';
    const SUM_BTN_ID = 'aim-mb-sum-btn';
    const PANEL_ID = 'aim-mb-panel';
    const RCLICK_POPUP_ID = 'aim-mb-rclick-popup';
    const MISSION_ROW_SELECTOR = 'li.missions-list__item';
    const MISSION_LINK_SELECTOR = 'a[data-testid="edit-mission-link"]';
    const MISSION_HREF_RE = /\/mission-bank\/(\d+)(?:\/|$|\?)/;
    const CACHE_KEY_VISIBLE_COLS = 'aim-mb-visible-cols';
    const CACHE_KEY_VISIBLE_COLS_LOG = 'aim-mb-visible-cols-log'; // separate column set for Mission Log mode
    const CACHE_KEY_DISTANCE_UNIT = 'aim-mb-distance-unit'; // 'imperial' | 'metric'
    const CACHE_KEY_FLIGHT_THRESHOLDS = 'aim-mb-flight-thresholds';
    const CACHE_KEY_GAP_DAYS = 'aim-mb-log-gap-days';       // coverage-gap threshold (days)
    const CACHE_KEY_COLLAPSE_BLOCKS = 'aim-mb-collapse-blocks'; // detail view: collapse Thermal/GEM/Wait scan blocks
    const LOG_SUM_BTN_ID = 'aim-mb-log-sum-btn';            // launcher on the Mission Log page
    const DEFAULT_GAP_DAYS = 7;
    // Detail-view ergonomics: collapse each snapshot's redundant
    // Thermal-on/GEM-on/Wait/GEM-off/Thermal-off block into ONE summary row.
    // Default ON — these 5 steps eat the editor. The data is untouched; this
    // is a pure view filter.
    let collapseScanBlocks = gmGet(CACHE_KEY_COLLAPSE_BLOCKS, true);
    // Map declutter: hide the redundant scan-block step markers (GEM/Thermal/
    // Wait) on the Mission Bank map, keeping only Navigate + Snapshot. Matched
    // by icon-filename substring via a CSS :has() rule (survives Leaflet's
    // marker rebuilds on zoom/pan with no JS observer). Confirmed filenames
    // from the live DOM: GEM = gem-mode-*.svg, Thermal/Camera-Type =
    // camera-type-*.svg, Wait = wait-*.svg. The Snapshot icon is a DIFFERENT
    // camera file (not "camera-type"), so these substrings never hit Navigate
    // or Snapshot.
    const CACHE_KEY_HIDE_SCAN_ICONS = 'aim-mb-hide-scan-icons';
    let hideScanIcons = gmGet(CACHE_KEY_HIDE_SCAN_ICONS, true);
    const REDUNDANT_MARKER_SRCS = ['gem-mode', 'camera-type', 'wait'];
    let loggedMarkerSrcs = false;
    // Native-editor collapse: shrink the redundant Camera Type / GEM Mode /
    // Wait instruction CARDS in Percepto's own mission editor (the left list)
    // to thin rows so the 100+-instruction list is scannable. The cards are
    // [data-rfd-draggable-id="<instructionId>"] (same handle the commit code
    // uses); we map each id → type from the open mission and tag the redundant
    // ones with a class. Capped height (not display:none) keeps a measurable
    // box so react-beautiful-dnd drag-reorder isn't disturbed.
    const CACHE_KEY_COLLAPSE_EDITOR = 'aim-mb-collapse-editor';
    let collapseEditorCards = gmGet(CACHE_KEY_COLLAPSE_EDITOR, true);
    const EDITOR_COLLAPSE_STYLE_ID = 'aim-mb-editor-collapse-style';
    let loggedEditorCards = false;

    // Per-step-type display colors. One color per type, used for BOTH the
    // compact-card text (native editor) AND the on-map order badges + reorder
    // popup. User-customizable via the Control Panel (type:'color' toggles).
    // Keep this the single source of truth — applyCompactCard,
    // composerEnsureBadgeCSS and composerEditOrder all read stepColor().
    const STEP_COLOR_DEFAULTS = {
        nav: '#6f9bff',
        snap: '#ff7ac0',
        thermalOn: '#ff9d2e',
        thermalOff: '#b5651d',
        gemOn: '#39ff14',
        gemOff: '#2e8b2e',
        wait: '#ffffff',
    };
    const CACHE_KEY_STEP_COLORS = 'aim-mb-step-colors';
    let stepColors = Object.assign({}, STEP_COLOR_DEFAULTS, gmGet(CACHE_KEY_STEP_COLORS, {}) || {});
    function stepColor(key) { return stepColors[key] || STEP_COLOR_DEFAULTS[key] || '#fff'; }
    // Re-apply every place a step color is rendered (called after a color change).
    function refreshStepColors() {
        if (CONTEXT !== 'IFRAME') return;
        try { composerEnsureBadgeCSS(true); } catch (e) {}
        try { applyNativeEditorCollapse(); } catch (e) {}
    }

    // Snapshot auto-AGL on save: when ON, every mission save re-sets each
    // snapshot's altitude to its DEM ground + the default AGL (so dragged
    // snapshots can't end up underground). SAFETY: this is in-memory only and
    // DEFAULTS OFF on every page load / Mission Bank entry — it must be turned
    // on deliberately via the editor-row button, which also raises a bright
    // on-map banner + a warning toast while it's ON. The default AGL itself is
    // persisted (Control Panel "Default snapshot AGL").
    let autoSnapAglEnabled = false;
    const CACHE_KEY_DEFAULT_SNAP_AGL = 'aim-mb-default-snap-agl';
    let defaultSnapAglFt = gmGet(CACHE_KEY_DEFAULT_SNAP_AGL, 10);
    // Editor compact-card altitude view: AGL (ground-relative) vs MSL (stored).
    // AGL reads more naturally; MSL is what's stored (for verifying). Toggle in
    // the editor button row. Persisted.
    const CACHE_KEY_AGL_VIEW = 'aim-mb-editor-agl-view';
    let showAglInEditor = gmGet(CACHE_KEY_AGL_VIEW, true);

    // Battery → flights mapping. User's IFS formula:
    //   > 560 → 7, > 480 → 6, > 360 → 5, > 270 → 4, > 180 → 3, >= 90 → 2, else 1
    // Adjustable via Settings cog popover. Drones land around 30% so 100%
    // raw usage already implies ~2 flights for full-charge starts.
    const DEFAULT_FLIGHT_THRESHOLDS = [560, 480, 360, 270, 180, 90];

    // Control Panel state
    let controlChannel = null;
    let controlPanelDetected = false;
    let masterEnabled = true;

    // Data cache: { [siteID]: { missions: [...], fetchedAt: timestamp } }
    const missionsBySite = {};
    let inFlightFetch = null; // de-dupe concurrent fetches

    // Mission Log cache: { [siteID]: { rows: [raw mission objects], total, fetchedAt } }
    // Distinct from missionsBySite — the log is execution history from
    // GET /missions/ (paginated), not the Mission Bank templates.
    const logBySite = {};
    let inFlightLogFetch = null;

    // Panel state — fresh each open
    let panelEl = null;
    let panelState = null; // { sortKey, sortDir, search, selectedIds, distanceUnit, drillId, tableScrollY }

    // Pending altitude changes — persist across panel close/reopen so
    // user can queue edits, navigate around, and commit later.
    // Shape: { [missionId]: { [instructionId]: { value: number, unit: 'imperial'|'metric' } } }
    const pendingAltitudes = {};
    let committingChanges = false;
    // Fast bulk save: when ON, staged altitude changes are spliced into the
    // user's outgoing mission save (POST /available_app/) in one shot instead
    // of the per-step dialog automation. SESSION-SCOPED + default OFF — resets
    // to false on every reload, so a save is never modified unless the user
    // deliberately flips it on this session. See installSaveHook / patchMissionSaveBody.
    let fastBulkSave = false;

    // Committed-but-not-yet-refetched altitudes. After a successful
    // queue commit, we update Percepto's per-step state but our
    // missionsBySite cache (from /available_app/) is still stale.
    // We track the new values here so the drill-down can show
    // "OLD ALT (new: NEW)" until the user hits Refresh.
    const committedAltitudes = {};

    // ========================================================
    // Control Panel integration
    // ========================================================
    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { return; }
        controlChannel.onmessage = (ev) => {
            controlPanelDetected = true;
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') {
                registerWithControlPanel();
                registerMissionSop();
            } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                if (msg.toggleId === 'master') {
                    masterEnabled = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (!masterEnabled) {
                        hideSumButton();
                        closePanel();
                        closeRightClickPopup();
                    } else {
                        runSumInjection();
                    }
                } else if (msg.toggleId === 'hide-scan-icons') {
                    const v = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (v !== hideScanIcons) {
                        hideScanIcons = v;
                        gmSet(CACHE_KEY_HIDE_SCAN_ICONS, hideScanIcons);
                        if (CONTEXT === 'IFRAME') try { applyMapIconDeclutter(document); } catch (e) {}
                    }
                } else if (msg.toggleId === 'collapse-editor-cards') {
                    const v = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (v !== collapseEditorCards) {
                        collapseEditorCards = v;
                        gmSet(CACHE_KEY_COLLAPSE_EDITOR, collapseEditorCards);
                        if (CONTEXT === 'IFRAME') {
                            try { applyNativeEditorCollapse(); } catch (e) {}
                            try { updateEditorCollapseBtn(); } catch (e) {}
                        }
                    }
                } else if (msg.toggleId === 'default-snap-agl') {
                    const v = Number(msg.value !== undefined ? msg.value : msg.enabled);
                    if (isFinite(v) && v !== defaultSnapAglFt) {
                        defaultSnapAglFt = v;
                        gmSet(CACHE_KEY_DEFAULT_SNAP_AGL, defaultSnapAglFt);
                        if (CONTEXT === 'IFRAME') { try { updateAutoSnapAglUI(); } catch (e) {} }
                    }
                } else if (typeof msg.toggleId === 'string' && msg.toggleId.indexOf('color-') === 0) {
                    const key = msg.toggleId.slice(6);
                    if (Object.prototype.hasOwnProperty.call(STEP_COLOR_DEFAULTS, key)) {
                        const v = msg.value !== undefined ? msg.value : msg.enabled;
                        if (typeof v === 'string' && v && stepColors[key] !== v) {
                            stepColors[key] = v;
                            gmSet(CACHE_KEY_STEP_COLORS, stepColors);
                            try { refreshStepColors(); } catch (e) {}
                        }
                    }
                }
            } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === MISSION_SOP_SCRIPT_ID) {
                handleMissionSopToggle(msg);
            } else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === MISSION_SOP_SCRIPT_ID) {
                // The Mission Bank UI (and its map) live in the IFRAME — run +
                // render the report there only, so the action fires exactly once.
                if (CONTEXT !== 'IFRAME') return;
                if (msg.actionId === 'mission-sop-run') runMissionSopAndReport();
                else if (msg.actionId === 'mission-sop-close') closeSopReport();
            }
        };
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Mission Bank Tools',
            description: 'Mission Summary panel + drill-down on Mission Bank URL.',
            version: SCRIPT_VERSION,
            group: 'Mission Bank Macros', scope: 'mission-bank', priority: 20,
            toggles: [
                { id: 'master', label: 'Enable', type: 'boolean', default: true, master: true },
                { id: 'hide-scan-icons', label: 'Hide scan-block map icons (GEM/Thermal/Wait)', type: 'boolean', default: true },
                { id: 'collapse-editor-cards', label: 'Collapse scan-block cards in the native editor', type: 'boolean', default: true },
                { id: 'default-snap-agl', label: 'Default snapshot AGL (auto-AGL toggle)', type: 'number', min: -50, max: 500, step: 1, default: 10, unit: 'ft' },
                { id: 'colors-header', label: 'Step colors (editor cards + map badges)', type: 'header' },
                { id: 'color-nav', label: 'Navigate', type: 'color', default: STEP_COLOR_DEFAULTS.nav },
                { id: 'color-snap', label: 'Snapshot', type: 'color', default: STEP_COLOR_DEFAULTS.snap },
                { id: 'color-thermalOn', label: 'Thermal On', type: 'color', default: STEP_COLOR_DEFAULTS.thermalOn },
                { id: 'color-thermalOff', label: 'Thermal Off', type: 'color', default: STEP_COLOR_DEFAULTS.thermalOff },
                { id: 'color-gemOn', label: 'GEM On', type: 'color', default: STEP_COLOR_DEFAULTS.gemOn },
                { id: 'color-gemOff', label: 'GEM Off', type: 'color', default: STEP_COLOR_DEFAULTS.gemOff },
                { id: 'color-wait', label: 'Wait', type: 'color', default: STEP_COLOR_DEFAULTS.wait },
            ],
            hotkeys: [],
        });
    }

    // ========================================================
    // Helpers — GM storage
    // ========================================================
    function gmGet(key, def) {
        try { return GM_getValue(key, def); } catch (e) { return def; }
    }
    function gmSet(key, val) {
        try { GM_setValue(key, val); } catch (e) {}
    }

    // ========================================================
    // Helpers — URL / site ID / site name
    // ========================================================
    function getCurrentSiteID() {
        const top = (() => { try { return window.top; } catch (e) { return window; } })();
        const hash = (top && top.location && top.location.hash) || location.hash || '';
        const m = hash.match(/#\/site\/(\d+)\//);
        return m ? m[1] : null;
    }

    function getCurrentSiteName() {
        // Percepto renders the site name in the top-frame site picker.
        // The Ant Design select uses `.ant-select-selection-item` with
        // a `title` attribute holding the full name (e.g. "Exxon 32 -
        // XBC Giddings Estate 1184H"). Fall back to textContent if no
        // title attribute, and to null if anything throws (cross-origin
        // / racing the initial render).
        try {
            const top = window.top || window;
            const candidates = [
                '.site-header__site-name',
                '.ant-select-selection-item',
                '[class*="site-name"]',
            ];
            for (const sel of candidates) {
                const el = top.document.querySelector(sel);
                if (el) {
                    const txt = (el.getAttribute && el.getAttribute('title')) || el.textContent;
                    if (txt && txt.trim()) return txt.trim();
                }
            }
        } catch (e) {}
        return null;
    }

    function isOnMissionBank() {
        const top = (() => { try { return window.top; } catch (e) { return window; } })();
        const hash = (top && top.location && top.location.hash) || location.hash || '';
        return /#\/site\/\d+\/control-panel\/mission-bank/.test(hash);
    }

    function isOnMissionLog() {
        const top = (() => { try { return window.top; } catch (e) { return window; } })();
        const hash = (top && top.location && top.location.hash) || location.hash || '';
        return /#\/site\/\d+\/mission-log/.test(hash);
    }

    // Which column set + visible-cols storage key is live, keyed off the
    // panel mode. 'bank' (default) preserves every existing Mission Bank
    // behaviour byte-for-byte; 'log' swaps in the Mission Log schema.
    function activeColumns() {
        return (panelState && panelState.mode === 'log') ? LOG_COLUMNS : COLUMNS;
    }
    function activeColById() {
        return (panelState && panelState.mode === 'log') ? LOG_COL_BY_ID : COL_BY_ID;
    }
    function visibleColsStorageKey() {
        return (panelState && panelState.mode === 'log') ? CACHE_KEY_VISIBLE_COLS_LOG : CACHE_KEY_VISIBLE_COLS;
    }

    // ========================================================
    // Data — fetch + derive per-mission stats
    // ========================================================
    // ========================================================
    // DEM elevation (Percepto's own /location_altitude/ endpoint)
    // ========================================================
    // Returns {altitude: meters} for a single lat/lng. Cookie-auth.
    // Cached aggressively in GM storage — same GPS appears in many
    // missions across many sessions, so the cache fills up fast and
    // bulk fetches become nearly instant on repeat use.
    const CACHE_KEY_ELEVATIONS = 'aim-mb-elev-cache';
    const ELEV_KEY_PRECISION = 5; // 5 decimals ≈ 1m
    const ELEV_CONCURRENCY = 4;   // max parallel fetches
    let elevationCache = null;    // lazy-loaded from GM storage
    let elevQueue = [];           // pending fetch tasks
    let elevActive = 0;           // currently in-flight fetches
    let elevBackoffUntil = 0;     // pause the queue until this time on a 429
    const elevFailedAt = {};      // key → last failure time (don't re-request for the cooldown)
    const ELEV_FAIL_COOLDOWN = 30000;
    const elevInFlight = {};      // key → Promise (so duplicate requests for same point share one fetch)

    function loadElevationCache() {
        if (elevationCache) return elevationCache;
        try { elevationCache = gmGet(CACHE_KEY_ELEVATIONS, {}) || {}; }
        catch (e) { elevationCache = {}; }
        return elevationCache;
    }

    // Debounced cache write — GM_setValue is synchronous and serializes
    // the whole object each call. During a 96-point bulk fetch this
    // could fire 96 times. Coalesce into one write 1s after the last
    // completion. flushElevationCache() forces immediate save if needed.
    // CHECKPOINT-EVERY-N strategy (v0.51) — same fix as Asset
    // Inspector v3.37. Old 1s-debounce-only approach lost the
    // cache when a bulk fetch ended without 1s of idle time, since
    // GM_setValue is async in Tampermonkey and beforeunload doesn't
    // get to complete the write. Now we commit every 50 new entries.
    const ELEV_SAVE_BATCH = 50;
    let elevDirtyCount = 0;
    let elevSaveTimer = null;
    function saveElevationCache() {
        if (!elevationCache) return;
        elevDirtyCount++;
        if (elevDirtyCount >= ELEV_SAVE_BATCH) {
            if (elevSaveTimer) { clearTimeout(elevSaveTimer); elevSaveTimer = null; }
            elevDirtyCount = 0;
            try { gmSet(CACHE_KEY_ELEVATIONS, elevationCache); } catch (e) {}
            return;
        }
        if (elevSaveTimer) clearTimeout(elevSaveTimer);
        elevSaveTimer = setTimeout(() => {
            elevSaveTimer = null;
            elevDirtyCount = 0;
            try { gmSet(CACHE_KEY_ELEVATIONS, elevationCache); } catch (e) {}
        }, 1000);
    }
    function flushElevationCache() {
        if (elevSaveTimer) { clearTimeout(elevSaveTimer); elevSaveTimer = null; }
        if (!elevationCache) return;
        elevDirtyCount = 0;
        try { gmSet(CACHE_KEY_ELEVATIONS, elevationCache); } catch (e) {}
    }

    function elevCacheKey(lat, lng) {
        return `${Number(lat).toFixed(ELEV_KEY_PRECISION)},${Number(lng).toFixed(ELEV_KEY_PRECISION)}`;
    }

    // Asset Inspector exposes its OTD-backed (Open-Topo-Data, batched, NO Percepto
    // rate-limit) elevation service on window.__aimAIElevation for sibling scripts.
    // When present we route MBT's DEM through it — this is what kills the bulk-
    // generate "Elevation Not Loaded" 429 storm (Percepto's /location_altitude/
    // throttles hard; OTD batches 100 pts/request). Falls back to MBT's own Percepto
    // queue when the bridge isn't there (suite not fully installed).
    function aiElev() {
        try { const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window; const b = w && w.__aimAIElevation; return (b && typeof b.fetch === 'function') ? b : null; }
        catch (e) { return null; }
    }

    // Reuse an already-cached DEM point within this radius instead of re-fetching.
    // Ground over a flat pad is constant, and OTD's ned10m is a 10 m dataset, so any
    // sample within ~50 ft is the same ground — this is what stops the generator from
    // re-requesting centroids we effectively already have (Asset Inspector samples
    // every asset vertex + edge midpoints, so a nearby cached hit is almost always
    // present).
    const MB_ELEV_NEAR_M = 15;
    function getElevationFromCache(lat, lng) {
        const br = aiElev();
        if (br) {
            try {
                const v = br.getCached(lat, lng);
                if (v != null) return v;
                if (typeof br.getNearest === 'function') { const n = br.getNearest(lat, lng, MB_ELEV_NEAR_M); if (n != null) return n; }
            } catch (e) {}
        }
        const cache = loadElevationCache();
        return cache[elevCacheKey(lat, lng)];
    }

    // Fetch a single elevation. Returns Promise<meters | null>.
    // 3-tier resolution:
    //   1. Cache hit → resolve immediately
    //   2. In-flight request for same key → return SHARED promise (this
    //      is the critical dedup — without it, re-renders that fire
    //      while a batch is mid-flight create duplicate HTTP requests)
    //   3. Miss → push to queue, throttled through pumpElevQueue
    function fetchElevation(lat, lng) {
        const br = aiElev();
        if (br) { try { return Promise.resolve(br.fetch(lat, lng)); } catch (e) {} }
        const key = elevCacheKey(lat, lng);
        const cache = loadElevationCache();
        if (cache[key] != null) return Promise.resolve(cache[key]);
        if (elevInFlight[key]) return elevInFlight[key];
        // Don't re-request a position that just failed (429/error) — this is what
        // turned rate-limits into a request STORM (fail → uncached → re-request).
        if (elevFailedAt[key] && Date.now() - elevFailedAt[key] < ELEV_FAIL_COOLDOWN) return Promise.resolve(null);
        const p = new Promise(resolve => {
            elevQueue.push({ lat, lng, key, resolve });
            pumpElevQueue();
        }).then(meters => {
            delete elevInFlight[key];
            return meters;
        });
        elevInFlight[key] = p;
        return p;
    }

    function pumpElevQueue() {
        const now = Date.now();
        if (now < elevBackoffUntil) { setTimeout(pumpElevQueue, (elevBackoffUntil - now) + 50); return; } // rate-limited; wait
        while (elevActive < ELEV_CONCURRENCY && elevQueue.length > 0) {
            const task = elevQueue.shift();
            elevActive++;
            const url = `/location_altitude/?location=${encodeURIComponent(JSON.stringify({ lat: task.lat, lng: task.lng }))}`;
            fetch(url, { credentials: 'include' })
                .then(r => { if (r.status === 429) { elevBackoffUntil = Date.now() + 6000; return null; } return r.ok ? r.json() : null; })
                .then(data => {
                    const meters = data && typeof data.altitude === 'number' ? data.altitude : null;
                    if (meters != null) {
                        const cache = loadElevationCache();
                        cache[task.key] = meters;
                        saveElevationCache();
                        delete elevFailedAt[task.key];
                    } else { elevFailedAt[task.key] = Date.now(); } // 429/miss → cool down before retry
                    task.resolve(meters);
                })
                .catch(() => { elevFailedAt[task.key] = Date.now(); task.resolve(null); })
                .finally(() => { elevActive--; pumpElevQueue(); });
        }
    }

    // Bulk-fetch elevations for many points with progress callbacks.
    // points: [{lat, lng, id?}] — id is yours, returned in the result map.
    // Returns Promise<{[id|index]: meters | null}>.
    function bulkFetchElevations(points, onProgress) {
        if (!points || points.length === 0) return Promise.resolve({});
        // Prefer the OTD bridge — batched, no Percepto 429 (the bulk-generate fix).
        const br = aiElev();
        if (br && typeof br.bulk === 'function') { try { return Promise.resolve(br.bulk(points, onProgress)); } catch (e) {} }
        let done = 0;
        const total = points.length;
        const result = {};
        const promises = points.map((p, i) => {
            const key = p.id != null ? p.id : i;
            return fetchElevation(p.lat, p.lng).then(meters => {
                result[key] = meters;
                done++;
                if (onProgress) onProgress(done, total);
            });
        });
        return Promise.all(promises).then(() => result);
    }

    function fetchMissions(siteID, onDone, onErr) {
        if (!siteID) { onErr && onErr('No site loaded'); return; }
        const url = `/available_app/?site_id=${encodeURIComponent(siteID)}&type=1`;
        if (inFlightFetch === siteID) return; // already fetching
        inFlightFetch = siteID;
        console.log(`${TAG} fetching missions for site ${siteID}`);
        fetch(url, { credentials: 'include' })
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(arr => {
                inFlightFetch = null;
                if (!Array.isArray(arr)) throw new Error('Unexpected response shape');
                missionsBySite[siteID] = { missions: arr, fetchedAt: Date.now() };
                console.log(`${TAG} loaded ${arr.length} missions for site ${siteID}`);
                onDone && onDone(arr);
            })
            .catch(e => {
                inFlightFetch = null;
                console.warn(`${TAG} fetch failed:`, e.message);
                onErr && onErr(e.message);
            });
    }

    // Filter out takeoff + returnHome from instructions (always-present
    // structural steps per user's spec).
    function realSteps(instructions) {
        if (!Array.isArray(instructions)) return [];
        return instructions.filter(s => s && s.type_name !== 'takeoff' && s.type_name !== 'returnHome');
    }

    function countByType(instructions, typeName) {
        if (!Array.isArray(instructions)) return 0;
        return instructions.filter(s => s && s.type_name === typeName).length;
    }

    function getFlightThresholds() {
        const stored = gmGet(CACHE_KEY_FLIGHT_THRESHOLDS, null);
        if (Array.isArray(stored) && stored.length === 6) return stored;
        return DEFAULT_FLIGHT_THRESHOLDS.slice();
    }

    function estimateFlights(batteryPct, thresholds) {
        const t = thresholds || getFlightThresholds();
        if (batteryPct == null) return null;
        if (batteryPct > t[0]) return 7;
        if (batteryPct > t[1]) return 6;
        if (batteryPct > t[2]) return 5;
        if (batteryPct > t[3]) return 4;
        if (batteryPct > t[4]) return 3;
        if (batteryPct >= t[5]) return 2;
        return 1;
    }

    function buildMissionRow(mission) {
        const app = mission.app_data || {};
        const inst = mission.instructions || [];
        const real = realSteps(inst);
        return {
            id: mission.id,
            name: mission.name || '',
            siteName: mission.site_name || '',
            active: !!mission.is_active,
            description: mission.description || '',
            robotTypes: (mission.robot_type_names || []).join(', '),
            steps: real.length,
            flightTimeS: Number(app.flight_time) || 0,
            flightDistanceM: Number(app.flight_distance) || 0,
            navTimeS: Number(app.nav_flight_time) || 0,
            navConsumption: Number(app.nav_consumption) || 0,
            waitTimeS: Number(app.wait_flight_time) || 0,
            waitConsumption: Number(app.wait_consumption) || 0,
            extraTimeS: Number(app.extra_flight_time) || 0,
            extraConsumption: Number(app.extra_consumption) || 0,
            landingTimeS: Number(app.landing_flight_time) || 0,
            landingConsumption: Number(app.landing_consumption) || 0,
            takeoffTimeS: Number(app.takeoff_flight_time) || 0,
            takeoffConsumption: Number(app.takeoff_consumption) || 0,
            batteryConsumption: Number(app.battery_consumption) || 0,
            // Total = sum of all phases (often equals battery_consumption but
            // not always — phases are tracked separately).
            totalConsumption: (Number(app.nav_consumption) || 0)
                + (Number(app.wait_consumption) || 0)
                + (Number(app.extra_consumption) || 0)
                + (Number(app.landing_consumption) || 0)
                + (Number(app.takeoff_consumption) || 0),
            // Raw instruction list for drill-down
            instructions: inst,
            realSteps: real,
            // Per-step-type counts — dynamically keyed so ANY step type
            // Percepto uses (including future ones) appears automatically.
            stepTypeCounts: (() => {
                const c = {};
                real.forEach(s => { const k = stepCountKey(s); c[k] = (c[k] || 0) + 1; });
                return c;
            })(),
        };
    }

    function buildAllRows(siteID) {
        const bucket = missionsBySite[siteID];
        if (!bucket) return [];
        return bucket.missions.map(buildMissionRow);
    }

    // ========================================================
    // Formatters
    // ========================================================
    function fmtTime(seconds) {
        if (!seconds || seconds < 0) return '—';
        const s = Math.round(seconds);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        return `${m}:${String(sec).padStart(2, '0')}`;
    }

    function getDistanceUnit() {
        return gmGet(CACHE_KEY_DISTANCE_UNIT, 'imperial');
    }

    function fmtDistance(meters, unit) {
        if (!meters || meters < 0) return '—';
        const u = unit || getDistanceUnit();
        if (u === 'imperial') {
            const mi = meters * 0.000621371;
            if (mi >= 0.1) return `${mi.toFixed(2)} mi`;
            const ft = meters * 3.28084;
            return `${Math.round(ft)} ft`;
        } else {
            const km = meters / 1000;
            if (km >= 0.1) return `${km.toFixed(2)} km`;
            return `${Math.round(meters)} m`;
        }
    }

    function fmtPct(n) {
        if (n == null || isNaN(n)) return '—';
        return `${Math.round(n)} %`;
    }

    function fmtNum(n) {
        if (n == null || isNaN(n)) return '—';
        return String(n);
    }

    // Display-friendly step type name. Default = raw type_name; specific
    // overrides for types the user reads frequently.
    function displayStepType(s) {
        const t = s && s.type_name;
        if (!t) return '?';
        if (t === 'cameraSelect') return 'Thermal';
        if (t === 'gemMode') return 'GEM';
        // Capitalize first letter of unknown/default types (navigate → Navigate, etc.)
        return t.charAt(0).toUpperCase() + t.slice(1);
    }

    // Key used for the Step Counts card. Splits Thermal/GEM into On/Off
    // variants so the user sees them separately, then sorts by a fixed
    // importance order with unknown types appended alphabetically.
    const STEP_COUNT_ORDER = [
        'navigate', 'snapshot', 'Thermal On', 'GEM On', 'wait',
        'GEM Off', 'Thermal Off',
    ];
    function stepCountKey(s) {
        if (!s) return '?';
        const t = s.type_name;
        if (t === 'cameraSelect') {
            const on = s.value1 === true || s.value1 === 1 || s.value1 === '1';
            return on ? 'Thermal On' : 'Thermal Off';
        }
        if (t === 'gemMode') {
            const on = s.value1 === true || s.value1 === 1 || s.value1 === '1';
            return on ? 'GEM On' : 'GEM Off';
        }
        return displayStepType(s);
    }

    function buildOrderedStepCounts(realSteps) {
        const counts = {};
        (realSteps || []).forEach(s => {
            const k = stepCountKey(s);
            counts[k] = (counts[k] || 0) + 1;
        });
        const ordered = [];
        STEP_COUNT_ORDER.forEach(k => {
            if (counts[k] != null) { ordered.push([k, counts[k]]); delete counts[k]; }
        });
        Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))
            .forEach(e => ordered.push(e));
        return ordered;
    }

    // Display-friendly step value. Bool-ish/0-1 types render as On/Off.
    // Accepts optional `unit` for meter→feet conversion on altitude values.
    function displayStepValue(s, unit) {
        if (!s) return '';
        const t = s.type_name;
        const v = s.value1;
        if (t === 'cameraSelect') {
            // Percepto stores camera type as a string ("Thermal"/"Visual")
            // OR boolean — render whichever is meaningful.
            if (typeof v === 'boolean') return v ? 'On' : 'Off';
            if (v === 1 || v === '1') return 'On';
            if (v === 0 || v === '0') return 'Off';
            return v != null ? String(v) : '';
        }
        if (t === 'gemMode') {
            if (v === 1 || v === '1' || v === true) return 'On';
            if (v === 0 || v === '0' || v === false) return 'Off';
            return v != null ? String(v) : '';
        }
        if (v == null) return '';
        // Navigate/snapshot values are altitude in meters. Convert to
        // feet when imperial, round to whole number, comma-format.
        if (s.value1_name === 'm' && typeof v === 'number') {
            const u = unit || getDistanceUnit();
            if (u === 'imperial') {
                const ft = Math.round(v * 3.28084);
                return `${ft.toLocaleString()} ft ALT`;
            }
            return `${Math.round(v).toLocaleString()} m ALT`;
        }
        return `${v}${s.value1_name ? ' ' + s.value1_name : ''}`;
    }

    // ========================================================
    // Column schema
    // ========================================================
    // Each column: {
    //   id, label, key, kind ('text'|'num'|'time'|'distance'|'pct'|'dot'),
    //   defaultVisible, csvExclude, csvKey, csvFmt (override CSV string)
    // }
    // Static columns — step-type counts are dynamic (discovered from data).
    // Dynamic step-type columns are inserted after 'steps' by refreshDynamicColumns.
    const STATIC_COLUMNS = [
        { id: 'active', label: 'Active', key: 'active', kind: 'dot', defaultVisible: true, csvExclude: true },
        { id: 'name', label: 'Mission Name', key: 'name', kind: 'text', defaultVisible: true, primary: true },
        { id: 'flightDistance', label: 'Flight Distance', key: 'flightDistanceM', kind: 'distance', defaultVisible: true },
        { id: 'flightTime', label: 'Flight Time', key: 'flightTimeS', kind: 'time', defaultVisible: true },
        { id: 'steps', label: 'Steps', key: 'steps', kind: 'num', defaultVisible: true },
        // ← dynamic step-type columns inserted here
        { id: 'batteryConsumption', label: 'Battery %', key: 'batteryConsumption', kind: 'pct', defaultVisible: true },
        { id: 'estFlights', label: 'Est. Flights', key: '__estFlights', kind: 'num', defaultVisible: true, derived: true },
        { id: 'totalConsumption', label: 'Total Consumption %', key: 'totalConsumption', kind: 'pct', defaultVisible: true },
        { id: 'siteName', label: 'Site Name', key: 'siteName', kind: 'text', defaultVisible: false },
        { id: 'navTime', label: 'Nav Time', key: 'navTimeS', kind: 'time', defaultVisible: false },
        { id: 'navConsumption', label: 'Nav Consumption %', key: 'navConsumption', kind: 'pct', defaultVisible: false },
        { id: 'waitTime', label: 'Wait Time', key: 'waitTimeS', kind: 'time', defaultVisible: false },
        { id: 'waitConsumption', label: 'Wait Consumption %', key: 'waitConsumption', kind: 'pct', defaultVisible: false },
        { id: 'extraTime', label: 'Extra Time', key: 'extraTimeS', kind: 'time', defaultVisible: false },
        { id: 'extraConsumption', label: 'Extra Consumption %', key: 'extraConsumption', kind: 'pct', defaultVisible: false },
        { id: 'landingTime', label: 'Landing Time', key: 'landingTimeS', kind: 'time', defaultVisible: false },
        { id: 'landingConsumption', label: 'Landing Consumption %', key: 'landingConsumption', kind: 'pct', defaultVisible: false },
        { id: 'takeoffTime', label: 'Takeoff Time', key: 'takeoffTimeS', kind: 'time', defaultVisible: false },
        { id: 'takeoffConsumption', label: 'Takeoff Consumption %', key: 'takeoffConsumption', kind: 'pct', defaultVisible: false },
        { id: 'description', label: 'Description', key: 'description', kind: 'text', defaultVisible: false },
        { id: 'robotTypes', label: 'Robot Types', key: 'robotTypes', kind: 'text', defaultVisible: false },
        { id: 'id', label: 'ID', key: 'id', kind: 'num', defaultVisible: false },
    ];

    // Dynamic step-type columns. COLUMNS + COL_BY_ID are rebuilt by
    // refreshDynamicColumns() after missions load for a site. All
    // existing code references COLUMNS/COL_BY_ID and keeps working.
    const DEFAULT_VISIBLE_STEP_TYPES = new Set(['navigate', 'snapshot']);

    // Migration: v0.8 used hardcoded column IDs for step types.
    // Map them to the new stype:<key> IDs so stored prefs carry over.
    const COLUMN_ID_MIGRATION = {
        'navigates': 'stype:navigate',
        'snapshots': 'stype:snapshot',
        'waits': 'stype:wait',
        'thermalOns': 'stype:Thermal On',
        'thermalOffs': 'stype:Thermal Off',
        'gemOns': 'stype:GEM On',
        'gemOffs': 'stype:GEM Off',
    };

    let COLUMNS = STATIC_COLUMNS.slice();
    let COL_BY_ID = Object.fromEntries(COLUMNS.map(c => [c.id, c]));

    function discoverStepTypes(siteID) {
        const bucket = missionsBySite[siteID];
        if (!bucket) return [];
        const allTypes = new Set();
        bucket.missions.forEach(m => {
            const real = realSteps(m.instructions || []);
            real.forEach(s => allTypes.add(stepCountKey(s)));
        });
        // Sort using the fixed importance order; unknowns alphabetical at end.
        const arr = Array.from(allTypes);
        const idx = (k) => { const i = STEP_COUNT_ORDER.indexOf(k); return i >= 0 ? i : STEP_COUNT_ORDER.length; };
        arr.sort((a, b) => {
            const ia = idx(a), ib = idx(b);
            if (ia !== ib) return ia - ib;
            return a.localeCompare(b);
        });
        return arr;
    }

    function refreshDynamicColumns(siteID) {
        const types = discoverStepTypes(siteID);
        const dynamic = types.map(t => ({
            id: `stype:${t}`,
            label: t,
            stepTypeKey: t,
            kind: 'num',
            defaultVisible: DEFAULT_VISIBLE_STEP_TYPES.has(t),
            dynamic: true,
        }));
        // Rebuild COLUMNS: static with dynamic inserted after 'steps'
        const result = [];
        STATIC_COLUMNS.forEach(c => {
            result.push(c);
            if (c.id === 'steps') result.push(...dynamic);
        });
        COLUMNS = result;
        COL_BY_ID = Object.fromEntries(COLUMNS.map(c => [c.id, c]));
    }

    function getVisibleColumnIds() {
        const cols = activeColumns();
        const byId = activeColById();
        const stored = gmGet(visibleColsStorageKey(), null);
        if (Array.isArray(stored) && stored.length > 0) {
            // Migrate v0.8 hardcoded step-type IDs → stype:… IDs (bank only;
            // log IDs aren't in the map so this is a no-op for log).
            const migrated = stored.map(id => COLUMN_ID_MIGRATION[id] || id);
            return migrated.filter(id => byId[id]);
        }
        return cols.filter(c => c.defaultVisible).map(c => c.id);
    }

    function setVisibleColumnIds(ids) {
        gmSet(visibleColsStorageKey(), ids);
    }

    function formatCellValue(row, col, unit, thresholds) {
        // Columns may carry their own formatter (used by Mission Log mode).
        if (typeof col.fmt === 'function') return col.fmt(row, unit);
        if (col.id === 'estFlights') {
            return fmtNum(estimateFlights(row.batteryConsumption, thresholds));
        }
        if (col.dynamic && col.stepTypeKey) {
            return fmtNum((row.stepTypeCounts || {})[col.stepTypeKey] || 0);
        }
        const v = row[col.key];
        switch (col.kind) {
            case 'time': return fmtTime(v);
            case 'distance': return fmtDistance(v, unit);
            case 'pct': return fmtPct(v);
            case 'num': return fmtNum(v);
            case 'text': return v || '';
            case 'dot': return v;
            default: return v;
        }
    }

    function getSortValue(row, col, thresholds) {
        if (typeof col.sortVal === 'function') return col.sortVal(row);
        if (col.id === 'estFlights') return estimateFlights(row.batteryConsumption, thresholds) || 0;
        if (col.dynamic && col.stepTypeKey) return (row.stepTypeCounts || {})[col.stepTypeKey] || 0;
        const v = row[col.key];
        if (col.kind === 'text' || col.kind === 'dot') return (v || '').toString().toLowerCase();
        return Number(v) || 0;
    }

    // ========================================================
    // MISSION LOG MODE — execution-history SUM
    // ========================================================
    // The Mission Log (#/site/<id>/mission-log) is a DIFFERENT React page +
    // data source from the Mission Bank: it's flight history pulled from
    // GET /missions/ (paginated), not the bank templates. We reuse the whole
    // SUM panel (chrome, table render, sort/filter, columns menu, export) by
    // running it in panelState.mode === 'log' against LOG_COLUMNS + log rows.

    const LOG_ONLY_FIELDS = 'id,mission_group_id,uploader_status,uploader_planned_images_count,drone_name,when,image_count,created_by_username,app_name,type,state,videos,landed,landing_files,tracking_files,landing_is_failed,duration,mission_data_reports,map_status,map_type,is_media_mission';

    // Percepto stores `when` as ISO UTC and `duration` as milliseconds.
    const LOG_CT_FMT = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: 'numeric', minute: '2-digit', hour12: true
    });
    function fmtWhenCT(ms) {
        if (ms == null) return '';
        const d = new Date(ms);
        if (isNaN(d.getTime())) return '';
        const p = {};
        for (const x of LOG_CT_FMT.formatToParts(d)) p[x.type] = x.value;
        return `${p.month}/${p.day}/${p.year} - ${p.hour}:${p.minute}${(p.dayPeriod || '').toLowerCase()} CT`;
    }
    function fmtDurationMs(ms) {
        if (ms == null) return '';
        const s = Math.round(ms / 1000);
        const pad = (n) => String(n).padStart(2, '0');
        if (s <= 0) return '00:00';
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
    }
    // Best-effort state-code labels — refine once the enum is confirmed.
    const LOG_STATE_LABELS = { 0: 'Pending', 1: 'In Progress', 2: 'Completed', 3: 'Aborted', 4: 'Failed', 5: 'Cancelled' };
    function logStateLabel(code) {
        if (code == null) return '';
        return LOG_STATE_LABELS[code] != null ? LOG_STATE_LABELS[code] : `State ${code}`;
    }

    const LOG_COLUMNS = [
        { id: 'id', label: 'Mission ID', key: 'id', kind: 'num', defaultVisible: true },
        { id: 'missionGroup', label: 'Group', key: 'missionGroup', kind: 'text', defaultVisible: true },
        { id: 'name', label: 'Name', key: 'name', kind: 'text', defaultVisible: true, primary: true },
        { id: 'timeCT', label: 'Time (CT)', kind: 'text', defaultVisible: true, fmt: (r) => fmtWhenCT(r.whenMs), sortVal: (r) => r.whenMs || 0 },
        { id: 'duration', label: 'Duration', kind: 'text', defaultVisible: true, fmt: (r) => fmtDurationMs(r.durationMs), sortVal: (r) => r.durationMs || 0 },
        { id: 'drone', label: 'Drone', key: 'drone', kind: 'text', defaultVisible: true },
        { id: 'type', label: 'Type', key: 'type', kind: 'text', defaultVisible: true },
        { id: 'state', label: 'State', kind: 'text', defaultVisible: true, fmt: (r) => r.stateLabel, sortVal: (r) => (r.stateCode == null ? -1 : r.stateCode) },
        { id: 'status', label: 'Status', kind: 'text', defaultVisible: true, fmt: (r) => (r._aborted ? '⚠ Aborted' : (r.landed || '')), sortVal: (r) => (r._aborted ? 1 : 0) },
        { id: 'images', label: 'Images', key: 'images', kind: 'num', defaultVisible: true },
        { id: 'videos', label: 'Videos', key: 'videoCount', kind: 'num', defaultVisible: false },
        { id: 'createdBy', label: 'Created By', key: 'createdBy', kind: 'text', defaultVisible: false },
        { id: 'media', label: 'Media Mission', kind: 'text', defaultVisible: false, fmt: (r) => (r.isMedia ? 'Yes' : 'No'), sortVal: (r) => (r.isMedia ? 1 : 0) },
    ];
    const LOG_COL_BY_ID = Object.fromEntries(LOG_COLUMNS.map(c => [c.id, c]));

    function buildLogRow(m) {
        const whenMs = m.when ? Date.parse(m.when) : null;
        const durationMs = (typeof m.duration === 'number') ? m.duration : (m.duration != null ? Number(m.duration) : 0);
        const stateCode = (m.state != null) ? m.state : null;
        const durS = durationMs != null ? Math.round(durationMs / 1000) : null;
        const aborted = (durationMs === 0) || (m.landing_is_failed === true);
        return {
            id: m.id,
            missionGroup: m.mission_group_id != null ? m.mission_group_id : '',
            name: m.app_name || '',
            whenMs, whenISO: m.when || '',
            durationMs: durationMs == null ? 0 : durationMs, durationS: durS,
            drone: m.drone_name || '',
            type: m.type || '',
            stateCode, stateLabel: logStateLabel(stateCode),
            landed: m.landed || '',
            landingFailed: m.landing_is_failed,
            images: m.image_count != null ? m.image_count : 0,
            videoCount: Array.isArray(m.videos) ? m.videos.length : 0,
            isMedia: !!m.is_media_mission,
            createdBy: m.created_by_username || '',
            _aborted: aborted,
            _raw: m,
        };
    }
    function buildLogRows(siteID) {
        const bucket = logBySite[siteID];
        if (!bucket) return [];
        return bucket.rows.map(buildLogRow);
    }

    // Paginated fetch of the full execution history. /missions/ returns the
    // newest `past_missions` page + a `total_mission_count`; we walk backward
    // via `last_mission_id` until we've collected the total (or a page is empty).
    function fetchMissionLog(siteID, onDone, onErr) {
        const all = [];
        let total = null;
        let guard = 0;
        const end = new Date(), start = new Date();
        start.setFullYear(start.getFullYear() - 2); // 2-year window
        const fmt = (d) => d.toISOString().slice(0, 10);

        function finish() {
            inFlightLogFetch = null;
            logBySite[siteID] = { rows: all, total: total != null ? total : all.length, fetchedAt: Date.now() };
            dlog(`${TAG} log fetch done: ${all.length} missions (total ${total})`);
            if (onDone) onDone();
        }
        function page(lastId) {
            if (++guard > 80) { finish(); return; } // safety cap (~1600 missions)
            const params = {
                site_id: Number(siteID), drones: [], missionTypes: [], missionId: [],
                users: [], state: null, takeoffCompleted: false,
                start: fmt(start), end: fmt(end), last_mission_id: lastId
            };
            const url = `/missions/?site_id=${encodeURIComponent(siteID)}&params=${encodeURIComponent(JSON.stringify(params))}&only=${encodeURIComponent(LOG_ONLY_FIELDS)}`;
            fetch(url, { credentials: 'include' })
                .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(j => {
                    const past = (j && j.past_missions) || [];
                    if (total == null && typeof j.total_mission_count === 'number') total = j.total_mission_count;
                    all.push(...past);
                    const lastMid = past.length ? past[past.length - 1].id : null;
                    const more = past.length > 0 && (total == null || all.length < total) && lastMid != null && lastMid !== lastId;
                    if (more) page(lastMid); else finish();
                })
                .catch(e => {
                    inFlightLogFetch = null;
                    console.error(`${TAG} log fetch failed`, e);
                    if (onErr) onErr(e.message || String(e));
                });
        }
        inFlightLogFetch = siteID;
        page(-1);
    }

    function renderLogTableView() {
        const sid = getCurrentSiteID();
        if (!sid) return;
        panelState.drillId = null;
        updateTitle();
        const allRows = buildLogRows(sid);
        const rows = filterAndSort(allRows);
        const visibleCols = getVisibleColumnIds().map(id => LOG_COL_BY_ID[id]).filter(Boolean);
        const total = (logBySite[sid] && logBySite[sid].total) || allRows.length;
        const html = `
            <div class="aim-mb-toolbar">
                <input class="aim-mb-search" type="text" placeholder="Search name / type / drone / group…" value="${escapeHtml(panelState.search)}" />
                <button class="aim-mb-tbtn" data-cols>Columns ▾</button>
                <button class="aim-mb-tbtn" data-stats title="Rollups, coverage gaps, outliers">📊 Stats</button>
                <button class="aim-mb-tbtn" data-refresh title="Re-fetch the log">↻</button>
            </div>
            <div class="aim-mb-table-wrap" id="aim-mb-table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th style="width:32px;"><input type="checkbox" data-select-all ${selectAllState(rows)} /></th>
                            ${visibleCols.map(col => renderHeaderCell(col)).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(r => renderRow(r, visibleCols, panelState.thresholds)).join('')}
                    </tbody>
                </table>
            </div>
            <div class="aim-mb-footer">
                <div class="aim-mb-info">
                    ${rows.length} of ${total} mission${total === 1 ? '' : 's'}${panelState.selectedIds.size > 0 ? ` · <strong style="color:#14d2dc">${panelState.selectedIds.size} selected</strong>` : ''}
                </div>
                <button class="aim-mb-tbtn" data-export="csv">Copy CSV</button>
                <button class="aim-mb-tbtn" data-export="tsv">Copy → Sheets</button>
                <button class="aim-mb-tbtn" data-export="json">Copy JSON</button>
            </div>
        `;
        setBodyHtml(html);
        const tw = panelEl.querySelector('#aim-mb-table-wrap');
        if (tw && panelState.tableScrollY) tw.scrollTop = panelState.tableScrollY;
        wireLogTableEvents(rows, visibleCols);
    }

    function wireLogTableEvents(rows, visibleCols) {
        const search = panelEl.querySelector('.aim-mb-search');
        if (search) {
            let dbnc = null;
            search.addEventListener('input', (e) => {
                const cursor = e.target.selectionStart;
                const newVal = e.target.value;
                if (dbnc) clearTimeout(dbnc);
                dbnc = setTimeout(() => {
                    panelState.search = newVal;
                    renderTableView();
                    const ns = panelEl.querySelector('.aim-mb-search');
                    if (ns) { ns.focus(); try { ns.setSelectionRange(cursor, cursor); } catch (er) {} }
                }, 250);
            });
        }
        const colsBtn = panelEl.querySelector('[data-cols]');
        if (colsBtn) colsBtn.onclick = () => openColumnsMenu(colsBtn);
        const statsBtn = panelEl.querySelector('[data-stats]');
        if (statsBtn) statsBtn.onclick = () => renderLogStats();
        const refreshBtn = panelEl.querySelector('[data-refresh]');
        if (refreshBtn) refreshBtn.onclick = () => {
            const sid = getCurrentSiteID();
            delete logBySite[sid];
            renderLoadingState();
            fetchMissionLog(sid, () => renderTableView(), (err) => renderErrorState(err));
        };
        panelEl.querySelectorAll('th[data-col]').forEach(th => {
            th.onclick = () => {
                const colId = th.dataset.col;
                if (panelState.sortKey === colId) {
                    if (panelState.sortDir === 'asc') panelState.sortDir = 'desc';
                    else if (panelState.sortDir === 'desc') { panelState.sortKey = 'timeCT'; panelState.sortDir = 'desc'; }
                    else panelState.sortDir = 'asc';
                } else { panelState.sortKey = colId; panelState.sortDir = 'asc'; }
                renderTableView();
            };
        });
        panelEl.querySelectorAll('tbody tr[data-id]').forEach(tr => {
            tr.onclick = (e) => {
                if (e.target.matches('input[type="checkbox"]')) return;
                const tw = panelEl.querySelector('#aim-mb-table-wrap');
                if (tw) panelState.tableScrollY = tw.scrollTop;
                renderLogDetail(Number(tr.dataset.id));
            };
        });
        wireRowSelectCheckboxes(rows);
        const selAll = panelEl.querySelector('[data-select-all]');
        if (selAll) selAll.onclick = (e) => {
            e.stopPropagation();
            if (selAll.checked) rows.forEach(r => panelState.selectedIds.add(r.id));
            else rows.forEach(r => panelState.selectedIds.delete(r.id));
            renderTableView();
        };
        panelEl.querySelectorAll('[data-export]').forEach(b => {
            b.onclick = () => doExport(b.dataset.export, rows, visibleCols);
        });
    }

    function renderLogDetail(missionId) {
        const sid = getCurrentSiteID();
        const row = buildLogRows(sid).find(r => r.id === missionId);
        if (!row) { renderTableView(); return; }
        panelState.drillId = missionId;
        const m = row._raw || {};
        const f = (label, val) => `<div style="display:flex;gap:10px;padding:4px 0;border-bottom:1px solid #1f1f1f;"><span style="color:#888;min-width:150px;flex-shrink:0;">${escapeHtml(label)}</span><span style="color:#e6e6e6;word-break:break-word;">${escapeHtml(val == null || val === '' ? '—' : String(val))}</span></div>`;
        const html = `
            <div class="aim-mb-toolbar">
                <button class="aim-mb-tbtn" data-back>← Back</button>
                <span style="font-weight:700;color:#14d2dc;">${escapeHtml(row.name)} · #${row.id}</span>
            </div>
            <div class="aim-mb-table-wrap" style="padding:10px 14px;font-size:12px;">
                ${f('Name', row.name)}
                ${f('Mission ID', row.id)}
                ${f('Group', row.missionGroup)}
                ${f('Time (CT)', fmtWhenCT(row.whenMs))}
                ${f('Time (raw UTC)', row.whenISO)}
                ${f('Duration', fmtDurationMs(row.durationMs))}
                ${f('Drone', row.drone)}
                ${f('Type', row.type)}
                ${f('State', `${row.stateLabel} (${row.stateCode})`)}
                ${f('Landed', row.landed)}
                ${f('Landing failed', row.landingFailed)}
                ${f('Aborted (derived)', row._aborted ? 'Yes' : 'No')}
                ${f('Images', row.images)}
                ${f('Videos', row.videoCount)}
                ${f('Media mission', row.isMedia ? 'Yes' : 'No')}
                ${f('Created by', row.createdBy)}
                ${f('Map status', m.map_status)}
                ${f('Map type', m.map_type)}
                ${f('Uploader status', m.uploader_status)}
                ${f('Planned images', m.uploader_planned_images_count)}
            </div>
        `;
        setBodyHtml(html);
        const back = panelEl.querySelector('[data-back]');
        if (back) back.onclick = () => renderTableView();
    }

    function renderLogStats() {
        const sid = getCurrentSiteID();
        const rows = buildLogRows(sid);
        const gapDays = Number(gmGet(CACHE_KEY_GAP_DAYS, DEFAULT_GAP_DAYS)) || DEFAULT_GAP_DAYS;
        const now = Date.now();
        const daysSince = (ms) => (ms ? Math.floor((now - ms) / 86400000) : null);

        const groups = {};
        let totalMs = 0, minWhen = Infinity, maxWhen = -Infinity;
        rows.forEach(r => {
            totalMs += r.durationMs || 0;
            if (r.whenMs) { if (r.whenMs < minWhen) minWhen = r.whenMs; if (r.whenMs > maxWhen) maxWhen = r.whenMs; }
            const g = r.missionGroup === '' ? '(none)' : r.missionGroup;
            if (!groups[g]) groups[g] = { group: g, names: new Set(), count: 0, totalMs: 0, durs: [], lastMs: 0 };
            const gg = groups[g];
            gg.count++; gg.totalMs += r.durationMs || 0;
            if (r.durationMs) gg.durs.push(r.durationMs);
            if (r.name) gg.names.add(r.name);
            if (r.whenMs && r.whenMs > gg.lastMs) gg.lastMs = r.whenMs;
        });
        const groupArr = Object.values(groups).sort((a, b) => b.lastMs - a.lastMs);
        const avgMs = rows.length ? totalMs / rows.length : 0;
        const gaps = groupArr.filter(g => g.lastMs && daysSince(g.lastMs) > gapDays);
        const outliers = rows.filter(r => r._aborted || (r.durationS != null && r.durationS > 0 && r.durationS < 60))
            .sort((a, b) => (b.whenMs || 0) - (a.whenMs || 0));

        const statCard = (label, val) => `<div style="background:#151a20;border:1px solid #2a2a2a;border-radius:6px;padding:8px 12px;min-width:120px;"><div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(label)}</div><div style="color:#14d2dc;font-size:16px;font-weight:700;">${escapeHtml(val)}</div></div>`;
        const min = (arr) => arr.length ? Math.min(...arr) : 0;
        const max = (arr) => arr.length ? Math.max(...arr) : 0;

        const html = `
            <div class="aim-mb-toolbar">
                <button class="aim-mb-tbtn" data-back>← Back</button>
                <span style="font-weight:700;color:#14d2dc;">📊 Mission Log Stats</span>
                <span style="margin-left:auto;color:#888;font-size:11px;">Gap threshold:</span>
                <input type="number" min="1" data-gap-days value="${gapDays}" style="width:54px;background:#0f1216;border:1px solid #444;color:#e6e6e6;padding:2px 4px;font-size:12px;border-radius:3px;" /> <span style="color:#888;font-size:11px;">days</span>
            </div>
            <div class="aim-mb-table-wrap" style="padding:12px 14px;">
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
                    ${statCard('Missions', String(rows.length))}
                    ${statCard('Groups', String(groupArr.length))}
                    ${statCard('Total flight time', fmtDurationMs(totalMs))}
                    ${statCard('Avg duration', fmtDurationMs(avgMs))}
                    ${statCard('Date range', (minWhen === Infinity ? '—' : `${fmtWhenCT(minWhen).split(' - ')[0]} → ${fmtWhenCT(maxWhen).split(' - ')[0]}`))}
                    ${statCard('Aborted/short', String(outliers.length))}
                </div>

                <div style="color:#14d2dc;font-weight:700;font-size:12px;margin:6px 0;">Per-group rollup</div>
                <table style="margin-bottom:16px;">
                    <thead><tr>
                        <th>Group</th><th>Runs</th><th>Total</th><th>Avg</th><th>Min</th><th>Max</th><th>Last run (CT)</th><th>Days ago</th>
                    </tr></thead>
                    <tbody>
                        ${groupArr.map(g => {
                            const d = daysSince(g.lastMs);
                            const stale = d != null && d > gapDays;
                            return `<tr${stale ? ' style="background:rgba(255,82,82,0.12);"' : ''}>
                                <td title="${escapeHtml(Array.from(g.names).join(', '))}">${escapeHtml(String(g.group))}</td>
                                <td>${g.count}</td>
                                <td>${fmtDurationMs(g.totalMs)}</td>
                                <td>${fmtDurationMs(g.durs.length ? g.totalMs / g.count : 0)}</td>
                                <td>${fmtDurationMs(min(g.durs))}</td>
                                <td>${fmtDurationMs(max(g.durs))}</td>
                                <td>${g.lastMs ? escapeHtml(fmtWhenCT(g.lastMs)) : '—'}</td>
                                <td${stale ? ' style="color:#ff5252;font-weight:700;"' : ''}>${d == null ? '—' : d}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>

                <div style="color:#ff8c42;font-weight:700;font-size:12px;margin:6px 0;">Coverage gaps (last run &gt; ${gapDays} days ago) — ${gaps.length}</div>
                ${gaps.length ? `<table style="margin-bottom:16px;"><thead><tr><th>Group</th><th>Last run (CT)</th><th>Days ago</th></tr></thead><tbody>
                    ${gaps.map(g => `<tr><td>${escapeHtml(String(g.group))}</td><td>${escapeHtml(fmtWhenCT(g.lastMs))}</td><td style="color:#ff5252;font-weight:700;">${daysSince(g.lastMs)}</td></tr>`).join('')}
                </tbody></table>` : `<div style="color:#5fff5f;font-size:11px;margin-bottom:16px;">✓ No groups exceed the gap threshold.</div>`}

                <div style="color:#ff8c42;font-weight:700;font-size:12px;margin:6px 0;">Duration outliers (aborted / &lt; 60s) — ${outliers.length}</div>
                ${outliers.length ? `<table><thead><tr><th>Mission</th><th>Time (CT)</th><th>Duration</th><th>Reason</th></tr></thead><tbody>
                    ${outliers.map(r => `<tr data-go="${r.id}" style="cursor:pointer;"><td>${escapeHtml(r.name)} · #${r.id}</td><td>${escapeHtml(fmtWhenCT(r.whenMs))}</td><td>${fmtDurationMs(r.durationMs)}</td><td>${r._aborted ? '⚠ aborted (0:00 / landing failed)' : 'short run'}</td></tr>`).join('')}
                </tbody></table>` : `<div style="color:#5fff5f;font-size:11px;">✓ No aborted or abnormally short missions.</div>`}
            </div>
        `;
        setBodyHtml(html);
        const back = panelEl.querySelector('[data-back]');
        if (back) back.onclick = () => renderTableView();
        const gapInput = panelEl.querySelector('[data-gap-days]');
        if (gapInput) gapInput.onchange = () => {
            const v = Math.max(1, Number(gapInput.value) || DEFAULT_GAP_DAYS);
            gmSet(CACHE_KEY_GAP_DAYS, v);
            renderLogStats();
        };
        panelEl.querySelectorAll('tr[data-go]').forEach(tr => {
            tr.onclick = () => renderLogDetail(Number(tr.dataset.go));
        });
    }

    // Floating launcher on the Mission Log page (the log page has no
    // Mission-Bank-style header to host an inline button, so we use a
    // fixed pill bottom-right). Re-placeable inline later if desired.
    function injectLogSumButton(doc) {
        if (!masterEnabled) return;
        if (!isOnMissionLog()) return;
        if (doc.getElementById(LOG_SUM_BTN_ID)) return;
        const btn = doc.createElement('button');
        btn.id = LOG_SUM_BTN_ID;
        btn.type = 'button';
        btn.textContent = '📋 LOG SUM';
        btn.title = 'Open Mission Log summary (AIM Mission Bank Tools)';
        Object.assign(btn.style, {
            position: 'fixed', bottom: '18px', right: '18px', zIndex: '99998',
            background: '#14d2dc', color: '#000', border: 'none', borderRadius: '6px',
            padding: '8px 14px', fontSize: '12px', fontWeight: '700', cursor: 'pointer',
            fontFamily: "'Lato','Segoe UI',sans-serif", boxShadow: '0 3px 12px rgba(0,0,0,0.5)'
        });
        btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openPanel('log'); };
        (doc.body || doc.documentElement).appendChild(btn);
    }

    // ========================================================
    // SUM button injection (Mission Bank toolbar)
    // ========================================================
    // The Mission Bank header in Percepto is `.missions-list__header`,
    // and the "New mission" button inside it is `.missions-list__new-button`.
    // We inject our SUM button as a sibling so it inherits the same
    // Ant Design styling for visual consistency.
    const TOOLBAR_ROW_ID = 'aim-mb-toolbar-row';

    function injectSumButton(doc) {
        if (!masterEnabled) return;
        if (!isOnMissionBank()) return;
        const header = doc.querySelector('.missions-list__header');
        // Wait for React to mount the real header. Previously we dropped
        // a floating fallback here and never replaced it.
        if (!header) return;
        // Find or build the toolbar row that lives directly under the
        // Percepto header. SUM and future MBT buttons all go in here so
        // they aren't crowded against the title + New Mission button.
        let row = doc.getElementById(TOOLBAR_ROW_ID);
        if (row && !header.parentNode.contains(row)) {
            // React rebuilt the header — drop the orphan row, recreate.
            row.remove();
            row = null;
        }
        if (!row) {
            row = doc.createElement('div');
            row.id = TOOLBAR_ROW_ID;
            Object.assign(row.style, {
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '0 16px 8px 16px',
                // Sit flush against the header; transparent so it
                // inherits whatever background Percepto uses.
                background: 'transparent',
            });
            header.parentNode.insertBefore(row, header.nextSibling);
        }
        const existing = doc.getElementById(SUM_BTN_ID);
        if (existing && row.contains(existing)) return; // already placed
        if (existing) existing.remove();
        injectButtonIntoRow(doc, row, header);
    }

    // Neon-green SUM button styling — matches the Site Setup SUM button
    // (Asset Inspector) so the two SUM launchers look/feel identical.
    // Injected into the button's own document (the iframe) so it's green
    // immediately, independent of whether the panel has ever opened.
    function ensureSumButtonStyles(doc) {
        if (doc.getElementById('aim-mb-sum-btn-styles')) return;
        const st = doc.createElement('style');
        st.id = 'aim-mb-sum-btn-styles';
        st.textContent = `
            @keyframes aim-mb-sum-pulse-glow {
                0%, 100% { box-shadow: 0 0 4px rgba(57,255,20,0.45), 0 0 9px rgba(57,255,20,0.22); }
                50%      { box-shadow: 0 0 11px rgba(57,255,20,0.90), 0 0 22px rgba(57,255,20,0.48); }
            }
            #${SUM_BTN_ID}.aim-mb-sum-neon-btn {
                animation: aim-mb-sum-pulse-glow 1.8s ease-in-out infinite;
                background: #39ff14 !important;
                border-color: #39ff14 !important;
                text-shadow: none !important;
            }
            #${SUM_BTN_ID}.aim-mb-sum-neon-btn,
            #${SUM_BTN_ID}.aim-mb-sum-neon-btn * {
                color: #000 !important;
                -webkit-text-fill-color: #000 !important;
            }
            #${SUM_BTN_ID}.aim-mb-sum-neon-btn:hover,
            #${SUM_BTN_ID}.aim-mb-sum-neon-btn:focus {
                background: #5cff43 !important;
                border-color: #5cff43 !important;
            }
            @media (prefers-reduced-motion: reduce) {
                #${SUM_BTN_ID}.aim-mb-sum-neon-btn { animation: none; }
            }`;
        (doc.head || doc.documentElement).appendChild(st);
    }

    function injectButtonIntoRow(doc, row, header) {
        ensureSumButtonStyles(doc);
        // Reuse the className from the existing "New mission" button so
        // SUM picks up Percepto's Ant theme (size, color, hover state).
        const newBtn = header.querySelector('.missions-list__new-button');
        const btn = doc.createElement('button');
        btn.id = SUM_BTN_ID;
        btn.type = 'button';
        // Keep Ant's base shape class for sizing/radius, add our neon class
        // for the pulsing glow. Built the SAME way as the Site Setup SUM
        // button so the two launchers are identical.
        btn.className = (newBtn ? newBtn.className : 'ant-btn ant-btn-primary') + ' aim-mb-sum-neon-btn';
        Object.assign(btn.style, {
            minWidth: 'unset', padding: '0 16px', height: '26px',
            fontSize: '11px', fontWeight: '800', letterSpacing: '0.02em',
            borderRadius: '4px', textShadow: 'none',
        });
        // Inline !important is the strongest author declaration — it beats
        // even Percepto's stylesheet !important. Their white
        // -webkit-text-fill-color kept winning over a CSS-rule override, so
        // set the color-critical props inline with explicit priority.
        const forceStyle = (prop, val) => { try { btn.style.setProperty(prop, val, 'important'); } catch (e) {} };
        forceStyle('background', '#39ff14');
        forceStyle('border', '1px solid #39ff14');
        forceStyle('color', '#000');
        forceStyle('-webkit-text-fill-color', '#000');
        btn.innerHTML = 'Mission Bank Summary';
        btn.title = 'Open Mission Bank Summary (AIM Mission Bank Tools)';
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPanel();
        };
        row.appendChild(btn);
    }

    function runSumInjection() {
        if (!masterEnabled) return;
        // IFRAME-only. Script is @match'd into both contexts; TOP has no
        // Mission Bank UI, so any TOP injection only produces a stray
        // floating button at the top-right of the viewport.
        if (CONTEXT !== 'IFRAME') return;
        try { injectSumButton(document); } catch (e) {}
        try { injectLogSumButton(document); } catch (e) {}
        try { applyMapIconDeclutter(document); } catch (e) {}
        try { applyNativeEditorCollapse(); } catch (e) {}
        try { injectEditorCollapseButton(); } catch (e) {}
        try { injectComposerButton(); } catch (e) {}
        try { compactTopArea(); } catch (e) {}
        try { composerEnsureMapModeIfNeeded(); } catch (e) {}
        try { genEnsureButton(); } catch (e) {}
    }

    // A collapse/expand toggle button in Percepto's native mission-edit
    // sidebar (next to "Add instruction"), so the user can flip scan-block
    // collapse without opening the Control Panel.
    const EDITOR_COLLAPSE_BTN_ID = 'aim-mb-editor-collapse-btn';
    function updateEditorCollapseBtn() {
        const btn = document.getElementById(EDITOR_COLLAPSE_BTN_ID);
        if (!btn) return;
        btn.textContent = collapseEditorCards ? '⊟' : '⊞';
        btn.title = collapseEditorCards ? 'Compact view: ON — click to expand the steps' : 'Compact view: OFF — click to compact the steps';
        btn.style.opacity = collapseEditorCards ? '1' : '0.7';
    }
    // The Compact-view toggle now lives inside injectComposerButton's combined
    // row (kept here as a no-op so existing callers don't need touching).
    function injectEditorCollapseButton() { /* merged into the composer button row */ }

    // Reclaim vertical space at the top of the native editor: shrink the
    // ant-divider gap (CSS) and compact Percepto's tall "Add instruction"
    // button (inline !important, re-applied if React recreates it).
    function compactTopArea() {
        if (CONTEXT !== 'IFRAME') return;
        const content = document.querySelector('.mission-edit__content');
        if (!content) return;
        if (!document.getElementById('aim-mb-top-css')) {
            const st = document.createElement('style');
            st.id = 'aim-mb-top-css';
            st.textContent = `
                .mission-edit__content { padding-top:2px !important; }
                .mission-edit__stats { margin:0 !important; padding:2px 0 !important; }
                .mission-edit__content .ant-divider { margin:4px 0 !important; }
            `;
            (document.head || document.documentElement).appendChild(st);
        }
        const addBtn = Array.from(content.querySelectorAll('button')).find(b => /add instruction/i.test(b.textContent || ''));
        if (addBtn && addBtn.dataset.aimCompacted !== '1') {
            addBtn.style.setProperty('padding-top', '7px', 'important');
            addBtn.style.setProperty('padding-bottom', '7px', 'important');
            addBtn.style.setProperty('margin', '2px 0', 'important');
            addBtn.style.setProperty('min-height', '0', 'important');
            addBtn.dataset.aimCompacted = '1';
        }
    }

    // ============================================================
    // MISSION COMPOSER — Increment 1 (read-only grouped view + multi-select)
    // ------------------------------------------------------------
    // Identifies the mission open in Percepto's native editor by matching the
    // on-screen instruction-card ids (data-rfd-draggable-id === instruction id)
    // to the cached /available_app/ mission — no fiber, no name guessing — then
    // groups its steps into INSPECTION BLOCKS (Navigate-group → Snapshot-block,
    // a snapshot + its trailing Thermal/GEM/Wait steps) in a docked panel.
    // Block reorder / bulk param edit / GPS-pick build on this next.
    // ============================================================
    const COMPOSER_BTN_ID = 'aim-mb-composer-btn';
    const COMPOSER_ROW_ID = 'aim-mb-composer-row';
    let composerMission = null;    // the matched mission (id→data source; order read from DOM)
    let composerBusy = false;      // guard against concurrent reorders
    let composerEditingStepId = null; // id of the step whose editor we last opened (reliable "current step" for marker-switch)
    // Map order badges: restyle Percepto's OWN navigate/snapshot markers IN
    // PLACE — recolor (nav=blue / snap=pink) + stamp the N#/S# number on each,
    // same spot+size. Left-click (M1) stays native (opens the step); right-click
    // (M2) opens our order editor. Always on; no toggle button.
    let composerMapMode = true;
    let composerMapEventsBound = false;
    let loggedNoMarkers = false;

    // ONE compact button row (Compact-view toggle + a small 🔄 Resync), side by
    // side, inserted right under "Add instruction" — keeps the top of the
    // sidebar tight so more steps show.
    function injectComposerButton() {
        if (CONTEXT !== 'IFRAME') return;
        const content = document.querySelector('.mission-edit__content');
        if (!content) return;
        if (document.getElementById(COMPOSER_ROW_ID)) { updateEditorCollapseBtn(); return; }
        const row = document.createElement('div');
        row.id = COMPOSER_ROW_ID;
        // Equal-width grid so the 4 utility buttons align in one tidy row.
        row.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:2px 0 4px;';
        const compact = document.createElement('button');
        compact.id = EDITOR_COLLAPSE_BTN_ID;
        compact.type = 'button';
        compact.style.cssText = 'flex:0 0 auto;padding:5px 8px;background:transparent;border:1px solid rgba(20,210,220,0.5);' +
            'color:#14d2dc;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;';
        compact.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            collapseEditorCards = !collapseEditorCards;
            gmSet(CACHE_KEY_COLLAPSE_EDITOR, collapseEditorCards);
            try { applyNativeEditorCollapse(); } catch (er) {}
            updateEditorCollapseBtn();
        };
        const refresh = document.createElement('button');
        refresh.id = COMPOSER_BTN_ID;
        refresh.type = 'button';
        refresh.textContent = '🔄';
        refresh.title = 'Resync map order — re-fetch this mission + re-number the badges (right-click a badge to reorder)';
        refresh.style.cssText = 'flex:0 0 auto;padding:5px 8px;background:rgba(95,255,95,0.12);border:1px solid rgba(95,255,95,0.5);' +
            'color:#5fff5f;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;';
        refresh.onclick = (e) => { e.preventDefault(); e.stopPropagation(); composerRefresh(); };
        const kml = document.createElement('button');
        kml.type = 'button';
        kml.textContent = '⬇ KML';
        kml.title = 'Export this mission to a Google-Earth KML — flight path + N#/S# pins, each pin showing its step details';
        kml.style.cssText = 'flex:0 0 auto;padding:5px 8px;background:rgba(150,180,255,0.12);border:1px solid rgba(150,180,255,0.5);' +
            'color:#9cf;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;';
        kml.onclick = (e) => { e.preventDefault(); e.stopPropagation(); exportOpenMissionKml(); };
        const aglv = document.createElement('button');
        aglv.id = AGL_VIEW_BTN_ID;
        aglv.type = 'button';
        aglv.style.cssText = 'flex:0 0 auto;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;';
        aglv.onclick = (e) => { e.preventDefault(); e.stopPropagation(); setAglView(!showAglInEditor); };
        row.appendChild(compact); row.appendChild(refresh); row.appendChild(kml); row.appendChild(aglv);
        // Second row: the safety-gated Auto snapshot-AGL toggle (full width so
        // it's hard to miss). Default OFF; turning it ON warns + shows a banner.
        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;margin:0 0 4px;';
        const autoBtn = document.createElement('button');
        autoBtn.id = AUTO_SNAP_AGL_BTN_ID;
        autoBtn.type = 'button';
        autoBtn.style.cssText = 'flex:1;padding:5px 8px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;';
        autoBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); setAutoSnapAgl(!autoSnapAglEnabled); };
        const stageBtn = document.createElement('button');
        stageBtn.type = 'button';
        stageBtn.textContent = '➕ Stage';
        stageBtn.title = 'Add N Navigates + M Snapshots to this mission, staged near the existing ones — then drag them into place (snapshots auto-set elevation if Auto-AGL is on; navigates use FFZ-min).';
        stageBtn.style.cssText = 'flex:0 0 auto;margin-left:5px;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;' +
            'background:rgba(150,180,255,0.12);border:1px solid rgba(150,180,255,0.5);color:#9cf;';
        stageBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); genStagePopup(stageBtn); };
        row2.appendChild(autoBtn); row2.appendChild(stageBtn);
        const addBtn = Array.from(content.querySelectorAll('button')).find(b => /add instruction/i.test(b.textContent || ''));
        if (addBtn && addBtn.parentNode) { addBtn.parentNode.insertBefore(row, addBtn.nextSibling); row.parentNode.insertBefore(row2, row.nextSibling); }
        else { content.insertBefore(row, content.firstChild); content.insertBefore(row2, row.nextSibling); }
        updateEditorCollapseBtn();
        updateAutoSnapAglUI();
        updateAglViewBtn();
        composerEnsureMapMode(true);
    }

    // ── Editor altitude view: AGL vs MSL toggle ──────────────────────────────
    const AGL_VIEW_BTN_ID = 'aim-mb-aglview-btn';
    function setAglView(on) {
        showAglInEditor = !!on;
        gmSet(CACHE_KEY_AGL_VIEW, showAglInEditor);
        updateAglViewBtn();
        try { applyNativeEditorCollapse(); } catch (e) {} // re-render cards in the new unit
    }
    function updateAglViewBtn() {
        const btn = document.getElementById(AGL_VIEW_BTN_ID);
        if (!btn) return;
        btn.textContent = showAglInEditor ? 'AGL' : 'MSL';
        btn.title = showAglInEditor
            ? 'Showing AGL (height above ground) on each step. Click to switch to MSL (stored altitude).'
            : 'Showing MSL (stored altitude) on each step. Click to switch to AGL (height above ground).';
        btn.style.background = showAglInEditor ? 'rgba(95,255,95,0.14)' : 'rgba(150,180,255,0.12)';
        btn.style.border = showAglInEditor ? '1px solid rgba(95,255,95,0.5)' : '1px solid rgba(150,180,255,0.5)';
        btn.style.color = showAglInEditor ? '#7dff7d' : '#9cf';
    }

    // ── Snapshot auto-AGL: toggle button + on-map banner ─────────────────────
    const AUTO_SNAP_AGL_BTN_ID = 'aim-mb-auto-snapagl-btn';
    const AUTO_SNAP_AGL_BANNER_ID = 'aim-mb-auto-snapagl-banner';
    function setAutoSnapAgl(on) {
        autoSnapAglEnabled = !!on;
        // Re-baseline live tracking so arming only acts on snapshots you move
        // AFTER turning it on (existing/flare snapshots are left until moved).
        Object.keys(liveSnapLastLoc).forEach(k => delete liveSnapLastLoc[k]);
        updateAutoSnapAglUI();
        if (autoSnapAglEnabled) {
            showToast(`⚠ Snapshot auto-AGL is ON — every save sets ALL snapshots to ground + ${defaultSnapAglFt} ft. Turn OFF for flares/elevated targets.`, '#ff7a00', 6000);
        } else {
            showToast('Snapshot auto-AGL is OFF — saves won\'t change snapshot altitudes.', '#888', 3000);
        }
    }
    function updateAutoSnapAglUI() {
        const btn = document.getElementById(AUTO_SNAP_AGL_BTN_ID);
        if (btn) {
            if (autoSnapAglEnabled) {
                btn.textContent = `📷 Auto-AGL: ON · ground+${defaultSnapAglFt}ft`;
                btn.style.background = 'rgba(255,122,0,0.22)';
                btn.style.border = '1px solid #ff7a00';
                btn.style.color = '#ff9d3a';
                btn.title = 'ON: every save sets ALL snapshots to their DEM ground + the default AGL. Click to turn OFF.';
            } else {
                btn.textContent = `📷 Auto-AGL: OFF`;
                btn.style.background = 'transparent';
                btn.style.border = '1px solid rgba(255,122,0,0.45)';
                btn.style.color = '#c98a4a';
                btn.title = `OFF: snapshot altitudes are untouched on save. Click to turn ON (then every save re-floats ALL snapshots to ground + ${defaultSnapAglFt} ft).`;
            }
        }
        updateAutoSnapAglBanner();
    }
    // Bright, persistent on-map banner so it's obvious auto-AGL is armed.
    function updateAutoSnapAglBanner() {
        if (CONTEXT !== 'IFRAME') return;
        let banner = document.getElementById(AUTO_SNAP_AGL_BANNER_ID);
        const mapC = document.querySelector('.mission-bank__map-container') || document.querySelector('.pr-map-container');
        if (!autoSnapAglEnabled || !mapC) { if (banner) banner.remove(); return; }
        if (!banner) {
            banner = document.createElement('div');
            banner.id = AUTO_SNAP_AGL_BANNER_ID;
            banner.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:1200;' +
                'background:rgba(255,122,0,0.92);color:#1a1000;font:700 12px/1.3 "Lato",sans-serif;' +
                'padding:5px 12px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.5);pointer-events:none;white-space:nowrap;';
            if (getComputedStyle(mapC).position === 'static') mapC.style.position = 'relative';
            mapC.appendChild(banner);
        }
        banner.textContent = `⚠ SNAPSHOT AUTO-AGL ON — saves set all snapshots to ground + ${defaultSnapAglFt} ft`;
    }

    function composerBindMapEvents() {
        if (composerMapEventsBound) return;
        const map = getLeafletMap();
        if (!map || typeof map.on !== 'function') return;
        map.on('zoomend moveend layeradd', () => { try { composerStyleNativeMarkers(); } catch (e) {} });
        composerMapEventsBound = true;
    }

    // Recolor + number Percepto's native nav/snap markers in place.
    function composerStyleNativeMarkers() {
        if (!composerMapMode || CONTEXT !== 'IFRAME' || !composerMission) return;
        const map = getLeafletMap();
        if (!map || typeof map.eachLayer !== 'function') return;
        composerBindMapEvents();
        installComposerMarkerEvents();
        composerEnsureBadgeCSS();
        // Number from the LIVE editor instruction order when available — it includes
        // un-saved, natively-added navs/snaps in their real position (the cached
        // composerMission doesn't, and 🔄 refresh re-pulls the server which also
        // lacks them, so a new nav stayed blank until save). Fall back to the cache.
        let ordered = null;
        try { const lctx = findMissionEditorCtx(); if (lctx && Array.isArray(lctx.instrs) && lctx.instrs.length) ordered = lctx.instrs; } catch (e) {}
        if (!ordered) {
            const byId = {}; (composerMission.instructions || []).forEach(x => { byId[String(x.id)] = x; });
            ordered = composerDomIds().map(id => byId[id]).filter(Boolean);
        }
        const K = (lat, lng) => `${(+lat).toFixed(6)},${(+lng).toFixed(6)}`;
        const lookup = {}; let navN = 0, snapN = 0;
        ordered.forEach(s => {
            if (!s || !s.location || s.location.lat == null) return;
            if (s.type_name === 'navigate') { navN++; lookup[K(s.location.lat, s.location.lng)] = { num: navN, kind: 'nav', id: String(s.id) }; }
            else if (s.type_name === 'snapshot') { snapN++; lookup[K(s.location.lat, s.location.lng)] = { num: snapN, kind: 'snap', id: String(s.id) }; }
        });
        let matched = 0, seen = 0;
        map.eachLayer(layer => {
            const el = layer && layer._icon;
            if (!el || !el.classList || !el.classList.contains('instruction-marker')) return;
            seen++;
            const ll = layer._latlng;
            if (!ll) return;
            const info = lookup[K(ll.lat, ll.lng)];
            if (!info) return;
            matched++;
            composerStyleOneMarker(el, info, [ll.lat, ll.lng]);
        });
        if (!matched && seen && !loggedNoMarkers) {
            loggedNoMarkers = true;
            console.warn(`${TAG} [map-badges] saw ${seen} instruction-markers but matched 0 by lat/lng — Leaflet layer model differs; tell me and I'll switch to pixel matching.`);
        }
    }
    // Persistent CSS: color nav (blue) / snap (pink) markers + hide their
    // original icon by IMG SRC, so a Percepto re-render (during a reorder)
    // re-applies the colored circle INSTANTLY — no flash of the original icon.
    // (The number is JS-injected and may blink for a frame; the circle won't.)
    // Keying off the img keeps :has matching even though we keep the img around.
    function composerEnsureBadgeCSS(rebuild) {
        let st = document.getElementById('aim-mb-badge-css');
        if (st && !rebuild) return;
        if (!st) {
            st = document.createElement('style');
            st.id = 'aim-mb-badge-css';
            (document.head || document.documentElement).appendChild(st);
        }
        const navC = stepColor('nav'), snapC = stepColor('snap');
        st.textContent = `
            .instruction-marker:has(img[src*="navigate-"]) .instruction-marker__icon { background:${navC} !important; border:1.5px solid #fff !important; border-radius:50% !important; position:relative; }
            .instruction-marker:has(img[src*="snapshot-"]) .instruction-marker__icon { background:${snapC} !important; border:1.5px solid #fff !important; border-radius:50% !important; position:relative; }
            .instruction-marker:has(img[src*="navigate-"]) .instruction-marker__icon img,
            .instruction-marker:has(img[src*="snapshot-"]) .instruction-marker__icon img { opacity:0 !important; }
            /* Number as ::after on the MARKER el (survives hover — Percepto only
               re-renders the inner icon's contents on hover, wiping a child span). */
            .instruction-marker[data-aim-num]::after { content: attr(data-aim-num); position:absolute; inset:0;
                display:flex; align-items:center; justify-content:center; color:#fff; -webkit-text-fill-color:#fff;
                font:800 11px/1 'Lato',sans-serif; pointer-events:none; z-index:2; }
        `;
    }
    function composerStyleOneMarker(el, info, ll) {
        const label = (info.kind === 'nav' ? 'N' : 'S') + info.num;
        el.setAttribute('data-aim-id', info.id);
        el.setAttribute('data-aim-kind', info.kind);
        el.__aimLL = ll;
        // Color + icon-hide is CSS (:has). Number is a CSS ::after from this
        // attr on the MARKER el — survives Percepto's hover re-render of the
        // inner icon. Click/right-click handled by the window-capture listeners.
        if (el.getAttribute('data-aim-num') !== label) el.setAttribute('data-aim-num', label);
    }

    // ONE window-capture listener pair for all styled markers:
    //  • right-click (M2) on a badge → our order editor, and stopImmediate so the
    //    Asset Inspector's window-bubble contextmenu doesn't also fire.
    //  • left-click (M1) on a badge → open that step's edit form (Percepto's
    //    native click only scrolls to it; we additionally trigger ⋮ → Edit).
    let composerMarkerEventsInstalled = false;
    function installComposerMarkerEvents() {
        if (composerMarkerEventsInstalled) return;
        composerMarkerEventsInstalled = true;
        const badge = (e) => (e.target && e.target.closest) ? e.target.closest('.instruction-marker[data-aim-id]') : null;
        window.addEventListener('contextmenu', (e) => {
            const m = badge(e); if (!m) return;
            e.preventDefault(); e.stopImmediatePropagation();
            const id = m.getAttribute('data-aim-id'), kind = m.getAttribute('data-aim-kind');
            // Number lives on the marker el as data-aim-num (e.g. "N3"/"S5") —
            // the v0.99 hover fix moved it here from the inner icon's old
            // data-aim-label, so read it from `m`, not a child.
            const lbl = m.getAttribute('data-aim-num') || '';
            const n = parseInt(lbl.replace(/[^0-9]/g, ''), 10) || 1;
            composerEditOrder(kind, id, n, m.__aimLL);
        }, true);
        // Left-click (M1) on a marker:
        //  • No step editor open → native scroll + open that step's editor (as before).
        //  • A DIFFERENT step's editor IS open → this is a STEP SWITCH. Block Percepto's
        //    native "move the open step to this point" (the cause of a snapshot sliding
        //    to the wrong spot), SAVE the current step (Shift+S), then open the clicked
        //    step. We block at pointerdown/mousedown too (left-button only) so Leaflet
        //    never even starts the move.
        //  • The marker of the step you're ALREADY editing → fully native (drag/reposition).
        const switchTargetFor = (e) => {
            const m = badge(e); if (!m) return null;
            if (!document.querySelector('[data-testid="btn-save-instruction"]')) return null; // no editor open
            const id = m.getAttribute('data-aim-id');
            const curId = getOpenStepId();
            // ONLY the step you're currently editing is native (drag/reposition).
            // Every OTHER marker is a switch (save current + open it).
            if (curId != null && String(curId) === String(id)) return null;
            return id;
        };
        const blockSwitchDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;  // left button only (keep M2 reorder)
            if (switchTargetFor(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
        };
        window.addEventListener('pointerdown', blockSwitchDown, true);
        window.addEventListener('mousedown', blockSwitchDown, true);
        window.addEventListener('click', (e) => {
            const m = badge(e); if (!m) return;
            const id = m.getAttribute('data-aim-id');
            const editorOpen = !!document.querySelector('[data-testid="btn-save-instruction"]');
            if (editorOpen) {
                const switchId = switchTargetFor(e);
                if (switchId) {
                    // DIFFERENT step → suppress the native move, save current + open it.
                    e.preventDefault(); e.stopImmediatePropagation();
                    composerEditingStepId = String(switchId); // we're now editing this one
                    try { openInstructionEditor(switchId, currentMissionIdFromHash()); }
                    catch (err) { console.warn(`${TAG} [switch] open failed`, err); showToast('Could not switch steps — see console.', '#ff9800', 3500); }
                }
                // SAME step you're editing (or can't tell): do NOTHING — leave M1
                // fully native so you can drag the marker without re-opening it.
                return;
            }
            // No editor open → open the clicked step's editor.
            setTimeout(() => composerOpenStepEdit(id), 320);
        }, true);
    }
    function composerOpenStepEdit(id) {
        const draggable = document.querySelector(`[data-rfd-draggable-id="${id}"]`);
        if (!draggable) { showToast('Could not find that step to edit.', '#ff9800', 3000); return; }
        composerEditingStepId = String(id); // remember which step we opened
        try {
            const ok = triggerInstructionAction(draggable, 'edit');
            if (!ok) forceOpenInstructionEdit(draggable);
        } catch (e) { try { forceOpenInstructionEdit(draggable); } catch (e2) { console.warn(`${TAG} [composer] open edit failed`, e2); } }
    }

    function composerEnsureMapMode(silent) {
        identifyOpenMission((data) => {
            if (!data) { if (!silent) showToast('Map badges: could not match the open mission to the cache.', '#ff9800', 4000); return; }
            composerMission = data.mission;
            composerStyleNativeMarkers();
        });
    }
    // Interval-driven: load the mission if missing/stale, else re-style markers
    // (idempotent — per-marker early-return when the label is unchanged).
    function composerEnsureMapModeIfNeeded() {
        if (!composerMapMode || CONTEXT !== 'IFRAME') return;
        if (!document.querySelector('.mission-edit__content')) return;
        const domIds = composerDomIds();
        if (!domIds.length) return;
        const covered = composerMission && domIds.slice(0, 3).every(d => (composerMission.instructions || []).some(x => String(x.id) === d));
        if (!composerMission || !covered) { composerEnsureMapMode(true); return; }
        try { composerStyleNativeMarkers(); } catch (e) {}
    }
    // ── Live mission-editor bridge ───────────────────────────────────────────
    // Read/write Percepto's LIVE in-editor instruction state via React fiber —
    // the same context MBT's reorder uses. `updateInstruction(fullObj)` replaces
    // by id (confirmed: `R[M]=N; n({...t,instructions:R})`). The fn and the
    // instructions array can sit on DIFFERENT context objects, so find each
    // independently; re-walk FRESH each call (per-render closures). Also probe
    // fiber.alternate to dodge React's double-buffered fibers.
    function mbGetFiber(el) {
        const k = el && Object.keys(el).find(kk => kk.startsWith('__reactFiber') || kk.startsWith('__reactInternalInstance'));
        return k ? el[k] : null;
    }
    function findMissionEditorCtx() {
        const card = document.querySelector('[data-rfd-draggable-id]');
        if (!card) return null;
        const f0 = mbGetFiber(card);
        let upd = null, instrs = null;
        for (const start of [f0, f0 && f0.alternate]) {
            let node = start, depth = 0;
            while (node && depth < 140) {
                let v; try { v = node.memoizedProps && node.memoizedProps.value; } catch (e) { v = null; }
                if (v && typeof v === 'object') {
                    if (!upd && typeof v.updateInstruction === 'function') upd = v.updateInstruction;
                    if (!instrs && Array.isArray(v.instructions) && v.instructions[0] &&
                        (v.instructions[0].type_name !== undefined || v.instructions[0].value1 !== undefined)) instrs = v.instructions;
                }
                node = node.return; depth++;
            }
            if (upd && instrs) break;
        }
        return (upd && instrs) ? { upd, instrs } : null;
    }

    // Per-snapshot last-handled position (so we act on MOVES, not every tick).
    const liveSnapLastLoc = {};
    let composerLastNSCount = -1; // live nav+snap count — change ⇒ native add/remove ⇒ restyle
    const genElevReqAt = {}; // throttle DEM prefetch per marker position (anti-429)
    let liveEditorTimer = null;
    function startLiveEditorSync() {
        if (liveEditorTimer || CONTEXT !== 'IFRAME') return;
        liveEditorTimer = setInterval(() => { try { liveEditorTick(); } catch (e) {} }, 700);
    }
    function liveEditorTick() {
        if (CONTEXT !== 'IFRAME' || !document.querySelector('.mission-edit__content')) return;
        const ctx = findMissionEditorCtx();
        if (!ctx) return;
        // (1) Keep MBT's cached mission in sync with the LIVE editor state, so the
        //     compact card + map badges reflect native step-edits / drags before a
        //     mission save (fixes "sidebar shows the old altitude"). Also re-syncs
        //     locations so the lat/lng badge match stops failing after a drag.
        let changed = false;
        if (composerMission && Array.isArray(composerMission.instructions)) {
            const byId = {}; ctx.instrs.forEach(s => { if (s && s.id != null) byId[String(s.id)] = s; });
            const cmIds = {}; composerMission.instructions.forEach(ci => { cmIds[String(ci.id)] = true; });
            composerMission.instructions.forEach(ci => {
                const live = byId[String(ci.id)]; if (!live) return;
                if (typeof live.value1 === 'number' && ci.value1 !== live.value1) { ci.value1 = live.value1; changed = true; }
                if (live.location && ci.location && (ci.location.lat !== live.location.lat || ci.location.lng !== live.location.lng)) { ci.location = { lat: live.location.lat, lng: live.location.lng }; changed = true; }
            });
            // ADD instructions present live but not in the cache (e.g. ➕ Stage
            // steps with client-only ids) so the compact view + N#/S# badges
            // recognize them before a save.
            ctx.instrs.forEach(live => {
                if (live && live.id != null && !cmIds[String(live.id)]) { composerMission.instructions.push(Object.assign({}, live)); changed = true; }
            });
        }
        // Native add/remove of a nav/snap (e.g. "Add Instruction → Navigate") shows
        // up as a live nav+snap COUNT change — force a restyle so the new marker gets
        // its N#/S# number immediately (numbering reads the live order now).
        const liveNS = ctx.instrs.filter(s => s && (s.type_name === 'navigate' || s.type_name === 'snapshot')).length;
        if (liveNS !== composerLastNSCount) { composerLastNSCount = liveNS; changed = true; }
        if (changed) { try { applyNativeEditorCollapse(); } catch (e) {} try { composerStyleNativeMarkers(); } catch (e) {} }
        // AGL view depends on DEM that loads async — re-render cards each tick so
        // the "… MSL (loading)" placeholders flip to AGL once ground is cached.
        else if (showAglInEditor && collapseEditorCards) { try { applyNativeEditorCollapse(); } catch (e) {} }
        // NOTE: auto-AGL is SAVE-ONLY now (applySnapAglToBodyStr) — we no longer
        // re-float snapshots on every move (it hammered the DEM endpoint into
        // 429s, and you only need it correct at save time).
    }
    function liveAutoSnapAgl(ctx) {
        const aglM = defaultSnapAglFt / 3.28084;
        for (const s of ctx.instrs) {
            if (!s || s.type_name !== 'snapshot' || !s.location || s.location.lat == null) continue;
            const key = `${(+s.location.lat).toFixed(6)},${(+s.location.lng).toFixed(6)}`;
            if (liveSnapLastLoc[s.id] === key) continue;            // this position already handled
            const ground = getElevationFromCache(s.location.lat, s.location.lng);
            if (ground == null) { try { fetchElevation(s.location.lat, s.location.lng); } catch (e) {} continue; } // wait for DEM, retry next tick
            const firstSight = !(s.id in liveSnapLastLoc);
            liveSnapLastLoc[s.id] = key;
            if (firstSight) continue;                                // baseline only
            const newV = Math.round((ground + aglM) * 100) / 100;
            if (typeof s.value1 === 'number' && Math.abs(s.value1 - newV) < 0.5) continue; // already correct
            try { ctx.upd(Object.assign({}, s, { value1: newV })); } catch (e) { continue; }
            if (composerMission) { const ci = (composerMission.instructions || []).find(x => x && String(x.id) === String(s.id)); if (ci) ci.value1 = newV; }
            console.log(`${TAG} [auto-agl] live: snapshot ${s.id} moved → value1 ${newV}m (ground ${Math.round(ground)} + ${defaultSnapAglFt}ft)`);
        }
    }

    // ====================================================================
    // MISSION GENERATOR — Increment 1: draw the site's assets + FFZs on the
    // Mission Bank map; right-click (M2) an asset to PREVIEW its scan geometry
    // (nav = closest safe point in the FFZ at ~100 ft standoff; snap = asset
    // centroid at ground + default AGL). NO mission is written yet — this proves
    // the data fetch, the drawing, the hit-test and the geometry. The actual
    // build + save (saveApp) comes in Increment 2.
    // ====================================================================
    const GEN_BTN_ID = 'aim-mb-gen-btn';
    const GEN_TARGET_STANDOFF_FT = 100; // ideal nav↔asset distance
    const GEN_FFZ_INSET_M = 1;          // push the nav this far inside the FFZ edge
    const GEN_SKIP_STATES = ['unreachable', 'unshielded', 'empty'];
    // Skip-state reason for an asset (unreachable/unshielded/empty) or null if
    // it's valid to generate. Ported from the Asset Inspector's assetSkipReason:
    // is_unshielded flag, else the state suffix after " - " in poi_type_str.
    function genSkipReason(asset) {
        if (asset.unshielded) return 'unshielded';
        const p = asset.poi || '';
        const i = p.indexOf(' - ');
        const suffix = i >= 0 ? p.slice(i + 3).trim().toLowerCase() : '';
        return GEN_SKIP_STATES.indexOf(suffix) >= 0 ? suffix : null;
    }
    const genEntCache = {};
    let genLayer = null, genPreviewLayer = null, genOverlayOn = false, genBase = null, genPopupEl = null;

    function genFetchEntities(siteID) {
        if (genEntCache[siteID]) return Promise.resolve(genEntCache[siteID]);
        const url = `https://percepto.app/map_objects/?getPoiMapObjectsAsList=true&site_id=${encodeURIComponent(siteID)}`;
        return fetch(url, { credentials: 'include' })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(arr => {
                const list = Array.isArray(arr) ? arr : (arr && arr.objects) || [];
                const ring = e => e.coords.map(c => ({ lat: c.lat, lng: c.lng }));
                const assets = list.filter(e => e && e.type === 3 && Array.isArray(e.coords) && e.coords.length >= 3)
                    .map(e => ({ id: e.id, name: e.name || '', ring: ring(e), poi: (e.custom && e.custom.poi_type_str) || '', unshielded: !!(e.custom && e.custom.is_unshielded) }));
                const ffzs = list.filter(e => e && e.type === 16 && Array.isArray(e.coords) && e.coords.length >= 3)
                    .map(e => ({ id: e.id, name: e.name || '', ring: ring(e), minAltM: (e.restrictions && typeof e.restrictions.minAlt === 'number') ? e.restrictions.minAlt : null }));
                // Base station (type 8) → origin for N/E/S/W section naming.
                // Fallback: centroid of all assets (so naming still works).
                let base = null;
                const baseEnt = list.find(e => e && e.type === 8 && (e.location || (Array.isArray(e.coords) && e.coords.length)));
                if (baseEnt) base = baseEnt.location ? { lat: baseEnt.location.lat, lng: baseEnt.location.lng } : { lat: baseEnt.coords[0].lat, lng: baseEnt.coords[0].lng };
                if (!base && assets.length) { let la = 0, ln = 0; assets.forEach(a => { const c = genCentroid(a.ring); la += c.lat; ln += c.lng; }); base = { lat: la / assets.length, lng: ln / assets.length }; }
                // For the Section+Battery MERGE: flight-path entities (type 15, arcs)
                // for the routing graph, and base candidates (type 8 installs, else
                // type-19 GMs named /base/i) for resolveBasesMB. Kept raw — the merge
                // routing core consumes arcs + coords directly.
                const fps = list.filter(e => e && e.type === 15 && Array.isArray(e.arcs));
                const baseEnts = list.filter(e => e && e.type === 8 && Array.isArray(e.coords) && e.coords[0] && typeof e.coords[0].lat === 'number');
                const gmBaseEnts = list.filter(e => e && e.type === 19 && e.name && /base/i.test(e.name) && Array.isArray(e.coords) && e.coords[0] && typeof e.coords[0].lat === 'number');
                const data = { assets, ffzs, base, fps, baseEnts: baseEnts.length ? baseEnts : gmBaseEnts };
                genEntCache[siteID] = data; genBase = base;
                return data;
            });
    }
    // ── geometry helpers (ported minimal) ──
    function genCentroid(ring) { let lat = 0, lng = 0; ring.forEach(p => { lat += p.lat; lng += p.lng; }); return { lat: lat / ring.length, lng: lng / ring.length }; }
    function genPointInPoly(pt, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].lng, yi = ring[i].lat, xj = ring[j].lng, yj = ring[j].lat;
            if (((yi > pt.lat) !== (yj > pt.lat)) && (pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }
    function genAssetFFZ(assetC, ffzs) {
        for (const f of ffzs) if (genPointInPoly(assetC, f.ring)) return f;
        let best = null, bd = Infinity;
        for (const f of ffzs) { const d = sopHaversineFt(assetC, genCentroid(f.ring)); if (d < bd) { bd = d; best = f; } }
        return best;
    }
    // Nav point: walk the FFZ boundary, and for each sample step ~1 m along the
    // edge's INWARD normal (the offset point that tests INSIDE the polygon), then
    // pick the inside point whose standoff to the asset is nearest ~100 ft. This
    // guarantees the nav lands inside the FFZ (not on the edge, where Percepto can
    // read it as outside) regardless of the FFZ's shape.
    function genNavPoint(assetC, ffz) {
        const ring = ffz.ring;
        const lat0 = (assetC.lat || ring[0].lat) * Math.PI / 180;
        const mLat = 111320, mLng = 111320 * Math.cos(lat0);
        const toXY = p => ({ x: p.lng * mLng, y: p.lat * mLat });
        const toLL = q => ({ lng: q.x / mLng, lat: q.y / mLat });
        let best = null, bestErr = Infinity, bestDist = 0;
        const consider = ll => {
            if (!genPointInPoly(ll, ring)) return;          // must land INSIDE
            const d = sopHaversineFt(assetC, ll), err = Math.abs(d - GEN_TARGET_STANDOFF_FT);
            if (err < bestErr) { bestErr = err; best = ll; bestDist = d; }
        };
        for (let i = 0; i < ring.length; i++) {
            const ax = toXY(ring[i]), bx = toXY(ring[(i + 1) % ring.length]);
            let nx = -(bx.y - ax.y), ny = (bx.x - ax.x); const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl; // unit edge normal
            for (let k = 0; k <= 6; k++) {
                const t = k / 6, px = ax.x + (bx.x - ax.x) * t, py = ax.y + (bx.y - ax.y) * t;
                consider(toLL({ x: px + nx * GEN_FFZ_INSET_M, y: py + ny * GEN_FFZ_INSET_M })); // one normal
                consider(toLL({ x: px - nx * GEN_FFZ_INSET_M, y: py - ny * GEN_FFZ_INSET_M })); // the other (inside one wins)
            }
        }
        if (!best) { const c = genCentroid(ring); best = c; bestDist = sopHaversineFt(assetC, c); } // fallback
        return { point: best, standoffFt: bestDist };
    }

    function genClearOverlay() {
        const map = getLeafletMap();
        if (genLayer && map) { try { map.removeLayer(genLayer); } catch (e) {} }
        if (genPreviewLayer && map) { try { map.removeLayer(genPreviewLayer); } catch (e) {} }
        genLayer = null; genPreviewLayer = null;
    }
    function genDrawOverlay() {
        const L = composerGetL(); const map = getLeafletMap(); const siteID = getCurrentSiteID();
        if (!L || !map || !siteID) { showToast('Generator: map/site not ready — open the Mission Bank map first.', '#ff9800'); return; }
        patchLeafletMap();
        genFetchEntities(siteID).then(({ assets, ffzs }) => {
            genClearOverlay();
            const group = L.layerGroup();
            ffzs.forEach(f => { try { L.polygon(f.ring.map(p => [p.lat, p.lng]), { color: '#39ff14', weight: 1, fill: false, interactive: false }).addTo(group); } catch (e) {} });
            let valid = 0, skipped = 0;
            assets.forEach(a => {
                try {
                    const skip = genSkipReason(a);             // red = would be skipped (bad state)
                    if (skip) skipped++; else valid++;
                    const col = skip ? '#ff6b6b' : '#fff';
                    const poly = L.polygon(a.ring.map(p => [p.lat, p.lng]), { color: col, weight: 1.5, fillColor: col, fillOpacity: skip ? 0.05 : 0.08, className: 'aim-gen-asset' });
                    poly.on('contextmenu', ev => { try { L.DomEvent.stop(ev); } catch (e) {} genShowGeneratePopup(a, ffzs, ev); });
                    poly.addTo(group);
                } catch (e) {}
            });
            group.addTo(map);
            genLayer = group; genOverlayOn = true; genUpdateBtn();
            showToast(`Generator: ${valid} valid · ${skipped} skip-state (red) · ${ffzs.length} FFZs. Right-click an asset to generate.`, '#5fff5f', 5500);
        }).catch(e => { console.warn(`${TAG} [gen] fetch/draw failed`, e); showToast('Generator: failed to load assets (see console).', '#ff5252', 4000); });
    }
    function genToggleOverlay() {
        if (genOverlayOn) { genClearOverlay(); genOverlayOn = false; genUpdateBtn(); showToast('Generator overlay off.', '#888', 1500); }
        else genDrawOverlay();
    }
    function genDrawPreview(snapPt, navPt) {
        const L = composerGetL(), map = getLeafletMap(); if (!L || !map || !navPt) return;
        if (genPreviewLayer) { try { map.removeLayer(genPreviewLayer); } catch (e) {} }
        const g = L.layerGroup();
        try {
            L.polyline([[navPt.lat, navPt.lng], [snapPt.lat, snapPt.lng]], { color: '#b04dff', weight: 2, dashArray: '4,4' }).addTo(g);
            L.circleMarker([navPt.lat, navPt.lng], { radius: 6, color: '#fff', weight: 1.5, fillColor: '#2f6bff', fillOpacity: 0.95 }).addTo(g);
            L.circleMarker([snapPt.lat, snapPt.lng], { radius: 6, color: '#fff', weight: 1.5, fillColor: '#ec4899', fillOpacity: 0.95 }).addTo(g);
        } catch (e) {}
        g.addTo(map); genPreviewLayer = g;
    }
    function genUpdateBtn() {
        const b = document.getElementById(GEN_BTN_ID);
        if (b) {
            b.textContent = genOverlayOn ? '⊕ Assets: ON' : '⊕ Generate';
            b.style.background = genOverlayOn ? '#14d2dc' : '#0d1b24';
            b.style.color = genOverlayOn ? '#04222a' : '#3fe0ea';
        }
        const all = document.getElementById(GEN_ALL_BTN_ID);
        if (all) all.style.display = genOverlayOn ? 'block' : 'none';
    }
    const GEN_ALL_BTN_ID = 'aim-mb-gen-all-btn';

    // ── Generator lock ────────────────────────────────────────────────────────
    // The mission GENERATOR (⊕ Generate / ▣ Generate All) CREATES real missions on
    // the live site via saveApp — by far the highest blast-radius tool here. It is
    // therefore LOCKED OFF by default for everyone; only an install that has flipped
    // the local flag below shows or runs it. Coworkers never run the unlock, so they
    // never see the buttons and can't trigger it. (Per-install GM flag — effectively
    // "just my machine"; nothing identity-bound, but undocumented + default-off.)
    // Unlock on your own install from the Mission Bank iframe console:
    //     __aimMBGenerator(true)     // unlock (persists across reloads)
    //     __aimMBGenerator(false)    // re-lock
    //     __aimMBGenerator()         // report current state
    // Everything else (SUM panel, inspector, altitude editing, SOP check, KML,
    // auto-AGL, ➕ Stage, marker-switch) is unaffected by this lock.
    const GEN_LOCK_KEY = 'aim-mb-generator-unlocked';
    let generatorUnlocked = false;
    try { generatorUnlocked = gmGet(GEN_LOCK_KEY, false) === true; } catch (e) {}
    function setGeneratorUnlocked(on) {
        if (on === undefined) { console.log(`${TAG} [generator] ${generatorUnlocked ? 'UNLOCKED' : 'LOCKED'} on this install`); return generatorUnlocked; }
        generatorUnlocked = !!on;
        try { gmSet(GEN_LOCK_KEY, generatorUnlocked); } catch (e) {}
        try {
            if (!generatorUnlocked) {
                const b = document.getElementById(GEN_BTN_ID); if (b) b.remove();
                const a = document.getElementById(GEN_ALL_BTN_ID); if (a) a.remove();
                const mr = document.getElementById('aim-mb-gen-merge-btn'); if (mr) mr.remove();
                genCloseBulkPanel();
                try { mbCloseMergePanel(); } catch (e) {}
                try { if (genOverlayOn) { genClearOverlay(); genOverlayOn = false; } } catch (e) {} // tear down any drawn asset overlay
            } else {
                genEnsureButton();
            }
        } catch (e) {}
        console.log(`${TAG} [generator] ${generatorUnlocked ? 'UNLOCKED' : 'LOCKED'} on this install`);
        showToast(`Mission Generator ${generatorUnlocked ? 'unlocked' : 'locked'} on this install.`, generatorUnlocked ? '#5fff5f' : '#ff9800', 3500);
        return generatorUnlocked;
    }
    try { const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window; w.__aimMBGenerator = setGeneratorUnlocked; } catch (e) {}

    function genRemoveButtons() {
        const b = document.getElementById(GEN_BTN_ID); if (b) b.remove();
        const a = document.getElementById(GEN_ALL_BTN_ID); if (a) a.remove();
        const mr = document.getElementById('aim-mb-gen-merge-btn'); if (mr) mr.remove();
    }
    function genEnsureButton() {
        if (CONTEXT !== 'IFRAME') return;
        if (!generatorUnlocked) return;   // generator locked off on this install
        // Generate / Merge are MISSION-BANK-only — never inject on Site Setup (the
        // old .pr-map-container fallback matched there). Remove them if we navigated away.
        if (!isOnMissionBank()) { genRemoveButtons(); return; }
        const mapC = document.querySelector('.mission-bank__map-container');
        if (!mapC) return;
        if (document.getElementById(GEN_BTN_ID)) { genUpdateBtn(); return; }
        if (getComputedStyle(mapC).position === 'static') mapC.style.position = 'relative';
        const btn = document.createElement('button');
        btn.id = GEN_BTN_ID; btn.type = 'button';
        btn.title = 'Draw the site\'s assets + FFZs on the map, then right-click an asset to generate its scan mission.';
        btn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:1100;padding:6px 11px;border-radius:6px;cursor:pointer;' +
            'font:800 12px "Lato",sans-serif;border:1.5px solid #14d2dc;box-shadow:0 2px 8px rgba(0,0,0,0.7);';
        btn.onclick = e => { e.preventDefault(); e.stopPropagation(); genToggleOverlay(); };
        mapC.appendChild(btn);
        // "Generate All" — bulk-generate every valid (white) asset. Shown only
        // while the overlay is on.
        const all = document.createElement('button');
        all.id = GEN_ALL_BTN_ID; all.type = 'button';
        all.textContent = '▣ Generate All';
        all.title = 'Generate a mission for every VALID asset (skips Empty / Unreachable / Unshielded) — preview, then commit.';
        all.style.cssText = 'position:absolute;top:40px;left:8px;z-index:1100;padding:6px 11px;border-radius:6px;cursor:pointer;display:none;' +
            'font:800 12px "Lato",sans-serif;border:1.5px solid #5fff5f;background:#0d2410;color:#7dff7d;box-shadow:0 2px 8px rgba(0,0,0,0.7);';
        all.onclick = e => { e.preventDefault(); e.stopPropagation(); genOpenBulkPanel(); };
        mapC.appendChild(all);
        // "⛟ Merge" — group solo missions into battery-tiered merged missions per
        // section. Independent of the asset overlay (operates on missions), so it
        // stays visible whenever the generator is unlocked.
        const mrg = document.createElement('button');
        mrg.id = 'aim-mb-gen-merge-btn'; mrg.type = 'button';
        mrg.textContent = '⛟ Merge';
        mrg.title = 'Group this site\'s solo missions into battery-tiered merged missions per section (furthest→closest from base).';
        mrg.style.cssText = 'position:absolute;top:8px;left:118px;z-index:1100;padding:6px 11px;border-radius:6px;cursor:pointer;' +
            'font:800 12px "Lato",sans-serif;border:1.5px solid #ffb74d;background:#241a0d;color:#ffce80;box-shadow:0 2px 8px rgba(0,0,0,0.7);';
        mrg.onclick = e => { e.preventDefault(); e.stopPropagation(); mbOpenMergePanel(); };
        mapC.appendChild(mrg);
        genUpdateBtn();
    }

    // ── Increment 2: build a mission for an asset + create it via saveApp ──────
    // N/E/S/W quadrant of a point relative to the base station (dominant axis).
    function genSection(pt) {
        if (!genBase) return '?';
        const dLat = pt.lat - genBase.lat, dLng = pt.lng - genBase.lng;
        if (Math.abs(dLat) >= Math.abs(dLng)) return dLat >= 0 ? 'N' : 'S';
        return dLng >= 0 ? 'E' : 'W';
    }
    // Pure: build the instruction list + name for one asset. Returns null if the
    // FFZ or ground elevation isn't available yet. Step shapes match a real solo
    // mission (types: takeoff 0, navigate 1, snapshot 6, cameraSelect 7, gemMode
    // 24, wait 5, returnHome 99). saveApp only sends type/location/value1/value2/
    // extra_options/polygon_points/snapshot_points, so that's all we set.
    function buildMissionForAsset(asset, ffzs, opts) {
        opts = opts || {};
        const aC = genCentroid(asset.ring);
        const ffz = genAssetFFZ(aC, ffzs);
        if (!ffz) return null;
        const groundM = getElevationFromCache(aC.lat, aC.lng);
        if (groundM == null) { if (aC.lat != null) try { fetchElevation(aC.lat, aC.lng); } catch (e) {} return null; }
        const nav = genNavPoint(aC, ffz);
        const navAltM = ffz.minAltM != null ? ffz.minAltM : (groundM + 40);
        const snapAltM = groundM + (defaultSnapAglFt / 3.28084);
        const I = (type, value1, value2, location, extra) => ({ type, value1: value1 === undefined ? null : value1, value2: value2 === undefined ? null : value2, location: location || null, extra_options: extra || {}, polygon_points: null, snapshot_points: null });
        const instrs = [];
        instrs.push(I(0, 20, null, null, {}));                                              // takeoff
        instrs.push(I(1, navAltM, 12, { lat: nav.point.lat, lng: nav.point.lng }, { shouldUseFreezoneMinAlt: true })); // navigate (FFZ min alt)
        const count = Math.max(1, opts.count || 1);
        for (let s = 0; s < count; s++) {
            instrs.push(I(6, snapAltM, 1, { lat: aC.lat, lng: aC.lng }, { pitch: 1001 }));   // snapshot @ asset center
            if (opts.inspectionScan) {
                instrs.push(I(7, true, null, null, {}));   // camera (thermal) ON
                instrs.push(I(24, 1, null, null, {}));     // GEM ON
                instrs.push(I(5, 10, null, null, {}));     // wait 10s
                instrs.push(I(24, 0, null, null, {}));     // GEM OFF
                instrs.push(I(7, false, null, null, {}));  // camera OFF
            }
        }
        instrs.push(I(99, null, null, null, {}));                                           // returnHome
        const name = `${genSection(aC)} - ${asset.name || ('Asset ' + asset.id)}`;
        return { instructions: instrs, name, navStandoffFt: nav.standoffFt };
    }
    // Find the mission editor's app context (saveApp + setCurrentApp). Anchors on
    // stable Mission Bank DOM (works even with NO mission open in the editor).
    function findMissionAppCtx() {
        const anchors = ['[data-rfd-draggable-id]', '.mission-bank__map-container', '.mission-bank__content', '.mission-bank'];
        for (const sel of anchors) {
            const el = document.querySelector(sel); if (!el) continue;
            const f0 = mbGetFiber(el);
            for (const start of [f0, f0 && f0.alternate]) {
                let node = start, depth = 0;
                while (node && depth < 160) {
                    let v; try { v = node.memoizedProps && node.memoizedProps.value; } catch (e) { v = null; }
                    if (v && typeof v === 'object' && typeof v.saveApp === 'function' && typeof v.setCurrentApp === 'function') return v;
                    node = node.return; depth++;
                }
            }
        }
        return null;
    }
    // Find Percepto's mission-LIST refetch — the zero-arg fn that re-GETs
    // /available_app/ (the sidebar list query, projected to only:"id,name") and
    // pushes the result into the list's setState. Found via the AIM_Mission_List_Probe:
    // its source uniquely contains BOTH "/available_app/" and an `only:` projection,
    // which distinguishes it from saveApp(2)/deleteApp(1). Walk the Mission Bank fiber
    // for a 0-arg function matching that signature. Re-walk fresh each call
    // (per-render closures).
    function findMissionListRefetch() {
        const anchors = ['a[href*="/mission-bank/"]', '.mission-bank__content', '.mission-bank', '.mission-bank__map-container', '[data-rfd-draggable-id]'];
        const seen = new Set();
        const scan = (obj) => {
            if (!obj || typeof obj !== 'object' || seen.has(obj)) return null; seen.add(obj);
            let keys = []; try { keys = Object.keys(obj); } catch (e) { return null; }
            for (const k of keys) {
                let v; try { v = obj[k]; } catch (e) { continue; }
                if (typeof v === 'function' && v.length === 0) {
                    let s = ''; try { s = String(v); } catch (e) {}
                    if (/available_app/.test(s) && /only\s*:/.test(s)) return v;
                }
            }
            return null;
        };
        for (const sel of anchors) {
            const el = document.querySelector(sel); if (!el) continue;
            const f0 = mbGetFiber(el);
            for (const start of [f0, f0 && f0.alternate]) {
                let node = start, depth = 0;
                while (node && depth < 200) {
                    let r = null;
                    try { r = scan(node.memoizedProps && node.memoizedProps.value); } catch (e) {} if (r) return r;
                    try { r = scan(node.memoizedProps); } catch (e) {} if (r) return r;
                    try { r = scan(node.stateNode); } catch (e) {} if (r) return r;
                    try { let h = node.memoizedState, i = 0; while (h && i < 40) { let rr = scan(h.memoizedState); if (rr) return rr; h = h.next; i++; } } catch (e) {}
                    node = node.return; depth++;
                }
            }
        }
        return null;
    }
    // Refresh Percepto's sidebar mission list in place (no page reload) after a
    // generate/bulk create. Best-effort: if the refetch fn can't be found, the new
    // missions still exist on the server — they just need a manual reload to show.
    function refreshMissionList() {
        try {
            const fn = findMissionListRefetch();
            if (typeof fn === 'function') { fn(); console.log(`${TAG} [gen] mission list refreshed`); return true; }
            console.warn(`${TAG} [gen] list-refetch fn not found — list may need a manual reload`);
        } catch (e) { console.warn(`${TAG} [gen] list refresh failed`, e); }
        return false;
    }

    async function genGenerateForAsset(asset, ffzs, opts) {
        if (!generatorUnlocked) return;   // generator locked off on this install
        const ctx = findMissionAppCtx();
        if (!ctx) { showToast('Mission context not found — make sure you\'re on the Mission Bank page.', '#ff5252', 4000); return; }
        const built = buildMissionForAsset(asset, ffzs, opts);
        if (!built) { showToast('Could not build mission (no FFZ near asset, or ground elevation still loading — try again).', '#ff9800', 4000); return; }
        showToast(`Creating "${built.name}"…`, '#9ad', 2500);
        try {
            const app = { id: null, type: 1, instructions: built.instructions, data_report_object_arr: [] };
            const res = await ctx.saveApp(app, built.name);
            const saved = (res && res.app) ? res.app : res;
            console.log(`${TAG} [gen] created mission "${built.name}"`, saved);
            showToast(`✓ Created "${built.name}" — opening it to adjust.`, '#5fff5f', 5000);
            try { refreshMissionList(); } catch (e) {} // sidebar shows the new mission (no reload)
            try { ctx.setCurrentApp(saved); } catch (e) { console.warn(`${TAG} [gen] setCurrentApp failed`, e); }
            // Navigate to the new mission's editor URL so it shows without a page
            // refresh. Use THIS frame's own hash (the editor is in the react-pages
            // iframe) — the iframe is sandboxed and can't navigate the top window.
            try {
                const cur = location.hash || '';
                const mm = cur.match(/^(.*\/mission-bank)(?:\/\d+)?/);
                if (mm && saved && saved.id != null) {
                    const target = `${mm[1]}/${saved.id}`;
                    if (cur !== target) location.hash = target;
                }
            } catch (e) { console.warn(`${TAG} [gen] open-nav failed`, e); }
        } catch (e) {
            console.warn(`${TAG} [gen] saveApp failed`, e);
            showToast('Generate failed — see console (the mission was NOT created).', '#ff5252', 5000);
        }
    }
    // M2 on an asset → preview line + a small popup to confirm + Generate.
    function genCloseGenPopup() { if (genPopupEl) { genPopupEl.remove(); genPopupEl = null; } document.removeEventListener('mousedown', genPopupOutside, true); }
    function genPopupOutside(e) { if (genPopupEl && !genPopupEl.contains(e.target)) genCloseGenPopup(); }
    function genShowGeneratePopup(asset, ffzs, ev) {
        if (!generatorUnlocked) return;   // generator locked off on this install
        genCloseGenPopup();
        const aC = genCentroid(asset.ring);
        const ffz = genAssetFFZ(aC, ffzs);
        if (!ffz) { showToast(`No FFZ near ${asset.name || 'asset'} — can't place the drone.`, '#ff9800', 4000); return; }
        const groundM = getElevationFromCache(aC.lat, aC.lng);
        if (groundM == null) { try { fetchElevation(aC.lat, aC.lng); } catch (e) {} showToast('Loading ground elevation — right-click again in a moment.', '#9ad', 2500); return; }
        const nav = genNavPoint(aC, ffz);
        genDrawPreview(aC, nav.point);
        const snapAltFt = Math.round(groundM * 3.28084) + defaultSnapAglFt;
        const navAltFt = ffz.minAltM != null ? Math.round(ffz.minAltM * 3.28084) : null;
        const name = `${genSection(aC)} - ${asset.name || ('Asset ' + asset.id)}`;
        const pop = document.createElement('div');
        pop.className = 'aim-mb-bp-pop';
        // Solid styling INLINE (the .aim-mb-bp-pop CSS is only injected when the
        // SUM panel renders; this popup can appear without it).
        pop.style.cssText += 'position:fixed;z-index:2147483600;min-width:250px;background:#1f2228;' +
            'border:1px solid #14d2dc;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,0.8);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;';
        pop.innerHTML = `
            <div class="aim-mb-menu-head" style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.12);"><span class="aim-mb-menu-title" style="font-weight:800;color:#7adfe6;font-size:13px;">⊕ Generate mission</span><button class="aim-mb-menu-close" data-gp-close style="flex:0 0 auto;background:rgba(255,255,255,0.12);border:none;color:#fff;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;">✕</button></div>
            <div style="padding:10px 12px;font-size:11px;color:#cfe;">
                <div style="font-weight:800;color:#7adfe6;margin-bottom:6px;font-size:12px;">${escapeHtml(name)}</div>
                <div>Snapshot @ asset center · ground+${defaultSnapAglFt} = <b>${snapAltFt} ft</b></div>
                <div>Navigate in FFZ · ${navAltFt != null ? 'FFZ-min <b>' + navAltFt + ' ft</b>' : 'FFZ-min n/a'} · ${Math.round(nav.standoffFt)} ft out</div>
                ${genSkipReason(asset) ? `<div style="color:#ff7a00;margin-top:4px;">⚠ Asset state: <b>${escapeHtml(genSkipReason(asset))}</b> — bulk would SKIP this one.</div>` : ''}
                <label style="display:flex;align-items:center;gap:6px;margin:9px 0;cursor:pointer;"><input type="checkbox" data-gp-scan checked> Inspection scan (Thermal/GEM/Wait wrap)</label>
                <div style="display:flex;gap:6px;justify-content:flex-end;">
                    <button class="aim-mb-tbtn" data-gp-cancel>Cancel</button>
                    <button class="aim-mb-bulk-btn" data-gp-go>⊕ Generate</button>
                </div>
            </div>`;
        document.body.appendChild(pop);
        genPopupEl = pop;
        const oe = ev.originalEvent || ev;
        pop.style.left = ((oe.clientX || 100) + 8) + 'px';
        pop.style.top = ((oe.clientY || 100) + 8) + 'px';
        const r = pop.getBoundingClientRect();
        if (r.right > window.innerWidth - 8) pop.style.left = Math.max(8, window.innerWidth - 8 - r.width) + 'px';
        if (r.bottom > window.innerHeight - 8) pop.style.top = Math.max(8, (oe.clientY || 100) - r.height - 8) + 'px';
        pop.querySelector('[data-gp-close]').onclick = genCloseGenPopup;
        pop.querySelector('[data-gp-cancel]').onclick = genCloseGenPopup;
        pop.querySelector('[data-gp-go]').onclick = () => {
            const scan = pop.querySelector('[data-gp-scan]').checked;
            genCloseGenPopup();
            genGenerateForAsset(asset, ffzs, { inspectionScan: scan });
        };
        setTimeout(() => document.addEventListener('mousedown', genPopupOutside, true), 0);
    }

    // ── Bulk: generate a mission for every VALID asset ────────────────────────
    const GEN_BULK_PANEL_ID = 'aim-mb-gen-bulk';
    let genBulkBusy = false;
    function genPreviewInfo(asset, ffzs) {
        const aC = genCentroid(asset.ring);
        const ffz = genAssetFFZ(aC, ffzs);
        const groundM = getElevationFromCache(aC.lat, aC.lng);
        const nav = ffz ? genNavPoint(aC, ffz) : null;
        return {
            name: `${genSection(aC)} - ${asset.name || ('Asset ' + asset.id)}`,
            ffz: !!ffz, ground: groundM,
            standoffFt: nav ? Math.round(nav.standoffFt) : null,
            snapAltFt: groundM != null ? Math.round(groundM * 3.28084) + defaultSnapAglFt : null,
            navAltFt: (ffz && ffz.minAltM != null) ? Math.round(ffz.minAltM * 3.28084) : null,
            buildable: !!(ffz && groundM != null),
        };
    }
    function genCloseBulkPanel() { const p = document.getElementById(GEN_BULK_PANEL_ID); if (p) p.remove(); }
    // Existing mission names (lowercased) for the site — so bulk skips assets
    // that already have a mission. Always a FRESH fetch (catches ones you just made).
    function genFetchMissionNames(siteID) {
        return fetch(`/available_app/?site_id=${encodeURIComponent(siteID)}&type=1`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : [])
            .then(arr => (Array.isArray(arr) ? arr : []).map(m => ((m && m.name) || '').trim().toLowerCase()).filter(Boolean))
            .catch(() => []);
    }
    function genHasMission(asset, names) {
        const an = (asset.name || '').trim().toLowerCase();
        if (!an) return false;
        const gen = `${genSection(genCentroid(asset.ring))} - ${asset.name}`.trim().toLowerCase();
        return names.some(nm => nm === gen || nm === an || nm.endsWith(' - ' + an));
    }
    function genOpenBulkPanel() {
        if (!generatorUnlocked) return;   // generator locked off on this install
        const siteID = getCurrentSiteID();
        if (!siteID) { showToast('Generator: no site.', '#ff9800'); return; }
        showToast('Loading assets + missions + elevations…', '#9ad', 2200);
        Promise.all([genFetchEntities(siteID), genFetchMissionNames(siteID)]).then(([{ assets, ffzs }, names]) => {
            const stateSkip = assets.filter(a => genSkipReason(a));
            const haveMission = assets.filter(a => !genSkipReason(a) && genHasMission(a, names));
            const valid = assets.filter(a => !genSkipReason(a) && !genHasMission(a, names));
            // Only fetch centroids we DON'T already have (exact or a nearby cached
            // DEM point) — most are already cached from Asset Inspector's sampling,
            // so this typically fetches nothing and never touches the rate limit.
            const pts = valid.map(a => genCentroid(a.ring)).filter(p => getElevationFromCache(p.lat, p.lng) == null);
            const render = () => genRenderBulkPanel(valid, stateSkip, haveMission, ffzs);
            if (!pts.length) { render(); return; }
            console.log(`${TAG} [gen-bulk] fetching ${pts.length} uncached elevations (of ${valid.length} assets)`);
            try { bulkFetchElevations(pts).then(render).catch(render); } catch (e) { render(); }
        }).catch(e => { console.warn(`${TAG} [gen-bulk] load failed`, e); showToast('Generator: failed to load assets (see console).', '#ff5252', 4000); });
    }
    function genRenderBulkPanel(valid, stateSkip, haveMission, ffzs) {
        genCloseBulkPanel();
        const rows = valid.map((a, i) => {
            const info = genPreviewInfo(a, ffzs);
            const dis = info.buildable ? '' : 'opacity:0.5;';
            const detail = info.buildable
                ? `nav ${info.standoffFt} ft @ ${info.navAltFt != null ? info.navAltFt + ' ft' : 'FFZ-min'} · snap ${info.snapAltFt} ft`
                : (info.ffz ? 'elevation not loaded' : 'no FFZ found — skip');
            return `<label class="aim-gen-row" style="display:flex;align-items:center;gap:8px;padding:5px 4px;border-bottom:1px solid #2a2f38;${dis}">
                <input type="checkbox" data-gen-row="${i}" ${info.buildable ? 'checked' : ''} ${info.buildable ? '' : 'disabled'}>
                <span style="flex:1;color:#e6e6e6;font-weight:700;">${escapeHtml(info.name)}</span>
                <span style="color:#9ad;font-size:10px;white-space:nowrap;">${escapeHtml(detail)}</span>
            </label>`;
        }).join('');
        const nm = a => escapeHtml(`${genSection(genCentroid(a.ring))} - ${a.name || a.id}`);
        const existRows = haveMission.map(a => `<div style="padding:3px 4px;color:#9ad;font-size:11px;border-bottom:1px solid #1b2430;">${nm(a)} <span style="color:#678;">· already has a mission</span></div>`).join('');
        const skipRows = stateSkip.map(a => `<div style="padding:3px 4px;color:#ff8a8a;font-size:11px;border-bottom:1px solid #241b1b;">${nm(a)} <span style="color:#a66;">· ${escapeHtml(genSkipReason(a))}</span></div>`).join('');
        const p = document.createElement('div');
        p.id = GEN_BULK_PANEL_ID;
        p.style.cssText = 'position:fixed;top:60px;right:24px;width:380px;max-height:80vh;display:flex;flex-direction:column;z-index:2147483600;' +
            'background:#161a20;border:1px solid #5fff5f;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.7);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;';
        p.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 12px;background:rgba(95,255,95,0.08);border-bottom:1px solid rgba(95,255,95,0.3);">
                <span style="font-weight:800;color:#7dff7d;font-size:14px;">▣ Generate Missions</span>
                <button data-gen-bulk-close style="flex:0 0 auto;background:rgba(255,255,255,0.12);border:none;color:#fff;width:22px;height:22px;border-radius:4px;cursor:pointer;">✕</button>
            </div>
            <div style="padding:8px 12px;font-size:11px;color:#bbb;border-bottom:1px solid #2a2f38;">
                <b style="color:#7dff7d;">${valid.length}</b> to create · <b style="color:#9ad;">${haveMission.length}</b> already have missions · <b style="color:#ff8a8a;">${stateSkip.length}</b> skip-state
                <label style="display:flex;align-items:center;gap:6px;margin-top:7px;cursor:pointer;color:#cfe;"><input type="checkbox" data-gen-bulk-scan checked> Inspection scan (Thermal/GEM/Wait wrap) on every mission</label>
            </div>
            <div style="overflow:auto;flex:1;padding:2px 10px;">${rows || '<div style="padding:12px;color:#888;">No assets to create.</div>'}
                ${existRows ? `<div style="margin-top:8px;color:#9ad;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;">Already have missions</div>${existRows}` : ''}
                ${skipRows ? `<div style="margin-top:8px;color:#ff8a8a;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;">Skipped (state)</div>${skipRows}` : ''}
            </div>
            <div style="padding:9px 12px;border-top:1px solid #2a2f38;display:flex;align-items:center;gap:8px;">
                <span data-gen-bulk-status style="flex:1;font-size:11px;color:#9ad;"></span>
                <button data-gen-bulk-cancel class="aim-mb-tbtn" style="padding:5px 10px;">Cancel</button>
                <button data-gen-bulk-go style="padding:5px 12px;background:#5fff5f;border:none;color:#04220a;border-radius:6px;cursor:pointer;font-weight:800;">⊕ Create</button>
            </div>`;
        document.body.appendChild(p);
        const close = () => genCloseBulkPanel();
        p.querySelector('[data-gen-bulk-close]').onclick = close;
        p.querySelector('[data-gen-bulk-cancel]').onclick = close;
        const goBtn = p.querySelector('[data-gen-bulk-go]');
        const updateGo = () => { const n = p.querySelectorAll('[data-gen-row]:checked').length; goBtn.textContent = `⊕ Create ${n}`; goBtn.disabled = !n || genBulkBusy; };
        p.querySelectorAll('[data-gen-row]').forEach(cb => cb.onchange = updateGo);
        updateGo();
        goBtn.onclick = () => {
            if (genBulkBusy) return;
            const picked = [...p.querySelectorAll('[data-gen-row]:checked')].map(cb => valid[Number(cb.getAttribute('data-gen-row'))]).filter(Boolean);
            const scan = p.querySelector('[data-gen-bulk-scan]').checked;
            genBulkCommit(picked, ffzs, { inspectionScan: scan }, p.querySelector('[data-gen-bulk-status]'), goBtn);
        };
    }
    async function genBulkCommit(assets, ffzs, opts, statusEl, goBtn) {
        if (!generatorUnlocked) return;   // generator locked off on this install
        const ctx = findMissionAppCtx();
        if (!ctx) { showToast('Mission context not found — be on the Mission Bank page.', '#ff5252', 4000); return; }
        genBulkBusy = true; if (goBtn) goBtn.disabled = true;
        let ok = 0, fail = 0;
        const setStatus = t => { if (statusEl) statusEl.textContent = t; };
        for (let i = 0; i < assets.length; i++) {
            setStatus(`Creating ${i + 1}/${assets.length}…`);
            const built = buildMissionForAsset(assets[i], ffzs, opts);
            if (!built) { fail++; continue; }
            try { await ctx.saveApp({ id: null, type: 1, instructions: built.instructions, data_report_object_arr: [] }, built.name); ok++; }
            catch (e) { fail++; console.warn(`${TAG} [gen-bulk] failed "${built.name}"`, e); }
        }
        genBulkBusy = false;
        setStatus(`Done — created ${ok}${fail ? `, ${fail} failed` : ''}.`);
        // Refresh Percepto's sidebar list in place so the new missions appear now.
        const refreshed = ok ? refreshMissionList() : false;
        showToast(`▣ Bulk generate: created ${ok}${fail ? ` · ${fail} failed (see console)` : ''}.${ok && !refreshed ? ' Reload the list to see them.' : ''}`, ok ? '#5fff5f' : '#ff5252', 7000);
        console.log(`${TAG} [gen-bulk] created ${ok}, failed ${fail}`);
        if (goBtn) goBtn.disabled = false;
    }

    // ════════════════════════════════════════════════════════════════════════
    // SECTION + BATTERY MERGE (v1.48) — group the site's SOLO missions into
    // battery-tiered merged missions per compass section (8-way + Central),
    // ordered furthest→closest from base. Routing core PORTED from Asset Inspector
    // (graph + Dijkstra + FFZ-bridging + batteryFor) so routed distances + Tattu/
    // Tulip tiers MATCH its Battery column. Merge = ordered concatenation of the
    // solos' bodies (strip each takeoff/returnHome, wrap ONE takeoff + ONE return);
    // the server computes route_points/app_data (verified vs a real merged mission).
    // Gated behind the generator unlock (it CREATES missions).
    // ════════════════════════════════════════════════════════════════════════
    const MB_BATTERY = { tattuMaxFt: 14000, tulipMaxFt: 18000 };
    const MB_REACH_FFZ_FT = 70, MB_ENTRY_FFZ_FT = 25;
    const MB_CENTRAL_FT = 750;   // asset within this straight-line of base → "Central"
    const MB_SECTION_NAMES = { N: 'North', NE: 'Northeast', E: 'East', SE: 'Southeast', S: 'South', SW: 'Southwest', W: 'West', NW: 'Northwest', C: 'Central' };
    const MB_SECTION_ORDER = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'C'];

    function mbApproxMeters(lat1, lng1, lat2, lng2) { const R = 6371000; const p1 = lat1 * Math.PI / 180; const dp = (lat2 - lat1) * Math.PI / 180; const dl = (lng2 - lng1) * Math.PI / 180; const x = dl * Math.cos(p1), y = dp; return Math.sqrt(x * x + y * y) * R; }
    function mbVkey(p) { return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`; }
    function mbSimplifyPolygon(poly) { if (!poly || poly.length < 3) return poly || []; let cl = 0, cn = 0; for (const p of poly) { cl += p.lat; cn += p.lng; } cl /= poly.length; cn /= poly.length; return poly.slice().sort((a, b) => Math.atan2(a.lat - cl, a.lng - cn) - Math.atan2(b.lat - cl, b.lng - cn)); }
    function mbPointToSegMeters(lat, lng, a, b) { const ax = a.lng, ay = a.lat, bx = b.lng, by = b.lat; const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy; let t = l2 === 0 ? 0 : ((lng - ax) * dx + (lat - ay) * dy) / l2; t = Math.max(0, Math.min(1, t)); return mbApproxMeters(lat, lng, ay + t * dy, ax + t * dx); }
    function mbPointToPolygonMeters(lat, lng, ring) { if (!ring || ring.length < 3) return Infinity; if (genPointInPoly({ lat, lng }, ring)) return 0; let best = Infinity; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const d = mbPointToSegMeters(lat, lng, ring[j], ring[i]); if (d < best) best = d; } return best; }
    function mbBuildGraph(fps) {
        const adj = new Map(), verts = new Map();
        const addV = p => { const k = mbVkey(p); if (!verts.has(k)) verts.set(k, { lat: p.lat, lng: p.lng }); if (!adj.has(k)) adj.set(k, []); return k; };
        (fps || []).forEach(e => { (e.arcs || []).forEach(arc => { if (!arc.point_a || !arc.point_b) return; if (typeof arc.point_a.lat !== 'number' || typeof arc.point_b.lat !== 'number') return; const ka = addV(arc.point_a), kb = addV(arc.point_b); if (ka === kb) return; const w = (typeof arc.distance === 'number' && arc.distance > 0) ? arc.distance : mbApproxMeters(arc.point_a.lat, arc.point_a.lng, arc.point_b.lat, arc.point_b.lng); adj.get(ka).push({ to: kb, w }); adj.get(kb).push({ to: ka, w }); }); });
        return { adj, verts };
    }
    function mbDijkstra(graph, startKey) { const dist = new Map(); if (!graph.adj.has(startKey)) return dist; dist.set(startKey, 0); const vis = new Set(); const pq = [{ k: startKey, d: 0 }]; while (pq.length) { let mi = 0; for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[mi].d) mi = i; const { k, d } = pq.splice(mi, 1)[0]; if (vis.has(k)) continue; vis.add(k); (graph.adj.get(k) || []).forEach(({ to, w }) => { const nd = d + w; if (nd < (dist.has(to) ? dist.get(to) : Infinity)) { dist.set(to, nd); pq.push({ k: to, d: nd }); } }); } return dist; }
    function mbNearestVertex(graph, lat, lng) { let best = null; graph.verts.forEach((v, k) => { const d = mbApproxMeters(lat, lng, v.lat, v.lng); if (!best || d < best.dist) best = { key: k, dist: d, vert: v }; }); return best; }
    function mbBatteryFor(routeM) { if (routeM == null) return null; const ft = routeM * 3.28084; if (ft <= MB_BATTERY.tattuMaxFt) return { label: 'Tattu', color: '#5fff5f', level: 0 }; if (ft <= MB_BATTERY.tulipMaxFt) return { label: 'Tulip', color: '#ffd54f', level: 1 }; return { label: `⚠ over ${MB_BATTERY.tulipMaxFt.toLocaleString()} ft`, color: '#ff5252', level: 2 }; }

    // 8-way + Central section from base. atan2(dLat,dLng): 0=E, 90=N.
    function mbSection(pt, base) {
        if (!base) return 'C';
        if (mbApproxMeters(base.lat, base.lng, pt.lat, pt.lng) * 3.28084 <= MB_CENTRAL_FT) return 'C';
        const dLat = pt.lat - base.lat, dLng = pt.lng - base.lng;
        let deg = Math.atan2(dLat, dLng) * 180 / Math.PI; if (deg < 0) deg += 360; // 0=E,90=N,180=W,270=S
        const idx = Math.round(deg / 45) % 8;
        return ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][idx];
    }

    // Build a router for the site: bridged FP graph + base Dijkstra maps. routeFor
    // (a list of asset points) returns one-way routeM (base→FFZ far edge) — the
    // EXACT Asset-Inspector algorithm. Reusable across all assets on the site.
    function mbBuildRouter(ent) {
        const graph = mbBuildGraph(ent.fps);
        const ffzs = (ent.ffzs || []).map(f => ({ ring: mbSimplifyPolygon(f.ring) }));
        const fpVerts = []; graph.verts.forEach((v, k) => fpVerts.push({ key: k, lat: v.lat, lng: v.lng }));
        const entryM = MB_ENTRY_FFZ_FT / 3.28084;
        ffzs.forEach(f => { const inside = fpVerts.filter(v => mbPointToPolygonMeters(v.lat, v.lng, f.ring) <= entryM); for (let i = 0; i < inside.length; i++) for (let j = i + 1; j < inside.length; j++) { const w = mbApproxMeters(inside[i].lat, inside[i].lng, inside[j].lat, inside[j].lng); graph.adj.get(inside[i].key).push({ to: inside[j].key, w }); graph.adj.get(inside[j].key).push({ to: inside[i].key, w }); } });
        const bases = (ent.baseEnts && ent.baseEnts.length) ? ent.baseEnts.map(b => ({ lat: b.coords[0].lat, lng: b.coords[0].lng })) : (ent.base ? [ent.base] : []);
        const baseRuns = bases.map(b => { const bv = mbNearestVertex(graph, b.lat, b.lng); if (!bv) return null; return { baseConn: bv.dist, dist: mbDijkstra(graph, bv.key) }; }).filter(Boolean);
        const reachM = MB_REACH_FFZ_FT / 3.28084;
        return {
            ready: graph.verts.size > 0 && baseRuns.length > 0,
            verts: graph.verts.size,
            routeFor(pts) {
                if (!pts || !pts.length) return null;
                let ffz = null, ffzD = Infinity;
                ffzs.forEach(f => { let best = Infinity; pts.forEach(c => { const d = mbPointToPolygonMeters(c.lat, c.lng, f.ring); if (d < best) best = d; }); if (best < ffzD) { ffzD = best; ffz = f; } });
                if (!ffz || ffzD > reachM) return null;
                const entries = fpVerts.filter(v => mbPointToPolygonMeters(v.lat, v.lng, ffz.ring) <= entryM);
                if (!entries.length) return null;
                let best = null;
                baseRuns.forEach(br => { entries.forEach(en => { const net = br.dist.has(en.key) ? br.dist.get(en.key) : null; if (net == null) return; let far = 0; ffz.ring.forEach(p => { const dd = mbApproxMeters(en.lat, en.lng, p.lat, p.lng); if (dd > far) far = dd; }); const total = br.baseConn + net + far; if (best == null || total < best) best = total; }); });
                return best;
            }
        };
    }

    // The asset point(s) a solo inspects = its snapshot (type 6) locations (asset
    // center). Falls back to navigate (type 1) locations. Used for section + routing.
    function mbSoloPoints(mission) {
        const ins = (mission && mission.instructions) || [];
        const snaps = ins.filter(i => i && i.type === 6 && i.location && typeof i.location.lat === 'number').map(i => ({ lat: i.location.lat, lng: i.location.lng }));
        if (snaps.length) return snaps;
        return ins.filter(i => i && i.type === 1 && i.location && typeof i.location.lat === 'number').map(i => ({ lat: i.location.lat, lng: i.location.lng }));
    }
    // The mission "body" = everything except the leading takeoff + trailing
    // returnHome (types 0 / 99). These get concatenated in the merge.
    function mbMissionBody(mission) {
        return ((mission && mission.instructions) || []).filter(i => i && i.type !== 0 && i.type !== 99);
    }

    // Compute the merge plan for a site: per-solo {mission, pts, ring, routeM,
    // section, battery}, then grouped into battery-tiered, furthest→closest sets.
    // `overrides` = {missionId: sectionCode} manual section reassignments.
    function mbComputeMerge(siteID, missions, ent, overrides) {
        const router = mbBuildRouter(ent);
        const base = ent.base;
        const solos = missions.map(m => {
            const pts = mbSoloPoints(m);
            if (!pts.length) return { mission: m, routeM: null, reason: 'no-location', section: 'C', battery: null };
            // Match to an asset entity (pad ring contains the snapshot point) for an
            // accurate pad-edge → FFZ distance; else route from the point itself.
            const c = pts[0];
            let ring = null;
            for (const a of (ent.assets || [])) { if (genPointInPoly(c, a.ring)) { ring = a.ring; break; } }
            const routePts = ring || pts;
            const routeM = router.ready ? router.routeFor(routePts) : null;
            const ov = overrides && overrides[String(m.id)];
            const section = ov || mbSection(c, base);
            return { mission: m, pt: c, routeM, reason: routeM == null ? (router.ready ? 'unreachable' : 'no-routing-data') : '', section, battery: mbBatteryFor(routeM) };
        });
        // Group by section → battery-tier sets.
        const bySection = {};
        solos.forEach(s => { (bySection[s.section] = bySection[s.section] || []).push(s); });
        const groups = [];
        MB_SECTION_ORDER.forEach(code => {
            const list = (bySection[code] || []).slice();
            if (!list.length) return;
            // order furthest→closest by routeM (null routes sink to the bottom).
            list.sort((a, b) => (b.routeM == null ? -1 : b.routeM) - (a.routeM == null ? -1 : a.routeM));
            const routable = list.filter(s => s.routeM != null);
            const tattu = routable.filter(s => s.battery && s.battery.level === 0);
            const tulip = routable.filter(s => s.battery && s.battery.level === 1);
            const over = routable.filter(s => s.battery && s.battery.level === 2);
            const name = MB_SECTION_NAMES[code];
            if (tulip.length) {
                // East 1 = Tattu subset; East 2 = Tattu + Tulip (East 2 ⊇ East 1).
                if (tattu.length) groups.push({ code, name: `${name} 1`, battery: 'Tattu', solos: tattu.slice() });
                groups.push({ code, name: `${name} 2`, battery: 'Tulip', solos: tattu.concat(tulip) });
            } else if (tattu.length) {
                groups.push({ code, name: `${name} 1-2`, battery: 'Tattu/Tulip', solos: tattu.slice() });
            }
            // over-range + unroutable solos are surfaced in the panel but not merged.
            if (over.length || list.some(s => s.routeM == null)) {
                const excluded = over.concat(list.filter(s => s.routeM == null));
                groups.push({ code, name: `${name} — excluded`, excluded });
            }
        });
        return { solos, groups, routerReady: router.ready, verts: router.verts };
    }

    // ── Merge panel + commit ─────────────────────────────────────────────────
    const MB_MERGE_PANEL_ID = 'aim-mb-merge-panel';
    let mbMergeBusy = false;
    function mbCloseMergePanel() { const p = document.getElementById(MB_MERGE_PANEL_ID); if (p) p.remove(); }
    function mbCurrentSiteID() { const m = (location.hash || '').match(/#\/site\/(\d+)\//); return m ? m[1] : null; }
    function mbFetchMissionsFull(siteID) {
        return fetch(`/available_app/?site_id=${encodeURIComponent(siteID)}&type=1`, { credentials: 'include' })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(arr => Array.isArray(arr) ? arr : []);
    }
    function mbOpenMergePanel() {
        if (!generatorUnlocked) return;
        if (CONTEXT !== 'IFRAME') return;
        const siteID = mbCurrentSiteID();
        if (!siteID) { showToast('No site loaded.', '#ff9800', 3000); return; }
        showToast('⛟ Loading missions + map for the merge…', '#9ad', 2500);
        Promise.all([mbFetchMissionsFull(siteID), genFetchEntities(siteID)])
            .then(([missions, ent]) => {
                const overrides = {};
                const rerender = () => { const data = mbComputeMerge(siteID, missions, ent, overrides); mbRenderMergePanel(data, siteID, missions, ent, overrides, rerender); };
                rerender();
            })
            .catch(e => { console.warn(`${TAG} [merge] load failed`, e); showToast('Merge: failed to load (see console).', '#ff5252', 4000); });
    }
    function mbRenderMergePanel(data, siteID, missions, ent, overrides, rerender) {
        mbCloseMergePanel();
        const ft = m => m == null ? '—' : `${Math.round(m * 3.28084).toLocaleString()} ft`;
        const secOpts = (cur) => MB_SECTION_ORDER.map(c => `<option value="${c}" ${c === cur ? 'selected' : ''}>${MB_SECTION_NAMES[c]}</option>`).join('');
        const mergeGroups = data.groups.filter(g => g.solos);
        const exclGroups = data.groups.filter(g => g.excluded);
        const chip = (b) => b ? `<span style="background:${b.color}22;color:${b.color};border:1px solid ${b.color}66;border-radius:4px;padding:0 5px;font-size:10px;font-weight:700;white-space:nowrap;">${b.label}</span>` : '';
        const soloRow = (s) => `<div style="display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid #20262e;">
            <span style="flex:1;color:#e6e6e6;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.mission.name || ('#' + s.mission.id))}</span>
            <span style="color:#9ad;font-size:10px;white-space:nowrap;">${ft(s.routeM)}</span>
            ${chip(s.battery)}
            <select data-mb-ov="${s.mission.id}" title="Reassign section" style="background:#0e1218;color:#cde;border:1px solid #2a3340;border-radius:4px;font-size:10px;padding:1px 2px;">${secOpts(s.section)}</select>
        </div>`;
        const groupBlock = (g) => `<div style="margin:6px 0;border:1px solid #2a3a2a;border-radius:6px;overflow:hidden;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;background:rgba(95,255,95,0.08);">
                <span style="font-weight:800;color:#7dff7d;font-size:12px;">⛟ ${escapeHtml(g.name)}</span>
                <span style="color:#9ad;font-size:10px;">${g.solos.length} stops · ${g.battery}</span>
            </div>
            <div style="padding:2px 4px;">${g.solos.map(soloRow).join('')}</div>
        </div>`;
        const exclBlock = (g) => `<div style="margin:5px 0;padding:4px 8px;border:1px solid #3a2a2a;border-radius:6px;">
            <div style="color:#ff8a8a;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px;">${escapeHtml(g.name)}</div>
            ${g.excluded.map(s => `<div style="display:flex;align-items:center;gap:6px;padding:2px 2px;font-size:11px;color:#caa;"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.mission.name || ('#' + s.mission.id))}</span><span style="color:#a66;font-size:10px;">${s.reason === 'unreachable' ? 'no route' : (s.reason || (s.battery && s.battery.level === 2 ? 'over range' : ''))}</span><select data-mb-ov="${s.mission.id}" style="background:#0e1218;color:#cde;border:1px solid #2a3340;border-radius:4px;font-size:10px;">${secOpts(s.section)}</select></div>`).join('')}
        </div>`;
        const routable = data.solos.filter(s => s.routeM != null).length;
        const p = document.createElement('div');
        p.id = MB_MERGE_PANEL_ID;
        p.style.cssText = 'position:fixed;top:60px;right:24px;width:430px;max-height:84vh;display:flex;flex-direction:column;z-index:2147483600;' +
            'background:#161a20;border:1px solid #5fff5f;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.7);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;';
        p.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 12px;background:rgba(95,255,95,0.08);border-bottom:1px solid rgba(95,255,95,0.3);">
                <span style="font-weight:800;color:#7dff7d;font-size:14px;">⛟ Merge by Section + Battery</span>
                <button data-mb-merge-close style="background:rgba(255,255,255,0.12);border:none;color:#fff;width:22px;height:22px;border-radius:4px;cursor:pointer;">✕</button>
            </div>
            <div style="padding:7px 12px;font-size:11px;color:#bbb;border-bottom:1px solid #2a2f38;">
                <b style="color:#7dff7d;">${missions.length}</b> solo missions · <b style="color:#9ad;">${routable}</b> routable · <b style="color:#7dff7d;">${mergeGroups.length}</b> merge groups${data.routerReady ? '' : ' · <b style="color:#ff8a8a;">no routing data (no FPs/base)</b>'}
                <div style="margin-top:3px;color:#789;">Furthest→closest from base. East 1 = Tattu subset, East 2 = + Tulip. Reassign a stop's section with the dropdown.</div>
            </div>
            <div style="overflow:auto;flex:1;padding:4px 10px;">
                ${mergeGroups.length ? mergeGroups.map(groupBlock).join('') : '<div style="padding:12px;color:#888;">No mergeable groups (need routable solos).</div>'}
                ${exclGroups.length ? `<div style="margin-top:6px;color:#ff8a8a;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;">Excluded (not merged)</div>${exclGroups.map(exclBlock).join('')}` : ''}
            </div>
            <div style="padding:9px 12px;border-top:1px solid #2a2f38;display:flex;align-items:center;gap:8px;">
                <span data-mb-merge-status style="flex:1;font-size:11px;color:#9ad;"></span>
                <button data-mb-merge-go style="padding:6px 12px;background:#5fff5f;border:none;color:#04220a;border-radius:6px;cursor:pointer;font-weight:800;" ${mergeGroups.length && !mbMergeBusy ? '' : 'disabled'}>⛟ Create ${mergeGroups.length} merged</button>
            </div>`;
        document.body.appendChild(p);
        p.querySelector('[data-mb-merge-close]').onclick = mbCloseMergePanel;
        p.querySelectorAll('[data-mb-ov]').forEach(sel => sel.onchange = () => { overrides[sel.getAttribute('data-mb-ov')] = sel.value; rerender(); });
        p.querySelector('[data-mb-merge-go]').onclick = () => mbCommitAllMerges(mergeGroups, p.querySelector('[data-mb-merge-status]'), p.querySelector('[data-mb-merge-go]'));
    }
    function mbMakeStep(type, value1) { return { type, value1: value1 === undefined ? null : value1, value2: null, location: null, extra_options: {}, polygon_points: null, snapshot_points: null }; }
    async function mbCommitAllMerges(groups, statusEl, goBtn) {
        if (!generatorUnlocked || mbMergeBusy) return;
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.saveApp !== 'function') { showToast('Mission context not found — be on the Mission Bank page.', '#ff5252', 4000); return; }
        mbMergeBusy = true; if (goBtn) goBtn.disabled = true;
        const setStatus = t => { if (statusEl) statusEl.textContent = t; };
        let ok = 0, fail = 0;
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            setStatus(`Creating "${g.name}" (${i + 1}/${groups.length})…`);
            // takeoff + each solo's body (no takeoff/return) furthest→closest + returnHome
            const body = [];
            g.solos.forEach(s => mbMissionBody(s.mission).forEach(st => body.push(st)));
            const instrs = [mbMakeStep(0, 20)].concat(body, [mbMakeStep(99)]);
            try { await ctx.saveApp({ id: null, type: 1, instructions: instrs, data_report_object_arr: [] }, g.name); ok++; }
            catch (e) { fail++; console.warn(`${TAG} [merge] failed "${g.name}"`, e); }
        }
        mbMergeBusy = false;
        const refreshed = ok ? refreshMissionList() : false;
        setStatus(`Done — created ${ok}${fail ? `, ${fail} failed` : ''}.`);
        showToast(`⛟ Merge: created ${ok} merged mission${ok === 1 ? '' : 's'}${fail ? ` · ${fail} failed (see console)` : ''}.${ok && !refreshed ? ' Reload the list to see them.' : ''}`, ok ? '#5fff5f' : '#ff5252', 7000);
        console.log(`${TAG} [merge] created ${ok}, failed ${fail}`);
        if (goBtn) goBtn.disabled = false;
    }

    // ── Stage steps: add N Navigates + M Snapshots to the OPEN mission, placed
    // near the existing nav/snap so you can drag them into position. Navigates
    // keep shouldUseFreezoneMinAlt (FFZ-min); snapshots auto-set to ground+AGL on
    // drop via the live Auto-AGL.
    // IMPLEMENTATION: COPY existing steps verbatim (preserving their exact type
    // objects + all fields) and rebuild the app via setCurrentApp. createInstruction's
    // h() mangles the type (number OR object → "No instruction component for type
    // [object Object]"), so we avoid it: copied steps already have valid types and
    // setCurrentApp is the same path normal edits use → renders + saves cleanly.
    function genStageSteps(navCount, snapCount, inspectionScan, insertAtNav) {
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.setCurrentApp !== 'function' || !ctx.currentApp) { showToast('Open a mission in the editor first.', '#ff9800', 4000); return; }
        const app = ctx.currentApp;
        // Source the instruction list from the cached app, falling back to the LIVE
        // editor state if that's empty/stale (so Stage works even when currentApp
        // hasn't populated yet).
        let instrs = app.instructions || [];
        if (!instrs.length) { try { const lc = findMissionEditorCtx(); if (lc && Array.isArray(lc.instrs) && lc.instrs.length) instrs = lc.instrs; } catch (e) {} }
        // Match by type_name OR type number — live editor steps don't always carry
        // type_name. (navigate=1, snapshot=6, cameraSelect=7, gemMode=24, wait=5,
        // returnHome=99.)
        const isNav = s => s && (s.type_name === 'navigate' || s.type === 1);
        const isSnap = s => s && (s.type_name === 'snapshot' || s.type === 6);
        const isReturn = s => s && (s.type_name === 'returnHome' || s.type === 99);
        const isWrap = s => s && (s.type_name === 'cameraSelect' || s.type === 7 || s.type_name === 'gemMode' || s.type === 24 || s.type_name === 'wait' || s.type === 5);
        // Copy settings from the LAST nav/snap (you finetune the most recent one).
        // Prefer one WITH a GPS location as the template, but fall back to ANY (an
        // "In Place" snapshot has no location yet still works as a settings template).
        const pickRef = (pred) => {
            const list = instrs.filter(pred);
            if (!list.length) return null;
            for (let i = list.length - 1; i >= 0; i--) { if (list[i].location && list[i].location.lat != null) return list[i]; }
            return list[list.length - 1];
        };
        const navRef = pickRef(isNav);
        const snapRef = pickRef(isSnap);
        if ((navCount && !navRef) || (snapCount && !snapRef)) {
            console.warn(`${TAG} [stage] no template — instrs:${instrs.length} navs:${instrs.filter(isNav).length} snaps:${instrs.filter(isSnap).length} (open a mission with a Navigate + Snapshot)`);
            showToast('Need an existing Navigate + Snapshot to copy from — generate/open a scan mission first.', '#ff9800', 4500); return;
        }
        // wrap template = the scan steps trailing the LAST snapshot (copied as-is)
        const wrapTpl = [];
        let si = -1; for (let i = instrs.length - 1; i >= 0; i--) { if (isSnap(instrs[i])) { si = i; break; } }
        if (si >= 0) for (let i = si + 1; i < instrs.length; i++) { if (isWrap(instrs[i])) wrapTpl.push(instrs[i]); else break; }
        // Place new steps in the MIDDLE OF THE CURRENT MAP VIEW (so they're easy to
        // find), fanned out in a small grid by index so multiples don't overlap.
        // Falls back to an offset from the ref if the map center isn't available.
        const map = getLeafletMap();
        const ctr = (map && typeof map.getCenter === 'function') ? map.getCenter() : null;
        const placeAt = (ref, i) => {
            const refLoc = (ref && ref.location && ref.location.lat != null) ? ref.location : null;
            const base = ctr ? { lat: ctr.lat, lng: ctr.lng } : refLoc;
            if (!base) return null; // no map center + no ref GPS (In-Place ref) → leave location unset
            const col = i % 4, row = Math.floor(i / 4);
            const mPerLat = 110540, mPerLng = 111320 * Math.cos(base.lat * Math.PI / 180);
            return { lat: base.lat + (row * 12) / mPerLat, lng: base.lng + (col * 12) / mPerLng };
        };
        // copy a step (preserve type object + all fields) with a UNIQUE id —
        // Percepto uses instruction.id as the React key (id.toString()), so a
        // missing/duplicate id crashes the editor (blank screen). The save strips
        // ids (server assigns real ones), so any unique client id is fine.
        let idSeq = 9000000000 + (((Date.now ? Date.now() : 1) % 1000000) * 100);
        const copyStep = (tpl, loc) => { const c = Object.assign({}, tpl); c.id = idSeq++; if (c.extra_options) c.extra_options = Object.assign({}, c.extra_options); if (loc) c.location = { lat: loc.lat, lng: loc.lng }; return c; };
        const staged = [];
        let placeIdx = 0;
        for (let i = 0; i < navCount; i++) staged.push(copyStep(navRef, placeAt(navRef, placeIdx++)));
        for (let j = 0; j < snapCount; j++) {
            // A staged snapshot is placed on the map + dragged into position, so it
            // must be a proper GPS ("To GPS") snapshot even if the template was an
            // "In Place" (yaw/tilt, no-GPS) one from a J2A mission. Force GPS mode +
            // a real location so it shows on the map and exports/validates correctly.
            const sc = copyStep(snapRef, placeAt(snapRef, placeIdx++));
            sc.value2 = 1; // "To GPS" mode
            sc.extra_options = Object.assign({}, sc.extra_options || {}, { pitch: 1001 });
            staged.push(sc);
            if (inspectionScan) wrapTpl.forEach(w => staged.push(copyStep(w, null)));
        }
        if (!staged.length) { showToast('Nothing to stage.', '#888'); return; }
        // Rebuild the instruction list (shallow-copy existing so we don't mutate
        // live objects), insert the staged steps, re-index.
        const newInstrs = instrs.map(s => Object.assign({}, s));
        const endIdx = () => { const rh = newInstrs.findIndex(isReturn); return rh < 0 ? newInstrs.length : rh; };
        // Insert position: before the Nth existing Navigate (so the new nav BECOMES
        // N#, pushing the old N#..end down by one) when insertAtNav is set; else at
        // the end (before returnHome).
        let insertIdx;
        if (insertAtNav && insertAtNav >= 1) {
            const navIdxs = [];
            newInstrs.forEach((s, k) => { if (isNav(s)) navIdxs.push(k); });
            insertIdx = (insertAtNav <= navIdxs.length) ? navIdxs[insertAtNav - 1] : endIdx();
        } else {
            insertIdx = endIdx();
        }
        newInstrs.splice(insertIdx, 0, ...staged);
        newInstrs.forEach((s, k) => { if (s) s.index_in_app = k; });
        const posMsg = (insertAtNav && insertAtNav >= 1) ? ` at N${insertAtNav}` : '';
        try {
            ctx.setCurrentApp(Object.assign({}, app, { instructions: newInstrs }));
            try { composerStyleNativeMarkers(); } catch (e) {}
            showToast(`Staged ${navCount} navigate(s) + ${snapCount} snapshot(s)${posMsg} — drag them into place, then SAVE.${snapCount ? ' Arm 📷 Auto-AGL so snapshots auto-set elevation on drop.' : ''}`, '#5fff5f', 7000);
        } catch (e) { console.warn(`${TAG} [stage] setCurrentApp failed`, e); showToast('Stage failed — see console.', '#ff5252', 4000); }
    }
    let genStagePopEl = null;
    function genStagePopup(anchorBtn) {
        if (genStagePopEl) { genStagePopEl.remove(); genStagePopEl = null; return; }
        const pop = document.createElement('div');
        pop.style.cssText = 'position:fixed;z-index:2147483600;min-width:210px;background:#1f2228;border:1px solid #9cf;border-radius:6px;' +
            'box-shadow:0 4px 20px rgba(0,0,0,0.8);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;padding:10px 12px;';
        pop.innerHTML = `
            <div style="font-weight:800;color:#9cf;font-size:13px;margin-bottom:8px;">➕ Stage steps</div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;"><label style="flex:1;">Navigates</label><input type="number" min="0" max="50" value="0" data-st-nav style="width:60px;background:#0f1216;border:1px solid #9cf;color:#fff;padding:3px 6px;border-radius:3px;"></div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;"><label style="flex:1;">Snapshots</label><input type="number" min="0" max="50" value="1" data-st-snap style="width:60px;background:#0f1216;border:1px solid #9cf;color:#fff;padding:3px 6px;border-radius:3px;"></div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px;"><label style="flex:1;">Insert at Nav #</label><input type="number" min="1" max="200" placeholder="end" data-st-at style="width:60px;background:#0f1216;border:1px solid #9cf;color:#fff;padding:3px 6px;border-radius:3px;"></div>
            <div style="font-size:10px;color:#789;margin-bottom:10px;">Blank = end. e.g. 6 → new nav becomes N6, the rest shift down.</div>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:10px;cursor:pointer;"><input type="checkbox" data-st-scan checked> Inspection scan wrap per snapshot</label>
            <div style="display:flex;gap:6px;justify-content:flex-end;">
                <button class="aim-mb-tbtn" data-st-cancel style="padding:5px 10px;">Cancel</button>
                <button data-st-add style="padding:5px 12px;background:#9cf;border:none;color:#06223a;border-radius:6px;cursor:pointer;font-weight:800;">Stage</button>
            </div>`;
        document.body.appendChild(pop);
        genStagePopEl = pop;
        const r = anchorBtn.getBoundingClientRect();
        pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8) + 'px';
        pop.style.top = (r.bottom + 4) + 'px';
        const close = () => { pop.remove(); genStagePopEl = null; document.removeEventListener('mousedown', outside, true); };
        const outside = e => { if (genStagePopEl && !pop.contains(e.target) && e.target !== anchorBtn) close(); };
        pop.querySelector('[data-st-cancel]').onclick = close;
        pop.querySelector('[data-st-add]').onclick = () => {
            const nav = Math.max(0, parseInt(pop.querySelector('[data-st-nav]').value, 10) || 0);
            const snap = Math.max(0, parseInt(pop.querySelector('[data-st-snap]').value, 10) || 0);
            const scan = pop.querySelector('[data-st-scan]').checked;
            const atRaw = parseInt(pop.querySelector('[data-st-at]').value, 10);
            const at = (!isNaN(atRaw) && atRaw >= 1) ? atRaw : null; // null = end
            close();
            if (!nav && !snap) { showToast('Set a Navigate and/or Snapshot count.', '#ff9800'); return; }
            genStageSteps(nav, snap, scan, at);
        };
        setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    }

    // The on-screen instruction ids, in current editor order.
    function composerDomIds() {
        return [...document.querySelectorAll('[data-rfd-draggable-id]')].map(el => el.getAttribute('data-rfd-draggable-id'));
    }
    // Match the open editor's cards to a cached mission by shared instruction
    // ids. Auto-refetches the site's missions when the cache is STALE — i.e.
    // the editor shows cards the cached mission doesn't have (you added/edited
    // steps) — so you never have to open the SUM first to refresh.
    function identifyOpenMission(cb) {
        const domIds = composerDomIds();
        if (!domIds.length) { cb(null); return; }
        const sid = getCurrentSiteID();
        const evaluate = (missions, fromFetch) => {
            let best = null, bestHits = 0;
            for (const m of (Array.isArray(missions) ? missions : [])) {
                const idset = new Set((m.instructions || []).map(x => String(x.id)));
                let hits = 0; for (const d of domIds) if (idset.has(d)) hits++;
                if (hits > bestHits) { bestHits = hits; best = m; }
            }
            const matched = best && bestHits >= Math.min(domIds.length, 3);
            const bestSet = best ? new Set((best.instructions || []).map(x => String(x.id))) : null;
            const covers = bestSet ? domIds.every(d => bestSet.has(d)) : false;
            // If we matched but the cache doesn't cover every on-screen card
            // (stale after an edit), OR didn't match at all, refetch ONCE.
            if ((!matched || !covers) && !fromFetch) {
                delete missionsBySite[sid];
                fetchMissions(sid, (m) => evaluate(m, true), () => cb(matched ? { mission: best, domIds } : null));
                return;
            }
            cb(matched ? { mission: best, domIds } : null);
        };
        const cached = missionsBySite[sid] && missionsBySite[sid].missions;
        if (Array.isArray(cached)) evaluate(cached, false);
        else fetchMissions(sid, (m) => evaluate(m, true), () => cb(null));
    }
    // Manual force-refresh: drop the cache + re-identify + redraw. Wired to the
    // 🔄 button so you can resync after editing in the native editor.
    function composerRefresh() {
        const sid = getCurrentSiteID();
        if (sid) delete missionsBySite[sid];
        composerMission = null;
        loggedNoMarkers = false;
        showToast('Refreshing mission from server…', '#9ad', 1500);
        composerEnsureMapMode(); // reload + re-number the native markers
    }

    // Re-style the native markers after a reorder (the cached mission supplies
    // each step's data by id; the order is read live from the DOM, so this
    // stays correct after a reorder).
    function rerenderComposer() {
        if (!composerMission) return;
        try { composerStyleNativeMarkers(); } catch (e) { console.warn(`${TAG} [composer] marker restyle failed`, e); }
    }

    // ── Reorder engine (ports the Quick Mission Editor's fiber reorder) ──
    function composerGetFiber(el) {
        const k = Object.keys(el).find(kk => kk.startsWith('__reactFiber') || kk.startsWith('__reactInternalInstance'));
        return k ? el[k] : null;
    }
    const COMPOSER_REORDER_CANDIDATES = [
        n => n && n.memoizedProps && n.memoizedProps.value && n.memoizedProps.value.reorderInstructions,
        n => n && n.memoizedProps && n.memoizedProps.reorderInstructions,
        n => n && n.stateNode && n.stateNode.props && n.stateNode.props.reorderInstructions,
        n => n && n.stateNode && n.stateNode.reorderInstructions,
    ];
    function composerFindReorderFn() {
        const d = document.querySelector('[data-rfd-draggable-id]');
        if (!d) return null;
        let node = composerGetFiber(d), depth = 0;
        while (node && depth < 80) {
            for (const p of COMPOSER_REORDER_CANDIDATES) { let fn; try { fn = p(node); } catch (e) {} if (typeof fn === 'function') return fn; }
            node = node.return; depth++;
        }
        console.warn(`${TAG} [composer] reorderInstructions not found after ${depth} fiber levels — Percepto may have refactored.`);
        return null;
    }
    function composerIndexById(id) {
        return [...document.querySelectorAll('[data-rfd-draggable-id]')].findIndex(el => el.getAttribute('data-rfd-draggable-id') === String(id));
    }
    // Wait until the moved item actually lands at expectedIdx (DOM reorder),
    // or time out. Mirrors the Quick Mission Editor's completion signal.
    function composerWaitForReorder(movedId, expectedIdx, ms = 3000) {
        return new Promise(resolve => {
            let done = false, obs = null, timer = null;
            const finish = (ok) => { if (done) return; done = true; if (obs) obs.disconnect(); if (timer) clearTimeout(timer); resolve(ok); };
            const target = document.querySelector('[data-rfd-droppable-id]') || document.querySelector('.mission-edit__content');
            if (target) {
                obs = new MutationObserver(() => { if (composerIndexById(movedId) === expectedIdx) finish(true); });
                obs.observe(target, { childList: true, subtree: true });
            }
            timer = setTimeout(() => finish(composerIndexById(movedId) === expectedIdx), ms);
        });
    }
    // Move a set of ids (in order) so they land starting at targetIndex.
    async function composerMoveIdsToIndex(orderedIds, targetIndex) {
        let placement = targetIndex;
        for (const id of orderedIds) {
            const from = composerIndexById(id);
            if (from < 0) continue;
            const to = from < placement ? placement - 1 : placement;
            if (from === to) { placement = to + 1; continue; }
            // CRITICAL: reorderInstructions is a React closure over the CURRENT
            // render's instruction snapshot; each call re-renders and
            // invalidates it. Re-walk the fiber for a FRESH function before
            // every move — reusing one stale fn was the v0.87 bug (every call
            // operated on the original order → scramble/crash).
            const fn = composerFindReorderFn();
            if (!fn) { console.warn(`${TAG} [composer] reorder fn lost mid-move`); break; }
            const p = composerWaitForReorder(id, to, 3000);
            try { fn(from, to); } catch (e) { console.warn(`${TAG} [composer] reorder error`, e); }
            await p;
            await new Promise(r => setTimeout(r, 130)); // let the new render settle so the next fetch is current
            placement = to + 1;
        }
    }
    // ── Leaflet access (ported from Map Styler) ──────────────────────────
    let leafletMapRef = null, leafletPatched = false;
    function composerGetL() { const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window; return w.L || null; }
    function composerLooksLikeMap(v) {
        return v && typeof v === 'object'
            && typeof v.latLngToContainerPoint === 'function'
            && typeof v.layerPointToLatLng === 'function'
            && typeof v.addLayer === 'function'
            && typeof v.removeLayer === 'function'
            && typeof v.getContainer === 'function';
    }
    function patchLeafletMap() {
        if (leafletPatched) return;
        const L = composerGetL();
        if (!L || !L.Map) return;
        try {
            ['initialize', 'getPane', 'addLayer', 'setView', '_animateZoom'].forEach(m => {
                if (typeof L.Map.prototype[m] !== 'function') return;
                const orig = L.Map.prototype[m];
                L.Map.prototype[m] = function(...a) {
                    try { if (this && this._container && !this._container.__aim_map__) this._container.__aim_map__ = this; } catch (e) {}
                    return orig.apply(this, a);
                };
            });
            leafletPatched = true;
        } catch (e) {}
    }
    function getLeafletMap() {
        if (leafletMapRef && leafletMapRef._container && document.body.contains(leafletMapRef._container)) return leafletMapRef;
        leafletMapRef = null;
        for (const c of document.querySelectorAll('.leaflet-container')) {
            if (composerLooksLikeMap(c.__aim_map__)) { leafletMapRef = c.__aim_map__; return leafletMapRef; }
            try { for (const k of Object.getOwnPropertyNames(c)) { try { const v = c[k]; if (composerLooksLikeMap(v)) { leafletMapRef = v; return v; } } catch (e) {} } } catch (e) {}
            for (const k in c) { try { const v = c[k]; if (composerLooksLikeMap(v)) { leafletMapRef = v; return v; } } catch (e) {} }
        }
        return null;
    }

    // ── Edit a Navigate's order number → move the whole stop there ──
    // A "stop" = the navigate + every step until the next navigate (its
    // snapshots + their scan steps), so snapshots auto-follow.
    function composerCurrentOrdered() {
        if (!composerMission) return [];
        const byId = {}; (composerMission.instructions || []).forEach(x => { byId[String(x.id)] = x; });
        return composerDomIds().map(id => byId[id]).filter(Boolean);
    }
    function composerNavGroups(ordered) {
        const groups = []; let cur = null;
        ordered.forEach(s => {
            if (s.type_name === 'navigate') { cur = { navId: String(s.id), ids: [String(s.id)] }; groups.push(cur); }
            else if (cur) cur.ids.push(String(s.id));
        });
        return groups;
    }
    // Move nav-group at index idx above the group at idx-1 (one step up).
    async function composerSwapGroupUp(idx) {
        if (idx <= 0) return;
        const groups = composerNavGroups(composerCurrentOrdered());
        if (idx >= groups.length) return;
        const dest = composerIndexById(groups[idx - 1].ids[0]);
        if (dest >= 0) await composerMoveIdsToIndex(groups[idx].ids, dest);
    }
    // DIAGNOSTIC MODE: while true, a nav-badge edit only LOGS the plan (which
    // reorderInstructions was found + the computed indices) and does NOT touch
    // the mission — so a wrong index basis can't scramble a real mission or
    // crash Percepto's editor (which was forcing a full-page refresh). Flip to
    // false once the logged plan is verified correct. v0.91: ENABLED — the
    // self-reverting probe confirmed card indices + single-call works; the bug
    // was the stale-closure reuse (now fixed by re-fetching per move).
    let composerReorderDebug = false;
    async function composerApplyNavOrder(navId, toNum) {
        if (composerBusy) return;
        const groups = composerNavGroups(composerCurrentOrdered());
        let f = groups.findIndex(g => g.navId === String(navId));
        const t = Math.max(1, Math.min(groups.length, toNum)) - 1;
        if (f < 0 || f === t) return;
        // Resolve the reorder fn + record which fiber path matched (for the log).
        let fn = null, fnWhy = 'no draggable card';
        const card = document.querySelector('[data-rfd-draggable-id]');
        if (card) {
            let node = composerGetFiber(card), depth = 0, found = false;
            while (node && depth < 80 && !found) {
                for (let pi = 0; pi < COMPOSER_REORDER_CANDIDATES.length; pi++) {
                    let cand; try { cand = COMPOSER_REORDER_CANDIDATES[pi](node); } catch (e) {}
                    if (typeof cand === 'function') { fn = cand; fnWhy = `candidate#${pi} @depth${depth}`; found = true; break; }
                }
                node = node.return; depth++;
            }
            if (!fn) fnWhy = `NOT FOUND after ${depth} fiber levels`;
        }
        const domIds = composerDomIds();
        const grpIds = groups[f].ids;
        const grpDomIdx = grpIds.map(id => composerIndexById(id));
        // Flat string (no console expansion needed) + a basis check: the first
        // few draggable ids vs the mission's first/last instruction ids+types,
        // which reveals if the card index is offset from the instruction array
        // (takeoff/returnHome not being cards).
        const instr = composerMission.instructions || [];
        console.log(`${TAG} [composer-reorder] PLAN ` + JSON.stringify({
            nav: navId, fromN: f + 1, toN: t + 1, reorderFn: fnWhy, groups: groups.length,
            domCards: domIds.length, instrCount: instr.length, groupDomIndices: grpDomIdx,
            firstCards: domIds.slice(0, 3), firstInstr: instr.slice(0, 3).map(x => `${x.type_name}#${x.id}`),
            lastInstr: instr.slice(-2).map(x => `${x.type_name}#${x.id}`),
        }));
        if (composerReorderDebug) {
            showToast('Reorder is in DIAGNOSTIC mode — the plan was logged to the console (paste it to me). Paused so it can’t scramble a mission until we confirm it’s safe.', '#ffd54f', 7000);
            return;
        }
        if (!fn) { showToast('Composer: reorder function not found.', '#ff5252', 4000); return; }
        composerBusy = true;
        try {
            while (f > t) { await composerSwapGroupUp(f); f--; }
            while (f < t) { await composerSwapGroupUp(f + 1); f++; }
        } catch (e) { console.warn(`${TAG} [composer] nav reorder failed`, e); }
        composerBusy = false;
        rerenderComposer();
        showToast(`Moved to N${t + 1} — hit SAVE in the editor.`, '#5fff5f', 3500);
    }
    // ── Snapshot reorder: move a snapshot block (snapshot + its scan steps) to
    // a global capture position S#. Within a stop → reorders captures; landing
    // under a different navigate → re-homes it there (for Nav↔Snap spacing).
    function composerSnapBlocks(ordered) {
        const isBlk = t => t === 'cameraSelect' || t === 'gemMode' || t === 'wait';
        const blocks = []; let i = 0;
        while (i < ordered.length) {
            const s = ordered[i];
            if (s && s.type_name === 'snapshot') {
                const b = { snapId: String(s.id), ids: [String(s.id)] };
                i++;
                while (i < ordered.length && ordered[i] && isBlk(ordered[i].type_name)) { b.ids.push(String(ordered[i].id)); i++; }
                blocks.push(b);
            } else i++;
        }
        return blocks;
    }
    async function composerSwapSnapBlockUp(idx) {
        if (idx <= 0) return;
        const blocks = composerSnapBlocks(composerCurrentOrdered());
        if (idx >= blocks.length) return;
        const dest = composerIndexById(blocks[idx - 1].ids[0]);
        if (dest >= 0) await composerMoveIdsToIndex(blocks[idx].ids, dest);
    }
    async function composerApplySnapOrder(snapId, toNum) {
        if (composerBusy) return;
        const blocks = composerSnapBlocks(composerCurrentOrdered());
        let f = blocks.findIndex(b => b.snapId === String(snapId));
        const t = Math.max(1, Math.min(blocks.length, toNum)) - 1;
        if (f < 0 || f === t) return;
        if (!composerFindReorderFn()) { showToast('Composer: reorder function not found.', '#ff5252', 4000); return; }
        composerBusy = true;
        try {
            while (f > t) { await composerSwapSnapBlockUp(f); f--; }
            while (f < t) { await composerSwapSnapBlockUp(f + 1); f++; }
        } catch (e) { console.warn(`${TAG} [composer] snap reorder failed`, e); }
        composerBusy = false;
        rerenderComposer();
        showToast(`Snapshot moved to S${t + 1} — hit SAVE in the editor.`, stepColor('snap'), 3500);
    }

    // Which Nav (by N#, 1-based) a snapshot is currently attached to = the nav
    // group whose steps include it. null if it's before the first nav.
    function composerSnapParentNavNum(snapId) {
        const groups = composerNavGroups(composerCurrentOrdered());
        for (let i = 0; i < groups.length; i++) { if (groups[i].ids.includes(String(snapId))) return i + 1; }
        return null;
    }
    // Re-home a snapshot (its whole block: snapshot + trailing scan steps) under a
    // different Navigate (by N#). It lands as that nav's LAST capture. The snapshot's
    // own GPS/alt is unchanged — only which nav the drone flies to before shooting.
    async function composerAttachSnapToNav(snapId, navNum) {
        if (composerBusy) return;
        const ordered = composerCurrentOrdered();
        const groups = composerNavGroups(ordered);
        const block = composerSnapBlocks(ordered).find(b => b.snapId === String(snapId));
        if (!block || !groups.length) { showToast('Couldn’t resolve the snapshot block.', '#ff9800', 3000); return; }
        const t = Math.max(1, Math.min(groups.length, navNum)) - 1;
        if (composerSnapParentNavNum(snapId) === t + 1) { showToast(`Snapshot is already under N${t + 1}.`, '#9ad', 2500); return; }
        if (!composerFindReorderFn()) { showToast('Composer: reorder function not found.', '#ff5252', 4000); return; }
        // Insert right after the target nav group's last step (so it becomes that
        // nav's last capture). composerMoveIdsToIndex handles the up/down shift.
        const lastId = groups[t].ids[groups[t].ids.length - 1];
        const dest = composerIndexById(lastId) + 1;
        if (dest <= 0) { showToast('Couldn’t locate the target nav.', '#ff9800', 3000); return; }
        composerBusy = true;
        try { await composerMoveIdsToIndex(block.ids, dest); }
        catch (e) { console.warn(`${TAG} [composer] attach-to-nav failed`, e); }
        composerBusy = false;
        rerenderComposer();
        showToast(`Snapshot re-homed under N${t + 1} — hit SAVE in the editor.`, stepColor('snap'), 3500);
    }

    // Inline number editor for a Nav (blue) or Snapshot (pink) badge. For a
    // snapshot it also shows + lets you change which Nav it's attached to.
    function composerEditOrder(kind, id, currentNum, ll) {
        if (composerBusy) return;
        const map = getLeafletMap(); if (!map) return;
        const old = document.getElementById('aim-cmp-num-edit'); if (old) old.remove();
        let pt, rect;
        try { pt = map.latLngToContainerPoint(ll); rect = map.getContainer().getBoundingClientRect(); }
        catch (e) { return; }
        const color = kind === 'nav' ? stepColor('nav') : stepColor('snap');
        const navColor = stepColor('nav');
        const label = kind === 'nav' ? 'N' : 'S';
        const parentNav = kind === 'snap' ? composerSnapParentNavNum(id) : null;
        const wrap = document.createElement('div');
        wrap.id = 'aim-cmp-num-edit';
        wrap.style.cssText = `position:fixed;left:${rect.left + pt.x}px;top:${rect.top + pt.y - 16}px;z-index:2147483640;` +
            `transform:translate(-50%,-100%);background:#0f1216;border:1px solid ${color};border-radius:6px;padding:5px 7px;` +
            'display:flex;flex-direction:column;gap:5px;box-shadow:0 4px 14px rgba(0,0,0,0.6);font-family:sans-serif';
        const inStyle = (c) => `width:48px;background:#1a1f27;border:1px solid ${c};color:#fff;border-radius:3px;padding:2px 4px;font:600 12px sans-serif`;
        wrap.innerHTML =
            `<div style="display:flex;gap:5px;align-items:center;"><span style="color:#9ad;font-size:10px;">${label}${currentNum}→</span>` +
            `<input data-ord type="number" min="1" value="${currentNum}" title="Capture order" style="${inStyle(color)}"></div>` +
            (kind === 'snap'
                ? `<div style="display:flex;gap:5px;align-items:center;"><span style="color:#9ad;font-size:10px;white-space:nowrap;">Nav N${parentNav || '?'}→</span>` +
                  `<input data-nav type="number" min="1" value="${parentNav || ''}" title="Attach this snapshot to a different Navigate (by N#)" style="${inStyle(navColor)}"></div>`
                : '');
        document.body.appendChild(wrap);
        const ordInput = wrap.querySelector('[data-ord]');
        const navInput = wrap.querySelector('[data-nav]');
        ordInput.focus(); ordInput.select();
        const commit = () => {
            const ov = parseInt(ordInput.value, 10);
            const nv = navInput ? parseInt(navInput.value, 10) : NaN;
            wrap.remove();
            // A nav re-home (changed) takes priority; otherwise apply capture order.
            if (navInput && !isNaN(nv) && nv !== parentNav) { composerAttachSnapToNav(id, nv); return; }
            if (!isNaN(ov)) { if (kind === 'nav') composerApplyNavOrder(id, ov); else composerApplySnapOrder(id, ov); }
        };
        const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { wrap.remove(); } };
        ordInput.onkeydown = onKey; if (navInput) navInput.onkeydown = onKey;
        const blurClose = () => { setTimeout(() => { const w = document.getElementById('aim-cmp-num-edit'); if (w && !w.contains(document.activeElement)) w.remove(); }, 150); };
        ordInput.onblur = blurClose; if (navInput) navInput.onblur = blurClose;
    }

    function ensureEditorCollapseStyle(on) {
        const existing = document.getElementById(EDITOR_COLLAPSE_STYLE_ID);
        if (!on) { if (existing) existing.remove(); return; }
        if (existing) return;
        const st = document.createElement('style');
        st.id = EDITOR_COLLAPSE_STYLE_ID;
        // COMPACT VIEW: hide each card's detail block (altitude/velocity/GPS
        // rows) so the card is one line, put the title content-width, and let
        // our injected value sit on the right. Card stays a real draggable box.
        st.textContent = `
            /* Cap the draggable WRAPPER (the visible tile) to its title row, so
               there's no dead space inside the tile. The wrapper's MARGIN (the
               between-step drag-to-insert gap) is outside the box → untouched. */
            [data-rfd-draggable-id].aim-mb-compact { max-height:38px !important; overflow:hidden !important; }
            [data-rfd-draggable-id].aim-mb-compact .mission-instruction-item { max-height:38px !important; min-height:0 !important; overflow:hidden !important; padding-top:0 !important; padding-bottom:0 !important; }
            [data-rfd-draggable-id].aim-mb-compact .mission-instruction-item__params { display:none !important; }
            [data-rfd-draggable-id].aim-mb-compact .mission-instruction-item__top { padding:0 !important; }
            [data-rfd-draggable-id].aim-mb-compact .mission-instruction-item__header { padding-top:6px !important; padding-bottom:6px !important; }
            [data-rfd-draggable-id].aim-mb-compact .mission-instruction-item__title { flex:0 0 auto !important; }
            [data-rfd-draggable-id].aim-mb-compact-renamed .mission-instruction-item__title__name { display:none !important; }
            .aim-mb-cx-name { font-weight:800; white-space:nowrap; margin-left:2px; }
            .aim-mb-cx-val { flex:1; text-align:right; font-weight:800; font-size:13px; white-space:nowrap; padding-right:10px; }
        `;
        (document.head || document.documentElement).appendChild(st);
    }
    function compactAltFt(m) { return typeof m === 'number' ? `${Math.round(m * 3.28084).toLocaleString()} ft` : ''; }
    // Altitude shown on a nav/snap compact card: AGL (value1 − DEM ground) when
    // the AGL view is on (falls back to MSL + triggers a DEM fetch until ground
    // is cached), else MSL (stored value1). Suffix tells you which you're seeing.
    function compactAltDisplay(instr) {
        const m = instr.value1;
        if (typeof m !== 'number') return '';
        const msl = `${Math.round(m * 3.28084).toLocaleString()} ft MSL`;
        if (!showAglInEditor) return msl;
        const g = stepElevM(instr);
        if (g == null) { // ground not cached yet — kick a fetch, show MSL meanwhile
            if (instr.location && instr.location.lat != null) { try { fetchElevation(instr.location.lat, instr.location.lng); } catch (e) {} }
            return msl;
        }
        return `${Math.round((m - g) * 3.28084).toLocaleString()} ft AGL`;
    }

    // Compact ONE card: hide its detail rows (via the class) and inject the key
    // value inline — Navigate/Snapshot=altitude (blue/pink), Wait=Ns (white),
    // Camera Type→Thermal On/Off (orange), GEM Mode→GEM On/Off (green).
    function applyCompactCard(card, instr) {
        const header = card.querySelector('.mission-instruction-item__header');
        const titleEl = card.querySelector('.mission-instruction-item__title');
        if (!header || !titleEl) return;
        const t = instr.type_name;
        let valText = null, valColor = '#cfe', titleColor = null, renameText = null, renameColor = '#fff';
        if (t === 'navigate') { valText = compactAltDisplay(instr); valColor = stepColor('nav'); titleColor = stepColor('nav'); }
        else if (t === 'snapshot') { valText = compactAltDisplay(instr); valColor = stepColor('snap'); titleColor = stepColor('snap'); }
        else if (t === 'wait') { valText = `${Math.round(Number(instr.value1) || 0)}s`; valColor = stepColor('wait'); titleColor = stepColor('wait'); }
        else if (t === 'cameraSelect') { renameText = instr.value1 ? 'Thermal On' : 'Thermal Off'; renameColor = instr.value1 ? stepColor('thermalOn') : stepColor('thermalOff'); }
        else if (t === 'gemMode') { const on = Number(instr.value1) === 1; renameText = on ? 'GEM On' : 'GEM Off'; renameColor = on ? stepColor('gemOn') : stepColor('gemOff'); }
        else { card.classList.remove('aim-mb-compact-renamed'); return; }

        // Color the native title name (Navigate=blue, Snapshot=pink).
        const nameEl = titleEl.querySelector('.mission-instruction-item__title__name');
        if (nameEl) nameEl.style.color = titleColor || '';

        if (renameText != null) {
            card.classList.add('aim-mb-compact-renamed');
            let r = titleEl.querySelector('.aim-mb-cx-name');
            if (!r) { r = document.createElement('span'); r.className = 'aim-mb-cx-name'; titleEl.appendChild(r); }
            if (r.textContent !== renameText) r.textContent = renameText;
            r.style.color = renameColor;
            const v = header.querySelector('.aim-mb-cx-val'); if (v) v.remove();
        } else {
            card.classList.remove('aim-mb-compact-renamed');
            let v = header.querySelector('.aim-mb-cx-val');
            if (!v) {
                v = document.createElement('div'); v.className = 'aim-mb-cx-val';
                const opts = header.querySelector('.mission-instruction-item__options');
                if (opts) header.insertBefore(v, opts); else header.appendChild(v);
            }
            if (v.textContent !== (valText || '')) v.textContent = valText || '';
            v.style.color = valColor;
            const r = titleEl.querySelector('.aim-mb-cx-name'); if (r) r.remove();
        }
    }

    // Apply / remove the compact view across the native editor's instruction
    // cards. Needs the mission data (composerMission) for the inline values;
    // when it isn't loaded yet, leave cards full (the interval re-runs once the
    // map-badge path has loaded the mission). Keeps native drag-drop intact.
    function applyNativeEditorCollapse() {
        if (CONTEXT !== 'IFRAME') return;
        const cards = document.querySelectorAll('[data-rfd-draggable-id]');
        const off = () => {
            ensureEditorCollapseStyle(false);
            cards.forEach(c => { c.classList.remove('aim-mb-compact', 'aim-mb-compact-renamed'); c.querySelectorAll('.aim-mb-cx-name,.aim-mb-cx-val').forEach(x => x.remove()); });
        };
        if (!collapseEditorCards) { off(); return; }
        if (!document.querySelector('.mission-edit__content') || !cards.length) return;
        if (!composerMission) { off(); return; } // wait for the mission to load
        ensureEditorCollapseStyle(true);
        const byId = {}; (composerMission.instructions || []).forEach(x => { byId[String(x.id)] = x; });
        cards.forEach(card => {
            const instr = byId[card.getAttribute('data-rfd-draggable-id')];
            if (!instr) return;
            card.classList.add('aim-mb-compact');
            applyCompactCard(card, instr);
        });
    }

    // Log the distinct instruction-marker icon filenames once, so we can
    // extend REDUNDANT_MARKER_SRCS with the exact Thermal + Wait names
    // without risking the Snapshot (camera) icon.
    function logMarkerIconSrcs(doc) {
        if (loggedMarkerSrcs) return;
        const imgs = doc.querySelectorAll('.instruction-marker img[src]');
        if (!imgs.length) return;
        const names = new Set();
        imgs.forEach(i => {
            const src = i.getAttribute('src') || '';
            const file = src.split('/').pop();
            if (file) names.add(file);
        });
        if (names.size) {
            loggedMarkerSrcs = true;
            console.log(`${TAG} [map-icons] distinct instruction-marker icons on this map:`, Array.from(names).sort());
        }
    }

    // Inject/refresh the CSS that hides redundant scan-block markers. Pure
    // CSS :has() so it auto-applies to markers Leaflet re-creates on zoom/pan.
    function applyMapIconDeclutter(doc) {
        logMarkerIconSrcs(doc);
        const STYLE_ID = 'aim-mb-map-declutter';
        const existing = doc.getElementById(STYLE_ID);
        if (!hideScanIcons) { if (existing) existing.remove(); return; }
        const css = REDUNDANT_MARKER_SRCS
            .map(sub => `.instruction-marker:has(img[src*="${sub}"]){display:none!important;}`)
            .join('\n');
        if (existing) { if (existing.textContent !== css) existing.textContent = css; return; }
        const st = doc.createElement('style');
        st.id = STYLE_ID;
        st.textContent = css;
        (doc.head || doc.documentElement).appendChild(st);
    }

    function hideSumButton() {
        try {
            document.querySelectorAll(`#${SUM_BTN_ID}`).forEach(el => el.remove());
            document.querySelectorAll(`#${TOOLBAR_ROW_ID}`).forEach(el => el.remove());
            document.querySelectorAll(`#${LOG_SUM_BTN_ID}`).forEach(el => el.remove());
        } catch (e) {}
    }

    // ========================================================
    // Right-click mission inspector (v0.6)
    // ========================================================
    // One delegated listener on the iframe document. Survives React
    // rebuilds of `ul.missions-list__items`. Plain right-click on a
    // mission row opens our popup; Shift+right-click falls through to
    // Chrome's native menu so coworkers can still "Open in New Tab".
    let rclickHandlerInstalled = false;

    function installRightClickHandler() {
        if (CONTEXT !== 'IFRAME') return;
        if (rclickHandlerInstalled) return;
        rclickHandlerInstalled = true;
        document.addEventListener('contextmenu', onRightClick, true);
        dlog(`${TAG} right-click mission inspector armed`);
    }

    function onRightClick(e) {
        if (!masterEnabled) return;
        if (e.shiftKey) return; // bypass — user wants Chrome's native menu
        if (!isOnMissionBank()) return;
        const row = e.target.closest && e.target.closest(MISSION_ROW_SELECTOR);
        if (!row) return;
        const link = row.querySelector(MISSION_LINK_SELECTOR) || row.querySelector('a[href]');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        const m = href.match(MISSION_HREF_RE);
        if (!m) return;
        const missionId = Number(m[1]);
        e.preventDefault();
        e.stopPropagation();
        openRightClickPopup(missionId, link.textContent.trim(), e.clientX, e.clientY);
    }

    function openRightClickPopup(missionId, fallbackName, x, y) {
        const siteID = getCurrentSiteID();
        if (!siteID) return;
        // Render shell immediately so the popup feels snappy; data fills
        // in when fetch (if any) returns.
        renderRightClickPopup({ id: missionId, name: fallbackName, _loading: true }, x, y);
        const bucket = missionsBySite[siteID];
        if (bucket) {
            const m = bucket.missions.find(mm => mm.id === missionId);
            if (m) {
                renderRightClickPopup(buildMissionRow(m), x, y);
                return;
            }
        }
        // Cold cache — fetch then re-render. Subsequent right-clicks
        // hit the cache and skip the network entirely.
        fetchMissions(siteID,
            (arr) => {
                const m = arr.find(mm => mm.id === missionId);
                if (!m) {
                    renderRightClickPopup({ id: missionId, name: fallbackName, _notFound: true }, x, y);
                } else {
                    renderRightClickPopup(buildMissionRow(m), x, y);
                }
            },
            (err) => renderRightClickPopup({ id: missionId, name: fallbackName, _error: err }, x, y)
        );
    }

    function closeRightClickPopup() {
        const el = document.getElementById(RCLICK_POPUP_ID);
        if (el) el.remove();
    }

    function renderRightClickPopup(row, x, y) {
        ensureRightClickPopupStyles();
        closeRightClickPopup();
        const pop = document.createElement('div');
        pop.id = RCLICK_POPUP_ID;
        const thresholds = getFlightThresholds();
        const unit = getDistanceUnit();
        let bodyHtml = '';
        if (row._loading) {
            bodyHtml = `<div style="padding:18px;text-align:center;color:#888;font-size:11px;">Loading mission ${row.id}…</div>`;
        } else if (row._notFound) {
            bodyHtml = `<div style="padding:18px;text-align:center;color:#ff5252;font-size:11px;">Mission ${row.id} not found on this site.</div>`;
        } else if (row._error) {
            bodyHtml = `<div style="padding:18px;text-align:center;color:#ff5252;font-size:11px;">Failed to load: ${escapeHtml(row._error)}</div>`;
        } else {
            const orderedCounts = buildOrderedStepCounts(row.realSteps);
            const typeCardsHtml = orderedCounts
                .map(([k, v]) => statCompact(k, v, String(v)))
                .join('') || '<div style="color:#888;font-size:10px;">No real steps.</div>';
            bodyHtml = `
                <div class="aim-mb-rc-card">
                    <div class="aim-mb-rc-card-title">Mission Stats</div>
                    <div class="aim-mb-rc-grid">
                        ${statCompact('Distance', fmtDistance(row.flightDistanceM, unit), fmtDistance(row.flightDistanceM, unit))}
                        ${statCompact('Flight Time', fmtTime(row.flightTimeS), fmtTime(row.flightTimeS))}
                        ${statCompact('Steps', row.steps, String(row.steps))}
                        ${statCompact('Battery %', fmtPct(row.batteryConsumption), fmtPct(row.batteryConsumption))}
                        ${statCompact('Est. Flights', estimateFlights(row.batteryConsumption, thresholds), String(estimateFlights(row.batteryConsumption, thresholds)))}
                        ${statCompact('Total Cons %', fmtPct(row.totalConsumption), fmtPct(row.totalConsumption))}
                    </div>
                </div>
                <div class="aim-mb-rc-card">
                    <div class="aim-mb-rc-card-title">Flight Phase Breakdown</div>
                    <div class="aim-mb-rc-grid">
                        ${statCompact('Takeoff', `${fmtTime(row.takeoffTimeS)} · ${fmtPct(row.takeoffConsumption)}`)}
                        ${statCompact('Navigate', `${fmtTime(row.navTimeS)} · ${fmtPct(row.navConsumption)}`)}
                        ${statCompact('Wait', `${fmtTime(row.waitTimeS)} · ${fmtPct(row.waitConsumption)}`)}
                        ${statCompact('Extra', `${fmtTime(row.extraTimeS)} · ${fmtPct(row.extraConsumption)}`)}
                        ${statCompact('Landing', `${fmtTime(row.landingTimeS)} · ${fmtPct(row.landingConsumption)}`)}
                    </div>
                </div>
                <div class="aim-mb-rc-card">
                    <div class="aim-mb-rc-card-title">Step Counts (excl. takeoff + return)</div>
                    <div class="aim-mb-rc-grid">${typeCardsHtml}</div>
                </div>
                ${row.description ? `<div class="aim-mb-rc-meta">Description: ${escapeHtml(row.description)}</div>` : ''}
            `;
        }
        const activeBadge = row.active === false
            ? `<span style="color:#888;font-size:10px;margin-left:8px;">Inactive</span>`
            : (row.active === true
                ? `<span class="aim-mb-dot active" style="margin-left:8px;" title="Active"></span>`
                : '');
        pop.innerHTML = `
            <div class="aim-mb-rc-head">
                <div class="aim-mb-rc-title">${escapeHtml(row.name || 'Mission')}${activeBadge}</div>
                <button class="aim-mb-rc-copy-name" data-rc-copy-name="${escapeHtml(row.name || '')}" title="Copy mission name">📋</button>
                <div class="aim-mb-rc-id">ID ${row.id}</div>
                <button class="aim-mb-rc-close" data-rc-close title="Close">✕</button>
            </div>
            <div class="aim-mb-rc-body">${bodyHtml}</div>
            <div class="aim-mb-rc-footer">
                <button class="aim-mb-tbtn" data-rc-open-sum>Open in SUM →</button>
            </div>
        `;
        document.body.appendChild(pop);
        positionRightClickPopup(pop, x, y);
        wireRightClickPopupEvents(pop, row.id);
    }

    function statCompact(label, value, copyVal) {
        const hasCopy = copyVal != null && copyVal !== 'null' && copyVal !== 'undefined' && copyVal !== '—';
        const cls = hasCopy ? 'aim-mb-rc-stat aim-mb-rc-stat-clickable' : 'aim-mb-rc-stat';
        const copyAttr = hasCopy ? `data-rc-copy="${escapeHtml(String(copyVal))}"` : '';
        const title = hasCopy ? ' title="Click to copy"' : '';
        return `<div class="${cls}" ${copyAttr}${title}><div class="aim-mb-rc-stat-label">${escapeHtml(label)}</div><div class="aim-mb-rc-stat-value">${escapeHtml(String(value))}</div></div>`;
    }

    function positionRightClickPopup(pop, x, y) {
        // Clamp to viewport with an 8px margin
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rect = pop.getBoundingClientRect();
        let left = x + 6;
        let top = y + 6;
        if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
        if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
        if (left < 8) left = 8;
        if (top < 8) top = 8;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
    }

    function wireRightClickPopupEvents(pop, missionId) {
        // Close X
        const closeBtn = pop.querySelector('[data-rc-close]');
        if (closeBtn) closeBtn.onclick = closeRightClickPopup;
        // Copy name
        const copyNameBtn = pop.querySelector('[data-rc-copy-name]');
        if (copyNameBtn) copyNameBtn.onclick = () => {
            const name = copyNameBtn.dataset.rcCopyName;
            if (name) { copyToClipboard(name); showToast(`Copied: ${name}`, '#5fff5f'); }
        };
        // "Open in SUM" — opens panel + drills into the mission
        const openBtn = pop.querySelector('[data-rc-open-sum]');
        if (openBtn) openBtn.onclick = () => {
            closeRightClickPopup();
            openPanelAndDrill(missionId);
        };
        // Click-to-copy stat cards
        pop.querySelectorAll('[data-rc-copy]').forEach(el => {
            el.onclick = () => {
                const v = el.dataset.rcCopy;
                if (!v) return;
                copyToClipboard(v);
                showToast(`Copied: ${v}`, '#5fff5f');
            };
        });
        // Draggable by header
        const head = pop.querySelector('.aim-mb-rc-head');
        if (head) makeRClickPopupDraggable(pop, head);
        // Outside click closes (mousedown so it fires before next contextmenu)
        setTimeout(() => {
            const onDoc = (e) => {
                if (!pop.contains(e.target)) {
                    pop.remove();
                    document.removeEventListener('mousedown', onDoc, true);
                }
            };
            document.addEventListener('mousedown', onDoc, true);
        }, 0);
        // Esc closes
        const onKey = (e) => {
            if (e.key === 'Escape') {
                pop.remove();
                document.removeEventListener('keydown', onKey, true);
            }
        };
        document.addEventListener('keydown', onKey, true);
    }

    function makeRClickPopupDraggable(el, handle) {
        let startX, startY, startLeft, startTop, dragging = false, pid = null;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true; pid = e.pointerId;
            startX = e.clientX; startY = e.clientY;
            const rect = el.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            try { handle.setPointerCapture(pid); } catch (er) {}
            e.preventDefault();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!dragging || e.pointerId !== pid) return;
            el.style.left = `${startLeft + e.clientX - startX}px`;
            el.style.top = `${startTop + e.clientY - startY}px`;
        });
        const stop = (e) => {
            if (e && e.pointerId !== pid) return;
            dragging = false;
            try { handle.releasePointerCapture(pid); } catch (er) {}
        };
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
    }

    // Open SUM panel and immediately jump to the drill-down view for a
    // specific mission. If data is cold the panel shows its own loading
    // state then renders the drill-down once missions arrive.
    function openPanelAndDrill(missionId) {
        const siteID = getCurrentSiteID();
        if (!siteID) return;
        if (!panelState) initPanelState();
        if (!panelEl) buildPanelChrome();
        panelEl.style.display = 'flex';
        if (panelGeom.snap) snapPanel(panelGeom.snap); // re-fit dock to current map size
        const bucket = missionsBySite[siteID];
        const goDrill = () => {
            // Confirm the mission exists in the loaded set; if not,
            // fall back to the table view.
            const rows = buildAllRows(siteID);
            if (rows.find(r => r.id === missionId)) renderDetailView(missionId);
            else renderTableView();
        };
        if (!bucket) {
            renderLoadingState();
            fetchMissions(siteID, goDrill, (err) => renderErrorState(err));
        } else {
            goDrill();
        }
    }

    function ensureRightClickPopupStyles() {
        if (document.getElementById('aim-mb-rclick-styles')) return;
        const style = document.createElement('style');
        style.id = 'aim-mb-rclick-styles';
        style.textContent = `
            #${RCLICK_POPUP_ID} { position: fixed; min-width: 320px; max-width: 420px; max-height: 80vh; overflow: auto; background: #0f1216; color: #e6e6e6; border: 1px solid #14d2dc; border-radius: 6px; box-shadow: 0 8px 28px rgba(0,0,0,0.7); z-index: 100002; font-family: 'Lato','Segoe UI',sans-serif; font-size: 11px; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-head { background: #14d2dc; color: #000; padding: 6px 10px; display: flex; align-items: center; gap: 8px; cursor: move; user-select: none; border-radius: 5px 5px 0 0; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-title { flex: 1; font-weight: 700; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-id { font-size: 10px; color: rgba(0,0,0,0.7); font-weight: 600; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-copy-name { background: rgba(0,0,0,0.15); border: none; color: #000; font-size: 11px; cursor: pointer; padding: 1px 5px; border-radius: 3px; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-copy-name:hover { background: rgba(0,0,0,0.3); }
            #${RCLICK_POPUP_ID} .aim-mb-rc-close { background: transparent; border: none; color: #000; font-size: 14px; cursor: pointer; font-weight: 700; padding: 0 4px; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-close:hover { color: #800; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-body { padding: 10px; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-card-title { font-size: 9px; text-transform: uppercase; color: #14d2dc; letter-spacing: 0.1em; margin-bottom: 6px; font-weight: 700; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 6px; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-stat { background: #0f1216; border-radius: 3px; padding: 5px 7px; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-stat-clickable { cursor: pointer; transition: background 0.1s; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-stat-clickable:hover { background: #181c22; outline: 1px solid #14d2dc; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-stat-label { font-size: 9px; color: #888; text-transform: uppercase; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-stat-value { font-size: 12px; color: #fff; font-weight: 700; margin-top: 1px; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-meta { color: #aaa; font-size: 10px; padding: 6px 10px; }
            #${RCLICK_POPUP_ID} .aim-mb-rc-footer { padding: 8px 10px; border-top: 1px solid #2a2a2a; display: flex; justify-content: flex-end; }
            #${RCLICK_POPUP_ID} .aim-mb-tbtn { background: #2a2a2a; border: 1px solid #444; color: #e6e6e6; padding: 4px 12px; font-size: 11px; cursor: pointer; border-radius: 3px; font-weight: 600; }
            #${RCLICK_POPUP_ID} .aim-mb-tbtn:hover { border-color: #14d2dc; color: #14d2dc; }
            #${RCLICK_POPUP_ID} .aim-mb-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
            #${RCLICK_POPUP_ID} .aim-mb-dot.active { background: #5fff5f; }
        `;
        document.head.appendChild(style);
    }

    // ========================================================
    // Panel — open/close + state
    // ========================================================
    function openPanel(mode) {
        mode = mode || 'bank';
        const siteID = getCurrentSiteID();
        if (!siteID) { showToast('No site loaded.', '#ff5252'); return; }
        // (Re)init when opening fresh or switching surfaces between opens.
        if (!panelState || panelState.mode !== mode) initPanelState(mode);
        if (!panelEl) buildPanelChrome();
        panelEl.style.display = 'flex';
        if (panelGeom.snap) snapPanel(panelGeom.snap); // re-fit dock to current map size
        if (mode === 'log') {
            const bucket = logBySite[siteID];
            if (!bucket) {
                renderLoadingState();
                fetchMissionLog(siteID, () => renderTableView(), (err) => renderErrorState(err));
            } else {
                renderTableView();
            }
            return;
        }
        const bucket = missionsBySite[siteID];
        if (!bucket) {
            renderLoadingState();
            fetchMissions(siteID,
                () => renderTableView(),
                (err) => renderErrorState(err)
            );
        } else {
            renderTableView();
        }
    }

    function closePanel() {
        if (panelEl) panelEl.style.display = 'none';
        closeOpenMenus();
        panelState = null;
    }

    function initPanelState(mode) {
        mode = mode || 'bank';
        panelState = {
            mode,
            sortKey: mode === 'log' ? 'timeCT' : 'flightDistance', // log: newest first
            sortDir: 'desc',
            search: '',
            selectedIds: new Set(),
            distanceUnit: getDistanceUnit(),
            drillId: null,
            tableScrollY: 0,
            thresholds: getFlightThresholds(),
        };
    }

    // ========================================================
    // Panel chrome (drag/resize/header/body/footer)
    // ========================================================
    function buildPanelChrome() {
        // Style injection (idempotent)
        if (!document.getElementById('aim-mb-styles')) {
            const style = document.createElement('style');
            style.id = 'aim-mb-styles';
            style.textContent = `
                #${PANEL_ID} { font-family: 'Lato','Segoe UI',sans-serif; color: #e6e6e6; }
                /* Header: green centered title on a subtle dark bar, matching the Site Setup SUM look/feel. */
                #${PANEL_ID} .aim-mb-header { background: rgba(95,255,95,0.06); color: #5fff5f; padding: 8px 12px; cursor: move; display: flex; align-items: center; gap: 8px; user-select: none; border-bottom: 1px solid rgba(255,255,255,0.08); border-radius: 6px 6px 0 0; flex-shrink: 0; }
                #${PANEL_ID} .aim-mb-header-title { font-weight: 700; font-size: 13px; flex: 1; text-align: left; color: #5fff5f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                #${PANEL_ID} .aim-mb-header-btn { background: rgba(95,255,95,0.12); border: 1px solid rgba(95,255,95,0.4); color: #5fff5f; padding: 2px 8px; font-size: 11px; border-radius: 3px; cursor: pointer; font-weight: 600; }
                #${PANEL_ID} .aim-mb-header-btn:hover { background: rgba(95,255,95,0.25); }
                /* Body is a flex column so toolbar + footer stay pinned and only the table scrolls. */
                #${PANEL_ID} .aim-mb-body { flex: 1; overflow: hidden; background: #0f1216; display: flex; flex-direction: column; }
                #${PANEL_ID} .aim-mb-toolbar { background: #1a1a1a; padding: 6px 10px; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex-shrink: 0; }
                #${PANEL_ID} .aim-mb-search { flex: 1; min-width: 180px; background: #0f1216; border: 1px solid #444; color: #e6e6e6; padding: 4px 8px; font-size: 12px; border-radius: 3px; outline: none; }
                #${PANEL_ID} .aim-mb-search:focus { border-color: #14d2dc; }
                #${PANEL_ID} .aim-mb-tbtn { background: #2a2a2a; border: 1px solid #444; color: #e6e6e6; padding: 3px 10px; font-size: 11px; cursor: pointer; border-radius: 3px; font-weight: 600; }
                #${PANEL_ID} .aim-mb-tbtn:hover { border-color: #14d2dc; color: #14d2dc; }
                #${PANEL_ID} .aim-mb-tbtn.active { background: #14d2dc; color: #000; border-color: #14d2dc; }
                #${PANEL_ID} .aim-mb-table-wrap { flex: 1; overflow: auto; background: #0f1216; }
                #${PANEL_ID} table { width: 100%; border-collapse: collapse; font-size: 11px; }
                #${PANEL_ID} thead { background: #1a1a1a; position: sticky; top: 0; z-index: 1; }
                #${PANEL_ID} th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #444; cursor: pointer; user-select: none; white-space: nowrap; font-weight: 600; color: #aaa; }
                #${PANEL_ID} th:hover { color: #14d2dc; }
                #${PANEL_ID} th.sorted { color: #14d2dc; }
                #${PANEL_ID} td { padding: 5px 8px; border-bottom: 1px solid #1f1f1f; }
                #${PANEL_ID} tbody tr { cursor: pointer; }
                #${PANEL_ID} tbody tr:nth-child(odd) { background: #0f1216; }
                #${PANEL_ID} tbody tr:nth-child(even) { background: #151a20; }
                #${PANEL_ID} tbody tr:hover { background: #1e2228; }
                #${PANEL_ID} tbody tr.selected { background: rgba(20,210,220,0.15); }
                #${PANEL_ID} .aim-mb-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
                #${PANEL_ID} .aim-mb-dot.active { background: #5fff5f; }
                #${PANEL_ID} .aim-mb-dot.inactive { background: #555; }
                #${PANEL_ID} .aim-mb-footer { background: #1a1a1a; padding: 6px 10px; border-top: 1px solid #2a2a2a; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex-shrink: 0; }
                #${PANEL_ID} .aim-mb-info { color: #aaa; font-size: 11px; flex: 1; }
                #${PANEL_ID} .aim-mb-resize { position: absolute; bottom: 0; right: 0; width: 14px; height: 14px; cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, #14d2dc 50%); border-radius: 0 0 6px 0; opacity: 0.5; touch-action: none; }
                #${PANEL_ID} .aim-mb-resize:hover { opacity: 1; }
                /* Detail view */
                #${PANEL_ID} .aim-mb-detail-header { background: #1a1a1a; padding: 10px 14px; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
                #${PANEL_ID} .aim-mb-detail-back { background: #2a2a2a; border: 1px solid #444; color: #14d2dc; padding: 4px 12px; cursor: pointer; border-radius: 3px; font-weight: 600; font-size: 12px; }
                #${PANEL_ID} .aim-mb-detail-back:hover { background: #14d2dc; color: #000; }
                #${PANEL_ID} .aim-mb-detail-title { flex: 1; font-size: 14px; font-weight: 700; color: #fff; }
                #${PANEL_ID} .aim-mb-detail-id { color: #888; font-size: 11px; }
                #${PANEL_ID} .aim-mb-detail-body { padding: 14px; overflow: auto; flex: 1; }
                #${PANEL_ID} .aim-mb-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; }
                #${PANEL_ID} .aim-mb-card-title { font-size: 10px; text-transform: uppercase; color: #14d2dc; letter-spacing: 0.1em; margin-bottom: 8px; font-weight: 700; }
                #${PANEL_ID} .aim-mb-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
                #${PANEL_ID} .aim-mb-stat { background: #0f1216; border-radius: 4px; padding: 8px 10px; }
                #${PANEL_ID} .aim-mb-stat-clickable { cursor: pointer; transition: background 0.1s; }
                #${PANEL_ID} .aim-mb-stat-clickable:hover { background: #181c22; outline: 1px solid #14d2dc; }
                #${PANEL_ID} .aim-mb-stat-label { font-size: 10px; color: #888; text-transform: uppercase; }
                #${PANEL_ID} .aim-mb-stat-value { font-size: 16px; color: #fff; font-weight: 700; margin-top: 2px; }
                #${PANEL_ID} .aim-mb-step-nav { color: #2dd4bf; font-weight: 700; }
                #${PANEL_ID} .aim-mb-step-snap { color: #ff9800; font-weight: 700; }
                #${PANEL_ID} .aim-mb-loc { cursor: pointer; color: #fff; text-decoration: underline; }
                #${PANEL_ID} .aim-mb-loc:hover { color: #14d2dc; }
                #${PANEL_ID} .aim-mb-latlng { cursor: pointer; color: #cdd6e0; }
                #${PANEL_ID} .aim-mb-latlng:hover { color: #14d2dc; }
                #${PANEL_ID} .aim-mb-gps { cursor: pointer; color: #8ab4f8; text-decoration: underline; white-space: nowrap; }
                #${PANEL_ID} .aim-mb-gps:hover { color: #14d2dc; }
                #${PANEL_ID} .aim-mb-step-focus { cursor: pointer; font-size: 12px; opacity: 0.6; }
                #${PANEL_ID} .aim-mb-step-focus:hover { opacity: 1; }
                #${PANEL_ID} .aim-mb-step-edit { cursor: pointer; font-size: 12px; opacity: 0.6; }
                #${PANEL_ID} .aim-mb-step-edit:hover { opacity: 1; }
                #${PANEL_ID} .aim-mb-elev { cursor: pointer; color: #c4b5fd; font-weight: 600; }
                #${PANEL_ID} .aim-mb-elev:hover { color: #ddd6fe; text-decoration: underline; }
                #${PANEL_ID} .aim-mb-elev-loading, #${PANEL_ID} .aim-mb-agl-loading { color: #555; font-style: italic; }
                #${PANEL_ID} .aim-mb-agl { cursor: pointer; font-weight: 700; }
                #${PANEL_ID} .aim-mb-agl-low { color: #ff5252; }
                #${PANEL_ID} .aim-mb-agl-ok { color: #5fff5f; }
                #${PANEL_ID} .aim-mb-agl-high { color: #3399ff; }
                #${PANEL_ID} .aim-mb-agl-editable { border-bottom: 1px dotted #555; }
                #${PANEL_ID} .aim-mb-agl-editable:hover { border-bottom-color: #14d2dc; }
                #${PANEL_ID} .aim-mb-alt-editable { cursor: pointer; border-bottom: 1px dotted #555; }
                #${PANEL_ID} .aim-mb-alt-editable:hover { color: #14d2dc; border-bottom-color: #14d2dc; }
                #${PANEL_ID} .aim-mb-alt-pending { cursor: pointer; background: #ff9800; color: #000; padding: 1px 6px; border-radius: 3px; font-weight: 700; }
                #${PANEL_ID} .aim-mb-alt-pending:hover { background: #ffb84d; }
                #${PANEL_ID} .aim-mb-alt-committed { color: #ffeb3b; font-weight: 700; margin-left: 4px; }
                #${PANEL_ID} .aim-mb-alt-input { width: 80px; background: #0f1216; border: 1px solid #14d2dc; color: #fff; padding: 2px 6px; font-size: 11px; border-radius: 3px; outline: none; }
                #${PANEL_ID} .aim-mb-pending-banner { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: rgba(255,152,0,0.15); border: 1px solid #ff9800; border-radius: 4px; margin-bottom: 8px; color: #ffb84d; font-size: 11px; font-weight: 600; }
                /* Gold "Bulk →" buttons — mirror the Site Setup SUM bulk toolbar. */
                #${PANEL_ID} .aim-mb-bulk-btn { background: #2a2a2a; border: 1px solid rgba(255,213,79,0.55); color: #ffd54f; padding: 3px 10px; font-size: 11px; cursor: pointer; border-radius: 3px; font-weight: 600; white-space: nowrap; }
                #${PANEL_ID} .aim-mb-bulk-btn:hover { background: rgba(255,213,79,0.12); border-color: #ffd54f; }
                #${PANEL_ID} .aim-mb-sel-count { font-size: 11px; color: #ffd54f; white-space: nowrap; font-weight: 600; }
                #${PANEL_ID} td.aim-mb-sel-cell input, #${PANEL_ID} th.aim-mb-sel-cell input { cursor: pointer; margin: 0; }
                .aim-mb-bp-pop { position: fixed; z-index: 100002; min-width: 240px; background: #1f2228; border: 1px solid #14d2dc; border-radius: 6px; box-shadow: 0 4px 20px rgba(0,0,0,0.7); font-family: 'Lato','Segoe UI',sans-serif; color: #e6e6e6; }
                .aim-mb-bp-pop input[type="text"] { background: #0f1216; border: 1px solid #14d2dc; color: #fff; padding: 3px 6px; font-size: 11px; border-radius: 3px; outline: none; }
                /* Floating menus — fixed positioning so they're not clipped by the panel and survive renders. */
                .aim-mb-cols-menu, .aim-mb-settings-popover { position: fixed; background: #1f2228; border: 1px solid #14d2dc; border-radius: 6px; z-index: 100001; box-shadow: 0 4px 20px rgba(0,0,0,0.7); font-family: 'Lato','Segoe UI',sans-serif; color: #e6e6e6; }
                .aim-mb-cols-menu { padding: 0; max-height: 360px; overflow: hidden; display: flex; flex-direction: column; }
                .aim-mb-settings-popover { padding: 0; min-width: 300px; }
                .aim-mb-menu-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #14d2dc; color: #000; border-radius: 5px 5px 0 0; font-weight: 700; font-size: 12px; }
                .aim-mb-menu-head .aim-mb-menu-title { flex: 1; }
                .aim-mb-menu-close { background: transparent; border: none; color: #000; font-size: 14px; cursor: pointer; font-weight: 700; padding: 0 4px; }
                .aim-mb-menu-close:hover { color: #800; }
                .aim-mb-menu-body { padding: 6px; overflow-y: auto; flex: 1; }
                .aim-mb-col-row { display: flex; align-items: center; padding: 2px 8px; font-size: 11px; gap: 4px; }
                .aim-mb-col-row:hover { background: rgba(20,210,220,0.1); }
                .aim-mb-col-row input { margin: 0; flex-shrink: 0; }
                .aim-mb-col-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .aim-mb-col-arrows { display: flex; gap: 1px; flex-shrink: 0; }
                .aim-mb-col-arrows button { background: #2a2a2a; border: 1px solid #444; color: #aaa; font-size: 9px; padding: 0 4px; cursor: pointer; border-radius: 2px; line-height: 16px; }
                .aim-mb-col-arrows button:hover:not([disabled]) { border-color: #14d2dc; color: #14d2dc; }
                .aim-mb-col-arrows button[disabled] { opacity: 0.3; cursor: default; }
                .aim-mb-cols-menu .aim-mb-tbtn { background: #2a2a2a; border: 1px solid #444; color: #e6e6e6; padding: 3px 10px; font-size: 11px; cursor: pointer; border-radius: 3px; font-weight: 600; }
                .aim-mb-cols-menu .aim-mb-tbtn:hover { border-color: #14d2dc; color: #14d2dc; }
                .aim-mb-settings-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; }
                .aim-mb-settings-row input[type="number"] { width: 80px; background: #0f1216; border: 1px solid #444; color: #e6e6e6; padding: 3px 6px; font-size: 11px; border-radius: 3px; outline: none; }
                .aim-mb-settings-row .aim-mb-tbtn { background: #2a2a2a; border: 1px solid #444; color: #e6e6e6; padding: 3px 10px; font-size: 11px; cursor: pointer; border-radius: 3px; font-weight: 600; }
                .aim-mb-settings-row .aim-mb-tbtn:hover { border-color: #14d2dc; color: #14d2dc; }
            `;
            document.head.appendChild(style);
        }

        loadPanelGeom();
        panelEl = document.createElement('div');
        panelEl.id = PANEL_ID;
        const startW = panelGeom.w || 900, startH = panelGeom.h || 600;
        Object.assign(panelEl.style, {
            position: 'fixed',
            width: startW + 'px', height: startH + 'px', minWidth: '500px', minHeight: '300px',
            background: '#0f1216', border: '1px solid #14d2dc', borderRadius: '6px',
            zIndex: '99999', display: 'flex', flexDirection: 'column',
            boxShadow: '0 8px 28px rgba(0,0,0,0.7)',
        });
        // Restore a saved float position, else default to top-right.
        if (typeof panelGeom.x === 'number' && typeof panelGeom.y === 'number') {
            panelEl.style.left = Math.max(0, Math.min(window.innerWidth - 80, panelGeom.x)) + 'px';
            panelEl.style.top = Math.max(0, Math.min(window.innerHeight - 40, panelGeom.y)) + 'px';
        } else {
            panelEl.style.top = '80px';
            panelEl.style.right = '20px';
        }

        // Header (draggable handle) — title, snap-dock buttons, refresh, close.
        const header = document.createElement('div');
        header.className = 'aim-mb-header';
        header.innerHTML = `
            <div class="aim-mb-header-title">📋 Mission Bank Summary — <span data-site></span></div>
            <span class="aim-mb-snap" style="display:flex;align-items:center;gap:1px;margin-right:2px"></span>
            <button class="aim-mb-header-btn" data-refresh title="Re-fetch missions">Refresh</button>
            <button class="aim-mb-header-btn" data-close>✕</button>
        `;
        addSnapButtons(header.querySelector('.aim-mb-snap'));
        panelEl.appendChild(header);
        makeDraggable(panelEl, header);
        header.querySelector('[data-close]').onclick = closePanel;
        header.querySelector('[data-refresh]').onclick = () => {
            const sid = getCurrentSiteID();
            if (!sid) return;
            delete missionsBySite[sid];
            // Clear committed-but-not-refetched markers — server now has truth
            const mids = missionsBySite[sid] ? missionsBySite[sid].missions.map(m => m.id) : Object.keys(committedAltitudes);
            mids.forEach(mid => clearCommittedFor(mid));
            renderLoadingState();
            fetchMissions(sid, () => renderTableView(), (err) => renderErrorState(err));
        };

        // Body (table OR detail view)
        const body = document.createElement('div');
        body.className = 'aim-mb-body';
        body.id = 'aim-mb-body';
        panelEl.appendChild(body);

        // Resize handles — all four edges + four corners (clamped to the map).
        addResizeHandles(panelEl);

        document.body.appendChild(panelEl);

        // Re-apply a saved dock (now that the panel is in the DOM and we can
        // measure the map), else clamp the floating panel into the map region.
        if (panelGeom.snap) snapPanel(panelGeom.snap);
        else clampPanelIntoMap();
        if (!panelResizeBound) {
            panelResizeBound = true;
            window.addEventListener('resize', () => {
                if (panelGeom.snap && panelEl && panelEl.style.display !== 'none') snapPanel(panelGeom.snap);
            });
        }
    }

    // Pointer-event drag: setPointerCapture guarantees we keep receiving
    // pointermove + pointerup even if the cursor leaves the handle (the
    // mouse-event version dropped if the user dragged off the corner).
    function makeDraggable(el, handle) {
        let startX, startY, startLeft, startTop, dragging = false, pointerId = null;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            pointerId = e.pointerId;
            startX = e.clientX; startY = e.clientY;
            const rect = el.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            el.style.right = 'auto'; // switch from right-anchored to left-anchored
            el.style.left = `${startLeft}px`;
            el.style.top = `${startTop}px`;
            try { handle.setPointerCapture(pointerId); } catch (er) {}
            e.preventDefault();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!dragging || e.pointerId !== pointerId) return;
            const c = clampToMap(startLeft + e.clientX - startX, startTop + e.clientY - startY, el.offsetWidth, el.offsetHeight);
            el.style.left = `${c.x}px`;
            el.style.top = `${c.y}px`;
            panelGeom.snap = null; // manual move un-docks
        });
        const stop = (e) => {
            if (e && e.pointerId !== pointerId) return;
            if (!dragging) return;
            dragging = false;
            try { handle.releasePointerCapture(pointerId); } catch (er) {}
            // Persist the new floating position.
            const r = el.getBoundingClientRect();
            panelGeom.x = Math.round(r.left); panelGeom.y = Math.round(r.top);
            panelGeom.w = Math.round(r.width); panelGeom.h = Math.round(r.height);
            savePanelGeom();
        };
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
    }

    function makeResizable(el, handle) {
        let startX, startY, startW, startH, resizing = false, pointerId = null;
        handle.addEventListener('pointerdown', (e) => {
            resizing = true;
            pointerId = e.pointerId;
            startX = e.clientX; startY = e.clientY;
            const rect = el.getBoundingClientRect();
            startW = rect.width; startH = rect.height;
            try { handle.setPointerCapture(pointerId); } catch (er) {}
            e.preventDefault();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!resizing || e.pointerId !== pointerId) return;
            el.style.width = `${Math.max(500, startW + e.clientX - startX)}px`;
            el.style.height = `${Math.max(300, startH + e.clientY - startY)}px`;
        });
        const stop = (e) => {
            if (e && e.pointerId !== pointerId) return;
            if (!resizing) return;
            resizing = false;
            try { handle.releasePointerCapture(pointerId); } catch (er) {}
            const r = el.getBoundingClientRect();
            panelGeom.w = Math.round(r.width); panelGeom.h = Math.round(r.height);
            panelGeom.x = Math.round(r.left); panelGeom.y = Math.round(r.top);
            savePanelGeom();
        };
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
    }

    // ========================================================
    // Panel geometry + snap docking — ported from the Site Setup SUM
    // panel so the two SUMs behave identically: dock to the left / right /
    // bottom of the MAP, float/restore, and persist position+size+snap
    // across opens. Snap targets come from the .leaflet-container region so
    // a side-dock fills the map's edge (not the sidebar).
    // ========================================================
    const PANEL_GEOM_KEY = 'aim-mb-panel-geom';
    const panelGeom = { x: null, y: null, w: 900, h: 600, snap: null, floatRect: null };
    let panelResizeBound = false;
    function loadPanelGeom() {
        const g = gmGet(PANEL_GEOM_KEY, null);
        if (!g || typeof g !== 'object') return;
        if (typeof g.x === 'number') panelGeom.x = g.x;
        if (typeof g.y === 'number') panelGeom.y = g.y;
        if (typeof g.w === 'number') panelGeom.w = g.w;
        if (typeof g.h === 'number') panelGeom.h = g.h;
        if (g.snap === 'left' || g.snap === 'right' || g.snap === 'bottom' || g.snap === null) panelGeom.snap = g.snap;
        if (g.floatRect && typeof g.floatRect === 'object') panelGeom.floatRect = g.floatRect;
    }
    function savePanelGeom() {
        gmSet(PANEL_GEOM_KEY, {
            x: panelGeom.x, y: panelGeom.y, w: panelGeom.w, h: panelGeom.h,
            snap: panelGeom.snap, floatRect: panelGeom.floatRect,
        });
    }
    function getMapRect() {
        try {
            const mc = document.querySelector('.leaflet-container');
            if (mc) {
                const r = mc.getBoundingClientRect();
                if (r.width > 200 && r.height > 200) return { left: r.left, top: r.top, width: r.width, height: r.height };
            }
        } catch (e) {}
        return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }
    function applyPanelGeom(L, T, W, H) {
        if (!panelEl) return;
        panelEl.style.right = 'auto';
        panelEl.style.left = Math.round(L) + 'px';
        panelEl.style.top = Math.round(T) + 'px';
        panelEl.style.width = Math.round(W) + 'px';
        panelEl.style.height = Math.round(H) + 'px';
        panelGeom.x = Math.round(L); panelGeom.y = Math.round(T);
        panelGeom.w = Math.round(W); panelGeom.h = Math.round(H);
    }
    function snapPanel(where) {
        if (!panelEl) return;
        const m = getMapRect();
        const priorSnap = panelGeom.snap;
        // Remember the floating geometry the first time we dock so float/restore can return to it.
        if (!priorSnap) {
            const r = panelEl.getBoundingClientRect();
            panelGeom.floatRect = { x: r.left, y: r.top, w: r.width, h: r.height };
        }
        const floatW = (panelGeom.floatRect && panelGeom.floatRect.w) || 900;
        let L, T, W, H;
        if (where === 'left' || where === 'right') {
            const baseW = priorSnap ? floatW : panelEl.getBoundingClientRect().width;
            W = Math.min(Math.max(baseW, 480), Math.round(m.width * 0.7));
            H = m.height; T = m.top;
            L = where === 'left' ? m.left : (m.left + m.width - W);
        } else { // bottom dock
            W = m.width; L = m.left;
            H = Math.min(Math.max(Math.round(m.height * 0.45), 300), m.height);
            T = m.top + m.height - H;
        }
        applyPanelGeom(L, T, W, H);
        panelGeom.snap = where;
    }
    function floatPanel() {
        panelGeom.snap = null;
        const f = panelGeom.floatRect;
        if (f) applyPanelGeom(f.x, f.y, f.w, f.h);
    }
    function makeSnapButton(glyph, tip, fn) {
        const b = document.createElement('button');
        b.textContent = glyph;
        b.title = tip;
        b.style.cssText = 'background:transparent;border:1px solid transparent;color:#9fb4bb;font-size:13px;line-height:1;cursor:pointer;padding:2px 5px;border-radius:3px';
        b.onmouseenter = () => { b.style.background = 'rgba(95,255,95,0.18)'; b.style.color = '#cdeff3'; };
        b.onmouseleave = () => { b.style.background = 'transparent'; b.style.color = '#9fb4bb'; };
        b.onpointerdown = (e) => { e.stopPropagation(); }; // don't start a header drag
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        return b;
    }
    function addSnapButtons(container) {
        container.appendChild(makeSnapButton('◧', 'Dock to left of map', () => { snapPanel('left'); savePanelGeom(); }));
        container.appendChild(makeSnapButton('◨', 'Dock to right of map', () => { snapPanel('right'); savePanelGeom(); }));
        container.appendChild(makeSnapButton('⬓', 'Dock to bottom of map', () => { snapPanel('bottom'); savePanelGeom(); }));
        container.appendChild(makeSnapButton('❐', 'Float / restore', () => { floatPanel(); savePanelGeom(); }));
    }

    // Keep the panel "locked to the AIM map" — clamp a floating position/size so it
    // stays within the map region (.leaflet-container), never wandering over the
    // sidebar or off-screen.
    function clampToMap(x, y, w, h) {
        const m = getMapRect();
        const maxX = m.left + m.width - Math.min(w, m.width);
        const maxY = m.top + m.height - Math.min(h, m.height);
        return { x: Math.max(m.left, Math.min(maxX, x)), y: Math.max(m.top, Math.min(maxY, y)) };
    }
    function clampPanelIntoMap() {
        if (!panelEl) return;
        const r = panelEl.getBoundingClientRect();
        const m = getMapRect();
        const w = Math.min(r.width, m.width), h = Math.min(r.height, m.height);
        const c = clampToMap(r.left, r.top, w, h);
        panelEl.style.right = 'auto';
        panelEl.style.left = c.x + 'px'; panelEl.style.top = c.y + 'px';
        panelEl.style.width = w + 'px'; panelEl.style.height = h + 'px';
        panelGeom.x = Math.round(c.x); panelGeom.y = Math.round(c.y);
        panelGeom.w = Math.round(w); panelGeom.h = Math.round(h);
    }

    // 8-way resize — all four edges + four corners, ported from the Site Setup SUM
    // (v4.76). Each handle declares which edges it moves; the opposite edge stays
    // anchored. Clamped to the map (min 480×300) so the panel stays locked to it.
    function addResizeHandles(panel) {
        const MINW = 480, MINH = 300;
        let rz = null;
        const onMove = (e) => {
            if (!rz) return;
            const m = getMapRect();
            const dx = e.clientX - rz.startX, dy = e.clientY - rz.startY;
            const rightX = rz.L + rz.W, bottomY = rz.T + rz.H;
            let L = rz.L, T = rz.T, W = rz.W, H = rz.H;
            if (rz.edges.e) W = rz.W + dx;
            if (rz.edges.w) W = rz.W - dx;
            if (rz.edges.s) H = rz.H + dy;
            if (rz.edges.n) H = rz.H - dy;
            W = Math.max(MINW, Math.min(m.width, W));
            H = Math.max(MINH, Math.min(m.height, H));
            if (rz.edges.w) { L = rightX - W; if (L < m.left) { L = m.left; W = rightX - m.left; } }
            if (rz.edges.n) { T = bottomY - H; if (T < m.top) { T = m.top; H = bottomY - m.top; } }
            if (rz.edges.e && L + W > m.left + m.width) W = m.left + m.width - L;
            if (rz.edges.s && T + H > m.top + m.height) H = m.top + m.height - T;
            panel.style.right = 'auto';
            panel.style.left = L + 'px'; panel.style.top = T + 'px';
            panel.style.width = W + 'px'; panel.style.height = H + 'px';
            panelGeom.x = Math.round(L); panelGeom.y = Math.round(T);
            panelGeom.w = Math.round(W); panelGeom.h = Math.round(H);
            panelGeom.snap = null; // manual resize un-docks
        };
        const onUp = () => { if (rz) { rz = null; document.body.style.userSelect = ''; savePanelGeom(); } };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        const mk = (css, edges) => {
            const h = document.createElement('div');
            h.style.cssText = 'position:absolute;z-index:6;' + css;
            h.addEventListener('mousedown', (e) => {
                const r = panel.getBoundingClientRect();
                rz = { edges, startX: e.clientX, startY: e.clientY, L: r.left, T: r.top, W: r.width, H: r.height };
                document.body.style.userSelect = 'none';
                e.preventDefault(); e.stopPropagation();
            });
            panel.appendChild(h);
        };
        const EDGE = 6, CRN = 14;
        mk(`top:0;left:${CRN}px;right:${CRN}px;height:${EDGE}px;cursor:ns-resize`, { n: true });
        mk(`bottom:0;left:${CRN}px;right:${CRN}px;height:${EDGE}px;cursor:ns-resize`, { s: true });
        mk(`left:0;top:${CRN}px;bottom:${CRN}px;width:${EDGE}px;cursor:ew-resize`, { w: true });
        mk(`right:0;top:${CRN}px;bottom:${CRN}px;width:${EDGE}px;cursor:ew-resize`, { e: true });
        mk(`top:0;left:0;width:${CRN}px;height:${CRN}px;cursor:nwse-resize`, { n: true, w: true });
        mk(`top:0;right:0;width:${CRN}px;height:${CRN}px;cursor:nesw-resize`, { n: true, e: true });
        mk(`bottom:0;left:0;width:${CRN}px;height:${CRN}px;cursor:nesw-resize`, { s: true, w: true });
        mk(`right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,#14d2dc 50%);border-bottom-right-radius:6px;opacity:0.6`, { s: true, e: true });
        const prevRemove = panel.remove.bind(panel);
        panel.remove = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); prevRemove(); };
    }

    // Representative map point for a mission = centroid of its snapshot (asset)
    // points, falling back to nav points (reuses the merge's mbSoloPoints). Pan
    // the AIM map there.
    function missionLatLng(mission) {
        try {
            // 1) snapshot/nav points (GPS snapshots + navs)
            let pts = mbSoloPoints(mission);
            // 2) ANY instruction with a location (covers missions whose snapshots are
            //    "In Place" / no-GPS but still have located navs)
            if (!pts.length) {
                const ins = (mission && mission.instructions) || [];
                pts = ins.filter(i => i && i.location && typeof i.location.lat === 'number').map(i => ({ lat: i.location.lat, lng: i.location.lng }));
            }
            // 3) server-computed route points (last resort)
            if (!pts.length && mission && Array.isArray(mission.route_points)) {
                pts = mission.route_points.filter(p => p && typeof p.lat === 'number').map(p => ({ lat: p.lat, lng: p.lng }));
            }
            if (!pts.length) return null;
            let la = 0, ln = 0; pts.forEach(p => { la += p.lat; ln += p.lng; });
            la /= pts.length; ln /= pts.length;
            if (!isFinite(la) || !isFinite(ln)) return null;
            return { lat: la, lng: ln };
        } catch (e) { return null; }
    }
    function panToMission(missionId) {
        try {
            const sid = getCurrentSiteID();
            const ms = (missionsBySite[sid] && missionsBySite[sid].missions) || [];
            const m = ms.find(x => String(x.id) === String(missionId));
            if (!m) { console.warn(`${TAG} [pan] mission ${missionId} not in cache (site ${sid}) — open/refresh the SUM panel`); return; }
            const ll = missionLatLng(m);
            if (!ll || !isFinite(ll.lat) || !isFinite(ll.lng)) { console.warn(`${TAG} [pan] mission ${missionId} has no usable GPS (all "In Place" snapshots / no located steps?)`); return; }
            const map = getLeafletMap();
            if (!map || typeof map.setView !== 'function') { console.warn(`${TAG} [pan] Leaflet map not found`); return; }
            map.setView([ll.lat, ll.lng], Math.max(17, map.getZoom()));
        } catch (e) { console.warn(`${TAG} [pan] failed`, e); }
    }

    // Spreadsheet-style multi-select on the row checkboxes (parity with the Site
    // Setup SUM):
    //   • plain / Ctrl(Cmd)+click → toggle just this mission (others stay selected)
    //   • Shift+click → apply this click's NEW state to the whole range from the
    //     last-clicked row (anchor) to here, in current display order.
    // `rows` = the display-ordered row list; selection lives in panelState.selectedIds,
    // the anchor in panelState._lastSelId.
    function wireRowSelectCheckboxes(rows) {
        if (!panelEl) return;
        // Re-render WITHOUT losing scroll — save the table scrollTop first so
        // renderTableView restores it (else a checkbox click jumps the list to top).
        const rerenderKeepScroll = () => {
            const tw = panelEl.querySelector('#aim-mb-table-wrap');
            if (tw) panelState.tableScrollY = tw.scrollTop;
            renderTableView();
        };
        panelEl.querySelectorAll('input[data-row]').forEach(cb => {
            cb.onclick = (e) => {
                e.stopPropagation();
                const id = Number(cb.dataset.row);
                const target = cb.checked; // checkbox already flipped to its new state
                const anchorId = panelState._lastSelId;
                if (e.shiftKey && anchorId != null && anchorId !== id) {
                    const ai = rows.findIndex(r => r.id === anchorId);
                    const ci = rows.findIndex(r => r.id === id);
                    if (ai >= 0 && ci >= 0) {
                        const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
                        for (let i = lo; i <= hi; i++) {
                            if (target) panelState.selectedIds.add(rows[i].id);
                            else panelState.selectedIds.delete(rows[i].id);
                        }
                        panelState._lastSelId = id;
                        rerenderKeepScroll();
                        return;
                    }
                }
                if (target) panelState.selectedIds.add(id);
                else panelState.selectedIds.delete(id);
                panelState._lastSelId = id;
                rerenderKeepScroll();
            };
        });
    }

    // ========================================================
    // Render states
    // ========================================================
    function setBodyHtml(html) {
        const body = panelEl && panelEl.querySelector('#aim-mb-body');
        if (body) body.innerHTML = html;
    }

    function updateTitle() {
        if (!panelEl) return;
        const titleEl = panelEl.querySelector('.aim-mb-header-title');
        const name = getCurrentSiteName();
        const sid = getCurrentSiteID();
        const site = name || (sid ? `Site ${sid}` : '?');
        const prefix = (panelState && panelState.mode === 'log') ? '📋 Mission Log' : '📋 Mission Bank Summary';
        if (titleEl) titleEl.innerHTML = `${prefix} — <span data-site>${escapeHtml(site)}</span>`;
    }

    function renderLoadingState() {
        updateTitle();
        const sid = getCurrentSiteID();
        setBodyHtml(`<div style="padding:40px;text-align:center;color:#888;">Loading missions for site ${sid}…</div>`);
    }

    function renderErrorState(msg) {
        setBodyHtml(`<div style="padding:40px;text-align:center;color:#ff5252;">Failed to load missions: ${escapeHtml(msg)}</div>`);
    }

    // ========================================================
    // Render — table view
    // ========================================================
    function renderTableView() {
        const sid = getCurrentSiteID();
        if (!sid) return;
        if (!panelState) initPanelState();
        if (panelState.mode === 'log') { renderLogTableView(); return; }
        panelState.drillId = null;
        updateTitle();
        // Rebuild dynamic step-type columns from the loaded missions so
        // ANY step type Percepto uses shows up automatically.
        refreshDynamicColumns(sid);

        const allRows = buildAllRows(sid);
        const rows = filterAndSort(allRows);

        const visibleColIds = getVisibleColumnIds();
        const visibleCols = visibleColIds.map(id => COL_BY_ID[id]).filter(Boolean);
        const thresholds = panelState.thresholds;

        const html = `
            <div class="aim-mb-toolbar">
                <input class="aim-mb-search" type="text" placeholder="Search by name…" value="${escapeHtml(panelState.search)}" />
                <button class="aim-mb-tbtn" data-cols>Columns ▾</button>
                <button class="aim-mb-tbtn ${panelState.distanceUnit === 'imperial' ? 'active' : ''}" data-unit="imperial">mi</button>
                <button class="aim-mb-tbtn ${panelState.distanceUnit === 'metric' ? 'active' : ''}" data-unit="metric">km</button>
                <button class="aim-mb-tbtn" data-settings title="Battery → flights thresholds">⚙</button>
            </div>
            <div class="aim-mb-table-wrap" id="aim-mb-table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th style="width:32px;"><input type="checkbox" data-select-all ${selectAllState(rows)} /></th>
                            ${visibleCols.map(col => renderHeaderCell(col)).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(r => renderRow(r, visibleCols, thresholds)).join('')}
                    </tbody>
                </table>
            </div>
            <div class="aim-mb-footer">
                <div class="aim-mb-info">
                    ${rows.length} mission${rows.length === 1 ? '' : 's'}${panelState.selectedIds.size > 0 ? ` · <strong style="color:#14d2dc">${panelState.selectedIds.size} selected</strong>` : ''}
                </div>
                <button class="aim-mb-tbtn" data-export="csv">Copy CSV</button>
                <button class="aim-mb-tbtn" data-export="tsv">Copy → Sheets</button>
                <button class="aim-mb-tbtn" data-export="json">Copy JSON</button>
            </div>
        `;
        setBodyHtml(html);
        // Restore scroll
        const tw = panelEl.querySelector('#aim-mb-table-wrap');
        if (tw && panelState.tableScrollY) tw.scrollTop = panelState.tableScrollY;

        wireTableEvents(rows, visibleCols);
    }

    function renderHeaderCell(col) {
        const sorted = panelState.sortKey === col.id;
        const arrow = sorted ? (panelState.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        return `<th class="${sorted ? 'sorted' : ''}" data-col="${col.id}">${escapeHtml(col.label)}${arrow}</th>`;
    }

    function renderRow(row, visibleCols, thresholds) {
        const checked = panelState.selectedIds.has(row.id) ? 'checked' : '';
        const selectedCls = panelState.selectedIds.has(row.id) ? 'selected' : '';
        const cells = visibleCols.map(col => {
            if (col.kind === 'dot') {
                const cls = row[col.key] ? 'active' : 'inactive';
                return `<td><span class="aim-mb-dot ${cls}" title="${row[col.key] ? 'Active' : 'Inactive'}"></span></td>`;
            }
            const v = formatCellValue(row, col, panelState.distanceUnit, thresholds);
            return `<td>${escapeHtml(String(v))}</td>`;
        }).join('');
        return `<tr class="${selectedCls}" data-id="${row.id}"><td><input type="checkbox" data-row="${row.id}" ${checked} /></td>${cells}</tr>`;
    }

    function selectAllState(rows) {
        if (rows.length === 0) return '';
        const allSelected = rows.every(r => panelState.selectedIds.has(r.id));
        return allSelected ? 'checked' : '';
    }

    function wireTableEvents(rows, visibleCols) {
        // Search — DEBOUNCED 250ms. Full table re-render on every
        // keystroke was the main mid-session perf hit (98 missions × 13
        // cols × per-row event re-wire). After debounce + re-render,
        // we re-grab the search input and restore focus + cursor pos.
        const search = panelEl.querySelector('.aim-mb-search');
        if (search) {
            let searchDebounce = null;
            search.addEventListener('input', (e) => {
                const cursor = e.target.selectionStart;
                const newVal = e.target.value;
                if (searchDebounce) clearTimeout(searchDebounce);
                searchDebounce = setTimeout(() => {
                    searchDebounce = null;
                    panelState.search = newVal;
                    renderTableView();
                    const newSearch = panelEl.querySelector('.aim-mb-search');
                    if (newSearch) {
                        newSearch.focus();
                        try { newSearch.setSelectionRange(cursor, cursor); } catch (er) {}
                    }
                }, 250);
            });
        }
        // Unit toggle
        panelEl.querySelectorAll('[data-unit]').forEach(b => {
            b.onclick = () => {
                panelState.distanceUnit = b.dataset.unit;
                gmSet(CACHE_KEY_DISTANCE_UNIT, panelState.distanceUnit);
                renderTableView();
            };
        });
        // Columns menu
        const colsBtn = panelEl.querySelector('[data-cols]');
        if (colsBtn) colsBtn.onclick = () => openColumnsMenu(colsBtn);
        // Settings (thresholds)
        const settingsBtn = panelEl.querySelector('[data-settings]');
        if (settingsBtn) settingsBtn.onclick = () => openSettingsPopover(settingsBtn);
        // Column sort
        panelEl.querySelectorAll('th[data-col]').forEach(th => {
            th.onclick = () => {
                const colId = th.dataset.col;
                if (panelState.sortKey === colId) {
                    if (panelState.sortDir === 'asc') panelState.sortDir = 'desc';
                    else if (panelState.sortDir === 'desc') {
                        // Reset to default: flightDistance desc
                        panelState.sortKey = 'flightDistance';
                        panelState.sortDir = 'desc';
                    } else panelState.sortDir = 'asc';
                } else {
                    panelState.sortKey = colId;
                    panelState.sortDir = 'asc';
                }
                renderTableView();
            };
        });
        // Row click → drill-down (but not if clicking checkbox)
        panelEl.querySelectorAll('tbody tr[data-id]').forEach(tr => {
            tr.onclick = (e) => {
                if (e.target.matches('input[type="checkbox"]')) return;
                const id = Number(tr.dataset.id);
                const tw = panelEl.querySelector('#aim-mb-table-wrap');
                if (tw) panelState.tableScrollY = tw.scrollTop;
                panToMission(id); // jump the map to the mission (checkbox-select stays put)
                renderDetailView(id);
            };
        });
        // Checkbox per row — Shift = contiguous range, plain/Ctrl = individual.
        wireRowSelectCheckboxes(rows);
        // Select all
        const selAll = panelEl.querySelector('[data-select-all]');
        if (selAll) {
            selAll.onclick = (e) => {
                e.stopPropagation();
                if (selAll.checked) rows.forEach(r => panelState.selectedIds.add(r.id));
                else rows.forEach(r => panelState.selectedIds.delete(r.id));
                renderTableView();
            };
        }
        // Exports
        panelEl.querySelectorAll('[data-export]').forEach(b => {
            b.onclick = () => doExport(b.dataset.export, rows, visibleCols);
        });
    }

    // ========================================================
    // Columns menu (visibility toggles, persisted)
    // ========================================================
    function openColumnsMenu(anchor) {
        closeOpenMenus();
        const menu = document.createElement('div');
        menu.className = 'aim-mb-cols-menu';
        positionFloatingMenu(menu, anchor);
        document.body.appendChild(menu);
        rebuildColumnsMenuBody(menu, anchor);
        // Outside click closes
        setTimeout(() => {
            const onDoc = (e) => {
                if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('mousedown', onDoc, true);
                }
            };
            document.addEventListener('mousedown', onDoc, true);
        }, 0);
    }

    function rebuildColumnsMenuBody(menu, anchor) {
        const visIds = getVisibleColumnIds();
        const visSet = new Set(visIds);
        // Build the list: visible columns first in their stored order
        // (with ↑/↓ arrows), then hidden columns below a divider.
        const byId = activeColById();
        const visibleRows = visIds.map(id => byId[id]).filter(Boolean);
        const hiddenRows = activeColumns().filter(c => !visSet.has(c.id));
        menu.innerHTML = `
            <div class="aim-mb-menu-head">
                <div class="aim-mb-menu-title">Columns</div>
                <button class="aim-mb-menu-close" data-close-menu title="Close">✕</button>
            </div>
            <div class="aim-mb-menu-body">
                <div style="font-size:9px;text-transform:uppercase;color:#14d2dc;letter-spacing:0.05em;padding:2px 8px 4px;font-weight:700;">Visible (drag order with ↑↓)</div>
                ${visibleRows.map((c, i) => `
                    <div class="aim-mb-col-row" data-col-id="${c.id}">
                        <input type="checkbox" data-col-toggle="${c.id}" checked />
                        <span class="aim-mb-col-label">${escapeHtml(c.label)}</span>
                        <span class="aim-mb-col-arrows">
                            <button data-col-up="${c.id}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
                            <button data-col-down="${c.id}" title="Move down" ${i === visibleRows.length - 1 ? 'disabled' : ''}>↓</button>
                        </span>
                    </div>
                `).join('')}
                <hr style="border:none;border-top:1px solid #444;margin:6px 0;" />
                <div style="font-size:9px;text-transform:uppercase;color:#888;letter-spacing:0.05em;padding:2px 8px 4px;font-weight:700;">Hidden</div>
                ${hiddenRows.map(c => `
                    <div class="aim-mb-col-row">
                        <input type="checkbox" data-col-toggle="${c.id}" />
                        <span class="aim-mb-col-label">${escapeHtml(c.label)}</span>
                    </div>
                `).join('')}
                <hr style="border:none;border-top:1px solid #444;margin:6px 0;" />
                <button class="aim-mb-tbtn" data-cols-reset style="width:100%">Reset to defaults</button>
            </div>
        `;
        // Close
        menu.querySelector('[data-close-menu]').onclick = () => menu.remove();
        // Toggle
        menu.querySelectorAll('[data-col-toggle]').forEach(cb => {
            cb.onclick = (e) => {
                e.stopPropagation();
                const id = cb.dataset.colToggle;
                const cur = getVisibleColumnIds().slice();
                if (cb.checked) {
                    // Append at end — preserves custom order
                    if (!cur.includes(id)) cur.push(id);
                } else {
                    const idx = cur.indexOf(id);
                    if (idx >= 0) cur.splice(idx, 1);
                }
                setVisibleColumnIds(cur);
                renderTableView();
                rebuildColumnsMenuBody(menu, anchor);
            };
        });
        // ↑ Move up
        menu.querySelectorAll('[data-col-up]').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const id = btn.dataset.colUp;
                const cur = getVisibleColumnIds().slice();
                const idx = cur.indexOf(id);
                if (idx > 0) { cur.splice(idx, 1); cur.splice(idx - 1, 0, id); }
                setVisibleColumnIds(cur);
                renderTableView();
                rebuildColumnsMenuBody(menu, anchor);
            };
        });
        // ↓ Move down
        menu.querySelectorAll('[data-col-down]').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const id = btn.dataset.colDown;
                const cur = getVisibleColumnIds().slice();
                const idx = cur.indexOf(id);
                if (idx >= 0 && idx < cur.length - 1) { cur.splice(idx, 1); cur.splice(idx + 1, 0, id); }
                setVisibleColumnIds(cur);
                renderTableView();
                rebuildColumnsMenuBody(menu, anchor);
            };
        });
        // Reset
        menu.querySelector('[data-cols-reset]').onclick = () => {
            const next = COLUMNS.filter(c => c.defaultVisible).map(c => c.id);
            setVisibleColumnIds(next);
            renderTableView();
            rebuildColumnsMenuBody(menu, anchor);
        };
    }

    // ========================================================
    // Settings popover (battery → flights thresholds)
    // ========================================================
    function openSettingsPopover(anchor) {
        closeOpenMenus();
        const t = panelState.thresholds;
        const labels = ['7 flights (>)', '6 flights (>)', '5 flights (>)', '4 flights (>)', '3 flights (>)', '2 flights (≥)'];
        const pop = document.createElement('div');
        pop.className = 'aim-mb-settings-popover';
        // Compute elevation cache stats
        const elevCache = loadElevationCache();
        const elevCount = Object.keys(elevCache).length;
        const elevSizeKB = Math.round(JSON.stringify(elevCache).length / 1024);
        pop.innerHTML = `
            <div class="aim-mb-menu-head">
                <div class="aim-mb-menu-title">Settings</div>
                <button class="aim-mb-menu-close" data-close-menu title="Close">✕</button>
            </div>
            <div class="aim-mb-menu-body" style="padding:12px;">
                <div style="font-size:11px;color:#14d2dc;font-weight:700;margin-bottom:6px;">Battery → Flights thresholds</div>
                <div style="font-size:10px;color:#888;margin-bottom:10px;">Adjust per-flight battery percentages. Drones land around 30 % so 100 % raw usage ≈ 2 flights.</div>
                ${labels.map((lbl, i) => `
                    <div class="aim-mb-settings-row">
                        <span style="flex:1">${lbl}</span>
                        <input type="number" data-thresh="${i}" value="${t[i]}" step="10" />
                        <span>%</span>
                    </div>
                `).join('')}
                <div class="aim-mb-settings-row" style="margin-top:10px;">
                    <button class="aim-mb-tbtn" data-thresh-reset style="flex:1">Reset thresholds to defaults</button>
                </div>
                <hr style="border:none;border-top:1px solid #444;margin:14px 0 10px;" />
                <div style="font-size:11px;color:#14d2dc;font-weight:700;margin-bottom:6px;">Elevation cache</div>
                <div style="font-size:10px;color:#888;margin-bottom:8px;">${elevCount.toLocaleString()} points cached · ~${elevSizeKB.toLocaleString()} KB</div>
                <div class="aim-mb-settings-row">
                    <button class="aim-mb-tbtn" data-clear-elev-cache style="flex:1">Clear elevation cache</button>
                </div>
            </div>
        `;
        positionFloatingMenu(pop, anchor, { preferLeft: true });
        document.body.appendChild(pop);

        pop.querySelector('[data-close-menu]').onclick = () => pop.remove();
        pop.querySelectorAll('[data-thresh]').forEach(inp => {
            inp.oninput = () => {
                const i = Number(inp.dataset.thresh);
                const v = Number(inp.value);
                if (!isNaN(v)) {
                    panelState.thresholds[i] = v;
                    gmSet(CACHE_KEY_FLIGHT_THRESHOLDS, panelState.thresholds);
                    renderTableView();
                    // Popover lives on document.body so it survives.
                }
            };
        });
        pop.querySelector('[data-thresh-reset]').onclick = () => {
            panelState.thresholds = DEFAULT_FLIGHT_THRESHOLDS.slice();
            gmSet(CACHE_KEY_FLIGHT_THRESHOLDS, panelState.thresholds);
            renderTableView();
            // Refresh input values in-place
            pop.querySelectorAll('[data-thresh]').forEach(inp => {
                const i = Number(inp.dataset.thresh);
                inp.value = panelState.thresholds[i];
            });
        };
        const clearElevBtn = pop.querySelector('[data-clear-elev-cache]');
        if (clearElevBtn) clearElevBtn.onclick = () => {
            if (!confirm(`Clear ${Object.keys(loadElevationCache()).length} cached elevation points? Next mission view will re-fetch from Percepto.`)) return;
            elevationCache = {};
            flushElevationCache();
            showToast('Elevation cache cleared', '#5fff5f');
            pop.remove();
        };
        setTimeout(() => {
            const onDoc = (e) => {
                if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
                    pop.remove();
                    document.removeEventListener('mousedown', onDoc, true);
                }
            };
            document.addEventListener('mousedown', onDoc, true);
        }, 0);
    }

    // Position a floating menu using fixed coords from the anchor's bounding rect.
    // Clamps to viewport so the menu never lands off-screen.
    function positionFloatingMenu(menu, anchor, opts) {
        const rect = anchor.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const desiredW = 280;
        let left = (opts && opts.preferLeft) ? (rect.right - desiredW) : rect.left;
        let top = rect.bottom + 4;
        if (left + desiredW > vw - 8) left = Math.max(8, vw - desiredW - 8);
        if (left < 8) left = 8;
        // Defer max-height calc until after attachment if needed; cap top.
        if (top + 100 > vh - 8) top = Math.max(8, vh - 200);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    function closeOpenMenus() {
        document.querySelectorAll('.aim-mb-cols-menu, .aim-mb-settings-popover').forEach(m => m.remove());
    }

    // ========================================================
    // Filter + Sort
    // ========================================================
    function filterAndSort(rows) {
        const q = (panelState.search || '').trim().toLowerCase();
        let out = rows;
        if (q) {
            if (panelState.mode === 'log') {
                out = out.filter(r => [r.name, r.type, r.drone, r.stateLabel, r.createdBy, String(r.missionGroup), String(r.id)]
                    .some(v => (v || '').toString().toLowerCase().includes(q)));
            } else {
                out = out.filter(r => (r.name || '').toLowerCase().includes(q)
                    || (r.description || '').toLowerCase().includes(q));
            }
        }
        const col = activeColById()[panelState.sortKey];
        if (col) {
            const dir = panelState.sortDir === 'asc' ? 1 : -1;
            out = out.slice().sort((a, b) => {
                const va = getSortValue(a, col, panelState.thresholds);
                const vb = getSortValue(b, col, panelState.thresholds);
                if (va < vb) return -1 * dir;
                if (va > vb) return 1 * dir;
                // Tiebreak by name
                return (a.name || '').localeCompare(b.name || '') * dir;
            });
        }
        return out;
    }

    // ========================================================
    // Detail view (master-detail swap)
    // ========================================================
    function renderDetailView(missionId, opts) {
        const sid = getCurrentSiteID();
        const rows = buildAllRows(sid);
        const row = rows.find(r => r.id === missionId);
        if (!row) { renderTableView(); return; }
        panelState.drillId = missionId;
        if (!panelState.detailFilter) panelState.detailFilter = new Set();
        // Row selection is per-mission — reset it when we land on a new mission.
        if (!panelState.detailSelection || panelState.detailSelDrill !== missionId) {
            panelState.detailSelection = new Set();
            panelState.detailSelDrill = missionId;
        }

        // Preserve scroll positions across re-renders so inline edits
        // don't snap the user back to the top of the drill-down.
        const prevBody = panelEl && panelEl.querySelector('.aim-mb-detail-body');
        const prevInstr = panelEl && panelEl.querySelector('.aim-mb-detail-instr-scroll');
        const savedBodyScroll = prevBody ? prevBody.scrollTop : 0;
        const savedInstrScroll = prevInstr ? prevInstr.scrollTop : 0;

        const unit = panelState.distanceUnit;
        const t = panelState.thresholds;
        const allSteps = row.realSteps;

        // Discover distinct step types for filter buttons
        const stepTypes = [];
        const seen = new Set();
        allSteps.forEach(s => {
            const t = displayStepType(s);
            if (!seen.has(t)) { seen.add(t); stepTypes.push(t); }
        });

        // Apply type filter — empty set = all visible (no filter active)
        const activeFilters = panelState.detailFilter;
        const showAll = activeFilters.size === 0;
        const filteredSteps = showAll ? allSteps : allSteps.filter(s => activeFilters.has(displayStepType(s)));

        const orderedCounts = buildOrderedStepCounts(allSteps);
        const typeStatCards = orderedCounts
            .map(([k, v]) => stat(k, v, String(v)))
            .join('');

        // Filter chips — multi-select: click toggles each type on/off.
        // "All" clears any active filters (empty set = show everything).
        const filterChips = [`<button class="aim-mb-tbtn${showAll ? ' active' : ''}" data-step-filter="__all">All</button>`]
            .concat(stepTypes.map(t =>
                `<button class="aim-mb-tbtn${activeFilters.has(t) ? ' active' : ''}" data-step-filter="${escapeHtml(t)}">${escapeHtml(t)}</button>`
            )).join('');

        const html = `
            <div class="aim-mb-detail-header">
                <button class="aim-mb-detail-back" data-back>← Back</button>
                <div class="aim-mb-detail-title" data-detail-name="${escapeHtml(row.name)}" title="Click to copy name" style="cursor:pointer;">${escapeHtml(row.name)} 📋</div>
                <button class="aim-mb-tbtn" data-open-editor="${row.id}" title="Open this mission in AIM editor">Edit ✏️</button>
                <button class="aim-mb-tbtn ${unit === 'imperial' ? 'active' : ''}" data-unit-d="imperial">mi</button>
                <button class="aim-mb-tbtn ${unit === 'metric' ? 'active' : ''}" data-unit-d="metric">km</button>
                <div class="aim-mb-detail-id">ID ${row.id}${row.active ? '' : ' · <span style="color:#888">Inactive</span>'}</div>
            </div>
            <div class="aim-mb-detail-body">
                <div class="aim-mb-card">
                    <div class="aim-mb-card-title">Mission Stats</div>
                    <div class="aim-mb-stats-grid">
                        ${stat('Distance', fmtDistance(row.flightDistanceM, unit), fmtDistance(row.flightDistanceM, unit))}
                        ${stat('Flight Time', fmtTime(row.flightTimeS), fmtTime(row.flightTimeS))}
                        ${stat('Steps', row.steps, String(row.steps))}
                        ${stat('Battery %', fmtPct(row.batteryConsumption), fmtPct(row.batteryConsumption))}
                        ${stat('Est. Flights', estimateFlights(row.batteryConsumption, t), String(estimateFlights(row.batteryConsumption, t)))}
                        ${stat('Total Consumption %', fmtPct(row.totalConsumption), fmtPct(row.totalConsumption))}
                    </div>
                </div>
                ${(() => {
                    // AGL aggregates EXCLUDE snapshots (they intentionally
                    // sit near ground level — pointing at targets — so they'd
                    // skew the "lowest flight clearance" stats). Ground
                    // elevation aggregates INCLUDE all GPS points though.
                    const aglAggr = []; // navigate + other flying steps
                    const allElev = [];
                    allSteps.forEach(s => {
                        if (!s || !s.location || s.location.lat == null) return;
                        const elevM = getElevationFromCache(Number(s.location.lat), Number(s.location.lng));
                        if (elevM == null) return;
                        allElev.push(elevM);
                        if (s.value1_name !== 'm' || typeof s.value1 !== 'number') return;
                        if (s.type_name === 'snapshot') return; // exclude snapshots from AGL aggregates
                        aglAggr.push(s.value1 - elevM);
                    });
                    if (allElev.length === 0) return '';
                    const conv = (m) => unit === 'imperial' ? Math.round(m * 3.28084) : Math.round(m);
                    const ul = unit === 'imperial' ? 'ft' : 'm';
                    const fmtN = n => `${conv(n).toLocaleString()} ${ul}`;
                    const fmtRaw = n => String(conv(n));
                    const totalGps = allSteps.filter(s=>s&&s.location&&s.location.lat!=null).length;
                    const navCount = allSteps.filter(s=>s&&s.location&&s.location.lat!=null && s.type_name!=='snapshot' && s.value1_name==='m' && typeof s.value1==='number').length;
                    const minElev = Math.min(...allElev);
                    const maxElev = Math.max(...allElev);
                    let aglStats = '';
                    if (aglAggr.length > 0) {
                        const minA = Math.min(...aglAggr);
                        const maxA = Math.max(...aglAggr);
                        const avgA = aglAggr.reduce((s, v) => s + v, 0) / aglAggr.length;
                        aglStats = `
                            ${stat('Min AGL (nav)', fmtN(minA), fmtRaw(minA))}
                            ${stat('Avg AGL (nav)', fmtN(avgA), fmtRaw(avgA))}
                            ${stat('Max AGL (nav)', fmtN(maxA), fmtRaw(maxA))}`;
                    }
                    return `<div class="aim-mb-card">
                        <div class="aim-mb-card-title">Terrain / AGL — AGL stats exclude snapshots (${aglAggr.length} nav-type, ${allElev.length}/${totalGps} GPS sampled)</div>
                        <div class="aim-mb-stats-grid">
                            ${aglStats}
                            ${stat('Min Ground Elv', fmtN(minElev), fmtRaw(minElev))}
                            ${stat('Max Ground Elv', fmtN(maxElev), fmtRaw(maxElev))}
                            ${stat('Ground Range', fmtN(maxElev - minElev), fmtRaw(maxElev - minElev))}
                        </div>
                    </div>`;
                })()}
                <div class="aim-mb-card">
                    <div class="aim-mb-card-title">Flight Phase Breakdown</div>
                    <div class="aim-mb-stats-grid">
                        ${stat('Takeoff', `${fmtTime(row.takeoffTimeS)} · ${fmtPct(row.takeoffConsumption)}`, `${fmtTime(row.takeoffTimeS)} / ${fmtPct(row.takeoffConsumption)}`)}
                        ${stat('Navigate', `${fmtTime(row.navTimeS)} · ${fmtPct(row.navConsumption)}`, `${fmtTime(row.navTimeS)} / ${fmtPct(row.navConsumption)}`)}
                        ${stat('Wait', `${fmtTime(row.waitTimeS)} · ${fmtPct(row.waitConsumption)}`, `${fmtTime(row.waitTimeS)} / ${fmtPct(row.waitConsumption)}`)}
                        ${stat('Extra', `${fmtTime(row.extraTimeS)} · ${fmtPct(row.extraConsumption)}`, `${fmtTime(row.extraTimeS)} / ${fmtPct(row.extraConsumption)}`)}
                        ${stat('Landing', `${fmtTime(row.landingTimeS)} · ${fmtPct(row.landingConsumption)}`, `${fmtTime(row.landingTimeS)} / ${fmtPct(row.landingConsumption)}`)}
                    </div>
                </div>
                <div class="aim-mb-card">
                    <div class="aim-mb-card-title">Step Counts (excluding takeoff + return)</div>
                    <div class="aim-mb-stats-grid">
                        ${typeStatCards || '<div style="color:#888;font-size:11px;">No real steps.</div>'}
                    </div>
                </div>
                <div class="aim-mb-card" style="padding-bottom:0;">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
                        <div class="aim-mb-card-title" style="margin-bottom:0;">Instructions</div>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;flex:1;">${filterChips}</div>
                        ${panelState.detailSelection.size ? `<span class="aim-mb-sel-count">${panelState.detailSelection.size} selected</span>` : ''}
                        <button class="aim-mb-bulk-btn" data-bulk="agl" title="Set a target AGL for the selected steps (or all visible editable steps if none selected) — recomputes each step's altitude from its own ground elevation.">Bulk → AGL</button>
                        <button class="aim-mb-bulk-btn" data-bulk="alt" title="Set an absolute altitude for the selected steps (or all visible editable steps if none selected).">Bulk → ALT</button>
                        <label class="aim-mb-collapse-toggle" style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:11px;color:#9ad;white-space:nowrap;" title="Collapse each snapshot's Thermal/GEM/Wait block into one summary row. Data is untouched — view only.">
                            <input type="checkbox" data-collapse-blocks ${collapseScanBlocks ? 'checked' : ''}> Collapse scan blocks
                        </label>
                        <button class="aim-mb-tbtn" data-detail-export="sheets" title="Copy visible rows → Sheets">Copy → Sheets</button>
                        <button class="aim-mb-tbtn" data-detail-export="kml" title="Export as KML — flight-path line + N#/S# 3D pins, each pin showing its step details (bundled Thermal/GEM/Wait)">Export KML</button>
                    </div>
                    ${(() => {
                        const n = countPending(missionId);
                        if (n === 0) return '';
                        return `<div class="aim-mb-pending-banner">
                            <span><strong>${n}</strong> altitude change${n === 1 ? '' : 's'} pending</span>
                            ${fastBulkSave
                                ? `<span style="color:#14d2dc;font-weight:700;white-space:nowrap;">⚡ ON → just <u>Save the mission</u> to apply all ${n} (no Commit needed)</span>`
                                : `<button class="aim-mb-tbtn" data-commit-pending style="background:#5fff5f;color:#000;border-color:#5fff5f;">Commit ${n} (per-step)</button>`}
                            <button class="aim-mb-tbtn" data-discard-pending>Discard</button>
                            <label style="display:inline-flex;align-items:center;gap:5px;margin-left:auto;cursor:pointer;white-space:nowrap;${fastBulkSave ? 'color:#14d2dc;font-weight:700;' : ''}" title="ON: skip per-step — staged changes are spliced into your next mission Save in one shot. Snapshot → altitude; Navigate → altitude + drop freezone-min. Strict match, fail-closed. OFF by default; resets each reload.">
                                <input type="checkbox" data-fast-save ${fastBulkSave ? 'checked' : ''}> ⚡ Fast bulk save
                            </label>
                        </div>`;
                    })()}
                    <div class="aim-mb-detail-instr-scroll" style="overflow:auto;max-height:400px;">
                        <table style="margin:0" id="aim-mb-detail-table">
                            <thead style="position:sticky;top:0;z-index:2;background:#1a1a1a;">
                                <tr><th class="aim-mb-sel-cell" style="width:24px;text-align:center;"><input type="checkbox" data-sel-all title="Select all editable visible steps"></th><th style="width:28px;"></th><th style="width:28px;"></th><th>Step</th><th>Type</th><th>Elevation</th><th>Value</th><th>AGL Δ</th><th>Lat</th><th>Long</th><th>GPS</th></tr>
                            </thead>
                            <tbody>
                                ${renderDetailRows(filteredSteps, allSteps, unit)}
                            </tbody>
                        </table>
                    </div>
                    ${row.description ? `<div style="padding:8px 0;color:#aaa;font-size:11px;">Description: ${escapeHtml(row.description)}</div>` : ''}
                    ${row.robotTypes ? `<div style="padding:0 0 8px;color:#aaa;font-size:11px;">Robot types: ${escapeHtml(row.robotTypes)}</div>` : ''}
                </div>
            </div>
        `;
        setBodyHtml(html);
        // Restore scroll positions
        const newBody = panelEl.querySelector('.aim-mb-detail-body');
        if (newBody) newBody.scrollTop = savedBodyScroll;
        const newInstr = panelEl.querySelector('.aim-mb-detail-instr-scroll');
        if (newInstr) newInstr.scrollTop = savedInstrScroll;
        wireDetailEvents(missionId, row, filteredSteps, allSteps);
        // Kick off bulk elevation fetch for steps with GPS that aren't
        // already cached. On completion (or as cells trickle in) we
        // re-render the detail view so the new values appear.
        kickOffElevationFetch(missionId, allSteps);
        // Optionally auto-focus the next editable altitude after a queue commit
        if (opts && opts.focusNextAfter != null) {
            focusNextAltEditable(missionId, opts.focusNextAfter, opts.focusColumn);
        }
    }

    // Trigger bulk elevation fetch for any uncached step GPS coords.
    // ONE re-render at the very end (not per partial completion) —
    // intermediate renders thrash the DOM and lag the whole page.
    // Progress is shown via inline text update in the card title.
    let elevFetchActive = null; // {missionId, total, done} or null
    function kickOffElevationFetch(missionId, allSteps) {
        const points = [];
        const seen = new Set();
        const now = Date.now();
        allSteps.forEach(s => {
            if (!s || !s.location || s.location.lat == null) return;
            const lat = Number(s.location.lat), lng = Number(s.location.lng);
            const key = elevCacheKey(lat, lng);
            if (seen.has(key)) return;
            seen.add(key);
            // Cache check MUST be bridge-aware (getElevationFromCache) — bulk routes
            // through the OTD bridge which caches in Asset Inspector's store, not
            // MBT's local one. Checking only the local cache made every re-render
            // see the point as "uncached" → fetch → re-render → fetch forever (the
            // "fetching 1 elevations" runaway).
            if (getElevationFromCache(lat, lng) != null) return; // already cached
            if (elevInFlight[key]) return;                       // already requested
            if (elevFailedAt[key] && now - elevFailedAt[key] < ELEV_FAIL_COOLDOWN) return; // recently failed — don't hammer
            points.push({ lat, lng, id: key });
        });
        if (points.length === 0) return;
        console.log(`${TAG} fetching ${points.length} elevations`);
        elevFetchActive = { missionId, total: points.length, done: 0 };
        updateElevProgressLabel();
        bulkFetchElevations(points, (done, total) => {
            if (elevFetchActive) { elevFetchActive.done = done; updateElevProgressLabel(); }
        }).then((result) => {
            elevFetchActive = null;
            // Mark points that DIDN'T resolve so we don't re-request them every
            // re-render (the bridge path bypasses the per-point cooldown), and only
            // re-render if something actually resolved — otherwise a fully-
            // unresolvable mission would render→fetch→render endlessly.
            let resolved = 0;
            points.forEach(p => {
                const got = (result && result[p.id] != null) || getElevationFromCache(p.lat, p.lng) != null;
                if (got) resolved++; else elevFailedAt[p.id] = Date.now();
            });
            if (resolved > 0 && panelState && panelState.drillId === missionId) {
                renderDetailView(missionId);
            }
        });
    }

    // Tiny DOM update — just the card title text. No full re-render.
    function updateElevProgressLabel() {
        if (!panelEl) return;
        const labels = panelEl.querySelectorAll('.aim-mb-card-title');
        for (const lbl of labels) {
            if (/Instructions/i.test(lbl.textContent || '')) {
                if (elevFetchActive) {
                    lbl.textContent = `Instructions — fetching elevations ${elevFetchActive.done}/${elevFetchActive.total}…`;
                } else {
                    lbl.textContent = 'Instructions';
                }
                return;
            }
        }
    }

    // Tab advances to the NEXT editable cell in the SAME column (not across
    // columns). column = 'alt' (Value) or 'agl' (AGL Δ).
    function focusNextAltEditable(missionId, currentInstrId, column) {
        const col = column === 'agl' ? 'agl' : 'alt';
        const opener = col === 'agl' ? startInlineAglEdit : startInlineAltEdit;
        const cells = panelEl.querySelectorAll(`[data-${col}-edit]`);
        let foundCurrent = false;
        for (const cell of cells) {
            const id = Number(cell.dataset.instrId);
            if (foundCurrent) {
                cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => opener(cell, missionId), 100);
                return;
            }
            if (id === currentInstrId) foundCurrent = true;
        }
    }

    function wireDetailEvents(missionId, row, filteredSteps, allSteps) {
        const unit = panelState.distanceUnit;
        panelEl.querySelector('[data-back]').onclick = () => {
            panelState.detailFilter = new Set();
            renderTableView();
        };
        // Copy mission name
        const titleEl = panelEl.querySelector('[data-detail-name]');
        if (titleEl) titleEl.onclick = () => {
            copyToClipboard(titleEl.dataset.detailName);
            showToast(`Copied: ${titleEl.dataset.detailName}`, '#5fff5f');
        };
        // Open in AIM editor — find the actual mission link in Percepto's
        // sidebar and click it. This uses Percepto's own React router so
        // it works regardless of iframe sandbox restrictions.
        const editBtn = panelEl.querySelector('[data-open-editor]');
        if (editBtn) editBtn.onclick = () => {
            const mid = editBtn.dataset.openEditor;
            if (!mid) return;
            const link = document.querySelector(`a[href*="/mission-bank/${mid}"]`);
            if (link) {
                link.click();
                // Pan to the pad AFTER the editor finishes opening — panning during
                // the navigation re-render hung the renderer (RESULT_CODE_HUNG).
                setTimeout(() => { try { panToMission(mid); } catch (e) {} }, 800);
            } else {
                showToast('Mission link not found in sidebar — try scrolling to it first', '#ff9800');
            }
        };
        // Unit toggle on detail
        panelEl.querySelectorAll('[data-unit-d]').forEach(b => {
            b.onclick = () => {
                panelState.distanceUnit = b.dataset.unitD;
                gmSet(CACHE_KEY_DISTANCE_UNIT, panelState.distanceUnit);
                renderDetailView(missionId);
            };
        });
        // Step-type filter chips — left-click multi-select toggle ("__all"
        // clears). Right-click (M2) solos that type only — like Site Setup SUM.
        panelEl.querySelectorAll('[data-step-filter]').forEach(b => {
            b.onclick = () => {
                const key = b.dataset.stepFilter;
                if (key === '__all') {
                    panelState.detailFilter = new Set();
                } else {
                    const f = panelState.detailFilter;
                    if (f.has(key)) f.delete(key);
                    else f.add(key);
                    // If all types are now selected, same as "all" — clear the set
                }
                renderDetailView(missionId);
            };
            b.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const key = b.dataset.stepFilter;
                // M2 on "All" clears; M2 on a type selects ONLY that type.
                panelState.detailFilter = (key === '__all') ? new Set() : new Set([key]);
                renderDetailView(missionId);
            };
        });
        // Click-to-copy on stat cards
        panelEl.querySelectorAll('.aim-mb-stat-clickable').forEach(el => {
            el.onclick = () => {
                const v = el.dataset.copy;
                if (v == null || v === 'null' || v === 'undefined') return;
                copyToClipboard(v);
                showToast(`Copied: ${v}`, '#5fff5f');
            };
        });
        // 🔭 binoculars → center map on GPS coords
        panelEl.querySelectorAll('.aim-mb-step-focus').forEach(el => {
            el.onclick = () => {
                const lat = Number(el.dataset.centerLat);
                const lng = Number(el.dataset.centerLng);
                if (!isNaN(lat) && !isNaN(lng)) {
                    const ok = centerMapOn(lat, lng);
                    if (ok) showToast(`Map centered on step`, '#14d2dc');
                    else showToast('Map not available', '#ff9800');
                }
            };
        });
        // ✏️ icon → open this instruction in Percepto's editor
        panelEl.querySelectorAll('.aim-mb-step-edit').forEach(el => {
            el.onclick = () => {
                const instrId = el.dataset.editInstr;
                if (instrId) openInstructionEditor(instrId, missionId);
            };
        });
        // Inline altitude edit — click cell → input → Enter/blur to queue
        panelEl.querySelectorAll('[data-alt-edit]').forEach(el => {
            el.onclick = (e) => {
                e.stopPropagation();
                startInlineAltEdit(el, missionId);
            };
            // Right-click copies the raw altitude (pending value if there
            // is one, otherwise original). Tooltip already advertises this.
            el.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const instrId = Number(el.dataset.instrId);
                const pending = getPendingChange(missionId, instrId);
                const raw = pending ? String(Math.round(pending.value)) : String(el.dataset.origAlt);
                copyToClipboard(raw);
                showToast(`Copied: ${raw}`, '#5fff5f');
            };
        });
        // Commit pending changes
        const fastSaveCb = panelEl.querySelector('[data-fast-save]');
        if (fastSaveCb) fastSaveCb.onchange = () => {
            fastBulkSave = !!fastSaveCb.checked;
            showToast(fastBulkSave
                ? '⚡ Fast bulk save ON — staged changes apply when you Save the mission'
                : 'Fast bulk save OFF — back to per-step Commit', fastBulkSave ? '#14d2dc' : '#888', 4000);
            renderDetailView(missionId);
        };
        const commitBtn = panelEl.querySelector('[data-commit-pending]');
        if (commitBtn) commitBtn.onclick = () => {
            const n = countPending(missionId);
            if (n > 5 && !confirm(`Commit ${n} altitude changes? This opens each step in the editor, sets the value, and clicks Save on the step — ~2s per step. You still save the overall mission yourself afterward.`)) return;
            commitPendingChanges(missionId);
        };
        // Discard pending changes
        const discardBtn = panelEl.querySelector('[data-discard-pending]');
        if (discardBtn) discardBtn.onclick = () => {
            if (!confirm(`Discard ${countPending(missionId)} pending altitude changes?`)) return;
            discardAllPendingFor(missionId);
            renderDetailView(missionId);
        };
        // Altitude click-to-copy: raw whole number only (no comma, no ft, no ALT)
        panelEl.querySelectorAll('[data-alt-raw]').forEach(el => {
            el.onclick = () => {
                copyToClipboard(el.dataset.altRaw);
                showToast(`Copied: ${el.dataset.altRaw}`, '#5fff5f');
            };
        });
        // Elevation click-to-copy: raw whole number, no comma, no unit.
        // Both left-click and right-click copy (consistent with altitude
        // right-click). preventDefault stops the browser context menu.
        panelEl.querySelectorAll('[data-elev-raw]').forEach(el => {
            const copy = (e) => {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                copyToClipboard(el.dataset.elevRaw);
                showToast(`Copied: ${el.dataset.elevRaw}`, '#5fff5f');
            };
            el.onclick = copy;
            el.oncontextmenu = copy;
        });
        // AGL Δ cell — left-click edits AGL (back-solves altitude = ground + AGL),
        // right-click copies the raw value. Mirrors the Value cell + Site Setup SUM.
        panelEl.querySelectorAll('[data-agl-edit]').forEach(el => {
            el.onclick = (e) => {
                e.stopPropagation();
                startInlineAglEdit(el, missionId);
            };
            el.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                copyToClipboard(el.dataset.aglRaw);
                showToast(`Copied: ${el.dataset.aglRaw}`, '#5fff5f');
            };
        });
        // Row-selection checkboxes (per editable step) — drive Bulk scope.
        if (!panelState.detailSelection) panelState.detailSelection = new Set();
        panelEl.querySelectorAll('[data-sel-row]').forEach(cb => {
            cb.onclick = (e) => e.stopPropagation();
            cb.onchange = () => {
                const id = Number(cb.dataset.instrId);
                if (cb.checked) panelState.detailSelection.add(id);
                else panelState.detailSelection.delete(id);
                renderDetailView(missionId);
            };
        });
        // Select-all — toggles every editable step currently visible (respects filter).
        const selAll = panelEl.querySelector('[data-sel-all]');
        if (selAll) {
            const editableVisible = filteredSteps.filter(stepAltEditable);
            selAll.checked = editableVisible.length > 0 && editableVisible.every(s => panelState.detailSelection.has(s.id));
            selAll.onclick = (e) => e.stopPropagation();
            selAll.onchange = () => {
                if (selAll.checked) editableVisible.forEach(s => panelState.detailSelection.add(s.id));
                else editableVisible.forEach(s => panelState.detailSelection.delete(s.id));
                renderDetailView(missionId);
            };
        }
        // Bulk → AGL / Bulk → ALT buttons.
        panelEl.querySelectorAll('[data-bulk]').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                openBulkPopover(b, missionId, filteredSteps, b.dataset.bulk);
            };
        });
        // Lat / Long cells — click or right-click copies the raw number.
        // (M1-edit to move the waypoint is a planned fast-follow.)
        panelEl.querySelectorAll('.aim-mb-latlng').forEach(el => {
            const copy = (e) => {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                copyToClipboard(el.dataset.coordVal);
                showToast(`Copied: ${el.dataset.coordVal}`, '#5fff5f');
            };
            el.onclick = copy;
            el.oncontextmenu = copy;
        });
        // GPS cell — left-click opens the Google Maps link in a new tab,
        // right-click copies the link.
        panelEl.querySelectorAll('.aim-mb-gps').forEach(el => {
            el.onclick = (e) => {
                e.preventDefault();
                const url = el.dataset.mapsUrl;
                if (!url) return;
                let opened = null;
                try { opened = (window.top || window).open(url, '_blank'); }
                catch (er) { opened = null; }
                if (!opened) {
                    copyToClipboard(url);
                    showToast(`Popup blocked. Copied link: ${url}`, '#ff9800');
                }
            };
            el.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const url = el.dataset.mapsUrl;
                if (url) {
                    copyToClipboard(url);
                    showToast('Copied Maps link', '#5fff5f');
                }
            };
        });
        // Export visible instructions → Sheets (TSV)
        const sheetsBtn = panelEl.querySelector('[data-detail-export="sheets"]');
        if (sheetsBtn) sheetsBtn.onclick = () => exportDetailToSheets(filteredSteps, allSteps, unit, row.name);
        // Export KML
        const kmlBtn = panelEl.querySelector('[data-detail-export="kml"]');
        if (kmlBtn) kmlBtn.onclick = () => exportDetailToKML(row, allSteps, unit);
        // Collapse scan blocks toggle — persist + re-render the detail view.
        const collapseCb = panelEl.querySelector('[data-collapse-blocks]');
        if (collapseCb) collapseCb.onchange = () => {
            collapseScanBlocks = !!collapseCb.checked;
            gmSet(CACHE_KEY_COLLAPSE_BLOCKS, collapseScanBlocks);
            renderDetailView(missionId);
        };
    }

    function startInlineAltEdit(cellSpan, missionId) {
        const instrId = Number(cellSpan.dataset.instrId);
        const origAlt = Number(cellSpan.dataset.origAlt);
        const pending = getPendingChange(missionId, instrId);
        const startVal = pending ? Math.round(pending.value) : origAlt;
        const unit = panelState.distanceUnit;
        const unitLabel = unit === 'imperial' ? 'ft' : 'm';
        // Use text input so formulas like "2974+15" are accepted
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'aim-mb-alt-input';
        input.value = startVal;
        input.title = 'Type a number, or a formula like 2974+15 or (2974+15)*2';
        cellSpan.replaceWith(input);
        input.focus();
        input.select();
        let advanceAfter = false;
        const commit = () => {
            const v = parseFormulaValue(input.value);
            if (isNaN(v)) {
                showToast('Invalid value or formula', '#ff5252');
                renderDetailView(missionId);
                return;
            }
            const rounded = Math.round(v);
            const adv = advanceAfter ? { focusNextAfter: instrId, focusColumn: 'alt' } : null;
            if (rounded === origAlt) {
                discardPendingChange(missionId, instrId);
                renderDetailView(missionId, adv);
                return;
            }
            queueAltitudeChange(missionId, instrId, rounded, unit);
            showToast(`Queued: step ${instrId} → ${rounded} ${unitLabel}`, '#ff9800');
            renderDetailView(missionId, adv);
        };
        input.onblur = commit;
        input.onkeydown = (e) => {
            // Enter = done (commit, no advance). Tab = commit + advance to the
            // next editable cell in the SAME column.
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                // stopPropagation: this key belongs to our inline editor, NOT the
                // Quick Mission Editor's document-level Enter handler (which would
                // otherwise pop its move dialog). We blur() synchronously below, so
                // by the time the event bubbled to QME, activeElement would no
                // longer be this input and QME's guard would miss it.
                e.stopPropagation();
                advanceAfter = (e.key === 'Tab');
                input.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                input.onblur = null;
                renderDetailView(missionId);
            }
        };
    }

    // Parse a number OR a math formula (e.g. "2974+15", "(2974+15)*2").
    // Strips any non-math chars before eval — only digits, dot, +, -, *,
    // /, parens, spaces are allowed.
    function parseFormulaValue(s) {
        if (s == null) return NaN;
        const trimmed = String(s).trim();
        if (!trimmed) return NaN;
        if (/[+\-*/()]/.test(trimmed)) {
            const clean = trimmed.replace(/[^0-9.+\-*/()\s]/g, '');
            if (!clean) return NaN;
            try {
                const result = Function(`"use strict"; return (${clean})`)();
                return Number(result);
            } catch (e) { return NaN; }
        }
        return Number(trimmed);
    }

    // Inline edit of the AGL Δ cell. The user types a target AGL (clearance
    // above ground); we back-solve altitude = ground elevation + AGL and queue
    // it as an ordinary altitude change, so it rides the same queue / Commit /
    // ⚡ fast-save pipeline as a direct Value edit. Mirrors the Site Setup SUM,
    // where editing AGL writes Min Alt = Elevation + AGL.
    function startInlineAglEdit(cellSpan, missionId) {
        const instrId = Number(cellSpan.dataset.instrId);
        const elevM = Number(cellSpan.dataset.elevM);
        const origAlt = Number(cellSpan.dataset.origAlt);      // original altitude, display units
        const startAgl = Number(cellSpan.dataset.aglCur);      // current (effective) AGL, display units
        if (!isFinite(elevM)) { showToast('Ground elevation not loaded yet — try again in a moment', '#ff9800'); return; }
        const unit = panelState.distanceUnit;
        const unitLabel = unit === 'imperial' ? 'ft' : 'm';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'aim-mb-alt-input';
        input.value = isFinite(startAgl) ? startAgl : '';
        input.title = `Target AGL in ${unitLabel}. Altitude becomes ground + this. Formulas like 100+10 work.`;
        cellSpan.replaceWith(input);
        input.focus();
        input.select();
        let advanceAfter = false;
        const commit = () => {
            const agl = parseFormulaValue(input.value);
            if (isNaN(agl)) {
                showToast('Invalid value or formula', '#ff5252');
                renderDetailView(missionId);
                return;
            }
            // target AGL (display) → meters → altitude meters → display altitude
            const targetAglM = unit === 'imperial' ? (agl / 3.28084) : agl;
            const newAltM = elevM + targetAglM;
            const newAltDisp = unit === 'imperial' ? Math.round(newAltM * 3.28084) : Math.round(newAltM);
            const adv = advanceAfter ? { focusNextAfter: instrId, focusColumn: 'agl' } : null;
            if (newAltDisp === origAlt) {
                discardPendingChange(missionId, instrId);
                renderDetailView(missionId, adv);
                return;
            }
            queueAltitudeChange(missionId, instrId, newAltDisp, unit);
            showToast(`Queued: step ${instrId} → ${Math.round(agl)} ${unitLabel} AGL (alt ${newAltDisp.toLocaleString()} ${unitLabel})`, '#ff9800', 4000);
            renderDetailView(missionId, adv);
        };
        input.onblur = commit;
        input.onkeydown = (e) => {
            // Enter = done; Tab = commit + advance to the next AGL cell.
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();   // belongs to our editor, not QME's document-level Enter
                advanceAfter = (e.key === 'Tab');
                input.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                input.onblur = null;
                renderDetailView(missionId);
            }
        };
    }

    // ── Bulk → AGL / Bulk → ALT ─────────────────────────────────────────────
    // Scope rule (matches Site Setup SUM): if any rows are checked, act on the
    // selection; otherwise act on ALL editable steps currently visible (the
    // active type filter is respected). Everything queues through the existing
    // pipeline, so the same Commit / ⚡ fast-save / safety model applies.
    let bulkPopoverEl = null;
    function closeBulkPopover() {
        if (bulkPopoverEl) { bulkPopoverEl.remove(); bulkPopoverEl = null; }
        document.removeEventListener('mousedown', bulkOutsideClose, true);
    }
    function bulkOutsideClose(e) {
        if (bulkPopoverEl && !bulkPopoverEl.contains(e.target)) closeBulkPopover();
    }
    function bulkScopedSteps(filteredSteps) {
        const sel = panelState.detailSelection || new Set();
        const editable = filteredSteps.filter(stepAltEditable);
        return sel.size ? editable.filter(s => sel.has(s.id)) : editable;
    }
    function openBulkPopover(anchorBtn, missionId, filteredSteps, mode) {
        closeBulkPopover();
        const unit = panelState.distanceUnit;
        const unitLabel = unit === 'imperial' ? 'ft' : 'm';
        const sel = panelState.detailSelection || new Set();
        const scoped = bulkScopedSteps(filteredSteps);
        const eligible = (mode === 'agl') ? scoped.filter(s => stepElevM(s) != null) : scoped;
        const skipNoElev = scoped.length - eligible.length;
        const scopeWord = sel.size ? 'selected' : 'visible editable';
        const title = mode === 'agl' ? 'Bulk → AGL' : 'Bulk → ALT';
        const hint = mode === 'agl'
            ? `Sets each step's altitude to its own ground elevation + this AGL (${unitLabel}).`
            : `Sets each step's altitude to this absolute value (${unitLabel}).`;
        const pop = document.createElement('div');
        pop.className = 'aim-mb-bp-pop';
        pop.innerHTML = `
            <div class="aim-mb-menu-head"><span class="aim-mb-menu-title">${title}</span><button class="aim-mb-menu-close" data-bp-close>✕</button></div>
            <div style="padding:10px 12px;">
                <div style="font-size:11px;color:#aaa;margin-bottom:8px;">${hint}</div>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <label style="flex:1;font-size:11px;">Target ${mode === 'agl' ? 'AGL' : 'altitude'} (${unitLabel})</label>
                    <input type="text" data-bp-input placeholder="${mode === 'agl' ? 'e.g. 100' : 'e.g. 2700'}" style="width:90px;">
                </div>
                <div style="font-size:11px;color:#888;margin:4px 0 10px;">Applies to <strong style="color:#ffd54f;">${eligible.length} ${scopeWord}</strong> step${eligible.length === 1 ? '' : 's'}${skipNoElev ? ` · ${skipNoElev} skipped (no elevation yet)` : ''}</div>
                <div style="display:flex;gap:6px;justify-content:flex-end;">
                    <button class="aim-mb-tbtn" data-bp-cancel>Cancel</button>
                    <button class="aim-mb-bulk-btn" data-bp-apply>Queue ${eligible.length} edit${eligible.length === 1 ? '' : 's'}</button>
                </div>
            </div>`;
        document.body.appendChild(pop);
        bulkPopoverEl = pop;
        // Position below the button, clamped into the viewport.
        const r = anchorBtn.getBoundingClientRect();
        pop.style.top = (r.bottom + 4) + 'px';
        pop.style.left = r.left + 'px';
        const pr = pop.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8) pop.style.left = Math.max(8, window.innerWidth - 8 - pr.width) + 'px';
        if (pr.bottom > window.innerHeight - 8) pop.style.top = Math.max(8, r.top - pr.height - 4) + 'px';
        const input = pop.querySelector('[data-bp-input]');
        input.focus();
        const doApply = () => applyBulk(mode, input.value, missionId, filteredSteps);
        pop.querySelector('[data-bp-apply]').onclick = doApply;
        pop.querySelector('[data-bp-cancel]').onclick = closeBulkPopover;
        pop.querySelector('[data-bp-close]').onclick = closeBulkPopover;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doApply(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBulkPopover(); }
        };
        // Defer so the click that opened the popover doesn't immediately close it.
        setTimeout(() => document.addEventListener('mousedown', bulkOutsideClose, true), 0);
    }
    function applyBulk(mode, rawInput, missionId, filteredSteps) {
        const v = parseFormulaValue(rawInput);
        if (isNaN(v)) { showToast('Invalid value or formula', '#ff5252'); return; }
        const unit = panelState.distanceUnit;
        const toM = (d) => unit === 'imperial' ? (d / 3.28084) : d;
        const scoped = bulkScopedSteps(filteredSteps);
        let queued = 0, skipped = 0;
        scoped.forEach(s => {
            let newAltM;
            if (mode === 'agl') {
                const elevM = stepElevM(s);
                if (elevM == null) { skipped++; return; }
                newAltM = elevM + toM(v);
            } else {
                newAltM = toM(v);
            }
            const newDisp = unit === 'imperial' ? Math.round(newAltM * 3.28084) : Math.round(newAltM);
            const origDisp = unit === 'imperial' ? Math.round(s.value1 * 3.28084) : Math.round(s.value1);
            if (newDisp === origDisp) { discardPendingChange(missionId, s.id); skipped++; return; }
            queueAltitudeChange(missionId, s.id, newDisp, unit);
            queued++;
        });
        closeBulkPopover();
        showToast(`Bulk → ${mode.toUpperCase()}: queued ${queued}${skipped ? ` · skipped ${skipped}` : ''}`, queued ? '#ff9800' : '#888', 4500);
        renderDetailView(missionId);
    }

    function exportDetailToSheets(filteredSteps, allSteps, unit, missionName) {
        const lines = ['Step\tType\tValue\tLocation'];
        filteredSteps.forEach(s => {
            const origIdx = allSteps.indexOf(s) + 1;
            const type = displayStepType(s);
            const val = displayStepValue(s, unit);
            let loc = '';
            if (s.location && typeof s.location === 'object' && s.location.lat != null) {
                loc = `${Number(s.location.lat).toFixed(5)}, ${Number(s.location.lng).toFixed(5)}`;
            }
            lines.push(`${origIdx}\t${type}\t${val}\t${loc}`);
        });
        copyToClipboard(lines.join('\n'));
        showToast(`Copied ${filteredSteps.length} steps → Sheets`, '#5fff5f');
    }

    // ── KML export (shared by the SUM drill-down + the map-edit row) ──────
    // value2 on a navigate is ground speed in m/s; ×2.23694 = mph.
    function kmlSpeedMph(s) {
        const v = s && s.value2;
        return (typeof v === 'number' && v > 0) ? Math.round(v * 2.23694) : null;
    }
    // One bundled (non-located) step as a description line — mirrors the
    // editor's compact-card labels (Thermal/GEM On/Off, Wait Ns).
    function kmlBundledLine(s) {
        const t = s.type_name;
        if (t === 'cameraSelect') return s.value1 ? 'Thermal On' : 'Thermal Off';
        if (t === 'gemMode') return Number(s.value1) === 1 ? 'GEM On' : 'GEM Off';
        if (t === 'wait') return `Wait ${Math.round(Number(s.value1) || 0)}s`;
        return displayStepType(s);
    }
    // value1 is the stored (absolute MSL) altitude in meters → "X ft (Y m)".
    function kmlAltText(s) {
        if (s.value1 == null || s.value1_name !== 'm' || typeof s.value1 !== 'number') return '—';
        return `${Math.round(s.value1 * 3.28084).toLocaleString()} ft (${Math.round(s.value1)} m)`;
    }
    function kmlAltM(s) {
        return (typeof s.value1 === 'number' && s.value1_name === 'm') ? s.value1 : 0;
    }
    // Hex #rrggbb → KML aabbggrr (KML byte order is reversed). Used so the
    // pins/labels match the user's AIM step colors (nav blue / snap pink).
    function hexToKmlColor(hex, alpha) {
        const c = String(hex || '').replace('#', '');
        if (c.length < 6) return 'ff00ffff';
        return `${alpha || 'ff'}${c.slice(4, 6)}${c.slice(2, 4)}${c.slice(0, 2)}`.toLowerCase();
    }

    // Capture AIM's REAL routed flight path off the map: Percepto draws it as
    // white DASHED <path> elements in the Leaflet overlay SVG, whose `d` coords
    // are layer points → invert via map.layerPointToLatLng to recover lat/lng
    // (the route follows the FPs/FFZs, base→steps→back). Returns an array of
    // lat/lng polylines, or null if the map/path isn't readable.
    function captureFlightRoutes() {
        try {
            const map = getLeafletMap();
            if (!map || typeof map.layerPointToLatLng !== 'function') return null;
            const sel = 'path.leaflet-interactive[stroke="white"],path.leaflet-interactive[stroke="#fff"],path.leaflet-interactive[stroke="#ffffff"]';
            const paths = document.querySelectorAll(sel);
            const routes = [];
            paths.forEach(p => {
                const dash = p.getAttribute('stroke-dasharray') || '';
                if (!/\d/.test(dash)) return; // the flight path is dashed; skip solid strokes
                const d = p.getAttribute('d'); if (!d) return;
                const pts = [];
                const re = /(-?\d*\.?\d+)[ ,]+(-?\d*\.?\d+)/g; let m;
                while ((m = re.exec(d)) !== null) pts.push([parseFloat(m[1]), parseFloat(m[2])]);
                if (pts.length < 2) return;
                const ll = [];
                for (const pt of pts) {
                    try { const g = map.layerPointToLatLng(pt); if (g && isFinite(g.lat) && isFinite(g.lng)) ll.push({ lat: g.lat, lng: g.lng }); } catch (e) {}
                }
                if (ll.length >= 2) routes.push(ll);
            });
            return routes.length ? routes : null;
        } catch (e) { console.warn(`${TAG} [kml] route capture failed`, e); return null; }
    }

    // Build a Google-Earth KML for an ordered list of mission steps:
    //   • a WHITE Flight Path line nav→nav (the real drone route),
    //   • PURPLE sightlines nav→each of its snapshots (what it's looking at),
    //     labeled with the nav↔snapshot standoff distance (ideal ~100 ft),
    //   • N# pins (blue) whose description is the WHOLE stop — nav params + its
    //     snapshots (with distances) and their Thermal/GEM/Wait scan steps,
    //   • S# pins (pink) whose description is alt + distance-from-nav + scans.
    function buildMissionKml(missionName, ordered, opts) {
        opts = opts || {};
        let navN = 0, snapN = 0;
        const stops = [];      // { nav, navNum, snaps:[snapBlock] }
        const snapBlocks = []; // { snap, snapNum, scans, parentNav, parentNavNum, distFt }
        let curStop = null, curSnapBlock = null;
        ordered.forEach(s => {
            const t = s.type_name;
            if (t === 'navigate') {
                navN++;
                curStop = { nav: s, navNum: navN, snaps: [] };
                stops.push(curStop); curSnapBlock = null;
            } else if (t === 'snapshot') {
                snapN++;
                curSnapBlock = {
                    snap: s, snapNum: snapN, scans: [],
                    parentNav: curStop ? curStop.nav : null,
                    parentNavNum: curStop ? curStop.navNum : null, distFt: null,
                };
                // Horizontal nav↔snapshot standoff (the ~100 ft the user checks).
                const pn = curSnapBlock.parentNav;
                if (pn && pn.location && pn.location.lat != null && s.location && s.location.lat != null) {
                    curSnapBlock.distFt = Math.round(sopHaversineFt(pn.location, s.location));
                }
                snapBlocks.push(curSnapBlock);
                if (curStop) curStop.snaps.push(curSnapBlock);
            } else {
                if (curSnapBlock) curSnapBlock.scans.push(s);
            }
        });

        const navsLoc = stops.map(st => st.nav).filter(n => n.location && n.location.lat != null);
        const anySnap = snapBlocks.some(sb => sb.snap.location && sb.snap.location.lat != null);
        if (!navsLoc.length && !anySnap) return null;

        // Flight path: prefer the REAL routed path captured from AIM's map (the
        // white dashed line that follows the FPs/FFZs, base→steps→back). Fall
        // back to a straight nav→nav line when it isn't readable (e.g. the SUM
        // export, where the open map may be a different mission).
        let pathPlacemark = '';
        if (opts.routes && opts.routes.length) {
            // The captured route is 2D (lat/lng only). Raise each vertex to the
            // altitude of the NEAREST navigate so the line rides up with the nav
            // pins instead of snapping to the ground.
            const navAlts = navsLoc.map(n => ({ lat: Number(n.location.lat), lng: Number(n.location.lng), alt: kmlAltM(n) }));
            const altForPoint = (p) => {
                let best = 0, bd = Infinity;
                for (const na of navAlts) { const a = na.lat - p.lat, b = na.lng - p.lng, d = a * a + b * b; if (d < bd) { bd = d; best = na.alt; } }
                return best;
            };
            const mode = navAlts.length ? 'absolute' : 'clampToGround';
            pathPlacemark = opts.routes.map((route, i) => {
                const coords = route.map(p => `${p.lng},${p.lat},${altForPoint(p)}`).join(' ');
                return `    <Placemark>
      <name>Flight Path${opts.routes.length > 1 ? ' ' + (i + 1) : ''}</name>
      <styleUrl>#style-path</styleUrl>
      <LineString><tessellate>1</tessellate><altitudeMode>${mode}</altitudeMode><coordinates>${coords}</coordinates></LineString>
    </Placemark>`;
            }).join('\n');
        } else if (navsLoc.length >= 2) {
            const pathCoords = navsLoc.map(n => `${Number(n.location.lng)},${Number(n.location.lat)},${kmlAltM(n)}`).join(' ');
            pathPlacemark = `    <Placemark>
      <name>Flight Path (straight nav→nav)</name>
      <styleUrl>#style-path</styleUrl>
      <LineString><tessellate>1</tessellate><altitudeMode>absolute</altitudeMode><coordinates>${pathCoords}</coordinates></LineString>
    </Placemark>`;
        }

        // PURPLE sightlines: nav → each of its snapshots, named with distance.
        const lookPlacemarks = snapBlocks.map(sb => {
            const n = sb.parentNav, s = sb.snap;
            if (!n || !n.location || n.location.lat == null || !s.location || s.location.lat == null) return '';
            const coords = `${Number(n.location.lng)},${Number(n.location.lat)},${kmlAltM(n)} ${Number(s.location.lng)},${Number(s.location.lat)},${kmlAltM(s)}`;
            const dTxt = sb.distFt != null ? ` · ${sb.distFt.toLocaleString()} ft` : '';
            return `    <Placemark>
      <name>N${sb.parentNavNum}→S${sb.snapNum}${dTxt}</name>
      <styleUrl>#style-look</styleUrl>
      <LineString><tessellate>1</tessellate><altitudeMode>absolute</altitudeMode><coordinates>${coords}</coordinates></LineString>
    </Placemark>`;
        }).filter(Boolean).join('\n');

        // Navigate pins — description carries the whole stop (with distances).
        const navPlacemarks = stops.map(st => {
            const s = st.nav;
            if (!s.location || s.location.lat == null) return '';
            const mph = kmlSpeedMph(s);
            let html = `<b>Stop N${st.navNum}</b><br/>Altitude: ${kmlAltText(s)}<br/>`;
            if (mph != null) html += `Speed: ${mph} mph<br/>`;
            if (st.snaps.length) {
                html += `<br/><b>Snapshots in this stop:</b><br/>`;
                st.snaps.forEach(sb => {
                    const d = sb.distFt != null ? ` — ${sb.distFt.toLocaleString()} ft away` : '';
                    html += `S${sb.snapNum} — ${kmlAltText(sb.snap)}${d}<br/>`;
                    sb.scans.forEach(sc => { html += `&nbsp;&nbsp;${kmlBundledLine(sc)}<br/>`; });
                });
            }
            return `    <Placemark>
      <name>N${st.navNum}</name>
      <description><![CDATA[${html}]]></description>
      <styleUrl>#style-nav</styleUrl>
      <Point><altitudeMode>absolute</altitudeMode><coordinates>${Number(s.location.lng)},${Number(s.location.lat)},${kmlAltM(s)}</coordinates></Point>
    </Placemark>`;
        }).filter(Boolean).join('\n');

        // Snapshot pins — description = alt + distance-from-nav + scan steps.
        const snapPlacemarks = snapBlocks.map(sb => {
            const s = sb.snap;
            if (!s.location || s.location.lat == null) return '';
            let html = `<b>Snapshot S${sb.snapNum}</b><br/>Altitude: ${kmlAltText(s)}<br/>`;
            if (sb.parentNavNum != null && sb.distFt != null) html += `Distance from N${sb.parentNavNum}: ${sb.distFt.toLocaleString()} ft<br/>`;
            if (sb.scans.length) {
                html += `<br/><b>Scan steps:</b><br/>`;
                sb.scans.forEach(sc => { html += `${kmlBundledLine(sc)}<br/>`; });
            }
            return `    <Placemark>
      <name>S${sb.snapNum}</name>
      <description><![CDATA[${html}]]></description>
      <styleUrl>#style-snap</styleUrl>
      <Point><altitudeMode>absolute</altitudeMode><coordinates>${Number(s.location.lng)},${Number(s.location.lat)},${kmlAltM(s)}</coordinates></Point>
    </Placemark>`;
        }).filter(Boolean).join('\n');

        // White pushpin icon + color tint = the exact AIM color (tinting the
        // default colored pin is unreliable; a white pin takes the tint cleanly).
        const navColor = hexToKmlColor(stepColor('nav'));
        const snapColor = hexToKmlColor(stepColor('snap'));
        const PIN = 'http://maps.google.com/mapfiles/kml/pushpin/wht-pushpin.png';
        // Title: "Site <id> - <site name> - <mission name>".
        const sid = getCurrentSiteID(), sname = getCurrentSiteName();
        const titleParts = [];
        if (sid) titleParts.push(`Site ${sid}`);
        if (sname) titleParts.push(sname);
        titleParts.push(missionName || 'Mission');
        const docName = titleParts.join(' - ');
        const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(docName)}</name>
    <description>White line = flight path (nav→nav). Purple lines = nav→snapshot sightlines (labeled with distance). Blue/pink pins carry per-stop step detail. Exported by AIM Mission Bank Tools v${SCRIPT_VERSION}.</description>
    <Style id="style-nav"><IconStyle><color>${navColor}</color><scale>1.1</scale><Icon><href>${PIN}</href></Icon></IconStyle><LabelStyle><color>${navColor}</color></LabelStyle></Style>
    <Style id="style-snap"><IconStyle><color>${snapColor}</color><scale>1.1</scale><Icon><href>${PIN}</href></Icon></IconStyle><LabelStyle><color>${snapColor}</color></LabelStyle></Style>
    <Style id="style-path"><LineStyle><color>ffffffff</color><width>3</width></LineStyle></Style>
    <Style id="style-look"><LineStyle><color>ffe24db0</color><width>1.6</width></LineStyle></Style>
    <Folder><name>Flight Path</name>
${pathPlacemark}
    </Folder>
    <Folder><name>Sightlines — Nav → Snapshot</name>
${lookPlacemarks}
    </Folder>
    <Folder><name>Navigates (${stops.length})</name>
${navPlacemarks}
    </Folder>
    <Folder><name>Snapshots (${snapBlocks.length})</name>
${snapPlacemarks}
    </Folder>
  </Document>
</kml>`;
        return { kml, navCount: stops.length, snapCount: snapBlocks.length, usedRoute: !!(opts.routes && opts.routes.length) };
    }

    // Download the KML (try top frame first to dodge the iframe sandbox, then
    // this frame, then clipboard as a last resort).
    function downloadKmlFile(missionName, kml) {
        const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
        const blobUrl = URL.createObjectURL(blob);
        const safeName = ((missionName || 'mission').replace(/[^a-zA-Z0-9_\- ]/g, '').trim()) || 'mission';
        let downloaded = false;
        for (const doc of [(window.top || window).document, document]) {
            if (downloaded) break;
            try {
                const a = doc.createElement('a');
                a.href = blobUrl; a.download = `${safeName}_flightpath.kml`;
                (doc.body || document.body).appendChild(a); a.click(); a.remove();
                downloaded = true;
            } catch (e) {}
        }
        if (!downloaded) { copyToClipboard(kml); showToast('Download blocked. KML copied to clipboard — paste into a .kml file.', '#ff9800'); }
        setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 5000);
        return downloaded;
    }

    function exportDetailToKML(row, allSteps) {
        const built = buildMissionKml(row && row.name, allSteps || []);
        if (!built) { showToast('No GPS steps (navigate/snapshot) to export.', '#ff9800'); return; }
        if (downloadKmlFile(row && row.name, built.kml)) showToast(`Exported KML — ${built.navCount} stops · ${built.snapCount} snapshots`, '#5fff5f');
    }

    // Map-edit row: export the mission currently open in the native editor,
    // using the LIVE on-screen order (so an unsaved reorder still exports right).
    function exportOpenMissionKml() {
        if (!composerMission) { showToast('Open a mission first (hit 🔄 to load it).', '#ff9800'); return; }
        const ordered = composerCurrentOrdered();
        if (!ordered.length) { showToast('Could not read the open mission steps.', '#ff9800'); return; }
        const routes = captureFlightRoutes(); // AIM's real routed path off the map
        const built = buildMissionKml(composerMission.name, ordered, { routes });
        if (!built) { showToast('No GPS steps (navigate/snapshot) to export.', '#ff9800'); return; }
        if (downloadKmlFile(composerMission.name, built.kml)) {
            const path = built.usedRoute ? 'real routed path' : 'straight nav→nav path (couldn\'t read the routed line)';
            showToast(`Exported KML — ${built.navCount} stops · ${built.snapCount} snapshots · ${path}`, '#5fff5f', 4500);
        }
    }

    // Center the Leaflet map on a lat/lng. The map lives in the same
    // iframe document. Uses the __aim_map__ property set by Map Styler's
    // prototype patch, or walks the container's properties as fallback.
    function centerMapOn(lat, lng) {
        try {
            const container = document.querySelector('.leaflet-container');
            if (!container) return false;
            let map = container.__aim_map__ || null;
            if (!map) {
                for (const key of Object.keys(container)) {
                    const v = container[key];
                    if (v && typeof v === 'object' && typeof v.setView === 'function' && typeof v.getZoom === 'function') {
                        map = v; break;
                    }
                }
            }
            if (!map) return false;
            map.setView([lat, lng], Math.max(map.getZoom(), 17));
            return true;
        } catch (e) { return false; }
    }

    // Open a specific instruction in Percepto's mission editor.
    // Finds the instruction by its draggable ID, scrolls to it,
    // simulates hover to reveal the three-dots menu, hovers the dots
    // to open the Ant dropdown, then clicks "Edit".
    //
    // The dots + dropdown are hover-triggered (not click), so we must
    // dispatch mouseenter/mouseover/pointermove events to make them
    // appear before we can interact with them.
    function openInstructionEditor(instructionId, missionId) {
        // If an edit dialog is already open, save it first
        const existingEdit = document.querySelector('.edit-instruction');
        if (existingEdit) {
            const saveBtn = document.querySelector('[data-testid="btn-save-instruction"]');
            if (saveBtn) {
                showToast('Saving current step…', '#14d2dc');
                saveBtn.click();
                // Wait for the edit dialog to close, then open the new step
                let waitAttempts = 0;
                const waitInterval = setInterval(() => {
                    waitAttempts++;
                    if (waitAttempts > 20) { clearInterval(waitInterval); navigateAndOpenStep(instructionId, missionId); return; }
                    if (!document.querySelector('.edit-instruction')) {
                        clearInterval(waitInterval);
                        setTimeout(() => navigateAndOpenStep(instructionId, missionId), 300);
                    }
                }, 200);
                return;
            }
        }
        navigateAndOpenStep(instructionId, missionId);
    }

    function navigateAndOpenStep(instructionId, missionId) {
        // Most reliable detection: does the instruction's draggable
        // element exist in the live DOM right now? If yes, the user
        // is already viewing this mission's instructions — skip the
        // sidebar-link click entirely and go straight to the edit.
        const existingDraggable = document.querySelector(`[data-rfd-draggable-id="${instructionId}"]`);
        if (existingDraggable) {
            dlog(`${TAG} [edit] already in mission editor — skipping navigation`);
            showToast('Opening step editor…', '#14d2dc');
            existingDraggable.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => {
                const fiberOk = triggerInstructionAction(existingDraggable, 'edit');
                if (!fiberOk) forceOpenInstructionEdit(existingDraggable);
            }, 200);
            return;
        }
        // Not in editor → navigate via sidebar link
        const link = document.querySelector(`a[href*="/mission-bank/${missionId}"]`);
        if (link) {
            showToast('Opening step editor…', '#14d2dc');
            link.click();
        } else {
            showToast('Mission not found in sidebar', '#ff5252');
            return;
        }
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            if (attempts > 30) { clearInterval(interval); showToast('Could not find instruction in editor — mission may still be loading', '#ff9800'); return; }
            const draggable = document.querySelector(`[data-rfd-draggable-id="${instructionId}"]`);
            if (!draggable) return;
            clearInterval(interval);
            draggable.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => {
                const fiberOk = triggerInstructionAction(draggable, 'edit');
                if (!fiberOk) {
                    dlog(`${TAG} [edit] fiber-walk failed, falling back to dropdown flow`);
                    forceOpenInstructionEdit(draggable);
                }
            }, 500);
        }, 200);
    }

    // CSS :hover can't be triggered programmatically — the three-dots
    // menu is hidden until the user hovers. We force it visible via
    // inline style overrides, click it, wait for the Ant dropdown,
    // click Edit, then clean up our style hacks.
    function injectGlobalEditStyles() {
        // No-op in v0.39. Native dots stay hover-revealed (Percepto
        // default). We never touch Ant's dropdown anymore — Edit/Delete
        // are triggered via React fiber walk, which doesn't disturb the
        // hover state at all. Manual hover for Edit/Delete works
        // normally after a commit.
    }

    // (Stub kept so commitOneChange's existing reference still works,
    // but no longer injects DOM into the React tree.)
    function forceOpenInstructionAction(draggable, actionKey) {
        const instrId = draggable.getAttribute('data-rfd-draggable-id');
        dismissStuckAntDropdowns();
        const dots = draggable.querySelector('[data-testid="btn-instruction-menu"]');
        if (!dots) { showToast('Menu button not found', '#ff9800'); return; }
        draggable.classList.add('aim-mb-force-dots');
        const beforeSet = new Set(Array.from(document.querySelectorAll(`[data-menu-id$="-${actionKey}"]`)));
        let triggerEl = null;
        let el = dots;
        for (let depth = 0; depth < 8 && el; depth++) {
            const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
            if (propsKey) {
                const props = el[propsKey];
                const handlerName = props.onMouseEnter ? 'onMouseEnter' : (props.onMouseOver ? 'onMouseOver' : (props.onClick ? 'onClick' : null));
                if (handlerName) {
                    try {
                        props[handlerName]({ type: handlerName.replace('on','').toLowerCase(), target: el, currentTarget: el, preventDefault(){}, stopPropagation(){}, nativeEvent: new MouseEvent('mouseenter') });
                        triggerEl = el; break;
                    } catch (e) {}
                }
            }
            el = el.parentElement;
        }
        let pollAttempts = 0;
        const poll = setInterval(() => {
            pollAttempts++;
            if (pollAttempts > 20) { clearInterval(poll); draggable.classList.remove('aim-mb-force-dots'); showToast(`${actionKey} dropdown did not appear`, '#ff9800'); return; }
            const candidates = document.querySelectorAll(`[data-menu-id$="-${actionKey}"]`);
            let menuItem = null;
            for (const c of candidates) {
                if (beforeSet.has(c)) continue;
                const dropdown = c.closest('.ant-dropdown');
                if (dropdown && dropdown.classList.contains('ant-dropdown-hidden')) continue;
                menuItem = c; break;
            }
            if (!menuItem) return;
            clearInterval(poll);
            menuItem.click();
            draggable.classList.remove('aim-mb-force-dots');
            setTimeout(() => {
                if (triggerEl) {
                    const propsKey = Object.keys(triggerEl).find(k => k.startsWith('__reactProps$'));
                    if (propsKey && triggerEl[propsKey].onMouseLeave) {
                        try { triggerEl[propsKey].onMouseLeave({ target: triggerEl, preventDefault(){}, stopPropagation(){}, nativeEvent: new MouseEvent('mouseleave') }); } catch (e) {}
                    }
                }
                dismissStuckAntDropdowns();
            }, 100);
        }, 100);
    }

    // Safety: scan for any instruction items still wearing the
    // force-dots class and remove it. Belt-and-suspenders cleanup
    // we can call after each commit step and at queue end.
    function clearAllForceDots() {
        document.querySelectorAll('.aim-mb-force-dots').forEach(el => {
            el.classList.remove('aim-mb-force-dots');
        });
    }

    // Walk the React fiber tree from the dots element to find the Ant
    // Dropdown's menu config. Returns the menu's onClick handler or
    // the items array — whichever is present.
    function findInstructionMenuConfig(dotsEl) {
        const fiberKey = Object.keys(dotsEl).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) return null;
        let fiber = dotsEl[fiberKey];
        let depth = 0;
        while (fiber && depth < 30) {
            const props = fiber.memoizedProps || (fiber.stateNode && fiber.stateNode.props);
            if (props) {
                // Ant Dropdown v5: { menu: { items, onClick } }
                if (props.menu && typeof props.menu === 'object') {
                    if (typeof props.menu.onClick === 'function') {
                        return { kind: 'menuOnClick', handler: props.menu.onClick, depth };
                    }
                    if (Array.isArray(props.menu.items)) {
                        return { kind: 'items', items: props.menu.items, depth };
                    }
                }
                // Ant Dropdown v4: { overlay: Menu, onClick }
                if (typeof props.onSelect === 'function') {
                    return { kind: 'onSelect', handler: props.onSelect, depth };
                }
            }
            fiber = fiber.return;
            depth++;
        }
        return null;
    }

    // Trigger an action ('edit' or 'delete') on a specific instruction
    // by walking the React fiber tree from its dots element and calling
    // the menu handler directly. NEVER opens the Ant dropdown UI, so
    // Ant's hover state is never touched — manual hover keeps working.
    function triggerInstructionAction(draggable, actionKey) {
        const instrId = draggable.getAttribute('data-rfd-draggable-id');
        const dots = draggable.querySelector('[data-testid="btn-instruction-menu"]');
        if (!dots) { console.warn(`${TAG} [fiber] no dots element for instruction ${instrId}`); return false; }
        const cfg = findInstructionMenuConfig(dots);
        if (!cfg) { console.warn(`${TAG} [fiber] no menu config in fiber tree for instruction ${instrId}`); return false; }
        dlog(`${TAG} [fiber] ${instrId}: found ${cfg.kind} at depth ${cfg.depth}`);
        try {
            if (cfg.kind === 'menuOnClick') {
                cfg.handler({ key: actionKey, keyPath: [actionKey], domEvent: { stopPropagation(){}, preventDefault(){} } });
                return true;
            }
            if (cfg.kind === 'onSelect') {
                cfg.handler({ key: actionKey, keyPath: [actionKey] });
                return true;
            }
            if (cfg.kind === 'items') {
                const item = cfg.items.find(i => i && i.key === actionKey);
                if (item && typeof item.onClick === 'function') {
                    item.onClick({ key: actionKey, domEvent: { stopPropagation(){}, preventDefault(){} } });
                    return true;
                }
                console.warn(`${TAG} [fiber] ${instrId}: no '${actionKey}' item; available keys:`, cfg.items.map(i => i && i.key));
                return false;
            }
        } catch (e) {
            console.warn(`${TAG} [fiber] ${instrId}: handler threw:`, e);
            return false;
        }
        return false;
    }

    function forceOpenInstructionEdit(draggable) {
        const instrId = draggable.getAttribute('data-rfd-draggable-id');
        dlog(`${TAG} [edit] starting for instruction ${instrId}`);
        dismissStuckAntDropdowns();
        const dots = draggable.querySelector('[data-testid="btn-instruction-menu"]');
        if (!dots) {
            console.warn(`${TAG} [edit] FAIL: dots element not found for instruction ${instrId}`);
            showToast('Three-dots menu not found', '#ff9800');
            return;
        }
        // Apply the force-show class (no inline style, no restore needed —
        // we just removeClass on cleanup).
        draggable.classList.add('aim-mb-force-dots');

        // Snapshot the dropdown menu Edit items BEFORE triggering hover.
        // Ant reuses a singleton portal — same .ant-dropdown element gets
        // its menu content swapped per trigger. So we identify the
        // "correct" dropdown by finding one whose Edit item is NEW
        // (i.e. didn't exist before our hover, or replaces an old one).
        const editsBefore = new Set(Array.from(document.querySelectorAll('[data-menu-id$="-edit"]')));
        dlog(`${TAG} [edit] ${instrId}: ${editsBefore.size} pre-existing Edit menu items`);

        // 3. Call the React onMouseEnter handler. CRITICAL: save the
        //    exact element we called the handler on, so we can call
        //    the paired onMouseLeave on the SAME element later. Without
        //    this pairing, Ant's "trigger is hovered" state never clears
        //    and manual hover stays broken until page refresh.
        let triggered = false;
        let triggerLevel = -1;
        let triggerHandlerName = null;
        let triggerEl = null; // ← exact element used for enter
        let el = dots;
        for (let depth = 0; depth < 8 && el; depth++) {
            const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
            if (propsKey) {
                const props = el[propsKey];
                const handlerName = props.onMouseEnter ? 'onMouseEnter' : (props.onMouseOver ? 'onMouseOver' : (props.onClick ? 'onClick' : null));
                if (handlerName) {
                    const handler = props[handlerName];
                    const fakeEvent = {
                        type: handlerName.replace('on', '').toLowerCase(), target: el, currentTarget: el,
                        preventDefault() {}, stopPropagation() {},
                        nativeEvent: new MouseEvent('mouseenter'),
                    };
                    try {
                        handler(fakeEvent);
                        triggered = true; triggerLevel = depth; triggerHandlerName = handlerName; triggerEl = el;
                    } catch (e) { console.warn(`${TAG} [edit] ${instrId}: handler ${handlerName} threw:`, e); }
                    if (triggered) break;
                }
            }
            el = el.parentElement;
        }
        if (!triggered) {
            console.warn(`${TAG} [edit] ${instrId}: no React handler found in 8 levels, falling back to DOM click`);
            dots.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } else {
            dlog(`${TAG} [edit] ${instrId}: triggered ${triggerHandlerName} at depth ${triggerLevel}`);
        }

        // 4. Poll for an Edit menu item that's (a) inside a non-hidden
        //    .ant-dropdown, AND (b) wasn't in our pre-trigger snapshot.
        //    This handles Ant's singleton portal reuse: when Ant swaps
        //    the menu content for a new trigger, the OLD Edit DOM node
        //    is detached and a NEW one appears. So "new since snapshot"
        //    correctly identifies the dropdown for THIS trigger.
        let pollAttempts = 0;
        const editPoll = setInterval(() => {
            pollAttempts++;
            if (pollAttempts > 20) {
                clearInterval(editPoll);
                const dropdowns = document.querySelectorAll('.ant-dropdown');
                const editsNow = document.querySelectorAll('[data-menu-id$="-edit"]');
                console.warn(`${TAG} [edit] ${instrId}: TIMEOUT. Dropdowns=${dropdowns.length}, visible=${Array.from(dropdowns).filter(d => !d.classList.contains('ant-dropdown-hidden')).length}, editsBefore=${editsBefore.size}, editsNow=${editsNow.length}`);
                showToast('Edit dropdown did not appear', '#ff9800');
                draggable.classList.remove('aim-mb-force-dots');
                return;
            }
            // Look for an Edit item that's new (post-hover) AND inside
            // a visible (non-hidden) dropdown.
            const candidates = document.querySelectorAll('[data-menu-id$="-edit"]');
            let editItem = null;
            for (const item of candidates) {
                if (editsBefore.has(item)) continue; // not new
                const dropdown = item.closest('.ant-dropdown');
                if (dropdown && dropdown.classList.contains('ant-dropdown-hidden')) continue;
                editItem = item; break;
            }
            // Fallback: text-based search inside any visible dropdown
            if (!editItem) {
                const visibleDropdowns = Array.from(document.querySelectorAll('.ant-dropdown'))
                    .filter(d => !d.classList.contains('ant-dropdown-hidden'));
                for (const d of visibleDropdowns) {
                    const byText = Array.from(d.querySelectorAll('.ant-dropdown-menu-item')).find(el => /^\s*Edit\s*$/.test(el.textContent));
                    if (byText && !editsBefore.has(byText)) { editItem = byText; break; }
                }
            }
            if (!editItem) return;
            clearInterval(editPoll);
            dlog(`${TAG} [edit] ${instrId}: clicking Edit menu item (poll attempt ${pollAttempts})`);
            editItem.click();
            draggable.classList.remove('aim-mb-force-dots');
            // Cleanup — call onMouseLeave on the SAME element we used
            // for onMouseEnter. This is the pairing Ant needs to clear
            // its internal "trigger is hovered" state. Without it,
            // manual hover stays broken until page refresh.
            setTimeout(() => {
                let leaveFired = false;
                // (a) PRIMARY: React onMouseLeave on the same triggerEl
                if (triggerEl) {
                    const propsKey = Object.keys(triggerEl).find(k => k.startsWith('__reactProps$'));
                    if (propsKey) {
                        const props = triggerEl[propsKey];
                        if (typeof props.onMouseLeave === 'function') {
                            try {
                                props.onMouseLeave({
                                    type: 'mouseleave', target: triggerEl, currentTarget: triggerEl,
                                    preventDefault(){}, stopPropagation(){},
                                    nativeEvent: new MouseEvent('mouseleave'),
                                });
                                leaveFired = true;
                                dlog(`${TAG} [edit] ${instrId}: called onMouseLeave on triggerEl (depth ${triggerLevel})`);
                            } catch (e) { console.warn(`${TAG} [edit] ${instrId}: onMouseLeave threw:`, e); }
                        } else if (typeof props.onMouseOut === 'function') {
                            try { props.onMouseOut({ target: triggerEl, preventDefault(){}, stopPropagation(){} }); leaveFired = true; } catch (e) {}
                        }
                    }
                }
                // (b) Native mouseleave on triggerEl as backup
                try {
                    (triggerEl || dots).dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, view: window }));
                    (triggerEl || dots).dispatchEvent(new MouseEvent('mouseout', { bubbles: true, view: window }));
                } catch (e) {}
                // (c) If we didn't fire leave on triggerEl, walk up
                if (!leaveFired) closeAntDropdownFor(dots);
                // (d) Click-outside as a fallback dismiss
                try {
                    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                } catch (e) {}
                // (e) Last resort: remove any visible dropdowns
                setTimeout(() => dismissStuckAntDropdowns(), 150);
            }, 100);
        }, 100);
    }

    // Dispatch native pointer + mouse leave events on a fresh element
    // in the live DOM. React's event delegation picks these up and
    // updates Ant's internal "trigger is hovered" state. Must be
    // called when the element is actually visible (e.g. on the
    // instruction list view, not the edit view).
    function dispatchPointerAndMouseLeave(el) {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window, pointerType: 'mouse' };
        try {
            el.dispatchEvent(new PointerEvent('pointerout', opts));
            el.dispatchEvent(new PointerEvent('pointerleave', { ...opts, bubbles: false }));
            el.dispatchEvent(new MouseEvent('mouseout', opts));
            el.dispatchEvent(new MouseEvent('mouseleave', { ...opts, bubbles: false }));
        } catch (e) {}
    }

    // After save returns us to the instruction list, find the just-
    // edited step's dots in the FRESH live DOM and dispatch leave
    // events so Ant clears its hover-tracking state. This is the
    // piece that was missing — cleanup against stale references
    // (during edit view) couldn't reach the live React component.
    function clearHoverStateForInstruction(instructionId) {
        // Wait briefly for the instruction list to be back in the DOM
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            if (attempts > 15) { clearInterval(interval); return; }
            const draggable = document.querySelector(`[data-rfd-draggable-id="${instructionId}"]`);
            if (!draggable) return;
            const dots = draggable.querySelector('[data-testid="btn-instruction-menu"]');
            if (!dots) return;
            clearInterval(interval);
            dispatchPointerAndMouseLeave(dots);
            // Also call the React onMouseLeave on the live element
            const propsKey = Object.keys(dots).find(k => k.startsWith('__reactProps$'));
            if (propsKey) {
                const props = dots[propsKey];
                if (typeof props.onMouseLeave === 'function') {
                    try { props.onMouseLeave({ type: 'mouseleave', target: dots, currentTarget: dots, preventDefault(){}, stopPropagation(){}, nativeEvent: new MouseEvent('mouseleave') }); } catch (e) {}
                }
                if (typeof props.onPointerLeave === 'function') {
                    try { props.onPointerLeave({ type: 'pointerleave', target: dots, currentTarget: dots, preventDefault(){}, stopPropagation(){}, nativeEvent: new PointerEvent('pointerleave') }); } catch (e) {}
                }
            }
            dlog(`${TAG} [edit] hover state cleared for instruction ${instructionId}`);
        }, 100);
    }

    // Politely tell Ant to close this trigger's dropdown by dispatching
    // the React onMouseLeave handler. This lets Ant clean up its own
    // state machine, preserving the user's ability to manually open
    // dropdowns later. Falls back to no-op if no handler is found.
    function closeAntDropdownFor(triggerEl) {
        let el = triggerEl;
        for (let depth = 0; depth < 8 && el; depth++) {
            const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
            if (propsKey) {
                const props = el[propsKey];
                const handler = props.onMouseLeave || props.onMouseOut;
                if (typeof handler === 'function') {
                    try { handler({ preventDefault(){}, stopPropagation(){} }); return true; } catch (e) {}
                }
            }
            el = el.parentElement;
        }
        return false;
    }

    // Last-resort cleanup: remove any visible Ant dropdown portals.
    // Use closeAntDropdownFor first to avoid corrupting Ant's state.
    function dismissStuckAntDropdowns() {
        document.querySelectorAll('.ant-dropdown').forEach(d => {
            if (!d.classList.contains('ant-dropdown-hidden')) {
                d.remove();
            }
        });
    }

    // React-aware value setter for Ant InputNumber. Native value
    // assignment doesn't trigger React's controlled-input update —
    // we have to use the underlying HTMLInputElement setter and
    // dispatch input + change events.
    //
    // v0.52: the trailing BLUR is the critical bit. Ant InputNumber keeps
    // the value you type in an internal "editing" buffer and only COMMITS it
    // to the form's React state on blur (or Enter). Without it, our value
    // showed in the box but Save read the original — so snapshot altitudes
    // reverted to 0 the moment the instruction saved. The Asset Inspector's
    // working Apply does exactly this; ported here.
    function setReactInputValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // v0.58: do NOT focus()-then-blur. v0.57 did, and Percepto's edit dialog
        // closes on the input blur — that's why the step "opened then instantly
        // closed" like a cancel. The form commit is handled by
        // commitInputNumberViaFiber (the InputNumber component onChange), which
        // doesn't need a blur. We still dispatch a bubbling blur event (no prior
        // focus, so harmless) only to satisfy any listener that expects one.
        input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        // NOTE (v0.55): no synthetic Enter — the Quick Mission Editor listens
        // for Enter on this page and would pop its move dialog.
    }

    // The inner `.ant-input-number-input` events update Ant's display but do
    // NOT reliably reach the Ant InputNumber *component's* onChange — the one
    // that emits the committed numeric value into Percepto's form. Diagnostics
    // proved the box holds the new value yet Save persists the old one, i.e. the
    // form model never updated. Walk up the fiber from the inner input to the
    // InputNumber component and call its onChange(value) directly. Returns true
    // if a component-level onChange was found and invoked.
    function commitInputNumberViaFiber(input, numericValue) {
        try {
            const fk = Object.keys(input).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
            if (!fk) return false;
            let fiber = input[fk], depth = 0;
            // Walk up. The inner <input> and wrapper <div>s are HOST fibers
            // (fiber.type is a string like 'input'/'div'). The Ant/rc InputNumber
            // is a COMPONENT fiber (fiber.type is a function/object). Its onChange
            // takes the committed value directly — that's the one that updates
            // Percepto's form. v0.59: target "first component fiber with onChange"
            // (the old numeric-prop heuristic didn't match Ant v5 → componentOnChange=false).
            while (fiber && depth < 30) {
                const props = fiber.memoizedProps;
                const isHost = typeof fiber.type === 'string';
                if (!isHost && props && typeof props.onChange === 'function') {
                    try { props.onChange(numericValue); return true; } catch (e) {
                        // Some wrappers expect an event-shaped arg; try that, then keep walking.
                        try { props.onChange({ target: { value: numericValue } }); return true; } catch (e2) {}
                    }
                }
                fiber = fiber.return; depth++;
            }
        } catch (e) { /* fall through — DOM events are the fallback */ }
        return false;
    }

    function findEditDialogInputByLabel(...labelTexts) {
        const labels = document.querySelectorAll('.edit-instruction__input-label');
        for (const label of labels) {
            const txt = (label.textContent || '').trim().toLowerCase();
            for (const want of labelTexts) {
                if (txt === want.toLowerCase()) {
                    const group = label.closest('.edit-instruction__input-group')
                        || label.parentElement;
                    return group ? group.querySelector('input.ant-input-number-input') : null;
                }
            }
        }
        return null;
    }

    // Set the altitude in the open edit dialog. Two-strategy resolution:
    //
    //   PRIMARY (value-anchored): scan every ant-input-number-input in
    //   the dialog; the one whose current aria-valuenow/value matches
    //   the step's known altitude (in user's display unit) is the
    //   altitude input. Survives label text changes and form restructure.
    //
    //   FALLBACK (label-regex): find an input-group whose label matches
    //   /altitude/i or /^height\b/i. Brittle to label text changes but
    //   covers cases where the value is 0 / blank / pre-changed.
    //
    // Then radio-gating: regardless of how we found it, if the input
    // group has ≥2 radios OR the input is disabled, click the second
    // radio (Custom altitude) first to enable the input.
    function setAltitudeInEditDialog(value, done, origDisplayValue) {
        // Strategy 1: value-anchored
        let group = null;
        let inputViaValue = null;
        if (origDisplayValue != null && !isNaN(origDisplayValue)) {
            const candidates = document.querySelectorAll('.edit-instruction__form input.ant-input-number-input');
            const target = Math.round(Number(origDisplayValue));
            dlog(`${TAG} [edit] ${candidates.length} number input(s); target≈${target}; current=[${Array.from(candidates).map(i => (i.getAttribute('aria-valuenow') || i.value)).join(', ')}]`);
            for (const inp of candidates) {
                const raw = inp.getAttribute('aria-valuenow') || inp.value;
                const num = Math.round(Number(raw));
                // Allow 1-unit tolerance for rounding
                if (!isNaN(num) && Math.abs(num - target) <= 1) {
                    inputViaValue = inp;
                    group = inp.closest('.edit-instruction__input-group') || inp.closest('div');
                    dlog(`${TAG} [edit] altitude matched by VALUE (${num} ≈ ${target})`);
                    break;
                }
            }
        }
        // Strategy 2: label-regex fallback
        if (!group) {
            const labels = document.querySelectorAll('.edit-instruction__input-label');
            for (const lbl of labels) {
                const t = (lbl.textContent || '').trim();
                if (/altitude/i.test(t) || /^height\b/i.test(t)) {
                    group = lbl.closest('.edit-instruction__input-group');
                    if (group) { dlog(`${TAG} [edit] altitude matched by LABEL "${t}"`); break; }
                }
            }
        }
        if (!group) {
            const labels = Array.from(document.querySelectorAll('.edit-instruction__input-label')).map(l => (l.textContent || '').trim());
            console.warn(`${TAG} [edit] altitude input not found. Labels available:`, labels);
            done(false); return;
        }
        // Radio gating: click "Custom" if radios are present OR the
        // candidate input is disabled (defensive — Navigate's altitude
        // input has `disabled` until Custom is selected).
        const radios = group.querySelectorAll('input[type="radio"]');
        const targetInput = inputViaValue || group.querySelector('input.ant-input-number-input');
        const needsRadio = radios.length >= 2 || (targetInput && targetInput.disabled);
        if (needsRadio && radios.length >= 2) {
            let customRadio = null;
            for (const r of radios) {
                const lbl = r.closest('label');
                if (lbl && /custom/i.test(lbl.textContent || '')) { customRadio = r; break; }
            }
            if (!customRadio) customRadio = radios[1];
            dlog(`${TAG} [edit] clicking Custom-altitude radio`);
            clickReactControl(customRadio);
            setTimeout(() => setAltValue(group, value, done, inputViaValue), 250);
        } else {
            setAltValue(group, value, done, inputViaValue);
        }
    }

    function setAltValue(group, value, done, preferredInput) {
        const numInput = preferredInput || group.querySelector('input.ant-input-number-input');
        if (!numInput) { console.warn(`${TAG} [edit] no number input in group`); done(false); return; }
        setReactInputValue(numInput, value);
        // The decisive commit: push the numeric value into the InputNumber
        // component's own onChange so Percepto's form model actually updates.
        // This is THE fix — Ant v5's display-level events don't reach the form.
        const committed = commitInputNumberViaFiber(numInput, Number(value));
        dlog(`${TAG} [edit] set → "${numInput.value}" (wanted ${value}) · componentOnChange=${committed}`);
        if (!committed) console.warn(`${TAG} [edit] componentOnChange=false — form may not have taken the value`);
        done(true);
    }

    // Click a React-controlled input (radio/checkbox) by calling its
    // onChange handler directly. Falls back to clicking the label.
    function clickReactControl(el) {
        const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
        if (propsKey) {
            const props = el[propsKey];
            if (typeof props.onChange === 'function') {
                try { props.onChange({ target: { checked: true, value: el.value }, preventDefault(){}, stopPropagation(){} }); return; } catch (e) {}
            }
            if (typeof props.onClick === 'function') {
                try { props.onClick({ preventDefault(){}, stopPropagation(){} }); return; } catch (e) {}
            }
        }
        const lbl = el.closest('label');
        if (lbl) lbl.click(); else el.click();
    }

    // Click a button through its React onClick handler. Native .click() on
    // Percepto's Ant v5 buttons doesn't always invoke React's onClick (so the
    // dialog can close without actually saving — "acts like cancel"). Call the
    // handler directly, with a native click as fallback. Returns true if fired.
    function clickReactButton(btn) {
        if (!btn) return false;
        const k = Object.keys(btn).find(key => key.startsWith('__reactProps$'));
        if (k && btn[k] && typeof btn[k].onClick === 'function') {
            try {
                btn[k].onClick({ preventDefault(){}, stopPropagation(){}, nativeEvent: {}, currentTarget: btn, target: btn });
                return true;
            } catch (e) { console.warn(`${TAG} [edit] react onClick threw, falling back to native click`, e); }
        }
        try { btn.click(); return true; } catch (e) { return false; }
    }

    // ========================================================
    // Read-only save-diff probe
    // ========================================================
    // Watches the outgoing mission save (POST /available_app/) and diffs every
    // instruction field against the cached original. MODIFIES NOTHING — passes
    // the save through untouched and only logs. Purpose: learn whether Percepto's
    // edit form RECOMPUTES dependent fields (value2 / extra_options / …) when you
    // change a value. If a save ever shows only value1 changing, a fast "patch
    // the save body" path would produce identical data (safe). If dependent
    // fields move too, a body-patch would desync — stay per-step. General by
    // design: diffs ALL fields, so it answers this for any field we bulk-edit later.
    function findCachedMissionForPayload(body) {
        for (const sid in missionsBySite) {
            const arr = (missionsBySite[sid] && missionsBySite[sid].missions) || [];
            const m = arr.find(mm => mm && (
                (mm.app_id != null && body.app_id != null && mm.app_id === body.app_id) ||
                (mm.name != null && body.name != null && mm.name === body.name)
            ));
            if (m) return m;
        }
        return null;
    }
    function probeSavePayload(bodyStr) {
        try {
            const body = JSON.parse(bodyStr);
            if (!body || !Array.isArray(body.instructions)) return;
            const m = findCachedMissionForPayload(body);
            if (!m || !Array.isArray(m.instructions)) {
                console.log(`${TAG} [diff-probe] save "${body.name}" — no cached original to diff (open the SUM panel for this site first)`);
                return;
            }
            const orig = m.instructions, usedO = new Set(), rows = [];
            let recompute = false;
            body.instructions.forEach((bi, i) => {
                if (!bi || !bi.location || bi.location.lat == null) return;
                let oi = null;
                for (let j = 0; j < orig.length; j++) {
                    if (usedO.has(j)) continue;
                    const o = orig[j];
                    if (o && o.location && o.location.lat != null &&
                        Math.abs(Number(o.location.lat) - Number(bi.location.lat)) < 1e-9 &&
                        Math.abs(Number(o.location.lng) - Number(bi.location.lng)) < 1e-9) { oi = o; usedO.add(j); break; }
                }
                if (!oi) return;
                const diffs = [];
                if (oi.value1 != null && Number(oi.value1) !== Number(bi.value1)) diffs.push(`value1 ${oi.value1}→${bi.value1}`);
                if (oi.value2 != null && Number(oi.value2) !== Number(bi.value2)) diffs.push(`value2 ${oi.value2}→${bi.value2}`);
                const oe = JSON.stringify(oi.extra_options || {}), be = JSON.stringify(bi.extra_options || {});
                if (oe !== be) diffs.push(`extra_options ${oe} → ${be}`);
                const op = JSON.stringify(oi.polygon_points || null), bp = JSON.stringify(bi.polygon_points || null);
                if (op !== bp) diffs.push(`polygon_points changed`);
                if (diffs.length) {
                    if (diffs.some(d => !d.startsWith('value1 '))) recompute = true;
                    rows.push(`#${i} (${bi.type_name || 'type ' + bi.type}) ${diffs.join(' · ')}`);
                }
            });
            if (!rows.length) { console.log(`${TAG} [diff-probe] save "${body.name}" — no field changes vs cached original`); return; }
            console.log(`${TAG} [diff-probe] save "${body.name}" — ${rows.length} step(s) changed:`);
            rows.forEach(r => console.log(`${TAG} [diff-probe]   ${r}`));
            console.log(`${TAG} [diff-probe] VERDICT: ${recompute
                ? '⚠ dependent fields ALSO changed → the form recomputes; a body-patch interceptor WOULD DESYNC. Stay per-step (or replicate the recompute).'
                : '✓ ONLY value1 changed → a body-patch interceptor would produce identical data. Safe to build for speed.'}`);
        } catch (e) { console.warn(`${TAG} [diff-probe] error`, e); }
    }

    // ---- Fast bulk save: patch the outgoing mission save (toggle-gated) ------
    // Splice staged altitude changes into the POST /available_app/ body. Per-type
    // rules learned from the probe: snapshot (type 6) → set value1; navigate
    // (type 1) → set value1 + extra_options.shouldUseFreezoneMinAlt=false (the
    // exact recompute the form does). Strict UNIQUE match by location + original
    // value (the payload has no instruction ids). Returns a modified body string,
    // or null to send the ORIGINAL unchanged (fail-closed). Only touches value1
    // (+ the one navigate flag) on staged steps — nothing else.
    function patchMissionSaveBody(bodyStr) {
        const body = JSON.parse(bodyStr);
        if (!body || !Array.isArray(body.instructions)) return null;
        let missionId = null, changes = null;
        for (const mid in pendingAltitudes) {
            if (!Object.keys(pendingAltitudes[mid] || {}).length) continue;
            const m = findCachedMissionById(mid);
            if (!m) continue;
            if ((m.app_id != null && body.app_id != null && m.app_id === body.app_id) ||
                (m.name != null && body.name != null && m.name === body.name)) { missionId = mid; changes = pendingAltitudes[mid]; break; }
        }
        if (!changes) {
            const totalPending = Object.values(pendingAltitudes).reduce((a, o) => a + Object.keys(o || {}).length, 0);
            console.warn(`${TAG} [fast-save] mission-save seen for "${body.name}" (app_id=${body.app_id}) but NO staged changes matched it (${totalPending} staged across ${Object.keys(pendingAltitudes).length} mission(s)). Did the page reload after staging?`);
            return null;
        }
        let applied = 0, skipped = 0; const used = new Set();
        for (const instrId in changes) {
            const ch = changes[instrId];
            if (ch.newM == null || ch.lat == null) { skipped++; console.warn(`${TAG} [fast-save] skip ${instrId} — missing match data`); continue; }
            let idx = -1, matchCount = 0;
            for (let i = 0; i < body.instructions.length; i++) {
                if (used.has(i)) continue;
                const bi = body.instructions[i];
                if (!bi || !bi.location || bi.location.lat == null) continue;
                const locOk = Math.abs(Number(bi.location.lat) - ch.lat) < 1e-7 && Math.abs(Number(bi.location.lng) - ch.lng) < 1e-7;
                const valOk = (ch.origM == null) || (typeof bi.value1 === 'number' && Math.abs(bi.value1 - ch.origM) < 0.5);
                if (locOk && valOk) { matchCount++; if (idx < 0) idx = i; }
            }
            // STRICT: only patch on a single unambiguous match.
            if (idx < 0 || matchCount !== 1) { skipped++; console.warn(`${TAG} [fast-save] skip step (lat=${ch.lat}, origM=${ch.origM}) — ${matchCount} matches, not 1`); continue; }
            const bi = body.instructions[idx];
            bi.value1 = Math.round(ch.newM * 100) / 100;
            if (bi.type === 1) { // navigate: setting a custom altitude drops freezone-min
                if (!bi.extra_options || typeof bi.extra_options !== 'object') bi.extra_options = {};
                bi.extra_options.shouldUseFreezoneMinAlt = false;
            }
            used.add(idx); applied++;
            console.log(`${TAG} [fast-save]   #${idx} (type ${bi.type}) value1→${bi.value1}${bi.type === 1 ? ' + freezone-min off' : ''}`);
        }
        if (applied === 0) return null;
        // Reflect into cache + clear the staged queue for this mission.
        try {
            const m = findCachedMissionById(missionId);
            if (m) for (const instrId in changes) {
                const instr = (m.instructions || []).find(i => i && i.id === Number(instrId));
                if (instr && changes[instrId].newM != null) instr.value1 = Math.round(changes[instrId].newM * 100) / 100;
            }
        } catch (e) {}
        discardAllPendingFor(missionId);
        const msg = `⚡ Fast save — patched ${applied}${skipped ? ` (skipped ${skipped} — see console)` : ''} altitude${applied === 1 ? '' : 's'}`;
        showToast(msg, skipped ? '#ff9800' : '#5fff5f', 5000);
        console.log(`${TAG} [fast-save] patched ${applied}, skipped ${skipped} for "${body.name}"`);
        return JSON.stringify(body);
    }

    // Hook router: returns a modified body to send, or null = send original.
    // Fail-closed: any throw → null (original save goes through untouched).
    // Auto snapshot-AGL pass: when armed, re-set every snapshot's value1 to its
    // DEM ground + the default AGL, using the body's OWN (current/moved) coords.
    // Ground must be cached (the marker prefetch warms it); uncached → skipped +
    // a "re-save in a moment" warning. Returns a modified body string or null.
    function applySnapAglToBodyStr(bodyStr) {
        const body = JSON.parse(bodyStr);
        if (!body || !Array.isArray(body.instructions)) return null;
        const aglM = defaultSnapAglFt / 3.28084;
        let set = 0, missDem = 0, noLoc = 0;
        body.instructions.forEach(bi => {
            if (!bi || bi.type !== 6) return; // 6 = snapshot
            if (!bi.location || bi.location.lat == null) { noLoc++; return; } // "In Place" (yaw/tilt) — no GPS to measure AGL from
            const groundM = getElevationFromCache(Number(bi.location.lat), Number(bi.location.lng));
            if (groundM == null) { missDem++; try { fetchElevation(bi.location.lat, bi.location.lng); } catch (e) {} return; }
            const newV = Math.round((groundM + aglM) * 100) / 100;
            if (typeof bi.value1 === 'number' && Math.abs(bi.value1 - newV) < 0.5) return; // already correct
            bi.value1 = newV;
            set++;
        });
        if (noLoc) {
            // These are "In Place" snapshots (a J2A capture pointing by yaw/tilt) —
            // they have no GPS/altitude, so there's nothing for auto-AGL to set.
            console.warn(`${TAG} [auto-agl] ${noLoc} snapshot(s) are "In Place" (no GPS) — auto-AGL can't set their AGL. Switch them to "To GPS" if you want a fixed AGL.`);
            showToast(`⚠ Auto-AGL: ${noLoc} snapshot(s) are "In Place" (no GPS) — can't set their AGL. Only "To GPS" snapshots get ground + ${defaultSnapAglFt} ft.`, '#ff7a00', 6500);
        }
        if (missDem) {
            console.warn(`${TAG} [auto-agl] ${missDem} snapshot(s) had no DEM cached — skipped; fetching now. Re-save in a moment.`);
            showToast(`⚠ Auto-AGL: ${missDem} snapshot(s) had no ground elevation yet — re-save in a moment to fix them.`, '#ff7a00', 5000);
        }
        if (set === 0) return null;
        showToast(`📷 Auto-AGL: set ${set} snapshot${set === 1 ? '' : 's'} to ground + ${defaultSnapAglFt} ft on save.`, '#5fff5f', 4500);
        console.log(`${TAG} [auto-agl] set ${set} snapshot altitude(s) to ground+${defaultSnapAglFt}ft on save`);
        return JSON.stringify(body);
    }

    function handleMissionSave(bodyStr) {
        let working = bodyStr;
        // 1. Snapshot auto-AGL pass (independent of fast-save; armed via the
        //    editor-row toggle, default OFF).
        if (autoSnapAglEnabled) {
            try { const s = applySnapAglToBodyStr(working); if (s) working = s; }
            catch (e) { console.warn(`${TAG} [auto-agl] pass error — leaving snapshots unchanged:`, e); }
        }
        // 2. Fast bulk-save pass (staged altitude edits), if enabled.
        if (fastBulkSave) {
            console.log(`${TAG} [fast-save] mission-save request intercepted — fastBulkSave ON, checking staged changes…`);
            try { const p = patchMissionSaveBody(working); if (p) working = p; }
            catch (e) { console.warn(`${TAG} [fast-save] patch error — sending body unchanged by fast-save:`, e); }
        } else {
            try { if (DEBUG()) probeSavePayload(bodyStr); } catch (e) {} // read-only diff log only when debugging
        }
        return working === bodyStr ? null : working;
    }

    // Shift+S → click the open STEP's "Save" button (data-testid=btn-save-instruction
    // in the edit-instruction panel). Shift+D → "Save & Next": save the open step,
    // then open the NEXT step's editor (rip through per-step finetuning). Both are
    // input-guarded so they don't fire while typing.
    // (Saving the whole mission via saveApp fails while a step editor is open — and
    // the per-step save is what's actually wanted in the editing workflow.)
    function installSaveHotkey() {
        if (CONTEXT !== 'IFRAME') return;
        window.addEventListener('keydown', (e) => {
            if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
            const isS = (e.key === 'S' || e.key === 's');
            const isD = (e.key === 'D' || e.key === 'd');
            if (!isS && !isD) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ||
                (t.closest && t.closest('.ant-input,.ant-select,.ant-select-selection-search-input,[role="textbox"]')))) return;
            const stepBtn = document.querySelector('[data-testid="btn-save-instruction"]');
            if (!stepBtn || stepBtn.disabled) return;   // only when a step editor is open
            e.preventDefault(); e.stopPropagation();
            if (isD) { saveAndNextStep(); return; }
            try { stepBtn.click(); showToast('✓ Step saved (Shift+S)', '#5fff5f', 1800); }
            catch (err) { console.warn(`${TAG} [save-hotkey] click failed`, err); }
        }, true);
    }

    // "Save & Next" — save the currently-open step, then auto-open the NEXT step's
    // editor. Lets you rip through per-step finetuning of a generated mission (move
    // snapshot → Save ⏭ → next snapshot → …) WITHOUT clicking the next marker on the
    // map (which Percepto would interpret as "move the open step" — the cause of the
    // snapshot sliding to the wrong spot). Surfaced as a button INSIDE the step editor
    // (next to Percepto's own Save) + the Shift+D hotkey.
    //
    // KEY: while a step editor is open, Percepto REPLACES the instruction-card list,
    // so the [data-rfd-draggable-id] cards are GONE. We therefore compute "next" from
    // REACT STATE (the ordered instructions array), not the DOM — then hand the next
    // id to openInstructionEditor(), which itself saves the open step, waits for the
    // editor to close + the list to re-render, and opens the target.
    const SAVE_NEXT_SKIP_TYPES = new Set([7, 24]); // cameraSelect, gemMode — no useful editor
    let saveNextLastOpenedId = null; // fallback "current step" when focus id is unavailable

    // The ordered instructions array from React state (survives the editor being open;
    // findMissionAppCtx anchors on stable DOM, not the [data-rfd-draggable-id] cards).
    function getMissionInstrsState() {
        try { const ac = findMissionAppCtx(); if (ac && ac.currentApp && Array.isArray(ac.currentApp.instructions) && ac.currentApp.instructions.length) return ac.currentApp.instructions; } catch (e) {}
        try { const ec = findMissionEditorCtx(); if (ec && Array.isArray(ec.instrs) && ec.instrs.length) return ec.instrs; } catch (e) {}
        return null;
    }

    // The id of the step whose editor is open — Percepto's own focusedInstructionId,
    // found by a broad fiber walk (the value can live on a different provider than
    // saveApp). Anchors include .edit-instruction so it works mid step-edit. Falls
    // back to the last step we opened in a Save & Next chain.
    function findFocusedInstrId() {
        const anchors = ['.edit-instruction', '[data-rfd-draggable-id]', '.mission-edit__content', '.mission-bank__map-container', '.mission-bank'];
        for (const sel of anchors) {
            const el = document.querySelector(sel); if (!el) continue;
            const f0 = mbGetFiber(el);
            for (const start of [f0, f0 && f0.alternate]) {
                let node = start, depth = 0;
                while (node && depth < 170) {
                    let v; try { v = node.memoizedProps && node.memoizedProps.value; } catch (e) { v = null; }
                    if (v && typeof v === 'object' && v.focusedInstructionId != null &&
                        (typeof v.saveApp === 'function' || typeof v.setCurrentApp === 'function' || Array.isArray(v.instructions))) {
                        return String(v.focusedInstructionId);
                    }
                    node = node.return; depth++;
                }
            }
        }
        return null;
    }
    function getOpenStepId() {
        const fid = findFocusedInstrId();
        if (fid != null) return fid;
        // Fall back to the step WE last opened (marker-click / switch) — makes the
        // "is this the step I'm editing?" check reliable even if Percepto's
        // focusedInstructionId can't be read, so only that one stays native.
        if (composerEditingStepId != null) return composerEditingStepId;
        return saveNextLastOpenedId;
    }

    // The next editable instruction id after `currentId` in the mission order
    // (skips camera/GEM toggles). Pure React-state — no DOM cards needed.
    function nextEditableInstrId(currentId) {
        const instrs = getMissionInstrsState();
        if (!instrs) return null;
        const idx = currentId != null ? instrs.findIndex(s => s && String(s.id) === String(currentId)) : -1;
        for (let j = idx + 1; j < instrs.length; j++) {
            const s = instrs[j];
            if (!s || s.id == null) continue;
            if (SAVE_NEXT_SKIP_TYPES.has(s.type)) continue;
            return String(s.id);
        }
        return null;
    }

    function currentMissionIdFromHash() {
        const m = (location.hash || '').match(/mission-bank\/(\d+)/);
        return m ? m[1] : null;
    }

    function saveAndNextStep() {
        if (CONTEXT !== 'IFRAME') return;
        const stepBtn = document.querySelector('[data-testid="btn-save-instruction"]');
        if (!stepBtn || stepBtn.disabled) {
            showToast('Open a step’s editor first — Save & Next saves it, then opens the next.', '#ff9800', 3500);
            return;
        }
        const curId = getOpenStepId();
        const nextId = nextEditableInstrId(curId);
        const missionId = currentMissionIdFromHash();
        if (!nextId) {
            // Nothing after this one — just save the open step in place.
            try { stepBtn.click(); showToast('✓ Step saved — last step (no next).', '#5fff5f', 2600); }
            catch (err) { console.warn(`${TAG} [save-next] save failed`, err); showToast('Save failed — see console.', '#ff5252', 3000); }
            saveNextLastOpenedId = null;
            return;
        }
        // openInstructionEditor saves the OPEN step (clicks btn-save-instruction),
        // waits for the editor to close + the list to re-render, then opens nextId.
        saveNextLastOpenedId = nextId;
        showToast('✓ Saving — opening next step…', '#5fff5f', 1600);
        try { openInstructionEditor(nextId, missionId); }
        catch (err) { console.warn(`${TAG} [save-next] open-next failed`, err); showToast('Saved, but couldn’t open the next step — open it manually.', '#ff9800', 4000); }
    }

    let saveProbeInstalled = false;
    function installSaveDiffProbe() {
        if (saveProbeInstalled) return;
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        if (win.__aim_mb_diffprobe) { saveProbeInstalled = true; return; }
        const SAVE_RE = /\/available_app\/(?:$|\?|#)/;
        try {
            const origFetch = win.fetch;
            if (typeof origFetch === 'function') {
                win.fetch = function(input, init) {
                    try {
                        const url = (typeof input === 'string') ? input : (input && input.url);
                        const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
                        if (method === 'POST' && url && SAVE_RE.test(url) && init && typeof init.body === 'string') {
                            const patched = handleMissionSave(init.body);
                            if (patched) init = Object.assign({}, init, { body: patched });
                        }
                    } catch (e) {}
                    return origFetch.apply(this, arguments);
                };
            }
        } catch (e) {}
        try {
            const XHR = win.XMLHttpRequest;
            const origOpen = XHR.prototype.open, origSend = XHR.prototype.send;
            XHR.prototype.open = function(method, url) { this.__aim_mb_m = (method || '').toUpperCase(); this.__aim_mb_u = url; return origOpen.apply(this, arguments); };
            XHR.prototype.send = function(b) {
                try {
                    if (this.__aim_mb_m === 'POST' && this.__aim_mb_u && SAVE_RE.test(this.__aim_mb_u) && typeof b === 'string') {
                        const patched = handleMissionSave(b);
                        if (patched) return origSend.call(this, patched);
                    }
                } catch (e) {}
                return origSend.apply(this, arguments);
            };
        } catch (e) {}
        win.__aim_mb_diffprobe = true;
        saveProbeInstalled = true;
        console.log(`${TAG} save hook armed — Fast bulk save is OFF by default (read-only) until you toggle it on`);
    }

    // ========================================================
    // Pending altitude changes — queue + commit
    // ========================================================
    function findCachedMissionById(missionId) {
        // String-tolerant: pendingAltitudes keys are strings (object keys), but
        // mission.id is a number — a strict === never matched, so the fast-save
        // mission lookup found nothing ("NO staged changes matched"). Compare as strings.
        for (const sid in missionsBySite) {
            const arr = (missionsBySite[sid] && missionsBySite[sid].missions) || [];
            const m = arr.find(mm => mm && String(mm.id) === String(missionId));
            if (m) return m;
        }
        return null;
    }
    function queueAltitudeChange(missionId, instructionId, value, unit) {
        if (!pendingAltitudes[missionId]) pendingAltitudes[missionId] = {};
        // Stash what the fast-save interceptor needs to match this step in the
        // save payload (which has no instruction ids): the new value in METERS,
        // plus the step's original altitude + location. Harmless for the
        // per-step path, which only reads {value, unit}.
        const newM = unit === 'imperial' ? (Number(value) / 3.28084) : Number(value);
        let origM = null, lat = null, lng = null;
        const m = findCachedMissionById(missionId);
        const instr = m && (m.instructions || []).find(i => i && i.id === Number(instructionId));
        if (instr) {
            if (typeof instr.value1 === 'number') origM = instr.value1;
            if (instr.location && instr.location.lat != null) { lat = Number(instr.location.lat); lng = Number(instr.location.lng); }
        }
        pendingAltitudes[missionId][instructionId] = { value, unit, newM, origM, lat, lng };
    }
    function discardPendingChange(missionId, instructionId) {
        if (pendingAltitudes[missionId]) {
            delete pendingAltitudes[missionId][instructionId];
            if (Object.keys(pendingAltitudes[missionId]).length === 0) delete pendingAltitudes[missionId];
        }
    }
    function discardAllPendingFor(missionId) {
        delete pendingAltitudes[missionId];
    }
    function getPendingChange(missionId, instructionId) {
        return pendingAltitudes[missionId] && pendingAltitudes[missionId][instructionId];
    }
    function countPending(missionId) {
        return pendingAltitudes[missionId] ? Object.keys(pendingAltitudes[missionId]).length : 0;
    }
    function markCommitted(missionId, instructionId, value, unit) {
        if (!committedAltitudes[missionId]) committedAltitudes[missionId] = {};
        committedAltitudes[missionId][instructionId] = { value, unit };
    }
    function getCommitted(missionId, instructionId) {
        return committedAltitudes[missionId] && committedAltitudes[missionId][instructionId];
    }
    function clearCommittedFor(missionId) { delete committedAltitudes[missionId]; }

    // Commit all pending altitude changes for a mission. For each:
    // open step editor → wait for dialog → find altitude input by
    // label → set value via React setter → click Save → wait for
    // dialog to close → next.
    function commitPendingChanges(missionId) {
        if (committingChanges) { showToast('Already committing — please wait', '#ff9800'); return; }
        const changes = pendingAltitudes[missionId];
        if (!changes || Object.keys(changes).length === 0) return;
        const entries = Object.entries(changes);
        committingChanges = true;
        showToast(`Committing 0/${entries.length}…`, '#14d2dc');
        runCommitQueue(missionId, entries, 0);
    }

    function runCommitQueue(missionId, entries, idx) {
        if (idx >= entries.length) {
            committingChanges = false;
            discardAllPendingFor(missionId);
            dismissStuckAntDropdowns();
            clearAllForceDots(); // safety net — restores native :hover everywhere
            showToast(`Committed ${entries.length} altitude change${entries.length === 1 ? '' : 's'}`, '#5fff5f');
            if (panelState && panelState.drillId === missionId) renderDetailView(missionId);
            return;
        }
        // Belt + suspenders before each iteration
        dismissStuckAntDropdowns();
        clearAllForceDots();
        const [instructionId, change] = entries[idx];
        dlog(`${TAG} [queue] ====== step ${idx + 1}/${entries.length}: instruction ${instructionId} → ${change.value} ${change.unit} ======`);
        commitOneChange(missionId, instructionId, change, (ok, err) => {
            if (!ok) {
                committingChanges = false;
                console.error(`${TAG} [queue] FAILED at step ${idx + 1}/${entries.length}: ${err}`);
                showToast(`Failed at step ${idx + 1}/${entries.length}: ${err || 'unknown'}`, '#ff5252');
                return;
            }
            dlog(`${TAG} [queue] step ${idx + 1}/${entries.length} success`);
            markCommitted(missionId, Number(instructionId), change.value, change.unit);
            // Clear Ant's lingering hover state on the just-edited step.
            // Runs AFTER save returns us to the instruction list, when
            // the dots element is back in the live DOM.
            clearHoverStateForInstruction(instructionId);
            showToast(`Committing ${idx + 1}/${entries.length}…`, '#14d2dc');
            setTimeout(() => runCommitQueue(missionId, entries, idx + 1), 600);
        });
    }

    function commitOneChange(missionId, instructionId, change, done) {
        // Look up the cached step so we can pass its current display
        // value to the altitude resolver for value-anchored matching.
        const sid = getCurrentSiteID();
        const bucket = missionsBySite[sid];
        const mission = bucket && bucket.missions.find(m => m.id === missionId);
        const instr = mission && (mission.instructions || []).find(i => i.id === Number(instructionId));
        let origDisplay = null;
        if (instr && instr.value1_name === 'm' && typeof instr.value1 === 'number') {
            origDisplay = change.unit === 'imperial' ? Math.round(instr.value1 * 3.28084) : Math.round(instr.value1);
        }
        // First close any existing edit dialog by saving it
        const existingEdit = document.querySelector('.edit-instruction');
        const beginStep = () => {
            // Navigate to mission editor (no-op if already there)
            const link = document.querySelector(`a[href*="/mission-bank/${missionId}"]`);
            if (link) link.click();
            // Poll for draggable to appear
            let attempts = 0;
            const findInterval = setInterval(() => {
                attempts++;
                if (attempts > 30) { clearInterval(findInterval); done(false, 'instruction not found'); return; }
                const draggable = document.querySelector(`[data-rfd-draggable-id="${instructionId}"]`);
                if (!draggable) return;
                clearInterval(findInterval);
                draggable.scrollIntoView({ behavior: 'instant', block: 'center' });
                setTimeout(() => {
                    // PRIMARY: fiber walk to trigger Edit directly,
                    // bypassing Ant dropdown (no hover state touched).
                    const fiberOk = triggerInstructionAction(draggable, 'edit');
                    if (!fiberOk) {
                        // FALLBACK: open dropdown the old way
                        dlog(`${TAG} [edit] fiber-walk failed, falling back to dropdown flow`);
                        forceOpenInstructionEdit(draggable);
                    }
                    // Wait for edit dialog form to render (any label present)
                    let dlgAttempts = 0;
                    const dlgInterval = setInterval(() => {
                        dlgAttempts++;
                        if (dlgAttempts > 25) { clearInterval(dlgInterval); done(false, 'edit dialog never opened'); return; }
                        const form = document.querySelector('.edit-instruction__form');
                        const anyLabel = form && form.querySelector('.edit-instruction__input-label');
                        if (!anyLabel) return;
                        clearInterval(dlgInterval);
                        // Set altitude (handles Navigate radios + Snapshot direct).
                        // origDisplay enables value-anchored matching: find
                        // the input whose current value matches the cached
                        // altitude — much more robust than label text.
                        setAltitudeInEditDialog(change.value, (ok) => {
                            if (!ok) { done(false, 'altitude input not found'); return; }
                            // v0.61: KEEP the ~1.1s beat. It is NOT just for show —
                            // Percepto's form needs time to process the altitude
                            // change (recompute/validate) before Save reads it. v0.60
                            // trimmed this to 250ms and it broke (Save read the old
                            // value). This is the timing the user confirmed working.
                            dlog(`${TAG} [edit] set ${change.value} ${change.unit === 'imperial' ? 'ft' : 'm'}, saving…`);
                            setTimeout(() => {
                                const saveBtn = document.querySelector('[data-testid="btn-save-instruction"]');
                                if (!saveBtn) { console.warn(`${TAG} [edit] save button not found`); done(false, 'save button not found'); return; }
                                // Click through React's onClick — native click can
                                // close the dialog without firing the save handler.
                                clickReactButton(saveBtn);
                                let saveAttempts = 0;
                                const saveInterval = setInterval(() => {
                                    saveAttempts++;
                                    if (saveAttempts > 30) { clearInterval(saveInterval); console.warn(`${TAG} [edit] save did NOT close dialog (timeout)`); done(false, 'save did not complete'); return; }
                                    if (!document.querySelector('.edit-instruction')) {
                                        clearInterval(saveInterval);
                                        dlog(`${TAG} [edit] dialog closed after ~${saveAttempts * 200}ms — saved`);
                                        done(true);
                                    }
                                }, 200);
                            }, 1100);
                        }, origDisplay);
                    }, 200);
                }, 400);
            }, 200);
        };
        if (existingEdit) {
            // Close existing dialog first
            const saveBtn = document.querySelector('[data-testid="btn-save-instruction"]');
            if (saveBtn) saveBtn.click();
            let waitAttempts = 0;
            const waitInterval = setInterval(() => {
                waitAttempts++;
                if (waitAttempts > 25 || !document.querySelector('.edit-instruction')) {
                    clearInterval(waitInterval);
                    setTimeout(beginStep, 200);
                }
            }, 200);
        } else {
            beginStep();
        }
    }

    function escapeXml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
        }[c]));
    }

    function stat(label, value, copyVal) {
        const hasCopy = copyVal != null && copyVal !== 'null' && copyVal !== 'undefined' && copyVal !== '—';
        const cls = hasCopy ? 'aim-mb-stat aim-mb-stat-clickable' : 'aim-mb-stat';
        const copyAttr = hasCopy ? `data-copy="${escapeHtml(String(copyVal))}"` : '';
        const title = hasCopy ? ' title="Click to copy"' : '';
        return `<div class="${cls}" ${copyAttr}${title}><div class="aim-mb-stat-label">${escapeHtml(label)}</div><div class="aim-mb-stat-value">${escapeHtml(String(value))}</div></div>`;
    }

    // Is this step's altitude inline/bulk editable? Gate shared by the row
    // renderer, the selection checkboxes, and the Bulk → AGL/ALT actions.
    function stepAltEditable(s) {
        return !!(s && s.value1_name === 'm' && typeof s.value1 === 'number');
    }
    // Ground elevation (m) for a step's GPS, or null if no GPS / not cached yet.
    function stepElevM(s) {
        if (!s || !s.location || s.location.lat == null) return null;
        const e = getElevationFromCache(Number(s.location.lat), Number(s.location.lng));
        return (e == null) ? null : e;
    }

    // Is this step one of the redundant "scan-block" toggle/wait steps that
    // collapse into a single summary row? (Thermal on/off, GEM on/off, Wait.)
    function isScanBlockStep(s) {
        const t = s && s.type_name;
        return t === 'cameraSelect' || t === 'gemMode' || t === 'wait';
    }

    // Build the detail table body. When collapseScanBlocks is on, each run of
    // Thermal/GEM/Wait steps collapses into ONE compact summary row; Navigate
    // and Snapshot rows render normally. Off → every step gets its own row.
    function renderDetailRows(filteredSteps, allSteps, unit) {
        if (!collapseScanBlocks) {
            return filteredSteps.map(s => renderStepRow(s, allSteps.indexOf(s) + 1, unit)).join('');
        }
        const out = [];
        let i = 0;
        while (i < filteredSteps.length) {
            const s = filteredSteps[i];
            if (isScanBlockStep(s)) {
                const run = [];
                while (i < filteredSteps.length && isScanBlockStep(filteredSteps[i])) { run.push(filteredSteps[i]); i++; }
                out.push(renderScanBlockRow(run));
            } else {
                out.push(renderStepRow(s, allSteps.indexOf(s) + 1, unit));
                i++;
            }
        }
        return out.join('');
    }

    // One collapsed summary row for a run of Thermal/GEM/Wait steps. Shows the
    // canonical block at a glance + a ✓/⚠ on whether it's the expected
    // Thermal-on → GEM-on → Wait → GEM-off → Thermal-off shape.
    function renderScanBlockRow(run) {
        const camOn = run.filter(s => s.type_name === 'cameraSelect' && s.value1).length;
        const camOff = run.filter(s => s.type_name === 'cameraSelect' && !s.value1).length;
        const gemOn = run.filter(s => s.type_name === 'gemMode' && Number(s.value1) === 1).length;
        const gemOff = run.filter(s => s.type_name === 'gemMode' && Number(s.value1) === 0).length;
        const waits = run.filter(s => s.type_name === 'wait');
        const waitTxt = waits.map(w => `${Math.round(Number(w.value1) || 0)}s`).join('+') || '—';
        const canonical = camOn === 1 && camOff === 1 && gemOn === 1 && gemOff === 1 && waits.length === 1;
        const mark = canonical ? '<span style="color:#5fff5f">✓</span>' : '<span style="color:#ffd54f" title="Not the canonical Thermal-on→GEM-on→Wait→GEM-off→Thermal-off block">⚠</span>';
        const summary = `🔥 Scan block ${mark} <span style="color:#9ad">·</span> 🌡️ Thermal ${camOn}/${camOff} <span style="color:#9ad">·</span> 📡 GEM ${gemOn}/${gemOff} <span style="color:#9ad">·</span> ⏱ ${waitTxt}`;
        return `<tr class="aim-mb-scan-block-row">
            <td></td><td></td><td></td>
            <td colspan="8" style="color:#8aa;font-size:11px;font-style:italic;padding:3px 6px;">↳ ${summary} <span style="color:#666">(${run.length} steps collapsed)</span></td>
        </tr>`;
    }

    function renderStepRow(s, idx, unit) {
        const type = displayStepType(s);
        const val = displayStepValue(s, unit);
        const rawType = s && s.type_name;
        const missionId = panelState && panelState.drillId;
        // Pending altitude change (if any) — used by BOTH the Value cell and the
        // AGL cell so editing either keeps the other in sync (effective altitude).
        const pendingChange = (missionId != null && s) ? getPendingChange(missionId, s.id) : null;
        const editable = stepAltEditable(s);
        const selSet = panelState && panelState.detailSelection;
        const isSelected = editable && selSet && selSet.has(s.id);
        const classes = [];
        if (rawType === 'navigate') classes.push('aim-mb-step-nav');
        else if (rawType === 'snapshot') classes.push('aim-mb-step-snap');
        if (isSelected) classes.push('selected');
        const rowClass = classes.length ? ` class="${classes.join(' ')}"` : '';
        // Selection checkbox — only for editable steps (bulk can't touch the rest).
        const selCell = editable
            ? `<td class="aim-mb-sel-cell" style="text-align:center;"><input type="checkbox" data-sel-row data-instr-id="${s.id}" ${isSelected ? 'checked' : ''}></td>`
            : '<td></td>';
        const hasGps = s && s.location && typeof s.location === 'object' && s.location.lat != null;
        // Binoculars — center map on this step's GPS
        let focusCell;
        if (hasGps) {
            const lat = Number(s.location.lat);
            const lng = Number(s.location.lng);
            focusCell = `<td style="text-align:center;"><span class="aim-mb-step-focus" data-center-lat="${lat}" data-center-lng="${lng}" title="Center map on this step">🔭</span></td>`;
        } else {
            focusCell = '<td></td>';
        }
        // Edit — open this instruction in Percepto's editor
        const instrId = s && s.id;
        const editCell = instrId ? `<td style="text-align:center;"><span class="aim-mb-step-edit" data-edit-instr="${instrId}" title="Open this step in the mission editor">✏️</span></td>` : '<td></td>';
        // Altitude value: inline-editable when value1_name === 'm'.
        // Click → input → Enter/blur to queue change.
        let valCell;
        if (editable) {
            const u = unit || getDistanceUnit();
            const rawNum = u === 'imperial' ? Math.round(s.value1 * 3.28084) : Math.round(s.value1);
            const pending = pendingChange;
            const committed = missionId ? getCommitted(missionId, s.id) : null;
            if (pending) {
                const pendingDisplay = u === 'imperial' ? `${Math.round(pending.value).toLocaleString()} ft ALT` : `${Math.round(pending.value).toLocaleString()} m ALT`;
                valCell = `<td><span class="aim-mb-alt-pending" data-alt-edit data-instr-id="${s.id}" data-orig-alt="${rawNum}" title="Pending change — was ${rawNum}, will be ${Math.round(pending.value)}. Click to re-edit.">${escapeHtml(pendingDisplay)} ⏳</span></td>`;
            } else if (committed) {
                // Locally-committed but cache still has old value.
                // Show "OLD ALT (new: NEW ft)" until Refresh refetches.
                const unitLabel = committed.unit === 'imperial' ? 'ft' : 'm';
                valCell = `<td><span class="aim-mb-alt-editable" data-alt-edit data-instr-id="${s.id}" data-orig-alt="${rawNum}" title="Was ${rawNum}, committed ${Math.round(committed.value)} ${unitLabel}. Refresh to reload from server.">${escapeHtml(val)} <span class="aim-mb-alt-committed">(new: ${Math.round(committed.value).toLocaleString()} ${unitLabel})</span></span></td>`;
            } else {
                valCell = `<td><span class="aim-mb-alt-editable" data-alt-edit data-instr-id="${s.id}" data-orig-alt="${rawNum}" title="Click to edit altitude. Right-click to copy raw value.">${escapeHtml(val)}</span></td>`;
            }
        } else {
            // v0.64 diag: why isn't this step's altitude editable? Dump the raw
            // altitude fields for navigate steps so we can wire up nav editing.
            if (s && s.type_name === 'navigate') {
                dlog(`${TAG} [navalt] navigate not editable — value1=${JSON.stringify(s.value1)} value1_name=${JSON.stringify(s.value1_name)} value2=${JSON.stringify(s.value2)} value2_name=${JSON.stringify(s.value2_name)} keys=[${Object.keys(s).join(',')}]`);
            }
            valCell = `<td>${escapeHtml(val)}</td>`;
        }
        // Lat / Long / GPS cells. Lat & Long: click or right-click copies the
        // raw number (M1-edit to move the waypoint is a planned fast-follow).
        // GPS: a Google Maps link — left-click opens a new tab, right-click
        // copies the URL.
        let latCell = '<td></td>', lngCell = '<td></td>', gpsCell = '<td></td>';
        if (hasGps) {
            const lat = Number(s.location.lat);
            const lng = Number(s.location.lng);
            const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
            latCell = `<td style="font-size:10px;"><span class="aim-mb-latlng" data-coord-val="${lat}" title="Click or right-click to copy latitude. (Editing — moving the waypoint — coming soon.)">${lat.toFixed(6)}</span></td>`;
            lngCell = `<td style="font-size:10px;"><span class="aim-mb-latlng" data-coord-val="${lng}" title="Click or right-click to copy longitude. (Editing — moving the waypoint — coming soon.)">${lng.toFixed(6)}</span></td>`;
            gpsCell = `<td style="font-size:10px;"><span class="aim-mb-gps" data-maps-url="${mapsUrl}" title="Click: open in Google Maps (new tab). Right-click: copy the Maps link.">${lat.toFixed(6)}, ${lng.toFixed(6)}</span></td>`;
        }
        // Elevation + AGL cells — populated by elevation cache (or "…" while fetching)
        const u = unit || getDistanceUnit();
        let elevCell = '<td></td>';
        let aglCell = '<td></td>';
        if (hasGps) {
            const lat = Number(s.location.lat);
            const lng = Number(s.location.lng);
            const elevM = getElevationFromCache(lat, lng);
            if (elevM != null) {
                const elevDisplay = u === 'imperial' ? Math.round(elevM * 3.28084) : Math.round(elevM);
                const elevUnit = u === 'imperial' ? 'ft' : 'm';
                elevCell = `<td><span class="aim-mb-elev" data-elev-raw="${elevDisplay}" title="Click to copy raw elevation">${elevDisplay.toLocaleString()} ${elevUnit} ELV</span></td>`;
                // AGL only meaningful if step has altitude (value1_name === 'm').
                // It's inline-editable: editing AGL back-solves altitude = ground + AGL.
                // Uses the EFFECTIVE altitude (pending change wins) so editing the
                // Value cell and the AGL cell stay in sync, just like the Site Setup SUM.
                if (editable) {
                    const effAltM = (pendingChange && typeof pendingChange.newM === 'number') ? pendingChange.newM : s.value1;
                    const origAltDisp = u === 'imperial' ? Math.round(s.value1 * 3.28084) : Math.round(s.value1);
                    const aglM = effAltM - elevM;
                    const aglDisplay = u === 'imperial' ? Math.round(aglM * 3.28084) : Math.round(aglM);
                    const aglFt = u === 'imperial' ? aglDisplay : Math.round(aglM * 3.28084);
                    const { cls, titleSuffix } = aglThresholdsForType(rawType, aglFt);
                    aglCell = `<td><span class="aim-mb-agl aim-mb-agl-editable ${cls}" data-agl-edit data-instr-id="${s.id}" data-elev-m="${elevM}" data-orig-alt="${origAltDisp}" data-agl-raw="${aglDisplay}" data-agl-cur="${aglDisplay}" title="AGL = altitude − ground elevation. ${titleSuffix} Click to edit AGL (sets altitude = ground + AGL). Right-click to copy raw.">${aglDisplay.toLocaleString()} ${elevUnit}</span></td>`;
                }
            } else {
                elevCell = `<td><span class="aim-mb-elev-loading" data-elev-loading="${lat},${lng}">…</span></td>`;
                aglCell = `<td><span class="aim-mb-agl-loading">…</span></td>`;
            }
        }
        return `<tr${rowClass}>${selCell}${focusCell}${editCell}<td>${idx}</td><td>${escapeHtml(type)}</td>${elevCell}${valCell}${aglCell}${latCell}${lngCell}${gpsCell}</tr>`;
    }

    // AGL thresholds differ by step type:
    //   snapshot: cameras point AT the ground, so near-zero AGL is the
    //     goal. RED <0 (below ground!), GREEN 0-49 ft, BLUE >=50 ft
    //   navigate (and others): drone is FLYING, needs clearance.
    //     RED <90 ft, GREEN 90-170 ft, BLUE >170 ft (matches Python DEM script)
    function aglThresholdsForType(rawType, aglFt) {
        if (rawType === 'snapshot') {
            if (aglFt < 0) return { cls: 'aim-mb-agl-low', titleSuffix: 'Snapshot below ground (<0 ft) — bad target.' };
            if (aglFt >= 40) return { cls: 'aim-mb-agl-high', titleSuffix: 'Snapshot far from ground (>=40 ft) — may miss target.' };
            return { cls: 'aim-mb-agl-ok', titleSuffix: 'Snapshot near ground (0-39 ft) — good target.' };
        }
        // navigate + other GPS step types: flight clearance thresholds
        if (aglFt < 90) return { cls: 'aim-mb-agl-low', titleSuffix: 'Too low (<90 ft) — flight clearance violation.' };
        if (aglFt > 170) return { cls: 'aim-mb-agl-high', titleSuffix: 'Too high (>170 ft).' };
        return { cls: 'aim-mb-agl-ok', titleSuffix: 'Within clearance (90-170 ft).' };
    }

    // ========================================================
    // Exports
    // ========================================================
    function doExport(kind, rows, visibleCols) {
        const sel = panelState.selectedIds;
        const exportRows = sel.size > 0 ? rows.filter(r => sel.has(r.id)) : rows;
        // CSV/TSV: visible cols only, excluding Active
        const csvCols = visibleCols.filter(c => !c.csvExclude);
        if (kind === 'csv' || kind === 'tsv') {
            const sep = kind === 'csv' ? ',' : '\t';
            const lines = [csvCols.map(c => quoteCsv(c.label, sep)).join(sep)];
            exportRows.forEach(r => {
                lines.push(csvCols.map(c => quoteCsv(String(formatCellValue(r, c, panelState.distanceUnit, panelState.thresholds)), sep)).join(sep));
            });
            const out = lines.join('\n');
            copyToClipboard(out);
            showToast(`Copied ${exportRows.length} mission${exportRows.length === 1 ? '' : 's'} as ${kind.toUpperCase()}`, '#5fff5f');
        } else if (kind === 'json') {
            // JSON dumps everything (full mission objects, not just visible cols)
            const sid = getCurrentSiteID();
            let full;
            if (panelState.mode === 'log') {
                const bucket = logBySite[sid];
                full = bucket ? bucket.rows.filter(m => sel.size === 0 || sel.has(m.id)) : [];
            } else {
                const bucket = missionsBySite[sid];
                full = bucket ? bucket.missions.filter(m => sel.size === 0 || sel.has(m.id)) : [];
            }
            copyToClipboard(JSON.stringify(full, null, 2));
            showToast(`Copied ${full.length} mission${full.length === 1 ? '' : 's'} as JSON`, '#5fff5f');
        }
    }

    function quoteCsv(s, sep) {
        const needsQuote = s.includes(sep) || s.includes('"') || s.includes('\n');
        if (!needsQuote) return s;
        return '"' + s.replace(/"/g, '""') + '"';
    }

    function copyToClipboard(text) {
        try {
            navigator.clipboard.writeText(text);
        } catch (e) {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (er) {}
            ta.remove();
        }
    }

    // ========================================================
    // Toast
    // ========================================================
    function showToast(msg, color) {
        const id = 'aim-mb-toast';
        const old = document.getElementById(id);
        if (old) old.remove();
        const t = document.createElement('div');
        t.id = id;
        Object.assign(t.style, {
            position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
            background: '#1f2228', border: `1px solid ${color || '#14d2dc'}`, color: '#fff',
            padding: '8px 16px', borderRadius: '6px', fontSize: '12px', fontWeight: '600',
            zIndex: '1000000', fontFamily: "'Lato','Segoe UI',sans-serif",
            boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
        });
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => { try { t.remove(); } catch (e) {} }, 3000);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // ============================================================
    // MISSION SOP VALIDATORS  (Phase 1)
    // ------------------------------------------------------------
    // Geometric/structural SOP checks over the site's missions, the
    // mission-side twin of the Site Setup SOP Validators in the Asset
    // Inspector. Registered as their OWN Control Panel section (second
    // scriptId, scope 'mission-bank') with a site-type PRESET selector,
    // per-check enables + editable thresholds, and a "🚩 Run check"
    // action that lists every violation in a floating report.
    //
    // 5 checks (per the SOP spec):
    //   1. navInFfz     — no Navigate is OUTSIDE an FFZ
    //   2. navAboveFfz  — no Navigate is lower than the FFZ it sits in
    //   3. snapAgl      — no Snapshot is below its min AGL (default 0 ft)
    //   4. blockBalance — every Snapshot has a matching Thermal/GEM/Wait block
    //   5. navSnapDist  — Navigate→Snapshot distance within [min,max] ft
    //
    // Presets are pluggable: add a key to MISSION_SOP_PRESETS and it
    // appears in the selector. Per-preset threshold/enable EDITS persist
    // separately (MISSION_SOP_OVERRIDES_KEY) so switching presets never
    // loses a tweak. Only Upstream ships real SOP numbers today; the
    // others inherit the same defaults until their SOPs are defined.
    // ============================================================
    const MISSION_SOP_SCRIPT_ID = 'aim-mission-sop';
    const MISSION_SOP_PRESET_KEY = 'aim-mb-sop-preset';
    const MISSION_SOP_OVERRIDES_KEY = 'aim-mb-sop-overrides';
    const MISSION_SOP_ENABLED_KEY = 'aim-mb-sop-enabled';
    const SOP_REPORT_ID = 'aim-mb-sop-report';

    // Per-check default enables (shared across presets unless overridden).
    const MISSION_SOP_ENABLE_DEFAULTS = {
        navInFfz: true, navAboveFfz: true, snapAgl: true, blockBalance: true, navSnapDist: true,
    };
    // Threshold defaults per preset. Upstream = the live SOP numbers.
    // Downstream / T&D start as copies (editable) until their SOPs land.
    const UPSTREAM_THRESH = {
        navSnapMinFt: 96,   // Navigate→Snapshot min standoff
        navSnapMaxFt: 204,  // Navigate→Snapshot max standoff
        snapMinAglFt: 0,    // Snapshot must be at/above this AGL
        navFloorTolFt: 0,   // slack on "Navigate ≥ FFZ min alt"
    };
    const MISSION_SOP_PRESETS = {
        upstream:   { label: 'OIL · Upstream',   thresholds: { ...UPSTREAM_THRESH } },
        downstream: { label: 'OIL · Downstream', thresholds: { ...UPSTREAM_THRESH } },
        td:         { label: 'T&D',              thresholds: { ...UPSTREAM_THRESH } },
    };

    function loadSopPreset() {
        const k = gmGet(MISSION_SOP_PRESET_KEY, 'upstream');
        return MISSION_SOP_PRESETS[k] ? k : 'upstream';
    }
    let sopPreset = loadSopPreset();
    function loadSopOverrides() {
        const o = gmGet(MISSION_SOP_OVERRIDES_KEY, null);
        return (o && typeof o === 'object') ? o : {};
    }
    let sopOverrides = loadSopOverrides();
    function loadSopEnabled() {
        const e = gmGet(MISSION_SOP_ENABLED_KEY, null);
        return Object.assign({}, MISSION_SOP_ENABLE_DEFAULTS, (e && typeof e === 'object') ? e : {});
    }
    let sopEnabled = loadSopEnabled();
    let sopMasterEnabled = true;

    // Effective thresholds = preset defaults with this preset's saved edits applied.
    function effectiveSopThresholds() {
        const base = MISSION_SOP_PRESETS[sopPreset].thresholds;
        const ov = (sopOverrides[sopPreset] && sopOverrides[sopPreset].thresholds) || {};
        return Object.assign({}, base, ov);
    }
    function setSopThreshold(id, value) {
        if (!sopOverrides[sopPreset]) sopOverrides[sopPreset] = { thresholds: {} };
        if (!sopOverrides[sopPreset].thresholds) sopOverrides[sopPreset].thresholds = {};
        sopOverrides[sopPreset].thresholds[id] = value;
        gmSet(MISSION_SOP_OVERRIDES_KEY, sopOverrides);
    }

    // --- geometry helpers (self-contained; ring = [{lat,lng}]) -----------
    function sopPointInPolygon(pt, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const yi = ring[i].lat, xi = ring[i].lng;
            const yj = ring[j].lat, xj = ring[j].lng;
            const intersect = ((yi > pt.lat) !== (yj > pt.lat)) &&
                (pt.lng < (xj - xi) * (pt.lat - yi) / ((yj - yi) || 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    function sopHaversineFt(a, b) {
        const R = 6371000; // m
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
        const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return (2 * R * Math.asin(Math.min(1, Math.sqrt(s)))) * 3.28084;
    }

    // Fetch the site's FFZs (type 16) → [{ring, minAltM}]. Cookie auth,
    // same endpoint the Asset Inspector uses. Cached per site for the
    // session so repeat runs don't re-hit the network.
    const sopFfzCache = {};
    function fetchSiteFfzs(siteID) {
        if (sopFfzCache[siteID]) return Promise.resolve(sopFfzCache[siteID]);
        const url = `https://percepto.app/map_objects/?getPoiMapObjectsAsList=true&site_id=${encodeURIComponent(siteID)}`;
        return fetch(url, { credentials: 'include' })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(arr => {
                const list = Array.isArray(arr) ? arr : (arr && arr.objects) || [];
                const ffzs = list.filter(e => e && e.type === 16 && Array.isArray(e.coords) && e.coords.length >= 3)
                    .map(e => ({
                        ring: e.coords.map(c => ({ lat: c.lat, lng: c.lng })),
                        minAltM: (e.restrictions && typeof e.restrictions.minAlt === 'number') ? e.restrictions.minAlt : null,
                        name: e.name || '',
                    }));
                sopFfzCache[siteID] = ffzs;
                return ffzs;
            });
    }

    // Core check. Returns { violations:[{missionId,missionName,check,stepIndex,detail,severity}], ffzCount, missionCount }.
    async function runMissionSop(missions, ffzs) {
        const th = effectiveSopThresholds();
        const violations = [];

        // Pre-warm DEM cache for all snapshot points (AGL check).
        if (sopEnabled.snapAgl) {
            const pts = [];
            missions.forEach(m => realSteps(m.instructions).forEach(s => {
                if (s.type_name === 'snapshot' && s.location) pts.push({ lat: s.location.lat, lng: s.location.lng });
            }));
            if (pts.length) { try { await bulkFetchElevations(pts); } catch (e) { console.warn(`${TAG} SOP DEM prefetch failed`, e); } }
        }

        for (const m of missions) {
            const steps = realSteps(m.instructions);
            const ctx = { id: m.id, name: m.name || `Mission ${m.id}` };
            let lastNav = null;                 // governing Navigate for snapshots below it
            let snapN = 0, camOn = 0, camOff = 0, gemOn = 0, gemOff = 0, waitN = 0;

            steps.forEach((s, i) => {
                if (s.type_name === 'navigate') {
                    lastNav = s;
                    if (!s.location) return;
                    // 1. Navigate must be inside some FFZ.
                    const containing = ffzs.find(f => sopPointInPolygon(s.location, f.ring));
                    if (sopEnabled.navInFfz && ffzs.length && !containing) {
                        violations.push({ ...ctx, check: 'Navigate outside FFZ', stepIndex: s.index_in_app,
                            detail: 'Navigate point is not inside any Free-Fly Zone', severity: 'high' });
                    }
                    // 2. Navigate altitude ≥ containing FFZ min alt (− tolerance).
                    if (sopEnabled.navAboveFfz && containing && typeof containing.minAltM === 'number' && typeof s.value1 === 'number') {
                        const navFt = s.value1 * 3.28084, floorFt = containing.minAltM * 3.28084;
                        if (Math.round(navFt) < Math.round(floorFt) - th.navFloorTolFt) {
                            violations.push({ ...ctx, check: 'Navigate below FFZ floor', stepIndex: s.index_in_app,
                                detail: `Navigate ${Math.round(navFt)} ft < FFZ min ${Math.round(floorFt)} ft${containing.name ? ` (${containing.name})` : ''}`, severity: 'high' });
                        }
                    }
                } else if (s.type_name === 'snapshot') {
                    snapN++;
                    // 3. Snapshot AGL ≥ min (default 0 → not underground).
                    if (sopEnabled.snapAgl && s.location && typeof s.value1 === 'number') {
                        const groundM = getElevationFromCache(s.location.lat, s.location.lng);
                        if (typeof groundM === 'number') {
                            const aglFt = (s.value1 - groundM) * 3.28084;
                            if (Math.round(aglFt) < th.snapMinAglFt) {
                                violations.push({ ...ctx, check: 'Snapshot below min AGL', stepIndex: s.index_in_app,
                                    detail: `Snapshot AGL ${Math.round(aglFt)} ft < min ${th.snapMinAglFt} ft`, severity: 'high' });
                            }
                        }
                    }
                    // 5. Navigate→Snapshot distance within band.
                    if (sopEnabled.navSnapDist && lastNav && lastNav.location && s.location) {
                        const dFt = sopHaversineFt(lastNav.location, s.location);
                        if (dFt < th.navSnapMinFt || dFt > th.navSnapMaxFt) {
                            violations.push({ ...ctx, check: 'Navigate↔Snapshot distance', stepIndex: s.index_in_app,
                                detail: `${Math.round(dFt)} ft (allowed ${th.navSnapMinFt}–${th.navSnapMaxFt} ft)`, severity: 'warn' });
                        }
                    }
                } else if (s.type_name === 'cameraSelect') {
                    if (s.value1) camOn++; else camOff++;
                } else if (s.type_name === 'gemMode') {
                    if (Number(s.value1) === 1) gemOn++; else gemOff++;
                } else if (s.type_name === 'wait') {
                    waitN++;
                }
            });

            // 4. Block balance — one Thermal-on/GEM-on/Wait/GEM-off/Thermal-off per Snapshot.
            if (sopEnabled.blockBalance) {
                const parts = [];
                if (camOn !== snapN) parts.push(`Thermal-on ${camOn}`);
                if (camOff !== snapN) parts.push(`Thermal-off ${camOff}`);
                if (gemOn !== snapN) parts.push(`GEM-on ${gemOn}`);
                if (gemOff !== snapN) parts.push(`GEM-off ${gemOff}`);
                if (waitN !== snapN) parts.push(`Wait ${waitN}`);
                if (parts.length) {
                    violations.push({ ...ctx, check: 'Scan-block mismatch', stepIndex: null,
                        detail: `${snapN} snapshot${snapN === 1 ? '' : 's'} but ${parts.join(', ')}`, severity: 'high' });
                }
            }
        }
        return { violations, ffzCount: ffzs.length, missionCount: missions.length };
    }

    // Run over the current site's missions (fetch if cold) and show report.
    function runMissionSopAndReport() {
        if (!sopMasterEnabled) { renderSopReport({ error: 'Mission SOP validators are disabled in the Control Panel.' }); return; }
        const sid = getCurrentSiteID();
        if (!sid) { renderSopReport({ error: 'No site loaded' }); return; }
        renderSopReport({ loading: 'Loading missions…' });
        const go = (missions) => {
            renderSopReport({ loading: 'Fetching FFZs + ground elevations…' });
            fetchSiteFfzs(sid)
                .then(ffzs => runMissionSop(missions, ffzs))
                .then(res => renderSopReport(res))
                .catch(e => { console.warn(`${TAG} SOP run failed`, e); renderSopReport({ error: e.message || String(e) }); });
        };
        const cached = missionsBySite[sid] && missionsBySite[sid].missions;
        if (Array.isArray(cached) && cached.length) go(cached);
        else fetchMissions(sid, go, (err) => renderSopReport({ error: err }));
    }

    // --- floating report popup -------------------------------------------
    function closeSopReport() {
        const el = document.getElementById(SOP_REPORT_ID);
        if (el) el.remove();
    }
    function renderSopReport(state) {
        closeSopReport();
        const pop = document.createElement('div');
        pop.id = SOP_REPORT_ID;
        pop.style.cssText = 'position:fixed;top:80px;right:24px;width:440px;max-height:72vh;z-index:2147483600;' +
            'background:#0f1216;border:1px solid rgba(95,255,95,0.4);border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.6);' +
            "font-family:'Lato','Segoe UI',sans-serif;color:#e6e6e6;display:flex;flex-direction:column;overflow:hidden";
        const presetLabel = MISSION_SOP_PRESETS[sopPreset].label;
        let body;
        if (state.error) {
            body = `<div style="padding:16px;color:#ff8a80">⚠ ${escapeHtml(state.error)}</div>`;
        } else if (state.loading) {
            body = `<div style="padding:16px;color:#9ad">${escapeHtml(state.loading)}</div>`;
        } else {
            const v = state.violations || [];
            // Group by mission.
            const byMission = {};
            v.forEach(x => { (byMission[x.id] = byMission[x.id] || { name: x.name, items: [] }).items.push(x); });
            const missionsWith = Object.keys(byMission).length;
            const clean = state.missionCount - missionsWith;
            const highN = v.filter(x => x.severity === 'high').length;
            const sevColor = s => s === 'high' ? '#ff5252' : '#ffd54f';
            const rows = Object.keys(byMission).map(mid => {
                const g = byMission[mid];
                const items = g.items.map(it => `
                    <div style="display:flex;gap:8px;padding:3px 0;font-size:11px;border-top:1px solid rgba(255,255,255,0.05)">
                        <span style="color:${sevColor(it.severity)};font-weight:700;flex-shrink:0">${it.severity === 'high' ? '●' : '▲'}</span>
                        <span style="flex:1">${escapeHtml(it.check)}${it.stepIndex != null ? ` <span style="color:#888">· step ${it.stepIndex}</span>` : ''}<br><span style="color:#aaa">${escapeHtml(it.detail)}</span></span>
                    </div>`).join('');
                return `
                    <div class="aim-sop-mrow" data-mid="${mid}" style="padding:7px 12px;border-bottom:1px solid #1f2430;cursor:pointer">
                        <div style="font-weight:700;font-size:12px;color:#5fff5f">${escapeHtml(g.name)} <span style="color:#888;font-weight:400">· ${g.items.length} issue${g.items.length === 1 ? '' : 's'}</span></div>
                        ${items}
                    </div>`;
            }).join('');
            const summary = v.length === 0
                ? `<span style="color:#5fff5f">✓ All ${state.missionCount} mission${state.missionCount === 1 ? '' : 's'} pass.</span>`
                : `<strong style="color:#ff5252">${v.length}</strong> issue${v.length === 1 ? '' : 's'} (${highN} hard) across <strong>${missionsWith}</strong> mission${missionsWith === 1 ? '' : 's'} · <span style="color:#5fff5f">${clean} clean</span>`;
            body = `
                <div style="padding:8px 12px;font-size:11px;color:#bbb;border-bottom:1px solid #1f2430">
                    ${summary}<br><span style="color:#777">${state.ffzCount} FFZ${state.ffzCount === 1 ? '' : 's'} · preset ${escapeHtml(presetLabel)} · click a mission to open it</span>
                </div>
                <div style="overflow:auto">${rows || '<div style="padding:16px;color:#5fff5f">No violations 🎉</div>'}</div>`;
        }
        pop.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(95,255,95,0.06);border-bottom:1px solid rgba(255,255,255,0.08)">
                <div style="flex:1;text-align:center;font-weight:700;color:#5fff5f;font-size:13px">🚩 Mission SOP Check</div>
                <button data-sop-rerun style="background:rgba(95,255,95,0.12);border:1px solid rgba(95,255,95,0.4);color:#5fff5f;padding:2px 8px;font-size:11px;border-radius:3px;cursor:pointer;font-weight:600">Re-run</button>
                <button data-sop-x style="background:rgba(95,255,95,0.12);border:1px solid rgba(95,255,95,0.4);color:#5fff5f;padding:2px 8px;font-size:11px;border-radius:3px;cursor:pointer;font-weight:600">✕</button>
            </div>
            ${body}`;
        document.body.appendChild(pop);
        pop.querySelector('[data-sop-x]').onclick = closeSopReport;
        pop.querySelector('[data-sop-rerun]').onclick = runMissionSopAndReport;
        pop.querySelectorAll('.aim-sop-mrow').forEach(r => {
            r.onclick = () => { try { openPanelAndDrill(Number(r.dataset.mid)); } catch (e) { console.warn(`${TAG} drill failed`, e); } };
        });
    }

    // --- Control Panel: SOP section --------------------------------------
    function handleMissionSopToggle(msg) {
        const id = msg.toggleId;
        const val = msg.value !== undefined ? msg.value : msg.enabled;
        if (id === 'sop-master') { sopMasterEnabled = !!val; return; }
        if (id === 'preset') {
            if (MISSION_SOP_PRESETS[val] && val !== sopPreset) {
                sopPreset = val;
                gmSet(MISSION_SOP_PRESET_KEY, sopPreset);
                registerMissionSop(); // re-publish so CP shows this preset's thresholds
            }
            return;
        }
        if (Object.prototype.hasOwnProperty.call(sopEnabled, id)) {
            const v = !!val;
            if (v === sopEnabled[id]) return;
            sopEnabled[id] = v;
            gmSet(MISSION_SOP_ENABLED_KEY, sopEnabled);
            return;
        }
        if (typeof msg.value === 'number') {
            const cur = effectiveSopThresholds();
            if (Object.prototype.hasOwnProperty.call(cur, id) && msg.value !== cur[id]) {
                setSopThreshold(id, msg.value);
            }
        }
    }
    function registerMissionSop() {
        if (!controlChannel) return;
        const th = effectiveSopThresholds();
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: MISSION_SOP_SCRIPT_ID, name: 'Mission SOP Validators',
            description: 'Structural/geometric SOP checks over the site’s missions. Pick a site-type preset, then "Run check" to list every violation.',
            version: SCRIPT_VERSION, group: 'Mission SOP', scope: 'mission-bank', priority: 30,
            toggles: [
                { id: 'sop-master', label: 'Enable mission SOP validators', type: 'boolean', default: true, master: true },
                { id: 'preset', label: 'Site-type preset', type: 'select', default: sopPreset,
                    options: Object.keys(MISSION_SOP_PRESETS).map(k => ({ value: k, label: MISSION_SOP_PRESETS[k].label })) },
                { id: 'navInFfz', label: 'Check · Navigate inside an FFZ', type: 'boolean', default: sopEnabled.navInFfz },
                { id: 'navAboveFfz', label: 'Check · Navigate ≥ FFZ floor', type: 'boolean', default: sopEnabled.navAboveFfz },
                { id: 'navFloorTolFt', label: 'Navigate-vs-floor slack', type: 'number', min: 0, max: 100, step: 1, default: th.navFloorTolFt, unit: 'ft' },
                { id: 'snapAgl', label: 'Check · Snapshot ≥ min AGL', type: 'boolean', default: sopEnabled.snapAgl },
                { id: 'snapMinAglFt', label: 'Snapshot min AGL', type: 'number', min: -50, max: 200, step: 1, default: th.snapMinAglFt, unit: 'ft' },
                { id: 'blockBalance', label: 'Check · Scan-block balance per snapshot', type: 'boolean', default: sopEnabled.blockBalance },
                { id: 'navSnapDist', label: 'Check · Navigate↔Snapshot distance', type: 'boolean', default: sopEnabled.navSnapDist },
                { id: 'navSnapMinFt', label: 'Navigate↔Snapshot min', type: 'number', min: 0, max: 1000, step: 1, default: th.navSnapMinFt, unit: 'ft' },
                { id: 'navSnapMaxFt', label: 'Navigate↔Snapshot max', type: 'number', min: 0, max: 2000, step: 1, default: th.navSnapMaxFt, unit: 'ft' },
                { id: 'mission-sop-run', label: '🚩 Run SOP check', type: 'button', action: 'mission-sop-run' },
                { id: 'mission-sop-close', label: 'Close report', type: 'button', action: 'mission-sop-close' },
            ],
            hotkeys: [],
        });
    }

    // ========================================================
    // Init
    // ========================================================
    function init() {
        console.log(`${TAG} v${SCRIPT_VERSION} init (${CONTEXT})`);
        setupControlPanel();
        registerWithControlPanel();
        registerMissionSop();
        // Inject the force-show-dots CSS rule into the iframe head.
        // We use a class instead of inline !important styles so cleanup
        // is just removing the class — survives Percepto DOM reuse.
        if (CONTEXT === 'IFRAME') {
            injectGlobalEditStyles();
        }
        // IFRAME-only — the Mission Bank UI lives in the React iframe
        if (CONTEXT === 'IFRAME') {
            // Bumped 2s → 4s; SUM only needs replacing on URL nav,
            // not constant polling. Cheap enough to keep but no need
            // to fire 30 times a minute.
            setInterval(runSumInjection, 4000);
            setTimeout(runSumInjection, 1000);
            try { patchLeafletMap(); } catch (e) {}
            // Live editor bridge: syncs MBT's display to the live mission-editor
            // state + drives armed snapshot auto-AGL on GPS moves (700ms poll,
            // early-returns unless a mission is open in the editor).
            try { startLiveEditorSync(); } catch (e) {}
            // Re-apply the native-editor collapse promptly as the instruction
            // list mounts / virtualizes on scroll (the 4s interval is too slow
            // to feel responsive). Debounced so a burst of mutations = 1 pass.
            let collapseDebounce = null;
            const editorObserver = new MutationObserver(() => {
                if (collapseDebounce) return;
                collapseDebounce = setTimeout(() => {
                    collapseDebounce = null;
                    try { applyNativeEditorCollapse(); } catch (e) {}
                    try { injectEditorCollapseButton(); } catch (e) {}
                    // Re-stamp the N#/S# marker badges too — Percepto re-renders a
                    // step's marker after a per-step save, wiping our number until
                    // the next style pass (the "S1 vanished but the circle stayed").
                    try { composerStyleNativeMarkers(); } catch (e) {}
                }, 150);
            });
            try { editorObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
            installRightClickHandler();
            // READ-ONLY probe: logs + diffs each mission save vs the cached
            // original (never modifies the save). Tells us whether the form
            // recomputes dependent fields, which decides if a fast body-patch
            // path is safe. Harmless to leave on.
            installSaveDiffProbe();
            installSaveHotkey();
        }
        // Re-evaluate injection on hashchange (URL → Mission Bank)
        try {
            const top = window.top || window;
            top.addEventListener('hashchange', () => {
                hideSumButton();
                // SAFETY: disarm snapshot auto-AGL on any navigation, so it never
                // stays armed when you (re)enter the Mission Bank.
                if (autoSnapAglEnabled) { autoSnapAglEnabled = false; try { updateAutoSnapAglUI(); } catch (e) {} }
                Object.keys(liveSnapLastLoc).forEach(k => delete liveSnapLastLoc[k]); // re-baseline next mission
                runSumInjection();
            });
        } catch (e) {}
        // Flush any pending elevation cache writes on tab close.
        window.addEventListener('beforeunload', () => flushElevationCache());
        console.log(`${TAG} ready`);
    }

    init();
})();
