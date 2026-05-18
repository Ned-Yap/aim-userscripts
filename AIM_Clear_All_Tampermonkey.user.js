// ==UserScript==
// @name         AIM Clear All
// @namespace    http://tampermonkey.net/
// @version      1.3
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Clear_All_Tampermonkey.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Clear_All_Tampermonkey.user.js
// @description  Adds Shift+C hotkey for the Clear All button. Registers with the AIM Control Panel for master toggle + hotkey rebinding.
// @author       Payden
// @match        *://percepto.app/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    var performAction = function() {
        window.console.log("Clear All: Triggering...");
        
        function clickElement(el, doc) {
            if (!el) return false;
            var rect = el.getBoundingClientRect();
            var x = rect.left + (rect.width / 2);
            var y = rect.top + (rect.height / 2);
            var cOpts = { bubbles: true, cancelable: true, view: doc.defaultView, buttons: 1, clientX: x, clientY: y };
            
            ['mousedown', 'mouseup', 'click'].forEach(function(t) { el.dispatchEvent(new MouseEvent(t, cOpts)); });
            
            // React Bypass
            try {
                var k = Object.keys(el).find(function(key) { return key.startsWith('__reactFiber') || key.startsWith('__reactProps'); });
                if (k && el[k].memoizedProps && el[k].memoizedProps.onClick) {
                    el[k].memoizedProps.onClick({ stopPropagation:function(){}, preventDefault:function(){}, nativeEvent: new MouseEvent('click', cOpts) });
                }
            } catch(e) {}
            return true;
        }

        function findAndExecute(doc) {
            // 1. Force Map "Reset"
            var map = doc.querySelector('.leaflet-container') || doc.querySelector('[class*="map-container"]');
            if (map) {
                var opts = { bubbles: true, cancelable: true, view: doc.defaultView };
                map.dispatchEvent(new MouseEvent('mouseout', opts));
                map.dispatchEvent(new MouseEvent('mouseup', opts));
            }

            // 2. Click Trash Can
            var trashBtn = doc.querySelector('img[title="Delete measurements"]');
            if (trashBtn && trashBtn.offsetParent !== null) {
                console.log("Clear All: Clicking Trash Can...");
                clickElement(trashBtn, doc);

                // 3. Wait for "Clear all" submenu
                setTimeout(function() {
                    var submenuBtns = doc.querySelectorAll('.map-tools__submenu__button');
                    var clearBtn = Array.from(submenuBtns).find(b => b.textContent.trim() === "Clear all");
                    
                    if (clearBtn) {
                        console.log("Clear All: Clicking Confirm...");
                        clickElement(clearBtn, doc);
                    } else {
                        console.warn("Clear All: Could not find 'Clear all' button.");
                    }
                }, 200); // Short delay for React to render menu
                return true;
            }
            return false;
        }

        // Try Current Document
        if (findAndExecute(document)) return;
        
        // Try Accessible Iframes
        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
            try {
                if (frames[i].contentDocument && findAndExecute(frames[i].contentDocument)) return;
            } catch(e) {}
        }
    };

    // --- AIM Control Panel integration ---
    const IS_TOP = window === window.top;
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-clear-all';
    const SCRIPT_VERSION = '1.3';
    let controlChannel = null;
    let controlPanelDetected = false;
    let masterEnabled = true;

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { return; }
        controlChannel.onmessage = (ev) => {
            controlPanelDetected = true;
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                if (msg.toggleId === 'master') masterEnabled = !!(msg.value !== undefined ? msg.value : msg.enabled);
            } else if (msg.type === 'HOTKEY_FIRED' && msg.scriptId === SCRIPT_ID && IS_TOP) {
                if (msg.hotkeyId === 'invoke' && masterEnabled) performAction();
            }
        };
    }
    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Clear All',
            version: SCRIPT_VERSION, group: 'Hotkeys',
            toggles: [{ id: 'master', label: 'Enable', type: 'boolean', default: true, master: true }],
            hotkeys: [{ id: 'invoke', label: 'Clear All measurements', default: 'Shift+C' }],
        });
    }
    setupControlPanel();
    registerWithControlPanel();

    var install = function() {
        var handler = function(e) {
            if (controlPanelDetected) return;
            if (!masterEnabled) return;
            // --- UNIVERSAL INPUT GUARD ---
            var el = e.target;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
                el.isContentEditable || el.closest('.ant-input') || el.closest('.ant-select') ||
                el.getAttribute('role') === 'textbox') {
                return;
            }

            // Shift + C
            if (e.shiftKey && (e.key === 'C' || e.code === 'KeyC')) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                performAction();
            }
        };

        if (!window.aimClearInstalled) {
            window.addEventListener('keydown', handler, true);
            window.aimClearInstalled = true;
        }

        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
            try {
                var win = frames[i].contentWindow;
                if (win && !win.aimClearInstalled) {
                    win.addEventListener('keydown', handler, true);
                    win.aimClearInstalled = true;
                }
            } catch(e) {}
        }
    };

    install();
    setInterval(install, 2000);
})();