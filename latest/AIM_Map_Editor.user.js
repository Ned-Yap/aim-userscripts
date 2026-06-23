// ==UserScript==
// @name         Latest - AIM Map Editor
// @namespace    http://tampermonkey.net/
// @version      0.48
// @description  Edit Percepto map entities (flight paths + FFZs) from the map. AGL VIEW (Shift+G): on Mountain-terrain (MSL) sites, an overlay over the native editor shows + edits altitudes as height-above-ground (AGL/Δ/MSL columns, color-coded, live-linked) — backend stays MSL; works for flight-path segments AND FFZ bands; also augments Percepto's hover ALT tooltip with AGL. Edit Percepto flight paths from the map while natively editing one: HOLD ALT to peek terrain — yellow elevation-check dots reveal near the cursor (paths can be hundreds of segments, so only nearby dots draw); hover one for live ground + AGL. (0) SMART ALTITUDE — as you draw an under-vertexed path, each new segment auto-gets a terrain-following band (highest ground under it +100/+30 ft, controllable) and, where the ground varies more than 30 ft, the tool inserts the fewest step vertices needed; a continuity bridge keeps connected segments overlapping by the 2 m the server requires. Auto-on-draw + a ⛰ Smart-fill button / Control Panel section to (re)analyze an existing path with a preview. (1) click any segment number to insert a vertex in the MIDDLE of that segment; (2) an "OPEN PATH" item in the double-click vertex popup un-closes a snapped/closed loop (reverses CLOSE PATH). SEAMLESS (Path B): edits are spliced straight into the flight path's live React editor working copy, so they appear instantly as real draggable/branchable waypoints, coexist with native drags, and a native Save persists them — NO page refresh. Every edit passes a validation gate (abort + visible error on any malformed result) so we can never push a bad flight path into Percepto's state. Also auto-blocks Percepto's native "phantom vertex on drop" bug. DEV/personal.
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_setValue
// @grant        GM_getValue
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Map_Editor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Map_Editor.user.js
// ==/UserScript==
//
// AIM Map Editor (formerly Flight Path Editor) — on-map editing of Percepto flight paths + FFZs,
// incl. the AGL view (Shift+G). Started as mid-segment vertex insert for flight paths.
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
    // --- AIM Pilot mode guard: stay fully inert when a pilot/regulator has
    // turned on Pilot mode in the Control Panel (shared localStorage flag). No
    // observers/intervals/hotkeys/DOM injection start past this point. Toggling
    // Pilot mode reloads the page, so this re-evaluates cleanly each load. ---
    try {
        if (localStorage.getItem('aim-mode') !== 'full') {
            console.log('[AIM FPE] Lite mode — CSM tool inert, init skipped.');
            return;
        }
    } catch (e) {}
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

    // ---- smart-altitude (terrain-following auto band + auto-step) ----
    // As you draw an under-vertexed path, on each drop/snap we sample the ground under
    // the new segment(s), set each segment's band to ground+floor / +band, and — if the
    // ground varies more than maxVar across a segment — insert step vertices (greedy,
    // fewest possible) so each sub-segment stays within maxVar. A final continuity bridge
    // keeps connected segments overlapping by the 2 m the server demands. See the smart
    // block below + reference_map_objects_save_endpoint / feedback_percepto_location_altitude_endpoint.
    const SCRIPT_VERSION = '0.48';
    const SMART_SAMPLE_SPACING_FT = 100;  // terrain sampling along a segment (for split detection) — coarser = fewer rate-limited DEM calls
    const SMART_MAX_SAMPLES = 60;         // cap DEM calls per segment
    const SMART_MIN_STEP_FT = 60;         // never place auto-steps closer than this (avoid over-splitting)
    const PEEK_RADIUS_PX = 130;           // Alt-peek: reveal terrain dots within this many px of the cursor
    const FT_TO_M = 1 / 3.28084;
    const SETTINGS_KEY = 'aim_fpe_smart_settings';
    const DEF_SETTINGS = { master: true, autoDraw: true, floorFt: 100, bandFt: 30, maxVarFt: 30, overlapM: 2, aglHud: true };
    let settings = { ...DEF_SETTINGS };
    function loadSettings() {
        try { if (typeof GM_getValue === 'function') { const raw = GM_getValue(SETTINGS_KEY, null); if (raw) settings = { ...DEF_SETTINGS, ...JSON.parse(raw) }; } }
        catch (e) { warn('loadSettings failed — using defaults', e); }
    }
    function saveSettings() {
        try { if (typeof GM_setValue === 'function') GM_setValue(SETTINGS_KEY, JSON.stringify(settings)); }
        catch (e) { warn('saveSettings failed', e); }
    }

    // ---- MSL vs AGL site mode (SAFETY-CRITICAL — mirrors the Asset Inspector) ----
    // Percepto stores FP arc min/max_alt as ABSOLUTE MSL on "Mountain terrain"
    // sites (mountain_terrain=true) and as HEIGHT-ABOVE-GROUND (AGL) on non-mountain
    // sites. Smart-altitude is terrain-FOLLOWING: it only makes sense on MSL sites
    // (band = ground + floor). On AGL sites the stored value is already terrain-
    // independent, so a lateral move must NOT change it and no terrain steps are
    // needed. Writing an MSL-style ground+floor (~ground 290 m) onto an AGL site is
    // read as ~950 ft ABOVE GROUND — catastrophic. Confirmed live 2026-06-18 on
    // site 1502 (MT on=MSL) + 285 (MT off=AGL).
    const fpeAltModeCache = {};
    function fpeSiteId() {
        const h = (unsafeWindow.location && unsafeWindow.location.hash) || location.hash || '';
        const m = h.match(/#\/site\/(\d+)\//);
        return m ? m[1] : null;
    }
    async function fpeSiteAltMode() {
        const sid = fpeSiteId();
        if (!sid) return 'unknown';
        if (fpeAltModeCache[sid]) return fpeAltModeCache[sid];
        let mode = 'unknown';
        try {
            const r = await fetch(`https://percepto.app/sites/${sid}/`, { credentials: 'same-origin' });
            if (r.ok) { const j = await r.json(); if (typeof j.mountain_terrain === 'boolean') mode = j.mountain_terrain ? 'msl' : 'agl'; }
        } catch (e) { warn('alt-mode fetch failed', e); }
        if (mode !== 'unknown') fpeAltModeCache[sid] = mode; // don't cache a transient fetch failure
        log(`site ${sid} altitude mode = ${mode.toUpperCase()} (mountain_terrain → ${mode === 'msl' ? 'true' : mode === 'agl' ? 'false' : '?'})`);
        return mode;
    }
    // Raw AGL band (no ground term) — what an AGL site stores for floor/floor+band.
    function aglBand() {
        const minM = Math.round(settings.floorFt * FT_TO_M);
        const maxM = Math.max(minM + 1, Math.round((settings.floorFt + settings.bandFt) * FT_TO_M));
        return { min_alt: minM, max_alt: maxM, min_emergency_alt: minM };
    }

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
    // Generic working-copy finder: DFS the committed fiber tree for a useState
    // whose value is the entity object (matched by `pred`) with a live dispatch.
    function findWorkingCopies(pred) {
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
                    if (s && typeof s === 'object' && !Array.isArray(s) && h.queue && h.queue.dispatch && pred(s)) {
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
    function findFpWorkingCopies() {
        return findWorkingCopies(s => s.type === 15 && Array.isArray(s.arcs) && s.arcs.length && Array.isArray(s.coords));
    }
    // FFZ (type 16) editor working copy — single altitude band in `restrictions`.
    function findFfzWorkingCopies() {
        return findWorkingCopies(s => s.type === 16 && s.restrictions && typeof s.restrictions === 'object' && !Array.isArray(s.restrictions) && Array.isArray(s.coords));
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
    let mouseDown = false;       // true between mousedown and mouseup — used to defer the smart pass until a drop
    function editingFP() { return !!document.querySelector(ARC_BADGE_SEL) || findFpWorkingCopies().length > 0; }
    function onDownTrack(e) {
        mouseDown = true;
        lastDown = { x: e.clientX, y: e.clientY, onVertex: !!(e.target && e.target.closest && e.target.closest(VERTEX_SEL)) };
    }
    // On drop/snap (mouseup) while editing a flight path, re-check for new segments and
    // smart-fill them. Debounced so a drag fires the pass once, after the geometry settles.
    function onUpTrack() {
        mouseDown = false;
        if (editingFP()) scheduleSmartPass();
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
        // smart-altitude trigger: re-evaluate on every drop/snap
        document.addEventListener('mouseup', onUpTrack, true);
        document.addEventListener('pointerup', onUpTrack, true);
        // elevation peek: hold Alt while editing an FP to reveal terrain dots near the cursor
        document.addEventListener('keydown', onPeekKeyDown, true);
        document.addEventListener('keyup', onPeekKeyUp, true);
        window.addEventListener('blur', exitPeek);
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
            .aim-fpe-peek-tip {
                background:#1f2228 !important; color:#ffd400 !important; border:1px solid #ffd40066 !important;
                font:11px -apple-system,sans-serif !important; padding:3px 7px !important; box-shadow:0 3px 10px rgba(0,0,0,0.6) !important;
            }
            .aim-fpe-peek-tip::before { border-top-color:#1f2228 !important; }
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

    // ==================================================================
    // SMART ALTITUDE — terrain-following auto band + greedy auto-step.
    //   For each target segment: dense-sample the ground under it, then
    //   greedily cut it into the FEWEST sub-segments whose ground varies
    //   ≤ maxVar. Each sub-segment's band = groundMax+floor / +band, with
    //   emergency = min (matches Percepto's native default). Then bridge
    //   connected arcs so they overlap by the 2 m the server requires.
    //   Two modes: AUTO (new segments as you draw) + PREVIEW (whole path).
    // ==================================================================
    const rk = (p) => (p && num(p.lat)) ? p.lat.toFixed(6) + ',' + p.lng.toFixed(6) : '?';
    const arcSig = (a) => [rk(a.point_a), rk(a.point_b)].sort().join('~'); // undirected — survives direction flips
    const procState = new Map();  // fpId -> { count, sigs:Set } — what we've already smart-processed

    // ---- DEM ground elevation (Percepto's own endpoint; cached, deduped, RATE-LIMITED) ----
    // The endpoint rate-limits HARD (HTTP 429): a long segment fired as a burst of fresh
    // points 429s even at low concurrency, and the retries land in the same saturated
    // window → cascade. So we RATE-LIMIT (min interval between request STARTS, not just a
    // concurrency cap) to turn the burst into a steady trickle that stays under the quota,
    // plus exponential backoff on 429. A 429 body is NOT JSON, so check res.ok BEFORE
    // parsing. Results persist to GM so re-running over the same area survives a reload.
    const elevCache = new Map(), elevInflight = new Map();
    const ekey = (lat, lng) => lat.toFixed(5) + ',' + lng.toFixed(5);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const ELEV_MAX_CONCURRENT = 2;
    const ELEV_MIN_INTERVAL_MS = 220;  // ≤ ~4.5 req/s — gentle on the shared limiter
    const ELEV_MAX_RETRIES = 2;        // for genuine NETWORK errors only (429 trips the breaker immediately)
    const ELEV_BREAKER_TRIP = 1;       // ONE 429 ⇒ quota is blown; stop instantly (no point hammering)
    const ELEV_BREAKER_BASE_MS = 60000;  // first pause 60 s…
    const ELEV_BREAKER_MAX_MS = 600000;  // …escalating ×2 each immediate re-trip up to 10 min (stops re-storming)
    const ELEV_CACHE_KEY = 'aim_fpe_elev_cache';
    const AI_NEAREST_M = 30;           // accept the Asset Inspector's nearest cached DEM point within this many metres
    let elevActive = 0, elevLastStart = 0, elevPumpScheduled = false;
    const elevQueue = [];
    let elevRateLimited = false;       // surfaced to the user when we give up / the breaker opens
    let elevDirty = 0;
    let elevConsec429 = 0, elevBreakerUntil = 0, elevBreakerStreak = 0;
    const breakerOpen = () => Date.now() < elevBreakerUntil;
    function openBreaker() {
        elevBreakerStreak++;
        const ms = Math.min(ELEV_BREAKER_MAX_MS, ELEV_BREAKER_BASE_MS * Math.pow(2, elevBreakerStreak - 1));
        elevBreakerUntil = Date.now() + ms; elevRateLimited = true;
        return ms;
    }
    function breakerSuccess() { elevConsec429 = 0; elevBreakerUntil = 0; elevBreakerStreak = 0; } // quota flowing again
    // Reuse the Asset Inspector's warm/shared/persistent elevation cache when present (it
    // exposes a service on unsafeWindow). getCached() is FREE — no network — so analyzed
    // sites / teammate-cached terrain never touch the rate-limited endpoint at all.
    const aiElev = () => { try { return unsafeWindow.__aimAIElevation || null; } catch (e) { return null; } };
    function loadElevCache() {
        try { if (typeof GM_getValue === 'function') { const raw = GM_getValue(ELEV_CACHE_KEY, null); if (raw) { const o = JSON.parse(raw); for (const k in o) elevCache.set(k, o[k]); log(`loaded ${elevCache.size} cached elevations`); } } }
        catch (e) { warn('loadElevCache failed', e); }
    }
    function persistElevCache() {
        try { if (typeof GM_setValue === 'function') { const o = {}; elevCache.forEach((v, k) => { o[k] = v; }); GM_setValue(ELEV_CACHE_KEY, JSON.stringify(o)); elevDirty = 0; } }
        catch (e) { warn('persistElevCache failed', e); }
    }
    function elevPump() {
        if (elevActive >= ELEV_MAX_CONCURRENT || !elevQueue.length) return;
        const now = Date.now();
        const wait = ELEV_MIN_INTERVAL_MS - (now - elevLastStart);
        if (wait > 0) { if (!elevPumpScheduled) { elevPumpScheduled = true; setTimeout(() => { elevPumpScheduled = false; elevPump(); }, wait); } return; }
        elevLastStart = now;
        const job = elevQueue.shift(); elevActive++;
        job().finally(() => { elevActive--; elevPump(); });
        elevPump(); // try to fill the other concurrency slot (interval-gated)
    }
    async function rawFetchElev(lat, lng, attempt) {
        if (breakerOpen()) return null; // quota looks blown — don't poke the penalty box
        const url = 'https://percepto.app/location_altitude/?location=' + encodeURIComponent(JSON.stringify({ lat, lng }));
        try {
            const res = await fetch(url, { credentials: 'include' });
            if (res.status === 429) {
                if (++elevConsec429 >= ELEV_BREAKER_TRIP) {
                    const ms = openBreaker();
                    warn(`DEM 429 — quota blown; pausing elevation lookups ${Math.round(ms / 1000)}s (cached terrain still works)`);
                }
                return null; // never retry a 429 — that just keeps the penalty alive + floods the console
            }
            if (!res.ok) { elevRateLimited = true; return null; }
            const j = await res.json().catch(() => null);
            const m = (j && typeof j.altitude === 'number') ? j.altitude : null;
            if (m != null) breakerSuccess(); // quota is flowing again
            return m;
        } catch (e) {
            if (attempt < ELEV_MAX_RETRIES && !breakerOpen()) { await sleep(800 * Math.pow(2, attempt) + Math.random() * 400); return rawFetchElev(lat, lng, attempt + 1); }
            warn('elevation fetch failed', e); return null;
        }
    }
    function fetchElevation(lat, lng) {
        const k = ekey(lat, lng);
        if (elevCache.has(k)) return Promise.resolve(elevCache.get(k));
        // Asset Inspector's warm/shared cache — free, skips the rate-limited endpoint.
        // Exact key first, then NEAREST cached point: the AI's DEM grid is dense (~10 m)
        // but a freshly-drawn path never samples the exact grid coords, so an exact match
        // always misses. Nearest within ~30 m is plenty — terrain barely moves over metres
        // and we add a 100 ft floor on top. This turns a cached site into free terrain.
        const ai = aiElev();
        if (ai) {
            let c = ai.getCached(lat, lng);
            if (c == null && ai.getNearest) c = ai.getNearest(lat, lng, AI_NEAREST_M);
            if (c != null) { elevCache.set(k, c); return Promise.resolve(c); }
            // LIVE FETCH via the Asset Inspector's SHARED queue (faster + smoother): one
            // coordinated queue instead of FPE running its own that collides with the AI's
            // — and no self-imposed 220ms delay or 60s breaker bail. Result cached locally
            // too so it survives even if the AI unloads.
            if (typeof ai.fetch === 'function') {
                if (elevInflight.has(k)) return elevInflight.get(k);
                const p = Promise.resolve(ai.fetch(lat, lng)).then(m => {
                    if (m != null) { elevCache.set(k, m); if (++elevDirty >= 20) persistElevCache(); }
                    elevInflight.delete(k); return m;
                }).catch(() => { elevInflight.delete(k); return null; });
                elevInflight.set(k, p);
                return p;
            }
        }
        // Fallback only when the Asset Inspector isn't loaded: FPE's own rate-limited queue.
        if (breakerOpen()) return Promise.resolve(null); // quota recovering — serve cache-only
        if (elevInflight.has(k)) return elevInflight.get(k);
        const p = new Promise((resolve) => {
            elevQueue.push(() => rawFetchElev(lat, lng, 0).then(m => {
                if (m != null) { elevCache.set(k, m); if (++elevDirty >= 20) persistElevCache(); }
                elevInflight.delete(k); resolve(m);
            }));
            elevPump();
        });
        elevInflight.set(k, p);
        return p;
    }
    async function mapLimit(items, limit, fn) {
        // The global elev queue (rate-limited) is the real throttle; this just maps in order.
        const out = await Promise.all(items.map((it, i) => fn(it, i)));
        if (elevDirty) persistElevCache();
        return out;
    }

    // ---- band from a sub-segment's highest ground (integer meters; server floors anyway) ----
    function bandForGroundMax(gmaxM) {
        const minM = Math.round(gmaxM + settings.floorFt * FT_TO_M);
        const maxM = Math.max(minM + 1, Math.round(gmaxM + (settings.floorFt + settings.bandFt) * FT_TO_M));
        return { min_alt: minM, max_alt: maxM, min_emergency_alt: minM };
    }

    // ---- continuity bridge: connected arcs must overlap with positive width ----
    // (ported from Asset Inspector's bridgeArcContinuity) — raises ONLY the lower
    // neighbour's ceiling so every floor keeps its true AGL; the band just fattens
    // at a terrain step (up to ~36.6 ft when floors differ by the full band width).
    function bridgeArcContinuity(arcs, overlapM, skip) {
        if (!Array.isArray(arcs) || arcs.length < 2) return [];
        const OVERLAP_M = (typeof overlapM === 'number' && overlapM > 0) ? overlapM : 2;
        const skipSet = skip instanceof Set ? skip : new Set();
        const vkey = (p) => (p && num(p.lat)) ? `${p.lat.toFixed(6)},${p.lng.toFixed(6)}` : null;
        const origMax = arcs.map(a => (a && num(a.max_alt)) ? a.max_alt : null);
        const byVertex = new Map();
        arcs.forEach((a, i) => { if (!a) return; [vkey(a.point_a), vkey(a.point_b)].forEach(kk => { if (!kk) return; if (!byVertex.has(kk)) byVertex.set(kk, []); byVertex.get(kk).push(i); }); });
        const edges = new Set();
        for (const idxs of byVertex.values()) for (let x = 0; x < idxs.length; x++) for (let y = x + 1; y < idxs.length; y++) edges.add(Math.min(idxs[x], idxs[y]) + ':' + Math.max(idxs[x], idxs[y]));
        const edgeList = [...edges].map(s => s.split(':').map(Number));
        for (let pass = 0; pass < 8; pass++) {
            let changed = false;
            for (const [i, j] of edgeList) {
                if (skipSet.has(i) || skipSet.has(j)) continue; // never touch an un-banded segment (its default band is bogus)
                const A = arcs[i], B = arcs[j];
                if (!A || !B || !num(A.min_alt) || !num(A.max_alt) || !num(B.min_alt) || !num(B.max_alt)) continue;
                if (A.max_alt > B.min_alt && B.max_alt > A.min_alt) continue; // already strictly overlap
                if (A.max_alt <= B.min_alt) { A.max_alt = B.min_alt + OVERLAP_M; changed = true; }
                else { B.max_alt = A.min_alt + OVERLAP_M; changed = true; }
            }
            if (!changed) break;
        }
        const bridges = [];
        arcs.forEach((a, i) => { if (origMax[i] != null && a && num(a.max_alt) && a.max_alt > origMax[i] + 0.01) bridges.push({ seg: i + 1, fromM: origMax[i], toM: a.max_alt }); });
        return bridges;
    }

    // ---- plan one segment: returns its replacement sub-arcs (≥1; >1 means steps added) ----
    async function planArc(arc, mode) {
        const A = arc.point_a, B = arc.point_b;
        if (!finitePt(A) || !finitePt(B)) return null;
        if (mode === 'agl') {
            // AGL site: altitude is height-above-ground (terrain-independent). No
            // terrain sampling, no step vertices — just the flat raw AGL band. (The
            // auto-pass also won't even reach here for an already-banded segment; see
            // computePlan's AGL filter, which preserves a moved segment's band.)
            const b = aglBand();
            return [{ ...arc, point_a: clone(A), point_b: clone(B), distance: hav(A, B),
                min_alt: b.min_alt, max_alt: b.max_alt, min_emergency_alt: b.min_emergency_alt, id: arc.id }];
        }
        const distM = hav(A, B) || 0;
        const n = Math.max(3, Math.min(SMART_MAX_SAMPLES, Math.ceil(distM / (SMART_SAMPLE_SPACING_FT * FT_TO_M)) + 1));
        const pts = [];
        for (let i = 0; i < n; i++) { const t = i / (n - 1); pts.push({ lat: A.lat + (B.lat - A.lat) * t, lng: A.lng + (B.lng - A.lng) * t, t }); }
        const elevs = await mapLimit(pts, 8, p => fetchElevation(p.lat, p.lng));
        const valid = pts.map((p, i) => ({ t: p.t, e: elevs[i] })).filter(x => typeof x.e === 'number');
        if (valid.length < 2) { if (debugOn()) log('planArc: no elevation data for a segment — left unchanged (cache cold / quota paused)'); return null; }
        // greedy partition by ground range ≤ maxVar, never below SMART_MIN_STEP_FT
        const maxVarM = settings.maxVarFt * FT_TO_M, minStepM = SMART_MIN_STEP_FT * FT_TO_M;
        const subs = []; let s = 0, cmin = valid[0].e, cmax = valid[0].e;
        for (let i = 1; i < valid.length; i++) {
            const nmin = Math.min(cmin, valid[i].e), nmax = Math.max(cmax, valid[i].e);
            const lenFromS = distM * (valid[i - 1].t - valid[s].t);
            if ((nmax - nmin) > maxVarM && lenFromS >= minStepM && (i - 1) > s) {
                subs.push({ i0: s, i1: i - 1 }); s = i - 1; cmin = Math.min(valid[i - 1].e, valid[i].e); cmax = Math.max(valid[i - 1].e, valid[i].e);
            } else { cmin = nmin; cmax = nmax; }
        }
        subs.push({ i0: s, i1: valid.length - 1 });
        // Diagnostic: shows whether "+0 steps" is genuinely flat terrain vs missing interior
        // DEM. Low coverage (valid ≪ n) means the open-space interior had no cached/live data,
        // so variation can't be seen — pre-warm the corridor. Full coverage + small Δ = flat.
        try {
            const gs = valid.map(v => v.e), gMinFt = Math.min(...gs) * 3.28084, gMaxFt = Math.max(...gs) * 3.28084;
            log(`segment terrain: ${valid.length}/${n} samples with data · ground ${gMinFt.toFixed(0)}–${gMaxFt.toFixed(0)} ft (Δ${(gMaxFt - gMinFt).toFixed(0)} ft, threshold ${settings.maxVarFt}) → ${subs.length - 1} step(s)`);
        } catch (e) {}
        const lerp = (t) => ({ lat: A.lat + (B.lat - A.lat) * t, lng: A.lng + (B.lng - A.lng) * t });
        const verts = [clone(A)];
        for (let k = 0; k < subs.length - 1; k++) verts.push(lerp(valid[subs[k].i1].t));
        verts.push(clone(B));
        const subArcs = [];
        for (let k = 0; k < subs.length; k++) {
            let g = -Infinity; for (let j = subs[k].i0; j <= subs[k].i1; j++) g = Math.max(g, valid[j].e);
            const band = bandForGroundMax(g);
            subArcs.push({ ...arc, point_a: clone(verts[k]), point_b: clone(verts[k + 1]), distance: hav(verts[k], verts[k + 1]),
                min_alt: band.min_alt, max_alt: band.max_alt, min_emergency_alt: band.min_emergency_alt,
                id: k === 0 ? arc.id : ((arc.id || 0) * 1000 + k) });
        }
        return subArcs;
    }

    // ---- build a full plan for a path from a set of target arc signatures ----
    async function computePlan(fpId, targetSigs, force) {
        const wc0 = findFpWorkingCopies().find(w => w.id === fpId);
        if (!wc0) return null;
        const mode = await fpeSiteAltMode();
        if (mode === 'unknown') return { error: 'site altitude mode unknown (could not read the Mountain-terrain flag) — not touching altitudes' };
        let targets = (wc0.state.arcs || []).filter(a => targetSigs.has(arcSig(a)));
        if (mode === 'agl' && !force) {
            // AGL: a lateral move never changes height-above-ground, so PRESERVE any
            // segment that already has a valid band. Only band genuinely unbanded
            // (freshly drawn) segments. The manual ⛰ Smart-fill button passes force
            // to deliberately re-apply the AGL band to everything.
            targets = targets.filter(a => !(num(a.min_alt) && num(a.max_alt) && a.max_alt > a.min_alt));
        }
        if (!targets.length) return null;
        const planned = [];
        const unresolved = []; // targets we couldn't band (no elevation yet) — keep them retry-able
        for (const a of targets) { const sub = await planArc(a, mode); if (sub && sub.length) planned.push({ sig: arcSig(a), subArcs: sub }); else unresolved.push(arcSig(a)); }
        if (!planned.length) return unresolved.length ? { error: 'no elevation data yet', unresolved } : null;
        const wc = findFpWorkingCopies().find(w => w.id === fpId);
        if (!wc || !wc.dispatch) return null;
        const st = wc.state;
        const repl = new Map(planned.map(x => [x.sig, x.subArcs]));
        const origArcs = clone(st.arcs), origCoords = clone(st.coords || []);
        const newArcs = []; let newCoords = clone(st.coords || []); const interiorPts = [];
        st.arcs.forEach(a => {
            const r = repl.get(arcSig(a));
            if (r) {
                newArcs.push(...r.map(clone));
                const interior = r.slice(0, -1).map(sa => clone(sa.point_b)); // the new step vertices
                if (interior.length) {
                    const ai = newCoords.findIndex(c => ptEq(c, a.point_a));
                    const at = ai >= 0 ? ai + 1 : newCoords.length;
                    newCoords.splice(at, 0, ...interior.map(clone));
                    interiorPts.push(...interior);
                }
            } else newArcs.push(a);
        });
        // Don't bridge segments we couldn't band — their default band is bogus, and
        // half-bridging produces the "min default / max raised" state. Leave them fully
        // at default until a retry bands them properly.
        const unresolvedSet = new Set(unresolved);
        const skipIdx = new Set();
        newArcs.forEach((a, i) => { if (unresolvedSet.has(arcSig(a))) skipIdx.add(i); });
        const bridges = bridgeArcContinuity(newArcs, settings.overlapM, skipIdx);
        // SAFETY GATE — the result must introduce no NEW integrity problem vs before.
        const preIssues = checkFlightPath(st);
        const post = checkFlightPath({ arcs: newArcs, coords: newCoords });
        const fresh = post.filter(p => !preIssues.includes(p));
        if (fresh.length) return { error: fresh[0] };
        return { fpId, name: st.name, mode, origArcs, origCoords, newArcs, newCoords, interiorPts, addedVerts: interiorPts.length, bridges: bridges.length, targets: planned.length, preIssues, unresolved };
    }

    // ---- commit a plan into the working copy (same write path as the splitter) ----
    function commitPlan(plan, opts) {
        const auto = !!(opts && opts.auto);
        // Never write into the editor while a vertex is actively held/dragged: Percepto only
        // commits a drag to React state on release, so a write mid-drag clobbers your live
        // move (snaps the vertex back) or disrupts an in-progress draw. Defer — the segment
        // stays an unprocessed candidate and the next release (onUpTrack) / sweep retries it.
        if (auto && mouseDown) return false;
        const wc = findFpWorkingCopies().find(w => w.id === plan.fpId);
        if (!wc || !wc.dispatch) { toast('Open the flight path editor to apply.', '#ff8a80'); return false; }
        // staleness guard: the path must not have changed since we planned it
        const curSigs = new Set((wc.state.arcs || []).map(arcSig));
        const origSigs = new Set(plan.origArcs.map(arcSig));
        if (curSigs.size !== origSigs.size || [...origSigs].some(s => !curSigs.has(s))) {
            toast('Path changed while analyzing — re-run smart-fill.', '#ffb14e'); return false;
        }
        undoStack.push({ id: plan.fpId, name: plan.name, kind: 'smart', arcs: plan.origArcs, coords: plan.origCoords });
        wc.dispatch({ ...wc.state, arcs: plan.newArcs, coords: plan.newCoords });
        state.inserts++;
        // Mark everything processed EXCEPT segments we couldn't band yet (no elevation):
        // leaving them out keeps them candidates so the next drop auto-retries them once
        // the cache/quota catches up — no need to nudge the vertex by hand.
        const resolvedSigs = new Set(plan.newArcs.map(arcSig));
        (plan.unresolved || []).forEach(s => resolvedSigs.delete(s));
        procState.set(plan.fpId, { count: plan.newArcs.length, sigs: resolvedSigs });
        log(`smart altitude on "${plan.name}": ${plan.targets} segment(s) → +${plan.addedVerts} step(s), ${plan.newArcs.length} arcs, ${plan.bridges} seam bridge(s) (validated · live working copy)`);
        renderPanel();
        const bandNote = plan.mode === 'agl'
            ? `AGL band +${settings.floorFt}/${settings.floorFt + settings.bandFt} ft (height above ground)`
            : `bands set (ground +${settings.floorFt}/${settings.floorFt + settings.bandFt} ft)`;
        toast(`⛰ Smart altitude: +${plan.addedVerts} step(s) on ${plan.name}, ${bandNote}. ${auto ? '' : 'Drag/Save as usual — no refresh.'}`, '#5fff5f');
        verifyEdit(plan.fpId, plan.preIssues, plan.newArcs.length, 'Smart altitude');
        return true;
    }

    // ---- AUTO mode: smart-fill segments added since we last looked (debounced on drop) ----
    const SMART_SETTLE_MS = 1000;  // wait this long after the LAST drop/drag before banding — lets you drag-drop-drop freely; the update only lands once you pause
    const SMART_SWEEP_MS = 4000;   // background heartbeat that catches any segment whose band got missed
    let smartTimer = null, autoBusy = false, smartRetryTimer = null;
    function scheduleSmartPass() { if (smartTimer) clearTimeout(smartTimer); smartTimer = setTimeout(() => { smartTimer = null; smartAutoPass().catch(e => warn('smartAutoPass threw', e)); }, SMART_SETTLE_MS); }
    async function smartAutoPass() {
        if (!settings.master || !settings.autoDraw || mouseDown || autoBusy || pendingPreview) return;
        elevRateLimited = false;
        const wcs = findFpWorkingCopies();
        for (const wc of wcs) {
            const arcs = wc.state.arcs || [];
            let ps = procState.get(wc.id);
            if (!ps) {
                // First time we've seen this path. Opened with ≥2 segments ⇒ an EXISTING
                // path — baseline it so we never auto-touch what was already there (use the
                // ⛰ Smart-fill button to re-do an existing path on purpose). ≤1 segment ⇒
                // it's being freshly drawn now — fall through and smart-fill from the start.
                if (arcs.length > 1) { procState.set(wc.id, { count: arcs.length, sigs: new Set(arcs.map(arcSig)) }); continue; }
                ps = { count: 0, sigs: new Set() }; procState.set(wc.id, ps);
            }
            // Candidates = any arc we haven't smart-processed at its CURRENT geometry. That
            // covers a freshly-drawn segment (new sig) AND a segment just moved by a drag/
            // snap drop (its endpoints changed → new sig). Drops are exactly when we recalc.
            const candidates = new Set(arcs.filter(a => !ps.sigs.has(arcSig(a))).map(arcSig));
            if (!candidates.size) { procState.set(wc.id, { count: arcs.length, sigs: new Set(arcs.map(arcSig)) }); continue; }
            autoBusy = true;
            try {
                const plan = await computePlan(wc.id, candidates);
                if (plan && !plan.error) commitPlan(plan, { auto: true });
                else {
                    if (plan && plan.error && debugOn()) log('auto smart-fill skipped:', plan.error);
                    // Baseline what we saw, but keep any un-banded (no-elevation) segments as
                    // candidates so the next drop auto-retries them once the cache/quota recovers.
                    const sigs = new Set(arcs.map(arcSig));
                    (plan && plan.unresolved || []).forEach(s => sigs.delete(s));
                    procState.set(wc.id, { count: arcs.length, sigs });
                }
            } finally { autoBusy = false; }
            if (elevRateLimited) {
                toast('⛰ Percepto’s elevation quota is exhausted — paused ~60s. Unfilled segments will auto-retry once it recovers (no need to nudge them).', '#ffb14e');
                // Auto-retry once the breaker expires so un-banded segments finish themselves.
                if (!smartRetryTimer) {
                    const wait = Math.max(2000, elevBreakerUntil - Date.now() + 800);
                    smartRetryTimer = setTimeout(() => { smartRetryTimer = null; if (editingFP()) scheduleSmartPass(); }, wait);
                }
            }
            break; // one path per pass — the next drop re-checks
        }
    }

    // ---- PREVIEW mode: analyze the whole open path, show proposed steps, await confirm ----
    let pendingPreview = null;  // { layer, panel }
    function clearPreview() {
        if (!pendingPreview) return;
        try { if (pendingPreview.layer) getLeafletMap().removeLayer(pendingPreview.layer); } catch (e) {}
        try { if (pendingPreview.panel) pendingPreview.panel.remove(); } catch (e) {}
        pendingPreview = null;
    }
    async function previewFill() {
        if (!settings.master) { toast('Smart altitude is off (enable it in the Control Panel).', '#ffb14e'); return; }
        clearPreview();
        const wcs = findFpWorkingCopies();
        if (!wcs.length) { toast('Open a flight path editor first.', '#ffb14e'); return; }
        const wc = wcs[0];
        const sigs = new Set((wc.state.arcs || []).map(arcSig));
        elevRateLimited = false;
        toast('⛰ Analyzing terrain under the path…', '#7fdfff');
        const plan = await computePlan(wc.id, sigs, true); // manual = force re-band (incl. AGL)
        if (!plan) { toast(elevRateLimited ? '⛰ Percepto’s elevation quota is exhausted — paused ~60s. Wait, then try ⛰ Smart-fill again (or pre-cache via the Asset Inspector’s elevation pass).' : 'Smart-fill: no elevation data / nothing to do.', '#ffb14e'); return; }
        if (plan.error) { toast(`⛰ Smart-fill blocked: ${plan.error}. Path untouched.`, '#ff8a80'); return; }
        showPreview(plan);
    }
    function showPreview(plan) {
        const map = getLeafletMap();
        const L = unsafeWindow.L;
        const layer = (map && L) ? L.layerGroup().addTo(map) : null;
        if (layer) plan.interiorPts.forEach(p => {
            try { L.circleMarker(L_ll(p), { radius: 6, color: '#7fdfff', weight: 2, fillColor: '#7fdfff', fillOpacity: 0.55 }).addTo(layer); } catch (e) {}
        });
        const panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1f2228;color:#e6e6e6;border:1px solid #7fdfff88;border-radius:8px;padding:14px 18px;font:13px -apple-system,sans-serif;z-index:100003;box-shadow:0 6px 22px rgba(0,0,0,0.7);max-width:84vw;text-align:center';
        panel.innerHTML = `<div style="font-weight:600;color:#7fdfff;margin-bottom:6px">⛰ Smart-fill "${plan.name}"</div>` +
            `<div style="margin-bottom:10px">+<b>${plan.addedVerts}</b> step(s) across <b>${plan.targets}</b> segment(s)` +
            (plan.bridges ? ` · ${plan.bridges} seam bridge(s)` : '') +
            `<br><span style="opacity:.75">bands = ground +${settings.floorFt} / +${settings.floorFt + settings.bandFt} ft · steps where ground varies >${settings.maxVarFt} ft</span></div>`;
        const mkBtn = (txt, bg, fn) => { const b = document.createElement('button'); b.textContent = txt; b.style.cssText = `margin:0 6px;padding:6px 16px;border:none;border-radius:5px;font:13px -apple-system;font-weight:600;cursor:pointer;background:${bg};color:#11151a`; b.addEventListener('click', fn); return b; };
        panel.appendChild(mkBtn('Apply', '#5fff5f', () => { const pl = plan; clearPreview(); commitPlan(pl, { auto: false }); }));
        panel.appendChild(mkBtn('Cancel', '#888', () => clearPreview()));
        document.body.appendChild(panel);
        pendingPreview = { layer, panel };
    }

    // ==================================================================
    // CORRIDOR PRE-WARM — fetch the WHOLE path's terrain once (gently),
    // resuming through the quota breaker, persisting as it goes. Afterward
    // smart-fill / peek / stepping run entirely from cache — no live calls,
    // quota-proof. The durable fix for fresh sites + open-space segments.
    // ==================================================================
    let prewarmActive = false, prewarmCancel = false, prewarmPanel = null;
    function setPrewarmPanel(html, withCancel) {
        if (!prewarmPanel) {
            prewarmPanel = document.createElement('div');
            prewarmPanel.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1f2228;color:#e6e6e6;border:1px solid #ffd40088;border-radius:8px;padding:12px 18px;font:13px -apple-system,sans-serif;z-index:100003;box-shadow:0 6px 22px rgba(0,0,0,0.7);max-width:84vw;text-align:center';
            document.body.appendChild(prewarmPanel);
        }
        prewarmPanel.innerHTML = html;
        if (withCancel) {
            const b = document.createElement('button');
            b.textContent = 'Cancel';
            b.style.cssText = 'margin-left:12px;padding:5px 14px;border:none;border-radius:5px;font:13px -apple-system;font-weight:600;cursor:pointer;background:#888;color:#11151a';
            b.addEventListener('click', () => { prewarmCancel = true; });
            prewarmPanel.appendChild(b);
        }
    }
    function hidePrewarmPanel() { if (prewarmPanel) { prewarmPanel.remove(); prewarmPanel = null; } }
    async function preWarmCorridor() {
        if (prewarmActive) { prewarmCancel = true; return; } // a second trigger cancels
        if (!settings.master) { toast('Smart altitude is off (enable it in the Control Panel).', '#ffb14e'); return; }
        const wcs = findFpWorkingCopies();
        if (!wcs.length) { toast('Open a flight path editor first.', '#ffb14e'); return; }
        // all sample points across the open path(s), deduped by rounded key
        const uniq = new Map();
        for (const p of buildPeekPoints()) { const k = ekey(p.lat, p.lng); if (!uniq.has(k)) uniq.set(k, p); }
        // drop points we already know (FPE cache, or Asset Inspector exact/nearest)
        const ai = aiElev();
        const todo = [];
        for (const [k, p] of uniq) {
            if (elevCache.has(k)) continue;
            if (ai) { let c = ai.getCached(p.lat, p.lng); if (c == null && ai.getNearest) c = ai.getNearest(p.lat, p.lng, AI_NEAREST_M); if (c != null) { elevCache.set(k, c); continue; } }
            todo.push(p);
        }
        if (!todo.length) { toast('⛰ Terrain already cached for this path — nothing to pre-warm. Smart-fill is instant.', '#5fff5f'); return; }
        prewarmActive = true; prewarmCancel = false;
        let done = 0, failed = 0;
        setPrewarmPanel(`⛰ Pre-warming terrain — 0 / ${todo.length}…`, true);
        for (const p of todo) {
            if (prewarmCancel) break;
            // wait out an open quota breaker, counting down, before each fetch
            while (breakerOpen() && !prewarmCancel) {
                setPrewarmPanel(`⛰ Pre-warming — ${done} / ${todo.length} · quota paused ${Math.ceil((elevBreakerUntil - Date.now()) / 1000)}s…`, true);
                await sleep(1000);
            }
            if (prewarmCancel) break;
            const g = await fetchElevation(p.lat, p.lng); // queue + rate-limit + persist on success
            if (g == null) failed++; else done++;
            setPrewarmPanel(`⛰ Pre-warming — ${done} / ${todo.length}${failed ? ` · ${failed} waiting on quota` : ''}…`, true);
        }
        if (elevDirty) persistElevCache();
        prewarmActive = false;
        hidePrewarmPanel();
        if (prewarmCancel) toast(`⛰ Pre-warm stopped — ${done}/${todo.length} cached (persisted). Run again to finish.`, '#ffd479');
        else if (failed) toast(`⛰ Pre-warm: ${done}/${todo.length} cached; ${failed} still blocked by quota. Wait a bit and run again to finish.`, '#ffb14e');
        else toast(`⛰ Pre-warm complete — ${todo.length} points cached + persisted. Smart-fill & peek are now instant + offline for this path.`, '#5fff5f');
    }

    // ---- floating "Smart-fill" + "Pre-warm" buttons while editing (work without the Control Panel) ----
    function ensureSmartUI() {
        let b = document.getElementById('aim-fpe-smart-btn');
        let pw = document.getElementById('aim-fpe-prewarm-btn');
        if (!settings.master || !editingFP()) { if (b) b.remove(); if (pw) pw.remove(); return; }
        if (!b) {
            b = document.createElement('div');
            b.id = 'aim-fpe-smart-btn';
            b.textContent = '⛰ Smart-fill path';
            b.title = 'Sample terrain under this path, add steps where the ground varies, and set every segment’s band (preview first)';
            b.style.cssText = 'position:fixed;bottom:64px;right:18px;background:#1f2228;border:1px solid rgba(127,223,255,0.6);border-radius:6px;padding:8px 12px;color:#7fdfff;font:12px -apple-system,sans-serif;font-weight:600;z-index:100001;box-shadow:0 6px 20px rgba(0,0,0,0.6);cursor:pointer;user-select:none';
            ['mousedown', 'click'].forEach(t => b.addEventListener(t, e => e.stopPropagation()));
            b.addEventListener('click', (e) => { e.preventDefault(); previewFill().catch(err => warn('previewFill threw', err)); });
            document.body.appendChild(b);
        }
        if (!pw) {
            pw = document.createElement('div');
            pw.id = 'aim-fpe-prewarm-btn';
            pw.textContent = '⤓ Pre-warm terrain';
            pw.title = 'Fetch the whole path’s terrain once (gently, resuming through quota pauses) + persist it, so smart-fill/peek/stepping run from cache. Click again to cancel.';
            pw.style.cssText = 'position:fixed;bottom:102px;right:18px;background:#1f2228;border:1px solid rgba(255,212,0,0.55);border-radius:6px;padding:8px 12px;color:#ffd400;font:12px -apple-system,sans-serif;font-weight:600;z-index:100001;box-shadow:0 6px 20px rgba(0,0,0,0.6);cursor:pointer;user-select:none';
            ['mousedown', 'click'].forEach(t => pw.addEventListener(t, e => e.stopPropagation()));
            pw.addEventListener('click', (e) => { e.preventDefault(); preWarmCorridor().catch(err => warn('preWarmCorridor threw', err)); });
            document.body.appendChild(pw);
        }
    }

    // ---- Control Panel integration (config lives here; matches the AIM house pattern) ----
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-flight-path-editor';
    let controlChannel = null;
    function registerWithControlPanel() {
        if (!controlChannel) return;
        try {
            controlChannel.postMessage({
                type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Map Editor', version: SCRIPT_VERSION, group: 'Site Setup', priority: 60,
                toggles: [
                    { id: 'master', label: 'Smart altitude', type: 'boolean', default: settings.master, master: true },
                    { id: 'aglHud', label: '▲ AGL view (show bands as AGL, Shift+G)', type: 'boolean', default: settings.aglHud },
                    { id: 'autoDraw', label: 'Auto-set bands as you draw', type: 'boolean', default: settings.autoDraw },
                    { id: 'floorFt', label: 'AGL floor (ft)', type: 'number', default: settings.floorFt },
                    { id: 'bandFt', label: 'Band width (ft)', type: 'number', default: settings.bandFt },
                    { id: 'maxVarFt', label: 'Max step variation (ft)', type: 'number', default: settings.maxVarFt },
                    { id: 'fillPath', label: '⛰ Smart-fill open path (preview)', type: 'button' },
                    { id: 'prewarm', label: '⤓ Pre-warm path terrain (cache)', type: 'button' },
                ],
                hotkeys: [],
            });
        } catch (e) { warn('registerWithControlPanel failed', e); }
    }
    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { warn('Control Panel channel unavailable — floating button still works', e); return; }
        controlChannel.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type === 'REQUEST_REGISTRATIONS') { registerWithControlPanel(); return; }
            if (m.scriptId !== SCRIPT_ID) return;
            if (m.type === 'SET_TOGGLE') {
                const v = (m.value !== undefined ? m.value : m.enabled);
                let changed = false;
                if (m.toggleId === 'master') { const nv = !!v; if (nv !== settings.master) { settings.master = nv; changed = true; } }
                else if (m.toggleId === 'aglHud') { const nv = !!v; if (nv !== settings.aglHud) { settings.aglHud = nv; saveSettings(); aglHudSig = ''; renderAglHud(); } return; }
                else if (m.toggleId === 'autoDraw') { const nv = !!v; if (nv !== settings.autoDraw) { settings.autoDraw = nv; changed = true; } }
                else if (m.toggleId === 'floorFt') { const nv = Number(v) || DEF_SETTINGS.floorFt; if (nv !== settings.floorFt) { settings.floorFt = nv; changed = true; } }
                else if (m.toggleId === 'bandFt') { const nv = Number(v) || DEF_SETTINGS.bandFt; if (nv !== settings.bandFt) { settings.bandFt = nv; changed = true; } }
                else if (m.toggleId === 'maxVarFt') { const nv = Number(v) || DEF_SETTINGS.maxVarFt; if (nv !== settings.maxVarFt) { settings.maxVarFt = nv; changed = true; } }
                if (changed) { saveSettings(); ensureSmartUI(); }
            } else if (m.type === 'TRIGGER_ACTION' && m.actionId === 'fillPath') {
                previewFill().catch(e => warn('previewFill threw', e));
            } else if (m.type === 'TRIGGER_ACTION' && m.actionId === 'prewarm') {
                preWarmCorridor().catch(e => warn('preWarmCorridor threw', e));
            }
        };
    }

    // ==================================================================
    // ELEVATION PEEK — hold Alt while editing a flight path to reveal the
    // terrain-check dots, but ONLY near the cursor (paths run hundreds of
    // segments, so we never render them all). Hover a yellow dot for live
    // ground + AGL data. Cache-first; uncached dots fetch gently (breaker-
    // gated + rate-limited), which organically warms the cache as you hover.
    // ==================================================================
    let peekMode = false, peekLayer = null, peekPoints = [], peekMoveTs = 0;
    const peekMarkers = new Map(); // point index -> circleMarker
    // Custom floating tip (not a Leaflet tooltip) so we can LINGER it ~250 ms after the
    // cursor leaves a dot — easier to read than an instant hide.
    let peekTipEl = null, peekTipTimer = null, peekTipOwner = null;
    function showPeekTip(html, px, py, owner) {
        if (!peekTipEl) {
            peekTipEl = document.createElement('div');
            peekTipEl.style.cssText = 'position:fixed;z-index:100050;pointer-events:none;background:#1f2228;color:#ffd400;border:1px solid #ffd40066;border-radius:5px;padding:4px 8px;font:11px -apple-system,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.6);white-space:nowrap;display:none';
            document.body.appendChild(peekTipEl);
        }
        peekTipEl.innerHTML = html;
        peekTipEl.style.left = (px + 12) + 'px';
        peekTipEl.style.top = (py - 30) + 'px';
        peekTipEl.style.display = 'block';
        peekTipOwner = owner || null;
        if (peekTipTimer) { clearTimeout(peekTipTimer); peekTipTimer = null; }
    }
    const PEEK_TIP_LINGER_MS = 250;
    function hidePeekTipSoon() { if (peekTipTimer) clearTimeout(peekTipTimer); peekTipTimer = setTimeout(() => { if (peekTipEl) peekTipEl.style.display = 'none'; peekTipOwner = null; }, PEEK_TIP_LINGER_MS); }
    function hidePeekTipNow() { if (peekTipTimer) { clearTimeout(peekTipTimer); peekTipTimer = null; } if (peekTipEl) peekTipEl.style.display = 'none'; peekTipOwner = null; }
    function buildPeekPoints() {
        const pts = [];
        findFpWorkingCopies().forEach(wc => (wc.state.arcs || []).forEach((arc, idx) => {
            const A = arc.point_a, B = arc.point_b;
            if (!finitePt(A) || !finitePt(B)) return;
            const distM = hav(A, B) || 0;
            const n = Math.max(2, Math.min(SMART_MAX_SAMPLES, Math.ceil(distM / (SMART_SAMPLE_SPACING_FT * FT_TO_M)) + 1));
            for (let i = 0; i < n; i++) { const t = i / (n - 1); pts.push({ lat: A.lat + (B.lat - A.lat) * t, lng: A.lng + (B.lng - A.lng) * t, seg: idx + 1, arc }); }
        }));
        return pts;
    }
    function peekLabel(groundM, arc, seg) {
        if (groundM == null) return `seg ${seg || '?'} · ground: fetching…`;
        let s = `seg ${seg || '?'} · ground ${Math.round(groundM * 3.28084)} ft`;
        if (arc && num(arc.min_alt) && num(arc.max_alt)) {
            const floorAgl = Math.round((arc.min_alt - groundM) * 3.28084), ceilAgl = Math.round((arc.max_alt - groundM) * 3.28084);
            s += ` · band ${Math.round(arc.min_alt * 3.28084)}–${Math.round(arc.max_alt * 3.28084)} ft (AGL ${floorAgl}–${ceilAgl})`;
        }
        return s;
    }
    // point→segment distance in metres (equirectangular) — for "which arc/seg is this?"
    function ptToSegM(p, a, b) {
        if (!finitePt(a) || !finitePt(b) || !finitePt(p)) return Infinity;
        const cos = Math.cos(p.lat * Math.PI / 180);
        const bx = (b.lng - a.lng) * 111320 * cos, by = (b.lat - a.lat) * 111320;
        const px = (p.lng - a.lng) * 111320 * cos, py = (p.lat - a.lat) * 111320;
        const len2 = bx * bx + by * by || 1; let t = (px * bx + py * by) / len2; t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - bx * t, py - by * t);
    }
    function findNearestArc(lat, lng) {
        let best = null, bestD = Infinity, seg = 0;
        findFpWorkingCopies().forEach(wc => (wc.state.arcs || []).forEach((arc, idx) => { const d = ptToSegM({ lat, lng }, arc.point_a, arc.point_b); if (d < bestD) { bestD = d; best = arc; seg = idx + 1; } }));
        return best ? { arc: best, seg } : null;
    }
    function addPeekMarker(i, p) {
        const L = unsafeWindow.L, map = getLeafletMap();
        if (!L || !map) return;
        const cached = elevCache.has(ekey(p.lat, p.lng)) ? elevCache.get(ekey(p.lat, p.lng)) : null;
        const m = L.circleMarker(L.latLng(p.lat, p.lng), { radius: 8, color: '#1a1a1a', weight: 1, fillColor: cached != null ? '#ffd400' : '#999', fillOpacity: 0.92 });
        m._peekHtml = peekLabel(cached, p.arc, p.seg);
        m.on('mouseover', ev => { const oe = ev.originalEvent || {}; showPeekTip(m._peekHtml, oe.pageX || 0, oe.pageY || 0, m); });
        m.on('mouseout', hidePeekTipSoon);
        peekLayer.addLayer(m);
        peekMarkers.set(i, m);
        if (cached == null) {
            fetchElevation(p.lat, p.lng).then(g => {
                if (peekMarkers.get(i) !== m) return;
                m._peekHtml = peekLabel(g, p.arc, p.seg);
                try { m.setStyle({ fillColor: g != null ? '#ffd400' : '#888' }); } catch (e) {}
                if (peekTipOwner === m && peekTipEl) showPeekTip(m._peekHtml, parseFloat(peekTipEl.style.left) - 12, parseFloat(peekTipEl.style.top) + 30, m); // refresh in place
            });
        }
    }
    function onPeekMove(e) {
        if (!peekMode) return;
        const now = Date.now(); if (now - peekMoveTs < 45) return; peekMoveTs = now;
        const map = getLeafletMap(), L = unsafeWindow.L; if (!map || !L) return;
        const cr = map.getContainer().getBoundingClientRect();
        const cx = e.clientX - cr.left, cy = e.clientY - cr.top;
        if (cx < 0 || cy < 0 || cx > cr.width || cy > cr.height) return;
        let cll; try { cll = map.containerPointToLatLng(L.point(cx, cy)); } catch (err) { return; }
        let metersR; try { metersR = map.distance(cll, map.containerPointToLatLng(L.point(cx + PEEK_RADIUS_PX, cy))); } catch (err) { metersR = 300; }
        const cos = Math.cos(cll.lat * Math.PI / 180) || 1e-6;
        const dLat = metersR / 111320, dLng = metersR / (111320 * cos);
        const inRange = new Set();
        for (let i = 0; i < peekPoints.length; i++) {
            const p = peekPoints[i];
            if (Math.abs(p.lat - cll.lat) > dLat || Math.abs(p.lng - cll.lng) > dLng) continue; // cheap bbox prefilter
            let cp; try { cp = map.latLngToContainerPoint(L.latLng(p.lat, p.lng)); } catch (err) { continue; }
            if (Math.hypot(cp.x - cx, cp.y - cy) > PEEK_RADIUS_PX) continue;
            inRange.add(i);
            if (!peekMarkers.has(i)) addPeekMarker(i, p);
        }
        for (const [i, m] of peekMarkers) { if (!inRange.has(i)) { if (peekTipOwner === m) hidePeekTipSoon(); try { peekLayer.removeLayer(m); } catch (e2) {} peekMarkers.delete(i); } }
    }
    // Percepto's own vertex handles + segment-number badges sit ON TOP of our dots (and
    // are draggable, so we can't cover them) — but you still want the numbers there. While
    // peeking, hovering a vertex/badge shows the same tip (terrain at that exact point).
    let peekDomToken = 0;
    function onPeekDomOver(e) {
        if (!peekMode) return;
        const el = e.target && e.target.closest && (e.target.closest(VERTEX_SEL) || e.target.closest(ARC_BADGE_SEL));
        if (!el) return;
        const map = getLeafletMap(), L = unsafeWindow.L; if (!map || !L) return;
        const cr = map.getContainer().getBoundingClientRect(), r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2 - cr.left, cy = r.top + r.height / 2 - cr.top;
        let ll; try { ll = map.containerPointToLatLng(L.point(cx, cy)); } catch (err) { return; }
        const hit = findNearestArc(ll.lat, ll.lng);
        const arc = hit ? hit.arc : null, seg = hit ? hit.seg : '?';
        const px = e.pageX || (r.left + r.width / 2), py = e.pageY || r.top;
        const key = ekey(ll.lat, ll.lng);
        const cached = elevCache.has(key) ? elevCache.get(key) : null;
        showPeekTip(peekLabel(cached, arc, seg), px, py, el);
        if (cached == null) {
            const tok = ++peekDomToken;
            fetchElevation(ll.lat, ll.lng).then(g => { if (peekMode && peekTipOwner === el && tok === peekDomToken) showPeekTip(peekLabel(g, arc, seg), px, py, el); });
        }
    }
    function onPeekDomOut(e) {
        if (!peekMode) return;
        const el = e.target && e.target.closest && (e.target.closest(VERTEX_SEL) || e.target.closest(ARC_BADGE_SEL));
        if (el) hidePeekTipSoon();
    }
    function enterPeek() {
        const map = getLeafletMap(), L = unsafeWindow.L; if (!map || !L) return;
        peekMode = true;
        peekPoints = buildPeekPoints();
        if (!peekLayer) peekLayer = L.layerGroup();
        peekLayer.addTo(map);
        document.addEventListener('mousemove', onPeekMove, true);
        document.addEventListener('mouseover', onPeekDomOver, true);
        document.addEventListener('mouseout', onPeekDomOut, true);
        toast(`⛰ Elevation peek ON — hover the yellow dots, or the vertices / segment numbers, near your cursor (${peekPoints.length} check points). Release Alt to hide.`, '#ffd400');
    }
    function exitPeek() {
        if (!peekMode) return;
        peekMode = false;
        document.removeEventListener('mousemove', onPeekMove, true);
        document.removeEventListener('mouseover', onPeekDomOver, true);
        document.removeEventListener('mouseout', onPeekDomOut, true);
        for (const [, m] of peekMarkers) { try { peekLayer.removeLayer(m); } catch (e) {} }
        peekMarkers.clear();
        hidePeekTipNow();
        try { const map = getLeafletMap(); if (map && peekLayer) map.removeLayer(peekLayer); } catch (e) {}
        if (elevDirty) persistElevCache(); // keep what hovering warmed
    }
    function onPeekKeyDown(e) {
        if (e.key !== 'Alt' || peekMode || !settings.master || !editingFP()) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        enterPeek();
    }
    function onPeekKeyUp(e) { if (e.key === 'Alt') exitPeek(); }

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

    // ==================================================================
    // AGL HUD — the native Min/Max alt fields show ABSOLUTE MSL on Mountain-
    // terrain sites (e.g. 2685 ft), which makes "am I 100 ft AGL?" impossible to
    // read. This floating panel sits BESIDE the editor and shows each segment's
    // band as AGL (= MSL − max ground under the segment, the safety-relevant
    // clearance) with the MSL right next to it for verification, and lets you TYPE
    // the band in AGL — it converts to MSL behind the scenes and writes the live
    // working copy (same safe path as the splitter). The backend stays MSL. A
    // toggle (Shift+G / header button / Control Panel) shows/hides it. On AGL
    // sites the stored value already IS AGL, so it's shown directly (+ MSL ref).
    // ==================================================================
    const AGL_HUD_ID = 'aim-fpe-agl-hud';
    const FT = 3.28084;
    const arcGroundCache = new Map(); // arcSig -> max ground (m) under the segment, or null
    let aglHudSig = '';               // last-rendered arc signature set (skip redundant rebuilds)
    let aglHudBusy = false;
    let aglGroundBackoffUntil = 0;    // pause ground fetches until this time if a pass resolved nothing (quota paused)
    const ffzGroundCache = new Map(); // ffz id -> max ground (m) under the polygon, or undefined
    function arcGroundMaxSync(arc) { const v = arcGroundCache.get(arcSig(arc)); return v === undefined ? undefined : v; }
    function ffzGroundSync(id) { return ffzGroundCache.has(id) ? ffzGroundCache.get(id) : undefined; }
    // Max ground (m) under an FFZ polygon — sample its vertices + centroid.
    async function ensureFfzGround(wc) {
        const id = wc.id;
        if (ffzGroundCache.has(id)) return ffzGroundCache.get(id);
        const coords = (wc.state.coords || []).filter(finitePt);
        if (!coords.length) return null;
        const pts = coords.slice(0, 16);
        let clat = 0, clng = 0; pts.forEach(p => { clat += p.lat; clng += p.lng; });
        pts.push({ lat: clat / pts.length, lng: clng / pts.length }); // centroid
        let gmax = -Infinity, any = false;
        for (const p of pts) { const e = await fetchElevation(p.lat, p.lng); if (typeof e === 'number') { any = true; if (e > gmax) gmax = e; } }
        if (any) ffzGroundCache.set(id, gmax); // don't cache nulls (quota paused) so it retries
        return any ? gmax : null;
    }
    async function ensureArcGround(arc) {
        const sig = arcSig(arc);
        if (arcGroundCache.has(sig)) return arcGroundCache.get(sig);
        const A = arc.point_a, B = arc.point_b;
        if (!finitePt(A) || !finitePt(B)) { arcGroundCache.set(sig, null); return null; }
        const distM = hav(A, B) || 0;
        // The HUD just needs a representative MAX ground for the band readout — NOT the
        // dense terrain-step sampling smart-altitude uses. Cap at 5 points/segment so a
        // 100-segment path is ~500 DEM calls, not thousands (which never finished under
        // the rate limit). Endpoints + a few interior catch the high spot well enough.
        const n = Math.max(2, Math.min(5, Math.ceil(distM / (300 * FT_TO_M)) + 1));
        let gmax = -Infinity, any = false;
        for (let i = 0; i < n; i++) { const t = i / (n - 1); const g = await fetchElevation(A.lat + (B.lat - A.lat) * t, A.lng + (B.lng - A.lng) * t); if (typeof g === 'number') { any = true; if (g > gmax) gmax = g; } }
        // Only cache a REAL value. A null means the quota breaker is open / rate-
        // limited (NOT "no terrain") — caching it would freeze that row on "ground…"
        // forever; leaving it uncached lets the next pass retry once quota recovers.
        if (any) arcGroundCache.set(sig, gmax);
        return any ? gmax : null;
    }
    function aglEditable(target) {
        return !!(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
            || (target.closest && target.closest('input,textarea,[contenteditable="true"],.ant-input,.ant-select'))));
    }
    function setAglHud(on) {
        settings.aglHud = !!on; saveSettings();
        try { controlChannel && controlChannel.postMessage({ type: 'AIM_AGL_VIEW', on: settings.aglHud, from: SCRIPT_ID }); } catch (e) {}
        aglHudSig = ''; renderAglHud();
        toast(settings.aglHud ? '▲ AGL view ON — bands shown as height above ground (MSL backend unchanged)' : '△ AGL view OFF — native MSL only', settings.aglHud ? '#7fdfff' : '#888');
    }
    // Given which field the user edited (in ft), the ground (ft), the site mode,
    // and the segment's CURRENT stored band (ft), return the new STORED band (ft).
    // The stored reference is MSL on a Mountain-terrain site, AGL otherwise; AGL and
    // MSL differ by the ground, Δ is the same in both. All three are editable and
    // cross-derive so the row live-updates.
    function deriveBand(field, x, gFt, mode, curMinFt, curMaxFt) {
        let minFt = curMinFt, maxFt = curMaxFt;
        const aglToStored = (aglFt) => mode === 'msl' ? (aglFt + gFt) : aglFt; // AGL→stored
        const mslToStored = (mslFt) => mode === 'msl' ? mslFt : (mslFt - gFt); // MSL→stored
        if (field === 'aglmin') minFt = aglToStored(x);
        else if (field === 'aglmax') maxFt = aglToStored(x);
        else if (field === 'mslmin') minFt = mslToStored(x);
        else if (field === 'mslmax') maxFt = mslToStored(x);
        else if (field === 'delta') maxFt = minFt + x; // Δ keeps the floor, moves the ceiling
        return { minFt, maxFt };
    }
    // Write a segment's new stored band (ft) into the live working copy — gated by the
    // same integrity check + undo as the splitter. Backend stays in its native unit.
    async function applyBandEdit(wcId, sig, minFt, maxFt) {
        if (!num(minFt) || !num(maxFt)) { log('AGL-edit: non-numeric band, ignored'); return; }
        const wc = findFpWorkingCopies().find(w => String(w.id) === String(wcId));
        if (!wc || !wc.dispatch) { toast('Open the flight path editor to apply.', '#ff8a80'); return; }
        const arc = (wc.state.arcs || []).find(a => arcSig(a) === sig);
        if (!arc) { log('AGL-edit: segment not found by sig (geometry changed?)'); aglHudSig = ''; renderAglHud(); return; }
        const minM = Math.round(minFt * FT_TO_M);
        let maxM = Math.round(maxFt * FT_TO_M); if (maxM <= minM) maxM = minM + 1;
        log(`AGL-edit: ${sig.slice(0, 16)} min_alt ${arc.min_alt}→${minM}m  max_alt ${arc.max_alt}→${maxM}m`);
        if (minM === arc.min_alt && maxM === arc.max_alt) { log('AGL-edit: no net change (rounded to same meters)'); toast('Altitudes store in whole metres (~3 ft steps) — that change was below one step, so it snapped back. Try a ≥3 ft change.', '#ffb14e'); return; }
        const newArcs = (wc.state.arcs || []).map(a => arcSig(a) !== sig ? a : ({ ...a, min_alt: minM, max_alt: maxM, min_emergency_alt: minM }));
        // Connected arcs must keep a >0 (server: ≥2 m) overlapping band or the path
        // 400s on save. Changing one segment's band almost always breaks that overlap
        // with its neighbours (tight bands) — which is why a raw edit reverted. Auto-
        // bridge: raise only the lower neighbour's ceiling to reconnect (each segment
        // keeps its floor) — the same fix smart-altitude uses.
        try { bridgeArcContinuity(newArcs, settings.overlapM); } catch (e) {}
        const pre = checkFlightPath(wc.state);
        const post = checkFlightPath({ arcs: newArcs, coords: wc.state.coords });
        const fresh = post.filter(p => !pre.includes(p));
        if (fresh.length) { log(`AGL-edit BLOCKED by integrity check: ${fresh[0]}`); toast(`Edit blocked: ${fresh[0]}. Segment untouched.`, '#ff8a80'); aglHudSig = ''; renderAglHud(); return; }
        undoStack.push({ id: wcId, name: wc.state.name, kind: 'agl', arcs: clone(wc.state.arcs), coords: clone(wc.state.coords) });
        wc.dispatch({ ...wc.state, arcs: newArcs });
        log('AGL-edit: dispatched to working copy');
        renderPanel();
        aglHudSig = ''; renderAglHud();
        // Verify the write actually stuck in React's committed state (diagnoses the
        // "reverts back" report — tells us if dispatch is being overwritten on re-render).
        setTimeout(() => {
            try {
                const w2 = findFpWorkingCopies().find(w => String(w.id) === String(wcId));
                const a2 = w2 && (w2.state.arcs || []).find(a => arcSig(a) === sig);
                if (a2) {
                    const stuck = (a2.min_alt === minM && a2.max_alt === maxM);
                    log(`AGL-edit VERIFY (+600ms): committed min_alt=${a2.min_alt}m max_alt=${a2.max_alt}m (wanted ${minM}/${maxM}) — ${stuck ? 'STUCK ✓' : 'REVERTED ✗'}`);
                    toast(stuck ? `✓ Stored: ${Math.round(a2.min_alt * FT)}–${Math.round(a2.max_alt * FT)} ft MSL` : '✗ Percepto reverted the write — tell Claude (it needs the native input path)', stuck ? '#5fff5f' : '#ff8a80');
                } else log('AGL-edit VERIFY: segment gone');
            } catch (e) {}
        }, 600);
    }
    function buildAglHud() {
        let el = document.getElementById(AGL_HUD_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = AGL_HUD_ID;
            // Geometry (left/top/width/height) is set by positionAglHud to sit EXACTLY
            // over Percepto's native form so it reads as native. Flush dark panel (no
            // rounded corners / shadow) matching the site-setup sidebar; opaque so the
            // native MSL list behind it is hidden.
            el.style.cssText = 'position:fixed;overflow:auto;background:#15181d;color:rgb(232,230,227);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;z-index:100001';
            // keep clicks/keys inside the HUD from reaching the map / global hotkeys
            ['mousedown', 'click', 'keydown', 'wheel'].forEach(t => el.addEventListener(t, e => e.stopPropagation()));
            el.addEventListener('input', onAglHudInput, true);   // live cross-update as you type
            el.addEventListener('change', onAglHudChange, true);  // commit to the working copy on blur/enter
            el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.classList.contains('aim-agl-in')) e.target.blur(); }, true);
            el.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-aglact]'); if (b) { if (b.getAttribute('data-aglact') === 'off') setAglHud(false); } });
            document.body.appendChild(el);
        }
        return el;
    }
    // Read a row's CURRENT committed stored band (ft) from the working copy.
    // kind 'ffz' → the FFZ's single restrictions band; else an FP arc (by sig).
    function rowStoredBandFt(wcId, sig, kind) {
        if (kind === 'ffz') {
            const wc = findFfzWorkingCopies().find(w => String(w.id) === String(wcId));
            const r = wc && wc.state.restrictions;
            if (!r || !num(r.minAlt) || !num(r.maxAlt)) return null;
            return { minFt: r.minAlt * FT, maxFt: r.maxAlt * FT };
        }
        const wc = findFpWorkingCopies().find(w => String(w.id) === String(wcId));
        const arc = wc && (wc.state.arcs || []).find(a => arcSig(a) === sig);
        if (!arc || !num(arc.min_alt) || !num(arc.max_alt)) return null;
        return { minFt: arc.min_alt * FT, maxFt: arc.max_alt * FT };
    }
    function bandFromInput(inp) {
        const field = inp.getAttribute('data-field');
        const mode = inp.getAttribute('data-mode');
        const gFt = parseFloat(inp.getAttribute('data-gft'));
        const x = parseFloat(inp.value);
        const cur = rowStoredBandFt(inp.getAttribute('data-wc'), inp.getAttribute('data-sig'), inp.getAttribute('data-kind'));
        if (!num(x) || !cur) return null;
        const needsGround = (mode === 'msl' && (field === 'aglmin' || field === 'aglmax')) || (mode === 'agl' && (field === 'mslmin' || field === 'mslmax'));
        if (needsGround && !num(gFt)) return null;
        return deriveBand(field, x, num(gFt) ? gFt : 0, mode, cur.minFt, cur.maxFt);
    }
    // LIVE: as you type in any field, recompute + repaint the OTHER fields in that
    // row (DOM only — no working-copy write yet). The MSL/AGL/Δ stay in lockstep.
    function onAglHudInput(e) {
        const inp = e.target;
        if (!inp || !inp.classList || !inp.classList.contains('aim-agl-in')) return;
        const b = bandFromInput(inp);
        if (!b) return;
        const row = inp.closest('tr'); if (!row) return;
        const gFt = parseFloat(inp.getAttribute('data-gft'));
        const mode = inp.getAttribute('data-mode');
        const r = (n) => String(Math.round(n));
        const aglMin = mode === 'msl' ? b.minFt - gFt : b.minFt;
        const aglMax = mode === 'msl' ? b.maxFt - gFt : b.maxFt;
        const mslMin = mode === 'msl' ? b.minFt : b.minFt + gFt;
        const mslMax = mode === 'msl' ? b.maxFt : b.maxFt + gFt;
        const vals = { aglmin: aglMin, aglmax: aglMax, delta: b.maxFt - b.minFt, mslmin: mslMin, mslmax: mslMax };
        row.querySelectorAll('input.aim-agl-in').forEach(o => {
            if (o === inp) return; // don't fight the cursor in the field being typed
            const f = o.getAttribute('data-field');
            if (f in vals && num(vals[f])) o.value = r(vals[f]);
        });
    }
    // COMMIT (blur/enter): write the row's resulting stored band to the working copy.
    function onAglHudChange(e) {
        const inp = e.target;
        if (!inp || !inp.classList || !inp.classList.contains('aim-agl-in')) return;
        const b = bandFromInput(inp);
        if (!b) { log(`AGL-edit: could not derive a band from field "${inp.getAttribute('data-field')}" (value ${inp.value}, gft ${inp.getAttribute('data-gft')}) — reverting display`); aglHudSig = ''; renderAglHud(); return; }
        if (inp.getAttribute('data-kind') === 'ffz') applyFfzBandEdit(inp.getAttribute('data-wc'), b.minFt, b.maxFt).catch(err => warn('applyFfzBandEdit threw', err));
        else applyBandEdit(inp.getAttribute('data-wc'), inp.getAttribute('data-sig'), b.minFt, b.maxFt).catch(err => warn('applyBandEdit threw', err));
    }
    // Commit a new band (ft) to the open FFZ's restrictions. FFZ altitudes allow
    // decimals (no whole-metre step) and have no connected-arc overlap rule, so no
    // bridge/round needed. minEmergencyAlt is left as-is (an unused leftover field).
    async function applyFfzBandEdit(wcId, minFt, maxFt) {
        if (!num(minFt) || !num(maxFt)) { log('FFZ-edit: non-numeric'); return; }
        const wc = findFfzWorkingCopies().find(w => String(w.id) === String(wcId));
        if (!wc || !wc.dispatch) { toast('Open the FFZ editor to apply.', '#ff8a80'); return; }
        const r = wc.state.restrictions || {};
        const minM = minFt * FT_TO_M;
        let maxM = maxFt * FT_TO_M; if (maxM <= minM) maxM = minM + 0.3;
        if (Math.abs(minM - (r.minAlt || 0)) < 0.05 && Math.abs(maxM - (r.maxAlt || 0)) < 0.05) return; // no change
        const newR = { ...r, minAlt: minM, maxAlt: maxM };
        wc.dispatch({ ...wc.state, restrictions: newR });
        log(`FFZ-edit: restrictions minAlt ${(r.minAlt || 0).toFixed(1)}→${minM.toFixed(1)}m maxAlt ${(r.maxAlt || 0).toFixed(1)}→${maxM.toFixed(1)}m (dispatched)`);
        toast(`✓ Stored: ${Math.round(minM * FT)}–${Math.round(maxM * FT)} ft MSL`, '#5fff5f');
        aglHudSig = ''; renderAglHud();
    }
    function renderAglHud() {
        const existing = document.getElementById(AGL_HUD_ID);
        if (!settings.aglHud) { if (existing) existing.remove(); aglHudSig = ''; return; }
        const fp = findFpWorkingCopies()[0];
        if (fp) { renderFpAglHud(fp); return; }
        const ffz = findFfzWorkingCopies()[0];
        if (ffz) { renderFfzAglHud(ffz); return; }
        if (existing) existing.remove(); aglHudSig = '';
    }
    function renderFpAglHud(wc) {
        const arcs = wc.state.arcs || [];
        const sid = fpeSiteId();
        let mode = sid ? (fpeAltModeCache[sid] || null) : null;
        if (mode === null) { fpeSiteAltMode().then(() => { aglHudSig = ''; renderAglHud(); }); mode = 'detecting'; }
        // signature: which arcs + their bands + known grounds → skip rebuild if unchanged
        const sig = wc.id + '|' + mode + '|' + arcs.map(a => `${arcSig(a)}:${a.min_alt}:${a.max_alt}:${arcGroundCache.get(arcSig(a))}`).join(',');
        if (sig === aglHudSig && document.getElementById(AGL_HUD_ID)) return;
        // Don't rebuild (which would steal focus) while the user is typing in a band input.
        const ae = document.activeElement;
        if (ae && ae.classList && ae.classList.contains('aim-agl-in') && document.getElementById(AGL_HUD_ID)) return;
        aglHudSig = sig;
        const el = buildAglHud();
        const isAgl = mode === 'agl';
        const modeChip = mode === 'detecting' ? '<span style="color:#ffb14e">detecting…</span>'
            : isAgl ? '<span style="color:#5fff5f">AGL site</span>' : mode === 'msl' ? '<span style="color:#7fdfff">MSL site → showing AGL</span>' : '<span style="color:#ff8a80">mode unknown</span>';
        let rows = '';
        // Warm ground for EVERY segment lacking it (not just the visible ones — the
        // whole point is you shouldn't have to scroll the native list). Progressive
        // re-render as values land; back off 4 s if a full pass resolved nothing
        // (quota paused) so we don't spin. fetchElevation self-throttles via the
        // shared queue / breaker.
        const wantGround = (mode === 'msl' || mode === 'agl');
        const missingCount = wantGround ? arcs.filter(a => !arcGroundCache.has(arcSig(a))).length : 0;
        if (wantGround && missingCount && !aglHudBusy && Date.now() >= aglGroundBackoffUntil) {
            aglHudBusy = true;
            (async () => {
                const missing = arcs.filter(a => !arcGroundCache.has(arcSig(a)));
                let resolved = 0, n = 0;
                for (const a of missing) { const g = await ensureArcGround(a); if (g != null) resolved++; if (++n % 8 === 0) { aglHudSig = ''; renderAglHud(); } }
                if (resolved === 0) aglGroundBackoffUntil = Date.now() + 4000;
                aglHudBusy = false; aglHudSig = ''; renderAglHud();
            })();
        }
        // Colour code: AGL = blue, Δ = yellow, MSL = orange (titles + boxes).
        const C = { agl: '#5fb8ff', delta: '#ffd400', msl: '#ff9f43' };
        const inS = (col) => `width:100%;box-sizing:border-box;background:#23272e;border:1px solid ${col}66;color:${col};border-radius:5px;padding:4px 2px;font:inherit;font-size:12px;text-align:center`;
        const dashCell = '<div style="text-align:center;color:#5b6470">…</div>';
        arcs.forEach((a, i) => {
            const g = arcGroundMaxSync(a);
            const gFt = (g != null) ? Math.round(g * FT) : null;
            const minM = num(a.min_alt) ? a.min_alt : null, maxM = num(a.max_alt) ? a.max_alt : null;
            // The STORED reference is always known; the OTHER reference needs ground.
            let aglMin = null, aglMax = null, mslMin = null, mslMax = null, delta = null;
            if (minM != null && maxM != null) {
                const sMin = Math.round(minM * FT), sMax = Math.round(maxM * FT);
                delta = sMax - sMin;
                if (isAgl) { aglMin = sMin; aglMax = sMax; if (gFt != null) { mslMin = sMin + gFt; mslMax = sMax + gFt; } }
                else if (mode === 'msl') { mslMin = sMin; mslMax = sMax; if (gFt != null) { aglMin = sMin - gFt; aglMax = sMax - gFt; } }
            }
            const da = `data-wc="${wc.id}" data-sig="${arcSig(a)}" data-mode="${mode}" data-gft="${gFt != null ? gFt : ''}"`;
            const cell = (field, val, col) => (val == null) ? dashCell : `<input class="aim-agl-in" data-field="${field}" ${da} value="${val}" style="${inS(col)}">`;
            rows += `<tr>`
                + `<td style="padding:4px 2px;color:#9aa4af;text-align:center;font-size:11px">${i + 1}</td>`
                + `<td style="padding:4px 3px">${cell('aglmin', aglMin, C.agl)}</td>`
                + `<td style="padding:4px 3px">${cell('aglmax', aglMax, C.agl)}</td>`
                + `<td style="padding:4px 3px">${cell('delta', delta, C.delta)}</td>`
                + `<td style="padding:4px 3px">${cell('mslmin', mslMin, C.msl)}</td>`
                + `<td style="padding:4px 3px">${cell('mslmax', mslMax, C.msl)}</td>`
                + `</tr>`;
        });
        const loadNote = missingCount ? `<span style="color:#ffb14e">loading ground ${arcs.length - missingCount}/${arcs.length}…</span>` : '';
        const th = (t, col) => `<th style="padding:0 3px 6px;font-weight:600;text-align:center;color:${col}">${t}</th>`;
        // table-layout:fixed + a colgroup makes the headers line up dead-on over the boxes.
        el.innerHTML = `
            <div style="padding:14px 10px 8px">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                    <span style="font-size:13px;letter-spacing:0.4px;color:#9aa4af;text-transform:uppercase">Path sections</span>
                    <button data-aglact="off" title="Show native MSL (Shift+G)" style="background:transparent;color:#9aa4af;border:1px solid #3a3f47;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px">MSL view</button>
                </div>
                <div style="font-size:11px;color:#6b7280;margin-bottom:8px">${modeChip} · <span style="color:${C.agl}">AGL</span> / <span style="color:${C.delta}">Δ</span> / <span style="color:${C.msl}">MSL</span> link live; edits commit to the live path (Save to persist). ${loadNote}</div>
                <table style="width:100%;border-collapse:collapse;table-layout:fixed">
                    <colgroup><col style="width:20px"><col><col><col><col><col></colgroup>
                    <thead><tr style="font-size:10px"><th style="padding:0 2px 6px;text-align:center;font-weight:600;color:#9aa4af">#</th>${th('AGL↓', C.agl)}${th('AGL↑', C.agl)}${th('Δ', C.delta)}${th('MSL↓', C.msl)}${th('MSL↑', C.msl)}</tr></thead>
                    <tbody>${rows || '<tr><td colspan="6" style="padding:10px;color:#6b7280;text-align:center">no segments</td></tr>'}</tbody>
                </table>
            </div>`;
        positionAglHud(el);
    }
    // FFZ editor: ONE altitude band (restrictions.minAlt/maxAlt). Same AGL/Δ/MSL
    // live-linked editing as the FP rows, but a single row + the FFZ's polygon ground.
    function renderFfzAglHud(wc) {
        const r = wc.state.restrictions || {};
        const minM = num(r.minAlt) ? r.minAlt : null, maxM = num(r.maxAlt) ? r.maxAlt : null;
        const sid = fpeSiteId();
        let mode = sid ? (fpeAltModeCache[sid] || null) : null;
        if (mode === null) { fpeSiteAltMode().then(() => { aglHudSig = ''; renderAglHud(); }); mode = 'detecting'; }
        const g = ffzGroundSync(wc.id);     // undefined = not fetched, null = no data
        const sig = 'ffz|' + wc.id + '|' + mode + '|' + minM + ':' + maxM + ':' + g;
        if (sig === aglHudSig && document.getElementById(AGL_HUD_ID)) return;
        const ae = document.activeElement;
        if (ae && ae.classList && ae.classList.contains('aim-agl-in') && document.getElementById(AGL_HUD_ID)) return;
        aglHudSig = sig;
        const el = buildAglHud();
        const isAgl = mode === 'agl';
        const modeChip = mode === 'detecting' ? '<span style="color:#ffb14e">detecting…</span>'
            : isAgl ? '<span style="color:#5fff5f">AGL site</span>' : mode === 'msl' ? '<span style="color:#7fdfff">MSL site → showing AGL</span>' : '<span style="color:#ff8a80">mode unknown</span>';
        const wantGround = (mode === 'msl' || mode === 'agl');
        const needGround = wantGround && g === undefined;
        if (needGround && !aglHudBusy && Date.now() >= aglGroundBackoffUntil) {
            aglHudBusy = true;
            (async () => { const got = await ensureFfzGround(wc); if (got == null) aglGroundBackoffUntil = Date.now() + 4000; aglHudBusy = false; aglHudSig = ''; renderAglHud(); })();
        }
        const gFt = (typeof g === 'number') ? Math.round(g * FT) : null;
        const C = { agl: '#5fb8ff', delta: '#ffd400', msl: '#ff9f43' };
        const inS = (col) => `width:100%;box-sizing:border-box;background:#23272e;border:1px solid ${col}66;color:${col};border-radius:5px;padding:6px 4px;font:inherit;font-size:13px;text-align:center`;
        const dashCell = '<div style="text-align:center;color:#5b6470">…</div>';
        let aglMin = null, aglMax = null, mslMin = null, mslMax = null, delta = null;
        if (minM != null && maxM != null) {
            const sMin = Math.round(minM * FT), sMax = Math.round(maxM * FT);
            delta = sMax - sMin;
            if (isAgl) { aglMin = sMin; aglMax = sMax; if (gFt != null) { mslMin = sMin + gFt; mslMax = sMax + gFt; } }
            else if (mode === 'msl') { mslMin = sMin; mslMax = sMax; if (gFt != null) { aglMin = sMin - gFt; aglMax = sMax - gFt; } }
        }
        const da = `data-wc="${wc.id}" data-kind="ffz" data-sig="" data-mode="${mode}" data-gft="${gFt != null ? gFt : ''}"`;
        const cell = (field, val, col) => (val == null) ? dashCell : `<input class="aim-agl-in" data-field="${field}" ${da} value="${val}" style="${inS(col)}">`;
        const th = (t, col) => `<th style="padding:0 3px 8px;font-weight:600;text-align:center;color:${col}">${t}</th>`;
        const loadNote = needGround ? '<span style="color:#ffb14e">loading ground…</span>' : '';
        el.innerHTML = `
            <div style="padding:14px 12px 8px">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                    <span style="font-size:13px;letter-spacing:0.4px;color:#9aa4af;text-transform:uppercase">FFZ altitude</span>
                    <button data-aglact="off" title="Show native MSL (Shift+G)" style="background:transparent;color:#9aa4af;border:1px solid #3a3f47;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px">MSL view</button>
                </div>
                <div style="font-size:11px;color:#6b7280;margin-bottom:10px">${xmlEsc(wc.state.name || 'FFZ')} · ${modeChip} · <span style="color:${C.agl}">AGL</span>/<span style="color:${C.delta}">Δ</span>/<span style="color:${C.msl}">MSL</span> link live. ${loadNote}</div>
                <table style="width:100%;border-collapse:collapse;table-layout:fixed">
                    <colgroup><col><col><col><col><col></colgroup>
                    <thead><tr style="font-size:10px">${th('AGL↓', C.agl)}${th('AGL↑', C.agl)}${th('Δ', C.delta)}${th('MSL↓', C.msl)}${th('MSL↑', C.msl)}</tr></thead>
                    <tbody><tr>
                        <td style="padding:5px 4px">${cell('aglmin', aglMin, C.agl)}</td>
                        <td style="padding:5px 4px">${cell('aglmax', aglMax, C.agl)}</td>
                        <td style="padding:5px 4px">${cell('delta', delta, C.delta)}</td>
                        <td style="padding:5px 4px">${cell('mslmin', mslMin, C.msl)}</td>
                        <td style="padding:5px 4px">${cell('mslmax', mslMax, C.msl)}</td>
                    </tr></tbody>
                </table>
            </div>`;
        positionAglHud(el);
    }
    // Sit EXACTLY over Percepto's native entity form (.upsert-entity__form) so it
    // reads as native, not a floating box. The SAVE/Cancel bar lives OUTSIDE the
    // form (in .upsert-entity), so it stays visible/clickable below us. Ends above
    // the SAVE button when present. Falls back to a left dock if the form is gone.
    function nativeFormEl() { return document.querySelector('.upsert-entity__form'); }
    function nativeSaveBtn() {
        const bs = document.querySelectorAll('button, [role="button"]');
        for (const b of bs) { const t = (b.textContent || '').trim().toUpperCase(); if (t === 'SAVE') return b; }
        return null;
    }
    function positionAglHud(el) {
        try {
            const form = nativeFormEl();
            const save = nativeSaveBtn();
            if (form) {
                const r = form.getBoundingClientRect();
                const bottomLimit = save ? (save.getBoundingClientRect().top - 8) : (window.innerHeight - 8);
                el.style.left = Math.round(r.left) + 'px';
                el.style.top = Math.round(r.top) + 'px';
                el.style.width = Math.round(r.width) + 'px';
                el.style.height = Math.max(120, Math.round(bottomLimit - r.top)) + 'px';
                el.style.bottom = 'auto';
            } else if (save) {
                const r = save.getBoundingClientRect();
                el.style.left = '0px'; el.style.top = '0px';
                el.style.width = Math.max(280, Math.round(r.right + 8)) + 'px';
                el.style.height = Math.max(120, Math.round(r.top - 8)) + 'px'; el.style.bottom = 'auto';
            } else {
                el.style.left = '0px'; el.style.top = '0px'; el.style.width = '320px'; el.style.height = '70vh'; el.style.bottom = 'auto';
            }
        } catch (e) {}
    }
    function xmlEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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

    // ==================================================================
    // NATIVE HOVER TOOLTIP → AGL. Percepto shows "ALT(ft) 2799 - 2828" (MSL) when
    // you hover an FFZ/FP line — its OWN tooltip, not ours, and the user can't pin
    // it to inspect. So we match it by CONTENT (regex on text), not selector, and
    // append "≈ X – Y ft AGL" using the ground at the cursor. MSL sites only (AGL
    // sites already show AGL). Best-effort + fully guarded: a miss does nothing.
    // ==================================================================
    let lastMapLL = null;
    function groundAtSync(lat, lng) {
        try {
            const k = ekey(lat, lng);
            if (elevCache.has(k)) return elevCache.get(k);
            const ai = aiElev();
            if (ai) { let c = ai.getCached && ai.getCached(lat, lng); if (c == null && ai.getNearest) c = ai.getNearest(lat, lng, AI_NEAREST_M); if (c != null) return c; }
        } catch (e) {}
        return null;
    }
    const ALT_TIP_RE = /ALT\s*\(ft\)\s*([\d,]+)\s*[-–]\s*([\d,]+)/i;
    function augmentAltTooltip(el) {
        try {
            if (!settings.aglHud || !el || el.nodeType !== 1) return;
            // ONE augment per tooltip: skip if this element, an ancestor, OR a descendant
            // is already done (the wrapper AND an inner span both match the text → dup).
            if ((el.getAttribute && el.getAttribute('data-aim-agl'))
                || (el.closest && el.closest('[data-aim-agl]'))
                || (el.querySelector && el.querySelector('[data-aim-agl]'))) return;
            const txt = el.textContent || '';
            if (txt.length > 80 || txt.indexOf('ALT') < 0) return;
            const m = txt.match(ALT_TIP_RE);
            if (!m) return;
            const sid = fpeSiteId(); const mode = sid ? fpeAltModeCache[sid] : null;
            if (mode == null) { fpeSiteAltMode(); return; }
            if (mode !== 'msl') return;            // AGL sites already display AGL
            if (!lastMapLL) return;
            let g = groundAtSync(lastMapLL.lat, lastMapLL.lng);
            if (g == null) {
                // The tooltip is on an FFZ/FP line — fall back to the nearest FP
                // segment's already-loaded max-ground (the HUD warms them all).
                const near = findNearestArc(lastMapLL.lat, lastMapLL.lng);
                if (near && arcGroundCache.has(arcSig(near.arc))) g = arcGroundCache.get(arcSig(near.arc));
            }
            if (g == null) { try { fetchElevation(lastMapLL.lat, lastMapLL.lng); } catch (e) {} return; } // warm; NOT marked → re-hover retries
            el.setAttribute('data-aim-agl', '1');  // mark only once we actually augment (so a cold spot stays retryable)
            const gFt = g * 3.28084;
            const lo = Math.round(parseFloat(m[1].replace(/,/g, '')) - gFt), hi = Math.round(parseFloat(m[2].replace(/,/g, '')) - gFt);
            // AGL on TOP and bigger (what the user cares about); Percepto's MSL line stays below.
            const add = document.createElement('div');
            add.style.cssText = 'color:#7fd1ff;font-size:15px;font-weight:700;margin-bottom:3px';
            add.textContent = `${lo} – ${hi} ft AGL`;
            el.insertBefore(add, el.firstChild);
        } catch (e) {}
    }
    function watchAltTooltips() {
        try {
            const map = getLeafletMap();
            const root = (map && map.getContainer && map.getContainer()) || document.body;
            document.addEventListener('mousemove', (e) => {
                try { const mp = getLeafletMap(); if (mp && mp.mouseEventToLatLng) lastMapLL = mp.mouseEventToLatLng(e); } catch (er) {}
            }, true);
            const obs = new MutationObserver(muts => {
                if (!settings.aglHud) return;
                for (const mu of muts) for (const n of mu.addedNodes) {
                    if (!n || n.nodeType !== 1) continue;
                    augmentAltTooltip(n);
                    if (n.children && n.children.length && n.children.length < 12 && n.querySelectorAll) n.querySelectorAll('*').forEach(augmentAltTooltip);
                }
            });
            obs.observe(root, { childList: true, subtree: true });
        } catch (e) { warn('tooltip watcher failed', e); }
    }

    // ---- boot ----
    loadSettings();
    loadElevCache();
    patchLeafletMap();
    ensureStyle();
    installBadgeListeners();
    setupControlPanel();
    registerWithControlPanel();
    setInterval(ensureSmartUI, 1500);
    // Background sweep: catch any segment whose band got missed (elevation wasn't ready on
    // its one drop-triggered pass and you never dropped near it again). Idle when you're
    // holding a vertex or there's nothing unfilled; the pass itself no-ops if all clean.
    setInterval(() => { if (settings.master && settings.autoDraw && !mouseDown && !autoBusy && editingFP()) scheduleSmartPass(); }, SMART_SWEEP_MS);
    // AGL HUD: keep it in sync while editing (cheap — skips rebuild when nothing changed).
    setInterval(() => { try { renderAglHud(); const el = document.getElementById(AGL_HUD_ID); if (el) positionAglHud(el); } catch (e) {} }, 900);
    setTimeout(watchAltTooltips, 2500); // give the map time to mount, then watch native ALT tooltips
    // Shift+G toggles the AGL view (quick flip back to native MSL to verify).
    window.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key !== 'g' && e.key !== 'G') return;
        if (aglEditable(e.target)) return;
        e.preventDefault(); e.stopPropagation();
        setAglHud(!settings.aglHud);
    }, true);
    let bootTries = 0;
    const bootIv = setInterval(() => { bootTries++; hookPopups(); if (popupHooked || bootTries > 80) clearInterval(bootIv); }, 700);
    log(`v${SCRIPT_VERSION} ready (iframe) — SMART ALTITUDE (terrain-following auto band + greedy auto-step: ground +${settings.floorFt}/${settings.floorFt + settings.bandFt} ft, steps where ground varies >${settings.maxVarFt} ft; auto-on-draw=${settings.autoDraw}, master=${settings.master}) · HOLD ALT while editing = elevation peek (yellow terrain dots near the cursor, hover for ground/AGL) · ⛰ Smart-fill button / Control Panel for an existing path · split (click a segment number) + OPEN PATH (vertex popup) · every edit runs a pre-write gate AND a post-write integrity check (auto-reverts on any new problem) · window.__aim_fpe_check() reports path health · auto-blocks the native phantom-vertex-on-drop bug`);
})();
