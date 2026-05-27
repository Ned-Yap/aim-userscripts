// ==UserScript==
// @name         AIM Mission Bank Tools
// @namespace    http://tampermonkey.net/
// @version      0.19
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Bank_Tools.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Bank_Tools.user.js
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
    const SCRIPT_VERSION = '0.19';
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
    const CACHE_KEY_DISTANCE_UNIT = 'aim-mb-distance-unit'; // 'imperial' | 'metric'
    const CACHE_KEY_FLIGHT_THRESHOLDS = 'aim-mb-flight-thresholds';

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

    // Panel state — fresh each open
    let panelEl = null;
    let panelState = null; // { sortKey, sortDir, search, selectedIds, distanceUnit, drillId, tableScrollY }

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

    // ========================================================
    // Data — fetch + derive per-mission stats
    // ========================================================
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
        return t;
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
        const stored = gmGet(CACHE_KEY_VISIBLE_COLS, null);
        if (Array.isArray(stored) && stored.length > 0) {
            // Migrate v0.8 hardcoded step-type IDs → stype:… IDs
            const migrated = stored.map(id => COLUMN_ID_MIGRATION[id] || id);
            return migrated.filter(id => COL_BY_ID[id]);
        }
        return COLUMNS.filter(c => c.defaultVisible).map(c => c.id);
    }

    function setVisibleColumnIds(ids) {
        gmSet(CACHE_KEY_VISIBLE_COLS, ids);
    }

    function formatCellValue(row, col, unit, thresholds) {
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
        if (col.id === 'estFlights') return estimateFlights(row.batteryConsumption, thresholds) || 0;
        if (col.dynamic && col.stepTypeKey) return (row.stepTypeCounts || {})[col.stepTypeKey] || 0;
        const v = row[col.key];
        if (col.kind === 'text' || col.kind === 'dot') return (v || '').toString().toLowerCase();
        return Number(v) || 0;
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

    function injectButtonIntoRow(doc, row, header) {
        // Reuse the className from the existing "New mission" button so
        // SUM picks up Percepto's Ant theme (size, color, hover state).
        const newBtn = header.querySelector('.missions-list__new-button');
        const btn = doc.createElement('button');
        btn.id = SUM_BTN_ID;
        btn.type = 'button';
        btn.className = newBtn ? newBtn.className : 'ant-btn ant-btn-primary';
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
    }

    function hideSumButton() {
        try {
            document.querySelectorAll(`#${SUM_BTN_ID}`).forEach(el => el.remove());
            document.querySelectorAll(`#${TOOLBAR_ROW_ID}`).forEach(el => el.remove());
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
        console.log(`${TAG} right-click mission inspector armed`);
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
    function openPanel() {
        const siteID = getCurrentSiteID();
        if (!siteID) { showToast('No site loaded.', '#ff5252'); return; }
        if (!panelState) initPanelState();
        if (!panelEl) buildPanelChrome();
        panelEl.style.display = 'flex';
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

    function initPanelState() {
        panelState = {
            sortKey: 'flightDistance', // default: longest distance first
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
                #${PANEL_ID} .aim-mb-header { background: #14d2dc; color: #000; padding: 6px 12px; cursor: move; display: flex; align-items: center; gap: 10px; user-select: none; border-radius: 6px 6px 0 0; flex-shrink: 0; }
                #${PANEL_ID} .aim-mb-header-title { font-weight: 700; font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                #${PANEL_ID} .aim-mb-header-btn { background: rgba(0,0,0,0.15); border: none; color: #000; padding: 2px 8px; font-size: 11px; border-radius: 3px; cursor: pointer; font-weight: 600; }
                #${PANEL_ID} .aim-mb-header-btn:hover { background: rgba(0,0,0,0.3); }
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
                #${PANEL_ID} .aim-mb-step-nav { color: #5fff5f; font-weight: 700; }
                #${PANEL_ID} .aim-mb-step-snap { color: #ff9800; font-weight: 700; }
                #${PANEL_ID} .aim-mb-loc { cursor: pointer; color: #14d2dc; text-decoration: underline; }
                #${PANEL_ID} .aim-mb-loc:hover { color: #5ff; }
                #${PANEL_ID} .aim-mb-step-num { cursor: pointer; color: #14d2dc; text-decoration: underline; font-weight: 700; }
                #${PANEL_ID} .aim-mb-step-num:hover { color: #5ff; }
                #${PANEL_ID} .aim-mb-step-edit { cursor: pointer; font-size: 12px; opacity: 0.6; }
                #${PANEL_ID} .aim-mb-step-edit:hover { opacity: 1; }
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
        const span = panelEl.querySelector('[data-site]');
        if (!span) return;
        const name = getCurrentSiteName();
        const sid = getCurrentSiteID();
        span.textContent = name || (sid ? `Site ${sid}` : '?');
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
        // Search — DO NOT auto-focus. v0.2 stole focus from the settings
        // popover after every keystroke, which broke that input. The user
        // can click into the field themselves.
        const search = panelEl.querySelector('.aim-mb-search');
        if (search) {
            search.addEventListener('input', (e) => {
                const cursor = e.target.selectionStart;
                panelState.search = e.target.value;
                renderTableView();
                // Restore focus + cursor IF we held focus when input fired —
                // we definitely did (input event implies focus), so just re-grab.
                const newSearch = panelEl.querySelector('.aim-mb-search');
                if (newSearch) {
                    newSearch.focus();
                    try { newSearch.setSelectionRange(cursor, cursor); } catch (er) {}
                }
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
        const visibleRows = visIds.map(id => COL_BY_ID[id]).filter(Boolean);
        const hiddenRows = COLUMNS.filter(c => !visSet.has(c.id));
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
        pop.innerHTML = `
            <div class="aim-mb-menu-head">
                <div class="aim-mb-menu-title">Battery → Flights thresholds</div>
                <button class="aim-mb-menu-close" data-close-menu title="Close">✕</button>
            </div>
            <div class="aim-mb-menu-body" style="padding:12px;">
                <div style="font-size:10px;color:#888;margin-bottom:10px;">Adjust per-flight battery percentages. Drones land around 30 % so 100 % raw usage ≈ 2 flights.</div>
                ${labels.map((lbl, i) => `
                    <div class="aim-mb-settings-row">
                        <span style="flex:1">${lbl}</span>
                        <input type="number" data-thresh="${i}" value="${t[i]}" step="10" />
                        <span>%</span>
                    </div>
                `).join('')}
                <div class="aim-mb-settings-row" style="margin-top:10px;">
                    <button class="aim-mb-tbtn" data-thresh-reset style="flex:1">Reset to defaults</button>
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
            out = out.filter(r => (r.name || '').toLowerCase().includes(q)
                || (r.description || '').toLowerCase().includes(q));
        }
        const col = COL_BY_ID[panelState.sortKey];
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
    function renderDetailView(missionId) {
        const sid = getCurrentSiteID();
        const rows = buildAllRows(sid);
        const row = rows.find(r => r.id === missionId);
        if (!row) { renderTableView(); return; }
        panelState.drillId = missionId;
        if (!panelState.detailFilter) panelState.detailFilter = new Set();

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
                        <button class="aim-mb-tbtn" data-detail-export="sheets" title="Copy visible rows → Sheets">Copy → Sheets</button>
                        <button class="aim-mb-tbtn" data-detail-export="kml" title="Export GPS steps (navigate/snapshot) as KML with 3D altitude pins">Export KML</button>
                    </div>
                    <div style="overflow:auto;max-height:400px;">
                        <table style="margin:0" id="aim-mb-detail-table">
                            <thead style="position:sticky;top:0;z-index:2;background:#1a1a1a;">
                                <tr><th>Step</th><th>Type</th><th>Value</th><th>Location</th><th style="width:32px;"></th></tr>
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
        wireDetailEvents(missionId, row, filteredSteps, allSteps);
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
        // Step-type filter chips — multi-select toggle. "__all" clears filters.
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
        // Step number click → center map on GPS coords
        panelEl.querySelectorAll('.aim-mb-step-num').forEach(el => {
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
        // Altitude click-to-copy: raw whole number only (no comma, no ft, no ALT)
        panelEl.querySelectorAll('[data-alt-raw]').forEach(el => {
            el.onclick = () => {
                copyToClipboard(el.dataset.altRaw);
                showToast(`Copied: ${el.dataset.altRaw}`, '#5fff5f');
            };
        });
        // Location cells — left-click opens Google Maps, right-click copies coords
        panelEl.querySelectorAll('.aim-mb-loc').forEach(el => {
            el.onclick = (e) => {
                e.preventDefault();
                const lat = el.dataset.lat;
                const lng = el.dataset.lng;
                if (!lat || !lng) return;
                const url = `https://www.google.com/maps?q=${lat},${lng}`;
                let opened = null;
                try { opened = (window.top || window).open(url, '_blank'); }
                catch (er) { opened = null; }
                if (!opened) {
                    copyToClipboard(url);
                    showToast(`Popup blocked. Copied URL: ${url}`, '#ff9800');
                }
            };
            el.oncontextmenu = (e) => {
                e.preventDefault();
                const lat = el.dataset.lat;
                const lng = el.dataset.lng;
                if (lat && lng) {
                    const coords = `${lat}, ${lng}`;
                    copyToClipboard(coords);
                    showToast(`Copied: ${coords}`, '#5fff5f');
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
        const link = document.querySelector(`a[href*="/mission-bank/${missionId}"]`);
        if (link) link.click();
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            if (attempts > 25) { clearInterval(interval); showToast('Could not find instruction in editor', '#ff9800'); return; }
            const draggable = document.querySelector(`[data-rfd-draggable-id="${instructionId}"]`);
            if (!draggable) return;
            clearInterval(interval);
            draggable.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => forceOpenInstructionEdit(draggable), 500);
        }, 200);
    }

    // CSS :hover can't be triggered programmatically — the three-dots
    // menu is hidden until the user hovers. We force it visible via
    // inline style overrides, click it, wait for the Ant dropdown,
    // click Edit, then clean up our style hacks.
    function forceOpenInstructionEdit(draggable) {
        const optionsContainer = draggable.querySelector('.mission-instruction-item__options');
        const dots = draggable.querySelector('[data-testid="btn-instruction-menu"]');
        if (!dots) { showToast('Three-dots menu not found', '#ff9800'); return; }
        const savedStyles = [];
        [optionsContainer, dots, dots.parentElement].forEach(el => {
            if (!el) return;
            savedStyles.push({ el, prev: el.getAttribute('style') || '' });
            el.style.cssText += ';display:block!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;';
        });
        // Ant Dropdown uses React's synthetic event system. DOM events
        // don't trigger it. Walk up from the dots SVG to find the
        // element whose React props have onMouseEnter (the rc-trigger
        // wrapper), and call the handler directly.
        let triggered = false;
        let el = dots;
        for (let depth = 0; depth < 8 && el; depth++) {
            const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
            if (propsKey) {
                const props = el[propsKey];
                const handler = props.onMouseEnter || props.onMouseOver || props.onClick;
                if (handler) {
                    const fakeEvent = {
                        type: 'mouseenter', target: el, currentTarget: el,
                        preventDefault() {}, stopPropagation() {},
                        nativeEvent: new MouseEvent('mouseenter'),
                    };
                    try { handler(fakeEvent); triggered = true; } catch (e) {}
                    if (triggered) break;
                }
            }
            el = el.parentElement;
        }
        if (!triggered) {
            // Last resort: dispatch real DOM click on dots
            dots.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
        setTimeout(() => {
            const editItem = document.querySelector('[data-menu-id$="-edit"]')
                || Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(el => /^\s*Edit\s*$/.test(el.textContent));
            if (editItem) {
                editItem.click();
            } else {
                showToast('Edit dropdown did not appear — try hovering the dots manually', '#ff9800');
            }
            savedStyles.forEach(({ el, prev }) => { el.setAttribute('style', prev); });
        }, 500);
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

    function renderStepRow(s, idx, unit) {
        const type = displayStepType(s);
        const val = displayStepValue(s, unit);
        const rawType = s && s.type_name;
        let rowClass = '';
        if (rawType === 'navigate') rowClass = ' class="aim-mb-step-nav"';
        else if (rawType === 'snapshot') rowClass = ' class="aim-mb-step-snap"';
        // Step number cell — click centers the map on this step's GPS
        const hasGps = s && s.location && typeof s.location === 'object' && s.location.lat != null;
        let stepCell;
        if (hasGps) {
            const lat = Number(s.location.lat);
            const lng = Number(s.location.lng);
            stepCell = `<td><span class="aim-mb-step-num" data-center-lat="${lat}" data-center-lng="${lng}" title="Click to center map on this step">${idx}</span></td>`;
        } else {
            stepCell = `<td>${idx}</td>`;
        }
        // Altitude value: click-to-copy raw whole number (no comma, no unit)
        let valCell;
        if (s && s.value1_name === 'm' && typeof s.value1 === 'number') {
            const u = unit || getDistanceUnit();
            const rawNum = u === 'imperial' ? Math.round(s.value1 * 3.28084) : Math.round(s.value1);
            valCell = `<td><span data-alt-raw="${rawNum}" style="cursor:pointer;" title="Click to copy raw altitude">${escapeHtml(val)}</span></td>`;
        } else {
            valCell = `<td>${escapeHtml(val)}</td>`;
        }
        // Location cell — clickable link to Google Maps
        let locCell = '';
        if (hasGps) {
            const lat = Number(s.location.lat);
            const lng = Number(s.location.lng);
            locCell = `<span class="aim-mb-loc" data-lat="${lat}" data-lng="${lng}" title="Click: open in Google Maps. Right-click: copy coords.">${lat.toFixed(5)}, ${lng.toFixed(5)}</span>`;
        }
        // Edit icon — opens this instruction in Percepto's editor
        const instrId = s && s.id;
        const editIcon = instrId ? `<td style="text-align:center;"><span class="aim-mb-step-edit" data-edit-instr="${instrId}" title="Open this step in the mission editor">✏️</span></td>` : '<td></td>';
        return `<tr${rowClass}>${stepCell}<td>${escapeHtml(type)}</td>${valCell}<td style="font-size:10px;">${locCell}</td>${editIcon}</tr>`;
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
            const bucket = missionsBySite[sid];
            const full = bucket ? bucket.missions.filter(m => sel.size === 0 || sel.has(m.id)) : [];
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

    // ========================================================
    // Init
    // ========================================================
    function init() {
        console.log(`${TAG} v${SCRIPT_VERSION} init (${CONTEXT})`);
        setupControlPanel();
        registerWithControlPanel();
        // IFRAME-only — the Mission Bank UI lives in the React iframe
        if (CONTEXT === 'IFRAME') {
            // Re-inject SUM button periodically (React re-renders the toolbar)
            setInterval(runSumInjection, 2000);
            // Also try once now in case DOM is already ready
            setTimeout(runSumInjection, 1000);
            // Install the right-click mission inspector once (delegated
            // listener on document; survives React rebuilds).
            installRightClickHandler();
        }
        // Re-evaluate injection on hashchange (URL → Mission Bank)
        try {
            const top = window.top || window;
            top.addEventListener('hashchange', () => {
                hideSumButton();
                runSumInjection();
            });
        } catch (e) {}
        console.log(`${TAG} ready`);
    }

    init();
})();
