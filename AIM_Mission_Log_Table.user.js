// ==UserScript==
// @name         AIM Mission Log Table
// @namespace    http://tampermonkey.net/
// @version      1.4
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Log_Table.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Log_Table.user.js
// @description  Makes the Mission Log table's columns drag-to-reorder and drag-edge-to-resize. Layout persists in localStorage and is continuously re-applied over Percepto's React re-renders. Shift+double-click any header resets. Also adds a per-row 📥 button that downloads that mission's drone flight path (LAT/LNG/ALT) as a 3D KML — path + time-animated track + a labeled waypoint every 10% (alt m/ft, AGL, speed, heading, battery, local time) + a flight summary. No hotkeys.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// What it does: Percepto's Mission Log uses a native Ant Design table that we
//   don't control. This script layers column drag-reorder + edge-resize on top
//   of it. Because React owns the table and rewrites it on every sort/filter/
//   scroll, we don't mutate-once — we keep a desired layout (order + widths) in
//   localStorage and ENFORCE it on a MutationObserver pass, re-applying after
//   each React render. All columns are made uniform (the native frozen/pinned
//   columns are un-stuck) so any column can move anywhere.
// Reset: Shift + double-click any column header clears the saved layout.
// Flight-path KML: each mission row gets a 📥 button (in the sticky-right
//   action cell). Click it to fetch GET /mission_positions/<id>/ (cookie auth,
//   same-origin) and download the drone's path as a KML containing:
//     • an absolute-altitude LineString (static 3D path)
//     • a time-stamped gx:Track (Google Earth time-animated playback)
//     • a labeled waypoint at every 10% of distance flown (+ Takeoff/Landing),
//       each carrying alt (m + ft), AGL (m + ft, derived from the DEM endpoint
//       /location_altitude/ since altitude_agl is usually null), speed (m/s +
//       mph from velocity mm/s), heading (° + compass), battery %, and the
//       site-local time (tz offset parsed from the row's time-cell title)
//     • a flight-summary table on the Document (duration, distance, alt range,
//       max AGL, max speed, battery used).
//   Points use altitude_asl (meters ASL, falling back to alt), are sorted
//   chronologically, and consecutive duplicate fixes (idle hover) are dropped.
// Hotkeys: none.
// Log tag: [AIM MLOG]

(function() {
    'use strict';

    // --- AIM Pilot mode guard: stay fully inert when a pilot/regulator has
    // turned on Pilot mode in the Control Panel (shared localStorage flag). No
    // observers/intervals/DOM injection start past this point. Toggling Pilot
    // mode reloads the page, so this re-evaluates cleanly each load. (This
    // script runs a document-wide MutationObserver + 1.5s interval — exactly
    // the flight-map work a pilot must not carry.) ---
    try {
        if (localStorage.getItem('aim-mode') !== 'full') {
            console.log('[AIM MLOG] Lite mode — CSM tool inert, init skipped.');
            return;
        }
    } catch (e) {}

    const CONTEXT = window === window.top ? 'TOP' : 'IFRAME';
    const TAG = `[AIM MLOG ${CONTEXT}]`;

    const ORDER_KEY = 'aim-mlog-col-order';
    const WIDTH_KEY = 'aim-mlog-col-widths';
    const MIN_W = 50;

    // The native missions table only exists inside the react-pages iframe.
    const CONTAINER_SEL = '.missions-page__table-container .ant-table';

    // --- persisted layout state -------------------------------------------

    let order = loadJSON(ORDER_KEY, null);     // array of column keys, or null
    let widths = loadJSON(WIDTH_KEY, {});      // { key: px }
    let ORIGINAL_KEYS = null;                  // captured from first render

    // --- live drag state ---------------------------------------------------

    let dragKey = null;
    let lastDropTh = null;

    function loadJSON(k, dflt) {
        try {
            const v = localStorage.getItem(k);
            return v ? JSON.parse(v) : dflt;
        } catch (e) {
            console.error(`${TAG} load ${k} failed:`, e);
            return dflt;
        }
    }
    function saveJSON(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); }
        catch (e) { console.error(`${TAG} save ${k} failed:`, e); }
    }

    // --- column identity ---------------------------------------------------

    function colKey(th) {
        const t = th.querySelector('.ant-table-column-title');
        return ((t ? t.textContent : th.textContent) || '').trim();
    }

    // Data header cells = thead th's minus the trailing scrollbar placeholder.
    function getDataThs(container) {
        const row = container.querySelector('.ant-table-header thead > tr');
        if (!row) return [];
        return Array.from(row.children).filter(
            th => th.tagName === 'TH' && !th.classList.contains('ant-table-cell-scrollbar')
        );
    }

    // --- the enforce pass --------------------------------------------------

    function enforce() {
        const container = document.querySelector(CONTAINER_SEL);
        if (!container) return;

        const headerRow = container.querySelector('.ant-table-header thead > tr');
        const headerColgroup = container.querySelector('.ant-table-header colgroup');
        const bodyColgroup = container.querySelector('.ant-table-body colgroup');
        const bodyRows = container.querySelectorAll('.ant-table-body tbody > tr.ant-table-row');
        if (!headerRow || !headerColgroup || !bodyColgroup) return;

        const N = bodyColgroup.children.length;
        if (N < 2) return;

        const dataThs = getDataThs(container);
        if (dataThs.length !== N) return; // mid-render mismatch — bail this pass

        const currentKeys = dataThs.map(colKey);
        if (currentKeys.some(k => !k)) return; // headers not text-ready yet

        if (!ORIGINAL_KEYS) ORIGINAL_KEYS = currentKeys.slice();
        if (!order) order = currentKeys.slice();

        // Sanitize: order must be a permutation of the live column set. If the
        // column set ever changes, fall back to current DOM order.
        const curSet = new Set(currentKeys);
        if (order.length !== currentKeys.length || !order.every(k => curSet.has(k))) {
            order = currentKeys.slice();
        }

        // Build the permutation that takes current DOM order -> desired order.
        const perm = order.map(k => currentKeys.indexOf(k));
        const isIdentity = perm.every((v, i) => v === i);

        if (!isIdentity) {
            applyPerm(headerRow, perm, N);
            applyPerm(headerColgroup, perm, N);
            applyPerm(bodyColgroup, perm, N);
            for (const r of bodyRows) {
                if (r.children.length === N) applyPerm(r, perm, N);
            }
        }

        // Un-freeze every cell so all columns behave uniformly, then size +
        // decorate. Re-query header th's (nodes moved during reorder).
        const ths = getDataThs(container);
        ths.forEach(th => {
            th.style.position = 'relative';   // kills horizontal sticky + anchors resize handle
            th.style.left = 'auto';
            th.style.right = 'auto';
            decorate(th, container);
        });
        for (const r of bodyRows) {
            for (const td of r.children) unfixCell(td);
        }

        applyWidths(headerColgroup, bodyColgroup, order, N);
    }

    function unfixCell(td) {
        if (td.className && td.className.indexOf('ant-table-cell-fix') >= 0) {
            td.style.position = 'static';
            td.style.left = 'auto';
            td.style.right = 'auto';
        }
    }

    // Reorder the FIRST `count` children of parent by `perm`; keep any trailing
    // children (e.g. the scrollbar col/th) pinned at the end.
    function applyPerm(parent, perm, count) {
        const kids = Array.from(parent.children);
        const data = kids.slice(0, count);
        const rest = kids.slice(count);
        const frag = document.createDocumentFragment();
        for (const idx of perm) frag.appendChild(data[idx]);
        for (const r of rest) frag.appendChild(r);
        parent.appendChild(frag);
    }

    function applyWidths(headerColgroup, bodyColgroup, displayKeys, N) {
        for (let i = 0; i < N; i++) {
            const w = widths[displayKeys[i]];
            if (!w) continue;
            if (headerColgroup.children[i]) headerColgroup.children[i].style.width = w + 'px';
            if (bodyColgroup.children[i]) bodyColgroup.children[i].style.width = w + 'px';
        }
    }

    // --- per-header decoration (drag + resize), idempotent -----------------

    function decorate(th, container) {
        if (th.dataset.aimMlog === '1') return;
        th.dataset.aimMlog = '1';
        th.classList.add('aim-mlog-th');
        th.draggable = true;

        th.addEventListener('dragstart', (e) => {
            dragKey = colKey(th);
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', dragKey); } catch (err) {}
            th.classList.add('aim-mlog-dragging');
        });
        th.addEventListener('dragend', () => {
            th.classList.remove('aim-mlog-dragging');
            clearDrop();
            dragKey = null;
        });
        th.addEventListener('dragover', (e) => {
            if (!dragKey) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const r = th.getBoundingClientRect();
            const after = e.clientX > r.left + r.width / 2;
            clearDrop();
            lastDropTh = th;
            th.classList.add(after ? 'aim-mlog-drop-after' : 'aim-mlog-drop-before');
        });
        th.addEventListener('drop', (e) => {
            if (!dragKey) return;
            e.preventDefault();
            const r = th.getBoundingClientRect();
            const after = e.clientX > r.left + r.width / 2;
            moveColumn(dragKey, colKey(th), after);
            clearDrop();
            dragKey = null;
        });

        // Shift + double-click a header => reset layout.
        th.addEventListener('dblclick', (e) => {
            if (!e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            resetLayout();
        });

        // Resize handle on the right edge.
        const handle = document.createElement('div');
        handle.className = 'aim-mlog-resize';
        handle.addEventListener('pointerdown', (e) => startResize(e, th, container));
        handle.addEventListener('dragstart', (e) => e.preventDefault());
        handle.addEventListener('dblclick', (e) => e.stopPropagation());
        th.appendChild(handle);
    }

    function clearDrop() {
        if (lastDropTh) {
            lastDropTh.classList.remove('aim-mlog-drop-before', 'aim-mlog-drop-after');
            lastDropTh = null;
        }
    }

    function moveColumn(fromKey, toKey, after) {
        try {
            if (!fromKey || fromKey === toKey) return;
            const arr = order.slice();
            const fromIdx = arr.indexOf(fromKey);
            if (fromIdx < 0) return;
            arr.splice(fromIdx, 1);
            let toIdx = arr.indexOf(toKey);
            if (toIdx < 0) return;
            if (after) toIdx += 1;
            arr.splice(toIdx, 0, fromKey);
            order = arr;
            saveJSON(ORDER_KEY, order);
            enforce();
        } catch (e) {
            console.error(`${TAG} moveColumn failed:`, e);
        }
    }

    function startResize(e, th, container) {
        try {
            e.preventDefault();
            e.stopPropagation();
            th.draggable = false; // don't start a column drag while resizing

            const ths = getDataThs(container);
            const colIdx = ths.indexOf(th);
            if (colIdx < 0) return;

            const headerColgroup = container.querySelector('.ant-table-header colgroup');
            const bodyColgroup = container.querySelector('.ant-table-body colgroup');
            const key = colKey(th);
            const startX = e.clientX;
            const startW = bodyColgroup.children[colIdx]
                ? bodyColgroup.children[colIdx].getBoundingClientRect().width
                : th.getBoundingClientRect().width;

            document.body.classList.add('aim-mlog-resizing');

            const move = (ev) => {
                const w = Math.max(MIN_W, Math.round(startW + (ev.clientX - startX)));
                widths[key] = w;
                if (headerColgroup.children[colIdx]) headerColgroup.children[colIdx].style.width = w + 'px';
                if (bodyColgroup.children[colIdx]) bodyColgroup.children[colIdx].style.width = w + 'px';
            };
            const up = () => {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', up);
                document.body.classList.remove('aim-mlog-resizing');
                th.draggable = true;
                saveJSON(WIDTH_KEY, widths);
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', up);
        } catch (err) {
            console.error(`${TAG} startResize failed:`, err);
        }
    }

    function resetLayout() {
        order = ORIGINAL_KEYS ? ORIGINAL_KEYS.slice() : null;
        widths = {};
        try {
            localStorage.removeItem(ORDER_KEY);
            localStorage.removeItem(WIDTH_KEY);
        } catch (e) { console.error(`${TAG} reset clear failed:`, e); }
        // Clear any inline col widths so Ant's defaults take back over.
        const container = document.querySelector(CONTAINER_SEL);
        if (container) {
            container.querySelectorAll('colgroup > col').forEach(c => { c.style.width = ''; });
        }
        console.log(`${TAG} layout reset`);
        enforce();
    }

    // --- flight-path KML download -----------------------------------------
    // Each mission row carries `data-row-key="mission-<id>"`; we read the id
    // from there (robust to column reorder/visibility) and inject a 📥 button
    // into the sticky-right action cell.

    const ROW_SEL = '.ant-table-body tbody > tr.ant-table-row';

    function decorateRows() {
        const container = document.querySelector(CONTAINER_SEL);
        if (!container) return;
        for (const tr of container.querySelectorAll(ROW_SEL)) {
            if (tr.dataset.aimKml === '1') continue;
            const m = (tr.getAttribute('data-row-key') || '').match(/mission-(\d+)/);
            if (!m) continue;
            const cell = tr.querySelector('.action-column-cell') || tr.lastElementChild;
            if (!cell) continue;
            tr.dataset.aimKml = '1';
            cell.insertBefore(makeKmlButton(m[1], tr), cell.firstChild);
        }
    }

    function makeKmlButton(missionId, tr) {
        const btn = document.createElement('button');
        btn.className = 'aim-kml-btn';
        btn.type = 'button';
        btn.textContent = '📥';
        btn.title = `Download flight path KML (drone positions) — mission ${missionId}`;
        // Row is clickable (navigates to the mission); stop our clicks from
        // bubbling to React's delegated row handler.
        const stop = (e) => e.stopPropagation();
        btn.addEventListener('mousedown', stop);
        btn.addEventListener('pointerdown', stop);
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            downloadMissionKml(missionId, tr, btn);
        });
        return btn;
    }

    function flash(btn, txt, ms) {
        btn.textContent = txt;
        setTimeout(() => { btn.textContent = '📥'; }, ms);
    }

    function downloadMissionKml(missionId, tr, btn) {
        if (btn.dataset.busy === '1') return;
        btn.dataset.busy = '1';
        btn.textContent = '⏳';
        const nameEl = tr.querySelector('.missions-page__mission-name');
        const missionName = nameEl ? (nameEl.textContent || '').trim() : '';
        const offMin = siteOffsetMinFromRow(tr); // site-local tz, parsed off the row
        console.log(`${TAG} fetching positions for mission ${missionId} (tz offset ${offMin} min)`);
        fetch(`/mission_positions/${encodeURIComponent(missionId)}/`, { credentials: 'include' })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(data => buildKml((data && data.positions) || [], missionId, missionName, offMin))
            .then(kml => {
                if (!kml) {
                    console.warn(`${TAG} mission ${missionId}: no usable positions`);
                    flash(btn, '∅', 2500);
                    return;
                }
                const safe = (missionName || 'mission').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
                downloadFile(kml, `mission_${missionId}_${safe}_flightpath.kml`);
                console.log(`${TAG} mission ${missionId}: KML downloaded`);
                flash(btn, '✅', 1500);
            })
            .catch(e => {
                console.error(`${TAG} KML download failed for mission ${missionId}:`, e);
                flash(btn, '❌', 2500);
            })
            .finally(() => { btn.dataset.busy = '0'; });
    }

    // --- unit + time + geo helpers ----------------------------------------

    const M_TO_FT = 3.28084;
    const MPS_TO_MPH = 2.2369363;

    // Site-local tz offset (minutes) parsed from the row's time-cell title,
    // e.g. "Jun 23, 2026 23:08 (site GMT-5)". null => fall back to viewer local.
    function siteOffsetMinFromRow(tr) {
        try {
            const el = tr.querySelector('[title*="GMT"]');
            const title = el ? (el.getAttribute('title') || '') : '';
            const m = title.match(/GMT\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i);
            if (!m) return null;
            const sign = m[1] === '-' ? -1 : 1;
            return sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
        } catch (e) { return null; }
    }

    function tzLabel(offMin) {
        if (offMin == null) return 'local';
        const s = offMin < 0 ? '-' : '+';
        const a = Math.abs(offMin);
        return `GMT${s}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`;
    }

    // Format a UTC ISO timestamp in the site-local wall clock.
    function fmtLocal(iso, offMin, withDate) {
        const ms = Date.parse(iso);
        if (isNaN(ms)) return '';
        if (offMin == null) {
            const d = new Date(ms);
            return withDate ? d.toLocaleString() : d.toLocaleTimeString();
        }
        const d = new Date(ms + offMin * 60000);
        const p2 = n => String(n).padStart(2, '0');
        let h = d.getUTCHours();
        const ap = h >= 12 ? 'pm' : 'am';
        const h12 = ((h + 11) % 12) + 1;
        const time = `${h12}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}${ap}`;
        if (!withDate) return time;
        const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
        return `${mo} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${time}`;
    }

    function cardinal(deg) {
        if (deg == null) return '';
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
    }

    // Horizontal great-circle distance (meters) between two {lat,lng}.
    function havM(a, b) {
        const R = 6371000, toR = Math.PI / 180;
        const la1 = a.lat * toR, la2 = b.lat * toR;
        const dla = (b.lat - a.lat) * toR, dlo = (b.lng - a.lng) * toR;
        const x = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(x));
    }

    // DEM ground elevation (m) at a point via Percepto's own endpoint. Used to
    // derive AGL since mission_positions altitude_agl is typically null.
    function fetchGroundM(lat, lng) {
        const url = `/location_altitude/?location=${encodeURIComponent(JSON.stringify({ lat, lng }))}`;
        return fetch(url, { credentials: 'include' })
            .then(r => (r.ok ? r.json() : null))
            .then(d => (d && typeof d.altitude === 'number') ? d.altitude : null)
            .catch(() => null);
    }
    // Sequential (avoids the /location_altitude/ 429 storm) — only ~11 pins.
    async function fetchGroundsSeq(coords) {
        const out = [];
        for (const c of coords) out.push(await fetchGroundM(c.lat, c.lng));
        return out;
    }

    function xmlEsc(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    }

    // Build a KML (async — fetches DEM for the pins):
    //   • absolute-altitude LineString (static 3D path)
    //   • timestamped gx:Track (Google Earth time playback)
    //   • a pin at every 10% of distance flown + Takeoff/Landing, each with
    //     alt (m/ft), AGL (m/ft via DEM), speed, heading, battery, local time
    //   • a flight-summary description on the Document
    // Prefers altitude_asl (m ASL); falls back to alt.
    async function buildKml(positions, missionId, missionName, offMin) {
        const pts = [];
        for (const p of positions) {
            const pos = p && p.position;
            if (!pos || typeof pos.lat !== 'number' || typeof pos.lng !== 'number') continue;
            const alt = (p.altitude_asl != null) ? p.altitude_asl
                : (p.alt != null ? p.alt : null);
            if (alt == null) continue;
            pts.push({
                lat: pos.lat, lng: pos.lng, alt, t: p.timestamp || null,
                vmm: (typeof p.velocity === 'number') ? p.velocity : null, // mm/s
                hdg: (typeof p.heading === 'number') ? p.heading : null,    // deg
                batt: (typeof p.battery === 'number') ? p.battery : null    // %
            });
        }
        if (!pts.length) return null;
        // Chronological order so the track plays back correctly.
        pts.sort((a, b) => (a.t ? Date.parse(a.t) : 0) - (b.t ? Date.parse(b.t) : 0));
        // Drop consecutive identical fixes (idle hover at base, etc.).
        const clean = [];
        for (const p of pts) {
            const last = clean[clean.length - 1];
            if (last && last.lat === p.lat && last.lng === p.lng && last.alt === p.alt) continue;
            clean.push(p);
        }

        // Cumulative 3D distance (m) along the cleaned path.
        const cum = new Array(clean.length).fill(0);
        for (let i = 1; i < clean.length; i++) {
            const h = havM(clean[i - 1], clean[i]);
            const dz = clean[i].alt - clean[i - 1].alt;
            cum[i] = cum[i - 1] + Math.sqrt(h * h + dz * dz);
        }
        const total = cum[cum.length - 1];

        // Pick pin indices at 0,10,…,100% of distance flown (dedup, ordered).
        const pinIdx = [];
        for (let pct = 0; pct <= 100; pct += 10) {
            const target = total * (pct / 100);
            let idx = 0;
            while (idx < cum.length - 1 && cum[idx] < target) idx++;
            if (!pinIdx.length || pinIdx[pinIdx.length - 1].idx !== idx) pinIdx.push({ pct, idx });
            else pinIdx[pinIdx.length - 1].pct = pct; // collapse dupes onto highest pct
        }

        // DEM ground for each pin → AGL.
        const grounds = await fetchGroundsSeq(pinIdx.map(pi => clean[pi.idx]));

        // ---- geometry strings ----
        const line = clean.map(p => `${p.lng},${p.lat},${p.alt}`).join(' ');
        const track = [];
        for (const p of clean) {
            if (!p.t) continue; // a when/coord pair must stay balanced
            track.push(`        <when>${p.t}</when>`);
            track.push(`        <gx:coord>${p.lng} ${p.lat} ${p.alt}</gx:coord>`);
        }

        // ---- pins ----
        const fmtM = (m) => `${Math.round(m)} m / ${Math.round(m * M_TO_FT)} ft`;
        const fmtSpeed = (vmm) => {
            if (vmm == null) return '—';
            const mps = vmm / 1000;
            return `${mps.toFixed(1)} m/s / ${(mps * MPS_TO_MPH).toFixed(1)} mph`;
        };
        const fmtDist = (m) => `${Math.round(m).toLocaleString()} m / ${(m / 1609.344).toFixed(2)} mi`;

        const pinPlacemarks = pinIdx.map((pi, i) => {
            const p = clean[pi.idx];
            const g = grounds[i];
            const agl = (g != null) ? (p.alt - g) : null;
            const isStart = pi.pct === 0, isEnd = pi.pct === 100;
            const style = isStart ? '#pin-start' : (isEnd ? '#pin-end' : '#pin-mid');
            const label = isStart ? 'Takeoff' : (isEnd ? 'Landing' : `${pi.pct}%`);
            const rows = [
                ['Progress', `${pi.pct}% · point ${pi.idx + 1}/${clean.length}`],
                ['Time', p.t ? `${fmtLocal(p.t, offMin)} (${tzLabel(offMin)})` : '—'],
                ['Altitude ASL', fmtM(p.alt)],
                ['Altitude AGL', agl != null ? fmtM(agl) : 'n/a (DEM unavailable)'],
                ['Speed', fmtSpeed(p.vmm)],
                ['Heading', p.hdg != null ? `${Math.round(p.hdg)}° ${cardinal(p.hdg)}` : '—'],
                ['Battery', p.batt != null ? `${p.batt}%` : '—'],
                ['Distance flown', fmtDist(cum[pi.idx])]
            ];
            const tbl = '<table>' + rows.map(r =>
                `<tr><td style="padding:1px 8px 1px 0;color:#888">${r[0]}</td><td><b>${r[1]}</b></td></tr>`).join('') + '</table>';
            return `    <Placemark>
      <name>${xmlEsc(label)}</name>
      <styleUrl>${style}</styleUrl>
      <description><![CDATA[${tbl}]]></description>
      <Point>
        <extrude>1</extrude>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${p.lng},${p.lat},${p.alt}</coordinates>
      </Point>
    </Placemark>`;
        }).join('\n');

        // ---- flight summary ----
        const t0 = clean.find(p => p.t), tN = [...clean].reverse().find(p => p.t);
        const durMs = (t0 && tN) ? (Date.parse(tN.t) - Date.parse(t0.t)) : 0;
        const durS = Math.max(0, Math.round(durMs / 1000));
        const durStr = `${Math.floor(durS / 60)}:${String(durS % 60).padStart(2, '0')}`;
        const alts = clean.map(p => p.alt);
        const maxAsl = Math.max(...alts), minAsl = Math.min(...alts);
        const aglVals = grounds.map((g, i) => g != null ? clean[pinIdx[i].idx].alt - g : null).filter(v => v != null);
        const speeds = clean.map(p => p.vmm).filter(v => v != null);
        const maxMph = speeds.length ? (Math.max(...speeds) / 1000 * MPS_TO_MPH) : null;
        const batts = clean.map(p => p.batt).filter(v => v != null);
        const sRows = [
            ['Mission', `${missionId}${missionName ? ' — ' + xmlEsc(missionName) : ''}`],
            ['Start', t0 ? `${fmtLocal(t0.t, offMin, true)} (${tzLabel(offMin)})` : '—'],
            ['End', tN ? `${fmtLocal(tN.t, offMin, true)} (${tzLabel(offMin)})` : '—'],
            ['Duration', `${durStr} (mm:ss)`],
            ['Distance flown', fmtDist(total)],
            ['Altitude ASL range', `${fmtM(minAsl)} → ${fmtM(maxAsl)}`],
            ['Max AGL', aglVals.length ? fmtM(Math.max(...aglVals)) : 'n/a'],
            ['Max speed', maxMph != null ? `${maxMph.toFixed(1)} mph` : '—'],
            ['Battery', batts.length ? `${batts[0]}% → ${batts[batts.length - 1]}% (used ${batts[0] - batts[batts.length - 1]}%)` : '—'],
            ['Points', `${clean.length} (from ${positions.length} samples)`]
        ];
        const summary = '<table>' + sRows.map(r =>
            `<tr><td style="padding:1px 10px 1px 0;color:#888">${r[0]}</td><td><b>${r[1]}</b></td></tr>`).join('') + '</table>';

        const title = `Mission ${missionId}${missionName ? ' — ' + missionName : ''}`;
        return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${xmlEsc(title)}</name>
    <description><![CDATA[${summary}]]></description>
    <Style id="fp"><LineStyle><color>ff00aaff</color><width>3</width></LineStyle></Style>
    <Style id="pin-start"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/pushpin/grn-pushpin.png</href></Icon></IconStyle></Style>
    <Style id="pin-mid"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href></Icon></IconStyle></Style>
    <Style id="pin-end"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/pushpin/red-pushpin.png</href></Icon></IconStyle></Style>
    <Placemark>
      <name>Flight path (3D)</name>
      <styleUrl>#fp</styleUrl>
      <LineString>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${line}</coordinates>
      </LineString>
    </Placemark>
    <Placemark>
      <name>Flight track (time-animated)</name>
      <styleUrl>#fp</styleUrl>
      <gx:Track>
        <altitudeMode>absolute</altitudeMode>
${track.join('\n')}
      </gx:Track>
    </Placemark>
    <Folder>
      <name>Waypoints (every 10%)</name>
${pinPlacemarks}
    </Folder>
  </Document>
</kml>`;
    }

    function downloadFile(text, filename) {
        try {
            const blob = new Blob([text], { type: 'application/vnd.google-earth.kml+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
        } catch (e) {
            console.error(`${TAG} download failed:`, e);
        }
    }

    // --- styles ------------------------------------------------------------

    function injectStyle() {
        if (document.getElementById('aim-mlog-style')) return;
        const s = document.createElement('style');
        s.id = 'aim-mlog-style';
        s.textContent = `
            th.aim-mlog-th { cursor: grab; }
            th.aim-mlog-th:active { cursor: grabbing; }
            th.aim-mlog-dragging { opacity: 0.45; }
            th.aim-mlog-drop-before { box-shadow: inset 3px 0 0 0 #5fff5f !important; }
            th.aim-mlog-drop-after  { box-shadow: inset -3px 0 0 0 #5fff5f !important; }
            .aim-mlog-resize {
                position: absolute; top: 0; right: 0;
                width: 7px; height: 100%;
                cursor: col-resize; z-index: 20; user-select: none;
            }
            .aim-mlog-resize:hover { background: rgba(95,255,255,0.45); }
            body.aim-mlog-resizing, body.aim-mlog-resizing * {
                cursor: col-resize !important; user-select: none !important;
            }
            .aim-kml-btn {
                background: transparent; border: none; cursor: pointer;
                font-size: 15px; line-height: 1; padding: 2px 4px; margin-right: 4px;
                border-radius: 4px; vertical-align: middle;
            }
            .aim-kml-btn:hover { background: rgba(95,255,255,0.25); }
            .aim-kml-btn[data-busy="1"] { cursor: default; }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    // --- wiring ------------------------------------------------------------

    let scheduled = false;
    function schedulePass() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            try { enforce(); }
            catch (e) { console.error(`${TAG} enforce failed:`, e); }
            try { decorateRows(); }
            catch (e) { console.error(`${TAG} decorateRows failed:`, e); }
        });
    }

    function init() {
        console.log(`${TAG} init`);
        injectStyle();
        schedulePass();

        const obs = new MutationObserver(schedulePass);
        obs.observe(document.documentElement, { childList: true, subtree: true });

        // Backup for renders that reset col widths without a childList change.
        setInterval(schedulePass, 1500);

        console.log(`${TAG} ready`);
    }

    init();
})();
