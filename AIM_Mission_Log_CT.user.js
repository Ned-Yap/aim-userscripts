// ==UserScript==
// @name         AIM Mission Log CT
// @namespace    http://tampermonkey.net/
// @version      1.1
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Log_CT.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Log_CT.user.js
// @description  Rewrites the Mission Log TIME column from the site's fixed GMT-5 stamps into real local Central Time. "Jun 11, 2026 13:28" -> "06/11/2026 - 1:28pm CT". Also relabels the header site clock to CT. No hotkeys.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// What it does: the Mission Log shows mission times in the site's fixed GMT-5
//   offset (per the header clock). That's confusing when investigating, because
//   real Central Time shifts (CDT=GMT-5 in summer, CST=GMT-6 in winter). This
//   script reads each GMT-5 stamp as an absolute instant and re-renders it in
//   America/Chicago, so summer missions read identically and winter missions
//   correctly drop an hour. Format: MM/DD/YYYY - h:mmam/pm CT.
// Hotkeys: none.
// Log tag: [AIM CT]

(function() {
    'use strict';

    // --- AIM Pilot mode guard: stay fully inert when a pilot/regulator has
    // turned on Pilot mode in the Control Panel (shared localStorage flag). No
    // observers/intervals/DOM injection start past this point. Toggling Pilot
    // mode reloads the page, so this re-evaluates cleanly each load. (This
    // script's document-wide MutationObserver is exactly the kind of flight-map
    // work pilots must not carry, so it goes inert.) ---
    try {
        if (localStorage.getItem('aim-pilot-mode') === '1') {
            console.log('[AIM CT] Pilot mode ON — builder inert, init skipped.');
            return;
        }
    } catch (e) {}

    const CONTEXT = window === window.top ? 'TOP' : 'IFRAME';
    const TAG = `[AIM CT ${CONTEXT}]`;

    // The site clock is fixed at this UTC offset (hours). The table stamps are
    // rendered in the same offset. We treat them as GMT-5 absolute instants.
    const SITE_OFFSET_HOURS = -5;

    const MONTHS = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };

    // "Jun 11, 2026 13:28"
    const STAMP_RE = /^\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*$/;

    const CT_FMT = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: 'numeric', minute: '2-digit', hour12: true
    });

    // Parse a GMT-5 stamp -> absolute Date (or null if it doesn't match).
    function parseSiteStamp(text) {
        const m = STAMP_RE.exec(text);
        if (!m) return null;
        const mon = MONTHS[m[1]];
        if (mon === undefined) return null;
        const day = parseInt(m[2], 10);
        const year = parseInt(m[3], 10);
        const hour = parseInt(m[4], 10);
        const min = parseInt(m[5], 10);
        // local(GMT-5) -> UTC: UTC = local - offset = local + 5h
        const utcMs = Date.UTC(year, mon, day, hour - SITE_OFFSET_HOURS, min);
        const d = new Date(utcMs);
        return isNaN(d.getTime()) ? null : d;
    }

    // Format an absolute Date as "06/11/2026 - 1:28pm CT" in Central Time.
    function formatCT(date) {
        const parts = {};
        for (const p of CT_FMT.formatToParts(date)) parts[p.type] = p.value;
        const ampm = (parts.dayPeriod || '').toLowerCase();
        return `${parts.month}/${parts.day}/${parts.year} - ${parts.hour}:${parts.minute}${ampm} CT`;
    }

    // --- Table TIME column (lives in the react-pages iframe) ---------------

    let tableConverted = 0;

    function convertTableCells() {
        const cells = document.querySelectorAll('td.ant-table-cell');
        for (const td of cells) {
            // Only leaf text cells; skip anything we've already rewritten.
            if (td.children.length) continue;
            if (td.dataset.aimCt === '1') continue;
            const raw = td.textContent;
            const date = parseSiteStamp(raw);
            if (!date) continue;
            try {
                td.title = raw.trim() + ' (site GMT-5)';
                td.textContent = formatCT(date);
                td.dataset.aimCt = '1';
                tableConverted++;
            } catch (e) {
                console.error(`${TAG} table cell convert failed:`, e);
            }
        }
    }

    // --- Header site clock (lives in the TOP frame) ------------------------

    let clockReported = false;

    function convertClock() {
        const clock = document.querySelector('.app-site-clock');
        if (!clock) return;
        // Structure: <div ...><div>16:17</div><div>GMT -5</div></div>
        const inner = clock.querySelector('div');
        if (!inner) return;
        const lines = inner.querySelectorAll('div');
        if (lines.length < 2) return;
        const timeEl = lines[0];
        const labelEl = lines[1];

        // The clock shows the current site (GMT-5) time. Real "now" in Central
        // is just the current instant formatted in America/Chicago.
        const parts = {};
        for (const p of CT_FMT.formatToParts(new Date())) parts[p.type] = p.value;
        const ampm = (parts.dayPeriod || '').toLowerCase();
        const desiredTime = `${parts.hour}:${parts.minute}${ampm}`;
        const desiredLabel = 'CT';

        // Idempotent: skip if already showing what we want (avoids observer loop).
        if (timeEl.textContent === desiredTime && labelEl.textContent === desiredLabel) return;
        timeEl.textContent = desiredTime;
        labelEl.textContent = desiredLabel;
        if (!clockReported) {
            console.log(`${TAG} header clock relabeled to CT`);
            clockReported = true;
        }
    }

    // --- Wiring ------------------------------------------------------------

    function pass() {
        try {
            if (CONTEXT === 'TOP') convertClock();
            convertTableCells();
        } catch (e) {
            console.error(`${TAG} pass failed:`, e);
        }
    }

    let scheduled = false;
    function schedulePass() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            pass();
        });
    }

    function init() {
        console.log(`${TAG} init`);
        pass();

        // React rewrites the table on scroll/sort/page-change and ticks the
        // clock every minute. Observe and re-apply (debounced via rAF).
        const obs = new MutationObserver(schedulePass);
        obs.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });

        // Cheap backup in case an observed mutation is missed.
        setInterval(pass, 3000);

        console.log(`${TAG} ready`);
    }

    init();
})();
