// ==UserScript==
// @name         Latest - AIM Fleet Tools
// @namespace    http://tampermonkey.net/
// @version      0.4
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
    const SCRIPT_VERSION = '0.4';
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
            capPerPair: 200, onlyProduction: false, showOnMap: true,
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
    function pairInView(p) {
        if (ftIgnore[p.aId] || ftIgnore[p.bId]) return false;
        // Hidden only when BOTH sides' clients are off — a single enabled
        // client still shows its cross-client conflicts (the dangerous kind)
        if (ftCfg.clientsOff[clientOf(p.aName)] && ftCfg.clientsOff[clientOf(p.bName)]) return false;
        return visibleConflicts(p).length > 0;
    }
    function visiblePairs() {
        if (!lastSweep || !lastSweep.pairs) return [];
        return lastSweep.pairs.filter(pairInView);
    }

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
    function getL() {
        // With @grant, the sandbox's own L draws invisibly — always prefer
        // the page's real L on unsafeWindow (engraved lesson, AIM Issues).
        try {
            const realWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            if (realWin && realWin.L) return realWin.L;
            if (window.L) return window.L;
        } catch (e) {}
        return null;
    }

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
    function getLandingMap() {
        if (landingMapRef && landingMapRef._container && document.body.contains(landingMapRef._container)) {
            return landingMapRef;
        }
        landingMapRef = null;
        // The landing map exists before we run, so the prototype-hook trick
        // wouldn't have stamped it — walk container properties instead.
        const containers = [document.getElementById('pr-sites-select-map'), ...document.querySelectorAll('.leaflet-container')];
        for (const container of containers) {
            if (!container) continue;
            const candidates = [container.__aim_map__, container._leaflet_map, container._leaflet];
            for (const c of candidates) {
                if (looksLikeLeafletMap(c)) { landingMapRef = c; return c; }
            }
            for (const k in container) {
                try {
                    const v = container[k];
                    if (looksLikeLeafletMap(v)) { landingMapRef = v; return v; }
                } catch (e) {}
            }
        }
        return null;
    }

    const FT_PANE = 'aim-ft-pins';
    function ensureFtPane(map) {
        if (!map || map._aim_ft_pane) return;
        try {
            if (typeof map.createPane !== 'function') return;
            // Above the landing map's site-name markers (600) so a conflict
            // pin is never buried under a "Multiple sites" bubble.
            const p = map.createPane(FT_PANE);
            if (p) { p.style.zIndex = 640; p.style.pointerEvents = 'none'; }
            map._aim_ft_pane = true;
        } catch (e) { console.warn(`${TAG} ensureFtPane failed:`, e); }
    }

    let mapPinLayers = [];
    const pinByPairKey = {};   // "aId:bId" → halo layer (for flash-on-zoom)
    let pinsKey = null;        // what the current pins represent — stops redraw loops
    let pinDrawSeq = 0;

    function clearSweepPins() {
        const map = getLandingMap();
        mapPinLayers.forEach(l => { try { if (map) map.removeLayer(l); } catch (e) {} });
        mapPinLayers = [];
        Object.keys(pinByPairKey).forEach(k => delete pinByPairKey[k]);
        pinsKey = null;
    }

    function sweepPinsKey() {
        if (!lastSweep || !lastSweep.at) return 'none';
        return `${lastSweep.at}:${visiblePairs().length}:${ftCfg.showOnMap}`
            + `:${NB_CLASSES.map(c => +ftCfg.view[c.key]).join('')}`
            + `:${Object.keys(ftCfg.clientsOff).sort().join(',')}`;
    }

    function drawSweepPins(attempt) {
        const seq = ++pinDrawSeq;
        clearSweepPins();
        if (!onLandingPage()) return;   // pinsKey stays null → redrawn on return to landing
        if (!ftCfg.showOnMap || !lastSweep || !lastSweep.at) { pinsKey = sweepPinsKey(); return; }
        const tryDraw = (n) => {
            if (seq !== pinDrawSeq) return;
            const map = getLandingMap();
            const L = getL();
            if (!map || !L) {
                if (n < 30) setTimeout(() => tryDraw(n + 1), 700);
                else console.warn(`${TAG} landing map never found — sweep pins not drawn (tables still work)`);
                return;
            }
            ensureFtPane(map);
            // Closest pairs win the pin budget — a cap keeps a 677-pair
            // sweep from stuffing the landing map with SVG.
            const PIN_CAP = 300;
            const list = visiblePairs()
                .map(p => ({ p, c: visibleConflicts(p)[0] }))
                .filter(x => x.c)
                .sort((a, b) => a.c.ft - b.c.ft);
            if (list.length > PIN_CAP) console.log(`${TAG} ${list.length} visible pairs — drawing the ${PIN_CAP} closest pins (filter to see the rest)`);
            let drawn = 0;
            list.slice(0, PIN_CAP).forEach(({ p, c }) => {
                const color = c.overlap ? '#ff3d00' : '#ffa030';
                try {
                    const halo = L.circleMarker([c.lat, c.lng], {
                        radius: 11, color, weight: 2, opacity: 0.75,
                        fillColor: color, fillOpacity: 0.15,
                        interactive: false, bubblingMouseEvents: false, pane: FT_PANE,
                    });
                    const core = L.circleMarker([c.lat, c.lng], {
                        radius: 3.5, color, weight: 1, opacity: 1,
                        fillColor: color, fillOpacity: 1,
                        interactive: false, bubblingMouseEvents: false, pane: FT_PANE,
                    });
                    halo.addTo(map); core.addTo(map);
                    mapPinLayers.push(halo, core);
                    pinByPairKey[`${p.aId}:${p.bId}`] = halo;
                    drawn++;
                } catch (e) { console.warn(`${TAG} pin draw failed for pair ${p.aId}:${p.bId}:`, e); }
            });
            pinsKey = sweepPinsKey();
            if (drawn) console.log(`${TAG} drew ${drawn} conflict pin(s) on the landing map`);
        };
        tryDraw(attempt || 0);
    }

    function zoomToPair(key) {
        const p = lastSweep && lastSweep.pairs.find(x => `${x.aId}:${x.bId}` === key);
        const c = p && (visibleConflicts(p)[0] || (p.conflicts && p.conflicts[0]));   // match the drawn pin
        const map = getLandingMap();
        if (!c || !map) return;
        try {
            map.setView([c.lat, c.lng], Math.max(map.getZoom ? map.getZoom() : 4, 15));
            const halo = pinByPairKey[key];
            if (halo) {
                halo.setStyle({ weight: 6, opacity: 1 });
                setTimeout(() => { try { halo.setStyle({ weight: 2, opacity: 0.75 }); } catch (e) {} }, 1400);
            }
        } catch (e) { console.warn(`${TAG} zoom-to-pair failed:`, e); }
    }

    // ==================================================================
    // 📊 Fleet Metrics (bones) — per-site counts straight from the index
    // ==================================================================
    function buildMetricsRows() {
        const rows = [];
        Object.keys(nbIndex.bboxes).forEach(id => {
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
    let openSections = { sweep: true, metrics: false };
    let expandedPair = null;   // "aId:bId"

    function onLandingPage() {
        return !!document.querySelector('.pr-sites-select-search');
    }

    function syncButton() {
        const want = onLandingPage();
        if (!want) {
            if (buttonEl) buttonEl.style.display = 'none';
            if (panelEl && !sweepRunning) panelEl.style.display = 'none';
            // SPA nav destroyed the landing map with our pins on it — drop
            // the dead refs so a return to landing redraws from scratch
            if (mapPinLayers.length) { mapPinLayers = []; Object.keys(pinByPairKey).forEach(k => delete pinByPairKey[k]); }
            pinsKey = null;
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
            + `<input type="checkbox" data-ft-flag="showOnMap" ${ftCfg.showOnMap ? 'checked' : ''}> Show on map</label>`
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
        const viewList = vis.map(p => ({ p, vc: visibleConflicts(p) }))
            .sort((a, b) => a.vc[0].ft - b.vc[0].ft || b.vc.length - a.vc.length);
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

    function renderMetricsSection() {
        if (!openSections.metrics) return '';
        const rows = buildMetricsRows();
        if (!rows.length) {
            return '<div style="padding:8px 10px;color:#888">Index is empty — run ⟳ Update index (or a sweep) first.</div>';
        }
        const out = [];
        out.push('<div style="padding:6px 10px;display:flex;gap:14px;border-bottom:1px solid #222834;">'
            + '<span data-ft="metrics-refresh" style="cursor:pointer;color:#7adfe6">⟳ Refresh names/clients</span>'
            + '<span data-ft="metrics-csv" style="cursor:pointer;color:#7adfe6">📋 Copy CSV</span>'
            + `<span style="color:#888">${rows.length} indexed site(s)</span></div>`);
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
                const num = ev.target.closest('input[data-ft-num]');
                if (num) {
                    const prop = num.getAttribute('data-ft-num');
                    const v = Number(num.value);
                    if (!isNaN(v) && v !== ftCfg[prop]) {
                        ftCfg[prop] = v;
                        saveCfg();
                        setStatus(`${prop === 'thresholdFt' ? 'threshold' : 'prefilter margin'} = ${v} ft — takes effect on the next sweep`);
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
    const start = () => {
        syncButton();
        setInterval(syncButton, 2000);
        window.addEventListener('hashchange', () => setTimeout(syncButton, 300));
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
    console.log(`${TAG} v${SCRIPT_VERSION} ready (${ENV_LABEL}${onLandingPage() ? ', landing page' : ''})`);
})();
