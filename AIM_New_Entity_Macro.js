// ==UserScript==
// @name         AIM New Entity Macro
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Hotkeys 1-6 create entities; Shift+S Save, Shift+D Delete, Shift+Z Cancel, Shift+X Finish.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    console.log("[AIM MACRO] 🏗️ Entity Creator Loaded");

    // --- Configuration ---
    const ENTITY_MAP = {
        'Digit1': 'Free fly zone',
        'Digit2': 'No fly zone',
        'Digit3': 'Flight path',
        'Digit4': 'Safe zone',
        'Digit5': 'Asset',
        'Digit6': 'General marker'
    };

    // --- Selectors ---
    const SEL_CANCEL = '.upsert-entity__cancel-button';
    const SEL_NEW_BTN = '.site-setup-header__new_entity-button';
    const SEL_FINISH_BTN = '.site-setup-header__finish-editing-button';
    const SEL_KEBAB_BTN = '.site-setup-header__kebab-button';
    const SEL_SAVE_BTN = '.upsert-entity__save-button';
    const SEL_OPTION_LABEL = '.select-entity-type__option-label';
    const SEL_OPTION_ITEM = '.select-entity-type__option';

    // --- Actions ---

    function clickElement(el, doc) {
        if (!el) return false;
        var cOpts = { bubbles: true, cancelable: true, view: doc.defaultView || window, buttons: 1 };
        ['mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, cOpts)));
        
        try {
            var k = Object.keys(el).find(key => key.startsWith('__reactFiber') || key.startsWith('__reactProps'));
            if (k && el[k].memoizedProps && el[k].memoizedProps.onClick) {
                el[k].memoizedProps.onClick({ stopPropagation:()=>{}, preventDefault:()=>{}, nativeEvent: new MouseEvent('click', cOpts) });
            }
        } catch(e) {}
        return true;
    }

    function findEntityButton(doc, text) {
        var labels = Array.from(doc.querySelectorAll(SEL_OPTION_LABEL));
        var targetLabel = labels.find(l => l.textContent.trim() === text);
        return targetLabel ? targetLabel.closest(SEL_OPTION_ITEM) : null;
    }

    function executeMacro(doc, entityName) {
        var cancelBtn = doc.querySelector(SEL_CANCEL);
        var proceedToNew = () => {
            var newBtn = doc.querySelector(SEL_NEW_BTN);
            if (newBtn && newBtn.offsetParent !== null) {
                clickElement(newBtn, doc);
                var attempts = 0;
                var poller = setInterval(() => {
                    attempts++;
                    var targetBtn = findEntityButton(doc, entityName);
                    if (targetBtn) {
                        clickElement(targetBtn, doc);
                        clearInterval(poller);
                    } else if (attempts > 20) clearInterval(poller);
                }, 100);
            } else {
                var targetBtn = findEntityButton(doc, entityName);
                if (targetBtn) clickElement(targetBtn, doc);
            }
        };
        if (cancelBtn && cancelBtn.offsetParent !== null) {
            clickElement(cancelBtn, doc);
            setTimeout(proceedToNew, 200); 
        } else proceedToNew();
    }

    function performGlobalAction(key) {
        var entityName = ENTITY_MAP[key];
        if (!entityName) return;
        executeMacro(document, entityName);
        document.querySelectorAll('iframe').forEach(f => {
            try { if (f.contentDocument) executeMacro(f.contentDocument, entityName); } catch(e) {}
        });
    }

    function performGlobalCancel() {
        var doCancel = (doc) => {
            var btn = doc.querySelector(SEL_CANCEL);
            if (btn && btn.offsetParent !== null) clickElement(btn, doc);
        };
        doCancel(document);
        document.querySelectorAll('iframe').forEach(f => {
            try { if (f.contentDocument) doCancel(f.contentDocument); } catch(e) {}
        });
    }

    function performGlobalSave() {
        var doSave = (doc) => {
            function findPopupSave() {
                var btns = Array.from(doc.querySelectorAll(SEL_SAVE_BTN + ', button.ant-btn-primary'));
                var visible = btns.filter(b => b.offsetParent !== null && b.textContent.trim().toLowerCase().includes("save"));
                return visible.length > 0 ? visible[visible.length - 1] : null;
            }
            var saveBtn = doc.querySelector(SEL_SAVE_BTN);
            if (saveBtn && saveBtn.offsetParent !== null) {
                clickElement(saveBtn, doc);
                setTimeout(() => {
                    var secondBtn = findPopupSave();
                    if (secondBtn && secondBtn !== saveBtn) {
                        clickElement(secondBtn, doc);
                        setTimeout(() => {
                            var thirdBtn = findPopupSave();
                            if (thirdBtn && thirdBtn !== secondBtn) clickElement(thirdBtn, doc);
                        }, 400);
                    }
                }, 400);
                return true;
            }
            return false;
        };
        if (!doSave(document)) {
            document.querySelectorAll('iframe').forEach(f => {
                try { if (f.contentDocument) doSave(f.contentDocument); } catch(e) {}
            });
        }
    }

    function performGlobalDelete() {
        var doDelete = (doc) => {
            var kebabBtn = doc.querySelector(SEL_KEBAB_BTN);
            if (kebabBtn && kebabBtn.offsetParent !== null) {
                clickElement(kebabBtn, doc);
                var attempts = 0;
                var poller = setInterval(() => {
                    attempts++;
                    var opt = doc.querySelector('li[data-menu-id$="-delete"]') || 
                              Array.from(doc.querySelectorAll('li[role="menuitem"]')).find(el => el.textContent.trim() === "Delete");
                    if (opt && opt.offsetParent !== null) {
                        clickElement(opt, doc);
                        clearInterval(poller);
                        var cAttempts = 0;
                        var cPoller = setInterval(() => {
                            cAttempts++;
                            var confirm = Array.from(doc.querySelectorAll('button span')).find(s => s.textContent.trim() === "Delete entity");
                            if (confirm && confirm.offsetParent !== null) {
                                clickElement(confirm.closest('button'), doc);
                                clearInterval(cPoller);
                            } else if (cAttempts > 20) clearInterval(cPoller);
                        }, 100);
                    } else if (attempts > 20) clearInterval(poller);
                }, 100);
                return true;
            }
            return false;
        };
        if (!doDelete(document)) {
            document.querySelectorAll('iframe').forEach(f => {
                try { if (f.contentDocument) doDelete(f.contentDocument); } catch(e) {}
            });
        }
    }

    function performGlobalFinish() {
        var doFinish = (doc) => {
            var btn = doc.querySelector(SEL_FINISH_BTN);
            if (btn && btn.offsetParent !== null) {
                clickElement(btn, doc);
                return true;
            }
            return false;
        };
        if (!doFinish(document)) {
            document.querySelectorAll('iframe').forEach(f => {
                try { if (f.contentDocument) doFinish(f.contentDocument); } catch(e) {}
            });
        }
    }

    // --- Listener ---
    var install = function() {
        var handler = function(e) {
            var el = e.target;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || 
                el.isContentEditable || el.closest('.ant-input') || el.closest('.ant-select') || 
                el.getAttribute('role') === 'textbox') return;

            if (e.shiftKey) {
                if (e.code === 'KeyZ') performGlobalCancel();
                else if (e.code === 'KeyS') performGlobalSave();
                else if (e.code === 'KeyD') performGlobalDelete();
                else if (e.code === 'KeyX') performGlobalFinish();
                else return;
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            } else if (['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].includes(e.code)) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                performGlobalAction(e.code);
            }
        };

        if (!window.aimMacroInstalled) {
            window.addEventListener('keydown', handler, true);
            window.aimMacroInstalled = true;
        }
        document.querySelectorAll('iframe').forEach(f => {
            try {
                if (f.contentWindow && !f.contentWindow.aimMacroInstalled) {
                    f.contentWindow.addEventListener('keydown', handler, true);
                    f.contentWindow.aimMacroInstalled = true;
                }
            } catch(e) {}
        });
    };

    install();
    setInterval(install, 1000);
})();