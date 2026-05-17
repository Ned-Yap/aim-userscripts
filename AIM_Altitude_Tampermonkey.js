// ==UserScript==
// @name         AIM Absolute Altitude
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Adds Shift+A hotkey for the Absolute Altitude tool, with segment cleanup.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    const SYNC_CHANNEL = "AIM_ALTITUDE_SYNC";
    const sync = new BroadcastChannel(SYNC_CHANNEL);
    
    window.aimPendingPin = false;

    sync.onmessage = (e) => {
        if (e.data === "START_TRAP") {
            window.aimPendingPin = true;
            console.log("[AIM ALT] 📡 Received Trap Start signal.");
        }
    };

    var performAction = function() {
        window.console.log("Altitude: Triggering...");
        window.aimPendingPin = true;
        sync.postMessage("START_TRAP"); // Tell all other frames to set the trap
        
        function findAndClick(doc) {
            var map = doc.querySelector('.leaflet-container') || doc.querySelector('[class*="map-container"]');
            if (map) {
                var opts = { bubbles: true, cancelable: true, view: doc.defaultView };
                map.dispatchEvent(new MouseEvent('mouseout', opts));
                map.dispatchEvent(new MouseEvent('mouseup', opts));
            }

            var btn = doc.querySelector('img[title="Absolute altitude"]');
            if (btn && btn.offsetParent !== null) {
                var rect = btn.getBoundingClientRect();
                var x = rect.left + (rect.width / 2);
                var y = rect.top + (rect.height / 2);
                var el = doc.elementFromPoint(x, y);
                
                if (el) {
                    el.click();
                    try {
                        var k = Object.keys(el).find(key => key.startsWith('__reactFiber') || key.startsWith('__reactProps'));
                        if (k && el[k].memoizedProps && el[k].memoizedProps.onClick) {
                            el[k].memoizedProps.onClick({ stopPropagation:()=>{}, preventDefault:()=>{}, nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView }) });
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
        var clickHandler = function(e) {
            if (window.aimPendingPin && e.button === 0) {
                console.log("[AIM ALT] 🛡️ Pin dropped. Initiating Smart Cleanup (200ms)...");
                var x = e.clientX;
                var y = e.clientY;
                var doc = e.target.ownerDocument || document;
                
                setTimeout(() => {
                    // 1. Find the Top Element (The Pin we just dropped)
                    var topEl = doc.elementFromPoint(x, y);
                    
                    if (topEl) {
                        console.log("[AIM ALT] 📍 Top element found:", topEl.tagName, topEl.className);
                        
                        // 2. Make it "click-through" temporarily
                        var originalPE = topEl.style.pointerEvents;
                        topEl.style.pointerEvents = 'none';
                        
                        // 3. Find the element UNDERNEATH (The stray vertex/line)
                        var elUnder = doc.elementFromPoint(x, y);
                        
                        if (elUnder && elUnder !== topEl) {
                            console.log("[AIM ALT] 🎯 Target found under pin:", elUnder.tagName, elUnder.className);
                            
                            // 4. Dispatch M2 (Right Click) sequence to the UNDERLYING element
                            var m2Opts = { bubbles: true, cancelable: true, view: window, button: 2, buttons: 2, clientX: x, clientY: y };
                            elUnder.dispatchEvent(new MouseEvent('mousedown', m2Opts));
                            elUnder.dispatchEvent(new MouseEvent('mouseup', m2Opts));
                            elUnder.dispatchEvent(new MouseEvent('contextmenu', m2Opts));
                        } else {
                            console.warn("[AIM ALT] ⚠️ No distinct element found underneath. Map container might be target.");
                        }

                        // 5. Restore Pin Interactivity
                        topEl.style.pointerEvents = originalPE;

                        // 6. RE-CLICK PIN TO OPEN POPUP (Fix for popup closing)
                        setTimeout(() => {
                             console.log("[AIM ALT] 🔄 Re-clicking pin to restore popup...");
                             topEl.click();
                             // React often needs a deeper simulated click if the standard .click() is swallowed
                             try {
                                 var k = Object.keys(topEl).find(key => key.startsWith('__reactFiber') || key.startsWith('__reactProps'));
                                 if (k && topEl[k].memoizedProps && topEl[k].memoizedProps.onClick) {
                                     topEl[k].memoizedProps.onClick({ 
                                         stopPropagation:()=>{}, 
                                         preventDefault:()=>{}, 
                                         nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView }) 
                                     });
                                 }
                             } catch(e) {}
                        }, 50);
                    }
                }, 200); 
                
                window.aimPendingPin = false; 
            }
        };

        var keyHandler = function(e) {
            var el = e.target;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || 
                el.isContentEditable || el.closest('.ant-input') || el.closest('.ant-select') || 
                el.getAttribute('role') === 'textbox') return;

            if (e.shiftKey && (e.key === 'A' || e.code === 'KeyA')) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                performAction();
            }
        };

        if (!window.aimAltInstalled) {
            window.addEventListener('keydown', keyHandler, true);
            window.addEventListener('mousedown', clickHandler, true);
            window.aimAltInstalled = true;
        }

        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
            try {
                var win = frames[i].contentWindow;
                if (win && !win.aimAltInstalled) {
                    win.addEventListener('keydown', keyHandler, true);
                    win.addEventListener('mousedown', clickHandler, true);
                    win.aimAltInstalled = true;
                }
            } catch(e) {}
        }
    };

    // Run Install Immediately on Load
    install();
    
    // Check frequently for new frames/reloads
    setInterval(install, 500); 
})();