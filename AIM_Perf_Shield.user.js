// ==UserScript==
// @name         AIM Performance Shield
// @namespace    http://tampermonkey.net/
// @version      1.2
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Perf_Shield.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Perf_Shield.user.js
// @description  Blocks the host app's session-replay recorder. On dense sites this was leaking ~600K DOM nodes + ~200MB heap per 30s + ~30% of total CPU. Surgical: only the replay plugin is blocked, regular product analytics still flow. Toggle via AIM Controls; default ON.
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
    const STORAGE_KEY = 'aim-perf-shield-enabled';

    // Read setting from GM storage; default ON. If the user has explicitly
    // toggled it OFF via the panel, GM_setValue stored `false`, otherwise
    // we get `true` (the default).
    let enabled = true;
    try { enabled = GM_getValue(STORAGE_KEY, true) !== false; } catch (e) {}

    // Patterns we block. Surgical: only the session-replay plugin and the
    // rrweb library that underpins it. Main Amplitude analytics tracking
    // (`analytics-browser-*.js`) is NOT blocked — that's small + Percepto
    // needs it for product metrics.
    const BLOCK_PATTERNS = [
        /plugin-session-replay-browser/i,
        /session.?replay/i, // catches session-replay, session_replay, session replay
        /rrweb/i,
        /sr\.amplitude\.com/i, // session-replay-specific upload endpoint
    ];

    function shouldBlock(url) {
        if (!enabled) return false;
        if (!url) return false;
        const s = typeof url === 'string' ? url : (url.url || String(url));
        return BLOCK_PATTERNS.some(p => p.test(s));
    }

    // Control Panel state declared early so the registration functions
    // can read it without hitting TDZ (was a v1.0 bug — `controlChannel`
    // declared at the bottom but referenced from the top crashed init).
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-perf-shield';
    const SCRIPT_VERSION = '1.2';
    // Tracks the last-applied enabled state so we only log on real changes.
    // The Control Panel echoes SET_TOGGLE messages back on every REGISTER
    // (including auto-registration when the panel opens), so without this
    // we'd spam the console every time the user opens the panel.
    let lastNotifiedEnabled = enabled;
    let controlChannel = null;

    // Each install* call is try/wrapped so one failure doesn't take the
    // rest down (and ESPECIALLY doesn't prevent control panel registration).
    if (enabled) {
        try { installScriptSrcSetterOverride(); } catch (e) { console.warn(`${TAG} src setter override failed:`, e); }
        try { installScriptTagBlocker(); } catch (e) { console.warn(`${TAG} tag blocker failed:`, e); }
        try { installFetchBlocker(); } catch (e) { console.warn(`${TAG} fetch blocker failed:`, e); }
        try { installXHRBlocker(); } catch (e) { console.warn(`${TAG} XHR blocker failed:`, e); }
        try { installSendBeaconBlocker(); } catch (e) { console.warn(`${TAG} beacon blocker failed:`, e); }
    }
    try { setupControlPanel(); } catch (e) { console.warn(`${TAG} panel setup failed:`, e); }
    try { registerWithControlPanel(); } catch (e) { console.warn(`${TAG} panel reg failed:`, e); }

    if (enabled) console.log(`${TAG} v${SCRIPT_VERSION} active — blocking session-replay traffic`);
    else console.log(`${TAG} v${SCRIPT_VERSION} disabled by user — all traffic passing through`);

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

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') {
                registerWithControlPanel();
            } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                if (msg.toggleId === 'master') {
                    const newVal = !!(msg.value !== undefined ? msg.value : msg.enabled);
                    try { GM_setValue(STORAGE_KEY, newVal); } catch (e) {}
                    // Only log on actual user-driven changes — the panel echoes
                    // SET_TOGGLE on every REGISTER which would otherwise spam.
                    if (newVal !== lastNotifiedEnabled) {
                        lastNotifiedEnabled = newVal;
                        console.log(`${TAG} ${newVal ? 'ENABLED' : 'DISABLED'} — reload the page for the change to take effect (in-flight recorder code keeps running until reload).`);
                    }
                }
            }
        };
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Performance Shield',
            description: 'Blocks the host app\'s session-replay recorder (CPU + memory leak source)',
            version: SCRIPT_VERSION,
            toggles: [{
                id: 'master',
                label: 'Block session-replay (reload page after toggle)',
                type: 'boolean',
                default: true,
                master: true,
            }],
            hotkeys: [],
        });
    }
})();
