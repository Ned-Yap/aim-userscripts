// ==UserScript==
// @name         AIM Sidebar Resizer
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  v3.2: Map Recovery. Restores map visibility by forcing sibling height and flex-growth.
// @author       Payden / Gemini
// @match        *://percepto.app/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const WIDTH_KEY = "AIM_SIDEBAR_WIDTH_V32";

    function setupResizer() {
        const sidebar = document.querySelector('.site-setup__content');
        const handleId = 'aim-resizer-bar-v32';
        
        if (!sidebar || document.getElementById(handleId)) return;

        console.log("[AIM SIDEBAR] Sidebar detected. Attaching v3.2 (Map Fix)...");

        let styleTag = document.getElementById('aim-sidebar-styles-v32');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'aim-sidebar-styles-v32';
            document.head.appendChild(styleTag);
        }

        function updateCSS(width) {
            const w = Math.max(260, Math.min(1200, width));
            styleTag.innerHTML = `
                :root { --aim-sidebar-width: ${w}px; }
                
                .site-setup {
                    display: flex !important;
                    flex-direction: row !important;
                    height: 100vh !important;
                    width: 100vw !important;
                    overflow: hidden !important;
                }
                
                .site-setup__content {
                    width: var(--aim-sidebar-width) !important;
                    min-width: var(--aim-sidebar-width) !important;
                    max-width: var(--aim-sidebar-width) !important;
                    flex: 0 0 var(--aim-sidebar-width) !important;
                    height: 100% !important;
                    position: relative !important;
                    display: flex !important;
                    flex-direction: column !important;
                }
                
                #${handleId} {
                    width: 6px !important;
                    height: 100% !important;
                    background-color: #417690 !important;
                    cursor: col-resize !important;
                    z-index: 1000 !important;
                    flex: 0 0 6px !important;
                    border-left: 1px solid rgba(255,255,255,0.2);
                }

                /* MAP FIX: Force the sibling to fill remaining width AND height */
                .site-setup__content + div, 
                .site-setup__content ~ div:not(#${handleId}) {
                    flex: 1 1 auto !important;
                    min-width: 0 !important;
                    height: 100% !important;
                    display: block !important;
                    visibility: visible !important;
                }
                
                .site-setup-header {
                    display: flex !important;
                    flex-direction: row !important;
                    justify-content: flex-end !important;
                    align-items: center !important;
                    gap: 4px !important;
                    flex-wrap: nowrap !important;
                }
                .site-setup-header__title { margin-right: auto !important; white-space: nowrap !important; }

                .map-entities__virtualized-list, .map-entities__autosizer, .map-entities, .map-entities__list {
                    width: 100% !important;
                }
            `;
            localStorage.setItem(WIDTH_KEY, w);
        }

        const bar = document.createElement('div');
        bar.id = handleId;
        sidebar.after(bar);

        const shield = document.createElement('div');
        Object.assign(shield.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            zIndex: '999999', cursor: 'col-resize', display: 'none'
        });
        document.body.appendChild(shield);

        let isDragging = false;
        bar.onmousedown = (e) => {
            isDragging = true;
            shield.style.display = 'block';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        };

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const rect = sidebar.getBoundingClientRect();
            updateCSS(e.clientX - rect.left);
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                shield.style.display = 'none';
                document.body.style.userSelect = '';
                
                window.dispatchEvent(new Event('resize'));
                document.querySelectorAll('iframe').forEach(f => {
                    try { if (f.contentWindow) f.contentWindow.dispatchEvent(new Event('resize')); } catch(e){}
                });
            }
        });

        const saved = parseInt(localStorage.getItem(WIDTH_KEY)) || 350;
        updateCSS(saved);
    }

    setInterval(setupResizer, 1000);

    window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'R') {
            localStorage.setItem(WIDTH_KEY, "350");
            location.reload();
        }
    });

})();
