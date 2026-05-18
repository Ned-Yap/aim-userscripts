// ==UserScript==
// @name         AIM Control Panel
// @namespace    http://tampermonkey.net/
// @version      1.14
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Control_Panel.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Control_Panel.js
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
    const VERSION = '1.14';
    const IS_TOP = window === window.top;
    const TAG = `[AIM CONTROL ${IS_TOP ? 'TOP' : 'IF'}]`;
    const CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const PREFS_KEY = 'aim-control-prefs';
    const HOTKEYS_KEY = 'aim-control-hotkeys';
    const TOKEN_KEY = 'aim-github-token';
    const KMLS_REPO = 'Ned-Yap/aim-userscripts-data';
    const KMLS_BRANCH = 'main';
    const INJECT_RETRY_MS = 500;
    const INJECT_MAX_TRIES = 60; // 30s of retries then give up

    // ============================================================
    // 2. STATE
    // ============================================================
    const state = {
        channel: null,
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
            const v = msg.value !== undefined ? msg.value : msg.enabled;
            setToggle(msg.scriptId, msg.toggleId, v);
            if (state.panelOpen) renderPanel();
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

    function handleRegister(msg) {
        if (!msg.scriptId) return;
        state.registry.set(msg.scriptId, { ...msg, lastSeen: Date.now() });
        // Echo back the current value for each registered setting. Carries
        // both `value` (typed) and `enabled` (bool) — scripts can read whichever
        // they're built for. Saves each script from doing its own localStorage.
        if (Array.isArray(msg.toggles) && state.channel) {
            flattenToggles(msg.toggles).forEach(t => {
                const value = getToggle(msg.scriptId, t.id, t.default);
                state.channel.postMessage({
                    type: 'SET_TOGGLE',
                    scriptId: msg.scriptId, toggleId: t.id,
                    value, enabled: !!value,
                });
            });
        }
        if (state.panelOpen) renderPanel();
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

    function inputGuard(e) {
        const el = e.target;
        if (!el) return false;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
        if (el.isContentEditable) return true;
        if (el.closest && (el.closest('.ant-input') || el.closest('.ant-select'))) return true;
        if (el.getAttribute && el.getAttribute('role') === 'textbox') return true;
        return false;
    }

    function installHotkeyRouter() {
        window.addEventListener('keydown', (e) => {
            // Rebinding capture takes priority — when the user is binding a key,
            // their next keypress IS the binding. Don't route to scripts.
            if (state.rebindingFor) {
                e.preventDefault(); e.stopPropagation();
                if (e.key === 'Escape') {
                    state.rebindingFor = null;
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
                    setHotkey(scriptId, hotkeyId, combo);
                    state.rebindingFor = null;
                    renderPanel();
                }
                return;
            }
            if (inputGuard(e)) return;
            // Route to any registered script whose hotkey matches.
            for (const [scriptId, script] of state.registry) {
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

    function injectButton() {
        const tools = findToolsBar();
        if (!tools) return false;
        if (state.buttonEl && tools.contains(state.buttonEl)) return true;
        // Match the existing .map-tools__button look. Use the same classes
        // the host app's other tools use so styling comes for free.
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="ant-dropdown-trigger map-tools__button pr-dropdown aim-control-button"
                 title="AIM Controls"
                 style="cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;user-select:none">
                <span style="font-size:18px;line-height:1;color:#e6e6e6">⚙</span>
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
            'position:absolute', 'top:calc(100% + 6px)', 'right:0',
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
    }

    function setPanelOpen(open) {
        if (!state.panelEl) createPanel();
        state.panelOpen = open;
        state.panelEl.style.display = open ? 'block' : 'none';
        if (open) {
            requestRegistrations();
            renderPanel();
        } else {
            // Cancel any in-progress rebind
            state.rebindingFor = null;
        }
    }

    function togglePanel() { setPanelOpen(!state.panelOpen); }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
    }
    function escapeAttr(s) { return escapeHtml(s); }

    // Renders one control row based on the toggle's type. Supported types:
    // Renders the GitHub PAT section that sits between the panel header and
    // the per-script controls. The actual token is never rendered to the DOM
    // — once saved, we show only a masked indicator (••••) and the status.
    function renderTokenSection() {
        const hasToken = !!getToken();
        const status = state.tokenStatus;
        let pillColor = '#888', pillText = 'Not configured';
        if (status === 'valid') { pillColor = '#5fff5f'; pillText = '✓ Valid'; }
        else if (status === 'invalid') { pillColor = '#ff6060'; pillText = '✗ Invalid'; }
        else if (status === 'testing') { pillColor = '#ffd591'; pillText = 'Testing…'; }
        else if (status === 'error') { pillColor = '#ff8c00'; pillText = '⚠ Error'; }
        else if (status === 'missing') { pillColor = '#888'; pillText = 'Not configured'; }
        else if (hasToken) { pillText = 'Saved (untested)'; pillColor = '#bbb'; }

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
            <div style="border-bottom:1px solid rgba(255,255,255,0.10);background:rgba(255,255,255,0.02)">
                <div style="padding:6px 10px 2px;display:flex;align-items:center;justify-content:space-between">
                    <span style="color:#e6e6e6;font-weight:600;font-size:12px">GitHub PAT <span style="color:#888;font-weight:400">(shielding KMLs)</span></span>
                    <span style="font-size:10px;color:${pillColor};font-weight:600">${escapeHtml(pillText)}</span>
                </div>
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
                testToken(val, (status, msg) => setStatus(status, msg));
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
    function renderControl(scriptId, t) {
        if (!t) return '';
        const type = t.type || 'boolean';
        const value = getToggle(scriptId, t.id, t.default);

        if (type === 'category') {
            // Header row: optional master checkbox + label + meta + expand arrow.
            // Clicking the checkbox toggles its boolean; clicking anywhere else
            // on the row expands/collapses the body.
            const expandKey = `cat:${scriptId}:${t.id}`;
            const expanded = state.expanded && state.expanded[expandKey];
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
            const expanded = state.expanded && state.expanded[expandKey];
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
                <span>${escapeHtml(t.label || t.id)}</span>
            </label>
        `;
    }

    function renderPanel() {
        if (!state.panelEl || !state.panelOpen) return;
        const scripts = Array.from(state.registry.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const headerHtml = `
            <div style="padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.10);display:flex;align-items:center;justify-content:space-between;background:rgb(28,28,28);border-radius:6px 6px 0 0;position:sticky;top:0;z-index:2">
                <strong style="color:rgb(20,210,220)">AIM Controls</strong>
                <span style="font-size:11px;color:#888">${scripts.length} script${scripts.length === 1 ? '' : 's'}</span>
            </div>
        `;

        const tokenHtml = renderTokenSection();

        const emptyHtml = scripts.length === 0 ? `
            <div style="padding:20px 16px;text-align:center;color:#888">
                <div style="margin-bottom:6px">No AIM scripts registered yet.</div>
                <small>Scripts auto-register on load. Try reloading the page.</small>
            </div>
        ` : '';

        const renderScriptBody = (script) => {
            const toggles = Array.isArray(script.toggles) ? script.toggles : [];
            const hotkeys = Array.isArray(script.hotkeys) ? script.hotkeys : [];

            const togglesHtml = toggles.map(t => renderControl(script.scriptId, t)).join('')
                || (hotkeys.length ? '' : `<div style="padding:3px 10px;color:#888;font-style:italic">no toggles exposed</div>`);

            const hotkeysHtml = hotkeys.map(hk => {
                const bound = getHotkey(script.scriptId, hk.id, hk.default);
                const isBindingThis = state.rebindingFor && state.rebindingFor.scriptId === script.scriptId && state.rebindingFor.hotkeyId === hk.id;
                const chipStyle = isBindingThis
                    ? 'background:rgba(173,104,0,0.20);border:1px solid #ffd591;color:#ffd591'
                    : 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);color:#e6e6e6';
                const chipText = isBindingThis ? 'press a key… (Esc to cancel)' : (bound || '— unbound —');
                const isCustom = bound && bound !== hk.default;
                return `
                    <div style="display:flex;align-items:center;gap:8px;padding:3px 10px">
                        <span style="flex:1;color:#bbb">${escapeHtml(hk.label || hk.id)}</span>
                        <button data-rebind data-script="${escapeAttr(script.scriptId)}" data-hotkey="${escapeAttr(hk.id)}"
                                style="font-family:ui-monospace,monospace;font-size:11px;padding:2px 8px;border-radius:3px;cursor:pointer;${chipStyle}">${escapeHtml(chipText)}</button>
                        ${isCustom ? `<button data-reset data-script="${escapeAttr(script.scriptId)}" data-hotkey="${escapeAttr(hk.id)}" style="background:transparent;border:none;color:rgb(20,210,220);cursor:pointer;font-size:11px" title="Reset to default (${escapeAttr(hk.default || '')})">↺</button>` : ''}
                    </div>
                `;
            }).join('');

            return `
                <div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.08)">
                    <div style="padding:0 10px 3px;display:flex;align-items:center;gap:6px">
                        <strong style="color:#e6e6e6">${escapeHtml(script.name || script.scriptId)}</strong>
                        <span style="color:#888;font-size:11px">v${escapeHtml(script.version || '?')}</span>
                    </div>
                    ${togglesHtml}
                    ${hotkeysHtml ? `<div style="margin-top:3px;padding:3px 0 0;border-top:1px dashed rgba(255,255,255,0.10)">${hotkeysHtml}</div>` : ''}
                </div>
            `;
        };

        // Group registered scripts by their declared `group` (if any).
        // Scripts without a group render standalone. Scripts that share a
        // group name appear inside a single collapsible header (e.g. all
        // the hotkey scripts under one "Hotkeys" section). Groups are open
        // by default; user can collapse via the chevron.
        const standalone = [];
        const groups = new Map(); // groupName -> [scripts]
        scripts.forEach(s => {
            if (s.group) {
                if (!groups.has(s.group)) groups.set(s.group, []);
                groups.get(s.group).push(s);
            } else {
                standalone.push(s);
            }
        });

        const renderGroup = (groupName, members) => {
            const expandKey = `group:${groupName}`;
            // Groups default to OPEN. Use a separate state map from categories
            // (state.groupsCollapsed) so the existing default-closed semantics
            // for categories isn't disrupted. Undefined = open, true = closed.
            const collapsed = !!(state.groupsCollapsed && state.groupsCollapsed[expandKey]);
            const bodyHtml = members.map(renderScriptBody).join('');
            return `
                <div style="border-bottom:1px solid rgba(255,255,255,0.12)">
                    <div data-grouptoggle="${escapeAttr(expandKey)}"
                         style="display:flex;align-items:center;padding:5px 10px;cursor:pointer;background:rgb(36,36,36);user-select:none">
                        <strong style="flex:1;color:rgb(20,210,220);font-size:12px">${escapeHtml(groupName)}</strong>
                        <span style="color:#888;font-size:10px;margin-right:8px">${members.length} script${members.length === 1 ? '' : 's'}</span>
                        <span style="color:#bbb;width:14px;text-align:right">${collapsed ? '▸' : '▾'}</span>
                    </div>
                    ${collapsed ? '' : `<div>${bodyHtml}</div>`}
                </div>
            `;
        };

        // Render standalone scripts first (alphabetical), then groups
        // (alphabetical by group name).
        let sectionsHtml = standalone.map(renderScriptBody).join('');
        Array.from(groups.keys()).sort().forEach(name => {
            sectionsHtml += renderGroup(name, groups.get(name));
        });

        state.panelEl.innerHTML = headerHtml + tokenHtml + emptyHtml + sectionsHtml;
        wireTokenSection();

        // Wire checkboxes (boolean controls)
        state.panelEl.querySelectorAll('input[data-control="boolean"]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                broadcastToggle(e.target.dataset.script, e.target.dataset.toggle, e.target.checked);
            });
        });
        // Wire select controls
        state.panelEl.querySelectorAll('select[data-control="select"]').forEach(sel => {
            sel.addEventListener('change', (e) => {
                let v = e.target.value;
                // Coerce numeric-looking values back to numbers so consumers
                // get the type they expect.
                if (!isNaN(parseFloat(v)) && isFinite(v)) v = parseFloat(v);
                broadcastToggle(e.target.dataset.script, e.target.dataset.toggle, v);
            });
        });
        // Wire action buttons
        state.panelEl.querySelectorAll('button[data-control="button"]').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                if (state.channel) {
                    state.channel.postMessage({
                        type: 'TRIGGER_ACTION',
                        scriptId: b.dataset.script,
                        actionId: b.dataset.action,
                    });
                }
            });
        });
        // Wire color inputs
        state.panelEl.querySelectorAll('input[data-control="color"]').forEach(inp => {
            inp.addEventListener('change', (e) => {
                broadcastToggle(e.target.dataset.script, e.target.dataset.toggle, e.target.value);
            });
        });
        // Wire number inputs (commit on change/blur, not on every keystroke)
        state.panelEl.querySelectorAll('input[data-control="number"]').forEach(inp => {
            inp.addEventListener('change', (e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v)) broadcastToggle(e.target.dataset.script, e.target.dataset.toggle, v);
            });
            // Stop hotkey router from intercepting digit keys while typing.
            inp.addEventListener('keydown', (e) => e.stopPropagation());
        });
        // Wire Advanced collapsibles
        state.panelEl.querySelectorAll('button[data-advtoggle]').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const key = b.dataset.advtoggle;
                state.expanded[key] = !state.expanded[key];
                renderPanel();
            });
        });
        // Wire category headers — expand/collapse on click, but pass through
        // clicks that landed on the master checkbox.
        state.panelEl.querySelectorAll('[data-cattoggle]').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT') return; // checkbox handles itself
                e.stopPropagation();
                const key = el.dataset.cattoggle;
                state.expanded[key] = !state.expanded[key];
                renderPanel();
            });
        });
        // Wire group headers (default OPEN, separate state map from categories)
        state.panelEl.querySelectorAll('[data-grouptoggle]').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT') return;
                e.stopPropagation();
                const key = el.dataset.grouptoggle;
                if (!state.groupsCollapsed) state.groupsCollapsed = {};
                state.groupsCollapsed[key] = !state.groupsCollapsed[key];
                renderPanel();
            });
        });
        // Wire rebind buttons
        state.panelEl.querySelectorAll('button[data-rebind]').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                state.rebindingFor = { scriptId: b.dataset.script, hotkeyId: b.dataset.hotkey };
                renderPanel();
            });
        });
        // Wire reset-to-default buttons
        state.panelEl.querySelectorAll('button[data-reset]').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                setHotkey(b.dataset.script, b.dataset.hotkey, null);
                renderPanel();
            });
        });
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
        installHotkeyRouter();
        const start = () => {
            ensureButton();
            requestRegistrations();
        };
        if (document.body) start();
        else document.addEventListener('DOMContentLoaded', start, { once: true });
        console.log(`${TAG} ready`);
    }

    init();
})();
