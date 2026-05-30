// ==UserScript==
// @name         Latest - AIM Bulk Altitude Updater
// @namespace    http://tampermonkey.net/
// @version      4.12
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Bulk_Altitude_Updater.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Bulk_Altitude_Updater.user.js
// @description  Pause-enabled bulk altitude updater with double-check logic. Prep Pass -> Pause (Update Data) -> Final Pass.
// @author       Payden
// @match        *://percepto.app/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const DATA_KEY = "AIM_ALT_MAP";
    const STAGE_KEY = "AIM_ALT_STAGE"; 
    const OFFSET_MODE_KEY = "AIM_ALT_OFFSET_MODE";
    const CUSTOM_OFFSET_KEY = "AIM_ALT_CUSTOM_VAL";
    const COMPLETED_KEY = "AIM_ALT_COMPLETED";
    const ACTIVE_CLICK_KEY = "AIM_ALT_LAST_CLICKED";
    const TAB_LOCK_KEY = "AIM_ALT_TAB_ID";

    if (!window.name) window.name = "aim_tab_" + Math.random().toString(36).substr(2, 9);
    const MY_TAB_ID = window.name;

    function init() {
        console.log("[AIM ALT v4.7] 🚀 Hunter Initialized. Double-Check logic active.");

        // --- AIM Control Panel integration ---
        // Master toggle + rebindable Shift+E hotkey. Existing keydown defers
        // when panel is detected. IS_TOP gates the action so it only fires
        // once across all frame contexts. createUI() is defined later in
        // init() but available by closure at HOTKEY_FIRED dispatch time.
        const IS_TOP = window === window.top;
        const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
        const SCRIPT_ID = 'aim-bulk-altitude-updater';
        const SCRIPT_VERSION = '4.12';
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
                type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Bulk Altitude Updater',
                description: 'Pause-enabled bulk altitude updater with double-check (prep → pause → final).',
                version: SCRIPT_VERSION,
                group: 'Site Setup Macros', scope: 'site-setup', priority: 80,
                toggles: [{ id: 'master', label: 'Enable', type: 'boolean', default: true, master: true }],
                hotkeys: [{ id: 'invoke', label: 'Open Bulk Altitude Updater', default: 'Shift+E' }],
            });
        }
        setupControlPanel();
        registerWithControlPanel();

        // --- UI Trigger Injection ---
        function runInjection() {
            function inject(doc) {
                const isEditing = !!doc.querySelector('.upsert-entity');
                const existingBtn = doc.getElementById('aim-alt-trigger-btn');
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
                        btn.id = 'aim-alt-trigger-btn';
                        btn.type = 'button';
                        btn.className = newBtnRef ? newBtnRef.className : 'ant-btn ant-btn-primary ant-btn-sm';
                        Object.assign(btn.style, {
                            minWidth: 'unset',
                            padding: '0 12px',
                            height: '24px',
                            fontSize: '10px',
                            fontWeight: 'bold'
                        });
                        btn.innerHTML = `ALT`;

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
            const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
            const altMap = {};
            lines.forEach(line => {
                const parts = line.split(/[\t,]{1,}|\s{2,}/).map(p => p.trim());
                if (parts.length >= 2) {
                    let fullName = parts[0];
                    const elev = parseFloat(parts[1].replace(/[^\d.]/g, ''));
                    if (isNaN(elev)) return;
                    const segMatch = fullName.match(/(.+) - Seg (\d+)/i);
                    if (segMatch) {
                        const baseName = segMatch[1].trim();
                        const segIndex = parseInt(segMatch[2]) - 1; 
                        if (!altMap[baseName]) altMap[baseName] = [];
                        altMap[baseName][segIndex] = elev;
                    } else {
                        if (!altMap[fullName]) altMap[fullName] = [];
                        altMap[fullName][0] = elev;
                    }
                }
            });
            return altMap;
        }

        function createUI() {
            if (document.getElementById('aim-alt-modal')) return;
            const modal = document.createElement('div');
            modal.id = 'aim-alt-modal';
            Object.assign(modal.style, {
                position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                backgroundColor: '#fff', padding: '20px', border: '2px solid #417690',
                borderRadius: '8px', zIndex: '100000', boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
                width: '520px', color: '#333', fontFamily: 'sans-serif'
            });

            modal.innerHTML = `
                <h3 style="margin-top:0; color:#417690;">Bulk Altitude Hunter v4.7</h3>
                <div style="margin-bottom: 10px; background: #f1f7f9; padding: 12px; border-radius: 4px; border: 1px solid #c5dce3; font-size: 13px;">
                    <div style="margin-bottom: 8px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                        <span style="font-weight: bold;">MaxAlt Height:</span>
                        <label style="cursor:pointer; color: #004d40; font-weight: bold;">
                            <input type="radio" name="aim-alt-offset" value="smart" checked> Smart (Auto 20/30)
                        </label>
                        <label style="cursor:pointer;"><input type="radio" name="aim-alt-offset" value="20"> FP (+20)</label>
                        <label style="cursor:pointer;"><input type="radio" name="aim-alt-offset" value="30"> FFZ (+30)</label>
                        <label style="cursor:pointer; display: flex; align-items: center; gap: 5px;">
                            <input type="radio" name="aim-alt-offset" value="other"> Custom: 
                            <input type="number" id="aim-alt-other-val" style="width:45px;" value="40">
                        </label>
                    </div>
                </div>
                <textarea id="aim-alt-input" style="width:100%; height:160px; margin-bottom:10px; border:1px solid #ccc; border-radius:4px; padding:5px; white-space: pre; font-family: monospace; font-size: 12px;" placeholder="freezone_1    2792\nflight_path_7 - Seg 1    2793..."></textarea>
                <div style="display:flex; justify-content: flex-end; gap: 10px;">
                    <button id="aim-alt-cancel" style="padding:8px 15px; border:1px solid #ccc; background:#eee; cursor:pointer; border-radius:4px;">Cancel</button>
                    <button id="aim-alt-start" style="padding:8px 20px; border:none; background:#417690; color:white; cursor:pointer; border-radius:4px; font-weight:bold;">Start Hunting</button>
                </div>
            `;
            document.body.appendChild(modal);

            document.getElementById('aim-alt-cancel').onclick = () => { modal.remove(); };
            document.getElementById('aim-alt-start').onclick = () => {
                const altMap = parseDataText(document.getElementById('aim-alt-input').value);
                if (Object.keys(altMap).length > 0) {
                    localStorage.setItem(DATA_KEY, JSON.stringify(altMap));
                    localStorage.setItem(OFFSET_MODE_KEY, document.querySelector('input[name="aim-alt-offset"]:checked').value);
                    localStorage.setItem(CUSTOM_OFFSET_KEY, document.getElementById('aim-alt-other-val').value);
                    localStorage.setItem(COMPLETED_KEY, JSON.stringify([]));
                    localStorage.setItem(STAGE_KEY, "prep");
                    localStorage.setItem(TAB_LOCK_KEY, MY_TAB_ID); 
                    modal.remove();
                    processHunter();
                }
            };
        }

        function createPauseUI() {
            if (document.getElementById('aim-alt-pause-modal')) return;
            const modal = document.createElement('div');
            modal.id = 'aim-alt-pause-modal';
            Object.assign(modal.style, {
                position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                backgroundColor: '#fff', padding: '20px', border: '3px solid #f39c12',
                borderRadius: '8px', zIndex: '100005', boxShadow: '0 4px 15px rgba(0,0,0,0.4)',
                width: '520px', color: '#333', fontFamily: 'sans-serif'
            });

            modal.innerHTML = `
                <h2 style="margin-top:0; color:#f39c12;">⚠️ PREP PASS COMPLETE</h2>
                <p style="font-size:14px;">The 25-9999ft pass is finished. Because AIM randomizes segments after saving, you must now:</p>
                <ol style="font-size:13px; line-height:1.4;">
                    <li><b>Regenerate</b> your spreadsheet altitude list now.</li>
                    <li>Paste the <b>Fresh List</b> (with new segment labels) below.</li>
                </ol>
                <textarea id="aim-alt-refresh-input" style="width:100%; height:160px; margin-bottom:10px; border:1px solid #ccc; border-radius:4px; padding:5px; white-space: pre; font-family: monospace; font-size: 12px;" placeholder="Paste NEWly generated segment list here..."></textarea>
                <div style="display:flex; justify-content: flex-end; gap: 10px;">
                    <button id="aim-alt-abort" style="padding:8px 15px; border:1px solid #ccc; background:#eee; cursor:pointer; border-radius:4px;">Abort</button>
                    <button id="aim-alt-resume" style="padding:8px 20px; border:none; background:#f39c12; color:white; cursor:pointer; border-radius:4px; font-weight:bold;">Resume Final Pass</button>
                </div>
            `;
            document.body.appendChild(modal);

            document.getElementById('aim-alt-abort').onclick = () => {
                localStorage.removeItem(DATA_KEY); localStorage.removeItem(COMPLETED_KEY); localStorage.removeItem(STAGE_KEY); localStorage.removeItem(TAB_LOCK_KEY);
                modal.remove();
                location.reload();
            };
            document.getElementById('aim-alt-resume').onclick = () => {
                const newAltMap = parseDataText(document.getElementById('aim-alt-refresh-input').value);
                if (Object.keys(newAltMap).length > 0) {
                    localStorage.setItem(DATA_KEY, JSON.stringify(newAltMap));
                    localStorage.setItem(COMPLETED_KEY, JSON.stringify([]));
                    localStorage.setItem(STAGE_KEY, "final");
                    modal.remove();
                    processHunter();
                } else {
                    alert("Please paste the updated list to continue.");
                }
            };
        }

        function showStatus(message, isError = false) {
            let status = document.getElementById('aim-alt-status');
            if (!status) {
                status = document.createElement('div');
                status.id = 'aim-alt-status';
                Object.assign(status.style, {
                    position: 'fixed', bottom: '20px', right: '20px', padding: '10px 20px',
                    borderRadius: '5px', zIndex: '100001', color: 'white', fontWeight: 'bold', boxShadow: '0 2px 10px rgba(0,0,0,0.2)'
                });
                document.body.appendChild(status);
            }
            status.style.backgroundColor = isError ? '#cc0000' : '#417690';
            status.innerHTML = message + ` <button id="aim-stop-alt" style="margin-left:10px; background:white; color:black; border:none; border-radius:3px; cursor:pointer; font-size:10px; padding:2px 5px;">STOP</button>`;
            document.getElementById('aim-stop-alt').onclick = () => {
                localStorage.removeItem(DATA_KEY); localStorage.removeItem(COMPLETED_KEY); localStorage.removeItem(STAGE_KEY); localStorage.removeItem(TAB_LOCK_KEY);
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

        function setInputValue(input, value) {
            if (!input) return;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        }

        function findInputs(doc) {
            const minInputs = [], maxInputs = [];
            const tableRows = doc.querySelectorAll('.flight-path-form-content__table-row');
            if (tableRows.length > 0) {
                tableRows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 3) {
                        const min = cells[1].querySelector('input.ant-input-number-input');
                        const max = cells[2].querySelector('input.ant-input-number-input');
                        if (min) minInputs.push(min); if (max) maxInputs.push(max);
                    }
                });
            }
            if (minInputs.length === 0) {
                Array.from(doc.querySelectorAll('label')).forEach(label => {
                    const txt = label.textContent.toLowerCase();
                    if (txt.includes('min') && (txt.includes('alt') || txt.includes('elev'))) {
                        let input = label.getAttribute('for') ? doc.getElementById(label.getAttribute('for')) : null;
                        if (!input) input = (label.closest('.ant-form-item') || label.parentElement).querySelector('input');
                        if (input) minInputs.push(input);
                    } else if (txt.includes('max') && (txt.includes('alt') || txt.includes('elev'))) {
                        let input = label.getAttribute('for') ? doc.getElementById(label.getAttribute('for')) : null;
                        if (!input) input = (label.closest('.ant-form-item') || label.parentElement).querySelector('input');
                        if (input) maxInputs.push(input);
                    }
                });
            }
            if (minInputs.length === 0 && maxInputs.length === 0) {
                const lone = doc.querySelector('.upsert-entity input.ant-input-number-input');
                if (lone) { minInputs.push(lone); maxInputs.push(lone); }
            }
            return { minInputs, maxInputs };
        }

        function parseUIVal(str) {
            if (!str) return 0;
            return parseFloat(str.replace(/,/g, '').replace(/[^\d.]/g, '')) || 0;
        }

        function processHunter() {
            const lockedTab = localStorage.getItem(TAB_LOCK_KEY);
            if (lockedTab && lockedTab !== MY_TAB_ID) return; 

            const stage = localStorage.getItem(STAGE_KEY);
            if (stage === "pause") { createPauseUI(); return; }

            const altMapRaw = localStorage.getItem(DATA_KEY);
            if (!altMapRaw) return;
            const altMap = JSON.parse(altMapRaw);
            const completed = JSON.parse(localStorage.getItem(COMPLETED_KEY) || "[]");
            const offsetMode = localStorage.getItem(OFFSET_MODE_KEY) || "smart";

            const allNames = Object.keys(altMap);
            const pendingNames = allNames.filter(n => !completed.includes(n));

            pendingNames.sort((a, b) => {
                const aIsZone = a.toLowerCase().includes("freezone");
                const bIsZone = b.toLowerCase().includes("freezone");
                if (aIsZone && !bIsZone) return -1;
                if (!aIsZone && bIsZone) return 1;
                return 0;
            });

            if (pendingNames.length === 0) {
                if (stage === "prep") {
                    localStorage.setItem(STAGE_KEY, "pause");
                    showStatus("Prep Pass Complete. Please update data to continue.", true);
                    createPauseUI();
                } else {
                    localStorage.removeItem(DATA_KEY); localStorage.removeItem(COMPLETED_KEY); localStorage.removeItem(STAGE_KEY); localStorage.removeItem(TAB_LOCK_KEY);
                    showStatus("Hunter Process Complete!");
                    setTimeout(() => document.getElementById('aim-alt-status')?.remove(), 3000);
                }
                return;
            }

            const currentTarget = pendingNames[0];
            showStatus(`[${stage.toUpperCase()}] ${currentTarget} (${pendingNames.length} left)`);

            const panels = scanAllDocs('.upsert-entity');
            if (panels.length > 0) {
                const { el: panel, doc: panelDoc } = panels[0];
                const entityTitleEl = panelDoc.querySelector('.upsert-entity__title') || panelDoc.querySelector('.site-setup-header__title');
                const openTitle = entityTitleEl?.textContent.trim().toLowerCase() || "";
                const lastClicked = localStorage.getItem(ACTIVE_CLICK_KEY);

                if (openTitle.includes(currentTarget.toLowerCase()) || lastClicked === currentTarget) {
                    const res = findInputs(panelDoc);
                    const elevations = altMap[currentTarget];
                    let currentOffset = currentTarget.toLowerCase().includes("freezone") ? 30 : 20;
                    if (offsetMode !== "smart") {
                        currentOffset = (offsetMode === "other") ? parseInt(localStorage.getItem(CUSTOM_OFFSET_KEY)) : parseInt(offsetMode);
                    }

                    let isPrepCorrect = true, isFinalCorrect = true;
                    const tolerance = 4;

                    res.minInputs.forEach((input, i) => {
                        const targetMin = (elevations[i] || elevations[0]) + 100;
                        const cur = parseUIVal(input.value);
                        if (Math.abs(cur - 25) > tolerance) isPrepCorrect = false;
                        if (Math.abs(cur - targetMin) > tolerance) isFinalCorrect = false;
                    });

                    res.maxInputs.forEach((input, i) => {
                        const targetMin = (elevations[i] || elevations[0]) + 100;
                        const cur = parseUIVal(input.value);
                        if (Math.abs(cur - 9999) > tolerance) isPrepCorrect = false;
                        const targetMax = (input === res.minInputs[i]) ? targetMin : targetMin + currentOffset;
                        if (Math.abs(cur - targetMax) > tolerance) isFinalCorrect = false;
                    });

                    if (isFinalCorrect || (stage === "prep" && isPrepCorrect)) {
                        showToast(`Skipped: ${currentTarget}`);
                        const cancelBtn = panelDoc.querySelector('.upsert-entity__cancel-button');
                        if (cancelBtn) clickElement(cancelBtn, panelDoc);
                        completed.push(currentTarget);
                        localStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
                        localStorage.removeItem(ACTIVE_CLICK_KEY);
                        setTimeout(processHunter, 800);
                        return;
                    }

                    res.minInputs.forEach((input, i) => {
                        const targetMin = (elevations[i] || elevations[0]) + 100;
                        setInputValue(input, stage === "prep" ? 25 : targetMin);
                    });
                    res.maxInputs.forEach((input, i) => {
                        const targetMin = (elevations[i] || elevations[0]) + 100;
                        if (stage === "prep") setInputValue(input, 9999);
                        else {
                            if (input !== res.minInputs[i]) setInputValue(input, targetMin + currentOffset);
                            else setInputValue(input, targetMin);
                        }
                    });

                    setTimeout(() => {
                        const saveBtn = panelDoc.querySelector('.upsert-entity__save-button') || Array.from(panelDoc.querySelectorAll('button')).find(b => b.textContent.includes('Save'));
                        if (saveBtn) {
                            clickElement(saveBtn, panelDoc);
                            setTimeout(() => {
                                const btns = scanAllDocs('button.ant-btn-primary', 'save');
                                if (btns.length > 0) clickElement(btns[btns.length - 1].el, btns[btns.length - 1].doc);
                                completed.push(currentTarget);
                                localStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
                                localStorage.removeItem(ACTIVE_CLICK_KEY);
                                setTimeout(processHunter, 2000);
                            }, 1000);
                        }
                    }, 800);
                    return;
                } else {
                    const cancelBtn = panelDoc.querySelector('.upsert-entity__cancel-button');
                    if (cancelBtn) { clickElement(cancelBtn, panelDoc); setTimeout(processHunter, 1000); return; }
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
                        setTimeout(processHunter, 2000);
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
                        completed.push(currentTarget);
                        localStorage.setItem(COMPLETED_KEY, JSON.stringify(completed));
                    }
                    setTimeout(processHunter, 1000);
                }
            }
        }

        window.addEventListener('keydown', (e) => {
            // Defer to panel router once detected; respect master toggle.
            if (controlPanelDetected) return;
            if (!masterEnabled) return;
            if (e.shiftKey && e.key.toLowerCase() === 'e') {
                const el = e.target;
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.closest('.ant-input')) return;
                e.preventDefault(); e.stopImmediatePropagation();
                createUI();
            }
        }, true);

        if (localStorage.getItem(DATA_KEY)) setTimeout(processHunter, 1000);
    }

    if (document.readyState === "complete" || document.readyState === "interactive") init();
    else window.addEventListener("DOMContentLoaded", init);
})();
