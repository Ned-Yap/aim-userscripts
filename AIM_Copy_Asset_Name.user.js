// ==UserScript==
// @name         AIM Copy Asset Name
// @namespace    http://tampermonkey.net/
// @version      1.5
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Copy_Asset_Name.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Copy_Asset_Name.user.js
// @description  Copies the name of an asset on hover using Shift+Ctrl+Q. Registers with the AIM Control Panel for master toggle + hotkey rebinding.
// @author       Payden / Gemini
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const CONTEXT = window === window.top ? "TOP" : "IFRAME";
    console.log(`[AIM COPY] 🚀 Script v1.3 starting in ${CONTEXT}... URL: ${window.location.href}`);

    const CHANNEL_NAME = "AIM_COPY_CHANNEL";
    const channel = new BroadcastChannel(CHANNEL_NAME);

    // --- Toast Logic (Only in TOP) ---
    if (CONTEXT === "TOP") {
        channel.onmessage = (e) => {
            if (e.data.action === "SHOW_TOAST") showToast(e.data.message, e.data.color);
        };

        function showToast(message, color = '#417690') {
            const existing = document.getElementById('copy-toast');
            if (existing) existing.remove();
            const msg = document.createElement('div');
            msg.id = 'copy-toast';
            msg.innerHTML = message;
            Object.assign(msg.style, {
                position: 'fixed', bottom: '20px', right: '20px', backgroundColor: color, color: 'white',
                padding: '12px 20px', borderRadius: '8px', zIndex: '999999', fontSize: '14px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontFamily: 'sans-serif', pointerEvents: 'none', transition: 'opacity 0.5s'
            });
            document.body.appendChild(msg);
            setTimeout(() => { msg.style.opacity = '0'; setTimeout(() => msg.remove(), 500); }, 2500);
        }
    }

    function triggerToast(message, color) {
        if (CONTEXT === "TOP") {
            window.top.postMessage({ action: "SHOW_TOAST", message, color }, "*");
        }
        channel.postMessage({ action: "SHOW_TOAST", message, color });
    }

    function performCopy(text) {
        if (!text) return false;
        const cleanText = text.trim();
        if (!cleanText) return false;
        
        navigator.clipboard.writeText(cleanText).then(() => {
            triggerToast(`Copied: <b>${cleanText}</b>`);
            console.log(`[AIM COPY] ✅ Successfully copied: "${cleanText}"`);
        }).catch(err => {
            console.error("[AIM COPY] Clipboard API failed, trying textarea fallback...", err);
            const ta = document.createElement("textarea");
            ta.value = cleanText;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            triggerToast(`Copied: <b>${cleanText}</b>`);
        });
        return true;
    }

    // --- AIM Control Panel integration ---
    const IS_TOP = CONTEXT === "TOP";
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-copy-asset';
    const SCRIPT_VERSION = '1.5';
    let controlChannel = null;
    let controlPanelDetected = false;
    let masterEnabled = true;
    let doPerformCopy = null; // assigned below before the channel may need it

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
                if (msg.hotkeyId === 'invoke' && masterEnabled && doPerformCopy) doPerformCopy();
            }
        };
    }
    function registerWithControlPanel() {
        if (!controlChannel) return;
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Copy Asset Name',
            version: SCRIPT_VERSION, group: 'Hotkeys',
            toggles: [{ id: 'master', label: 'Enable', type: 'boolean', default: true, master: true }],
            hotkeys: [{ id: 'invoke', label: 'Copy hovered asset name', default: 'Shift+Ctrl+Q' }],
        });
    }
    setupControlPanel();
    registerWithControlPanel();

    // Wrapped so the panel's HOTKEY_FIRED handler can call the same logic.
    doPerformCopy = function performHotkeyAction() {
        const potentialTooltips = document.querySelectorAll('.leaflet-tooltip, .ant-tooltip-inner, [role="tooltip"], .tooltip-inner');
        let foundText = null;
        for (let t of potentialTooltips) {
            const style = window.getComputedStyle(t);
            const opacity = parseFloat(style.opacity);
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && opacity > 0.1;
            if (isVisible) {
                const span = t.querySelector('span');
                const text = (span ? span.innerText : t.innerText).trim();
                if (text) { foundText = text; break; }
            }
        }
        if (foundText) performCopy(foundText);
        else if (CONTEXT === "TOP") triggerToast('⚠️ No active tooltip found!', '#ff9800');
    };

    window.addEventListener('keydown', (e) => {
        if (controlPanelDetected) return; // panel routes via HOTKEY_FIRED
        if (!masterEnabled) return;
        const isQ = (e.key === 'Q' || e.key === 'q' || e.code === 'KeyQ');
        if (isQ && e.shiftKey && (e.ctrlKey || e.metaKey)) {
            console.log(`[AIM COPY] 🔑 Hotkey detected in ${CONTEXT}. Searching...`);

            // Check if we are in an input field
            const el = e.target;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.closest('.ant-input')) {
                console.log("[AIM COPY] ⌨️ Focus is in an input field. Ignoring hotkey.");
                return;
            }

            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();

            // 1. Broad search for any tooltip-like element
            const potentialTooltips = document.querySelectorAll('.leaflet-tooltip, .ant-tooltip-inner, [role="tooltip"], .tooltip-inner');
            console.log(`[AIM COPY] Found ${potentialTooltips.length} tooltip candidates.`);

            let foundText = null;
            for (let t of potentialTooltips) {
                const style = window.getComputedStyle(t);
                const opacity = parseFloat(style.opacity);
                const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && opacity > 0.1;
                
                if (isVisible) {
                    // Specific check for span inside (as found by user)
                    const span = t.querySelector('span');
                    const text = (span ? span.innerText : t.innerText).trim();
                    if (text) {
                        foundText = text;
                        console.log(`[AIM COPY] Using text from visible tooltip: "${text}" (Opacity: ${opacity})`);
                        break;
                    }
                }
            }

            if (foundText) {
                performCopy(foundText);
            } else {
                console.warn("[AIM COPY] No visible tooltip found with text.");
                if (CONTEXT === "TOP") triggerToast('⚠️ No active tooltip found!', '#ff9800');
            }
        }
    }, true);

    console.log(`[AIM COPY] 🛰️ Script v1.3 fully loaded in ${CONTEXT}`);
})();
