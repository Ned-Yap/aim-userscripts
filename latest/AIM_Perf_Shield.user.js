// ==UserScript==
// @name         Latest - AIM Performance Shield
// @namespace    http://tampermonkey.net/
// @version      1.13
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Perf_Shield.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Perf_Shield.user.js
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

    // Ortho low-res mode (v1.7) — moved from Map Styler so users see the
    // option alongside other performance toggles. Map Styler still owns the
    // actual tile-cap logic; we just persist the preference and broadcast it.
    const STORAGE_KEY_ORTHO_LOWRES = 'aim-perf-shield-ortho-lowres';
    const STORAGE_KEY_ORTHO_LOWRES_ZOOM = 'aim-perf-shield-ortho-lowres-zoom';
    let orthoLowRes = false;
    let orthoLowResZoom = 15;
    try { orthoLowRes = GM_getValue(STORAGE_KEY_ORTHO_LOWRES, false) === true; } catch (e) {}
    try { orthoLowResZoom = Number(GM_getValue(STORAGE_KEY_ORTHO_LOWRES_ZOOM, 15)) || 15; } catch (e) {}

    // Debug-log suppression (v1.8) — Percepto floods console.log with
    // non-actionable state-change noise (RAZTEST, WeatherStore:_calcweather,
    // STATE CHANGED Action: ..., Drone X already exists in OGI state, etc.).
    // When DevTools is open the browser pays formatting + render cost for
    // every line, which is a major perf drag on dense pages like Mission Bank.
    // This toggle wraps console.log/info/warn/debug and silently drops
    // matched lines. Default ON. Per-pattern counters at
    // window.__aim_perf_log_counts for diagnostics.
    const STORAGE_KEY_SUPPRESS_LOGS = 'aim-perf-suppress-debug-logs';
    let suppressDebugLogs = true;
    try { suppressDebugLogs = GM_getValue(STORAGE_KEY_SUPPRESS_LOGS, true) === true; } catch (e) {}

    // Mission-notification kill. Percepto's pilot toasts ("Drone took off",
    // "Snapshot taken", …) render in the TOP frame as
    // pr-notifications > .popup-notifications > .notification-item. For site
    // builders who aren't flying they're pure noise — they steal focus, block
    // button clicks, and play a chime. OFF by default; CSS hides the toast and
    // a play() patch silences the chime when ON.
    const STORAGE_KEY_KILL_NOTIFS = 'aim-perf-kill-mission-notifs';
    let killNotifs = false;
    try { killNotifs = GM_getValue(STORAGE_KEY_KILL_NOTIFS, false) === true; } catch (e) {}
    // Declared here (not next to their functions) so applyNotifBlockCss can run
    // from the init block below without a temporal-dead-zone error — same rule
    // as CHAT_BLOCK_* above. display:none also kills the focus-steal + click-
    // blocking (a hidden element captures no pointer events).
    const NOTIF_BLOCK_STYLE_ID = 'aim-perf-notif-block-css';
    const NOTIF_DOM_SELECTOR = 'pr-notifications, .popup-notifications, .notification-item';
    const NOTIF_BLOCK_CSS = `
        pr-notifications,
        .popup-notifications,
        .notification-item {
            display: none !important;
            pointer-events: none !important;
        }
    `;
    // Sound scoping: a mounting toast opens this forward window during which an
    // audio play() is treated as the chime. Keeps unrelated audio playing.
    let notifSoundWindowUntil = 0;
    const NOTIF_SOUND_WINDOW_MS = 2500;

    // Predicate list. Each entry: [name, fn(args) → boolean]. v1.10 rewrite:
    // - Patterns use regex on either args[0] OR the joined-string form so
    //   single-arg ("Drone 5 already exists in OGI") AND multi-arg
    //   (console.log("Drone", 5, "already exists...")) both match. v1.8/v1.9
    //   only handled multi-arg → most patterns missed real Percepto logs.
    // - Allow leading whitespace via ^\s* — some Percepto logs have leading
    //   spaces in args[0] which broke startsWith() checks.
    //
    // Helper: cheaply join args for joined-string regex tests. Skips
    // object serialization to avoid allocation cost on every log.
    function joinArgs(a) {
        let s = '';
        for (let i = 0; i < a.length; i++) {
            const x = a[i];
            if (typeof x === 'string') s += (s ? ' ' : '') + x;
            else if (typeof x === 'number' || typeof x === 'boolean') s += (s ? ' ' : '') + String(x);
        }
        return s;
    }
    const LOG_SUPPRESS_PATTERNS = [
        ['RAZTEST', a => typeof a[0] === 'string' && /^\s*RAZTEST\b/.test(a[0])],
        ['WeatherStore', a => typeof a[0] === 'string' && /^\s*WeatherStore:/.test(a[0])],
        ['STATE CHANGED', a => typeof a[0] === 'string' && /^\s*STATE CHANGED/.test(a[0])],
        ['Drone already exists', a => /\bDrone\s+\d+\s+already exists in OGI/.test(joinArgs(a))],
        ['Added drone to OGI', a => /\bAdded drone\s+\d+\s+to OGI state/.test(joinArgs(a))],
        ['Amplitude unexpected EOI', a => typeof a[0] === 'string' && /Amplitude Logger \[Warn\]: Unexpected end of input/.test(a[0])],
        ['Unhandled rejection {}', a => a.some(x => typeof x === 'string' && /Possibly unhandled rejection/.test(x))],
        ['no active group', a => typeof a[0] === 'string' && /^\s*no active group\s*$/.test(a[0])],
        ['in recalcWeather', a => typeof a[0] === 'string' && /^\s*in recalcWeather\s*$/.test(a[0])],
        ['in init. ids are', a => typeof a[0] === 'string' && /^\s*in init\. ids are/.test(a[0])],
        ['mapElementScope', a => typeof a[0] === 'string' && /^\s*mapElementScope scope removed/.test(a[0])],
        ['news feed', a => typeof a[0] === 'string' && /^\s*news feed:/.test(a[0])],
        ['Initializing library', a => typeof a[0] === 'string' && /^\s*Initializing library\s*$/.test(a[0])],
        ['ws.init', a => typeof a[0] === 'string' && /^\s*ws\.init called with ip:/.test(a[0])],
        ['createNewSocket', a => typeof a[0] === 'string' && /^\s*createNewSocket connecting/.test(a[0])],
    ];

    function shouldSuppressLog(args) {
        if (!args || args.length === 0) return null;
        // Hard safety rails — never filter:
        //   - Our own [AIM …] logs (we want our diagnostics through)
        //   - Anything where any arg is an actual Error object (real exceptions)
        if (typeof args[0] === 'string' && args[0].startsWith('[AIM ')) return null;
        for (let i = 0; i < args.length; i++) {
            if (args[i] instanceof Error) return null;
        }
        for (const [name, pred] of LOG_SUPPRESS_PATTERNS) {
            try { if (pred(args)) return name; } catch (e) {}
        }
        return null;
    }

    // Wrap console.log/info/warn/debug exactly once per context. Tracked
    // on unsafeWindow so the same context (TOP or IFRAME) can't double-wrap
    // — stacked wrappers would inflate per-log overhead unnecessarily.
    //
    // v1.9 fix: wrap unsafeWindow.console (the PAGE console), NOT the
    // sandboxed `console` reference. Perf Shield has @grant GM_setValue
    // → runs in Tampermonkey's sandboxed context → `console` here is a
    // SANDBOXED copy that Percepto never uses. Percepto's console.log
    // calls go to the page console (unsafeWindow.console). v1.8 wrapped
    // the sandboxed copy and silently filtered nothing.
    //
    // Cross-check: every OTHER override in this file (fetch, XHR,
    // script.src, sendBeacon) already uses unsafeWindow correctly —
    // this was a v1.8-only regression on the new suppressor.
    function installLogSuppressor() {
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const pageConsole = win.console;
        if (!pageConsole) return;
        if (win.__aim_perf_console_patched) return;
        win.__aim_perf_console_patched = true;
        win.__aim_perf_log_counts = win.__aim_perf_log_counts || {};
        ['log', 'info', 'warn', 'debug'].forEach(m => {
            const orig = pageConsole[m];
            if (typeof orig !== 'function') return;
            pageConsole[m] = function (...args) {
                if (suppressDebugLogs) {
                    const matched = shouldSuppressLog(args);
                    if (matched) {
                        win.__aim_perf_log_counts[matched] = (win.__aim_perf_log_counts[matched] || 0) + 1;
                        return; // silently drop
                    }
                }
                return orig.apply(pageConsole, args);
            };
        });
    }

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
    const SCRIPT_VERSION = '1.13';
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
    // Install the log suppressor FIRST so its early init can quiet the
    // network-blocker logs below if you don't want them either (they're
    // not in the pattern list so they still come through — but the wrap
    // is in place for everything that follows).
    try { installLogSuppressor(); } catch (e) { console.warn(`${TAG} log suppressor failed:`, e); }
    try { installScriptSrcSetterOverride(); } catch (e) { console.warn(`${TAG} src setter override failed:`, e); }
    try { installScriptTagBlocker(); } catch (e) { console.warn(`${TAG} tag blocker failed:`, e); }
    try { installFetchBlocker(); } catch (e) { console.warn(`${TAG} fetch blocker failed:`, e); }
    try { installXHRBlocker(); } catch (e) { console.warn(`${TAG} XHR blocker failed:`, e); }
    try { installSendBeaconBlocker(); } catch (e) { console.warn(`${TAG} beacon blocker failed:`, e); }
    // CSS-hide for chat bubbles. Network blocks alone can't remove an
    // already-rendered bubble — apply now so any pre-loaded launcher
    // disappears immediately.
    try { applyChatBlockCss(blockEnabled['block-intercom']); } catch (e) { console.warn(`${TAG} chat CSS apply failed:`, e); }
    // Mission-notification kill — apply the CSS hide immediately (so a toast
    // already on screen at load disappears) and install the chime suppressor.
    try { applyNotifBlockCss(killNotifs); } catch (e) { console.warn(`${TAG} notif CSS apply failed:`, e); }
    try { installNotifObserver(); } catch (e) { console.warn(`${TAG} notif observer failed:`, e); }
    try { installNotifSoundSuppressor(); } catch (e) { console.warn(`${TAG} notif sound suppressor failed:`, e); }
    try { setupControlPanel(); } catch (e) { console.warn(`${TAG} panel setup failed:`, e); }
    try { registerWithControlPanel(); } catch (e) { console.warn(`${TAG} panel reg failed:`, e); }

    const activeBlocks = Object.keys(blockEnabled).filter(k => blockEnabled[k]);
    console.log(`${TAG} v${SCRIPT_VERSION} ready — active blocks: ${activeBlocks.length ? activeBlocks.join(', ') : 'none'}`);
    if (hideSatellite) console.log(`${TAG} hide-satellite ON — broadcasting to Map Styler`);
    if (orthoLowRes) console.log(`${TAG} ortho low-res ON (cap zoom ${orthoLowResZoom}) — broadcasting to Map Styler`);
    if (suppressDebugLogs) console.log(`${TAG} log suppressor ON — Percepto debug spam filtered (counts at window.__aim_perf_log_counts)`);

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

    // ---- Mission-notification kill (visual + sound) ----
    // NOTE: NOTIF_BLOCK_STYLE_ID / NOTIF_BLOCK_CSS / sound-scoping state are
    // declared up top (near killNotifs) so applyNotifBlockCss can run from the
    // init block without hitting a temporal-dead-zone error. See the
    // perf-shield-TDZ rule. The functions below are hoisted so their position
    // doesn't matter.
    function applyNotifBlockCss(on) {
        if (on) {
            if (document.getElementById(NOTIF_BLOCK_STYLE_ID)) return;
            const style = document.createElement('style');
            style.id = NOTIF_BLOCK_STYLE_ID;
            style.textContent = NOTIF_BLOCK_CSS;
            (document.head || document.documentElement).appendChild(style);
        } else {
            const el = document.getElementById(NOTIF_BLOCK_STYLE_ID);
            if (el) el.remove();
        }
    }
    // Watch for mission-toast insertions. When one mounts, open a short
    // suppression window so the chime that fires on mount is muted WITHOUT
    // muting the user's other audio. Cheap — only reacts to added nodes that
    // match the notification selector. Installed once; gated on killNotifs.
    let notifObserverInstalled = false;
    function installNotifObserver() {
        if (notifObserverInstalled) return;
        const setup = () => {
            const obs = new MutationObserver((muts) => {
                if (!killNotifs) return;
                for (const m of muts) {
                    for (const node of m.addedNodes) {
                        if (!node || node.nodeType !== 1) continue;
                        const isNotif = (node.matches && node.matches(NOTIF_DOM_SELECTOR)) ||
                                        (node.querySelector && node.querySelector(NOTIF_DOM_SELECTOR));
                        if (isNotif) { notifSoundWindowUntil = Date.now() + NOTIF_SOUND_WINDOW_MS; return; }
                    }
                }
            });
            const root = document.documentElement || document.body || document;
            obs.observe(root, { childList: true, subtree: true });
        };
        if (document.documentElement) setup();
        else document.addEventListener('readystatechange', setup, { once: true });
        notifObserverInstalled = true;
    }
    // Is this play() the notification chime (vs. audio the user wants)? True if:
    //  (a) we're inside the post-toast window the observer opened, OR
    //  (b) a notification node is currently in the DOM (covers a chime that
    //      plays synchronously in the same tick the toast was appended, before
    //      the observer microtask runs), OR
    //  (c) the <audio> element lives inside the notification DOM subtree.
    // Otherwise the audio is unrelated and plays normally.
    function isNotifSound(el) {
        if (Date.now() < notifSoundWindowUntil) return true;
        try { if (document.querySelector(NOTIF_DOM_SELECTOR)) return true; } catch (e) {}
        try { if (el && el.closest && el.closest(NOTIF_DOM_SELECTOR)) return true; } catch (e) {}
        return false;
    }
    // Patch HTMLAudioElement.play once. Suppress ONLY when killNotifs is on AND
    // isNotifSound() says this play coincides with a toast. Returns a resolved
    // promise to honor play()'s contract so Percepto's caller doesn't throw.
    function installNotifSoundSuppressor() {
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const proto = win.HTMLAudioElement && win.HTMLAudioElement.prototype;
        if (!proto || proto.__aim_notif_play_patched) return;
        const origPlay = proto.play;
        proto.play = function() {
            if (killNotifs && isNotifSound(this)) {
                try { this.muted = true; this.pause(); } catch (e) {}
                return Promise.resolve();
            }
            return origPlay.apply(this, arguments);
        };
        proto.__aim_notif_play_patched = true;
    }

    // Push current Perf Shield toggle state out to anyone listening (currently
    // just Map Styler, which mirrors `hide-satellite`). Called on init, on
    // toggle change, and in response to REQUEST_PERF_SETTINGS.
    function broadcastPerfSettings() {
        if (!controlChannel) return;
        controlChannel.postMessage({ type: 'PERF_TOGGLE', key: 'hide-satellite', value: hideSatellite });
        controlChannel.postMessage({ type: 'PERF_TOGGLE', key: 'ortho-lowres', value: orthoLowRes });
        controlChannel.postMessage({ type: 'PERF_TOGGLE', key: 'ortho-lowres-zoom', value: orthoLowResZoom });
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
                const rawVal = msg.value !== undefined ? msg.value : msg.enabled;
                const newVal = !!rawVal;
                if (msg.toggleId === 'hide-satellite') {
                    if (newVal === hideSatellite) return; // IDEMPOTENT no-op
                    hideSatellite = newVal;
                    try { GM_setValue(STORAGE_KEY_HIDE_SAT, newVal); } catch (e) {}
                    console.log(`${TAG} hide-satellite ${newVal ? 'ON' : 'OFF'}`);
                    broadcastPerfSettings();
                    return;
                }
                if (msg.toggleId === 'ortho-lowres') {
                    if (newVal === orthoLowRes) return; // IDEMPOTENT no-op
                    orthoLowRes = newVal;
                    try { GM_setValue(STORAGE_KEY_ORTHO_LOWRES, newVal); } catch (e) {}
                    console.log(`${TAG} ortho-lowres ${newVal ? 'ON' : 'OFF'}`);
                    broadcastPerfSettings();
                    return;
                }
                if (msg.toggleId === 'ortho-lowres-zoom') {
                    const n = Number(rawVal);
                    if (isNaN(n) || n === orthoLowResZoom) return; // IDEMPOTENT no-op
                    orthoLowResZoom = n;
                    try { GM_setValue(STORAGE_KEY_ORTHO_LOWRES_ZOOM, n); } catch (e) {}
                    console.log(`${TAG} ortho-lowres cap zoom = ${n}`);
                    broadcastPerfSettings();
                    return;
                }
                if (msg.toggleId === 'suppress-debug-logs') {
                    if (newVal === suppressDebugLogs) return; // IDEMPOTENT no-op
                    suppressDebugLogs = newVal;
                    try { GM_setValue(STORAGE_KEY_SUPPRESS_LOGS, newVal); } catch (e) {}
                    console.log(`${TAG} log suppressor ${newVal ? 'ON' : 'OFF'}`);
                    return;
                }
                if (msg.toggleId === 'kill-notifs') {
                    if (newVal === killNotifs) return; // IDEMPOTENT no-op
                    killNotifs = newVal;
                    try { GM_setValue(STORAGE_KEY_KILL_NOTIFS, newVal); } catch (e) {}
                    try { applyNotifBlockCss(newVal); } catch (e) {}
                    // Sound suppressor reads killNotifs live; no re-patch needed.
                    console.log(`${TAG} mission-notification kill ${newVal ? 'ON' : 'OFF'}`);
                    return;
                }
                const groupId = toggleIdToGroup(msg.toggleId);
                const group = BLOCK_GROUPS[groupId];
                if (!group) return;
                // IDEMPOTENT no-op for group toggles too — was a major
                // source of redundant work (every echoed SET_TOGGLE
                // wrote GM, applied chat CSS, etc).
                if (newVal === blockEnabled[groupId]) return;
                blockEnabled[groupId] = newVal;
                try { GM_setValue(group.storageKey, newVal); } catch (e) {}
                if (groupId === 'block-intercom') {
                    try { applyChatBlockCss(newVal); } catch (e) {}
                }
                lastNotified[groupId] = newVal;
                const reloadHint = groupId === 'session-replay'
                    ? ' — reload the page for the change to take effect (in-flight recorder code keeps running until reload).'
                    : ' — takes effect on the next matching network call.';
                console.log(`${TAG} ${groupId} ${newVal ? 'ENABLED' : 'DISABLED'}${reloadHint}`);
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
            // Two visual sub-groups via type:'header' dividers. Headers carry
            // no state — they just label everything below them until the next
            // header. The session-replay toggle keeps `master:true` so the
            // script-level master rendering still works; the header above it
            // visually anchors it in the Network blocks group.
            toggles: [
                { type: 'header', label: 'Console' },
                {
                    id: 'suppress-debug-logs',
                    label: 'Suppress noisy Percepto debug logs',
                    type: 'boolean',
                    default: true,
                },
                { type: 'header', label: 'Mission notifications' },
                {
                    id: 'kill-notifs',
                    label: 'Kill mission toasts (takeoff / snapshot / etc — silences chime too)',
                    type: 'boolean',
                    default: false,
                },
                { type: 'header', label: 'Map performance' },
                {
                    id: 'hide-satellite',
                    label: 'Hide satellite base tiles',
                    type: 'boolean',
                    default: false,
                },
                {
                    id: 'ortho-lowres',
                    label: 'Low-res orthomosaic (caps tile zoom)',
                    type: 'boolean',
                    default: false,
                },
                {
                    id: 'ortho-lowres-zoom',
                    label: 'Cap zoom at',
                    type: 'number',
                    min: 10, max: 20, step: 1, default: 15,
                },
                { type: 'header', label: 'Network blocks' },
                {
                    id: 'master',
                    label: 'Block session-replay recorder (reload after toggle)',
                    type: 'boolean',
                    default: BLOCK_GROUPS['session-replay'].defaultEnabled,
                    master: true,
                },
                {
                    id: 'block-intercom',
                    label: 'Block chat widget (Zendesk · Intercom)',
                    type: 'boolean',
                    default: BLOCK_GROUPS['block-intercom'].defaultEnabled,
                },
                {
                    id: 'block-weather',
                    label: 'Block weather indicator (pilots only)',
                    type: 'boolean',
                    default: BLOCK_GROUPS['block-weather'].defaultEnabled,
                },
            ],
            hotkeys: [],
        });
    }
})();
