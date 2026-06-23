// ==UserScript==
// @name         Latest - AIM Control Panel
// @namespace    http://tampermonkey.net/
// @version      1.31
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Control_Panel.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Control_Panel.user.js
// @description  Native-style control panel injected into the map-tools bar. Hosts toggles + hotkey rebinding for all AIM scripts. Click the gear icon next to the layer menu.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @run-at       document-end
// ==/UserScript==

// Pattern any AIM script can opt into (paste into your script's init):
//
//   const controlCh = new BroadcastChannel('AIM_CONTROL_CHANNEL');
//   const SCRIPT_ID = 'aim-myscript';
//   const TOGGLES = [
//     { id: 'master', label: 'Enable', default: true, master: true },
//     { id: 'feature-a', label: 'Feature A', default: true },
//   ];
//   const HOTKEYS = [
//     { id: 'toggle-master', label: 'Toggle on/off', default: 'Shift+M' },
//   ];
//   function register() {
//     controlCh.postMessage({
//       type: 'REGISTER', scriptId: SCRIPT_ID, name: 'My Script',
//       version: '1.0', frame: location.pathname,
//       toggles: TOGGLES, hotkeys: HOTKEYS,
//     });
//   }
//   controlCh.onmessage = (ev) => {
//     const m = ev.data || {};
//     if (m.type === 'REQUEST_REGISTRATIONS') register();
//     else if (m.type === 'SET_TOGGLE' && m.scriptId === SCRIPT_ID) { /* update state */ }
//     else if (m.type === 'HOTKEY_FIRED' && m.scriptId === SCRIPT_ID) { /* react */ }
//   };
//   register();
//
// Hotkey rebinds are managed centrally by the control panel — it dispatches
// HOTKEY_FIRED to your script when the bound combo is pressed, so you don't
// need to install your own keydown listener.
//
// Log tag: [AIM CONTROL]

(function() {
    'use strict';

    // ============================================================
    // 1. CONSTANTS
    // ============================================================
    const VERSION = '1.31';
    const IS_TOP = window === window.top;
    const TAG = `[AIM CONTROL ${IS_TOP ? 'TOP' : 'IF'}]`;
    const CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const PREFS_KEY = 'aim-control-prefs';
    const HOTKEYS_KEY = 'aim-control-hotkeys';
    // v1.31 — LITE / FULL MODE (CSM whitelist). A shared localStorage value
    // (readable by ALL userscripts on percepto.app, unlike per-script GM
    // storage) that gates the destructive/building tools. DEFAULT = LITE: every
    // non-CSM (regs, pilots, any new GitHub user) gets the non-destructive QoL +
    // viewing tools but NO building tools — they stay inert at init via their
    // own guard. FULL mode unlocks the building tools, and is granted only to
    // GitHub logins on the CSM whitelist (csm-whitelist.json in the private data
    // repo). The Control Panel resolves your login (GET /user via your PAT) +
    // the list, then caches MODE_KEY = 'full' | 'lite'. Pilots/regs HAVE PATs
    // (for power-line KMLs + Issues), so PAT-presence can't be the gate — the
    // whitelist is. Escape hatch for a CSM the list can't reach:
    // localStorage.setItem('aim-mode','full') in the console, then reload.
    const MODE_KEY = 'aim-mode';            // 'full' (CSM/builder) | 'lite' (default)
    const MODE_CSM_KEY = 'aim-is-csm';      // '1' if whitelist-resolved as a CSM (UI: show Lite/Full toggle)
    const MODE_LOGIN_KEY = 'aim-mode-login'; // cached resolved GitHub login (display only)
    const CSM_WHITELIST_PATH = 'csm-whitelist.json'; // in KMLS_REPO (private data repo)
    // Scripts allowed in LITE mode (everyone). Everything NOT listed is a
    // CSM-only building tool that stays inert unless aim-mode==='full'. Used to
    // hide CSM sections from the panel in Lite (defense for un-guarded installs).
    const LITE_ALLOWED = new Set([
        'aim-defaults', 'aim-styler', 'aim-styler-powerlines',
        'aim-perf-shield', 'aim-map-nav', 'aim-issues',
        'aim-ruler', 'aim-clear-all', 'aim-altitude', 'aim-power-line-editor',
    ]);
    const REBIND_ERROR_TIMEOUT_MS = 6000;
    const TOKEN_KEY = 'aim-github-token';
    const KMLS_REPO = 'Ned-Yap/aim-userscripts-data';
    const KMLS_BRANCH = 'main';
    const INJECT_RETRY_MS = 500;
    const INJECT_MAX_TRIES = 60; // 30s of retries then give up

    // ============================================================
    // URL SCOPE — v1.22 (page-aware panel + hotkey routing)
    //
    // Each registered script may declare a `scope` field in REGISTER:
    //   - 'site-setup'   → only on /#/site/<id>/control-panel/site-setup
    //                      OR on /admin/.../merge_available_apps/step<N>/...
    //                      (the Bulk Mission Adder's admin URL counts as
    //                      Site Setup for visibility purposes)
    //   - 'mission-bank' → only on /#/site/<id>/control-panel/mission-bank
    //                      (incl. deep children)
    //   - 'admin-merge'  → only on /admin/.../merge_available_apps/step<N>/...
    //                      (used by Bulk Mission Adder so it never renders
    //                      in the panel anywhere — that page has no map,
    //                      so the panel never displays there either)
    //   - undefined      → "always visible" (default; backward compatible)
    //
    // Scripts whose scope doesn't match the current URL are:
    //   1. Hidden from the rendered panel
    //   2. Silently skipped by HOTKEY_FIRED routing
    //
    // Cross-frame: we read window.top so both TOP and IFRAME contexts
    // see the same SPA URL (same-origin within percepto.app).
    // ============================================================
    function getUrlScope() {
        let pathname = '';
        let hash = '';
        try {
            const top = window.top || window;
            pathname = top.location.pathname || '';
            hash = top.location.hash || '';
        } catch (e) {
            // Cross-origin guard (shouldn't trigger on percepto.app) — fall
            // back to the iframe's own URL so we degrade gracefully.
            pathname = location.pathname || '';
            hash = location.hash || '';
        }
        if (/^\/admin\/percepto\/availableapp\/merge_available_apps\/step\d+\//.test(pathname)) {
            return 'admin-merge';
        }
        if (/#\/site\/\d+\/control-panel\/site-setup/.test(hash)) return 'site-setup';
        if (/#\/site\/\d+\/control-panel\/mission-bank/.test(hash)) return 'mission-bank';
        return 'other';
    }

    // Site-Setup-scoped scripts (scope:'site-setup') also appear on
    // admin-merge so the workflow stays coherent — Bulk Mission Adder's
    // admin page is part of the Site Setup mental model even though the
    // URL shape is different. Mission Bank scope stays strict.
    function scopeMatches(scriptScope) {
        if (!scriptScope) return true; // unscoped scripts always show
        const current = state.urlScope || getUrlScope();
        if (scriptScope === current) return true;
        if (scriptScope === 'site-setup' && current === 'admin-merge') return true;
        return false;
    }

    // ============================================================
    // 2. STATE
    // ============================================================
    const state = {
        channel: null,
        // v1.22 — current URL scope for page-aware filtering. Recomputed
        // on hashchange. See getUrlScope() above.
        urlScope: 'other',
        // scriptId -> { name, version, toggles, hotkeys, frame, lastSeen }
        registry: new Map(),
        // { [scriptId]: { [toggleId]: bool } }
        prefs: {},
        // { [scriptId]: { [hotkeyId]: 'Shift+O' } }   // user overrides
        hotkeys: {},
        buttonEl: null,
        panelEl: null,
        panelOpen: false,
        rebindingFor: null, // { scriptId, hotkeyId } while capturing a new key combo
        injectTries: 0,
        expanded: {},       // Advanced section keys -> bool (open/closed)
        // GitHub PAT for fetching private-repo KMLs.
        // 'unknown' | 'missing' | 'testing' | 'valid' | 'invalid' | 'error'
        tokenStatus: 'unknown',
        tokenStatusMsg: '',
        tokenInputVisible: false, // only true after Edit click — keeps PAT off-screen by default
        // Group/section open state. Default = closed (undefined = collapsed).
        // Reset each time the panel is opened so it always starts tidy.
        sectionsOpen: {},
        // Transient error message shown when a hotkey rebind collides with
        // an existing binding. Cleared on next user action OR auto-clears
        // after REBIND_ERROR_TIMEOUT_MS.
        rebindError: null,
        rebindErrorTimer: null,
        // PAT (GitHub Connection) section state — separately collapsible
        // from script sections, default closed so the panel stays compact.
        tokenSectionOpen: false,
    };

    console.log(`${TAG} v${VERSION} loading`);

    // ============================================================
    // 3. PREFS
    // ============================================================
    function loadPrefs() {
        try { state.prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (e) { state.prefs = {}; }
        try { state.hotkeys = JSON.parse(localStorage.getItem(HOTKEYS_KEY) || '{}'); } catch (e) { state.hotkeys = {}; }
    }
    function savePrefs() {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch (e) {}
        try { localStorage.setItem(HOTKEYS_KEY, JSON.stringify(state.hotkeys)); } catch (e) {}
    }
    // v1.31 — Lite/Full mode (shared localStorage, see MODE_KEY note above).
    // Anything other than the literal 'full' is treated as LITE (the safe
    // default), so an unset/garbage value never accidentally unlocks builders.
    function getMode() {
        try { return localStorage.getItem(MODE_KEY) === 'full' ? 'full' : 'lite'; }
        catch (e) { return 'lite'; }
    }
    function isFull() { return getMode() === 'full'; }
    function setMode(mode) {
        try { localStorage.setItem(MODE_KEY, mode === 'full' ? 'full' : 'lite'); } catch (e) {}
    }
    function getModeLogin() {
        try { return localStorage.getItem(MODE_LOGIN_KEY) || ''; } catch (e) { return ''; }
    }
    function isCsmUser() {
        try { return localStorage.getItem(MODE_CSM_KEY) === '1'; } catch (e) { return false; }
    }
    // The mode the page actually LOADED with — i.e. what every script's init
    // guard read. resolveMode() may change MODE_KEY later (async), but that
    // only takes effect on the next reload, so the banner compares this against
    // getMode() to decide whether to nudge a reload.
    const ACTIVE_MODE = getMode();

    // Resolve CSM status against the whitelist and cache the mode. Runs once a
    // token is available. Writes MODE_KEY; guards read it at INIT so the change
    // applies on the NEXT reload (we surface a reload nudge when it flips). On
    // any failure (no token / network / parse) we DON'T downgrade — we leave the
    // cached mode untouched, so a resolved CSM isn't knocked back to Lite by a
    // transient blip, and an unresolved user simply stays Lite (safe default).
    let modeResolving = false;
    function resolveMode() {
        const token = getToken();
        if (!token || typeof GM_xmlhttpRequest !== 'function' || modeResolving) return;
        modeResolving = true;
        ghJson('https://api.github.com/user', token, (me) => {
            const login = me && me.login;
            if (!login) { modeResolving = false; return; }
            try { localStorage.setItem(MODE_LOGIN_KEY, login); } catch (e) {}
            const url = `https://api.github.com/repos/${KMLS_REPO}/contents/${CSM_WHITELIST_PATH}?ref=${KMLS_BRANCH}`;
            ghJson(url, token, (file) => {
                modeResolving = false;
                let list = null;
                try {
                    // contents API returns base64 in .content; decode then parse.
                    const txt = file && file.content ? atob(file.content.replace(/\n/g, '')) : null;
                    list = txt ? (JSON.parse(txt).csms || []) : null;
                } catch (e) { console.warn(`${TAG} csm-whitelist parse failed:`, e); }
                if (!Array.isArray(list)) {
                    console.warn(`${TAG} csm-whitelist unavailable — leaving mode as ${getMode()} (login ${login})`);
                    return; // don't downgrade on a missing/garbled list
                }
                const isCsm = list.some(u => String(u).toLowerCase() === login.toLowerCase());
                try { localStorage.setItem(MODE_CSM_KEY, isCsm ? '1' : '0'); } catch (e) {}
                const prev = getMode();
                let raw = null;
                try { raw = localStorage.getItem(MODE_KEY); } catch (e) {}
                if (!isCsm) {
                    // Non-CSMs are always Lite — enforce it (overrides a stray
                    // value). The console escape hatch only matters when the
                    // list can't be fetched, which returns earlier without
                    // reaching here, so this never strands a real CSM.
                    setMode('lite');
                } else if (raw !== 'full' && raw !== 'lite') {
                    // First resolution for a CSM → default to Full. An explicit
                    // prior choice (full, or a Lite "preview") is respected.
                    setMode('full');
                }
                const newMode = getMode();
                console.log(`${TAG} mode resolved: ${login} → CSM=${isCsm}, mode=${newMode}${newMode !== prev ? ` (was ${prev}; reload to apply)` : ''}`);
                if ((newMode !== prev || true) && state.panelOpen) renderPanel();
            });
        });
    }
    // Minimal GitHub GET → parsed JSON via GM_xmlhttpRequest (page-CORS-proof).
    function ghJson(url, token, cb) {
        try {
            GM_xmlhttpRequest({
                method: 'GET', url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                onload: (resp) => {
                    if (resp.status >= 200 && resp.status < 300) {
                        let data = null;
                        try { data = JSON.parse(resp.responseText); } catch (e) {}
                        cb(data);
                    } else { console.warn(`${TAG} GET ${url} → HTTP ${resp.status}`); cb(null); }
                },
                onerror: () => { console.warn(`${TAG} GET ${url} network error`); cb(null); },
                ontimeout: () => { console.warn(`${TAG} GET ${url} timed out`); cb(null); },
                timeout: 8000,
            });
        } catch (e) { console.warn(`${TAG} GET ${url} threw:`, e); cb(null); }
    }
    function getToggle(scriptId, toggleId, def) {
        const s = state.prefs[scriptId];
        if (s && Object.prototype.hasOwnProperty.call(s, toggleId)) return s[toggleId];
        return def;
    }
    function setToggle(scriptId, toggleId, enabled) {
        if (!state.prefs[scriptId]) state.prefs[scriptId] = {};
        state.prefs[scriptId][toggleId] = enabled;
        savePrefs();
    }
    // Reset a toggle back to the schema default. We DELETE from prefs so
    // future getToggle() falls back to the schema default cleanly. The
    // SET_TOGGLE broadcast with the default value notifies the owning
    // script — its internal toggleState updates and it can re-render.
    function resetToggleToDefault(scriptId, toggleId, def) {
        if (state.prefs[scriptId] && Object.prototype.hasOwnProperty.call(state.prefs[scriptId], toggleId)) {
            delete state.prefs[scriptId][toggleId];
            savePrefs();
        }
        if (state.channel) {
            state.channel.postMessage({
                type: 'SET_TOGGLE', scriptId, toggleId,
                value: def, enabled: !!def,
            });
        }
    }
    // True when the live value differs from the schema default — controls
    // the per-row reset icon's visibility. Type-aware comparison so
    // "0.5" vs 0.5 doesn't show a stale reset arrow.
    function isCustomized(t, value) {
        if (value === undefined) return false;
        if (t.type === 'number') return Number(value) !== Number(t.default);
        if (t.type === 'color') return String(value).toLowerCase() !== String(t.default || '').toLowerCase();
        if (t.type === 'select') return String(value) !== String(t.default);
        // boolean (default)
        return !!value !== !!t.default;
    }
    function getHotkey(scriptId, hotkeyId, def) {
        const s = state.hotkeys[scriptId];
        if (s && s[hotkeyId]) return s[hotkeyId];
        return def;
    }
    function setHotkey(scriptId, hotkeyId, combo) {
        if (!state.hotkeys[scriptId]) state.hotkeys[scriptId] = {};
        if (combo == null) delete state.hotkeys[scriptId][hotkeyId];
        else state.hotkeys[scriptId][hotkeyId] = combo;
        savePrefs();
    }

    // ============================================================
    // 3b. GITHUB TOKEN (GM_setValue — per-extension storage,
    //     not localStorage. Other scripts on the same page can
    //     read localStorage but not GM storage.)
    // ============================================================
    function gmGet(key, def) {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, def);
        } catch (e) {}
        return def;
    }
    function gmSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') { GM_setValue(key, value); return true; }
        } catch (e) {}
        return false;
    }
    function getToken() {
        const t = gmGet(TOKEN_KEY, '');
        return typeof t === 'string' ? t : '';
    }
    function setToken(value) {
        gmSet(TOKEN_KEY, value || '');
        state.tokenStatus = value ? 'unknown' : 'missing';
        state.tokenStatusMsg = '';
        // GM storage is per-script in Tampermonkey — other scripts cannot
        // read this panel's namespace. So we broadcast the token over the
        // control channel for any script that needs it. BroadcastChannel
        // is same-origin, in-browser only; nothing leaves the machine.
        if (state.channel) {
            state.channel.postMessage({ type: 'TOKEN_VALUE', token: value || '' });
            state.channel.postMessage({ type: 'REFETCH_KMLS' });
        }
        // v1.31 — a new/changed token means we can (re-)resolve CSM status.
        modeResolving = false;
        if (value) resolveMode();
    }
    // Verifies the PAT by hitting the contents API for the KMLs repo root.
    // Uses GM_xmlhttpRequest so the request bypasses page CORS rules.
    function testToken(value, cb) {
        if (!value) { cb('missing', 'No token entered'); return; }
        if (typeof GM_xmlhttpRequest !== 'function') {
            cb('error', 'GM_xmlhttpRequest unavailable (check @grant headers)');
            return;
        }
        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.github.com/repos/${KMLS_REPO}/contents/?ref=${KMLS_BRANCH}`,
                headers: {
                    'Authorization': `Bearer ${value}`,
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                onload: (resp) => {
                    if (resp.status >= 200 && resp.status < 300) {
                        let count = 0;
                        try { count = (JSON.parse(resp.responseText) || []).length; } catch (e) {}
                        cb('valid', `${count} file${count === 1 ? '' : 's'} in repo`);
                    } else if (resp.status === 401) {
                        cb('invalid', 'Token rejected (401) — check it has Contents: Read');
                    } else if (resp.status === 404) {
                        cb('invalid', 'Repo not found (404) — check token has access to this repo');
                    } else {
                        cb('error', `HTTP ${resp.status}`);
                    }
                },
                onerror: () => cb('error', 'Network error'),
                ontimeout: () => cb('error', 'Timed out'),
                timeout: 8000,
            });
        } catch (e) {
            cb('error', e.message || 'Unknown error');
        }
    }

    // ============================================================
    // 4. CHANNEL
    // ============================================================
    function setupChannel() {
        try {
            state.channel = new BroadcastChannel(CHANNEL_NAME);
            state.channel.onmessage = handleMessage;
        } catch (e) {
            console.error(`${TAG} BroadcastChannel unavailable:`, e);
        }
    }

    function handleMessage(event) {
        const msg = event.data || {};
        if (msg.type === 'REGISTER') {
            handleRegister(msg);
            // New script just came online — if we have a token, hand it
            // over so the script can use it for any private-repo fetches.
            const token = getToken();
            if (token && state.channel) {
                state.channel.postMessage({ type: 'TOKEN_VALUE', token });
            }
        } else if (msg.type === 'UNREGISTER' && msg.scriptId) {
            state.registry.delete(msg.scriptId);
            if (state.panelOpen) renderPanel();
        } else if (msg.type === 'SET_TOGGLE' && msg.scriptId && msg.toggleId !== undefined) {
            // A script changed one of its settings (e.g. toggled via hotkey).
            // Mirror into our prefs so UI stays in sync. Don't re-broadcast.
            // v1.24: skip the re-render when the new value matches what's
            // already in prefs — every SET_TOGGLE echo from REGISTER bounces
            // back here, and without this guard each one triggered a full
            // renderPanel(), destroying inputs the user just clicked.
            const v = msg.value !== undefined ? msg.value : msg.enabled;
            const prev = state.prefs[msg.scriptId] && state.prefs[msg.scriptId][msg.toggleId];
            const changed = prev !== v;
            setToggle(msg.scriptId, msg.toggleId, v);
            if (changed && state.panelOpen) scheduleRender();
        } else if (msg.type === 'REQUEST_TOKEN') {
            const token = getToken();
            if (token && state.channel) {
                state.channel.postMessage({ type: 'TOKEN_VALUE', token });
            }
        }
    }

    // Walks the toggles tree, unwrapping 'advanced' AND 'category' groups so
    // every leaf setting (and each category's master checkbox) is returned
    // flat. Used when echoing saved values back — without category support
    // here, child prefs never re-broadcast on REGISTER and the styler boots
    // with undefined values for ffz.show / asset.show / etc.
    function flattenToggles(toggles) {
        const out = [];
        (toggles || []).forEach(t => {
            if (!t) return;
            if (t.type === 'header') return; // purely visual divider, no stored state
            if ((t.type === 'advanced' || t.type === 'category') && Array.isArray(t.children)) {
                if (t.type === 'category' && t.master && t.master.id) {
                    out.push({ id: t.master.id, default: t.master.default });
                }
                t.children.forEach(c => { if (c && c.id) out.push(c); });
            } else if (t.id) {
                out.push(t);
            }
        });
        return out;
    }

    // v1.24 — cheap structural signature of a REGISTER payload. Used to
    // skip re-renders when a script re-registers with identical content
    // (Map Styler re-registers on every category toggle, every script
    // re-registers on REQUEST_REGISTRATIONS, etc). Doesn't include
    // lastSeen / frame so timestamp drift doesn't invalidate the cache.
    function registrationSignature(msg) {
        return JSON.stringify({
            n: msg.name, v: msg.version, g: msg.group, p: msg.priority,
            s: msg.scope, t: msg.toggles, h: msg.hotkeys,
        });
    }

    function handleRegister(msg) {
        if (!msg.scriptId) return;
        // v1.31 — defense in depth: in LITE mode, if a CSM-only tool still
        // registered (an older install without the init guard), mute it by
        // forcing its master toggle off. Guarded CSM tools never get here.
        if (!isFull() && !LITE_ALLOWED.has(msg.scriptId) && state.channel) {
            state.channel.postMessage({
                type: 'SET_TOGGLE', scriptId: msg.scriptId,
                toggleId: 'master', value: false, enabled: false,
            });
        }
        const prev = state.registry.get(msg.scriptId);
        const sig = registrationSignature(msg);
        const isIdentical = prev && prev.__sig === sig;
        state.registry.set(msg.scriptId, { ...msg, lastSeen: Date.now(), __sig: sig });
        // Echo back the current value for each registered setting. Carries
        // both `value` (typed) and `enabled` (bool) — scripts can read whichever
        // they're built for. Saves each script from doing its own localStorage.
        // v1.24: only echo on FIRST register of this scriptId; re-registers
        // with identical payload don't need to re-broadcast (scripts already
        // have the values from the first echo).
        if (!isIdentical && Array.isArray(msg.toggles) && state.channel) {
            flattenToggles(msg.toggles).forEach(t => {
                const value = getToggle(msg.scriptId, t.id, t.default);
                state.channel.postMessage({
                    type: 'SET_TOGGLE',
                    scriptId: msg.scriptId, toggleId: t.id,
                    value, enabled: !!value,
                });
            });
        }
        // v1.24: skip the re-render when nothing structural changed —
        // avoids the burst-of-renderPanel-on-open that was destroying
        // freshly-clicked inputs/checkboxes mid-click.
        if (!isIdentical && state.panelOpen) scheduleRender();
    }

    function requestRegistrations() {
        if (state.channel) state.channel.postMessage({ type: 'REQUEST_REGISTRATIONS' });
    }

    function broadcastToggle(scriptId, toggleId, value) {
        setToggle(scriptId, toggleId, value);
        if (state.channel) {
            // Send both `value` (any type) and `enabled` (bool) for compatibility
            // with scripts that only know about boolean toggles.
            state.channel.postMessage({
                type: 'SET_TOGGLE', scriptId, toggleId,
                value, enabled: !!value,
            });
        }
    }

    function broadcastHotkeyFired(scriptId, hotkeyId) {
        if (state.channel) {
            state.channel.postMessage({ type: 'HOTKEY_FIRED', scriptId, hotkeyId });
        }
    }

    // ============================================================
    // 5. HOTKEY ROUTING
    // ============================================================
    function comboFromEvent(e) {
        const parts = [];
        if (e.shiftKey) parts.push('Shift');
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.metaKey) parts.push('Meta');
        // Use e.key for the printable name (avoids KeyO/KeyA noise).
        const k = (e.key || '').toUpperCase();
        if (k && k.length > 0 && !/^(SHIFT|CONTROL|ALT|META)$/.test(k)) parts.push(k);
        return parts.join('+');
    }

    function eventMatchesCombo(e, combo) {
        if (!combo) return false;
        return comboFromEvent(e).toUpperCase() === combo.toUpperCase();
    }

    // Returns { scriptId, hotkeyId, label } of the hotkey currently bound to
    // `combo`, excluding (skipScriptId, skipHotkeyId) which is the one being
    // rebound. null if no conflict. Used to prevent two scripts from racing
    // for the same key combo.
    // Sets a transient rebind error message that auto-clears after the
    // timeout. Cancels any previously-pending clear.
    function setRebindError(msg) {
        state.rebindError = msg;
        if (state.rebindErrorTimer) {
            clearTimeout(state.rebindErrorTimer);
            state.rebindErrorTimer = null;
        }
        if (msg) {
            state.rebindErrorTimer = setTimeout(() => {
                state.rebindError = null;
                state.rebindErrorTimer = null;
                if (state.panelOpen) renderPanel();
            }, REBIND_ERROR_TIMEOUT_MS);
        }
    }

    function findHotkeyConflict(combo, skipScriptId, skipHotkeyId) {
        if (!combo) return null;
        const target = combo.toUpperCase();
        for (const [scriptId, script] of state.registry) {
            if (!Array.isArray(script.hotkeys)) continue;
            for (const hk of script.hotkeys) {
                if (scriptId === skipScriptId && hk.id === skipHotkeyId) continue;
                const bound = getHotkey(scriptId, hk.id, hk.default);
                if (bound && bound.toUpperCase() === target) {
                    return { scriptId, hotkeyId: hk.id, label: hk.label || hk.id };
                }
            }
        }
        return null;
    }

    function inputGuard(e) {
        const el = e.target;
        if (!el) return false;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
        if (el.isContentEditable) return true;
        if (el.closest && (el.closest('.ant-input') || el.closest('.ant-select'))) return true;
        if (el.getAttribute && el.getAttribute('role') === 'textbox') return true;
        return false;
    }

    // Listen for SPA navigation that changes the URL scope. Attach to
    // window.top so IFRAME instances see the SPA-level hash change. TOP
    // instance attaches to its own window. Recomputes state.urlScope and
    // re-renders if the value actually changed.
    function installScopeWatcher() {
        const update = () => {
            const next = getUrlScope();
            if (next !== state.urlScope) {
                state.urlScope = next;
                if (state.panelOpen) renderPanel();
            }
        };
        try {
            const top = window.top || window;
            top.addEventListener('hashchange', update);
            // Also listen for popstate in case Percepto ever moves off
            // hash-based routing (defensive — costs nothing today).
            top.addEventListener('popstate', update);
        } catch (e) {
            window.addEventListener('hashchange', update);
            window.addEventListener('popstate', update);
        }
        // Initialize current value.
        state.urlScope = getUrlScope();
    }

    function installHotkeyRouter() {
        window.addEventListener('keydown', (e) => {
            // Rebinding capture takes priority — when the user is binding a key,
            // their next keypress IS the binding. Don't route to scripts.
            if (state.rebindingFor) {
                e.preventDefault(); e.stopPropagation();
                if (e.key === 'Escape') {
                    state.rebindingFor = null;
                    setRebindError(null); // also clear any pending collision msg
                    renderPanel();
                    return;
                }
                // Ignore modifier-only keydowns. When you press Shift+L, two
                // keydown events fire: one for Shift alone, then one for L
                // (with shiftKey=true). Without this guard we'd save "Shift"
                // and exit rebind mode before the letter ever arrived.
                const keyName = (e.key || '').toUpperCase();
                if (/^(SHIFT|CONTROL|ALT|META|OS)$/.test(keyName)) return;
                const combo = comboFromEvent(e);
                // Need at least one modifier OR a non-letter key. A bare
                // letter binding would fire whenever the user types anywhere.
                if (combo && !(/^[A-Z]$/.test(combo))) {
                    const { scriptId, hotkeyId } = state.rebindingFor;
                    // Collision check: same combo already bound elsewhere?
                    const conflict = findHotkeyConflict(combo, scriptId, hotkeyId);
                    if (conflict) {
                        const scriptName = (state.registry.get(conflict.scriptId) || {}).name || conflict.scriptId;
                        setRebindError(`${combo} is already bound to "${conflict.label}" (${scriptName}). Rebind that one first.`);
                        // Stay in rebind mode so user can press another key
                        // or Esc to cancel — better than dropping them out.
                        renderPanel();
                    } else {
                        setHotkey(scriptId, hotkeyId, combo);
                        state.rebindingFor = null;
                        setRebindError(null);
                        renderPanel();
                    }
                }
                return;
            }
            if (inputGuard(e)) return;
            // Route to any registered script whose hotkey matches AND whose
            // declared scope matches the current URL. Out-of-scope scripts
            // silently drop the hotkey (v1.22 page-awareness).
            for (const [scriptId, script] of state.registry) {
                if (!scopeMatches(script.scope)) continue;
                if (!Array.isArray(script.hotkeys)) continue;
                for (const hk of script.hotkeys) {
                    const bound = getHotkey(scriptId, hk.id, hk.default);
                    if (eventMatchesCombo(e, bound)) {
                        e.preventDefault(); e.stopPropagation();
                        broadcastHotkeyFired(scriptId, hk.id);
                        return;
                    }
                }
            }
        }, true);
    }

    // ============================================================
    // 6. BUTTON INJECTION
    // ============================================================
    function findToolsBar() {
        return document.querySelector('.map-tools');
    }

    // Leaflet listens for click/dblclick/mousedown on its container — if those
    // bubble up from our button or panel, the map below us interprets them as
    // pan/zoom actions. Stop the full mouse event set at our boundary.
    function swallowMouseEvents(el) {
        ['click', 'dblclick', 'mousedown', 'mouseup',
         'pointerdown', 'pointerup', 'pointermove',
         'wheel', 'contextmenu', 'touchstart', 'touchend'].forEach(evt => {
            el.addEventListener(evt, (e) => { e.stopPropagation(); }, false);
        });
    }

    // v1.29 — the signature neon-green pulsing glow (same breathing box-shadow
    // technique as the Site Setup Summary button + AIM Issues activity dot).
    // Injected once into whichever document holds the gear (the map iframe).
    function ensureGearStyles(doc) {
        try {
            if (!doc || doc.getElementById('aim-gear-styles')) return;
            const style = doc.createElement('style');
            style.id = 'aim-gear-styles';
            style.textContent = `
                @keyframes aim-gear-pulse-glow {
                    0%, 100% { box-shadow: 0 0 4px rgba(57,255,20,0.45), 0 0 9px rgba(57,255,20,0.22); }
                    50%      { box-shadow: 0 0 11px rgba(57,255,20,0.90), 0 0 22px rgba(57,255,20,0.48); }
                }
                .aim-control-button { animation: aim-gear-pulse-glow 1.8s ease-in-out infinite; border-radius: 6px; }
                @media (prefers-reduced-motion: reduce) { .aim-control-button { animation: none; } }
            `;
            (doc.head || doc.documentElement).appendChild(style);
        } catch (e) {}
    }

    function injectButton() {
        const tools = findToolsBar();
        if (!tools) return false;
        if (state.buttonEl && tools.contains(state.buttonEl)) return true;
        ensureGearStyles(document);
        // Match the existing .map-tools__button look. Use the same classes
        // the host app's other tools use so styling comes for free.
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="ant-dropdown-trigger map-tools__button pr-dropdown aim-control-button"
                 title="AIM Controls"
                 style="cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;user-select:none">
                <span style="font-size:18px;line-height:1;color:#39ff14">⚙</span>
            </div>
        `;
        const btn = wrapper.firstElementChild;
        tools.appendChild(btn);
        state.buttonEl = btn;
        swallowMouseEvents(btn); // prevent map-zoom on double-click of button
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            togglePanel();
        });
        console.log(`${TAG} button injected into .map-tools`);
        return true;
    }

    function watchToolsBar() {
        // the host app's React might recreate .map-tools; re-inject if our button
        // disappears.
        const obs = new MutationObserver(() => {
            if (state.buttonEl && !document.body.contains(state.buttonEl)) {
                state.buttonEl = null;
                injectButton();
            } else if (!state.buttonEl) {
                injectButton();
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    function ensureButton() {
        if (injectButton()) {
            watchToolsBar();
            return;
        }
        state.injectTries++;
        if (state.injectTries < INJECT_MAX_TRIES) {
            setTimeout(ensureButton, INJECT_RETRY_MS);
        } else {
            console.warn(`${TAG} gave up injecting after ${INJECT_MAX_TRIES} tries — .map-tools not found in this frame`);
        }
    }

    // ============================================================
    // 7. PANEL UI
    // ============================================================
    function createPanel() {
        if (state.panelEl) return;
        const panel = document.createElement('div');
        panel.className = 'aim-control-panel';
        // Dark theme: matches the host app's dark grey, ~85% opacity so the map
        // shows through faintly without losing text contrast.
        panel.style.cssText = [
            // v1.25: right:35px (was 0) shifts the dropdown ~35px LEFT of
            // the gear's right edge so it doesn't get covered by the Power
            // Line Editor's icon strip (⚡ + [+D] + [+T] + …) hanging
            // below the ⚡ button at right:0 of the same .map-tools strip.
            'position:absolute', 'top:calc(100% + 6px)', 'right:35px',
            'min-width:280px', 'max-width:360px',
            // Cap height aggressively so the panel stays compact and scrolls
            // internally instead of stretching down past where the user wants
            // to interact with the map.
            'max-height:55vh', 'overflow-y:auto',
            'background:rgba(40,40,40,0.86)', 'color:#e6e6e6',
            'backdrop-filter:blur(4px)', '-webkit-backdrop-filter:blur(4px)',
            'border:1px solid rgba(255,255,255,0.12)', 'border-radius:6px',
            'box-shadow:0 6px 22px rgba(0,0,0,0.55)',
            // High z-index so we layer above the host app's own overlays
            // (e.g. .map-coordinates-tool is z-index:1000).
            'z-index:100000', 'padding:0', 'display:none',
            'font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'cursor:default',
        ].join(';');
        swallowMouseEvents(panel); // prevent clicks inside the panel from reaching the map
        if (state.buttonEl) state.buttonEl.appendChild(panel);
        state.panelEl = panel;
        // Click outside closes
        document.addEventListener('click', (e) => {
            if (state.panelOpen && state.buttonEl && !state.buttonEl.contains(e.target)) {
                setPanelOpen(false);
            }
        }, true);

        // Event delegation for ALL panel controls. Attached ONCE on the
        // stable panel element, so re-renders don't lose listeners and
        // clicks landing on freshly-recreated checkboxes/buttons still
        // route correctly. Replaces the previous per-element listener
        // attachment in renderPanel (which had a race: clicks landing
        // mid-render could miss their listener).
        panel.addEventListener('change', (e) => {
            const t = e.target;
            if (!t || !t.dataset) return;
            const ctrl = t.dataset.control;
            if (ctrl === 'boolean') {
                broadcastToggle(t.dataset.script, t.dataset.toggle, t.checked);
            } else if (ctrl === 'select') {
                let v = t.value;
                if (!isNaN(parseFloat(v)) && isFinite(v)) v = parseFloat(v);
                broadcastToggle(t.dataset.script, t.dataset.toggle, v);
            } else if (ctrl === 'color') {
                broadcastToggle(t.dataset.script, t.dataset.toggle, t.value);
            } else if (ctrl === 'number') {
                const v = parseFloat(t.value);
                if (!isNaN(v)) broadcastToggle(t.dataset.script, t.dataset.toggle, v);
            }
        }, false);
        // Shared click handler — extracted so we can attach it to BOTH
        // click and pointerdown for defensive routing (in case Leaflet's
        // intermittent click swallow causes the first click to miss).
        // Debounced so one physical click that arrives via both events
        // only acts once.
        let lastHandled = 0;
        const handlePanelInteract = (e) => {
            const t = e.target;
            if (!t) return;
            // For pointerdown, only process LEFT button (button 0). Avoids
            // accidental dismissals on right-click context-menu attempts.
            if (e.type === 'pointerdown' && e.button !== 0) return;
            // Action buttons (validator run/clear etc.)
            if (t.dataset && t.dataset.control === 'button') {
                const now = Date.now();
                if (now - lastHandled < 250) return;
                lastHandled = now;
                e.stopPropagation();
                if (state.channel) {
                    state.channel.postMessage({
                        type: 'TRIGGER_ACTION',
                        scriptId: t.dataset.script,
                        actionId: t.dataset.action,
                    });
                }
                return;
            }
            // Walk up to find any clickable ancestor.
            const dismiss = t.closest && t.closest('[data-dismiss-error]');
            if (dismiss) {
                const now = Date.now();
                if (now - lastHandled < 250) return;
                lastHandled = now;
                e.stopPropagation();
                setRebindError(null);
                renderPanel();
                return;
            }
            // v1.31 — Lite/Full mode toggle (CSMs only; the button only renders
            // for whitelist-resolved CSMs). Lets a CSM preview Lite (what a
            // pilot/reg sees) and switch back. Guards read aim-mode at INIT, so
            // a reload is the clean way to apply.
            const reloadBtn = t.closest && t.closest('[data-reload-mode]');
            if (reloadBtn) {
                e.stopPropagation();
                location.reload();
                return;
            }
            const modeBtn = t.closest && t.closest('[data-mode-toggle]');
            if (modeBtn) {
                const now = Date.now();
                if (now - lastHandled < 250) return;
                lastHandled = now;
                e.stopPropagation();
                const goFull = getMode() !== 'full';
                setMode(goFull ? 'full' : 'lite');
                renderPanel();
                const msg = goFull
                    ? 'Switching to FULL (CSM) mode — building tools (SUM / SOP / bulk / macros / editors) will be enabled.'
                    : 'Switching to LITE mode — you will see what a reg / pilot sees: building tools hidden, QoL + viewing tools stay.';
                if (confirm(`${msg}\n\nReload the page now to apply?`)) {
                    location.reload();
                }
                return;
            }
            // v1.27 — clear the search box.
            const searchClear = t.closest && t.closest('[data-search-clear]');
            if (searchClear) {
                e.stopPropagation();
                state.search = '';
                renderPanel();
                const ni = state.panelEl && state.panelEl.querySelector('[data-search]');
                if (ni) ni.focus();
                return;
            }
            const rebindBtn = t.closest && t.closest('[data-rebind]');
            if (rebindBtn) {
                const now = Date.now();
                if (now - lastHandled < 250) return;
                lastHandled = now;
                e.stopPropagation();
                state.rebindingFor = { scriptId: rebindBtn.dataset.script, hotkeyId: rebindBtn.dataset.hotkey };
                setRebindError(null);
                renderPanel();
                return;
            }
            const resetBtn = t.closest && t.closest('[data-reset]');
            if (resetBtn) {
                const now = Date.now();
                if (now - lastHandled < 250) return;
                lastHandled = now;
                e.stopPropagation();
                const sid = resetBtn.dataset.script;
                if (resetBtn.dataset.hotkey) {
                    // Hotkey reset (existing behavior): clear from saved
                    // hotkeys so the schema default takes over.
                    setHotkey(sid, resetBtn.dataset.hotkey, null);
                } else if (resetBtn.dataset.toggle) {
                    // Toggle reset (v1.20): find the toggle schema, look up
                    // its default, broadcast SET_TOGGLE with that value, and
                    // drop the per-user override from prefs.
                    const script = state.registry.get(sid);
                    if (script) {
                        const t = flattenToggles(script.toggles).find(x => x.id === resetBtn.dataset.toggle);
                        if (t) resetToggleToDefault(sid, t.id, t.default);
                    }
                }
                renderPanel();
                return;
            }
            const advToggle = t.closest && t.closest('[data-advtoggle]');
            if (advToggle) {
                const now = Date.now();
                if (now - lastHandled < 250) return;
                lastHandled = now;
                e.stopPropagation();
                const key = advToggle.dataset.advtoggle;
                state.expanded[key] = !state.expanded[key];
                renderPanel();
                return;
            }
            const catToggle = t.closest && t.closest('[data-cattoggle]');
            if (catToggle) {
                if (t.tagName === 'INPUT') return; // checkbox owns its click
                const now = Date.now();
                if (now - lastHandled < 250) return;
                lastHandled = now;
                e.stopPropagation();
                const key = catToggle.dataset.cattoggle;
                state.expanded[key] = !state.expanded[key];
                renderPanel();
                return;
            }
            const sectionToggle = t.closest && t.closest('[data-sectiontoggle]');
            if (sectionToggle) {
                if (t.tagName === 'INPUT') return;
                const now = Date.now();
                if (now - lastHandled < 250) return;
                lastHandled = now;
                e.stopPropagation();
                const key = sectionToggle.dataset.sectiontoggle;
                if (!state.sectionsOpen) state.sectionsOpen = {};
                state.sectionsOpen[key] = !state.sectionsOpen[key];
                renderPanel();
                return;
            }
            const tokenToggle = t.closest && t.closest('[data-tokensectiontoggle]');
            if (tokenToggle) {
                if (t.tagName === 'INPUT' || t.tagName === 'BUTTON') return;
                const now = Date.now();
                if (now - lastHandled < 250) return;
                lastHandled = now;
                e.stopPropagation();
                state.tokenSectionOpen = !state.tokenSectionOpen;
                renderPanel();
                return;
            }
        };
        panel.addEventListener('click', handlePanelInteract, false);
        // Pointerdown backup — catches clicks that 'click' loses to Leaflet's
        // intermittent capture (same fix as the validator pins).
        panel.addEventListener('pointerdown', handlePanelInteract, false);
        // v1.27 — live search. Re-render on every keystroke, then restore focus
        // + caret to the (rebuilt) search box so typing stays smooth.
        panel.addEventListener('input', (e) => {
            const t = e.target;
            if (!t || !t.matches || !t.matches('[data-search]')) return;
            state.search = t.value;
            const pos = t.selectionStart;
            renderPanel();
            const ni = state.panelEl && state.panelEl.querySelector('[data-search]');
            if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch (e2) {} }
        }, false);
        // Keep digit/letter keys from triggering script hotkeys while typing in
        // a number / token / search input inside the panel.
        panel.addEventListener('keydown', (e) => {
            const t = e.target;
            const isPanelInput = t && t.matches && (t.matches('[data-search]') || t.matches('[data-token-input]') ||
                (t.dataset && (t.dataset.control === 'number' || t.dataset['tokenInput'] !== undefined)));
            if (isPanelInput) e.stopPropagation();
        }, false);
    }

    function setPanelOpen(open) {
        if (!state.panelEl) createPanel();
        state.panelOpen = open;
        state.panelEl.style.display = open ? 'block' : 'none';
        if (open) {
            // Reset section open state so the panel always starts tidy.
            // Per-session behavior; not persisted across page loads.
            state.sectionsOpen = {};
            state.tokenSectionOpen = false;
            setRebindError(null);
            // Auto-test the GitHub token (if one is saved) so the dot
            // reflects current connectivity, not the last cached result.
            const tok = getToken();
            if (tok) {
                state.tokenStatus = 'testing';
                testToken(tok, (status, msg) => {
                    state.tokenStatus = status;
                    state.tokenStatusMsg = msg || '';
                    if (state.panelOpen) renderPanel();
                });
            } else {
                state.tokenStatus = 'missing';
                state.tokenStatusMsg = '';
            }
            requestRegistrations();
            renderPanel();
        } else {
            // Cancel any in-progress rebind
            state.rebindingFor = null;
            setRebindError(null);
        }
    }

    function togglePanel() { setPanelOpen(!state.panelOpen); }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
    }
    function escapeAttr(s) { return escapeHtml(s); }

    // Renders one control row based on the toggle's type. Supported types:
    // Renders the GitHub Connection section as a compact collapsible row.
    // Collapsed (default): just the dot + name + chevron. Expanded: the
    // Edit / Test / Clear controls. Lives at the BOTTOM of the panel since
    // it's a "configuration" item, not part of the active controls.
    function renderTokenSection() {
        const hasToken = !!getToken();
        const status = state.tokenStatus;
        // Status dot color — only green when explicitly verified valid.
        let dotColor = '#666'; // gray: no token / unknown
        let dotTitle = 'Not configured';
        if (status === 'valid') { dotColor = '#5fff5f'; dotTitle = 'Connected'; }
        else if (status === 'invalid') { dotColor = '#ff6060'; dotTitle = 'Token rejected'; }
        else if (status === 'testing') { dotColor = '#ffd591'; dotTitle = 'Testing…'; }
        else if (status === 'error') { dotColor = '#ff8c00'; dotTitle = 'Connection error'; }
        else if (hasToken) { dotColor = '#bbb'; dotTitle = 'Saved (untested)'; }

        const open = !!state.tokenSectionOpen;
        const headerHtml = `
            <div data-tokensectiontoggle="1"
                 style="display:flex;align-items:center;padding:5px 10px;cursor:pointer;background:rgb(36,36,36);user-select:none">
                <span title="${escapeAttr(dotTitle)}"
                      style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${dotColor};margin-right:8px;box-shadow:0 0 4px ${dotColor}66"></span>
                <strong style="flex:1;color:rgb(20,210,220);font-size:12px">GitHub Connection <span style="color:#888;font-weight:400">(KMLs)</span></strong>
                <span style="color:#888;font-size:10px;margin-right:8px">${escapeHtml(dotTitle)}</span>
                <span style="color:#bbb;width:14px;text-align:right">${open ? '▾' : '▸'}</span>
            </div>
        `;
        if (!open) return `<div style="border-top:1px solid rgba(255,255,255,0.12)">${headerHtml}</div>`;

        const statusMsgHtml = state.tokenStatusMsg
            ? `<div style="padding:0 10px 4px;color:#888;font-size:11px;font-style:italic">${escapeHtml(state.tokenStatusMsg)}</div>`
            : '';

        const showInput = state.tokenInputVisible || !hasToken;
        const inputHtml = showInput ? `
            <div style="display:flex;gap:6px;padding:4px 10px;align-items:center">
                <input type="password" data-token-input
                       placeholder="github_pat_…"
                       autocomplete="off" spellcheck="false"
                       style="flex:1;background:rgb(20,20,20);border:1px solid rgba(255,255,255,0.18);color:#e6e6e6;padding:3px 6px;border-radius:3px;font-family:ui-monospace,monospace;font-size:11px" />
                <button data-token-save
                        style="background:rgba(20,210,220,0.18);border:1px solid rgba(20,210,220,0.5);color:rgb(20,210,220);padding:2px 8px;border-radius:3px;font-size:11px;cursor:pointer">Save & Test</button>
                ${hasToken ? `<button data-token-cancel style="background:transparent;border:1px solid rgba(255,255,255,0.18);color:#bbb;padding:2px 8px;border-radius:3px;font-size:11px;cursor:pointer">Cancel</button>` : ''}
            </div>
        ` : `
            <div style="display:flex;gap:6px;padding:4px 10px;align-items:center">
                <span style="flex:1;font-family:ui-monospace,monospace;font-size:11px;color:#bbb">••••••••••••••••</span>
                <button data-token-edit
                        style="background:transparent;border:1px solid rgba(255,255,255,0.18);color:#bbb;padding:2px 8px;border-radius:3px;font-size:11px;cursor:pointer">Edit</button>
                <button data-token-test
                        style="background:transparent;border:1px solid rgba(20,210,220,0.5);color:rgb(20,210,220);padding:2px 8px;border-radius:3px;font-size:11px;cursor:pointer">Test</button>
                <button data-token-clear
                        style="background:transparent;border:1px solid rgba(255,96,96,0.5);color:#ff6060;padding:2px 8px;border-radius:3px;font-size:11px;cursor:pointer">Clear</button>
            </div>
        `;

        return `
            <div style="border-top:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.02)">
                ${headerHtml}
                ${inputHtml}
                ${statusMsgHtml}
            </div>
        `;
    }

    // Hooks up the buttons/inputs created by renderTokenSection. Called once
    // per render — the panel re-renders on any state change, so re-binding
    // is cheap and avoids stale closures.
    function wireTokenSection() {
        const root = state.panelEl;
        if (!root) return;
        const setStatus = (status, msg) => {
            state.tokenStatus = status;
            state.tokenStatusMsg = msg || '';
            renderPanel();
        };
        const saveBtn = root.querySelector('[data-token-save]');
        const input = root.querySelector('[data-token-input]');
        if (saveBtn && input) {
            // Stop hotkey router from grabbing keys while typing into the field.
            input.addEventListener('keydown', (e) => e.stopPropagation());
            const save = () => {
                const val = (input.value || '').trim();
                if (!val) { setStatus('missing', 'Please paste a token first'); return; }
                setToken(val);
                state.tokenInputVisible = false;
                setStatus('testing', 'Verifying…');
                testToken(val, (status, msg) => {
                    // On initial connection, append a reload hint. Map Styler
                    // needs to (re-)receive the token and re-fetch KMLs; in
                    // some cases — especially right after a multi-update
                    // install — a hard-reload is needed for the SVG overlays
                    // to actually render. Telling the user up-front beats
                    // them wondering why nothing appears.
                    if (status === 'valid') {
                        msg = `${msg}. KMLs should appear within ~10s. If they don't, hard-reload: Ctrl+Shift+R (⌘+Shift+R on Mac).`;
                    }
                    setStatus(status, msg);
                });
            };
            saveBtn.addEventListener('click', (e) => { e.stopPropagation(); save(); });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); save(); }
            });
        }
        const cancelBtn = root.querySelector('[data-token-cancel]');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                state.tokenInputVisible = false;
                renderPanel();
            });
        }
        const editBtn = root.querySelector('[data-token-edit]');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                state.tokenInputVisible = true;
                renderPanel();
            });
        }
        const testBtn = root.querySelector('[data-token-test]');
        if (testBtn) {
            testBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tok = getToken();
                if (!tok) { setStatus('missing', 'No token saved'); return; }
                setStatus('testing', 'Verifying…');
                testToken(tok, (status, msg) => setStatus(status, msg));
            });
        }
        const clearBtn = root.querySelector('[data-token-clear]');
        if (clearBtn) {
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                setToken('');
                setStatus('missing', 'Token cleared');
            });
        }
    }

    //   boolean (default)  — checkbox
    //   select             — dropdown of {value,label} options
    //   number             — numeric input with optional unit suffix
    //   advanced           — collapsible group of nested children
    // v1.20 — small reset-icon snippet shared across all control types.
    // Returns empty string when the value matches the schema default
    // (so the icon only appears when there's something to reset).
    function resetIconHtml(scriptId, t, value) {
        if (!isCustomized(t, value)) return '';
        const defStr = t.default === undefined ? '' : String(t.default);
        return `<button data-reset data-script="${escapeAttr(scriptId)}" data-toggle="${escapeAttr(t.id)}"
                       style="background:transparent;border:none;color:rgb(20,210,220);cursor:pointer;font-size:11px;padding:0 2px"
                       title="Reset to default${defStr ? ` (${escapeAttr(defStr)})` : ''}">↺</button>`;
    }

    // v1.28 — search helpers. isSearching() force-expands categories so a
    // matching child is visible. filterTogglesForSearch returns a PRUNED
    // toggle tree containing only controls (or whole categories) whose label
    // matches — so searching "Flight" shows only flight controls, not the
    // whole Outlines section. Recurses into category/advanced children; drops
    // 'header' dividers (they'd be orphaned).
    function isSearching() { return !!(state.search && state.search.trim()); }
    function filterTogglesForSearch(toggles, q) {
        const out = [];
        (toggles || []).forEach(t => {
            if (!t) return;
            if (t.type === 'header') return;
            const label = (t.label || '').toLowerCase();
            if (t.type === 'category' || t.type === 'advanced') {
                if (label.includes(q)) { out.push(t); return; }   // whole category matches
                const kids = filterTogglesForSearch(t.children || [], q);
                if (kids.length) out.push({ ...t, children: kids }); // keep category, matching kids only
                return;
            }
            if (label.includes(q)) out.push(t);
        });
        return out;
    }
    function filterHotkeysForSearch(hotkeys, q) {
        return (hotkeys || []).filter(h => h && (h.label || '').toLowerCase().includes(q));
    }

    function renderControl(scriptId, t) {
        if (!t) return '';
        const type = t.type || 'boolean';
        const value = getToggle(scriptId, t.id, t.default);

        if (type === 'header') {
            // Purely visual sub-section divider — no state, no checkbox, no
            // collapse. Used to group flat lists of toggles into named
            // segments (e.g. Perf Shield's "Map performance" / "Network
            // blocks"). Children are NOT nested — they're peer siblings in
            // the toggles list; the header just labels everything that
            // follows it until the next header.
            return `
                <div style="padding:6px 10px 3px 10px;color:#7adfe6;font-size:10px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;border-top:1px solid rgba(255,255,255,0.08);margin-top:2px;background:rgba(20,210,220,0.04)">
                    ${escapeHtml(t.label || '')}
                </div>
            `;
        }

        if (type === 'category') {
            // Header row: optional master checkbox + label + meta + expand arrow.
            // Clicking the checkbox toggles its boolean; clicking anywhere else
            // on the row expands/collapses the body.
            const expandKey = `cat:${scriptId}:${t.id}`;
            const expanded = isSearching() || (state.expanded && state.expanded[expandKey]);
            const childrenHtml = (t.children || []).map(c => renderControl(scriptId, c)).join('');
            let headerCheckbox = '';
            if (t.master && t.master.id) {
                const masterValue = getToggle(scriptId, t.master.id, t.master.default);
                headerCheckbox = `<input type="checkbox" ${masterValue ? 'checked' : ''}
                    data-control="boolean"
                    data-script="${escapeAttr(scriptId)}"
                    data-toggle="${escapeAttr(t.master.id)}"
                    style="cursor:pointer;accent-color:rgb(20,210,220);margin:0 6px 0 0" />`;
            }
            const metaHtml = t.meta ? ` <span style="color:#888;font-weight:normal;font-size:11px">${escapeHtml(t.meta)}</span>` : '';
            return `
                <div style="border-bottom:1px solid rgba(255,255,255,0.08)">
                    <div data-cattoggle="${escapeAttr(expandKey)}" style="display:flex;align-items:center;padding:4px 10px;cursor:pointer;background:rgba(255,255,255,0.02);user-select:none">
                        ${headerCheckbox}
                        <span style="flex:1;color:#e6e6e6">${escapeHtml(t.label || t.id)}${metaHtml}</span>
                        <span style="color:#bbb;width:14px;text-align:right">${expanded ? '▾' : '▸'}</span>
                    </div>
                    ${expanded ? `<div style="padding:3px 0 5px 18px;background:rgba(0,0,0,0.12);border-top:1px dashed rgba(255,255,255,0.06)">${childrenHtml}</div>` : ''}
                </div>
            `;
        }

        if (type === 'advanced') {
            const expandKey = `adv:${scriptId}:${t.id || 'group'}`;
            const expanded = isSearching() || (state.expanded && state.expanded[expandKey]);
            const childrenHtml = (t.children || []).map(c => renderControl(scriptId, c)).join('');
            return `
                <div style="border-top:1px dashed rgba(255,255,255,0.10);margin-top:4px;padding-top:2px">
                    <button data-advtoggle="${escapeAttr(expandKey)}"
                            style="width:100%;text-align:left;background:transparent;border:none;color:#bbb;padding:4px 10px;cursor:pointer;font:inherit;display:flex;align-items:center;gap:6px">
                        <span style="display:inline-block;width:10px">${expanded ? '▾' : '▸'}</span>
                        <span>${escapeHtml(t.label || 'Advanced')}</span>
                    </button>
                    ${expanded ? `<div style="padding:2px 0">${childrenHtml}</div>` : ''}
                </div>
            `;
        }

        if (type === 'select') {
            const opts = (t.options || []).map(o => {
                const sel = String(o.value) === String(value) ? 'selected' : '';
                return `<option value="${escapeAttr(String(o.value))}" ${sel}>${escapeHtml(o.label || o.value)}</option>`;
            }).join('');
            return `
                <div style="display:flex;align-items:center;gap:8px;padding:3px 10px;color:#e6e6e6">
                    <span style="flex:1">${escapeHtml(t.label || t.id)}</span>
                    <select data-control="select" data-script="${escapeAttr(scriptId)}" data-toggle="${escapeAttr(t.id)}"
                            style="background:#1f2228;color:#e6e6e6;border:1px solid rgba(255,255,255,0.18);border-radius:3px;padding:2px 6px;cursor:pointer;font:inherit">${opts}</select>
                    ${resetIconHtml(scriptId, t, value)}
                </div>
            `;
        }

        if (type === 'color') {
            const v = value || t.default || '#000000';
            return `
                <div style="display:flex;align-items:center;gap:8px;padding:3px 10px;color:#e6e6e6">
                    <span style="flex:1">${escapeHtml(t.label || t.id)}</span>
                    <input type="color" value="${escapeAttr(String(v))}"
                           data-control="color" data-script="${escapeAttr(scriptId)}" data-toggle="${escapeAttr(t.id)}"
                           style="width:42px;height:24px;cursor:pointer;border:1px solid rgba(255,255,255,0.18);border-radius:3px;padding:0;background:transparent"/>
                    ${resetIconHtml(scriptId, t, value)}
                </div>
            `;
        }

        if (type === 'button') {
            // Action button — broadcasts TRIGGER_ACTION (actionId from t.action
            // or t.id). The owning script listens and runs whatever is wired up.
            return `
                <div style="padding:4px 10px">
                    <button data-control="button"
                            data-script="${escapeAttr(scriptId)}"
                            data-action="${escapeAttr(t.action || t.id)}"
                            style="width:100%;background:rgba(20,210,220,0.18);border:1px solid rgba(20,210,220,0.5);color:rgb(20,210,220);padding:4px 8px;border-radius:3px;font:inherit;cursor:pointer">
                        ${escapeHtml(t.label || t.id)}
                    </button>
                </div>
            `;
        }

        if (type === 'number') {
            const v = (value === undefined || value === null) ? (t.default ?? '') : value;
            return `
                <div style="display:flex;align-items:center;gap:8px;padding:3px 10px;color:#e6e6e6">
                    <span style="flex:1">${escapeHtml(t.label || t.id)}</span>
                    <input type="number" value="${escapeAttr(String(v))}"
                           ${t.min !== undefined ? `min="${escapeAttr(String(t.min))}"` : ''}
                           ${t.max !== undefined ? `max="${escapeAttr(String(t.max))}"` : ''}
                           ${t.step !== undefined ? `step="${escapeAttr(String(t.step))}"` : ''}
                           data-control="number" data-script="${escapeAttr(scriptId)}" data-toggle="${escapeAttr(t.id)}"
                           style="width:70px;background:#1f2228;color:#e6e6e6;border:1px solid rgba(255,255,255,0.18);border-radius:3px;padding:2px 6px;font:inherit"/>
                    ${t.unit ? `<span style="color:#888;font-size:11px">${escapeHtml(t.unit)}</span>` : ''}
                    ${resetIconHtml(scriptId, t, value)}
                </div>
            `;
        }

        // boolean (default)
        const isMaster = !!t.master;
        return `
            <label style="display:flex;align-items:center;gap:8px;padding:3px 10px;cursor:pointer;color:#e6e6e6;${isMaster ? 'font-weight:600;border-bottom:1px dashed rgba(255,255,255,0.10)' : ''}">
                <input type="checkbox" ${value ? 'checked' : ''}
                       data-control="boolean"
                       data-script="${escapeAttr(scriptId)}"
                       data-toggle="${escapeAttr(t.id)}"
                       style="cursor:pointer;accent-color:rgb(20,210,220)" />
                <span style="flex:1">${escapeHtml(t.label || t.id)}</span>
                ${resetIconHtml(scriptId, t, value)}
            </label>
        `;
    }

    // v1.24 — coalesce burst renderPanel() calls. When the panel opens we
    // broadcast REQUEST_REGISTRATIONS; each script in TOP + IFRAME responds
    // with REGISTER, and each REGISTER echoes back N SET_TOGGLEs (one per
    // toggle in the script). With ~14 scripts × 2 contexts that adds up to
    // dozens of renderPanel() calls in the first ~500ms after open. Each
    // render rebuilds panel.innerHTML, which destroys any input/checkbox
    // the user clicked mid-burst — losing the change event entirely.
    // Symptom: "hide-satellite checkbox unresponsive", "inputs need
    // multiple clicks before they accept edits". Fix: rAF-debounce.
    let renderScheduled = false;
    function scheduleRender() {
        if (renderScheduled) return;
        if (!state.panelEl || !state.panelOpen) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            renderPanel();
        });
    }

    function renderPanel() {
        if (!state.panelEl || !state.panelOpen) return;
        const scripts = Array.from(state.registry.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        // v1.27 — search filter. When non-empty, only matching sections render
        // and everything is force-expanded so results are visible.
        const q = (state.search || '').trim().toLowerCase();
        const searching = q.length > 0;

        const headerHtml = `
            <div style="border-bottom:1px solid rgba(255,255,255,0.10);background:rgb(28,28,28);border-radius:6px 6px 0 0;position:sticky;top:0;z-index:2">
                <div style="padding:6px 10px;display:flex;align-items:center;justify-content:space-between">
                    <strong style="color:rgb(20,210,220)">AIM Controls</strong>
                    <span style="font-size:11px;color:#888">${scripts.length} script${scripts.length === 1 ? '' : 's'}</span>
                </div>
                <div style="padding:0 10px 7px;display:flex;align-items:center;gap:6px">
                    <input data-search type="text" placeholder="Search settings…" value="${escapeAttr(state.search || '')}"
                           style="flex:1;background:rgb(20,20,20);border:1px solid rgba(255,255,255,0.18);border-radius:4px;color:#e6e6e6;font-size:11px;padding:4px 8px;outline:none" />
                    ${searching ? `<button data-search-clear title="Clear search" style="background:transparent;border:none;color:#bbb;cursor:pointer;font-size:15px;line-height:1;padding:0 4px">×</button>` : ''}
                </div>
            </div>
        `;

        const tokenHtml = renderTokenSection();

        const emptyHtml = scripts.length === 0 ? `
            <div style="padding:20px 16px;text-align:center;color:#888">
                <div style="margin-bottom:6px">No AIM scripts registered yet.</div>
                <small>Scripts auto-register on load. Try reloading the page.</small>
            </div>
        ` : '';

        // Renders the inner content (toggles + hotkeys) for one script.
        // Four layout variants based on shape:
        //   1. Single master + single hotkey → ONE combined row.
        //   2. Hotkeys all have pairToggleId, no other toggles → each row
        //      gets its own inline enable checkbox. No master. Optional
        //      script-name header. (e.g. New Entity Macro v1.6+)
        //   3. Single master + multiple hotkeys → checkbox+name header + rows.
        //   4. Default → toggles list + hotkey rows + optional sub-header.
        //
        // Hotkey schema fields supported beyond {id, label, default}:
        //   - labelHtml: trusted raw HTML to use as label (for colored names)
        //   - chipColor: hex color applied to the key-chip text
        //   - pairToggleId: id of a paired enable toggle that renders inline
        const renderScriptInner = (script, withSubHeader) => {
            const toggles = Array.isArray(script.toggles) ? script.toggles : [];
            const hotkeys = Array.isArray(script.hotkeys) ? script.hotkeys : [];

            // Which toggles are paired with a hotkey row? Those are rendered
            // inline (inside the hotkey row) instead of as standalone toggles.
            const pairedToggleIds = new Set();
            hotkeys.forEach(hk => { if (hk.pairToggleId) pairedToggleIds.add(hk.pairToggleId); });
            const unpairedToggles = toggles.filter(t => !pairedToggleIds.has(t.id));
            const isSimple = unpairedToggles.length === 1 && unpairedToggles[0].master === true;

            // Resolve a label — trusted HTML if labelHtml is present, otherwise
            // the plain label gets escaped. Used for both toggles and hotkeys.
            const labelText = (item) => item.labelHtml || escapeHtml(item.label || item.id);

            const renderHotkeyChip = (hk, indentPx) => {
                const bound = getHotkey(script.scriptId, hk.id, hk.default);
                const isBindingThis = state.rebindingFor && state.rebindingFor.scriptId === script.scriptId && state.rebindingFor.hotkeyId === hk.id;
                const chipColorOverride = !isBindingThis && hk.chipColor ? `color:${hk.chipColor};` : '';
                const chipStyle = isBindingThis
                    ? 'background:rgba(173,104,0,0.20);border:1px solid #ffd591;color:#ffd591'
                    : `background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);color:#e6e6e6;${chipColorOverride}`;
                const chipText = isBindingThis ? 'press a key… (Esc to cancel)' : (bound || '— unbound —');
                const isCustom = bound && bound !== hk.default;
                return `
                    <div style="display:flex;align-items:center;gap:8px;padding:3px 10px 3px ${indentPx}px">
                        <span style="flex:1;color:#bbb">${labelText(hk)}</span>
                        <button data-rebind data-script="${escapeAttr(script.scriptId)}" data-hotkey="${escapeAttr(hk.id)}"
                                style="font-family:ui-monospace,monospace;font-size:11px;padding:2px 8px;border-radius:3px;cursor:pointer;font-weight:600;${chipStyle}">${escapeHtml(chipText)}</button>
                        ${isCustom ? `<button data-reset data-script="${escapeAttr(script.scriptId)}" data-hotkey="${escapeAttr(hk.id)}" style="background:transparent;border:none;color:rgb(20,210,220);cursor:pointer;font-size:11px" title="Reset to default (${escapeAttr(hk.default || '')})">↺</button>` : ''}
                    </div>
                `;
            };

            // Hotkey row with INLINE enable checkbox (paired toggle). Used by
            // CASE 2. The checkbox swallows clicks so the row label/chip stays
            // independent.
            const renderHotkeyRowWithCheckbox = (hk, indentPx) => {
                const t = toggles.find(x => x.id === hk.pairToggleId);
                if (!t) return renderHotkeyChip(hk, indentPx);
                const checked = getToggle(script.scriptId, t.id, t.default);
                const bound = getHotkey(script.scriptId, hk.id, hk.default);
                const isBindingThis = state.rebindingFor && state.rebindingFor.scriptId === script.scriptId && state.rebindingFor.hotkeyId === hk.id;
                const chipColorOverride = !isBindingThis && hk.chipColor ? `color:${hk.chipColor};` : '';
                const chipStyle = isBindingThis
                    ? 'background:rgba(173,104,0,0.20);border:1px solid #ffd591;color:#ffd591'
                    : `background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);color:#e6e6e6;${chipColorOverride}`;
                const chipText = isBindingThis ? 'press a key… (Esc to cancel)' : (bound || '— unbound —');
                const isCustom = bound && bound !== hk.default;
                return `
                    <label style="display:flex;align-items:center;gap:8px;padding:3px 10px 3px ${indentPx}px;cursor:pointer">
                        <input type="checkbox" ${checked ? 'checked' : ''}
                               data-control="boolean"
                               data-script="${escapeAttr(script.scriptId)}"
                               data-toggle="${escapeAttr(t.id)}"
                               style="cursor:pointer;accent-color:rgb(20,210,220);margin:0" />
                        <span style="flex:1;color:#e6e6e6">${labelText(hk)}</span>
                        <button data-rebind data-script="${escapeAttr(script.scriptId)}" data-hotkey="${escapeAttr(hk.id)}"
                                style="font-family:ui-monospace,monospace;font-size:11px;padding:2px 8px;border-radius:3px;cursor:pointer;font-weight:600;${chipStyle}">${escapeHtml(chipText)}</button>
                        ${isCustom ? `<button data-reset data-script="${escapeAttr(script.scriptId)}" data-hotkey="${escapeAttr(hk.id)}" style="background:transparent;border:none;color:rgb(20,210,220);cursor:pointer;font-size:11px" title="Reset to default (${escapeAttr(hk.default || '')})">↺</button>` : ''}
                    </label>
                `;
            };

            // CASE 1: simple single-master + single-hotkey → one row.
            if (isSimple && hotkeys.length === 1 && !hotkeys[0].pairToggleId) {
                const t = unpairedToggles[0];
                const hk = hotkeys[0];
                const checked = getToggle(script.scriptId, t.id, t.default);
                const bound = getHotkey(script.scriptId, hk.id, hk.default);
                const isBindingThis = state.rebindingFor && state.rebindingFor.scriptId === script.scriptId && state.rebindingFor.hotkeyId === hk.id;
                const chipColorOverride = !isBindingThis && hk.chipColor ? `color:${hk.chipColor};` : '';
                const chipStyle = isBindingThis
                    ? 'background:rgba(173,104,0,0.20);border:1px solid #ffd591;color:#ffd591'
                    : `background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);color:#e6e6e6;${chipColorOverride}`;
                const chipText = isBindingThis ? 'press a key… (Esc to cancel)' : (bound || '— unbound —');
                const isCustom = bound && bound !== hk.default;
                return `
                    <label style="display:flex;align-items:center;gap:8px;padding:4px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04)">
                        <input type="checkbox" ${checked ? 'checked' : ''}
                               data-control="boolean"
                               data-script="${escapeAttr(script.scriptId)}"
                               data-toggle="${escapeAttr(t.id)}"
                               style="cursor:pointer;accent-color:rgb(20,210,220);margin:0" />
                        <span style="flex:1;color:#e6e6e6">${labelText(hk)}</span>
                        <button data-rebind data-script="${escapeAttr(script.scriptId)}" data-hotkey="${escapeAttr(hk.id)}"
                                style="font-family:ui-monospace,monospace;font-size:11px;padding:2px 8px;border-radius:3px;cursor:pointer;font-weight:600;${chipStyle}">${escapeHtml(chipText)}</button>
                        ${isCustom ? `<button data-reset data-script="${escapeAttr(script.scriptId)}" data-hotkey="${escapeAttr(hk.id)}" style="background:transparent;border:none;color:rgb(20,210,220);cursor:pointer;font-size:11px" title="Reset to default (${escapeAttr(hk.default || '')})">↺</button>` : ''}
                    </label>
                `;
            }

            // CASE 2: every hotkey has a paired enable toggle (no master) →
            // each row gets its own inline checkbox. Optional script-name
            // header for context (no checkbox in it).
            const allHotkeysPaired = hotkeys.length > 0 && hotkeys.every(hk => hk.pairToggleId);
            if (allHotkeysPaired && unpairedToggles.length === 0) {
                const headerHtml = withSubHeader ? `
                    <div style="padding:4px 10px;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06)">
                        <strong style="color:#e6e6e6;font-size:12px">${escapeHtml(script.name || script.scriptId)}</strong>
                    </div>
                ` : '';
                const rowsHtml = hotkeys.map(hk => renderHotkeyRowWithCheckbox(hk, 10)).join('');
                return `<div>${headerHtml}${rowsHtml}</div>`;
            }

            // CASE 3: simple single-master + multiple hotkeys → checkbox+name
            // header followed by indented hotkey rows. Some hotkeys may have
            // their own pairToggleId — rendered inline if so.
            if (isSimple && hotkeys.length > 1) {
                const t = unpairedToggles[0];
                const checked = getToggle(script.scriptId, t.id, t.default);
                const headerHtml = withSubHeader ? `
                    <label style="display:flex;align-items:center;gap:8px;padding:4px 10px;cursor:pointer;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06)">
                        <input type="checkbox" ${checked ? 'checked' : ''}
                               data-control="boolean"
                               data-script="${escapeAttr(script.scriptId)}"
                               data-toggle="${escapeAttr(t.id)}"
                               style="cursor:pointer;accent-color:rgb(20,210,220);margin:0" />
                        <strong style="flex:1;color:#e6e6e6;font-size:12px">${escapeHtml(script.name || script.scriptId)}</strong>
                    </label>
                ` : '';
                const hotkeysHtml = hotkeys.map(hk => hk.pairToggleId
                    ? renderHotkeyRowWithCheckbox(hk, 24)
                    : renderHotkeyChip(hk, 24)).join('');
                return `<div>${headerHtml}${hotkeysHtml}</div>`;
            }

            // CASE 4 (default): complex layout — toggles list (excluding any
            // that are paired with hotkey rows) + hotkey rows.
            const togglesHtml = unpairedToggles.map(t => renderControl(script.scriptId, t)).join('')
                || (hotkeys.length ? '' : `<div style="padding:3px 10px;color:#888;font-style:italic">no toggles exposed</div>`);
            const hotkeysHtml = hotkeys.map(hk => hk.pairToggleId
                ? renderHotkeyRowWithCheckbox(hk, 10)
                : renderHotkeyChip(hk, 10)).join('');
            const subHeader = withSubHeader ? `
                <div style="padding:3px 10px 3px;display:flex;align-items:center;gap:6px">
                    <strong style="color:#e6e6e6">${escapeHtml(script.name || script.scriptId)}</strong>
                    <span style="color:#888;font-size:11px">v${escapeHtml(script.version || '?')}</span>
                </div>` : '';
            return `
                <div style="padding:4px 0;${withSubHeader ? 'border-bottom:1px solid rgba(255,255,255,0.08)' : ''}">
                    ${subHeader}
                    ${togglesHtml}
                    ${hotkeysHtml ? `<div style="margin-top:3px;padding:3px 0 0;border-top:1px dashed rgba(255,255,255,0.10)">${hotkeysHtml}</div>` : ''}
                </div>
            `;
        };

        // Reusable section wrapper — cyan collapsible header used for both
        // groups and standalone scripts. Default state = COLLAPSED. Per
        // user request: the panel always starts tidy each time it opens.
        const renderSection = (key, title, meta, bodyHtml) => {
            const open = searching || !!(state.sectionsOpen && state.sectionsOpen[key]);
            return `
                <div style="border-bottom:1px solid rgba(255,255,255,0.12)">
                    <div data-sectiontoggle="${escapeAttr(key)}"
                         style="display:flex;align-items:center;padding:5px 10px;cursor:pointer;background:rgb(36,36,36);user-select:none">
                        <strong style="flex:1;color:rgb(20,210,220);font-size:12px">${escapeHtml(title)}</strong>
                        ${meta ? `<span style="color:#888;font-size:10px;margin-right:8px">${escapeHtml(meta)}</span>` : ''}
                        <span style="color:#bbb;width:14px;text-align:right">${open ? '▾' : '▸'}</span>
                    </div>
                    ${open ? `<div>${bodyHtml}</div>` : ''}
                </div>
            `;
        };
        // v1.27 — nested, collapsible sub-section for a script INSIDE a group
        // (indented + subtler than a top-level section). Reuses the generic
        // data-sectiontoggle handler with a `member:<id>` key. Default closed
        // (so a big group like Map Display opens to a tidy list of titles);
        // force-open while searching.
        const renderSubSection = (key, title, meta, bodyHtml) => {
            const open = searching || !!(state.sectionsOpen && state.sectionsOpen[key]);
            return `
                <div style="border-top:1px solid rgba(255,255,255,0.06)">
                    <div data-sectiontoggle="${escapeAttr(key)}"
                         style="display:flex;align-items:center;padding:4px 10px 4px 20px;cursor:pointer;background:rgb(31,31,31);user-select:none">
                        <span style="flex:1;color:#cdeff3;font-size:11px;font-weight:600">${escapeHtml(title)}</span>
                        ${meta ? `<span style="color:#777;font-size:9px;margin-right:8px">${escapeHtml(meta)}</span>` : ''}
                        <span style="color:#999;width:12px;text-align:right;font-size:11px">${open ? '▾' : '▸'}</span>
                    </div>
                    ${open ? `<div style="padding-left:8px">${bodyHtml}</div>` : ''}
                </div>
            `;
        };

        // Group registered scripts by their declared `group`. Scripts
        // without a group get a section with the script's own name as the
        // header (visually consistent with grouped sections).
        // v1.22 — filter by URL scope BEFORE bucketing into standalone/groups
        // so out-of-scope scripts disappear entirely from the panel.
        // Groups whose members all get filtered out simply won't be created,
        // so their section header doesn't render either.
        // v1.30 — in Pilot mode, hide any builder that still registered (an
        // older install without the init guard). Guarded builders never reach
        // here because they return before registering.
        const visibleScripts = scripts
            .filter(s => scopeMatches(s.scope))
            .filter(s => isFull() || LITE_ALLOWED.has(s.scriptId));

        // v1.26 — CENTRAL TAXONOMY. One source of truth for how the panel is
        // organized, keyed by scriptId so we can re-group everything WITHOUT
        // editing the other scripts. SCRIPT_GROUP overrides each script's
        // self-declared `group`; SCRIPT_ORDER sets within-group order. A
        // script not listed here falls back to its own `group` (or standalone),
        // so new/unknown scripts still appear (at the bottom). Edit THIS to
        // rearrange the Control Panel.
        const SCRIPT_GROUP = {
            // Map Display — what's drawn on the map + display performance.
            'aim-defaults': 'Map Display',
            'aim-styler': 'Map Display',
            'aim-perf-shield': 'Map Display',
            'aim-map-nav': 'Map Display',
            // Power Lines — distro/trans styling (Map Styler power-line card,
            // added in Phase 2) + the power-line editor.
            'aim-power-line-editor': 'Power Lines',
            'aim-styler-powerlines': 'Power Lines',
            // Site Setup — entity inspection, validation, creation.
            'aim-copy-asset': 'Site Setup',
            'aim-sop-validators': 'Site Setup',
            'aim-new-entity-macro': 'Site Setup',
            'aim-site-setup-generator': 'Site Setup',
            // Map Tools — quick one-shot map utilities.
            'aim-altitude': 'Map Tools',
            'aim-ruler': 'Map Tools',
            'aim-clear-all': 'Map Tools',
            // Missions — the Mission Bank side.
            'aim-mission-bank-tools': 'Missions',
            'aim-bulk-mission-adder': 'Missions',
            'aim-quick-mission-editor': 'Missions',
            // Issues — single-member group (renders without a redundant sub-header).
            'aim-issues': 'Issues',
        };
        const SCRIPT_ORDER = {
            'aim-defaults': 10, 'aim-styler': 20, 'aim-perf-shield': 30, 'aim-map-nav': 40,
            'aim-styler-powerlines': 10, 'aim-power-line-editor': 20,
            'aim-copy-asset': 10, 'aim-sop-validators': 20, 'aim-new-entity-macro': 30, 'aim-site-setup-generator': 40,
            'aim-altitude': 10, 'aim-ruler': 20, 'aim-clear-all': 30,
            'aim-mission-bank-tools': 10, 'aim-bulk-mission-adder': 20, 'aim-quick-mission-editor': 30,
        };

        // v1.28 — return the script to RENDER for the current search, or null
        // to exclude it. If the query hits the tool's NAME or GROUP, show the
        // whole tool; otherwise prune to just the matching controls (so
        // searching "Flight" shows only flight controls, not all of Outlines).
        const searchScript = (s, g) => {
            if (!searching) return s;
            if ((s.name || '').toLowerCase().includes(q) || (g && g.toLowerCase().includes(q))) return s;
            const ft = filterTogglesForSearch(s.toggles, q);
            const fh = filterHotkeysForSearch(s.hotkeys, q);
            if (ft.length || fh.length) return { ...s, toggles: ft, hotkeys: fh };
            return null;
        };

        const standalone = [];
        const groups = new Map(); // groupName -> [scripts]
        visibleScripts.forEach(s => {
            const g = SCRIPT_GROUP[s.scriptId] || s.group;
            const sv = searchScript(s, g);
            if (!sv) return;
            if (g) {
                if (!groups.has(g)) groups.set(g, []);
                groups.get(g).push(sv);
            } else {
                standalone.push(sv);
            }
        });

        // v1.20 — Build a single section list with explicit ordering by
        // SECTION_PRIORITY. Lower priority numbers render first. Items not
        // in the map get priority 999 (and tie-break alphabetically). This
        // is what makes "Outlines / Performance / Hotkeys / others"
        // intuitive instead of pure alphabetical (which would put Bulk*
        // first, scattering the layout). Keys match the existing
        // section keys: `script:<scriptId>` for standalone, `group:<name>`
        // for groups. Edit this map to change the order.
        const SECTION_PRIORITY = {
            // v1.26 — top-level group order (lower = higher up). Mirrors the
            // SCRIPT_GROUP taxonomy above. Anything not listed → 999 (bottom).
            'group:Map Display': 10,
            'group:Power Lines': 20,
            'group:Site Setup': 30,
            'group:Map Tools': 40,
            'group:Missions': 50,
            'group:Issues': 60,
        };
        const sectionEntries = [];
        standalone.forEach(s => {
            const key = `script:${s.scriptId}`;
            sectionEntries.push({
                key,
                priority: SECTION_PRIORITY[key] !== undefined ? SECTION_PRIORITY[key] : 999,
                sortName: s.name || s.scriptId,
                renderFn: () => renderSection(
                    key,
                    s.name || s.scriptId,
                    `v${s.version || '?'}`,
                    renderScriptInner(s, false),
                ),
            });
        });
        groups.forEach((members, name) => {
            const key = `group:${name}`;
            // Sort members WITHIN the group by REGISTER's optional `priority`
            // field (lower first, default 100), tiebreak by display name.
            // Lets us order Hotkeys as "simple → macros → bulk tools" instead
            // of pure alphabetical. Scripts that don't set priority just
            // fall back to alphabetical ordering with everything else at 100.
            const sortedMembers = [...members].sort((a, b) => {
                const pa = SCRIPT_ORDER[a.scriptId] !== undefined ? SCRIPT_ORDER[a.scriptId] : (typeof a.priority === 'number' ? a.priority : 100);
                const pb = SCRIPT_ORDER[b.scriptId] !== undefined ? SCRIPT_ORDER[b.scriptId] : (typeof b.priority === 'number' ? b.priority : 100);
                if (pa !== pb) return pa - pb;
                return (a.name || a.scriptId).localeCompare(b.name || b.scriptId);
            });
            // Single-member group → render the member directly under the group
            // name (no redundant "Issues / Issues" sub-header or "1 script" meta).
            const single = sortedMembers.length === 1;
            const meta = single ? `v${sortedMembers[0].version || '?'}` : `${sortedMembers.length} scripts`;
            const bodyHtml = single
                ? renderScriptInner(sortedMembers[0], false)
                : sortedMembers.map(s => renderSubSection(`member:${s.scriptId}`, s.name || s.scriptId, `v${s.version || '?'}`, renderScriptInner(s, false))).join('');
            sectionEntries.push({
                key,
                priority: SECTION_PRIORITY[key] !== undefined ? SECTION_PRIORITY[key] : 999,
                sortName: name,
                renderFn: () => renderSection(key, name, meta, bodyHtml),
            });
        });
        sectionEntries.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.sortName.localeCompare(b.sortName);
        });
        let sectionsHtml = sectionEntries.map(e => e.renderFn()).join('');
        if (searching && sectionEntries.length === 0) {
            sectionsHtml = `<div style="padding:16px;text-align:center;color:#888;font-size:11px">No settings match “${escapeHtml(state.search.trim())}”.</div>`;
        }

        // Transient error banner shown after a rebind collision. Auto-clears
        // after ~6s OR when the user clicks the × close button.
        const errorHtml = state.rebindError ? `
            <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(255,96,96,0.18);border-bottom:1px solid rgba(255,96,96,0.45);color:#ff9a9a;font-size:11px;font-weight:600">
                <span style="flex:1">⚠ ${escapeHtml(state.rebindError)}</span>
                <button data-dismiss-error title="Dismiss"
                        style="background:transparent;border:none;color:#ff9a9a;cursor:pointer;font-size:14px;line-height:1;padding:0 4px">×</button>
            </div>
        ` : '';

        // v1.31 — Lite/Full mode banner. Shows the mode the page is RUNNING in
        // (ACTIVE_MODE), the resolved GitHub login, and — only for whitelist-
        // resolved CSMs — a Lite/Full toggle (to preview the pilot/reg view). A
        // "reload to apply" nudge appears when resolveMode() has changed the
        // cached mode since load (e.g. a CSM's first resolution).
        const full = ACTIVE_MODE === 'full';
        const login = getModeLogin();
        const pending = getMode() !== ACTIVE_MODE; // resolved differs from what's running
        const modeLabel = full ? '🛠️ Full (CSM)' : '🪶 Lite';
        const sub = login
            ? `${escapeHtml(login)}${isCsmUser() ? ' · CSM' : ''}`
            : (isFull() ? '' : 'building tools hidden');
        const pilotHtml = `
            <div style="padding:7px 10px;border-bottom:1px solid rgba(255,255,255,0.10);background:${full ? 'rgba(120,90,200,0.20)' : 'rgba(20,120,180,0.18)'};display:flex;align-items:center;gap:8px">
                <div style="flex:1;min-width:0">
                    <div style="color:${full ? '#cdbcff' : '#7fd4ff'};font-weight:600">${modeLabel} mode</div>
                    <div style="font-size:10px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sub}</div>
                </div>
                ${pending ? `<button data-reload-mode title="Reload to apply the resolved mode" style="cursor:pointer;font-size:11px;font-weight:700;padding:3px 10px;border-radius:4px;border:1px solid #ffd591;background:rgba(173,104,0,0.25);color:#ffd591">reload</button>` : ''}
                ${isCsmUser() ? `<button data-mode-toggle title="Switch between Full (CSM) and Lite (what regs/pilots see). Reloads to apply." style="cursor:pointer;font-size:11px;font-weight:700;padding:3px 12px;border-radius:4px;border:1px solid ${full ? '#cdbcff' : 'rgba(255,255,255,0.25)'};background:${full ? 'rgba(120,90,200,0.30)' : 'rgba(255,255,255,0.06)'};color:${full ? '#e6dcff' : '#bbb'}">${full ? 'Full' : 'Lite'}</button>` : ''}
            </div>
        `;

        // Layout order: header, mode banner, error, sections, then PAT at the
        // bottom. PAT is a config item that the user only touches occasionally —
        // putting it at the bottom keeps active controls front-and-center.
        state.panelEl.innerHTML = headerHtml + pilotHtml + errorHtml + emptyHtml + sectionsHtml + tokenHtml;
        wireTokenSection();
        // NOTE: per-element click/change listeners moved to delegated
        // handlers in createPanel() — see panel.addEventListener calls
        // there. Per-render attachment had a race where clicks landing on
        // freshly-recreated controls could miss their listener.
    }

    // ============================================================
    // 8. INIT
    // ============================================================
    function init() {
        loadPrefs();
        // Token status starts as 'missing' if nothing's saved, otherwise
        // 'unknown' — the UI shows "Saved (untested)" until the user
        // clicks Test (or another script reports success/failure).
        state.tokenStatus = getToken() ? 'unknown' : 'missing';
        setupChannel();
        // v1.31 — if a token is already cached, resolve CSM status now so the
        // mode is fresh for the NEXT reload (guards read aim-mode at init).
        if (getToken()) resolveMode();
        installHotkeyRouter();
        installScopeWatcher();
        const start = () => {
            // .map-tools only ever exists in the iframe context where
            // Percepto mounts its Leaflet map. The TOP-frame instance of
            // the Control Panel stays alive for BroadcastChannel routing,
            // hotkey handling, and shared GM storage — but should NOT try
            // to inject the gear button there (was spamming the console
            // with 60 retry stack traces over 30s, all guaranteed to fail).
            if (IS_TOP) {
                console.log(`${TAG} skipping button injection in TOP frame (map is in iframe)`);
            } else {
                ensureButton();
            }
            requestRegistrations();
        };
        if (document.body) start();
        else document.addEventListener('DOMContentLoaded', start, { once: true });
        console.log(`${TAG} ready`);
    }

    init();
})();
