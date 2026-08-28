// ==UserScript==
// @name         Latest - AIM Site Diff
// @namespace    http://tampermonkey.net/
// @version      0.80
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Diff.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Diff.user.js
// @description  Site comparison suite: shadow-site ghost overlay (per-type show/color/opacity), swipe divider, significant-change diff (→ AIM Issues), and Phase 3a Import — create-only copy of shadow entities (assets etc.) onto the current site with dry-run preview + verify. v0.70: cross-SERVER shadows. v0.80 (#250 layer 2): neighboring-site overlay — shows every other site's FFZs/FPs/assets within a display radius (Site Watch snapshot bboxes prefilter, live /map_objects/ for the math) and flags cross-site conflicts under the threshold (segment-to-segment, default 200 ft).
// @author       Payden
// @match        *://percepto.app/*
// @match        *://qa.percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @match        https://qa.percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      percepto.app
// @connect      qa.percepto.app
// @run-at       document-end
// ==/UserScript==

// AIM Site Diff — compares two sites' Site Setups. Workflow terms: the
// LIVE site is the original (running ops); the OFFLINE site is the rebuilt
// copy from "Duplicate Site with Site Setup". You work ON the Offline site
// and shadow the Live site.
//   Phase 1 — ghost overlay: shadow site's entities draw dashed with
//     per-type show/color/opacity controls.
//   Phase 2 — compare: swipe divider (shadow shows right of the handle) +
//     significant-change diff. Envelope = shadow FFZ polygons + FP segments
//     buffered by the threshold (default 30 ft); stretches of THIS site's
//     FPs (and optionally FFZ perimeters) outside the envelope are
//     highlighted and can be sent to AIM Issues (needs Asset Inspector
//     v4.165+ which unions them into the validator-issue channel).
//   Phase 3a — Import (CSM Full mode): create-only copy of the shadow's
//     entities onto the CURRENT site — per-type checkboxes (assets
//     default-on), dup-name skip, dry-run preview, double-click arm,
//     sequential POST /map_objects/ + fresh-fetch verify + run log.
//   Neighbors (#250 layer 2): overlay every OTHER site's FFZs/FPs/assets
//     within a display radius (default 1000 ft) and flag cross-site
//     conflicts under the threshold (default 200 ft, segment-to-segment).
// No hotkeys. Log tag: [AIM DIFF]

(function () {
    'use strict';

    const TAG = '[AIM DIFF]';
    // Per-tab identity shared across frames via window.top (same-origin).

    // Must match the Control Panel's aimTabId so hotkeys/actions stay tab-local.

    function aimTabId() {

        try {

            const pw = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

            const t = pw.top;

            if (!t.__AIM_TAB_ID) t.__AIM_TAB_ID = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);

            return t.__AIM_TAB_ID;

        } catch (e) { return null; }

    }
    const IS_IFRAME = window !== window.top;

    // --------------------------------------------------------------
    // CSRF sniffer (v0.52) — Percepto's auth cookies are HttpOnly in
    // at least some sessions (live-confirmed 2026-07-27: document.cookie
    // shows ONLY Amplitude cookies in both frames while credentialed
    // fetches still work), so the cookie can never be read directly.
    // Instead, passively watch the app's OWN outgoing fetch/XHR calls
    // for an X-CSRFToken header and bank the value in localStorage
    // (Percepto wipes sessionStorage; localStorage survives). Installed
    // in BOTH frames — the token is the same session-wide.
    // --------------------------------------------------------------
    const CSRF_LS_KEY = 'aim-sd-csrf';

    function stashSniffedCsrf(token, from) {
        if (!token || typeof token !== 'string' || token.length < 16) return;
        try {
            const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const prev = w.localStorage.getItem(CSRF_LS_KEY);
            w.localStorage.setItem(CSRF_LS_KEY, JSON.stringify({ t: token, at: Date.now(), from }));
            if (!prev || JSON.parse(prev).t !== token) console.log(`${TAG} banked CSRF token from a native ${from} request`);
        } catch (e) {}
    }

    function readSniffedCsrf() {
        try {
            const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const raw = w.localStorage.getItem(CSRF_LS_KEY);
            if (!raw) return null;
            const s = JSON.parse(raw);
            if (s && typeof s.t === 'string' && s.t.length >= 16) return s.t;
        } catch (e) {}
        return null;
    }

    function installCsrfSniffer() {
        try {
            const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            if (w.__aimSdCsrfSniffed) return;
            w.__aimSdCsrfSniffed = true;
            const origFetch = w.fetch;
            if (typeof origFetch === 'function') {
                w.fetch = function (input, init) {
                    try {
                        const h = (init && init.headers) || (input && typeof input === 'object' && input.headers) || null;
                        if (h) {
                            if (typeof h.get === 'function') {
                                const v = h.get('X-CSRFToken');
                                if (v) stashSniffedCsrf(v, 'fetch');
                            } else if (typeof h === 'object') {
                                for (const k of Object.keys(h)) {
                                    if (/^x-csrftoken$/i.test(k)) { stashSniffedCsrf(h[k], 'fetch'); break; }
                                }
                            }
                        }
                    } catch (e) {}
                    return origFetch.apply(this, arguments);
                };
            }
            const XHR = w.XMLHttpRequest;
            if (XHR && XHR.prototype && XHR.prototype.setRequestHeader) {
                const origSet = XHR.prototype.setRequestHeader;
                XHR.prototype.setRequestHeader = function (name, value) {
                    try { if (/^x-csrftoken$/i.test(String(name))) stashSniffedCsrf(String(value), 'xhr'); } catch (e) {}
                    return origSet.apply(this, arguments);
                };
            }
            console.log(`${TAG} CSRF sniffer installed (${IS_IFRAME ? 'iframe' : 'top'} frame)`);
        } catch (e) { console.warn(`${TAG} csrf sniffer install failed:`, e); }
    }

    installCsrfSniffer();

    if (!IS_IFRAME) {
        try { console.log(`${TAG} top frame — CSRF sniffer active, otherwise idle (map is in iframe)`); } catch (e) {}
        return;
    }

    const SCRIPT_ID = 'aim-site-diff';
    const SCRIPT_VERSION = '0.80';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const PANE_NAME = 'aim-site-diff-pane';
    const HL_PANE_NAME = 'aim-site-diff-hl';
    const SITE_ID_RE = /#\/site\/(\d+)\//;

    const KEY_MASTER = 'aim-sd-master';
    const KEY_STYLE = 'aim-sd-style';
    const KEY_PAIRS = 'aim-sd-pairs';
    const KEY_SITES_CACHE = 'aim-sd-sites-cache';
    const KEY_DIFF = 'aim-sd-diff';
    const KEY_FILE_PREFIX = 'aim-sd-file-';   // + envSiteKey(siteID) → stored JSON-backup shadow

    // ------------------------------------------------------------------
    // Server model (v0.70). Prod and QA are separate databases — the same
    // numeric site ID can be two different sites. Everything keyed by site
    // ID in GM storage (shared across origins!) uses envSiteKey() so the
    // two servers never share per-site state. Cross-server shadow fetches
    // go through GM_xmlhttpRequest (carries the OTHER domain's cookies and
    // bypasses CORS — needs @connect for both hosts).
    // ------------------------------------------------------------------
    const IS_QA = location.hostname === 'qa.percepto.app' || location.hostname.endsWith('.qa.percepto.app');
    const THIS_SERVER = IS_QA ? 'qa' : 'prod';
    const OTHER_SERVER = IS_QA ? 'prod' : 'qa';
    const SERVER_ORIGINS = { prod: 'https://percepto.app', qa: 'https://qa.percepto.app' };
    const SERVER_LABELS = { prod: 'Prod', qa: 'QA' };
    function envSiteKey(sid) { return IS_QA ? `qa-${sid}` : String(sid); }
    // Data-repo KML files are namespaced the same way: prod = <id>-distro.kml,
    // QA = qa-<id>-distro.kml (must stay in lockstep with Map Styler's naming).
    function kmlEnvPrefix(server) { return server === 'qa' ? 'qa-' : ''; }

    function gmFetchJson(url, ms) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest unavailable — check @grant'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: ms || 20000,
                headers: { 'Accept': 'application/json' },
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' — log into that server in another tab first' : ''}`));
                        return;
                    }
                    try { resolve(JSON.parse(res.responseText)); }
                    catch (e) { reject(new Error('response was not JSON — probably that server\'s login page; log into it in another tab first')); }
                },
                ontimeout: () => reject(new Error('timeout')),
                onerror: () => reject(new Error('network error')),
            });
        });
    }

    console.log(`${TAG} v${SCRIPT_VERSION} loading (server: ${THIS_SERVER})`);

    // Per-type registry. Shadow defaults are deliberately warm/shifted hues so
    // they never read as the native palette (FP cyan / FFZ green / NFZ red).
    const SHADOW_TYPES = [
        { key: 'fp',    type: 15, label: 'Flight Paths',  color: '#ffa030' },
        { key: 'ffz',   type: 16, label: 'Free Fly Zones', color: '#d05fff' },
        { key: 'nfz',   type: 4,  label: 'No Fly Zones',  color: '#ff5252' },
        { key: 'asset', type: 3,  label: 'Assets',        color: '#ffe08a' },
        { key: 'gm',    type: 19, label: 'Markers',       color: '#ff8ac2' },
        { key: 'base',  type: 8,  label: 'Base Stations', color: '#ffd54f' },
        { key: 'safe',  type: 98, label: 'Safe Zones',    color: '#7adfe6' },
    ];
    const TYPE_TO_KEY = {};
    SHADOW_TYPES.forEach(t => { TYPE_TO_KEY[t.type] = t.key; });

    // ------------------------------------------------------------------
    // GM persistence (guarded — @grant without declaration silently no-ops)
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
        console.warn(`${TAG} ⚠ GM_getValue/GM_setValue not available — check @grant directives. Persistence is BROKEN until fixed.`);
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    function defaultStyle() {
        const s = { weight: 2, markerSize: 6, dashed: true, types: {} };
        SHADOW_TYPES.forEach(t => { s.types[t.key] = { show: true, color: t.color, opacity: 0.75 }; });
        return s;
    }
    function loadStyle() {
        const s = defaultStyle();
        try {
            const raw = gmGet(KEY_STYLE, null);
            if (raw) {
                const stored = JSON.parse(raw);
                if (typeof stored.weight === 'number') s.weight = stored.weight;
                if (typeof stored.markerSize === 'number') s.markerSize = stored.markerSize;
                if (typeof stored.dashed === 'boolean') s.dashed = stored.dashed;
                if (stored.types) {
                    SHADOW_TYPES.forEach(t => {
                        const st = stored.types[t.key];
                        if (!st) return;
                        if (typeof st.show === 'boolean') s.types[t.key].show = st.show;
                        if (typeof st.color === 'string') s.types[t.key].color = st.color;
                        if (typeof st.opacity === 'number') s.types[t.key].opacity = st.opacity;
                    });
                }
            }
        } catch (e) { console.warn(`${TAG} loadStyle:`, e); }
        return s;
    }
    function saveStyle() {
        try { gmSet(KEY_STYLE, JSON.stringify(style)); }
        catch (e) { console.warn(`${TAG} saveStyle:`, e); }
    }
    function loadPairs() {
        try {
            const raw = gmGet(KEY_PAIRS, null);
            if (raw) {
                const p = JSON.parse(raw);
                if (p && typeof p === 'object') return p;
            }
        } catch (e) { console.warn(`${TAG} loadPairs:`, e); }
        return {};
    }
    function savePairs() {
        try { gmSet(KEY_PAIRS, JSON.stringify(pairs)); }
        catch (e) { console.warn(`${TAG} savePairs:`, e); }
    }

    function defaultDiffCfg() {
        return {
            thresholdFt: 30, includeFfz: true, color: '#ff2d2d',
            swipe: false, swipeMode: 'split', focus: false, newRouteFt: 300,
        };
    }
    function loadDiffCfg() {
        const d = defaultDiffCfg();
        try {
            const raw = gmGet(KEY_DIFF, null);
            if (raw) {
                const stored = JSON.parse(raw);
                if (typeof stored.thresholdFt === 'number') d.thresholdFt = stored.thresholdFt;
                if (typeof stored.includeFfz === 'boolean') d.includeFfz = stored.includeFfz;
                if (typeof stored.color === 'string') d.color = stored.color;
                if (typeof stored.swipe === 'boolean') d.swipe = stored.swipe;
                if (stored.swipeMode === 'split' || stored.swipeMode === 'overlay') d.swipeMode = stored.swipeMode;
                if (typeof stored.focus === 'boolean') d.focus = stored.focus;
                if (typeof stored.newRouteFt === 'number') d.newRouteFt = stored.newRouteFt;
            }
        } catch (e) { console.warn(`${TAG} loadDiffCfg:`, e); }
        return d;
    }
    function saveDiffCfg() {
        try { gmSet(KEY_DIFF, JSON.stringify(diffCfg)); }
        catch (e) { console.warn(`${TAG} saveDiffCfg:`, e); }
    }

    let masterEnabled = gmGet(KEY_MASTER, false) === true;
    let style = loadStyle();
    let diffCfg = loadDiffCfg();
    let pairs = loadPairs();               // { envSiteKey: '<shadowSiteId>' | {kind:'site', id, server} | {kind:'file', name} }
    const shadowCache = {};                // { cacheKey: { entities, fetchedAt } }
    const sitesListByServer = { prod: null, qa: null };   // server → [{id, name}]
    let siteID = null;
    let controlChannel = null;

    // Shadow source model: a pairs[] value is one of
    //   - a site-id string (pre-v0.70 format = same-server site, kept as-is)
    //   - {kind:'site', id, server:'prod'|'qa'} (v0.70+ — server-explicit)
    //   - {kind:'file', name} for an uploaded /map_objects JSON backup.
    // Pairs are keyed by envSiteKey(siteID) so a prod site and a QA site
    // with the same numeric ID keep independent pairings.
    function shadowSourceFor(sid) {
        const v = sid ? pairs[envSiteKey(sid)] : null;
        if (!v) return null;
        if (typeof v === 'string') return { kind: 'site', id: v, server: THIS_SERVER };
        if (v && v.kind === 'site' && v.id) {
            return { kind: 'site', id: String(v.id), server: v.server === 'qa' ? 'qa' : (v.server === 'prod' ? 'prod' : THIS_SERVER) };
        }
        if (v && v.kind === 'file') return v;
        return null;
    }
    function setPair(sid, value) { pairs[envSiteKey(sid)] = value; savePairs(); }
    function clearPair(sid) { delete pairs[envSiteKey(sid)]; savePairs(); }
    function shadowSourceLabel(src) {
        if (!src) return '';
        if (src.kind === 'site') {
            const tag = src.server !== THIS_SERVER ? ` [${SERVER_LABELS[src.server]}]` : '';
            return `${siteLabel(src.id, src.server)}${tag}`;
        }
        return `file "${src.name}"`;
    }
    function srcCacheKey(src, sid) {
        return src.kind === 'site' ? `${src.server}:${src.id}` : fileCacheKey(sid);
    }

    // ------------------------------------------------------------------
    // Leaflet access (patterns from AIM Issues — see that script for the
    // history behind each of these)
    // ------------------------------------------------------------------
    function getL() {
        // With @grant, sandbox-side L draws vectors that attach but render
        // invisibly — always prefer the page's real L on unsafeWindow.
        try {
            const realWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            if (realWin && realWin.L) return realWin.L;
            if (window.L) return window.L;
        } catch (e) {}
        return null;
    }

    let leafletPatched = false;
    function patchLeafletMap() {
        if (leafletPatched) return true;
        try {
            const L = getL();
            if (!L || !L.Map || !L.Map.prototype) return false;
            // Hook commonly-called map methods so even already-created maps
            // get stamped with container.__aim_map__ on their next call.
            // Idempotent with the other AIM scripts' copies of this hook
            // (all guard on !container.__aim_map__).
            const methodsToHook = ['initialize', 'getPane', 'addLayer', 'invalidateSize', 'setView', 'panTo', '_animateZoom'];
            methodsToHook.forEach(method => {
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
            leafletPatched = true;
            console.log(`${TAG} patched L.Map prototype (${methodsToHook.length} hooks)`);
            return true;
        } catch (e) {
            console.warn(`${TAG} L.Map patch failed:`, e);
            return false;
        }
    }

    function looksLikeLeafletMap(v) {
        // Full method set required — do NOT relax (partial matches latch onto
        // Leaflet helpers that lack methods we need).
        return v && typeof v === 'object'
            && typeof v.latLngToLayerPoint === 'function'
            && typeof v.latLngToContainerPoint === 'function'
            && typeof v.layerPointToLatLng === 'function'
            && typeof v.distance === 'function'
            && typeof v.getContainer === 'function';
    }

    let leafletMapRef = null;
    function getLeafletMap() {
        if (leafletMapRef && leafletMapRef._container && document.body.contains(leafletMapRef._container)) {
            return leafletMapRef;
        }
        leafletMapRef = null;
        const containers = document.querySelectorAll('.leaflet-container');
        for (const container of containers) {
            const candidates = [container.__aim_map__, container._leaflet_map, container._leaflet];
            for (const c of candidates) {
                if (looksLikeLeafletMap(c)) { leafletMapRef = c; return c; }
            }
            for (const k in container) {
                try {
                    const v = container[k];
                    if (looksLikeLeafletMap(v)) { leafletMapRef = v; return v; }
                } catch (e) {}
            }
        }
        return null;
    }

    function ensurePane(map) {
        if (!map || map._aim_sd_pane_created) return;
        try {
            if (typeof map.createPane !== 'function') return;
            const pane = map.createPane(PANE_NAME);
            // z 550: above the overlayPane vectors (400) so the ghost reads
            // clearly, below the markerPane icons (600) so native markers
            // stay visible. Never interactive.
            if (pane) { pane.style.zIndex = 550; pane.style.pointerEvents = 'none'; }
            // Diff highlights get their own pane: NOT swipe-clipped (they
            // mark THIS site's geometry, not the shadow's) and above markers
            // so a flagged stretch is never buried.
            const hl = map.createPane(HL_PANE_NAME);
            if (hl) { hl.style.zIndex = 620; hl.style.pointerEvents = 'none'; }
            map._aim_sd_pane_created = true;
        } catch (e) {
            console.warn(`${TAG} ensurePane failed:`, e);
        }
    }

    // ------------------------------------------------------------------
    // Fetching (cookie auth, same-origin — no PAT involved)
    // ------------------------------------------------------------------
    function fetchWithTimeout(url, opts, ms) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms || 20000);
        return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
            .finally(() => clearTimeout(t));
    }

    function entityCoords(e) {
        // GET responses use `coords`; POST echoes use `points`. Handle both.
        if (!e) return null;
        if (Array.isArray(e.coords) && e.coords.length > 0) return e.coords;
        if (Array.isArray(e.points) && e.points.length > 0) return e.points;
        return null;
    }

    // src = {id, server}. Same-server → plain cookie fetch; cross-server →
    // GM_xmlhttpRequest against the other origin (its cookies ride along).
    async function fetchShadowEntities(src, force) {
        const server = (src && src.server) || THIS_SERVER;
        const id = String(src && src.id != null ? src.id : src);
        const cacheKey = `${server}:${id}`;
        if (!force && shadowCache[cacheKey]) return shadowCache[cacheKey].entities;
        let path = `/map_objects/?getPoiMapObjectsAsList=true&site_id=${encodeURIComponent(id)}`;
        if (force) path += `&_t=${Date.now()}`;
        try {
            let data;
            if (server !== THIS_SERVER) {
                data = await gmFetchJson(SERVER_ORIGINS[server] + path, 20000);
            } else {
                const r = await fetchWithTimeout(path, {
                    credentials: 'same-origin',
                    cache: force ? 'no-store' : 'default',
                    headers: { 'Accept': 'application/json' },
                }, 20000);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                data = await r.json();
            }
            if (!Array.isArray(data)) throw new Error('response not an array');
            shadowCache[cacheKey] = { entities: data, fetchedAt: Date.now() };
            console.log(`${TAG} loaded ${data.length} entities for shadow site ${id} (${server})`);
            return data;
        } catch (e) {
            console.warn(`${TAG} shadow fetch failed for site ${id} on ${server}:`, e);
            return null;
        }
    }

    function validateBackupEntities(data) {
        // A /map_objects backup is a bare array of entity objects. Accept a
        // wrapped array too (some exports nest it), then sanity-check shape.
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
        if (!plausible.length) return { error: 'no entities with geometry (type + coords/points/arcs)' };
        return { entities: list, drawable: plausible.length };
    }

    function fileCacheKey(sid) { return `file:${sid}`; }

    function storeShadowFile(sid, name, entities) {
        shadowCache[fileCacheKey(sid)] = { entities, fetchedAt: Date.now() };
        try {
            gmSet(KEY_FILE_PREFIX + envSiteKey(sid), JSON.stringify({ name, savedAt: Date.now(), entities }));
        } catch (e) {
            // A very large backup may exceed storage limits — overlay still
            // works this session from memory, it just won't survive a reload.
            console.warn(`${TAG} could not persist backup file (session-only):`, e);
        }
    }

    function loadShadowFileEntities(sid) {
        const cached = shadowCache[fileCacheKey(sid)];
        if (cached) return cached.entities;
        try {
            const raw = gmGet(KEY_FILE_PREFIX + envSiteKey(sid), null);
            if (raw) {
                const stored = JSON.parse(raw);
                if (stored && Array.isArray(stored.entities)) {
                    shadowCache[fileCacheKey(sid)] = { entities: stored.entities, fetchedAt: stored.savedAt || Date.now() };
                    return stored.entities;
                }
            }
        } catch (e) { console.warn(`${TAG} loadShadowFileEntities:`, e); }
        return null;
    }

    async function getShadowEntities(sid, src, force) {
        if (!src) return null;
        if (src.kind === 'site') return fetchShadowEntities(src, force);
        const ents = loadShadowFileEntities(sid);
        if (!ents) console.warn(`${TAG} shadow file "${src.name}" not found in storage — re-upload it via the picker`);
        return ents;
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

    async function fetchSiteList(server, force) {
        const srv = server || THIS_SERVER;
        if (sitesListByServer[srv] && !force) return sitesListByServer[srv];
        const cacheGmKey = srv === 'prod' ? KEY_SITES_CACHE : `${KEY_SITES_CACHE}-qa`;
        try {
            let parsed;
            if (srv !== THIS_SERVER) {
                parsed = await gmFetchJson(`${SERVER_ORIGINS[srv]}/sites/`, 20000);
            } else {
                const r = await fetchWithTimeout('/sites/', {
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json' },
                }, 20000);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                parsed = JSON.parse(await r.text());
            }
            const list = extractList(parsed);
            const seen = new Set();
            const out = [];
            for (const s of list) {
                const id = String(s.id != null ? s.id : (s.site_id != null ? s.site_id : ''));
                if (!id || seen.has(id)) continue;
                seen.add(id);
                out.push({ id, name: String(s.name || s.site_name || s.title || `site ${id}`) });
            }
            if (out.length) {
                sitesListByServer[srv] = out;
                gmSet(cacheGmKey, JSON.stringify(out));
                return out;
            }
            throw new Error('empty site list');
        } catch (e) {
            console.warn(`${TAG} site list fetch failed (${srv}):`, e);
            try {
                const cached = gmGet(cacheGmKey, null);
                if (cached) {
                    sitesListByServer[srv] = JSON.parse(cached);
                    return sitesListByServer[srv];
                }
            } catch (e2) {}
            return null;
        }
    }

    function siteLabel(id, server) {
        const list = sitesListByServer[server || THIS_SERVER];
        if (list) {
            const s = list.find(x => x.id === String(id));
            if (s) return s.name;
        }
        return `site ${id}`;
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    let shadowLayers = [];
    let renderSeq = 0;

    function clearShadowLayers() {
        const map = getLeafletMap();
        shadowLayers.forEach(l => {
            try { if (map) map.removeLayer(l); } catch (e) {}
        });
        shadowLayers = [];
    }

    function buildLayers(e, L) {
        const key = TYPE_TO_KEY[e.type];
        if (!key) return [];
        const ts = style.types[key];
        if (!ts || !ts.show) return [];
        const base = {
            color: ts.color,
            weight: style.weight,
            opacity: ts.opacity,
            dashArray: style.dashed ? '6,5' : null,
            interactive: false,
            bubblingMouseEvents: false,
            pane: PANE_NAME,
        };
        if (e.type === 15) {
            // FPs store geometry as arcs (point_a→point_b); one multi-segment
            // polyline per FP entity keeps layer count low.
            const segs = (Array.isArray(e.arcs) ? e.arcs : [])
                .filter(a => a && a.point_a && a.point_b
                    && typeof a.point_a.lat === 'number' && typeof a.point_b.lat === 'number')
                .map(a => [[a.point_a.lat, a.point_a.lng], [a.point_b.lat, a.point_b.lng]]);
            if (segs.length) return [L.polyline(segs, base)];
            const cs = entityCoords(e);
            if (cs && cs.length > 1) return [L.polyline(cs.map(p => [p.lat, p.lng]), base)];
            return [];
        }
        if (e.type === 3 || e.type === 16 || e.type === 4) {
            const cs = entityCoords(e);
            if (!cs || cs.length < 3) return [];
            return [L.polygon(cs.map(p => [p.lat, p.lng]), Object.assign({}, base, {
                fillColor: ts.color,
                fillOpacity: ts.opacity * 0.10,
            }))];
        }
        // Point entities: GM (19), Base (8), Safe (98)
        const cs = entityCoords(e);
        if (!cs || !cs.length || typeof cs[0].lat !== 'number') return [];
        return [L.circleMarker([cs[0].lat, cs[0].lng], Object.assign({}, base, {
            radius: style.markerSize,
            fillColor: ts.color,
            fillOpacity: Math.min(1, ts.opacity * 0.6),
        }))];
    }

    function drawAttempt(entities, shadowLabel, attempt, seq) {
        if (seq !== renderSeq) return;
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L) {
            if (attempt < 60) {
                setTimeout(() => drawAttempt(entities, shadowLabel, attempt + 1, seq), 500);
            } else if (document.querySelector('.leaflet-container')) {
                console.warn(`${TAG} draw gave up — Leaflet map never appeared after ${attempt} tries`);
            }
            // No .leaflet-container at all → this is a non-map react-pages
            // iframe; give up silently.
            return;
        }
        ensurePane(map);
        let drawn = 0, skipped = 0;
        entities.forEach(e => {
            try {
                const layers = buildLayers(e, L);
                if (!layers.length) { skipped++; return; }
                layers.forEach(l => {
                    l.addTo(map);
                    // interactive:false alone isn't enough on every renderer path
                    try { if (l._path) l._path.style.pointerEvents = 'none'; } catch (err) {}
                    shadowLayers.push(l);
                });
                drawn++;
            } catch (err) {
                skipped++;
                console.warn(`${TAG} draw failed for entity ${e && e.id}:`, err);
            }
        });
        console.log(`${TAG} shadow of ${shadowLabel}: drew ${drawn} entities (${skipped} hidden/skipped)`);
        updateBadge();
        applySwipeClip();
        applyFocusMode();
    }

    function renderShadow(force) {
        const seq = ++renderSeq;
        clearShadowLayers();
        updateBadge();
        applySwipeClip();
        applyFocusMode();
        if (!masterEnabled || !siteID) return;
        const src = shadowSourceFor(siteID);
        if (!src) return;
        getShadowEntities(siteID, src, force).then(entities => {
            if (seq !== renderSeq || !entities) return;
            drawAttempt(entities, shadowSourceLabel(src), 0, seq);
        });
    }

    let redrawTimer = null;
    function scheduleRedraw() {
        if (redrawTimer) clearTimeout(redrawTimer);
        redrawTimer = setTimeout(() => { redrawTimer = null; renderShadow(false); }, 120);
    }

    // ------------------------------------------------------------------
    // Badge (small map indicator so a shadowed map is never a mystery)
    // ------------------------------------------------------------------
    const siteListRequested = { prod: false, qa: false };
    function updateBadge() {
        let b = document.getElementById('aim-sd-badge');
        const src = (masterEnabled && siteID) ? shadowSourceFor(siteID) : null;
        // Cross-server shadow: pull that server's site list once so the
        // badge shows the site's NAME, not just "site <id>".
        if (src && src.kind === 'site' && !sitesListByServer[src.server] && !siteListRequested[src.server]) {
            siteListRequested[src.server] = true;
            fetchSiteList(src.server, false).then(list => { if (list) updateBadge(); });
        }
        if (!src || !document.querySelector('.leaflet-container')) {
            if (b) b.style.display = 'none';
            return;
        }
        if (!b) {
            b = document.createElement('div');
            b.id = 'aim-sd-badge';
            b.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147480000;'
                + 'background:rgba(20,24,32,0.9);color:#ffa030;border:1px solid #ffa03066;'
                + 'border-radius:4px;padding:3px 8px;font:12px/1.4 monospace;cursor:pointer;'
                + 'user-select:none;';
            b.title = 'AIM Site Diff — click to change shadow site';
            b.addEventListener('click', (ev) => {
                ev.stopPropagation();
                openPicker();
            });
            document.body.appendChild(b);
        }
        const cached = shadowCache[srcCacheKey(src, siteID)];
        const count = cached ? ` · ${cached.entities.length}` : '';
        b.textContent = `◈ Shadow: ${shadowSourceLabel(src)}${count}`;
        b.style.display = 'block';
    }

    // ------------------------------------------------------------------
    // Shadow-site picker panel
    // ------------------------------------------------------------------
    let pickerEl = null;

    function pickerStatusHtml() {
        const src = siteID ? shadowSourceFor(siteID) : null;
        if (!src) return '<span style="color:#888">No shadow selected for this site. Pick the Live (original) site below, or load a JSON backup.</span>';
        const cached = shadowCache[srcCacheKey(src, siteID)];
        const count = cached ? ` — ${cached.entities.length} entities` : '';
        const idBit = src.kind === 'site' ? ` <span style="color:#666">#${src.id}</span>` : '';
        return `Shadowing <span style="color:#ffa030">${escapeHtml(shadowSourceLabel(src))}</span>${idBit}${count}`;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    let pickerServer = THIS_SERVER;   // which server's site list the picker is showing

    function renderPickerTabs() {
        const tabsEl = pickerEl && pickerEl.querySelector('#aim-sd-tabs');
        if (!tabsEl) return;
        tabsEl.innerHTML = ['prod', 'qa'].map(srv => {
            const active = srv === pickerServer;
            const label = `${SERVER_LABELS[srv]}${srv === THIS_SERVER ? ' (this server)' : ''}`;
            return `<span data-srv="${srv}" style="cursor:pointer;padding:2px 10px;border-radius:3px;`
                + (active ? 'background:#22303f;color:#7adfe6;font-weight:bold;' : 'color:#888;')
                + `">${label}</span>`;
        }).join('');
    }

    function renderPickerList(filter) {
        const listEl = pickerEl && pickerEl.querySelector('#aim-sd-list');
        if (!listEl) return;
        const f = (filter || '').trim().toLowerCase();
        const rows = [];
        if (/^\d+$/.test(f)) {
            rows.push(`<div class="aim-sd-row" data-sid="${f}" data-srv="${pickerServer}" style="color:#7adfe6">➜ Use site ID ${f} directly (${SERVER_LABELS[pickerServer]})</div>`);
        }
        const list = sitesListByServer[pickerServer];
        if (list) {
            const cur = shadowSourceFor(siteID);
            list
                .filter(s => !(pickerServer === THIS_SERVER && s.id === siteID))
                .filter(s => !f || s.name.toLowerCase().includes(f) || s.id.includes(f))
                .slice(0, 200)
                .forEach(s => {
                    const active = !!(cur && cur.kind === 'site' && cur.id === s.id && cur.server === pickerServer);
                    rows.push(`<div class="aim-sd-row" data-sid="${s.id}" data-srv="${pickerServer}" style="${active ? 'color:#ffa030;' : ''}">`
                        + `${escapeHtml(s.name)} <span style="color:#666">#${s.id}</span>${active ? ' ◈' : ''}</div>`);
                });
        } else if (pickerServer !== THIS_SERVER) {
            rows.push(`<div style="color:#888;padding:4px 6px">Loading ${SERVER_LABELS[pickerServer]} site list… If it never loads, log into ${SERVER_ORIGINS[pickerServer].replace('https://', '')} in another tab, then ⟳ Refresh. You can also type a numeric site ID above.</div>`);
        } else {
            rows.push('<div style="color:#888;padding:4px 6px">Site list unavailable — type a numeric site ID above.</div>');
        }
        listEl.innerHTML = rows.join('') || '<div style="color:#888;padding:4px 6px">No matches.</div>';
    }

    function openPicker() {
        if (!pickerEl) {
            pickerEl = document.createElement('div');
            pickerEl.id = 'aim-sd-picker';
            pickerEl.style.cssText = 'position:fixed;top:70px;right:16px;z-index:2147480001;width:320px;'
                + 'background:#14181f;color:#ddd;border:1px solid #2a3140;border-radius:6px;'
                + 'font:12px/1.5 monospace;box-shadow:0 4px 18px rgba(0,0,0,0.5);';
            pickerEl.innerHTML = ''
                + '<div style="padding:7px 10px;color:#7adfe6;font-weight:bold;border-bottom:1px solid #2a3140;">'
                + '◈ Site Diff — shadow site <span id="aim-sd-close" style="float:right;cursor:pointer;color:#888">✕</span></div>'
                + '<div id="aim-sd-status" style="padding:6px 10px;border-bottom:1px solid #222834;"></div>'
                + '<div id="aim-sd-tabs" style="padding:6px 10px 0;display:flex;gap:6px;"></div>'
                + '<div style="padding:6px 10px;"><input id="aim-sd-search" type="text" placeholder="Search sites or type a site ID…" '
                + 'style="width:100%;box-sizing:border-box;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:4px 6px;font:inherit;outline:none;"></div>'
                + '<div id="aim-sd-list" style="max-height:280px;overflow-y:auto;padding:0 4px 4px;"></div>'
                + '<div style="padding:6px 10px;border-top:1px solid #222834;display:flex;gap:10px;flex-wrap:wrap;">'
                + '<span id="aim-sd-file" style="cursor:pointer;color:#ffa030">📂 JSON backup…</span>'
                + '<span id="aim-sd-refresh" style="cursor:pointer;color:#7adfe6">⟳ Refresh data</span>'
                + '<span id="aim-sd-clear" style="cursor:pointer;color:#ff5252">Clear shadow</span>'
                + '</div>'
                + '<input id="aim-sd-file-input" type="file" accept=".json,application/json" style="display:none">';
            document.body.appendChild(pickerEl);

            const style2 = document.createElement('style');
            style2.textContent = '#aim-sd-list .aim-sd-row{padding:3px 6px;cursor:pointer;border-radius:3px;}'
                + '#aim-sd-list .aim-sd-row:hover{background:#222a38;}';
            pickerEl.appendChild(style2);

            pickerEl.querySelector('#aim-sd-close').addEventListener('click', () => { pickerEl.style.display = 'none'; });
            pickerEl.querySelector('#aim-sd-search').addEventListener('input', (ev) => renderPickerList(ev.target.value));
            pickerEl.querySelector('#aim-sd-tabs').addEventListener('click', (ev) => {
                const tab = ev.target.closest('[data-srv]');
                if (!tab) return;
                const srv = tab.getAttribute('data-srv');
                if (srv === pickerServer) return;
                pickerServer = srv;
                renderPickerTabs();
                renderPickerList(pickerEl.querySelector('#aim-sd-search').value);
                fetchSiteList(srv, false).then(() => {
                    if (pickerEl.style.display !== 'none' && pickerServer === srv) {
                        renderPickerList(pickerEl.querySelector('#aim-sd-search').value);
                    }
                });
            });
            pickerEl.querySelector('#aim-sd-clear').addEventListener('click', () => {
                if (siteID && pairs[envSiteKey(siteID)]) {
                    console.log(`${TAG} cleared shadow pairing for site ${siteID} (${THIS_SERVER})`);
                    const src = shadowSourceFor(siteID);
                    if (src && src.kind === 'file') {
                        delete shadowCache[fileCacheKey(siteID)];
                        gmSet(KEY_FILE_PREFIX + envSiteKey(siteID), '');   // drop the stored backup too
                    }
                    clearPair(siteID);
                    renderShadow(false);
                    refreshPickerStatus();
                    renderPickerList(pickerEl.querySelector('#aim-sd-search').value);
                }
            });
            pickerEl.querySelector('#aim-sd-file').addEventListener('click', () => {
                pickerEl.querySelector('#aim-sd-file-input').click();
            });
            pickerEl.querySelector('#aim-sd-file-input').addEventListener('change', (ev) => {
                const f = ev.target.files && ev.target.files[0];
                ev.target.value = '';   // allow re-uploading the same filename later
                if (!f) return;
                if (!siteID) { setPickerNote('Open a site first, then load the backup.', true); return; }
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        const parsed = JSON.parse(String(reader.result));
                        const v = validateBackupEntities(parsed);
                        if (v.error) {
                            setPickerNote(`"${f.name}" doesn't look like a /map_objects backup — ${v.error}`, true);
                            return;
                        }
                        storeShadowFile(siteID, f.name, v.entities);
                        setPair(siteID, { kind: 'file', name: f.name });
                        console.log(`${TAG} site ${siteID} now shadows JSON backup "${f.name}" (${v.entities.length} entities, ${v.drawable} drawable)`);
                        if (!masterEnabled) {
                            console.log(`${TAG} note: master toggle is OFF — enable "Site Diff" in the Control Panel to see the overlay`);
                        }
                        renderShadow(false);
                        refreshPickerStatus();
                        renderPickerList(pickerEl.querySelector('#aim-sd-search').value);
                    } catch (e) {
                        console.warn(`${TAG} backup parse failed:`, e);
                        setPickerNote(`Could not parse "${f.name}" — not valid JSON.`, true);
                    }
                };
                reader.onerror = () => setPickerNote('File read failed.', true);
                reader.readAsText(f);
            });
            pickerEl.querySelector('#aim-sd-refresh').addEventListener('click', () => {
                fetchSiteList(pickerServer, true).then(() => renderPickerList(pickerEl.querySelector('#aim-sd-search').value));
                renderShadow(true);
            });
            // Row clicks via delegation — the list is rebuilt on every keystroke
            pickerEl.querySelector('#aim-sd-list').addEventListener('click', (ev) => {
                const row = ev.target.closest('[data-sid]');
                if (!row || !siteID) return;
                const sid = row.getAttribute('data-sid');
                const srv = row.getAttribute('data-srv') || pickerServer;
                // Same id on the OTHER server is a legitimate shadow — only
                // block shadowing this exact site on this server.
                if (srv === THIS_SERVER && sid === siteID) return;
                setPair(siteID, { kind: 'site', id: sid, server: srv });
                console.log(`${TAG} site ${siteID} (${THIS_SERVER}) now shadows site ${sid} (${srv})`);
                if (!masterEnabled) {
                    console.log(`${TAG} note: master toggle is OFF — enable "Site Diff" in the Control Panel to see the overlay`);
                }
                renderShadow(false);
                pickerEl.style.display = 'none';
            });
        }
        pickerEl.style.display = 'block';
        refreshPickerStatus();
        renderPickerTabs();
        renderPickerList(pickerEl.querySelector('#aim-sd-search').value);
        fetchSiteList(pickerServer, false).then(() => {
            if (pickerEl.style.display !== 'none') {
                refreshPickerStatus();
                renderPickerList(pickerEl.querySelector('#aim-sd-search').value);
            }
        });
        try { pickerEl.querySelector('#aim-sd-search').focus(); } catch (e) {}
    }

    function refreshPickerStatus() {
        const el = pickerEl && pickerEl.querySelector('#aim-sd-status');
        if (el) el.innerHTML = pickerStatusHtml();
    }

    function setPickerNote(msg, isError) {
        const el = pickerEl && pickerEl.querySelector('#aim-sd-status');
        if (el) el.innerHTML = `<span style="color:${isError ? '#ff5252' : '#7adfe6'}">${escapeHtml(msg)}</span>`;
    }

    // ==================================================================
    // Phase 2 — significant-change diff (approved-envelope model)
    //
    // Envelope = the shadow's (Live site's) FFZ polygons + FP segments,
    // buffered by the threshold. A stretch of THIS site's flight geometry
    // outside the envelope was never regs-reviewed → significant change.
    // A new FP threading through a removed FFZ corridor stays quiet.
    // ==================================================================
    const FT_PER_M = 3.28084;
    const SAMPLE_STEP_M = 3;          // ~10 ft sampling along new geometry
    const MIN_RUN_SAMPLES = 2;        // ignore single-sample blips

    function projector(lat0) {
        // Local equirectangular — plenty accurate at site scale
        const mLat = 111320;
        const mLng = 111320 * Math.cos(lat0 * Math.PI / 180) || 1e-6;
        return {
            toXY: (p) => ({ x: p.lng * mLng, y: p.lat * mLat }),
            toLatLng: (x, y) => [y / mLat, x / mLng],
        };
    }

    function segDistM(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = 0;
        if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }

    function pointInRingXY(px, py, xs, ys) {
        let inside = false;
        for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
            if (((ys[i] > py) !== (ys[j] > py))
                && (px < (xs[j] - xs[i]) * (py - ys[i]) / (ys[j] - ys[i]) + xs[i])) inside = !inside;
        }
        return inside;
    }

    function buildEnvelope(entities, proj, thrM) {
        const segs = [];    // shadow FP arcs
        const polys = [];   // shadow FFZ rings
        const pad = thrM + 1;   // bbox pad ≥ threshold → coverage tests stay exact
        (entities || []).forEach(e => {
            if (e.type === 15 && Array.isArray(e.arcs)) {
                e.arcs.forEach(a => {
                    if (!a || !a.point_a || !a.point_b) return;
                    if (typeof a.point_a.lat !== 'number' || typeof a.point_b.lat !== 'number') return;
                    const A = proj.toXY(a.point_a), B = proj.toXY(a.point_b);
                    segs.push({
                        ax: A.x, ay: A.y, bx: B.x, by: B.y,
                        name: e.name || `FP ${e.id}`,
                        minX: Math.min(A.x, B.x) - pad, maxX: Math.max(A.x, B.x) + pad,
                        minY: Math.min(A.y, B.y) - pad, maxY: Math.max(A.y, B.y) + pad,
                    });
                });
            } else if (e.type === 16) {
                const cs = entityCoords(e);
                if (!cs || cs.length < 3) return;
                const xs = [], ys = [];
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                cs.forEach(p => {
                    if (!p || typeof p.lat !== 'number') return;
                    const q = proj.toXY(p);
                    xs.push(q.x); ys.push(q.y);
                    if (q.x < minX) minX = q.x;
                    if (q.x > maxX) maxX = q.x;
                    if (q.y < minY) minY = q.y;
                    if (q.y > maxY) maxY = q.y;
                });
                if (xs.length < 3) return;
                polys.push({ xs, ys, name: e.name || `FFZ ${e.id}`, minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad });
            }
        });
        return { segs, polys };
    }

    // Min distance to the envelope with bbox prefilter. The pad equals the
    // threshold, so covered/uncovered decisions are exact; the returned
    // distance for far-away points is only a lower bound (Infinity if no
    // bbox matched) — use distToEnvelopeExactM for reporting.
    function distToEnvelopeM(x, y, env) {
        let best = Infinity;
        for (const pg of env.polys) {
            if (x < pg.minX || x > pg.maxX || y < pg.minY || y > pg.maxY) continue;
            if (pointInRingXY(x, y, pg.xs, pg.ys)) return 0;
            for (let i = 0, j = pg.xs.length - 1; i < pg.xs.length; j = i++) {
                const d = segDistM(x, y, pg.xs[j], pg.ys[j], pg.xs[i], pg.ys[i]);
                if (d < best) best = d;
            }
        }
        for (const s of env.segs) {
            if (x < s.minX || x > s.maxX || y < s.minY || y > s.maxY) continue;
            const d = segDistM(x, y, s.ax, s.ay, s.bx, s.by);
            if (d < best) best = d;
        }
        return best;
    }

    // Exact (no bbox) scan that also says WHICH old feature is nearest —
    // used once per stretch for the report ("88 ft from FFZ freezone_4")
    function nearestOldFeature(x, y, env) {
        const best = { d: Infinity, name: null, kind: null };
        for (const pg of env.polys) {
            if (pointInRingXY(x, y, pg.xs, pg.ys)) return { d: 0, name: pg.name, kind: 'FFZ' };
            for (let i = 0, j = pg.xs.length - 1; i < pg.xs.length; j = i++) {
                const d = segDistM(x, y, pg.xs[j], pg.ys[j], pg.xs[i], pg.ys[i]);
                if (d < best.d) { best.d = d; best.name = pg.name; best.kind = 'FFZ'; }
            }
        }
        for (const s of env.segs) {
            const d = segDistM(x, y, s.ax, s.ay, s.bx, s.by);
            if (d < best.d) { best.d = d; best.name = s.name; best.kind = 'FP'; }
        }
        return best;
    }

    let diffLayers = [];
    let diffStretches = [];
    let diffRunning = false;
    let diffMeta = null;   // { thrFt, shadowLabel, at }
    let sdIssuesChannel = null;

    function ensureIssuesChannel() {
        if (sdIssuesChannel) return sdIssuesChannel;
        try { sdIssuesChannel = new BroadcastChannel('AIM_SITEDIFF_ISSUES'); }
        catch (e) { console.warn(`${TAG} sitediff issues channel unavailable:`, e); }
        return sdIssuesChannel;
    }

    function clearDiff(alsoIssues) {
        const map = getLeafletMap();
        diffLayers.forEach(l => { try { if (map) map.removeLayer(l); } catch (e) {} });
        diffLayers = [];
        diffStretches = [];
        diffMeta = null;
        if (alsoIssues && siteID) {
            const ch = ensureIssuesChannel();
            if (ch) ch.postMessage({ type: 'CLEAR_DIFF_ISSUES', siteID });
        }
        if (diffPanelEl && diffPanelEl.style.display !== 'none') {
            setDiffStatus('Cleared.');
            renderDiffList();
        }
    }

    async function diffEntity(e, proj, env, thrM, out) {
        const kind = e.type === 15 ? 'FP' : 'FFZ';
        const name = e.name || `${kind} ${e.id}`;
        let segList = [];
        if (e.type === 15) {
            segList = (e.arcs || [])
                .filter(a => a && a.point_a && a.point_b
                    && typeof a.point_a.lat === 'number' && typeof a.point_b.lat === 'number')
                .map(a => [a.point_a, a.point_b]);
        } else {
            const cs = (entityCoords(e) || []).filter(p => p && typeof p.lat === 'number');
            if (cs.length < 3) return;
            for (let i = 0; i < cs.length; i++) segList.push([cs[i], cs[(i + 1) % cs.length]]);
        }
        let run = null;
        let prevEnd = null;
        let ops = 0;
        const closeRun = () => {
            if (!run) return;
            if (run.samples >= MIN_RUN_SAMPLES && run.worst) {
                const near = nearestOldFeature(run.worst.x, run.worst.y, env);
                out.push({
                    kind, name, entityId: e.id,
                    pts: run.pts,
                    lengthM: run.lengthM,
                    segStart: run.segStart, segEnd: run.segEnd,
                    maxOffM: isFinite(near.d) ? near.d : null,   // null = nothing old anywhere
                    nearName: near.name, nearKind: near.kind,
                });
            }
            run = null;
        };
        for (let si = 0; si < segList.length; si++) {
            const [P, Q] = segList[si];
            // Arcs usually chain in order; when they don't (branch jump),
            // close the open run rather than drawing a false connector.
            if (prevEnd && (Math.abs(prevEnd.lat - P.lat) > 1e-6 || Math.abs(prevEnd.lng - P.lng) > 1e-6)) closeRun();
            prevEnd = Q;
            const A = proj.toXY(P), B = proj.toXY(Q);
            const segLen = Math.hypot(B.x - A.x, B.y - A.y);
            if (segLen === 0) continue;
            const n = Math.max(1, Math.ceil(segLen / SAMPLE_STEP_M));
            for (let i = 0; i <= n; i++) {
                const t = i / n;
                const x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t;
                const d = distToEnvelopeM(x, y, env);
                if (d > thrM) {
                    const lat = P.lat + (Q.lat - P.lat) * t, lng = P.lng + (Q.lng - P.lng) * t;
                    if (!run) {
                        run = { pts: [[lat, lng]], samples: 1, lengthM: 0, lastXY: { x, y }, worst: { x, y, d }, segStart: si + 1, segEnd: si + 1 };
                    } else {
                        run.pts.push([lat, lng]);
                        run.samples++;
                        run.lengthM += Math.hypot(x - run.lastXY.x, y - run.lastXY.y);
                        run.lastXY = { x, y };
                        run.segEnd = si + 1;
                        if (d > run.worst.d) run.worst = { x, y, d };
                    }
                } else {
                    closeRun();
                }
                // Cooperative yield so big sites don't freeze the tab
                if (++ops >= 500) { ops = 0; await new Promise(r => setTimeout(r, 0)); }
            }
        }
        closeRun();
    }

    // One place formats a stretch for the panel, the report, and the issue
    // note — keeps all three telling the same story.
    function stretchDesc(s) {
        const lenFt = Math.round(s.lengthM * FT_PER_M);
        const segTxt = s.kind === 'FP'
            ? (s.segStart === s.segEnd ? `seg ${s.segStart}` : `segs ${s.segStart}–${s.segEnd}`)
            : 'perimeter';
        const offFt = s.maxOffM === null ? null : Math.round(s.maxOffM * FT_PER_M);
        const isNew = offFt === null || offFt > diffCfg.newRouteFt;
        const offTxt = isNew
            ? `NEW route (nothing old within ${diffCfg.newRouteFt} ft)`
            : `max ${offFt} ft from ${s.nearKind} "${s.nearName}"`;
        return { lenFt, segTxt, offTxt, offFt, isNew };
    }

    function drawDiffStretches() {
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L) return;
        ensurePane(map);
        diffStretches.forEach(s => {
            try {
                const line = L.polyline(s.pts, {
                    color: diffCfg.color,
                    weight: 5,
                    opacity: 0.95,
                    interactive: false,
                    bubblingMouseEvents: false,
                    pane: HL_PANE_NAME,
                });
                line.addTo(map);
                try { if (line._path) line._path.style.pointerEvents = 'none'; } catch (e) {}
                s._layer = line;
                diffLayers.push(line);
            } catch (e) {
                console.warn(`${TAG} diff draw failed:`, e);
            }
        });
    }

    async function runDiff() {
        if (diffRunning) return;
        if (!siteID) { openDiffPanel(); setDiffStatus('No site loaded.'); return; }
        const src = shadowSourceFor(siteID);
        if (!src) {
            openDiffPanel();
            setDiffStatus('Pick a shadow first — the Live (original) site or a JSON backup.');
            return;
        }
        diffRunning = true;
        clearDiff(false);
        openDiffPanel();
        setDiffStatus('Running diff…');
        try {
            const [mine, theirs] = await Promise.all([
                fetchShadowEntities({ id: siteID, server: THIS_SERVER }, true),   // THIS (Offline) site — always fresh
                getShadowEntities(siteID, src, false),      // shadow (Live) baseline
            ]);
            if (!mine) { setDiffStatus('Could not fetch this site\'s entities.'); return; }
            if (!theirs) { setDiffStatus('Could not load the shadow\'s entities.'); return; }
            let anchorLat = null;
            for (const e of theirs.concat(mine)) {
                const cs = entityCoords(e);
                if (cs && cs[0] && typeof cs[0].lat === 'number') { anchorLat = cs[0].lat; break; }
                if (Array.isArray(e.arcs) && e.arcs[0] && e.arcs[0].point_a) { anchorLat = e.arcs[0].point_a.lat; break; }
            }
            if (anchorLat === null) { setDiffStatus('No geometry found on either side.'); return; }
            const thrFt = diffCfg.thresholdFt;
            const thrM = thrFt / FT_PER_M;
            const proj = projector(anchorLat);
            const env = buildEnvelope(theirs, proj, thrM);
            if (!env.segs.length && !env.polys.length) {
                setDiffStatus('Shadow has no FFZ/FP geometry — every flight route here would flag. Aborted.');
                return;
            }
            const targets = [];
            (mine || []).forEach(e => {
                if (e.type === 15 && Array.isArray(e.arcs) && e.arcs.length) targets.push(e);
                else if (diffCfg.includeFfz && e.type === 16) {
                    const cs = entityCoords(e);
                    if (cs && cs.length >= 3) targets.push(e);
                }
            });
            const stretches = [];
            let done = 0;
            for (const e of targets) {
                await diffEntity(e, proj, env, thrM, stretches);
                done++;
                if (done % 5 === 0) setDiffStatus(`Running diff… ${done}/${targets.length}`);
            }
            stretches.sort((a, b) => b.lengthM - a.lengthM);
            diffStretches = stretches;
            diffMeta = { thrFt, shadowLabel: shadowSourceLabel(src), at: new Date() };
            drawDiffStretches();
            const totalFt = Math.round(stretches.reduce((s, x) => s + x.lengthM, 0) * FT_PER_M);
            console.log(`${TAG} diff done: ${stretches.length} significant stretch(es), ${totalFt} ft total (thr ${thrFt} ft, ${targets.length} entities checked vs ${env.polys.length} FFZs + ${env.segs.length} FP segs)`);
            setDiffStatus(stretches.length
                ? `${stretches.length} significant stretch(es) — ${totalFt.toLocaleString()} ft total outside the old envelope (threshold ${thrFt} ft).`
                : `No significant changes — all flight geometry within ${thrFt} ft of the old envelope ✓`);
            renderDiffList();
        } catch (e) {
            console.warn(`${TAG} runDiff threw:`, e);
            setDiffStatus('Diff failed — see console.');
        } finally {
            diffRunning = false;
        }
    }

    // Thin corridor polygon around a stretch line → AIM Issues polygon
    function bufferStretchRing(pts, halfM) {
        const proj = projector(pts[0][0]);
        const P = pts.map(p => proj.toXY({ lat: p[0], lng: p[1] }));
        if (P.length === 1) P.push({ x: P[0].x + 1, y: P[0].y });
        const left = [], right = [];
        let nx = 0, ny = 1;
        for (let i = 0; i < P.length; i++) {
            const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy);
            if (len > 0) { nx = -dy / len; ny = dx / len; }
            left.push([P[i].x + nx * halfM, P[i].y + ny * halfM]);
            right.push([P[i].x - nx * halfM, P[i].y - ny * halfM]);
        }
        return left.concat(right.reverse()).map(q => proj.toLatLng(q[0], q[1]));
    }

    function sendDiffIssues() {
        if (!siteID) return;
        if (!diffStretches.length) { setDiffStatus('Nothing to send — run the diff first.'); return; }
        const ch = ensureIssuesChannel();
        if (!ch) { setDiffStatus('Issues channel unavailable.'); return; }
        const thrFt = diffMeta ? diffMeta.thrFt : diffCfg.thresholdFt;
        const issues = diffStretches.map(s => {
            const d = stretchDesc(s);
            return {
                shape: 'polygon',
                polygon: bufferStretchRing(s.pts, 5),
                note: `Site Diff: ${s.kind} "${s.name}" ${d.segTxt} — ${d.lenFt} ft outside the old envelope (thr ${thrFt} ft) — ${d.offTxt}`,
            };
        });
        ch.postMessage({ type: 'DIFF_ISSUES', siteID, issues });
        console.log(`${TAG} sent ${issues.length} diff issue(s) to the validator union`);
        setDiffStatus(`Sent ${issues.length} issue(s) — needs Asset Inspector v4.165+ and AIM Issues enabled to draw.`);
    }

    function buildDiffReport() {
        const lines = [];
        const thrFt = diffMeta ? diffMeta.thrFt : diffCfg.thresholdFt;
        lines.push(`AIM Site Diff report — site ${siteID} vs shadow ${diffMeta ? diffMeta.shadowLabel : ''}`);
        lines.push(`Threshold ${thrFt} ft · ${diffStretches.length} significant stretch(es)`);
        diffStretches.forEach((s, i) => {
            const d = stretchDesc(s);
            const mid = s.pts[Math.floor(s.pts.length / 2)];
            lines.push(`${i + 1}. ${s.kind} · ${s.name} (${d.segTxt}) — ${d.lenFt} ft long — ${d.offTxt} @ ${mid[0].toFixed(6)}, ${mid[1].toFixed(6)}`);
        });
        return lines.join('\n');
    }

    // ---------------- Diff results panel (table) ----------------
    let diffPanelEl = null;
    let diffSort = { key: 'lengthM', dir: -1 };
    let diffFilter = { text: '', type: 'all', newOnly: false };
    const DIFF_COLS = [
        { key: 'kind', label: 'Type', w: 46 },
        { key: 'name', label: 'Name', w: 160 },
        { key: 'segs', label: 'Segs', w: 64 },
        { key: 'lengthM', label: 'Length', w: 72 },
        { key: 'off', label: 'Offset', w: 72 },
        { key: 'from', label: 'From (old)', w: 150 },
    ];

    function setDiffStatus(msg) {
        const el = diffPanelEl && diffPanelEl.querySelector('#aim-sd-diff-status');
        if (el) el.textContent = msg;
    }

    function diffRowsView() {
        const rows = diffStretches
            .map((s, i) => ({ i, s, d: stretchDesc(s) }))
            .filter(r => {
                if (diffFilter.type !== 'all' && r.s.kind !== diffFilter.type) return false;
                if (diffFilter.newOnly && !r.d.isNew) return false;
                if (diffFilter.text) {
                    const hay = `${r.s.name} ${r.s.nearName || ''}`.toLowerCase();
                    if (!hay.includes(diffFilter.text)) return false;
                }
                return true;
            });
        const { key, dir } = diffSort;
        rows.sort((a, b) => {
            let va, vb;
            switch (key) {
                case 'kind': va = a.s.kind; vb = b.s.kind; break;
                case 'name': va = a.s.name || ''; vb = b.s.name || ''; break;
                case 'segs': va = a.s.segStart || 0; vb = b.s.segStart || 0; break;
                case 'off':
                    // NEW (null / beyond threshold) sorts as farthest-out
                    va = a.s.maxOffM === null ? Infinity : a.s.maxOffM;
                    vb = b.s.maxOffM === null ? Infinity : b.s.maxOffM;
                    break;
                case 'from': va = a.s.nearName || ''; vb = b.s.nearName || ''; break;
                default: va = a.s.lengthM; vb = b.s.lengthM;
            }
            if (typeof va === 'string') return va.localeCompare(vb) * dir;
            return (va - vb) * dir;
        });
        return rows;
    }

    function renderDiffList() {
        const wrap = diffPanelEl && diffPanelEl.querySelector('#aim-sd-diff-list');
        if (!wrap) return;
        const countEl = diffPanelEl.querySelector('#aim-sd-diff-count');
        if (!diffStretches.length) {
            wrap.innerHTML = '';
            if (countEl) countEl.textContent = '';
            return;
        }
        const rows = diffRowsView();
        if (countEl) countEl.textContent = `${rows.length}/${diffStretches.length}`;
        const arrow = (k) => diffSort.key === k ? (diffSort.dir === 1 ? ' ▲' : ' ▼') : '';
        const cols = DIFF_COLS.map((c, ci) => `<col data-ci="${ci}" style="width:${c.w}px">`).join('');
        const ths = DIFF_COLS.map((c, ci) =>
            `<th data-sk="${c.key}" style="position:sticky;top:0;z-index:1;background:#1a2029;color:#7adfe6;`
            + 'text-align:left;padding:4px 6px;cursor:pointer;border-bottom:1px solid #2a3140;'
            + `white-space:nowrap;overflow:hidden;">${c.label}${arrow(c.key)}`
            + `<span class="aim-sd-grip" data-ci="${ci}" style="position:absolute;right:0;top:0;bottom:0;width:7px;cursor:col-resize;"></span></th>`
        ).join('');
        const trs = rows.map(r => {
            const offHtml = r.d.isNew
                ? '<span style="color:#ff5252;font-weight:bold">NEW</span>'
                : `${r.d.offFt} ft`;
            const fromTxt = r.d.isNew ? '—' : `${r.s.nearKind} ${r.s.nearName}`;
            const td = 'padding:3px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid #1d2430;';
            return `<tr class="aim-sd-tr" data-di="${r.i}" style="cursor:pointer;">`
                + `<td style="${td}color:${r.s.kind === 'FP' ? '#ffa030' : '#d05fff'}">${r.s.kind}</td>`
                + `<td style="${td}" title="${escapeHtml(r.s.name)}">${escapeHtml(r.s.name)}</td>`
                + `<td style="${td}color:#888">${escapeHtml(r.d.segTxt.replace(/^segs? /, ''))}</td>`
                + `<td style="${td}">${r.d.lenFt.toLocaleString()} ft</td>`
                + `<td style="${td}">${offHtml}</td>`
                + `<td style="${td}color:#aaa" title="${escapeHtml(fromTxt)}">${escapeHtml(fromTxt)}</td>`
                + '</tr>';
        }).join('');
        wrap.innerHTML = `<table style="border-collapse:collapse;table-layout:fixed;width:max-content;min-width:100%;">`
            + `<colgroup>${cols}</colgroup><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
    }

    const KEY_DIFF_GEOM = 'aim-sd-diff-geom';
    let diffGeomSaveTimer = null;

    function saveDiffGeom() {
        if (!diffPanelEl) return;
        if (diffGeomSaveTimer) clearTimeout(diffGeomSaveTimer);
        diffGeomSaveTimer = setTimeout(() => {
            diffGeomSaveTimer = null;
            try {
                const r = diffPanelEl.getBoundingClientRect();
                gmSet(KEY_DIFF_GEOM, JSON.stringify({ left: r.left, top: r.top, w: r.width, h: r.height }));
            } catch (e) {}
        }, 300);
    }

    function openDiffPanel() {
        if (!diffPanelEl) {
            let geom = { left: 16, top: 70, w: 620, h: 440 };
            try {
                const raw = gmGet(KEY_DIFF_GEOM, null);
                if (raw) {
                    const g = JSON.parse(raw);
                    if (typeof g.left === 'number' && typeof g.w === 'number') geom = g;
                }
            } catch (e) {}
            // Keep it reachable if the window shrank since last session
            geom.left = Math.max(0, Math.min(geom.left, window.innerWidth - 120));
            geom.top = Math.max(0, Math.min(geom.top, window.innerHeight - 80));

            diffPanelEl = document.createElement('div');
            diffPanelEl.id = 'aim-sd-diff-panel';
            diffPanelEl.style.cssText = `position:fixed;top:${geom.top}px;left:${geom.left}px;width:${geom.w}px;height:${geom.h}px;`
                + 'z-index:2147480001;background:#14181f;color:#ddd;border:1px solid #2a3140;border-radius:6px;'
                + 'font:12px/1.5 monospace;box-shadow:0 4px 18px rgba(0,0,0,0.5);'
                + 'display:flex;flex-direction:column;resize:both;overflow:hidden;min-width:360px;min-height:220px;';
            diffPanelEl.innerHTML = ''
                + '<div id="aim-sd-diff-drag" style="padding:7px 10px;color:#7adfe6;font-weight:bold;border-bottom:1px solid #2a3140;cursor:move;user-select:none;flex:none;">'
                + '⚖ Site Diff — significant changes <span id="aim-sd-diff-close" style="float:right;cursor:pointer;color:#888">✕</span></div>'
                + '<div id="aim-sd-diff-status" style="padding:5px 10px;border-bottom:1px solid #222834;color:#aaa;flex:none;"></div>'
                + '<div style="display:flex;gap:6px;padding:5px 10px;border-bottom:1px solid #222834;align-items:center;flex:none;">'
                + '<input id="aim-sd-diff-search" type="text" placeholder="Filter name / old feature…" '
                + 'style="flex:1;min-width:60px;box-sizing:border-box;background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:3px 6px;font:inherit;outline:none;">'
                + '<select id="aim-sd-diff-type" style="background:#0e1218;color:#ddd;border:1px solid #2a3140;border-radius:3px;padding:3px 4px;font:inherit;">'
                + '<option value="all">All</option><option value="FP">FP</option><option value="FFZ">FFZ</option></select>'
                + '<label style="display:flex;align-items:center;gap:3px;color:#ff5252;cursor:pointer;white-space:nowrap;">'
                + '<input id="aim-sd-diff-new" type="checkbox"> NEW only</label>'
                + '<span id="aim-sd-diff-count" style="color:#666;white-space:nowrap;"></span>'
                + '</div>'
                + '<div id="aim-sd-diff-list" style="flex:1;overflow:auto;"></div>'
                + '<div style="padding:6px 10px;border-top:1px solid #222834;display:flex;gap:10px;flex-wrap:wrap;flex:none;">'
                + '<span id="aim-sd-diff-issues" style="cursor:pointer;color:#ff8ac2">🚩 Send to Issues</span>'
                + '<span id="aim-sd-diff-copy" style="cursor:pointer;color:#7adfe6">📋 Copy report</span>'
                + '<span id="aim-sd-diff-clear" style="cursor:pointer;color:#ff5252">Clear</span>'
                + '</div>';
            document.body.appendChild(diffPanelEl);

            const hoverCss = document.createElement('style');
            hoverCss.textContent = '#aim-sd-diff-list .aim-sd-tr:hover td{background:#222a38;}';
            diffPanelEl.appendChild(hoverCss);

            diffPanelEl.querySelector('#aim-sd-diff-close').addEventListener('click', () => { diffPanelEl.style.display = 'none'; });
            diffPanelEl.querySelector('#aim-sd-diff-issues').addEventListener('click', sendDiffIssues);
            diffPanelEl.querySelector('#aim-sd-diff-clear').addEventListener('click', () => clearDiff(true));
            diffPanelEl.querySelector('#aim-sd-diff-copy').addEventListener('click', () => {
                try {
                    navigator.clipboard.writeText(buildDiffReport())
                        .then(() => setDiffStatus('Report copied to clipboard.'))
                        .catch(e => { console.warn(`${TAG} clipboard write failed:`, e); setDiffStatus('Clipboard write failed.'); });
                } catch (e) { console.warn(`${TAG} clipboard unavailable:`, e); }
            });

            // Filters
            diffPanelEl.querySelector('#aim-sd-diff-search').addEventListener('input', (ev) => {
                diffFilter.text = ev.target.value.trim().toLowerCase();
                renderDiffList();
            });
            diffPanelEl.querySelector('#aim-sd-diff-type').addEventListener('change', (ev) => {
                diffFilter.type = ev.target.value;
                renderDiffList();
            });
            diffPanelEl.querySelector('#aim-sd-diff-new').addEventListener('change', (ev) => {
                diffFilter.newOnly = ev.target.checked;
                renderDiffList();
            });

            // Drag the panel by its header
            const dragBar = diffPanelEl.querySelector('#aim-sd-diff-drag');
            dragBar.addEventListener('pointerdown', (ev) => {
                if (ev.target.id === 'aim-sd-diff-close') return;
                ev.preventDefault();
                const r = diffPanelEl.getBoundingClientRect();
                const offX = ev.clientX - r.left, offY = ev.clientY - r.top;
                const onMove = (mv) => {
                    diffPanelEl.style.left = `${Math.max(0, mv.clientX - offX)}px`;
                    diffPanelEl.style.top = `${Math.max(0, mv.clientY - offY)}px`;
                };
                const onUp = () => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    saveDiffGeom();
                };
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
            try { new ResizeObserver(saveDiffGeom).observe(diffPanelEl); } catch (e) {}

            // Table interactions — delegated (the table is rebuilt on every
            // render, the wrapper is stable)
            const listWrap = diffPanelEl.querySelector('#aim-sd-diff-list');
            let colResizing = false;
            listWrap.addEventListener('pointerdown', (ev) => {
                const grip = ev.target.closest('.aim-sd-grip');
                if (!grip) return;
                ev.preventDefault();
                ev.stopPropagation();
                colResizing = true;
                const ci = Number(grip.getAttribute('data-ci'));
                const startX = ev.clientX;
                const startW = DIFF_COLS[ci].w;
                const colEl = listWrap.querySelector(`col[data-ci="${ci}"]`);
                const onMove = (mv) => {
                    DIFF_COLS[ci].w = Math.max(32, startW + (mv.clientX - startX));
                    if (colEl) colEl.style.width = `${DIFF_COLS[ci].w}px`;
                };
                const onUp = () => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    // Swallow the click that follows so it doesn't sort
                    setTimeout(() => { colResizing = false; }, 0);
                };
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
            listWrap.addEventListener('click', (ev) => {
                if (colResizing) return;
                const th = ev.target.closest('th[data-sk]');
                if (th) {
                    const k = th.getAttribute('data-sk');
                    if (diffSort.key === k) diffSort.dir = -diffSort.dir;
                    else diffSort = { key: k, dir: k === 'name' || k === 'kind' || k === 'from' ? 1 : -1 };
                    renderDiffList();
                    return;
                }
                const row = ev.target.closest('tr[data-di]');
                if (!row) return;
                const s = diffStretches[Number(row.getAttribute('data-di'))];
                if (!s) return;
                const map = getLeafletMap();
                const L = getL();
                if (!map || !L) return;
                try {
                    map.fitBounds(L.latLngBounds(s.pts).pad(0.6));
                    if (s._layer) {
                        s._layer.setStyle({ weight: 10 });
                        setTimeout(() => { try { s._layer.setStyle({ weight: 5 }); } catch (e) {} }, 1200);
                    }
                } catch (e) { console.warn(`${TAG} zoom-to-stretch failed:`, e); }
            });
        }
        diffPanelEl.style.display = 'flex';
        renderDiffList();
    }

    // ==================================================================
    // Phase 3a — Migration Planner (READ-ONLY)
    //
    // Direction: the OFFLINE site (open on screen, the rebuilt copy) is the
    // source of truth; the LIVE site (the shadow) is the target. Entities
    // match by type + name. The planner only reports what the executor
    // (Phase 3b, not built yet) would do — it never writes.
    // Full/CSM mode only.
    // ==================================================================
    const MIG_EPS_M = 0.3;   // vertices closer than this count as unmoved

    function isFullMode() {
        try { return localStorage.getItem('aim-mode') === 'full'; }
        catch (e) { return false; }
    }

    function migKey(e) { return `${e.type}:${String(e.name || '').trim().toLowerCase()}`; }

    // Short/long labels for an entity type (also fixes v0.40 where
    // planMigration called this without it existing → ReferenceError).
    function typeReg(type) {
        const t = SHADOW_TYPES.find(x => x.type === type);
        if (t) return { short: t.key.toUpperCase(), label: t.label };
        return { short: `T${type}`, label: `type ${type}` };
    }

    function migPtEqual(a, b, proj) {
        if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return false;
        const A = proj.toXY(a), B = proj.toXY(b);
        return Math.hypot(A.x - B.x, A.y - B.y) <= MIG_EPS_M;
    }

    function numEq(a, b, tol) {
        if (a == null && b == null) return true;
        if (typeof a !== 'number' || typeof b !== 'number') return a === b;
        return Math.abs(a - b) <= (tol || 0.01);
    }

    // Reasons an entity on Live would need an update to match Offline
    function migCompare(off, live, proj) {
        const reasons = [];
        if (off.type === 15) {
            const oa = Array.isArray(off.arcs) ? off.arcs : [];
            const la = Array.isArray(live.arcs) ? live.arcs : [];
            if (oa.length !== la.length) {
                reasons.push(`arcs ${la.length}→${oa.length}`);
            } else {
                let moved = 0, alt = 0;
                for (let i = 0; i < oa.length; i++) {
                    const o = oa[i], l = la[i];
                    if (!migPtEqual(o.point_a, l.point_a, proj) || !migPtEqual(o.point_b, l.point_b, proj)) moved++;
                    if (!numEq(o.min_alt, l.min_alt) || !numEq(o.max_alt, l.max_alt)
                        || !numEq(o.min_emergency_alt, l.min_emergency_alt)) alt++;
                }
                if (moved) reasons.push(`${moved} arc(s) moved`);
                if (alt) reasons.push(`${alt} arc altitude band(s)`);
            }
        } else {
            const oc = entityCoords(off) || [];
            const lc = entityCoords(live) || [];
            if (oc.length !== lc.length) {
                reasons.push(`vertices ${lc.length}→${oc.length}`);
            } else {
                let moved = 0;
                for (let i = 0; i < oc.length; i++) if (!migPtEqual(oc[i], lc[i], proj)) moved++;
                if (moved) reasons.push(`${moved} vertex(es) moved`);
            }
            const or = off.restrictions, lr = live.restrictions;
            if (or && lr && (typeof or.minAlt === 'number' || typeof lr.minAlt === 'number')) {
                if (!numEq(or.minAlt, lr.minAlt) || !numEq(or.maxAlt, lr.maxAlt)) {
                    reasons.push(`alt band ${lr.minAlt}–${lr.maxAlt}→${or.minAlt}–${or.maxAlt} m`);
                }
            }
        }
        if (String(off.description || '') !== String(live.description || '')) reasons.push('description');
        if (off.type === 19) {
            if (String(off.general_marker_type || '') !== String(live.general_marker_type || '')) reasons.push('marker type');
            if (!numEq(off.marker_height, live.marker_height)) reasons.push('marker height');
        }
        if (off.type === 3 && !!off.is_unshielded !== !!live.is_unshielded) reasons.push('unshielded flag');
        return reasons;
    }

    let migPlan = null;   // { rows, summary, offLabel, liveLabel, liveSiteId }

    async function planMigration() {
        if (!isFullMode()) {
            openMigPanel();
            setMigBody('<span style="color:#ff5252">CSM Full mode required — migration tools are inert in Lite mode.</span>');
            return;
        }
        if (!siteID) { openMigPanel(); setMigBody('No site loaded.'); return; }
        const src = shadowSourceFor(siteID);
        if (!src) {
            openMigPanel();
            setMigBody('Pick a shadow first — the LIVE (original) site this plan would write to.');
            return;
        }
        openMigPanel();
        setMigBody('<span style="color:#aaa">Building plan…</span>');
        try {
            const [offline, live] = await Promise.all([
                fetchShadowEntities({ id: siteID, server: THIS_SERVER }, true),
                getShadowEntities(siteID, src, true),
            ]);
            if (!offline || !live) { setMigBody('Could not fetch one of the sides — see console.'); return; }
            let anchorLat = null;
            for (const e of live.concat(offline)) {
                const cs = entityCoords(e);
                if (cs && cs[0] && typeof cs[0].lat === 'number') { anchorLat = cs[0].lat; break; }
                if (Array.isArray(e.arcs) && e.arcs[0] && e.arcs[0].point_a) { anchorLat = e.arcs[0].point_a.lat; break; }
            }
            const proj = projector(anchorLat || 0);

            const SKIP_TYPES = { 8: 'Base Station', 98: 'Safe Zone' };   // hardware-bound — never migrated
            const rows = [];
            const liveByKey = new Map();
            const dupLive = new Set();
            live.forEach(e => {
                if (SKIP_TYPES[e.type]) return;
                const k = migKey(e);
                if (liveByKey.has(k)) dupLive.add(k);
                else liveByKey.set(k, e);
            });
            const offSeen = new Set();
            const dupOff = new Set();
            offline.forEach(e => {
                const k = migKey(e);
                if (offSeen.has(k)) dupOff.add(k);
                offSeen.add(k);
            });
            const matchedLiveIds = new Set();

            offline.forEach(off => {
                const reg = typeReg(off.type);
                if (SKIP_TYPES[off.type]) {
                    rows.push({ action: 'skip', kind: reg.short, name: off.name, note: `${SKIP_TYPES[off.type]} — hardware-bound, never migrated` });
                    return;
                }
                const k = migKey(off);
                if (dupOff.has(k) || dupLive.has(k)) {
                    rows.push({ action: 'review', kind: reg.short, name: off.name, note: 'ambiguous — duplicate name+type on one side, match manually' });
                    return;
                }
                const liveMatch = liveByKey.get(k);
                if (!liveMatch) {
                    const detail = off.type === 15 ? `${(off.arcs || []).length} arcs` : `${(entityCoords(off) || []).length} verts`;
                    rows.push({ action: 'create', kind: reg.short, name: off.name, note: detail });
                    return;
                }
                matchedLiveIds.add(liveMatch.id);
                const reasons = migCompare(off, liveMatch, proj);
                if (reasons.length) {
                    rows.push({ action: 'update', kind: reg.short, name: off.name, liveId: liveMatch.id, note: reasons.join(', ') });
                } else {
                    rows.push({ action: 'same', kind: reg.short, name: off.name, liveId: liveMatch.id });
                }
            });
            live.forEach(l => {
                if (SKIP_TYPES[l.type] || matchedLiveIds.has(l.id)) return;
                const k = migKey(l);
                if (dupLive.has(k) || dupOff.has(k)) return;   // already flagged as review
                const reg = typeReg(l.type);
                if (l.type === 3) {
                    rows.push({ action: 'review', kind: reg.short, name: l.name, liveId: l.id, note: 'asset exists on Live only — assets are NEVER auto-deleted (flight/image/issue history)' });
                } else {
                    rows.push({ action: 'delete', kind: reg.short, name: l.name, liveId: l.id, note: 'exists on Live only' });
                }
            });

            const order = { update: 0, create: 1, delete: 2, review: 3, skip: 4, same: 5 };
            rows.sort((a, b) => (order[a.action] - order[b.action]) || String(a.name).localeCompare(String(b.name)));
            const summary = {};
            rows.forEach(r => { summary[r.action] = (summary[r.action] || 0) + 1; });
            migPlan = {
                rows, summary,
                offLabel: `site ${siteID}`,
                liveLabel: shadowSourceLabel(src),
                liveSiteId: src.kind === 'site' ? src.id : null,
                liveEntities: live,
            };
            console.log(`${TAG} migration plan: ${JSON.stringify(summary)}`);
            renderMigPlan();
        } catch (e) {
            console.warn(`${TAG} planMigration threw:`, e);
            setMigBody('Plan failed — see console.');
        }
    }

    const MIG_ACTION_STYLE = {
        update: '#ffa030', create: '#5fff5f', delete: '#ff5252',
        review: '#ff8ac2', skip: '#888', same: '#556',
    };

    function buildMigReport() {
        if (!migPlan) return '';
        const lines = [];
        lines.push('AIM Site Diff — migration plan (READ-ONLY preview, nothing was written)');
        lines.push(`Source (Offline/new): ${migPlan.offLabel} · Target (Live/original): ${migPlan.liveLabel}`);
        lines.push(Object.keys(migPlan.summary).map(k => `${k.toUpperCase()} ${migPlan.summary[k]}`).join(' · '));
        lines.push('');
        migPlan.rows.filter(r => r.action !== 'same').forEach(r => {
            lines.push(`${r.action.toUpperCase()} ${r.kind} "${r.name}"${r.liveId ? ` (live id ${r.liveId})` : ''}${r.note ? ` — ${r.note}` : ''}`);
        });
        return lines.join('\n');
    }

    function renderMigPlan() {
        if (!migPlan) return;
        const s = migPlan.summary;
        const chip = (a, label) => (s[a] ? `<span style="color:${MIG_ACTION_STYLE[a]}">${label} ${s[a]}</span>` : '');
        const head = [chip('update', 'UPDATE'), chip('create', 'CREATE'), chip('delete', 'DELETE'),
            chip('review', 'REVIEW'), chip('skip', 'skip'), chip('same', 'unchanged')]
            .filter(Boolean).join(' · ');
        const rowsHtml = migPlan.rows.filter(r => r.action !== 'same').map(r =>
            `<div style="padding:2px 6px;border-bottom:1px solid #1d2430;">`
            + `<span style="color:${MIG_ACTION_STYLE[r.action]};font-weight:bold">${r.action.toUpperCase()}</span> `
            + `<span style="color:#7adfe6">${r.kind}</span> ${escapeHtml(String(r.name || ''))}`
            + `${r.note ? `<span style="color:#888"> — ${escapeHtml(r.note)}</span>` : ''}</div>`
        ).join('') || '<div style="color:#5fff5f;padding:6px">Sites are identical (within tolerance) — nothing to migrate ✓</div>';
        setMigBody(
            `<div style="padding:4px 6px;border-bottom:1px solid #222834;">${migPlan.offLabel} (source) → ${escapeHtml(migPlan.liveLabel)} (target)<br>${head}</div>`
            + `<div style="max-height:46vh;overflow-y:auto;">${rowsHtml}</div>`
            + '<div style="padding:6px;color:#888;font-size:11px;">Read-only preview. The executor (Phase 3b) is gated on delete-endpoint + mission-reference recon.</div>'
        );
    }

    function downloadJson(filename, data) {
        // Blob downloads from the sandboxed map iframe are blocked — hand
        // the anchor to the TOP document (same-origin), the proven pattern
        // from the Site Setup Analyzer's KML export.
        try {
            const topWin = window.top || window;
            const doc = topWin.document;
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = topWin.URL.createObjectURL(blob);
            const a = doc.createElement('a');
            a.href = url;
            a.download = filename;
            doc.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => { try { topWin.URL.revokeObjectURL(url); } catch (e) {} }, 5000);
            return true;
        } catch (e) {
            console.warn(`${TAG} download failed:`, e);
            return false;
        }
    }

    async function backupLiveSite() {
        if (!siteID) return;
        const src = shadowSourceFor(siteID);
        if (!src) { openMigPanel(); setMigBody('Pick a shadow (the Live site) first.'); return; }
        if (src.kind !== 'site') { openMigPanel(); setMigBody('Shadow is already a JSON file — nothing to back up.'); return; }
        const ents = await fetchShadowEntities(src, true);
        if (!ents) { openMigPanel(); setMigBody('Backup fetch failed — see console.'); return; }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const name = `site-${src.id}-map_objects-${stamp}.json`;
        if (downloadJson(name, ents)) {
            console.log(`${TAG} rollback backup downloaded: ${name} (${ents.length} entities)`);
            openMigPanel();
            setMigBody(`<span style="color:#5fff5f">Backup saved: ${escapeHtml(name)} (${ents.length} entities).</span> This exact file re-uploads as a shadow if a rollback reference is ever needed.`);
        }
    }

    // ---------------- Migration panel ----------------
    let migPanelEl = null;

    function setMigBody(html) {
        const el = migPanelEl && migPanelEl.querySelector('#aim-sd-mig-body');
        if (el) el.innerHTML = html;
    }

    function openMigPanel() {
        if (!migPanelEl) {
            migPanelEl = document.createElement('div');
            migPanelEl.id = 'aim-sd-mig-panel';
            migPanelEl.style.cssText = 'position:fixed;top:90px;left:40px;z-index:2147480002;width:520px;'
                + 'background:#14181f;color:#ddd;border:1px solid #2a3140;border-radius:6px;'
                + 'font:12px/1.5 monospace;box-shadow:0 4px 18px rgba(0,0,0,0.5);';
            migPanelEl.innerHTML = ''
                + '<div id="aim-sd-mig-drag" style="padding:7px 10px;color:#7adfe6;font-weight:bold;border-bottom:1px solid #2a3140;cursor:move;user-select:none;">'
                + '🧭 Site Diff — migration plan (read-only) <span id="aim-sd-mig-close" style="float:right;cursor:pointer;color:#888">✕</span></div>'
                + '<div id="aim-sd-mig-body"></div>'
                + '<div style="padding:6px 10px;border-top:1px solid #222834;display:flex;gap:10px;flex-wrap:wrap;">'
                + '<span id="aim-sd-mig-copy" style="cursor:pointer;color:#7adfe6">📋 Copy plan</span>'
                + '<span id="aim-sd-mig-backup" style="cursor:pointer;color:#5fff5f">💾 Backup Live JSON</span>'
                + '</div>';
            document.body.appendChild(migPanelEl);
            migPanelEl.querySelector('#aim-sd-mig-close').addEventListener('click', () => { migPanelEl.style.display = 'none'; });
            migPanelEl.querySelector('#aim-sd-mig-backup').addEventListener('click', () => { backupLiveSite(); });
            migPanelEl.querySelector('#aim-sd-mig-copy').addEventListener('click', () => {
                const txt = buildMigReport();
                if (!txt) return;
                try {
                    navigator.clipboard.writeText(txt)
                        .then(() => console.log(`${TAG} migration plan copied`))
                        .catch(e => console.warn(`${TAG} clipboard write failed:`, e));
                } catch (e) { console.warn(`${TAG} clipboard unavailable:`, e); }
            });
            const dragBar = migPanelEl.querySelector('#aim-sd-mig-drag');
            dragBar.addEventListener('pointerdown', (ev) => {
                if (ev.target.id === 'aim-sd-mig-close') return;
                ev.preventDefault();
                const r = migPanelEl.getBoundingClientRect();
                const offX = ev.clientX - r.left, offY = ev.clientY - r.top;
                const onMove = (mv) => {
                    migPanelEl.style.left = `${Math.max(0, mv.clientX - offX)}px`;
                    migPanelEl.style.top = `${Math.max(0, mv.clientY - offY)}px`;
                };
                const onUp = () => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                };
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }
        migPanelEl.style.display = 'block';
    }

    // ==================================================================
    // Phase 3a — Import (create-only copy of shadow entities onto THIS
    // site). Direction is the REVERSE of the migration plan: the shadow
    // (a live site or an uploaded /map_objects JSON backup) is the
    // SOURCE and the currently open site is the TARGET. Create-only —
    // existing target entities are never modified or deleted; a source
    // entity whose type+name already exists on the target is skipped.
    // Write recipe is the proven one from Asset Inspector
    // buildWriteBody + Map Editor commitSplit: strip id, site_id ←
    // target, points ← coords, strip site/coords/polygon/
    // asset_waypoints, mountain_terrain_site ← target /sites/<id>/,
    // type-3 custom.new_poi_type_str = "", arc id/mapobject stripped.
    // Full/CSM mode only.
    // ==================================================================
    const KEY_IMPORT_TYPES = 'aim-sd-import-types';
    const KEY_IMPORT_KML = 'aim-sd-import-kml';
    const IMPORT_SKIP_TYPES = { 8: 'Base Station', 98: 'Safe Zone' };   // hardware-bound — never imported
    const IMPORT_POST_GAP_MS = 120;

    // Power-line KMLs live OUTSIDE Percepto — per-site files in the
    // private data repo (<siteID>-distro.kml / <siteID>-trans.kml),
    // fetched by Map Styler with the shared PAT. "Importing" them =
    // copying every <srcID>-* root file to <tgtID>-* via the GitHub
    // Contents API (create-only — existing target files are skipped).
    // api.github.com sends CORS headers, so plain fetch works — no
    // GM_xmlhttpRequest / @connect needed.
    const DATA_REPO = 'Ned-Yap/aim-userscripts-data';
    const DATA_BRANCH = 'main';
    const GH_API = 'https://api.github.com';
    let cachedToken = '';   // PAT from Control Panel TOKEN_VALUE broadcast

    function loadImportTypes() {
        const def = { fp: false, ffz: false, nfz: false, asset: true, gm: false };
        try {
            const raw = gmGet(KEY_IMPORT_TYPES, null);
            if (raw) {
                const s = JSON.parse(raw);
                Object.keys(def).forEach(k => { if (typeof s[k] === 'boolean') def[k] = s[k]; });
            }
        } catch (e) { console.warn(`${TAG} loadImportTypes:`, e); }
        return def;
    }
    let importTypes = loadImportTypes();
    function saveImportTypes() {
        try { gmSet(KEY_IMPORT_TYPES, JSON.stringify(importTypes)); }
        catch (e) { console.warn(`${TAG} saveImportTypes:`, e); }
    }
    let importKml = gmGet(KEY_IMPORT_KML, false) === true;

    function readCsrfFrom(doc) {
        try {
            const m = ((doc && doc.cookie) || '').match(/(?:^|;\s*)csrftoken=([^;]+)/);
            return m ? decodeURIComponent(m[1]) : null;
        } catch (e) { return null; }
    }

    function readDomCsrf(doc) {
        try {
            const inp = doc.querySelector('input[name="csrfmiddlewaretoken"]');
            if (inp && inp.value) return inp.value;
            const meta = doc.querySelector('meta[name="csrf-token"], meta[name="csrf_token"], meta[name="csrftoken"]');
            if (meta && meta.content) return meta.content;
        } catch (e) {}
        return null;
    }

    // Django accepts a MASKED form token (csrfmiddlewaretoken) in the
    // X-CSRFToken header — scraping any same-session server-rendered
    // page works even when the cookie itself is HttpOnly-invisible.
    async function scrapeCsrfFromPage(path) {
        try {
            const r = await fetchWithTimeout(path, { credentials: 'same-origin', headers: { 'Accept': 'text/html' } }, 15000);
            if (!r.ok) return null;
            const html = await r.text();
            let m = html.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/);
            if (!m) m = html.match(/value=["']([^"']{32,128})["'][^>]*name=["']csrfmiddlewaretoken["']/);
            if (!m) m = html.match(/csrf[_-]?token["']?\s*[:=]\s*["']([A-Za-z0-9+/=]{32,128})["']/i);
            return m ? m[1] : null;
        } catch (e) { return null; }
    }

    // v0.52 ladder. Percepto's csrftoken cookie is HttpOnly in at least
    // some sessions (live-confirmed: only Amplitude cookies visible in
    // both frames while credentialed fetches work), so the sniffed
    // native-request token is the PRIMARY source; cookie reads are kept
    // for sessions where the cookie is still JS-visible; DOM + rendered
    // -page scrapes are last-ditch.
    async function resolveCsrfToken() {
        const attempts = [];
        let t = readSniffedCsrf();
        attempts.push(`sniffed native token: ${t ? 'HIT' : 'miss'}`);
        if (!t) {
            t = readCsrfFrom(document)
                || (typeof unsafeWindow !== 'undefined' && unsafeWindow.document ? readCsrfFrom(unsafeWindow.document) : null);
            if (!t) { try { t = readCsrfFrom(window.top.document); } catch (e) {} }
            attempts.push(`cookies: ${t ? 'HIT' : 'miss'}`);
        }
        if (!t) {
            t = readDomCsrf(document);
            if (!t) { try { t = readDomCsrf(window.top.document); } catch (e) {} }
            attempts.push(`DOM token: ${t ? 'HIT' : 'miss'}`);
        }
        if (!t) {
            t = await scrapeCsrfFromPage('/');
            attempts.push(`scrape /: ${t ? 'HIT' : 'miss'}`);
        }
        if (!t) {
            t = await scrapeCsrfFromPage('/admin/login/');
            attempts.push(`scrape /admin/login/: ${t ? 'HIT' : 'miss'}`);
        }
        console.log(`${TAG} csrf token resolution: ${attempts.join(' → ')}`);
        return t;
    }

    const impSiteCfgCache = {};
    async function fetchTargetSiteCfg(sid, force) {
        if (!force && impSiteCfgCache[sid]) return impSiteCfgCache[sid];
        const r = await fetchWithTimeout(`/sites/${encodeURIComponent(sid)}/`, {
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
        }, 20000);
        if (!r.ok) throw new Error(`/sites/${sid}/ HTTP ${r.status}`);
        const j = await r.json();
        impSiteCfgCache[sid] = j;
        return j;
    }

    // Read-shape source entity → write body that CREATES it on the
    // target site. Everything is copied verbatim (name, description,
    // custom subtype fields, restrictions, validated, unshielded flag,
    // marker fields) — only identity + site linkage is rewritten.
    function buildImportBody(entity, targetSiteId, siteCfg) {
        const b = JSON.parse(JSON.stringify(entity));
        delete b.id;                                   // no id ⇒ server creates
        b.site_id = Number(targetSiteId);
        b.points = entityCoords(entity) || [];
        delete b.site;
        delete b.coords;
        delete b.polygon;
        delete b.asset_waypoints;
        b.mountain_terrain_site = !!(siteCfg && siteCfg.mountain_terrain);
        if (b.type === 3) {
            // Server rule #5: asset saves must carry custom.new_poi_type_str
            // ("" = keep poi_type_str as an existing type). Omitting it can
            // 400 or silently reset the subtype.
            if (!b.custom || typeof b.custom !== 'object') b.custom = {};
            b.custom.new_poi_type_str = '';
        }
        if (Array.isArray(b.arcs)) {
            b.arcs.forEach(a => {
                if (!a) return;
                delete a.id;                           // server assigns fresh arc ids on create
                delete a.mapobject;
                if (a.point_a && a.point_b && !Array.isArray(a.points)) a.points = [a.point_a, a.point_b];
            });
        }
        return b;
    }

    // impState: { srcLabel, targetCount, rows, running, armed, report }
    // row: { ent, key, action:'create'|'exists'|'skip', note }
    let impState = null;
    let impPanelEl = null;
    let impArmTimer = null;

    function setImpBody(html) {
        const el = impPanelEl && impPanelEl.querySelector('#aim-sd-imp-body');
        if (el) el.innerHTML = html;
    }
    function setImpStatus(msg, color) {
        const el = impPanelEl && impPanelEl.querySelector('#aim-sd-imp-status');
        if (el) el.innerHTML = `<span style="color:${color || '#aaa'}">${msg}</span>`;
    }

    async function prepareImport() {
        if (!isFullMode()) {
            setImpBody('<div style="padding:8px"><span style="color:#ff5252">CSM Full mode required — import tools are inert in Lite mode.</span></div>');
            return;
        }
        if (!siteID) { setImpBody('<div style="padding:8px">No site loaded.</div>'); return; }
        const src = shadowSourceFor(siteID);
        if (!src) {
            setImpBody('<div style="padding:8px">Pick a shadow first (🗺 Choose shadow) — the shadow is the SOURCE this import copies FROM. A live site or an uploaded JSON backup both work.</div>');
            return;
        }
        if (src.kind === 'site' && src.server === THIS_SERVER && String(src.id) === String(siteID)) {
            setImpBody('<div style="padding:8px"><span style="color:#ff5252">The shadow IS this site — nothing to import.</span></div>');
            return;
        }
        setImpBody('<div style="padding:8px;color:#aaa">Loading source + target…</div>');
        try {
            const [source, target] = await Promise.all([
                getShadowEntities(siteID, src, src.kind === 'site'),
                fetchShadowEntities({ id: String(siteID), server: THIS_SERVER }, true),
            ]);
            if (!source || !target) {
                setImpBody('<div style="padding:8px"><span style="color:#ff5252">Could not load one of the sides — see console.</span>'
                    + (src.kind === 'file' ? ' Re-upload the backup via the picker if it aged out of storage.' : '') + '</div>');
                return;
            }
            const targetKeys = new Set();
            target.forEach(e => targetKeys.add(migKey(e)));
            const rows = source.map(ent => {
                const reg = typeReg(ent.type);
                if (IMPORT_SKIP_TYPES[ent.type]) {
                    return { ent, key: null, action: 'skip', note: `${IMPORT_SKIP_TYPES[ent.type]} — hardware-bound, never imported` };
                }
                const key = TYPE_TO_KEY[ent.type] || null;
                if (!key) return { ent, key: null, action: 'skip', note: `unknown type ${ent.type}` };
                const hasGeom = !!(entityCoords(ent) || (Array.isArray(ent.arcs) && ent.arcs.length));
                if (!hasGeom) return { ent, key, action: 'skip', note: 'no geometry' };
                if (targetKeys.has(migKey(ent))) {
                    return { ent, key, action: 'exists', note: `${reg.short} with this name already on target — create-only, skipped` };
                }
                return { ent, key, action: 'create', note: '' };
            });
            impState = {
                srcLabel: shadowSourceLabel(src),
                srcSiteId: src.kind === 'site' ? src.id : null,
                srcServer: src.kind === 'site' ? src.server : null,
                targetCount: target.length,
                rows, running: false, armed: false, report: null,
            };
            renderImportPlan();
        } catch (e) {
            console.warn(`${TAG} prepareImport threw:`, e);
            setImpBody('<div style="padding:8px"><span style="color:#ff5252">Prepare failed — see console.</span></div>');
        }
    }

    function importSelectedRows() {
        if (!impState) return [];
        return impState.rows.filter(r => r.action === 'create' && r.key && importTypes[r.key]);
    }

    function renderImportPlan() {
        if (!impState) return;
        const counts = {};   // key → {create, exists, skip}
        SHADOW_TYPES.forEach(t => { counts[t.key] = { create: 0, exists: 0, skip: 0 }; });
        impState.rows.forEach(r => {
            if (r.key && counts[r.key]) counts[r.key][r.action === 'create' ? 'create' : (r.action === 'exists' ? 'exists' : 'skip')]++;
        });
        const typeRows = SHADOW_TYPES.filter(t => !IMPORT_SKIP_TYPES[t.type]).map(t => {
            const c = counts[t.key];
            const dis = impState.running ? 'disabled' : '';
            const extra = [c.exists ? `<span style="color:#ffa030">${c.exists} exist</span>` : '',
                c.skip ? `<span style="color:#888">${c.skip} skipped</span>` : ''].filter(Boolean).join(' · ');
            return `<label style="display:flex;gap:8px;align-items:center;padding:2px 6px;cursor:pointer;">`
                + `<input type="checkbox" data-imp-type="${t.key}" ${importTypes[t.key] ? 'checked' : ''} ${dis}>`
                + `<span style="color:${t.color};min-width:100px">${t.label}</span>`
                + `<span style="color:#5fff5f">${c.create} to create</span>`
                + (extra ? `<span>· ${extra}</span>` : '') + '</label>';
        }).join('');
        const sel = importSelectedRows();
        const preview = sel.slice(0, 400).map(r => {
            const reg = typeReg(r.ent.type);
            const detail = r.ent.type === 15 ? `${(r.ent.arcs || []).length} arcs` : `${(entityCoords(r.ent) || []).length} verts`;
            return `<div style="padding:1px 6px;border-bottom:1px solid #1d2430;">`
                + `<span style="color:#5fff5f;font-weight:bold">CREATE</span> `
                + `<span style="color:#7adfe6">${reg.short}</span> ${escapeHtml(String(r.ent.name || '(unnamed)'))}`
                + `<span style="color:#888"> — ${detail}</span></div>`;
        }).join('');
        const targetNote = impState.targetCount
            ? `<span style="color:#ffa030">⚠ target already has ${impState.targetCount} entities</span>`
            : '<span style="color:#5fff5f">target site is empty ✓</span>';
        const kmlPossible = !!impState.srcSiteId;
        const kmlOn = !!(importKml && kmlPossible);
        let kmlNote;
        if (!kmlPossible) kmlNote = '<span style="color:#888">needs a live-site shadow (JSON backups carry no site id)</span>';
        else {
            const srcKml = `${kmlEnvPrefix(impState.srcServer)}${impState.srcSiteId}`;
            const tgtKml = `${kmlEnvPrefix(THIS_SERVER)}${siteID}`;
            kmlNote = `<span style="color:#888">copy ${escapeHtml(srcKml)}-* → ${escapeHtml(tgtKml)}-* in the data repo (create-only)</span>`
                + (cachedToken ? '' : ' <span style="color:#ffa030">— needs the GitHub token (AIM Controls gear)</span>');
        }
        const kmlRow = `<label style="display:flex;gap:8px;align-items:center;padding:4px 6px;border-bottom:1px solid #222834;`
            + `cursor:${kmlPossible ? 'pointer' : 'default'};${kmlPossible ? '' : 'opacity:0.55;'}">`
            + `<input type="checkbox" data-imp-kml="1" ${kmlOn ? 'checked' : ''} ${(!kmlPossible || impState.running) ? 'disabled' : ''}>`
            + `<span style="color:#ffd54f;min-width:100px">⚡ Power lines</span>${kmlNote}</label>`;
        const runnable = sel.length || kmlOn;
        const runLabel = impState.armed
            ? `⚠ Click again to RUN (${sel.length} entities${kmlOn ? ' + KMLs' : ''}) — this writes for real`
            : `🚀 Create ${sel.length} entities${kmlOn ? ' + copy power-line KMLs' : ''}`;
        const runColor = impState.armed ? '#ff5252' : (runnable ? '#5fff5f' : '#555');
        setImpBody(''
            + `<div style="padding:4px 6px;border-bottom:1px solid #222834;">`
            + `SOURCE: ${escapeHtml(impState.srcLabel)} → TARGET: this site (${escapeHtml(String(siteID))}) · ${targetNote}<br>`
            + `<span style="color:#888">Create-only: existing target entities are never touched. Fields copy verbatim (incl. validated flag).</span></div>`
            + `<div style="padding:4px 0;border-bottom:1px solid #222834;">${typeRows}</div>`
            + kmlRow
            + `<div style="max-height:34vh;overflow-y:auto;">${preview || '<div style="color:#888;padding:6px">Nothing selected to create.</div>'}`
            + (sel.length > 400 ? `<div style="color:#888;padding:4px 6px">…and ${sel.length - 400} more</div>` : '') + '</div>'
            + `<div id="aim-sd-imp-status" style="padding:4px 6px;border-top:1px solid #222834;min-height:18px;"></div>`
            + `<div style="padding:6px;display:flex;gap:12px;flex-wrap:wrap;border-top:1px solid #222834;">`
            + `<span data-imp="run" style="cursor:${runnable ? 'pointer' : 'default'};color:${runColor};font-weight:bold">${runLabel}</span>`
            + `<span data-imp="backup-src" style="cursor:pointer;color:#7adfe6">💾 Backup source JSON</span>`
            + `<span data-imp="refresh" style="cursor:pointer;color:#7adfe6">⟳ Re-check</span>`
            + (impState.report ? `<span data-imp="log" style="cursor:pointer;color:#ffa030">📄 Download run log</span>` : '')
            + '</div>');
    }

    async function runImport() {
        if (!impState || impState.running) return;
        const sel = importSelectedRows();
        const kmlOn = !!(importKml && impState.srcSiteId);
        if (!sel.length && !kmlOn) { setImpStatus('Nothing selected.', '#888'); return; }
        if (!impState.armed) {
            impState.armed = true;
            renderImportPlan();
            setImpStatus('Armed — click again within 5s to run.', '#ffa030');
            clearTimeout(impArmTimer);
            impArmTimer = setTimeout(() => {
                if (impState && impState.armed && !impState.running) { impState.armed = false; renderImportPlan(); }
            }, 5000);
            return;
        }
        clearTimeout(impArmTimer);
        impState.armed = false;
        impState.running = true;
        renderImportPlan();
        let csrf = null;
        if (sel.length) {
            setImpStatus('resolving CSRF token…');
            csrf = await resolveCsrfToken();
            if (!csrf) {
                setImpStatus('no CSRF token yet — make ONE small native edit anywhere in Percepto (e.g. save any entity or move a marker), which lets the sniffer capture the app\'s own token, then re-run. Console shows the resolution trace.', '#ff5252');
                impState.running = false;
                return;
            }
        }
        const created = [];
        const errors = [];
        try {
            const cfg = sel.length ? await fetchTargetSiteCfg(siteID, true) : null;
            for (let i = 0; i < sel.length; i++) {
                const ent = sel[i].ent;
                const label = `${typeReg(ent.type).short} "${ent.name || '(unnamed)'}"`;
                setImpStatus(`creating ${i + 1}/${sel.length} — ${escapeHtml(label)}…`);
                try {
                    const body = buildImportBody(ent, siteID, cfg);
                    const r = await fetchWithTimeout('/map_objects/', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'X-CSRFToken': csrf },
                        body: JSON.stringify(body),
                    }, 30000);
                    const txt = await r.text();
                    if (r.status === 403) {
                        // Stale/rejected token poisons EVERY remaining POST —
                        // clear the banked one and abort instead of 403-ing
                        // down the whole list.
                        try { ((typeof unsafeWindow !== 'undefined') ? unsafeWindow : window).localStorage.removeItem(CSRF_LS_KEY); } catch (e2) {}
                        throw new Error(`CSRF-ABORT: server 403 — banked token cleared; make one native edit (so the sniffer re-captures) and re-run. ${(txt || '').slice(0, 120)}`);
                    }
                    if (!r.ok) throw new Error(`server ${r.status} — ${(txt || '').slice(0, 200)}`);
                    let j = null;
                    try { j = JSON.parse(txt); } catch (e) {}
                    if (!j || !j.map_objects || j.map_objects.id == null) throw new Error(`unexpected response — ${(txt || '').slice(0, 150)}`);
                    created.push({ id: j.map_objects.id, name: ent.name, type: ent.type });
                } catch (e) {
                    if (String(e && e.message || '').startsWith('CSRF-ABORT')) throw e;
                    console.warn(`${TAG} import create failed for ${label}:`, e);
                    errors.push({ name: ent.name, type: ent.type, reason: String(e && e.message || e) });
                }
                await new Promise(res => setTimeout(res, IMPORT_POST_GAP_MS));
            }
            // Verify — fresh fetch of the target, every created id must be there
            const verifyProblems = [];
            if (sel.length) {
                setImpStatus('verifying against a fresh fetch…');
                const fresh = await fetchShadowEntities({ id: String(siteID), server: THIS_SERVER }, true);
                if (!fresh) {
                    verifyProblems.push('verify fetch failed — created entities unconfirmed, check the site manually');
                } else {
                    created.forEach(c => {
                        if (!fresh.some(e => e && e.id === c.id)) verifyProblems.push(`created "${c.name}" (id ${c.id}) missing from fresh fetch`);
                    });
                }
            }
            // Power-line KMLs last — a CSRF/entity abort never leaves
            // half-copied repo files, and a KML failure never blocks entities
            let kmlResult = null;
            if (kmlOn) {
                setImpStatus('copying power-line KMLs…');
                kmlResult = await copyPowerLineKmls(impState.srcSiteId, impState.srcServer, siteID, m => setImpStatus(escapeHtml(m)));
            }
            impState.report = {
                ranAt: new Date().toISOString(),
                targetSite: siteID,
                source: impState.srcLabel,
                created, errors, verifyProblems,
                kml: kmlResult,
            };
            const kmlBad = !!(kmlResult && kmlResult.errors.length);
            const col = errors.length || verifyProblems.length || kmlBad
                ? ((created.length || (kmlResult && kmlResult.copied.length)) ? '#ffa030' : '#ff5252') : '#5fff5f';
            const kmlMsg = kmlResult
                ? ` · KMLs: <b>${kmlResult.copied.length} copied</b>`
                    + (kmlResult.skipped.length ? `, ${kmlResult.skipped.length} skipped` : '')
                    + (kmlResult.errors.length ? `, <span style="color:#ff5252">${kmlResult.errors.length} FAILED</span>` : '')
                : '';
            console.log(`${TAG} import done: ${created.length} created, ${errors.length} failed, ${verifyProblems.length} verify problems`, impState.report);
            impState.running = false;
            renderImportPlan();
            const doneMsg = `Done — <b>${created.length} created</b>`
                + (errors.length ? `, <span style="color:#ff5252">${errors.length} FAILED</span>` : '')
                + (verifyProblems.length ? `, <span style="color:#ff5252">${verifyProblems.length} verify problem(s)</span>` : (sel.length ? ', all verified ✓' : ''))
                + kmlMsg + ' · see run log / console for detail';
            setImpStatus(doneMsg, col);
            // Re-check so freshly-created entities now show as "exists" —
            // carrying the report across (prepareImport builds a fresh
            // impState, which would drop the run-log button)
            if (!errors.length && !verifyProblems.length && sel.length) {
                const rep = impState.report;
                setTimeout(() => {
                    if (!impState || impState.running) return;
                    prepareImport().then(() => {
                        if (impState && !impState.running) {
                            impState.report = rep;
                            renderImportPlan();
                            setImpStatus(doneMsg + ' (re-checked)', col);
                        }
                    });
                }, 800);
            }
        } catch (e) {
            console.warn(`${TAG} runImport threw:`, e);
            impState.report = { ranAt: new Date().toISOString(), targetSite: siteID, source: impState.srcLabel, created, errors, verifyProblems: ['run aborted: ' + String(e && e.message || e)] };
            impState.running = false;
            renderImportPlan();
            setImpStatus(`Import aborted after ${created.length} create(s) — ${escapeHtml(String(e && e.message || e))}. Created entities remain on the site (create-only, nothing was overwritten).`, '#ff5252');
        }
    }

    async function copyPowerLineKmls(srcId, srcServer, tgtId, progress) {
        const out = { copied: [], skipped: [], errors: [] };
        if (!cachedToken) {
            out.errors.push('no GitHub token — set the PAT in AIM Controls (gear), then re-run');
            return out;
        }
        const hdrJson = { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github+json' };
        let listing;
        try {
            const r = await fetchWithTimeout(`${GH_API}/repos/${DATA_REPO}/contents/?ref=${DATA_BRANCH}`, { headers: hdrJson }, 30000);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            listing = await r.json();
            if (!Array.isArray(listing)) throw new Error('unexpected listing shape');
        } catch (e) {
            out.errors.push(`could not list the data repo: ${String(e && e.message || e)}`);
            return out;
        }
        // KML files are env-namespaced: prod = <id>-*, QA = qa-<id>-*. The
        // source prefix follows the SHADOW's server, the target this one's.
        const prefix = `${kmlEnvPrefix(srcServer)}${srcId}-`;
        const files = listing.filter(f => f && f.type === 'file' && String(f.name).startsWith(prefix));
        if (!files.length) {
            out.errors.push(`no ${prefix}* files in the data repo — site ${srcId} (${srcServer || THIS_SERVER}) has no power-line KMLs`);
            return out;
        }
        const existing = new Set(listing.map(f => f.name));
        for (const f of files) {
            const tgtName = `${kmlEnvPrefix(THIS_SERVER)}${tgtId}-${f.name.slice(prefix.length)}`;
            if (existing.has(tgtName)) { out.skipped.push(`${tgtName} (already exists)`); continue; }
            progress(`copying ${f.name} → ${tgtName}…`);
            try {
                // Raw media type works for any size up to 100 MB and is
                // binary-safe (.kmz) — the JSON content field caps at 1 MB.
                const raw = await fetchWithTimeout(
                    `${GH_API}/repos/${DATA_REPO}/contents/${encodeURIComponent(f.name)}?ref=${DATA_BRANCH}`,
                    { headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github.raw' } }, 60000);
                if (!raw.ok) throw new Error(`source GET HTTP ${raw.status}`);
                const bytes = new Uint8Array(await raw.arrayBuffer());
                let bin = '';
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                }
                const b64 = btoa(bin);
                const put = await fetchWithTimeout(
                    `${GH_API}/repos/${DATA_REPO}/contents/${encodeURIComponent(tgtName)}`,
                    {
                        method: 'PUT',
                        headers: Object.assign({ 'Content-Type': 'application/json' }, hdrJson),
                        // No sha → create-only; GitHub 422s instead of overwriting if it appeared meanwhile
                        body: JSON.stringify({ message: `[AIM site ${tgtId}] import power-line KML from site ${srcId} (${f.name})`, content: b64, branch: DATA_BRANCH }),
                    }, 60000);
                if (put.status !== 200 && put.status !== 201) {
                    const t = await put.text();
                    throw new Error(`PUT HTTP ${put.status} — ${(t || '').slice(0, 150)}`);
                }
                out.copied.push(tgtName);
            } catch (e) {
                console.warn(`${TAG} KML copy failed for ${f.name}:`, e);
                out.errors.push(`${f.name}: ${String(e && e.message || e)}`);
            }
        }
        if (out.copied.length) {
            // Map Styler re-fetches its KMLs on this signal — the new site
            // gets its power lines without a reload.
            try { if (controlChannel) controlChannel.postMessage({ type: 'REFETCH_KMLS' }); } catch (e) {}
        }
        return out;
    }

    function backupImportSource() {
        if (!impState) return;
        const src = shadowSourceFor(siteID);
        if (!src) return;
        getShadowEntities(siteID, src, false).then(ents => {
            if (!ents) { setImpStatus('backup failed — source unavailable', '#ff5252'); return; }
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const name = `import-source-${src.kind === 'site' ? `site-${src.id}` : 'file'}-${stamp}.json`;
            if (downloadJson(name, ents)) setImpStatus(`backup saved: ${escapeHtml(name)} (${ents.length} entities)`, '#5fff5f');
        });
    }

    function openImportPanel() {
        if (!impPanelEl) {
            impPanelEl = document.createElement('div');
            impPanelEl.id = 'aim-sd-imp-panel';
            impPanelEl.style.cssText = 'position:fixed;top:80px;left:60px;z-index:2147480002;width:560px;'
                + 'background:#14181f;color:#ddd;border:1px solid #2a3140;border-radius:6px;'
                + 'font:12px/1.5 monospace;box-shadow:0 4px 18px rgba(0,0,0,0.5);';
            impPanelEl.innerHTML = ''
                + '<div id="aim-sd-imp-drag" style="padding:7px 10px;color:#7adfe6;font-weight:bold;border-bottom:1px solid #2a3140;cursor:move;user-select:none;">'
                + '📥 Site Diff — import shadow → this site (create-only) <span data-imp="close" style="float:right;cursor:pointer;color:#888">✕</span></div>'
                + '<div id="aim-sd-imp-body"></div>';
            document.body.appendChild(impPanelEl);
            // Delegated — the body is rebuilt on every render, the panel root never is
            impPanelEl.addEventListener('click', (ev) => {
                const el = ev.target.closest('[data-imp]');
                if (!el) return;
                const cmd = el.getAttribute('data-imp');
                if (cmd === 'close') impPanelEl.style.display = 'none';
                else if (cmd === 'run') runImport();
                else if (cmd === 'backup-src') backupImportSource();
                else if (cmd === 'refresh') { if (!impState || !impState.running) prepareImport(); }
                else if (cmd === 'log' && impState && impState.report) {
                    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
                    downloadJson(`import-run-site-${siteID}-${stamp}.json`, impState.report);
                }
            });
            impPanelEl.addEventListener('change', (ev) => {
                if (impState && impState.running) return;
                const kcb = ev.target.closest('input[data-imp-kml]');
                if (kcb) {
                    importKml = !!kcb.checked;
                    gmSet(KEY_IMPORT_KML, importKml);
                    if (impState) { impState.armed = false; renderImportPlan(); }
                    return;
                }
                const cb = ev.target.closest('input[data-imp-type]');
                if (!cb) return;
                const key = cb.getAttribute('data-imp-type');
                if (!(key in importTypes)) return;
                importTypes[key] = !!cb.checked;
                saveImportTypes();
                if (impState) { impState.armed = false; renderImportPlan(); }
            });
            const dragBar = impPanelEl.querySelector('#aim-sd-imp-drag');
            dragBar.addEventListener('pointerdown', (ev) => {
                if (ev.target.getAttribute && ev.target.getAttribute('data-imp') === 'close') return;
                ev.preventDefault();
                const r = impPanelEl.getBoundingClientRect();
                const offX = ev.clientX - r.left, offY = ev.clientY - r.top;
                const onMove = (mv) => {
                    impPanelEl.style.left = `${Math.max(0, mv.clientX - offX)}px`;
                    impPanelEl.style.top = `${Math.max(0, mv.clientY - offY)}px`;
                };
                const onUp = () => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                };
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }
        impPanelEl.style.display = 'block';
        try { if (controlChannel && !cachedToken) controlChannel.postMessage({ type: 'REQUEST_TOKEN' }); } catch (e) {}
        prepareImport();
    }

    // ---------------- Swipe divider ----------------
    let swipeHandleEl = null;
    let swipeFrac = 0.5;
    let swipeHookedMap = null;

    function ensureSwipeHandle(map) {
        const container = map.getContainer();
        if (swipeHandleEl && swipeHandleEl.parentElement === container) return;
        try { if (swipeHandleEl) swipeHandleEl.remove(); } catch (e) {}
        swipeHandleEl = document.createElement('div');
        swipeHandleEl.id = 'aim-sd-swipe';
        swipeHandleEl.style.cssText = 'position:absolute;top:0;bottom:0;width:12px;margin-left:-6px;'
            + 'cursor:ew-resize;z-index:1200;touch-action:none;';
        swipeHandleEl.innerHTML = ''
            + '<div style="position:absolute;top:0;bottom:0;left:5px;width:2px;background:#ffa030;box-shadow:0 0 4px #000;"></div>'
            + '<div style="position:absolute;top:50%;left:-6px;width:24px;height:24px;margin-top:-12px;border-radius:50%;'
            + 'background:#14181f;border:2px solid #ffa030;color:#ffa030;font:12px/20px monospace;text-align:center;user-select:none;">⇔</div>';
        swipeHandleEl.title = 'Drag with M1 = split view (left Original / right New) · M2 = overlay reveal (ghost right of handle)';
        const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        swipeHandleEl.addEventListener('contextmenu', stop);
        swipeHandleEl.addEventListener('pointerdown', (ev) => {
            stop(ev);
            // Mouse button picks the mode: M1 = split, M2 = overlay reveal
            const wantMode = ev.button === 2 ? 'overlay' : 'split';
            if (wantMode !== diffCfg.swipeMode) {
                diffCfg.swipeMode = wantMode;
                saveDiffCfg();
                console.log(`${TAG} swipe mode → ${wantMode}`);
            }
            try { swipeHandleEl.setPointerCapture(ev.pointerId); } catch (e) {}
            const onMove = (mv) => {
                const rect = container.getBoundingClientRect();
                if (rect.width > 0) {
                    swipeFrac = Math.max(0.02, Math.min(0.98, (mv.clientX - rect.left) / rect.width));
                    applySwipeClip();
                }
            };
            const onUp = (up) => {
                try { swipeHandleEl.releasePointerCapture(up.pointerId); } catch (e) {}
                swipeHandleEl.removeEventListener('pointermove', onMove);
                swipeHandleEl.removeEventListener('pointerup', onUp);
            };
            swipeHandleEl.addEventListener('pointermove', onMove);
            swipeHandleEl.addEventListener('pointerup', onUp);
        });
        // Keep Leaflet from turning handle drags into map pans
        ['mousedown', 'touchstart', 'dblclick', 'click'].forEach(t =>
            swipeHandleEl.addEventListener(t, (ev) => ev.stopPropagation()));
        container.appendChild(swipeHandleEl);
    }

    // Percepto's own entity rendering lives in these default panes — in
    // split mode they get clipped to the right side so the left shows the
    // shadow (Original) only. Cleared the moment split mode is off.
    const NATIVE_SWIPE_PANES = ['overlayPane', 'markerPane', 'shadowPane'];
    let nativeClipsApplied = false;

    function setNativeClips(map, clip) {
        NATIVE_SWIPE_PANES.forEach(n => {
            try { const p = map.getPane(n); if (p) p.style.clipPath = clip; } catch (e) {}
        });
        // Diff highlights mark THIS site's geometry → they belong to the New side
        try { const hl = map.getPane(HL_PANE_NAME); if (hl) hl.style.clipPath = clip; } catch (e) {}
        nativeClipsApplied = !!clip;
    }

    function applySwipeClip() {
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L) return;
        const pane = map.getPane && map.getPane(PANE_NAME);
        if (!pane) return;
        const active = diffCfg.swipe && masterEnabled && !!shadowSourceFor(siteID);
        if (!active) {
            pane.style.clipPath = '';
            if (nativeClipsApplied) setNativeClips(map, '');
            if (swipeHandleEl) swipeHandleEl.style.display = 'none';
            return;
        }
        // Clip in LAYER coords — the coordinate space of pane children. The
        // map pane carries the pan translation (our pane's own offset is 0),
        // so v0.20's getPosition(pane) drifted off the handle after any pan;
        // containerPointToLayerPoint accounts for it exactly.
        const size = map.getSize();
        let lx;
        try { lx = map.containerPointToLayerPoint([swipeFrac * size.x, 0]).x; }
        catch (e) { lx = swipeFrac * size.x; }
        const BIG = 1000000;
        const rightOfHandle = `polygon(${lx}px ${-BIG}px, ${BIG}px ${-BIG}px, ${BIG}px ${BIG}px, ${lx}px ${BIG}px)`;
        const leftOfHandle = `polygon(${-BIG}px ${-BIG}px, ${lx}px ${-BIG}px, ${lx}px ${BIG}px, ${-BIG}px ${BIG}px)`;
        if (diffCfg.swipeMode === 'overlay') {
            // Overlay reveal: full New view everywhere, ghost only right of handle
            pane.style.clipPath = rightOfHandle;
            if (nativeClipsApplied) setNativeClips(map, '');
        } else {
            // Split: LEFT = Original (shadow) only · RIGHT = New (this site) only
            pane.style.clipPath = leftOfHandle;
            setNativeClips(map, rightOfHandle);
        }
        ensureSwipeHandle(map);
        swipeHandleEl.style.display = 'block';
        swipeHandleEl.style.left = `${Math.round(swipeFrac * size.x)}px`;
        if (swipeHookedMap !== map) {
            try {
                map.on('move zoom viewreset resize', applySwipeClip);
                swipeHookedMap = map;
            } catch (e) { console.warn(`${TAG} swipe map hook failed:`, e); }
        }
    }

    // Focus mode: hide every entity layer (native + shadow) except the diff
    // highlights, so flagged stretches stand alone over the basemap.
    function applyFocusMode() {
        const map = getLeafletMap();
        if (!map) return;
        const on = diffCfg.focus && masterEnabled;
        const vis = on ? 'hidden' : '';
        NATIVE_SWIPE_PANES.forEach(n => {
            try { const p = map.getPane(n); if (p) p.style.visibility = vis; } catch (e) {}
        });
        try { const sp = map.getPane(PANE_NAME); if (sp) sp.style.visibility = vis; } catch (e) {}
    }

    // ==================================================================
    // Feature #250 Layer 2 — Neighboring-site overlay + conflict check
    //
    // Sites are starting to overlap geographically; two drones on two
    // different sites can share airspace. This layer shows every OTHER
    // site's FFZs / flight paths / assets within a display radius of
    // this site, and flags any foreign entity within the conflict
    // threshold of a local one.
    //
    // Hybrid data model (user decision, see AIM_Site_Overlap_Design.md):
    //   - Site Watch snapshots (site-watch[-qa]/<id>/latest.json.gz in
    //     the private data repo, PAT via TOKEN_VALUE) supply cheap
    //     bounding boxes → prefilter which sites are even candidates.
    //   - Live /map_objects/ fetches supply CURRENT geometry for the
    //     real math on candidate sites only.
    //   - Sites with no snapshot fall back to a /sites/ center + a
    //     generous radius; sites with neither are listed as UNCHECKED
    //     in the report — never silently skipped.
    //
    // ENGRAVED: all proximity is segment-to-segment / point-in-polygon —
    // NEVER vertex-to-vertex. Strict QA isolation: neighbors come only
    // from THIS server's site set; the index key is env-namespaced.
    //
    // [#250 shared glue] bboxFromEntities / bboxGapFt / segSegClosestM /
    // nbPrepareEntity are the neighbor-discovery + segment-math helpers
    // this project duplicates into AIM_Fleet_Tools and the Asset
    // Inspector validator check #13 (userscripts can't import from each
    // other). Keep names + shapes identical — a fix here is a mechanical
    // 3-file sweep.
    // ==================================================================
    const KEY_NB = 'aim-sd-nb';
    const KEY_NB_INDEX = IS_QA ? 'aim-sd-nb-index-qa' : 'aim-sd-nb-index';
    const NB_PANE_NAME = 'aim-site-diff-nb';
    const NB_HL_PANE_NAME = 'aim-site-diff-nb-hl';
    const NB_WATCH_DIR = IS_QA ? 'site-watch-qa' : 'site-watch';
    const NB_SNAP_RE = new RegExp(`^${NB_WATCH_DIR}/(\\d+)/latest\\.json\\.gz$`);
    const NB_CENTER_MARGIN_FT = 5280;   // extent unknown from a bare center — assume up to 1 mi
    const NB_INDEX_RECHECK_MS = 6 * 3600 * 1000;   // auto re-check snapshot shas at most every 6h
    const NB_FETCH_CONCURRENCY = 4;
    // One color per NEIGHBOR SITE (not per type) — that alone makes foreign
    // geometry unmistakable vs native (color = type) and vs the warm shadow
    // palette; dotted strokes double the distinction.
    const NB_PALETTE = ['#7986cb', '#4db6ac', '#f06292', '#a1887f', '#90a4ae', '#dce775', '#64b5f6', '#ffb74d'];
    const NB_CONFLICT_COLOR = '#ff3d00';
    const NB_CLASSES = [
        { key: 'ffz', type: 16, label: 'FFZs' },
        { key: 'fp', type: 15, label: 'Flight paths' },
        { key: 'asset', type: 3, label: 'Assets' },
    ];
    const NB_TYPE_TO_CLASS = { 16: 'ffz', 15: 'fp', 3: 'asset' };

    function defaultNbCfg() {
        return { enabled: false, radiusFt: 1000, thresholdFt: 200, classes: { ffz: true, fp: true, asset: true } };
    }
    function loadNbCfg() {
        const d = defaultNbCfg();
        try {
            const raw = gmGet(KEY_NB, null);
            if (raw) {
                const s = JSON.parse(raw);
                if (typeof s.enabled === 'boolean') d.enabled = s.enabled;
                if (typeof s.radiusFt === 'number') d.radiusFt = s.radiusFt;
                if (typeof s.thresholdFt === 'number') d.thresholdFt = s.thresholdFt;
                if (s.classes) NB_CLASSES.forEach(c => {
                    if (typeof s.classes[c.key] === 'boolean') d.classes[c.key] = s.classes[c.key];
                });
            }
        } catch (e) { console.warn(`${TAG} loadNbCfg:`, e); }
        return d;
    }
    let nbCfg = loadNbCfg();
    function saveNbCfg() {
        try { gmSet(KEY_NB, JSON.stringify(nbCfg)); }
        catch (e) { console.warn(`${TAG} saveNbCfg:`, e); }
    }

    // Index: { shas: {siteId: gitSha}, bboxes: {siteId: {minLat,minLng,
    // maxLat,maxLng, ffz,fp,asset} | {empty:true}}, builtAt, checkedAt }
    function loadNbIndex() {
        try {
            const raw = gmGet(KEY_NB_INDEX, null);
            if (raw) {
                const s = JSON.parse(raw);
                if (s && s.shas && s.bboxes) return s;
            }
        } catch (e) { console.warn(`${TAG} loadNbIndex:`, e); }
        return { shas: {}, bboxes: {}, builtAt: 0, checkedAt: 0 };
    }
    let nbIndex = loadNbIndex();
    function saveNbIndex() {
        try { gmSet(KEY_NB_INDEX, JSON.stringify(nbIndex)); }
        catch (e) { console.warn(`${TAG} saveNbIndex:`, e); }
    }

    let nbState = null;    // last scan result — see scanNeighbors
    let nbLayers = [];
    let nbPinLayers = [];
    let nbScanSeq = 0;
    let nbPanelEl = null;

    const nbYield = () => new Promise(r => setTimeout(r, 0));

    async function nbGunzipToText(bytes) {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const ab = await new Response(ds.readable).arrayBuffer();
        return new TextDecoder('utf-8').decode(new Uint8Array(ab));
    }

    // [#250 shared glue] bbox over conflict-relevant geometry (types 3/15/16
    // only — a stray GM marker miles out must not inflate the site's extent).
    // Returns null when the site has no such geometry.
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

    // [#250 shared glue] gap between two lat/lng bboxes in feet (0 = overlap).
    function bboxGapFt(a, b) {
        const midLat = (Math.min(a.minLat, b.minLat) + Math.max(a.maxLat, b.maxLat)) / 2;
        const mLat = 111320;
        const mLng = 111320 * Math.cos(midLat * Math.PI / 180) || 1e-6;
        const gapLat = Math.max(0, Math.max(a.minLat - b.maxLat, b.minLat - a.maxLat)) * mLat;
        const gapLng = Math.max(0, Math.max(a.minLng - b.maxLng, b.minLng - a.maxLng)) * mLng;
        return Math.hypot(gapLat, gapLng) * FT_PER_M;
    }

    // ---------------- Site Watch snapshot index (bbox prefilter) ----------------

    async function nbGhTree() {
        // One request returns every path+sha in the data repo — the cheap way
        // to know which snapshots changed since the cached index.
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
        const v = validateBackupEntities(parsed);   // snapshots are the raw /map_objects list
        if (v.error) return { empty: true };        // a site with no drawable geometry is a valid (empty) answer
        return bboxFromEntities(v.entities) || { empty: true };
    }

    // Refresh the bbox index from the data repo. Incremental: only snapshots
    // whose git sha changed are re-downloaded. Progress reported via cb.
    async function ensureNbIndex(progress, forceCheck) {
        const notes = [];
        const haveIndex = Object.keys(nbIndex.bboxes).length > 0;
        if (!cachedToken) {
            try { if (controlChannel) controlChannel.postMessage({ type: 'REQUEST_TOKEN' }); } catch (e) {}
            await new Promise(r => setTimeout(r, 800));
        }
        if (!cachedToken) {
            if (haveIndex) {
                notes.push('no GitHub token — using the cached neighbor index (may be stale)');
                return notes;
            }
            throw new Error('GitHub token needed to build the neighbor index — set the PAT in AIM Controls (gear)');
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
        // Drop sites whose snapshot vanished
        Object.keys(nbIndex.shas).forEach(id => {
            if (!tree.shas[id]) { delete nbIndex.shas[id]; delete nbIndex.bboxes[id]; }
        });
        const changed = Object.keys(tree.shas).filter(id => nbIndex.shas[id] !== tree.shas[id] || !nbIndex.bboxes[id]);
        const total = changed.length;
        if (total) {
            console.log(`${TAG} neighbor index: ${total} snapshot(s) to (re)fetch of ${Object.keys(tree.shas).length}`);
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
                        console.warn(`${TAG} neighbor index: snapshot fetch failed for site ${id}:`, e);
                    }
                    done++;
                    if (progress) progress(done, total);
                    if (done % 25 === 0) { saveNbIndex(); await nbYield(); }
                }
            };
            await Promise.all(Array.from({ length: Math.min(NB_FETCH_CONCURRENCY, changed.length) }, worker));
            if (failed) notes.push(`${failed} snapshot fetch(es) failed — those sites are UNCHECKED this scan`);
            nbIndex.builtAt = Date.now();
        }
        nbIndex.checkedAt = Date.now();
        saveNbIndex();
        return notes;
    }

    // ---------------- segment math ----------------

    // [#250 shared glue] entity → projected segment list (+ ring for
    // polygons) with a padded-less bbox for pair prefiltering. Returns null
    // for entities outside the conflict classes or without usable geometry.
    function nbPrepareEntity(e, proj) {
        const cls = e && NB_TYPE_TO_CLASS[e.type];
        if (!cls || !nbCfg.classes[cls]) return null;
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

    // [#250 shared glue] min distance between two segments, with the point
    // of closest approach. Crossing segments → 0 at the intersection —
    // endpoint-only math would call an X-crossing "far apart".
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

    // Min distance between two prepared entities (segment-to-segment +
    // polygon containment). Containment matters: a local asset wholly inside
    // a foreign FFZ can have every edge pair far apart while the airspace
    // fully overlaps.
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

    // ---------------- scan ----------------

    function ensureNbPanes(map) {
        if (!map || map._aim_sd_nb_panes) return;
        try {
            if (typeof map.createPane !== 'function') return;
            // z 540: just under the shadow pane (550) — foreign sites read as
            // background context, the paired shadow stays on top of them.
            const p = map.createPane(NB_PANE_NAME);
            if (p) { p.style.zIndex = 540; p.style.pointerEvents = 'none'; }
            // Conflict pins above everything incl. diff highlights (620) —
            // never swipe-clipped, a cross-site conflict must never hide.
            const hl = map.createPane(NB_HL_PANE_NAME);
            if (hl) { hl.style.zIndex = 630; hl.style.pointerEvents = 'none'; }
            map._aim_sd_nb_panes = true;
        } catch (e) { console.warn(`${TAG} ensureNbPanes failed:`, e); }
    }

    function clearNbLayers() {
        const map = getLeafletMap();
        nbLayers.concat(nbPinLayers).forEach(l => { try { if (map) map.removeLayer(l); } catch (e) {} });
        nbLayers = [];
        nbPinLayers = [];
    }

    function nbBuildEntityLayers(e, L, color) {
        const cls = NB_TYPE_TO_CLASS[e.type];
        if (!cls || !nbCfg.classes[cls]) return [];
        const base = {
            color, weight: 2, opacity: 0.85, dashArray: '2,6',
            interactive: false, bubblingMouseEvents: false, pane: NB_PANE_NAME,
        };
        if (e.type === 15) {
            const segs = (Array.isArray(e.arcs) ? e.arcs : [])
                .filter(a => a && a.point_a && a.point_b
                    && typeof a.point_a.lat === 'number' && typeof a.point_b.lat === 'number')
                .map(a => [[a.point_a.lat, a.point_a.lng], [a.point_b.lat, a.point_b.lng]]);
            if (segs.length) return [L.polyline(segs, base)];
            const cs = entityCoords(e);
            if (cs && cs.length > 1) return [L.polyline(cs.map(p => [p.lat, p.lng]), base)];
            return [];
        }
        const cs = entityCoords(e);
        if (!cs || cs.length < 3) return [];
        return [L.polygon(cs.map(p => [p.lat, p.lng]), Object.assign({}, base, {
            fillColor: color, fillOpacity: 0.06,
        }))];
    }

    function nbDrawAttempt(seq, attempt) {
        if (seq !== nbScanSeq || !nbState || nbState.scanning) return;
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L) {
            if (attempt < 60) setTimeout(() => nbDrawAttempt(seq, attempt + 1), 500);
            else if (document.querySelector('.leaflet-container')) console.warn(`${TAG} neighbor draw gave up — no Leaflet map after ${attempt} tries`);
            return;
        }
        ensureNbPanes(map);
        let drawn = 0;
        nbState.neighbors.forEach(nb => {
            nb.entities.forEach(e => {
                try {
                    nbBuildEntityLayers(e, L, nb.color).forEach(l => {
                        l.addTo(map);
                        try { if (l._path) l._path.style.pointerEvents = 'none'; } catch (err) {}
                        nbLayers.push(l);
                        drawn++;
                    });
                } catch (err) { console.warn(`${TAG} neighbor draw failed for entity ${e && e.id}:`, err); }
            });
        });
        nbState.conflicts.forEach(c => {
            try {
                const halo = L.circleMarker([c.lat, c.lng], {
                    radius: 14, color: NB_CONFLICT_COLOR, weight: 2, opacity: 0.6,
                    fillColor: NB_CONFLICT_COLOR, fillOpacity: 0.12,
                    interactive: false, bubblingMouseEvents: false, pane: NB_HL_PANE_NAME,
                });
                const core = L.circleMarker([c.lat, c.lng], {
                    radius: 4, color: NB_CONFLICT_COLOR, weight: 1, opacity: 1,
                    fillColor: NB_CONFLICT_COLOR, fillOpacity: 1,
                    interactive: false, bubblingMouseEvents: false, pane: NB_HL_PANE_NAME,
                });
                halo.addTo(map); core.addTo(map);
                c._halo = halo;
                nbPinLayers.push(halo, core);
            } catch (err) { console.warn(`${TAG} conflict pin draw failed:`, err); }
        });
        console.log(`${TAG} neighbors: drew ${drawn} foreign layer(s) + ${nbState.conflicts.length} conflict pin(s)`);
    }

    // Probe a raw /sites/ list entry for a usable center. No script has ever
    // needed coordinates from /sites/, so the real field name is UNVERIFIED —
    // probe the plausible shapes and log once if nothing hits.
    let nbCenterProbeLogged = false;
    function nbSiteEntryCenter(s) {
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
        if (!nbCenterProbeLogged) {
            nbCenterProbeLogged = true;
            try { console.log(`${TAG} /sites/ entry carries no recognizable center — keys:`, Object.keys(s).join(', ')); } catch (e) {}
        }
        return null;
    }

    // Raw /sites/ payload (id → raw entry) for the center fallback. Cached
    // per session; separate from fetchSiteList's slim {id,name} cache.
    let nbRawSites = null;
    async function nbFetchRawSites() {
        if (nbRawSites) return nbRawSites;
        try {
            const r = await fetchWithTimeout('/sites/', {
                credentials: 'same-origin', headers: { 'Accept': 'application/json' },
            }, 20000);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const list = extractList(await r.json());
            const map = {};
            list.forEach(s => {
                const id = String(s && (s.id != null ? s.id : s.site_id) || '');
                if (id) map[id] = s;
            });
            nbRawSites = map;
        } catch (e) {
            console.warn(`${TAG} raw /sites/ fetch failed (center fallback unavailable):`, e);
            nbRawSites = {};
        }
        return nbRawSites;
    }

    function nbSetStatus(msg) {
        if (nbState) nbState.status = msg;
        const el = nbPanelEl && nbPanelEl.querySelector('#aim-sd-nb-status');
        if (el) el.textContent = msg;
        updateNbBadge();
    }

    async function scanNeighbors(manual) {
        const seq = ++nbScanSeq;
        clearNbLayers();
        if (!nbCfg.enabled || !siteID) {
            nbState = null;
            updateNbBadge();
            if (nbPanelEl && nbPanelEl.style.display !== 'none') renderNbPanel();
            return;
        }
        nbState = { scanning: true, status: 'starting…', neighbors: [], conflicts: [], unchecked: [], notes: [], at: null };
        updateNbBadge();
        if (nbPanelEl && nbPanelEl.style.display !== 'none') renderNbPanel();
        const scanSite = siteID;
        try {
            nbSetStatus('fetching this site\'s geometry…');
            const mine = await fetchShadowEntities({ id: scanSite, server: THIS_SERVER }, true);
            if (seq !== nbScanSeq) return;
            if (!mine) throw new Error('could not fetch this site\'s /map_objects/');
            const myBox = bboxFromEntities(mine);
            if (!myBox) {
                nbState.scanning = false;
                nbState.at = Date.now();
                nbSetStatus('this site has no FFZ/FP/asset geometry — nothing to check against');
                if (nbPanelEl && nbPanelEl.style.display !== 'none') renderNbPanel();
                return;
            }
            nbSetStatus('checking neighbor index…');
            const notes = await ensureNbIndex((done, total) => {
                if (seq === nbScanSeq) nbSetStatus(`indexing site snapshots… ${done}/${total}`);
            }, manual);
            if (seq !== nbScanSeq) return;
            nbState.notes.push(...notes);

            const maxFt = Math.max(nbCfg.radiusFt, nbCfg.thresholdFt);
            const candidates = [];
            Object.keys(nbIndex.bboxes).forEach(id => {
                if (id === String(scanSite)) return;
                const b = nbIndex.bboxes[id];
                if (!b || b.empty) return;
                if (bboxGapFt(myBox, b) <= maxFt) candidates.push({ id, src: 'snapshot' });
            });

            // Sites with NO snapshot: center fallback + generous margin; no
            // center either → UNCHECKED, listed in the report.
            const siteList = await fetchSiteList(THIS_SERVER, false);
            if (seq !== nbScanSeq) return;
            if (siteList) {
                const noSnap = siteList.filter(s => s.id !== String(scanSite) && !nbIndex.bboxes[s.id]);
                if (noSnap.length) {
                    const raw = await nbFetchRawSites();
                    if (seq !== nbScanSeq) return;
                    noSnap.forEach(s => {
                        const c = nbSiteEntryCenter(raw[s.id]);
                        if (c) {
                            const ptBox = { minLat: c.lat, maxLat: c.lat, minLng: c.lng, maxLng: c.lng };
                            if (bboxGapFt(myBox, ptBox) <= maxFt + NB_CENTER_MARGIN_FT) {
                                candidates.push({ id: s.id, src: 'center' });
                            }
                        } else {
                            nbState.unchecked.push({ id: s.id, name: s.name });
                        }
                    });
                }
            } else {
                nbState.notes.push('site list unavailable — snapshot-less sites could not be checked or counted');
            }

            // Live geometry for candidates only — the real math runs on
            // CURRENT data, the index is only the prefilter.
            const proj = projector((myBox.minLat + myBox.maxLat) / 2);
            const thrM = nbCfg.thresholdFt / FT_PER_M;
            const minePrepared = [];
            mine.forEach(e => {
                const p = nbPrepareEntity(e, proj);
                if (p) minePrepared.push(p);
            });
            const neighbors = [];
            for (let i = 0; i < candidates.length; i++) {
                if (seq !== nbScanSeq) return;
                const cand = candidates[i];
                nbSetStatus(`fetching neighbor site ${cand.id} (${i + 1}/${candidates.length})…`);
                const ents = await fetchShadowEntities({ id: cand.id, server: THIS_SERVER }, manual);
                if (seq !== nbScanSeq) return;
                if (!ents) {
                    nbState.notes.push(`site ${cand.id} live fetch failed — NOT checked this scan`);
                    continue;
                }
                const prepared = [];
                ents.forEach(e => {
                    const p = nbPrepareEntity(e, proj);
                    if (p) prepared.push(p);
                });
                if (!prepared.length) continue;
                neighbors.push({
                    id: cand.id,
                    name: siteLabel(cand.id, THIS_SERVER),
                    src: cand.src,
                    color: NB_PALETTE[neighbors.length % NB_PALETTE.length],
                    entities: ents.filter(e => NB_TYPE_TO_CLASS[e.type] && nbCfg.classes[NB_TYPE_TO_CLASS[e.type]]),
                    prepared,
                    counts: {
                        ffz: prepared.filter(p => p.cls === 'ffz').length,
                        fp: prepared.filter(p => p.cls === 'fp').length,
                        asset: prepared.filter(p => p.cls === 'asset').length,
                    },
                    minFt: null,
                });
            }

            // Conflict math — segment-to-segment with per-pair bbox skip and
            // cooperative yielding (engraved: long spatial loops must yield).
            nbSetStatus('running conflict check…');
            const conflicts = [];
            const thrPad = thrM + 1;
            let ops = 0;
            for (const nb of neighbors) {
                for (const fe of nb.prepared) {
                    for (const le of minePrepared) {
                        if (le.minX > fe.maxX + thrPad || le.maxX < fe.minX - thrPad
                            || le.minY > fe.maxY + thrPad || le.maxY < fe.minY - thrPad) continue;
                        ops += le.segs.length * fe.segs.length;
                        const c = nbEntityPairClosest(le, fe);
                        if (ops >= 4000) { ops = 0; await nbYield(); if (seq !== nbScanSeq) return; }
                        if (!c) continue;
                        const ft = c.d * FT_PER_M;
                        if (nb.minFt === null || ft < nb.minFt) nb.minFt = ft;
                        // Round-then-compare (engraved): flag on the displayed
                        // integer — a distance that DISPLAYS as the threshold
                        // never flags.
                        if (Math.round(ft) >= nbCfg.thresholdFt) continue;
                        const ll = proj.toLatLng(c.x, c.y);
                        conflicts.push({
                            localName: le.name, localCls: le.cls,
                            foreignName: fe.name, foreignCls: fe.cls,
                            siteId: nb.id, siteName: nb.name, siteColor: nb.color,
                            ft: Math.round(ft), overlap: c.d === 0,
                            lat: ll[0], lng: ll[1],
                        });
                    }
                }
            }
            conflicts.sort((a, b) => a.ft - b.ft);
            nbState.neighbors = neighbors;
            nbState.conflicts = conflicts;
            nbState.scanning = false;
            nbState.at = Date.now();
            const uncheckedBit = nbState.unchecked.length ? ` · ${nbState.unchecked.length} site(s) UNCHECKED (no snapshot/center)` : '';
            nbSetStatus(`${neighbors.length} neighbor(s) within ${nbCfg.radiusFt} ft · `
                + (conflicts.length ? `⚠ ${conflicts.length} conflict(s) under ${nbCfg.thresholdFt} ft` : `no conflicts under ${nbCfg.thresholdFt} ft ✓`)
                + uncheckedBit);
            console.log(`${TAG} neighbor scan: ${candidates.length} candidate(s) → ${neighbors.length} with geometry, ${conflicts.length} conflict(s), ${nbState.unchecked.length} unchecked`);
            nbDrawAttempt(seq, 0);
            updateNbBadge();
            if (nbPanelEl && nbPanelEl.style.display !== 'none') renderNbPanel();
            if (conflicts.length && !manual) openNbPanel();   // conflicts must not pass silently
        } catch (e) {
            if (seq !== nbScanSeq) return;
            console.warn(`${TAG} neighbor scan failed:`, e);
            nbState.scanning = false;
            nbState.error = String(e && e.message || e);
            nbState.at = Date.now();
            nbSetStatus(`scan failed — ${nbState.error}`);
            if (nbPanelEl && nbPanelEl.style.display !== 'none') renderNbPanel();
        }
    }

    // ---------------- badge + panel ----------------

    function updateNbBadge() {
        let b = document.getElementById('aim-sd-nb-badge');
        const show = nbCfg.enabled && siteID && document.querySelector('.leaflet-container');
        if (!show) { if (b) b.style.display = 'none'; return; }
        if (!b) {
            b = document.createElement('div');
            b.id = 'aim-sd-nb-badge';
            // Sits just above the shadow badge (bottom:10)
            b.style.cssText = 'position:fixed;left:10px;bottom:38px;z-index:2147480000;'
                + 'background:rgba(20,24,32,0.9);border:1px solid #7986cb66;'
                + 'border-radius:4px;padding:3px 8px;font:12px/1.4 monospace;cursor:pointer;'
                + 'user-select:none;';
            b.title = 'AIM Site Diff — neighboring sites (click for conflict panel)';
            b.addEventListener('click', (ev) => { ev.stopPropagation(); openNbPanel(); });
            document.body.appendChild(b);
        }
        if (!nbState) {
            b.textContent = '⬡ Neighbors: not scanned';
            b.style.color = '#8899bb';
        } else if (nbState.scanning) {
            b.textContent = `⬡ ${nbState.status || 'scanning…'}`;
            b.style.color = '#8899bb';
        } else if (nbState.error) {
            b.textContent = '⬡ Neighbors: scan FAILED';
            b.style.color = '#ff5252';
        } else {
            const n = nbState.neighbors.length, c = nbState.conflicts.length;
            b.textContent = c ? `⬡ ${n} neighbor(s) · ⚠ ${c} conflict(s)` : `⬡ ${n} neighbor(s) · ✓`;
            b.style.color = c ? NB_CONFLICT_COLOR : (n ? '#7986cb' : '#667');
        }
        b.style.display = 'block';
    }

    function buildNbReport() {
        const lines = [];
        lines.push(`AIM Site Diff — cross-site overlap report — site ${siteID} (${siteLabel(siteID, THIS_SERVER)}) [${SERVER_LABELS[THIS_SERVER]}]`);
        const cls = NB_CLASSES.filter(c => nbCfg.classes[c.key]).map(c => c.label).join(', ');
        lines.push(`Scanned ${nbState && nbState.at ? new Date(nbState.at).toLocaleString() : '—'} · display radius ${nbCfg.radiusFt} ft · conflict threshold ${nbCfg.thresholdFt} ft · classes: ${cls}`);
        if (!nbState || nbState.scanning) { lines.push('(scan not finished)'); return lines.join('\n'); }
        if (nbState.error) lines.push(`SCAN FAILED: ${nbState.error}`);
        lines.push('');
        lines.push(`Neighbors in range (${nbState.neighbors.length}):`);
        nbState.neighbors.forEach(nb => {
            const min = nb.minFt === null ? 'no pair within checking range' : `closest approach ${Math.round(nb.minFt)} ft`;
            const srcBit = nb.src === 'center' ? ' [center-only prefilter — no snapshot]' : '';
            lines.push(`  • ${nb.name} (#${nb.id})${srcBit} — ${nb.counts.ffz} FFZ · ${nb.counts.fp} FP · ${nb.counts.asset} assets — ${min} — ${location.origin}/#/site/${nb.id}/control-panel/site-setup`);
        });
        lines.push('');
        lines.push(`Conflicts under ${nbCfg.thresholdFt} ft (${nbState.conflicts.length}):`);
        nbState.conflicts.forEach((c, i) => {
            lines.push(`  ${i + 1}. ${c.localCls.toUpperCase()} "${c.localName}" ↔ ${c.foreignCls.toUpperCase()} "${c.foreignName}" (${c.siteName} #${c.siteId}) — ${c.overlap ? 'OVERLAP' : `${c.ft} ft`} @ ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`);
        });
        if (nbState.unchecked.length) {
            lines.push('');
            lines.push(`NOT CHECKED — no Site Watch snapshot and no usable /sites/ center (${nbState.unchecked.length}):`);
            nbState.unchecked.forEach(u => lines.push(`  • ${u.name || 'site'} (#${u.id})`));
        }
        nbState.notes.forEach(n => lines.push(`Note: ${n}`));
        return lines.join('\n');
    }

    function renderNbPanel() {
        if (!nbPanelEl) return;
        const body = nbPanelEl.querySelector('#aim-sd-nb-body');
        if (!body) return;
        if (!nbCfg.enabled) {
            body.innerHTML = '<div style="padding:8px;color:#888">Neighbor overlay is OFF — enable "Show neighboring site setups" in the Control Panel (Site Diff card).</div>';
            return;
        }
        if (!nbState) {
            body.innerHTML = '<div style="padding:8px;color:#888">Not scanned yet.</div>'
                + '<div style="padding:0 8px 8px;"><span data-nb="scan" style="cursor:pointer;color:#5fff5f">⬡ Scan now</span></div>';
            return;
        }
        const rows = [];
        if (nbState.scanning) {
            rows.push('<div style="padding:8px;color:#8899bb">Scanning…</div>');
        } else {
            if (nbState.error) rows.push(`<div style="padding:6px 8px;color:#ff5252">Scan failed: ${escapeHtml(nbState.error)}</div>`);
            rows.push('<div style="padding:4px 8px;border-bottom:1px solid #222834;color:#7adfe6;font-weight:bold">Neighbors in range</div>');
            if (!nbState.neighbors.length) {
                rows.push(`<div style="padding:4px 8px;color:#888">None within ${nbCfg.radiusFt} ft.</div>`);
            }
            nbState.neighbors.forEach(nb => {
                const min = nb.minFt === null ? '—' : `${Math.round(nb.minFt)} ft`;
                rows.push(`<div class="aim-sd-nb-row" data-nb-site="${nb.id}" style="padding:3px 8px;cursor:pointer;border-bottom:1px solid #1d2430;">`
                    + `<span style="color:${nb.color}">◼</span> ${escapeHtml(nb.name)} <span style="color:#666">#${nb.id}</span>`
                    + (nb.src === 'center' ? ' <span style="color:#ffa030" title="no Site Watch snapshot — found via site center">◦center</span>' : '')
                    + `<span style="color:#888"> — ${nb.counts.ffz} FFZ · ${nb.counts.fp} FP · ${nb.counts.asset} assets · closest ${min}</span></div>`);
            });
            rows.push(`<div style="padding:4px 8px;border-bottom:1px solid #222834;color:${nbState.conflicts.length ? NB_CONFLICT_COLOR : '#5fff5f'};font-weight:bold">`
                + (nbState.conflicts.length ? `⚠ ${nbState.conflicts.length} conflict(s) under ${nbCfg.thresholdFt} ft` : `No conflicts under ${nbCfg.thresholdFt} ft ✓`) + '</div>');
            nbState.conflicts.forEach((c, i) => {
                rows.push(`<div class="aim-sd-nb-row" data-nb-z="${i}" style="padding:3px 8px;cursor:pointer;border-bottom:1px solid #1d2430;">`
                    + `<span style="color:${NB_CONFLICT_COLOR};font-weight:bold">${c.overlap ? 'OVERLAP' : `${c.ft} ft`}</span> `
                    + `${c.localCls.toUpperCase()} <span style="color:#ddd">${escapeHtml(c.localName)}</span>`
                    + ` ↔ ${c.foreignCls.toUpperCase()} <span style="color:${c.siteColor}">${escapeHtml(c.foreignName)}</span>`
                    + `<span style="color:#888"> (${escapeHtml(c.siteName)})</span></div>`);
            });
            if (nbState.unchecked.length) {
                rows.push(`<div style="padding:4px 8px;color:#ffa030">⚠ ${nbState.unchecked.length} site(s) NOT checked — no snapshot, no usable center. Full list in 📋 Copy report.</div>`);
            }
            nbState.notes.forEach(n => rows.push(`<div style="padding:2px 8px;color:#888">note: ${escapeHtml(n)}</div>`));
        }
        body.innerHTML = `<div style="max-height:46vh;overflow-y:auto;">${rows.join('')}</div>`;
    }

    function openNbPanel() {
        if (!nbPanelEl) {
            nbPanelEl = document.createElement('div');
            nbPanelEl.id = 'aim-sd-nb-panel';
            nbPanelEl.style.cssText = 'position:fixed;top:90px;right:16px;z-index:2147480002;width:480px;'
                + 'background:#14181f;color:#ddd;border:1px solid #2a3140;border-radius:6px;'
                + 'font:12px/1.5 monospace;box-shadow:0 4px 18px rgba(0,0,0,0.5);';
            nbPanelEl.innerHTML = ''
                + '<div id="aim-sd-nb-drag" style="padding:7px 10px;color:#7adfe6;font-weight:bold;border-bottom:1px solid #2a3140;cursor:move;user-select:none;">'
                + '⬡ Site Diff — neighboring sites <span data-nb="close" style="float:right;cursor:pointer;color:#888">✕</span></div>'
                + '<div id="aim-sd-nb-status" style="padding:5px 10px;border-bottom:1px solid #222834;color:#aaa;"></div>'
                + '<div id="aim-sd-nb-body"></div>'
                + '<div style="padding:6px 10px;border-top:1px solid #222834;display:flex;gap:12px;flex-wrap:wrap;">'
                + '<span data-nb="scan" style="cursor:pointer;color:#5fff5f">⟲ Rescan</span>'
                + '<span data-nb="copy" style="cursor:pointer;color:#7adfe6">📋 Copy report</span>'
                + '<span data-nb="index" style="cursor:pointer;color:#ffa030" title="Re-check every Site Watch snapshot sha and refetch changed ones">⟳ Update index</span>'
                + '</div>';
            document.body.appendChild(nbPanelEl);
            const hoverCss = document.createElement('style');
            hoverCss.textContent = '#aim-sd-nb-body .aim-sd-nb-row:hover{background:#222a38;}';
            nbPanelEl.appendChild(hoverCss);
            // Delegated — body is rebuilt per render, the panel root never is
            nbPanelEl.addEventListener('click', (ev) => {
                const act = ev.target.closest('[data-nb]');
                if (act) {
                    const cmd = act.getAttribute('data-nb');
                    if (cmd === 'close') nbPanelEl.style.display = 'none';
                    else if (cmd === 'scan') scanNeighbors(true);
                    else if (cmd === 'index') { nbIndex.checkedAt = 0; scanNeighbors(true); }
                    else if (cmd === 'copy') {
                        try {
                            navigator.clipboard.writeText(buildNbReport())
                                .then(() => nbSetStatus('report copied to clipboard'))
                                .catch(e => { console.warn(`${TAG} clipboard write failed:`, e); nbSetStatus('clipboard write failed'); });
                        } catch (e) { console.warn(`${TAG} clipboard unavailable:`, e); }
                    }
                    return;
                }
                const zRow = ev.target.closest('[data-nb-z]');
                if (zRow && nbState) {
                    const c = nbState.conflicts[Number(zRow.getAttribute('data-nb-z'))];
                    const map = getLeafletMap();
                    if (c && map) {
                        try {
                            map.setView([c.lat, c.lng], Math.max(map.getZoom ? map.getZoom() : 17, 17));
                            if (c._halo) {
                                c._halo.setStyle({ weight: 5, opacity: 1 });
                                setTimeout(() => { try { c._halo.setStyle({ weight: 2, opacity: 0.6 }); } catch (e) {} }, 1400);
                            }
                        } catch (e) { console.warn(`${TAG} zoom-to-conflict failed:`, e); }
                    }
                    return;
                }
                const sRow = ev.target.closest('[data-nb-site]');
                if (sRow && nbState) {
                    const nb = nbState.neighbors.find(n => n.id === sRow.getAttribute('data-nb-site'));
                    const b = nb && nbIndex.bboxes[nb.id];
                    const map = getLeafletMap();
                    const L = getL();
                    if (b && !b.empty && map && L) {
                        try { map.fitBounds(L.latLngBounds([[b.minLat, b.minLng], [b.maxLat, b.maxLng]]).pad(0.2)); }
                        catch (e) { console.warn(`${TAG} zoom-to-neighbor failed:`, e); }
                    }
                }
            });
            const dragBar = nbPanelEl.querySelector('#aim-sd-nb-drag');
            dragBar.addEventListener('pointerdown', (ev) => {
                if (ev.target.getAttribute && ev.target.getAttribute('data-nb') === 'close') return;
                ev.preventDefault();
                const r = nbPanelEl.getBoundingClientRect();
                const offX = ev.clientX - r.left, offY = ev.clientY - r.top;
                const onMove = (mv) => {
                    nbPanelEl.style.left = `${Math.max(0, mv.clientX - offX)}px`;
                    nbPanelEl.style.right = 'auto';
                    nbPanelEl.style.top = `${Math.max(0, mv.clientY - offY)}px`;
                };
                const onUp = () => {
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                };
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
        }
        nbPanelEl.style.display = 'block';
        const st = nbPanelEl.querySelector('#aim-sd-nb-status');
        if (st && nbState && nbState.status) st.textContent = nbState.status;
        renderNbPanel();
    }

    // ------------------------------------------------------------------
    // Control Panel integration
    // ------------------------------------------------------------------
    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER',
            scriptId: SCRIPT_ID,
            name: 'Site Diff',
            description: 'Overlay another site\'s Site Setup on this map as a ghost layer — compare an offline/staging copy against the live site.',
            version: SCRIPT_VERSION,
            group: 'Site Setup',
            priority: 50,
            toggles: [
                { id: 'master', label: 'Enable shadow overlay', type: 'boolean', default: false, master: true },
                { id: 'choose-site', label: '🗺 Choose shadow (site or JSON backup)…', type: 'button', action: 'choose-site' },
                { id: 'refresh-shadow', label: '⟳ Refresh shadow data', type: 'button', action: 'refresh-shadow' },
                { type: 'header', label: 'Neighbor sites (cross-site overlap)' },
                { id: 'nb-enable', label: 'Show neighboring site setups', type: 'boolean', default: false },
                { id: 'nb-radius', label: 'Neighbor display radius', type: 'number', min: 100, max: 20000, step: 100, default: 1000, unit: 'ft' },
                { id: 'nb-threshold', label: 'Conflict threshold', type: 'number', min: 10, max: 2000, step: 10, default: 200, unit: 'ft' },
                { id: 'nb-ffz', label: 'Check FFZs', type: 'boolean', default: true },
                { id: 'nb-fp', label: 'Check flight paths', type: 'boolean', default: true },
                { id: 'nb-asset', label: 'Check assets', type: 'boolean', default: true },
                { id: 'nb-scan', label: '⬡ Scan neighbors now', type: 'button', action: 'nb-scan' },
                { id: 'nb-panel', label: '⚠ Neighbor conflicts panel…', type: 'button', action: 'nb-panel' },
                { type: 'header', label: 'Compare' },
                { id: 'swipe', label: 'Swipe divider', type: 'boolean', default: false },
                { id: 'swipe-mode', label: 'Swipe mode (or drag handle: M1 split / M2 overlay)', type: 'select', default: 'split', options: [
                    { value: 'split', label: 'Split — left Original · right New' },
                    { value: 'overlay', label: 'Overlay reveal — ghost right of handle' },
                ] },
                { id: 'diff-threshold', label: 'Significant-change threshold', type: 'number', min: 5, max: 300, step: 5, default: 30, unit: 'ft' },
                { id: 'diff-new-threshold', label: 'Label "NEW route" beyond', type: 'number', min: 50, max: 2000, step: 50, default: 300, unit: 'ft' },
                { id: 'diff-ffz', label: 'Diff FFZ perimeters too (not just FPs)', type: 'boolean', default: true },
                { id: 'diff-focus', label: 'Focus mode — hide all entities except change highlights', type: 'boolean', default: false },
                { id: 'diff-color', label: 'Change highlight color', type: 'color', default: '#ff2d2d' },
                { id: 'run-diff', label: '⚖ Run significant-change diff', type: 'button', action: 'run-diff' },
                { id: 'clear-diff', label: 'Clear diff highlights + issues', type: 'button', action: 'clear-diff' },
                { type: 'header', label: 'Migration (CSM only)' },
                { id: 'plan-migration', label: '🧭 Plan migration (read-only preview)', type: 'button', action: 'plan-migration' },
                { id: 'backup-live', label: '💾 Backup Live site JSON', type: 'button', action: 'backup-live' },
                { id: 'open-import', label: '📥 Import shadow entities → this site…', type: 'button', action: 'open-import' },
                { type: 'header', label: 'Style' },
                { id: 'dashed', label: 'Dashed lines (ghost look)', type: 'boolean', default: true },
                { id: 'weight', label: 'Line weight', type: 'number', min: 1, max: 8, step: 1, default: 2, unit: 'px' },
                { id: 'marker-size', label: 'Point marker size', type: 'number', min: 2, max: 14, step: 1, default: 6, unit: 'px' },
                ...SHADOW_TYPES.map(t => ({
                    type: 'category',
                    id: `${t.key}-cat`,
                    label: t.label,
                    master: { id: `${t.key}.show`, default: true },
                    children: [
                        { id: `${t.key}.color`, label: 'Color', type: 'color', default: t.color },
                        { id: `${t.key}.opacity`, label: 'Opacity', type: 'number', min: 0.05, max: 1, step: 0.05, default: 0.75 },
                    ],
                })),
            ],
            hotkeys: [],
        });
    }

    function handleSetToggle(msg) {
        const rawVal = msg.value !== undefined ? msg.value : msg.enabled;
        const id = msg.toggleId;
        // Every branch early-returns on unchanged value — the panel echoes
        // stored toggles on REGISTER from BOTH frames, duplicates are normal.
        if (id === 'master') {
            const v = !!rawVal;
            if (v === masterEnabled) return;
            masterEnabled = v;
            gmSet(KEY_MASTER, v);
            console.log(`${TAG} shadow overlay ${v ? 'ON' : 'OFF'}`);
            renderShadow(false);
            return;
        }
        if (id === 'nb-enable') {
            const v = !!rawVal;
            if (v === nbCfg.enabled) return;
            nbCfg.enabled = v;
            saveNbCfg();
            console.log(`${TAG} neighbor overlay ${v ? 'ON' : 'OFF'}`);
            if (v) scanNeighbors(false);
            else { nbScanSeq++; clearNbLayers(); nbState = null; updateNbBadge(); if (nbPanelEl && nbPanelEl.style.display !== 'none') renderNbPanel(); }
            return;
        }
        if (id === 'nb-radius' || id === 'nb-threshold') {
            const n = Number(rawVal);
            const prop = id === 'nb-radius' ? 'radiusFt' : 'thresholdFt';
            if (isNaN(n) || n === nbCfg[prop]) return;
            nbCfg[prop] = n;
            saveNbCfg();
            if (nbCfg.enabled) scanNeighbors(false);
            return;
        }
        const nbCls = id.match(/^nb-(ffz|fp|asset)$/);
        if (nbCls) {
            const v = !!rawVal;
            if (v === nbCfg.classes[nbCls[1]]) return;
            nbCfg.classes[nbCls[1]] = v;
            saveNbCfg();
            if (nbCfg.enabled) scanNeighbors(false);
            return;
        }
        if (id === 'dashed') {
            const v = !!rawVal;
            if (v === style.dashed) return;
            style.dashed = v;
            saveStyle();
            scheduleRedraw();
            return;
        }
        if (id === 'swipe') {
            const v = !!rawVal;
            if (v === diffCfg.swipe) return;
            diffCfg.swipe = v;
            saveDiffCfg();
            applySwipeClip();
            return;
        }
        if (id === 'swipe-mode') {
            const v = String(rawVal);
            if ((v !== 'split' && v !== 'overlay') || v === diffCfg.swipeMode) return;
            diffCfg.swipeMode = v;
            saveDiffCfg();
            applySwipeClip();
            return;
        }
        if (id === 'diff-threshold') {
            const n = Number(rawVal);
            if (isNaN(n) || n === diffCfg.thresholdFt) return;
            diffCfg.thresholdFt = n;
            saveDiffCfg();
            return;   // takes effect on the next diff run
        }
        if (id === 'diff-new-threshold') {
            const n = Number(rawVal);
            if (isNaN(n) || n === diffCfg.newRouteFt) return;
            diffCfg.newRouteFt = n;
            saveDiffCfg();
            renderDiffList();   // relabels NEW vs distance rows in place
            return;
        }
        if (id === 'diff-focus') {
            const v = !!rawVal;
            if (v === diffCfg.focus) return;
            diffCfg.focus = v;
            saveDiffCfg();
            applyFocusMode();
            return;
        }
        if (id === 'diff-ffz') {
            const v = !!rawVal;
            if (v === diffCfg.includeFfz) return;
            diffCfg.includeFfz = v;
            saveDiffCfg();
            return;
        }
        if (id === 'diff-color') {
            const v = String(rawVal);
            if (v === diffCfg.color) return;
            diffCfg.color = v;
            saveDiffCfg();
            diffLayers.forEach(l => { try { l.setStyle({ color: v }); } catch (e) {} });
            return;
        }
        if (id === 'weight' || id === 'marker-size') {
            const n = Number(rawVal);
            if (isNaN(n)) return;
            const prop = id === 'weight' ? 'weight' : 'markerSize';
            if (n === style[prop]) return;
            style[prop] = n;
            saveStyle();
            scheduleRedraw();
            return;
        }
        const m = id.match(/^([a-z]+)\.(show|color|opacity)$/);
        if (m && style.types[m[1]]) {
            const ts = style.types[m[1]];
            if (m[2] === 'show') {
                const v = !!rawVal;
                if (v === ts.show) return;
                ts.show = v;
            } else if (m[2] === 'color') {
                const v = String(rawVal);
                if (v === ts.color) return;
                ts.color = v;
            } else {
                const n = Number(rawVal);
                if (isNaN(n) || n === ts.opacity) return;
                ts.opacity = n;
            }
            saveStyle();
            scheduleRedraw();
        }
    }

    function handleAction(actionId) {
        // Gate to the focused tab — BroadcastChannel reaches every tab's iframe
        if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
        if (actionId === 'choose-site') openPicker();
        else if (actionId === 'refresh-shadow') renderShadow(true);
        else if (actionId === 'run-diff') runDiff();
        else if (actionId === 'clear-diff') clearDiff(true);
        else if (actionId === 'plan-migration') planMigration();
        else if (actionId === 'backup-live') backupLiveSite();
        else if (actionId === 'open-import') openImportPanel();
        else if (actionId === 'nb-scan') { openNbPanel(); scanNeighbors(true); }
        else if (actionId === 'nb-panel') openNbPanel();
    }

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} control channel unavailable:`, e); return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) handleSetToggle(msg);
            else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === SCRIPT_ID) { if (msg.tabId ? msg.tabId !== aimTabId() : document.hidden) return; /* cross-tab guard */ handleAction(msg.actionId); }
            else if (msg.type === 'TOKEN_VALUE') {
                cachedToken = String(msg.token || '');
                // The import panel shows a "needs token" hint — refresh it
                if (impState && !impState.running && impPanelEl && impPanelEl.style.display !== 'none') renderImportPlan();
            }
        };
        try { controlChannel.postMessage({ type: 'REQUEST_TOKEN' }); } catch (e) {}
    }

    // ------------------------------------------------------------------
    // Site detection (hash lives on the TOP window; iframe never sees its
    // hashchange, so listen on both)
    // ------------------------------------------------------------------
    function readSiteIdFromHash() {
        let hash = '';
        try { hash = (window.top && window.top.location && window.top.location.hash) || ''; }
        catch (e) {}
        if (!hash) hash = location.hash || '';
        const m = hash.match(SITE_ID_RE);
        return m ? m[1] : null;
    }

    function setCurrentSite(newId) {
        if (newId === siteID) return;
        // Diff results belong to the site they ran on — never carry across
        clearDiff(false);
        siteID = newId;
        console.log(`${TAG} site → ${siteID || '(none)'}`);
        if (pickerEl) { pickerEl.style.display = 'none'; }
        if (diffPanelEl) { diffPanelEl.style.display = 'none'; }
        // An import plan is target-site-specific — never carry it across
        if (impPanelEl) { impPanelEl.style.display = 'none'; }
        impState = null;
        // Neighbor results belong to the site they ran on
        nbScanSeq++;
        clearNbLayers();
        nbState = null;
        if (nbPanelEl) { nbPanelEl.style.display = 'none'; }
        updateNbBadge();
        renderShadow(false);
        if (nbCfg.enabled && siteID) scanNeighbors(false);
    }

    function attachHashListener() {
        const handler = () => setCurrentSite(readSiteIdFromHash());
        try {
            if (window.top && window.top !== window) {
                window.top.addEventListener('hashchange', handler);
            }
        } catch (e) {}
        window.addEventListener('hashchange', handler);
    }

    // ------------------------------------------------------------------
    // Sibling-script control channel (v0.61) — the Asset Inspector's
    // Bulk → 🗑 Delete arms the revert path here: it hands us its
    // pre-delete backup, we bank it as this site's file-shadow so
    // 📥 Import can restore in two clicks. GM storage is per-script,
    // hence the BroadcastChannel handoff.
    // ------------------------------------------------------------------
    function setupSiblingCtrl() {
        try {
            const ch = new BroadcastChannel('AIM_SITEDIFF_CTRL');
            ch.onmessage = (ev) => {
                const m = ev.data || {};
                if (m.type !== 'SET_FILE_SHADOW' || !m.siteId || !Array.isArray(m.entities) || !m.entities.length) return;
                const sid = String(m.siteId);
                const name = String(m.name || 'predelete-backup.json');
                try {
                    storeShadowFile(sid, name, m.entities);
                    // BroadcastChannel is per-origin, so this is always a
                    // same-server handoff — envSiteKey applies cleanly.
                    setPair(sid, { kind: 'file', name });
                    console.log(`${TAG} revert shadow armed for site ${sid} — "${name}" (${m.entities.length} entities) via AIM_SITEDIFF_CTRL`);
                    if (sid === String(siteID)) renderShadow(false);
                } catch (e) { console.warn(`${TAG} SET_FILE_SHADOW failed:`, e); }
            };
        } catch (e) { console.warn(`${TAG} sibling ctrl channel unavailable:`, e); }
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    setupControlPanel();
    setupSiblingCtrl();
    registerWithControlPanel();
    if (!patchLeafletMap()) {
        let patchTries = 0;
        const patchTimer = setInterval(() => {
            if (patchLeafletMap() || ++patchTries >= 60) clearInterval(patchTimer);
        }, 500);
    }
    attachHashListener();
    siteID = readSiteIdFromHash();
    // Safety net: Percepto is an SPA and some navigations can slip past the
    // hashchange listeners — poll so a stale shadow never survives onto a
    // site it wasn't paired with.
    setInterval(() => {
        const id = readSiteIdFromHash();
        if (id !== siteID) setCurrentSite(id);
    }, 2000);
    renderShadow(false);
    if (nbCfg.enabled && siteID) scanNeighbors(false);
    console.log(`${TAG} v${SCRIPT_VERSION} ready (master ${masterEnabled ? 'ON' : 'OFF'}, neighbors ${nbCfg.enabled ? 'ON' : 'OFF'}${siteID ? `, site ${siteID}` : ''})`);
})();
