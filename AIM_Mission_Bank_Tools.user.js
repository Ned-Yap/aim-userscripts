// ==UserScript==
// @name         AIM Mission Bank Tools
// @namespace    http://tampermonkey.net/
// @version      2.50
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Bank_Tools.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Bank_Tools.user.js
// @description  Mission Bank Tools — SUM button opens an all-missions Summary panel with per-mission stats, sortable columns, drill-down detail view, CSV/TSV/JSON/HTML export. First feature: Mission Summary panel.
// @author       Payden
// @match        *://percepto.app/*
// @match        *://qa.percepto.app/*
// @match        https://percepto.app/*
// @match        https://qa.percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @match        https://qa.percepto.app/static/dist/react-pages/*
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
    const SCRIPT_VERSION = '2.50';

    // Server model (v2.05): prod and QA are separate databases — the same
    // numeric site ID is two different sites. GM storage is shared across
    // origins, so per-site keys are env-namespaced (QA = qa-<id>).
    const IS_QA = location.hostname === 'qa.percepto.app' || location.hostname.endsWith('.qa.percepto.app');
    const envSiteKey = (sid) => IS_QA ? `qa-${sid}` : String(sid);
    // Debug flag — set window.__AIM_MB_DEBUG = true in DevTools to enable
    // verbose [edit], [queue], [fiber] logs. Off by default for speed.
    const DEBUG = () => !!(window.__AIM_MB_DEBUG || (window.top && window.top.__AIM_MB_DEBUG));
    const dlog = (...args) => { if (DEBUG()) console.log(...args); };
    const TAG = '[AIM MB TOOLS]';
    // v1.90 perf instrumentation — counters reported to console every 5s while
    // the mission editor is doing work, so live slowness can be attributed to a
    // specific pathway (observer passes / tick passes / card writes / node
    // re-creation ping-pong / elevation lookups) instead of guessed at.
    const MB_PERF = { obs: 0, ticks: 0, collapsePasses: 0, collapseMs: 0, cardWrites: 0, cxCreates: 0, markerPasses: 0, markerMs: 0, elevLook: 0, elevKicks: 0 };
    // Per-step ground memo (ground elevation for a fixed lat/lng never changes):
    // stops the compact-card tick from re-hitting the shared elevation cache —
    // whose miss path is a getNearest LINEAR SCAN — for every card every 700ms.
    const stepElevMemo = {};
    const stepElevMissAt = {};
    const STEP_ELEV_MISS_COOLDOWN = 5000;
    // Per-location cooldown for display-driven fetch kicks (the queue dedupes
    // in-flight, but a large mission re-kicked every uncached point every tick).
    const elevKickAt = {};
    const ELEV_KICK_COOLDOWN = 15000;
    // v1.91: card AGL refresh is demand-driven, not per-tick. cxAglPending is
    // recomputed on every collapse pass (true while any card still shows the
    // MSL placeholder because its ground elevation hasn't arrived) — the tick
    // only re-renders while it's true, at a slow cadence, then goes idle.
    let cxAglPending = false;
    let liveTickN = 0;
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const CONTEXT = window === window.top ? 'TOP' : 'IFRAME';
    // Per-tab identity shared across frames via window.top (same-origin).
    // Must match the Control Panel's aimTabId so hotkeys/actions stay tab-local.
    function aimTabId() {
        try {
            const pw = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
            const t = pw.top;
            if (!t.__AIM_TAB_ID) t.__AIM_TAB_ID = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
            return t.__AIM_TAB_ID;
        } catch (e) { return null; }
    }
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
    let renameSuppressAutoAgl = 0; // >0 while an inline rename saves — handleMissionSave skips the auto-AGL pass so a rename never re-floats snapshots
    const CACHE_KEY_DEFAULT_SNAP_AGL = 'aim-mb-default-snap-agl';
    let defaultSnapAglFt = gmGet(CACHE_KEY_DEFAULT_SNAP_AGL, 10);
    // Editor compact-card altitude view: AGL (ground-relative) vs MSL (stored).
    // AGL reads more naturally; MSL is what's stored (for verifying). Toggle in
    // the editor button row. Persisted.
    const CACHE_KEY_AGL_VIEW = 'aim-mb-editor-agl-view';
    let showAglInEditor = gmGet(CACHE_KEY_AGL_VIEW, true);
    const CACHE_KEY_HIDE_FLAGPOLE = 'aim-mb-hide-flagpole';
    let hideFlagPoleOverlay = gmGet(CACHE_KEY_HIDE_FLAGPOLE, false);
    // 🧮 Math in native step number fields (#236): type an arithmetic
    // expression ("2630+15") into any Ant InputNumber in the step edit form
    // and press Enter (or click away) — MBT evaluates it and commits the
    // result through the InputNumber component's onChange (the same commit
    // path the Apply queue uses). A LEADING +, * or / is relative to the
    // field's committed value: "+15" on a field holding 2630 → 2645.
    const CACHE_KEY_MATH_FIELDS = 'aim-mb-math-fields';
    let mathFieldsEnabled = gmGet(CACHE_KEY_MATH_FIELDS, true);

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
    // v2.26: which frame owns the 👁 overlay — the SS/MB map iframe, or any
    // frame that actually has a Leaflet map (Data View TOP). Used by the
    // SET_TOGGLE handlers so preview toggles act in whichever frame renders.
    function mpvFrameOk() {
        if (CONTEXT === 'IFRAME') return true;
        try { return !!getLeafletMap(); } catch (e) { return false; }
    }

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
                        if (mpvFrameOk()) try { mpvTeardown(); } catch (e) {}
                    } else {
                        runSumInjection();
                        if (mpvFrameOk()) try { mpvInjectButton(); } catch (e) {}
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
                } else if (msg.toggleId === 'map-step-badges') {
                    const v = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (v !== composerMapMode) {
                        composerMapMode = v;
                        gmSet(CACHE_KEY_MAP_BADGES, composerMapMode);
                        if (CONTEXT === 'IFRAME') {
                            if (composerMapMode) { try { composerEnsureMapModeIfNeeded(); } catch (e) {} }
                            else { try { composerBadgesTeardown(); } catch (e) {} }
                        }
                    }
                } else if (msg.toggleId === 'hide-flagpole-overlay') {
                    const v = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (v !== hideFlagPoleOverlay) {
                        hideFlagPoleOverlay = v;
                        gmSet(CACHE_KEY_HIDE_FLAGPOLE, hideFlagPoleOverlay);
                        if (CONTEXT === 'IFRAME') try { applyFlagPoleOverlayHide(); } catch (e) {}
                    }
                } else if (msg.toggleId === 'mission-preview') {
                    const v = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (v !== mpvEnabled) {
                        mpvEnabled = v;
                        gmSet(CACHE_KEY_MPV_ENABLED, mpvEnabled);
                        // v2.26: mpvFrameOk, not IFRAME — on Data View the TOP
                        // instance owns the overlay; the IFRAME gate meant a
                        // DV uncheck stored the value but never tore down.
                        if (mpvFrameOk()) {
                            if (mpvEnabled) { try { mpvInjectButton(); } catch (e) {} }
                            else { try { mpvTeardown(); } catch (e) {} }
                        }
                    }
                } else if (msg.toggleId === 'preview-all') {
                    const v = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (v !== mpvAllOn) {
                        mpvAllOn = v;
                        gmSet(CACHE_KEY_MPV_ALL, mpvAllOn);
                        if (mpvFrameOk()) try { mpvAllChanged(); } catch (e) {}
                    }
                } else if (msg.toggleId === 'default-snap-agl') {
                    const v = Number(msg.value !== undefined ? msg.value : msg.enabled);
                    if (isFinite(v) && v !== defaultSnapAglFt) {
                        defaultSnapAglFt = v;
                        gmSet(CACHE_KEY_DEFAULT_SNAP_AGL, defaultSnapAglFt);
                        if (CONTEXT === 'IFRAME') { try { updateAutoSnapAglUI(); } catch (e) {} }
                    }
                } else if (msg.toggleId === 'math-fields') {
                    const v = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (v !== mathFieldsEnabled) {
                        mathFieldsEnabled = v;
                        gmSet(CACHE_KEY_MATH_FIELDS, mathFieldsEnabled);
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
            } else if (msg.type === 'HOTKEY_FIRED' && msg.scriptId === SCRIPT_ID) {
                // Cross-tab guard: BroadcastChannel delivers to EVERY open tab — only
                // the tab that pressed/clicked may act (tabId from CP v1.43+; visibility
                // fallback under an older CP).
                if (msg.tabId ? msg.tabId !== aimTabId() : document.hidden) return;
                // Editor lives in the IFRAME — toggle Click-to-Add there only.
                if (CONTEXT === 'IFRAME' && msg.hotkeyId === 'toggle-click-add') { try { caSetMode(!caModeOn); } catch (e) {} }
            } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === MISSION_SOP_SCRIPT_ID) {
                handleMissionSopToggle(msg);
            } else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === MISSION_SOP_SCRIPT_ID) {
                // Cross-tab guard: BroadcastChannel delivers to EVERY open tab — only
                // the tab that pressed/clicked may act (tabId from CP v1.43+; visibility
                // fallback under an older CP).
                if (msg.tabId ? msg.tabId !== aimTabId() : document.hidden) return;
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
                { id: 'map-step-badges', label: 'N#/S# map step badges + Click-to-Add (OFF = perf test)', type: 'boolean', default: true },
                { id: 'hide-flagpole-overlay', label: 'Hide Flag Pole scan overlay (blue cone)', type: 'boolean', default: false },
                { id: 'mission-preview', label: '👁 Mission preview (map-tools button, Site Setup + Mission Bank)', type: 'boolean', default: true },
                { id: 'preview-all', label: '👁 Show ALL missions (light dots — no lines/labels)', type: 'boolean', default: false },
                { id: 'default-snap-agl', label: 'Default snapshot AGL (auto-AGL toggle)', type: 'number', min: -50, max: 500, step: 1, default: 10, unit: 'ft' },
                { id: 'math-fields', label: '🧮 Math in step number fields (type 2630+15 or +15, then Enter)', type: 'boolean', default: true },
                { id: 'colors-header', label: 'Step colors (editor cards + map badges)', type: 'header' },
                { id: 'color-nav', label: 'Navigate', type: 'color', default: STEP_COLOR_DEFAULTS.nav },
                { id: 'color-snap', label: 'Snapshot', type: 'color', default: STEP_COLOR_DEFAULTS.snap },
                { id: 'color-thermalOn', label: 'Thermal On', type: 'color', default: STEP_COLOR_DEFAULTS.thermalOn },
                { id: 'color-thermalOff', label: 'Thermal Off', type: 'color', default: STEP_COLOR_DEFAULTS.thermalOff },
                { id: 'color-gemOn', label: 'GEM On', type: 'color', default: STEP_COLOR_DEFAULTS.gemOn },
                { id: 'color-gemOff', label: 'GEM Off', type: 'color', default: STEP_COLOR_DEFAULTS.gemOff },
                { id: 'color-wait', label: 'Wait', type: 'color', default: STEP_COLOR_DEFAULTS.wait },
            ],
            hotkeys: [
                { id: 'toggle-click-add', label: 'Toggle Click-to-Add mode (mission editor)', default: '' },
            ],
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
        try { applyFlagPoleOverlayHide(); } catch (e) {}
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
    // (M2) opens our order editor. CP toggle 'map-step-badges' (default ON);
    // OFF also disables Click-to-Add + the M2 order editor (they ride the same
    // marker tagging) — primarily a perf isolation switch for large missions.
    const CACHE_KEY_MAP_BADGES = 'aim-mb-map-step-badges';
    let composerMapMode = gmGet(CACHE_KEY_MAP_BADGES, true);
    let composerMapEventsBound = false;
    let loggedNoMarkers = false;
    // Full visual + interaction teardown for the badges toggle: drop the badge
    // CSS (colors/numbers revert to native icons) and untag every marker so the
    // window-capture M1/M2 handlers stop matching them.
    function composerBadgesTeardown() {
        try {
            const st = document.getElementById('aim-mb-badge-css');
            if (st) st.remove();
            document.querySelectorAll('[data-aim-id]').forEach(el => {
                el.removeAttribute('data-aim-id');
                el.removeAttribute('data-aim-kind');
                el.removeAttribute('data-aim-num');
                el.classList.remove('aim-mb-nav', 'aim-mb-snap');
            });
        } catch (e) { console.warn(`${TAG} [map-badges] teardown failed`, e); }
    }

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
        kml.title = 'Export this mission to a Google-Earth KML — white nav→nav mission path + cyan routed base path + N#/S# pins, each pin showing its step details';
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
        // flex-wrap: the 🎞 Wrap button overflowed the sidebar width on the
        // default layout (clipped) — let it fall to its own full-width line.
        row2.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 0;margin:0 0 4px;';
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
        const caBtn = document.createElement('button');
        caBtn.id = CA_BTN_ID;
        caBtn.type = 'button';
        caBtn.style.cssText = 'flex:0 0 auto;margin-left:5px;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;';
        caBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); caSetMode(!caModeOn); };
        const wrapBtn = document.createElement('button');
        wrapBtn.id = WRAP_BTN_ID;
        wrapBtn.type = 'button';
        wrapBtn.style.cssText = 'flex:1 0 auto;margin-left:5px;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;';
        wrapBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); wrapPopup(wrapBtn); };
        // Right-click (M2) = toggle AUTO-WRAP for this session (applies the last-used
        // template on every mission SAVE — see applyWrapToBodyStr).
        wrapBtn.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); toggleAutoWrap(); };
        row2.appendChild(autoBtn); row2.appendChild(stageBtn); row2.appendChild(caBtn); row2.appendChild(wrapBtn);
        // Row 3: the Click-to-Add "Insert at" bar (shown only while the mode is ON).
        const row3 = document.createElement('div');
        row3.id = CA_BAR_ID;
        row3.style.cssText = 'display:none;align-items:center;gap:6px;margin:0 0 4px;font-size:11px;color:#cfe;';
        row3.innerHTML = '<span>Empty <b style="color:#7dff7d">L=Snapshot</b> · <b style="color:#14d2dc">R=Nav</b> · <b style="color:#ff9d3a">Alt+R</b>=del · <b style="color:#cfe">Ctrl+Z</b> undo</span>' +
            '<label style="margin-left:auto;white-space:nowrap;">Insert at N</label>' +
            '<input type="number" min="1" data-ca-at placeholder="end" title="Target group: snapshots append to the end of this group; a nav inserts right after it (rest shifts down). Blank = end of mission." style="width:52px;background:#0f1216;border:1px solid #5fff5f;color:#fff;padding:2px 6px;border-radius:3px;font:inherit;font-size:11px;">';
        row3.querySelector('[data-ca-at]').onchange = (ev) => { const v = parseInt(ev.target.value, 10); caInsertAtNav = (isFinite(v) && v >= 1) ? v : null; updateCaBanner(); };
        const addBtn = Array.from(content.querySelectorAll('button')).find(b => /add instruction/i.test(b.textContent || ''));
        if (addBtn && addBtn.parentNode) { addBtn.parentNode.insertBefore(row, addBtn.nextSibling); row.parentNode.insertBefore(row2, row.nextSibling); row2.parentNode.insertBefore(row3, row2.nextSibling); }
        else { content.insertBefore(row, content.firstChild); content.insertBefore(row2, row.nextSibling); content.insertBefore(row3, row2.nextSibling); }
        updateEditorCollapseBtn();
        updateAutoSnapAglUI();
        updateAglViewBtn();
        updateCaUI();
        updateWrapBtn(); // AFTER the rows are inserted — getElementById needs the button in the DOM
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

    // ── Click-to-Add: rapid map-click step builder ───────────────────────────
    // While editing a mission, ARM the mode (sticky ➕ toggle / hotkey, OR hold Ctrl
    // momentarily) and click empty map: LEFT = Snapshot, RIGHT = Nav. New steps copy
    // the last nav/snap's settings, land at the clicked point, and stay STAGED (Save
    // when done) — same working-copy path as ➕ Stage. "Insert at N#" targets a group
    // (blank = end); a right-click nav auto-advances the target to itself so the
    // following left-clicks drop its snapshots. Robust empty-space detection via
    // elementFromPoint (bail if a marker/UI is under the cursor), not Leaflet layer
    // click semantics.
    const CA_BTN_ID = 'aim-mb-clickadd-btn';
    const CA_BAR_ID = 'aim-mb-clickadd-bar';
    const CA_BANNER_ID = 'aim-mb-clickadd-banner';
    let caModeOn = false;
    let caInsertAtNav = null;      // 1-based target group, or null = end of mission
    let caBoundContainer = null;
    let caIdBump = 0;
    let caUndoStack = [];          // {id, kind, prevInsertAt, appId} for Ctrl+Z undo of click-added steps
    let caCtrlHeld = false;        // live Ctrl state (for box-zoom gating)
    function caMapContainer() { const m = getLeafletMap(); return (m && typeof m.getContainer === 'function') ? m.getContainer() : null; }
    // Turn Leaflet's Shift+drag box-zoom OFF whenever a mission is open in the editor —
    // it fights Shift-to-stack / Shift-drag placement and kept zooming instead of
    // placing. Scroll-wheel + the +/- buttons still zoom. Re-asserted every marker tick
    // so Leaflet can't re-enable it; restored when you leave the editor.
    function caUpdateBoxZoom() {
        if (CONTEXT !== 'IFRAME') return;
        try {
            const map = getLeafletMap();
            if (!map || !map.boxZoom || typeof map.boxZoom.enabled !== 'function') return;
            const editing = !!document.querySelector('.mission-edit__content');
            if (editing) { if (map.boxZoom.enabled()) map.boxZoom.disable(); }
            else if (!map.boxZoom.enabled()) map.boxZoom.enable();
        } catch (e) {}
    }
    function caArmed(e) { return caModeOn || !!(e && e.ctrlKey); }
    function caIsTypingTarget(t) {
        if (!t || !t.tagName) return false;
        const tn = t.tagName;
        return tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT' || t.isContentEditable || (t.closest && !!t.closest('.ant-input, .ant-select, [role="textbox"]'));
    }
    function caIsEmptySpace(e) {
        if (e && e.shiftKey) return true;   // Shift = ignore whatever icon is under the cursor → stack a step in place
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el) return true;
        // Only bail on an existing STEP MARKER (so clicking it edits that step) or our
        // own UI. Polygons/overlays are click-THROUGH — the flag-pole scan cone (a
        // default-blue leaflet-interactive path), FFZ/asset fills and FP lines must
        // NOT block dropping a step. Step markers live in the marker pane, ABOVE the
        // overlay pane, so elementFromPoint still returns the icon when you click one.
        return !el.closest('.leaflet-marker-icon, [class*="map-marker__"], .leaflet-popup, .leaflet-control, [id^="aim-"], button, input, select, textarea, a');
    }
    // Percepto draws a Flag Pole step's scan cone as a default-Leaflet-blue polygon
    // (#3388ff, fill-opacity 0.2) that covers a big area. Optional hide (GM pref via
    // Control Panel) drops it with CSS so it stops obscuring the map. Independent of
    // Click-to-Add's click-through (which works whether it's hidden or not).
    function applyFlagPoleOverlayHide() {
        if (CONTEXT !== 'IFRAME') return;
        const ID = 'aim-mb-flagpole-hide-style';
        let st = document.getElementById(ID);
        if (hideFlagPoleOverlay) {
            if (!st) {
                st = document.createElement('style'); st.id = ID;
                st.textContent = 'svg.leaflet-zoom-animated path.leaflet-interactive[stroke="#3388ff"][fill="#3388ff"]{display:none !important;}';
                (document.head || document.documentElement).appendChild(st);
            }
        } else if (st) { st.remove(); }
    }
    // While Shift is held during editing, make OTHER step markers non-interactive so a
    // press falls THROUGH to the map (stack in place) or to the marker of the step
    // you're editing (drag it even when another icon overlaps). The edited step's own
    // marker stays interactive so it can be dragged.
    function caApplyShiftIgnore(on) {
        if (CONTEXT !== 'IFRAME') return;
        const ID = 'aim-mb-shift-ignore-style';
        let st = document.getElementById(ID);
        if (on && caEditing()) {
            const editedId = getOpenStepId();
            const esc = (v) => (window.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v);
            if (!st) { st = document.createElement('style'); st.id = ID; (document.head || document.documentElement).appendChild(st); }
            st.textContent = '.instruction-marker[data-aim-id],.leaflet-marker-icon[data-aim-id]{pointer-events:none !important;}' +
                (editedId != null ? `[data-aim-id="${esc(editedId)}"]{pointer-events:auto !important;}` : '');
        } else if (st) { st.remove(); }
    }
    function caClickToLatLng(e) {
        const m = getLeafletMap(); if (!m) return null;
        try { if (typeof m.mouseEventToLatLng === 'function') return m.mouseEventToLatLng(e); } catch (_) {}
        try { const c = caMapContainer(), r = c.getBoundingClientRect(); return m.containerPointToLatLng([e.clientX - r.left, e.clientY - r.top]); } catch (_) {}
        return null;
    }
    function caEditing() { return CONTEXT === 'IFRAME' && composerMapMode && !!composerMission; }
    function caOnClick(e) {
        if (!caEditing() || !caArmed(e) || !caIsEmptySpace(e)) return;
        const ll = caClickToLatLng(e); if (!ll) return;
        e.preventDefault(); e.stopPropagation();
        caAddStep('snap', ll);
    }
    function caOnContextMenu(e) {
        if (!caEditing() || !caArmed(e) || !caIsEmptySpace(e)) return;
        const ll = caClickToLatLng(e); if (!ll) return;
        e.preventDefault(); e.stopPropagation();
        caAddStep('nav', ll);
    }
    function caBindMap() {
        caInitKeyFlags();
        const c = caMapContainer(); if (!c || caBoundContainer === c) return;
        if (caBoundContainer) { try { caBoundContainer.removeEventListener('click', caOnClick, true); caBoundContainer.removeEventListener('contextmenu', caOnContextMenu, true); } catch (_) {} }
        c.addEventListener('click', caOnClick, true);
        c.addEventListener('contextmenu', caOnContextMenu, true);
        caBoundContainer = c;
    }
    // Mirror the shared data-aim-clickadd flag while Ctrl is held during editing, so
    // the momentary hold-Ctrl path also makes other scripts' M2 handlers stand down
    // (the sticky toggle sets it in caSetMode). IFRAME-only so we never suppress the
    // inspector on the top-window Site Setup page.
    let caKeyFlagsBound = false;
    function caInitKeyFlags() {
        if (caKeyFlagsBound || CONTEXT !== 'IFRAME') return;
        caKeyFlagsBound = true;
        // Recompute the flag from the LIVE Ctrl state on EVERY key event, so releasing
        // Shift while Ctrl is still held keeps it set (the old per-key toggle cleared it
        // on Shift-up, letting the Asset Inspector reclaim the right-click). Clears when
        // Ctrl is actually released. (The sticky toggle sets the flag in caSetMode.)
        const sync = (e) => {
            if (caModeOn) return; // toggle owns the flag
            try {
                if (e.ctrlKey && caEditing()) document.documentElement.setAttribute('data-aim-clickadd', '1');
                else document.documentElement.removeAttribute('data-aim-clickadd');
            } catch (err) {}
        };
        window.addEventListener('keydown', e => {
            caCtrlHeld = e.ctrlKey; sync(e); caUpdateBoxZoom();
            if (e.shiftKey) caApplyShiftIgnore(true);   // Shift → let events fall through overlapping markers
            // Ctrl+Z → undo the last Click-to-Add step. Only hijack when we actually
            // have one to undo, while editing, and not typing in a field (so native
            // text-undo and Percepto's own shortcuts are untouched otherwise).
            if (e.ctrlKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && caUndoStack.length && caEditing() && !caIsTypingTarget(e.target)) {
                e.preventDefault(); e.stopPropagation();
                caUndoLast();
            }
        }, true);
        window.addEventListener('keyup', e => { caCtrlHeld = e.ctrlKey; sync(e); if (!e.shiftKey) caApplyShiftIgnore(false); caUpdateBoxZoom(); }, true);
        window.addEventListener('blur', () => { caCtrlHeld = false; caApplyShiftIgnore(false); caUpdateBoxZoom(); }, true);
    }
    function caSetMode(on) {
        if (CONTEXT !== 'IFRAME') return;
        caModeOn = !!on;
        caBindMap();
        // Shared synchronous signal so other scripts' right-click handlers (e.g.
        // the Asset Inspector, whose window-level M2 fires before our deeper
        // map-container handler) stand down while Click-to-Add owns empty-space
        // right-clicks. They check document.documentElement[data-aim-clickadd].
        try { if (caModeOn) document.documentElement.setAttribute('data-aim-clickadd', '1'); else document.documentElement.removeAttribute('data-aim-clickadd'); } catch (e) {}
        caUpdateBoxZoom();   // toggle disables Shift+drag box-zoom while armed
        updateCaUI();
        if (caModeOn) showToast('➕ Click-to-Add ON — empty-space LEFT-click = Snapshot, RIGHT-click = Nav. Hold SHIFT to ignore icons underneath (stack in the same spot). Steps stay STAGED — SAVE when done.', '#7dff7d', 6500);
        else showToast('Click-to-Add OFF.', '#888', 1800);
    }
    function updateCaUI() {
        const btn = document.getElementById(CA_BTN_ID);
        if (btn) {
            btn.textContent = caModeOn ? '➕ Adding: ON' : '➕ Click-add';
            btn.title = 'Click-to-Add: when ON, LEFT-click empty map = Snapshot, RIGHT-click = Nav — placed at the "Insert at" group (blank = end). Hold Ctrl to add momentarily without toggling. Steps stay staged; SAVE when done.';
            btn.style.background = caModeOn ? 'rgba(95,255,95,0.22)' : 'transparent';
            btn.style.border = caModeOn ? '1px solid #5fff5f' : '1px solid rgba(95,255,95,0.45)';
            btn.style.color = caModeOn ? '#7dff7d' : '#7bbf7b';
        }
        const bar = document.getElementById(CA_BAR_ID);
        if (bar) bar.style.display = caModeOn ? 'flex' : 'none';
        updateCaBanner();
    }
    function updateCaBanner() {
        if (CONTEXT !== 'IFRAME') return;
        let b = document.getElementById(CA_BANNER_ID);
        const mapC = document.querySelector('.mission-bank__map-container') || document.querySelector('.pr-map-container');
        if (!caModeOn || !mapC) { if (b) b.remove(); return; }
        if (!b) {
            b = document.createElement('div');
            b.id = CA_BANNER_ID;
            b.style.cssText = 'position:absolute;top:34px;left:50%;transform:translateX(-50%);z-index:1200;' +
                'background:rgba(95,255,95,0.92);color:#04220a;font:700 12px/1.3 "Lato",sans-serif;' +
                'padding:5px 12px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.5);pointer-events:none;white-space:nowrap;';
            if (getComputedStyle(mapC).position === 'static') mapC.style.position = 'relative';
            mapC.appendChild(b);
        }
        b.textContent = `➕ CLICK-TO-ADD ON — L-click = Snapshot · R-click = Nav · into ${caInsertAtNav ? 'N' + caInsertAtNav : 'end'}`;
    }
    function caAddStep(kind, latlng) {
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.setCurrentApp !== 'function' || !ctx.currentApp) { showToast('Open a mission in the editor first.', '#ff9800', 3500); return; }
        const app = ctx.currentApp;
        let instrs = app.instructions || [];
        if (!instrs.length) { try { const lc = findMissionEditorCtx(); if (lc && Array.isArray(lc.instrs) && lc.instrs.length) instrs = lc.instrs; } catch (e) {} }
        const isNav = s => s && (s.type_name === 'navigate' || s.type === 1);
        const isSnap = s => s && (s.type_name === 'snapshot' || s.type === 6);
        const isReturn = s => s && (s.type_name === 'returnHome' || s.type === 99);
        const pickRef = (pred) => { const list = instrs.filter(pred); if (!list.length) return null; for (let i = list.length - 1; i >= 0; i--) { if (list[i].location && list[i].location.lat != null) return list[i]; } return list[list.length - 1]; };
        const ref = kind === 'nav' ? pickRef(isNav) : pickRef(isSnap);
        if (!ref) { showToast(`Need an existing ${kind === 'nav' ? 'Navigate' : 'Snapshot'} in this mission to copy settings from.`, '#ff9800', 4000); return; }
        const c = Object.assign({}, ref);
        c.id = 9000000000 + (((Date.now ? Date.now() : 1) % 1000000) * 100) + (caIdBump++);
        if (c.extra_options) c.extra_options = Object.assign({}, c.extra_options);
        c.location = { lat: latlng.lat, lng: latlng.lng };
        if (kind === 'snap') {
            c.value2 = 1; // "To GPS"
            c.extra_options = Object.assign({}, c.extra_options || {}, { pitch: (c.extra_options && c.extra_options.pitch != null) ? c.extra_options.pitch : 1001 });
            const g = getElevationFromCache(latlng.lat, latlng.lng);
            if (g != null) c.value1 = g + (defaultSnapAglFt / 3.28084);
            else { try { fetchElevation(latlng.lat, latlng.lng); } catch (e) {} } // keep ref alt; Auto-AGL/Save corrects once cached
        }
        const newInstrs = instrs.map(s => Object.assign({}, s));
        const navIdxs = []; newInstrs.forEach((s, k) => { if (isNav(s)) navIdxs.push(k); });
        const endIdx = () => { const rh = newInstrs.findIndex(isReturn); return rh < 0 ? newInstrs.length : rh; };
        // Insert at the END of the target group N# (before the next nav) — a nav there
        // becomes N#+1 (rest shifts down); a snapshot lands after N#'s children.
        const g = caInsertAtNav;
        let insertIdx = (g && g >= 1 && g <= navIdxs.length) ? ((g < navIdxs.length) ? navIdxs[g] : endIdx()) : endIdx();
        newInstrs.splice(insertIdx, 0, c);
        newInstrs.forEach((s, k) => { if (s) s.index_in_app = k; });
        let addedNavGroup = null;
        if (kind === 'nav') { let cnt = 0; for (let k = 0; k < newInstrs.length; k++) { if (isNav(newInstrs[k])) { cnt++; if (newInstrs[k].id === c.id) { addedNavGroup = cnt; break; } } } caInsertAtNav = addedNavGroup; const inp = document.querySelector('#' + CA_BAR_ID + ' [data-ca-at]'); if (inp) inp.value = addedNavGroup || ''; }
        try {
            ctx.setCurrentApp(Object.assign({}, app, { instructions: newInstrs }));
            try { composerStyleNativeMarkers(); } catch (e) {}
            updateCaBanner();
            // Record for Ctrl+Z undo. Reset the stack if we've switched missions.
            if (caUndoStack.length && caUndoStack[caUndoStack.length - 1].appId !== app.id) caUndoStack = [];
            caUndoStack.push({ op: 'add', id: c.id, kind, prevInsertAt: g, appId: app.id });
            const where = kind === 'nav' ? `N${addedNavGroup}` : (g ? `end of N${g}` : 'end');
            showToast(`➕ ${kind === 'nav' ? 'Nav' : 'Snapshot'} added (${where}).${kind === 'nav' ? ' Left-click to drop its snapshots.' : ''} Ctrl+Z to undo · SAVE when done.`, '#7dff7d', 2600);
        } catch (e) { console.warn(`${TAG} [click-add] setCurrentApp failed`, e); showToast('Click-to-Add failed — see console.', '#ff5252', 3500); }
    }
    // Undo the most recent Click-to-Add action — an 'add' (remove the step by id +
    // restore the insert target) or a 'del' (re-insert the removed step(s) at their
    // original index). One shared stack so Ctrl+Z peels back adds AND Alt+M2 deletes.
    function caUndoLast() {
        if (!caUndoStack.length) { showToast('Nothing to undo.', '#888', 1500); return; }
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.setCurrentApp !== 'function' || !ctx.currentApp) { showToast('Open a mission in the editor first.', '#ff9800', 3000); return; }
        const app = ctx.currentApp;
        const rec = caUndoStack[caUndoStack.length - 1];
        if (rec.appId !== app.id) { caUndoStack = []; showToast('Undo cleared — different mission is open.', '#9ad', 2500); return; }
        let instrs = app.instructions || [];
        if (!instrs.length) { try { const lc = findMissionEditorCtx(); if (lc && Array.isArray(lc.instrs) && lc.instrs.length) instrs = lc.instrs; } catch (e) {} }
        caUndoStack.pop();
        const kl = rec.kind === 'nav' ? 'Nav' : rec.kind === 'flag' ? 'Flag Pole' : 'Snapshot';
        let newInstrs, msg;
        if (rec.op === 'tpl') {
            // A wrap-template apply is one undo unit: strip every step it added.
            const ids = new Set((rec.ids || []).map(String));
            newInstrs = instrs.filter(s => !(s && ids.has(String(s.id)))).map(s => Object.assign({}, s));
            msg = `↩ Removed "${rec.name}" wrap steps (${instrs.length - newInstrs.length}).`;
        } else if (rec.op === 'del') {
            const at = Math.max(0, Math.min(rec.index, instrs.length));
            newInstrs = instrs.slice(0, at).concat(rec.steps.map(s => Object.assign({}, s)), instrs.slice(at)).map(s => Object.assign({}, s));
            msg = `↩ Restored ${kl}${rec.steps.length > 1 ? ' + scan' : ''}.`;
        } else {
            const idx = instrs.findIndex(s => s && String(s.id) === String(rec.id));
            if (idx < 0) { showToast('That step is no longer here (saved or already removed).', '#9ad', 2500); return; }
            newInstrs = instrs.slice(0, idx).concat(instrs.slice(idx + 1)).map(s => Object.assign({}, s));
            caInsertAtNav = (rec.prevInsertAt != null && rec.prevInsertAt >= 1) ? rec.prevInsertAt : null;
            const inp = document.querySelector('#' + CA_BAR_ID + ' [data-ca-at]'); if (inp) inp.value = caInsertAtNav || '';
            msg = `↩ Undid ${kl}.`;
        }
        newInstrs.forEach((s, k) => { if (s) s.index_in_app = k; });
        try {
            ctx.setCurrentApp(Object.assign({}, app, { instructions: newInstrs }));
            try { composerStyleNativeMarkers(); } catch (e) {}
            updateCaBanner();
            showToast(`${msg}${caUndoStack.length ? ' Ctrl+Z again for more.' : ''}`, '#7dff7d', 1800);
        } catch (e) { console.warn(`${TAG} [click-add] undo failed`, e); showToast('Undo failed — see console.', '#ff5252', 3000); }
    }
    // Alt + right-click on a Nav/Snapshot marker → delete that step. A snapshot also
    // takes its trailing scan-wrap block (contiguous camera/GEM/wait) so no orphans.
    // Pushed to the shared undo stack, so Ctrl+Z restores it verbatim at its spot.
    function composerDeleteStep(id) {
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.setCurrentApp !== 'function' || !ctx.currentApp) { showToast('Open a mission in the editor first.', '#ff9800', 3000); return; }
        const app = ctx.currentApp;
        let instrs = app.instructions || [];
        if (!instrs.length) { try { const lc = findMissionEditorCtx(); if (lc && Array.isArray(lc.instrs) && lc.instrs.length) instrs = lc.instrs; } catch (e) {} }
        const isNavT = s => s && (s.type_name === 'navigate' || s.type === 1);
        const isSnapT = s => s && (s.type_name === 'snapshot' || s.type === 6);
        const isFlagT = s => s && (s.type_name === 'flag pole' || s.type === 16);
        const isWrapT = s => s && (s.type_name === 'cameraSelect' || s.type === 7 || s.type_name === 'gemMode' || s.type === 24 || s.type_name === 'wait' || s.type === 5);
        const idx = instrs.findIndex(s => s && String(s.id) === String(id));
        if (idx < 0) { showToast('Could not find that step to delete.', '#ff9800', 3000); return; }
        const kind = isNavT(instrs[idx]) ? 'nav' : isFlagT(instrs[idx]) ? 'flag' : 'snap';
        let end = idx + 1;
        if (isSnapT(instrs[idx])) { while (end < instrs.length && isWrapT(instrs[end])) end++; } // take the scan block too
        const removed = instrs.slice(idx, end).map(s => Object.assign({}, s));
        const newInstrs = instrs.slice(0, idx).concat(instrs.slice(end)).map(s => Object.assign({}, s));
        newInstrs.forEach((s, k) => { if (s) s.index_in_app = k; });
        if (caUndoStack.length && caUndoStack[caUndoStack.length - 1].appId !== app.id) caUndoStack = [];
        caUndoStack.push({ op: 'del', steps: removed, index: idx, kind, appId: app.id });
        try {
            ctx.setCurrentApp(Object.assign({}, app, { instructions: newInstrs }));
            try { composerStyleNativeMarkers(); } catch (e) {}
            const extra = removed.length > 1 ? ` (+${removed.length - 1} scan step${removed.length - 1 === 1 ? '' : 's'})` : '';
            const kl = kind === 'nav' ? 'Nav' : kind === 'flag' ? 'Flag Pole' : 'Snapshot';
            showToast(`🗑 Deleted ${kl}${extra}. Ctrl+Z to restore · SAVE when done.`, '#ff9d3a', 3200);
        } catch (e) { console.warn(`${TAG} [click-add] delete failed`, e); showToast('Delete failed — see console.', '#ff5252', 3000); }
    }

    // ── 🎞 Wrap templates: the Click-to-Add finisher ─────────────────────────
    // A wrap template is a NAMED, ORDERED sequence of saved step presets (the
    // 📋-captured ones from ➕ Stage — Camera Thermal, GEM On, Wait, GEM Off…).
    // Apply walks the open mission and inserts the sequence after EVERY "bare"
    // snapshot — one whose next step is a nav / snapshot / returnHome / end —
    // so freshly Ctrl-clicked inspection points get their scan wrap in one go
    // while snapshots that already have trailing scan steps are left alone.
    // Everything stays STAGED (native SAVE commits); one Ctrl+Z removes the
    // whole batch. Templates store preset NAMES, resolved at apply time, so a
    // preset quick-edit (Wait seconds, RGB↔Thermal) carries into future applies.
    const CACHE_KEY_WRAP_TEMPLATES = 'aim-mb-wrap-templates';
    const CACHE_KEY_WRAP_LAST = 'aim-mb-wrap-last';
    const WRAP_BTN_ID = 'aim-mb-wrap-btn';
    let wrapPopEl = null;
    function wrapTemplatesLoad() { const o = gmGet(CACHE_KEY_WRAP_TEMPLATES, {}); return (o && typeof o === 'object') ? o : {}; }
    function wrapTemplatesSave(o) { try { gmSet(CACHE_KEY_WRAP_TEMPLATES, o || {}); } catch (e) { console.warn(`${TAG} [wrap] template save failed`, e); } }
    function wrapOrderCmp(all) {
        return (a, b) => {
            const oa = all[a].order != null ? all[a].order : (all[a].savedAt || 0);
            const ob = all[b].order != null ? all[b].order : (all[b].savedAt || 0);
            return oa - ob || a.localeCompare(b);
        };
    }
    function wrapApplyTemplate(name) {
        const all = wrapTemplatesLoad();
        const tpl = all[name];
        if (!tpl || !Array.isArray(tpl.steps) || !tpl.steps.length) { showToast('Pick a template with at least one step.', '#ff9800', 3500); return false; }
        const presets = stagePresetsLoad();
        const missing = tpl.steps.filter(n => !presets[n] || !presets[n].instr);
        if (missing.length) { showToast(`Template "${name}" uses missing step preset(s): ${missing.join(', ')} — recapture them (➕ Stage → 📋) or edit the template.`, '#ff5252', 7000); return false; }
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.setCurrentApp !== 'function' || !ctx.currentApp) { showToast('Open a mission in the editor first.', '#ff9800', 3500); return false; }
        const app = ctx.currentApp;
        let instrs = app.instructions || [];
        if (!instrs.length) { try { const lc = findMissionEditorCtx(); if (lc && Array.isArray(lc.instrs) && lc.instrs.length) instrs = lc.instrs; } catch (e) {} }
        if (!instrs.length) { showToast('This mission has no steps yet.', '#ff9800', 3000); return false; }
        const isNav = s => s && (s.type_name === 'navigate' || s.type === 1);
        const isSnap = s => s && (s.type_name === 'snapshot' || s.type === 6);
        const isReturn = s => s && (s.type_name === 'returnHome' || s.type === 99);
        // Same unique-id scheme as Click-to-Add (shared bump so parallel adds
        // in the same ms can't collide) — save strips ids, server assigns real ones.
        const nextId = () => 9000000000 + (((Date.now ? Date.now() : 1) % 1000000) * 100) + (caIdBump++);
        const newInstrs = [];
        const addedIds = [];
        let applied = 0, skipped = 0;
        for (let i = 0; i < instrs.length; i++) {
            const s = instrs[i];
            newInstrs.push(Object.assign({}, s));
            if (!isSnap(s)) continue;
            const nxt = instrs[i + 1];
            const bare = (nxt === undefined) || isNav(nxt) || isSnap(nxt) || isReturn(nxt);
            if (!bare) { skipped++; continue; } // already has trailing scan steps — don't double-wrap
            tpl.steps.forEach(pn => {
                const c = JSON.parse(JSON.stringify(presets[pn].instr));
                c.id = nextId();
                addedIds.push(c.id);
                // Located preset types (e.g. Flag Pole) land AT the snapshot's
                // point; location-less scan steps (Wait/Camera/GEM) stay bare.
                if (c.location && c.location.lat != null && s.location && s.location.lat != null) c.location = { lat: s.location.lat, lng: s.location.lng };
                newInstrs.push(c);
            });
            applied++;
        }
        if (!applied) { showToast(`No bare snapshots to wrap${skipped ? ` — all ${skipped} already have trailing steps (Ctrl+Z or Alt+R-click to clear first)` : ' — add snapshots first'}.`, '#ff9800', 5000); return false; }
        newInstrs.forEach((s, k) => { if (s) s.index_in_app = k; });
        try {
            ctx.setCurrentApp(Object.assign({}, app, { instructions: newInstrs }));
            try { composerStyleNativeMarkers(); } catch (e) {}
            if (caUndoStack.length && caUndoStack[caUndoStack.length - 1].appId !== app.id) caUndoStack = [];
            caUndoStack.push({ op: 'tpl', ids: addedIds, name, appId: app.id });
            console.log(`${TAG} [wrap] applied "${name}" (${tpl.steps.length} step seq) after ${applied} snapshot(s), skipped ${skipped}`);
            showToast(`🎞 "${name}" applied after ${applied} snapshot(s)${skipped ? ` · ${skipped} skipped (already wrapped)` : ''}. Ctrl+Z removes the whole batch · SAVE when done.`, '#5fff5f', 6500);
            return true;
        } catch (e) { console.warn(`${TAG} [wrap] setCurrentApp failed`, e); showToast('Apply failed — see console.', '#ff5252', 3500); return false; }
    }
    // ── Auto-wrap (session-only) + site-wide wrap ────────────────────────────
    // M2 on the 🎞 button toggles AUTO-WRAP for THIS SESSION (deliberately not
    // persisted): every mission SAVE gets the last-used template inserted after
    // each bare snapshot via the outgoing-body interceptor (handleMissionSave),
    // then a post-save fresh-fetch VERIFIES no snapshot is left bare.
    // Site-wide: 🌐 in the 🎞 popup wraps EVERY mission on the site with bare
    // snapshots via ctx.saveApp — dry-run count → confirm → JSON backup download
    // → sequential saves → fresh-fetch verify. Steps normalized via pcmNormStep
    // (the LIVE-CONFIRMED merge-save shape; identity is positional, never id).
    let autoWrapEnabled = false; // session-only ON PURPOSE — never persisted
    let wrapSiteBusy = false;
    let wrapVerifyT = null;
    // Wire-shape bare check (body.instructions / fetched mission.instructions —
    // plain type numbers): snapshot=6 is bare iff the NEXT step is a takeoff(0)/
    // nav(1)/snapshot(6)/returnHome(99) or the end of the list.
    function wrapWireBareIdxs(instrs) {
        const out = [];
        for (let i = 0; i < (instrs || []).length; i++) {
            const s = instrs[i];
            if (!s || s.type !== 6) continue;
            const nxt = instrs[i + 1];
            if (nxt === undefined || nxt.type === 0 || nxt.type === 1 || nxt.type === 6 || nxt.type === 99) out.push(i);
        }
        return out;
    }
    // Resolve the LAST-USED template to raw preset instructions, or {error}.
    function wrapResolveLast() {
        const name = gmGet(CACHE_KEY_WRAP_LAST, null);
        if (!name) return { error: 'no template used yet — open 🎞 and Apply one once' };
        const all = wrapTemplatesLoad(); const tpl = all[name];
        if (!tpl || !Array.isArray(tpl.steps) || !tpl.steps.length) return { error: `template "${name}" no longer exists` };
        const presets = stagePresetsLoad();
        const missing = tpl.steps.filter(n => !presets[n] || !presets[n].instr);
        if (missing.length) return { error: `template "${name}" uses missing preset(s): ${missing.join(', ')}` };
        return { name, steps: tpl.steps.map(n => presets[n].instr) };
    }
    // Insert normalized template clones after every bare snapshot. Existing
    // entries pass through untouched; located preset types (flag pole) land at
    // the snapshot's point. Returns {list, applied, skipped}.
    function wrapInsertWire(instrs, tplSteps) {
        const bare = new Set(wrapWireBareIdxs(instrs));
        const out = []; let applied = 0, skipped = 0;
        (instrs || []).forEach((s, i) => {
            out.push(s);
            if (!s || s.type !== 6) return;
            if (!bare.has(i)) { skipped++; return; }
            tplSteps.forEach(t => {
                const c = pcmNormStep(t);
                if (c.location && c.location.lat != null && s.location && s.location.lat != null) c.location = { lat: s.location.lat, lng: s.location.lng };
                out.push(c);
            });
            applied++;
        });
        return { list: out, applied, skipped };
    }
    function toggleAutoWrap() {
        if (!autoWrapEnabled) {
            const r = wrapResolveLast();
            if (r.error) { showToast(`Can't arm Auto-wrap: ${r.error}.`, '#ff9800', 5000); return; }
            autoWrapEnabled = true;
            showToast(`🎞 AUTO-WRAP ON (this session) — "${r.name}" is applied to bare snapshots on every mission SAVE, then verified. Right-click 🎞 to turn off.`, '#ff7a00', 7000);
            console.log(`${TAG} [wrap] auto-wrap ON (template "${r.name}")`);
        } else {
            autoWrapEnabled = false;
            showToast('🎞 Auto-wrap OFF.', '#888', 2500);
            console.log(`${TAG} [wrap] auto-wrap OFF`);
        }
        updateWrapBtn();
    }
    function updateWrapBtn() {
        const b = document.getElementById(WRAP_BTN_ID);
        if (!b) return;
        if (autoWrapEnabled) {
            b.textContent = '🎞 AUTO';
            b.title = `AUTO-WRAP ON (session only): "${gmGet(CACHE_KEY_WRAP_LAST, '?')}" is applied to bare snapshots on every mission SAVE, with post-save verification. Right-click to turn off. Left-click opens templates.`;
            b.style.background = 'rgba(255,122,0,0.22)'; b.style.border = '1px solid #ff7a00'; b.style.color = '#ff9d3a';
        } else {
            b.textContent = '🎞 Wrap';
            b.title = 'Wrap templates: apply a saved sequence of your step presets (e.g. Therm on → GEM on → Wait → GEM off → Therm off) after EVERY snapshot that has no trailing steps yet. Left-click: open/manage/apply. RIGHT-CLICK: toggle AUTO-WRAP (auto-applies on every SAVE, this session only).';
            b.style.background = 'rgba(255,150,255,0.10)'; b.style.border = '1px solid rgba(255,150,255,0.45)'; b.style.color = '#f9f';
        }
    }
    // Save-interceptor pass (called from handleMissionSave when armed): rewrite
    // the outgoing POST /available_app/ body. Fail-open — any problem returns
    // null and the native save goes through untouched.
    function applyWrapToBodyStr(bodyStr) {
        const body = JSON.parse(bodyStr);
        if (!body || !Array.isArray(body.instructions)) return null;
        const r = wrapResolveLast();
        if (r.error) { showToast(`🎞 Auto-wrap SKIPPED this save: ${r.error}.`, '#ff9800', 5000); return null; }
        const w = wrapInsertWire(body.instructions, r.steps);
        if (!w.applied) {
            showToast(`🎞 Auto-wrap: nothing to add — all ${w.skipped} snapshot(s) already wrapped.`, '#9ad', 3500);
            return null;
        }
        body.instructions = w.list;
        showToast(`🎞 Auto-wrap: added "${r.name}" after ${w.applied} snapshot(s) on save${w.skipped ? ` (${w.skipped} already wrapped)` : ''} — verifying…`, '#5fff5f', 5000);
        console.log(`${TAG} [wrap] auto-applied "${r.name}" ×${w.applied} to "${body.name}" on save`);
        scheduleWrapVerify(body.name, body.app_id);
        return JSON.stringify(body);
    }
    // Post-save verification: fresh-fetch the site's missions and confirm the
    // saved mission has ZERO bare snapshots. Green ✓ / red ⚠ toast either way.
    function scheduleWrapVerify(name, appId) {
        if (wrapVerifyT) clearTimeout(wrapVerifyT);
        wrapVerifyT = setTimeout(() => {
            wrapVerifyT = null;
            const sid = getCurrentSiteID();
            if (!sid) return;
            mbFetchMissionsFull(sid).then(arr => {
                const m = arr.find(x => x && ((appId != null && (x.app_id === appId || x.id === appId)) || x.name === name));
                if (!m) { showToast(`⚠ Auto-wrap verify: couldn't re-fetch "${name}" — check it manually.`, '#ff9800', 5000); return; }
                const bare = wrapWireBareIdxs(m.instructions || []).length;
                if (bare === 0) showToast(`✓ Auto-wrap VERIFIED — every snapshot in "${name}" has its scan steps.`, '#5fff5f', 4500);
                else showToast(`⚠ Auto-wrap verify FAILED — ${bare} snapshot(s) in "${name}" still bare. Open it and check.`, '#ff5252', 8000);
                console.log(`${TAG} [wrap] verify "${name}": ${bare} bare snapshot(s)`);
            }).catch(e => { console.warn(`${TAG} [wrap] verify fetch failed`, e); showToast('⚠ Auto-wrap verify fetch failed — see console.', '#ff9800', 4000); });
        }, 2500);
    }
    // Site-wide apply: every mission with bare snapshots gets the template,
    // saved via ctx.saveApp (update in place, name preserved).
    async function wrapApplySiteWide(tplName) {
        if (wrapSiteBusy) { showToast('Site-wide wrap already running…', '#ff9800', 2500); return; }
        if (document.querySelector('.edit-instruction')) { showToast('Close the open STEP editor first (save or cancel it), then retry.', '#ff9800', 4500); return; }
        const all = wrapTemplatesLoad(); const tpl = all[tplName];
        if (!tpl || !Array.isArray(tpl.steps) || !tpl.steps.length) { showToast('Pick a template with steps first.', '#ff9800', 3000); return; }
        const presets = stagePresetsLoad();
        const missing = tpl.steps.filter(n => !presets[n] || !presets[n].instr);
        if (missing.length) { showToast(`Template uses missing preset(s): ${missing.join(', ')}.`, '#ff5252', 6000); return; }
        const tplSteps = tpl.steps.map(n => presets[n].instr);
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.saveApp !== 'function') { showToast('Mission context not found — be on the Mission Bank page.', '#ff5252', 4500); return; }
        const sid = getCurrentSiteID();
        if (!sid) { showToast('No site detected.', '#ff5252', 3000); return; }
        wrapSiteBusy = true;
        try {
            showToast('🌐 Fetching all missions…', '#9cf', 2500);
            const missions = await mbFetchMissionsFull(sid);
            const affected = missions.map(m => ({ m, bare: wrapWireBareIdxs(m.instructions || []).length })).filter(x => x.bare > 0);
            if (!affected.length) { showToast(`✓ Nothing to do — all ${missions.length} mission(s) already fully wrapped.`, '#5fff5f', 5000); return; }
            const totalSnaps = affected.reduce((a, x) => a + x.bare, 0);
            if (!window.confirm(`Apply wrap "${tplName}" (${tpl.steps.length} steps) SITE-WIDE?\n\n` +
                `${affected.length} of ${missions.length} missions have bare snapshots (${totalSnaps} snapshot(s) total).\n` +
                `A JSON backup of the affected missions downloads first.\n\nThis SAVES every affected mission. Continue?`)) return;
            try {
                const backup = JSON.stringify({ site: sid, savedAt: new Date().toISOString(), template: tplName, missions: affected.map(x => x.m) });
                const blob = new Blob([backup], { type: 'application/json' });
                const blobUrl = URL.createObjectURL(blob);
                let downloaded = false;
                for (const doc of [(window.top || window).document, document]) {
                    if (downloaded) break;
                    try {
                        const a = doc.createElement('a');
                        a.href = blobUrl; a.download = `site${sid}_missions_prewrap_backup.json`;
                        (doc.body || document.body).appendChild(a); a.click(); a.remove();
                        downloaded = true;
                    } catch (e) {}
                }
                setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 5000);
                if (!downloaded) throw new Error('no frame allowed the download');
            } catch (e) {
                console.warn(`${TAG} [wrap] backup download failed`, e);
                if (!window.confirm('Backup download FAILED — continue WITHOUT a backup?')) return;
            }
            let ok = 0, fail = 0; const failedNames = [];
            for (let k = 0; k < affected.length; k++) {
                const { m } = affected[k];
                try {
                    const norm = (m.instructions || []).map(pcmNormStep);
                    const w = wrapInsertWire(norm, tplSteps);
                    await ctx.saveApp(Object.assign({}, m, { instructions: w.list }), m.name);
                    ok++;
                } catch (e) { fail++; failedNames.push(m.name); console.warn(`${TAG} [wrap] site-wide save FAILED for "${m.name}"`, e); }
                if ((k + 1) % 5 === 0 || k === affected.length - 1) showToast(`🌐 Wrapping… ${k + 1}/${affected.length}`, '#9cf', 1500);
                await new Promise(r => setTimeout(r, 150));
            }
            showToast('🌐 Verifying (fresh fetch)…', '#9cf', 2500);
            await new Promise(r => setTimeout(r, 1500));
            const after = await mbFetchMissionsFull(sid);
            const stillBare = after.filter(m => wrapWireBareIdxs(m.instructions || []).length > 0);
            const good = fail === 0 && stillBare.length === 0;
            showToast(`🌐 Site-wide wrap done: ${ok} mission(s) saved${fail ? `, ${fail} FAILED` : ''} · verify: ${good ? 'ALL missions fully wrapped ✓' : `⚠ ${stillBare.length} mission(s) still have bare snapshots — see console`}`, good ? '#5fff5f' : '#ff9800', 10000);
            console.log(`${TAG} [wrap] site-wide result: ok=${ok} fail=${fail}${failedNames.length ? ` failed=[${failedNames.join(', ')}]` : ''} stillBare=[${stillBare.map(m => m.name).join(', ') || 'none'}]`);
            try { fetchMissions(sid, () => {}, () => {}); } catch (e) {} // refresh MBT's cache
        } catch (e) {
            console.warn(`${TAG} [wrap] site-wide failed`, e);
            showToast('Site-wide wrap failed — see console.', '#ff5252', 5000);
        } finally { wrapSiteBusy = false; }
    }
    function wrapPopup(anchorBtn) {
        if (wrapPopEl) { wrapPopEl.remove(); wrapPopEl = null; return; }
        const selCss = 'background:#0f1216;border:1px solid #9cf;color:#fff;border-radius:3px;padding:3px 4px;font:inherit;font-size:11px;';
        const pop = document.createElement('div');
        pop.style.cssText = 'position:fixed;z-index:2147483600;width:300px;background:#1f2228;border:1px solid #f9f;border-radius:6px;' +
            'box-shadow:0 4px 20px rgba(0,0,0,0.8);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;padding:10px 12px;';
        pop.innerHTML = `
            <div style="font-weight:800;color:#f9f;font-size:13px;margin-bottom:6px;">🎞 Wrap templates</div>
            <div style="font-size:10px;color:#789;margin-bottom:8px;">An ordered sequence of your 📋-captured step presets (➕ Stage), inserted after every snapshot that has no trailing steps yet — before the next nav. Staged only: SAVE commits, one Ctrl+Z removes the batch.</div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
                <select data-wr-sel style="flex:1;min-width:0;${selCss}"></select>
                <button data-wr-apply style="padding:5px 12px;background:#f9f;border:none;color:#3a0636;border-radius:6px;cursor:pointer;font-weight:800;font-size:12px;">▶ Apply</button>
            </div>
            <div data-wr-list style="border-top:1px solid #34404e;padding-top:6px;margin-bottom:8px;"></div>
            <div style="border-top:1px solid #34404e;padding-top:6px;">
                <div style="font-size:10px;font-weight:800;color:#f9f;margin-bottom:4px;">BUILD / EDIT (✎ loads a template here)</div>
                <input data-wr-name placeholder="Template name" style="width:100%;box-sizing:border-box;background:#0f1216;border:1px solid #456;color:#fff;padding:3px 6px;border-radius:3px;font:inherit;font-size:11px;margin-bottom:6px;">
                <div data-wr-steps style="margin-bottom:6px;"></div>
                <div style="display:flex;gap:6px;margin-bottom:8px;">
                    <select data-wr-addsel style="flex:1;min-width:0;${selCss}"></select>
                    <button class="aim-mb-tbtn" data-wr-add style="padding:3px 8px;font-size:11px;">➕ Add</button>
                </div>
                <div style="display:flex;gap:6px;justify-content:flex-end;">
                    <button class="aim-mb-tbtn" data-wr-close style="padding:5px 10px;">Close</button>
                    <button data-wr-save style="padding:5px 12px;background:#9cf;border:none;color:#06223a;border-radius:6px;cursor:pointer;font-weight:800;font-size:12px;">💾 Save template</button>
                </div>
            </div>
            <div style="border-top:1px solid #34404e;padding-top:6px;margin-top:8px;">
                <div style="font-size:10px;font-weight:800;color:#ff9d3a;margin-bottom:4px;">SITE-WIDE</div>
                <button data-wr-site style="width:100%;padding:5px 8px;font-size:11px;font-weight:700;cursor:pointer;border-radius:6px;background:rgba(255,122,0,0.10);border:1px solid rgba(255,122,0,0.5);color:#ff9d3a;">🌐 Apply selected template to ALL missions…</button>
                <div style="font-size:10px;color:#789;margin-top:4px;">Saves every mission on this site that has bare snapshots — backup JSON downloads first, then a fresh-fetch verify. Tip: RIGHT-CLICK the 🎞 button = Auto-wrap on every save (this session).</div>
            </div>`;
        document.body.appendChild(pop);
        wrapPopEl = pop;
        const selEl = pop.querySelector('[data-wr-sel]');
        const listEl = pop.querySelector('[data-wr-list]');
        const nameEl = pop.querySelector('[data-wr-name]');
        const stepsEl = pop.querySelector('[data-wr-steps]');
        const addSelEl = pop.querySelector('[data-wr-addsel]');
        let bSteps = []; // builder state: ordered preset names
        const renderSel = () => {
            const all = wrapTemplatesLoad();
            const names = Object.keys(all).sort(wrapOrderCmp(all));
            const last = gmGet(CACHE_KEY_WRAP_LAST, null);
            selEl.innerHTML = names.length
                ? names.map(n => `<option value="${escapeHtml(n)}"${n === last ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')
                : '<option value="">— no templates yet —</option>';
        };
        const renderAddSel = () => {
            const presets = stagePresetsLoad();
            const cmp = wrapOrderCmp(presets); // same {order, savedAt} shape as templates
            const names = Object.keys(presets).sort(cmp);
            addSelEl.innerHTML = names.length
                ? names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
                : '<option value="">— no step presets — capture via ➕ Stage → 📋 —</option>';
        };
        const renderList = () => {
            const all = wrapTemplatesLoad();
            const names = Object.keys(all).sort(wrapOrderCmp(all));
            if (!names.length) { listEl.innerHTML = '<div style="font-size:10px;color:#789;">No templates yet — build one below.</div>'; return; }
            listEl.innerHTML = '<div style="font-size:10px;font-weight:800;color:#f9f;margin-bottom:4px;">MY TEMPLATES</div>' + names.map(n => {
                const chain = (all[n].steps || []).join(' → ');
                return `<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;font-size:12px;">
                    <label style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(chain)}">${escapeHtml(n)} <span style="color:#789;font-size:10px;">(${(all[n].steps || []).length})</span></label>
                    <span data-wr-edit="${escapeHtml(n)}" title="Load into the builder below" style="cursor:pointer;color:#9cf;font-size:11px;">✎</span>
                    <span data-wr-ren="${escapeHtml(n)}" title="Rename template" style="cursor:pointer;color:#9ab;font-size:11px;">✏️</span>
                    <span data-wr-del="${escapeHtml(n)}" title="Delete template" style="cursor:pointer;color:#f66;font-size:12px;">🗑</span></div>`;
            }).join('');
            listEl.querySelectorAll('[data-wr-edit]').forEach(el => { el.onclick = () => {
                const n = el.getAttribute('data-wr-edit');
                const a2 = wrapTemplatesLoad(); if (!a2[n]) return;
                nameEl.value = n;
                bSteps = (a2[n].steps || []).slice();
                renderBuilder();
            }; });
            listEl.querySelectorAll('[data-wr-ren]').forEach(el => { el.onclick = () => {
                const oldName = el.getAttribute('data-wr-ren');
                const a2 = wrapTemplatesLoad(); const t = a2[oldName]; if (!t) return;
                const nn = (window.prompt('Rename template:', oldName) || '').trim();
                if (!nn || nn === oldName) return;
                if (a2[nn] && !window.confirm(`"${nn}" already exists — overwrite it?`)) return;
                delete a2[oldName];
                t.name = nn;
                a2[nn] = t;
                wrapTemplatesSave(a2);
                if (gmGet(CACHE_KEY_WRAP_LAST, null) === oldName) gmSet(CACHE_KEY_WRAP_LAST, nn);
                console.log(`${TAG} [wrap] renamed template "${oldName}" → "${nn}"`);
                renderList(); renderSel();
            }; });
            listEl.querySelectorAll('[data-wr-del]').forEach(el => { el.onclick = () => {
                const n = el.getAttribute('data-wr-del');
                const a2 = wrapTemplatesLoad(); delete a2[n]; wrapTemplatesSave(a2);
                console.log(`${TAG} [wrap] deleted template "${n}"`);
                renderList(); renderSel();
            }; });
        };
        const renderBuilder = () => {
            if (!bSteps.length) { stepsEl.innerHTML = '<div style="font-size:10px;color:#789;">No steps yet — pick a preset below and ➕ Add. Order top→bottom = order after each snapshot.</div>'; return; }
            stepsEl.innerHTML = bSteps.map((n, i) => `
                <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;font-size:12px;">
                    <span style="color:#789;font-size:10px;width:14px;text-align:right;">${i + 1}.</span>
                    <label style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(n)}</label>
                    <span data-wr-sup="${i}" title="Move up" style="cursor:pointer;color:#9cf;font-size:11px;">▲</span>
                    <span data-wr-sdn="${i}" title="Move down" style="cursor:pointer;color:#9cf;font-size:11px;">▼</span>
                    <span data-wr-srm="${i}" title="Remove" style="cursor:pointer;color:#f66;font-size:12px;">✕</span>
                </div>`).join('');
            const move = (i, d) => { const j = i + d; if (j < 0 || j >= bSteps.length) return; const t = bSteps[i]; bSteps[i] = bSteps[j]; bSteps[j] = t; renderBuilder(); };
            stepsEl.querySelectorAll('[data-wr-sup]').forEach(el => { el.onclick = () => move(+el.getAttribute('data-wr-sup'), -1); });
            stepsEl.querySelectorAll('[data-wr-sdn]').forEach(el => { el.onclick = () => move(+el.getAttribute('data-wr-sdn'), 1); });
            stepsEl.querySelectorAll('[data-wr-srm]').forEach(el => { el.onclick = () => { bSteps.splice(+el.getAttribute('data-wr-srm'), 1); renderBuilder(); }; });
        };
        renderSel(); renderAddSel(); renderList(); renderBuilder();
        pop.querySelector('[data-wr-add]').onclick = () => {
            const n = addSelEl.value;
            if (!n) { showToast('No step presets saved yet — capture one via ➕ Stage → 📋.', '#ff9800', 4500); return; }
            bSteps.push(n); // duplicates allowed on purpose (e.g. two Waits)
            renderBuilder();
        };
        pop.querySelector('[data-wr-save]').onclick = () => {
            const n = (nameEl.value || '').trim();
            if (!n) { showToast('Give the template a name.', '#ff9800', 2500); return; }
            if (!bSteps.length) { showToast('Add at least one step.', '#ff9800', 2500); return; }
            const a2 = wrapTemplatesLoad();
            const existing = a2[n];
            const maxOrder = Object.values(a2).reduce((m, t) => Math.max(m, t && t.order != null ? t.order : 0), 0);
            a2[n] = { name: n, savedAt: Date.now(), order: existing && existing.order != null ? existing.order : maxOrder + 10, steps: bSteps.slice() };
            wrapTemplatesSave(a2);
            gmSet(CACHE_KEY_WRAP_LAST, n);
            console.log(`${TAG} [wrap] saved template "${n}" (${bSteps.length} steps)`);
            showToast(`Saved wrap template "${n}".`, '#5fff5f', 2500);
            renderList(); renderSel();
        };
        pop.querySelector('[data-wr-apply]').onclick = () => {
            const n = selEl.value;
            if (!n) { showToast('No template selected — build one below first.', '#ff9800', 3000); return; }
            gmSet(CACHE_KEY_WRAP_LAST, n);
            updateWrapBtn(); // AUTO tooltip tracks the last-used template
            if (wrapApplyTemplate(n)) close();
        };
        // Site-wide is double-click armed (blast radius: saves every affected mission).
        let wrSiteArm = null;
        pop.querySelector('[data-wr-site]').onclick = () => {
            const n = selEl.value;
            if (!n) { showToast('No template selected.', '#ff9800', 2500); return; }
            const btn = pop.querySelector('[data-wr-site]');
            if (!wrSiteArm) {
                wrSiteArm = setTimeout(() => { wrSiteArm = null; try { btn.textContent = '🌐 Apply selected template to ALL missions…'; } catch (e) {} }, 4000);
                btn.textContent = '⚠ Click again to wrap ALL missions on this site';
                return;
            }
            clearTimeout(wrSiteArm); wrSiteArm = null;
            gmSet(CACHE_KEY_WRAP_LAST, n);
            updateWrapBtn();
            close();
            wrapApplySiteWide(n);
        };
        const r = anchorBtn.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 316)) + 'px';
        pop.style.top = (r.bottom + 4) + 'px';
        const close = () => { pop.remove(); wrapPopEl = null; document.removeEventListener('mousedown', outside, true); };
        const outside = e => { if (wrapPopEl && !pop.contains(e.target) && e.target !== anchorBtn) close(); };
        pop.querySelector('[data-wr-close]').onclick = close;
        setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    }

    function composerBindMapEvents() {
        if (composerMapEventsBound) return;
        const map = getLeafletMap();
        if (!map || typeof map.on !== 'function') return;
        // DEBOUNCED (v1.88): 'layeradd' fires once PER MARKER — opening a large
        // mission added N markers and ran a full restyle (fiber walk + eachLayer
        // over every layer) N times back-to-back, O(N²) at open and again on
        // every pan/zoom marker churn. One trailing pass 200ms after the burst
        // settles is visually identical.
        let restyleT = null;
        map.on('zoomend moveend layeradd', () => {
            if (restyleT) return;
            restyleT = setTimeout(() => {
                restyleT = null;
                try { composerStyleNativeMarkers(); } catch (e) {}
            }, 200);
        });
        composerMapEventsBound = true;
    }

    // Recolor + number Percepto's native nav/snap markers in place.
    function composerStyleNativeMarkers() {
        const t0 = performance.now();
        MB_PERF.markerPasses++;
        try { composerStyleNativeMarkersCore(); } finally { MB_PERF.markerMs += performance.now() - t0; }
    }
    function composerStyleNativeMarkersCore() {
        if (!composerMapMode || CONTEXT !== 'IFRAME' || !composerMission) return;
        const map = getLeafletMap();
        if (!map || typeof map.eachLayer !== 'function') return;
        composerBindMapEvents();
        caBindMap();          // (re)attach Click-to-Add handlers to the current map container
        updateCaBanner();     // keep the armed banner present if the container rebuilt
        caUpdateBoxZoom();    // keep Shift+drag box-zoom OFF while the editor is open
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
            if (s.type_name === 'navigate' || s.type === 1) { navN++; lookup[K(s.location.lat, s.location.lng)] = { num: navN, kind: 'nav', id: String(s.id) }; }
            else if (s.type_name === 'snapshot' || s.type === 6) { snapN++; lookup[K(s.location.lat, s.location.lng)] = { num: snapN, kind: 'snap', id: String(s.id) }; }
            // Flag Pole (type 16) — tag its native marker so it's selectable + movable
            // + Alt-deletable like nav/snap. We DON'T restyle/number it, so its native
            // flag-pole icon stays as-is (the user wants that icon to remain).
            else if (s.type_name === 'flag pole' || s.type === 16) { lookup[K(s.location.lat, s.location.lng)] = { kind: 'flag', id: String(s.id) }; }
        });
        let matched = 0, seen = 0;
        map.eachLayer(layer => {
            const el = layer && layer._icon;
            if (!el || !el.classList) return;
            const ll = layer._latlng;
            if (!ll) return;
            const info = lookup[K(ll.lat, ll.lng)];
            if (el.classList.contains('instruction-marker')) {
                // Percepto's nav/snap markers.
                seen++;
                if (info && info.kind !== 'flag') { matched++; composerStyleOneMarker(el, info, [ll.lat, ll.lng]); }
            } else if (el.classList.contains('leaflet-marker-icon')) {
                // The Flag Pole renders as a GENERIC location-marker (not an
                // instruction-marker), so match it to the flag-pole instruction by
                // lat/lng and tag it selectable. Other generic markers (GMs) sit at
                // different coords → no lookup hit → left alone.
                if (info && info.kind === 'flag') composerStyleOneMarker(el, info, [ll.lat, ll.lng]);
            }
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
        // v1.89 PERF: class-keyed, NOT :has(img[src*=…]) — :has() made Chrome
        // re-evaluate ancestor invalidation on every DOM mutation in the iframe,
        // scaling with marker count; the whole editor turned to sludge the
        // moment this stylesheet + N markers existed. composerStyleOneMarker
        // stamps .aim-mb-nav/.aim-mb-snap on each marker instead. Tradeoff: a
        // marker Percepto re-creates shows its native icon for ~200ms until the
        // debounced restyle re-tags it (the old CSS matched instantly).
        st.textContent = `
            .instruction-marker.aim-mb-nav .instruction-marker__icon { background:${navC} !important; border:1.5px solid #fff !important; border-radius:50% !important; position:relative; }
            .instruction-marker.aim-mb-snap .instruction-marker__icon { background:${snapC} !important; border:1.5px solid #fff !important; border-radius:50% !important; position:relative; }
            .instruction-marker.aim-mb-nav .instruction-marker__icon img,
            .instruction-marker.aim-mb-snap .instruction-marker__icon img { opacity:0 !important; }
            /* Number as ::after on the MARKER el (survives hover — Percepto only
               re-renders the inner icon's contents on hover, wiping a child span). */
            .instruction-marker[data-aim-num]::after { content: attr(data-aim-num); position:absolute; inset:0;
                display:flex; align-items:center; justify-content:center; color:#fff; -webkit-text-fill-color:#fff;
                font:800 11px/1 'Lato',sans-serif; pointer-events:none; z-index:2; }
        `;
    }
    function composerStyleOneMarker(el, info, ll) {
        el.setAttribute('data-aim-id', info.id);
        el.setAttribute('data-aim-kind', info.kind);
        el.__aimLL = ll;
        // Flag Pole: just tag it selectable — leave the native icon + no number badge.
        if (info.kind === 'flag') { el.removeAttribute('data-aim-num'); return; }
        // Kind class drives the color/icon-hide CSS (v1.89: replaced :has()).
        const kindCls = info.kind === 'nav' ? 'aim-mb-nav' : 'aim-mb-snap';
        const otherCls = info.kind === 'nav' ? 'aim-mb-snap' : 'aim-mb-nav';
        if (!el.classList.contains(kindCls)) el.classList.add(kindCls);
        if (el.classList.contains(otherCls)) el.classList.remove(otherCls);
        const label = (info.kind === 'nav' ? 'N' : 'S') + info.num;
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
        // nav/snap are .instruction-marker; the flag-pole is a generic
        // .leaflet-marker-icon we tag with data-aim-id. Only MBT sets data-aim-id, so
        // scoping to these two marker classes can't catch another script's markers.
        const badge = (e) => (e.target && e.target.closest) ? e.target.closest('.instruction-marker[data-aim-id], .leaflet-marker-icon[data-aim-id]') : null;
        // Is this the marker of the step currently open in the editor? That one stays
        // fully native under Shift so you can DRAG it (e.g. move the flag pole) even
        // when another marker overlaps.
        const isEditedMarker = (m) => m && String(m.getAttribute('data-aim-id')) === String(getOpenStepId());
        window.addEventListener('contextmenu', (e) => {
            const m = badge(e); if (!m) return;
            if (e.shiftKey && isEditedMarker(m)) return; // edited marker: leave native
            // Shift while armed = stack a NAV here, IGNORING this marker. Own the event
            // at window-capture (before Leaflet's interactive-marker handler — the flag
            // pole is a Leaflet-interactive marker) and add here, so nothing else fires.
            if (e.shiftKey && caArmed(e)) {
                e.preventDefault(); e.stopImmediatePropagation();
                try { const ll = caClickToLatLng(e); if (ll) caAddStep('nav', ll); } catch (err) { console.warn(`${TAG} [click-add] shift-stack nav failed`, err); }
                return;
            }
            e.preventDefault(); e.stopImmediatePropagation();
            // Shift held but NOT armed → ignore this marker (no reorder/open).
            if (e.shiftKey) return;
            const id = m.getAttribute('data-aim-id'), kind = m.getAttribute('data-aim-kind');
            // Alt + right-click = DELETE this step (Ctrl+Z restores it). Otherwise
            // the plain right-click opens the reorder editor as before.
            if (e.altKey) { composerDeleteStep(id); return; }
            // Flag Pole: M2 opens its editor (the nav/snap reorder popup doesn't apply).
            if (kind === 'flag') { composerOpenStepEdit(id); return; }
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
            if (e.shiftKey) {
                const m = badge(e);
                if (m && isEditedMarker(m)) return;   // edited marker → native (drag it)
                // When ARMED (Ctrl held / toggle on — read live from THIS mouse event,
                // so it's right even if key events went to another frame), block the
                // press so Leaflet's Shift+drag box-zoom / map-drag can't start; the
                // following click/contextmenu does the add. Also block a non-edited
                // marker even when not armed (so it never swaps). Plain Shift on empty
                // map when NOT armed is left alone (box-zoom still works).
                if (caArmed(e) || m) e.stopImmediatePropagation();
                return;
            }
            if (e.button !== undefined && e.button !== 0) return;  // left button only (keep M2 reorder)
            if (switchTargetFor(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
        };
        window.addEventListener('pointerdown', blockSwitchDown, true);
        window.addEventListener('mousedown', blockSwitchDown, true);
        window.addEventListener('click', (e) => {
            const m = badge(e); if (!m) return;
            if (e.shiftKey && isEditedMarker(m)) return; // edited marker: leave native (drag/click)
            // Shift while armed = stack a SNAPSHOT here, ignoring this marker. Own the
            // event so the marker (esp. the Leaflet-interactive flag pole) can't grab it.
            if (e.shiftKey && caArmed(e)) {
                e.preventDefault(); e.stopImmediatePropagation();
                try { const ll = caClickToLatLng(e); if (ll) caAddStep('snap', ll); } catch (err) { console.warn(`${TAG} [click-add] shift-stack snap failed`, err); }
                return;
            }
            // Shift held but NOT armed → still IGNORE this marker (don't switch/select it).
            // This guarantees Shift never swaps steps, even if arming wasn't detected.
            if (e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); return; }
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
        MB_PERF.ticks++;
        liveTickN++;
        // (1) Keep MBT's cached mission in sync with the LIVE editor state, so the
        //     compact card + map badges reflect native step-edits / drags before a
        //     mission save (fixes "sidebar shows the old altitude"). Also re-syncs
        //     locations so the lat/lng badge match stops failing after a drag.
        //     v1.91: location-only changes (dragging a step) no longer touch the
        //     CARDS — a moved step's AGL updates on the next value change / mission
        //     reload, per user preference. Markers still restyle so badges follow.
        let valChanged = false, locChanged = false;
        if (composerMission && Array.isArray(composerMission.instructions)) {
            const byId = {}; ctx.instrs.forEach(s => { if (s && s.id != null) byId[String(s.id)] = s; });
            const cmIds = {}; composerMission.instructions.forEach(ci => { cmIds[String(ci.id)] = true; });
            composerMission.instructions.forEach(ci => {
                const live = byId[String(ci.id)]; if (!live) return;
                if (typeof live.value1 === 'number' && ci.value1 !== live.value1) { ci.value1 = live.value1; valChanged = true; }
                if (live.location && ci.location && (ci.location.lat !== live.location.lat || ci.location.lng !== live.location.lng)) { ci.location = { lat: live.location.lat, lng: live.location.lng }; locChanged = true; }
            });
            // ADD instructions present live but not in the cache (e.g. ➕ Stage
            // steps with client-only ids) so the compact view + N#/S# badges
            // recognize them before a save.
            ctx.instrs.forEach(live => {
                if (live && live.id != null && !cmIds[String(live.id)]) { composerMission.instructions.push(Object.assign({}, live)); valChanged = true; }
            });
        }
        // Native add/remove of a nav/snap (e.g. "Add Instruction → Navigate") shows
        // up as a live nav+snap COUNT change — force a restyle so the new marker gets
        // its N#/S# number immediately (numbering reads the live order now).
        const liveNS = ctx.instrs.filter(s => s && (s.type_name === 'navigate' || s.type_name === 'snapshot')).length;
        if (liveNS !== composerLastNSCount) { composerLastNSCount = liveNS; valChanged = true; }
        if (valChanged) { try { applyNativeEditorCollapse(); } catch (e) {} try { composerStyleNativeMarkers(); } catch (e) {} }
        else if (locChanged) { try { composerStyleNativeMarkers(); } catch (e) {} }
        // AGL view depends on DEM that loads async — while any card still shows
        // the MSL placeholder, re-render at a SLOW cadence (~2.8s) until all
        // grounds are cached, then go fully idle (v1.91; was every tick).
        else if (showAglInEditor && collapseEditorCards && cxAglPending && liveTickN % 4 === 0) { try { applyNativeEditorCollapse(); } catch (e) {} }
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
        const url = `/map_objects/?getPoiMapObjectsAsList=true&site_id=${encodeURIComponent(siteID)}`;
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
        mrg.title = 'Auto-Group: battery-tiered merged missions per section — 2-opt route order + multi-flight battery simulator (breaks planned near base).';
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
        // Name from a template (customizable in the bulk panel). Tokens: {section}
        // = N/E/S/W from base, {asset} = the asset's name. Default keeps the old
        // "<section> - <asset>" format.
        const assetName = asset.name || ('Asset ' + asset.id);
        const tpl = (opts.nameTemplate && opts.nameTemplate.trim()) || '{section} - {asset}';
        const name = tpl.split('{section}').join(genSection(aC)).split('{asset}').join(assetName);
        return { instructions: instrs, name, navStandoffFt: nav.standoffFt };
    }

    // ── TEMPLATE-DRIVEN GENERATION (Model B) ────────────────────────────────
    // Capture an OPEN mission's step pattern once, save it as a named preset, then
    // generate every asset's mission from it. The template stores the step SEQUENCE
    // + per-step SETTINGS (type/value1/value2/extra_options) minus absolute coords;
    // coordinates are re-derived per asset at build time (navs along the FFZ edge,
    // each nav's snapshots/flag-poles clustered around it — never stacked).
    const CACHE_KEY_MISSION_TEMPLATES = 'aim-mb-mission-templates';
    // Flag pole = type 16 (verified 2026-07-06 on a real mission JSON); altitude +
    // camera params live in extra_options (value1/value2 are null). saveApp rebuilds
    // setmission_dict server-side, so we only carry type/location/extra_options.
    const TPL_TYPE_BY_NAME = { takeoff: 0, navigate: 1, wait: 5, snapshot: 6, cameraselect: 7, camera: 7, gemmode: 24, gem: 24, 'flag pole': 16, flagpole: 16, flag_pole: 16, returnhome: 99 };
    function tplLoadAll() { const o = gmGet(CACHE_KEY_MISSION_TEMPLATES, {}); return (o && typeof o === 'object') ? o : {}; }
    function tplSaveAll(o) { try { gmSet(CACHE_KEY_MISSION_TEMPLATES, o || {}); } catch (e) { console.warn(`${TAG} [tpl] save failed`, e); } }
    function tplTypeNum(s) {
        if (typeof s.type === 'number') return s.type;
        if (s.type && typeof s.type.id === 'number') return s.type.id;
        const n = (s.type_name || '').toLowerCase();
        return TPL_TYPE_BY_NAME[n] != null ? TPL_TYPE_BY_NAME[n] : null;
    }
    function tplNormStep(s) {
        return { type: tplTypeNum(s), type_name: s.type_name || null, value1: (s.value1 === undefined ? null : s.value1), value2: (s.value2 === undefined ? null : s.value2), extra_options: s.extra_options ? JSON.parse(JSON.stringify(s.extra_options)) : {} };
    }
    function tplCaptureOpenMission(name) {
        const ctx = findMissionAppCtx();
        if (!ctx || !ctx.currentApp) { showToast('Open the mission you want to use as a template first.', '#ff9800', 4500); return null; }
        let src = ctx.currentApp.instructions || [];
        if (!src.length) { try { const lc = findMissionEditorCtx(); if (lc && Array.isArray(lc.instrs) && lc.instrs.length) src = lc.instrs; } catch (e) {} }
        const body = src.map(tplNormStep).filter(s => s.type != null && s.type !== 0 && s.type !== 99); // drop takeoff + returnHome (builder re-wraps)
        if (!body.length) { showToast('That mission has no navigate/snapshot steps to capture.', '#ff9800', 4500); return null; }
        const tpl = { name: name, savedAt: Date.now(), srcName: (ctx.currentApp.name || ''), body: body };
        const all = tplLoadAll(); all[name] = tpl; tplSaveAll(all);
        console.log(`${TAG} [tpl] captured "${name}" — ${tplSummary(tpl)} (${body.length} steps)`);
        return tpl;
    }
    function tplSummary(tpl) {
        if (!tpl || !tpl.body) return '';
        let nav = 0, snap = 0, flag = 0, other = 0;
        tpl.body.forEach(s => { if (s.type === 1) nav++; else if (s.type === 6) snap++; else if (s.type === 16) flag++; else other++; });
        const bits = [];
        if (nav) bits.push(`${nav} nav`); if (flag) bits.push(`${flag} flag pole`); if (snap) bits.push(`${snap} snap`); if (other) bits.push(`${other} scan`);
        return bits.join(' · ') || 'empty';
    }
    // K nav points spread along the FFZ edge (inside), fanned by bearing around the
    // asset so multi-nav templates ring the asset instead of stacking. Falls back to
    // a ring around the centroid when the FFZ has no valid inside-edge points.
    function genNavPointsSpread(assetC, ffz, K) {
        const ring = ffz.ring;
        const lat0 = (assetC.lat || ring[0].lat) * Math.PI / 180;
        const mLat = 111320, mLng = 111320 * Math.cos(lat0);
        const toXY = p => ({ x: p.lng * mLng, y: p.lat * mLat });
        const toLL = q => ({ lng: q.x / mLng, lat: q.y / mLat });
        const cands = [];
        for (let i = 0; i < ring.length; i++) {
            const ax = toXY(ring[i]), bx = toXY(ring[(i + 1) % ring.length]);
            let nx = -(bx.y - ax.y), ny = (bx.x - ax.x); const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
            for (let k = 0; k <= 6; k++) {
                const t = k / 6, px = ax.x + (bx.x - ax.x) * t, py = ax.y + (bx.y - ax.y) * t;
                [1, -1].forEach(sgn => {
                    const ll = toLL({ x: px + sgn * nx * GEN_FFZ_INSET_M, y: py + sgn * ny * GEN_FFZ_INSET_M });
                    if (!genPointInPoly(ll, ring)) return;
                    let brg = Math.atan2(ll.lng - assetC.lng, ll.lat - assetC.lat) * 180 / Math.PI; if (brg < 0) brg += 360;
                    cands.push({ ll, d: sopHaversineFt(assetC, ll), brg });
                });
            }
        }
        if (!cands.length) {
            const out = [], rM = GEN_TARGET_STANDOFF_FT / 3.28084, cl = 110540, cg = 111320 * Math.cos(assetC.lat * Math.PI / 180);
            for (let k = 0; k < K; k++) { const a = (k / K) * 2 * Math.PI; out.push({ lat: assetC.lat + (rM * Math.cos(a)) / cl, lng: assetC.lng + (rM * Math.sin(a)) / cg }); }
            return out;
        }
        const pts = [], used = new Set();
        for (let k = 0; k < K; k++) {
            const target = (k / K) * 360; let best = -1, bestScore = Infinity;
            for (let ci = 0; ci < cands.length; ci++) {
                if (used.has(ci)) continue;
                let da = Math.abs(cands[ci].brg - target); if (da > 180) da = 360 - da;
                const score = da + Math.abs(cands[ci].d - GEN_TARGET_STANDOFF_FT) * 0.2;
                if (score < bestScore) { bestScore = score; best = ci; }
            }
            if (best < 0) best = 0;
            used.add(best); pts.push(cands[best].ll);
        }
        return pts;
    }
    // A child step's map position: fanned ~12 m out from its nav, toward the asset,
    // 30° apart so a nav's snapshots ring it without stacking.
    function genClusterPoint(anchor, i, count, aimAt) {
        const R = 12, mLat = 110540, mLng = 111320 * Math.cos(anchor.lat * Math.PI / 180);
        let base = 0;
        if (aimAt) { const bx = (aimAt.lng - anchor.lng) * mLng, by = (aimAt.lat - anchor.lat) * mLat; base = Math.atan2(by, bx); }
        const spread = count > 1 ? (i - (count - 1) / 2) * (Math.PI / 6) : 0;
        const ang = base + spread;
        return { lat: anchor.lat + (R * Math.sin(ang)) / mLat, lng: anchor.lng + (R * Math.cos(ang)) / mLng };
    }
    // Build one asset's mission from a captured template. navs → FFZ edge, each
    // nav's snapshots/flag-poles clustered around it, altitudes re-derived per asset
    // (nav = FFZ-min, snapshot = ground+AGL); flag-pole + scan-wrap steps carry the
    // template's own settings verbatim.
    function buildMissionFromTemplate(asset, ffzs, tpl, opts) {
        opts = opts || {};
        const aC = genCentroid(asset.ring);
        const ffz = genAssetFFZ(aC, ffzs);
        if (!ffz) return null;
        const groundM = getElevationFromCache(aC.lat, aC.lng);
        if (groundM == null) { if (aC.lat != null) try { fetchElevation(aC.lat, aC.lng); } catch (e) {} return null; }
        const navAltM = ffz.minAltM != null ? ffz.minAltM : (groundM + 40);
        const snapAltM = groundM + (defaultSnapAglFt / 3.28084);
        const body = (tpl && tpl.body) || [];
        const groups = []; let cur = null;
        body.forEach(st => {
            if (st.type === 1) { cur = { nav: st, children: [] }; groups.push(cur); }
            else { if (!cur) { cur = { nav: null, children: [] }; groups.push(cur); } cur.children.push(st); }
        });
        const navGroups = groups.filter(g => g.nav);
        const K = Math.max(1, navGroups.length);
        const navPts = genNavPointsSpread(aC, ffz, K);
        const mkStep = (norm, loc) => {
            const type = norm.type, eo = norm.extra_options ? JSON.parse(JSON.stringify(norm.extra_options)) : {};
            let v1 = norm.value1, v2 = norm.value2;
            if (type === 1) { v1 = navAltM; if (v2 == null) v2 = 12; if (eo.shouldUseFreezoneMinAlt === undefined) eo.shouldUseFreezoneMinAlt = true; }
            else if (type === 6) { v1 = snapAltM; v2 = 1; if (eo.pitch === undefined) eo.pitch = 1001; }
            // flag pole (16) + scan wrap (5/7/24): keep the template's value1/value2/extra_options
            return { type, value1: v1 == null ? null : v1, value2: v2 == null ? null : v2, location: loc || null, extra_options: eo, polygon_points: null, snapshot_points: null };
        };
        const instrs = [];
        instrs.push({ type: 0, value1: 20, value2: null, location: null, extra_options: {}, polygon_points: null, snapshot_points: null }); // takeoff
        let ni = 0;
        groups.forEach(g => {
            let anchor;
            if (g.nav) { anchor = navPts[ni] || navPts[navPts.length - 1] || aC; ni++; instrs.push(mkStep(g.nav, { lat: anchor.lat, lng: anchor.lng })); }
            else anchor = navPts[0] || aC;
            const locKids = g.children.filter(c => c.type === 6 || c.type === 16).length;
            let li = 0;
            g.children.forEach(ch => {
                const loc = (ch.type === 6 || ch.type === 16) ? genClusterPoint(anchor, li++, locKids, aC) : null;
                instrs.push(mkStep(ch, loc));
            });
        });
        instrs.push({ type: 99, value1: null, value2: null, location: null, extra_options: {}, polygon_points: null, snapshot_points: null }); // returnHome
        const assetName = asset.name || ('Asset ' + asset.id);
        const t = (opts.nameTemplate && opts.nameTemplate.trim()) || '{section} - {asset}';
        const name = t.split('{section}').join(genSection(aC)).split('{asset}').join(assetName);
        return { instructions: instrs, name };
    }
    // Dispatch: use a captured template if one was chosen, else the basic builder.
    function genBuild(asset, ffzs, opts) {
        if (opts && opts.template) return buildMissionFromTemplate(asset, ffzs, opts.template, opts);
        return buildMissionForAsset(asset, ffzs, opts);
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
        const built = genBuild(asset, ffzs, opts);
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
                <div style="display:flex;align-items:center;gap:6px;margin-top:9px;"><label style="white-space:nowrap;color:#cfe;">Template</label><select data-gp-tpl style="flex:1;min-width:0;background:#0f1216;border:1px solid #2a3340;color:#fff;padding:2px 6px;border-radius:3px;font:inherit;font-size:11px;"></select></div>
                <div data-gp-tpl-sum style="color:#789;font-size:10px;margin-top:2px;"></div>
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
        // Template picker (same presets as the bulk panel). Basic = the popup's
        // built-in preview; a template replays a captured pattern for THIS asset.
        const gpTpl = pop.querySelector('[data-gp-tpl]');
        const gpSum = pop.querySelector('[data-gp-tpl-sum]');
        const gpScan = pop.querySelector('[data-gp-scan]');
        const gpUpdateSum = () => {
            const t = tplLoadAll()[gpTpl.value];
            if (gpScan) { gpScan.disabled = !!t; gpScan.parentElement.style.opacity = t ? '0.5' : ''; }
            gpSum.textContent = t ? `${tplSummary(t)} — navs on FFZ edge, snaps clustered per nav (scan from template).` : 'Basic: 1 nav + snapshot at asset center.';
        };
        (() => { const all = tplLoadAll(), names = Object.keys(all).sort();
            gpTpl.innerHTML = '<option value="">Basic — 1 nav + snapshot</option>' + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)} · ${escapeHtml(tplSummary(all[n]))}</option>`).join('');
            gpUpdateSum(); })();
        gpTpl.onchange = gpUpdateSum;
        pop.querySelector('[data-gp-go]').onclick = () => {
            const scan = gpScan.checked;
            const template = gpTpl.value ? (tplLoadAll()[gpTpl.value] || null) : null;
            genCloseGenPopup();
            genGenerateForAsset(asset, ffzs, { inspectionScan: scan, template });
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
    // Edge-to-edge distance (ft) from an asset pad to its NEAREST FFZ — 0 if the FFZ
    // overlaps/contains the pad (or vice-versa). Used by the "built areas only"
    // filter: an asset counts as built if it has an FFZ inside or ≤ GEN_BUILT_FT of
    // it. Reuses the merge routing core's point-to-polygon distance.
    const GEN_BUILT_FT = 50;
    function genAssetNearestFFZFt(asset, ffzs) {
        if (!asset || !Array.isArray(asset.ring) || !asset.ring.length || !ffzs || !ffzs.length) return Infinity;
        let best = Infinity;
        for (const f of ffzs) {
            if (!f || !Array.isArray(f.ring) || f.ring.length < 3) continue;
            for (const c of asset.ring) { const d = mbPointToPolygonMeters(c.lat, c.lng, f.ring) * 3.28084; if (d < best) best = d; if (best === 0) return 0; }
            for (const p of f.ring) { const d = mbPointToPolygonMeters(p.lat, p.lng, asset.ring) * 3.28084; if (d < best) best = d; if (best === 0) return 0; }
        }
        return best;
    }
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
            const nearFt = genAssetNearestFFZFt(a, ffzs);
            const hasFFZ = nearFt <= GEN_BUILT_FT; // built = FFZ inside or ≤50 ft
            const dis = info.buildable ? '' : 'opacity:0.5;';
            const detail = info.buildable
                ? `nav ${info.standoffFt} ft @ ${info.navAltFt != null ? info.navAltFt + ' ft' : 'FFZ-min'} · snap ${info.snapAltFt} ft`
                : (info.ffz ? 'elevation not loaded' : 'no FFZ found — skip');
            return `<label class="aim-gen-row" data-has-ffz="${hasFFZ ? 1 : 0}" style="display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-bottom:1px solid #2a2f38;${dis}">
                <input type="checkbox" data-gen-row="${i}" ${info.buildable ? 'checked' : ''} ${info.buildable ? '' : 'disabled'} style="flex:0 0 auto;margin-top:2px;">
                <div style="flex:1;min-width:0;">
                    <div style="color:#e6e6e6;font-weight:700;font-size:12px;line-height:1.25;">${escapeHtml(info.name)}</div>
                    <div style="color:#9ad;font-size:10px;line-height:1.2;margin-top:1px;">${escapeHtml(detail)}</div>
                </div>
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
                <div style="display:flex;align-items:center;gap:6px;margin-top:7px;"><label style="color:#cfe;white-space:nowrap;">Name</label><input data-gen-bulk-name value="{section} - {asset}" title="Tokens: {section} = N/E/S/W · {asset} = asset name" style="flex:1;background:#0f1216;border:1px solid #2a3340;color:#fff;padding:2px 6px;border-radius:3px;font:inherit;font-size:11px;"></div>
                <div style="color:#789;font-size:10px;margin-top:2px;">Tokens: <b>{section}</b> = N/E/S/W · <b>{asset}</b> = asset name (e.g. <b>NNE - {asset}</b>)</div>
                <div style="display:flex;align-items:center;gap:6px;margin-top:7px;">
                    <label style="color:#cfe;white-space:nowrap;">Template</label>
                    <select data-gen-tpl style="flex:1;min-width:0;background:#0f1216;border:1px solid #2a3340;color:#fff;padding:2px 6px;border-radius:3px;font:inherit;font-size:11px;"></select>
                    <button data-gen-tpl-capture class="aim-mb-tbtn" title="Capture the mission currently open in the editor as a reusable template" style="padding:2px 7px;font-size:11px;">📋</button>
                    <button data-gen-tpl-del class="aim-mb-tbtn" title="Delete the selected template" style="padding:2px 7px;font-size:11px;">🗑</button>
                </div>
                <div data-gen-tpl-sum style="color:#789;font-size:10px;margin-top:2px;"></div>
                <label style="display:flex;align-items:center;gap:6px;margin-top:5px;cursor:pointer;color:#cfe;"><input type="checkbox" data-gen-bulk-builtonly> Built areas only — assets with an FFZ inside or ≤${GEN_BUILT_FT} ft</label>
                <div style="display:flex;align-items:center;gap:6px;margin-top:7px;">
                    <button data-gen-selall class="aim-mb-tbtn" style="padding:3px 9px;font-size:11px;">Select all</button>
                    <button data-gen-deselall class="aim-mb-tbtn" style="padding:3px 9px;font-size:11px;">Deselect all</button>
                    <span data-gen-shown style="flex:1;text-align:right;color:#789;font-size:10px;"></span>
                </div>
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
        const shownEl = p.querySelector('[data-gen-shown]');
        const updateGo = () => {
            const n = p.querySelectorAll('[data-gen-row]:checked').length;
            goBtn.textContent = `⊕ Create ${n}`; goBtn.disabled = !n || genBulkBusy;
            const vis = [...p.querySelectorAll('.aim-gen-row')].filter(r => r.style.display !== 'none').length;
            if (shownEl) shownEl.textContent = `${vis} shown`;
        };
        p.querySelectorAll('[data-gen-row]').forEach(cb => cb.onchange = updateGo);
        // "Built areas only" filter — hide (and uncheck) assets with no FFZ within
        // GEN_BUILT_FT. Off by default.
        const builtOnly = p.querySelector('[data-gen-bulk-builtonly]');
        const applyBuiltFilter = () => {
            const on = builtOnly.checked;
            p.querySelectorAll('.aim-gen-row').forEach(row => {
                const has = row.getAttribute('data-has-ffz') === '1';
                if (on && !has) { row.style.display = 'none'; const cb = row.querySelector('[data-gen-row]'); if (cb) cb.checked = false; }
                else row.style.display = '';
            });
            updateGo();
        };
        builtOnly.onchange = applyBuiltFilter;
        // Select all (visible + buildable only) / Deselect all.
        p.querySelector('[data-gen-selall]').onclick = () => {
            p.querySelectorAll('.aim-gen-row').forEach(row => { if (row.style.display === 'none') return; const cb = row.querySelector('[data-gen-row]:not(:disabled)'); if (cb) cb.checked = true; });
            updateGo();
        };
        p.querySelector('[data-gen-deselall]').onclick = () => { p.querySelectorAll('[data-gen-row]').forEach(cb => cb.checked = false); updateGo(); };
        updateGo();
        // Template picker: "Basic" (existing 1-nav builder) + saved presets. Capture
        // 📋 grabs the mission open in the editor; 🗑 deletes the selected preset.
        const tplSel = p.querySelector('[data-gen-tpl]');
        const tplSum = p.querySelector('[data-gen-tpl-sum]');
        const scanCb = p.querySelector('[data-gen-bulk-scan]');
        const updateTplSum = () => {
            const t = tplLoadAll()[tplSel.value];
            if (scanCb) { scanCb.disabled = !!t; scanCb.parentElement.style.opacity = t ? '0.5' : ''; }
            tplSum.textContent = t
                ? `${tplSummary(t)}${t.srcName ? ' · from "' + t.srcName + '"' : ''} — navs along FFZ edge, snapshots clustered per nav (scan wrap comes from the template).`
                : 'Basic: 1 nav at the FFZ edge + snapshot(s) at the asset center.';
        };
        const refreshTpls = (selectName) => {
            const all = tplLoadAll(); const names = Object.keys(all).sort();
            tplSel.innerHTML = '<option value="">Basic — 1 nav + snapshot</option>' + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)} · ${escapeHtml(tplSummary(all[n]))}</option>`).join('');
            if (selectName && all[selectName]) tplSel.value = selectName;
            updateTplSum();
        };
        tplSel.onchange = updateTplSum;
        p.querySelector('[data-gen-tpl-capture]').onclick = () => {
            const nm = (prompt('Name this template (captures the mission currently OPEN in the editor):', '') || '').trim();
            if (!nm) return;
            const t = tplCaptureOpenMission(nm);
            if (t) { refreshTpls(nm); showToast(`✓ Template "${nm}" saved — ${tplSummary(t)}.`, '#5fff5f', 5000); }
        };
        p.querySelector('[data-gen-tpl-del]').onclick = () => {
            const nm = tplSel.value;
            if (!nm) { showToast('Pick a saved template to delete (Basic can\'t be deleted).', '#9ad', 3000); return; }
            if (!confirm(`Delete template "${nm}"?`)) return;
            const all = tplLoadAll(); delete all[nm]; tplSaveAll(all); refreshTpls(''); showToast(`Template "${nm}" deleted.`, '#888', 2500);
        };
        refreshTpls('');
        goBtn.onclick = () => {
            if (genBulkBusy) return;
            const picked = [...p.querySelectorAll('[data-gen-row]:checked')].map(cb => valid[Number(cb.getAttribute('data-gen-row'))]).filter(Boolean);
            const scan = scanCb.checked;
            const nameTemplate = (p.querySelector('[data-gen-bulk-name]').value || '').trim() || '{section} - {asset}';
            const template = tplSel.value ? (tplLoadAll()[tplSel.value] || null) : null;
            genBulkCommit(picked, ffzs, { inspectionScan: scan, nameTemplate, template }, p.querySelector('[data-gen-bulk-status]'), goBtn);
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
            const built = genBuild(assets[i], ffzs, opts);
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
    // ── Auto-Group config (v2.15, feature #216) — GM-persisted knobs for the
    // grouping optimizer. Tier radii sit deliberately a hair UNDER the Asset
    // Inspector Battery column's 14k/18k (user rule 2026-07-30: "maybe even a
    // hair under — 13.5 and 17.5"). Budgets = TOTAL per-flight range in
    // ft-equivalents, ≈2× the one-way point-of-no-return estimates (15.5k
    // Tattu / 20k Tulip with zero capture budget).
    const AG_CFG_KEY = 'aim-mb-autogroup-cfg';
    const AG_DEFAULTS = {
        // v2.23: back to the operational 14k/18k — the "hair under" 13.5k/17.5k
        // defaults kept surprising the user (a 13.7k pad reading Tulip-orange
        // when they think of it as a 14k Tattu pad). The margin knob already
        // provides the safety slack; radii should match how they talk.
        tattuRadiusFt: 14000,   // one-way route ≤ this → Tattu tier
        tulipRadiusFt: 18000,   // ≤ this → Tulip tier; beyond → excluded (unflyable)
        // Budgets back-derived from real ops (live test 2026-07-30): 14k/18k
        // pads ARE flown with capture + a 20–30% landing reserve, so total
        // range ≈ 2×radius ÷ 0.75 → ~37k Tattu / ~46k Tulip ft-equiv.
        tattuBudgetFt: 37000,
        tulipBudgetFt: 46000,
        marginPct: 82,          // usable % of the budget — the rest is landing reserve
        // v2.17: a pad's cost = its mission's ACTUAL internal path length
        // (sum of instruction-location hops — the same data the SUM panel
        // estimates from) + stepCost × steps for hover/capture overhead.
        stepCostFt: 40,
        stepMax: 600,           // soft step cap per merged mission (multi-flight is normal)
        targetGroups: 5,        // target direction families per site (user: 4–6 macros total)
    };
    let agCfgCache = null;
    function agCfg() {
        if (!agCfgCache) {
            const saved = gmGet(AG_CFG_KEY, null);
            agCfgCache = Object.assign({}, AG_DEFAULTS, (saved && typeof saved === 'object') ? saved : {});
            Object.keys(AG_DEFAULTS).forEach(k => { const v = Number(agCfgCache[k]); agCfgCache[k] = (isFinite(v) && v > 0) ? v : AG_DEFAULTS[k]; });
        }
        return agCfgCache;
    }
    function agSetCfg(patch) {
        const next = Object.assign({}, agCfg(), patch || {});
        gmSet(AG_CFG_KEY, next);
        agCfgCache = null;   // rebuild (validated) on next read
    }
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
    function mbBatteryFor(routeM) { if (routeM == null) return null; const ft = routeM * 3.28084; const cfg = agCfg(); if (ft <= cfg.tattuRadiusFt) return { label: 'Tattu', color: '#5fff5f', level: 0 }; if (ft <= cfg.tulipRadiusFt) return { label: 'Tulip', color: '#ffd54f', level: 1 }; return { label: `⚠ over ${cfg.tulipRadiusFt.toLocaleString()} ft`, color: '#ff5252', level: 2 }; }

    // 8-way + Central section from base. atan2(dLat,dLng): 0=E, 90=N.
    function mbSection(pt, base) {
        if (!base) return 'C';
        if (mbApproxMeters(base.lat, base.lng, pt.lat, pt.lng) * 3.28084 <= MB_CENTRAL_FT) return 'C';
        const dLat = pt.lat - base.lat, dLng = pt.lng - base.lng;
        let deg = Math.atan2(dLat, dLng) * 180 / Math.PI; if (deg < 0) deg += 360; // 0=E,90=N,180=W,270=S
        const idx = Math.round(deg / 45) % 8;
        return ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][idx];
    }

    // ── Segment-aware graph helpers (v2.18) ─────────────────────────────────
    // ENGRAVED RULE: proximity measures to SEGMENTS, never vertices. An FP arc
    // that CROSSES an FFZ mid-segment is a legal entry even when both of its
    // endpoints are far away, and a pad served by an FP with no FFZ of its own
    // is fully reachable — both were being excluded (live-test feedback:
    // "all the ones I circled are fully reachable and built that way").
    function agRingBbox(ring, padM) {
        let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
        ring.forEach(p => { if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat; if (p.lng < w) w = p.lng; if (p.lng > e) e = p.lng; });
        const dLat = (padM || 0) / 111320;
        const dLng = (padM || 0) / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
        return { s: s - dLat, n: n + dLat, w: w - dLng, e: e + dLng };
    }
    function agBboxHit(bb, a, b) {
        return Math.min(a.lat, b.lat) <= bb.n && Math.max(a.lat, b.lat) >= bb.s
            && Math.min(a.lng, b.lng) <= bb.e && Math.max(a.lng, b.lng) >= bb.w;
    }
    // Splice a synthetic vertex into every FP edge that passes within entryM of
    // an FFZ its endpoints don't touch — the crossing point becomes a real
    // graph vertex (proportional weights), so entry checks and cliques see it.
    function agSpliceFfzCrossings(graph, ffzs, entryM) {
        const edges = [];
        graph.adj.forEach((list, ka) => list.forEach(ed => { if (ka < ed.to) edges.push({ ka, kb: ed.to, w: ed.w }); }));
        const boxes = ffzs.map(f => agRingBbox(f.ring, entryM));
        let added = 0;
        edges.forEach(({ ka, kb, w }) => {
            const a = graph.verts.get(ka), b = graph.verts.get(kb);
            ffzs.forEach((f, fi) => {
                if (!agBboxHit(boxes[fi], a, b)) return;
                if (mbPointToPolygonMeters(a.lat, a.lng, f.ring) <= entryM) return;
                if (mbPointToPolygonMeters(b.lat, b.lng, f.ring) <= entryM) return;
                const total = mbApproxMeters(a.lat, a.lng, b.lat, b.lng);
                const nSteps = Math.max(2, Math.ceil(total / 15));
                let hit = null;
                for (let i = 1; i < nSteps; i++) {
                    const t = i / nSteps;
                    const p = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
                    const d = mbPointToPolygonMeters(p.lat, p.lng, f.ring);
                    if (d <= entryM && (!hit || d < hit.d)) hit = { p, t, d };
                }
                if (!hit) return;
                const k = `x:${ka}|${kb}|${fi}`;
                if (graph.verts.has(k)) return;
                graph.verts.set(k, hit.p);
                graph.adj.set(k, [{ to: ka, w: w * hit.t }, { to: kb, w: w * (1 - hit.t) }]);
                graph.adj.get(ka).push({ to: k, w: w * hit.t });
                graph.adj.get(kb).push({ to: k, w: w * (1 - hit.t) });
                added++;
            });
        });
        return added;
    }
    // Nearest point ON ANY FP EDGE to a set of pad points (bbox-prefiltered).
    // Returns {ka, kb, w, t, d, p} in meters, or null when nothing ≤ maxM.
    function agNearestArcPoint(graph, pts, maxM) {
        if (!pts || !pts.length) return null;
        let bs = Infinity, bn = -Infinity, bw = Infinity, be = -Infinity;
        pts.forEach(p => { if (p.lat < bs) bs = p.lat; if (p.lat > bn) bn = p.lat; if (p.lng < bw) bw = p.lng; if (p.lng > be) be = p.lng; });
        const dLat = maxM / 111320, dLng = maxM / (111320 * Math.cos(((bs + bn) / 2) * Math.PI / 180));
        const bb = { s: bs - dLat, n: bn + dLat, w: bw - dLng, e: be + dLng };
        let best = null;
        graph.adj.forEach((list, ka) => list.forEach(ed => {
            if (ka >= ed.to) return;
            // pad stubs aren't flight paths — never project onto them
            if (String(ka).indexOf('pad') === 0 || String(ed.to).indexOf('pad') === 0) return;
            const a = graph.verts.get(ka), b = graph.verts.get(ed.to);
            if (!agBboxHit(bb, a, b)) return;
            pts.forEach(c => {
                const ax = a.lng, ay = a.lat, bx = b.lng, by = b.lat;
                const dx = bx - ax, dy = by - ay;
                const l2 = dx * dx + dy * dy;
                let t = l2 === 0 ? 0 : ((c.lng - ax) * dx + (c.lat - ay) * dy) / l2;
                t = Math.max(0, Math.min(1, t));
                const py = ay + t * dy, px = ax + t * dx;
                const d = mbApproxMeters(c.lat, c.lng, py, px);
                if (d <= maxM && (!best || d < best.d)) best = { ka, kb: ed.to, w: ed.w, t, d, p: { lat: py, lng: px } };
            });
        }));
        return best;
    }

    // Build a router for the site: bridged FP graph + base Dijkstra maps. routeFor
    // (a list of asset points) returns one-way routeM — Asset-Inspector algorithm
    // + v2.18 segment-aware extensions (spliced FFZ crossings, FP-only fallback).
    function mbBuildRouter(ent) {
        const graph = mbBuildGraph(ent.fps);
        // RAW rings (v2.18) — mbSimplifyPolygon's angular sort mangles non-star
        // polygons (engraved bug), corrupting inside/entry tests.
        const ffzs = (ent.ffzs || []).map(f => ({ ring: f.ring })).filter(f => f.ring && f.ring.length >= 3);
        const entryM = MB_ENTRY_FFZ_FT / 3.28084;
        agSpliceFfzCrossings(graph, ffzs, entryM);
        const fpVerts = []; graph.verts.forEach((v, k) => fpVerts.push({ key: k, lat: v.lat, lng: v.lng }));
        ffzs.forEach(f => { const inside = fpVerts.filter(v => mbPointToPolygonMeters(v.lat, v.lng, f.ring) <= entryM); for (let i = 0; i < inside.length; i++) for (let j = i + 1; j < inside.length; j++) { const w = mbApproxMeters(inside[i].lat, inside[i].lng, inside[j].lat, inside[j].lng); graph.adj.get(inside[i].key).push({ to: inside[j].key, w }); graph.adj.get(inside[j].key).push({ to: inside[i].key, w }); } });
        const bases = (ent.baseEnts && ent.baseEnts.length) ? ent.baseEnts.map(b => ({ lat: b.coords[0].lat, lng: b.coords[0].lng })) : (ent.base ? [ent.base] : []);
        const baseRuns = bases.map(b => { const bv = mbNearestVertex(graph, b.lat, b.lng); if (!bv) return null; return { baseConn: bv.dist, dist: mbDijkstra(graph, bv.key) }; }).filter(Boolean);
        const reachM = MB_REACH_FFZ_FT / 3.28084;
        const ffzFor = (pts) => {
            let ffz = null, ffzD = Infinity;
            ffzs.forEach(f => { let best = Infinity; pts.forEach(c => { const d = mbPointToPolygonMeters(c.lat, c.lng, f.ring); if (d < best) best = d; }); if (best < ffzD) { ffzD = best; ffz = f; } });
            return { ffz, ffzD };
        };
        return {
            ready: graph.verts.size > 0 && baseRuns.length > 0,
            verts: graph.verts.size,
            routeFor(pts) {
                if (!pts || !pts.length) return null;
                const { ffz, ffzD } = ffzFor(pts);
                if (ffz && ffzD <= reachM) {
                    const entries = fpVerts.filter(v => mbPointToPolygonMeters(v.lat, v.lng, ffz.ring) <= entryM);
                    let best = null;
                    baseRuns.forEach(br => { entries.forEach(en => { const net = br.dist.has(en.key) ? br.dist.get(en.key) : null; if (net == null) return; let far = 0; ffz.ring.forEach(p => { const dd = mbApproxMeters(en.lat, en.lng, p.lat, p.lng); if (dd > far) far = dd; }); const total = br.baseConn + net + far; if (best == null || total < best) best = total; }); });
                    if (best != null) return best;
                }
                // FP-only fallback (v2.18): the pad is served straight off a
                // flight path (no FFZ of its own, or its FFZ has no entries) —
                // route to the nearest point ON an arc, segment-aware.
                const arc = agNearestArcPoint(graph, pts, reachM);
                if (!arc) return null;
                let bestFp = null;
                baseRuns.forEach(br => {
                    const da = br.dist.has(arc.ka) ? br.dist.get(arc.ka) + arc.w * arc.t : null;
                    const db = br.dist.has(arc.kb) ? br.dist.get(arc.kb) + arc.w * (1 - arc.t) : null;
                    [da, db].forEach(dd => { if (dd == null) return; const total = br.baseConn + dd + arc.d; if (bestFp == null || total < bestFp) bestFp = total; });
                });
                return bestFp;
            },
            // Human-readable reason a pad is unroutable — shown in Excluded.
            explain(pts) {
                if (!pts || !pts.length) return 'no location';
                const { ffz, ffzD } = ffzFor(pts);
                if (!ffz || ffzD > reachM) {
                    return agNearestArcPoint(graph, pts, reachM) ? 'FP found but no base path' : `no FFZ/FP within ${MB_REACH_FFZ_FT} ft`;
                }
                const entries = fpVerts.filter(v => mbPointToPolygonMeters(v.lat, v.lng, ffz.ring) <= entryM);
                if (!entries.length) return `pad FFZ has no FP entry within ${MB_ENTRY_FFZ_FT} ft`;
                return 'no base path to pad FFZ';
            }
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    // AUTO-GROUP OPTIMIZER (v2.15, feature #216) — upgrades the merge from
    // "sort furthest→closest" to a real routing optimization (small-N CVRP):
    //   1. ORDER GRAPH — FP graph + each pad as a vertex + line-of-sight
    //      shortcut edges INSIDE FFZ polygons (flight rule: stay inside FFZ/FP;
    //      giant open FFZs are crossed straight). LOS edges are containment-
    //      SAMPLED so concave FFZs never grant an illegal shortcut. Pairwise
    //      pad↔pad + base↔pad distances via Dijkstra from every pad.
    //   2. BREAK SIMULATOR — a merged mission spans 2–5 flights; Percepto
    //      resumes at the last completed step after a recharge, so every
    //      mid-mission break costs ~2× the distance home (return leg + commute
    //      back out). The simulator walks an ordering, spends legs + per-step
    //      capture cost against the usable budget (budget × margin), and
    //      breaks so the drone can ALWAYS still make it home.
    //   3. OPTIMIZER — far→near + nearest-neighbor seeds, 2-opt polished,
    //      scored by the SIMULATOR total (transit + RTB overhead). Far→near
    //      tends to win: the battery runs low when the drone is near base.
    // The order graph is SEPARATE from mbBuildRouter's so tier assignment
    // (routeM → Tattu/Tulip) stays in parity with the Asset Inspector's
    // Battery-column algorithm.
    // ════════════════════════════════════════════════════════════════════════

    // Dijkstra with predecessor tracking (mbDijkstra only returns distances) —
    // the route overlay needs the actual vertex path along FPs/FFZs, not a
    // straight line between stops (live-test fix, v2.16).
    function agDijkstra(graph, startKey) {
        const dist = new Map(), prev = new Map();
        if (!graph.adj.has(startKey)) return { dist, prev };
        dist.set(startKey, 0);
        const vis = new Set();
        const pq = [{ k: startKey, d: 0 }];
        while (pq.length) {
            let mi = 0;
            for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[mi].d) mi = i;
            const { k, d } = pq.splice(mi, 1)[0];
            if (vis.has(k)) continue;
            vis.add(k);
            (graph.adj.get(k) || []).forEach(({ to, w }) => {
                const nd = d + w;
                if (nd < (dist.has(to) ? dist.get(to) : Infinity)) { dist.set(to, nd); prev.set(to, k); pq.push({ k: to, d: nd }); }
            });
        }
        return { dist, prev };
    }

    // Does segment a↔b stay inside `ring`? Sampled every ~20 m with a small
    // edge tolerance — cheap and reliable, no clipping library needed.
    function agSegInsideRing(a, b, ring) {
        const total = mbApproxMeters(a.lat, a.lng, b.lat, b.lng);
        const n = Math.max(2, Math.ceil(total / 20));
        for (let i = 1; i < n; i++) {
            const t = i / n;
            const p = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
            if (!genPointInPoly(p, ring) && mbPointToPolygonMeters(p.lat, p.lng, ring) > 8) return false;
        }
        return true;
    }

    // Build the pairwise distance model over the ROUTABLE solos. Returns null
    // when there is nothing to route with. Distances are in FEET. Pairs the
    // graph can't connect fall back to straight-line ×1.25 (counted in
    // offGraphPairs and surfaced in the panel — never silently wrong).
    function agBuildOrderGraph(ent, solos) {
        const graph = mbBuildGraph(ent.fps);
        if (!graph.verts.size) return null;
        // RAW rings, NOT mbSimplifyPolygon (v2.17 live-test fix): the angular
        // sort mangles non-star FFZs (the engraved SOP-validator bug), which
        // made agSegInsideRing REJECT legitimate in-FFZ shortcuts — routes
        // then detoured the long way around (18k-ft base legs on 1k-ft pads).
        const ffzs = (ent.ffzs || []).map(f => ({ ring: f.ring })).filter(f => f.ring && f.ring.length >= 3);
        const entryM = MB_ENTRY_FFZ_FT / 3.28084, reachM = MB_REACH_FFZ_FT / 3.28084;
        // Segment-aware entries (v2.18): arcs crossing an FFZ mid-segment get a
        // spliced vertex BEFORE the vertex census, so cliques + pad links see them.
        agSpliceFfzCrossings(graph, ffzs, entryM);
        const fpVerts = []; graph.verts.forEach((v, k) => fpVerts.push({ key: k, lat: v.lat, lng: v.lng }));
        const link = (ka, kb, w) => { graph.adj.get(ka).push({ to: kb, w }); graph.adj.get(kb).push({ to: ka, w }); };
        // FFZ cliques (v2.19): ALWAYS link — a rejected LOS just means the
        // drone hugs the FFZ interior instead of cutting straight, so the pair
        // gets a ×1.4 detour penalty rather than disconnection. (Strict LOS
        // cliques split components the router graph kept connected → 39.5k
        // straight-fallback legs and effectively random ordering — live test.)
        ffzs.forEach(f => {
            const inside = fpVerts.filter(v => mbPointToPolygonMeters(v.lat, v.lng, f.ring) <= entryM);
            for (let i = 0; i < inside.length; i++) for (let j = i + 1; j < inside.length; j++) {
                const straight = mbApproxMeters(inside[i].lat, inside[i].lng, inside[j].lat, inside[j].lng);
                link(inside[i].key, inside[j].key, agSegInsideRing(inside[i], inside[j], f.ring) ? straight : straight * 1.4);
            }
        });
        // Pads as vertices, LOS-linked into their FFZ (or straight to the
        // nearest in-FFZ FP vertex when no sampled segment survives — the pad
        // sits within REACH of the FFZ so the stub is short + legal-ish).
        // FFZ selection measures from the pad's RING points (same predicate as
        // routeFor) — the centroid alone can sit > REACH from the FFZ even
        // when the pad edge touches it.
        const padKeys = solos.map((s, si) => {
            const c = s.pt;
            if (!c) return null;
            const probe = (s.routePts && s.routePts.length) ? s.routePts : [c];
            const k = `pad:${si}`;
            let ffz = null, ffzD = Infinity;
            ffzs.forEach(f => { let best = Infinity; probe.forEach(pp => { const d = mbPointToPolygonMeters(pp.lat, pp.lng, f.ring); if (d < best) best = d; }); if (best < ffzD) { ffzD = best; ffz = f; } });
            let linked = 0;
            if (ffz && ffzD <= reachM) {
                const inside = fpVerts.filter(v => mbPointToPolygonMeters(v.lat, v.lng, ffz.ring) <= entryM);
                if (inside.length) {
                    graph.verts.set(k, { lat: c.lat, lng: c.lng });
                    graph.adj.set(k, []);
                    inside.forEach(v => { if (agSegInsideRing(c, v, ffz.ring)) { link(k, v.key, mbApproxMeters(c.lat, c.lng, v.lat, v.lng)); linked++; } });
                    if (!linked) {
                        let best = null;
                        inside.forEach(v => { const d = mbApproxMeters(c.lat, c.lng, v.lat, v.lng); if (!best || d < best.d) best = { v, d }; });
                        link(k, best.v.key, best.d);
                        linked = 1;
                    }
                }
            }
            if (!linked) {
                // FP-only pad (v2.18): no FFZ (or FFZ without entries) — splice a
                // synthetic vertex at the nearest point ON an arc, segment-aware.
                const arc = agNearestArcPoint(graph, probe, reachM);
                if (!arc) { graph.verts.delete(k); graph.adj.delete(k); return null; }
                if (!graph.verts.has(k)) { graph.verts.set(k, { lat: c.lat, lng: c.lng }); graph.adj.set(k, []); }
                const xk = `padx:${si}`;
                graph.verts.set(xk, arc.p);
                graph.adj.set(xk, []);
                link(xk, arc.ka, arc.w * arc.t);
                link(xk, arc.kb, arc.w * (1 - arc.t));
                link(k, xk, Math.max(1, arc.d));
            }
            return k;
        });
        // Base vertices (same resolution as mbBuildRouter): own vertex, stub
        // edge to the nearest FP vertex.
        const bases = (ent.baseEnts && ent.baseEnts.length) ? ent.baseEnts.map(b => ({ lat: b.coords[0].lat, lng: b.coords[0].lng })) : (ent.base ? [ent.base] : []);
        const baseKeys = bases.map((b, bi) => {
            const bv = mbNearestVertex(graph, b.lat, b.lng);
            if (!bv) return null;
            const k = `base:${bi}`;
            graph.verts.set(k, { lat: b.lat, lng: b.lng });
            graph.adj.set(k, []);
            link(k, bv.key, bv.dist);
            return k;
        }).filter(Boolean);
        if (!baseKeys.length) return null;
        // One Dijkstra per pad + per base — N ≤ ~100, verts a few hundred: cheap.
        const runs = new Map();
        padKeys.forEach(k => { if (k) runs.set(k, agDijkstra(graph, k)); });
        baseKeys.forEach(k => runs.set(k, agDijkstra(graph, k)));
        // Off-graph legs tracked as UNIQUE pairs (v2.19) — the old raw call
        // counter ballooned into the tens of thousands during 2-opt.
        const offGraph = new Set();
        const straightFt = (a, b) => mbApproxMeters(a.lat, a.lng, b.lat, b.lng) * 3.28084 * 1.25;
        const lookup = (kFrom, kTo) => {
            const run = runs.get(kFrom);
            const m = run ? run.dist.get(kTo) : undefined;
            if (m == null) { offGraph.add(kFrom < kTo ? `${kFrom}|${kTo}` : `${kTo}|${kFrom}`); return straightFt(graph.verts.get(kFrom), graph.verts.get(kTo)); }
            return m * 3.28084;
        };
        // Actual vertex path kFrom→kTo (endpoints included) — walks the prev
        // chain. null when the graph can't connect them.
        const pathPts = (kFrom, kTo) => {
            const run = runs.get(kFrom);
            if (!run || !run.dist.has(kTo)) return null;
            const keys = [kTo];
            let cur = kTo, guard = 0;
            while (cur !== kFrom && guard++ < 20000) {
                cur = run.prev.get(cur);
                if (cur == null) return null;
                keys.push(cur);
            }
            return keys.reverse().map(k => { const v = graph.verts.get(k); return { lat: v.lat, lng: v.lng }; });
        };
        const padPt = i => solos[i].pt;
        const bestBaseKeyFor = (padKey) => {
            let best = null;
            baseKeys.forEach(bk => { const d = lookup(bk, padKey); if (!best || d < best.d) best = { bk, d }; });
            return best ? best.bk : null;
        };
        return {
            padKeys,
            // pad index ↔ pad index (indexes into the `solos` array passed in).
            // A pad that never got a graph vertex estimates straight-line ×1.25
            // (counted in offGraphPairs) — the panel surfaces it, never Infinity.
            padDistFt(i, j) {
                if (i === j) return 0;
                if (!padKeys[i] || !padKeys[j]) { offGraph.add(`p${Math.min(i, j)}|p${Math.max(i, j)}`); return straightFt(padPt(i), padPt(j)); }
                return lookup(padKeys[i], padKeys[j]);
            },
            // pad index → closest base
            baseDistFt(i) {
                if (!padKeys[i]) { offGraph.add(`b|p${i}`); let best = Infinity; bases.forEach(b => { const d = straightFt(b, padPt(i)); if (d < best) best = d; }); return best; }
                let best = Infinity;
                baseKeys.forEach(bk => { const d = lookup(bk, padKeys[i]); if (d < best) best = d; });
                return best;
            },
            // Route-overlay paths (v2.16): actual FP/FFZ vertex chains, with a
            // straight 2-point fallback when the graph can't connect.
            padPath(i, j) {
                const p = (padKeys[i] && padKeys[j]) ? pathPts(padKeys[i], padKeys[j]) : null;
                return p || [padPt(i), padPt(j)];
            },
            basePath(i) {
                if (padKeys[i]) {
                    const bk = bestBaseKeyFor(padKeys[i]);
                    const p = bk ? pathPts(bk, padKeys[i]) : null;
                    if (p) return p;
                }
                let bb = null;
                bases.forEach(b => { const d = straightFt(b, padPt(i)); if (!bb || d < bb.d) bb = { b, d }; });
                return bb ? [bb.b, padPt(i)] : [padPt(i)];
            },
            get offGraphPairs() { return offGraph.size; },
        };
    }

    // A mission's internal flown distance — the sum of hops between its
    // instructions' GPS locations (the same data the SUM panel estimates
    // from). This is the per-pad battery cost the simulator uses (v2.17),
    // plus stepCost × steps for hover/capture overhead.
    function agIntraFt(mission) {
        const ins = (mission && mission.instructions) || [];
        // NAV hops only (v2.19) — the drone flies nav to nav; snapshots are
        // camera positions and add no transit.
        let navs = ins.filter(i => i && i.type === 1 && i.location && typeof i.location.lat === 'number');
        if (!navs.length) navs = ins.filter(i => i && i.location && typeof i.location.lat === 'number');
        let prev = null, ft = 0;
        navs.forEach(i => {
            const L = i.location;
            if (prev) ft += mbApproxMeters(prev.lat, prev.lng, L.lat, L.lng) * 3.28084;
            prev = L;
        });
        return ft;
    }

    // Walk an ordering through the battery model. `order` = indexes into the
    // group's solo list; dPad/dBase in ft; costOf(i) = solo i's on-pad cost
    // (intra-mission path + hover overhead) in ft-equivalents.
    // Rule: before committing to a pad the drone must reach it, shoot it, AND
    // still get home within the usable budget — else it breaks off first.
    function agSimulate(order, dPad, dBase, costOf, budgetFt) {
        const cfg = agCfg();
        const usable = budgetFt * cfg.marginPct / 100;
        const flights = [], tight = [];
        let cur = -1, rem = usable, fPads = [], fDist = 0, overheadFt = 0;
        const endFlight = () => {
            const home = cur === -1 ? 0 : dBase(cur);
            fDist += home;
            let pct = Math.round((budgetFt - ((usable - rem) + home)) / budgetFt * 100);
            if (!isFinite(pct)) pct = -99;
            flights.push({ pads: fPads, distFt: fDist, reservePct: Math.max(-99, pct) });
        };
        for (let x = 0; x < order.length; x++) {
            const i = order[x];
            const stepFt = costOf(i);
            let legFt = cur === -1 ? dBase(i) : dPad(cur, i);
            if (cur !== -1 && rem < legFt + stepFt + dBase(i)) {
                // recharge break: RTB from the current pad, resume from base
                overheadFt += dBase(cur);
                endFlight();
                cur = -1; rem = usable; fPads = []; fDist = 0;
                legFt = dBase(i);
                overheadFt += legFt;   // the commute back out to the resume point
            }
            if (cur === -1 && rem < legFt + stepFt + dBase(i)) tight.push(i);   // doesn't fit even on a fresh battery — flag, keep going
            rem -= legFt + stepFt;
            fDist += legFt + stepFt;
            fPads.push(i); cur = i;
        }
        if (fPads.length) endFlight();
        return { flights, totalFt: flights.reduce((s, f) => s + f.distFt, 0), overheadFt, tight };
    }

    // Best visiting order for a set of pads: two seeds (furthest→closest and a
    // nearest-neighbor chain from the furthest pad), each 2-opt polished with
    // the SIMULATOR total as the objective — transit and RTB overhead both count.
    function agOptimizeOrder(idxs, dPad, dBase, costOf, budgetFt) {
        if (idxs.length < 2) return idxs.slice();
        // Depth tie-break (v2.34, user rule): a dead-end spur costs the SAME
        // transit in either direction, so the simulator ties — and the user
        // always wants the DEEPEST pad of a newly-entered area first, peeling
        // back toward base. tieFt sums position×depth scaled to < 1 ft, so it
        // settles ties without ever trading away real distance.
        const nIdx = idxs.length;
        let maxD = 1;
        idxs.forEach(i => { const d = dBase(i); if (isFinite(d) && d > maxD) maxD = d; });
        const tieFt = (o) => { let t = 0; for (let x = 0; x < o.length; x++) t += (x / nIdx) * (dBase(o[x]) / maxD); return (t / nIdx) * 0.9; };
        const cost = o => agSimulate(o, dPad, dBase, costOf, budgetFt).totalFt + tieFt(o);
        const farNear = idxs.slice().sort((a, b) => dBase(b) - dBase(a));
        const nn = [farNear[0]];
        const left = new Set(farNear.slice(1));
        while (left.size) {
            const cur = nn[nn.length - 1];
            let best = null;
            left.forEach(j => { const d = dPad(cur, j); if (!best || d < best.d) best = { j, d }; });
            nn.push(best.j); left.delete(best.j);
        }
        let winner = null;
        // Seed ORDER is the tie-break (strict <): when most pads each need
        // their own flight, every order simulates ~equal and the first seed
        // wins — NN chains read geographically coherent, far→near reads
        // scrambled ("why is 1, 2, 3 all over the place" — live test v2.33).
        // So: NN chain first, caller's order (bearing sweep) second,
        // far→near last.
        [nn, idxs.slice(), farNear].forEach(seed => {
            let o = seed.slice(), c = cost(o), improved = true, guard = 0;
            while (improved && guard++ < 40) {
                improved = false;
                for (let i = 0; i < o.length - 1; i++) {
                    for (let j = i + 1; j < o.length; j++) {
                        const cand = o.slice(0, i).concat(o.slice(i, j + 1).reverse(), o.slice(j + 1));
                        const cc = cost(cand);
                        // 0.01 threshold: sub-1-ft tie-break improvements
                        // (deepest-first) must be able to win too
                        if (cc < c - 0.01) { o = cand; c = cc; improved = true; }
                    }
                }
            }
            if (!winner || c < winner.c) winner = { o, c };
        });
        return winner.o;
    }

    // 16-wind compass name for a chunk of solos (circular-mean bearing from
    // base). Used when a section splits on the step cap — the sub-sectors get
    // finer compass names (East → ENE + ESE) instead of A/B suffixes, since
    // the "1"/"2" slots are battery tiers. Collisions get an _2 suffix.
    const AG_WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    function agWindName(list, base, usedNames) {
        let sx = 0, sy = 0;
        list.forEach(s => {
            const dLat = s.pt.lat - base.lat, dLng = (s.pt.lng - base.lng) * Math.cos(base.lat * Math.PI / 180);
            const h = Math.hypot(dLat, dLng) || 1;
            sy += dLat / h; sx += dLng / h;
        });
        let compass = 90 - Math.atan2(sy, sx) * 180 / Math.PI;   // 0=N, clockwise
        compass = ((compass % 360) + 360) % 360;
        let name = AG_WINDS[Math.round(compass / 22.5) % 16];
        let n = 2;
        while (usedNames.has(name)) name = `${AG_WINDS[Math.round(compass / 22.5) % 16]}_${n++}`;
        usedNames.add(name);
        return name;
    }

    // Global sweep partition (v2.16 — replaces fixed 8-way sections, which
    // produced 14 tiny groups on a 57-pad site; the user wants ~4–6 macros).
    // ALL routable pads sorted by bearing around base, seam at the largest
    // angular gap, cut into K contiguous arcs with roughly equal step totals.
    // K = ceil(totalSteps / stepMax) capped at the targetGroups knob — so
    // adjacent directions merge freely (user rule: efficiency over looks) and
    // multi-flight missions are expected, not avoided.
    function agSweepFamilies(solos, base) {
        const cfg = agCfg();
        const steps = s => pcmStepCount(s.mission);
        const totalSteps = solos.reduce((t, s) => t + steps(s), 0);
        const K = Math.max(1, Math.min(solos.length, Math.min(cfg.targetGroups, Math.max(1, Math.ceil(totalSteps / cfg.stepMax)))));
        if (K <= 1 || !base) return [{ solos: solos.slice() }];
        const bearing = s => { const d = 90 - Math.atan2(s.pt.lat - base.lat, (s.pt.lng - base.lng) * Math.cos(base.lat * Math.PI / 180)) * 180 / Math.PI; return ((d % 360) + 360) % 360; };
        const withB = solos.map(s => ({ s, b: bearing(s) })).sort((a, b) => a.b - b.b);
        let gapAt = 0, gapMax = -1;
        for (let i = 0; i < withB.length; i++) {
            const next = withB[(i + 1) % withB.length].b + ((i + 1) >= withB.length ? 360 : 0);
            const g = next - withB[i].b;
            if (g > gapMax) { gapMax = g; gapAt = (i + 1) % withB.length; }
        }
        const rot = withB.slice(gapAt).concat(withB.slice(0, gapAt)).map(x => x.s);
        const target = totalSteps / K;
        const fams = []; let cl = [], cs = 0;
        rot.forEach(s => {
            cl.push(s); cs += steps(s);
            if (cs >= target && fams.length < K - 1) { fams.push({ solos: cl }); cl = []; cs = 0; }
        });
        if (cl.length) fams.push({ solos: cl });
        return fams;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 🔋 RANGE OVERLAY (v2.20) — trustworthy per-pad battery classification.
    // For every asset pad's FFZ: the TRUE shortest route from the base staying
    // INSIDE FFZs / along FPs (visibility graph over FFZ ring vertices — paths
    // bend around corners, never cut them; ring-boundary edges guarantee a
    // legal path exists around any concave shape, visibility edges only ever
    // shorten it). Then VERIFIED before anything is colored:
    //   1. LEGALITY AUDIT — the winning route re-sampled every ~5 m; every
    //      sample must lie inside an FFZ or on an FP arc (~13 ft tolerance).
    //      Any violation → pad renders ⚠ orange "unverified", never classified.
    //   2. SECOND OPINION — a DENSIFIED graph (ring + arc midpoints) is solved
    //      independently; the shorter answer wins, disagreements are logged.
    //   3. LOWER BOUND — every route must be ≥ straight-line distance.
    // All rendering is interactive:false / pointer-events:none — M2 pad
    // picking for the merge editor passes straight through the overlay.
    // ════════════════════════════════════════════════════════════════════════

    // Strict segment-inside test for the range graph. DELIBERATELY finer and
    // tighter than the legality audit (4 m steps / 2 m tolerance vs the
    // audit's 5 m / 4 m): every edge this builds provably survives the audit,
    // so a flagged route always means a real bug, never sampling noise. (The
    // audit caught exactly this on 1583: a 56 m visibility edge clipping a
    // concave notch between 10 m construction samples.)
    function rngSegInside(a, b, ring) {
        const total = mbApproxMeters(a.lat, a.lng, b.lat, b.lng);
        const n = Math.max(2, Math.ceil(total / 4));
        for (let i = 1; i < n; i++) {
            const t = i / n;
            const p = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
            if (!genPointInPoly(p, ring) && mbPointToPolygonMeters(p.lat, p.lng, ring) > 2) return false;
        }
        return true;
    }

    function rngBuildGraph(ent, dense) {
        const graph = mbBuildGraph(ent.fps);
        const ffzs = (ent.ffzs || []).map(f => ({ ring: f.ring })).filter(f => f.ring && f.ring.length >= 3);
        const entryM = MB_ENTRY_FFZ_FT / 3.28084;
        const addV = (k, p) => { if (!graph.verts.has(k)) { graph.verts.set(k, p); graph.adj.set(k, []); } };
        const link = (ka, kb, w) => { graph.adj.get(ka).push({ to: kb, w }); graph.adj.get(kb).push({ to: ka, w }); };
        // dense mode: split every FP arc at its midpoint (second-opinion run)
        if (dense) {
            const edges = [];
            graph.adj.forEach((list, ka) => list.forEach(e => { if (ka < e.to) edges.push({ ka, kb: e.to, w: e.w }); }));
            edges.forEach(({ ka, kb, w }, i) => {
                const a = graph.verts.get(ka), b = graph.verts.get(kb);
                const mk = `m:${i}`;
                addV(mk, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
                link(mk, ka, w / 2); link(mk, kb, w / 2);
            });
        }
        agSpliceFfzCrossings(graph, ffzs, entryM);
        // FFZ ring vertices as graph nodes + boundary edges.
        ffzs.forEach((f, fi) => {
            const ring = f.ring;
            const keys = ring.map((p, i) => { const k = `r:${fi}:${i}`; addV(k, { lat: p.lat, lng: p.lng }); return k; });
            for (let i = 0; i < ring.length; i++) {
                const j = (i + 1) % ring.length;
                const w = mbApproxMeters(ring[i].lat, ring[i].lng, ring[j].lat, ring[j].lng);
                if (dense && w > 30) {
                    const mk = `rm:${fi}:${i}`;
                    addV(mk, { lat: (ring[i].lat + ring[j].lat) / 2, lng: (ring[i].lng + ring[j].lng) / 2 });
                    link(keys[i], mk, w / 2); link(mk, keys[j], w / 2);
                } else {
                    link(keys[i], keys[j], w);
                }
            }
        });
        // Intra-FFZ visibility edges over ALL member vertices (ring verts, FP
        // verts, crossings, overlapping FFZs' ring verts). Strict containment,
        // NO penalties, NO forced links — the boundary edges already guarantee
        // connectivity, so these only ever shorten legal paths.
        const boxes = ffzs.map(f => agRingBbox(f.ring, entryM));
        ffzs.forEach((f, fi) => {
            const bb = boxes[fi];
            const members = [];
            graph.verts.forEach((v, k) => {
                if (v.lat < bb.s || v.lat > bb.n || v.lng < bb.w || v.lng > bb.e) return;
                if (mbPointToPolygonMeters(v.lat, v.lng, f.ring) <= entryM) members.push({ k, v });
            });
            for (let i = 0; i < members.length; i++) {
                for (let j = i + 1; j < members.length; j++) {
                    if (!rngSegInside(members[i].v, members[j].v, f.ring)) continue;
                    link(members[i].k, members[j].k, mbApproxMeters(members[i].v.lat, members[i].v.lng, members[j].v.lat, members[j].v.lng));
                }
            }
        });
        // Base vertices: visibility-linked into any FFZ they sit in, plus a
        // stub onto the nearest FP arc so the base is never stranded.
        const bases = (ent.baseEnts && ent.baseEnts.length) ? ent.baseEnts.map(b => ({ lat: b.coords[0].lat, lng: b.coords[0].lng })) : (ent.base ? [ent.base] : []);
        const baseKeys = bases.map((b, bi) => {
            const k = `base:${bi}`;
            addV(k, { lat: b.lat, lng: b.lng });
            let linked = 0;
            ffzs.forEach((f, fi) => {
                if (mbPointToPolygonMeters(b.lat, b.lng, f.ring) > entryM) return;
                const bb = boxes[fi];
                graph.verts.forEach((v, vk) => {
                    if (vk === k) return;
                    if (v.lat < bb.s || v.lat > bb.n || v.lng < bb.w || v.lng > bb.e) return;
                    if (mbPointToPolygonMeters(v.lat, v.lng, f.ring) > entryM) return;
                    if (!rngSegInside(b, v, f.ring)) return;
                    link(k, vk, mbApproxMeters(b.lat, b.lng, v.lat, v.lng));
                    linked++;
                });
            });
            const arc = agNearestArcPoint(graph, [b], MB_REACH_FFZ_FT / 3.28084);
            if (arc) {
                const xk = `basex:${bi}`;
                addV(xk, arc.p);
                link(xk, arc.ka, arc.w * arc.t); link(xk, arc.kb, arc.w * (1 - arc.t));
                link(k, xk, Math.max(1, arc.d));
                linked++;
            }
            if (!linked) { const nv = mbNearestVertex(graph, b.lat, b.lng); if (nv && nv.key !== k) link(k, nv.key, nv.dist); }
            return k;
        });
        return { graph, ffzs, baseKeys };
    }

    // Is a point legal flight space? Inside an FFZ, on an FP arc (~4 m tol),
    // or in the takeoff vicinity of a base (the base→graph stub necessarily
    // crosses a few meters of open ground).
    function rngPointLegal(p, ffzs, boxes, arcs, basePts) {
        if (basePts) {
            for (let i = 0; i < basePts.length; i++) {
                if (mbApproxMeters(p.lat, p.lng, basePts[i].lat, basePts[i].lng) <= MB_REACH_FFZ_FT / 3.28084) return true;
            }
        }
        for (let i = 0; i < ffzs.length; i++) {
            const bb = boxes[i];
            if (p.lat < bb.s || p.lat > bb.n || p.lng < bb.w || p.lng > bb.e) continue;
            if (mbPointToPolygonMeters(p.lat, p.lng, ffzs[i].ring) <= 4) return true;
        }
        for (let i = 0; i < arcs.length; i++) {
            const a = arcs[i];
            if (p.lat < a.bb.s || p.lat > a.bb.n || p.lng < a.bb.w || p.lng > a.bb.e) continue;
            if (mbPointToSegMeters(p.lat, p.lng, a.a, a.b) <= 4) return true;
        }
        return false;
    }

    // Audit one route: walk the prev chain, sample every ~5 m, count illegal.
    function rngAuditPath(sol, targetKey, ffzs, boxes, arcs, basePts) {
        const best = sol.distTo(targetKey);
        if (!best) return { ok: false, badFrac: 1 };
        const run = sol.runs[best.ri];
        const keys = [targetKey];
        let cur = targetKey, guard = 0;
        while (run.prev.has(cur) && guard++ < 20000) { cur = run.prev.get(cur); keys.push(cur); }
        const pts = keys.reverse().map(k => sol.g.graph.verts.get(k)).filter(Boolean);
        let bad = 0, total = 0;
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            const n = Math.max(1, Math.ceil(mbApproxMeters(a.lat, a.lng, b.lat, b.lng) / 5));
            for (let s = 0; s <= n; s++) {
                const p = { lat: a.lat + (b.lat - a.lat) * s / n, lng: a.lng + (b.lng - a.lng) * s / n };
                total++;
                if (!rngPointLegal(p, ffzs, boxes, arcs, basePts)) bad++;
            }
        }
        return { ok: bad === 0, badFrac: total ? bad / total : 1, pts };
    }

    // Asset↔FFZ distance measured RING-PERIMETER to polygon (sampled ~10 m) —
    // corners alone miss an FFZ hugging the middle of a pad edge (engraved
    // segments-not-vertices rule; live case v2.34: "ATKINS 14 4213H — no FFZ"
    // with its FFZ visibly touching the pad edge).
    function rngRingToPolyM(ringA, ringB) {
        let best = Infinity;
        for (let i = 0; i < ringA.length; i++) {
            const a = ringA[i], b = ringA[(i + 1) % ringA.length];
            const n = Math.max(1, Math.ceil(mbApproxMeters(a.lat, a.lng, b.lat, b.lng) / 10));
            for (let s = 0; s <= n; s++) {
                const p = { lat: a.lat + (b.lat - a.lat) * s / n, lng: a.lng + (b.lng - a.lng) * s / n };
                const d = mbPointToPolygonMeters(p.lat, p.lng, ringB);
                if (d < best) best = d;
                if (best === 0) return 0;
            }
        }
        return best;
    }

    // Solve the whole site: sparse + dense runs, per-pad classification with
    // the three verification passes. Distances in FEET.
    function rngSolve(ent) {
        const t0 = Date.now();
        const reachM = MB_REACH_FFZ_FT / 3.28084;
        const runFor = (dense) => {
            const g = rngBuildGraph(ent, dense);
            const runs = g.baseKeys.map(bk => agDijkstra(g.graph, bk));
            return {
                g, runs,
                distTo(k) {
                    let best = null;
                    runs.forEach((r, ri) => { const d = r.dist.get(k); if (d != null && (best == null || d < best.d)) best = { d, ri }; });
                    return best;
                },
            };
        };
        const sparse = runFor(false);
        const dense = runFor(true);
        const ffzs = sparse.g.ffzs;
        const boxes = ffzs.map(f => agRingBbox(f.ring, 5));
        const arcs = [];
        (ent.fps || []).forEach(e => (e.arcs || []).forEach(arc => {
            if (!arc.point_a || !arc.point_b || typeof arc.point_a.lat !== 'number' || typeof arc.point_b.lat !== 'number') return;
            const a = arc.point_a, b = arc.point_b;
            arcs.push({ a, b, bb: { s: Math.min(a.lat, b.lat) - 0.0001, n: Math.max(a.lat, b.lat) + 0.0001, w: Math.min(a.lng, b.lng) - 0.0001, e: Math.max(a.lng, b.lng) + 0.0001 } });
        }));
        const basePts = sparse.g.baseKeys.map(k => sparse.g.graph.verts.get(k));
        const byFfz = new Map();   // fi → result (pads sharing an FFZ share the answer)
        const results = [];
        // v2.34: pad→FFZ match samples the pad PERIMETER (segments, not just
        // corners), bbox-prefiltered so the extra sampling stays cheap.
        const ffzReachBoxes = ffzs.map(f => agRingBbox(f.ring, reachM + 5));
        (ent.assets || []).forEach(a => {
            const ab = agRingBbox(a.ring, 0);
            let fi = -1, fd = Infinity;
            ffzs.forEach((f, i) => {
                const bb = ffzReachBoxes[i];
                if (!(ab.s <= bb.n && ab.n >= bb.s && ab.w <= bb.e && ab.e >= bb.w)) return;
                const d = rngRingToPolyM(a.ring, f.ring);
                if (d < fd) { fd = d; fi = i; }
            });
            if (fi < 0 || fd > reachM) { results.push({ asset: a, fi: -1, status: 'no-ffz' }); return; }
            if (byFfz.has(fi)) { results.push(Object.assign({ asset: a }, byFfz.get(fi))); return; }
            const ring = ffzs[fi].ring;
            let worst = null, entry = null, missing = 0;
            for (let i = 0; i < ring.length; i++) {
                const kS = sparse.distTo(`r:${fi}:${i}`), kD = dense.distTo(`r:${fi}:${i}`);
                let m = kS ? kS.d : null;
                if (kD && (m == null || kD.d < m - 1)) m = kD.d;   // second opinion: shorter wins
                if (m == null) { missing++; continue; }
                if (entry == null || m < entry) entry = m;
                if (worst == null || m > worst.w) worst = { w: m, vi: i };
            }
            let r;
            if (worst == null) {
                r = { fi, status: 'unreachable' };
            } else {
                const kS = sparse.distTo(`r:${fi}:${worst.vi}`), kD = dense.distTo(`r:${fi}:${worst.vi}`);
                const disagree = !!(kS && kD && Math.abs(kS.d - kD.d) > Math.max(30, 0.02 * Math.min(kS.d, kD.d)));
                const audit = rngAuditPath(sparse, `r:${fi}:${worst.vi}`, ffzs, boxes, arcs, basePts);
                // lower bound: route can never beat the straight line
                const vw = ring[worst.vi];
                let straightM = Infinity;
                basePts.forEach(bp => { const d = mbApproxMeters(bp.lat, bp.lng, vw.lat, vw.lng); if (d < straightM) straightM = d; });
                const belowBound = worst.w < straightM - 5;
                r = {
                    fi, status: 'ok',
                    worstFt: worst.w * 3.28084, entryFt: entry * 3.28084,
                    verified: audit.ok && !belowBound, disagree, missing,
                    badFrac: audit.badFrac,
                };
            }
            byFfz.set(fi, r);
            results.push(Object.assign({ asset: a }, r));
        });
        const flagged = results.filter(x => x.status === 'ok' && (!x.verified || x.disagree));
        console.log(`${TAG} [range] ${results.length} pads solved in ${Date.now() - t0} ms · ${flagged.length} flagged (illegal-sample or sparse/dense disagreement)`);
        flagged.forEach(x => console.log(`${TAG} [range] ⚠ ${x.asset.name}: verified=${x.verified} disagree=${x.disagree} badFrac=${(x.badFrac || 0).toFixed(3)}`));
        return { results, ffzs, byFfz };
    }

    // ── rendering (all click-through) ──
    const rng = { on: false, busy: false, layers: [], legendEl: null, chips: [], hover: null };
    function rngClear() {
        rng.layers.forEach(l => { try { l.remove(); } catch (e) {} });
        rng.layers = [];
        rng.chips = [];
        rngUnbindHover();
        if (rng.legendEl) { try { rng.legendEl.remove(); } catch (e) {} rng.legendEl = null; }
    }
    // Big tintable battery icon (v2.21 — the text chip was too small to spot).
    // pointer-events:none throughout: nothing about it is pressable.
    function rngBatteryHtml(color, mark, near) {
        // near = within RNG_NEAR_FT of the class cutoff → red outline (v2.24)
        const stroke = near ? '#ff2222' : '#10131a';
        const sw = near ? 2.6 : 1.8;
        return `<div style="pointer-events:none;position:relative;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.85));">
            <svg width="34" height="18" viewBox="0 0 34 18">
                <rect x="1.5" y="2" width="27" height="14" rx="3.5" fill="${color}" stroke="${stroke}" stroke-width="${sw}"></rect>
                <rect x="30" y="5.5" width="3.5" height="7" rx="1.5" fill="${stroke}"></rect>
            </svg>
            ${mark ? `<div style="position:absolute;top:0;left:0;width:29px;text-align:center;font:800 12px/18px sans-serif;color:#10131a;">${mark}</div>` : ''}
        </div>`;
    }
    // Hover distances WITHOUT pointer events: a throttled mousemove tracker on
    // the map container measures cursor proximity to each battery icon and
    // shows a floating tooltip. The icons never receive events, so M2 pad
    // picking cannot conflict with them by construction.
    function rngBindHover() {
        rngUnbindHover();
        const map = getLeafletMap();
        const c = map && typeof map.getContainer === 'function' ? map.getContainer() : null;
        if (!c) return;
        const tip = document.createElement('div');
        tip.style.cssText = 'position:fixed;z-index:2147483601;pointer-events:none;display:none;background:rgba(16,19,26,0.95);border:1px solid #7adfe6;border-radius:6px;padding:4px 10px;color:#e6e6e6;font:700 12px "Lato","Segoe UI",sans-serif;box-shadow:0 3px 10px rgba(0,0,0,0.6);white-space:nowrap;';
        document.body.appendChild(tip);
        let last = 0;
        const onMove = (ev) => {
            const now = Date.now();
            if (now - last < 60) return;
            last = now;
            const m2 = getLeafletMap();
            if (!m2) { tip.style.display = 'none'; return; }
            const rect = c.getBoundingClientRect();
            let best = null;
            rng.chips.forEach(ch => {
                let p;
                try { p = m2.latLngToContainerPoint([ch.lat, ch.lng]); } catch (e) { return; }
                const d = Math.hypot(ev.clientX - (rect.left + p.x), ev.clientY - (rect.top + p.y));
                if (d <= 26 && (!best || d < best.d)) best = { d, ch };
            });
            if (!best) { tip.style.display = 'none'; return; }
            tip.textContent = best.ch.text;
            tip.style.left = `${ev.clientX + 14}px`;
            tip.style.top = `${ev.clientY - 32}px`;
            tip.style.display = 'block';
        };
        const onLeave = () => { tip.style.display = 'none'; };
        c.addEventListener('mousemove', onMove);
        c.addEventListener('mouseleave', onLeave);
        rng.hover = { c, onMove, onLeave, tip };
    }
    function rngUnbindHover() {
        if (!rng.hover) return;
        try { rng.hover.c.removeEventListener('mousemove', rng.hover.onMove); rng.hover.c.removeEventListener('mouseleave', rng.hover.onLeave); } catch (e) {}
        try { rng.hover.tip.remove(); } catch (e) {}
        rng.hover = null;
    }
    function rngDraw(sol) {
        const L = composerGetL(), map = getLeafletMap();
        if (!L || !map) { showToast('Range: map not found.', '#ff9800', 3000); return; }
        // Belt-and-braces: the marker ELEMENT itself must never take events
        // (divIcon default styling varies) — M2 on a pad under a battery icon
        // has to reach the pad.
        if (!document.getElementById('aim-mb-rng-style')) {
            const st = document.createElement('style');
            st.id = 'aim-mb-rng-style';
            st.textContent = '.aim-mb-rng-chip, .aim-mb-rng-chip * { pointer-events: none !important; }';
            document.head.appendChild(st);
        }
        const cfg = agCfg();
        // Within this many ft below a class cutoff → red-outlined battery +
        // "close to cutoff" in the tooltip (13.5–14k / 17.5–18k at defaults).
        const RNG_NEAR_FT = 500;
        const cls = (r) => {
            if (r.status === 'no-ffz') return { color: '#9aa5b1', label: 'no FFZ', kind: 'noffz', mark: '–' };
            if (r.status === 'unreachable') return { color: '#ff5252', label: 'no legal route from base', kind: 'unreach', mark: '✕' };
            if (!r.verified || r.disagree) return { color: '#c39dff', label: '⚠ unverified — see console', kind: 'warn', mark: '!' };
            if (r.worstFt <= cfg.tattuRadiusFt) return { color: '#5fff5f', label: 'Tattu', kind: 'tattu', mark: '', near: r.worstFt > cfg.tattuRadiusFt - RNG_NEAR_FT };
            if (r.worstFt <= cfg.tulipRadiusFt) return { color: '#ffa726', label: 'Tulip', kind: 'tulip', mark: '', near: r.worstFt > cfg.tulipRadiusFt - RNG_NEAR_FT };
            return { color: '#ff5252', label: 'out of range', kind: 'over', mark: '✕' };
        };
        const counts = { tattu: 0, tulip: 0, over: 0, warn: 0, unreach: 0, noffz: 0, near: 0 };
        const drawnFfz = new Set();
        sol.results.forEach(r => {
            const c = cls(r);
            counts[c.kind]++;
            if (c.near) counts.near++;
            if (r.fi >= 0 && !drawnFfz.has(r.fi)) {
                drawnFfz.add(r.fi);
                const ring = sol.ffzs[r.fi].ring.map(p => [p.lat, p.lng]);
                try {
                    rng.layers.push(L.polygon(ring, { color: c.color, weight: 3, dashArray: '7 5', opacity: 0.95, fillColor: c.color, fillOpacity: 0.10, interactive: false }).addTo(getLeafletMap()));
                    const ctr = genCentroid(sol.ffzs[r.fi].ring);
                    const icon = L.divIcon({
                        className: 'aim-mb-rng-chip',
                        html: rngBatteryHtml(c.color, c.mark, c.near),
                        iconSize: [34, 18], iconAnchor: [17, 9],
                    });
                    // sits BELOW pick-number badges (their zIndexOffset is +1000)
                    rng.layers.push(L.marker([ctr.lat, ctr.lng], { icon, interactive: false, keyboard: false, zIndexOffset: -600 }).addTo(getLeafletMap()));
                    rng.chips.push({
                        lat: ctr.lat, lng: ctr.lng,
                        text: r.status === 'ok'
                            ? `${(r.worstFt / 1000).toFixed(1)}k ft · ${c.label}${c.near ? ' — ⚠ close to cutoff' : ''}`
                            : c.label,
                    });
                } catch (e) {}
            } else if (r.fi < 0 && r.asset && r.asset.ring && r.asset.ring.length >= 3) {
                try { rng.layers.push(L.polygon(r.asset.ring.map(p => [p.lat, p.lng]), { color: c.color, weight: 2, dashArray: '3 5', opacity: 0.8, fill: false, interactive: false }).addTo(getLeafletMap())); } catch (e) {}
            }
        });
        rngBindHover();
        // legend (fixed, small, bottom-left)
        const cfg2 = agCfg();
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:12px;bottom:14px;z-index:2147483599;background:rgba(16,19,26,0.92);border:1px solid #2a3340;border-radius:8px;padding:8px 11px;color:#e6e6e6;font:11px "Lato","Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.6);pointer-events:auto;';
        const row = (col, label, n) => n ? `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;"><span style="width:10px;height:10px;border-radius:2px;background:${col};"></span>${label} <b style="margin-left:auto;padding-left:10px;">${n}</b></div>` : '';
        el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;"><b style="color:#7adfe6;">🔋 Range from base</b><span data-rng-x style="cursor:pointer;color:#888;font-weight:800;">✕</span></div>`
            + row('#5fff5f', `Tattu ≤ ${(cfg2.tattuRadiusFt / 1000).toFixed(1)}k ft`, counts.tattu)
            + row('#ffa726', `Tulip ≤ ${(cfg2.tulipRadiusFt / 1000).toFixed(1)}k ft`, counts.tulip)
            + row('#ff5252', 'Out of range / no route', counts.over + counts.unreach)
            + row('#c39dff', '⚠ unverified (see console)', counts.warn)
            + row('#9aa5b1', 'No FFZ', counts.noffz)
            + (counts.near ? `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;"><span style="width:10px;height:10px;border-radius:2px;background:#333;border:2px solid #ff2222;"></span>Red outline = close to cutoff <b style="margin-left:auto;padding-left:10px;">${counts.near}</b></div>` : '')
            + '<div style="color:#789;margin-top:4px;">Hover a battery for the distance · everything is click-through</div>';
        document.body.appendChild(el);
        el.querySelector('[data-rng-x]').onclick = () => { rng.on = false; rngClear(); const b = document.querySelector('[data-rng-toggle]'); if (b) b.classList.remove('active'); };
        rng.legendEl = el;
    }
    async function rngToggle(btn) {
        if (rng.on) { rng.on = false; rngClear(); if (btn) btn.classList.remove('active'); return; }
        if (rng.busy) return;
        const sid = getCurrentSiteID();
        if (!sid) { showToast('No site loaded.', '#ff5252', 3000); return; }
        rng.busy = true;
        showToast('🔋 Range check — building legal-route graph (double + triple checking)…', '#7adfe6', 3000);
        try {
            const ent = await genFetchEntities(sid);
            const sol = rngSolve(ent);
            rngClear();
            rngDraw(sol);
            rng.on = true;
            if (btn) btn.classList.add('active');
            showToast('🔋 Range overlay ON — colors are triple-verified shortest LEGAL routes. M2 picking still works.', '#5fff5f', 4500);
        } catch (e) {
            console.warn(`${TAG} [range] failed`, e);
            showToast('Range check failed (see console).', '#ff5252', 4000);
        }
        rng.busy = false;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 🖊 LASSO (v2.27) — freehand-draw a loop around pads to build a merge.
    // Everything inside the loop is matched to its mission (pad name = mission
    // name, same ladder as M2 picking), ordered FURTHEST→CLOSEST using the
    // 🔋 Range solver's triple-verified legal-route distances, and — when the
    // loop contains Tulip pads — auto-split into "X 1" (Tattu pads only) and
    // "X 2" (everything), Tulips removed from 1 and kept in 2. Each variant
    // stages into the pad-click merge editor (numbered badges) for inspection
    // before Create. Drawing is a one-shot pen: press 🖊, drag a loop, done.
    // ════════════════════════════════════════════════════════════════════════
    const lasso = { armed: false, drawing: false, pts: [], line: null, data: null, handlers: null, resultEl: null, resultLayers: [] };
    function lassoCleanupDraw() {
        const map = getLeafletMap();
        try { if (map && map.dragging && lasso.dragWasEnabled) map.dragging.enable(); } catch (e) {}
        if (lasso.handlers) {
            const { c, down, move, up, key } = lasso.handlers;
            try { c.removeEventListener('pointerdown', down, true); c.removeEventListener('pointermove', move, true); c.removeEventListener('pointerup', up, true); } catch (e) {}
            try { document.removeEventListener('keydown', key, true); } catch (e) {}
            try { c.style.cursor = ''; } catch (e) {}
            lasso.handlers = null;
        }
        if (lasso.line) { try { lasso.line.remove(); } catch (e) {} lasso.line = null; }
        lasso.armed = false; lasso.drawing = false; lasso.pts = [];
        const b = document.querySelector('[data-lasso-toggle]');
        if (b) b.classList.remove('active');
    }
    function lassoCloseResults() {
        if (lasso.resultEl) { try { lasso.resultEl.remove(); } catch (e) {} lasso.resultEl = null; }
        lasso.resultLayers.forEach(l => { try { l.remove(); } catch (e) {} });
        lasso.resultLayers = [];
    }
    async function lassoToggle(btn) {
        if (lasso.armed) { lassoCleanupDraw(); showToast('🖊 Lasso cancelled.', '#888', 2000); return; }
        const sid = getCurrentSiteID();
        if (!sid) { showToast('No site loaded.', '#ff5252', 3000); return; }
        const map = getLeafletMap();
        const L = composerGetL();
        if (!map || !L || typeof map.mouseEventToLatLng !== 'function') { showToast('Lasso: map not found.', '#ff5252', 3000); return; }
        showToast('🖊 Lasso — loading pads, missions + verified ranges…', '#7adfe6', 2500);
        let ent, missions, sol;
        try {
            [ent, missions] = await Promise.all([genFetchEntities(sid), new Promise((res, rej) => fetchMissions(sid, res, rej))]);
            sol = rngSolve(ent);   // the trusted router — same engine as 🔋
        } catch (e) {
            console.warn(`${TAG} [lasso] load failed`, e);
            showToast('Lasso: failed to load site data (see console).', '#ff5252', 4000);
            return;
        }
        lasso.data = { ent, missions, byAsset: new Map(sol.results.map(r => [r.asset.id, r])) };
        const c = map.getContainer();
        lasso.dragWasEnabled = !!(map.dragging && map.dragging.enabled && map.dragging.enabled());
        try { if (map.dragging) map.dragging.disable(); } catch (e) {}
        c.style.cursor = 'crosshair';
        const down = (ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault(); ev.stopPropagation();
            lasso.drawing = true;
            lasso.pts = [map.mouseEventToLatLng(ev)];
            try { lasso.line = L.polyline(lasso.pts, { color: '#7adfe6', weight: 3, dashArray: '4 6', opacity: 0.95, interactive: false }).addTo(map); } catch (e) {}
        };
        const move = (ev) => {
            if (!lasso.drawing) return;
            ev.preventDefault(); ev.stopPropagation();
            let ll;
            try { ll = map.mouseEventToLatLng(ev); } catch (e) { return; }
            const prev = lasso.pts[lasso.pts.length - 1];
            if (prev && mbApproxMeters(prev.lat, prev.lng, ll.lat, ll.lng) < 3) return;
            lasso.pts.push(ll);
            if (lasso.line) lasso.line.setLatLngs(lasso.pts);
        };
        const up = (ev) => {
            if (!lasso.drawing) return;
            ev.preventDefault(); ev.stopPropagation();
            const ring = lasso.pts.map(p => ({ lat: p.lat, lng: p.lng }));
            lassoCleanupDraw();
            if (ring.length < 8) { showToast('🖊 Loop too small — draw a bigger circle around the pads.', '#ff9800', 3500); return; }
            lassoProcess(ring);
        };
        const key = (ev) => { if (ev.key === 'Escape') { lassoCleanupDraw(); showToast('🖊 Lasso cancelled.', '#888', 2000); } };
        c.addEventListener('pointerdown', down, true);
        c.addEventListener('pointermove', move, true);
        c.addEventListener('pointerup', up, true);
        document.addEventListener('keydown', key, true);
        lasso.handlers = { c, down, move, up, key };
        lasso.armed = true;
        if (btn) btn.classList.add('active');
        showToast('🖊 Draw a loop around the pads you want merged (Esc cancels).', '#5fff5f', 5000);
    }
    function lassoWindName(rows, base) {
        if (!base || !rows.length) return 'Lasso';
        let sx = 0, sy = 0;
        rows.forEach(r => {
            const ctr = genCentroid(r.asset.ring);
            const dLat = ctr.lat - base.lat, dLng = (ctr.lng - base.lng) * Math.cos(base.lat * Math.PI / 180);
            const h = Math.hypot(dLat, dLng) || 1;
            sy += dLat / h; sx += dLng / h;
        });
        let compass = 90 - Math.atan2(sy, sx) * 180 / Math.PI;
        compass = ((compass % 360) + 360) % 360;
        return AG_WINDS[Math.round(compass / 22.5) % 16];
    }
    // Trusted pairwise distances for the lassoed pads (v2.30): every pad
    // attaches to the Range legal-route graph at its first NAV point (reusing
    // the 👁 preview's mpvAttachPoint), then one Dijkstra per pad gives
    // pad↔pad and pad↔base along REAL legal routes. Off-graph pairs fall back
    // straight-line ×1.25 and are counted + logged.
    function lassoBuildPairwise(rows, ent, byAsset) {
        try {
            const built = rngBuildGraph(ent, false);
            const link = (ka, kb, w) => { built.graph.adj.get(ka).push({ to: kb, w }); built.graph.adj.get(kb).push({ to: ka, w }); };
            // v2.33: anchor each pad to its OWN FFZ's ring vertices (the fi the
            // verified solver assigned it) — real missions put navs inside the
            // FFZ, but this stays connected regardless of nav placement (nav-
            // at-centroid pads attached to NOTHING and every distance fell
            // back to straight-line, which is what scrambled the ordering).
            const padKeys = rows.map((r, i) => {
                const navs = mbSoloPoints(r.mission);
                const p = navs.length ? navs[0] : genCentroid(r.asset.ring);
                const k = `lp:${i}`;
                built.graph.verts.set(k, { lat: p.lat, lng: p.lng });
                built.graph.adj.set(k, []);
                let linked = 0;
                const res = byAsset ? byAsset.get(r.asset.id) : null;
                if (res && res.fi >= 0 && built.ffzs[res.fi]) {
                    built.ffzs[res.fi].ring.forEach((rp, ri) => {
                        const rk = `r:${res.fi}:${ri}`;
                        if (!built.graph.adj.has(rk)) return;
                        link(k, rk, mbApproxMeters(p.lat, p.lng, rp.lat, rp.lng));
                        linked++;
                    });
                }
                if (!linked) {
                    const arc = agNearestArcPoint(built.graph, r.asset.ring || [p], MB_REACH_FFZ_FT / 3.28084);
                    if (arc) {
                        const xk = `lpx:${i}`;
                        built.graph.verts.set(xk, arc.p);
                        built.graph.adj.set(xk, []);
                        link(xk, arc.ka, arc.w * arc.t);
                        link(xk, arc.kb, arc.w * (1 - arc.t));
                        link(k, xk, Math.max(1, arc.d));
                        linked++;
                    }
                }
                if (!linked) console.warn(`${TAG} [lasso] pad "${r.asset.name}" could not attach to the route graph — its legs estimate straight-line`);
                return k;
            });
            const runs = padKeys.map(k => agDijkstra(built.graph, k));
            let off = 0;
            const straightPts = rows.map(r => genCentroid(r.asset.ring));
            const dPad = (i, j) => {
                if (i === j) return 0;
                const d = runs[i].dist.get(padKeys[j]);
                if (d == null) { off++; return mbApproxMeters(straightPts[i].lat, straightPts[i].lng, straightPts[j].lat, straightPts[j].lng) * 3.28084 * 1.25; }
                return d * 3.28084;
            };
            const dBase = (i) => {
                let best = null;
                built.baseKeys.forEach(bk => { const d = runs[i].dist.get(bk); if (d != null && (best == null || d < best)) best = d; });
                if (best == null) { off++; return rows[i].ft; }   // solver's verified worst-corner as fallback
                return best * 3.28084;
            };
            const cfg = agCfg();
            const costOf = (i) => agIntraFt(rows[i].mission) + pcmStepCount(rows[i].mission) * cfg.stepCostFt;
            const idxOf = new Map(rows.map((r, i) => [r, i]));
            return { ok: true, rows, idxOf, dPad, dBase, costOf, offCount: () => off };
        } catch (e) {
            console.warn(`${TAG} [lasso] pairwise graph failed — furthest→closest fallback`, e);
            return { ok: false };
        }
    }
    // Order a subset: 2-opt scored by the flight simulator on trusted
    // distances (a pad that forces an RTB shouldn't drag the route back over
    // ground it already covered — pure furthest→closest zigzagged, live test).
    // SPUR-WALK ORDER (v2.36) — decoded from the user's hand-corrected order
    // ("this is how I updated, but I'm just eyeballing it"): fly to the
    // DEEPEST pad of an area first, peel back toward base along its corridor
    // (never stepping to a deeper pad), and when the nearest continuation
    // would cost more than a fresh out-leg from base, JUMP to the deepest
    // remaining pad — the next area. Deterministic, auditable, and matches
    // the far→near SOP per area. The simulator then adds the part eyeballing
    // can't: battery breaks, landing reserves, real route distances.
    // (2-opt was rejected live twice: transit-cheaper LOOP shapes read as
    // chaos and give deep pads a half-drained battery.)
    function lassoOrderRows(subset, budgetFt, pw) {
        const rowsD = subset.slice().sort((x, y) => y.ft - x.ft);
        try {
            if (!(pw && pw.ok) || rowsD.length < 2) return { rows: rowsD, sim: null };
            const remaining = new Set(rowsD.map(r => pw.idxOf.get(r)));
            const ftOf = i => pw.rows[i].ft;
            const order = [];
            let cur = null, guard = 0;
            while (remaining.size && guard++ < 5000) {
                if (cur == null) {
                    // new area → deepest remaining pad
                    let deep = null;
                    remaining.forEach(i => { if (deep == null || ftOf(i) > ftOf(deep)) deep = i; });
                    cur = deep;
                } else {
                    // continue the area: nearest remaining pad that is NOT
                    // deeper than where we are (±500 ft tolerance)
                    let best = null;
                    remaining.forEach(i => {
                        if (ftOf(i) > ftOf(cur) + 500) return;
                        const d = pw.dPad(cur, i);
                        if (!best || d < best.d) best = { i, d };
                    });
                    // area exhausted (or continuing costs more than a fresh
                    // out-leg from base) → jump to the next area's deepest
                    if (!best || best.d > pw.dBase(best.i)) { cur = null; continue; }
                    cur = best.i;
                }
                order.push(cur);
                remaining.delete(cur);
            }
            remaining.forEach(i => order.push(i));   // guard-overflow safety
            const sim = agSimulate(order, pw.dPad, pw.dBase, pw.costOf, budgetFt);
            return { rows: order.map(i => pw.rows[i]), sim };
        } catch (e) {
            console.warn(`${TAG} [lasso] spur-walk failed — plain furthest→closest`, e);
            return { rows: rowsD, sim: null };
        }
    }
    function lassoProcess(ring) {
        const { ent, missions, byAsset } = lasso.data || {};
        if (!ent) return;
        const cfg = agCfg();
        // v2.33: a pad counts as inside when its centroid OR any corner is in
        // the loop (edge pads were dropping out of tight lassos).
        const inLoop = (a) => genPointInPoly(genCentroid(a.ring), ring) || a.ring.some(p => genPointInPoly(p, ring));
        const inside = (ent.assets || []).filter(a => a.ring && a.ring.length >= 3 && inLoop(a));
        if (!inside.length) { showToast('🖊 No pads inside the loop.', '#ff9800', 3500); return; }
        const rows = [], skipped = [];
        const skip = (a, reason) => skipped.push({ name: a.name, reason, pt: genCentroid(a.ring) });
        inside.forEach(a => {
            const cands = rankMatchMissions(a.name, missions);
            if (!cands.length) { skip(a, 'no mission with this name'); return; }
            if (cands.length > 1) { skip(a, `${cands.length} mission matches (add it via M2)`); return; }
            const r = byAsset.get(a.id);
            if (!r || r.status !== 'ok') { skip(a, r ? (r.status === 'no-ffz' ? 'no FFZ' : 'no legal route') : 'no range data'); return; }
            if (!r.verified || r.disagree) { skip(a, 'range unverified (see console)'); return; }
            if (r.worstFt > cfg.tulipRadiusFt) { skip(a, `over ${(cfg.tulipRadiusFt / 1000).toFixed(0)}k ft`); return; }
            rows.push({ asset: a, mission: cands[0], ft: r.worstFt, tulip: r.worstFt > cfg.tattuRadiusFt });
        });
        // Pre-order = bearing sweep around base with the seam at the largest
        // angular gap — the human "walk the loop" order. It feeds the
        // optimizer as a seed AND is the tie-break when the simulator sees
        // every order as ~equal (v2.33).
        if (ent.base && rows.length > 2) {
            const bear = r => { const c = genCentroid(r.asset.ring); const d = 90 - Math.atan2(c.lat - ent.base.lat, (c.lng - ent.base.lng) * Math.cos(ent.base.lat * Math.PI / 180)) * 180 / Math.PI; return ((d % 360) + 360) % 360; };
            const wb = rows.map(r => ({ r, b: bear(r) })).sort((a, b) => a.b - b.b);
            let gapAt = 0, gapMax = -1;
            for (let i = 0; i < wb.length; i++) { const nb = wb[(i + 1) % wb.length].b + ((i + 1) >= wb.length ? 360 : 0); const g = nb - wb[i].b; if (g > gapMax) { gapMax = g; gapAt = (i + 1) % wb.length; } }
            const swept = wb.slice(gapAt).concat(wb.slice(0, gapAt)).map(x => x.r);
            rows.length = 0;
            swept.forEach(r => rows.push(r));
        } else {
            rows.sort((x, y) => y.ft - x.ft);
        }
        const wind = lassoWindName(rows, ent.base);
        const tattu = rows.filter(r => !r.tulip);
        const tulips = rows.filter(r => r.tulip);
        const pw = rows.length > 1 ? lassoBuildPairwise(rows, ent, byAsset) : null;
        const variants = [];
        // Tulip pads present → auto-split: "1" = Tattu only, "2" = everything.
        // Each variant's order = 2-opt + flight simulator on trusted distances.
        const mkVariant = (name, subPrefix, set, budgetFt) => {
            const o = lassoOrderRows(set, budgetFt, pw);
            variants.push({ name, sub: `${subPrefix} · ${set.length} pads · deep-first spur walk, verified routes`, rows: o.rows, sim: o.sim });
        };
        if (tulips.length && tattu.length) {
            mkVariant(`${wind} 1`, 'Tattu only', tattu, cfg.tattuBudgetFt);
            mkVariant(`${wind} 2`, 'Tattu + Tulip', rows, cfg.tulipBudgetFt);
        } else if (tulips.length) {
            mkVariant(`${wind} 2`, 'Tulip', rows, cfg.tulipBudgetFt);
        } else if (rows.length) {
            mkVariant(`${wind} 1-2`, 'either battery', rows, cfg.tattuBudgetFt);
        }
        const offN = (pw && pw.ok) ? pw.offCount() : 0;
        if (offN) console.warn(`${TAG} [lasso] ${offN} pad-pair legs estimated off-graph (straight ×1.25)`);
        if (!variants.length) { showToast(`🖊 ${inside.length} pads in loop, none usable — ${skipped.length} skipped (see the popup).`, '#ff9800', 4500); }
        lassoShowResults(variants, skipped, missions, ent, offN);
        console.log(`${TAG} [lasso] ${inside.length} pads in loop → ${rows.length} usable (${tulips.length} Tulip) · ${skipped.length} skipped`);
    }
    function lassoShowResults(variants, skipped, missions, ent, offN) {
        lassoCloseResults();
        // Red ✕ on every skipped pad — a pad inside the loop with no number
        // must explain itself on the map, not just in the list (v2.33).
        const Lx = composerGetL(), mapx = getLeafletMap();
        if (Lx && mapx) {
            skipped.forEach(s => {
                if (!s || !s.pt) return;
                try {
                    lasso.resultLayers.push(Lx.marker([s.pt.lat, s.pt.lng], {
                        icon: Lx.divIcon({ className: 'aim-mb-rng-chip', html: '<div style="pointer-events:none;font:800 17px sans-serif;color:#ff5252;text-shadow:0 1px 3px #000,0 0 6px #000;">✕</div>', iconSize: [0, 0], iconAnchor: [6, 9] }),
                        interactive: false, keyboard: false, zIndexOffset: 900,
                    }).addTo(mapx));
                } catch (e) {}
            });
        }
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;right:24px;bottom:20px;width:330px;max-height:60vh;overflow:auto;z-index:2147483601;'
            + 'background:#161a20;border:1px solid #7adfe6;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.7);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;padding:10px 12px;';
        const vBtn = (v, i) => {
            // 🔋 dividers between flights — a jump on the map between
            // consecutive numbers usually IS a recharge boundary; make it
            // visible so the order stops looking "crazy" (v2.35).
            const breaks = new Set();
            if (v.sim && v.sim.flights.length > 1) { let acc = 0; v.sim.flights.slice(0, -1).forEach(f => { acc += f.pads.length; breaks.add(acc - 1); }); }
            const simLine = v.sim
                ? `<div style="color:#9ad;font-size:10px;margin-top:2px;">est <b style="color:#cde;">${(v.sim.totalFt / 1000).toFixed(1)}k ft</b> · 🔋 ${v.sim.flights.length} flight${v.sim.flights.length === 1 ? '' : 's'} · land ${v.sim.flights.map(f => f.reservePct + '%').join(' / ')}</div>`
                : '';
            return `<div style="margin:5px 0;padding:6px 8px;border:1px solid #2a3a2a;border-radius:6px;">
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="flex:1;font-weight:800;color:#7dff7d;">⛟ ${escapeHtml(v.name)}</span>
                <button data-lasso-stage="${i}" style="padding:3px 10px;background:#5fff5f;border:none;color:#04220a;border-radius:5px;cursor:pointer;font-weight:800;font-size:11px;">🔗 Stage</button>
            </div>
            <div style="color:#9ad;font-size:10px;margin-top:2px;">${escapeHtml(v.sub)}</div>
            ${simLine}
            <div style="color:#789;font-size:10px;margin-top:3px;max-height:130px;overflow:auto;">${v.rows.map((r, n) => `<div>${n + 1}. ${escapeHtml(r.mission.name)} <span style="color:#567;">${(r.ft / 1000).toFixed(1)}k${r.tulip ? ' · Tulip' : ''}</span></div>` + (breaks.has(n) ? '<div style="text-align:center;color:#ffb74d;font-size:9px;">— 🔋 return &amp; recharge —</div>' : '')).join('')}</div>
        </div>`;
        };
        el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:5px;">
                <b style="color:#7adfe6;">🖊 Lasso result</b>
                <span data-lasso-close style="margin-left:auto;cursor:pointer;color:#888;font-weight:800;">✕</span>
            </div>
            ${variants.map(vBtn).join('') || '<div style="color:#888;font-size:11px;">No stageable missions.</div>'}
            ${offN ? `<div style="margin-top:5px;color:#ffb74d;font-size:10px;">⚠ ${offN} pad-pair leg(s) estimated off-graph — order may be imperfect (see console)</div>` : ''}
            ${skipped.length ? `<div style="margin-top:6px;color:#ff9800;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;">Skipped (${skipped.length}) — marked ✕ on the map</div>${skipped.map(s => `<div style="color:#caa;font-size:10px;">${escapeHtml(s.name)} — ${escapeHtml(s.reason)}</div>`).join('')}` : ''}
            <div style="color:#789;font-size:10px;margin-top:6px;">Stage a variant → inspect the numbered badges → 🔗 Create. Panel stays open so you can stage the other one after.</div>`;
        document.body.appendChild(el);
        el.querySelector('[data-lasso-close]').onclick = lassoCloseResults;
        el.querySelectorAll('[data-lasso-stage]').forEach(b => b.onclick = () => {
            const v = variants[Number(b.getAttribute('data-lasso-stage'))];
            if (!v) return;
            agStageInPcm({ name: v.name, solos: v.rows.map(r => ({ mission: r.mission, pt: genCentroid(r.asset.ring) })) }, missions, ent);
        });
        lasso.resultEl = el;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 🧩 MACRO COVERAGE (v2.37) — visually see which pads are already claimed
    // by macro (merged) missions. Detection is DATA-DERIVED, not recipe-based:
    // any mission whose located steps touch ≥ 2 distinct pads is a macro, so
    // it works no matter who created the merge or how. Each macro gets a
    // color; member pads get that outline + a name chip; the legend counts
    // pads that still aren't in any macro. All click-through.
    // ════════════════════════════════════════════════════════════════════════
    // hidden = per-session visibility filter (v2.47) — mission ids whose map
    // layers are currently switched off in the legend; resets to all-visible
    // every fresh 🧩 toggle-on. macroLayers groups layers per mission id so a
    // single macro can be hidden/shown without a full redraw.
    const mcv = { on: false, busy: false, layers: [], legendEl: null, hidden: new Set(), macroLayers: new Map() };
    function mcvClear() {
        mcv.layers.forEach(l => { try { l.remove(); } catch (e) {} });
        mcv.layers = [];
        mcv.macroLayers = new Map();
        try { mcvClearRoutes(); } catch (e) {}
        if (mcv.legendEl) { try { mcv.legendEl.remove(); } catch (e) {} mcv.legendEl = null; }
    }
    // mission → distinct pads its located steps touch (inside or ≤150 ft of
    // an asset ring; bbox-prefiltered)
    function mcvDetect(ent, missions) {
        const assets = (ent.assets || []).filter(a => a.ring && a.ring.length >= 3);
        const tolM = 46;   // 150 ft
        const boxes = assets.map(a => agRingBbox(a.ring, tolM + 5));
        const macros = [];
        const covered = new Set();
        const missionPads = new Map();
        (missions || []).forEach(m => {
            const padIds = new Set(), pads = [];
            // v2.40: also build the mission's BLOCK structure — contiguous runs
            // of steps per pad, in flight order. Unlocated steps (waits/camera)
            // and off-pad transit navs travel with the pad they follow; steps
            // before the first pad go in a leading null-block. Blocks are what
            // ♻ reorder resequences (each pad's own steps stay intact).
            const blocks = [];
            let curPad;   // undefined until the first pad assignment
            (m.instructions || []).forEach(i => {
                if (!i || i.type === 0 || i.type === 99) return;
                if (i.location && typeof i.location.lat === 'number') {
                    const p = i.location;
                    let best = null;
                    for (let ai = 0; ai < assets.length; ai++) {
                        const bb = boxes[ai];
                        if (p.lat < bb.s || p.lat > bb.n || p.lng < bb.w || p.lng > bb.e) continue;
                        const d = mbPointToPolygonMeters(p.lat, p.lng, assets[ai].ring);
                        if (d <= tolM && (!best || d < best.d)) best = { a: assets[ai], d };
                    }
                    if (best) {
                        curPad = best.a.id;
                        if (!padIds.has(best.a.id)) { padIds.add(best.a.id); pads.push(best.a); }
                    }
                }
                const aId = (curPad === undefined) ? null : curPad;
                if (!blocks.length || blocks[blocks.length - 1].aId !== aId) blocks.push({ aId, steps: [] });
                blocks[blocks.length - 1].steps.push(i);
            });
            if (pads.length) missionPads.set(m.id, pads);
            if (pads.length >= 2) {
                macros.push({ mission: m, pads, blocks });
                pads.forEach(a => covered.add(a.id));
            }
        });
        // pads that have SOME mission on them but no macro yet
        const touched = new Set();
        missionPads.forEach(pads => pads.forEach(a => touched.add(a.id)));
        const todo = assets.filter(a => touched.has(a.id) && !covered.has(a.id));
        return { macros, covered, todo, touched, assets, padCount: assets.length };
    }
    function mcvDraw(det) {
        const L = composerGetL(), map = getLeafletMap();
        if (!L || !map) { showToast('Macros: map not found.', '#ff9800', 3000); return; }
        const COLORS = ['#7adfe6', '#ffd54f', '#ff8ad2', '#9dff8a', '#c39dff', '#ffab73', '#8ab6ff', '#f3ff7a', '#ff9e9e', '#7affc9'];
        det.macros.forEach((mc, i) => {
            const col = COLORS[i % COLORS.length];
            // v2.47: layers grouped per macro so the legend can hide/show one
            // macro without a redraw. Hidden macros' layers are built but NOT
            // added to the map (mcvSetVis adds them on unhide).
            const vis = !mcv.hidden.has(mc.mission.id);
            const lys = [];
            const keep = (l) => { mcv.layers.push(l); lys.push(l); if (vis) l.addTo(map); return l; };
            let deepest = null;
            mc.pads.forEach((a, pi) => {
                try {
                    // SOLID fill (v2.38) — covered pads read as painted, so the
                    // eye only hunts for UNfilled pads (the remaining work)
                    keep(L.polygon(a.ring.map(p => [p.lat, p.lng]), { color: col, weight: 3, opacity: 0.95, fill: true, fillColor: col, fillOpacity: 0.55, interactive: false }));
                    // v2.43: visit-order number on every covered pad, in the
                    // macro's color. Pads shared by two macros get side-by-side
                    // badges (x-offset per macro index). Click-through.
                    const c2 = genCentroid(a.ring);
                    keep(L.marker([c2.lat, c2.lng], {
                        icon: L.divIcon({
                            className: 'aim-mb-rng-chip',
                            html: `<div style="pointer-events:none;width:19px;height:19px;border-radius:50%;background:${col};color:#10131a;font:800 11px/19px monospace;text-align:center;border:1.5px solid #10131a;box-shadow:0 1px 4px rgba(0,0,0,0.7);">${pi + 1}</div>`,
                            iconSize: [19, 19], iconAnchor: [10 - (i % 3) * 14, 10],
                        }),
                        interactive: false, keyboard: false, zIndexOffset: -300,
                    }));
                } catch (e) {}
                if (!deepest) deepest = a;   // first pad = mission's first stop
            });
            if (deepest) {
                const c = genCentroid(deepest.ring);
                try {
                    keep(L.marker([c.lat, c.lng], {
                        icon: L.divIcon({
                            className: 'aim-mb-rng-chip',
                            html: `<div style="pointer-events:none;background:${col};color:#10131a;font:800 11px/1 'Lato',sans-serif;padding:3px 7px;border-radius:4px;border:1.5px solid #10131a;box-shadow:0 1px 5px rgba(0,0,0,0.7);white-space:nowrap;">${escapeHtml(String(mc.mission.name || '').slice(0, 24))}</div>`,
                            iconSize: [0, 0], iconAnchor: [0, 22],
                        }),
                        interactive: false, keyboard: false, zIndexOffset: -400,
                    }));
                } catch (e) {}
            }
            mcv.macroLayers.set(mc.mission.id, lys);
        });
        // legend (top-left, under the toolbar)
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:12px;top:70px;z-index:2147483599;max-height:50vh;overflow:auto;background:rgba(16,19,26,0.92);border:1px solid #2a3340;border-radius:8px;padding:8px 11px;color:#e6e6e6;font:11px "Lato","Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.6);';
        const COLORS2 = ['#7adfe6', '#ffd54f', '#ff8ad2', '#9dff8a', '#c39dff', '#ffab73', '#8ab6ff', '#f3ff7a', '#ff9e9e', '#7affc9'];
        el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><b style="color:#7adfe6;">🧩 Macro coverage</b><button data-mcv-report title="Copy the coverage report (Name / Classification / Captured / Battery / Section / Mission / Order) — colored cells, paste into Google Sheets" style="padding:1px 7px;background:rgba(122,223,230,0.14);border:1px solid rgba(122,223,230,0.5);color:#7adfe6;border-radius:4px;cursor:pointer;font-size:10px;">📋 Report</button><button data-mcv-vis-all title="Show every macro on the map" style="padding:1px 6px;background:rgba(122,223,230,0.14);border:1px solid rgba(122,223,230,0.5);color:#7adfe6;border-radius:4px;cursor:pointer;font-size:10px;">All</button><button data-mcv-vis-none title="Hide every macro — then re-check just the ones you want" style="padding:1px 6px;background:rgba(122,223,230,0.14);border:1px solid rgba(122,223,230,0.5);color:#7adfe6;border-radius:4px;cursor:pointer;font-size:10px;">None</button><span data-mcv-x style="margin-left:auto;cursor:pointer;color:#888;font-weight:800;">✕</span></div>`
            + (det.macros.length
                ? det.macros.map((mc, i) => {
                    const au = (mcv.data && mcv.data.audits) ? mcv.data.audits.get(mc.mission.id) : null;
                    let auditLine = '';
                    let reBtn = '';
                    if (au && au.cur && au.re) {
                        const c = au.calib;
                        const curFl = c ? c.curFl : au.cur.flights.length;
                        const reFl = c ? c.reFl : au.re.flights.length;
                        const curFt = c && c.curDistM ? c.curDistM * 3.28084 : au.cur.totalFt;
                        const reFt = c && c.reDistM ? c.reDistM * 3.28084 : au.re.totalFt;
                        const dFl = curFl - reFl;
                        const dPct = au.cur.totalFt > 0 ? Math.round((au.cur.totalFt - au.re.totalFt) / au.cur.totalFt * 100) : 0;
                        const days = mcvDays(curFl).days;
                        const worth = dFl >= 1 || dPct >= 10;
                        auditLine = `<div title="${c ? 'Percepto-calibrated: absolutes from the mission\'s own battery/distance estimate; only the current↔replan ratio comes from the route simulator' : 'Simulator estimate (no Percepto battery data on this mission)'}" style="margin:0 0 3px 16px;font-size:10px;color:${worth ? '#ffb74d' : '#789'};">`
                            + `${(curFt / 1000).toFixed(0)}k ft · ${curFl} fl · ~${days.toFixed(1)}d${c ? '' : ' <span style="color:#567;">(sim)</span>'}`
                            + (worth ? ` → ♻ ${(reFt / 1000).toFixed(0)}k · ${reFl} fl (−${dFl} fl, −${dPct}%)` : ' · ✓ near-optimal')
                            + `${au.unknown ? ` · ⚠${au.unknown} unranged` : ''}</div>`;
                        if (worth) reBtn = `<button data-mcv-reorder="${mc.mission.id}" title="Re-order this mission's pad blocks in place (backup + verify; steps untouched)" style="padding:0 5px;background:rgba(255,183,77,0.15);border:1px solid rgba(255,183,77,0.5);color:#ffb74d;border-radius:4px;cursor:pointer;font-size:10px;">♻</button>`;
                        reBtn += `<button data-mcv-route="${mc.mission.id}" data-mcv-route-col="${COLORS2[i % COLORS2.length]}" title="Draw this macro's CURRENT route (solid) vs the ♻ replan route (dashed white) on the map" style="padding:0 5px;background:rgba(122,223,230,0.12);border:1px solid rgba(122,223,230,0.4);color:#7adfe6;border-radius:4px;cursor:pointer;font-size:10px;">👁</button>`;
                    }
                    // v2.47: per-macro visibility — checkbox toggles this macro's
                    // map layers; clicking the color swatch SOLOs it (hide all
                    // others; click again to bring everything back).
                    const vis = !mcv.hidden.has(mc.mission.id);
                    if (auditLine) auditLine = auditLine.replace('<div ', `<div data-mcv-au="${mc.mission.id}" `);
                    return `<div data-mcv-row="${mc.mission.id}" style="display:flex;align-items:center;gap:6px;margin:2px 0;opacity:${vis ? 1 : 0.38};"><input type="checkbox" data-mcv-vis="${mc.mission.id}" ${vis ? 'checked' : ''} title="Show/hide this macro on the map" style="margin:0;cursor:pointer;accent-color:${COLORS2[i % COLORS2.length]};"><span data-mcv-solo="${mc.mission.id}" title="Solo — show ONLY this macro (click again to show all)" style="width:10px;height:10px;border-radius:2px;background:${COLORS2[i % COLORS2.length]};flex:none;cursor:pointer;"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px;">${escapeHtml(String(mc.mission.name || ''))}</span>${reBtn}<b style="margin-left:auto;padding-left:8px;">${mc.pads.length}</b></div>${auditLine ? auditLine.replace('style="', `style="opacity:${vis ? 1 : 0.38};`) : ''}`;
                }).join('')
                : '<div style="color:#888;">No macro missions yet (≥2 pads in one mission).</div>')
            + `<div style="color:#ffb74d;margin-top:5px;">⬜ ${det.todo.length} pad(s) with missions, not in any macro</div>`
            + (() => { const t = mcvTimeCfg(); const perDay = mcvDays(1).perDay; return `<div style="display:flex;gap:5px;align-items:center;margin-top:5px;font-size:10px;color:#9ad;flex-wrap:wrap;">`
                + `flight <input data-mcv-t="flightMin" type="number" value="${t.flightMin}" style="width:34px;background:#0e1218;color:#e6e6e6;border:1px solid #2a3340;border-radius:3px;font-size:10px;">m`
                + ` charge <input data-mcv-t="chargeMin" type="number" value="${t.chargeMin}" style="width:38px;background:#0e1218;color:#e6e6e6;border:1px solid #2a3340;border-radius:3px;font-size:10px;">m`
                + ` ops <input data-mcv-t="opsHrs" type="number" value="${t.opsHrs}" style="width:30px;background:#0e1218;color:#e6e6e6;border:1px solid #2a3340;border-radius:3px;font-size:10px;">h/d`
                + ` <span style="color:#789;">≈${perDay} fl/day</span></div>`; })()
            + '<div style="color:#789;margin-top:3px;">Filled = covered · UNfilled = still to do · click-through</div>';
        document.body.appendChild(el);
        el.querySelector('[data-mcv-x]').onclick = () => { mcv.on = false; mcvClear(); const b = document.querySelector('[data-mcv-toggle]'); if (b) b.classList.remove('active'); };
        el.querySelector('[data-mcv-report]').onclick = () => mcvReport();
        el.querySelectorAll('[data-mcv-reorder]').forEach(b => b.onclick = () => mcvReorder(Number(b.getAttribute('data-mcv-reorder')) || b.getAttribute('data-mcv-reorder')));
        el.querySelectorAll('[data-mcv-route]').forEach(b => b.onclick = () => {
            const id = Number(b.getAttribute('data-mcv-route')) || b.getAttribute('data-mcv-route');
            const on = mcvToggleRoute(id, b.getAttribute('data-mcv-route-col'));
            b.style.background = on ? 'rgba(122,223,230,0.4)' : 'rgba(122,223,230,0.12)';
        });
        // v2.47: per-macro show/hide + solo + All/None
        el.querySelectorAll('input[data-mcv-vis]').forEach(cb => cb.onchange = () => {
            const id = Number(cb.getAttribute('data-mcv-vis')) || cb.getAttribute('data-mcv-vis');
            mcvSetVis(id, cb.checked);
        });
        el.querySelectorAll('[data-mcv-solo]').forEach(sw => sw.onclick = () => {
            const id = Number(sw.getAttribute('data-mcv-solo')) || sw.getAttribute('data-mcv-solo');
            mcvSolo(id);
        });
        el.querySelector('[data-mcv-vis-all]').onclick = () => mcvAllVis(true);
        el.querySelector('[data-mcv-vis-none]').onclick = () => mcvAllVis(false);
        el.querySelectorAll('[data-mcv-t]').forEach(inp => inp.onchange = () => {
            const patch = {}; patch[inp.getAttribute('data-mcv-t')] = Number(inp.value);
            gmSet(MCV_TIME_KEY, Object.assign({}, mcvTimeCfg(), patch));
            // redraw with the new day math
            if (mcv.data && mcv.data.det) { mcvClear(); mcvDraw(mcv.data.det); }
        });
        mcv.legendEl = el;
        // subtle dashed white outline on not-yet-covered pads — the TODO list
        det.todo.forEach(a => {
            try { mcv.layers.push(L.polygon(a.ring.map(p => [p.lat, p.lng]), { color: '#ffffff', weight: 2, dashArray: '2 6', opacity: 0.65, fill: false, interactive: false }).addTo(map)); } catch (e) {}
        });
    }
    // ── per-macro visibility (v2.47) ────────────────────────────────────────
    // Isolate the macro being worked on: checkbox per legend row, click the
    // color swatch to SOLO, All/None in the header. Session-only — resets to
    // all-visible on every fresh 🧩 toggle-on. Hiding a macro also clears its
    // 👁 route-comparison lines (they'd float context-free otherwise).
    function mcvSetVis(id, visible) {
        const lys = mcv.macroLayers.get(id) || [];
        if (visible) {
            mcv.hidden.delete(id);
            const map = getLeafletMap();
            if (map) lys.forEach(l => { try { l.addTo(map); } catch (e) {} });
        } else {
            mcv.hidden.add(id);
            lys.forEach(l => { try { l.remove(); } catch (e) {} });
            if (mcvRoutes.has(id)) {
                mcvClearRoutes(id);
                const rb = mcv.legendEl && mcv.legendEl.querySelector(`[data-mcv-route="${id}"]`);
                if (rb) rb.style.background = 'rgba(122,223,230,0.12)';
            }
        }
        if (mcv.legendEl) {
            const row = mcv.legendEl.querySelector(`[data-mcv-row="${id}"]`);
            if (row) row.style.opacity = visible ? '1' : '0.38';
            const au = mcv.legendEl.querySelector(`[data-mcv-au="${id}"]`);
            if (au) au.style.opacity = visible ? '1' : '0.38';
            const cb = mcv.legendEl.querySelector(`input[data-mcv-vis="${id}"]`);
            if (cb) cb.checked = visible;
        }
    }
    function mcvAllVis(visible) {
        const det = mcv.data && mcv.data.det;
        if (det) det.macros.forEach(mc => mcvSetVis(mc.mission.id, visible));
    }
    function mcvSolo(id) {
        const det = mcv.data && mcv.data.det;
        if (!det) return;
        const others = det.macros.map(mc => mc.mission.id).filter(x => x !== id);
        const alreadySolo = !mcv.hidden.has(id) && others.length > 0 && others.every(x => mcv.hidden.has(x));
        if (alreadySolo) mcvAllVis(true);
        else det.macros.forEach(mc => mcvSetVis(mc.mission.id, mc.mission.id === id));
    }
    // ── ♻ EFFICIENCY AUDIT + REORDER (v2.40) ────────────────────────────────
    // Flight-hours are the SLA currency: ~20-25 min flight + ~80 min recharge
    // means EVERY flight costs ~1¾ h of wall clock, so a 6-flight macro eats
    // an ops day. The audit simulates each macro's CURRENT step order vs the
    // spur-walk replan of the same pads, and converts flights → days via
    // editable time knobs. ♻ then resequences the macro's per-pad step
    // blocks in place (same id + name, backup first, verify after).
    const MCV_TIME_KEY = 'aim-mb-mcv-time';
    function mcvTimeCfg() {
        const d = { flightMin: 22, chargeMin: 80, opsHrs: 8 };
        const s = gmGet(MCV_TIME_KEY, null);
        const o = Object.assign({}, d, (s && typeof s === 'object') ? s : {});
        Object.keys(d).forEach(k => { const v = Number(o[k]); o[k] = (isFinite(v) && v > 0) ? v : d[k]; });
        return o;
    }
    function mcvDays(flights) {
        const t = mcvTimeCfg();
        // last flight of the day needs no recharge after it
        const perDay = Math.max(1, Math.floor((t.opsHrs * 60 + t.chargeMin) / (t.flightMin + t.chargeMin)));
        return { days: flights / perDay, perDay };
    }
    function mcvAudit(det, ent) {
        const t0 = Date.now();
        let sol;
        try { sol = rngSolve(ent); } catch (e) { console.warn(`${TAG} [mcv] audit range solve failed`, e); return new Map(); }
        const byAsset = new Map(sol.results.map(r => [r.asset.id, r]));
        const cfg = agCfg();
        const audits = new Map();
        det.macros.forEach(mc => {
            try {
                const stepsByPad = new Map();
                (mc.blocks || []).forEach(b => {
                    if (b.aId == null) return;
                    if (!stepsByPad.has(b.aId)) stepsByPad.set(b.aId, []);
                    b.steps.forEach(s => stepsByPad.get(b.aId).push(s));
                });
                const rows = [];
                let unknown = 0;
                mc.pads.forEach(a => {
                    const r = byAsset.get(a.id);
                    if (!r || r.status !== 'ok') { unknown++; return; }
                    rows.push({
                        asset: a,
                        mission: { id: `blk:${a.id}`, name: a.name, instructions: stepsByPad.get(a.id) || [] },
                        ft: r.worstFt,
                        tulip: r.worstFt > cfg.tattuRadiusFt,
                    });
                });
                if (rows.length < 2) { audits.set(mc.mission.id, null); return; }
                const budget = rows.some(r => r.tulip) ? cfg.tulipBudgetFt : cfg.tattuBudgetFt;
                const pw = lassoBuildPairwise(rows, ent, byAsset);
                if (!pw || !pw.ok) { audits.set(mc.mission.id, null); return; }
                const cur = agSimulate(rows.map((_, i) => i), pw.dPad, pw.dBase, pw.costOf, budget);
                const re = lassoOrderRows(rows, budget, pw);
                // Percepto calibration (v2.41): our sim runs ~2× hot in absolute
                // terms (energy-ft conflation + conservative budgets + RTB legs)
                // — live cross-check vs the SUM table. So absolutes anchor to
                // PERCEPTO's own per-mission estimates (battery_consumption %,
                // flight_distance) and our sim provides only the RATIO, where
                // systematic model error cancels. Flights via the SUM panel's
                // own estimateFlights thresholds (the ⚙ knob).
                let calib = null;
                // v2.43: the consumption/distance fields live under app_data
                // (same source buildMissionRow uses) — reading the mission root
                // made EVERY macro silently fall back to "(sim)".
                const app = mc.mission.app_data || {};
                const bPct = Number(app.battery_consumption) || null;
                const distM = Number(app.flight_distance) || null;
                if (bPct && re.sim && cur.totalFt > 0) {
                    // v2.42: reorder only shrinks the NAV phase — Wait /
                    // takeoff / landing / extra burn is order-invariant (live
                    // SUM breakdown: West Side 404% = 293% nav + 111% fixed).
                    // The ratio is therefore computed on the sim's NAV-like
                    // energy (legs + intra-pad flying; per-step hover cost
                    // excluded from both sides) and applied to Percepto's
                    // nav_consumption only; the fixed phases carry over.
                    const stepOnly = rows.reduce((t2, r2) => t2 + pcmStepCount(r2.mission) * cfg.stepCostFt, 0);
                    const navCurFt = Math.max(1, cur.totalFt - stepOnly);
                    const navReFt = Math.max(1, re.sim.totalFt - stepOnly);
                    const navRatio = Math.min(2, Math.max(0.1, navReFt / navCurFt));
                    const navB = Number(app.nav_consumption) || null;
                    const fixedB = navB != null ? Math.max(0, bPct - navB) : null;
                    const reB = (navB != null && fixedB != null)
                        ? navB * navRatio + fixedB
                        : bPct * (re.sim.totalFt / cur.totalFt);   // no phase data → whole-ratio fallback
                    calib = {
                        ratio: navRatio,
                        curB: bPct, reB,
                        curFl: estimateFlights(bPct) || cur.flights.length,
                        reFl: estimateFlights(reB) || re.sim.flights.length,
                        curDistM: distM, reDistM: distM ? distM * navRatio : null,
                    };
                }
                audits.set(mc.mission.id, { cur, re: re.sim, reRows: re.rows, unknown, budget, calib });
            } catch (e) {
                console.warn(`${TAG} [mcv] audit failed for "${mc.mission.name}"`, e);
                audits.set(mc.mission.id, null);
            }
        });
        console.log(`${TAG} [mcv] audit: ${det.macros.length} macro(s) in ${Date.now() - t0} ms`);
        return audits;
    }
    // ♻ resequence a macro's per-pad blocks into the replan order, in place.
    let mcvReorderBusy = false;
    async function mcvReorder(missionId) {
        if (mcvReorderBusy) return;
        const data = mcv.data;
        const mc = data && data.det.macros.find(x => x.mission.id === missionId);
        const audit = data && data.audits ? data.audits.get(missionId) : null;
        if (!mc || !audit || !audit.re) { showToast('No replan available for this mission.', '#ff9800', 3000); return; }
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.saveApp !== 'function') { showToast('Mission context not found — be on the Mission Bank page.', '#ff5252', 4500); return; }
        const m = mc.mission;
        const ins = m.instructions || [];
        const to = ins.filter(i => i && i.type === 0).slice(0, 1);
        const rh = ins.filter(i => i && i.type === 99).slice(-1);
        const lead = (mc.blocks[0] && mc.blocks[0].aId == null) ? mc.blocks[0].steps : [];
        const byPad = new Map();
        mc.blocks.forEach(b => {
            if (b.aId == null) return;
            if (!byPad.has(b.aId)) byPad.set(b.aId, []);
            b.steps.forEach(s => byPad.get(b.aId).push(s));
        });
        const orderIds = audit.reRows.map(r => r.asset.id);
        const seen = new Set(orderIds);
        mc.pads.forEach(a => { if (!seen.has(a.id) && byPad.has(a.id)) { orderIds.push(a.id); seen.add(a.id); } });
        const body = lead.slice();
        orderIds.forEach(id => (byPad.get(id) || []).forEach(s => body.push(s)));
        const instrs = to.map(pcmNormStep).concat(body.map(pcmNormStep), rh.map(pcmNormStep));
        // hard sanity: exactly the same steps, only re-sequenced
        const expected = to.length + rh.length + ins.filter(i => i && i.type !== 0 && i.type !== 99).length;
        if (instrs.length !== expected) {
            console.warn(`${TAG} [mcv] reorder ABORT — step count mismatch (${instrs.length} vs ${expected})`, m.name);
            showToast('♻ Aborted: rebuilt step count does not match the original (see console). Nothing saved.', '#ff5252', 6000);
            return;
        }
        const cFl = audit.calib ? audit.calib.curFl : audit.cur.flights.length;
        const rFl = audit.calib ? audit.calib.reFl : audit.re.flights.length;
        const cFt = (audit.calib && audit.calib.curDistM) ? audit.calib.curDistM * 3.28084 : audit.cur.totalFt;
        const rFt = (audit.calib && audit.calib.reDistM) ? audit.calib.reDistM * 3.28084 : audit.re.totalFt;
        const dCur = mcvDays(cFl), dRe = mcvDays(rFl);
        if (!window.confirm(`♻ Re-order "${m.name}" IN PLACE?\n\n`
            + `${cFl} flights (~${dCur.days.toFixed(1)} day(s)) → ${rFl} flights (~${dRe.days.toFixed(1)} day(s))\n`
            + `est ${(cFt / 1000).toFixed(0)}k ft → ${(rFt / 1000).toFixed(0)}k ft${audit.calib ? ' (Percepto-calibrated)' : ''}\n\n`
            + `Each pad's steps stay intact — only the pad ORDER changes. Mission id + name unchanged.\nA JSON backup downloads first.`)) return;
        mcvReorderBusy = true;
        try {
            // backup (same frame-walking download as the wrap tools)
            try {
                const blob = new Blob([JSON.stringify({ site: getCurrentSiteID(), savedAt: new Date().toISOString(), reason: 'pre-reorder', mission: m })], { type: 'application/json' });
                const blobUrl = URL.createObjectURL(blob);
                let downloaded = false;
                for (const doc of [(window.top || window).document, document]) {
                    if (downloaded) break;
                    try {
                        const a = doc.createElement('a');
                        a.href = blobUrl; a.download = `mission${m.id}_prereorder_backup.json`;
                        (doc.body || document.body).appendChild(a); a.click(); a.remove();
                        downloaded = true;
                    } catch (e) {}
                }
                setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 5000);
                if (!downloaded) throw new Error('no frame allowed the download');
            } catch (e) {
                console.warn(`${TAG} [mcv] backup download failed`, e);
                if (!window.confirm('Backup download FAILED — continue WITHOUT a backup?')) { mcvReorderBusy = false; return; }
            }
            showToast(`♻ Saving re-ordered "${m.name}"…`, '#9cf', 3000);
            await ctx.saveApp(Object.assign({}, m, { instructions: instrs }), m.name);
            // verify: fresh fetch → same pad set, new order, same step count
            await new Promise(r => setTimeout(r, 1200));
            const after = await mbFetchMissionsFull(getCurrentSiteID());
            const m2 = after.find(x => x.id === m.id);
            let good = false;
            if (m2) {
                const det2 = mcvDetect(data.ent, [m2]);
                const mc2 = det2.macros[0];
                const gotOrder = mc2 ? mc2.pads.map(a => a.id).join(',') : '';
                const wantOrder = orderIds.join(',');
                const steps2 = (m2.instructions || []).filter(i => i && i.type !== 0 && i.type !== 99).length;
                const steps1 = ins.filter(i => i && i.type !== 0 && i.type !== 99).length;
                good = gotOrder === wantOrder && steps2 === steps1;
                if (!good) console.warn(`${TAG} [mcv] verify mismatch — order got [${gotOrder}] want [${wantOrder}] · steps ${steps2}/${steps1}`);
            }
            showToast(good
                ? `♻ "${m.name}" re-ordered ✓ verified — ${cFl} → ${rFl} flights. Re-check its schedule if one is active.`
                : `⚠ "${m.name}" saved but verify mismatched — check the mission + console (backup downloaded).`, good ? '#5fff5f' : '#ff9800', 9000);
            // refresh overlay data
            mcv.data.missions = after;
            mcv.data.det = mcvDetect(data.ent, after);
            mcv.data.audits = mcvAudit(mcv.data.det, data.ent);
            mcvClear();
            mcvDraw(mcv.data.det);
            mcv.on = true;
        } catch (e) {
            console.warn(`${TAG} [mcv] reorder failed`, e);
            showToast('♻ Reorder FAILED — nothing verified, backup downloaded (see console).', '#ff5252', 6000);
        }
        mcvReorderBusy = false;
    }

    // 👁 route comparison (v2.44) — draw a macro's CURRENT order (solid, the
    // macro's color) and the ♻ replan order (dashed white) as legal routes on
    // the verified graph, base to base. Answers "how is it so much further"
    // with feet of line instead of vibes. Click-through; per-macro toggle.
    const mcvRoutes = new Map();   // missionId -> layers[]
    function mcvClearRoutes(missionId) {
        const clear = (id) => { (mcvRoutes.get(id) || []).forEach(l => { try { l.remove(); } catch (e) {} }); mcvRoutes.delete(id); };
        if (missionId != null) clear(missionId);
        else Array.from(mcvRoutes.keys()).forEach(clear);
    }
    function mcvRouteBuilt() {
        const data = mcv.data;
        if (!data) return null;
        if (!data.routeBuilt) {
            try {
                const built = rngBuildGraph(data.ent, false);
                built.boxes = built.ffzs.map(f => agRingBbox(f.ring, MB_ENTRY_FFZ_FT / 3.28084));
                data.routeBuilt = built;
            } catch (e) { console.warn(`${TAG} [mcv] route graph build failed`, e); return null; }
        }
        return data.routeBuilt;
    }
    function mcvToggleRoute(missionId, color) {
        if (mcvRoutes.has(missionId)) { mcvClearRoutes(missionId); return false; }
        const L = composerGetL(), map = getLeafletMap();
        const data = mcv.data;
        if (!L || !map || !data) return false;
        const mc = data.det.macros.find(x => x.mission.id === missionId);
        const au = data.audits ? data.audits.get(missionId) : null;
        const built = mcvRouteBuilt();
        if (!mc || !built) { showToast('Route compare unavailable (see console).', '#ff9800', 3000); return false; }
        const base = data.ent.base;
        const layers = [];
        // v2.45: anchor at the mission's ACTUAL NAV POINTS, never centroids —
        // the drone flies navs; centroid stubs reached illegally into pads and
        // exaggerated the drawn length (live catch). Per pad we walk its block
        // steps' navs in order; legs between stops route legally.
        const stepsByPad = new Map();
        (mc.blocks || []).forEach(b => {
            if (b.aId == null) return;
            if (!stepsByPad.has(b.aId)) stepsByPad.set(b.aId, []);
            b.steps.forEach(s => stepsByPad.get(b.aId).push(s));
        });
        const padById = new Map(mc.pads.map(a => [a.id, a]));
        const navsOf = (padId) => {
            const steps = stepsByPad.get(padId) || [];
            const navs = steps.filter(s => s && s.type === 1 && s.location && typeof s.location.lat === 'number').map(s => s.location);
            if (navs.length) return navs;
            const a = padById.get(padId);
            return a ? [genCentroid(a.ring)] : [];
        };
        const pathFor = (padIds) => {
            const stops = [];
            if (base) stops.push(base);
            padIds.forEach(id => navsOf(id).forEach(p => stops.push(p)));
            if (base) stops.push(base);
            let pts = [];
            for (let i = 1; i < stops.length; i++) {
                const leg = mpvLegalPath(built, stops[i - 1], stops[i]) || [[stops[i - 1].lat, stops[i - 1].lng], [stops[i].lat, stops[i].lng]];
                pts = pts.length ? pts.concat(leg.slice(1)) : leg.slice();
            }
            return pts;
        };
        try {
            layers.push(L.polyline(pathFor(mc.pads.map(a => a.id)), { color, weight: 4, opacity: 0.9, interactive: false }).addTo(map));
            if (au && au.reRows && au.reRows.length) {
                layers.push(L.polyline(pathFor(au.reRows.map(r => r.asset.id)), { color: '#ffffff', weight: 2.5, opacity: 0.9, dashArray: '6 6', interactive: false }).addTo(map));
            }
        } catch (e) { console.warn(`${TAG} [mcv] route draw failed`, e); }
        mcvRoutes.set(missionId, layers);
        return true;
    }

    // 📋 Report (v2.39) — the user's planning spreadsheet, generated: one row
    // per pad with Name / Asset Classification / Captured? / Battery /
    // Section / Mission Name / Order, grouped by mission (uncovered pads at
    // the bottom). Copies rich HTML (colored cells for Sheets) + TSV fallback.
    function mcvSubtypeOf(a) {
        const p = String(a.poi || '').trim();
        const i = p.indexOf(' - ');
        return ((i >= 0 ? p.slice(0, i) : p) || '').trim();
    }
    async function mcvReport() {
        const data = mcv.data;
        if (!data) { showToast('Toggle 🧩 Macros on first.', '#ff9800', 3000); return; }
        const { ent, missions, det } = data;
        showToast('📋 Building coverage report…', '#7adfe6', 2000);
        let bat = new Map();
        try { const sol = rngSolve(ent); bat = new Map(sol.results.map(r => [r.asset.id, r])); } catch (e) { console.warn(`${TAG} [mcv] report range solve failed`, e); }
        const secName = { N: 'North', E: 'East', S: 'South', W: 'West', NE: 'NE', SE: 'SE', SW: 'SW', NW: 'NW', C: 'Central' };
        const macrosOf = new Map();
        det.macros.forEach(mc => mc.pads.forEach((a, i) => {
            if (!macrosOf.has(a.id)) macrosOf.set(a.id, []);
            macrosOf.get(a.id).push({ name: String(mc.mission.name || ''), order: i + 1 });
        }));
        const rows = det.assets.map(a => {
            const r = bat.get(a.id);
            const tulip = !!(r && r.status === 'ok' && r.worstFt > agCfg().tattuRadiusFt && r.worstFt <= agCfg().tulipRadiusFt);
            const batLabel = r && r.status === 'ok'
                ? (r.worstFt <= agCfg().tattuRadiusFt ? 'Tattu' : (tulip ? 'Tulip' : 'Over range'))
                : (r && r.status === 'no-ffz' ? 'No FFZ' : 'No route');
            const list = macrosOf.get(a.id) || [];
            const pref = (tulip ? list.find(x => / 2$/.test(x.name)) : (list.find(x => / 1$/.test(x.name)) || list.find(x => / 1-2$/.test(x.name)))) || list[0] || null;
            return {
                name: a.name || String(a.id),
                cls: mcvSubtypeOf(a),
                captured: det.touched.has(a.id),
                bat: batLabel,
                sec: secName[mbSection(genCentroid(a.ring), ent.base)] || '',
                mission: pref ? pref.name : '',
                order: pref ? pref.order : '',
            };
        });
        rows.sort((x, y) => (x.mission || '~').localeCompare(y.mission || '~') || (Number(x.order) || 9999) - (Number(y.order) || 9999) || x.name.localeCompare(y.name));
        const CLS_BG = { 'h-well': '#1c64b8', 'v-well': '#8b4a16', 'battery': '#1e7d46', 'compressor': '#e8d18a', 'well-cluster': '#455a64' };
        const SEC_BG = { East: '#1e7d46', North: '#c62828', South: '#5d4037', West: '#1c64b8', NE: '#7cb342', SE: '#e8d18a', SW: '#6a3ab2', NW: '#00838f', Central: '#616161' };
        const dark = bg => ['#e8d18a'].indexOf(bg) >= 0;
        const td = (txt, bg, fg) => `<td style="border:1px solid #bbb;padding:2px 8px;${bg ? `background:${bg};color:${fg || '#fff'};` : ''}">${escapeHtml(String(txt))}</td>`;
        const html = '<table style="border-collapse:collapse;font-family:Arial;font-size:12px;"><tr>'
            + ['Name', 'Asset Classification', 'Captured?', 'Battery', 'Section', 'Mission Name', 'Order'].map(h => `<td style="border:1px solid #999;padding:2px 8px;background:#efefef;font-weight:bold;">${h}</td>`).join('')
            + '</tr>'
            + rows.map(r2 => {
                const clsBg = CLS_BG[r2.cls.toLowerCase()] || '#607d8b';
                const secBg = SEC_BG[r2.sec] || '';
                return '<tr>'
                    + td(r2.name)
                    + td(r2.cls, clsBg, dark(clsBg) ? '#333' : '#fff')
                    + td(r2.captured ? '✓' : '', r2.captured ? '#00d050' : '#ffcdd2', '#0a3018')
                    + td(r2.bat, r2.bat === 'Tattu' ? '#cfe8ff' : (r2.bat === 'Tulip' ? '#ecd6f7' : '#eee'), '#333')
                    + td(r2.sec, secBg, dark(secBg) ? '#333' : '#fff')
                    + td(r2.mission)
                    + td(r2.order)
                    + '</tr>';
            }).join('')
            + '</table>';
        // ♻ mission-level audit table (v2.40) — appended below the pad table
        const audits = data.audits || new Map();
        const auRows = det.macros.map(mc => {
            const au = audits.get(mc.mission.id);
            const steps = (mc.mission.instructions || []).filter(i => i && i.type !== 0 && i.type !== 99).length;
            if (!au || !au.cur || !au.re) return { name: mc.mission.name, pads: mc.pads.length, steps, cur: '', curFl: '', re: '', reFl: '', dFl: '', days: '' };
            const c = au.calib;
            const curFl = c ? c.curFl : au.cur.flights.length;
            const reFl = c ? c.reFl : au.re.flights.length;
            const curFt = c && c.curDistM ? c.curDistM * 3.28084 : au.cur.totalFt;
            const reFt = c && c.reDistM ? c.reDistM * 3.28084 : au.re.totalFt;
            return {
                name: mc.mission.name, pads: mc.pads.length, steps,
                cur: Math.round(curFt / 1000) + 'k', curFl,
                re: Math.round(reFt / 1000) + 'k', reFl,
                dFl: curFl - reFl,
                days: mcvDays(curFl).days.toFixed(1),
            };
        }).sort((a, b) => (Number(b.dFl) || 0) - (Number(a.dFl) || 0));
        const auHtml = auRows.length
            ? '<br><table style="border-collapse:collapse;font-family:Arial;font-size:12px;"><tr>'
                + ['Mission', 'Pads', 'Steps', 'Current est ft', 'Current flights', 'Replan est ft', 'Replan flights', 'Flights saved', 'Est days (current)'].map(h => `<td style="border:1px solid #999;padding:2px 8px;background:#efefef;font-weight:bold;">${h}</td>`).join('')
                + '</tr>'
                + auRows.map(r3 => '<tr>' + [r3.name, r3.pads, r3.steps, r3.cur, r3.curFl, r3.re, r3.reFl, r3.dFl, r3.days].map((v, ci) => td(v, ci === 7 && Number(v) >= 1 ? '#ffe0b2' : '', '#333')).join('') + '</tr>').join('')
                + '</table>'
            : '';
        const html2 = html + auHtml;
        const tsv = ['Name\tAsset Classification\tCaptured?\tBattery\tSection\tMission Name\tOrder']
            .concat(rows.map(r2 => [r2.name, r2.cls, r2.captured ? 'TRUE' : 'FALSE', r2.bat, r2.sec, r2.mission, r2.order].join('\t')))
            .concat(auRows.length ? ['', 'Mission\tPads\tSteps\tCurrent est ft\tCurrent flights\tReplan est ft\tReplan flights\tFlights saved\tEst days (current)']
                .concat(auRows.map(r3 => [r3.name, r3.pads, r3.steps, r3.cur, r3.curFl, r3.re, r3.reFl, r3.dFl, r3.days].join('\t'))) : [])
            .join('\n');
        try {
            await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob([html2], { type: 'text/html' }),
                'text/plain': new Blob([tsv], { type: 'text/plain' }),
            })]);
            showToast(`📋 Report copied (${rows.length} pads) — paste into Google Sheets.`, '#5fff5f', 5000);
        } catch (e) {
            try {
                const ta = document.createElement('textarea');
                ta.value = tsv; document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); ta.remove();
                showToast(`📋 Report copied as TSV (${rows.length} pads).`, '#5fff5f', 4500);
            } catch (e2) { console.warn(`${TAG} [mcv] report copy failed`, e2); showToast('Report copy failed (see console).', '#ff5252', 4000); }
        }
    }

    async function mcvToggle(btn) {
        if (mcv.on) { mcv.on = false; mcvClear(); if (btn) btn.classList.remove('active'); return; }
        if (mcv.busy) return;
        const sid = getCurrentSiteID();
        if (!sid) { showToast('No site loaded.', '#ff5252', 3000); return; }
        mcv.busy = true;
        showToast('🧩 Scanning missions for macro coverage…', '#7adfe6', 2500);
        try {
            const [ent, missions] = await Promise.all([genFetchEntities(sid), new Promise((res, rej) => fetchMissions(sid, res, rej))]);
            const det = mcvDetect(ent, missions);
            mcv.data = { ent, missions, det };
            showToast('♻ Auditing macro efficiency (current order vs replan)…', '#7adfe6', 2500);
            mcv.data.audits = mcvAudit(det, ent);
            mcvClear();
            mcv.hidden = new Set();   // default: every macro visible on a fresh open
            mcvDraw(det);
            mcv.on = true;
            if (btn) btn.classList.add('active');
            console.log(`${TAG} [mcv] ${det.macros.length} macro(s) · ${det.covered.size} pads covered · ${det.todo.length} pads with missions still uncovered`);
        } catch (e) {
            console.warn(`${TAG} [mcv] failed`, e);
            showToast('Macro coverage failed (see console).', '#ff5252', 4000);
        }
        mcv.busy = false;
    }

    // The point(s) a solo flies = its NAVIGATE (type 1) locations — the drone
    // flies navs; snapshots (type 6) are camera positions, NOT waypoints
    // (v2.19 live-test fix: routes were anchoring to snapshot points).
    // Falls back to snapshot locations for nav-less missions.
    function mbSoloPoints(mission) {
        const ins = (mission && mission.instructions) || [];
        const navs = ins.filter(i => i && i.type === 1 && i.location && typeof i.location.lat === 'number').map(i => ({ lat: i.location.lat, lng: i.location.lng }));
        if (navs.length) return navs;
        return ins.filter(i => i && i.type === 6 && i.location && typeof i.location.lat === 'number').map(i => ({ lat: i.location.lat, lng: i.location.lng }));
    }
    // The mission "body" = everything except the leading takeoff + trailing
    // returnHome (types 0 / 99). These get concatenated in the merge.
    function mbMissionBody(mission) {
        return ((mission && mission.instructions) || []).filter(i => i && i.type !== 0 && i.type !== 99);
    }

    // Compute the merge plan for a site: per-solo {mission, pts, ring, routeM,
    // section, battery}, then grouped into battery-tiered sets — split on the
    // step cap into finer compass sub-sectors, each ordered by the Auto-Group
    // optimizer and battery-simulated (v2.15, feature #216).
    // `overrides` = {missionId: sectionCode} manual section reassignments.
    function mbComputeMerge(siteID, missions, ent, overrides) {
        const router = mbBuildRouter(ent);
        const base = ent.base;
        const cfg = agCfg();
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
            // v2.16: overrides are FAMILY indexes (applied after the sweep),
            // not section codes — section is informational only now.
            const section = mbSection(c, base);
            // routePts rides along: the order graph matches pads to FFZs by the
            // same ring points routeFor used (centroid alone can sit > REACH
            // from the FFZ even when the pad edge touches it).
            return { mission: m, pt: c, routePts, routeM, reason: routeM == null ? (router.ready ? router.explain(routePts) : 'no routing data') : '', section, battery: mbBatteryFor(routeM) };
        });
        // Pairwise order graph over the routable solos (pads become vertices).
        const routableAll = solos.filter(s => s.routeM != null && s.battery && s.battery.level < 2);
        let ag = null;
        try { ag = routableAll.length >= 2 ? agBuildOrderGraph(ent, routableAll) : null; }
        catch (e) { console.warn(`${TAG} [ag] order graph failed — falling back to distance sort`, e); }
        const agIdx = new Map(); routableAll.forEach((s, i) => agIdx.set(s, i));
        // Per-pad battery cost (v2.17): the mission's REAL internal path
        // length (instruction-location hops) + hover overhead per step.
        const intraCache = new Map();
        const padCostFt = (s) => {
            let v = intraCache.get(s.mission.id);
            if (v == null) { v = agIntraFt(s.mission) + pcmStepCount(s.mission) * cfg.stepCostFt; intraCache.set(s.mission.id, v); }
            return v;
        };
        const agDPad = ag ? (i, j) => ag.padDistFt(i, j) : null;
        const agDBase = ag ? i => ag.baseDistFt(i) : null;
        const agCostOf = i => padCostFt(routableAll[i]);
        // Order + simulate one group's solo set against a battery budget.
        const orderAndSim = (set, budgetFt) => {
            if (!ag || !set.length) {
                const sorted = set.slice().sort((a, b) => (b.routeM || 0) - (a.routeM || 0));
                return { solos: sorted, sim: null };
            }
            const idxs = set.map(s => agIdx.get(s));
            const order = agOptimizeOrder(idxs, agDPad, agDBase, agCostOf, budgetFt);
            return { solos: order.map(i => routableAll[i]), idxs: order, sim: agSimulate(order, agDPad, agDBase, agCostOf, budgetFt) };
        };
        // Families: global bearing sweep into ~targetGroups arcs (v2.16 — no
        // fixed 8-way sections; adjacent directions merge freely). `overrides`
        // = {missionId: familyIndexString} pins a pad into a specific family.
        const families = agSweepFamilies(routableAll, base);
        Object.keys(overrides || {}).forEach(mid => {
            const fi = Number(overrides[mid]);
            if (!isFinite(fi) || fi < 0 || fi >= families.length) return;
            const s = routableAll.find(x => String(x.mission.id) === String(mid));
            if (!s || families[fi].solos.includes(s)) return;
            families.forEach(f => { const at = f.solos.indexOf(s); if (at >= 0) f.solos.splice(at, 1); });
            families[fi].solos.push(s);
        });
        // ── Corridor pickup (v2.17) ──────────────────────────────────────────
        // The sweep assigns by BEARING only, so a pad sitting right on another
        // family's flight corridor stays in its angular family ("skips pads it
        // flies right past" — live-test feedback). Refinement: repeatedly take
        // the single best pad move between families — evaluated by insertion
        // deltas on the SIMULATED orders — while it saves > 1,000 ft of total
        // flown distance. User-pinned pads (overrides) never auto-move.
        if (ag && families.length > 1) {
            const pinned = new Set(Object.keys(overrides || {}).map(String));
            const famBudget = f => f.solos.some(s => s.battery.level === 1) ? cfg.tulipBudgetFt : cfg.tattuBudgetFt;
            const simTot = (o, b) => o.length ? agSimulate(o, agDPad, agDBase, agCostOf, b).totalFt : 0;
            const famOrder = new Map();
            families.forEach(f => famOrder.set(f, agOptimizeOrder(f.solos.map(s => agIdx.get(s)), agDPad, agDBase, agCostOf, famBudget(f))));
            let guard = 0;
            while (guard++ < 24) {
                let best = null;
                families.forEach(src => {
                    const so = famOrder.get(src);
                    const srcCost = simTot(so, famBudget(src));
                    so.forEach((pi, k) => {
                        if (pinned.has(String(routableAll[pi].mission.id))) return;
                        const without = so.slice(0, k).concat(so.slice(k + 1));
                        const save = srcCost - simTot(without, famBudget(src));
                        families.forEach(tgt => {
                            if (tgt === src) return;
                            const to = famOrder.get(tgt);
                            const tb = (routableAll[pi].battery.level === 1 || tgt.solos.some(s2 => s2.battery.level === 1)) ? cfg.tulipBudgetFt : cfg.tattuBudgetFt;
                            const before = simTot(to, tb);
                            for (let ins = 0; ins <= to.length; ins++) {
                                const cand = to.slice(0, ins).concat([pi], to.slice(ins));
                                const gain = save - (simTot(cand, tb) - before);
                                if (gain > 1000 && (!best || gain > best.gain)) best = { gain, src, tgt, pi, without, cand };
                            }
                        });
                    });
                });
                if (!best) break;
                famOrder.set(best.src, best.without);
                famOrder.set(best.tgt, best.cand);
                const s = routableAll[best.pi];
                best.src.solos.splice(best.src.solos.indexOf(s), 1);
                best.tgt.solos.push(s);
                console.log(`${TAG} [ag] corridor pickup: "${s.mission.name}" moved between groups (saves ~${Math.round(best.gain).toLocaleString()} ft)`);
            }
        }
        // Names AFTER membership settles (wind name follows the pads).
        const usedNames = new Set();
        families.forEach((f, i) => { f.name = (base && f.solos.length) ? agWindName(f.solos, base, usedNames) : `Group ${i + 1}`; });
        const groups = [];
        families.forEach((f, fi) => {
            if (!f.solos.length) return;
            const tattu = f.solos.filter(s => s.battery.level === 0);
            const tulip = f.solos.filter(s => s.battery.level === 1);
            const mk = (nm, batLabel, set, budgetFt) => {
                const os = orderAndSim(set, budgetFt);
                groups.push({ fam: fi, name: nm, battery: batLabel, solos: os.solos, idxs: os.idxs || null, sim: os.sim, budgetFt });
            };
            if (tulip.length) {
                // X 1 = Tattu subset; X 2 = Tattu + Tulip (X 2 ⊇ X 1), each
                // ordered independently (tier-2 re-optimizes, per user).
                if (tattu.length) mk(`${f.name} 1`, 'Tattu', tattu.slice(), cfg.tattuBudgetFt);
                mk(`${f.name} 2`, 'Tulip', tattu.concat(tulip), cfg.tulipBudgetFt);
            } else if (tattu.length) {
                // 1-2 flies on EITHER battery → simulate on the weaker (Tattu).
                mk(`${f.name} 1-2`, 'Tattu/Tulip', tattu.slice(), cfg.tattuBudgetFt);
            }
        });
        // Over-range + unroutable solos surfaced in one block, never merged.
        const excluded = solos.filter(s => !(s.routeM != null && s.battery && s.battery.level < 2));
        if (excluded.length) groups.push({ name: 'Excluded', excluded });
        return { solos, groups, families, ag, agSolos: routableAll, routerReady: router.ready, verts: router.verts, agReady: !!ag, offGraphPairs: ag ? ag.offGraphPairs : 0 };
    }

    // ── Merge panel + commit ─────────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════════
    // v1.99 — PAD-CLICK MERGE + CROSS-SITE MISSION COPY
    //
    // Pad-click merge (🔗): right-click (M2) asset pads on the map IN ORDER;
    // each pad's name resolves to the mission with the SAME name (user rule:
    // pad name = mission name, snapshots always belong to their pad). The
    // merged mission = first mission's takeoff + every mission's editable
    // steps in click order + last mission's returnHome (user rule: all
    // takeoffs/landings are identical — keep first TO, last LAND). Created
    // as a NEW mission via the proven ctx.saveApp({id:null}) path; originals
    // untouched.
    //
    // Cross-site copy (📥): fetch another site's missions, pick-list
    // (default all), create-only onto THIS site via the same saveApp path —
    // dup names skipped. Coordinates are absolute GPS, so cloned sites line
    // up. Instruction ids ride along and are ignored on create (same as the
    // v1.48 Section+Battery merge which passes fetched instructions raw).
    // ════════════════════════════════════════════════════════════════════════
    const PCM_PANEL_ID = 'aim-mb-pcm-panel';
    const pcm = { on: false, picks: [], markers: [], missions: null, assets: null, base: null, bound: null, panelEl: null, customName: null, pendingChoice: null, filterType: null, editingName: null, panelPos: null };

    // Asset base type ("well-cluster", "battery", …) — the poi string minus
    // any " - <state>" suffix. Used by the merge-mode type filter.
    function pcmBaseType(a) {
        const p = String((a && a.poi) || '').trim();
        if (!p) return '(untyped)';
        const i = p.indexOf(' - ');
        return ((i >= 0 ? p.slice(0, i) : p).trim().toLowerCase()) || '(untyped)';
    }

    // ---- Merge recipes (v2.03) — the ordered pick list is persisted per
    // merged-mission name so a merge can be RE-EDITED (reordered / re-synced
    // from its source missions) without re-clicking every pad. Stored in GM;
    // source missions resolve by NAME at load time so renames surface loudly.
    const PCM_RECIPES_KEY = 'aim-mb-merge-recipes';
    // v2.05: recipe keys are env-namespaced — prod and QA are separate
    // databases, so site 1583 on QA is NOT prod's 1583. GM storage is
    // shared across origins; bare-ID keys would leak recipes between them.
    function pcmRecipeKey(siteId, name) { return `${envSiteKey(siteId)}::${name}`; }
    function pcmLoadRecipes() {
        try {
            if (typeof GM_getValue === 'function') {
                const raw = GM_getValue(PCM_RECIPES_KEY, null);
                if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object') return o; }
            }
        } catch (e) { console.warn(`${TAG} [pcm] recipe load failed`, e); }
        return {};
    }
    function pcmSaveRecipe(siteId, name) {
        try {
            if (typeof GM_setValue !== 'function') return;
            const all = pcmLoadRecipes();
            all[pcmRecipeKey(siteId, name)] = {
                site: String(siteId), name, at: Date.now(),
                picks: pcm.picks.map(p => ({ assetId: p.asset.id, assetName: p.asset.name, missionName: p.mission.name })),
            };
            GM_setValue(PCM_RECIPES_KEY, JSON.stringify(all));
        } catch (e) { console.warn(`${TAG} [pcm] recipe save failed`, e); }
    }
    function pcmDeleteRecipe(siteId, name) {
        try {
            if (typeof GM_setValue !== 'function') return;
            const all = pcmLoadRecipes();
            delete all[pcmRecipeKey(siteId, name)];
            GM_setValue(PCM_RECIPES_KEY, JSON.stringify(all));
        } catch (e) {}
    }
    function pcmSiteRecipes(siteId) {
        const all = pcmLoadRecipes();
        return Object.keys(all).filter(k => k.indexOf(`${envSiteKey(siteId)}::`) === 0).map(k => all[k]).sort((a, b) => b.at - a.at);
    }
    function pcmLoadRecipe(rec) {
        const missing = [];
        const picks = [];
        rec.picks.forEach(rp => {
            const mission = (pcm.missions || []).find(m => String((m && m.name) || '').trim().toLowerCase() === String(rp.missionName || '').trim().toLowerCase());
            if (!mission) { missing.push(rp.missionName); return; }
            const asset = (pcm.assets || []).find(a => a.id === rp.assetId) || { id: rp.assetId, name: rp.assetName, ring: null };
            picks.push({ asset, mission });
        });
        pcm.picks = picks;
        pcm.editingName = rec.name;
        pcm.customName = rec.name;
        pcm.pendingChoice = null;
        if (missing.length) showToast(`⚠ ${missing.length} source mission(s) not found (renamed/deleted?): ${missing.join(', ')}`, '#ff9800', 6500);
        pcmRefresh();
    }

    // ⚡ Efficient order — furthest → closest from the base station (same
    // convention as the Section+Battery merge: the drone works its way home).
    function pcmEfficientOrder() {
        if (pcm.picks.length < 2) return;
        const b = pcm.base;
        if (!b) { showToast('No base station found on this site — can\'t compute distance order.', '#ff9800', 3500); return; }
        const dist = (p) => {
            if (!p.asset || !Array.isArray(p.asset.ring) || !p.asset.ring.length) return 0;
            const c = genCentroid(p.asset.ring);
            const dLat = (c.lat - b.lat) * 111320;
            const dLng = (c.lng - b.lng) * 111320 * Math.cos(b.lat * Math.PI / 180);
            return Math.hypot(dLat, dLng);
        };
        pcm.picks.sort((a, b2) => dist(b2) - dist(a));
        showToast('⚡ Reordered furthest → closest from base.', '#5fff5f', 3000);
        pcmRefresh();
    }

    // M2 on a numbered badge → move-to-position popup (no need to unwind
    // picks to fix one slot).
    let pcmRenumEl = null;
    function pcmCloseRenumber() {
        if (pcmRenumEl) { try { pcmRenumEl.remove(); } catch (e) {} pcmRenumEl = null; }
    }
    function pcmOpenRenumber(idx, x, y) {
        pcmCloseRenumber();
        const p = pcm.picks[idx];
        if (!p) return;
        const el = document.createElement('div');
        el.style.cssText = `position:fixed;left:${Math.min(x, window.innerWidth - 260)}px;top:${Math.min(y, window.innerHeight - 110)}px;z-index:2147483602;`
            + 'background:#161a20;border:1px solid #7adfe6;border-radius:6px;padding:8px 10px;color:#e6e6e6;font:12px "Lato","Segoe UI",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,0.7);';
        el.innerHTML = `<div style="color:#7adfe6;font-weight:700;margin-bottom:5px;">#${idx + 1} · ${escapeHtml(String(p.asset.name || ''))}</div>
            <div style="display:flex;gap:6px;align-items:center;">
            <label style="color:#9ad;font-size:11px;">Move to</label>
            <input data-pcm-renum type="number" min="1" max="${pcm.picks.length}" value="${idx + 1}" style="width:52px;background:#0e1218;color:#e6e6e6;border:1px solid #2a3340;border-radius:4px;padding:2px 5px;">
            <button data-pcm-renum-set style="padding:3px 9px;background:#7adfe6;border:none;color:#04222a;border-radius:4px;cursor:pointer;font-weight:800;">Set</button>
            <button data-pcm-renum-rm style="padding:3px 9px;background:rgba(255,85,85,0.2);border:1px solid #ff5555;color:#ff8a8a;border-radius:4px;cursor:pointer;">Remove</button>
            <button data-pcm-renum-x style="background:none;border:none;color:#888;cursor:pointer;">✕</button></div>`;
        document.body.appendChild(el);
        pcmRenumEl = el;
        const doSet = () => {
            const v = Math.max(1, Math.min(pcm.picks.length, Number(el.querySelector('[data-pcm-renum]').value) || (idx + 1)));
            const moved = pcm.picks.splice(idx, 1)[0];
            pcm.picks.splice(v - 1, 0, moved);
            pcmCloseRenumber();
            pcmRefresh();
        };
        el.querySelector('[data-pcm-renum-set]').onclick = doSet;
        el.querySelector('[data-pcm-renum]').onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') doSet(); };
        el.querySelector('[data-pcm-renum-rm]').onclick = () => { pcm.picks.splice(idx, 1); pcmCloseRenumber(); pcmRefresh(); };
        el.querySelector('[data-pcm-renum-x]').onclick = () => pcmCloseRenumber();
    }

    function pcmStepCount(m) { return mbMissionBody(m).length; }

    function pcmFindMission(name) {
        const c = pcmFindMissionCandidates(name);
        return c.length === 1 ? c[0] : null;
    }

    // v2.01: mission names carry section prefixes ("NNE - SMITH SN 48-37 03
    // 203H" for pad "SMITH SN 48-37 03 203H" — the generator's
    // "{section} - {asset}" template). Rank matches: exact → ends with
    // " - <pad>" → contains. Multiple survivors at a rank → the panel shows
    // a pick-one chooser instead of guessing (a "Merged - A + B" mission
    // also CONTAINS pad names, so contains can tie).
    function pcmFindMissionCandidates(name) {
        return rankMatchMissions(name, pcm.missions);
    }

    // v2.08: the asset-name → mission rank ladder, extracted so pad-click
    // merge and the Site Setup mission preview (mpv) agree on which mission
    // a pad name means. The Asset Inspector's "Find in Missions" (v4.211)
    // mirrors this ladder too — keep all three in sync.
    function rankMatchMissions(name, missions) {
        const want = String(name || '').trim().toLowerCase();
        if (!want || !Array.isArray(missions)) return [];
        const all = missions.filter(m => m && typeof m.name === 'string' && m.name.trim());
        const norm = m => m.name.trim().toLowerCase();
        let c = all.filter(m => norm(m) === want);
        if (c.length) return c;
        c = all.filter(m => norm(m).endsWith('- ' + want) || norm(m).endsWith('– ' + want));
        if (c.length) return c;
        return all.filter(m => norm(m).indexOf(want) >= 0);
    }

    async function pcmEnter() {
        const sid = getCurrentSiteID();
        if (!sid) { showToast('No site loaded.', '#ff5252', 3000); return; }
        showToast('🔗 Merge mode — loading pads + missions…', '#7adfe6', 2500);
        try {
            const [ent, missions] = await Promise.all([
                genFetchEntities(sid),
                new Promise((res, rej) => fetchMissions(sid, res, rej)),
            ]);
            pcm.assets = (ent && ent.assets) || [];
            pcm.base = (ent && ent.base) || null;
            pcm.missions = missions || [];
        } catch (e) {
            console.warn(`${TAG} [pcm] load failed`, e);
            showToast('Merge mode: failed to load pads/missions (see console).', '#ff5252', 4000);
            return;
        }
        if (!pcm.assets.length) { showToast('No asset pads found on this site.', '#ff9800', 3500); return; }
        pcm.on = true; pcm.picks = []; pcm.customName = null; pcm.editingName = null;
        // Synchronous DOM flag (same protocol as Click-to-Add's
        // data-aim-clickadd): the Asset Inspector's window contextmenu
        // handler bails while this is set (AI v4.199+), so M2 on a pad
        // reaches OUR handler instead of popping the entity inspector.
        try { document.documentElement.setAttribute('data-aim-merge', '1'); } catch (e) {}
        pcmBind();
        pcmRefresh();
        showToast('🔗 Merge mode ON — right-click (M2) pads in order. M2 a numbered pad to remove it.', '#5fff5f', 5000);
    }

    function pcmExit() {
        pcm.on = false;
        try { document.documentElement.removeAttribute('data-aim-merge'); } catch (e) {}
        pcmUnbind();
        pcmClearMarkers();
        if (pcm.panelEl) { try { pcm.panelEl.remove(); } catch (e) {} pcm.panelEl = null; }
        pcm.picks = []; pcm.customName = null; pcm.pendingChoice = null; pcm.editingName = null;
        pcmCloseRenumber();
        const btn = document.querySelector('[data-pcm-toggle]');
        if (btn) btn.classList.remove('active');
    }

    function pcmBind() {
        pcmUnbind();
        const c = document.querySelector('.leaflet-container');
        if (!c) { showToast('Merge mode: map not found.', '#ff5252', 3000); return; }
        const h = (e) => pcmOnContextMenu(e);
        c.addEventListener('contextmenu', h, true);
        pcm.bound = { c, h };
    }
    function pcmUnbind() {
        if (pcm.bound) { try { pcm.bound.c.removeEventListener('contextmenu', pcm.bound.h, true); } catch (e) {} pcm.bound = null; }
    }

    function pcmOnContextMenu(e) {
        if (!pcm.on) return;
        // M2 directly on a numbered badge = renumber that pick in place
        const badgeEl = (e.target && e.target.closest) ? e.target.closest('[data-pcm-idx]') : null;
        if (badgeEl) {
            e.preventDefault(); e.stopPropagation();
            pcmOpenRenumber(Number(badgeEl.getAttribute('data-pcm-idx')), e.clientX + 8, e.clientY + 8);
            return;
        }
        const map = getLeafletMap();
        if (!map || typeof map.mouseEventToLatLng !== 'function') return;
        let ll;
        try { ll = map.mouseEventToLatLng(e); } catch (err) { return; }
        const pt = { lat: ll.lat, lng: ll.lng };
        const hit = (pcm.assets || []).find(a => a && a.ring && a.ring.length >= 3 && genPointInPoly(pt, a.ring));
        if (!hit) return;   // not on a pad — let native / other AIM handlers run
        e.preventDefault(); e.stopPropagation();
        if (pcm.filterType && pcmBaseType(hit) !== pcm.filterType) {
            showToast(`Filtered out — "${hit.name}" is "${pcmBaseType(hit)}" (filter: ${pcm.filterType}).`, '#ff9800', 3000);
            return;
        }
        const idx = pcm.picks.findIndex(p => p.asset.id === hit.id);
        if (idx >= 0) { pcm.picks.splice(idx, 1); pcm.pendingChoice = null; pcmRefresh(); return; }
        const cands = pcmFindMissionCandidates(hit.name).filter(m => !pcm.picks.some(p => p.mission.id === m.id));
        if (!cands.length) {
            const any = pcmFindMissionCandidates(hit.name).length;
            showToast(any ? `Pad "${hit.name}"'s mission is already in the list.` : `No mission matching "${hit.name}" on this site.`, '#ff9800', 3500);
            return;
        }
        if (cands.length === 1) {
            pcm.picks.push({ asset: hit, mission: cands[0] });
            pcm.pendingChoice = null;
            pcmRefresh();
            return;
        }
        pcm.pendingChoice = { asset: hit, candidates: cands.slice(0, 8) };
        pcmRenderPanel();
    }

    function pcmClearMarkers() {
        pcm.markers.forEach(m => { try { m.remove(); } catch (e) {} });
        pcm.markers = [];
    }
    function pcmDrawMarkers() {
        pcmClearMarkers();
        const L = composerGetL(), map = getLeafletMap();
        if (!L || !map) return;
        pcm.picks.forEach((p, i) => {
            if (!p.asset || !Array.isArray(p.asset.ring) || !p.asset.ring.length) return;   // recipe-loaded pick whose asset is gone
            const c = genCentroid(p.asset.ring);
            const icon = L.divIcon({
                className: 'aim-mb-pcm-badge',
                // interactive marker + data-pcm-idx → M2 on the badge itself opens the renumber popup
                html: `<div data-pcm-idx="${i}" style="width:26px;height:26px;border-radius:50%;background:#7adfe6;color:#04222a;font:800 14px/26px monospace;text-align:center;border:2px solid #04222a;box-shadow:0 1px 6px rgba(0,0,0,0.6);cursor:context-menu;">${i + 1}</div>`,
                iconSize: [26, 26], iconAnchor: [13, 13],
            });
            // zIndexOffset: pick numbers must sit ABOVE the 🔋 Range batteries
            try { pcm.markers.push(L.marker([c.lat, c.lng], { icon, interactive: true, zIndexOffset: 1000 }).addTo(map)); } catch (e) {}
        });
    }
    function pcmRefresh() { pcmDrawMarkers(); pcmRenderPanel(); }

    function pcmRenderPanel() {
        if (pcm.panelEl) { try { pcm.panelEl.remove(); } catch (e) {} pcm.panelEl = null; }
        const total = pcm.picks.reduce((s, pk) => s + pcmStepCount(pk.mission), 0);
        const defName = pcm.picks.length ? ('Merged - ' + pcm.picks.map(pk => pk.asset.name).join(' + ')) : '';
        const nameVal = pcm.customName != null ? pcm.customName : defName;
        // v2.30: rows are draggable — grab anywhere on a row (the ⠿ handle
        // telegraphs it) and drop onto another row to insert BEFORE it.
        // M2-on-badge renumbering still works as before.
        const rows = pcm.picks.map((pk, i) => `<div data-pcm-row="${i}" draggable="true" style="display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid #20262e;font-size:11px;cursor:grab;">
            <span style="color:#556;font-size:12px;">⠿</span>
            <span style="color:#7adfe6;font-weight:800;min-width:14px;">${i + 1}</span>
            <span style="flex:1;color:#e6e6e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(String(pk.mission.name || ''))}</span>
            <span style="color:#9ad;white-space:nowrap;">${pcmStepCount(pk.mission)} steps</span>
            <button data-pcm-rm="${i}" style="background:none;border:none;color:#ff8a8a;cursor:pointer;font-size:12px;">✕</button>
        </div>`).join('');
        const types = {};
        (pcm.assets || []).forEach(a => { const t = pcmBaseType(a); types[t] = (types[t] || 0) + 1; });
        const typeOpts = ['<option value="">All asset types</option>']
            .concat(Object.keys(types).sort().map(t => `<option value="${escapeHtml(t)}" ${pcm.filterType === t ? 'selected' : ''}>${escapeHtml(t)} (${types[t]})</option>`)).join('');
        const recipes = pcmSiteRecipes(getCurrentSiteID());
        const recipeOpts = recipes.map((r, i) => `<option value="${i}">${escapeHtml(r.name)} · ${r.picks.length} pads</option>`).join('');
        const el = document.createElement('div');
        el.id = PCM_PANEL_ID;
        const pos = pcm.panelPos ? `left:${pcm.panelPos.left};top:${pcm.panelPos.top};right:auto;` : 'top:60px;right:24px;';
        el.style.cssText = `position:fixed;${pos}width:360px;max-height:78vh;display:flex;flex-direction:column;z-index:2147483601;`
            + 'background:#161a20;border:1px solid #7adfe6;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.7);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;';
        el.innerHTML = `
            <div data-pcm-drag style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 12px;background:rgba(122,223,230,0.08);border-bottom:1px solid rgba(122,223,230,0.3);cursor:move;user-select:none;">
                <span style="font-weight:800;color:#7adfe6;font-size:14px;">${pcm.editingName ? `✏ Editing "${escapeHtml(pcm.editingName)}"` : '🔗 Merge by pad clicks'}</span>
                <button data-pcm-close style="background:rgba(255,255,255,0.12);border:none;color:#fff;width:22px;height:22px;border-radius:4px;cursor:pointer;">✕</button>
            </div>
            <div style="padding:7px 12px;font-size:10px;color:#789;border-bottom:1px solid #2a2f38;line-height:1.5;">
                Right-click (M2) pads in order — pad #1's mission leads. M2 a numbered BADGE to move it to any position; M2 elsewhere on a picked pad removes it.
                Keeps the FIRST mission's takeoff + the LAST mission's landing; everything between is the missions' editable steps in order.
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid #2a2f38;">
                <select data-pcm-filter title="Only pads of this asset type respond to M2" style="background:#0e1218;color:#cde;border:1px solid #2a3340;border-radius:4px;font-size:10px;padding:2px 3px;max-width:150px;">${typeOpts}</select>
                <button data-pcm-eff title="Reorder the current picks furthest → closest from the base station" style="padding:3px 8px;background:rgba(255,213,79,0.15);border:1px solid rgba(255,213,79,0.5);color:#ffd54f;border-radius:4px;cursor:pointer;font-size:10px;">⚡ Far→near</button>
                ${recipeOpts ? `<select data-pcm-recipe title="Load a saved merge to view its order or re-edit it" style="background:#0e1218;color:#cde;border:1px solid #2a3340;border-radius:4px;font-size:10px;padding:2px 3px;max-width:170px;"><option value="">✏ saved merges…</option>${recipeOpts}</select>` : ''}
            </div>
            ${pcm.pendingChoice ? `<div style="padding:6px 10px;border-bottom:1px solid #3a3320;background:rgba(255,213,79,0.07);">
                <div style="font-size:11px;color:#ffd54f;margin-bottom:4px;">Pad "${escapeHtml(pcm.pendingChoice.asset.name)}" matches ${pcm.pendingChoice.candidates.length} missions — pick one:</div>
                ${pcm.pendingChoice.candidates.map((m, i) => `<button data-pcm-cand="${i}" style="display:block;width:100%;text-align:left;margin:2px 0;padding:3px 8px;background:#0e1218;border:1px solid #3a4350;border-radius:4px;color:#e6e6e6;cursor:pointer;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.name)} <span style="color:#9ad;">· ${pcmStepCount(m)} steps</span></button>`).join('')}
                <button data-pcm-cand-cancel style="margin-top:3px;padding:2px 8px;background:none;border:none;color:#888;cursor:pointer;font-size:10px;">cancel</button>
            </div>` : ''}
            <div style="overflow:auto;flex:1;padding:2px 8px;">${rows || '<div style="padding:10px;color:#888;font-size:11px;">No pads picked yet.</div>'}</div>
            <div style="display:flex;gap:8px;align-items:center;padding:7px 12px;border-top:1px solid #2a2f38;">
                <label style="font-size:11px;color:#9ad;">Name</label>
                <input data-pcm-name type="text" value="${escapeHtml(nameVal)}" style="flex:1;background:#0e1218;color:#e6e6e6;border:1px solid #2a3340;border-radius:4px;padding:3px 6px;font-size:11px;" />
            </div>
            <div style="padding:9px 12px;border-top:1px solid #2a2f38;display:flex;align-items:center;gap:8px;">
                <span data-pcm-status style="flex:1;font-size:11px;color:#9ad;">${pcm.picks.length} mission(s) · ${total} steps</span>
                <button data-pcm-clear style="padding:5px 9px;background:rgba(255,255,255,0.12);border:none;color:#ddd;border-radius:5px;cursor:pointer;font-size:11px;">Clear</button>
                <button data-pcm-go style="padding:6px 12px;background:#5fff5f;border:none;color:#04220a;border-radius:6px;cursor:pointer;font-weight:800;" ${pcm.picks.length >= 2 ? '' : 'disabled'}>${pcm.editingName ? `💾 Update (${total})` : `🔗 Create (${total})`}</button>
            </div>`;
        document.body.appendChild(el);
        pcm.panelEl = el;
        el.querySelector('[data-pcm-close]').onclick = () => pcmExit();
        el.querySelector('[data-pcm-clear]').onclick = () => { pcm.picks = []; pcm.customName = null; pcm.pendingChoice = null; pcmRefresh(); };
        el.querySelectorAll('[data-pcm-cand]').forEach(b => {
            b.onclick = () => {
                const ch = pcm.pendingChoice;
                if (!ch) return;
                const m = ch.candidates[Number(b.getAttribute('data-pcm-cand'))];
                if (!m) return;
                pcm.picks.push({ asset: ch.asset, mission: m });
                pcm.pendingChoice = null;
                pcmRefresh();
            };
        });
        const candCancel = el.querySelector('[data-pcm-cand-cancel]');
        if (candCancel) candCancel.onclick = () => { pcm.pendingChoice = null; pcmRenderPanel(); };
        // Draggable by the header; the position survives the panel's rebuilds
        el.querySelector('[data-pcm-drag]').addEventListener('pointerdown', (ev) => {
            if (ev.target.closest && ev.target.closest('button')) return;
            ev.preventDefault();
            const r = el.getBoundingClientRect();
            const ox = ev.clientX - r.left, oy = ev.clientY - r.top;
            const mv = (m2) => {
                el.style.left = `${Math.max(0, m2.clientX - ox)}px`;
                el.style.top = `${Math.max(0, m2.clientY - oy)}px`;
                el.style.right = 'auto';
                pcm.panelPos = { left: el.style.left, top: el.style.top };
            };
            const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
            document.addEventListener('pointermove', mv);
            document.addEventListener('pointerup', up);
        });
        const filterSel = el.querySelector('[data-pcm-filter]');
        if (filterSel) filterSel.onchange = () => { pcm.filterType = filterSel.value || null; };
        const effBtn = el.querySelector('[data-pcm-eff]');
        if (effBtn) effBtn.onclick = () => pcmEfficientOrder();
        const recipeSel = el.querySelector('[data-pcm-recipe]');
        if (recipeSel) recipeSel.onchange = () => {
            const r = pcmSiteRecipes(getCurrentSiteID())[Number(recipeSel.value)];
            if (r) pcmLoadRecipe(r);
        };
        el.querySelector('[data-pcm-go]').onclick = () => pcmCommit();
        const nameEl = el.querySelector('[data-pcm-name]');
        nameEl.oninput = () => { pcm.customName = nameEl.value; };
        el.querySelectorAll('[data-pcm-rm]').forEach(b => {
            b.onclick = () => { pcm.picks.splice(Number(b.getAttribute('data-pcm-rm')), 1); pcmRefresh(); };
        });
        // drag-and-drop reorder (v2.30) — drop inserts BEFORE the hovered row;
        // drop on the footer area appends to the end.
        let pcmDragIdx = null;
        const rowEls = el.querySelectorAll('[data-pcm-row]');
        rowEls.forEach(rowEl => {
            rowEl.addEventListener('dragstart', (ev) => {
                pcmDragIdx = Number(rowEl.getAttribute('data-pcm-row'));
                rowEl.style.opacity = '0.45';
                try { ev.dataTransfer.setData('text/plain', String(pcmDragIdx)); ev.dataTransfer.effectAllowed = 'move'; } catch (e2) {}
            });
            rowEl.addEventListener('dragover', (ev) => { ev.preventDefault(); if (Number(rowEl.getAttribute('data-pcm-row')) !== pcmDragIdx) rowEl.style.boxShadow = 'inset 0 2px 0 #7adfe6'; });
            rowEl.addEventListener('dragleave', () => { rowEl.style.boxShadow = ''; });
            rowEl.addEventListener('drop', (ev) => {
                ev.preventDefault();
                rowEl.style.boxShadow = '';
                const to = Number(rowEl.getAttribute('data-pcm-row'));
                if (pcmDragIdx == null || pcmDragIdx === to) return;
                const moved = pcm.picks.splice(pcmDragIdx, 1)[0];
                pcm.picks.splice(to > pcmDragIdx ? to - 1 : to, 0, moved);
                pcmDragIdx = null;
                pcmRefresh();
            });
            rowEl.addEventListener('dragend', () => {
                rowEl.style.opacity = '';
                rowEls.forEach(r2 => { r2.style.boxShadow = ''; });
                pcmDragIdx = null;
            });
        });
    }

    // v2.02: LIVE 400 FIX — a merged create concatenates instructions from
    // SEVERAL missions, each carrying its own server-assigned instruction
    // ids (+ other read-shape fields); the mixed/foreign ids 400 the create.
    // (A single-mission copy passes raw instructions fine — one mission's
    // ids are self-consistent.) Normalize every merged step down to the
    // exact field set the generator's proven creates use: no id, deep-
    // cloned location/extras.
    function pcmNormStep(s) {
        return {
            type: s.type,
            value1: s.value1 === undefined ? null : s.value1,
            value2: s.value2 === undefined ? null : s.value2,
            location: s.location ? JSON.parse(JSON.stringify(s.location)) : null,
            extra_options: s.extra_options ? JSON.parse(JSON.stringify(s.extra_options)) : {},
            polygon_points: s.polygon_points ? JSON.parse(JSON.stringify(s.polygon_points)) : null,
            snapshot_points: s.snapshot_points ? JSON.parse(JSON.stringify(s.snapshot_points)) : null,
        };
    }

    let pcmBusy = false;
    async function pcmCommit() {
        if (pcmBusy) return;
        if (pcm.picks.length < 2) { showToast('Pick at least 2 pads to merge.', '#ff9800', 3000); return; }
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.saveApp !== 'function') { showToast('Mission context not found — be on the Mission Bank page.', '#ff5252', 4000); return; }
        const nameEl = pcm.panelEl && pcm.panelEl.querySelector('[data-pcm-name]');
        const name = ((nameEl && nameEl.value) || '').trim();
        if (!name) { showToast('Give the merged mission a name.', '#ff9800', 3000); return; }
        const exact = (pcm.missions || []).find(m => String((m && m.name) || '').trim().toLowerCase() === name.toLowerCase());
        const editing = pcm.editingName
            ? (pcm.missions || []).find(m => String((m && m.name) || '').trim().toLowerCase() === pcm.editingName.trim().toLowerCase())
            : null;
        if (pcm.editingName && !editing) { showToast(`Mission "${pcm.editingName}" no longer exists — this will CREATE a new one instead.`, '#ff9800', 5000); }
        if (!editing && exact) { showToast(`A mission named "${name}" already exists — pick another name.`, '#ff9800', 4500); return; }
        if (editing && exact && exact.id !== editing.id) { showToast(`Another mission is already named "${name}".`, '#ff9800', 4500); return; }
        const first = pcm.picks[0].mission, last = pcm.picks[pcm.picks.length - 1].mission;
        const to = pcmNormStep(((first.instructions || []).find(i => i && i.type === 0)) || mbMakeStep(0, 20));
        const rh = pcmNormStep((Array.from(last.instructions || []).reverse().find(i => i && i.type === 99)) || mbMakeStep(99));
        const body = [];
        pcm.picks.forEach(p => mbMissionBody(p.mission).forEach(st => body.push(pcmNormStep(st))));
        const instrs = [to].concat(body, [rh]);
        const statusEl = pcm.panelEl && pcm.panelEl.querySelector('[data-pcm-status]');
        if (statusEl) statusEl.textContent = `Creating "${name}" (${body.length} steps)…`;
        pcmBusy = true;
        try {
            if (editing) {
                // Update IN PLACE: full clone of the existing mission with the
                // rebuilt instruction list — id preserved, everything else kept.
                const app = JSON.parse(JSON.stringify(editing));
                app.instructions = instrs;
                await ctx.saveApp(app, name);
            } else {
                await ctx.saveApp({ id: null, type: 1, instructions: instrs, data_report_object_arr: [] }, name);
            }
        } catch (e) {
            pcmBusy = false;
            console.warn(`${TAG} [pcm] create failed`, e);
            showToast(`🔗 Merge create FAILED — ${String(e && e.message || e)}`, '#ff5252', 6000);
            if (statusEl) statusEl.textContent = 'Create failed — see console.';
            return;
        }
        pcmBusy = false;
        pcmSaveRecipe(getCurrentSiteID(), name);
        if (pcm.editingName && pcm.editingName !== name) pcmDeleteRecipe(getCurrentSiteID(), pcm.editingName);
        const verb = editing ? 'Updated' : 'Created';
        const refreshed = refreshMissionList();
        showToast(`🔗 ${verb} "${name}" — ${body.length} steps from ${pcm.picks.length} missions. Re-edit any time via ✏ saved merges.${refreshed ? '' : ' Reload the list to see it.'}`, '#5fff5f', 7000);
        console.log(`${TAG} [pcm] ${verb.toLowerCase()} "${name}" from ${pcm.picks.length} missions (${body.length} steps + takeoff/land)`);
        pcmExit();
    }

    // ---------------- Cross-site mission copy ----------------
    const CPM_PANEL_ID = 'aim-mb-copy-panel';
    let cpmBusy = false;

    function openCopyMissionsPanel() {
        const old = document.getElementById(CPM_PANEL_ID);
        if (old) { old.remove(); return; }
        const sid = getCurrentSiteID();
        if (!sid) { showToast('No site loaded.', '#ff5252', 3000); return; }
        let lastSrc = '';
        try { if (typeof GM_getValue === 'function') lastSrc = GM_getValue(IS_QA ? 'qa-aim-mb-copy-src' : 'aim-mb-copy-src', '') || ''; } catch (e) {}
        const p = document.createElement('div');
        p.id = CPM_PANEL_ID;
        p.style.cssText = 'position:fixed;top:60px;right:24px;width:390px;max-height:80vh;display:flex;flex-direction:column;z-index:2147483601;'
            + 'background:#161a20;border:1px solid #7adfe6;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.7);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;';
        p.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 12px;background:rgba(122,223,230,0.08);border-bottom:1px solid rgba(122,223,230,0.3);">
                <span style="font-weight:800;color:#7adfe6;font-size:14px;">📥 Copy missions → site ${escapeHtml(String(sid))}</span>
                <button data-cpm-close style="background:rgba(255,255,255,0.12);border:none;color:#fff;width:22px;height:22px;border-radius:4px;cursor:pointer;">✕</button>
            </div>
            <div style="display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #2a2f38;">
                <label style="font-size:11px;color:#9ad;white-space:nowrap;">Source site ID</label>
                <input data-cpm-src type="text" value="${escapeHtml(lastSrc)}" style="width:90px;background:#0e1218;color:#e6e6e6;border:1px solid #2a3340;border-radius:4px;padding:3px 6px;font-size:12px;" />
                <button data-cpm-load style="padding:4px 10px;background:#7adfe6;border:none;color:#04222a;border-radius:5px;cursor:pointer;font-weight:800;font-size:11px;">Load</button>
            </div>
            <div data-cpm-list style="overflow:auto;flex:1;padding:4px 10px;font-size:11px;color:#888;">Enter the source site ID and Load. Copy is create-only — mission names already on this site are skipped.</div>
            <div style="padding:9px 12px;border-top:1px solid #2a2f38;display:flex;align-items:center;gap:8px;">
                <span data-cpm-status style="flex:1;font-size:11px;color:#9ad;"></span>
                <button data-cpm-go style="padding:6px 12px;background:#5fff5f;border:none;color:#04220a;border-radius:6px;cursor:pointer;font-weight:800;" disabled>📥 Copy 0</button>
            </div>`;
        document.body.appendChild(p);
        p.querySelector('[data-cpm-close]').onclick = () => { if (!cpmBusy) p.remove(); };
        let loaded = null;
        const listEl = p.querySelector('[data-cpm-list]');
        const goBtn = p.querySelector('[data-cpm-go]');
        const statusEl = p.querySelector('[data-cpm-status]');
        const updateGo = () => {
            const n = loaded ? listEl.querySelectorAll('input[data-cpm-pick]:checked').length : 0;
            goBtn.textContent = `📥 Copy ${n}`;
            goBtn.disabled = cpmBusy || !n;
        };
        p.querySelector('[data-cpm-load]').onclick = async () => {
            const srcId = String(p.querySelector('[data-cpm-src]').value || '').trim();
            if (!/^\d+$/.test(srcId)) { showToast('Source site ID must be a number.', '#ff9800', 3000); return; }
            if (srcId === String(sid)) { showToast('Source IS this site — use 🔗 Merge for same-site work.', '#ff9800', 4000); return; }
            try { if (typeof GM_setValue === 'function') GM_setValue(IS_QA ? 'qa-aim-mb-copy-src' : 'aim-mb-copy-src', srcId); } catch (e) {}
            listEl.innerHTML = '<div style="padding:8px;color:#9ad;">Loading…</div>';
            try {
                const [srcArr, tgtArr] = await Promise.all([
                    fetch(`/available_app/?site_id=${encodeURIComponent(srcId)}&type=1`, { credentials: 'include' })
                        .then(r => { if (!r.ok) throw new Error(`source HTTP ${r.status}`); return r.json(); }),
                    fetch(`/available_app/?site_id=${encodeURIComponent(sid)}&type=1`, { credentials: 'include' })
                        .then(r => { if (!r.ok) throw new Error(`target HTTP ${r.status}`); return r.json(); }),
                ]);
                if (!Array.isArray(srcArr)) throw new Error('unexpected source response shape');
                const tgtNames = new Set((Array.isArray(tgtArr) ? tgtArr : []).map(m => String((m && m.name) || '').trim().toLowerCase()));
                loaded = { src: srcArr };
                if (!srcArr.length) { listEl.innerHTML = '<div style="padding:8px;color:#ff9800;">Source site has no missions.</div>'; updateGo(); return; }
                listEl.innerHTML = `<div style="padding:4px 2px;color:#9ad;">${srcArr.length} mission(s) on site ${escapeHtml(srcId)} · <a data-cpm-all href="#" style="color:#7adfe6;">all</a> / <a data-cpm-none href="#" style="color:#7adfe6;">none</a></div>`
                    + srcArr.map((m, i) => {
                        const dup = tgtNames.has(String((m && m.name) || '').trim().toLowerCase());
                        const steps = mbMissionBody(m).length;
                        return `<label style="display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid #20262e;${dup ? 'opacity:0.5;' : 'cursor:pointer;'}">
                            <input type="checkbox" data-cpm-pick="${i}" ${dup ? 'disabled' : 'checked'} />
                            <span style="flex:1;color:#e6e6e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(String(m.name || ('#' + m.id)))}</span>
                            <span style="color:#9ad;white-space:nowrap;">${steps} steps</span>
                            ${dup ? '<span style="color:#ff9800;font-size:10px;white-space:nowrap;">exists — skipped</span>' : ''}
                        </label>`;
                    }).join('');
                listEl.querySelectorAll('input[data-cpm-pick]').forEach(cb => { cb.onchange = updateGo; });
                const allA = listEl.querySelector('[data-cpm-all]'), noneA = listEl.querySelector('[data-cpm-none]');
                if (allA) allA.onclick = (ev) => { ev.preventDefault(); listEl.querySelectorAll('input[data-cpm-pick]:not(:disabled)').forEach(cb => { cb.checked = true; }); updateGo(); };
                if (noneA) noneA.onclick = (ev) => { ev.preventDefault(); listEl.querySelectorAll('input[data-cpm-pick]').forEach(cb => { if (!cb.disabled) cb.checked = false; }); updateGo(); };
                updateGo();
            } catch (e) {
                console.warn(`${TAG} [copy] load failed`, e);
                listEl.innerHTML = `<div style="padding:8px;color:#ff8a8a;">Load failed — ${escapeHtml(String(e && e.message || e))}</div>`;
                loaded = null;
                updateGo();
            }
        };
        goBtn.onclick = async () => {
            if (!loaded || cpmBusy) return;
            const ctx = findMissionAppCtx();
            if (!ctx || typeof ctx.saveApp !== 'function') { showToast('Mission context not found — be on the Mission Bank page.', '#ff5252', 4000); return; }
            const picks = Array.from(listEl.querySelectorAll('input[data-cpm-pick]:checked'))
                .map(cb => loaded.src[Number(cb.getAttribute('data-cpm-pick'))]).filter(Boolean);
            if (!picks.length) return;
            cpmBusy = true; updateGo();
            let ok = 0, fail = 0;
            for (let i = 0; i < picks.length; i++) {
                const m = picks[i];
                statusEl.textContent = `Copying ${i + 1}/${picks.length} — ${m.name}…`;
                try {
                    await ctx.saveApp({ id: null, type: 1, instructions: (m.instructions || []), data_report_object_arr: [] }, m.name);
                    ok++;
                } catch (e) { fail++; console.warn(`${TAG} [copy] failed "${m.name}"`, e); }
            }
            cpmBusy = false;
            const refreshed = ok ? refreshMissionList() : false;
            statusEl.textContent = `Done — copied ${ok}${fail ? `, ${fail} failed` : ''}.`;
            showToast(`📥 Copied ${ok} mission(s)${fail ? ` · ${fail} failed (see console)` : ''}.${ok && !refreshed ? ' Reload the list to see them.' : ''}`, ok ? '#5fff5f' : '#ff5252', 7000);
            console.log(`${TAG} [copy] copied ${ok}, failed ${fail} → site ${sid}`);
            updateGo();
        };
    }

    const MB_MERGE_PANEL_ID = 'aim-mb-merge-panel';
    let mbMergeBusy = false;
    function mbCloseMergePanel() { const p = document.getElementById(MB_MERGE_PANEL_ID); if (p) p.remove(); try { agClearRoutes(); } catch (e) {} }
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
    // Per-group route-preview overlays (v2.15) — polyline base→pads→base in
    // group color + numbered dots + 🔋 markers at simulated recharge breaks.
    let agRouteLayers = [];
    function agClearRoutes(gi) {
        agRouteLayers = agRouteLayers.filter(r => {
            if (gi != null && r.gi !== gi) return true;
            r.layers.forEach(l => { try { l.remove(); } catch (e) {} });
            return false;
        });
    }
    function agToggleRoute(g, gi, color, ent, data) {
        const had = agRouteLayers.some(r => r.gi === gi);
        agClearRoutes(gi);
        if (had) return false;
        const L = composerGetL(), map = getLeafletMap();
        if (!L || !map) { showToast('Map not found for the route preview.', '#ff9800', 2500); return false; }
        const base = ent && ent.base;
        const ag = data && data.ag;
        const layers = [];
        try {
            // Draw the ACTUAL flown route along FPs/FFZ shortcuts (v2.16 —
            // straight pad-to-pad lines were wrong). One polyline per flight:
            // base → pads → base, legs reconstructed from the order graph.
            const ll = p => [p.lat, p.lng];
            const drawSeq = (idxSeq) => {
                if (!idxSeq.length) return;
                let pts = [];
                if (ag) {
                    pts = ag.basePath(idxSeq[0]).map(ll);
                    for (let x = 1; x < idxSeq.length; x++) pts = pts.concat(ag.padPath(idxSeq[x - 1], idxSeq[x]).slice(1).map(ll));
                    const home = ag.basePath(idxSeq[idxSeq.length - 1]).map(ll).reverse();
                    pts = pts.concat(home.slice(1));
                } else {
                    if (base) pts.push(ll(base));
                    idxSeq.forEach(i => pts.push(ll(data.agSolos[i].pt)));
                    if (base) pts.push(ll(base));
                }
                layers.push(L.polyline(pts, { color, weight: 3, opacity: 0.85, dashArray: '7 5', interactive: false }).addTo(map));
            };
            if (g.sim && g.idxs) g.sim.flights.forEach(f => drawSeq(f.pads));
            else if (g.idxs) drawSeq(g.idxs);
            else {
                const pts = [];
                if (base) pts.push([base.lat, base.lng]);
                g.solos.forEach(s => { if (s.pt) pts.push([s.pt.lat, s.pt.lng]); });
                if (base) pts.push([base.lat, base.lng]);
                layers.push(L.polyline(pts, { color, weight: 3, opacity: 0.85, dashArray: '7 5', interactive: false }).addTo(map));
            }
            const breaks = new Set();
            if (g.sim && g.sim.flights.length > 1) { let acc = 0; g.sim.flights.slice(0, -1).forEach(f => { acc += f.pads.length; breaks.add(acc - 1); }); }
            g.solos.forEach((s, i) => {
                if (!s.pt) return;
                const icon = L.divIcon({
                    className: 'aim-mb-ag-badge',
                    html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};color:#111;font:800 11px/20px monospace;text-align:center;border:2px solid #111;box-shadow:0 1px 5px rgba(0,0,0,0.6);">${i + 1}</div>${breaks.has(i) ? '<div style="position:absolute;top:-13px;left:12px;font-size:13px;">🔋</div>' : ''}`,
                    iconSize: [20, 20], iconAnchor: [10, 10],
                });
                layers.push(L.marker([s.pt.lat, s.pt.lng], { icon, interactive: false }).addTo(map));
            });
        } catch (e) { console.warn(`${TAG} [ag] route preview failed`, e); }
        agRouteLayers.push({ gi, layers });
        return true;
    }

    // Hand a proposed group to the pad-click merge editor — full edit UX
    // (renumber, remove, rename, recipe save, single-group create).
    function agStageInPcm(g, missions, ent) {
        pcm.missions = missions || [];
        pcm.assets = (ent && ent.assets) || [];
        pcm.base = (ent && ent.base) || null;
        pcm.picks = g.solos.map(s => ({
            asset: pcm.assets.find(a => s.pt && Array.isArray(a.ring) && a.ring.length >= 3 && genPointInPoly(s.pt, a.ring)) || { id: null, name: s.mission.name, ring: null },
            mission: s.mission,
        }));
        pcm.customName = g.name; pcm.editingName = null; pcm.pendingChoice = null;
        if (!pcm.on) {
            pcm.on = true;
            try { document.documentElement.setAttribute('data-aim-merge', '1'); } catch (e) {}
            pcmBind();
            const btn = document.querySelector('[data-pcm-toggle]');
            if (btn) btn.classList.add('active');
        }
        mbCloseMergePanel();
        pcmRefresh();
        showToast(`🔗 "${g.name}" staged in the merge editor (optimized order) — review, then Create.`, '#5fff5f', 5000);
    }

    // Bank every proposed group as a pcm merge recipe (no missions created).
    function agSaveGroupRecipes(mergeGroups, siteID, ent) {
        if (typeof GM_setValue !== 'function') { showToast('GM storage unavailable — can\'t save recipes.', '#ff5252', 3000); return; }
        const assets = (ent && ent.assets) || [];
        const all = pcmLoadRecipes();
        mergeGroups.forEach(g => {
            all[pcmRecipeKey(siteID, g.name)] = {
                site: String(siteID), name: g.name, at: Date.now(),
                picks: g.solos.map(s => {
                    const a = assets.find(a2 => s.pt && Array.isArray(a2.ring) && a2.ring.length >= 3 && genPointInPoly(s.pt, a2.ring));
                    return { assetId: a ? a.id : null, assetName: a ? a.name : s.mission.name, missionName: s.mission.name };
                }),
            };
        });
        try {
            GM_setValue(PCM_RECIPES_KEY, JSON.stringify(all));
            showToast(`💾 Saved ${mergeGroups.length} recipe(s) — load them any time from the 🔗 Merge panel's "saved merges".`, '#5fff5f', 5500);
        } catch (e) { console.warn(`${TAG} [ag] recipe save failed`, e); showToast('Recipe save failed (see console).', '#ff5252', 3500); }
    }

    function mbRenderMergePanel(data, siteID, missions, ent, overrides, rerender) {
        mbCloseMergePanel();
        const cfg = agCfg();
        const ft = m => m == null ? '—' : `${Math.round(m * 3.28084).toLocaleString()} ft`;
        const kft = f => f == null ? '—' : `${(Math.round(f / 100) / 10).toLocaleString()}k ft`;
        // Family picker (v2.16): each stop can be pinned into any of the sweep
        // families by INDEX (names are emergent, indexes are stable per render).
        const famOf = new Map();
        (data.families || []).forEach((f, fi) => f.solos.forEach(s => famOf.set(s.mission.id, fi)));
        const famOpts = (cur) => (data.families || []).map((f, fi) => `<option value="${fi}" ${fi === cur ? 'selected' : ''}>${escapeHtml(f.name || `Group ${fi + 1}`)}</option>`).join('');
        const mergeGroups = data.groups.filter(g => g.solos);
        const exclGroups = data.groups.filter(g => g.excluded);
        const AG_COLORS = ['#7adfe6', '#ffd54f', '#ff8ad2', '#9dff8a', '#c39dff', '#ffab73', '#8ab6ff', '#f3ff7a', '#ff9e9e', '#7affc9'];
        const chip = (b) => b ? `<span style="background:${b.color}22;color:${b.color};border:1px solid ${b.color}66;border-radius:4px;padding:0 5px;font-size:10px;font-weight:700;white-space:nowrap;">${b.label}</span>` : '';
        const reserveChip = (pct) => {
            const target = 100 - cfg.marginPct;
            const col = pct >= target - 2 ? '#5fff5f' : (pct >= 10 ? '#ffb74d' : '#ff5252');
            return `<span title="estimated battery on landing" style="color:${col};font-weight:700;">${pct}%</span>`;
        };
        const soloRow = (s, i) => `<div style="display:flex;align-items:center;gap:6px;padding:3px 4px;border-bottom:1px solid #20262e;">
            <span style="color:#7adfe6;font-weight:800;font-size:10px;min-width:16px;text-align:right;">${i + 1}</span>
            <span style="flex:1;color:#e6e6e6;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.mission.name || ('#' + s.mission.id))}</span>
            <span style="color:#9ad;font-size:10px;white-space:nowrap;">${ft(s.routeM)}</span>
            ${chip(s.battery)}
            <select data-mb-ov="${s.mission.id}" title="Move this stop to another group" style="background:#0e1218;color:#cde;border:1px solid #2a3340;border-radius:4px;font-size:10px;padding:1px 2px;">${famOpts(famOf.get(s.mission.id))}</select>
        </div>`;
        const groupRows = (g) => {
            const breaks = new Set();
            if (g.sim && g.sim.flights.length > 1) { let acc = 0; g.sim.flights.slice(0, -1).forEach(f => { acc += f.pads.length; breaks.add(acc - 1); }); }
            return g.solos.map((s, i) => soloRow(s, i)
                + (breaks.has(i) ? '<div style="text-align:center;color:#ffb74d;font-size:9px;padding:1px 0;border-bottom:1px dashed #3a3320;">— 🔋 return &amp; recharge —</div>' : '')).join('');
        };
        const simLine = (g) => {
            if (!g.sim) return `<div style="padding:2px 8px 4px;font-size:10px;color:#789;">no optimizer (need FP graph + base) — furthest→closest order</div>`;
            const s = g.sim;
            return `<div style="padding:2px 8px 5px;font-size:10px;color:#9ad;">est <b style="color:#cde;">${kft(s.totalFt)}</b> <span style="color:#789;">(${kft(s.overheadFt)} RTB legs)</span> · 🔋 <b style="color:#cde;">${s.flights.length}</b> flight${s.flights.length === 1 ? '' : 's'} · land ${s.flights.map(f => reserveChip(f.reservePct)).join(' / ')}${s.tight.length ? `<span style="color:#ff5252;font-weight:700;"> · ⚠ ${s.tight.length} pad${s.tight.length === 1 ? '' : 's'} won't fit one flight</span>` : ''}</div>`;
        };
        const groupBlock = (g, gi) => {
            const stepsTotal = g.solos.reduce((t, s) => t + pcmStepCount(s.mission), 0);
            const col = AG_COLORS[gi % AG_COLORS.length];
            return `<div style="margin:6px 0;border:1px solid #2a3a2a;border-radius:6px;overflow:hidden;">
            <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:rgba(95,255,95,0.08);">
                <span style="width:9px;height:9px;border-radius:50%;background:${col};flex:none;"></span>
                <span style="font-weight:800;color:#7dff7d;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">⛟ ${escapeHtml(g.name)}</span>
                <span style="color:#9ad;font-size:10px;white-space:nowrap;">${g.solos.length} stops · ${stepsTotal > cfg.stepMax ? `<b style="color:#ffb74d;">${stepsTotal} steps</b>` : `${stepsTotal} steps`} · ${g.battery}</span>
                <button data-ag-route="${gi}" title="Show/hide this route on the map" style="padding:1px 6px;background:rgba(122,223,230,0.14);border:1px solid rgba(122,223,230,0.5);color:#7adfe6;border-radius:4px;cursor:pointer;font-size:11px;">👁</button>
                <button data-ag-edit="${gi}" title="Open this group in the pad-click merge editor (reorder / rename / create just this one)" style="padding:1px 6px;background:rgba(255,213,79,0.12);border:1px solid rgba(255,213,79,0.5);color:#ffd54f;border-radius:4px;cursor:pointer;font-size:11px;">🔗</button>
            </div>
            ${simLine(g)}
            <div style="padding:2px 4px;">${groupRows(g)}</div>
        </div>`;
        };
        const knob = (k, label, title, step) => `<label title="${escapeHtml(title)}" style="display:flex;align-items:center;gap:3px;font-size:10px;color:#9ad;white-space:nowrap;">${label}
            <input data-ag-k="${k}" type="number" step="${step || 1}" min="1" value="${cfg[k]}" style="width:56px;background:#0e1218;color:#e6e6e6;border:1px solid #2a3340;border-radius:4px;padding:1px 4px;font-size:10px;"></label>`;
        const exclBlock = (g) => `<div style="margin:5px 0;padding:4px 8px;border:1px solid #3a2a2a;border-radius:6px;">
            <div style="color:#ff8a8a;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px;">${escapeHtml(g.name)} · ${g.excluded.length}</div>
            ${g.excluded.map(s => `<div style="display:flex;align-items:center;gap:6px;padding:2px 2px;font-size:11px;color:#caa;"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.mission.name || ('#' + s.mission.id))}</span><span style="color:#a66;font-size:10px;">${escapeHtml(s.reason || (s.battery && s.battery.level === 2 ? `over ${agCfg().tulipRadiusFt.toLocaleString()} ft range` : ''))}</span></div>`).join('')}
        </div>`;
        const routable = data.solos.filter(s => s.routeM != null).length;
        // Full-site estimate = the superset tier per section ("X 2" / "X 1-2") —
        // you fly ONE tier per section, so summing every group would double-count.
        const primary = mergeGroups.filter(g => / (2|1-2)$/.test(g.name) && g.sim);
        const totFt = primary.length ? primary.reduce((t, g) => t + g.sim.totalFt, 0) : null;
        const totFlights = primary.length ? primary.reduce((t, g) => t + g.sim.flights.length, 0) : null;
        const p = document.createElement('div');
        p.id = MB_MERGE_PANEL_ID;
        p.style.cssText = 'position:fixed;top:60px;right:24px;width:470px;max-height:84vh;display:flex;flex-direction:column;z-index:2147483600;' +
            'background:#161a20;border:1px solid #5fff5f;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.7);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;';
        p.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 12px;background:rgba(95,255,95,0.08);border-bottom:1px solid rgba(95,255,95,0.3);">
                <span style="font-weight:800;color:#7dff7d;font-size:14px;">🧠 Auto-Group — Merge by Section + Battery</span>
                <button data-mb-merge-close style="background:rgba(255,255,255,0.12);border:none;color:#fff;width:22px;height:22px;border-radius:4px;cursor:pointer;">✕</button>
            </div>
            <div style="padding:7px 12px;font-size:11px;color:#bbb;border-bottom:1px solid #2a2f38;">
                <b style="color:#7dff7d;">${missions.length}</b> solo missions · <b style="color:#9ad;">${routable}</b> routable · <b style="color:#7dff7d;">${mergeGroups.length}</b> merge groups${totFt != null ? ` · full site ≈ <b style="color:#7dff7d;">${kft(totFt)}</b> / ${totFlights} flights` : ''}${data.routerReady ? '' : ' · <b style="color:#ff8a8a;">no routing data (no FPs/base)</b>'}${data.agReady ? '' : ' · <b style="color:#ffb74d;">optimizer off — distance sort</b>'}${data.offGraphPairs ? ` · <b style="color:#ffb74d;">⚠ ${data.offGraphPairs} leg(s) estimated off-graph</b>` : ''}
                <div style="margin-top:3px;color:#789;">Order = 2-opt + flight simulator (breaks planned near base; multi-flight is normal). X 1 = Tattu subset, X 2 = + Tulip. 👁 route on map · 🔗 edit one group · dropdown moves a stop to another group.</div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:6px 12px;border-bottom:1px solid #2a2f38;">
                ${knob('tattuRadiusFt', 'Tattu≤', 'Tattu tier radius: pads whose one-way route is within this fly on Tattu', 500)}
                ${knob('tulipRadiusFt', 'Tulip≤', 'Tulip tier radius: beyond this a pad is excluded as unflyable', 500)}
                ${knob('tattuBudgetFt', 'T-bud', 'Tattu full-battery TOTAL flight budget (ft-equivalents)', 1000)}
                ${knob('tulipBudgetFt', 'U-bud', 'Tulip full-battery TOTAL flight budget (ft-equivalents)', 1000)}
                ${knob('marginPct', 'use%', 'Usable % of the budget — the rest is the landing reserve', 1)}
                ${knob('stepCostFt', 'ft/step', 'Battery cost per mission step, in ft-equivalents (captures/hover)', 10)}
                ${knob('stepMax', 'max steps', 'Soft step target per merged mission — drives how many groups the sweep cuts (multi-flight is fine)', 25)}
                ${knob('targetGroups', 'groups', 'Max direction groups (families) for the whole site — battery tiers can double the mission count', 1)}
                <button data-ag-reset title="Reset all knobs to defaults" style="padding:1px 7px;background:none;border:1px solid #2a3340;color:#789;border-radius:4px;cursor:pointer;font-size:10px;">↺</button>
            </div>
            <div style="overflow:auto;flex:1;padding:4px 10px;">
                ${mergeGroups.length ? mergeGroups.map(groupBlock).join('') : '<div style="padding:12px;color:#888;">No mergeable groups (need routable solos).</div>'}
                ${exclGroups.length ? `<div style="margin-top:6px;color:#ff8a8a;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;">Excluded (not merged)</div>${exclGroups.map(exclBlock).join('')}` : ''}
            </div>
            <div style="padding:9px 12px;border-top:1px solid #2a2f38;display:flex;align-items:center;gap:8px;">
                <span data-mb-merge-status style="flex:1;font-size:11px;color:#9ad;"></span>
                <button data-ag-recipes title="Save every group's ordered pad list as a merge recipe (creates NO missions)" style="padding:5px 9px;background:rgba(122,223,230,0.14);border:1px solid rgba(122,223,230,0.5);color:#7adfe6;border-radius:5px;cursor:pointer;font-size:11px;" ${mergeGroups.length ? '' : 'disabled'}>💾 Recipes</button>
                <button data-mb-merge-go style="padding:6px 12px;background:#5fff5f;border:none;color:#04220a;border-radius:6px;cursor:pointer;font-weight:800;" ${mergeGroups.length && !mbMergeBusy ? '' : 'disabled'}>⛟ Create ${mergeGroups.length} merged</button>
            </div>`;
        document.body.appendChild(p);
        p.querySelector('[data-mb-merge-close]').onclick = mbCloseMergePanel;
        p.querySelectorAll('[data-mb-ov]').forEach(sel => sel.onchange = () => { overrides[sel.getAttribute('data-mb-ov')] = sel.value; rerender(); });
        p.querySelectorAll('[data-ag-k]').forEach(inp => inp.onchange = () => {
            const patch = {}; patch[inp.getAttribute('data-ag-k')] = Number(inp.value);
            agSetCfg(patch); rerender();
        });
        p.querySelector('[data-ag-reset]').onclick = () => { agSetCfg(Object.assign({}, AG_DEFAULTS)); rerender(); };
        p.querySelectorAll('[data-ag-route]').forEach(b => b.onclick = () => {
            const gi = Number(b.getAttribute('data-ag-route'));
            const on = agToggleRoute(mergeGroups[gi], gi, AG_COLORS[gi % AG_COLORS.length], ent, data);
            b.style.background = on ? 'rgba(122,223,230,0.45)' : 'rgba(122,223,230,0.14)';
        });
        p.querySelectorAll('[data-ag-edit]').forEach(b => b.onclick = () => agStageInPcm(mergeGroups[Number(b.getAttribute('data-ag-edit'))], missions, ent));
        const rcp = p.querySelector('[data-ag-recipes]');
        if (rcp) rcp.onclick = () => agSaveGroupRecipes(mergeGroups, siteID, ent);
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
            // takeoff + each solo's body (no takeoff/return) in optimized order + returnHome.
            // pcmNormStep strips the per-mission server instruction ids — mixed
            // foreign ids 400 a merged create (v2.02 lesson, applied here v2.15).
            const body = [];
            g.solos.forEach(s => mbMissionBody(s.mission).forEach(st => body.push(pcmNormStep(st))));
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

    // ── Step presets: capture ANY configured step in the open editor (Wait,
    // Camera Type, GEM, Camera Pitch, Flag Pole, maneuvers…) as a named preset,
    // persisted in GM storage forever, and stage clones of it from the ➕ Stage
    // popup. Clone-based ON PURPOSE — creating instructions from scratch trips
    // Percepto's createInstruction type-mangling (see genStageSteps header), so
    // a new type needs one native add+configure, once ever, then lives here.
    // Wait + Camera Type presets get inline quick-edit controls in the popup
    // (seconds / RGB-vs-Thermal) whose edits persist to the preset.
    const CACHE_KEY_STEP_PRESETS = 'aim-mb-step-presets';
    const CACHE_KEY_STAGE_LAST = 'aim-mb-stage-last';
    function stagePresetsLoad() { const o = gmGet(CACHE_KEY_STEP_PRESETS, {}); return (o && typeof o === 'object') ? o : {}; }
    function stagePresetsSave(o) { try { gmSet(CACHE_KEY_STEP_PRESETS, o || {}); } catch (e) { console.warn(`${TAG} [stage] preset save failed`, e); } }
    function stagePresetDefaultName(s) {
        const t = tplTypeNum(s);
        if (t === 5) return `Wait ${Math.round(Number(s.value1) || 0)}s`;
        if (t === 7) return s.value1 ? 'Camera Thermal' : 'Camera RGB';
        if (t === 24) return Number(s.value1) === 1 ? 'GEM On' : 'GEM Off';
        return s.type_name ? s.type_name : `type ${t}`;
    }
    function stageCaptureOpenStep(idOverride) {
        const openId = (idOverride != null) ? idOverride : getOpenStepId();
        const ctx = findMissionAppCtx();
        let instrs = (ctx && ctx.currentApp && ctx.currentApp.instructions) || [];
        if (!instrs.length) { try { const lc = findMissionEditorCtx(); if (lc && Array.isArray(lc.instrs)) instrs = lc.instrs; } catch (e) {} }
        const s = (openId != null) ? instrs.find(x => x && String(x.id) === String(openId)) : null;
        if (!s) { showToast('Click a step to open its edit form first, then capture.', '#ff9800', 4500); return false; }
        // The default name previews WHAT got grabbed (e.g. "Wait 5s") — a wrong
        // step is obvious before saving.
        const name = (window.prompt('Save step preset as:', stagePresetDefaultName(s)) || '').trim();
        if (!name) return false;
        const instr = JSON.parse(JSON.stringify(s));
        delete instr.id; delete instr.index_in_app;
        const all = stagePresetsLoad();
        // New presets append to the end of the user-ordered list.
        const maxOrder = Object.values(all).reduce((m, p) => Math.max(m, p && p.order != null ? p.order : 0), 0);
        all[name] = { name, savedAt: Date.now(), order: maxOrder + 10, instr };
        stagePresetsSave(all);
        console.log(`${TAG} [stage] captured step preset "${name}" (type ${tplTypeNum(instr)})`);
        showToast(`Saved step preset "${name}".`, '#5fff5f', 3000);
        return true;
    }
    // ── Armed capture: opening a step's edit form SWAPS the sidebar (killing
    // the ➕ Stage row) and the click closes the popup — so capturing "the open
    // step" directly is only possible if a form is already open. Arming solves
    // the catch-22: 📋 with no form open closes the popup into a floating chip
    // and captures WHICHEVER step you open next (focusedInstructionId change).
    let stageArmPoll = null, stageArmChip = null, stageArmPick = null;
    function stageCancelArm(silent) {
        if (stageArmPoll) { clearInterval(stageArmPoll); stageArmPoll = null; }
        if (stageArmChip) { stageArmChip.remove(); stageArmChip = null; }
        if (stageArmPick) { document.removeEventListener('click', stageArmPick, true); stageArmPick = null; }
        if (!silent) console.log(`${TAG} [stage] capture arm cleared`);
    }
    function stageArmCapture() {
        stageCancelArm(true);
        let baseline = null;
        try { baseline = findFocusedInstrId(); } catch (e) {}
        // PRIMARY pick path (v1.95): capture-phase click. The step CARD carries
        // its instruction id in data-rfd-draggable-id and our map badges carry
        // data-aim-id — no React focus read needed (focusedInstructionId proved
        // unreadable on some routes: formOpen:true fid:null on site 1153).
        // Swallow the click so the form doesn't even need to open.
        stageArmPick = (e) => {
            const hit = e.target && e.target.closest && e.target.closest('[data-rfd-draggable-id], .instruction-marker[data-aim-id], .leaflet-marker-icon[data-aim-id]');
            if (!hit) return;
            const id = hit.getAttribute('data-rfd-draggable-id') || hit.getAttribute('data-aim-id');
            if (id == null || id === '') return;
            e.preventDefault(); e.stopPropagation();
            stageCancelArm(true);
            if (stageCaptureOpenStep(id)) showToast('Preset saved — reopen ➕ Stage to use it.', '#5fff5f', 4000);
        };
        document.addEventListener('click', stageArmPick, true);
        const chip = document.createElement('div');
        chip.textContent = '📋 Capture armed — click the step CARD in the list (or its N#/S# map badge). Click here to cancel.';
        chip.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:2147483600;' +
            'background:rgba(150,180,255,0.95);color:#06223a;font:700 12px/1.3 "Lato",sans-serif;' +
            'padding:6px 14px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.5);cursor:pointer;max-width:80vw;';
        chip.onclick = () => { stageCancelArm(); showToast('Capture cancelled.', '#888', 2000); };
        document.body.appendChild(chip);
        stageArmChip = chip;
        const t0 = Date.now();
        let formSince = 0, lastDiag = 0;
        stageArmPoll = setInterval(() => {
            const now = Date.now();
            if (now - t0 > 60000) { stageCancelArm(); showToast('Capture timed out.', '#888', 2500); return; }
            let fid = null;
            try { fid = findFocusedInstrId(); } catch (e) {}
            const formOpen = !!document.querySelector('.edit-instruction');
            if (formOpen && !formSince) formSince = now;
            if (!formOpen) formSince = 0;
            if (now - lastDiag > 3000) { lastDiag = now; console.log(`${TAG} [stage] armed — formOpen:${formOpen} fid:${fid} baseline:${baseline}`); }
            // Trigger A (backup): a step edit form MOUNTED (.edit-instruction) and
            // the focus id is readable. On routes where focusedInstructionId is
            // unreadable (fid stays null) this just keeps waiting — the click-pick
            // listener is the primary path and the 3s diag line explains state.
            if (formOpen) {
                if (fid == null && now - formSince < 1200) return;
                if (fid == null) fid = getOpenStepId();
                if (fid == null) return;
                stageCancelArm(true);
                if (stageCaptureOpenStep(fid)) showToast('Preset saved — reopen ➕ Stage to use it.', '#5fff5f', 4000);
                return;
            }
            // Trigger B: focus moved to a DIFFERENT step than at arm time (card
            // click that highlights without opening a form).
            if (fid != null && String(fid) !== String(baseline)) {
                stageCancelArm(true);
                if (stageCaptureOpenStep(fid)) showToast('Preset saved — reopen ➕ Stage to use it.', '#5fff5f', 4000);
            }
        }, 300);
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
    function genStageSteps(navCount, snapCount, inspectionScan, insertAtNav, presetReqs, insertMode) {
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
        // Saved step presets: clone the captured instruction verbatim (settings
        // travel with it); located types (e.g. Flag Pole) land in the map-center
        // fan like navs/snaps, location-less types (Wait/Camera/GEM) stay bare.
        (presetReqs || []).forEach(req => {
            for (let k = 0; k < req.count; k++) {
                const c = JSON.parse(JSON.stringify(req.preset.instr));
                c.id = idSeq++;
                if (c.location && c.location.lat != null) {
                    const l = placeAt(c, placeIdx++);
                    if (l) c.location = { lat: l.lat, lng: l.lng };
                }
                staged.push(c);
            }
        });
        if (!staged.length) { showToast('Nothing to stage.', '#888'); return; }
        // Rebuild the instruction list (shallow-copy existing so we don't mutate
        // live objects), insert the staged steps, re-index.
        const newInstrs = instrs.map(s => Object.assign({}, s));
        const endIdx = () => { const rh = newInstrs.findIndex(isReturn); return rh < 0 ? newInstrs.length : rh; };
        // Insert position (v1.97 — group-relative, predictable):
        //   'start' → right AFTER the Nth Navigate (top of its group)
        //   'end'   → right BEFORE the (N+1)th Navigate (bottom of its group),
        //             or before returnHome when N is the last group.
        // Blank Nav # → very end (before returnHome).
        let insertIdx;
        const mode = insertMode === 'end' ? 'end' : 'start';
        if (insertAtNav && insertAtNav >= 1) {
            const navIdxs = [];
            newInstrs.forEach((s, k) => { if (isNav(s)) navIdxs.push(k); });
            if (insertAtNav <= navIdxs.length) {
                insertIdx = (mode === 'end')
                    ? ((insertAtNav < navIdxs.length) ? navIdxs[insertAtNav] : endIdx())
                    : navIdxs[insertAtNav - 1] + 1;
            } else {
                insertIdx = endIdx();
            }
        } else {
            insertIdx = endIdx();
        }
        newInstrs.splice(insertIdx, 0, ...staged);
        newInstrs.forEach((s, k) => { if (s) s.index_in_app = k; });
        const posMsg = (insertAtNav && insertAtNav >= 1) ? ` at ${mode} of N${insertAtNav} group` : '';
        try {
            ctx.setCurrentApp(Object.assign({}, app, { instructions: newInstrs }));
            try { composerStyleNativeMarkers(); } catch (e) {}
            const bits = [];
            if (navCount) bits.push(`${navCount} navigate(s)`);
            if (snapCount) bits.push(`${snapCount} snapshot(s)`);
            (presetReqs || []).forEach(r => bits.push(`${r.count}× ${r.preset.name}`));
            showToast(`Staged ${bits.join(' + ')}${posMsg} — drag them into place, then SAVE.${snapCount ? ' Arm 📷 Auto-AGL so snapshots auto-set elevation on drop.' : ''}`, '#5fff5f', 7000);
        } catch (e) { console.warn(`${TAG} [stage] setCurrentApp failed`, e); showToast('Stage failed — see console.', '#ff5252', 4000); }
    }
    let genStagePopEl = null;
    function genStagePopup(anchorBtn) {
        if (genStagePopEl) { genStagePopEl.remove(); genStagePopEl = null; return; }
        const last = gmGet(CACHE_KEY_STAGE_LAST, null) || {};
        const lastNav = Number.isFinite(+last.nav) ? Math.max(0, +last.nav) : 0;
        const lastSnap = Number.isFinite(+last.snap) ? Math.max(0, +last.snap) : 1;
        const lastScan = (last.scan === undefined) ? true : !!last.scan;
        const lastMode = last.insertMode === 'end' ? 'end' : 'start';
        const pop = document.createElement('div');
        pop.style.cssText = 'position:fixed;z-index:2147483600;min-width:240px;background:#1f2228;border:1px solid #9cf;border-radius:6px;' +
            'box-shadow:0 4px 20px rgba(0,0,0,0.8);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;padding:10px 12px;';
        const numCss = 'width:60px;background:#0f1216;border:1px solid #9cf;color:#fff;padding:3px 6px;border-radius:3px;';
        const smallNumCss = 'width:46px;background:#0f1216;border:1px solid #456;color:#fff;padding:2px 4px;border-radius:3px;';
        pop.innerHTML = `
            <div style="font-weight:800;color:#9cf;font-size:13px;margin-bottom:8px;">➕ Stage steps</div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;"><label style="flex:1;">Navigates</label><input type="number" min="0" max="50" value="${lastNav}" data-st-nav style="${numCss}"></div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;"><label style="flex:1;">Snapshots</label><input type="number" min="0" max="50" value="${lastSnap}" data-st-snap style="${numCss}"></div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px;"><label style="flex:1;">Insert at Nav #</label><input type="number" min="1" max="200" placeholder="end" data-st-at style="${numCss}"></div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px;"><label style="flex:1;">Position</label><select data-st-mode style="background:#0f1216;border:1px solid #9cf;color:#fff;border-radius:3px;padding:3px 4px;font-size:11px;max-width:150px;">
                <option value="start">Start of group (after nav)</option>
                <option value="end">End of group (before next nav)</option>
            </select></div>
            <div style="font-size:10px;color:#789;margin-bottom:10px;">Blank Nav # = very end. e.g. 2 + Start → right after N2; 2 + End → just before N3.</div>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:10px;cursor:pointer;"><input type="checkbox" data-st-scan ${lastScan ? 'checked' : ''}> Inspection scan wrap per snapshot</label>
            <div data-st-presets style="border-top:1px solid #34404e;padding-top:6px;margin-bottom:8px;"></div>
            <button class="aim-mb-tbtn" data-st-cap style="padding:4px 8px;font-size:11px;margin-bottom:10px;width:100%;" title="If a step's edit form is open, captures it now. Otherwise arms capture: click the step you want and it saves automatically when its form opens.">📋 Capture a step as preset</button>
            <div style="display:flex;gap:6px;justify-content:flex-end;">
                <button class="aim-mb-tbtn" data-st-cancel style="padding:5px 10px;">Cancel</button>
                <button data-st-add style="padding:5px 12px;background:#9cf;border:none;color:#06223a;border-radius:6px;cursor:pointer;font-weight:800;">Stage</button>
            </div>`;
        document.body.appendChild(pop);
        genStagePopEl = pop;
        pop.querySelector('[data-st-mode]').value = lastMode;
        const rowsEl = pop.querySelector('[data-st-presets]');
        // User-controlled order (↑/↓, persisted via preset.order) — this is ALSO
        // the order staged clones land in the mission (genStageSteps iterates
        // presetReqs in row order). Presets saved before order existed sort by
        // capture time.
        const presetOrderCmp = (all) => (a, b) => {
            const oa = all[a].order != null ? all[a].order : (all[a].savedAt || 0);
            const ob = all[b].order != null ? all[b].order : (all[b].savedAt || 0);
            return oa - ob || a.localeCompare(b);
        };
        const movePreset = (name, dir) => {
            const all = stagePresetsLoad();
            const names = Object.keys(all).sort(presetOrderCmp(all));
            const i = names.indexOf(name), j = i + dir;
            if (i < 0 || j < 0 || j >= names.length) return;
            const t = names[i]; names[i] = names[j]; names[j] = t;
            names.forEach((n, k) => { all[n].order = (k + 1) * 10; });
            stagePresetsSave(all);
            renderPresetRows();
        };
        const renderPresetRows = () => {
            // Keep typed counts across re-renders (reorder/capture/delete).
            const keepCounts = {};
            rowsEl.querySelectorAll('[data-st-pcount]').forEach(inp => { keepCounts[inp.getAttribute('data-st-pcount')] = inp.value; });
            const all = stagePresetsLoad();
            const names = Object.keys(all).sort(presetOrderCmp(all));
            if (!names.length) {
                rowsEl.innerHTML = '<div style="font-size:10px;color:#789;">No saved steps yet — set up a step how you want (any type), then hit 📋 below and click that step.</div>';
                return;
            }
            rowsEl.innerHTML = '<div style="font-size:10px;font-weight:800;color:#9cf;margin-bottom:4px;">MY STEPS</div>' + names.map(n => {
                const p = all[n]; const t = tplTypeNum(p.instr);
                let ctrl = '';
                if (t === 5) ctrl = `<span style="font-size:11px;color:#9ab;">⏱</span><input type="number" min="0" max="600" value="${Math.round(Number(p.instr.value1) || 0)}" data-st-pval="${escapeHtml(n)}" title="Wait seconds" style="${smallNumCss}">`;
                else if (t === 7) ctrl = `<select data-st-pcam="${escapeHtml(n)}" title="Camera" style="background:#0f1216;border:1px solid #456;color:#fff;border-radius:3px;padding:2px;font-size:11px;"><option value="0"${!p.instr.value1 ? ' selected' : ''}>RGB</option><option value="1"${p.instr.value1 ? ' selected' : ''}>Thermal</option></select>`;
                const savedCount = Math.max(0, parseInt(p.count, 10) || 0);
                return `<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;font-size:12px;">
                    <span data-st-pup="${escapeHtml(n)}" title="Move up (staging order)" style="cursor:pointer;color:#9cf;font-size:11px;">▲</span>
                    <span data-st-pdn="${escapeHtml(n)}" title="Move down (staging order)" style="cursor:pointer;color:#9cf;font-size:11px;">▼</span>
                    <label style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(n)}">${escapeHtml(n)}</label>
                    <span data-st-pren="${escapeHtml(n)}" title="Rename preset" style="cursor:pointer;color:#9ab;font-size:11px;">✏️</span>${ctrl}
                    <input type="number" min="0" max="50" value="${savedCount}" data-st-pcount="${escapeHtml(n)}" title="How many to stage (remembered)" style="${smallNumCss}">
                    <span data-st-pdel="${escapeHtml(n)}" title="Delete preset" style="cursor:pointer;color:#f66;font-size:12px;">🗑</span></div>`;
            }).join('');
            // Inline edits persist straight to the preset ("the way you last had it").
            rowsEl.querySelectorAll('[data-st-pval]').forEach(inp => { inp.onchange = () => {
                const a2 = stagePresetsLoad(); const p = a2[inp.getAttribute('data-st-pval')]; if (!p) return;
                p.instr.value1 = Math.max(0, parseInt(inp.value, 10) || 0); stagePresetsSave(a2);
            }; });
            rowsEl.querySelectorAll('[data-st-pcam]').forEach(sel => { sel.onchange = () => {
                const a2 = stagePresetsLoad(); const p = a2[sel.getAttribute('data-st-pcam')]; if (!p) return;
                p.instr.value1 = sel.value === '1' ? 1 : 0; stagePresetsSave(a2);
            }; });
            rowsEl.querySelectorAll('[data-st-pdel]').forEach(d => { d.onclick = () => {
                const n = d.getAttribute('data-st-pdel');
                const a2 = stagePresetsLoad(); delete a2[n]; stagePresetsSave(a2);
                console.log(`${TAG} [stage] deleted step preset "${n}"`);
                renderPresetRows();
            }; });
            rowsEl.querySelectorAll('[data-st-pup]').forEach(u => { u.onclick = () => movePreset(u.getAttribute('data-st-pup'), -1); });
            rowsEl.querySelectorAll('[data-st-pdn]').forEach(d => { d.onclick = () => movePreset(d.getAttribute('data-st-pdn'), 1); });
            rowsEl.querySelectorAll('[data-st-pren]').forEach(r => { r.onclick = () => {
                const oldName = r.getAttribute('data-st-pren');
                const a2 = stagePresetsLoad(); const p = a2[oldName]; if (!p) return;
                const nn = (window.prompt('Rename preset:', oldName) || '').trim();
                if (!nn || nn === oldName) return;
                if (a2[nn] && !window.confirm(`"${nn}" already exists — overwrite it?`)) return;
                delete a2[oldName];
                p.name = nn;
                a2[nn] = p;
                stagePresetsSave(a2);
                console.log(`${TAG} [stage] renamed step preset "${oldName}" → "${nn}"`);
                renderPresetRows();
            }; });
            // Counts persist ON the preset — typing a count remembers it across
            // popup opens (navs/snaps already persist via aim-mb-stage-last).
            rowsEl.querySelectorAll('[data-st-pcount]').forEach(inp => {
                const kept = keepCounts[inp.getAttribute('data-st-pcount')];
                if (kept !== undefined) inp.value = kept;
                inp.onchange = () => {
                    const a2 = stagePresetsLoad(); const p = a2[inp.getAttribute('data-st-pcount')]; if (!p) return;
                    p.count = Math.max(0, parseInt(inp.value, 10) || 0);
                    stagePresetsSave(a2);
                };
            });
        };
        renderPresetRows();
        const r = anchorBtn.getBoundingClientRect();
        pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8) + 'px';
        pop.style.top = (r.bottom + 4) + 'px';
        const close = () => { pop.remove(); genStagePopEl = null; document.removeEventListener('mousedown', outside, true); };
        const outside = e => { if (genStagePopEl && !pop.contains(e.target) && e.target !== anchorBtn) close(); };
        pop.querySelector('[data-st-cancel]').onclick = close;
        pop.querySelector('[data-st-cap]').onclick = () => {
            let fid = null;
            try { fid = findFocusedInstrId(); } catch (e) {}
            // Direct capture ONLY when a step edit form is actually mounted —
            // focusedInstructionId can be STALE (still the last step you edited)
            // with no form open, which must arm, not capture the stale step.
            if (fid != null && document.querySelector('.edit-instruction')) {
                if (stageCaptureOpenStep(fid)) renderPresetRows();
                return;
            }
            // No step form open → arm: close the popup, capture the next step opened.
            close();
            stageArmCapture();
        };
        pop.querySelector('[data-st-add]').onclick = () => {
            const nav = Math.max(0, parseInt(pop.querySelector('[data-st-nav]').value, 10) || 0);
            const snap = Math.max(0, parseInt(pop.querySelector('[data-st-snap]').value, 10) || 0);
            const scan = pop.querySelector('[data-st-scan]').checked;
            const atRaw = parseInt(pop.querySelector('[data-st-at]').value, 10);
            const at = (!isNaN(atRaw) && atRaw >= 1) ? atRaw : null; // null = end
            const mode = pop.querySelector('[data-st-mode]').value === 'end' ? 'end' : 'start';
            const allP = stagePresetsLoad();
            const presetReqs = [];
            pop.querySelectorAll('[data-st-pcount]').forEach(inp => {
                const c = Math.max(0, parseInt(inp.value, 10) || 0);
                const p = allP[inp.getAttribute('data-st-pcount')];
                if (!p) return;
                p.count = c; // persist counts even if the input's change event never fired
                if (c > 0) presetReqs.push({ preset: p, count: c });
            });
            stagePresetsSave(allP);
            close();
            gmSet(CACHE_KEY_STAGE_LAST, { nav, snap, scan, insertMode: mode });
            if (!nav && !snap && !presetReqs.length) { showToast('Set a count for at least one step type.', '#ff9800'); return; }
            genStageSteps(nav, snap, scan, at, presetReqs, mode);
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
        // v2.14: Data View (legacy Angular app) keeps its map on
        // $rootScope.current_map — never on the container's props. Guarded on
        // a container existing in THIS document so the SS/MB top frame
        // (Angular shell, map in iframe) can't grab a stale reference.
        try {
            // v2.21: unsafeWindow, not window — page globals aren't guaranteed
            // to be visible through the sandbox proxy (same rule as the
            // Styler/AI angular grabs and unsafeWindow.L).
            const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const ng = w.angular;
            const containers = document.querySelectorAll('.leaflet-container');
            if (ng && containers.length && typeof ng.element === 'function') {
                const scope = ng.element(containers[0]).scope();
                const root = scope && scope.$root;
                if (root && composerLooksLikeMap(root.current_map)) {
                    leafletMapRef = root.current_map;
                    return leafletMapRef;
                }
            }
        } catch (e) { console.log(`${TAG} angular map fallback threw (${e.message}) — no map in this frame`); }
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
            cxAglPending = true;
            if (instr.location && instr.location.lat != null) {
                const k = elevCacheKey(Number(instr.location.lat), Number(instr.location.lng));
                if (!elevKickAt[k] || Date.now() - elevKickAt[k] > ELEV_KICK_COOLDOWN) {
                    elevKickAt[k] = Date.now();
                    MB_PERF.elevKicks++;
                    try { fetchElevation(instr.location.lat, instr.location.lng); } catch (e) {}
                }
            }
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

        // v1.89 PERF: skip the DOM writes when this card already shows exactly
        // this state. The 700ms tick re-runs this across EVERY card (to flip
        // "MSL (loading)" → AGL as DEM arrives); unguarded style writes dirtied
        // style every tick and forced constant recalc on large missions. The
        // stamp lives as a JS property → clearing/re-creating the card (React)
        // or off() naturally resets it.
        const stamp = `${t}|${valText}|${valColor}|${renameText}|${renameColor}|${titleColor}`;
        if (card.__aimCxStamp === stamp) {
            // Stamp can outlive our injected node when Percepto re-renders the
            // card's INNER DOM in place (per-step save) — verify it's still there.
            const node = renameText != null ? titleEl.querySelector('.aim-mb-cx-name') : header.querySelector('.aim-mb-cx-val');
            if (node) return;
        }
        card.__aimCxStamp = stamp;
        MB_PERF.cardWrites++;

        // Color the native title name (Navigate=blue, Snapshot=pink).
        const nameEl = titleEl.querySelector('.mission-instruction-item__title__name');
        if (nameEl) nameEl.style.color = titleColor || '';

        if (renameText != null) {
            card.classList.add('aim-mb-compact-renamed');
            let r = titleEl.querySelector('.aim-mb-cx-name');
            if (!r) { r = document.createElement('span'); r.className = 'aim-mb-cx-name'; titleEl.appendChild(r); MB_PERF.cxCreates++; }
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
                MB_PERF.cxCreates++;
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
        const t0 = performance.now();
        MB_PERF.collapsePasses++;
        try { applyNativeEditorCollapseCore(); } finally { MB_PERF.collapseMs += performance.now() - t0; }
    }
    function applyNativeEditorCollapseCore() {
        if (CONTEXT !== 'IFRAME') return;
        const cards = document.querySelectorAll('[data-rfd-draggable-id]');
        const off = () => {
            ensureEditorCollapseStyle(false);
            cards.forEach(c => { c.classList.remove('aim-mb-compact', 'aim-mb-compact-renamed'); c.querySelectorAll('.aim-mb-cx-name,.aim-mb-cx-val').forEach(x => x.remove()); delete c.__aimCxStamp; });
        };
        if (!collapseEditorCards) { off(); return; }
        if (!document.querySelector('.mission-edit__content') || !cards.length) return;
        if (!composerMission) { off(); return; } // wait for the mission to load
        ensureEditorCollapseStyle(true);
        const byId = {}; (composerMission.instructions || []).forEach(x => { byId[String(x.id)] = x; });
        cxAglPending = false; // recomputed by compactAltDisplay during this pass
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
                <button class="aim-mb-tbtn" data-bulk-rename title="Find & replace text across the SELECTED missions' names (e.g. N - → NNE - )">✎ Rename ▾</button>
                <button class="aim-mb-tbtn" data-bulk-delete title="Permanently delete the SELECTED missions from the server" style="color:#ff8a8a;">🗑 Delete</button>
                <button class="aim-mb-tbtn" data-copy-missions title="Copy missions from another site into this one (create-only, dup names skipped)">📥 Copy</button>
                <button class="aim-mb-tbtn ${pcm.on ? 'active' : ''}" data-pcm-toggle title="Merge missions by right-clicking pads on the map in order (pad name = mission name)">🔗 Merge</button>
                <button class="aim-mb-tbtn ${rng.on ? 'active' : ''}" data-rng-toggle title="Color every pad's FFZ by the TRUE shortest LEGAL route from base (inside FFZ/FP only, triple-verified: path audit + dense second opinion + lower bound). Overlay is click-through — M2 merge picking still works.">🔋 Range</button>
                <button class="aim-mb-tbtn ${lasso.armed ? 'active' : ''}" data-lasso-toggle title="Draw a freehand loop around pads → auto-build a furthest→closest merge list (Tulip pads auto-split into a separate '2' mission) and stage it in the merge editor for inspection.">🖊 Lasso</button>
                <button class="aim-mb-tbtn ${mcv.on ? 'active' : ''}" data-mcv-toggle title="Show which pads are already claimed by macro (merged) missions — each macro gets a color + name chip; white dashed pads have missions but no macro yet. Click-through.">🧩 Macros</button>
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
        const editableName = panelState.mode !== 'log'; // rename only makes sense for missions
        const cells = visibleCols.map(col => {
            if (col.kind === 'dot') {
                const cls = row[col.key] ? 'active' : 'inactive';
                return `<td><span class="aim-mb-dot ${cls}" title="${row[col.key] ? 'Active' : 'Inactive'}"></span></td>`;
            }
            const v = formatCellValue(row, col, panelState.distanceUnit, thresholds);
            if (col.id === 'name' && editableName) {
                // Click to rename · Tab → next mission's name (server rename via saveApp).
                return `<td class="aim-mb-name-cell" data-name-edit="${row.id}" title="Click to rename · Tab to next" style="cursor:text;">${escapeHtml(String(v))}</td>`;
            }
            return `<td>${escapeHtml(String(v))}</td>`;
        }).join('');
        return `<tr class="${selectedCls}" data-id="${row.id}"><td><input type="checkbox" data-row="${row.id}" ${checked} /></td>${cells}</tr>`;
    }

    function selectAllState(rows) {
        if (rows.length === 0) return '';
        const allSelected = rows.every(r => panelState.selectedIds.has(r.id));
        return allSelected ? 'checked' : '';
    }

    // ── Inline mission rename — click a Name cell, edit, Tab to the next ───────
    // Rename persists via saveApp (Percepto's own save; app_id preserved). Renames
    // are SERIALIZED (one saveApp at a time) so rapid Tabbing doesn't fire dozens of
    // concurrent POSTs, and the auto-AGL pass is suppressed so a rename never
    // re-floats snapshots. NOTE: saveApp re-saves the whole mission (server recomputes
    // route) — cheap + lossless for a name change.
    let renameQueue = Promise.resolve();
    async function renameMissionNow(missionId, newName, oldName) {
        const sid = getCurrentSiteID();
        const ms = (missionsBySite[sid] && missionsBySite[sid].missions) || [];
        const m = ms.find(x => String(x.id) === String(missionId));
        if (!m) return;
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.saveApp !== 'function') { showToast('Rename: mission context not found — be on the Mission Bank page.', '#ff5252', 4000); m.name = oldName; return; }
        renameSuppressAutoAgl++;
        try {
            await ctx.saveApp(m, newName);
            m.name = newName;
            console.log(`${TAG} [rename] "${oldName}" → "${newName}"`);
        } catch (e) {
            console.warn(`${TAG} [rename] failed for ${missionId}`, e);
            m.name = oldName;
            showToast(`Rename failed for "${oldName}" — see console.`, '#ff5252', 4000);
        } finally { renameSuppressAutoAgl--; }
    }
    function queueRename(missionId, newName, oldName) {
        renameQueue = renameQueue.then(() => renameMissionNow(missionId, newName, oldName)).catch(() => {});
    }
    function startNameEdit(td, missionId) {
        if (!td || td.querySelector('input')) return;
        const sid = getCurrentSiteID();
        const ms = (missionsBySite[sid] && missionsBySite[sid].missions) || [];
        const m = ms.find(x => String(x.id) === String(missionId));
        const cur = m ? (m.name || '') : (td.textContent || '');
        const input = document.createElement('input');
        input.type = 'text'; input.value = cur;
        input.style.cssText = 'width:100%;box-sizing:border-box;background:#0f1216;border:1px solid #14d2dc;color:#fff;font:inherit;padding:2px 4px;border-radius:3px;';
        td.textContent = ''; td.appendChild(input);
        input.focus(); input.select();
        let done = false;
        const finish = (commit) => {
            if (done) return; done = true;
            const nv = input.value.trim();
            if (commit && nv && nv !== cur) {
                td.textContent = nv;
                if (m) m.name = nv;               // optimistic UI + cache
                queueRename(missionId, nv, cur);  // serialized background saveApp
            } else {
                td.textContent = cur;
            }
        };
        const gotoSibling = (dir) => {
            const cells = [...panelEl.querySelectorAll('[data-name-edit]')];
            const idx = cells.findIndex(c => c.getAttribute('data-name-edit') === String(missionId));
            const nxt = cells[idx + dir];
            if (nxt) { try { nxt.scrollIntoView({ block: 'nearest' }); } catch (e) {} startNameEdit(nxt, nxt.getAttribute('data-name-edit')); }
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            else if (e.key === 'Tab') { e.preventDefault(); finish(true); gotoSibling(e.shiftKey ? -1 : 1); }
        };
        input.onblur = () => { setTimeout(() => finish(true), 100); };
    }

    // Bulk rename — find & replace text across the SELECTED missions' names, with a
    // live before→after preview. Reuses the serialized rename queue.
    function openBulkRenamePopover(anchor) {
        try { closeOpenMenus(); } catch (e) {}
        const sid = getCurrentSiteID();
        const ms = (missionsBySite[sid] && missionsBySite[sid].missions) || [];
        const selected = ms.filter(m => panelState.selectedIds.has(m.id));
        if (!selected.length) { showToast('Select missions first (row checkboxes), then ✎ Rename.', '#ff9800', 3500); return; }
        const menu = document.createElement('div');
        menu.className = 'aim-mb-bulk-rename-pop';
        menu.style.cssText = 'position:fixed;z-index:2147483647;width:370px;max-height:72vh;display:flex;flex-direction:column;background:#161a20;border:1px solid #14d2dc;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.7);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;';
        menu.innerHTML = `
            <div style="padding:9px 12px;background:rgba(20,210,220,0.08);border-bottom:1px solid rgba(20,210,220,0.3);font-weight:800;color:#7adfe6;font-size:13px;">✎ Bulk rename · ${selected.length} selected</div>
            <div style="padding:9px 12px;border-bottom:1px solid #2a2f38;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><label style="width:56px;color:#9ad;font-size:12px;">Find</label><input data-br-find placeholder="N - " style="flex:1;background:#0f1216;border:1px solid #2a3340;color:#fff;padding:4px 6px;border-radius:3px;font:inherit;"></div>
                <div style="display:flex;align-items:center;gap:8px;"><label style="width:56px;color:#9ad;font-size:12px;">Replace</label><input data-br-replace placeholder="NNE - " style="flex:1;background:#0f1216;border:1px solid #2a3340;color:#fff;padding:4px 6px;border-radius:3px;font:inherit;"></div>
                <div style="margin-top:5px;color:#789;font-size:10px;">Replaces that text everywhere it appears in each selected name.</div>
            </div>
            <div data-br-preview style="overflow:auto;flex:1;padding:4px 10px;font-size:11px;min-height:60px;"></div>
            <div style="padding:9px 12px;border-top:1px solid #2a2f38;display:flex;align-items:center;gap:8px;">
                <span data-br-count style="flex:1;font-size:11px;color:#9ad;"></span>
                <button data-br-cancel class="aim-mb-tbtn" style="padding:5px 10px;">Cancel</button>
                <button data-br-apply style="padding:5px 12px;background:#14d2dc;border:none;color:#04222a;border-radius:6px;cursor:pointer;font-weight:800;" disabled>Apply</button>
            </div>`;
        document.body.appendChild(menu);
        try { positionFloatingMenu(menu, anchor); } catch (e) { const r = anchor.getBoundingClientRect(); menu.style.left = r.left + 'px'; menu.style.top = (r.bottom + 4) + 'px'; }
        const findI = menu.querySelector('[data-br-find]');
        const replI = menu.querySelector('[data-br-replace]');
        const prev = menu.querySelector('[data-br-preview]');
        const countEl = menu.querySelector('[data-br-count]');
        const applyBtn = menu.querySelector('[data-br-apply]');
        let changes = [];
        const recompute = () => {
            const find = findI.value;
            const repl = replI.value;
            changes = [];
            if (find) selected.forEach(m => {
                const oldN = m.name || '';
                if (oldN.includes(find)) { const newN = oldN.split(find).join(repl); if (newN !== oldN) changes.push({ id: m.id, oldN, newN }); }
            });
            prev.innerHTML = changes.length
                ? changes.slice(0, 300).map(c => `<div style="padding:2px 0;border-bottom:1px solid #20262e;"><span style="color:#a99;">${escapeHtml(c.oldN)}</span><br><span style="color:#7dff7d;">→ ${escapeHtml(c.newN)}</span></div>`).join('')
                : `<div style="padding:10px;color:#888;">${find ? 'No selected names contain that text.' : 'Type the text to find (e.g. "N - ").'}</div>`;
            countEl.textContent = `${changes.length} of ${selected.length} will change`;
            applyBtn.disabled = !changes.length;
        };
        findI.oninput = recompute; replI.oninput = recompute;
        recompute(); findI.focus();
        const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); };
        const outside = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
        menu.querySelector('[data-br-cancel]').onclick = close;
        applyBtn.onclick = () => {
            const n = changes.length;
            changes.forEach(c => { const m = ms.find(x => x.id === c.id); if (m) m.name = c.newN; queueRename(c.id, c.newN, c.oldN); });
            close();
            renderTableView();
            showToast(`✎ Renaming ${n} mission${n === 1 ? '' : 's'} — saving in the background. Reload to see them in native Mission Bank.`, '#5fff5f', 6000);
        };
        setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    }

    // Bulk DELETE the selected missions (permanent — via ctx.deleteApp). Serialized,
    // with a clear confirmation listing what will be removed.
    function openBulkDeletePopover(anchor) {
        try { closeOpenMenus(); } catch (e) {}
        const sid = getCurrentSiteID();
        const ms = (missionsBySite[sid] && missionsBySite[sid].missions) || [];
        const selected = ms.filter(m => panelState.selectedIds.has(m.id));
        if (!selected.length) { showToast('Select missions first (row checkboxes), then 🗑 Delete.', '#ff9800', 3500); return; }
        const ctx = findMissionAppCtx();
        if (!ctx || typeof ctx.deleteApp !== 'function') { showToast('Delete: mission context not found — be on the Mission Bank page.', '#ff5252', 4000); return; }
        const menu = document.createElement('div');
        menu.className = 'aim-mb-bulk-del-pop';
        menu.style.cssText = 'position:fixed;z-index:2147483647;width:360px;max-height:72vh;display:flex;flex-direction:column;background:#1a1113;border:1px solid #ff5252;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.7);color:#e6e6e6;font-family:"Lato","Segoe UI",sans-serif;';
        menu.innerHTML = `
            <div style="padding:9px 12px;background:rgba(255,82,82,0.12);border-bottom:1px solid rgba(255,82,82,0.35);font-weight:800;color:#ff9a9a;font-size:13px;">🗑 Delete missions · ${selected.length} selected</div>
            <div style="padding:8px 12px;font-size:11px;color:#f2b8b8;border-bottom:1px solid #3a2a2a;"><b>Permanently deletes</b> these from the server — can’t be undone.</div>
            <div style="overflow:auto;flex:1;padding:4px 10px;font-size:11px;min-height:60px;">${selected.slice(0, 400).map(m => `<div style="padding:2px 0;border-bottom:1px solid #2a1e1e;color:#e6c8c8;">${escapeHtml(m.name || ('#' + m.id))}</div>`).join('')}</div>
            <div style="padding:9px 12px;border-top:1px solid #3a2a2a;display:flex;align-items:center;gap:8px;">
                <span data-del-status style="flex:1;font-size:11px;color:#f2b8b8;"></span>
                <button data-del-cancel class="aim-mb-tbtn" style="padding:5px 10px;">Cancel</button>
                <button data-del-go style="padding:5px 12px;background:#ff5252;border:none;color:#2a0a0a;border-radius:6px;cursor:pointer;font-weight:800;">Delete ${selected.length}</button>
            </div>`;
        document.body.appendChild(menu);
        try { positionFloatingMenu(menu, anchor); } catch (e) { const r = anchor.getBoundingClientRect(); menu.style.left = r.left + 'px'; menu.style.top = (r.bottom + 4) + 'px'; }
        const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); };
        const outside = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
        menu.querySelector('[data-del-cancel]').onclick = close;
        const statusEl = menu.querySelector('[data-del-status]');
        const goBtn = menu.querySelector('[data-del-go]');
        goBtn.onclick = async () => {
            goBtn.disabled = true; menu.querySelector('[data-del-cancel]').disabled = true;
            const deleted = [];
            for (let i = 0; i < selected.length; i++) {
                statusEl.textContent = `Deleting ${i + 1}/${selected.length}…`;
                try { await ctx.deleteApp(selected[i].id); deleted.push(selected[i].id); panelState.selectedIds.delete(selected[i].id); }
                catch (e) { console.warn(`${TAG} [delete] failed "${selected[i].name}"`, e); }
            }
            const delSet = new Set(deleted);
            if (missionsBySite[sid]) missionsBySite[sid].missions = missionsBySite[sid].missions.filter(m => !delSet.has(m.id));
            close();
            renderTableView();
            try { refreshMissionList(); } catch (e) {}
            const fail = selected.length - deleted.length;
            showToast(`🗑 Deleted ${deleted.length}${fail ? ` · ${fail} failed (see console)` : ''}. Reload to refresh native Mission Bank.`, deleted.length ? '#5fff5f' : '#ff5252', 6000);
            console.log(`${TAG} [delete] removed ${deleted.length}, failed ${fail}`);
        };
        setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
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
        // Bulk rename (find & replace on selected)
        const brBtn = panelEl.querySelector('[data-bulk-rename]');
        if (brBtn) brBtn.onclick = () => openBulkRenamePopover(brBtn);
        // Bulk delete (selected)
        const bdBtn = panelEl.querySelector('[data-bulk-delete]');
        if (bdBtn) bdBtn.onclick = () => openBulkDeletePopover(bdBtn);
        // v1.99 — cross-site mission copy + pad-click merge mode
        const cpBtn = panelEl.querySelector('[data-copy-missions]');
        if (cpBtn) cpBtn.onclick = () => openCopyMissionsPanel();
        const rngBtn = panelEl.querySelector('[data-rng-toggle]');
        if (rngBtn) rngBtn.onclick = () => rngToggle(rngBtn);
        const lassoBtn = panelEl.querySelector('[data-lasso-toggle]');
        if (lassoBtn) lassoBtn.onclick = () => lassoToggle(lassoBtn);
        const mcvBtn = panelEl.querySelector('[data-mcv-toggle]');
        if (mcvBtn) mcvBtn.onclick = () => mcvToggle(mcvBtn);
        const pcmBtn = panelEl.querySelector('[data-pcm-toggle]');
        if (pcmBtn) pcmBtn.onclick = async () => {
            if (pcm.on) { pcmExit(); }
            else { await pcmEnter(); if (pcm.on) pcmBtn.classList.add('active'); }
        };
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
                // Clicking the Name cell starts an inline rename — don't drill into detail.
                const nameCell = e.target.closest && e.target.closest('[data-name-edit]');
                if (nameCell) { e.stopPropagation(); startNameEdit(nameCell, nameCell.getAttribute('data-name-edit')); return; }
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
                        <button class="aim-mb-tbtn" data-detail-export="kml" title="Export as KML — nav→nav mission path (+ routed base path if this mission is open on the map) + N#/S# 3D pins, each pin showing its step details (bundled Thermal/GEM/Wait)">Export KML</button>
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
    //   • a WHITE Mission Path line nav→nav (the step order N1→N2→…),
    //   • a CYAN Routed Path line when opts.routes is supplied (the map's
    //     dashed base→mission→base transit, following the FPs/FFZs),
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

        // Flight path: emit BOTH lines when we can —
        //   • the straight nav→nav zigzag (WHITE) = the mission's step order,
        //     always present so N1→N2→N3… is visible in every export;
        //   • the REAL routed path captured off AIM's map (CYAN, the dashed
        //     line that follows the FPs/FFZs, base→steps→back) when readable.
        // Previously routes REPLACED the zigzag, so the editor export lost the
        // step order and the SUM export lost the base transit — now combined.
        let pathPlacemark = '';
        if (navsLoc.length >= 2) {
            const pathCoords = navsLoc.map(n => `${Number(n.location.lng)},${Number(n.location.lat)},${kmlAltM(n)}`).join(' ');
            pathPlacemark = `    <Placemark>
      <name>Mission Path (nav→nav)</name>
      <styleUrl>#style-path</styleUrl>
      <LineString><tessellate>1</tessellate><altitudeMode>absolute</altitudeMode><coordinates>${pathCoords}</coordinates></LineString>
    </Placemark>`;
        }
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
            const routed = opts.routes.map((route, i) => {
                const coords = route.map(p => `${p.lng},${p.lat},${altForPoint(p)}`).join(' ');
                return `    <Placemark>
      <name>Routed Path (base→mission→base)${opts.routes.length > 1 ? ' ' + (i + 1) : ''}</name>
      <styleUrl>#style-route</styleUrl>
      <LineString><tessellate>1</tessellate><altitudeMode>${mode}</altitudeMode><coordinates>${coords}</coordinates></LineString>
    </Placemark>`;
            }).join('\n');
            pathPlacemark = pathPlacemark ? `${pathPlacemark}\n${routed}` : routed;
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
    <description>White line = mission path in step order (nav→nav). Cyan line = the routed path off the map (base→mission→base, follows the FPs/FFZs — only present when the mission was open on the map at export). Purple lines = nav→snapshot sightlines (labeled with distance). Blue/pink pins carry per-stop step detail. Exported by AIM Mission Bank Tools v${SCRIPT_VERSION}.</description>
    <Style id="style-nav"><IconStyle><color>${navColor}</color><scale>1.1</scale><Icon><href>${PIN}</href></Icon></IconStyle><LabelStyle><color>${navColor}</color></LabelStyle></Style>
    <Style id="style-snap"><IconStyle><color>${snapColor}</color><scale>1.1</scale><Icon><href>${PIN}</href></Icon></IconStyle><LabelStyle><color>${snapColor}</color></LabelStyle></Style>
    <Style id="style-path"><LineStyle><color>ffffffff</color><width>3</width></LineStyle></Style>
    <Style id="style-route"><LineStyle><color>d0ffd966</color><width>2.4</width></LineStyle></Style>
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
        // If THIS mission is the one open on the map, grab its routed line too
        // (a different open mission's route would be wrong — skip it then).
        let routes = null;
        try {
            if (composerMission && row && row.id != null && String(composerMission.id) === String(row.id)) routes = captureFlightRoutes();
        } catch (e) { console.warn(`${TAG} [kml] route capture skipped`, e); }
        const built = buildMissionKml(row && row.name, allSteps || [], { routes });
        if (!built) { showToast('No GPS steps (navigate/snapshot) to export.', '#ff9800'); return; }
        if (downloadKmlFile(row && row.name, built.kml)) {
            const path = built.usedRoute ? ' · nav path + routed base path' : '';
            showToast(`Exported KML — ${built.navCount} stops · ${built.snapCount} snapshots${path}`, '#5fff5f');
        }
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
            const path = built.usedRoute ? 'nav path + routed base path' : 'nav path only (couldn\'t read the routed line)';
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

    // ── 🧮 Math in native step number fields (#236) ──────────────────────────
    // Ant InputNumber lets you TYPE "2630+15" but reverts it on blur (invalid
    // number). We catch Enter/blur in the capture phase first, evaluate the
    // expression ourselves, rewrite the display via setReactInputValue and
    // commit through commitInputNumberViaFiber — so the form model gets the
    // computed number exactly like the Apply queue writes one.
    //
    // Safe evaluator: + - * / ( ) and decimals only, recursive descent, no
    // eval(). Returns null unless the WHOLE string parses to a finite number.
    function mathEvalExpr(str) {
        const s = str.replace(/\s+/g, '');
        let i = 0;
        function num() {
            const m = /^\d*\.?\d+/.exec(s.slice(i));
            if (!m) return null;
            i += m[0].length;
            return parseFloat(m[0]);
        }
        function factor() {
            if (s[i] === '(') {
                i++;
                const v = expr();
                if (v == null || s[i] !== ')') return null;
                i++;
                return v;
            }
            if (s[i] === '-') { i++; const v = factor(); return v == null ? null : -v; }
            if (s[i] === '+') { i++; return factor(); }
            return num();
        }
        function term() {
            let v = factor();
            while (v != null && (s[i] === '*' || s[i] === '/')) {
                const op = s[i++];
                const r = factor();
                if (r == null) return null;
                v = op === '*' ? v * r : v / r;
            }
            return v;
        }
        function expr() {
            let v = term();
            while (v != null && (s[i] === '+' || s[i] === '-')) {
                const op = s[i++];
                const r = term();
                if (r == null) return null;
                v = op === '+' ? v + r : v - r;
            }
            return v;
        }
        const v = expr();
        return (v != null && i === s.length && isFinite(v)) ? v : null;
    }

    // Evaluate the field if (and only if) it holds an expression. Plain
    // numbers and foreign text pass through untouched. Returns true when a
    // value was computed AND committed via the component onChange.
    function mathFieldMaybeEval(input, why) {
        const raw = String(input.value || '').trim();
        if (!raw) return false;
        if (/^-?\d*\.?\d+$/.test(raw)) return false;            // plain number — not ours
        if (!/^[\d.\s()+*/x×-]+$/i.test(raw)) return false;     // foreign chars — not ours
        let exprStr = raw.replace(/[x×]/gi, '*');
        // Leading +, * or / = relative to the committed value (aria-valuenow).
        // Leading '-' stays absolute — it's indistinguishable from a negative.
        if (/^[+*/]/.test(exprStr)) {
            const cur = parseFloat(input.getAttribute('aria-valuenow'));
            if (!isFinite(cur)) {
                console.warn(`${TAG} [math] relative "${raw}" but no committed value to base it on — ignoring`);
                return false;
            }
            exprStr = `(${cur})${exprStr}`;
        }
        const v = mathEvalExpr(exprStr);
        if (v == null) {
            console.warn(`${TAG} [math] could not evaluate "${raw}" — leaving field alone (Ant will revert it on blur)`);
            return false;
        }
        const out = Math.round(v * 100) / 100;
        setReactInputValue(input, out);
        const committed = commitInputNumberViaFiber(input, out);
        if (committed) console.log(`${TAG} [math] (${why}) "${raw}" → ${out} (committed)`);
        else console.warn(`${TAG} [math] (${why}) "${raw}" → ${out} — component onChange NOT found; display updated, letting Ant's own ${why} commit it`);
        return committed;
    }

    function mathFieldTarget(e) {
        const t = e.target;
        if (!t || t.tagName !== 'INPUT' || !t.classList || !t.classList.contains('ant-input-number-input')) return null;
        return t.closest('.edit-instruction') ? t : null;
    }
    function installMathFields() {
        // Enter — evaluate + commit, and swallow the key so nothing else
        // (Percepto's form, the Quick Mission Editor's Enter listener) reacts
        // to an Enter that was "just math". A second Enter on the now-plain
        // number behaves natively. If the fiber commit failed we let the key
        // through so Ant's own Enter handling commits the rewritten display.
        window.addEventListener('keydown', (e) => {
            if (!masterEnabled || !mathFieldsEnabled || e.key !== 'Enter') return;
            const t = mathFieldTarget(e);
            if (t && mathFieldMaybeEval(t, 'enter')) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
        // Click-away — evaluate + commit BEFORE Ant's blur handler reverts the
        // "invalid" expression text.
        window.addEventListener('focusout', (e) => {
            if (!masterEnabled || !mathFieldsEnabled) return;
            const t = mathFieldTarget(e);
            if (t) mathFieldMaybeEval(t, 'blur');
        }, true);
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
        if (autoSnapAglEnabled && renameSuppressAutoAgl === 0) {
            try { const s = applySnapAglToBodyStr(working); if (s) working = s; }
            catch (e) { console.warn(`${TAG} [auto-agl] pass error — leaving snapshots unchanged:`, e); }
        }
        // 1.5 Auto-wrap pass (session toggle via M2 on the 🎞 button): insert the
        //     last-used wrap template after every bare snapshot in the outgoing
        //     body, then schedule a post-save fresh-fetch verification.
        if (autoWrapEnabled) {
            try { const s = applyWrapToBodyStr(working); if (s) working = s; }
            catch (e) { console.warn(`${TAG} [wrap] auto-wrap pass error — body unchanged:`, e); }
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
                    let isSave = false;
                    try {
                        const url = (typeof input === 'string') ? input : (input && input.url);
                        const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
                        isSave = !!(method === 'POST' && url && SAVE_RE.test(url));
                        if (isSave && init && typeof init.body === 'string') {
                            const patched = handleMissionSave(init.body);
                            if (patched) init = Object.assign({}, init, { body: patched });
                        }
                    } catch (e) {}
                    const p = origFetch.apply(this, arguments);
                    // v2.13: observe the save RESPONSE (status only, body
                    // untouched) — a successful save refreshes the mission-
                    // preview overlay so its dots/badges track the edit.
                    if (isSave) { try { p.then(r => { if (r && r.ok) mpvOnMissionSaved(); }, () => {}); } catch (e) {} }
                    return p;
                };
            }
        } catch (e) {}
        try {
            const XHR = win.XMLHttpRequest;
            const origOpen = XHR.prototype.open, origSend = XHR.prototype.send;
            XHR.prototype.open = function(method, url) { this.__aim_mb_m = (method || '').toUpperCase(); this.__aim_mb_u = url; return origOpen.apply(this, arguments); };
            XHR.prototype.send = function(b) {
                try {
                    if (this.__aim_mb_m === 'POST' && this.__aim_mb_u && SAVE_RE.test(this.__aim_mb_u)) {
                        // v2.13: successful save → refresh the preview overlay.
                        try {
                            this.addEventListener('load', function() {
                                try { if (this.status >= 200 && this.status < 300) mpvOnMissionSaved(); } catch (e) {}
                            });
                        } catch (e) {}
                        if (typeof b === 'string') {
                            const patched = handleMissionSave(b);
                            if (patched) return origSend.call(this, patched);
                        }
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
        const lat = Number(s.location.lat), lng = Number(s.location.lng);
        const key = elevCacheKey(lat, lng);
        if (stepElevMemo[key] != null) return stepElevMemo[key];
        const now = Date.now();
        if (stepElevMissAt[key] && now - stepElevMissAt[key] < STEP_ELEV_MISS_COOLDOWN) return null;
        MB_PERF.elevLook++;
        const e = getElevationFromCache(lat, lng);
        if (e == null) { stepElevMissAt[key] = now; return null; }
        stepElevMemo[key] = e;
        return e;
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
    // 6 checks (per the SOP spec):
    //   1. navInFfz     — no Navigate is OUTSIDE an FFZ
    //   2. navAboveFfz  — no Navigate is lower than the FFZ it sits in
    //   3. navUnderCeil — no Navigate is higher than the FFZ ceiling
    //   4. snapAgl      — no Snapshot is below its min AGL (default 0 ft)
    //   5. blockBalance — every Snapshot has a matching Thermal/GEM/Wait block
    //   6. navSnapDist  — Navigate→Snapshot distance within [min,max] ft
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
        navInFfz: true, navAboveFfz: true, navUnderCeil: true, snapAgl: true, blockBalance: true, navSnapDist: true,
    };
    // Threshold defaults per preset. Upstream = the live SOP numbers.
    // Downstream / T&D start as copies (editable) until their SOPs land.
    const UPSTREAM_THRESH = {
        navSnapMinFt: 96,   // Navigate→Snapshot min standoff
        navSnapMaxFt: 204,  // Navigate→Snapshot max standoff
        snapMinAglFt: 0,    // Snapshot must be at/above this AGL
        navFloorTolFt: 0,   // slack on "Navigate ≥ FFZ min alt"
        navCeilTolFt: 0,    // slack on "Navigate ≤ FFZ max alt"
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
    // " · AGL 96 ft" suffix for a step's altitude, or '' when the DEM
    // cache has no ground for that point (never blocks the check itself).
    function sopAglStr(s) {
        if (!s.location || typeof s.value1 !== 'number') return '';
        const groundM = getElevationFromCache(s.location.lat, s.location.lng);
        if (typeof groundM !== 'number') return '';
        return ` · AGL ${Math.round((s.value1 - groundM) * 3.28084)} ft`;
    }
    // Structured altitude fields for a floor/ceiling violation — feed the
    // sortable columns in the Sheets export. AGL values are relative to
    // the DEM ground at the NAVIGATE point (null when ground is uncached).
    function sopBandFields(s, ffz) {
        const groundM = s.location ? getElevationFromCache(s.location.lat, s.location.lng) : null;
        const gFt = (typeof groundM === 'number') ? groundM * 3.28084 : null;
        const msl = m => (typeof m === 'number') ? Math.round(m * 3.28084) : null;
        const agl = m => (typeof m === 'number' && gFt !== null) ? Math.round(m * 3.28084 - gFt) : null;
        return {
            navMsl: msl(s.value1), navAgl: agl(s.value1),
            ffzName: ffz.name || '',
            ffzMinMsl: msl(ffz.minAltM), ffzMinAgl: agl(ffz.minAltM),
            ffzMaxMsl: msl(ffz.maxAltM), ffzMaxAgl: agl(ffz.maxAltM),
        };
    }

    // Fetch the site's FFZs (type 16) → [{ring, minAltM, maxAltM}]. Cookie auth,
    // same endpoint the Asset Inspector uses. Cached per site for the
    // session so repeat runs don't re-hit the network.
    const sopFfzCache = {};
    function fetchSiteFfzs(siteID) {
        if (sopFfzCache[siteID]) return Promise.resolve(sopFfzCache[siteID]);
        const url = `/map_objects/?getPoiMapObjectsAsList=true&site_id=${encodeURIComponent(siteID)}`;
        return fetch(url, { credentials: 'include' })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(arr => {
                const list = Array.isArray(arr) ? arr : (arr && arr.objects) || [];
                const ffzs = list.filter(e => e && e.type === 16 && Array.isArray(e.coords) && e.coords.length >= 3)
                    .map(e => ({
                        ring: e.coords.map(c => ({ lat: c.lat, lng: c.lng })),
                        minAltM: (e.restrictions && typeof e.restrictions.minAlt === 'number') ? e.restrictions.minAlt : null,
                        maxAltM: (e.restrictions && typeof e.restrictions.maxAlt === 'number') ? e.restrictions.maxAlt : null,
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

        // Pre-warm DEM cache: snapshot points (AGL check) + navigate points
        // (AGL readout in the floor/ceiling violation details).
        const wantNavDem = sopEnabled.navAboveFfz || sopEnabled.navUnderCeil;
        if (sopEnabled.snapAgl || wantNavDem) {
            const pts = [];
            missions.forEach(m => realSteps(m.instructions).forEach(s => {
                if (!s.location) return;
                if ((s.type_name === 'snapshot' && sopEnabled.snapAgl) ||
                    (s.type_name === 'navigate' && wantNavDem)) {
                    pts.push({ lat: s.location.lat, lng: s.location.lng });
                }
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
                        const navFt = Math.round(s.value1 * 3.28084), floorFt = Math.round(containing.minAltM * 3.28084);
                        if (navFt < floorFt - th.navFloorTolFt) {
                            violations.push({ ...ctx, ...sopBandFields(s, containing), deltaFt: navFt - floorFt,
                                check: 'Navigate below FFZ floor', stepIndex: s.index_in_app,
                                detail: `Navigate ${navFt} ft${sopAglStr(s)} < FFZ floor ${floorFt} ft — ${floorFt - navFt} ft under${containing.name ? ` (${containing.name})` : ''}`, severity: 'high' });
                        }
                    }
                    // 3. Navigate altitude ≤ containing FFZ max alt (+ tolerance).
                    if (sopEnabled.navUnderCeil && containing && typeof containing.maxAltM === 'number' && typeof s.value1 === 'number') {
                        const navFt = Math.round(s.value1 * 3.28084), ceilFt = Math.round(containing.maxAltM * 3.28084);
                        if (navFt > ceilFt + th.navCeilTolFt) {
                            violations.push({ ...ctx, ...sopBandFields(s, containing), deltaFt: navFt - ceilFt,
                                check: 'Navigate above FFZ ceiling', stepIndex: s.index_in_app,
                                detail: `Navigate ${navFt} ft${sopAglStr(s)} > FFZ ceiling ${ceilFt} ft — ${navFt - ceilFt} ft over${containing.name ? ` (${containing.name})` : ''}`, severity: 'high' });
                        }
                    }
                } else if (s.type_name === 'snapshot') {
                    snapN++;
                    // 4. Snapshot AGL ≥ min (default 0 → not underground).
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
                    // 6. Navigate→Snapshot distance within band.
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

            // 5. Block balance — one Thermal-on/GEM-on/Wait/GEM-off/Thermal-off per Snapshot.
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
    // Escape a violation detail and colorize the "N ft under/over" delta
    // (under = red, over = blue) so it pops in the report + Sheets copy.
    const SOP_UNDER_COLOR = '#ff5252', SOP_OVER_COLOR = '#4dc3ff';
    function sopDetailHtml(detail) {
        return escapeHtml(detail).replace(/— (\d+ ft (under|over))/g, (m, d, dir) =>
            `— <strong style="color:${dir === 'under' ? SOP_UNDER_COLOR : SOP_OVER_COLOR}">${d}</strong>`);
    }

    // Last completed run, kept for the 📋 Sheets copy.
    let lastSopResult = null;

    // Copy the last SOP report as a rich HTML table — pasting into Google
    // Sheets/Excel yields formatted cells. Plain-text TSV as fallback.
    function copySopReportForSheets() {
        const res = lastSopResult;
        if (!res || !Array.isArray(res.violations)) { showToast('Run the SOP check first.', '#ff9800'); return; }
        const v = res.violations;
        const sid = getCurrentSiteID();
        let siteName = ''; try { siteName = getCurrentSiteName() || ''; } catch (e) {}
        const missionsWith = new Set(v.map(x => x.id)).size;
        const title = `Mission SOP Check — Site ${sid || '?'}${siteName ? ` · ${siteName}` : ''}`;
        const summary = `${v.length} issue${v.length === 1 ? '' : 's'} across ${missionsWith} of ${res.missionCount} missions · ` +
            `${res.missionCount - missionsWith} clean · ${res.ffzCount} FFZs · preset ${MISSION_SOP_PRESETS[sopPreset].label} · ${new Date().toLocaleString()}`;
        const th = 'background:#263238;color:#ffffff;font-weight:bold;border:1px solid #90a4ae;padding:4px 8px;text-align:left';
        const td = 'border:1px solid #cfd8dc;padding:4px 8px;vertical-align:top';
        const tdNum = `${td};text-align:right`;
        const numCell = n => (typeof n === 'number') ? n : '';
        // One row per violation. Floor/ceiling checks fill the structured
        // altitude columns (numbers → sortable/filterable in Sheets); other
        // checks keep their sentence in Detail.
        const cols = ['Mission', 'Check', 'Step', 'Navigate MSL ft', 'Navigate AGL ft', 'FFZ Name',
            'FFZ Min MSL ft', 'FFZ Min AGL ft', 'FFZ Max MSL ft', 'FFZ Max AGL ft', 'Ft Over (+) / Under (−)', 'Severity', 'Detail'];
        const rowVals = x => {
            const structured = typeof x.deltaFt === 'number';
            return [x.name, x.check, x.stepIndex != null ? x.stepIndex : '',
                numCell(x.navMsl), numCell(x.navAgl), x.ffzName || '',
                numCell(x.ffzMinMsl), numCell(x.ffzMinAgl), numCell(x.ffzMaxMsl), numCell(x.ffzMaxAgl),
                structured ? x.deltaFt : '', x.severity === 'high' ? 'HARD' : 'WARN', structured ? '' : x.detail];
        };
        const rowsHtml = v.map(x => {
            const r = rowVals(x);
            const deltaColor = (typeof x.deltaFt === 'number') ? (x.deltaFt > 0 ? SOP_OVER_COLOR : SOP_UNDER_COLOR) : '#000000';
            const sevColor = x.severity === 'high' ? '#c62828' : '#b8860b';
            return `<tr>
                <td style="${td}">${escapeHtml(r[0])}</td>
                <td style="${td}">${escapeHtml(r[1])}</td>
                <td style="${tdNum}">${r[2]}</td>
                <td style="${tdNum}">${r[3]}</td>
                <td style="${tdNum}">${r[4]}</td>
                <td style="${td}">${escapeHtml(r[5])}</td>
                <td style="${tdNum}">${r[6]}</td>
                <td style="${tdNum}">${r[7]}</td>
                <td style="${tdNum}">${r[8]}</td>
                <td style="${tdNum}">${r[9]}</td>
                <td style="${tdNum};font-weight:bold;color:${deltaColor}">${r[10]}</td>
                <td style="${td};font-weight:bold;color:${sevColor}">${r[11]}</td>
                <td style="${td}">${escapeHtml(r[12])}</td>
            </tr>`;
        }).join('');
        const html = `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px">
            <tr><td colspan="${cols.length}" style="font-weight:bold;font-size:14px;padding:4px 8px">${escapeHtml(title)}</td></tr>
            <tr><td colspan="${cols.length}" style="color:#555555;padding:2px 8px">${escapeHtml(summary)}</td></tr>
            <tr>${cols.map(c => `<th style="${th}">${escapeHtml(c)}</th>`).join('')}</tr>
            ${rowsHtml || `<tr><td colspan="${cols.length}" style="${td};color:#2e7d32">No violations — all ${res.missionCount} missions pass.</td></tr>`}
        </table>`;
        const tsv = [title, summary, cols.join('\t')]
            .concat(v.map(x => rowVals(x).map(c => String(c).replace(/[\t\n]/g, ' ')).join('\t')))
            .join('\n');
        try {
            const item = new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([tsv], { type: 'text/plain' }),
            });
            navigator.clipboard.write([item]).then(
                () => showToast('SOP report copied — paste into Google Sheets.', '#5fff5f'),
                (e) => { console.warn(`${TAG} SOP rich copy failed, falling back to TSV`, e); copyToClipboard(tsv); showToast('Copied as plain text (TSV).', '#ff9800'); });
        } catch (e) {
            console.warn(`${TAG} ClipboardItem unavailable, falling back to TSV`, e);
            copyToClipboard(tsv);
            showToast('Copied as plain text (TSV).', '#ff9800');
        }
    }

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
            lastSopResult = state;
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
                        <span style="flex:1">${escapeHtml(it.check)}${it.stepIndex != null ? ` <span style="color:#888">· step ${it.stepIndex}</span>` : ''}<br><span style="color:#aaa">${sopDetailHtml(it.detail)}</span></span>
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
                <button data-sop-copy title="Copy report as a table — paste into Google Sheets" style="background:rgba(95,255,95,0.12);border:1px solid rgba(95,255,95,0.4);color:#5fff5f;padding:2px 8px;font-size:11px;border-radius:3px;cursor:pointer;font-weight:600">📋 Sheets</button>
                <button data-sop-rerun style="background:rgba(95,255,95,0.12);border:1px solid rgba(95,255,95,0.4);color:#5fff5f;padding:2px 8px;font-size:11px;border-radius:3px;cursor:pointer;font-weight:600">Re-run</button>
                <button data-sop-x style="background:rgba(95,255,95,0.12);border:1px solid rgba(95,255,95,0.4);color:#5fff5f;padding:2px 8px;font-size:11px;border-radius:3px;cursor:pointer;font-weight:600">✕</button>
            </div>
            ${body}`;
        document.body.appendChild(pop);
        pop.querySelector('[data-sop-x]').onclick = closeSopReport;
        pop.querySelector('[data-sop-rerun]').onclick = runMissionSopAndReport;
        pop.querySelector('[data-sop-copy]').onclick = copySopReportForSheets;
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
                { id: 'navUnderCeil', label: 'Check · Navigate ≤ FFZ ceiling', type: 'boolean', default: sopEnabled.navUnderCeil },
                { id: 'navCeilTolFt', label: 'Navigate-vs-ceiling slack', type: 'number', min: 0, max: 100, step: 1, default: th.navCeilTolFt, unit: 'ft' },
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
    // Legacy Mission Bank detection (TOP only) — v1.98
    // Some sites (first seen: 1465) are served Percepto's LEGACY
    // Angular Mission Bank on the current app build: the react-pages
    // iframe never exists, so every iframe-gated MBT feature (SUM,
    // Stage, badges, inline editing) silently never appears. Fail
    // loudly instead: a console warning each time the bank is opened
    // on such a site, plus one dismissible toast per site per session,
    // so "MBT is broken" reads as "this site is on the legacy path".
    // ========================================================
    const LEGACY_TOAST_ID = 'aim-mb-legacy-toast';
    const LEGACY_WAIT_MS = 8000;     // grace for the iframe to mount on slow loads
    const LEGACY_WATCH_MAX_MS = 30000; // stop polling after this per navigation
    const legacyToastShownSites = new Set();

    function hasReactPagesIframe() {
        try {
            return [...document.querySelectorAll('iframe')].some(f => (f.src || '').includes('/react-pages/'));
        } catch (e) { return false; }
    }

    function removeLegacyToast() {
        const el = document.getElementById(LEGACY_TOAST_ID);
        if (el) el.remove();
    }

    function showLegacyToast() {
        if (document.getElementById(LEGACY_TOAST_ID)) return;
        const toast = document.createElement('div');
        toast.id = LEGACY_TOAST_ID;
        toast.style.cssText = [
            'position:fixed', 'bottom:18px', 'right:18px', 'z-index:2147483646',
            'max-width:340px', 'background:#1f1f28', 'color:#ddd',
            'border:1px solid #444', 'border-left:3px solid #e6a23c',
            'border-radius:6px', 'padding:10px 30px 10px 12px',
            'font:12px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif',
            'box-shadow:0 4px 14px rgba(0,0,0,.45)',
        ].join(';');
        toast.innerHTML = `
            <div style="font-weight:600;color:#5fd3f3;margin-bottom:3px">AIM Mission Bank Tools</div>
            This site uses Percepto's <b>legacy Mission Bank</b> — MBT tools (SUM, Stage, badges, inline editing) aren't available here. Other sites are unaffected.
            <span data-aim-legacy-close style="position:absolute;top:6px;right:9px;cursor:pointer;color:#888;font-size:14px">✕</span>`;
        toast.querySelector('[data-aim-legacy-close]').addEventListener('click', removeLegacyToast);
        (document.body || document.documentElement).appendChild(toast);
    }

    function startLegacyBankWatch() {
        let timer = null;
        const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
        const check = () => {
            stop();
            // Scoped to the Mission Bank route only — mission-log and other
            // pages may legitimately have no react-pages iframe.
            if (!isOnMissionBank()) { removeLegacyToast(); return; }
            let waited = 0;
            let warned = false;
            timer = setInterval(() => {
                if (!isOnMissionBank()) { stop(); removeLegacyToast(); return; }
                if (hasReactPagesIframe()) {
                    // Iframe showed up (slow load, or Percepto migrated the
                    // site mid-session) — retract any false alarm.
                    if (warned) console.log(`${TAG} react-pages iframe appeared after ${waited / 1000}s — legacy warning retracted.`);
                    stop();
                    removeLegacyToast();
                    return;
                }
                waited += 2000;
                if (!warned && waited >= LEGACY_WAIT_MS) {
                    warned = true;
                    const siteID = mbCurrentSiteID() || '?';
                    console.warn(`${TAG} legacy Mission Bank detected on site ${siteID} — no react-pages iframe after ${waited / 1000}s. MBT UI is unavailable on this site (Percepto serves it the legacy Angular bank).`);
                    if (!legacyToastShownSites.has(siteID)) {
                        legacyToastShownSites.add(siteID);
                        showLegacyToast();
                    }
                }
                if (waited >= LEGACY_WATCH_MAX_MS) stop();
            }, 2000);
        };
        check();
        window.addEventListener('hashchange', check);
    }

    // ========================================================
    // Init
    // ========================================================
    // ============================================================
    // v2.08: 👁 Mission Preview overlay — Site Setup route (feature #212)
    //
    // Bridges the SS↔MB gap in the VIEW direction: while editing Site
    // Setup entities you can overlay any of the site's missions (steps +
    // flight order) on the SS map, so FFZ/FP reshaping is judged against
    // the missions that actually fly there. Read-only — mission editing
    // from SS is a later phase.
    //
    //   - 👁 button in .map-tools (SS route only, IFRAME) → draggable
    //     picker panel: checkbox + color swatch per mission, All / None /
    //     🔄 refresh. Selection persisted per env-keyed site.
    //   - Per checked mission: dashed polyline through located steps in
    //     instruction order (interactive:false — never blocks SS vertex
    //     editing) + N#/S# badges and 🚩 flag poles with hover tooltips
    //     (mission · step · type · altitude). Takeoff/returnHome skipped.
    //   - AIM_MB_PREVIEW BroadcastChannel: the Asset Inspector popup's 👁
    //     button sends {type:'PREVIEW_ASSET', name}; we rank-match (same
    //     ladder as pad-click merge) and toggle that mission's overlay,
    //     then ACK so the sender can detect MBT missing entirely.
    // ============================================================
    const MPV_CHANNEL_NAME = 'AIM_MB_PREVIEW';
    const MPV_SEL_KEY = 'aim-mb-preview-sel';       // { [envSiteKey(sid)]: [missionId, …] }
    const CACHE_KEY_MPV_ENABLED = 'aim-mb-preview-enabled';
    let mpvEnabled = gmGet(CACHE_KEY_MPV_ENABLED, true);
    // v2.12: "show ALL missions" mode — unchecked missions render as light
    // canvas dots (no lines/labels); checked ones keep full badges.
    const CACHE_KEY_MPV_ALL = 'aim-mb-preview-all';
    let mpvAllOn = gmGet(CACHE_KEY_MPV_ALL, false);
    const MPV_BTN_ID = 'aim-mb-preview-btn';
    const MPV_PANEL_ID = 'aim-mb-preview-panel';
    const MPV_COLORS = ['#7adfe6', '#ffd54f', '#ff8a65', '#aed581', '#ce93d8', '#4fc3f7', '#f48fb1', '#80cbc4', '#ffab91', '#fff176'];
    const mpv = { channel: null, layers: {}, panelEl: null, onSiteSetup: false, canvas: null, svg: null };

    // v2.12: preview works on BOTH sides of the bridge — Site Setup AND
    // Mission Bank (see missions on the map without opening the editor).
    // v2.14: and on Data View (legacy Angular app, map in the TOP window) —
    // the Asset Inspector's 👁 popup button works there too. Frame safety is
    // unchanged: mpvPreviewByName/mpvRedraw only act in the frame that owns
    // a Leaflet map, so on SS/MB the iframe instance answers, on DV the TOP
    // instance does.
    function mpvRouteOk() {
        const top = (() => { try { return window.top; } catch (e) { return window; } })();
        const hash = (top && top.location && top.location.hash) || location.hash || '';
        return /#\/site\/\d+\/control-panel\/(site-setup|mission-bank)/.test(hash)
            || /#\/site\/\d+\/data_view\//.test(hash);
    }

    function mpvSelForSite(sid) {
        const all = gmGet(MPV_SEL_KEY, {}) || {};
        const arr = all[envSiteKey(sid)];
        return Array.isArray(arr) ? arr.slice() : [];
    }
    function mpvSaveSel(sid, ids) {
        const all = gmGet(MPV_SEL_KEY, {}) || {};
        all[envSiteKey(sid)] = ids;
        gmSet(MPV_SEL_KEY, all);
    }
    function mpvMissions(sid) {
        const b = missionsBySite[sid];
        return (b && b.missions) || null;
    }
    function mpvColor(mid, missions) {
        const i = (missions || []).findIndex(m => m && m.id === mid);
        return MPV_COLORS[(i >= 0 ? i : 0) % MPV_COLORS.length];
    }

    function mpvClearMission(mid) {
        (mpv.layers[mid] || []).forEach(l => { try { l.remove(); } catch (e) {} });
        delete mpv.layers[mid];
    }
    function mpvClearAll() {
        Object.keys(mpv.layers).forEach(mpvClearMission);
        try { mpvHideTip(); } catch (e) {}   // v2.32: don't strand a hover label over removed dots
    }

    // v2.28 (extracted from v2.25): dedicated, PRIMED svg renderer. Letting
    // a vector layer lazily create map._renderer crashes on Data View's
    // older Leaflet — a fresh renderer's _bounds stays undefined until the
    // next moveend, the first add throws ("reading 'x'"), and the half-
    // registered layer then throws on EVERY pan/zoom → map freezes until
    // refresh. Explicit add + _update() sets _bounds immediately.
    function mpvEnsureSvg(L, map) {
        if (!mpv.svg || mpv.svg._map !== map) {
            try {
                mpv.svg = L.svg();
                mpv.svg.addTo(map);
                if (typeof mpv.svg._update === 'function') mpv.svg._update();
            } catch (e) { console.warn(`${TAG} [mpv] svg renderer setup failed:`, e); mpv.svg = null; }
        }
        return mpv.svg;
    }

    // ════════════════════════════════════════════════════════════════
    // v2.29: 👁 legal-route nav lines — the blue nav→nav line follows the
    // ACTUAL flyable path (along FPs / through FFZs) instead of a straight
    // segment. Strictly READ-ONLY reuse of the 🔋 Range solver
    // (rngBuildGraph/agDijkstra + helpers): if any of it is missing or
    // throws, every leg falls back to the straight dashed line — routing
    // can never break the preview.
    // Graph is built ONCE per site (async: entities fetch + build), cached;
    // the first draw renders straight lines and re-renders routed when the
    // graph lands.
    // ════════════════════════════════════════════════════════════════
    const mpvRoute = { sid: null, built: null, building: false, failedSid: null };

    function mpvRouteReady(sid) {
        if (!sid) return null;
        if (mpvRoute.sid === sid && mpvRoute.built) return mpvRoute.built;
        if (mpvRoute.failedSid === sid) return null;   // build failed once — straight lines, no retry storm
        if (mpvRoute.building) return null;
        if (typeof genFetchEntities !== 'function' || typeof rngBuildGraph !== 'function'
            || typeof agDijkstra !== 'function' || typeof agRingBbox !== 'function') {
            if (mpvRoute.failedSid !== 'api') {
                mpvRoute.failedSid = 'api';
                console.warn(`${TAG} [mpv] Range solver API not found — nav lines stay straight`);
            }
            return null;
        }
        mpvRoute.building = true;
        Promise.resolve(genFetchEntities(sid)).then(ent => {
            const built = rngBuildGraph(ent);
            built.boxes = built.ffzs.map(f => agRingBbox(f.ring, MB_ENTRY_FFZ_FT / 3.28084));
            mpvRoute.sid = sid;
            mpvRoute.built = built;
            mpvRoute.building = false;
            console.log(`${TAG} [mpv] legal-route graph ready (${built.graph.verts.size} verts) — re-rendering routed nav lines`);
            mpvRedraw();
        }).catch(e => {
            mpvRoute.building = false;
            mpvRoute.failedSid = sid;
            console.warn(`${TAG} [mpv] legal-route graph build failed — nav lines stay straight:`, e);
        });
        return null;
    }

    // Temp-attach a point into the graph the same way the solver attaches
    // bases: visibility edges inside every FFZ that contains it, a stub onto
    // the nearest FP arc, and a nearest-vertex fallback so it's never
    // stranded. Every added key is recorded in tempOut for detachment.
    function mpvAttachPoint(built, p, tag, tempOut) {
        const { graph, ffzs, boxes } = built;
        const entryM = MB_ENTRY_FFZ_FT / 3.28084;
        const k = `mpv:${tag}`;
        graph.verts.set(k, { lat: p.lat, lng: p.lng });
        graph.adj.set(k, []);
        tempOut.push(k);
        const link = (ka, kb, w) => { graph.adj.get(ka).push({ to: kb, w }); graph.adj.get(kb).push({ to: ka, w }); };
        let linked = 0;
        ffzs.forEach((f, fi) => {
            if (mbPointToPolygonMeters(p.lat, p.lng, f.ring) > entryM) return;
            const bb = boxes[fi];
            graph.verts.forEach((v, vk) => {
                if (vk === k || vk.indexOf('mpv') === 0) return;
                if (v.lat < bb.s || v.lat > bb.n || v.lng < bb.w || v.lng > bb.e) return;
                if (mbPointToPolygonMeters(v.lat, v.lng, f.ring) > entryM) return;
                if (!rngSegInside(p, v, f.ring)) return;
                link(k, vk, mbApproxMeters(p.lat, p.lng, v.lat, v.lng));
                linked++;
            });
        });
        const arc = agNearestArcPoint(graph, [p], MB_REACH_FFZ_FT / 3.28084);
        if (arc) {
            const xk = `mpvx:${tag}`;
            graph.verts.set(xk, arc.p);
            graph.adj.set(xk, []);
            tempOut.push(xk);
            link(xk, arc.ka, arc.w * arc.t);
            link(xk, arc.kb, arc.w * (1 - arc.t));
            link(k, xk, Math.max(1, arc.d));
            linked++;
        }
        if (!linked) {
            // v2.33 fix: mbNearestVertex scans ALL verts including the vertex
            // just added for p itself (distance 0) — it always won, the
            // key!==k guard rejected it, and the point ended up STRANDED
            // (degree 0). Scan excluding k instead.
            let best = null;
            graph.verts.forEach((v, vk) => {
                if (vk === k) return;
                const d = mbApproxMeters(p.lat, p.lng, v.lat, v.lng);
                if (!best || d < best.d) best = { vk, d };
            });
            if (best) link(k, best.vk, best.d);
        }
        return k;
    }

    function mpvDetachTemp(graph, tempKeys) {
        if (!tempKeys.length) return;
        const tset = new Set(tempKeys);
        tempKeys.forEach(k => { graph.verts.delete(k); graph.adj.delete(k); });
        graph.adj.forEach(list => {
            for (let i = list.length - 1; i >= 0; i--) if (tset.has(list[i].to)) list.splice(i, 1);
        });
    }

    // Legal path a→b as [[lat,lng],…], or null (no route / solver hiccup)
    // → caller draws the straight fallback.
    function mpvLegalPath(built, a, b) {
        const graph = built.graph;
        const temp = [];
        try {
            const ka = mpvAttachPoint(built, a, 'a', temp);
            const kb = mpvAttachPoint(built, b, 'b', temp);
            // v2.46: two points in the SAME FFZ connect DIRECTLY when the
            // straight segment stays inside it. mpvAttachPoint deliberately
            // never links temp points to each other, so without this every
            // same-FFZ leg doglegged via a ring/FP vertex (live catch: a
            // nav→nav leg retraced through an interior vertex instead of
            // flying straight).
            const entryM2 = MB_ENTRY_FFZ_FT / 3.28084;
            for (let fi = 0; fi < built.ffzs.length; fi++) {
                const f = built.ffzs[fi];
                if (mbPointToPolygonMeters(a.lat, a.lng, f.ring) > entryM2) continue;
                if (mbPointToPolygonMeters(b.lat, b.lng, f.ring) > entryM2) continue;
                if (!rngSegInside(a, b, f.ring)) continue;
                const w = mbApproxMeters(a.lat, a.lng, b.lat, b.lng);
                graph.adj.get(ka).push({ to: kb, w });
                graph.adj.get(kb).push({ to: ka, w });
                break;
            }
            const { dist, prev } = agDijkstra(graph, ka);
            if (!dist.has(kb)) return null;
            const path = [];
            let cur = kb, guard = 0;
            while (cur !== undefined && guard++ < 20000) {
                const v = graph.verts.get(cur);
                if (v) path.push([v.lat, v.lng]);
                if (cur === ka) break;
                cur = prev.get(cur);
            }
            if (cur !== ka) return null;
            path.reverse();
            return path.length >= 2 ? path : null;
        } catch (e) {
            console.warn(`${TAG} [mpv] legal-route leg failed — straight fallback:`, e);
            return null;
        } finally {
            try { mpvDetachTemp(graph, temp); } catch (e) {}
        }
    }

    function mpvDrawMission(m, color) {
        const L = composerGetL(), map = getLeafletMap();
        if (!L || !map || !m) return;
        mpvClearMission(m.id);
        const layers = [];
        const steps = Array.isArray(m.instructions) ? m.instructions : [];
        const located = steps.filter(s => s && s.location
            && typeof s.location.lat === 'number' && typeof s.location.lng === 'number'
            && s.type_name !== 'takeoff' && s.type_name !== 'returnHome');
        // v2.28: lines match the mission's real structure (a single
        // step-order polyline read as a meaningless Z on multi-snap
        // missions): BLUE dashed nav→nav flight line in flight order, plus
        // PINK dashed sightlines from each nav to its own snapshots.
        // interactive:false so clicks pass through to the editor beneath.
        const svgR = mpvEnsureSvg(L, map);
        const addLine = (pts, opts) => {
            let pl = null;
            try {
                if (svgR) opts.renderer = svgR;
                pl = L.polyline(pts, opts);
                pl.addTo(map);
                layers.push(pl);
            } catch (e) {
                console.warn(`${TAG} [mpv] line failed:`, e);
                // Leaflet registers a layer BEFORE onAdd runs — a layer that
                // threw mid-add stays attached and poisons every later map
                // move. Detach it so a failed line can never freeze the map.
                if (pl) { try { map.removeLayer(pl); } catch (e2) {} }
            }
        };
        const navPts = [];
        const sightlines = [];
        let curNav = null;
        for (const s of located) {
            if (s.type_name === 'navigate') { curNav = [s.location.lat, s.location.lng]; navPts.push(curNav); }
            else if (s.type_name === 'snapshot' && curNav) sightlines.push([curNav, [s.location.lat, s.location.lng]]);
        }
        if (navPts.length >= 2) {
            const navOpts = { color: stepColor('nav'), weight: 3, opacity: 0.85, dashArray: '7,7', interactive: false };
            // v2.29: route each leg along the actual flyable path (Range
            // solver graph). Graph not ready/failed → straight line now;
            // a routed re-render fires when the async build lands.
            const built = mpvRouteReady(getCurrentSiteID());
            if (built) {
                for (let i = 0; i + 1 < navPts.length; i++) {
                    const seg = mpvLegalPath(built,
                        { lat: navPts[i][0], lng: navPts[i][1] },
                        { lat: navPts[i + 1][0], lng: navPts[i + 1][1] });
                    addLine(seg || [navPts[i], navPts[i + 1]], Object.assign({}, navOpts));
                }
            } else {
                addLine(navPts, navOpts);
            }
        }
        for (const sl of sightlines) {
            addLine(sl, { color: stepColor('snap'), weight: 2, opacity: 0.75, dashArray: '4,6', interactive: false });
        }
        let nav = 0, snap = 0;
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            if (!s || !s.location || typeof s.location.lat !== 'number' || typeof s.location.lng !== 'number') continue;
            const t = s.type_name;
            let html = null, size = 0;
            if (t === 'navigate') {
                nav++;
                // v2.10: badges use the step-type colors (CP-customizable,
                // same as the Mission Bank N#/S# badges) — nav blue / snap
                // pink; the per-MISSION color stays on the dashed line +
                // picker swatch so missions remain tellable-apart.
                html = `<div style="width:22px;height:22px;border-radius:50%;background:${stepColor('nav')};color:#04222a;font:800 10px/19px monospace;text-align:center;border:2px solid rgba(0,0,0,0.6);box-shadow:0 1px 4px rgba(0,0,0,0.5);">N${nav}</div>`;
                size = 22;
            } else if (t === 'snapshot') {
                snap++;
                html = `<div style="width:17px;height:17px;border-radius:3px;background:${stepColor('snap')};color:#04222a;font:800 9px/16px monospace;text-align:center;border:1px solid rgba(0,0,0,0.6);opacity:0.92;">S${snap}</div>`;
                size = 17;
            } else if (t === 'flag pole' || s.type === 16) {
                html = '<div style="font-size:13px;line-height:14px;text-shadow:0 1px 2px #000;">🚩</div>';
                size = 14;
            } else {
                continue;   // takeoff/returnHome/control steps — noise on the SS map
            }
            try {
                const icon = L.divIcon({ className: 'aim-mpv-badge', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
                const mk = L.marker([s.location.lat, s.location.lng], { icon, interactive: true }).addTo(map);
                const alt = displayStepValue(s);
                const badgeHtml = `<b>${escapeHtml(m.name || '(mission)')}</b> · step ${i + 1}/${steps.length} · ${escapeHtml(t || ('type ' + s.type))}${alt ? ' · ' + escapeHtml(alt) : ''}`;
                if (CONTEXT === 'TOP') {
                    // v2.32: own hover label on DV — Percepto's tooltip
                    // subclass there crashes on bound tooltips.
                    mk.on('mouseover', () => mpvShowTip(map, mk.getLatLng(), badgeHtml));
                    mk.on('mouseout', mpvHideTip);
                } else {
                    mk.bindTooltip(
                        `<b>${escapeHtml(m.name || '(mission)')}</b><br>step ${i + 1}/${steps.length} · ${escapeHtml(t || ('type ' + s.type))}${alt ? ' · ' + escapeHtml(alt) : ''}`,
                        { direction: 'top', offset: [0, -8], opacity: 0.95 });
                }
                layers.push(mk);
            } catch (e) { console.warn(`${TAG} [mpv] marker failed:`, e); }
        }
        mpv.layers[m.id] = layers;
    }

    // v2.12: light-mode rendering for "show ALL missions" — one shared
    // canvas renderer, plain circles (nav blue / snap pink), no polyline,
    // no labels, no tooltips. DOM divIcon badges are one element each and
    // choke at all-missions scale; canvas circles are just paint, so this
    // IS materially lighter, not merely visually quieter.
    function mpvGetCanvas(L) {
        if (!mpv.canvas) { try { mpv.canvas = L.canvas({ padding: 0.3 }); } catch (e) { mpv.canvas = null; } }
        return mpv.canvas;
    }
    // v2.32: Data View's app SUBCLASSES Leaflet's tooltip pipeline
    // (openTooltip override in app-bundle) and it crashes on tooltips WE
    // bind ("appendChild … not of type 'Node'") — so on DV, hover labels
    // are our own floating div pinned to the map container. pointer-events
    // none, one shared element, hidden on mouseout/clear.
    let mpvTipEl = null;
    function mpvShowTip(map, latlng, html) {
        try {
            const c = map.getContainer();
            if (!mpvTipEl || !c.contains(mpvTipEl)) {
                mpvTipEl = document.createElement('div');
                mpvTipEl.style.cssText = 'position:absolute;z-index:10000;pointer-events:none;'
                    + 'background:rgba(18,20,26,0.92);color:#e6e6e6;border:1px solid rgba(255,255,255,0.25);'
                    + 'border-radius:4px;padding:4px 7px;font:11px/1.35 monospace;display:none;'
                    + 'white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.5)';
                c.appendChild(mpvTipEl);
            }
            mpvTipEl.innerHTML = html;
            const p = map.latLngToContainerPoint(latlng);
            mpvTipEl.style.left = Math.round(p.x + 12) + 'px';
            mpvTipEl.style.top = Math.round(p.y - 26) + 'px';
            mpvTipEl.style.display = 'block';
        } catch (e) {}
    }
    function mpvHideTip() {
        if (mpvTipEl) mpvTipEl.style.display = 'none';
    }

    function mpvDrawMissionLight(m) {
        const L = composerGetL(), map = getLeafletMap();
        if (!L || !map || !m || typeof L.circleMarker !== 'function') return;
        mpvClearMission(m.id);
        const layers = [];
        // v2.28: on Data View (TOP renders) the lazily-added canvas renderer
        // is broken on the page's older Leaflet — dots painted at stale
        // offsets after pan/zoom, and removals never repaint (ghost dots).
        // Use the explicitly-added + primed svg renderer there (proven by
        // the 👁 lines); canvas stays for SS/MB where all-missions scale
        // genuinely needs it and it works.
        const renderer = (CONTEXT === 'TOP') ? mpvEnsureSvg(L, map) : mpvGetCanvas(L);
        // v2.31: on Data View the dots are svg (cheap pointer events), so make
        // them self-identifying — hover shows WHOSE mission a dot belongs to.
        // Root of the "whose dots are these?!" confusion: dense lease families
        // (e.g. 18A) put several missions' steps on/next to one pad, and
        // anonymous dots read as wrong data. SS/MB keeps interactive:false —
        // canvas at all-missions scale is exactly where hit-testing hurts.
        const dvTips = CONTEXT === 'TOP';
        // FOCUS MODE: while ANY mission is checked (full badges), everyone
        // else's dots dim way down so the previewed mission pops. Hover
        // labels still work on dimmed dots. No toggle — strictly-better UX;
        // clears automatically when nothing is checked.
        const focusDim = mpvSelForSite(getCurrentSiteID() || '').length > 0;
        const dotFill = focusDim ? 0.22 : 0.85;
        const dotStroke = focusDim ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.55)';
        const steps = Array.isArray(m.instructions) ? m.instructions : [];
        for (const s of steps) {
            if (!s || !s.location || typeof s.location.lat !== 'number' || typeof s.location.lng !== 'number') continue;
            const t = s.type_name;
            let color = null, r = 0;
            if (t === 'navigate') { color = stepColor('nav'); r = 4; }
            else if (t === 'snapshot') { color = stepColor('snap'); r = 3; }
            else continue;
            try {
                const opts = { radius: r, color: dotStroke, weight: 1, fillColor: color, fillOpacity: dotFill, interactive: dvTips };
                if (renderer) opts.renderer = renderer;
                const cm = L.circleMarker([s.location.lat, s.location.lng], opts).addTo(map);
                if (dvTips) {
                    // v2.32: own hover label, NOT bindTooltip — Percepto's
                    // tooltip subclass on DV crashes on bound tooltips.
                    const tipHtml = `<b>${escapeHtml(m.name || '(mission)')}</b> · ${escapeHtml(t)}`;
                    cm.on('mouseover', () => mpvShowTip(map, cm.getLatLng(), tipHtml));
                    cm.on('mouseout', mpvHideTip);
                }
                layers.push(cm);
            } catch (e) {}
        }
        mpv.layers[m.id] = layers;
    }

    function mpvRedraw() {
        const sid = getCurrentSiteID();
        mpvClearAll();
        if (!sid || !mpvRouteOk() || !masterEnabled || !mpvEnabled) return;
        const missions = mpvMissions(sid);
        if (!missions) return;
        const map = getLeafletMap();
        if (!map) return;
        // Entity-less sites never build the overlay SVG pane — force it
        // once so our polylines render (see reference_leaflet_lazy_overlay_svg).
        try {
            const L = composerGetL();
            const pane = map.getPane && map.getPane('overlayPane');
            if (L && L.svg && pane && !pane.querySelector('svg')) L.svg().addTo(map);
        } catch (e) {}
        const sel = new Set(mpvSelForSite(sid));
        for (const m of missions) {
            if (!m) continue;
            if (sel.has(m.id)) mpvDrawMission(m, mpvColor(m.id, missions));
            else if (mpvAllOn) mpvDrawMissionLight(m);   // v2.12: sea-of-dots for the rest
        }
    }

    // v2.13: a mission save landed (observed by the save hook's response
    // watcher) — the overlay draws from the missionsBySite cache, which a
    // native editor save leaves stale (user had to uncheck/recheck to see
    // the new dots). Debounced: Percepto save flows can POST more than
    // once back-to-back. Only fires when something is actually overlaid.
    let mpvSaveRefreshTimer = null;
    function mpvOnMissionSaved() {
        if (CONTEXT !== 'IFRAME') return;
        if (!masterEnabled || !mpvEnabled || !mpvRouteOk()) return;
        const sid = getCurrentSiteID();
        if (!sid) return;
        if (!mpvSelForSite(sid).length && !mpvAllOn) return;
        if (mpvSaveRefreshTimer) clearTimeout(mpvSaveRefreshTimer);
        mpvSaveRefreshTimer = setTimeout(() => {
            mpvSaveRefreshTimer = null;
            delete missionsBySite[sid];
            fetchMissions(sid, () => {
                mpvRedraw();
                if (mpv.panelEl) mpvRenderList();
                console.log(`${TAG} [mpv] overlay refreshed after mission save`);
            }, (err) => console.warn(`${TAG} [mpv] post-save refresh failed:`, err));
        }, 900);
    }

    // "Show ALL missions" toggled — fetch if the cache is cold, then redraw.
    function mpvAllChanged() {
        const sid = getCurrentSiteID();
        if (!sid || !mpvRouteOk()) return;
        if (mpvAllOn && !mpvMissions(sid)) {
            fetchMissions(sid, () => mpvRedraw(), (err) => showToast('Mission fetch failed: ' + err, '#ff5252', 3500));
        } else {
            mpvRedraw();
        }
    }

    function mpvSetMission(sid, mid, on) {
        const ids = mpvSelForSite(sid).filter(x => x !== mid);
        if (on) ids.push(mid);
        mpvSaveSel(sid, ids);
        mpvRedraw();
    }

    // ---- picker panel ----
    function mpvClosePanel() {
        if (mpv.panelEl) { try { mpv.panelEl.remove(); } catch (e) {} mpv.panelEl = null; }
    }

    function mpvOpenPanel() {
        const sid = getCurrentSiteID();
        if (!sid) { showToast('No site loaded.', '#ff9800', 2500); return; }
        if (mpv.panelEl) { mpvClosePanel(); return; }   // 👁 button = toggle
        const btnCss = 'background:#0f1216;border:1px solid #2a3340;color:#e6e6e6;padding:2px 10px;border-radius:3px;cursor:pointer;font:inherit;font-size:11px;';
        const el = document.createElement('div');
        el.id = MPV_PANEL_ID;
        el.style.cssText = 'position:fixed;top:70px;right:60px;z-index:100001;background:#0f1216;border:1px solid #14d2dc;border-radius:6px;box-shadow:0 8px 28px rgba(0,0,0,0.7);color:#e6e6e6;font-family:Lato,\'Segoe UI\',sans-serif;font-size:12px;width:290px;max-height:70vh;display:flex;flex-direction:column;';
        el.innerHTML = `
            <div data-mpv-drag style="background:#14d2dc;color:#000;padding:6px 10px;font-weight:700;border-radius:5px 5px 0 0;cursor:move;user-select:none;display:flex;align-items:center;gap:6px;">
                <span style="flex:1;">👁 Mission preview</span>
                <button data-mpv-refresh title="Re-fetch missions from the server" style="background:rgba(0,0,0,0.15);border:none;color:#000;cursor:pointer;border-radius:3px;font-size:12px;padding:1px 5px;">🔄</button>
                <button data-mpv-close style="background:transparent;border:none;color:#000;font-weight:700;font-size:14px;cursor:pointer;padding:0 4px;">×</button>
            </div>
            <div style="display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.08);">
                <button data-mpv-all style="${btnCss}">All</button>
                <button data-mpv-none style="${btnCss}">None</button>
                <span style="flex:1;text-align:right;color:#9ad;font-size:10px;align-self:center;">hover a badge for step info</span>
            </div>
            <div data-mpv-list style="overflow:auto;padding:4px 0;"></div>`;
        document.body.appendChild(el);
        mpv.panelEl = el;
        try { makeDraggable(el, el.querySelector('[data-mpv-drag]')); } catch (e) {}
        el.addEventListener('click', mpvPanelClick);
        el.addEventListener('change', (e) => {
            const cb = e.target && e.target.closest && e.target.closest('input[data-mpv-mid]');
            if (!cb) return;
            const sid2 = getCurrentSiteID();
            if (sid2) mpvSetMission(sid2, Number(cb.getAttribute('data-mpv-mid')), cb.checked);
        });
        mpvRenderList();
        if (!mpvMissions(sid)) {
            fetchMissions(sid, () => { mpvRenderList(); mpvRedraw(); },
                (err) => { mpvRenderList(); showToast('Mission fetch failed: ' + err, '#ff5252', 3500); });
        }
    }

    function mpvRenderList() {
        if (!mpv.panelEl) return;
        const list = mpv.panelEl.querySelector('[data-mpv-list]');
        if (!list) return;
        const sid = getCurrentSiteID();
        const missions = sid ? mpvMissions(sid) : null;
        if (!missions) { list.innerHTML = '<div style="padding:10px;color:#9ad;">Loading missions…</div>'; return; }
        if (!missions.length) { list.innerHTML = '<div style="padding:10px;color:#9ad;">No missions on this site.</div>'; return; }
        const sel = new Set(mpvSelForSite(sid));
        list.innerHTML = missions.filter(Boolean).map(m => {
            const color = mpvColor(m.id, missions);
            const steps = realSteps(m.instructions).length;
            return `<label style="display:flex;align-items:center;gap:7px;padding:4px 10px;cursor:pointer;">
                <input type="checkbox" data-mpv-mid="${m.id}" ${sel.has(m.id) ? 'checked' : ''} style="accent-color:${color};">
                <span style="width:10px;height:10px;border-radius:2px;background:${color};flex:0 0 auto;"></span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(m.name || '')}">${escapeHtml(m.name || '(unnamed)')}</span>
                <span style="color:#9ad;font-size:10px;flex:0 0 auto;">${steps} steps</span>
            </label>`;
        }).join('');
    }

    function mpvPanelClick(e) {
        const sid = getCurrentSiteID();
        if (!sid) return;
        if (e.target.closest('[data-mpv-close]')) { mpvClosePanel(); return; }
        if (e.target.closest('[data-mpv-refresh]')) {
            delete missionsBySite[sid];
            mpvRenderList();
            fetchMissions(sid, () => { mpvRenderList(); mpvRedraw(); },
                (err) => { mpvRenderList(); showToast('Mission fetch failed: ' + err, '#ff5252', 3500); });
            return;
        }
        if (e.target.closest('[data-mpv-all]') || e.target.closest('[data-mpv-none]')) {
            const missions = mpvMissions(sid) || [];
            mpvSaveSel(sid, e.target.closest('[data-mpv-all]') ? missions.filter(Boolean).map(m => m.id) : []);
            mpvRenderList();
            mpvRedraw();
        }
    }

    // ---- map-tools button + route gating ----
    function mpvTeardown() {
        const b = document.getElementById(MPV_BTN_ID);
        if (b) try { b.remove(); } catch (e) {}
        mpvClosePanel();
        mpvClearAll();
    }

    function mpvInjectButton() {
        if (!masterEnabled || !mpvEnabled || !mpvRouteOk()) {
            if (mpv.onSiteSetup) { mpv.onSiteSetup = false; mpvTeardown(); }
            return;
        }
        // v2.14: only the frame that owns a Leaflet map participates (SS/MB
        // iframe, Data View TOP). Keeps the SS TOP instance from duplicate-
        // fetching missions it can never draw. Map not mounted yet → the 3s
        // interval retries.
        if (!getLeafletMap()) return;
        if (!mpv.onSiteSetup) {
            mpv.onSiteSetup = true;
            // Entering the route with a persisted selection (or ALL mode):
            // restore the overlay, fetching missions first if cache is cold.
            const sid = getCurrentSiteID();
            if (sid && (mpvSelForSite(sid).length || mpvAllOn) && !mpvMissions(sid)) {
                fetchMissions(sid, () => mpvRedraw(), (err) => console.warn(`${TAG} [mpv] restore fetch failed:`, err));
            } else {
                mpvRedraw();
            }
        }
        // The map/Leaflet can lag the route change — if overlays should
        // exist but don't yet, retry on this same injection tick.
        const sid = getCurrentSiteID();
        if (sid && (mpvSelForSite(sid).length || mpvAllOn) && !Object.keys(mpv.layers).length
            && mpvMissions(sid) && getLeafletMap()) mpvRedraw();
        // v2.26: cross-tab drift self-heal. The picker selection is GM-stored
        // with no broadcast, so un/checking a mission in ANOTHER tab (e.g. the
        // Mission Bank tab) left this tab's overlay stale — most visible on
        // Data View, which has no picker of its own. Every tick, compare the
        // drawn mission set against the stored one and redraw on mismatch.
        if (sid && mpvMissions(sid) && getLeafletMap()) {
            const want = new Set(mpvSelForSite(sid));
            if (mpvAllOn) (mpvMissions(sid) || []).forEach(m2 => { if (m2) want.add(m2.id); });
            const have = Object.keys(mpv.layers).map(Number);
            if (have.length !== want.size || have.some(id => !want.has(id))) mpvRedraw();
        }
        if (document.getElementById(MPV_BTN_ID)) return;
        const tools = document.querySelector('.map-tools');
        if (!tools) return;
        const btn = document.createElement('div');
        btn.id = MPV_BTN_ID;
        btn.className = 'map-tools__button';
        btn.title = 'AIM Mission preview — overlay this site\'s missions on the Site Setup map';
        btn.textContent = '👁';
        btn.style.cssText = 'cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;';
        btn.addEventListener('click', (e) => { e.stopPropagation(); mpvOpenPanel(); });
        tools.appendChild(btn);
    }

    // ---- Asset Inspector bridge (AIM_MB_PREVIEW channel) ----
    function mpvAck(extra) {
        try { mpv.channel && mpv.channel.postMessage(Object.assign({ type: 'PREVIEW_ACK' }, extra)); } catch (e) {}
    }

    function mpvPreviewByName(name) {
        const sid = getCurrentSiteID();
        // Multi-frame protocol: instances without a map stay quiet so the
        // frame that HAS one answers. v2.21: quiet ≠ silent — log which gate
        // stopped us, so a no-ACK timeout is diagnosable from the console
        // (this exact silence cost a debugging round on Data View).
        if (!sid) { console.log(`${TAG} [mpv] PREVIEW_ASSET "${name}": no site id in hash — not answering (${CONTEXT})`); return; }
        if (!getLeafletMap()) { console.log(`${TAG} [mpv] PREVIEW_ASSET "${name}": no Leaflet map in this frame (${CONTEXT}) — leaving it to the frame that owns one`); return; }
        if (!masterEnabled || !mpvEnabled) {
            mpvAck({ found: false, name, disabled: true });
            showToast('Mission preview is disabled in the Control Panel.', '#ff9800', 3000);
            return;
        }
        const go = (missions) => {
            const cands = rankMatchMissions(name, missions);
            if (!cands.length) {
                mpvAck({ found: false, name });
                showToast(`No mission matching "${name}" on this site.`, '#ff9800', 3000);
                return;
            }
            const hit = cands[0];
            const on = mpvSelForSite(sid).indexOf(hit.id) < 0;
            mpvSetMission(sid, hit.id, on);
            if (mpv.panelEl) mpvRenderList();
            mpvAck({ found: true, name: hit.name, shown: on });
            showToast(`${on ? '👁 Showing' : 'Hid'} mission "${hit.name}"${cands.length > 1 ? ` (${cands.length} matched — best rank shown)` : ''}`, '#7adfe6', 2500);
        };
        const cached = mpvMissions(sid);
        if (cached) go(cached);
        else fetchMissions(sid, go, (err) => {
            mpvAck({ found: false, name, error: String(err) });
            showToast('Mission fetch failed: ' + err, '#ff5252', 3500);
        });
    }

    function mpvInit() {
        try { mpv.channel = new BroadcastChannel(MPV_CHANNEL_NAME); } catch (e) { mpv.channel = null; }
        if (mpv.channel) {
            mpv.channel.onmessage = (ev) => {
                const msg = ev.data || {};
                if (msg.type !== 'PREVIEW_ASSET' || !msg.name) return;
                if (!mpvRouteOk()) return;
                // Cross-tab gate (same rule as Styler TRIGGER_ACTION):
                // BroadcastChannel delivers to EVERY open percepto tab, so
                // clicking 👁 on a Data View tab used to draw the overlay in
                // a background Mission Bank tab on the same site (which also
                // ACKed, so no timeout toast anywhere visible). Only the tab
                // the user actually clicked in — the focused one — answers.
                if (!document.hasFocus()) {
                    console.log(`${TAG} [mpv] PREVIEW_ASSET ignored — tab not focused (cross-tab broadcast)`);
                    return;
                }
                try { mpvPreviewByName(String(msg.name)); }
                catch (e) { console.warn(`${TAG} [mpv] preview-by-name failed:`, e); }
            };
        }
        setInterval(mpvInjectButton, 3000);
        setTimeout(mpvInjectButton, 800);
        // Route changes: close the panel (site/section may differ) and
        // re-gate the button + overlays. Top hash is the SPA's router.
        try {
            (window.top || window).addEventListener('hashchange', () => {
                mpvClosePanel();
                setTimeout(() => { try { mpvInjectButton(); mpvRedraw(); } catch (e) {} }, 400);
            });
        } catch (e) {}
    }

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
        // v2.14: 👁 Mission Preview runs in BOTH contexts. On SS/MB the
        // iframe owns the map and TOP's instance harmlessly no-ops (its
        // ticks find no .map-tools and no Leaflet map); on Data View the
        // map lives in TOP, so the TOP instance is the one that draws.
        // mpvRouteOk + getLeafletMap gate every action either way.
        try { mpvInit(); } catch (e) { console.warn(`${TAG} [mpv] init failed:`, e); }
        if (CONTEXT === 'TOP') {
            // The Angular-scope map grab needs no prototype patch, but
            // stamping __aim_map__ on the DV container lets the Asset
            // Inspector's own detector find the map too. No-op when this
            // realm has no window.L (SS/MB top frame).
            try { patchLeafletMap(); } catch (e) {}
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
            const editorObserver = new MutationObserver((recs) => {
                // Tile-churn guard (v1.88): pan/zoom floods childList mutations
                // from the tile pane; nothing we style lives there, so a batch
                // that is ONLY tile churn shouldn't cost a collapse+restyle pass.
                if (recs.length && recs.every(r => r.target && r.target.closest && r.target.closest('.leaflet-tile-pane'))) return;
                MB_PERF.obs++;
                if (collapseDebounce) return;
                collapseDebounce = setTimeout(() => {
                    collapseDebounce = null;
                    try { applyNativeEditorCollapse(); } catch (e) {}
                    try { injectEditorCollapseButton(); } catch (e) {}
                    // Re-inject the composer button row promptly — Percepto swaps
                    // the sidebar (step edit form / Add Instruction list) and
                    // unmounts the row; the 4s interval read as "Stage vanished".
                    try { injectComposerButton(); } catch (e) {}
                    // Re-stamp the N#/S# marker badges too — Percepto re-renders a
                    // step's marker after a per-step save, wiping our number until
                    // the next style pass (the "S1 vanished but the circle stayed").
                    try { composerStyleNativeMarkers(); } catch (e) {}
                }, 150);
            });
            try { editorObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
            // v1.90 perf reporter — one console line per 5s window in which the
            // editor machinery did anything, so slowness attributes to a pathway.
            setInterval(() => {
                const p = MB_PERF;
                if (!p.obs && !p.ticks && !p.collapsePasses && !p.markerPasses && !p.elevLook && !p.elevKicks) return;
                console.log(`${TAG} [perf] 5s — obs:${p.obs} ticks:${p.ticks} | collapse ${p.collapsePasses}× ${p.collapseMs.toFixed(0)}ms writes:${p.cardWrites} creates:${p.cxCreates} | markers ${p.markerPasses}× ${p.markerMs.toFixed(0)}ms | elev looks:${p.elevLook} kicks:${p.elevKicks}`);
                Object.keys(p).forEach(k => { p[k] = 0; });
            }, 5000);
            installRightClickHandler();
            // 🧮 Math in native step number fields (#236) — capture-phase
            // Enter/blur on Ant InputNumbers inside the step edit form.
            installMathFields();
            // READ-ONLY probe: logs + diffs each mission save vs the cached
            // original (never modifies the save). Tells us whether the form
            // recomputes dependent fields, which decides if a fast body-patch
            // path is safe. Harmless to leave on.
            installSaveDiffProbe();
            installSaveHotkey();
        }
        // TOP-only: watch for sites served the legacy Angular Mission Bank
        // (no react-pages iframe) and say so instead of silently missing.
        if (CONTEXT === 'TOP') {
            try { startLegacyBankWatch(); } catch (e) { console.warn(`${TAG} legacy-bank watch failed to start:`, e); }
        }
        // Re-evaluate injection on hashchange (URL → Mission Bank)
        try {
            const top = window.top || window;
            top.addEventListener('hashchange', () => {
                hideSumButton();
                // SAFETY: disarm snapshot auto-AGL on any navigation, so it never
                // stays armed when you (re)enter the Mission Bank.
                if (autoSnapAglEnabled) { autoSnapAglEnabled = false; try { updateAutoSnapAglUI(); } catch (e) {} }
                try { stageCancelArm(true); } catch (e) {}
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
