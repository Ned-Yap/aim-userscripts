// ==UserScript==
// @name         Latest - AIM Fleet Tools
// @namespace    http://tampermonkey.net/
// @version      0.24
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Fleet_Tools.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Fleet_Tools.user.js
// @description  Fleet-wide tools on the sites-select landing page (before entering any site). v0.1 (#250 layer 1): ⚠ Overlap Sweep — checks EVERY pair of sites for geographic overlap (Site Watch snapshot bboxes prefilter candidate pairs, live /map_objects/ supplies current geometry, segment-to-segment math, threshold default 200 ft) with a per-pair conflict report + site links; per-site on/off for duplicate/OFFLINE copies. 📊 Fleet Metrics — per-site FFZ/FP/asset counts from the snapshot index. v0.2: /sites/ status surfaced everywhere (probe-confirmed payload: id/name/location/status) + optional "Production only" sweep filter. v0.3: sweep results draw ON the landing map — a pin at each conflicting pair's closest approach (red = overlap, orange = near), 🎯 per pair row flies the map there, "Show on map" toggle. Panel is built as sections so future fleet tools slot in.
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
    const SCRIPT_VERSION = '0.24';
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
        if (tree.truncated) notes.push('data-repo tree listing was truncated by GitHub — some sites may be missing from the index');
        Object.keys(nbIndex.shas).forEach(id => {
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
    // 📊 Fleet Metrics (bones) — per-site counts straight from the index
    // ==================================================================
    function buildMetricsRows() {
        const rows = [];
        Object.keys(nbIndex.bboxes).forEach(id => {
            // Snapshot-only orphans (sites outside the user's current
            // /sites/ list) are access we no longer have — never shown
            if (rawSites && !rawSites[id]) return;
            const b = nbIndex.bboxes[id];
            const raw = rawSites && rawSites[id] && rawSites[id].raw;
            rows.push({
                id, name: siteName(id),
                client: (raw && siteEntryClient(raw)) || '',
                status: siteStatus(id),
                ffz: b && !b.empty ? b.ffz : 0,
                fp: b && !b.empty ? b.fp : 0,
                asset: b && !b.empty ? b.asset : 0,
                empty: !!(b && b.empty),
            });
        });
        rows.sort((a, b) => (a.client || '￿').localeCompare(b.client || '￿') || a.name.localeCompare(b.name));
        return rows;
    }

    function buildMetricsCsv() {
        const rows = buildMetricsRows();
        const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
        const lines = ['site_id,site_name,client,status,ffz,fp,assets'];
        rows.forEach(r => lines.push([r.id, esc(r.name), esc(r.client), esc(r.status), r.ffz, r.fp, r.asset].join(',')));
        return lines.join('\n');
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

    function xrefEnvAddSeg(env, A, B) {
        env.segs.push({
            ax: A.x, ay: A.y, bx: B.x, by: B.y,
            minX: Math.min(A.x, B.x), maxX: Math.max(A.x, B.x),
            minY: Math.min(A.y, B.y), maxY: Math.max(A.y, B.y),
        });
    }
    function xrefEnvAddRing(env, ptsXY) {
        const xs = [], ys = [];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        ptsXY.forEach(q => {
            xs.push(q.x); ys.push(q.y);
            if (q.x < minX) minX = q.x;
            if (q.x > maxX) maxX = q.x;
            if (q.y < minY) minY = q.y;
            if (q.y > maxY) maxY = q.y;
        });
        if (xs.length > 2) env.polys.push({ xs, ys, minX, maxX, minY, maxY });
    }

    async function runXref() {
        if (xrefState && xrefState.running) return;
        const seq = ++xrefSeq;
        if (!kmlLayerById(xrefSrcSel) && kmlLayers.length) xrefSrcSel = kmlLayers[0].id;   // lone-option selects never fire 'change'
        const src = kmlLayerById(xrefSrcSel);
        if (!src) { setStatus('pick a source KML layer first'); return; }
        const b1m = ftCfg.xrefB1 / FT_PER_M;
        const b2m = ftCfg.xrefB2 / FT_PER_M;
        if (!(b2m > b1m)) { setStatus('band 2 must be larger than band 1'); return; }
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
            if (String(xrefTgtSel).startsWith('sites')) {
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
                    if (ftCfg.onlyProduction && siteStatus(id) && siteStatus(id) !== 'Production') return false;
                    const b = nbIndex.bboxes[id];
                    return b && !b.empty && bboxGapFt(b, src.bbox) <= ftCfg.xrefB2 + marginFt;
                });
                if (!cands.length) notes.push('NO sites within range of this layer');
                for (let i = 0; i < cands.length; i++) {
                    if (seq !== xrefSeq) return;
                    setStatus(`cross-ref: fetching site ${cands[i]} (${i + 1}/${cands.length})…`);
                    let ents;
                    try { ents = await fetchSiteEntities(cands[i], false); }
                    catch (e) { notes.push(`site ${siteName(cands[i])} (#${cands[i]}) fetch failed — not counted as coverage`); continue; }
                    sitesUsed++;
                    ents.forEach(e => {
                        if (useFp && e.type === 15 && Array.isArray(e.arcs)) {
                            e.arcs.forEach(a => {
                                if (a && a.point_a && a.point_b && typeof a.point_a.lat === 'number' && typeof a.point_b.lat === 'number') {
                                    xrefEnvAddSeg(env, proj.toXY(a.point_a), proj.toXY(a.point_b));
                                }
                            });
                        } else if (useFfz && e.type === 16) {
                            const cs = (entityCoords(e) || []).filter(p => p && typeof p.lat === 'number');
                            if (cs.length > 2) xrefEnvAddRing(env, cs.map(p => proj.toXY(p)));
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
                    if (f.type === 'poly') {
                        xrefEnvAddRing(env, xy);
                    } else if (f.type === 'line') {
                        for (let i = 1; i < xy.length; i++) xrefEnvAddSeg(env, xy[i - 1], xy[i]);
                    } else {
                        xrefEnvAddSeg(env, xy[0], xy[0]);   // point = degenerate segment
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
            const b1ft = ftCfg.xrefB1, b2ft = ftCfg.xrefB2;
            const classify = (d) => {
                const ft = Math.round(d * FT_PER_M);
                return ft < b1ft ? 1 : (ft < b2ft ? 2 : 0);
            };
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
                    const band = classify(xrefDistGrid(q.x, q.y, grid, cellM, pad));
                    pointHits[band]++;
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
                        const d = xrefDistGrid(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, grid, cellM, pad);
                        const band = classify(d);
                        const lat = Pa[0] + (Pb[0] - Pa[0]) * t, lng = Pa[1] + (Pb[1] - Pa[1]) * t;
                        if (k > 0) { bandLenM[band] += segLen / n; doneLenM += segLen / n; }
                        if (!run || run.band !== band) {
                            // extend the outgoing run to the transition point
                            // so adjacent bands SHARE their boundary — without
                            // this every color change left a one-step gap
                            if (run) run.pts.push([lat, lng]);
                            finishRun(run);
                            run = { band, featName: f.name, pts: [[lat, lng]], lenM: 0 };
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
            const result = {
                at: Date.now(),
                srcName: src.name, tgtLabel, sitesUsed,
                b1: ftCfg.xrefB1, b2: ftCfg.xrefB2,
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
            setStatus(`cross-ref done — ≤${result.b1} ft: ${fmtMi(bandLenM[1])} · ≤${result.b2} ft: ${fmtMi(bandLenM[1] + bandLenM[2])} of ${fmtMi(totalLenM)}`);
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

    function buildXrefReport() {
        const r = xrefState && xrefState.result;
        if (!r) return 'AIM Fleet Tools — no cross-reference run yet';
        const L = r.bandLenM;
        const lines = [];
        lines.push(`AIM Fleet Tools — KML cross-reference [${ENV_LABEL}]`);
        lines.push(`Source: "${r.srcName}" · Target: ${r.tgtLabel}${r.sitesUsed ? ` (${r.sitesUsed} site(s) in range)` : ''}`);
        lines.push(`Ran ${new Date(r.at).toLocaleString()} · bands ≤${r.b1} ft / ≤${r.b2} ft · sampled every ~${r.stepFt} ft`);
        lines.push('');
        lines.push(`Line length total: ${fmtMi(r.totalM)}`);
        lines.push(`  ≤${r.b1} ft of target:      ${fmtMi(L[1])} (${pct(L[1], r.totalM)})`);
        lines.push(`  ${r.b1}–${r.b2} ft:            ${fmtMi(L[2])} (${pct(L[2], r.totalM)})`);
        lines.push(`  ≤${r.b2} ft CUMULATIVE:    ${fmtMi(L[1] + L[2])} (${pct(L[1] + L[2], r.totalM)})   ← inspectable from existing coverage`);
        lines.push(`  beyond ${r.b2} ft:          ${fmtMi(L[0])} (${pct(L[0], r.totalM)})   ← needs new site area`);
        if (r.pointsTotal) {
            lines.push('');
            lines.push(`Points: ${r.pointsTotal} total — ≤${r.b1} ft: ${r.pointHits[1]} · ${r.b1}–${r.b2} ft: ${r.pointHits[2]} · beyond: ${r.pointHits[0]}`);
        }
        lines.push('');
        lines.push(`Longest stretches (${Math.min(40, r.runsTotal)} of ${r.runsTotal}):`);
        (r.topRuns || r.runs).slice(0, 40).forEach((run, i) => {
            const tag = run.band === 1 ? `≤${r.b1}ft` : (run.band === 2 ? `≤${r.b2}ft` : `>${r.b2}ft`);
            const mid = run.pts[Math.floor(run.pts.length / 2)];
            lines.push(`  ${i + 1}. [${tag}] ${fmtMi(run.lenM)}${run.featName ? ` — ${run.featName}` : ''} @ ${mid[0].toFixed(6)}, ${mid[1].toFixed(6)}`);
        });
        r.notes.forEach(n => lines.push(`Note: ${n}`));
        return lines.join('\n');
    }

    // ==================================================================
    // UI — floating button on the landing page + sectioned panel
    // ==================================================================
    let buttonEl = null;
    let panelEl = null;
    let openSections = { sweep: true, map: true, kml: true, xref: true, metrics: false };
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
        if (!String(xrefTgtSel).startsWith('sites') && !kmlLayerById(xrefTgtSel)) xrefTgtSel = 'sites';
        const sel = 'background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:2px 4px;font:inherit;max-width:180px;';
        const num = 'width:52px;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;font:inherit;padding:1px 3px;';
        const srcOpts = kmlLayers.map(ly => `<option value="${ly.id}" ${xrefSrcSel === ly.id ? 'selected' : ''}>${escapeHtml(ly.name)}</option>`).join('');
        const tgtOpts = `<option value="sites" ${xrefTgtSel === 'sites' ? 'selected' : ''}>Site FFZs + FPs (existing coverage)</option>`
            + `<option value="sites-ffz" ${xrefTgtSel === 'sites-ffz' ? 'selected' : ''}>Site FFZs ONLY (mission-step airspace)</option>`
            + `<option value="sites-fp" ${xrefTgtSel === 'sites-fp' ? 'selected' : ''}>Site FPs ONLY</option>`
            + kmlLayers.filter(ly => ly.id !== xrefSrcSel).map(ly => `<option value="${ly.id}" ${xrefTgtSel === ly.id ? 'selected' : ''}>KML: ${escapeHtml(ly.name)}</option>`).join('');
        const running = xrefState && xrefState.running;
        const rows = [];
        rows.push('<div style="padding:6px 10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #222834;">'
            + `<label>Source <select data-xr="src" style="${sel}">${srcOpts || '<option value="">(load a KML first)</option>'}</select></label>`
            + `<label>vs <select data-xr="tgt" style="${sel}">${tgtOpts}</select></label>`
            + `<label title="inner band">≤<input type="number" data-ft-num="xrefB1" value="${ftCfg.xrefB1}" min="5" max="1000" step="5" style="${num}"> ft</label>`
            + `<label title="outer band">≤<input type="number" data-ft-num="xrefB2" value="${ftCfg.xrefB2}" min="10" max="5000" step="10" style="${num}"> ft</label>`
            + (running
                ? '<span data-ft="xr-abort" style="cursor:pointer;color:#ff5252;font-weight:bold">■ Abort</span>'
                : '<span data-ft="xr-run" style="cursor:pointer;color:#5fff5f;font-weight:bold">▶ Run cross-ref</span>')
            + '<span data-ft="xr-copy" style="cursor:pointer;color:#7adfe6">📋 Copy report</span>'
            + '<span data-ft="xr-clear" style="cursor:pointer;color:#888">Clear</span>'
            + '</div>');
        if (xrefState && xrefState.error) rows.push(`<div style="padding:4px 10px;color:#ff5252">${escapeHtml(xrefState.error)}</div>`);
        if (running) rows.push('<div style="padding:6px 10px;color:#8899bb">Running… (progress in the status line up top)</div>');
        const r = xrefState && xrefState.result;
        if (r) {
            const L = r.bandLenM;
            rows.push(`<div style="padding:4px 10px;border-bottom:1px solid #222834;">`
                + `"${escapeHtml(r.srcName)}" vs ${escapeHtml(r.tgtLabel)}${r.sitesUsed ? ` <span style="color:#888">(${r.sitesUsed} sites in range)</span>` : ''} — total ${fmtMi(r.totalM)}<br>`
                + `<span style="color:${XREF_COLORS[1]}">■ ≤${r.b1} ft: ${fmtMi(L[1])} (${pct(L[1], r.totalM)})</span> · `
                + `<span style="color:${XREF_COLORS[2]}">■ ${r.b1}–${r.b2} ft: ${fmtMi(L[2])} (${pct(L[2], r.totalM)})</span> · `
                + `<span style="color:${XREF_COLORS[0]}">■ beyond: ${fmtMi(L[0])} (${pct(L[0], r.totalM)})</span><br>`
                + `<b style="color:#5fff5f">≤${r.b2} ft cumulative: ${fmtMi(L[1] + L[2])} (${pct(L[1] + L[2], r.totalM)})</b> <span style="color:#888">— inspectable from existing coverage</span>`
                + (r.pointsTotal ? `<br><span style="color:#aaa">points: ≤${r.b1}ft ${r.pointHits[1]} · ${r.b1}–${r.b2}ft ${r.pointHits[2]} · beyond ${r.pointHits[0]} of ${r.pointsTotal}</span>` : '')
                + '</div>');
            rows.push('<div style="max-height:28vh;overflow-y:auto;">'
                + (r.topRuns || r.runs).slice(0, 30).map((run, i) =>
                    `<div class="aim-ft-row" data-xr-fly="${i}" style="padding:2px 10px;cursor:pointer;border-bottom:1px solid #1d2430;">`
                    + `<span style="color:${XREF_COLORS[run.band]};font-weight:bold">${run.band === 1 ? `≤${r.b1}ft` : (run.band === 2 ? `≤${r.b2}ft` : `>${r.b2}ft`)}</span> `
                    + `${fmtMi(run.lenM)}${run.featName ? ` <span style="color:#888">— ${escapeHtml(run.featName)}</span>` : ''} 🎯</div>`).join('')
                + (r.runsTotal > 30 ? `<div style="color:#888;padding:2px 10px">…${r.runsTotal - 30} more stretches in 📋 Copy report</div>` : '')
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
        }
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

    function renderMetricsSection() {
        if (!openSections.metrics) return '';
        const rows = buildMetricsRows();
        if (!rows.length) {
            return '<div style="padding:8px 10px;color:#888">Index is empty — run ⟳ Update index (or a sweep) first.</div>';
        }
        const out = [];
        const orphans = rawSites ? Object.keys(nbIndex.bboxes).filter(id => !rawSites[id]).length : 0;
        out.push('<div style="padding:6px 10px;display:flex;gap:14px;border-bottom:1px solid #222834;">'
            + '<span data-ft="metrics-refresh" style="cursor:pointer;color:#7adfe6">⟳ Refresh names/clients</span>'
            + '<span data-ft="metrics-csv" style="cursor:pointer;color:#7adfe6">📋 Copy CSV</span>'
            + `<span style="color:#888">${rows.length} indexed site(s)${orphans ? ` · ${orphans} snapshot-only (no access) hidden` : ''}</span></div>`);
        const hasClient = rows.some(r => r.client);
        const hasStatus = rows.some(r => r.status);
        out.push('<div style="max-height:40vh;overflow-y:auto;">'
            + '<table style="border-collapse:collapse;width:100%;font:inherit;">'
            + `<thead><tr style="color:#7adfe6;text-align:left;"><th style="padding:2px 8px;">Site</th>${hasClient ? '<th style="padding:2px 8px;">Client</th>' : ''}${hasStatus ? '<th style="padding:2px 8px;">Status</th>' : ''}<th style="padding:2px 8px;">FFZ</th><th style="padding:2px 8px;">FP</th><th style="padding:2px 8px;">Assets</th></tr></thead><tbody>`
            + rows.map(r => `<tr style="border-bottom:1px solid #1d2430;${r.empty ? 'color:#666;' : ''}">`
                + `<td style="padding:2px 8px;">${escapeHtml(r.name)} <span style="color:#666">#${r.id}</span></td>`
                + (hasClient ? `<td style="padding:2px 8px;color:#aaa">${escapeHtml(r.client)}</td>` : '')
                + (hasStatus ? `<td style="padding:2px 8px;color:${statusTag(r.status) ? '#ffa030' : '#888'}">${escapeHtml(r.status || '—')}</td>` : '')
                + `<td style="padding:2px 8px;">${r.ffz}</td><td style="padding:2px 8px;">${r.fp}</td><td style="padding:2px 8px;">${r.asset}</td></tr>`).join('')
            + '</tbody></table></div>');
        return out.join('');
    }

    function renderPanel() {
        if (!panelEl) return;
        const body = panelEl.querySelector('#aim-ft-body');
        if (!body) return;
        body.innerHTML = ''
            + sectionHeader('sweep', '⚠', 'Overlap Sweep', `${ENV_LABEL} · thr ${ftCfg.thresholdFt} ft`)
            + renderSweepSection()
            + sectionHeader('map', '🗺', 'Map', 'basemap + airspace chart')
            + renderMapSection()
            + sectionHeader('kml', '📎', 'KML Layers', `${kmlLayers.length} layer(s)`)
            + renderKmlSection()
            + sectionHeader('xref', '📐', 'Cross-reference', 'KML vs sites / KML vs KML')
            + renderXrefSection()
            + sectionHeader('metrics', '📊', 'Fleet Metrics', 'per-site entity counts (bones)')
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
                if (ev.target.closest('input[data-ft-class],input[data-ft-flag],input[data-ft-view],input[data-kml-show],input[data-kml-fill],input[data-kml-color]')) return;   // checkbox/color → change handler
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
                const act = ev.target.closest('[data-ft]');
                if (act) {
                    const cmd = act.getAttribute('data-ft');
                    if (cmd === 'close') panelEl.style.display = 'none';
                    else if (cmd === 'kml-upload') { const fi = panelEl.querySelector('#aim-ft-kml-file'); if (fi) fi.click(); }
                    else if (cmd === 'kml-refresh') kmlRefreshRepo();
                    else if (cmd === 'xr-run') runXref();
                    else if (cmd === 'xr-abort') { xrefSeq++; if (xrefState) xrefState.running = false; setStatus('cross-ref aborted'); renderPanel(); }
                    else if (cmd === 'xr-copy') copyText(buildXrefReport(), 'cross-ref report copied');
                    else if (cmd === 'xr-clear') { xrefSeq++; xrefState = null; renderPanel(); renderOverlay(); }
                    else if (cmd === 'run') runSweep();
                    else if (cmd === 'abort') abortSweep();
                    else if (cmd === 'copy') copyText(buildSweepReport(), 'report copied to clipboard');
                    else if (cmd === 'metrics-csv') copyText(buildMetricsCsv(), 'metrics CSV copied to clipboard');
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
                            const labels = { thresholdFt: 'threshold', marginFt: 'prefilter margin', xrefB1: 'cross-ref band 1', xrefB2: 'cross-ref band 2' };
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
