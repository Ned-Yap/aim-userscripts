// ==UserScript==
// @name         Latest - AIM Flight Path Editor
// @namespace    http://tampermonkey.net/
// @version      0.13
// @description  Insert a vertex in the MIDDLE of a Percepto flight-path segment — while natively editing a flight path, just click any segment number to split that segment in two. No button, no mode. SEAMLESS (Path B): the vertex is spliced straight into the flight path's live React editor working copy, so it appears instantly as a real draggable/branchable waypoint, coexists with native drags, and a native Save persists it — NO page refresh. Also auto-blocks Percepto's native "phantom vertex on drop" bug (a stray vertex spawned when you release a dragged waypoint). DEV/personal.
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
//   - Click any segment number → a real vertex is inserted at that segment's midpoint.
//     No button, no mode — a native segment-number click does nothing, so we always
//     treat it as a split. The new vertex is a genuine branchable/draggable waypoint,
//     and a native Save persists it with NO refresh. A small Undo chip appears after
//     a split (or call window.__aim_fpe_undo()).
//   - Also auto-fixes a NATIVE Percepto bug: dropping a dragged vertex fires a stray
//     `click` that spawns a phantom zero-length vertex on top of the moved one. We
//     swallow exactly that post-drag click (see the phantom-add guard below).
//
// WHY piggyback on the segment-number badges (.map-marker__arc-index): they are
// Percepto's OWN markers — already at each segment midpoint, zoom-animated, and
// re-rendered by Percepto whenever the geometry changes. So they never drift and
// never overlap our own dots (we draw none). Insert mode intercepts a badge click
// (capture phase, suppresses the native handler) and matches it to the nearest arc
// midpoint across all flight paths in live state → that's the (path, segment).
//
// HOW THE INSERT WORKS (Path B, confirmed 2026-06-09/10): when you open a flight path's
// native editor, Percepto holds that path's LIVE working copy in a React useState whose
// value is the FP object itself ({id,name,type:15,arcs,coords,…}, component `JBe`). This
// — NOT the site-wide entities array `g$e`/hook0 — is what native drags mutate and what a
// Save serializes (hook0 stays at the page-load snapshot during editing and never sees
// drags; v0.8–0.10 wrote hook0 and so couldn't insert after a drag). We locate the working
// copy by walking the React fiber tree (FiberRoot.current) from the Leaflet container,
// splice the chosen arc A→B into A→M, M→B (M = segment midpoint), and value-dispatch the
// updated FP object. The map re-renders the new waypoint immediately, it coexists with
// dragged waypoints, and the native Save persists it — no API POST, no reload. We key arcs
// on geometry (endpoints), never id (ids regenerate on save).
// See ShortKeys/AIM_Editor_Probe[2-8].js + reference_percepto_editor_react_state. [AIM FPE].
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
    // Find the open flight path's EDITOR WORKING COPY — the live state a native drag
    // mutates AND a native Save serializes. This is NOT g$e/hook0 (the site-wide
    // entities array), which stays at the page-load snapshot during editing and never
    // sees native drags. The working copy is a function-component useState whose value
    // is the FP object itself: { id, name, type:15, arcs:[…], coords:[…], … } + dispatch
    // (Percepto's `JBe`). Reading it means our matching + splice always agree with what
    // you see on the map (dragged waypoints included). Confirmed via AIM_Editor_Probe8.
    // Returns [{ id, name, state, dispatch }] — usually one (the path being edited).
    function findFpWorkingCopies() {
        const map = getLeafletMap();
        const container = (map && map.getContainer && map.getContainer()) || document.querySelector('.leaflet-container');
        let f = fiberOf(container);
        if (!f) return [];
        // Resolve FiberRoot.current so we DFS the committed tree (never a stale alternate).
        let top = f, g = 0; while (top.return && g++ < 5000) top = top.return;
        const fiberRoot = top.stateNode;
        const root = (fiberRoot && fiberRoot.current) ? fiberRoot.current : top;
        const found = [];
        const visited = new Set(); const stack = [root]; let count = 0;
        while (stack.length && count < 60000) {
            const fb = stack.pop(); if (!fb || visited.has(fb)) continue; visited.add(fb); count++;
            const t = fb.type;
            if (typeof t === 'function' && !(t.prototype && t.prototype.isReactComponent)) {
                let h = fb.memoizedState, i = 0;
                while (h && typeof h === 'object' && 'next' in h && i < 80) {
                    const s = h.memoizedState;
                    if (s && typeof s === 'object' && !Array.isArray(s) && s.type === 15
                        && Array.isArray(s.arcs) && s.arcs.length && Array.isArray(s.coords)
                        && h.queue && h.queue.dispatch) {
                        found.push({ id: s.id, name: s.name, state: s, dispatch: h.queue.dispatch });
                    }
                    h = h.next; i++;
                }
            }
            if (fb.child) stack.push(fb.child);
            if (fb.sibling) stack.push(fb.sibling);
        }
        return found;
    }
    const flightPaths = () => findFpWorkingCopies();

    // ---- state ----
    const state = {
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
        flightPaths().forEach(wc => (wc.state.arcs || []).forEach(arc => {
            const A = arc.point_a, B = arc.point_b; if (!A || !B) return;
            const mid = { lat: (A.lat + B.lat) / 2, lng: (A.lng + B.lng) / 2 };
            let p; try { p = map.latLngToContainerPoint(L_ll(mid)); } catch (e) { return; }
            const d = Math.hypot(p.x - bx, p.y - by);
            if (d < bestD) { bestD = d; best = { fpId: wc.id, A: clone(A), B: clone(B), mid }; }
        }));
        return best;
    }
    // A segment badge only exists while you're natively editing a flight path, and a
    // native click on it does nothing (it's info-only) — so we ALWAYS treat a badge
    // click as a split. No mode, no button.
    function onBadgeClick(e) {
        const badge = e.target && e.target.closest && e.target.closest(ARC_BADGE_SEL);
        if (!badge) return;
        e.preventDefault(); e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        const hit = arcForBadge(badge);
        if (!hit) { toast(`Couldn't match segment "${(badge.textContent || '').trim()}" to a path — zoom in a touch and retry.`, '#ffb14e'); return; }
        doInsert(hit.fpId, hit.A, hit.B, hit.mid);
    }
    // Swallow mousedown/pointerdown/dblclick on a badge so Percepto doesn't start a
    // native select/drag before our click fires. (Badges only exist while editing.)
    function onBadgeSuppress(e) {
        const badge = e.target && e.target.closest && e.target.closest(ARC_BADGE_SEL);
        if (!badge) return;
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }
    // ---- native "phantom vertex on drop" guard ----
    // Percepto bug (pre-dates these scripts, reproduces with TM off): after you DRAG a
    // flight-path vertex, a synthetic `click` fires at the drop point and Percepto adds
    // a stray zero-length branch vertex on top of the one you moved — invisible until
    // you zoom all the way in. Confirmed via AIM_Editor_Probe9: mousedown on
    // .map-marker__flight-path-vertex → move → mouseup → `click` with a large movedΔ →
    // arc count ++. We swallow EXACTLY that click: press started on a vertex + moved past
    // a threshold, while an FP editor is open. A real click-to-add (no preceding drag,
    // movedΔ≈0), vertex-select (no move), panning, and our segment-split all pass.
    const VERTEX_SEL = '.map-marker__flight-path-vertex';
    const DRAG_PX = 5;          // movement past this between mousedown and the click = a drag, not a click
    let lastDown = { x: 0, y: 0, onVertex: false };
    function editingFP() { return !!document.querySelector(ARC_BADGE_SEL) || findFpWorkingCopies().length > 0; }
    function onDownTrack(e) {
        lastDown = { x: e.clientX, y: e.clientY, onVertex: !!(e.target && e.target.closest && e.target.closest(VERTEX_SEL)) };
    }
    function onClickGuard(e) {
        if (!lastDown.onVertex) return;                                                 // press didn't start on a vertex
        if (e.target && e.target.closest && e.target.closest(ARC_BADGE_SEL)) return;     // never touch our split
        if (Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) <= DRAG_PX) return; // a real click/select, not a drag
        if (!editingFP()) return;                                                       // only while editing a flight path
        e.preventDefault(); e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        log(`blocked Percepto's phantom "drop = new vertex" click (${Math.round(Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y))}px after a vertex drag)`);
    }
    function installBadgeListeners() {
        document.addEventListener('click', onBadgeClick, true);
        ['mousedown', 'pointerdown', 'dblclick'].forEach(t => document.addEventListener(t, onBadgeSuppress, true));
        // phantom-add guard (capture, so it runs before Percepto's handler)
        document.addEventListener('mousedown', onDownTrack, true);
        document.addEventListener('pointerdown', onDownTrack, true);
        document.addEventListener('click', onClickGuard, true);
    }

    // Subtle cue that segment numbers are click-to-split while editing (CSS only).
    function ensureStyle() {
        if (document.getElementById('aim-fpe-style')) return;
        const s = document.createElement('style');
        s.id = 'aim-fpe-style';
        s.textContent = `
            ${ARC_BADGE_SEL} { cursor: copy !important; }
            ${ARC_BADGE_SEL}:hover {
                box-shadow: 0 0 0 2px #5fff5f, 0 0 8px 1px rgba(95,255,95,0.8) !important;
            }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    // ---- the Path B insert: splice arc into the open FP's working copy, no network ----
    function doInsert(fpId, A, B, M) {
        const wcs = findFpWorkingCopies();
        const wc = wcs.find(w => w.id === fpId) || wcs[0];
        if (!wc || !wc.dispatch) { toast('Open the flight path\'s editor first (so its segment numbers show).', '#ff8a80'); warn('no FP working copy'); return; }
        const st = wc.state;
        // find the arc by its endpoints (geometry, not index — arc ids/order can shift)
        const idx = st.arcs.findIndex(a => ptEq(a.point_a, A) && ptEq(a.point_b, B));
        if (idx === -1) { toast('That segment just changed — click the segment number again.', '#ffb14e'); return; }
        const a = st.arcs[idx];
        const Mpt = M || { lat: (a.point_a.lat + a.point_b.lat) / 2, lng: (a.point_a.lng + a.point_b.lng) / 2 };
        const dAB = hav(a.point_a, a.point_b) || (a.distance || 1);
        const fAM = Math.min(0.999, Math.max(0.001, hav(a.point_a, Mpt) / dAB));
        // two halves inherit the arc's altitude band + flags; mb gets a synthetic local
        // id so React keys don't collide (the server regenerates all arc ids on save).
        const am = { ...a, point_b: clone(Mpt), distance: (a.distance != null ? a.distance : dAB) * fAM, id: a.id };
        const mb = { ...a, point_a: clone(Mpt), distance: (a.distance != null ? a.distance : dAB) * (1 - fAM), id: (a.id || 0) * 1000 + 1 };
        const origArcs = clone(st.arcs), origCoords = clone(st.coords || []);
        const newArcs = st.arcs.slice(); newArcs.splice(idx, 1, am, mb);
        // coords mirrors the waypoint list (the save rebuilds it from arcs); keep it consistent.
        const newCoords = (st.coords || []).slice();
        if (newCoords.length) newCoords.splice(Math.min(idx + 1, newCoords.length), 0, clone(Mpt));
        else newCoords.push(clone(a.point_a), clone(Mpt), clone(a.point_b));

        undoStack.push({ id: fpId, name: st.name, seg: idx + 1, arcs: origArcs, coords: origCoords });
        // value-form dispatch on the working-copy useState (it holds the FP object itself).
        wc.dispatch({ ...st, arcs: newArcs, coords: newCoords });
        state.inserts++;
        log(`inserted vertex on "${st.name}" seg ${idx + 1}: arcs ${origArcs.length} → ${newArcs.length} (live working copy, no refresh)`);
        renderPanel();
        toast(`✚ Vertex added on ${st.name} (seg ${idx + 1}). Drag/branch it natively, then Save — no refresh needed.`, '#5fff5f');
    }

    function doUndo() {
        const snap = undoStack.pop();
        if (!snap) { toast('Nothing to undo', '#ffd479'); return; }
        const wc = findFpWorkingCopies().find(w => w.id === snap.id);
        if (!wc || !wc.dispatch) { toast('Open the path\'s editor to undo.', '#ff8a80'); return; }
        wc.dispatch({ ...wc.state, arcs: snap.arcs, coords: snap.coords });
        if (state.inserts > 0) state.inserts--;
        log(`undid insert on "${snap.name}" seg ${snap.seg}`);
        renderPanel();
        toast(`↩ Reverted last insert (${snap.name})`, '#ffd479');
    }
    unsafeWindow.__aim_fpe_undo = doUndo;

    // ---- UI ----
    function toast(msg, color) {
        try {
            const t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1f2228;color:${color || '#e6e6e6'};border:1px solid ${color || '#5fff5f'}88;border-radius:6px;padding:10px 16px;font:13px -apple-system,sans-serif;z-index:100002;box-shadow:0 6px 20px rgba(0,0,0,0.6);max-width:80vw;text-align:center`;
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 5000);
        } catch (e) {}
    }

    // No button, no mode: splitting is just a click on a segment number while editing.
    // The only persistent UI is a small Undo chip, shown after a split so a mistaken
    // one is one click to revert. renderPanel() is the chip updater (name kept so the
    // doInsert/doUndo callers don't change).
    const CHIP_ID = 'aim-fpe-chip';
    function renderPanel() {
        let c = document.getElementById(CHIP_ID);
        if (!undoStack.length) { if (c) c.remove(); return; }
        if (!c) {
            c = document.createElement('div');
            c.id = CHIP_ID;
            c.style.cssText = 'position:fixed;bottom:24px;right:18px;background:#1f2228;border:1px solid rgba(255,193,71,0.55);border-radius:6px;padding:8px 12px;color:#ffd479;font:12px -apple-system,sans-serif;font-weight:600;z-index:100001;box-shadow:0 6px 20px rgba(0,0,0,0.6);cursor:pointer;user-select:none';
            ['mousedown', 'click'].forEach(t => c.addEventListener(t, e => e.stopPropagation()));
            c.addEventListener('click', (e) => { e.preventDefault(); doUndo(); });
            document.body.appendChild(c);
        }
        c.textContent = `↩ Undo split (${undoStack.length})`;
    }

    // ---- boot ----
    patchLeafletMap();
    ensureStyle();
    installBadgeListeners();
    log('v0.13 ready (iframe) — click a segment number to split it (no button) · writes the FP editor working copy (coexists with native drags) · auto-blocks the native phantom-vertex-on-drop bug · no refresh');
})();
