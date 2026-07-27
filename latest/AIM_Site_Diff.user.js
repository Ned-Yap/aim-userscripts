// ==UserScript==
// @name         Latest - AIM Site Diff
// @namespace    http://tampermonkey.net/
// @version      0.52
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Diff.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Diff.user.js
// @description  Site comparison suite: shadow-site ghost overlay (per-type show/color/opacity), swipe divider, significant-change diff (→ AIM Issues), and Phase 3a Import — create-only copy of shadow entities (assets etc.) onto the current site with dry-run preview + verify. Full migration executor later.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
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
// No hotkeys. Log tag: [AIM DIFF]

(function () {
    'use strict';

    const TAG = '[AIM DIFF]';
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
    const SCRIPT_VERSION = '0.52';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const PANE_NAME = 'aim-site-diff-pane';
    const HL_PANE_NAME = 'aim-site-diff-hl';
    const SITE_ID_RE = /#\/site\/(\d+)\//;

    const KEY_MASTER = 'aim-sd-master';
    const KEY_STYLE = 'aim-sd-style';
    const KEY_PAIRS = 'aim-sd-pairs';
    const KEY_SITES_CACHE = 'aim-sd-sites-cache';
    const KEY_DIFF = 'aim-sd-diff';
    const KEY_FILE_PREFIX = 'aim-sd-file-';   // + siteID → stored JSON-backup shadow

    console.log(`${TAG} v${SCRIPT_VERSION} loading`);

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
    let pairs = loadPairs();               // { siteId: '<shadowSiteId>' | {kind:'file', name} }
    const shadowCache = {};                // { cacheKey: { entities, fetchedAt } }
    let sitesList = null;                  // [{id, name}]
    let siteID = null;
    let controlChannel = null;

    // Shadow source model: a pairs[] value is either a site-id string
    // (v0.10 format, kept as-is) or {kind:'file', name} for an uploaded
    // /map_objects JSON backup (stored per-site in GM, survives reloads).
    function shadowSourceFor(sid) {
        const v = sid ? pairs[sid] : null;
        if (!v) return null;
        if (typeof v === 'string') return { kind: 'site', id: v };
        if (v && v.kind === 'file') return v;
        return null;
    }
    function shadowSourceLabel(src) {
        if (!src) return '';
        if (src.kind === 'site') return siteLabel(src.id);
        return `file "${src.name}"`;
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

    async function fetchShadowEntities(shadowId, force) {
        if (!force && shadowCache[shadowId]) return shadowCache[shadowId].entities;
        let url = `/map_objects/?getPoiMapObjectsAsList=true&site_id=${encodeURIComponent(shadowId)}`;
        if (force) url += `&_t=${Date.now()}`;
        try {
            const r = await fetchWithTimeout(url, {
                credentials: 'same-origin',
                cache: force ? 'no-store' : 'default',
                headers: { 'Accept': 'application/json' },
            }, 20000);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            if (!Array.isArray(data)) throw new Error('response not an array');
            shadowCache[shadowId] = { entities: data, fetchedAt: Date.now() };
            console.log(`${TAG} loaded ${data.length} entities for shadow site ${shadowId}`);
            return data;
        } catch (e) {
            console.warn(`${TAG} shadow fetch failed for site ${shadowId}:`, e);
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
            gmSet(KEY_FILE_PREFIX + sid, JSON.stringify({ name, savedAt: Date.now(), entities }));
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
            const raw = gmGet(KEY_FILE_PREFIX + sid, null);
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
        if (src.kind === 'site') return fetchShadowEntities(src.id, force);
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

    async function fetchSiteList(force) {
        if (sitesList && !force) return sitesList;
        try {
            const r = await fetchWithTimeout('/sites/', {
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' },
            }, 20000);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const text = await r.text();
            const list = extractList(JSON.parse(text));
            const seen = new Set();
            const out = [];
            for (const s of list) {
                const id = String(s.id != null ? s.id : (s.site_id != null ? s.site_id : ''));
                if (!id || seen.has(id)) continue;
                seen.add(id);
                out.push({ id, name: String(s.name || s.site_name || s.title || `site ${id}`) });
            }
            if (out.length) {
                sitesList = out;
                gmSet(KEY_SITES_CACHE, JSON.stringify(out));
                return out;
            }
            throw new Error('empty site list');
        } catch (e) {
            console.warn(`${TAG} site list fetch failed:`, e);
            try {
                const cached = gmGet(KEY_SITES_CACHE, null);
                if (cached) {
                    sitesList = JSON.parse(cached);
                    return sitesList;
                }
            } catch (e2) {}
            return null;
        }
    }

    function siteLabel(id) {
        if (sitesList) {
            const s = sitesList.find(x => x.id === String(id));
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
    function updateBadge() {
        let b = document.getElementById('aim-sd-badge');
        const src = (masterEnabled && siteID) ? shadowSourceFor(siteID) : null;
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
        const cached = shadowCache[src.kind === 'site' ? src.id : fileCacheKey(siteID)];
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
        const cached = shadowCache[src.kind === 'site' ? src.id : fileCacheKey(siteID)];
        const count = cached ? ` — ${cached.entities.length} entities` : '';
        const idBit = src.kind === 'site' ? ` <span style="color:#666">#${src.id}</span>` : '';
        return `Shadowing <span style="color:#ffa030">${escapeHtml(shadowSourceLabel(src))}</span>${idBit}${count}`;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function renderPickerList(filter) {
        const listEl = pickerEl && pickerEl.querySelector('#aim-sd-list');
        if (!listEl) return;
        const f = (filter || '').trim().toLowerCase();
        const rows = [];
        if (/^\d+$/.test(f)) {
            rows.push(`<div class="aim-sd-row" data-sid="${f}" style="color:#7adfe6">➜ Use site ID ${f} directly</div>`);
        }
        if (sitesList) {
            sitesList
                .filter(s => s.id !== siteID)
                .filter(s => !f || s.name.toLowerCase().includes(f) || s.id.includes(f))
                .slice(0, 200)
                .forEach(s => {
                    const cur = shadowSourceFor(siteID);
                    const active = !!(cur && cur.kind === 'site' && cur.id === s.id);
                    rows.push(`<div class="aim-sd-row" data-sid="${s.id}" style="${active ? 'color:#ffa030;' : ''}">`
                        + `${escapeHtml(s.name)} <span style="color:#666">#${s.id}</span>${active ? ' ◈' : ''}</div>`);
                });
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
            pickerEl.querySelector('#aim-sd-clear').addEventListener('click', () => {
                if (siteID && pairs[siteID]) {
                    console.log(`${TAG} cleared shadow pairing for site ${siteID}`);
                    const src = shadowSourceFor(siteID);
                    if (src && src.kind === 'file') {
                        delete shadowCache[fileCacheKey(siteID)];
                        gmSet(KEY_FILE_PREFIX + siteID, '');   // drop the stored backup too
                    }
                    delete pairs[siteID];
                    savePairs();
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
                        pairs[siteID] = { kind: 'file', name: f.name };
                        savePairs();
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
                fetchSiteList(true).then(() => renderPickerList(pickerEl.querySelector('#aim-sd-search').value));
                renderShadow(true);
            });
            // Row clicks via delegation — the list is rebuilt on every keystroke
            pickerEl.querySelector('#aim-sd-list').addEventListener('click', (ev) => {
                const row = ev.target.closest('[data-sid]');
                if (!row || !siteID) return;
                const sid = row.getAttribute('data-sid');
                if (sid === siteID) return;
                pairs[siteID] = sid;
                savePairs();
                console.log(`${TAG} site ${siteID} now shadows site ${sid}`);
                if (!masterEnabled) {
                    console.log(`${TAG} note: master toggle is OFF — enable "Site Diff" in the Control Panel to see the overlay`);
                }
                renderShadow(false);
                pickerEl.style.display = 'none';
            });
        }
        pickerEl.style.display = 'block';
        refreshPickerStatus();
        renderPickerList(pickerEl.querySelector('#aim-sd-search').value);
        fetchSiteList(false).then(() => {
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
                fetchShadowEntities(siteID, true),          // THIS (Offline) site — always fresh
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
                fetchShadowEntities(siteID, true),
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
        const ents = await fetchShadowEntities(src.id, true);
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
    const IMPORT_SKIP_TYPES = { 8: 'Base Station', 98: 'Safe Zone' };   // hardware-bound — never imported
    const IMPORT_POST_GAP_MS = 120;

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
        if (src.kind === 'site' && String(src.id) === String(siteID)) {
            setImpBody('<div style="padding:8px"><span style="color:#ff5252">The shadow IS this site — nothing to import.</span></div>');
            return;
        }
        setImpBody('<div style="padding:8px;color:#aaa">Loading source + target…</div>');
        try {
            const [source, target] = await Promise.all([
                getShadowEntities(siteID, src, src.kind === 'site'),
                fetchShadowEntities(String(siteID), true),
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
        const runLabel = impState.armed
            ? `⚠ Click again to CREATE ${sel.length} — this writes to the server`
            : `🚀 Create ${sel.length} entities on this site`;
        const runColor = impState.armed ? '#ff5252' : (sel.length ? '#5fff5f' : '#555');
        setImpBody(''
            + `<div style="padding:4px 6px;border-bottom:1px solid #222834;">`
            + `SOURCE: ${escapeHtml(impState.srcLabel)} → TARGET: this site (${escapeHtml(String(siteID))}) · ${targetNote}<br>`
            + `<span style="color:#888">Create-only: existing target entities are never touched. Fields copy verbatim (incl. validated flag).</span></div>`
            + `<div style="padding:4px 0;border-bottom:1px solid #222834;">${typeRows}</div>`
            + `<div style="max-height:34vh;overflow-y:auto;">${preview || '<div style="color:#888;padding:6px">Nothing selected to create.</div>'}`
            + (sel.length > 400 ? `<div style="color:#888;padding:4px 6px">…and ${sel.length - 400} more</div>` : '') + '</div>'
            + `<div id="aim-sd-imp-status" style="padding:4px 6px;border-top:1px solid #222834;min-height:18px;"></div>`
            + `<div style="padding:6px;display:flex;gap:12px;flex-wrap:wrap;border-top:1px solid #222834;">`
            + `<span data-imp="run" style="cursor:${sel.length ? 'pointer' : 'default'};color:${runColor};font-weight:bold">${runLabel}</span>`
            + `<span data-imp="backup-src" style="cursor:pointer;color:#7adfe6">💾 Backup source JSON</span>`
            + `<span data-imp="refresh" style="cursor:pointer;color:#7adfe6">⟳ Re-check</span>`
            + (impState.report ? `<span data-imp="log" style="cursor:pointer;color:#ffa030">📄 Download run log</span>` : '')
            + '</div>');
    }

    async function runImport() {
        if (!impState || impState.running) return;
        const sel = importSelectedRows();
        if (!sel.length) { setImpStatus('Nothing selected.', '#888'); return; }
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
        setImpStatus('resolving CSRF token…');
        const csrf = await resolveCsrfToken();
        if (!csrf) {
            setImpStatus('no CSRF token yet — make ONE small native edit anywhere in Percepto (e.g. save any entity or move a marker), which lets the sniffer capture the app\'s own token, then re-run. Console shows the resolution trace.', '#ff5252');
            impState.running = false;
            return;
        }
        const created = [];
        const errors = [];
        try {
            const cfg = await fetchTargetSiteCfg(siteID, true);
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
            setImpStatus('verifying against a fresh fetch…');
            const verifyProblems = [];
            const fresh = await fetchShadowEntities(String(siteID), true);
            if (!fresh) {
                verifyProblems.push('verify fetch failed — created entities unconfirmed, check the site manually');
            } else {
                created.forEach(c => {
                    if (!fresh.some(e => e && e.id === c.id)) verifyProblems.push(`created "${c.name}" (id ${c.id}) missing from fresh fetch`);
                });
            }
            impState.report = {
                ranAt: new Date().toISOString(),
                targetSite: siteID,
                source: impState.srcLabel,
                created, errors, verifyProblems,
            };
            const col = errors.length || verifyProblems.length ? (created.length ? '#ffa030' : '#ff5252') : '#5fff5f';
            console.log(`${TAG} import done: ${created.length} created, ${errors.length} failed, ${verifyProblems.length} verify problems`, impState.report);
            impState.running = false;
            renderImportPlan();
            setImpStatus(
                `Done — <b>${created.length} created</b>`
                + (errors.length ? `, <span style="color:#ff5252">${errors.length} FAILED</span>` : '')
                + (verifyProblems.length ? `, <span style="color:#ff5252">${verifyProblems.length} verify problem(s)</span>` : ', all verified ✓')
                + ' · see run log / console for detail', col);
            // Re-check so freshly-created entities now show as "exists"
            if (!errors.length && !verifyProblems.length) setTimeout(() => { if (impState && !impState.running) prepareImport().then(() => { setImpStatus(`Done — ${created.length} created, all verified ✓ (re-checked)`, '#5fff5f'); }); }, 800);
        } catch (e) {
            console.warn(`${TAG} runImport threw:`, e);
            impState.report = { ranAt: new Date().toISOString(), targetSite: siteID, source: impState.srcLabel, created, errors, verifyProblems: ['run aborted: ' + String(e && e.message || e)] };
            impState.running = false;
            renderImportPlan();
            setImpStatus(`Import aborted after ${created.length} create(s) — ${escapeHtml(String(e && e.message || e))}. Created entities remain on the site (create-only, nothing was overwritten).`, '#ff5252');
        }
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
                const cb = ev.target.closest('input[data-imp-type]');
                if (!cb || (impState && impState.running)) return;
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
    }

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} control channel unavailable:`, e); return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) handleSetToggle(msg);
            else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === SCRIPT_ID) handleAction(msg.actionId);
        };
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
        renderShadow(false);
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
    // Init
    // ------------------------------------------------------------------
    setupControlPanel();
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
    console.log(`${TAG} v${SCRIPT_VERSION} ready (master ${masterEnabled ? 'ON' : 'OFF'}${siteID ? `, site ${siteID}` : ''})`);
})();
