// ==UserScript==
// @name         Latest - AIM Mission Bank Tools
// @namespace    http://tampermonkey.net/
// @version      0.74
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

    const SCRIPT_ID = 'aim-mission-bank-tools';
    const SCRIPT_VERSION = '0.74';
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
    const LOG_SUM_BTN_ID = 'aim-mb-log-sum-btn';            // launcher on the Mission Log page
    const DEFAULT_GAP_DAYS = 7;

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
            toggles: [{ id: 'master', label: 'Enable', type: 'boolean', default: true, master: true }],
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

    function getElevationFromCache(lat, lng) {
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
        const key = elevCacheKey(lat, lng);
        const cache = loadElevationCache();
        if (cache[key] != null) return Promise.resolve(cache[key]);
        if (elevInFlight[key]) return elevInFlight[key];
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
        while (elevActive < ELEV_CONCURRENCY && elevQueue.length > 0) {
            const task = elevQueue.shift();
            elevActive++;
            const url = `/location_altitude/?location=${encodeURIComponent(JSON.stringify({ lat: task.lat, lng: task.lng }))}`;
            fetch(url, { credentials: 'include' })
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    const meters = data && typeof data.altitude === 'number' ? data.altitude : null;
                    if (meters != null) {
                        const cache = loadElevationCache();
                        cache[task.key] = meters;
                        saveElevationCache();
                    }
                    task.resolve(meters);
                })
                .catch(() => task.resolve(null))
                .finally(() => { elevActive--; pumpElevQueue(); });
        }
    }

    // Bulk-fetch elevations for many points with progress callbacks.
    // points: [{lat, lng, id?}] — id is yours, returned in the result map.
    // Returns Promise<{[id|index]: meters | null}>.
    function bulkFetchElevations(points, onProgress) {
        if (!points || points.length === 0) return Promise.resolve({});
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
        panelEl.querySelectorAll('input[data-row]').forEach(cb => {
            cb.onclick = (e) => {
                e.stopPropagation();
                const id = Number(cb.dataset.row);
                if (cb.checked) panelState.selectedIds.add(id); else panelState.selectedIds.delete(id);
                renderTableView();
            };
        });
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
        btn.className = (newBtn ? newBtn.className : 'ant-btn ant-btn-primary') + ' aim-mb-sum-neon-btn';
        btn.innerHTML = '<span>SUM</span>';
        btn.title = 'Open mission summary (AIM Mission Bank Tools)';
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
                #${PANEL_ID} .aim-mb-header-title { font-weight: 700; font-size: 13px; flex: 1; text-align: center; color: #5fff5f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

        panelEl = document.createElement('div');
        panelEl.id = PANEL_ID;
        Object.assign(panelEl.style, {
            position: 'fixed', top: '80px', right: '20px',
            width: '900px', height: '600px', minWidth: '500px', minHeight: '300px',
            background: '#0f1216', border: '1px solid #14d2dc', borderRadius: '6px',
            zIndex: '99999', display: 'flex', flexDirection: 'column',
            boxShadow: '0 8px 28px rgba(0,0,0,0.7)',
        });

        // Header (draggable handle)
        const header = document.createElement('div');
        header.className = 'aim-mb-header';
        header.innerHTML = `
            <div class="aim-mb-header-title">📋 Mission Summary — <span data-site></span></div>
            <button class="aim-mb-header-btn" data-refresh title="Re-fetch missions">Refresh</button>
            <button class="aim-mb-header-btn" data-close>✕</button>
        `;
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

        // Resize handle
        const resize = document.createElement('div');
        resize.className = 'aim-mb-resize';
        panelEl.appendChild(resize);
        makeResizable(panelEl, resize);

        document.body.appendChild(panelEl);
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
            el.style.left = `${startLeft + e.clientX - startX}px`;
            el.style.top = `${startTop + e.clientY - startY}px`;
        });
        const stop = (e) => {
            if (e && e.pointerId !== pointerId) return;
            dragging = false;
            try { handle.releasePointerCapture(pointerId); } catch (er) {}
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
            resizing = false;
            try { handle.releasePointerCapture(pointerId); } catch (er) {}
        };
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
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
        const prefix = (panelState && panelState.mode === 'log') ? '📋 Mission Log' : '📋 Mission Summary';
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
                renderDetailView(id);
            };
        });
        // Checkbox per row
        panelEl.querySelectorAll('input[data-row]').forEach(cb => {
            cb.onclick = (e) => {
                e.stopPropagation();
                const id = Number(cb.dataset.row);
                if (cb.checked) panelState.selectedIds.add(id);
                else panelState.selectedIds.delete(id);
                renderTableView();
            };
        });
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
                        <button class="aim-mb-tbtn" data-detail-export="sheets" title="Copy visible rows → Sheets">Copy → Sheets</button>
                        <button class="aim-mb-tbtn" data-detail-export="kml" title="Export GPS steps (navigate/snapshot) as KML with 3D altitude pins">Export KML</button>
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
                                ${filteredSteps.map(s => {
                                    const origIdx = allSteps.indexOf(s) + 1;
                                    return renderStepRow(s, origIdx, unit);
                                }).join('')}
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
        allSteps.forEach(s => {
            if (!s || !s.location || s.location.lat == null) return;
            const lat = Number(s.location.lat), lng = Number(s.location.lng);
            const key = elevCacheKey(lat, lng);
            if (seen.has(key)) return;
            seen.add(key);
            const cache = loadElevationCache();
            if (cache[key] != null) return; // already cached
            // Skip if another iteration already requested this point
            if (elevInFlight[key]) return;
            points.push({ lat, lng, id: key });
        });
        if (points.length === 0) return;
        console.log(`${TAG} fetching ${points.length} elevations`);
        elevFetchActive = { missionId, total: points.length, done: 0 };
        updateElevProgressLabel();
        bulkFetchElevations(points, (done, total) => {
            if (elevFetchActive) { elevFetchActive.done = done; updateElevProgressLabel(); }
        }).then(() => {
            elevFetchActive = null;
            // ONE re-render after everything completes
            if (panelState && panelState.drillId === missionId) {
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

    function exportDetailToKML(row, allSteps, unit) {
        const gpsSteps = allSteps.filter(s =>
            s.location && typeof s.location === 'object' && s.location.lat != null
            && (s.type_name === 'navigate' || s.type_name === 'snapshot')
        );
        if (gpsSteps.length === 0) {
            showToast('No GPS steps (navigate/snapshot) to export.', '#ff9800');
            return;
        }
        // KML colors are aabbggrr (reversed from hex RGB).
        // Navigate = #5fff5f → green → KML ff5fff5f
        // Snapshot = #ff9800 → orange → KML ff0098ff
        const placemarks = gpsSteps.map((s, i) => {
            const idx = allSteps.indexOf(s) + 1;
            const type = displayStepType(s);
            const altM = (s.value1 != null && s.value1_name === 'm') ? Number(s.value1) : 0;
            const lat = Number(s.location.lat);
            const lng = Number(s.location.lng);
            const styleId = s.type_name === 'navigate' ? 'nav' : 'snap';
            return `    <Placemark>
      <name>Step ${idx} — ${escapeXml(type)}</name>
      <description>Altitude: ${Math.round(altM)} m (${Math.round(altM * 3.28084).toLocaleString()} ft)</description>
      <styleUrl>#style-${styleId}</styleUrl>
      <Point>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${lng},${lat},${altM}</coordinates>
      </Point>
    </Placemark>`;
        }).join('\n');
        const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(row.name)} — GPS Steps</name>
    <description>Navigate + Snapshot steps with 3D altitude pins. Exported by AIM Mission Bank Tools v${SCRIPT_VERSION}.</description>
    <Style id="style-nav">
      <IconStyle><color>ff5fff5f</color><scale>1.1</scale></IconStyle>
      <LabelStyle><color>ff5fff5f</color></LabelStyle>
    </Style>
    <Style id="style-snap">
      <IconStyle><color>ff0098ff</color><scale>1.1</scale></IconStyle>
      <LabelStyle><color>ff0098ff</color></LabelStyle>
    </Style>
${placemarks}
  </Document>
</kml>`;
        // Download as file. Percepto's iframe sandbox may block the
        // download attribute, so try from top frame first, then fall
        // back to clipboard so the user can paste into a .kml file.
        const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
        const blobUrl = URL.createObjectURL(blob);
        const safeName = (row.name || 'mission').replace(/[^a-zA-Z0-9_\- ]/g, '').trim();
        let downloaded = false;
        try {
            const topDoc = (window.top || window).document;
            const a = topDoc.createElement('a');
            a.href = blobUrl;
            a.download = `${safeName}_steps.kml`;
            topDoc.body.appendChild(a);
            a.click();
            a.remove();
            downloaded = true;
        } catch (e) {}
        if (!downloaded) {
            try {
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = `${safeName}_steps.kml`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                downloaded = true;
            } catch (e) {}
        }
        if (!downloaded) {
            copyToClipboard(kml);
            showToast('Download blocked. KML copied to clipboard — paste into a .kml file.', '#ff9800');
        } else {
            showToast(`Exported ${gpsSteps.length} GPS steps as KML`, '#5fff5f');
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
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
    function handleMissionSave(bodyStr) {
        if (fastBulkSave) {
            console.log(`${TAG} [fast-save] mission-save request intercepted — fastBulkSave ON, checking staged changes…`);
            try { return patchMissionSaveBody(bodyStr); }
            catch (e) { console.warn(`${TAG} [fast-save] patch error — sending ORIGINAL save unchanged:`, e); return null; }
        }
        try { if (DEBUG()) probeSavePayload(bodyStr); } catch (e) {} // read-only diff log only when debugging
        return null;
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
            installRightClickHandler();
            // READ-ONLY probe: logs + diffs each mission save vs the cached
            // original (never modifies the save). Tells us whether the form
            // recomputes dependent fields, which decides if a fast body-patch
            // path is safe. Harmless to leave on.
            installSaveDiffProbe();
        }
        // Re-evaluate injection on hashchange (URL → Mission Bank)
        try {
            const top = window.top || window;
            top.addEventListener('hashchange', () => {
                hideSumButton();
                runSumInjection();
            });
        } catch (e) {}
        // Flush any pending elevation cache writes on tab close.
        window.addEventListener('beforeunload', () => flushElevationCache());
        console.log(`${TAG} ready`);
    }

    init();
})();
