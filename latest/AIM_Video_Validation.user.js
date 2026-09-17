// ==UserScript==
// @name         Latest - AIM Video Validation
// @namespace    http://tampermonkey.net/
// @version      0.7
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Video_Validation.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Video_Validation.user.js
// @description  Mission Playback helpers for first-flight video validation: snapshot strip in flight order with S# badges, click a snapshot to seek the video to its shutter time, playhead highlights the current shot, shot card with planned-vs-actual heading / camera angle / altitude. Read-only (Phase 1). Design: ShortKeys/AIM_Video_Validation_Design.md.
// @author       Payden
// @match        *://percepto.app/*
// @match        *://qa.percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @match        https://qa.percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

// AIM Video Validation — Phase 1 (view only, no writes).
// What it does: on /#/site/<sid>/control-panel/past-mission/<mid> (Mission Playback) it joins the
// flown mission (images + flown path + embedded plan) and (1) reorders the snapshot strip oldest-first
// with S# badges, (2) seeks the video to a snapshot's shutter time on click / ▶, (3) highlights the
// shot under the playhead, (4) shows a shot card: planned vs actual heading / camera angle / altitude.
// Hotkeys: [ / ] — previous / next shot (still viewer open → previous / next image in OUR order; else video by shot).
//          Routed by the Control Panel (scope 'playback', CP ≥ 1.45) with a direct fallback until the panel proves it routes them.
// Log tag: [AIM VV]
(function() {
    'use strict';

    const SCRIPT_ID = 'aim-video-validation';
    const SCRIPT_VERSION = '0.7';
    const TAG = '[AIM VV]';
    const IS_TOP = window === window.top;
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const ROUTE_RX = /#\/site\/(\d+)\/control-panel\/past-mission\/(\d+)/;
    const SHOT_MATCH_WINDOW_S = 12;     // playhead within this of a shutter = "current shot"
    const M_TO_FT = 3.28084;

    // With @grant, the sandbox console can be invisible in the page console — log via the page's.
    const pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const log = function() {
        try { (pageWin.console || console).log.apply(null, [TAG].concat([].slice.call(arguments))); }
        catch (e) { console.log(TAG, e); }
    };
    const warn = function() {
        try { (pageWin.console || console).warn.apply(null, [TAG].concat([].slice.call(arguments))); }
        catch (e) { console.warn(TAG, e); }
    };

    // Per-tab identity shared across frames via the REAL page top (same-origin).
    // Must match the Control Panel's aimTabId (HOTKEY_FIRED / TRIGGER_ACTION are tab-local).
    function aimTabId() {
        try {
            const t = pageWin.top;
            if (!t.__AIM_TAB_ID) t.__AIM_TAB_ID = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
            return t.__AIM_TAB_ID;
        } catch (e) { return null; }
    }
    const TAB_ID = aimTabId();

    // ---------------------------------------------------------------
    // Settings (Control Panel toggles; GM-persisted per script)
    // ---------------------------------------------------------------
    const SETTINGS_KEY = 'aim-vv-settings';
    const DEFAULTS = {
        master: true,
        stripOrder: true,      // oldest-first strip
        badges: true,          // S# badges on tiles
        clickSeek: true,       // clicking a thumbnail also seeks the video
        leadInS: 3,            // seek this many seconds BEFORE the shutter
        shotCard: true,        // docked shot card under the strip
        units: 'ft',           // 'ft' | 'm'
        overlay: true,         // plan steps on the map
        overlayActual: true,   // actual shot poses (drone dot + heading + footprint)
        overlayLabels: true,   // N#/S# labels (else plain dots)
        overlayGroup: false,   // whole mission group, color per flight, whole-mission numbering
    };
    let settings = Object.assign({}, DEFAULTS);
    try { settings = Object.assign({}, DEFAULTS, GM_getValue(SETTINGS_KEY, {}) || {}); }
    catch (e) { warn('settings load failed (defaults):', e); }
    function saveSettings() { try { GM_setValue(SETTINGS_KEY, settings); } catch (e) { warn('settings save failed:', e); } }

    // ---------------------------------------------------------------
    // Route / frame gates
    // ---------------------------------------------------------------
    function topHash() { try { return pageWin.top.location.hash || ''; } catch (e) { return location.hash || ''; } }
    function routeIds() { const m = topHash().match(ROUTE_RX); return m ? { sid: m[1], mid: m[2] } : null; }
    function playbackRoot() { return document.querySelector('.mission-playback, .mp-content'); }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------
    const R_EARTH = 6371000, RAD = Math.PI / 180;
    function distM(a, b) {
        if (!a || !b) return null;
        const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
        return 2 * R_EARTH * Math.asin(Math.sqrt(x));
    }
    function bearingDeg(a, b) {
        const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
        const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
        return (Math.atan2(y, x) / RAD + 360) % 360;
    }
    function hdgDelta(a, b) { if (a == null || b == null) return null; let d = ((b - a) % 360 + 540) % 360 - 180; return d; }
    // Percepto gimbal units → degrees (2000 = level, 1000 = straight down; verified ±1.5°).
    function gimbalToDeg(v) { return (typeof v === 'number') ? (v - 2000) / (1000 / 90) : null; }
    // Filename '2026_09_16__21_15_36_7__235004_thermal.jpg' → epoch ms (UTC, tenths). Shutter time; created_at is upload time.
    function nameTime(name) {
        const m = String(name || '').match(/(\d{4})_(\d{2})_(\d{2})__(\d{2})_(\d{2})_(\d{2})_(\d)/);
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7] * 100) : null;
    }
    // Image URL → stable key: last path segment minus the size suffix + query. Same for img.src and thumbnail_url.
    function imgKey(u) {
        try { return new URL(u, location.origin).pathname.split('/').pop().replace(/\.size_w\d+/, ''); }
        catch (e) { return String(u || '').split('?')[0].split('/').pop().replace(/\.size_w\d+/, ''); }
    }
    function mmss(s) { if (s == null || !isFinite(s)) return '–'; const n = Math.max(0, Math.round(s)); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); }
    function fmtAlt(m) { if (m == null || !isFinite(m)) return '–'; return settings.units === 'm' ? m.toFixed(0) + ' m' : (m * M_TO_FT).toFixed(0) + ' ft'; }
    function fmtDist(m) { if (m == null || !isFinite(m)) return '–'; return settings.units === 'm' ? m.toFixed(1) + ' m' : (m * M_TO_FT).toFixed(0) + ' ft'; }
    function signed(n, unit, digits) { if (n == null || !isFinite(n)) return '–'; const s = (n > 0 ? '+' : '') + n.toFixed(digits == null ? 0 : digits); return s + (unit || ''); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function getJSON(u) {
        return fetch(u, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u); return r.json(); });
    }

    // ---------------------------------------------------------------
    // Model — one per (sid, mid). Built by loadModel().
    // ---------------------------------------------------------------
    // model = { sid, mid, mission, plan[], byId{}, video{t0, duration}, fixes[] (sorted), insFixes[] (with app_instruction),
    //           images[] (full records + shutter/videoOff/key/step), shots[] (images grouped by shutter),
    //           slice{minIdx,maxIdx}, numbering{ stepId -> {n:'S3', kind:'snap'|'nav'} } }
    let model = null;
    let loading = null;

    function loadModel(sid, mid) {
        log('loading mission ' + mid + ' (site ' + sid + ')');
        const imagesUrl = '/images/?site=' + sid + '&mission=' + mid + '&limit=100&offset=0';
        return Promise.all([
            getJSON('/missions/' + mid + '/'),
            getJSON('/videos/' + mid + '/'),
            getJSON(imagesUrl).then(function page(j) {
                // Follow pagination if Percepto ever returns more than one page.
                const results = (j && j.results) || (Array.isArray(j) ? j : []);
                if (j && j.next) {
                    return getJSON(String(j.next).replace(/^https?:\/\/[^/]+/, '')).then(page).then(more => results.concat(more));
                }
                return results;
            }),
            getJSON('/mission_positions/' + mid + '/'),
        ]).then(([mission, videos, images, pos]) => {
            const m = { sid, mid, mission, images: [], shots: [], byId: {}, numbering: {} };
            m.plan = (mission.app && Array.isArray(mission.app.instructions)) ? mission.app.instructions.slice().sort((a, b) => a.index_in_app - b.index_in_app) : [];
            m.plan.forEach(s => { m.byId[s.id] = s; });
            const v = (Array.isArray(videos) ? videos[0] : videos) || {};
            m.video = { t0: v.drone_record_start_time ? new Date(v.drone_record_start_time).getTime() : null, rec: v };
            if (!m.video.t0) warn('video record has no drone_record_start_time — falling back to first flown fix');
            m.fixes = (pos.positions || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            m.fixes.forEach(f => { f._t = new Date(f.timestamp).getTime(); });
            if (!m.video.t0 && m.fixes.length) m.video.t0 = m.fixes[0]._t;
            m.insFixes = m.fixes.filter(f => f.app_instruction != null).map(f => ({ t: f._t, id: (typeof f.app_instruction === 'object') ? f.app_instruction.id : f.app_instruction }));

            // This flight's slice of the plan = index range of the instructions that actually activated.
            const idxs = m.insFixes.map(x => m.byId[x.id] ? m.byId[x.id].index_in_app : null).filter(x => x != null);
            m.slice = idxs.length ? { minIdx: Math.min.apply(null, idxs), maxIdx: Math.max.apply(null, idxs) } : null;
            computeNumbering(m, false);

            // Images: shutter time, video offset, step join, actual-vs-planned deltas.
            images.forEach(im => {
                const shutter = nameTime(im.name) || (im.created_at ? new Date(im.created_at).getTime() : null);
                const rec = Object.assign({}, im, {
                    shutter,
                    videoOff: (shutter != null && m.video.t0 != null) ? (shutter - m.video.t0) / 1000 : null,
                    key: imgKey(im.thumbnail_url || im.url),
                    kind: im.type === 'THERMAL' || im.thermal ? 'T' : (im.type === 'GEM' ? 'G' : 'RGB'),
                });
                rec.step = activeStepAt(m, shutter);
                rec.fix = nearestFix(m, shutter);
                rec.delta = computeDelta(m, rec);
                m.images.push(rec);
            });
            const KIND_RANK = { RGB: 0, T: 1, G: 2 };
            m.images.sort((a, b) => (a.shutter || 0) - (b.shutter || 0) || (KIND_RANK[a.kind] || 0) - (KIND_RANK[b.kind] || 0));
            m.images.forEach((im, i) => { im.rank = i + 1; });   // CSS order value (video tile = 0)
            // Shots = images sharing a shutter time (RGB + thermal [+ GEM] of one snapshot).
            let cur = null;
            m.images.forEach(im => {
                if (!cur || im.shutter == null || cur.shutter == null || Math.abs(im.shutter - cur.shutter) > 1500) {
                    cur = { shutter: im.shutter, videoOff: im.videoOff, images: [], step: im.step, delta: im.delta, primary: im };
                    m.shots.push(cur);
                }
                cur.images.push(im);
                if (im.kind === 'RGB') { cur.primary = im; cur.delta = im.delta; }
            });
            // Extra shots on an already-shot step (pilot re-take) get flagged.
            const seen = {};
            m.shots.forEach(sh => { const id = sh.step && sh.step.id; if (id != null) { sh.retake = !!seen[id]; seen[id] = true; } });
            log('model ready: plan ' + m.plan.length + ' steps, slice ' + (m.slice ? m.slice.minIdx + '–' + m.slice.maxIdx : 'n/a') + ', images ' + m.images.length + ', shots ' + m.shots.length + ', fixes ' + m.fixes.length + ', t0 ' + (m.video.t0 ? new Date(m.video.t0).toISOString() : 'n/a'));
            return m;
        });
    }

    // Numbering: S#/N# per flight (slice) by default; whole-plan when `global`.
    function computeNumbering(m, global) {
        m.numbering = {};
        m.numberingGlobal = !!global;
        let s = 0, n = 0;
        m.plan.forEach(step => {
            const inSlice = global || !m.slice || (step.index_in_app >= m.slice.minIdx && step.index_in_app <= m.slice.maxIdx);
            if (!inSlice) return;
            if (step.type_name === 'snapshot') { s++; m.numbering[step.id] = { n: 'S' + s, kind: 'snap', ord: s }; }
            else if (step.type_name === 'navigate') { n++; m.numbering[step.id] = { n: 'N' + n, kind: 'nav', ord: n }; }
        });
    }

    // Plan step active at time t: latest app_instruction fix at or before t.
    function activeStepAt(m, t) {
        if (t == null || !m.insFixes.length) return null;
        let best = null;
        for (const f of m.insFixes) { if (f.t <= t) best = f; else break; }
        return best ? (m.byId[best.id] || null) : null;
    }
    function nearestFix(m, t) {
        if (t == null || !m.fixes.length) return null;
        let lo = 0, hi = m.fixes.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (m.fixes[mid]._t < t) lo = mid + 1; else hi = mid; }
        const a = m.fixes[lo], b = m.fixes[lo - 1];
        return (b && Math.abs(b._t - t) < Math.abs(a._t - t)) ? b : a;
    }
    // Parent navigate of a step = nearest preceding navigate in the plan.
    function parentNav(m, step) {
        if (!step) return null;
        const i = m.plan.indexOf(step);
        for (let k = i - 1; k >= 0; k--) if (m.plan[k].type_name === 'navigate') return m.plan[k];
        return null;
    }
    // Planned pose for a snapshot step: GPS snapshot (has location) → derived from nav → aim point; in-place → explicit.
    function plannedPose(m, step) {
        if (!step || step.type_name !== 'snapshot') return null;
        const nav = parentNav(m, step);
        const eo = step.extra_options || {};
        const navAlt = nav ? (nav.extra_options && nav.extra_options.abs_alt != null ? nav.extra_options.abs_alt : nav.value1) : null;
        if (step.location && typeof step.location.lat === 'number') {
            const aimAlt = (typeof step.value1 === 'number') ? step.value1 : null;
            const pose = { type: 'gps', aim: step.location, aimAlt, nav, navAlt, heading: null, pitchDeg: null, alt: navAlt };
            if (nav && nav.location) {
                pose.heading = bearingDeg(nav.location, step.location);
                const horiz = distM(nav.location, step.location);
                if (aimAlt != null && navAlt != null && horiz != null) pose.pitchDeg = Math.atan2(aimAlt - navAlt, horiz) / RAD;
                pose.range = horiz;
            }
            return pose;
        }
        return { type: 'inplace', nav, navAlt, heading: (typeof eo.heading === 'number') ? eo.heading : null, pitchDeg: gimbalToDeg(eo.pitch), alt: (typeof eo.abs_alt === 'number') ? eo.abs_alt : navAlt };
    }
    function computeDelta(m, im) {
        const step = im.step;
        if (!step) return { none: true };
        const pose = plannedPose(m, step);
        if (!pose) return { notSnap: true, stepType: step.type_name };
        const d = { pose };
        d.hdg = hdgDelta(pose.heading, im.drone_heading);
        d.pitch = (pose.pitchDeg != null && typeof im.camera_pitch === 'number') ? im.camera_pitch - pose.pitchDeg : null;
        d.alt = (pose.alt != null && typeof im.alt === 'number') ? im.alt - pose.alt : null;
        d.pos = (pose.nav && pose.nav.location && im.location) ? distM(pose.nav.location, im.location) : null;
        return d;
    }

    // ---------------------------------------------------------------
    // DOM: strip order + badges
    // ---------------------------------------------------------------
    let styleEl = null;
    function ensureCSS() {
        if (styleEl && document.head.contains(styleEl)) return;
        styleEl = document.createElement('style');
        styleEl.id = 'aim-vv-style';
        styleEl.textContent = `
            .aim-vv-tile { position: relative; }
            .aim-vv-nav { position: absolute; bottom: 14px; z-index: 20; width: 34px; height: 34px; border-radius: 50%;
                border: 1px solid rgba(95,227,255,.7); background: rgba(10,14,18,.8); color: #5fe3ff; font: 700 22px/30px monospace; cursor: pointer; }
            .aim-vv-nav:hover { background: #5fe3ff; color: #04222a; }
            .aim-vv-nav--prev { left: 14px; } .aim-vv-nav--next { right: 14px; }
            .aim-vv-nav--off { opacity: .25; cursor: default; }
            html.aim-vv-own-nav .mp-media .pr-image-nav-btn { display: none !important; }
            .aim-vv-badge { position: absolute; left: 3px; top: 3px; z-index: 100; pointer-events: none;
                font: 800 10px/14px monospace; padding: 0 4px; border-radius: 3px; color: #04222a;
                background: #ff7ad9; box-shadow: 0 1px 3px rgba(0,0,0,.6); }
            .aim-vv-badge--t { background: #ffb347; }
            .aim-vv-badge--g { background: #b0ff5f; }
            .aim-vv-badge--none { background: #ff5f5f; color: #fff; }
            .aim-vv-badge--retake { outline: 2px dashed #fff; }
            .aim-vv-seek { position: absolute; right: 3px; bottom: 3px; z-index: 100; cursor: pointer;
                font: 700 11px/16px monospace; width: 18px; height: 18px; text-align: center; border-radius: 3px;
                background: rgba(0,0,0,.65); color: #5fe3ff; border: 1px solid rgba(95,227,255,.6); }
            .aim-vv-seek:hover { background: #5fe3ff; color: #04222a; }
            .aim-vv-tile--active { outline: 2px solid #5fe3ff; outline-offset: -2px; }
            .aim-vv-card { margin: 6px 0 4px; padding: 6px 8px; border: 1px solid rgba(95,227,255,.35); border-radius: 4px;
                background: rgba(10,14,18,.85); color: #e6e6e6; font: 11px/1.4 monospace; }
            .aim-vv-card b { color: #5fe3ff; }
            .aim-vv-card table { border-collapse: collapse; }
            .aim-vv-card td { padding: 0 10px 0 0; white-space: nowrap; }
            .aim-vv-card .ok { color: #5fff5f; } .aim-vv-card .warn { color: #ffb347; } .aim-vv-card .bad { color: #ff5f5f; }
            .aim-vv-card .dim { color: #888; }
            .aim-vv-legend { margin-top: 0; }
            .aim-vv-ov { background: none; border: none; }
            .aim-vv-ov-nav { width: 22px; height: 22px; border-radius: 50%; color: #04222a; font: 800 10px/19px monospace; text-align: center; border: 2px solid rgba(0,0,0,.6); box-shadow: 0 1px 4px rgba(0,0,0,.5); }
            .aim-vv-ov-snap { width: 18px; height: 18px; border-radius: 3px; color: #04222a; font: 800 9px/17px monospace; text-align: center; border: 1px solid rgba(0,0,0,.6); opacity: .92; }
            .aim-vv-ov-dot { width: 10px; height: 10px; border-radius: 50%; border: 1px solid rgba(0,0,0,.6); margin: 4px; }
            .aim-vv-ov-dot--small { width: 6px; height: 6px; margin: 2px; opacity: .7; }
            .aim-vv-ov-flag { font-size: 13px; line-height: 16px; text-shadow: 0 1px 2px #000; }
            .aim-vv-ov-actual { width: 12px; height: 12px; border-radius: 50%; background: #5fe3ff; border: 2px solid #04222a; box-shadow: 0 0 0 1px #5fe3ff; }
            .aim-vv-ov-actual--retake { border-style: dashed; border-color: #fff; }
            .aim-vv-ov.aim-vv-ov--active > div { outline: 3px solid #fff; outline-offset: 1px; animation: aim-vv-pulse 1.2s ease-in-out infinite; }
            @keyframes aim-vv-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(95,227,255,.9); } 50% { box-shadow: 0 0 0 8px rgba(95,227,255,0); } }
        `;
        document.head.appendChild(styleEl);
    }

    function stripGrid() { return document.querySelector('.mp-thumbnails__grid'); }
    let activeKeys = [];   // image keys of the shot under the playhead (declared before stampStrip uses it)
    function tileImage(tile) {
        const im = tile.querySelector('img');
        if (!im || !model) return null;
        const k = imgKey(im.currentSrc || im.src);
        return model.images.find(r => r.key === k) || null;
    }
    function stripTiles(grid) {
        const items = Array.from(grid.querySelectorAll('.mp-thumbnails__item'));
        return items.length ? items : Array.from(grid.children);
    }
    // The element whose CSS `order` matters = the grid's direct child holding this tile (Percepto may wrap it).
    function orderEl(grid, tile) { let el = tile; while (el && el.parentElement !== grid) el = el.parentElement; return el || tile; }
    const badgeLossLogged = {};
    // Circuit breaker: if something re-renders the strip in a loop we must not amplify it into a frozen tab.
    const stampLog = [];
    let stampCooldownUntil = 0;
    function stampBudget() {
        const now = Date.now();
        if (now < stampCooldownUntil) return false;
        while (stampLog.length && now - stampLog[0] > 1000) stampLog.shift();
        stampLog.push(now);
        if (stampLog.length > 20) {
            stampCooldownUntil = now + 5000;
            warn('strip re-stamped ' + stampLog.length + '× in 1 s — backing off for 5 s (something re-renders the strip in a loop)');
            return false;
        }
        return true;
    }
    function stampStrip(force) {
        const grid = stripGrid();
        if (!grid || !model) return;
        const tiles = stripTiles(grid);
        // Stamp key = everything that changes what a tile should look like. Percepto re-renders
        // tiles (new elements) when you click one, so "already stamped" must be checked PER TILE.
        const stamp = model.mid + ':' + settings.stripOrder + ':' + settings.badges + ':' + model.numberingGlobal;
        // Percepto's re-render WIPES a tile's children (our badge + ▶) but keeps the element, so the
        // stamp alone is not enough — a matched tile must still hold its badge.
        const srcKeyOf = (t) => { const im = t.querySelector('img'); return im ? imgKey(im.currentSrc || im.src) : ''; };
        // Re-rendered tiles get their <img src> a moment AFTER they appear — an unmatched tile must be retried
        // once its src changes, or it sits unbadged at the front of the strip forever.
        const stale = tiles.some(t => t.dataset.aimVvStamp !== stamp
            || t.dataset.aimVvSrc !== srcKeyOf(t)
            || (settings.badges && t.dataset.aimVvKey && !t.querySelector('.aim-vv-badge')));
        if (!force && !stale) return;
        if (!stampBudget()) return;
        let matched = 0;
        tiles.forEach((tile, i) => {
            const rec = tileImage(tile);
            tile.classList.add('aim-vv-tile');
            tile.dataset.aimVvStamp = stamp;
            tile.dataset.aimVvSrc = srcKeyOf(tile);
            if (rec) tile.dataset.aimVvKey = rec.key; else delete tile.dataset.aimVvKey;
            // Order: video tile (no image record) pinned first, then shutter order (RGB, T, G within a pair).
            if (settings.stripOrder) {
                orderEl(grid, tile).style.order = rec ? String(rec.rank) : '0';
            } else {
                orderEl(grid, tile).style.order = '';
            }
            let badge = tile.querySelector('.aim-vv-badge');
            let seek = tile.querySelector('.aim-vv-seek');
            if (!rec) { if (badge) badge.remove(); if (seek) seek.remove(); return; }
            matched++;
            if (settings.badges) {
                if (!badge) { badge = document.createElement('div'); tile.appendChild(badge); }
                const num = rec.step && model.numbering[rec.step.id];
                const shot = model.shots.find(s => s.images.includes(rec));
                const label = num ? num.n : (rec.step ? rec.step.type_name.slice(0, 4) : '?');
                badge.className = 'aim-vv-badge' + (rec.kind === 'T' ? ' aim-vv-badge--t' : rec.kind === 'G' ? ' aim-vv-badge--g' : '') + (num ? '' : ' aim-vv-badge--none') + (shot && shot.retake ? ' aim-vv-badge--retake' : '');
                badge.textContent = label + ' ' + rec.kind;
                badge.title = (num ? num.n + ' · ' : '') + 'shutter ' + mmss(rec.videoOff) + (shot && shot.retake ? ' · re-take of an already-shot step' : '');
                if (!seek) {
                    seek = document.createElement('div');
                    seek.className = 'aim-vv-seek';
                    seek.textContent = '▶';
                    seek.title = 'Seek video to this shot';
                    seek.dataset.aimVvKey = rec.key;
                    tile.appendChild(seek);
                }
            } else { if (badge) badge.remove(); if (seek) seek.remove(); }
        });
        // Diagnostic: a matched tile that STILL has no badge right after stamping → Percepto's structure
        // differs from what we expect; log its DOM once per image so the next fix is not a guess.
        if (settings.badges) {
            let unmatched = 0;
            tiles.forEach(tile => {
                const k = tile.dataset.aimVvKey;
                if (k && !tile.querySelector('.aim-vv-badge') && !badgeLossLogged[k]) {
                    badgeLossLogged[k] = true;
                    warn('badge missing right after stamp on', k, '→ tile DOM:', tile.outerHTML.slice(0, 600), '| parent:', tile.parentElement && tile.parentElement.className);
                }
                if (!k) unmatched++;
            });
            if (unmatched > 1 && !badgeLossLogged.__unmatched) {   // 1 = the video tile, expected
                badgeLossLogged.__unmatched = true;
                const t = tiles.find(x => !x.dataset.aimVvKey && x !== tiles[0]);
                warn('tiles not matched to an image: ' + unmatched + ' (video tile + ' + (unmatched - 1) + ') — sample:', t ? t.outerHTML.slice(0, 500) : '');
            }
        }
        // Re-rendered tiles lost the playhead outline too — re-apply it.
        const keys = activeKeys; activeKeys = []; markActiveTiles(keys);
        // First stamp (explicit) → scroll to the start so S1 is in view.
        if (force === true) {
            const scroller = grid.closest('.mp-thumbnails') || grid;
            try { (grid.scrollWidth > grid.clientWidth ? grid : scroller).scrollLeft = 0; } catch (e) { /* cosmetic */ }
        }
        log('strip stamped' + (force === true ? '' : ' (re-render)') + ': ' + tiles.length + ' tiles, ' + matched + ' matched to images' + (settings.stripOrder ? ' (oldest first)' : ''));
    }
    function unstampStrip() {
        const grid = stripGrid();
        if (!grid) return;
        stripTiles(grid).forEach(tile => {
            orderEl(grid, tile).style.order = '';
            tile.classList.remove('aim-vv-tile', 'aim-vv-tile--active');
            tile.querySelectorAll('.aim-vv-badge, .aim-vv-seek').forEach(el => el.remove());
            delete tile.dataset.aimVvStamp; delete tile.dataset.aimVvKey; delete tile.dataset.aimVvSrc;
        });
    }

    // ---------------------------------------------------------------
    // Video: seek + playhead tracking
    // ---------------------------------------------------------------
    function videoEl() { return document.querySelector('video'); }
    function videoTile() {
        const grid = stripGrid();
        if (!grid) return null;
        return stripTiles(grid).find(t => !tileImage(t)) || grid.children[0] || null;
    }
    function seekToShot(rec, showVideo) {
        const v = videoEl();
        if (!v || !rec || rec.videoOff == null) { warn('seek: no video or no offset for', rec && rec.name); return; }
        const t = Math.max(0, rec.videoOff - (Number(settings.leadInS) || 0));
        try {
            v.currentTime = t;
            log('seek → ' + mmss(t) + ' (shot at ' + mmss(rec.videoOff) + ')');
        } catch (e) { warn('seek failed:', e); }
        if (showVideo) {
            // Percepto shows the still after a thumbnail click; clicking the video tile swaps the player back.
            const vt = videoTile();
            if (vt && !v.offsetParent) { try { vt.click(); } catch (e) { warn('video tile click failed:', e); } }
        }
        selectShot(rec);
    }
    function markActiveTiles(keys) {
        const grid = stripGrid();
        if (!grid) return;
        if (keys.join('|') === activeKeys.join('|')) return;
        activeKeys = keys;
        stripTiles(grid).forEach(tile => {
            const rec = tileImage(tile);
            tile.classList.toggle('aim-vv-tile--active', !!(rec && keys.includes(rec.key)));
        });
    }
    let hookedVideo = null;
    function hookVideo() {
        const v = videoEl();
        if (!v || v === hookedVideo) return;
        hookedVideo = v;
        v.addEventListener('timeupdate', onTimeUpdate);
        log('video hooked (duration ' + mmss(v.duration) + ')');
    }
    let lastPlayheadShot = null;
    function onTimeUpdate() {
        if (!model || !settings.master) return;
        const v = hookedVideo; if (!v) return;
        const t = v.currentTime;
        let best = null, bestD = Infinity;
        model.shots.forEach(sh => { if (sh.videoOff == null) return; const d = Math.abs(sh.videoOff - t); if (d < bestD) { bestD = d; best = sh; } });
        // "Current" = the shot whose shutter is within the window, preferring the most recent one already taken.
        let current = null;
        model.shots.forEach(sh => { if (sh.videoOff != null && sh.videoOff <= t + 1.5 && t - sh.videoOff <= SHOT_MATCH_WINDOW_S) current = sh; });
        if (!current && best && bestD <= 1.5) current = best;
        markActiveTiles(current ? current.images.map(i => i.key) : []);
        if (current !== lastPlayheadShot) {
            lastPlayheadShot = current;
            if (current) { renderCard(current.primary, 'playhead'); if (!v.paused) scrollTileIntoView(current.primary); }
            markActiveOverlay();
        }
    }
    function scrollTileIntoView(rec) {
        const grid = stripGrid(); if (!grid) return;
        const tile = stripTiles(grid).find(t => tileImage(t) === rec);
        if (tile) { try { tile.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* cosmetic */ } }
    }
    function stepShot(dir) {
        if (!model || !model.shots.length) return;
        const v = videoEl(); const t = v ? v.currentTime : 0;
        const offs = model.shots.filter(s => s.videoOff != null);
        let target = null;
        if (dir > 0) target = offs.find(s => s.videoOff > t + 0.5);
        else { for (const s of offs) { if (s.videoOff < t - (Number(settings.leadInS) || 0) - 0.5) target = s; } }
        if (!target) { log('no ' + (dir > 0 ? 'next' : 'previous') + ' shot'); return; }
        seekToShot(target.primary, true);
        scrollTileIntoView(target.primary);
    }

    // ---------------------------------------------------------------
    // Still viewer (Percepto shows the clicked image in .mp-media): its ‹ › arrows and the
    // "8 / 14" counter walk Percepto's newest-first list. We redirect both to OUR order.
    // ---------------------------------------------------------------
    function stillImg() { return document.querySelector('.mp-media__image'); }
    function currentStillRec() {
        const im = stillImg();
        if (!im || !model) return null;
        const k = imgKey(im.currentSrc || im.src);
        return model.images.find(r => r.key === k) || null;
    }
    function tileFor(rec) {
        const grid = stripGrid(); if (!grid || !rec) return null;
        return stripTiles(grid).find(t => t.dataset.aimVvKey === rec.key || tileImage(t) === rec) || null;
    }
    function showStill(rec) {
        const t = tileFor(rec);
        if (!t) { warn('no tile for', rec && rec.name); return; }
        try { t.click(); } catch (e) { warn('tile click failed:', e); }   // onGridClick handles seek/select
        setTimeout(() => { try { fixCounter(); ensureNavButtons(); } catch (e) { warn('nav refresh:', e); } }, 60);
        try { t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* cosmetic */ }
    }
    function stepStill(dir) {
        const cur = currentStillRec();
        if (!cur) return false;
        const next = model.images.find(r => r.rank === cur.rank + dir);
        if (!next) { log('no ' + (dir > 0 ? 'next' : 'previous') + ' image'); return true; }
        showStill(next);
        return true;
    }
    function fixCounter() {
        const cur = currentStillRec();
        if (!cur || !settings.stripOrder) return;
        const c = document.querySelector('.mp-media__counter');
        if (c) {
            const want = cur.rank + ' / ' + model.images.length;
            if (c.textContent.trim() !== want) { c.textContent = want; c.title = 'AIM order (oldest first)'; }
        }
    }
    // Our own ‹ › buttons in the still viewer. Percepto hides/disables its arrow at ITS list end (newest-first),
    // and fighting React for its `disabled` state is a loop waiting to happen — so we add our own pair that
    // always exists and walks OUR order. Percepto's arrows are still redirected when they are clickable.
    let navBtnEls = null;
    function ensureNavButtons() {
        const media = document.querySelector('.mp-media');
        const wantOn = !!(model && settings.master && settings.stripOrder && media && stillImg());
        document.documentElement.classList.toggle('aim-vv-own-nav', wantOn);
        if (!wantOn) { if (navBtnEls) { navBtnEls.forEach(b => { try { b.remove(); } catch (e) {} }); navBtnEls = null; } return; }
        if (navBtnEls && navBtnEls.every(b => media.contains(b))) { updateNavButtons(); return; }
        if (navBtnEls) navBtnEls.forEach(b => { try { b.remove(); } catch (e) {} });
        navBtnEls = [-1, 1].map(dir => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'aim-vv-nav aim-vv-nav--' + (dir < 0 ? 'prev' : 'next');
            b.dataset.aimVvDir = String(dir);
            b.innerHTML = dir < 0 ? '&#8249;' : '&#8250;';
            b.title = (dir < 0 ? 'Previous' : 'Next') + ' image (flight order)';
            media.appendChild(b);
            return b;
        });
        updateNavButtons();
    }
    function updateNavButtons() {
        if (!navBtnEls) return;
        const cur = currentStillRec();
        const n = model ? model.images.length : 0;
        navBtnEls.forEach(b => {
            const dir = Number(b.dataset.aimVvDir);
            const off = !cur || (dir < 0 ? cur.rank <= 1 : cur.rank >= n);
            if (b.classList.contains('aim-vv-nav--off') !== off) b.classList.toggle('aim-vv-nav--off', off);
        });
    }
    function onOurNavClick(e) {
        const b = e.target.closest && e.target.closest('.aim-vv-nav');
        if (!b || !model) return;
        e.preventDefault(); e.stopPropagation();
        if (b.classList.contains('aim-vv-nav--off')) return;
        stepStill(Number(b.dataset.aimVvDir));
    }
    // Percepto's ‹ › buttons: decide direction by position (left/right of the media pane),
    // swallow the native handler, step in our order instead.
    function onNavArrowClick(e) {
        if (!model || !settings.master || !settings.stripOrder) return;
        const btn = e.target.closest && e.target.closest('.pr-image-nav-btn');
        if (!btn) return;
        const media = btn.closest('.mp-media') || document.querySelector('.mp-media');
        if (!media) return;
        const r = btn.getBoundingClientRect(), m = media.getBoundingClientRect();
        const dir = (r.left + r.width / 2) < (m.left + m.width / 2) ? -1 : 1;
        e.preventDefault(); e.stopPropagation();
        if (!stepStill(dir)) log('arrow: no current still — ignored');
    }

    // ---------------------------------------------------------------
    // Shot card
    // ---------------------------------------------------------------
    let cardEl = null;
    let selectedRec = null;
    function ensureCard() {
        if (!settings.shotCard) { if (cardEl) { cardEl.remove(); cardEl = null; } return null; }
        const host = document.querySelector('.mp-thumbnails');
        if (!host) return null;
        if (cardEl && host.parentElement && host.parentElement.contains(cardEl)) return cardEl;
        cardEl = document.createElement('div');
        cardEl.className = 'aim-vv-card';
        cardEl.innerHTML = '<span class="dim">Video Validation — click a snapshot (or play) to see planned vs actual.</span>';
        host.insertAdjacentElement('afterend', cardEl);
        return cardEl;
    }
    function selectShot(rec) { selectedRec = rec; renderCard(rec, 'selected'); markActiveOverlay(); }
    function cls(v, warnAt, badAt) { if (v == null) return 'dim'; const a = Math.abs(v); return a >= badAt ? 'bad' : a >= warnAt ? 'warn' : 'ok'; }
    function renderCard(rec, why) {
        const el = ensureCard();
        if (!el || !rec || !model) return;
        if (why === 'playhead' && selectedRec && selectedRec !== rec && (videoEl() && videoEl().paused)) return; // don't fight a manual selection while paused
        const step = rec.step, d = rec.delta || {}, pose = d.pose;
        const num = step && model.numbering[step.id];
        const shot = model.shots.find(s => s.images.includes(rec));
        const kinds = shot ? shot.images.map(i => i.kind).join('+') : rec.kind;
        const assets = (rec.assets || []).map(a => a.name).filter(Boolean);
        let head = '<b>' + esc(num ? num.n : (step ? step.type_name : 'no step')) + '</b>'
            + (step ? ' <span class="dim">step #' + step.index_in_app + (model.numberingGlobal ? ' (whole mission)' : ' · this flight') + '</span>' : ' <span class="bad">no plan step active at shutter</span>')
            + ' · ' + esc(kinds) + ' · shutter <b>' + mmss(rec.videoOff) + '</b>'
            + (shot && shot.retake ? ' · <span class="warn">re-take</span>' : '')
            + (assets.length ? ' · ' + esc(assets.join(', ')) : ' · <span class="dim">no asset in frame</span>');
        let rows = '';
        if (pose) {
            const fx = rec.fix;
            rows = '<table>'
                + '<tr><td class="dim"></td><td class="dim">planned</td><td class="dim">actual</td><td class="dim">Δ</td></tr>'
                + '<tr><td>heading</td><td>' + (pose.heading != null ? pose.heading.toFixed(0) + '°' : '–') + '</td><td>' + (rec.drone_heading != null ? rec.drone_heading + '°' : '–') + '</td><td class="' + cls(d.hdg, 5, 15) + '">' + signed(d.hdg, '°') + '</td></tr>'
                + '<tr><td>camera angle</td><td>' + (pose.pitchDeg != null ? pose.pitchDeg.toFixed(0) + '°' : '–') + '</td><td>' + (rec.camera_pitch != null ? rec.camera_pitch + '°' : '–') + '</td><td class="' + cls(d.pitch, 3, 8) + '">' + signed(d.pitch, '°') + '</td></tr>'
                + '<tr><td>drone alt</td><td>' + fmtAlt(pose.alt) + '</td><td>' + fmtAlt(rec.alt) + '</td><td class="' + cls(d.alt != null ? d.alt * (settings.units === 'm' ? 1 : M_TO_FT) : null, 10, 25) + '">' + (d.alt != null ? signed(d.alt * (settings.units === 'm' ? 1 : M_TO_FT), settings.units === 'm' ? ' m' : ' ft') : '–') + '</td></tr>'
                + '<tr><td>drone vs nav</td><td colspan="2" class="dim">' + (pose.nav ? esc((model.numbering[pose.nav.id] || {}).n || 'nav #' + pose.nav.index_in_app) : '–') + '</td><td class="' + cls(d.pos != null ? d.pos * M_TO_FT : null, 10, 30) + '">' + fmtDist(d.pos) + '</td></tr>'
                + (pose.type === 'gps' ? '<tr><td>aim point</td><td colspan="3" class="dim">GPS snapshot · target alt ' + fmtAlt(pose.aimAlt) + ' · range ' + fmtDist(pose.range) + '</td></tr>' : '<tr><td>type</td><td colspan="3" class="dim">in-place snapshot (heading + camera angle at the nav)</td></tr>')
                + (fx ? '<tr><td class="dim">flown fix</td><td colspan="3" class="dim">' + (fx.velocity != null ? (fx.velocity / 1000 * 2.23694).toFixed(0) + ' mph · ' : '') + 'battery ' + fx.battery + '% · ' + Math.abs(fx._t - rec.shutter) + ' ms from shutter</td></tr>' : '')
                + '</table>';
        } else if (d.notSnap) {
            rows = '<div class="warn">Active step at shutter was <b>' + esc(d.stepType) + '</b>, not a snapshot — likely a pilot manual shot.</div>'
                + '<div class="dim">actual: heading ' + rec.drone_heading + '° · camera ' + rec.camera_pitch + '° · alt ' + fmtAlt(rec.alt) + '</div>';
        } else {
            rows = '<div class="dim">actual: heading ' + rec.drone_heading + '° · camera ' + rec.camera_pitch + '° · alt ' + fmtAlt(rec.alt) + '</div>';
        }
        const prev = rec.previous_image && rec.previous_image.name ? '<span class="dim">previous capture: ' + esc(rec.previous_image.name.replace(/__\d+_.*$/, '').replace(/_/g, ' ').replace(/  /g, ' ')) + '</span>' : '<span class="dim">no previous capture linked</span>';
        el.innerHTML = head + rows + '<div style="margin-top:3px;">' + prev + ' · <span class="dim">[ / ] prev / next shot</span></div>';
    }

    // ---------------------------------------------------------------
    // Events: tile clicks (delegated, capture) + ▶
    // ---------------------------------------------------------------
    function onGridClick(e) {
        if (!model || !settings.master) return;
        if (e.target.closest && e.target.closest('.aim-vv-nav')) { onOurNavClick(e); return; }
        if (e.target.closest && e.target.closest('.pr-image-nav-btn')) { onNavArrowClick(e); return; }
        const grid = stripGrid(); if (!grid || !grid.contains(e.target)) return;
        const seek = e.target.closest('.aim-vv-seek');
        if (seek) {
            e.preventDefault(); e.stopPropagation();
            const rec = model.images.find(r => r.key === seek.dataset.aimVvKey);
            if (rec) { seekToShot(rec, true); }
            return;
        }
        const tile = e.target.closest('.mp-thumbnails__item');
        if (!tile) return;
        const rec = tileImage(tile);
        if (!rec) return;   // video tile — let Percepto handle it
        // Let Percepto show the still first; then seek the (still-alive) video so ▶ resumes at the shot.
        setTimeout(() => { if (settings.clickSeek) seekToShot(rec, false); else selectShot(rec); }, 0);
    }


    // ---------------------------------------------------------------
    // Map overlay — plan steps (N#/S#) + actual shot poses on the playback Leaflet map.
    // Raw Leaflet only (react-leaflet map): own L.svg() renderer, explicitly added + primed.
    // ---------------------------------------------------------------
    const ov = { map: null, L: null, svg: null, layers: [], stepMarkers: {}, shotMarkers: {}, group: null, groupLoading: false };
    const FLIGHT_COLORS = ['#ff7ad9', '#ffb347', '#b0ff5f', '#5fa8ff', '#ff5f5f', '#c77dff', '#ffe95f', '#5fe3ff'];
    const COLOR_NAV = '#5fa8ff', COLOR_SNAP = '#ff7ad9', COLOR_ACTUAL = '#5fe3ff', COLOR_OTHER = '#8a8f99';

    function looksLikeLeafletMap(v) {
        return !!v && typeof v === 'object' && typeof v.latLngToLayerPoint === 'function' && typeof v.latLngToContainerPoint === 'function'
            && typeof v.layerPointToLatLng === 'function' && typeof v.distance === 'function' && typeof v.getContainer === 'function';
    }
    function findMap() {
        if (ov.map && ov.map._container && document.body.contains(ov.map._container)) return ov.map;
        ov.map = null;
        const containers = document.querySelectorAll('.leaflet-container');
        for (const c of containers) {
            const hints = [c.__aim_map__, c._leaflet_map, c._leaflet];
            for (const h of hints) if (looksLikeLeafletMap(h)) { ov.map = h; return h; }
            try { for (const k of Object.getOwnPropertyNames(c)) { const v = c[k]; if (looksLikeLeafletMap(v)) { ov.map = v; return v; } } } catch (e) { /* keep looking */ }
        }
        return null;
    }
    function getL() { const L = pageWin.L || window.L; return (L && typeof L.polyline === 'function' && typeof L.marker === 'function') ? L : null; }
    function ensureSvg(L, map) {
        if (ov.svg && ov.svg._map === map) return ov.svg;
        try { ov.svg = L.svg({ pane: 'overlayPane' }); ov.svg.addTo(map); if (typeof ov.svg._update === 'function') ov.svg._update(); }
        catch (e) { warn('svg renderer failed:', e); ov.svg = null; }
        return ov.svg;
    }
    function offsetLatLng(ll, meters, headingDeg) {
        const dN = meters * Math.cos(headingDeg * RAD), dE = meters * Math.sin(headingDeg * RAD);
        return [ll.lat + dN / 111320, ll.lng + dE / (111320 * Math.cos(ll.lat * RAD))];
    }
    function clearOverlay() {
        const map = ov.map;
        ov.layers.forEach(l => { try { if (map) map.removeLayer(l); } catch (e) { /* already gone */ } });
        ov.layers = []; ov.stepMarkers = {}; ov.shotMarkers = {};
    }
    function addLayer(map, layer) {
        try { layer.addTo(map); ov.layers.push(layer); return layer; }
        catch (e) { warn('overlay layer failed:', e); try { map.removeLayer(layer); } catch (e2) { /* detached */ } return null; }
    }
    // Which flight of the group flew a plan index (group toggle): returns {mid, color, i} or null.
    function flightForIdx(idx) {
        if (!ov.group) return null;
        for (const g of ov.group) if (g.minIdx != null && idx >= g.minIdx && idx <= g.maxIdx) return g;
        return null;
    }
    function drawOverlay() {
        clearOverlay();
        if (!model || !settings.master || !settings.overlay) return;
        const L = getL(), map = findMap();
        if (!L || !map) { if (!ov.warned) { ov.warned = true; warn('overlay: Leaflet map not found yet (L=' + !!L + ')'); } return; }
        ov.warned = false;
        const svg = ensureSvg(L, map);
        const lineOpts = (o) => Object.assign({ interactive: false }, svg ? { renderer: svg } : {}, o);
        const groupOn = !!(settings.overlayGroup && ov.group);
        const inSlice = (st) => groupOn || !model.slice || (st.index_in_app >= model.slice.minIdx && st.index_in_app <= model.slice.maxIdx);
        const steps = model.plan.filter(st => inSlice(st) && (st.type_name === 'navigate' || st.type_name === 'snapshot' || st.type_name === 'flag pole'));
        const colorFor = (st, base) => { if (!groupOn) return base; const g = flightForIdx(st.index_in_app); return g ? g.color : COLOR_OTHER; };
        // Whole-mission view is dense (800+ steps): un-flown steps become small grey dots, and flown steps
        // only get N#/S# labels when zoomed in close. Redrawn on zoomend when the threshold flips.
        const zoom = (typeof map.getZoom === 'function') ? map.getZoom() : 18;
        const dense = groupOn && steps.length > 120;
        ov.labelZoomGate = dense ? (zoom >= 17) : true;
        const showLabel = (st) => settings.overlayLabels && (!dense || (ov.labelZoomGate && !!flightForIdx(st.index_in_app)));
        const unflown = (st) => groupOn && !flightForIdx(st.index_in_app);

        // Flight line nav→nav (dashed) + sightlines nav→aim point for GPS snapshots + heading ticks for in-place ones.
        let curNav = null; const navPts = [];
        steps.forEach(st => {
            if (st.type_name === 'navigate' && st.location) { curNav = st; navPts.push([st.location.lat, st.location.lng]); }
        });
        if (navPts.length >= 2) addLayer(map, L.polyline(navPts, lineOpts({ color: COLOR_NAV, weight: 2, opacity: 0.6, dashArray: '6,8' })));
        let nav = null;
        steps.forEach(st => {
            if (st.type_name === 'navigate') { nav = st; return; }
            if (st.type_name !== 'snapshot' || !nav || !nav.location) return;
            if (dense && unflown(st)) return;
            const col = colorFor(st, COLOR_SNAP);
            if (st.location && typeof st.location.lat === 'number') {
                addLayer(map, L.polyline([[nav.location.lat, nav.location.lng], [st.location.lat, st.location.lng]], lineOpts({ color: col, weight: 2, opacity: 0.75, dashArray: '3,5' })));
            } else {
                const eo = st.extra_options || {};
                if (typeof eo.heading === 'number') addLayer(map, L.polyline([[nav.location.lat, nav.location.lng], offsetLatLng(nav.location, 18, eo.heading)], lineOpts({ color: col, weight: 3, opacity: 0.9 })));
            }
        });

        // Markers with N#/S# labels.
        let inplaceCount = {};
        nav = null;
        steps.forEach(st => {
            const num = model.numbering[st.id];
            let ll = null, html = null, size = 0, anchor = null, col = null;
            if (st.type_name === 'navigate') {
                nav = st; if (!st.location) return;
                col = colorFor(st, COLOR_NAV); ll = [st.location.lat, st.location.lng]; size = 22;
                html = '<div class="aim-vv-ov-nav" style="background:' + col + '">' + esc(num ? num.n : 'N') + '</div>';
            } else if (st.type_name === 'snapshot') {
                col = colorFor(st, COLOR_SNAP); size = 18;
                if (st.location && typeof st.location.lat === 'number') {
                    ll = [st.location.lat, st.location.lng];
                } else if (nav && nav.location) {
                    // In-place: sit at the nav, pushed ~22 px out along its heading so several snaps on one nav don't stack.
                    const eo = st.extra_options || {}; const h = typeof eo.heading === 'number' ? eo.heading : (inplaceCount[nav.id] = (inplaceCount[nav.id] || 0) + 1) * 45;
                    ll = [nav.location.lat, nav.location.lng];
                    anchor = [size / 2 - 22 * Math.sin(h * RAD), size / 2 + 22 * Math.cos(h * RAD)];
                } else return;
                html = '<div class="aim-vv-ov-snap" style="background:' + col + '">' + esc(num ? num.n : 'S') + '</div>';
            } else if (st.type_name === 'flag pole' && st.location) {
                ll = [st.location.lat, st.location.lng]; size = 16; html = '<div class="aim-vv-ov-flag">🚩</div>';
            } else return;
            if (st.type_name !== 'flag pole') {
                if (unflown(st)) { html = '<div class="aim-vv-ov-dot aim-vv-ov-dot--small" style="background:' + COLOR_OTHER + '"></div>'; size = 10; anchor = null; }
                else if (!showLabel(st)) { html = '<div class="aim-vv-ov-dot" style="background:' + col + '"></div>'; }
            }
            try {
                const icon = L.divIcon({ className: 'aim-vv-ov', html, iconSize: [size, size], iconAnchor: anchor || [size / 2, size / 2] });
                const mk = L.marker(ll, { icon, interactive: true, zIndexOffset: 500 });
                if (!addLayer(map, mk)) return;
                ov.stepMarkers[st.id] = mk;
                const shots = model.shots.filter(sh => sh.step && sh.step.id === st.id);
                const g = groupOn ? flightForIdx(st.index_in_app) : null;
                const tip = '<b>' + esc(num ? num.n : st.type_name) + '</b> · step #' + st.index_in_app
                    + (g ? ' · flight ' + esc(g.label) : '')
                    + (st.type_name === 'snapshot' ? (st.location ? ' · GPS aim point' : ' · in-place ' + ((st.extra_options || {}).heading != null ? st.extra_options.heading + '°' : '')) : '')
                    + (shots.length ? ' · shot at ' + shots.map(sh => mmss(sh.videoOff)).join(', ') : (st.type_name === 'snapshot' && !groupOn ? ' · <i>no image</i>' : ''));
                mk.bindTooltip(tip, { direction: 'top', offset: [0, -10], opacity: 0.95 });
                if (shots.length) mk.on('click', () => { const sh = shots[0]; seekToShot(sh.primary, true); scrollTileIntoView(sh.primary); });
            } catch (e) { warn('overlay marker failed:', e); }
        });

        // Actual shot poses from the image records: drone dot + heading tick + ground footprint.
        if (settings.overlayActual) {
            model.shots.forEach(sh => {
                const im = sh.primary; if (!im || !im.location) return;
                const num = sh.step && model.numbering[sh.step.id];
                if (Array.isArray(im.fov_polygon) && im.fov_polygon.length >= 3) {
                    addLayer(map, L.polygon(im.fov_polygon.map(p => [p.lat, p.lng]), lineOpts({ color: COLOR_ACTUAL, weight: 1.5, opacity: 0.8, fillColor: COLOR_ACTUAL, fillOpacity: 0.08 })));
                }
                if (typeof im.drone_heading === 'number') addLayer(map, L.polyline([[im.location.lat, im.location.lng], offsetLatLng(im.location, 14, im.drone_heading)], lineOpts({ color: COLOR_ACTUAL, weight: 2, opacity: 0.9 })));
                try {
                    const icon = L.divIcon({ className: 'aim-vv-ov', html: '<div class="aim-vv-ov-actual' + (sh.retake ? ' aim-vv-ov-actual--retake' : '') + '"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
                    const mk = L.marker([im.location.lat, im.location.lng], { icon, interactive: true, zIndexOffset: 600 });
                    if (!addLayer(map, mk)) return;
                    ov.shotMarkers[im.key] = mk;
                    const d = sh.delta || {};
                    mk.bindTooltip('<b>actual</b> ' + esc(num ? num.n : '?') + ' · ' + mmss(sh.videoOff) + ' · hdg ' + im.drone_heading + '° · cam ' + im.camera_pitch + '° · ' + fmtAlt(im.alt)
                        + (d.hdg != null ? ' · Δhdg ' + signed(d.hdg, '°') : '') + (d.pitch != null ? ' · Δcam ' + signed(d.pitch, '°') : '') + (sh.retake ? ' · re-take' : ''), { direction: 'top', offset: [0, -8], opacity: 0.95 });
                    mk.on('click', () => { seekToShot(im, true); scrollTileIntoView(im); });
                } catch (e) { warn('overlay actual marker failed:', e); }
            });
        }
        if (!ov.zoomHooked || ov.zoomHookedMap !== map) {
            try { map.on('zoomend', onOverlayZoom); ov.zoomHooked = true; ov.zoomHookedMap = map; } catch (e) { warn('zoomend hook failed:', e); }
        }
        activeOverlayKey = undefined;   // markers are new — force the active highlight to re-apply
        log('overlay drawn: ' + steps.length + ' plan steps' + (groupOn ? ' (whole mission, ' + ov.group.length + ' flights)' : ' (this flight)') + ', ' + Object.keys(ov.shotMarkers).length + ' actual shots, ' + ov.layers.length + ' layers');
        markActiveOverlay();
    }
    function onOverlayZoom() {
        if (!model || !ov.layers.length) return;
        const groupOn = !!(settings.overlayGroup && ov.group);
        if (!groupOn) return;
        const gate = (ov.map && typeof ov.map.getZoom === 'function' ? ov.map.getZoom() : 18) >= 17;
        if (gate !== ov.labelZoomGate) drawOverlay();
    }
    let activeOverlayKey = null;
    function markActiveOverlay() {
        if (!model) return;
        const sh = lastPlayheadShot || (selectedRec && model.shots.find(x => x.images.includes(selectedRec))) || null;
        const key = sh ? (sh.primary.key + '|' + (sh.step ? sh.step.id : '')) : null;
        if (key === activeOverlayKey && ov.layers.length) return;
        activeOverlayKey = key;
        const setActive = (mk, on) => { const el = mk && mk._icon; if (el) el.classList.toggle('aim-vv-ov--active', !!on); };
        Object.values(ov.stepMarkers).forEach(mk => setActive(mk, false));
        Object.values(ov.shotMarkers).forEach(mk => setActive(mk, false));
        if (sh) { if (sh.step) setActive(ov.stepMarkers[sh.step.id], true); setActive(ov.shotMarkers[sh.primary.key], true); }
    }
    // Group: every flight of this mission group → its plan index range (one positions fetch per flight, cached per tab).
    const groupCache = {};
    function loadGroup() {
        if (!model || ov.groupLoading) return;
        const others = (model.mission.attached_missions || []).map(Number).filter(x => x && String(x) !== String(model.mid));
        ov.groupLoading = true;
        const entries = [{ mid: Number(model.mid), minIdx: model.slice && model.slice.minIdx, maxIdx: model.slice && model.slice.maxIdx, first: model.fixes.length ? model.fixes[0]._t : 0, self: true }];
        const chain = others.reduce((p, mid) => p.then(() => {
            if (groupCache[mid]) { entries.push(groupCache[mid]); return; }
            return getJSON('/mission_positions/' + mid + '/').then(j => {
                const Q = j.positions || [];
                const idx = Q.filter(f => f.app_instruction != null).map(f => { const id = typeof f.app_instruction === 'object' ? f.app_instruction.id : f.app_instruction; return model.byId[id] ? model.byId[id].index_in_app : null; }).filter(x => x != null);
                const first = Q.length ? Math.min.apply(null, Q.map(f => new Date(f.timestamp).getTime())) : 0;
                const e = { mid, minIdx: idx.length ? Math.min.apply(null, idx) : null, maxIdx: idx.length ? Math.max.apply(null, idx) : null, first, fixes: Q.length };
                groupCache[mid] = e; entries.push(e);
                log('group flight ' + mid + ': steps ' + (e.minIdx != null ? e.minIdx + '–' + e.maxIdx : 'none in this plan') + ' (' + Q.length + ' fixes)');
            }).catch(e => { warn('group flight ' + mid + ' failed:', e.message); entries.push({ mid, minIdx: null, maxIdx: null, first: 0, error: e.message }); });
        }), Promise.resolve());
        chain.then(() => {
            entries.sort((a, b) => (a.first || 0) - (b.first || 0));
            entries.forEach((e, i) => { e.i = i + 1; e.color = FLIGHT_COLORS[i % FLIGHT_COLORS.length]; e.label = '#' + e.i + ' ' + e.mid + (e.self ? ' (this)' : ''); });
            ov.group = entries; ov.groupLoading = false;
            computeNumbering(model, true);
            stampStrip(true); drawOverlay(); renderLegend();
            if (selectedRec) renderCard(selectedRec, 'selected');
            log('group ready: ' + entries.map(e => e.label + ' ' + (e.minIdx != null ? e.minIdx + '–' + e.maxIdx : '∅')).join(' · '));
        });
    }
    function setGroupMode(on) {
        if (!model) return;
        if (on) { if (ov.group) { computeNumbering(model, true); stampStrip(true); drawOverlay(); renderLegend(); } else loadGroup(); }
        else { computeNumbering(model, false); stampStrip(true); drawOverlay(); renderLegend(); if (selectedRec) renderCard(selectedRec, 'selected'); }
    }
    // Flight legend / picker under the shot card: every flight of the group, click = open in a new tab.
    let legendEl = null;
    function renderLegend() {
        const card = ensureCard();
        if (!card) return;
        if (legendEl && !card.parentElement.contains(legendEl)) legendEl = null;
        if (!legendEl) { legendEl = document.createElement('div'); legendEl.className = 'aim-vv-card aim-vv-legend'; card.insertAdjacentElement('afterend', legendEl); }
        const others = (model.mission.attached_missions || []).length;
        let html;
        if (!ov.group) {
            html = '<span class="dim">Mission group ' + esc(model.mission.mission_group_id) + ' · this flight + ' + others + ' other' + (others === 1 ? '' : 's') + ' · </span>'
                + '<a href="#" data-aim-vv="load-group" style="color:#5fe3ff">' + (ov.groupLoading ? 'loading flights…' : 'show all flights (whole-mission numbering)') + '</a>';
        } else html = '<span class="dim">flights: </span>' + ov.group.map(g =>
            '<a href="#" data-aim-vv="open-flight" data-mid="' + g.mid + '" title="open in a new tab" style="color:' + g.color + ';margin-right:10px;text-decoration:none">● ' + esc(g.label) + ' <span class="dim">' + (g.minIdx != null ? 'steps ' + g.minIdx + '–' + g.maxIdx : (g.error ? 'error' : 'no steps')) + '</span></a>').join('')
            + ' · <a href="#" data-aim-vv="toggle-group" style="color:#5fe3ff">' + (settings.overlayGroup ? 'this flight only' : 'whole mission') + '</a>'
            + (settings.overlayGroup ? ' <span class="dim">· grey dots = not flown by any flight in this group yet · labels appear when zoomed in</span>' : '');
        if (legendEl.innerHTML !== html) legendEl.innerHTML = html;   // called every tick — only touch the DOM on change
    }
    function onLegendClick(e) {
        const a = e.target.closest && e.target.closest('[data-aim-vv]');
        if (!a || !model) return;
        e.preventDefault(); e.stopPropagation();
        const what = a.dataset.aimVv;
        if (what === 'load-group') { settings.overlayGroup = true; saveSettings(); loadGroup(); renderLegend(); }
        else if (what === 'toggle-group') { settings.overlayGroup = !settings.overlayGroup; saveSettings(); setGroupMode(settings.overlayGroup); }
        else if (what === 'open-flight') {
            const url = location.origin + '/#/site/' + model.sid + '/control-panel/past-mission/' + a.dataset.mid;
            try { pageWin.top.open(url, '_blank'); } catch (err) { window.open(url, '_blank'); }
        }
    }
    // ---------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------
    let current = null;            // { sid, mid }
    let observer = null;
    let tickTimer = null;
    let stampTimer = null;

    function scheduleStamp(ms) {
        if (stampTimer) return;
        stampTimer = setTimeout(() => { stampTimer = null; try { stampStrip(false); fixCounter(); ensureNavButtons(); } catch (e) { warn('stamp failed:', e); } }, ms || 150);
    }

    function activate(ids) {
        current = ids;
        model = null;
        ensureCSS();
        loading = loadModel(ids.sid, ids.mid).then(m => {
            if (!current || current.mid !== ids.mid) return;   // navigated away while loading
            model = m;
            if (settings.overlayGroup) computeNumbering(m, false);   // numbering goes global once the group loads
            stampStrip(true);
            hookVideo();
            ensureCard();
            renderLegend();
            drawOverlay();
            if (settings.overlayGroup) loadGroup();
            if (!observer) {
                observer = new MutationObserver((muts) => {
                    if (!model) return;
                    // Ignore our own writes (badges, ▶, nav buttons, card) — reacting to them is how loops start.
                    const ours = (n) => n && n.nodeType === 1 && (n.className || '').toString().indexOf('aim-vv') === 0;
                    const hot = muts.some(mu => {
                        const t = mu.target;
                        if (!t || !t.closest) return false;
                        if (t.closest('.aim-vv-card, .aim-vv-legend')) return false;
                        if (mu.type === 'childList' && Array.from(mu.addedNodes).concat(Array.from(mu.removedNodes)).every(ours) && (mu.addedNodes.length || mu.removedNodes.length)) return false;
                        return !!t.closest('.mp-thumbnails, .mp-media');
                    });
                    scheduleStamp(hot ? 30 : 150);   // always deferred — never mutate the DOM inside an observer callback
                });
                observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
            }
            log('ready v' + SCRIPT_VERSION + ' — mission ' + ids.mid);
        }).catch(e => { warn('load failed:', e); loading = null; });
    }
    function deactivate() {
        current = null; model = null; loading = null;
        try { unstampStrip(); } catch (e) { warn('unstamp failed:', e); }
        try { clearOverlay(); } catch (e) { warn('overlay clear failed:', e); }
        try { if (ov.zoomHooked && ov.zoomHookedMap) ov.zoomHookedMap.off('zoomend', onOverlayZoom); } catch (e) { /* map gone */ }
        ov.zoomHooked = false; ov.zoomHookedMap = null;
        ov.group = null; ov.groupLoading = false; ov.map = null; ov.svg = null; activeOverlayKey = null;
        if (legendEl) { try { legendEl.remove(); } catch (e) {} legendEl = null; }
        if (navBtnEls) { navBtnEls.forEach(b => { try { b.remove(); } catch (e) {} }); navBtnEls = null; }
        document.documentElement.classList.remove('aim-vv-own-nav');
        if (cardEl) { try { cardEl.remove(); } catch (e) {} cardEl = null; }
        if (hookedVideo) { try { hookedVideo.removeEventListener('timeupdate', onTimeUpdate); } catch (e) {} hookedVideo = null; }
        selectedRec = null; lastPlayheadShot = null; activeKeys = [];
    }
    function tick() {
        if (!settings.master) { if (current) { log('disabled — tearing down'); deactivate(); } return; }
        const ids = routeIds();
        const root = playbackRoot();
        if (!ids || !root) { if (current) { log('left playback — tearing down'); deactivate(); } return; }
        if (!current || current.mid !== ids.mid) { if (current) deactivate(); activate(ids); return; }
        if (model) {
            hookVideo(); scheduleStamp(); ensureCard(); renderLegend();
            try { fixCounter(); ensureNavButtons(); } catch (e) { warn('counter/nav:', e); }
            if (settings.overlay && !ov.layers.length) drawOverlay();          // map appeared after load
            else if (ov.map && ov.map._container && !document.body.contains(ov.map._container)) drawOverlay();   // map rebuilt
            markActiveOverlay();
        }
    }

    // ---------------------------------------------------------------
    // Control Panel
    // ---------------------------------------------------------------
    let controlChannel = null;
    let controlPanelDetected = false;
    function applyToggle(id, val) {
        const map = { 'master': 'master', 'strip-order': 'stripOrder', 'badges': 'badges', 'click-seek': 'clickSeek', 'lead-in': 'leadInS', 'shot-card': 'shotCard', 'units': 'units',
            'overlay': 'overlay', 'overlay-actual': 'overlayActual', 'overlay-labels': 'overlayLabels', 'overlay-group': 'overlayGroup' };
        const key = map[id]; if (!key) return;
        let v = val;
        if (key === 'leadInS') { v = parseFloat(val); if (!isFinite(v) || v < 0 || v > 60) return; }
        else if (key === 'units') { v = (val === 'm') ? 'm' : 'ft'; }
        else v = !!val;
        if (settings[key] === v) return;   // idempotent — CP echoes from both frames
        settings[key] = v; saveSettings();
        log(id + ' = ' + JSON.stringify(v));
        if (!IS_TOP && model) {
            if (key === 'stripOrder' || key === 'badges') stampStrip(true);
            if (key === 'shotCard') { ensureCard(); if (selectedRec) renderCard(selectedRec, 'selected'); }
            if (key === 'units' && selectedRec) renderCard(selectedRec, 'selected');
            if (key === 'overlay' || key === 'overlayActual' || key === 'overlayLabels') drawOverlay();
            if (key === 'overlayGroup') setGroupMode(v);
        }
    }
    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { warn('no BroadcastChannel:', e); return; }
        controlChannel.onmessage = function(ev) {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') { controlPanelDetected = true; registerWithControlPanel(); }
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                controlPanelDetected = true;
                applyToggle(msg.toggleId, msg.value !== undefined ? msg.value : msg.enabled);
            }
            else if ((msg.type === 'HOTKEY_FIRED' || msg.type === 'TRIGGER_ACTION') && msg.scriptId === SCRIPT_ID) {
                controlPanelDetected = true;
                if (IS_TOP) return;                                  // the playback DOM lives in the iframe
                if (msg.tabId ? msg.tabId !== TAB_ID : document.hidden) return;   // tab-local, fail closed
                const id = msg.hotkeyId || msg.actionId;
                if (!settings.master || !model) return;
                if (id === 'prev-shot' || id === 'next-shot') {
                    cpRoutesMyKeys = true;                           // proven: the panel knows our scope → fallback stands down
                    if (Date.now() - lastDirectKeyAt < 250) return;  // the fallback already handled this keypress
                    hotkeyStep(id === 'next-shot' ? 1 : -1);
                }
                else if (id === 'reload') { const ids = current; deactivate(); if (ids) activate(ids); }
            }
        };
    }
    function registerWithControlPanel() {
        if (!controlChannel) return;
        try {
            controlChannel.postMessage({
                type: 'REGISTER',
                scriptId: SCRIPT_ID,
                name: 'Video Validation',
                version: SCRIPT_VERSION,
                scope: 'playback',
                toggles: [
                    { id: 'master', label: 'Enable', type: 'boolean', default: DEFAULTS.master, master: true },
                    { id: 'strip-order', label: 'Snapshot strip oldest → newest', type: 'boolean', default: DEFAULTS.stripOrder },
                    { id: 'badges', label: 'S# badges on thumbnails', type: 'boolean', default: DEFAULTS.badges },
                    { id: 'click-seek', label: 'Clicking a thumbnail seeks the video', type: 'boolean', default: DEFAULTS.clickSeek },
                    { id: 'lead-in', label: 'Seek lead-in (seconds before the shot)', type: 'number', default: DEFAULTS.leadInS, min: 0, max: 60 },
                    { id: 'shot-card', label: 'Shot card (planned vs actual)', type: 'boolean', default: DEFAULTS.shotCard },
                    { id: 'units', label: 'Units', type: 'select', default: DEFAULTS.units, options: [{ value: 'ft', label: 'ft' }, { value: 'm', label: 'm' }] },
                    { id: 'hdr-map', type: 'header', label: 'Map overlay' },
                    { id: 'overlay', label: 'Plan steps on the map (N# / S#)', type: 'boolean', default: DEFAULTS.overlay },
                    { id: 'overlay-actual', label: 'Actual shot poses (cyan: drone, heading, footprint)', type: 'boolean', default: DEFAULTS.overlayActual },
                    { id: 'overlay-labels', label: 'Number labels (off = plain dots)', type: 'boolean', default: DEFAULTS.overlayLabels },
                    { id: 'overlay-group', label: 'Whole mission group (color per flight, whole-mission numbering)', type: 'boolean', default: DEFAULTS.overlayGroup },
                    { id: 'reload', label: 'Reload mission data', type: 'button' },
                ],
                hotkeys: [
                    { id: 'prev-shot', label: 'Previous shot', default: '[' },
                    { id: 'next-shot', label: 'Next shot', default: ']' },
                ],
            });
        } catch (e) { warn('register failed:', e); }
    }

    // [ / ]: step the still viewer when it is open (image by image, our order), else step the video by shot.
    function hotkeyStep(dir) {
        if (stillImg()) { if (stepStill(dir)) return; }
        stepShot(dir);
    }
    // Direct hotkeys. Active until the Control Panel PROVES it routes our keys (a HOTKEY_FIRED for us):
    // a panel older than v1.45 has no 'playback' scope and silently drops them. Dedupe covers the
    // overlap when both paths handle the same keypress. Universal input guard.
    let cpRoutesMyKeys = false;
    let lastDirectKeyAt = 0;
    function fallbackKeys(e) {
        if (cpRoutesMyKeys || !settings.master || !model || IS_TOP) return;
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
        if (e.key !== '[' && e.key !== ']') return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ||
            (t.className && /ant-input|ant-select/.test(String(t.className))) || t.getAttribute('role') === 'textbox')) return;
        lastDirectKeyAt = Date.now();
        e.preventDefault();
        hotkeyStep(e.key === ']' ? 1 : -1);
    }

    // ---------------------------------------------------------------
    // Go.
    // ---------------------------------------------------------------
    log('init v' + SCRIPT_VERSION + ' (' + (IS_TOP ? 'top' : 'iframe') + ')');
    setupControlPanel();
    registerWithControlPanel();
    if (!IS_TOP) {
        document.addEventListener('click', onGridClick, true);
        document.addEventListener('click', onLegendClick, true);
        window.addEventListener('keydown', fallbackKeys, true);
        tickTimer = setInterval(tick, 1000);
        tick();
    }
    log('ready (' + (IS_TOP ? 'top: panel registration only' : 'iframe: watching for the playback route') + ')');
})();
