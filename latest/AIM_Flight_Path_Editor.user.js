// ==UserScript==
// @name         Latest - AIM Flight Path Editor
// @namespace    http://tampermonkey.net/
// @version      0.9
// @description  Insert a vertex in the MIDDLE of a Percepto flight-path segment — open the flight path's native editor, toggle the ✚ (insert mode), and click any segment number to split that segment in two. SEAMLESS (Path B): the vertex is spliced straight into Percepto's live React editor state, so it appears instantly as a real draggable/branchable waypoint and a native Save persists it — NO page refresh. DEV/personal.
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Flight_Path_Editor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Flight_Path_Editor.user.js
// ==/UserScript==
//
// AIM Flight Path Editor — on-map mid-segment vertex insert for Percepto flight paths.
//   - Open a flight path's NATIVE editor so its segment-number badges appear.
//   - Toggle the ✚ button in .map-tools (iframe only — the map lives there) to enter
//     insert mode → the segment numbers glow green.
//   - Click any segment number → a real vertex is inserted at that segment's
//     midpoint. The new vertex is a genuine branchable/draggable waypoint, and a
//     native Save persists it with NO refresh.
//
// WHY piggyback on the segment-number badges (.map-marker__arc-index): they are
// Percepto's OWN markers — already at each segment midpoint, zoom-animated, and
// re-rendered by Percepto whenever the geometry changes. So they never drift and
// never overlap our own dots (we draw none). Insert mode intercepts a badge click
// (capture phase, suppresses the native handler) and matches it to the nearest arc
// midpoint across all flight paths in live state → that's the (path, segment).
//
// HOW THE INSERT WORKS (Path B, confirmed 2026-06-09): Percepto's Site Setup editor
// keeps the full map-object array in a React hook (component `g$e`, the entities-
// array useState). We locate that hook by walking the React fiber tree from the
// Leaflet container, splice the chosen arc A→B into A→M, M→B (M = segment midpoint),
// and call the hook's dispatch (Percepto's own setState). The map re-renders the new
// waypoint immediately, and because the native Save reads from this same hook, the
// insert survives the save — no API POST, no reload. arcs is the geometry source of
// truth; arc IDs regenerate on save so we key on geometry (endpoints), never id.
// See ShortKeys/AIM_Editor_Probe[2-5].js + reference_percepto_editor_react_state. [AIM FPE].
//
(function() {
    'use strict';
    const TAG = '[AIM FPE]';
    const IS_IFRAME = window !== window.top;
    if (!IS_IFRAME) { try { console.log(`${TAG} top frame — idle (map is in iframe)`); } catch (e) {} return; }

    const BADGE_MATCH_PX = 30;  // a clicked segment badge must be within this many px of an arc midpoint
    const EPS = 1e-7;           // lat/lng match epsilon for arc identity
    const ARC_BADGE_SEL = '.map-marker__arc-index';  // Percepto's per-segment number badge

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
        insertMode: false,      // ON = clicking a segment number splits it
        inserts: 0,             // count this session (info only — all are live, nothing pending)
    };
    const undoStack = [];       // [{id, name, seg, arcs, coords}] for instant local revert

    // ---- segment-badge interception (the trigger) ----
    // Match a clicked segment-number badge to the nearest arc midpoint across all
    // flight paths in live state → returns {fpId, A, B, mid} or null.
    function arcForBadge(badgeEl) {
        const map = getLeafletMap();
        if (!map) return null;
        const cr = map.getContainer().getBoundingClientRect();
        const r = badgeEl.getBoundingClientRect();
        const bx = r.left + r.width / 2 - cr.left, by = r.top + r.height / 2 - cr.top;
        let best = null, bestD = BADGE_MATCH_PX;
        flightPaths().forEach(fp => (fp.arcs || []).forEach(arc => {
            const A = arc.point_a, B = arc.point_b; if (!A || !B) return;
            const mid = { lat: (A.lat + B.lat) / 2, lng: (A.lng + B.lng) / 2 };
            let p; try { p = map.latLngToContainerPoint(L_ll(mid)); } catch (e) { return; }
            const d = Math.hypot(p.x - bx, p.y - by);
            if (d < bestD) { bestD = d; best = { fpId: fp.id, A: clone(A), B: clone(B), mid }; }
        }));
        return best;
    }
    function onBadgeClick(e) {
        if (!state.insertMode) return;
        const badge = e.target && e.target.closest && e.target.closest(ARC_BADGE_SEL);
        if (!badge) return;
        e.preventDefault(); e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        const hit = arcForBadge(badge);
        if (!hit) { toast(`Couldn't match segment "${(badge.textContent || '').trim()}" to a path — zoom in a touch and retry.`, '#ffb14e'); return; }
        doInsert(hit.fpId, hit.A, hit.B, hit.mid);
    }
    // In insert mode also swallow mousedown/pointerdown/dblclick on a badge so Percepto
    // doesn't start a native select/drag before our click fires.
    function onBadgeSuppress(e) {
        if (!state.insertMode) return;
        const badge = e.target && e.target.closest && e.target.closest(ARC_BADGE_SEL);
        if (!badge) return;
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }
    function installBadgeListeners() {
        document.addEventListener('click', onBadgeClick, true);
        ['mousedown', 'pointerdown', 'dblclick'].forEach(t => document.addEventListener(t, onBadgeSuppress, true));
    }

    // green-glow the segment badges while insert mode is on (CSS only, reversible)
    function ensureStyle() {
        if (document.getElementById('aim-fpe-style')) return;
        const s = document.createElement('style');
        s.id = 'aim-fpe-style';
        s.textContent = `
            body.aim-fpe-insert-mode ${ARC_BADGE_SEL} {
                box-shadow: 0 0 0 2px #5fff5f, 0 0 8px 1px rgba(95,255,95,0.75) !important;
                cursor: copy !important;
            }
            .aim-fpe-btn.aim-fpe-on { background: rgba(95,255,95,0.22) !important; box-shadow: 0 0 0 1px rgba(95,255,95,0.7) inset; }
            .aim-fpe-btn.aim-fpe-on span { color: #5fff5f !important; }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    // ---- the Path B insert: splice arc into live React state, no network ----
    function doInsert(fpId, A, B, M) {
        const hook = findEntitiesHook();
        if (!hook || !hook.dispatch) { toast('Live editor state not found — reload the page and try again.', '#ff8a80'); warn('no entities hook'); return; }
        const ent = hook.arr.find(e => e && e.id === fpId);
        if (!ent || !Array.isArray(ent.arcs)) { toast('Flight path not found in live state.', '#ff8a80'); return; }
        // find the arc by its endpoints (geometry, not index — arc ids/order can shift)
        let idx = ent.arcs.findIndex(a => ptEq(a.point_a, A) && ptEq(a.point_b, B));
        if (idx === -1) { toast('That segment just changed — click the segment number again.', '#ffb14e'); return; }
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
        renderPanel();
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
        renderPanel();
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
        w.innerHTML = `<div class="map-tools__button aim-fpe-btn" title="Flight Path Editor — toggle insert mode, then click a segment number to split it" style="cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;user-select:none"><span style="font-size:17px;line-height:1">✚</span></div>`;
        buttonEl = w.firstElementChild;
        ['mousedown', 'click', 'contextmenu'].forEach(t => buttonEl.addEventListener(t, e => e.stopPropagation()));
        buttonEl.addEventListener('click', (e) => { e.preventDefault(); toggleInsertMode(); });
        tools.appendChild(buttonEl);
        syncButton();
        log('button injected into .map-tools');
    }
    function syncButton() { if (buttonEl) buttonEl.classList.toggle('aim-fpe-on', state.insertMode); }

    function toggleInsertMode() {
        state.insertMode = !state.insertMode;
        document.body.classList.toggle('aim-fpe-insert-mode', state.insertMode);
        syncButton();
        if (state.insertMode) {
            const hasBadges = document.querySelector(ARC_BADGE_SEL);
            if (!findEntitiesHook()) warn('live editor state not found — open Site Setup so the map editor is loaded');
            toast(hasBadges
                ? 'Insert mode ON — click any glowing segment number to split it.'
                : 'Insert mode ON — open a flight path\'s editor so its segment numbers appear, then click one.', '#5fff5f');
            renderPanel();
        } else {
            toast('Insert mode off', '#9aa');
            const p = document.getElementById(PANEL_ID); if (p) p.remove();
        }
    }

    function renderPanel() {
        let p = document.getElementById(PANEL_ID);
        if (!state.insertMode) { if (p) p.remove(); return; }
        if (!p) {
            p = document.createElement('div');
            p.id = PANEL_ID;
            p.style.cssText = 'position:fixed;top:80px;right:18px;width:300px;background:#1f2228;border:1px solid rgba(95,255,95,0.5);border-radius:8px;padding:14px 16px;color:#e6e6e6;font:12px -apple-system,sans-serif;z-index:100001;box-shadow:0 8px 28px rgba(0,0,0,0.6)';
            document.body.appendChild(p);
        }
        const canUndo = undoStack.length > 0;
        p.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong style="color:#5fff5f;font-size:14px">✚ Insert mode ON</strong>
                <span id="aim-fpe-x" style="cursor:pointer;color:#888;font-size:16px" title="Turn insert mode off">×</span>
            </div>
            <div style="color:#cfd6dc;margin-bottom:8px;line-height:1.5">Open a flight path's editor, then <b style="color:#5fff5f">click a glowing segment number</b> to split that segment at its midpoint.</div>
            <div style="margin-bottom:8px;padding:7px 10px;background:rgba(95,255,95,0.08);border:1px solid rgba(95,255,95,0.35);border-radius:4px;color:#9be89b;line-height:1.45">
                ✅ <b>Seamless</b> — the vertex appears live as a real waypoint. Drag/branch it natively, then <b>Save</b>. <b>No refresh.</b>
                ${state.inserts > 0 ? `<br><span style="color:#cfd6dc">${state.inserts} insert${state.inserts === 1 ? '' : 's'} this session.</span>` : ''}
            </div>
            <button id="aim-fpe-undo" ${canUndo ? '' : 'disabled'} style="width:100%;background:rgba(255,193,71,${canUndo ? '0.16' : '0.06'});color:${canUndo ? '#ffd479' : '#7a6f4a'};border:1px solid rgba(255,193,71,${canUndo ? '0.55' : '0.25'});border-radius:4px;padding:7px;cursor:${canUndo ? 'pointer' : 'default'};font:inherit;font-weight:600">↩ Undo last insert${canUndo ? ` (${undoStack.length})` : ''}</button>
            <div style="color:#888;font-size:11px;line-height:1.5;margin-top:8px">New vertices land at the segment midpoint — drag natively to fine-tune. Undo reverts locally (or just don't Save).</div>
        `;
        p.querySelector('#aim-fpe-x').onclick = toggleInsertMode;
        const u = p.querySelector('#aim-fpe-undo'); if (u && canUndo) u.onclick = doUndo;
    }

    // ---- boot ----
    patchLeafletMap();
    ensureStyle();
    installBadgeListeners();
    let tries = 0;
    const boot = setInterval(() => { tries++; if (findToolsBar() && !buttonEl) injectButton(); if (tries > 60) clearInterval(boot); }, 700);
    try {
        const obs = new MutationObserver(() => { if (buttonEl && !document.body.contains(buttonEl)) { buttonEl = null; injectButton(); } else if (!buttonEl) injectButton(); });
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    log('v0.9 ready (iframe) — ✚ insert-mode toggle · click a segment number to split it · seamless Path B (no refresh)');
})();
