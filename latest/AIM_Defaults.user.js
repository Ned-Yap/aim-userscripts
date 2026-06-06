// ==UserScript==
// @name         Latest - AIM Defaults
// @namespace    http://tampermonkey.net/
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Defaults.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Defaults.user.js
// @description  Streamline the constant Percepto chores. Smart site navigation (land on your default section, keep your section when switching sites) + map-layer defaults (auto-off layers + Feeder Line bring-to-top) on every new site. Configurable in the AIM Control Panel.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
//
// What it does:
//   NAVIGATION (top window):
//     - Watches the URL hash. Site is always #/site/<ID>/<rest>.
//     - From the landing page → always your default section (default: Site Setup).
//     - Switching sites via the in-page dropdown → keep the SAME section on the
//       new site (session memory). Toggle that off to always use the default.
//     - Redirect rules handle unique-sub-ID paths that won't carry to a new site
//       (e.g. past-mission/<id> → mission-log/).
//   MAP LAYERS (map iframe):
//     - On each new site, opens the layer menu and applies your defaults:
//       auto-off chosen layers, and Feeder Line off→on to force it on top.
//
// Config: AIM Control Panel → "AIM Defaults" section.
// Log tag: [AIM DEFAULTS]

(function() {
    'use strict';

    const TAG = '[AIM DEFAULTS]';
    const log = (...a) => console.log(TAG, ...a);
    const warn = (...a) => console.warn(TAG, ...a);
    const err = (...a) => console.error(TAG, ...a);

    const IS_TOP = window === window.top;
    log('🛰️ loading…', IS_TOP ? '(top)' : '(iframe)');

    // ---- Settings (defaults; Control Panel overrides via SET_TOGGLE) ----------
    const S = {
        master: true,
        'nav-enabled': true,
        'default-section': 'control-panel/site-setup',
        'session-memory': true,
        'layers-enabled': true,
        'feeder-reorder': true,
        'off-street-labels': false,
        'off-site-setup': false,
        'off-general-markers': false,
        'off-assets': false,
        'off-feeder-line': false,
        'off-map': false,
    };

    // Section path suffixes (the part after #/site/<id>/).
    const SECTIONS = [
        { value: 'control-panel/site-setup',     label: 'Site Setup' },
        { value: 'data_view/',                   label: 'Data Map' },
        { value: 'control-panel/mission-bank',   label: 'Mission Bank' },
        { value: 'control-panel/insight-manager', label: 'Insight Manager' },
        { value: 'dashboard',                    label: 'Dashboard' },
    ];

    // Paths that contain a site-unique sub-ID and must NOT be carried to another
    // site verbatim — redirect to a safe section-level fallback instead.
    // Extend this list as new cases turn up.
    const REDIRECT_RULES = [
        { name: 'past-mission', test: /^control-panel\/past-mission\//i, to: 'mission-log/' },
    ];

    // Auto-off layer config key -> visible label in the layer menu.
    const LAYER_LABELS = [
        ['off-street-labels', 'Street labels'],
        ['off-site-setup', 'Site setup'],
        ['off-general-markers', 'General markers'],
        ['off-assets', 'Assets'],
        ['off-feeder-line', 'Feeder Line'],
        ['off-map', 'Map'],
    ];

    const norm = (s) => (s == null ? '' : String(s)).replace(/^\/+|\/+$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ---------------------------------------------------------------------------
    // Control Panel integration
    // ---------------------------------------------------------------------------
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-defaults';
    const SCRIPT_VERSION = '1.0';
    let controlChannel = null;

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { warn('BroadcastChannel unavailable — using defaults', e); return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                const id = msg.toggleId;
                if (!(id in S)) return;
                const val = msg.value !== undefined ? msg.value : msg.enabled;
                if (S[id] === val) return;           // idempotent — CP runs in both frames
                S[id] = val;
                log('setting', id, '=', val);
            }
        };
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'AIM Defaults',
            description: 'Smart site navigation + map-layer defaults on every new site.',
            version: SCRIPT_VERSION, priority: 5,
            toggles: [
                { id: 'master', label: 'Enable AIM Defaults', type: 'boolean', default: true, master: true },
                { type: 'header', label: 'Navigation' },
                { id: 'nav-enabled', label: 'Smart site navigation', type: 'boolean', default: true },
                { id: 'default-section', label: 'Default landing section', type: 'select',
                  default: 'control-panel/site-setup', options: SECTIONS },
                { id: 'session-memory', label: 'Session memory (keep section on site switch)', type: 'boolean', default: true },
                { type: 'header', label: 'Map Layers' },
                { id: 'layers-enabled', label: 'Auto-apply layer defaults on new site', type: 'boolean', default: true },
                { id: 'feeder-reorder', label: 'Feeder Line → bring on top (off/on)', type: 'boolean', default: true },
                { id: 'off-street-labels', label: 'Auto-off: Street labels', type: 'boolean', default: false },
                { id: 'off-site-setup', label: 'Auto-off: Site setup', type: 'boolean', default: false },
                { id: 'off-general-markers', label: 'Auto-off: General markers', type: 'boolean', default: false },
                { id: 'off-assets', label: 'Auto-off: Assets', type: 'boolean', default: false },
                { id: 'off-feeder-line', label: 'Auto-off: Feeder Line', type: 'boolean', default: false },
                { id: 'off-map', label: 'Auto-off: Map', type: 'boolean', default: false },
            ],
        });
    }

    // ---------------------------------------------------------------------------
    // Navigation (top window only)
    // ---------------------------------------------------------------------------
    function parseSite(hash) {
        const m = (hash || '').match(/#\/site\/(\d+)\/?(.*)$/);
        if (!m) return null;
        return { id: m[1], rest: m[2] || '' };
    }

    function applyRedirectRules(rest) {
        for (const rule of REDIRECT_RULES) {
            if (rule.test.test(rest)) {
                log(`redirect rule "${rule.name}" → ${rule.to}`);
                return rule.to;
            }
        }
        return rest;
    }

    // Site navigation is sometimes a full page reload (e.g. picking a site from
    // the landing search) and sometimes an in-app hash change (dropdown switch).
    // So we don't rely on hashchange alone — we persist the current site+section
    // and re-decide on every load AND hashchange.
    //
    // IMPORTANT: storage is localStorage, NOT sessionStorage. Percepto clears
    // sessionStorage during app boot (verified: prevId vanished between load and
    // the first nav), which made every navigation fall back to the default.
    // localStorage survives (Bulk Mission Adder relies on it too). We ALSO keep
    // an in-memory mirror in the persistent top frame as the primary source of
    // truth — Percepto can't touch a JS variable, and the top frame survives
    // every in-site hashchange. localStorage is only the cross-reload fallback.
    const SS_SITE = 'AIM_DEF_site';
    const SS_SECTION = 'AIM_DEF_section';
    const SS_FROM_LANDING = 'AIM_DEF_from_landing';
    const ssGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const ssSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
    const ssDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* */ } };

    // In-memory primary state (top frame). null until first seeded from storage.
    const mem = { site: null, section: null };
    function recordState(siteId, section) {
        mem.site = siteId; mem.section = section;
        ssSet(SS_SITE, siteId); ssSet(SS_SECTION, section);
    }

    // Arm the "from landing" flag when the user actually interacts with the
    // LANDING search box (.pr-sites-select-search) — focus or type. This is the
    // only reliable signal: time/DOM-presence checks false-armed during slow
    // site switches and bounced them to the default. The landing search and the
    // in-site header dropdown (.site-select) are DIFFERENT elements, so using the
    // site dropdown to switch sites never arms this — switches keep their section,
    // landing searches go to the default. Set in localStorage so it survives the
    // full reload into the chosen site, then consumed on arrival.
    function armLandingOnInteraction() {
        const handler = (e) => {
            try {
                const t = e.target;
                if (t && t.closest && t.closest('.pr-sites-select-search')) {
                    if (ssGet(SS_FROM_LANDING) !== '1') {
                        ssSet(SS_FROM_LANDING, '1');
                        log('landing search used — armed default for next site');
                    }
                }
            } catch (e2) { /* non-fatal */ }
        };
        document.addEventListener('focusin', handler, true);
        document.addEventListener('input', handler, true);
    }

    function evaluateNav(reason) {
        try {
            if (!S.master || !S['nav-enabled']) return;
            const cur = parseSite(location.hash);
            if (!cur) return;                      // non-site hash (incl. boot transients) — do NOT clear state

            const fromLanding = ssGet(SS_FROM_LANDING) === '1';
            // Prefer the in-memory mirror (Percepto can't wipe it); fall back to
            // localStorage only when mem is empty (i.e. right after a full reload).
            const prevId = mem.site || ssGet(SS_SITE);
            const prevSec = mem.site ? mem.section : ssGet(SS_SECTION);

            // Same site as before → ALWAYS respect where you are. Checked FIRST so
            // a stale/false landing flag can never bounce in-site navigation. Any
            // landing flag is definitionally wrong here (landing has no site), so
            // clear it too.
            if (prevId === cur.id) {
                if (fromLanding) ssDel(SS_FROM_LANDING);
                recordState(cur.id, cur.rest);
                return;
            }

            let target;
            if (fromLanding) {
                target = S['default-section'];                         // arrived via landing search → default
            } else if (prevId && prevId !== cur.id) {
                target = S['session-memory'] ? applyRedirectRules(prevSec || '') : S['default-section']; // site switch
            } else {
                target = S['default-section'];                         // first entry, no history → default
            }

            ssDel(SS_FROM_LANDING);                // consume the one-shot landing flag

            if (target && norm(cur.rest) !== norm(target)) {
                // Record the intended target FIRST so the post-redirect evaluation
                // sees "same site" and doesn't loop.
                recordState(cur.id, target);
                const url = location.href.split('#')[0] + '#/site/' + cur.id + '/' + target;
                log(`redirect (${reason}) ${cur.rest || '(root)'} → ${target} on site ${cur.id}`);
                location.replace(url);            // replace so Back doesn't bounce through Data Map
                return;
            }
            // Already where we want — just record current state.
            recordState(cur.id, cur.rest);
        } catch (e) {
            err('evaluateNav failed', e);
        }
    }

    // ---------------------------------------------------------------------------
    // Map layers (map iframe only)
    // ---------------------------------------------------------------------------
    const HIDE_STYLE_ID = 'aim-defaults-layer-hide';

    function setMenuHidden(hidden) {
        let style = document.getElementById(HIDE_STYLE_ID);
        if (hidden) {
            if (!style) {
                style = document.createElement('style');
                style.id = HIDE_STYLE_ID;
                // opacity-only so element.click() still works; avoids the flash.
                style.textContent = '.pr-layer-menu{opacity:0 !important; transition:none !important;}';
                document.head.appendChild(style);
            }
        } else if (style) {
            style.remove();
        }
    }

    function waitFor(sel, timeout = 2500, root = document) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const tick = () => {
                const el = root.querySelector(sel);
                if (el) return resolve(el);
                if (Date.now() - t0 > timeout) return resolve(null);
                setTimeout(tick, 50);
            };
            tick();
        });
    }

    function findLayerItem(menu, label) {
        const items = menu.querySelectorAll('.pr-dropdown-menu-item');
        for (const item of items) {
            const wrap = item.querySelector('label.ant-checkbox-wrapper');
            if (wrap && norm(wrap.textContent) === norm(label)) return item;
        }
        return null;
    }
    const itemChecked = (item) => !!item.querySelector('input.ant-checkbox-input')?.checked;
    function toggleItem(item) {
        const wrap = item.querySelector('label.ant-checkbox-wrapper');
        if (wrap) { wrap.click(); return true; }
        return false;
    }

    async function runLayerRoutine(doAutoOff) {
        const trigger = document.querySelector('.map-layer-menu');
        if (!trigger) return false;
        log('applying layer defaults', doAutoOff ? '(incl. auto-off)' : '(feeder only)');
        setMenuHidden(true);
        try {
            trigger.click();                                   // open menu
            const menu = await waitFor('.pr-layer-menu', 2500);
            if (!menu) { warn('layer menu did not open'); return false; }
            await sleep(120);

            // Auto-off configured layers (only when it's a new site).
            if (doAutoOff) {
                for (const [key, label] of LAYER_LABELS) {
                    if (!S[key]) continue;
                    const item = findLayerItem(menu, label);
                    if (item && itemChecked(item)) { toggleItem(item); await sleep(90); log('auto-off:', label); }
                }
            }

            // Feeder Line bring-to-top (skip if it's set to auto-off — leave it off).
            if (S['feeder-reorder'] && !S['off-feeder-line']) {
                const item = findLayerItem(menu, 'Feeder Line');
                if (item && itemChecked(item)) {
                    toggleItem(item); await sleep(220);        // off
                    const again = findLayerItem(menu, 'Feeder Line') || item;
                    toggleItem(again); await sleep(120);       // on (now drawn on top)
                    log('feeder line reordered on top');
                }
            }

            trigger.click();                                   // close menu
            await sleep(60);
            return true;
        } catch (e) {
            err('runLayerRoutine failed', e);
            return false;
        } finally {
            setMenuHidden(false);
        }
    }

    function startLayerWatcher() {
        let lastSig = null;            // top-hash we already handled (feeder per page)
        let lastAutoOffSite = null;    // site we already auto-offed (per new site)
        let running = false;

        setInterval(() => {
            if (running) return;
            if (!S.master || !S['layers-enabled']) return;
            if (!document.querySelector('.map-layer-menu')) return;
            let topHash = '';
            try { topHash = window.top.location.hash; } catch (e) { return; } // cross-origin guard
            const site = (topHash.match(/#\/site\/(\d+)\//) || [])[1] || null;
            if (!site) return;
            if (topHash === lastSig) return;       // already handled this page
            lastSig = topHash;                     // one attempt per page load
            const doAutoOff = site !== lastAutoOffSite;
            running = true;
            runLayerRoutine(doAutoOff)
                .then((ok) => { if (ok && doAutoOff) lastAutoOffSite = site; })
                .catch((e) => err('layer watcher', e))
                .finally(() => { running = false; });
        }, 800);
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    function init() {
        setupControlPanel();
        registerWithControlPanel();

        if (IS_TOP) {
            armLandingOnInteraction();
            window.addEventListener('hashchange', () => evaluateNav('hashchange'));
            evaluateNav('load');                 // act on the initial (possibly full-reload) entry
            log('navigation armed — default:', S['default-section'], '| session memory:', S['session-memory']);
        } else {
            startLayerWatcher();
            log('layer watcher armed');
        }
    }

    init();
})();
