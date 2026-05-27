// ==UserScript==
// @name         AIM Mission Bank Tools
// @namespace    http://tampermonkey.net/
// @version      0.2
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Bank_Tools.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Bank_Tools.user.js
// @description  Mission Bank Tools — SUM button opens an all-missions Summary panel with per-mission stats, sortable columns, drill-down detail view, CSV/TSV/JSON/HTML export. First feature: Mission Summary panel.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

// AIM Mission Bank Tools — v0.2
// Feature: Mission Summary panel (#48 in features.csv).
//
// Architecture mirrors Asset Inspector's SUM panel:
//   - SUM button injected on Mission Bank toolbar (with floating fallback
//     if Percepto's DOM doesn't have the expected selector)
//   - Floating draggable panel with sortable table of all missions
//   - Click row → master-detail swap to drill-down view (back button
//     restores table at scroll position)
//   - Columns toggle ▾ menu — visibility persisted in GM storage
//   - Default sort: Flight Distance DESC (longest first — clusters
//     user's multi-missions at top per their build pattern)
//   - Settings cog → adjustable battery-to-flights thresholds
//   - Exports: CSV / TSV / JSON / Copy-to-Sheets (visible cols only,
//     excluding Active which is panel-only)
//
// Data: /available_app/?site_id=X&type=1 (cookie auth, no PAT needed).
// One fetch per site returns everything: instructions, app_data stats,
// site_name, robot_type_names, etc. Cached per-site in memory.
//
// Bracketed log tag: [AIM MB TOOLS]

(function () {
    'use strict';

    const SCRIPT_ID = 'aim-mission-bank-tools';
    const SCRIPT_VERSION = '0.2';
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
    // Helpers — URL / site ID
    // ========================================================
    function getCurrentSiteID() {
        const top = (() => { try { return window.top; } catch (e) { return window; } })();
        const hash = (top && top.location && top.location.hash) || location.hash || '';
        const m = hash.match(/#\/site\/(\d+)\//);
        return m ? m[1] : null;
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
        return `${Math.round(n)}%`;
    }

    function fmtNum(n) {
        if (n == null || isNaN(n)) return '—';
        return String(n);
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
    function injectSumButton(doc) {
        if (!masterEnabled) return;
        if (!isOnMissionBank()) return;
        if (doc.getElementById(SUM_BTN_ID)) {
            doc.getElementById(SUM_BTN_ID).style.display = '';
            return;
        }
        // Candidate selectors for the Mission Bank toolbar. We don't know
        // Percepto's exact class without DOM inspection, so try several
        // patterns mirroring Site Setup. Falls back to a floating
        // bottom-right button if none match.
        const candidates = [
            '.mission-bank-header--all-missions',
            '.mission-bank-header',
            '.mission-bank__header',
            '[class*="mission-bank"][class*="header"]',
            '.percepto-mission-bank-header',
        ];
        let header = null;
        for (const sel of candidates) {
            try {
                header = doc.querySelector(sel);
                if (header) break;
            } catch (e) {}
        }
        if (header) {
            injectButtonIntoHeader(doc, header);
        } else {
            injectFloatingButton(doc);
        }
    }

    function injectButtonIntoHeader(doc, header) {
        let container = doc.getElementById('aim-mb-automation-container');
        if (!container) {
            container = doc.createElement('div');
            container.id = 'aim-mb-automation-container';
            Object.assign(container.style, {
                width: '100%', display: 'flex', justifyContent: 'flex-start',
                padding: '4px 0 8px 16px', borderBottom: '1px solid #f0f0f0',
                marginTop: '-4px', gap: '10px',
            });
            header.after(container);
        }
        // Try to mirror an existing Ant button on the header for native styling
        const refBtn = header.querySelector('button[class*="ant-btn"]');
        const btn = doc.createElement('button');
        btn.id = SUM_BTN_ID;
        btn.type = 'button';
        btn.className = refBtn ? refBtn.className : 'ant-btn ant-btn-primary ant-btn-sm';
        Object.assign(btn.style, {
            minWidth: 'unset', padding: '0 12px', height: '24px',
            fontSize: '10px', fontWeight: 'bold',
        });
        btn.innerHTML = 'SUM';
        btn.title = 'Open mission summary (AIM Mission Bank Tools)';
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPanel();
        };
        container.appendChild(btn);
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

    function recursiveSumInject(win) {
        try {
            injectSumButton(win.document);
            const frames = win.document.querySelectorAll('iframe');
            frames.forEach(f => { if (f.contentWindow) recursiveSumInject(f.contentWindow); });
        } catch (e) {}
    }

    function runSumInjection() {
        if (!masterEnabled) return;
        recursiveSumInject(window);
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
                #${PANEL_ID} .aim-mb-header { background: #14d2dc; color: #000; padding: 6px 12px; cursor: move; display: flex; align-items: center; gap: 10px; user-select: none; border-radius: 6px 6px 0 0; }
                #${PANEL_ID} .aim-mb-header-title { font-weight: 700; font-size: 13px; flex: 1; }
                #${PANEL_ID} .aim-mb-header-btn { background: rgba(0,0,0,0.15); border: none; color: #000; padding: 2px 8px; font-size: 11px; border-radius: 3px; cursor: pointer; font-weight: 600; }
                #${PANEL_ID} .aim-mb-header-btn:hover { background: rgba(0,0,0,0.3); }
                #${PANEL_ID} .aim-mb-toolbar { background: #1a1a1a; padding: 6px 10px; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
                #${PANEL_ID} .aim-mb-search { flex: 1; min-width: 180px; background: #0f1216; border: 1px solid #444; color: #e6e6e6; padding: 4px 8px; font-size: 12px; border-radius: 3px; outline: none; }
                #${PANEL_ID} .aim-mb-search:focus { border-color: #14d2dc; }
                #${PANEL_ID} .aim-mb-tbtn { background: #2a2a2a; border: 1px solid #444; color: #e6e6e6; padding: 3px 10px; font-size: 11px; cursor: pointer; border-radius: 3px; font-weight: 600; }
                #${PANEL_ID} .aim-mb-tbtn:hover { border-color: #14d2dc; color: #14d2dc; }
                #${PANEL_ID} .aim-mb-tbtn.active { background: #14d2dc; color: #000; border-color: #14d2dc; }
                #${PANEL_ID} .aim-mb-body { flex: 1; overflow: auto; background: #0f1216; }
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
                #${PANEL_ID} .aim-mb-footer { background: #1a1a1a; padding: 6px 10px; border-top: 1px solid #2a2a2a; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
                #${PANEL_ID} .aim-mb-info { color: #aaa; font-size: 11px; flex: 1; }
                #${PANEL_ID} .aim-mb-resize { position: absolute; bottom: 0; right: 0; width: 14px; height: 14px; cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, #14d2dc 50%); border-radius: 0 0 6px 0; opacity: 0.5; }
                #${PANEL_ID} .aim-mb-resize:hover { opacity: 1; }
                #${PANEL_ID} .aim-mb-cols-menu { position: absolute; background: #1f2228; border: 1px solid #14d2dc; border-radius: 6px; padding: 6px; max-height: 320px; overflow-y: auto; z-index: 100000; box-shadow: 0 4px 16px rgba(0,0,0,0.5); }
                #${PANEL_ID} .aim-mb-cols-menu label { display: block; padding: 3px 8px; font-size: 11px; color: #e6e6e6; cursor: pointer; white-space: nowrap; }
                #${PANEL_ID} .aim-mb-cols-menu label:hover { background: rgba(20,210,220,0.15); }
                #${PANEL_ID} .aim-mb-cols-menu input { margin-right: 6px; }
                #${PANEL_ID} .aim-mb-settings-popover { position: absolute; background: #1f2228; border: 1px solid #14d2dc; border-radius: 6px; padding: 14px; z-index: 100000; box-shadow: 0 4px 20px rgba(0,0,0,0.7); min-width: 280px; }
                #${PANEL_ID} .aim-mb-settings-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; color: #e6e6e6; }
                #${PANEL_ID} .aim-mb-settings-row input[type="number"] { width: 80px; background: #0f1216; border: 1px solid #444; color: #e6e6e6; padding: 3px 6px; font-size: 11px; border-radius: 3px; outline: none; }
                #${PANEL_ID} .aim-mb-detail-header { background: #1a1a1a; padding: 10px 14px; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 12px; }
                #${PANEL_ID} .aim-mb-detail-back { background: #2a2a2a; border: 1px solid #444; color: #14d2dc; padding: 4px 12px; cursor: pointer; border-radius: 3px; font-weight: 600; font-size: 12px; }
                #${PANEL_ID} .aim-mb-detail-back:hover { background: #14d2dc; color: #000; }
                #${PANEL_ID} .aim-mb-detail-title { flex: 1; font-size: 14px; font-weight: 700; color: #fff; }
                #${PANEL_ID} .aim-mb-detail-id { color: #888; font-size: 11px; }
                #${PANEL_ID} .aim-mb-detail-body { padding: 14px; }
                #${PANEL_ID} .aim-mb-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; }
                #${PANEL_ID} .aim-mb-card-title { font-size: 10px; text-transform: uppercase; color: #14d2dc; letter-spacing: 0.1em; margin-bottom: 8px; font-weight: 700; }
                #${PANEL_ID} .aim-mb-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
                #${PANEL_ID} .aim-mb-stat { background: #0f1216; border-radius: 4px; padding: 8px 10px; }
                #${PANEL_ID} .aim-mb-stat-label { font-size: 10px; color: #888; text-transform: uppercase; }
                #${PANEL_ID} .aim-mb-stat-value { font-size: 16px; color: #fff; font-weight: 700; margin-top: 2px; }
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
            <div class="aim-mb-header-title">📋 Mission Summary — Site <span data-site></span></div>
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

    function makeDraggable(el, handle) {
        let startX, startY, startLeft, startTop, dragging = false;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            const rect = el.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            el.style.right = 'auto'; // switch from right-anchored to left-anchored
            el.style.left = `${startLeft}px`;
            el.style.top = `${startTop}px`;
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            el.style.left = `${startLeft + e.clientX - startX}px`;
            el.style.top = `${startTop + e.clientY - startY}px`;
        });
        window.addEventListener('mouseup', () => { dragging = false; });
    }

    function makeResizable(el, handle) {
        let startX, startY, startW, startH, resizing = false;
        handle.addEventListener('mousedown', (e) => {
            resizing = true;
            startX = e.clientX; startY = e.clientY;
            const rect = el.getBoundingClientRect();
            startW = rect.width; startH = rect.height;
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!resizing) return;
            el.style.width = `${Math.max(500, startW + e.clientX - startX)}px`;
            el.style.height = `${Math.max(300, startH + e.clientY - startY)}px`;
        });
        window.addEventListener('mouseup', () => { resizing = false; });
    }

    // ========================================================
    // Render states
    // ========================================================
    function setBodyHtml(html) {
        const body = panelEl && panelEl.querySelector('#aim-mb-body');
        if (body) body.innerHTML = html;
    }

    function renderLoadingState() {
        const sid = getCurrentSiteID();
        if (panelEl) panelEl.querySelector('[data-site]').textContent = sid || '?';
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
        panelEl.querySelector('[data-site]').textContent = sid;

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
            <div style="overflow:auto;flex:1;background:#0f1216;" id="aim-mb-table-wrap">
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
        // Search
        const search = panelEl.querySelector('.aim-mb-search');
        if (search) {
            search.addEventListener('input', (e) => {
                panelState.search = e.target.value;
                renderTableView();
            });
            // Keep focus + cursor position
            search.focus();
            search.setSelectionRange(panelState.search.length, panelState.search.length);
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
        if (colsBtn) colsBtn.onclick = (e) => openColumnsMenu(colsBtn);
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
        menu.innerHTML = COLUMNS.map(c => `
            <label><input type="checkbox" data-col-toggle="${c.id}" ${visible.has(c.id) ? 'checked' : ''} /> ${escapeHtml(c.label)}</label>
        `).join('') + `
            <hr style="border:none;border-top:1px solid #444;margin:4px 0;" />
            <label style="color:#14d2dc;font-weight:600"><button class="aim-mb-tbtn" data-cols-reset style="width:100%">Reset to defaults</button></label>
        `;
        const rect = anchor.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 4}px`;
        panelEl.appendChild(menu);

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
                openColumnsMenu(anchor); // re-anchor
            };
        });
        menu.querySelector('[data-cols-reset]').onclick = () => {
            const next = COLUMNS.filter(c => c.defaultVisible).map(c => c.id);
            setVisibleColumnIds(next);
            renderTableView();
            openColumnsMenu(anchor);
        };
        // Outside click closes
        setTimeout(() => {
            const onDoc = (e) => {
                if (!menu.contains(e.target) && e.target !== anchor) {
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
            <div style="font-size:12px;font-weight:700;color:#14d2dc;margin-bottom:10px;">Battery → Flights thresholds</div>
            <div style="font-size:10px;color:#888;margin-bottom:10px;">Adjust per-flight battery percentages. Drones land around 30% so 100% raw usage ≈ 2 flights.</div>
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
        `;
        const rect = anchor.getBoundingClientRect();
        pop.style.left = `${Math.max(8, rect.left - 200)}px`;
        pop.style.top = `${rect.bottom + 4}px`;
        panelEl.appendChild(pop);

        pop.querySelectorAll('[data-thresh]').forEach(inp => {
            inp.oninput = () => {
                const i = Number(inp.dataset.thresh);
                const v = Number(inp.value);
                if (!isNaN(v)) {
                    panelState.thresholds[i] = v;
                    gmSet(CACHE_KEY_FLIGHT_THRESHOLDS, panelState.thresholds);
                    renderTableView();
                    // Re-anchor since renderTableView re-creates panel innerHTML
                    // (but pop was appended to panelEl which still exists)
                }
            };
        });
        pop.querySelector('[data-thresh-reset]').onclick = () => {
            panelState.thresholds = DEFAULT_FLIGHT_THRESHOLDS.slice();
            gmSet(CACHE_KEY_FLIGHT_THRESHOLDS, panelState.thresholds);
            pop.remove();
            renderTableView();
        };
        setTimeout(() => {
            const onDoc = (e) => {
                if (!pop.contains(e.target) && e.target !== anchor) {
                    pop.remove();
                    document.removeEventListener('mousedown', onDoc, true);
                }
            };
            document.addEventListener('mousedown', onDoc, true);
        }, 0);
    }

    function closeOpenMenus() {
        if (!panelEl) return;
        panelEl.querySelectorAll('.aim-mb-cols-menu, .aim-mb-settings-popover').forEach(m => m.remove());
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

        const html = `
            <div class="aim-mb-detail-header">
                <button class="aim-mb-detail-back" data-back>← Back</button>
                <div class="aim-mb-detail-title">${escapeHtml(row.name)}</div>
                <div class="aim-mb-detail-id">ID ${row.id}${row.active ? '' : ' · <span style="color:#888">Inactive</span>'}</div>
            </div>
            <div class="aim-mb-detail-body">
                <div class="aim-mb-card">
                    <div class="aim-mb-card-title">Mission Stats</div>
                    <div class="aim-mb-stats-grid">
                        ${stat('Steps', row.steps)}
                        ${stat('Flight Time', fmtTime(row.flightTimeS))}
                        ${stat('Distance', fmtDistance(row.flightDistanceM, unit))}
                        ${stat('Battery %', fmtPct(row.batteryConsumption))}
                        ${stat('Est. Flights', estimateFlights(row.batteryConsumption, t))}
                        ${stat('Total Consumption %', fmtPct(row.totalConsumption))}
                    </div>
                </div>
                <div class="aim-mb-card">
                    <div class="aim-mb-card-title">Flight Phase Breakdown</div>
                    <div class="aim-mb-stats-grid">
                        ${stat('Takeoff', `${fmtTime(row.takeoffTimeS)} · ${fmtPct(row.takeoffConsumption)}`)}
                        ${stat('Navigate', `${fmtTime(row.navTimeS)} · ${fmtPct(row.navConsumption)}`)}
                        ${stat('Wait', `${fmtTime(row.waitTimeS)} · ${fmtPct(row.waitConsumption)}`)}
                        ${stat('Extra', `${fmtTime(row.extraTimeS)} · ${fmtPct(row.extraConsumption)}`)}
                        ${stat('Landing', `${fmtTime(row.landingTimeS)} · ${fmtPct(row.landingConsumption)}`)}
                    </div>
                </div>
                <div class="aim-mb-card">
                    <div class="aim-mb-card-title">Step Counts (excluding takeoff + return)</div>
                    <div class="aim-mb-stats-grid">
                        ${stat('Snapshots', row.snapshots)}
                        ${stat('Navigates', row.navigates)}
                        ${stat('Waits', row.waits)}
                        ${stat('Other', Math.max(0, row.steps - row.snapshots - row.navigates - row.waits))}
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
        panelEl.querySelector('[data-back]').onclick = () => {
            renderTableView();
        };
    }

    function stat(label, value) {
        return `<div class="aim-mb-stat"><div class="aim-mb-stat-label">${escapeHtml(label)}</div><div class="aim-mb-stat-value">${escapeHtml(String(value))}</div></div>`;
    }

    function renderStepRow(s, idx) {
        const type = s.type_name || '?';
        const val = s.value1 != null ? `${s.value1}${s.value1_name ? ' ' + s.value1_name : ''}` : '';
        const loc = s.location && typeof s.location === 'object' && s.location.lat != null
            ? `${Number(s.location.lat).toFixed(5)}, ${Number(s.location.lng).toFixed(5)}` : '';
        return `<tr><td>${idx}</td><td>${escapeHtml(type)}</td><td>${escapeHtml(val)}</td><td style="font-size:10px;color:#888;">${escapeHtml(loc)}</td></tr>`;
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
