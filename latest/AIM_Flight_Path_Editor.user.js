// ==UserScript==
// @name         Latest - AIM Flight Path Editor
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Insert a vertex in the MIDDLE of a Percepto flight-path segment from the map — click a "+" handle (or right-click a segment) and it splits that one segment into two, no delete-and-rebuild. Mirrors the Power Line Editor's on-map vertex UX. DEV/personal.
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
//   - Pick a flight path. A dim "+" handle appears at the MIDDLE of every segment.
//   - Click a "+" handle → a real vertex is inserted there (arcs-splice via
//     POST /map_objects/), the path re-fetches, and the handles rebuild. The new
//     vertex is a genuine branchable/draggable waypoint.
//   - Right-click anywhere on the chosen path's geometry → insert at the exact
//     clicked point (snapped onto the nearest segment).
// Mechanism proven in ShortKeys/AIM_Insert_Vertex.js. arcs is the geometry source
// of truth; the server rebuilds the path from arcs. Arc IDs regenerate every save,
// so we never key on them. Log tag: [AIM FPE].
//
(function() {
    'use strict';
    const TAG = '[AIM FPE]';
    const IS_IFRAME = window !== window.top;
    // The map lives in the react-pages iframe; only run the map logic there.
    if (!IS_IFRAME) { try { console.log(`${TAG} top frame — idle (map is in iframe)`); } catch (e) {} return; }

    const MAP_OBJECTS_URL = 'https://percepto.app/map_objects/?getPoiMapObjectsAsList=true&site_id=';
    const SAVE_URL = 'https://percepto.app/map_objects/';
    const SNAP_PX = 12;

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
            && typeof o.latLngToLayerPoint === 'function' && typeof o.getContainer === 'function' && typeof o.distance === 'function';
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

    // Build the write body for an entity (read→write transform).
    function buildWriteBody(e, cfg) {
        const b = JSON.parse(JSON.stringify(e));
        b.site_id = e.site; b.points = (e.coords || []).slice();
        delete b.site; delete b.coords; delete b.polygon; delete b.asset_waypoints;
        b.mountain_terrain_site = !!(cfg && cfg.mountain_terrain);
        if (Array.isArray(b.arcs)) b.arcs.forEach(a => { if (a.point_a && a.point_b && !Array.isArray(a.points)) a.points = [a.point_a, a.point_b]; });
        return b;
    }

    // Insert a vertex at point M splitting arc index `idx` of entity `e`.
    async function insertVertex(e, idx, M) {
        const cfg = await fetchSiteCfg();
        const csrf = getCsrf();
        if (!csrf) { warn('no csrftoken'); return { ok: false }; }
        const before = JSON.parse(JSON.stringify(e)); // for the audit + undo
        const b = buildWriteBody(e, cfg);
        const arc = b.arcs[idx];
        if (!arc) return { ok: false, reason: 'no arc' };
        const A = arc.point_a, B = arc.point_b;
        const mk = (pa, pb, frac) => ({
            point_a: pa, point_b: pb, distance: (arc.distance || 0) * frac,
            min_alt: arc.min_alt, max_alt: arc.max_alt, min_emergency_alt: arc.min_emergency_alt,
            wait_until_approved: arc.wait_until_approved || false, mapobject: e.id, points: [pa, pb],
        });
        // frac of the new vertex along A→B (for the distance split).
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
        // Audit: GPS-matched old→new segment-number remap.
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

    // ---- on-map handles ----
    const state = { active: false, fpId: null, handles: [], rightClickHandler: null };
    function clearHandles() {
        const map = getLeafletMap();
        state.handles.forEach(h => { try { h.remove(); } catch (e) {} });
        state.handles = [];
    }
    function currentFP() { return entities.find(e => e && e.id === state.fpId) || null; }

    function rebuildHandles() {
        clearHandles();
        const map = getLeafletMap();
        const L = unsafeWindow.L;
        const fp = currentFP();
        if (!map || !L || !fp || !state.active) { renderPanel(); return; }
        const ghost = L.divIcon({
            html: '<div style="width:11px;height:11px;border-radius:50%;background:rgba(122,223,230,0.5);border:1.5px solid rgba(255,255,255,0.7);cursor:copy" title="Click to add a vertex here"></div>',
            className: 'aim-fpe-mid', iconSize: [15, 15], iconAnchor: [7.5, 7.5],
        });
        (fp.arcs || []).forEach((arc, idx) => {
            const A = arc.point_a, B = arc.point_b;
            if (!A || !B) return;
            const mid = { lat: (A.lat + B.lat) / 2, lng: (A.lng + B.lng) / 2 };
            const mk = L.marker([mid.lat, mid.lng], { icon: ghost, zIndexOffset: 900, keyboard: false });
            mk.on('click', async (ev) => {
                try { if (ev.originalEvent) { ev.originalEvent.preventDefault(); ev.originalEvent.stopPropagation(); } } catch (e) {}
                await doInsert(idx, mid, mk);
            });
            mk.addTo(map);
            state.handles.push(mk);
        });
        log(`showing ${state.handles.length} insert handles on "${fp.name}"`);
        renderPanel();
    }

    let busy = false;
    async function doInsert(idx, M, marker) {
        if (busy) return;
        busy = true;
        try {
            if (marker) try { marker.getElement().firstChild.style.background = 'rgba(255,213,79,0.9)'; } catch (e) {}
            const fp = currentFP();
            if (!fp) return;
            const res = await insertVertex(fp, idx, M);
            if (!res.ok) { toast(`Insert failed${res.status ? ' (' + res.status + ')' : ''} — see console`, '#ff8a80'); return; }
            window.__aim_fpe_lastBackup = res.backup; // undo source
            await fetchEntities();
            rebuildHandles();
            toast(`Vertex added on ${fp.name} · seg ${idx + 1} split. Refresh the editor to drag/branch it.`, '#7adfe6');
        } catch (e) { warn('insert error', e); }
        finally { busy = false; }
    }

    // Right-click anywhere on the map → insert at the snapped click point on the
    // nearest segment of the chosen FP (within SNAP_PX).
    function snapToFP(clickLatLng) {
        const map = getLeafletMap();
        const fp = currentFP();
        if (!map || !fp) return null;
        const cp = map.latLngToContainerPoint(clickLatLng);
        let best = null, bestD = SNAP_PX + 0.01;
        (fp.arcs || []).forEach((arc, idx) => {
            const A = arc.point_a, B = arc.point_b; if (!A || !B) return;
            const pa = map.latLngToContainerPoint(L_ll(A)), pb = map.latLngToContainerPoint(L_ll(B));
            const dx = pb.x - pa.x, dy = pb.y - pa.y, len2 = dx * dx + dy * dy;
            if (len2 < 1e-6) return;
            let t = ((cp.x - pa.x) * dx + (cp.y - pa.y) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const fx = pa.x + t * dx, fy = pa.y + t * dy;
            const d = Math.hypot(fx - cp.x, fy - cp.y);
            if (d < bestD) { bestD = d; const ll = map.containerPointToLatLng([fx, fy]); best = { idx, M: { lat: ll.lat, lng: ll.lng } }; }
        });
        return best;
    }
    function L_ll(p) { return unsafeWindow.L.latLng(p.lat, p.lng); }

    function installRightClick() {
        const map = getLeafletMap();
        if (!map || state.rightClickHandler) return;
        state.rightClickHandler = (e) => {
            if (!state.active || !currentFP()) return;
            const hit = snapToFP(e.latlng);
            if (!hit) return;
            try { if (e.originalEvent) e.originalEvent.preventDefault(); } catch (x) {}
            doInsert(hit.idx, hit.M, null);
        };
        map.on('contextmenu', state.rightClickHandler);
    }
    function uninstallRightClick() {
        const map = getLeafletMap();
        if (map && state.rightClickHandler) map.off('contextmenu', state.rightClickHandler);
        state.rightClickHandler = null;
    }

    // ---- UI: button + small panel ----
    const PANEL_ID = 'aim-fpe-panel';
    function toast(msg, color) {
        try {
            const t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1f2228;color:${color || '#e6e6e6'};border:1px solid ${color || '#5fff5f'}88;border-radius:6px;padding:10px 16px;font:13px -apple-system,sans-serif;z-index:100002;box-shadow:0 6px 20px rgba(0,0,0,0.6)`;
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 4500);
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
        const ex = document.getElementById(PANEL_ID);
        if (ex) { closePanel(); return; }
        openPanel();
    }
    async function openPanel() {
        try { await fetchEntities(); } catch (e) { warn('fetch failed', e); }
        state.active = true;
        installRightClick();
        renderPanel();
        // default to first FP if none chosen
        if (!state.fpId) { const f = flightPaths()[0]; if (f) state.fpId = f.id; }
        rebuildHandles();
    }
    function closePanel() {
        state.active = false;
        clearHandles();
        uninstallRightClick();
        const p = document.getElementById(PANEL_ID); if (p) p.remove();
    }
    function renderPanel() {
        let p = document.getElementById(PANEL_ID);
        if (!state.active) { if (p) p.remove(); return; }
        if (!p) {
            p = document.createElement('div');
            p.id = PANEL_ID;
            p.style.cssText = 'position:fixed;top:80px;right:18px;width:300px;background:#1f2228;border:1px solid rgba(122,223,230,0.5);border-radius:8px;padding:14px 16px;color:#e6e6e6;font:12px -apple-system,sans-serif;z-index:100001;box-shadow:0 8px 28px rgba(0,0,0,0.6)';
            document.body.appendChild(p);
        }
        const fps = flightPaths();
        const fp = currentFP();
        p.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="color:#7adfe6;font-size:14px">✚ Flight Path Editor</strong>
                <span id="aim-fpe-x" style="cursor:pointer;color:#888;font-size:16px">×</span>
            </div>
            <div style="color:#aaa;margin-bottom:8px">Pick a flight path, then click a dim "+" on the map to add a vertex mid-segment. Or right-click anywhere on the path.</div>
            <select id="aim-fpe-sel" style="width:100%;background:#13151a;color:#e6e6e6;border:1px solid #3a3f47;border-radius:4px;padding:6px;margin-bottom:8px">
                ${fps.map(f => `<option value="${f.id}" ${f.id === state.fpId ? 'selected' : ''}>${String(f.name).replace(/</g, '&lt;')} (${f.arcs.length} seg)</option>`).join('')}
            </select>
            <div style="color:#7adfe6">${fp ? `${state.handles.length} insert points shown` : 'no flight path selected'}</div>
            <div style="color:#888;margin-top:8px;font-size:11px">After inserting, refresh the page to drag/branch the new vertex in Percepto's editor. Undo last: <code>window.__aim_fpe_undo()</code></div>
        `;
        p.querySelector('#aim-fpe-x').onclick = closePanel;
        const sel = p.querySelector('#aim-fpe-sel');
        if (sel) sel.onchange = () => { state.fpId = parseInt(sel.value, 10); rebuildHandles(); };
    }

    // Undo the last insert (re-POST the pre-insert body).
    unsafeWindow.__aim_fpe_undo = async () => {
        const o = window.__aim_fpe_lastBackup;
        if (!o) { log('nothing to undo'); return; }
        const cfg = await fetchSiteCfg();
        const csrf = getCsrf();
        const b = buildWriteBody(o, cfg);
        const r = await fetch(SAVE_URL, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: JSON.stringify(b) });
        log('undo →', r.status);
        if (r.status === 200) { await fetchEntities(); rebuildHandles(); toast('Reverted last insert', '#ffd479'); }
    };

    // ---- boot ----
    patchLeafletMap();
    let tries = 0;
    const boot = setInterval(() => {
        tries++;
        if (findToolsBar() && !buttonEl) injectButton();
        if (tries > 60) clearInterval(boot);
    }, 700);
    // Re-inject if the toolbar re-renders.
    try {
        const obs = new MutationObserver(() => { if (buttonEl && !document.body.contains(buttonEl)) { buttonEl = null; injectButton(); } else if (!buttonEl) injectButton(); });
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    log('v0.1 ready (iframe) — ✚ in .map-tools');
})();
