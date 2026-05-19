// ==UserScript==
// @name         AIM Performance Shield
// @namespace    http://tampermonkey.net/
// @version      1.6
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Perf_Shield.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Perf_Shield.user.js
// @description  AIM Performance section. Bundles surgical network blocks for stuff site builders don't need: session-replay recorder (default ON — major leak source), weather API (default OFF — useful only to pilots), Intercom chat widget (default OFF). Plus an in-map "hide satellite base tiles" toggle (default OFF — for when your ortho already covers the site).
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// Why this script exists:
// A Performance trace on a dense site showed:
//   - JS heap growing 200MB in 30s
//   - DOM nodes doubling (640K → 1.25M) in 30s
//   - Event listeners growing 75K → 96K
//   - Amplitude session-replay plugin consuming ~8.3s of 31s CPU time
// The session-replay plugin uses rrweb to record every DOM mutation for
// later playback. On a site that's constantly mutating (Leaflet overlays,
// our wipe&rebuild cycle, Percepto's React), the replay buffer grows
// unbounded — making the site progressively slower the longer it's open.
// Blocking JUST that plugin (not all analytics) recovers all of the
// above with negligible product-side impact.

(function() {
    'use strict';

    const TAG = '[AIM PERF SHIELD]';

    // Each block category is a peer toggle. The install* hooks (fetch/XHR/script-tag
    // overrides) are installed unconditionally below — they're cheap when no
    // category matches the URL — so toggling any single category on or off
    // takes effect immediately for FUTURE network calls. Existing in-flight
    // code (especially the session-replay recorder) keeps running until reload.
    //
    // Adding a new block category: append to BLOCK_GROUPS, add a corresponding
    // toggle in registerWithControlPanel(), handle the toggleId in setupControlPanel().
    const BLOCK_GROUPS = {
        'session-replay': {
            storageKey: 'aim-perf-shield-enabled',
            defaultEnabled: true,
            patterns: [
                /plugin-session-replay-browser/i,
                /session.?replay/i,
                /rrweb/i,
                /sr\.amplitude\.com/i,
            ],
        },
        'block-weather': {
            storageKey: 'aim-perf-block-weather',
            defaultEnabled: false,
            patterns: [
                /\/weather_for_indication\//i,
            ],
        },
        'block-intercom': {
            storageKey: 'aim-perf-block-intercom',
            defaultEnabled: false,
            patterns: [
                /intercom\.io/i,
                /intercomcdn\.com/i,
                /intercomassets\.com/i,
                /widget\.intercom/i,
                // Zendesk Web Widget — Percepto's actual chat vendor
                // (confirmed by the iframe#launcher + data-garden-id="..."
                // attributes on the bubble element).
                /zdassets\.com/i,
                /zopim\.com/i,
                /zendesk\.com/i,
            ],
        },
    };

    // Live enabled-state per group, read from GM storage with defaults.
    const blockEnabled = {};
    Object.keys(BLOCK_GROUPS).forEach(id => {
        const g = BLOCK_GROUPS[id];
        try { blockEnabled[id] = GM_getValue(g.storageKey, g.defaultEnabled) === true; }
        catch (e) { blockEnabled[id] = g.defaultEnabled; }
    });

    // Hide-satellite isn't a network block — it's a Map Styler instruction —
    // but lives here so all perf toggles are in one panel section. Broadcast
    // via PERF_TOGGLE; Map Styler mirrors and acts on it.
    const STORAGE_KEY_HIDE_SAT = 'aim-perf-shield-hide-satellite';
    let hideSatellite = false;
    try { hideSatellite = GM_getValue(STORAGE_KEY_HIDE_SAT, false) === true; } catch (e) {}

    // Chat-bubble CSS-hide config. Declared up here (NOT inside the function
    // section below) because the init block calls applyChatBlockCss() before
    // those function-section declarations are evaluated — function
    // declarations hoist but `const` doesn't, so referencing them from a
    // hoisted function at init time throws TDZ. Targets stable Zendesk /
    // Intercom attributes; generated styled-components classes change on
    // every host-app build so we avoid those.
    const CHAT_BLOCK_STYLE_ID = 'aim-perf-chat-block-css';
    const CHAT_BLOCK_CSS = `
        /* Zendesk Web Widget */
        iframe#launcher,
        iframe[title*="messaging window" i],
        iframe[title*="Messaging Window" i],
        button[aria-label="Open messaging window" i],
        /* Intercom */
        iframe[name^="intercom-"],
        div.intercom-lightweight-app,
        div.intercom-launcher-frame,
        div#intercom-container {
            display: none !important;
        }
    `;

    function shouldBlock(url) {
        if (!url) return false;
        const s = typeof url === 'string' ? url : (url.url || String(url));
        for (const id of Object.keys(BLOCK_GROUPS)) {
            if (!blockEnabled[id]) continue;
            const g = BLOCK_GROUPS[id];
            if (g.patterns.some(p => p.test(s))) return true;
        }
        return false;
    }

    // Control Panel state declared early so the registration functions
    // can read it without hitting TDZ (was a v1.0 bug — `controlChannel`
    // declared at the bottom but referenced from the top crashed init).
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-perf-shield';
    const SCRIPT_VERSION = '1.6';
    // Tracks the last-applied per-group state so we only log on real changes.
    // The Control Panel echoes SET_TOGGLE for every toggle on REGISTER, which
    // without this dedup would log a reload-reminder line per toggle per
    // panel open.
    const lastNotified = Object.assign({}, blockEnabled);
    let controlChannel = null;

    // Install all network/script overrides UNCONDITIONALLY so any block
    // category can take effect without needing the session-replay master ON.
    // Each call is try/wrapped so one failure doesn't take down the rest
    // (and especially doesn't prevent control panel registration).
    try { installScriptSrcSetterOverride(); } catch (e) { console.warn(`${TAG} src setter override failed:`, e); }
    try { installScriptTagBlocker(); } catch (e) { console.warn(`${TAG} tag blocker failed:`, e); }
    try { installFetchBlocker(); } catch (e) { console.warn(`${TAG} fetch blocker failed:`, e); }
    try { installXHRBlocker(); } catch (e) { console.warn(`${TAG} XHR blocker failed:`, e); }
    try { installSendBeaconBlocker(); } catch (e) { console.warn(`${TAG} beacon blocker failed:`, e); }
    // CSS-hide for chat bubbles. Network blocks alone can't remove an
    // already-rendered bubble — apply now so any pre-loaded launcher
    // disappears immediately.
    try { applyChatBlockCss(blockEnabled['block-intercom']); } catch (e) { console.warn(`${TAG} chat CSS apply failed:`, e); }
    try { setupControlPanel(); } catch (e) { console.warn(`${TAG} panel setup failed:`, e); }
    try { registerWithControlPanel(); } catch (e) { console.warn(`${TAG} panel reg failed:`, e); }

    const activeBlocks = Object.keys(blockEnabled).filter(k => blockEnabled[k]);
    console.log(`${TAG} v${SCRIPT_VERSION} ready — active blocks: ${activeBlocks.length ? activeBlocks.join(', ') : 'none'}`);
    if (hideSatellite) console.log(`${TAG} hide-satellite ON — broadcasting to Map Styler`);

    // 0. Override HTMLScriptElement.prototype.src setter — fires BEFORE
    //    the browser starts loading when JS sets `script.src = 'url'`.
    //    More reliable than MutationObserver, which fires AFTER append
    //    (the browser may have already started loading by then).
    function installScriptSrcSetterOverride() {
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const proto = win.HTMLScriptElement && win.HTMLScriptElement.prototype;
        if (!proto) return;
        const desc = Object.getOwnPropertyDescriptor(proto, 'src');
        if (!desc || !desc.set || !desc.get) return;
        const origGet = desc.get, origSet = desc.set;
        Object.defineProperty(proto, 'src', {
            configurable: true,
            enumerable: true,
            get() { return origGet.call(this); },
            set(value) {
                if (shouldBlock(value)) {
                    console.log(`${TAG} blocked script.src=: ${value}`);
                    return origSet.call(this, 'data:text/plain,');
                }
                return origSet.call(this, value);
            },
        });
        // Also intercept setAttribute('src', ...)
        const origSetAttr = proto.setAttribute;
        proto.setAttribute = function(name, value) {
            if (name && name.toLowerCase() === 'src' && shouldBlock(value)) {
                console.log(`${TAG} blocked script.setAttribute(src): ${value}`);
                return origSetAttr.call(this, name, 'data:text/plain,');
            }
            return origSetAttr.call(this, name, value);
        };
    }

    // 1. Catch <script> tags being inserted into the DOM and remove them
    //    BEFORE the browser executes them. Defense-in-depth alongside the
    //    src setter override above.
    let removed = 0;
    function installScriptTagBlocker() {
        const setupObserver = () => {
            const obs = new MutationObserver((mutations) => {
                for (const mut of mutations) {
                    for (const node of mut.addedNodes) {
                        if (node.tagName === 'SCRIPT' && node.src && shouldBlock(node.src)) {
                            const wasSrc = node.src;
                            node.type = 'javascript/blocked'; // prevent execution
                            node.src = 'data:text/plain,';
                            try { node.remove(); } catch (e) {}
                            removed++;
                            console.log(`${TAG} blocked script #${removed}: ${wasSrc}`);
                        }
                    }
                }
            });
            // documentElement may not exist yet if we run very early
            const root = document.documentElement || document.body || document;
            obs.observe(root, { childList: true, subtree: true });
        };
        if (document.documentElement) setupObserver();
        else document.addEventListener('readystatechange', setupObserver, { once: true });
    }

    // 2. Override fetch — catches network calls if the recorder script
    //    somehow loaded before we did (defense in depth).
    function installFetchBlocker() {
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const origFetch = win.fetch;
        if (typeof origFetch !== 'function') return;
        win.fetch = function(...args) {
            if (shouldBlock(args[0])) {
                // Per Fetch spec: 204/205/304 are "null body status" codes
                // and the Response constructor THROWS if body is a non-null
                // value with those statuses. Use null. (v1.0 used '' here
                // which threw on every blocked call.)
                return Promise.resolve(new Response(null, { status: 204, statusText: 'Blocked by AIM' }));
            }
            return origFetch.apply(this, args);
        };
    }

    // 3. Override XMLHttpRequest — same rationale as fetch.
    function installXHRBlocker() {
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const OXHR = win.XMLHttpRequest;
        if (typeof OXHR !== 'function') return;
        const Patched = function() {
            const xhr = new OXHR();
            const origOpen = xhr.open;
            const origSend = xhr.send;
            let isBlocked = false;
            xhr.open = function(method, url, ...rest) {
                if (shouldBlock(url)) {
                    isBlocked = true;
                    return origOpen.call(xhr, method, 'data:text/plain,', ...rest);
                }
                return origOpen.call(xhr, method, url, ...rest);
            };
            xhr.send = function(body) {
                if (isBlocked) return; // no-op (browser already opened a data: URL)
                return origSend.call(xhr, body);
            };
            return xhr;
        };
        Patched.prototype = OXHR.prototype;
        win.XMLHttpRequest = Patched;
    }

    // 4. Override sendBeacon — analytics commonly use this for the final
    //    upload on page unload.
    function installSendBeaconBlocker() {
        const origBeacon = navigator.sendBeacon;
        if (typeof origBeacon !== 'function') return;
        navigator.sendBeacon = function(url, data) {
            if (shouldBlock(url)) return true; // pretend success
            return origBeacon.call(navigator, url, data);
        };
    }

    function applyChatBlockCss(on) {
        if (on) {
            if (document.getElementById(CHAT_BLOCK_STYLE_ID)) return;
            const style = document.createElement('style');
            style.id = CHAT_BLOCK_STYLE_ID;
            style.textContent = CHAT_BLOCK_CSS;
            // documentElement is available at document-start; head may not be yet.
            (document.head || document.documentElement).appendChild(style);
        } else {
            const el = document.getElementById(CHAT_BLOCK_STYLE_ID);
            if (el) el.remove();
        }
    }

    // Push current Perf Shield toggle state out to anyone listening (currently
    // just Map Styler, which mirrors `hide-satellite`). Called on init, on
    // toggle change, and in response to REQUEST_PERF_SETTINGS.
    function broadcastPerfSettings() {
        if (!controlChannel) return;
        controlChannel.postMessage({ type: 'PERF_TOGGLE', key: 'hide-satellite', value: hideSatellite });
    }

    // The panel uses toggleId='master' to signal the script's primary
    // on/off. We map 'master' → 'session-replay' here so the rest of the
    // file stays consistent with the BLOCK_GROUPS keys.
    function toggleIdToGroup(toggleId) {
        return toggleId === 'master' ? 'session-replay' : toggleId;
    }

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') {
                registerWithControlPanel();
                broadcastPerfSettings();
            } else if (msg.type === 'REQUEST_PERF_SETTINGS') {
                broadcastPerfSettings();
            } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                const newVal = !!(msg.value !== undefined ? msg.value : msg.enabled);
                if (msg.toggleId === 'hide-satellite') {
                    if (newVal !== hideSatellite) {
                        hideSatellite = newVal;
                        try { GM_setValue(STORAGE_KEY_HIDE_SAT, newVal); } catch (e) {}
                        console.log(`${TAG} hide-satellite ${newVal ? 'ON' : 'OFF'}`);
                    }
                    broadcastPerfSettings();
                    return;
                }
                const groupId = toggleIdToGroup(msg.toggleId);
                const group = BLOCK_GROUPS[groupId];
                if (!group) return;
                blockEnabled[groupId] = newVal;
                try { GM_setValue(group.storageKey, newVal); } catch (e) {}
                // Chat block also needs the CSS hide applied/removed instantly
                // — script-blocking alone can't undo an already-rendered bubble.
                if (groupId === 'block-intercom') {
                    try { applyChatBlockCss(newVal); } catch (e) {}
                }
                if (newVal !== lastNotified[groupId]) {
                    lastNotified[groupId] = newVal;
                    const reloadHint = groupId === 'session-replay'
                        ? ' — reload the page for the change to take effect (in-flight recorder code keeps running until reload).'
                        : ' — takes effect on the next matching network call.';
                    console.log(`${TAG} ${groupId} ${newVal ? 'ENABLED' : 'DISABLED'}${reloadHint}`);
                }
            }
        };
        // Replay state to any scripts already listening (e.g. Map Styler).
        broadcastPerfSettings();
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Performance',
            description: 'Network-level blocks for stuff site builders don\'t need (weather, replay, chat) + map perf toggles',
            version: SCRIPT_VERSION,
            toggles: [
                {
                    id: 'master',
                    label: 'Block session-replay recorder (reload page after toggle)',
                    type: 'boolean',
                    default: BLOCK_GROUPS['session-replay'].defaultEnabled,
                    master: true,
                },
                {
                    id: 'hide-satellite',
                    label: 'Hide satellite base tiles (use when ortho covers site)',
                    type: 'boolean',
                    default: false,
                },
                {
                    id: 'block-weather',
                    label: 'Block weather API (Percepto /weather_for_indication/)',
                    type: 'boolean',
                    default: BLOCK_GROUPS['block-weather'].defaultEnabled,
                },
                {
                    id: 'block-intercom',
                    label: 'Block chat widget (Zendesk + Intercom)',
                    type: 'boolean',
                    default: BLOCK_GROUPS['block-intercom'].defaultEnabled,
                },
            ],
            hotkeys: [],
        });
    }
})();
