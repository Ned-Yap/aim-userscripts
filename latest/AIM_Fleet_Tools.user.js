// ==UserScript==
// @name         Latest - AIM Fleet Tools
// @namespace    http://tampermonkey.net/
// @version      0.54
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Fleet_Tools.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Fleet_Tools.user.js
// @description  Fleet-wide tools on the sites-select landing page (before entering any site). v0.54 (#274): Incomplete flights + Capture % from planned-vs-actual image counts (Pilots / Pilot-days / Flights), raw state codes + mission_data_reports sample in the data check. v0.53 (#274): ⚙ Site rules is a real button. v0.52 (#274): Pilot Utilization hides all-zero / blank columns (panel + Sheets + CSV) with a 'hidden:' note and a checkbox to show them. v0.51 (#275): 🕘 remembered site selections in the Fleet Data picker — Recent (auto-noted by every run) + Saved (named), one pick re-selects the sites and filter. v0.50 (#274): Night hours unioned like air time (was summed per drone), Landing-failed column from landing_is_failed, data check shows flown rows by state. v0.49 (#274): ⚙ per-site rules (24/7 / day / night / custom window from NOAA sunrise-sunset at the site, 1:1 flag, drone count) → flyable drone-hrs + pool util % per date/hour, Locked-1:1 vs Flex air + Drones ⌀ (flex) + 1:1-overlap flags per pilot, Night hours; rules re-aggregate instantly. v0.48 (#274): Drones tab (air / idle days / longest gap / since last per drone) + Hours tab (drones airborne and pilots active by local hour) + fleet peak-airborne chip — the drone side of the utilization question. v0.47 (#274): 🔬 Data check (states / durations / landed-vs-duration verdict / same-drone overlap / attribution), flight end = duration | landed time, click a Pilot-day row for its flight-by-flight union trace. v0.46 (#274): 🧑‍✈️ Pilot Utilization — air time per pilot per local day as the UNION of flight intervals (1-to-many: overlapping drones count once), drone-hrs, util % of shift, 1/2/3/4+ drone breakdown, best/lightest day; sortable Pilots / Pilot-days / Dates / Flights tabs, Copy → Sheets / CSV. v0.41 (#270): 📊 Entities → Sheets from the site picker — every entity of every picked site as ONE table (per-type checkboxes, Exxon-style "Key: value | …" descriptions split into Desc: columns, optional coordinates / raw JSON), rich-clipboard Copy → Sheets or CSV download. v0.32 (#264): 🗺 KML exports from the site picker — ⭕ one enclosing circle per site (min enclosing circle + pad, folder per client) and 🗺 every picked site's setup in ONE KML (Site Setup Analyzer layout, 2D/3D). v0.28: 📐 cross-ref target "Base stations — straight-line range" (Tattu ≤14,000 ft / Tulip ≤18,000 ft from each site's base, per-base breakdown) = what a KML network can reach unshielded. v0.27 (#259): 📦 Fleet Data — pick any sites, browse their LIVE site setup / missions / mission log in-tool, export the selection as one ZIP (per-site JSON + CSV, combined CSVs, optional GPS tracks, date-ranged mission log). v0.26 (#259): 📊 Fleet Metrics — every site's setup (entities, FFZ/FP/NFZ/markers, acres, miles, equipment, states, pilot validation) + mission (count, steps, step mix, planned mi/h) numbers in one sortable table with column sets, fleet totals, per-site detail, Sheets/CSV export — computed from the Site Watch snapshots (sha-diffed, only changed sites re-download). v0.25 (#257): 🚩 Fleet Issues section — front door to AIM Issues' fleet panel (every site's issues in one place) with live open/pending/my-review counts + a badge on the button. v0.1 (#250 layer 1): ⚠ Overlap Sweep — checks EVERY pair of sites for geographic overlap (Site Watch snapshot bboxes prefilter candidate pairs, live /map_objects/ supplies current geometry, segment-to-segment math, threshold default 200 ft) with a per-pair conflict report + site links; per-site on/off for duplicate/OFFLINE copies. 📊 Fleet Metrics — per-site FFZ/FP/asset counts from the snapshot index. v0.2: /sites/ status surfaced everywhere (probe-confirmed payload: id/name/location/status) + optional "Production only" sweep filter. v0.3: sweep results draw ON the landing map — a pin at each conflicting pair's closest approach (red = overlap, orange = near), 🎯 per pair row flies the map there, "Show on map" toggle. Panel is built as sections so future fleet tools slot in.
// @author       Payden
// @match        *://percepto.app/*
// @match        *://qa.percepto.app/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

// AIM Fleet Tools — fleet-wide tooling that lives OUTSIDE any site, on the
// sites-select landing page (detected via .pr-sites-select-search, same
// signal AIM Defaults uses). No map, no Leaflet — pure panel + tables.
//   ⚠ Overlap Sweep (#250 layer 1): find every pair of sites whose
//     FFZs/FPs/assets come within the conflict threshold of each other.
//   🧑‍✈️ Pilot Utilization (#274): air time per pilot per day = union of
//     flight intervals (overlapping drones count once), sortable + exports.
//   📊 Entities → Sheets (#270): every entity of every picked site as one
//     table for Google Sheets / CSV, per-type checkboxes.
//   📊 Fleet Metrics (bones): per-site entity counts from the Site Watch
//     snapshot index; grouped by client when the /sites/ payload carries one.
// GitHub PAT arrives over the AIM_CONTROL_CHANNEL TOKEN_VALUE broadcast
// (the Control Panel's channel runs on the landing page — verified).
// No hotkeys. Log tag: [AIM FLEET]

(function () {
    'use strict';

    const TAG = '[AIM FLEET]';
    if (window !== window.top) return;   // landing page is top-level; nothing to do in iframes

    const SCRIPT_ID = 'aim-fleet-tools';
    const SCRIPT_VERSION = '0.54';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';

    // ------------------------------------------------------------------
    // Env model — QA and prod are separate DBs with colliding site IDs.
    // This tool operates strictly within its own origin's site set; all
    // persisted per-env data is env-keyed.
    // ------------------------------------------------------------------
    const IS_QA = location.hostname === 'qa.percepto.app' || location.hostname.endsWith('.qa.percepto.app');
    const ENV_SUFFIX = IS_QA ? '-qa' : '';
    const ENV_LABEL = IS_QA ? 'QA' : 'Prod';

    const DATA_REPO = 'Ned-Yap/aim-userscripts-data';
    const DATA_BRANCH = 'main';
    const GH_API = 'https://api.github.com';
    const NB_WATCH_DIR = IS_QA ? 'site-watch-qa' : 'site-watch';
    const NB_SNAP_RE = new RegExp(`^${NB_WATCH_DIR}/(\\d+)/latest\\.json\\.gz$`);
    const NB_CENTER_MARGIN_FT = 5280;      // extent unknown from a bare center — assume up to 1 mi
    const NB_INDEX_RECHECK_MS = 6 * 3600 * 1000;
    const NB_FETCH_CONCURRENCY = 4;
    const FT_PER_M = 3.28084;

    const KEY_CFG = 'aim-ft-cfg';                       // prefs — deliberately shared across envs
    const KEY_INDEX = 'aim-ft-index' + ENV_SUFFIX;      // snapshot bbox index (own copy — GM is per-script)
    const KEY_IGNORE = 'aim-ft-ignore' + ENV_SUFFIX;    // duplicate/OFFLINE sites turned off
    const KEY_SWEEP = 'aim-ft-sweep' + ENV_SUFFIX;      // last sweep result + timestamp
    const KEY_TOKEN = 'aim-ft-token-cache';             // last TOKEN_VALUE heard (CP broadcast)

    const NB_CLASSES = [
        { key: 'ffz', type: 16, label: 'FFZs' },
        { key: 'fp', type: 15, label: 'Flight paths' },
        { key: 'asset', type: 3, label: 'Assets' },
    ];
    const NB_TYPE_TO_CLASS = { 16: 'ffz', 15: 'fp', 3: 'asset' };

    // ------------------------------------------------------------------
    // GM persistence (guarded)
    // ------------------------------------------------------------------
    function gmGet(key, def) {
        try { if (typeof GM_getValue === 'function') return GM_getValue(key, def); }
        catch (e) { console.warn(`${TAG} gmGet ${key}:`, e); }
        return def;
    }
    function gmSet(key, val) {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, val); }
        catch (e) { console.warn(`${TAG} gmSet ${key}:`, e); }
    }
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') {
        console.warn(`${TAG} ⚠ GM_getValue/GM_setValue not available — check @grant. Persistence is BROKEN until fixed.`);
    }
    function loadJson(key, def) {
        try {
            const raw = gmGet(key, null);
            if (raw) {
                const v = JSON.parse(raw);
                if (v && typeof v === 'object') return v;
            }
        } catch (e) { console.warn(`${TAG} loadJson ${key}:`, e); }
        return def;
    }

    function defaultCfg() {
        return {
            thresholdFt: 200, marginFt: 500, classes: { ffz: true, fp: true, asset: true },
            capPerPair: 200, onlyProduction: false, showOnMap: true, drawSetups: true,
            basemap: 'default', faaChart: false, faaOpacity: 0.75,
            xrefB1: 50, xrefB2: 200,
            // v0.28: straight-line range bands for the "Base stations" target
            // (one-way distance from a site's base): Tattu / Tulip batteries.
            xrefBaseB1: 14000, xrefBaseB2: 18000,
            siteLabels: 'dark',
            // Display-only view filters (never re-run the sweep): which
            // conflict classes to SHOW, and which clients are toggled off.
            view: { ffz: true, fp: true, asset: true },
            clientsOff: {},
        };
    }
    function loadCfg() {
        const d = defaultCfg();
        const s = loadJson(KEY_CFG, null);
        if (s) {
            if (typeof s.thresholdFt === 'number') d.thresholdFt = s.thresholdFt;
            if (typeof s.marginFt === 'number') d.marginFt = s.marginFt;
            if (typeof s.capPerPair === 'number') d.capPerPair = s.capPerPair;
            if (typeof s.onlyProduction === 'boolean') d.onlyProduction = s.onlyProduction;
            if (typeof s.showOnMap === 'boolean') d.showOnMap = s.showOnMap;
            if (typeof s.drawSetups === 'boolean') d.drawSetups = s.drawSetups;
            if (typeof s.basemap === 'string') d.basemap = s.basemap;
            if (typeof s.faaChart === 'boolean') d.faaChart = s.faaChart;
            if (typeof s.faaOpacity === 'number') d.faaOpacity = s.faaOpacity;
            if (typeof s.xrefB1 === 'number') d.xrefB1 = s.xrefB1;
            if (typeof s.xrefB2 === 'number') d.xrefB2 = s.xrefB2;
            if (typeof s.xrefBaseB1 === 'number') d.xrefBaseB1 = s.xrefBaseB1;
            if (typeof s.xrefBaseB2 === 'number') d.xrefBaseB2 = s.xrefBaseB2;
            if (typeof s.siteLabels === 'string') d.siteLabels = s.siteLabels;
            if (s.view) NB_CLASSES.forEach(c => {
                if (typeof s.view[c.key] === 'boolean') d.view[c.key] = s.view[c.key];
            });
            if (s.clientsOff && typeof s.clientsOff === 'object') d.clientsOff = s.clientsOff;
            if (s.classes) NB_CLASSES.forEach(c => {
                if (typeof s.classes[c.key] === 'boolean') d.classes[c.key] = s.classes[c.key];
            });
        }
        return d;
    }
    let ftCfg = loadCfg();
    function saveCfg() { gmSet(KEY_CFG, JSON.stringify(ftCfg)); }

    let nbIndex = loadJson(KEY_INDEX, { shas: {}, bboxes: {}, builtAt: 0, checkedAt: 0 });
    if (!nbIndex.shas || !nbIndex.bboxes) nbIndex = { shas: {}, bboxes: {}, builtAt: 0, checkedAt: 0 };
    function saveIndex() { gmSet(KEY_INDEX, JSON.stringify(nbIndex)); }

    let ftIgnore = loadJson(KEY_IGNORE, {});   // { siteId: true } — duplicate/OFFLINE copies turned off
    function saveIgnore() { gmSet(KEY_IGNORE, JSON.stringify(ftIgnore)); }

    let lastSweep = loadJson(KEY_SWEEP, null);

    // ------------------------------------------------------------------
    // Token — the Control Panel broadcasts TOKEN_VALUE on its channel
    // (its channel runs on the landing page; verified). We also bank the
    // last-heard token in our own GM as a warm-start fallback.
    // ------------------------------------------------------------------
    let cachedToken = String(gmGet(KEY_TOKEN, '') || '');
    let controlChannel = null;
    function setupControlChannel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} control channel unavailable:`, e); return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'TOKEN_VALUE') {
                const t = String(msg.token || '');
                if (t && t !== cachedToken) {
                    cachedToken = t;
                    gmSet(KEY_TOKEN, t);
                    console.log(`${TAG} GitHub token received from AIM Controls`);
                    setTimeout(() => { try { kmlBoot(); } catch (e) {} }, 300);   // persistent KML layers can list now
                } else if (!t) {
                    cachedToken = '';
                    gmSet(KEY_TOKEN, '');
                }
            }
        };
        try { controlChannel.postMessage({ type: 'REQUEST_TOKEN' }); } catch (e) {}
    }

    // ------------------------------------------------------------------
    // Fetch helpers
    // ------------------------------------------------------------------
    function fetchWithTimeout(url, opts, ms) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms || 20000);
        return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
            .finally(() => clearTimeout(t));
    }

    function entityCoords(e) {
        if (!e) return null;
        if (Array.isArray(e.coords) && e.coords.length > 0) return e.coords;
        if (Array.isArray(e.points) && e.points.length > 0) return e.points;
        return null;
    }

    function extractList(parsed) {
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') {
            for (const k of ['results', 'objects', 'data', 'items', 'sites']) {
                if (Array.isArray(parsed[k])) return parsed[k];
            }
        }
        return [];
    }

    function validateBackupEntities(data) {
        let list = data;
        if (!Array.isArray(list) && data && typeof data === 'object') {
            for (const k of ['entities', 'results', 'objects', 'data', 'map_objects']) {
                if (Array.isArray(data[k])) { list = data[k]; break; }
            }
        }
        if (!Array.isArray(list) || !list.length) return { error: 'not an entity array' };
        const plausible = list.filter(e => e && typeof e === 'object'
            && typeof e.type === 'number'
            && (entityCoords(e) || (Array.isArray(e.arcs) && e.arcs.length)));
        if (!plausible.length) return { error: 'no entities with geometry' };
        return { entities: list, drawable: plausible.length };
    }

    async function nbGunzipToText(bytes) {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const ab = await new Response(ds.readable).arrayBuffer();
        return new TextDecoder('utf-8').decode(new Uint8Array(ab));
    }

    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ftYield = () => new Promise(r => setTimeout(r, 0));
    function siteSetupUrl(id) { return `${location.origin}/#/site/${id}/control-panel/site-setup`; }

    // ==================================================================
    // [#250 shared glue] — neighbor-discovery + segment-math helpers.
    // Identical copies live in AIM_Site_Diff (origin copy, v0.80) and will
    // land in the Asset Inspector validator check #13. Userscripts can't
    // import from each other — keep names + shapes identical so a fix is
    // a mechanical 3-file sweep. (Only the cfg object each copy reads for
    // enabled classes differs: ftCfg here, nbCfg in Site Diff.)
    // ==================================================================
    function projector(lat0) {
        const mLat = 111320;
        const mLng = 111320 * Math.cos(lat0 * Math.PI / 180) || 1e-6;
        return {
            toXY: (p) => ({ x: p.lng * mLng, y: p.lat * mLat }),
            toLatLng: (x, y) => [y / mLat, x / mLng],
        };
    }

    function pointInRingXY(px, py, xs, ys) {
        let inside = false;
        for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
            if (((ys[i] > py) !== (ys[j] > py))
                && (px < (xs[j] - xs[i]) * (py - ys[i]) / (ys[j] - ys[i]) + xs[i])) inside = !inside;
        }
        return inside;
    }

    function bboxFromEntities(entities) {
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        const counts = { ffz: 0, fp: 0, asset: 0 };
        const eat = (p) => {
            if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
            if (p.lat < minLat) minLat = p.lat;
            if (p.lat > maxLat) maxLat = p.lat;
            if (p.lng < minLng) minLng = p.lng;
            if (p.lng > maxLng) maxLng = p.lng;
        };
        (entities || []).forEach(e => {
            const cls = e && NB_TYPE_TO_CLASS[e.type];
            if (!cls) return;
            let had = false;
            const cs = entityCoords(e);
            if (cs) { cs.forEach(eat); had = cs.length > 0; }
            if (e.type === 15 && Array.isArray(e.arcs)) {
                e.arcs.forEach(a => { if (a) { eat(a.point_a); eat(a.point_b); had = true; } });
            }
            if (had) counts[cls]++;
        });
        if (!isFinite(minLat)) return null;
        return { minLat, minLng, maxLat, maxLng, ffz: counts.ffz, fp: counts.fp, asset: counts.asset };
    }

    function bboxGapFt(a, b) {
        const midLat = (Math.min(a.minLat, b.minLat) + Math.max(a.maxLat, b.maxLat)) / 2;
        const mLat = 111320;
        const mLng = 111320 * Math.cos(midLat * Math.PI / 180) || 1e-6;
        const gapLat = Math.max(0, Math.max(a.minLat - b.maxLat, b.minLat - a.maxLat)) * mLat;
        const gapLng = Math.max(0, Math.max(a.minLng - b.maxLng, b.minLng - a.maxLng)) * mLng;
        return Math.hypot(gapLat, gapLng) * FT_PER_M;
    }

    function nbPrepareEntity(e, proj) {
        const cls = e && NB_TYPE_TO_CLASS[e.type];
        if (!cls || !ftCfg.classes[cls]) return null;
        const segs = [];
        let ring = null;
        if (e.type === 15) {
            (Array.isArray(e.arcs) ? e.arcs : []).forEach(a => {
                if (!a || !a.point_a || !a.point_b) return;
                if (typeof a.point_a.lat !== 'number' || typeof a.point_b.lat !== 'number') return;
                const A = proj.toXY(a.point_a), B = proj.toXY(a.point_b);
                segs.push({ ax: A.x, ay: A.y, bx: B.x, by: B.y });
            });
            if (!segs.length) {
                const cs = (entityCoords(e) || []).filter(p => p && typeof p.lat === 'number');
                for (let i = 1; i < cs.length; i++) {
                    const A = proj.toXY(cs[i - 1]), B = proj.toXY(cs[i]);
                    segs.push({ ax: A.x, ay: A.y, bx: B.x, by: B.y });
                }
            }
        } else {
            const cs = (entityCoords(e) || []).filter(p => p && typeof p.lat === 'number');
            if (cs.length < 3) return null;
            const xs = [], ys = [];
            cs.forEach(p => { const q = proj.toXY(p); xs.push(q.x); ys.push(q.y); });
            ring = { xs, ys };
            for (let i = 0; i < xs.length; i++) {
                const j = (i + 1) % xs.length;
                segs.push({ ax: xs[i], ay: ys[i], bx: xs[j], by: ys[j] });
            }
        }
        if (!segs.length) return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        segs.forEach(s => {
            minX = Math.min(minX, s.ax, s.bx); maxX = Math.max(maxX, s.ax, s.bx);
            minY = Math.min(minY, s.ay, s.by); maxY = Math.max(maxY, s.ay, s.by);
        });
        return {
            cls, type: e.type, id: e.id,
            name: e.name || `${cls.toUpperCase()} ${e.id}`,
            segs, ring, minX, maxX, minY, maxY,
        };
    }

    function nbSegPtClosest(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = 0;
        if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const x = ax + t * dx, y = ay + t * dy;
        return { d: Math.hypot(px - x, py - y), x, y };
    }

    function nbOrient(ax, ay, bx, by, cx, cy) { return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); }

    function segSegClosestM(s, t) {
        const o1 = nbOrient(s.ax, s.ay, s.bx, s.by, t.ax, t.ay);
        const o2 = nbOrient(s.ax, s.ay, s.bx, s.by, t.bx, t.by);
        const o3 = nbOrient(t.ax, t.ay, t.bx, t.by, s.ax, s.ay);
        const o4 = nbOrient(t.ax, t.ay, t.bx, t.by, s.bx, s.by);
        if (((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0))) {
            const denom = (s.bx - s.ax) * (t.by - t.ay) - (s.by - s.ay) * (t.bx - t.ax);
            if (denom !== 0) {
                const u = ((t.ax - s.ax) * (t.by - t.ay) - (t.ay - s.ay) * (t.bx - t.ax)) / denom;
                return { d: 0, x: s.ax + u * (s.bx - s.ax), y: s.ay + u * (s.by - s.ay) };
            }
        }
        let best = null;
        const consider = (px, py, seg) => {
            const c = nbSegPtClosest(px, py, seg.ax, seg.ay, seg.bx, seg.by);
            if (!best || c.d < best.d) best = { d: c.d, x: (px + c.x) / 2, y: (py + c.y) / 2 };
        };
        consider(t.ax, t.ay, s);
        consider(t.bx, t.by, s);
        consider(s.ax, s.ay, t);
        consider(s.bx, s.by, t);
        return best;
    }

    function nbEntityPairClosest(a, b) {
        let best = null;
        const keep = (c) => { if (c && (!best || c.d < best.d)) best = c; };
        if (a.ring) {
            for (const s of b.segs) {
                if (pointInRingXY(s.ax, s.ay, a.ring.xs, a.ring.ys)) { keep({ d: 0, x: s.ax, y: s.ay }); return best; }
            }
        }
        if (b.ring) {
            for (const s of a.segs) {
                if (pointInRingXY(s.ax, s.ay, b.ring.xs, b.ring.ys)) { keep({ d: 0, x: s.ax, y: s.ay }); return best; }
            }
        }
        for (const sa of a.segs) {
            for (const sb of b.segs) {
                keep(segSegClosestM(sa, sb));
                if (best && best.d === 0) return best;
            }
        }
        return best;
    }

    // ------------------------------------------------------------------
    // Site Watch snapshot index (same incremental pattern as Site Diff:
    // ONE git Trees call diffs shas, only changed snapshots re-download)
    // ------------------------------------------------------------------
    async function nbGhTree() {
        const r = await fetchWithTimeout(
            `${GH_API}/repos/${DATA_REPO}/git/trees/${DATA_BRANCH}?recursive=1`,
            { headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github+json' } }, 30000);
        if (!r.ok) throw new Error(`tree HTTP ${r.status}`);
        const j = await r.json();
        if (!Array.isArray(j.tree)) throw new Error('unexpected tree shape');
        const shas = {};
        j.tree.forEach(f => {
            if (!f || f.type !== 'blob') return;
            const m = NB_SNAP_RE.exec(f.path);
            if (m) shas[m[1]] = f.sha;
        });
        return { shas, truncated: !!j.truncated };
    }

    async function nbFetchSnapshotBbox(id) {
        const r = await fetchWithTimeout(
            `${GH_API}/repos/${DATA_REPO}/contents/${NB_WATCH_DIR}/${id}/latest.json.gz?ref=${DATA_BRANCH}`,
            { headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github.raw' } }, 60000);
        if (!r.ok) throw new Error(`snapshot GET HTTP ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const parsed = JSON.parse(await nbGunzipToText(bytes));
        const v = validateBackupEntities(parsed);
        if (v.error) return { empty: true };
        return bboxFromEntities(v.entities) || { empty: true };
    }

    async function ensureNbIndex(progress, forceCheck) {
        const notes = [];
        const haveIndex = Object.keys(nbIndex.bboxes).length > 0;
        if (!cachedToken) {
            try { if (controlChannel) controlChannel.postMessage({ type: 'REQUEST_TOKEN' }); } catch (e) {}
            await new Promise(r => setTimeout(r, 800));
        }
        if (!cachedToken) {
            if (haveIndex) {
                notes.push('no GitHub token — using the cached site index (may be stale)');
                return notes;
            }
            throw new Error('GitHub token needed to build the site index — set the PAT in AIM Controls (gear), then re-run');
        }
        const fresh = (Date.now() - (nbIndex.checkedAt || 0)) < NB_INDEX_RECHECK_MS;
        if (haveIndex && fresh && !forceCheck) return notes;
        let tree;
        try { tree = await nbGhTree(); }
        catch (e) {
            if (haveIndex) {
                notes.push(`snapshot listing failed (${String(e && e.message || e)}) — using the cached index`);
                return notes;
            }
            throw e;
        }
        if (tree.truncated) notes.push('data-repo tree listing was truncated by GitHub — some sites may be missing from the index (cached ones kept)');
        if (!tree.truncated) Object.keys(nbIndex.shas).forEach(id => {   // v0.26: a truncated listing must not evict cached sites
            if (!tree.shas[id]) { delete nbIndex.shas[id]; delete nbIndex.bboxes[id]; }
        });
        const changed = Object.keys(tree.shas).filter(id => nbIndex.shas[id] !== tree.shas[id] || !nbIndex.bboxes[id]);
        const total = changed.length;
        if (total) {
            console.log(`${TAG} site index: ${total} snapshot(s) to (re)fetch of ${Object.keys(tree.shas).length}`);
            let done = 0, failed = 0, cursor = 0;
            const worker = async () => {
                while (cursor < changed.length) {
                    const id = changed[cursor++];
                    try {
                        const box = await nbFetchSnapshotBbox(id);
                        nbIndex.bboxes[id] = box;
                        nbIndex.shas[id] = tree.shas[id];
                    } catch (e) {
                        failed++;
                        console.warn(`${TAG} site index: snapshot fetch failed for site ${id}:`, e);
                    }
                    done++;
                    if (progress) progress(done, total);
                    if (done % 25 === 0) { saveIndex(); await ftYield(); }
                }
            };
            await Promise.all(Array.from({ length: Math.min(NB_FETCH_CONCURRENCY, changed.length) }, worker));
            if (failed) notes.push(`${failed} snapshot fetch(es) failed — those sites are UNCHECKED this sweep`);
            nbIndex.builtAt = Date.now();
        }
        nbIndex.checkedAt = Date.now();
        saveIndex();
        return notes;
    }

    // ------------------------------------------------------------------
    // /sites/ — names + center/client probes (raw entries kept per session)
    // ------------------------------------------------------------------
    let rawSites = null;   // { id: { name, raw } }
    let probeLogged = false;

    function siteEntryCenter(s) {
        if (!s || typeof s !== 'object') return null;
        const cands = [
            s.location, s.center, s.position, s.coordinates,
            { lat: s.lat, lng: s.lng }, { lat: s.latitude, lng: s.longitude },
        ];
        for (const c of cands) {
            if (c && typeof c === 'object') {
                const lat = Number(c.lat != null ? c.lat : c.latitude);
                const lng = Number(c.lng != null ? c.lng : (c.lon != null ? c.lon : c.longitude));
                if (isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0)) return { lat, lng };
            }
        }
        return null;
    }

    function siteEntryClient(s) {
        if (!s || typeof s !== 'object') return null;
        for (const k of ['client', 'client_name', 'company', 'company_name', 'customer', 'organization', 'account']) {
            const v = s[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
            if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) return v.name.trim();
        }
        return null;
    }

    async function fetchRawSites(force) {
        if (rawSites && !force) return rawSites;
        const r = await fetchWithTimeout('/sites/', {
            credentials: 'same-origin', headers: { 'Accept': 'application/json' },
        }, 20000);
        if (!r.ok) throw new Error(`/sites/ HTTP ${r.status}`);
        const list = extractList(await r.json());
        const map = {};
        list.forEach(s => {
            const id = String(s && (s.id != null ? s.id : s.site_id) || '');
            if (!id) return;
            // Payload shape live-probed 2026-09-09: id, name, location
            // ({lat,lng} — the center fallback field, 444/445 sites),
            // is_imperial, has_const_rid_location, status ('Production'…).
            // No client field exists — grouping stays name-based for now.
            map[id] = {
                name: String(s.name || s.site_name || s.title || `site ${id}`),
                status: String(s.status || ''),
                raw: s,
            };
        });
        if (!probeLogged && list.length) {
            probeLogged = true;
            const sample = list[0];
            if (!siteEntryCenter(sample)) console.log(`${TAG} /sites/ entry carries no recognizable center — keys:`, Object.keys(sample).join(', '));
            if (!siteEntryClient(sample)) console.log(`${TAG} /sites/ entry carries no recognizable client field — keys:`, Object.keys(sample).join(', '));
            // Learn the status vocabulary — decides whether "Production only"
            // can become the default duplicate/OFFLINE-site filter.
            const statuses = {};
            list.forEach(s => { const st = String(s.status || '(none)'); statuses[st] = (statuses[st] || 0) + 1; });
            console.log(`${TAG} site status vocabulary:`, statuses);
        }
        rawSites = map;
        return map;
    }

    function siteName(id) {
        return (rawSites && rawSites[id] && rawSites[id].name) || `site ${id}`;
    }
    function siteStatus(id) {
        return (rawSites && rawSites[id] && rawSites[id].status) || '';
    }
    function statusTag(st) {
        // Annotate anything that is NOT plain Production — that's where the
        // duplicate/OFFLINE copies should live if statuses are maintained.
        return st && st !== 'Production' ? st : '';
    }

    const entityCache = {};   // id → entities (per page-load session)
    async function fetchSiteEntities(id, force) {
        if (!force && entityCache[id]) return entityCache[id];
        const r = await fetchWithTimeout(`/map_objects/?getPoiMapObjectsAsList=true&site_id=${encodeURIComponent(id)}`, {
            credentials: 'same-origin', headers: { 'Accept': 'application/json' },
        }, 25000);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!Array.isArray(data)) throw new Error('response not an array');
        entityCache[id] = data;
        return data;
    }

    // ==================================================================
    // ⚠ Overlap Sweep
    // ==================================================================
    let sweepSeq = 0;
    let sweepRunning = false;

    function setStatus(msg) {
        const el = panelEl && panelEl.querySelector('#aim-ft-status');
        if (el) el.textContent = msg;
    }

    async function runSweep() {
        if (sweepRunning) return;
        const seq = ++sweepSeq;
        sweepRunning = true;
        renderPanel();
        const result = {
            at: null, env: ENV_LABEL,
            thresholdFt: ftCfg.thresholdFt, marginFt: ftCfg.marginFt,
            classes: Object.assign({}, ftCfg.classes),
            onlyProduction: ftCfg.onlyProduction,
            pairs: [], offSites: [], skippedStatus: [], unchecked: [], centerOnly: [], notes: [],
            siteCount: 0, candidatePairs: 0, fetchedSites: 0,
        };
        try {
            setStatus('checking site index…');
            const notes = await ensureNbIndex((done, total) => {
                if (seq === sweepSeq) setStatus(`indexing site snapshots… ${done}/${total}`);
            }, false);
            if (seq !== sweepSeq) return;
            result.notes.push(...notes);

            setStatus('fetching site list…');
            const sites = await fetchRawSites(true);
            if (seq !== sweepSeq) return;
            const allIds = Object.keys(sites);
            result.siteCount = allIds.length;

            // Build the bbox roster: snapshot bbox preferred; center + 1 mi
            // margin fallback; neither → UNCHECKED (reported, never silent).
            // Turned-off sites (duplicate/OFFLINE copies) sit out entirely.
            const roster = [];
            allIds.forEach(id => {
                if (ftIgnore[id]) { result.offSites.push({ id, name: siteName(id) }); return; }
                const st = siteStatus(id);
                if (ftCfg.onlyProduction && st && st !== 'Production') {
                    result.skippedStatus.push({ id, name: siteName(id), status: st });
                    return;
                }
                const b = nbIndex.bboxes[id];
                if (b && !b.empty) { roster.push({ id, box: b, src: 'snapshot' }); return; }
                if (b && b.empty) return;   // no flight geometry — nothing to overlap
                const c = siteEntryCenter(sites[id].raw);
                if (c) {
                    roster.push({ id, box: { minLat: c.lat, maxLat: c.lat, minLng: c.lng, maxLng: c.lng }, src: 'center' });
                    result.centerOnly.push({ id, name: siteName(id) });
                } else {
                    result.unchecked.push({ id, name: siteName(id) });
                }
            });

            // Candidate pairs by bbox gap. Center-only entries get the extra
            // 1 mi margin (their true extent is unknown).
            setStatus(`prefiltering ${roster.length} sites (${(roster.length * (roster.length - 1) / 2).toLocaleString()} pairs)…`);
            await ftYield();
            const candFt = ftCfg.thresholdFt + ftCfg.marginFt;
            const candPairs = [];
            for (let i = 0; i < roster.length; i++) {
                for (let j = i + 1; j < roster.length; j++) {
                    const a = roster[i], b = roster[j];
                    let lim = candFt;
                    if (a.src === 'center') lim += NB_CENTER_MARGIN_FT;
                    if (b.src === 'center') lim += NB_CENTER_MARGIN_FT;
                    if (bboxGapFt(a.box, b.box) <= lim) candPairs.push([a, b]);
                }
                if (i % 40 === 0) { await ftYield(); if (seq !== sweepSeq) return; }
            }
            result.candidatePairs = candPairs.length;

            // Live-fetch every site involved in ≥1 candidate pair (once each)
            const involved = [...new Set(candPairs.flatMap(p => [p[0].id, p[1].id]))];
            const entsById = {};
            for (let i = 0; i < involved.length; i++) {
                if (seq !== sweepSeq) return;
                const id = involved[i];
                setStatus(`fetching site ${id} (${i + 1}/${involved.length})…`);
                // force — every explicit run works on CURRENT geometry, so a
                // re-run after fixing a site never reports the old conflict
                try { entsById[id] = await fetchSiteEntities(id, true); }
                catch (e) {
                    console.warn(`${TAG} live fetch failed for site ${id}:`, e);
                    result.notes.push(`site ${siteName(id)} (#${id}) live fetch failed — its pairs are NOT checked this sweep`);
                }
            }
            result.fetchedSites = involved.filter(id => entsById[id]).length;

            // Pair math — shared glue, cooperative yields, capped detail per
            // pair (a duplicate-copy pair would otherwise record thousands).
            const thrM = ftCfg.thresholdFt / FT_PER_M;
            const thrPad = thrM + 1;
            let ops = 0;
            for (let pi = 0; pi < candPairs.length; pi++) {
                if (seq !== sweepSeq) return;
                const [A, B] = candPairs[pi];
                if (!entsById[A.id] || !entsById[B.id]) continue;
                setStatus(`checking pair ${pi + 1}/${candPairs.length} — ${siteName(A.id)} ↔ ${siteName(B.id)}…`);
                const midLat = ((A.box.minLat + A.box.maxLat) + (B.box.minLat + B.box.maxLat)) / 4;
                const proj = projector(midLat);
                const prep = (ents) => {
                    const out = [];
                    ents.forEach(e => { const p = nbPrepareEntity(e, proj); if (p) out.push(p); });
                    return out;
                };
                const pa = prep(entsById[A.id]);
                const pb = prep(entsById[B.id]);
                const conflicts = [];
                let total = 0, minFt = null, capped = false;
                outer:
                for (const ea of pa) {
                    for (const eb of pb) {
                        if (ea.minX > eb.maxX + thrPad || ea.maxX < eb.minX - thrPad
                            || ea.minY > eb.maxY + thrPad || ea.maxY < eb.minY - thrPad) continue;
                        ops += ea.segs.length * eb.segs.length;
                        const c = nbEntityPairClosest(ea, eb);
                        if (ops >= 4000) { ops = 0; await ftYield(); if (seq !== sweepSeq) return; }
                        if (!c) continue;
                        const ft = c.d * FT_PER_M;
                        if (minFt === null || ft < minFt) minFt = ft;
                        // Round-then-compare (engraved): flag on the displayed integer
                        if (Math.round(ft) >= ftCfg.thresholdFt) continue;
                        total++;
                        if (conflicts.length < ftCfg.capPerPair) {
                            const ll = proj.toLatLng(c.x, c.y);
                            conflicts.push({
                                aName: ea.name, aCls: ea.cls, bName: eb.name, bCls: eb.cls,
                                ft: Math.round(ft), overlap: c.d === 0,
                                lat: ll[0], lng: ll[1],
                            });
                        } else if (total >= ftCfg.capPerPair * 5) {
                            // A duplicate-copy pair — everything overlaps.
                            // Stop grinding; the count is already the story.
                            capped = true;
                            break outer;
                        }
                    }
                }
                if (total > 0) {
                    conflicts.sort((x, y) => x.ft - y.ft);
                    result.pairs.push({
                        aId: A.id, aName: siteName(A.id), aSrc: A.src, aStatus: siteStatus(A.id),
                        bId: B.id, bName: siteName(B.id), bSrc: B.src, bStatus: siteStatus(B.id),
                        count: total, capped, minFt: minFt === null ? null : Math.round(minFt),
                        conflicts,
                    });
                }
            }
            result.pairs.sort((a, b) => (a.minFt ?? Infinity) - (b.minFt ?? Infinity) || b.count - a.count);
            result.at = Date.now();
            lastSweep = result;
            try { gmSet(KEY_SWEEP, JSON.stringify(result)); }
            catch (e) { console.warn(`${TAG} could not persist sweep result (session-only):`, e); }
            console.log(`${TAG} sweep done: ${result.siteCount} sites → ${result.candidatePairs} candidate pair(s) → ${result.pairs.length} conflicting pair(s); ${result.offSites.length} off, ${result.unchecked.length} unchecked`);
        } catch (e) {
            console.warn(`${TAG} sweep failed:`, e);
            result.error = String(e && e.message || e);
            result.at = Date.now();
            lastSweep = result;
        } finally {
            if (seq === sweepSeq) {
                sweepRunning = false;
                renderPanel();
                drawSweepPins();
            }
        }
    }

    function abortSweep() {
        if (!sweepRunning) return;
        sweepSeq++;
        sweepRunning = false;
        console.log(`${TAG} sweep aborted`);
        renderPanel();
        setStatus('sweep aborted');
    }

    // Client is derived from the site-name prefix ("Koch Fertilizer - Enid"
    // → "Koch Fertilizer") — /sites/ carries no client field (probe 2026-09-09),
    // so the naming convention is the only grouping signal that exists.
    function clientOf(name) {
        const s = String(name || '');
        const i = s.indexOf(' - ');
        return (i > 0 ? s.slice(0, i) : s).trim() || '(unnamed)';
    }

    // View filters are DISPLAY-ONLY: they slice the finished sweep result
    // for rendering (rows + map pins). The math and the 📋 report always
    // carry everything.
    function conflictInView(c) {
        return !!(ftCfg.view[c.aCls] && ftCfg.view[c.bCls]);
    }
    function visibleConflicts(p) {
        return (p.conflicts || []).filter(conflictInView);
    }
    // Memoized view (v0.15 perf): filtering 677 pairs × their conflict
    // lists is too expensive to re-run on every 2s poll / render — compute
    // once per (sweep, filters) state, invalidated by the stamp.
    let viewCache = { stamp: null, pairs: [], list: [] };
    function viewStamp() {
        return `${(lastSweep && lastSweep.at) || 0}`
            + `|${NB_CLASSES.map(c => +ftCfg.view[c.key]).join('')}`
            + `|${Object.keys(ftCfg.clientsOff).sort().join(',')}`
            + `|${Object.keys(ftIgnore).sort().join(',')}`;
    }
    function visibleView() {
        const stamp = viewStamp();
        if (viewCache.stamp === stamp) return viewCache;
        const pairs = [];
        const list = [];   // [{p, vc}] sorted by filtered closest distance
        if (lastSweep && lastSweep.pairs) {
            lastSweep.pairs.forEach(p => {
                if (ftIgnore[p.aId] || ftIgnore[p.bId]) return;
                // Hidden only when BOTH sides' clients are off — one enabled
                // client still shows its cross-client conflicts
                if (ftCfg.clientsOff[clientOf(p.aName)] && ftCfg.clientsOff[clientOf(p.bName)]) return;
                const vc = visibleConflicts(p);
                if (!vc.length) return;
                pairs.push(p);
                list.push({ p, vc });
            });
            list.sort((a, b) => a.vc[0].ft - b.vc[0].ft || b.vc.length - a.vc.length);
        }
        viewCache = { stamp, pairs, list };
        return viewCache;
    }
    function visiblePairs() { return visibleView().pairs; }

    function buildSweepReport() {
        const lines = [];
        lines.push(`AIM Fleet Tools — cross-site overlap sweep [${ENV_LABEL}]`);
        if (!lastSweep) { lines.push('(no sweep run yet)'); return lines.join('\n'); }
        const cls = NB_CLASSES.filter(c => lastSweep.classes && lastSweep.classes[c.key]).map(c => c.label).join(', ');
        lines.push(`Ran ${lastSweep.at ? new Date(lastSweep.at).toLocaleString() : '—'} · threshold ${lastSweep.thresholdFt} ft (+${lastSweep.marginFt} ft prefilter margin) · classes: ${cls}${lastSweep.onlyProduction ? ' · Production-status sites only' : ''}`);
        lines.push(`${lastSweep.siteCount} sites → ${lastSweep.candidatePairs} candidate pair(s) → ${lastSweep.pairs.length} conflicting pair(s)`);
        if (lastSweep.error) lines.push(`SWEEP FAILED: ${lastSweep.error}`);
        // The report deliberately IGNORES the panel's view filters (classes/
        // clients) — it is the full record; only ⊘ turned-off sites are held
        // out, and those are listed below.
        const vis = lastSweep.pairs.filter(p => !ftIgnore[p.aId] && !ftIgnore[p.bId]);
        const hidden = lastSweep.pairs.length - vis.length;
        lines.push('');
        lines.push(`Conflicting site pairs (${vis.length}${hidden ? ` — ${hidden} more held out by turned-off sites` : ''}):`);
        vis.forEach((p, i) => {
            lines.push(`${i + 1}. ${p.aName} (#${p.aId}) ↔ ${p.bName} (#${p.bId}) — ${p.count}${p.capped ? '+' : ''} conflict(s), closest ${p.minFt === null ? '—' : (p.minFt === 0 ? 'OVERLAP' : `${p.minFt} ft`)}`);
            lines.push(`   ${siteSetupUrl(p.aId)}  ·  ${siteSetupUrl(p.bId)}`);
            p.conflicts.slice(0, 20).forEach(c => {
                lines.push(`   - ${c.aCls.toUpperCase()} "${c.aName}" ↔ ${c.bCls.toUpperCase()} "${c.bName}" — ${c.overlap ? 'OVERLAP' : `${c.ft} ft`} @ ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`);
            });
            if (p.conflicts.length > 20) lines.push(`   …and ${p.count - 20}${p.capped ? '+' : ''} more`);
        });
        if (lastSweep.offSites.length) {
            lines.push('');
            lines.push(`TURNED OFF — excluded from the sweep (${lastSweep.offSites.length}):`);
            lastSweep.offSites.forEach(s => lines.push(`  • ${s.name} (#${s.id})`));
        }
        if (lastSweep.skippedStatus && lastSweep.skippedStatus.length) {
            lines.push('');
            lines.push(`SKIPPED by "Production only" — /sites/ status ≠ Production (${lastSweep.skippedStatus.length}):`);
            lastSweep.skippedStatus.forEach(s => lines.push(`  • ${s.name} (#${s.id}) — ${s.status}`));
        }
        if (lastSweep.centerOnly && lastSweep.centerOnly.length) {
            lines.push('');
            lines.push(`CENTER-ONLY prefilter — no Site Watch snapshot, extent unknown (${lastSweep.centerOnly.length}):`);
            lastSweep.centerOnly.forEach(s => lines.push(`  • ${s.name} (#${s.id})`));
        }
        if (lastSweep.unchecked.length) {
            lines.push('');
            lines.push(`NOT CHECKED — no snapshot and no usable /sites/ center (${lastSweep.unchecked.length}):`);
            lastSweep.unchecked.forEach(s => lines.push(`  • ${s.name} (#${s.id})`));
        }
        (lastSweep.notes || []).forEach(n => lines.push(`Note: ${n}`));
        return lines.join('\n');
    }

    // ==================================================================
    // Landing-map integration — the sites-select page has its own Leaflet
    // world map (#pr-sites-select-map, top frame; live-probed 2026-09-09).
    // Sweep results draw on it as conflict pins: red = OVERLAP pair,
    // orange = near-miss pair; 🎯 on a pair row flies the map there.
    // ==================================================================
    // NOTE (v0.9): there is deliberately NO getL()/Leaflet-layer drawing
    // here — the landing map is a bundled Leaflet copy, and adding layers
    // built from the global L wedged it (frozen pan, no tiles). All drawing
    // goes through the raw SVG overlay below, public map API only.

    function looksLikeLeafletMap(v) {
        // Full method set required — do NOT relax (partial matches latch
        // onto Leaflet helpers that lack methods we need).
        return v && typeof v === 'object'
            && typeof v.latLngToLayerPoint === 'function'
            && typeof v.latLngToContainerPoint === 'function'
            && typeof v.layerPointToLatLng === 'function'
            && typeof v.distance === 'function'
            && typeof v.getContainer === 'function';
    }

    let landingMapRef = null;
    let mapFoundLogged = false;
    let lastDeepSearchAt = 0;

    let mapFoundVia = null;
    function stampFoundMap(map, via) {
        landingMapRef = map;
        mapFoundVia = via;
        try { const c = map.getContainer(); if (c && !c.__aim_map__) c.__aim_map__ = map; } catch (e) {}
        if (!mapFoundLogged) {
            mapFoundLogged = true;
            let inst = '';
            try {
                const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
                if (w.L && w.L.Map) inst = map instanceof w.L.Map ? ' (instance of global L.Map ✓)' : ' (⚠ NOT an instance of global L.Map — bundled Leaflet copy, drawing may misbehave)';
            } catch (e) {}
            console.log(`${TAG} landing map found via ${via}${inst}`);
        }
        return map;
    }

    // The landing page is the legacy Angular shell (pr-sites-select) —
    // v0.5's container-property walk found nothing there because Leaflet
    // never stores the map on its container; in the site iframes our other
    // scripts stamp it via the L.Map prototype hook, but nothing does that
    // here. The proven Data View pattern applies instead: the map lives on
    // an Angular scope ($rootScope.current_map on data_view) — reach it
    // through angular.element(...).injector() (works even with debug info
    // off, unlike .scope()).
    let lastWalkInspected = 0;
    function ngWalkForMap(root) {
        // v0.7: the v0.6 walk skipped EVERY $-prefixed key — but Angular
        // components (pr-sites-select is one) publish their controller as
        // $ctrl, and controller-as maps live ONE LEVEL DOWN ($ctrl.map).
        // Now: skip only $$-internals + scope plumbing, and peek one level
        // into plain objects (controllers) on each scope.
        const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const SKIP = { $parent: 1, $root: 1, $id: 1 };
        const queue = [root];
        const seen = new Set();
        let inspected = 0;
        while (queue.length && inspected < 2500) {
            const s = queue.shift();
            if (!s || seen.has(s.$id)) continue;
            seen.add(s.$id);
            inspected++;
            for (const k in s) {
                if (!Object.prototype.hasOwnProperty.call(s, k)) continue;
                if (k.startsWith('$$') || SKIP[k]) continue;
                try {
                    const v = s[k];
                    if (looksLikeLeafletMap(v)) { lastWalkInspected = inspected; return { map: v, key: k }; }
                    if (v && typeof v === 'object' && !Array.isArray(v) && !v.nodeType && v !== w) {
                        for (const k2 of Object.keys(v)) {
                            try {
                                if (looksLikeLeafletMap(v[k2])) { lastWalkInspected = inspected; return { map: v[k2], key: `${k}.${k2}` }; }
                            } catch (e2) {}
                        }
                    }
                } catch (e) {}
            }
            if (s.$$childHead) {
                let c = s.$$childHead;
                while (c) { queue.push(c); c = c.$$nextSibling; }
            }
        }
        lastWalkInspected = inspected;
        return null;
    }

    // v0.8: the landing map container carries __reactFiber$ props (live
    // probe 2026-09-09) — the sites-select map is REACT-rendered inside the
    // Angular shell (only 7 Angular scopes exist; the shell is chrome).
    // So the map lives in React fiber state, reachable by the proven
    // fiber-walk technique: climb from the container's fiber to its root,
    // then BFS child/sibling checking stateNode / memoizedProps /
    // memoizedState (+ the hooks chain, one level into each object —
    // catches react-leaflet v2 stateNode.leafletElement, v3+ context
    // {map}, and useRef {current: map} alike).
    let lastFiberInspected = 0;
    function reactFiberWalkForMap(container) {
        let startFiber = null;
        for (const k in container) {
            if (k.startsWith('__reactFiber$')) { startFiber = container[k]; break; }
        }
        if (!startFiber) return null;
        const checkObj = (o) => {
            if (!o || typeof o !== 'object') return null;
            if (looksLikeLeafletMap(o)) return o;
            if (o.nodeType) return null;   // DOM nodes: direct check only
            try {
                const keys = Object.keys(o);
                if (keys.length <= 60) {
                    for (const k of keys) {
                        try { const v = o[k]; if (looksLikeLeafletMap(v)) return v; } catch (e) {}
                    }
                }
            } catch (e) {}
            return null;
        };
        let top = startFiber;
        for (let i = 0; i < 60 && top.return; i++) top = top.return;
        const queue = [top];
        const seen = new Set();
        let inspected = 0;
        while (queue.length && inspected < 4000) {
            const f = queue.shift();
            if (!f || seen.has(f)) continue;
            seen.add(f);
            inspected++;
            try {
                for (const slot of [f.stateNode, f.memoizedProps, f.memoizedState]) {
                    const hit = checkObj(slot);
                    if (hit) { lastFiberInspected = inspected; return hit; }
                }
                // hooks chain (function components): each hook's state can
                // hold the map (useState/useRef/useContext)
                let hook = f.memoizedState;
                let h = 0;
                while (hook && typeof hook === 'object' && 'memoizedState' in hook && h++ < 40) {
                    const hit = checkObj(hook.memoizedState);
                    if (hit) { lastFiberInspected = inspected; return hit; }
                    hook = hook.next;
                }
            } catch (e) {}
            if (f.child) queue.push(f.child);
            if (f.sibling) queue.push(f.sibling);
        }
        lastFiberInspected = inspected;
        return null;
    }

    function getLandingMap() {
        if (landingMapRef && landingMapRef._container && document.body.contains(landingMapRef._container)) {
            return landingMapRef;
        }
        landingMapRef = null;
        const containers = [document.getElementById('pr-sites-select-map'), ...document.querySelectorAll('.leaflet-container')];
        for (const container of containers) {
            if (!container) continue;
            const candidates = [container.__aim_map__, container._leaflet_map, container._leaflet];
            for (const c of candidates) {
                if (looksLikeLeafletMap(c)) return stampFoundMap(c, 'container property');
            }
            for (const k in container) {
                try {
                    const v = container[k];
                    if (looksLikeLeafletMap(v)) return stampFoundMap(v, `container.${k}`);
                } catch (e) {}
            }
        }
        // Heavy routes below (fiber walk + scope-tree walk + window sweep)
        // — at most once per 3s so the discovery poll stays cheap
        const now = Date.now();
        if (now - lastDeepSearchAt < 3000) return null;
        lastDeepSearchAt = now;
        // React fiber route — the landing map's actual home
        for (const container of containers) {
            if (!container) continue;
            try {
                const hit = reactFiberWalkForMap(container);
                if (hit) return stampFoundMap(hit, `react fiber walk (${lastFiberInspected} fibers)`);
            } catch (e) { console.warn(`${TAG} react fiber route threw:`, e); }
        }
        // Angular scope route
        try {
            const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const ng = w.angular;
            if (ng && typeof ng.element === 'function') {
                let root = null;
                try {
                    const inj = ng.element(w.document.body).injector();
                    if (inj && typeof inj.get === 'function') root = inj.get('$rootScope');
                } catch (e) {}
                if (!root) {
                    try {
                        const sc = ng.element(containers[0] || w.document.body).scope();
                        root = sc && sc.$root;
                    } catch (e) {}
                }
                if (root) {
                    if (looksLikeLeafletMap(root.current_map)) return stampFoundMap(root.current_map, '$rootScope.current_map');
                    const hit = ngWalkForMap(root);
                    if (hit) return stampFoundMap(hit.map, `angular scope key "${hit.key}"`);
                }
            }
        } catch (e) { console.warn(`${TAG} angular map route threw:`, e); }
        // Last route: a window global holding the map (bounded sweep)
        try {
            const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const names = Object.getOwnPropertyNames(w).slice(0, 4000);
            for (const k of names) {
                try { if (looksLikeLeafletMap(w[k])) return stampFoundMap(w[k], `window.${k}`); } catch (e) {}
            }
        } catch (e) {}
        return null;
    }

    // Belt-and-braces: with the page's L patched, an existing map stamps
    // itself onto its container on its next internal method call (pan/zoom/
    // tile work). Idempotent with the other AIM scripts' copies of this
    // hook (all guard on !container.__aim_map__).
    let leafletProtoPatched = false;
    function patchLeafletProto() {
        if (leafletProtoPatched) return true;
        try {
            const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const L = w.L;
            if (!L || !L.Map || !L.Map.prototype) return false;
            ['getPane', 'addLayer', 'invalidateSize', 'setView', 'panTo', '_animateZoom', 'fire'].forEach(method => {
                if (typeof L.Map.prototype[method] !== 'function') return;
                const orig = L.Map.prototype[method];
                L.Map.prototype[method] = function (...args) {
                    try {
                        if (this && this._container && !this._container.__aim_map__) {
                            this._container.__aim_map__ = this;
                        }
                    } catch (e) {}
                    return orig.apply(this, args);
                };
            });
            leafletProtoPatched = true;
            console.log(`${TAG} patched page L.Map prototype`);
            return true;
        } catch (e) {
            console.warn(`${TAG} L.Map patch failed:`, e);
            return false;
        }
    }

    // One-line diagnosis of every discovery path — logged when drawing
    // gives up, and callable from the console as __aimFleetMapDebug()
    function landingMapDebug() {
        const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const c = document.getElementById('pr-sites-select-map');
        const d = { container: !!c, pageL: !!w.L, pageLVersion: (w.L && w.L.version) || null, angular: !!w.angular };
        d.ngVersion = (w.angular && w.angular.version && w.angular.version.full) || null;
        try { d.injector = !!w.angular.element(w.document.body).injector(); } catch (e) { d.injector = false; }
        try {
            const root = w.angular.element(w.document.body).injector().get('$rootScope');
            d.rootCurrentMap = !!looksLikeLeafletMap(root.current_map);
            d.rootMapishKeys = Object.keys(root).filter(k => k.charAt(0) !== '$' && /map/i.test(k)).slice(0, 10);
        } catch (e) { d.rootCurrentMap = 'n/a'; }
        try {
            const mc = document.getElementById('pr-sites-select-map');
            d.reactFiber = !!(mc && Object.keys(mc).some(k => k.startsWith('__reactFiber$')));
        } catch (e) { d.reactFiber = 'n/a'; }
        lastDeepSearchAt = 0;   // debug call always gets a full search
        d.found = !!getLandingMap();
        d.foundVia = mapFoundVia;
        d.scopesWalked = lastWalkInspected;
        d.fibersWalked = lastFiberInspected;
        return d;
    }
    try {
        ((typeof unsafeWindow !== 'undefined') ? unsafeWindow : window).__aimFleetMapDebug = () => {
            const d = landingMapDebug();
            console.log(`${TAG} map debug:`, JSON.stringify(d));
            return d;
        };
    } catch (e) {}

    // ------------------------------------------------------------------
    // Raw SVG overlay (v0.9). The landing map is a BUNDLED Leaflet copy
    // (react fiber walk found it; NOT an instance of the global L.Map) —
    // v0.8 added global-L layer objects to it and WEDGED the map (frozen
    // pan, no tiles: foreign layers broke its event pipeline). So no
    // Leaflet layer objects at all: one pane + one <svg> we own, drawn
    // with only the map's PUBLIC API (createPane / latLngToLayerPoint /
    // getZoom / on) — cross-copy safe by construction. Layer points are
    // pane-local pixel coords, so an svg pinned at 0,0 with
    // overflow:visible needs no transforms: panning moves the pane for
    // free, and we re-project on zoomend/viewreset.
    // ------------------------------------------------------------------
    const OVERLAY_PANE = 'aim-ft-overlay';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    let ovSvg = null;
    let ovSetupsG = null;
    let ovKmlG = null;
    let ovXrefG = null;
    let ovPinsG = null;
    let ovMap = null;

    function ensureOverlay(map) {
        if (ovMap === map && ovSvg && ovSvg.parentElement) return true;
        try {
            if (typeof map.createPane !== 'function' || typeof map.getPane !== 'function' || typeof map.on !== 'function') return false;
            let pane = map.getPane(OVERLAY_PANE);
            if (!pane) {
                pane = map.createPane(OVERLAY_PANE);
                // Above the site-name markers (600) so pins never bury
                if (pane) { pane.style.zIndex = 635; pane.style.pointerEvents = 'none'; }
            }
            if (!pane) return false;
            ovSvg = document.createElementNS(SVG_NS, 'svg');
            ovSvg.setAttribute('width', '1');
            ovSvg.setAttribute('height', '1');
            ovSvg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;';
            ovSetupsG = document.createElementNS(SVG_NS, 'g');   // site geometry (bottom)
            ovKmlG = document.createElementNS(SVG_NS, 'g');      // KML layers
            ovXrefG = document.createElementNS(SVG_NS, 'g');     // cross-ref runs
            ovPinsG = document.createElementNS(SVG_NS, 'g');     // conflict pins (top)
            ovSvg.appendChild(ovSetupsG);
            ovSvg.appendChild(ovKmlG);
            ovSvg.appendChild(ovXrefG);
            ovSvg.appendChild(ovPinsG);
            pane.appendChild(ovSvg);
            if (ovMap !== map) {
                map.on('zoomend viewreset', onMapZoomChanged);
                map.on('moveend', onMapMoved);
                map.on('move', onMapMoving);
                ovMap = map;
                // First refresh without waiting for a user interaction —
                // and re-apply the chosen basemap/chart to the fresh map
                setTimeout(() => {
                    scheduleSetupRefresh();
                    applyBasemap();
                    updateFaaTiles();
                }, 150);
            }
            console.log(`${TAG} overlay attached to the landing map (raw SVG, no foreign Leaflet layers)`);
            return true;
        } catch (e) {
            console.warn(`${TAG} ensureOverlay failed:`, e);
            return false;
        }
    }

    // rAF-coalesced render (v0.15 perf): bursts (progressive site fetches,
    // pinch zooms) collapse into one rebuild per frame
    let renderQueued = false;
    function requestRender() {
        if (renderQueued) return;
        renderQueued = true;
        try {
            requestAnimationFrame(() => { renderQueued = false; renderOverlay(); });
        } catch (e) { renderQueued = false; renderOverlay(); }
    }

    // v0.15 perf split: pure pans move the pane via CSS — layer coords are
    // UNCHANGED, so the SVG needs no re-projection. Only zoom/viewreset
    // (which re-anchor the layer origin) rebuild the SVG.
    function onMapZoomChanged() {
        requestRender();          // layer coords changed — re-project
        scheduleSetupRefresh();
        applyBasemap();
        updateFaaTiles();
    }
    function onMapMoved() {
        scheduleSetupRefresh();   // viewport culling + fetch of newly-visible sites
        applyBasemap();           // extend/prune tile grids into the new view
        updateFaaTiles();
    }
    // During an active drag, top up the tile grids every 150ms so a long
    // pan never outruns the cover (moveend alone left gaps → default-map
    // flash in dark mode). Cheap: add/prune imgs only, no SVG work.
    let dragTileAt = 0;
    function onMapMoving() {
        const now = Date.now();
        if (now - dragTileAt < 150) return;
        dragTileAt = now;
        applyBasemap();
        updateFaaTiles();
    }

    // Projects and rebuilds the whole overlay from current data. Bounded by
    // the pin cap (300) + setup site cap (40), so a full rebuild is a few ms.
    function renderOverlay() {
        if (!onLandingPage()) return false;
        const map = getLandingMap();
        if (!map || !ensureOverlay(map)) return false;
        let zoom = 0;
        try { zoom = map.getZoom ? map.getZoom() : 0; } catch (e) {}
        const P = (lat, lng) => {
            const p = map.latLngToLayerPoint([lat, lng]);
            return `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;
        };
        try {
            // --- site setups (zoom-gated, class-filtered at render time).
            // No site-name labels: the v0.10 labels were a diagnostic for
            // the orphan-site leak; with /sites/ scoping (v0.11) Percepto's
            // own site bubbles are the naming layer. ---
            let sHtml = '';
            if (ftCfg.drawSetups && zoom >= SETUP_MIN_ZOOM) {
                // v0.15 perf: ONE merged <path> per class per site (multi-
                // subpath d) instead of one element per entity — dense sites
                // drop from thousands of SVG nodes to ≤3 per site. Same
                // class = same color; overlapping rings union via nonzero
                // fill, visually identical.
                Object.keys(setupGeomBySite).forEach(id => {
                    const dByCls = { ffz: '', fp: '', asset: '' };
                    setupGeomBySite[id].forEach(g => {
                        if (!ftCfg.view[g.cls]) return;
                        let d = '';
                        g.parts.forEach(part => {
                            part.forEach((pt, i) => { d += (i ? 'L' : 'M') + P(pt[0], pt[1]); });
                            if (g.closed) d += 'Z';
                        });
                        dByCls[g.cls] += d;
                    });
                    NB_CLASSES.forEach(c => {
                        const d = dByCls[c.key];
                        if (!d) return;
                        const st = SETUP_STYLE[c.key];
                        const closed = c.key !== 'fp';
                        sHtml += `<path d="${d}" fill="${closed ? st.color : 'none'}" fill-opacity="${closed ? st.fill : 0}"`
                            + ` stroke="${st.color}" stroke-width="${st.weight}" stroke-opacity="0.9" stroke-linejoin="round"/>`;
                    });
                });
            }
            ovSetupsG.innerHTML = sHtml;
            // --- KML layers (merged: one path for lines + one for polys
            // per layer, points as circles capped at 800/layer) ---
            let kHtml = '';
            kmlLayers.forEach(ly => {
                if (!ly.features) return;
                const st = kmlStyleFor(ly.id);
                if (!st.show) return;
                let dLine = '', dPoly = '', ptsHtml = '';
                let ptCount = 0;
                ly.features.forEach(f => {
                    if (f.type === 'point') {
                        if (ptCount++ >= 800) return;
                        const xy = map.latLngToLayerPoint(f.pts[0]);
                        ptsHtml += `<circle cx="${xy.x}" cy="${xy.y}" r="${Math.max(2.5, st.width + 1.5)}" fill="${st.color}" fill-opacity="${st.opacity}" stroke="#10141c" stroke-width="1"/>`;
                        return;
                    }
                    let d = '';
                    f.pts.forEach((pt, i) => { d += (i ? 'L' : 'M') + P(pt[0], pt[1]); });
                    if (f.type === 'poly') dPoly += d + 'Z';
                    else dLine += d;
                });
                if (dPoly) kHtml += `<path d="${dPoly}" fill="${st.fill ? st.color : 'none'}" fill-opacity="${st.fill ? 0.12 : 0}" stroke="${st.color}" stroke-width="${st.width}" stroke-opacity="${st.opacity}" stroke-linejoin="round"/>`;
                if (dLine) kHtml += `<path d="${dLine}" fill="none" stroke="${st.color}" stroke-width="${st.width}" stroke-opacity="${st.opacity}" stroke-linejoin="round" stroke-linecap="round"/>`;
                kHtml += ptsHtml;
            });
            ovKmlG.innerHTML = kHtml;
            // --- cross-ref runs (band-colored) + point marks ---
            let xHtml = '';
            const xr = xrefState && xrefState.result;
            if (xr) {
                // ONE merged path per band — thousands of runs, 3 SVG nodes
                const dBand = { 0: '', 1: '', 2: '' };
                xr.runs.forEach(run => {
                    let d = '';
                    run.pts.forEach((pt, i) => { d += (i ? 'L' : 'M') + P(pt[0], pt[1]); });
                    dBand[run.band] += d;
                });
                [0, 2, 1].forEach(b => {   // draw red first, blue on top
                    if (dBand[b]) xHtml += `<path d="${dBand[b]}" fill="none" stroke="${XREF_COLORS[b]}" stroke-width="4" stroke-opacity="0.95" stroke-linecap="round"/>`;
                });
                xr.pointMarks.forEach(pm => {
                    const xy = map.latLngToLayerPoint([pm.lat, pm.lng]);
                    xHtml += `<circle cx="${xy.x}" cy="${xy.y}" r="5" fill="${XREF_COLORS[pm.band]}" fill-opacity="0.9" stroke="#10141c" stroke-width="1"/>`;
                });
            }
            ovXrefG.innerHTML = xHtml;
            // --- conflict dots (secondary conflict locations), then pins ---
            let pHtml = '';
            dotData.forEach(dd => {
                const xy = map.latLngToLayerPoint([dd.lat, dd.lng]);
                pHtml += `<circle cx="${xy.x}" cy="${xy.y}" r="3" fill="${dd.color}" fill-opacity="0.9" stroke="#10141c" stroke-width="1"/>`;
            });
            const now = Date.now();
            pinData.forEach(p => {
                const xy = map.latLngToLayerPoint([p.lat, p.lng]);
                const hot = pinFlash.key === p.key && now < pinFlash.until;
                pHtml += `<g data-pinkey="${p.key}">`
                    + `<circle cx="${xy.x}" cy="${xy.y}" r="11" fill="${p.color}" fill-opacity="${hot ? 0.35 : 0.15}" stroke="${p.color}" stroke-width="${hot ? 6 : 2}" stroke-opacity="${hot ? 1 : 0.75}"/>`
                    + `<circle cx="${xy.x}" cy="${xy.y}" r="3.5" fill="${p.color}"/>`
                    + '</g>';
            });
            ovPinsG.innerHTML = pHtml;
            return true;
        } catch (e) {
            console.warn(`${TAG} renderOverlay failed:`, e);
            return false;
        }
    }

    let pinData = [];                        // [{key, lat, lng, color}] — one big pin per pair (closest conflict)
    let dotData = [];                        // [{lat, lng, color}] — small dot at EVERY other recorded conflict
    let pinFlash = { key: null, until: 0 };  // 🎯 highlight, applied at render time
    let pinsKey = null;                      // what the current pins represent — stops redraw loops

    function sweepPinsKey() {
        if (!lastSweep || !lastSweep.at) return 'none';
        return `${lastSweep.at}:${visiblePairs().length}:${ftCfg.showOnMap}`
            + `:${NB_CLASSES.map(c => +ftCfg.view[c.key]).join('')}`
            + `:${Object.keys(ftCfg.clientsOff).sort().join(',')}`;
    }

    let pinsGiveUpLogged = false;
    function drawSweepPins() {
        pinData = [];
        dotData = [];
        if (onLandingPage() && ftCfg.showOnMap && lastSweep && lastSweep.at) {
            // Closest pairs win the pin budget — a cap keeps a 677-pair
            // sweep from stuffing the landing map with SVG.
            const PIN_CAP = 300;
            const list = visibleView().list;   // memoized, pre-sorted, carries vc
            if (list.length > PIN_CAP) console.log(`${TAG} ${list.length} visible pairs — drawing the ${PIN_CAP} closest pins (filter to see the rest)`);
            pinData = list.slice(0, PIN_CAP).map(({ p, vc }) => ({
                key: `${p.aId}:${p.bId}`,
                lat: vc[0].lat, lng: vc[0].lng,
                color: vc[0].overlap ? '#ff3d00' : '#ffa030',
            }));
            // Small dot at every OTHER recorded conflict of the visible
            // pairs — so "no marker here" always means "not a cross-site
            // conflict", never "the pair's pin landed elsewhere"
            const DOT_CAP = 600;
            for (const { vc } of list) {
                if (dotData.length >= DOT_CAP) break;
                for (let i = 1; i < vc.length && dotData.length < DOT_CAP; i++) {
                    dotData.push({ lat: vc[i].lat, lng: vc[i].lng, color: vc[i].overlap ? '#ff3d00' : '#ffa030' });
                }
            }
        }
        const ok = renderOverlay();
        // No map yet → leave pinsKey null so the 2s landing poll retries
        pinsKey = ok ? sweepPinsKey() : null;
        if (!ok && onLandingPage() && pinData.length && !pinsGiveUpLogged) {
            pinsGiveUpLogged = true;
            console.warn(`${TAG} landing map not found yet — overlay pending (tables work). Discovery:`, JSON.stringify(landingMapDebug()), '— run __aimFleetMapDebug() if this persists');
        }
    }

    function zoomToPair(key) {
        const p = lastSweep && lastSweep.pairs.find(x => `${x.aId}:${x.bId}` === key);
        const c = p && (visibleConflicts(p)[0] || (p.conflicts && p.conflicts[0]));   // match the drawn pin
        const map = getLandingMap();
        if (!c || !map) return;
        try {
            map.setView([c.lat, c.lng], Math.max(map.getZoom ? map.getZoom() : 4, 15));
            pinFlash = { key, until: Date.now() + 1600 };
            renderOverlay();
            setTimeout(renderOverlay, 1700);   // un-flash even without map events
        } catch (e) { console.warn(`${TAG} zoom-to-pair failed:`, e); }
    }

    // ==================================================================
    // 🗺 Map section (v0.13): basemap + FAA sectional on the landing map.
    // Both built cross-copy safe — the wedge lesson from v0.8 stands:
    //   Basemap = re-point Percepto's OWN tile layer via ITS setUrl (their
    //   object, their method; no foreign layers). "Default" restores the
    //   original URL.
    //   FAA chart = raw <img> tile pane we own (same philosophy as the SVG
    //   overlay), positioned via latLngToLayerPoint. Tile URLs + z8–12
    //   bounds proven in Map Styler.
    // ==================================================================
    // bg = ground color shown where cover tiles haven't loaded yet — a
    // matching tone instead of the default map flashing through (v0.16)
    const BASEMAPS = {
        default: { label: 'Percepto default' },
        esri: { label: 'Esri World Imagery', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxNative: 19, bg: '#1c2318' },
        usgs: { label: 'USGS NAIP imagery', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', maxNative: 16, bg: '#1c2318' },
        dark: { label: 'Dark map (Esri Gray)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxNative: 16, bg: '#161616' },
        light: { label: 'Light map (Esri Gray)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxNative: 16, bg: '#d9d9d9' },
        osm: { label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNative: 19, bg: '#f2efe9' },
    };
    // Raw tile engines — a pane of absolutely-positioned <img> tiles we
    // fully own (the FAA-chart pattern, generalized). v0.13 tried setUrl on
    // Percepto's own tile layer, but it didn't take on the live map
    // (react-leaflet re-asserts its layer's URL) — so a non-default
    // basemap now draws as a COVER pane just above Percepto's tilePane;
    // "Percepto default" simply clears it. Guaranteed to work: same engine
    // as the proven FAA chart.
    function rawTileEngine(paneName, zIndex) {
        return { paneName, zIndex, tiles: {}, el: null, srcUrl: null, capWarned: false, lastOpacity: 1 };
    }
    const baseEng = rawTileEngine('aim-ft-base', 205);   // just above tilePane (200)
    const faaEng = rawTileEngine('aim-ft-faa', 210);     // chart above the basemap cover
    const RAW_TILE_CAP = 180;

    function engClear(eng) {
        Object.keys(eng.tiles).forEach(k => { try { eng.tiles[k].remove(); } catch (e) {} });
        eng.tiles = {};
        eng.needKeys = null;
    }
    function engReset(eng) { eng.tiles = {}; eng.el = null; eng.srcUrl = null; eng.needKeys = null; }

    // Drop stale-zoom tiles once every needed current-zoom tile has loaded
    function engPruneStale(eng) {
        const need = eng.needKeys;
        if (!need) return;
        for (const k of need) {
            const img = eng.tiles[k];
            if (!img || !img.__loaded) return;   // new level not complete yet — keep the old one
        }
        Object.keys(eng.tiles).forEach(k => {
            if (eng.tiles[k].__tz !== eng.curZ) { try { eng.tiles[k].remove(); } catch (e) {} delete eng.tiles[k]; }
        });
    }

    function engUpdate(eng, src, opacity) {
        if (!onLandingPage()) return;
        const map = getLandingMap();
        if (!map) return;
        if (!src) { engClear(eng); eng.srcUrl = null; return; }
        try {
            if (!eng.el || !eng.el.parentElement) {
                eng.el = map.getPane(eng.paneName) || map.createPane(eng.paneName);
                if (!eng.el) return;
                eng.el.style.zIndex = eng.zIndex;
                eng.el.style.pointerEvents = 'none';
            }
            if (eng.srcUrl !== src.url) { engClear(eng); eng.srcUrl = src.url; }
            const mz = Math.round(map.getZoom ? map.getZoom() : 0);
            if (src.min != null && mz < src.min) { engClear(eng); return; }   // chart illegible below its native range
            const z = Math.max(0, Math.min(src.max, mz));
            // src.pad prefetches beyond the viewport (the basemap cover uses
            // a big pad so pans stay covered instead of flashing the default)
            const b = map.getBounds().pad(src.pad != null ? src.pad : 0.05);
            const x0 = lng2tile(b.getWest(), z), x1 = lng2tile(b.getEast(), z);
            const y0 = lat2tile(b.getNorth(), z), y1 = lat2tile(b.getSouth(), z);
            const cap = src.cap != null ? src.cap : RAW_TILE_CAP;
            const count = (x1 - x0 + 1) * (y1 - y0 + 1);
            if (count > cap) {
                if (!eng.capWarned) { eng.capWarned = true; console.warn(`${TAG} ${eng.paneName}: ${count} tiles in view exceeds cap ${cap}`); }
                engClear(eng);
                return;
            }
            eng.lastOpacity = opacity;
            eng.curZ = z;
            const need = new Set();
            const missing = [];
            const nMax = Math.pow(2, z) - 1;
            const cx = (x0 + x1) / 2, cyv = (y0 + y1) / 2;
            for (let x = x0; x <= x1; x++) {
                for (let y = Math.max(0, y0); y <= Math.min(nMax, y1); y++) {
                    const key = `${z}/${x}/${y}`;
                    need.add(key);
                    if (!eng.tiles[key]) missing.push({ key, x, y, d: (x - cx) * (x - cx) + (y - cyv) * (y - cyv) });
                }
            }
            eng.needKeys = need;
            // v0.17: create CENTER-OUT with fetch-priority hints, so the
            // middle of the screen fills first and the prefetch margin
            // loads last (row-order creation had visible tiles queued
            // behind off-screen ones in the browser's per-host limit)
            missing.sort((a, b2) => a.d - b2.d);
            missing.forEach((m, idx) => {
                const img = document.createElement('img');
                img.__loaded = false;
                img.__tx = m.x; img.__ty = m.y; img.__tz = z;
                try { img.fetchPriority = idx < 16 ? 'high' : (idx > missing.length * 0.6 ? 'low' : 'auto'); } catch (e) {}
                img.decoding = 'async';
                img.src = src.url.replace('{z}', z).replace('{x}', m.x).replace('{y}', m.y);
                // fade in on load instead of popping over the ground
                img.style.cssText = 'position:absolute;pointer-events:none;user-select:none;opacity:0;transition:opacity .15s;';
                img.draggable = false;
                img.addEventListener('load', () => {
                    img.__loaded = true;
                    img.style.opacity = eng.lastOpacity;
                    engPruneStale(eng);   // stale-zoom tiles leave once the new level is in
                });
                img.addEventListener('error', () => {
                    // no-coverage tiles 404 — fine; counts as "done" so
                    // stale-tile pruning is never blocked by a 404
                    img.__loaded = true;
                    img.style.display = 'none';
                    engPruneStale(eng);
                });
                eng.el.appendChild(img);
                eng.tiles[m.key] = img;
            });
            // Position EVERY kept tile — including stale-zoom ones, which
            // stay (scaled by corner projection, exactly like Leaflet keeps
            // old tiles) until the new zoom level has fully loaded. This is
            // what kills the seconds of bare ground after each zoom.
            Object.keys(eng.tiles).forEach(k => {
                const img = eng.tiles[k];
                const tz = img.__tz;
                if (tz === z && !need.has(k)) {
                    // same zoom but out of the padded view → gone
                    try { img.remove(); } catch (e) {}
                    delete eng.tiles[k];
                    return;
                }
                const p1 = map.latLngToLayerPoint([tile2lat(img.__ty, tz), tile2lng(img.__tx, tz)]);
                const p2 = map.latLngToLayerPoint([tile2lat(img.__ty + 1, tz), tile2lng(img.__tx + 1, tz)]);
                img.style.left = `${p1.x}px`;
                img.style.top = `${p1.y}px`;
                img.style.width = `${p2.x - p1.x + 0.5}px`;
                img.style.height = `${p2.y - p1.y + 0.5}px`;
                if (img.__loaded) img.style.opacity = opacity;
            });
            engPruneStale(eng);
            // hard safety cap on retained DOM (rapid multi-level zooms)
            const all = Object.keys(eng.tiles);
            if (all.length > 900) {
                all.forEach(k => {
                    if (eng.tiles[k].__tz !== z) { try { eng.tiles[k].remove(); } catch (e) {} delete eng.tiles[k]; }
                });
            }
        } catch (e) { console.warn(`${TAG} raw tiles (${eng.paneName}) update failed:`, e); }
    }

    // ---- Percepto site-name labels (.pr-site-marker — recon'd via the
    // AIM Inspector) — pure CSS overrides, toggleable ----
    const LABEL_CSS = {
        // dark translucent chip, bright text, slimmed + ellipsized so long
        // well names stop being 360px white banners
        dark: '.pr-site-marker{background:rgba(14,18,26,0.55)!important;color:#6ee7ff!important;'
            + 'border:1px solid rgba(110,231,255,0.28)!important;border-radius:4px!important;'
            + 'padding:1px 7px!important;font-size:11px!important;line-height:1.35!important;font-weight:600!important;'
            + 'max-width:230px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;'
            + 'box-shadow:none!important;}',
        hidden: '.pr-site-marker{display:none!important;}',
        default: '',
    };
    let labelStyleEl = null;
    function applySiteLabels() {
        try {
            if (!labelStyleEl || !labelStyleEl.parentElement) {
                labelStyleEl = document.createElement('style');
                labelStyleEl.id = 'aim-ft-label-css';
                (document.head || document.documentElement).appendChild(labelStyleEl);
            }
            labelStyleEl.textContent = LABEL_CSS[ftCfg.siteLabels] || '';
        } catch (e) { console.warn(`${TAG} site-label CSS failed:`, e); }
    }

    function applyBasemap() {
        const bm = BASEMAPS[ftCfg.basemap];
        const cover = !!(bm && bm.url);
        // Big pad: prefetch half a viewport past every edge so normal pans
        // stay covered instead of flashing the default map underneath
        engUpdate(baseEng, cover ? { url: bm.url, max: bm.maxNative, pad: 0.5, cap: 420 } : null, 1);
        // While a cover is active, hide Percepto's own tiles and tint the
        // container to match — whatever peeks through during a fast pan is
        // a matching ground, not the bright default map. Style-only touches
        // on their panes (never layer objects), fully reversed on 'default'.
        const map = getLandingMap();
        if (map) {
            try {
                const tp = map.getPane && map.getPane('tilePane');
                if (tp) tp.style.visibility = cover ? 'hidden' : '';
                const c = map.getContainer && map.getContainer();
                if (c) c.style.background = cover ? (bm.bg || '#202020') : '';
            } catch (e) {}
        }
        return true;
    }
    function updateFaaTiles() { engUpdate(faaEng, ftCfg.faaChart ? FAA_SRC : null, ftCfg.faaOpacity); }

    // ---- FAA VFR sectional as a raw tile pane ----
    const FAA_SRC = { url: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}', min: 8, max: 12, pad: 0.2, cap: 220 };

    function lng2tile(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
    function lat2tile(lat, z) {
        const r = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
    }
    function tile2lng(x, z) { return x / Math.pow(2, z) * 360 - 180; }
    function tile2lat(y, z) {
        const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
        return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }


    // ------------------------------------------------------------------
    // Site-setup geometry on the landing map (v0.5). "See everything but
    // NOT BREAK the system" (user doctrine): zoom-gated (≥12 — below that
    // a whole site is sub-pixel), viewport-culled via the index bboxes,
    // hard-capped at the nearest SETUP_SITE_CAP sites, redrawn
    // incrementally on pan/zoom. Class Show checkboxes + client chips +
    // ⊘-off all apply. Geometry comes from the session entity cache, so
    // sites already fetched by a sweep draw instantly.
    // ------------------------------------------------------------------
    const SETUP_MIN_ZOOM = 12;
    const SETUP_SITE_CAP = 40;
    const SETUP_FETCH_CONCURRENCY = 3;
    // Class colors follow the native Percepto palette so the fleet view
    // reads instantly: FP cyan, FFZ green, assets white.
    const SETUP_STYLE = {
        ffz: { color: '#2eff7b', weight: 2, fill: 0.08 },
        fp: { color: '#00e5ff', weight: 2, fill: 0 },
        asset: { color: '#ffffff', weight: 1.5, fill: 0.06 },
    };
    let setupGeomBySite = {};   // id → [{cls, closed, parts:[[[lat,lng],…],…]}] — rendered by renderOverlay
    let setupSeq = 0;
    let setupRefreshTimer = null;

    // Entity → plain geometry records (lat/lng only, ALL classes kept —
    // the class Show filter applies at render time, so toggling a class
    // never refetches anything).
    function nbEntityToGeom(e) {
        const cls = NB_TYPE_TO_CLASS[e.type];
        if (!cls) return null;
        if (e.type === 15) {
            const parts = (Array.isArray(e.arcs) ? e.arcs : [])
                .filter(a => a && a.point_a && a.point_b
                    && typeof a.point_a.lat === 'number' && typeof a.point_b.lat === 'number')
                .map(a => [[a.point_a.lat, a.point_a.lng], [a.point_b.lat, a.point_b.lng]]);
            if (!parts.length) {
                const cs = (entityCoords(e) || []).filter(pt => pt && typeof pt.lat === 'number');
                if (cs.length > 1) parts.push(cs.map(pt => [pt.lat, pt.lng]));
            }
            return parts.length ? { cls, closed: false, parts } : null;
        }
        const cs = (entityCoords(e) || []).filter(pt => pt && typeof pt.lat === 'number');
        if (cs.length < 3) return null;
        return { cls, closed: true, parts: [cs.map(pt => [pt.lat, pt.lng])] };
    }

    function bboxIntersects(b, west, south, east, north) {
        return !(b.minLng > east || b.maxLng < west || b.minLat > north || b.maxLat < south);
    }

    function scheduleSetupRefresh() {
        if (setupRefreshTimer) clearTimeout(setupRefreshTimer);
        setupRefreshTimer = setTimeout(() => { setupRefreshTimer = null; refreshSetupLayers(); }, 400);
    }

    async function refreshSetupLayers() {
        const seq = ++setupSeq;
        if (!onLandingPage()) return;
        const map = getLandingMap();
        if (!map) return;
        if (!ftCfg.drawSetups || (map.getZoom ? map.getZoom() : 0) < SETUP_MIN_ZOOM) {
            // Keep the geometry cache (cheap) — renderOverlay's zoom gate
            // already hides it; nothing to fetch below the gate.
            renderOverlay();
            return;
        }
        // /sites/ is the ACCESS AUTHORITY, not just the name source: the
        // snapshot index can hold sites the user no longer has access to
        // (historic Site Watch runs — live-hit 2026-09-09: orphan sites 807/
        // 1227/1310 drew on the map). Fail closed: no list → nothing draws.
        if (!rawSites) {
            try { await fetchRawSites(false); } catch (e) { console.warn(`${TAG} /sites/ fetch failed — setups NOT drawn (cannot verify site access):`, e); }
            if (seq !== setupSeq) return;
        }
        if (!rawSites) return;
        let west, south, east, north, ctr;
        try {
            const b = map.getBounds().pad(0.15);
            west = b.getWest(); south = b.getSouth(); east = b.getEast(); north = b.getNorth();
            ctr = map.getCenter();
        } catch (e) { return; }
        // Sites in view, filters applied, nearest-to-center first
        const wanted = [];
        Object.keys(nbIndex.bboxes).forEach(id => {
            if (!rawSites[id]) return;   // snapshot-only orphan — not the user's site
            const box = nbIndex.bboxes[id];
            if (!box || box.empty) return;
            if (ftIgnore[id]) return;
            if (ftCfg.clientsOff[clientOf(siteName(id))]) return;
            if (!bboxIntersects(box, west, south, east, north)) return;
            const dLat = (box.minLat + box.maxLat) / 2 - ctr.lat;
            const dLng = (box.minLng + box.maxLng) / 2 - ctr.lng;
            wanted.push({ id, d: dLat * dLat + dLng * dLng });
        });
        wanted.sort((a, b) => a.d - b.d);
        if (wanted.length > SETUP_SITE_CAP) {
            console.log(`${TAG} ${wanted.length} sites in view — drawing the ${SETUP_SITE_CAP} nearest site setups (zoom in for the rest)`);
        }
        const keep = new Set(wanted.slice(0, SETUP_SITE_CAP).map(w => w.id));
        // Drop sites that left the view / got filtered out
        let changed = false;
        Object.keys(setupGeomBySite).forEach(id => {
            if (!keep.has(id)) { delete setupGeomBySite[id]; changed = true; }
        });
        if (changed) requestRender();
        // Fetch + add the missing ones, nearest first, gently concurrent —
        // each finished site renders immediately (progressive draw)
        const queue = [...keep].filter(id => !setupGeomBySite[id]);
        if (!queue.length) return;
        const worker = async () => {
            while (queue.length) {
                if (seq !== setupSeq) return;
                const id = queue.shift();
                let ents;
                try { ents = await fetchSiteEntities(id, false); }
                catch (e) {
                    console.warn(`${TAG} setup fetch failed for site ${id} — not drawn:`, e);
                    continue;
                }
                if (seq !== setupSeq) return;
                const geoms = [];
                ents.forEach(e => {
                    try {
                        const g = nbEntityToGeom(e);
                        if (g) geoms.push(g);
                    } catch (e3) { console.warn(`${TAG} setup geometry failed for entity ${e && e.id}:`, e3); }
                });
                setupGeomBySite[id] = geoms;
                requestRender();   // coalesced — a burst of finished sites renders once per frame
            }
        };
        await Promise.all(Array.from({ length: Math.min(SETUP_FETCH_CONCURRENCY, queue.length) }, worker));
    }

    // ==================================================================
    // 📎 KML layers (v0.18) — Google-Earth-style overlay layers on the
    // landing map. Session layers live in memory only; 💾 promotes one to
    // the PRIVATE data repo (fleet-kml/<name>.kml, create-only PUT) so it
    // persists for every session. Show/style prefs are per-user in GM.
    // Rendered through the raw SVG overlay (never Leaflet layer objects).
    // ==================================================================
    const KML_DIR = 'fleet-kml';
    const KEY_KML_STYLES = 'aim-ft-kml-styles';
    const KEY_KML_LIST = 'aim-ft-kml-list';
    const KML_PALETTE = ['#ffd54f', '#4fc3f7', '#ff8a65', '#aed581', '#ba68c8', '#4db6ac', '#f06292', '#90a4ae'];
    let kmlLayers = [];          // [{id, name, source:'session'|'repo', sha?, rawText?, features, vertexCount, bbox, style}]
    let kmlStyles = loadJson(KEY_KML_STYLES, {});
    let kmlBootDone = false;
    let kmlDeleteArm = null;     // {id, at} — double-click arm for repo deletes

    function saveKmlStyles() { gmSet(KEY_KML_STYLES, JSON.stringify(kmlStyles)); }
    function kmlLayerById(id) { return kmlLayers.find(l => l.id === id); }
    function kmlStyleFor(id) {
        if (!kmlStyles[id]) {
            kmlStyles[id] = {
                show: true, color: KML_PALETTE[Object.keys(kmlStyles).length % KML_PALETTE.length],
                width: 2.5, opacity: 0.9, fill: true,
            };
        }
        return kmlStyles[id];
    }

    // ---- parsing (DOMParser; CSS type selectors ignore the KML namespace) ----
    function parseKmlText(text) {
        const doc = new DOMParser().parseFromString(text, 'text/xml');
        if (doc.querySelector('parsererror')) throw new Error('not valid KML/XML (KMZ? unzip to .kml first)');
        const features = [];
        let vertexCount = 0;
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        const parseCoords = (node) => {
            const out = [];
            String(node.textContent || '').trim().split(/\s+/).forEach(tok => {
                const p = tok.split(',');
                const lng = Number(p[0]), lat = Number(p[1]);
                if (isFinite(lat) && isFinite(lng)) {
                    out.push([lat, lng]);
                    if (lat < minLat) minLat = lat;
                    if (lat > maxLat) maxLat = lat;
                    if (lng < minLng) minLng = lng;
                    if (lng > maxLng) maxLng = lng;
                }
            });
            return out;
        };
        doc.querySelectorAll('Placemark').forEach(pm => {
            let fname = '';
            try { const n = pm.querySelector(':scope > name'); fname = (n && n.textContent.trim()) || ''; } catch (e) {}
            pm.querySelectorAll('Point > coordinates').forEach(c => {
                const pts = parseCoords(c);
                if (pts.length) { features.push({ name: fname, type: 'point', pts: [pts[0]] }); vertexCount++; }
            });
            pm.querySelectorAll('LineString > coordinates').forEach(c => {
                const pts = parseCoords(c);
                if (pts.length > 1) { features.push({ name: fname, type: 'line', pts }); vertexCount += pts.length; }
            });
            pm.querySelectorAll('Polygon').forEach(pg => {
                // outer ring only (inner holes ignored — noted in the report)
                const outer = pg.querySelector('outerBoundaryIs coordinates');
                if (outer) {
                    const pts = parseCoords(outer);
                    if (pts.length > 2) { features.push({ name: fname, type: 'poly', pts }); vertexCount += pts.length; }
                }
            });
        });
        if (!features.length) throw new Error('no Point/LineString/Polygon placemarks found');
        return { features, vertexCount, bbox: { minLat, minLng, maxLat, maxLng } };
    }

    // GeoJSON (v0.19) — clients export .geojson as often as .kml.
    // Coordinates are [lng, lat]; outer rings only (holes noted in reports).
    function parseGeojsonText(text) {
        let j;
        try { j = JSON.parse(text); } catch (e) { throw new Error('not valid JSON'); }
        const features = [];
        let vertexCount = 0;
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        const conv = (coords) => coords.map(c => {
            const lat = Number(c[1]), lng = Number(c[0]);
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            return [lat, lng];
        }).filter(p => isFinite(p[0]) && isFinite(p[1]));
        const addGeom = (g, name) => {
            if (!g || !g.type) return;
            if (g.type === 'Point') {
                const p = conv([g.coordinates]);
                if (p.length) { features.push({ name, type: 'point', pts: p }); vertexCount++; }
            } else if (g.type === 'MultiPoint') {
                (g.coordinates || []).forEach(c => addGeom({ type: 'Point', coordinates: c }, name));
            } else if (g.type === 'LineString') {
                const pts = conv(g.coordinates || []);
                if (pts.length > 1) { features.push({ name, type: 'line', pts }); vertexCount += pts.length; }
            } else if (g.type === 'MultiLineString') {
                (g.coordinates || []).forEach(cs => addGeom({ type: 'LineString', coordinates: cs }, name));
            } else if (g.type === 'Polygon') {
                const pts = conv((g.coordinates || [])[0] || []);   // outer ring
                if (pts.length > 2) { features.push({ name, type: 'poly', pts }); vertexCount += pts.length; }
            } else if (g.type === 'MultiPolygon') {
                (g.coordinates || []).forEach(rings => addGeom({ type: 'Polygon', coordinates: rings }, name));
            } else if (g.type === 'GeometryCollection') {
                (g.geometries || []).forEach(gg => addGeom(gg, name));
            }
        };
        const featName = (f) => {
            const pr = f.properties || {};
            for (const k of ['name', 'Name', 'NAME', 'label', 'id', 'ID', 'LineID', 'FacilityID']) {
                if (pr[k] != null && String(pr[k]).trim()) return String(pr[k]).trim();
            }
            return '';
        };
        if (j.type === 'FeatureCollection') (j.features || []).forEach(f => f && addGeom(f.geometry, featName(f)));
        else if (j.type === 'Feature') addGeom(j.geometry, featName(j));
        else addGeom(j, '');
        if (!features.length) throw new Error('no usable GeoJSON geometries found');
        return { features, vertexCount, bbox: { minLat, minLng, maxLat, maxLng } };
    }

    // Dispatcher: JSON-looking text → GeoJSON, else KML/XML
    function parseGeoText(text) {
        const head = String(text).slice(0, 200).trim();
        return (head.startsWith('{') || head.startsWith('[')) ? parseGeojsonText(text) : parseKmlText(text);
    }

    // ---- data-repo I/O (plain fetch — api.github.com sends CORS headers) ----
    function ghHdr() { return { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github+json' }; }

    async function kmlRepoList(force) {
        if (!cachedToken) throw new Error('GitHub token needed (AIM Controls gear)');
        // no-store: api.github.com responses are browser-cached ~60s — a
        // stale directory listing made a freshly saved layer invisible
        const r = await fetchWithTimeout(`${GH_API}/repos/${DATA_REPO}/contents/${KML_DIR}?ref=${DATA_BRANCH}`, { headers: ghHdr(), cache: 'no-store' }, 25000);
        if (r.status === 404) { gmSet(KEY_KML_LIST, '[]'); return []; }   // folder not created yet
        if (!r.ok) throw new Error(`list HTTP ${r.status}`);
        const j = await r.json();
        const list = (Array.isArray(j) ? j : [])
            .filter(f => f && f.type === 'file' && /\.(kml|geojson|json)$/i.test(f.name))
            .map(f => ({ name: f.name, sha: f.sha }));
        gmSet(KEY_KML_LIST, JSON.stringify(list));
        return list;
    }

    async function kmlRepoFetchText(name) {
        const r = await fetchWithTimeout(
            `${GH_API}/repos/${DATA_REPO}/contents/${KML_DIR}/${encodeURIComponent(name)}?ref=${DATA_BRANCH}`,
            { headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github.raw' } }, 60000);
        if (!r.ok) throw new Error(`fetch HTTP ${r.status}`);
        return r.text();
    }

    async function kmlRepoPut(name, text) {
        // UTF-8-safe chunked base64 (the proven Site Diff KML-copy pattern)
        const bytes = new TextEncoder().encode(text);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const r = await fetchWithTimeout(`${GH_API}/repos/${DATA_REPO}/contents/${KML_DIR}/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: Object.assign({ 'Content-Type': 'application/json' }, ghHdr()),
            // no sha → create-only; GitHub 422s instead of overwriting
            body: JSON.stringify({ message: `[AIM Fleet] add KML layer ${name}`, content: btoa(bin), branch: DATA_BRANCH }),
        }, 60000);
        if (r.status === 422) throw new Error('a layer with this name already exists in the repo — use ⟳ in KML Layers to load it, or rename your file');
        if (r.status !== 200 && r.status !== 201) throw new Error(`PUT HTTP ${r.status}`);
        return (await r.json()).content.sha;
    }

    async function kmlRepoDelete(name, sha) {
        const r = await fetchWithTimeout(`${GH_API}/repos/${DATA_REPO}/contents/${KML_DIR}/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: Object.assign({ 'Content-Type': 'application/json' }, ghHdr()),
            body: JSON.stringify({ message: `[AIM Fleet] delete KML layer ${name}`, sha, branch: DATA_BRANCH }),
        }, 60000);
        if (!r.ok) throw new Error(`DELETE HTTP ${r.status}`);
    }

    async function kmlEnsureLoaded(ly) {
        if (ly.features) return ly;
        const text = await kmlRepoFetchText(ly.repoName);
        const parsed = parseGeoText(text);
        Object.assign(ly, parsed);
        return ly;
    }

    // Boot: list repo layers (GM cache first for instant rows), auto-load
    // the ones whose per-user style says show. Idempotent; retried when
    // the token arrives and when the panel opens.
    async function kmlBoot() {
        if (kmlBootDone || !cachedToken) return;
        kmlBootDone = true;
        let list = loadJson(KEY_KML_LIST, null);
        try { list = await kmlRepoList(false); }
        catch (e) { console.warn(`${TAG} KML repo list failed (using cached):`, e); }
        (list || []).forEach(f => {
            const id = `repo:${f.name}`;
            if (kmlLayerById(id)) return;
            kmlLayers.push({ id, name: f.name.replace(/\.(kml|geojson|json)$/i, ''), repoName: f.name, source: 'repo', sha: f.sha, features: null });
        });
        renderPanel();
        for (const ly of kmlLayers) {
            if (ly.source === 'repo' && !ly.features && kmlStyleFor(ly.id).show) {
                try { await kmlEnsureLoaded(ly); renderOverlay(); }
                catch (e) { console.warn(`${TAG} KML layer "${ly.name}" load failed:`, e); }
            }
        }
        renderPanel();
        if (kmlLayers.length) console.log(`${TAG} KML layers: ${kmlLayers.length} in repo`);
    }

    // Force re-list + MERGE into the open layer set — adds repo layers
    // this session doesn't know (saved elsewhere / lost to a stale cache),
    // refreshes shas, drops repo rows whose file is gone. The recovery
    // path for "saved it but it doesn't show".
    async function kmlRefreshRepo() {
        try {
            setStatus('refreshing KML list from GitHub…');
            const list = await kmlRepoList(true);
            const seen = new Set();
            let added = 0;
            list.forEach(f => {
                const id = `repo:${f.name}`;
                seen.add(id);
                const existing = kmlLayerById(id);
                if (existing) { existing.sha = f.sha; return; }
                kmlLayers.push({ id, name: f.name.replace(/\.(kml|geojson|json)$/i, ''), repoName: f.name, source: 'repo', sha: f.sha, features: null });
                added++;
            });
            const before = kmlLayers.length;
            kmlLayers = kmlLayers.filter(ly => ly.source !== 'repo' || seen.has(ly.id));
            const dropped = before - kmlLayers.length;
            setStatus(`KML list refreshed — ${list.length} in repo${added ? `, ${added} new` : ''}${dropped ? `, ${dropped} removed` : ''}`);
            renderPanel();
            renderOverlay();
        } catch (e) {
            console.warn(`${TAG} KML refresh failed:`, e);
            setStatus(`KML refresh failed — ${String(e && e.message || e)}`);
        }
    }

    async function kmlHandleFiles(files) {
        for (const f of files) {
            try {
                if (/\.kmz$/i.test(f.name)) { setStatus(`"${f.name}" is a KMZ — unzip it to .kml first`); continue; }
                const text = await f.text();
                const parsed = parseGeoText(text);
                const id = `sess:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
                const extM = f.name.match(/\.(kml|geojson|json)$/i);
                kmlLayers.push(Object.assign({
                    id, name: f.name.replace(/\.(kml|geojson|json)$/i, ''), source: 'session', rawText: text,
                    ext: extM ? extM[0].toLowerCase() : '.kml',
                }, parsed));
                kmlStyleFor(id);
                saveKmlStyles();
                console.log(`${TAG} KML "${f.name}": ${parsed.features.length} feature(s), ${parsed.vertexCount} vertices (session layer)`);
                setStatus(`loaded "${f.name}" — ${parsed.features.length} feature(s) (session only; 💾 to keep it)`);
            } catch (e) {
                console.warn(`${TAG} KML parse failed for ${f.name}:`, e);
                setStatus(`"${f.name}" failed: ${String(e && e.message || e)}`);
            }
        }
        renderPanel();
        renderOverlay();
    }

    // ==================================================================
    // 📐 Cross-reference (v0.18) — the reason this exists: how much of a
    // client's water-line KML can be inspected from EXISTING sites
    // without building new areas. Samples the source layer's geometry and
    // classifies every sample by distance to the target (site FFZs+FPs,
    // or another KML layer) into bands (≤50 ft, ≤200 ft default).
    // Segment-to-segment/point-in-polygon math (engraved), cooperative
    // yields, results drawn as colored runs on the map + copyable report.
    // ==================================================================
    // ≤b1 BLUE (green would vanish against FFZs — user call), ≤b2 amber, beyond red
    const XREF_COLORS = { 1: '#3d7bff', 2: '#ffd130', 0: '#ff5252' };
    let xrefState = null;   // {running, result, srcId, tgt}
    let xrefSeq = 0;
    let xrefSrcSel = '';    // UI selections (session)
    let xrefTgtSel = 'sites';
    // v0.30: site scope — only sites whose name contains one of these
    // comma-separated terms count as targets/bases (e.g. "Exxon"). Empty = all.
    let xrefSiteFilter = '';
    let xrefUsePicked = false;   // v0.39: scope = the Fleet Data picker selection
    function xrefSiteMatches(id) {
        if (xrefUsePicked) return fdSelected.has(String(id));
        const terms = xrefSiteFilter.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        if (!terms.length) return true;
        const nm = siteName(id).toLowerCase();
        return terms.some(t => nm.includes(t));
    }

    // Uniform-grid spatial index over the envelope (v0.19) — a county-
    // scale source (~200k samples) against a 10k-item envelope would be
    // billions of bbox tests brute-force. Cell ≥ pad ⇒ a sample's own
    // cell ± 1 ring is guaranteed to hold every candidate within pad.
    function xrefBuildGrid(env, cellM) {
        const grid = new Map();
        const put = (kind, item) => {
            const gx0 = Math.floor(item.minX / cellM), gx1 = Math.floor(item.maxX / cellM);
            const gy0 = Math.floor(item.minY / cellM), gy1 = Math.floor(item.maxY / cellM);
            for (let gx = gx0; gx <= gx1; gx++) {
                for (let gy = gy0; gy <= gy1; gy++) {
                    const k = gx + ':' + gy;
                    let cell = grid.get(k);
                    if (!cell) { cell = { segs: [], polys: [] }; grid.set(k, cell); }
                    cell[kind].push(item);
                }
            }
        };
        env.segs.forEach(s => put('segs', s));
        env.polys.forEach(p => put('polys', p));
        return grid;
    }

    let xrefQueryId = 0;
    function xrefDistGrid(x, y, grid, cellM, pad) {
        let best = Infinity;
        const qid = ++xrefQueryId;   // dedupe items spanning several cells
        const gx = Math.floor(x / cellM), gy = Math.floor(y / cellM);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const cell = grid.get((gx + dx) + ':' + (gy + dy));
                if (!cell) continue;
                for (const pg of cell.polys) {
                    if (pg.__q === qid) continue;
                    pg.__q = qid;
                    if (x < pg.minX - pad || x > pg.maxX + pad || y < pg.minY - pad || y > pg.maxY + pad) continue;
                    if (pointInRingXY(x, y, pg.xs, pg.ys)) return 0;
                    for (let i = 0, j = pg.xs.length - 1; i < pg.xs.length; j = i++) {
                        const c = nbSegPtClosest(x, y, pg.xs[j], pg.ys[j], pg.xs[i], pg.ys[i]);
                        if (c.d < best) best = c.d;
                    }
                }
                for (const s of cell.segs) {
                    if (s.__q === qid) continue;
                    s.__q = qid;
                    if (x < s.minX - pad || x > s.maxX + pad || y < s.minY - pad || y > s.maxY + pad) continue;
                    const c = nbSegPtClosest(x, y, s.ax, s.ay, s.bx, s.by);
                    if (c.d < best) best = c.d;
                }
            }
        }
        return best;
    }

    // v0.28/v0.39: like xrefDistGrid but also returns WHICH target item was
    // nearest (its `tag` = {sid, site, ename, etype}) — every sample/point
    // can then be attributed to a site + entity. Polygons and segments.
    function xrefNearestGrid(x, y, grid, cellM, pad) {
        let best = Infinity, tag = null;
        const qid = ++xrefQueryId;
        const gx = Math.floor(x / cellM), gy = Math.floor(y / cellM);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const cell = grid.get((gx + dx) + ':' + (gy + dy));
                if (!cell) continue;
                for (const pg of cell.polys) {
                    if (pg.__q === qid) continue;
                    pg.__q = qid;
                    if (x < pg.minX - pad || x > pg.maxX + pad || y < pg.minY - pad || y > pg.maxY + pad) continue;
                    if (pointInRingXY(x, y, pg.xs, pg.ys)) return { d: 0, tag: pg.tag };
                    for (let i = 0, j = pg.xs.length - 1; i < pg.xs.length; j = i++) {
                        const c = nbSegPtClosest(x, y, pg.xs[j], pg.ys[j], pg.xs[i], pg.ys[i]);
                        if (c.d < best) { best = c.d; tag = pg.tag; }
                    }
                }
                for (const s of cell.segs) {
                    if (s.__q === qid) continue;
                    s.__q = qid;
                    if (x < s.minX - pad || x > s.maxX + pad || y < s.minY - pad || y > s.maxY + pad) continue;
                    const c = nbSegPtClosest(x, y, s.ax, s.ay, s.bx, s.by);
                    if (c.d < best) { best = c.d; tag = s.tag; }
                }
            }
        }
        return { d: best, tag };
    }
    function xrefEnvAddSeg(env, A, B, tag) {
        env.segs.push({
            ax: A.x, ay: A.y, bx: B.x, by: B.y,
            minX: Math.min(A.x, B.x), maxX: Math.max(A.x, B.x),
            minY: Math.min(A.y, B.y), maxY: Math.max(A.y, B.y),
            tag: tag || null,
        });
    }
    function xrefEnvAddRing(env, ptsXY, tag) {
        const xs = [], ys = [];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        ptsXY.forEach(q => {
            xs.push(q.x); ys.push(q.y);
            if (q.x < minX) minX = q.x;
            if (q.x > maxX) maxX = q.x;
            if (q.y < minY) minY = q.y;
            if (q.y > maxY) maxY = q.y;
        });
        if (xs.length > 2) env.polys.push({ xs, ys, minX, maxX, minY, maxY, tag: tag || null });
    }

    async function runXref() {
        if (xrefState && xrefState.running) return;
        const seq = ++xrefSeq;
        if (!kmlLayerById(xrefSrcSel) && kmlLayers.length) xrefSrcSel = kmlLayers[0].id;   // lone-option selects never fire 'change'
        const src = kmlLayerById(xrefSrcSel);
        if (!src) { setStatus('pick a source KML layer first'); return; }
        // v0.28: the base-station target uses its own (much larger) bands
        const isBases = xrefTgtSel === 'bases';
        const B1FT = isBases ? ftCfg.xrefBaseB1 : ftCfg.xrefB1;
        const B2FT = isBases ? ftCfg.xrefBaseB2 : ftCfg.xrefB2;
        const b1m = B1FT / FT_PER_M;
        const b2m = B2FT / FT_PER_M;
        if (!(b2m > b1m)) { setStatus('band 2 must be larger than band 1'); return; }
        const perBase = {};   // sid → { name, lenM:{1,2,0}, pts:{1,2,0} } (bases mode)
        if (xrefUsePicked && !fdSelected.size && (isBases || String(xrefTgtSel).startsWith('sites'))) { setStatus('"picked only" is on but nothing is picked — tick sites in 📦 Fleet Data or turn it off'); return; }
        xrefState = { running: true, result: null };
        renderPanel();
        try {
            await kmlEnsureLoaded(src);
            if (seq !== xrefSeq) return;
            const proj = projector((src.bbox.minLat + src.bbox.maxLat) / 2);
            const notes = ['polygon inner holes ignored', 'lengths are sampling approximations'];

            // ---- target envelope ----
            const env = { segs: [], polys: [] };
            let tgtLabel;
            let sitesUsed = 0;
            let basesUsed = 0;
            const sitesNoBase = [];
            if (isBases) {
                // Straight-line (one-way) distance from each site's BASE
                // STATION (type 8 in /map_objects/) — "what can we reach from
                // base without shielding": ≤ Tattu range / ≤ Tulip range.
                tgtLabel = `base stations — straight-line range (Tattu ≤${B1FT.toLocaleString()} ft / Tulip ≤${B2FT.toLocaleString()} ft)`;
                const sites = await fetchRawSites(false);
                if (seq !== xrefSeq) return;
                const marginFt = 3000;   // the base may sit outside the setup bbox
                const cands = Object.keys(sites).filter(id => {
                    if (ftIgnore[id]) return false;
                    if (!xrefSiteMatches(id)) return false;   // v0.30: site scope
                    if (ftCfg.onlyProduction && siteStatus(id) && siteStatus(id) !== 'Production') return false;
                    const b = nbIndex.bboxes[id];
                    if (b && !b.empty) return bboxGapFt(b, src.bbox) <= B2FT + marginFt;
                    const c = siteEntryCenter(sites[id].raw);
                    if (!c) return false;   // no snapshot AND no center — cannot place it
                    const pb = { minLat: c.lat, maxLat: c.lat, minLng: c.lng, maxLng: c.lng };
                    return bboxGapFt(pb, src.bbox) <= B2FT + marginFt + 5280;   // center-only: extra mile of slack
                });
                if (!cands.length) notes.push('NO sites within range of this layer');
                for (let i = 0; i < cands.length; i++) {
                    if (seq !== xrefSeq) return;
                    setStatus(`cross-ref: fetching site ${cands[i]} for its base station (${i + 1}/${cands.length})…`);
                    let ents;
                    try { ents = await fetchSiteEntities(cands[i], false); }
                    catch (e) { notes.push(`site ${siteName(cands[i])} (#${cands[i]}) fetch failed — no base counted`); continue; }
                    sitesUsed++;
                    let found = 0;
                    ents.forEach(e => {
                        if (!e || e.type !== 8) return;
                        const c = (entityCoords(e) || [])[0];
                        if (!c || typeof c.lat !== 'number' || typeof c.lng !== 'number') return;
                        const q = proj.toXY(c);
                        xrefEnvAddSeg(env, q, q, { sid: String(cands[i]), site: siteName(cands[i]), ename: e.name || 'base', etype: 'Base' });   // point = degenerate segment, tagged
                        found++;
                    });
                    if (found) { basesUsed += found; perBase[cands[i]] = { sid: cands[i], name: siteName(cands[i]), bases: found, lenM: { 0: 0, 1: 0, 2: 0 }, pts: { 0: 0, 1: 0, 2: 0 } }; }
                    else sitesNoBase.push(siteName(cands[i]));
                }
                if (sitesNoBase.length) notes.push(`${sitesNoBase.length} site(s) in range have NO base station in their setup and were skipped: ${sitesNoBase.slice(0, 8).join(', ')}${sitesNoBase.length > 8 ? '…' : ''}`);
            } else if (String(xrefTgtSel).startsWith('sites')) {
                // Scope matters operationally: mission steps only run INSIDE
                // FFZs — FFZ-only coverage = what is actually inspectable
                const useFfz = xrefTgtSel !== 'sites-fp';
                const useFp = xrefTgtSel !== 'sites-ffz';
                tgtLabel = xrefTgtSel === 'sites-ffz' ? 'site FFZs ONLY (mission-step airspace)'
                    : (xrefTgtSel === 'sites-fp' ? 'site FPs ONLY' : 'site FFZs + FPs');
                const sites = await fetchRawSites(false);
                if (seq !== xrefSeq) return;
                const marginFt = 500;   // index bboxes may be slightly stale
                const cands = Object.keys(nbIndex.bboxes).filter(id => {
                    if (!sites[id]) return false;           // access authority (engraved)
                    if (ftIgnore[id]) return false;         // duplicate/OFFLINE copies don't count as coverage
                    if (!xrefSiteMatches(id)) return false; // v0.30: site scope
                    if (ftCfg.onlyProduction && siteStatus(id) && siteStatus(id) !== 'Production') return false;
                    const b = nbIndex.bboxes[id];
                    return b && !b.empty && bboxGapFt(b, src.bbox) <= ftCfg.xrefB2 + marginFt;
                });
                if (!cands.length) notes.push('NO sites within range of this layer');
                if (xrefUsePicked) {   // v0.39: a picked site with no Site Watch snapshot can't be placed — say so, never silently drop it
                    const missing = Array.from(fdSelected).filter(id => !(nbIndex.bboxes[id] && !nbIndex.bboxes[id].empty));
                    if (missing.length) notes.push(`${missing.length} picked site(s) have no Site Watch snapshot and were NOT checked: ${missing.slice(0, 8).map(id => siteName(id)).join(', ')}${missing.length > 8 ? '…' : ''} — run ⟳ Update index in the Overlap Sweep section`);
                }
                for (let i = 0; i < cands.length; i++) {
                    if (seq !== xrefSeq) return;
                    setStatus(`cross-ref: fetching site ${cands[i]} (${i + 1}/${cands.length})…`);
                    let ents;
                    try { ents = await fetchSiteEntities(cands[i], false); }
                    catch (e) { notes.push(`site ${siteName(cands[i])} (#${cands[i]}) fetch failed — not counted as coverage`); continue; }
                    sitesUsed++;
                    const sidTag = String(cands[i]), siteTag = siteName(cands[i]);
                    ents.forEach(e => {
                        if (useFp && e.type === 15 && Array.isArray(e.arcs)) {
                            const tag = { sid: sidTag, site: siteTag, ename: e.name || `FP ${e.id}`, etype: 'FP' };
                            e.arcs.forEach(a => {
                                if (a && a.point_a && a.point_b && typeof a.point_a.lat === 'number' && typeof a.point_b.lat === 'number') {
                                    xrefEnvAddSeg(env, proj.toXY(a.point_a), proj.toXY(a.point_b), tag);
                                }
                            });
                        } else if (useFfz && e.type === 16) {
                            const cs = (entityCoords(e) || []).filter(p => p && typeof p.lat === 'number');
                            if (cs.length > 2) xrefEnvAddRing(env, cs.map(p => proj.toXY(p)), { sid: sidTag, site: siteTag, ename: e.name || `FFZ ${e.id}`, etype: 'FFZ' });
                        }
                    });
                }
            } else {
                const tgt = kmlLayerById(xrefTgtSel);
                if (!tgt) { setStatus('target layer not found'); xrefState.running = false; renderPanel(); return; }
                await kmlEnsureLoaded(tgt);
                if (seq !== xrefSeq) return;
                tgtLabel = `KML "${tgt.name}"`;
                tgt.features.forEach(f => {
                    const xy = f.pts.map(p => proj.toXY({ lat: p[0], lng: p[1] }));
                    const tag = { sid: null, site: tgt.name, ename: f.name || '', etype: 'KML' };
                    if (f.type === 'poly') {
                        xrefEnvAddRing(env, xy, tag);
                    } else if (f.type === 'line') {
                        for (let i = 1; i < xy.length; i++) xrefEnvAddSeg(env, xy[i - 1], xy[i], tag);
                    } else {
                        xrefEnvAddSeg(env, xy[0], xy[0], tag);   // point = degenerate segment
                    }
                });
            }
            if (!env.segs.length && !env.polys.length) {
                xrefState = { running: false, result: null };
                setStatus('cross-ref: target has no usable geometry in range');
                renderPanel();
                return;
            }

            // ---- sample + classify the source ----
            setStatus('cross-ref: sampling source geometry…');
            // adaptive step: ~10 ft on small layers, coarser on huge ones
            // (cap ~60k samples so county-scale networks stay responsive)
            let totalLenM = 0;
            src.features.forEach(f => {
                if (f.type === 'point') return;
                const xy = f.pts.map(p => proj.toXY({ lat: p[0], lng: p[1] }));
                const n = f.type === 'poly' ? xy.length : xy.length - 1;
                for (let i = 0; i < n; i++) {
                    const a = xy[i], b = xy[(i + 1) % xy.length];
                    totalLenM += Math.hypot(b.x - a.x, b.y - a.y);
                }
            });
            // ~33 ft max step (was ~100 ft on county-scale sources — too
            // coarse next to a 50 ft band; the grid index pays for it)
            const step = Math.min(10, Math.max(3, totalLenM / 250000));
            const pad = b2m + 1;
            const cellM = Math.max(150, pad);
            const grid = xrefBuildGrid(env, cellM);
            const bandLenM = { 0: 0, 1: 0, 2: 0 };
            const runs = [];   // EVERY run is kept and drawn — v0.18 dropped
                               // short/overflow runs, leaving gaps on the map
            const pointHits = { 0: 0, 1: 0, 2: 0 };
            const pointMarks = [];
            let ops = 0;
            let doneLenM = 0;
            const b1ft = B1FT, b2ft = B2FT;
            const classify = (d) => {
                const ft = Math.round(d * FT_PER_M);
                return ft < b1ft ? 1 : (ft < b2ft ? 2 : 0);
            };
            // v0.39: every query returns WHICH target item was nearest — points
            // within the bands are listed with site / entity / distance, runs
            // carry their site/entity, bases roll up per site.
            let lastTag = null;
            const dist = (x, y) => { const r = xrefNearestGrid(x, y, grid, cellM, pad); lastTag = r.tag; return r.d; };
            const pointMatches = [];   // { name, lat, lng, band, ft, sid, site, ename, etype }
            const PM_CAP = 5000;
            const finishRun = (run) => {
                if (!run) return;
                if (run.pts.length > 320) {   // decimate drawing pts, keep shape
                    const keep = [];
                    const stride = Math.ceil(run.pts.length / 300);
                    for (let i = 0; i < run.pts.length; i += stride) keep.push(run.pts[i]);
                    keep.push(run.pts[run.pts.length - 1]);
                    run.pts = keep;
                }
                runs.push(run);
            };
            for (const f of src.features) {
                if (seq !== xrefSeq) return;
                if (f.type === 'point') {
                    const q = proj.toXY({ lat: f.pts[0][0], lng: f.pts[0][1] });
                    const dq = dist(q.x, q.y);
                    const band = classify(dq);
                    pointHits[band]++;
                    if (isBases && band && lastTag && perBase[lastTag.sid]) perBase[lastTag.sid].pts[band]++;
                    if (band && pointMatches.length < PM_CAP) pointMatches.push({ name: f.name || '', lat: f.pts[0][0], lng: f.pts[0][1], band, ft: Math.round(dq * FT_PER_M),
                        sid: lastTag ? lastTag.sid : null, site: lastTag ? lastTag.site : '', ename: lastTag ? lastTag.ename : '', etype: lastTag ? lastTag.etype : '' });
                    if (pointMarks.length < 500) pointMarks.push({ lat: f.pts[0][0], lng: f.pts[0][1], band });
                    continue;
                }
                const xy = f.pts.map(p => proj.toXY({ lat: p[0], lng: p[1] }));
                const segN = f.type === 'poly' ? xy.length : xy.length - 1;
                let run = null;   // continues ACROSS segments — a feature's
                                  // polyline is one continuous line
                for (let i = 0; i < segN; i++) {
                    const A = xy[i], B = xy[(i + 1) % xy.length];
                    const Pa = f.pts[i], Pb = f.pts[(i + 1) % f.pts.length];
                    const segLen = Math.hypot(B.x - A.x, B.y - A.y);
                    if (!segLen) continue;
                    const n = Math.max(1, Math.ceil(segLen / step));
                    // continuation segments skip k=0 (same point as the
                    // previous segment's last sample)
                    for (let k = (run && i > 0) ? 1 : 0; k <= n; k++) {
                        const t = k / n;
                        const d = dist(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t);
                        const band = classify(d);
                        const lat = Pa[0] + (Pb[0] - Pa[0]) * t, lng = Pa[1] + (Pb[1] - Pa[1]) * t;
                        if (k > 0) {
                            bandLenM[band] += segLen / n; doneLenM += segLen / n;
                            if (isBases && band && lastTag && perBase[lastTag.sid]) perBase[lastTag.sid].lenM[band] += segLen / n;
                        }
                        if (!run || run.band !== band) {
                            // extend the outgoing run to the transition point
                            // so adjacent bands SHARE their boundary — without
                            // this every color change left a one-step gap
                            if (run) run.pts.push([lat, lng]);
                            finishRun(run);
                            run = { band, featName: f.name, pts: [[lat, lng]], lenM: 0, tag: band ? lastTag : null };
                        } else {
                            run.lenM += segLen / n;
                            run.pts.push([lat, lng]);
                        }
                        if (++ops >= 3000) {
                            ops = 0;
                            setStatus(`cross-ref: classifying… ${Math.min(99, Math.round(doneLenM / totalLenM * 100))}%`);
                            await ftYield();
                            if (seq !== xrefSeq) return;
                        }
                    }
                }
                finishRun(run);
            }
            const topRuns = [...runs].sort((a, b) => b.lenM - a.lenM).slice(0, 60);
            if (isBases || String(xrefTgtSel).startsWith('sites')) {
                if (xrefUsePicked) tgtLabel += ` · picked sites only (${fdSelected.size})`;
                else if (xrefSiteFilter.trim()) tgtLabel += ` · sites matching "${xrefSiteFilter.trim()}"`;
            }
            pointMatches.sort((a, b) => (a.site || '').localeCompare(b.site || '') || a.ft - b.ft);
            const perBaseList = Object.values(perBase).sort((a, b) => (b.lenM[1] + b.lenM[2]) - (a.lenM[1] + a.lenM[2]) || (b.pts[1] + b.pts[2]) - (a.pts[1] + a.pts[2]));
            const result = {
                at: Date.now(),
                srcName: src.name, tgtLabel, sitesUsed,
                mode: isBases ? 'bases' : 'coverage',
                basesUsed, sitesNoBase: sitesNoBase.length, perBase: perBaseList,
                pointMatches, pointMatchesCapped: pointMatches.length >= PM_CAP,
                sitesMatched: (() => { const S = new Set(); pointMatches.forEach(m => { if (m.sid) S.add(m.sid); }); runs.forEach(rn => { if (rn.band && rn.tag && rn.tag.sid) S.add(rn.tag.sid); }); return S.size; })(),
                b1: B1FT, b2: B2FT,
                stepFt: Math.round(step * FT_PER_M),
                totalM: totalLenM, bandLenM,
                runs,              // complete — drawn as 3 merged band paths
                topRuns,           // longest first — panel list + report
                runsTotal: runs.length,
                pointHits, pointMarks,
                pointsTotal: src.features.filter(f => f.type === 'point').length,
                notes,
            };
            xrefState = { running: false, result };
            console.log(`${TAG} cross-ref done:`, buildXrefReport().split('\n').slice(0, 8).join(' | '));
            setStatus(totalLenM > 0
                ? `cross-ref done — ≤${result.b1} ft: ${fmtMi(bandLenM[1])} · ≤${result.b2} ft: ${fmtMi(bandLenM[1] + bandLenM[2])} of ${fmtMi(totalLenM)}`
                : `cross-ref done — ≤${result.b1} ft: ${pointHits[1]} · ≤${result.b2} ft: ${pointHits[1] + pointHits[2]} of ${result.pointsTotal} points`);
            renderPanel();
            renderOverlay();
        } catch (e) {
            console.warn(`${TAG} cross-ref failed:`, e);
            xrefState = { running: false, result: null, error: String(e && e.message || e) };
            setStatus(`cross-ref failed — ${String(e && e.message || e)}`);
            renderPanel();
        }
    }

    function fmtMi(m) {
        const ft = m * FT_PER_M;
        return ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${Math.round(ft).toLocaleString()} ft`;
    }
    function pct(part, whole) { return whole > 0 ? `${(part / whole * 100).toFixed(1)}%` : '—'; }

    // ---- v0.31: 📊 cross-ref report card (popup, like the Fleet Issues summary) ----
    let xrefCardEl = null, xrefCardKeyH = null;
    function closeXrefCard() {
        if (xrefCardEl) { try { xrefCardEl.remove(); } catch (e) {} }
        xrefCardEl = null;
        if (xrefCardKeyH) { try { document.removeEventListener('keydown', xrefCardKeyH, true); } catch (e) {} xrefCardKeyH = null; }
    }
    function xrefSheetsHtml(r) {
        const bases = r.mode === 'bases';
        const P = r.pointHits || { 0: 0, 1: 0, 2: 0 };
        const pointsOnly = !!r.pointsTotal && !(r.totalM > 0);
        const th = (v) => `<th style="background:#14171b;color:#fff;padding:6px 8px;border:1px solid #444;text-align:left">${escapeHtml(v)}</th>`;
        const td = (v) => `<td style="padding:5px 8px;border:1px solid #444">${v}</td>`;
        const miN = (m) => (m * FT_PER_M / 5280).toFixed(2);
        const l1 = bases ? `Tattu ≤${r.b1.toLocaleString()} ft` : `≤${r.b1} ft`, l2 = bases ? `Tulip only ${r.b1.toLocaleString()}–${r.b2.toLocaleString()} ft` : `${r.b1}–${r.b2} ft`;
        const out = [`<p><b>AIM Fleet Tools — cross-reference</b> — "${escapeHtml(r.srcName)}" vs ${escapeHtml(r.tgtLabel)} — ${escapeHtml(new Date(r.at).toLocaleString())}</p>`];
        out.push('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><tr>' + [pointsOnly ? 'Points' : 'Total mi', l1, l2, `≤${r.b2.toLocaleString()} ft cumulative`, 'Beyond', 'Sites checked', 'Sites with matches', bases ? 'Bases' : ''].filter(Boolean).map(th).join('') + '</tr><tr>'
            + (pointsOnly ? [r.pointsTotal, `${P[1]} (${pct(P[1], r.pointsTotal)})`, `${P[2]} (${pct(P[2], r.pointsTotal)})`, `${P[1] + P[2]} (${pct(P[1] + P[2], r.pointsTotal)})`, `${P[0]} (${pct(P[0], r.pointsTotal)})`]
                : [miN(r.totalM), `${miN(r.bandLenM[1])} (${pct(r.bandLenM[1], r.totalM)})`, `${miN(r.bandLenM[2])} (${pct(r.bandLenM[2], r.totalM)})`, `${miN(r.bandLenM[1] + r.bandLenM[2])} (${pct(r.bandLenM[1] + r.bandLenM[2], r.totalM)})`, `${miN(r.bandLenM[0])} (${pct(r.bandLenM[0], r.totalM)})`])
              .concat([r.sitesUsed, r.sitesMatched || 0, bases ? r.basesUsed : null]).filter(v => v !== null).map(v => td(escapeHtml(String(v)))).join('') + '</tr></table><br>');
        if (bases && r.perBase && r.perBase.length) {
            out.push('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><tr>' + ['Base (site)', 'Site ID', pointsOnly ? 'Tattu pts' : 'Tattu mi', pointsOnly ? 'Tulip-only pts' : 'Tulip-only mi', pointsOnly ? 'Reachable pts' : 'Reachable mi', pointsOnly ? '' : 'Points Tattu/Tulip'].filter(Boolean).map(th).join('') + '</tr>');
            r.perBase.forEach(b => out.push('<tr>' + td(`<a href="${siteSetupUrl(b.sid)}" style="color:#1a73e8">${escapeHtml(b.name)}</a>${b.bases > 1 ? ` ×${b.bases}` : ''}`) + td(b.sid)
                + (pointsOnly ? td(b.pts[1]) + td(b.pts[2]) + td(b.pts[1] + b.pts[2]) : td(miN(b.lenM[1])) + td(miN(b.lenM[2])) + td(miN(b.lenM[1] + b.lenM[2])) + td(`${b.pts[1]}/${b.pts[2]}`)) + '</tr>'));
            out.push('</table><br>');
        }
        if (r.pointMatches && r.pointMatches.length) {
            out.push('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><tr>' + ['Site', 'Site ID', 'Entity type', 'Entity', 'Feature', 'Distance ft', 'Band', 'Lat', 'Lng'].map(th).join('') + '</tr>');
            r.pointMatches.forEach(m => out.push('<tr>' + td(escapeHtml(m.site || '')) + td(m.sid || '') + td(escapeHtml(m.etype || '')) + td(escapeHtml(m.ename || '')) + td(escapeHtml(m.name || '')) + td(m.ft) + td(m.band === 1 ? l1 : l2) + td(m.lat.toFixed(6)) + td(m.lng.toFixed(6)) + '</tr>'));
            out.push('</table><br>');
        }
        if (r.runsTotal) {
            out.push('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><tr>' + ['#', 'Band', 'Length mi', 'Feature', 'Nearest site', 'Nearest entity', 'Lat', 'Lng'].map(th).join('') + '</tr>');
            (r.topRuns || r.runs).slice(0, 40).forEach((run, i) => { const mid = run.pts[Math.floor(run.pts.length / 2)]; out.push('<tr>' + td(i + 1) + td(run.band === 1 ? l1 : run.band === 2 ? l2 : 'beyond') + td(miN(run.lenM)) + td(escapeHtml(run.featName || '')) + td(escapeHtml(run.tag ? run.tag.site || '' : '')) + td(escapeHtml(run.tag ? `${run.tag.etype || ''} ${run.tag.ename || ''}`.trim() : '')) + td(mid[0].toFixed(6)) + td(mid[1].toFixed(6)) + '</tr>'); });
            out.push('</table>');
        }
        return out.join('');
    }
    function openXrefCard() {
        closeXrefCard();
        const r = xrefState && xrefState.result;
        if (!r) { setStatus('no cross-reference run yet'); return; }
        const bases = r.mode === 'bases';
        const P = r.pointHits || { 0: 0, 1: 0, 2: 0 };
        const pointsOnly = !!r.pointsTotal && !(r.totalM > 0);
        const l1 = bases ? `Tattu ≤${r.b1.toLocaleString()} ft` : `≤${r.b1} ft`, l2 = bases ? `Tulip only ${r.b1.toLocaleString()}–${r.b2.toLocaleString()} ft` : `${r.b1}–${r.b2} ft`;
        const L = r.bandLenM;
        const total = pointsOnly ? r.pointsTotal : r.totalM;
        const v = (k) => pointsOnly ? P[k] : L[k];
        const fmtV = (x) => pointsOnly ? `${x} pts` : fmtMi(x);
        const tile = (label, val, sub, color) => `<div style="background:#14171b;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 12px;min-width:120px"><div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">${label}</div><div style="color:${color || '#e6e6e6'};font-size:20px;font-weight:700">${val}</div>${sub ? `<div style="color:#888;font-size:11px">${sub}</div>` : ''}</div>`;
        const bar = (label, val, color) => `<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin:3px 0"><span style="width:230px;color:${color}">${label}</span><div style="flex:1;height:12px;background:#0e1115;border-radius:6px;overflow:hidden"><div style="width:${total ? Math.round(100 * val / total) : 0}%;height:100%;background:${color}"></div></div><span style="width:150px;text-align:right;font-weight:700">${fmtV(val)} <span style="color:#888;font-weight:400">${pct(val, total)}</span></span></div>`;
        const card = document.createElement('div');
        card.id = 'aim-ft-xref-card';
        card.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:900px;max-width:95vw;max-height:88vh;background:#1f2228;border:1px solid rgba(122,223,230,0.55);border-radius:10px;color:#e6e6e6;z-index:2147480002;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.7);display:flex;flex-direction:column;overflow:hidden`;
        const perBaseHtml = (bases && r.perBase && r.perBase.length) ? (() => {
            const list = pointsOnly ? r.perBase.filter(b => b.pts[1] + b.pts[2] > 0) : r.perBase.filter(b => b.lenM[1] + b.lenM[2] > 0 || b.pts[1] + b.pts[2] > 0);
            const zero = r.perBase.length - list.length;
            const max = Math.max(1, ...list.map(b => pointsOnly ? b.pts[1] + b.pts[2] : b.lenM[1] + b.lenM[2]));
            return `<div style="margin-top:14px"><div style="color:#7adfe6;font-weight:700;font-size:11px;margin-bottom:4px">PER BASE — what each site's base can reach ${pointsOnly ? '(points)' : '(miles)'}</div>
                <table style="width:100%;border-collapse:collapse;font-size:12px"><tr style="color:#888;text-align:left"><th style="padding:4px 6px">Base (site)</th><th style="padding:4px 6px;color:${XREF_COLORS[1]}">Tattu</th><th style="padding:4px 6px;color:${XREF_COLORS[2]}">Tulip only</th><th style="padding:4px 6px;color:#5fff5f">Reachable</th><th style="padding:4px 6px;width:30%"></th>${pointsOnly ? '' : '<th style="padding:4px 6px">Points</th>'}</tr>
                ${list.map(b => { const reach = pointsOnly ? b.pts[1] + b.pts[2] : b.lenM[1] + b.lenM[2]; const f = pointsOnly ? (x) => `${x}` : fmtMi; return `<tr style="border-top:1px solid rgba(255,255,255,0.06)"><td style="padding:4px 6px">${escapeHtml(b.name)} <span style="color:#555">#${b.sid}</span>${b.bases > 1 ? ` <span style="color:#888">×${b.bases}</span>` : ''} <span data-ft-link="${b.sid}" style="cursor:pointer;color:#5fb3ff">↗</span></td><td style="padding:4px 6px">${f(pointsOnly ? b.pts[1] : b.lenM[1])}</td><td style="padding:4px 6px">${f(pointsOnly ? b.pts[2] : b.lenM[2])}</td><td style="padding:4px 6px;font-weight:700;color:#5fff5f">${f(reach)}</td><td style="padding:4px 6px"><div style="height:8px;background:#0e1115;border-radius:4px;overflow:hidden"><div style="width:${Math.round(100 * reach / max)}%;height:100%;background:#5fff5f"></div></div></td>${pointsOnly ? '' : `<td style="padding:4px 6px;color:#aaa">${b.pts[1]}/${b.pts[2]}</td>`}</tr>`; }).join('')}
                ${zero ? `<tr><td colspan="6" style="padding:4px 6px;color:#666">+${zero} base(s) with nothing in range</td></tr>` : ''}</table></div>`;
        })() : '';
        const matchesHtml = (r.pointMatches && r.pointMatches.length) ? `<div style="margin-top:14px"><div style="color:#7adfe6;font-weight:700;font-size:11px;margin-bottom:4px">POINTS WITHIN ≤${r.b2.toLocaleString()} FT <span style="color:#888;font-weight:400">(${r.pointMatches.length}${r.pointMatchesCapped ? '+, capped' : ''} · site → entity → feature → distance · click 🎯)</span></div>
            <div style="max-height:34vh;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><tr style="color:#888;text-align:left;position:sticky;top:0;background:#1f2228"><th style="padding:4px 6px">Site</th><th style="padding:4px 6px">Entity</th><th style="padding:4px 6px">Feature</th><th style="padding:4px 6px">Distance</th><th style="padding:4px 6px"></th></tr>
            ${r.pointMatches.slice(0, 1500).map((m, i) => `<tr data-xrs-pt="${i}" style="border-top:1px solid rgba(255,255,255,0.05);cursor:pointer"><td style="padding:3px 6px;color:#7adfe6">${escapeHtml(m.site || '—')}</td><td style="padding:3px 6px"><span style="color:#888;font-size:10px">${escapeHtml(m.etype || '')}</span> ${escapeHtml(m.ename || '—')}</td><td style="padding:3px 6px;color:#aaa">${escapeHtml(m.name || '(unnamed)')}</td><td style="padding:3px 6px;font-weight:700;color:${XREF_COLORS[m.band]}">${m.ft.toLocaleString()} ft</td><td style="padding:3px 6px">🎯</td></tr>`).join('')}</table>${r.pointMatches.length > 1500 ? `<div style="color:#666;font-size:11px;padding:4px 6px">…${r.pointMatches.length - 1500} more in Copy → Sheets</div>` : ''}</div></div>` : '';
        const runsHtml = r.runsTotal ? `<div style="margin-top:14px"><div style="color:#7adfe6;font-weight:700;font-size:11px;margin-bottom:4px">LONGEST STRETCHES <span style="color:#888;font-weight:400">(${Math.min(20, r.runsTotal)} of ${r.runsTotal} · click 🎯 to fly there)</span></div>
            ${(r.topRuns || r.runs).slice(0, 20).map((run, i) => `<div data-xrs-fly="${i}" style="display:flex;gap:10px;align-items:center;padding:3px 6px;border-top:1px solid rgba(255,255,255,0.05);cursor:pointer"><span style="width:180px;color:${XREF_COLORS[run.band]};font-weight:700">${run.band === 1 ? l1 : run.band === 2 ? l2 : 'beyond'}</span><span style="width:80px;font-weight:700">${fmtMi(run.lenM)}</span><span style="flex:1;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(run.featName || '')}${run.tag ? ` <span style="color:#7adfe6">→ ${escapeHtml(run.tag.site || '')}</span> <span style="color:#888">${escapeHtml(`${run.tag.etype || ''} ${run.tag.ename || ''}`.trim())}</span>` : ''}</span><span>🎯</span></div>`).join('')}</div>` : '';
        card.innerHTML = `
            <div style="padding:10px 14px;background:#14171b;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;gap:10px">
                <span style="font-size:16px">📐</span><span style="font-weight:700;color:#7adfe6">Cross-reference report</span>
                <span style="color:#888;font-size:11px">· ${escapeHtml(new Date(r.at).toLocaleString())}</span>
                <span style="margin-left:auto;display:flex;gap:6px">
                    <button id="aim-xrc-sheets" style="padding:4px 10px;background:#3a3f48;color:#ffd54f;border:1px solid rgba(255,213,79,0.4);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">📊 Copy → Sheets</button>
                    <button id="aim-xrc-text" style="padding:4px 10px;background:#3a3f48;color:#a8c4ff;border:1px solid rgba(168,196,255,0.3);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">📋 Copy text</button>
                    <button id="aim-xrc-close" style="padding:4px 10px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px">✕</button>
                </span>
            </div>
            <div style="padding:12px 14px;overflow:auto;flex:1;min-height:0">
                <div style="font-size:13px;line-height:1.5"><b>"${escapeHtml(r.srcName)}"</b> <span style="color:#888">vs</span> ${escapeHtml(r.tgtLabel)}<br>
                    <span style="color:#888;font-size:11px">${r.sitesUsed ? `${bases ? `${r.basesUsed} base(s) across ` : ''}${r.sitesUsed} site(s) checked · <b style="color:#5fff5f">${r.sitesMatched || 0} with a match</b>${r.sitesNoBase ? ` · ${r.sitesNoBase} skipped (no base in setup)` : ''} · ` : ''}${bases ? 'one-way straight-line distance from the base' : 'distance to the nearest target geometry'} · sampled every ~${r.stepFt} ft</span></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
                    ${tile(pointsOnly ? 'Points' : 'Network', pointsOnly ? r.pointsTotal : fmtMi(r.totalM), pointsOnly ? 'in the source layer' : 'total line length', '#e6e6e6')}
                    ${tile(bases ? 'Reachable · no shielding' : 'Inspectable', fmtV(v(1) + v(2)), `${pct(v(1) + v(2), total)} within ${r.b2.toLocaleString()} ft`, '#5fff5f')}
                    ${tile(bases ? 'Tattu' : `≤ ${r.b1} ft`, fmtV(v(1)), pct(v(1), total), XREF_COLORS[1])}
                    ${tile(bases ? 'Tulip only' : `${r.b1}–${r.b2} ft`, fmtV(v(2)), pct(v(2), total), XREF_COLORS[2])}
                    ${tile('Beyond', fmtV(v(0)), `${pct(v(0), total)} · ${bases ? 'needs shielding / new base' : 'needs new site area'}`, XREF_COLORS[0])}
                </div>
                <div style="margin-top:14px;background:#14171b;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 12px">
                    ${bar(l1, v(1), XREF_COLORS[1])}${bar(l2, v(2), XREF_COLORS[2])}${bar('beyond', v(0), XREF_COLORS[0])}
                    ${(!pointsOnly && r.pointsTotal) ? `<div style="color:#888;font-size:11px;margin-top:6px">Points in the layer: ${l1} ${P[1]} · ${l2} ${P[2]} · beyond ${P[0]} of ${r.pointsTotal}</div>` : ''}
                </div>
                ${perBaseHtml}
                ${matchesHtml}
                ${runsHtml}
                ${r.notes.length ? `<div style="margin-top:12px;color:#888;font-size:11px">${r.notes.map(x => `• ${escapeHtml(x)}`).join('<br>')}</div>` : ''}
            </div>`;
        ['mousedown', 'pointerdown', 'wheel', 'dblclick', 'contextmenu', 'touchstart'].forEach(evt => card.addEventListener(evt, e => e.stopPropagation(), false));
        document.body.appendChild(card);
        xrefCardEl = card;
        card.querySelector('#aim-xrc-close').onclick = closeXrefCard;
        card.querySelector('#aim-xrc-text').onclick = () => copyText(buildXrefReport(), 'report copied as text');
        card.querySelector('#aim-xrc-sheets').onclick = () => copyHtmlToClipboard(xrefSheetsHtml(r), buildXrefReport(), 'report copied — paste into Google Sheets / Excel');
        card.addEventListener('click', (ev) => {
            const fly = ev.target.closest('[data-xrs-fly]');
            if (fly) { const run = (r.topRuns || r.runs)[Number(fly.getAttribute('data-xrs-fly'))]; if (run) flyToBbox(ptsBbox(run.pts)); return; }
            const pt = ev.target.closest('[data-xrs-pt]');
            if (pt) { const m = r.pointMatches[Number(pt.getAttribute('data-xrs-pt'))]; if (m) flyToBbox({ minLat: m.lat - 0.001, maxLat: m.lat + 0.001, minLng: m.lng - 0.0013, maxLng: m.lng + 0.0013 }); return; }
            const link = ev.target.closest('[data-ft-link]');
            if (link) window.open(siteSetupUrl(link.getAttribute('data-ft-link')), '_blank');
        });
        xrefCardKeyH = (e) => { if (e.key === 'Escape' && xrefCardEl) { e.preventDefault(); closeXrefCard(); } };
        document.addEventListener('keydown', xrefCardKeyH, true);
    }

    function buildXrefReport() {
        const r = xrefState && xrefState.result;
        if (!r) return 'AIM Fleet Tools — no cross-reference run yet';
        const L = r.bandLenM;
        const lines = [];
        lines.push(`AIM Fleet Tools — KML cross-reference [${ENV_LABEL}]`);
        lines.push(`Source: "${r.srcName}" · Target: ${r.tgtLabel}${r.sitesUsed ? ` (${r.sitesUsed} site(s) checked · ${r.sitesMatched || 0} with a match within ≤${r.b2.toLocaleString()} ft)` : ''}`);
        lines.push(`Ran ${new Date(r.at).toLocaleString()} · bands ≤${r.b1} ft / ≤${r.b2} ft · sampled every ~${r.stepFt} ft`);
        lines.push('');
        const P = r.pointHits || { 0: 0, 1: 0, 2: 0 };
        const pointsOnly = !!r.pointsTotal && !(r.totalM > 0);
        if (pointsOnly) {
            // Point layer (risers, assets, wells…): counts ARE the result.
            const tot = r.pointsTotal;
            lines.push(`Points total: ${tot}`);
            if (r.mode === 'bases') {
                lines.push(`  Tattu range (≤${r.b1.toLocaleString()} ft from a base):   ${P[1]} (${pct(P[1], tot)})`);
                lines.push(`  Tulip only (${r.b1.toLocaleString()}–${r.b2.toLocaleString()} ft):        ${P[2]} (${pct(P[2], tot)})`);
                lines.push(`  ≤${r.b2.toLocaleString()} ft CUMULATIVE:            ${P[1] + P[2]} (${pct(P[1] + P[2], tot)})   ← reachable straight-line from a base (no shielding needed)`);
                lines.push(`  beyond Tulip range:              ${P[0]} (${pct(P[0], tot)})   ← needs shielding / a new base`);
                lines.push(`Bases: ${r.basesUsed} across ${r.sitesUsed} site(s) fetched${r.sitesNoBase ? ` · ${r.sitesNoBase} site(s) skipped (no base in setup)` : ''} · distance = one-way straight line from the base`);
            } else {
                lines.push(`  ≤${r.b1} ft of target:      ${P[1]} (${pct(P[1], tot)})`);
                lines.push(`  ${r.b1}–${r.b2} ft:            ${P[2]} (${pct(P[2], tot)})`);
                lines.push(`  ≤${r.b2} ft CUMULATIVE:    ${P[1] + P[2]} (${pct(P[1] + P[2], tot)})   ← inspectable from existing coverage`);
                lines.push(`  beyond ${r.b2} ft:          ${P[0]} (${pct(P[0], tot)})   ← needs new site area`);
            }
            if (r.mode === 'bases' && r.perBase && r.perBase.length) {
                lines.push('');
                lines.push('Per base (site | Tattu pts | Tulip-only pts | reachable pts):');
                r.perBase.filter(b => b.pts[1] + b.pts[2] > 0).forEach(b => lines.push(`  ${b.name} (#${b.sid})${b.bases > 1 ? ` ×${b.bases} bases` : ''} | ${b.pts[1]} | ${b.pts[2]} | ${b.pts[1] + b.pts[2]}`));
                const zero = r.perBase.filter(b => b.pts[1] + b.pts[2] === 0).length;
                if (zero) lines.push(`  (+${zero} base(s) with no points in range)`);
            }
            if (r.pointMatches && r.pointMatches.length) {
                lines.push('');
                lines.push(`Points within ≤${r.b2.toLocaleString()} ft (${r.pointMatches.length}${r.pointMatchesCapped ? '+, capped' : ''}) — site | entity | feature | distance | band:`);
                r.pointMatches.slice(0, 500).forEach(m => lines.push(`  ${m.site || '—'} | ${m.etype ? m.etype + ' ' : ''}${m.ename || '—'} | ${m.name || '(unnamed)'} | ${m.ft.toLocaleString()} ft | ${m.band === 1 ? `≤${r.b1.toLocaleString()}` : `≤${r.b2.toLocaleString()}`} @ ${m.lat.toFixed(6)}, ${m.lng.toFixed(6)}`));
                if (r.pointMatches.length > 500) lines.push(`  …${r.pointMatches.length - 500} more (📊 Report → Copy → Sheets has them all)`);
            }
            r.notes.forEach(nn => lines.push(`Note: ${nn}`));
            return lines.join('\n');
        }
        lines.push(`Line length total: ${fmtMi(r.totalM)}`);
        if (r.mode === 'bases') {
            lines.push(`  Tattu range (≤${r.b1.toLocaleString()} ft from a base):   ${fmtMi(L[1])} (${pct(L[1], r.totalM)})`);
            lines.push(`  Tulip only (${r.b1.toLocaleString()}–${r.b2.toLocaleString()} ft):        ${fmtMi(L[2])} (${pct(L[2], r.totalM)})`);
            lines.push(`  ≤${r.b2.toLocaleString()} ft CUMULATIVE:            ${fmtMi(L[1] + L[2])} (${pct(L[1] + L[2], r.totalM)})   ← reachable straight-line from a base (no shielding needed)`);
            lines.push(`  beyond Tulip range:              ${fmtMi(L[0])} (${pct(L[0], r.totalM)})   ← needs shielding / a new base`);
            lines.push(`Bases: ${r.basesUsed} across ${r.sitesUsed} site(s) fetched${r.sitesNoBase ? ` · ${r.sitesNoBase} site(s) skipped (no base in setup)` : ''} · distance = one-way straight line from the base`);
        } else {
            lines.push(`  ≤${r.b1} ft of target:      ${fmtMi(L[1])} (${pct(L[1], r.totalM)})`);
            lines.push(`  ${r.b1}–${r.b2} ft:            ${fmtMi(L[2])} (${pct(L[2], r.totalM)})`);
            lines.push(`  ≤${r.b2} ft CUMULATIVE:    ${fmtMi(L[1] + L[2])} (${pct(L[1] + L[2], r.totalM)})   ← inspectable from existing coverage`);
            lines.push(`  beyond ${r.b2} ft:          ${fmtMi(L[0])} (${pct(L[0], r.totalM)})   ← needs new site area`);
        }
        if (r.mode === 'bases' && r.perBase && r.perBase.length) {
            lines.push('');
            lines.push('Per base (site | Tattu | Tulip-only | reachable total | points Tattu/Tulip):');
            r.perBase.forEach(b => lines.push(`  ${b.name} (#${b.sid})${b.bases > 1 ? ` ×${b.bases} bases` : ''} | ${fmtMi(b.lenM[1])} | ${fmtMi(b.lenM[2])} | ${fmtMi(b.lenM[1] + b.lenM[2])} | ${b.pts[1]}/${b.pts[2]}`));
        }
        if (r.pointsTotal) {
            lines.push('');
            lines.push(`Points: ${r.pointsTotal} total — ≤${r.b1} ft: ${r.pointHits[1]} · ${r.b1}–${r.b2} ft: ${r.pointHits[2]} · beyond: ${r.pointHits[0]}`);
        }
        if (r.pointMatches && r.pointMatches.length) {
            lines.push('');
            lines.push(`Points within ≤${r.b2.toLocaleString()} ft (${r.pointMatches.length}${r.pointMatchesCapped ? '+, capped' : ''}) — site | entity | feature | distance | band:`);
            r.pointMatches.slice(0, 500).forEach(m => lines.push(`  ${m.site || '—'} | ${m.etype ? m.etype + ' ' : ''}${m.ename || '—'} | ${m.name || '(unnamed)'} | ${m.ft.toLocaleString()} ft | ${m.band === 1 ? `≤${r.b1.toLocaleString()}` : `≤${r.b2.toLocaleString()}`} @ ${m.lat.toFixed(6)}, ${m.lng.toFixed(6)}`));
            if (r.pointMatches.length > 500) lines.push(`  …${r.pointMatches.length - 500} more (📊 Report → Copy → Sheets has them all)`);
        }
        if (r.runsTotal) {
        lines.push('');
        lines.push(`Longest stretches (${Math.min(40, r.runsTotal)} of ${r.runsTotal}):`);
        (r.topRuns || r.runs).slice(0, 40).forEach((run, i) => {
            const tag = run.band === 1 ? `≤${r.b1}ft` : (run.band === 2 ? `≤${r.b2}ft` : `>${r.b2}ft`);
            const mid = run.pts[Math.floor(run.pts.length / 2)];
            const near = run.tag ? ` → ${run.tag.site ? run.tag.site + ' · ' : ''}${run.tag.etype ? run.tag.etype + ' ' : ''}${run.tag.ename || ''}` : '';
            lines.push(`  ${i + 1}. [${tag}] ${fmtMi(run.lenM)}${run.featName ? ` — ${run.featName}` : ''}${near} @ ${mid[0].toFixed(6)}, ${mid[1].toFixed(6)}`);
        });
        }
        r.notes.forEach(n => lines.push(`Note: ${n}`));
        return lines.join('\n');
    }


    // ==================================================================
    // 🎥 FLIGHT CHECKS (v0.33, feature #267 fleet scale) — every flown flight
    // of the picked sites (Fleet Data picker) in the last N days, scored
    // against its plan the way AIM Video Validation does on one playback
    // page, minus the flown-track download: the picture record already
    // carries the real pose (position / altitude / heading / camera angle),
    // so a flight costs TWO small reads (mission record with its embedded
    // plan + image list). Each picture is matched to a planned snapshot by
    // pose near its nav ([#267 shared core] — same math as Video Validation's
    // pose fallback). A flown flight never changes → results cache per
    // flight id in GM (script storage for now; data repo later).
    // Views: by flight · by drone (hardware bias → IT) · by mission (build
    // problem → CSM) · by site. Thresholds editable here, persisted in cfg.
    // ==================================================================
    const FC_CORE_VER = 2;   // v2: sequence alignment join (position is an OUTPUT), per-flight S# numbering
    const FC_KEY = 'aim-ft-fc-cache';
    const FC_CAP = 3000;
    const FC_DEF = { hdg: 10, cam: 5, altFt: 25, posFt: 30, days: 7, gateDeg: 20, navFt: 200 };
    if (!ftCfg.fc) ftCfg.fc = {};
    const fcCfg = () => Object.assign({}, FC_DEF, ftCfg.fc);
    let fcCache = loadJson(FC_KEY, null);
    if (!fcCache || fcCache.ver !== FC_CORE_VER || !fcCache.flights) fcCache = { ver: FC_CORE_VER, flights: {} };
    function fcSaveCache() {
        const ids = Object.keys(fcCache.flights);
        if (ids.length > FC_CAP) { ids.sort((a, b) => (fcCache.flights[a].when || '').localeCompare(fcCache.flights[b].when || '')); ids.slice(0, ids.length - FC_CAP).forEach(id => delete fcCache.flights[id]); }
        gmSet(FC_KEY, JSON.stringify(fcCache));
    }
    let fcRun = null;          // { done, total, msg, abort, errors }
    let fcResults = null;      // { at, sites:[ids], days, flights:[result] }
    let fcTab = 'summary';
    let fcOpenFlight = null;
    let fcSortKey = 'flagged';

    const FC_M2FT = 3.28084, FC_RAD = Math.PI / 180;
    function fcDistM(a, b) { if (!a || !b) return null; const dLat = (b.lat - a.lat) * FC_RAD, dLng = (b.lng - a.lng) * FC_RAD; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * FC_RAD) * Math.cos(b.lat * FC_RAD) * Math.sin(dLng / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(x)); }
    function fcBearing(a, b) { const y = Math.sin((b.lng - a.lng) * FC_RAD) * Math.cos(b.lat * FC_RAD); const x = Math.cos(a.lat * FC_RAD) * Math.sin(b.lat * FC_RAD) - Math.sin(a.lat * FC_RAD) * Math.cos(b.lat * FC_RAD) * Math.cos((b.lng - a.lng) * FC_RAD); return (Math.atan2(y, x) / FC_RAD + 360) % 360; }
    function fcHdgDelta(a, b) { if (a == null || b == null) return null; return ((b - a) % 360 + 540) % 360 - 180; }
    function fcCompass(deg) { const p = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']; return p[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]; }
    const fcGimbalDeg = (v) => (typeof v === 'number') ? (v - 2000) / (1000 / 90) : null;   // 2000 = level, 1000 = straight down
    function fcNameTime(name) { const m = String(name || '').match(/(\d{4})_(\d{2})_(\d{2})__(\d{2})_(\d{2})_(\d{2})_(\d)/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7] * 100) : null; }
    // [#267 shared core] planned pose of a snapshot step. Drone altitude = the NAV's value1 (a snapshot's abs_alt is stale).
    function fcPlannedPose(plan, i) {
        const st = plan[i]; let nav = null; for (let k = i - 1; k >= 0; k--) if (plan[k].type_name === 'navigate') { nav = plan[k]; break; }
        if (!nav || !nav.location) return null;
        const alt = typeof nav.value1 === 'number' ? nav.value1 : null;
        if (st.location && typeof st.location.lat === 'number') {
            const h = fcDistM(nav.location, st.location); const aimAlt = typeof st.value1 === 'number' ? st.value1 : null;
            return { gps: true, nav, alt, heading: fcBearing(nav.location, st.location), pitch: (aimAlt != null && alt != null && h > 0.5) ? Math.atan2(aimAlt - alt, h) / FC_RAD : null };
        }
        const e = st.extra_options || {};
        return { gps: false, nav, alt, heading: typeof e.heading === 'number' ? e.heading : null, pitch: fcGimbalDeg(e.pitch) };
    }
    // [#267 shared core] score one flight: plan (sorted instructions) + image records → shots, flags, summary.
    // JOIN = local sequence alignment (Smith–Waterman) of the pictures (time order) against the plan's snapshots
    // (step order). Match cost = how well the picture's heading + camera angle fit the planned pose, with only a
    // WEAK position prior — so a drone 278 ft off station still lands on its own step and the distance is reported,
    // instead of being quietly matched to whatever nav happened to be nearby (the v1 mistake). Gaps = planned
    // snapshots with no picture (missing) or pictures with no step (unplanned); a leftover picture whose pose fits
    // the neighbouring matched step is a re-take.
    function fcScore(plan, images, cfg, meta) {
        const snaps = []; plan.forEach((st, i) => { if (st.type_name === 'snapshot') { const pose = fcPlannedPose(plan, i); if (pose) snaps.push({ st, i, pose }); } });
        const imgs = images.map(im => Object.assign({}, im, { shutter: fcNameTime(im.name) || (im.created_at ? new Date(im.created_at).getTime() : 0), kind: im.type === 'THERMAL' || im.thermal ? 'T' : (im.type === 'GEM' ? 'G' : 'RGB') })).sort((a, b) => a.shutter - b.shutter);
        const shots = []; let cur = null;
        imgs.forEach(im => { if (!cur || Math.abs(im.shutter - cur.shutter) > 1500) { cur = { shutter: im.shutter, images: [], primary: im }; shots.push(cur); } cur.images.push(im); if (im.kind === 'RGB') cur.primary = im; });
        // pose fit of shot a vs planned snapshot b: 0 = perfect; degrees of combined heading + camera error, plus a
        // weak position term (≤ 3 "degrees" at 300 ft) that only breaks ties between look-alike snapshots.
        const fit = (sh, c) => {
            const im = sh.primary; if (!im.location || typeof im.drone_heading !== 'number') return 99;
            const dh = Math.abs(fcHdgDelta(c.pose.heading, im.drone_heading) || 0);
            const dp = (c.pose.pitch != null && typeof im.camera_pitch === 'number') ? Math.abs(im.camera_pitch - c.pose.pitch) : 0;
            const dNav = fcDistM(c.pose.nav.location, im.location); const posTerm = dNav == null ? 3 : Math.min(3, (dNav * FC_M2FT) / 100);
            return dh + dp + posTerm;
        };
        const GATE = Number(cfg.gateDeg) || 20;
        const matchScore = (sh, c) => GATE - fit(sh, c);         // positive = plausible match, negative = not
        const GAP_SNAP = -4, GAP_SHOT = -5;                        // skip a planned snapshot / skip a picture
        const n = shots.length, m = snaps.length;
        const H = []; const T = [];
        for (let i = 0; i <= n; i++) { H.push(new Float64Array(m + 1)); T.push(new Uint8Array(m + 1)); }
        let best = 0, bi = 0, bj = 0;
        for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
            const d = H[i - 1][j - 1] + matchScore(shots[i - 1], snaps[j - 1]);
            const u = H[i - 1][j] + GAP_SHOT, l = H[i][j - 1] + GAP_SNAP;
            let v = 0, t = 0;
            if (d > v) { v = d; t = 1; } if (u > v) { v = u; t = 2; } if (l > v) { v = l; t = 3; }
            H[i][j] = v; T[i][j] = t;
            if (v > best) { best = v; bi = i; bj = j; }
        }
        const assign = new Array(n).fill(null);   // shot index → snap index
        let i = bi, j = bj;
        while (i > 0 && j > 0 && H[i][j] > 0) { const t = T[i][j]; if (t === 1) { assign[i - 1] = j - 1; i--; j--; } else if (t === 2) i--; else j--; }
        // re-takes: an unassigned picture whose pose fits an already-assigned neighbouring step
        const usedSnap = {}; assign.forEach(a => { if (a != null) usedSnap[a] = true; });
        assign.forEach((a, k) => {
            if (a != null) return;
            const cand = [k - 1, k + 1].map(x => assign[x]).filter(x => x != null);
            let pick = null, pf = 8;
            cand.forEach(ci => { const f = fit(shots[k], snaps[ci]); if (f < pf) { pf = f; pick = ci; } });
            if (pick != null) { assign[k] = pick; shots[k].retake = true; }
        });
        const matchedIdx = assign.filter(a => a != null).map(a => snaps[a].st.index_in_app);
        const minIdx = matchedIdx.length ? Math.min.apply(null, matchedIdx) : null, maxIdx = matchedIdx.length ? Math.max.apply(null, matchedIdx) : null;
        // per-flight S# = ordinal among the plan's snapshots inside this flight's slice (matches Video Validation)
        const inSlice = snaps.filter(c => minIdx != null && c.st.index_in_app >= minIdx && c.st.index_in_app <= maxIdx);
        const sNum = {}; inSlice.forEach((c, k) => { sNum[c.st.id] = 'S' + (k + 1); });
        const seen = {}; const rows = [];
        shots.forEach((sh, k) => {
            const im = sh.primary; const flags = []; const a = assign[k];
            const r = { t: new Date(sh.shutter).toISOString(), kinds: sh.images.map(x => x.kind).join('+'), name: im.name, asset: (im.assets || []).map(x => x.name).filter(Boolean).join(', '), flags, hdg: [null, im.drone_heading, null], cam: [null, im.camera_pitch, null], alt: [null, typeof im.alt === 'number' ? im.alt * FC_M2FT : null, null], pos: null, dir: '' };
            if (a != null) {
                const c = snaps[a], p = c.pose; r.s = sNum[c.st.id] || 'S?'; r.idx = c.st.index_in_app; r.stepId = c.st.id;
                r.hdg = [p.heading, im.drone_heading, fcHdgDelta(p.heading, im.drone_heading)];
                r.cam = [p.pitch, im.camera_pitch, (p.pitch != null && typeof im.camera_pitch === 'number') ? im.camera_pitch - p.pitch : null];
                r.alt = [p.alt != null ? p.alt * FC_M2FT : null, typeof im.alt === 'number' ? im.alt * FC_M2FT : null, (p.alt != null && typeof im.alt === 'number') ? (im.alt - p.alt) * FC_M2FT : null];
                const dNav = im.location ? fcDistM(p.nav.location, im.location) : null; r.pos = dNav != null ? dNav * FC_M2FT : null; r.dir = (r.pos != null && r.pos >= 3) ? fcCompass(fcBearing(p.nav.location, im.location)) : '';
                if (sh.retake || seen[c.st.id]) flags.push('re-take'); seen[c.st.id] = (seen[c.st.id] || 0) + 1;
                if (r.hdg[2] != null && Math.abs(r.hdg[2]) > cfg.hdg) flags.push('heading ' + (r.hdg[2] > 0 ? '+' : '') + r.hdg[2].toFixed(0) + '°');
                if (r.cam[2] != null && Math.abs(r.cam[2]) > cfg.cam) flags.push('camera ' + (r.cam[2] > 0 ? '+' : '') + r.cam[2].toFixed(0) + '°');
                if (r.alt[2] != null && Math.abs(r.alt[2]) > cfg.altFt) flags.push('altitude ' + (r.alt[2] > 0 ? '+' : '') + r.alt[2].toFixed(0) + ' ft');
                if (r.pos != null && r.pos > cfg.posFt) flags.push('off station ' + r.pos.toFixed(0) + ' ft ' + r.dir);
            } else { r.s = '?'; flags.push('unplanned shot (fits no planned snapshot in sequence)'); }
            rows.push(r);
        });
        const missing = inSlice.filter(c => !seen[c.st.id]).map(c => sNum[c.st.id]);
        const mean = (arr) => { const v = arr.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
        const matched = rows.filter(r => r.stepId != null);
        return Object.assign({}, meta, {
            coreVer: FC_CORE_VER, at: Date.now(), shots: rows.length, flagged: rows.filter(r => r.flags.length).length, retakes: rows.filter(r => r.flags.includes('re-take')).length, unplanned: rows.filter(r => r.s === '?').length,
            missing, slice: minIdx != null ? [minIdx, maxIdx] : null, planSteps: plan.length, planSnaps: snaps.length, flightSnaps: inSlice.length, alignScore: best,
            dHdg: mean(matched.map(r => Math.abs(r.hdg[2]))), dCam: mean(matched.map(r => Math.abs(r.cam[2]))), dAlt: mean(matched.map(r => r.alt[2])), dPos: mean(matched.map(r => r.pos)),
            rows,
        });
    }
    async function fcFetchLog(sid, start, end, isAborted) {
        const all = []; let total = null; let lastId = -1; let pages = 0;
        for (;;) {
            if (isAborted && isAborted()) throw new Error('aborted');
            if (++pages > 200) break;
            const params = { site_id: Number(sid), drones: [], missionTypes: [], missionId: [], users: [], state: null, takeoffCompleted: false, start: fdYmd(start), end: fdYmd(end), last_mission_id: lastId };
            const j = await fdGetJson(`/missions/?site_id=${encodeURIComponent(sid)}&params=${encodeURIComponent(JSON.stringify(params))}&only=${encodeURIComponent(FD_LOG_ONLY)}`, 40000);
            const past = (j && j.past_missions) || [];
            if (total == null && typeof j.total_mission_count === 'number') total = j.total_mission_count;
            all.push(...past);
            const lastMid = past.length ? past[past.length - 1].id : null;
            const more = past.length > 0 && (total == null || all.length < total) && lastMid != null && lastMid !== lastId;
            if (!more) break;
            lastId = lastMid;
        }
        return all;
    }
    async function fcFetchImages(sid, mid) {
        let url = `/images/?site=${encodeURIComponent(sid)}&mission=${encodeURIComponent(mid)}&limit=100&offset=0`; const out = []; let guard = 0;
        while (url && ++guard < 20) { const j = await fdGetJson(url, 40000); const res = (j && j.results) || (Array.isArray(j) ? j : []); out.push(...res); url = j && j.next ? String(j.next).replace(/^https?:\/\/[^/]+/, '') : null; }
        return out;
    }
    async function fcCheckFlight(sid, row, cfg) {
        const mid = row.id;
        const cached = fcCache.flights[mid];
        if (cached && cached.coreVer === FC_CORE_VER) return cached;
        const [mission, images] = await Promise.all([fdGetJson(`/missions/${encodeURIComponent(mid)}/`, 40000), fcFetchImages(sid, mid)]);
        const plan = (mission.app && Array.isArray(mission.app.instructions)) ? mission.app.instructions.slice().sort((a, b) => a.index_in_app - b.index_in_app) : [];
        const res = fcScore(plan, images, cfg, { mid, sid: String(sid), site: siteName(String(sid)) || String(sid), name: mission.name || mission.app_name || row.app_name || '', drone: mission.drone_name || row.drone_name || '', droneType: mission.drone && mission.drone.robot_type_name, when: mission.when || row.when, group: mission.mission_group_id, appId: mission.app && mission.app.id });
        fcCache.flights[mid] = res;
        return res;
    }
    async function runFlightChecks() {
        if (fcRun) return;
        const cfg = fcCfg();
        const sites = Array.from(fdSelected); fdNotePick();
        if (!sites.length) { setStatus('Flight checks: pick sites in 📦 Fleet Data first (or Select all there)'); openSections.data = true; renderPanel(); return; }
        const end = new Date(); const start = new Date(); start.setDate(start.getDate() - (Number(cfg.days) || 7));
        fcRun = { done: 0, total: 0, msg: 'listing flights…', abort: false, errors: [] };
        openSections.fc = true; renderPanel();
        const isAborted = () => fcRun && fcRun.abort;
        const flights = [];
        try {
            for (const sid of sites) {
                if (isAborted()) break;
                fcRun.msg = `listing flights · ${siteName(sid) || sid}`; renderPanel();
                try { const rows = await fcFetchLog(sid, start, end, isAborted); rows.forEach(r => { if ((r.image_count || 0) > 0) flights.push({ sid, row: r }); }); }
                catch (e) { if (String(e.message).includes('aborted')) break; fcRun.errors.push(`${siteName(sid) || sid}: log ${e.message}`); }
            }
            fcRun.total = flights.length;
            const results = []; let cachedHits = 0;
            const queue = flights.slice(); const workers = [];
            const work = async () => {
                while (queue.length && !isAborted()) {
                    const f = queue.shift();
                    try { const had = !!(fcCache.flights[f.row.id] && fcCache.flights[f.row.id].coreVer === FC_CORE_VER); const res = await fcCheckFlight(f.sid, f.row, cfg); if (had) cachedHits++; results.push(res); }
                    catch (e) { fcRun.errors.push(`${f.row.id}: ${e.message}`); }
                    fcRun.done++; fcRun.msg = `checking flights · ${fcRun.done}/${fcRun.total}`;
                    if (fcRun.done % 5 === 0) { fcSaveCache(); renderPanel(); }
                }
            };
            for (let i = 0; i < 3; i++) workers.push(work());
            await Promise.all(workers);
            fcSaveCache();
            results.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
            fcResults = { at: Date.now(), sites, days: cfg.days, flights: results, cachedHits, aborted: isAborted(), errors: fcRun.errors };
            setStatus(`Flight checks: ${results.length} flight(s) across ${sites.length} site(s), last ${cfg.days} d · ${cachedHits} from cache${fcRun.errors.length ? ` · ${fcRun.errors.length} error(s)` : ''}${isAborted() ? ' · aborted' : ''}`);
        } catch (e) { console.error(`${TAG} flight checks failed`, e); setStatus('Flight checks failed: ' + e.message); }
        fcRun = null; renderPanel();
    }
    // ---- aggregation ----
    function fcAgg(keyFn, labelFn) {
        const g = {};
        (fcResults ? fcResults.flights : []).forEach(f => {
            const k = keyFn(f); if (!g[k]) g[k] = { key: k, label: labelFn(f), flights: 0, shots: 0, flagged: 0, retakes: 0, missing: 0, unplanned: 0, hdg: [], cam: [], alt: [], pos: [] };
            const a = g[k]; a.flights++; a.shots += f.shots; a.flagged += f.flagged; a.retakes += f.retakes; a.missing += (f.missing || []).length; a.unplanned += f.unplanned || 0;
            f.rows.forEach(r => { if (r.stepId == null) return; if (r.hdg[2] != null) a.hdg.push(Math.abs(r.hdg[2])); if (r.cam[2] != null) a.cam.push(Math.abs(r.cam[2])); if (r.alt[2] != null) a.alt.push(r.alt[2]); if (r.pos != null) a.pos.push(r.pos); });
        });
        const mean = (v) => v.length ? v.reduce((x, y) => x + y, 0) / v.length : null;
        return Object.values(g).map(a => Object.assign(a, { dHdg: mean(a.hdg), dCam: mean(a.cam), dAlt: mean(a.alt), dPos: mean(a.pos), pct: a.shots ? (100 * (a.shots - a.flagged) / a.shots) : null })).sort((x, y) => (y.flagged / Math.max(1, y.shots)) - (x.flagged / Math.max(1, x.shots)));
    }
    // ---- one-page SUMMARY: only what matters, in words ----
    function fcMajorIssues() {
        const cfg = fcCfg(); const F = fcResults ? fcResults.flights : [];
        const out = [];
        F.forEach(f => {
            if (!f.shots) return;
            const reasons = []; let sev = 0;
            const share = f.flagged / f.shots;
            const off = f.rows.filter(r => r.flags.some(x => x.startsWith('off station')));
            if (off.length >= Math.max(2, f.shots * 0.25)) { const dirs = {}; off.forEach(r => { dirs[r.dir] = (dirs[r.dir] || 0) + 1; }); const dir = Object.keys(dirs).sort((a, b) => dirs[b] - dirs[a])[0]; const mean = off.reduce((n, r) => n + r.pos, 0) / off.length; reasons.push(`${off.length} of ${f.shots} shots off station (~${mean.toFixed(0)} ft ${dir || ''}) — drone position, not the plan`); sev += 3 + share * 3; }
            const hdg = f.rows.filter(r => r.flags.some(x => x.startsWith('heading'))); if (hdg.length >= 2) { reasons.push(`${hdg.length} shots heading off by >${cfg.hdg}°`); sev += 2; }
            const cam = f.rows.filter(r => r.flags.some(x => x.startsWith('camera'))); if (cam.length >= 2) { reasons.push(`${cam.length} shots camera angle off by >${cfg.cam}°`); sev += 2; }
            const alt = f.rows.filter(r => r.flags.some(x => x.startsWith('altitude'))); if (alt.length >= 2) { const mean = alt.reduce((n, r) => n + r.alt[2], 0) / alt.length; reasons.push(`${alt.length} shots flown ${mean > 0 ? 'high' : 'low'} by ~${Math.abs(mean).toFixed(0)} ft`); sev += 2; }
            if ((f.missing || []).length >= 2) { reasons.push(`${f.missing.length} planned snapshots produced no picture (${f.missing.slice(0, 6).join(', ')}${f.missing.length > 6 ? '…' : ''})`); sev += 2 + Math.min(3, f.missing.length / 2); }
            if (f.retakes >= 2) { reasons.push(`${f.retakes} re-takes`); sev += 1.5; }
            if ((f.unplanned || 0) >= 3) { reasons.push(`${f.unplanned} pictures match no planned snapshot (pilot / manual?)`); sev += 1; }
            if (!reasons.length && share >= 0.5 && f.flagged >= 3) { reasons.push(`${f.flagged} of ${f.shots} shots outside limits`); sev += 2; }
            if (reasons.length) out.push({ f, sev, text: reasons.join(' · ') });
        });
        out.sort((a, b) => b.sev - a.sev);
        // drone bias: mean off-station or altitude bias across ≥ 2 flights
        const drones = fcAgg(f => f.drone || '?', f => f.drone || '?').filter(a => a.flights >= 2 && ((a.dPos != null && a.dPos > cfg.posFt) || (a.dAlt != null && Math.abs(a.dAlt) > cfg.altFt) || a.pct < 75)).map(a => ({ label: a.label, text: [a.dPos != null && a.dPos > cfg.posFt ? `mean off-station ${a.dPos.toFixed(0)} ft across ${a.flights} flights — position / RTK?` : null, a.dAlt != null && Math.abs(a.dAlt) > cfg.altFt ? `flies ${a.dAlt > 0 ? 'high' : 'low'} by ~${Math.abs(a.dAlt).toFixed(0)} ft on average — altitude source?` : null, a.pct < 75 ? `only ${a.pct.toFixed(0)}% of shots within limits` : null].filter(Boolean).join(' · ') }));
        const missions = fcAgg(f => f.sid + '|' + f.name, f => f.name).filter(a => a.flights >= 2 && a.pct < 75).map(a => { const dr = new Set(F.filter(f => f.sid + '|' + f.name === a.key).map(f => f.drone)); return { label: a.label, text: `${a.pct.toFixed(0)}% within limits over ${a.flights} flights${dr.size > 1 ? ' on ' + dr.size + ' drones — plan problem, not a drone' : ''}` }; });
        return { flights: out, drones, missions };
    }
    function fcFlagWords(r) {
        return r.flags.map(f => {
            if (f.startsWith('off station')) return 'drone ' + f.replace('off station ', '') + ' from its nav';
            if (f.startsWith('heading')) return 'heading ' + f.replace('heading ', '') + ' off';
            if (f.startsWith('camera')) return 'camera ' + f.replace('camera ', '') + ' off';
            if (f.startsWith('altitude')) return 'flew ' + f.replace('altitude ', '');
            if (f === 're-take') return 're-take';
            if (f.startsWith('unplanned')) return 'no planned snapshot matches';
            return f;
        }).join(' · ');
    }
    function fcFlagRows() {
        const F = fcResults ? fcResults.flights : []; const rows = [];
        F.forEach(f => {
            const day = f.when ? new Date(f.when).toLocaleDateString() : '';
            f.rows.forEach(r => { if (!r.flags.length) return; rows.push({ f, r, cells: [f.mid, f.name, f.drone, day, r.s + (r.idx != null ? ' (#' + r.idx + ')' : ''), r.asset || '', fcFlagWords(r), fcPlaybackUrl(f)] }); });
            (f.missing || []).forEach(sn => rows.push({ f, r: null, cells: [f.mid, f.name, f.drone, day, sn, '', 'planned snapshot — no picture taken', fcPlaybackUrl(f)] }));
        });
        return rows;
    }
    function fcSummaryRows() {
        const R = fcResults; if (!R) return { cols: [], rows: [], bold: [] };
        const cfg = fcCfg(); const shots = R.flights.reduce((n, f) => n + f.shots, 0), flagged = R.flights.reduce((n, f) => n + f.flagged, 0);
        const fr = fcFlagRows();
        const rows = [], bold = [];
        rows.push([`${R.flights.length} flights · ${shots} shots · ${shots ? Math.round(100 * (shots - flagged) / shots) : 0}% within limits · ${flagged} flagged · ${R.flights.reduce((n, f) => n + f.retakes, 0)} re-takes · ${R.flights.reduce((n, f) => n + (f.missing || []).length, 0)} no picture`, R.sites.map(id => siteName(String(id)) || id).join(', '), `last ${cfg.days} days`, new Date(R.at).toLocaleString(), '', '', `limits: heading ${cfg.hdg}° · camera ${cfg.cam}° · altitude ${cfg.altFt} ft · off-station ${cfg.posFt} ft`, '']); bold.push(true);
        rows.push(['flight', 'mission', 'drone', 'date', 'shot', 'asset', 'issue', 'playback']); bold.push(true);
        fr.forEach(x => { rows.push(x.cells); bold.push(false); });
        if (!fr.length) { rows.push(['', '', '', '', '', '', 'no flagged shots', '']); bold.push(false); }
        return { cols: ['', '', '', '', '', '', '', ''], rows, bold };
    }
    function fcSummaryRowsNarrative() {
        const R = fcResults; if (!R) return { cols: [], rows: [], bold: [] };
        const cfg = fcCfg(); const shots = R.flights.reduce((n, f) => n + f.shots, 0), flagged = R.flights.reduce((n, f) => n + f.flagged, 0);
        const S = fcMajorIssues();
        const rows = [], bold = [];
        const push = (r, b) => { rows.push(r); bold.push(!!b); };
        push(['Flight check summary', R.sites.map(id => siteName(String(id)) || id).join(', '), 'last ' + cfg.days + ' days', new Date(R.at).toLocaleString()], true);
        push(['flights', R.flights.length, 'shots', shots]); push(['within limits', shots ? Math.round(100 * (shots - flagged) / shots) + '%' : '', 'flagged shots', flagged]);
        push(['re-takes', R.flights.reduce((n, f) => n + f.retakes, 0), 'no picture', R.flights.reduce((n, f) => n + (f.missing || []).length, 0)]);
        push(['thresholds', `heading ${cfg.hdg}° · camera ${cfg.cam}° · altitude ${cfg.altFt} ft · off-station ${cfg.posFt} ft`, '', '']);
        push(['', '', '', '']);
        push(['MAJOR ISSUES — flights', '', '', ''], true);
        push(['flight · mission', 'drone · when', 'what is wrong', 'playback'], true);
        if (!S.flights.length) push(['none', 'every flight within limits', '', '']);
        S.flights.slice(0, 25).forEach(x => push([`${x.f.mid} · ${x.f.name}`, `${x.f.drone} · ${x.f.when ? new Date(x.f.when).toLocaleString() : ''}`, x.text, fcPlaybackUrl(x.f)]));
        if (S.flights.length > 25) push([`… ${S.flights.length - 25} more`, '', 'see the flights view', '']);
        if (S.drones.length) { push(['', '', '', '']); push(['DRONES WITH A PATTERN (hardware / position / altitude — for IT)', '', '', ''], true); S.drones.forEach(d => push([d.label, '', d.text, ''])); }
        if (S.missions.length) { push(['', '', '', '']); push(['MISSIONS WITH A PATTERN (build — for the CSM)', '', '', ''], true); S.missions.forEach(m => push([m.label, '', m.text, ''])); }
        return { cols: ['', '', '', ''], rows, bold };
    }
    function fcCopySummary() { const t = fcSummaryRows(); fcCopySheets2(t.cols, t.rows, 'flight-check summary (' + t.rows.length + ' rows)', t.bold); }
    function renderFcSummary() {
        const fr = fcFlagRows(); const esc = escapeHtml; const cfgT = fcCfg();
        const cell = (v, extra) => `<td style="padding:2px 6px;border-bottom:1px solid #1e2430;${extra || ''}">${esc(String(v == null ? '' : v))}</td>`;
        let h = '<div style="overflow:auto;max-height:46vh"><table style="border-collapse:collapse;font:11px/1.4 monospace;width:100%"><tr style="color:#7adfe6">' + ['flight', 'mission', 'drone', 'date', 'shot', 'asset', 'issue'].map(c => `<th style="text-align:left;padding:2px 6px;position:sticky;top:0;background:#14181f">${c}</th>`).join('') + '</tr>';
        if (!fr.length) h += '<tr><td colspan="7" style="padding:6px;color:#5fff5f">no flagged shots</td></tr>';
        fr.forEach(x => { h += `<tr class="aim-ft-row"><td style="padding:2px 6px;border-bottom:1px solid #1e2430;white-space:nowrap"><a href="${fcPlaybackUrl(x.f)}" target="_blank" rel="noopener" style="color:#7adfe6">${esc(String(x.f.mid))}</a></td>${cell(x.cells[1], 'white-space:nowrap')}${cell(x.cells[2], 'white-space:nowrap')}${cell(x.cells[3], 'white-space:nowrap')}${cell(x.cells[4], 'white-space:nowrap')}${cell(x.cells[5], 'white-space:nowrap')}${cell(x.cells[6], 'color:' + (x.r ? '#ffb347' : '#ff7a7a'))}</tr>`; });
        h += '</table></div>';
        const S = fcMajorIssues();
        if (S.drones.length || S.missions.length) {
            h += '<div style="padding:6px 10px;border-top:1px solid #222834">';
            S.drones.forEach(d => { h += `<div><b>${esc(d.label)}</b> <span style="color:#ffb347">${esc(d.text)}</span></div>`; });
            S.missions.forEach(m => { h += `<div><b>${esc(m.label)}</b> <span style="color:#ffb347">${esc(m.text)}</span></div>`; });
            h += '</div>';
        }
        return h;
    }
    function renderFcSummaryNarrative() {
        const S = fcMajorIssues(); const esc = escapeHtml;
        let h = '<div style="padding:6px 10px">';
        h += '<div style="color:#7adfe6;font-weight:bold;margin-bottom:4px">Major issues — flights</div>';
        if (!S.flights.length) h += '<div style="color:#5fff5f">none — every flight within limits</div>';
        S.flights.slice(0, 25).forEach(x => { h += `<div class="aim-ft-row" style="padding:3px 0;border-bottom:1px solid #1e2430"><a href="${fcPlaybackUrl(x.f)}" target="_blank" rel="noopener" style="color:#7adfe6">${esc(String(x.f.mid))}</a> <b>${esc(x.f.name)}</b> <span style="color:#888">· ${esc(x.f.drone)} · ${x.f.when ? esc(new Date(x.f.when).toLocaleString()) : ''}</span><div style="color:#ffb347;padding-left:14px">${esc(x.text)}</div></div>`; });
        if (S.flights.length > 25) h += `<div style="color:#666">… ${S.flights.length - 25} more in the flights view</div>`;
        if (S.drones.length) { h += '<div style="color:#7adfe6;font-weight:bold;margin:8px 0 4px">Drones with a pattern <span style="color:#888;font-weight:normal">(for IT)</span></div>'; S.drones.forEach(d => { h += `<div style="padding:2px 0"><b>${esc(d.label)}</b> <span style="color:#ffb347">${esc(d.text)}</span></div>`; }); }
        if (S.missions.length) { h += '<div style="color:#7adfe6;font-weight:bold;margin:8px 0 4px">Missions with a pattern <span style="color:#888;font-weight:normal">(for the CSM)</span></div>'; S.missions.forEach(m => { h += `<div style="padding:2px 0"><b>${esc(m.label)}</b> <span style="color:#ffb347">${esc(m.text)}</span></div>`; }); }
        return h + '</div>';
    }
    const fcN = (v, d, unit) => v == null || !isFinite(v) ? '–' : (+v).toFixed(d == null ? 0 : d) + (unit || '');
    const fcS = (v, d, unit) => v == null || !isFinite(v) ? '–' : ((v > 0 ? '+' : '') + (+v).toFixed(d == null ? 0 : d) + (unit || ''));
    const fcColor = (v, thr) => v == null || !isFinite(v) ? '#888' : (Math.abs(v) > 2 * thr ? '#ff5f5f' : Math.abs(v) > thr ? '#ffb347' : '#5fff5f');
    function fcPlaybackUrl(f) { return `${location.origin}/#/site/${f.sid}/control-panel/past-mission/${f.mid}`; }
    function fcTable() {
        const cfg = fcCfg();
        if (fcTab === 'drones') return { cols: ['drone', 'flights', 'shots', 'within limits', 'flagged', 're-takes', 'no picture', 'unplanned', 'mean |Δhdg|', 'mean |Δcam|', 'mean Δalt (bias)', 'mean off-station'], rows: fcAgg(f => f.drone || '?', f => (f.drone || '?') + (f.droneType ? ' (' + f.droneType + ')' : '')).map(a => [a.label, a.flights, a.shots, fcN(a.pct, 0, '%'), a.flagged, a.retakes, a.missing, a.unplanned, fcN(a.dHdg, 1, '°'), fcN(a.dCam, 1, '°'), fcS(a.dAlt, 0, ' ft'), fcN(a.dPos, 0, ' ft')]) };
        if (fcTab === 'missions') return { cols: ['mission', 'site', 'flights', 'shots', 'within limits', 'flagged', 're-takes', 'no picture', 'unplanned', 'mean |Δhdg|', 'mean |Δcam|', 'mean Δalt', 'mean off-station'], rows: fcAgg(f => f.sid + '|' + f.name, f => f.name).map(a => { const f0 = fcResults.flights.find(f => f.sid + '|' + f.name === a.key); return [a.label, f0 ? f0.site : '', a.flights, a.shots, fcN(a.pct, 0, '%'), a.flagged, a.retakes, a.missing, a.unplanned, fcN(a.dHdg, 1, '°'), fcN(a.dCam, 1, '°'), fcS(a.dAlt, 0, ' ft'), fcN(a.dPos, 0, ' ft')]; }) };
        if (fcTab === 'sites') return { cols: ['site', 'flights', 'shots', 'within limits', 'flagged', 're-takes', 'no picture', 'unplanned', 'mean |Δhdg|', 'mean |Δcam|', 'mean Δalt', 'mean off-station'], rows: fcAgg(f => f.sid, f => f.site).map(a => [a.label, a.flights, a.shots, fcN(a.pct, 0, '%'), a.flagged, a.retakes, a.missing, a.unplanned, fcN(a.dHdg, 1, '°'), fcN(a.dCam, 1, '°'), fcS(a.dAlt, 0, ' ft'), fcN(a.dPos, 0, ' ft')]) };
        const fl = (fcResults ? fcResults.flights : []).slice().sort((a, b) => fcSortKey === 'when' ? String(b.when || '').localeCompare(String(a.when || '')) : (b.flagged / Math.max(1, b.shots)) - (a.flagged / Math.max(1, a.shots)) || b.flagged - a.flagged);
        return { cols: ['flight', 'mission', 'site', 'drone', 'when', 'shots', 'flagged', 're-takes', 'no picture', 'unplanned', 'mean |Δhdg|', 'mean |Δcam|', 'mean Δalt', 'mean off-station', 'playback'], rows: fl.map(f => [f.mid, f.name, f.site, f.drone, f.when ? new Date(f.when).toLocaleString() : '', f.shots, f.flagged, f.retakes, (f.missing || []).length, f.unplanned || 0, fcN(f.dHdg, 1, '°'), fcN(f.dCam, 1, '°'), fcS(f.dAlt, 0, ' ft'), fcN(f.dPos, 0, ' ft'), fcPlaybackUrl(f)]), flights: fl };
    }
    // Copy for Google Sheets / Excel: an HTML table (pastes into cells, header kept) + a tab-separated plain-text fallback.
    function fcCopySheets(cols, rows, label) {
        const esc = (v) => escapeHtml(String(v == null ? '' : v));
        const html = '<table><thead><tr>' + cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(v => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
        const tsv = [cols.join('\t')].concat(rows.map(r => r.map(v => String(v == null ? '' : v).replace(/[\t\n\r]+/g, ' ')).join('\t'))).join('\n');
        const done = () => setStatus(label + ' copied — paste into Sheets (Ctrl+V)');
        try {
            const CI = window.ClipboardItem;
            if (CI && navigator.clipboard && navigator.clipboard.write) {
                navigator.clipboard.write([new CI({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([tsv], { type: 'text/plain' }) })]).then(done).catch(e => { console.warn(`${TAG} rich copy failed, falling back to text:`, e); copyText(tsv, label + ' copied (tab-separated)'); });
                return;
            }
        } catch (e) { console.warn(`${TAG} rich copy unavailable:`, e); }
        copyText(tsv, label + ' copied (tab-separated)');
    }
    // Sheets-safe number: a plain number (never "+1 ft" — Sheets reads a leading + as a formula), '' when unknown.
    const fcNum = (v, d) => (v == null || !isFinite(v)) ? '' : +(+v).toFixed(d == null ? 0 : d);
    function fcCopySheets2(cols, rows, label, boldRows) {
        // like fcCopySheets but with optional bold rows (flight summary rows) — Sheets keeps <b>.
        const esc = (v) => escapeHtml(String(v == null ? '' : v));
        const html = '<table><thead><tr>' + cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((r, i) => '<tr>' + r.map(v => '<td>' + (boldRows && boldRows[i] ? '<b>' + esc(v) + '</b>' : esc(v)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
        const tsv = [cols.join('\t')].concat(rows.map(r => r.map(v => String(v == null ? '' : v).replace(/[\t\n\r]+/g, ' ')).join('\t'))).join('\n');
        const done = () => setStatus(label + ' copied — paste into Sheets (Ctrl+V)');
        try {
            const CI = window.ClipboardItem;
            if (CI && navigator.clipboard && navigator.clipboard.write) { navigator.clipboard.write([new CI({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([tsv], { type: 'text/plain' }) })]).then(done).catch(e => { console.warn(`${TAG} rich copy failed:`, e); copyText(tsv, label + ' copied (tab-separated)'); }); return; }
        } catch (e) { console.warn(`${TAG} rich copy unavailable:`, e); }
        copyText(tsv, label + ' copied (tab-separated)');
    }
    function fcCopyView() {
        if (fcTab === 'summary') { fcCopySummary(); return; }
        if (fcTab !== 'flights') {
            // aggregate views: same columns, numbers as numbers
            const t = fcTable();
            const rows = t.rows.map(r => r.map(v => { const m = typeof v === 'string' && v.match(/^([+-]?\d+(?:\.\d+)?)\s*(%|°|ft)?$/); return m ? +m[1] : (v === '–' ? '' : v); }));
            const cols = t.cols.map(c => c.replace(/mean \|Δhdg\|/, 'mean |Δ heading| (°)').replace(/mean \|Δcam\|/, 'mean |Δ camera| (°)').replace(/mean Δalt( \(bias\))?/, 'mean Δ alt (ft, signed)').replace(/mean off-station/, 'mean off-station (ft)').replace(/within limits/, 'within limits (%)'));
            fcCopySheets2(cols, rows, 'flight-check by ' + fcTab.replace(/s$/, ''));
            return;
        }
        // flights view: a bold FLIGHT row (counts + means) followed by its shots, flight columns repeated on every row.
        const cols = ['row', 'flight', 'mission', 'site', 'drone', 'when', 'shot', 'step', 'shutter', 'kinds', 'asset', 'planned heading (°)', 'actual heading (°)', 'Δ heading (°)', 'planned camera (°)', 'actual camera (°)', 'Δ camera (°)', 'planned alt (ft)', 'actual alt (ft)', 'Δ alt (ft)', 'drone vs nav (ft)', 'direction', 'flags', 'playback'];
        const rows = [], bold = [];
        const t = fcTable();
        t.flights.forEach(f => {
            rows.push(['FLIGHT', f.mid, f.name, f.site, f.drone, f.when ? new Date(f.when).toLocaleString() : '', f.shots + ' shots', f.flagged + ' flagged', f.retakes + ' re-takes', (f.missing || []).length + ' no picture', (f.unplanned || 0) + ' unplanned', '', '', fcNum(f.dHdg, 1), '', '', fcNum(f.dCam, 1), '', '', fcNum(f.dAlt, 0), fcNum(f.dPos, 0), 'means →', (f.missing && f.missing.length) ? 'no picture: ' + f.missing.join(', ') : '', fcPlaybackUrl(f)]);
            bold.push(true);
            f.rows.forEach(r => { rows.push(['shot', f.mid, f.name, f.site, f.drone, f.when ? new Date(f.when).toLocaleString() : '', r.s, r.idx != null ? r.idx : '', new Date(r.t).toLocaleString(), r.kinds, r.asset || '', fcNum(r.hdg[0]), fcNum(r.hdg[1]), fcNum(r.hdg[2]), fcNum(r.cam[0]), fcNum(r.cam[1]), fcNum(r.cam[2]), fcNum(r.alt[0]), fcNum(r.alt[1]), fcNum(r.alt[2]), fcNum(r.pos), r.dir || '', r.flags.join('; ') || 'ok', fcPlaybackUrl(f)]); bold.push(false); });
        });
        fcCopySheets2(cols, rows, 'flights + shots (' + t.flights.length + ' flights, ' + (rows.length - t.flights.length) + ' shots)', bold);
    }
    function fcCopyAllShots() {
        const cols = ['flight', 'mission', 'site', 'drone', 'when', 'shot', 'step', 'shutter', 'kinds', 'asset', 'planned heading', 'actual heading', 'Δ heading', 'planned camera', 'actual camera', 'Δ camera', 'planned alt ft', 'actual alt ft', 'Δ alt ft', 'drone vs nav ft', 'direction', 'flags', 'image', 'playback'];
        const n = fcNum;
        const rows = [];
        (fcResults ? fcResults.flights : []).forEach(f => f.rows.forEach(r => rows.push([f.mid, f.name, f.site, f.drone, f.when ? new Date(f.when).toLocaleString() : '', r.s, r.idx != null ? r.idx : '', new Date(r.t).toLocaleString(), r.kinds, r.asset || '', n(r.hdg[0]), n(r.hdg[1]), n(r.hdg[2]), n(r.cam[0]), n(r.cam[1]), n(r.cam[2]), n(r.alt[0]), n(r.alt[1]), n(r.alt[2]), n(r.pos), r.dir || '', r.flags.join('; ') || 'ok', r.name || '', fcPlaybackUrl(f)])));
        fcCopySheets2(cols, rows, 'all shots flat (' + rows.length + ' rows)');
    }
    function fcJira() { if (fcTab === 'summary') { const t = fcSummaryRows(); return t.rows.map((r, i) => (t.bold[i] ? '*' : '') + r.filter(x => x !== '').join(' · ') + (t.bold[i] ? '*' : '')).join('\n'); } const t = fcTable(); return ['||' + t.cols.join('||') + '||'].concat(t.rows.map(r => '|' + r.map(x => String(x == null ? '' : x).replace(/\|/g, '/')).join('|') + '|')).join('\n'); }
    function renderFcSection() {
        if (!openSections.fc) return '';
        const cfg = fcCfg();
        const inp = (k, label, unit, w) => `<label style="margin-right:10px;color:#aaa">${label} <input type="number" data-fc-thr="${k}" value="${cfg[k]}" min="0" step="1" style="width:${w || 52}px;background:#0f1216;color:#ddd;border:1px solid #444;border-radius:3px;padding:1px 4px;font:inherit"> ${unit}</label>`;
        let h = '<div style="padding:8px 10px;border-bottom:1px solid #222834">'
            + `<div style="color:#888;margin-bottom:6px">Scope = the sites picked in 📦 Fleet Data (<b style="color:#ddd">${fdSelected.size}</b> picked) · flights with pictures in the last ${inp('days', '', 'days', 44)}</div>`
            + '<div style="margin-bottom:6px">Flag a shot when: ' + inp('hdg', 'heading >', '°') + inp('cam', 'camera >', '°') + inp('altFt', 'altitude >', 'ft') + inp('posFt', 'off-station >', 'ft') + '</div>'
            + '<div style="color:#666;margin-bottom:6px">pictures are aligned to the plan\'s snapshot sequence by heading + camera angle; a match needs a pose fit within ' + inp('gateDeg', '', '° (heading + camera, plus ≤3 for position)', 44) + ' — position is measured, never assumed</div>'
            + (fcRun
                ? `<span style="color:#7adfe6">${fcRun.msg}</span> <span data-ft="fc-abort" style="cursor:pointer;color:#ff7a7a;margin-left:10px">✕ abort</span>${fcRun.total ? `<div style="height:5px;background:#222834;border-radius:3px;margin-top:6px"><div style="height:5px;width:${Math.round(100 * fcRun.done / Math.max(1, fcRun.total))}%;background:#7adfe6;border-radius:3px"></div></div>` : ''}`
                : `<span data-ft="fc-run" style="cursor:pointer;color:#7adfe6;border:1px solid #2a3140;padding:2px 8px;border-radius:3px">▶ Check flights</span>`
                  + ` <span data-ft="fc-clear" style="cursor:pointer;color:#888;margin-left:10px" title="forget cached per-flight results (${Object.keys(fcCache.flights).length})">🗑 clear cache (${Object.keys(fcCache.flights).length})</span>`)
            + '</div>';
        if (!fcResults) return h + '<div style="padding:8px 10px;color:#666">No run yet. Pick sites in Fleet Data, set the window, then ▶ Check flights. A flown flight never changes, so each flight is scored once and cached; later runs only fetch new flights.</div>';
        const R = fcResults; const shots = R.flights.reduce((n, f) => n + f.shots, 0), flagged = R.flights.reduce((n, f) => n + f.flagged, 0);
        const chip = (v, l, c) => `<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 9px;border:1px solid ${c || '#2a3140'};border-radius:5px"><b style="color:${c || '#ddd'};font-size:14px">${v}</b> <span style="color:#888">${l}</span></span>`;
        h += '<div style="padding:8px 10px;border-bottom:1px solid #222834">'
            + chip(R.flights.length, 'flights', '#7adfe6') + chip(shots, 'shots') + chip(shots ? Math.round(100 * (shots - flagged) / shots) + '%' : '–', 'within limits', flagged ? '#ffb347' : '#5fff5f') + chip(flagged, 'flagged', flagged ? '#ffb347' : null) + chip(R.flights.reduce((n, f) => n + f.retakes, 0), 're-takes') + chip(R.flights.reduce((n, f) => n + (f.missing || []).length, 0), 'no picture') + chip(R.flights.reduce((n, f) => n + (f.unplanned || 0), 0), 'unplanned')
            + (R.errors && R.errors.length ? `<div style="color:#ff7a7a">${R.errors.length} error(s): ${R.errors.slice(0, 3).map(escapeHtml).join(' · ')}${R.errors.length > 3 ? ' …' : ''}</div>` : '')
            + '<div style="margin-top:4px">' + ['summary', 'flights', 'drones', 'missions', 'sites'].map(t => `<span data-ft="fc-tab-${t}" style="cursor:pointer;margin-right:12px;${fcTab === t ? 'color:#7adfe6;font-weight:bold;border-bottom:1px solid #7adfe6' : 'color:#888'}">${t === 'summary' ? 'flags' : 'by ' + t.replace(/s$/, '')}</span>`).join('')
            + `<span data-ft="fc-csv" style="cursor:pointer;color:#888;margin-left:14px" title="pastes into cells: on the flights view = a bold row per flight followed by its shots">📋 copy for Sheets${fcTab === 'flights' ? ' (flights + shots)' : fcTab === 'summary' ? ' (flagged shots)' : ''}</span> <span data-ft="fc-shots" style="cursor:pointer;color:#888;margin-left:10px" title="every shot of every flight, one row each, no flight rows — for pivots">📋 shots only (flat)</span> <span data-ft="fc-jira" style="cursor:pointer;color:#888;margin-left:10px">📋 JIRA table</span>`
            + (fcTab === 'flights' ? ` <span data-ft="fc-sort" style="cursor:pointer;color:#888;margin-left:10px">sort: ${fcSortKey === 'when' ? 'newest' : 'worst first'}</span>` : '') + '</div></div>';
        if (fcTab === 'summary') return h + renderFcSummary();
        const t = fcTable(); const cfgT = fcCfg();
        const cell = (v) => `<td style="padding:2px 6px;white-space:nowrap;border-bottom:1px solid #1e2430">${escapeHtml(String(v == null ? '' : v))}</td>`;
        h += '<div style="overflow:auto;max-height:46vh"><table style="border-collapse:collapse;font:11px/1.4 monospace;width:100%"><tr style="color:#7adfe6">' + t.cols.filter(c => c !== 'playback').map(c => `<th style="text-align:left;padding:2px 6px;position:sticky;top:0;background:#14181f">${escapeHtml(c)}</th>`).join('') + '</tr>';
        if (fcTab === 'flights') {
            t.flights.forEach((f, i) => {
                const r = t.rows[i]; const open = fcOpenFlight === f.mid;
                h += `<tr class="aim-ft-row" data-fc-flight="${f.mid}" style="cursor:pointer;${f.flagged ? 'background:rgba(255,179,71,.05)' : ''}">` + cell((open ? '▾ ' : '▸ ') + f.mid) + cell(r[1]) + cell(r[2]) + cell(r[3]) + cell(r[4]) + cell(r[5]) + `<td style="padding:2px 6px;color:${f.flagged ? '#ffb347' : '#5fff5f'}">${f.flagged}</td>` + cell(r[7]) + cell(r[8]) + cell(r[9]) + `<td style="padding:2px 6px;color:${fcColor(f.dHdg, cfgT.hdg)}">${r[10]}</td><td style="padding:2px 6px;color:${fcColor(f.dCam, cfgT.cam)}">${r[11]}</td><td style="padding:2px 6px;color:${fcColor(f.dAlt, cfgT.altFt)}">${r[12]}</td><td style="padding:2px 6px;color:${fcColor(f.dPos, cfgT.posFt)}">${r[13]}</td></tr>`;
                if (open) {
                    h += `<tr><td colspan="14" style="padding:4px 6px 8px 22px;background:#101419"><div style="margin-bottom:4px"><a href="${fcPlaybackUrl(f)}" target="_blank" rel="noopener" style="color:#7adfe6">🎞 open playback ↗</a> <span style="color:#666">· whole mission ${f.planSteps} steps / ${f.planSnaps} snapshots${f.slice ? ` · this flight steps ${f.slice[0]}–${f.slice[1]} (${f.flightSnaps || '?'} snapshots)` : ''}${f.missing && f.missing.length ? ` · <span style="color:#ff7a7a">no picture: ${f.missing.join(', ')}</span>` : ''}</span></div>`
                        + '<table style="border-collapse:collapse;font:11px/1.4 monospace"><tr style="color:#888"><th style="text-align:left;padding:1px 6px">shot</th><th style="text-align:left;padding:1px 6px">step</th><th style="text-align:left;padding:1px 6px">shutter</th><th style="text-align:left;padding:1px 6px">heading p/a/Δ</th><th style="text-align:left;padding:1px 6px">camera p/a/Δ</th><th style="text-align:left;padding:1px 6px">alt ft p/a/Δ</th><th style="text-align:left;padding:1px 6px">drone vs nav</th><th style="text-align:left;padding:1px 6px">asset</th><th style="text-align:left;padding:1px 6px">flags</th></tr>'
                        + f.rows.map(r => `<tr>${cell(r.s)}${cell(r.idx != null ? '#' + r.idx : '')}${cell(new Date(r.t).toLocaleTimeString())}${cell(fcN(r.hdg[0]) + '° / ' + fcN(r.hdg[1]) + '° / ' + fcS(r.hdg[2], 0, '°'))}${cell(fcN(r.cam[0]) + '° / ' + fcN(r.cam[1]) + '° / ' + fcS(r.cam[2], 0, '°'))}${cell(fcN(r.alt[0]) + ' / ' + fcN(r.alt[1]) + ' / ' + fcS(r.alt[2]))}${cell(r.pos != null ? fcN(r.pos) + ' ft ' + r.dir : '–')}${cell(r.asset || '–')}<td style="padding:2px 6px;color:${r.flags.length ? '#ffb347' : '#5fff5f'}">${escapeHtml(r.flags.length ? r.flags.join('; ') : 'ok')}</td></tr>`).join('') + '</table></td></tr>';
                }
            });
        } else {
            t.rows.forEach(r => { h += '<tr class="aim-ft-row">' + r.map(cell).join('') + '</tr>'; });
        }
        h += '</table></div>';
        return h;
    }
    // ==================================================================
    // 🧑‍✈️ PILOT UTILIZATION (v0.46, #274) — how much of each pilot's shift
    // is actually spent flying. Pilots fly one-to-many (2–4 drones at once,
    // staggered starts/ends), so per pilot per LOCAL day every flight is a
    // [takeoff, takeoff + duration] interval and the day's AIR TIME is the
    // UNION of those intervals — two drones up for the same 30 min count
    // 30 min once. Drone-hours (plain sum of durations) is kept alongside
    // so the 1-to-many leverage is visible (drone-hrs ÷ air-hrs).
    // Source: /missions/ log rows of the picked sites (fcFetchLog pager;
    // `when` = launch UTC, `duration` ms, `created_by_username` = pilot).
    // Read-only. Nothing is written to Percepto.
    // ==================================================================
    const KEY_PU = 'aim-ft-pilot-opts';
    const PU_TZS = [['America/Chicago', 'Central (CT)'], ['America/Denver', 'Mountain (MT)'], ['America/Los_Angeles', 'Pacific (PT)'], ['America/New_York', 'Eastern (ET)'], ['UTC', 'UTC']];
    const puOpts = (() => {
        const def = { days: 28, shiftHrs: 8, minMin: 0, tz: 'America/Chicago', endMode: 'duration' };   // endMode: 'duration' (when + duration) | 'landed' (landed timestamp)
        const s = loadJson(KEY_PU, {});
        if (s.endMode === 'landed') def.endMode = 'landed';
        def.twilightMin = 30; def.hideEmpty = true;
        if (typeof s.hideEmpty === 'boolean') def.hideEmpty = s.hideEmpty;
        ['days', 'shiftHrs', 'minMin', 'twilightMin'].forEach(k => { if (typeof s[k] === 'number' && isFinite(s[k]) && s[k] >= 0) def[k] = s[k]; });
        if (typeof s.tz === 'string' && PU_TZS.some(t => t[0] === s.tz)) def.tz = s.tz;
        if (!(def.days >= 1)) def.days = 28;
        if (!(def.shiftHrs > 0)) def.shiftHrs = 8;
        return def;
    })();
    const puSave = () => gmSet(KEY_PU, JSON.stringify(puOpts));
    // ---- per-site flying rules (v0.49): window 24/7 | day | night | custom, 1:1 flag, drone count. GM, env-keyed (QA ids ≠ prod ids). ----
    const KEY_PU_RULES = 'aim-ft-site-rules' + ENV_SUFFIX;
    const puRules = loadJson(KEY_PU_RULES, {});   // { [sid]: { w, from, to, one, drones } }
    const puRulesSave = () => gmSet(KEY_PU_RULES, JSON.stringify(puRules));
    const PU_WINDOWS = { '247': '24/7', day: 'Day only', night: 'Night only', custom: 'Custom hours' };
    const puRuleOf = (sid) => Object.assign({ w: '247', from: '06:00', to: '20:00', one: false, drones: null }, puRules[sid] || {});
    let puShowRules = false; let puBulkW = '247';
    // NOAA sunrise / sunset (≈ ±1 min). dayKey = local calendar date. Returns { rise, set } (ms UTC) or { polar: 'day' | 'night' }.
    function puSunTimes(lat, lng, dayKey) {
        const [y, m, d] = dayKey.split('-').map(Number);
        const J = Date.UTC(y, m - 1, d, 12) / 86400000 + 2440587.5;
        const n = Math.round(J - 2451545);   // J is that date's noon UTC, so this is the whole-day count exactly (the textbook ceil(+0.0008) would land on the NEXT day)
        const rad = Math.PI / 180;
        const Js = n - lng / 360;   // mean solar noon (J* = n − lω/360, lω east-positive / west-negative)
        const M = ((357.5291 + 0.98560028 * Js) % 360 + 360) % 360;
        const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
        const L = ((M + C + 180 + 102.9372) % 360 + 360) % 360;
        const Jt = 2451545 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
        const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.4397 * rad));
        const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
        if (cosW > 1) return { polar: 'night' };
        if (cosW < -1) return { polar: 'day' };
        const w = Math.acos(cosW) / rad;
        const toMs = (jd) => (jd - 2440587.5) * 86400000;
        return { rise: toMs(Jt - w / 360), set: toMs(Jt + w / 360) };
    }
    // local wall-clock → ms UTC (two-pass offset, DST-safe)
    function puLocalMs(dayKey, hhmm, tz) {
        const [y, m, d] = dayKey.split('-').map(Number); const mm = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); if (!mm) return NaN;
        const wall = Date.UTC(y, m - 1, d, Number(mm[1]), Number(mm[2]), 0); let t = wall - puOffset(wall, tz); t = wall - puOffset(t, tz); return t;
    }
    const puMidnight = (dayKey, tz) => puLocalMs(dayKey, '00:00', tz);
    // sunrise−margin … sunset+margin clipped to the local day; null when the site has no centre
    function puDayWindow(sid, dayKey, tz, memo) {
        const k = `${sid}|${dayKey}`; if (memo && k in memo) return memo[k];
        const raw = rawSites && rawSites[sid] && rawSites[sid].raw; const c = raw && siteEntryCenter(raw);
        let out = null;
        if (c) {
            const st = puSunTimes(c.lat, c.lng, dayKey); const m0 = puMidnight(dayKey, tz), m1 = puNextMidnight(m0, tz);
            if (st.polar) out = st.polar === 'day' ? [m0, m1] : [m0, m0];
            else { const mar = (Number(puOpts.twilightMin) || 0) * 60000; out = [Math.max(m0, st.rise - mar), Math.min(m1, st.set + mar)]; }
        }
        if (memo) memo[k] = out; return out;
    }
    // flyable intervals of a site on a local day under its rule → [[a,b],…]
    function puSiteWindows(sid, dayKey, tz, memo) {
        const r = puRuleOf(sid); const m0 = puMidnight(dayKey, tz), m1 = puNextMidnight(m0, tz);
        if (r.w === 'custom') { const a = puLocalMs(dayKey, r.from, tz), b = puLocalMs(dayKey, r.to, tz); if (!isFinite(a) || !isFinite(b) || a === b) return [[m0, m1]]; return a < b ? [[a, b]] : [[m0, b], [a, m1]]; }
        if (r.w === 'day' || r.w === 'night') {
            const dw = puDayWindow(sid, dayKey, tz, memo); if (!dw) return [[m0, m1]];   // unknown centre → treat as 24/7 (surfaced in the rules table)
            if (r.w === 'day') return dw[1] > dw[0] ? [dw] : [];
            const out = []; if (dw[0] > m0) out.push([m0, dw[0]]); if (dw[1] < m1) out.push([dw[1], m1]); return out;
        }
        return [[m0, m1]];
    }
    const puOverlapMs = (s, e, wins) => wins.reduce((t, [a, b]) => t + Math.max(0, Math.min(e, b) - Math.max(s, a)), 0);
    let puRun = null;        // { done, total, msg, abort, errors }
    let puResults = null;    // { at, sites, days, from, to, tz, flights, pilots, pilotDays, dates, skipped, errors, aborted }
    let puTab = 'pilots';    // pilots | days | dates | flights
    let puOpenDay = null;    // 'pilot|day' expanded on the Pilot-days tab (flight-by-flight trace)
    let puShowCheck = false; // 🔬 data check block open
    const puSort = { pilots: { key: 'air', dir: -1 }, days: { key: 'air', dir: -1 }, dates: { key: 'date', dir: -1 }, flights: { key: 'start', dir: -1 }, drones: { key: 'air', dir: -1 }, hours: { key: 'hour', dir: 1 } };
    const puLogCache = {};   // `${sid}|${from}|${to}` → rows (a flown flight never changes; per page load)

    // ---- time-zone helpers (Intl only, no library) ----
    const puDtf = {};
    function puParts(t, tz) {
        if (!puDtf[tz]) puDtf[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const o = {}; puDtf[tz].formatToParts(new Date(t)).forEach(p => { if (p.type !== 'literal') o[p.type] = Number(p.value); });
        if (o.hour === 24) o.hour = 0;
        return o;
    }
    const puDayKey = (t, tz) => { const p = puParts(t, tz); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
    // tz offset (ms, local − UTC) in force at instant t
    function puOffset(t, tz) { const p = puParts(t, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000; }
    // Next local midnight strictly after t. Two passes: the offset at t is
    // wrong on a DST-change day (the switch happens at 02:00, before the
    // following midnight), so re-derive the offset at the first guess.
    function puNextMidnight(t, tz) {
        const p = puParts(t, tz);
        const wall = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0);
        let m = wall - puOffset(t, tz);
        m = wall - puOffset(m, tz);
        if (m <= t) m += 86400000;
        return m;
    }
    const puClock = (t, tz) => { const p = puParts(t, tz); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
    const puHm = (h) => { if (h == null || !isFinite(h)) return ''; const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
    const puH2 = (h) => (h == null || !isFinite(h)) ? '' : Math.round(h * 100) / 100;
    const puPct = (v) => (v == null || !isFinite(v)) ? '' : Math.round(v * 100);

    // Union + concurrency profile of [s,e] intervals (ms). Returns
    // { unionMs, maxK, atK: [ms at 1 drone, at 2, at 3, at ≥4] }.
    function puProfile(iv) {
        const ev = [];
        iv.forEach(([s, e]) => { if (e > s) { ev.push([s, 1]); ev.push([e, -1]); } });
        ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);   // ends before starts at the same instant
        let k = 0, last = null, unionMs = 0, maxK = 0; const atK = [0, 0, 0, 0];
        ev.forEach(([t, d]) => {
            if (last != null && k > 0) { const span = t - last; unionMs += span; atK[Math.min(k, 4) - 1] += span; }
            k += d; last = t; if (k > maxK) maxK = k;
        });
        return { unionMs, maxK, atK };
    }
    function puWindow() {
        const end = new Date(); const start = new Date(); start.setDate(start.getDate() - (Number(puOpts.days) || 28));
        return { start, end };
    }
    // One log row → normalized flight, or null (never flew / no usable times).
    function puNormalize(sid, r) {
        const start = Date.parse(r.when);
        if (!isFinite(start)) return { skip: 'no launch time' };
        const landed = Date.parse(r.landed);
        let dur = Number(r.duration);
        if (puOpts.endMode === 'landed' && isFinite(landed) && landed > start) dur = landed - start;   // user chose the landed timestamp as the flight end
        if (!(dur > 0)) dur = isFinite(landed) && landed > start ? landed - start : NaN;
        if (!(dur > 0)) return { skip: r.state === 0 || r.state === 5 ? 'never flew' : 'no duration' };
        if (dur > 12 * 3600000) return { skip: `duration ${(dur / 3600000).toFixed(1)} h > 12 h (bad record)` };
        if (dur < (Number(puOpts.minMin) || 0) * 60000) return { skip: 'under min length' };
        return { id: r.id, sid, site: siteName(sid) || String(sid), pilot: String(r.created_by_username || '').trim() || '(unknown)', drone: r.drone_name || '', name: r.app_name || '', state: r.state != null ? (FD_STATE[r.state] || `State ${r.state}`) : '', group: r.mission_group_id != null ? r.mission_group_id : '', start, end: start + dur, dur, media: !!r.is_media_mission, landedAt: isFinite(landed) ? landed : null, durField: Number(r.duration), landFail: !!r.landing_is_failed,
            stateRaw: r.state, planned: Number(r.uploader_planned_images_count) || 0, images: Number(r.image_count) || 0, reports: r.mission_data_reports };
    }
    // Split a flight at local midnight(s) → [{day, s, e}]
    function puDaySlices(f, tz) {
        const out = []; let s = f.start; let guard = 0;
        while (s < f.end && ++guard < 8) { const m = puNextMidnight(s, tz); const e = Math.min(m, f.end); out.push({ day: puDayKey(s, tz), s, e }); s = e; }
        return out;
    }
    function puAggregate(flights, tz, shiftHrs, ctx) {
        const memo = {};
        // per-flight rule facts: 1:1 site? overlapped another flight of the same pilot while 1:1 (a rule breach or a mis-flagged site)?
        const byPilotF = {}; flights.forEach(f => { f.one = !!puRuleOf(f.sid).one; f.viol = false; f.nightMs = 0; f.incomplete = f.planned > 0 && f.images < f.planned; f.capture = f.planned > 0 ? f.images / f.planned : null; (byPilotF[f.pilot] = byPilotF[f.pilot] || []).push(f); });
        Object.values(byPilotF).forEach(list => list.forEach(f => { if (f.one) f.viol = list.some(g => g !== f && g.start < f.end - 60000 && g.end > f.start + 60000); }));
        const pd = new Map();   // `${pilot}|${day}` → bucket
        flights.forEach(f => {
            puDaySlices(f, tz).forEach(sl => {
                const k = `${f.pilot}|${sl.day}`;
                let b = pd.get(k);
                if (!b) { b = { pilot: f.pilot, day: sl.day, iv: [], oneIv: [], flexIv: [], flexMs: 0, nightIv: [], viol: 0, landFail: 0, incomplete: 0, planned: 0, images: 0, flights: new Set(), droneMs: 0, sites: new Set(), drones: new Set(), first: Infinity, last: -Infinity, aborted: 0 }; pd.set(k, b); }
                b.iv.push([sl.s, sl.e]); b.flights.add(f.id); b.droneMs += sl.e - sl.s; b.sites.add(f.site); if (f.drone) b.drones.add(f.drone);
                if (f.one) { b.oneIv.push([sl.s, sl.e]); if (sl.s === f.start && f.viol) b.viol++; } else { b.flexIv.push([sl.s, sl.e]); b.flexMs += sl.e - sl.s; }
                if (sl.s === f.start && f.landFail) b.landFail++;
                if (sl.s === f.start && f.planned > 0) { b.planned += f.planned; b.images += f.images; if (f.incomplete) b.incomplete++; }
                // night pieces of this slice (before sunrise−m / after sunset+m at the flight's site) — unioned per pilot-day like air time
                const dw = puDayWindow(f.sid, sl.day, tz, memo);
                if (dw) { if (sl.s < dw[0]) { const e = Math.min(sl.e, dw[0]); b.nightIv.push([sl.s, e]); f.nightMs += e - sl.s; } if (sl.e > dw[1]) { const a = Math.max(sl.s, dw[1]); b.nightIv.push([a, sl.e]); f.nightMs += sl.e - a; } }
                b.first = Math.min(b.first, sl.s); b.last = Math.max(b.last, sl.e);
                if (sl.s === f.start && /Aborted|Failed/.test(f.state)) b.aborted++;
            });
        });
        const H = 3600000;
        const pilotDays = Array.from(pd.values()).map(b => {
            const p = puProfile(b.iv);
            const locked = puProfile(b.oneIv).unionMs / H, flex = puProfile(b.flexIv).unionMs / H;
            return { pilot: b.pilot, day: b.day, flights: b.flights.size, droneH: b.droneMs / H, air: p.unionMs / H, util: (p.unionMs / H) / shiftHrs, maxK: p.maxK, k1: p.atK[0] / H, k2: p.atK[1] / H, k3: p.atK[2] / H, k4: p.atK[3] / H,
                locked, flex, flexDroneH: b.flexMs / H, levFlex: flex ? (b.flexMs / H) / flex : 0, viol: b.viol, night: puProfile(b.nightIv).unionMs / H, landFail: b.landFail, incomplete: b.incomplete, planned: b.planned, images: b.images, capture: b.planned ? b.images / b.planned : null,
                first: b.first, last: b.last, span: (b.last - b.first) / H, sites: Array.from(b.sites).sort(), drones: Array.from(b.drones).sort(), aborted: b.aborted };
        });
        const byPilot = new Map();
        pilotDays.forEach(d => {
            let p = byPilot.get(d.pilot);
            if (!p) { p = { pilot: d.pilot, days: 0, flights: 0, droneH: 0, air: 0, k1: 0, k2: 0, k3: 0, k4: 0, maxK: 0, maxDay: null, minDay: null, sites: new Set(), drones: new Set(), aborted: 0, span: 0, locked: 0, flex: 0, flexDroneH: 0, viol: 0, night: 0, landFail: 0, incomplete: 0, planned: 0, images: 0 }; byPilot.set(d.pilot, p); }
            p.locked += d.locked; p.flex += d.flex; p.flexDroneH += d.flexDroneH; p.viol += d.viol; p.night += d.night; p.landFail += d.landFail; p.incomplete += d.incomplete; p.planned += d.planned; p.images += d.images;
            p.days++; p.flights += d.flights; p.droneH += d.droneH; p.air += d.air; p.k1 += d.k1; p.k2 += d.k2; p.k3 += d.k3; p.k4 += d.k4; p.maxK = Math.max(p.maxK, d.maxK); p.aborted += d.aborted; p.span += d.span;
            d.sites.forEach(s => p.sites.add(s)); d.drones.forEach(s => p.drones.add(s));
            if (!p.maxDay || d.air > p.maxDay.air) p.maxDay = d;
            if (!p.minDay || d.air < p.minDay.air) p.minDay = d;
        });
        const pilots = Array.from(byPilot.values()).map(p => ({ pilot: p.pilot, days: p.days, flights: p.flights, fpd: p.flights / p.days, droneH: p.droneH, air: p.air, airPerDay: p.air / p.days, util: (p.air / p.days) / shiftHrs, leverage: p.air ? p.droneH / p.air : 0,
            k1: p.k1, k2: p.k2, k3: p.k3, k4: p.k4, maxK: p.maxK, maxDayAir: p.maxDay ? p.maxDay.air : 0, maxDayDate: p.maxDay ? p.maxDay.day : '', minDayAir: p.minDay ? p.minDay.air : 0, minDayDate: p.minDay ? p.minDay.day : '',
            locked: p.locked, flex: p.flex, levFlex: p.flex ? p.flexDroneH / p.flex : 0, viol: p.viol, night: p.night, landFail: p.landFail, incomplete: p.incomplete, planned: p.planned, images: p.images, capture: p.planned ? p.images / p.planned : null,
            spanPerDay: p.span / p.days, avgFlightMin: p.flights ? (p.droneH * 60) / p.flights : 0, aborted: p.aborted, sites: Array.from(p.sites).sort(), drones: Array.from(p.drones).sort() }));
        const byDate = new Map();
        pilotDays.forEach(d => {
            let x = byDate.get(d.day);
            if (!x) { x = { day: d.day, pilots: new Set(), flights: 0, droneH: 0, air: 0, top: null, low: null }; byDate.set(d.day, x); }
            x.pilots.add(d.pilot); x.flights += d.flights; x.droneH += d.droneH; x.air += d.air;
            if (!x.top || d.air > x.top.air) x.top = d; if (!x.low || d.air < x.low.air) x.low = d;
        });
        // ---- flyable capacity under the site rules: drone-hours available per calendar day and per local hour ----
        const nDaysCal = Math.max(1, Number(puOpts.days) || 1);
        const availHour = new Array(24).fill(0); const availDate = {}; const dayKeys = [];
        const ctxSites = (ctx && ctx.sites) || []; const seenBySite = {}; flights.forEach(f => { if (f.drone) (seenBySite[f.sid] = seenBySite[f.sid] || new Set()).add(f.drone); });
        if (ctx && ctx.start && ctx.end) { let t = ctx.start.getTime(); const endT = ctx.end.getTime(); let g = 0; while (t <= endT && ++g < 800) { dayKeys.push(puDayKey(t, tz)); t = puNextMidnight(t, tz); } }
        const droneCount = {};
        ctxSites.forEach(sid => {
            const r = puRuleOf(sid); const nd = (r.drones != null && isFinite(r.drones) && r.drones >= 0) ? Number(r.drones) : Math.max(1, seenBySite[sid] ? seenBySite[sid].size : 0);
            droneCount[sid] = nd; if (!nd) return;
            dayKeys.forEach(dk => {
                const m0 = puMidnight(dk, tz); let dayMs = 0;
                puSiteWindows(sid, dk, tz, memo).forEach(([a, b]) => {
                    if (b <= a) return; dayMs += b - a;
                    // hour bins by offset from local midnight (exact except across a DST switch, where one bin is an hour off)
                    let x = a; let g = 0; while (x < b && ++g < 60) { const hr = Math.min(23, Math.floor((x - m0) / H)); const e = Math.min(b, m0 + (hr + 1) * H); if (e <= x) break; availHour[hr] += (e - x) * nd; x = e; }
                });
                availDate[dk] = (availDate[dk] || 0) + dayMs * nd;
            });
        });
        const availTotalH = Object.values(availDate).reduce((a, b) => a + b, 0) / H;
        const poolDrones = Object.values(droneCount).reduce((a, b) => a + b, 0);
        dayKeys.forEach(dk => { if (!byDate.has(dk)) byDate.set(dk, { day: dk, pilots: new Set(), flights: 0, droneH: 0, air: 0, top: null, low: null }); });
        const dates = Array.from(byDate.values()).map(x => ({ avail: (availDate[x.day] || 0) / H, poolUtil: availDate[x.day] ? x.droneH / (availDate[x.day] / H) : 0, day: x.day, pilots: x.pilots.size, names: Array.from(x.pilots).sort(), flights: x.flights, droneH: x.droneH, air: x.air, airPerPilot: x.pilots.size ? x.air / x.pilots.size : 0, util: x.pilots.size ? (x.air / x.pilots.size) / shiftHrs : 0, top: x.top ? `${x.top.pilot} ${puHm(x.top.air)}` : '', low: x.low ? `${x.low.pilot} ${puHm(x.low.air)}` : '' }));
        // ---- drone side: is the pool the constraint? ----
        const nDays = Math.max(1, Number(puOpts.days) || 1);
        const byDrone = new Map();
        flights.forEach(f => {
            const k = f.drone || '(no drone name)';
            let d = byDrone.get(k);
            if (!d) { d = { drone: k, flights: 0, ms: 0, days: new Set(), sites: new Set(), pilots: new Set(), last: -Infinity, first: Infinity, aborted: 0, starts: [] }; byDrone.set(k, d); }
            d.flights++; d.ms += f.dur; d.days.add(puDayKey(f.start, tz)); d.sites.add(f.site); d.pilots.add(f.pilot); d.last = Math.max(d.last, f.end); d.first = Math.min(d.first, f.start); if (/Aborted|Failed/.test(f.state)) d.aborted++; d.starts.push(puDayKey(f.start, tz));
        });
        const drones = Array.from(byDrone.values()).map(d => {
            const days = Array.from(d.days).sort(); let gap = 0;
            for (let i = 1; i < days.length; i++) gap = Math.max(gap, Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400000) - 1);
            const sinceLast = Math.max(0, Math.floor((Date.now() - d.last) / 86400000));
            return { drone: d.drone, flights: d.flights, air: d.ms / H, days: d.days.size, idleDays: nDays - d.days.size, airPerDay: d.ms / H / d.days.size, airPerCalDay: d.ms / H / nDays, gap, sinceLast, avgFlightMin: d.ms / 60000 / d.flights, aborted: d.aborted, sites: Array.from(d.sites).sort(), pilots: Array.from(d.pilots).sort(), last: d.last };
        });
        // ---- hour of day (local): how much of the pool is airborne when ----
        const hourMs = new Array(24).fill(0), hourStarts = new Array(24).fill(0), hourPilotDays = Array.from({ length: 24 }, () => new Set()), hourDroneDays = Array.from({ length: 24 }, () => new Set());
        flights.forEach(f => {
            let s = f.start, guard = 0;
            const pp = puParts(f.start, tz); hourStarts[pp.hour]++;
            while (s < f.end && ++guard < 200) {
                const p = puParts(s, tz); const next = s + ((60 - p.minute) * 60 - p.second) * 1000; const e = Math.min(next, f.end);
                hourMs[p.hour] += e - s; const dk = puDayKey(s, tz); hourPilotDays[p.hour].add(`${f.pilot}|${dk}`); if (f.drone) hourDroneDays[p.hour].add(`${f.drone}|${dk}`);
                s = e;
            }
        });
        const nDates = Math.max(1, byDate.size);
        const hours = hourMs.map((ms, hr) => ({ hour: hr, label: `${String(hr).padStart(2, '0')}:00`, droneH: ms / H, avgAirborne: ms / H / nDates, avgAirborneCal: ms / H / nDays, starts: hourStarts[hr], pilotsAvg: hourPilotDays[hr].size / nDates, dronesAvg: hourDroneDays[hr].size / nDates, avail: availHour[hr] / H / nDaysCal, poolUtil: availHour[hr] ? ms / availHour[hr] : 0 }));
        drones.forEach(d => { const top = d.sites.length ? d.sites[0] : null; const sid = flights.find(f => f.drone === d.drone && f.site === top); const r = sid ? puRuleOf(sid.sid) : null; d.window = r ? PU_WINDOWS[r.w] : ''; d.one = r ? !!r.one : false; });
        const fleet = puProfile(flights.map(f => [f.start, f.end]));
        return { pilots, pilotDays, dates, drones, hours, fleetPeak: fleet.maxK, nDates, availTotalH, poolDrones, poolUtil: availTotalH ? (flights.reduce((t, f) => t + f.dur, 0) / H) / availTotalH : 0 };
    }
    async function runPilotUtil() {
        if (puRun) return;
        const sites = Array.from(fdSelected); fdNotePick();
        if (!sites.length) { setStatus('Pilot utilization: pick sites in 📦 Fleet Data first (or ☑ select shown there)'); openSections.data = true; renderPanel(); return; }
        const { start, end } = puWindow();
        const from = fdYmd(start), to = fdYmd(end);
        puRun = { done: 0, total: sites.length, msg: 'listing flights…', abort: false, errors: [] };
        openSections.pilots = true; renderPanel();
        const isAborted = () => puRun && puRun.abort;
        const flights = []; const skipped = {}; const skippedRows = []; const raw = []; let rawRows = 0;
        try {
            for (const sid of sites) {
                if (isAborted()) break;
                puRun.msg = `listing flights · ${siteName(sid) || sid} (${puRun.done + 1}/${sites.length})`; setStatus(puRun.msg); renderPanel();
                const ck = `${sid}|${from}|${to}`;
                try {
                    const rows = puLogCache[ck] || (puLogCache[ck] = await fcFetchLog(sid, start, end, isAborted));
                    rawRows += rows.length;
                    rows.forEach(r => { raw.push({ sid, r }); const f = puNormalize(sid, r); if (f.skip) { skipped[f.skip] = (skipped[f.skip] || 0) + 1; skippedRows.push({ sid, r, why: f.skip }); } else flights.push(f); });
                } catch (e) { if (String(e.message).includes('aborted')) break; puRun.errors.push(`${siteName(sid) || sid}: ${e.message}`); console.warn(`${TAG} pilot util: log fetch failed for ${sid}:`, e); }
                puRun.done++;
                await ftYield();
            }
            // dedupe (a mission id can only be one flight; guards against a site listed twice)
            const seen = new Set(); const uniq = flights.filter(f => !seen.has(f.id) && seen.add(f.id));
            uniq.sort((a, b) => a.start - b.start);
            const agg = puAggregate(uniq, puOpts.tz, puOpts.shiftHrs, { sites, start, end });
            puResults = { at: Date.now(), sites, days: puOpts.days, from, to, tz: puOpts.tz, shiftHrs: puOpts.shiftHrs, flights: uniq, pilots: agg.pilots, pilotDays: agg.pilotDays, dates: agg.dates, drones: agg.drones, hours: agg.hours, fleetPeak: agg.fleetPeak, nDates: agg.nDates, availTotalH: agg.availTotalH, poolDrones: agg.poolDrones, poolUtil: agg.poolUtil, startMs: start.getTime(), endMs: end.getTime(), skipped, skippedRows, raw, endMode: puOpts.endMode, rawRows, errors: puRun.errors, aborted: isAborted() };
            puOpenDay = null; puShowCheck = false;
            const sk = Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(', ');
            setStatus(`Pilot utilization: ${uniq.length} flight(s) · ${agg.pilots.length} pilot(s) · ${agg.pilotDays.length} pilot-day(s) across ${sites.length} site(s), last ${puOpts.days} d${sk ? ` · skipped ${sk}` : ''}${puRun.errors.length ? ` · ${puRun.errors.length} error(s)` : ''}${isAborted() ? ' · ABORTED (partial)' : ''}`);
            console.log(`${TAG} pilot util: ${rawRows} log rows → ${uniq.length} flights, ${agg.pilots.length} pilots`, { skipped, errors: puRun.errors });
        } catch (e) { console.error(`${TAG} pilot utilization failed:`, e); setStatus(`Pilot utilization failed — ${String(e && e.message || e)}`); }
        puRun = null; renderPanel();
    }
    // rules / options changed → recompute from the flights already fetched (no network)
    function puReaggregate() {
        if (!puResults) return;
        try { const R = puResults; const agg = puAggregate(R.flights, R.tz, R.shiftHrs, { sites: R.sites, start: new Date(R.startMs), end: new Date(R.endMs) }); Object.assign(R, { pilots: agg.pilots, pilotDays: agg.pilotDays, dates: agg.dates, drones: agg.drones, hours: agg.hours, fleetPeak: agg.fleetPeak, nDates: agg.nDates, availTotalH: agg.availTotalH, poolDrones: agg.poolDrones, poolUtil: agg.poolUtil }); }
        catch (e) { console.error(`${TAG} pilot util re-aggregate failed:`, e); setStatus(`re-aggregate failed — ${String(e && e.message || e)}`); }
    }
    // ---- tables: cols = { key, label, get(row) → raw (number/string), fmt?(raw) → panel text, title? } ----
    const PU_COLS = {
        pilots: [
            { key: 'pilot', label: 'Pilot', get: r => r.pilot },
            { key: 'days', label: 'Active days', get: r => r.days, title: 'days with at least one flight' },
            { key: 'flights', label: 'Flights', get: r => r.flights },
            { key: 'fpd', label: 'Flights / day', get: r => r.fpd, fmt: v => v.toFixed(1), exp: puH2 },
            { key: 'air', label: 'Air time', get: r => r.air, fmt: puHm, exp: puH2, expLabel: 'Air time (h)', title: 'union of flight intervals — overlapping drones count once' },
            { key: 'airPerDay', label: 'Air / day', get: r => r.airPerDay, fmt: puHm, exp: puH2, expLabel: 'Air / day (h)' },
            { key: 'util', label: 'Util %', get: r => r.util, fmt: v => puPct(v) + '%', exp: puPct, title: 'air time per active day ÷ shift hours' },
            { key: 'droneH', label: 'Drone-hrs', get: r => r.droneH, fmt: puHm, exp: puH2, expLabel: 'Drone-hrs (h)', title: 'plain sum of flight durations' },
            { key: 'leverage', label: 'Drones ⌀', get: r => r.leverage, fmt: v => v.toFixed(2) + '×', exp: puH2, title: 'drone-hrs ÷ air time = average drones in the air while flying' },
            { key: 'locked', label: 'Locked 1:1', get: r => r.locked, fmt: puHm, exp: puH2, expLabel: 'Locked 1:1 (h)', title: 'air time at sites flagged 1:1 — the pilot could not add a second drone' },
            { key: 'flex', label: 'Flex air', get: r => r.flex, fmt: puHm, exp: puH2, expLabel: 'Flex air (h)', title: 'air time at sites where 1-to-many was allowed' },
            { key: 'levFlex', label: 'Drones ⌀ (flex)', get: r => r.levFlex, fmt: v => v.toFixed(2) + '×', exp: puH2, title: 'drone-hrs ÷ air time over the flex hours only — the fair 1-to-many measure' },
            { key: 'viol', label: '1:1 overlaps', get: r => r.viol, title: 'flights at a 1:1 site that overlapped another flight by this pilot (rule breach, or the site is mis-flagged)' },
            { key: 'night', label: 'Night', get: r => r.night, fmt: puHm, exp: puH2, expLabel: 'Night (h)', title: 'air time outside sunrise−margin … sunset+margin at the site' },
            { key: 'maxK', label: 'Max at once', get: r => r.maxK },
            { key: 'k1', label: '1 drone', get: r => r.k1, fmt: puHm, exp: puH2, expLabel: '1 drone (h)', title: 'air time with exactly one drone up' },
            { key: 'k2', label: '2 drones', get: r => r.k2, fmt: puHm, exp: puH2, expLabel: '2 drones (h)' },
            { key: 'k3', label: '3 drones', get: r => r.k3, fmt: puHm, exp: puH2, expLabel: '3 drones (h)' },
            { key: 'k4', label: '4+ drones', get: r => r.k4, fmt: puHm, exp: puH2, expLabel: '4+ drones (h)' },
            { key: 'maxDayAir', label: 'Best day', get: r => r.maxDayAir, fmt: (v, r) => `${puHm(v)} · ${r.maxDayDate}`, exp: puH2, expLabel: 'Best day (h)' },
            { key: 'maxDayDate', label: 'Best day date', get: r => r.maxDayDate, hide: true },
            { key: 'minDayAir', label: 'Lightest day', get: r => r.minDayAir, fmt: (v, r) => `${puHm(v)} · ${r.minDayDate}`, exp: puH2, expLabel: 'Lightest day (h)' },
            { key: 'minDayDate', label: 'Lightest day date', get: r => r.minDayDate, hide: true },
            { key: 'spanPerDay', label: 'Span / day', get: r => r.spanPerDay, fmt: puHm, exp: puH2, expLabel: 'Span / day (h)', title: 'first takeoff → last landing, averaged over active days' },
            { key: 'avgFlightMin', label: 'Avg flight', get: r => r.avgFlightMin, fmt: v => Math.round(v) + ' min', exp: v => Math.round(v), expLabel: 'Avg flight (min)' },
            { key: 'aborted', label: 'Aborted/failed', get: r => r.aborted, title: 'flown flights whose log state is Aborted or Failed (see 🔬 Data check → flown rows by state)' },
            { key: 'landFail', label: 'Landing failed', get: r => r.landFail, title: 'flights the log flags landing_is_failed' },
            { key: 'incomplete', label: 'Incomplete', get: r => r.incomplete, title: 'flights that captured fewer images than planned (uploader_planned_images_count) — ended early, whatever the state says' },
            { key: 'capture', label: 'Capture %', get: r => r.capture == null ? '' : r.capture, fmt: v => v === '' ? '' : puPct(v) + '%', exp: v => v === '' ? '' : puPct(v), title: 'images captured ÷ images planned, over flights that had a plan' },
            { key: 'drones', label: 'Drones', get: r => r.drones.length, fmt: (v, r) => `${v}`, exp: (v, r) => r.drones.join(', '), title: r => r.drones.join(', ') },
            { key: 'sites', label: 'Sites', get: r => r.sites.length, fmt: (v, r) => `${v}`, exp: (v, r) => r.sites.join(', '), title: r => r.sites.join(', ') },
        ],
        days: [
            { key: 'day', label: 'Date', get: r => r.day },
            { key: 'pilot', label: 'Pilot', get: r => r.pilot },
            { key: 'flights', label: 'Flights', get: r => r.flights },
            { key: 'air', label: 'Air time', get: r => r.air, fmt: puHm, exp: puH2, expLabel: 'Air time (h)' },
            { key: 'util', label: 'Util %', get: r => r.util, fmt: v => puPct(v) + '%', exp: puPct },
            { key: 'droneH', label: 'Drone-hrs', get: r => r.droneH, fmt: puHm, exp: puH2, expLabel: 'Drone-hrs (h)' },
            { key: 'locked', label: 'Locked 1:1', get: r => r.locked, fmt: puHm, exp: puH2, expLabel: 'Locked 1:1 (h)' },
            { key: 'flex', label: 'Flex air', get: r => r.flex, fmt: puHm, exp: puH2, expLabel: 'Flex air (h)' },
            { key: 'levFlex', label: 'Drones ⌀ (flex)', get: r => r.levFlex, fmt: v => v.toFixed(2) + '×', exp: puH2 },
            { key: 'viol', label: '1:1 overlaps', get: r => r.viol },
            { key: 'night', label: 'Night', get: r => r.night, fmt: puHm, exp: puH2, expLabel: 'Night (h)' },
            { key: 'maxK', label: 'Max at once', get: r => r.maxK },
            { key: 'k1', label: '1 drone', get: r => r.k1, fmt: puHm, exp: puH2, expLabel: '1 drone (h)' },
            { key: 'k2', label: '2 drones', get: r => r.k2, fmt: puHm, exp: puH2, expLabel: '2 drones (h)' },
            { key: 'k3', label: '3+ drones', get: r => r.k3 + r.k4, fmt: puHm, exp: puH2, expLabel: '3+ drones (h)' },
            { key: 'first', label: 'First takeoff', get: r => r.first, fmt: v => puClock(v, puOpts.tz), exp: v => puClock(v, puOpts.tz) },
            { key: 'last', label: 'Last landing', get: r => r.last, fmt: v => puClock(v, puOpts.tz), exp: v => puClock(v, puOpts.tz) },
            { key: 'span', label: 'Span', get: r => r.span, fmt: puHm, exp: puH2, expLabel: 'Span (h)', title: 'first takeoff → last landing' },
            { key: 'aborted', label: 'Aborted/failed', get: r => r.aborted },
            { key: 'landFail', label: 'Landing failed', get: r => r.landFail },
            { key: 'incomplete', label: 'Incomplete', get: r => r.incomplete },
            { key: 'capture', label: 'Capture %', get: r => r.capture == null ? '' : r.capture, fmt: v => v === '' ? '' : puPct(v) + '%', exp: v => v === '' ? '' : puPct(v) },
            { key: 'drones', label: 'Drones', get: r => r.drones.join(', ') },
            { key: 'sites', label: 'Sites', get: r => r.sites.join(', ') },
        ],
        dates: [
            { key: 'day', label: 'Date', get: r => r.day },
            { key: 'pilots', label: 'Pilots', get: r => r.pilots, fmt: (v, r) => `${v}`, title: r => r.names.join(', '), exp: (v, r) => v },
            { key: 'flights', label: 'Flights', get: r => r.flights },
            { key: 'air', label: 'Air time (all pilots)', get: r => r.air, fmt: puHm, exp: puH2, expLabel: 'Air time (h)' },
            { key: 'airPerPilot', label: 'Air / pilot', get: r => r.airPerPilot, fmt: puHm, exp: puH2, expLabel: 'Air / pilot (h)' },
            { key: 'util', label: 'Util %', get: r => r.util, fmt: v => puPct(v) + '%', exp: puPct },
            { key: 'droneH', label: 'Drone-hrs', get: r => r.droneH, fmt: puHm, exp: puH2, expLabel: 'Drone-hrs (h)' },
            { key: 'avail', label: 'Flyable drone-hrs', get: r => r.avail, fmt: puHm, exp: puH2, expLabel: 'Flyable drone-hrs (h)', title: 'drone-hours the site rules allowed that day (drones × window)' },
            { key: 'poolUtil', label: 'Pool util %', get: r => r.poolUtil, fmt: v => puPct(v) + '%', exp: puPct, title: 'drone-hrs flown ÷ flyable drone-hrs' },
            { key: 'top', label: 'Most air', get: r => r.top },
            { key: 'low', label: 'Least air', get: r => r.low },
            { key: 'names', label: 'Pilot names', get: r => r.names.join(', '), hide: true },
        ],
        drones: [
            { key: 'drone', label: 'Drone', get: r => r.drone },
            { key: 'flights', label: 'Flights', get: r => r.flights },
            { key: 'air', label: 'Air time', get: r => r.air, fmt: puHm, exp: puH2, expLabel: 'Air time (h)' },
            { key: 'days', label: 'Days flown', get: r => r.days },
            { key: 'idleDays', label: 'Idle days', get: r => r.idleDays, title: 'calendar days in the window with no flight' },
            { key: 'airPerDay', label: 'Air / flown day', get: r => r.airPerDay, fmt: puHm, exp: puH2, expLabel: 'Air / flown day (h)' },
            { key: 'airPerCalDay', label: 'Air / cal. day', get: r => r.airPerCalDay, fmt: puHm, exp: puH2, expLabel: 'Air / calendar day (h)', title: 'air time ÷ every day of the window' },
            { key: 'gap', label: 'Longest gap', get: r => r.gap, fmt: v => v + ' d', expLabel: 'Longest gap (days)', title: 'longest run of consecutive days with no flight, between flights' },
            { key: 'sinceLast', label: 'Since last', get: r => r.sinceLast, fmt: v => v + ' d', expLabel: 'Since last (days)', title: 'days since this drone last landed' },
            { key: 'avgFlightMin', label: 'Avg flight', get: r => r.avgFlightMin, fmt: v => Math.round(v) + ' min', exp: v => Math.round(v), expLabel: 'Avg flight (min)' },
            { key: 'aborted', label: 'Aborted/failed', get: r => r.aborted },
            { key: 'window', label: 'Window', get: r => r.window || '' },
            { key: 'one', label: '1:1', get: r => r.one ? 'yes' : '' },
            { key: 'pilots', label: 'Pilots', get: r => r.pilots.length, fmt: (v, r) => `${v}`, exp: (v, r) => r.pilots.join(', '), title: r => r.pilots.join(', ') },
            { key: 'sites', label: 'Sites', get: r => r.sites.join(', ') },
        ],
        hours: [
            { key: 'hour', label: 'Hour (local)', get: r => r.hour, fmt: (v, r) => r.label, exp: (v, r) => r.label },
            { key: 'avgAirborne', label: 'Drones airborne ⌀', get: r => r.avgAirborne, fmt: v => v.toFixed(2), exp: puH2, title: 'average number of drones in the air during this hour, over days that had any flying' },
            { key: 'avgAirborneCal', label: 'Airborne ⌀ (all days)', get: r => r.avgAirborneCal, fmt: v => v.toFixed(2), exp: puH2, title: 'same, averaged over every calendar day of the window' },
            { key: 'dronesAvg', label: 'Distinct drones ⌀', get: r => r.dronesAvg, fmt: v => v.toFixed(1), exp: puH2, title: 'distinct drones that flew at all during this hour, per flying day' },
            { key: 'pilotsAvg', label: 'Pilots active ⌀', get: r => r.pilotsAvg, fmt: v => v.toFixed(1), exp: puH2, title: 'distinct pilots with a drone up during this hour, per flying day' },
            { key: 'avail', label: 'Drones flyable ⌀', get: r => r.avail, fmt: v => v.toFixed(1), exp: puH2, title: 'drones whose site window covers this hour, averaged over every calendar day' },
            { key: 'poolUtil', label: 'Pool util %', get: r => r.poolUtil, fmt: v => puPct(v) + '%', exp: puPct, title: 'drone-hrs flown in this hour ÷ flyable drone-hrs' },
            { key: 'starts', label: 'Takeoffs', get: r => r.starts },
            { key: 'droneH', label: 'Drone-hrs', get: r => r.droneH, fmt: puHm, exp: puH2, expLabel: 'Drone-hrs (h)' },
        ],
        flights: [
            { key: 'start', label: 'Takeoff', get: r => r.start, fmt: v => `${puDayKey(v, puOpts.tz)} ${puClock(v, puOpts.tz)}`, exp: v => `${puDayKey(v, puOpts.tz)} ${puClock(v, puOpts.tz)}` },
            { key: 'end', label: 'Landed', get: r => r.end, fmt: v => puClock(v, puOpts.tz), exp: v => `${puDayKey(v, puOpts.tz)} ${puClock(v, puOpts.tz)}` },
            { key: 'dur', label: 'Duration', get: r => r.dur / 60000, fmt: v => Math.round(v) + ' min', exp: v => Math.round(v * 10) / 10, expLabel: 'Duration (min)' },
            { key: 'pilot', label: 'Pilot', get: r => r.pilot },
            { key: 'drone', label: 'Drone', get: r => r.drone },
            { key: 'site', label: 'Site', get: r => r.site },
            { key: 'name', label: 'Mission', get: r => r.name },
            { key: 'state', label: 'State', get: r => r.state },
            { key: 'landFail', label: 'Landing failed', get: r => r.landFail ? 'yes' : '' },
            { key: 'images', label: 'Images actual/planned', get: r => r.planned ? `${r.images}/${r.planned}` : (r.images ? String(r.images) : '') },
            { key: 'incomplete', label: 'Incomplete', get: r => r.incomplete ? 'yes' : '' },
            { key: 'stateRaw', label: 'State code', get: r => r.stateRaw == null ? '' : r.stateRaw },
            { key: 'overlap', label: 'Overlapping', get: r => r.overlap, title: 'other flights by the same pilot in the air at any point during this one' },
            { key: 'one', label: '1:1 site', get: r => r.one ? (r.viol ? 'yes ⚠ overlapped' : 'yes') : '' },
            { key: 'night', label: 'Night (min)', get: r => Math.round((r.nightMs || 0) / 60000) },
            { key: 'id', label: 'Mission ID', get: r => r.id },
            { key: 'group', label: 'Group', get: r => r.group },
            { key: 'link', label: 'Playback', get: r => `${location.origin}/#/site/${r.sid}/control-panel/past-mission/${r.id}`, hide: true },
        ],
    };
    function puRows(tab) {
        if (!puResults) return [];
        if (tab === 'flights') {
            if (!puResults._flightsWithOverlap) {
                const byPilot = {}; puResults.flights.forEach(f => (byPilot[f.pilot] = byPilot[f.pilot] || []).push(f));
                puResults.flights.forEach(f => { f.overlap = byPilot[f.pilot].filter(g => g !== f && g.start < f.end && g.end > f.start).length; });
                puResults._flightsWithOverlap = true;
            }
            return puResults.flights;
        }
        return tab === 'pilots' ? puResults.pilots : tab === 'days' ? puResults.pilotDays : tab === 'drones' ? (puResults.drones || []) : tab === 'hours' ? (puResults.hours || []) : puResults.dates;
    }
    function puSorted(tab) {
        const cols = PU_COLS[tab]; const st = puSort[tab]; const col = cols.find(c => c.key === st.key) || cols[0];
        const rows = puRows(tab).slice();
        rows.sort((a, b) => { const x = col.get(a), y = col.get(b); const c = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }); return c * st.dir || String(a.pilot || a.day || '').localeCompare(String(b.pilot || b.day || '')); });
        return rows;
    }
    // columns worth showing: drop the ones that are 0 / blank on EVERY row (1:1 columns before any site is flagged, Aborted/failed when Percepto files everything as Completed, …)
    const puEmptyVal = (v) => v == null || v === '' || v === 0 || v === false || (Array.isArray(v) && !v.length);
    function puVisibleCols(tab, rows) {
        const all = PU_COLS[tab].filter(c => !c.hide);
        if (!puOpts.hideEmpty || !rows.length) return { cols: all, hidden: [] };
        const hidden = []; const cols = all.filter((c, i) => { if (i === 0) return true; const keep = rows.some(r => !puEmptyVal(c.get(r))); if (!keep) hidden.push(c.label); return keep; });
        return { cols, hidden };
    }
    function puExportCols(tab, rows) {
        const src = rows ? puVisibleCols(tab, rows).cols : PU_COLS[tab].filter(c => !c.hide);
        return src.map(c => ({ label: c.expLabel || c.label, get: r => { const v = c.get(r); return c.exp ? c.exp(v, r) : v; } }));
    }
    function puSheetsHtml(tab) {
        const rows = puSorted(tab), cols = puExportCols(tab, rows);
        const th = (s) => `<th style="background:#e8eaed;border:1px solid #bbb;padding:3px 6px;text-align:left;white-space:nowrap">${escapeHtml(s)}</th>`;
        const td = (s) => `<td style="border:1px solid #ccc;padding:2px 6px">${escapeHtml(String(s == null ? '' : s))}</td>`;
        return `<table border="1" cellpadding="3" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:11px"><tr>${cols.map(c => th(c.label)).join('')}</tr>${rows.map(r => '<tr>' + cols.map(c => td(c.get(r))).join('') + '</tr>').join('')}</table>`;
    }
    function puTsv(tab) {
        const rows = puSorted(tab), cols = puExportCols(tab, rows); const esc = (v) => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
        return [cols.map(c => esc(c.label)).join('\t')].concat(rows.map(r => cols.map(c => esc(c.get(r))).join('\t'))).join('\n');
    }
    function puExport(kind) {
        if (!puResults) { setStatus('run ▶ Pilot utilization first'); return; }
        const tab = puTab; const n = puRows(tab).length;
        const label = { pilots: 'pilots', days: 'pilot-days', dates: 'dates', flights: 'flights', drones: 'drones', hours: 'hours' }[tab] || tab;
        if (kind === 'csv') {
            fdDownload(new Blob([(() => { const rows = puSorted(tab); return fdCsv(puExportCols(tab, rows), rows); })()], { type: 'text/csv' }), `AIM-pilot-utilization ${label} ${puResults.from} to ${puResults.to}.csv`);
            setStatus(`pilot utilization ${label} CSV downloaded — ${n} row(s)`);
        } else copyHtmlToClipboard(puSheetsHtml(tab), puTsv(tab), `pilot utilization ${label} copied — ${n} row(s) — paste into Google Sheets / Excel`);
    }
    // ---- 🔬 data check: is the log telling us what we think it is? ----
    const puPctl = (arr, q) => { if (!arr.length) return NaN; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))]; };
    function puDataCheck() {
        const R = puResults; if (!R || !R.raw) return '';
        const inc = (m, k) => { m[k] = (m[k] || 0) + 1; };
        const byType = {}, byState = {}, noDurState = {}, users = {}; let media = 0, blankUser = 0, noDurWithLanded = 0, landedBeforeWhen = 0;
        const durMin = [], delta = [];
        R.raw.forEach(({ r }) => {
            inc(byType, r.type == null ? 'null' : String(r.type)); inc(byState, r.state != null ? (FD_STATE[r.state] || `State ${r.state}`) : 'null');
            if (r.is_media_mission) media++;
            const u = String(r.created_by_username || '').trim(); if (!u) blankUser++; inc(users, u || '(blank)');
            const when = Date.parse(r.when), landed = Date.parse(r.landed), d = Number(r.duration);
            if (!(d > 0)) { inc(noDurState, r.state != null ? (FD_STATE[r.state] || `State ${r.state}`) : 'null'); if (isFinite(landed) && isFinite(when) && landed > when) noDurWithLanded++; }
            else durMin.push(d / 60000);
            if (isFinite(landed) && isFinite(when)) { if (landed < when) landedBeforeWhen++; if (d > 0) delta.push(((landed - when) - d) / 60000); }
        });
        // a physical drone cannot be in two flights at once — self-overlap means the intervals are too long (bad when/duration semantics)
        const byDrone = {}; R.flights.forEach(f => { if (f.drone) (byDrone[f.drone] = byDrone[f.drone] || []).push(f); });
        let selfOverlap = 0; const selfEx = [];
        Object.values(byDrone).forEach(list => { list.sort((a, b) => a.start - b.start); for (let i = 1; i < list.length; i++) { if (list[i].start < list[i - 1].end - 60000) { selfOverlap++; if (selfEx.length < 3) selfEx.push(`${list[i].drone} #${list[i - 1].id}→#${list[i].id} (${Math.round((list[i - 1].end - list[i].start) / 60000)} min)`); } } });
        const totDrone = R.pilotDays.reduce((s, d) => s + d.droneH, 0), totAir = R.pilotDays.reduce((s, d) => s + d.air, 0);
        const fmtMap = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${escapeHtml(k)} ${v}`).join(' · ');
        const topUsers = Object.entries(users).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${escapeHtml(k)} ${v}`).join(' · ');
        const dMed = puPctl(delta, 0.5), dP90 = puPctl(delta, 0.9), dBig = delta.filter(x => Math.abs(x) > 2).length;
        const row = (l, v, c) => `<div style="display:flex;gap:8px;padding:1px 0"><span style="color:#888;min-width:190px;flex:none">${l}</span><span style="color:${c || '#ddd'}">${v}</span></div>`;
        let verdict = '';
        if (delta.length) {
            if (Math.abs(dMed) <= 2) verdict = `<span style="color:#5fff5f">duration ≈ landed − launch (median Δ ${dMed.toFixed(1)} min) → duration spans the whole flight. Using it is right.</span>`;
            else if (dMed > 2) verdict = `<span style="color:#ffb347">landed − launch is typically ${dMed.toFixed(1)} min LONGER than duration (p90 ${dP90.toFixed(1)}) → duration excludes takeoff / return-to-dock. Switch "flight end" to <b>landed time</b> to count the full airborne span.</span>`;
            else verdict = `<span style="color:#ff7a7a">landed − launch is typically ${(-dMed).toFixed(1)} min SHORTER than duration → these two fields disagree; check a flight in Percepto before trusting either.</span>`;
        } else verdict = '<span style="color:#888">no rows carry both landed and duration — cannot cross-check</span>';
        return '<div style="padding:8px 10px;border-bottom:1px solid #222834;background:#10141a;font:11px/1.5 monospace">'
            + '<div style="color:#7adfe6;font-weight:bold;margin-bottom:4px">🔬 Data check — what the mission log actually contains</div>'
            + row('log rows fetched', `${R.raw.length} · used ${R.flights.length} · skipped ${R.raw.length - R.flights.length}`)
            + row('rows by state', fmtMap(byState))
            + row('raw state codes', (() => { const m = {}; R.raw.forEach(({ r }) => inc(m, r.state == null ? 'null' : `${r.state} → ${FD_STATE[r.state] || '?'}`)); return fmtMap(m) + ' <span style="color:#666">(our label mapping is unverified — if aborted flights are known to exist and every flown row is code 2, the mapping is wrong)</span>'; })())
            + row('planned vs actual images', (() => { const withPlan = R.flights.filter(f => f.planned > 0); const inc2 = withPlan.filter(f => f.incomplete); const caps = withPlan.map(f => f.capture); return withPlan.length ? `${withPlan.length} flights had a plan · <b style="color:${inc2.length ? '#ffb347' : '#5fff5f'}">${inc2.length} captured fewer images than planned</b> (${withPlan.length ? Math.round(100 * inc2.length / withPlan.length) : 0}%) · capture median ${Math.round(puPctl(caps, 0.5) * 100)}% · p10 ${Math.round(puPctl(caps, 0.1) * 100)}%` : 'no flights carry a planned image count'; })())
            + row('mission_data_reports', (() => { const has = R.raw.filter(({ r }) => r.mission_data_reports != null && !(Array.isArray(r.mission_data_reports) && !r.mission_data_reports.length) && !(typeof r.mission_data_reports === 'object' && !Object.keys(r.mission_data_reports).length)); if (!has.length) return 'empty on every row'; const keys = {}; has.forEach(({ r }) => { const v = r.mission_data_reports; (Array.isArray(v) ? v : [v]).forEach(x => { if (x && typeof x === 'object') Object.keys(x).forEach(k => inc(keys, k)); else inc(keys, typeof x); }); }); const sample = escapeHtml(JSON.stringify(has[0].r.mission_data_reports).slice(0, 300)); return `${has.length} rows carry one · keys: ${fmtMap(keys)} · sample: <code style="color:#aaa">${sample}</code>`; })())
            + row('flown rows by state', (() => { const m = {}; R.flights.forEach(f => inc(m, f.state || 'null')); const lf = R.flights.filter(f => f.landFail).length; return `${fmtMap(m)}${lf ? ` · <b style="color:#ffb347">${lf} flagged landing_is_failed</b>` : ' · no landing_is_failed flags'} — if every flown row is Completed, Percepto files aborted launches under the no-duration rows above and the Aborted/failed column stays 0`; })())
            + row('rows by type', `${fmtMap(byType)}${media ? ` · media missions ${media}` : ''}`)
            + row('rows with no duration', Object.keys(noDurState).length ? `${fmtMap(noDurState)} · ${noDurWithLanded} rescued from their landed time (counted) · <b>${Object.values(noDurState).reduce((a, b) => a + b, 0) - noDurWithLanded} have neither → skipped</b> (Pending/Cancelled never flew; an Aborted/Failed row with no times is a launch that did not happen or a broken record)` : 'none', Object.keys(noDurState).length ? '#ffb347' : '#5fff5f')
            + row('duration (min)', durMin.length ? `min ${puPctl(durMin, 0).toFixed(1)} · p10 ${puPctl(durMin, 0.1).toFixed(1)} · median ${puPctl(durMin, 0.5).toFixed(1)} · p90 ${puPctl(durMin, 0.9).toFixed(1)} · max ${puPctl(durMin, 1).toFixed(1)} · mean ${(durMin.reduce((a, b) => a + b, 0) / durMin.length).toFixed(1)}` : 'none')
            + row('landed − launch vs duration', delta.length ? `${delta.length} rows carry both · median Δ ${dMed.toFixed(1)} min · p90 ${dP90.toFixed(1)} · ${dBig} differ by >2 min` : 'no rows carry both')
            + row('verdict on "duration"', verdict)
            + row('landed before launch', landedBeforeWhen ? `${landedBeforeWhen} rows (bad records)` : 'none', landedBeforeWhen ? '#ff7a7a' : '#5fff5f')
            + row('same drone in 2 flights at once', selfOverlap ? `<b>${selfOverlap}</b> — intervals are TOO LONG or overlap by >1 min; e.g. ${selfEx.map(escapeHtml).join(', ')}` : 'none — intervals are consistent with one drone per flight', selfOverlap ? '#ff7a7a' : '#5fff5f')
            + row('pilot attribution', `${Object.keys(users).length} distinct created_by_username${blankUser ? ` · <b style="color:#ff7a7a">${blankUser} blank</b>` : ''} · top: ${topUsers}`)
            + row('overlap removed', `drone-hrs ${puHm(totDrone)} − air ${puHm(totAir)} = <b>${puHm(totDrone - totAir)}</b> of concurrent flying not double-counted`)
            + `<div style="color:#666;margin-top:6px">Air time is time with ≥1 drone airborne — a FLOOR on pilot busy-time. Not in it: pre-flight checks, waiting on charge / dock cycles, weather holds, data review, driving. Attribution is the username that launched the mission (created_by_username); if a scheduler or CSM launches for pilots, those hours land on that account. Scope is the picked sites only — a pilot's flights on un-picked sites are missing.</div>`
            + '</div>';
    }
    // ---- flight-by-flight trace for one pilot-day (verify the union by hand against Percepto's mission log) ----
    function puDayTrace(pilot, day) {
        const R = puResults; if (!R) return '';
        const tz = R.tz; const slices = [];
        R.flights.filter(f => f.pilot === pilot).forEach(f => puDaySlices(f, tz).forEach(sl => { if (sl.day === day) slices.push({ f, s: sl.s, e: sl.e, cut: sl.s !== f.start || sl.e !== f.end }); }));
        slices.sort((a, b) => a.s - b.s);
        const merged = []; slices.forEach(sl => { const m = merged[merged.length - 1]; if (m && sl.s <= m.e) { m.e = Math.max(m.e, sl.e); m.n++; } else merged.push({ s: sl.s, e: sl.e, n: 1 }); });
        const union = merged.reduce((t, m) => t + (m.e - m.s), 0), sum = slices.reduce((t, x) => t + (x.e - x.s), 0);
        const c = (v, extra) => `<td style="padding:1px 6px;white-space:nowrap;${extra || ''}">${escapeHtml(String(v))}</td>`;
        let h = `<tr><td colspan="99" style="padding:4px 6px 8px 22px;background:#101419"><div style="color:#7adfe6;margin-bottom:3px">${escapeHtml(pilot)} · ${day} · ${slices.length} flight(s) · sum of durations ${puHm(sum / 3600000)} → union ${puHm(union / 3600000)} (${merged.length} airborne block(s))</div>`
            + '<table style="border-collapse:collapse;font:11px/1.4 monospace"><tr style="color:#888"><th style="text-align:left;padding:1px 6px">takeoff</th><th style="text-align:left;padding:1px 6px">landed</th><th style="text-align:left;padding:1px 6px">min</th><th style="text-align:left;padding:1px 6px">drone</th><th style="text-align:left;padding:1px 6px">site</th><th style="text-align:left;padding:1px 6px">mission</th><th style="text-align:left;padding:1px 6px">state</th><th style="text-align:left;padding:1px 6px">id</th></tr>'
            + slices.map(x => `<tr>${c(puClock(x.s, tz) + (x.cut && x.s !== x.f.start ? ' (cont.)' : ''))}${c(puClock(x.e, tz) + (x.cut && x.e !== x.f.end ? ' (→ next day)' : ''))}${c(Math.round((x.e - x.s) / 60000), 'text-align:right')}${c(x.f.drone)}${c(x.f.site)}${c(x.f.name)}${c(x.f.state)}<td style="padding:1px 6px"><a href="${location.origin}/#/site/${x.f.sid}/control-panel/past-mission/${x.f.id}" target="_blank" rel="noopener" style="color:#7adfe6">${x.f.id} ↗</a></td></tr>`).join('')
            + '</table><div style="color:#888;margin-top:4px">airborne blocks: ' + merged.map(m => `${puClock(m.s, tz)}–${puClock(m.e, tz)} (${Math.round((m.e - m.s) / 60000)} min, ${m.n} flight${m.n > 1 ? 's' : ''})`).join(' · ') + '</div></td></tr>';
        return h;
    }
    function renderPuRules() {
        const sids = Array.from(fdSelected).sort((a, b) => siteName(a).localeCompare(siteName(b)));
        if (!sids.length) return '<div style="padding:4px 10px;color:#666">pick sites in 📦 Fleet Data to set their rules</div>';
        const dis = puRun ? 'disabled' : '';
        const inp = 'background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;padding:1px 3px;';
        const today = puDayKey(Date.now(), puOpts.tz); const memo = {};
        const cnt = { '247': 0, day: 0, night: 0, custom: 0, one: 0 }; sids.forEach(sid => { const r = puRuleOf(sid); cnt[r.w] = (cnt[r.w] || 0) + 1; if (r.one) cnt.one++; });
        let h = `<div style="border:1px solid #2a3140;border-radius:4px;margin-bottom:6px;background:#10141a">`
            + `<div style="padding:4px 8px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;color:#888">${sids.length} picked: 24/7 ${cnt['247']} · day ${cnt.day} · night ${cnt.night} · custom ${cnt.custom} · <b style="color:#ffb347">1:1 ${cnt.one}</b>`
            + ` <span style="margin-left:auto">set all picked to <select data-pu-bulk ${dis} style="${inp}">${Object.entries(PU_WINDOWS).map(([k, l]) => `<option value="${k}" ${puBulkW === k ? 'selected' : ''}>${l}</option>`).join('')}</select> <span data-ft="pu-rules-apply" style="cursor:pointer;color:#5fff5f">apply</span> · <span data-ft="pu-rules-clear" style="cursor:pointer;color:#ff7a7a" title="remove the rules of every picked site (back to 24/7, not 1:1, drones = seen)">reset picked</span></span></div>`
            + '<div style="max-height:220px;overflow:auto"><table style="border-collapse:collapse;font:11px/1.4 monospace;width:100%"><tr style="color:#888"><th style="text-align:left;padding:2px 6px">site</th><th style="text-align:left;padding:2px 6px">window</th><th style="text-align:left;padding:2px 6px">custom from–to</th><th style="text-align:left;padding:2px 6px" title="pilot must stay dedicated to this drone">1:1</th><th style="text-align:left;padding:2px 6px" title="drones based here (blank = as seen in the log, min 1)">drones</th><th style="text-align:left;padding:2px 6px">☀ today</th></tr>';
        sids.forEach(sid => {
            const r = puRuleOf(sid); const raw = rawSites && rawSites[sid] && rawSites[sid].raw; const c = raw && siteEntryCenter(raw);
            let sun = '<span style="color:#ff7a7a" title="no site centre in /sites/ — day/night falls back to 24/7">no centre</span>';
            if (c) { const st = puSunTimes(c.lat, c.lng, today); sun = st.polar ? `polar ${st.polar}` : `${puClock(st.rise, puOpts.tz)}–${puClock(st.set, puOpts.tz)}`; }
            const seen = puResults ? new Set(puResults.flights.filter(f => f.sid === sid && f.drone).map(f => f.drone)).size : 0;
            h += `<tr class="aim-ft-row"><td style="padding:1px 6px;white-space:nowrap">${escapeHtml(siteName(sid))} <span style="color:#555">#${sid}</span></td>`
                + `<td style="padding:1px 6px"><select data-pu-rule="${sid}|w" ${dis} style="${inp}">${Object.entries(PU_WINDOWS).map(([k, l]) => `<option value="${k}" ${r.w === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>`
                + `<td style="padding:1px 6px;white-space:nowrap"><input type="time" data-pu-rule="${sid}|from" value="${escapeHtml(r.from)}" ${r.w === 'custom' ? '' : 'disabled'} ${dis} style="${inp}width:78px"> – <input type="time" data-pu-rule="${sid}|to" value="${escapeHtml(r.to)}" ${r.w === 'custom' ? '' : 'disabled'} ${dis} style="${inp}width:78px"></td>`
                + `<td style="padding:1px 6px"><input type="checkbox" data-pu-rule="${sid}|one" ${r.one ? 'checked' : ''} ${dis}></td>`
                + `<td style="padding:1px 6px"><input type="number" data-pu-rule="${sid}|drones" value="${r.drones != null ? r.drones : ''}" placeholder="${seen || 1}" min="0" step="1" ${dis} style="${inp}width:44px"></td>`
                + `<td style="padding:1px 6px;color:#888;white-space:nowrap">${sun}</td></tr>`;
        });
        return h + '</table></div></div>';
    }
    function renderPilotSection() {
        if (!openSections.pilots) return '';
        const dis = puRun ? 'disabled' : '';
        const num = (k, w, min, step) => `<input type="number" data-pu-opt="${k}" value="${puOpts[k]}" min="${min}" step="${step || 1}" ${dis} style="width:${w}px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;padding:1px 3px;">`;
        let h = '<div style="padding:8px 10px;border-bottom:1px solid #222834">'
            + `<div style="color:#888;margin-bottom:6px">Scope = the sites picked in 📦 Fleet Data (<b style="color:#ddd">${fdSelected.size}</b> picked) · flights in the last ${num('days', 48, 1)} days · shift ${num('shiftHrs', 40, 1, 0.5)} h · ignore flights under ${num('minMin', 40, 0)} min · days in `
            + `<select data-pu-tz ${dis} style="background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;">${PU_TZS.map(t => `<option value="${t[0]}" ${puOpts.tz === t[0] ? 'selected' : ''}>${t[1]}</option>`).join('')}</select>`
            + ` · flight end = <select data-pu-end ${dis} title="duration: launch + the log's duration field · landed: the log's landed timestamp (also rescues rows with no duration)" style="background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;"><option value="duration" ${puOpts.endMode !== 'landed' ? 'selected' : ''}>launch + duration</option><option value="landed" ${puOpts.endMode === 'landed' ? 'selected' : ''}>landed time</option></select> · <label title="drop columns that are 0 / blank on every row of the tab (panel + exports)" style="cursor:pointer"><input type="checkbox" data-pu-chk="hideEmpty" ${puOpts.hideEmpty ? 'checked' : ''} ${dis}> hide empty columns</label></div>`
            + `<div style="color:#888;margin-bottom:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:center"><span data-ft="pu-rules" title="per site: 24/7 / day only / night only / custom window · 1:1 (pilot locked to the drone) · drones based there" style="cursor:pointer;color:${puShowRules ? '#14181f' : '#7adfe6'};background:${puShowRules ? '#7adfe6' : 'transparent'};border:1px solid #7adfe6;padding:2px 8px;border-radius:3px;font-weight:bold">⚙ Site rules — day / night / 1:1 (${Object.keys(puRules).length} set)</span> <span>day = sunrise − <input type="number" data-pu-opt="twilightMin" value="${puOpts.twilightMin}" min="0" step="5" ${dis} style="width:44px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;padding:1px 3px;"> min … sunset + same (at the site\'s own coordinates)</span></div>`
            + (puShowRules ? renderPuRules() : '')
            + '<div style="color:#666;margin-bottom:6px">Air time = the UNION of a pilot\'s flight intervals per day — two drones up in the same 30 min count 30 min once. Drone-hrs = plain sum of durations. Util % = air time per active day ÷ shift hours. Flights that cross midnight are split at midnight.</div>'
            + (puRun
                ? `<span style="color:#7adfe6">${escapeHtml(puRun.msg)}</span> <span data-ft="pu-abort" style="cursor:pointer;color:#ff7a7a;margin-left:10px">✕ abort</span><div style="height:5px;background:#222834;border-radius:3px;margin-top:6px"><div style="height:5px;width:${puRun.total ? Math.round(100 * puRun.done / puRun.total) : 0}%;background:#7adfe6;border-radius:3px"></div></div>`
                : `<span data-ft="pu-run" style="cursor:pointer;color:${fdSelected.size ? '#5fff5f' : '#555'};border:1px solid #2a3140;padding:2px 8px;border-radius:3px;font-weight:bold">▶ Pilot utilization</span>`
                  + (Object.keys(puLogCache).length ? ` <span data-ft="pu-clear" style="cursor:pointer;color:#888;margin-left:10px" title="forget the fetched logs (${Object.keys(puLogCache).length} site-windows) so the next run re-fetches">🗑 clear cache</span>` : ''))
            + '</div>';
        if (!puResults) return h + '<div style="padding:8px 10px;color:#666">No run yet. Pick sites in Fleet Data (☑ select shown = every site you can see), set the window, then ▶ Pilot utilization.</div>';
        const R = puResults;
        const chip = (v, l, c) => `<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 9px;border:1px solid ${c || '#2a3140'};border-radius:5px"><b style="color:${c || '#ddd'};font-size:14px">${v}</b> <span style="color:#888">${l}</span></span>`;
        const totAir = R.pilotDays.reduce((s, d) => s + d.air, 0), totDrone = R.pilotDays.reduce((s, d) => s + d.droneH, 0);
        const sk = Object.entries(R.skipped || {}).map(([k, v]) => `${v} ${k}`).join(' · ');
        h += '<div style="padding:8px 10px;border-bottom:1px solid #222834">'
            + chip(R.pilots.length, 'pilots', '#7adfe6') + chip(R.flights.length, 'flights') + chip(R.pilotDays.length, 'pilot-days') + chip(puHm(totAir), 'air time', '#5fff5f') + chip(puHm(totDrone), 'drone-hrs') + chip(totAir ? (totDrone / totAir).toFixed(2) + '×' : '–', 'drones in the air ⌀', '#ffd54f')
            + chip(R.pilotDays.length ? puPct(totAir / R.pilotDays.length / R.shiftHrs) + '%' : '–', `util of ${R.shiftHrs} h shift ⌀`, '#ffb347')
            + chip((R.drones || []).length, 'drones seen') + chip(R.fleetPeak || 0, 'drones airborne at peak', '#7adfe6')
            + chip(`${R.poolDrones || 0}`, 'drones in pool (rules)') + chip(puHm(R.availTotalH || 0), 'flyable drone-hrs') + chip(R.availTotalH ? puPct(R.poolUtil) + '%' : '–', 'pool util', '#ffd54f')
            + `<div style="color:#666">${R.from} → ${R.to} · ${R.tz} · ${R.sites.length} site(s)${sk ? ` · skipped: ${escapeHtml(sk)}` : ''}${R.aborted ? ' · <b style="color:#ff7a7a">ABORTED — partial</b>' : ''}</div>`
            + (R.errors && R.errors.length ? `<div style="color:#ff7a7a">${R.errors.length} error(s): ${R.errors.slice(0, 3).map(escapeHtml).join(' · ')}${R.errors.length > 3 ? ' …' : ''}</div>` : '')
            + '<div style="margin-top:4px">' + [['pilots', 'Pilots'], ['days', 'Pilot-days'], ['dates', 'Dates'], ['drones', 'Drones'], ['hours', 'Hours'], ['flights', 'Flights']].map(([t, l]) => `<span data-ft="pu-tab-${t}" style="cursor:pointer;margin-right:12px;${puTab === t ? 'color:#7adfe6;font-weight:bold;border-bottom:1px solid #7adfe6' : 'color:#888'}">${l}</span>`).join('')
            + '<span data-ft="pu-sheets" style="cursor:pointer;color:#ffd54f;margin-left:14px" title="this tab, current sort, as a table for Google Sheets / Excel">📊 Copy → Sheets</span>'
            + '<span data-ft="pu-csv" style="cursor:pointer;color:#5fff5f;margin-left:10px" title="this tab, current sort, as CSV">⬇ CSV</span>'
            + `<span data-ft="pu-check" style="cursor:pointer;color:${puShowCheck ? '#7adfe6' : '#888'};margin-left:10px" title="audit the fetched log rows: states, durations, landed-vs-duration, same-drone overlaps, attribution">🔬 Data check</span>`
            + '<span style="color:#666;margin-left:10px">click a column header to sort · Pilot-days: click a row for its flights</span></div></div>';
        if (puShowCheck) h += puDataCheck();
        const st = puSort[puTab]; const rows = puSorted(puTab); const vis = puVisibleCols(puTab, rows); const cols = vis.cols;
        if (vis.hidden.length) h += `<div style="padding:2px 10px;color:#666;font-size:11px">hidden (all zero / blank): ${vis.hidden.map(escapeHtml).join(' · ')}</div>`;
        const cell = (c, r) => { const v = c.get(r); const txt = c.fmt ? c.fmt(v, r) : (v == null ? '' : String(v)); const tip = typeof c.title === 'function' ? c.title(r) : ''; return `<td style="padding:2px 6px;white-space:nowrap;border-bottom:1px solid #1e2430;${typeof v === 'number' ? 'text-align:right' : ''}" ${tip ? `title="${escapeHtml(tip)}"` : ''}>${escapeHtml(txt)}</td>`; };
        h += `<div style="overflow:auto;max-height:50vh"><table style="border-collapse:collapse;font:11px/1.4 monospace;width:100%"><tr>`
            + cols.map(c => `<th data-pu-sort="${c.key}" title="${escapeHtml(typeof c.title === 'string' ? c.title : 'sort')}" style="text-align:left;padding:2px 6px;position:sticky;top:0;background:#14181f;cursor:pointer;white-space:nowrap;color:${st.key === c.key ? '#7adfe6' : '#888'}">${escapeHtml(c.label)}${st.key === c.key ? (st.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('') + '</tr>'
            + rows.slice(0, 2000).map(r => { const dk = puTab === 'days' ? `${r.pilot}|${r.day}` : null; return `<tr class="aim-ft-row"${puTab === 'flights' ? ` data-pu-flight="${r.sid}/${r.id}"` : ''}${dk ? ` data-pu-day="${escapeHtml(dk)}" style="cursor:pointer;${puOpenDay === dk ? 'background:#1a2029' : ''}"` : ''}>${cols.map(c => cell(c, r)).join('')}</tr>` + (dk && puOpenDay === dk ? puDayTrace(r.pilot, r.day) : ''); }).join('')
            + '</table>' + (rows.length > 2000 ? `<div style="padding:4px 10px;color:#888">showing 2000 of ${rows.length} — exports carry every row</div>` : '') + '</div>';
        return h;
    }

    // ==================================================================
    // UI — floating button on the landing page + sectioned panel
    // ==================================================================
    let buttonEl = null;
    let panelEl = null;
    // v0.31: every section starts COLLAPSED (user request) — open what you need.
    let openSections = { issues: false, data: false, fc: false, pilots: false, sweep: false, map: false, kml: false, xref: false, metrics: false };
    // v0.25 (#257): 🚩 Fleet Issues front door. AIM Issues owns the engine +
    // panel (one copy of the merge/Slack/role rules); we ask it for a summary
    // and open it over tab-local DOM events on `document` (NOT the
    // BroadcastChannel — that reaches every tab).
    let issuesSummary = null;        // last 'aim-fleet:issues-summary' detail
    let issuesRequestedAt = 0;
    function setupIssuesBridge() {
        document.addEventListener('aim-fleet:issues-summary', (ev) => {
            issuesSummary = (ev && ev.detail) || null;
            renderPanel();
            syncButtonBadge();
        });
    }
    function requestIssuesSummary() {
        issuesRequestedAt = Date.now();
        try { document.dispatchEvent(new CustomEvent('aim-fleet:issues-request')); }
        catch (e) { console.warn(`${TAG} issues-request event threw:`, e); }
    }
    function openFleetIssues() {
        try { document.dispatchEvent(new CustomEvent('aim-fleet:open-issues')); }
        catch (e) { console.warn(`${TAG} open-issues event threw:`, e); }
        if (!issuesSummary) setTimeout(() => { if (!issuesSummary) setStatus('AIM Issues v1.41+ not detected — install/update it to use Fleet Issues'); }, 1500);
    }
    function syncButtonBadge() {
        if (!buttonEl) return;
        const s = issuesSummary;
        const n = s ? (s.myPending || s.open + s.pending) : 0;
        buttonEl.textContent = '⚠ Fleet Tools' + (n ? ` · 🚩${n}` : '');
    }
    function renderIssuesSection() {
        if (!openSections.issues) return '';
        const s = issuesSummary;
        const out = [];
        out.push('<div style="padding:6px 10px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + '<span data-ft="issues-open" style="cursor:pointer;color:#5fff5f;font-weight:bold">🌐 Open Fleet Issues</span>'
            + '<span data-ft="issues-refresh" style="cursor:pointer;color:#7adfe6" title="Ask AIM Issues for a fresh summary">⟳</span>'
            + '</div>');
        if (!s) {
            const waiting = issuesRequestedAt && Date.now() - issuesRequestedAt < 2500;
            out.push(`<div style="padding:8px 10px;color:#888">${waiting ? 'Asking AIM Issues…' : 'No answer from AIM Issues — it needs v1.41+ installed and enabled (Tampermonkey → Check for updates).'}</div>`);
            return out.join('');
        }
        if (!s.hasToken) {
            out.push('<div style="padding:8px 10px;color:#ffa030">No GitHub token — save your PAT in AIM Controls (gear inside any site) to load issues.</div>');
            return out.join('');
        }
        const pill = (label, n, bg, fg, title) => `<span title="${escapeHtml(title || '')}" style="display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:10px;background:${bg};color:${fg};font-weight:bold">${label} ${n}</span>`;
        out.push('<div style="padding:8px 10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'
            + pill('OPEN', s.open, '#ff4d4d', '#fff', 'open issues across all your sites')
            + pill('PENDING', s.pending, '#8000FF', '#fff', 'proposals awaiting an approver')
            + (s.myPending ? pill('⚡ MY REVIEW', s.myPending, '#ffa726', '#000', 'pending proposals YOU can approve') : '')
            + (s.unseen ? pill('? UNSEEN', s.unseen, '#00FF7F', '#003318', 'issues with activity you have not viewed') : '')
            + `<span style="color:#888">${s.total} live · ${s.sites} site(s)${s.hiddenNoAccess ? ` · ${s.hiddenNoAccess} hidden (no access)` : ''}${s.loading ? ' · ⏳ loading…' : ''}</span>`
            + '</div>');
        if (s.error) out.push(`<div style="padding:0 10px 8px 10px;color:#ffa030">⚠ ${escapeHtml(s.error)}</div>`);
        out.push('<div style="padding:0 10px 8px 10px;color:#666">Review, approve, comment and bulk-clear every site\'s issues from one panel — AIM Issues v' + escapeHtml(String(s.version || '')) + '.</div>');
        return out.join('');
    }
    let kmlSearch = '';

    function flyToBbox(b) {
        const map = getLandingMap();
        if (!map || !b || !isFinite(b.minLat)) return;
        try { map.fitBounds([[b.minLat, b.minLng], [b.maxLat, b.maxLng]]); } catch (e) { console.warn(`${TAG} fitBounds failed:`, e); }
    }
    function ptsBbox(pts) {
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        pts.forEach(p => {
            if (p[0] < minLat) minLat = p[0];
            if (p[0] > maxLat) maxLat = p[0];
            if (p[1] < minLng) minLng = p[1];
            if (p[1] > maxLng) maxLng = p[1];
        });
        return { minLat, minLng, maxLat, maxLng };
    }

    async function kmlSaveToRepo(ly) {
        if (!cachedToken) { setStatus('GitHub token needed (AIM Controls gear)'); return; }
        try {
            setStatus(`saving "${ly.name}" to GitHub…`);
            const fname = ly.name.replace(/[^\w\- .]/g, '_') + (ly.ext || '.kml');
            const sha = await kmlRepoPut(fname, ly.rawText);
            const newId = `repo:${fname}`;
            kmlStyles[newId] = kmlStyleFor(ly.id);   // carry the style over
            delete kmlStyles[ly.id];
            saveKmlStyles();
            Object.assign(ly, { id: newId, source: 'repo', repoName: fname, sha });
            // GitHub's listing lags fresh commits — append to the cached
            // list directly instead of trusting an immediate re-list
            const cached = loadJson(KEY_KML_LIST, []) || [];
            if (!cached.some(x => x.name === fname)) {
                cached.push({ name: fname, sha });
                gmSet(KEY_KML_LIST, JSON.stringify(cached));
            }
            setStatus(`"${ly.name}" saved to GitHub — persistent for every session ✓`);
        } catch (e) { setStatus(`save failed — ${String(e && e.message || e)}`); }
        renderPanel();
    }

    async function kmlDelete(ly) {
        if (ly.source === 'session') {
            kmlLayers = kmlLayers.filter(l => l.id !== ly.id);
            delete kmlStyles[ly.id];
            saveKmlStyles();
            renderPanel();
            renderOverlay();
            return;
        }
        // Repo delete is destructive — double-click ARM (project convention)
        if (!kmlDeleteArm || kmlDeleteArm.id !== ly.id || Date.now() - kmlDeleteArm.at > 5000) {
            kmlDeleteArm = { id: ly.id, at: Date.now() };
            renderPanel();
            setStatus(`click ✕ again within 5s to DELETE "${ly.name}" from GitHub for everyone`);
            setTimeout(() => { if (kmlDeleteArm && Date.now() - kmlDeleteArm.at >= 5000) { kmlDeleteArm = null; renderPanel(); } }, 5200);
            return;
        }
        kmlDeleteArm = null;
        try {
            const list = await kmlRepoList(true);   // fresh sha
            const f = list.find(x => x.name === ly.repoName);
            if (f) await kmlRepoDelete(ly.repoName, f.sha);
            kmlLayers = kmlLayers.filter(l => l.id !== ly.id);
            delete kmlStyles[ly.id];
            saveKmlStyles();
            setStatus(`deleted "${ly.name}" from GitHub`);
        } catch (e) { setStatus(`delete failed — ${String(e && e.message || e)}`); }
        renderPanel();
        renderOverlay();
    }

    function renderKmlSection() {
        if (!openSections.kml) return '';
        const rows = [];
        rows.push('<div style="padding:6px 10px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + '<span data-ft="kml-upload" style="cursor:pointer;color:#5fff5f;font-weight:bold">⬆ Load KML…</span>'
            + '<span data-ft="kml-refresh" style="cursor:pointer;color:#7adfe6" title="Re-list saved layers from GitHub (fixes a saved layer not showing)">⟳</span>'
            + '<span style="color:#666">session-only until 💾 · ☁ = in GitHub · .kml / .geojson · KMZ: unzip first</span>'
            + '<input id="aim-ft-kml-file" type="file" multiple accept=".kml,.geojson,.json" style="display:none">'
            + `<input id="aim-ft-kml-search" type="text" placeholder="Search layers/features…" value="${escapeHtml(kmlSearch)}" style="flex:1;min-width:90px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 6px;font:inherit;outline:none;">`
            + '</div>');
        if (!kmlLayers.length) {
            rows.push('<div style="padding:6px 10px;color:#888">No KML layers yet.' + (cachedToken ? '' : ' <span style="color:#ffa030">(GitHub token needed to see saved layers)</span>') + '</div>');
        }
        const q = kmlSearch.trim().toLowerCase();
        const featHits = [];
        const num = 'width:46px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;padding:1px 3px;';
        kmlLayers.forEach(ly => {
            const nameHit = !q || ly.name.toLowerCase().includes(q);
            if (q && ly.features) {
                ly.features.forEach((f, fi) => {
                    if (featHits.length < 20 && f.name && f.name.toLowerCase().includes(q)) featHits.push({ ly, f, fi });
                });
            }
            if (!nameHit) return;
            const st = kmlStyleFor(ly.id);
            const meta = ly.features ? `${ly.features.length}f · ${ly.vertexCount}v` : 'not loaded';
            const armed = kmlDeleteArm && kmlDeleteArm.id === ly.id && Date.now() - kmlDeleteArm.at < 5000;
            rows.push(`<div style="padding:3px 10px;border-bottom:1px solid #1d2430;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">`
                + `<input type="checkbox" data-kml-show="${ly.id}" ${st.show ? 'checked' : ''} title="show/hide on the map">`
                + `<input type="color" data-kml-color="${ly.id}" value="${st.color}" title="layer color" style="width:26px;height:18px;padding:0;border:none;background:none;cursor:pointer;">`
                + `<span style="flex:1;min-width:80px;">${escapeHtml(ly.name)} <span style="color:#666">${ly.source === 'repo' ? '☁' : 'session'} · ${escapeHtml(meta)}</span></span>`
                + `<label style="color:#888" title="line width">w <input type="number" data-kml-width="${ly.id}" value="${st.width}" min="0.5" max="10" step="0.5" style="${num}"></label>`
                + `<label style="color:#888" title="fill polygons"><input type="checkbox" data-kml-fill="${ly.id}" ${st.fill ? 'checked' : ''}> fill</label>`
                + `<label style="color:#888" title="opacity">op <input type="number" data-kml-op="${ly.id}" value="${st.opacity}" min="0.1" max="1" step="0.1" style="${num}"></label>`
                + `<span data-kml-fly="${ly.id}" style="cursor:pointer" title="fly to this layer">🎯</span>`
                + (ly.source === 'session' ? `<span data-kml-save="${ly.id}" style="cursor:pointer;color:#7adfe6" title="Save to GitHub — persistent, shared across sessions">💾</span>` : '')
                + `<span data-kml-del="${ly.id}" style="cursor:pointer;color:#ff5252" title="${ly.source === 'repo' ? 'Delete from GitHub (click twice to confirm)' : 'Remove this session layer'}">${armed ? '⚠ sure?' : '✕'}</span>`
                + '</div>');
        });
        featHits.forEach(h => {
            rows.push(`<div style="padding:2px 10px 2px 30px;border-bottom:1px solid #1d2430;color:#aaa;">`
                + `↳ ${escapeHtml(h.f.name)} <span style="color:#666">(${escapeHtml(h.ly.name)} · ${h.f.type})</span> `
                + `<span data-kml-flyf="${h.ly.id}|${h.fi}" style="cursor:pointer">🎯</span></div>`);
        });
        return rows.join('');
    }

    function renderXrefSection() {
        if (!openSections.xref) return '';
        // A lone <select> option never fires 'change', so the state must
        // default to what the dropdown displays — also self-heals when the
        // chosen layer's id changed (💾 save) or the layer was removed
        if (!kmlLayerById(xrefSrcSel)) xrefSrcSel = kmlLayers.length ? kmlLayers[0].id : '';
        if (!String(xrefTgtSel).startsWith('sites') && xrefTgtSel !== 'bases' && !kmlLayerById(xrefTgtSel)) xrefTgtSel = 'sites';
        const sel = 'background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 4px;font:inherit;max-width:180px;';
        const num = 'width:52px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;padding:1px 3px;';
        const srcOpts = kmlLayers.map(ly => `<option value="${ly.id}" ${xrefSrcSel === ly.id ? 'selected' : ''}>${escapeHtml(ly.name)}</option>`).join('');
        const tgtOpts = `<option value="sites" ${xrefTgtSel === 'sites' ? 'selected' : ''}>Site FFZs + FPs (existing coverage)</option>`
            + `<option value="sites-ffz" ${xrefTgtSel === 'sites-ffz' ? 'selected' : ''}>Site FFZs ONLY (mission-step airspace)</option>`
            + `<option value="sites-fp" ${xrefTgtSel === 'sites-fp' ? 'selected' : ''}>Site FPs ONLY</option>`
            + `<option value="bases" ${xrefTgtSel === 'bases' ? 'selected' : ''}>Base stations — straight-line range (Tattu / Tulip, no shielding)</option>`
            + kmlLayers.filter(ly => ly.id !== xrefSrcSel).map(ly => `<option value="${ly.id}" ${xrefTgtSel === ly.id ? 'selected' : ''}>KML: ${escapeHtml(ly.name)}</option>`).join('');
        const running = xrefState && xrefState.running;
        const rows = [];
        rows.push('<div style="padding:6px 10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + `<label>Source <select data-xr="src" style="${sel}">${srcOpts || '<option value="">(load a KML first)</option>'}</select></label>`
            + `<label>vs <select data-xr="tgt" style="${sel}">${tgtOpts}</select></label>`
            + (xrefTgtSel !== 'bases' && !String(xrefTgtSel).startsWith('sites') ? ''
                : `<label title="Only sites whose NAME contains one of these comma-separated words count (e.g. Exxon, Diamondback). Empty = every site you can access.">sites: <input type="text" id="aim-ft-xr-sites" value="${escapeHtml(xrefSiteFilter)}" placeholder="all (e.g. Exxon)" ${xrefUsePicked ? 'disabled' : ''} style="width:110px;background:#0e1218;color:${xrefUsePicked ? '#666' : '#ddd'};border:1px solid #2a3140;border-radius:3px;font:inherit;padding:1px 4px;"></label>`
                  + `<label title="Use the sites ticked in 📦 Fleet Data as the ONLY targets" style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" id="aim-ft-xr-picked" ${xrefUsePicked ? 'checked' : ''}> picked only <span style="color:${fdSelected.size ? '#5fff5f' : '#888'}">(${fdSelected.size})</span></label>`)
            + (xrefTgtSel === 'bases'
                ? `<label title="Tattu one-way range from the base">Tattu ≤<input type="number" data-ft-num="xrefBaseB1" value="${ftCfg.xrefBaseB1}" min="1000" max="60000" step="500" style="${num};width:64px"> ft</label>`
                  + `<label title="Tulip one-way range from the base">Tulip ≤<input type="number" data-ft-num="xrefBaseB2" value="${ftCfg.xrefBaseB2}" min="1000" max="80000" step="500" style="${num};width:64px"> ft</label>`
                : `<label title="inner band">≤<input type="number" data-ft-num="xrefB1" value="${ftCfg.xrefB1}" min="5" max="1000" step="5" style="${num}"> ft</label>`
                  + `<label title="outer band">≤<input type="number" data-ft-num="xrefB2" value="${ftCfg.xrefB2}" min="10" max="5000" step="10" style="${num}"> ft</label>`)
            + (running
                ? '<span data-ft="xr-abort" style="cursor:pointer;color:#ff5252;font-weight:bold">■ Abort</span>'
                : '<span data-ft="xr-run" style="cursor:pointer;color:#5fff5f;font-weight:bold">▶ Run cross-ref</span>')
            + (xrefState && xrefState.result ? '<span data-ft="xr-card" style="cursor:pointer;color:#ffd54f;font-weight:bold">📊 Report</span>' : '')
            + '<span data-ft="xr-copy" style="cursor:pointer;color:#7adfe6">📋 Copy text</span>'
            + '<span data-ft="xr-clear" style="cursor:pointer;color:#888">Clear</span>'
            + '</div>');
        if (xrefState && xrefState.error) rows.push(`<div style="padding:4px 10px;color:#ff5252">${escapeHtml(xrefState.error)}</div>`);
        if (running) rows.push('<div style="padding:6px 10px;color:#8899bb">Running… (progress in the status line up top)</div>');
        const r = xrefState && xrefState.result;
        if (r) {
            // v0.31: compact headline only — the 📊 Report card carries the detail
            const bases = r.mode === 'bases';
            const P = r.pointHits || { 0: 0, 1: 0, 2: 0 };
            const pointsOnly = !!r.pointsTotal && !(r.totalM > 0);
            const L = r.bandLenM;
            const total = pointsOnly ? r.pointsTotal : r.totalM;
            const v = (k) => pointsOnly ? P[k] : L[k];
            const f = (x) => pointsOnly ? `${x} pts` : fmtMi(x);
            const l1 = bases ? 'Tattu' : `≤${r.b1} ft`, l2 = bases ? 'Tulip only' : `${r.b1}–${r.b2} ft`;
            rows.push(`<div style="padding:6px 10px;border-bottom:1px solid #222834;line-height:1.6">`
                + `<div>"${escapeHtml(r.srcName)}" <span style="color:#888">vs</span> ${escapeHtml(r.tgtLabel)} <span style="color:#888">· ${pointsOnly ? `${r.pointsTotal} points` : fmtMi(r.totalM)}${r.sitesUsed ? ` · ${r.sitesUsed} sites checked, ${r.sitesMatched || 0} with a match` : ''}${r.pointMatches && r.pointMatches.length ? ` · <span style="color:#5fff5f">${r.pointMatches.length} matched point(s) listed in 📊 Report</span>` : ''}</span></div>`
                + `<div><b style="color:#5fff5f;font-size:14px">${f(v(1) + v(2))} (${pct(v(1) + v(2), total)})</b> <span style="color:#888">${bases ? 'reachable from a base without shielding' : 'inspectable from existing coverage'}</span>`
                + ` — <span style="color:${XREF_COLORS[1]}">${l1} ${f(v(1))}</span> · <span style="color:${XREF_COLORS[2]}">${l2} ${f(v(2))}</span> · <span style="color:${XREF_COLORS[0]}">beyond ${f(v(0))}</span></div>`
                + `<div style="color:#888">📊 Report = the full breakdown${bases ? ' per base' : ''}${r.runsTotal ? ' + longest stretches (🎯 fly-to)' : ''} · the map shows every stretch colour-coded</div>`
                + '</div>');
        }
        return rows.join('');
    }
    let expandedPair = null;   // "aId:bId"

    function onLandingPage() {
        return !!document.querySelector('.pr-sites-select-search');
    }

    function syncButton() {
        const want = onLandingPage();
        if (!want) {
            if (buttonEl) buttonEl.style.display = 'none';
            if (panelEl && !sweepRunning) panelEl.style.display = 'none';
            // SPA nav destroyed the landing map (and our overlay with it) —
            // drop the dead refs so a return to landing rebuilds from scratch
            pinData = [];
            dotData = [];
            pinsKey = null;
            setupGeomBySite = {};
            ovSvg = null; ovSetupsG = null; ovKmlG = null; ovXrefG = null; ovPinsG = null; ovMap = null;
            engReset(baseEng); engReset(faaEng);
            landingMapRef = null;
            return;
        }
        if (!buttonEl) {
            buttonEl = document.createElement('div');
            buttonEl.id = 'aim-ft-button';
            buttonEl.textContent = '⚠ Fleet Tools';
            buttonEl.title = `AIM Fleet Tools v${SCRIPT_VERSION} — fleet-wide overlap sweep + metrics (${ENV_LABEL})`;
            buttonEl.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147480000;'
                + 'background:#14181f;color:#7adfe6;border:1px solid #2a3140;border-radius:6px;'
                + 'padding:8px 14px;font:13px/1.4 monospace;cursor:pointer;user-select:none;'
                + 'box-shadow:0 4px 14px rgba(0,0,0,0.5);';
            buttonEl.addEventListener('click', () => { openPanel(); });
            document.body.appendChild(buttonEl);
            console.log(`${TAG} landing page detected — Fleet Tools button placed`);
            requestIssuesSummary();   // v0.25: badge on the button
        }
        syncButtonBadge();
        buttonEl.style.display = 'block';
        // Keep the map pins current: covers the first draw of a GM-cached
        // sweep on page load AND the redraw after returning from a site
        if (pinsKey !== sweepPinsKey()) drawSweepPins();
        // Once the overlay hooks the map, its own view events drive the
        // setup refreshes; until then keep nudging
        if (ftCfg.drawSetups && !ovMap) scheduleSetupRefresh();
    }

    function sectionHeader(key, icon, label, extra) {
        const open = openSections[key];
        return `<div data-ft-sec="${key}" style="padding:6px 10px;cursor:pointer;user-select:none;`
            + 'background:#1a2029;border-top:1px solid #2a3140;color:#7adfe6;font-weight:bold;">'
            + `${open ? '▾' : '▸'} ${icon} ${label}`
            + (extra ? ` <span style="color:#888;font-weight:normal">${extra}</span>` : '')
            + '</div>';
    }

    function renderSweepSection() {
        if (!openSections.sweep) return '';
        const rows = [];
        // config row
        const cls = NB_CLASSES.map(c =>
            `<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;">`
            + `<input type="checkbox" data-ft-class="${c.key}" ${ftCfg.classes[c.key] ? 'checked' : ''} ${sweepRunning ? 'disabled' : ''}> ${c.label}</label>`).join(' ');
        rows.push('<div style="padding:6px 10px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + `<label>threshold <input type="number" data-ft-num="thresholdFt" value="${ftCfg.thresholdFt}" min="10" max="2000" step="10" ${sweepRunning ? 'disabled' : ''} style="width:60px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 4px;font:inherit;"> ft</label>`
            + `<label>margin <input type="number" data-ft-num="marginFt" value="${ftCfg.marginFt}" min="0" max="10000" step="100" ${sweepRunning ? 'disabled' : ''} style="width:60px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 4px;font:inherit;"> ft</label>`
            + cls
            + `<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;" title="Skip sites whose /sites/ status is not 'Production' — where duplicate/OFFLINE copies should live if statuses are maintained">`
            + `<input type="checkbox" data-ft-flag="onlyProduction" ${ftCfg.onlyProduction ? 'checked' : ''} ${sweepRunning ? 'disabled' : ''}> Production only</label>`
            + `<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;" title="Draw a pin on the landing map at each conflicting pair's closest approach">`
            + `<input type="checkbox" data-ft-flag="showOnMap" ${ftCfg.showOnMap ? 'checked' : ''}> Conflict pins</label>`
            + `<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;" title="Draw FFZs/flight paths/assets of the sites in view on the landing map — zoom in to at least level 12; nearest ${SETUP_SITE_CAP} sites, honors the Show/client filters">`
            + `<input type="checkbox" data-ft-flag="drawSetups" ${ftCfg.drawSetups ? 'checked' : ''}> Site setups (zoom in)</label>`
            + '</div>');
        // action row
        rows.push('<div style="padding:6px 10px;display:flex;gap:14px;flex-wrap:wrap;border-bottom:1px solid #222834;">'
            + (sweepRunning
                ? '<span data-ft="abort" style="cursor:pointer;color:#ff5252;font-weight:bold">■ Abort sweep</span>'
                : '<span data-ft="run" style="cursor:pointer;color:#5fff5f;font-weight:bold">▶ Run overlap sweep</span>')
            + '<span data-ft="copy" style="cursor:pointer;color:#7adfe6">📋 Copy report</span>'
            + '<span data-ft="index" style="cursor:pointer;color:#ffa030" title="Re-check every Site Watch snapshot sha and refetch changed ones">⟳ Update index</span>'
            + '</div>');
        if (!lastSweep) {
            rows.push('<div style="padding:8px 10px;color:#888">No sweep run yet on this browser.</div>');
            return rows.join('');
        }
        if (lastSweep.error) rows.push(`<div style="padding:4px 10px;color:#ff5252">Last sweep FAILED: ${escapeHtml(lastSweep.error)}</div>`);
        const vis = visiblePairs();
        const hidden = lastSweep.pairs.length - vis.length;
        rows.push(`<div style="padding:4px 10px;color:#aaa;border-bottom:1px solid #222834;">`
            + `Last run ${lastSweep.at ? new Date(lastSweep.at).toLocaleString() : '—'} · ${lastSweep.siteCount} sites → ${lastSweep.candidatePairs} candidate pair(s) → `
            + `<span style="color:${vis.length ? '#ff3d00' : '#5fff5f'};font-weight:bold">${vis.length} conflicting pair(s)</span>`
            + (hidden ? ` <span style="color:#888">(+${hidden} hidden by view filters / turned-off sites)</span>` : '')
            + (lastSweep.skippedStatus && lastSweep.skippedStatus.length ? ` · <span style="color:#888">${lastSweep.skippedStatus.length} skipped (non-Production)</span>` : '')
            + (lastSweep.unchecked.length ? ` · <span style="color:#ffa030">${lastSweep.unchecked.length} UNCHECKED</span>` : '')
            + '</div>');
        // View filters — display-only, instant, never re-run the sweep.
        // The 📋 report always carries the full unfiltered data.
        const vfBoxes = NB_CLASSES.map(c =>
            `<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;">`
            + `<input type="checkbox" data-ft-view="${c.key}" ${ftCfg.view[c.key] ? 'checked' : ''}> ${c.label}</label>`).join(' ');
        rows.push('<div style="padding:4px 10px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + `<span style="color:#7adfe6">Show:</span> ${vfBoxes} <span style="color:#666">(display only — 📋 report keeps everything)</span></div>`);
        // Client chips — one per name prefix, toggleable
        const clientCounts = {};
        lastSweep.pairs.forEach(p => {
            if (ftIgnore[p.aId] || ftIgnore[p.bId]) return;
            const ca = clientOf(p.aName), cb = clientOf(p.bName);
            clientCounts[ca] = (clientCounts[ca] || 0) + 1;
            if (cb !== ca) clientCounts[cb] = (clientCounts[cb] || 0) + 1;
        });
        const clientNames = Object.keys(clientCounts).sort((a, b) => a.localeCompare(b));
        if (clientNames.length > 1) {
            rows.push('<div style="padding:4px 10px;border-bottom:1px solid #222834;max-height:84px;overflow-y:auto;line-height:1.9;">'
                + '<span style="color:#7adfe6">Clients:</span> '
                + '<span data-ft-clients="all" style="cursor:pointer;color:#5fff5f">all</span> '
                + '<span data-ft-clients="none" style="cursor:pointer;color:#ff5252">none</span> '
                + clientNames.map(cl => {
                    const off = !!ftCfg.clientsOff[cl];
                    return `<span data-ft-client="${escapeHtml(cl)}" title="Toggle this client's pairs" style="cursor:pointer;border:1px solid ${off ? '#333' : '#7adfe655'};border-radius:3px;padding:0 5px;white-space:nowrap;color:${off ? '#555' : '#7adfe6'};">${escapeHtml(cl)} <span style="color:${off ? '#444' : '#888'}">${clientCounts[cl]}</span></span>`;
                }).join(' ')
                + '</div>');
        }
        // turned-off chips
        const offIds = Object.keys(ftIgnore);
        if (offIds.length) {
            rows.push('<div style="padding:4px 10px;border-bottom:1px solid #222834;color:#888;">Turned off: '
                + offIds.map(id => `<span style="white-space:nowrap">${escapeHtml(siteName(id))} <span style="color:#666">#${id}</span> `
                    + `<span data-ft-on="${id}" style="cursor:pointer;color:#5fff5f" title="Turn this site back on (re-run sweep to include it)">✕</span></span>`).join(' · ')
                + '</div>');
        }
        // pair rows — sorted by the FILTERED closest distance, hard-capped
        // so a 677-pair sweep can never flood the DOM
        const ROW_CAP = 400;
        const viewList = visibleView().list;   // memoized, pre-sorted
        viewList.slice(0, ROW_CAP).forEach(({ p, vc }) => {
            const key = `${p.aId}:${p.bId}`;
            const open = expandedPair === key;
            const min = vc[0];
            const minTxt = min.overlap ? 'OVERLAP' : `${min.ft} ft`;
            const stTag = (st) => statusTag(st) ? ` <span style="color:#ffa030;border:1px solid #ffa03055;border-radius:3px;padding:0 3px;font-size:10px;" title="/sites/ status — not Production">${escapeHtml(st)}</span>` : '';
            rows.push(`<div class="aim-ft-row" data-ft-pair="${key}" style="padding:4px 10px;cursor:pointer;border-bottom:1px solid #1d2430;">`
                + `${open ? '▾' : '▸'} <span style="color:${min.overlap ? '#ff3d00' : '#ffa030'};font-weight:bold">${minTxt}</span> `
                + `${escapeHtml(p.aName)} <span style="color:#666">#${p.aId}</span>${stTag(p.aStatus)}`
                + ` ↔ ${escapeHtml(p.bName)} <span style="color:#666">#${p.bId}</span>${stTag(p.bStatus)}`
                + ` <span style="color:#888">— ${vc.length}${p.capped ? '+' : ''} conflict(s)</span>`
                + ` <span data-ft-zoom="${key}" title="Fly the map to this conflict" style="cursor:pointer">🎯</span>`
                + (p.aSrc === 'center' || p.bSrc === 'center' ? ' <span style="color:#ffa030" title="one side was prefiltered by bare site center — no snapshot">◦center</span>' : '')
                + '</div>');
            if (open) {
                rows.push('<div style="padding:2px 10px 6px 24px;border-bottom:1px solid #1d2430;background:#10141b;">'
                    + `<div style="padding:2px 0;color:#7adfe6;"><a data-ft-link="${p.aId}" style="cursor:pointer;text-decoration:underline">open ${escapeHtml(p.aName)}</a>`
                    + ` · <a data-ft-link="${p.bId}" style="cursor:pointer;text-decoration:underline">open ${escapeHtml(p.bName)}</a>`
                    + ` · <span data-ft-off="${p.aId}" style="cursor:pointer;color:#ff5252" title="Turn off (duplicate/OFFLINE copy)">⊘ off ${escapeHtml(p.aName)}</span>`
                    + ` · <span data-ft-off="${p.bId}" style="cursor:pointer;color:#ff5252" title="Turn off (duplicate/OFFLINE copy)">⊘ off ${escapeHtml(p.bName)}</span></div>`
                    + vc.slice(0, 60).map(c =>
                        `<div style="padding:1px 0;">`
                        + `<span style="color:${c.overlap ? '#ff3d00' : '#ffa030'};font-weight:bold">${c.overlap ? 'OVERLAP' : `${c.ft} ft`}</span> `
                        + `${c.aCls.toUpperCase()} ${escapeHtml(c.aName)} ↔ ${c.bCls.toUpperCase()} ${escapeHtml(c.bName)}`
                        + ` <span style="color:#666">@ ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</span></div>`).join('')
                    + (vc.length > 60 ? `<div style="color:#888">…and ${vc.length - 60}${p.capped ? '+' : ''} more (full list via 📋 Copy report)</div>` : '')
                    + '</div>');
            }
        });
        if (viewList.length > ROW_CAP) {
            rows.push(`<div style="padding:6px 10px;color:#ffa030">Showing the ${ROW_CAP} closest pairs of ${viewList.length} — narrow with the filters above, ⊘ off duplicate sites, or 📋 Copy report for everything.</div>`);
        }
        if (!vis.length && !lastSweep.error) rows.push(`<div style="padding:6px 10px;color:#5fff5f">No site pairs conflict under ${lastSweep.thresholdFt} ft ✓</div>`);
        return rows.join('');
    }

    function renderMapSection() {
        if (!openSections.map) return '';
        const opts = Object.keys(BASEMAPS).map(k =>
            `<option value="${k}" ${ftCfg.basemap === k ? 'selected' : ''}>${BASEMAPS[k].label}</option>`).join('');
        return '<div style="padding:6px 10px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + `<label>Basemap <select data-ft-basemap style="background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 4px;font:inherit;">${opts}</select></label>`
            + `<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;" title="FAA VFR sectional chart overlay — tiles exist at zoom 8–12 (upscaled beyond)">`
            + `<input type="checkbox" data-ft-flag="faaChart" ${ftCfg.faaChart ? 'checked' : ''}> 🛩 FAA sectional</label>`
            + `<label>opacity <input type="number" data-ft-num="faaOpacity" value="${ftCfg.faaOpacity}" min="0.1" max="1" step="0.05" style="width:52px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 4px;font:inherit;"></label>`
            + `<label>Site labels <select data-ft-labels style="background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 4px;font:inherit;">`
            + `<option value="dark" ${ftCfg.siteLabels === 'dark' ? 'selected' : ''}>Dark &amp; slim</option>`
            + `<option value="default" ${ftCfg.siteLabels === 'default' ? 'selected' : ''}>Percepto default</option>`
            + `<option value="hidden" ${ftCfg.siteLabels === 'hidden' ? 'selected' : ''}>Hidden</option>`
            + '</select></label>'
            + '</div>'
            + '<div style="padding:4px 10px;color:#666;border-bottom:1px solid #222834;">Applies to this landing map only — site maps keep their Map Styler controls. Full airspace checks (obstacles/LAANC/TFR) are site-scoped in the Asset Inspector.</div>';
    }

    // ==================================================================
    // 📊 FLEET METRICS (v0.26, feature #259 phase 4) — every site's setup
    // + mission numbers in one table, computed from the Site Watch
    // snapshots (site-watch/<id>/latest.json.gz = raw /map_objects/,
    // mission-latest.json.gz = mission fingerprints). Same incremental
    // pattern as the bbox index: ONE git Trees call diffs shas, only
    // changed snapshots re-download. Own GM store so the sweep's bbox
    // index stays untouched. Freshness = Site Watch's cadence.
    // ==================================================================
    const KEY_METRICS = 'aim-ft-metrics' + ENV_SUFFIX;
    const MT_SNAP_RE = new RegExp(`^${NB_WATCH_DIR}/(\\d+)/latest\\.json\\.gz$`);
    const MT_MISSION_RE = new RegExp(`^${NB_WATCH_DIR}/(\\d+)/mission-latest\\.json\\.gz$`);
    const MT_M_PER_MI = 1609.344;
    const MT_M2_PER_ACRE = 4046.8564224;
    let mtIndex = loadJson(KEY_METRICS, { shas: {}, mshas: {}, sites: {}, missions: {}, builtAt: 0, checkedAt: 0 });
    if (!mtIndex.shas || !mtIndex.sites) mtIndex = { shas: {}, mshas: {}, sites: {}, missions: {}, builtAt: 0, checkedAt: 0 };
    // v0.42: schema stamp — when computeSetupMetrics gains fields, older per-site
    // records must be recomputed: drop the setup shas so the next build re-reads
    // every setup snapshot once (missions untouched).
    const MT_SCHEMA = 3;   // 3 = #273 nested-asset counts added
    if (mtIndex.schema !== MT_SCHEMA) { mtIndex.shas = {}; mtIndex.schema = MT_SCHEMA; mtIndex.checkedAt = 0; saveMetricsIndex(); console.log(`${TAG} metrics index schema → ${MT_SCHEMA}: setup snapshots will be re-read on the next ▶ Build`); }
    if (!mtIndex.mshas) mtIndex.mshas = {};
    if (!mtIndex.missions) mtIndex.missions = {};
    function saveMetricsIndex() { gmSet(KEY_METRICS, JSON.stringify(mtIndex)); }
    let mtBuilding = false;
    let mtSet = 'overview';       // active column set
    let mtSort = { key: 'name', dir: 1 };
    let mtFilter = '';
    let mtWide = false;
    const mtExpanded = new Set();

    // ---- asset subtype parser (copied VERBATIM from the Asset Inspector's
    // parseAssetSubtype/prettyKey so fleet numbers match the SUM panel) ----
    const MT_STATE_WORDS = ['unreachable', 'unshielded', 'empty', 'inactive', 'hy'];
    const MT_STATE_WORDSET = new Set(MT_STATE_WORDS);
    function mtPrettyKey(raw) {
        return String(raw).split(/\s+/).map(word =>
            word.split('-').map(part => {
                if (!part) return part;
                if (part.length <= 3 && part === part.toUpperCase()) return part;
                return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            }).join('-')
        ).join(' ');
    }
    function mtParseSubtype(sub) {
        const parts = String(sub || '').trim().split(' - ').map(s => s.trim()).filter(Boolean);
        const mods = [];
        while (parts.length > 1 && MT_STATE_WORDSET.has(parts[parts.length - 1].toLowerCase())) mods.push(parts.pop().toLowerCase());
        let state = 'Normal';
        for (const w of MT_STATE_WORDS) { if (mods.indexOf(w) !== -1) { state = (w === 'hy') ? 'HY' : mtPrettyKey(w); break; } }
        const typeKey = parts.length ? mtPrettyKey(parts.join(' - ')) : '';
        return { typeKey, state };
    }
    // Planar polygon area (m²) from [{lat,lng}] — equirectangular at the ring's latitude.
    function mtRingAreaM2(coords) {
        if (!Array.isArray(coords) || coords.length < 3) return 0;
        const lat0 = coords.reduce((s, p) => s + (p.lat || 0), 0) / coords.length;
        const mLat = 111320, mLng = 111320 * Math.cos(lat0 * Math.PI / 180);
        let a = 0;
        for (let i = 0, n = coords.length; i < n; i++) {
            const p = coords[i], q = coords[(i + 1) % n];
            if (!p || !q || typeof p.lat !== 'number' || typeof q.lat !== 'number') return 0;
            a += (p.lng * mLng) * (q.lat * mLat) - (q.lng * mLng) * (p.lat * mLat);
        }
        return Math.abs(a) / 2;
    }
    function mtInc(map, key, n) { if (!key) return; map[key] = (map[key] || 0) + (n == null ? 1 : n); }

    // ====================================================================
    // [#273 nested assets — shared glue] buildAssetTree(ents). Copied VERBATIM
    // into Site Setup Tools / Fleet Tools / Mission Bank Tools (reference copy:
    // ShortKeys/AIM_Asset_Tree.js). Verified live on site 1607 (2026-09-21):
    // a child asset carries top-level `parent_asset_name: "<name>"`; a root
    // has no such key; the link is a server-side FK serialised as the NAME
    // (renaming the parent cascades); names are unique per site so an exact
    // name match is unambiguous; chains are allowed (asset → Flowline → Pad).
    // Geometry is NOT a parent signal (Flowline overlaps Pump Jack 3 yet is
    // parented to the Pad) — `outsideParent` is a diagnostic only.
    // → { byId: Map<id,node>, roots, orphans }; node = { id, name, ent, parentId,
    //    parentName, rootId, depth, children[], descendants[], orphan, outsideParent }
    // ====================================================================
    function buildAssetTree(ents) {
        const assets = (ents || []).filter(e => e && e.type === 3);
        const byName = new Map();
        const byId = new Map();
        assets.forEach(e => {
            const key = String(e.name || '').trim();
            // Percepto enforces unique asset names per site; a collision here can only come
            // from whitespace variants. Keep the FIRST, warn, never guess silently.
            if (byName.has(key)) console.warn(`${typeof TAG === 'string' ? TAG : '[AIM ASSET TREE]'} duplicate asset name "${key}" (ids ${byName.get(key).id}, ${e.id}) — children link to the first`);
            else byName.set(key, e);
            byId.set(e.id, { id: e.id, name: e.name || '', ent: e, parentId: null, parentName: null,
                rootId: e.id, depth: 0, children: [], descendants: [], orphan: false, outsideParent: false });
        });
        // pass 1: resolve parent links by name
        assets.forEach(e => {
            const n = byId.get(e.id);
            const pName = typeof e.parent_asset_name === 'string' ? e.parent_asset_name.trim() : '';
            if (!pName) return;
            n.parentName = pName;
            const p = byName.get(pName);
            if (!p || p.id === e.id) { n.orphan = true; return; }
            n.parentId = p.id;
        });
        // pass 2: break cycles BEFORE any counts are taken — every member of a cycle
        // becomes an orphan root, so children[] / depth / roots stay consistent
        byId.forEach(n => {
            const seen = new Set([n.id]);
            let cur = n;
            while (cur.parentId !== null) {
                const up = byId.get(cur.parentId);
                if (!up || seen.has(up.id)) { n.orphan = true; n.parentId = null; break; }
                seen.add(up.id); cur = up;
            }
        });
        // pass 3: children from the final links, then depth / root / descendants
        byId.forEach(n => { if (n.parentId !== null) byId.get(n.parentId).children.push(n.id); });
        byId.forEach(n => {
            let cur = n, d = 0;
            while (cur.parentId !== null) { cur = byId.get(cur.parentId); d++; }
            n.depth = d; n.rootId = cur.id;
            for (let a = n.parentId === null ? null : byId.get(n.parentId); a; a = a.parentId === null ? null : byId.get(a.parentId)) a.descendants.push(n.id);
        });
        // diagnostic: centroid outside declared parent ring
        const centroid = e => { const c = e.coords || []; if (!c.length) return null;
            return { lat: c.reduce((s, p) => s + p.lat, 0) / c.length, lng: c.reduce((s, p) => s + p.lng, 0) / c.length }; };
        const pip = (pt, ring) => { let ins = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const a = ring[i], b = ring[j];
                if ((a.lat > pt.lat) !== (b.lat > pt.lat) && pt.lng < (b.lng - a.lng) * (pt.lat - a.lat) / (b.lat - a.lat) + a.lng) ins = !ins;
            } return ins; };
        byId.forEach(n => {
            if (n.parentId === null) return;
            const c = centroid(n.ent), ring = byId.get(n.parentId).ent.coords;
            if (c && Array.isArray(ring) && ring.length >= 3 && !pip(c, ring)) n.outsideParent = true;
        });
        const nodes = [...byId.values()];
        return { byId, roots: nodes.filter(n => n.parentId === null && !n.orphan), orphans: nodes.filter(n => n.orphan) };
    }

    function computeSetupMetrics(entities) {
        const m = {
            n: 0, counts: { asset: 0, ffz: 0, fp: 0, nfz: 0, gm: 0, base: 0, safe: 0, other: 0 },
            valid: { asset: [0, 0], ffz: [0, 0], fp: [0, 0], nfz: [0, 0], gm: [0, 0] },   // [validated, not]
            unshielded: 0, notes: 0,
            equip: {}, states: { Normal: 0, HY: 0, Empty: 0, Inactive: 0, Unshielded: 0, Unreachable: 0 }, cats: {},
            ffzAcres: 0, ffzBandFtSum: 0, ffzBandN: 0, nfzAcres: 0,
            fpArcs: 0, fpM: 0, fpBandFtSum: 0, fpBandN: 0,
            gmTypes: {}, baseActive: 0,
            apprArcs: 0, apprFps: 0, apprList: [],   // v0.42: arcs flagged wait_until_approved ("approval required")
            nested: 0, nestParents: 0,               // v0.44 #273: assets with a parent_asset_name / assets that have children
        };
        try {
            buildAssetTree(entities).byId.forEach(n => { if (n.depth > 0) m.nested++; if (n.children.length) m.nestParents++; });
        } catch (err) { console.warn(`${TAG} nested-asset metrics failed:`, err); }
        const V = (k, e) => { m.valid[k][e.validated ? 0 : 1]++; };
        (entities || []).forEach(e => {
            if (!e || typeof e.type !== 'number') return;
            m.n++;
            if (e.is_unshielded) m.unshielded++;
            if (typeof e.description === 'string' && e.description.trim() && e.type !== 3) m.notes++;
            const c = entityCoords(e);
            switch (e.type) {
                case 3: {
                    m.counts.asset++; V('asset', e);
                    const sub = e.custom && typeof e.custom.poi_type_str === 'string' ? e.custom.poi_type_str : '';
                    const p = mtParseSubtype(sub);
                    if (p.typeKey) mtInc(m.equip, p.typeKey);
                    mtInc(m.states, p.state);
                    if (p.state === 'Unshielded' && !e.is_unshielded) m.unshielded++;
                    const cat = typeof e.description === 'string' && /Cat:\s*([^|]+)/i.exec(e.description);
                    if (cat) mtInc(m.cats, cat[1].trim());
                    break;
                }
                case 16: {
                    m.counts.ffz++; V('ffz', e);
                    m.ffzAcres += mtRingAreaM2(c) / MT_M2_PER_ACRE;
                    const r = e.restrictions;
                    if (r && typeof r.minAlt === 'number' && typeof r.maxAlt === 'number') { m.ffzBandFtSum += (r.maxAlt - r.minAlt) * FT_PER_M; m.ffzBandN++; }
                    break;
                }
                case 4: { m.counts.nfz++; V('nfz', e); m.nfzAcres += mtRingAreaM2(c) / MT_M2_PER_ACRE; break; }
                case 15: {
                    m.counts.fp++; V('fp', e);
                    let appr = 0, tot = 0;
                    (Array.isArray(e.arcs) ? e.arcs : []).forEach(a => {
                        if (!a) return;
                        m.fpArcs++; tot++;
                        if (a.wait_until_approved) appr++;
                        if (typeof a.distance === 'number') m.fpM += a.distance;
                        if (typeof a.min_alt === 'number' && typeof a.max_alt === 'number') { m.fpBandFtSum += (a.max_alt - a.min_alt) * FT_PER_M; m.fpBandN++; }
                    });
                    if (appr) { m.apprArcs += appr; m.apprFps++; m.apprList.push({ id: e.id, name: e.name || `FP ${e.id}`, appr, arcs: tot }); }
                    break;
                }
                case 19: { m.counts.gm++; V('gm', e); mtInc(m.gmTypes, String(e.general_marker_type || 'general')); break; }
                case 8:  { m.counts.base++; if (e.custom && e.custom.active) m.baseActive++; break; }
                case 98: { m.counts.safe++; break; }
                default: m.counts.other++;
            }
        });
        m.ffzAcres = Math.round(m.ffzAcres * 10) / 10;
        m.nfzAcres = Math.round(m.nfzAcres * 10) / 10;
        m.fpM = Math.round(m.fpM);
        return m;
    }
    function computeMissionMetrics(list) {
        const m = { n: 0, active: 0, inactive: 0, steps: 0, distM: 0, durS: 0, stepTypes: {}, snapshots: 0, orbits: 0, areaMaps: 0, gem: 0, withDist: 0 };
        (Array.isArray(list) ? list : []).forEach(x => {
            if (!x) return;
            m.n++;
            if (x.active === false) m.inactive++; else m.active++;
            m.steps += Number(x.steps) || 0;
            if (typeof x.distance === 'number' && x.distance > 0) { m.distM += x.distance; m.withDist++; }
            if (typeof x.duration === 'number' && x.duration > 0) m.durS += x.duration;
            const tc = x.typeCounts || {};
            Object.keys(tc).forEach(k => mtInc(m.stepTypes, k, Number(tc[k]) || 0));
            m.snapshots += Number(tc.snapshot) || 0;
            m.orbits += Number(tc['orbit inspection']) || 0;
            m.areaMaps += (Number(tc['area mapping']) || 0) + (Number(tc['area scan']) || 0);
            if ((Number(tc.gemMode) || 0) > 0) m.gem++;
        });
        m.distM = Math.round(m.distM);
        return m;
    }

    async function mtGhTree() {
        const r = await fetchWithTimeout(
            `${GH_API}/repos/${DATA_REPO}/git/trees/${DATA_BRANCH}?recursive=1`,
            { headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github+json' } }, 30000);
        if (!r.ok) throw new Error(`tree HTTP ${r.status}`);
        const j = await r.json();
        if (!Array.isArray(j.tree)) throw new Error('unexpected tree shape');
        const setup = {}, mission = {};
        j.tree.forEach(f => {
            if (!f || f.type !== 'blob') return;
            let mm = MT_SNAP_RE.exec(f.path); if (mm) { setup[mm[1]] = f.sha; return; }
            mm = MT_MISSION_RE.exec(f.path); if (mm) mission[mm[1]] = f.sha;
        });
        return { setup, mission, truncated: !!j.truncated };
    }
    async function mtFetchGz(path) {
        const r = await fetchWithTimeout(
            `${GH_API}/repos/${DATA_REPO}/contents/${path}?ref=${DATA_BRANCH}`,
            { headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github.raw' } }, 60000);
        if (!r.ok) throw new Error(`GET ${path} HTTP ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        return JSON.parse(await nbGunzipToText(bytes));
    }

    // Build / refresh the metrics index. `force` re-checks every sha; the
    // full first build is ~450 setup + ~440 mission downloads (a few minutes).
    async function ensureMetricsIndex(progress, force) {
        const notes = [];
        if (!cachedToken) {
            try { if (controlChannel) controlChannel.postMessage({ type: 'REQUEST_TOKEN' }); } catch (e) {}
            await new Promise(r => setTimeout(r, 800));
        }
        if (!cachedToken) throw new Error('GitHub token needed to build fleet metrics — set the PAT in AIM Controls (gear), then re-run');
        const have = Object.keys(mtIndex.sites).length > 0;
        const fresh = (Date.now() - (mtIndex.checkedAt || 0)) < NB_INDEX_RECHECK_MS;
        if (have && fresh && !force) return notes;
        let tree;
        try { tree = await mtGhTree(); }
        catch (e) { if (have) { notes.push(`snapshot listing failed (${String(e && e.message || e)}) — using cached metrics`); return notes; } throw e; }
        if (tree.truncated) notes.push('data-repo tree listing was truncated by GitHub — some sites may be missing (cached ones kept)');
        if (!tree.truncated) {   // only a COMPLETE listing may evict vanished sites
            Object.keys(mtIndex.shas).forEach(id => { if (!tree.setup[id]) { delete mtIndex.shas[id]; delete mtIndex.sites[id]; } });
            Object.keys(mtIndex.mshas).forEach(id => { if (!tree.mission[id]) { delete mtIndex.mshas[id]; delete mtIndex.missions[id]; } });
        }
        const jobs = [];
        Object.keys(tree.setup).forEach(id => { if (mtIndex.shas[id] !== tree.setup[id] || !mtIndex.sites[id]) jobs.push({ id, kind: 'setup', sha: tree.setup[id] }); });
        Object.keys(tree.mission).forEach(id => { if (mtIndex.mshas[id] !== tree.mission[id] || !mtIndex.missions[id]) jobs.push({ id, kind: 'mission', sha: tree.mission[id] }); });
        const total = jobs.length;
        if (total) {
            console.log(`${TAG} metrics index: ${total} snapshot(s) to (re)fetch`);
            let done = 0, failed = 0, cursor = 0;
            const worker = async () => {
                while (cursor < jobs.length) {
                    const j = jobs[cursor++];
                    try {
                        if (j.kind === 'setup') {
                            const parsed = await mtFetchGz(`${NB_WATCH_DIR}/${j.id}/latest.json.gz`);
                            const v = validateBackupEntities(parsed);
                            mtIndex.sites[j.id] = Object.assign(computeSetupMetrics(v.error ? [] : v.entities), { at: Date.now(), empty: !!v.error });
                            mtIndex.shas[j.id] = j.sha;
                        } else {
                            const parsed = await mtFetchGz(`${NB_WATCH_DIR}/${j.id}/mission-latest.json.gz`);
                            mtIndex.missions[j.id] = Object.assign(computeMissionMetrics(extractList(parsed)), { at: Date.now() });
                            mtIndex.mshas[j.id] = j.sha;
                        }
                    } catch (e) {
                        failed++;
                        console.warn(`${TAG} metrics index: ${j.kind} fetch failed for site ${j.id}:`, e);
                    }
                    done++;
                    if (progress) progress(done, total);
                    if (done % 25 === 0) { saveMetricsIndex(); await ftYield(); }
                }
            };
            await Promise.all(Array.from({ length: Math.min(NB_FETCH_CONCURRENCY, jobs.length) }, worker));
            if (failed) notes.push(`${failed} snapshot fetch(es) failed — those sites keep their previous numbers (or show as missing)`);
            mtIndex.builtAt = Date.now();
        }
        mtIndex.checkedAt = Date.now();
        saveMetricsIndex();
        return notes;
    }

    // ---- rows + column sets ----
    const MT_COLS = {
        name:      { label: 'Site', get: r => r.name, text: true },
        client:    { label: 'Client', get: r => r.client, text: true },
        status:    { label: 'Status', get: r => r.status, text: true },
        snapAge:   { label: 'Indexed', get: r => r.snapAgeD, fmt: v => v == null ? '—' : `${v} d`, title: 'Days since this site\'s numbers were (re)computed from its Site Watch snapshot' },
        entities:  { label: 'Entities', get: r => r.s && r.s.n },
        assets:    { label: 'Assets', get: r => r.s && r.s.counts.asset },
        ffz:       { label: 'FFZ', get: r => r.s && r.s.counts.ffz },
        fp:        { label: 'FP', get: r => r.s && r.s.counts.fp },
        nfz:       { label: 'NFZ', get: r => r.s && r.s.counts.nfz },
        gm:        { label: 'Markers', get: r => r.s && r.s.counts.gm },
        base:      { label: 'Base', get: r => r.s && r.s.counts.base },
        safe:      { label: 'Safe', get: r => r.s && r.s.counts.safe },
        ffzAcres:  { label: 'FFZ acres', get: r => r.s && r.s.ffzAcres, fmt: v => v == null ? '—' : v.toFixed(1), total: 'sum' },
        ffzBand:   { label: 'FFZ band ft', get: r => r.s && r.s.ffzBandN ? Math.round(r.s.ffzBandFtSum / r.s.ffzBandN) : null, title: 'Average FFZ altitude band (max − min)', total: 'avg' },
        nfzAcres:  { label: 'NFZ acres', get: r => r.s && r.s.nfzAcres, fmt: v => v == null ? '—' : v.toFixed(1), total: 'sum' },
        fpArcs:    { label: 'FP arcs', get: r => r.s && r.s.fpArcs },
        fpMi:      { label: 'FP mi', get: r => r.s && r.s.fpM / MT_M_PER_MI, fmt: v => v == null ? '—' : v.toFixed(2), total: 'sum' },
        fpBand:    { label: 'FP band ft', get: r => r.s && r.s.fpBandN ? Math.round(r.s.fpBandFtSum / r.s.fpBandN) : null, title: 'Average flight-path arc altitude band', total: 'avg' },
        gmTypes:   { label: 'Marker types', get: r => r.s ? mtTop(r.s.gmTypes, 4) : '', text: true },
        unsh:      { label: 'Unshielded', get: r => r.s && r.s.unshielded },
        nested:    { label: 'Nested', get: r => (r.s && typeof r.s.nested === 'number') ? r.s.nested : null, title: 'Assets nested under a parent that exists on the site (a parent name that matches nothing is not counted); — = site not re-indexed since this check was added' },
        nestParents: { label: 'Parents', get: r => (r.s && typeof r.s.nestParents === 'number') ? r.s.nestParents : null, title: 'Assets that have at least one nested child (usually pads)' },
        // null (→ '—') when the record predates this check — a stale site must read "unknown", never 0
        apprFp:    { label: '🛂 Approval FPs', get: r => (r.s && Array.isArray(r.s.apprList)) ? r.s.apprFps : null, title: 'Flight paths with at least one arc flagged "wait until approved" (approval required before flying); — = site not re-indexed since this check was added' },
        apprArcs:  { label: 'Approval arcs', get: r => (r.s && Array.isArray(r.s.apprList)) ? r.s.apprArcs : null, title: 'Flight-path arcs flagged "wait until approved"' },
        notes:     { label: 'Notes', get: r => r.s && r.s.notes, title: 'Non-asset entities with a description' },
        equip:     { label: 'Equipment', get: r => r.s ? mtTop(r.s.equip, 5) : '', text: true },
        cats:      { label: 'Categories', get: r => r.s ? mtTop(r.s.cats, 5) : '', text: true, title: '"Cat:" from asset descriptions (Exxon taxonomy)' },
        stNormal:  { label: 'Normal', get: r => r.s && r.s.states.Normal },
        stHY:      { label: 'HY', get: r => r.s && r.s.states.HY },
        stEmpty:   { label: 'Empty', get: r => r.s && r.s.states.Empty },
        stInact:   { label: 'Inactive', get: r => r.s && r.s.states.Inactive },
        stUnsh:    { label: 'Unshld', get: r => r.s && r.s.states.Unshielded },
        stUnreach: { label: 'Unreach', get: r => r.s && r.s.states.Unreachable },
        vAsset:    { label: 'Assets ✓/✗', get: r => r.s && r.s.valid.asset, fmt: mtPair, sortVal: v => v ? v[0] : null, total: 'pair' },
        vFfz:      { label: 'FFZ ✓/✗', get: r => r.s && r.s.valid.ffz, fmt: mtPair, sortVal: v => v ? v[0] : null, total: 'pair' },
        vFp:       { label: 'FP ✓/✗', get: r => r.s && r.s.valid.fp, fmt: mtPair, sortVal: v => v ? v[0] : null, total: 'pair' },
        vNfz:      { label: 'NFZ ✓/✗', get: r => r.s && r.s.valid.nfz, fmt: mtPair, sortVal: v => v ? v[0] : null, total: 'pair' },
        vGm:       { label: 'Markers ✓/✗', get: r => r.s && r.s.valid.gm, fmt: mtPair, sortVal: v => v ? v[0] : null, total: 'pair' },
        vPct:      { label: 'Validated %', get: r => r.validPct, fmt: v => v == null ? '—' : `${Math.round(v)}%`, title: 'Pilot-validated share of assets + FFZ + FP + NFZ', total: 'vpct' },
        missions:  { label: 'Missions', get: r => r.m && r.m.n },
        mActive:   { label: 'Active', get: r => r.m && r.m.active },
        mInactive: { label: 'Inactive', get: r => r.m && r.m.inactive },
        steps:     { label: 'Steps', get: r => r.m && r.m.steps },
        avgSteps:  { label: 'Avg steps', get: r => r.m && r.m.n ? Math.round(r.m.steps / r.m.n) : null, total: 'avg' },
        snaps:     { label: 'Snapshots', get: r => r.m && r.m.snapshots, title: 'Snapshot steps across all missions' },
        orbits:    { label: 'Orbits', get: r => r.m && r.m.orbits },
        areaMaps:  { label: 'Area maps', get: r => r.m && r.m.areaMaps },
        gem:       { label: 'GEM missions', get: r => r.m && r.m.gem, title: 'Missions with at least one GEM (gas) step' },
        mMi:       { label: 'Planned mi', get: r => r.m && r.m.distM / MT_M_PER_MI, fmt: v => v == null ? '—' : v.toFixed(1), total: 'sum' },
        mHrs:      { label: 'Planned h', get: r => r.m && r.m.durS / 3600, fmt: v => v == null ? '—' : v.toFixed(1), total: 'sum' },
        avgMi:     { label: 'Avg mi', get: r => r.m && r.m.withDist ? r.m.distM / r.m.withDist / MT_M_PER_MI : null, fmt: v => v == null ? '—' : v.toFixed(2), total: 'avg' },
        stepTypes: { label: 'Step mix', get: r => r.m ? mtTop(r.m.stepTypes, 5) : '', text: true },
    };
    const MT_SETS = {
        overview:   { label: 'Overview',   cols: ['name', 'client', 'status', 'assets', 'ffz', 'fp', 'apprFp', 'nfz', 'gm', 'fpMi', 'missions', 'steps', 'vPct', 'snapAge'] },
        setup:      { label: 'Site setup', cols: ['name', 'entities', 'assets', 'ffz', 'ffzAcres', 'ffzBand', 'fp', 'fpArcs', 'fpMi', 'fpBand', 'apprFp', 'apprArcs', 'nfz', 'nfzAcres', 'gm', 'gmTypes', 'base', 'safe', 'unsh', 'nested', 'notes'] },
        assets:     { label: 'Assets',     cols: ['name', 'assets', 'nested', 'nestParents', 'equip', 'cats', 'stNormal', 'stHY', 'stEmpty', 'stInact', 'stUnsh', 'stUnreach'] },
        missions:   { label: 'Missions',   cols: ['name', 'missions', 'mActive', 'mInactive', 'steps', 'avgSteps', 'snaps', 'orbits', 'areaMaps', 'gem', 'mMi', 'mHrs', 'avgMi', 'stepTypes'] },
        validation: { label: 'Validation', cols: ['name', 'vAsset', 'vFfz', 'vFp', 'vNfz', 'vGm', 'vPct', 'unsh', 'apprFp', 'apprArcs'] },
        all:        { label: 'All columns', cols: Object.keys(MT_COLS) },
    };
    function mtPair(v) { return v ? `<span style="color:#5fff5f">${v[0]}</span>/<span style="color:${v[1] ? '#ff8585' : '#666'}">${v[1]}</span>` : '—'; }
    function mtTop(map, n) {
        return Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(' · ');
    }
    function buildMetricsRows() {
        const rows = [];
        const ids = new Set(Object.keys(mtIndex.sites).concat(Object.keys(mtIndex.missions)));
        ids.forEach(id => {
            if (rawSites && !rawSites[id]) return;   // snapshot-only orphan (no access) — hidden, counted by caller
            const s = mtIndex.sites[id] && !mtIndex.sites[id].empty ? mtIndex.sites[id] : null;
            const m = mtIndex.missions[id] || null;
            const raw = rawSites && rawSites[id] && rawSites[id].raw;
            let validPct = null;
            if (s) {
                const y = s.valid.asset[0] + s.valid.ffz[0] + s.valid.fp[0] + s.valid.nfz[0];
                const t = y + s.valid.asset[1] + s.valid.ffz[1] + s.valid.fp[1] + s.valid.nfz[1];
                validPct = t ? Math.round(100 * y / t) : null;
            }
            rows.push({
                id, name: siteName(id), client: (raw && siteEntryClient(raw)) || clientOf(siteName(id)) || '', status: siteStatus(id),
                s, m, validPct, snapAgeD: s ? Math.floor((Date.now() - (s.at || 0)) / 86400000) : null,
            });
        });
        return rows;
    }
    function mtSortRows(rows) {
        const col = MT_COLS[mtSort.key] || MT_COLS.name;
        const val = (r) => { const v = col.get(r); return col.sortVal ? col.sortVal(v) : v; };
        return rows.slice().sort((a, b) => {
            const va = val(a), vb = val(b);
            if (col.text) return String(va || '').localeCompare(String(vb || '')) * mtSort.dir || a.name.localeCompare(b.name);
            const na = (va == null || va === '') ? -Infinity : Number(va), nb = (vb == null || vb === '') ? -Infinity : Number(vb);
            return (na - nb) * mtSort.dir || a.name.localeCompare(b.name);
        });
    }
    function mtFilteredRows() {
        let rows = buildMetricsRows();
        if (ftCfg.onlyProduction) rows = rows.filter(r => !r.status || r.status === 'Production');
        const q = mtFilter.trim().toLowerCase();
        if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || (r.client || '').toLowerCase().includes(q) || r.id === q || (r.status || '').toLowerCase().includes(q));
        return mtSortRows(rows);
    }
    function mtTotals(rows, cols) {
        const out = {};
        cols.forEach(k => {
            const c = MT_COLS[k];
            if (c.text || k === 'snapAge') { out[k] = ''; return; }
            if (c.total === 'pair') { const t = [0, 0]; rows.forEach(r => { const v = c.get(r); if (v) { t[0] += v[0]; t[1] += v[1]; } }); out[k] = mtPair(t); return; }
            if (c.total === 'vpct') {   // entity-weighted, matches the fleet tile
                let y = 0, t = 0;
                rows.forEach(r => { if (!r.s) return; ['asset', 'ffz', 'fp', 'nfz'].forEach(q => { y += r.s.valid[q][0]; t += r.s.valid[q][0] + r.s.valid[q][1]; }); });
                out[k] = t ? `${Math.round(100 * y / t)}%` : '—'; return;
            }
            const vals = rows.map(r => c.get(r)).filter(v => typeof v === 'number' && isFinite(v));
            if (!vals.length) { out[k] = '—'; return; }
            const sum = vals.reduce((a, b) => a + b, 0);
            const v = c.total === 'avg' ? sum / vals.length : sum;
            out[k] = c.fmt ? c.fmt(c.total === 'avg' ? v : v) : String(Math.round(v));
            if (c.total === 'avg' && !c.fmt) out[k] = String(Math.round(v));
        });
        return out;
    }
    function mtCell(col, r) {
        const v = col.get(r);
        if (col.fmt) return col.fmt(v);
        if (v == null || v === '') return '<span style="color:#555">—</span>';
        if (col.text) return escapeHtml(String(v));
        return typeof v === 'number' ? String(Math.round(v * 100) / 100) : escapeHtml(String(v));
    }
    function mtCellText(col, r) {
        const v = col.get(r);
        if (v == null || v === '') return '';
        if (Array.isArray(v)) return `${v[0]}/${v[1]}`;
        if (typeof v === 'number') return String(Math.round(v * 100) / 100);
        return String(v);
    }
    function buildMetricsCsv() {
        const rows = mtFilteredRows();
        const cols = MT_SETS.all.cols;
        const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
        const lines = ['site_id,' + cols.map(k => esc(MT_COLS[k].label)).join(',')];
        rows.forEach(r => lines.push([r.id].concat(cols.map(k => esc(mtCellText(MT_COLS[k], r)))).join(',')));
        return lines.join('\n');
    }
    function buildMetricsSheetsHtml() {
        const rows = mtFilteredRows();
        const cols = MT_SETS[mtSet].cols;
        const th = (v) => `<th style="background:#14171b;color:#fff;padding:6px 8px;border:1px solid #444;text-align:left">${escapeHtml(v)}</th>`;
        const td = (v) => `<td style="padding:5px 8px;border:1px solid #444">${v}</td>`;
        const out = [`<p><b>AIM Fleet Metrics — ${escapeHtml(MT_SETS[mtSet].label)}</b> — ${escapeHtml(new Date().toLocaleString())} — ${rows.length} site(s)</p>`];
        out.push('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><tr>' + th('Site ID') + cols.map(k => th(MT_COLS[k].label)).join('') + '</tr>');
        rows.forEach(r => out.push('<tr>' + td(r.id) + cols.map(k => k === 'name' ? td(`<a href="${siteSetupUrl(r.id)}" style="color:#1a73e8">${escapeHtml(r.name)}</a>`) : td(escapeHtml(mtCellText(MT_COLS[k], r)))).join('') + '</tr>'));
        const tot = mtTotals(rows, cols);
        out.push('<tr>' + td('<b>Fleet</b>') + cols.map(k => td(`<b>${k === 'name' ? `${rows.length} sites` : String(tot[k]).replace(/<[^>]+>/g, '')}</b>`)).join('') + '</tr></table>');
        return out.join('');
    }
    function copyHtmlToClipboard(html, text, doneMsg) {
        (async () => {
            try {
                if (navigator.clipboard && window.ClipboardItem) {
                    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
                    setStatus(doneMsg); return;
                }
            } catch (e) { console.warn(`${TAG} rich clipboard failed, falling back to text:`, e); }
            copyText(text, doneMsg + ' (plain text)');
        })();
    }
    function mtFleetTotalsBlock(rows) {
        const S = { sites: rows.length, assets: 0, ffz: 0, fp: 0, nfz: 0, gm: 0, fpMi: 0, missions: 0, steps: 0, mMi: 0, mHrs: 0, vy: 0, vt: 0, equip: {}, states: {}, withSetup: 0, withMissions: 0 };
        rows.forEach(r => {
            if (r.s) {
                S.withSetup++; S.assets += r.s.counts.asset; S.ffz += r.s.counts.ffz; S.fp += r.s.counts.fp; S.nfz += r.s.counts.nfz; S.gm += r.s.counts.gm; S.fpMi += r.s.fpM / MT_M_PER_MI;
                Object.entries(r.s.equip).forEach(([k, v]) => mtInc(S.equip, k, v));
                Object.entries(r.s.states).forEach(([k, v]) => mtInc(S.states, k, v));
                ['asset', 'ffz', 'fp', 'nfz'].forEach(k => { S.vy += r.s.valid[k][0]; S.vt += r.s.valid[k][0] + r.s.valid[k][1]; });
            }
            if (r.m) { S.withMissions++; S.missions += r.m.n; S.steps += r.m.steps; S.mMi += r.m.distM / MT_M_PER_MI; S.mHrs += r.m.durS / 3600; }
        });
        const tile = (l, v, c) => `<div style="background:#0e1218;border:1px solid #2a3140;border-radius:5px;padding:5px 9px;min-width:70px"><div style="color:#888;font-size:10px">${l}</div><div style="color:${c || '#ddd'};font-weight:bold;font-size:15px">${v}</div></div>`;
        const stateColor = { Normal: '#5fff5f', HY: '#00e5ff', Empty: '#ffd54f', Inactive: '#ff9800', Unshielded: '#ff5722', Unreachable: '#a855f7' };
        const eq = Object.entries(S.equip).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const st = Object.entries(S.states).filter(x => x[1]).sort((a, b) => b[1] - a[1]);
        const eqMax = eq.length ? eq[0][1] : 1;
        return '<div style="padding:6px 10px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #222834;">'
            + tile('Sites', `${S.sites}`, '#7adfe6') + tile('Assets', S.assets, '#fff') + tile('FFZ', S.ffz, '#5fff5f') + tile('FP', S.fp, '#1ca0de') + tile('NFZ', S.nfz, '#ff5555') + tile('Markers', S.gm, '#c084fc')
            + tile('FP miles', S.fpMi.toFixed(0), '#1ca0de') + tile('Missions', S.missions, '#ffd54f') + tile('Steps', S.steps, '#ffd54f') + tile('Planned mi', S.mMi.toFixed(0), '#ffd54f') + tile('Planned h', S.mHrs.toFixed(0), '#ffd54f')
            + tile('Validated', S.vt ? `${Math.round(100 * S.vy / S.vt)}%` : '—', '#5fff5f')
            + tile('🛂 Approval FPs', rows.some(r => r.s && Array.isArray(r.s.apprList)) ? rows.reduce((n, r) => n + ((r.s && Array.isArray(r.s.apprList)) ? r.s.apprFps : 0), 0) + (rows.some(r => r.s && !Array.isArray(r.s.apprList)) ? '<span style="color:#ffa030;font-size:11px" title="some sites not re-indexed since this check was added — ▶ Build metrics">*</span>' : '') : '—', '#ffa030')
            + '</div>'
            + '<div style="padding:4px 10px 6px;display:grid;grid-template-columns:1fr 1fr;gap:10px;border-bottom:1px solid #222834;">'
            + `<div><div style="color:#7adfe6;font-weight:bold;font-size:11px">EQUIPMENT (fleet, top 10)</div>${eq.map(([k, v]) => `<div style="display:flex;align-items:center;gap:6px;font-size:11px"><span style="width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aaa">${escapeHtml(k)}</span><div style="flex:1;height:8px;background:#0e1218;border-radius:4px;overflow:hidden"><div style="width:${Math.round(100 * v / eqMax)}%;height:100%;background:#7adfe6"></div></div><span style="width:40px;text-align:right">${v}</span></div>`).join('') || '<span style="color:#666">—</span>'}</div>`
            + `<div><div style="color:#7adfe6;font-weight:bold;font-size:11px">ASSET STATES (fleet)</div>${st.map(([k, v]) => `<div style="display:flex;align-items:center;gap:6px;font-size:11px"><span style="width:150px;color:${stateColor[k] || '#aaa'}">${escapeHtml(k)}</span><div style="flex:1;height:8px;background:#0e1218;border-radius:4px;overflow:hidden"><div style="width:${Math.round(100 * v / (S.assets || 1))}%;height:100%;background:${stateColor[k] || '#aaa'}"></div></div><span style="width:40px;text-align:right">${v}</span></div>`).join('') || '<span style="color:#666">—</span>'}`
            + `<div style="color:#666;font-size:10px;margin-top:4px">${S.withSetup} site(s) with a setup snapshot · ${S.withMissions} with a mission snapshot · ${S.sites - S.withSetup} without</div></div>`
            + '</div>';
    }
    function mtDetailBlock(r) {
        const s = r.s, m = r.m;
        const list = (map, n) => Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, n || 30).map(([k, v]) => `<span style="display:inline-block;margin:1px 6px 1px 0;color:#aaa">${escapeHtml(k)} <b style="color:#ddd">${v}</b></span>`).join('') || '<span style="color:#666">—</span>';
        return `<tr><td colspan="99" style="padding:6px 12px 8px 24px;background:#10141a;border-bottom:1px solid #1d2430;font-size:11px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div>
                    <div style="color:#7adfe6;font-weight:bold">SITE SETUP ${s ? `<span style="color:#666;font-weight:normal">· indexed ${r.snapAgeD} d ago</span>` : '<span style="color:#ffa030;font-weight:normal">· no snapshot</span>'}</div>
                    ${s ? `<div>Entities <b>${s.n}</b> · assets <b>${s.counts.asset}</b> · FFZ <b>${s.counts.ffz}</b> (${s.ffzAcres} ac) · FP <b>${s.counts.fp}</b> (${s.fpArcs} arcs, ${(s.fpM / MT_M_PER_MI).toFixed(2)} mi) · NFZ <b>${s.counts.nfz}</b> (${s.nfzAcres} ac) · markers <b>${s.counts.gm}</b> · base <b>${s.counts.base}</b>${s.baseActive ? ' (active)' : ''} · safe <b>${s.counts.safe}</b> · unshielded <b>${s.unshielded}</b>${typeof s.nested === 'number' ? ` · nested <b>${s.nested}</b>` : ''}</div>
                    <div style="margin-top:3px"><span style="color:#888">Equipment:</span> ${list(s.equip)}</div>
                    <div style="margin-top:2px"><span style="color:#888">States:</span> ${list(s.states)}</div>
                    ${Object.keys(s.cats).length ? `<div style="margin-top:2px"><span style="color:#888">Categories:</span> ${list(s.cats)}</div>` : ''}
                    <div style="margin-top:2px"><span style="color:#888">Marker types:</span> ${list(s.gmTypes)}</div>
                    ${s.apprList && s.apprList.length ? `<div style="margin-top:2px;color:#ffa030">🛂 Approval-required FPs (${s.apprList.length}): ${s.apprList.map(f => `${escapeHtml(f.name)} <span style="color:#888">(${f.appr}/${f.arcs} arcs)</span>`).join(' · ')}</div>` : ''}
                    <div style="margin-top:2px"><span style="color:#888">Validated ✓/✗:</span> assets ${mtPair(s.valid.asset)} · FFZ ${mtPair(s.valid.ffz)} · FP ${mtPair(s.valid.fp)} · NFZ ${mtPair(s.valid.nfz)} · markers ${mtPair(s.valid.gm)}</div>` : ''}
                </div>
                <div>
                    <div style="color:#7adfe6;font-weight:bold">MISSIONS ${m ? `<span style="color:#666;font-weight:normal">· indexed ${Math.floor((Date.now() - (m.at || 0)) / 86400000)} d ago</span>` : '<span style="color:#ffa030;font-weight:normal">· no mission snapshot (Site Watch “watch missions” off?)</span>'}</div>
                    ${m ? `<div>Missions <b>${m.n}</b> (${m.active} active, ${m.inactive} inactive) · steps <b>${m.steps}</b> (avg ${m.n ? Math.round(m.steps / m.n) : 0}) · planned <b>${(m.distM / MT_M_PER_MI).toFixed(1)} mi</b> / <b>${(m.durS / 3600).toFixed(1)} h</b> · snapshots <b>${m.snapshots}</b> · orbits <b>${m.orbits}</b> · area maps <b>${m.areaMaps}</b> · GEM missions <b>${m.gem}</b></div>
                    <div style="margin-top:3px"><span style="color:#888">Step mix:</span> ${list(m.stepTypes)}</div>` : ''}
                </div>
            </div>
            <div style="margin-top:6px"><span data-ft-link="${r.id}" style="cursor:pointer;color:#5fb3ff">↗ open site setup</span></div>
        </td></tr>`;
    }

    // ---- v0.42: 🛂 approval-required flight paths (arcs flagged wait_until_approved) ----
    function mtApprovalRows() {
        const fps = [], sitesWith = new Set();
        let stale = 0;
        buildMetricsRows().forEach(r => {
            if (!r.s) return;
            if (mtIndex.schema !== MT_SCHEMA || !Array.isArray(r.s.apprList)) { stale++; return; }   // record predates the field
            r.s.apprList.forEach(f => { fps.push({ sid: r.id, site: r.name, client: r.client, status: r.status, ageD: r.snapAgeD, live: !!r.s.live, name: f.name, id: f.id, appr: f.appr, arcs: f.arcs }); sitesWith.add(r.id); });
        });
        fps.sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name));
        return { fps, sites: sitesWith.size, stale };
    }
    let apprCardEl = null, apprCardKeyH = null, apprVerifying = false;
    // v0.43: snapshots lag (Site Watch cadence) — re-read the flagged sites LIVE
    // from /map_objects/ and refresh their metrics records in place, so a fix
    // made minutes ago drops off the list without waiting for the next snapshot.
    async function apprVerifyLive() {
        if (apprVerifying) return;
        const sids = Array.from(new Set(mtApprovalRows().fps.map(f => f.sid)));
        if (!sids.length) { setStatus('nothing to verify — no flagged flight paths'); return; }
        apprVerifying = true;
        let cleared = 0, still = 0, failed = 0;
        try {
            for (let i = 0; i < sids.length; i++) {
                const sid = sids[i];
                setStatus(`verifying live… ${siteName(sid)} (${i + 1}/${sids.length})`);
                try {
                    const live = await fdFetchSetup(sid, true);
                    const before = (mtIndex.sites[sid] && mtIndex.sites[sid].apprFps) || 0;
                    const rec = Object.assign(computeSetupMetrics(live.entities), { at: Date.now(), empty: false, live: true });
                    mtIndex.sites[sid] = rec;   // sha untouched: the next snapshot change still re-reads it
                    if (rec.apprFps < before) cleared += before - rec.apprFps;
                    still += rec.apprFps;
                } catch (e) { failed++; console.warn(`${TAG} live verify failed for site ${sid}:`, e); }
            }
            saveMetricsIndex();
            setStatus(`live verify done — ${still} flight path(s) still need approval · ${cleared} cleared since the snapshot${failed ? ` · ${failed} site(s) failed` : ''}`);
        } finally {
            apprVerifying = false;
            renderPanel();
            openApprovalCard();
        }
    }
    function closeApprovalCard() {
        if (apprCardEl) { try { apprCardEl.remove(); } catch (e) {} }
        apprCardEl = null;
        if (apprCardKeyH) { try { document.removeEventListener('keydown', apprCardKeyH, true); } catch (e) {} apprCardKeyH = null; }
    }
    function openApprovalCard() {
        closeApprovalCard();
        const A = mtApprovalRows();
        const indexed = Object.keys(mtIndex.sites).length;
        const needRebuild = !Object.keys(mtIndex.shas).length && indexed > 0;   // schema bump dropped the shas → ▶ Build re-reads
        const csv = ['site_id,site,client,status,flight_path,fp_id,approval_arcs,total_arcs,indexed_days_ago'].concat(A.fps.map(f => [f.sid, f.site, f.client, f.status, f.name, f.id, f.appr, f.arcs, f.ageD].map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(','))).join('\n');
        const th = (v) => `<th style="background:#14171b;color:#fff;padding:6px 8px;border:1px solid #444;text-align:left">${escapeHtml(v)}</th>`;
        const td = (v) => `<td style="padding:5px 8px;border:1px solid #444">${v}</td>`;
        const sheets = `<p><b>AIM Fleet Tools — approval-required flight paths</b> — ${escapeHtml(new Date().toLocaleString())} — ${A.fps.length} flight path(s) on ${A.sites} site(s)</p>`
            + '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><tr>' + ['Site', 'Site ID', 'Client', 'Status', 'Flight path', 'FP ID', 'Approval arcs', 'Total arcs', 'Indexed (d ago)'].map(th).join('') + '</tr>'
            + A.fps.map(f => '<tr>' + td(`<a href="${siteSetupUrl(f.sid)}" style="color:#1a73e8">${escapeHtml(f.site)}</a>`) + td(f.sid) + td(escapeHtml(f.client || '')) + td(escapeHtml(f.status || '')) + td(escapeHtml(f.name)) + td(f.id) + td(f.appr) + td(f.arcs) + td(f.ageD == null ? '' : f.ageD) + '</tr>').join('') + '</table>';
        const card = document.createElement('div');
        card.id = 'aim-ft-appr-card';
        card.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:860px;max-width:95vw;max-height:88vh;background:#1f2228;border:1px solid rgba(255,160,48,0.55);border-radius:10px;color:#e6e6e6;z-index:2147480002;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.7);display:flex;flex-direction:column;overflow:hidden`;
        const tile = (label, val, color) => `<div style="background:#14171b;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 12px;min-width:110px"><div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">${label}</div><div style="color:${color || '#e6e6e6'};font-size:20px;font-weight:700">${val}</div></div>`;
        let bySite = '';
        if (A.fps.length) {
            let cur = null;
            A.fps.forEach(f => {
                if (f.sid !== cur) { cur = f.sid; bySite += `<tr style="background:#181b21"><td colspan="4" style="padding:5px 8px;color:#7adfe6;font-weight:700">${escapeHtml(f.site)} <span style="color:#555">#${f.sid}</span> <span data-ft-link="${f.sid}" style="cursor:pointer;color:#5fb3ff">↗</span>${f.status && statusTag(f.status) ? ` <span style="color:#ffa030;font-weight:400">${escapeHtml(f.status)}</span>` : ''} <span style="color:#666;font-weight:400">· ${f.live ? '<span style=\"color:#5fff5f\">live-verified</span>' : 'indexed ' + (f.ageD == null ? '?' : f.ageD + ' d ago')}</span></td></tr>`; }
                bySite += `<tr style="border-top:1px solid rgba(255,255,255,0.05)"><td style="padding:4px 8px 4px 24px">${escapeHtml(f.name)}</td><td style="padding:4px 8px;color:#666">#${f.id}</td><td style="padding:4px 8px;color:#ffa030;font-weight:700">${f.appr} of ${f.arcs} arc${f.arcs === 1 ? '' : 's'}</td><td style="padding:4px 8px;color:#888">${f.appr === f.arcs ? 'whole path' : 'partial'}</td></tr>`;
            });
        }
        card.innerHTML = `
            <div style="padding:10px 14px;background:#14171b;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;gap:10px">
                <span style="font-size:16px">🛂</span><span style="font-weight:700;color:#ffa030">Approval-required flight paths</span>
                <span style="color:#888;font-size:11px">· arcs flagged "wait until approved" · from the Site Watch snapshots (indexed ${indexed} sites)</span>
                <span style="margin-left:auto;display:flex;gap:6px">
                    <button id="aim-appr-verify" ${apprVerifying || !A.fps.length ? 'disabled' : ''} title="Re-read the flagged sites from Percepto right now (snapshots can lag a day) and refresh their records" style="padding:4px 10px;background:#1a3a40;color:#7adfe6;border:1px solid rgba(122,223,230,0.5);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">${apprVerifying ? '⏳ Verifying…' : `🔄 Verify live (${A.sites} sites)`}</button>
                    <button id="aim-appr-sheets" style="padding:4px 10px;background:#3a3f48;color:#ffd54f;border:1px solid rgba(255,213,79,0.4);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">📊 Copy → Sheets</button>
                    <button id="aim-appr-csv" style="padding:4px 10px;background:#3a3f48;color:#a8c4ff;border:1px solid rgba(168,196,255,0.3);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">📋 Copy CSV</button>
                    <button id="aim-appr-close" style="padding:4px 10px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px">✕</button>
                </span>
            </div>
            <div style="padding:12px 14px;overflow:auto;flex:1;min-height:0">
                ${needRebuild ? '<div style="color:#ffa030;margin-bottom:10px">⚠ The index predates this check — run <b>▶ Build metrics</b> once so every site setup is re-read, then reopen.</div>' : ''}
                ${A.stale ? `<div style="color:#ffa030;margin-bottom:10px">⚠ ${A.stale} site record(s) were computed before this check existed and are not counted — run ▶ Build metrics.</div>` : ''}
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    ${tile('Flight paths', A.fps.length, '#ffa030')}${tile('Sites', A.sites, '#7adfe6')}${tile('Approval arcs', A.fps.reduce((n, f) => n + f.appr, 0), '#ffa030')}${tile('Sites indexed', indexed, '#888')}
                </div>
                ${A.fps.length ? `<div style="margin-top:14px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><tr style="color:#888;text-align:left"><th style="padding:4px 8px">Flight path</th><th style="padding:4px 8px">ID</th><th style="padding:4px 8px">Arcs needing approval</th><th style="padding:4px 8px"></th></tr>${bySite}</table></div>`
                    : (indexed ? '<div style="margin-top:14px;color:#5fff5f">No flight path in the indexed fleet is flagged wait-until-approved.</div>' : '<div style="margin-top:14px;color:#888">No metrics yet — run ▶ Build metrics first.</div>')}
                <div style="margin-top:12px;color:#666;font-size:11px">Numbers come from each site's Site Watch snapshot (age shown per site) — a fix made since then still shows until Site Watch re-snapshots the site (24 h quiet / 3 h after a change). <b>🔄 Verify live</b> re-reads the flagged sites from Percepto now. Click ↗ to open the site.</div>
            </div>`;
        ['mousedown', 'pointerdown', 'wheel', 'dblclick', 'contextmenu', 'touchstart'].forEach(evt => card.addEventListener(evt, e => e.stopPropagation(), false));
        document.body.appendChild(card);
        apprCardEl = card;
        card.querySelector('#aim-appr-close').onclick = closeApprovalCard;
        const vb = card.querySelector('#aim-appr-verify');
        if (vb && !vb.disabled) vb.onclick = () => { vb.disabled = true; vb.textContent = '⏳ Verifying…'; apprVerifyLive(); };
        card.querySelector('#aim-appr-csv').onclick = () => copyText(csv, `${A.fps.length} row(s) copied as CSV`);
        card.querySelector('#aim-appr-sheets').onclick = () => copyHtmlToClipboard(sheets, csv, 'approval-required flight paths copied — paste into Google Sheets / Excel');
        card.addEventListener('click', (ev) => { const link = ev.target.closest('[data-ft-link]'); if (link) window.open(siteSetupUrl(link.getAttribute('data-ft-link')), '_blank'); });
        apprCardKeyH = (e) => { if (e.key === 'Escape' && apprCardEl) { e.preventDefault(); closeApprovalCard(); } };
        document.addEventListener('keydown', apprCardKeyH, true);
    }

    function renderMetricsSection() {
        if (!openSections.metrics) return '';
        const out = [];
        const total = Object.keys(mtIndex.sites).length;
        const orphans = rawSites ? Object.keys(mtIndex.sites).filter(id => !rawSites[id]).length : 0;
        out.push('<div style="padding:6px 10px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + (mtBuilding ? '<span style="color:#ffa030">⏳ building…</span>'
                : `<span data-ft="metrics-build" style="cursor:pointer;color:#5fff5f;font-weight:bold" title="Check every Site Watch snapshot sha and (re)compute changed sites — first run downloads everything (a few minutes)">${total ? '⟳ Update metrics' : '▶ Build metrics'}</span>`)
            + '<span data-ft="metrics-refresh" style="cursor:pointer;color:#7adfe6" title="Re-fetch /sites/ names, clients, statuses">⟳ Names</span>'
            + '<span data-ft="metrics-sheets" style="cursor:pointer;color:#ffd54f">📊 Copy → Sheets</span>'
            + '<span data-ft="metrics-csv" style="cursor:pointer;color:#7adfe6">📋 Copy CSV (all columns)</span>'
            + `<span data-ft="metrics-wide" style="cursor:pointer;color:#7adfe6" title="Toggle a wide panel for the table">${mtWide ? '⤡ Normal width' : '⤢ Wide'}</span>`
            + (total ? `<span data-ft="metrics-appr" style="cursor:pointer;color:#ffa030;font-weight:bold" title="Every flight path in the fleet whose arcs are flagged wait-until-approved">🛂 Approval FPs (${mtApprovalRows().fps.length})</span>` : '')
            + `<span style="color:#888">${total} site(s) indexed${orphans ? ` · ${orphans} no-access hidden` : ''}${mtIndex.builtAt ? ` · built ${new Date(mtIndex.builtAt).toLocaleString()}` : ''}</span>`
            + '</div>');
        if (!total) {
            out.push('<div style="padding:8px 10px;color:#888">No metrics yet — ▶ Build metrics reads every site’s Site Watch snapshot (setup + missions) once, then only changed sites re-download.</div>');
            return out.join('');
        }
        const rows = mtFilteredRows();
        out.push(mtFleetTotalsBlock(rows));
        out.push('<div style="padding:6px 10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + Object.keys(MT_SETS).map(k => `<span data-ft-mtset="${k}" style="cursor:pointer;padding:2px 8px;border-radius:10px;border:1px solid ${mtSet === k ? '#7adfe6' : '#2a3140'};color:${mtSet === k ? '#7adfe6' : '#aaa'};background:${mtSet === k ? '#1a2e33' : 'transparent'}">${MT_SETS[k].label}</span>`).join('')
            + `<input type="text" data-ft-mtfilter value="${escapeHtml(mtFilter)}" placeholder="filter site / client / status…" style="margin-left:auto;width:200px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 6px;font:inherit;">`
            + `<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;" title="Only sites whose /sites/ status is Production"><input type="checkbox" data-ft-flag="onlyProduction" ${ftCfg.onlyProduction ? 'checked' : ''}> Production only</label>`
            + '</div>');
        const cols = MT_SETS[mtSet].cols;
        const tot = mtTotals(rows, cols);
        const arrow = (k) => mtSort.key === k ? (mtSort.dir > 0 ? ' ▲' : ' ▼') : '';
        out.push(`<div style="max-height:${mtWide ? '60vh' : '45vh'};overflow:auto;">`
            + '<table style="border-collapse:collapse;width:100%;font:inherit;white-space:nowrap;">'
            + '<thead><tr style="color:#7adfe6;text-align:left;position:sticky;top:0;background:#14181f;z-index:1">'
            + cols.map(k => `<th data-ft-mtsort="${k}" title="${escapeHtml(MT_COLS[k].title || 'click to sort')}" style="padding:3px 8px;cursor:pointer;user-select:none;border-bottom:1px solid #2a3140">${escapeHtml(MT_COLS[k].label)}${arrow(k)}</th>`).join('')
            + '</tr></thead><tbody>'
            + rows.map(r => `<tr class="aim-ft-row" data-ft-mtrow="${r.id}" style="border-bottom:1px solid #1d2430;cursor:pointer;${!r.s && !r.m ? 'color:#666;' : ''}">`
                + cols.map(k => k === 'name'
                    ? `<td style="padding:2px 8px;"><span style="color:#666">${mtExpanded.has(r.id) ? '▾' : '▸'}</span> ${escapeHtml(r.name)} <span style="color:#555">#${r.id}</span></td>`
                    : `<td style="padding:2px 8px;${MT_COLS[k].text ? 'max-width:220px;overflow:hidden;text-overflow:ellipsis;' : ''}${k === 'status' && statusTag(r.status) ? 'color:#ffa030' : ''}">${mtCell(MT_COLS[k], r)}</td>`).join('')
                + '</tr>' + (mtExpanded.has(r.id) ? mtDetailBlock(r) : '')).join('')
            + `<tr style="border-top:2px solid #2a3140;color:#7adfe6;font-weight:bold;position:sticky;bottom:0;background:#14181f">`
            + cols.map(k => `<td style="padding:3px 8px;">${k === 'name' ? `Fleet (${rows.length})` : tot[k]}</td>`).join('') + '</tr>'
            + '</tbody></table></div>');
        return out.join('');
    }

    // ==================================================================
    // 📦 FLEET DATA (v0.27, feature #259 phase 5a) — pick any sites, browse
    // their LIVE data in-tool (site setup entities / missions / mission log)
    // and export the selection as ONE zip (per-site JSON + CSV, combined
    // CSVs). Everything is cookie-authed same-origin reads; nothing writes
    // to Percepto. The mission-log archive (data repo) is the next step.
    // ==================================================================
    const FD_LOG_ONLY = 'id,mission_group_id,uploader_status,uploader_planned_images_count,drone_name,when,image_count,created_by_username,app_name,type,state,videos,landed,landing_files,tracking_files,landing_is_failed,duration,mission_data_reports,map_status,map_type,is_media_mission';
    const FD_STATE = { 0: 'Pending', 1: 'In Progress', 2: 'Completed', 3: 'Aborted', 4: 'Failed', 5: 'Cancelled' };
    const FD_TYPE = { 3: 'Asset', 4: 'NFZ', 8: 'Base', 15: 'FP', 16: 'FFZ', 19: 'Marker', 98: 'SafeZone' };
    const FD_CACHE_MS = 10 * 60 * 1000;
    const FD_TRACK_CAP = 200;
    const fdSelected = new Set();
    let fdFilter = '';
    // ---- remembered picks (v0.51): every run that consumes the selection notes it under "Recent"; "Saved" = named by the user. GM, env-keyed. ----
    const KEY_PICKS = 'aim-ft-picks' + ENV_SUFFIX;
    const fdPicks = (() => { const v = loadJson(KEY_PICKS, {}); return { saved: Array.isArray(v.saved) ? v.saved : [], recent: Array.isArray(v.recent) ? v.recent : [] }; })();   // { saved: [{name, ids, filter, at}], recent: [{label, ids, filter, at}] }
    const fdPicksSave = () => gmSet(KEY_PICKS, JSON.stringify(fdPicks));
    let fdPickApplied = '';   // label of the pick last applied (shown in the picker row)
    const fdPickKey = (ids) => ids.slice().sort().join(',');
    function fdPickLabel(ids) {
        const by = {}; ids.forEach(id => { const c = fdClientOfId(id); by[c] = (by[c] || 0) + 1; });
        const top = Object.entries(by).sort((a, b) => b[1] - a[1]);
        const head = top.slice(0, 3).map(([c, n]) => `${c} ${n}`).join(' · ') + (top.length > 3 ? ` · +${top.length - 3} more` : '');
        return `${head} (${ids.length} site${ids.length === 1 ? '' : 's'})`;
    }
    // called by every run that reads fdSelected — moves an identical set to the top instead of duplicating it
    function fdNotePick() {
        const ids = Array.from(fdSelected); if (!ids.length) return;
        const key = fdPickKey(ids);
        fdPicks.recent = fdPicks.recent.filter(r => fdPickKey(r.ids || []) !== key);
        fdPicks.recent.unshift({ label: fdPickLabel(ids), ids, filter: fdFilter, at: Date.now() });
        fdPicks.recent = fdPicks.recent.slice(0, 12);
        fdPicksSave();
    }
    function fdApplyPick(kind, idx) {
        const list = kind === 'saved' ? fdPicks.saved : fdPicks.recent; const pk = list[idx]; if (!pk) return;
        const known = rawSites ? new Set(Object.keys(rawSites)) : null;
        fdSelected.clear(); let missing = 0;
        (pk.ids || []).forEach(id => { if (!known || known.has(String(id))) fdSelected.add(String(id)); else missing++; });
        fdFilter = typeof pk.filter === 'string' ? pk.filter : '';
        fdPickApplied = kind === 'saved' ? pk.name : pk.label;
        setStatus(`applied ${kind === 'saved' ? `saved pick "${pk.name}"` : 'recent pick'} — ${fdSelected.size} site(s)${missing ? ` · ${missing} no longer in your site list` : ''}`);
        renderPanel();
    }
    function fdSavePick() {
        const ids = Array.from(fdSelected); if (!ids.length) { setStatus('pick sites first, then save'); return; }
        let name = null; try { name = window.prompt('Name this selection:', fdPickLabel(ids)); } catch (e) { console.warn(`${TAG} prompt unavailable:`, e); }
        if (name == null) return; name = String(name).trim(); if (!name) return;
        fdPicks.saved = fdPicks.saved.filter(p => p.name !== name);
        fdPicks.saved.unshift({ name, ids, filter: fdFilter, at: Date.now() });
        fdPicksSave(); fdPickApplied = name; setStatus(`saved pick "${name}" — ${ids.length} site(s)`); renderPanel();
    }
    function fdDeletePick(name) {
        fdPicks.saved = fdPicks.saved.filter(p => p.name !== name); fdPicksSave(); if (fdPickApplied === name) fdPickApplied = ''; setStatus(`deleted saved pick "${name}"`); renderPanel();
    }
    function renderPickRow() {
        const when = (t) => { try { return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
        const opt = (kind, i, text) => `<option value="${kind}:${i}">${escapeHtml(text)}</option>`;
        const savedOpts = fdPicks.saved.map((p, i) => opt('saved', i, `${p.name} — ${(p.ids || []).length} sites`)).join('');
        const recentOpts = fdPicks.recent.map((r, i) => opt('recent', i, `${r.label} · ${when(r.at)}`)).join('');
        const cur = fdPicks.saved.find(p => p.name === fdPickApplied);
        return '<div style="padding:4px 10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;color:#888">'
            + '<span title="selections you ran before — pick one to re-select the same sites (and filter text)">🕘</span>'
            + `<select data-fd-pick style="max-width:360px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;"><option value="">${fdPicks.saved.length || fdPicks.recent.length ? 'apply a remembered selection…' : 'no remembered selections yet — run anything with sites picked'}</option>`
            + (savedOpts ? `<optgroup label="Saved">${savedOpts}</optgroup>` : '') + (recentOpts ? `<optgroup label="Recent (auto)">${recentOpts}</optgroup>` : '') + '</select>'
            + `<span data-ft="fd-pick-save" title="name the current selection so it stays under Saved" style="cursor:pointer;color:${fdSelected.size ? '#5fff5f' : '#555'}">💾 save current</span>`
            + (cur ? `<span data-ft="fd-pick-del" data-name="${escapeHtml(cur.name)}" title="delete this saved pick" style="cursor:pointer;color:#ff7a7a">✕ ${escapeHtml(cur.name)}</span>` : (fdPickApplied ? `<span style="color:#7adfe6">${escapeHtml(fdPickApplied)}</span>` : ''))
            + '</div>';
    }
    let fdDatasets = { setup: true, missions: true, log: true, tracks: false };
    let fdRange = '90d';           // 30d | 90d | 12m | 18m | custom
    let fdStart = '', fdEnd = '';  // custom yyyy-mm-dd
    let fdBrowse = null;           // { sid, tab: 'setup'|'missions'|'log', search, loading, error }
    let fdWide = false;
    let fdRun = null;              // { done, total, msg, abort }
    const fdCache = { setup: {}, missions: {}, log: {} };   // sid → { at, ... }
    let fdCollapsedClients = new Set();

    const fdYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;   // LOCAL date — toISOString would shift a day
    function fdRangeDates() {
        const end = new Date();
        const start = new Date();
        if (fdRange === 'custom' && (fdStart || fdEnd)) {
            const e = fdEnd ? new Date(fdEnd + 'T23:59:59') : end;
            const s = fdStart ? new Date(fdStart + 'T00:00:00') : new Date((isNaN(e) ? end : e).getTime() - 90 * 86400000);
            return { start: isNaN(s) ? start : s, end: isNaN(e) ? end : e };
        }
        if (fdRange === '30d') start.setDate(start.getDate() - 30);
        else if (fdRange === '12m') start.setMonth(start.getMonth() - 12);
        else if (fdRange === '18m') start.setMonth(start.getMonth() - 18);
        else start.setDate(start.getDate() - 90);
        return { start, end };
    }
    function fdRangeLabel() {
        const r = fdRangeDates();
        return `${fdYmd(r.start)} → ${fdYmd(r.end)}`;
    }
    async function fdGetJson(url, ms) {
        const resp = await fetchWithTimeout(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } }, ms || 30000);
        if (resp.status === 401 || resp.status === 403) throw new Error('not logged in (401/403)');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ct = resp.headers.get('content-type') || '';
        const text = await resp.text();
        if (!/json/i.test(ct)) { if (/<form|login|sign\s*in|password/i.test(text)) throw new Error('login page returned — session expired?'); throw new Error('non-JSON response'); }
        return JSON.parse(text);
    }
    async function fdFetchSetup(sid, force) {
        const c = fdCache.setup[sid];
        if (c && !force && Date.now() - c.at < FD_CACHE_MS) return c;
        const raw = await fdGetJson(`/map_objects/?getPoiMapObjectsAsList=true&site_id=${encodeURIComponent(sid)}`);
        const entities = extractList(raw);
        const out = { at: Date.now(), entities, raw };
        fdCache.setup[sid] = out;
        return out;
    }
    async function fdFetchMissions(sid, force) {
        const c = fdCache.missions[sid];
        if (c && !force && Date.now() - c.at < FD_CACHE_MS) return c;
        const raw = await fdGetJson(`/available_app/?site_id=${encodeURIComponent(sid)}&type=1`);
        const list = extractList(raw);
        const out = { at: Date.now(), list, raw };
        fdCache.missions[sid] = out;
        return out;
    }
    // Paged mission log (same walk MBT uses): newest page first, then
    // last_mission_id cursors backward until total is reached.
    function fdLogKey() { const r = fdRangeDates(); return `${fdYmd(r.start)}|${fdYmd(r.end)}`; }
    async function fdFetchLog(sid, force, onPage, isAborted) {
        const { start, end } = fdRangeDates();
        const key = fdLogKey();
        const c = fdCache.log[sid];
        if (c && !force && c.key === key && Date.now() - c.at < FD_CACHE_MS) return c;
        const fmt = fdYmd;
        const all = []; let total = null; let lastId = -1; let pages = 0;
        for (;;) {
            if (isAborted && isAborted()) throw new Error('aborted');
            if (++pages > 400) break;   // ~8000 flights safety cap
            const params = { site_id: Number(sid), drones: [], missionTypes: [], missionId: [], users: [], state: null, takeoffCompleted: false, start: fmt(start), end: fmt(end), last_mission_id: lastId };
            const j = await fdGetJson(`/missions/?site_id=${encodeURIComponent(sid)}&params=${encodeURIComponent(JSON.stringify(params))}&only=${encodeURIComponent(FD_LOG_ONLY)}`, 40000);
            const past = (j && j.past_missions) || [];
            if (total == null && typeof j.total_mission_count === 'number') total = j.total_mission_count;
            all.push(...past);
            if (onPage) onPage(all.length, total);
            const lastMid = past.length ? past[past.length - 1].id : null;
            const more = past.length > 0 && (total == null || all.length < total) && lastMid != null && lastMid !== lastId;
            if (!more) break;
            lastId = lastMid;
        }
        const out = { at: Date.now(), key, rows: all, total: total != null ? total : all.length, start: fmt(start), end: fmt(end) };
        fdCache.log[sid] = out;
        return out;
    }
    async function fdFetchTrack(missionId) {
        return fdGetJson(`/mission_positions/${encodeURIComponent(missionId)}/`, 60000);
    }

    // ---- row shapers + CSV ----
    const fdCsvEsc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    function fdCsv(cols, rows) {
        return [cols.map(c => fdCsvEsc(c.label)).join(',')].concat(rows.map(r => cols.map(c => fdCsvEsc(c.get(r))).join(','))).join('\n');
    }
    function fdAltFt(e) {
        if (e.type === 16 || e.type === 4) { const r = e.restrictions; if (r && typeof r.minAlt === 'number') return `${Math.round(r.minAlt * FT_PER_M)}–${Math.round((r.maxAlt || r.minAlt) * FT_PER_M)}`; }
        if (e.type === 15 && Array.isArray(e.arcs) && e.arcs.length) {
            let lo = Infinity, hi = -Infinity; e.arcs.forEach(a => { if (a && typeof a.min_alt === 'number') { lo = Math.min(lo, a.min_alt); hi = Math.max(hi, a.max_alt || a.min_alt); } });
            if (isFinite(lo)) return `${Math.round(lo * FT_PER_M)}–${Math.round(hi * FT_PER_M)}`;
        }
        return '';
    }
    const FD_SETUP_COLS = [
        { label: 'Site ID', get: r => r._sid }, { label: 'Site', get: r => r._site },
        { label: 'ID', get: e => e.id }, { label: 'Name', get: e => e.name || '' }, { label: 'Type', get: e => FD_TYPE[e.type] || `type ${e.type}` },
        { label: 'Subtype', get: e => (e.custom && e.custom.poi_type_str) || e.general_marker_type || '' },
        { label: 'Validated', get: e => e.validated ? 'yes' : 'no' }, { label: 'Unshielded', get: e => e.is_unshielded ? 'yes' : '' },
        { label: 'Alt ft (MSL)', get: fdAltFt }, { label: 'Vertices', get: e => (entityCoords(e) || []).length || (Array.isArray(e.arcs) ? e.arcs.length + 1 : 0) },
        { label: 'Lat', get: e => { const c = entityCoords(e); return c && c[0] ? c[0].lat : ''; } }, { label: 'Lng', get: e => { const c = entityCoords(e); return c && c[0] ? c[0].lng : ''; } },
        { label: 'Description', get: e => e.description || '' },
    ];
    const FD_MISSION_COLS = [
        { label: 'Site ID', get: r => r._sid }, { label: 'Site', get: r => r._site },
        { label: 'ID', get: m => m.id }, { label: 'Name', get: m => m.name || '' }, { label: 'Active', get: m => m.is_active === false ? 'no' : 'yes' },
        { label: 'Steps', get: m => (m.instructions || []).length }, { label: 'Snapshots', get: m => (m.instructions || []).filter(i => i && i.type_name === 'snapshot').length },
        { label: 'Step mix', get: m => { const c = {}; (m.instructions || []).forEach(i => { if (i && i.type_name) c[i.type_name] = (c[i.type_name] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '); } },
        { label: 'Description', get: m => m.description || '' },
    ];
    const fdWhenCT = (iso) => { if (!iso) return ''; try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)); } catch (e) { return iso; } };
    const fdDur = (ms) => { const s = Math.round((Number(ms) || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const FD_LOG_COLS = [
        { label: 'Site ID', get: r => r._sid }, { label: 'Site', get: r => r._site },
        { label: 'Mission ID', get: m => m.id }, { label: 'Group', get: m => m.mission_group_id != null ? m.mission_group_id : '' }, { label: 'Name', get: m => m.app_name || '' },
        { label: 'When (UTC)', get: m => m.when || '' }, { label: 'When (CT)', get: m => fdWhenCT(m.when) },
        { label: 'Duration', get: m => fdDur(m.duration) }, { label: 'Duration s', get: m => Math.round((Number(m.duration) || 0) / 1000) },
        { label: 'Drone', get: m => m.drone_name || '' }, { label: 'State', get: m => m.state != null ? (FD_STATE[m.state] || `State ${m.state}`) : '' },
        { label: 'Landed', get: m => m.landed || '' }, { label: 'Landing failed', get: m => m.landing_is_failed ? 'yes' : '' },
        { label: 'Images', get: m => m.image_count != null ? m.image_count : '' }, { label: 'Videos', get: m => Array.isArray(m.videos) ? m.videos.length : '' },
        { label: 'Created by', get: m => m.created_by_username || '' }, { label: 'Media mission', get: m => m.is_media_mission ? 'yes' : '' },
    ];
    function fdTag(rows, sid) { const name = siteName(sid); return rows.map(r => Object.assign(Object.create(r), { _sid: sid, _site: name })); }

    // ---- store-only ZIP writer (no dependency) ----
    const FD_CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
    function fdCrc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = FD_CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
    function fdDosTime(d) { return { time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31), date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31) }; }
    function fdZip(files) {   // files: [{ name, text|bytes }]
        const enc = new TextEncoder();
        const parts = [], central = [];
        let offset = 0;
        const now = fdDosTime(new Date());
        const u16 = (v) => [v & 255, (v >>> 8) & 255], u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
        files.forEach(f => {
            const name = enc.encode(f.name);
            const data = f.bytes || enc.encode(f.text || '');
            const crc = fdCrc32(data);
            const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(now.time), ...u16(now.date), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...name]);
            parts.push(local, data);
            central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(now.time), ...u16(now.date), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]));
            offset += local.length + data.length;
        });
        const cdSize = central.reduce((n, c) => n + c.length, 0);
        const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
        return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
    }
    function fdDownload(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 4000);
    }
    const fdSafe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);

    // ---- export runner ----
    async function fdExport() {
        const sids = Array.from(fdSelected);
        if (!sids.length) { setStatus('pick at least one site first'); return; }
        fdNotePick();
        if (fdRun) return;
        const ds = fdDatasets;
        if (!ds.setup && !ds.missions && !ds.log) { setStatus('tick at least one dataset'); return; }
        if (ds.tracks && !ds.log) { setStatus('GPS tracks need "Mission log" ticked (tracks are fetched per flown flight)'); return; }
        fdRun = { done: 0, total: sids.length, msg: 'starting…', abort: false };
        renderPanel();
        const files = [];
        const allSetup = [], allMissions = [], allLog = [];
        const failures = [];
        let tracks = 0;
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        try {
            for (const sid of sids) {
                if (fdRun.abort) break;
                const folder = `${fdSafe(siteName(sid))} (${sid})`;
                fdRun.msg = `${siteName(sid)} — site setup`; renderPanel();
                if (ds.setup) {
                    try {
                        const s = await fdFetchSetup(sid);
                        files.push({ name: `${folder}/site-setup.json`, text: JSON.stringify(s.entities, null, 1) });
                        allSetup.push(...fdTag(s.entities, sid));
                    } catch (e) { failures.push(`${siteName(sid)}: setup — ${e.message || e}`); }
                }
                if (ds.missions && !fdRun.abort) {
                    fdRun.msg = `${siteName(sid)} — missions`; renderPanel();
                    try {
                        const m = await fdFetchMissions(sid);
                        files.push({ name: `${folder}/missions.json`, text: JSON.stringify(m.list, null, 1) });
                        allMissions.push(...fdTag(m.list, sid));
                    } catch (e) { failures.push(`${siteName(sid)}: missions — ${e.message || e}`); }
                }
                if (ds.log && !fdRun.abort) {
                    try {
                        const l = await fdFetchLog(sid, false, (n, t) => { fdRun.msg = `${siteName(sid)} — mission log ${n}${t != null ? '/' + t : ''}`; setStatus(fdRun.msg); }, () => !!(fdRun && fdRun.abort));
                        files.push({ name: `${folder}/mission-log.json`, text: JSON.stringify(l.rows, null, 1) });
                        files.push({ name: `${folder}/mission-log.csv`, text: fdCsv(FD_LOG_COLS, fdTag(l.rows, sid)) });
                        allLog.push(...fdTag(l.rows, sid));
                        if (ds.tracks) {
                            const flown = l.rows.filter(r => r && r.id && r.state === 2).slice(0, Math.max(0, FD_TRACK_CAP - tracks));
                            for (const r of flown) {
                                if (fdRun.abort) break;
                                fdRun.msg = `${siteName(sid)} — track ${r.id}`; setStatus(fdRun.msg);
                                try { const t = await fdFetchTrack(r.id); files.push({ name: `${folder}/tracks/${r.id}.json`, text: JSON.stringify(t) }); tracks++; }
                                catch (e) { failures.push(`${siteName(sid)}: track ${r.id} — ${e.message || e}`); }
                            }
                        }
                    } catch (e) { if (String(e.message) !== 'aborted') failures.push(`${siteName(sid)}: mission log — ${e.message || e}`); }
                }
                fdRun.done++;
                renderPanel();
                await ftYield();
            }
            if (allSetup.length) files.push({ name: 'ALL-site-setups.csv', text: fdCsv(FD_SETUP_COLS, allSetup) });
            if (allMissions.length) files.push({ name: 'ALL-missions.csv', text: fdCsv(FD_MISSION_COLS, allMissions) });
            if (allLog.length) files.push({ name: `ALL-mission-log ${fdRangeLabel().replace(/ → /g, ' to ')}.csv`, text: fdCsv(FD_LOG_COLS, allLog) });
            files.push({ name: 'README.txt', text: [
                `AIM Fleet Tools v${SCRIPT_VERSION} — fleet data export ${new Date().toLocaleString()} (${location.hostname})`,
                `Sites: ${sids.length}${fdRun.abort ? ' (ABORTED — partial)' : ''}`,
                `Datasets: ${['setup', 'missions', 'log', 'tracks'].filter(k => ds[k]).join(', ')}${ds.log ? ` · mission-log window ${fdRangeLabel()}` : ''}`,
                `Rows: setup entities ${allSetup.length} · missions ${allMissions.length} · flights ${allLog.length}${ds.tracks ? ` · tracks ${tracks}` : ''}`,
                failures.length ? `\nFAILED:\n${failures.map(f => '  - ' + f).join('\n')}` : '\nNo failures.',
                '\nPer-site folders hold the raw JSON (setup = /map_objects/, missions = /available_app/, mission-log = /missions/). ALL-*.csv combine every picked site.',
            ].join('\n') });
            const blob = fdZip(files);
            fdDownload(blob, `AIM-fleet-data ${stamp} (${sids.length} sites).zip`);
            setStatus(`export ready — ${files.length} file(s), ${(blob.size / 1048576).toFixed(1)} MB${failures.length ? ` · ${failures.length} failure(s) (see README.txt / console)` : ''}${fdRun.abort ? ' · ABORTED (partial)' : ''}`);
            if (failures.length) console.warn(`${TAG} fleet data export failures:`, failures);
        } catch (e) {
            console.error(`${TAG} fleet data export failed:`, e);
            setStatus(`export failed — ${String(e && e.message || e)}`);
        } finally {
            fdRun = null;
            renderPanel();
        }
    }

    // ---- browse (live, in-tool) ----
    async function fdOpenBrowse(sid, tab) {
        const b = { sid, tab: tab || (fdBrowse && fdBrowse.tab) || 'setup', search: '', loading: true, error: '' };
        fdBrowse = b;
        renderPanel();
        // Every write below is gated on `fdBrowse === b`: a slow walk for a
        // site the user has since clicked away from must not paint its
        // progress/error over the newer view.
        try {
            if (b.tab === 'setup') await fdFetchSetup(sid);
            else if (b.tab === 'missions') await fdFetchMissions(sid);
            else await fdFetchLog(sid, false, (n, t) => { if (fdBrowse === b) { b.progress = `${n}${t != null ? '/' + t : ''}`; renderPanel(); } });
        } catch (e) { if (fdBrowse === b) b.error = String(e && e.message || e); console.warn(`${TAG} browse fetch failed:`, e); }
        if (fdBrowse !== b) return;
        b.loading = false; b.progress = '';
        renderPanel();
    }
    function fdBrowseRows() {
        if (!fdBrowse) return { cols: [], rows: [] };
        const sid = fdBrowse.sid;
        let cols, rows;
        if (fdBrowse.tab === 'setup') { cols = FD_SETUP_COLS; rows = fdCache.setup[sid] ? fdTag(fdCache.setup[sid].entities, sid) : []; }
        else if (fdBrowse.tab === 'missions') { cols = FD_MISSION_COLS; rows = fdCache.missions[sid] ? fdTag(fdCache.missions[sid].list, sid) : []; }
        else { const c = fdCache.log[sid]; cols = FD_LOG_COLS; rows = (c && c.key === fdLogKey()) ? fdTag(c.rows, sid) : []; }
        const q = (fdBrowse.search || '').trim().toLowerCase();
        if (q) rows = rows.filter(r => cols.some(c => String(c.get(r) == null ? '' : c.get(r)).toLowerCase().includes(q)));
        return { cols: cols.slice(2), rows };   // hide the Site ID / Site columns in-tool
    }
    function renderDataSection() {
        if (!openSections.data) return '';
        const out = [];
        const sites = rawSites ? Object.keys(rawSites) : [];
        if (!sites.length) {
            out.push('<div style="padding:8px 10px;color:#888">Loading your site list… <span data-ft="fd-sites" style="cursor:pointer;color:#7adfe6">⟳ retry</span></div>');
            return out.join('');
        }
        const q = fdFilter.trim().toLowerCase();
        const byClient = {};
        sites.forEach(id => {
            const nm = siteName(id), cl = fdClientOfId(id);   // single source of truth for the client key (header, select-all, KML folders)
            if (q && !(nm.toLowerCase().includes(q) || cl.toLowerCase().includes(q) || id === q)) return;
            (byClient[cl] = byClient[cl] || []).push(id);
        });
        const clients = Object.keys(byClient).sort();
        const shownIds = clients.flatMap(c => byClient[c]);
        // picker
        out.push('<div style="padding:6px 10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + `<input type="text" data-fd-filter value="${escapeHtml(fdFilter)}" placeholder="filter sites / clients…" style="width:200px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 6px;font:inherit;">`
            + `<span data-ft="fd-selall" style="cursor:pointer;color:#7adfe6">☑ select shown (${shownIds.length})</span>`
            + '<span data-ft="fd-clear" style="cursor:pointer;color:#888">clear</span>'
            + `<span style="color:${fdSelected.size ? '#5fff5f' : '#888'};font-weight:bold">${fdSelected.size} selected</span>`
            + `<span data-ft="fd-wide" style="cursor:pointer;color:#7adfe6;margin-left:auto">${fdWide ? '⤡ Normal width' : '⤢ Wide'}</span>`
            + '</div>');
        out.push(renderPickRow());   // v0.51: remembered selections
        out.push('<div id="aim-fd-list" style="max-height:170px;overflow:auto;border-bottom:1px solid #222834;">'
            + clients.map(cl => {
                const ids = byClient[cl].sort((a, b) => siteName(a).localeCompare(siteName(b)));
                const nSel = ids.filter(id => fdSelected.has(id)).length;
                const collapsed = fdCollapsedClients.has(cl);
                return `<div data-fd-client="${escapeHtml(cl)}" style="padding:3px 10px;background:#1a2029;color:#7adfe6;cursor:pointer;user-select:none;display:flex;gap:8px;align-items:center">`
                    + `<input type="checkbox" data-fd-clientsel="${escapeHtml(cl)}" ${nSel === ids.length ? 'checked' : ''} title="select / clear this client" style="margin:0">`
                    + `<span>${collapsed ? '▸' : '▾'} ${escapeHtml(cl)}</span><span style="color:#888;font-weight:normal">${nSel}/${ids.length}</span></div>`
                    + (collapsed ? '' : ids.map(id => `<label style="display:flex;gap:6px;align-items:center;padding:1px 10px 1px 26px;cursor:pointer;${fdSelected.has(id) ? 'background:#16262a;' : ''}">`
                        + `<input type="checkbox" data-fd-site="${id}" ${fdSelected.has(id) ? 'checked' : ''} style="margin:0">`
                        + `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(siteName(id))} <span style="color:#555">#${id}</span>${statusTag(siteStatus(id)) ? ` <span style="color:#ffa030">${escapeHtml(siteStatus(id))}</span>` : ''}</span>`
                        + `<span data-fd-chip="${id}" title="browse this site's data" style="color:#5fb3ff;cursor:pointer">🔍</span></label>`).join(''));
            }).join('')
            + '</div>');
        // datasets + export
        const cb = (k, label, title) => `<label title="${escapeHtml(title || '')}" style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" data-fd-dataset="${k}" ${fdDatasets[k] ? 'checked' : ''} ${fdRun ? 'disabled' : ''}> ${label}</label>`;
        out.push('<div style="padding:6px 10px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + '<span style="color:#888">Export:</span>' + cb('setup', 'Site setup', 'Full /map_objects/ JSON per site + combined entity CSV') + cb('missions', 'Missions', 'Full mission JSON per site + combined CSV') + cb('log', 'Mission log', 'Flown flights per site (JSON + CSV) + combined CSV') + cb('tracks', 'GPS tracks', `Flown GPS track per completed flight (cap ${FD_TRACK_CAP} — heavy)`)
            + `<select data-fd-range ${fdRun ? 'disabled' : ''} style="background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;">${[['30d', 'last 30 days'], ['90d', 'last 90 days'], ['12m', 'last 12 months'], ['18m', 'last 18 months'], ['custom', 'custom…']].map(([k, l]) => `<option value="${k}" ${fdRange === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`
            + (fdRange === 'custom' ? `<input type="date" data-fd-date="start" value="${escapeHtml(fdStart)}" style="background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;"> → <input type="date" data-fd-date="end" value="${escapeHtml(fdEnd)}" style="background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;">` : `<span style="color:#666">${fdRangeLabel()}</span>`)
            + '</div>');
        out.push('<div style="padding:6px 10px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + (fdRun
                ? `<span data-ft="fd-abort" style="cursor:pointer;color:#ff5252;font-weight:bold">■ Abort</span><span style="color:#ffa030">⏳ ${fdRun.done}/${fdRun.total} sites · ${escapeHtml(fdRun.msg)}</span>`
                : `<span data-ft="fd-export" style="cursor:pointer;color:${fdSelected.size ? '#5fff5f' : '#555'};font-weight:bold">⬇ Export ${fdSelected.size} site(s) as ZIP</span>`)
            + '<span style="color:#666">per-site JSON + CSV, combined ALL-*.csv, README — nothing is written to Percepto</span>'
            + '</div>');
        out.push(renderKmlExportRow());   // v0.32: ⭕ site circles / 🗺 site setups KML
        out.push(renderSheetsExportRow());   // v0.41 (#270): 📊 every entity of every picked site → Sheets / CSV
        // browse
        if (fdBrowse) {
            const b = fdBrowse;
            const tabs = [['setup', '🗺 Site setup'], ['missions', '🧭 Missions'], ['log', '🛫 Mission log']];
            const { cols, rows } = fdBrowseRows();
            const cached = b.tab === 'setup' ? fdCache.setup[b.sid] : b.tab === 'missions' ? fdCache.missions[b.sid]
                : (fdCache.log[b.sid] && fdCache.log[b.sid].key === fdLogKey() ? fdCache.log[b.sid] : null);
            out.push(`<div style="padding:6px 10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;background:#10141a">`
                + `<span style="color:#7adfe6;font-weight:bold">🔍 ${escapeHtml(siteName(b.sid))}</span><span style="color:#555">#${b.sid}</span>`
                + tabs.map(([k, l]) => `<span data-fd-tab="${k}" style="cursor:pointer;padding:2px 8px;border-radius:10px;border:1px solid ${b.tab === k ? '#7adfe6' : '#2a3140'};color:${b.tab === k ? '#7adfe6' : '#aaa'};background:${b.tab === k ? '#1a2e33' : 'transparent'}">${l}</span>`).join('')
                + `<input type="text" data-fd-search value="${escapeHtml(b.search || '')}" placeholder="search rows…" style="width:160px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 6px;font:inherit;">`
                + `<span data-ft="fd-copy" style="cursor:pointer;color:#7adfe6">📋 Copy CSV (${rows.length})</span>`
                + `<span data-ft="fd-reload" style="cursor:pointer;color:#7adfe6" title="re-fetch this tab from Percepto">⟳</span>`
                + `<span data-ft-link="${b.sid}" style="cursor:pointer;color:#5fb3ff">↗ open</span>`
                + `<span data-ft="fd-browse-close" style="cursor:pointer;color:#888;margin-left:auto">✕</span></div>`);
            if (b.loading) out.push(`<div style="padding:8px 10px;color:#ffa030">⏳ loading ${b.tab === 'log' ? `mission log ${fdRangeLabel()}${b.progress ? ' · ' + b.progress : ''}` : b.tab}…</div>`);
            else if (b.error) out.push(`<div style="padding:8px 10px;color:#ff5252">⚠ ${escapeHtml(b.error)}</div>`);
            else if (!rows.length) out.push(`<div style="padding:8px 10px;color:#888">${cached ? 'No rows' + (b.search ? ' match the search' : '') + '.' : (b.tab === 'log' ? 'Window changed — press ⟳ to load the mission log for ' + escapeHtml(fdRangeLabel()) + '.' : 'Nothing loaded yet.')}</div>`);
            else {
                const CAP = 1500;
                out.push(`<div style="padding:2px 10px;color:#666">${rows.length} row(s)${b.tab === 'log' && cached ? ` · window ${fdRangeLabel()} · server total ${cached.total}` : ''}${cached ? ` · fetched ${Math.round((Date.now() - cached.at) / 60000)} min ago` : ''}${rows.length > CAP ? ` · showing first ${CAP} (CSV has all)` : ''}</div>`);
                out.push(`<div style="max-height:${fdWide ? '55vh' : '40vh'};overflow:auto;"><table style="border-collapse:collapse;width:100%;font:inherit;white-space:nowrap;">`
                    + '<thead><tr style="color:#7adfe6;text-align:left;position:sticky;top:0;background:#14181f;z-index:1">' + cols.map(c => `<th style="padding:3px 8px;border-bottom:1px solid #2a3140">${escapeHtml(c.label)}</th>`).join('') + '</tr></thead><tbody>'
                    + rows.slice(0, CAP).map(r => '<tr class="aim-ft-row" style="border-bottom:1px solid #1d2430">' + cols.map(c => { const v = c.get(r); const s = v == null ? '' : String(v); return `<td style="padding:2px 8px;max-width:260px;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(s)}">${escapeHtml(s)}</td>`; }).join('') + '</tr>').join('')
                    + '</tbody></table></div>');
            }
        } else {
            out.push('<div style="padding:6px 10px;color:#666">Click 🔍 next to any site to browse its live site setup, missions, or mission log here without opening it.</div>');
        }
        return out.join('');
    }

    function fdRenderKeepScroll() {
        const list = panelEl && panelEl.querySelector('#aim-fd-list');
        const st = list ? list.scrollTop : 0;
        renderPanel();
        const again = panelEl && panelEl.querySelector('#aim-fd-list');
        if (again) again.scrollTop = st;
    }
    // ==================================================================
    // 🗺 FLEET KML EXPORTS (v0.32) — from the Fleet Data site picker:
    //   ⭕ Site circles: one ground circle per site that ENCLOSES every
    //      entity of its setup (minimum enclosing circle + pad) → one KML,
    //      folder per client.
    //   🗺 Site setups: every picked site's full setup in ONE KML with the
    //      Site Setup Analyzer's folder layout + styles (2D or 3D), nested
    //      client → site → entity-type folders.
    // Live /map_objects/ per site (fdFetchSetup, 10-min cache), read-only.
    // ==================================================================
    const KX_FT_TO_M = 0.3048;
    let kxCirclePadFt = 100;
    let kxMode = '2D';
    let kxInclude = { assets: true, ffzs: true, fps: true, nfzs: true, markers: true, base: true, safe: true };

    // Client grouping for the picker: "Exxon 40 - Atkins…" → "Exxon",
    // "Diamondback Cobra 01" → "Diamondback Cobra", "CHS - McPherson" → "CHS".
    // (clientOf() keeps the raw "Exxon 40" prefix — the sweep's chips rely on it.)
    function clientGroupOf(name) {
        let s = String(name || '').trim();
        const i = s.indexOf(' - ');
        if (i > 0) s = s.slice(0, i);
        const toks = s.split(/\s+/).filter(Boolean);
        while (toks.length > 1 && /\d/.test(toks[toks.length - 1])) toks.pop();
        return toks.join(' ') || '(unnamed)';
    }

    const xmlEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    const kxCoords = (pts, alt) => (pts || []).filter(p => p && typeof p.lat === 'number' && typeof p.lng === 'number').map(p => `${p.lng},${p.lat},${alt != null ? alt : 0}`).join(' ');
    function kxCloseRing(pts) {
        if (!Array.isArray(pts) || pts.length < 2) return pts || [];
        const a = pts[0], z = pts[pts.length - 1];
        return (a.lat === z.lat && a.lng === z.lng) ? pts : pts.concat([a]);
    }
    function kxCircleRing(lat, lng, radiusM, n) {
        const mLat = 111320, mLng = 111320 * Math.cos(lat * Math.PI / 180) || 1e-9;
        const pts = [];
        for (let i = 0; i <= n; i++) {
            const t = (i / n) * 2 * Math.PI;
            pts.push({ lat: lat + radiusM * Math.cos(t) / mLat, lng: lng + radiusM * Math.sin(t) / mLng });
        }
        return pts;
    }
    // Every geometry point of a setup (rings, arcs, points).
    function kxAllPoints(entities) {
        const out = [];
        (entities || []).forEach(e => {
            if (!e) return;
            (entityCoords(e) || []).forEach(p => { if (p && typeof p.lat === 'number' && typeof p.lng === 'number') out.push(p); });
            if (Array.isArray(e.arcs)) e.arcs.forEach(a => { if (a) { if (a.point_a && typeof a.point_a.lat === 'number') out.push(a.point_a); if (a.point_b && typeof a.point_b.lat === 'number') out.push(a.point_b); } });
        });
        return out;
    }
    // Minimum enclosing circle (Bădoiu–Clarkson iteration on a local
    // equirectangular plane) — within ~1% of optimal, always encloses.
    function kxEnclosingCircle(points) {
        if (!points.length) return null;
        const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
        const mLat = 111320, mLng = 111320 * Math.cos(lat0 * Math.PI / 180) || 1e-9;
        const xy = points.map(p => ({ x: (p.lng) * mLng, y: p.lat * mLat }));
        let cx = xy.reduce((s, p) => s + p.x, 0) / xy.length, cy = xy.reduce((s, p) => s + p.y, 0) / xy.length;
        const far = () => { let b = 0, d = 0; for (let i = 0; i < xy.length; i++) { const dd = Math.hypot(xy[i].x - cx, xy[i].y - cy); if (dd > d) { d = dd; b = i; } } return { i: b, d }; };
        for (let k = 1; k <= 200; k++) { const f = far(); cx += (xy[f.i].x - cx) / (k + 1); cy += (xy[f.i].y - cy) / (k + 1); }
        const r = far().d;   // radius = distance to the farthest point from the final centre → guaranteed to enclose
        return { lat: cy / mLat, lng: cx / mLng, radiusM: r };
    }

    function kxStyles(mode) {
        const m3 = mode === '3D';
        const noFill = '<PolyStyle><fill>0</fill></PolyStyle>';
        return [
            '<Style id="asset_style"><LineStyle><color>ffb469ff</color><width>4</width></LineStyle>' + noFill + '</Style>',
            '<Style id="asset_unshielded_style"><LineStyle><color>ff00a5ff</color><width>4</width></LineStyle>' + noFill + '</Style>',
            '<Style id="asset_unreachable_style"><LineStyle><color>ffffaf5f</color><width>4</width></LineStyle>' + noFill + '</Style>',
            '<Style id="asset_empty_style"><LineStyle><color>59ffffff</color><width>4</width></LineStyle>' + noFill + '</Style>',
            `<Style id="freezone_style"><LineStyle><color>ff00ff00</color><width>2</width></LineStyle><PolyStyle>${m3 ? '<color>3300ff00</color>' : '<fill>0</fill>'}</PolyStyle></Style>`,
            `<Style id="nofly_style"><LineStyle><color>ff0000ff</color><width>2</width></LineStyle><PolyStyle>${m3 ? '<color>330000ff</color>' : '<fill>0</fill>'}</PolyStyle></Style>`,
            '<Style id="flightpath_style"><LineStyle><color>ffffff00</color><width>3</width></LineStyle>' + noFill + '</Style>',
            '<Style id="generalmarker-general_style"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/paddle/purple-circle.png</href></Icon></IconStyle></Style>',
            '<Style id="generalmarker-tower_style"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/flag.png</href></Icon></IconStyle></Style>',
            '<Style id="generalmarker-hazard_style"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/caution.png</href></Icon></IconStyle></Style>',
            '<Style id="basestation_style"><IconStyle><color>ff4fd5ff</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/heliport.png</href></Icon></IconStyle></Style>',
            '<Style id="safezone_style"><IconStyle><color>ffb59eff</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/parking_lot.png</href></Icon></IconStyle></Style>',
            '<Style id="sitecircle_style"><LineStyle><color>ffe6df7a</color><width>3</width></LineStyle><PolyStyle><color>22e6df7a</color></PolyStyle></Style>',
            '<Style id="sitecenter_style"><IconStyle><scale>0.7</scale><color>ffe6df7a</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>',
        ].join('\n');
    }
    function kxAssetStyle(e) {
        const sub = (e.custom && e.custom.poi_type_str) || '';
        const mods = sub.split(' - ').slice(1).map(s => s.trim().toLowerCase());
        const has = (m) => mods.some(x => x.includes(m));
        if (e.is_unshielded || has('unshielded')) return 'asset_unshielded_style';
        if (has('unreachable')) return 'asset_unreachable_style';
        if (has('empty')) return 'asset_empty_style';
        return 'asset_style';
    }
    function kxDesc(e, siteLabel) {
        const L = [`<b>${xmlEsc(e.name || '')}</b>`, `Site: ${xmlEsc(siteLabel)}`, `Type: ${xmlEsc(FD_TYPE[e.type] || ('type ' + e.type))}`];
        const sub = (e.custom && e.custom.poi_type_str) || e.general_marker_type || '';
        if (sub) L.push(`Subtype: ${xmlEsc(sub)}`);
        if (e.validated != null) L.push(`Validated: ${e.validated ? 'yes' : 'no'}`);
        if (e.is_unshielded) L.push('Unshielded: yes');
        const alt = fdAltFt(e); if (alt) L.push(`Altitude band: ${alt} ft MSL`);
        if (e.description) L.push(xmlEsc(e.description));
        L.push(`ID: ${e.id}`);
        return `<![CDATA[${L.join('<br>')}]]>`;
    }
    function kxPolygon(ring, mode, extrude, altM, altMode) {
        return `<Polygon>${extrude ? '<extrude>1</extrude>' : ''}<altitudeMode>${altMode}</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kxCoords(ring, altM)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    }
    function kxAssetGeom(e, mode) {
        const c = entityCoords(e) || [];
        if (c.length < 3) return c[0] ? `<Point><altitudeMode>clampToGround</altitudeMode><coordinates>${kxCoords([c[0]])}</coordinates></Point>` : '';
        const ring = kxCloseRing(c);
        return mode === '3D' ? kxPolygon(ring, mode, true, 20 * KX_FT_TO_M, 'relativeToGround') : kxPolygon(ring, mode, false, 0, 'clampToGround');
    }
    function kxFfzGeom(e, mode) {
        const c = entityCoords(e) || [];
        if (c.length < 3) return '';
        const ring = kxCloseRing(c);
        if (mode === '3D') {
            const r = e.restrictions || {};
            if (r.minAlt == null) return '';
            const minA = r.minAlt, maxA = r.maxAlt != null ? r.maxAlt : minA + 37;
            const faces = [kxPolygon(ring, mode, false, minA, 'absolute'), kxPolygon(ring, mode, false, maxA, 'absolute')];
            for (let i = 0; i < c.length; i++) {
                const p1 = c[i], p2 = c[(i + 1) % c.length];
                faces.push(`<Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${p1.lng},${p1.lat},${minA} ${p2.lng},${p2.lat},${minA} ${p2.lng},${p2.lat},${maxA} ${p1.lng},${p1.lat},${maxA} ${p1.lng},${p1.lat},${minA}</coordinates></LinearRing></outerBoundaryIs></Polygon>`);
            }
            return `<MultiGeometry>${faces.join('')}</MultiGeometry>`;
        }
        return kxPolygon(ring, mode, false, 0, 'clampToGround');
    }
    function kxNfzGeom(e, mode) {
        const c = entityCoords(e) || [];
        if (c.length < 3) return '';
        const ring = kxCloseRing(c);
        return mode === '3D' ? kxPolygon(ring, mode, true, 400 * KX_FT_TO_M, 'relativeToGround') : kxPolygon(ring, mode, false, 0, 'clampToGround');
    }
    function kxArcGeom(a, mode) {
        if (!a || !a.point_a || !a.point_b) return '';
        const p1 = a.point_a, p2 = a.point_b;
        if (mode === '3D' && typeof a.min_alt === 'number' && typeof a.max_alt === 'number') {
            return `<MultiGeometry><Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${p1.lng},${p1.lat},${a.min_alt} ${p2.lng},${p2.lat},${a.min_alt} ${p2.lng},${p2.lat},${a.max_alt} ${p1.lng},${p1.lat},${a.max_alt} ${p1.lng},${p1.lat},${a.min_alt}</coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry>`;
        }
        return `<LineString><altitudeMode>clampToGround</altitudeMode><coordinates>${kxCoords([p1, p2], 0)}</coordinates></LineString>`;
    }
    function kxPointGeom(e, mode) {
        const c = (entityCoords(e) || [])[0];
        if (!c) return '';
        if (mode === '3D' && typeof e.marker_height === 'number' && e.marker_height > 0) return `<Point><extrude>1</extrude><altitudeMode>relativeToGround</altitudeMode><coordinates>${c.lng},${c.lat},${e.marker_height}</coordinates></Point>`;
        return `<Point><altitudeMode>clampToGround</altitudeMode><coordinates>${c.lng},${c.lat},0</coordinates></Point>`;
    }
    // One site's setup as the Analyzer's folder set (returned as XML fragments).
    function kxSiteFolders(entities, siteLabel, mode, inc) {
        const by = { 3: [], 4: [], 8: [], 15: [], 16: [], 98: [], gm: { general: [], tower: [], hazard: [] } };
        (entities || []).forEach(e => {
            if (!e || typeof e.type !== 'number') return;
            if (e.type === 19) { const t = String(e.general_marker_type || 'general').toLowerCase(); (by.gm[t] || by.gm.general).push(e); }
            else if (by[e.type]) by[e.type].push(e);
        });
        const pm = (e, style, geom) => geom ? `<Placemark id="pm_${e.id}"><name>${xmlEsc(e.name)}</name><description>${kxDesc(e, siteLabel)}</description><styleUrl>#${style}</styleUrl>${geom}</Placemark>` : '';
        const out = [];
        const folder = (name, items) => { const body = items.filter(Boolean).join(''); if (body) out.push(`<Folder><name>${xmlEsc(name)}</name>${body}</Folder>`); };
        if (inc.assets) folder('Asset', by[3].map(e => pm(e, kxAssetStyle(e), kxAssetGeom(e, mode))));
        if (inc.fps && by[15].length) {
            const fps = by[15].map(e => {
                const arcs = (Array.isArray(e.arcs) ? e.arcs : []).map((a, i) => { const g = kxArcGeom(a, mode); return g ? `<Placemark id="arc_${a.id != null ? a.id : e.id + '_' + i}"><name>${xmlEsc(mode === '3D' ? `${e.name} - Segment ${a.id != null ? a.id : i + 1}` : e.name)}</name><description><![CDATA[${xmlEsc(e.name)} · ${xmlEsc(siteLabel)}<br>Arc ${i + 1}: ${typeof a.min_alt === 'number' ? Math.round(a.min_alt * FT_PER_M) + '–' + Math.round((a.max_alt || a.min_alt) * FT_PER_M) + ' ft MSL' : ''}${typeof a.distance === 'number' ? ' · ' + Math.round(a.distance * FT_PER_M) + ' ft' : ''}]]></description><styleUrl>#flightpath_style</styleUrl>${g}</Placemark>` : ''; }).join('');
                return arcs ? `<Folder id="fp_${e.id}"><name>${xmlEsc(e.name)}</name>${arcs}</Folder>` : '';
            });
            folder('Flight Path', fps);
        }
        if (inc.ffzs) folder('Freezone', by[16].map(e => pm(e, 'freezone_style', kxFfzGeom(e, mode))));
        if (inc.nfzs) folder('No-fly', by[4].map(e => pm(e, 'nofly_style', kxNfzGeom(e, mode))));
        if (inc.markers) {
            folder('General Marker - General', by.gm.general.map(e => pm(e, 'generalmarker-general_style', kxPointGeom(e, mode))));
            folder('General Marker - Tower', by.gm.tower.map(e => pm(e, 'generalmarker-tower_style', kxPointGeom(e, mode))));
            folder('General Marker - Hazard', by.gm.hazard.map(e => pm(e, 'generalmarker-hazard_style', kxPointGeom(e, mode))));
        }
        if (inc.base) folder('Base Station', by[8].map(e => pm(e, 'basestation_style', kxPointGeom(e, mode))));
        if (inc.safe) folder('Safe Zone', by[98].map(e => pm(e, 'safezone_style', kxPointGeom(e, mode))));
        return out.join('');
    }

    // Fetch every picked site's setup (sequential, cached) with progress/abort.
    async function kxCollect(sids, label) {
        const got = new Map(); const failed = [];
        for (let i = 0; i < sids.length; i++) {
            if (fdRun && fdRun.abort) break;
            const sid = sids[i];
            fdRun.done = i; fdRun.msg = `${label} — ${siteName(sid)} (${i + 1}/${sids.length})`; setStatus(fdRun.msg);
            try { got.set(sid, (await fdFetchSetup(sid)).entities); }
            catch (e) { failed.push(`${siteName(sid)}: ${e.message || e}`); }
            if (i % 5 === 4) { renderPanel(); await ftYield(); }
        }
        return { got, failed };
    }
    function kxGroupByClient(sids) {
        const g = new Map();
        sids.forEach(sid => { const c = fdClientOfId(sid); if (!g.has(c)) g.set(c, []); g.get(c).push(sid); });
        return Array.from(g.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    }
    async function kxExportCircles() {
        const sids = Array.from(fdSelected);
        if (!sids.length) { setStatus('pick at least one site first'); return; }
        fdNotePick();
        if (fdRun) return;
        fdRun = { done: 0, total: sids.length, msg: 'starting…', abort: false };
        renderPanel();
        try {
            const { got, failed } = await kxCollect(sids, 'site circles');
            const padM = Math.max(0, Number(kxCirclePadFt) || 0) * KX_FT_TO_M;
            const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', `<Document><name>AIM site circles (${got.size} sites, +${Math.round(padM * FT_PER_M)} ft pad)</name>`,
                `<description><![CDATA[Generated by AIM Fleet Tools v${SCRIPT_VERSION} · ${new Date().toISOString().slice(0, 10)}<br>One circle per site enclosing every entity of its Site Setup (minimum enclosing circle + pad).]]></description>`, kxStyles('2D')];
            const rows = []; let empty = 0;
            kxGroupByClient(Array.from(got.keys())).forEach(([client, ids]) => {
                xml.push(`<Folder><name>${xmlEsc(client)}</name>`);
                ids.sort((a, b) => siteName(a).localeCompare(siteName(b))).forEach(sid => {
                    const ents = got.get(sid);
                    const mec = kxEnclosingCircle(kxAllPoints(ents));
                    if (!mec) { empty++; return; }
                    const rM = mec.radiusM + padM;
                    const ring = kxCircleRing(mec.lat, mec.lng, rM, 72);
                    const nm = siteName(sid);
                    const ext = `<ExtendedData><Data name="site_id"><value>${sid}</value></Data><Data name="site_name"><value>${xmlEsc(nm)}</value></Data><Data name="client"><value>${xmlEsc(client)}</value></Data><Data name="radius_ft"><value>${Math.round(rM * FT_PER_M)}</value></Data><Data name="center_lat"><value>${mec.lat.toFixed(6)}</value></Data><Data name="center_lng"><value>${mec.lng.toFixed(6)}</value></Data><Data name="entities"><value>${(ents || []).length}</value></Data></ExtendedData>`;
                    xml.push(`<Placemark id="circle_${sid}"><name>${xmlEsc(nm)}</name><description><![CDATA[<b>${xmlEsc(nm)}</b> (#${sid})<br>Radius ${Math.round(rM * FT_PER_M).toLocaleString()} ft (${(rM * FT_PER_M / 5280).toFixed(2)} mi) incl. ${Math.round(padM * FT_PER_M)} ft pad<br>Center ${mec.lat.toFixed(6)}, ${mec.lng.toFixed(6)}<br>${(ents || []).length} entities · ${xmlEsc(siteStatus(sid) || '')}]]></description><styleUrl>#sitecircle_style</styleUrl>${ext}${kxPolygon(ring, '2D', false, 0, 'clampToGround')}</Placemark>`);
                    xml.push(`<Placemark id="center_${sid}"><name>${xmlEsc(nm)} — center</name><styleUrl>#sitecenter_style</styleUrl><Point><altitudeMode>clampToGround</altitudeMode><coordinates>${mec.lng},${mec.lat},0</coordinates></Point></Placemark>`);
                    rows.push([sid, nm, client, Math.round(rM * FT_PER_M), mec.lat.toFixed(6), mec.lng.toFixed(6), (ents || []).length]);
                });
                xml.push('</Folder>');
            });
            xml.push('</Document></kml>');
            const stamp = new Date().toISOString().slice(0, 10);
            fdDownload(new Blob([xml.join('\n')], { type: 'application/vnd.google-earth.kml+xml' }), `AIM-site-circles ${stamp} (${rows.length} sites).kml`);
            setStatus(`site circles KML downloaded — ${rows.length} circle(s)${empty ? ` · ${empty} site(s) had no geometry` : ''}${failed.length ? ` · ${failed.length} fetch failure(s) (console)` : ''}${fdRun.abort ? ' · ABORTED (partial)' : ''}`);
            if (failed.length) console.warn(`${TAG} site circles: failures`, failed);
        } catch (e) { console.error(`${TAG} site circles failed:`, e); setStatus(`site circles failed — ${String(e && e.message || e)}`); }
        finally { fdRun = null; renderPanel(); }
    }
    async function kxExportSetups() {
        const sids = Array.from(fdSelected);
        if (!sids.length) { setStatus('pick at least one site first'); return; }
        fdNotePick();
        if (fdRun) return;
        fdRun = { done: 0, total: sids.length, msg: 'starting…', abort: false };
        renderPanel();
        try {
            const { got, failed } = await kxCollect(sids, `site setups ${kxMode}`);
            const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', `<Document><name>AIM site setups (${got.size} sites, ${kxMode})</name>`,
                `<description><![CDATA[Generated by AIM Fleet Tools v${SCRIPT_VERSION} · ${new Date().toISOString().slice(0, 10)}<br>Layout matches the Site Setup Analyzer export: client → site → entity-type folders.]]></description>`, kxStyles(kxMode)];
            let placed = 0;
            kxGroupByClient(Array.from(got.keys())).forEach(([client, ids]) => {
                xml.push(`<Folder><name>${xmlEsc(client)}</name>`);
                ids.sort((a, b) => siteName(a).localeCompare(siteName(b))).forEach(sid => {
                    const nm = siteName(sid);
                    const body = kxSiteFolders(got.get(sid), `${nm} (#${sid})`, kxMode, kxInclude);
                    if (!body) return;
                    placed++;
                    xml.push(`<Folder id="site_${sid}"><name>${xmlEsc(nm)}</name><description><![CDATA[Site #${sid} · ${(got.get(sid) || []).length} entities · ${xmlEsc(siteStatus(sid) || '')}]]></description>${body}</Folder>`);
                });
                xml.push('</Folder>');
            });
            xml.push('</Document></kml>');
            const text = xml.join('\n');
            const stamp = new Date().toISOString().slice(0, 10);
            fdDownload(new Blob([text], { type: 'application/vnd.google-earth.kml+xml' }), `AIM-site-setups ${stamp} ${kxMode} (${placed} sites).kml`);
            setStatus(`site setups KML downloaded — ${placed} site(s), ${(text.length / 1048576).toFixed(1)} MB${failed.length ? ` · ${failed.length} fetch failure(s) (console)` : ''}${fdRun.abort ? ' · ABORTED (partial)' : ''}`);
            if (failed.length) console.warn(`${TAG} site setups KML: failures`, failed);
        } catch (e) { console.error(`${TAG} site setups KML failed:`, e); setStatus(`site setups KML failed — ${String(e && e.message || e)}`); }
        finally { fdRun = null; renderPanel(); }
    }
    function renderKmlExportRow() {
        const inc = (k, l) => `<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" data-kx-inc="${k}" ${kxInclude[k] ? 'checked' : ''} ${fdRun ? 'disabled' : ''}> ${l}</label>`;
        return '<div style="padding:6px 10px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + '<span style="color:#888">KML:</span>'
            + `<span data-ft="kx-circles" title="One ground circle per picked site, enclosing every entity of its setup (+ pad)" style="cursor:pointer;color:${fdSelected.size && !fdRun ? '#5fff5f' : '#555'};font-weight:bold">⭕ Site circles</span>`
            + `<label title="Extra radius added to each enclosing circle">pad <input type="number" data-kx-pad value="${kxCirclePadFt}" min="0" max="10000" step="50" ${fdRun ? 'disabled' : ''} style="width:60px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;padding:1px 3px;"> ft</label>`
            + '<span style="width:1px;height:16px;background:#2a3140"></span>'
            + `<span data-ft="kx-setups" title="Every picked site's full setup in one KML (Site Setup Analyzer layout: client → site → type folders)" style="cursor:pointer;color:${fdSelected.size && !fdRun ? '#5fff5f' : '#555'};font-weight:bold">🗺 Site setups</span>`
            + `<select data-kx-mode ${fdRun ? 'disabled' : ''} style="background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;"><option value="2D" ${kxMode === '2D' ? 'selected' : ''}>2D (ground)</option><option value="3D" ${kxMode === '3D' ? 'selected' : ''}>3D (altitude boxes)</option></select>`
            + inc('assets', 'Assets') + inc('ffzs', 'FFZ') + inc('fps', 'FP') + inc('nfzs', 'NFZ') + inc('markers', 'Markers') + inc('base', 'Base') + inc('safe', 'Safe')
            + '</div>';
    }

    // ==================================================================
    // 📊 FLEET SHEETS EXPORT (v0.41, #270) — every entity of every picked
    // site as ONE flat table (client → site → type → name), with per-type
    // include checkboxes. 📊 Copy → Sheets writes rich HTML + TSV to the
    // clipboard (paste straight into Google Sheets / Excel); ⬇ CSV downloads
    // the same table. Columns are the union of everything /map_objects/
    // carries for the ticked types (asset custom.* fields, FFZ/NFZ
    // restrictions, FP arcs, base-station drone, …). "Key: value | Key: value"
    // descriptions (the Exxon asset convention) are split into their own
    // Desc: columns so the client's own asset ID lands in a sortable cell.
    // Live /map_objects/ per site (fdFetchSetup, 10-min cache), read-only.
    // ==================================================================
    const KEY_FX = 'aim-ft-sheets-opts';
    const FX_TYPES = [
        { key: 'assets',  type: 3,  label: 'Assets' },
        { key: 'ffzs',    type: 16, label: 'FFZ' },
        { key: 'fps',     type: 15, label: 'FP' },
        { key: 'nfzs',    type: 4,  label: 'NFZ' },
        { key: 'markers', type: 19, label: 'Markers' },
        { key: 'base',    type: 8,  label: 'Base' },
        { key: 'safe',    type: 98, label: 'Safe' },
    ];
    const fxOpts = (() => {
        const def = { inc: { assets: true, ffzs: true, fps: true, nfzs: true, markers: true, base: true, safe: true }, splitDesc: true, geometry: false, raw: false };
        const s = loadJson(KEY_FX, {});
        if (s.inc && typeof s.inc === 'object') Object.keys(def.inc).forEach(k => { if (typeof s.inc[k] === 'boolean') def.inc[k] = s.inc[k]; });
        ['splitDesc', 'geometry', 'raw'].forEach(k => { if (typeof s[k] === 'boolean') def[k] = s[k]; });
        return def;
    })();
    const fxSave = () => gmSet(KEY_FX, JSON.stringify(fxOpts));
    let fxLast = null;   // { rows, sites, failed, aborted, at } — shown in the row after an export

    const fxFt = (m) => (typeof m === 'number' && isFinite(m)) ? Math.round(m * FT_PER_M * 10) / 10 : '';
    const fxVal = (v) => (v == null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
    const fxYesNo = (v) => v == null ? '' : (v ? 'yes' : 'no');
    const fxCustom = (e, k) => (e.custom && typeof e.custom === 'object' && !Array.isArray(e.custom)) ? fxVal(e.custom[k]) : '';
    const fxRestr = (e, k) => (e.restrictions && typeof e.restrictions === 'object' && !Array.isArray(e.restrictions)) ? e.restrictions[k] : undefined;
    const fxDrone = (e) => (e.custom && e.custom.allocated_by_drone && typeof e.custom.allocated_by_drone === 'object') ? e.custom.allocated_by_drone : null;
    // Every vertex of an entity: polygon ring / point / FP waypoints, else the arc chain.
    function fxPoints(e) {
        const pts = (entityCoords(e) || []).filter(p => p && typeof p.lat === 'number' && typeof p.lng === 'number');
        if (pts.length) return pts;
        const out = [];
        if (Array.isArray(e.arcs)) e.arcs.forEach((a, i) => { if (!a) return; if (i === 0 && a.point_a && typeof a.point_a.lat === 'number') out.push(a.point_a); if (a.point_b && typeof a.point_b.lat === 'number') out.push(a.point_b); });
        return out;
    }
    function fxCentroid(e) {
        const pts = fxPoints(e);
        if (!pts.length) return null;
        // closed rings repeat the first vertex — drop it so it doesn't double-weight
        const ring = (pts.length > 3 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lng === pts[pts.length - 1].lng) ? pts.slice(0, -1) : pts;
        return { lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length, lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length };
    }
    function fxArcStats(e) {
        const st = { n: 0, lenM: 0, lo: Infinity, hi: -Infinity, em: Infinity, wait: 0 };
        if (!Array.isArray(e.arcs)) return st;
        e.arcs.forEach(a => {
            if (!a) return;
            st.n++;
            if (typeof a.distance === 'number') st.lenM += a.distance;
            else if (a.point_a && a.point_b && typeof a.point_a.lat === 'number' && typeof a.point_b.lat === 'number') st.lenM += haversineM(a.point_a.lat, a.point_a.lng, a.point_b.lat, a.point_b.lng);
            if (typeof a.min_alt === 'number') st.lo = Math.min(st.lo, a.min_alt);
            if (typeof a.max_alt === 'number') st.hi = Math.max(st.hi, a.max_alt);
            if (typeof a.min_emergency_alt === 'number') st.em = Math.min(st.em, a.min_emergency_alt);
            if (a.wait_until_approved) st.wait++;
        });
        return st;
    }
    function haversineM(lat1, lng1, lat2, lng2) {
        const R = 6371008.8, d = Math.PI / 180;
        const a = Math.sin((lat2 - lat1) * d / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lng2 - lng1) * d / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }
    // "Desig: h-Pioneer | Div: PER MID Northwest | ID: 34409" → [['Desig','h-Pioneer'], …]; [] when it isn't that shape.
    function fxDescPairs(desc) {
        const s = String(desc == null ? '' : desc).trim();
        if (!s || s.indexOf(':') < 0) return [];
        const pairs = [];
        for (const part of s.split('|')) {
            const i = part.indexOf(':');
            if (i <= 0) return [];   // a piece without "key:" → not the key/value convention, keep it as plain text
            const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
            if (!k || k.length > 40 || !/[A-Za-z]/.test(k) || /^(https?|ftp|s3|file)$/i.test(k) || v.startsWith('//')) return [];
            pairs.push([k, v]);
        }
        return pairs;
    }
    // Column registry. `t` = entity types the column applies to (null = every type);
    // a column is emitted when at least one ticked type uses it. get(e, r) → cell value.
    const FX_COLS = [
        { label: 'Client', get: (e, r) => r.client },
        { label: 'Site ID', get: (e, r) => r.sid },
        { label: 'Site', get: (e, r) => r.site, link: (e, r) => siteSetupUrl(r.sid) },
        { label: 'Site status', get: (e, r) => siteStatus(r.sid) || '' },
        { label: 'Entity ID', get: e => e.id },
        { label: 'Type', get: e => FD_TYPE[e.type] || `type ${e.type}` },
        { label: 'Type code', get: e => e.type },
        { label: 'Name', get: e => e.name || '' },
        { label: 'Subtype', get: e => (e.custom && e.custom.poi_type_str) || '', t: [3] },
        { label: 'Equipment', get: e => mtParseSubtype(e.custom && e.custom.poi_type_str).typeKey, t: [3] },
        { label: 'State', get: e => (e.custom && e.custom.poi_type_str) ? mtParseSubtype(e.custom.poi_type_str).state : '', t: [3] },
        // #273 nested assets (r.nest = buildAssetTree node for this entity, computed per site in fxBuildTable)
        { label: 'Parent asset', get: (e, r) => r.nest ? (r.nest.parentName || '') : '', t: [3] },
        { label: 'Nest depth', get: (e, r) => r.nest ? r.nest.depth : '', t: [3] },
        { label: 'Child assets', get: (e, r) => r.nest ? r.nest.children.length : '', t: [3] },
        { label: 'Marker type', get: e => e.general_marker_type || '', t: [19] },
        { label: 'Marker height', get: e => fxVal(e.marker_height), t: [19] },
        { label: 'Description', get: e => e.description == null ? '' : String(e.description) },
        { label: 'Validated', get: e => fxYesNo(e.validated) },
        { label: 'Unshielded', get: e => fxYesNo(e.is_unshielded) },
        { label: 'Lat', get: (e, r) => r.c ? Number(r.c.lat.toFixed(7)) : '' },
        { label: 'Lng', get: (e, r) => r.c ? Number(r.c.lng.toFixed(7)) : '' },
        { label: 'GPS', get: (e, r) => r.c ? `${r.c.lat.toFixed(6)}, ${r.c.lng.toFixed(6)}` : '' },
        { label: 'Vertices', get: (e, r) => r.pts.length },
        { label: 'Area (acres)', get: (e, r) => (e.type === 3 || e.type === 16 || e.type === 4) && r.pts.length >= 3 ? Math.round(mtRingAreaM2(r.pts) / 4046.8564 * 1000) / 1000 : '', t: [3, 16, 4] },
        { label: 'Min alt ft MSL', get: e => fxFt(fxRestr(e, 'minAlt')), t: [16, 4] },
        { label: 'Max alt ft MSL', get: e => fxFt(fxRestr(e, 'maxAlt')), t: [16, 4] },
        { label: 'Alt band ft', get: e => { const lo = fxRestr(e, 'minAlt'), hi = fxRestr(e, 'maxAlt'); return (typeof lo === 'number' && typeof hi === 'number') ? Math.round((hi - lo) * FT_PER_M * 10) / 10 : ''; }, t: [16, 4] },
        { label: 'Orig min alt (raw)', get: e => fxVal(fxRestr(e, 'origMinAlt')), t: [16, 4] },
        { label: 'Emergency alt ft MSL', get: e => fxFt(fxRestr(e, 'minEmergencyAlt')), t: [16, 4] },
        { label: 'Orig emergency alt (raw)', get: e => fxVal(fxRestr(e, 'origMinEmergencyAlt')), t: [16, 4] },
        { label: 'Arcs', get: (e, r) => r.arc.n, t: [15] },
        { label: 'Length ft', get: (e, r) => r.arc.n ? Math.round(r.arc.lenM * FT_PER_M) : '', t: [15] },
        { label: 'FP min alt ft MSL', get: (e, r) => isFinite(r.arc.lo) ? fxFt(r.arc.lo) : '', t: [15] },
        { label: 'FP max alt ft MSL', get: (e, r) => isFinite(r.arc.hi) ? fxFt(r.arc.hi) : '', t: [15] },
        { label: 'FP emergency alt (raw)', get: (e, r) => isFinite(r.arc.em) ? r.arc.em : '', t: [15] },
        { label: 'Wait-until-approved arcs', get: (e, r) => r.arc.n ? r.arc.wait : '', t: [15] },
        { label: 'Asset altitude', get: e => fxCustom(e, 'altitude'), t: [3] },
        { label: 'Height AGL', get: e => fxCustom(e, 'height_agl'), t: [3] },
        { label: 'Elevation ASL m', get: e => fxCustom(e, 'elevation_asl'), t: [3, 8] },
        { label: 'Elevation ASL ft', get: e => fxFt(e.custom && e.custom.elevation_asl), t: [3, 8] },
        { label: 'POI ID', get: e => fxCustom(e, 'poi_id'), t: [3] },
        { label: 'POI volume method', get: e => fxCustom(e, 'poi_volume_method'), t: [3] },
        { label: 'Pole feeder', get: e => fxCustom(e, 'pole_feeder'), t: [3] },
        { label: 'Pole usage', get: e => fxCustom(e, 'pole_usage'), t: [3] },
        { label: 'Pole is simple', get: e => e.custom && typeof e.custom.pole_is_simple === 'boolean' ? fxYesNo(e.custom.pole_is_simple) : '', t: [3] },
        { label: 'Constantly present', get: e => fxYesNo(e.constantly_present_asset_name), t: [3] },
        { label: 'Asset waypoints', get: e => Array.isArray(e.asset_waypoints) ? e.asset_waypoints.length : '', t: [3] },
        { label: 'Safe-zone altitude m', get: e => fxCustom(e, 'altitude'), t: [98] },
        { label: 'Safe-zone altitude ft', get: e => fxFt(e.custom && e.custom.altitude), t: [98] },
        { label: 'Heading', get: e => fxCustom(e, 'heading'), t: [8] },
        { label: 'Docking heading', get: e => fxCustom(e, 'docking_heading'), t: [8] },
        { label: 'Ground station ID', get: e => fxCustom(e, 'ground_station_id'), t: [8] },
        { label: 'Relative alt', get: e => fxCustom(e, 'relative_alt'), t: [8] },
        { label: 'Base active', get: e => e.custom && typeof e.custom.active === 'boolean' ? fxYesNo(e.custom.active) : '', t: [8] },
        { label: 'Doors status', get: e => fxCustom(e, 'doors_status'), t: [8] },
        { label: 'Drone', get: e => { const d = fxDrone(e); return d ? (d.name || '') : ''; }, t: [8] },
        { label: 'Drone ID', get: e => { const d = fxDrone(e); return d && d.id != null ? d.id : ''; }, t: [8] },
        { label: 'Drone type', get: e => { const d = fxDrone(e); return d ? (d.robot_type_name || '') : ''; }, t: [8] },
        { label: 'Drone connected', get: e => { const d = fxDrone(e); return d && typeof d.is_connected === 'boolean' ? fxYesNo(d.is_connected) : ''; }, t: [8] },
        { label: 'Drone battery %', get: e => { const d = fxDrone(e); return d && d.battery_status != null ? d.battery_status : ''; }, t: [8] },
        { label: 'Drone cameras', get: e => { const d = fxDrone(e); return d && d.camera_types && typeof d.camera_types === 'object' ? Object.keys(d.camera_types).join(', ') : ''; }, t: [8] },
        { label: 'Coordinates', get: (e, r) => r.pts.map(p => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`).join(' | '), opt: 'geometry' },
        { label: 'Arcs (a → b, alt m)', get: e => Array.isArray(e.arcs) ? e.arcs.map(a => a && a.point_a && a.point_b ? `${a.point_a.lat.toFixed(6)},${a.point_a.lng.toFixed(6)} → ${a.point_b.lat.toFixed(6)},${a.point_b.lng.toFixed(6)} [${a.min_alt}–${a.max_alt}]` : '').filter(Boolean).join(' | ') : '', t: [15], opt: 'geometry' },
        { label: 'Polygon (WKT)', get: e => e.polygon || '', t: [3, 16, 4], opt: 'geometry' },
        { label: 'Custom (JSON)', get: e => e.custom && Object.keys(e.custom).length ? JSON.stringify(e.custom) : '', opt: 'raw' },
        { label: 'Restrictions (JSON)', get: e => e.restrictions && !Array.isArray(e.restrictions) && Object.keys(e.restrictions).length ? JSON.stringify(e.restrictions) : '', opt: 'raw' },
        { label: 'Params (JSON)', get: e => e.params && Object.keys(e.params).length ? JSON.stringify(e.params) : '', opt: 'raw' },
        { label: 'Site setup link', get: (e, r) => siteSetupUrl(r.sid) },
    ];
    const fxTypeOrder = FX_TYPES.map(t => t.type);
    function fxSelectedTypes() { return FX_TYPES.filter(t => fxOpts.inc[t.key]).map(t => t.type); }
    // Build { cols, rows } from the collected setups. Rows carry precomputed
    // centroid / points / arc stats so each column getter stays cheap.
    function fxBuildTable(got) {
        const types = new Set(fxSelectedTypes());
        const rows = [];
        kxGroupByClient(Array.from(got.keys())).forEach(([client, ids]) => {
            ids.sort((a, b) => siteName(a).localeCompare(siteName(b))).forEach(sid => {
                const site = siteName(sid);
                const nestTree = buildAssetTree(got.get(sid) || []);   // #273 — from the FULL list, before the type filter
                const ents = (got.get(sid) || []).filter(e => e && types.has(e.type));
                ents.sort((a, b) => (fxTypeOrder.indexOf(a.type) - fxTypeOrder.indexOf(b.type)) || String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }) || ((a.id || 0) - (b.id || 0)));
                ents.forEach(e => {
                    const pts = fxPoints(e);
                    rows.push({ e, sid, site, client, pts, c: fxCentroid(e), nest: e.type === 3 ? (nestTree.byId.get(e.id) || null) : null, arc: e.type === 15 ? fxArcStats(e) : { n: 0, lenM: 0, lo: Infinity, hi: -Infinity, em: Infinity, wait: 0 } });
                });
            });
        });
        const cols = FX_COLS.filter(c => (!c.t || c.t.some(t => types.has(t))) && (!c.opt || fxOpts[c.opt])).map(c => ({ label: c.label, get: c.get, link: c.link, t: c.t }));
        if (fxOpts.splitDesc) {
            // one "Desc: <key>" column per distinct key, in first-seen order; rows that don't follow the convention leave them blank
            const keys = []; const seen = new Set();
            rows.forEach(r => { r.desc = {}; fxDescPairs(r.e.description).forEach(([k, v]) => { r.desc[k] = v; if (!seen.has(k)) { seen.add(k); keys.push(k); } }); });
            const at = cols.findIndex(c => c.label === 'Description') + 1;
            cols.splice(at || cols.length, 0, ...keys.map(k => ({ label: `Desc: ${k}`, get: (e, r) => (r.desc && r.desc[k] != null) ? r.desc[k] : '' })));
        }
        return { cols, rows };
    }
    // Type-gated columns stay blank on rows of other types (custom.altitude / general_marker_type exist on every entity).
    const fxCell = (col, r) => { if (col.t && !col.t.includes(r.e.type)) return ''; try { const v = col.get(r.e, r); return v == null ? '' : v; } catch (e) { console.warn(`${TAG} sheets export: column "${col.label}" failed for entity ${r.e && r.e.id}:`, e); return ''; } };
    function fxSheetsHtml(cols, rows) {
        const th = (s) => `<th style="background:#e8eaed;border:1px solid #bbb;padding:3px 6px;text-align:left;white-space:nowrap">${escapeHtml(s)}</th>`;
        const td = (s) => `<td style="border:1px solid #ccc;padding:2px 6px">${s}</td>`;
        const out = ['<table border="1" cellpadding="3" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:11px"><tr>' + cols.map(c => th(c.label)).join('') + '</tr>'];
        rows.forEach(r => out.push('<tr>' + cols.map(c => { const v = fxCell(c, r); return td(c.link ? `<a href="${escapeHtml(c.link(r.e, r))}" style="color:#1a73e8">${escapeHtml(String(v))}</a>` : escapeHtml(String(v))); }).join('') + '</tr>'));
        out.push('</table>');
        return out.join('');
    }
    function fxTsv(cols, rows) {
        const esc = (v) => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
        return [cols.map(c => esc(c.label)).join('\t')].concat(rows.map(r => cols.map(c => esc(fxCell(c, r))).join('\t'))).join('\n');
    }
    function fxSummary(rows, got) {
        const per = {};
        rows.forEach(r => { const k = FD_TYPE[r.e.type] || `type ${r.e.type}`; per[k] = (per[k] || 0) + 1; });
        return `${rows.length.toLocaleString()} row(s) · ${got.size} site(s)` + (Object.keys(per).length ? ' · ' + Object.entries(per).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', ') : '');
    }
    async function fxExport(kind) {
        const sids = Array.from(fdSelected);
        if (!sids.length) { setStatus('pick at least one site first'); return; }
        fdNotePick();
        if (!fxSelectedTypes().length) { setStatus('tick at least one entity type for the Sheets export'); return; }
        if (fdRun) return;
        fdRun = { done: 0, total: sids.length, msg: 'starting…', abort: false };
        renderPanel();
        try {
            const { got, failed } = await kxCollect(sids, kind === 'csv' ? 'entity CSV' : 'entity table');
            const aborted = !!fdRun.abort;
            setStatus('building entity table…'); await ftYield();
            const { cols, rows } = fxBuildTable(got);
            fxLast = { rows: rows.length, sites: got.size, failed: failed.length, aborted, at: Date.now(), summary: fxSummary(rows, got) };
            const tail = `${failed.length ? ` · ${failed.length} fetch failure(s) (console)` : ''}${aborted ? ' · ABORTED (partial)' : ''}`;
            if (failed.length) console.warn(`${TAG} sheets export: failures`, failed);
            console.log(`${TAG} sheets export: ${fxLast.summary} · ${cols.length} column(s)`);
            if (!rows.length) { setStatus(`no entities of the ticked types on the picked site(s)${tail}`); return; }
            const stamp = new Date().toISOString().slice(0, 10);
            if (kind === 'csv') {
                const csv = fdCsv(cols.map(c => ({ label: c.label, get: r => fxCell(c, r) })), rows);
                fdDownload(new Blob([csv], { type: 'text/csv' }), `AIM-fleet-entities ${stamp} (${got.size} sites, ${rows.length} rows).csv`);
                setStatus(`entity CSV downloaded — ${fxLast.summary} · ${cols.length} columns${tail}`);
            } else {
                const html = fxSheetsHtml(cols, rows), text = fxTsv(cols, rows);
                if (html.length > 40 * 1048576) { setStatus(`table too large for the clipboard (${(html.length / 1048576).toFixed(0)} MB) — use ⬇ CSV, or tick fewer types / sites`); return; }
                copyHtmlToClipboard(html, text, `entity table copied — ${fxLast.summary} · ${cols.length} columns — paste into Google Sheets / Excel${tail}`);
            }
        } catch (e) { console.error(`${TAG} sheets export failed:`, e); setStatus(`sheets export failed — ${String(e && e.message || e)}`); }
        finally { fdRun = null; renderPanel(); }
    }
    function renderSheetsExportRow() {
        const dis = fdRun ? 'disabled' : '';
        const inc = FX_TYPES.map(t => `<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" data-fx-inc="${t.key}" ${fxOpts.inc[t.key] ? 'checked' : ''} ${dis}> ${t.label}</label>`).join('');
        const opt = (k, l, title) => `<label title="${escapeHtml(title)}" style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#aaa"><input type="checkbox" data-fx-opt="${k}" ${fxOpts[k] ? 'checked' : ''} ${dis}> ${l}</label>`;
        const ready = fdSelected.size && !fdRun && fxSelectedTypes().length;
        const last = fxLast ? `<span style="color:#666;margin-left:auto" title="last export">${escapeHtml(fxLast.summary)}${fxLast.aborted ? ' · partial' : ''}${fxLast.failed ? ` · ${fxLast.failed} failed` : ''}</span>` : '';
        return '<div style="padding:6px 10px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + '<span style="color:#888">Entities:</span>'
            + `<span data-ft="fx-sheets" title="Every entity of the ticked types on every picked site, one row each — copied as a table for Google Sheets / Excel" style="cursor:pointer;color:${ready ? '#ffd54f' : '#555'};font-weight:bold">📊 Copy → Sheets</span>`
            + `<span data-ft="fx-csv" title="Same table as a CSV download" style="cursor:pointer;color:${ready ? '#5fff5f' : '#555'};font-weight:bold">⬇ CSV</span>`
            + '<span style="width:1px;height:16px;background:#2a3140"></span>'
            + inc
            + '<span style="width:1px;height:16px;background:#2a3140"></span>'
            + opt('splitDesc', 'split description', 'Split "Key: value | Key: value" descriptions into one Desc: column per key (the Exxon asset convention — puts the client asset ID in its own column)')
            + opt('geometry', 'coordinates', 'Add every vertex (and FP arcs / polygon WKT) as extra columns')
            + opt('raw', 'raw JSON', 'Add the raw custom / restrictions / params objects as JSON columns')
            + last
            + '</div>';
    }

    function fdClientOfId(id) { const raw = rawSites && rawSites[id] && rawSites[id].raw; return (raw && siteEntryClient(raw)) || clientGroupOf(siteName(id)) || 'Other'; }
    function fdClientIds(cl) { return rawSites ? Object.keys(rawSites).filter(id => fdClientOfId(id) === cl) : []; }
    function fdVisibleSiteIds() {
        const q = fdFilter.trim().toLowerCase();
        return rawSites ? Object.keys(rawSites).filter(id => !q || siteName(id).toLowerCase().includes(q) || fdClientOfId(id).toLowerCase().includes(q) || id === q) : [];
    }

    function renderPanel() {
        if (!panelEl) return;
        const body = panelEl.querySelector('#aim-ft-body');
        if (!body) return;
        const isum = issuesSummary;
        panelEl.style.width = ((mtWide && openSections.metrics) || (fdWide && openSections.data)) ? '96vw' : '640px';
        body.innerHTML = ''
            + sectionHeader('issues', '🚩', 'Fleet Issues', isum && isum.hasToken ? `${isum.open} open · ${isum.pending} pending${isum.myPending ? ` · ⚡ ${isum.myPending} for you` : ''}` : 'all sites in one panel')
            + renderIssuesSection()
            + sectionHeader('data', '📦', 'Fleet Data', `${fdSelected.size} site(s) picked · browse + export`)
            + renderDataSection()
            + sectionHeader('fc', '🎥', 'Flight Checks', fcResults ? `${fcResults.flights.length} flight(s) · ${fcResults.flights.reduce((n, f) => n + f.flagged, 0)} flagged shots` : 'planned vs actual, every flown flight of the picked sites')
            + renderFcSection()
            + sectionHeader('pilots', '🧑‍✈️', 'Pilot Utilization', puResults ? `${puResults.pilots.length} pilot(s) · ${puResults.flights.length} flight(s) · last ${puResults.days} d` : 'air time per pilot per day — overlapping drones count once')
            + renderPilotSection()
            + sectionHeader('sweep', '⚠', 'Overlap Sweep', `${ENV_LABEL} · thr ${ftCfg.thresholdFt} ft`)
            + renderSweepSection()
            + sectionHeader('map', '🗺', 'Map', 'basemap + airspace chart')
            + renderMapSection()
            + sectionHeader('kml', '📎', 'KML Layers', `${kmlLayers.length} layer(s)`)
            + renderKmlSection()
            + sectionHeader('xref', '📐', 'Cross-reference', 'KML vs sites / KML vs KML')
            + renderXrefSection()
            + sectionHeader('metrics', '📊', 'Fleet Metrics', Object.keys(mtIndex.sites).length ? `${Object.keys(mtIndex.sites).length} sites · setups + missions` : 'setups + missions from Site Watch snapshots')
            + renderMetricsSection();
    }

    function copyText(txt, doneMsg) {
        try {
            navigator.clipboard.writeText(txt)
                .then(() => setStatus(doneMsg))
                .catch(e => { console.warn(`${TAG} clipboard write failed:`, e); setStatus('clipboard write failed'); });
        } catch (e) { console.warn(`${TAG} clipboard unavailable:`, e); }
    }

    function openPanel() {
        if (!panelEl) {
            panelEl = document.createElement('div');
            panelEl.id = 'aim-ft-panel';
            panelEl.style.cssText = 'position:fixed;top:70px;right:18px;z-index:2147480001;width:640px;max-width:94vw;'
                + 'background:#14181f;color:#ddd;border:1px solid #2a3140;border-radius:6px;'
                + 'font:12px/1.5 monospace;box-shadow:0 4px 18px rgba(0,0,0,0.5);'
                + 'display:flex;flex-direction:column;max-height:82vh;';
            panelEl.innerHTML = ''
                + '<div id="aim-ft-drag" style="padding:7px 10px;color:#7adfe6;font-weight:bold;border-bottom:1px solid #2a3140;cursor:move;user-select:none;flex:none;">'
                + `⚠ AIM Fleet Tools <span style="color:#888;font-weight:normal">v${SCRIPT_VERSION} · ${ENV_LABEL}</span>`
                + '<span data-ft="close" style="float:right;cursor:pointer;color:#888">✕</span></div>'
                + '<div id="aim-ft-status" style="padding:5px 10px;border-bottom:1px solid #222834;color:#aaa;flex:none;min-height:18px;"></div>'
                + '<div id="aim-ft-body" style="flex:1;overflow-y:auto;"></div>';
            document.body.appendChild(panelEl);
            const hoverCss = document.createElement('style');
            hoverCss.textContent = '#aim-ft-body .aim-ft-row:hover{background:#222a38;}';
            panelEl.appendChild(hoverCss);

            // Delegated — the body is rebuilt on every render, the root never is
            panelEl.addEventListener('click', (ev) => {
                if (ev.target.closest('input[data-ft-class],input[data-ft-flag],input[data-ft-view],input[data-kml-show],input[data-kml-fill],input[data-kml-color],input[data-fd-site],input[data-fd-clientsel],select[data-fd-pick],input[data-fd-dataset],select[data-fd-range],input[data-fd-date],input[data-kx-inc],select[data-kx-mode],input[data-kx-pad],input[data-fx-inc],input[data-fx-opt],input[data-fc-thr],input[data-pu-opt],input[data-pu-chk],select[data-pu-tz],select[data-pu-end],select[data-pu-rule],input[data-pu-rule],select[data-pu-bulk],#aim-ft-xr-picked')) return;   // checkbox/color/select → change handler
                const clAll = ev.target.closest('[data-ft-clients]');
                if (clAll) {
                    if (clAll.getAttribute('data-ft-clients') === 'all') {
                        ftCfg.clientsOff = {};
                    } else if (lastSweep && lastSweep.pairs) {
                        lastSweep.pairs.forEach(p => {
                            ftCfg.clientsOff[clientOf(p.aName)] = true;
                            ftCfg.clientsOff[clientOf(p.bName)] = true;
                        });
                    }
                    saveCfg();
                    renderPanel();
                    drawSweepPins();
                    scheduleSetupRefresh();
                    return;
                }
                const clChip = ev.target.closest('[data-ft-client]');
                if (clChip) {
                    const cl = clChip.getAttribute('data-ft-client');
                    if (ftCfg.clientsOff[cl]) delete ftCfg.clientsOff[cl];
                    else ftCfg.clientsOff[cl] = true;
                    saveCfg();
                    renderPanel();
                    drawSweepPins();
                    scheduleSetupRefresh();
                    return;
                }
                const puTh = ev.target.closest('[data-pu-sort]');
                if (puTh) { const k = puTh.getAttribute('data-pu-sort'); const st = puSort[puTab]; if (st.key === k) st.dir = -st.dir; else { st.key = k; st.dir = ['pilot', 'day', 'site', 'drone', 'name', 'state'].includes(k) ? 1 : -1; } renderPanel(); return; }
                const puDy = ev.target.closest('[data-pu-day]');
                if (puDy && !ev.target.closest('a')) { const k = puDy.getAttribute('data-pu-day'); puOpenDay = puOpenDay === k ? null : k; renderPanel(); return; }
                const puFl = ev.target.closest('[data-pu-flight]');
                if (puFl && !ev.target.closest('a')) { const [sid, mid] = puFl.getAttribute('data-pu-flight').split('/'); window.open(`${location.origin}/#/site/${sid}/control-panel/past-mission/${mid}`, '_blank', 'noopener'); return; }
                const fcRow = ev.target.closest('[data-fc-flight]');
                if (fcRow && !ev.target.closest('a')) { const mid = Number(fcRow.getAttribute('data-fc-flight')); fcOpenFlight = fcOpenFlight === mid ? null : mid; fdRenderKeepScroll(); return; }
                const act = ev.target.closest('[data-ft]');
                if (act) {
                    const cmd = act.getAttribute('data-ft');
                    if (cmd === 'close') panelEl.style.display = 'none';
                    else if (cmd === 'issues-open') openFleetIssues();
                    else if (cmd === 'issues-refresh') { requestIssuesSummary(); renderPanel(); }
                    else if (cmd === 'kml-upload') { const fi = panelEl.querySelector('#aim-ft-kml-file'); if (fi) fi.click(); }
                    else if (cmd === 'kml-refresh') kmlRefreshRepo();
                    else if (cmd === 'xr-run') runXref();
                    else if (cmd === 'xr-abort') { xrefSeq++; if (xrefState) xrefState.running = false; setStatus('cross-ref aborted'); renderPanel(); }
                    else if (cmd === 'xr-copy') copyText(buildXrefReport(), 'cross-ref report copied');
                    else if (cmd === 'xr-card') openXrefCard();
                    else if (cmd === 'xr-clear') { xrefSeq++; xrefState = null; closeXrefCard(); renderPanel(); renderOverlay(); }
                    else if (cmd === 'run') runSweep();
                    else if (cmd === 'abort') abortSweep();
                    else if (cmd === 'copy') copyText(buildSweepReport(), 'report copied to clipboard');
                    else if (cmd === 'metrics-csv') copyText(buildMetricsCsv(), 'metrics CSV copied to clipboard');
                    else if (cmd === 'fd-export') fdExport();
                    else if (cmd === 'kx-circles') kxExportCircles();
                    else if (cmd === 'kx-setups') kxExportSetups();
                    else if (cmd === 'fx-sheets') fxExport('sheets');
                    else if (cmd === 'fx-csv') fxExport('csv');
                    else if (cmd === 'fd-abort') { if (fdRun) { fdRun.abort = true; setStatus('aborting export after the current request…'); } }
                    else if (cmd === 'fc-run') runFlightChecks();
                    else if (cmd === 'pu-run') runPilotUtil();
                    else if (cmd === 'pu-abort') { if (puRun) { puRun.abort = true; setStatus('aborting pilot utilization after the current request…'); } }
                    else if (cmd === 'pu-clear') { Object.keys(puLogCache).forEach(k => delete puLogCache[k]); setStatus('pilot utilization log cache cleared'); renderPanel(); }
                    else if (cmd === 'pu-check') { puShowCheck = !puShowCheck; renderPanel(); }
                    else if (cmd === 'pu-rules') { puShowRules = !puShowRules; renderPanel(); }
                    else if (cmd === 'pu-rules-apply') { Array.from(fdSelected).forEach(sid => { puRules[sid] = Object.assign(puRuleOf(sid), { w: puBulkW }); }); puRulesSave(); puReaggregate(); setStatus(`site rules: ${fdSelected.size} picked site(s) set to ${PU_WINDOWS[puBulkW]}`); renderPanel(); }
                    else if (cmd === 'pu-rules-clear') { Array.from(fdSelected).forEach(sid => delete puRules[sid]); puRulesSave(); puReaggregate(); setStatus('site rules reset for the picked sites'); renderPanel(); }
                    else if (cmd === 'pu-sheets') puExport('sheets');
                    else if (cmd === 'pu-csv') puExport('csv');
                    else if (cmd && cmd.startsWith('pu-tab-')) { puTab = cmd.slice(7); renderPanel(); }
                    else if (cmd === 'fc-abort') { if (fcRun) { fcRun.abort = true; setStatus('aborting flight checks after the current requests…'); } }
                    else if (cmd === 'fc-clear') { fcCache = { ver: FC_CORE_VER, flights: {} }; fcSaveCache(); fcResults = null; renderPanel(); }
                    else if (cmd === 'fc-csv') fcCopyView();
                    else if (cmd === 'fc-shots') fcCopyAllShots();
                    else if (cmd === 'fc-jira') copyText(fcJira(), 'flight-check JIRA table copied');
                    else if (cmd === 'fc-sort') { fcSortKey = fcSortKey === 'when' ? 'flagged' : 'when'; renderPanel(); }
                    else if (cmd && cmd.startsWith('fc-tab-')) { fcTab = cmd.slice(7); fcOpenFlight = null; renderPanel(); }
                    else if (cmd === 'fd-pick-save') fdSavePick();
                    else if (cmd === 'fd-pick-del') fdDeletePick(act.getAttribute('data-name'));
                    else if (cmd === 'fd-selall') { fdVisibleSiteIds().forEach(id => fdSelected.add(id)); renderPanel(); }
                    else if (cmd === 'fd-clear') { fdSelected.clear(); renderPanel(); }
                    else if (cmd === 'fd-wide') { fdWide = !fdWide; renderPanel(); }
                    else if (cmd === 'fd-browse-close') { fdBrowse = null; renderPanel(); }
                    else if (cmd === 'fd-copy') { const { cols, rows } = fdBrowseRows(); copyText(fdCsv(cols, rows), `${rows.length} row(s) copied as CSV`); }
                    else if (cmd === 'fd-reload') { if (fdBrowse) { const b = fdBrowse; if (b.tab === 'setup') delete fdCache.setup[b.sid]; else if (b.tab === 'missions') delete fdCache.missions[b.sid]; else delete fdCache.log[b.sid]; fdOpenBrowse(b.sid, b.tab); } }
                    else if (cmd === 'fd-sites') { fetchRawSites(true).then(() => renderPanel()).catch(e => { console.warn(`${TAG} /sites/ fetch failed:`, e); setStatus('site list fetch failed — see console'); }); }
                    else if (cmd === 'metrics-appr') openApprovalCard();
                    else if (cmd === 'metrics-sheets') copyHtmlToClipboard(buildMetricsSheetsHtml(), buildMetricsCsv(), 'metrics table copied — paste into Google Sheets / Excel');
                    else if (cmd === 'metrics-wide') { mtWide = !mtWide; renderPanel(); }
                    else if (cmd === 'metrics-build') {
                        if (mtBuilding) return;
                        mtBuilding = true;
                        renderPanel();
                        const t0 = Date.now();
                        Promise.all([fetchRawSites(false).catch(e => { console.warn(`${TAG} /sites/ fetch failed:`, e); return null; }),
                                     ensureMetricsIndex((done, total) => setStatus(`building fleet metrics… ${done}/${total} snapshot(s)`), true)])
                            .then(([, notes]) => { setStatus(`fleet metrics ready — ${Object.keys(mtIndex.sites).length} site(s) in ${Math.round((Date.now() - t0) / 1000)} s${notes.length ? ' · ' + notes.join(' · ') : ''}`); })
                            .catch(e => { console.warn(`${TAG} metrics build failed:`, e); setStatus(`metrics build failed — ${String(e && e.message || e)}`); })
                            .finally(() => { mtBuilding = false; renderPanel(); });
                    }
                    else if (cmd === 'metrics-refresh') {
                        fetchRawSites(true).then(() => renderPanel())
                            .catch(e => { console.warn(`${TAG} /sites/ refresh failed:`, e); setStatus('site list refresh failed — see console'); });
                    } else if (cmd === 'index') {
                        if (sweepRunning) return;
                        nbIndex.checkedAt = 0;
                        sweepRunning = true;
                        renderPanel();
                        ensureNbIndex((done, total) => setStatus(`indexing site snapshots… ${done}/${total}`), true)
                            .then(notes => { setStatus(`index updated — ${Object.keys(nbIndex.bboxes).length} site(s)${notes.length ? ' · ' + notes.join(' · ') : ''}`); })
                            .catch(e => { console.warn(`${TAG} index update failed:`, e); setStatus(`index update failed — ${String(e && e.message || e)}`); })
                            .finally(() => { sweepRunning = false; renderPanel(); });
                    }
                    return;
                }
                const fdChip = ev.target.closest('[data-fd-chip]');
                if (fdChip) { ev.preventDefault(); fdOpenBrowse(fdChip.getAttribute('data-fd-chip')); return; }
                const fdTab = ev.target.closest('[data-fd-tab]');
                if (fdTab) { if (fdBrowse) fdOpenBrowse(fdBrowse.sid, fdTab.getAttribute('data-fd-tab')); return; }
                const fdCl = ev.target.closest('[data-fd-client]');
                if (fdCl) { const c = fdCl.getAttribute('data-fd-client'); if (fdCollapsedClients.has(c)) fdCollapsedClients.delete(c); else fdCollapsedClients.add(c); fdRenderKeepScroll(); return; }
                const mtset = ev.target.closest('[data-ft-mtset]');
                if (mtset) { mtSet = mtset.getAttribute('data-ft-mtset'); if (!MT_SETS[mtSet]) mtSet = 'overview'; renderPanel(); return; }
                const mtsort = ev.target.closest('[data-ft-mtsort]');
                if (mtsort) {
                    const k = mtsort.getAttribute('data-ft-mtsort');
                    if (mtSort.key === k) mtSort.dir = -mtSort.dir; else mtSort = { key: k, dir: MT_COLS[k] && MT_COLS[k].text ? 1 : -1 };
                    renderPanel(); return;
                }
                const mtrow = ev.target.closest('[data-ft-mtrow]');
                if (mtrow && !ev.target.closest('[data-ft-link]')) {
                    const id = mtrow.getAttribute('data-ft-mtrow');
                    if (mtExpanded.has(id)) mtExpanded.delete(id); else mtExpanded.add(id);
                    renderPanel(); return;
                }
                const zoom = ev.target.closest('[data-ft-zoom]');
                if (zoom) {
                    zoomToPair(zoom.getAttribute('data-ft-zoom'));
                    return;   // don't also toggle the pair row open/closed
                }
                const sec = ev.target.closest('[data-ft-sec]');
                if (sec) {
                    const k = sec.getAttribute('data-ft-sec');
                    openSections[k] = !openSections[k];
                    renderPanel();
                    return;
                }
                const link = ev.target.closest('[data-ft-link]');
                if (link) {
                    window.open(siteSetupUrl(link.getAttribute('data-ft-link')), '_blank');
                    return;
                }
                const off = ev.target.closest('[data-ft-off]');
                if (off) {
                    const id = off.getAttribute('data-ft-off');
                    ftIgnore[id] = true;
                    saveIgnore();
                    console.log(`${TAG} site ${id} turned OFF (remembered for ${ENV_LABEL}) — its pairs are hidden; next sweep skips it entirely`);
                    renderPanel();
                    drawSweepPins();
                    scheduleSetupRefresh();
                    return;
                }
                const on = ev.target.closest('[data-ft-on]');
                if (on) {
                    const id = on.getAttribute('data-ft-on');
                    delete ftIgnore[id];
                    saveIgnore();
                    console.log(`${TAG} site ${id} turned back ON — re-run the sweep to include it`);
                    setStatus(`${siteName(id)} turned back on — re-run the sweep to include it`);
                    renderPanel();
                    drawSweepPins();
                    scheduleSetupRefresh();
                    return;
                }
                const kFly = ev.target.closest('[data-kml-fly]');
                if (kFly) {
                    const ly = kmlLayerById(kFly.getAttribute('data-kml-fly'));
                    if (ly && ly.bbox) flyToBbox(ly.bbox);
                    else if (ly && !ly.features) kmlEnsureLoaded(ly).then(() => { flyToBbox(ly.bbox); renderOverlay(); renderPanel(); }).catch(e => setStatus(`load failed — ${e.message}`));
                    return;
                }
                const kFlyF = ev.target.closest('[data-kml-flyf]');
                if (kFlyF) {
                    const [lid, fi] = kFlyF.getAttribute('data-kml-flyf').split('|');
                    const ly = kmlLayerById(lid);
                    const f = ly && ly.features && ly.features[Number(fi)];
                    if (f) flyToBbox(ptsBbox(f.pts));
                    return;
                }
                const kSave = ev.target.closest('[data-kml-save]');
                if (kSave) { const ly = kmlLayerById(kSave.getAttribute('data-kml-save')); if (ly) kmlSaveToRepo(ly); return; }
                const kDel = ev.target.closest('[data-kml-del]');
                if (kDel) { const ly = kmlLayerById(kDel.getAttribute('data-kml-del')); if (ly) kmlDelete(ly); return; }
                const xFly = ev.target.closest('[data-xr-fly]');
                if (xFly && xrefState && xrefState.result) {
                    const run = (xrefState.result.topRuns || xrefState.result.runs)[Number(xFly.getAttribute('data-xr-fly'))];
                    if (run) flyToBbox(ptsBbox(run.pts));
                    return;
                }
                const pair = ev.target.closest('[data-ft-pair]');
                if (pair) {
                    const key = pair.getAttribute('data-ft-pair');
                    expandedPair = expandedPair === key ? null : key;
                    renderPanel();
                }
            });
            // Live search — re-render but keep the search box focused
            panelEl.addEventListener('input', (ev) => {
                if (ev.target.id === 'aim-ft-xr-sites') { xrefSiteFilter = ev.target.value; return; }   // read at run time; no re-render needed
                const fdIn = ev.target.hasAttribute && (ev.target.hasAttribute('data-fd-filter') ? 'data-fd-filter' : ev.target.hasAttribute('data-fd-search') ? 'data-fd-search' : null);
                if (fdIn) {
                    if (fdIn === 'data-fd-filter') fdFilter = ev.target.value; else if (fdBrowse) fdBrowse.search = ev.target.value;
                    renderPanel();
                    const box = panelEl.querySelector(`input[${fdIn}]`);
                    if (box) { box.focus(); try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) {} }
                    return;
                }
                if (ev.target.hasAttribute && ev.target.hasAttribute('data-ft-mtfilter')) {
                    mtFilter = ev.target.value;
                    renderPanel();
                    const box = panelEl.querySelector('input[data-ft-mtfilter]');
                    if (box) { box.focus(); try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) {} }
                    return;
                }
                if (ev.target.id !== 'aim-ft-kml-search') return;
                kmlSearch = ev.target.value;
                renderPanel();
                const box = panelEl.querySelector('#aim-ft-kml-search');
                if (box) {
                    box.focus();
                    try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) {}
                }
            });
            panelEl.addEventListener('change', (ev) => {
                const t = ev.target;
                if (t.hasAttribute && t.hasAttribute('data-fd-pick')) { const v = String(t.value || ''); const i = v.indexOf(':'); if (i > 0) fdApplyPick(v.slice(0, i), Number(v.slice(i + 1))); return; }
                if (t.hasAttribute && t.hasAttribute('data-fd-site')) { const id = t.getAttribute('data-fd-site'); if (t.checked) fdSelected.add(id); else fdSelected.delete(id); fdRenderKeepScroll(); return; }
                // 6. client select-all acts on the SHOWN rows of that client (what the header count shows)
                if (t.hasAttribute && t.hasAttribute('data-fd-clientsel')) { const cl = t.getAttribute('data-fd-clientsel'); const ids = fdVisibleSiteIds().filter(id => fdClientOfId(id) === cl); ids.forEach(id => { if (t.checked) fdSelected.add(id); else fdSelected.delete(id); }); fdRenderKeepScroll(); return; }
                if (t.hasAttribute && t.hasAttribute('data-pu-opt')) { const k = t.getAttribute('data-pu-opt'); const v = Number(t.value); if (t.value.trim() === '' || !isFinite(v) || v < 0) return; if (k === 'days' && v < 1) return; if (k === 'shiftHrs' && !(v > 0)) return; if (k in puOpts) { puOpts[k] = v; puSave(); if (k === 'twilightMin' || k === 'shiftHrs') { if (puResults && k === 'shiftHrs') puResults.shiftHrs = v; puReaggregate(); renderPanel(); } } return; }
                if (t.hasAttribute && t.hasAttribute('data-pu-chk')) { const k = t.getAttribute('data-pu-chk'); if (k === 'hideEmpty') { puOpts.hideEmpty = !!t.checked; puSave(); renderPanel(); } return; }
                if (t.hasAttribute && t.hasAttribute('data-pu-bulk')) { puBulkW = t.value in PU_WINDOWS ? t.value : '247'; return; }
                if (t.hasAttribute && t.hasAttribute('data-pu-rule')) {
                    const [sid, field] = t.getAttribute('data-pu-rule').split('|'); const r = puRuleOf(sid);
                    if (field === 'w') { if (!(t.value in PU_WINDOWS)) return; r.w = t.value; }
                    else if (field === 'from' || field === 'to') { if (!/^\d{1,2}:\d{2}$/.test(t.value)) return; r[field] = t.value; }
                    else if (field === 'one') r.one = !!t.checked;
                    else if (field === 'drones') { if (t.value.trim() === '') r.drones = null; else { const v = Number(t.value); if (!isFinite(v) || v < 0) return; r.drones = Math.round(v); } }
                    puRules[sid] = r; puRulesSave(); puReaggregate(); const keep = t.getAttribute('data-pu-rule'); renderPanel();
                    const again = panelEl.querySelector(`[data-pu-rule="${keep}"]`); if (again && again.type !== 'checkbox' && again.tagName !== 'SELECT') { try { again.focus(); } catch (e) {} }
                    return;
                }
                if (t.hasAttribute && t.hasAttribute('data-pu-end')) { puOpts.endMode = t.value === 'landed' ? 'landed' : 'duration'; puSave(); return; }
                if (t.hasAttribute && t.hasAttribute('data-pu-tz')) { if (PU_TZS.some(z => z[0] === t.value)) { puOpts.tz = t.value; puSave(); } return; }
                if (t.hasAttribute && t.hasAttribute('data-fc-thr')) { const k = t.getAttribute('data-fc-thr'); const v = Number(t.value); if (isFinite(v) && v >= 0) { ftCfg.fc[k] = v; saveCfg(); } return; }
                if (t.id === 'aim-ft-xr-picked') { xrefUsePicked = !!t.checked; renderPanel(); return; }
                if (t.hasAttribute && t.hasAttribute('data-kx-inc')) { kxInclude[t.getAttribute('data-kx-inc')] = !!t.checked; return; }
                if (t.hasAttribute && t.hasAttribute('data-fx-inc')) { const k = t.getAttribute('data-fx-inc'); if (k in fxOpts.inc) { fxOpts.inc[k] = !!t.checked; fxSave(); renderPanel(); } return; }
                if (t.hasAttribute && t.hasAttribute('data-fx-opt')) { const k = t.getAttribute('data-fx-opt'); if (['splitDesc', 'geometry', 'raw'].includes(k)) { fxOpts[k] = !!t.checked; fxSave(); } return; }
                if (t.hasAttribute && t.hasAttribute('data-kx-mode')) { kxMode = t.value === '3D' ? '3D' : '2D'; return; }
                if (t.hasAttribute && t.hasAttribute('data-kx-pad')) { if (t.value.trim() === '') return; const v = Number(t.value); if (isFinite(v) && v >= 0) kxCirclePadFt = v; return; }
                if (t.hasAttribute && t.hasAttribute('data-fd-dataset')) { fdDatasets[t.getAttribute('data-fd-dataset')] = !!t.checked; renderPanel(); return; }
                if (t.hasAttribute && t.hasAttribute('data-fd-range')) { fdRange = String(t.value); if (fdBrowse && fdBrowse.tab === 'log' && fdRange !== 'custom') fdOpenBrowse(fdBrowse.sid, 'log'); else renderPanel(); return; }
                if (t.hasAttribute && t.hasAttribute('data-fd-date')) {
                    const which = t.getAttribute('data-fd-date');
                    if (which === 'start') fdStart = String(t.value); else fdEnd = String(t.value);
                    // Chrome fires change per typed digit — keep the field focused across the re-render.
                    renderPanel();
                    const again = panelEl.querySelector(`input[data-fd-date="${which}"]`);
                    if (again) { try { again.focus(); } catch (e) {} }
                    return;
                }
                if (ev.target.id === 'aim-ft-kml-file') {
                    const files = [...(ev.target.files || [])];
                    ev.target.value = '';
                    if (files.length) kmlHandleFiles(files);
                    return;
                }
                const kmlAttr = ['data-kml-show', 'data-kml-fill', 'data-kml-color', 'data-kml-width', 'data-kml-op']
                    .find(a => ev.target.hasAttribute && ev.target.hasAttribute(a));
                if (kmlAttr) {
                    const ly = kmlLayerById(ev.target.getAttribute(kmlAttr));
                    if (!ly) return;
                    const st = kmlStyleFor(ly.id);
                    if (kmlAttr === 'data-kml-show') {
                        st.show = !!ev.target.checked;
                        if (st.show && !ly.features) {
                            setStatus(`loading "${ly.name}"…`);
                            kmlEnsureLoaded(ly)
                                .then(() => { setStatus(`"${ly.name}" loaded`); renderOverlay(); renderPanel(); })
                                .catch(e => setStatus(`load failed — ${String(e && e.message || e)}`));
                        }
                    } else if (kmlAttr === 'data-kml-fill') st.fill = !!ev.target.checked;
                    else if (kmlAttr === 'data-kml-color') st.color = String(ev.target.value);
                    else {
                        const v = Number(ev.target.value);
                        if (isNaN(v)) return;
                        if (kmlAttr === 'data-kml-width') st.width = v;
                        else st.opacity = v;
                    }
                    saveKmlStyles();
                    renderOverlay();
                    return;
                }
                const xrSel = ev.target.closest('select[data-xr]');
                if (xrSel) {
                    if (xrSel.getAttribute('data-xr') === 'src') xrefSrcSel = String(xrSel.value);
                    else xrefTgtSel = String(xrSel.value);
                    renderPanel();
                    return;
                }
                const lblSel = ev.target.closest('select[data-ft-labels]');
                if (lblSel) {
                    const v = String(lblSel.value);
                    if (LABEL_CSS[v] !== undefined && v !== ftCfg.siteLabels) {
                        ftCfg.siteLabels = v;
                        saveCfg();
                        applySiteLabels();
                        setStatus(`site labels → ${v === 'dark' ? 'dark & slim' : v}`);
                    }
                    return;
                }
                const bmSel = ev.target.closest('select[data-ft-basemap]');
                if (bmSel) {
                    const v = String(bmSel.value);
                    if (BASEMAPS[v] && v !== ftCfg.basemap) {
                        ftCfg.basemap = v;
                        saveCfg();
                        setStatus(applyBasemap()
                            ? `basemap → ${BASEMAPS[v].label}`
                            : 'basemap switch failed — could not find the map\'s tile layer (see console)');
                    }
                    return;
                }
                const num = ev.target.closest('input[data-ft-num]');
                if (num) {
                    const prop = num.getAttribute('data-ft-num');
                    const v = Number(num.value);
                    if (!isNaN(v) && v !== ftCfg[prop]) {
                        ftCfg[prop] = v;
                        saveCfg();
                        if (prop === 'faaOpacity') {
                            updateFaaTiles();
                            setStatus(`FAA chart opacity = ${v}`);
                        } else {
                            const labels = { thresholdFt: 'threshold', marginFt: 'prefilter margin', xrefB1: 'cross-ref band 1', xrefB2: 'cross-ref band 2', xrefBaseB1: 'Tattu range', xrefBaseB2: 'Tulip range' };
                            setStatus(`${labels[prop] || prop} = ${v} ft — takes effect on the next ${prop.startsWith('xref') ? 'cross-ref run' : 'sweep'}`);
                        }
                    }
                    return;
                }
                const flag = ev.target.closest('input[data-ft-flag]');
                if (flag) {
                    const prop = flag.getAttribute('data-ft-flag');
                    ftCfg[prop] = !!flag.checked;
                    saveCfg();
                    if (prop === 'showOnMap') {
                        setStatus(`map pins ${flag.checked ? 'ON' : 'OFF'}`);
                        drawSweepPins();
                    } else if (prop === 'drawSetups') {
                        setStatus(flag.checked ? `site setups ON — zoom the map in to level ${SETUP_MIN_ZOOM}+ to see them` : 'site setups OFF');
                        refreshSetupLayers();
                    } else if (prop === 'faaChart') {
                        setStatus(flag.checked ? `FAA sectional ON — chart tiles exist at zoom ${FAA_SRC.min}–${FAA_SRC.max}` : 'FAA sectional OFF');
                        updateFaaTiles();
                    } else {
                        setStatus(`${prop === 'onlyProduction' ? '"Production only"' : prop} ${flag.checked ? 'ON' : 'OFF'} — takes effect on the next sweep`);
                        if (prop === 'onlyProduction') renderPanel();
                    }
                    return;
                }
                const vf = ev.target.closest('input[data-ft-view]');
                if (vf) {
                    const key = vf.getAttribute('data-ft-view');
                    if (key in ftCfg.view) {
                        ftCfg.view[key] = !!vf.checked;
                        saveCfg();
                        renderPanel();
                        // Classes filter at RENDER time (geometry cache
                        // keeps all classes) — drawSweepPins re-renders the
                        // whole overlay, pins and setups alike
                        drawSweepPins();
                    }
                    return;
                }
                const cb = ev.target.closest('input[data-ft-class]');
                if (cb) {
                    const key = cb.getAttribute('data-ft-class');
                    if (key in ftCfg.classes) {
                        ftCfg.classes[key] = !!cb.checked;
                        saveCfg();
                        setStatus('classes changed — takes effect on the next sweep');
                    }
                }
            });
            const dragBar = panelEl.querySelector('#aim-ft-drag');
            dragBar.addEventListener('pointerdown', (ev) => {
                if (ev.target.getAttribute && ev.target.getAttribute('data-ft') === 'close') return;
                ev.preventDefault();
                const r = panelEl.getBoundingClientRect();
                const offX = ev.clientX - r.left, offY = ev.clientY - r.top;
                const onMove = (mv) => {
                    panelEl.style.left = `${Math.max(0, mv.clientX - offX)}px`;
                    panelEl.style.right = 'auto';
                    panelEl.style.top = `${Math.max(0, mv.clientY - offY)}px`;
                };
                const onUp = () => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                };
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }
        panelEl.style.display = 'flex';
        requestIssuesSummary();   // v0.25: 🚩 Fleet Issues counts (AIM Issues answers over a DOM event)
        kmlBoot();   // idempotent — lists persistent KML layers once the token exists
        // Names for stored results/ignore chips on a fresh page load
        if (!rawSites) {
            fetchRawSites(false).then(() => renderPanel())
                .catch(e => console.warn(`${TAG} /sites/ fetch failed (names show as ids):`, e));
        }
        renderPanel();
        setStatus(lastSweep && lastSweep.at
            ? `showing last sweep from ${new Date(lastSweep.at).toLocaleString()}`
            : 'ready — ▶ Run overlap sweep to check the whole fleet');
    }

    // ------------------------------------------------------------------
    // Init — the landing page is an SPA destination; poll for its marker
    // ------------------------------------------------------------------
    setupControlChannel();
    setupIssuesBridge();   // v0.25: listen for AIM Issues' fleet summary
    if (!patchLeafletProto()) {
        let patchTries = 0;
        const patchTimer = setInterval(() => {
            if (patchLeafletProto() || ++patchTries >= 60) clearInterval(patchTimer);
        }, 500);
    }
    const start = () => {
        syncButton();
        applySiteLabels();   // .pr-site-marker only exists on the landing page — global CSS is harmless elsewhere
        setInterval(syncButton, 2000);
        window.addEventListener('hashchange', () => setTimeout(syncButton, 300));
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
    // Persistent KML layers with show=true should appear without opening
    // the panel — boot once the token has had a moment to arrive
    setTimeout(() => { try { kmlBoot(); } catch (e) {} }, 2500);
    console.log(`${TAG} v${SCRIPT_VERSION} ready (${ENV_LABEL}${onLandingPage() ? ', landing page' : ''})`);
})();
