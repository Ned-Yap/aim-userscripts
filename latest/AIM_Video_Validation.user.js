// ==UserScript==
// @name         Latest - AIM Video Validation
// @namespace    http://tampermonkey.net/
// @version      0.48
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
// @grant        GM_info
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

// AIM Video Validation — Phase 1 (view) + Phase 2 (edit: writes the mission plan).
// Editing is ON by default in the dev copy ("Latest - …") and OFF by default in prod until the save path has been
// proven on a live mission; prod users opt in from the Control Panel (labelled experimental).
// What it does: on /#/site/<sid>/control-panel/past-mission/<mid> (Mission Playback) it joins the
// flown mission (images + flown path + embedded plan) and (1) reorders the snapshot strip oldest-first
// with S# badges, (2) seeks the video to a snapshot's shutter time on click / ▶, (3) highlights the
// shot under the playhead, (4) shows a shot card: planned vs actual heading / camera angle / altitude.
// Time bar under the player: ‹ › skip 10 s (left-click) / 30 s (right-click), jump-to-time box, shot ⏮ ⏭.
// Hotkeys: [ / ] — previous / next shot (still viewer open → previous / next image in OUR order; else video by shot).
//          Routed by the Control Panel (scope 'playback', CP ≥ 1.45) with a direct fallback until the panel proves it routes them.
// Log tag: [AIM VV]
(function() {
    'use strict';

    const SCRIPT_ID = 'aim-video-validation';
    const IS_DEV = (function() { try { return /^Latest - /.test((GM_info && GM_info.script && GM_info.script.name) || ''); } catch (e) { return false; } })();
    const SCRIPT_VERSION = '0.48';
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
        timeBar: true,         // skip / jump-to-time bar under the player
        edit: IS_DEV,          // Adjust panel (Phase 2) — on in the dev copy, opt-in in prod until the save path is proven
        stepDeg: 1, stepPitch: 1, stepFt: 1, stepAltFt: 1, rayCapFt: 500,
        flownDashed: true,     // restyle Percepto's flown-path line
        flownColor: '#ffffff',
        lookPoints: true,      // planned look-point for every in-place snapshot (ray to terrain at planned heading/angle)
        legend: true,          // legend box on the map
        legendOpen: true,      // expanded (false = collapsed to a ? chip)
        chkHdg: 10, chkCam: 5, chkAltFt: 25, chkPosFt: 30, chkLookFt: 50,   // flight checker thresholds
        follow: true,          // selecting a snapshot pans/zooms the map to it
        followZoom: 19,        // max zoom when following
        actualLookPoints: true,// cyan ring where the ACTUAL camera ray met the ground (from the picture's real pose)
        liveDiffOverlay: true, // yellow markers where the CURRENT saved plan differs from what flew
        liveColor: '#ffe95f',
        navKeepAim: true,      // moving a nav re-aims its in-place snapshots at their look-points
        navColor: '#5fa8ff', snapColor: '#ff7ad9', actualColor: '#5fe3ff',
        navLineW: 2, snapLineW: 2.5, actualLineW: 1.5, flownLineW: 3,
    };
    let settings = Object.assign({}, DEFAULTS);
    try { settings = Object.assign({}, DEFAULTS, GM_getValue(SETTINGS_KEY, {}) || {}); }
    catch (e) { warn('settings load failed (defaults):', e); }
    function saveSettings() { try { GM_setValue(SETTINGS_KEY, settings); } catch (e) { warn('settings save failed:', e); } }
    // v0.20 shipped 5° / 2° / 10 ft / 10 ft; v0.22 moved to 1-unit steps. A stored copy of the OLD defaults is not a user choice.
    if (settings.stepDeg === 5 && settings.stepPitch === 2 && settings.stepFt === 10 && settings.stepAltFt === 10) { settings.stepDeg = settings.stepPitch = settings.stepFt = settings.stepAltFt = 1; saveSettings(); }

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
    function compass16(deg) {
        if (deg == null || !isFinite(deg)) return '';
        const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
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
            const m = { sid, mid, mission, images: [], shots: [], byId: {}, numbering: {}, live: null, liveById: {}, liveDiff: null };
            m.plan = (mission.app && Array.isArray(mission.app.instructions)) ? mission.app.instructions.slice().sort((a, b) => a.index_in_app - b.index_in_app) : [];
            m.plan.forEach(s => { m.byId[s.id] = s; });
            // The mission record embeds the plan AS FLOWN (frozen). Edits must read/verify against the LIVE app.
            const appId = mission.app && mission.app.id;
            const livePromise = appId ? fetchLiveApp(sid, appId, mission.app.name || mission.name, m.plan).then(a => { attachLive(m, a); }).catch(e => { warn('live app read failed (edits disabled):', e.message); m.live = null; m.liveError = e.message; }) : Promise.resolve();
            m._livePromise = livePromise;
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

            // Images: shutter time, video offset; step join happens per SHOT below (pose-aware).
            images.forEach(im => {
                const shutter = nameTime(im.name) || (im.created_at ? new Date(im.created_at).getTime() : null);
                const rec = Object.assign({}, im, {
                    shutter,
                    videoOff: (shutter != null && m.video.t0 != null) ? (shutter - m.video.t0) / 1000 : null,
                    key: imgKey(im.thumbnail_url || im.url),
                    kind: im.type === 'THERMAL' || im.thermal ? 'T' : (im.type === 'GEM' ? 'G' : 'RGB'),
                });
                rec.fix = nearestFix(m, shutter);
                m.images.push(rec);
            });
            const KIND_RANK = { RGB: 0, T: 1, G: 2 };
            m.images.sort((a, b) => (a.shutter || 0) - (b.shutter || 0) || (KIND_RANK[a.kind] || 0) - (KIND_RANK[b.kind] || 0));
            m.images.forEach((im, i) => { im.rank = i + 1; });   // CSS order value (video tile = 0)
            // Shots = images sharing a shutter time (RGB + thermal [+ GEM] of one snapshot).
            let cur = null;
            m.images.forEach(im => {
                if (!cur || im.shutter == null || cur.shutter == null || Math.abs(im.shutter - cur.shutter) > 1500) {
                    cur = { shutter: im.shutter, videoOff: im.videoOff, images: [], primary: im };
                    m.shots.push(cur);
                }
                cur.images.push(im);
                if (im.kind === 'RGB') cur.primary = im;
            });
            // Join each shot to its plan step: the executing step from the flown log, unless a LATER unclaimed
            // snapshot in this flight matches the picture's actual heading + camera angle much better (the log is sparse —
            // 235004's S7 was shot between two log entries and would otherwise read as an S6 re-take).
            const claimed = {};
            m.shots.forEach(sh => { sh.step = joinShotToStep(m, sh, claimed); if (sh.step) claimed[sh.step.id] = (claimed[sh.step.id] || 0) + 1; });
            m.shots.forEach(sh => { sh.images.forEach(im => { im.step = sh.step; im.delta = computeDelta(m, im); }); sh.delta = sh.primary.delta; });
            // Extra shots on an already-shot step (pilot re-take) get flagged.
            const seen = {};
            m.shots.forEach(sh => { const id = sh.step && sh.step.id; if (id != null) { sh.retake = !!seen[id]; seen[id] = true; } });
            return livePromise.then(() => m);
        }).then(m => {
            log('model ready: plan ' + m.plan.length + ' steps, slice ' + (m.slice ? m.slice.minIdx + '–' + m.slice.maxIdx : 'n/a') + ', images ' + m.images.length + ', shots ' + m.shots.length + ', fixes ' + m.fixes.length + ', t0 ' + (m.video.t0 ? new Date(m.video.t0).toISOString() : 'n/a'));
            return m;
        });
    }

    // The LIVE app: GET /available_app/<id>/ is 404 on this server; the site's mission list (what the Mission Bank
    // reads) carries every app with full instructions. One list read, pick ours by id.
    // A flown mission's record embeds a FROZEN per-flight copy of the app (its own id, e.g. 181518); the live app the
    // Mission Bank edits has a different id (e.g. 183822) and is not in the site list under the frozen id. Resolve the
    // live app by name, disambiguating same-name missions by structure and geometry against the flown plan.
    // (GET /available_app/<id>/ is 404 and the list needs type=1 — without it the server answers 400.)
    function fetchLiveApp(sid, appId, name, flownPlan) {
        return getJSON('/available_app/?site_id=' + encodeURIComponent(sid) + '&type=1').then(arr => {
            const list = Array.isArray(arr) ? arr : (arr && (arr.results || arr.apps)) || [];
            const direct = list.find(a => a && Number(a.id) === Number(appId));
            if (direct) { direct.__aimVvHow = 'by id'; return direct; }
            const named = list.filter(a => a && a.name === name);
            if (!named.length) throw new Error('no live mission named "' + name + '" in the site list (' + list.length + ' missions; flown record app ' + appId + ')');
            let pick = named[0], how = 'by name';
            if (named.length > 1) {
                const flown = flownPlan || [];
                const aligned = named.filter(a => Array.isArray(a.instructions) && a.instructions.length === flown.length && a.instructions.slice().sort((x, y) => x.index_in_app - y.index_in_app).every((st, i) => st.type === flown[i].type));
                const pool = aligned.length ? aligned : named;
                // Geometry: total distance between located steps of the candidate and the flown plan (smaller = closer copy).
                const score = (a) => { const ins = (a.instructions || []).slice().sort((x, y) => x.index_in_app - y.index_in_app); let d = 0, n = 0; ins.forEach((st, i) => { const f = flown[i]; if (st && f && st.location && f.location) { d += distM(st.location, f.location) || 0; n++; } }); return n ? d / n : Infinity; };
                pool.sort((a, b) => score(a) - score(b));
                pick = pool[0];
                how = 'by name (' + named.length + ' same-name missions; ' + (aligned.length ? aligned.length + ' structurally matching, ' : '') + 'closest geometry ' + (isFinite(score(pick)) ? score(pick).toFixed(1) + ' m/step' : 'n/a') + ')';
                warn('live app for "' + name + '": ' + named.length + ' missions share the name — picked ' + pick.id + ' ' + how);
            }
            pick.__aimVvHow = how;
            if (Number(pick.id) !== Number(appId)) log('live app = ' + pick.id + ' (flown record carries frozen copy ' + appId + ') — resolved ' + how);
            if (!Array.isArray(pick.instructions)) throw new Error('live app ' + pick.id + ' has no instructions in the list response');
            return pick;
        });
    }
    // Map the live app onto the flown plan positionally (ids are per-copy; the POST never sends them anyway).
    // Same count + same type per index → edits work, "before" = live values, differences are reported.
    function attachLive(m, app) {
        const live = (app && Array.isArray(app.instructions)) ? app.instructions.slice().sort((a, b) => a.index_in_app - b.index_in_app) : [];
        m.liveApp = app; m.live = live; m.liveById = {}; m.liveDiff = [];
        if (live.length !== m.plan.length || live.some((st, i) => st.type !== m.plan[i].type)) {
            m.liveAligned = false;
            warn('live plan differs STRUCTURALLY from the flown plan (' + live.length + ' vs ' + m.plan.length + ' steps) — edits disabled on this page');
            return;
        }
        m.liveAligned = true;
        live.forEach((st, i) => {
            const flown = m.plan[i];
            const copy = deepCopy(st); copy.id = flown.id; copy.index_in_app = flown.index_in_app; copy.type_name = flown.type_name;
            m.liveById[flown.id] = copy;
            if (stepSig(flown) !== stepSig(copy)) m.liveDiff.push(flown.id);
        });
        if (m.liveDiff.length) log('live plan differs from the flown plan on ' + m.liveDiff.length + ' step(s): ' + m.liveDiff.map(id => ((m.numbering[id] || {}).n || '#' + m.byId[id].index_in_app) + ' [' + fieldDiffs(m.byId[id], m.liveById[id]).map(d => d.field + ' ' + d.before + '→' + d.after).join('; ') + ']').join(', ') + ' — edits start from the LIVE values');
        else log('live plan = flown plan (' + live.length + ' steps)');
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

    function joinShotToStep(m, sh, claimed) {
        const im = sh.primary; const t = sh.shutter;
        const active = activeStepAt(m, t);
        const poseScore = (st) => {
            const p = plannedPose(m, st); if (!p || p.heading == null) return Infinity;
            const dh = Math.abs(hdgDelta(p.heading, im.drone_heading) || 0);
            const dp = (p.pitchDeg != null && typeof im.camera_pitch === 'number') ? Math.abs(im.camera_pitch - p.pitchDeg) : 0;
            return dh + dp;
        };
        const activeOk = active && active.type_name === 'snapshot';
        const activeScore = activeOk ? poseScore(active) : Infinity;
        // Only look past the log when the logged step is not a clean fit (already claimed, or the pose disagrees).
        if (activeOk && !claimed[active.id] && activeScore <= 12) return active;
        const fromIdx = active ? active.index_in_app : (m.slice ? m.slice.minIdx : 0);
        const toIdx = m.slice ? m.slice.maxIdx : Infinity;
        let best = null, bestScore = 12;   // hard gate: ≤ 12° combined heading + angle error
        m.plan.forEach(st => {
            if (st.type_name !== 'snapshot' || st.index_in_app < fromIdx || st.index_in_app > toIdx || claimed[st.id]) return;
            const sc = poseScore(st);
            if (sc < bestScore) { bestScore = sc; best = st; }
        });
        if (best && best !== active) log('join: shot at ' + mmss(sh.videoOff) + ' → ' + (m.numbering[best.id] ? m.numbering[best.id].n : 'step #' + best.index_in_app) + ' by pose (' + bestScore.toFixed(1) + '° off) instead of logged ' + (active ? active.type_name + ' #' + active.index_in_app : 'none'));
        return best || active;
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
        const navAlt = nav ? ((typeof nav.value1 === 'number') ? nav.value1 : (nav.extra_options && nav.extra_options.abs_alt != null ? nav.extra_options.abs_alt : null)) : null;
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
        // In-place: the drone stands at the nav, so its altitude is the NAV's value1 (abs_alt on the snapshot is a stale
        // derived field — on EL SE S5 it was 54 ft below what the nav commands and the drone flew).
        return { type: 'inplace', nav, navAlt, heading: (typeof eo.heading === 'number') ? eo.heading : null, pitchDeg: gimbalToDeg(eo.pitch), alt: (typeof nav?.value1 === 'number') ? nav.value1 : ((typeof eo.abs_alt === 'number') ? eo.abs_alt : navAlt) };
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
        // Direction the drone was displaced FROM the planned nav (bearing nav → actual drone position).
        d.posDir = (d.pos != null && d.pos >= 1) ? compass16(bearingDeg(pose.nav.location, im.location)) : '';
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
            [data-aim-vv-stamp] { position: relative; }          /* tile anchor — React rewrites className, never data-* */
            [data-aim-vv-active="1"] { outline: 2px solid #5fe3ff; outline-offset: -2px; }
            .aim-vv-nav { position: absolute; top: 50%; transform: translateY(-50%); z-index: 20; width: 40px; height: 40px; border-radius: 50%;
                border: 1px solid rgba(95,227,255,.7); background: rgba(10,14,18,.8); color: #5fe3ff; font: 700 22px/30px monospace; cursor: pointer; }
            .aim-vv-nav:hover { background: #5fe3ff; color: #04222a; }
            .aim-vv-nav--prev { left: 18px; } .aim-vv-nav--next { right: 18px; }
            .aim-vv-nav--off { opacity: .25; cursor: default; }
            html.aim-vv-own-nav .mp-media .pr-image-nav-btn { display: none !important; }
            .aim-vv-badge { position: absolute; left: 2px; top: 2px; z-index: 100; pointer-events: none;
                font: 800 9px/12px monospace; padding: 0 3px; border-radius: 6px; color: #04222a;
                background: rgba(255,122,217,.9); box-shadow: 0 1px 2px rgba(0,0,0,.6); }
            .aim-vv-badge--t { background: rgba(255,179,71,.9); }
            .aim-vv-badge--g { background: rgba(176,255,95,.9); }
            .aim-vv-badge--none { background: #ff5f5f; color: #fff; }
            .aim-vv-badge--retake { outline: 2px dashed #fff; }
            .aim-vv-seek { position: absolute; right: 2px; bottom: 2px; z-index: 100; cursor: pointer; opacity: .55;
                font: 700 9px/13px monospace; width: 14px; height: 14px; text-align: center; border-radius: 50%;
                background: rgba(0,0,0,.7); color: #5fe3ff; border: 1px solid rgba(95,227,255,.6); }
            [data-aim-vv-stamp]:hover .aim-vv-seek { opacity: 1; }
            .aim-vv-scrub { cursor: ew-resize; border-bottom: 1px dashed rgba(95,227,255,.5); user-select: none; }
            body.aim-vv-scrubbing { cursor: ew-resize !important; user-select: none; }
            .aim-vv-split > :not(.aim-vv-group):nth-child(2) > * { cursor: copy; }
            .aim-vv-seek:hover { background: #5fe3ff; color: #04222a; }
            .aim-vv-card { margin: 6px 0 4px; padding: 6px 8px; border: 1px solid rgba(95,227,255,.35); border-radius: 4px;
                background: rgba(10,14,18,.85); color: #e6e6e6; font: 11px/1.4 monospace; }
            .aim-vv-card b { color: #5fe3ff; }
            .aim-vv-card table { border-collapse: collapse; }
            .aim-vv-card td { padding: 0 10px 0 0; white-space: nowrap; }
            .aim-vv-card .ok { color: #5fff5f; } .aim-vv-card .warn { color: #ffb347; } .aim-vv-card .bad { color: #ff5f5f; }
            .aim-vv-card .dim { color: #888; }
            .aim-vv-legend { margin-top: 0; }
            .mp-data.aim-vv-split, .aim-vv-split { display: grid !important; grid-template-columns: minmax(260px, max-content) minmax(300px, 1fr); column-gap: 20px; align-items: start; padding-top: 6px !important; padding-bottom: 6px !important; }
            .aim-vv-group { overflow-x: auto; min-width: 0; }
            .aim-vv-split > :not(.aim-vv-group) { grid-column: 1; }
            /* Compact list view of Percepto's Mission Data: title = 1st child, field grid = 2nd child, each field = value + label. */
            .aim-vv-split > :not(.aim-vv-group):first-child { font-size: 12px !important; line-height: 1.4 !important; margin: 0 0 4px !important; padding: 0 !important; letter-spacing: .04em; color: #aaa; }
            .aim-vv-split > :not(.aim-vv-group):nth-child(2) { display: flex !important; flex-direction: column; gap: 1px; margin: 0 !important; padding: 0 !important; }
            .aim-vv-split > :not(.aim-vv-group):nth-child(2) > * { display: flex !important; flex-direction: row-reverse; justify-content: flex-end; align-items: baseline; gap: 10px; margin: 0 !important; padding: 0 !important; min-width: 0; }
            .aim-vv-split > :not(.aim-vv-group):nth-child(2) > * > * { font-size: 12px !important; line-height: 1.45 !important; margin: 0 !important; padding: 0 !important; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 340px; }
            .aim-vv-split > :not(.aim-vv-group):nth-child(2) > * > :last-child { color: #888 !important; font-weight: 400; flex: 0 0 96px; }
            .aim-vv-group { grid-column: 2; grid-row: 1 / span 20; align-self: start; font: 11px/1.45 monospace; color: #e6e6e6;
                padding: 8px 10px; border: 1px solid rgba(95,227,255,.35); border-radius: 4px; background: rgba(10,14,18,.85); }
            .aim-vv-group b { color: #5fe3ff; } .aim-vv-group .dim { color: #888; } .aim-vv-group .bad { color: #ff5f5f; }
            .aim-vv-group__head { margin-bottom: 4px; }
            .aim-vv-group__toggle { color: #5fe3ff; margin-left: 8px; }
            .aim-vv-group__hint { margin-bottom: 4px; }
            .aim-vv-group__scroll { max-height: 190px; overflow-y: auto; }
            .aim-vv-group__list { border-collapse: collapse; width: 100%; }
            .aim-vv-group__list td { padding: 1px 8px 1px 0; white-space: nowrap; }
            .aim-vv-group__list a { color: #5fe3ff; text-decoration: none; }
            .aim-vv-group__self td { background: rgba(95,227,255,.07); }
            .aim-vv-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; font: 11px/1.3 monospace; color: #e6e6e6;
                background: rgba(10,14,18,.85); border-bottom: 1px solid rgba(95,227,255,.25); }
            .aim-vv-bar button { background: #1f2228; color: #5fe3ff; border: 1px solid rgba(95,227,255,.5); border-radius: 3px; padding: 2px 8px; font: inherit; cursor: pointer; }
            .aim-vv-bar button:hover { background: #5fe3ff; color: #04222a; }
            .aim-vv-bar .aim-vv-time { width: 68px; background: #0f1216; color: #e6e6e6; border: 1px solid #444; border-radius: 3px; padding: 2px 6px; font: inherit; text-align: center; }
            .aim-vv-bar .aim-vv-bar-now { margin-left: auto; }
            .aim-vv-bar .dim { color: #888; }
            .aim-vv-ov { background: none; border: none; }
            .aim-vv-ov-nav { width: 22px; height: 22px; border-radius: 50%; color: #04222a; font: 800 10px/19px monospace; text-align: center; border: 2px solid rgba(0,0,0,.6); box-shadow: 0 1px 4px rgba(0,0,0,.5); }
            .aim-vv-ov-snap { width: 18px; height: 18px; border-radius: 3px; color: #04222a; font: 800 9px/17px monospace; text-align: center; border: 1px solid rgba(0,0,0,.6); opacity: .92; }
            .aim-vv-ov-dot { width: 10px; height: 10px; border-radius: 50%; border: 1px solid rgba(0,0,0,.6); margin: 4px; }
            .aim-vv-ov-dot--small { width: 6px; height: 6px; margin: 2px; opacity: .7; }
            .aim-vv-ov-flag { font-size: 13px; line-height: 16px; text-shadow: 0 1px 2px #000; }
            .aim-vv-ov-actual { width: 16px; height: 16px; border-radius: 50%; background: rgba(95,227,255,.15); border: 2px solid #5fe3ff; box-sizing: border-box; }
            .aim-vv-ov-actual--retake { border-style: dashed; border-color: #fff; }
            .aim-vv-ov-look { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #ff7ad9; box-sizing: border-box; background: rgba(255,122,217,.18); }
            .aim-vv-ov-look::after { content: ''; position: absolute; left: 5px; top: 5px; width: 4px; height: 4px; border-radius: 50%; background: #ff7ad9; }
            .aim-vv-ov-alook { width: 14px; height: 14px; border-radius: 50%; border: 2px dashed #5fe3ff; box-sizing: border-box; background: rgba(95,227,255,.12); }
            .aim-vv-lg { position: absolute; right: 10px; bottom: 66px; z-index: 1200; cursor: pointer; background: rgba(10,14,18,.9); color: #e6e6e6; border: 1px solid rgba(95,227,255,.4); border-radius: 5px; padding: 5px 8px; font: 11px/1.5 monospace; max-width: min(380px, 60%); pointer-events: auto; }
            .aim-vv-lg--closed { padding: 2px 8px; }
            .aim-vv-lg__head { user-select: none; } .aim-vv-lg { user-select: none; } .aim-vv-lg b { color: #5fe3ff; } .aim-vv-lg .dim { color: #888; }
            .aim-vv-lg__row { white-space: normal; } .aim-vv-lg__sw { display: inline-block; width: 20px; text-align: center; margin-right: 4px; }
            .aim-vv-ov-live { width: 22px; height: 22px; border-radius: 4px; border: 2px solid #ffe95f; background: rgba(0,0,0,.55); color: #ffe95f; font: 800 9px/18px monospace; text-align: center; }
            .aim-vv-ov-ghost { width: 22px; height: 22px; border-radius: 50%; border: 2px dashed #fff; background: rgba(0,0,0,.35); color: #fff; font: 800 9px/18px monospace; text-align: center; }
            .aim-vv-edit__row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; }
            .aim-vv-edit__row > .dim:first-child { min-width: 82px; }
            .aim-vv-edit button, .aim-vv-review button { background: #1f2228; color: #5fe3ff; border: 1px solid rgba(95,227,255,.5); border-radius: 3px; padding: 2px 8px; font: inherit; cursor: pointer; }
            .aim-vv-edit button:hover, .aim-vv-review button:hover { background: #5fe3ff; color: #04222a; }
            .aim-vv-edit button.aim-vv-danger { color: #ff7a7a; border-color: rgba(255,95,95,.6); }
            .aim-vv-edit button.aim-vv-danger:hover { background: #ff5f5f; color: #fff; }
            .aim-vv-review button[disabled] { opacity: .4; cursor: default; }
            .aim-vv-edit .aim-vv-restore-pick { max-width: 420px; background: #0f1216; color: #e6e6e6; border: 1px solid #444; border-radius: 3px; padding: 2px 6px; font: inherit; }
            .aim-vv-edit .aim-vv-latlng { width: 190px; background: #0f1216; color: #e6e6e6; border: 1px solid #444; border-radius: 3px; padding: 2px 6px; font: inherit; }
            .aim-vv-edit button.aim-vv-armed { background: #5fe3ff; color: #04222a; }
            .leaflet-container.aim-vv-placing, .leaflet-container.aim-vv-placing * { cursor: crosshair !important; }
            .aim-vv-edit__foot { border-top: 1px solid rgba(255,255,255,.12); padding-top: 4px; margin-top: 6px; }
            .aim-vv-review { position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; }
            .aim-vv-review__box { max-width: 900px; max-height: 80vh; overflow: auto; background: #12151a; color: #e6e6e6; border: 1px solid rgba(95,227,255,.5); border-radius: 6px; padding: 12px 14px; font: 12px/1.45 monospace; }
            .aim-vv-cardhost canvas { display: block; max-width: 100%; height: auto; border-radius: 6px; }
            .aim-vv-review table { border-collapse: collapse; margin: 6px 0; } .aim-vv-review td { padding: 2px 10px 2px 0; white-space: nowrap; border-bottom: 1px solid rgba(255,255,255,.06); }
            .aim-vv-review b { color: #5fe3ff; } .aim-vv-review .dim { color: #888; } .aim-vv-review .warn { color: #ffb347; }
            .aim-vv-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 100001; background: rgba(10,14,18,.95); color: #e6e6e6; border: 1px solid rgba(95,227,255,.6); border-radius: 4px; padding: 8px 14px; font: 12px/1.4 monospace; display: none; max-width: 70vw; }
            .aim-vv-toast--bad { border-color: #ff5f5f; color: #ffb3b3; }
            .aim-vv-card .aim-vv-adjust-wrap { float: right; display: flex; gap: 6px; }
            .aim-vv-card .aim-vv-adjust { float: none; background: #1f2228; color: #5fe3ff; border: 1px solid rgba(95,227,255,.5); border-radius: 3px; padding: 1px 8px; font: inherit; cursor: pointer; }
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
                badge.textContent = label;
                badge.style.background = rec.kind === 'RGB' ? (settings.snapColor || '#ff7ad9') : '';
                badge.title = (num ? num.n + ' · ' : '') + (rec.kind === 'T' ? 'thermal' : rec.kind === 'G' ? 'GEM' : 'RGB') + ' · shutter ' + mmss(rec.videoOff) + (shot && shot.retake ? ' · re-take of an already-shot step' : '');
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
    // Diagnostic: is the badge on this tile actually VISIBLE after Percepto reacted to the click?
    // Logs what covers it (once per image) so a hidden badge is never a guess again.
    const visProbeLogged = {};
    function probeTileVisibility(tile, rec) {
        try {
            if (!settings.badges || !rec || visProbeLogged[rec.key]) return;
            const live = tileFor(rec) || tile;
            const badge = live && live.querySelector('.aim-vv-badge');
            const seek = live && live.querySelector('.aim-vv-seek');
            const info = (el) => el ? { tag: el.tagName, cls: String(el.className).slice(0, 80), z: getComputedStyle(el).zIndex, pos: getComputedStyle(el).position, op: getComputedStyle(el).opacity, vis: getComputedStyle(el).visibility, disp: getComputedStyle(el).display } : null;
            const check = (el, name) => {
                if (!el) return name + ': MISSING from DOM';
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) return name + ': zero size ' + JSON.stringify(info(el));
                const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                if (top === el || el.contains(top)) return name + ': visible';
                return name + ': COVERED by ' + JSON.stringify(info(top)) + ' | badge ' + JSON.stringify(info(el)) + ' | rect ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
            };
            const res = [check(badge, 'badge'), check(seek, 'seek')];
            visProbeLogged[rec.key] = true;
            const bad = res.some(x => !/visible$/.test(x));
            (bad ? warn : log)('tile visibility after click (' + rec.key + '): ' + res.join(' · ') + (bad ? ' | tile: ' + JSON.stringify(info(live)) + ' | tile children: ' + Array.from(live.children).map(c => c.tagName + '.' + String(c.className).slice(0, 40)).join(', ') : ''));
        } catch (e) { warn('visibility probe failed:', e); }
    }
    function unstampStrip() {
        const grid = stripGrid();
        if (!grid) return;
        stripTiles(grid).forEach(tile => {
            orderEl(grid, tile).style.order = '';
            tile.querySelectorAll('.aim-vv-badge, .aim-vv-seek').forEach(el => el.remove());
            delete tile.dataset.aimVvStamp; delete tile.dataset.aimVvKey; delete tile.dataset.aimVvSrc; delete tile.dataset.aimVvActive;
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
    function showPlayer() {
        if (!stillImg()) return true;
        // A still is showing; clicking the video tile swaps the player back (the <video> kept its time).
        const vt = videoTile();
        if (vt) { try { vt.click(); return true; } catch (e) { warn('video tile click failed:', e); } }
        else warn('video tile not found — cannot swap back to the player');
        return false;
    }
    function seekVideo(t, play) {
        const v = videoEl();
        if (!v) { warn('seek: no <video>'); return false; }
        t = Math.max(0, Math.min(isFinite(v.duration) ? v.duration : t, t));
        try { v.currentTime = t; } catch (e) { warn('seek failed:', e); return false; }
        if (play) { try { const p = v.play(); if (p && p.catch) p.catch(e => warn('play() refused:', e.message)); } catch (e) { warn('play failed:', e); } }
        return true;
    }
    function seekToShot(rec, showVideo, play) {
        const v = videoEl();
        if (!v || !rec || rec.videoOff == null) { warn('seek: no video or no offset for', rec && rec.name); return; }
        const t = Math.max(0, rec.videoOff - (Number(settings.leadInS) || 0));
        if (showVideo) showPlayer();
        if (seekVideo(t, !!play)) log('seek → ' + mmss(t) + ' (shot at ' + mmss(rec.videoOff) + ')' + (play ? ' ▶' : ''));
        selectShot(rec);
    }
    function markActiveTiles(keys) {
        const grid = stripGrid();
        if (!grid) return;
        if (keys.join('|') === activeKeys.join('|')) return;
        activeKeys = keys;
        stripTiles(grid).forEach(tile => {
            const rec = tileImage(tile);
            const on = !!(rec && keys.includes(rec.key));
            if (on) tile.dataset.aimVvActive = '1'; else delete tile.dataset.aimVvActive;
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
        updateBarNow();
        let best = null, bestD = Infinity;
        model.shots.forEach(sh => { if (sh.videoOff == null) return; const d = Math.abs(sh.videoOff - t); if (d < bestD) { bestD = d; best = sh; } });
        // "Current" = the shot whose shutter is within the window: the most recent one already taken, or the one
        // about to be taken (inside the lead-in we seek to before a shot).
        const lead = (Number(settings.leadInS) || 0) + 1.5;
        let current = null;
        model.shots.forEach(sh => { if (sh.videoOff != null && sh.videoOff <= t + lead && t - sh.videoOff <= SHOT_MATCH_WINDOW_S) current = sh; });
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
        const lead = Number(settings.leadInS) || 0;
        // A shot "starts" at its lead-in point (where selecting it seeks to). Next = first shot whose start is ahead of
        // the playhead; previous = last shot whose start is behind it. Judging by the shutter instead made "next" from a
        // freshly selected shot land on the same shot, and "previous" just after a shutter find nothing.
        const offs = model.shots.filter(s => s.videoOff != null).map(s => ({ s, start: Math.max(0, s.videoOff - lead) }));
        let target = null;
        if (dir > 0) { const hit = offs.find(o => o.start > t + 0.5); target = hit && hit.s; }
        else { const before = offs.filter(o => o.start < t - 0.5); target = before.length ? before[before.length - 1].s : null; }
        if (!target) { log('no ' + (dir > 0 ? 'next' : 'previous') + ' shot'); return; }
        seekToShot(target.primary, true);
        scrollTileIntoView(target.primary);
    }

    // ---------------------------------------------------------------
    // Still viewer (Percepto shows the clicked image in .mp-media): its ‹ › arrows and the
    // "8 / 14" counter walk Percepto's newest-first list. We redirect both to OUR order.
    // ---------------------------------------------------------------
    function stillImg() { return document.querySelector('.mp-media__image'); }
    let pendingStill = null;   // { key, at } — the image we just asked Percepto to show (it may still be loading)
    function currentStillRec() {
        const im = stillImg();
        if (!im || !model) return null;
        // The src ATTRIBUTE is the intended image; currentSrc lags until the new file starts loading.
        const k = imgKey(im.getAttribute('src') || im.currentSrc || im.src);
        const shown = model.images.find(r => r.key === k) || null;
        if (pendingStill && Date.now() - pendingStill.at < 1500 && (!shown || shown.key !== pendingStill.key)) {
            return model.images.find(r => r.key === pendingStill.key) || shown;   // rapid stepping: chain from our own target
        }
        pendingStill = null;
        return shown;
    }
    function tileFor(rec) {
        const grid = stripGrid(); if (!grid || !rec) return null;
        return stripTiles(grid).find(t => t.dataset.aimVvKey === rec.key || tileImage(t) === rec) || null;
    }
    function showStill(rec) {
        const t = tileFor(rec);
        if (!t) { warn('no tile for', rec && rec.name); return; }
        pendingStill = { key: rec.key, at: Date.now() };
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
    // Time bar (under the player): skip ±10 s (M1) / ±30 s (M2), jump-to-time box, shot ⏮ ⏭.
    // ---------------------------------------------------------------
    let barEl = null;
    function parseTime(str) {
        const t = String(str || '').trim();
        if (!t) return null;
        if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);                      // plain seconds
        const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);        // m:ss or h:mm:ss
        if (m) return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        const m2 = t.match(/^(\d+)m\s*(\d+)?s?$/i);                             // 8m20s
        if (m2) return (+m2[1]) * 60 + (+(m2[2] || 0));
        return null;
    }
    function ensureBar() {
        if (!settings.timeBar) { if (barEl) { barEl.remove(); barEl = null; } return null; }
        const media = document.querySelector('.mp-media');
        if (!media || !media.parentElement) return null;
        if (barEl && media.parentElement.contains(barEl)) return barEl;
        barEl = document.createElement('div');
        barEl.className = 'aim-vv-bar';
        barEl.innerHTML = ''
            + '<button type="button" data-aim-vv-bar="prev-shot" title="Previous shot  ( [ )">⏮ shot</button>'
            + '<button type="button" data-aim-vv-bar="skip" data-s="-10" data-s2="-30" title="Left-click −10 s · right-click −30 s">‹ 10s</button>'
            + '<input type="text" class="aim-vv-time" data-aim-vv-scrub="time" placeholder="m:ss" title="Type a time (m:ss or seconds) + Enter · drag ↔ or mouse-wheel to scrub (Shift ×5)" spellcheck="false">'
            + '<button type="button" data-aim-vv-bar="go" title="Jump to the typed time">Go</button>'
            + '<button type="button" data-aim-vv-bar="skip" data-s="10" data-s2="30" title="Left-click +10 s · right-click +30 s">10s ›</button>'
            + '<button type="button" data-aim-vv-bar="next-shot" title="Next shot  ( ] )">shot ⏭</button>'
            + '<span class="aim-vv-bar-now dim aim-vv-scrub" data-aim-vv-scrub="time" title="drag ↔ to scrub (1 s per step, Shift ×5)"></span>';
        media.insertAdjacentElement('afterend', barEl);
        const inp = barEl.querySelector('.aim-vv-time');
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); barGo(); } else if (e.key === 'Escape') { inp.blur(); } });
        inp.addEventListener('keyup', (e) => e.stopPropagation());
        barEl.addEventListener('contextmenu', (e) => { const b = e.target.closest('[data-aim-vv-bar="skip"]'); if (b) { e.preventDefault(); e.stopPropagation(); barSkip(Number(b.dataset.s2)); } });
        return barEl;
    }
    function barGo() {
        const inp = barEl && barEl.querySelector('.aim-vv-time');
        const t = inp ? parseTime(inp.value) : null;
        if (t == null) { warn('jump: could not read "' + (inp && inp.value) + '" — use m:ss or seconds'); if (inp) inp.select(); return; }
        showPlayer();
        if (seekVideo(t, false)) log('jump → ' + mmss(t));
        if (inp) inp.blur();
    }
    function barSkip(sec) {
        const v = videoEl(); if (!v) return;
        showPlayer();
        if (seekVideo(v.currentTime + sec, false)) log('skip ' + (sec > 0 ? '+' : '') + sec + 's → ' + mmss(v.currentTime));
    }
    function onBarClick(e) {
        const b = e.target.closest && e.target.closest('[data-aim-vv-bar]');
        if (!b || !model) return;
        e.preventDefault(); e.stopPropagation();
        const what = b.dataset.aimVvBar;
        if (what === 'skip') barSkip(Number(b.dataset.s));
        else if (what === 'go') barGo();
        else if (what === 'prev-shot') { showPlayer(); stepShot(-1); }
        else if (what === 'next-shot') { showPlayer(); stepShot(1); }
    }
    function updateBarNow() {
        if (!barEl) return;
        const v = videoEl(); if (!v) return;
        const now = barEl.querySelector('.aim-vv-bar-now');
        const txt = mmss(v.currentTime) + ' / ' + mmss(v.duration);
        if (now && now.textContent !== txt) now.textContent = txt;
        const inp = barEl.querySelector('.aim-vv-time');
        if (inp && document.activeElement !== inp && inp.value !== mmss(v.currentTime)) inp.value = mmss(v.currentTime);
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
    function selectShot(rec) { selectedRec = rec; renderCard(rec, 'selected'); markActiveOverlay(); followShot(rec); }
    // Pan/zoom the map to the selected shot: its step marker (planned), the drone's actual position and the planned nav.
    let lastFollowedKey = null;
    function followShot(rec) {
        if (!settings.follow || !rec || !model) return;
        if (rec.key === lastFollowedKey) return;   // same shot re-selected (thermal twin, playhead) — don't fight the user's pan
        const map = findMap(), L = getL(); if (!map || !L) return;
        const pts = [];
        if (rec.location) pts.push([rec.location.lat, rec.location.lng]);
        const st = rec.step;
        if (st) {
            const mk = ov.stepMarkers[st.id]; if (mk) { const p = mk.getLatLng(); pts.push([p.lat, p.lng]); }
            const nav = parentNav(model, st); if (nav && nav.location) pts.push([nav.location.lat, nav.location.lng]);
        }
        if (!pts.length) return;
        lastFollowedKey = rec.key;
        try {
            const maxZoom = Number(settings.followZoom) || 19;
            if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), maxZoom - 1), { animate: true });
            else map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom, animate: true });
        } catch (e) { warn('follow failed:', e); }
    }
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
                + '<tr><td>drone vs nav</td><td colspan="2" class="dim">' + (pose.nav ? esc((model.numbering[pose.nav.id] || {}).n || 'nav #' + pose.nav.index_in_app) : '–') + (d.pos != null && d.pos * M_TO_FT >= 10 ? ' — drone stood ' + esc(d.posDir) + ' of it' : '') + '</td><td class="' + cls(d.pos != null ? d.pos * M_TO_FT : null, 10, 30) + '">' + fmtDist(d.pos) + (d.posDir ? ' ' + esc(d.posDir) : '') + '</td></tr>'
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
        const adjust = '<span class="aim-vv-adjust-wrap">' + (settings.edit ? '<button type="button" class="aim-vv-adjust" data-aim-vv-ed-toggle="1" title="Open the Adjust panel for this step">✎ Adjust' + (ed.work && edDiff().length ? ' (' + edDiff().length + ')' : '') + '</button>' : '')
            + '<button type="button" class="aim-vv-adjust" data-aim-vv-tool="check" title="Check every shot of this flight against the plan (re-takes, deviations, missing shots)">🔎 Check flight</button>'
            + '<button type="button" class="aim-vv-adjust" data-aim-vv-tool="session" title="Before / after of everything applied on this page, copy for JIRA">📋 Changes' + (sessionReports.filter(r => String(r.mid) === String(model.mid)).length ? ' (' + sessionReports.filter(r => String(r.mid) === String(model.mid)).length + ')' : '') + '</button></span>';
        el.innerHTML = adjust + head + rows + '<div style="margin-top:3px;">' + prev + ' · <span class="dim">[ / ] prev / next shot</span></div>';
        if (ed.open) renderEdit();
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
            if (rec) { seekToShot(rec, true, true); }
            return;
        }
        const tile = e.target.closest('.mp-thumbnails__item');
        if (!tile) return;
        const rec = tileImage(tile);
        if (!rec) return;   // video tile — let Percepto handle it
        // Let Percepto show the still first; then seek the (still-alive) video so ▶ resumes at the shot.
        setTimeout(() => { if (settings.clickSeek) seekToShot(rec, false); else selectShot(rec); }, 0);
        setTimeout(() => probeTileVisibility(tile, rec), 700);
    }


    // ---------------------------------------------------------------
    // Map overlay — plan steps (N#/S#) + actual shot poses on the playback Leaflet map.
    // Raw Leaflet only (react-leaflet map): own L.svg() renderer, explicitly added + primed.
    // ---------------------------------------------------------------
    const ov = { map: null, L: null, svg: null, layers: [], stepMarkers: {}, shotMarkers: {}, group: null, groupLoading: false };
    const FLIGHT_COLORS = ['#ff7ad9', '#ffb347', '#b0ff5f', '#5fa8ff', '#ff5f5f', '#c77dff', '#ffe95f', '#5fe3ff'];
    const COLOR_OTHER = '#8a8f99';
    // Overlay colors / line weight are Control Panel settings (read live so a picker change redraws with the new values).
    let COLOR_NAV = '#5fa8ff', COLOR_SNAP = '#ff7ad9', COLOR_ACTUAL = '#5fe3ff';
    let W_NAV = 2, W_SNAP = 2.5, W_ACT = 1.5;
    function syncOverlayStyle() { COLOR_NAV = settings.navColor || '#5fa8ff'; COLOR_SNAP = settings.snapColor || '#ff7ad9'; COLOR_ACTUAL = settings.actualColor || '#5fe3ff'; W_NAV = Number(settings.navLineW) || 2; W_SNAP = Number(settings.snapLineW) || 2.5; W_ACT = Number(settings.actualLineW) || 1.5; }

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
        ed.ghosts.forEach(l => { try { if (map) map.removeLayer(l); } catch (e) { /* already gone */ } }); ed.ghosts = [];
        lookLayers.forEach(l => { try { if (map) map.removeLayer(l); } catch (e) { /* already gone */ } }); lookLayers = []; lookToken++;
        if (model) model.plan.forEach(st => { delete st._look; });
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
    let overlayToken = 0, actualLookToken = 0;
    const overlayDrawLog = []; let overlayCooldownUntil = 0;
    function drawOverlay() {
        clearOverlay();
        if (!model || !settings.master || !settings.overlay) return;
        // Circuit breaker: more than 8 redraws in a second means something is redrawing in a loop — stop for 10 s.
        const now = Date.now();
        if (now < overlayCooldownUntil) return;
        while (overlayDrawLog.length && now - overlayDrawLog[0] > 1000) overlayDrawLog.shift();
        overlayDrawLog.push(now);
        if (overlayDrawLog.length > 8) { overlayCooldownUntil = now + 10000; warn('overlay redrawn ' + overlayDrawLog.length + '× in 1 s — stopping overlay redraws for 10 s (redraw loop)'); return; }
        const L = getL(), map = findMap();
        if (!L || !map) { if (!ov.warned) { ov.warned = true; warn('overlay: Leaflet map not found yet (L=' + !!L + ')'); } return; }
        ov.warned = false;
        const token = ++overlayToken;
        const groupOn = !!(settings.overlayGroup && ov.group);
        // Terrain under each nav that carries in-place snapshots (this flight only) → look-points. Cached after the first pass.
        const inSlice = (st) => groupOn || !model.slice || (st.index_in_app >= model.slice.minIdx && st.index_in_app <= model.slice.maxIdx);
        const navsNeeding = []; let nv = null;
        if (settings.lookPoints && !groupOn) model.plan.forEach(st => { if (st.type_name === 'navigate') nv = st; else if (st.type_name === 'snapshot' && !isGps(st) && nv && nv.location && inSlice(st) && !navsNeeding.includes(nv)) navsNeeding.push(nv); });
        const pending = navsNeeding.filter(n => demCache[(+n.location.lat).toFixed(5) + ',' + (+n.location.lng).toFixed(5)] === undefined);
        if (pending.length) {
            log('overlay: fetching terrain under ' + pending.length + ' nav(s) for look-points…');
            Promise.all(pending.map(n => demCached(n.location))).then(() => { if (token === overlayToken) drawOverlaySync(L, map); });
            drawOverlaySync(L, map);   // draw now (in-place snaps beside their nav), redraw at look-points when terrain lands
            return;
        }
        drawOverlaySync(L, map);
    }
    function groundAt(ll) {
        const v = demCache[(+ll.lat).toFixed(5) + ',' + (+ll.lng).toFixed(5)];
        if (v !== undefined) return v;
        // A nav moved in the working copy has no exact lookup yet — use the nearest cached terrain within 300 m (preview only).
        let best = null, bd = 300;
        Object.keys(demCache).forEach(k => { const g = demCache[k]; if (g == null) return; const [la, ln] = k.split(',').map(Number); const d = distM(ll, { lat: la, lng: ln }); if (d < bd) { bd = d; best = g; } });
        return best;
    }
    // Where an in-place snapshot is DRAWN: its look-point when terrain is known and look-points are on, else beside the nav.
    function inplaceDrawPos(nav, st) {
        if (settings.lookPoints && nav && nav.location) { const g = groundAt(nav.location); if (g != null) { const lp = lookPointFor(nav, st, g); if (lp) return { ll: [lp.ll.lat, lp.ll.lng], look: lp }; } }
        return null;
    }
    function drawOverlaySync(L, map) {
        clearOverlay();
        const svg = ensureSvg(L, map);
        const lineOpts = (o) => Object.assign({ interactive: false }, svg ? { renderer: svg } : {}, o);
        const groupOn = !!(settings.overlayGroup && ov.group);
        const inSlice = (st) => groupOn || !model.slice || (st.index_in_app >= model.slice.minIdx && st.index_in_app <= model.slice.maxIdx);
        if (!settings.master || !settings.overlay) return;
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
        syncOverlayStyle();
        if (navPts.length >= 2) addLayer(map, L.polyline(navPts, lineOpts({ color: COLOR_NAV, weight: W_NAV, opacity: 0.6, dashArray: '6,8' })));
        let nav = null;
        steps.forEach(st => {
            if (st.type_name === 'navigate') { nav = st; return; }
            if (st.type_name !== 'snapshot' || !nav || !nav.location) return;
            if (dense && unflown(st)) return;
            const col = colorFor(st, COLOR_SNAP);
            if (st.location && typeof st.location.lat === 'number') {
                addLayer(map, L.polyline([[nav.location.lat, nav.location.lng], [st.location.lat, st.location.lng]], lineOpts({ color: col, weight: W_SNAP, opacity: 0.85, dashArray: '4,6' })));
            } else {
                const eo = st.extra_options || {};
                const dp = inplaceDrawPos(nav, st);
                if (dp) addLayer(map, L.polyline([[nav.location.lat, nav.location.lng], dp.ll], lineOpts({ color: col, weight: W_SNAP, opacity: 0.85, dashArray: '4,6' })));
                else if (typeof eo.heading === 'number') addLayer(map, L.polyline([[nav.location.lat, nav.location.lng], offsetLatLng(nav.location, 18, eo.heading)], lineOpts({ color: col, weight: W_SNAP + 0.5, opacity: 0.9 })));
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
                    const dp = inplaceDrawPos(nav, st);
                    if (dp) { ll = dp.ll; st._look = dp.look; }
                    else {
                        // No terrain yet / look-points off: sit at the nav, pushed ~22 px out along the heading so snaps don't stack.
                        const eo = st.extra_options || {}; const h = typeof eo.heading === 'number' ? eo.heading : (inplaceCount[nav.id] = (inplaceCount[nav.id] || 0) + 1) * 45;
                        ll = [nav.location.lat, nav.location.lng];
                        anchor = [size / 2 - 22 * Math.sin(h * RAD), size / 2 + 22 * Math.cos(h * RAD)];
                    }
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
                    + (st.type_name === 'snapshot' ? (st.location ? ' · GPS aim point' : ' · in-place ' + ((st.extra_options || {}).heading != null ? st.extra_options.heading + '°' : '') + (st._look ? ' · look-point ' + fmtDist(st._look.dist) + ' out (horizontal)' + (st._look.slant != null ? ', ' + fmtDist(st._look.slant) + ' line of sight' : '') + (st._look.agl != null ? ', ' + fmtAlt(st._look.agl) + ' above terrain' : '') + (st._look.capped ? ' (capped)' : '') : '')) : '')
                    + (shots.length ? ' · shot at ' + shots.map(sh => mmss(sh.videoOff)).join(', ') : (st.type_name === 'snapshot' && !groupOn ? ' · <i>no image</i>' : ''));
                mk.bindTooltip(tip, { direction: 'top', offset: [0, -10], opacity: 0.95 });
                if (shots.length) mk.on('click', () => { const sh = shots[0]; seekToShot(sh.primary, true, true); scrollTileIntoView(sh.primary); });
            } catch (e) { warn('overlay marker failed:', e); }
        });

        // Actual look-point: where the REAL camera ray (drone position / heading / angle from the picture) met the ground.
        // Terrain under the drone comes from the same cache the planned look-points use (fetched lazily, redraw when it lands).
        if (settings.overlayActual && settings.actualLookPoints) {
            // Only positions NEVER looked up (undefined). A failed lookup is cached as null and must not be retried here —
            // v0.38 retried nulls on every redraw and looped the tab to death.
            const demKey = (ll) => (+ll.lat).toFixed(5) + ',' + (+ll.lng).toFixed(5);
            const need = model.shots.map(sh => sh.primary).filter(im => im && im.location && typeof im.drone_heading === 'number' && typeof im.camera_pitch === 'number' && demCache[demKey(im.location)] === undefined);
            if (need.length) { const tok = ++actualLookToken, ot = overlayToken; log('overlay: fetching terrain under ' + need.length + ' drone position(s) for actual look-points…'); Promise.all(need.map(im => demCached(im.location))).then(() => { if (tok === actualLookToken && ot === overlayToken) drawOverlay(); }); }
            model.shots.forEach(sh => {
                const im = sh.primary; if (!im || !im.location || typeof im.drone_heading !== 'number' || typeof im.camera_pitch !== 'number') return;
                const g = groundAt(im.location); if (g == null) return;
                const alt = typeof im.alt === 'number' ? im.alt : null; if (alt == null) return;
                const capM = (Number(settings.rayCapFt) || 500) * FT, down = Math.tan(Math.abs(im.camera_pitch) * RAD);
                let dist = down > 0.01 ? (alt - g) / down : Infinity; let capped = false; if (!(dist > 0) || dist > capM) { dist = capM; capped = true; }
                const aim = moveLL(im.location, dist, im.drone_heading);
                const num = sh.step && model.numbering[sh.step.id];
                try {
                    const mk = L.marker([aim.lat, aim.lng], { icon: L.divIcon({ className: 'aim-vv-ov', html: '<div class="aim-vv-ov-alook" style="border-color:' + COLOR_ACTUAL + '"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: true, zIndexOffset: 280 });
                    mk.bindTooltip('<b>' + esc(num ? num.n : '?') + '</b> ACTUAL look-point · ' + fmtDist(dist) + ' out (horizontal), ' + fmtDist(Math.sqrt(dist * dist + (alt - g) * (alt - g))) + ' line of sight' + (capped ? ' (capped — shallow angle)' : '') + ' · from the real position, ' + im.drone_heading + '° / ' + im.camera_pitch + '°, ' + fmtAlt(alt - g) + ' above terrain', { direction: 'top', offset: [0, -8], opacity: 0.95 });
                    if (addLayer(map, mk)) { const pm = ov.stepMarkers[sh.step && sh.step.id]; if (pm) { const pp = pm.getLatLng(); if (distM(pp, aim) > 1) addLayer(map, L.polyline([[pp.lat, pp.lng], [aim.lat, aim.lng]], lineOpts({ color: COLOR_ACTUAL, weight: 1, opacity: 0.6, dashArray: '2,4' }))); } }
                } catch (e) { warn('actual look-point failed:', e); }
            });
        }
        // Actual shot poses from the image records: drone dot + heading tick + ground footprint.
        if (settings.overlayActual) {
            model.shots.forEach(sh => {
                const im = sh.primary; if (!im || !im.location) return;
                const num = sh.step && model.numbering[sh.step.id];
                if (Array.isArray(im.fov_polygon) && im.fov_polygon.length >= 3) {
                    addLayer(map, L.polygon(im.fov_polygon.map(p => [p.lat, p.lng]), lineOpts({ color: COLOR_ACTUAL, weight: W_ACT, opacity: 0.8, fillColor: COLOR_ACTUAL, fillOpacity: 0.08 })));
                }
                if (typeof im.drone_heading === 'number') addLayer(map, L.polyline([[im.location.lat, im.location.lng], offsetLatLng(im.location, 14, im.drone_heading)], lineOpts({ color: COLOR_ACTUAL, weight: W_ACT + 0.5, opacity: 0.9 })));
                try {
                    const icon = L.divIcon({ className: 'aim-vv-ov', html: '<div class="aim-vv-ov-actual' + (sh.retake ? ' aim-vv-ov-actual--retake' : '') + '" style="border-color:' + (sh.retake ? '#fff' : COLOR_ACTUAL) + ';background:' + COLOR_ACTUAL + '26"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
                    const mk = L.marker([im.location.lat, im.location.lng], { icon, interactive: true, zIndexOffset: 300 });   // under the N#/S# labels
                    if (!addLayer(map, mk)) return;
                    ov.shotMarkers[im.key] = mk;
                    const d = sh.delta || {};
                    mk.bindTooltip('<b>actual</b> ' + esc(num ? num.n : '?') + ' · ' + mmss(sh.videoOff) + ' · hdg ' + im.drone_heading + '° · cam ' + im.camera_pitch + '° · ' + fmtAlt(im.alt)
                        + (d.hdg != null ? ' · Δhdg ' + signed(d.hdg, '°') : '') + (d.pitch != null ? ' · Δcam ' + signed(d.pitch, '°') : '')
                        + (d.pos != null ? ' · ' + fmtDist(d.pos) + (d.posDir ? ' ' + d.posDir : '') + ' from nav' : '') + (sh.retake ? ' · re-take' : ''), { direction: 'top', offset: [0, -8], opacity: 0.95 });
                    mk.on('click', () => { seekToShot(im, true, true); scrollTileIntoView(im); });
                } catch (e) { warn('overlay actual marker failed:', e); }
            });
        }
        if (!ov.zoomHooked || ov.zoomHookedMap !== map) {
            try { map.on('zoomend', onOverlayZoom); ov.zoomHooked = true; ov.zoomHookedMap = map; } catch (e) { warn('zoomend hook failed:', e); }
        }
        activeOverlayKey = undefined;   // markers are new — force the active highlight to re-apply
        try { drawGhosts(); } catch (e) { warn('ghosts:', e); }
        try { drawLookPoints(); } catch (e) { warn('look-points:', e); }
        try { drawLiveDiff(L, map, lineOpts); } catch (e) { warn('live-diff overlay:', e); }
        try { ensureLegend(); } catch (e) { warn('legend:', e); }
        log('overlay drawn: ' + steps.length + ' plan steps' + (groupOn ? ' (whole mission, ' + ov.group.length + ' flights)' : ' (this flight)') + ', ' + Object.keys(ov.shotMarkers).length + ' actual shots, ' + ov.layers.length + ' layers');
        markActiveOverlay();
    }
    // Yellow: where the CURRENT saved (live) plan differs from the flown plan on the map — a marker at the live position
    // with a dashed link back to the flown marker, so edits can be made on top of what is saved now.
    function drawLiveDiff(L, map, lineOpts) {
        if (!settings.liveDiffOverlay || !model || !model.liveAligned || !model.liveDiff || !model.liveDiff.length) return;
        const col = settings.liveColor || '#ffe95f';
        const liveNavOf = (liveStep) => { const i = model.plan.findIndex(x => x.id === liveStep.id); for (let k = i - 1; k >= 0; k--) if (model.plan[k].type_name === 'navigate') return model.liveById[model.plan[k].id]; return null; };
        let drawn = 0;
        model.liveDiff.forEach(id => {
            const live = model.liveById[id]; if (!live) return;
            let ll = null;
            if (live.type_name === 'navigate' && live.location) ll = live.location;
            else if (live.type_name === 'snapshot') {
                if (isGps(live)) ll = live.location;
                else { const nav = liveNavOf(live); if (nav && nav.location) { const g = groundAt(nav.location); const lp = g != null ? lookPointFor(nav, live, g) : null; ll = lp ? { lat: lp.ll[0], lng: lp.ll[1] } : nav.location; } }
            }
            if (!ll) return;
            const flownMk = ov.stepMarkers[id];
            if (flownMk) { const f = flownMk.getLatLng(); if (distM(f, ll) > 0.3) addLayer(map, L.polyline([[f.lat, f.lng], [ll.lat, ll.lng]], lineOpts({ color: col, weight: 1.5, opacity: 0.9, dashArray: '3,4' }))); }
            const num = model.numbering[id];
            try {
                const mk = L.marker([ll.lat, ll.lng], { icon: L.divIcon({ className: 'aim-vv-ov', html: '<div class="aim-vv-ov-live" style="border-color:' + col + ';color:' + col + '">' + esc(num ? num.n : live.type_name) + '</div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: true, zIndexOffset: 450 });
                const flown = model.byId[id]; const d = flown ? fieldDiffs(flown, live) : [];
                mk.bindTooltip('<b>' + esc(num ? num.n : live.type_name) + '</b> · CURRENT saved plan (differs from what flew)' + (d.length ? '<br>' + d.map(x => esc(x.field) + ': ' + esc(x.before) + ' → ' + esc(x.after)).join('<br>') : ''), { direction: 'top', offset: [0, -10], opacity: 0.95 });
                if (addLayer(map, mk)) drawn++;
            } catch (e) { warn('live-diff marker failed:', e); }
        });
        if (drawn) log('live-diff overlay: ' + drawn + ' step(s) drawn where the saved plan differs from the flown one');
    }
    // Legend box on the map (bottom-left), built from the live color settings; collapses to a ? chip.
    let legendBox = null;
    function ensureLegend() {
        const c = document.querySelector('.leaflet-container');
        if (!c || !model || !settings.legend || !settings.overlay) { if (legendBox) { legendBox.remove(); legendBox = null; } return; }
        if (!legendBox || !c.contains(legendBox)) { legendBox = document.createElement('div'); legendBox.className = 'aim-vv-lg'; c.appendChild(legendBox); ['mousedown', 'dblclick', 'wheel', 'pointerdown', 'touchstart'].forEach(ev => legendBox.addEventListener(ev, e => e.stopPropagation())); }
        syncOverlayStyle();
        const sw = (html) => '<span class="aim-vv-lg__sw">' + html + '</span>';
        const nav = sw('<i style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' + COLOR_NAV + ';border:2px solid rgba(0,0,0,.6)"></i>');
        const snap = sw('<i style="display:inline-block;width:12px;height:12px;border-radius:3px;background:' + COLOR_SNAP + ';border:1px solid rgba(0,0,0,.6)"></i>');
        const aring = sw('<i style="display:inline-block;width:12px;height:12px;border-radius:50%;border:2px dashed ' + COLOR_ACTUAL + ';box-sizing:border-box"></i>');
        const dring = sw('<i style="display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid ' + COLOR_ACTUAL + ';box-sizing:border-box;background:' + COLOR_ACTUAL + '26"></i>');
        const fov = sw('<i style="display:inline-block;width:14px;height:10px;border:1.5px solid ' + COLOR_ACTUAL + ';background:' + COLOR_ACTUAL + '14"></i>');
        const live = sw('<i style="display:inline-block;width:12px;height:12px;border-radius:3px;border:2px solid ' + (settings.liveColor || '#ffe95f') + ';box-sizing:border-box;background:rgba(0,0,0,.5)"></i>');
        const ghost = sw('<i style="display:inline-block;width:12px;height:12px;border-radius:50%;border:2px dashed #fff;box-sizing:border-box"></i>');
        const line = (col, dash) => sw('<i style="display:inline-block;width:18px;border-top:2px ' + dash + ' ' + col + ';vertical-align:middle"></i>');
        const body = settings.legendOpen ? ''
            + '<div class="aim-vv-lg__row">' + nav + ' N# planned nav <span class="dim">(drone position)</span></div>'
            + '<div class="aim-vv-lg__row">' + snap + ' S# planned look-point / GPS aim point <span class="dim">— what you edit</span></div>'
            + '<div class="aim-vv-lg__row">' + line(COLOR_SNAP, 'dashed') + ' nav → what it looks at</div>'
            + '<div class="aim-vv-lg__row">' + aring + ' ACTUAL look-point <span class="dim">(where this picture looked)</span></div>'
            + '<div class="aim-vv-lg__row">' + dring + ' ' + fov + ' actual drone position + camera footprint</div>'
            + '<div class="aim-vv-lg__row">' + live + ' saved plan where it differs from what flew</div>'
            + '<div class="aim-vv-lg__row">' + ghost + ' pending edit (not saved)</div>'
            + '<div class="aim-vv-lg__row">' + line(settings.flownColor || '#fff', 'dashed') + ' flown path &nbsp; ' + line(COLOR_NAV, 'dashed') + ' next nav</div>'
            + '<div class="aim-vv-lg__row dim">strip: pink = RGB · orange = thermal · green = GEM · dashed = re-take</div>'
            : '';
        const html = '<div class="aim-vv-lg__head">' + (settings.legendOpen ? '<b>Video Validation legend</b> <span class="dim">▾ click anywhere to hide</span>' : '<b>?</b>') + '</div>' + body;
        if (legendBox.innerHTML !== html) legendBox.innerHTML = html;
        legendBox.classList.toggle('aim-vv-lg--closed', !settings.legendOpen);
        legendBox.setAttribute('data-aim-vv-lg-toggle', '1');   // the whole box toggles
        legendBox.title = settings.legendOpen ? 'click to hide the legend' : 'legend';
    }
    function onLegendToggle(e) {
        const t = e.target.closest && e.target.closest('[data-aim-vv-lg-toggle]'); if (!t) return;
        e.preventDefault(); e.stopPropagation();
        settings.legendOpen = !settings.legendOpen; saveSettings(); ensureLegend();
    }
    // Diagnostic: one JSON line per snapshot in this flight — type, plan fields, where its marker was drawn and why,
    // the matched picture's real pose, the actual look-point, terrain. Control Panel button "Dump snapshot geometry".
    function dumpGeometry() {
        if (!model) { warn('dump: no model'); return; }
        const groupOn = !!(settings.overlayGroup && ov.group);
        const inSlice = (st) => groupOn || !model.slice || (st.index_in_app >= model.slice.minIdx && st.index_in_app <= model.slice.maxIdx);
        log('GEOMETRY DUMP mission ' + model.mid + ' · slice ' + JSON.stringify(model.slice) + ' · lookPoints=' + settings.lookPoints + ' actualLook=' + settings.actualLookPoints + ' · demCache ' + Object.keys(demCache).length + ' entries (' + Object.values(demCache).filter(v => v == null).length + ' null)');
        let nav = null;
        model.plan.forEach(st => {
            if (st.type_name === 'navigate') nav = st;
            if (st.type_name !== 'snapshot' || !inSlice(st)) return;
            const num = model.numbering[st.id]; const mk = ov.stepMarkers[st.id];
            const shots = model.shots.filter(sh => sh.step && sh.step.id === st.id);
            const im = shots.length ? shots[0].primary : null;
            const g = nav && nav.location ? groundAt(nav.location) : null;
            const lp = (!isGps(st) && nav && g != null) ? lookPointFor(nav, st, g) : null;
            const row = {
                s: num ? num.n : '#' + st.index_in_app, type: isGps(st) ? 'GPS' : 'in-place', loc: st.location, value1: st.value1, eo: st.extra_options,
                nav: nav ? { n: (model.numbering[nav.id] || {}).n, loc: nav.location, value1: nav.value1, abs_alt: nav.extra_options && nav.extra_options.abs_alt, ground: g } : null,
                drawnAt: mk ? mk.getLatLng() : 'NO MARKER', lookPoint: lp ? { ll: lp.ll, dist_ft: +(lp.dist * M_TO_FT).toFixed(0), agl_ft: lp.agl != null ? +(lp.agl * M_TO_FT).toFixed(0) : null, capped: lp.capped } : null,
                picture: im ? { kind: im.kind, loc: im.location, alt: im.alt, hdg: im.drone_heading, pitch: im.camera_pitch, target: im.target_location, groundAtDrone: groundAt(im.location) } : 'none',
                shots: shots.length,
            };
            console.log(TAG + ' GEO ' + JSON.stringify(row));
        });
        console.log(TAG + ' GEO layers=' + ov.layers.length + ' stepMarkers=' + Object.keys(ov.stepMarkers).length + ' shotMarkers=' + Object.keys(ov.shotMarkers).length);
    }
    function onOverlayZoom() {
        if (!model || !ov.layers.length) return;
        const groupOn = !!(settings.overlayGroup && ov.group);
        if (!groupOn) return;
        const gate = (ov.map && typeof ov.map.getZoom === 'function' ? ov.map.getZoom() : 18) >= 17;
        if (gate !== ov.labelZoomGate) drawOverlay();
    }
    // Planned look-point of an in-place snapshot: from the nav (planned altitude above the terrain under it),
    // at the planned heading and camera angle, down to the ground (cap = rayCapFt). Terrain via /location_altitude/, cached.
    const demCache = {};
    function demCached(ll) {
        const k = (+ll.lat).toFixed(5) + ',' + (+ll.lng).toFixed(5);
        if (demCache[k] !== undefined) return Promise.resolve(demCache[k]);
        return dem(ll).then(v => { demCache[k] = v; return v; }).catch(e => { warn('dem:', e.message); demCache[k] = null; return null; });
    }
    function lookPointFor(nav, step, ground) {
        const e = step.extra_options || {};
        const alt = typeof nav.value1 === 'number' ? nav.value1 : (typeof e.abs_alt === 'number' ? e.abs_alt : null);
        const pitch = gimbalToDeg(e.pitch);
        if (alt == null || pitch == null || typeof e.heading !== 'number' || !nav.location) return null;
        const capM = (Number(settings.rayCapFt) || 500) * FT;
        const down = Math.tan(Math.abs(pitch) * RAD);
        let dist = (ground != null && down > 0.01) ? (alt - ground) / down : Infinity;
        let capped = false; if (!(dist > 0) || dist > capM) { dist = capM; capped = true; }
        const agl = ground != null ? alt - ground : null;
        return { ll: moveLL(nav.location, dist, e.heading), dist, capped, agl, slant: agl != null ? Math.sqrt(dist * dist + agl * agl) : null };
    }
    let lookLayers = [];
    let lookToken = 0;
    function drawLookPoints() { /* v0.24: look-points are where in-place S# squares are drawn (see inplaceDrawPos); no separate rings */ }
    // Percepto draws the flown path as one huge polyline; restyle it dashed white (it re-applies on tick).
    let flownLayer = null;
    function styleFlownPath(force) {
        const map = findMap(); if (!map) return;
        if (!flownLayer || !map.hasLayer(flownLayer)) {
            flownLayer = null; let best = 0;
            Object.values(map._layers || {}).forEach(l => { if (typeof l.getLatLngs === 'function' && !(l.options && l.options.className && /aim-/.test(l.options.className))) { const n = JSON.stringify(l.getLatLngs()).split('"lat"').length - 1; if (n > best && n > 500) { best = n; flownLayer = l; } } });
            if (!flownLayer) return;
        }
        if (!flownLayer.__aimVvOrig) flownLayer.__aimVvOrig = { color: flownLayer.options.color, dashArray: flownLayer.options.dashArray || null, opacity: flownLayer.options.opacity };
        const want = settings.flownDashed ? { color: settings.flownColor || '#ffffff', dashArray: '6,8', opacity: 0.9 } : flownLayer.__aimVvOrig;
        if (force || flownLayer.options.color !== want.color || (flownLayer.options.dashArray || null) !== (want.dashArray || null)) { try { flownLayer.setStyle(want); } catch (e) { warn('flown path style:', e); } }
        // The Map Styler restyles this path every second or so (inline). A stylesheet rule with !important beats
        // inline styles, so tag the element with a class and let CSS win instead of fighting it every tick.
        const el = flownLayer._path;
        if (el) {
            if (el.classList.toggle('aim-vv-flown', !!settings.flownDashed) !== !!settings.flownDashed) { /* toggled */ }
            ensureFlownRule(want.color);
        }
    }
    let flownRuleEl = null, flownRuleColor = null;
    function ensureFlownRule(color) {
        const sig = color + '|' + (Number(settings.flownLineW) || 3);
        if (flownRuleEl && document.head.contains(flownRuleEl) && flownRuleColor === sig) return;
        if (!flownRuleEl || !document.head.contains(flownRuleEl)) { flownRuleEl = document.createElement('style'); flownRuleEl.id = 'aim-vv-flown-style'; document.head.appendChild(flownRuleEl); }
        flownRuleColor = sig;
        const w = Number(settings.flownLineW) || 3;
        flownRuleEl.textContent = 'path.aim-vv-flown { stroke: ' + color + ' !important; stroke-width: ' + w + 'px !important; stroke-dasharray: 6 8 !important; stroke-opacity: .9 !important; }';
    }
    let activeOverlayKey = null;
    function markActiveOverlay() {
        if (!model) return;
        const v = videoEl();
        const selShot = selectedRec && model.shots.find(x => x.images.includes(selectedRec));
        const sh = (v && !v.paused) ? (lastPlayheadShot || selShot || null) : (selShot || lastPlayheadShot || null);
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
    // Group panel: the Mission Data block becomes two columns — Percepto's fields left, our flight list right.
    // Per-flight metadata (name / when / duration / images) from the mission-log list endpoint (one call),
    // per-mission fallback for ids the list omits. Step ranges arrive when the group positions load.
    const groupMeta = {};          // mid -> { name, when, duration, image_count, drone_name, state, landed }
    let groupMetaLoading = false;
    let groupHost = null, groupPanelEl = null, groupHostLogged = false;
    function fmtWhen(iso) {
        if (!iso) return '–';
        try { const d = new Date(iso); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
        catch (e) { return String(iso).slice(0, 16); }
    }
    function groupIds() {
        if (!model) return [];
        const ids = [Number(model.mid)].concat((model.mission.attached_missions || []).map(Number));
        return Array.from(new Set(ids.filter(x => x > 0)));
    }
    function loadGroupMeta() {
        if (!model || groupMetaLoading) return;
        const ids = groupIds().filter(id => !groupMeta[id]);
        if (!ids.length) return;
        groupMetaLoading = true;
        const m0 = model.mission;
        groupMeta[Number(model.mid)] = { name: m0.name || m0.app_name, when: m0.when, duration: m0.duration, image_count: m0.image_count, drone_name: m0.drone_name, state: m0.state, landed: m0.landed };
        const rest = ids.filter(id => id !== Number(model.mid));
        const end = new Date(), start = new Date(); start.setFullYear(start.getFullYear() - 2);
        const fmt = (d) => d.toISOString().slice(0, 10);
        const params = { site_id: Number(model.sid), drones: [], missionTypes: [], missionId: rest, users: [], state: null, takeoffCompleted: false, start: fmt(start), end: fmt(end), last_mission_id: -1 };
        const only = 'id,mission_group_id,drone_name,when,image_count,created_by_username,app_name,name,type,state,duration,landed';
        const url = '/missions/?site_id=' + encodeURIComponent(model.sid) + '&params=' + encodeURIComponent(JSON.stringify(params)) + '&only=' + encodeURIComponent(only);
        (rest.length ? getJSON(url) : Promise.resolve({})).then(j => {
            const rows = ((j && j.past_missions) || []).concat((j && j.upcoming_missions) || []);
            rows.forEach(r => { if (rest.includes(Number(r.id))) groupMeta[Number(r.id)] = { name: r.name || r.app_name, when: r.when, duration: r.duration, image_count: r.image_count, drone_name: r.drone_name, state: r.state, landed: r.landed }; });
            const missing = rest.filter(id => !groupMeta[id]);
            if (missing.length) log('group meta: list endpoint returned ' + (rest.length - missing.length) + '/' + rest.length + ' — fetching ' + missing.length + ' individually');
            return missing.reduce((pr, id) => pr.then(() => getJSON('/missions/' + id + '/').then(m => { groupMeta[id] = { name: m.name || m.app_name, when: m.when, duration: m.duration, image_count: m.image_count, drone_name: m.drone_name, state: m.state, landed: m.landed }; }).catch(e => { warn('group meta ' + id + ':', e.message); groupMeta[id] = { error: e.message }; })), Promise.resolve());
        }).catch(e => { warn('group meta list failed:', e.message); return rest.reduce((pr, id) => pr.then(() => getJSON('/missions/' + id + '/').then(m => { groupMeta[id] = { name: m.name || m.app_name, when: m.when, duration: m.duration, image_count: m.image_count, drone_name: m.drone_name, state: m.state, landed: m.landed }; }).catch(e2 => { groupMeta[id] = { error: e2.message }; })), Promise.resolve()); })
        .then(() => { groupMetaLoading = false; renderLegend(); });
    }
    function findGroupHost() {
        let host = document.querySelector('.mp-data');
        if (!host) {
            host = Array.from(document.querySelectorAll('.mp-right div')).find(d => d.children.length >= 2 && /^MISSION DATA/i.test(d.textContent.trim()) && d.textContent.length < 600) || null;
        }
        if (host && !groupHostLogged) {
            groupHostLogged = true;
            log('group panel host: ' + host.tagName + '.' + String(host.className).slice(0, 60) + ' → children: ' + Array.from(host.children).map(c => c.tagName + '.' + String(c.className).slice(0, 40)).join(', '));
        }
        return host;
    }
    let legendEl = null;   // kept as an alias of the panel for older call sites
    function renderLegend() {
        if (!model) return;
        const host = findGroupHost();
        if (!host) return;
        if (groupHost !== host || !groupPanelEl || !host.contains(groupPanelEl)) {
            groupHost = host;
            host.classList.add('aim-vv-split');
            groupPanelEl = document.createElement('div');
            groupPanelEl.className = 'aim-vv-group';
            host.appendChild(groupPanelEl);
            legendEl = groupPanelEl;
        }
        const ids = groupIds();
        // Order: by flight time when known (this flight's `when` is always known), else by id.
        const rows = ids.map(mid => {
            const meta = groupMeta[mid] || {};
            const g = ov.group ? ov.group.find(x => x.mid === mid) : null;
            return { mid, meta, g, self: mid === Number(model.mid), when: meta.when ? new Date(meta.when).getTime() : (g && g.first) || 0 };
        }).sort((a, b) => (a.when || 0) - (b.when || 0) || a.mid - b.mid);
        const groupOn = !!(settings.overlayGroup && ov.group);
        let html = '<div class="aim-vv-group__head"><b>Mission group ' + esc(model.mission.mission_group_id) + '</b> <span class="dim">· ' + ids.length + ' flight' + (ids.length === 1 ? '' : 's') + '</span>'
            + ' <a href="#" data-aim-vv="' + (ov.group ? 'toggle-group' : 'load-group') + '" class="aim-vv-group__toggle">'
            + (ov.groupLoading ? 'loading flights…' : (ov.group ? (settings.overlayGroup ? 'this flight only' : 'whole mission on map') : 'whole mission on map')) + '</a></div>'
            + (groupOn ? '<div class="dim aim-vv-group__hint">colors = flight that flew each step · grey = not flown yet · labels at close zoom</div>' : '');
        html += '<div class="aim-vv-group__scroll"><table class="aim-vv-group__list">' + rows.map((r, i) => {
            const m = r.meta, g = r.g;
            const color = g ? g.color : (r.self ? '#5fe3ff' : '#8a8f99');
            const steps = g ? (g.minIdx != null ? g.minIdx + '–' + g.maxIdx : (g.error ? 'error' : '∅')) : '';
            const dur = typeof m.duration === 'number' ? mmss(m.duration / 1000) : '';
            const url = location.origin + '/#/site/' + model.sid + '/control-panel/past-mission/' + r.mid;
            return '<tr class="' + (r.self ? 'aim-vv-group__self' : '') + '">'
                + '<td><span style="color:' + color + '">●</span> <span class="dim">#' + (i + 1) + '</span></td>'
                + '<td>' + (r.self ? '<b>' + r.mid + '</b> <span class="dim">(this)</span>' : '<a href="' + url + '" target="_blank" rel="noopener" data-aim-vv="open-flight" data-mid="' + r.mid + '" title="open in a new tab">' + r.mid + ' ↗</a>') + '</td>'
                + '<td class="dim">' + esc(fmtWhen(m.when)) + '</td>'
                + '<td class="dim">' + (dur || (m.error ? '<span class="bad">meta error</span>' : (groupMetaLoading ? '…' : ''))) + '</td>'
                + '<td class="dim">' + (m.image_count != null ? m.image_count + ' img' : '') + '</td>'
                + '<td class="dim">' + (steps ? 'steps ' + steps : (ov.groupLoading ? '…' : '')) + '</td>'
                + '</tr>';
        }).join('') + '</table></div>';
        if (groupPanelEl.innerHTML !== html) {   // called every tick — only touch the DOM on change, keep the scroll position
            const sc = groupPanelEl.querySelector('.aim-vv-group__scroll'); const top = sc ? sc.scrollTop : 0;
            groupPanelEl.innerHTML = html;
            const sc2 = groupPanelEl.querySelector('.aim-vv-group__scroll'); if (sc2 && top) sc2.scrollTop = top;
        }
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
            log('opened flight ' + a.dataset.mid + ' in a new tab');
        }
    }

    // ===============================================================
    // PHASE 2 — EDIT: nudge / adopt / convert / delete / duplicate on a WORKING COPY of the plan,
    // ghost preview on the map, review diff, then ONE full-mission save with rails.
    // Writes: POST /available_app/ (body shape LEARNED from a real Percepto save — Delete Guard banks it
    // in localStorage 'aim-mission-post-shape-v1'; we fail closed without it). Lite mode blocks writes.
    // ===============================================================
    const SHAPE_KEY = 'aim-mission-post-shape-v1';
    const BACKUPS_KEY = 'aim-vv-backups';        // GM: last 20 pre-write app snapshots
    const REPORTS_KEY = 'aim-vv-corrections';    // GM: last 200 before/after reports
    const ed = { work: null, panelEl: null, reviewEl: null, ghosts: [], tempId: -1, open: false, busy: false, log: [] };
    function edLog(what, step) { ed.log.push({ at: Date.now(), what, step: step ? stepLabel(step) : '' }); }
    const deepCopy = (o) => JSON.parse(JSON.stringify(o));
    const gimbalFromDeg = (deg) => Math.round(2000 + Math.max(-90, Math.min(0, deg)) * (1000 / 90));
    const FT = 1 / M_TO_FT;
    function isLite() { try { return localStorage.getItem('aim-mode') !== 'full'; } catch (e) { return true; } }
    function moveLL(ll, meters, bearing) { const p = offsetLatLng(ll, meters, bearing); return { lat: +p[0].toFixed(8), lng: +p[1].toFixed(8) }; }

    // Own CSRF sniffer (Delete Guard exposes window.top.__AIM_CSRF too — use either).
    let sniffedCsrf = null;
    function sniffHeaders(h) {
        try {
            if (!h) return;
            const take = (k, v) => { if (String(k).toLowerCase() === 'x-csrftoken' && v) sniffedCsrf = String(v); };
            if (typeof h.forEach === 'function') h.forEach((v, k) => take(k, v));
            else if (Array.isArray(h)) h.forEach(p => take(p[0], p[1]));
            else Object.keys(h).forEach(k => take(k, h[k]));
        } catch (e) { /* best effort */ }
    }
    function installCsrfSniffer() {
        try {
            const w = pageWin;
            if (w.__aimVvSniff) return;
            w.__aimVvSniff = true;
            const of = w.fetch;
            w.fetch = function(input, init) { sniffHeaders((init && init.headers) || (input && input.headers)); return of.apply(this, arguments); };
            const oh = w.XMLHttpRequest.prototype.setRequestHeader;
            w.XMLHttpRequest.prototype.setRequestHeader = function(k, v) { if (String(k).toLowerCase() === 'x-csrftoken' && v) sniffedCsrf = String(v); return oh.apply(this, arguments); };
        } catch (e) { warn('csrf sniffer failed:', e); }
    }
    function getCsrf() {
        if (sniffedCsrf) return sniffedCsrf;
        try { if (pageWin.top.__AIM_CSRF) return pageWin.top.__AIM_CSRF; } catch (e) { /* cross-origin */ }
        try { const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/); if (m) return decodeURIComponent(m[1]); } catch (e) { /* no cookie */ }
        return null;
    }
    function loadShape() {
        try { const raw = localStorage.getItem(SHAPE_KEY); if (raw) return JSON.parse(raw); } catch (e) { /* fall through */ }
        try { return pageWin.top.__AIM_MISSION_SHAPE || null; } catch (e) { return null; }
    }

    // ---- working copy ----
    function liveBase() { return (model && model.liveAligned) ? model.plan.map(st => model.liveById[st.id]) : (model ? model.plan : []); }
    function edEnsureWork() { if (!ed.work && model) ed.work = deepCopy(liveBase()); return ed.work; }
    function edResetWork() { ed.work = model ? deepCopy(liveBase()) : null; ed.log = []; drawGhosts(); renderEdit(); }
    function editsBlocked() {
        if (!model) return 'no mission loaded';
        if (model.liveError) return 'could not read the live mission (' + model.liveError + ')';
        if (!model.live) return 'live mission not loaded';
        if (!model.liveAligned) return 'the mission has been restructured since this flight (' + model.live.length + ' steps now vs ' + model.plan.length + ' flown) — edit it in the Mission Bank';
        return null;
    }
    function wk(id) { return edEnsureWork().find(x => x.id === id) || null; }
    function wkNavOf(step) { const w = edEnsureWork(); for (let k = w.indexOf(step) - 1; k >= 0; k--) if (w[k].type_name === 'navigate') return w[k]; return null; }
    function origOf(id) { return (model.liveAligned && model.liveById[id]) || model.byId[id] || null; }
    function stepLabel(step) { const n = model.numbering[step.id]; return n ? n.n : (step.type_name + ' #' + (step.index_in_app != null ? step.index_in_app : '+')); }
    function isGps(step) { return !!(step.location && typeof step.location.lat === 'number'); }
    function eo(step) { if (!step.extra_options) step.extra_options = {}; return step.extra_options; }
    // Current in-place heading/pitch or GPS-derived pose of a WORK step.
    function wkPose(step) {
        const nav = wkNavOf(step);
        if (isGps(step)) {
            const r = { type: 'gps', nav, heading: null, pitchDeg: null };
            if (nav && nav.location) { r.heading = bearingDeg(nav.location, step.location); const h = distM(nav.location, step.location); if (typeof step.value1 === 'number' && typeof nav.value1 === 'number') r.pitchDeg = Math.atan2(step.value1 - nav.value1, h) / RAD; r.range = h; }
            return r;
        }
        const e = step.extra_options || {};
        return { type: 'inplace', nav, heading: typeof e.heading === 'number' ? e.heading : 0, pitchDeg: gimbalToDeg(e.pitch) != null ? gimbalToDeg(e.pitch) : 0 };
    }
    // Set a nav's altitude keeping its abs_alt offset (abs_alt tracks value1 by a small constant on MSL sites).
    function setNavAlt(nav, m) {
        const old = nav.value1;
        nav.value1 = +m.toFixed(2);
        const e = eo(nav);
        if (typeof e.abs_alt === 'number' && typeof old === 'number') e.abs_alt = +(e.abs_alt + (nav.value1 - old)).toFixed(2);
        // Snapshots hanging off this nav mirror abs_alt (they carry no altitude of their own).
        const w = ed.work; const i = w.indexOf(nav);
        for (let k = i + 1; k < w.length && w[k].type_name !== 'navigate'; k++) if (w[k].type_name === 'snapshot' && !isGps(w[k]) && w[k].extra_options && typeof w[k].extra_options.abs_alt === 'number' && typeof e.abs_alt === 'number') w[k].extra_options.abs_alt = e.abs_alt;
    }
    // Picture-relative edits. Amounts: deg for turn/tilt, metres for moves/alt.
    function edTurn(step, dDeg) {           // left(-) / right(+)
        if (isGps(step)) {
            // GPS: dDeg is metres of sideways movement at the aim point — applied as a ROTATION around the nav
            // so the range never changes (stepping sideways in a straight line walks the point outward).
            const nav = wkNavOf(step); if (!nav || !nav.location) return;
            const r = distM(nav.location, step.location); if (!(r > 0.5)) return;
            const brg = bearingDeg(nav.location, step.location) + (dDeg / r) / RAD;
            step.location = moveLL(nav.location, r, brg);
            return;
        }
        const e = eo(step); e.heading = ((((typeof e.heading === 'number' ? e.heading : 0) + dDeg) % 360) + 360) % 360;
        delete step._aim;   // turning the camera is a deliberate change of aim
    }
    function edTilt(step, dDeg) {           // up(+) / down(-) in picture terms → camera angle
        if (isGps(step)) { step.value1 = +(((typeof step.value1 === 'number') ? step.value1 : 0) + dDeg).toFixed(2); return; }   // GPS: dDeg used as metres of target alt
        const e = eo(step); e.pitch = gimbalFromDeg((gimbalToDeg(e.pitch) != null ? gimbalToDeg(e.pitch) : 0) + dDeg);
        delete step._aim;   // tilting the camera is a deliberate change of aim
    }
    // In-place snapshots aim at a ground point implied by heading + angle + height. "Closer / farther" and "alt ±" keep
    // THAT point fixed: the nav moves (or climbs) and the camera re-tilts to stay on it. The look-point distance changes.
    // The AIM of an in-place snapshot is fixed ONCE from its ORIGINAL pose (original nav position, heading, angle,
    // terrain under the original nav) and every later move re-aims at that same point. Recomputing it from the rounded
    // heading / gimbal units after each move let the aim creep a little per step. Capped (grazing) shots get an aim at
    // the cap distance at the ray's altitude there, so they re-aim too instead of sliding with the nav.
    function ensureAim(step) {
        if (step._aim) return step._aim;
        const nav = wkNavOf(step); if (!nav || !nav.location) return null;
        const oNav = origOf(nav.id) || nav, oStep = origOf(step.id) || step;
        const src = (oNav.location && (oStep.extra_options || {}).heading != null) ? { nav: oNav, step: oStep } : { nav, step };
        const g = groundAt(src.nav.location); if (g == null) return null;
        const lp = lookPointFor(src.nav, src.step, g); if (!lp) return null;
        const e = src.step.extra_options || {};
        const alt = typeof src.nav.value1 === 'number' ? src.nav.value1 : e.abs_alt;
        const aimAlt = lp.capped ? alt - lp.dist * Math.tan(Math.abs(gimbalToDeg(e.pitch)) * RAD) : g;
        step._aim = { lat: lp.ll.lat, lng: lp.ll.lng, alt: aimAlt, capped: lp.capped };
        return step._aim;
    }
    function inplaceLook(step) {
        const nav = wkNavOf(step); if (!nav || !nav.location) return null;
        const aim = ensureAim(step); if (!aim) return null;
        return { nav, aim, dist: distM(nav.location, aim) };
    }
    function retilt(step, nav, aim) {
        const e = eo(step);
        const alt = typeof nav.value1 === 'number' ? nav.value1 : e.abs_alt;
        const h = distM(nav.location, aim); if (!(h > 0.5) || alt == null) return;
        e.pitch = gimbalFromDeg(-Math.atan2(alt - aim.alt, h) / RAD);
        e.heading = Math.round(bearingDeg(nav.location, aim)) % 360;
    }
    // Move a nav; when "keep aim" is on, every in-place snapshot on it re-aims (heading + camera angle) at the ground
    // point it was looking at from the OLD position. GPS snapshots keep their aim point by nature.
    function moveNavKeepAim(nav, newLL) {
        if (!nav || !nav.location) return;
        const w = edEnsureWork(); const i = w.indexOf(nav);
        const snaps = []; for (let k = i + 1; k < w.length && w[k].type_name !== 'navigate'; k++) if (w[k].type_name === 'snapshot' && !isGps(w[k])) snaps.push(w[k]);
        const aims = settings.navKeepAim ? snaps.map(st => ensureAim(st)) : [];
        nav.location = { lat: +(+newLL.lat).toFixed(8), lng: +(+newLL.lng).toFixed(8) };
        snaps.forEach((st, k) => { if (aims[k]) retilt(st, nav, aims[k]); });
    }
    function edRange(step, dM) {            // closer(-) / farther(+)
        const nav = wkNavOf(step); if (!nav || !nav.location) return;
        if (isGps(step)) { const brg = bearingDeg(nav.location, step.location); step.location = moveLL(step.location, Math.abs(dM), dM > 0 ? brg : brg + 180); return; }
        const look = inplaceLook(step);
        const h = wkPose(step).heading;
        if (!look) { nav.location = moveLL(nav.location, Math.abs(dM), dM < 0 ? h : h + 180); return; }   // no terrain: plain move
        const newDist = Math.max(3, look.dist + dM);
        nav.location = moveLL(look.aim, newDist, (bearingDeg(look.aim, nav.location)) % 360);   // back off from the aim point along the current line
        retilt(step, nav, look.aim);
    }
    function edAlt(step, dM) {
        const nav = wkNavOf(step); if (!nav || typeof nav.value1 !== 'number') return;
        const look = !isGps(step) ? inplaceLook(step) : null;
        setNavAlt(nav, nav.value1 + dM);
        if (look) retilt(step, nav, look.aim);
    }
    function edAdopt(step, shot) {
        const im = shot.primary; const nav = wkNavOf(step); if (!im || !nav) return;
        if (im.location) nav.location = { lat: +im.location.lat, lng: +im.location.lng };
        if (typeof im.alt === 'number') setNavAlt(nav, im.alt);
        if (!isGps(step)) { const e = eo(step); if (typeof im.drone_heading === 'number') e.heading = im.drone_heading; if (typeof im.camera_pitch === 'number') e.pitch = gimbalFromDeg(im.camera_pitch); }
    }
    function dem(ll) { return getJSON('/location_altitude/?location=' + encodeURIComponent(JSON.stringify({ lat: ll.lat, lng: ll.lng }))).then(j => (j && typeof j.altitude === 'number') ? j.altitude : null); }
    // Convert an in-place snapshot to a GPS aim point by casting the ACTUAL camera ray to the ground (cap = rayCapFt).
    function edConvertGps(step, shot) {
        const im = shot.primary; if (!im || !im.location || typeof im.drone_heading !== 'number' || typeof im.camera_pitch !== 'number') { toast('Convert needs the actual shot pose (position, heading, camera angle)', true); return Promise.resolve(false); }
        const nav = wkNavOf(step); if (!nav) return Promise.resolve(false);
        const capM = (Number(settings.rayCapFt) || 500) * FT;
        return dem(im.location).then(ground => {
            const alt = typeof im.alt === 'number' ? im.alt : nav.value1;
            const down = Math.tan(Math.abs(im.camera_pitch) * RAD);
            let dist = (ground != null && down > 0.01) ? (alt - ground) / down : Infinity;
            let capped = false; if (!(dist > 0) || dist > capM) { dist = capM; capped = true; }
            const aim = moveLL(im.location, dist, im.drone_heading);
            const aimAlt = capped ? alt - dist * down : ground;
            return dem(aim).then(g2 => {
                const finalAlt = (!capped && g2 != null) ? g2 : aimAlt;
                nav.location = { lat: +im.location.lat, lng: +im.location.lng }; setNavAlt(nav, alt);
                step.location = aim; step.value1 = +finalAlt.toFixed(2);
                const e = eo(step); e.heading = 0; e.pitch = 2000;   // placeholders Percepto stores on GPS snapshots
                log('convert → GPS aim point ' + aim.lat + ',' + aim.lng + ' alt ' + fmtAlt(finalAlt) + ' (' + fmtDist(dist) + (capped ? ', CAPPED' : '') + ', ground ' + (ground != null ? fmtAlt(ground) : 'n/a') + ')');
                return true;
            });
        }).catch(e => { warn('convert failed:', e); toast('Convert failed: ' + e.message, true); return false; });
    }
    // A snapshot "block" = the snapshot + the camera/wait steps that follow it up to the next snapshot/nav/flag/returnHome.
    function blockOf(step) {
        const w = edEnsureWork(); const i = w.indexOf(step); if (i < 0) return null;
        let j = i + 1;
        while (j < w.length && !['snapshot', 'navigate', 'flag pole', 'returnHome', 'takeoff'].includes(w[j].type_name)) j++;
        return { start: i, end: j };
    }
    function edDeleteBlock(step) { const b = blockOf(step); if (!b) return; ed.work.splice(b.start, b.end - b.start); }
    function edDuplicateBlock(step) {
        const b = blockOf(step); if (!b) return null;
        const clone = ed.work.slice(b.start, b.end).map(x => { const c = deepCopy(x); c.id = ed.tempId--; c._new = true; return c; });
        ed.work.splice(b.end, 0, ...clone);
        return clone[0];
    }
    // ---- diff ----
    function F(v) { return typeof v === 'number' ? +v.toFixed(2) : v; }
    function canon(o) { if (o == null || typeof o !== 'object') return typeof o === 'number' ? +o.toFixed(2) : o; if (Array.isArray(o)) return o.map(canon); const out = {}; Object.keys(o).sort().forEach(k => { out[k] = canon(o[k]); }); return out; }
    function stepSig(st) { return JSON.stringify({ t: st.type, l: st.location ? [+(+st.location.lat).toFixed(7), +(+st.location.lng).toFixed(7)] : null, v1: F(st.value1), v2: F(st.value2), e: canon(st.extra_options || {}) }); }
    function fieldDiffs(a, b) {
        const out = [];
        const eqLL = (x, y) => (!x && !y) || (x && y && Math.abs(x.lat - y.lat) < 1e-7 && Math.abs(x.lng - y.lng) < 1e-7);
        if (!eqLL(a.location, b.location)) out.push({ field: 'position', before: a.location ? a.location.lat.toFixed(6) + ', ' + a.location.lng.toFixed(6) : '–', after: b.location ? b.location.lat.toFixed(6) + ', ' + b.location.lng.toFixed(6) : '–', note: (a.location && b.location) ? fmtDist(distM(a.location, b.location)) + ' ' + compass16(bearingDeg(a.location, b.location)) : '' });
        if (F(a.value1) !== F(b.value1)) out.push({ field: a.type_name === 'navigate' ? 'drone alt' : (isGps(b) ? 'target alt' : 'value1'), before: fmtAlt(a.value1), after: fmtAlt(b.value1) });
        const ea = a.extra_options || {}, eb = b.extra_options || {};
        ['heading', 'pitch', 'abs_alt'].forEach(k => {
            if (F(ea[k]) !== F(eb[k])) out.push({ field: k === 'pitch' ? 'camera angle' : (k === 'abs_alt' ? 'abs alt' : k), before: k === 'pitch' ? (gimbalToDeg(ea[k]) != null ? gimbalToDeg(ea[k]).toFixed(0) + '°' : '–') : (k === 'abs_alt' ? fmtAlt(ea[k]) : (ea[k] != null ? ea[k] + '°' : '–')), after: k === 'pitch' ? gimbalToDeg(eb[k]).toFixed(0) + '°' : (k === 'abs_alt' ? fmtAlt(eb[k]) : eb[k] + '°') });
        });
        return out;
    }
    function edDiff() {
        const w = edEnsureWork(); const out = [];
        liveBase().forEach(o => {
            const n = w.find(x => x.id === o.id);
            if (!n) { out.push({ id: o.id, label: stepLabel(o), kind: 'deleted', type: o.type_name }); return; }
            if (stepSig(o) !== stepSig(n)) fieldDiffs(o, n).forEach(d => out.push(Object.assign({ id: o.id, label: stepLabel(o), kind: 'changed', type: o.type_name }, d)));
        });
        w.forEach((n, i) => { if (n._new) out.push({ id: n.id, label: n.type_name + ' (new, after #' + (i > 0 ? (w[i - 1].index_in_app != null ? w[i - 1].index_in_app : '+') : 0) + ')', kind: 'added', type: n.type_name }); });
        return out;
    }
    // ---- ghosts on the map ----
    function drawGhosts() {
        const map = findMap(), L = getL();
        ed.ghosts.forEach(l => { try { map && map.removeLayer(l); } catch (e) { /* gone */ } }); ed.ghosts = [];
        if (!map || !L || !ed.work || !settings.overlay) return;
        const add = (layer) => { try { layer.addTo(map); ed.ghosts.push(layer); } catch (e) { warn('ghost failed:', e); try { map.removeLayer(layer); } catch (e2) {} } };
        const lineOpts = (o) => Object.assign({ interactive: false }, ov.svg ? { renderer: ov.svg } : {}, o);
        const changed = new Set(edDiff().map(d => d.id));
        ed.work.forEach(st => {
            if (!changed.has(st.id) && !st._new) return;
            const o = origOf(st.id);
            let ll = null;
            let lookLine = null;
            if (st.type_name === 'navigate' && st.location) ll = st.location;
            else if (st.type_name === 'snapshot') { const nav = wkNavOf(st); if (isGps(st)) ll = st.location; else if (st._aim && nav && nav.location) { ll = { lat: st._aim.lat, lng: st._aim.lng }; lookLine = [[nav.location.lat, nav.location.lng], [st._aim.lat, st._aim.lng]]; } else { const dp = nav ? inplaceDrawPos(nav, st) : null; if (dp) { ll = { lat: dp.ll[0], lng: dp.ll[1] }; lookLine = [[nav.location.lat, nav.location.lng], dp.ll]; } else ll = nav && nav.location; } }
            if (!ll) return;
            if (lookLine) add(L.polyline(lookLine, lineOpts({ color: '#fff', weight: 1.5, opacity: 0.8, dashArray: '2,5' })));
            const col = st.type_name === 'navigate' ? COLOR_NAV : COLOR_SNAP;
            if (o && o.location && st.location && distM(o.location, st.location) > 0.2) add(L.polyline([[o.location.lat, o.location.lng], [st.location.lat, st.location.lng]], lineOpts({ color: '#fff', weight: 1.5, opacity: 0.8, dashArray: '2,4' })));
            else if (o && lookLine && ov.stepMarkers[o.id]) { const from = ov.stepMarkers[o.id].getLatLng(); if (distM(from, ll) > 0.2) add(L.polyline([[from.lat, from.lng], [ll.lat, ll.lng]], lineOpts({ color: '#fff', weight: 1.5, opacity: 0.8, dashArray: '2,4' }))); }
            if (st.type_name === 'snapshot' && !isGps(st) && !lookLine) { const h = wkPose(st).heading; add(L.polyline([[ll.lat, ll.lng], offsetLatLng(ll, 22, h)], lineOpts({ color: '#fff', weight: 2, opacity: 0.9, dashArray: '3,3' }))); }
            try { add(L.marker([ll.lat, ll.lng], { icon: L.divIcon({ className: 'aim-vv-ov', html: '<div class="aim-vv-ov-ghost" style="border-color:' + col + '">' + esc(stepLabel(st)) + '</div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false, zIndexOffset: 700 })); } catch (e) { warn('ghost marker failed:', e); }
        });
    }
    // ---- panel ----
    function currentShotForEdit() { if (!selectedRec || !model) return null; return model.shots.find(sh => sh.images.includes(selectedRec)) || null; }
    function ensureEditPanel() {
        if (!settings.edit || !ed.open) { if (ed.panelEl) { ed.panelEl.remove(); ed.panelEl = null; } return null; }
        const card = ensureCard(); if (!card) return null;
        if (ed.panelEl && card.parentElement.contains(ed.panelEl)) return ed.panelEl;
        ed.panelEl = document.createElement('div'); ed.panelEl.className = 'aim-vv-card aim-vv-edit';
        card.insertAdjacentElement('afterend', ed.panelEl);
        return ed.panelEl;
    }
    function renderEdit(force) {
        const el = ensureEditPanel(); if (!el || !model) return;
        edEnsureWork();
        if (scrub && scrub.engaged && !force) { refreshScrubValues(); return; }
        const shot = currentShotForEdit();
        const step = shot && shot.step && shot.step.type_name === 'snapshot' ? wk(shot.step.id) : null;
        const diff = edDiff();
        const btn = (act, txt, title, extra) => '<button type="button" data-aim-vv-ed="' + act + '" ' + (extra || '') + ' title="' + esc(title || '') + '">' + txt + '</button>';
        let html = '';
        const blocked = editsBlocked();
        if (blocked) { html = '<div><b>Adjust</b> <span class="warn">— editing unavailable: ' + esc(blocked) + '</span></div>'; if (el.innerHTML !== html) el.innerHTML = html; return; }
        if (model.liveApp && Number(model.liveApp.id) !== Number(model.mission.app && model.mission.app.id)) html += '<div class="dim">live mission app <b>' + esc(model.liveApp.id) + '</b> (this flight\'s record is a frozen copy, ' + esc(model.mission.app.id) + ') · resolved ' + esc(model.liveApp.__aimVvHow || '') + '</div>';
        if (model.liveDiff && model.liveDiff.length) html += '<div class="warn">⚠ the live plan differs from what flew on ' + model.liveDiff.length + ' step(s) (' + esc(model.liveDiff.map(id => (model.numbering[id] || {}).n || '#' + model.byId[id].index_in_app).join(', ')) + ') — the map shows the FLOWN plan; the saved plan is drawn in yellow where it differs; edits start from the saved values</div>';
        if (!step) {
            html += '<div><b>Adjust</b> <span class="dim">— select a snapshot (click a thumbnail) to edit its step' + (shot && shot.step ? ' · active step is a ' + esc(shot.step.type_name) + ', not a snapshot' : '') + '</span></div>';
        } else {
            const pose = wkPose(step), nav = pose.nav, gps = isGps(step);
            const sc = (kind, txt, title) => '<b data-aim-vv-scrub="' + kind + '" class="aim-vv-scrub" title="' + esc(title) + ' — drag ↔ to change (Shift ×5)">' + txt + '</b>';
            const sd = Number(settings.stepDeg) || 1, sp = Number(settings.stepPitch) || 1, sf = Number(settings.stepFt) || 1, sa = Number(settings.stepAltFt) || 1;
            html += '<div><b>Adjust ' + esc(stepLabel(step)) + '</b> <span class="dim">· ' + (gps ? 'GPS aim point' : 'in-place') + ' · nav ' + (nav ? esc(stepLabel(nav)) : '–') + ' · steps ' + sd + '° / ' + sp + '° / ' + sf + ' ft / ' + sa + ' ft alt · Shift = ×5</span></div>';
            html += '<div class="aim-vv-edit__row"><span class="dim">picture</span>'
                + btn('turn', '◀ left', gps ? 'Move the aim point ' + sf + ' ft to the left of the nav→aim line' : 'Turn the heading ' + sd + '° left', 'data-n="-1"')
                + btn('turn', 'right ▶', gps ? 'Move the aim point ' + sf + ' ft to the right' : 'Turn the heading ' + sd + '° right', 'data-n="1"')
                + btn('tilt', '▲ up', gps ? 'Raise the target altitude ' + sa + ' ft' : 'Tilt the camera ' + sp + '° up', 'data-n="1"')
                + btn('tilt', '▼ down', gps ? 'Lower the target altitude ' + sa + ' ft' : 'Tilt the camera ' + sp + '° down', 'data-n="-1"')
                + btn('range', 'closer', gps ? 'Move the aim point ' + sf + ' ft toward the nav' : 'Bring the nav ' + sf + ' ft toward what it is looking at (camera re-tilts to stay on it)', 'data-n="-1"')
                + btn('range', 'farther', gps ? 'Move the aim point ' + sf + ' ft away from the nav' : 'Back the nav ' + sf + ' ft away from what it is looking at (camera re-tilts)', 'data-n="1"')
                + btn('alt', 'alt −', 'Drone (nav) altitude −' + sa + ' ft' + (gps ? '' : ' (camera re-tilts to keep the look-point)'), 'data-n="-1"')
                + btn('alt', 'alt +', 'Drone (nav) altitude +' + sa + ' ft' + (gps ? '' : ' (camera re-tilts to keep the look-point)'), 'data-n="1"') + '</div>';
            html += '<div class="aim-vv-edit__row"><span class="dim">now</span> heading ' + sc('heading', pose.heading != null ? pose.heading.toFixed(0) + '°' : '–', gps ? 'aim point sideways, 1 ft per step' : 'heading') + ' · camera ' + sc('camera', pose.pitchDeg != null ? pose.pitchDeg.toFixed(0) + '°' : '–', gps ? 'target altitude' : 'camera angle') + ' · drone alt ' + sc('alt', fmtAlt(nav ? nav.value1 : null), 'drone (nav) altitude')
                + (gps ? ' · target alt ' + sc('target-alt', fmtAlt(step.value1), 'target altitude') + ' · range ' + sc('range', fmtDist(pose.range), 'aim point closer / farther') : ' · look-point ' + sc('range', (function() { const lk = inplaceLook(step); if (lk) { const h = (typeof nav.value1 === 'number' && lk.aim.alt != null) ? nav.value1 - lk.aim.alt : null; return fmtDist(lk.dist) + (h != null ? ' / ' + fmtDist(Math.sqrt(lk.dist * lk.dist + h * h)) + ' LOS' : '') + (lk.aim.capped ? ' (capped)' : ''); } const g = nav && nav.location ? groundAt(nav.location) : null; const lp = (nav && g != null) ? lookPointFor(nav, step, g) : null; return lp ? fmtDist(lp.dist) + (lp.slant != null ? ' / ' + fmtDist(lp.slant) + ' LOS' : '') + (lp.capped ? ' (capped)' : '') : '?'; })(), 'distance from the nav to where the camera points (terrain at the nav) — drag: nav closer / farther along the heading'))
                + '</div>';
            if (nav) {
                html += '<div class="aim-vv-edit__row"><span class="dim">nav ' + esc(stepLabel(nav)) + '</span>'
                    + btn('nav-move', '▲ N', 'Move the nav ' + sf + ' ft north', 'data-b="0"') + btn('nav-move', '▼ S', 'Move the nav ' + sf + ' ft south', 'data-b="180"')
                    + btn('nav-move', '◀ W', 'Move the nav ' + sf + ' ft west', 'data-b="270"') + btn('nav-move', 'E ▶', 'Move the nav ' + sf + ' ft east', 'data-b="90"')
                    + (function() { const o = origOf(nav.id); if (!o || !o.location || !nav.location) return ''; const ns = distM(o.location, { lat: nav.location.lat, lng: o.location.lng }) * (nav.location.lat >= o.location.lat ? 1 : -1); const ew = distM(o.location, { lat: o.location.lat, lng: nav.location.lng }) * (nav.location.lng >= o.location.lng ? 1 : -1); return ' <span class="dim">moved</span> ' + sc('nav-ns', signed(ns * M_TO_FT, ' ft', 0) + ' N', 'north / south from the original nav — drag') + ' ' + sc('nav-ew', signed(ew * M_TO_FT, ' ft', 0) + ' E', 'east / west from the original nav — drag') + ' '; })()
                    + btn('nav-place', ed.placing ? '📍 click the map… (Esc cancels)' : '📍 Place on map', 'Next click on the map sets this nav\'s position', ed.placing ? 'class="aim-vv-armed"' : '')
                    + '<input type="text" class="aim-vv-latlng" data-aim-vv-latlng="1" value="' + esc(nav.location ? nav.location.lat.toFixed(6) + ', ' + nav.location.lng.toFixed(6) : '') + '" title="lat, lng — Enter to apply" spellcheck="false">'
                    + btn('nav-set', 'Set', 'Apply the typed lat, lng')
                    + '<label class="dim" title="When the nav moves, every in-place snapshot on it re-aims (heading + camera angle) at the ground point it was looking at"><input type="checkbox" data-aim-vv-ed-check="nav-keep-aim" ' + (settings.navKeepAim ? 'checked' : '') + '> keep cameras on their look-points</label></div>';
            }
            html += '<div class="aim-vv-edit__row"><span class="dim">from flight</span>'
                + btn('adopt', 'Adopt actual shot', 'Move the nav to where the drone stood and copy the actual heading / camera angle / altitude into the step')
                + (gps ? '' : btn('convert', 'Convert → GPS aim point', 'Cast the actual camera ray to the ground (cap ' + (settings.rayCapFt || 500) + ' ft) and make that the aim point'))
                + '</div>';
            html += '<div class="aim-vv-edit__row"><span class="dim">steps</span>'
                + btn('dup', 'Duplicate block after', 'Copy this snapshot and its camera/wait steps right after it')
                + btn('del', 'Delete block', 'Remove this snapshot and its camera/wait steps', 'class="aim-vv-danger"')
                + btn('reset-step', 'Reset this step', 'Undo pending changes on this step and its nav') + '</div>';
        }
        html += '<div class="aim-vv-edit__row aim-vv-edit__foot">'
            + (diff.length ? '<b>' + diff.length + ' pending field change' + (diff.length === 1 ? '' : 's') + '</b> <span class="dim">from ' + ed.log.length + ' action' + (ed.log.length === 1 ? '' : 's') + (ed.log.length ? ' (last: ' + esc(ed.log[ed.log.length - 1].what) + (ed.log[ed.log.length - 1].step ? ' ' + esc(ed.log[ed.log.length - 1].step) : '') + ')' : '') + '</span> ' + btn('review', 'Review & Apply…', 'Show the before/after diff, back up the mission, then write') + btn('discard', 'Discard all', 'Drop every pending change') : '<span class="dim">no pending changes</span>')
            + (isLite() ? ' <span class="warn">Lite mode: writes are blocked</span>' : '')
            + (!loadShape() ? ' <span class="warn">no learned save shape yet — open any mission in the Mission Bank and Save once</span>' : '')
            + (!getCsrf() ? ' <span class="warn">no CSRF token seen yet</span>' : '')
            + '</div>'
            + '<div class="aim-vv-edit__row"><span class="dim">restore</span><select class="aim-vv-restore-pick" data-aim-vv-restore-pick="1">' + restoreOptions() + '</select>'
            + btn('restore', '↩ Load into working copy', 'Load the chosen state into the working copy — then Review & Apply writes it (the saved backups are per mission, newest first)')
            + btn('restore-file', '📂 From backup file…', 'Load a vv-backup-*.json you downloaded earlier') + '<input type="file" accept=".json,application/json" class="aim-vv-restore-file" data-aim-vv-restore-file="1" style="display:none"></div>';
        if (el.innerHTML !== html) el.innerHTML = html;
    }
    function backupsFor(mid) { try { return (GM_getValue(BACKUPS_KEY, []) || []).filter(b => String(b.mid) === String(mid)); } catch (e) { return []; } }
    function reportsFor(mid) { try { return (GM_getValue(REPORTS_KEY, []) || []).filter(r => String(r.mid) === String(mid)); } catch (e) { return []; } }
    function restoreOptions() {
        const reps = reportsFor(model.mid);
        const opts = ['<option value="flown">the plan exactly as it FLEW (this flight\'s record)</option>'];
        backupsFor(model.mid).forEach(b => {
            const rep = reps.find(r => r.at === b.at);
            const what = rep && rep.actions && rep.actions.length ? 'before: ' + rep.actions.map(a => a.what + (a.step ? ' ' + a.step : '')).join(', ') : (rep ? 'before: ' + (rep.changes || []).length + ' change(s)' : 'before a save');
            opts.push('<option value="' + esc(b.at) + '">' + esc(new Date(b.at).toLocaleString()) + ' — ' + esc(what.slice(0, 90)) + '</option>');
        });
        return opts.join('');
    }
    // Load a full instruction list into the working copy, matching CURRENT ids positionally so the diff reads as changes.
    function loadIntoWork(instructions, label) {
        const ins = (instructions || []).slice().sort((a, b2) => (a.index_in_app || 0) - (b2.index_in_app || 0)).map(deepCopy);
        ins.forEach((st, i) => { const cur = model.plan[i]; if (cur && cur.type === st.type) st.id = cur.id; else { st.id = ed.tempId--; st._new = true; } delete st._aim; });
        ed.work = ins; ed.log = [{ at: Date.now(), what: 'Load ' + label, step: '' }];
        drawGhosts(); renderEdit();
        const n = edDiff().length;
        toast(n ? 'Loaded ' + label + ' — ' + n + ' field change' + (n === 1 ? '' : 's') + ' vs the saved plan · Review & Apply to write' : 'Loaded ' + label + ' — identical to the saved plan, nothing to apply', !n);
    }
    function onRestoreFile(e) {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
            try {
                const j = JSON.parse(String(rd.result));
                const ins = (j.app && j.app.instructions) || j.instructions || null;
                if (!Array.isArray(ins)) throw new Error('not a vv-backup file (no app.instructions)');
                if (j.mid && String(j.mid) !== String(model.mid)) warn('backup file is for mission ' + j.mid + ', this page is ' + model.mid + ' — loading anyway (positional match)');
                loadIntoWork(ins, 'file ' + f.name);
            } catch (err) { warn('backup file:', err); toast('Could not load: ' + err.message, true); }
        };
        rd.readAsText(f);
        e.target.value = '';
    }
    // Drag-to-change: mousedown on a [data-aim-vv-scrub] element, drag horizontally; every SCRUB_PX = one unit (Shift ×5).
    const SCRUB_PX = 6;
    let scrub = null;
    function onScrubDown(e) {
        const el = e.target.closest && e.target.closest('[data-aim-vv-scrub]');
        if (!el || e.button !== 0) return;
        const isInput = el.tagName === 'INPUT';
        if (!isInput) e.preventDefault();
        e.stopPropagation();
        scrub = { el, kind: el.dataset.aimVvScrub, x0: e.clientX, dx: 0, acc: 0, locked: false };
        // Engage only once the pointer has actually moved (a plain click must never grab the cursor).
    }
    function engageScrub() {
        if (!scrub || scrub.engaged) return;
        scrub.engaged = true;
        document.body.classList.add('aim-vv-scrubbing');
        // Pointer lock = unbounded movement (the screen edge no longer ends the drag). Lock the BODY, not the number:
        // the panel re-renders while dragging and a replaced element would drop the lock. Falls back to clientX deltas.
        try { const p = document.body.requestPointerLock && document.body.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) { /* fallback */ }
    }
    function onScrubMove(e) {
        if (!scrub) return;
        if (!scrub.engaged) { if (Math.abs(e.clientX - scrub.x0) < 5) return; engageScrub(); }
        const locked = document.pointerLockElement === document.body;
        if (locked) { scrub.dx += e.movementX || 0; scrub.locked = true; } else if (!scrub.locked) { scrub.dx = e.clientX - scrub.x0; }
        const units = Math.trunc(scrub.dx / SCRUB_PX) - scrub.acc;
        if (!units) return;
        scrub.acc += units;
        const n = units * (e.shiftKey ? 5 : 1);
        dragKind = scrub.kind; dragUnits += n;
        try { scrubApply(scrub.kind, n); } catch (err) { warn('scrub failed:', err); }
    }
    function onScrubUp() {
        if (!scrub) return;
        const wasDrag = scrub.engaged;
        scrub = null;
        document.body.classList.remove('aim-vv-scrubbing');
        try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* not locked */ }
        if (wasDrag) { if (dragKind && dragKind !== 'time' && dragUnits) { const shot = currentShotForEdit(); const st = shot && shot.step; edLog('drag ' + dragKind + ' ' + (dragUnits > 0 ? '+' : '') + dragUnits, st && st.type_name === 'snapshot' ? wk(st.id) : null); } try { renderEdit(true); } catch (e) { /* panel may be closed */ } }   // full re-render once the drag ends
        dragKind = null; dragUnits = 0;
    }
    let dragKind = null, dragUnits = 0;
    function onScrubWheel(e) {
        const el = e.target.closest && e.target.closest('[data-aim-vv-scrub]');
        if (!el || !model) return;
        e.preventDefault(); e.stopPropagation();
        const n = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 5 : 1);
        try { scrubApply(el.dataset.aimVvScrub, n); } catch (err) { warn('wheel scrub failed:', err); }
    }
    function scrubApply(kind, n) {
        if (kind === 'time') { const v = videoEl(); if (v) { showPlayer(); seekVideo(v.currentTime + n, false); updateBarNow(); } return; }
        const shot = currentShotForEdit();
        const step = shot && shot.step && shot.step.type_name === 'snapshot' ? wk(shot.step.id) : null;
        if (!step) return;
        if (kind === 'heading') edTurn(step, isGps(step) ? n * FT : n);           // GPS: 1 unit = 1 ft sideways (as rotation)
        else if (kind === 'camera') edTilt(step, isGps(step) ? n * FT : n);      // GPS: 1 unit = 1 ft of target alt
        else if (kind === 'alt') edAlt(step, n * FT);
        else if (kind === 'range') edRange(step, n * FT);
        else if (kind === 'target-alt') { if (isGps(step)) step.value1 = +((step.value1 || 0) + n * FT).toFixed(2); }
        else if (kind === 'nav-ns' || kind === 'nav-ew') { const nav = wkNavOf(step); if (nav && nav.location) moveNavKeepAim(nav, moveLL(nav.location, Math.abs(n) * FT, kind === 'nav-ns' ? (n > 0 ? 0 : 180) : (n > 0 ? 90 : 270))); }
        drawGhosts(); renderEdit();
    }
    // While a drag is in progress only the numbers change — never rebuild the panel (that would replace the elements).
    function refreshScrubValues() {
        if (!ed.panelEl) return;
        const shot = currentShotForEdit();
        const step = shot && shot.step && shot.step.type_name === 'snapshot' ? wk(shot.step.id) : null;
        if (!step) return;
        const pose = wkPose(step), nav = pose.nav;
        const set = (kind, txt) => { const el = ed.panelEl.querySelector('[data-aim-vv-scrub="' + kind + '"]'); if (el && el.textContent !== txt) el.textContent = txt; };
        set('heading', pose.heading != null ? pose.heading.toFixed(0) + '°' : '–');
        set('camera', pose.pitchDeg != null ? pose.pitchDeg.toFixed(0) + '°' : '–');
        set('alt', fmtAlt(nav ? nav.value1 : null));
        if (isGps(step)) { set('target-alt', fmtAlt(step.value1)); set('range', fmtDist(pose.range)); }
        else if (nav && nav.location) { const lk = inplaceLook(step); if (lk) { const h = (typeof nav.value1 === 'number' && lk.aim.alt != null) ? nav.value1 - lk.aim.alt : null; set('range', fmtDist(lk.dist) + (h != null ? ' / ' + fmtDist(Math.sqrt(lk.dist * lk.dist + h * h)) + ' LOS' : '') + (lk.aim.capped ? ' (capped)' : '')); } else set('range', '?'); }
        const o = nav && origOf(nav.id);
        if (o && o.location && nav.location) {
            const ns = distM(o.location, { lat: nav.location.lat, lng: o.location.lng }) * (nav.location.lat >= o.location.lat ? 1 : -1);
            const ew = distM(o.location, { lat: o.location.lat, lng: nav.location.lng }) * (nav.location.lng >= o.location.lng ? 1 : -1);
            set('nav-ns', signed(ns * M_TO_FT, ' ft', 0) + ' N'); set('nav-ew', signed(ew * M_TO_FT, ' ft', 0) + ' E');
            const inp = ed.panelEl.querySelector('[data-aim-vv-latlng]'); if (inp && document.activeElement !== inp) inp.value = nav.location.lat.toFixed(6) + ', ' + nav.location.lng.toFixed(6);
        }
    }
    function onCopyClick(e) {
        if (!groupHost || !groupHost.classList.contains('aim-vv-split')) return;
        const grid = groupHost.children[1]; if (!grid || !grid.contains(e.target)) return;
        const field = Array.from(grid.children).find(f => f.contains(e.target)); if (!field) return;
        const value = field.children[0]; const label = field.children[1];
        const txt = value ? value.textContent.trim() : '';
        if (!txt) return;
        e.preventDefault(); e.stopPropagation();
        const done = () => toast('Copied ' + (label ? label.textContent.trim() : '') + ': ' + txt, false);
        try { navigator.clipboard.writeText(txt).then(done, () => { fallbackCopy(txt); done(); }); } catch (err) { fallbackCopy(txt); done(); }
    }
    function fallbackCopy(txt) { try { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } catch (e) { warn('copy failed:', e); } }
    function onEditClick(e) {
        if (e.target.matches && (e.target.matches('[data-aim-vv-ed-check]') || e.target.matches('[data-aim-vv-restore-pick], [data-aim-vv-restore-pick] *'))) return;   // native controls
        const b = e.target.closest && e.target.closest('[data-aim-vv-ed]');
        if (!b || !model) return;
        e.preventDefault(); e.stopPropagation();
        if (ed.busy) return;
        const act = b.dataset.aimVvEd; const mult = e.shiftKey ? 5 : 1; const n = Number(b.dataset.n || 1) * mult;
        const shot = currentShotForEdit();
        const step = shot && shot.step && shot.step.type_name === 'snapshot' ? wk(shot.step.id) : null;
        const sd = Number(settings.stepDeg) || 1, sp = Number(settings.stepPitch) || 1, sf = (Number(settings.stepFt) || 1) * FT, sa = (Number(settings.stepAltFt) || 1) * FT;
        try {
            if (act === 'review') { openReview(); return; }
            if (act === 'discard') { edResetWork(); toast('Pending changes discarded', false); return; }
            if (act === 'close') { ed.open = false; ensureEditPanel(); return; }
            if (act === 'nav-move' && step) { const nav = wkNavOf(step); if (nav && nav.location) { moveNavKeepAim(nav, moveLL(nav.location, Math.abs(n) * (Number(settings.stepFt) || 1) * FT, Number(b.dataset.b))); edLog('nav ' + ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[b.dataset.b] || b.dataset.b + '°') + ' ' + Math.abs(n * (Number(settings.stepFt) || 1)) + ' ft', nav); } }
            else if (act === 'nav-keep-aim') { settings.navKeepAim = !settings.navKeepAim; saveSettings(); renderEdit(); return; }
            else if (act === 'nav-place' && step) { setPlacing(ed.placing ? null : { navId: wkNavOf(step) && wkNavOf(step).id }); }
            else if (act === 'nav-set' && step) {
                const nav = wkNavOf(step); const inp = ed.panelEl && ed.panelEl.querySelector('[data-aim-vv-latlng]');
                const m = inp && inp.value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
                if (!nav || !m) { toast('Type "lat, lng"', true); return; }
                const lat = +m[1], lng = +m[2];
                if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) { toast('lat/lng out of range', true); return; }
                if (nav.location && distM(nav.location, { lat, lng }) > 2000) { toast('That is ' + fmtDist(distM(nav.location, { lat, lng })) + ' away — refusing (>2000 m)', true); return; }
                moveNavKeepAim(nav, { lat, lng }); edLog('nav set to ' + lat.toFixed(6) + ', ' + lng.toFixed(6), nav);
            }
            if (act === 'nav-move' || act === 'nav-set') { drawGhosts(); renderEdit(); return; }
            if (act === 'nav-place') { renderEdit(); return; }
            if (act === 'restore') {
                const sel = ed.panelEl && ed.panelEl.querySelector('[data-aim-vv-restore-pick]'); const v = sel ? sel.value : 'flown';
                if (v === 'flown') { loadIntoWork(model.plan, 'the plan as flown'); return; }
                const bk = backupsFor(model.mid).find(b => b.at === v); if (!bk || !bk.app) { toast('That backup is no longer in script storage — use 📂 From backup file', true); return; }
                loadIntoWork(bk.app.instructions, 'backup from ' + new Date(bk.at).toLocaleString()); return;
            }
            if (act === 'restore-file') { const inp = ed.panelEl && ed.panelEl.querySelector('[data-aim-vv-restore-file]'); if (inp) inp.click(); return; }
            if (!step) return;
            if (act === 'turn') { edTurn(step, isGps(step) ? n * sf : n * sd); edLog((n < 0 ? 'left ' : 'right ') + Math.abs(isGps(step) ? n * (Number(settings.stepFt) || 1) : n * sd) + (isGps(step) ? ' ft' : '°'), step); }
            else if (act === 'tilt') { edTilt(step, isGps(step) ? n * sa : n * sp); edLog((n > 0 ? 'up ' : 'down ') + Math.abs(isGps(step) ? n * (Number(settings.stepAltFt) || 1) : n * sp) + (isGps(step) ? ' ft' : '°'), step); }
            else if (act === 'range') { edRange(step, n * sf); edLog((n < 0 ? 'closer ' : 'farther ') + Math.abs(n * (Number(settings.stepFt) || 1)) + ' ft', step); }
            else if (act === 'alt') { edAlt(step, n * sa); edLog('alt ' + (n > 0 ? '+' : '−') + Math.abs(n * (Number(settings.stepAltFt) || 1)) + ' ft', step); }
            else if (act === 'adopt') { edAdopt(step, shot); delete step._aim; edLog('Adopt actual shot', step); }
            else if (act === 'convert') { ed.busy = true; edConvertGps(step, shot).then(ok => { ed.busy = false; if (ok) edLog('Convert → GPS aim point', step); drawGhosts(); renderEdit(); }); return; }
            else if (act === 'dup') { const c = edDuplicateBlock(step); toast(c ? 'Block duplicated after ' + stepLabel(step) : 'Could not duplicate', !c); if (c) edLog('Duplicate block after', step); }
            else if (act === 'del') { edDeleteBlock(step); toast('Block ' + stepLabel(step) + ' marked for deletion', false); edLog('Delete block', step); }
            else if (act === 'reset-step') { const o = origOf(step.id); const nav = wkNavOf(step); const on = nav && origOf(nav.id); if (o) Object.assign(step, deepCopy(o)); if (on) Object.assign(nav, deepCopy(on)); delete step._aim; edLog('Reset step', step); }
            drawGhosts(); renderEdit();
        } catch (err) { warn('edit action failed:', err); toast('Edit failed: ' + err.message, true); }
    }
    // ---- place a nav by clicking the map ----
    function setPlacing(p) {
        ed.placing = p;
        const c = document.querySelector('.leaflet-container');
        if (c) c.classList.toggle('aim-vv-placing', !!p);
        if (p) toast('Click the map to place the nav · Esc cancels', false);
    }
    function onMapPlaceClick(e) {
        if (!ed.placing || !model) return;
        const c = e.target.closest && e.target.closest('.leaflet-container'); if (!c) return;
        const map = findMap(); if (!map) return;
        e.preventDefault(); e.stopPropagation();
        let ll = null;
        try { ll = map.mouseEventToLatLng(e); } catch (err) { warn('place: latlng failed:', err); }
        const nav = ed.placing.navId != null ? wk(ed.placing.navId) : null;
        setPlacing(null);
        if (!ll || !nav) { renderEdit(); return; }
        if (nav.location && distM(nav.location, ll) > 2000) { toast('That is ' + fmtDist(distM(nav.location, ll)) + ' from the nav — refusing (>2000 m)', true); renderEdit(); return; }
        moveNavKeepAim(nav, ll); edLog('Place on map', nav);
        drawGhosts(); renderEdit();
        toast('Nav ' + stepLabel(nav) + ' moved — review to apply', false);
    }
    function onPlaceKey(e) { if (e.key === 'Escape' && ed.placing) { setPlacing(null); renderEdit(); } }
    // ---- review + apply ----
    function openReview() {
        const diff = edDiff();
        if (!diff.length) { toast('Nothing to apply', false); return; }
        if (ed.reviewEl) ed.reviewEl.remove();
        const shape = loadShape(), csrf = getCsrf(), lite = isLite();
        const blockers = [];
        const blk = editsBlocked(); if (blk) blockers.push(blk);
        if (lite) blockers.push('Lite mode — writes are blocked (CSM access needed)');
        if (!shape || !shape.sample) blockers.push('No learned save shape: open any mission in the Mission Bank, click Save once (unchanged is fine), reload this page');
        if (!csrf) blockers.push('No CSRF token seen in this tab yet');
        const rows = diff.map(d => '<tr><td>' + esc(d.label) + '</td><td>' + esc(d.kind) + (d.field ? ' · ' + esc(d.field) : '') + '</td><td>' + esc(d.before != null ? d.before : '') + '</td><td>' + esc(d.after != null ? d.after : '') + '</td><td class="dim">' + esc(d.note || '') + '</td></tr>').join('');
        const el = document.createElement('div'); el.className = 'aim-vv-review';
        const actions = ed.log.length ? '<div class="dim" style="margin:4px 0">actions: ' + ed.log.map((a, i) => (i + 1) + '. ' + esc(a.what) + (a.step ? ' <b>' + esc(a.step) + '</b>' : '')).join(' · ') + '</div>' : '';
        const grp = model.mission.mission_group_id;
        el.innerHTML = '<div class="aim-vv-review__box"><div><b>Review changes to mission "' + esc(model.mission.name || model.mission.app_name) + '"</b> <span class="dim">(app ' + esc(model.mission.app && model.mission.app.id) + (grp != null && grp >= 0 ? ' · affects every future flight of group ' + esc(grp) : ' · not part of a mission group') + ')</span></div>' + actions
            + '<table><tr class="dim"><td>step</td><td>change</td><td>before</td><td>after</td><td></td></tr>' + rows + '</table>'
            + '<div class="dim" style="margin:6px 0">Rails: the plan is re-read and compared first · a full JSON backup is saved (script storage + download) · ONE save · re-read and verified · a before/after report is saved + downloaded.</div>'
            + (function() { try { const app = model.liveApp || model.mission.app; const r = resolveSelectedRobot(app); if (!r.value) blockers.push('Cannot resolve selected_robot: ' + r.from); const rep = Array.isArray(app.data_report_object_arr) ? app.data_report_object_arr.map(x => x && (x.name || x.id)).join(', ') : 'none'; return '<div class="dim">will send: name "' + esc(app.name) + '" · type ' + esc(app.type) + ' · site_id ' + esc(app.site) + ' · app_id <b>' + esc(app.id) + '</b>' + (app.__aimVvHow ? ' <span class="dim">(live app, ' + esc(app.__aimVvHow) + ')</span>' : '') + ' · selected_robot <b>' + esc(r.value || '?') + '</b> <span class="dim">(' + esc(r.from) + ')</span> · reports: ' + esc(rep) + ' · ' + edEnsureWork().length + ' instructions</div>'; } catch (e) { blockers.push('preflight failed: ' + e.message); return ''; } })()
            + (blockers.length ? '<div class="warn">' + blockers.map(esc).join('<br>') + '</div>' : '')
            + '<div class="aim-vv-edit__row"><button type="button" data-aim-vv-rv="apply" ' + (blockers.length ? 'disabled' : '') + '>Apply ' + diff.length + ' change' + (diff.length === 1 ? '' : 's') + '</button><button type="button" data-aim-vv-rv="cancel">Cancel</button><span class="aim-vv-review__status dim"></span></div></div>';
        document.body.appendChild(el); ed.reviewEl = el;
    }
    function onReviewClick(e) {
        const b = e.target.closest && e.target.closest('[data-aim-vv-rv]'); if (!b) return;
        e.preventDefault(); e.stopPropagation();
        if (b.dataset.aimVvRv === 'cancel') { if (ed.reviewEl) ed.reviewEl.remove(); ed.reviewEl = null; return; }
        if (b.dataset.aimVvRv === 'apply' && !b.disabled) { b.disabled = true; applyChanges(); }
    }
    function status(msg) { const s2 = ed.reviewEl && ed.reviewEl.querySelector('.aim-vv-review__status'); if (s2) s2.textContent = msg; log(msg); }
    function download(name, obj) {
        try {
            const doc = pageWin.top.document;   // top-window download bypasses the iframe sandbox
            const blob = new pageWin.top.Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
            const a = doc.createElement('a'); a.href = pageWin.top.URL.createObjectURL(blob); a.download = name; doc.body.appendChild(a); a.click();
            setTimeout(() => { try { pageWin.top.URL.revokeObjectURL(a.href); a.remove(); } catch (e2) {} }, 2000);
        } catch (e) { warn('download failed (' + name + '):', e); }
    }
    function gmPush(key, entry, cap) { try { const arr = GM_getValue(key, []) || []; arr.unshift(entry); GM_setValue(key, arr.slice(0, cap)); } catch (e) { warn('GM store failed:', e); } }
    // Build the save body from the learned shape: scalars from the sample, overridden by this app's own values
    // where the field names match, name/type/site_id/app_id set explicitly, instructions minimal.
    // Percepto's save body carries `selected_robot` (an uppercase drone-type enum such as SPARROW / AIRMAX_POWERTRAIN).
    // Resolve it from THIS mission: the app's robot type names first, then the drone that flew it. Null = cannot write.
    function resolveSelectedRobot(app) {
        const enumLike = (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]+$/.test(v) ? v : null;
        const names = Array.isArray(app.robot_type_names) ? app.robot_type_names.map(enumLike).filter(Boolean) : [];
        const flew = model && model.mission.drone && enumLike(model.mission.drone.robot_type_name);
        if (flew && (names.includes(flew) || !names.length)) return { value: flew, from: 'drone that flew it' + (names.length > 1 ? ' (app lists ' + names.join('/') + ')' : '') };
        if (names.length) return { value: names[0], from: 'app.robot_type_names' + (names.length > 1 ? ' (' + names.join('/') + ')' : '') + (flew ? ' — flown by ' + flew + ' which the app does not list' : '') };
        const fromRt = Array.isArray(app.robot_type) ? app.robot_type.map(x => enumLike(x && (x.name || x.robot_type_name || x))).find(Boolean) : null;
        if (fromRt) return { value: fromRt, from: 'app.robot_type' };
        const fromDrone = model && model.mission.drone && enumLike(model.mission.drone.robot_type_name);
        if (fromDrone) return { value: fromDrone, from: 'mission.drone.robot_type_name' };
        return { value: null, from: 'unresolved (app.robot_type_names=' + JSON.stringify(app.robot_type_names) + ', app.robot_type=' + JSON.stringify(app.robot_type) + ')' };
    }
    function buildBody(app, work, shape) {
        const b = deepCopy(shape.sample || {});
        const src = { name: app.name, description: app.description, type: app.type, site_id: app.site, app_id: app.id, map_type: app.map_type, mock_app: app.mock_app, report_rules: app.report_rules, assets_app: app.assets_app, robot_type: app.robot_type, is_active: app.is_active };
        const used = [];
        Object.keys(src).forEach(k => { if (k in b && src[k] !== undefined) { b[k] = src[k]; used.push(k); } });
        b.name = app.name; b.type = app.type != null ? app.type : 1; b.site_id = Number(app.site); b.app_id = app.id;
        if ('selected_robot' in b) { const r = resolveSelectedRobot(app); if (!r.value) throw new Error('cannot resolve selected_robot — ' + r.from); b.selected_robot = r.value; used.push('selected_robot'); }
        if ('dataReportObjectArr' in b) {
            const banked = Array.isArray(app.data_report_object_arr) ? app.data_report_object_arr : [];
            const learned = Array.isArray(b.dataReportObjectArr) ? b.dataReportObjectArr : [];
            b.dataReportObjectArr = (learned.length && typeof learned[0] === 'number') ? banked.map(x => (x && x.id != null) ? x.id : x) : banked;
        }
        b.instructions = work.map(st => ({ type: st.type, polygon_points: st.polygon_points === undefined ? null : st.polygon_points, extra_options: st.extra_options || {}, snapshot_points: st.snapshot_points === undefined ? null : st.snapshot_points, location: st.location || null, value1: st.value1 === undefined ? null : st.value1, value2: st.value2 === undefined ? null : st.value2 }));
        const fromSample = Object.keys(b).filter(k => !used.includes(k) && !['name', 'type', 'site_id', 'app_id', 'instructions', 'dataReportObjectArr'].includes(k));
        return { body: b, fromSample };
    }
    function planSig(ins) { return (ins || []).map(x => x.id).join(','); }
    async function applyChanges() {
        if (ed.busy) return; ed.busy = true;
        const diff = edDiff(); const mid = model.mid, sid = model.sid;
        try {
            const shape = loadShape(), csrf = getCsrf();
            if (isLite() || !shape || !shape.sample || !csrf || !diff.length) throw new Error('blocked (lite / shape / csrf / empty)');
            const blocked = editsBlocked(); if (blocked) throw new Error(blocked);
            const appId = model.mission.app && model.mission.app.id;
            status('re-reading the live mission…');
            const freshApp = await fetchLiveApp(sid, appId, model.liveApp && model.liveApp.name, model.plan);
            if (Number(freshApp.id) !== Number(model.liveApp && model.liveApp.id)) throw new Error('live app id changed between load (' + (model.liveApp && model.liveApp.id) + ') and now (' + freshApp.id + ')');
            const freshIns = (freshApp.instructions || []).slice().sort((a, b2) => a.index_in_app - b2.index_in_app);
            const loadedIns = model.live || [];
            if (freshIns.length !== loadedIns.length || freshIns.some((st, i) => stepSig(st) !== stepSig(loadedIns[i]))) throw new Error('the live mission changed since this page loaded — reload and redo the edits');
            const at = new Date().toISOString(), stamp = at.replace(/[:.]/g, '-');
            status('backing up…');
            const backup = { at, mid, sid, appId: freshApp.id, name: freshApp.name, app: freshApp };
            gmPush(BACKUPS_KEY, backup, 20); download('vv-backup-' + mid + '-' + stamp + '.json', backup);
            const fresh = { app: freshApp };
            const built = buildBody(freshApp, ed.work, shape);
            log('save base = live app ' + freshApp.id + ' (' + freshIns.length + ' steps; flown record ' + appId + ')');
            log('save body: ' + built.body.instructions.length + ' instructions · keys ' + Object.keys(built.body).join(',') + (built.fromSample.length ? ' · from learned sample (unchanged): ' + built.fromSample.join(',') : ''));
            status('saving…');
            const r = await fetch('/available_app/', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: JSON.stringify(built.body) });
            const txt = await r.text().catch(() => '');
            if (!r.ok) { warn('save failed HTTP ' + r.status + ': ' + txt.slice(0, 500)); warn('failing body:', built.body); throw new Error('save HTTP ' + r.status); }
            status('verifying (live mission)…');
            const afterApp = await fetchLiveApp(sid, appId, freshApp.name, model.plan);
            const after = { app: afterApp };
            const afterIns = (afterApp.instructions || []).slice().sort((a, b2) => a.index_in_app - b2.index_in_app);
            const mism = [];
            const rtBefore = JSON.stringify(fresh.app.robot_type_names || []), rtAfter = JSON.stringify(after.app.robot_type_names || []);
            if (rtBefore !== rtAfter) mism.push('ROBOT TYPES CHANGED: ' + rtBefore + ' → ' + rtAfter + ' (selected_robot semantics — restore the backup)');
            const repB = JSON.stringify((fresh.app.data_report_object_arr || []).map(x => x && x.id)), repA = JSON.stringify((after.app.data_report_object_arr || []).map(x => x && x.id));
            if (repB !== repA) mism.push('data reports changed: ' + repB + ' → ' + repA);
            if (afterIns.length !== ed.work.length) mism.push('step count ' + afterIns.length + ' ≠ expected ' + ed.work.length);
            ed.work.forEach((w, i) => { const a = afterIns[i]; if (!a) return; const wa = deepCopy(w); delete wa._new; const dd = fieldDiffs(Object.assign({ type_name: w.type_name }, a), Object.assign({ type_name: w.type_name }, wa)); if (a.type !== w.type) mism.push('#' + i + ' type ' + a.type + ' ≠ ' + w.type); dd.forEach(d => mism.push('#' + i + ' ' + d.field + ': server ' + d.before + ' vs sent ' + d.after)); });
            const report = { at, mid, sid, appId: fresh.app.id, name: fresh.app.name, group: model.mission.mission_group_id, actions: ed.log.map(a => ({ at: new Date(a.at).toISOString(), what: a.what, step: a.step })), changes: diff, verify: { ok: !mism.length, mismatches: mism }, httpStatus: r.status };
            gmPush(REPORTS_KEY, report, 200); download('vv-correction-' + mid + '-' + stamp + '.json', report);
            sessionReports.push(report);
            if (mism.length) { warn('verify mismatches:', mism); toast('Saved, but ' + mism.length + ' field(s) read back differently — see console + report', true); }
            else toast('✅ Saved ' + diff.length + ' change' + (diff.length === 1 ? '' : 's') + ' · verified · backup + report downloaded', false);
            status(mism.length ? 'saved with ' + mism.length + ' mismatch(es)' : 'saved + verified');
            if (ed.reviewEl) { ed.reviewEl.remove(); ed.reviewEl = null; }
            ed.work = null; ed.log = []; ed.busy = false;
            const ids = current; deactivate(); if (ids) activate(ids);
            return;
        } catch (e) {
            warn('apply failed:', e); toast('🛑 Not applied: ' + e.message, true); status('failed: ' + e.message);
            const b = ed.reviewEl && ed.reviewEl.querySelector('[data-aim-vv-rv="apply"]'); if (b) b.disabled = false;
        }
        ed.busy = false;
    }
    // ===============================================================
    // FLIGHT CHECKER + SESSION CHANGE REPORT (copy for JIRA)
    // ===============================================================
    const sessionReports = [];   // every Apply on this page (all missions), in order
    let reportEl = null;
    function fmtSigned(v, unit, d) { if (v == null || !isFinite(v)) return '–'; const r = +v.toFixed(d == null ? 0 : d); return (r > 0 ? '+' : '') + (r === 0 ? '0' : r.toFixed(d == null ? 0 : d)) + unit; }
    function actualLookPointOf(im) {
        if (!im || !im.location || typeof im.drone_heading !== 'number' || typeof im.camera_pitch !== 'number' || typeof im.alt !== 'number') return null;
        const g = groundAt(im.location); if (g == null) return null;
        const capM = (Number(settings.rayCapFt) || 500) * FT, down = Math.tan(Math.abs(im.camera_pitch) * RAD);
        let dist = down > 0.01 ? (im.alt - g) / down : Infinity; let capped = false; if (!(dist > 0) || dist > capM) { dist = capM; capped = true; }
        return { ll: moveLL(im.location, dist, im.drone_heading), dist, capped };
    }
    function plannedLookPointOf(step) {
        if (!step) return null;
        if (isGps(step)) return { ll: step.location };
        const nav = parentNav(model, step); if (!nav || !nav.location) return null;
        const g = groundAt(nav.location); if (g == null) return null;
        const lp = lookPointFor(nav, step, g); return lp ? { ll: lp.ll, capped: lp.capped } : null;
    }
    function checkFlight() {
        const thr = { hdg: Number(settings.chkHdg) || 0, cam: Number(settings.chkCam) || 0, alt: Number(settings.chkAltFt) || 0, pos: Number(settings.chkPosFt) || 0, look: Number(settings.chkLookFt) || 0 };
        const inSlice = (st) => !model.slice || (st.index_in_app >= model.slice.minIdx && st.index_in_app <= model.slice.maxIdx);
        const snapsInFlight = model.plan.filter(st => st.type_name === 'snapshot' && inSlice(st));
        const rows = []; const seen = {};
        model.shots.forEach(sh => {
            const im = sh.primary, st = sh.step, d = sh.delta || {};
            const num = st && model.numbering[st.id];
            const flags = [];
            let lookGap = null;
            if (st && st.type_name === 'snapshot') {
                const p = plannedLookPointOf(st), a = actualLookPointOf(im);
                if (p && a && p.ll && a.ll) { lookGap = distM(p.ll, a.ll) * M_TO_FT; if (!(p.capped || a.capped) && lookGap > thr.look) flags.push('look-point ' + lookGap.toFixed(0) + ' ft off'); }
            }
            if (!st || st.type_name !== 'snapshot') flags.push('no snapshot step executing (pilot / manual?)');
            if (sh.retake) flags.push('re-take (' + ((seen[st.id] || 0) + 1) + ')');
            if (d.hdg != null && Math.abs(d.hdg) > thr.hdg) flags.push('heading ' + fmtSigned(d.hdg, '°'));
            if (d.pitch != null && Math.abs(d.pitch) > thr.cam) flags.push('camera ' + fmtSigned(d.pitch, '°'));
            if (d.alt != null && Math.abs(d.alt * M_TO_FT) > thr.alt) flags.push('altitude ' + fmtSigned(d.alt * M_TO_FT, ' ft'));
            if (d.pos != null && d.pos * M_TO_FT > thr.pos) flags.push('off station ' + (d.pos * M_TO_FT).toFixed(0) + ' ft ' + (d.posDir || ''));
            if (st) seen[st.id] = (seen[st.id] || 0) + 1;
            const pose = d.pose || {};
            rows.push({ s: num ? num.n : (st ? st.type_name : '?'), step: st ? st.index_in_app : null, shutter: mmss(sh.videoOff), kinds: sh.images.map(i => i.kind).join('+'), name: im && im.name,
                hdg: [pose.heading, im && im.drone_heading, d.hdg], cam: [pose.pitchDeg, im && im.camera_pitch, d.pitch], alt: [pose.alt, im && im.alt, d.alt], pos: d.pos, posDir: d.posDir, look: lookGap, asset: im && (im.assets || []).map(a => a.name).join(', '), flags });
        });
        const missing = snapsInFlight.filter(st => !seen[st.id]).map(st => (model.numbering[st.id] || {}).n || '#' + st.index_in_app);
        const summary = { shots: rows.length, flagged: rows.filter(r => r.flags.length).length, retakes: rows.filter(r => r.flags.some(f => f.startsWith('re-take'))).length, missing, thr };
        return { rows, summary };
    }
    function flightHeader() {
        const m = model.mission; const inSlice = (st) => !model.slice || (st.index_in_app >= model.slice.minIdx && st.index_in_app <= model.slice.maxIdx);
        const flightSteps = model.plan.filter(inSlice), flightSnaps = flightSteps.filter(st => st.type_name === 'snapshot');
        const allSnaps = model.plan.filter(st => st.type_name === 'snapshot');
        return { mission: m.name || m.app_name, appId: model.liveApp ? model.liveApp.id : (m.app && m.app.id), flownAppId: m.app && m.app.id, flightId: model.mid, group: m.mission_group_id, site: model.sid, drone: m.drone_name || (m.drone && m.drone.name), droneType: m.drone && m.drone.robot_type_name, when: m.when, flightSteps: flightSteps.length, flightSnaps: flightSnaps.length, missionSteps: model.plan.length, missionSnaps: allSnaps.length, slice: model.slice, url: location.origin + '/#/site/' + model.sid + '/control-panel/past-mission/' + model.mid };
    }
    function shotSentence(r) {
        const bits = [];
        r.flags.forEach(f => {
            if (f.startsWith('off station')) bits.push('drone was ' + f.replace('off station ', '') + ' of its nav');
            else if (f.startsWith('heading')) bits.push('heading ' + f.replace('heading ', '') + ' off plan');
            else if (f.startsWith('camera')) bits.push('camera angle ' + f.replace('camera ', '') + ' off plan');
            else if (f.startsWith('altitude')) bits.push('flew ' + f.replace('altitude ', '') + ' vs plan');
            else if (f.startsWith('look-point')) bits.push('looked ' + f.replace('look-point ', '').replace(' off', '') + ' away from the planned spot');
            else if (f.startsWith('re-take')) bits.push('re-take of a step already shot');
            else if (f.startsWith('no snapshot')) bits.push('taken while no snapshot step was running (pilot / manual)');
            else bits.push(f);
        });
        const ok = [];
        if (!r.flags.some(f => f.startsWith('heading') || f.startsWith('camera'))) ok.push('camera on plan');
        if (!r.flags.some(f => f.startsWith('off station'))) ok.push('on station');
        return r.s + ' at ' + r.shutter + ' — ' + bits.join('; ') + (ok.length ? '; ' + ok.join(', ') : '') + (r.asset ? '' : '; no asset in frame');
    }
    function checkerSummary(res, jira) {
        const h = flightHeader(); const L = [];
        L.push((jira ? 'h3. ' : '') + 'Flight check — ' + h.mission + ' · flight ' + h.flightId + ' · ' + new Date(h.when).toLocaleString() + (h.drone ? ' · ' + h.drone : ''));
        L.push('This flight: ' + h.flightSteps + ' steps, ' + h.flightSnaps + ' snapshots · whole mission: ' + h.missionSteps + ' steps, ' + h.missionSnaps + ' snapshots · ' + h.url);
        const bad = res.rows.filter(r => r.flags.length);
        L.push(res.summary.shots + ' shots · ' + bad.length + ' need' + (bad.length === 1 ? 's' : '') + ' attention · ' + res.summary.retakes + ' re-take' + (res.summary.retakes === 1 ? '' : 's') + (res.summary.missing.length ? ' · no picture for ' + res.summary.missing.join(', ') : ''));
        if (!bad.length) L.push((jira ? '* ' : '• ') + 'All shots within limits.');
        bad.forEach(r => L.push((jira ? '* ' : '• ') + shotSentence(r)));
        return L.join('\n');
    }
    const tri = (a, unit, d) => (a[0] != null ? (+a[0]).toFixed(d || 0) : '–') + unit + ' / ' + (a[1] != null ? (+a[1]).toFixed(d || 0) : '–') + unit + ' / ' + fmtSigned(a[2], unit, d || 0);
    function checkerText(res, jira) {
        const h = flightHeader();
        const L = [];
        L.push((jira ? 'h3. ' : '') + 'Flight check — ' + h.mission + ' · flight ' + h.flightId + (h.group != null && h.group >= 0 ? ' (group ' + h.group + ')' : '') + ' · ' + (h.drone || '') + (h.droneType ? ' (' + h.droneType + ')' : '') + ' · ' + new Date(h.when).toLocaleString());
        L.push('Steps: this flight ' + h.flightSteps + ' (' + h.flightSnaps + ' snapshots) · whole mission ' + h.missionSteps + ' (' + h.missionSnaps + ' snapshots) · ' + h.url);
        L.push('Shots ' + res.summary.shots + ' · flagged ' + res.summary.flagged + ' · re-takes ' + res.summary.retakes + ' · snapshot steps with no picture: ' + (res.summary.missing.length ? res.summary.missing.join(', ') : 'none'));
        L.push('Thresholds: heading ' + res.summary.thr.hdg + '° · camera ' + res.summary.thr.cam + '° · altitude ' + res.summary.thr.alt + ' ft · off-station ' + res.summary.thr.pos + ' ft · look-point ' + res.summary.thr.look + ' ft. Columns are planned / actual / Δ.');
        const head = ['shot', 'step', 'shutter', 'heading', 'camera', 'drone alt (ft)', 'drone vs nav', 'look-point gap', 'asset', 'flags'];
        if (jira) L.push('||' + head.join('||') + '||');
        else L.push(head.join('\t'));
        res.rows.forEach(r => {
            const c = [r.s, r.step != null ? '#' + r.step : '', r.shutter, tri(r.hdg, '°'), tri(r.cam, '°'), tri([r.alt[0] != null ? r.alt[0] * M_TO_FT : null, r.alt[1] != null ? r.alt[1] * M_TO_FT : null, r.alt[2] != null ? r.alt[2] * M_TO_FT : null], ''), r.pos != null ? (r.pos * M_TO_FT).toFixed(0) + ' ft ' + (r.posDir || '') : '–', r.look != null ? r.look.toFixed(0) + ' ft' : '–', r.asset || '–', r.flags.length ? r.flags.join('; ') : 'ok'];
            L.push(jira ? '|' + c.map(x => String(x).replace(/\|/g, '/')).join('|') + '|' : c.join('\t'));
        });
        return L.join('\n');
    }
    function sessionText(jira) {
        const h = flightHeader();
        const reps = sessionReports.filter(r => String(r.mid) === String(model.mid));
        const L = [];
        L.push((jira ? 'h3. ' : '') + 'Mission changes — ' + h.mission + ' · flight ' + h.flightId + (h.group != null && h.group >= 0 ? ' (group ' + h.group + ')' : '') + ' · ' + new Date().toLocaleString());
        L.push('Steps: this flight ' + h.flightSteps + ' (' + h.flightSnaps + ' snapshots) · whole mission ' + h.missionSteps + ' (' + h.missionSnaps + ' snapshots) · live app ' + h.appId + ' · ' + h.url);
        if (!reps.length) { L.push('No changes applied on this page yet.'); return L.join('\n'); }
        L.push(reps.length + ' save' + (reps.length === 1 ? '' : 's') + ' this session · ' + reps.reduce((n, r) => n + (r.changes || []).length, 0) + ' field changes · verify ' + (reps.every(r => r.verify && r.verify.ok) ? 'clean' : 'MISMATCHES — see console'));
        const head = ['save', 'step', 'change', 'before', 'after', 'note', 'action'];
        if (jira) L.push('||' + head.join('||') + '||'); else L.push(head.join('\t'));
        reps.forEach((r, i) => {
            const acts = (r.actions || []).map(a => a.what + (a.step ? ' ' + a.step : '')).join(', ');
            (r.changes || []).forEach(c => {
                const cells = [String(i + 1) + ' · ' + new Date(r.at).toLocaleTimeString(), c.label, c.kind + (c.field ? ' · ' + c.field : ''), c.before != null ? c.before : '', c.after != null ? c.after : '', c.note || '', acts];
                L.push(jira ? '|' + cells.map(x => String(x).replace(/\|/g, '/')).join('|') + '|' : cells.join('\t'));
            });
        });
        return L.join('\n');
    }
    // ---- summary CARD (canvas) — screenshot-ready, copy as image / save PNG ----
    // spec: { title, subtitle, lines[], chips[{label, value, color}], items[{badge, color, text, sub}], footer }
    function renderCard(spec) {
        const W = 980, PAD = 28, SCALE = 2;
        const font = (w, px) => w + ' ' + px + 'px ' + 'Consolas, "Cascadia Mono", "JetBrains Mono", Menlo, monospace';
        const c = document.createElement('canvas'); const ctx = c.getContext('2d');
        // measure pass
        const wrap = (text, px, maxW, weight) => { ctx.font = font(weight || '400', px); const words = String(text).split(' '); const out = []; let line = ''; words.forEach(w => { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }); if (line) out.push(line); return out; };
        const rows = [];
        let y = PAD;
        rows.push({ t: 'title', y, h: 34 }); y += 40;
        wrap(spec.subtitle || '', 15, W - 2 * PAD).forEach(l => { rows.push({ t: 'sub', y, text: l }); y += 22; });
        (spec.lines || []).forEach(l => { wrap(l, 14, W - 2 * PAD).forEach(x => { rows.push({ t: 'line', y, text: x }); y += 20; }); });
        y += 8;
        if (spec.chips && spec.chips.length) { rows.push({ t: 'chips', y }); y += 54; }
        y += 6;
        (spec.items || []).forEach(it => {
            const ls = wrap(it.text, 15, W - 2 * PAD - 70, '600');
            const subs = it.sub ? wrap(it.sub, 13, W - 2 * PAD - 70) : [];
            rows.push({ t: 'item', y, it, ls, subs, h: 12 + ls.length * 22 + subs.length * 18 });
            y += 12 + ls.length * 22 + subs.length * 18 + 8;
        });
        y += 10;
        rows.push({ t: 'footer', y }); y += 26;
        const H = y + PAD - 10;
        c.width = W * SCALE; c.height = H * SCALE; c.style.width = W + 'px'; c.style.height = H + 'px';
        ctx.scale(SCALE, SCALE);
        // paint
        ctx.fillStyle = '#0e1116'; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(95,227,255,.35)'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
        ctx.fillStyle = '#5fe3ff'; ctx.fillRect(0, 0, W, 4);
        rows.forEach(r => {
            if (r.t === 'title') { ctx.fillStyle = '#5fe3ff'; ctx.font = font('700', 24); ctx.fillText(spec.title, PAD, r.y + 24); }
            else if (r.t === 'sub') { ctx.fillStyle = '#cfd3da'; ctx.font = font('400', 15); ctx.fillText(r.text, PAD, r.y + 15); }
            else if (r.t === 'line') { ctx.fillStyle = '#8a8f99'; ctx.font = font('400', 14); ctx.fillText(r.text, PAD, r.y + 14); }
            else if (r.t === 'chips') {
                let x = PAD;
                spec.chips.forEach(ch => {
                    ctx.font = font('700', 22); const vw = ctx.measureText(String(ch.value)).width; ctx.font = font('400', 12); const lw = ctx.measureText(ch.label).width;
                    const w = Math.max(vw, lw) + 28;
                    ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.strokeStyle = ch.color || 'rgba(255,255,255,.18)'; ctx.lineWidth = 1.5;
                    roundRect(ctx, x, r.y, w, 46, 8); ctx.fill(); ctx.stroke();
                    ctx.fillStyle = ch.color || '#e6e6e6'; ctx.font = font('700', 22); ctx.fillText(String(ch.value), x + 14, r.y + 24);
                    ctx.fillStyle = '#8a8f99'; ctx.font = font('400', 12); ctx.fillText(ch.label, x + 14, r.y + 40);
                    x += w + 10;
                });
            }
            else if (r.t === 'item') {
                const it = r.it;
                ctx.fillStyle = 'rgba(255,255,255,.03)'; roundRect(ctx, PAD, r.y, W - 2 * PAD, r.h, 6); ctx.fill();
                ctx.fillStyle = it.color || '#ff7ad9'; roundRect(ctx, PAD + 10, r.y + 10, 44, 24, 5); ctx.fill();
                ctx.fillStyle = '#04222a'; ctx.font = font('800', 13); const bw = ctx.measureText(it.badge).width; ctx.fillText(it.badge, PAD + 10 + (44 - bw) / 2, r.y + 27);
                ctx.fillStyle = '#e6e6e6'; ctx.font = font('600', 15); r.ls.forEach((l, i) => ctx.fillText(l, PAD + 66, r.y + 26 + i * 22));
                ctx.fillStyle = '#8a8f99'; ctx.font = font('400', 13); r.subs.forEach((l, i) => ctx.fillText(l, PAD + 66, r.y + 26 + r.ls.length * 22 + i * 18 - 2));
            }
            else if (r.t === 'footer') { ctx.fillStyle = '#5b6068'; ctx.font = font('400', 12); ctx.fillText(spec.footer || '', PAD, r.y + 12); }
        });
        return c;
    }
    function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    function canvasToBlob(c) { return new Promise((res, rej) => { try { c.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'); } catch (e) { rej(e); } }); }
    function copyCanvasImage(c) {
        return canvasToBlob(c).then(blob => {
            const CI = pageWin.ClipboardItem || window.ClipboardItem;
            if (!CI || !navigator.clipboard || !navigator.clipboard.write) throw new Error('image clipboard not available in this browser — use Save PNG');
            return navigator.clipboard.write([new CI({ 'image/png': blob })]);
        }).then(() => toast('Image copied — paste it into the ticket', false)).catch(e => { warn('copy image:', e); toast('Could not copy the image: ' + e.message, true); });
    }
    function saveCanvasPng(c, name) {
        canvasToBlob(c).then(blob => { const doc = pageWin.top.document; const a = doc.createElement('a'); a.href = pageWin.top.URL.createObjectURL(blob); a.download = name; doc.body.appendChild(a); a.click(); setTimeout(() => { try { pageWin.top.URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 2000); }).catch(e => { warn('save png:', e); toast('Could not save: ' + e.message, true); });
    }
    function checkerCardSpec(res) {
        const h = flightHeader(); const bad = res.rows.filter(r => r.flags.length);
        return {
            title: 'Flight check · ' + (h.mission || ''),
            subtitle: 'flight ' + h.flightId + (h.group != null && h.group >= 0 ? ' · group ' + h.group : '') + ' · ' + new Date(h.when).toLocaleString() + (h.drone ? ' · ' + h.drone : ''),
            lines: ['this flight ' + h.flightSteps + ' steps / ' + h.flightSnaps + ' snapshots · whole mission ' + h.missionSteps + ' steps / ' + h.missionSnaps + ' snapshots'],
            chips: [{ label: 'shots', value: res.summary.shots, color: '#5fe3ff' }, { label: 'need attention', value: bad.length, color: bad.length ? '#ffb347' : '#5fff5f' }, { label: 're-takes', value: res.summary.retakes, color: res.summary.retakes ? '#ffb347' : null }, { label: 'no picture', value: res.summary.missing.length, color: res.summary.missing.length ? '#ff5f5f' : null }],
            items: bad.length ? bad.map(r => ({ badge: r.s, color: r.flags.some(f => f.startsWith('no snapshot') || f.startsWith('re-take')) ? '#ffb347' : '#ff7ad9', text: shotSentence(r).replace(/^\S+ at \S+ — /, ''), sub: 'at ' + r.shutter + (r.asset ? ' · ' + r.asset : '') + ' · heading ' + tri(r.hdg, '°') + ' · camera ' + tri(r.cam, '°') + ' · alt ' + tri([r.alt[0] != null ? r.alt[0] * M_TO_FT : null, r.alt[1] != null ? r.alt[1] * M_TO_FT : null, r.alt[2] != null ? r.alt[2] * M_TO_FT : null], ' ft') + ' (planned / actual / Δ)' })) : [{ badge: 'OK', color: '#5fff5f', text: 'All shots within limits.', sub: 'heading ≤ ' + res.summary.thr.hdg + '° · camera ≤ ' + res.summary.thr.cam + '° · altitude ≤ ' + res.summary.thr.alt + ' ft · off-station ≤ ' + res.summary.thr.pos + ' ft · look-point ≤ ' + res.summary.thr.look + ' ft' }],
            footer: h.url + ' · AIM Video Validation',
        };
    }
    function changeSentences(reps) {
        // Group each save's field changes by step → one line per step in words.
        const out = [];
        reps.forEach((r, i) => {
            const byStep = {};
            (r.changes || []).forEach(c => { (byStep[c.label] = byStep[c.label] || []).push(c); });
            Object.keys(byStep).forEach(label => {
                const cs = byStep[label]; const parts = [];
                cs.forEach(c => {
                    if (c.kind === 'deleted') parts.push('deleted');
                    else if (c.kind === 'added') parts.push('added');
                    else if (c.field === 'position') parts.push('moved ' + (c.note || '') + (c.after ? '' : ''));
                    else if (c.field === 'heading') parts.push('heading ' + c.before + ' → ' + c.after);
                    else if (c.field === 'camera angle') parts.push('camera ' + c.before + ' → ' + c.after);
                    else if (c.field === 'drone alt') parts.push('altitude ' + c.before + ' → ' + c.after);
                    else if (c.field === 'target alt') parts.push('target alt ' + c.before + ' → ' + c.after);
                    else if (c.field === 'abs alt') { /* derived — skip in the summary */ }
                    else parts.push(c.field + ' ' + c.before + ' → ' + c.after);
                });
                if (parts.length) out.push({ badge: label, color: /^N/.test(label) ? '#5fa8ff' : '#ff7ad9', text: parts.join(' · '), sub: 'save ' + (i + 1) + ' at ' + new Date(r.at).toLocaleTimeString() + ' · ' + (r.actions || []).map(a => a.what + (a.step ? ' ' + a.step : '')).join(', ') + (r.verify && r.verify.ok ? ' · verified' : ' · VERIFY MISMATCH') });
            });
        });
        return out;
    }
    function sessionCardSpec(reps) {
        const h = flightHeader();
        const items = changeSentences(reps);
        return {
            title: 'Mission changes · ' + (h.mission || ''),
            subtitle: 'flight ' + h.flightId + (h.group != null && h.group >= 0 ? ' · group ' + h.group : '') + ' · ' + new Date().toLocaleString(),
            lines: ['this flight ' + h.flightSteps + ' steps / ' + h.flightSnaps + ' snapshots · whole mission ' + h.missionSteps + ' steps / ' + h.missionSnaps + ' snapshots · live app ' + h.appId],
            chips: [{ label: 'saves', value: reps.length, color: '#5fe3ff' }, { label: 'steps changed', value: items.length, color: items.length ? '#ffb347' : null }, { label: 'field changes', value: reps.reduce((n, r) => n + (r.changes || []).length, 0) }],
            items: items.length ? items : [{ badge: '—', color: '#8a8f99', text: 'No changes applied on this page yet.' }],
            footer: h.url + ' · AIM Video Validation',
        };
    }
    function copyText(txt, label) {
        const done = () => toast('Copied ' + label + ' to the clipboard', false);
        try { navigator.clipboard.writeText(txt).then(done, () => { fallbackCopy(txt); done(); }); } catch (e) { fallbackCopy(txt); done(); }
    }
    function openReportBox(spec, tableHtml, plain, jira, summaryJira, pngName) {
        if (reportEl) reportEl.remove();
        reportEl = document.createElement('div'); reportEl.className = 'aim-vv-review';
        const card = renderCard(spec);
        reportEl.innerHTML = '<div class="aim-vv-review__box" style="max-width:96vw;padding:10px">'
            + '<div class="aim-vv-edit__row" style="margin:0 0 8px"><button type="button" data-aim-vv-rep="img">📷 Copy as image</button><button type="button" data-aim-vv-rep="png">⬇ Save PNG</button>' + (summaryJira ? '<button type="button" data-aim-vv-rep="summary">Copy as text</button>' : '<button type="button" data-aim-vv-rep="plain">Copy as text</button>') + '<button type="button" data-aim-vv-rep="close">Close</button></div>'
            + '<div class="aim-vv-cardhost"></div>'
            + '<details style="margin-top:8px"><summary class="dim" style="cursor:pointer">details table (numbers) · copy for JIRA</summary>' + tableHtml + '<div class="aim-vv-edit__row" style="margin-top:6px"><button type="button" data-aim-vv-rep="jira">Copy table (JIRA markup)</button><button type="button" data-aim-vv-rep="plain">Copy table (text)</button></div></details></div>';
        reportEl.querySelector('.aim-vv-cardhost').appendChild(card);
        reportEl.__plain = plain; reportEl.__jira = jira; reportEl.__summary = summaryJira; reportEl.__card = card; reportEl.__png = pngName || 'aim-video-validation.png';
        document.body.appendChild(reportEl);
    }
    function onReportClick(e) {
        const b = e.target.closest && e.target.closest('[data-aim-vv-rep]'); if (!b || !reportEl) return;
        e.preventDefault(); e.stopPropagation();
        const what = b.dataset.aimVvRep;
        if (what === 'close') { reportEl.remove(); reportEl = null; }
        else if (what === 'jira') copyText(reportEl.__jira, 'the JIRA table');
        else if (what === 'summary') copyText(reportEl.__summary, 'the summary');
        else if (what === 'img') copyCanvasImage(reportEl.__card);
        else if (what === 'png') saveCanvasPng(reportEl.__card, reportEl.__png);
        else if (what === 'plain') copyText(reportEl.__plain, 'the report');
    }
    function openChecker() {
        if (!model) { toast('No mission loaded', true); return; }
        const res = checkFlight(); const h = flightHeader();
        const cellCls = (flag) => flag ? ' class="warn"' : '';
        const rows = res.rows.map(r => '<tr' + (r.flags.length ? ' style="background:rgba(255,179,71,.08)"' : '') + '><td><b>' + esc(r.s) + '</b></td><td class="dim">' + (r.step != null ? '#' + r.step : '') + '</td><td>' + esc(r.shutter) + '</td>'
            + '<td' + cellCls(r.flags.some(f => f.startsWith('heading'))) + '>' + esc(tri(r.hdg, '°')) + '</td><td' + cellCls(r.flags.some(f => f.startsWith('camera'))) + '>' + esc(tri(r.cam, '°')) + '</td>'
            + '<td' + cellCls(r.flags.some(f => f.startsWith('altitude'))) + '>' + esc(tri([r.alt[0] != null ? r.alt[0] * M_TO_FT : null, r.alt[1] != null ? r.alt[1] * M_TO_FT : null, r.alt[2] != null ? r.alt[2] * M_TO_FT : null], '')) + '</td>'
            + '<td' + cellCls(r.flags.some(f => f.startsWith('off station'))) + '>' + (r.pos != null ? (r.pos * M_TO_FT).toFixed(0) + ' ft ' + esc(r.posDir || '') : '–') + '</td><td' + cellCls(r.flags.some(f => f.startsWith('look-point'))) + '>' + (r.look != null ? r.look.toFixed(0) + ' ft' : '–') + '</td>'
            + '<td class="dim">' + esc(r.asset || '–') + '</td><td>' + (r.flags.length ? '<span class="warn">' + esc(r.flags.join('; ')) + '</span>' : '<span class="ok">ok</span>') + '</td></tr>').join('');
        const table = '<table><tr class="dim"><td>shot</td><td>step</td><td>shutter</td><td>heading p/a/Δ</td><td>camera p/a/Δ</td><td>drone alt ft p/a/Δ</td><td>drone vs nav</td><td>look-point gap</td><td>asset</td><td>flags</td></tr>' + rows + '</table>'
            + '<div style="margin-top:6px">Shots <b>' + res.summary.shots + '</b> · flagged <b>' + res.summary.flagged + '</b> · re-takes <b>' + res.summary.retakes + '</b> · snapshot steps with no picture: ' + (res.summary.missing.length ? '<span class="warn">' + esc(res.summary.missing.join(', ')) + '</span>' : 'none') + '</div>';
        const bad = res.rows.filter(r => r.flags.length);
        const summaryHtml = '<div>' + res.summary.shots + ' shots · <b>' + bad.length + '</b> need' + (bad.length === 1 ? 's' : '') + ' attention · ' + res.summary.retakes + ' re-take' + (res.summary.retakes === 1 ? '' : 's') + (res.summary.missing.length ? ' · <span class="warn">no picture for ' + esc(res.summary.missing.join(', ')) + '</span>' : '') + '</div>'
            + (bad.length ? '<ul style="margin:6px 0 0 18px;padding:0">' + bad.map(r => '<li>' + esc(shotSentence(r)) + '</li>').join('') + '</ul>' : '<div class="ok" style="margin-top:6px">All shots within limits.</div>');
        openReportBox(checkerCardSpec(res), table, checkerText(res, false), checkerText(res, true), checkerSummary(res, false), 'vv-flight-check-' + h.flightId + '.png');
    }
    function openSessionReport() {
        if (!model) { toast('No mission loaded', true); return; }
        const h = flightHeader(); const reps = sessionReports.filter(r => String(r.mid) === String(model.mid));
        const rows = reps.map((r, i) => (r.changes || []).map(c => '<tr><td class="dim">' + (i + 1) + ' · ' + esc(new Date(r.at).toLocaleTimeString()) + '</td><td><b>' + esc(c.label) + '</b></td><td>' + esc(c.kind + (c.field ? ' · ' + c.field : '')) + '</td><td>' + esc(c.before != null ? c.before : '') + '</td><td>' + esc(c.after != null ? c.after : '') + '</td><td class="dim">' + esc(c.note || '') + '</td><td class="dim">' + esc((r.actions || []).map(a => a.what + (a.step ? ' ' + a.step : '')).join(', ')) + '</td></tr>').join('')).join('');
        const table = reps.length ? '<table><tr class="dim"><td>save</td><td>step</td><td>change</td><td>before</td><td>after</td><td>note</td><td>action</td></tr>' + rows + '</table>' : '<div class="dim">No changes applied on this page yet — Apply something first.</div>';
        openReportBox(sessionCardSpec(reps), table, sessionText(false), sessionText(true), null, 'vv-changes-' + h.flightId + '.png');
    }
    // ---- toast ----
    let toastEl = null;
    function toast(msg, bad) {
        try {
            if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'aim-vv-toast'; document.body.appendChild(toastEl); }
            toastEl.textContent = msg; toastEl.classList.toggle('aim-vv-toast--bad', !!bad); toastEl.style.display = 'block';
            clearTimeout(toastEl._t); toastEl._t = setTimeout(() => { toastEl.style.display = 'none'; }, bad ? 7000 : 3500);
        } catch (e) { log(msg); }
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
            ensureBar();
            renderLegend();
            loadGroupMeta();
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
        try { if (flownLayer && flownLayer.__aimVvOrig) { flownLayer.setStyle(flownLayer.__aimVvOrig); if (flownLayer._path) flownLayer._path.classList.remove('aim-vv-flown'); } } catch (e) {} flownLayer = null;
        try { ed.ghosts.forEach(l => { try { ov.map && ov.map.removeLayer(l); } catch (e2) {} }); } catch (e) {}
        ed.ghosts = []; ed.work = null; ed.open = false; ed.busy = false; if (ed.placing) setPlacing(null);
        if (ed.panelEl) { try { ed.panelEl.remove(); } catch (e) {} ed.panelEl = null; }
        if (ed.reviewEl) { try { ed.reviewEl.remove(); } catch (e) {} ed.reviewEl = null; }
        try { if (ov.zoomHooked && ov.zoomHookedMap) ov.zoomHookedMap.off('zoomend', onOverlayZoom); } catch (e) { /* map gone */ }
        ov.zoomHooked = false; ov.zoomHookedMap = null;
        ov.group = null; ov.groupLoading = false; ov.map = null; ov.svg = null; activeOverlayKey = null;
        if (groupPanelEl) { try { groupPanelEl.remove(); } catch (e) {} }
        if (groupHost) { try { groupHost.classList.remove('aim-vv-split'); } catch (e) {} }
        groupPanelEl = null; groupHost = null; legendEl = null; groupMetaLoading = false;
        if (navBtnEls) { navBtnEls.forEach(b => { try { b.remove(); } catch (e) {} }); navBtnEls = null; }
        document.documentElement.classList.remove('aim-vv-own-nav');
        if (legendBox) { try { legendBox.remove(); } catch (e) {} legendBox = null; }
        if (cardEl) { try { cardEl.remove(); } catch (e) {} cardEl = null; }
        if (barEl) { try { barEl.remove(); } catch (e) {} barEl = null; }
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
            hookVideo(); scheduleStamp(); ensureCard(); ensureBar(); renderLegend(); updateBarNow();
            try { fixCounter(); ensureNavButtons(); } catch (e) { warn('counter/nav:', e); }
            try { styleFlownPath(); } catch (e) { warn('flown style:', e); }
            try { ensureLegend(); } catch (e) { warn('legend:', e); }
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
            'overlay': 'overlay', 'overlay-actual': 'overlayActual', 'overlay-labels': 'overlayLabels', 'overlay-group': 'overlayGroup', 'time-bar': 'timeBar',
            'edit': 'edit', 'turn-step': 'stepDeg', 'tilt-step': 'stepPitch', 'move-step': 'stepFt', 'alt-step': 'stepAltFt', 'ray-cap-ft': 'rayCapFt',
            'flown-dashed': 'flownDashed', 'flown-color': 'flownColor', 'look-points': 'lookPoints',
            'nav-color': 'navColor', 'snap-color': 'snapColor', 'actual-color': 'actualColor', 'live-diff': 'liveDiffOverlay', 'live-color': 'liveColor',
            'follow': 'follow', 'follow-zoom': 'followZoom', 'actual-look': 'actualLookPoints', 'legend': 'legend',
            'chk-hdg': 'chkHdg', 'chk-cam': 'chkCam', 'chk-alt': 'chkAltFt', 'chk-pos': 'chkPosFt', 'chk-look': 'chkLookFt',
            'nav-line-w': 'navLineW', 'snap-line-w': 'snapLineW', 'actual-line-w': 'actualLineW', 'flown-line-w': 'flownLineW' };
        const key = map[id]; if (!key) return;
        let v = val;
        if (key === 'leadInS') { v = parseFloat(val); if (!isFinite(v) || v < 0 || v > 60) return; }
        else if (['stepDeg', 'stepPitch', 'stepFt', 'stepAltFt', 'rayCapFt'].includes(key)) { v = parseFloat(val); if (!isFinite(v) || v <= 0) return; }
        else if (key === 'units') { v = (val === 'm') ? 'm' : 'ft'; }
        else if (key === 'flownColor' || key === 'navColor' || key === 'snapColor' || key === 'actualColor' || key === 'liveColor') { v = /^#[0-9a-f]{6}$/i.test(String(val)) ? String(val) : DEFAULTS[key]; }
        else if (/LineW$/.test(key)) { v = parseFloat(val); if (!isFinite(v) || v < 0.5 || v > 12) return; }
        else if (key === 'followZoom') { v = parseFloat(val); if (!isFinite(v) || v < 14 || v > 22) return; }
        else if (/^chk/.test(key)) { v = parseFloat(val); if (!isFinite(v) || v < 0) return; }
        else v = !!val;
        if (settings[key] === v) return;   // idempotent — CP echoes from both frames
        settings[key] = v; saveSettings();
        log(id + ' = ' + JSON.stringify(v));
        if (!IS_TOP && model) {
            if (key === 'stripOrder' || key === 'badges') stampStrip(true);
            if (key === 'shotCard') { ensureCard(); if (selectedRec) renderCard(selectedRec, 'selected'); }
            if (key === 'units' && selectedRec) renderCard(selectedRec, 'selected');
            if (key === 'overlay' || key === 'overlayActual' || key === 'overlayLabels') drawOverlay();
            if (key === 'timeBar') ensureBar();
            if (key === 'flownDashed' || key === 'flownColor') styleFlownPath(true);
            if (key === 'lookPoints' || key === 'liveDiffOverlay' || key === 'liveColor' || key === 'actualLookPoints') drawOverlay();
            if (key === 'legend' || /Color$/.test(key)) ensureLegend();
            if (key === 'navColor' || key === 'snapColor' || key === 'actualColor' || /LineW$/.test(key)) { syncOverlayStyle(); drawOverlay(); stampStrip(true); styleFlownPath(true); }
            if (key === 'edit' || key.startsWith('step') || key === 'rayCapFt') { if (!settings.edit) ed.open = false; renderEdit(); }
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
                else if (id === 'dump-geo') dumpGeometry();
                else if (id === 'check-flight') openChecker();
                else if (id === 'session-report') openSessionReport();
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
                    { id: 'time-bar', label: 'Time bar under the player (±10/30 s, jump to time)', type: 'boolean', default: DEFAULTS.timeBar },
                    { id: 'hdr-chk', type: 'header', label: 'Flight checker thresholds (flag a shot when …)' },
                    { id: 'chk-hdg', label: 'heading off by more than (°)', type: 'number', default: DEFAULTS.chkHdg, min: 0, max: 180 },
                    { id: 'chk-cam', label: 'camera angle off by more than (°)', type: 'number', default: DEFAULTS.chkCam, min: 0, max: 90 },
                    { id: 'chk-alt', label: 'drone altitude off by more than (ft)', type: 'number', default: DEFAULTS.chkAltFt, min: 0, max: 1000 },
                    { id: 'chk-pos', label: 'drone more than this from its nav (ft)', type: 'number', default: DEFAULTS.chkPosFt, min: 0, max: 5000 },
                    { id: 'chk-look', label: 'planned vs actual look-point gap over (ft)', type: 'number', default: DEFAULTS.chkLookFt, min: 0, max: 5000 },
                    { id: 'check-flight', label: '🔎 Check this flight (re-takes, deviations, missing shots)', type: 'button' },
                    { id: 'session-report', label: '📋 Session change report (copy for JIRA)', type: 'button' },
                    { id: 'hdr-edit', type: 'header', label: 'Editing (writes the mission plan)' },
                    { id: 'edit', label: 'Adjust panel — EXPERIMENTAL: nudge / adopt / convert / delete / duplicate, saves to the mission', type: 'boolean', default: DEFAULTS.edit },
                    { id: 'turn-step', label: 'Turn step (degrees; Shift ×5)', type: 'number', default: DEFAULTS.stepDeg, min: 0.5, max: 90 },
                    { id: 'tilt-step', label: 'Camera tilt step (degrees; Shift ×5)', type: 'number', default: DEFAULTS.stepPitch, min: 0.5, max: 45 },
                    { id: 'move-step', label: 'Move step (ft; Shift ×5)', type: 'number', default: DEFAULTS.stepFt, min: 0.5, max: 500 },
                    { id: 'alt-step', label: 'Altitude step (ft; Shift ×5)', type: 'number', default: DEFAULTS.stepAltFt, min: 0.5, max: 200 },
                    { id: 'ray-cap-ft', label: 'Convert → GPS: max ray distance (ft)', type: 'number', default: DEFAULTS.rayCapFt, min: 50, max: 5000 },
                    { id: 'units', label: 'Units', type: 'select', default: DEFAULTS.units, options: [{ value: 'ft', label: 'ft' }, { value: 'm', label: 'm' }] },
                    { id: 'hdr-map', type: 'header', label: 'Map overlay' },
                    { id: 'overlay', label: 'Plan steps on the map (N# / S#)', type: 'boolean', default: DEFAULTS.overlay },
                    { id: 'overlay-actual', label: 'Actual shot poses (cyan: drone, heading, footprint)', type: 'boolean', default: DEFAULTS.overlayActual },
                    { id: 'overlay-labels', label: 'Number labels (off = plain dots)', type: 'boolean', default: DEFAULTS.overlayLabels },
                    { id: 'overlay-group', label: 'Whole mission group (color per flight, whole-mission numbering)', type: 'boolean', default: DEFAULTS.overlayGroup },
                    { id: 'flown-dashed', label: 'Flown path: restyle (dashed)', type: 'boolean', default: DEFAULTS.flownDashed },
                    { id: 'flown-color', label: 'Flown path color', type: 'color', default: DEFAULTS.flownColor },
                    { id: 'look-points', label: 'Planned look-points for in-place snapshots (ray to terrain)', type: 'boolean', default: DEFAULTS.lookPoints },
                    { id: 'legend', label: 'Legend box on the map (bottom-left, collapsible)', type: 'boolean', default: DEFAULTS.legend },
                    { id: 'follow', label: 'Selecting a snapshot pans / zooms the map to it', type: 'boolean', default: DEFAULTS.follow },
                    { id: 'follow-zoom', label: 'Follow: max zoom level', type: 'number', default: DEFAULTS.followZoom, min: 14, max: 22 },
                    { id: 'actual-look', label: 'Actual look-points (cyan ring where the real camera ray met the ground)', type: 'boolean', default: DEFAULTS.actualLookPoints },
                    { id: 'live-diff', label: 'Show the CURRENT saved plan where it differs from what flew (yellow)', type: 'boolean', default: DEFAULTS.liveDiffOverlay },
                    { id: 'live-color', label: 'Saved-plan (differs) color', type: 'color', default: DEFAULTS.liveColor },
                    { id: 'nav-color', label: 'Nav color (N#)', type: 'color', default: DEFAULTS.navColor },
                    { id: 'snap-color', label: 'Snapshot color (S#, sightlines)', type: 'color', default: DEFAULTS.snapColor },
                    { id: 'actual-color', label: 'Actual shot color (rings, footprints)', type: 'color', default: DEFAULTS.actualColor },
                    { id: 'nav-line-w', label: 'Nav→nav line weight (px)', type: 'number', default: DEFAULTS.navLineW, min: 0.5, max: 12 },
                    { id: 'snap-line-w', label: 'Sightline weight (nav→snapshot, px)', type: 'number', default: DEFAULTS.snapLineW, min: 0.5, max: 12 },
                    { id: 'actual-line-w', label: 'Actual shot weight (footprint, heading tick, px)', type: 'number', default: DEFAULTS.actualLineW, min: 0.5, max: 12 },
                    { id: 'flown-line-w', label: 'Flown path weight (px)', type: 'number', default: DEFAULTS.flownLineW, min: 0.5, max: 12 },
                    { id: 'reload', label: 'Reload mission data', type: 'button' },
                    { id: 'dump-geo', label: 'Dump snapshot geometry to console (diagnostic)', type: 'button' },
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
        document.addEventListener('click', onLegendToggle, true);
        document.addEventListener('click', onBarClick, true);
        document.addEventListener('click', onEditClick, true);
        document.addEventListener('change', (e) => { const c = e.target; if (!c || !c.matches) return; if (c.matches('[data-aim-vv-ed-check="nav-keep-aim"]')) { settings.navKeepAim = !!c.checked; saveSettings(); log('nav keep-aim = ' + settings.navKeepAim); } else if (c.matches('[data-aim-vv-restore-file]')) onRestoreFile(e); }, true);
        document.addEventListener('click', onMapPlaceClick, true);
        window.addEventListener('keydown', onPlaceKey, true);
        document.addEventListener('keydown', (e) => { const t = e.target; if (t && t.matches && t.matches('[data-aim-vv-latlng]')) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); const b = ed.panelEl && ed.panelEl.querySelector('[data-aim-vv-ed="nav-set"]'); if (b) b.click(); } } }, true);
        document.addEventListener('click', onCopyClick, true);
        document.addEventListener('mousedown', onScrubDown, true);
        document.addEventListener('mousemove', onScrubMove, true);
        document.addEventListener('mouseup', onScrubUp, true);
        document.addEventListener('wheel', onScrubWheel, { capture: true, passive: false });
        document.addEventListener('click', onReviewClick, true);
        document.addEventListener('click', onReportClick, true);
        document.addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('[data-aim-vv-tool]'); if (!t || !model) return; e.preventDefault(); e.stopPropagation(); if (t.dataset.aimVvTool === 'check') openChecker(); else openSessionReport(); }, true);
        document.addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('[data-aim-vv-ed-toggle]'); if (!t || !model) return; e.preventDefault(); e.stopPropagation(); ed.open = !ed.open; if (ed.open) edEnsureWork(); renderEdit(); if (selectedRec) renderCard(selectedRec, 'selected'); }, true);
        installCsrfSniffer();
        window.addEventListener('keydown', fallbackKeys, true);
        tickTimer = setInterval(tick, 1000);
        tick();
    }
    if (!IS_TOP) { try { pageWin.__aimVv = { get model() { return model; }, get overlay() { return ov; }, settings, dump: dumpGeometry }; } catch (e) { /* sandbox */ } }
    log('ready (' + (IS_TOP ? 'top: panel registration only' : 'iframe: watching for the playback route') + ')');
})();
