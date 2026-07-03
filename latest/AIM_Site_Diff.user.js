// ==UserScript==
// @name         Latest - AIM Site Diff
// @namespace    http://tampermonkey.net/
// @version      0.30
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Diff.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Diff.user.js
// @description  Site comparison suite: shadow-site ghost overlay (per-type show/color/opacity), swipe divider, and significant-change diff — stretches of this site's FPs/FFZs outside the shadow site's approved envelope (old FFZs + FPs buffered by a threshold) are highlighted and can be sent to AIM Issues for regs review. Phase 3 (API migration) later.
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
// No hotkeys. Log tag: [AIM DIFF]

(function () {
    'use strict';

    const TAG = '[AIM DIFF]';
    const IS_IFRAME = window !== window.top;
    if (!IS_IFRAME) {
        try { console.log(`${TAG} top frame — idle (map is in iframe)`); } catch (e) {}
        return;
    }

    const SCRIPT_ID = 'aim-site-diff';
    const SCRIPT_VERSION = '0.30';
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
        return { lenFt, segTxt, offTxt, isNew };
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

    // ---------------- Diff results panel ----------------
    let diffPanelEl = null;

    function setDiffStatus(msg) {
        const el = diffPanelEl && diffPanelEl.querySelector('#aim-sd-diff-status');
        if (el) el.textContent = msg;
    }

    function renderDiffList() {
        const el = diffPanelEl && diffPanelEl.querySelector('#aim-sd-diff-list');
        if (!el) return;
        if (!diffStretches.length) { el.innerHTML = ''; return; }
        el.innerHTML = diffStretches.map((s, i) => {
            const d = stretchDesc(s);
            const offHtml = d.isNew
                ? `<span style="color:#ff5252;font-weight:bold">NEW</span>`
                : escapeHtml(d.offTxt);
            return `<div class="aim-sd-row" data-di="${i}">`
                + `<span style="color:${s.kind === 'FP' ? '#ffa030' : '#d05fff'}">${s.kind}</span> · `
                + `${escapeHtml(s.name)} <span style="color:#666">(${d.segTxt})</span>`
                + ` — ${d.lenFt.toLocaleString()} ft — ${offHtml}</div>`;
        }).join('');
    }

    function openDiffPanel() {
        if (!diffPanelEl) {
            diffPanelEl = document.createElement('div');
            diffPanelEl.id = 'aim-sd-diff-panel';
            diffPanelEl.style.cssText = 'position:fixed;top:70px;left:16px;z-index:2147480001;width:340px;'
                + 'background:#14181f;color:#ddd;border:1px solid #2a3140;border-radius:6px;'
                + 'font:12px/1.5 monospace;box-shadow:0 4px 18px rgba(0,0,0,0.5);';
            diffPanelEl.innerHTML = ''
                + '<div style="padding:7px 10px;color:#7adfe6;font-weight:bold;border-bottom:1px solid #2a3140;">'
                + '⚖ Site Diff — significant changes <span id="aim-sd-diff-close" style="float:right;cursor:pointer;color:#888">✕</span></div>'
                + '<div id="aim-sd-diff-status" style="padding:6px 10px;border-bottom:1px solid #222834;color:#aaa;"></div>'
                + '<div id="aim-sd-diff-list" style="max-height:300px;overflow-y:auto;padding:0 4px;"></div>'
                + '<div style="padding:6px 10px;border-top:1px solid #222834;display:flex;gap:10px;flex-wrap:wrap;">'
                + '<span id="aim-sd-diff-issues" style="cursor:pointer;color:#ff8ac2">🚩 Send to Issues</span>'
                + '<span id="aim-sd-diff-copy" style="cursor:pointer;color:#7adfe6">📋 Copy report</span>'
                + '<span id="aim-sd-diff-clear" style="cursor:pointer;color:#ff5252">Clear</span>'
                + '</div>';
            document.body.appendChild(diffPanelEl);
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
            // Click a row → zoom to the stretch + briefly fatten it
            diffPanelEl.querySelector('#aim-sd-diff-list').addEventListener('click', (ev) => {
                const row = ev.target.closest('[data-di]');
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
        diffPanelEl.style.display = 'block';
        renderDiffList();
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
