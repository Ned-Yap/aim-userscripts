// ==UserScript==
// @name         Latest - AIM Issues
// @namespace    http://tampermonkey.net/
// @version      0.2
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Issues.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Issues.user.js
// @description  CSM-collaborative issue flagging. 🚩 button in .map-tools. M1 ⚡ flag mode → click-drag rectangle or Shift+click polygon → required note. Renders dashed red. M1 on issue = session-hide. M2 on issue = stub status modal (Phase 1 — full state machine arrives in Phase 3). Phase 1 LOCAL-ONLY (localStorage); Phase 2 swaps to GitHub.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// Design ref: see memory/project_aim_issues_design.md for full spec.
//
// Phase 1 scope (this version):
// - 🚩 button in .map-tools — M1 toggles flag mode, M2 stub (no-op in P1)
// - In flag mode: M1 click-drag on map = rectangle.
//   Shift+M1 click = polygon mode (sticky — subsequent clicks add vertices
//   without holding Shift; Enter or double-click finishes; Esc cancels).
// - Required note modal after draw completes
// - localStorage per-site persistence (key: aim-issues-site-<siteID>)
// - Render: dashed red polygon + ⚠ divIcon at centroid
// - M1 on issue marker/polygon = toggle session-hide (resets on refresh)
// - M2 on issue = stub modal showing the note + current status (no transitions)
//
// NOT in Phase 1: GitHub sync, real status state machine, dedicated 🚩 panel,
// SUM table integration, surface filter, history audit log.
//
// Log tag: [AIM ISSUES]
//
// Map-tools placement: PLE's ⚡ asserts itself as LAST child via its own
// MutationObserver. Rather than fight it for the slot, 🚩 inserts itself
// IMMEDIATELY BEFORE PLE's ⚡ — gives layout: ... gear → 🚩 → ⚡. If PLE
// isn't installed yet, 🚩 appends to the end and the next observer tick
// re-positions it once PLE shows up.

(function () {
    'use strict';

    const TAG = '[AIM ISSUES]';
    const SCRIPT_VERSION = '0.2';
    const IS_TOP = window === window.top;
    const FRAME = IS_TOP ? 'TOP' : 'IFRAME';

    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-issues';
    const STORAGE_PREFIX = 'aim-issues-site-';

    // ------- State -------
    let masterEnabled = true;
    let flagModeActive = false;
    let siteID = null;
    let currentSiteIssues = [];                  // Issue[] for current site
    const hiddenIds = new Set();                 // session-only — resets on reload
    let showHidden = true;                       // v0.2: when ON, session-hidden
                                                 // issues render dimmed instead
                                                 // of disappearing. M2 on 🚩
                                                 // toggles this.
    const issueLayers = new Map();               // issueId → { polygon, marker }
    let drawingState = null;
    let drawToolbarEl = null;
    let noteModalEl = null;
    let stubModalEl = null;
    let buttonEl = null;
    let controlChannel = null;
    let leafletMapRef = null;

    // ------- Site ID -------
    // v0.2: read TOP frame's hash, not the IFRAME's own. The map iframe
    // URL is `/static/dist/react-pages/*` and has NO site info — only the
    // top-window URL hash carries `#/site/<id>/...`. v0.1 read the iframe
    // hash and silently came up with siteID=null after every refresh,
    // which made localStorage-stored issues vanish.
    function readSiteIdFromHash() {
        let hash = '';
        try { hash = (window.top && window.top.location && window.top.location.hash) || ''; }
        catch (e) {}
        if (!hash) hash = location.hash || '';
        const m = hash.match(/#\/site\/(\d+)\//);
        return m ? m[1] : null;
    }

    function storageKeyForSite(id) { return `${STORAGE_PREFIX}${id}`; }

    function loadIssuesFromStorage(id) {
        if (!id) return [];
        try {
            const raw = localStorage.getItem(storageKeyForSite(id));
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.issues)) return [];
            return parsed.issues;
        } catch (e) {
            console.warn(`${TAG} loadIssuesFromStorage threw:`, e);
            return [];
        }
    }

    function saveIssuesToStorage(id, issues) {
        if (!id) return;
        try {
            const payload = { version: 1, siteID: id, issues };
            localStorage.setItem(storageKeyForSite(id), JSON.stringify(payload));
        } catch (e) {
            console.warn(`${TAG} saveIssuesToStorage threw:`, e);
        }
    }

    function setCurrentSite(newId) {
        if (newId === siteID) return;
        siteID = newId;
        clearIssueLayers();
        hiddenIds.clear();
        currentSiteIssues = loadIssuesFromStorage(siteID);
        console.log(`${TAG} site changed → ${siteID} (${currentSiteIssues.length} issue${currentSiteIssues.length === 1 ? '' : 's'})`);
        renderAllIssues();
        renderButtonState();
    }

    // v0.2: listen for hashchange on BOTH top and current windows. The
    // top frame is where Percepto's site navigation actually updates the
    // hash; the iframe never sees it. Same-origin so cross-frame access
    // works.
    function attachHashListener() {
        const handler = () => setCurrentSite(readSiteIdFromHash());
        try {
            if (window.top && window.top !== window) {
                window.top.addEventListener('hashchange', handler);
            }
        } catch (e) {}
        window.addEventListener('hashchange', handler);
    }

    // ------- Control Panel registration (Phase 1 minimal) -------
    function setupControlChannel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} control channel unavailable:`, e); return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                const v = msg.value !== undefined ? msg.value : msg.enabled;
                if (msg.toggleId === 'master') {
                    if (!!v === masterEnabled) return;
                    masterEnabled = !!v;
                    renderButtonState();
                    if (!masterEnabled) {
                        if (flagModeActive) setFlagMode(false);
                        clearIssueLayers();
                    } else {
                        renderAllIssues();
                    }
                }
            }
        };
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        try {
            controlChannel.postMessage({
                type: 'REGISTER',
                scriptId: SCRIPT_ID,
                name: 'Issues',
                version: SCRIPT_VERSION,
                toggles: [
                    { id: 'master', label: 'Enable Issues', type: 'boolean', default: true, master: true },
                ],
                hotkeys: [],
            });
        } catch (e) {}
    }

    // ------- Leaflet map detection (cribbed from Map Styler) -------
    function looksLikeLeafletMap(v) {
        return v && typeof v === 'object'
            && typeof v.latLngToLayerPoint === 'function'
            && typeof v.latLngToContainerPoint === 'function'
            && typeof v.layerPointToLatLng === 'function'
            && typeof v.distance === 'function'
            && typeof v.getContainer === 'function';
    }

    function getLeafletMap() {
        if (leafletMapRef && leafletMapRef._container && document.body.contains(leafletMapRef._container)) {
            return leafletMapRef;
        }
        leafletMapRef = null;
        const containers = document.querySelectorAll('.leaflet-container');
        for (const container of containers) {
            const candidates = [container.__aim_map__, container._leaflet_map, container._leaflet];
            for (const c of candidates) {
                if (looksLikeLeafletMap(c)) { leafletMapRef = c; return c; }
            }
            for (const k in container) {
                try {
                    const v = container[k];
                    if (looksLikeLeafletMap(v)) { leafletMapRef = v; return v; }
                } catch (e) {}
            }
            try {
                for (const k of Object.getOwnPropertyNames(container)) {
                    try {
                        const v = container[k];
                        if (looksLikeLeafletMap(v)) { leafletMapRef = v; return v; }
                    } catch (e) {}
                }
            } catch (e) {}
        }
        return null;
    }

    function getL() {
        try { return window.L || (window.top && window.top.L) || null; }
        catch (e) { return null; }
    }

    // ------- 🚩 button injection -------
    const BUTTON_CLASS = 'aim-issues-button';
    const PLE_BUTTON_SELECTOR = '.aim-ple-button';
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

    function ensurePositionRelativeToPle() {
        const tools = findToolsBar();
        if (!tools || !buttonEl) return;
        const ple = tools.querySelector(PLE_BUTTON_SELECTOR);
        if (ple) {
            if (buttonEl.nextElementSibling !== ple) {
                try { tools.insertBefore(buttonEl, ple); } catch (e) {}
            }
        } else {
            if (tools.lastElementChild !== buttonEl) {
                try { tools.appendChild(buttonEl); } catch (e) {}
            }
        }
    }

    function injectButton() {
        const tools = findToolsBar();
        if (!tools) return false;
        if (buttonEl && tools.contains(buttonEl)) {
            ensurePositionRelativeToPle();
            return true;
        }
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="ant-dropdown-trigger map-tools__button pr-dropdown ${BUTTON_CLASS}"
                 title="Issues · M1 toggle flag mode · click-drag = rectangle · Shift+click = polygon"
                 style="cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;user-select:none;z-index:2147483647;isolation:isolate">
                <span class="aim-issues-icon" style="font-size:18px;line-height:1">🚩</span>
            </div>
        `;
        const el = wrapper.firstElementChild;
        buttonEl = el;
        ensurePositionRelativeToPle.__needsInsert = true;
        // First placement: try to slot before PLE if present, else append.
        const ple = tools.querySelector(PLE_BUTTON_SELECTOR);
        if (ple) tools.insertBefore(el, ple);
        else tools.appendChild(el);
        swallowMouseEvents(buttonEl);
        buttonEl.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!masterEnabled) return;
            setFlagMode(!flagModeActive);
        });
        buttonEl.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!masterEnabled) return;
            // v0.2: M2 toggles whether session-hidden issues render at all.
            // When ON (default), hidden issues show DIMMED (M1 the marker
            // to un-hide). When OFF, they vanish entirely until either
            // a) M2 here flips back, or b) page refresh resets hiddenIds.
            showHidden = !showHidden;
            renderAllIssues();
            renderButtonState();
            const n = hiddenIds.size;
            if (showHidden) {
                showToast(`Showing ${n} hidden issue${n === 1 ? '' : 's'} dimmed. M1 the icon to un-hide.`, 3500);
            } else {
                showToast(`Hiding ${n} session-hidden issue${n === 1 ? '' : 's'} completely.`, 3500);
            }
        });
        renderButtonState();
        console.log(`${TAG} v${SCRIPT_VERSION} button injected into .map-tools`);
        return true;
    }

    function watchToolsBar() {
        const obs = new MutationObserver(() => {
            if (buttonEl && !document.body.contains(buttonEl)) {
                buttonEl = null;
                injectButton();
            } else if (!buttonEl) {
                injectButton();
            } else {
                ensurePositionRelativeToPle();
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

    function renderButtonState() {
        if (!buttonEl) return;
        const icon = buttonEl.querySelector('.aim-issues-icon');
        if (icon) {
            if (flagModeActive && masterEnabled) {
                icon.style.filter = 'none';
                icon.style.fontSize = '22px';
                icon.style.textShadow = [
                    '0 0 8px  rgba(255,77,77,0.95)',
                    '0 0 18px rgba(255,77,77,0.70)',
                    '0 0 32px rgba(255,77,77,0.40)',
                ].join(', ');
            } else {
                icon.style.filter = masterEnabled ? 'grayscale(0.4) brightness(0.85)' : 'grayscale(1) brightness(0.5)';
                icon.style.fontSize = '18px';
                icon.style.textShadow = 'none';
            }
        }
        const hiddenCount = hiddenIds.size;
        const hiddenSuffix = hiddenCount > 0
            ? ` · ${hiddenCount} hidden ${showHidden ? '(dimmed)' : '(off)'} — M2 to toggle`
            : '';
        buttonEl.title = !masterEnabled
            ? 'Issues: disabled in AIM Controls'
            : flagModeActive
                ? `Issues: FLAG MODE armed — click-drag for rectangle, Shift+click for polygon, Esc to exit${hiddenSuffix}`
                : `Issues · M1 toggle flag mode · M2 toggle visibility of session-hidden${hiddenSuffix}`;

        // Badge: count for current site
        let badge = buttonEl.querySelector('.aim-issues-badge');
        const n = currentSiteIssues.length;
        if (n > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'aim-issues-badge';
                badge.style.cssText = [
                    'position:absolute', 'top:-4px', 'right:-4px',
                    'min-width:16px', 'height:16px', 'border-radius:8px',
                    'background:#ff4d4d', 'color:#fff',
                    'font-size:10px', 'font-weight:700',
                    'display:flex', 'align-items:center', 'justify-content:center',
                    'padding:0 4px',
                    'box-shadow:0 1px 3px rgba(0,0,0,0.6)',
                    'pointer-events:none',
                ].join(';');
                buttonEl.appendChild(badge);
            }
            badge.textContent = String(n);
        } else if (badge) {
            badge.remove();
        }
    }

    // ------- Flag mode + draw -------
    function setFlagMode(on) {
        if (on === flagModeActive) return;
        flagModeActive = on;
        if (on) enterFlagMode();
        else exitFlagMode({ silent: true });
        renderButtonState();
    }

    function enterFlagMode() {
        const map = getLeafletMap();
        if (!map) {
            showToast('Map not ready — try again in a second.', 3000);
            flagModeActive = false;
            renderButtonState();
            return;
        }
        const container = map.getContainer ? map.getContainer() : null;
        if (container) container.style.cursor = 'crosshair';
        // Disable map drag so our mousedown→drag isn't fighting Leaflet pan.
        // Re-enabled on exit. Same trick Leaflet's own draw plugin uses.
        try { if (map.dragging) map.dragging.disable(); } catch (e) {}
        try { if (map.doubleClickZoom) map.doubleClickZoom.disable(); } catch (e) {}
        // Bind Leaflet events for draw — latlng is delivered to us directly.
        map.on('mousedown', onMapMouseDown);
        map.on('mousemove', onMapMouseMove);
        map.on('mouseup',   onMapMouseUp);
        map.on('click',     onMapClick);
        map.on('dblclick',  onMapDblClick);
        window.addEventListener('keydown', onWindowKeyDown, true);
        showToast('Flag mode ON — click-drag for rectangle, Shift+click for polygon. Esc to exit.', 4000);
    }

    function exitFlagMode(opts) {
        opts = opts || {};
        const map = getLeafletMap();
        if (map) {
            const container = map.getContainer ? map.getContainer() : null;
            if (container) container.style.cursor = '';
            try { map.off('mousedown', onMapMouseDown); } catch (e) {}
            try { map.off('mousemove', onMapMouseMove); } catch (e) {}
            try { map.off('mouseup',   onMapMouseUp);   } catch (e) {}
            try { map.off('click',     onMapClick);     } catch (e) {}
            try { map.off('dblclick',  onMapDblClick);  } catch (e) {}
            try { if (map.dragging) map.dragging.enable(); } catch (e) {}
            try { if (map.doubleClickZoom) map.doubleClickZoom.enable(); } catch (e) {}
        }
        window.removeEventListener('keydown', onWindowKeyDown, true);
        discardDraw({ silent: true });
        if (!opts.silent) showToast('Flag mode OFF.', 1800);
    }

    function onWindowKeyDown(e) {
        if (e.key === 'Escape') {
            if (drawingState) discardDraw({ silent: false });
            else setFlagMode(false);
            return;
        }
        if (e.key === 'Enter' && drawingState && drawingState.mode === 'polygon') {
            e.preventDefault();
            finishPolygon();
        }
    }

    function onMapMouseDown(e) {
        if (!flagModeActive || !masterEnabled) return;
        const oe = e.originalEvent;
        if (!oe) return;
        if (oe.button !== 0) return;
        // In polygon mode, ignore mousedown — vertices are placed on 'click'.
        if (drawingState && drawingState.mode === 'polygon') return;
        // Shift+mousedown seeds polygon mode. The first vertex is placed
        // on the matching 'click' fire (Leaflet emits click after mouseup
        // for the same press), so we just FLAG that we're seeding polygon.
        if (oe.shiftKey) {
            drawingState = {
                mode: 'polygon',
                vertices: [],
                previewLayer: null,
            };
            buildDrawToolbar();
            return;
        }
        // Rectangle drag start
        drawingState = {
            mode: 'rect',
            startLatLng: e.latlng,
            currentLatLng: e.latlng,
            previewLayer: null,
        };
        buildDrawToolbar();
        renderRectPreview();
    }

    function onMapMouseMove(e) {
        if (!drawingState) return;
        if (drawingState.mode === 'rect') {
            drawingState.currentLatLng = e.latlng;
            renderRectPreview();
        } else if (drawingState.mode === 'polygon' && drawingState.vertices.length > 0) {
            drawingState.hoverLatLng = e.latlng;
            renderPolygonPreview();
        }
    }

    function onMapMouseUp(e) {
        if (!drawingState || drawingState.mode !== 'rect') return;
        const start = drawingState.startLatLng;
        const end = e.latlng || drawingState.currentLatLng;
        if (!start || !end) { discardDraw({ silent: true }); return; }
        // Reject tiny drags — likely an accidental click, fall through to
        // polygon-seed behavior on the next mousedown.
        const dx = Math.abs(start.lat - end.lat);
        const dy = Math.abs(start.lng - end.lng);
        const tooSmall = (dx < 1e-7 && dy < 1e-7);
        if (tooSmall) { discardDraw({ silent: true }); return; }
        const polygonLatLngs = rectLatLngs(start, end);
        clearPreview();
        drawingState = null;
        tearDownDrawToolbar();
        openNoteModal('rectangle', polygonLatLngs);
    }

    function onMapClick(e) {
        if (!drawingState || drawingState.mode !== 'polygon') return;
        // Add vertex
        drawingState.vertices.push(e.latlng);
        renderPolygonPreview();
        updateDrawToolbar();
    }

    function onMapDblClick(e) {
        if (!drawingState || drawingState.mode !== 'polygon') return;
        // Leaflet fires click TWICE before dblclick. Pop the duplicate.
        if (drawingState.vertices.length >= 2) {
            // Each click added a vertex; the dblclick's two clicks both ran.
            // The two extra vertices are identical to the intended last
            // vertex — pop one duplicate to avoid a zero-length edge.
            const last = drawingState.vertices[drawingState.vertices.length - 1];
            const prev = drawingState.vertices[drawingState.vertices.length - 2];
            if (last && prev && last.lat === prev.lat && last.lng === prev.lng) {
                drawingState.vertices.pop();
            }
        }
        finishPolygon();
    }

    function finishPolygon() {
        if (!drawingState || drawingState.mode !== 'polygon') return;
        if (drawingState.vertices.length < 3) {
            showToast('Polygon needs at least 3 vertices.', 3000);
            return;
        }
        const latlngs = drawingState.vertices.slice();
        clearPreview();
        drawingState = null;
        tearDownDrawToolbar();
        openNoteModal('polygon', latlngs);
    }

    function discardDraw(opts) {
        opts = opts || {};
        clearPreview();
        drawingState = null;
        tearDownDrawToolbar();
        if (!opts.silent) showToast('Draw cancelled.', 1800);
    }

    function rectLatLngs(a, b) {
        const minLat = Math.min(a.lat, b.lat), maxLat = Math.max(a.lat, b.lat);
        const minLng = Math.min(a.lng, b.lng), maxLng = Math.max(a.lng, b.lng);
        return [
            { lat: minLat, lng: minLng },
            { lat: minLat, lng: maxLng },
            { lat: maxLat, lng: maxLng },
            { lat: maxLat, lng: minLng },
        ];
    }

    function clearPreview() {
        if (drawingState && drawingState.previewLayer) {
            const map = getLeafletMap();
            if (map) try { map.removeLayer(drawingState.previewLayer); } catch (e) {}
            drawingState.previewLayer = null;
        }
    }

    function renderRectPreview() {
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L || !drawingState) return;
        clearPreview();
        const corners = rectLatLngs(drawingState.startLatLng, drawingState.currentLatLng);
        const latlngs = corners.map(c => [c.lat, c.lng]);
        try {
            drawingState.previewLayer = L.polygon(latlngs, {
                color: '#ff4d4d',
                weight: 3,
                opacity: 0.95,
                dashArray: '8,6',
                fillColor: '#ff0000',
                fillOpacity: 0.12,
                interactive: false,
            }).addTo(map);
        } catch (e) {}
    }

    function renderPolygonPreview() {
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L || !drawingState) return;
        clearPreview();
        const verts = drawingState.vertices.slice();
        if (drawingState.hoverLatLng && verts.length > 0) verts.push(drawingState.hoverLatLng);
        if (verts.length < 2) return;
        const latlngs = verts.map(c => [c.lat, c.lng]);
        try {
            if (verts.length >= 3) {
                drawingState.previewLayer = L.polygon(latlngs, {
                    color: '#ff4d4d',
                    weight: 3,
                    opacity: 0.95,
                    dashArray: '8,6',
                    fillColor: '#ff0000',
                    fillOpacity: 0.10,
                    interactive: false,
                }).addTo(map);
            } else {
                drawingState.previewLayer = L.polyline(latlngs, {
                    color: '#ff4d4d',
                    weight: 3,
                    opacity: 0.95,
                    dashArray: '8,6',
                    interactive: false,
                }).addTo(map);
            }
        } catch (e) {}
    }

    // ------- Floating draw toolbar -------
    function buildDrawToolbar() {
        tearDownDrawToolbar();
        const tb = document.createElement('div');
        tb.id = 'aim-issues-draw-toolbar';
        tb.style.cssText = `
            position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
            background:#1f2228;border:2px solid #ff4d4d;border-radius:8px;
            padding:10px 16px;z-index:99999;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;display:flex;align-items:center;gap:12px;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
        `;
        const label = document.createElement('span');
        label.id = 'aim-issues-draw-label';
        label.style.cssText = 'color:#ff8585;font-weight:600';
        tb.appendChild(label);
        if (drawingState && drawingState.mode === 'polygon') {
            const finishBtn = document.createElement('button');
            finishBtn.textContent = '✓ Finish (Enter)';
            finishBtn.setAttribute('data-role', 'finish');
            finishBtn.style.cssText = 'padding:7px 14px;background:#5fff5f;color:#000;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700;opacity:0.4';
            finishBtn.disabled = true;
            finishBtn.onclick = () => finishPolygon();
            tb.appendChild(finishBtn);
            const undoBtn = document.createElement('button');
            undoBtn.textContent = '↶ Undo vertex';
            undoBtn.style.cssText = 'padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
            undoBtn.onclick = () => {
                if (!drawingState || !drawingState.vertices.length) return;
                drawingState.vertices.pop();
                renderPolygonPreview();
                updateDrawToolbar();
            };
            tb.appendChild(undoBtn);
        }
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '✗ Cancel (Esc)';
        cancelBtn.style.cssText = 'padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
        cancelBtn.onclick = () => discardDraw({ silent: false });
        tb.appendChild(cancelBtn);
        document.body.appendChild(tb);
        drawToolbarEl = tb;
        updateDrawToolbar();
    }

    function updateDrawToolbar() {
        if (!drawToolbarEl || !drawingState) return;
        const label = drawToolbarEl.querySelector('#aim-issues-draw-label');
        if (drawingState.mode === 'rect') {
            if (label) label.textContent = 'Drawing rectangle · release mouse to commit';
        } else {
            const n = drawingState.vertices.length;
            if (label) label.textContent = `Drawing polygon · ${n} vertex${n === 1 ? '' : 'es'}${n < 3 ? ` (need ≥3)` : ''}`;
            const finishBtn = drawToolbarEl.querySelector('button[data-role="finish"]');
            if (finishBtn) {
                finishBtn.disabled = n < 3;
                finishBtn.style.opacity = finishBtn.disabled ? '0.4' : '1';
                finishBtn.style.cursor = finishBtn.disabled ? 'not-allowed' : 'pointer';
            }
        }
    }

    function tearDownDrawToolbar() {
        if (drawToolbarEl) { try { drawToolbarEl.remove(); } catch (e) {} }
        drawToolbarEl = null;
    }

    // ------- Note modal -------
    function openNoteModal(shape, latlngsObjs) {
        closeNoteModal();
        const overlay = document.createElement('div');
        overlay.id = 'aim-issues-note-modal-overlay';
        overlay.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:100000;
            display:flex;align-items:center;justify-content:center;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        `;
        const card = document.createElement('div');
        card.style.cssText = `
            background:#1f2228;border:1px solid rgba(255,77,77,0.55);
            border-radius:10px;padding:18px 22px;width:480px;max-width:90vw;
            color:#e6e6e6;box-shadow:0 8px 32px rgba(0,0,0,0.6);
        `;
        card.innerHTML = `
            <div style="font-size:15px;font-weight:600;color:#ff8585;margin-bottom:10px">
                New issue · ${shape} · ${latlngsObjs.length} vertex${latlngsObjs.length === 1 ? '' : 'es'}
            </div>
            <div style="font-size:12px;color:#aaa;margin-bottom:8px">
                Describe the issue. Required.
            </div>
            <textarea id="aim-issues-note-input"
                placeholder="e.g. mislabeled tank — should be 'Tank 14B' not 'Tank 14A'"
                style="width:100%;min-height:90px;background:#14171b;color:#e6e6e6;
                       border:1px solid rgba(255,255,255,0.15);border-radius:6px;
                       padding:8px 10px;font:inherit;font-size:13px;resize:vertical;box-sizing:border-box"></textarea>
            <div id="aim-issues-note-err" style="color:#ff8585;font-size:12px;margin-top:6px;min-height:16px"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
                <button id="aim-issues-note-cancel"
                    style="padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit">
                    Cancel
                </button>
                <button id="aim-issues-note-save"
                    style="padding:7px 14px;background:#ff4d4d;color:#fff;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700">
                    Create issue
                </button>
            </div>
        `;
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        noteModalEl = overlay;
        const input = card.querySelector('#aim-issues-note-input');
        const err = card.querySelector('#aim-issues-note-err');
        const cancel = card.querySelector('#aim-issues-note-cancel');
        const save = card.querySelector('#aim-issues-note-save');
        setTimeout(() => { try { input.focus(); } catch (e) {} }, 30);
        cancel.onclick = () => { closeNoteModal(); showToast('Issue discarded.', 1800); };
        save.onclick = () => {
            const note = (input.value || '').trim();
            if (!note) { err.textContent = 'Note is required.'; return; }
            err.textContent = '';
            createIssue({ shape, latlngsObjs, note });
            closeNoteModal();
        };
        // Esc to cancel, Ctrl/Cmd+Enter to save
        const keyH = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
        };
        overlay.addEventListener('keydown', keyH, true);
    }

    function closeNoteModal() {
        if (noteModalEl) { try { noteModalEl.remove(); } catch (e) {} }
        noteModalEl = null;
    }

    function createIssue({ shape, latlngsObjs, note }) {
        if (!siteID) { showToast('No site loaded — issue discarded.', 4000); return; }
        const nowIso = new Date().toISOString();
        const id = `iss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const polygon = latlngsObjs.map(c => [c.lat, c.lng]);
        // Phase 1: no GitHub identity yet — leave createdBy as the local
        // placeholder. Phase 2 swaps in the GitHub login.
        const issue = {
            id,
            surface: 'site-setup',
            shape,
            polygon,
            note,
            status: 'open',
            createdAt: nowIso,
            createdBy: 'local-only',
            history: [
                { at: nowIso, by: 'local-only', fromStatus: null, toStatus: 'open', note },
            ],
        };
        currentSiteIssues.push(issue);
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderOneIssue(issue);
        renderButtonState();
        showToast(`Issue created (${currentSiteIssues.length} on this site).`, 3000);
        console.log(`${TAG} created issue ${id} (${shape}, ${polygon.length} vertices)`);
    }

    // ------- Rendering issues -------
    function clearIssueLayers() {
        const map = getLeafletMap();
        issueLayers.forEach(({ polygon, marker }) => {
            try { if (map && polygon) map.removeLayer(polygon); } catch (e) {}
            try { if (map && marker)  map.removeLayer(marker);  } catch (e) {}
        });
        issueLayers.clear();
    }

    function renderAllIssues() {
        clearIssueLayers();
        if (!masterEnabled) return;
        currentSiteIssues.forEach((issue) => {
            const isHidden = hiddenIds.has(issue.id);
            // v0.2: when showHidden=OFF, hidden issues are not rendered at all.
            // When showHidden=ON (default), they render with dimmed style and
            // the polygon goes pointer-events:none so clicks fall through to
            // whatever's under it (Percepto markers, KML lines, etc.). The
            // small ⚠ marker stays clickable so the user can M1 to un-hide.
            if (isHidden && !showHidden) return;
            renderOneIssue(issue, { isHidden });
        });
    }

    function centroidOfLatLngs(latlngs) {
        if (!latlngs || !latlngs.length) return null;
        let sLat = 0, sLng = 0;
        latlngs.forEach(p => { sLat += p[0]; sLng += p[1]; });
        return [sLat / latlngs.length, sLng / latlngs.length];
    }

    function styleForStatus(status) {
        // Phase 1 only renders 'open'; the rest are stubs for Phase 3.
        switch (status) {
            case 'ready-for-review':
                return { color: '#ffd54f', fill: '#ffd54f', fillOpacity: 0.20, dashArray: '10,6', weight: 3 };
            case 'resolved':
                return { color: '#888', fill: '#888', fillOpacity: 0.08, dashArray: null, weight: 1.5 };
            case 'ignored':
                return { color: '#788cb4', fill: '#788cb4', fillOpacity: 0.08, dashArray: '4,4', weight: 1.5 };
            case 'open':
            default:
                return { color: '#ff4d4d', fill: '#ff0000', fillOpacity: 0.15, dashArray: '10,6', weight: 3 };
        }
    }

    function iconForStatus(status) {
        switch (status) {
            case 'ready-for-review': return { glyph: '⚠', color: '#ffd54f' };
            case 'resolved':         return { glyph: '✓', color: '#888' };
            case 'ignored':          return { glyph: '⊘', color: '#788cb4' };
            case 'open':
            default:                 return { glyph: '⚠', color: '#ff4d4d' };
        }
    }

    function renderOneIssue(issue, opts) {
        if (!issue) return;
        opts = opts || {};
        const isHidden = !!opts.isHidden;
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L) return;
        // Wipe any prior layers for this id (re-renders are idempotent)
        const prior = issueLayers.get(issue.id);
        if (prior) {
            try { if (prior.polygon) map.removeLayer(prior.polygon); } catch (e) {}
            try { if (prior.marker)  map.removeLayer(prior.marker);  } catch (e) {}
        }
        const st = styleForStatus(issue.status);
        const icoMeta = iconForStatus(issue.status);
        // v0.2: hidden style — dimmed to ~25% opacity, thinner stroke, almost
        // no fill, polygon goes interactive:false so clicks fall through.
        // The marker stays interactive so M1 on it un-hides.
        const polygonOpts = isHidden ? {
            color: st.color,
            weight: 1.5,
            opacity: 0.25,
            dashArray: st.dashArray,
            fillColor: st.fill,
            fillOpacity: 0.04,
            interactive: false,
            bubblingMouseEvents: false,
        } : {
            color: st.color,
            weight: st.weight,
            opacity: 0.95,
            dashArray: st.dashArray,
            fillColor: st.fill,
            fillOpacity: st.fillOpacity,
            interactive: true,
            bubblingMouseEvents: false,
        };
        const polygon = L.polygon(issue.polygon, polygonOpts);
        if (!isHidden) {
            polygon.bindTooltip(buildTooltipHtml(issue, { isHidden }), {
                direction: 'top',
                offset: L.point(0, -8),
                sticky: true,
                className: 'aim-issues-tooltip',
            });
            polygon.on('click', (ev) => {
                try { L.DomEvent.stopPropagation(ev); } catch (e) {}
                toggleSessionHide(issue.id);
            });
            polygon.on('contextmenu', (ev) => {
                try { L.DomEvent.stopPropagation(ev); } catch (e) {}
                try { if (ev.originalEvent) ev.originalEvent.preventDefault(); } catch (e) {}
                openStubStatusModal(issue);
            });
        }
        polygon.addTo(map);
        // Belt-and-suspenders for click-through when hidden: even with
        // interactive:false, some Leaflet renderer paths still get a
        // `pointer-events: visiblePainted` on the SVG path. Force none.
        if (isHidden && polygon._path) {
            try { polygon._path.style.pointerEvents = 'none'; } catch (e) {}
        }

        const c = centroidOfLatLngs(issue.polygon);
        let marker = null;
        if (c) {
            // Hidden marker: smaller, dim border, dim glyph, but still clickable.
            const markerOpacity = isHidden ? 0.45 : 1;
            const markerSize = isHidden ? 20 : 26;
            const fontSize = isHidden ? 11 : 14;
            const borderWidth = isHidden ? 1 : 2;
            const divIcon = L.divIcon({
                className: 'aim-issues-icon-marker',
                html: `<div style="
                    width:${markerSize}px;height:${markerSize}px;border-radius:${markerSize / 2}px;
                    background:rgba(20,23,27,${isHidden ? 0.6 : 0.92});
                    border:${borderWidth}px ${isHidden ? 'dashed' : 'solid'} ${icoMeta.color};
                    color:${icoMeta.color};
                    opacity:${markerOpacity};
                    display:flex;align-items:center;justify-content:center;
                    font-size:${fontSize}px;font-weight:700;
                    box-shadow:${isHidden ? 'none' : '0 2px 6px rgba(0,0,0,0.6)'};
                    pointer-events:auto;
                    cursor:pointer;
                    ${isHidden ? 'filter:grayscale(0.3);' : ''}
                ">${icoMeta.glyph}</div>`,
                iconSize: [markerSize, markerSize],
                iconAnchor: [markerSize / 2, markerSize / 2],
            });
            marker = L.marker(c, { icon: divIcon, interactive: true, bubblingMouseEvents: false });
            marker.bindTooltip(buildTooltipHtml(issue, { isHidden }), {
                direction: 'top',
                offset: L.point(0, -8),
                className: 'aim-issues-tooltip',
            });
            marker.on('click', (ev) => {
                try { L.DomEvent.stopPropagation(ev); } catch (e) {}
                toggleSessionHide(issue.id);
            });
            marker.on('contextmenu', (ev) => {
                try { L.DomEvent.stopPropagation(ev); } catch (e) {}
                try { if (ev.originalEvent) ev.originalEvent.preventDefault(); } catch (e) {}
                openStubStatusModal(issue);
            });
            marker.addTo(map);
        }
        issueLayers.set(issue.id, { polygon, marker });
    }

    function buildTooltipHtml(issue, opts) {
        opts = opts || {};
        const age = relativeAge(issue.createdAt);
        const safeNote = (issue.note || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const safeBy = (issue.createdBy || '?').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const statusLabel = (issue.status || 'open').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        const hideHint = opts.isHidden
            ? '<span style="color:#5fff5f">HIDDEN</span> · M1 to un-hide · M2 = status (stub)'
            : 'M1 = hide for this session · M2 = status (stub)';
        return `
            <div style="max-width:300px">
                <div style="font-weight:700;color:#ff8585;margin-bottom:4px">${statusLabel} · ${age}</div>
                <div style="color:#e6e6e6;font-size:12px;margin-bottom:4px">${safeNote}</div>
                <div style="color:#888;font-size:11px">@${safeBy}</div>
                <div style="color:#666;font-size:10px;margin-top:4px;font-style:italic">${hideHint}</div>
            </div>
        `;
    }

    function relativeAge(iso) {
        try {
            const t = new Date(iso).getTime();
            const dt = Date.now() - t;
            if (dt < 60 * 1000) return 'just now';
            if (dt < 60 * 60 * 1000) {
                const m = Math.floor(dt / (60 * 1000));
                return `${m} min ago`;
            }
            if (dt < 24 * 60 * 60 * 1000) {
                const h = Math.floor(dt / (60 * 60 * 1000));
                return `${h}h ago`;
            }
            const d = Math.floor(dt / (24 * 60 * 60 * 1000));
            return `${d}d ago`;
        } catch (e) { return iso; }
    }

    function toggleSessionHide(id) {
        const issue = currentSiteIssues.find(i => i.id === id);
        if (!issue) return;
        const willHide = !hiddenIds.has(id);
        if (willHide) hiddenIds.add(id);
        else hiddenIds.delete(id);
        // v0.2: don't remove layers — re-render with the new style. When
        // showHidden=OFF and we're hiding, renderOneIssue would still draw
        // it dimmed, so we have to honor the global flag here too.
        if (willHide && !showHidden) {
            // Truly remove
            const map = getLeafletMap();
            const layers = issueLayers.get(id);
            if (layers && map) {
                try { if (layers.polygon) map.removeLayer(layers.polygon); } catch (e) {}
                try { if (layers.marker)  map.removeLayer(layers.marker);  } catch (e) {}
            }
            issueLayers.delete(id);
        } else {
            renderOneIssue(issue, { isHidden: willHide });
        }
        renderButtonState();
        if (willHide) {
            showToast(showHidden
                ? 'Issue hidden (dimmed). M1 the small icon to un-hide. M2 🚩 to hide all hidden completely.'
                : 'Issue hidden completely. M2 🚩 to show dimmed.',
                4500);
        } else {
            showToast('Issue un-hidden.', 2000);
        }
    }

    // ------- Stub status modal (Phase 1) -------
    function openStubStatusModal(issue) {
        closeStubModal();
        const overlay = document.createElement('div');
        overlay.id = 'aim-issues-status-modal-overlay';
        overlay.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:100000;
            display:flex;align-items:center;justify-content:center;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        `;
        const card = document.createElement('div');
        card.style.cssText = `
            background:#1f2228;border:1px solid rgba(255,77,77,0.45);
            border-radius:10px;padding:18px 22px;width:520px;max-width:92vw;
            color:#e6e6e6;box-shadow:0 8px 32px rgba(0,0,0,0.6);
        `;
        const safeNote = (issue.note || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const histRows = (issue.history || []).map(h => {
            const safeHistNote = (h.note || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
            const safeBy = (h.by || '?').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
            const trans = h.fromStatus ? `${h.fromStatus} → ${h.toStatus}` : `created (${h.toStatus})`;
            return `<div style="padding:6px 8px;border-bottom:1px dotted rgba(255,255,255,0.08);font-size:12px">
                <div style="color:#aaa;font-size:11px">${h.at} · @${safeBy}</div>
                <div style="color:#e6e6e6">${trans}</div>
                ${safeHistNote ? `<div style="color:#bbb;font-size:11px;margin-top:2px">"${safeHistNote}"</div>` : ''}
            </div>`;
        }).join('');
        card.innerHTML = `
            <div style="font-size:15px;font-weight:600;color:#ff8585;margin-bottom:6px">
                Issue · ${(issue.status || 'open').toUpperCase()}
            </div>
            <div style="color:#e6e6e6;font-size:13px;margin-bottom:10px">${safeNote}</div>
            <div style="color:#888;font-size:11px;margin-bottom:4px">History</div>
            <div style="max-height:200px;overflow:auto;border:1px solid rgba(255,255,255,0.10);border-radius:4px;background:#14171b">${histRows}</div>
            <div style="color:#666;font-size:11px;margin-top:10px;font-style:italic">
                Phase 1 stub — status transitions arrive in Phase 3.
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                <button id="aim-issues-stub-close"
                    style="padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit">
                    Close
                </button>
            </div>
        `;
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        stubModalEl = overlay;
        card.querySelector('#aim-issues-stub-close').onclick = closeStubModal;
        const keyH = (e) => { if (e.key === 'Escape') closeStubModal(); };
        overlay.addEventListener('keydown', keyH, true);
    }

    function closeStubModal() {
        if (stubModalEl) { try { stubModalEl.remove(); } catch (e) {} }
        stubModalEl = null;
    }

    // ------- Toast -------
    function showToast(text, durationMs) {
        const existing = document.getElementById('aim-issues-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'aim-issues-toast';
        toast.textContent = text;
        // Same bottom:170px convention as Map Styler v34.62 — stays above
        // any floating draw toolbar at bottom:100px.
        toast.style.cssText = `
            position:fixed;bottom:170px;left:50%;transform:translateX(-50%);
            background:rgba(15,18,22,0.95);color:#e6e6e6;
            padding:10px 18px;border-radius:6px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            z-index:99999;border:1px solid rgba(255,77,77,0.5);
            pointer-events:none;max-width:80vw;text-align:center;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
        `;
        document.body.appendChild(toast);
        setTimeout(() => { try { toast.remove(); } catch (e) {} }, durationMs || 3000);
    }

    // ------- Init -------
    function init() {
        setupControlChannel();
        registerWithControlPanel();
        if (IS_TOP) {
            // TOP frame: register with Control Panel only — no UI here.
            console.log(`${TAG} v${SCRIPT_VERSION} ready (TOP — no UI in this frame)`);
            // Still watch site changes from TOP for completeness, in case
            // future phases want to coordinate across frames.
            setCurrentSite(readSiteIdFromHash());
            attachHashListener();
            return;
        }
        setCurrentSite(readSiteIdFromHash());
        attachHashListener();
        ensureButton();
        // First render attempt after a short delay so Leaflet has time to
        // mount the map for the current site.
        setTimeout(renderAllIssues, 1500);
        console.log(`${TAG} v${SCRIPT_VERSION} ready (${FRAME}) — site ${siteID || '(none)'}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
