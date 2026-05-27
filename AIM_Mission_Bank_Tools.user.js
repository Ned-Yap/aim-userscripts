// ==UserScript==
// @name         AIM Mission Bank Tools
// @namespace    http://tampermonkey.net/
// @version      0.3
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

// AIM Mission Bank Tools — v0.3
// Feature: Mission Summary panel (#48 in features.csv).
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
    const SCRIPT_VERSION = '0.3';
    const TAG = '[AIM MB TOOLS]';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const CONTEXT = window === window.top ? 'TOP' : 'IFRAME';
    const SUM_BTN_ID = 'aim-mb-sum-btn';
    const PANEL_ID = 'aim-mb-panel';
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
            // Counts by type for future stats popup
            snapshots: countByType(inst, 'snapshot'),
            navigates: countByType(inst, 'navigate'),
            waits: countByType(inst, 'wait'),
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

    // Display-friendly step value. Bool-ish/0-1 types render as On/Off.
    function displayStepValue(s) {
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
        return `${v}${s.value1_name ? ' ' + s.value1_name : ''}`;
    }

    // ========================================================
    // Column schema
    // ========================================================
    // Each column: {
    //   id, label, key, kind ('text'|'num'|'time'|'distance'|'pct'|'dot'),
    //   defaultVisible, csvExclude, csvKey, csvFmt (override CSV string)
    // }
    const COLUMNS = [
        { id: 'active', label: 'Active', key: 'active', kind: 'dot', defaultVisible: true, csvExclude: true },
        { id: 'siteName', label: 'Site Name', key: 'siteName', kind: 'text', defaultVisible: true },
        { id: 'name', label: 'Mission Name', key: 'name', kind: 'text', defaultVisible: true, primary: true },
        { id: 'steps', label: 'Steps', key: 'steps', kind: 'num', defaultVisible: true },
        { id: 'flightTime', label: 'Flight Time', key: 'flightTimeS', kind: 'time', defaultVisible: true },
        { id: 'flightDistance', label: 'Flight Distance', key: 'flightDistanceM', kind: 'distance', defaultVisible: true },
        { id: 'batteryConsumption', label: 'Battery %', key: 'batteryConsumption', kind: 'pct', defaultVisible: true },
        { id: 'estFlights', label: 'Est. Flights', key: '__estFlights', kind: 'num', defaultVisible: true, derived: true },
        { id: 'totalConsumption', label: 'Total Consumption %', key: 'totalConsumption', kind: 'pct', defaultVisible: true },
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
    const COL_BY_ID = Object.fromEntries(COLUMNS.map(c => [c.id, c]));

    function getVisibleColumnIds() {
        const stored = gmGet(CACHE_KEY_VISIBLE_COLS, null);
        if (Array.isArray(stored) && stored.length > 0) {
            // Filter against current schema in case columns were renamed/removed
            return stored.filter(id => COL_BY_ID[id]);
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
    function injectSumButton(doc) {
        if (!masterEnabled) return;
        if (!isOnMissionBank()) return;
        if (doc.getElementById(SUM_BTN_ID)) {
            doc.getElementById(SUM_BTN_ID).style.display = '';
            return;
        }
        const header = doc.querySelector('.missions-list__header');
        if (header) {
            injectButtonIntoHeader(doc, header);
        } else if (doc.body) {
            injectFloatingButton(doc);
        }
    }

    function injectButtonIntoHeader(doc, header) {
        const newBtn = header.querySelector('.missions-list__new-button');
        const btn = doc.createElement('button');
        btn.id = SUM_BTN_ID;
        btn.type = 'button';
        // Reuse the className from the existing "New mission" button so
        // SUM picks up Percepto's Ant theme (size, color, hover state).
        btn.className = newBtn ? newBtn.className : 'ant-btn ant-btn-primary';
        btn.style.marginLeft = '8px';
        btn.innerHTML = '<span>SUM</span>';
        btn.title = 'Open mission summary (AIM Mission Bank Tools)';
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPanel();
        };
        if (newBtn && newBtn.parentNode) {
            newBtn.parentNode.insertBefore(btn, newBtn.nextSibling);
        } else {
            header.appendChild(btn);
        }
    }

    function injectFloatingButton(doc) {
        const btn = doc.createElement('button');
        btn.id = SUM_BTN_ID;
        btn.type = 'button';
        Object.assign(btn.style, {
            position: 'fixed', top: '70px', right: '20px', zIndex: '99996',
            background: '#1890ff', color: '#fff', border: 'none', borderRadius: '4px',
            padding: '6px 14px', fontSize: '11px', fontWeight: 'bold',
            cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            fontFamily: "'Lato','Segoe UI',sans-serif",
        });
        btn.innerHTML = 'SUM';
        btn.title = 'Open mission summary (AIM Mission Bank Tools) — fallback floating placement';
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPanel();
        };
        doc.body.appendChild(btn);
    }

    function runSumInjection() {
        if (!masterEnabled) return;
        // Inject only into THIS context's document. The script is @match'd
        // into both top and iframe, so each context handles its own DOM.
        // Recursive iframe walk (v0.2) produced duplicate buttons.
        try { injectSumButton(document); } catch (e) {}
    }

    function hideSumButton() {
        try {
            const all = document.querySelectorAll(`#${SUM_BTN_ID}`);
            all.forEach(el => el.remove());
        } catch (e) {}
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
                #${PANEL_ID} tbody tr:hover { background: #1a1a1a; }
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
                /* Floating menus — fixed positioning so they're not clipped by the panel and survive renders. */
                .aim-mb-cols-menu, .aim-mb-settings-popover { position: fixed; background: #1f2228; border: 1px solid #14d2dc; border-radius: 6px; z-index: 100001; box-shadow: 0 4px 20px rgba(0,0,0,0.7); font-family: 'Lato','Segoe UI',sans-serif; color: #e6e6e6; }
                .aim-mb-cols-menu { padding: 0; max-height: 360px; overflow: hidden; display: flex; flex-direction: column; }
                .aim-mb-settings-popover { padding: 0; min-width: 300px; }
                .aim-mb-menu-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #14d2dc; color: #000; border-radius: 5px 5px 0 0; font-weight: 700; font-size: 12px; }
                .aim-mb-menu-head .aim-mb-menu-title { flex: 1; }
                .aim-mb-menu-close { background: transparent; border: none; color: #000; font-size: 14px; cursor: pointer; font-weight: 700; padding: 0 4px; }
                .aim-mb-menu-close:hover { color: #800; }
                .aim-mb-menu-body { padding: 6px; overflow-y: auto; flex: 1; }
                .aim-mb-cols-menu label { display: block; padding: 3px 8px; font-size: 11px; cursor: pointer; white-space: nowrap; }
                .aim-mb-cols-menu label:hover { background: rgba(20,210,220,0.15); }
                .aim-mb-cols-menu input { margin-right: 6px; }
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
        const visible = new Set(getVisibleColumnIds());
        menu.innerHTML = `
            <div class="aim-mb-menu-head">
                <div class="aim-mb-menu-title">Columns</div>
                <button class="aim-mb-menu-close" data-close-menu title="Close">✕</button>
            </div>
            <div class="aim-mb-menu-body">
                ${COLUMNS.map(c => `
                    <label><input type="checkbox" data-col-toggle="${c.id}" ${visible.has(c.id) ? 'checked' : ''} /> ${escapeHtml(c.label)}</label>
                `).join('')}
                <hr style="border:none;border-top:1px solid #444;margin:6px 0;" />
                <button class="aim-mb-tbtn" data-cols-reset style="width:100%">Reset to defaults</button>
            </div>
        `;
        positionFloatingMenu(menu, anchor);
        document.body.appendChild(menu);

        menu.querySelector('[data-close-menu]').onclick = () => menu.remove();
        menu.querySelectorAll('[data-col-toggle]').forEach(cb => {
            cb.onclick = (e) => {
                e.stopPropagation();
                const id = cb.dataset.colToggle;
                const cur = new Set(getVisibleColumnIds());
                if (cb.checked) cur.add(id);
                else cur.delete(id);
                // Preserve original column order
                const next = COLUMNS.map(c => c.id).filter(id => cur.has(id));
                setVisibleColumnIds(next);
                renderTableView();
                // Menu was appended to document.body so it survives the
                // re-render — no need to re-open.
            };
        });
        menu.querySelector('[data-cols-reset]').onclick = () => {
            const next = COLUMNS.filter(c => c.defaultVisible).map(c => c.id);
            setVisibleColumnIds(next);
            renderTableView();
            // Refresh checkbox states in-place
            const visNow = new Set(next);
            menu.querySelectorAll('[data-col-toggle]').forEach(cb => {
                cb.checked = visNow.has(cb.dataset.colToggle);
            });
        };
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

        const unit = panelState.distanceUnit;
        const t = panelState.thresholds;
        const realSteps = row.realSteps;

        // Build dynamic per-type counts so we surface ALL distinct types
        // (not just snapshot / navigate / wait). Uses display name so
        // cameraSelect → "Thermal", gemMode → "GEM" in the breakdown.
        const typeCounts = {};
        realSteps.forEach(s => {
            const t = displayStepType(s);
            typeCounts[t] = (typeCounts[t] || 0) + 1;
        });
        const typeStatCards = Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => stat(k, v, String(v)))
            .join('');

        const html = `
            <div class="aim-mb-detail-header">
                <button class="aim-mb-detail-back" data-back>← Back</button>
                <div class="aim-mb-detail-title">${escapeHtml(row.name)}</div>
                <button class="aim-mb-tbtn ${unit === 'imperial' ? 'active' : ''}" data-unit-d="imperial">mi</button>
                <button class="aim-mb-tbtn ${unit === 'metric' ? 'active' : ''}" data-unit-d="metric">km</button>
                <div class="aim-mb-detail-id">ID ${row.id}${row.active ? '' : ' · <span style="color:#888">Inactive</span>'}</div>
            </div>
            <div class="aim-mb-detail-body">
                <div class="aim-mb-card">
                    <div class="aim-mb-card-title">Mission Stats</div>
                    <div class="aim-mb-stats-grid">
                        ${stat('Steps', row.steps, String(row.steps))}
                        ${stat('Flight Time', fmtTime(row.flightTimeS), fmtTime(row.flightTimeS))}
                        ${stat('Distance', fmtDistance(row.flightDistanceM, unit), fmtDistance(row.flightDistanceM, unit))}
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
                <div class="aim-mb-card">
                    <div class="aim-mb-card-title">Instructions (Step 1 = first after takeoff)</div>
                    <table style="margin:0">
                        <thead>
                            <tr><th>Step</th><th>Type</th><th>Value</th><th>Location</th></tr>
                        </thead>
                        <tbody>
                            ${realSteps.map((s, i) => renderStepRow(s, i + 1)).join('')}
                        </tbody>
                    </table>
                    ${row.description ? `<div style="margin-top:10px;color:#aaa;font-size:11px;">Description: ${escapeHtml(row.description)}</div>` : ''}
                    ${row.robotTypes ? `<div style="margin-top:4px;color:#aaa;font-size:11px;">Robot types: ${escapeHtml(row.robotTypes)}</div>` : ''}
                </div>
            </div>
        `;
        setBodyHtml(html);
        wireDetailEvents(missionId);
    }

    function wireDetailEvents(missionId) {
        panelEl.querySelector('[data-back]').onclick = () => {
            renderTableView();
        };
        // Unit toggle on detail
        panelEl.querySelectorAll('[data-unit-d]').forEach(b => {
            b.onclick = () => {
                panelState.distanceUnit = b.dataset.unitD;
                gmSet(CACHE_KEY_DISTANCE_UNIT, panelState.distanceUnit);
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
        // Location cells — left-click opens Google Maps, right-click copies coords
        panelEl.querySelectorAll('.aim-mb-loc').forEach(el => {
            el.onclick = (e) => {
                e.preventDefault();
                const lat = el.dataset.lat;
                const lng = el.dataset.lng;
                if (lat && lng) {
                    try { window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank'); }
                    catch (er) { showToast('Failed to open Google Maps', '#ff5252'); }
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
    }

    function stat(label, value, copyVal) {
        const hasCopy = copyVal != null && copyVal !== 'null' && copyVal !== 'undefined' && copyVal !== '—';
        const cls = hasCopy ? 'aim-mb-stat aim-mb-stat-clickable' : 'aim-mb-stat';
        const copyAttr = hasCopy ? `data-copy="${escapeHtml(String(copyVal))}"` : '';
        const title = hasCopy ? ' title="Click to copy"' : '';
        return `<div class="${cls}" ${copyAttr}${title}><div class="aim-mb-stat-label">${escapeHtml(label)}</div><div class="aim-mb-stat-value">${escapeHtml(String(value))}</div></div>`;
    }

    function renderStepRow(s, idx) {
        const type = displayStepType(s);
        const val = displayStepValue(s);
        const rawType = s && s.type_name;
        let rowClass = '';
        if (rawType === 'navigate') rowClass = ' class="aim-mb-step-nav"';
        else if (rawType === 'snapshot') rowClass = ' class="aim-mb-step-snap"';
        // Location cell — clickable link to Google Maps
        let locCell = '';
        if (s && s.location && typeof s.location === 'object' && s.location.lat != null) {
            const lat = Number(s.location.lat);
            const lng = Number(s.location.lng);
            locCell = `<span class="aim-mb-loc" data-lat="${lat}" data-lng="${lng}" title="Click: open in Google Maps. Right-click: copy coords.">${lat.toFixed(5)}, ${lng.toFixed(5)}</span>`;
        }
        return `<tr${rowClass}><td>${idx}</td><td>${escapeHtml(type)}</td><td>${escapeHtml(val)}</td><td style="font-size:10px;">${locCell}</td></tr>`;
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
