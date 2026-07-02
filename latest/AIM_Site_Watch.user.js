// ==UserScript==
// @name         Latest - AIM Site Watch
// @namespace    http://tampermonkey.net/
// @version      0.15
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Watch.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Watch.user.js
// @description  Personal background auditor. Polls every Percepto site's setup JSON (and optionally its missions) on an ADAPTIVE schedule (daily when quiet, every few hours after a change) and records what changed: a running field-level diff CSV plus a rotating gzip snapshot history, committed to the private aim-userscripts-data repo. Daily Slack digest. Configurable in the AIM Control Panel ("Site Watch").
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @connect      api.github.com
// @connect      slack.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==
//
// What it does:
//   - Enumerates your sites from /sites/, then polls each
//     /map_objects/?getPoiMapObjectsAsList=true&site_id=<id> from your own
//     logged-in session (cookie auth — same endpoint the Asset Inspector uses).
//   - DETECTION is cheap: each site's JSON is normalized (keys sorted) and
//     SHA-256 hashed; only the tiny hash is stored locally to decide changed/not.
//   - ADAPTIVE schedule per site: COLD = checked every `coldHours` (default 24h).
//     On a detected change it goes HOT = every `hotHours` (default 3h) and stays
//     HOT on a rolling `hotWindowHours` window (default 24h, resets on each new
//     change); after that quiet window it drops back to COLD.
//   - ON CHANGE: pulls the previous snapshot from GitHub, computes a field-level
//     diff, appends rows to site-watch/changes.csv (the audit log), and stores
//     the new JSON as latest.json.gz + a 10-deep rotating snap-NNN.json.gz ring.
//   - DAILY SLACK DIGEST: once per PT day at digestHourPT (default 6pm PT) the
//     leader tab reads changes.csv back and posts ONE message to the
//     CSM-Site-Issues channel — a parent listing which sites were touched, with
//     a threaded per-site rollup table of what changed. Uses the bot token in
//     DATA_REPO/slack-config.json (same bot/channel as AIM Issues). Silent on a
//     day with zero changes. Catches up a missed day if no tab was open at 6pm.
//   - Robustness: AUTH-LOSS FREEZE (weekend logout / login redirect → never
//     hashes a login page as data, just pauses and resumes Monday); timestamp
//     scheduler with wake catch-up (sleep just delays, never corrupts);
//     single-tab leader lease (only one tab polls even with many open).
//
// Hotkeys: none. Log tag: [AIM WATCH]. Runs in TOP frame only.
//
// GitHub layout (private repo Ned-Yap/aim-userscripts-data, branch main):
//   site-watch/changes.csv                  — running audit log (append-only)
//   site-watch/<siteID>/latest.json.gz      — current baseline (for diffing)
//   site-watch/<siteID>/snap-001..010.json.gz — rotating 10-deep history ring
//   NOTE: git history retains every committed blob, so run `git gc`/squash on
//   aim-userscripts-data quarterly to keep .git from growing unbounded.

(function () {
    'use strict';

    // --- AIM Pilot mode guard: stay fully inert when a pilot/regulator has
    // turned on Pilot mode in the Control Panel (shared localStorage flag). No
    // observers/intervals/network polling start past this point. Toggling Pilot
    // mode reloads the page, so this re-evaluates cleanly each load. (Site Watch
    // is heavy background polling — exactly what a pilot must not carry.) ---
    try {
        if (localStorage.getItem('aim-mode') !== 'full') {
            console.log('[AIM WATCH] Lite mode — CSM tool inert, init skipped.');
            return;
        }
    } catch (e) {}

    const TAG = '[AIM WATCH]';
    const IS_TOP = (window === window.top);

    // TOP frame only. The react-pages iframe (also @match'd) does nothing —
    // fetches are same-origin from top, and gating here avoids a top/iframe
    // double-runner inside a single tab.
    if (!IS_TOP) return;

    // ---- identity / channel ----
    const SCRIPT_ID = 'aim-site-watch';
    const SCRIPT_VERSION = '0.15';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';

    // ---- GitHub (data repo) ----
    const GITHUB_API_BASE = 'https://api.github.com';
    const DATA_REPO = 'Ned-Yap/aim-userscripts-data';
    const DATA_BRANCH = 'main';
    const WATCH_DIR = 'site-watch';
    const CSV_PATH = `${WATCH_DIR}/changes.csv`;
    const CSV_HEADER = 'timestamp_utc,site_id,site_name,change,entity_type,entity_name,object_id,field,was,is';
    const TOKEN_KEY = 'aim-github-token';   // shared with Map Styler / AIM Issues

    // ---- this script's own GM storage keys ----
    const STATE_KEY = 'aim-site-watch-state-v1';
    const META_KEY = 'aim-site-watch-meta';
    const CONFIG_KEY = 'aim-site-watch-config';
    const MASTER_KEY = 'aim-site-watch-master';
    const LEADER_KEY = 'aim-site-watch-leader';
    // ---- daily Slack digest (bot token, reused from AIM Issues' slack-config.json) ----
    // The bot (csmissues) + channel (CSM-Site-Issues) live in the SAME private
    // repo Site Watch already reads (DATA_REPO). chat.postMessage returns a
    // message ts so the per-site detail can thread under one daily parent.
    const SLACK_CONFIG_PATH = 'slack-config.json';
    const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';
    const SLACK_CONFIG_KEY = 'aim-site-watch-slack-config';   // cached {botToken,channelId}
    const DIGEST_DAY_KEY = 'aim-site-watch-digest-day';       // PT day (YYYY-MM-DD) already posted
    const DIGEST_AT_KEY = 'aim-site-watch-digest-at';         // ISO cutoff of the last digest

    // ---- tunables ----
    const DEFAULTS = {
        coldHours: 24,
        hotHours: 3,
        hotWindowHours: 24,
        throttleMs: 1000,       // delay between sites — gentle on Percepto + GitHub secondary write limits
        maxPerCycle: 25,        // sites processed per wake — bounds burst + first-run baselining
        siteListRefreshHours: 24,
        digestHourPT: 18,       // local-PT hour the daily Slack digest fires at (18 = 6pm PT)
        watchMissions: false,   // also poll each site's missions (/available_app/) as a 2nd source
    };
    const WAKE_MS = 15 * 60 * 1000;     // scheduler wake interval
    const LEASE_TTL_MS = 90 * 1000;     // leader lease validity — short, so a vanished tab frees it fast
    const HEARTBEAT_MS = 30 * 1000;     // leader renews / others try to claim this often
    const STARTUP_CATCHUP_MS = 8000;    // first catch-up shortly after load
    const MAX_CSV_FIELD = 500;          // truncate long was/is values

    // ---- runtime state ----
    let cfg = Object.assign({}, DEFAULTS);
    let masterEnabled = false;
    let controlChannel = null;
    let cachedToken = gmGet(TOKEN_KEY, '') || '';
    let slackConfig = (function () {
        try { const s = gmGet(SLACK_CONFIG_KEY, ''); return s ? JSON.parse(s) : null; }
        catch (e) { return null; }
    })();
    let digestRunning = false;
    let digestRetryAfter = 0;       // backoff timestamp after a failed digest post
    const tabId = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now();
    let amLeader = false;
    let pausedForAuth = false;
    let cycleRunning = false;
    let siteList = [];          // [{id, name}]
    let siteListFetchedAt = 0;
    // { sites: {[id]:{hash,state,lastChangeAt,lastCheckAt,nextCheckAt,slot}}, missions: {[id]:{…same…}} }
    let state = loadState();

    // =====================================================================
    // GM storage wrappers (@grant declared above so these are real, not no-ops)
    // =====================================================================
    function gmGet(key, def) {
        try { if (typeof GM_getValue === 'function') return GM_getValue(key, def); }
        catch (e) { console.warn(TAG, 'gmGet', key, e); }
        return def;
    }
    function gmSet(key, val) {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, val); }
        catch (e) { console.warn(TAG, 'gmSet', key, e); }
    }

    function loadState() {
        const s = gmGet(STATE_KEY, null);
        const st = (s && s.sites) ? s : { sites: {} };
        if (!st.missions) st.missions = {};     // 2nd source (missions); migrate older state
        return st;
    }
    function persistState() { gmSet(STATE_KEY, state); }
    function persistMeta() { gmSet(META_KEY, { siteListFetchedAt, siteList }); }
    function saveConfig() {
        gmSet(CONFIG_KEY, { coldHours: cfg.coldHours, hotHours: cfg.hotHours, hotWindowHours: cfg.hotWindowHours, digestHourPT: cfg.digestHourPT, watchMissions: cfg.watchMissions });
    }
    function loadConfig() { const c = gmGet(CONFIG_KEY, null); if (c) Object.assign(cfg, c); }

    // =====================================================================
    // Encoding / hashing / compression helpers
    // =====================================================================
    function textToB64(text) {
        const utf8 = new TextEncoder().encode(text);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < utf8.length; i += chunk) bin += String.fromCharCode.apply(null, utf8.subarray(i, i + chunk));
        return btoa(bin);
    }
    function b64ToText(b64) {
        const bin = atob((b64 || '').replace(/\n/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    }
    function bytesToB64(bytes) {
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        return btoa(bin);
    }
    function b64ToBytes(b64) {
        const bin = atob((b64 || '').replace(/\n/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }
    async function gzipToBytes(str) {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(new TextEncoder().encode(str));
        writer.close();
        const ab = await new Response(cs.readable).arrayBuffer();
        return new Uint8Array(ab);
    }
    async function gunzipFromBytes(bytes) {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const ab = await new Response(ds.readable).arrayBuffer();
        return new TextDecoder('utf-8').decode(new Uint8Array(ab));
    }
    async function sha256Hex(str) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        const arr = new Uint8Array(buf);
        let hex = '';
        for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
        return hex;
    }
    // Deterministic JSON: sorts object keys recursively so key-order churn
    // doesn't register as a change.
    function stableStringify(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
        const keys = Object.keys(value).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
    }
    // Live drone telemetry (battery, position, status of the allocated drone)
    // changes constantly and is NOT a setup edit. Stripped from the data BEFORE
    // hashing / diffing / snapshotting so it never triggers a false change or
    // HOT escalation. Add more keys here if other volatile fields turn up.
    const VOLATILE_KEYS = ['allocated_by_drone'];
    function stripVolatile(value) {
        if (Array.isArray(value)) return value.map(stripVolatile);
        if (value && typeof value === 'object') {
            const out = {};
            for (const k of Object.keys(value)) {
                if (VOLATILE_KEYS.indexOf(k) !== -1) continue;
                out[k] = stripVolatile(value[k]);
            }
            return out;
        }
        return value;
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    // fetch() has no built-in timeout — without this a single hung request
    // would freeze the whole cycle indefinitely. Aborts after `ms`.
    async function fetchWithTimeout(url, opts, ms) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms);
        try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
        finally { clearTimeout(t); }
    }

    // =====================================================================
    // GitHub HTTP (Promise over GM_xmlhttpRequest)
    // =====================================================================
    function ghRequest(opts) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest unavailable — re-approve grants in Tampermonkey'));
                return;
            }
            try {
                GM_xmlhttpRequest({
                    ...opts,
                    onload: (resp) => resolve(resp),
                    onerror: (err) => reject(err || new Error('network error')),
                    ontimeout: () => reject(new Error('timeout')),
                });
            } catch (e) { reject(e); }
        });
    }
    function ghHeaders(write) {
        const h = { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github+json' };
        if (write) h['Content-Type'] = 'application/json';
        return h;
    }
    function ghPath(path) { return path.split('/').map(encodeURIComponent).join('/'); }

    // Returns {sha, base64} or null on 404.
    async function ghGetMeta(path) {
        if (!cachedToken) throw new Error('no token');
        const url = `${GITHUB_API_BASE}/repos/${DATA_REPO}/contents/${ghPath(path)}?ref=${DATA_BRANCH}`;
        const resp = await ghRequest({ method: 'GET', url, headers: ghHeaders(), timeout: 25000 });
        if (resp.status === 404) return null;
        if (resp.status !== 200) throw new Error(`GET ${path} HTTP ${resp.status}`);
        const meta = JSON.parse(resp.responseText);
        return { sha: meta.sha || null, base64: meta.content || '' };
    }
    // Raw file content as text. The Contents API blanks base64 `content` to ''
    // for files over 1 MB (returns encoding:"none", NOT an error) — that would
    // silently empty the growing changes.csv on read AND make appendCsvRows
    // rewrite it from scratch (history wipe). The raw media type returns the
    // body directly and works up to 100 MB. Returns the text, or null on 404.
    async function ghGetRaw(path) {
        if (!cachedToken) throw new Error('no token');
        const url = `${GITHUB_API_BASE}/repos/${DATA_REPO}/contents/${ghPath(path)}?ref=${DATA_BRANCH}`;
        const resp = await ghRequest({
            method: 'GET', url,
            headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github.raw' },
            timeout: 30000,
        });
        if (resp.status === 404) return null;
        if (resp.status !== 200) throw new Error(`GET(raw) ${path} HTTP ${resp.status}`);
        return resp.responseText || '';
    }
    async function safeGetSha(path) {
        try { const m = await ghGetMeta(path); return m ? m.sha : undefined; }
        catch (e) { console.warn(TAG, `sha lookup ${path}`, e); return undefined; }
    }
    // Create/update a file. base64Content is already base64. Handles 409/422
    // (sha conflict) by re-GETting the sha and retrying once.
    async function ghPut(path, base64Content, message, sha) {
        const url = `${GITHUB_API_BASE}/repos/${DATA_REPO}/contents/${ghPath(path)}`;
        const body = { message, content: base64Content, branch: DATA_BRANCH };
        if (sha) body.sha = sha;
        let resp = await ghRequest({ method: 'PUT', url, headers: ghHeaders(true), data: JSON.stringify(body), timeout: 30000 });
        if (resp.status === 200 || resp.status === 201) {
            const ret = JSON.parse(resp.responseText);
            return ret && ret.content ? ret.content.sha : null;
        }
        if (resp.status === 409 || resp.status === 422) {
            const fresh = await safeGetSha(path);
            const body2 = { message, content: base64Content, branch: DATA_BRANCH };
            if (fresh) body2.sha = fresh;
            resp = await ghRequest({ method: 'PUT', url, headers: ghHeaders(true), data: JSON.stringify(body2), timeout: 30000 });
            if (resp.status === 200 || resp.status === 201) {
                const ret = JSON.parse(resp.responseText);
                return ret && ret.content ? ret.content.sha : null;
            }
        }
        throw new Error(`PUT ${path} HTTP ${resp.status}`);
    }
    // Robust read of the changes.csv. Returns {text, sha}:
    //   - {text:null, sha:null}  ONLY on a genuine 404 (file does not exist yet).
    //   - {text, sha}            on success (full content + the sha for the PUT).
    //   - THROWS                 when the file EXISTS (sha present) but the body
    //                            can't be read back intact.
    // A blank/short read of an existing file is a READ FAILURE, never an empty
    // file. v0.11–v0.13 treated it as empty and rewrote the file from a bare
    // header — silently wiping ~3000 rows of audit history on 2026-06-20, then
    // re-wiping every cycle. So we sanity-check (non-empty + our header) and
    // refuse to proceed otherwise. Read base64 from the Contents API when it's
    // present (the proven path that carried 3000+ rows); the API only blanks
    // base64 above 1 MB, so fall back to the raw media type just for that case.
    async function readCsv() {
        const meta = await ghGetMeta(CSV_PATH);
        if (!meta) return { text: null, sha: null };          // genuine 404
        let text;
        if (meta.base64 && meta.base64.length) text = b64ToText(meta.base64);   // <1 MB
        else text = await ghGetRaw(CSV_PATH);                 // >1 MB — base64 blanked
        const firstLine = text ? (text.split('\n', 1)[0] || '') : '';
        if (!text || !text.length || firstLine !== CSV_HEADER) {
            throw new Error(`CSV read failed for existing file (sha ${meta.sha}, len ${text ? text.length : 'null'}, head "${firstLine.slice(0, 40)}") — refusing to overwrite history`);
        }
        return { text, sha: meta.sha };
    }

    // CSV append: re-reads fresh content each attempt so concurrent appends
    // never drop rows, and NEVER recreates an existing file from scratch (a bad
    // read retries, then aborts with history intact rather than wiping it).
    async function appendCsvRows(rowStrings, message) {
        if (!rowStrings.length) return;
        for (let attempt = 0; attempt < 3; attempt++) {
            let base, sha;
            try {
                const r = await readCsv();
                if (r.text == null) { base = CSV_HEADER + '\n'; sha = undefined; }   // create ONLY on real 404
                else { base = r.text.endsWith('\n') ? r.text : r.text + '\n'; sha = r.sha; }
            } catch (e) {
                // Read of an existing file failed — retry; do NOT overwrite.
                console.warn(`${TAG} CSV read attempt ${attempt + 1}/3 failed, retrying`, e);
                await sleep(800);
                continue;
            }
            const content = base + rowStrings.join('\n') + '\n';
            const url = `${GITHUB_API_BASE}/repos/${DATA_REPO}/contents/${ghPath(CSV_PATH)}`;
            const body = { message, content: textToB64(content), branch: DATA_BRANCH };
            if (sha) body.sha = sha;
            const resp = await ghRequest({ method: 'PUT', url, headers: ghHeaders(true), data: JSON.stringify(body), timeout: 30000 });
            if (resp.status === 200 || resp.status === 201) return;
            if (resp.status === 409 || resp.status === 422) continue;   // sha conflict → re-read and re-append
            throw new Error(`CSV PUT HTTP ${resp.status}`);
        }
        // All attempts exhausted. Better to drop these rows (still recorded in the
        // per-site snapshots) than to wipe the whole audit log.
        throw new Error('CSV append failed after retries — audit log left intact, rows not written');
    }

    // =====================================================================
    // Percepto fetch (same-origin, cookie auth)
    // =====================================================================
    async function fetchSiteSetup(siteId) {
        const url = `/map_objects/?getPoiMapObjectsAsList=true&site_id=${encodeURIComponent(siteId)}`;
        let resp;
        try { resp = await fetchWithTimeout(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } }, 20000); }
        catch (e) { return { error: 'network', detail: String(e) }; }
        if (resp.status === 401 || resp.status === 403) return { authLost: true };
        if (resp.redirected && /\/(login|signin|auth|account)/i.test(resp.url)) return { authLost: true };
        if (!resp.ok) return { error: 'http', status: resp.status };
        const ct = resp.headers.get('content-type') || '';
        const text = await resp.text();
        // Logged-out responses often come back as a 200 HTML login page. NEVER
        // hash that as site data. If it smells like a login page → auth-loss
        // (freeze everything). Otherwise it's just one odd site → skip it, but
        // don't pause the whole watcher over a single weird response.
        if (!/json/i.test(ct)) {
            if (/<form|login|sign\s*in|password|csrf/i.test(text)) return { authLost: true, reason: 'login-page' };
            return { error: 'non-json' };
        }
        let data;
        try { data = JSON.parse(text); } catch (e) { return { error: 'parse' }; }
        return { data };
    }

    // Missions for a site — same cookie auth, one link per site returning ALL
    // that site's missions. Same shape as fetchSiteSetup: {data} | {authLost} | {error}.
    async function fetchMissions(siteId) {
        const url = `/available_app/?site_id=${encodeURIComponent(siteId)}&type=1`;
        let resp;
        try { resp = await fetchWithTimeout(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } }, 20000); }
        catch (e) { return { error: 'network', detail: String(e) }; }
        if (resp.status === 401 || resp.status === 403) return { authLost: true };
        if (resp.redirected && /\/(login|signin|auth|account)/i.test(resp.url)) return { authLost: true };
        if (!resp.ok) return { error: 'http', status: resp.status };
        const ct = resp.headers.get('content-type') || '';
        const text = await resp.text();
        if (!/json/i.test(ct)) {
            if (/<form|login|sign\s*in|password|csrf/i.test(text)) return { authLost: true, reason: 'login-page' };
            return { error: 'non-json' };
        }
        let data;
        try { data = JSON.parse(text); } catch (e) { return { error: 'parse' }; }
        return { data };
    }

    async function fetchSiteList() {
        let resp;
        try { resp = await fetchWithTimeout('/sites/', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } }, 20000); }
        catch (e) { console.warn(TAG, 'site list fetch failed', e); return null; }
        if (resp.status === 401 || resp.status === 403) { pauseForAuth('site-list 401/403'); return null; }
        if (!resp.ok) { console.warn(TAG, 'site list HTTP', resp.status); return null; }
        const ct = resp.headers.get('content-type') || '';
        const text = await resp.text();
        let sites = [];
        if (/json/i.test(ct)) {
            try {
                const list = extractList(JSON.parse(text));
                sites = list
                    .map(s => ({ id: String(s.id != null ? s.id : (s.site_id != null ? s.site_id : (s.pk != null ? s.pk : ''))), name: String(s.name || s.site_name || s.title || '') }))
                    .filter(s => s.id);
            } catch (e) { console.warn(TAG, 'site list JSON parse failed', e); }
        }
        if (!sites.length) sites = parseSitesFromHtml(text);
        const seen = new Set();
        const out = [];
        for (const s of sites) { if (s.id && !seen.has(s.id)) { seen.add(s.id); out.push(s); } }
        return out;
    }
    function parseSitesFromHtml(html) {
        const out = [];
        const seen = new Set();
        const re = /(?:site_id=|\/site\/)(\d+)/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            if (!seen.has(m[1])) { seen.add(m[1]); out.push({ id: m[1], name: '' }); }
        }
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            doc.querySelectorAll('a[href*="site_id="],a[href*="/site/"]').forEach(a => {
                const mm = /(?:site_id=|\/site\/)(\d+)/.exec(a.getAttribute('href') || '');
                if (!mm) return;
                const name = (a.textContent || '').trim();
                const ex = out.find(s => s.id === mm[1]);
                if (ex && name && !ex.name) ex.name = name;
            });
        } catch (e) { console.warn(TAG, 'site list HTML name parse', e); }
        return out;
    }

    // Pull an array of objects out of whatever shape the endpoint returns.
    function extractList(data) {
        if (Array.isArray(data)) return data;
        if (data && typeof data === 'object') {
            for (const k of ['results', 'objects', 'data', 'map_objects', 'mapObjects', 'pois', 'items', 'sites']) {
                if (Array.isArray(data[k])) return data[k];
            }
            const vals = Object.values(data);
            if (vals.length && vals.every(v => v && typeof v === 'object')) return vals;
        }
        return [];
    }
    function getObjId(obj) {
        if (!obj || typeof obj !== 'object') return null;
        for (const k of ['id', '_id', 'pk', 'poi_id', 'objectId', 'uuid']) {
            if (obj[k] != null) return String(obj[k]);
        }
        if (obj.name != null) return 'name:' + String(obj.name);
        return null;
    }

    // =====================================================================
    // Diff engine (field-level)
    // =====================================================================
    function fmtVal(v) {
        let s = (v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        if (s.length > MAX_CSV_FIELD) s = s.slice(0, MAX_CSV_FIELD) + '…';
        return s;
    }
    function summarize(o) {
        if (!o || typeof o !== 'object') return fmtVal(o);
        const name = o.name || o.title || o.label || '';
        const type = o.type != null ? typeShort(o.type) : '';
        const bits = [];
        if (name) bits.push(`name=${name}`);
        if (type) bits.push(`type=${type}`);
        return bits.length ? bits.join(' ') : fmtVal(o);
    }
    // Percepto entity type → short label (mirrors Asset Inspector's TYPE_REG).
    const TYPE_SHORT = { 3: 'Asset', 4: 'NFZ', 8: 'Base', 15: 'FP', 16: 'FFZ', 19: 'Marker', 98: 'SafeZone' };
    function typeShort(t) { return TYPE_SHORT[t] != null ? TYPE_SHORT[t] : ('type' + t); }
    // Display remap for entity_type strings already written to old CSV rows
    // (those stored "type8"/"type98" before the map above gained 8/98).
    const TYPE_DISPLAY = { type8: 'Base', type98: 'SafeZone' };
    function dispType(s) { return TYPE_DISPLAY[s] || s; }
    function entMeta(o) { return { etype: (o && o.type != null) ? typeShort(o.type) : '', ename: (o && (o.name || o.title || o.label)) || '' }; }
    // Derived/internal fields that regenerate on every save (arc ids, recomputed
    // distances) or mirror another field (coords ↔ arc points — arcs is the
    // geometry source of truth). Skipped in the diff OUTPUT so the CSV shows the
    // meaningful edit, not the churn. (Still part of the hash, so a real re-save
    // is still noticed → logged as a non-structural change if nothing else moved.)
    function isNoiseField(path) {
        if (path === 'id' || path.endsWith('.id')) return true;
        if (path === 'distance' || path.endsWith('.distance')) return true;
        if (path === 'coords' || path.indexOf('coords.') === 0) return true;
        return false;
    }
    function diffObjects(oldList, newList) {
        const rows = [];
        const oldMap = new Map();
        oldList.forEach((o, i) => oldMap.set(getObjId(o) || ('idx:' + i), o));
        const newMap = new Map();
        newList.forEach((o, i) => newMap.set(getObjId(o) || ('idx:' + i), o));
        for (const [id, o] of oldMap) {
            if (!newMap.has(id)) { const m = entMeta(o); rows.push({ change: 'removed', etype: m.etype, ename: m.ename, objectId: id, field: '(entity)', was: summarize(o), is: '' }); }
        }
        for (const [id, o] of newMap) {
            if (!oldMap.has(id)) { const m = entMeta(o); rows.push({ change: 'added', etype: m.etype, ename: m.ename, objectId: id, field: '(entity)', was: '', is: summarize(o) }); }
        }
        for (const [id, nObj] of newMap) {
            if (!oldMap.has(id)) continue;
            const m = entMeta(nObj);
            deepDiff(oldMap.get(id), nObj, '', (path, was, is) => {
                if (isNoiseField(path)) return;
                rows.push({ change: 'modified', etype: m.etype, ename: m.ename, objectId: id, field: path || '(root)', was: fmtVal(was), is: fmtVal(is) });
            });
        }
        return rows;
    }
    function deepDiff(a, b, path, emit) {
        if (stableStringify(a) === stableStringify(b)) return;
        const aObj = a && typeof a === 'object';
        const bObj = b && typeof b === 'object';
        if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) { emit(path, a, b); return; }
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
            const sub = path ? path + '.' + k : k;
            const av = a[k];
            const bv = b[k];
            if (stableStringify(av) === stableStringify(bv)) continue;
            if (av && typeof av === 'object' && bv && typeof bv === 'object') deepDiff(av, bv, sub, emit);
            else emit(sub, av, bv);
        }
    }
    function csvCell(s) {
        s = String(s == null ? '' : s);
        if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
    }
    function csvRow(arr) { return arr.map(csvCell).join(','); }

    // =====================================================================
    // Mission fingerprint + diff
    // ---------------------------------------------------------------------
    // We DON'T raw-diff the mission payload. Instead each mission is reduced to
    // a compact "fingerprint" holding ONLY the things worth watching: name,
    // active flag, distance, duration, total steps, per-type step counts, and a
    // per-step value bag (altitude / speed / GPS / camera pitch / any value).
    // Everything else — regenerating instruction ids, recomputed route_points,
    // the app_data consumption breakdown, mirror fields — is simply never put in
    // the fingerprint, so it can't create noise. The fingerprint is BOTH what we
    // hash (change detection) and what we diff (the report). No strip list.
    // Distance/duration are derived and can shift when a site's FFZ/shielding is
    // edited and the route reroutes — that's intentionally still flagged; you'll
    // usually see a matching row from the Site-Setup source the same day.
    // =====================================================================
    function num(v, dp) { return (typeof v === 'number' && isFinite(v)) ? +v.toFixed(dp) : null; }
    function missionStepFP(ins, i) {
        const t = ins.type_name || ('type' + ins.type);
        const geo = (t === 'navigate' || t === 'snapshot');
        const fp = { i, t };
        if (ins.location && typeof ins.location === 'object' && ins.location.lat != null) {
            fp.lat = num(+ins.location.lat, 7);
            fp.lng = num(+ins.location.lng, 7);
        }
        if (typeof ins.value1 === 'number') fp[geo ? 'alt' : 'value'] = num(ins.value1, 2);
        else if (ins.value1 != null && typeof ins.value1 !== 'object') fp.value = ins.value1;   // bool / string
        if (typeof ins.value2 === 'number') fp[geo ? 'speed' : 'value2'] = num(ins.value2, 3);
        if (ins.extra_options && typeof ins.extra_options === 'object') {
            for (const k of Object.keys(ins.extra_options)) fp['opt_' + k] = ins.extra_options[k];
        }
        return fp;
    }
    function missionFP(m) {
        const instr = Array.isArray(m.instructions) ? m.instructions : [];
        const typeCounts = {};
        for (const ins of instr) { const t = ins.type_name || ('type' + ins.type); typeCounts[t] = (typeCounts[t] || 0) + 1; }
        const ad = m.app_data || {};
        return {
            id: String(m.id != null ? m.id : ''),
            name: m.name || '',
            active: m.is_active !== false,
            mtype: m.type,
            distance: ad.flight_distance != null ? ad.flight_distance : null,   // meters
            duration: ad.flight_time != null ? ad.flight_time : null,           // seconds
            steps: instr.length,
            typeCounts,
            stepFP: instr.map(missionStepFP),
        };
    }
    // Whole-payload → array of fingerprints, keyed/sorted by mission id so array
    // reordering never registers as a change.
    function missionFingerprints(payload) {
        return extractList(payload).map(missionFP).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    function activeLabel(a) { return a ? 'active' : 'inactive'; }
    // Compare two step fingerprints (same index) → labeled value changes.
    function diffStepFP(oldS, newS, i, tName, emit) {
        const keys = new Set([...Object.keys(oldS || {}), ...Object.keys(newS || {})]);
        for (const k of keys) {
            if (k === 'i' || k === 't') continue;
            const a = oldS ? oldS[k] : undefined;
            const b = newS ? newS[k] : undefined;
            if (stableStringify(a) === stableStringify(b)) continue;
            emit(`step[${i}].${tName}.${k}`, a, b);
        }
    }
    // Summarized diff of two fingerprint arrays. Returns rows in the same shape
    // as diffObjects (etype fixed to 'mission' so the CSV/digest can split it out).
    function diffMissions(oldFPs, newFPs) {
        const rows = [];
        const oldMap = new Map(); (oldFPs || []).forEach(f => oldMap.set(f.id, f));
        const newMap = new Map(); (newFPs || []).forEach(f => newMap.set(f.id, f));
        const push = (change, f, field, was, is) => rows.push({ change, etype: 'mission', ename: f.name || f.id, objectId: f.id, field, was: fmtVal(was), is: fmtVal(is) });
        // Deleted
        for (const [id, f] of oldMap) {
            if (!newMap.has(id)) push('removed', f, '(mission)', `${f.steps} steps`, '');
        }
        // Added
        for (const [id, f] of newMap) {
            if (!oldMap.has(id)) push('added', f, '(mission)', '', `${f.steps} steps`);
        }
        // Modified
        for (const [id, nf] of newMap) {
            const of = oldMap.get(id);
            if (!of) continue;
            if (of.name !== nf.name) push('modified', nf, 'name', of.name, nf.name);
            if (of.active !== nf.active) push('modified', nf, 'active', activeLabel(of.active), activeLabel(nf.active));
            if (of.distance !== nf.distance) push('modified', nf, 'distance', of.distance == null ? '' : `${of.distance} m`, nf.distance == null ? '' : `${nf.distance} m`);
            if (of.duration !== nf.duration) push('modified', nf, 'duration', of.duration == null ? '' : `${of.duration} s`, nf.duration == null ? '' : `${nf.duration} s`);
            if (of.steps !== nf.steps) push('modified', nf, 'step_count', of.steps, nf.steps);
            // Per-type count deltas
            const types = new Set([...Object.keys(of.typeCounts || {}), ...Object.keys(nf.typeCounts || {})]);
            for (const t of types) {
                const a = (of.typeCounts || {})[t] || 0, b = (nf.typeCounts || {})[t] || 0;
                if (a !== b) push('modified', nf, `count.${t}`, a, b);
            }
            if (of.steps === nf.steps) {
                // Same length → indices line up → per-step value diff.
                for (let i = 0; i < nf.steps; i++) {
                    diffStepFP(of.stepFP[i], nf.stepFP[i], i, (nf.stepFP[i] && nf.stepFP[i].t) || '', (field, was, is) => push('modified', nf, field, was, is));
                }
            } else {
                // Count changed → alignment breaks; report the first position where
                // the step-type sequence diverges (everything below it shifted).
                const n = Math.min(of.steps, nf.steps);
                let k = 0;
                while (k < n && (of.stepFP[k].t === nf.stepFP[k].t)) k++;
                push('modified', nf, 'first_change_at', '', `step ${k}${nf.stepFP[k] ? ' (' + nf.stepFP[k].t + ')' : ''}`);
            }
        }
        return rows;
    }

    // =====================================================================
    // Scheduler
    // =====================================================================
    function nameFor(id) {
        const s = siteList.find(x => x.id === id);
        return s ? (s.name || '') : '';
    }
    function latestPath(id) { return `${WATCH_DIR}/${id}/latest.json.gz`; }
    function snapPath(id, slot) { return `${WATCH_DIR}/${id}/snap-${String(slot).padStart(3, '0')}.json.gz`; }
    // Missions live under the same site folder, prefixed so they never collide
    // with the setup snapshots. We store the compact fingerprint (below), not the
    // raw payload — it's the whitelist of fields we care about, and much smaller.
    function mLatestPath(id) { return `${WATCH_DIR}/${id}/mission-latest.json.gz`; }
    function mSnapPath(id, slot) { return `${WATCH_DIR}/${id}/mission-snap-${String(slot).padStart(3, '0')}.json.gz`; }
    function scheduleNext(st, mode) {
        const hours = (mode === 'hot') ? cfg.hotHours : cfg.coldHours;
        st.nextCheckAt = Date.now() + hours * 3600e3;
    }
    function pauseForAuth(why) {
        if (!pausedForAuth) console.warn(`${TAG} paused — appears logged out (${why}). Will resume after you log back in.`);
        pausedForAuth = true;
    }

    // Leader lease — only one tab polls. Short TTL + heartbeat + pagehide
    // release so a refreshed/closed tab frees it immediately (a stale lease
    // from a dead page must never deadlock the live tabs).
    function leaseForeignAndFresh(now) {
        const lease = gmGet(LEADER_KEY, null);
        return !!(lease && lease.tabId && lease.ts && lease.tabId !== tabId && (now - lease.ts) < LEASE_TTL_MS);
    }
    function claimLeader() {
        const now = Date.now();
        if (leaseForeignAndFresh(now)) { amLeader = false; return false; }
        gmSet(LEADER_KEY, { tabId, ts: now });
        const after = gmGet(LEADER_KEY, null);
        amLeader = !!(after && after.tabId === tabId);
        return amLeader;
    }
    function renewLeader() { if (amLeader) gmSet(LEADER_KEY, { tabId, ts: Date.now() }); }
    function stealLeader() { gmSet(LEADER_KEY, { tabId, ts: Date.now() }); amLeader = true; }   // manual action forces this tab
    function releaseLeader() {
        const lease = gmGet(LEADER_KEY, null);
        if (lease && lease.tabId === tabId) gmSet(LEADER_KEY, null);
        amLeader = false;
    }

    // =====================================================================
    // Slack daily digest
    // -----
    // Posting goes through the Slack Web API (chat.postMessage) using the bot
    // token in DATA_REPO/slack-config.json — the SAME bot + CSM-Site-Issues
    // channel AIM Issues already uses. chat.postMessage returns the message ts,
    // so the per-site detail threads under one daily parent (incoming webhooks
    // can't thread, which is why the old webhook path was dropped).
    //
    // Cadence: once per PT day, fired on the first leader tick at/after
    // `digestHourPT` (default 18 = 6pm PT). Browser-only, so if no tab was open
    // at 6pm the next tab to open that catches up posts the missed day. The
    // changes.csv (durable audit log) is the source of truth — we read it back
    // and report every row since the last digest's cutoff, so nothing is lost
    // across browser restarts. Silent on a day with zero changes.
    // =====================================================================
    function slackEnabled() { return !!(slackConfig && slackConfig.botToken && slackConfig.channelId); }
    function slackEsc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    // Pull the Slack bot config from DATA_REPO/slack-config.json (cookie-less,
    // PAT-authed GitHub read) and cache in GM so a refresh keeps Slack working.
    async function fetchSlackConfig() {
        if (!cachedToken) return;
        try {
            const meta = await ghGetMeta(SLACK_CONFIG_PATH);
            if (!meta) { console.warn(TAG, 'slack-config.json missing — digest disabled'); slackConfig = null; gmSet(SLACK_CONFIG_KEY, ''); return; }
            const cfgObj = JSON.parse(b64ToText(meta.base64 || ''));
            if (cfgObj && cfgObj.botToken && cfgObj.channelId) {
                slackConfig = { botToken: cfgObj.botToken, channelId: cfgObj.channelId };
                gmSet(SLACK_CONFIG_KEY, JSON.stringify(slackConfig));
                console.log(`${TAG} Slack config loaded — channel ${slackConfig.channelId}`);
            } else {
                console.warn(TAG, 'slack-config.json present but missing botToken/channelId — digest disabled');
                slackConfig = null; gmSet(SLACK_CONFIG_KEY, '');
            }
        } catch (e) { console.warn(TAG, 'fetchSlackConfig threw', e); }
    }

    // POST a message (optionally threaded). Resolves to the message ts on
    // success, null on any failure. Never throws.
    async function slackPost(text, threadTs) {
        if (!slackEnabled()) return null;
        try {
            const body = { channel: slackConfig.channelId, text };
            if (threadTs) body.thread_ts = threadTs;
            const resp = await ghRequest({
                method: 'POST', url: SLACK_POST_URL,
                headers: { 'Authorization': `Bearer ${slackConfig.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
                data: JSON.stringify(body), timeout: 15000,
            });
            let parsed = null; try { parsed = JSON.parse(resp.responseText); } catch (e) {}
            if (resp.status === 200 && parsed && parsed.ok) return parsed.ts || null;
            console.warn(`${TAG} Slack post failed: HTTP ${resp.status} ${parsed ? parsed.error : (resp.responseText || '').slice(0, 200)}`);
            return null;
        } catch (e) { console.warn(TAG, 'slackPost threw', e); return null; }
    }

    // ---- PT clock (DST-correct via Intl) ----
    function ptParts() {
        const now = new Date();
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        let hour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(now), 10);
        if (hour === 24) hour = 0;       // some engines render midnight as 24
        return { day, hour };
    }
    function prevDay(ymd) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
    // The most recent PT day whose digest boundary (digestHourPT) has passed.
    function targetDigestDay() {
        const { day, hour } = ptParts();
        return (hour >= cfg.digestHourPT) ? day : prevDay(day);
    }
    // "6pm PT" / "8am PT" from a 24h hour, for the parent header.
    function hourLabelPT(h) {
        const ampm = h < 12 ? 'am' : 'pm';
        let hh = h % 12; if (hh === 0) hh = 12;
        return `${hh}${ampm} PT`;
    }
    // Short PT datetime for the "changes from … to …" window line.
    function fmtPT(iso) {
        if (!iso) return '(start)';
        try {
            return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) + ' PT';
        } catch (e) { return iso; }
    }

    // ---- CSV read-back (the durable log is the source of truth) ----
    // Proper parser: was/is cells are quoted and can contain commas, quotes, and
    // newlines — split(',') would shred them.
    function parseCsv(text) {
        const rows = [];
        let row = [], cell = '', inQ = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inQ) {
                if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
                else cell += ch;
            } else {
                if (ch === '"') inQ = true;
                else if (ch === ',') { row.push(cell); cell = ''; }
                else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
                else if (ch === '\r') { /* skip */ }
                else cell += ch;
            }
        }
        if (cell.length || row.length) { row.push(cell); rows.push(row); }
        return rows;
    }
    async function fetchChangesSince(sinceISO) {
        const { text } = await readCsv();           // throws on a bad read of an existing file
        if (text == null) return [];                // genuine 404 — no log yet
        const rows = parseCsv(text);
        if (!rows.length) return [];
        const header = rows[0];
        const idx = {};
        header.forEach((h, i) => idx[h] = i);
        const out = [];
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (!row.length || row.every(c => c === '')) continue;
            const ts = row[idx.timestamp_utc] || '';
            if (sinceISO && ts <= sinceISO) continue;   // ISO Zulu strings sort lexically
            out.push({
                ts, siteId: row[idx.site_id] || '', siteName: row[idx.site_name] || '',
                change: row[idx.change] || '', etype: row[idx.entity_type] || '', ename: row[idx.entity_name] || '',
                objectId: row[idx.object_id] || '', field: row[idx.field] || '',
                was: row[idx.was] || '', is: row[idx.is] || '',
            });
        }
        return out;
    }

    // Collapse a field path to a readable label; geometry churn → "geometry".
    function collapseField(path) {
        if (!path || path === '(entity)') return '';
        if (path === '(non-structural change)') return 'non-structural';
        if (path === '(changed; no prior snapshot)') return 'first-diff';
        if (/^arcs\b/.test(path) || /(^|\.)coords(\.|$)/.test(path) || /point_[ab]/.test(path) || /\.(lat|lng)$/.test(path)) return 'geometry';
        const seg = path.split('.').pop();
        return seg || path;
    }
    function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
    // Readable label for a mission change field (keeps the step index).
    function missionFieldLabel(field) {
        if (field === 'step_count') return 'steps';
        if (field.indexOf('count.') === 0) return field.slice(6) + ' count';
        if (field === 'first_change_at') return 'first change';
        const m = /^step\[(\d+)\]\.([^.]+)\.(.+)$/.exec(field);
        if (m) return `step${m[1]} ${m[3]}`;    // e.g. "step2 alt"
        return field;                            // name / active / distance / duration
    }

    // Group flat CSV rows → per-site, per-entity rollup.
    function rollup(changeRows) {
        const sites = new Map();   // siteId → {name, ents:Map(key→{change,etype,ename,fields:Set,tuples:[]})}
        for (const c of changeRows) {
            if (!sites.has(c.siteId)) sites.set(c.siteId, { name: c.siteName, ents: new Map() });
            const site = sites.get(c.siteId);
            if (c.siteName && !site.name) site.name = c.siteName;
            const mission = c.etype === 'mission';
            // Missions are keyed by object id so a mission's rows group together;
            // setup notes without an objectId fall back to the field.
            const key = (mission ? 'm:' : '') + (c.objectId || ('note:' + c.field));
            if (!site.ents.has(key)) site.ents.set(key, { change: c.change, etype: c.etype, ename: c.ename || c.objectId, fields: new Set(), tuples: [], mission });
            const e = site.ents.get(key);
            const f = collapseField(c.field);
            if (f) e.fields.add(f);
            // Keep the actual old→new values for missions so the digest can show
            // them (setup rows stay summarized as field names only). Cap per entity.
            if (mission && e.tuples.length < 12 && c.field && c.field !== '(mission)') e.tuples.push({ field: c.field, was: c.was, is: c.is });
        }
        return sites;
    }

    // Sites ordered most-changed first (shared by parent + thread so row N in
    // the parent list lines up with block N in the thread).
    function orderedSites(sites) {
        return [...sites.entries()].sort((a, b) => (b[1].ents.size - a[1].ents.size) || (a[1].name || a[0]).localeCompare(b[1].name || b[0]));
    }
    function buildParent(sites, dayLabel, sinceISO, nowISO) {
        const n = sites.size;
        const lines = [`:satellite: *Site Watch — daily digest* (${slackEsc(dayLabel)}, ${hourLabelPT(cfg.digestHourPT)})`,
                       `*${n}* site${n === 1 ? '' : 's'} changed · _${fmtPT(sinceISO)} → ${fmtPT(nowISO)}_`, ''];
        const arr = orderedSites(sites);
        const CAP = 50;
        arr.slice(0, CAP).forEach(([id, s]) => {
            let a = 0, r = 0, m = 0, mis = 0;
            for (const e of s.ents.values()) { if (e.change === 'added') a++; else if (e.change === 'removed') r++; else m++; if (e.mission) mis++; }
            const url = siteSetupUrl(id);
            const name = slackEsc(s.name || '(unnamed)').replace(/\|/g, '/');   // | breaks <url|text>

            const cnt = s.ents.size;
            const tally = [a ? `${a} added` : '', r ? `${r} removed` : '', m ? `${m} modified` : ''].filter(Boolean).join(' · ');
            const misLbl = mis ? ` _(incl. ${mis} mission${mis === 1 ? '' : 's'})_` : '';
            lines.push(`• <${url}|${name}> (${id}) — ${cnt} entit${cnt === 1 ? 'y' : 'ies'}: ${tally}${misLbl}`);
        });
        if (arr.length > CAP) lines.push(`…and ${arr.length - CAP} more site(s).`);
        return lines.join('\n');
    }

    // Per-site monospace detail tables, chunked under Slack's per-message limit.
    function buildThreadChunks(sites) {
        const LIMIT = 3500;
        const ROWCAP = 60;       // cap rows shown per site (full detail always in the CSV)
        const chunks = [];
        let buf = '';
        const flush = () => { if (buf) { chunks.push('```\n' + buf.replace(/\n$/, '') + '\n```'); buf = ''; } };
        const arr = orderedSites(sites);   // same order as the parent list
        for (const [id, s] of arr) {
            const head = `${s.name || '(unnamed)'} (${id})\n`;
            const ents = [...s.ents.values()].sort((x, y) => x.change.localeCompare(y.change));
            const lines = [];
            ents.slice(0, ROWCAP).forEach(e => {
                let detail;
                if (e.change === 'added') detail = e.mission ? '(new mission)' : '(new entity)';
                else if (e.change === 'removed') detail = e.mission ? '(deleted)' : '(removed)';
                else if (e.mission && e.tuples.length) {
                    // Missions show the actual old → new values, not just field names.
                    detail = e.tuples.slice(0, 6).map(t => `${missionFieldLabel(t.field)} ${t.was || '∅'}→${t.is || '∅'}`).join(' · ')
                        + (e.tuples.length > 6 ? ` +${e.tuples.length - 6}` : '');
                } else {
                    const fl = [...e.fields];
                    detail = fl.length ? (fl.length + ' field' + (fl.length === 1 ? '' : 's') + ': ' + fl.slice(0, 6).join(', ') + (fl.length > 6 ? ` +${fl.length - 6}` : '')) : '(modified)';
                }
                lines.push(`  ${pad(e.change, 9)}${pad(dispType(e.etype), 9)}${pad(String(e.ename || '').slice(0, 24), 26)}${detail}`);
            });
            if (ents.length > ROWCAP) lines.push(`  …and ${ents.length - ROWCAP} more (see changes.csv)`);
            const block = head + lines.join('\n') + '\n\n';
            if (buf.length + block.length > LIMIT) { flush(); }
            // A single huge site still gets its own (possibly oversized) chunk —
            // Slack truncates very long code blocks but the rows are capped anyway.
            buf += block;
        }
        flush();
        return chunks;
    }

    // Post a digest for all changes since `sinceISO`. Returns:
    //   'posted' — parent went out (thread is best-effort after that)
    //   'empty'  — no changes in the window (silent day; window may still close)
    //   'failed' — couldn't read the CSV or the parent post failed (do NOT
    //              advance the cutoff; the caller retries later)
    async function postDigest(sinceISO, dayLabel) {
        if (!slackEnabled()) { console.warn(TAG, 'digest: Slack not configured'); return 'failed'; }
        let rows;
        try { rows = await fetchChangesSince(sinceISO); }
        catch (e) { console.warn(TAG, 'digest: changes.csv read failed', e); return 'failed'; }
        if (!rows.length) { console.log(`${TAG} digest: no changes since ${sinceISO || '(start)'} — staying silent`); return 'empty'; }
        const sites = rollup(rows);
        const nowISO = new Date().toISOString();
        const parentTs = await slackPost(buildParent(sites, dayLabel, sinceISO, nowISO));
        if (!parentTs) { console.warn(TAG, 'digest: parent post failed — not advancing cutoff, will retry'); return 'failed'; }
        const chunks = buildThreadChunks(sites);
        let chunkFails = 0;
        for (const ch of chunks) { if (!await slackPost(ch, parentTs)) chunkFails++; await sleep(400); }
        console.log(`%c${TAG} digest posted — ${sites.size} site(s), ${rows.length} change row(s), ${chunks.length} thread message(s)${chunkFails ? ` · ${chunkFails} thread post(s) failed` : ''}`, 'color:#5fd0ff;font-weight:700');
        return 'posted';
    }

    // Fire the daily digest once the PT boundary passes. Cheap when not firing
    // (pure GM/clock checks); only the leader tab posts. Guarded against reentry.
    async function maybeDailyDigest(trigger) {
        if (!masterEnabled || !cachedToken || digestRunning) return;
        if (!slackEnabled()) return;
        if (Date.now() < digestRetryAfter) return;     // backing off after a failure
        const target = targetDigestDay();
        const lastDay = gmGet(DIGEST_DAY_KEY, null);
        // First ever: baseline silently so we never dump the whole historical CSV.
        if (!lastDay) { gmSet(DIGEST_DAY_KEY, target); gmSet(DIGEST_AT_KEY, new Date().toISOString()); return; }
        if (lastDay >= target) return;                 // already posted this boundary
        digestRunning = true;
        try {
            const since = gmGet(DIGEST_AT_KEY, '') || '';
            const status = await postDigest(since, target);
            if (status === 'failed') {
                // Don't advance the cutoff — that span is unreported. Back off so a
                // hard failure (Slack down / bad token) retries every ~10 min, not
                // every 30s heartbeat.
                digestRetryAfter = Date.now() + 10 * 60 * 1000;
                console.warn(`${TAG} daily digest failed (${trigger}) — retry in ~10 min`);
                return;
            }
            // 'posted' or 'empty': close the window so the next digest doesn't
            // re-report the same span (silent days still advance).
            digestRetryAfter = 0;
            gmSet(DIGEST_DAY_KEY, target);
            gmSet(DIGEST_AT_KEY, new Date().toISOString());
            if (status === 'posted') console.log(`${TAG} daily digest complete (${trigger})`);
        } catch (e) { console.error(TAG, 'maybeDailyDigest error', e); }
        finally { digestRunning = false; }
    }

    // Live status: HOT sites (recently changed) highlighted in orange up top —
    // those are the ones you care about — and the quiet cold majority tucked
    // into a collapsed table. console.table can't color cells, so HOT rows are
    // rendered as individual colored lines.
    function showStatus() {
        const ids = Object.keys(state.sites);
        const mk = id => {
            const st = state.sites[id];
            return {
                site: id,
                name: nameFor(id) || '',
                lastChecked: st.lastCheckAt ? new Date(st.lastCheckAt).toLocaleString() : '(baseline)',
                nextDue: st.nextCheckAt ? new Date(st.nextCheckAt).toLocaleString() : '',
                snapshots: st.slot || 0,
            };
        };
        const byId = (a, b) => a.site.localeCompare(b.site, undefined, { numeric: true });
        const hot = ids.filter(id => state.sites[id].state === 'hot').map(mk).sort(byId);
        const cold = ids.filter(id => state.sites[id].state !== 'hot').map(mk).sort(byId);
        const dueNow = ids.filter(id => (state.sites[id].nextCheckAt || 0) <= Date.now()).length;
        console.log(
            `%c${TAG} STATUS — ${ids.length}/${siteList.length} checked · %c${hot.length} HOT%c · ${cold.length} cold · ${dueNow} due now · paused=${pausedForAuth} · leader=${amLeader}`,
            'color:#5fd0ff;font-weight:700', 'color:#ff8c42;font-weight:800', 'color:#5fd0ff;font-weight:700'
        );
        if (hot.length) {
            console.log(`%c🔥 HOT (${hot.length}) — recently changed, re-checked every ${cfg.hotHours}h:`, 'color:#ff8c42;font-weight:800');
            hot.forEach(r => console.log(
                `%c   ${r.name} (${r.site})%c  last ${r.lastChecked} · next ${r.nextDue} · ${r.snapshots} snap`,
                'color:#ffb37a;font-weight:700', 'color:#9aa0a6'
            ));
        }
        try { console.groupCollapsed(`%c   cold (${cold.length}) — click to expand`, 'color:#8a8f98'); console.table(cold); console.groupEnd(); }
        catch (e) { console.table(cold); }
        return { hot, cold };
    }

    const RESULT_COLOR = {
        baseline: '#5fd0ff',   // cyan — first-time baseline
        checked:  '#8a8f98',   // gray — unchanged
        changed:  '#ffd24a',   // yellow — something changed (attention)
        error:    '#ff6b6b',   // red — fetch failed / missed
        auth:     '#ff9f43',   // orange — auth-paused
    };
    function siteSetupUrl(id) { return `${location.origin}/#/site/${id}/control-panel/site-setup`; }
    function siteJsonUrl(id) { return `${location.origin}/map_objects/?getPoiMapObjectsAsList=true&site_id=${id}`; }
    // Rich per-site console line: progress (batch + running total), site name,
    // id, colored result. Changed/error lines also append clickable URLs (passed
    // as separate args so DevTools linkifies them).
    function siteMissionsUrl(id) { return `${location.origin}/available_app/?site_id=${id}&type=1`; }
    function logSiteResult(i, batchLen, s, res, source) {
        const id = s.id;
        const name = nameFor(id) || s.name || '(unnamed)';
        const c = RESULT_COLOR[res] || '#cccccc';
        const tag = source === 'mission' ? ' [missions]' : '';
        const prog = `${i}/${batchLen}`;
        const line = `%c(${prog})%c ${name} %c(${id})${tag}%c → ${res}`;
        const styles = [
            'color:#9aa0a6',
            'color:#e6e6e6;font-weight:600',
            'color:#9aa0a6',
            `color:${c};font-weight:700`,
        ];
        if (res === 'changed' || res === 'error') {
            const link = source === 'mission' ? ['\n   missions →', siteMissionsUrl(id)] : ['\n   setup →', siteSetupUrl(id), '\n   json →', siteJsonUrl(id)];
            console.log(line, ...styles, ...link);
        } else {
            console.log(line, ...styles);
        }
    }

    // Returns 'auth' | 'error' | 'baseline' | 'checked' | 'changed'
    async function checkSite(s, pendingCsv) {
        const id = s.id;
        const r = await fetchSiteSetup(id);
        if (r.authLost) return 'auth';
        if (r.error) {
            console.warn(TAG, `site ${id} fetch ${r.error}`, r.status || '');
            const st = state.sites[id];
            if (st) scheduleNext(st, 'cold');     // back off; don't hammer a flaky endpoint
            return 'error';
        }
        const cleaned = stripVolatile(r.data);      // drop live drone telemetry before hashing/diffing
        const norm = stableStringify(cleaned);
        const hash = await sha256Hex(norm);
        let st = state.sites[id];

        if (!st) {
            // First sight — record baseline only, no diff, no alert.
            st = state.sites[id] = { hash, state: 'cold', lastChangeAt: 0, lastCheckAt: Date.now(), nextCheckAt: 0 };
            try {
                const gz = bytesToB64(await gzipToBytes(norm));
                await ghPut(latestPath(id), gz, `[site-watch] baseline site ${id}`, await safeGetSha(latestPath(id)));
            } catch (e) { console.error(TAG, `baseline commit site ${id} failed`, e); }
            scheduleNext(st, 'cold');
            return 'baseline';
        }

        st.lastCheckAt = Date.now();

        if (hash === st.hash) {
            if (st.state === 'hot' && (Date.now() - (st.lastChangeAt || 0)) >= cfg.hotWindowHours * 3600e3) {
                st.state = 'cold';
                console.log(`${TAG} site ${id} demoted to COLD (quiet ${cfg.hotWindowHours}h)`);
            }
            scheduleNext(st, st.state);
            return 'checked';
        }

        // CHANGED — diff against the previous snapshot from GitHub.
        console.log(`${TAG} site ${id} CHANGED`);
        let prevData = null;
        try {
            const meta = await ghGetMeta(latestPath(id));
            if (meta) prevData = JSON.parse(await gunzipFromBytes(b64ToBytes(meta.base64)));
        } catch (e) { console.warn(TAG, `site ${id} could not load previous snapshot for diff`, e); }

        const ts = new Date().toISOString();
        const nm = nameFor(id) || s.name || '';
        if (prevData) {
            const rows = diffObjects(extractList(stripVolatile(prevData)), extractList(cleaned));
            if (rows.length) {
                for (const row of rows) pendingCsv.push(csvRow([ts, id, nm, row.change, row.etype, row.ename, row.objectId, row.field, row.was, row.is]));
            } else {
                // Hash moved but no meaningful field diff — a derived/noise field (id, distance, coords mirror) or a key reorder.
                pendingCsv.push(csvRow([ts, id, nm, 'modified', '', '', '', '(non-structural change)', '', '']));
            }
            console.log(`${TAG} site ${id}: ${rows.length} field change(s)`);
        } else {
            pendingCsv.push(csvRow([ts, id, nm, 'modified', '', '', '', '(changed; no prior snapshot)', '', '']));
        }

        // Store new snapshot: overwrite latest + push into the 10-deep ring.
        try {
            const gz = bytesToB64(await gzipToBytes(norm));
            await ghPut(latestPath(id), gz, `[site-watch] update latest site ${id}`, await safeGetSha(latestPath(id)));
            const slot = ((st.slot || 0) % 10) + 1;     // 1..10 rotating
            st.slot = slot;
            const sp = snapPath(id, slot);
            await ghPut(sp, gz, `[site-watch] snapshot site ${id} ${ts}`, await safeGetSha(sp));
        } catch (e) { console.error(TAG, `site ${id} snapshot commit failed`, e); }

        st.hash = hash;
        st.state = 'hot';
        st.lastChangeAt = Date.now();
        scheduleNext(st, 'hot');
        return 'changed';
    }

    // Mission source — same lifecycle as checkSite, against state.missions and
    // the fingerprint snapshots. Returns 'auth'|'error'|'baseline'|'checked'|'changed'.
    async function checkMissions(s, pendingCsv) {
        const id = s.id;
        const r = await fetchMissions(id);
        if (r.authLost) return 'auth';
        if (r.error) {
            console.warn(TAG, `site ${id} missions fetch ${r.error}`, r.status || '');
            const st = state.missions[id];
            if (st) scheduleNext(st, 'cold');
            return 'error';
        }
        const fps = missionFingerprints(r.data);    // whitelist fingerprint — the ONLY signal
        const norm = stableStringify(fps);
        const hash = await sha256Hex(norm);
        let st = state.missions[id];

        if (!st) {
            st = state.missions[id] = { hash, state: 'cold', lastChangeAt: 0, lastCheckAt: Date.now(), nextCheckAt: 0 };
            try {
                const gz = bytesToB64(await gzipToBytes(norm));
                await ghPut(mLatestPath(id), gz, `[site-watch] baseline missions ${id}`, await safeGetSha(mLatestPath(id)));
            } catch (e) { console.error(TAG, `mission baseline commit site ${id} failed`, e); }
            scheduleNext(st, 'cold');
            return 'baseline';
        }

        st.lastCheckAt = Date.now();

        if (hash === st.hash) {
            if (st.state === 'hot' && (Date.now() - (st.lastChangeAt || 0)) >= cfg.hotWindowHours * 3600e3) {
                st.state = 'cold';
                console.log(`${TAG} site ${id} missions demoted to COLD (quiet ${cfg.hotWindowHours}h)`);
            }
            scheduleNext(st, st.state);
            return 'checked';
        }

        console.log(`${TAG} site ${id} MISSIONS CHANGED`);
        let prevFPs = null;
        try {
            const meta = await ghGetMeta(mLatestPath(id));
            if (meta) prevFPs = JSON.parse(await gunzipFromBytes(b64ToBytes(meta.base64)));
        } catch (e) { console.warn(TAG, `site ${id} could not load previous mission snapshot`, e); }

        const ts = new Date().toISOString();
        const nm = nameFor(id) || s.name || '';
        if (prevFPs) {
            const rows = diffMissions(prevFPs, fps);
            if (rows.length) {
                for (const row of rows) pendingCsv.push(csvRow([ts, id, nm, row.change, row.etype, row.ename, row.objectId, row.field, row.was, row.is]));
            } else {
                pendingCsv.push(csvRow([ts, id, nm, 'modified', 'mission', '', '', '(non-structural change)', '', '']));
            }
            console.log(`${TAG} site ${id}: ${rows.length} mission change(s)`);
        } else {
            pendingCsv.push(csvRow([ts, id, nm, 'modified', 'mission', '', '', '(changed; no prior snapshot)', '', '']));
        }

        try {
            const gz = bytesToB64(await gzipToBytes(norm));
            await ghPut(mLatestPath(id), gz, `[site-watch] update missions ${id}`, await safeGetSha(mLatestPath(id)));
            const slot = ((st.slot || 0) % 10) + 1;
            st.slot = slot;
            const sp = mSnapPath(id, slot);
            await ghPut(sp, gz, `[site-watch] mission snapshot site ${id} ${ts}`, await safeGetSha(sp));
        } catch (e) { console.error(TAG, `site ${id} mission snapshot commit failed`, e); }

        st.hash = hash;
        st.state = 'hot';
        st.lastChangeAt = Date.now();
        scheduleNext(st, 'hot');
        return 'changed';
    }

    async function runCycle(trigger) {
        if (!masterEnabled) return;
        if (cycleRunning) return;
        if (!cachedToken) { console.warn(`${TAG} no GitHub token yet — open the Control Panel and save your PAT`); return; }
        if (!claimLeader()) { console.log(`${TAG} another tab is the active watcher — standing by (use "Check all due now" to take over)`); return; }
        cycleRunning = true;
        try {
            const now = Date.now();
            if (!siteList.length || (now - siteListFetchedAt) > cfg.siteListRefreshHours * 3600e3) {
                const list = await fetchSiteList();
                if (list && list.length) {
                    siteList = list; siteListFetchedAt = now; persistMeta();
                    console.log(`${TAG} site list: ${siteList.length} sites`);
                } else if (!siteList.length) {
                    console.warn(TAG, 'no sites discovered yet — will retry next wake');
                    return;
                }
            }
            if (pausedForAuth) {
                const probe = siteList[0];
                const pr = probe ? await fetchSiteSetup(probe.id) : { authLost: true };
                if (pr.authLost) { console.log(`${TAG} still logged out — staying paused`); return; }
                pausedForAuth = false;
                console.log(`${TAG} auth restored — resuming`);
            }

            // Build a combined due list of (site, source) tasks. Setup always
            // runs; missions only when the toggle is on. Both share the one
            // maxPerCycle budget, sorted by whichever is most overdue.
            const tasks = [];
            for (const s of siteList) {
                const su = state.sites[s.id];
                if (!su || (su.nextCheckAt || 0) <= now) tasks.push({ s, source: 'setup', due: su ? (su.nextCheckAt || 0) : 0 });
                if (cfg.watchMissions) {
                    const mu = state.missions[s.id];
                    if (!mu || (mu.nextCheckAt || 0) <= now) tasks.push({ s, source: 'mission', due: mu ? (mu.nextCheckAt || 0) : 0 });
                }
            }
            tasks.sort((a, b) => a.due - b.due);
            const batch = tasks.slice(0, cfg.maxPerCycle);
            if (!batch.length) return;
            const hotCount = Object.values(state.sites).filter(st => st.state === 'hot').length
                + (cfg.watchMissions ? Object.values(state.missions).filter(st => st.state === 'hot').length : 0);
            const sourcesLbl = cfg.watchMissions ? 'setup+missions' : 'setup';
            console.log(`%c${TAG} cycle (${trigger}): ${batch.length} of ${tasks.length} due tasks (${sourcesLbl}) · ${siteList.length} sites · ${hotCount} HOT`, 'color:#5fd0ff;font-weight:600');

            const pendingCsv = [];
            let checked = 0;
            let changed = 0;
            let i = 0;
            for (const t of batch) {
                if (pausedForAuth) break;
                renewLeader();
                const res = t.source === 'mission' ? await checkMissions(t.s, pendingCsv) : await checkSite(t.s, pendingCsv);
                i++;
                if (res === 'auth') { pauseForAuth('cycle'); break; }
                if (res === 'changed') changed++;
                if (res === 'changed' || res === 'checked' || res === 'baseline') checked++;
                logSiteResult(i, batch.length, t.s, res, t.source);
                await sleep(cfg.throttleMs);
            }
            if (pendingCsv.length) {
                try { await appendCsvRows(pendingCsv, `[site-watch] ${pendingCsv.length} change row(s)`); }
                catch (e) { console.error(TAG, 'CSV append failed', e); }
            }
            persistState();
            const doneAt = Date.now();
            let stillDue = 0;
            for (const s of siteList) {
                const su = state.sites[s.id];
                if (!su || (su.nextCheckAt || 0) <= doneAt) stillDue++;
                if (cfg.watchMissions) { const mu = state.missions[s.id]; if (!mu || (mu.nextCheckAt || 0) <= doneAt) stillDue++; }
            }
            const tail = stillDue > 0
                ? `${stillDue} still due — next batch in ~${Math.round(WAKE_MS / 60000)} min (or click "Check all due now")`
                : `all ${siteList.length} sites baselined — now watching on the adaptive schedule`;
            console.log(`%c${TAG} cycle done: ${checked} checked, ${changed} changed · ${tail}`, 'color:#5fd0ff;font-weight:600');
            await maybeDailyDigest('cycle');
        } catch (e) {
            console.error(TAG, 'cycle error', e);
        } finally {
            cycleRunning = false;
        }
    }

    // =====================================================================
    // Control Panel integration
    // =====================================================================
    const TOGGLES = [
        { id: 'master', label: 'Enable Site Watch', type: 'boolean', default: false, master: true },
        { id: 'coldHours', label: 'Quiet check interval (hours)', type: 'number', default: DEFAULTS.coldHours, min: 1, max: 168, step: 1 },
        { id: 'hotHours', label: 'Active check interval (hours)', type: 'number', default: DEFAULTS.hotHours, min: 1, max: 24, step: 1 },
        { id: 'hotWindowHours', label: 'Stay-active window after a change (hours)', type: 'number', default: DEFAULTS.hotWindowHours, min: 3, max: 168, step: 1 },
        { id: 'digestHourPT', label: 'Daily Slack digest hour (PT, 24h)', type: 'number', default: DEFAULTS.digestHourPT, min: 0, max: 23, step: 1 },
        { id: 'watchMissions', label: 'Also watch missions (steps · distance · values)', type: 'boolean', default: DEFAULTS.watchMissions },
        { id: 'check-now', label: 'Check all due now', type: 'button', action: 'check-now' },
        { id: 'status', label: 'Show status (console)', type: 'button', action: 'status' },
        { id: 'post-digest-now', label: 'Post Slack digest now (last 24h, test)', type: 'button', action: 'post-digest-now' },
        { id: 'reset-baselines', label: 'Reset all baselines (re-learn)', type: 'button', action: 'reset-baselines' },
    ];

    function registerWithControlPanel() {
        if (!controlChannel) return;
        try {
            controlChannel.postMessage({
                type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Site Watch', version: SCRIPT_VERSION,
                toggles: TOGGLES, hotkeys: [],
            });
        } catch (e) { console.warn(TAG, 'register failed', e); }
    }
    function handleSetToggle(msg) {
        const id = msg.toggleId;
        const val = (msg.value !== undefined ? msg.value : msg.enabled);
        if (id === 'master') {
            const on = !!val;
            if (on === masterEnabled) return;       // idempotent (panel runs in top + iframe)
            masterEnabled = on;
            gmSet(MASTER_KEY, masterEnabled);
            console.log(`${TAG} master ${masterEnabled ? 'ENABLED' : 'disabled'}`);
            if (masterEnabled) runCycle('enable');
            return;
        }
        if (id === 'coldHours' || id === 'hotHours' || id === 'hotWindowHours') {
            const n = Number(val);
            if (!isFinite(n) || n <= 0) return;
            if (cfg[id] === n) return;              // idempotent
            cfg[id] = n;
            saveConfig();
            console.log(`${TAG} ${id} = ${n}`);
        }
        if (id === 'digestHourPT') {
            const n = Number(val);
            if (!isFinite(n) || n < 0 || n > 23) return;
            if (cfg.digestHourPT === n) return;     // idempotent
            cfg.digestHourPT = n;
            saveConfig();
            console.log(`${TAG} digestHourPT = ${n} (PT)`);
        }
        if (id === 'watchMissions') {
            const on = !!val;
            if (cfg.watchMissions === on) return;   // idempotent (panel runs top + iframe)
            cfg.watchMissions = on;
            saveConfig();
            console.log(`${TAG} watchMissions ${on ? 'ENABLED — missions will baseline over the next cycles' : 'disabled'}`);
            if (on && masterEnabled && cachedToken) runCycle('missions-on');
        }
    }
    function handleAction(actionId) {
        if (actionId === 'check-now') { console.log(`${TAG} manual check requested`); stealLeader(); runCycle('manual'); }
        else if (actionId === 'status') { showStatus(); }
        else if (actionId === 'post-digest-now') {
            // Test/preview: post a digest of the last 24h WITHOUT touching the
            // daily schedule cutoff, so it never interferes with the real 6pm run.
            if (digestRunning) { console.warn(TAG, 'a digest is already in progress — ignoring manual request'); return; }
            (async () => {
                if (!slackEnabled()) { await fetchSlackConfig(); }
                if (!slackEnabled()) { console.warn(TAG, 'digest: Slack not configured (slack-config.json) — cannot post'); return; }
                digestRunning = true;
                try {
                    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
                    console.log(`${TAG} manual digest preview — changes since ${since}`);
                    await postDigest(since, ptParts().day);
                } catch (e) { console.error(TAG, 'manual digest error', e); }
                finally { digestRunning = false; }
            })();
        } else if (actionId === 'reset-baselines') {
            if (!confirm('Reset ALL site baselines? Next checks re-learn current state (no diffs until something changes again).')) return;
            doResetBaselines('user');
            // Tell every other tab (esp. the leader) to clear too, so its stale
            // in-memory state can't overwrite the reset on its next cycle.
            try { if (controlChannel) controlChannel.postMessage({ type: 'SW_RESET_SYNC', scriptId: SCRIPT_ID, from: tabId }); } catch (e) { console.warn(TAG, 'reset broadcast', e); }
        }
    }
    function doResetBaselines(reason) {
        state = { sites: {}, missions: {} };
        persistState();
        console.log(`${TAG} baselines reset (${reason})`);
    }
    function handleTokenValue(token) {
        const prev = cachedToken;
        cachedToken = token || '';
        if (cachedToken === prev) return;
        gmSet(TOKEN_KEY, cachedToken);
        if (cachedToken) fetchSlackConfig();
        if (cachedToken && masterEnabled) runCycle('token');
    }
    function setupControlChannel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { console.warn(TAG, 'control channel unavailable', e); return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) handleSetToggle(msg);
            else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === SCRIPT_ID) handleAction(msg.actionId);
            else if (msg.type === 'SW_RESET_SYNC' && msg.scriptId === SCRIPT_ID && msg.from !== tabId) doResetBaselines('synced from another tab');
            else if (msg.type === 'TOKEN_VALUE') handleTokenValue(msg.token || '');
        };
    }

    // =====================================================================
    // Boot
    // =====================================================================
    loadConfig();
    masterEnabled = gmGet(MASTER_KEY, false) === true;
    (function restoreMeta() {
        const m = gmGet(META_KEY, null);
        if (m && Array.isArray(m.siteList)) { siteList = m.siteList; siteListFetchedAt = m.siteListFetchedAt || 0; }
    })();
    setupControlChannel();
    registerWithControlPanel();
    if (cachedToken) fetchSlackConfig();        // load bot config for the daily digest
    console.log(`${TAG} v${SCRIPT_VERSION} ready (master ${masterEnabled ? 'ON' : 'OFF'})`);

    setInterval(() => runCycle('wake'), WAKE_MS);
    setTimeout(() => runCycle('startup-catchup'), STARTUP_CATCHUP_MS);

    // Leader heartbeat: hold the lease if we're leader, else try to claim a
    // stale one (so a vanished leader is replaced within ~LEASE_TTL).
    setInterval(() => {
        if (!masterEnabled || !cachedToken) return;
        if (amLeader) renewLeader();
        else claimLeader();
        // Only the leader posts; the day-boundary check inside is cheap and
        // idempotent, so firing it every heartbeat catches the 6pm boundary even
        // on a quiet day where no sites are due and runCycle returns early.
        if (amLeader) maybeDailyDigest('heartbeat');
    }, HEARTBEAT_MS);
    // Free the lease on refresh/close so the next load takes over immediately.
    window.addEventListener('pagehide', releaseLeader);
})();
