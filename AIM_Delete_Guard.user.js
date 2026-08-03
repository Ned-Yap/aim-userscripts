// ==UserScript==
// @name         AIM Delete Guard
// @namespace    http://tampermonkey.net/
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Delete_Guard.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Delete_Guard.user.js
// @description  Banks a full JSON copy of every map_objects entity BEFORE it is deleted (any source: hotkey, kebab menu, bulk tools). Keeps a rolling 24h history with one-click restore. A delete that cannot be backed up is BLOCKED. No hotkeys; panel opens from the AIM Control Panel.
// @author       Payden
// @match        *://percepto.app/*
// @match        *://qa.percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @match        https://qa.percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// Log tag: [AIM UNDO]
(function() {
    const SCRIPT_ID = 'aim-delete-guard';
    const SCRIPT_VERSION = '1.0';
    const IS_TOP = window === window.top;
    const LS_KEY = 'aim-delete-history-v1';       // per-origin, so QA and prod stay separate
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;       // 24h rolling window
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const TYPE_LABELS = { 3: 'Asset', 4: 'NFZ', 8: 'Base', 15: 'FP', 16: 'FFZ', 19: 'GM', 98: 'Safe' };

    console.log('[AIM UNDO] init v' + SCRIPT_VERSION + (IS_TOP ? ' (top)' : ' (iframe)'));

    let masterEnabled = true;
    let cachedCsrf = null;
    let controlChannel = null;

    // Per-tab identity shared across frames via window.top (same-origin).
    // Must match the Control Panel's aimTabId so panel actions stay tab-local.
    function aimTabId() {
        try {
            const pw = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
            const t = pw.top;
            if (!t.__AIM_TAB_ID) t.__AIM_TAB_ID = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
            return t.__AIM_TAB_ID;
        } catch (e) { return null; }
    }

    // ---------------- storage ----------------

    function loadHistory() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(arr)) return [];
            const cutoff = Date.now() - MAX_AGE_MS;
            const pruned = arr.filter(e => e && e.ts >= cutoff);
            if (pruned.length !== arr.length) saveHistory(pruned);
            return pruned;
        } catch (e) {
            console.error('[AIM UNDO] history read failed:', e);
            return [];
        }
    }

    function saveHistory(arr) {
        // On quota overflow, drop oldest entries until the write fits — a
        // shorter history beats losing the newest (most valuable) backups.
        for (let attempt = 0; attempt < 10; attempt++) {
            try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); return true; }
            catch (e) {
                if (!arr.length) { console.error('[AIM UNDO] history write failed:', e); return false; }
                arr = arr.slice(0, arr.length - 1);
            }
        }
        console.error('[AIM UNDO] history write failed after trimming');
        return false;
    }

    function bankEntity(entity) {
        const hist = loadHistory();
        hist.unshift({ ts: Date.now(), iso: new Date().toISOString(), siteId: entity.site, entity });
        const ok = saveHistory(hist);
        const label = (TYPE_LABELS[entity.type] || ('type ' + entity.type)) + ' "' + (entity.name || 'unnamed') + '"';
        console.log('[AIM UNDO] 🕘 banked ' + label + ' (id ' + entity.id + ', site ' + entity.site + ') before delete');
        showToast('🕘 Backed up ' + label + ' — restorable for 24h via Control Panel → Delete Guard', false);
        return ok;
    }

    // ---------------- CSRF sniffing (cookies are HttpOnly — sniff outgoing headers) ----------------

    function sniffCsrfValue(name, value) {
        if (name && String(name).toLowerCase() === 'x-csrftoken' && value) {
            if (cachedCsrf !== value) console.log('[AIM UNDO] CSRF token captured');
            cachedCsrf = value;
            // Share across frames: deletes/saves fire in the map IFRAME but the
            // restore panel runs in TOP — without this, restore never sees a token.
            try { window.top.__AIM_CSRF = value; } catch (e) {}
        }
    }

    function getCsrf() {
        if (cachedCsrf) return cachedCsrf;
        try { return window.top.__AIM_CSRF || null; } catch (e) { return null; }
    }

    function sniffCsrfFromFetch(input, init) {
        try {
            const h = (init && init.headers) || (input && typeof input === 'object' && input.headers) || null;
            if (!h) return;
            if (typeof h.forEach === 'function') h.forEach((v, k) => sniffCsrfValue(k, v));
            else if (Array.isArray(h)) h.forEach(p => sniffCsrfValue(p[0], p[1]));
            else Object.keys(h).forEach(k => sniffCsrfValue(k, h[k]));
        } catch (e) { /* sniffing is best-effort; never break the request */ }
    }

    // ---------------- delete interception ----------------

    const DELETE_RX = /\/map_objects\/(\d+)\/?(?:[?#]|$)/;
    const ORIG_FETCH = window.fetch.bind(window);

    async function fetchEntityForBackup(id) {
        const r = await ORIG_FETCH('/map_objects/' + id + '/', { credentials: 'include' });
        if (!r.ok) throw new Error('backup GET returned HTTP ' + r.status);
        return r.json();
    }

    function blockedResponse(id) {
        showToast('🛑 Delete BLOCKED — could not back up entity ' + id + ' first. Nothing was deleted; retry in a moment.', true);
        console.error('[AIM UNDO] delete of ' + id + ' BLOCKED (backup failed)');
        return new Response(JSON.stringify({ detail: 'AIM Delete Guard: delete blocked because the pre-delete backup failed' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } });
    }

    window.fetch = function(input, init) {
        try {
            sniffCsrfFromFetch(input, init);
            if (masterEnabled) {
                const url = (typeof input === 'string') ? input : ((input && input.url) || '');
                const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
                const m = method === 'DELETE' ? url.match(DELETE_RX) : null;
                if (m) {
                    const id = m[1];
                    return fetchEntityForBackup(id)
                        .then(entity => { bankEntity(entity); return ORIG_FETCH(input, init); })
                        .catch(e => { console.error('[AIM UNDO] backup failed:', e); return blockedResponse(id); });
                }
            }
        } catch (e) { console.error('[AIM UNDO] fetch intercept error:', e); }
        return ORIG_FETCH(input, init);
    };

    const XHR = XMLHttpRequest.prototype;
    const ORIG_OPEN = XHR.open, ORIG_SEND = XHR.send, ORIG_SET_HEADER = XHR.setRequestHeader;
    XHR.open = function(method, url) {
        this.__aimUndo = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
        return ORIG_OPEN.apply(this, arguments);
    };
    XHR.setRequestHeader = function(name, value) {
        try { sniffCsrfValue(name, value); } catch (e) {}
        return ORIG_SET_HEADER.apply(this, arguments);
    };
    XHR.send = function() {
        const info = this.__aimUndo;
        const m = (masterEnabled && info && info.method === 'DELETE') ? info.url.match(DELETE_RX) : null;
        if (!m) return ORIG_SEND.apply(this, arguments);
        const xhr = this, args = arguments, id = m[1];
        fetchEntityForBackup(id)
            .then(entity => { bankEntity(entity); ORIG_SEND.apply(xhr, args); })
            .catch(e => {
                console.error('[AIM UNDO] backup failed (XHR path):', e);
                showToast('🛑 Delete BLOCKED — could not back up entity ' + id + ' first. Nothing was deleted; retry in a moment.', true);
                try { xhr.abort(); } catch (err) {}
            });
    };

    // ---------------- restore ----------------

    function buildWriteBody(entity, siteCfg) {
        // Read-shape → write-shape per the banked POST /map_objects/ rules:
        // strip id (server creates), points←coords, site_id←site, arcs lose
        // id/mapobject and gain points:[point_a,point_b], type-3 needs
        // custom.new_poi_type_str, mountain_terrain_site from /sites/<id>/.
        const b = JSON.parse(JSON.stringify(entity));
        delete b.id;
        b.site_id = entity.site;
        b.points = entity.coords || [];
        delete b.site; delete b.coords; delete b.polygon; delete b.asset_waypoints;
        if (Array.isArray(b.arcs)) {
            b.arcs = entity.arcs.map(a => {
                const c = JSON.parse(JSON.stringify(a));
                delete c.id; delete c.mapobject;
                c.points = [a.point_a, a.point_b];
                return c;
            });
        }
        if (b.type === 3) { b.custom = b.custom || {}; b.custom.new_poi_type_str = ''; }
        if (siteCfg && siteCfg.mountain_terrain_site !== undefined) b.mountain_terrain_site = siteCfg.mountain_terrain_site;
        return b;
    }

    async function restoreEntry(ts) {
        const hist = loadHistory();
        const entry = hist.find(e => e.ts === ts);
        if (!entry) { showToast('🛑 Restore failed: entry expired or missing', true); return; }
        const csrf = getCsrf();
        if (!csrf) {
            showToast('🛑 Restore needs a CSRF token and none has been seen yet this session — make any save/edit once, then retry', true);
            return;
        }
        const label = (TYPE_LABELS[entry.entity.type] || ('type ' + entry.entity.type)) + ' "' + (entry.entity.name || 'unnamed') + '"';
        try {
            const siteR = await ORIG_FETCH('/sites/' + entry.siteId + '/', { credentials: 'include' });
            const siteCfg = siteR.ok ? await siteR.json() : null;
            const body = buildWriteBody(entry.entity, siteCfg);
            const r = await ORIG_FETCH('/map_objects/', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                const txt = await r.text().catch(() => '');
                console.error('[AIM UNDO] restore POST HTTP ' + r.status + ': ' + txt.slice(0, 400));
                showToast('🛑 Restore of ' + label + ' failed (HTTP ' + r.status + ') — see console. If it is a flight path, restore its FFZs first.', true);
                return;
            }
            entry.restoredAt = Date.now();
            saveHistory(hist);
            console.log('[AIM UNDO] ✅ restored ' + label + ' to site ' + entry.siteId);
            showToast('✅ Restored ' + label + ' to site ' + entry.siteId + ' — refresh the page to see it', false);
            renderPanel();
        } catch (e) {
            console.error('[AIM UNDO] restore failed:', e);
            showToast('🛑 Restore of ' + label + ' failed: ' + e.message, true);
        }
    }

    // ---------------- UI (top frame only) ----------------

    function showToast(msg, isError) {
        try {
            const doc = IS_TOP ? document : window.top.document;
            if (!doc || !doc.body) return;
            const t = doc.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
                'background:' + (isError ? '#2b0d0d' : '#0d1f2b') + ';color:' + (isError ? '#ff6b6b' : '#7fd7ff') + ';' +
                'border:2px solid ' + (isError ? '#ff4d4d' : '#1ca0de') + ';border-radius:8px;padding:12px 18px;' +
                'font:14px/1.4 sans-serif;max-width:560px;box-shadow:0 4px 18px rgba(0,0,0,.6);pointer-events:none';
            doc.body.appendChild(t);
            setTimeout(() => t.remove(), isError ? 10000 : 5000);
        } catch (e) { console.warn('[AIM UNDO] toast failed: ' + e.message); }
    }

    let panelEl = null;

    function fmtTime(ts) {
        const d = new Date(ts);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    function entryDetail(ent) {
        if (Array.isArray(ent.arcs) && ent.arcs.length) return ent.arcs.length + ' segs';
        if (Array.isArray(ent.coords)) return ent.coords.length + ' pts';
        return '';
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderPanel() {
        if (!IS_TOP || !panelEl) return;
        const hist = loadHistory();
        const rows = hist.map(e => {
            const ent = e.entity || {};
            const label = TYPE_LABELS[ent.type] || ('t' + ent.type);
            const action = e.restoredAt
                ? '<span style="color:#5fff5f">✓ restored</span>'
                : '<button data-undo-restore="' + e.ts + '" style="background:#143;border:1px solid #2a6;color:#7fffb0;border-radius:4px;padding:2px 8px;cursor:pointer">Restore</button>';
            return '<tr style="border-bottom:1px solid #223">' +
                '<td style="padding:4px 6px;white-space:nowrap">' + fmtTime(e.ts) + '</td>' +
                '<td style="padding:4px 6px">' + label + '</td>' +
                '<td style="padding:4px 6px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(ent.name) + '">' + (esc(ent.name) || 'unnamed') + '</td>' +
                '<td style="padding:4px 6px;white-space:nowrap">' + entryDetail(ent) + '</td>' +
                '<td style="padding:4px 6px">' + e.siteId + '</td>' +
                '<td style="padding:4px 6px">' + action + '</td></tr>';
        }).join('');
        panelEl.innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #1ca0de;cursor:default">' +
            '<strong style="color:#1ca0de;flex:1">🕘 Delete history (24h)</strong>' +
            '<button data-undo-clear style="background:#311;border:1px solid #633;color:#f88;border-radius:4px;padding:2px 8px;cursor:pointer">Clear</button>' +
            '<button data-undo-close style="background:none;border:none;color:#ccc;font-size:16px;cursor:pointer">✕</button></div>' +
            (hist.length
                ? '<div style="max-height:50vh;overflow:auto"><table style="border-collapse:collapse;font:12px/1.4 sans-serif;color:#ddd;width:100%">' +
                  '<tr style="color:#8ab;text-align:left"><th style="padding:4px 6px">Time</th><th style="padding:4px 6px">Type</th><th style="padding:4px 6px">Name</th><th style="padding:4px 6px">Detail</th><th style="padding:4px 6px">Site</th><th style="padding:4px 6px"></th></tr>' +
                  rows + '</table></div>'
                : '<div style="padding:16px;color:#889;font:13px sans-serif">No deletes in the last 24 hours.</div>');
    }

    function togglePanel() {
        if (!IS_TOP) return;
        if (panelEl) { panelEl.remove(); panelEl = null; return; }
        panelEl = document.createElement('div');
        panelEl.id = 'aim-undo-panel';
        panelEl.style.cssText = 'position:fixed;top:80px;right:16px;z-index:2147483646;width:460px;max-width:92vw;' +
            'background:#0b0f14;border:1px solid #1ca0de;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.7)';
        panelEl.addEventListener('click', (e) => {
            const r = e.target.closest('[data-undo-restore]');
            if (r) { restoreEntry(Number(r.getAttribute('data-undo-restore'))); return; }
            if (e.target.closest('[data-undo-clear]')) {
                if (window.confirm('Clear the entire 24h delete history? Backups will be unrecoverable.')) {
                    saveHistory([]); renderPanel();
                }
                return;
            }
            if (e.target.closest('[data-undo-close]')) { panelEl.remove(); panelEl = null; }
        });
        document.body.appendChild(panelEl);
        renderPanel();
    }

    // ---------------- Control Panel integration ----------------

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { console.warn('[AIM UNDO] BroadcastChannel unavailable: ' + e.message); return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                if (msg.toggleId === 'master') {
                    const v = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    if (v === masterEnabled) return; // idempotent — CP echoes from top AND iframe
                    masterEnabled = v;
                    console.log('[AIM UNDO] master ' + (v ? 'ENABLED' : 'DISABLED — deletes will NOT be backed up'));
                }
            } else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === SCRIPT_ID) {
                // Cross-tab guard: only the tab that clicked reacts.
                if (msg.tabId ? msg.tabId !== aimTabId() : document.hidden) return;
                if (!IS_TOP) return;
                if (msg.actionId === 'show-history') togglePanel();
            }
        };
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Delete Guard',
            version: SCRIPT_VERSION, group: 'Site Setup', priority: 95,
            toggles: [
                { id: 'master', label: 'Back up every delete (block un-backed deletes)', type: 'boolean', default: true, master: true },
                { id: 'show-history', label: '🕘 Show delete history (24h)', type: 'button', action: 'show-history' },
            ],
            hotkeys: [],
        });
    }

    setupControlPanel();
    registerWithControlPanel();
    setInterval(loadHistory, 30 * 60 * 1000); // periodic prune of the 24h window
    console.log('[AIM UNDO] ready — deletes are intercepted, history at Control Panel → Delete Guard');
})();
