// ==UserScript==
// @name         AIM Bulk Mission Adder
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Bulk add missions via Shift+B or Green Button. Turbo speed + Auto-Clone + High Contrast List.
// @author       Payden / Gemini
// @match        *://percepto.app/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    console.log("[AIM BULK] 🛰️ Script attempting to load...");

    const STORAGE_KEY = "AIM_BULK_QUEUE";
    const REMOVAL_KEY = "AIM_BULK_REMOVE_QUEUE";
    const LOG_KEY = "AIM_BULK_LOGS";

    function init() {
        console.log("[AIM BULK] 🚀 Script fully initialized.");

        // Helper to ensure we are on the correct step 2 page
        function isTargetPage() {
            return window.location.href.includes('/merge_available_apps/step2/');
        }

        // --- UPDATED: Contrast Boost for the list ---
        function injectStyles() {
            if (document.getElementById('aim-contrast-styles')) return;
            const style = document.createElement('style');
            style.id = 'aim-contrast-styles';
            style.textContent = `
                /* Targets the list items containing the remove buttons */
                li:has(button[name="remove_app"]) {
                    background-color: #333333 !important; /* Dark Grey background */
                    color: #00FFFF !important; /* Bright Cyan */
                    font-weight: bold !important;
                    border-color: #555555 !important;
                }
                li:has(button[name="remove_app"]) strong {
                    color: #00FFFF !important; /* Bright Cyan */
                }
                /* The custom Bulk Add button */
                .aim-bulk-add-btn {
                    margin-left: 10px; 
                    padding: 8px 16px; 
                    background: #28a745 !important; /* Green */
                    color: white !important; 
                    border: none; 
                    border-radius: 4px; 
                    cursor: pointer; 
                    font-size: 14px;
                    font-weight: bold;
                    transition: opacity 0.2s;
                }
                .aim-bulk-add-btn:hover { opacity: 0.8; }
            `;
            document.head.appendChild(style);
        }

        // --- NEW: Install the physical "Bulk Add" button ---
        function installBulkButton() {
            if (!isTargetPage()) return;
            
            const addMoreBtn = document.querySelector('button[name="add_more"]');
            if (addMoreBtn && !document.getElementById('aim-bulk-trigger-btn')) {
                const bulkBtn = document.createElement('button');
                bulkBtn.id = 'aim-bulk-trigger-btn';
                bulkBtn.type = 'button';
                bulkBtn.className = 'aim-bulk-add-btn';
                bulkBtn.innerText = 'Bulk Add';
                bulkBtn.onclick = (e) => {
                    e.preventDefault();
                    createUI();
                };
                // Insert after the Add More button
                addMoreBtn.parentNode.insertBefore(bulkBtn, addMoreBtn.nextSibling);
            }
        }

        // --- Auto-Clone on Merge ---
        function installMergeIntercept() {
            if (!isTargetPage()) return;
            const mergeBtn = document.querySelector('button[name="merge"]');
            if (mergeBtn && !mergeBtn.dataset.aimIntercepted) {
                mergeBtn.dataset.aimIntercepted = "true";
                mergeBtn.addEventListener('click', (e) => {
                    console.log("[AIM BULK] 🔄 Merge clicked. Cloning page to new tab...");
                    window.open(window.location.href, '_blank');
                });
                // Visual indicator that it's enhanced
            mergeBtn.title = "Enhanced by AIM: Will open clone in new tab";
                mergeBtn.style.border = "2px solid #417690";
            }
        }

        function createUI(existingLines = []) {
            if (document.getElementById('aim-bulk-modal')) return;

            const modal = document.createElement('div');
            modal.id = 'aim-bulk-modal';
            Object.assign(modal.style, {
                position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                backgroundColor: '#fff', padding: '20px', border: '2px solid #417690',
                borderRadius: '8px', zIndex: '100000', boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
                width: '400px', color: '#333', fontFamily: 'sans-serif'
            });

            const initialValue = existingLines.join('\n');
            const hasRemoveButtons = document.querySelectorAll('button[name="remove_app"]').length > 0;

            modal.innerHTML = `
                <h3 style="margin-top:0; color:#417690;">Bulk Mission Adder</h3>
                <p style="font-size:12px; color:#666;">Paste mission names (one per line):</p>
                <textarea id="aim-bulk-input" style="width:100%; height:200px; margin-bottom:10px; border:1px solid #ccc; border-radius:4px; padding:5px; color: black; background: white;">${initialValue}</textarea>
                
                <div style="display:flex; justify-content: space-between; align-items: center;">
                    <div>
                        ${hasRemoveButtons ? `<button id="aim-bulk-clear-all" style="padding:8px 12px; border:none; background:#dc3545; color:white; cursor:pointer; border-radius:4px; font-size:12px;">Clear All Added</button>` : ''}
                    </div>
                    <div style="display:flex; gap: 10px;">
                        <button id="aim-bulk-cancel" style="padding:8px 15px; border:1px solid #ccc; background:#eee; cursor:pointer; border-radius:4px; color: black;">Cancel</button>
                        <button id="aim-bulk-start" style="padding:8px 15px; border:none; background:#417690; color:white; cursor:pointer; border-radius:4px;">Start Adding</button>
                    </div>
                </div>
            `;

            const overlay = document.body.querySelector('#aim-bulk-overlay') || document.createElement('div');
            if (!overlay.parentNode) {
                overlay.id = 'aim-bulk-overlay';
                Object.assign(overlay.style, {
                    position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: '99999'
                });
                document.body.appendChild(overlay);
            }

            document.body.appendChild(modal);

            document.getElementById('aim-bulk-cancel').onclick = () => { modal.remove(); overlay.remove(); };
            
            if (hasRemoveButtons) {
                document.getElementById('aim-bulk-clear-all').onclick = () => {
                    if (confirm("This will remove ALL added missions one by one. Continue?")) {
                        const buttons = Array.from(document.querySelectorAll('button[name="remove_app"]'));
                        const ids = buttons.map(btn => btn.value);
                        localStorage.setItem(REMOVAL_KEY, JSON.stringify(ids));
                        modal.remove(); overlay.remove();
                        processNextRemoval();
                    }
                };
            }

            document.getElementById('aim-bulk-start').onclick = () => {
                const text = document.getElementById('aim-bulk-input').value;
                const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
                if (lines.length > 0) {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
                    localStorage.setItem(LOG_KEY, JSON.stringify([]));
                    modal.remove(); overlay.remove();
                    processNext();
                } else { alert("Please enter at least one mission name."); }
            };
        }

        function showStatus(message, isError = false) {
            let status = document.getElementById('aim-bulk-status');
            if (!status) {
                status = document.createElement('div');
                status.id = 'aim-bulk-status';
                Object.assign(status.style, {
                    position: 'fixed', bottom: '20px', right: '20px', padding: '10px 20px',
                    borderRadius: '5px', zIndex: '100001', color: 'white', fontWeight: 'bold',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.2)'
                });
                document.body.appendChild(status);
            }
            status.style.backgroundColor = isError ? '#cc0000' : '#417690';
            status.innerHTML = message + ` <button id="aim-stop-bulk" style="margin-left:10px; background:white; color:black; border:none; border-radius:3px; cursor:pointer; font-size:10px; padding:2px 5px;">STOP</button>`;
            document.getElementById('aim-stop-bulk').onclick = () => {
                localStorage.removeItem(STORAGE_KEY);
                localStorage.removeItem(REMOVAL_KEY);
                status.remove();
                alert("Bulk process stopped.");
            };
        }

        // --- Removal Logic ---
        function processNextRemoval() {
            const queueRaw = localStorage.getItem(REMOVAL_KEY);
            if (!queueRaw) return;

            const queue = JSON.parse(queueRaw);
            if (queue.length === 0) {
                localStorage.removeItem(REMOVAL_KEY);
                alert("All missions removed.");
                if (document.getElementById('aim-bulk-status')) document.getElementById('aim-bulk-status').remove();
                return;
            }

            const nextId = queue[0];
            showStatus(`Removing missions... (${queue.length} left)`);

            const btn = document.querySelector(`button[name="remove_app"][value="${nextId}"]`);
            if (btn) {
                queue.shift();
                localStorage.setItem(REMOVAL_KEY, JSON.stringify(queue));
                setTimeout(() => { btn.click(); }, 150);
            } else {
                queue.shift();
                localStorage.setItem(REMOVAL_KEY, JSON.stringify(queue));
                processNextRemoval();
            }
        }

        // --- Core Adding Logic ---
        function processNext() {
            const queueRaw = localStorage.getItem(STORAGE_KEY);
            if (!queueRaw) return;

            const queue = JSON.parse(queueRaw);
            if (queue.length === 0) {
                localStorage.removeItem(STORAGE_KEY);
                const logs = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
                alert("Bulk process complete!\n\nSummary:\n" + logs.join('\n'));
                return;
            }

            const currentMission = queue[0];
            showStatus(`Processing: ${currentMission} (${queue.length} left)`);

            const select = document.getElementById('id_add_app');
            const btn = document.querySelector('button[name="add_more"]');

            if (!select || !btn) {
                console.warn("[AIM BULK] Elements not found on this page.");
                return;
            }

            function getCleanSuffix(str) {
                if (!str) return "";
                let clean = str.replace(/[\s\xA0]+/g, ' ').trim();
                const separatorRegex = / [-\u2013\u2014] /;
                const match = clean.match(separatorRegex);
                if (match) {
                    clean = clean.substring(match.index + match[0].length).trim();
                }
                return clean.toLowerCase();
            }

            const targetClean = getCleanSuffix(currentMission);
            let matchValue = null;

            for (let i = 0; i < select.options.length; i++) {
                const opt = select.options[i];
                if (getCleanSuffix(opt.text) === targetClean) {
                    matchValue = opt.value;
                    break;
                }
            }

            const logs = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
            if (matchValue) {
                select.value = matchValue;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                
                queue.shift();
                localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
                logs.push(`✅ Added: ${currentMission}`);
                localStorage.setItem(LOG_KEY, JSON.stringify(logs));

                setTimeout(() => { btn.click(); }, 150);
            } else {
                console.error(`[AIM BULK] Match failed: "${currentMission}"`);
                localStorage.removeItem(STORAGE_KEY);
                if (document.getElementById('aim-bulk-status')) document.getElementById('aim-bulk-status').remove();
                alert(`🛑 MISSION NOT FOUND!\n\nThe script could not find:\n"${currentMission}"\n\nThe process has been halted.`);
                createUI(queue);
            }
        }

        window.addEventListener('keydown', (e) => {
            const isB = (e.key && e.key.toLowerCase() === 'b');
            if (e.shiftKey && isB) {
                if (!isTargetPage()) return;
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
                e.preventDefault(); e.stopImmediatePropagation();
                createUI();
            }
        }, true);

        // Continuous monitoring
        setInterval(() => {
            installMergeIntercept();
            installBulkButton();
            injectStyles();
        }, 1000);

        if (localStorage.getItem(STORAGE_KEY)) {
            setTimeout(processNext, 300);
        } else if (localStorage.getItem(REMOVAL_KEY)) {
            setTimeout(processNextRemoval, 300);
        }
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        init();
    } else {
        window.addEventListener("DOMContentLoaded", init);
    }
})();