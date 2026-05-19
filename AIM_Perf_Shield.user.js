// ==UserScript==
// @name         AIM Performance Shield
// @namespace    http://tampermonkey.net/
// @version      1.0
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
        /rrweb/i,
        /\/session-replay\//i,
        /sr\.amplitude\.com/i, // session-replay-specific upload endpoint
    ];

    function shouldBlock(url) {
        if (!enabled) return false;
        if (!url) return false;
        const s = typeof url === 'string' ? url : (url.url || String(url));
        return BLOCK_PATTERNS.some(p => p.test(s));
    }

    if (enabled) installBlockers();
    setupControlPanel(); // register either way so the toggle is visible
    registerWithControlPanel();

    if (enabled) console.log(`${TAG} active — blocking session-replay traffic`);
    else console.log(`${TAG} disabled by user — all traffic passing through`);

    // --- BLOCKERS (only installed when enabled) ---
    function installBlockers() {
        installScriptTagBlocker();
        installFetchBlocker();
        installXHRBlocker();
        installSendBeaconBlocker();
    }

    // 1. Catch <script> tags being inserted into the DOM and remove them
    //    BEFORE the browser executes them. This is the most effective
    //    block — if the plugin script never runs, it can't record anything.
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
        try {
            const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const origFetch = win.fetch;
            if (typeof origFetch !== 'function') return;
            win.fetch = function(...args) {
                if (shouldBlock(args[0])) {
                    return Promise.resolve(new Response('', { status: 204, statusText: 'Blocked by AIM Shield' }));
                }
                return origFetch.apply(this, args);
            };
        } catch (e) { console.warn(`${TAG} fetch override failed:`, e); }
    }

    // 3. Override XMLHttpRequest — same rationale as fetch.
    function installXHRBlocker() {
        try {
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
        } catch (e) { console.warn(`${TAG} XHR override failed:`, e); }
    }

    // 4. Override sendBeacon — analytics commonly use this for the final
    //    upload on page unload.
    function installSendBeaconBlocker() {
        try {
            const origBeacon = navigator.sendBeacon;
            if (typeof origBeacon !== 'function') return;
            navigator.sendBeacon = function(url, data) {
                if (shouldBlock(url)) return true; // pretend success
                return origBeacon.call(navigator, url, data);
            };
        } catch (e) { console.warn(`${TAG} sendBeacon override failed:`, e); }
    }

    // --- AIM Control Panel registration ---
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-perf-shield';
    const SCRIPT_VERSION = '1.0';
    let controlChannel = null;

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
                    console.log(`${TAG} ${newVal ? 'ENABLED' : 'DISABLED'} — reload the page for the change to take effect (in-flight recorder code keeps running until reload).`);
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
