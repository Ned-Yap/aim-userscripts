// ==UserScript==
// @name         AIM Copy Asset Name
// @namespace    http://tampermonkey.net/
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Copy_Asset_Name.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Copy_Asset_Name.user.js
// @description  Right-click any entity (asset, FFZ, flight path, marker) to pop up an inspector with name/type/elevation/notes. Each row click-to-copy. "Open in editor" triggers Percepto's native edit dialog. Replaces the old Shift+Ctrl+Q hotkey. Panel display name: "Asset Inspector".
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// NOTE: file/script @name stays "AIM Copy Asset Name" for Tampermonkey
// auto-update continuity (renaming creates a duplicate install instead of
// upgrading). Internally the script is now the Asset Inspector — the panel
// displays it under that name via the REGISTER message's `name` field.

(function() {
    'use strict';

    const CONTEXT = window === window.top ? 'TOP' : 'IFRAME';
    const TAG = `[AIM INSPECT ${CONTEXT}]`;
    console.log(`${TAG} v2.0 loading`);

    const SCRIPT_ID = 'aim-copy-asset'; // preserved for prefs continuity
    const SCRIPT_VERSION = '2.0';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SITE_ID_RE = /#\/site\/(\d+)\//;
    const MAP_OBJECTS_URL = 'https://percepto.app/map_objects/?getPoiMapObjectsAsList=true&site_id=';

    let controlChannel = null;
    let masterEnabled = true;
    // mapObjectsBySite: { [siteID]: { entities: [...], fetchedAt: ms } }
    const mapObjectsBySite = {};
    const fetchingSites = new Set();

    // ============================================================
    // Leaflet map ref (read from Map Styler's __aim_map__ patch when
    // available; fall back to walking container properties).
    // ============================================================
    function looksLikeLeafletMap(v) {
        return v && typeof v === 'object'
            && typeof v.containerPointToLatLng === 'function'
            && typeof v.latLngToContainerPoint === 'function'
            && typeof v.getContainer === 'function';
    }
    function getLeafletMap() {
        const containers = document.querySelectorAll('.leaflet-container');
        for (const c of containers) {
            if (c.__aim_map__ && looksLikeLeafletMap(c.__aim_map__)) return c.__aim_map__;
        }
        for (const c of containers) {
            const names = Object.getOwnPropertyNames(c);
            for (const k of names) {
                let v;
                try { v = c[k]; } catch (e) { continue; }
                if (looksLikeLeafletMap(v)) return v;
            }
        }
        return null;
    }

    function getCurrentSiteID() {
        const m = (location.hash || '').match(SITE_ID_RE);
        if (m) return m[1];
        try {
            const topHash = window.top.location.hash || '';
            const m2 = topHash.match(SITE_ID_RE);
            if (m2) return m2[1];
        } catch (e) {}
        return null;
    }

    // ============================================================
    // Data fetch — internal endpoint, cookie auth (no token needed)
    // ============================================================
    function fetchMapObjects(siteID, force) {
        if (!siteID) return;
        if (fetchingSites.has(siteID)) return;
        if (mapObjectsBySite[siteID] && !force) return;
        fetchingSites.add(siteID);
        const url = MAP_OBJECTS_URL + encodeURIComponent(siteID);
        console.log(`${TAG} fetching map_objects for site ${siteID}`);
        fetch(url, { credentials: 'same-origin' })
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                if (!Array.isArray(data)) throw new Error('Response not an array');
                mapObjectsBySite[siteID] = { entities: data, fetchedAt: Date.now() };
                console.log(`${TAG} loaded ${data.length} entities for site ${siteID}`);
            })
            .catch(e => {
                console.warn(`${TAG} fetch failed for site ${siteID}:`, e);
            })
            .finally(() => {
                fetchingSites.delete(siteID);
            });
    }

    // ============================================================
    // Spatial matching — point-in-polygon for assets/FFZs, distance-
    // to-segment for flight paths, nearest-within for point markers.
    // ============================================================
    function pointInPolygon(lat, lng, poly) {
        if (!poly || poly.length < 3) return false;
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].lng, yi = poly[i].lat;
            const xj = poly[j].lng, yj = poly[j].lat;
            const intersect = ((yi > lat) !== (yj > lat))
                && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    function approxMeters(lat1, lng1, lat2, lng2) {
        // Equirectangular approximation — good for <10km within a site.
        const R = 6371000;
        const phi1 = lat1 * Math.PI / 180;
        const dphi = (lat2 - lat1) * Math.PI / 180;
        const dlam = (lng2 - lng1) * Math.PI / 180;
        const x = dlam * Math.cos(phi1);
        const y = dphi;
        return Math.sqrt(x*x + y*y) * R;
    }
    function pointToSegMeters(lat, lng, a, b) {
        const ax = a.lng, ay = a.lat;
        const bx = b.lng, by = b.lat;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx*dx + dy*dy;
        let t = len2 === 0 ? 0 : ((lng - ax) * dx + (lat - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx, cy = ay + t * dy;
        return approxMeters(lat, lng, cy, cx);
    }
    function findEntityAtLatLng(lat, lng, siteID) {
        const bucket = mapObjectsBySite[siteID];
        if (!bucket) return null;
        const entities = bucket.entities || [];
        // 1. Polygon hit (assets type 3, FFZs type 16) — prefer smaller area
        //    on ties so user can pick a small asset inside a larger zone.
        let bestPoly = null, bestPolyArea = Infinity;
        for (const e of entities) {
            if ((e.type === 3 || e.type === 16) && Array.isArray(e.coords) && e.coords.length >= 3) {
                if (pointInPolygon(lat, lng, e.coords)) {
                    // Rough area via bounding box (cheap, no real area calc).
                    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
                    for (const c of e.coords) {
                        if (c.lat < minLat) minLat = c.lat;
                        if (c.lat > maxLat) maxLat = c.lat;
                        if (c.lng < minLng) minLng = c.lng;
                        if (c.lng > maxLng) maxLng = c.lng;
                    }
                    const area = (maxLat - minLat) * (maxLng - minLng);
                    if (area < bestPolyArea) { bestPoly = e; bestPolyArea = area; }
                }
            }
        }
        if (bestPoly) return bestPoly;
        // 2. Flight paths (type 15) — distance to nearest segment < 8m
        let bestFP = null, bestFPDist = 8;
        for (const e of entities) {
            if (e.type !== 15) continue;
            // Try the arcs first (more accurate segment list)
            if (Array.isArray(e.arcs) && e.arcs.length) {
                for (const arc of e.arcs) {
                    if (arc && arc.point_a && arc.point_b) {
                        const d = pointToSegMeters(lat, lng, arc.point_a, arc.point_b);
                        if (d < bestFPDist) { bestFP = e; bestFPDist = d; }
                    }
                }
            } else if (Array.isArray(e.coords) && e.coords.length >= 2) {
                for (let i = 0; i < e.coords.length - 1; i++) {
                    const d = pointToSegMeters(lat, lng, e.coords[i], e.coords[i+1]);
                    if (d < bestFPDist) { bestFP = e; bestFPDist = d; }
                }
            }
        }
        if (bestFP) return bestFP;
        // 3. Point markers (type 19) — nearest within 15m
        let bestPt = null, bestPtDist = 15;
        for (const e of entities) {
            if (e.type === 19 && Array.isArray(e.coords) && e.coords[0]) {
                const d = approxMeters(lat, lng, e.coords[0].lat, e.coords[0].lng);
                if (d < bestPtDist) { bestPt = e; bestPtDist = d; }
            }
        }
        return bestPt;
    }

    // ============================================================
    // Inspector popup UI
    // ============================================================
    const POPUP_ID = 'aim-inspector-popup';
    const TOAST_ID = 'aim-inspector-toast';
    let outsideListener = null;

    function closeInspector() {
        const el = document.getElementById(POPUP_ID);
        if (el) el.remove();
        if (outsideListener) {
            document.removeEventListener('mousedown', outsideListener, true);
            outsideListener = null;
        }
    }

    function entityTypeLabel(e) {
        const t = e.type;
        if (t === 3) return e.custom && e.custom.poi_type_str ? `Asset · ${e.custom.poi_type_str}` : 'Asset';
        if (t === 15) return 'Flight Path';
        if (t === 16) return 'Free Fly Zone';
        if (t === 19) return e.general_marker_type ? `Marker · ${e.general_marker_type}` : 'Marker';
        return `Type ${t}`;
    }
    function entityTypeColor(e) {
        const t = e.type;
        if (t === 3) return '#ffffff';
        if (t === 15) return '#1ca0de';
        if (t === 16) return '#5fff5f';
        if (t === 19) return '#ff9800';
        return '#7adfe6';
    }

    function buildEntityFields(e) {
        const out = [];
        out.push({ label: 'Name', value: e.name });
        out.push({ label: 'ID', value: e.id });
        if (e.type === 3 && e.custom) {
            if (e.custom.poi_type_str) out.push({ label: 'Subtype', value: e.custom.poi_type_str });
            if (typeof e.custom.elevation_asl === 'number') {
                out.push({ label: 'Elev ASL', value: `${e.custom.elevation_asl.toFixed(2)} ft` });
            }
            if (e.custom.altitude !== undefined && e.custom.altitude !== 0) {
                out.push({ label: 'Altitude', value: e.custom.altitude });
            }
            if (e.custom.height_agl != null) out.push({ label: 'Height AGL', value: e.custom.height_agl });
            if (e.custom.poi_id) out.push({ label: 'POI ID', value: e.custom.poi_id });
            out.push({ label: 'Unshielded', value: e.is_unshielded ? 'yes' : 'no' });
        }
        if (e.type === 15) {
            const wpCount = Array.isArray(e.coords) ? e.coords.length : 0;
            out.push({ label: 'Waypoints', value: wpCount });
            if (Array.isArray(e.arcs)) {
                out.push({ label: 'Segments', value: e.arcs.length });
                let totalM = 0;
                let minA = Infinity, maxA = -Infinity;
                for (const a of e.arcs) {
                    if (typeof a.distance === 'number') totalM += a.distance;
                    if (typeof a.min_alt === 'number' && a.min_alt < minA) minA = a.min_alt;
                    if (typeof a.max_alt === 'number' && a.max_alt > maxA) maxA = a.max_alt;
                }
                if (totalM > 0) {
                    out.push({ label: 'Total len', value: `${totalM.toFixed(1)} m (${(totalM * 3.28084).toFixed(0)} ft)` });
                }
                if (isFinite(minA) && isFinite(maxA)) {
                    out.push({ label: 'Alt range', value: `${minA} – ${maxA} ft` });
                }
            }
        }
        if (e.type === 16) {
            out.push({ label: 'Vertices', value: Array.isArray(e.coords) ? e.coords.length : 0 });
            if (e.restrictions && typeof e.restrictions === 'object') {
                if (e.restrictions.minAlt !== undefined) out.push({ label: 'Min Alt', value: `${e.restrictions.minAlt} ft` });
                if (e.restrictions.maxAlt !== undefined) out.push({ label: 'Max Alt', value: `${e.restrictions.maxAlt} ft` });
            }
        }
        if (e.type === 19) {
            if (e.general_marker_type) out.push({ label: 'Marker type', value: e.general_marker_type });
            if (Array.isArray(e.coords) && e.coords[0]) {
                out.push({ label: 'Coords', value: `${e.coords[0].lat.toFixed(6)}, ${e.coords[0].lng.toFixed(6)}` });
            }
        }
        if (e.description) {
            const desc = String(e.description).trim();
            if (desc) out.push({ label: 'Notes', value: desc.length > 140 ? desc.slice(0, 140) + '…' : desc });
        }
        out.push({ label: 'Validated', value: e.validated ? 'yes' : 'no' });
        return out;
    }

    function showInspectorPopup(x, y, entity) {
        closeInspector();
        const popup = document.createElement('div');
        popup.id = POPUP_ID;
        const typeColor = entityTypeColor(entity);
        const typeLabel = entityTypeLabel(entity);
        popup.style.cssText = `
            position:fixed;left:${x}px;top:${y}px;z-index:99999;
            background:#1f2228;border:1px solid rgba(20,210,220,0.55);border-radius:6px;
            box-shadow:0 4px 18px rgba(0,0,0,0.6);
            min-width:280px;max-width:380px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;padding:4px 0;
        `;

        const header = document.createElement('div');
        header.style.cssText = `padding:7px 12px;color:${typeColor};font-weight:600;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:2px;font-size:13px;line-height:1.25`;
        header.textContent = entity.name || '(unnamed)';
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:10px;color:#888;font-weight:normal;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px';
        sub.textContent = typeLabel;
        header.appendChild(sub);
        popup.appendChild(header);

        const rows = buildEntityFields(entity);
        rows.forEach(({ label, value }) => {
            if (value === '' || value === null || value === undefined) return;
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;padding:5px 12px;cursor:pointer;align-items:flex-start;gap:8px';
            row.onmouseenter = () => { row.style.background = 'rgba(20,210,220,0.12)'; };
            row.onmouseleave = () => { row.style.background = 'transparent'; };
            row.onclick = (ev) => {
                ev.stopPropagation();
                copyToClipboard(String(value), `Copied ${label}`);
            };
            const lbl = document.createElement('span');
            lbl.style.cssText = 'flex:0 0 75px;color:#888;font-size:11px;line-height:1.4';
            lbl.textContent = label;
            const val = document.createElement('span');
            val.style.cssText = 'flex:1;color:#e6e6e6;font-size:12px;word-break:break-word;line-height:1.4';
            val.textContent = String(value);
            const icon = document.createElement('span');
            icon.style.cssText = 'flex:0 0 14px;color:#7adfe6;font-size:11px;text-align:right;opacity:0.55';
            icon.textContent = '⧉';
            row.appendChild(lbl);
            row.appendChild(val);
            row.appendChild(icon);
            popup.appendChild(row);
        });

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;gap:6px;padding:7px 12px;border-top:1px solid rgba(255,255,255,0.08);margin-top:2px';

        const editBtn = document.createElement('button');
        editBtn.textContent = 'Open in editor';
        editBtn.style.cssText = 'flex:1;background:rgba(20,210,220,0.18);color:#7adfe6;border:1px solid rgba(20,210,220,0.45);border-radius:3px;padding:5px 8px;cursor:pointer;font:inherit;font-size:11px';
        editBtn.onclick = (ev) => {
            ev.stopPropagation();
            openInEditor(entity);
            closeInspector();
        };
        footer.appendChild(editBtn);

        const jsonBtn = document.createElement('button');
        jsonBtn.textContent = 'Copy JSON';
        jsonBtn.style.cssText = 'flex:0 0 90px;background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:5px 8px;cursor:pointer;font:inherit;font-size:11px';
        jsonBtn.onclick = (ev) => {
            ev.stopPropagation();
            copyToClipboard(JSON.stringify(entity, null, 2), 'Copied full JSON');
        };
        footer.appendChild(jsonBtn);

        popup.appendChild(footer);

        document.body.appendChild(popup);

        // Reposition if off-screen
        const r = popup.getBoundingClientRect();
        if (r.right > window.innerWidth) popup.style.left = `${window.innerWidth - r.width - 4}px`;
        if (r.bottom > window.innerHeight) popup.style.top = `${window.innerHeight - r.height - 4}px`;
        if (r.left < 0) popup.style.left = '4px';
        if (r.top < 0) popup.style.top = '4px';

        // Outside-click close — same pattern as KML menu fix (v34.24):
        // skip if mousedown lands inside the popup so action clicks fire.
        setTimeout(() => {
            outsideListener = (e) => {
                if (popup.contains(e.target)) return;
                closeInspector();
            };
            document.addEventListener('mousedown', outsideListener, true);
        }, 0);
    }

    // ============================================================
    // Clipboard + toast
    // ============================================================
    function showToast(msg, borderColor) {
        const old = document.getElementById(TOAST_ID);
        if (old) old.remove();
        const t = document.createElement('div');
        t.id = TOAST_ID;
        t.textContent = msg;
        t.style.cssText = `
            position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
            background:rgba(15,18,22,0.95);color:#e6e6e6;
            padding:10px 18px;border-radius:6px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            z-index:99999;border:1px solid ${borderColor || 'rgba(20,210,220,0.55)'};
            pointer-events:none;max-width:80vw;text-align:center;
            box-shadow:0 4px 18px rgba(0,0,0,0.5);
        `;
        document.body.appendChild(t);
        setTimeout(() => { try { t.remove(); } catch (e) {} }, 2500);
    }
    function copyToClipboard(text, label) {
        if (!text) return;
        const fallback = () => {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showToast(label || 'Copied');
            } catch (e) {
                showToast('Copy failed', 'rgba(255,96,96,0.55)');
                console.error(`${TAG} copy failed:`, e);
            }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                () => showToast(label || 'Copied'),
                fallback
            );
        } else {
            fallback();
        }
    }

    // ============================================================
    // "Open in editor" — synthesize a Shift+click at the entity's
    // centroid. Shift bypasses asset.lock (per Map Styler design),
    // so this works whether assets are locked or not.
    // ============================================================
    function openInEditor(entity) {
        const map = getLeafletMap();
        if (!map) {
            showToast('Map not ready — try again in a sec', 'rgba(255,96,96,0.55)');
            return;
        }
        if (!Array.isArray(entity.coords) || entity.coords.length === 0) {
            showToast('Cannot open editor: no coords on entity', 'rgba(255,96,96,0.55)');
            return;
        }
        let lat, lng;
        if (entity.coords.length >= 3) {
            let sumLat = 0, sumLng = 0;
            for (const c of entity.coords) { sumLat += c.lat; sumLng += c.lng; }
            lat = sumLat / entity.coords.length;
            lng = sumLng / entity.coords.length;
        } else {
            lat = entity.coords[0].lat;
            lng = entity.coords[0].lng;
        }
        let pt;
        try { pt = map.latLngToContainerPoint([lat, lng]); }
        catch (e) {
            showToast('Map projection failed', 'rgba(255,96,96,0.55)');
            return;
        }
        const cRect = map.getContainer().getBoundingClientRect();
        const sx = cRect.left + pt.x;
        const sy = cRect.top + pt.y;
        const target = document.elementFromPoint(sx, sy);
        if (!target) {
            showToast('Nothing at that screen point — pan first?', 'rgba(255,96,96,0.55)');
            return;
        }
        ['mousedown', 'mouseup', 'click'].forEach(typ => {
            const ev = new MouseEvent(typ, {
                bubbles: true, cancelable: true, view: window,
                clientX: sx, clientY: sy, button: 0,
                shiftKey: true, // bypass asset.locked
            });
            target.dispatchEvent(ev);
        });
        showToast(`Opened ${entity.name || entity.id} in editor`);
    }

    // ============================================================
    // Right-click handler — capture phase on window, gated to map area
    // ============================================================
    function installRightClickHandler() {
        window.addEventListener('contextmenu', (e) => {
            if (!masterEnabled) return;
            const target = e.target;
            // Don't intercept inputs / editable areas — preserve native context menu there
            if (target && target.tagName) {
                const tn = target.tagName;
                if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT' || target.isContentEditable) return;
                if (target.closest && target.closest('.ant-input, .ant-select')) return;
            }
            const map = getLeafletMap();
            if (!map) return;
            const container = map.getContainer();
            // Must be a right-click inside the map's container
            if (!container.contains(target)) return;
            const siteID = getCurrentSiteID();
            if (!siteID) return;
            const cRect = container.getBoundingClientRect();
            const px = e.clientX - cRect.left;
            const py = e.clientY - cRect.top;
            let latlng;
            try { latlng = map.containerPointToLatLng([px, py]); }
            catch (err) { return; }
            if (!latlng) return;
            // Lazy-fetch if not loaded yet
            if (!mapObjectsBySite[siteID] && !fetchingSites.has(siteID)) {
                fetchMapObjects(siteID);
                showToast('Loading site entities — try right-click again in a sec', 'rgba(255,180,0,0.55)');
                return;
            }
            if (fetchingSites.has(siteID)) {
                showToast('Still loading…', 'rgba(255,180,0,0.55)');
                return;
            }
            const entity = findEntityAtLatLng(latlng.lat, latlng.lng, siteID);
            if (!entity) {
                // Don't intercept — let native context menu show (user
                // right-clicked on empty map). Could toast "no entity here"
                // but that would be annoying for normal map right-clicks.
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            showInspectorPopup(e.clientX, e.clientY, entity);
        }, true);
    }

    // ============================================================
    // Control Panel integration
    // ============================================================
    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); }
        catch (e) { return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                if (msg.toggleId === 'master') {
                    masterEnabled = !!(msg.value !== undefined ? msg.value : msg.enabled);
                }
            } else if (msg.type === 'TRIGGER_ACTION' && msg.scriptId === SCRIPT_ID && CONTEXT === 'IFRAME') {
                // Gate to IFRAME + focused tab (same pattern as Map Styler v34.28)
                if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
                if (msg.actionId === 'refresh-entities') {
                    const sid = getCurrentSiteID();
                    if (sid) {
                        delete mapObjectsBySite[sid];
                        fetchMapObjects(sid, true);
                        showToast(`Refreshing entities for site ${sid}…`);
                    } else {
                        showToast('No site loaded', 'rgba(255,96,96,0.55)');
                    }
                }
            }
        };
    }
    function registerWithControlPanel() {
        if (!controlChannel) return;
        // Refresh button included as a `type: 'button'` toggle entry — the
        // panel renders type:'button' rows with a click action that emits
        // TRIGGER_ACTION back to us (handled in setupControlPanel).
        controlChannel.postMessage({
            type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Asset Inspector',
            description: 'Right-click any entity (asset/FFZ/flight path/marker) for an inspector popup. Click any row to copy its value.',
            version: SCRIPT_VERSION, group: 'Hotkeys', priority: 40,
            toggles: [
                { id: 'master', label: 'Enable (right-click any entity)', type: 'boolean', default: true, master: true },
                { id: 'refresh-action', label: 'Refresh entity data for this site', type: 'button', action: 'refresh-entities' },
            ],
            hotkeys: [],
        });
    }
    setupControlPanel();
    registerWithControlPanel();
    installRightClickHandler();

    // ============================================================
    // Initial fetch + site-change refetch (IFRAME only — TOP has no
    // map, doesn't need entity data, and fetching from both wastes a
    // round trip).
    // ============================================================
    if (CONTEXT === 'IFRAME') {
        // Delay first fetch so the page has a chance to settle.
        setTimeout(() => {
            const sid = getCurrentSiteID();
            if (sid) fetchMapObjects(sid);
        }, 2500);
        let lastSite = getCurrentSiteID();
        window.addEventListener('hashchange', () => {
            const sid = getCurrentSiteID();
            if (sid && sid !== lastSite) {
                lastSite = sid;
                console.log(`${TAG} site changed to ${sid} — refetching entities`);
                fetchMapObjects(sid);
            }
        });
    }

    console.log(`${TAG} v2.0 ready`);
})();
