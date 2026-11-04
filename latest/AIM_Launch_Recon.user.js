// ==UserScript==
// @name         Latest - AIM Launch Recon
// @namespace    http://tampermonkey.net/
// @version      0.1
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Launch_Recon.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Launch_Recon.user.js
// @description  v0.1: passive recorder for the mission-launch / resume / incomplete-mission write path. Logs every POST/PUT/PATCH/DELETE (and any GET touching mission_group / missions / launch) in the top window and the react-pages iframe to GM storage: method, url, request body, response head. Dev-only, personal. Dump with __aimLaunchDump() (console) or __aimLaunchDownload() (JSON file).
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @match        *://qa.percepto.app/*
// @match        https://qa.percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// AIM Launch Recon — passive request recorder for the Launch page's resume /
// incomplete-mission write path (we have never seen the Resume POST or the trash
// DELETE; see memory reference_mission_group_endpoint). Changes nothing: wraps
// fetch + XHR, records interesting exchanges to GM storage (cap 150, debounced).
// Hotkeys: none. Console: __aimLaunchDump() / __aimLaunchDownload() / __aimLaunchClear().
// Log tag: [AIM LAUNCH RECON]
(function() {
    'use strict';
    const TAG = '[AIM LAUNCH RECON]';
    const KEY = 'aim-launch-recon';
    const CAP = 150;
    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const FRAME = (W === W.top) ? 'TOP' : 'IFRAME@' + (location.pathname || '').slice(0, 40);
    console.log(`${TAG} init ${FRAME}`);

    let recs = [];
    try { const v = GM_getValue(KEY, '[]'); recs = JSON.parse(v); if (!Array.isArray(recs)) recs = []; }
    catch (e) { console.warn(`${TAG} stored records unreadable — starting fresh`, e); recs = []; }

    let saveTimer = null;
    function scheduleSave() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            try {
                // merge with what other frames wrote since we loaded (per-frame copies)
                let other = [];
                try { other = JSON.parse(GM_getValue(KEY, '[]')); } catch (e) { other = []; }
                const seen = new Set(recs.map(r => r.k));
                const merged = recs.concat((Array.isArray(other) ? other : []).filter(r => r && !seen.has(r.k)));
                merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
                recs = merged.slice(-CAP);
                GM_setValue(KEY, JSON.stringify(recs));
            } catch (e) { console.warn(`${TAG} save failed`, e); }
        }, 1500);
    }

    const cap = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s) : s == null ? null : String(s).slice(0, n));
    const rel = u => String(u).replace(location.origin, '');
    const interesting = (m, u) => m !== 'GET' || /mission_group|\/missions\/|launch|resume|quick/i.test(String(u));
    const skip = u => /\/cdn-cgi\/|\/rum|amplitude|zendesk|sentry/i.test(String(u));

    function add(r) {
        r.k = `${r.at}|${r.method}|${r.url}`;
        recs.push(r);
        if (recs.length > CAP) recs = recs.slice(-CAP);
        console.log(`${TAG} ${FRAME} ${r.kind} ${r.method} ${r.status} ${r.url}`, r.reqBody ? cap(r.reqBody, 200) : '');
        scheduleSave();
    }

    try {
        const F = W.fetch;
        W.fetch = async function(input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            let reqBody = null;
            try { reqBody = init && init.body != null ? (typeof init.body === 'string' ? init.body : Object.prototype.toString.call(init.body)) : null; } catch (e) { reqBody = '(unreadable body)'; }
            const t0 = Date.now();
            const res = await F.apply(this, arguments);
            try {
                const same = String(url).startsWith('/') || String(url).startsWith(location.origin);
                if (same && !skip(url) && interesting(method, url)) {
                    res.clone().text().then(t => add({
                        at: new Date().toISOString(), frame: FRAME, kind: 'fetch', method, url: rel(url), status: res.status, ms: Date.now() - t0,
                        reqHeaders: init && init.headers ? cap(JSON.stringify(init.headers), 400) : null, reqBody: cap(reqBody, 6000), resBody: cap(t, 2000),
                    })).catch(e => console.warn(`${TAG} response read failed`, e));
                }
            } catch (e) { console.warn(`${TAG} fetch tap failed`, e); }
            return res;
        };
        const XP = W.XMLHttpRequest.prototype, XO = XP.open, XS = XP.send;
        XP.open = function(m, u) { this.__aimM = String(m).toUpperCase(); this.__aimU = u; return XO.apply(this, arguments); };
        XP.send = function(b) {
            const t0 = Date.now();
            this.addEventListener('loadend', () => {
                try {
                    const u = this.__aimU;
                    const same = String(u).startsWith('/') || String(u).startsWith(location.origin);
                    if (same && !skip(u) && interesting(this.__aimM, u)) {
                        add({ at: new Date().toISOString(), frame: FRAME, kind: 'xhr', method: this.__aimM, url: rel(u), status: this.status, ms: Date.now() - t0,
                            reqBody: cap(typeof b === 'string' ? b : (b == null ? null : Object.prototype.toString.call(b)), 6000),
                            resBody: cap(typeof this.responseText === 'string' ? this.responseText : '', 2000) });
                    }
                } catch (e) { console.warn(`${TAG} xhr tap failed`, e); }
            });
            return XS.apply(this, arguments);
        };
    } catch (e) { console.error(`${TAG} hook install failed — recorder inactive in ${FRAME}`, e); return; }

    const all = () => { let s = []; try { s = JSON.parse(GM_getValue(KEY, '[]')); } catch (e) { s = []; } const seen = new Set(recs.map(r => r.k)); return recs.concat((Array.isArray(s) ? s : []).filter(r => r && !seen.has(r.k))).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); };
    W.__aimLaunchDump = () => { const a = all(); console.log(`${TAG} ${a.length} record(s). COPY THIS:`); console.log(JSON.stringify(a, null, 1)); return a.length; };
    W.__aimLaunchDownload = () => {
        try {
            const a = all();
            const blob = new Blob([JSON.stringify({ savedAt: new Date().toISOString(), origin: location.origin, records: a }, null, 1)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const el = document.createElement('a'); el.href = url; el.download = `aim_launch_recon_${Date.now()}.json`;
            document.body.appendChild(el); el.click(); el.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            console.log(`${TAG} downloaded ${a.length} record(s)`);
            return a.length;
        } catch (e) { console.error(`${TAG} download failed`, e); return -1; }
    };
    W.__aimLaunchClear = () => { recs = []; try { GM_setValue(KEY, '[]'); } catch (e) { console.warn(`${TAG} clear failed`, e); } console.log(`${TAG} cleared`); };
    console.log(`${TAG} ready ${FRAME} — ${recs.length} stored record(s)`);
})();
