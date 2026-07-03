// ==UserScript==
// @name         Latest - AIM Site Diff
// @namespace    http://tampermonkey.net/
// @version      0.10
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Diff.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Site_Diff.user.js
// @description  Shadow-site overlay: render another site's Site Setup on the current map as a ghost layer (per-type show/color/opacity) for old vs new comparison. Phase 1 of the Site Diff suite (Phase 2: swipe + significant-change diff, Phase 3: API migration).
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

// AIM Site Diff — overlays a second site's Site Setup ("shadow site") on the
// current map so an offline/staging copy can be compared against the live
// site. Phase 1 is view-only: pick a shadow site, its entities draw as a
// dashed ghost layer with per-type show/color/opacity controls.
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
    const SCRIPT_VERSION = '0.10';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const PANE_NAME = 'aim-site-diff-pane';
    const SITE_ID_RE = /#\/site\/(\d+)\//;

    const KEY_MASTER = 'aim-sd-master';
    const KEY_STYLE = 'aim-sd-style';
    const KEY_PAIRS = 'aim-sd-pairs';
    const KEY_SITES_CACHE = 'aim-sd-sites-cache';

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

    let masterEnabled = gmGet(KEY_MASTER, false) === true;
    let style = loadStyle();
    let pairs = loadPairs();               // { currentSiteId: shadowSiteId }
    const shadowCache = {};                // { siteId: { entities, fetchedAt } }
    let sitesList = null;                  // [{id, name}]
    let siteID = null;
    let controlChannel = null;

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

    function drawAttempt(entities, shadowId, attempt, seq) {
        if (seq !== renderSeq) return;
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L) {
            if (attempt < 60) {
                setTimeout(() => drawAttempt(entities, shadowId, attempt + 1, seq), 500);
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
        console.log(`${TAG} shadow of site ${shadowId}: drew ${drawn} entities (${skipped} hidden/skipped)`);
        updateBadge();
    }

    function renderShadow(force) {
        const seq = ++renderSeq;
        clearShadowLayers();
        updateBadge();
        if (!masterEnabled || !siteID) return;
        const shadowId = pairs[siteID];
        if (!shadowId) return;
        fetchShadowEntities(shadowId, force).then(entities => {
            if (seq !== renderSeq || !entities) return;
            drawAttempt(entities, shadowId, 0, seq);
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
        const shadowId = (masterEnabled && siteID) ? pairs[siteID] : null;
        if (!shadowId || !document.querySelector('.leaflet-container')) {
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
        const cached = shadowCache[shadowId];
        const count = cached ? ` · ${cached.entities.length}` : '';
        b.textContent = `◈ Shadow: ${siteLabel(shadowId)}${count}`;
        b.style.display = 'block';
    }

    // ------------------------------------------------------------------
    // Shadow-site picker panel
    // ------------------------------------------------------------------
    let pickerEl = null;

    function pickerStatusHtml() {
        const shadowId = siteID ? pairs[siteID] : null;
        if (!shadowId) return '<span style="color:#888">No shadow site selected for this site.</span>';
        const cached = shadowCache[shadowId];
        const count = cached ? ` — ${cached.entities.length} entities` : '';
        return `Shadowing <span style="color:#ffa030">${escapeHtml(siteLabel(shadowId))}</span> <span style="color:#666">#${shadowId}</span>${count}`;
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
                    const active = pairs[siteID] === s.id;
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
                + '<div style="padding:6px 10px;border-top:1px solid #222834;display:flex;gap:8px;">'
                + '<span id="aim-sd-clear" style="cursor:pointer;color:#ff5252">Clear shadow</span>'
                + '<span id="aim-sd-refresh" style="cursor:pointer;color:#7adfe6">⟳ Refresh data</span>'
                + '</div>';
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
                    delete pairs[siteID];
                    savePairs();
                    renderShadow(false);
                    refreshPickerStatus();
                    renderPickerList(pickerEl.querySelector('#aim-sd-search').value);
                }
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
                { id: 'choose-site', label: '🗺 Choose shadow site…', type: 'button', action: 'choose-site' },
                { id: 'refresh-shadow', label: '⟳ Refresh shadow data', type: 'button', action: 'refresh-shadow' },
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
        siteID = newId;
        console.log(`${TAG} site → ${siteID || '(none)'}`);
        if (pickerEl) { pickerEl.style.display = 'none'; }
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
    renderShadow(false);
    console.log(`${TAG} v${SCRIPT_VERSION} ready (master ${masterEnabled ? 'ON' : 'OFF'}${siteID ? `, site ${siteID}` : ''})`);
})();
