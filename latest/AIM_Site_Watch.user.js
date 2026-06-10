// ==UserScript==
// @name         Latest - AIM Site Watch
// @namespace    http://tampermonkey.net/
// @version      0.9
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Watch.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Watch.user.js
// @description  Personal background auditor. Polls every Percepto site's setup JSON on an ADAPTIVE schedule (daily when quiet, every few hours after a change) and records what changed: a running field-level diff CSV plus a rotating gzip snapshot history, committed to the private aim-userscripts-data repo. Configurable in the AIM Control Panel ("Site Watch").
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @connect      api.github.com
// @connect      hooks.slack.com
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

    const TAG = '[AIM WATCH]';
    const IS_TOP = (window === window.top);

    // TOP frame only. The react-pages iframe (also @match'd) does nothing —
    // fetches are same-origin from top, and gating here avoids a top/iframe
    // double-runner inside a single tab.
    if (!IS_TOP) return;

    // ---- identity / channel ----
    const SCRIPT_ID = 'aim-site-watch';
    const SCRIPT_VERSION = '0.9';
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
    const SLACK_KEY = 'aim-site-watch-slack-webhook';
    const LEADER_KEY = 'aim-site-watch-leader';

    // ---- tunables ----
    const DEFAULTS = {
        coldHours: 24,
        hotHours: 3,
        hotWindowHours: 24,
        throttleMs: 1000,       // delay between sites — gentle on Percepto + GitHub secondary write limits
        maxPerCycle: 25,        // sites processed per wake — bounds burst + first-run baselining
        siteListRefreshHours: 24,
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
    let slackWebhook = gmGet(SLACK_KEY, '') || '';
    const tabId = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now();
    let amLeader = false;
    let pausedForAuth = false;
    let cycleRunning = false;
    let siteList = [];          // [{id, name}]
    let siteListFetchedAt = 0;
    let state = loadState();    // { sites: { [id]: {hash, state, lastChangeAt, lastCheckAt, nextCheckAt, slot} } }

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
        return (s && s.sites) ? s : { sites: {} };
    }
    function persistState() { gmSet(STATE_KEY, state); }
    function persistMeta() { gmSet(META_KEY, { siteListFetchedAt, siteList }); }
    function saveConfig() {
        gmSet(CONFIG_KEY, { coldHours: cfg.coldHours, hotHours: cfg.hotHours, hotWindowHours: cfg.hotWindowHours });
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
    // CSV append: re-reads fresh content each attempt so concurrent appends
    // never drop rows.
    async function appendCsvRows(rowStrings, message) {
        if (!rowStrings.length) return;
        for (let attempt = 0; attempt < 3; attempt++) {
            const meta = await ghGetMeta(CSV_PATH);
            let content;
            if (!meta) {
                content = CSV_HEADER + '\n';
            } else {
                const existing = b64ToText(meta.base64);
                const firstLine = (existing.split('\n', 1)[0] || '');
                // If the column schema changed (older 8-col header), start a fresh
                // file with the new header rather than producing ragged rows.
                if (firstLine === CSV_HEADER) content = existing.endsWith('\n') ? existing : existing + '\n';
                else content = CSV_HEADER + '\n';
            }
            content += rowStrings.join('\n') + '\n';
            const url = `${GITHUB_API_BASE}/repos/${DATA_REPO}/contents/${ghPath(CSV_PATH)}`;
            const body = { message, content: textToB64(content), branch: DATA_BRANCH };
            if (meta && meta.sha) body.sha = meta.sha;
            const resp = await ghRequest({ method: 'PUT', url, headers: ghHeaders(true), data: JSON.stringify(body), timeout: 30000 });
            if (resp.status === 200 || resp.status === 201) return;
            if (resp.status === 409 || resp.status === 422) continue;   // conflict → re-GET fresh and re-append
            throw new Error(`CSV PUT HTTP ${resp.status}`);
        }
        throw new Error('CSV PUT failed after retries');
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
    const TYPE_SHORT = { 3: 'Asset', 4: 'NFZ', 15: 'FP', 16: 'FFZ', 19: 'Marker' };
    function typeShort(t) { return TYPE_SHORT[t] != null ? TYPE_SHORT[t] : ('type' + t); }
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
    // Scheduler
    // =====================================================================
    function nameFor(id) {
        const s = siteList.find(x => x.id === id);
        return s ? (s.name || '') : '';
    }
    function latestPath(id) { return `${WATCH_DIR}/${id}/latest.json.gz`; }
    function snapPath(id, slot) { return `${WATCH_DIR}/${id}/snap-${String(slot).padStart(3, '0')}.json.gz`; }
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

    function notifySlack(id, name) {
        if (!slackWebhook) return;
        try {
            const txt = `:satellite: Site setup changed — ${name ? name + ' ' : ''}(site ${id}). See ${CSV_PATH}.`;
            GM_xmlhttpRequest({
                method: 'POST', url: slackWebhook,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ text: txt }),
                onload: () => {}, onerror: (e) => console.warn(TAG, 'slack notify failed', e),
            });
        } catch (e) { console.warn(TAG, 'slack notify error', e); }
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
    function logSiteResult(i, batchLen, s, res) {
        const id = s.id;
        const name = nameFor(id) || s.name || '(unnamed)';
        const c = RESULT_COLOR[res] || '#cccccc';
        // Batch position always; a running "done/total" only WHILE the sweep is
        // still climbing (e.g. baselining) — drop it once fully baselined so it
        // doesn't pin at the saturated 443/443.
        const done = Object.keys(state.sites).length;
        const total = siteList.length;
        const prog = (total && done < total) ? `${i}/${batchLen} · ${done}/${total}` : `${i}/${batchLen}`;
        const line = `%c(${prog})%c ${name} %c(${id})%c → ${res}`;
        const styles = [
            'color:#9aa0a6',
            'color:#e6e6e6;font-weight:600',
            'color:#9aa0a6',
            `color:${c};font-weight:700`,
        ];
        if (res === 'changed' || res === 'error') {
            console.log(line, ...styles, '\n   setup →', siteSetupUrl(id), '\n   json →', siteJsonUrl(id));
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
        notifySlack(id, nm);
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

            const due = siteList.filter(s => {
                const st = state.sites[s.id];
                return !st || (st.nextCheckAt || 0) <= now;
            });
            due.sort((a, b) => ((state.sites[a.id] && state.sites[a.id].nextCheckAt) || 0) - ((state.sites[b.id] && state.sites[b.id].nextCheckAt) || 0));
            const batch = due.slice(0, cfg.maxPerCycle);
            if (!batch.length) return;
            const hotCount = Object.values(state.sites).filter(st => st.state === 'hot').length;
            const baselined = Object.keys(state.sites).length;
            // Show baselining progress only while it's still incomplete; once all
            // sites are baselined that number is saturated, so switch to HOT count.
            const progress = baselined < siteList.length ? ` · ${baselined}/${siteList.length} baselined` : '';
            console.log(`%c${TAG} cycle (${trigger}): checking ${batch.length} of ${due.length} due · ${siteList.length} sites · ${hotCount} HOT${progress}`, 'color:#5fd0ff;font-weight:600');

            const pendingCsv = [];
            let checked = 0;
            let changed = 0;
            let i = 0;
            for (const s of batch) {
                if (pausedForAuth) break;
                renewLeader();
                const res = await checkSite(s, pendingCsv);
                i++;
                if (res === 'auth') { pauseForAuth('cycle'); break; }
                if (res === 'changed') changed++;
                if (res === 'changed' || res === 'checked' || res === 'baseline') checked++;
                logSiteResult(i, batch.length, s, res);
                await sleep(cfg.throttleMs);
            }
            if (pendingCsv.length) {
                try { await appendCsvRows(pendingCsv, `[site-watch] ${pendingCsv.length} change row(s)`); }
                catch (e) { console.error(TAG, 'CSV append failed', e); }
            }
            persistState();
            const stillDue = siteList.filter(s => { const st = state.sites[s.id]; return !st || (st.nextCheckAt || 0) <= Date.now(); }).length;
            const tail = stillDue > 0
                ? `${stillDue} still due — next batch in ~${Math.round(WAKE_MS / 60000)} min (or click "Check all due now")`
                : `all ${siteList.length} sites baselined — now watching on the adaptive schedule`;
            console.log(`%c${TAG} cycle done: ${checked} checked, ${changed} changed · ${tail}`, 'color:#5fd0ff;font-weight:600');
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
        { id: 'check-now', label: 'Check all due now', type: 'button', action: 'check-now' },
        { id: 'status', label: 'Show status (console)', type: 'button', action: 'status' },
        { id: 'set-slack', label: 'Set Slack webhook…', type: 'button', action: 'set-slack' },
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
    }
    function handleAction(actionId) {
        if (actionId === 'check-now') { console.log(`${TAG} manual check requested`); stealLeader(); runCycle('manual'); }
        else if (actionId === 'status') { showStatus(); }
        else if (actionId === 'set-slack') {
            const v = prompt('Slack incoming-webhook URL (leave blank to clear):', slackWebhook || '');
            if (v === null) return;
            slackWebhook = v.trim();
            gmSet(SLACK_KEY, slackWebhook);
            console.log(`${TAG} slack webhook ${slackWebhook ? 'set' : 'cleared'}`);
        } else if (actionId === 'reset-baselines') {
            if (!confirm('Reset ALL site baselines? Next checks re-learn current state (no diffs until something changes again).')) return;
            doResetBaselines('user');
            // Tell every other tab (esp. the leader) to clear too, so its stale
            // in-memory state can't overwrite the reset on its next cycle.
            try { if (controlChannel) controlChannel.postMessage({ type: 'SW_RESET_SYNC', scriptId: SCRIPT_ID, from: tabId }); } catch (e) { console.warn(TAG, 'reset broadcast', e); }
        }
    }
    function doResetBaselines(reason) {
        state = { sites: {} };
        persistState();
        console.log(`${TAG} baselines reset (${reason})`);
    }
    function handleTokenValue(token) {
        const prev = cachedToken;
        cachedToken = token || '';
        if (cachedToken === prev) return;
        gmSet(TOKEN_KEY, cachedToken);
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
    console.log(`${TAG} v${SCRIPT_VERSION} ready (master ${masterEnabled ? 'ON' : 'OFF'})`);

    setInterval(() => runCycle('wake'), WAKE_MS);
    setTimeout(() => runCycle('startup-catchup'), STARTUP_CATCHUP_MS);

    // Leader heartbeat: hold the lease if we're leader, else try to claim a
    // stale one (so a vanished leader is replaced within ~LEASE_TTL).
    setInterval(() => {
        if (!masterEnabled || !cachedToken) return;
        if (amLeader) renewLeader();
        else claimLeader();
    }, HEARTBEAT_MS);
    // Free the lease on refresh/close so the next load takes over immediately.
    window.addEventListener('pagehide', releaseLeader);
})();
