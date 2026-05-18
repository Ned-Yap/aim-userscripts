// ==UserScript==
// @name         AIM New Entity Macro
// @namespace    http://tampermonkey.net/
// @version      1.6
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_New_Entity_Macro.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_New_Entity_Macro.user.js
// @description  Hotkeys 1-6 create color-coded entities; Shift+S Save, Shift+D D (double-press) Delete, Shift+Z Cancel, Shift+X Finish. Each hotkey individually enable/rebindable via the AIM Control Panel.
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

    // --- AIM Control Panel integration ---
    // 10 hotkeys, each individually rebindable AND individually enable/disable
    // via paired enable toggles (no shared master — user wanted per-entity
    // control). Color-coded entity labels + chips for visual scanning.
    // Delete requires DOUBLE-PRESS within DELETE_WINDOW_MS for safety.
    const IS_TOP = window === window.top;
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-new-entity-macro';
    const SCRIPT_VERSION = '1.6';
    const DELETE_WINDOW_MS = 500; // second press must arrive within this
    let controlChannel = null;
    let controlPanelDetected = false;
    // Per-hotkey enable state. Mirrors the paired toggles' state. Defaults
    // to true so a fresh install works without panel interaction.
    const enables = {
        'create-ffz': true, 'create-nfz': true, 'create-fp': true,
        'create-safe': true, 'create-asset': true, 'create-marker': true,
        'save': true, 'delete': true, 'cancel': true, 'finish': true,
    };
    let lastDeletePressAt = 0;

    // Color palette (kept here so the colors apply to both the panel chip
    // and the entity name label — see hotkey schema below).
    const ENTITY_COLORS = {
        ffz: '#5fff5f',     // green
        nfz: '#ff5060',     // red
        fp:  '#1ca0de',     // cyan
        safe:'#ff8c00',     // orange
        asset:'#ffffff',    // white
        marker:'#c39bd3',   // light purple
    };

    // hotkeyId -> action handler. Delete is special-cased for double-press.
    const HOTKEY_ACTIONS = {
        'create-ffz':    () => performGlobalAction('Digit1'),
        'create-nfz':    () => performGlobalAction('Digit2'),
        'create-fp':     () => performGlobalAction('Digit3'),
        'create-safe':   () => performGlobalAction('Digit4'),
        'create-asset':  () => performGlobalAction('Digit5'),
        'create-marker': () => performGlobalAction('Digit6'),
        'save':          () => performGlobalSave(),
        'delete':        () => {
            // Double-press safety: first press records timestamp; the second
            // within DELETE_WINDOW_MS triggers the actual delete. Otherwise
            // the press is a no-op and resets the window.
            const now = Date.now();
            if (now - lastDeletePressAt <= DELETE_WINDOW_MS) {
                lastDeletePressAt = 0;
                console.log("[AIM MACRO] 🗑️ Delete confirmed (double-press) — executing");
                performGlobalDelete();
            } else {
                lastDeletePressAt = now;
                console.log(`[AIM MACRO] ⚠️ Delete primed — press again within ${DELETE_WINDOW_MS}ms to confirm`);
            }
        },
        'cancel':        () => performGlobalCancel(),
        'finish':        () => performGlobalFinish(),
    };

    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { return; }
        controlChannel.onmessage = (ev) => {
            controlPanelDetected = true;
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                // Toggle ids follow the pattern 'enable-<hotkey-id>'.
                const m = (msg.toggleId || '').match(/^enable-(.+)$/);
                if (m && enables.hasOwnProperty(m[1])) {
                    enables[m[1]] = !!(msg.value !== undefined ? msg.value : msg.enabled);
                }
            } else if (msg.type === 'HOTKEY_FIRED' && msg.scriptId === SCRIPT_ID && IS_TOP) {
                if (!enables[msg.hotkeyId]) return; // per-hotkey enable check
                const fn = HOTKEY_ACTIONS[msg.hotkeyId];
                if (fn) fn();
            }
        };
    }

    // Builds the per-hotkey enable toggles. The panel renders them inline
    // with the matching hotkey row via the pairToggleId schema field.
    function buildToggles() {
        return Object.keys(enables).map(id => ({
            id: `enable-${id}`,
            // Label not user-visible (paired toggle is inlined in the hotkey row)
            // but kept descriptive in case the panel ever surfaces it.
            label: `Enable ${id}`,
            type: 'boolean',
            default: true,
        }));
    }

    // Builds the hotkey schema with colored labels (labelHtml — bold colored
    // span on the entity name with plain "New" prefix per user spec) and
    // matching chipColor. Each paired with its enable toggle.
    function buildHotkeys() {
        const C = ENTITY_COLORS;
        const colored = (prefix, name, color) => `${prefix}<strong style="color:${color}">${name}</strong>`;
        return [
            { id: 'create-ffz',    labelHtml: colored('New ', 'Free Fly Zone',  C.ffz),    chipColor: C.ffz,    default: '1',       pairToggleId: 'enable-create-ffz' },
            { id: 'create-nfz',    labelHtml: colored('New ', 'No Fly Zone',    C.nfz),    chipColor: C.nfz,    default: '2',       pairToggleId: 'enable-create-nfz' },
            { id: 'create-fp',     labelHtml: colored('New ', 'Flight Path',    C.fp),     chipColor: C.fp,     default: '3',       pairToggleId: 'enable-create-fp' },
            { id: 'create-safe',   labelHtml: colored('New ', 'Safe Zone',      C.safe),   chipColor: C.safe,   default: '4',       pairToggleId: 'enable-create-safe' },
            { id: 'create-asset',  labelHtml: colored('New ', 'Asset',          C.asset),  chipColor: C.asset,  default: '5',       pairToggleId: 'enable-create-asset' },
            { id: 'create-marker', labelHtml: colored('New ', 'General Marker', C.marker), chipColor: C.marker, default: '6',       pairToggleId: 'enable-create-marker' },
            { id: 'save',          label: 'Save (triple-confirm sequencing)',                                   default: 'Shift+S', pairToggleId: 'enable-save' },
            { id: 'delete',        label: 'Delete entity (double-press to confirm)',                            default: 'Shift+D', pairToggleId: 'enable-delete' },
            { id: 'cancel',        label: 'Cancel current edit',                                                default: 'Shift+Z', pairToggleId: 'enable-cancel' },
            { id: 'finish',        label: 'Finish editing',                                                     default: 'Shift+X', pairToggleId: 'enable-finish' },
        ];
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'New Entity Macro',
            version: SCRIPT_VERSION, group: 'Hotkeys',
            toggles: buildToggles(),
            hotkeys: buildHotkeys(),
        });
    }
    setupControlPanel();
    registerWithControlPanel();

    // --- Listener ---
    // Fallback keydown handler for when the Control Panel isn't loaded
    // (standalone use). Defers to the panel's HOTKEY_FIRED routing when
    // the panel IS detected. Routes through HOTKEY_ACTIONS so the same
    // per-entity enable + double-press-delete logic applies in both modes.
    var install = function() {
        var handler = function(e) {
            if (controlPanelDetected) return;
            var el = e.target;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
                el.isContentEditable || el.closest('.ant-input') || el.closest('.ant-select') ||
                el.getAttribute('role') === 'textbox') return;

            const fireAction = (hotkeyId) => {
                if (!enables[hotkeyId]) return false;
                const fn = HOTKEY_ACTIONS[hotkeyId];
                if (!fn) return false;
                fn();
                return true;
            };

            if (e.shiftKey) {
                let id = null;
                if (e.code === 'KeyZ') id = 'cancel';
                else if (e.code === 'KeyS') id = 'save';
                else if (e.code === 'KeyD') id = 'delete';
                else if (e.code === 'KeyX') id = 'finish';
                else return;
                if (fireAction(id)) {
                    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                }
            } else {
                const map = { Digit1:'create-ffz', Digit2:'create-nfz', Digit3:'create-fp',
                              Digit4:'create-safe', Digit5:'create-asset', Digit6:'create-marker' };
                const id = map[e.code];
                if (id && fireAction(id)) {
                    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                }
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