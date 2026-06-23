// ==UserScript==
// @name         AIM Mission Log Table
// @namespace    http://tampermonkey.net/
// @version      1.2
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Log_Table.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Log_Table.user.js
// @description  Makes the Mission Log table's columns drag-to-reorder and drag-edge-to-resize. Layout persists in localStorage and is continuously re-applied over Percepto's React re-renders. Shift+double-click any header resets. No hotkeys.
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
