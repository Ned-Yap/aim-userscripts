// ==UserScript==
// @name         AIM Copy Asset Name
// @namespace    http://tampermonkey.net/
// @version      3.3
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
    const SCRIPT_VERSION = '3.3';
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
        // 1. Polygon hit (assets type 3, NFZs type 4, FFZs type 16) — prefer
        //    smaller area on ties so user can pick a small asset inside a
        //    larger zone.
        let bestPoly = null, bestPolyArea = Infinity;
        for (const e of entities) {
            if ((e.type === 3 || e.type === 4 || e.type === 16) && Array.isArray(e.coords) && e.coords.length >= 3) {
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

    // Central type registry. Single source of truth — every label,
    // color, sort-priority, short-name lookup goes through this.
    //   - 3  = Asset (white, drone-mission target)
    //   - 4  = NFZ (no-fly zone — red, forbidden airspace)
    //   - 15 = Flight Path (blue)
    //   - 16 = FFZ (free fly zone — green, allowed airspace)
    //   - 19 = General Marker (purple — matches AIM altitude markers)
    //
    // sortPrio matches the user's preferred default order:
    //   FP → FFZ → NFZ → Asset → Marker.
    // hasValidStatus marks types where the `validated` flag is
    // meaningful in Percepto's UI — Assets and Markers hide the
    // toggle entirely, so we treat their `validated` value as N/A.
    const TYPE_REG = {
        3:  { short: 'Ast', long: 'Asset',           color: '#ffffff', sortPrio: 4, hasValidStatus: false },
        4:  { short: 'NFZ', long: 'No Fly Zone',     color: '#ff5555', sortPrio: 3, hasValidStatus: true  },
        15: { short: 'FP',  long: 'Flight Path',     color: '#1ca0de', sortPrio: 1, hasValidStatus: true  },
        16: { short: 'FFZ', long: 'Free Fly Zone',   color: '#5fff5f', sortPrio: 2, hasValidStatus: true  },
        19: { short: 'Mkr', long: 'Marker',          color: '#c084fc', sortPrio: 5, hasValidStatus: false },
    };
    function typeReg(t) { return TYPE_REG[t] || { short: '?', long: `Type ${t}`, color: '#7adfe6', sortPrio: 99, hasValidStatus: false }; }

    function entityTypeLabel(e) {
        const reg = typeReg(e.type);
        if (e.type === 3) return e.custom && e.custom.poi_type_str ? `${reg.long} · ${e.custom.poi_type_str}` : reg.long;
        if (e.type === 19) return e.general_marker_type ? `${reg.long} · ${e.general_marker_type}` : reg.long;
        return reg.long;
    }
    function entityTypeColor(e) { return typeReg(e.type).color; }

    // Build a dual-unit row: feet (converted from meters) / meters,
    // each number separately click-to-copy. Units are display-only,
    // never included in the copied text.
    //
    //   Input: meters as a number (from Percepto's JSON, which stores
    //          altitudes/elevations/distances in meters even though the
    //          UI displays feet).
    //   Output: row with `parts` array — renderer splits into copyable
    //           spans (with `copy`) and plain spans (`copy: null`).
    function meterRow(label, meters, ftDecimals, mDecimals) {
        if (typeof meters !== 'number' || !isFinite(meters)) return null;
        const ft = meters * 3.28084;
        const ftStr = ft.toFixed(ftDecimals != null ? ftDecimals : (ft < 100 ? 1 : 0));
        const mStr = meters.toFixed(mDecimals != null ? mDecimals : 2);
        return {
            label,
            parts: [
                { text: ftStr, copy: ftStr },
                { text: ' ft / ', copy: null },
                { text: mStr, copy: mStr },
                { text: ' m', copy: null },
            ],
        };
    }

    function buildEntityFields(e) {
        const out = [];
        out.push({ label: 'Name', value: e.name });
        out.push({ label: 'ID', value: e.id });
        if (e.type === 3 && e.custom) {
            if (e.custom.poi_type_str) out.push({ label: 'Subtype', value: e.custom.poi_type_str });
            // Elevation ASL is in meters in the JSON despite Percepto's
            // UI labeling it as ft elsewhere. Show both.
            if (typeof e.custom.elevation_asl === 'number') {
                const row = meterRow('Elev ASL', e.custom.elevation_asl);
                if (row) out.push(row);
            }
            if (typeof e.custom.altitude === 'number' && e.custom.altitude !== 0) {
                const row = meterRow('Altitude', e.custom.altitude);
                if (row) out.push(row);
            }
            if (typeof e.custom.height_agl === 'number') {
                const row = meterRow('Height AGL', e.custom.height_agl);
                if (row) out.push(row);
            }
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
                    const row = meterRow('Total len', totalM, 0, 1);
                    if (row) out.push(row);
                }
                if (isFinite(minA)) {
                    const row = meterRow('Min Alt', minA);
                    if (row) out.push(row);
                }
                if (isFinite(maxA)) {
                    const row = meterRow('Max Alt', maxA);
                    if (row) out.push(row);
                }
            }
        }
        if (e.type === 16) {
            out.push({ label: 'Vertices', value: Array.isArray(e.coords) ? e.coords.length : 0 });
            if (e.restrictions && typeof e.restrictions === 'object') {
                if (typeof e.restrictions.minAlt === 'number') {
                    const row = meterRow('Min Alt', e.restrictions.minAlt);
                    if (row) out.push(row);
                }
                if (typeof e.restrictions.maxAlt === 'number') {
                    const row = meterRow('Max Alt', e.restrictions.maxAlt);
                    if (row) out.push(row);
                }
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
        header.style.cssText = `padding:7px 32px 7px 12px;color:${typeColor};font-weight:600;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:2px;font-size:13px;line-height:1.25;position:relative`;
        header.textContent = entity.name || '(unnamed)';
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:10px;color:#888;font-weight:normal;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px';
        sub.textContent = typeLabel;
        header.appendChild(sub);
        // × close button — top-right corner.
        const xBtn = document.createElement('button');
        xBtn.textContent = '×';
        xBtn.title = 'Close';
        xBtn.style.cssText = 'position:absolute;top:4px;right:6px;background:transparent;border:none;color:#888;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:3px';
        xBtn.onmouseenter = () => { xBtn.style.color = '#e6e6e6'; xBtn.style.background = 'rgba(255,255,255,0.06)'; };
        xBtn.onmouseleave = () => { xBtn.style.color = '#888'; xBtn.style.background = 'transparent'; };
        xBtn.onclick = (ev) => { ev.stopPropagation(); closeInspector(); };
        header.appendChild(xBtn);
        popup.appendChild(header);

        const rows = buildEntityFields(entity);
        rows.forEach(rowSpec => {
            if (!rowSpec) return;
            const { label, value, parts } = rowSpec;
            // Multi-part rows (dual-unit altitudes etc.) — each `part`
            // is either copyable (has .copy) or plain text (.copy null).
            if (Array.isArray(parts) && parts.length) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;padding:5px 12px;align-items:flex-start;gap:8px';
                const lbl = document.createElement('span');
                lbl.style.cssText = 'flex:0 0 75px;color:#888;font-size:11px;line-height:1.4';
                lbl.textContent = label;
                row.appendChild(lbl);
                const val = document.createElement('span');
                val.style.cssText = 'flex:1;color:#e6e6e6;font-size:12px;word-break:break-word;line-height:1.4';
                parts.forEach(p => {
                    const span = document.createElement('span');
                    span.textContent = p.text;
                    if (p.copy !== null && p.copy !== undefined) {
                        span.style.cssText = 'cursor:pointer;padding:0 2px;border-radius:2px';
                        span.onmouseenter = () => { span.style.background = 'rgba(20,210,220,0.25)'; };
                        span.onmouseleave = () => { span.style.background = 'transparent'; };
                        span.onclick = (ev) => {
                            ev.stopPropagation();
                            copyToClipboard(String(p.copy), `Copied ${p.copy}`);
                        };
                    } else {
                        span.style.cssText = 'color:#888;font-size:11px';
                    }
                    val.appendChild(span);
                });
                row.appendChild(val);
                const icon = document.createElement('span');
                icon.style.cssText = 'flex:0 0 14px;color:#7adfe6;font-size:11px;text-align:right;opacity:0.55';
                icon.textContent = '⧉';
                row.appendChild(icon);
                popup.appendChild(row);
                return;
            }
            // Single-value rows — whole row click-to-copy as before.
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

        const findBtn = document.createElement('button');
        findBtn.textContent = '🔍 Find in Map Entities';
        findBtn.style.cssText = 'flex:1;background:rgba(20,210,220,0.18);color:#7adfe6;border:1px solid rgba(20,210,220,0.45);border-radius:3px;padding:5px 8px;cursor:pointer;font:inherit;font-size:11px';
        findBtn.onclick = (ev) => {
            ev.stopPropagation();
            findEntityInSidebar(entity);
            closeInspector();
        };
        footer.appendChild(findBtn);

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
    // "Find in Map Entities" — paste entity name into the sidebar's
    // Search input and trigger the filter.
    //
    // Why this instead of dispatching map clicks:
    //   v2.0–v2.2 tried synthetic DOM clicks and layer.fire('click') on
    //   the matched map layer. Layer matching worked (console showed
    //   sub-meter matches) but the dispatched events were no-ops —
    //   Percepto's selection handler isn't bound via Leaflet's
    //   .on('click', …) or any DOM listener we could reach. The sidebar
    //   route bypasses the whole map-click problem.
    //
    // Why the React-aware value setter:
    //   The sidebar input is an Ant Design <input> driven by React.
    //   Setting input.value directly doesn't notify React — its onChange
    //   doesn't fire and the filter doesn't apply. The workaround is to
    //   call the native HTMLInputElement.value setter via prototype, then
    //   dispatch a bubbling 'input' event. React's synthetic event system
    //   picks it up.
    //
    // What's still manual:
    //   v2.4 only filters the list. User still clicks the matching result
    //   row to open the editor. Auto-clicking the result requires a
    //   selector for the result row, which I haven't sniffed yet. v2.5
    //   can add that once the result row's outerHTML is shared.
    // ============================================================
    const SIDEBAR_INPUT_SELECTOR = 'input.ant-input[placeholder="Search entity"]';

    function findEntityInSidebar(entity) {
        const name = entity && entity.name;
        if (!name) {
            showToast('No name on entity to search', 'rgba(255,180,0,0.55)');
            return;
        }
        // Sidebar input might be in TOP or IFRAME. Try our own document
        // first; if it's not here, walk frames.
        let input = document.querySelector(SIDEBAR_INPUT_SELECTOR);
        if (!input) {
            try {
                const allFrames = Array.from(window.top.document.querySelectorAll('iframe'));
                input = window.top.document.querySelector(SIDEBAR_INPUT_SELECTOR);
                for (let i = 0; !input && i < allFrames.length; i++) {
                    try { input = allFrames[i].contentDocument.querySelector(SIDEBAR_INPUT_SELECTOR); }
                    catch (e) { /* cross-origin frame */ }
                }
            } catch (e) { /* cross-origin top */ }
        }
        if (!input) {
            showToast('Map Entities search input not found — sidebar open?', 'rgba(255,96,96,0.55)');
            console.warn(`${TAG} sidebar input not found via "${SIDEBAR_INPUT_SELECTOR}"`);
            return;
        }
        // React-aware value setter — bypasses React's input-tracking guard.
        try {
            const proto = window.HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) {
                descriptor.set.call(input, name);
            } else {
                input.value = name;
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            // Also focus the input so the user can immediately keyboard-arrow
            // through results if they want.
            try { input.focus(); } catch (e) {}
            showToast(`Filtered Map Entities to "${name}" — click the result to open`);
        } catch (e) {
            console.warn(`${TAG} sidebar paste failed, falling back to clipboard:`, e);
            copyToClipboard(name, `Copied "${name}" — paste in Map Entities sidebar`);
        }
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
    // SUMMARY VIEW — floating panel listing every entity on the site.
    // Reuses the same /map_objects cache the right-click inspector
    // already builds, so no duplicate fetches.
    //
    // Triggered by a SUM button injected next to Percepto's native
    // entity-header toolbar (alongside the existing ALT and VAL buttons
    // from AIM_Bulk_Altitude_Updater and AIM_Bulk_Validator, which
    // already inject into #aim-automation-container — we just append).
    // ============================================================
    const SUM_BTN_ID = 'aim-sum-trigger-btn';
    const SUM_PANEL_ID = 'aim-sum-panel';
    // Default visible columns — user can toggle via "Columns ▾" menu.
    // 'sel' is the multi-select checkbox column (always on, not in the menu).
    const ALL_COL_KEYS = ['typeShort', 'name', 'subtype', 'elev', 'altMin', 'altMax', 'validated'];
    let sumPanelState = {
        search: '',
        typeFilter: new Set(['3', '4', '15', '16', '19']), // All types on by default
        validatedOnly: false,
        unvalidatedOnly: false,
        unshieldedOnly: false,
        notesOnly: false,
        unitsFt: true,             // false → display meters
        // Default sort = by type-priority (FP → FFZ → NFZ → Asset → Marker),
        // then A→Z within each type group. Sort by 'typePrio' uses the
        // numeric priority; the secondary tie-break by name happens in
        // filterAndSortRows when sortKey === 'typePrio'.
        sortKey: 'typePrio',
        sortDir: 1,
        x: null, y: null,          // last drag position (px from viewport)
        w: 720, h: null,           // last drag size (null = use default max-height)
        selectedIds: new Set(),    // multi-select state — survives panel reopen
        visibleCols: new Set(ALL_COL_KEYS),
    };

    function injectSumButton(doc) {
        // Don't inject in edit mode — Bulk Validator hides the whole
        // toolbar then, and SUM should follow the same convention.
        if (doc.querySelector('.upsert-entity')) {
            const existing = doc.getElementById(SUM_BTN_ID);
            if (existing) existing.style.display = 'none';
            return;
        }
        if (doc.getElementById(SUM_BTN_ID)) {
            doc.getElementById(SUM_BTN_ID).style.display = '';
            return;
        }
        const header = doc.querySelector('.site-setup-header--all-entities');
        if (!header) return;
        let container = doc.getElementById('aim-automation-container');
        // If neither ALT nor VAL ran first, create the container. Use
        // the same styling they use so layout stays consistent.
        if (!container) {
            container = doc.createElement('div');
            container.id = 'aim-automation-container';
            Object.assign(container.style, {
                width: '100%', display: 'flex', justifyContent: 'flex-start',
                padding: '4px 0 8px 16px', borderBottom: '1px solid #f0f0f0',
                marginTop: '-4px', gap: '10px',
            });
            header.after(container);
        }
        const newBtnRef = header.querySelector('.site-setup-header__new_entity-button');
        const btn = doc.createElement('button');
        btn.id = SUM_BTN_ID;
        btn.type = 'button';
        btn.className = newBtnRef ? newBtnRef.className : 'ant-btn ant-btn-primary ant-btn-sm';
        Object.assign(btn.style, {
            minWidth: 'unset', padding: '0 12px', height: '24px',
            fontSize: '10px', fontWeight: 'bold',
        });
        btn.innerHTML = 'SUM';
        btn.title = 'Open entities summary (AIM Asset Inspector)';
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openSummaryPanel();
        };
        container.appendChild(btn);
    }
    function recursiveSumInject(win) {
        try {
            injectSumButton(win.document);
            const frames = win.document.querySelectorAll('iframe');
            frames.forEach(f => { if (f.contentWindow) recursiveSumInject(f.contentWindow); });
        } catch (e) {}
    }
    function runSumInjection() {
        if (!masterEnabled) return;
        recursiveSumInject(window);
    }
    if (CONTEXT === 'IFRAME') {
        setInterval(runSumInjection, 2000);
        setTimeout(runSumInjection, 500);
    }

    // ----- Summary panel UI -----
    function closeSummaryPanel() {
        const el = document.getElementById(SUM_PANEL_ID);
        if (el) el.remove();
    }

    function openSummaryPanel() {
        closeInspector();
        const siteID = getCurrentSiteID();
        if (!siteID) {
            showToast('No site loaded', 'rgba(255,96,96,0.55)');
            return;
        }
        if (!mapObjectsBySite[siteID]) {
            fetchMapObjects(siteID);
            showToast('Loading entities — try again in a sec', 'rgba(255,180,0,0.55)');
            return;
        }
        renderSummaryPanel(siteID);
    }

    // Shorthand for the summary table — route through TYPE_REG so labels
    // and colors come from a single source of truth.
    function typeShortLabel(t) { return typeReg(t).short; }
    function typeBadgeColor(t) { return typeReg(t).color; }

    // Build the flat row-set for the table. Each row is { entity, name,
    // typeLabel, subtype, elevFt, altRangeFt, validated } — pre-computed
    // so sort/filter are cheap.
    function buildSummaryRows(siteID) {
        const bucket = mapObjectsBySite[siteID];
        if (!bucket) return [];
        return (bucket.entities || []).map(e => {
            const reg = typeReg(e.type);
            const row = {
                entity: e,
                type: e.type,
                typeShort: reg.short,
                typePrio: reg.sortPrio,
                name: e.name || '',
                subtype: '',
                // Altitudes/elevations stored in METERS (source of truth);
                // display converts to ft when sumPanelState.unitsFt is on.
                // Sort uses the meter value directly — relative ordering is
                // the same in either unit.
                elevM: null,
                altMinM: null,
                altMaxM: null,
                // validated is null for types where Percepto hides the
                // toggle (Assets, Markers) — we treat those as N/A so the
                // Validated/Unvalidated filters don't accidentally hide
                // every asset on the site.
                validated: reg.hasValidStatus ? !!e.validated : null,
                unshielded: !!e.is_unshielded,
                hasNotes: !!(e.description && String(e.description).trim()),
            };
            if (e.type === 3 && e.custom) {
                row.subtype = e.custom.poi_type_str || '';
                if (typeof e.custom.elevation_asl === 'number') {
                    row.elevM = e.custom.elevation_asl;
                }
            }
            if (e.type === 15 && Array.isArray(e.arcs) && e.arcs.length) {
                let minA = Infinity, maxA = -Infinity;
                for (const a of e.arcs) {
                    if (typeof a.min_alt === 'number' && a.min_alt < minA) minA = a.min_alt;
                    if (typeof a.max_alt === 'number' && a.max_alt > maxA) maxA = a.max_alt;
                }
                if (isFinite(minA)) row.altMinM = minA;
                if (isFinite(maxA)) row.altMaxM = maxA;
            }
            // NFZ (4) and FFZ (16) both store altitude range in restrictions.
            if ((e.type === 4 || e.type === 16) && e.restrictions && typeof e.restrictions === 'object') {
                if (typeof e.restrictions.minAlt === 'number') row.altMinM = e.restrictions.minAlt;
                if (typeof e.restrictions.maxAlt === 'number') row.altMaxM = e.restrictions.maxAlt;
            }
            if (e.type === 19) row.subtype = e.general_marker_type || '';
            return row;
        });
    }

    function filterAndSortRows(rows, state) {
        const q = (state.search || '').trim().toLowerCase();
        let out = rows.filter(r => {
            if (!state.typeFilter.has(String(r.type))) return false;
            // Validation filters apply only to types where validation is
            // meaningful (FFZ / FP / NFZ). N/A rows (r.validated === null)
            // are excluded by both filters when active — they have no
            // valid/invalid state to match against.
            if (state.validatedOnly && r.validated !== true) return false;
            if (state.unvalidatedOnly && r.validated !== false) return false;
            if (state.unshieldedOnly && !r.unshielded) return false;
            if (state.notesOnly && !r.hasNotes) return false;
            if (q && !r.name.toLowerCase().includes(q) && !r.subtype.toLowerCase().includes(q)) return false;
            return true;
        });
        const dir = state.sortDir;
        const cmp = (a, b, key) => {
            const va = a[key], vb = b[key];
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (typeof va === 'number' && typeof vb === 'number') return va - vb;
            return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
        };
        out.sort((a, b) => {
            // Special handling when sorting by type — secondary sort by name
            // gives the "FP A→Z, FFZ A→Z, NFZ A→Z, Asset A→Z, Marker A→Z"
            // group layout the user wants by default.
            if (state.sortKey === 'typePrio') {
                const d = a.typePrio - b.typePrio;
                if (d !== 0) return dir * d;
                return dir * cmp(a, b, 'name');
            }
            return dir * cmp(a, b, state.sortKey);
        });
        return out;
    }

    function renderSummaryPanel(siteID) {
        closeSummaryPanel();
        const allRows = buildSummaryRows(siteID);

        const panel = document.createElement('div');
        panel.id = SUM_PANEL_ID;
        const startW = sumPanelState.w || 720;
        const startH = sumPanelState.h; // null = use max-height: 80vh
        const startX = sumPanelState.x != null ? sumPanelState.x : Math.max(60, window.innerWidth - startW - 40);
        const startY = sumPanelState.y != null ? sumPanelState.y : 80;
        panel.style.cssText = `
            position:fixed;left:${startX}px;top:${startY}px;z-index:99998;
            width:${startW}px;${startH ? `height:${startH}px;` : 'max-height:80vh;'}
            max-width:96vw;display:flex;flex-direction:column;
            background:#1f2228;border:1px solid rgba(20,210,220,0.55);border-radius:8px;
            box-shadow:0 6px 28px rgba(0,0,0,0.65);
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;
        `;

        // --- Header (draggable) ---
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.08);cursor:move;user-select:none;background:rgba(20,210,220,0.06)';
        const title = document.createElement('div');
        title.style.cssText = 'flex:1;color:#7adfe6;font-weight:600;font-size:13px';
        title.textContent = `AIM Entities · Site ${siteID}`;
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = 'background:transparent;border:none;color:#bbb;font-size:18px;cursor:pointer;padding:0 4px;line-height:1';
        closeBtn.onclick = closeSummaryPanel;
        head.appendChild(title);
        head.appendChild(closeBtn);
        panel.appendChild(head);

        // Drag handling — track on head mousedown, follow mousemove, snap
        // back to viewport on release. Stored in sumPanelState so position
        // persists between open/close.
        let dragging = false, dragOffX = 0, dragOffY = 0;
        head.addEventListener('mousedown', (e) => {
            if (e.target === closeBtn) return;
            dragging = true;
            const r = panel.getBoundingClientRect();
            dragOffX = e.clientX - r.left;
            dragOffY = e.clientY - r.top;
            e.preventDefault();
        });
        const onMove = (e) => {
            if (!dragging) return;
            let nx = e.clientX - dragOffX, ny = e.clientY - dragOffY;
            nx = Math.max(0, Math.min(window.innerWidth - 80, nx));
            ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
            panel.style.left = nx + 'px';
            panel.style.top = ny + 'px';
            sumPanelState.x = nx; sumPanelState.y = ny;
        };
        const onUp = () => { dragging = false; };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        // Clean up listeners when panel closes
        const origRemove = panel.remove.bind(panel);
        panel.remove = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            origRemove();
        };

        // --- Toolbar (search + filters) ---
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.08)';
        const searchRow = document.createElement('div');
        searchRow.style.cssText = 'display:flex;gap:8px;align-items:center';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = '🔍  Search name or subtype…';
        searchInput.value = sumPanelState.search;
        searchInput.style.cssText = 'flex:1;background:#15171c;color:#e6e6e6;border:1px solid rgba(255,255,255,0.18);border-radius:4px;padding:5px 8px;font:inherit;font-size:12px';
        searchInput.oninput = () => {
            sumPanelState.search = searchInput.value;
            redrawTable();
        };
        searchRow.appendChild(searchInput);
        toolbar.appendChild(searchRow);

        const chipRow = document.createElement('div');
        chipRow.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
        // Type chips ordered to match the default sort priority
        // (FP → FFZ → NFZ → Asset → Marker). Compact labels — full names
        // were chewing up the toolbar width. Each chip uses its type's
        // color so the toolbar visually mirrors the colored Type column.
        const chipDefs = [
            { tNum: '15', label: 'FPs'    },
            { tNum: '16', label: 'FFZs'   },
            { tNum: '4',  label: 'NFZs'   },
            { tNum: '3',  label: 'Assets' },
            { tNum: '19', label: 'GMs'    },
        ];
        chipDefs.forEach(({ tNum, label }) => {
            const reg = typeReg(parseInt(tNum, 10));
            const color = reg.color;
            const chip = document.createElement('button');
            chip.type = 'button';
            const update = () => {
                const on = sumPanelState.typeFilter.has(tNum);
                if (on) {
                    // Use the type's color: 22%-opacity background + full-color
                    // text + 70%-opacity border. Hex "33" = ~20% alpha,
                    // "aa" = ~67%, both nicely visible on the dark panel.
                    chip.style.cssText = `background:${color}33;color:${color};border:1px solid ${color}aa;border-radius:12px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;font-weight:600`;
                } else {
                    chip.style.cssText = 'background:transparent;color:#666;border:1px solid rgba(255,255,255,0.15);border-radius:12px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px';
                }
            };
            chip.textContent = label;
            chip.onclick = () => {
                if (sumPanelState.typeFilter.has(tNum)) sumPanelState.typeFilter.delete(tNum);
                else sumPanelState.typeFilter.add(tNum);
                update();
                redrawTable();
            };
            update();
            chipRow.appendChild(chip);
        });
        // Filter checkboxes. Validated and Unvalidated are mutually
        // exclusive — toggling one auto-clears the other (otherwise
        // both ON shows nothing, which is just confusing).
        function makeFilterCheckbox(labelText, stateKey, opts) {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex;align-items:center;gap:4px;color:#bbb;font-size:11px;cursor:pointer;margin-left:8px';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!sumPanelState[stateKey];
            cb.style.cssText = 'accent-color:rgb(20,210,220);cursor:pointer';
            cb.onchange = () => {
                sumPanelState[stateKey] = cb.checked;
                if (cb.checked && opts && opts.unset) {
                    // Re-render the panel so the paired checkbox visually unsets too.
                    sumPanelState[opts.unset] = false;
                    renderSummaryPanel(siteID);
                    return;
                }
                redrawTable();
            };
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(labelText));
            return lbl;
        }
        chipRow.appendChild(makeFilterCheckbox('Validated only', 'validatedOnly', { unset: 'unvalidatedOnly' }));
        chipRow.appendChild(makeFilterCheckbox('Unvalidated only', 'unvalidatedOnly', { unset: 'validatedOnly' }));
        chipRow.appendChild(makeFilterCheckbox('Unshielded only', 'unshieldedOnly'));
        chipRow.appendChild(makeFilterCheckbox('Has notes', 'notesOnly'));
        toolbar.appendChild(chipRow);

        // Unit toggle + Columns menu — second toolbar row.
        const optsRow = document.createElement('div');
        optsRow.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding-top:4px;border-top:1px dashed rgba(255,255,255,0.06)';
        // Units: simple checkbox toggle between ft (checked) and m (unchecked).
        const unitsLbl = document.createElement('label');
        unitsLbl.style.cssText = 'display:flex;align-items:center;gap:4px;color:#bbb;font-size:11px;cursor:pointer';
        const unitsCb = document.createElement('input');
        unitsCb.type = 'checkbox';
        unitsCb.checked = !!sumPanelState.unitsFt;
        unitsCb.style.cssText = 'accent-color:rgb(20,210,220);cursor:pointer';
        unitsCb.onchange = () => {
            sumPanelState.unitsFt = unitsCb.checked;
            redrawTable();
        };
        unitsLbl.appendChild(unitsCb);
        unitsLbl.appendChild(document.createTextNode('Show in feet (uncheck for meters)'));
        optsRow.appendChild(unitsLbl);

        // Columns menu — opens a small popover with one checkbox per column.
        // Hidden columns are also omitted from CSV/TSV exports.
        const colsBtn = document.createElement('button');
        colsBtn.type = 'button';
        colsBtn.textContent = 'Columns ▾';
        colsBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;margin-left:auto';
        let colsMenuEl = null;
        colsBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (colsMenuEl) { colsMenuEl.remove(); colsMenuEl = null; return; }
            colsMenuEl = document.createElement('div');
            // position:fixed so the menu doesn't extend the document scroll
            // region — `absolute` was pinning to the body and adding right-
            // edge / bottom-edge horizontal scrollbars to the page when the
            // menu sat near the panel's right corner.
            colsMenuEl.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(20,210,220,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:6px 10px;z-index:99999;font-size:11px;color:#e6e6e6;min-width:160px';
            const colDefs = [
                { key: 'typeShort', label: 'Type' },
                { key: 'name',      label: 'Name' },
                { key: 'subtype',   label: 'Subtype' },
                { key: 'elev',      label: 'Elevation' },
                { key: 'altMin',    label: 'Min Alt' },
                { key: 'altMax',    label: 'Max Alt' },
                { key: 'validated', label: 'Valid' },
            ];
            colDefs.forEach(({ key, label }) => {
                const row = document.createElement('label');
                row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = sumPanelState.visibleCols.has(key);
                cb.style.cssText = 'accent-color:rgb(20,210,220);cursor:pointer';
                cb.onchange = () => {
                    if (cb.checked) sumPanelState.visibleCols.add(key);
                    else sumPanelState.visibleCols.delete(key);
                    redrawTable();
                };
                row.appendChild(cb);
                row.appendChild(document.createTextNode(label));
                colsMenuEl.appendChild(row);
            });
            // Position just below the button, then clamp post-mount so it
            // doesn't push past the viewport edge (which used to trigger
            // a page-level scrollbar).
            const r = colsBtn.getBoundingClientRect();
            colsMenuEl.style.left = r.left + 'px';
            colsMenuEl.style.top = (r.bottom + 4) + 'px';
            document.body.appendChild(colsMenuEl);
            const menuRect = colsMenuEl.getBoundingClientRect();
            if (menuRect.right > window.innerWidth - 8) {
                colsMenuEl.style.left = (window.innerWidth - menuRect.width - 8) + 'px';
            }
            if (menuRect.bottom > window.innerHeight - 8) {
                // Flip above the button if there's no room below.
                colsMenuEl.style.top = (r.top - menuRect.height - 4) + 'px';
            }
            const onDocClick = (e) => {
                if (colsMenuEl && !colsMenuEl.contains(e.target) && e.target !== colsBtn) {
                    colsMenuEl.remove(); colsMenuEl = null;
                    document.removeEventListener('mousedown', onDocClick, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
        };
        optsRow.appendChild(colsBtn);
        toolbar.appendChild(optsRow);
        panel.appendChild(toolbar);

        // --- Table area ---
        const tableWrap = document.createElement('div');
        tableWrap.style.cssText = 'flex:1;overflow:auto;min-height:0';
        panel.appendChild(tableWrap);

        // --- Footer ---
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 12px;border-top:1px solid rgba(255,255,255,0.08);background:rgba(0,0,0,0.15);flex-wrap:wrap';
        const countEl = document.createElement('div');
        countEl.style.cssText = 'flex:1;color:#888;font-size:11px;min-width:140px';
        footer.appendChild(countEl);
        // Button style helper — three Copy buttons + Refresh need it.
        const BTN_CSS = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:4px 10px;cursor:pointer;font:inherit;font-size:11px';
        const csvBtn = document.createElement('button');
        csvBtn.textContent = 'Copy CSV';
        csvBtn.style.cssText = BTN_CSS;
        const tsvBtn = document.createElement('button');
        tsvBtn.textContent = 'Copy → Sheets';
        tsvBtn.title = 'Tab-separated — paste directly into Google Sheets / Excel';
        tsvBtn.style.cssText = BTN_CSS;
        const jsonBtn = document.createElement('button');
        jsonBtn.textContent = 'Copy JSON';
        jsonBtn.style.cssText = BTN_CSS;
        const refreshBtn = document.createElement('button');
        refreshBtn.textContent = 'Refresh';
        refreshBtn.style.cssText = BTN_CSS;
        refreshBtn.onclick = () => {
            const sid = getCurrentSiteID();
            if (!sid) return;
            delete mapObjectsBySite[sid];
            fetchMapObjects(sid, true);
            showToast('Refreshing entities…');
            // Re-render after a short delay so the new data is in the cache.
            setTimeout(() => {
                if (mapObjectsBySite[sid]) renderSummaryPanel(sid);
            }, 1500);
        };
        footer.appendChild(csvBtn);
        footer.appendChild(tsvBtn);
        footer.appendChild(jsonBtn);
        footer.appendChild(refreshBtn);
        panel.appendChild(footer);

        // Resize handle — small grip in the bottom-right corner. Drag to
        // change panel width + height. Min 480x300, max 96vw x 90vh.
        // Final size persists in sumPanelState so it survives close/reopen.
        const resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = 'position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 40%,rgba(20,210,220,0.55) 40%,rgba(20,210,220,0.55) 50%,transparent 50%,transparent 65%,rgba(20,210,220,0.45) 65%,rgba(20,210,220,0.45) 75%,transparent 75%);border-bottom-right-radius:8px';
        let resizing = false, rStartX = 0, rStartY = 0, rStartW = 0, rStartH = 0;
        resizeHandle.addEventListener('mousedown', (e) => {
            resizing = true;
            const r = panel.getBoundingClientRect();
            rStartX = e.clientX; rStartY = e.clientY;
            rStartW = r.width; rStartH = r.height;
            e.preventDefault();
            e.stopPropagation();
        });
        const onResizeMove = (e) => {
            if (!resizing) return;
            const nw = Math.max(480, Math.min(window.innerWidth * 0.96, rStartW + (e.clientX - rStartX)));
            const nh = Math.max(300, Math.min(window.innerHeight * 0.90, rStartH + (e.clientY - rStartY)));
            panel.style.width = nw + 'px';
            panel.style.height = nh + 'px';
            panel.style.maxHeight = 'none'; // override the default cap once user resizes
            sumPanelState.w = nw;
            sumPanelState.h = nh;
        };
        const onResizeUp = () => { resizing = false; };
        document.addEventListener('mousemove', onResizeMove);
        document.addEventListener('mouseup', onResizeUp);
        panel.appendChild(resizeHandle);
        // Extend the cleanup remove() to drop the resize listeners too.
        const prevRemove = panel.remove;
        panel.remove = () => {
            document.removeEventListener('mousemove', onResizeMove);
            document.removeEventListener('mouseup', onResizeUp);
            prevRemove();
        };

        document.body.appendChild(panel);

        // --- Table draw helper (called on filter/sort changes) ---
        function redrawTable() {
            const rows = filterAndSortRows(allRows, sumPanelState);
            tableWrap.innerHTML = '';
            const table = document.createElement('table');
            table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;table-layout:auto';

            // Build the active column list — checkbox column always first,
            // then user-selected columns in canonical order. Each col has
            // dataKey (the property on the row for the value) and a render
            // function for the cell.
            const unitLbl = sumPanelState.unitsFt ? 'ft' : 'm';
            const fmtAlt = (m) => {
                if (m == null) return '—';
                return sumPanelState.unitsFt ? (m * 3.28084).toFixed(0) : m.toFixed(1);
            };
            const allColDefs = [
                { key: 'typeShort', label: 'Type',           w: 50,  num: false, dataKey: 'typeShort' },
                { key: 'name',      label: 'Name',           w: 230, num: false, dataKey: 'name' },
                { key: 'subtype',   label: 'Subtype',        w: 100, num: false, dataKey: 'subtype' },
                { key: 'elev',      label: `Elev (${unitLbl})`,   w: 80,  num: true,  dataKey: 'elevM',   fmt: fmtAlt },
                { key: 'altMin',    label: `Min Alt (${unitLbl})`, w: 80, num: true,  dataKey: 'altMinM', fmt: fmtAlt },
                { key: 'altMax',    label: `Max Alt (${unitLbl})`, w: 80, num: true,  dataKey: 'altMaxM', fmt: fmtAlt },
                { key: 'validated', label: 'Valid',          w: 50,  num: false, dataKey: 'validated' },
            ];
            const cols = allColDefs.filter(c => sumPanelState.visibleCols.has(c.key));

            // Header row — first cell is the select-all checkbox, then
            // user-selected columns sorted by their canonical position.
            const thead = document.createElement('thead');
            thead.style.cssText = 'position:sticky;top:0;background:#262a31;z-index:1';
            const headRow = document.createElement('tr');
            // Select-all checkbox
            const thSel = document.createElement('th');
            thSel.style.cssText = 'width:32px;padding:6px 6px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.12)';
            const selAll = document.createElement('input');
            selAll.type = 'checkbox';
            selAll.style.cssText = 'accent-color:rgb(20,210,220);cursor:pointer';
            // Indeterminate when partial selection
            const rowIds = rows.map(r => r.entity.id);
            const selCount = rowIds.filter(id => sumPanelState.selectedIds.has(id)).length;
            selAll.checked = selCount > 0 && selCount === rows.length;
            selAll.indeterminate = selCount > 0 && selCount < rows.length;
            selAll.onchange = () => {
                if (selAll.checked) rowIds.forEach(id => sumPanelState.selectedIds.add(id));
                else rowIds.forEach(id => sumPanelState.selectedIds.delete(id));
                redrawTable();
            };
            thSel.appendChild(selAll);
            headRow.appendChild(thSel);
            cols.forEach(col => {
                const th = document.createElement('th');
                const key = col.dataKey || col.key;
                const isSorted = sumPanelState.sortKey === key;
                // 3-state cycle on every column: asc → desc → default
                // (typePrio asc, name secondary). Resets when a column
                // hits its third click instead of locking into desc
                // forever; user was getting stuck unable to return to the
                // grouped-by-type default sort without a full refresh.
                th.textContent = col.label;
                th.style.cssText = `padding:6px 8px;text-align:${col.num ? 'right' : 'left'};color:${isSorted ? '#7adfe6' : '#bbb'};font-weight:600;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.12);cursor:pointer;user-select:none;min-width:${col.w}px;white-space:nowrap`;
                if (isSorted) th.textContent += sumPanelState.sortDir === 1 ? ' ▲' : ' ▼';
                th.title = isSorted
                    ? (sumPanelState.sortDir === 1 ? 'Click for descending; click again to reset to default sort' : 'Click to reset to default sort (grouped by type)')
                    : 'Click to sort ascending';
                th.onclick = () => {
                    if (sumPanelState.sortKey !== key) {
                        sumPanelState.sortKey = key;
                        sumPanelState.sortDir = 1;
                    } else if (sumPanelState.sortDir === 1) {
                        sumPanelState.sortDir = -1;
                    } else {
                        // Third click → back to default (type-grouped, name asc within)
                        sumPanelState.sortKey = 'typePrio';
                        sumPanelState.sortDir = 1;
                    }
                    redrawTable();
                };
                headRow.appendChild(th);
            });
            thead.appendChild(headRow);
            table.appendChild(thead);

            // Body rows
            const tbody = document.createElement('tbody');
            rows.forEach((r) => {
                const tr = document.createElement('tr');
                tr.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.05)';
                tr.onmouseenter = () => { tr.style.background = 'rgba(20,210,220,0.10)'; };
                tr.onmouseleave = () => { tr.style.background = 'transparent'; };

                // Checkbox cell — clicks here don't trigger row navigation.
                const tdSel = document.createElement('td');
                tdSel.style.cssText = 'width:32px;padding:5px 6px;text-align:center';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = sumPanelState.selectedIds.has(r.entity.id);
                cb.style.cssText = 'accent-color:rgb(20,210,220);cursor:pointer';
                cb.onclick = (ev) => ev.stopPropagation();
                cb.onchange = () => {
                    if (cb.checked) sumPanelState.selectedIds.add(r.entity.id);
                    else sumPanelState.selectedIds.delete(r.entity.id);
                    // Update header select-all state without full redraw
                    const newSel = rowIds.filter(id => sumPanelState.selectedIds.has(id)).length;
                    selAll.checked = newSel > 0 && newSel === rows.length;
                    selAll.indeterminate = newSel > 0 && newSel < rows.length;
                    countEl.textContent = makeCountText(rows.length, allRows.length, sumPanelState.selectedIds.size);
                };
                tdSel.appendChild(cb);
                tr.appendChild(tdSel);

                // Body cell click → row action (pan + open inspector). Each
                // td handles its own click so the checkbox td above can
                // stopPropagation to avoid triggering this.
                const onRowClick = () => {
                    panToEntity(r.entity);
                    const px = sumPanelState.x != null ? sumPanelState.x + (sumPanelState.w || 720) + 10 : 60;
                    const py = sumPanelState.y != null ? sumPanelState.y + 40 : 100;
                    showInspectorPopup(
                        Math.min(px, window.innerWidth - 360),
                        Math.min(py, window.innerHeight - 380),
                        r.entity
                    );
                };

                cols.forEach(col => {
                    const td = document.createElement('td');
                    td.style.cursor = 'pointer';
                    td.onclick = onRowClick;
                    if (col.key === 'typeShort') {
                        td.style.cssText = `padding:5px 8px;color:${typeBadgeColor(r.type)};font-weight:600;font-size:11px;cursor:pointer`;
                        td.textContent = r.typeShort;
                    } else if (col.key === 'name') {
                        td.style.cssText = 'padding:5px 8px;color:#e6e6e6;cursor:pointer';
                        td.textContent = r.name || '(unnamed)';
                    } else if (col.key === 'subtype') {
                        td.style.cssText = 'padding:5px 8px;color:#bbb;font-size:11px;cursor:pointer';
                        td.textContent = r.subtype || '—';
                    } else if (col.key === 'elev' || col.key === 'altMin' || col.key === 'altMax') {
                        td.style.cssText = 'padding:5px 8px;color:#bbb;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer';
                        td.textContent = col.fmt(r[col.dataKey]);
                    } else if (col.key === 'validated') {
                        // null → N/A (Assets/Markers — Percepto hides the toggle for these).
                        // true → green ✓, false → red ✗ for FFZ/FP/NFZ.
                        let txt = '—', color = '#666';
                        if (r.validated === true) { txt = '✓'; color = '#5fff5f'; }
                        else if (r.validated === false) { txt = '✗'; color = '#ff5555'; }
                        td.style.cssText = `padding:5px 8px;text-align:center;color:${color};cursor:pointer;font-weight:600`;
                        td.textContent = txt;
                    }
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            tableWrap.appendChild(table);

            countEl.textContent = makeCountText(rows.length, allRows.length, sumPanelState.selectedIds.size);

            // Helper — pick which rows to export. Selection wins when any
            // are checked; otherwise the current filter+sort snapshot.
            const exportRows = () => {
                if (sumPanelState.selectedIds.size > 0) {
                    return rows.filter(r => sumPanelState.selectedIds.has(r.entity.id));
                }
                return rows;
            };

            // Tabular row generator — used for both CSV and TSV. Returns
            // [header, ...dataRows] where each row is an array of stringy
            // cell values. Only includes visible columns (the user toggled
            // them off, so they don't want them in exports either).
            const tabular = () => {
                const header = cols.map(c => c.label);
                const data = exportRows().map(r => cols.map(col => {
                    if (col.key === 'typeShort') return r.typeShort;
                    if (col.key === 'name') return r.name || '';
                    if (col.key === 'subtype') return r.subtype || '';
                    if (col.key === 'elev' || col.key === 'altMin' || col.key === 'altMax') {
                        const v = r[col.dataKey];
                        if (v == null) return '';
                        return sumPanelState.unitsFt ? (v * 3.28084).toFixed(0) : v.toFixed(1);
                    }
                    if (col.key === 'validated') {
                        if (r.validated === true) return 'yes';
                        if (r.validated === false) return 'no';
                        return ''; // N/A
                    }
                    return '';
                }));
                return [header, ...data];
            };

            csvBtn.onclick = () => {
                const tab = tabular();
                const lines = tab.map(row => row.map(csvQuote).join(','));
                copyToClipboard(lines.join('\n'), `Copied CSV (${tab.length - 1} row${tab.length - 1 === 1 ? '' : 's'})`);
            };
            tsvBtn.onclick = () => {
                // TSV — tabs as separators. Spreadsheets paste this directly
                // into rows/columns instead of dumping it into a single cell.
                // Strip embedded tabs/newlines from cell contents to keep
                // the layout intact.
                const tab = tabular();
                const lines = tab.map(row => row.map(c =>
                    String(c == null ? '' : c).replace(/[\t\r\n]+/g, ' ')
                ).join('\t'));
                copyToClipboard(lines.join('\n'), `Copied for Sheets (${tab.length - 1} row${tab.length - 1 === 1 ? '' : 's'})`);
            };
            jsonBtn.onclick = () => {
                const fullEntities = exportRows().map(r => r.entity);
                copyToClipboard(JSON.stringify(fullEntities, null, 2), `Copied JSON (${fullEntities.length} entit${fullEntities.length === 1 ? 'y' : 'ies'})`);
            };
        }
        redrawTable();
    }

    function makeCountText(shown, total, selected) {
        let s = `Showing ${shown} of ${total}`;
        if (shown !== total) s += ' (filtered)';
        if (selected > 0) s += ` · ${selected} selected`;
        return s;
    }

    function csvQuote(s) {
        if (s == null) return '';
        const str = String(s);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    function panToEntity(entity) {
        const map = getLeafletMap();
        if (!map || !Array.isArray(entity.coords) || entity.coords.length === 0) return;
        let lat, lng;
        if (entity.coords.length >= 3) {
            let sLat = 0, sLng = 0;
            for (const c of entity.coords) { sLat += c.lat; sLng += c.lng; }
            lat = sLat / entity.coords.length;
            lng = sLng / entity.coords.length;
        } else {
            lat = entity.coords[0].lat;
            lng = entity.coords[0].lng;
        }
        try { map.setView([lat, lng], Math.max(18, map.getZoom())); }
        catch (e) { console.warn(`${TAG} setView threw:`, e); }
    }

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
