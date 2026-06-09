// ==UserScript==
// @name         Latest - AIM Flight Path Editor
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  Insert a vertex in the MIDDLE of a Percepto flight-path segment from the map — click a "+" handle and it splits that one segment into two, no delete-and-rebuild. Mirrors the Power Line Editor's on-map vertex UX. DEV/personal.
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Flight_Path_Editor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Flight_Path_Editor.user.js
// ==/UserScript==
//
// AIM Flight Path Editor — on-map mid-segment vertex insert for Percepto flight paths.
//   - Toggle the ✚ button in .map-tools (iframe only — that's where the map is).
//   - A dim "+" handle appears at the MIDDLE of every flight-path segment that's
//     currently in view (pan/zoom loads more). No flight-path picking needed.
//   - Click a "+" → a real vertex is inserted there (arcs-splice via
//     POST /map_objects/), the data re-fetches, and the handles rebuild. The new
//     vertex is a genuine branchable/draggable waypoint (after one page reload —
//     Percepto's editor needs to re-read the entity).
//   - ↩ Undo button reverts the last insert.
// Mechanism proven in ShortKeys/AIM_Insert_Vertex.js. arcs is the geometry source
// of truth; the server rebuilds the path from arcs. Arc IDs regenerate every save,
// so we never key on them. Log tag: [AIM FPE].
//
(function() {
    'use strict';
    const TAG = '[AIM FPE]';
    const IS_IFRAME = window !== window.top;
    if (!IS_IFRAME) { try { console.log(`${TAG} top frame — idle (map is in iframe)`); } catch (e) {} return; }

    const MAP_OBJECTS_URL = 'https://percepto.app/map_objects/?getPoiMapObjectsAsList=true&site_id=';
    const SAVE_URL = 'https://percepto.app/map_objects/';

    const log = (...a) => { try { (unsafeWindow.console || console).log(TAG, ...a); } catch (e) {} };
    const warn = (...a) => { try { (unsafeWindow.console || console).warn(TAG, ...a); } catch (e) {} };

    function getCurrentSiteID() {
        const m = (location.hash || '').match(/#\/site\/(\d+)\//) || (top.location.hash || '').match(/#\/site\/(\d+)\//);
        return m ? m[1] : null;
    }
    function getCsrf() {
        const m = (document.cookie || '').match(/(?:^|;\s*)csrftoken=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    // ---- Leaflet map access (mirrors Map Styler's getLeafletMap) ----
    let leafletMapRef = null;
    function looksLikeLeafletMap(o) {
        return o && typeof o.latLngToContainerPoint === 'function' && typeof o.containerPointToLatLng === 'function'
            && typeof o.latLngToLayerPoint === 'function' && typeof o.getContainer === 'function' && typeof o.distance === 'function'
            && typeof o.getBounds === 'function';
    }
    function patchLeafletMap() {
        try {
            const L = unsafeWindow.L;
            if (!L || !L.Map || L.Map.prototype.__aim_fpe_patched) return;
            const origInit = L.Map.prototype.initialize;
            L.Map.prototype.initialize = function(...args) {
                const r = origInit.apply(this, args);
                try { if (this._container) this._container.__aim_map__ = this; } catch (e) {}
                return r;
            };
            L.Map.prototype.__aim_fpe_patched = true;
        } catch (e) {}
    }
    function getLeafletMap() {
        if (leafletMapRef && leafletMapRef._container && document.body.contains(leafletMapRef._container)) return leafletMapRef;
        const containers = document.querySelectorAll('.leaflet-container');
        for (const c of containers) {
            for (const cand of [c.__aim_map__, c._leaflet_map, c._leaflet]) {
                if (looksLikeLeafletMap(cand)) { leafletMapRef = cand; return cand; }
            }
            for (const k in c) { try { if (looksLikeLeafletMap(c[k])) { leafletMapRef = c[k]; return c[k]; } } catch (e) {} }
        }
        return null;
    }

    // ---- data ----
    let entities = [];
    async function fetchEntities() {
        const sid = getCurrentSiteID();
        if (!sid) return [];
        const r = await fetch(MAP_OBJECTS_URL + encodeURIComponent(sid) + '&_t=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        entities = await r.json();
        return entities;
    }
    let siteCfg = null;
    async function fetchSiteCfg() {
        const sid = getCurrentSiteID();
        if (siteCfg && siteCfg.__sid === sid) return siteCfg;
        const r = await fetch(`https://percepto.app/sites/${encodeURIComponent(sid)}/`, { credentials: 'same-origin' });
        siteCfg = await r.json(); siteCfg.__sid = sid; return siteCfg;
    }
    const flightPaths = () => entities.filter(e => e && e.type === 15 && Array.isArray(e.arcs) && e.arcs.length);

    function buildWriteBody(e, cfg) {
        const b = JSON.parse(JSON.stringify(e));
        b.site_id = e.site; b.points = (e.coords || []).slice();
        delete b.site; delete b.coords; delete b.polygon; delete b.asset_waypoints;
        b.mountain_terrain_site = !!(cfg && cfg.mountain_terrain);
        if (Array.isArray(b.arcs)) b.arcs.forEach(a => { if (a.point_a && a.point_b && !Array.isArray(a.points)) a.points = [a.point_a, a.point_b]; });
        return b;
    }

    async function insertVertex(e, idx, M) {
        const cfg = await fetchSiteCfg();
        const csrf = getCsrf();
        if (!csrf) { warn('no csrftoken'); return { ok: false }; }
        const before = JSON.parse(JSON.stringify(e));
        const b = buildWriteBody(e, cfg);
        const arc = b.arcs[idx];
        if (!arc) return { ok: false, reason: 'no arc' };
        const A = arc.point_a, B = arc.point_b;
        const mk = (pa, pb, frac) => ({
            point_a: pa, point_b: pb, distance: (arc.distance || 0) * frac,
            min_alt: arc.min_alt, max_alt: arc.max_alt, min_emergency_alt: arc.min_emergency_alt,
            wait_until_approved: arc.wait_until_approved || false, mapobject: e.id, points: [pa, pb],
        });
        const dAB = Math.hypot(B.lat - A.lat, B.lng - A.lng) || 1;
        const frac = Math.min(0.999, Math.max(0.001, Math.hypot(M.lat - A.lat, M.lng - A.lng) / dAB));
        b.arcs.splice(idx, 1, mk(A, M, frac), mk(M, B, 1 - frac));
        b.points.push(M);
        let resp;
        try {
            const r = await fetch(SAVE_URL, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'X-CSRFToken': csrf }, body: JSON.stringify(b) });
            const txt = await r.text();
            let j = null; try { j = JSON.parse(txt); } catch (x) {}
            resp = { status: r.status, json: j, raw: txt };
        } catch (err) { warn('POST threw', err); return { ok: false }; }
        if (resp.status !== 200) { warn('server', resp.status, (resp.raw || '').slice(0, 300)); return { ok: false, status: resp.status, raw: resp.raw }; }
        const vk = p => p ? `${p.lat.toFixed(6)},${p.lng.toFixed(6)}` : '∅';
        const newArcs = (resp.json.map_objects && resp.json.map_objects.arcs) || [];
        const newKeys = newArcs.map(a => vk(a.point_a) + '>' + vk(a.point_b));
        const remap = [];
        before.arcs.forEach((a, i) => {
            const ni = newKeys.indexOf(vk(a.point_a) + '>' + vk(a.point_b));
            if (ni === -1) remap.push(`old seg ${i + 1} → split`);
            else if (ni !== i) remap.push(`old seg ${i + 1} → seg ${ni + 1}`);
        });
        log(`inserted on "${e.name}" seg ${idx + 1}: arcs ${before.arcs.length} → ${newArcs.length}.`, remap.length ? 'renumbered: ' + remap.join(', ') : '');
        return { ok: true, saved: resp.json.map_objects, remap, backup: before };
    }

    // ---- on-map handles (all FPs, viewport-culled) ----
    const state = { active: false, handles: [], moveHandler: null };
    function clearHandles() {
        state.handles.forEach(h => { try { h.remove(); } catch (e) {} });
        state.handles = [];
    }
    let busy = false;
    function rebuildHandles() {
        clearHandles();
        const map = getLeafletMap();
        const L = unsafeWindow.L;
        if (!map || !L || !state.active) { renderPanel(); return; }
        const ghost = L.divIcon({
            html: '<div style="display:flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:3px;background:rgba(34,197,94,0.9);border:1.5px solid #fff;color:#fff;font:700 13px/1 monospace;cursor:copy;box-shadow:0 0 5px rgba(0,0,0,0.7)" title="Click to add a vertex here">+</div>',
            className: 'aim-fpe-mid', iconSize: [16, 16], iconAnchor: [8, 8],
        });
        let total = 0;
        const bounds = map.getBounds();
        flightPaths().forEach(fp => {
            const eid = fp.id;
            (fp.arcs || []).forEach((arc, idx) => {
                const A = arc.point_a, B = arc.point_b;
                if (!A || !B) return;
                const mid = { lat: (A.lat + B.lat) / 2, lng: (A.lng + B.lng) / 2 };
                total++;
                if (!bounds.contains([mid.lat, mid.lng])) return; // only render what's in view
                const mk = L.marker([mid.lat, mid.lng], { icon: ghost, zIndexOffset: 900, keyboard: false });
                mk.on('click', async (ev) => {
                    try { if (ev.originalEvent) { ev.originalEvent.preventDefault(); ev.originalEvent.stopPropagation(); } } catch (e) {}
                    const ent = entities.find(x => x.id === eid);
                    if (ent) await doInsert(ent, idx, mid, mk);
                });
                mk.addTo(map);
                state.handles.push(mk);
            });
        });
        log(`showing ${state.handles.length} of ${total} insert points (in view)`);
        renderPanel();
    }

    async function doInsert(fp, idx, M, marker) {
        if (busy) return;
        busy = true;
        try {
            if (marker) try { marker.getElement().firstChild.style.background = 'rgba(255,213,79,0.95)'; } catch (e) {}
            const res = await insertVertex(fp, idx, M);
            if (!res.ok) { toast(`Insert failed${res.status ? ' (' + res.status + ')' : ''} — see console`, '#ff8a80'); return; }
            window.__aim_fpe_lastBackup = res.backup;
            await fetchEntities();
            rebuildHandles();
            toast(`Vertex added on ${fp.name}, seg ${idx + 1}. ↩ Undo in the panel, or refresh to edit it.`, '#7adfe6');
        } catch (e) { warn('insert error', e); }
        finally { busy = false; }
    }

    async function doUndo() {
        const o = window.__aim_fpe_lastBackup;
        if (!o) { toast('Nothing to undo', '#ffd479'); return; }
        try {
            const cfg = await fetchSiteCfg();
            const csrf = getCsrf();
            const b = buildWriteBody(o, cfg);
            const r = await fetch(SAVE_URL, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: JSON.stringify(b) });
            log('undo →', r.status);
            if (r.status === 200) { window.__aim_fpe_lastBackup = null; await fetchEntities(); rebuildHandles(); toast('Reverted last insert — refresh to see it in the editor', '#ffd479'); }
            else toast('Undo failed (' + r.status + ')', '#ff8a80');
        } catch (e) { warn('undo error', e); toast('Undo errored — see console', '#ff8a80'); }
    }
    unsafeWindow.__aim_fpe_undo = doUndo;

    // ---- UI ----
    const PANEL_ID = 'aim-fpe-panel';
    function toast(msg, color) {
        try {
            const t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1f2228;color:${color || '#e6e6e6'};border:1px solid ${color || '#5fff5f'}88;border-radius:6px;padding:10px 16px;font:13px -apple-system,sans-serif;z-index:100002;box-shadow:0 6px 20px rgba(0,0,0,0.6);max-width:80vw;text-align:center`;
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 5000);
        } catch (e) {}
    }
    function findToolsBar() { return document.querySelector('.map-tools'); }
    let buttonEl = null;
    function injectButton() {
        const tools = findToolsBar();
        if (!tools || buttonEl) return;
        const w = document.createElement('div');
        w.innerHTML = `<div class="map-tools__button aim-fpe-btn" title="Flight Path Editor — insert vertices" style="cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;user-select:none"><span style="font-size:17px;line-height:1">✚</span></div>`;
        buttonEl = w.firstElementChild;
        ['mousedown', 'click', 'contextmenu'].forEach(t => buttonEl.addEventListener(t, e => e.stopPropagation()));
        buttonEl.addEventListener('click', (e) => { e.preventDefault(); togglePanel(); });
        tools.appendChild(buttonEl);
        log('button injected into .map-tools');
    }
    function togglePanel() {
        if (document.getElementById(PANEL_ID)) { closePanel(); return; }
        openPanel();
    }
    async function openPanel() {
        try { await fetchEntities(); } catch (e) { warn('fetch failed', e); }
        state.active = true;
        const map = getLeafletMap();
        if (map && !state.moveHandler) { state.moveHandler = () => rebuildHandles(); map.on('moveend zoomend', state.moveHandler); }
        renderPanel();
        rebuildHandles();
    }
    function closePanel() {
        state.active = false;
        clearHandles();
        const map = getLeafletMap();
        if (map && state.moveHandler) { try { map.off('moveend zoomend', state.moveHandler); } catch (e) {} state.moveHandler = null; }
        const p = document.getElementById(PANEL_ID); if (p) p.remove();
    }
    function renderPanel() {
        let p = document.getElementById(PANEL_ID);
        if (!state.active) { if (p) p.remove(); return; }
        if (!p) {
            p = document.createElement('div');
            p.id = PANEL_ID;
            p.style.cssText = 'position:fixed;top:80px;right:18px;width:288px;background:#1f2228;border:1px solid rgba(122,223,230,0.5);border-radius:8px;padding:14px 16px;color:#e6e6e6;font:12px -apple-system,sans-serif;z-index:100001;box-shadow:0 8px 28px rgba(0,0,0,0.6)';
            document.body.appendChild(p);
        }
        const fps = flightPaths();
        p.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="color:#7adfe6;font-size:14px">✚ Flight Path Editor</strong>
                <span id="aim-fpe-x" style="cursor:pointer;color:#888;font-size:16px">×</span>
            </div>
            <div style="color:#aaa;margin-bottom:8px;line-height:1.5">Click a dim cyan <b>+</b> on the map to drop a vertex in the middle of that segment. Pan/zoom to load more.</div>
            <div style="color:#7adfe6;margin-bottom:10px"><b>${state.handles.length}</b> insert points in view · ${fps.length} flight path${fps.length === 1 ? '' : 's'}</div>
            <button id="aim-fpe-undo" style="width:100%;background:rgba(255,193,71,0.16);color:#ffd479;border:1px solid rgba(255,193,71,0.55);border-radius:4px;padding:7px;cursor:pointer;font:inherit;font-weight:600">↩ Undo last insert</button>
            <div style="color:#888;margin-top:8px;font-size:11px;line-height:1.5">After inserting, <b>refresh the page</b> to drag/branch the new vertex in Percepto's editor. (Auto-reload coming.)</div>
        `;
        p.querySelector('#aim-fpe-x').onclick = closePanel;
        const u = p.querySelector('#aim-fpe-undo'); if (u) u.onclick = doUndo;
    }

    // ---- boot ----
    patchLeafletMap();
    let tries = 0;
    const boot = setInterval(() => { tries++; if (findToolsBar() && !buttonEl) injectButton(); if (tries > 60) clearInterval(boot); }, 700);
    try {
        const obs = new MutationObserver(() => { if (buttonEl && !document.body.contains(buttonEl)) { buttonEl = null; injectButton(); } else if (!buttonEl) injectButton(); });
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    log('v0.3 ready (iframe) — ✚ in .map-tools');
})();
