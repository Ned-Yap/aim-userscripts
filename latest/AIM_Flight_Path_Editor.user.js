// ==UserScript==
// @name         Latest - AIM Flight Path Editor
// @namespace    http://tampermonkey.net/
// @version      0.8
// @description  Insert a vertex in the MIDDLE of a Percepto flight-path segment from the map — click a flight path to focus it, then click a cyan "+" to split that segment in two. SEAMLESS (Path B): the vertex is spliced straight into Percepto's live React editor state, so it appears instantly as a real draggable/branchable waypoint and a native Save persists it — NO page refresh. DEV/personal.
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Flight_Path_Editor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Flight_Path_Editor.user.js
// ==/UserScript==
//
// AIM Flight Path Editor — on-map mid-segment vertex insert for Percepto flight paths.
//   - Toggle the ✚ button in .map-tools (iframe only — the map lives there).
//   - CLICK A FLIGHT PATH on the map to focus it → cyan "+" handles appear at the
//     midpoint of each of its in-view segments (pan/zoom loads more).
//   - Click a "+" → a real vertex is inserted there. The new vertex is a genuine
//     branchable/draggable waypoint, and a native Save persists it with NO refresh.
//
// HOW IT WORKS (Path B, confirmed 2026-06-09): Percepto's Site Setup editor keeps
// the full map-object array in a React hook (component `g$e`, the entities-array
// useState). We locate that hook by walking the React fiber tree from the Leaflet
// container, splice the chosen arc A→B into A→M, M→B (M = segment midpoint), and
// call the hook's dispatch (Percepto's own setState) to update the live model.
// The map re-renders the new waypoint immediately, and because the native Save
// reads from this same hook, the insert survives the save — no API POST, no reload.
// arcs is the geometry source of truth; arc IDs regenerate on save so we key on
// geometry (endpoints), never id. See ShortKeys/AIM_Editor_Probe[2-5].js. [AIM FPE].
//
(function() {
    'use strict';
    const TAG = '[AIM FPE]';
    const IS_IFRAME = window !== window.top;
    if (!IS_IFRAME) { try { console.log(`${TAG} top frame — idle (map is in iframe)`); } catch (e) {} return; }

    const SELECT_PX = 14;       // click within this many px of a path to focus it
    const EPS = 1e-7;           // lat/lng match epsilon for arc identity

    const log = (...a) => { try { (unsafeWindow.console || console).log(TAG, ...a); } catch (e) {} };
    const warn = (...a) => { try { (unsafeWindow.console || console).warn(TAG, ...a); } catch (e) {} };
    const L_ll = (p) => unsafeWindow.L.latLng(p.lat, p.lng);
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const hav = (a, b) => {
        const R = 6371000, t = Math.PI / 180;
        const dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
    };
    const ptEq = (p, q) => p && q && Math.abs(p.lat - q.lat) < EPS && Math.abs(p.lng - q.lng) < EPS;

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

    // ---- Percepto live editor state (the entities-array React hook) ----
    // Walk the fiber tree from the Leaflet container up to the React root, then DFS
    // down to the function component whose hook state is the map-object array (each
    // item has arcs/coords) and which exposes a dispatch. Returns {arr, dispatch}
    // from the CURRENT committed tree every call (so it reflects native edits too).
    function fiberOf(el) {
        if (!el) return null;
        for (const k in el) { if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return el[k]; }
        return null;
    }
    function findEntitiesHook() {
        const map = getLeafletMap();
        const container = (map && map.getContainer && map.getContainer()) || document.querySelector('.leaflet-container');
        let f = fiberOf(container);
        if (!f) return null;
        let root = f, g = 0; while (root.return && g++ < 5000) root = root.return;
        const visited = new Set(); const stack = [root]; let count = 0;
        while (stack.length && count < 60000) {
            const fb = stack.pop(); if (!fb || visited.has(fb)) continue; visited.add(fb); count++;
            const t = fb.type;
            if (typeof t === 'function' && !(t.prototype && t.prototype.isReactComponent)) {
                let h = fb.memoizedState, i = 0;
                while (h && typeof h === 'object' && 'next' in h && i < 80) {
                    const s = h.memoizedState;
                    if (Array.isArray(s) && s.length >= 2 && h.queue && h.queue.dispatch
                        && s.some(x => x && typeof x === 'object' && (x.arcs || x.coords))) {
                        return { arr: s, dispatch: h.queue.dispatch };
                    }
                    h = h.next; i++;
                }
            }
            if (fb.child) stack.push(fb.child);
            if (fb.sibling) stack.push(fb.sibling);
        }
        return null;
    }
    function liveEntities() { const hk = findEntitiesHook(); return (hk && hk.arr) || []; }
    const flightPaths = () => liveEntities().filter(e => e && e.type === 15 && Array.isArray(e.arcs) && e.arcs.length);

    // ---- state ----
    const state = {
        active: false, selectedFpId: null, handles: [],
        moveHandler: null, clickHandler: null,
        inserts: 0,             // count this session (info only — all are live, nothing pending)
    };
    const undoStack = [];       // [{id, name, seg, arcs, coords}] for instant local revert
    function selectedFP() { return liveEntities().find(e => e && e.id === state.selectedFpId) || null; }

    function clearHandles() {
        state.handles.forEach(h => { try { h.remove(); } catch (e) {} });
        state.handles = [];
    }

    // Nearest flight path to a map click (container-px), or null.
    function nearestFP(clickLatLng) {
        const map = getLeafletMap();
        if (!map) return null;
        const cp = map.latLngToContainerPoint(clickLatLng);
        let bestId = null, bestD = SELECT_PX;
        flightPaths().forEach(fp => {
            (fp.arcs || []).forEach(arc => {
                const A = arc.point_a, B = arc.point_b; if (!A || !B) return;
                const pa = map.latLngToContainerPoint(L_ll(A)), pb = map.latLngToContainerPoint(L_ll(B));
                const dx = pb.x - pa.x, dy = pb.y - pa.y, len2 = dx * dx + dy * dy; if (len2 < 1e-6) return;
                let t = ((cp.x - pa.x) * dx + (cp.y - pa.y) * dy) / len2; t = Math.max(0, Math.min(1, t));
                const fx = pa.x + t * dx, fy = pa.y + t * dy;
                const d = Math.hypot(fx - cp.x, fy - cp.y);
                if (d < bestD) { bestD = d; bestId = fp.id; }
            });
        });
        return bestId;
    }

    function rebuildHandles() {
        clearHandles();
        const map = getLeafletMap();
        const L = unsafeWindow.L;
        const fp = selectedFP();
        if (!map || !L || !state.active || !fp) { renderPanel(); return; }
        const ghost = L.divIcon({
            html: '<div style="width:12px;height:12px;border-radius:50%;background:rgba(122,223,230,0.55);border:1.5px solid rgba(255,255,255,0.75);cursor:copy;box-shadow:0 0 4px rgba(0,0,0,0.5)" title="Click to add a vertex here"></div>',
            className: 'aim-fpe-mid', iconSize: [16, 16], iconAnchor: [8, 8],
        });
        let total = 0;
        const bounds = map.getBounds();
        (fp.arcs || []).forEach((arc) => {
            const A = arc.point_a, B = arc.point_b; if (!A || !B) return;
            const mid = { lat: (A.lat + B.lat) / 2, lng: (A.lng + B.lng) / 2 };
            total++;
            if (!bounds.contains([mid.lat, mid.lng])) return;
            const a0 = clone(A), b0 = clone(B);   // capture endpoints → arc identity at click time
            const mk = L.marker([mid.lat, mid.lng], { icon: ghost, zIndexOffset: 900, keyboard: false });
            mk.on('click', (ev) => {
                try { if (ev.originalEvent) { ev.originalEvent.preventDefault(); ev.originalEvent.stopPropagation(); } } catch (e) {}
                doInsert(fp.id, a0, b0, mid);
            });
            mk.addTo(map);
            state.handles.push(mk);
        });
        log(`"${fp.name}": ${state.handles.length} of ${total} insert points in view`);
        renderPanel();
    }

    // ---- the Path B insert: splice arc into live React state, no network ----
    function doInsert(fpId, A, B, M) {
        const hook = findEntitiesHook();
        if (!hook || !hook.dispatch) { toast('Live editor state not found — reload the page and try again.', '#ff8a80'); warn('no entities hook'); return; }
        const ent = hook.arr.find(e => e && e.id === fpId);
        if (!ent || !Array.isArray(ent.arcs)) { toast('Flight path not found in live state.', '#ff8a80'); return; }
        // find the arc by its endpoints (geometry, not index — arc ids/order can shift)
        let idx = ent.arcs.findIndex(a => ptEq(a.point_a, A) && ptEq(a.point_b, B));
        if (idx === -1) { toast('That segment changed — click a fresh handle.', '#ffb14e'); rebuildHandles(); return; }
        const a = ent.arcs[idx];
        const Mpt = M || { lat: (a.point_a.lat + a.point_b.lat) / 2, lng: (a.point_a.lng + a.point_b.lng) / 2 };
        const dAB = hav(a.point_a, a.point_b) || (a.distance || 1);
        const fAM = Math.min(0.999, Math.max(0.001, hav(a.point_a, Mpt) / dAB));
        // two halves inherit the arc's altitude band + flags; mb gets a synthetic local
        // id so React keys don't collide (the server regenerates all arc ids on save).
        const am = { ...a, point_b: clone(Mpt), distance: (a.distance != null ? a.distance : dAB) * fAM, id: a.id };
        const mb = { ...a, point_a: clone(Mpt), distance: (a.distance != null ? a.distance : dAB) * (1 - fAM), id: (a.id || 0) * 1000 + 1 };
        const origArcs = clone(ent.arcs), origCoords = clone(ent.coords || []);
        const newArcs = ent.arcs.slice(); newArcs.splice(idx, 1, am, mb);
        // coords is cosmetic-for-render (the save rebuilds it from arcs); keep it consistent.
        const newCoords = (ent.coords || []).slice();
        if (newCoords.length) newCoords.splice(Math.min(idx + 1, newCoords.length), 0, clone(Mpt));
        else newCoords.push(clone(a.point_a), clone(Mpt), clone(a.point_b));

        undoStack.push({ id: fpId, name: ent.name, seg: idx + 1, arcs: origArcs, coords: origCoords });
        hook.dispatch(arr => arr.map(e => (e && e.id === fpId) ? { ...e, arcs: newArcs, coords: newCoords } : e));
        state.inserts++;
        log(`inserted vertex on "${ent.name}" seg ${idx + 1}: arcs ${origArcs.length} → ${newArcs.length} (live, no refresh)`);
        setTimeout(rebuildHandles, 40);
        toast(`✚ Vertex added on ${ent.name} (seg ${idx + 1}). Drag/branch it natively, then Save — no refresh needed.`, '#5fff5f');
    }

    function doUndo() {
        const snap = undoStack.pop();
        if (!snap) { toast('Nothing to undo', '#ffd479'); return; }
        const hook = findEntitiesHook();
        if (!hook || !hook.dispatch) { toast('Live state not found — refresh.', '#ff8a80'); return; }
        hook.dispatch(arr => arr.map(e => (e && e.id === snap.id) ? { ...e, arcs: snap.arcs, coords: snap.coords } : e));
        if (state.inserts > 0) state.inserts--;
        log(`undid insert on "${snap.name}" seg ${snap.seg}`);
        setTimeout(rebuildHandles, 40);
        toast(`↩ Reverted last insert (${snap.name})`, '#ffd479');
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
    function openPanel() {
        state.active = true;
        const map = getLeafletMap();
        if (map) {
            if (!state.moveHandler) { state.moveHandler = () => rebuildHandles(); map.on('moveend zoomend', state.moveHandler); }
            if (!state.clickHandler) {
                state.clickHandler = (e) => {
                    if (!state.active) return;
                    const id = nearestFP(e.latlng);
                    if (id && id !== state.selectedFpId) { state.selectedFpId = id; const fp = selectedFP(); log('focused flight path:', fp && fp.name); rebuildHandles(); }
                };
                map.on('click', state.clickHandler);
            }
        }
        if (!findEntitiesHook()) warn('live editor state not found yet — open Site Setup so the map editor is loaded');
        renderPanel();
        rebuildHandles();
    }
    function closePanel() {
        state.active = false;
        clearHandles();
        const map = getLeafletMap();
        if (map) {
            if (state.moveHandler) { try { map.off('moveend zoomend', state.moveHandler); } catch (e) {} state.moveHandler = null; }
            if (state.clickHandler) { try { map.off('click', state.clickHandler); } catch (e) {} state.clickHandler = null; }
        }
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
        const fp = selectedFP();
        const canUndo = undoStack.length > 0;
        p.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="color:#7adfe6;font-size:14px">✚ Flight Path Editor</strong>
                <span id="aim-fpe-x" style="cursor:pointer;color:#888;font-size:16px">×</span>
            </div>
            ${fp
                ? `<div style="color:#cfd6dc;margin-bottom:8px">Focused: <b style="color:#7adfe6">${String(fp.name).replace(/</g, '&lt;')}</b> · <b>${state.handles.length}</b> handles in view.<br><span style="color:#888">Click a handle to insert a vertex. Click another path to switch.</span></div>`
                : `<div style="color:#aaa;margin-bottom:8px;line-height:1.5"><b>Click a flight path on the map</b> to focus it — its insert handles appear.</div>`}
            <div style="margin-bottom:8px;padding:7px 10px;background:rgba(95,255,95,0.08);border:1px solid rgba(95,255,95,0.35);border-radius:4px;color:#9be89b;line-height:1.45">
                ✅ <b>Seamless</b> — inserts appear live as real waypoints. Edit/branch them natively, then <b>Save</b>. <b>No refresh.</b>
                ${state.inserts > 0 ? `<br><span style="color:#cfd6dc">${state.inserts} insert${state.inserts === 1 ? '' : 's'} this session.</span>` : ''}
            </div>
            <button id="aim-fpe-undo" ${canUndo ? '' : 'disabled'} style="width:100%;background:rgba(255,193,71,${canUndo ? '0.16' : '0.06'});color:${canUndo ? '#ffd479' : '#7a6f4a'};border:1px solid rgba(255,193,71,${canUndo ? '0.55' : '0.25'});border-radius:4px;padding:7px;cursor:${canUndo ? 'pointer' : 'default'};font:inherit;font-weight:600">↩ Undo last insert${canUndo ? ` (${undoStack.length})` : ''}</button>
            <div style="color:#888;font-size:11px;line-height:1.5;margin-top:8px">New vertices land at the segment midpoint — drag natively to fine-tune. Undo reverts locally (or just don't Save).</div>
        `;
        p.querySelector('#aim-fpe-x').onclick = closePanel;
        const u = p.querySelector('#aim-fpe-undo'); if (u && canUndo) u.onclick = doUndo;
    }

    // ---- boot ----
    patchLeafletMap();
    let tries = 0;
    const boot = setInterval(() => { tries++; if (findToolsBar() && !buttonEl) injectButton(); if (tries > 60) clearInterval(boot); }, 700);
    try {
        const obs = new MutationObserver(() => { if (buttonEl && !document.body.contains(buttonEl)) { buttonEl = null; injectButton(); } else if (!buttonEl) injectButton(); });
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    log('v0.8 ready (iframe) — ✚ in .map-tools · seamless Path B (live React-state insert, no refresh)');
})();
