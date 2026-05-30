// ==UserScript==
// @name         Latest - AIM Power Line Editor
// @namespace    http://tampermonkey.net/
// @version      0.7
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Power_Line_Editor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Power_Line_Editor.user.js
// @description  Floating left-edge toolbar to enter Power Lines edit mode. M1 click any power line → drops vertex handles via Map Styler's existing vertex-edit. Add Line / Commit / Discard buttons + dirty-count badge. Drives Map Styler v34.44+ over AIM_POWER_LINE_EDIT channel.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// What this is
// ============
// A separate-from-Map-Styler editor for KML power lines. Map Styler already
// has the full back-end (enterVertexEdit, enterDrawMode, commitKMLChanges,
// commitOps queue, GitHub PUT pipeline) — this script is the discoverable
// UX layer on top:
//   - Floating ⚡ master toggle on the map's left edge, always visible
//   - When ON, expands a strip of edit buttons (Add Line, Commit, Discard)
//     and starts capturing M1 clicks on power-line SVG paths
//   - M1 on a line → calls Map Styler's enterVertexEdit via channel
//   - When OFF, M1 passes through normally — no behavior change vs today
//   - Dirty-count badge stays in sync via STATUS broadcasts from Styler
//
// All state lives in Map Styler. This script holds NO commit ops, no KML
// data, no GitHub talk. It's purely UI + click detection + channel I/O.
// Log tag: [AIM PLE]

(function () {
    'use strict';

    const TAG = '[AIM PLE]';
    const SCRIPT_VERSION = '0.7';
    const IS_TOP = window === window.top;
    const FRAME = IS_TOP ? 'TOP' : 'IFRAME';

    // v0.4: Split into two independent state knobs.
    //
    // editEnabled (persisted) — controls whether M1 on a power line
    //   enters vertex edit AND whether Map Styler's distro/trans
    //   edit-mode toggles are on. Toggled by **M2 (right-click) on ⚡**.
    //   Visual: bolt at full color + neon-green glow + bigger when ON;
    //   greyscale + no glow when OFF.
    //
    // panelOpen (session only — not persisted) — controls visibility
    //   of the Add/Commit/Discard dropdown panel. Toggled by **M1
    //   (left-click) on ⚡**. Closes automatically when user starts
    //   a draw or vertex edit so the panel doesn't block the map.
    //
    // The split lets the user keep edit mode on continuously (so M1
    // on lines always Just Works) while only opening the panel briefly
    // for the rare add/commit/discard actions. User feedback:
    // "I can't have the big Add buttons eating up a bunch of realestate".
    const EDIT_STORAGE_KEY = 'aim-ple-edit-enabled';
    function readEditEnabled() {
        try { return localStorage.getItem(EDIT_STORAGE_KEY) === 'true'; }
        catch (e) { return false; }
    }
    function writeEditEnabled(on) {
        try { localStorage.setItem(EDIT_STORAGE_KEY, on ? 'true' : 'false'); }
        catch (e) {}
    }

    // ------- Channel I/O -------
    const PLE_CHANNEL_NAME = 'AIM_POWER_LINE_EDIT';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const MAP_STYLER_SCRIPT_ID = 'aim-map-styler';

    let pleChannel = null;
    let controlChannel = null;
    let status = {
        siteID: null,
        distroCount: 0,
        transCount: 0,
        vertexEditActive: false,
        vertexEditType: null,
        vertexEditPmIdx: null,
        drawModeActive: false,
        drawModeType: null,
    };

    function setupChannels() {
        try { pleChannel = new BroadcastChannel(PLE_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} PLE channel unavailable:`, e); }
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} control channel unavailable:`, e); }
        if (pleChannel) {
            pleChannel.onmessage = (ev) => {
                const m = ev.data || {};
                if (m.type === 'STATUS') {
                    status = { ...status, ...m };
                    renderButtonState();
                }
            };
        }
    }

    function sendPle(payload) {
        if (!pleChannel) return;
        try { pleChannel.postMessage(payload); } catch (e) {}
    }
    function requestStatus() { sendPle({ type: 'REQUEST_STATUS' }); }

    // Flip Map Styler's per-category edit-mode toggles via the existing
    // Control Panel SET_TOGGLE mechanism. Map Styler already listens for
    // these on AIM_CONTROL_CHANNEL — no new code in Styler needed for
    // toggle flipping. Also persists into Control Panel prefs so the
    // toggle UI in the gear menu stays in sync.
    function setStylerEditMode(on) {
        if (!controlChannel) return;
        ['distro.edit-mode', 'trans.edit-mode'].forEach(toggleId => {
            try {
                controlChannel.postMessage({
                    type: 'SET_TOGGLE',
                    scriptId: MAP_STYLER_SCRIPT_ID,
                    toggleId,
                    value: on,
                    enabled: on,
                });
            } catch (e) {}
        });
    }

    // ------- State -------
    let editEnabled = readEditEnabled();
    let panelOpen = false; // session only, not persisted

    function setEditEnabled(on) {
        if (on === editEnabled) return;
        editEnabled = on;
        writeEditEnabled(on);
        setStylerEditMode(on);
        if (on) {
            installClickInterceptor();
            requestStatus();
        } else {
            uninstallClickInterceptor();
            // If a vertex edit or draw was in progress, exit it cleanly
            // so the user isn't left with stranded handles.
            if (status.vertexEditActive) sendPle({ type: 'EXIT_VERTEX_EDIT', save: false });
        }
        renderButtonState();
    }

    function setPanelOpen(on) {
        if (on === panelOpen) return;
        panelOpen = on;
        renderButtonState();
    }

    // ------- M1 click interceptor -------
    // Power-line paths in Map Styler are tagged with data-buffer-kind=
    // "kml-distro" / "kml-trans" and data-kml-pm-idx="N". We capture
    // M1 (button 0) clicks at the document level, find the matching
    // path via e.target.closest, and dispatch a vertex-edit command.
    //
    // Capture phase + a `pointerdown` AND `click` pair: Leaflet
    // sometimes eats one or the other depending on what tool is active.
    // Pair-with-debounce gives us a safety net.
    let clickInterceptorInstalled = false;
    let lastClickAt = 0;

    function onLineClick(e) {
        if (!editEnabled) return;
        if (e.button !== 0) return;
        // Don't intercept while a vertex-edit is already active — the
        // user is dragging handles, clicks elsewhere should be ignored
        // OR Leaflet's own drag finish (which arrives as a click). The
        // vertex-edit's own Save/Discard buttons live in a separate
        // floating toolbar (built by Map Styler), so we don't conflict.
        if (status.vertexEditActive) return;
        if (status.drawModeActive) return;
        const t = e.target;
        if (!t || !t.closest) return;
        const path = t.closest('path[data-buffer-kind^="kml-"][data-kml-pm-idx]');
        if (!path) return;
        const kind = path.getAttribute('data-buffer-kind') || '';
        const m = kind.match(/^kml-(distro|trans)$/);
        if (!m) return;
        const kmlType = m[1];
        const pmIdx = parseInt(path.getAttribute('data-kml-pm-idx'), 10);
        if (!Number.isFinite(pmIdx)) return;
        const now = Date.now();
        if (now - lastClickAt < 250) return; // debounce pointerdown+click pair
        lastClickAt = now;
        e.preventDefault();
        e.stopPropagation();
        sendPle({ type: 'ENTER_VERTEX_EDIT', kmlType, pmIdx });
    }

    function installClickInterceptor() {
        if (clickInterceptorInstalled) return;
        // Capture phase: get the event before Leaflet's own handlers.
        document.addEventListener('click', onLineClick, true);
        document.addEventListener('pointerdown', onLineClick, true);
        clickInterceptorInstalled = true;
    }

    function uninstallClickInterceptor() {
        if (!clickInterceptorInstalled) return;
        document.removeEventListener('click', onLineClick, true);
        document.removeEventListener('pointerdown', onLineClick, true);
        clickInterceptorInstalled = false;
    }

    // ------- Toolbar UI -------
    // v0.2: ⚡ button injected into Percepto's `.map-tools` strip (the
    // top-right vertical column of map controls). Mirrors the AIM Control
    // Panel's gear-button injection pattern so it sits naturally alongside
    // the other map tools — same classes, same look, same z-index.
    //
    // When master is ON, a sub-panel appears directly BELOW the ⚡ button
    // (position:absolute, top:calc(100% + 6px), right:0). The sub-panel
    // STAYS OPEN as long as master is ON — unlike the Control Panel
    // dropdown, this isn't dismissed by clicking the map. Click ⚡ again
    // to close.
    //
    // Only IFRAME injects + hosts the toolbar (map lives in the iframe;
    // TOP frame has no `.map-tools` to inject into).
    const BUTTON_CLASS = 'aim-ple-button';
    const PANEL_ID = 'aim-ple-panel';
    let buttonEl = null;
    let panelEl = null;
    let injectTries = 0;
    const INJECT_MAX_TRIES = 60;
    const INJECT_RETRY_MS = 500;

    function findToolsBar() { return document.querySelector('.map-tools'); }

    function swallowMouseEvents(el) {
        ['click', 'dblclick', 'mousedown', 'mouseup',
         'pointerdown', 'pointerup', 'pointermove',
         'wheel', 'contextmenu', 'touchstart', 'touchend'].forEach(evt => {
            el.addEventListener(evt, (e) => e.stopPropagation(), false);
        });
    }

    function injectButton() {
        const tools = findToolsBar();
        if (!tools) return false;
        if (buttonEl && tools.contains(buttonEl)) return true;
        // Match the existing .map-tools__button look. Use the same class
        // soup the host app's other tools use so styling comes for free.
        const wrapper = document.createElement('div');
        // v0.7: z-index pushed to 2147483647 (max safe i32) so ⚡ is
        // guaranteed to paint above the AIM Control Panel dropdown
        // regardless of any intermediate stacking context. Previous v0.6
        // used 100001 which should have worked but the user reported
        // the bolt still being hidden behind the CP. Max value rules
        // out any "another container has higher z-index" possibility.
        wrapper.innerHTML = `
            <div class="ant-dropdown-trigger map-tools__button pr-dropdown ${BUTTON_CLASS}"
                 title="Power Lines edit mode"
                 style="cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;user-select:none;z-index:2147483647;isolation:isolate">
                <span class="aim-ple-icon" style="font-size:18px;line-height:1;color:#e6e6e6">⚡</span>
            </div>
        `;
        const el = wrapper.firstElementChild;
        tools.appendChild(el);
        buttonEl = el;
        swallowMouseEvents(buttonEl); // prevent map-zoom on accidental dblclick
        // v0.4: M1 toggles panel; M2 toggles editing. Separates the
        // visible-but-occasional panel from the persistent edit mode.
        buttonEl.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            setPanelOpen(!panelOpen);
        });
        buttonEl.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            setEditEnabled(!editEnabled);
        });
        // Tooltip hints at both interactions.
        buttonEl.title = 'Power Lines: M1 = open menu · M2 = toggle edit mode';
        // v0.7: panel now lives in document.body (position:fixed) instead
        // of inside buttonEl. Avoids any parent stacking-context surprises
        // and lets us compute exact pixel coordinates relative to the
        // Control Panel + ⚡ button on each show.
        createPanel();
        renderButtonState();
        console.log(`${TAG} v${SCRIPT_VERSION} button injected into .map-tools`);
        return true;
    }

    function watchToolsBar() {
        const obs = new MutationObserver(() => {
            if (buttonEl && !document.body.contains(buttonEl)) {
                buttonEl = null; panelEl = null;
                injectButton();
            } else if (!buttonEl) {
                injectButton();
            }
        });
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
    }

    function ensureButton() {
        if (injectButton()) { watchToolsBar(); return; }
        injectTries++;
        if (injectTries < INJECT_MAX_TRIES) setTimeout(ensureButton, INJECT_RETRY_MS);
        else console.warn(`${TAG} gave up injecting after ${INJECT_MAX_TRIES} tries — .map-tools not found`);
    }

    function createPanel() {
        if (panelEl) return;
        panelEl = document.createElement('div');
        panelEl.id = PANEL_ID;
        // v0.7: panel attached to document.body (NOT buttonEl) with
        // position:fixed + computed coordinates. Reasons:
        //   - Escapes any parent stacking context — guaranteed paint
        //     order without relying on ancestor z-index behavior.
        //   - Lets us position the panel relative to the Control Panel
        //     when it's open (cleanly tucked above its top edge,
        //     right-aligned with CP) instead of guessing at toolbar
        //     button height with calc().
        panelEl.style.cssText = [
            'position:fixed',
            'background:rgba(40,40,40,0.94)', 'color:#e6e6e6',
            'backdrop-filter:blur(4px)', '-webkit-backdrop-filter:blur(4px)',
            'border:1px solid rgba(57,255,20,0.45)', 'border-radius:6px',
            'box-shadow:0 6px 22px rgba(0,0,0,0.55)',
            'z-index:2147483647', // same max as the ⚡ button
            'padding:6px',
            'display:none',
            'flex-direction:column', 'gap:5px', 'align-items:stretch',
            'min-width:180px', 'max-width:220px',
            'font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'cursor:default',
        ].join(';');
        swallowMouseEvents(panelEl);
        document.body.appendChild(panelEl);
        watchControlPanelForReposition();
        // Reposition on window resize (fixed coords need recompute).
        window.addEventListener('resize', () => { if (panelOpen) positionPanel(); }, false);
    }

    // Is Percepto's AIM Control Panel dropdown open right now?
    function isControlPanelOpen() {
        const cp = document.querySelector('.aim-control-panel');
        if (!cp) return false;
        return cp.style.display !== 'none' && cp.offsetParent !== null;
    }

    // Compute panel position in viewport coords. Two modes:
    //   CP open  → panel sits IMMEDIATELY above the CP's top edge,
    //              right-aligned to CP.right (so it stacks vertically
    //              with CP — flush together, no floating gap).
    //   default  → panel sits below ⚡ button, right edge shifted
    //              ~10px LEFT of the toolbar column so no buttons covered.
    function positionPanel() {
        if (!panelEl || !buttonEl) return;
        const btnRect = buttonEl.getBoundingClientRect();
        const cp = document.querySelector('.aim-control-panel');
        const cpOpen = cp && cp.style.display !== 'none' && cp.offsetParent !== null;
        // Reset before measuring (so we get natural panel height each time)
        panelEl.style.top = 'auto';
        panelEl.style.bottom = 'auto';
        panelEl.style.left = 'auto';
        panelEl.style.right = 'auto';
        panelEl.style.display = 'flex';
        panelEl.style.visibility = 'hidden';
        const panelRect = panelEl.getBoundingClientRect();
        panelEl.style.visibility = 'visible';
        if (cpOpen) {
            const cpRect = cp.getBoundingClientRect();
            // Panel bottom 6px above CP top; right-aligned with CP.
            const right = window.innerWidth - cpRect.right;
            const bottom = window.innerHeight - cpRect.top + 6;
            panelEl.style.right = `${Math.max(8, right)}px`;
            panelEl.style.bottom = `${Math.max(8, bottom)}px`;
            panelEl.style.boxShadow = '0 -6px 22px rgba(0,0,0,0.55)';
        } else {
            // Below ⚡, shifted LEFT past toolbar column (each toolbar
            // button ≈ 30px wide; offset 40px clears the column with
            // ~10px breathing room).
            const right = window.innerWidth - btnRect.right + 40;
            const top = btnRect.bottom + 6;
            panelEl.style.right = `${Math.max(8, right)}px`;
            panelEl.style.top = `${Math.max(8, top)}px`;
            panelEl.style.boxShadow = '0 6px 22px rgba(0,0,0,0.55)';
        }
    }

    // Watch the AIM Control Panel for open/close so we can reposition
    // OUR panel in response. The CP element gets attribute changes
    // (style.display) when toggled. We re-observe each time we see the
    // CP appear (it's created lazily by Control Panel script).
    let cpObserver = null;
    let cpObserverTarget = null;
    function watchControlPanelForReposition() {
        const findAndObserve = () => {
            const cp = document.querySelector('.aim-control-panel');
            if (!cp || cp === cpObserverTarget) return;
            if (cpObserver) { try { cpObserver.disconnect(); } catch (e) {} }
            cpObserverTarget = cp;
            cpObserver = new MutationObserver(() => {
                if (panelOpen) positionPanel();
            });
            cpObserver.observe(cp, { attributes: true, attributeFilter: ['style'] });
        };
        findAndObserve();
        // CP can be re-created (React re-renders, etc.) — keep checking.
        const bodyObserver = new MutationObserver(findAndObserve);
        if (document.body) bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    function btn(label, title, onClick, opts) {
        opts = opts || {};
        const b = document.createElement('button');
        b.type = 'button';
        b.title = title;
        b.innerHTML = label;
        b.style.cssText = [
            'width:100%',
            'min-height:30px',
            'padding:5px 10px',
            'border-radius:4px',
            `background:${opts.bg || 'rgba(255,255,255,0.06)'}`,
            `border:1px solid ${opts.border || 'rgba(255,255,255,0.18)'}`,
            `color:${opts.color || '#e6e6e6'}`,
            'cursor:pointer',
            'font:inherit',
            'text-align:left',
            'display:flex',
            'align-items:center',
            'gap:8px',
        ].join(';');
        // Click handler — capture+stop so Leaflet can't eat it. The panel
        // already swallows propagation up to the map; this guarantees the
        // button's own onClick fires regardless.
        b.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            try { onClick(e); } catch (err) { console.warn(`${TAG} btn handler threw:`, err); }
        });
        // Hover affordance.
        const baseBg = opts.bg || 'rgba(255,255,255,0.06)';
        const hoverBg = opts.hoverBg || 'rgba(255,255,255,0.12)';
        b.addEventListener('mouseenter', () => { b.style.background = hoverBg; });
        b.addEventListener('mouseleave', () => { b.style.background = baseBg; });
        return b;
    }

    // ⚡ button visual state:
    //   - editEnabled=ON  → native orange ⚡ + neon-green glow + larger
    //   - editEnabled=OFF → greyscale ⚡ + no glow + standard size
    // Independent of panelOpen — the panel is just a menu, not a mode.
    // Dirty-count badge shows regardless so uncommitted work is always
    // visible (even when editing is off).
    function renderButtonState() {
        if (!buttonEl) return;
        const icon = buttonEl.querySelector('.aim-ple-icon');
        if (icon) {
            if (editEnabled) {
                // Brighter + bigger + neon-green 3-layer halo. The ⚡
                // glyph is an emoji so its native orange shows through;
                // the glow is the cue (not the icon color).
                icon.style.filter = 'none';
                icon.style.fontSize = '22px';
                icon.style.textShadow = [
                    '0 0 8px  rgba(57,255,20,0.95)',
                    '0 0 18px rgba(57,255,20,0.70)',
                    '0 0 32px rgba(57,255,20,0.40)',
                ].join(', ');
            } else {
                // Desaturate + dim to "this is off / not in use" cue.
                icon.style.filter = 'grayscale(1) brightness(0.65)';
                icon.style.fontSize = '18px';
                icon.style.textShadow = 'none';
            }
        }
        // Dirty-count badge in the corner of the button.
        let badge = buttonEl.querySelector('.aim-ple-badge');
        const totalDirty = status.distroCount + status.transCount;
        if (totalDirty > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'aim-ple-badge';
                badge.style.cssText = [
                    'position:absolute', 'top:-4px', 'right:-4px',
                    'min-width:16px', 'height:16px', 'border-radius:8px',
                    'background:#ffd96b', 'color:#000',
                    'font-size:10px', 'font-weight:700',
                    'display:flex', 'align-items:center', 'justify-content:center',
                    'padding:0 4px',
                    'box-shadow:0 1px 3px rgba(0,0,0,0.6)',
                    'pointer-events:none',
                ].join(';');
                buttonEl.appendChild(badge);
            }
            badge.textContent = String(totalDirty);
        } else if (badge) {
            badge.remove();
        }
        renderPanelContents();
    }

    function renderPanelContents() {
        if (!panelEl) return;
        if (!panelOpen) {
            panelEl.style.display = 'none';
            panelEl.innerHTML = '';
            return;
        }
        panelEl.innerHTML = '';

        // ROW 1: title + close X (right-aligned). Clicking X closes
        // panel without needing to find the ⚡ button (which can be
        // hidden if CP is open and the z-index fix didn't take).
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:2px 2px 4px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:4px';
        const title = document.createElement('div');
        title.textContent = 'Power Lines';
        title.style.cssText = 'color:rgb(20,210,220);font-weight:600';
        titleRow.appendChild(title);
        const closeX = document.createElement('button');
        closeX.type = 'button';
        closeX.textContent = '✕';
        closeX.title = 'Close panel (M1 ⚡)';
        closeX.style.cssText = 'background:transparent;border:none;color:#888;cursor:pointer;font-size:14px;line-height:1;padding:2px 6px;border-radius:3px';
        closeX.addEventListener('mouseenter', () => { closeX.style.background = 'rgba(255,80,80,0.18)'; closeX.style.color = '#ff8585'; });
        closeX.addEventListener('mouseleave', () => { closeX.style.background = 'transparent'; closeX.style.color = '#888'; });
        closeX.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            setPanelOpen(false);
        });
        titleRow.appendChild(closeX);
        panelEl.appendChild(titleRow);

        // ROW 2: edit-mode toggle button. Click to toggle without
        // needing to find the ⚡ button. Same effect as M2 on ⚡.
        const editToggle = document.createElement('button');
        editToggle.type = 'button';
        editToggle.innerHTML = editEnabled
            ? '<span style="color:#39ff14">●</span> Edit mode: <b>ON</b>'
            : '<span style="color:#888">○</span> Edit mode: <b>OFF</b>';
        editToggle.title = 'Toggle edit mode (same as M2 on ⚡)';
        editToggle.style.cssText = [
            'width:100%', 'padding:5px 10px', 'border-radius:4px',
            `background:${editEnabled ? 'rgba(57,255,20,0.10)' : 'rgba(255,255,255,0.04)'}`,
            `border:1px solid ${editEnabled ? 'rgba(57,255,20,0.45)' : 'rgba(255,255,255,0.15)'}`,
            'color:#e6e6e6', 'cursor:pointer', 'font:inherit',
            'text-align:center', 'margin-bottom:4px',
        ].join(';');
        editToggle.addEventListener('mouseenter', () => {
            editToggle.style.background = editEnabled ? 'rgba(57,255,20,0.20)' : 'rgba(255,255,255,0.10)';
        });
        editToggle.addEventListener('mouseleave', () => {
            editToggle.style.background = editEnabled ? 'rgba(57,255,20,0.10)' : 'rgba(255,255,255,0.04)';
        });
        editToggle.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            setEditEnabled(!editEnabled);
        });
        panelEl.appendChild(editToggle);

        // Add Line — distro
        panelEl.appendChild(btn(
            '<span style="color:#ffd96b">+</span> Add distro line',
            'Click map to add vertices. Esc cancels. Save via Map Styler\'s floating toolbar.',
            () => sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'distro' })
        ));
        // Add Line — trans
        panelEl.appendChild(btn(
            '<span style="color:#ff8585">+</span> Add trans line',
            'Click map to add vertices. Esc cancels. Save via Map Styler\'s floating toolbar.',
            () => sendPle({ type: 'ENTER_DRAW_MODE', kmlType: 'trans' })
        ));

        // Commit per type — only show if there are dirty ops for that type.
        if (status.distroCount > 0) {
            panelEl.appendChild(btn(
                `<span style="color:#5fff5f">☁</span> Commit distro (${status.distroCount})`,
                `Commit ${status.distroCount} pending distribution change${status.distroCount === 1 ? '' : 's'} to GitHub`,
                () => sendPle({ type: 'COMMIT_KML', kmlType: 'distro' }),
                { bg: 'rgba(95,255,95,0.10)', border: 'rgba(95,255,95,0.4)', hoverBg: 'rgba(95,255,95,0.20)' }
            ));
        }
        if (status.transCount > 0) {
            panelEl.appendChild(btn(
                `<span style="color:#5fff5f">☁</span> Commit trans (${status.transCount})`,
                `Commit ${status.transCount} pending transmission change${status.transCount === 1 ? '' : 's'} to GitHub`,
                () => sendPle({ type: 'COMMIT_KML', kmlType: 'trans' }),
                { bg: 'rgba(95,255,95,0.10)', border: 'rgba(95,255,95,0.4)', hoverBg: 'rgba(95,255,95,0.20)' }
            ));
        }

        // Discard — shown if anything is dirty.
        const totalDirty = status.distroCount + status.transCount;
        if (totalDirty > 0) {
            panelEl.appendChild(btn(
                `<span style="color:#ff8585">✗</span> Discard all (${totalDirty})`,
                `Discard ALL pending changes (${totalDirty}). Has its own confirm prompt.`,
                () => {
                    if (status.distroCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'distro' });
                    if (status.transCount > 0) sendPle({ type: 'DISCARD_OPS', kmlType: 'trans' });
                },
                { bg: 'rgba(255,80,80,0.10)', border: 'rgba(255,133,133,0.4)', hoverBg: 'rgba(255,80,80,0.20)' }
            ));
        }

        // Status footer.
        if (status.vertexEditActive) {
            const ind = document.createElement('div');
            ind.textContent = `▸ editing ${status.vertexEditType} #${status.vertexEditPmIdx}`;
            ind.style.cssText = 'color:#7adfe6;font-size:11px;padding:4px 6px 2px;border-top:1px solid rgba(255,255,255,0.08);margin-top:2px';
            panelEl.appendChild(ind);
        } else if (status.drawModeActive) {
            const ind = document.createElement('div');
            ind.textContent = `▸ drawing ${status.drawModeType}`;
            ind.style.cssText = 'color:#5fff5f;font-size:11px;padding:4px 6px 2px;border-top:1px solid rgba(255,255,255,0.08);margin-top:2px';
            panelEl.appendChild(ind);
        } else {
            const hint = document.createElement('div');
            hint.textContent = editEnabled
                ? 'M1 on any line to edit vertices'
                : 'Click "Edit mode" above to enable';
            hint.style.cssText = 'color:#888;font-size:10px;padding:4px 6px 2px;border-top:1px solid rgba(255,255,255,0.08);margin-top:2px;font-style:italic';
            panelEl.appendChild(hint);
        }

        // Reposition AFTER content is built so the panel height we
        // measure in positionPanel is the real rendered height.
        positionPanel();
    }

    // ------- Init -------
    function init() {
        if (IS_TOP) {
            // TOP has no map to edit and no .map-tools to inject into.
            // Still set up the channels so status messages don't error.
            setupChannels();
            console.log(`${TAG} v${SCRIPT_VERSION} ready (TOP — no UI in this frame)`);
            return;
        }
        setupChannels();
        ensureButton();
        // If edit mode was ON before reload, restore the click interceptor
        // and tell Map Styler to flip its edit-mode toggles back on.
        if (editEnabled) {
            setStylerEditMode(true);
            installClickInterceptor();
        }
        // Ask for current dirty counts so the badge is accurate on load.
        // Use a small delay to let Map Styler finish its own init first.
        setTimeout(requestStatus, 800);
        console.log(`${TAG} v${SCRIPT_VERSION} ready (${FRAME}) — edit ${editEnabled ? 'ON' : 'OFF'}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
