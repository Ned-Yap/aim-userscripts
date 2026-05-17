// ==UserScript==
// @name         AIM Clear All
// @namespace    http://tampermonkey.net/
// @version      1.1
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Clear_All_Tampermonkey.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Clear_All_Tampermonkey.js
// @description  Adds Shift+C hotkey for the Clear All button.
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

    var install = function() {
        var handler = function(e) {
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