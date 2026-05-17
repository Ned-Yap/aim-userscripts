// ==UserScript==
// @name         AIM Measure / Ruler
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Adds Shift+R hotkey for the Measure tool, with segment cleanup.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    const SYNC_CHANNEL = "AIM_RULER_SYNC";
    const sync = new BroadcastChannel(SYNC_CHANNEL);
    
    window.aimPendingRuler = false;

    sync.onmessage = (e) => {
        if (e.data === "START_TRAP") {
            window.aimPendingRuler = true;
            // console.log("[AIM RULER] 📡 Received Trap Start signal.");
        }
    };

    var performAction = function() {
        window.console.log("Ruler: Triggering...");
        window.aimPendingRuler = true;
        sync.postMessage("START_TRAP");
        
        function findAndClick(doc) {
            // 1. Force Map Reset
            var map = doc.querySelector('.leaflet-container') || doc.querySelector('[class*="map-container"]');
            if (map) {
                var opts = { bubbles: true, cancelable: true, view: doc.defaultView };
                map.dispatchEvent(new MouseEvent('mouseout', opts));
                map.dispatchEvent(new MouseEvent('mouseup', opts));
            }

            // 2. Find Button
            var btn = doc.querySelector('img[title="Measure distance"]');
            if (btn && btn.offsetParent !== null) {
                var rect = btn.getBoundingClientRect();
                var x = rect.left + (rect.width / 2);
                var y = rect.top + (rect.height / 2);
                var el = doc.elementFromPoint(x, y);
                
                if (el) {
                    el.click();
                    try {
                        var k = Object.keys(el).find(function(key) { return key.startsWith('__reactFiber') || key.startsWith('__reactProps'); });
                        if (k && el[k].memoizedProps && el[k].memoizedProps.onClick) {
                            el[k].memoizedProps.onClick({ stopPropagation:function(){}, preventDefault:function(){}, nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView }) });
                        }
                    } catch(e) {}

                    // Undo initial stray point at 0,0
                    setTimeout(function() {
                        var originEl = doc.elementFromPoint(0, 0) || doc.body;
                        var m2Opts = { bubbles: true, cancelable: true, view: doc.defaultView, button: 2, buttons: 2, clientX: 0, clientY: 0 };
                        originEl.dispatchEvent(new MouseEvent('mousedown', m2Opts));
                        originEl.dispatchEvent(new MouseEvent('mouseup', m2Opts));
                        originEl.dispatchEvent(new MouseEvent('contextmenu', m2Opts));
                    }, 10);

                    return true;
                }
            }
            return false;
        }

        if (findAndClick(document)) return;
        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
            try { if (frames[i].contentDocument && findAndClick(frames[i].contentDocument)) return; } catch(e) {}
        }
    };

    var install = function() {
        // --- CLICK CLEANER (Same logic as Altitude) ---
        var clickHandler = function(e) {
            if (window.aimPendingRuler && e.button === 0) {
                console.log("[AIM RULER] 🛡️ Pin dropped. Cleaning up segment...");
                var x = e.clientX;
                var y = e.clientY;
                var doc = e.target.ownerDocument || document;
                
                setTimeout(() => {
                    var elAtPoint = doc.elementFromPoint(x, y);
                    if (elAtPoint) {
                        var m2Opts = { bubbles: true, cancelable: true, view: window, button: 2, buttons: 2, clientX: x, clientY: y };
                        elAtPoint.dispatchEvent(new MouseEvent('mousedown', m2Opts));
                        elAtPoint.dispatchEvent(new MouseEvent('mouseup', m2Opts));
                        elAtPoint.dispatchEvent(new MouseEvent('contextmenu', m2Opts));
                    }
                }, 100); 
                
                window.aimPendingRuler = false; 
            }
        };

        var keyHandler = function(e) {
            var el = e.target;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || 
                el.isContentEditable || el.closest('.ant-input') || el.closest('.ant-select') || 
                el.getAttribute('role') === 'textbox') return;

            // Shift + R
            if (e.shiftKey && (e.key === 'R' || e.code === 'KeyR')) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                performAction();
            }
        };

        if (!window.aimRulerInstalled) {
            window.addEventListener('keydown', keyHandler, true);
            window.addEventListener('mousedown', clickHandler, true);
            window.aimRulerInstalled = true;
        }

        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
            try {
                var win = frames[i].contentWindow;
                if (win && !win.aimRulerInstalled) {
                    win.addEventListener('keydown', keyHandler, true);
                    win.addEventListener('mousedown', clickHandler, true);
                    win.aimRulerInstalled = true;
                }
            } catch(e) {}
        }
    };

    install();
    setInterval(install, 500); 
})();