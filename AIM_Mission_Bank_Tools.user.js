// ==UserScript==
// @name         AIM Mission Bank Tools
// @namespace    http://tampermonkey.net/
// @version      0.1
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Bank_Tools.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Bank_Tools.user.js
// @description  Mission Bank workflow tools (summary, bulk ops, etc.). Skeleton — install now so coworkers get features as they ship.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// Mission Bank Tools — placeholder.
// Hotkeys/features: NONE YET (this file is a skeleton).
// Bracketed log tag: [AIM MB TOOLS]
//
// Why this exists today:
//   We want coworkers installed NOW so the first time we ship a real
//   Mission Bank feature, they get it automatically via Tampermonkey's
//   @updateURL. Otherwise every new install request would be a manual
//   ask. This file does nothing functional until features are added.
//
// When the first real feature lands:
//   1. Add toggles/hotkeys to buildToggles() / buildHotkeys()
//   2. Uncomment the registerWithControlPanel() block
//   3. Uncomment 'group:Mission Bank Macros': 50 in AIM_Control_Panel
//      SECTION_PRIORITY (currently a comment-only placeholder)
//   4. Bump @version + SCRIPT_VERSION below

(function() {
    'use strict';

    const SCRIPT_ID = 'aim-mission-bank-tools';
    const SCRIPT_VERSION = '0.1';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const TAG = '[AIM MB TOOLS]';
    const IS_TOP = window === window.top;

    let controlChannel = null;
    let controlPanelDetected = false;
    let masterEnabled = true;

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { return; }
        controlChannel.onmessage = (ev) => {
            controlPanelDetected = true;
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') {
                registerWithControlPanel();
            } else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                if (msg.toggleId === 'master') {
                    masterEnabled = !!(msg.value !== undefined ? msg.value : msg.enabled);
                }
            } else if (msg.type === 'HOTKEY_FIRED' && msg.scriptId === SCRIPT_ID && IS_TOP) {
                // IS_TOP gate avoids double-execution — BroadcastChannel delivers to
                // every context. Route to the right handler below when features land.
                //
                // if (msg.hotkeyId === 'open-summary' && masterEnabled) openMissionSummary();
                // if (msg.hotkeyId === 'bulk-edit'    && masterEnabled) openBulkMissionEdit();
            }
        };
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        // Intentionally NOT registering yet. Empty register would create
        // an empty "Mission Bank Macros" section in the panel with nothing
        // in it, which would be confusing. Uncomment when the first real
        // feature ships:
        //
        // controlChannel.postMessage({
        //     type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Mission Bank Tools',
        //     description: 'Summary panel + bulk ops for Mission Bank.',
        //     version: SCRIPT_VERSION,
        //     group: 'Mission Bank Macros', scope: 'mission-bank', priority: 50,
        //     toggles: [{ id: 'master', label: 'Enable', type: 'boolean', default: true, master: true }],
        //     hotkeys: [
        //         // { id: 'open-summary', label: 'Open Mission Summary', default: 'Shift+M' },
        //     ],
        // });
    }

    function init() {
        console.log(`${TAG} v${SCRIPT_VERSION} init (${IS_TOP ? 'TOP' : 'IFRAME'}) — skeleton, no features yet`);
        setupControlPanel();
        registerWithControlPanel();
        console.log(`${TAG} ready`);
    }

    init();
})();
