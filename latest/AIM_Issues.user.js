// ==UserScript==
// @name         Latest - AIM Issues
// @namespace    http://tampermonkey.net/
// @version      1.12
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Issues.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Issues.user.js
// @description  CSM-collaborative issue flagging w/ approver oversight. 🚩 button in .map-tools. CSMs PROPOSE ignore/fix (purple/yellow); approvers APPROVE (→ resolved/ignored grey) or REJECT (→ open red). Approvers can direct-resolve without going through pending. Per-user activity indicator (green ?) flags unseen comments/transitions. Approvers list lives in aim-userscripts-data/approvers.json.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.github.com
// @connect      slack.com
// @run-at       document-end
// ==/UserScript==

// Design ref: see memory/project_aim_issues_design.md for the original
// spec; v1.00 oversight redesign described in project_aim_issues_arch.md.
//
// v1.00 scope:
// - Two-tier state machine with approver oversight:
//     CSMs PROPOSE → pending_fix (yellow) / pending_ignore (purple)
//     Approvers APPROVE → resolved / ignored, or REJECT → back to open.
//     Approvers can also direct-resolve/ignore from open (bypass pending).
// - Approver allowlist in aim-userscripts-data/approvers.json
//     Loaded with PAT, cached in GM storage. Edit the file to add/remove.
// - Self-approval block scaffolded but DISABLED by default
//     (SELF_APPROVAL_BLOCK_ENABLED=false) — flip when team grows past
//     single-active-reviewer.
// - Per-user activity indicator (pulsing green ?)
//     Map-marker badge + panel-row chip when OTHERS post events you
//     haven't seen. Clears on modal open. lastSeen state in localStorage.
// - Panel: pending status chips added, "Pending my review" shortcut
//     (approvers only), toolbar badge morphs to orange + pending count
//     when approver has work waiting.
// - Legacy `ready-for-review` status grandfathered (still renders + can
//     transition; chip hidden when count=0).
//
// Carried from prior versions: tombstone deletes, history-union + push-back
// merge, dedicated panel, affected-entities via /map_objects, entity-pill
// M1 copy / M2 sidebar paste, Sheets HTML clipboard, priority field,
// floating draggable status modal.
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
    const SCRIPT_VERSION = '1.12';
    const IS_TOP = window === window.top;
    const FRAME = IS_TOP ? 'TOP' : 'IFRAME';

    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-issues';
    const STORAGE_PREFIX = 'aim-issues-site-';

    // ------- GitHub sync constants (v0.5 Phase 2) -------
    const GITHUB_API_BASE = 'https://api.github.com';
    const ISSUES_REPO = 'Ned-Yap/aim-userscripts-data';
    const ISSUES_BRANCH = 'main';
    const ISSUES_PATH = (sid) => `issues/${sid}-issues.json`;
    const APPROVERS_PATH = 'approvers.json';
    // v1.03: Slack notifications. Bot token + channel ID + name→SlackID map
    // live in aim-userscripts-data/slack-config.json (same private repo +
    // PAT we already use). Posting goes through the Slack Web API
    // (chat.postMessage) so we get the message ts back for threading —
    // an incoming webhook can't thread.
    const SLACK_CONFIG_PATH = 'slack-config.json';
    const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';
    const SLACK_UPDATE_URL = 'https://slack.com/api/chat.update';
    const TOKEN_KEY = 'aim-github-token';          // shared with Map Styler
    const USERNAME_KEY = 'aim-issues-github-login'; // ours
    const APPROVERS_KEY = 'aim-issues-approvers';   // cached approver list
    const SLACK_CONFIG_KEY = 'aim-issues-slack-config'; // cached slack-config.json

    // ------- v1.00 approver oversight + activity-indicator constants -------
    //
    // SELF_APPROVAL_BLOCK_ENABLED: false today (per user decision — only one
    // active reviewer + admin bypass means self-approval would block the
    // common case). Flip to true when the team grows + you want to enforce
    // a second-pair-of-eyes rule on every pending issue.
    const SELF_APPROVAL_BLOCK_ENABLED = false;

    // Last-seen activity tracking — per-user, per-issue timestamp in
    // localStorage. Opening the status modal marks the issue "seen" up
    // to the latest history entry's timestamp. Unseen history entries
    // pulse a green ? badge on the marker + panel row.
    const LAST_SEEN_KEY_PREFIX = 'aim-issues-lastseen-';
    function lastSeenKey() {
        return LAST_SEEN_KEY_PREFIX + (cachedUsername || 'local');
    }
    function loadLastSeenMap() {
        try {
            const raw = localStorage.getItem(lastSeenKey());
            if (!raw) return {};
            const obj = JSON.parse(raw);
            return (obj && typeof obj === 'object') ? obj : {};
        } catch (e) { return {}; }
    }
    function saveLastSeenMap(map) {
        try { localStorage.setItem(lastSeenKey(), JSON.stringify(map)); }
        catch (e) {}
    }
    function markIssueSeen(issueId) {
        if (!issueId) return;
        const issue = currentSiteIssues.find(i => i.id === issueId);
        if (!issue) return;
        const lastAt = lastEventAt(issue);
        const t = new Date(lastAt || 0).getTime();
        if (!Number.isFinite(t)) return;
        const map = loadLastSeenMap();
        map[issueId] = t;
        saveLastSeenMap(map);
    }
    function unseenHistoryFor(issue) {
        if (!issue || !Array.isArray(issue.history)) return [];
        const map = loadLastSeenMap();
        const seenAt = map[issue.id];
        // Never seen → all history is unseen, EXCEPT entries authored by
        // the current user (you've "seen" your own actions by definition).
        return issue.history.filter(h => {
            if (!h || !h.at) return false;
            if (h.by && cachedUsername && h.by === cachedUsername) return false;
            const t = new Date(h.at).getTime();
            if (!Number.isFinite(t)) return false;
            if (seenAt == null) return true;
            return t > seenAt;
        });
    }
    function hasUnseenActivity(issue) {
        return unseenHistoryFor(issue).length > 0;
    }

    // ------- GM helpers (silently no-op if grants unconfirmed) -------
    function gmGet(key, def) {
        try { if (typeof GM_getValue === 'function') return GM_getValue(key, def); } catch (e) {}
        return def;
    }
    function gmSet(key, value) {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch (e) {}
    }

    // ------- GitHub HTTP wrapper (Promise over GM_xmlhttpRequest) -------
    function ghRequest(opts) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest unavailable — re-approve script grants in Tampermonkey'));
                return;
            }
            try {
                GM_xmlhttpRequest({
                    ...opts,
                    onload: (resp) => resolve(resp),
                    onerror: (err) => reject(err || new Error('network error')),
                    ontimeout: () => reject(new Error('timeout')),
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    function textToB64(text) {
        const utf8 = new TextEncoder().encode(text);
        let bin = '';
        for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
        return btoa(bin);
    }
    function b64ToText(b64) {
        const bin = atob((b64 || '').replace(/\n/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    }

    // ------- Control Panel toggle schema (v0.3) -------
    // Defaults match v0.2 visual behavior. User can dial these in via the
    // AIM Controls dropdown — "Issue rendering" category.
    const TOGGLES = [
        { id: 'master', label: 'Enable Issues', type: 'boolean', default: true, master: true },
        {
            type: 'category',
            id: 'render-cat',
            label: 'Issue rendering',
            children: [
                { id: 'render.visible-weight', label: 'Visible stroke weight', type: 'number',
                  min: 1, max: 6, step: 0.5, default: 3, unit: 'px' },
                { id: 'render.visible-opacity', label: 'Visible stroke opacity', type: 'number',
                  min: 0.4, max: 1, step: 0.05, default: 0.95, unit: 'fill' },
                { id: 'render.visible-fill', label: 'Visible fill opacity', type: 'number',
                  min: 0, max: 0.5, step: 0.025, default: 0.15, unit: 'fill' },
                { id: 'render.visible-marker-size', label: 'Visible marker size', type: 'number',
                  min: 16, max: 44, step: 2, default: 26, unit: 'px' },
                { id: 'render.hidden-opacity', label: 'Hidden stroke opacity', type: 'number',
                  min: 0.05, max: 0.8, step: 0.05, default: 0.25, unit: 'fill' },
                { id: 'render.hidden-fill', label: 'Hidden fill opacity', type: 'number',
                  min: 0, max: 0.3, step: 0.01, default: 0.04, unit: 'fill' },
                { id: 'render.hidden-weight', label: 'Hidden stroke weight', type: 'number',
                  min: 0.5, max: 3, step: 0.5, default: 1.5, unit: 'px' },
                { id: 'render.hidden-marker-size', label: 'Hidden marker size', type: 'number',
                  min: 10, max: 40, step: 2, default: 20, unit: 'px' },
            ],
        },
    ];

    function flattenToggles(arr) {
        const out = [];
        (arr || []).forEach(t => {
            if (!t) return;
            if ((t.type === 'advanced' || t.type === 'category') && Array.isArray(t.children)) {
                if (t.type === 'category' && t.master && t.master.id) {
                    out.push({ id: t.master.id, default: t.master.default });
                }
                t.children.forEach(c => { if (c && c.id) out.push(c); });
            } else if (t.id) {
                out.push(t);
            }
        });
        return out;
    }
    const toggleState = {};
    flattenToggles(TOGGLES).forEach(t => { toggleState[t.id] = t.default; });

    function getT(key) { return toggleState[key]; }

    // ------- State -------
    let masterEnabled = true;
    let flagModeActive = false;
    let siteID = null;
    let siteName = '';     // v0.20: friendly name from .site-select widget
    let currentSiteIssues = [];                  // Issue[] for current site
    const hiddenIds = new Set();                 // session-only — resets on reload
    let pendingFocusIssueId = null;              // v1.06: deep-link ?aim_issue=<id> target

    // GitHub sync state (v0.5)
    let cachedToken = gmGet(TOKEN_KEY, '') || '';       // recovered after refresh; also via TOKEN_VALUE broadcast
    let cachedUsername = gmGet(USERNAME_KEY, '') || ''; // fetched once on first token, persisted
    // v1.00: approver allowlist. Loaded once per session from
    // aim-userscripts-data/approvers.json. Mirrored to GM storage so
    // refresh-without-network still recognizes the user's role.
    let approversList = (function() {
        try { const raw = gmGet(APPROVERS_KEY, ''); if (!raw) return [];
              const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
        catch (e) { return []; }
    })();
    let approversSha = null;                              // for future write-back
    // v1.03: Slack config. { botToken, channelId, users:{githubLogin:slackId} }.
    // Loaded from slack-config.json alongside approvers. Mirrored to GM so a
    // refresh-without-network keeps Slack working. null/empty = Slack off
    // (everything degrades silently to no-post).
    let slackConfig = (function() {
        try { const raw = gmGet(SLACK_CONFIG_KEY, ''); if (!raw) return null;
              const obj = JSON.parse(raw); return (obj && typeof obj === 'object') ? obj : null; }
        catch (e) { return null; }
    })();
    function isApprover() {
        if (!cachedUsername) return false;                // local-only / no token
        return approversList.includes(cachedUsername);
    }
    function currentRole() {
        return isApprover() ? 'approver' : 'csm';
    }
    const shaBySite = {};                                // {[siteID]: 'sha-from-last-GET-or-PUT'}
    // syncStatus drives the small dot on the 🚩 button:
    //   'no-token' (grey)  — no PAT yet, local-only
    //   'syncing'  (orange-pulse) — GET or PUT in flight
    //   'ok'       (green) — last op succeeded, in sync with GitHub
    //   'pending'  (orange) — local changes not yet pushed (rare; created during retry)
    //   'error'    (red)   — last op failed
    let syncStatus = 'no-token';
    let pendingCommit = false;                           // serialize concurrent PUTs to avoid SHA races
    let commitNeededAgain = false;                       // set when a second commit request arrives mid-flight
    // v0.17: affected-entities detection. Fetched once per site change
    // from /map_objects/ (Percepto's entity list, same endpoint Asset
    // Inspector uses). Cached + invalidated when entities reload.
    const MAP_OBJECTS_URL = 'https://percepto.app/map_objects/?getPoiMapObjectsAsList=true&site_id=';
    let mapObjects = null;                                // { siteID, entities: [...] }
    let mapObjectsFetching = false;
    const issueAffectedCache = new Map();                 // issueId → array of affected entities
    const issueLayers = new Map();               // issueId → { polygon, marker }
    let drawingState = null;
    let drawToolbarEl = null;
    let noteModalEl = null;
    let statusModalEl = null;
    // v0.15: dedicated 🚩 panel (M2 on the toolbar 🚩 button opens it)
    let panelEl = null;
    // Filter chips — Set of allowed statuses. Empty == all hidden (rare).
    // v1.00: include pending_fix + pending_ignore by default; keep legacy
    // ready-for-review for grandfathered issues.
    const panelFilters = new Set(['open', 'pending_fix', 'pending_ignore', 'ready-for-review', 'resolved', 'ignored']);
    // v0.29: priority filter chips. Uses the literal string 'none' for
    // issues with no priority (issue.priority === null/undefined). All
    // four active by default. M1 toggle, M2 solo (same as status chips).
    const panelPriorityFilters = new Set(['high', 'medium', 'low', 'none']);
    let panelSearch = '';
    let panelAssignedToMe = false;   // v1.12: "Assigned to me" filter toggle
    // v0.16: persisted size + position. Loaded from localStorage on open,
    // saved on drag/resize release. Use viewport-anchored top/left so the
    // panel sticks wherever the user left it across reloads.
    const PANEL_LAYOUT_KEY = 'aim-issues-panel-layout';
    let panelLayout = null;            // { left, top, width, height } in px
    let panelDragInFlight = false;     // suppresses re-renders during drag
    function loadPanelLayout() {
        try {
            const raw = localStorage.getItem(PANEL_LAYOUT_KEY);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object') return null;
            return obj;
        } catch (e) { return null; }
    }
    function savePanelLayout(layout) {
        try { localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(layout)); }
        catch (e) {}
    }
    function clampPanelLayout(l) {
        // Clamp into viewport, with minimum size + at-least-partly-visible.
        const minW = 360, minH = 240;
        const vw = window.innerWidth, vh = window.innerHeight;
        const out = { ...l };
        out.width  = Math.max(minW, Math.min(out.width  || 560, vw - 20));
        out.height = Math.max(minH, Math.min(out.height || 520, vh - 20));
        const titleBar = 40; // leave at least the header on-screen
        out.left = Math.max(10 - out.width + 80, Math.min(out.left, vw - 80));
        out.top  = Math.max(10, Math.min(out.top, vh - titleBar));
        return out;
    }

    // v0.30: same layout-persistence model for the status modal so it
    // behaves like a real floating window (no backdrop dim, draggable
    // header, resizable corner, sticks where the user left it). Default
    // bottom-right since map content is usually centered.
    const STATUS_MODAL_LAYOUT_KEY = 'aim-issues-statusmodal-layout';
    let statusModalLayout = null;
    let statusModalDragInFlight = false;
    function loadStatusModalLayout() {
        try {
            const raw = localStorage.getItem(STATUS_MODAL_LAYOUT_KEY);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object') return null;
            return obj;
        } catch (e) { return null; }
    }
    function saveStatusModalLayout(layout) {
        try { localStorage.setItem(STATUS_MODAL_LAYOUT_KEY, JSON.stringify(layout)); }
        catch (e) {}
    }
    function clampStatusModalLayout(l) {
        const minW = 420, minH = 360;
        const vw = window.innerWidth, vh = window.innerHeight;
        const out = { ...l };
        out.width  = Math.max(minW, Math.min(out.width  || 560, vw - 20));
        out.height = Math.max(minH, Math.min(out.height || 600, vh - 20));
        out.left = Math.max(10 - out.width + 120, Math.min(out.left, vw - 120));
        out.top  = Math.max(10, Math.min(out.top, vh - 40));
        return out;
    }

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

    // v0.20: read the friendly site name from Percepto's site-select
    // widget (lives in TOP frame's header). Same-origin so the
    // cross-frame query works. Returns '' if the widget isn't mounted
    // yet (e.g. very early in load) — caller retries later.
    function readSiteName() {
        const sel = '.site-select .ant-select-selection-item';
        try {
            const topDoc = window.top && window.top.document;
            if (topDoc) {
                const el = topDoc.querySelector(sel);
                if (el) return (el.getAttribute('title') || el.textContent || '').trim();
            }
        } catch (e) {}
        try {
            const el = document.querySelector(sel);
            if (el) return (el.getAttribute('title') || el.textContent || '').trim();
        } catch (e) {}
        return '';
    }

    // v0.20: retry reading the site name — Percepto's site-select widget
    // can lag a few hundred ms behind the URL hash change on initial load.
    // Stops once we get a non-empty value, or after ~10s.
    function tickReadSiteName(attempt) {
        if (attempt > 20) return;
        const name = readSiteName();
        if (name) {
            if (name !== siteName) {
                siteName = name;
                renderButtonState(); // re-renders panel if open
            }
            return;
        }
        setTimeout(() => tickReadSiteName(attempt + 1), 500);
    }

    function storageKeyForSite(id) { return `${STORAGE_PREFIX}${id}`; }

    function loadIssuesFromStorage(id) {
        if (!id) return [];
        try {
            const raw = localStorage.getItem(storageKeyForSite(id));
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.issues)) return [];
            // v0.7: purge local-only stragglers on load. These were
            // created in v0.1-v0.4 testing (before GitHub identity) and
            // shouldn't follow the user around forever. Going forward
            // local-only issues never sync to GitHub anyway (see
            // commitIssuesToGitHub's filter) so persisting them locally
            // just clutters the map.
            const cleaned = parsed.issues.filter(i => i.createdBy !== 'local-only');
            if (cleaned.length !== parsed.issues.length) {
                const removed = parsed.issues.length - cleaned.length;
                console.log(`${TAG} purged ${removed} stale local-only issue${removed === 1 ? '' : 's'} from site ${id} on load`);
                try { saveIssuesToStorage(id, cleaned); } catch (e) {}
            }
            return cleaned;
        } catch (e) {
            console.warn(`${TAG} loadIssuesFromStorage threw:`, e);
            return [];
        }
    }

    function saveIssuesToStorage(id, issues) {
        if (!id) return;
        try {
            // v1.02: validator-generated issues (source:'validator', authored
            // 'Validator') are EPHEMERAL — never persisted, never synced. They
            // regenerate on demand from the Asset Inspector's SOP validators,
            // so storing them would just leave stale violations on the map
            // after the geometry is fixed. Strip them here so no caller can
            // accidentally persist them, and so they're absent on next load.
            const persist = (issues || []).filter(i => i.source !== 'validator');
            const payload = { version: 1, siteID: id, issues: persist };
            localStorage.setItem(storageKeyForSite(id), JSON.stringify(payload));
        } catch (e) {
            console.warn(`${TAG} saveIssuesToStorage threw:`, e);
        }
    }

    function setCurrentSite(newId) {
        if (newId === siteID) return;
        siteID = newId;
        readFocusParam();   // v1.06: a deep-link nav may carry ?aim_issue=<id>
        // v0.20: refresh friendly site name. Retries below in case the
        // .site-select widget isn't mounted yet on initial load.
        siteName = readSiteName();
        if (!siteName && newId) tickReadSiteName(0);
        clearIssueLayers();
        hiddenIds.clear();
        // v0.17: invalidate entity caches on site change
        mapObjects = null;
        issueAffectedCache.clear();
        currentSiteIssues = loadIssuesFromStorage(siteID);
        console.log(`${TAG} site changed → ${siteID} (${currentSiteIssues.length} local issue${currentSiteIssues.length === 1 ? '' : 's'})`);
        renderAllIssues();
        renderButtonState();
        // v0.5: if we have a token, pull authoritative data from GitHub.
        // refetchIssues merges remote + local by ID and pushes any local-only
        // additions back. No token → local-only fallback (Phase 1 behavior).
        if (siteID && cachedToken) refetchIssues();
        // v0.17: fetch Percepto entities for affected-entity detection.
        // Cookie auth — no token needed.
        if (siteID && !IS_TOP) fetchSiteEntities(siteID);
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
                handleSetToggle(msg);
            } else if (msg.type === 'TOKEN_VALUE') {
                handleTokenValue(msg.token || '');
            } else if (msg.type === 'REFETCH_KMLS') {
                // Token was just saved/cleared — Map Styler emits this; we
                // piggyback because the same broadcast is "token changed,
                // re-pull your data". Refetch our issues file too.
                if (siteID && cachedToken) refetchIssues();
            }
        };
    }

    function handleTokenValue(token) {
        const prev = cachedToken;
        cachedToken = token || '';
        if (cachedToken === prev) return;       // idempotent
        gmSet(TOKEN_KEY, cachedToken);          // mirror locally so refresh recovers
        if (!cachedToken) {
            cachedUsername = '';
            gmSet(USERNAME_KEY, '');
            syncStatus = 'no-token';
            renderButtonState();
            return;
        }
        // New / changed token. Ensure username + (re-)fetch current site.
        fetchGithubUsername().then(() => {
            // v1.00: also fetch approver allowlist alongside username
            fetchApproversList();
            // v1.03: and the Slack notification config (bot token + map)
            fetchSlackConfig();
            if (siteID) refetchIssues();
            else { syncStatus = 'ok'; renderButtonState(); }
        });
    }

    async function fetchGithubUsername() {
        if (IS_TOP) return;        // IFRAME owns sync to avoid duplicate API calls
        if (!cachedToken) return;
        try {
            const resp = await ghRequest({
                method: 'GET',
                url: `${GITHUB_API_BASE}/user`,
                headers: {
                    'Authorization': `Bearer ${cachedToken}`,
                    'Accept': 'application/vnd.github+json',
                },
                timeout: 15000,
            });
            if (resp.status === 200) {
                const data = JSON.parse(resp.responseText);
                if (data && data.login && data.login !== cachedUsername) {
                    cachedUsername = data.login;
                    gmSet(USERNAME_KEY, cachedUsername);
                    console.log(`${TAG} authenticated as @${cachedUsername}`);
                }
            } else {
                console.warn(`${TAG} GET /user HTTP ${resp.status}`);
            }
        } catch (e) {
            console.warn(`${TAG} GET /user threw:`, e);
        }
    }

    // v1.00: pull the approver allowlist from
    // aim-userscripts-data/approvers.json. Defines who can ACCEPT/REJECT
    // pending proposals + skip the pending step on direct ignore/resolve.
    // Missing file = no approvers; everyone uses CSM flow. Cached in GM
    // storage so refresh-without-network preserves role across reloads.
    async function fetchApproversList() {
        if (IS_TOP) return;
        if (!cachedToken) return;
        try {
            const url = `${GITHUB_API_BASE}/repos/${ISSUES_REPO}/contents/${encodeURIComponent(APPROVERS_PATH)}?ref=${ISSUES_BRANCH}`;
            const resp = await ghRequest({
                method: 'GET',
                url,
                headers: {
                    'Authorization': `Bearer ${cachedToken}`,
                    'Accept': 'application/vnd.github+json',
                },
                timeout: 15000,
            });
            if (resp.status === 404) {
                console.warn(`${TAG} approvers.json missing in data repo — approval flow disabled (everyone uses CSM transitions)`);
                approversList = [];
                gmSet(APPROVERS_KEY, JSON.stringify([]));
                return;
            }
            if (resp.status !== 200) {
                console.warn(`${TAG} GET approvers.json HTTP ${resp.status}`);
                return;
            }
            const meta = JSON.parse(resp.responseText);
            approversSha = meta.sha || null;
            const text = b64ToText(meta.content || '');
            const data = JSON.parse(text);
            const list = (data && Array.isArray(data.approvers)) ? data.approvers : [];
            approversList = list;
            gmSet(APPROVERS_KEY, JSON.stringify(list));
            console.log(`${TAG} approvers loaded (${list.length}): ${list.join(', ')} — you are ${isApprover() ? 'an APPROVER ✓' : 'a CSM'}`);
            // Refresh UI that depends on role
            if (panelEl) renderIssuesPanel();
            renderButtonState();
        } catch (e) {
            console.warn(`${TAG} fetchApproversList threw:`, e);
        }
    }

    // v1.03: pull Slack notification config from
    // aim-userscripts-data/slack-config.json. Shape:
    //   { "botToken":"xoxb-…", "channelId":"C0…",
    //     "users": { "GitHubLogin": "U0…", … } }
    // Missing file = Slack notifications off (everything degrades to no-post).
    // Cached in GM so a refresh-without-network keeps it available.
    async function fetchSlackConfig() {
        if (IS_TOP) return;            // IFRAME owns sync, same as approvers
        if (!cachedToken) return;
        try {
            const url = `${GITHUB_API_BASE}/repos/${ISSUES_REPO}/contents/${encodeURIComponent(SLACK_CONFIG_PATH)}?ref=${ISSUES_BRANCH}`;
            const resp = await ghRequest({
                method: 'GET',
                url,
                headers: {
                    'Authorization': `Bearer ${cachedToken}`,
                    'Accept': 'application/vnd.github+json',
                },
                timeout: 15000,
            });
            if (resp.status === 404) {
                console.warn(`${TAG} slack-config.json missing — Slack notifications disabled`);
                slackConfig = null;
                gmSet(SLACK_CONFIG_KEY, '');
                return;
            }
            if (resp.status !== 200) {
                console.warn(`${TAG} GET slack-config.json HTTP ${resp.status}`);
                return;
            }
            const meta = JSON.parse(resp.responseText);
            const cfg = JSON.parse(b64ToText(meta.content || ''));
            if (cfg && cfg.botToken && cfg.channelId) {
                slackConfig = { botToken: cfg.botToken, channelId: cfg.channelId, users: cfg.users || {} };
                gmSet(SLACK_CONFIG_KEY, JSON.stringify(slackConfig));
                const n = Object.keys(slackConfig.users).length;
                console.log(`${TAG} Slack config loaded — channel ${slackConfig.channelId}, ${n} user(s) mapped`);
            } else {
                console.warn(`${TAG} slack-config.json present but missing botToken/channelId — Slack off`);
                slackConfig = null;
                gmSet(SLACK_CONFIG_KEY, '');
            }
        } catch (e) {
            console.warn(`${TAG} fetchSlackConfig threw:`, e);
        }
    }

    // ------- Slack notification helpers (v1.03) -------
    function slackEnabled() {
        return !!(slackConfig && slackConfig.botToken && slackConfig.channelId);
    }
    // Slack control-char escaping for free text. Mentions (<@id>) are built
    // separately and must NOT pass through this.
    function slackEsc(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    // GitHub login → Slack mention. Falls back to a plain @login (no real
    // ping) when the user isn't in the map, so the info is never lost.
    function slackMention(login) {
        if (!login || login === 'local-only') return '';
        const id = slackConfig && slackConfig.users ? slackConfig.users[login] : null;
        return id ? `<@${id}>` : `@${slackEsc(login)}`;
    }
    // v1.10: convert inline @login tokens in free text to real Slack pings
    // for any mapped user (so typing "@ChristopherD-AIM" in a comment pings
    // them). Run AFTER slackEsc — the <@id> we insert must not be escaped.
    function slackifyMentions(text) {
        if (!slackConfig || !slackConfig.users) return text;
        return (text || '').replace(/@([A-Za-z0-9._-]+)/g, (m, name) => {
            const id = slackConfig.users[name];
            return id ? `<@${id}>` : m;
        });
    }
    // All mapped approvers as a mention string (for review pings). v1.13:
    // excludes `exceptLogin` so we never ping the person who just acted —
    // an approver proposing their own find pings the OTHER approvers, not
    // themselves.
    function slackMentionApprovers(exceptLogin) {
        const mentions = (approversList || [])
            .filter(l => l && l !== exceptLogin)
            .map(slackMention).filter(Boolean);
        return mentions.length ? mentions.join(' ') : '';
    }
    // POST a message (optionally threaded). Resolves to the message ts on
    // success, null on any failure. IFRAME-only (mirrors the sync owner) so
    // a single action fires exactly one post. Never throws.
    async function slackPost(text, threadTs) {
        if (IS_TOP) return null;
        if (!slackEnabled()) return null;
        try {
            const body = { channel: slackConfig.channelId, text };
            if (threadTs) body.thread_ts = threadTs;
            const resp = await ghRequest({
                method: 'POST',
                url: SLACK_POST_URL,
                headers: {
                    'Authorization': `Bearer ${slackConfig.botToken}`,
                    'Content-Type': 'application/json; charset=utf-8',
                },
                data: JSON.stringify(body),
                timeout: 15000,
            });
            let parsed = null;
            try { parsed = JSON.parse(resp.responseText); } catch (e) {}
            if (resp.status === 200 && parsed && parsed.ok) {
                return parsed.ts || null;
            }
            console.warn(`${TAG} Slack post failed: HTTP ${resp.status} ${parsed ? parsed.error : (resp.responseText || '').slice(0, 200)}`);
            return null;
        } catch (e) {
            console.warn(`${TAG} slackPost threw:`, e);
            return null;
        }
    }

    // Should this issue ever generate Slack traffic? Validator (ephemeral)
    // and local-only issues never sync, so they never post.
    function slackPostable(issue) {
        return slackEnabled() && issue && issue.createdBy !== 'local-only' && issue.source !== 'validator';
    }

    // v1.05: linked site label — clickable in Slack, jumps straight to the
    // site's Site Setup. <url|text> is Slack's link syntax; text can't hold
    // | or <>, which site names never do. v1.06: when issueId is given, the
    // URL carries ?aim_issue=<id> (before the hash, so SPA routing keeps it)
    // and AIM Issues focuses that issue on load — see maybeFocusIssueFromUrl.
    function siteLabelForSlack(issueId) {
        const label = siteName ? slackEsc(siteName) : `site ${siteID}`;
        const q = issueId ? `?aim_issue=${encodeURIComponent(issueId)}` : '';
        return `<https://percepto.app/${q}#/site/${siteID}/control-panel/site-setup|${label}>`;
    }

    // v1.08: status badge for the parent message — icon + label + whether to
    // strike the note (terminal states). The parent is a LIVE status board:
    // it's chat.update'd on every transition so the channel shows current
    // state at a glance. The immutable history lives in the thread replies.
    function slackStatusBadge(status) {
        switch (status) {
            case 'pending_fix':      return { icon: '🟡', text: 'PENDING FIX',      strike: false };
            case 'pending_ignore':   return { icon: '🟣', text: 'PENDING IGNORE',   strike: false };
            case 'ready-for-review': return { icon: '🟡', text: 'READY FOR REVIEW', strike: false };
            case 'resolved':         return { icon: '✅', text: 'RESOLVED',          strike: true  };
            case 'ignored':          return { icon: '⊘', text: 'IGNORED',           strike: true  };
            case 'deleted':          return { icon: '🗑', text: 'DELETED',           strike: true  };
            default:                 return { icon: '🚩', text: 'OPEN',              strike: false };
        }
    }
    // Canonical parent-message text, driven by the issue's current status
    // (or an explicit override, e.g. 'deleted' which isn't stored on .status).
    // Rebuilt identically on creation + every chat.update so the parent always
    // reflects live status without losing formatting.
    function slackParentText(issue, statusOverride) {
        const status = statusOverride || issue.status || 'open';
        const b = slackStatusBadge(status);
        const pri = issue.priority ? ` \`[${priorityMeta(issue.priority).text}]\`` : '';
        const creator = slackMention(issue.createdBy) || ('@' + slackEsc(issue.createdBy));
        const link = siteLabelForSlack(issue.id);
        let note = slackEsc(issue.note || '(no description)');
        if (b.strike) note = `~${note}~`;
        // v1.12: assignee shown as PLAIN @text (not a real <@id> mention) so
        // re-rendering the parent on every transition never re-pings them —
        // the actual ping happens in the assignment thread reply.
        const assignedSuffix = issue.assignee ? ` · 👤 @${slackEsc(issue.assignee)}` : '';
        const lines = [
            `${b.icon} *${b.text}* — issue on ${link}${pri}`,
            `>${note}`,
            `_${slackEsc(issue.shape || 'shape')} · filed by ${creator}${assignedSuffix}_`,
        ];
        const mentions = (issue.slackNotify || []).map(slackMention).filter(Boolean).join(' ');
        if (mentions) lines.push(`cc ${mentions}`);
        return lines.join('\n');
    }

    // Edit an existing message in place (chat.update). Works with chat:write —
    // no extra scope. IFRAME-only, never throws.
    async function slackUpdate(ts, text) {
        if (IS_TOP || !slackEnabled() || !ts) return false;
        try {
            const resp = await ghRequest({
                method: 'POST',
                url: SLACK_UPDATE_URL,
                headers: {
                    'Authorization': `Bearer ${slackConfig.botToken}`,
                    'Content-Type': 'application/json; charset=utf-8',
                },
                data: JSON.stringify({ channel: slackConfig.channelId, ts, text }),
                timeout: 15000,
            });
            let p = null; try { p = JSON.parse(resp.responseText); } catch (e) {}
            if (resp.status === 200 && p && p.ok) return true;
            console.warn(`${TAG} chat.update failed: HTTP ${resp.status} ${p ? p.error : ''}`);
            return false;
        } catch (e) {
            console.warn(`${TAG} slackUpdate threw:`, e);
            return false;
        }
    }

    // New issue → parent message. Stores the returned ts on the issue so
    // every browser can thread replies under it, then re-commits to sync
    // the ts. `notifyLogins` = GitHub logins the creator chose to @-mention.
    // v1.13: no self-ping — we drop the creator from the cc list (they filed
    // it, they don't need a notification for their own issue), so the picker
    // only ever pings OTHER people. No more default-tag-the-creator (that was
    // always a self-ping).
    async function postSlackNewIssue(issue, notifyLogins) {
        if (!slackPostable(issue)) return;
        try {
            const mentionLogins = (notifyLogins || []).filter(l => l && l !== issue.createdBy);
            // Stamp the notify list on the live issue first so the parent text
            // (and any later chat.update) reproduces the same cc line.
            const live = currentSiteIssues.find(i => i.id === issue.id) || issue;
            live.slackNotify = mentionLogins;
            const ts = await slackPost(slackParentText(live, null), null);
            if (ts) {
                live.slackThreadTs = ts;
                saveIssuesToStorage(siteID, currentSiteIssues);
                commitIssuesToGitHub(`attach slack thread to ${issue.id.slice(0, 14)}`);
                // v1.08: thread = immutable history. Post sequentially so
                // order is guaranteed: (1) original report, (2) affected
                // entities, then transitions append after.
                await postSlackOriginalRequest(live, ts);
                await postSlackAffectedEntities(live, ts);
            }
        } catch (e) {
            console.warn(`${TAG} postSlackNewIssue threw:`, e);
        }
    }

    // v1.08: original report → first thread reply, preserved verbatim so
    // editing the parent (live status board) never loses what was filed.
    async function postSlackOriginalRequest(issue, threadTs) {
        if (!slackEnabled() || !threadTs) return;
        try {
            const creator = slackMention(issue.createdBy) || ('@' + slackEsc(issue.createdBy));
            const pri = issue.priority ? ` \`[${priorityMeta(issue.priority).text}]\`` : '';
            await slackPost(`📝 *Reported* by ${creator}${pri}\n>${slackEsc(issue.note || '(no description)')}`, threadTs);
        } catch (e) {
            console.warn(`${TAG} postSlackOriginalRequest threw:`, e);
        }
    }

    // Affected entities → first threaded reply under a new issue. Reuses the
    // same overlap detection the panel uses.
    async function postSlackAffectedEntities(issue, threadTs) {
        if (!slackEnabled() || !threadTs) return;
        try {
            const affected = affectedEntitiesFor(issue);
            if (!affected || !affected.length) return;
            const CAP = 40;
            const lines = affected.slice(0, CAP).map(a =>
                `• *${slackEsc(a.typeLabel || a.typeShort || '?')}*: ${slackEsc(a.name)}${a.subtype ? ' (' + slackEsc(a.subtype) + ')' : ''}`);
            const more = affected.length > CAP ? `\n_…and ${affected.length - CAP} more_` : '';
            await slackPost(`📍 *Affected entities (${affected.length}):*\n${lines.join('\n')}${more}`, threadTs);
        } catch (e) {
            console.warn(`${TAG} postSlackAffectedEntities threw:`, e);
        }
    }

    // Delete → threaded reply, so the thread shows created → … → deleted,
    // and strike/badge the original parent message (v1.06).
    async function postSlackDelete(issue, by) {
        if (!slackPostable(issue) || !issue.slackThreadTs) return;
        try {
            const actor = slackMention(by) || ('@' + slackEsc(by));
            await slackPost(`🗑 ${actor} *deleted* this issue`, issue.slackThreadTs);
            await slackUpdate(issue.slackThreadTs, slackParentText(issue, 'deleted'));
        } catch (e) {
            console.warn(`${TAG} postSlackDelete threw:`, e);
        }
    }

    // Status transition → threaded reply. Role-aware mention:
    //  • CSM proposes (→ pending_*)         → ping approvers to review
    //  • approver approves/rejects pending  → cc the original proposer
    //  • direct resolve / reopen / un-ignore → no mention
    async function postSlackTransition(issue, fromStatus, transition, note, by) {
        if (!slackPostable(issue)) return;
        try {
            const actor = slackMention(by) || ('@' + slackEsc(by));
            const toLabel = (STATUS_LABEL[transition.to] || { text: transition.to.toUpperCase() }).text;
            // v1.13: never ping the actor for their own action (exceptLogin=by).
            const prop = proposerOf(issue);
            const proposerMention = (prop && prop !== by) ? slackMention(prop) : '';
            let head, mention = '';
            if (transition.to === 'pending_fix') {
                head = `🟡 ${actor} proposed *FIX* — needs review`;
                mention = slackMentionApprovers(by);
            } else if (transition.to === 'pending_ignore') {
                head = `🟣 ${actor} proposed *IGNORE* — needs review`;
                mention = slackMentionApprovers(by);
            } else if (transition.approvalCheck && transition.to === 'open') {
                head = `❌ ${actor} *rejected* → back to OPEN`;
                mention = proposerMention;
            } else if (transition.approvalCheck) {
                head = `✅ ${actor} *approved* → ${toLabel}`;
                mention = proposerMention;
            } else if (transition.to === 'open') {
                head = `↺ ${actor} re-opened → OPEN`;
            } else {
                head = `✅ ${actor} → ${toLabel}`;
            }
            const lines = [head];
            if (note) lines.push(`>${slackEsc(note)}`);
            if (mention) lines.push(`cc ${mention}`);
            const text = issue.slackThreadTs ? lines.join('\n')
                       : `${lines.join('\n')}\n_(${slackEsc((issue.note || '').slice(0, 80))} — ${siteLabelForSlack()})_`;
            await slackPost(text, issue.slackThreadTs || null);
            // v1.08: parent is a live status board — reflect EVERY transition
            // (pending/resolved/ignored/reopen). issue.status is already the
            // new status here (applyTransition set it before calling us).
            if (issue.slackThreadTs) {
                await slackUpdate(issue.slackThreadTs, slackParentText(issue));
            }
        } catch (e) {
            console.warn(`${TAG} postSlackTransition threw:`, e);
        }
    }

    // v1.12: assignment → threaded reply + pings the new assignee. Parent
    // status board also re-rendered (shows assignee).
    async function postSlackAssignment(issue, from, to, by) {
        if (!slackPostable(issue)) return;
        try {
            const actor = slackMention(by) || ('@' + slackEsc(by));
            let head;
            if (!to) {
                head = `👤 ${actor} *unassigned* this issue`;
            } else if (to === by) {
                head = `👤 ${actor} *self-assigned* this issue`;
            } else {
                head = `👤 ${actor} *assigned* this to ${slackMention(to) || ('@' + slackEsc(to))}`;
            }
            const text = issue.slackThreadTs ? head
                       : `${head}\n_(${slackEsc((issue.note || '').slice(0, 80))} — ${siteLabelForSlack()})_`;
            await slackPost(text, issue.slackThreadTs || null);
            if (issue.slackThreadTs) await slackUpdate(issue.slackThreadTs, slackParentText(issue));
        } catch (e) {
            console.warn(`${TAG} postSlackAssignment threw:`, e);
        }
    }

    // Most recent person who moved this issue INTO a pending_* state — the
    // one whose proposal an approver is now approving/rejecting.
    function proposerOf(issue) {
        const h = issue.history || [];
        for (let i = h.length - 1; i >= 0; i--) {
            if (h[i].toStatus === 'pending_fix' || h[i].toStatus === 'pending_ignore') return h[i].by;
        }
        return null;
    }

    // Comment → threaded reply. v1.10: inline @login in the text auto-pings
    // mapped users, and `notifyLogins` (from the chip picker) are cc'd.
    async function postSlackComment(issue, note, by, notifyLogins) {
        if (!slackPostable(issue)) return;
        try {
            const actor = slackMention(by) || ('@' + slackEsc(by));
            const body = slackifyMentions(slackEsc(note));
            // v1.13: don't ping yourself in your own comment.
            const cc = (notifyLogins || []).filter(l => l && l !== by).map(slackMention).filter(Boolean).join(' ');
            let head = `💬 ${actor}: ${body}`;
            if (cc) head += `\ncc ${cc}`;
            const text = issue.slackThreadTs ? head
                       : `${head}\n_(${slackEsc((issue.note || '').slice(0, 80))} — ${siteLabelForSlack()})_`;
            await slackPost(text, issue.slackThreadTs || null);
        } catch (e) {
            console.warn(`${TAG} postSlackComment threw:`, e);
        }
    }

    // ------- Remote read / write -------
    // Pulls issues/<siteID>-issues.json. null on 404 (no file yet);
    // throws on any other non-200. Caches SHA per site.
    async function fetchRemoteIssues(sid) {
        if (!cachedToken || !sid) return null;
        const url = `${GITHUB_API_BASE}/repos/${ISSUES_REPO}/contents/${encodeURIComponent(ISSUES_PATH(sid))}?ref=${ISSUES_BRANCH}`;
        const resp = await ghRequest({
            method: 'GET',
            url,
            headers: {
                'Authorization': `Bearer ${cachedToken}`,
                'Accept': 'application/vnd.github+json',
            },
            timeout: 20000,
        });
        if (resp.status === 404) return null;
        if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
        const meta = JSON.parse(resp.responseText);
        const text = b64ToText(meta.content || '');
        const data = JSON.parse(text);
        const issues = (data && Array.isArray(data.issues)) ? data.issues : [];
        return { issues, sha: meta.sha };
    }

    // Compare history-last timestamps; tiebreak on createdAt.
    function lastHistAt(issue) {
        if (issue.history && issue.history.length) {
            const t = new Date(issue.history[issue.history.length - 1].at).getTime();
            if (Number.isFinite(t)) return t;
        }
        return new Date(issue.createdAt || 0).getTime() || 0;
    }

    // v0.24: merge history arrays so concurrent transitions on the SAME
    // issue both survive. Bug: two CSMs each open the same issue from
    // stale views, both ignore it with different notes; A's PUT lands
    // first, B's PUT hits 409 → re-fetch + merge. Old logic picked whichever
    // whole-issue object had a later history-tail timestamp → A's
    // transition got discarded entirely. Now we union the histories and
    // recompute status from history[last].
    function mergeHistoryArrays(a, b) {
        const all = [...(a || []), ...(b || [])];
        // Dedupe: identical (at|by|fromStatus|toStatus|note) = same entry.
        // No tolerance window — exact match. Browser clocks drifting a
        // few seconds is acceptable in the audit log.
        const seen = new Set();
        const out = [];
        for (const h of all) {
            if (!h || typeof h !== 'object') continue;
            const key = `${h.at}|${h.by}|${h.fromStatus}|${h.toStatus}|${h.note || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(h);
        }
        out.sort((x, y) => {
            const tx = new Date(x.at).getTime();
            const ty = new Date(y.at).getTime();
            return (isNaN(tx) ? 0 : tx) - (isNaN(ty) ? 0 : ty);
        });
        return out;
    }

    function mergeIssueObjects(a, b) {
        const history = mergeHistoryArrays(a.history, b.history);
        const status = history.length
            ? history[history.length - 1].toStatus
            : (a.status || b.status || 'open');
        // v0.26: diagnostic so we can SEE merges happening when users
        // report data loss. Logs the per-issue merge with history counts.
        try {
            const aLen = (a.history || []).length;
            const bLen = (b.history || []).length;
            if (aLen !== history.length || bLen !== history.length) {
                console.log(`${TAG} mergeIssueObjects(${a.id}): local hist=${aLen} + remote hist=${bLen} → merged=${history.length}, status=${status}`);
            }
        } catch (e) {}
        // Immutable fields (polygon / note / surface / shape / createdAt /
        // createdBy / id) don't change after creation, so both copies hold
        // the same values — taking from either side is fine. Use spread
        // with `a` first for stable ordering of fields.
        const merged = { ...a, ...b, history, status };
        // v0.25: delete-wins. If EITHER copy is tombstoned, the merged
        // result is tombstoned. Keep whichever tombstone happened first
        // (canonical record of when the delete actually occurred).
        if (a.deleted || b.deleted) {
            merged.deleted = true;
            // Prefer earliest deletedAt — first delete is the canonical one
            const aAt = a.deletedAt ? new Date(a.deletedAt).getTime() : Infinity;
            const bAt = b.deletedAt ? new Date(b.deletedAt).getTime() : Infinity;
            if (aAt <= bAt) {
                merged.deletedAt = a.deletedAt || b.deletedAt;
                merged.deletedBy = a.deletedBy || b.deletedBy;
            } else {
                merged.deletedAt = b.deletedAt;
                merged.deletedBy = b.deletedBy;
            }
        }
        return merged;
    }

    function mergeIssueLists(localList, remoteList) {
        const byId = new Map();
        (remoteList || []).forEach(r => { if (r && r.id) byId.set(r.id, r); });
        (localList || []).forEach(l => {
            if (!l || !l.id) return;
            const r = byId.get(l.id);
            if (!r) { byId.set(l.id, l); return; }
            byId.set(l.id, mergeIssueObjects(l, r));
        });
        const out = Array.from(byId.values());
        // v0.26: diagnostic for the union counts
        try {
            console.log(`${TAG} mergeIssueLists: local=${(localList || []).length} + remote=${(remoteList || []).length} → ${out.length}`);
        } catch (e) {}
        return out;
    }

    async function refetchIssues() {
        // Sync only runs in the IFRAME — TOP also gets TOKEN_VALUE +
        // hashchange but would fire duplicate API calls otherwise.
        if (IS_TOP) return;
        if (!siteID || !cachedToken) return;
        const sid = siteID;
        setSyncStatus('syncing');
        try {
            const remote = await fetchRemoteIssues(sid);
            if (sid !== siteID) return;                      // site changed mid-flight
            if (remote === null) {
                // No file on GitHub yet. Push local issues to create it —
                // but only authored ones (v0.7: local-only never syncs).
                delete shaBySite[sid];
                const authoredCount = currentSiteIssues.filter(i => i.createdBy !== 'local-only' && i.source !== 'validator').length;
                if (authoredCount > 0) {
                    console.log(`${TAG} no remote file for site ${sid} but ${authoredCount} authored issue${authoredCount === 1 ? '' : 's'} local — pushing to create file`);
                    await commitIssuesToGitHub('initial push to migrate local issues');
                } else {
                    setSyncStatus('ok');
                }
                return;
            }
            // 200 — merge remote + local by ID.
            const beforeLocalCount = currentSiteIssues.length;
            const merged = mergeIssueLists(currentSiteIssues, remote.issues);
            const localOnlyCount = merged.filter(m =>
                !remote.issues.some(r => r.id === m.id)
            ).length;
            // v0.27: ALSO push back if a merged issue has more history
            // entries than its remote counterpart, OR a local-tombstone that
            // remote doesn't have. v0.26's diagnostic caught this — Tab 2
            // had [created, Ignored-2] locally, GitHub had [created, Ignore-1]
            // (pushed by Tab 1 between Tab 2's commit and Tab 2's refetch).
            // Merge produced 3 entries. Old code's `localOnlyCount` was 0
            // (issue exists in both) → no push → Tab 2's "Ignored-2"
            // stayed local forever. Now we detect history-delta and push.
            let historyDeltaCount = 0;
            let tombstoneDeltaCount = 0;
            merged.forEach(m => {
                const r = remote.issues.find(x => x.id === m.id);
                if (!r) return; // counted in localOnlyCount
                const mLen = (m.history || []).length;
                const rLen = (r.history || []).length;
                if (mLen > rLen) historyDeltaCount++;
                if (m.deleted && !r.deleted) tombstoneDeltaCount++;
            });
            const needsPush = (localOnlyCount + historyDeltaCount + tombstoneDeltaCount) > 0;
            shaBySite[sid] = remote.sha;
            currentSiteIssues = merged;
            saveIssuesToStorage(sid, currentSiteIssues);
            renderAllIssues();
            renderButtonState();
            if (needsPush) {
                const parts = [];
                if (localOnlyCount) parts.push(`${localOnlyCount} local-only`);
                if (historyDeltaCount) parts.push(`${historyDeltaCount} with extra history`);
                if (tombstoneDeltaCount) parts.push(`${tombstoneDeltaCount} tombstoned`);
                console.log(`${TAG} merged remote (${remote.issues.length}) with local (${beforeLocalCount}) → ${merged.length} total; pushing: ${parts.join(', ')}`);
                await commitIssuesToGitHub(`merge: ${parts.join(', ')}`);
            } else {
                setSyncStatus('ok');
                console.log(`${TAG} synced from GitHub: ${remote.issues.length} issue${remote.issues.length === 1 ? '' : 's'} on site ${sid}`);
            }
        } catch (e) {
            setSyncStatus('error');
            console.warn(`${TAG} refetchIssues failed:`, e);
            showToast(`Sync failed: ${e.message || 'unknown error'}. Local changes preserved.`, 5000);
        }
    }

    async function commitIssuesToGitHub(reasonOverride) {
        if (IS_TOP) return false;
        if (!siteID || !cachedToken) return false;
        if (pendingCommit) {
            // Serialize — a second commit while one is in flight would
            // race the SHA cache. Flag a follow-up push to capture the
            // newest currentSiteIssues after the in-flight one finishes.
            commitNeededAgain = true;
            console.log(`${TAG} commit already in flight — queued follow-up`);
            return false;
        }
        pendingCommit = true;
        const sid = siteID;
        setSyncStatus('syncing');
        try {
            const path = ISSUES_PATH(sid);
            const url = `${GITHUB_API_BASE}/repos/${ISSUES_REPO}/contents/${encodeURIComponent(path)}`;
            // v0.7: local-only issues never leave the user's browser. They
            // have no real author and shouldn't pollute the shared file —
            // either drop them entirely on next refresh (loadIssuesFromStorage
            // purge) or wait for the user to delete via UI. Either way,
            // commits to GitHub exclude them.
            const issuesToSync = currentSiteIssues.filter(i => i.createdBy !== 'local-only' && i.source !== 'validator');
            const payload = { version: 1, siteID: sid, issues: issuesToSync };
            const b64 = textToB64(JSON.stringify(payload, null, 2));
            const sha = shaBySite[sid];
            const reason = reasonOverride || `update (${issuesToSync.length} total)`;
            // v0.26: log the per-issue history counts going into the PUT so
            // we can see exactly what's being uploaded. If user reports
            // "the 2nd overwrote the 1st", this log line will show
            // whether the merged history actually made it into the PUT.
            try {
                const hcounts = issuesToSync.map(i => `${i.id.slice(0, 14)}…:${(i.history || []).length}h${i.deleted ? ',DEL' : ''}`).join(' ');
                console.log(`${TAG} PUT (${reason}) sha=${(sha || 'NEW').slice(0, 7)} hist counts: ${hcounts || '(empty)'}`);
            } catch (e) {}
            const body = {
                message: `[AIM site ${sid}] issues: ${reason}`,
                content: b64,
                branch: ISSUES_BRANCH,
            };
            if (sha) body.sha = sha;
            const resp = await ghRequest({
                method: 'PUT',
                url,
                headers: {
                    'Authorization': `Bearer ${cachedToken}`,
                    'Accept': 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                },
                data: JSON.stringify(body),
                timeout: 25000,
            });
            if (resp.status === 200 || resp.status === 201) {
                const ret = JSON.parse(resp.responseText);
                if (ret && ret.content && ret.content.sha) shaBySite[sid] = ret.content.sha;
                setSyncStatus('ok');
                showToast(`✓ Synced to GitHub (${issuesToSync.length} issue${issuesToSync.length === 1 ? '' : 's'}).`, 2500);
                return true;
            }
            if (resp.status === 409 || resp.status === 422) {
                // SHA mismatch — someone else committed since our last GET.
                // Re-fetch, union-merge, retry PUT once.
                console.warn(`${TAG} commit conflict (HTTP ${resp.status}) — re-fetching to merge`);
                pendingCommit = false;
                const remote = await fetchRemoteIssues(sid);
                if (remote === null) {
                    delete shaBySite[sid];
                } else {
                    currentSiteIssues = mergeIssueLists(currentSiteIssues, remote.issues);
                    shaBySite[sid] = remote.sha;
                    saveIssuesToStorage(sid, currentSiteIssues);
                    renderAllIssues();
                }
                // One retry — no infinite loop on persistent conflicts.
                if (sid === siteID) return commitIssuesToGitHub(reasonOverride);
                return false;
            }
            if (resp.status === 401 || resp.status === 403) {
                setSyncStatus('error');
                showToast('GitHub denied write — PAT needs contents:write on aim-userscripts-data.', 8000);
                return false;
            }
            setSyncStatus('error');
            showToast(`Commit failed: HTTP ${resp.status}.`, 4500);
            console.warn(`${TAG} commit PUT HTTP ${resp.status}:`, (resp.responseText || '').substring(0, 600));
            return false;
        } catch (e) {
            setSyncStatus('error');
            showToast(`Commit failed: ${e.message || 'network error'}.`, 4500);
            console.error(`${TAG} commit threw:`, e);
            return false;
        } finally {
            pendingCommit = false;
            // If something arrived during this commit (typically another
            // createIssue), schedule a follow-up so it lands in GitHub.
            if (commitNeededAgain && siteID && cachedToken) {
                commitNeededAgain = false;
                setTimeout(() => commitIssuesToGitHub('follow-up after concurrent change'), 100);
            }
        }
    }

    function setSyncStatus(s) {
        if (s === syncStatus) return;
        syncStatus = s;
        renderButtonState();
    }

    function handleSetToggle(msg) {
        const v = msg.value !== undefined ? msg.value : msg.enabled;
        if (msg.toggleId === 'master') {
            const next = !!v;
            if (next === masterEnabled) return;
            masterEnabled = next;
            renderButtonState();
            if (!masterEnabled) {
                if (flagModeActive) setFlagMode(false);
                clearIssueLayers();
            } else {
                renderAllIssues();
            }
            return;
        }
        // Render toggles (numbers). All re-render on change — idempotent
        // early-return prevents render thrash from duplicate broadcasts.
        if (msg.toggleId in toggleState) {
            const def = flattenToggles(TOGGLES).find(t => t.id === msg.toggleId);
            const nextRaw = (def && def.type === 'number') ? Number(v) : v;
            if (toggleState[msg.toggleId] === nextRaw) return;
            toggleState[msg.toggleId] = nextRaw;
            renderAllIssues();
        }
    }

    function registerWithControlPanel() {
        if (!controlChannel) return;
        try {
            controlChannel.postMessage({
                type: 'REGISTER',
                scriptId: SCRIPT_ID,
                name: 'Issues',
                version: SCRIPT_VERSION,
                toggles: TOGGLES,
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

    // ------- Leaflet map tagging (self-sufficient — was a v1.00 bug) -------
    // v1.01: AIM Issues previously only READ `container.__aim_map__`, which
    // is set by Map Styler's prototype hook — but that hook only installs
    // when Map Styler's master toggle is ON. Coworkers with Map Styler
    // disabled got "Map not ready" on flag mode (M1) because the container
    // was never tagged, and Percepto holds the map in a closure the DOM
    // walk can't reach. We now install our OWN copy of the hook so flag
    // mode works regardless of whether Map Styler is enabled or installed.
    // Idempotent with Map Styler's hook (both guard on !container.__aim_map__),
    // so running both is harmless.
    let leafletPatched = false;
    function patchLeafletMap() {
        if (leafletPatched) return true;
        try {
            const L = getL();
            if (!L || !L.Map || !L.Map.prototype) return false;
            // Hook commonly-called map methods. The next time Percepto runs
            // ANY of these, we capture `this` and stash it on the container
            // as `__aim_map__` — covers already-created maps, not just new ones.
            const methodsToHook = ['initialize', 'getPane', 'addLayer', 'invalidateSize', 'setView', 'panTo', '_animateZoom'];
            methodsToHook.forEach(method => {
                if (typeof L.Map.prototype[method] !== 'function') return;
                const orig = L.Map.prototype[method];
                L.Map.prototype[method] = function (...args) {
                    try {
                        if (this && this._container && !this._container.__aim_map__) {
                            this._container.__aim_map__ = this;
                        }
                    } catch (e) {}
                    return orig.apply(this, args);
                };
            });
            leafletPatched = true;
            console.log(`${TAG} patched L.Map prototype methods (${methodsToHook.length} hooks)`);
            return true;
        } catch (e) {
            console.warn(`${TAG} L.Map patch failed:`, e);
            return false;
        }
    }

    function getL() {
        // v0.6: with @grant directives (added in v0.5), Tampermonkey runs
        // the script in a sandboxed context where `window` is a proxy.
        // Page-mounted Leaflet lives on `unsafeWindow`, and creating a
        // polygon via the sandbox-side L produced a polygon that attached
        // but rendered invisibly — markers (divIcon) happened to work
        // because they're DOM-only. Same fix Map Styler uses (line 1104).
        try {
            const realWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            if (realWin && realWin.L) return realWin.L;
            if (window.L) return window.L;
            if (window.top && window.top.L) return window.top.L;
        } catch (e) {}
        return null;
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
            // v0.15: M2 now opens the dedicated Issues panel. The
            // "Un-hide all non-resolved" action moved into a button
            // inside the panel header.
            if (panelEl) closeIssuesPanel();
            else openIssuesPanel();
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
        const hiddenSuffix = hiddenCount > 0 ? ` · ${hiddenCount} hidden` : '';
        const syncLabel = ({
            'no-token': 'no GitHub token (local-only)',
            'syncing':  'syncing with GitHub…',
            'ok':       cachedUsername ? `synced to GitHub as @${cachedUsername}` : 'synced to GitHub',
            'pending':  'local changes pending push',
            'error':    'GitHub sync error — see console',
        })[syncStatus] || '';
        const syncSuffix = syncLabel ? ` · ${syncLabel}` : '';
        buttonEl.title = !masterEnabled
            ? 'Issues: disabled in AIM Controls'
            : flagModeActive
                ? `Issues: FLAG MODE armed — click-drag rect, Shift+click polygon, Esc to exit${hiddenSuffix}${syncSuffix}`
                : `Issues · M1 toggle flag mode · M2 open Issues panel${hiddenSuffix}${syncSuffix}`;

        // Badge: count for current site (top-right corner). v1.00 — if
        // the user is an approver AND there are pending issues, the badge
        // morphs to ORANGE + pending count (your-attention-needed cue).
        // Otherwise plain red total count, as before.
        let badge = buttonEl.querySelector('.aim-issues-badge');
        const live = liveIssues(currentSiteIssues);
        const n = live.length;
        const pending = isApprover()
            ? live.filter(i => i.status === 'pending_fix' || i.status === 'pending_ignore').length
            : 0;
        const showAttention = pending > 0;
        const badgeText = showAttention ? String(pending) : (n > 0 ? String(n) : '');
        const badgeBg = showAttention ? '#ffa726' : '#ff4d4d';
        const badgeFg = showAttention ? '#000' : '#fff';
        if (badgeText) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'aim-issues-badge';
                badge.style.cssText = [
                    'position:absolute', 'top:-4px', 'right:-4px',
                    'min-width:16px', 'height:16px', 'border-radius:8px',
                    'font-size:10px', 'font-weight:700',
                    'display:flex', 'align-items:center', 'justify-content:center',
                    'padding:0 4px',
                    'box-shadow:0 1px 3px rgba(0,0,0,0.6)',
                    'pointer-events:none',
                ].join(';');
                buttonEl.appendChild(badge);
            }
            badge.textContent = badgeText;
            badge.style.background = badgeBg;
            badge.style.color = badgeFg;
            badge.title = showAttention
                ? `${pending} pending your review`
                : `${n} issue${n === 1 ? '' : 's'} on this site`;
        } else if (badge) {
            badge.remove();
        }

        // Sync dot: small colored circle in top-LEFT corner so it doesn't
        // collide with the count badge. v0.5.
        let dot = buttonEl.querySelector('.aim-issues-syncdot');
        if (!dot) {
            dot = document.createElement('span');
            dot.className = 'aim-issues-syncdot';
            dot.style.cssText = [
                'position:absolute', 'top:-3px', 'left:-3px',
                'width:8px', 'height:8px', 'border-radius:4px',
                'border:1px solid rgba(0,0,0,0.55)',
                'pointer-events:none',
                'transition:background 200ms ease',
            ].join(';');
            buttonEl.appendChild(dot);
        }
        const dotColor = ({
            'no-token': '#777',
            'syncing':  '#ffb347',
            'ok':       '#5fff5f',
            'pending':  '#ffb347',
            'error':    '#ff4d4d',
        })[syncStatus] || '#777';
        dot.style.background = dotColor;
        dot.style.boxShadow = (syncStatus === 'syncing')
            ? '0 0 6px rgba(255,179,71,0.9)'
            : (syncStatus === 'error' ? '0 0 6px rgba(255,77,77,0.9)' : 'none');
        // v0.15: every renderButtonState call follows a data mutation
        // (create/delete/transition/hide/sync), so it's the right pinch
        // point to refresh the panel. Cheap (panel re-renders only if
        // it's open).
        if (panelEl) {
            try { renderIssuesPanel(); } catch (e) { console.warn(`${TAG} panel refresh threw:`, e); }
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
        // v0.28: priority chips inside the note modal — None/Low/Med/High.
        // No selection means priority stays null.
        const priorityChipsHtml = ['none', 'low', 'medium', 'high'].map(p => {
            if (p === 'none') {
                return `<button type="button" class="aim-issues-pri-chip" data-priority=""
                    style="padding:5px 12px;background:#1a1d23;color:#888;border:1.5px solid #555;border-radius:14px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">
                    None
                </button>`;
            }
            const m = priorityMeta(p);
            return `<button type="button" class="aim-issues-pri-chip" data-priority="${p}"
                style="padding:5px 12px;background:transparent;color:${m.color};border:1.5px solid ${m.color};border-radius:14px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">
                ${m.text}
            </button>`;
        }).join('');
        // v1.03: optional "Notify" multi-select — @-mention chosen teammates
        // in the Slack post on creation. v1.05: includes yourself (tag an
        // issue for your own follow-up). Empty selection defaults to the
        // creator in postSlackNewIssue.
        const notifyLogins = slackEnabled()
            ? Object.keys(slackConfig.users || {}).sort()
            : [];
        const notifyRowHtml = notifyLogins.length ? `
            <div style="font-size:12px;color:#aaa;margin-top:10px;margin-bottom:6px">
                Notify on Slack (optional)
            </div>
            <div id="aim-issues-notify-row" style="display:flex;gap:6px;flex-wrap:wrap">
                ${notifyLogins.map(l => `<button type="button" class="aim-issues-notify-chip" data-login="${escHtml(l)}"
                    style="padding:5px 12px;background:transparent;color:#5fb3ff;border:1.5px solid #5fb3ff;border-radius:14px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">
                    @${escHtml(l)}
                </button>`).join('')}
            </div>` : '';
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
            <div style="font-size:12px;color:#aaa;margin-top:6px;margin-bottom:6px">
                Priority (optional)
            </div>
            <div id="aim-issues-pri-row" style="display:flex;gap:6px;flex-wrap:wrap">
                ${priorityChipsHtml}
            </div>
            ${notifyRowHtml}
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
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
        // v1.09: stop map/Leaflet from processing pointer/mouse/wheel events
        // that bubble out of the modal — the status modal already does this;
        // the note modal didn't, which let every click leak to Percepto's
        // global handlers and stalled chip feedback by seconds.
        ['mousedown', 'pointerdown', 'pointerup', 'mouseup', 'wheel', 'click', 'dblclick', 'contextmenu', 'touchstart'].forEach(evt => {
            card.addEventListener(evt, (e) => e.stopPropagation(), false);
        });
        const input = card.querySelector('#aim-issues-note-input');
        const err = card.querySelector('#aim-issues-note-err');
        const cancel = card.querySelector('#aim-issues-note-cancel');
        const save = card.querySelector('#aim-issues-note-save');
        setTimeout(() => { try { input.focus(); } catch (e) {} }, 30);
        // v0.28: priority chip selection — null by default. Filled bg = selected.
        let selectedPriority = null;
        const chips = card.querySelectorAll('.aim-issues-pri-chip');
        const paintChips = () => {
            chips.forEach(c => {
                const p = c.dataset.priority || null;
                const isSel = (selectedPriority === (p || null));
                const m = p ? priorityMeta(p) : { color: '#888', textColor: '#888' };
                if (isSel) {
                    c.style.background = p ? m.color : '#555';
                    c.style.color = p ? m.textColor : '#fff';
                } else {
                    c.style.background = 'transparent';
                    c.style.color = p ? m.color : '#888';
                }
            });
        };
        // v1.09: pointerdown (with click fallback + debounce) so priority
        // selection feels instant, matching the notify chips.
        let lastPriFire = 0;
        const selectPri = (c) => {
            const now = Date.now();
            if (now - lastPriFire < 250) return;   // ignore the paired event
            lastPriFire = now;
            selectedPriority = c.dataset.priority || null;
            paintChips();
        };
        chips.forEach(c => {
            const h = (e) => { e.preventDefault(); e.stopPropagation(); selectPri(c); };
            c.addEventListener('pointerdown', h, true);
            c.addEventListener('click', h, true);
        });
        // v1.03: notify chips — independent multi-select toggle. Filled = on.
        // v1.06: Leaflet intermittently swallows `click` on elements inside
        // the map iframe, so the first 1-2 taps did nothing. Listen on BOTH
        // pointerdown AND click with a per-chip debounce so whichever event
        // survives toggles exactly once (the paired event is ignored).
        const notifySelected = new Set();
        const lastChipFire = new Map();
        const toggleNotifyChip = (c) => {
            const login = c.dataset.login;
            const now = Date.now();
            if (now - (lastChipFire.get(login) || 0) < 300) return;  // ignore paired event
            lastChipFire.set(login, now);
            if (notifySelected.has(login)) {
                notifySelected.delete(login);
                c.style.background = 'transparent';
                c.style.color = '#5fb3ff';
            } else {
                notifySelected.add(login);
                c.style.background = '#5fb3ff';
                c.style.color = '#0a1a2a';
            }
        };
        card.querySelectorAll('.aim-issues-notify-chip').forEach(c => {
            const handler = (e) => { e.preventDefault(); e.stopPropagation(); toggleNotifyChip(c); };
            c.addEventListener('pointerdown', handler, true);
            c.addEventListener('click', handler, true);
        });
        cancel.onclick = () => { closeNoteModal(); showToast('Issue discarded.', 1800); };
        save.onclick = () => {
            // v0.21: lock + close-first guard. Coworker hit Create, modal
            // didn't close (createIssue threw before closeNoteModal), they
            // hit Create twice more and got 2 duplicate issues. Now: lock
            // the button on first click + close the modal IMMEDIATELY,
            // then run createIssue inside try so any thrown error is
            // logged but the user can't double-fire.
            if (save.dataset.locked === '1') return;
            const note = (input.value || '').trim();
            if (!note) { err.textContent = 'Note is required.'; return; }
            err.textContent = '';
            save.dataset.locked = '1';
            save.disabled = true;
            save.textContent = 'Creating…';
            save.style.opacity = '0.7';
            save.style.cursor = 'not-allowed';
            closeNoteModal();
            try {
                createIssue({ shape, latlngsObjs, note, priority: selectedPriority, notify: Array.from(notifySelected) });
            } catch (e) {
                console.error(`${TAG} createIssue threw:`, e);
                showToast('Issue created — render failed, refresh to recover. See console.', 5000);
            }
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

    function createIssue({ shape, latlngsObjs, note, priority, notify }) {
        if (!siteID) { showToast('No site loaded — issue discarded.', 4000); return; }
        const nowIso = new Date().toISOString();
        const id = `iss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const polygon = latlngsObjs.map(c => [c.lat, c.lng]);
        // v0.5: createdBy is the GitHub login when authenticated; falls
        // back to 'local-only' when there's no PAT.
        const by = cachedUsername || 'local-only';
        // v0.28: priority is optional. null = no priority set. Picker in
        // the note modal lets user pick HIGH/MED/LOW or skip.
        const pri = (priority && PRIORITY_LABEL[priority]) ? priority : null;
        const issue = {
            id,
            surface: 'site-setup',
            shape,
            polygon,
            note,
            status: 'open',
            priority: pri,
            createdAt: nowIso,
            createdBy: by,
            history: [
                { at: nowIso, by, fromStatus: null, toStatus: 'open', note },
            ],
        };
        currentSiteIssues.push(issue);
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderOneIssue(issue);
        renderButtonState();
        const localCount = liveIssues(currentSiteIssues).length;
        if (cachedToken) {
            showToast(`Issue created — pushing to GitHub…`, 2500);
            commitIssuesToGitHub(`add issue by @${by}`);
            // v1.03: announce in Slack + capture thread ts (fire-and-forget).
            postSlackNewIssue(issue, notify);
        } else {
            showToast(`Issue created locally (no GitHub token, ${localCount} on this site).`, 3500);
        }
        console.log(`${TAG} created issue ${id} (${shape}, ${polygon.length} vertices) by @${by}`);
    }

    // v0.6: creator-only delete. Removes from currentSiteIssues, drops
    // any rendered layer for it, saves locally, and pushes the new list
    // to GitHub. The status modal's two-stage confirm is the user-facing
    // guard; this function trusts the caller. The creator check is also
    // re-asserted here as a belt-and-suspenders defence in case a future
    // entry point forgets it.
    function deleteIssue(id) {
        const issue = currentSiteIssues.find(i => i.id === id);
        if (!issue) return;
        const isCreator = !!(issue.createdBy && cachedUsername && issue.createdBy === cachedUsername);
        // v0.7: anyone can delete a local-only issue regardless of token
        // state — they're throwaway entries with no real owner.
        const isLocalOnly = (issue.createdBy === 'local-only');
        if (!isCreator && !isLocalOnly) {
            showToast(`Only @${issue.createdBy} can delete this issue.`, 4500);
            return;
        }
        // Drop visual layers
        const map = getLeafletMap();
        const layers = issueLayers.get(id);
        if (layers && map) {
            try { if (layers.polygon) map.removeLayer(layers.polygon); } catch (e) {}
            try { if (layers.marker)  map.removeLayer(layers.marker);  } catch (e) {}
        }
        issueLayers.delete(id);
        hiddenIds.delete(id);

        // v0.25: TOMBSTONE for synced issues. Removing-and-committing didn't
        // survive: Tab 2 (with the issue still present in its stale local
        // state) would race and re-upload it during a 409 retry. Tombstones
        // make delete a state CHANGE not a state REMOVAL — survives merges
        // via delete-wins. Local-only issues never sync so we just yank
        // them outright (no tombstone needed).
        if (isLocalOnly) {
            currentSiteIssues = currentSiteIssues.filter(i => i.id !== id);
            saveIssuesToStorage(siteID, currentSiteIssues);
            renderButtonState();
            console.log(`${TAG} deleted local-only issue ${id}`);
            showToast('Local-only issue deleted (not synced to GitHub).', 3000);
            return;
        }
        // Mark in place — preserves the entry for distributed-sync safety.
        const nowIso = new Date().toISOString();
        const by = cachedUsername || 'local-only';
        issue.deleted = true;
        issue.deletedAt = nowIso;
        issue.deletedBy = by;
        // Append a history entry too so the audit log shows the deletion
        // (matches our pattern of preserving every action in history[]).
        if (!Array.isArray(issue.history)) issue.history = [];
        issue.history.push({
            at: nowIso,
            by,
            fromStatus: issue.status || 'open',
            toStatus: 'deleted',
            note: '(deleted)',
        });
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderButtonState();
        console.log(`${TAG} tombstoned issue ${id} by @${by}`);
        if (cachedToken) {
            showToast('Issue deleted — pushing to GitHub…', 2500);
            commitIssuesToGitHub(`tombstone issue by @${by}`);
            // v1.05: log the deletion in the issue's Slack thread.
            postSlackDelete(issue, by);
        } else {
            showToast('Issue deleted locally (no GitHub token).', 3000);
        }
    }

    // v0.25: helper. Filters tombstoned issues from any list before render.
    function liveIssues(list) {
        return (list || []).filter(i => i && !i.deleted);
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

    // v0.4: render-retry loop. Without this, the first render kicked off
    // by setCurrentSite-from-init runs BEFORE Leaflet mounts the iframe map.
    // getLeafletMap returns null, renderOneIssue silently no-ops, and
    // nothing appears until the user toggles a Control Panel setting (which
    // re-fires renderAllIssues after the map is ready). With retries baked
    // in, the first explicit call polls every 500ms (up to ~15s) until the
    // map appears, then renders. Any new explicit call resets the budget.
    let renderRetryTimer = null;
    // v0.22: bumped from 30 → 60 (15s → 30s budget). User hit "gave up
    // after 30 tries" on a slow load with concurrent Map Styler kick;
    // 30s gives Leaflet a more comfortable window to materialize.
    const RENDER_MAX_RETRIES = 60;
    const RENDER_RETRY_MS = 500;

    function renderAllIssues() {
        if (renderRetryTimer) { clearTimeout(renderRetryTimer); renderRetryTimer = null; }
        renderAllIssuesAttempt(0);
    }

    function renderAllIssuesAttempt(attempt) {
        renderRetryTimer = null;
        clearIssueLayers();
        if (!masterEnabled) return;
        // v0.25: skip tombstoned issues entirely
        const live = liveIssues(currentSiteIssues);
        if (live.length === 0) return;
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L) {
            if (attempt < RENDER_MAX_RETRIES) {
                renderRetryTimer = setTimeout(() => renderAllIssuesAttempt(attempt + 1), RENDER_RETRY_MS);
            } else {
                console.warn(`${TAG} renderAllIssues gave up — Leaflet map never appeared after ${attempt} tries`);
            }
            return;
        }
        if (attempt > 0) {
            console.log(`${TAG} renderAllIssues: map ready after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
        }
        ensureCustomPanes(map);
        live.forEach((issue) => {
            renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        });
        // v1.06: if we arrived via a ?aim_issue=<id> deep-link, focus it now
        // that the issue + map are ready.
        maybeFocusPendingIssue();
    }

    // v0.8: create high-z-index panes so issue shapes + markers sit on top
    // of Percepto's own markers (entities, FFZs, etc.). Without this, M2 on
    // an issue marker positioned over an asset triggers Percepto's M2 menu
    // instead. Default Leaflet pane z-indexes: overlayPane=400, markerPane=600,
    // tooltipPane=650, popupPane=700. We use 750/800 to sit above all of
    // them. Idempotent — gated by a per-map flag.
    function ensureCustomPanes(map) {
        if (!map || map._aim_issues_panes_created) return;
        try {
            if (typeof map.createPane !== 'function') return;
            const polyPane = map.createPane('aim-issues-polygons');
            if (polyPane) { polyPane.style.zIndex = 750; polyPane.style.pointerEvents = 'auto'; }
            const markerPane = map.createPane('aim-issues-markers');
            if (markerPane) { markerPane.style.zIndex = 800; markerPane.style.pointerEvents = 'auto'; }
            const tooltipPane = map.createPane('aim-issues-tooltips');
            if (tooltipPane) { tooltipPane.style.zIndex = 850; tooltipPane.style.pointerEvents = 'none'; }
            map._aim_issues_panes_created = true;
            console.log(`${TAG} created custom panes (polygons z750, markers z800, tooltips z850)`);
        } catch (e) {
            console.warn(`${TAG} ensureCustomPanes failed:`, e);
        }
    }

    function unhideAllNonResolved() {
        if (hiddenIds.size === 0) {
            showToast('Nothing to un-hide.', 2000);
            return;
        }
        let unhid = 0;
        let kept = 0;
        const toUnhide = [];
        hiddenIds.forEach(id => {
            const issue = currentSiteIssues.find(i => i.id === id);
            // If the underlying issue no longer exists, drop the hide.
            if (!issue) { toUnhide.push(id); return; }
            // Resolved + ignored stay hidden — they're meant to be background.
            if (issue.status === 'resolved' || issue.status === 'ignored') { kept++; return; }
            toUnhide.push(id);
        });
        toUnhide.forEach(id => { hiddenIds.delete(id); unhid++; });
        renderAllIssues();
        renderButtonState();
        if (unhid === 0) {
            showToast(`No active issues hidden (${kept} resolved/ignored stay hidden).`, 3000);
        } else {
            showToast(
                `Un-hid ${unhid} issue${unhid === 1 ? '' : 's'}${kept > 0 ? ` (${kept} resolved/ignored stay hidden)` : ''}.`,
                3500);
        }
    }

    function centroidOfLatLngs(latlngs) {
        if (!latlngs || !latlngs.length) return null;
        let sLat = 0, sLng = 0;
        latlngs.forEach(p => { sLat += p[0]; sLng += p[1]; });
        return [sLat / latlngs.length, sLng / latlngs.length];
    }

    // v0.23: arithmetic centroid falls OUTSIDE concave polygons (L-shapes,
    // C-shapes, etc.) — user reported the issue icon landing outside the
    // polygon. Better: pole-of-inaccessibility — the interior point that
    // is maximally distant from every edge. Simple grid-search variant
    // since our polygons are small (4-100 vertices). Falls back to:
    //   1. arithmetic centroid if it's inside the polygon
    //   2. grid-search best interior point
    //   3. first vertex if grid search finds nothing inside (degenerate)
    function pointToSegDistSq(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const cx = x1 + t * dx, cy = y1 + t * dy;
        return (px - cx) * (px - cx) + (py - cy) * (py - cy);
    }

    function bestInteriorPoint(polygon) {
        if (!polygon || polygon.length < 3) return centroidOfLatLngs(polygon);
        // 1. arithmetic centroid if it's inside the polygon — fastest, ideal
        //    for convex shapes (the common case).
        const centroid = centroidOfLatLngs(polygon);
        if (centroid && pointInPolygon(centroid[0], centroid[1], polygon)) {
            return centroid;
        }
        // 2. grid search: 20x20 candidates in the bounding box, pick the
        //    interior point with the maximum distance to the nearest edge.
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        for (const p of polygon) {
            if (p[0] < minLat) minLat = p[0];
            if (p[0] > maxLat) maxLat = p[0];
            if (p[1] < minLng) minLng = p[1];
            if (p[1] > maxLng) maxLng = p[1];
        }
        const N = 20;
        let bestPoint = null, bestDistSq = -1;
        for (let i = 1; i < N; i++) {
            for (let j = 1; j < N; j++) {
                const lat = minLat + (maxLat - minLat) * (i / N);
                const lng = minLng + (maxLng - minLng) * (j / N);
                if (!pointInPolygon(lat, lng, polygon)) continue;
                let minDistSq = Infinity;
                for (let k = 0; k < polygon.length; k++) {
                    const a = polygon[k], b = polygon[(k + 1) % polygon.length];
                    const d = pointToSegDistSq(lat, lng, a[0], a[1], b[0], b[1]);
                    if (d < minDistSq) minDistSq = d;
                }
                if (minDistSq > bestDistSq) {
                    bestDistSq = minDistSq;
                    bestPoint = [lat, lng];
                }
            }
        }
        // 3. degenerate (very thin sliver) → first vertex
        return bestPoint || (polygon[0] ? [polygon[0][0], polygon[0][1]] : null);
    }

    // ------- Affected-entity detection (v0.17 — Phase 5b) -------
    //
    // Percepto's /map_objects endpoint returns the site's entity list. We
    // fetch our own copy (cookie auth, same shape Asset Inspector uses)
    // and run point-in-polygon for each entity against each issue's
    // polygon to compute "what's affected". Results cached per issue id;
    // cache invalidated when entities refresh.
    //
    // Entity type codes (per Asset Inspector):
    //   3  = Asset (polygon)
    //   4  = NFZ (polygon)
    //   15 = Flight Path (polyline)
    //   16 = FFZ (polygon)
    //   19 = General Marker (point)
    const ENTITY_TYPE_META = {
        3:  { label: 'Asset',       short: 'AST', color: '#ffffff' },
        4:  { label: 'NFZ',         short: 'NFZ', color: '#ff4d4d' },
        15: { label: 'Flight Path', short: 'FP',  color: '#1ca0de' },
        16: { label: 'FFZ',         short: 'FFZ', color: '#5fff5f' },
        19: { label: 'Marker',      short: 'GM',  color: '#a855f7' },
    };

    async function fetchSiteEntities(sid) {
        if (!sid) return;
        if (mapObjects && mapObjects.siteID === sid) return;
        if (mapObjectsFetching) return;
        mapObjectsFetching = true;
        try {
            const url = MAP_OBJECTS_URL + encodeURIComponent(sid);
            const r = await fetch(url, { credentials: 'same-origin' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            if (!Array.isArray(data)) throw new Error('response not an array');
            mapObjects = { siteID: sid, entities: data };
            issueAffectedCache.clear();
            console.log(`${TAG} fetched ${data.length} entities for affected-entity detection on site ${sid}`);
            // Refresh anything that displays counts
            if (panelEl) renderIssuesPanel();
            // Tooltips re-bind on next render anyway; status modal is one-shot.
        } catch (e) {
            console.warn(`${TAG} fetchSiteEntities failed for site ${sid}:`, e);
        } finally {
            mapObjectsFetching = false;
        }
    }

    // Standard ray-casting point-in-polygon. polygon is [[lat,lng], ...].
    // Returns true if (lat, lng) is inside the closed polygon.
    function pointInPolygon(lat, lng, polygon) {
        if (!polygon || polygon.length < 3) return false;
        let inside = false;
        const n = polygon.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = polygon[i][1], yi = polygon[i][0];
            const xj = polygon[j][1], yj = polygon[j][0];
            const intersect = ((yi > lat) !== (yj > lat))
                && (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // For each entity, "affected" means at least one of its vertices /
    // arc endpoints / center sits inside the issue polygon. Doesn't catch
    // the rare case where the entity surrounds the issue without any
    // vertex inside — uncommon for typical issue rectangles.
    function affectedEntitiesFor(issue) {
        if (!issue || !Array.isArray(issue.polygon) || issue.polygon.length < 3) return [];
        if (issueAffectedCache.has(issue.id)) return issueAffectedCache.get(issue.id);
        const out = [];
        if (!mapObjects || mapObjects.siteID !== siteID || !Array.isArray(mapObjects.entities)) {
            return out;
        }
        const poly = issue.polygon;
        for (const e of mapObjects.entities) {
            if (!e || typeof e.type !== 'number') continue;
            let hit = false;
            if (e.type === 3 || e.type === 4 || e.type === 16) {
                // Polygon entities — any vertex inside
                if (Array.isArray(e.coords)) {
                    for (const c of e.coords) {
                        if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)
                            && pointInPolygon(c.lat, c.lng, poly)) { hit = true; break; }
                    }
                }
            } else if (e.type === 15) {
                // Flight path — any arc endpoint or coord vertex inside
                if (Array.isArray(e.arcs)) {
                    for (const a of e.arcs) {
                        if (!a) continue;
                        if (a.point_a && pointInPolygon(a.point_a.lat, a.point_a.lng, poly)) { hit = true; break; }
                        if (a.point_b && pointInPolygon(a.point_b.lat, a.point_b.lng, poly)) { hit = true; break; }
                    }
                }
                if (!hit && Array.isArray(e.coords)) {
                    for (const c of e.coords) {
                        if (c && pointInPolygon(c.lat, c.lng, poly)) { hit = true; break; }
                    }
                }
            } else if (e.type === 19) {
                if (Array.isArray(e.coords) && e.coords[0]) {
                    if (pointInPolygon(e.coords[0].lat, e.coords[0].lng, poly)) hit = true;
                }
            }
            if (hit) {
                out.push({
                    id: e._id || e.id || String(out.length),
                    name: e.name || '(unnamed)',
                    type: e.type,
                    typeLabel: (ENTITY_TYPE_META[e.type] || { label: String(e.type) }).label,
                    typeShort: (ENTITY_TYPE_META[e.type] || { short: '?' }).short,
                    typeColor: (ENTITY_TYPE_META[e.type] || { color: '#aaa' }).color,
                    subtype: e.poi_type_str || e.subtype || '',
                });
            }
        }
        // Sort: by type then by name
        out.sort((a, b) => (a.type - b.type) || a.name.localeCompare(b.name));
        issueAffectedCache.set(issue.id, out);
        return out;
    }

    // ------- v0.18: entity-pill helpers (copy + find-in-sidebar) -------
    //
    // Same sidebar-paste mechanic Asset Inspector uses (latest/, line 1254).
    // Duplicated here so Issues works even when Asset Inspector isn't
    // installed — Issues stands on its own. The React-aware value setter
    // is required because Percepto's sidebar input is a controlled React
    // component; plain input.value = ... doesn't fire onChange.

    const SIDEBAR_INPUT_SELECTOR = 'input.ant-input[placeholder="Search entity"]';

    function copyTextToClipboard(text) {
        if (!text) return Promise.reject(new Error('empty'));
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text);
            }
        } catch (e) {}
        // Fallback for non-clipboard browsers
        return new Promise((resolve, reject) => {
            try {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus(); ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                ok ? resolve() : reject(new Error('execCommand failed'));
            } catch (e) { reject(e); }
        });
    }

    function findSidebarInput() {
        let input = document.querySelector(SIDEBAR_INPUT_SELECTOR);
        if (input) return input;
        try {
            input = window.top && window.top.document
                ? window.top.document.querySelector(SIDEBAR_INPUT_SELECTOR)
                : null;
            if (input) return input;
            const frames = Array.from((window.top && window.top.document) ? window.top.document.querySelectorAll('iframe') : []);
            for (const f of frames) {
                try {
                    const fi = f.contentDocument && f.contentDocument.querySelector(SIDEBAR_INPUT_SELECTOR);
                    if (fi) return fi;
                } catch (e) {}
            }
        } catch (e) {}
        return null;
    }

    function findEntityInSidebar(name) {
        if (!name) return false;
        const input = findSidebarInput();
        if (!input) {
            showToast('Map Entities search input not found — open the sidebar first.', 4500);
            return false;
        }
        try {
            const proto = window.HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) descriptor.set.call(input, name);
            else input.value = name;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            try { input.focus(); } catch (e) {}
            const inputDoc = input.ownerDocument || document;
            const matchLower = name.trim().toLowerCase();
            setTimeout(() => {
                let target = null;
                const items = inputDoc.querySelectorAll('.map-entities__entity-item');
                for (const item of items) {
                    const txt = (item.textContent || '').trim().toLowerCase();
                    if (txt.includes(matchLower)) { target = item; break; }
                }
                if (!target && items.length === 1) target = items[0];
                if (target) {
                    try {
                        // Dispatch a real-looking pointerdown+up+click so React
                        // sees it. Plain .click() works for most but not all
                        // virtualized rows.
                        const rect = target.getBoundingClientRect();
                        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
                        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => {
                            target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
                        });
                    } catch (e) { try { target.click(); } catch (e2) {} }
                    showToast(`Opened "${name}" in sidebar.`, 2500);
                } else {
                    showToast(`Sidebar filtered to "${name}" — click the result to open.`, 4000);
                }
            }, 300);
            return true;
        } catch (e) {
            console.warn(`${TAG} findEntityInSidebar failed:`, e);
            return false;
        }
    }

    // v0.18: per-issue expansion state for the panel's affected-entities list
    const expandedIssueIds = new Set();

    // ------- v0.19: Google Sheets / Excel export -------
    //
    // Writes the panel's currently-visible issues as a formatted HTML
    // table to the clipboard, alongside a TSV plain-text fallback.
    // Sheets/Excel pick up text/html → cells inherit our background
    // colors + inline line breaks. Pattern matches Asset Inspector's
    // copyStatsAsSheet (latest/, line 7388).

    function buildIssuesHtmlForSheets(issues, siteId, siteName_) {
        // Inline-styled table — Sheets/Excel honor most inline CSS.
        // v0.28: + Priority + Comment Count columns
        const headers = [
            'Status', 'Priority', 'Note', 'Created', 'By', 'Assignee',
            'Last Event', 'Last Event When', 'Last Event By',
            'Comments #', 'Affects #', 'Affected Entities', 'Full History',
            'Issue ID', 'Site ID', 'Site Name',
        ];
        const out = [];
        out.push('<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px">');
        // Header row
        out.push('<thead><tr>');
        headers.forEach(h => {
            out.push(`<th style="background:#14171b;color:#ffffff;font-weight:bold;text-align:left;padding:8px 10px;border:1px solid #444">${escHtml(h)}</th>`);
        });
        out.push('</tr></thead>');
        out.push('<tbody>');
        issues.forEach(issue => {
            const status = issue.status || 'open';
            const meta = STATUS_LABEL[status] || { text: status.toUpperCase(), color: '#888' };
            const statusFg = (status === 'ready-for-review' || status === 'resolved') ? '#000000' : '#ffffff';
            const lastH = (issue.history && issue.history.length) ? issue.history[issue.history.length - 1] : null;
            const lastEventLabel_ = lastEventLabel(issue);
            const lastEventWhen = lastH ? fmtDateTime(lastH.at) : fmtDateTime(issue.createdAt);
            const lastEventBy = lastH ? (lastH.by || '?') : (issue.createdBy || '?');
            const createdWhen = fmtDateTime(issue.createdAt);
            const createdBy = issue.createdBy || '?';
            const affected = affectedEntitiesFor(issue);
            const affectedCount = affected.length;
            const affectedList = affected.map(a => `${a.typeShort} ${a.name}${a.subtype ? ' (' + a.subtype + ')' : ''}`).join('<br>');
            // v0.28: comment count + priority cells
            const commentCount = (issue.history || []).filter(h =>
                h.kind === 'comment' || (h.fromStatus && h.fromStatus === h.toStatus && h.kind !== 'priority')
            ).length;
            const priM = issue.priority ? priorityMeta(issue.priority) : null;
            const histText = (issue.history || []).map(h => {
                const note = h.note ? ' — "' + h.note + '"' : '';
                let trans;
                if (h.kind === 'priority' || h.toPriority !== undefined) {
                    trans = `priority: ${h.fromPriority || 'NONE'} → ${h.toPriority || 'NONE'}`;
                } else if (!h.fromStatus) trans = `created (${h.toStatus})`;
                else if (h.toStatus === 'deleted') trans = `deleted`;
                else if (h.kind === 'assign') trans = h.toAssignee ? `assigned → @${h.toAssignee}` : `unassigned`;
                else if (h.kind === 'comment' || h.fromStatus === h.toStatus) trans = `comment`;
                else trans = `${h.fromStatus} → ${h.toStatus}`;
                return `[${fmtDateTime(h.at)}] @${h.by}: ${trans}${note}`;
            }).join('<br>');
            out.push('<tr>');
            out.push(`<td style="background:${meta.color};color:${statusFg};font-weight:bold;padding:6px 10px;border:1px solid #444;vertical-align:top">${escHtml(meta.text)}</td>`);
            if (priM) {
                out.push(`<td style="background:${priM.color};color:${priM.textColor};font-weight:bold;padding:6px 10px;border:1px solid #444;vertical-align:top;text-align:center">${escHtml(priM.text)}</td>`);
            } else {
                out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top;text-align:center;color:#999"><i>—</i></td>`);
            }
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top">${escHtml(issue.note)}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top;white-space:nowrap">${escHtml(createdWhen)}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top">@${escHtml(createdBy)}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top">${issue.assignee ? '@' + escHtml(issue.assignee) : '<i style="color:#999">—</i>'}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top;font-weight:bold;color:${meta.color}">${escHtml(lastEventLabel_)}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top;white-space:nowrap">${escHtml(lastEventWhen)}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top">@${escHtml(lastEventBy)}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top;text-align:center;font-weight:bold">${commentCount}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top;text-align:center;font-weight:bold">${affectedCount}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top">${affectedList || '<i style="color:#888">(none)</i>'}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top;font-size:11px">${histText}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top;font-family:monospace;font-size:10px;color:#888">${escHtml(issue.id)}</td>`);
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top">${escHtml(siteId)}</td>`);
            // v0.29: Site Name is a link to the site-setup URL. Sheets +
            // Excel both honor <a href> in pasted HTML — cell becomes
            // clickable, displays the name as link text.
            const siteUrl = siteId ? `https://percepto.app/#/site/${encodeURIComponent(siteId)}/control-panel/site-setup` : '';
            const siteNameCell = (siteName_ && siteUrl)
                ? `<a href="${siteUrl}" style="color:#1a73e8;text-decoration:underline">${escHtml(siteName_)}</a>`
                : escHtml(siteName_ || '');
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top">${siteNameCell}</td>`);
            out.push('</tr>');
        });
        out.push('</tbody></table>');
        return out.join('');
    }

    function buildIssuesTsv(issues, siteId, siteName_) {
        const headers = [
            'Status', 'Priority', 'Note', 'Created', 'By', 'Assignee',
            'Last Event', 'Last Event When', 'Last Event By',
            'Comments #', 'Affects #', 'Affected Entities', 'Full History',
            'Issue ID', 'Site ID', 'Site Name',
        ];
        const lines = [headers.join('\t')];
        const safe = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ');
        issues.forEach(issue => {
            const status = issue.status || 'open';
            const meta = STATUS_LABEL[status] || { text: status.toUpperCase() };
            const lastH = (issue.history && issue.history.length) ? issue.history[issue.history.length - 1] : null;
            const lastEventWhen = lastH ? fmtDateTime(lastH.at) : fmtDateTime(issue.createdAt);
            const lastEventBy = lastH ? (lastH.by || '?') : (issue.createdBy || '?');
            const affected = affectedEntitiesFor(issue);
            const affectedList = affected.map(a => `${a.typeShort} ${a.name}${a.subtype ? ' (' + a.subtype + ')' : ''}`).join(' | ');
            const commentCount = (issue.history || []).filter(h =>
                h.kind === 'comment' || (h.fromStatus && h.fromStatus === h.toStatus && h.kind !== 'priority')
            ).length;
            const priLabel = issue.priority ? priorityMeta(issue.priority).text : '';
            const histText = (issue.history || []).map(h => {
                const note = h.note ? ' — "' + h.note + '"' : '';
                let trans;
                if (h.kind === 'priority' || h.toPriority !== undefined) {
                    trans = `priority: ${h.fromPriority || 'NONE'} → ${h.toPriority || 'NONE'}`;
                } else if (!h.fromStatus) trans = `created (${h.toStatus})`;
                else if (h.toStatus === 'deleted') trans = `deleted`;
                else if (h.kind === 'assign') trans = h.toAssignee ? `assigned → @${h.toAssignee}` : `unassigned`;
                else if (h.kind === 'comment' || h.fromStatus === h.toStatus) trans = `comment`;
                else trans = `${h.fromStatus} → ${h.toStatus}`;
                return `[${fmtDateTime(h.at)}] @${h.by}: ${trans}${note}`;
            }).join(' | ');
            lines.push([
                meta.text,
                priLabel,
                issue.note,
                fmtDateTime(issue.createdAt),
                '@' + (issue.createdBy || '?'),
                issue.assignee ? '@' + issue.assignee : '',
                lastEventLabel(issue),
                lastEventWhen,
                '@' + lastEventBy,
                String(commentCount),
                String(affected.length),
                affectedList,
                histText,
                issue.id,
                siteId,
                siteName_ || '',
            ].map(safe).join('\t'));
        });
        return lines.join('\n');
    }

    async function copyIssuesToSheets(issues, siteId, siteName_) {
        if (!issues || issues.length === 0) {
            showToast('Nothing to export — no issues match current filters.', 3000);
            return;
        }
        const html = buildIssuesHtmlForSheets(issues, siteId, siteName_);
        const tsv = buildIssuesTsv(issues, siteId, siteName_);
        try {
            if (navigator.clipboard && window.ClipboardItem) {
                const item = new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([tsv], { type: 'text/plain' }),
                });
                await navigator.clipboard.write([item]);
                showToast(`Copied ${issues.length} issue${issues.length === 1 ? '' : 's'} — paste into Google Sheets / Excel`, 3500);
                return;
            }
        } catch (e) {
            console.warn(`${TAG} ClipboardItem write failed, falling back:`, e);
        }
        // Fallback: select a hidden HTML node + execCommand('copy')
        try {
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            tmp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
            document.body.appendChild(tmp);
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(tmp);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('copy');
            sel.removeAllRanges();
            document.body.removeChild(tmp);
            showToast(`Copied ${issues.length} issue${issues.length === 1 ? '' : 's'} — paste into Google Sheets / Excel`, 3500);
        } catch (e) {
            console.error(`${TAG} Sheets fallback also failed:`, e);
            copyTextToClipboard(tsv).then(() =>
                showToast('Copied as plain TSV (HTML clipboard unavailable)', 3500)
            ).catch(() =>
                showToast('Export failed — see console.', 3500)
            );
        }
    }

    function styleForStatus(status) {
        switch (status) {
            // v1.00: pending_fix = yellow (gold), pending_ignore = purple.
            case 'pending_fix':
                return { color: '#FFD700', fill: '#FFD700', fillOpacity: 0.20, dashArray: '10,6', weight: 3 };
            case 'pending_ignore':
                return { color: '#8000FF', fill: '#8000FF', fillOpacity: 0.20, dashArray: '10,6', weight: 3 };
            case 'ready-for-review':   // legacy
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
            case 'pending_fix':      return { glyph: '⏳', color: '#FFD700' };
            case 'pending_ignore':   return { glyph: '⏳', color: '#8000FF' };
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
        // v0.22: ensureCustomPanes was only called by renderAllIssues, but
        // createIssue calls renderOneIssue DIRECTLY. Result: first-issue
        // creation on a fresh site fails — `pane: 'aim-issues-markers'` is
        // passed to L.marker, then marker.addTo blows up in _initIcon
        // because the pane was never registered on this map. Idempotent
        // (gated by map._aim_issues_panes_created).
        ensureCustomPanes(map);
        // Wipe any prior layers for this id (re-renders are idempotent)
        const prior = issueLayers.get(issue.id);
        if (prior) {
            try { if (prior.polygon) map.removeLayer(prior.polygon); } catch (e) {}
            try { if (prior.marker)  map.removeLayer(prior.marker);  } catch (e) {}
        }
        const st = styleForStatus(issue.status);
        const icoMeta = iconForStatus(issue.status);
        // v0.3: stroke weight + opacities are user-tunable via Control Panel.
        // Status only drives color + dash pattern; size/opacity are global.
        const vWeight  = Number(getT('render.visible-weight'))  || 3;
        const vOpacity = Number(getT('render.visible-opacity')) || 0.95;
        const vFill    = Number(getT('render.visible-fill'))    || 0.15;
        const hOpacity = Number(getT('render.hidden-opacity'))  || 0.25;
        const hFill    = Number(getT('render.hidden-fill'))     || 0.04;
        const hWeight  = Number(getT('render.hidden-weight'))   || 1.5;
        // v0.8: pane: 'aim-issues-polygons' (z-index 750) makes the SVG
        // sit above Percepto's overlay layers but below issue markers.
        // Falls back to default overlayPane if our custom pane wasn't
        // created (unlikely but defensive).
        const polyPane = (map.getPane && map.getPane('aim-issues-polygons')) ? 'aim-issues-polygons' : undefined;
        // v0.11: polygon is ALWAYS click-through. The icon is the only
        // interactive surface — that lets users right-click entities under
        // the issue box without the box swallowing the event. Tooltip and
        // click handlers move to the icon only.
        const polygonOpts = {
            color: st.color,
            weight: isHidden ? hWeight : vWeight,
            opacity: isHidden ? hOpacity : vOpacity,
            dashArray: st.dashArray,
            fillColor: st.fill,
            fillOpacity: isHidden ? hFill : vFill,
            interactive: false,
            bubblingMouseEvents: false,
            pane: polyPane,
        };
        const polygon = L.polygon(issue.polygon, polygonOpts);
        const ttPane = (map.getPane && map.getPane('aim-issues-tooltips')) ? 'aim-issues-tooltips' : undefined;
        polygon.addTo(map);
        // Force pointer-events:none on the SVG path — interactive:false
        // alone isn't enough on every Leaflet renderer path. This is what
        // lets M2 reach Percepto entities under the polygon area.
        if (polygon._path) {
            try { polygon._path.style.pointerEvents = 'none'; } catch (e) {}
        }

        // v0.23: bestInteriorPoint (pole-of-inaccessibility variant) instead
        // of arithmetic centroid — guarantees the icon lands INSIDE the
        // polygon even for L-shapes / C-shapes / concave outlines.
        const c = bestInteriorPoint(issue.polygon);
        let marker = null;
        // v0.21: wrap marker code in try/catch. A coworker hit "polygon
        // renders but icon doesn't" — meant something in here threw silently
        // and aborted both the marker AND the modal close (createIssue
        // never reached the post-render lines). With this try, the polygon
        // at least gets registered + we get a console error to diagnose
        // the specific failure if it happens again.
        try { if (c) {
            const vMarker = Number(getT('render.visible-marker-size')) || 26;
            const hMarker = Number(getT('render.hidden-marker-size')) || 20;
            const markerOpacity = isHidden ? 0.45 : 1;
            const markerSize = isHidden ? hMarker : vMarker;
            const fontSize = Math.max(9, Math.round(markerSize * 0.55));
            const borderWidth = isHidden ? 1 : 2;
            // v1.00: green ? pulsing badge when the user hasn't seen the
            // latest events on this issue. unseenHistoryFor excludes the
            // user's own actions — only OTHERS' activity triggers it.
            const unseen = unseenHistoryFor(issue);
            const activityBadge = unseen.length > 0 ? `
                <span class="aim-issues-activity-dot"
                      title="${escHtml(`${unseen.length} new event${unseen.length === 1 ? '' : 's'} since you last opened — open to dismiss`)}"
                      style="position:absolute;top:-5px;right:-5px;
                             width:14px;height:14px;border-radius:50%;
                             background:#00FF7F;color:#000;
                             display:flex;align-items:center;justify-content:center;
                             font-size:10px;font-weight:900;line-height:1;
                             border:1.5px solid rgba(0,0,0,0.65);
                             pointer-events:none;z-index:2">?</span>
            ` : '';
            // v0.11: data-issue-id lets other AIM scripts (notably Asset
            // Inspector with its window-capture contextmenu handler) detect
            // an issue icon and bail before they steal the click. Class
            // .aim-issues-icon-marker is also a selector for the same purpose.
            const divIcon = L.divIcon({
                className: 'aim-issues-icon-marker',
                html: `<div data-issue-id="${issue.id}" style="
                    position:relative;
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
                ">${icoMeta.glyph}${activityBadge}</div>`,
                iconSize: [markerSize, markerSize],
                iconAnchor: [markerSize / 2, markerSize / 2],
            });
            const markerPane = (map.getPane && map.getPane('aim-issues-markers')) ? 'aim-issues-markers' : undefined;
            marker = L.marker(c, { icon: divIcon, interactive: true, bubblingMouseEvents: false, pane: markerPane });
            marker.bindTooltip(buildTooltipHtml(issue, { isHidden }), {
                direction: 'top',
                offset: L.point(0, -8),
                className: 'aim-issues-tooltip',
                pane: ttPane,
            });
            // v0.11: stopImmediatePropagation on the originalEvent — without
            // it, Percepto's own contextmenu listener (attached at document
            // or window level) fires alongside ours and pops its asset menu
            // even when the user clicked the issue icon. L.DomEvent.stopPropagation
            // alone only stops Leaflet's internal propagation, not native DOM.
            const swallow = (ev) => {
                try { L.DomEvent.stopPropagation(ev); } catch (e) {}
                const oe = ev.originalEvent;
                if (oe) {
                    try { oe.preventDefault(); } catch (e) {}
                    try { oe.stopPropagation(); } catch (e) {}
                    try {
                        if (typeof oe.stopImmediatePropagation === 'function') oe.stopImmediatePropagation();
                    } catch (e) {}
                }
            };
            marker.on('click', (ev) => {
                swallow(ev);
                toggleSessionHide(issue.id);
            });
            marker.on('contextmenu', (ev) => {
                swallow(ev);
                openStatusModal(issue);
            });
            marker.addTo(map);
        } } catch (e) {
            console.error(`${TAG} marker render failed for issue ${issue.id}:`, e);
            marker = null;
        }
        issueLayers.set(issue.id, { polygon, marker });
    }

    // v0.14: describe the LAST event in the issue's history, not the
    // current status. So a resolved issue that was just re-opened says
    // "Re-opened" not "Open", and a freshly-created issue says "Open"
    // (its creation). Color matches the destination status so the header
    // reflects what state the issue is now in.
    function lastEventLabel(issue) {
        const hist = (issue && issue.history) || [];
        if (hist.length === 0) {
            return (STATUS_LABEL[issue.status || 'open'] || { text: 'OPEN' }).text;
        }
        const last = hist[hist.length - 1];
        // v0.28: comment + priority kinds
        if (last.kind === 'priority' || last.toPriority !== undefined) {
            const toP = last.toPriority ? priorityMeta(last.toPriority).text : 'NONE';
            return `Priority → ${toP}`;
        }
        if (last.kind === 'comment' || (last.fromStatus && last.fromStatus === last.toStatus)) {
            return `💬 Commented`;
        }
        if (!last.fromStatus) {
            return (STATUS_LABEL[last.toStatus] || { text: (last.toStatus || 'open').toUpperCase() }).text;
        }
        if (last.toStatus === 'deleted') return 'Deleted';
        // Transition — describe semantically
        const key = `${last.fromStatus}|${last.toStatus}`;
        const map = {
            // v1.00 flow
            'open|pending_fix':         'Proposed Fix',
            'open|pending_ignore':      'Proposed Ignore',
            'pending_fix|resolved':     'Approved Fix',
            'pending_fix|open':         'Rejected Fix',
            'pending_ignore|ignored':   'Approved Ignore',
            'pending_ignore|open':      'Rejected Ignore',
            'open|resolved':            'Resolved (direct)',
            'open|ignored':             'Ignored (direct)',
            'resolved|open':            'Re-opened',
            'ignored|open':             'Un-ignored',
            // Legacy
            'open|ready-for-review':    'Ready for Review',
            'ready-for-review|resolved': 'Resolved',
            'ready-for-review|open':    'Rejected',
        };
        return map[key] || (STATUS_LABEL[last.toStatus] || { text: (last.toStatus || '').toUpperCase() }).text;
    }

    function lastEventAt(issue) {
        const hist = (issue && issue.history) || [];
        if (hist.length === 0) return issue.createdAt;
        return hist[hist.length - 1].at;
    }

    // v1.00: one-line summary of a history entry for use in tooltips +
    // activity-indicator hovers. HTML-safe.
    function describeHistEntry(h) {
        if (!h) return '';
        const by = (h.by || '?').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const note = h.note ? `: <i>"${(h.note).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}"</i>` : '';
        if (h.kind === 'priority' || h.toPriority !== undefined) {
            const toP = h.toPriority ? priorityMeta(h.toPriority).text : 'NONE';
            const toMeta = h.toPriority ? priorityMeta(h.toPriority) : { color: '#888' };
            return `<b>@${by}</b> set priority → <span style="color:${toMeta.color}">${toP}</span>${note}`;
        }
        if (h.kind === 'comment' || (h.fromStatus && h.fromStatus === h.toStatus)) {
            return `💬 <b>@${by}</b> commented${note}`;
        }
        if (!h.fromStatus) {
            return `<b>@${by}</b> created${note}`;
        }
        if (h.toStatus === 'deleted') return `🗑 <b>@${by}</b> deleted`;
        const fromMeta = STATUS_LABEL[h.fromStatus] || { text: (h.fromStatus || '').toUpperCase(), color: '#aaa' };
        const toMeta = STATUS_LABEL[h.toStatus] || { text: (h.toStatus || '').toUpperCase(), color: '#aaa' };
        return `<b>@${by}</b>: <span style="color:${fromMeta.color}">${fromMeta.text}</span> → <span style="color:${toMeta.color}">${toMeta.text}</span>${note}`;
    }

    function buildTooltipHtml(issue, opts) {
        opts = opts || {};
        const safeNote = (issue.note || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const safeBy = (issue.createdBy || '?').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        // v0.14: header text + age describe the LAST transition, not
        // current status. Color reflects the destination status so the
        // tooltip header matches the icon color.
        const headerLabel = lastEventLabel(issue);
        const age = relativeAge(lastEventAt(issue));
        const headerColor = (STATUS_LABEL[issue.status || 'open'] || { color: '#ff8585' }).color;
        const hideHint = opts.isHidden
            ? '<span style="color:#5fff5f;font-weight:700">HIDDEN</span> &middot; M1 to un-hide &middot; M2 = change status'
            : 'M1 = hide &middot; M2 = change status';
        // v0.17: affected-entities count + type breakdown
        let affectsHtml = '';
        const affected = affectedEntitiesFor(issue);
        if (affected.length > 0) {
            // Tally per type for the compact summary
            const byType = {};
            affected.forEach(a => { byType[a.typeShort] = (byType[a.typeShort] || 0) + 1; });
            const parts = Object.keys(byType).map(t => {
                const meta = Object.values(ENTITY_TYPE_META).find(m => m.short === t) || { color: '#aaa' };
                return `<span style="color:${meta.color};font-weight:700">${byType[t]}&nbsp;${t}</span>`;
            }).join(' &middot; ');
            affectsHtml = `<div style="color:#ddd;font-size:11px;margin-top:4px">
                <span style="color:#ffd54f;font-weight:700">Affects ${affected.length}:</span> ${parts}
            </div>`;
        }
        // v0.28: priority chip inline with the header line
        const priHtml = issue.priority
            ? `<span style="display:inline-block;padding:1px 6px;border-radius:8px;background:${priorityMeta(issue.priority).color};color:${priorityMeta(issue.priority).textColor};font-size:9px;font-weight:700;letter-spacing:0.5px;margin-left:6px">🎯 ${priorityMeta(issue.priority).text}</span>`
            : '';
        // v1.00: unseen-activity callout — green-tinted block listing
        // what's new since the user last opened this issue. Clears once
        // the user opens the status modal.
        let unseenHtml = '';
        const unseen = unseenHistoryFor(issue);
        if (unseen.length > 0) {
            const rows = unseen.slice(-5).map(h =>
                `<div style="color:#ddd;font-size:11px;margin-top:2px">${describeHistEntry(h)}</div>`
            ).join('');
            const moreCount = unseen.length > 5 ? unseen.length - 5 : 0;
            unseenHtml = `
                <div style="margin-top:8px;padding:6px 8px;background:rgba(0,255,127,0.10);
                            border-left:3px solid #00FF7F;border-radius:3px">
                    <div style="color:#00FF7F;font-size:11px;font-weight:700">
                        🟢 New since you last looked (${unseen.length})
                    </div>
                    ${rows}
                    ${moreCount > 0 ? `<div style="color:#888;font-size:10px;font-style:italic;margin-top:3px">+ ${moreCount} earlier</div>` : ''}
                </div>`;
        }
        return `
            <div style="line-height:1.35">
                <div style="font-weight:700;color:${headerColor};font-size:13px;margin-bottom:6px">${headerLabel} &middot; ${age}${priHtml}</div>
                <div style="color:#ffffff;font-size:13px;font-weight:600;margin-bottom:6px">${safeNote}</div>
                <div style="color:#a8c4ff;font-size:11px;font-weight:600">@${safeBy}</div>
                ${affectsHtml}
                ${unseenHtml}
                <div style="color:#888;font-size:10px;margin-top:6px;font-style:italic">${hideHint}</div>
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

    // v0.6: format an ISO timestamp as "MM-DD-YYYY h:mm AM/PM TZ" using
    // the viewer's local timezone. e.g. "06-01-2026 8:23 PM CDT".
    // formatToParts lets us reassemble in the user's preferred shape; the
    // default `toLocaleString` would give "6/1/2026, 8:23:00 PM" without
    // the zero-padded month/day or the timezone token.
    function fmtDateTime(iso) {
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return iso;
            const parts = new Intl.DateTimeFormat('en-US', {
                month: '2-digit', day: '2-digit', year: 'numeric',
                hour: 'numeric', minute: '2-digit',
                hour12: true,
                timeZoneName: 'short',
            }).formatToParts(d);
            const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
            const mm = get('month'), dd = get('day'), yy = get('year');
            const hh = get('hour'), mi = get('minute'), dp = (get('dayPeriod') || '').toUpperCase();
            const tz = get('timeZoneName');
            return `${mm}-${dd}-${yy} ${hh}:${mi} ${dp}${tz ? ` ${tz}` : ''}`;
        } catch (e) { return iso; }
    }

    // v0.8: combined check — issue renders dimmed if it's session-hidden
    // OR if its status is meant to be background (resolved / ignored).
    function isIssueDimmed(issue) {
        if (!issue) return false;
        if (hiddenIds.has(issue.id)) return true;
        if (issue.status === 'resolved' || issue.status === 'ignored') return true;
        return false;
    }

    function toggleSessionHide(id) {
        const issue = currentSiteIssues.find(i => i.id === id);
        if (!issue) return;
        // v0.8: resolved/ignored are background by status — M1 is a no-op
        // on those (toggling session-hide wouldn't change anything visually
        // and would just confuse the user).
        if (issue.status === 'resolved' || issue.status === 'ignored') {
            showToast(`Already in background (${issue.status}).`, 2500);
            return;
        }
        const willHide = !hiddenIds.has(id);
        if (willHide) hiddenIds.add(id);
        else hiddenIds.delete(id);
        renderOneIssue(issue, { isHidden: willHide });
        renderButtonState();
        if (willHide) {
            showToast('Issue dimmed. M1 the small icon to un-hide. M2 🚩 to un-hide all non-resolved.', 4500);
        } else {
            showToast('Issue un-hidden.', 2000);
        }
    }

    // ------- v1.00: status state machine with approver oversight -------
    //
    //                       ┌── CSM Propose Ignore ─→ pending_ignore ──→ ignored
    //                       │  (purple)                                  (grey)
    //                       │                            │
    //   open (red) ─────────┤                      Approver: Approve / Reject
    //                       │                            ↓
    //                       │                       (Reject → back to open)
    //                       │
    //                       ├── CSM Propose Fix ────→ pending_fix ─────→ resolved
    //                       │  (yellow)                                  (grey)
    //                       │                            │
    //                       │                      Approver: Approve / Reject
    //                       │                            ↓
    //                       │                       (Reject → back to open)
    //                       │
    //                       ├── Approver Direct ────→ ignored | resolved
    //                       │  (skip pending step)
    //                       │
    //                       └── ignored / resolved ──── Reopen ────────→ open
    //
    // `roles` field on each transition gates UI visibility:
    //   ['csm']      → only non-approvers see this button
    //   ['approver'] → only approvers see this button
    //   undefined    → everyone sees it (e.g. Re-open)
    //
    // `approvalCheck: true` runs the self-approval guard — when
    // SELF_APPROVAL_BLOCK_ENABLED is true, blocks approving your own
    // proposal. Disabled by default (single-active-reviewer team).
    //
    // Legacy `ready-for-review` kept in STATUS_LABEL + STATUS_TRANSITIONS
    // so pre-v1.00 issues still render + can transition. New flow uses
    // pending_fix in its place.
    const STATUS_TRANSITIONS = {
        'open': [
            // Proposal path. v1.06: approvers can ALSO propose (not just
            // direct-resolve) so an approver can route their own find through
            // another approver (e.g. Chris) instead of self-approving.
            { to: 'pending_fix',    label: '→ Propose Fix',     noteRequired: true,  color: '#FFD700', textColor: '#000',
              notePrompt: 'What was fixed? e.g. "Added missing H-Well to Site Setup"',
              roles: ['csm', 'approver'] },
            { to: 'pending_ignore', label: '→ Propose Ignore',  noteRequired: true,  color: '#8000FF', textColor: '#fff',
              notePrompt: 'Why should this be ignored? e.g. "Not within our scope" or "Duplicate of #..."',
              roles: ['csm', 'approver'] },
            // Approver direct-action (skips pending step)
            { to: 'resolved',       label: '✓ Resolve (direct)',  noteRequired: false, color: '#5fff5f', textColor: '#000',
              notePrompt: 'Optional comment on resolution',
              roles: ['approver'] },
            { to: 'ignored',        label: '⊘ Ignore (direct)',   noteRequired: true,  color: '#788cb4', textColor: '#fff',
              notePrompt: 'Why are you ignoring this? Required for the audit log.',
              roles: ['approver'] },
        ],
        'pending_ignore': [
            { to: 'ignored', label: '✓ Approve Ignore',           noteRequired: false, color: '#5fff5f', textColor: '#000',
              notePrompt: 'Optional comment on the approval',
              roles: ['approver'], approvalCheck: true },
            { to: 'open',    label: '✗ Reject (back to Open)',    noteRequired: true,  color: '#ff4d4d', textColor: '#fff',
              notePrompt: 'Why is this being rejected? What still needs to be done?',
              roles: ['approver'], approvalCheck: true },
        ],
        'pending_fix': [
            { to: 'resolved', label: '✓ Approve Fix',             noteRequired: false, color: '#5fff5f', textColor: '#000',
              notePrompt: 'Optional acceptance comment',
              roles: ['approver'], approvalCheck: true },
            { to: 'open',     label: '✗ Reject (back to Open)',   noteRequired: true,  color: '#ff4d4d', textColor: '#fff',
              notePrompt: 'Why is this being rejected? What still needs to be done?',
              roles: ['approver'], approvalCheck: true },
        ],
        // Legacy — pre-v1.00 issues use this status. Keep transition list
        // available so grandfathered issues can flow forward.
        'ready-for-review': [
            { to: 'resolved', label: '→ Resolve (legacy)',        noteRequired: false, color: '#5fff5f', textColor: '#000',
              notePrompt: 'Optional acceptance comment' },
            { to: 'open',     label: '↺ Reject (back to Open)',   noteRequired: true,  color: '#ff4d4d', textColor: '#fff',
              notePrompt: 'Why is this being rejected? What still needs to be done?' },
        ],
        'resolved': [
            { to: 'open',     label: '↺ Re-open',                  noteRequired: true, color: '#ff4d4d', textColor: '#fff',
              notePrompt: 'Why is this being re-opened? What came back or what was missed?' },
        ],
        'ignored': [
            { to: 'open',     label: '↺ Un-ignore (back to Open)', noteRequired: true, color: '#ff4d4d', textColor: '#fff',
              notePrompt: 'Why are you un-ignoring this? What changed?' },
        ],
    };

    const STATUS_LABEL = {
        'open':             { text: 'OPEN',             color: '#ff4d4d' },
        'pending_fix':      { text: 'PENDING FIX',      color: '#FFD700' },
        'pending_ignore':   { text: 'PENDING IGNORE',   color: '#8000FF' },
        'ready-for-review': { text: 'READY FOR REVIEW', color: '#ffd54f' }, // legacy
        'resolved':         { text: 'RESOLVED',         color: '#888'    },
        'ignored':          { text: 'IGNORED',          color: '#788cb4' },
    };

    // v0.28: priority. Independent of status. Default null (no priority set).
    // Ordered low → high for sort comparisons (LOW=1, MEDIUM=2, HIGH=3, null=0).
    const PRIORITY_LABEL = {
        'high':   { text: 'HIGH',   short: 'H', color: '#ff4d4d', textColor: '#fff', rank: 3 },
        'medium': { text: 'MEDIUM', short: 'M', color: '#ffa726', textColor: '#000', rank: 2 },
        'low':    { text: 'LOW',    short: 'L', color: '#42a5f5', textColor: '#fff', rank: 1 },
    };
    const PRIORITY_ORDER = ['high', 'medium', 'low'];
    function priorityMeta(p) {
        return PRIORITY_LABEL[p] || { text: '—', short: '—', color: '#555', textColor: '#bbb', rank: 0 };
    }

    function applyTransition(issueId, transition, note) {
        const issue = currentSiteIssues.find(i => i.id === issueId);
        if (!issue) return false;
        const fromStatus = issue.status;
        if (!STATUS_TRANSITIONS[fromStatus] || !STATUS_TRANSITIONS[fromStatus].some(t => t.to === transition.to)) {
            console.warn(`${TAG} illegal transition ${fromStatus} → ${transition.to}`);
            return false;
        }
        const nowIso = new Date().toISOString();
        const by = cachedUsername || 'local-only';
        const trimmedNote = (note || '').trim();
        if (transition.noteRequired && !trimmedNote) {
            return false;
        }
        if (!Array.isArray(issue.history)) issue.history = [];
        issue.history.push({
            at: nowIso,
            by,
            fromStatus,
            toStatus: transition.to,
            note: trimmedNote,
        });
        issue.status = transition.to;
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        renderButtonState();
        console.log(`${TAG} transition ${issueId}: ${fromStatus} → ${transition.to} by @${by}${trimmedNote ? ` (note: ${trimmedNote.slice(0, 80)})` : ''}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        const targetLabel = (STATUS_LABEL[transition.to] || { text: transition.to.toUpperCase() }).text;
        if (cachedToken && !wasLocalOnly) {
            showToast(`Status → ${targetLabel} — pushing to GitHub…`, 2500);
            commitIssuesToGitHub(`@${by}: ${fromStatus} → ${transition.to}`);
            // v1.03: threaded Slack reply with role-aware @-mentions.
            postSlackTransition(issue, fromStatus, transition, trimmedNote, by);
        } else {
            showToast(`Status → ${targetLabel} (local only).`, 2500);
        }
        return true;
    }

    function escHtml(s) {
        return (s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    }

    // v0.28: comments. Don't change status — just append a history entry
    // where fromStatus === toStatus. Required note. Same audit / sync
    // pipeline as transitions.
    function applyComment(issueId, note, notifyLogins) {
        const issue = currentSiteIssues.find(i => i.id === issueId);
        if (!issue) return false;
        const trimmedNote = (note || '').trim();
        if (!trimmedNote) return false;
        const nowIso = new Date().toISOString();
        const by = cachedUsername || 'local-only';
        if (!Array.isArray(issue.history)) issue.history = [];
        issue.history.push({
            at: nowIso,
            by,
            fromStatus: issue.status || 'open',
            toStatus: issue.status || 'open',  // same → comment
            kind: 'comment',
            note: trimmedNote,
        });
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderButtonState();
        console.log(`${TAG} comment on ${issueId} by @${by}: ${trimmedNote.slice(0, 80)}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast(`Comment added — pushing to GitHub…`, 2500);
            commitIssuesToGitHub(`@${by}: comment`);
            // v1.03: threaded Slack reply. v1.10: + @-mentions from picker.
            postSlackComment(issue, trimmedNote, by, notifyLogins);
        } else {
            showToast('Comment added (local only).', 2500);
        }
        return true;
    }

    // v1.12: assignment. Doesn't change status. Audited via a history entry
    // with kind='assign' + fromAssignee/toAssignee. Anyone can (re)assign.
    // null assignee = unassigned. Mirrors applyComment's sync + Slack pattern.
    function applyAssignment(issueId, newAssignee) {
        const issue = currentSiteIssues.find(i => i.id === issueId);
        if (!issue) return false;
        const from = issue.assignee || null;
        const to = newAssignee || null;
        if (from === to) return false;   // no-op
        const nowIso = new Date().toISOString();
        const by = cachedUsername || 'local-only';
        if (!Array.isArray(issue.history)) issue.history = [];
        issue.history.push({
            at: nowIso,
            by,
            fromStatus: issue.status || 'open',
            toStatus: issue.status || 'open',
            kind: 'assign',
            fromAssignee: from,
            toAssignee: to,
            note: '',
        });
        issue.assignee = to;
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        renderButtonState();
        if (panelEl) renderIssuesPanel();
        console.log(`${TAG} assign ${issueId}: ${from || '(none)'} → ${to || '(none)'} by @${by}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast(to ? `Assigned to @${to} — pushing…` : 'Unassigned — pushing…', 2500);
            commitIssuesToGitHub(`@${by}: assign → ${to || 'none'}`);
            postSlackAssignment(issue, from, to, by);
        } else {
            showToast(to ? `Assigned to @${to} (local only).` : 'Unassigned (local only).', 2500);
        }
        return true;
    }

    // v0.28: priority change. Doesn't change status. Audited via a history
    // entry with kind='priority' + fromPriority/toPriority fields.
    function applyPriorityChange(issueId, newPriority, optionalNote) {
        const issue = currentSiteIssues.find(i => i.id === issueId);
        if (!issue) return false;
        const fromPriority = issue.priority || null;
        if (fromPriority === newPriority) return false;  // no-op
        const nowIso = new Date().toISOString();
        const by = cachedUsername || 'local-only';
        if (!Array.isArray(issue.history)) issue.history = [];
        issue.history.push({
            at: nowIso,
            by,
            fromStatus: issue.status || 'open',
            toStatus: issue.status || 'open',
            kind: 'priority',
            fromPriority,
            toPriority: newPriority,
            note: (optionalNote || '').trim(),
        });
        issue.priority = newPriority;
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        renderButtonState();
        const fromLabel = fromPriority ? priorityMeta(fromPriority).text : 'NONE';
        const toLabel = newPriority ? priorityMeta(newPriority).text : 'NONE';
        console.log(`${TAG} priority ${issueId}: ${fromLabel} → ${toLabel} by @${by}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast(`Priority → ${toLabel} — pushing to GitHub…`, 2500);
            commitIssuesToGitHub(`@${by}: priority ${fromLabel} → ${toLabel}`);
        } else {
            showToast(`Priority → ${toLabel} (local only).`, 2500);
        }
        return true;
    }

    // ------- Real status modal (Phase 3) -------
    //
    // Two visual states:
    //   1. Initial — header + history + transition buttons + Delete/Close
    //   2. Armed (after user clicks a transition button) — note input
    //      + Confirm/Cancel; transition buttons row hidden
    //
    // re-renders the modal innerHTML on state change.
    function openStatusModal(issue) {
        closeStatusModal();
        // v0.30: no more overlay. The modal is a floating window so it
        // doesn't darken the map and the user can move it out of the way
        // while reviewing the issue. Default position bottom-right;
        // layout persists per the panel pattern.
        const stored = loadStatusModalLayout();
        if (stored) statusModalLayout = clampStatusModalLayout(stored);
        else statusModalLayout = clampStatusModalLayout({
            width: 560,
            height: Math.min(620, window.innerHeight - 100),
            left: window.innerWidth - 580,
            top: window.innerHeight - Math.min(640, window.innerHeight - 60),
        });
        const card = document.createElement('div');
        card.id = 'aim-issues-status-modal';
        card.style.cssText = `
            position:fixed;
            left:${statusModalLayout.left}px;top:${statusModalLayout.top}px;
            width:${statusModalLayout.width}px;height:${statusModalLayout.height}px;
            background:#1f2228;border:1px solid rgba(255,77,77,0.45);
            border-radius:10px;
            color:#e6e6e6;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            box-shadow:0 8px 32px rgba(0,0,0,0.6);
            z-index:99500;
            display:flex;flex-direction:column;overflow:hidden;
        `;
        // Stop map/leaflet events from intercepting clicks/wheel on the modal
        ['mousedown','pointerdown','wheel','dblclick','click','contextmenu','touchstart'].forEach(evt => {
            card.addEventListener(evt, (e) => e.stopPropagation(), false);
        });

        // Local UI state — armed transition (null = pick a transition;
        // non-null = note prompt for that transition).
        let armed = null;
        let pendingNote = '';     // preserved across re-renders if user typed something
        const pendingCommentNotify = new Set();  // v1.10: logins to @-mention on a comment
        // v0.30: history sort direction. v1.11: default newest first (true).
        // Click "History" header to toggle.
        let historySortDesc = true;

        function render() {
            // v0.30: skip re-renders mid-drag so stale handlers don't get
            // re-wired and the layout-state stays consistent during the
            // drag operation.
            if (statusModalDragInFlight) return;
            // Re-resolve issue from current state in case it changed
            const liveIssue = currentSiteIssues.find(i => i.id === issue.id) || issue;
            const safeNote = escHtml(liveIssue.note);
            const status = liveIssue.status || 'open';
            const statusMeta = STATUS_LABEL[status] || { text: status.toUpperCase(), color: '#ff8585' };
            // v1.00: role-gated transition list. CSMs see Propose buttons;
            // approvers see Direct + Approve/Reject. Transitions with no
            // `roles` field are shown to everyone (e.g. Re-open).
            const role = currentRole();
            const allTransitions = STATUS_TRANSITIONS[status] || [];
            const transitions = allTransitions.filter(t =>
                !t.roles || t.roles.includes(role)
            );
            // v0.28: history rendering distinguishes kinds.
            //   created: "created (OPEN)"
            //   comment (kind==='comment' or fromStatus===toStatus && !priority): "💬 commented"
            //   priority (kind==='priority' or has priority fields): "🎯 priority: LOW → HIGH"
            //   deleted (toStatus==='deleted'): "🗑 deleted"
            //   transition: "OPEN → IGNORED"
            // v0.30: sort history per user preference. Default oldest first.
            const sortedHistory = (liveIssue.history || []).slice().sort((a, b) => {
                const at = new Date(a.at).getTime();
                const bt = new Date(b.at).getTime();
                if (isNaN(at) && isNaN(bt)) return 0;
                if (isNaN(at)) return 1;
                if (isNaN(bt)) return -1;
                return historySortDesc ? bt - at : at - bt;
            });
            // v1.11: emoji + status colors matching the Slack badges so the
            // history reads at a glance. slackStatusBadge → icon; STATUS_LABEL
            // → text + color.
            const sIcon = (s) => slackStatusBadge(s).icon;
            const sColor = (s) => (STATUS_LABEL[s] || { color: '#aaa' }).color;
            const sText = (s) => (STATUS_LABEL[s] || { text: (s || '').toUpperCase() }).text;
            const statusPill = (s) => `${sIcon(s)} <span style="color:${sColor(s)};font-weight:700">${sText(s)}</span>`;
            const histRows = sortedHistory.map(h => {
                const safeHistNote = escHtml(h.note);
                const safeBy = escHtml(h.by || '?');
                let label, labelColor = '#e6e6e6';
                if (h.kind === 'priority' || (h.fromPriority !== undefined || h.toPriority !== undefined)) {
                    const fromP = h.fromPriority ? priorityMeta(h.fromPriority).text : 'NONE';
                    const toP = h.toPriority ? priorityMeta(h.toPriority).text : 'NONE';
                    const toMeta = h.toPriority ? priorityMeta(h.toPriority) : { color: '#888' };
                    label = `🎯 priority: ${fromP} → <span style="color:${toMeta.color};font-weight:700">${toP}</span>`;
                } else if (!h.fromStatus) {
                    label = `🚩 created → ${statusPill(h.toStatus)}`;
                } else if (h.toStatus === 'deleted') {
                    label = `🗑 <span style="color:#ff8585;font-weight:700">DELETED</span>`;
                } else if (h.kind === 'assign') {
                    label = h.toAssignee
                        ? `👤 assigned → <span style="color:#5fb3ff;font-weight:700">@${escHtml(h.toAssignee)}</span>`
                        : `👤 <span style="color:#888;font-weight:700">unassigned</span>`;
                } else if (h.kind === 'comment' || h.fromStatus === h.toStatus) {
                    label = `💬 commented`;
                    labelColor = '#a8c4ff';
                } else {
                    label = `${statusPill(h.fromStatus)} → ${statusPill(h.toStatus)}`;
                }
                return `<div style="padding:6px 8px;border-bottom:1px dotted rgba(255,255,255,0.08);font-size:12px">
                    <div style="color:#a8c4ff;font-size:11px;font-weight:600">${fmtDateTime(h.at)} &middot; @${safeBy}</div>
                    <div style="color:${labelColor};margin-top:2px">${label}</div>
                    ${safeHistNote ? `<div style="color:#bbb;font-size:11px;margin-top:2px">"${safeHistNote}"</div>` : ''}
                </div>`;
            }).join('');

            const isCreator = !!(liveIssue.createdBy && cachedUsername && liveIssue.createdBy === cachedUsername);
            const isLocalOnly = (liveIssue.createdBy === 'local-only');
            const canDelete = isCreator || isLocalOnly;
            const deleteBtnHtml = canDelete
                ? `<button id="aim-issues-modal-delete"
                       style="padding:7px 14px;background:#5a2222;color:#ff8585;border:1px solid #ff4d4d;border-radius:4px;cursor:pointer;font:inherit;font-weight:700;margin-right:auto">
                       🗑 Delete${isCreator ? ' (you created this)' : ' (local-only)'}
                   </button>`
                : '';

            // v0.28: armed can be one of:
            //   transition object: { to, color, textColor, noteRequired, notePrompt, label } — status change
            //   { kind: 'comment' } — add a comment (required note)
            //   { kind: 'priority', to: 'high' | 'medium' | 'low' | null } — priority change (optional note)
            //   null — show all action buttons (transitions + comment + priority chips)
            let actionSectionHtml = '';
            if (armed && armed.kind === 'comment') {
                // v1.10: tag teammates on a comment — chip picker (reliable)
                // plus inline @login in the text auto-converts (see
                // slackifyMentions). Only shown when Slack is configured.
                const notifyUsers = slackEnabled() ? Object.keys(slackConfig.users || {}).sort() : [];
                const notifyRow = notifyUsers.length ? `
                    <div style="color:#aaa;font-size:11px;margin:8px 0 4px 0">Tag on Slack (optional)</div>
                    <div id="aim-issues-comment-notify" style="display:flex;gap:5px;flex-wrap:wrap">
                        ${notifyUsers.map(l => {
                            const on = pendingCommentNotify.has(l);
                            return `<button type="button" class="aim-issues-comment-notify-chip" data-login="${escHtml(l)}"
                                style="padding:4px 10px;background:${on ? '#5fb3ff' : 'transparent'};color:${on ? '#0a1a2a' : '#5fb3ff'};border:1.5px solid #5fb3ff;border-radius:13px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">
                                @${escHtml(l)}
                            </button>`;
                        }).join('')}
                    </div>` : '';
                actionSectionHtml = `
                    <div style="margin-top:14px;padding:12px;background:#14171b;border:1px solid rgba(168,196,255,0.30);border-radius:6px">
                        <div style="color:#a8c4ff;font-size:12px;font-weight:600;margin-bottom:6px">
                            💬 Add a comment <span style="color:#888;font-weight:400">(no status change)</span>
                        </div>
                        <div style="color:#aaa;font-size:11px;margin-bottom:4px">Comment <span style="color:#ff8585">(required)</span></div>
                        <textarea id="aim-issues-modal-note"
                            placeholder="Add a comment without changing status. Tip: @TeammateLogin pings them."
                            style="width:100%;min-height:70px;background:#0e1115;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:6px 8px;font:inherit;font-size:12px;resize:vertical;box-sizing:border-box">${escHtml(pendingNote)}</textarea>
                        <div id="aim-issues-modal-noteerr" style="color:#ff8585;font-size:11px;margin-top:4px;min-height:14px"></div>
                        ${notifyRow}
                    </div>
                `;
            } else if (armed && armed.kind === 'priority') {
                const tgt = armed.to ? priorityMeta(armed.to) : { text: 'NONE', color: '#555', textColor: '#fff' };
                actionSectionHtml = `
                    <div style="margin-top:14px;padding:12px;background:#14171b;border:1px solid ${armed.to ? tgt.color : '#555'}55;border-radius:6px">
                        <div style="color:#a8c4ff;font-size:12px;font-weight:600;margin-bottom:6px">
                            🎯 Set priority to <span style="color:${tgt.color};font-weight:700">${tgt.text}</span>
                        </div>
                        <div style="color:#aaa;font-size:11px;margin-bottom:4px">Reason <span style="color:#888">(optional)</span></div>
                        <textarea id="aim-issues-modal-note"
                            placeholder="Why are you changing the priority? (optional)"
                            style="width:100%;min-height:60px;background:#0e1115;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:6px 8px;font:inherit;font-size:12px;resize:vertical;box-sizing:border-box">${escHtml(pendingNote)}</textarea>
                        <div id="aim-issues-modal-noteerr" style="color:#ff8585;font-size:11px;margin-top:4px;min-height:14px"></div>
                    </div>
                `;
            } else if (armed) {
                const tgtLabel = (STATUS_LABEL[armed.to] || { text: armed.to.toUpperCase() }).text;
                const reqText = armed.noteRequired ? '<span style="color:#ff8585">(required)</span>' : '<span style="color:#888">(optional)</span>';
                actionSectionHtml = `
                    <div style="margin-top:14px;padding:12px;background:#14171b;border:1px solid rgba(255,255,255,0.10);border-radius:6px">
                        <div style="color:#a8c4ff;font-size:12px;font-weight:600;margin-bottom:6px">
                            Transitioning to <span style="color:${armed.color};font-weight:700">${tgtLabel}</span>
                        </div>
                        <div style="color:#aaa;font-size:11px;margin-bottom:4px">Note ${reqText}</div>
                        <textarea id="aim-issues-modal-note"
                            placeholder="${escHtml(armed.notePrompt || (armed.noteRequired ? 'Required note' : 'Optional note'))}"
                            style="width:100%;min-height:70px;background:#0e1115;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:6px 8px;font:inherit;font-size:12px;resize:vertical;box-sizing:border-box">${escHtml(pendingNote)}</textarea>
                        <div id="aim-issues-modal-noteerr" style="color:#ff8585;font-size:11px;margin-top:4px;min-height:14px"></div>
                    </div>
                `;
            } else {
                // Not armed — show all action buttons (transitions + comment + priority)
                // v1.00: when the issue is in a pending state but the
                // current user is a CSM (not an approver), no transition
                // buttons are visible to them. Show a banner explaining
                // why instead of the misleading "Terminal status" message.
                let noTransitionsMsg = '<span style="color:#888;font-style:italic;font-size:11px">Terminal status</span>';
                if ((status === 'pending_fix' || status === 'pending_ignore') && role === 'csm') {
                    noTransitionsMsg = `<span style="color:#8be1ff;font-style:italic;font-size:11px">
                        ⏳ Awaiting approver review — only approvers can accept or reject pending proposals.
                    </span>`;
                }
                const transBtns = transitions.length
                    ? transitions.map((t, i) => `
                        <button data-tidx="${i}"
                            class="aim-issues-modal-transbtn"
                            style="padding:7px 12px;background:${t.color};color:${t.textColor};border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px;font-weight:700">
                            ${t.label}
                        </button>
                    `).join('')
                    : noTransitionsMsg;
                // v0.28: priority chips in unarmed view — clicking arms a priority change.
                const currentPri = liveIssue.priority || null;
                const priChips = ['high', 'medium', 'low', null].map(p => {
                    const m = p ? priorityMeta(p) : { text: 'NONE', color: '#888', textColor: '#fff' };
                    const isCur = currentPri === p;
                    const label = p ? m.text : 'None';
                    return `<button data-priority="${p || ''}"
                        class="aim-issues-modal-pribtn"
                        ${isCur ? 'disabled' : ''}
                        title="${isCur ? 'Current priority' : `Set priority to ${label}`}"
                        style="padding:5px 10px;background:${isCur ? m.color : 'transparent'};color:${isCur ? m.textColor : m.color};border:1.5px solid ${m.color};border-radius:14px;cursor:${isCur ? 'default' : 'pointer'};font:inherit;font-size:11px;font-weight:700;opacity:${isCur ? 1 : 0.85}">
                        ${label}${isCur ? ' ●' : ''}
                    </button>`;
                }).join('');
                // v1.12: assignee chips — anyone can (re)assign. Roster =
                // mapped Slack users + yourself + current assignee. One-click
                // assign (no note step); current is highlighted; ⭐ marks you.
                const assignSet = new Set(slackEnabled() ? Object.keys(slackConfig.users || {}) : []);
                if (cachedUsername) assignSet.add(cachedUsername);
                if (liveIssue.assignee) assignSet.add(liveIssue.assignee);
                const cur = liveIssue.assignee || null;
                const assignChips = Array.from(assignSet).sort().map(u => {
                    const isCur = (cur === u);
                    const isMe = (u === cachedUsername);
                    return `<button class="aim-issues-assign-chip" data-assignee="${escHtml(u)}"
                        style="padding:4px 9px;background:${isCur ? '#5fb3ff' : 'transparent'};color:${isCur ? '#0a1a2a' : '#5fb3ff'};border:1.5px solid #5fb3ff;border-radius:12px;cursor:pointer;font:inherit;font-size:10px;font-weight:700">
                        ${isMe ? '⭐ ' : ''}@${escHtml(u)}${isCur ? ' ✓' : ''}
                    </button>`;
                }).join('');
                const unassignChip = `<button class="aim-issues-assign-chip" data-assignee=""
                    style="padding:4px 9px;background:${cur ? 'transparent' : '#555'};color:${cur ? '#888' : '#fff'};border:1.5px solid #777;border-radius:12px;cursor:pointer;font:inherit;font-size:10px;font-weight:700">
                    Unassign</button>`;
                actionSectionHtml = `
                    <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        <span style="color:#aaa;font-size:12px;margin-right:4px">Change status:</span>
                        ${transBtns}
                    </div>
                    <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        <span style="color:#aaa;font-size:12px;margin-right:4px">🎯 Priority:</span>
                        ${priChips}
                    </div>
                    <div style="margin-top:10px">
                        <div style="color:#aaa;font-size:12px;margin-bottom:4px">👤 Assignee: ${cur ? `<span style="color:#5fb3ff;font-weight:700">@${escHtml(cur)}</span>` : '<span style="color:#888">unassigned</span>'}</div>
                        <div style="display:flex;gap:5px;flex-wrap:wrap">${assignChips}${unassignChip}</div>
                    </div>
                    <div style="margin-top:10px">
                        <button id="aim-issues-modal-commentbtn"
                            style="padding:6px 12px;background:#1a2333;color:#a8c4ff;border:1px solid #a8c4ff66;border-radius:4px;cursor:pointer;font:inherit;font-size:12px;font-weight:700">
                            💬 Add comment
                        </button>
                    </div>
                `;
            }

            // v0.17: affected-entities section. Compact pill list grouped by
            // type with color coding. Show even when empty so the user knows
            // we ran the detection.
            const affected = affectedEntitiesFor(liveIssue);
            // v0.18: pills are interactive — M1 copy name, M2 find-in-sidebar.
            // data-entity-name carries the value for the wireHandlers pass.
            const entitiesPillsHtml = affected.map(a => `
                <div class="aim-issues-entity-pill" data-entity-name="${escHtml(a.name)}"
                    title="M1 copy name · M2 open in Map Entities sidebar"
                    style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;margin:2px 4px 2px 0;
                           background:#0e1115;border:1px solid ${a.typeColor}55;border-radius:12px;font-size:11px;
                           cursor:pointer;user-select:none">
                    <span style="color:${a.typeColor};font-weight:700;font-size:9px;letter-spacing:0.5px">${a.typeShort}</span>
                    <span style="color:#e6e6e6">${escHtml(a.name)}</span>
                    ${a.subtype ? `<span style="color:#888;font-size:9px">(${escHtml(a.subtype)})</span>` : ''}
                </div>
            `).join('');
            const entitiesNote = !mapObjects
                ? `<span style="color:#888;font-style:italic">loading entities…</span>`
                : (affected.length === 0
                    ? `<span style="color:#888;font-style:italic">No Percepto entities detected under this polygon.</span>`
                    : entitiesPillsHtml);
            const entitiesSectionHtml = `
                <div style="margin-top:12px">
                    <div style="color:#888;font-size:11px;margin-bottom:4px;display:flex;align-items:center;gap:6px">
                        <span>Affected entities ${affected.length > 0 ? `(${affected.length})` : ''}</span>
                        ${affected.length > 0 ? '<span style="color:#666">· M1 copy · M2 sidebar</span>' : ''}
                    </div>
                    <div style="max-height:160px;overflow:auto;border:1px solid rgba(255,255,255,0.10);
                                border-radius:4px;background:#14171b;padding:6px 8px">
                        ${entitiesNote}
                    </div>
                </div>
            `;
            // v0.28: priority chip in the header next to status
            const headerPri = liveIssue.priority
                ? `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:10px;background:${priorityMeta(liveIssue.priority).color};color:${priorityMeta(liveIssue.priority).textColor};font-size:10px;font-weight:700;letter-spacing:0.5px">🎯 ${priorityMeta(liveIssue.priority).text}</span>`
                : '';
            // v0.30: floating-window structure — draggable header / scrollable
            // body / fixed footer / resize handle. Header doubles as drag
            // handle. History title is clickable to toggle sort.
            const sortArrow = historySortDesc ? '▼' : '▲';
            const sortLabel = historySortDesc ? 'newest first' : 'oldest first';
            // v1.00: role chip in header (approver vs CSM) so the user
            // sees at a glance what buttons they have access to.
            const roleChip = role === 'approver'
                ? `<span style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:9px;
                                background:#1a3a5a;color:#5fff5f;font-size:9px;font-weight:700;
                                border:1px solid rgba(95,255,95,0.45);letter-spacing:0.5px"
                         title="You're on the approver allowlist — you can directly resolve/ignore and approve/reject pending issues">
                       ✓ APPROVER
                   </span>`
                : `<span style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:9px;
                                background:#222;color:#aaa;font-size:9px;font-weight:700;
                                border:1px solid rgba(255,255,255,0.15);letter-spacing:0.5px"
                         title="You're a CSM — propose changes for approver review.">
                       CSM
                   </span>`;
            // v1.11: Slack-reported badge. Green ✓ + link to the thread when
            // the issue posted successfully (has a thread ts); amber ⧗ when
            // Slack is on but it hasn't posted (e.g. created pre-Slack, or the
            // post failed). Hidden entirely when Slack isn't configured.
            let slackBadge = '';
            if (slackEnabled() && liveIssue.slackThreadTs) {
                const permalink = `https://percepto.slack.com/archives/${slackConfig.channelId}/p${String(liveIssue.slackThreadTs).replace('.', '')}`;
                // v1.13: open via window.top.open in a click handler — the
                // map iframe's sandbox blocks <a target="_blank">, so a plain
                // link did nothing.
                slackBadge = `<span class="aim-issues-slack-link" data-href="${permalink}"
                        title="Reported to Slack — click to open the thread"
                        style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:9px;
                               background:#10331f;color:#5fff5f;font-size:9px;font-weight:700;
                               border:1px solid rgba(95,255,95,0.45);letter-spacing:0.5px;cursor:pointer">
                       ✓ SLACK
                   </span>`;
            } else if (slackEnabled()) {
                slackBadge = `<span title="Not yet posted to Slack"
                        style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:9px;
                               background:#3a2a10;color:#ffae5f;font-size:9px;font-weight:700;
                               border:1px solid rgba(255,174,95,0.4);letter-spacing:0.5px">
                       ⧗ SLACK
                   </span>`;
            }
            // v1.06: pinned footer. When a transition/comment/priority is
            // armed, Cancel + Confirm live here (always visible, no scrolling
            // past them) instead of buried in the body. Unarmed, the footer
            // holds only Delete (the header ✕ is the single close — no
            // redundant bottom Close button). Empty unarmed footer is hidden.
            const footerBase = `padding:10px 18px;background:#14171b;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:8px;align-items:center;flex-shrink:0`;
            let footerHtml = '';
            if (armed) {
                let confLabel, confBg, confColor;
                if (armed.kind === 'comment') {
                    confLabel = 'Confirm comment'; confBg = '#a8c4ff'; confColor = '#000';
                } else if (armed.kind === 'priority') {
                    const t = armed.to ? priorityMeta(armed.to) : { text: 'NONE', color: '#555', textColor: '#fff' };
                    confLabel = `Confirm priority → ${t.text}`; confBg = t.color; confColor = t.textColor;
                } else {
                    const tl = (STATUS_LABEL[armed.to] || { text: armed.to.toUpperCase() }).text;
                    confLabel = `Confirm → ${tl}`; confBg = armed.color; confColor = armed.textColor;
                }
                footerHtml = `<div style="${footerBase};justify-content:flex-end">
                    <button id="aim-issues-modal-cancel-transition"
                        style="padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit">
                        Cancel
                    </button>
                    <button id="aim-issues-modal-confirm-transition"
                        style="padding:7px 14px;background:${confBg};color:${confColor};border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700">
                        ${confLabel}
                    </button>
                </div>`;
            } else if (canDelete) {
                footerHtml = `<div style="${footerBase}">${deleteBtnHtml}</div>`;
            }
            card.innerHTML = `
                <div id="aim-issues-modal-header"
                     style="padding:10px 14px;background:#14171b;border-bottom:1px solid rgba(255,255,255,0.10);
                            display:flex;align-items:center;gap:10px;cursor:move;user-select:none;flex-shrink:0"
                     title="Drag to move the popup">
                    <span style="color:#aaa;font-size:14px;font-weight:600">Issue ·</span>
                    <span style="color:${statusMeta.color};font-weight:700;font-size:14px">${statusMeta.text}</span>
                    ${headerPri}
                    ${roleChip}
                    ${slackBadge}
                    ${liveIssue.assignee ? `<span title="Assigned to @${escHtml(liveIssue.assignee)}" style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:9px;background:#13294a;color:#5fb3ff;font-size:9px;font-weight:700;border:1px solid rgba(95,179,255,0.45);letter-spacing:0.3px">👤 ${escHtml(liveIssue.assignee)}</span>` : ''}
                    <button id="aim-issues-modal-headerclose" title="Close"
                        style="margin-left:auto;padding:3px 9px;background:#3a3f48;color:#e6e6e6;
                               border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px">
                        ✕
                    </button>
                </div>
                <div id="aim-issues-modal-body"
                     style="padding:14px 18px;overflow:auto;flex:1;min-height:0">
                    <div style="color:#e6e6e6;font-size:13px;margin-bottom:12px;line-height:1.4">${safeNote}</div>
                    ${entitiesSectionHtml}
                    ${actionSectionHtml}
                    <div id="aim-issues-modal-historyheader"
                         title="Click to toggle sort direction"
                         style="color:#888;font-size:11px;margin:14px 0 4px 0;cursor:pointer;user-select:none;
                                display:inline-flex;align-items:center;gap:5px;padding:2px 6px;
                                border-radius:4px;border:1px solid transparent;transition:border-color 150ms">
                        History
                        <span style="color:#a8c4ff;font-weight:600">${sortArrow}</span>
                        <span style="color:#888;font-style:italic">${sortLabel}</span>
                    </div>
                    <div style="border:1px solid rgba(255,255,255,0.10);border-radius:4px;background:#14171b">${histRows}</div>
                </div>
                ${footerHtml}
                <div id="aim-issues-modal-resize"
                     title="Drag to resize"
                     style="position:absolute;bottom:0;right:0;width:18px;height:18px;cursor:nwse-resize;
                            background:linear-gradient(135deg,transparent 0%,transparent 45%,rgba(255,77,77,0.55) 45%,rgba(255,77,77,0.55) 60%,transparent 60%,transparent 75%,rgba(255,77,77,0.55) 75%,rgba(255,77,77,0.55) 90%,transparent 90%);">
                </div>
            `;
            wireHandlers(liveIssue, transitions);
            // v1.06: when armed, bring the note into view + focus it so the
            // user sees the input (the Confirm/Cancel are pinned in the footer).
            if (armed) {
                const noteEl = card.querySelector('#aim-issues-modal-note');
                if (noteEl) {
                    try { noteEl.scrollIntoView({ block: 'nearest' }); } catch (e) {}
                    try { noteEl.focus(); } catch (e) {}
                }
            }
        }

        function wireHandlers(liveIssue, transitions) {
            // v1.06: bottom "Close" removed — header ✕ is the single close.
            const closeBtn = card.querySelector('#aim-issues-modal-close');
            if (closeBtn) closeBtn.onclick = closeStatusModal;
            const headerCloseBtn = card.querySelector('#aim-issues-modal-headerclose');
            if (headerCloseBtn) headerCloseBtn.onclick = closeStatusModal;
            // v1.13: ✓ SLACK badge → open the thread in a new tab via the top
            // window (iframe sandbox blocks <a target=_blank>).
            const slackLink = card.querySelector('.aim-issues-slack-link');
            if (slackLink) {
                slackLink.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const href = slackLink.dataset.href;
                    if (!href) return;
                    try { (window.top || window).open(href, '_blank', 'noopener'); }
                    catch (e2) { try { window.open(href, '_blank'); } catch (e3) {} }
                };
            }

            // v0.30: history sort toggle
            const histHeader = card.querySelector('#aim-issues-modal-historyheader');
            if (histHeader) {
                histHeader.onclick = (e) => {
                    e.stopPropagation();
                    historySortDesc = !historySortDesc;
                    render();
                };
                histHeader.onmouseenter = () => { histHeader.style.borderColor = 'rgba(168,196,255,0.4)'; };
                histHeader.onmouseleave = () => { histHeader.style.borderColor = 'transparent'; };
            }

            // v0.30: drag + resize
            wireModalDragAndResize();

            // v0.18: entity pills — M1 copy, M2 find-in-sidebar
            card.querySelectorAll('.aim-issues-entity-pill').forEach(pill => {
                const name = pill.dataset.entityName;
                pill.onclick = (e) => {
                    e.stopPropagation();
                    if (!name) return;
                    copyTextToClipboard(name)
                        .then(() => showToast(`Copied "${name}"`, 2000))
                        .catch(() => showToast('Copy failed.', 2500));
                };
                pill.oncontextmenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!name) return;
                    findEntityInSidebar(name);
                };
            });

            // Transition buttons
            card.querySelectorAll('.aim-issues-modal-transbtn').forEach(btn => {
                btn.onclick = () => {
                    const idx = parseInt(btn.dataset.tidx, 10);
                    const t = transitions[idx];
                    if (!t) return;
                    armed = t;
                    pendingNote = '';
                    render();
                    setTimeout(() => {
                        const ta = card.querySelector('#aim-issues-modal-note');
                        if (ta) ta.focus();
                    }, 30);
                };
            });

            // v1.12: assignee chips — one-click (re)assign. pointerdown+click
            // +debounce for snappy, no-dropped-click behaviour; re-render to
            // refresh the highlight + header chip.
            let lastAssignFire = 0;
            card.querySelectorAll('.aim-issues-assign-chip').forEach(chip => {
                const handler = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const now = Date.now();
                    if (now - lastAssignFire < 300) return;
                    lastAssignFire = now;
                    const target = chip.dataset.assignee || null;
                    if (applyAssignment(liveIssue.id, target)) render();
                };
                chip.addEventListener('pointerdown', handler, true);
                chip.addEventListener('click', handler, true);
            });

            // v0.28: Comment button — arms a comment-mode (required note)
            const commentBtn = card.querySelector('#aim-issues-modal-commentbtn');
            if (commentBtn) {
                commentBtn.onclick = () => {
                    armed = { kind: 'comment' };
                    pendingNote = '';
                    render();
                    setTimeout(() => {
                        const ta = card.querySelector('#aim-issues-modal-note');
                        if (ta) ta.focus();
                    }, 30);
                };
            }

            // v1.10: comment notify chips — toggle in place (no re-render so
            // the comment textarea isn't cleared). pointerdown+click+debounce
            // for the same snappy, no-dropped-click behaviour as elsewhere.
            const cmtChipFire = new Map();
            card.querySelectorAll('.aim-issues-comment-notify-chip').forEach(chip => {
                const toggle = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const login = chip.dataset.login;
                    const now = Date.now();
                    if (now - (cmtChipFire.get(login) || 0) < 300) return;
                    cmtChipFire.set(login, now);
                    if (pendingCommentNotify.has(login)) {
                        pendingCommentNotify.delete(login);
                        chip.style.background = 'transparent'; chip.style.color = '#5fb3ff';
                    } else {
                        pendingCommentNotify.add(login);
                        chip.style.background = '#5fb3ff'; chip.style.color = '#0a1a2a';
                    }
                };
                chip.addEventListener('pointerdown', toggle, true);
                chip.addEventListener('click', toggle, true);
            });

            // v0.28: Priority chips — arms a priority change (optional note)
            card.querySelectorAll('.aim-issues-modal-pribtn').forEach(btn => {
                if (btn.disabled) return;
                btn.onclick = () => {
                    const p = btn.dataset.priority || null;
                    armed = { kind: 'priority', to: p || null };
                    pendingNote = '';
                    render();
                    setTimeout(() => {
                        const ta = card.querySelector('#aim-issues-modal-note');
                        if (ta) ta.focus();
                    }, 30);
                };
            });

            // Armed-mode buttons (shared across transition / comment / priority)
            const cancelBtn = card.querySelector('#aim-issues-modal-cancel-transition');
            if (cancelBtn) {
                cancelBtn.onclick = () => { armed = null; pendingNote = ''; render(); };
            }
            const noteInput = card.querySelector('#aim-issues-modal-note');
            if (noteInput) {
                noteInput.oninput = () => { pendingNote = noteInput.value; };
                noteInput.onkeydown = (e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        confirmBtn && confirmBtn.click();
                    }
                };
            }
            const confirmBtn = card.querySelector('#aim-issues-modal-confirm-transition');
            if (confirmBtn) {
                confirmBtn.onclick = () => {
                    if (!armed) return;
                    const note = (noteInput ? noteInput.value : pendingNote).trim();
                    // v0.28: dispatch by armed.kind
                    if (armed.kind === 'comment') {
                        if (!note) {
                            const err = card.querySelector('#aim-issues-modal-noteerr');
                            if (err) err.textContent = 'Comment text required.';
                            if (noteInput) noteInput.focus();
                            return;
                        }
                        const ok = applyComment(liveIssue.id, note, Array.from(pendingCommentNotify));
                        if (ok) closeStatusModal();
                        return;
                    }
                    if (armed.kind === 'priority') {
                        const ok = applyPriorityChange(liveIssue.id, armed.to || null, note);
                        if (ok) closeStatusModal();
                        return;
                    }
                    // Default: status transition
                    if (armed.noteRequired && !note) {
                        const err = card.querySelector('#aim-issues-modal-noteerr');
                        if (err) err.textContent = 'Note required for this transition.';
                        if (noteInput) noteInput.focus();
                        return;
                    }
                    // v1.00: self-approval block. Disabled by default
                    // (SELF_APPROVAL_BLOCK_ENABLED=false). When enabled,
                    // blocks an approver from approving/rejecting a
                    // proposal they themselves authored — second pair of
                    // eyes enforcement.
                    if (armed.approvalCheck && SELF_APPROVAL_BLOCK_ENABLED) {
                        const fromStatus = liveIssue.status;
                        // Walk history backwards to find the most recent
                        // entry that put us INTO the current pending state.
                        // That entry's `by` is the proposer we're checking
                        // against the current user.
                        const proposalEntry = (liveIssue.history || [])
                            .slice().reverse()
                            .find(h => h && h.toStatus === fromStatus
                                && h.fromStatus && h.fromStatus !== h.toStatus);
                        const proposer = proposalEntry ? proposalEntry.by : null;
                        if (proposer && cachedUsername && proposer === cachedUsername) {
                            showToast(
                                "You can't approve your own proposed change — another approver needs to review this.",
                                5500);
                            return;
                        }
                    }
                    const ok = applyTransition(liveIssue.id, armed, note);
                    if (ok) closeStatusModal();
                };
            }

            // Delete (two-stage confirm — preserved from v0.6)
            const deleteBtn = card.querySelector('#aim-issues-modal-delete');
            if (deleteBtn) {
                deleteBtn.onclick = () => {
                    if (deleteBtn.dataset.armed === '1') {
                        deleteIssue(liveIssue.id);
                        closeStatusModal();
                        return;
                    }
                    deleteBtn.dataset.armed = '1';
                    deleteBtn.textContent = '⚠ Click again to confirm delete';
                    deleteBtn.style.background = '#ff4d4d';
                    deleteBtn.style.color = '#fff';
                    setTimeout(() => {
                        if (!deleteBtn || deleteBtn.dataset.armed !== '1') return;
                        deleteBtn.dataset.armed = '0';
                        // Restore original label via a re-render — safer than
                        // string-matching the original creator/local label.
                        render();
                    }, 5000);
                };
            }
        }

        // v0.30: drag/resize for the modal. Closure-scoped so it sees `card`,
        // `render`, `statusModalLayout` directly. Re-wired on every render
        // since innerHTML wipes the mousedown handlers on the header/handle.
        function wireModalDragAndResize() {
            const header = card.querySelector('#aim-issues-modal-header');
            const handle = card.querySelector('#aim-issues-modal-resize');
            if (header) {
                header.addEventListener('mousedown', (e) => {
                    if (e.target.closest('button, input, textarea')) return;
                    if (e.button !== 0) return;
                    e.preventDefault(); e.stopPropagation();
                    startModalDrag(e, 'move');
                });
            }
            if (handle) {
                handle.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    e.preventDefault(); e.stopPropagation();
                    startModalDrag(e, 'resize');
                });
            }
        }
        function startModalDrag(downEvent, mode) {
            if (!card || !statusModalLayout) return;
            statusModalDragInFlight = true;
            const sx = downEvent.clientX, sy = downEvent.clientY;
            const sLeft = statusModalLayout.left, sTop = statusModalLayout.top;
            const sW = statusModalLayout.width, sH = statusModalLayout.height;
            const onMove = (e) => {
                const dx = e.clientX - sx, dy = e.clientY - sy;
                let next;
                if (mode === 'move') next = { ...statusModalLayout, left: sLeft + dx, top: sTop + dy };
                else next = { ...statusModalLayout, width: sW + dx, height: sH + dy };
                const clamped = clampStatusModalLayout(next);
                statusModalLayout = clamped;
                card.style.left   = `${clamped.left}px`;
                card.style.top    = `${clamped.top}px`;
                card.style.width  = `${clamped.width}px`;
                card.style.height = `${clamped.height}px`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove, true);
                document.removeEventListener('mouseup', onUp, true);
                statusModalDragInFlight = false;
                saveStatusModalLayout(statusModalLayout);
                render();
            };
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
        }

        render();
        document.body.appendChild(card);
        statusModalEl = card;
        // v1.00: opening the modal counts as "seen". Mark the issue,
        // then re-render the marker + panel rows so the green ? badge
        // clears immediately.
        try {
            markIssueSeen(issue.id);
            renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
            if (panelEl) renderIssuesPanel();
        } catch (e) { console.warn(`${TAG} mark-seen on modal open threw:`, e); }
        // v0.30: Esc on document (no overlay anymore). Use capture so
        // we beat any other Esc handlers.
        const keyH = (e) => {
            if (e.key !== 'Escape') return;
            // Only act if we're the focus context — but in practice any
            // Esc while modal open should toggle armed or close.
            if (!statusModalEl) return;
            if (armed) { e.preventDefault(); armed = null; pendingNote = ''; render(); }
            else { e.preventDefault(); closeStatusModal(); }
        };
        document.addEventListener('keydown', keyH, true);
        // Save reference for cleanup
        card._aim_keyhandler = keyH;
    }

    function closeStatusModal() {
        if (statusModalEl) {
            // v0.30: clean up the document-level Esc listener attached in
            // openStatusModal — otherwise leftover handlers stack up across
            // open/close cycles.
            try {
                const keyH = statusModalEl._aim_keyhandler;
                if (keyH) document.removeEventListener('keydown', keyH, true);
            } catch (e) {}
            try { statusModalEl.remove(); } catch (e) {}
        }
        statusModalEl = null;
    }

    // ------- Issues panel (v0.15 — Phase 5 floating panel) -------
    //
    // Triggered by M2 on the 🚩 toolbar button. Floating top-right pane
    // listing every issue on the current site. Status filter chips +
    // search + click-row-to-pan-and-open-modal. Un-hide All + Refresh
    // buttons live in the header (un-hide used to be M2 on the toolbar
    // button — moved here in v0.15).
    function openIssuesPanel() {
        if (panelEl) { renderIssuesPanel(); return; }
        const panel = document.createElement('div');
        panel.id = 'aim-issues-panel';
        // v0.16: position + size driven by panelLayout (persisted). Defaults
        // place us top-right-ish; if user has moved/resized, restore that.
        const stored = loadPanelLayout();
        if (stored) panelLayout = clampPanelLayout(stored);
        else panelLayout = clampPanelLayout({
            left: window.innerWidth - 580,
            top: 60,
            width: 560,
            height: Math.min(620, window.innerHeight - 100),
        });
        panel.style.cssText = `
            position:fixed;
            left:${panelLayout.left}px;top:${panelLayout.top}px;
            width:${panelLayout.width}px;height:${panelLayout.height}px;
            background:#1f2228;border:1px solid rgba(255,77,77,0.55);border-radius:10px;
            box-shadow:0 8px 32px rgba(0,0,0,0.6);
            z-index:99000;
            color:#e6e6e6;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            display:flex;flex-direction:column;overflow:hidden;
        `;
        // Block Leaflet drag/zoom from intercepting clicks/wheel on the panel.
        ['mousedown','pointerdown','wheel','dblclick','click','contextmenu','touchstart'].forEach(evt => {
            panel.addEventListener(evt, (e) => e.stopPropagation(), false);
        });
        document.body.appendChild(panel);
        panelEl = panel;
        renderIssuesPanel();
        console.log(`${TAG} panel opened`);
    }

    function closeIssuesPanel() {
        if (panelEl) { try { panelEl.remove(); } catch (e) {} }
        panelEl = null;
    }

    // Status meta — extends STATUS_LABEL with chip-color hints. Resolved
    // is "dim" by status so its chip is faded too.
    // v1.00: pending_fix + pending_ignore added between open and resolved.
    // ready-for-review chip is hidden in render unless a legacy issue is
    // actually in that status (count > 0).
    const PANEL_STATUS_ORDER = ['open', 'pending_fix', 'pending_ignore', 'ready-for-review', 'resolved', 'ignored'];

    function panelMatchesIssue(issue) {
        const st = issue.status || 'open';
        if (!panelFilters.has(st)) return false;
        // v1.12: "Assigned to me" filter.
        if (panelAssignedToMe && (issue.assignee || null) !== (cachedUsername || null)) return false;
        // v0.29: priority filter — 'none' represents null/undefined.
        const priKey = issue.priority || 'none';
        if (!panelPriorityFilters.has(priKey)) return false;
        const q = panelSearch.trim().toLowerCase();
        if (!q) return true;
        const note = (issue.note || '').toLowerCase();
        const by = (issue.createdBy || '').toLowerCase();
        if (note.includes(q) || by.includes(q)) return true;
        // also match against any history note
        return (issue.history || []).some(h => (h.note || '').toLowerCase().includes(q));
    }

    function renderIssuesPanel() {
        if (!panelEl) return;
        // v0.16: don't re-render mid-drag — would re-wire stale handlers.
        if (panelDragInFlight) return;
        // Preserve search input focus + cursor across re-render. Without
        // this, each renderButtonState-triggered re-render kicks the user
        // out of the search box mid-keystroke.
        const ae = document.activeElement;
        const wasSearchFocused = ae && ae.id === 'aim-issues-panel-search';
        const prevSelStart = wasSearchFocused ? ae.selectionStart : null;
        const prevSelEnd   = wasSearchFocused ? ae.selectionEnd   : null;
        // v0.25: filter tombstones from the panel — sort + per-status counts
        // both operate on the live list.
        const liveSiteIssues = liveIssues(currentSiteIssues);
        const issuesSorted = liveSiteIssues
            .slice()
            .sort((a, b) => new Date(lastEventAt(b)).getTime() - new Date(lastEventAt(a)).getTime());
        const visibleIssues = issuesSorted.filter(panelMatchesIssue);

        // Per-status counts (always all live issues, ignoring search —
        // counts tell the user how many are in each bucket)
        const countsByStatus = {
            'open': 0, 'pending_fix': 0, 'pending_ignore': 0,
            'ready-for-review': 0, 'resolved': 0, 'ignored': 0,
        };
        liveSiteIssues.forEach(i => {
            const s = i.status || 'open';
            if (countsByStatus[s] !== undefined) countsByStatus[s]++;
        });
        // v1.00: pending count for the "Pending my review" shortcut
        // (approvers only — gated below).
        const pendingCount = (countsByStatus['pending_fix'] || 0)
                           + (countsByStatus['pending_ignore'] || 0);

        const safeSearch = escHtml(panelSearch);
        const syncDot = ({
            'no-token': '#777', 'syncing': '#ffb347', 'ok': '#5fff5f',
            'pending': '#ffb347', 'error': '#ff4d4d',
        })[syncStatus] || '#777';
        const syncWord = ({
            'no-token': 'local-only', 'syncing': 'syncing…',
            'ok': cachedUsername ? `@${cachedUsername}` : 'synced',
            'pending': 'pending', 'error': 'error',
        })[syncStatus] || '';

        // v1.00: status chip needs dark text only when its background is
        // bright enough that white text would be unreadable. pending_fix
        // (gold) + ready-for-review (light yellow) + resolved (light grey)
        // → dark text. All others → white.
        const STATUSES_NEEDING_DARK_TEXT = new Set(['pending_fix', 'ready-for-review', 'resolved']);
        // Chips row
        const chipsHtml = PANEL_STATUS_ORDER.map(st => {
            const meta = STATUS_LABEL[st] || { text: st.toUpperCase(), color: '#888' };
            const n = countsByStatus[st] || 0;
            // Hide legacy ready-for-review chip if no issues in it
            if (st === 'ready-for-review' && n === 0) return '';
            const active = panelFilters.has(st);
            const activeFg = STATUSES_NEEDING_DARK_TEXT.has(st) ? '#000' : '#fff';
            return `<button class="aim-issues-panel-chip" data-status="${st}"
                title="${active ? 'Click to hide' : 'Click to show'} ${meta.text.toLowerCase()} issues — M2 to solo"
                style="
                    padding:5px 10px;border-radius:14px;font:inherit;font-size:11px;font-weight:700;
                    border:1.5px solid ${meta.color};
                    background:${active ? meta.color : 'transparent'};
                    color:${active ? activeFg : meta.color};
                    cursor:pointer;opacity:${active ? 1 : 0.55};
                    display:inline-flex;align-items:center;gap:6px">
                <span>${meta.text}</span>
                <span style="background:rgba(0,0,0,0.25);padding:1px 5px;border-radius:8px;font-size:10px">${n}</span>
            </button>`;
        }).filter(Boolean).join('');

        // v1.00: "Pending my review" shortcut chip — approvers only.
        // M1 click: solo pending_fix + pending_ignore (hide everything else).
        // Always visible when role=approver, even if count is 0.
        const role = currentRole();
        // v1.12: "Assigned to me" filter chip — everyone, when authed.
        const myAssignedCount = cachedUsername
            ? liveSiteIssues.filter(i => (i.assignee || null) === cachedUsername).length : 0;
        const assignedToMeChipHtml = cachedUsername ? `
            <button id="aim-issues-panel-assignedtome"
                title="Show only issues assigned to you"
                style="padding:5px 10px;border-radius:14px;font:inherit;font-size:11px;font-weight:700;
                       border:1.5px dashed #5fb3ff;
                       background:${panelAssignedToMe ? '#5fb3ff' : 'transparent'};
                       color:${panelAssignedToMe ? '#0a1a2a' : '#5fb3ff'};
                       cursor:pointer;display:inline-flex;align-items:center;gap:6px">
                <span>👤 Assigned to me</span>
                <span style="background:rgba(0,0,0,0.25);padding:1px 5px;border-radius:8px;font-size:10px">${myAssignedCount}</span>
            </button>` : '';
        const pendingShortcutHtml = (role === 'approver') ? `
            <button id="aim-issues-panel-pending-shortcut"
                title="Solo pending issues (Pending Fix + Pending Ignore) — for your review"
                style="
                    padding:5px 10px;border-radius:14px;font:inherit;font-size:11px;font-weight:700;
                    border:1.5px dashed #5fff5f;
                    background:transparent;color:#5fff5f;
                    cursor:pointer;opacity:${pendingCount > 0 ? 1 : 0.7};
                    display:inline-flex;align-items:center;gap:6px">
                <span>⚡ Pending my review</span>
                <span style="background:${pendingCount > 0 ? '#ffa726' : 'rgba(0,0,0,0.25)'};
                             color:${pendingCount > 0 ? '#000' : '#bbb'};
                             padding:1px 5px;border-radius:8px;font-size:10px">${pendingCount}</span>
            </button>` : '';
        // v0.29: priority filter chips. Same M1 toggle / M2 solo semantics.
        // 'none' represents issues with no priority set.
        const priCountsByKey = { high: 0, medium: 0, low: 0, none: 0 };
        liveSiteIssues.forEach(i => {
            const k = i.priority || 'none';
            if (priCountsByKey[k] !== undefined) priCountsByKey[k]++;
        });
        const priChipsHtml = ['high', 'medium', 'low', 'none'].map(p => {
            const m = (p === 'none')
                ? { text: 'No priority', color: '#888', textColor: '#fff' }
                : priorityMeta(p);
            const active = panelPriorityFilters.has(p);
            const n = priCountsByKey[p];
            const labelText = p === 'none' ? 'NONE' : m.text;
            return `<button class="aim-issues-panel-prichip" data-priority="${p}"
                title="${active ? 'Click to hide' : 'Click to show'} ${labelText.toLowerCase()}-priority issues (M2 = solo)"
                style="
                    padding:4px 9px;border-radius:12px;font:inherit;font-size:10px;font-weight:700;
                    border:1.5px solid ${m.color};
                    background:${active ? m.color : 'transparent'};
                    color:${active ? m.textColor : m.color};
                    cursor:pointer;opacity:${active ? 1 : 0.55};
                    display:inline-flex;align-items:center;gap:5px">
                <span>${p === 'none' ? '—' : '🎯'} ${labelText}</span>
                <span style="background:rgba(0,0,0,0.25);padding:1px 4px;border-radius:7px;font-size:9px">${n}</span>
            </button>`;
        }).join('');

        // Rows
        let rowsHtml;
        if (liveSiteIssues.length === 0) {
            rowsHtml = `<div style="padding:30px 12px;color:#888;text-align:center;font-style:italic">
                No issues on this site yet. Toggle 🚩 → flag mode → click-drag to create one.
            </div>`;
        } else if (visibleIssues.length === 0) {
            rowsHtml = `<div style="padding:30px 12px;color:#888;text-align:center;font-style:italic">
                No issues match the current filters / search.
            </div>`;
        } else {
            rowsHtml = visibleIssues.map(issue => {
                const meta = STATUS_LABEL[issue.status || 'open'] || { text: 'OPEN', color: '#ff4d4d' };
                const headerLabel = lastEventLabel(issue);
                const age = relativeAge(lastEventAt(issue));
                const safeNote = escHtml(issue.note);
                const safeBy = escHtml(issue.createdBy || '?');
                const sessionHidden = hiddenIds.has(issue.id);
                const dimmed = (issue.status === 'resolved' || issue.status === 'ignored');
                const rowOpacity = (sessionHidden || dimmed) ? 0.55 : 1;
                // v0.17 + v0.18: per-type tally under the note, with an
                // expand arrow to stack the affected entities vertically.
                // Expansion state persists per issue id in expandedIssueIds.
                const affected = affectedEntitiesFor(issue);
                let affectsHtml;
                if (!mapObjects) {
                    affectsHtml = `<div style="color:#888;font-size:10px;margin-top:3px;font-style:italic">loading entities…</div>`;
                } else if (affected.length === 0) {
                    affectsHtml = '';
                } else {
                    const byType = {};
                    affected.forEach(a => { byType[a.typeShort] = (byType[a.typeShort] || 0) + 1; });
                    const parts = Object.keys(byType).map(t => {
                        const m = Object.values(ENTITY_TYPE_META).find(mm => mm.short === t) || { color: '#aaa' };
                        return `<span style="color:${m.color};font-weight:700">${byType[t]}&nbsp;${t}</span>`;
                    }).join(' &middot; ');
                    const expanded = expandedIssueIds.has(issue.id);
                    const arrow = expanded ? '▼' : '▶';
                    // Stacked entity list when expanded — same shape as the
                    // modal pills, including M1/M2 behavior. Single column.
                    const stackedHtml = expanded ? `
                        <div style="margin-top:5px;display:flex;flex-direction:column;gap:3px;
                                    padding:6px;background:rgba(0,0,0,0.25);border-radius:4px;
                                    border:1px solid rgba(255,255,255,0.06)">
                            <div style="color:#666;font-size:9px;font-style:italic;margin-bottom:2px">
                                M1 copy · M2 open in sidebar
                            </div>
                            ${affected.map(a => `
                                <div class="aim-issues-entity-pill" data-entity-name="${escHtml(a.name)}"
                                    title="M1 copy name · M2 open in Map Entities sidebar"
                                    style="display:flex;align-items:center;gap:5px;padding:3px 6px;
                                           background:#0e1115;border:1px solid ${a.typeColor}55;border-radius:4px;font-size:11px;
                                           cursor:pointer;user-select:none">
                                    <span style="color:${a.typeColor};font-weight:700;font-size:9px;letter-spacing:0.5px;min-width:24px">${a.typeShort}</span>
                                    <span style="color:#e6e6e6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.name)}</span>
                                    ${a.subtype ? `<span style="color:#888;font-size:9px;flex-shrink:0">(${escHtml(a.subtype)})</span>` : ''}
                                </div>
                            `).join('')}
                        </div>
                    ` : '';
                    affectsHtml = `<div style="font-size:10px;margin-top:3px">
                        <span class="aim-issues-row-expand" data-issue-id="${issue.id}"
                            title="${expanded ? 'Collapse' : 'Expand'} affected entities"
                            style="color:#ffd54f;cursor:pointer;user-select:none;display:inline-block;min-width:10px;margin-right:2px">${arrow}</span>
                        <span style="color:#ffd54f;font-weight:700">Affects ${affected.length}:</span> ${parts}
                        ${stackedHtml}
                    </div>`;
                }
                // v0.28: priority chip under the status pill if set
                const priM = issue.priority ? priorityMeta(issue.priority) : null;
                const priChip = priM
                    ? `<div style="margin-top:3px"><span style="display:inline-block;padding:1px 5px;border-radius:6px;background:${priM.color};color:${priM.textColor};font-size:9px;font-weight:700">🎯 ${priM.text}</span></div>`
                    : '';
                // v1.00: status badge needs dark text for bright backgrounds.
                const darkText = (issue.status === 'pending_fix'
                    || issue.status === 'ready-for-review'
                    || issue.status === 'resolved');
                // v1.00: pulsing green ? indicator + native tooltip summary
                // of unseen events. Click row opens modal which clears it.
                const unseen = unseenHistoryFor(issue);
                let activityChip = '';
                if (unseen.length > 0) {
                    // Plain-text title — strip the HTML formatting from
                    // describeHistEntry. Native title attribute can't render HTML.
                    const plainSummary = unseen.slice(-5).map(h => {
                        const by = h.by || '?';
                        if (h.kind === 'priority' || h.toPriority !== undefined) {
                            const toP = h.toPriority ? priorityMeta(h.toPriority).text : 'NONE';
                            return `@${by}: priority → ${toP}`;
                        }
                        if (h.kind === 'comment' || (h.fromStatus && h.fromStatus === h.toStatus)) {
                            return `@${by}: 💬 ${(h.note || '').slice(0, 80)}`;
                        }
                        if (!h.fromStatus) return `@${by}: created`;
                        if (h.toStatus === 'deleted') return `@${by}: deleted`;
                        const fromLbl = (STATUS_LABEL[h.fromStatus] || {text: h.fromStatus}).text;
                        const toLbl = (STATUS_LABEL[h.toStatus] || {text: h.toStatus}).text;
                        return `@${by}: ${fromLbl} → ${toLbl}`;
                    }).join('\n');
                    const moreCount = unseen.length > 5 ? `\n+ ${unseen.length - 5} earlier` : '';
                    const titleText = `${unseen.length} new event${unseen.length === 1 ? '' : 's'}:\n${plainSummary}${moreCount}\n\nClick row to view + dismiss.`;
                    activityChip = `<span class="aim-issues-activity-dot"
                        title="${escHtml(titleText)}"
                        style="display:inline-flex;align-items:center;justify-content:center;
                               width:16px;height:16px;border-radius:50%;
                               background:#00FF7F;color:#000;
                               font-size:11px;font-weight:900;line-height:1;
                               border:1px solid rgba(0,0,0,0.45);
                               margin-left:6px;vertical-align:middle">?</span>`;
                }
                return `<div class="aim-issues-panel-row" data-issue-id="${issue.id}"
                    style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.06);
                           cursor:pointer;opacity:${rowOpacity};
                           display:grid;grid-template-columns:90px 110px 1fr 80px;gap:8px;align-items:start"
                    title="Click to zoom to issue + open status modal">
                    <div>
                        <span style="display:inline-block;padding:2px 6px;border-radius:8px;
                                     background:${meta.color};color:${darkText ? '#000' : '#fff'};
                                     font-size:10px;font-weight:700">${meta.text}</span>
                        ${priChip}
                        ${sessionHidden ? '<div style="font-size:9px;color:#5fff5f;margin-top:2px">HIDDEN</div>' : ''}
                    </div>
                    <div style="color:#a8c4ff;font-size:11px;font-weight:600">
                        ${escHtml(headerLabel)}${activityChip}
                        <div style="color:#888;font-weight:400;font-size:10px;margin-top:1px">${age}</div>
                    </div>
                    <div>
                        <div style="color:#e6e6e6;font-size:12px;line-height:1.35;
                                    overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
                                    -webkit-line-clamp:2;-webkit-box-orient:vertical">${safeNote}</div>
                        ${affectsHtml}
                    </div>
                    <div style="color:#a8c4ff;font-size:11px;text-align:right">
                        @${safeBy}
                        ${issue.assignee ? `<div style="color:#5fb3ff;font-size:10px;margin-top:2px" title="Assigned to @${escHtml(issue.assignee)}">👤 ${escHtml(issue.assignee)}</div>` : ''}
                    </div>
                </div>`;
            }).join('');
        }

        panelEl.innerHTML = `
            <div id="aim-issues-panel-header" style="padding:10px 14px;background:#14171b;border-bottom:1px solid rgba(255,255,255,0.10);
                        display:flex;align-items:center;gap:10px;cursor:move;user-select:none"
                 title="Drag to move the panel">
                <span style="font-size:16px">🚩</span>
                <span style="font-weight:700;color:#ff8585">Issues</span>
                <span style="color:#888;font-size:11px">·</span>
                <span style="color:#888;font-size:11px">Site ${escHtml(siteID || '—')}${siteName ? ` <span style="color:#a8c4ff">· ${escHtml(siteName)}</span>` : ''}</span>
                <span style="color:#888;font-size:11px">·</span>
                <span style="color:#aaa;font-size:11px">${liveSiteIssues.length} total</span>
                <span style="color:#888;font-size:11px">·</span>
                <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px">
                    <span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${syncDot}"></span>
                    <span style="color:#aaa">${escHtml(syncWord)}</span>
                </span>
                <button id="aim-issues-panel-close" title="Close panel"
                    style="margin-left:auto;padding:4px 10px;background:#3a3f48;color:#e6e6e6;
                           border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px">
                    ✕
                </button>
            </div>
            <div style="padding:10px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
                        border-bottom:1px solid rgba(255,255,255,0.06);background:#181b21">
                ${chipsHtml}
                ${pendingShortcutHtml}
                ${assignedToMeChipHtml}
                <div style="margin-left:auto;display:flex;gap:6px">
                    ${hiddenIds.size > 0
                        ? `<button id="aim-issues-panel-unhide"
                               title="Un-hide all session-hidden issues (except resolved + ignored)"
                               style="padding:5px 10px;background:#3a3f48;color:#5fff5f;
                                      border:1px solid rgba(95,255,95,0.4);border-radius:4px;
                                      cursor:pointer;font:inherit;font-size:11px;font-weight:700">
                               ↺ Un-hide all (${hiddenIds.size})
                           </button>`
                        : ''}
                    <button id="aim-issues-panel-export"
                        title="Copy ${visibleIssues.length} visible issue${visibleIssues.length === 1 ? '' : 's'} as a formatted table — paste into Google Sheets / Excel"
                        ${visibleIssues.length === 0 ? 'disabled' : ''}
                        style="padding:5px 10px;background:#3a3f48;color:#ffd54f;
                               border:1px solid rgba(255,213,79,0.4);border-radius:4px;
                               cursor:${visibleIssues.length === 0 ? 'not-allowed' : 'pointer'};font:inherit;font-size:11px;font-weight:700;
                               opacity:${visibleIssues.length === 0 ? 0.4 : 1}">
                        📊 Copy → Sheets (${visibleIssues.length})
                    </button>
                    <button id="aim-issues-panel-refresh"
                        title="Re-fetch issues from GitHub"
                        style="padding:5px 10px;background:#3a3f48;color:#a8c4ff;
                               border:1px solid rgba(168,196,255,0.3);border-radius:4px;
                               cursor:pointer;font:inherit;font-size:11px;font-weight:700">
                        ↻ Refresh
                    </button>
                </div>
            </div>
            <div style="padding:6px 14px 8px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;
                        border-bottom:1px solid rgba(255,255,255,0.06);background:#181b21">
                <span style="color:#888;font-size:10px;margin-right:2px;font-weight:600">PRIORITY:</span>
                ${priChipsHtml}
            </div>
            <div style="padding:8px 14px;border-bottom:1px solid rgba(255,255,255,0.06);background:#181b21">
                <input id="aim-issues-panel-search" type="text"
                    placeholder="Search notes / authors / history…"
                    value="${safeSearch}"
                    style="width:100%;padding:6px 10px;background:#0e1115;color:#fff;
                           border:1px solid rgba(255,255,255,0.15);border-radius:4px;font:inherit;font-size:12px;box-sizing:border-box">
            </div>
            <div style="padding:0;overflow:auto;flex:1;min-height:120px">${rowsHtml}</div>
            <div style="padding:6px 14px;background:#14171b;border-top:1px solid rgba(255,255,255,0.06);
                        color:#666;font-size:10px;font-style:italic">
                Row: zoom + open modal · M1 chip: toggle · M2 chip: solo (status + priority) · ▶ expand entities · M1 pill: copy · M2 pill: sidebar
            </div>
            <div id="aim-issues-panel-resize"
                 title="Drag to resize"
                 style="position:absolute;bottom:0;right:0;width:18px;height:18px;cursor:nwse-resize;
                        background:linear-gradient(135deg,transparent 0%,transparent 45%,rgba(255,77,77,0.55) 45%,rgba(255,77,77,0.55) 60%,transparent 60%,transparent 75%,rgba(255,77,77,0.55) 75%,rgba(255,77,77,0.55) 90%,transparent 90%);">
            </div>
        `;

        // Wire handlers
        panelEl.querySelector('#aim-issues-panel-close').onclick = closeIssuesPanel;

        const unhideBtn = panelEl.querySelector('#aim-issues-panel-unhide');
        if (unhideBtn) {
            unhideBtn.onclick = () => {
                unhideAllNonResolved();
                renderIssuesPanel();
            };
        }
        const refreshBtn = panelEl.querySelector('#aim-issues-panel-refresh');
        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                refreshBtn.textContent = '⏳ Refreshing…';
                refreshBtn.disabled = true;
                try { await refetchIssues(); }
                catch (e) {}
                renderIssuesPanel();
            };
        }
        // v0.19: export visible issues to Sheets
        const exportBtn = panelEl.querySelector('#aim-issues-panel-export');
        if (exportBtn && !exportBtn.disabled) {
            exportBtn.onclick = () => {
                // v0.20: refresh siteName at click-time in case it loaded after init
                if (!siteName) siteName = readSiteName();
                copyIssuesToSheets(visibleIssues, siteID || '', siteName || '');
            };
        }
        const searchInput = panelEl.querySelector('#aim-issues-panel-search');
        if (searchInput) {
            // Debounced re-render on every keystroke
            let t = null;
            searchInput.oninput = () => {
                panelSearch = searchInput.value;
                clearTimeout(t);
                t = setTimeout(() => { if (panelEl) renderIssuesPanel(); }, 150);
            };
        }
        // v1.00: "Pending my review" shortcut — solo the two pending
        // statuses. Toggle: clicking again restores the prior full set.
        // v1.12: "Assigned to me" filter toggle
        const assignedToMeBtn = panelEl.querySelector('#aim-issues-panel-assignedtome');
        if (assignedToMeBtn) {
            assignedToMeBtn.onclick = () => {
                panelAssignedToMe = !panelAssignedToMe;
                renderIssuesPanel();
            };
        }
        const pendingShortcut = panelEl.querySelector('#aim-issues-panel-pending-shortcut');
        if (pendingShortcut) {
            pendingShortcut.onclick = () => {
                const isAlreadySolo = (panelFilters.size === 2
                    && panelFilters.has('pending_fix')
                    && panelFilters.has('pending_ignore'));
                panelFilters.clear();
                if (isAlreadySolo) {
                    // Restore everything
                    PANEL_STATUS_ORDER.forEach(s => panelFilters.add(s));
                } else {
                    panelFilters.add('pending_fix');
                    panelFilters.add('pending_ignore');
                }
                renderIssuesPanel();
            };
        }
        panelEl.querySelectorAll('.aim-issues-panel-chip').forEach(chip => {
            chip.onclick = () => {
                const st = chip.dataset.status;
                if (panelFilters.has(st)) panelFilters.delete(st);
                else panelFilters.add(st);
                renderIssuesPanel();
            };
            // v0.16: M2 on a chip "solos" that status (audio-mixer pattern,
            // matches Asset Inspector). M2 again → restore all.
            chip.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const st = chip.dataset.status;
                const isCurrentlySolo = (panelFilters.size === 1 && panelFilters.has(st));
                panelFilters.clear();
                if (isCurrentlySolo) {
                    PANEL_STATUS_ORDER.forEach(s => panelFilters.add(s));
                } else {
                    panelFilters.add(st);
                }
                renderIssuesPanel();
            };
        });
        // v0.29: priority chips — same M1 toggle / M2 solo semantics
        const ALL_PRIORITIES = ['high', 'medium', 'low', 'none'];
        panelEl.querySelectorAll('.aim-issues-panel-prichip').forEach(chip => {
            chip.onclick = () => {
                const p = chip.dataset.priority;
                if (panelPriorityFilters.has(p)) panelPriorityFilters.delete(p);
                else panelPriorityFilters.add(p);
                renderIssuesPanel();
            };
            chip.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const p = chip.dataset.priority;
                const isCurrentlySolo = (panelPriorityFilters.size === 1 && panelPriorityFilters.has(p));
                panelPriorityFilters.clear();
                if (isCurrentlySolo) ALL_PRIORITIES.forEach(x => panelPriorityFilters.add(x));
                else panelPriorityFilters.add(p);
                renderIssuesPanel();
            };
        });
        panelEl.querySelectorAll('.aim-issues-panel-row').forEach(row => {
            row.onclick = (e) => {
                // v0.18: don't fire row-click when user clicked the expand
                // arrow or an entity pill inside the row.
                if (e.target.closest('.aim-issues-row-expand, .aim-issues-entity-pill')) return;
                const id = row.dataset.issueId;
                const issue = currentSiteIssues.find(i => i.id === id);
                if (!issue) return;
                zoomToIssue(issue);
                openStatusModal(issue);
            };
        });
        // v0.18: expand/collapse arrows
        panelEl.querySelectorAll('.aim-issues-row-expand').forEach(arrow => {
            arrow.onclick = (e) => {
                e.stopPropagation();
                const id = arrow.dataset.issueId;
                if (!id) return;
                if (expandedIssueIds.has(id)) expandedIssueIds.delete(id);
                else expandedIssueIds.add(id);
                renderIssuesPanel();
            };
        });
        // v0.18: panel entity pills — same M1 copy / M2 sidebar as modal
        panelEl.querySelectorAll('.aim-issues-entity-pill').forEach(pill => {
            const name = pill.dataset.entityName;
            pill.onclick = (e) => {
                e.stopPropagation();
                if (!name) return;
                copyTextToClipboard(name)
                    .then(() => showToast(`Copied "${name}"`, 2000))
                    .catch(() => showToast('Copy failed.', 2500));
            };
            pill.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!name) return;
                findEntityInSidebar(name);
            };
        });
        // v0.16: drag-to-move + drag-to-resize
        wirePanelDragAndResize();
        // Restore search input focus after re-render
        if (wasSearchFocused) {
            const newSearch = panelEl.querySelector('#aim-issues-panel-search');
            if (newSearch) {
                newSearch.focus();
                if (prevSelStart !== null) {
                    try { newSearch.setSelectionRange(prevSelStart, prevSelEnd); } catch (e) {}
                }
            }
        }
    }

    // v0.16: zoom + pan so the polygon fills a comfortable portion of
    // the map, with padding so we see context around it. Caps maxZoom
    // so a tiny issue doesn't zoom in to building-level.
    function zoomToIssue(issue) {
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L || !issue || !issue.polygon || !issue.polygon.length) return;
        try {
            const bounds = L.latLngBounds(issue.polygon);
            map.fitBounds(bounds, { padding: [80, 80], maxZoom: 19, animate: true, duration: 0.4 });
        } catch (e) {
            // Fallback to plain pan (v0.23: best-interior, not raw centroid)
            const c = bestInteriorPoint(issue.polygon);
            if (c) { try { map.panTo(c, { animate: true, duration: 0.4 }); } catch (e2) {} }
        }
    }

    // v1.06: deep-link focus. A Slack issue link carries ?aim_issue=<id>
    // (before the hash). On load / nav we read it, then once that issue is
    // loaded + the map is ready we zoom to it and open its box — and strip
    // the param so a refresh doesn't re-trigger.
    function readFocusParam() {
        try {
            let search = '';
            try { search = (window.top && window.top.location && window.top.location.search) || ''; } catch (e) {}
            if (!search) search = location.search || '';
            const m = search.match(/[?&]aim_issue=([^&]+)/);
            if (m) pendingFocusIssueId = decodeURIComponent(m[1]);
        } catch (e) { console.warn(`${TAG} readFocusParam threw:`, e); }
    }
    function clearFocusParam() {
        try {
            const w = window.top || window;
            const url = new URL(w.location.href);
            if (url.searchParams.has('aim_issue')) {
                url.searchParams.delete('aim_issue');
                w.history.replaceState(null, '', url.toString());
            }
        } catch (e) {}
    }
    function maybeFocusPendingIssue() {
        if (IS_TOP || !pendingFocusIssueId) return;   // UI + map live in the iframe
        const issue = liveIssues(currentSiteIssues).find(i => i.id === pendingFocusIssueId);
        if (!issue) return;          // not loaded yet (or another site) — retry next render
        const id = pendingFocusIssueId;
        pendingFocusIssueId = null;
        clearFocusParam();
        try {
            zoomToIssue(issue);
            openStatusModal(issue);
            console.log(`${TAG} deep-link focus → issue ${id}`);
        } catch (e) { console.warn(`${TAG} deep-link focus threw:`, e); }
    }

    // v0.16: panel drag/resize. Header drag → move; corner handle → resize.
    // Both persist to localStorage on release.
    function wirePanelDragAndResize() {
        if (!panelEl) return;
        const header = panelEl.querySelector('#aim-issues-panel-header');
        const handle = panelEl.querySelector('#aim-issues-panel-resize');

        if (header) {
            header.addEventListener('mousedown', (e) => {
                // Don't start a drag when mousing down on a button/input inside the header
                if (e.target.closest('button, input')) return;
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                startPanelDrag(e, 'move');
            });
        }
        if (handle) {
            handle.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                startPanelDrag(e, 'resize');
            });
        }
    }

    function startPanelDrag(downEvent, mode) {
        if (!panelEl || !panelLayout) return;
        panelDragInFlight = true;
        const startX = downEvent.clientX;
        const startY = downEvent.clientY;
        const startLeft = panelLayout.left;
        const startTop = panelLayout.top;
        const startWidth = panelLayout.width;
        const startHeight = panelLayout.height;

        const onMove = (e) => {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            let next;
            if (mode === 'move') {
                next = { ...panelLayout, left: startLeft + dx, top: startTop + dy };
            } else {
                next = { ...panelLayout, width: startWidth + dx, height: startHeight + dy };
            }
            const clamped = clampPanelLayout(next);
            panelLayout = clamped;
            panelEl.style.left   = `${clamped.left}px`;
            panelEl.style.top    = `${clamped.top}px`;
            panelEl.style.width  = `${clamped.width}px`;
            panelEl.style.height = `${clamped.height}px`;
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            panelDragInFlight = false;
            savePanelLayout(panelLayout);
            // Re-render once so any data changes during drag flow in
            renderIssuesPanel();
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
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

    // v0.3: dark tooltip so the issue note is readable. Leaflet's default
    // .leaflet-tooltip is white on white-ish — the note text washed out.
    // Scoped to .aim-issues-tooltip so it doesn't touch Percepto's other
    // tooltips.
    function injectStyles() {
        if (document.getElementById('aim-issues-styles')) return;
        const style = document.createElement('style');
        style.id = 'aim-issues-styles';
        style.textContent = `
            .leaflet-tooltip.aim-issues-tooltip {
                background: rgba(15, 18, 22, 0.96) !important;
                color: #ffffff !important;
                border: 1px solid rgba(255, 77, 77, 0.65) !important;
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.65) !important;
                padding: 9px 12px !important;
                border-radius: 6px !important;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
                /* v0.11: width:max-content + max-width:420px is the right
                   incantation. max-content tells the browser "use the natural
                   one-line width", max-width caps it. Long text → 420px wide
                   and wraps inside; short text → narrow box hugging the
                   content. Plain shrink-to-fit (v0.10) wasn't enough; Leaflet
                   or Percepto was squeezing the tooltip to a column. */
                white-space: normal !important;
                width: max-content !important;
                max-width: 420px !important;
            }
            .leaflet-tooltip-top.aim-issues-tooltip::before    { border-top-color:    rgba(15,18,22,0.96) !important; }
            .leaflet-tooltip-bottom.aim-issues-tooltip::before { border-bottom-color: rgba(15,18,22,0.96) !important; }
            .leaflet-tooltip-left.aim-issues-tooltip::before   { border-left-color:   rgba(15,18,22,0.96) !important; }
            .leaflet-tooltip-right.aim-issues-tooltip::before  { border-right-color:  rgba(15,18,22,0.96) !important; }
            /* v1.00: pulsing green ? badge for unseen activity. Used on
               both the map marker (absolute child of divIcon wrapper) and
               panel row indicator. The animation runs forever until the
               user opens the issue's status modal (which marks it seen). */
            @keyframes aim-issues-pulse-glow {
                0%, 100% {
                    box-shadow: 0 0 3px rgba(0, 255, 127, 0.6),
                                0 0 7px  rgba(0, 255, 127, 0.30);
                    transform: scale(1);
                }
                50% {
                    box-shadow: 0 0 10px rgba(0, 255, 127, 0.95),
                                0 0 18px rgba(0, 255, 127, 0.55);
                    transform: scale(1.12);
                }
            }
            .aim-issues-activity-dot {
                animation: aim-issues-pulse-glow 1.6s ease-in-out infinite;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    // ------- Init -------
    // ============================================================
    // v1.02 — SOP Validator bridge.
    // The Asset Inspector's SOP validators compute geometric SOP
    // violations (FFZ↔Asset standoff, FP↔Asset, FFZ↔FFZ overlap, …) and
    // hand them to us over the dedicated AIM_VALIDATOR_ISSUES channel.
    // We render them through the normal issue pipeline (markers, polygon,
    // panel, click-to-zoom) authored as 'Validator' with note 'violation:
    // …'. They are EPHEMERAL: tagged source:'validator', wiped+redrawn on
    // every run, never persisted to localStorage, never synced to GitHub
    // (see saveIssuesToStorage / commitIssuesToGitHub filters). GM storage
    // is per-script so the Asset Inspector cannot write our store directly
    // — this channel is the only handoff.
    // ============================================================
    const VALIDATOR_CHANNEL_NAME = 'AIM_VALIDATOR_ISSUES';
    let validatorChannel = null;

    function setupValidatorChannel() {
        try { validatorChannel = new BroadcastChannel(VALIDATOR_CHANNEL_NAME); }
        catch (e) { console.warn(`${TAG} validator channel unavailable:`, e); return; }
        validatorChannel.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type === 'VALIDATOR_ISSUES') applyValidatorIssues(m);
            else if (m.type === 'CLEAR_VALIDATOR_ISSUES') clearValidatorIssues(m.siteID);
        };
    }

    // Remove every previously-drawn validator issue for the given site
    // (drops Leaflet layers + the in-memory records). No persistence to
    // touch — validator issues never reach storage.
    function clearValidatorIssues(forSite) {
        if (forSite != null && String(forSite) !== String(siteID)) return;
        const map = getLeafletMap();
        let removed = 0;
        currentSiteIssues = currentSiteIssues.filter(i => {
            if (i.source !== 'validator') return true;
            const layers = issueLayers.get(i.id);
            if (layers && map) {
                try { if (layers.polygon) map.removeLayer(layers.polygon); } catch (e) {}
                try { if (layers.marker)  map.removeLayer(layers.marker);  } catch (e) {}
            }
            issueLayers.delete(i.id);
            hiddenIds.delete(i.id);
            removed++;
            return false;
        });
        if (removed) {
            renderButtonState();
            try { renderIssuesPanel(); } catch (e) {}
            console.log(`${TAG} cleared ${removed} validator issue${removed === 1 ? '' : 's'}`);
        }
    }

    // Render a fresh batch of validator findings. Wipes any prior validator
    // issues for this site first (re-runs replace, never accumulate).
    function applyValidatorIssues(m) {
        if (IS_TOP) return;                         // IFRAME owns rendering
        if (!siteID) return;
        if (m.siteID != null && String(m.siteID) !== String(siteID)) {
            console.log(`${TAG} ignoring validator issues for site ${m.siteID} (current ${siteID})`);
            return;
        }
        clearValidatorIssues(siteID);
        const incoming = Array.isArray(m.issues) ? m.issues : [];
        const nowIso = new Date().toISOString();
        let drawn = 0;
        incoming.forEach((vi, idx) => {
            const polygon = Array.isArray(vi.polygon) ? vi.polygon : null;
            if (!polygon || polygon.length < 3) return;
            const note = vi.note || 'violation';
            const id = `val_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
            const pri = (vi.priority && PRIORITY_LABEL && PRIORITY_LABEL[vi.priority]) ? vi.priority : null;
            const issue = {
                id,
                surface: 'site-setup',
                shape: vi.shape || 'polygon',
                polygon,
                note,
                status: 'open',
                priority: pri,
                createdAt: nowIso,
                createdBy: 'Validator',
                source: 'validator',
                history: [
                    { at: nowIso, by: 'Validator', fromStatus: null, toStatus: 'open', note },
                ],
            };
            currentSiteIssues.push(issue);
            try { renderOneIssue(issue); drawn++; } catch (e) { console.warn(`${TAG} renderOneIssue (validator) threw:`, e); }
        });
        renderButtonState();
        try { renderIssuesPanel(); } catch (e) {}
        showToast(`Validator: ${drawn} issue${drawn === 1 ? '' : 's'} drawn on the map.`, 3200);
        console.log(`${TAG} drew ${drawn} validator issue${drawn === 1 ? '' : 's'} for site ${siteID}`);
    }

    function init() {
        setupControlChannel();
        setupValidatorChannel();
        registerWithControlPanel();
        // v0.5: seed sync status from the cached token recovered from
        // GM storage (survives refresh). Control Panel will broadcast
        // the authoritative TOKEN_VALUE shortly after; that path also
        // (re)fetches the username.
        if (cachedToken) {
            syncStatus = cachedUsername ? 'ok' : 'syncing';
            // Refresh username in the background — handles PAT rotation.
            fetchGithubUsername();
            // v1.00: refresh approver list in the background — handles
            // boss-just-added-me scenario without requiring a script reload.
            fetchApproversList();
            // v1.03: same for the Slack notification config.
            fetchSlackConfig();
        } else {
            syncStatus = 'no-token';
        }
        // Always ask the Control Panel for the current token so we get
        // the latest if the user updated it elsewhere.
        try { if (controlChannel) controlChannel.postMessage({ type: 'REQUEST_TOKEN' }); } catch (e) {}

        // Install our own Leaflet map-tagging hook ASAP (both frames — the map
        // lives in the iframe but TOP has its own L). Leaflet may not be loaded
        // at init, so retry until it patches (or we give up after ~30s).
        if (!patchLeafletMap()) {
            let patchTries = 0;
            const patchTimer = setInterval(() => {
                if (patchLeafletMap() || ++patchTries >= 60) clearInterval(patchTimer);
            }, 500);
        }

        if (IS_TOP) {
            // TOP frame: register with Control Panel only — no UI here.
            console.log(`${TAG} v${SCRIPT_VERSION} ready (TOP — no UI in this frame)`);
            setCurrentSite(readSiteIdFromHash());
            attachHashListener();
            return;
        }
        injectStyles();
        setCurrentSite(readSiteIdFromHash());
        attachHashListener();
        ensureButton();
        // First render fires from setCurrentSite above; renderAllIssues
        // now has built-in retry-until-map-ready (v0.4).
        console.log(`${TAG} v${SCRIPT_VERSION} ready (${FRAME}) — site ${siteID || '(none)'} · token ${cachedToken ? 'cached' : 'none'} · user ${cachedUsername || '(unknown)'}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
