// ==UserScript==
// @name         Latest - AIM Time Tracker
// @namespace    http://tampermonkey.net/
// @version      0.1
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Time_Tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Time_Tracker.user.js
// @description  Passive CSM time capture: records which site/area you're actively working in (focused tab only, idle-aware), per-tab open/close spans, and which AIM tools fired. Phase 1 = LOCAL-ONLY capture + debug readout for validation; no sync, no UI beyond the debug panel. Design: ShortKeys/AIM_Time_Tracker_Design.md.
// @author       Payden
// @match        *://percepto.app/*
// @match        *://qa.percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @match        https://qa.percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

// AIM Time Tracker — Phase 1 capture engine (local-only).
// What it does: turns raw focus + input activity into per-(site, area) time slices,
// stored raw (real minutes) in GM storage; 15-min rounding happens only at display.
// Hotkeys: Shift+T — toggle the capture debug panel (via Control Panel router).
// Log tag: [AIM TIME]
(function() {
    'use strict';

    const SCRIPT_ID = 'aim-time-tracker';
    const SCRIPT_VERSION = '0.1';
    const IS_TOP = window === window.top;
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';

    const TICK_MS = 10 * 1000;          // capture state machine cadence
    const DEFAULT_IDLE_MIN = 5;         // no input for this long => stop accruing
    const MIN_SLICE_S = 20;             // shorter than this is focus noise, not work
    const HEARTBEAT_STALE_MS = 5 * 60 * 1000;  // registry entries older than this = tab gone
    const KEEP_DAYS = 45;               // local retention before pruning old day keys
    const EV_PREFIX = 'aim-tt-ev:';     // per-day, PER-TAB event keys: aim-tt-ev:<date>:<tabId>
    const TABS_KEY = 'aim-tt-tabs';     // live heartbeat registry (display/diagnostics only)

    // With @grant, the sandbox console can be invisible in the page console — log via the page's.
    const pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const log = function() {
        try { (pageWin.console || console).log.apply(null, ['[AIM TIME]'].concat([].slice.call(arguments))); }
        catch (e) { console.log('[AIM TIME]', e); }
    };

    // Per-tab identity shared across frames via the REAL page top (same-origin).
    // Must match the Control Panel's aimTabId — CP stamps this id on HOTKEY_FIRED /
    // TRIGGER_ACTION, which both gates hotkeys tab-locally AND lets us tool-tag
    // slices with "fired in THIS tab" certainty.
    function aimTabId() {
        try {
            const t = pageWin.top;
            if (!t.__AIM_TAB_ID) t.__AIM_TAB_ID = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
            return t.__AIM_TAB_ID;
        } catch (e) { return null; }
    }

    // ---------------------------------------------------------------
    // Activity signal — every frame reports input to the top instance.
    // ---------------------------------------------------------------
    let lastForward = 0;
    function forwardActivity() {
        const now = Date.now();
        if (now - lastForward < 1000) return;   // 1/s is plenty for a 5-min idle window
        lastForward = now;
        try {
            const t = pageWin.top;
            if (t.__aimTTActivity) t.__aimTTActivity();
        } catch (e) { /* cross-origin frame — not ours, ignore */ }
    }
    ['keydown', 'pointerdown', 'pointermove', 'wheel'].forEach(function(ev) {
        window.addEventListener(ev, forwardActivity, { capture: true, passive: true });
    });

    if (!IS_TOP) {
        log('init v' + SCRIPT_VERSION + ' (iframe — activity forwarder only)');
        return;
    }

    // =============================================================
    // Everything below runs in the TOP frame only.
    // =============================================================
    log('init v' + SCRIPT_VERSION + ' (top)');

    const TAB_ID = aimTabId();
    let masterEnabled = true;
    let idleMin = DEFAULT_IDLE_MIN;
    let lastActivityTs = Date.now();
    try { pageWin.top.__aimTTActivity = function() { lastActivityTs = Date.now(); }; }
    catch (e) { log('could not install activity hook:', e); }

    // ---------------------------------------------------------------
    // Context detection — site + area from the URL. Unknown route
    // segments are recorded verbatim so Phase 1 validation can lock
    // the real route→area map (routes are guesses until proven).
    // ---------------------------------------------------------------
    const routesSeen = {};   // rawRoute -> mapped area (debug panel table)
    function detectContext() {
        const env = location.hostname.indexOf('qa.') === 0 ? 'qa' : 'prod';
        if (location.pathname.indexOf('/admin') === 0) {
            return { env: env, site: null, area: 'admin', route: location.pathname };
        }
        const hash = location.hash || '';
        const m = hash.match(/#\/site\/(\d+)\/?([^?]*)/);
        if (!m) {
            // Site-less app surface (landing/site picker/etc.) — not work on a site; don't accrue.
            return { env: env, site: null, area: null, route: hash.slice(0, 60) || location.pathname };
        }
        const rawSeg = (m[2] || '').split('/')[0] || '(root)';
        let area = 'other';
        if (/setup/i.test(rawSeg)) area = 'site_setup';
        else if (/mission/i.test(rawSeg)) area = 'missions';
        else if (/data/i.test(rawSeg)) area = 'data_view';
        else if (/dashboard|overview|\(root\)/i.test(rawSeg)) area = 'overview';
        routesSeen[rawSeg] = area;
        return { env: env, site: m[1], area: area, route: rawSeg };
    }

    // ---------------------------------------------------------------
    // Storage — per-day, PER-TAB event keys so concurrent tabs never
    // read-modify-write race each other. Readers merge all tab keys.
    // ---------------------------------------------------------------
    function dayKey(ts) {
        const d = new Date(ts);
        const p = function(n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    function myEvKey(ts) { return EV_PREFIX + dayKey(ts) + ':' + TAB_ID; }

    function appendEvent(ev) {
        try {
            const key = myEvKey(ev.start || ev.ts || Date.now());
            const arr = GM_getValue(key, []);
            arr.push(ev);
            GM_setValue(key, arr);
        } catch (e) { log('appendEvent failed:', e, ev); }
    }

    function readDayEvents(date) {
        const out = [];
        try {
            GM_listValues().forEach(function(k) {
                if (k.indexOf(EV_PREFIX + date + ':') === 0) {
                    const arr = GM_getValue(k, []);
                    for (let i = 0; i < arr.length; i++) out.push(arr[i]);
                }
            });
        } catch (e) { log('readDayEvents failed:', e); }
        out.sort(function(a, b) { return (a.start || a.ts || 0) - (b.start || b.ts || 0); });
        return out;
    }

    function pruneOldKeys() {
        try {
            const cutoff = dayKey(Date.now() - KEEP_DAYS * 86400000);
            GM_listValues().forEach(function(k) {
                if (k.indexOf(EV_PREFIX) === 0 && k.slice(EV_PREFIX.length, EV_PREFIX.length + 10) < cutoff) {
                    GM_deleteValue(k);
                }
            });
        } catch (e) { log('prune failed:', e); }
    }

    // ---------------------------------------------------------------
    // Slice state machine. A slice = contiguous ACTIVE time on one
    // (site, area). Active = this tab focused+visible AND input within
    // the idle window. Only the focused tab accrues — N open tabs
    // never double-count. Raw minutes stored; rounding is display-only.
    // ---------------------------------------------------------------
    let cur = null;   // {site, env, area, route, start, lastSeen, tools:{}}

    function isActive() {
        return document.hasFocus() &&
               document.visibilityState === 'visible' &&
               (Date.now() - lastActivityTs) < idleMin * 60000;
    }

    function closeSlice(endTs, reason) {
        if (!cur) return;
        const end = Math.max(cur.start, Math.min(endTs, cur.lastSeen + TICK_MS));
        const secs = (end - cur.start) / 1000;
        if (secs >= MIN_SLICE_S) {
            appendEvent({
                v: 1, type: 'slice', tabId: TAB_ID,
                site: cur.site, env: cur.env, area: cur.area, route: cur.route,
                start: cur.start, end: end, mins: Math.round(secs / 6) / 10,
                tools: Object.keys(cur.tools), closed: reason
            });
        }
        cur = null;
        persistLive();
    }

    // Crash insurance: the open slice is mirrored to a sidecar ':live' key
    // every tick; a crashed tab's last mirror becomes the closed slice at
    // read time (see readDayLedger). Track the key we wrote so closing a
    // slice always clears ITS mirror — even across a midnight rollover,
    // where the mirror lives under yesterday's key (a stale mirror would
    // double-count against the real closed slice).
    let lastLiveKey = null;
    function persistLive() {
        try {
            if (!cur) {
                if (lastLiveKey) { GM_setValue(lastLiveKey, null); lastLiveKey = null; }
                return;
            }
            const key = myEvKey(cur.start) + ':live';
            if (lastLiveKey && lastLiveKey !== key) GM_setValue(lastLiveKey, null);
            lastLiveKey = key;
            GM_setValue(key, {
                v: 1, type: 'slice', tabId: TAB_ID, live: true,
                site: cur.site, env: cur.env, area: cur.area, route: cur.route,
                start: cur.start, end: cur.lastSeen,
                mins: Math.round((cur.lastSeen - cur.start) / 6000) / 10,
                tools: Object.keys(cur.tools)
            });
        } catch (e) { log('persistLive failed:', e); }
    }

    function tick() {
        try {
            if (!masterEnabled) { closeSlice(Date.now(), 'disabled'); heartbeat(false); return; }
            const now = Date.now();
            const ctx = detectContext();
            const active = isActive() && !!ctx.area;   // area null = site-less landing, never accrue
            const ctxChanged = cur && (cur.site !== ctx.site || cur.area !== ctx.area || cur.env !== ctx.env);

            if (cur && (!active || ctxChanged)) {
                closeSlice(active ? now : lastActivityTs, ctxChanged ? 'nav' : (document.hasFocus() ? 'idle' : 'blur'));
            }
            if (!cur && active) {
                cur = { site: ctx.site, env: ctx.env, area: ctx.area, route: ctx.route,
                        start: now, lastSeen: now, tools: {} };
            }
            if (cur && active) { cur.lastSeen = now; persistLive(); }

            // Day rollover with a slice open across midnight: close into the old day, reopen fresh.
            if (cur && dayKey(cur.start) !== dayKey(now)) { closeSlice(now, 'midnight'); }

            heartbeat(active, ctx);
        } catch (e) { log('tick failed:', e); }
    }

    // Live tab registry — display/diagnostics only ("3 tabs open on Site A").
    // Cross-tab read-modify-write can drop a beat; each tab rewrites its own
    // entry every tick, so the registry self-heals within one cadence.
    function heartbeat(active, ctx) {
        try {
            const tabs = GM_getValue(TABS_KEY, {});
            tabs[TAB_ID] = { ts: Date.now(), site: ctx ? ctx.site : null, area: ctx ? ctx.area : null,
                             env: ctx ? ctx.env : null, focused: !!active };
            Object.keys(tabs).forEach(function(id) {
                if (Date.now() - (tabs[id].ts || 0) > HEARTBEAT_STALE_MS) delete tabs[id];
            });
            GM_setValue(TABS_KEY, tabs);
        } catch (e) { log('heartbeat failed:', e); }
    }

    // Tab open/close span events.
    appendEvent({ v: 1, type: 'tab_open', tabId: TAB_ID, ts: Date.now() });
    window.addEventListener('pagehide', function() {
        try {
            closeSlice(Date.now(), 'unload');
            appendEvent({ v: 1, type: 'tab_close', tabId: TAB_ID, ts: Date.now() });
            const tabs = GM_getValue(TABS_KEY, {});
            delete tabs[TAB_ID];
            GM_setValue(TABS_KEY, tabs);
        } catch (e) { /* page is going away; nothing recoverable */ }
    });

    // ---------------------------------------------------------------
    // Tool tags — free labels from the AIM ecosystem. CP stamps tabId
    // on hotkey/action broadcasts; exact match = fired in THIS tab.
    // READ-ONLY listener: the tracker never fires actions itself.
    // ---------------------------------------------------------------
    function tagTool(scriptId, what) {
        if (cur && scriptId && scriptId !== SCRIPT_ID) cur.tools[scriptId + ':' + what] = true;
    }

    // ---------------------------------------------------------------
    // Ledger + debug panel.
    // ---------------------------------------------------------------
    function readDayLedger(date) {
        const events = readDayEvents(date);
        // fold in live mirrors (this tab's open slice + any crashed tab's remnant)
        try {
            GM_listValues().forEach(function(k) {
                if (k.indexOf(EV_PREFIX + date + ':') === 0 && k.slice(-5) === ':live') {
                    const lv = GM_getValue(k, null);
                    if (lv) events.push(lv);
                }
            });
        } catch (e) { log('live merge failed:', e); }
        const rows = {};   // "<site>|<area>|<env>" -> mins
        let tabsOpen = 0, tabsClosed = 0;
        events.forEach(function(ev) {
            if (ev.type === 'slice') {
                const key = (ev.site || '—') + '|' + ev.area + '|' + ev.env;
                if (!rows[key]) rows[key] = { site: ev.site, area: ev.area, env: ev.env, mins: 0, tools: {} };
                rows[key].mins += ev.mins || 0;
                (ev.tools || []).forEach(function(t) { rows[key].tools[t] = true; });
            }
            else if (ev.type === 'tab_open') tabsOpen++;
            else if (ev.type === 'tab_close') tabsClosed++;
        });
        return { events: events, rows: rows, tabsOpen: tabsOpen, tabsClosed: tabsClosed };
    }

    function round15(mins) { return Math.max(mins > 1 ? 15 : 0, Math.round(mins / 15) * 15); }
    function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, function(c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }); }

    let panelEl = null;
    let panelTimer = null;
    function togglePanel() { panelEl ? destroyPanel() : buildPanel(); }
    function destroyPanel() {
        if (panelTimer) clearInterval(panelTimer);
        panelTimer = null;
        if (panelEl) panelEl.remove();
        panelEl = null;
    }
    function buildPanel() {
        panelEl = document.createElement('div');
        panelEl.id = 'aim-tt-debug';
        panelEl.style.cssText = 'position:fixed;bottom:14px;left:14px;z-index:2147483000;width:430px;max-height:70vh;' +
            'overflow:auto;background:#0d1117;color:#c9d1d9;border:1px solid #22d3ee55;border-radius:10px;' +
            'font:12px/1.5 monospace;padding:10px 12px;box-shadow:0 8px 30px rgba(0,0,0,.6)';
        document.body.appendChild(panelEl);
        panelEl.addEventListener('click', function(e) {
            const act = e.target.closest('[data-tt]');
            if (!act) return;
            if (act.dataset.tt === 'close') destroyPanel();
            else if (act.dataset.tt === 'copy') {
                const dump = JSON.stringify(readDayLedger(dayKey(Date.now())).events, null, 1);
                navigator.clipboard.writeText(dump).then(
                    function() { log('day JSON copied (' + dump.length + ' chars)'); },
                    function(err) { log('clipboard copy failed:', err); });
            }
        });
        renderPanel();
        panelTimer = setInterval(renderPanel, 2000);
    }
    function renderPanel() {
        if (!panelEl) return;
        try {
            const today = dayKey(Date.now());
            const led = readDayLedger(today);
            const ctx = detectContext();
            const state = !masterEnabled ? 'DISABLED' : !document.hasFocus() ? 'blurred'
                : (Date.now() - lastActivityTs) >= idleMin * 60000 ? 'idle'
                : ctx.area ? 'ACTIVE' : 'no site context';
            const tabs = GM_getValue(TABS_KEY, {});
            let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
                '<b style="color:#22d3ee">⏱ Time Tracker — capture debug</b>' +
                '<span><span data-tt="copy" style="cursor:pointer;color:#22d3ee" title="Copy today\'s raw events JSON">⧉ JSON</span>' +
                ' <span data-tt="close" style="cursor:pointer;padding-left:8px">✕</span></span></div>' +
                '<div>state: <b style="color:' + (state === 'ACTIVE' ? '#5fff5f' : '#f0a35f') + '">' + state + '</b>' +
                ' · now: ' + esc(ctx.site ? ctx.env + ' site ' + ctx.site + ' · ' + ctx.area : (ctx.area || '—')) +
                (cur ? ' · slice ' + Math.round((Date.now() - cur.start) / 60000) + 'm open' : '') + '</div>';

            html += '<div style="margin-top:8px;color:#22d3ee">Today (raw → 15-min rounded)</div><table style="width:100%">';
            const keys = Object.keys(led.rows).sort(function(a, b) { return led.rows[b].mins - led.rows[a].mins; });
            if (!keys.length) html += '<tr><td style="color:#8b949e">no slices yet</td></tr>';
            keys.forEach(function(k) {
                const r = led.rows[k];
                const tools = Object.keys(r.tools);
                html += '<tr><td>' + esc((r.env === 'qa' ? 'qa·' : '') + (r.site ? 'site ' + r.site : '—')) + '</td>' +
                    '<td>' + esc(r.area) + '</td>' +
                    '<td style="text-align:right">' + r.mins.toFixed(1) + 'm → <b>' + round15(r.mins) + 'm</b></td></tr>' +
                    (tools.length ? '<tr><td></td><td colspan="2" style="color:#8b949e">🛠 ' + esc(tools.join(', ')) + '</td></tr>' : '');
            });
            html += '</table>';

            html += '<div style="margin-top:8px;color:#22d3ee">Open tabs (' + Object.keys(tabs).length + ')</div>';
            Object.keys(tabs).forEach(function(id) {
                const t = tabs[id];
                html += '<div style="color:' + (t.focused ? '#5fff5f' : '#8b949e') + '">' +
                    (id === TAB_ID ? '▸ ' : '· ') + esc((t.site ? 'site ' + t.site : '—') + ' ' + (t.area || '') +
                    (t.env === 'qa' ? ' (qa)' : '')) + (t.focused ? ' — focused' : '') + '</div>';
            });

            const recent = led.events.filter(function(e) { return e.type === 'slice'; }).slice(-8).reverse();
            html += '<div style="margin-top:8px;color:#22d3ee">Recent slices</div>';
            recent.forEach(function(s) {
                const hm = function(ts) { const d = new Date(ts); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); };
                html += '<div style="color:#8b949e">' + hm(s.start) + '–' + hm(s.end) + ' ' +
                    esc((s.site ? 'site ' + s.site : '—') + ' ' + s.area) + ' ' + (s.mins || 0).toFixed(1) + 'm' +
                    (s.live ? ' <b style="color:#5fff5f">(live)</b>' : ' (' + esc(s.closed || '') + ')') + '</div>';
            });

            html += '<div style="margin-top:8px;color:#22d3ee">Routes seen (verify the area mapping!)</div>';
            Object.keys(routesSeen).forEach(function(r) {
                html += '<div style="color:#8b949e">' + esc(r) + ' → ' + esc(routesSeen[r]) + '</div>';
            });
            html += '<div style="margin-top:6px;color:#8b949e">tab ' + esc(TAB_ID) + ' · v' + SCRIPT_VERSION +
                ' · idle cutoff ' + idleMin + 'm · tabs opened/closed today: ' + led.tabsOpen + '/' + led.tabsClosed + '</div>';
            panelEl.innerHTML = html;
        } catch (e) { log('renderPanel failed:', e); }
    }

    // ---------------------------------------------------------------
    // Control Panel integration.
    // ---------------------------------------------------------------
    let controlChannel = null;
    let controlPanelDetected = false;
    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { log('no BroadcastChannel:', e); return; }
        controlChannel.onmessage = function(ev) {
            const msg = ev.data || {};
            // Tool tagging first — any script's hotkey/action fired in THIS tab.
            if ((msg.type === 'HOTKEY_FIRED' || msg.type === 'TRIGGER_ACTION') && msg.tabId && msg.tabId === TAB_ID) {
                tagTool(msg.scriptId, msg.hotkeyId || msg.actionId || msg.type);
            }
            if (msg.type === 'REQUEST_REGISTRATIONS') { controlPanelDetected = true; registerWithControlPanel(); }
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                controlPanelDetected = true;
                const val = msg.value !== undefined ? msg.value : msg.enabled;
                if (msg.toggleId === 'master') {
                    if (masterEnabled === !!val) return;   // idempotent — CP echoes from both frames
                    masterEnabled = !!val;
                    log('master ' + (masterEnabled ? 'ENABLED' : 'DISABLED'));
                } else if (msg.toggleId === 'idle-min') {
                    const n = parseFloat(val);
                    if (isFinite(n) && n >= 1 && n <= 60 && n !== idleMin) { idleMin = n; log('idle cutoff = ' + n + 'm'); }
                }
            }
            else if ((msg.type === 'HOTKEY_FIRED' || msg.type === 'TRIGGER_ACTION') && msg.scriptId === SCRIPT_ID) {
                controlPanelDetected = true;
                // Tab-local gate: exact tabId match when the CP stamps one; else fail closed on hidden tabs.
                if (msg.tabId ? msg.tabId !== TAB_ID : document.hidden) return;
                if (msg.hotkeyId === 'debug' || msg.actionId === 'debug') togglePanel();
            }
        };
    }
    function registerWithControlPanel() {
        if (!controlChannel) return;
        try {
            controlChannel.postMessage({
                type: 'REGISTER',
                scriptId: SCRIPT_ID,
                name: 'Time Tracker',
                version: SCRIPT_VERSION,
                group: 'Time Tracker',
                toggles: [
                    { id: 'master', label: 'Enable time capture', type: 'boolean', default: true, master: true },
                    { id: 'idle-min', label: 'Idle cutoff (minutes)', type: 'number', default: DEFAULT_IDLE_MIN, min: 1, max: 60 },
                    { id: 'debug', label: 'Show capture debug panel', type: 'button' }
                ],
                hotkeys: [
                    { id: 'debug', label: 'Toggle capture debug panel', default: 'Shift+T' }
                ]
            });
        } catch (e) { log('register failed:', e); }
    }

    // Fallback hotkey when no Control Panel is installed (universal input guard).
    window.addEventListener('keydown', function(e) {
        if (controlPanelDetected || !masterEnabled) return;
        if (!(e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'T' || e.key === 't'))) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ||
            (t.className && /ant-input|ant-select/.test(String(t.className))) || t.getAttribute('role') === 'textbox')) return;
        togglePanel();
    }, true);

    // ---------------------------------------------------------------
    // Go.
    // ---------------------------------------------------------------
    setupControlPanel();
    registerWithControlPanel();
    pruneOldKeys();
    setInterval(tick, TICK_MS);
    tick();
    log('ready — capturing locally (Phase 1). Shift+T or CP button for the debug panel.');
})();
