// ==UserScript==
// @name         AIM Bulk Validator
// @namespace    http://tampermonkey.net/
// @version      1.4
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Bulk_Validator.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Bulk_Validator.user.js
// @description  Bulk validate/unvalidate entities from a list. FFZs prioritized.
// @author       Payden / Gemini
// @match        *://percepto.app/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const DATA_KEY = "AIM_VAL_LIST";
    const MODE_KEY = "AIM_VAL_MODE"; // "validate" or "unvalidate"
    const COMPLETED_KEY = "AIM_VAL_COMPLETED";
    const ACTIVE_CLICK_KEY = "AIM_VAL_LAST_CLICKED";
    const TAB_LOCK_KEY = "AIM_VAL_TAB_ID";

    if (!window.name) window.name = "aim_val_tab_" + Math.random().toString(36).substr(2, 9);
    const MY_TAB_ID = window.name;

    function init() {
        console.log("[AIM Bulk Validator] 🚀 Validator Initialized.");

        // --- AIM Control Panel integration ---
        // Master toggle + rebindable Shift+V hotkey. Existing keydown defers
        // when panel is detected. IS_TOP gates the action so it only fires
        // once across all frame contexts.
        const IS_TOP = window === window.top;
        const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
        const SCRIPT_ID = 'aim-bulk-validator';
        const SCRIPT_VERSION = '1.4';
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
                    if (msg.hotkeyId === 'invoke' && masterEnabled) createUI();
                }
            };
        }
        function registerWithControlPanel() {
            if (!controlChannel) return;
            controlChannel.postMessage({
                type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Bulk Validator',
                description: 'Bulk validate/unvalidate entities from a list. FFZs prioritized.',
                version: SCRIPT_VERSION,
                group: 'Site Setup Macros', scope: 'site-setup', priority: 90,
                toggles: [{ id: 'master', label: 'Enable', type: 'boolean', default: true, master: true }],
                hotkeys: [{ id: 'invoke', label: 'Open Bulk Validator', default: 'Shift+V' }],
            });
        }
        setupControlPanel();
        registerWithControlPanel();

        // --- UI Trigger Injection ---
        function runInjection() {
            function inject(doc) {
                const isEditing = !!doc.querySelector('.upsert-entity');
                const existingBtn = doc.getElementById('aim-val-trigger-btn');
                const container = doc.getElementById('aim-automation-container');

                if (isEditing) {
                    if (existingBtn) existingBtn.style.display = 'none';
                    if (container) container.style.display = 'none';
                    return;
                }

                const header = doc.querySelector('.site-setup-header--all-entities');
                if (header) {
                    if (!container) {
                        const newContainer = doc.createElement('div');
                        newContainer.id = 'aim-automation-container';
                        Object.assign(newContainer.style, {
                            width: '100%',
                            display: 'flex',
                            justifyContent: 'flex-start',
                            padding: '4px 0 8px 16px',
                            borderBottom: '1px solid #f0f0f0',
                            marginTop: '-4px',
                            gap: '10px'
                        });
                        header.after(newContainer);
                    } else {
                        container.style.display = 'flex';
                    }

                    if (!existingBtn) {
                        const newBtnRef = header.querySelector('.site-setup-header__new_entity-button');
                        const btn = doc.createElement('button');
                        btn.id = 'aim-val-trigger-btn';
                        btn.type = 'button';
                        btn.className = newBtnRef ? newBtnRef.className : 'ant-btn ant-btn-primary ant-btn-sm';
                        Object.assign(btn.style, {
                            minWidth: 'unset',
                            padding: '0 12px',
                            height: '24px',
                            fontSize: '10px',
                            fontWeight: 'bold'
                        });
                        btn.innerHTML = `VAL`;

                        btn.onclick = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            createUI();
                        };

                        (doc.getElementById('aim-automation-container') || container).appendChild(btn);
                    } else {
                        existingBtn.style.display = '';
                    }
                }
            }

            function recursiveInject(win) {
                try {
                    inject(win.document);
                    const frames = win.document.querySelectorAll('iframe');
                    frames.forEach(f => { if (f.contentWindow) recursiveInject(f.contentWindow); });
                } catch(e) {}
            }
            recursiveInject(window);
        }
        setInterval(runInjection, 2000);

        function parseDataText(text) {
            const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
            const baseNames = new Set();
            lines.forEach(line => {
                // Strip "- Seg X" or similar segment labels to match base entity names
                const segMatch = line.match(/(.+) - Seg \d+/i);
                if (segMatch) {
                    baseNames.add(segMatch[1].trim());
                } else {
                    baseNames.add(line);
                }
            });
            return Array.from(baseNames);
        }

        function createUI() {
            if (document.getElementById('aim-val-modal')) return;
            const modal = document.createElement('div');
            modal.id = 'aim-val-modal';
            Object.assign(modal.style, {
                position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                backgroundColor: '#fff', padding: '20px', border: '2px solid #417690',
                borderRadius: '8px', zIndex: '100000', boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
                width: '450px', color: '#333', fontFamily: 'sans-serif'
            });

            modal.innerHTML = `
                <h3 style="margin-top:0; color:#417690;">Bulk Validator</h3>
                <div style="margin-bottom: 10px; background: #f1f7f9; padding: 12px; border-radius: 4px; border: 1px solid #c5dce3; font-size: 13px;">
                    <div style="display: flex; gap: 20px; align-items: center;">
                        <span style="font-weight: bold;">Action:</span>
                        <label style="cursor:pointer; font-weight: bold; color: #27ae60;">
                            <input type="radio" name="aim-val-mode" value="validate" checked> Validate
                        </label>
                        <label style="cursor:pointer; font-weight: bold; color: #c0392b;">
                            <input type="radio" name="aim-val-mode" value="unvalidate"> Unvalidate
                        </label>
                    </div>
                </div>
                <textarea id="aim-val-input" style="width:100%; height:160px; margin-bottom:10px; border:1px solid #ccc; border-radius:4px; padding:5px; white-space: pre; font-family: monospace; font-size: 12px;" placeholder="Paste entity names here (one per line)..."></textarea>
                <div style="display:flex; justify-content: flex-end; gap: 10px;">
                    <button id="aim-val-cancel" style="padding:8px 15px; border:1px solid #ccc; background:#eee; cursor:pointer; border-radius:4px;">Cancel</button>
                    <button id="aim-val-start" style="padding:8px 20px; border:none; background:#417690; color:white; cursor:pointer; border-radius:4px; font-weight:bold;">Start Validating</button>
                </div>
            `;
            document.body.appendChild(modal);

            document.getElementById('aim-val-cancel').onclick = () => { modal.remove(); };
            document.getElementById('aim-val-start').onclick = () => {
                const list = parseDataText(document.getElementById('aim-val-input').value);
                if (list.length > 0) {
                    localStorage.setItem(DATA_KEY, JSON.stringify(list));
                    localStorage.setItem(MODE_KEY, document.querySelector('input[name="aim-val-mode"]:checked').value);
                    localStorage.setItem(COMPLETED_KEY, JSON.stringify([]));
                    localStorage.setItem(TAB_LOCK_KEY, MY_TAB_ID); 
                    modal.remove();
                    processValidator();
                }
            };
        }

        function showStatus(message, isError = false) {
            let status = document.getElementById('aim-val-status');
            if (!status) {
                status = document.createElement('div');
                status.id = 'aim-val-status';
                Object.assign(status.style, {
                    position: 'fixed', bottom: '20px', right: '20px', padding: '10px 20px',
                    borderRadius: '5px', zIndex: '100001', color: 'white', fontWeight: 'bold', boxShadow: '0 2px 10px rgba(0,0,0,0.2)'
                });
                document.body.appendChild(status);
            }
            status.style.backgroundColor = isError ? '#cc0000' : '#417690';
            status.innerHTML = message + ` <button id="aim-stop-val" style="margin-left:10px; background:white; color:black; border:none; border-radius:3px; cursor:pointer; font-size:10px; padding:2px 5px;">STOP</button>`;
            document.getElementById('aim-stop-val').onclick = () => {
                localStorage.removeItem(DATA_KEY); localStorage.removeItem(COMPLETED_KEY); localStorage.removeItem(TAB_LOCK_KEY);
                status.remove();
            };
        }

        function showToast(message) {
            const toast = document.createElement('div');
            Object.assign(toast.style, {
                position: 'fixed', bottom: '70px', right: '20px', padding: '8px 15px',
                borderRadius: '4px', zIndex: '100002', color: 'white', backgroundColor: '#f39c12',
                fontWeight: 'bold', boxShadow: '0 2px 5px rgba(0,0,0,0.2)', fontSize: '12px',
                transition: 'opacity 0.5s ease'
            });
            toast.innerText = message;
            document.body.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 500);
            }, 2500);
        }

        function scanAllDocs(selector, textSearch = "") {
            let results = [];
            function recursiveScan(win) {
                try {
                    const doc = win.document;
                    let els = Array.from(doc.querySelectorAll(selector));
                    if (textSearch) els = els.filter(el => el.textContent.toLowerCase().includes(textSearch.toLowerCase()));
                    els.forEach(el => results.push({ el, doc }));
                    const frames = win.document.querySelectorAll('iframe');
                    frames.forEach(f => { if (f.contentWindow) recursiveScan(f.contentWindow); });
                } catch (e) {}
            }
            recursiveScan(window);
            return results;
        }

        function clickElement(el, doc) {
            if (!el) return;
            const opts = { bubbles: true, cancelable: true, view: doc.defaultView || window };
            ['mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
        }

        function processValidator() {
            const lockedTab = localStorage.getItem(TAB_LOCK_KEY);
            if (lockedTab && lockedTab !== MY_TAB_ID) return; 

            const listRaw = localStorage.getItem(DATA_KEY);
            if (!listRaw) return;
            const list = JSON.parse(listRaw);
            const completed = JSON.parse(localStorage.getItem(COMPLETED_KEY) || "[]");
            const mode = localStorage.getItem(MODE_KEY);

            const pendingNames = list.filter(n => !completed.includes(n));

            // Prioritize FFZs
            pendingNames.sort((a, b) => {
                const aIsZone = a.toLowerCase().includes("freezone");
                const bIsZone = b.toLowerCase().includes("freezone");
                if (aIsZone && !bIsZone) return -1;
                if (!aIsZone && bIsZone) return 1;
                return 0;
            });

            if (pendingNames.length === 0) {
                localStorage.removeItem(DATA_KEY); localStorage.removeItem(COMPLETED_KEY); localStorage.removeItem(TAB_LOCK_KEY);
                showStatus("Validation Process Complete!");
                setTimeout(() => document.getElementById('aim-val-status')?.remove(), 3000);
                return;
            }

            const currentTarget = pendingNames[0];
            showStatus(`${mode === 'validate' ? 'Validating' : 'Unvalidating'}: ${currentTarget} (${pendingNames.length} left)`);

            const panels = scanAllDocs('.upsert-entity');
            if (panels.length > 0) {
                const { el: panel, doc: panelDoc } = panels[0];
                const entityTitleEl = panelDoc.querySelector('.upsert-entity__title') || panelDoc.querySelector('.site-setup-header__title');
                const openTitle = entityTitleEl?.textContent.trim().toLowerCase() || "";
                const lastClicked = localStorage.getItem(ACTIVE_CLICK_KEY);

                if (openTitle.includes(currentTarget.toLowerCase()) || lastClicked === currentTarget) {
                    const switchBtn = panelDoc.querySelector('button.upsert-entity__form-is-validated-switch');
                    if (switchBtn) {
                        const isChecked = switchBtn.getAttribute('aria-checked') === 'true';
                        const targetChecked = (mode === 'validate');

                        if (isChecked === targetChecked) {
                            showToast(`Skipped (Already ${mode}d): ${currentTarget}`);
                            const cancelBtn = panelDoc.querySelector('.upsert-entity__cancel-button');
                            if (cancelBtn) clickElement(cancelBtn, panelDoc);
                            completed.push(currentTarget);
                            localStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
                            localStorage.removeItem(ACTIVE_CLICK_KEY);
                            setTimeout(processValidator, 800);
                            return;
                        }

                        // Toggle switch
                        clickElement(switchBtn, panelDoc);

                        // Save
                        setTimeout(() => {
                            const saveBtn = panelDoc.querySelector('.upsert-entity__save-button') || Array.from(panelDoc.querySelectorAll('button')).find(b => b.textContent.includes('Save'));
                            if (saveBtn) {
                                clickElement(saveBtn, panelDoc);
                                setTimeout(() => {
                                    // Handle confirmation modal if it exists
                                    const btns = scanAllDocs('button.ant-btn-primary', 'save');
                                    if (btns.length > 0) clickElement(btns[btns.length - 1].el, btns[btns.length - 1].doc);
                                    
                                    completed.push(currentTarget);
                                    localStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
                                    localStorage.removeItem(ACTIVE_CLICK_KEY);
                                    setTimeout(processValidator, 1500);
                                }, 1000);
                            }
                        }, 500);
                        return;
                    } else {
                        // Switch not found? Maybe already validated or different UI?
                        showToast(`Switch not found for ${currentTarget}`);
                        const cancelBtn = panelDoc.querySelector('.upsert-entity__cancel-button');
                        if (cancelBtn) clickElement(cancelBtn, panelDoc);
                        completed.push(currentTarget);
                        localStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
                        localStorage.removeItem(ACTIVE_CLICK_KEY);
                        setTimeout(processValidator, 800);
                        return;
                    }
                } else {
                    const cancelBtn = panelDoc.querySelector('.upsert-entity__cancel-button');
                    if (cancelBtn) { clickElement(cancelBtn, panelDoc); setTimeout(processValidator, 1000); return; }
                }
            }

            const sidebarItems = scanAllDocs('.map-entities__entity-item');
            let foundVisible = false;
            for (let item of sidebarItems) {
                const name = item.el.querySelector('.map-entities__entity-name')?.textContent.trim();
                if (name === currentTarget) {
                    item.el.scrollIntoView({ block: 'center' });
                    setTimeout(() => {
                        localStorage.setItem(ACTIVE_CLICK_KEY, currentTarget);
                        clickElement(item.el, item.doc);
                        setTimeout(processValidator, 2000);
                    }, 500);
                    foundVisible = true;
                    break;
                }
            }

            if (!foundVisible && sidebarItems.length > 0) {
                const list = sidebarItems[0].el.closest('.map-entities__virtualized-list') || sidebarItems[0].el.parentElement;
                if (list) {
                    list.scrollTop += list.clientHeight * 0.7;
                    if (list.scrollTop + list.clientHeight >= list.scrollHeight) {
                        // If we've scrolled to the end and haven't found it, skip it
                        completed.push(currentTarget);
                        localStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
                    }
                    setTimeout(processValidator, 1000);
                }
            }
        }

        window.addEventListener('keydown', (e) => {
            // Defer to panel router once detected; respect master toggle.
            if (controlPanelDetected) return;
            if (!masterEnabled) return;
            if (e.shiftKey && e.key.toLowerCase() === 'v') {
                const el = e.target;
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.closest('.ant-input')) return;
                e.preventDefault(); e.stopImmediatePropagation();
                createUI();
            }
        }, true);

        if (localStorage.getItem(DATA_KEY)) setTimeout(processValidator, 1000);
    }

    if (document.readyState === "complete" || document.readyState === "interactive") init();
    else window.addEventListener("DOMContentLoaded", init);
})();
