// ==UserScript==
// @name         Latest - AIM Flight Path Editor
// @namespace    http://tampermonkey.net/
// @version      0.19
// @description  Edit Percepto flight paths from the map while natively editing one: (1) click any segment number to insert a vertex in the MIDDLE of that segment; (2) an "OPEN PATH" item in the double-click vertex popup un-closes a snapped/closed loop (reverses CLOSE PATH). No button, no mode. SEAMLESS (Path B): edits are spliced straight into the flight path's live React editor working copy, so they appear instantly as real draggable/branchable waypoints, coexist with native drags, and a native Save persists them — NO page refresh. Every edit passes a validation gate (abort + visible error on any malformed result) so we can never push a bad flight path into Percepto's state. Also auto-blocks Percepto's native "phantom vertex on drop" bug. DEV/personal.
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
    const VERTEX_POPUP_SEL = '.flight-path-vertex-popup';        // Percepto's double-click vertex popup
    const POPUP_MENU_SEL = '.flight-path-vertex-popup__menu';    // its menu container
    const POPUP_ITEM_CLASS = 'flight-path-vertex-popup__menu-item';
    const OPEN_ITEM_CLASS = 'aim-fpe-open-path';                 // our injected "OPEN PATH" item
    const UNSNAP_OFFSET_PX = 50;  // how far (screen px) the freed vertex lands off the junction

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
    const num = (n) => typeof n === 'number' && Number.isFinite(n);
    const finitePt = (p) => !!p && num(p.lat) && num(p.lng);
    const ptSame = (p, q) => !!p && !!q && p.lat === q.lat && p.lng === q.lng;  // exact (same inserted vertex)

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
    let blockedCount = 0;       // exposed on unsafeWindow.__aim_fpe_blocked
    function debugOn() { try { return !!unsafeWindow.__aim_fpe_debug; } catch (e) { return false; } }
    function onClickGuard(e) {
        if (!lastDown.onVertex) return;                                                 // press didn't start on a vertex
        if (e.target && e.target.closest && e.target.closest(ARC_BADGE_SEL)) return;     // never touch our split
        const moved = Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y);
        if (moved <= DRAG_PX) return;                                                   // a real click/select, not a drag
        if (!editingFP()) return;                                                       // only while editing a flight path
        e.preventDefault(); e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        blockedCount++;
        try { unsafeWindow.__aim_fpe_blocked = blockedCount; } catch (e2) {}
        // silent by default (fires on every drag); set window.__aim_fpe_debug = true to log.
        if (debugOn()) log(`blocked phantom "drop = new vertex" click (${Math.round(moved)}px after a vertex drag) · ${blockedCount} total`);
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

    // ---- SAFETY GATE: validate the split BEFORE writing anything to the editor ----
    // Returns { ok:true } or { ok:false, reason }. If it returns not-ok, doInsert
    // aborts and writes nothing — the path is left exactly as it was. This is the
    // guarantee that we can never push a malformed flight path into Percepto's state.
    function validateSplit(st, srcArc, M, am, mb, newArcs, newCoords) {
        // 1. exact count deltas — arcs +1, coords +1, nothing else changed in size
        if (newArcs.length !== st.arcs.length + 1) return { ok: false, reason: 'arc count delta ≠ +1' };
        if (newCoords.length !== (st.coords || []).length + 1) return { ok: false, reason: 'coord count delta ≠ +1' };
        // 2. every coordinate in the resulting path is a finite number (no NaN/null) —
        //    validates ALL arcs + coords, so we also refuse to edit an already-corrupt path
        for (const arc of newArcs) if (!finitePt(arc.point_a) || !finitePt(arc.point_b)) return { ok: false, reason: 'non-finite arc endpoint' };
        for (const c of newCoords) if (!finitePt(c)) return { ok: false, reason: 'non-finite coordinate' };
        if (!finitePt(M)) return { ok: false, reason: 'non-finite inserted vertex' };
        // 3. endpoint continuity — the split must preserve the chain A→M→B exactly
        if (!ptSame(am.point_a, srcArc.point_a)) return { ok: false, reason: 'first half lost original start' };
        if (!ptSame(mb.point_b, srcArc.point_b)) return { ok: false, reason: 'second half lost original end' };
        if (!ptSame(am.point_b, mb.point_a)) return { ok: false, reason: 'halves do not meet at the inserted vertex' };
        if (!ptSame(am.point_b, M)) return { ok: false, reason: 'inserted vertex mismatch' };
        // 4. degenerate guard — never manufacture a zero-length arc (M must differ from both ends)
        if (ptSame(M, srcArc.point_a) || ptSame(M, srcArc.point_b)) return { ok: false, reason: 'segment too short to split (midpoint == an endpoint)' };
        // 5. attribute inheritance — both halves carry the parent arc's bands + flags unchanged
        for (const f of ['min_alt', 'max_alt', 'min_emergency_alt', 'wait_until_approved']) {
            if (am[f] !== srcArc[f] || mb[f] !== srcArc[f]) return { ok: false, reason: 'attribute "' + f + '" not inherited' };
        }
        // 6. altitude band sanity — strictly-positive band (Percepto's connected-arc rule)
        if (!(num(srcArc.min_alt) && num(srcArc.max_alt) && srcArc.max_alt > srcArc.min_alt)) return { ok: false, reason: 'source arc has an invalid altitude band' };
        // 7. ownership preserved — both halves still belong to this map object
        if (am.mapobject !== srcArc.mapobject || mb.mapobject !== srcArc.mapobject) return { ok: false, reason: 'mapobject ownership changed' };
        return { ok: true };
    }

    // ---- flight-path integrity checker ----
    // Returns an array of issue strings ([] = clean). Catches the kinds of corruption
    // an edit could introduce: non-finite coords, a severed (disconnected) path,
    // coords/arcs mismatch (orphan coords or arc endpoints missing from coords),
    // zero-length arcs, inverted altitude bands, and connected-arc altitude-band gaps
    // (Percepto's rule that arcs sharing a vertex must share a strictly-positive band).
    function checkFlightPath(fp) {
        const issues = [];
        const arcs = (fp && fp.arcs) || [], coords = (fp && fp.coords) || [];
        arcs.forEach((a, i) => {
            if (!finitePt(a.point_a)) issues.push(`arc ${i + 1} point_a is non-finite`);
            if (!finitePt(a.point_b)) issues.push(`arc ${i + 1} point_b is non-finite`);
            if (finitePt(a.point_a) && finitePt(a.point_b) && ptSame(a.point_a, a.point_b)) issues.push(`arc ${i + 1} is zero-length (point_a == point_b)`);
            if (num(a.min_alt) && num(a.max_alt) && a.max_alt < a.min_alt) issues.push(`arc ${i + 1} altitude band inverted (max < min)`);
        });
        coords.forEach((c, i) => { if (!finitePt(c)) issues.push(`coord ${i} is non-finite`); });
        if (arcs.length && !graphConnected(arcs)) issues.push('path is split into disconnected pieces');
        // coords set must equal the arc-endpoint set (no orphan coords, no missing waypoints)
        const arcNodes = new Set(), coordNodes = new Set();
        arcs.forEach(a => { if (finitePt(a.point_a)) arcNodes.add(nodeKey(a.point_a)); if (finitePt(a.point_b)) arcNodes.add(nodeKey(a.point_b)); });
        coords.forEach(c => { if (finitePt(c)) coordNodes.add(nodeKey(c)); });
        arcNodes.forEach(k => { if (!coordNodes.has(k)) issues.push(`arc endpoint ${k} missing from coords`); });
        coordNodes.forEach(k => { if (!arcNodes.has(k)) issues.push(`orphan coord ${k} (no arc uses it)`); });
        // connected-arc altitude overlap: any two arcs sharing a vertex must overlap with positive width
        for (let i = 0; i < arcs.length; i++) for (let j = i + 1; j < arcs.length; j++) {
            const a = arcs[i], b = arcs[j];
            const shares = ptEq(a.point_a, b.point_a) || ptEq(a.point_a, b.point_b) || ptEq(a.point_b, b.point_a) || ptEq(a.point_b, b.point_b);
            if (!shares) continue;
            if (num(a.min_alt) && num(a.max_alt) && num(b.min_alt) && num(b.max_alt)) {
                const lo = Math.max(a.min_alt, b.min_alt), hi = Math.min(a.max_alt, b.max_alt);
                if (hi <= lo) issues.push(`arcs ${i + 1} & ${j + 1} share a vertex but their altitude bands don't overlap`);
            }
        }
        return issues;
    }
    // Manual command: window.__aim_fpe_check() — report integrity of every open FP.
    function runIntegrityReport() {
        const wcs = findFpWorkingCopies();
        if (!wcs.length) { log('integrity check: no flight path editor open'); return []; }
        const report = wcs.map(wc => ({ name: wc.state.name, id: wc.id, issues: checkFlightPath(wc.state) }));
        report.forEach(r => r.issues.length
            ? warn(`integrity: "${r.name}" has ${r.issues.length} issue(s):`, r.issues)
            : log(`integrity: "${r.name}" — CLEAN (${(wcs.find(w => w.id === r.id).state.arcs || []).length} arcs)`));
        return report;
    }
    unsafeWindow.__aim_fpe_check = runIntegrityReport;

    // ---- post-edit verification: confirm the edit applied AND introduced no NEW
    //      integrity problem vs the pre-edit snapshot; auto-revert if it did. ----
    function verifyEdit(fpId, preIssues, expectedArcCount, label) {
        setTimeout(() => {
            try {
                const wc = findFpWorkingCopies().find(w => w.id === fpId);
                if (!wc) return; // editor closed — can't verify
                const arcs = wc.state.arcs || [];
                const revert = (reason) => {
                    const last = undoStack[undoStack.length - 1];
                    if (last && last.id === fpId) {
                        undoStack.pop();
                        wc.dispatch({ ...wc.state, arcs: last.arcs, coords: last.coords });
                    }
                    if (state.inserts > 0) state.inserts--;
                    renderPanel();
                    warn(`${label}: ${reason} — auto-reverted`);
                    toast(`⛔ ${label} reverted — ${reason}. Path left as it was.`, '#ff8a80');
                };
                if (arcs.length !== expectedArcCount) { revert(`edit didn't apply cleanly (expected ${expectedArcCount} arcs, got ${arcs.length})`); return; }
                const post = checkFlightPath(wc.state);
                const fresh = post.filter(p => !preIssues.includes(p));
                if (fresh.length) { revert(`integrity check failed: ${fresh[0]}`); return; }
                log(`${label}: verified clean${post.length ? ' (' + post.length + ' pre-existing issue(s), unchanged)' : ''}`);
            } catch (e) { warn(`${label} post-edit verify threw`, e); }
        }, 60);
    }

    // ---- the Path B insert: splice arc into the open FP's working copy, no network ----
    function doInsert(fpId, A, B, M) {
        try {
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

            // SAFETY GATE — write nothing unless the result is provably well-formed.
            const v = validateSplit(st, a, Mpt, am, mb, newArcs, newCoords);
            if (!v.ok) {
                warn('split ABORTED —', v.reason, '· source arc:', a);
                toast(`⛔ Split blocked: ${v.reason}. Nothing changed — path untouched.`, '#ff8a80');
                return;
            }

            const preIssues = checkFlightPath(st); // health BEFORE the edit (don't blame us for pre-existing)
            undoStack.push({ id: fpId, name: st.name, seg: idx + 1, arcs: origArcs, coords: origCoords });
            // value-form dispatch on the working-copy useState (it holds the FP object itself).
            wc.dispatch({ ...st, arcs: newArcs, coords: newCoords });
            state.inserts++;
            log(`inserted vertex on "${st.name}" seg ${idx + 1}: arcs ${origArcs.length} → ${newArcs.length} (validated · live working copy · no refresh)`);
            renderPanel();
            toast(`✚ Vertex added on ${st.name} (seg ${idx + 1}). Drag/branch it natively, then Save — no refresh needed.`, '#5fff5f');
            verifyEdit(fpId, preIssues, origArcs.length + 1, 'Split');
        } catch (e) {
            warn('doInsert threw — nothing dispatched after the throw point', e);
            toast('⛔ Split errored — see console. Path left as-is.', '#ff8a80');
        }
    }

    function doUndo() {
        const snap = undoStack.pop();
        if (!snap) { toast('Nothing to undo', '#ffd479'); return; }
        const wc = findFpWorkingCopies().find(w => w.id === snap.id);
        if (!wc || !wc.dispatch) { toast('Open the path\'s editor to undo.', '#ff8a80'); return; }
        wc.dispatch({ ...wc.state, arcs: snap.arcs, coords: snap.coords });
        if (state.inserts > 0) state.inserts--;
        log(`undid ${snap.kind || 'insert'} on "${snap.name}"`);
        renderPanel();
        toast(`↩ Reverted last ${snap.kind === 'open' ? 'loop-open' : 'split'} (${snap.name})`, '#ffd479');
    }
    unsafeWindow.__aim_fpe_undo = doUndo;

    // ==================================================================
    // OPEN PATH (unsnap) — reverse Percepto's native "CLOSE PATH" merge.
    // A close moves a loose end onto an existing vertex (byte-identical
    // coords) so two vertices become one and the loop closes. We reverse
    // it: detach the loop-closing arc's shared endpoint to a new offset
    // coordinate, re-opening the loop. Triggered from an "OPEN PATH" item
    // we inject into Percepto's own double-click vertex popup.
    // ==================================================================
    const nodeKey = (p) => p.lat.toFixed(7) + ',' + p.lng.toFixed(7);

    function arcsIncidentTo(arcs, V) {
        const res = [];
        arcs.forEach((a, i) => {
            if (ptEq(a.point_a, V)) res.push({ arcIdx: i, endpoint: 'a' });
            else if (ptEq(a.point_b, V)) res.push({ arcIdx: i, endpoint: 'b' });
        });
        return res;
    }
    // Is arc[skipIdx] a BRIDGE? (removing it disconnects its two endpoints)
    function isBridge(arcs, skipIdx) {
        const a = arcs[skipIdx];
        const srcKey = nodeKey(a.point_a), dstKey = nodeKey(a.point_b);
        if (srcKey === dstKey) return false; // zero-length self-loop: not a bridge
        const adj = new Map();
        arcs.forEach((arc, i) => {
            if (i === skipIdx) return;
            const ka = nodeKey(arc.point_a), kb = nodeKey(arc.point_b);
            if (!adj.has(ka)) adj.set(ka, []); if (!adj.has(kb)) adj.set(kb, []);
            adj.get(ka).push(kb); adj.get(kb).push(ka);
        });
        const seen = new Set([srcKey]); const stack = [srcKey];
        while (stack.length) { const n = stack.pop(); for (const m of (adj.get(n) || [])) { if (m === dstKey) return false; if (!seen.has(m)) { seen.add(m); stack.push(m); } } }
        return true; // dst unreachable without this arc → it's a bridge
    }
    function graphConnected(arcs) {
        if (!arcs.length) return true;
        const adj = new Map(); const nodes = new Set();
        arcs.forEach(a => {
            const ka = nodeKey(a.point_a), kb = nodeKey(a.point_b);
            nodes.add(ka); nodes.add(kb);
            if (!adj.has(ka)) adj.set(ka, []); if (!adj.has(kb)) adj.set(kb, []);
            adj.get(ka).push(kb); adj.get(kb).push(ka);
        });
        const start = nodes.values().next().value;
        const seen = new Set([start]); const stack = [start];
        while (stack.length) { const n = stack.pop(); for (const m of (adj.get(n) || [])) if (!seen.has(m)) { seen.add(m); stack.push(m); } }
        return seen.size === nodes.size;
    }
    // At vertex V, the loop-closer = the most-recently-added incident arc that is
    // part of a cycle (NOT a bridge). Returns {arcIdx, endpoint} or null. Because we
    // only ever pick a non-bridge, opening the loop can never sever the path.
    function findCloserAt(arcs, V) {
        const incident = arcsIncidentTo(arcs, V);
        if (incident.length < 2) return null;
        const cycleEdges = incident.filter(inc => !isBridge(arcs, inc.arcIdx));
        if (!cycleEdges.length) return null;
        cycleEdges.sort((x, y) => y.arcIdx - x.arcIdx); // highest index = most recently added = the closer
        return cycleEdges[0];
    }

    function validateUnsnap(st, V, Vprime, newArcs, newCoords) {
        if (newArcs.length !== st.arcs.length) return { ok: false, reason: 'arc count changed' };
        if (newCoords.length !== (st.coords || []).length + 1) return { ok: false, reason: 'coord count delta ≠ +1' };
        if (!finitePt(Vprime)) return { ok: false, reason: 'freed vertex is non-finite' };
        if (ptSame(Vprime, V)) return { ok: false, reason: 'freed vertex did not move' };
        for (const arc of newArcs) if (!finitePt(arc.point_a) || !finitePt(arc.point_b)) return { ok: false, reason: 'non-finite arc endpoint' };
        if (!graphConnected(newArcs)) return { ok: false, reason: 'edit would disconnect the flight path' };
        return { ok: true };
    }

    function doUnsnap(fpId, V) {
        try {
            const wc = findFpWorkingCopies().find(w => w.id === fpId);
            if (!wc || !wc.dispatch) { toast('Open the flight path editor first.', '#ff8a80'); return; }
            const st = wc.state;
            const closer = findCloserAt(st.arcs, V);
            if (!closer) { toast('No closed loop to open at this vertex.', '#ffb14e'); return; }
            const map = getLeafletMap();
            if (!map) { toast('Map not ready.', '#ff8a80'); return; }
            const arc = st.arcs[closer.arcIdx];
            const far = closer.endpoint === 'b' ? arc.point_a : arc.point_b; // the endpoint that is NOT V
            // place the freed vertex ~50px off the junction, pointing AWAY from the arc's far end
            const Vpx = map.latLngToContainerPoint(L_ll(V));
            const Fpx = map.latLngToContainerPoint(L_ll(far));
            let dx = Vpx.x - Fpx.x, dy = Vpx.y - Fpx.y;
            const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
            const Vpll = map.containerPointToLatLng(unsafeWindow.L.point(Vpx.x + dx * UNSNAP_OFFSET_PX, Vpx.y + dy * UNSNAP_OFFSET_PX));
            const Vprime = { lat: Vpll.lat, lng: Vpll.lng };

            const origArcs = clone(st.arcs), origCoords = clone(st.coords || []);
            const newArcs = clone(st.arcs);
            if (closer.endpoint === 'b') newArcs[closer.arcIdx].point_b = clone(Vprime);
            else newArcs[closer.arcIdx].point_a = clone(Vprime);
            const na = newArcs[closer.arcIdx];
            na.distance = hav(na.point_a, na.point_b); // server recomputes on save anyway
            // Insert the freed vertex POSITIONALLY (right after the junction it split off
            // from) rather than appending — appending at the end left Percepto's editor
            // mis-binding the marker until a refresh; matching the splitter's positional
            // insert keeps the live marker↔arc binding consistent.
            const newCoords = clone(st.coords || []);
            const vIdx = newCoords.findIndex(c => ptEq(c, V));
            if (vIdx >= 0) newCoords.splice(vIdx + 1, 0, clone(Vprime)); else newCoords.push(clone(Vprime));

            const v = validateUnsnap(st, V, Vprime, newArcs, newCoords);
            if (!v.ok) { warn('OPEN PATH aborted —', v.reason); toast(`⛔ Open Path blocked: ${v.reason}. Nothing changed.`, '#ff8a80'); return; }

            const preIssues = checkFlightPath(st); // health BEFORE the edit
            undoStack.push({ id: fpId, name: st.name, kind: 'open', arcs: origArcs, coords: origCoords });
            wc.dispatch({ ...st, arcs: newArcs, coords: newCoords });
            state.inserts++;
            log(`opened loop on "${st.name}" — detached arc ${closer.arcIdx + 1} from the junction (coords ${origCoords.length} → ${newCoords.length}, validated)`);
            renderPanel();
            toast(`✂ Loop opened on ${st.name}. ⚠ SAVE now, then REFRESH before editing this path again — the freed vertex only drags cleanly after a refresh.`, '#ffd479');
            verifyEdit(fpId, preIssues, st.arcs.length, 'Open Path');
        } catch (e) {
            warn('doUnsnap threw — path left as-is', e);
            toast('⛔ Open Path errored — see console. Path left as-is.', '#ff8a80');
        }
    }

    // ---- inject "OPEN PATH" into Percepto's double-click vertex popup ----
    function nearestVertexToLatLng(ll) {
        let best = null, bestD = Infinity;
        findFpWorkingCopies().forEach(wc => {
            (wc.state.arcs || []).forEach(a => {
                for (const p of [a.point_a, a.point_b]) {
                    if (!finitePt(p)) continue;
                    const d = hav(ll, p);
                    if (d < bestD) { bestD = d; best = { wc, V: { lat: p.lat, lng: p.lng } }; }
                }
            });
        });
        return (best && bestD <= 8) ? best : null; // within ~8 m of a real vertex
    }
    function injectOpenPathItem(popupEl, fpId, V, popup) {
        const menu = popupEl.querySelector(POPUP_MENU_SEL);
        if (!menu || menu.querySelector('.' + OPEN_ITEM_CLASS)) return;
        const item = document.createElement('div');
        item.className = POPUP_ITEM_CLASS + ' ' + OPEN_ITEM_CLASS;
        item.textContent = 'OPEN PATH';
        item.style.color = '#5fff5f';
        item.addEventListener('click', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            try { const m = getLeafletMap(); if (m && popup) m.closePopup(popup); } catch (e) {}
            doUnsnap(fpId, V);
        });
        menu.appendChild(item);
        log('injected OPEN PATH into the vertex popup');
    }
    function handlePopupOpen(e) {
        try {
            const popup = e.popup;
            const el = popup && popup.getElement && popup.getElement();
            if (!el || !el.classList || !el.classList.contains(VERTEX_POPUP_SEL.slice(1))) return;
            const ll = popup.getLatLng && popup.getLatLng();
            if (!ll) return;
            const hit = nearestVertexToLatLng({ lat: ll.lat, lng: ll.lng });
            if (!hit) return;
            if (!findCloserAt(hit.wc.state.arcs, hit.V)) return; // only when there's a loop to open here
            const tryInject = () => injectOpenPathItem(el, hit.wc.id, hit.V, popup);
            tryInject();
            // Percepto renders the menu via React and may render AFTER popupopen (or
            // re-render and drop our item) — re-inject for the popup's lifetime so
            // OPEN PATH is reliably there on the FIRST open.
            let obs = null;
            try { obs = new MutationObserver(tryInject); obs.observe(el, { childList: true, subtree: true }); } catch (e2) {}
            const map = getLeafletMap();
            if (map && map.on) {
                const onClose = (ev2) => { if (ev2.popup === popup) { try { if (obs) obs.disconnect(); } catch (e3) {} try { map.off('popupclose', onClose); } catch (e3) {} } };
                map.on('popupclose', onClose);
            }
        } catch (err) { warn('handlePopupOpen threw', err); }
    }
    let popupHooked = false;
    function hookPopups() {
        if (popupHooked) return;
        const map = getLeafletMap();
        if (!map || !map.on) return;
        map.on('popupopen', handlePopupOpen);
        popupHooked = true;
        log('OPEN PATH ready — popupopen hook attached');
    }

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
        c.textContent = `↩ Undo last edit (${undoStack.length})`;
    }

    // ---- boot ----
    patchLeafletMap();
    ensureStyle();
    installBadgeListeners();
    let bootTries = 0;
    const bootIv = setInterval(() => { bootTries++; hookPopups(); if (popupHooked || bootTries > 80) clearInterval(bootIv); }, 700);
    log('v0.19 ready (iframe) — split (click a segment number) + OPEN PATH (vertex popup, un-close a loop; toast reminds to SAVE+refresh before editing again) · every edit runs a pre-write gate AND a post-write integrity check (auto-reverts on any new problem) · window.__aim_fpe_check() reports path health · auto-blocks the native phantom-vertex-on-drop bug');
})();
