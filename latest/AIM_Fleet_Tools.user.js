// ==UserScript==
// @name         Latest - AIM Fleet Tools
// @namespace    http://tampermonkey.net/
// @version      0.15
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
    const SCRIPT_VERSION = '0.15';
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
            ovSetupsG = document.createElementNS(SVG_NS, 'g');   // geometry under…
            ovPinsG = document.createElementNS(SVG_NS, 'g');     // …conflict pins
            ovSvg.appendChild(ovSetupsG);
            ovSvg.appendChild(ovPinsG);
            pane.appendChild(ovSvg);
            if (ovMap !== map) {
                map.on('zoomend viewreset', onMapZoomChanged);
                map.on('moveend', onMapMoved);
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
    const BASEMAPS = {
        default: { label: 'Percepto default' },
        esri: { label: 'Esri World Imagery', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxNative: 19 },
        usgs: { label: 'USGS NAIP imagery', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', maxNative: 16 },
        dark: { label: 'Dark map (Esri Gray)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxNative: 16 },
        light: { label: 'Light map (Esri Gray)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', maxNative: 16 },
        osm: { label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNative: 19 },
    };
    // Raw tile engines — a pane of absolutely-positioned <img> tiles we
    // fully own (the FAA-chart pattern, generalized). v0.13 tried setUrl on
    // Percepto's own tile layer, but it didn't take on the live map
    // (react-leaflet re-asserts its layer's URL) — so a non-default
    // basemap now draws as a COVER pane just above Percepto's tilePane;
    // "Percepto default" simply clears it. Guaranteed to work: same engine
    // as the proven FAA chart.
    function rawTileEngine(paneName, zIndex) {
        return { paneName, zIndex, tiles: {}, el: null, srcUrl: null, capWarned: false };
    }
    const baseEng = rawTileEngine('aim-ft-base', 205);   // just above tilePane (200)
    const faaEng = rawTileEngine('aim-ft-faa', 210);     // chart above the basemap cover
    const RAW_TILE_CAP = 180;

    function engClear(eng) {
        Object.keys(eng.tiles).forEach(k => { try { eng.tiles[k].remove(); } catch (e) {} });
        eng.tiles = {};
    }
    function engReset(eng) { eng.tiles = {}; eng.el = null; eng.srcUrl = null; }

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
            const b = map.getBounds().pad(0.05);
            const x0 = lng2tile(b.getWest(), z), x1 = lng2tile(b.getEast(), z);
            const y0 = lat2tile(b.getNorth(), z), y1 = lat2tile(b.getSouth(), z);
            const count = (x1 - x0 + 1) * (y1 - y0 + 1);
            if (count > RAW_TILE_CAP) {
                if (!eng.capWarned) { eng.capWarned = true; console.warn(`${TAG} ${eng.paneName}: ${count} tiles in view exceeds cap ${RAW_TILE_CAP}`); }
                engClear(eng);
                return;
            }
            const need = new Set();
            const nMax = Math.pow(2, z) - 1;
            for (let x = x0; x <= x1; x++) {
                for (let y = Math.max(0, y0); y <= Math.min(nMax, y1); y++) {
                    const key = `${z}/${x}/${y}`;
                    need.add(key);
                    let img = eng.tiles[key];
                    if (!img) {
                        img = document.createElement('img');
                        img.src = src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
                        img.style.cssText = 'position:absolute;pointer-events:none;user-select:none;';
                        img.draggable = false;
                        img.addEventListener('error', () => { img.style.display = 'none'; });   // no-coverage tiles 404 — fine
                        eng.el.appendChild(img);
                        eng.tiles[key] = img;
                    }
                    // Corner projection handles the z-clamp upscale (map
                    // zoom beyond the source's native max) automatically
                    const p1 = map.latLngToLayerPoint([tile2lat(y, z), tile2lng(x, z)]);
                    const p2 = map.latLngToLayerPoint([tile2lat(y + 1, z), tile2lng(x + 1, z)]);
                    img.style.left = `${p1.x}px`;
                    img.style.top = `${p1.y}px`;
                    img.style.width = `${p2.x - p1.x + 0.5}px`;
                    img.style.height = `${p2.y - p1.y + 0.5}px`;
                    img.style.opacity = opacity;
                }
            }
            Object.keys(eng.tiles).forEach(k => {
                if (!need.has(k)) { try { eng.tiles[k].remove(); } catch (e) {} delete eng.tiles[k]; }
            });
        } catch (e) { console.warn(`${TAG} raw tiles (${eng.paneName}) update failed:`, e); }
    }

    function applyBasemap() {
        const bm = BASEMAPS[ftCfg.basemap];
        engUpdate(baseEng, bm && bm.url ? { url: bm.url, max: bm.maxNative } : null, 1);
        return true;
    }
    function updateFaaTiles() { engUpdate(faaEng, ftCfg.faaChart ? FAA_SRC : null, ftCfg.faaOpacity); }

    // ---- FAA VFR sectional as a raw tile pane ----
    const FAA_SRC = { url: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}', min: 8, max: 12 };

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
    // UI — floating button on the landing page + sectioned panel
    // ==================================================================
    let buttonEl = null;
    let panelEl = null;
    let openSections = { sweep: true, map: true, metrics: false };
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
            ovSvg = null; ovSetupsG = null; ovPinsG = null; ovMap = null;
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
                if (ev.target.closest('input[data-ft-class],input[data-ft-flag],input[data-ft-view]')) return;   // checkbox → change handler
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
                const pair = ev.target.closest('[data-ft-pair]');
                if (pair) {
                    const key = pair.getAttribute('data-ft-pair');
                    expandedPair = expandedPair === key ? null : key;
                    renderPanel();
                }
            });
            panelEl.addEventListener('change', (ev) => {
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
                            setStatus(`${prop === 'thresholdFt' ? 'threshold' : 'prefilter margin'} = ${v} ft — takes effect on the next sweep`);
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
        setInterval(syncButton, 2000);
        window.addEventListener('hashchange', () => setTimeout(syncButton, 300));
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
    console.log(`${TAG} v${SCRIPT_VERSION} ready (${ENV_LABEL}${onLandingPage() ? ', landing page' : ''})`);
})();
