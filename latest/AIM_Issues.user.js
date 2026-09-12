// ==UserScript==
// @name         Latest - AIM Issues
// @namespace    http://tampermonkey.net/
// @version      1.42
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Issues.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Issues.user.js
// @description  CSM-collaborative issue flagging w/ approver oversight. 🚩 button in .map-tools. CSMs PROPOSE ignore/fix (purple/yellow); approvers APPROVE (→ resolved/ignored grey) or REJECT (→ open red). Approvers can direct-resolve without going through pending. Per-user activity indicator (green ?) flags unseen comments/transitions. Approvers list lives in aim-userscripts-data/approvers.json.
// @author       Payden
// @match        *://percepto.app/*
// @match        *://qa.percepto.app/*
// @match        https://percepto.app/*
// @match        https://qa.percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @match        https://qa.percepto.app/static/dist/react-pages/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
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
// v1.41 (#257 Fleet Issues): every site's issues in one 🌐 Fleet panel —
// landing page (opened from Fleet Tools via the tab-local DOM event
// 'aim-fleet:open-issues') or in-site (🌐 button in the Issues panel header).
// Same status modal, same role gates, same merge/Slack rules: mutations
// resolve a per-site CONTEXT from the issue id (ctxForIssue) and commit that
// site's file (commitFleetSite). TOP-frame gates are now topDefers() — TOP
// only stays passive while a site (and therefore the iframe) is loaded.
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
    const SCRIPT_VERSION = '1.42';

    // Server model (v1.36): prod and QA are separate databases — the same
    // numeric site ID is two different sites. QA issues live in their own
    // qa-<id>-issues.json files (never merged into prod's), and every Slack
    // message from a QA tab is tagged [QA].
    const IS_QA = location.hostname === 'qa.percepto.app' || location.hostname.endsWith('.qa.percepto.app');
    const envSiteKey = (sid) => IS_QA ? `qa-${sid}` : String(sid);
    const IS_TOP = window === window.top;
    const FRAME = IS_TOP ? 'TOP' : 'IFRAME';
    // v1.41 (fleet issues, #257): the frame-ownership rule. Inside a site the
    // react-pages IFRAME owns every network side effect (sync, Slack, config
    // fetches) and TOP stays passive — that's the pre-v1.41 `if (IS_TOP)
    // return` everywhere. On the LANDING page there is no iframe at all, so
    // TOP must do the work itself (the fleet issues panel lives there). One
    // predicate replaces the bare IS_TOP gates: TOP defers only while a
    // site is loaded.
    function topDefers() { return IS_TOP && !!siteID; }

    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    const SCRIPT_ID = 'aim-issues';
    const STORAGE_PREFIX = 'aim-issues-site-';

    // ------- GitHub sync constants (v0.5 Phase 2) -------
    const GITHUB_API_BASE = 'https://api.github.com';
    const ISSUES_REPO = 'Ned-Yap/aim-userscripts-data';
    const ISSUES_BRANCH = 'main';
    const ISSUES_PATH = (sid) => `issues/${envSiteKey(sid)}-issues.json`;
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
    const CAT_APPROVERS_KEY = 'aim-issues-cat-approvers';  // v1.31: cached per-category approver map
    const SLACK_CONFIG_KEY = 'aim-issues-slack-config'; // cached slack-config.json
    // v1.41: fleet issues cache — { [sid]: { sha, issues, name } } for every
    // site file in the data repo, keyed per environment (QA files are qa-<id>).
    // sha-diffed against the issues/ listing so only changed files re-download.
    const FLEET_CACHE_KEY = 'aim-issues-fleet-cache' + (IS_QA ? '-qa' : '');

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
        const issue = resolveIssue(issueId);   // v1.41: site OR fleet copy
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
    // v1.31: per-category approvers. approvers.json may carry an optional
    //   "categoryApprovers": { "unshielded": ["DanielleC-AIM", ...] }
    // block — those logins get approver powers ONLY for issues of that
    // category (union with the global approvers list, who can approve
    // everything). Absent/empty block = identical to pre-v1.31 behavior.
    let categoryApprovers = (function() {
        try { const raw = gmGet(CAT_APPROVERS_KEY, ''); if (!raw) return {};
              const obj = JSON.parse(raw); return (obj && typeof obj === 'object') ? obj : {}; }
        catch (e) { return {}; }
    })();
    function isApprover() {
        if (!cachedUsername) return false;                // local-only / no token
        return approversList.includes(cachedUsername);
    }
    // v1.31: issue category. Only 'unshielded' is meaningful today; any
    // other/absent value renders + behaves as a normal issue (so old
    // clients and old records degrade gracefully).
    const CATEGORY_META = {
        unshielded: { text: 'UNSHIELDED ROUTE', short: 'Unshielded', color: '#b26bff' },
    };
    function issueCategory(issue) {
        return (issue && issue.category === 'unshielded') ? 'unshielded' : 'issue';
    }
    function isUnshielded(issue) { return issueCategory(issue) === 'unshielded'; }
    // Per-issue approver check: global approver OR category approver for
    // this issue's category. This is what all moderation gates use.
    function isApproverFor(issue) {
        if (isApprover()) return true;
        if (!cachedUsername || !issue) return false;
        const list = categoryApprovers[issueCategory(issue)];
        return Array.isArray(list) && list.includes(cachedUsername);
    }
    // Can this user approve ANYTHING? Gates the review-oriented panel UI
    // (pending shortcut); per-issue power still comes from isApproverFor.
    function isAnyApprover() {
        if (isApprover()) return true;
        if (!cachedUsername) return false;
        return Object.values(categoryApprovers).some(l => Array.isArray(l) && l.includes(cachedUsername));
    }
    function currentRole() {
        return isApprover() ? 'approver' : 'csm';
    }
    function roleFor(issue) {
        return isApproverFor(issue) ? 'approver' : 'csm';
    }
    const shaBySite = {};                                // {[siteID]: 'sha-from-last-GET-or-PUT'}
    // v1.41 (#257): fleet store — one context per site loaded by the fleet
    // issues panel: { sid, name, issues, sha, access, committing, commitAgain }.
    // The CURRENT site is never duplicated here: ctxForSid(siteID) aliases the
    // live currentSiteIssues so in-site edits and fleet edits share one list.
    const fleetStore = new Map();
    let fleetSites = null;          // Map<sid, {name, status, client}> from /sites/ (null = not loaded)
    let fleetLoadedAt = 0;
    let fleetLoading = false;
    let fleetLoadError = '';
    let fleetHiddenNoAccess = 0;    // issue files whose site is NOT in the user's /sites/ list
    let fleetPanelEl = null;
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
    const MAP_OBJECTS_URL = '/map_objects/?getPoiMapObjectsAsList=true&site_id=';
    let mapObjects = null;                                // { siteID, entities: [...] }
    let mapObjectsFetching = false;
    const issueAffectedCache = new Map();                 // issueId → array of affected entities
    const issueLayers = new Map();               // issueId → { polygon, marker }
    let drawingState = null;
    // v1.30: reshape flow — non-null while the user is redrawing an issue's
    // polygon from the status modal. { issueId, ghost, pending, previewLayer }.
    // The grey dashed ghost exists ONLY while this is set.
    let reshapeState = null;
    // v1.37: move-icon flow — non-null while the user is dragging an issue's
    // marker to a custom spot. { issueId, pending: [lat,lng]|null }.
    let markerMoveState = null;
    let drawToolbarEl = null;
    let noteModalEl = null;
    let statusModalEl = null;
    // v0.15: dedicated 🚩 panel (M2 on the toolbar 🚩 button opens it)
    let panelEl = null;
    // Filter chips — Set of allowed statuses. Empty == all hidden (rare).
    // v1.00: include pending_fix + pending_ignore by default; keep legacy
    // ready-for-review for grandfathered issues.
    const panelFilters = new Set(['open', 'pending_fix', 'pending_ignore', 'ready-for-review', 'resolved', 'ignored']);
    // v1.31: category filter — both shown by default. Same M1 toggle / M2
    // solo semantics as the status chips.
    const panelCategoryFilters = new Set(['issue', 'unshielded']);
    // v0.29: priority filter chips. Uses the literal string 'none' for
    // issues with no priority (issue.priority === null/undefined). All
    // four active by default. M1 toggle, M2 solo (same as status chips).
    const panelPriorityFilters = new Set(['high', 'medium', 'low', 'none']);
    let panelSearch = '';
    let panelAssignedToMe = false;   // v1.12: "Assigned to me" filter toggle
    let panelShowDeleted = false;    // v1.26: approver-only "Deleted" view toggle
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

    // ------- v1.41: issue context resolution (site vs fleet) -------
    // Every mutation used to read the ambient globals (siteID /
    // currentSiteIssues). They now resolve a CONTEXT from the issue id, so
    // the same applyTransition/applyComment/... work on any site's issues
    // loaded by the fleet panel. Issue ids are globally unique
    // (iss_<ms>_<rand6>), and the current site is never held twice.
    function siteCtx() {
        return {
            sid: siteID, name: siteName, isSite: true,
            get issues() { return currentSiteIssues; },
            set issues(v) { currentSiteIssues = v; },
        };
    }
    function ctxForSid(sid) {
        if (!sid) return null;
        if (siteID && String(sid) === String(siteID) && !IS_TOP) return siteCtx();
        // TOP frame inside a site: the iframe owns the live list; the fleet
        // copy (if loaded) is the best we have there.
        if (siteID && String(sid) === String(siteID) && IS_TOP && !fleetStore.has(String(sid))) return siteCtx();
        return fleetStore.get(String(sid)) || null;
    }
    function ctxForIssue(issueId) {
        if (!issueId) return null;
        if (currentSiteIssues.some(i => i && i.id === issueId)) return siteCtx();
        for (const ctx of fleetStore.values()) {
            if ((ctx.issues || []).some(i => i && i.id === issueId)) return ctx;
        }
        return null;
    }
    function resolveIssue(issueId) {
        const ctx = ctxForIssue(issueId);
        return ctx ? (ctx.issues || []).find(i => i && i.id === issueId) || null : null;
    }
    // Persist a context locally: the current site → localStorage (as before);
    // a fleet site → the GM fleet cache entry (so a reload shows the edit
    // even before the next GitHub refresh).
    function persistCtx(ctx) {
        if (!ctx) return;
        if (ctx.isSite) { saveIssuesToStorage(siteID, currentSiteIssues); return; }
        fleetCacheWrite(ctx);
    }
    // Commit a context to GitHub. Current site → the serialized single-site
    // path; fleet site → its own per-site serialized PUT (commitFleetSite).
    function commitCtx(ctx, reason) {
        if (!ctx) return Promise.resolve(false);
        // v1.42: inside a bulk batch, record the site instead of PUTting —
        // runBulk commits each touched site ONCE afterwards.
        if (bulkBatch) {
            bulkBatch.touched.set(String(ctx.sid), ctx);
            bulkBatch.reasons.push(reason);
            return Promise.resolve(true);
        }
        if (ctx.isSite) return commitIssuesToGitHub(reason);
        return commitFleetSite(ctx, reason);
    }
    // Re-render whatever surfaces show this context. Map layers only exist
    // for the current site; the fleet panel refreshes for every context.
    function rerenderCtx(ctx, issue) {
        if (ctx && ctx.isSite && issue) renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        renderButtonState();
        if (fleetPanelEl) renderFleetPanel();
    }

    function setCurrentSite(newId) {
        if (newId === siteID) return;
        siteID = newId;
        // v1.41: fleet housekeeping. TOP entering a site hands the UI to the
        // iframe (close our fleet panel/modal there); every frame re-marks
        // which fleet context aliases the live current-site list.
        if (IS_TOP && newId && fleetPanelEl) { closeFleetPanel(); closeStatusModal(); }
        fleetStore.forEach(c => { c.isCurrentAlias = !!(newId && String(c.sid) === String(newId) && !IS_TOP); });
        readFocusParam();   // v1.06: a deep-link nav may carry ?aim_issue=<id>
        // v0.20: refresh friendly site name. Retries below in case the
        // .site-select widget isn't mounted yet on initial load.
        siteName = readSiteName();
        if (!siteName && newId) tickReadSiteName(0);
        // v1.30: a site nav mid-reshape abandons the reshape (the ghost's map
        // is going away with the old site's layers).
        cancelReshape({ silent: true });
        cancelMarkerMove({ silent: true });   // v1.37: same for a mid-move nav
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
            else {
                syncStatus = 'ok'; renderButtonState();
                // v1.41: landing page (TOP, no site) — warm the fleet list so
                // the Fleet Tools badge + panel are instant.
                if (IS_TOP) fleetLoad(false);
            }
            if (fleetPanelEl && !fleetLoading) fleetLoad(false);
        });
    }

    async function fetchGithubUsername() {
        if (topDefers()) return;   // IFRAME owns sync inside a site (v1.41: TOP works on the landing page)
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
        if (topDefers()) return;
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
            // v1.31: optional per-category approvers block (union with global).
            const catMap = (data && data.categoryApprovers && typeof data.categoryApprovers === 'object')
                ? data.categoryApprovers : {};
            categoryApprovers = catMap;
            gmSet(CAT_APPROVERS_KEY, JSON.stringify(catMap));
            const catNote = Object.keys(catMap).filter(k => (catMap[k] || []).length)
                .map(k => `${k}: ${catMap[k].join(', ')}`).join(' | ');
            console.log(`${TAG} approvers loaded (${list.length}): ${list.join(', ')}${catNote ? ` · category approvers — ${catNote}` : ''} — you are ${isApprover() ? 'an APPROVER ✓' : (isAnyApprover() ? 'a CATEGORY APPROVER ✓' : 'a CSM')}`);
            // Refresh UI that depends on role
            if (panelEl) renderIssuesPanel();
            if (fleetPanelEl) renderFleetPanel();
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
        if (topDefers()) return;       // IFRAME owns sync inside a site, same as approvers
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
        // v1.40: muteAll is a fleet-wide EMERGENCY KILL SWITCH — set
        // "muteAll": true in aim-userscripts-data/slack-config.json and every
        // v1.40+ browser goes Slack-silent on its next config fetch (page
        // load), without waiting ~24h for a Tampermonkey script update.
        if (slackConfig && slackConfig.muteAll) return false;
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
    // v1.14: plain @login DISPLAY text — never a real <@id> mention, so it
    // never pings. Use for the "who did it" actor/creator in message heads;
    // real slackMention() is reserved for people we actually want to notify.
    function slackPlain(login) {
        return login && login !== 'local-only' ? `@${slackEsc(login)}` : '@?';
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
        if (topDefers()) return null;   // IFRAME owns the flow inside a site
        return slackPostRaw(text, threadTs);
    }
    // v1.22: frame-agnostic post core. slackPost keeps the IS_TOP guard for
    // the current-site flow; the global stale sweep (TOP frame) calls this
    // directly because TOP is exactly where the cross-site sweep must run.
    async function slackPostRaw(text, threadTs) {
        if (!slackEnabled()) return null;
        if (IS_QA) text = `[QA] ${text}`;   // QA traffic is unmistakable in the channel
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

    // Should this issue ever generate Slack traffic?
    //  • local-only issues never sync → never post.
    //  • validator findings (ephemeral, self-diagnose-and-fix) default OFF —
    //    they post only when the user opts a specific one in via the
    //    "🔔 Notify Slack" toggle (v1.19). Field absent/false = off.
    //  • normal issues are unchanged — auto-ping.
    function slackPostable(issue) {
        if (!slackEnabled() || !issue || issue.createdBy === 'local-only') return false;
        if (issue.source === 'validator') return !!issue.slackNotifyOptIn;   // default OFF
        return true;
    }

    // v1.05: linked site label — clickable in Slack, jumps straight to the
    // site's Site Setup. <url|text> is Slack's link syntax; text can't hold
    // | or <>, which site names never do. v1.06: when issueId is given, the
    // URL carries ?aim_issue=<id> (before the hash, so SPA routing keeps it)
    // and AIM Issues focuses that issue on load — see maybeFocusIssueFromUrl.
    // v1.22: sidOverride/nameOverride let the global stale sweep (TOP frame,
    // no open site) build a label for ANY site, not just the current one.
    function siteLabelForSlack(issueId, sidOverride, nameOverride) {
        // v1.41: no override → the issue's own context (fleet panel acts on
        // OTHER sites' issues, whose sid/name aren't the ambient globals).
        const c = (!sidOverride && issueId) ? ctxForIssue(issueId) : null;
        const sid = sidOverride || (c && c.sid) || siteID;
        const name = sidOverride ? nameOverride : (c ? (c.name || '') : siteName);
        const label = name ? slackEsc(name) : `site ${sid}`;
        const q = issueId ? `?aim_issue=${encodeURIComponent(issueId)}` : '';
        return `<${location.origin}/${q}#/site/${sid}/control-panel/site-setup|${label}>`;
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
    function slackParentText(issue, statusOverride, sidOverride, nameOverride) {
        const status = statusOverride || issue.status || 'open';
        const b = slackStatusBadge(status);
        const pri = issue.priority ? ` \`[${priorityMeta(issue.priority).text}]\`` : '';
        // v1.17: PLAIN @text for the filer (no real <@id> mention) — a real
        // mention here pinged the creator and made them follow the thread,
        // so they got notified of every later reply. Real pings are reserved
        // for the cc list + transition/comment recipients.
        const creator = slackPlain(issue.createdBy);
        const link = siteLabelForSlack(issue.id, sidOverride, nameOverride);
        let note = slackEsc(issue.note || '(no description)');
        if (b.strike) note = `~${note}~`;
        // v1.12: assignee shown as PLAIN @text (not a real <@id> mention) so
        // re-rendering the parent on every transition never re-pings them —
        // the actual ping happens in the assignment thread reply.
        const assignedSuffix = issue.assignee ? ` · 👤 @${slackEsc(issue.assignee)}` : '';
        // v1.31: unshielded routes are labeled as such on the parent board.
        const kindLabel = isUnshielded(issue) ? '🛡✕ *Unshielded Route*' : 'issue';
        const lines = [
            `${b.icon} *${b.text}* — ${kindLabel} on ${link}${pri}`,
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
        if (topDefers()) return false;   // IFRAME owns the flow inside a site
        return slackUpdateRaw(ts, text);
    }
    // v1.22: frame-agnostic chat.update core, mirrors slackPostRaw. The global
    // stale sweep (TOP frame) uses it to refresh parent boards on other sites.
    async function slackUpdateRaw(ts, text) {
        if (!slackEnabled() || !ts) return false;
        if (IS_QA) text = `[QA] ${text}`;   // keep the tag through parent-board updates
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
            const ctx = ctxForIssue(issue.id) || siteCtx();
            const live = resolveIssue(issue.id) || issue;
            live.slackNotify = mentionLogins;
            const ts = await slackPost(slackParentText(live, null), null);
            if (ts) {
                live.slackThreadTs = ts;
                persistCtx(ctx);
                commitCtx(ctx, `attach slack thread to ${issue.id.slice(0, 14)}`);
                // v1.08: thread = immutable history. Post sequentially so
                // order is guaranteed: (1) original report, (2) affected
                // entities, then transitions append after.
                await postSlackOriginalRequest(live, ts);
                await postSlackAffectedEntities(live, ts);
                markSlackPosted(live);   // v1.29: created issue is caught up
            }
        } catch (e) {
            console.warn(`${TAG} postSlackNewIssue threw:`, e);
        }
    }

    // v1.18: adopt-on-first-touch. An issue created before Slack existed has
    // no parent message. The first time someone acts on it (transition /
    // comment / assignment), backfill a parent status board + the two seed
    // replies and stamp the thread ts, so from then on it behaves like a
    // native issue. Returns the thread ts (or null). No-op if it already has
    // a thread, isn't postable, or the parent post fails. NOT used on delete
    // (no point creating a thread just to strike it).
    async function ensureSlackThread(issue) {
        if (issue.slackThreadTs) return issue.slackThreadTs;
        if (!slackPostable(issue)) return null;
        try {
            const ts = await slackPost(slackParentText(issue, null), null);
            if (!ts) return null;
            const ctx = ctxForIssue(issue.id) || siteCtx();
            const live = resolveIssue(issue.id) || issue;
            live.slackThreadTs = ts;
            if (issue !== live) issue.slackThreadTs = ts;   // caller's ref too
            persistCtx(ctx);   // strips validator
            // v1.19: validator findings are ephemeral — the ts lives in memory
            // only (session-scoped). Don't churn a GitHub commit for them.
            if (live.source !== 'validator') {
                commitCtx(ctx, `adopt slack thread for ${issue.id.slice(0, 14)}`);
            }
            await postSlackOriginalRequest(live, ts);
            await postSlackAffectedEntities(live, ts);
            console.log(`${TAG} adopted pre-Slack issue ${issue.id} → thread ${ts}`);
            return ts;
        } catch (e) {
            console.warn(`${TAG} ensureSlackThread threw:`, e);
            return null;
        }
    }

    // v1.08: original report → first thread reply, preserved verbatim so
    // editing the parent (live status board) never loses what was filed.
    async function postSlackOriginalRequest(issue, threadTs) {
        if (!slackEnabled() || !threadTs) return;
        try {
            const creator = slackPlain(issue.createdBy);
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
            const actor = slackPlain(by);
            await slackPost(`🗑 ${actor} *deleted* this issue`, issue.slackThreadTs);
            await slackUpdate(issue.slackThreadTs, slackParentText(issue, 'deleted'));
            markSlackPosted(issue);   // v1.29: advance watermark on success
        } catch (e) {
            console.warn(`${TAG} postSlackDelete threw:`, e);
        }
    }

    // v1.26: reinstate → threaded reply + un-strike the parent message (its
    // text reverts to the restored status since issue.status is already set).
    async function postSlackReinstate(issue, by) {
        if (!slackPostable(issue) || !issue.slackThreadTs) return;
        try {
            const actor = slackPlain(by);
            await slackPost(`♻ ${actor} *reinstated* this issue`, issue.slackThreadTs);
            await slackUpdate(issue.slackThreadTs, slackParentText(issue));
            markSlackPosted(issue);   // v1.29: advance watermark on success
        } catch (e) {
            console.warn(`${TAG} postSlackReinstate threw:`, e);
        }
    }

    // Status transition → threaded reply. Role-aware mention:
    //  • CSM proposes (→ pending_*)         → ping approvers to review
    //  • approver approves/rejects pending  → cc the original proposer
    //  • direct resolve / reopen / un-ignore → no mention
    async function postSlackTransition(issue, fromStatus, transition, note, by) {
        // Intentionally-silent cases (no warning): local-only issues never
        // sync, and opted-out validator findings are silent by design.
        if (!issue || issue.createdBy === 'local-only') return;
        if (issue.source === 'validator' && !issue.slackNotifyOptIn) return;
        // v1.27: this is a NORMAL issue that should notify. If Slack isn't ready
        // (config didn't load or raced this session), try ONE on-demand refetch
        // — postSlackTransition runs in the IFRAME (the GitHub commit already
        // succeeded), so fetchSlackConfig actually executes here. If it's STILL
        // unavailable, tell the actor instead of failing silently: the prior
        // behaviour skipped Slack with zero feedback, so a missed notification
        // looked identical to a successful one (the bug Chris hit on 06-23).
        if (!slackEnabled() && cachedToken) {
            try { await fetchSlackConfig(); } catch (e) {}
        }
        if (!slackEnabled()) {
            console.warn(`${TAG} Slack NOT notified for ${issue.id} — config unavailable this session`);
            showToast('⚠ Saved + synced to GitHub, but Slack was NOT notified — Slack config didn\'t load this session. A page reload usually fixes it.', 7000);
            return;
        }
        try {
            await ensureSlackThread(issue);   // v1.18: adopt pre-Slack issues
            const actor = slackPlain(by);
            const toLabel = (STATUS_LABEL[transition.to] || { text: transition.to.toUpperCase() }).text;
            // v1.13/v1.14: never ping the actor for their own action.
            //  • propose → ping the OTHER approvers (review needed)
            //  • approve/reject → ping the ASSIGNED CSM (falls back to the
            //    proposer if nobody's assigned) so they know the outcome
            const reviewTarget = issue.assignee || proposerOf(issue);
            const reviewMention = (reviewTarget && reviewTarget !== by) ? slackMention(reviewTarget) : '';
            let head, mention = '';
            if (transition.to === 'pending_fix') {
                head = `🟡 ${actor} proposed *FIX* — needs review`;
                mention = slackMentionApprovers(by);
            } else if (transition.to === 'pending_ignore') {
                head = `🟣 ${actor} proposed *IGNORE* — needs review`;
                mention = slackMentionApprovers(by);
            } else if (transition.approvalCheck && transition.to === 'open') {
                head = `❌ ${actor} *rejected* → back to OPEN`;
                mention = reviewMention;
            } else if (transition.approvalCheck) {
                head = `✅ ${actor} *approved* → ${toLabel}`;
                mention = reviewMention;
            } else if (transition.to === 'open') {
                head = `↺ ${actor} re-opened → OPEN`;
            } else {
                head = `✅ ${actor} → ${toLabel}`;
            }
            const lines = [head];
            if (note) lines.push(`>${slackEsc(note)}`);
            if (mention) lines.push(`cc ${mention}`);
            const text = issue.slackThreadTs ? lines.join('\n')
                       : `${lines.join('\n')}\n_(${slackEsc((issue.note || '').slice(0, 80))} — ${siteLabelForSlack(issue.id)})_`;
            // v1.27: capture the result. slackPost returns the message ts on
            // success, null on any API failure (bad token, not_in_channel,
            // rate limit — all of which slackPost logs). Surface a failure to
            // the actor so a dropped notification isn't silent.
            const replyTs = await slackPost(text, issue.slackThreadTs || null);
            if (!replyTs) {
                showToast('⚠ Saved + synced to GitHub, but the Slack post failed (Slack API error — check the bot token / channel). See console for the reason.', 7000);
            }
            // v1.08: parent is a live status board — reflect EVERY transition
            // (pending/resolved/ignored/reopen). issue.status is already the
            // new status here (applyTransition set it before calling us).
            if (issue.slackThreadTs) {
                await slackUpdate(issue.slackThreadTs, slackParentText(issue));
            }
            if (replyTs) markSlackPosted(issue);   // v1.29: advance watermark on success
        } catch (e) {
            console.warn(`${TAG} postSlackTransition threw:`, e);
            showToast('⚠ Saved + synced, but the Slack notification threw an error (see console).', 7000);
        }
    }

    // v1.12: assignment → threaded reply + pings the new assignee. Parent
    // status board also re-rendered (shows assignee).
    async function postSlackAssignment(issue, from, to, by) {
        if (!slackPostable(issue)) return;
        try {
            await ensureSlackThread(issue);   // v1.18: adopt pre-Slack issues
            const actor = slackPlain(by);
            let head;
            if (!to) {
                head = `👤 ${actor} *unassigned* this issue`;
            } else if (to === by) {
                head = `👤 ${actor} *self-assigned* this issue`;
            } else {
                head = `👤 ${actor} *assigned* this to ${slackMention(to) || ('@' + slackEsc(to))}`;
            }
            const text = issue.slackThreadTs ? head
                       : `${head}\n_(${slackEsc((issue.note || '').slice(0, 80))} — ${siteLabelForSlack(issue.id)})_`;
            await slackPost(text, issue.slackThreadTs || null);
            if (issue.slackThreadTs) await slackUpdate(issue.slackThreadTs, slackParentText(issue));
            markSlackPosted(issue);   // v1.29: advance watermark on success
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
            await ensureSlackThread(issue);   // v1.18: adopt pre-Slack issues
            const actor = slackPlain(by);
            const body = slackifyMentions(slackEsc(note));
            // v1.13: don't ping yourself in your own comment.
            const cc = (notifyLogins || []).filter(l => l && l !== by).map(slackMention).filter(Boolean).join(' ');
            let head = `💬 ${actor}: ${body}`;
            if (cc) head += `\ncc ${cc}`;
            const text = issue.slackThreadTs ? head
                       : `${head}\n_(${slackEsc((issue.note || '').slice(0, 80))} — ${siteLabelForSlack(issue.id)})_`;
            await slackPost(text, issue.slackThreadTs || null);
            markSlackPosted(issue);
        } catch (e) {
            console.warn(`${TAG} postSlackComment threw:`, e);
        }
    }

    // v1.31: category conversion → threaded reply + parent board refresh (the
    // parent label changes between "issue" and "Unshielded Route"). No pings.
    async function postSlackCategoryChange(issue, from, to, by) {
        if (!slackPostable(issue)) return;
        try {
            await ensureSlackThread(issue);
            const actor = slackPlain(by);
            const head = (to === 'unshielded')
                ? `🛡 ${actor} marked this as an *Unshielded Route*`
                : `🚩 ${actor} converted this back to a *normal issue*`;
            const text = issue.slackThreadTs ? head
                       : `${head}\n_(${slackEsc((issue.note || '').slice(0, 80))} — ${siteLabelForSlack(issue.id)})_`;
            await slackPost(text, issue.slackThreadTs || null);
            if (issue.slackThreadTs) await slackUpdate(issue.slackThreadTs, slackParentText(issue));
            markSlackPosted(issue);
        } catch (e) {
            console.warn(`${TAG} postSlackCategoryChange threw:`, e);
        }
    }

    // v1.30: reshape → threaded reply with the refreshed affected-entity
    // count. No mentions — geometry edits aren't actionable pings. Parent
    // board untouched (status/note unchanged, and it carries no geometry).
    async function postSlackReshape(issue, by, note) {
        if (!slackPostable(issue)) return;
        try {
            await ensureSlackThread(issue);   // adopt pre-Slack issues
            const actor = slackPlain(by);
            const affected = affectedEntitiesFor(issue);
            const nVerts = Array.isArray(issue.polygon) ? issue.polygon.length : '?';
            // v1.38: the ↩ Undo path passes a note so the thread reads
            // "moved → undone" instead of two indistinguishable reshapes.
            const head = `✏ ${actor} *reshaped* this issue's area (${nVerts}-point ${slackEsc(issue.shape || 'polygon')}) — now affects ${affected.length} entit${affected.length === 1 ? 'y' : 'ies'}`
                + (note ? ` — _${slackEsc(note)}_` : '');
            const text = issue.slackThreadTs ? head
                       : `${head}\n_(${slackEsc((issue.note || '').slice(0, 80))} — ${siteLabelForSlack(issue.id)})_`;
            await slackPost(text, issue.slackThreadTs || null);
            markSlackPosted(issue);
        } catch (e) {
            console.warn(`${TAG} postSlackReshape threw:`, e);
        }
    }

    // ===== v1.29: Slack watermark + on-open reconcile + manual resend =====
    //
    // The watermark `slackPostedHistoryLen` records how many history entries
    // have been reflected to Slack. It advances ONLY after a confirmed post
    // (so a silent failure leaves it behind) and is committed to GitHub so
    // every session shares it. On site-open the IFRAME compares each issue's
    // history length to its watermark; anything ahead means a transition never
    // reached Slack while the actor's Slack was down — we post a catch-up reply
    // and refresh the parent board. Pre-watermark issues are migrated to
    // "already caught up" (watermark = current length) so we never spam the
    // whole backlog — use the manual 📣 Resend button to recover those.

    // Advance + persist the watermark after a confirmed Slack post. Commits so
    // other sessions don't re-backfill what we just posted.
    function markSlackPosted(issue) {
        if (!issue) return;
        const ctx = ctxForIssue(issue.id) || siteCtx();   // v1.41: fleet-aware
        const live = resolveIssue(issue.id) || issue;
        if (!live || live.source === 'validator' || live.createdBy === 'local-only') return;
        const len = Array.isArray(live.history) ? live.history.length : 0;
        if ((live.slackPostedHistoryLen || 0) >= len) return;   // already current
        live.slackPostedHistoryLen = len;
        persistCtx(ctx);
        if (cachedToken) commitCtx(ctx, `slack watermark ${live.id.slice(0, 14)}→${len}`);
    }

    // Plain Slack-mrkdwn one-liner describing a history entry (for catch-up).
    function slackHistLine(h) {
        const by = slackPlain(h.by || '?');
        if (h.kind === 'reinstate') return `${by} reinstated`;
        if (h.toStatus === 'deleted') return `${by} deleted`;
        if (h.kind === 'assign') return h.toAssignee ? `${by} assigned → ${slackMention(h.toAssignee) || ('@' + slackEsc(h.toAssignee))}` : `${by} unassigned`;
        if (h.kind === 'priority') return `${by} set priority → ${slackEsc((h.toPriority || 'none'))}`;
        if (h.kind === 'reshape') return `${by} reshaped the area${h.note ? ` — ${slackEsc(h.note.slice(0, 80))}` : ''}`;
        if (h.kind === 'markermove') return h.markerPos ? `${by} moved the map icon` : `${by} reset the map icon position`;
        if (h.kind === 'category') return (h.toCategory === 'unshielded') ? `${by} marked as Unshielded Route` : `${by} converted to normal issue`;
        if (h.kind === 'comment' || (h.fromStatus && h.fromStatus === h.toStatus)) return `${by} commented: ${slackEsc((h.note || '').slice(0, 80))}`;
        if (!h.fromStatus) return `${by} created`;
        const f = (STATUS_LABEL[h.fromStatus] || { text: h.fromStatus }).text;
        const t = (STATUS_LABEL[h.toStatus] || { text: h.toStatus }).text;
        return `${by}: ${f} → ${t}`;
    }

    // Post a single consolidated catch-up reply for the missed history entries,
    // then refresh the parent board to the current status.
    async function backfillSlackForIssue(issue) {
        try {
            const wm = issue.slackPostedHistoryLen || 0;
            // v1.40: NEVER re-blast 'bump' entries. The v1.38 global sweep
            // wrote bump history from the TOP frame without advancing the
            // watermark, so the next site-open saw "history ahead of Slack"
            // and posted a Catch-up reply per issue re-describing bumps that
            // HAD already posted — the 2026-08-27 ~30-message burst. Bumps
            // are dead (v1.39) and were never lifecycle events anyway.
            const missed = (issue.history || []).slice(wm).filter(h => h.kind !== 'bump');
            if (!missed.length) { markSlackPosted(issue); return; }   // bumps only — advance silently
            if (!issue.slackThreadTs) return;
            const lines = missed.map(h => `• ${slackHistLine(h)}`);
            const txt = `🔄 *Catch-up* — these updates happened while Slack was unreachable:\n${lines.join('\n')}`;
            const ts = await slackPost(txt, issue.slackThreadTs);
            await slackUpdate(issue.slackThreadTs, slackParentText(issue));
            if (ts) markSlackPosted(issue);
        } catch (e) {
            console.warn(`${TAG} backfillSlackForIssue threw:`, e);
        }
    }

    // Run once per site after issues are loaded. Migrates pre-watermark issues
    // to caught-up, and backfills any issue whose history ran ahead of Slack.
    let slackReconciledSite = null;
    async function reconcileSlackOnOpen() {
        if (topDefers()) return;            // IFRAME owns Slack inside a site
        if (!siteID || !cachedToken) return;
        if (slackReconciledSite === siteID) return;
        if (!slackEnabled()) { try { await fetchSlackConfig(); } catch (e) {} }
        if (!slackEnabled()) return;        // can't reconcile without Slack
        slackReconciledSite = siteID;
        let migrated = 0;
        const behind = [];
        for (const issue of currentSiteIssues) {
            if (!issue || issue.source === 'validator' || issue.createdBy === 'local-only' || issue.deleted) continue;
            if (!slackPostable(issue)) continue;
            const len = (issue.history || []).length;
            if (issue.slackPostedHistoryLen == null) {
                issue.slackPostedHistoryLen = len;   // migrate — assume caught up
                migrated++;
            } else if (len > issue.slackPostedHistoryLen && issue.slackThreadTs) {
                behind.push(issue);
            }
        }
        if (migrated) {
            saveIssuesToStorage(siteID, currentSiteIssues);
            if (cachedToken) commitIssuesToGitHub(`init slack watermarks (${migrated})`);
        }
        if (behind.length) {
            console.warn(`${TAG} Slack reconcile: ${behind.length} issue(s) behind Slack — backfilling`);
            showToast(`🔄 Catching Slack up on ${behind.length} issue${behind.length === 1 ? '' : 's'} that changed while Slack was offline…`, 5000);
            for (const issue of behind) await backfillSlackForIssue(issue);
        }
    }

    // Manual approver action: re-post the current status to Slack (creating the
    // thread if missing). Recovers a notification that silently failed before
    // the watermark existed (e.g. the 06-23 miss).
    function resendIssueToSlack(id) {
        const issue = resolveIssue(id);   // v1.41: site or fleet copy
        if (!issue) return;
        if (!isApproverFor(issue)) { showToast('Only an approver can resend to Slack.', 4000); return; }
        if (issue.createdBy === 'local-only' || issue.source === 'validator') {
            showToast('This issue type doesn\'t post to Slack.', 4000); return;
        }
        (async () => {
            if (!slackEnabled() && cachedToken) { try { await fetchSlackConfig(); } catch (e) {} }
            if (!slackEnabled()) { showToast('Slack config not available this session — reload and retry.', 5000); return; }
            try {
                const ts = await ensureSlackThread(issue);   // creates parent if missing
                const threadTs = ts || issue.slackThreadTs;
                if (!threadTs) { showToast('Could not create/find the Slack thread.', 5000); return; }
                const actor = slackPlain(cachedUsername || '?');
                const stat = (STATUS_LABEL[issue.status || 'open'] || { text: (issue.status || 'open').toUpperCase() }).text;
                const reply = await slackPost(`📣 ${actor} re-sent the current status: *${stat}*`, threadTs);
                await slackUpdate(threadTs, slackParentText(issue));
                if (reply) markSlackPosted(issue);
                showToast(reply ? 'Re-sent to Slack ✓' : '⚠ Slack resend failed (see console).', 4000);
            } catch (e) {
                console.warn(`${TAG} resendIssueToSlack threw:`, e);
                showToast('⚠ Slack resend threw an error (see console).', 4000);
            }
        })();
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

    // v1.30: latest valid kind:'reshape' entry in a (union-merged) history —
    // its polygon/toShape are the current geometry. Returns null when the
    // history holds no reshape (i.e. the creation polygon still stands).
    // >= on the tie-break so a same-timestamp duplicate resolves to the later
    // list position, matching mergeHistoryArrays' stable sort.
    function latestReshapeFromHistory(history) {
        let best = null, bestAt = -Infinity;
        (history || []).forEach(h => {
            if (!h || h.kind !== 'reshape') return;
            if (!Array.isArray(h.polygon) || h.polygon.length < 3) return;
            const t = new Date(h.at).getTime();
            const at = isNaN(t) ? 0 : t;
            if (at >= bestAt) { bestAt = at; best = h; }
        });
        return best;
    }

    // v1.37: derive the marker's custom position from a (union-merged)
    // history. The latest kind:'markermove' entry wins (markerPos may be
    // null = "reset to auto"), EXCEPT when a reshape is chronologically
    // newer — a redrawn polygon invalidates the old hand-placed spot, so
    // reshape resets the icon to automatic placement. No markermove entry
    // at all → fallback (stored field; normally undefined = auto).
    function markerPosFromHistory(history, fallback) {
        let best = null, bestAt = -Infinity, reshapeAt = -Infinity;
        (history || []).forEach(h => {
            if (!h) return;
            const t = new Date(h.at).getTime();
            const at = isNaN(t) ? 0 : t;
            if (h.kind === 'reshape') { if (at >= reshapeAt) reshapeAt = at; return; }
            if (h.kind !== 'markermove') return;
            if (at >= bestAt) { bestAt = at; best = h; }
        });
        if (!best) return fallback;
        if (reshapeAt > bestAt) return null;
        const p = best.markerPos;
        return (Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1])) ? p : null;
    }

    // v1.38: ↩ Undo target for the LATEST reshape — the geometry an undo
    // would restore. Prefers the entry's own fromPolygon (recorded since
    // v1.38, exact), else falls back to the previous reshape entry's polygon.
    // Returns { shape, polygon, entry } or null when nothing is restorable
    // (no reshape at all, or a legacy first reshape whose creation polygon
    // was never recorded). Undo NEVER removes history — union-merge would
    // resurrect it from any other copy — it appends a compensating entry.
    function reshapeUndoTarget(issue) {
        const reshapes = ((issue && issue.history) || [])
            .filter(h => h && h.kind === 'reshape' && Array.isArray(h.polygon) && h.polygon.length >= 3)
            .sort((a, b) => {
                const ta = new Date(a.at).getTime(), tb = new Date(b.at).getTime();
                return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
            });
        if (!reshapes.length) return null;
        const last = reshapes[reshapes.length - 1];
        if (Array.isArray(last.fromPolygon) && last.fromPolygon.length >= 3) {
            return { shape: last.fromShape || issue.shape || 'polygon', polygon: last.fromPolygon, entry: last };
        }
        if (reshapes.length >= 2) {
            const prev = reshapes[reshapes.length - 2];
            return { shape: prev.toShape || 'polygon', polygon: prev.polygon, entry: last };
        }
        return null;
    }

    // v1.38: ↩ Undo target for the LATEST icon move — recomputes what
    // markerPosFromHistory would yield WITHOUT that entry (local filter
    // only; the entry itself is never removed from the stored history).
    // Returns { pos, entry } (pos null = auto placement) or null when
    // there's no markermove to undo, or a newer reshape already reset the
    // icon (the move is inert — undo would be a no-op).
    function markerMoveUndoTarget(issue) {
        const hist = (issue && issue.history) || [];
        let last = null, lastAt = -Infinity, reshapeAt = -Infinity;
        hist.forEach(h => {
            if (!h) return;
            const t = new Date(h.at).getTime();
            const at = isNaN(t) ? 0 : t;
            if (h.kind === 'reshape') { if (at >= reshapeAt) reshapeAt = at; return; }
            if (h.kind !== 'markermove') return;
            if (at >= lastAt) { lastAt = at; last = h; }
        });
        if (!last || reshapeAt > lastAt) return null;
        const pos = markerPosFromHistory(hist.filter(h => h !== last), undefined);
        return { pos: pos || null, entry: last };
    }

    // v1.31: derive category from the last kind:'category' conversion in a
    // (union-merged) history; falls back to the stored field for issues
    // created directly with a category (creation category is in both copies).
    function categoryFromHistory(history, fallback) {
        let best = null, bestAt = -Infinity;
        (history || []).forEach(h => {
            if (!h || h.kind !== 'category') return;
            const t = new Date(h.at).getTime();
            const at = isNaN(t) ? 0 : t;
            if (at >= bestAt) { bestAt = at; best = h; }
        });
        if (best) return best.toCategory || undefined;
        return fallback;
    }

    // v1.26: derive the deleted flag from a (union-merged) history. Scans for
    // the last delete (toStatus==='deleted') vs reinstate (kind==='reinstate')
    // event; whichever is chronologically latest decides. Returns the stored
    // fallback flag when the history carries no delete/reinstate event at all
    // (legacy tombstones whose delete predates history entries). This is the
    // single source of truth for "is this issue deleted" after a merge.
    function deletedFromHistory(history, fallbackDeleted) {
        let state = null, stateAt = -Infinity;
        (history || []).forEach(h => {
            if (!h) return;
            const isDel = h.toStatus === 'deleted';
            const isReinst = h.kind === 'reinstate';
            if (!isDel && !isReinst) return;
            const at = new Date(h.at).getTime();
            const t = isNaN(at) ? 0 : at;
            if (t >= stateAt) { stateAt = t; state = isDel; }
        });
        return state === null ? !!fallbackDeleted : state;
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
        // Immutable fields (note / surface / createdAt / createdBy / id)
        // don't change after creation, so both copies hold the same values —
        // taking from either side is fine. Use spread with `a` first for
        // stable ordering of fields. polygon/shape are NO LONGER immutable
        // (v1.30 reshape) — they're re-derived from history just below.
        const merged = { ...a, ...b, history, status };
        // v1.30: polygon/shape mutate via reshape. The latest kind:'reshape'
        // entry in the union-merged history is the source of truth (mirrors
        // the deleted-from-history pattern) — without this, whichever copy
        // spread last would silently clobber a fresh reshape with stale
        // geometry. No reshape entry → both copies hold the creation polygon.
        const reshape = latestReshapeFromHistory(history);
        if (reshape) {
            merged.polygon = reshape.polygon;
            if (reshape.toShape) merged.shape = reshape.toShape;
        }
        // v1.31: category mutates via the convert action — same derive-from-
        // history rule so a conversion survives sync in any tab order.
        merged.category = categoryFromHistory(history, a.category || b.category);
        // v1.37: custom marker position — same derive-from-history rule
        // (latest markermove wins; a newer reshape resets it to auto).
        merged.markerPos = markerPosFromHistory(history, a.markerPos || b.markerPos);
        // v1.29: the Slack watermark must merge by MAX — a stale copy with a
        // lower (or missing) watermark must not win, or we'd re-backfill what
        // another session already posted. Keep undefined only if BOTH are unset
        // (so first-open migration still runs). Also never lose a known thread.
        if (a.slackPostedHistoryLen != null || b.slackPostedHistoryLen != null) {
            merged.slackPostedHistoryLen = Math.max(a.slackPostedHistoryLen || 0, b.slackPostedHistoryLen || 0);
        }
        merged.slackThreadTs = a.slackThreadTs || b.slackThreadTs;
        // v1.26: deleted state is DERIVED from the union-merged history so a
        // reinstate can survive sync. Was v0.25 "delete-wins" (any tombstoned
        // copy → tombstoned), which made reinstate impossible — the next merge
        // against a coworker's stale copy re-deleted it. Now the chronologically
        // LAST delete-vs-reinstate event in the merged history wins, so
        // delete → reinstate → delete in any tab order resolves correctly.
        merged.deleted = deletedFromHistory(history, a.deleted || b.deleted);
        // Preserve the audit fields. deletedAt = earliest delete (canonical
        // first-delete time); reinstatedAt = latest reinstate.
        if (a.deletedAt || b.deletedAt) {
            const aAt = a.deletedAt ? new Date(a.deletedAt).getTime() : Infinity;
            const bAt = b.deletedAt ? new Date(b.deletedAt).getTime() : Infinity;
            merged.deletedAt = aAt <= bAt ? (a.deletedAt || b.deletedAt) : b.deletedAt;
            merged.deletedBy = aAt <= bAt ? (a.deletedBy || b.deletedBy) : b.deletedBy;
        }
        if (a.reinstatedAt || b.reinstatedAt) {
            const aR = a.reinstatedAt ? new Date(a.reinstatedAt).getTime() : -Infinity;
            const bR = b.reinstatedAt ? new Date(b.reinstatedAt).getTime() : -Infinity;
            merged.reinstatedAt = aR >= bR ? a.reinstatedAt : b.reinstatedAt;
            merged.reinstatedBy = aR >= bR ? a.reinstatedBy : b.reinstatedBy;
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

    // ---- v1.20: stale-issue auto-bump (client-side) -------------------
    // *** DISABLED in v1.39 (2026-08-27): no scheduled callers remain. ***
    // Channel policy: #CSM-Site-Issues only gets issue opened/updated/closed
    // events — no weekly re-pings. Code kept intact for possible re-enable.
    // Pings assignee + approvers when an issue sits in open/pending for >7
    // days, re-bumping weekly. Runs in the IFRAME (sync owner) after each
    // refetch + hourly. Dedups across browsers via the synced kind:'bump'
    // history entry, and adopts pre-Slack issues first. Uses the PAT the
    // browser already has — no cloud/GitHub-App auth needed.
    const STALE_BUMP_STATUSES = new Set(['open', 'pending_fix', 'pending_ignore', 'ready-for-review']);
    const STALE_BUMP_MS = 7 * 24 * 60 * 60 * 1000;
    let staleBumpRunning = false;
    function issueStaleSince(issue) {
        const h = issue.history || [];
        for (let i = h.length - 1; i >= 0; i--) if (h[i].toStatus === issue.status) return new Date(h[i].at).getTime();
        return new Date(issue.createdAt).getTime();
    }
    function issueLastBumpAt(issue) {
        const h = issue.history || [];
        for (let i = h.length - 1; i >= 0; i--) if (h[i].kind === 'bump') return new Date(h[i].at).getTime();
        return 0;
    }
    async function runStaleBumpCheck() {
        if (IS_TOP || staleBumpRunning) return;
        if (!slackEnabled() || !cachedToken || !siteID) return;
        staleBumpRunning = true;
        try {
            const now = Date.now();
            let bumped = 0;
            for (const issue of currentSiteIssues) {
                if (!issue || issue.deleted || issue.source === 'validator' || issue.createdBy === 'local-only') continue;
                if (!STALE_BUMP_STATUSES.has(issue.status)) continue;
                const since = issueStaleSince(issue);
                if (now - since <= STALE_BUMP_MS) continue;                 // not stale yet
                if (now - issueLastBumpAt(issue) < STALE_BUMP_MS) continue; // bumped within 7d
                const days = Math.floor((now - since) / 86400000);
                const label = (STATUS_LABEL[issue.status] || { text: issue.status.toUpperCase() }).text;
                await ensureSlackThread(issue);   // adopt pre-Slack issues into a thread first
                const seen = new Set();
                const mentions = [issue.assignee, ...(approversList || [])].filter(Boolean)
                    .map(t => { if (seen.has(t)) return ''; seen.add(t); return slackMention(t); })
                    .filter(Boolean).join(' ');
                const head = `⏰ *Stale ${days}d* — still *${label}* since ${new Date(since).toISOString().slice(0, 10)}`;
                const text = issue.slackThreadTs
                    ? `${head}${mentions ? '\ncc ' + mentions : ''}`
                    : `${head} · ${siteLabelForSlack(issue.id)}\n>${(issue.note || '').slice(0, 120)}${mentions ? '\ncc ' + mentions : ''}`;
                const ts = await slackPost(text, issue.slackThreadTs || null);
                if (!ts) continue;   // post failed — don't record a bump (retry next run)
                if (!Array.isArray(issue.history)) issue.history = [];
                issue.history.push({ at: new Date().toISOString(), by: 'auto-bump', fromStatus: issue.status, toStatus: issue.status, kind: 'bump', note: `Auto-bump: ${days}d in ${label}` });
                bumped++;
            }
            if (bumped) {
                saveIssuesToStorage(siteID, currentSiteIssues);
                commitIssuesToGitHub('stale-issue auto-bump');
                renderButtonState();
                if (panelEl) renderIssuesPanel();
                console.log(`${TAG} stale-bump: ${bumped} issue(s) bumped`);
            }
        } catch (e) {
            console.warn(`${TAG} runStaleBumpCheck threw:`, e);
        } finally {
            staleBumpRunning = false;
        }
    }

    // ---- v1.22: GLOBAL stale sweep (TOP frame, no open site required) ----
    // runStaleBumpCheck above only sees currentSiteIssues — the ONE site you
    // have open — so stale issues on every OTHER site never get bumped until
    // someone navigates into them. This sweep runs in the TOP frame (which
    // exists everywhere, including the landing page with no map iframe),
    // enumerates EVERY site's issue file on GitHub, and bumps stale issues
    // site-by-site. It needs no map/iframe and no open site.
    //
    // Scope: APPROVERS only. The per-site IFRAME check stays ungated (any CSM
    // opening a site still bumps it), but the cross-site sweep is an oversight
    // function — gating to approvers keeps every CSM's browser from listing +
    // fetching every site file hourly and racing on the same bumps.
    //
    // Dedup is the same kind:'bump' 7-day window as the per-site path: each
    // site's issues are fetched FRESH from GitHub right before bumping, so a
    // bump another browser already wrote this week is seen and skipped. The
    // currently-open site (if any) is skipped here and left to the IFRAME.
    let globalSweepRunning = false;
    // v1.24: issue ids whose parent board we've already name-reconciled this
    // browser session — keeps the silent chat.update from re-firing every
    // hourly sweep. Resets on reload (a fresh session re-checks once, harmless).
    const sweptBoards = new Set();
    // v1.22: site ID → friendly name map. The sweep runs in the TOP frame
    // without opening any site, so readSiteName() (DOM .site-select) only
    // knows the current site. Pull every site's name from Percepto's own
    // same-origin /sites/ endpoint (cookie auth, no PAT) so adopted parent
    // boards + bump fallback text show the NAME, not "site <id>". Cached for
    // the run; rebuilt each sweep (cheap, one request).
    let siteNamesCache = null;
    async function fetchSiteNames() {
        try {
            const resp = await fetch('/sites/', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
            if (!resp.ok) { console.warn(`${TAG} /sites/ HTTP ${resp.status} — sweep will fall back to site IDs`); return new Map(); }
            const ct = resp.headers.get('content-type') || '';
            const map = new Map();
            if (/json/i.test(ct)) {
                let data = null; try { data = await resp.json(); } catch (e) {}
                let list = Array.isArray(data) ? data : null;
                if (!list && data && typeof data === 'object') {
                    for (const k of ['results', 'objects', 'data', 'sites', 'items']) {
                        if (Array.isArray(data[k])) { list = data[k]; break; }
                    }
                }
                (list || []).forEach(s => {
                    const id = String(s.id != null ? s.id : (s.site_id != null ? s.site_id : (s.pk != null ? s.pk : '')));
                    const name = String(s.name || s.site_name || s.title || '').trim();
                    if (id && name) map.set(id, name);
                });
            }
            return map;
        } catch (e) {
            console.warn(`${TAG} fetchSiteNames threw — sweep falls back to site IDs:`, e);
            return new Map();
        }
    }
    async function listIssueSites() {
        const url = `${GITHUB_API_BASE}/repos/${ISSUES_REPO}/contents/issues?ref=${ISSUES_BRANCH}`;
        const resp = await ghRequest({
            method: 'GET',
            url,
            headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github+json' },
            timeout: 20000,
        });
        if (resp.status === 404) return [];           // no issues/ dir yet
        if (resp.status !== 200) throw new Error(`list issues/ HTTP ${resp.status}`);
        const arr = JSON.parse(resp.responseText);
        if (!Array.isArray(arr)) return [];
        const sids = [];
        // Each server sweeps ONLY its own files: prod = <id>-issues.json,
        // QA = qa-<id>-issues.json. Without this split a QA tab would bump
        // prod issues (and build site links to the wrong origin).
        const fileRe = IS_QA ? /^qa-(\d+)-issues\.json$/ : /^(\d+)-issues\.json$/;
        for (const f of arr) {
            const m = f && f.name && f.name.match(fileRe);
            if (m) sids.push(m[1]);
        }
        return sids;
    }
    // PUT a site's full issue list back. On 409/422 (someone committed since
    // our GET) refetch + union-merge + retry once. Returns true on success.
    async function putIssuesForSite(sid, issues, sha, reason) {
        const path = ISSUES_PATH(sid);
        const url = `${GITHUB_API_BASE}/repos/${ISSUES_REPO}/contents/${encodeURIComponent(path)}`;
        const payload = { version: 1, siteID: sid, issues };
        const body = {
            message: `[AIM site ${sid}] issues: ${reason}`,
            content: textToB64(JSON.stringify(payload, null, 2)),
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
        if (resp.status === 200 || resp.status === 201) return true;
        if (resp.status === 409 || resp.status === 422) {
            console.warn(`${TAG} sweep PUT conflict on site ${sid} (HTTP ${resp.status}) — refetch + merge + retry`);
            const remote = await fetchRemoteIssues(sid);
            if (!remote) return false;
            const merged = mergeIssueLists(issues, remote.issues);
            return putIssuesForSite(sid, merged, remote.sha, reason);
        }
        console.warn(`${TAG} sweep PUT site ${sid} HTTP ${resp.status}: ${(resp.responseText || '').slice(0, 300)}`);
        return false;
    }
    // Bump stale issues for ONE site off its freshly-fetched remote list.
    // `name` = friendly site name (from /sites/), '' falls back to "site <id>".
    async function sweepSite(sid, name) {
        const remote = await fetchRemoteIssues(sid);
        if (!remote || !remote.issues.length) return 0;
        const now = Date.now();
        let bumped = 0;
        for (const issue of remote.issues) {
            if (!issue || issue.deleted || issue.source === 'validator' || issue.createdBy === 'local-only') continue;
            if (!STALE_BUMP_STATUSES.has(issue.status)) continue;
            // (A) Reconcile the parent board's site name — runs BEFORE the bump
            // gate so it isn't blocked for 7 days after an issue was just
            // bumped. v1.22 adopted boards showing "site <id>"; this rewrites
            // them to the friendly name + current status. chat.update is silent
            // (no notification) and idempotent — for an already-correct board it
            // re-sends identical text, invisibly. Gated once per browser session
            // (sweptBoards) so we don't re-issue the update every hourly sweep.
            if (issue.slackThreadTs && name && slackPostable(issue) && !sweptBoards.has(issue.id)) {
                sweptBoards.add(issue.id);
                slackUpdateRaw(issue.slackThreadTs, slackParentText(issue, null, sid, name));
            }
            // (B) Stale bump.
            const since = issueStaleSince(issue);
            if (now - since <= STALE_BUMP_MS) continue;                 // not stale yet
            if (now - issueLastBumpAt(issue) < STALE_BUMP_MS) continue; // bumped within 7d
            const days = Math.floor((now - since) / 86400000);
            const label = (STATUS_LABEL[issue.status] || { text: issue.status.toUpperCase() }).text;
            // Adopt pre-Slack issues into a thread (parent status board) first,
            // so the bump threads under it. slackPostable filters local-only /
            // opted-out validator findings (validator never reaches here anyway).
            if (!issue.slackThreadTs && slackPostable(issue)) {
                const ts = await slackPostRaw(slackParentText(issue, null, sid, name), null);
                if (ts) { issue.slackThreadTs = ts; sweptBoards.add(issue.id); }
            }
            const seen = new Set();
            const mentions = [issue.assignee, ...(approversList || [])].filter(Boolean)
                .map(t => { if (seen.has(t)) return ''; seen.add(t); return slackMention(t); })
                .filter(Boolean).join(' ');
            const head = `⏰ *Stale ${days}d* — still *${label}* since ${new Date(since).toISOString().slice(0, 10)}`;
            const text = issue.slackThreadTs
                ? `${head}${mentions ? '\ncc ' + mentions : ''}`
                : `${head} · ${siteLabelForSlack(issue.id, sid, name)}\n>${(issue.note || '').slice(0, 120)}${mentions ? '\ncc ' + mentions : ''}`;
            const ts = await slackPostRaw(text, issue.slackThreadTs || null);
            if (!ts) continue;   // post failed — don't record a bump (retry next run)
            if (!Array.isArray(issue.history)) issue.history = [];
            issue.history.push({ at: new Date().toISOString(), by: 'auto-bump', fromStatus: issue.status, toStatus: issue.status, kind: 'bump', note: `Auto-bump: ${days}d in ${label}` });
            bumped++;
        }
        if (bumped) {
            const ok = await putIssuesForSite(sid, remote.issues, remote.sha, 'stale-issue auto-bump (global sweep)');
            if (!ok) console.warn(`${TAG} sweep: site ${sid} bumped ${bumped} but PUT failed — will retry next sweep`);
        }
        return bumped;
    }
    async function runGlobalStaleSweep() {
        if (!IS_TOP || globalSweepRunning) return;       // TOP owns the cross-site sweep
        if (!slackEnabled() || !cachedToken) return;     // nothing to post / no auth
        if (!isApprover()) return;                       // oversight function — approvers only
        globalSweepRunning = true;
        try {
            const sids = await listIssueSites();
            if (!sids.length) return;
            siteNamesCache = await fetchSiteNames();   // one /sites/ request for the whole sweep
            let totalBumped = 0, sitesBumped = 0;
            for (const sid of sids) {
                if (sid === siteID) continue;            // current site → IFRAME handles it
                try {
                    const n = await sweepSite(sid, siteNamesCache.get(sid) || '');
                    if (n) { totalBumped += n; sitesBumped++; }
                } catch (e) {
                    console.warn(`${TAG} global sweep: site ${sid} threw:`, e);
                }
            }
            console.log(`${TAG} global stale sweep: scanned ${sids.length} site(s), bumped ${totalBumped} issue(s) across ${sitesBumped} site(s)`);
        } catch (e) {
            console.warn(`${TAG} runGlobalStaleSweep threw:`, e);
        } finally {
            globalSweepRunning = false;
        }
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
            // v1.39: stale-bump check DISABLED (channel policy 2026-08-27 —
            // Slack only gets issue opened/updated/closed events, no re-pings).
            // runStaleBumpCheck();
            // v1.29: reconcile Slack — backfill any issue whose history ran
            // ahead of its Slack watermark (a transition that never posted
            // because the actor's Slack was down). Runs once per site.
            reconcileSlackOnOpen();
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
        // v1.31: per-issue approval power — a category approver's badge only
        // counts pendings they can actually approve.
        const pending = isAnyApprover()
            ? live.filter(i => (i.status === 'pending_fix' || i.status === 'pending_ignore') && isApproverFor(i)).length
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

    // v1.30: draw-session binding shared by BOTH flag mode (new issue) and
    // reshape mode (redraw an existing issue's polygon). One session at a
    // time — the entry points cancel the other mode before binding.
    function bindDrawSession(map) {
        const container = map.getContainer ? map.getContainer() : null;
        if (container) container.style.cursor = 'crosshair';
        // Disable map drag so our mousedown→drag isn't fighting Leaflet pan.
        // Re-enabled on unbind. Same trick Leaflet's own draw plugin uses.
        try { if (map.dragging) map.dragging.disable(); } catch (e) {}
        try { if (map.doubleClickZoom) map.doubleClickZoom.disable(); } catch (e) {}
        // Bind Leaflet events for draw — latlng is delivered to us directly.
        map.on('mousedown', onMapMouseDown);
        map.on('mousemove', onMapMouseMove);
        map.on('mouseup',   onMapMouseUp);
        map.on('click',     onMapClick);
        map.on('dblclick',  onMapDblClick);
        window.addEventListener('keydown', onWindowKeyDown, true);
    }

    function unbindDrawSession() {
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
    }

    function enterFlagMode() {
        const map = getLeafletMap();
        if (!map) {
            showToast('Map not ready — try again in a second.', 3000);
            flagModeActive = false;
            renderButtonState();
            return;
        }
        cancelReshape({ silent: true });   // one draw mode at a time
        bindDrawSession(map);
        showToast('Flag mode ON — click-drag for rectangle, Shift+click for polygon. Esc to exit.', 4000);
    }

    function exitFlagMode(opts) {
        opts = opts || {};
        unbindDrawSession();
        discardDraw({ silent: true });
        if (!opts.silent) showToast('Flag mode OFF.', 1800);
    }

    function onWindowKeyDown(e) {
        if (e.key === 'Escape') {
            // v1.30: layered Esc during reshape — first Esc discards the
            // staged/pending shape (back to drawing), next Esc cancels the
            // whole reshape and restores the original rendering.
            if (reshapeState && reshapeState.pending) { discardReshapePending(); return; }
            if (markerMoveState) { cancelMarkerMove({ silent: false }); return; }
            if (drawingState) discardDraw({ silent: false });
            else if (reshapeState) cancelReshape({ silent: false });
            else setFlagMode(false);
            return;
        }
        if (e.key === 'Enter' && drawingState && drawingState.mode === 'polygon') {
            e.preventDefault();
            finishPolygon();
        }
    }

    function onMapMouseDown(e) {
        // v1.30: the same handlers serve flag mode AND reshape mode.
        if ((!flagModeActive && !reshapeState) || !masterEnabled) return;
        // While a reshaped-but-unconfirmed shape awaits Apply/Redraw/Cancel,
        // ignore new draws — the toolbar owns the next step.
        if (reshapeState && reshapeState.pending) return;
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
        // v1.30: in reshape mode the drawn shape replaces an existing issue's
        // polygon (after confirm) instead of opening the new-issue note modal.
        if (reshapeState) { stageReshapePending('rectangle', polygonLatLngs); return; }
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
        // v1.30: reshape mode — stage the replacement shape for confirm.
        if (reshapeState) { stageReshapePending('polygon', latlngs); return; }
        openNoteModal('polygon', latlngs);
    }

    function discardDraw(opts) {
        opts = opts || {};
        clearPreview();
        drawingState = null;
        tearDownDrawToolbar();
        // v1.30: discarding a sketch mid-reshape stays IN reshape mode —
        // bring back the instruction toolbar so the user can draw again.
        if (reshapeState && !reshapeState.pending) buildReshapeToolbar('idle');
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

    // ------- v1.30: Reshape (redraw an issue's polygon) -------
    // Entered ONLY from the status modal's ✏ Reshape button (M2 on the issue
    // icon → modal → Reshape), so the grey dashed ghost of the current shape
    // exists only while the user is actively looking at / reshaping that
    // issue. Flow: ghost the old shape → draw a replacement rect/polygon with
    // the same tools as creation → ✓ Apply / ↶ Redraw / ✗ Cancel. The new
    // polygon is recorded as a kind:'reshape' history entry — the audit trail
    // AND the distributed-sync source of truth (mergeIssueObjects re-derives
    // polygon/shape from the latest reshape entry in the union history, so a
    // coworker's stale copy can't clobber a fresh reshape).
    const RESHAPE_GHOST_STYLE = {
        color: '#9aa0a6', weight: 2, opacity: 0.85, dashArray: '6,6',
        fillColor: '#9aa0a6', fillOpacity: 0.06,
        interactive: false, bubblingMouseEvents: false,
    };

    function startReshape(issueId) {
        const issue = currentSiteIssues.find(i => i.id === issueId);
        if (!issue) { showToast('Issue not found — cannot reshape.', 3000); return; }
        if (issue.deleted) { showToast('Deleted issues cannot be reshaped.', 3000); return; }
        if (issue.source === 'validator') { showToast('Validator issues are regenerated on each run — reshape not applicable.', 3500); return; }
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L) { showToast('Map not ready — try again in a second.', 3000); return; }
        if (flagModeActive) setFlagMode(false);   // one draw mode at a time
        cancelMarkerMove({ silent: true });       // one edit mode at a time
        cancelReshape({ silent: true });          // idempotent restart
        // Swap the normal rendering for the grey dashed ghost. renderOneIssue
        // skips this issue while reshapeState holds its id, so a background
        // sync re-render can't paint the old shape back under the session.
        const prior = issueLayers.get(issueId);
        if (prior) {
            try { if (prior.polygon) map.removeLayer(prior.polygon); } catch (e) {}
            try { if (prior.marker)  map.removeLayer(prior.marker);  } catch (e) {}
            issueLayers.delete(issueId);
        }
        let ghost = null;
        try {
            const polyPane = (map.getPane && map.getPane('aim-issues-polygons')) ? 'aim-issues-polygons' : undefined;
            ghost = L.polygon(issue.polygon, { ...RESHAPE_GHOST_STYLE, pane: polyPane }).addTo(map);
            if (ghost._path) { try { ghost._path.style.pointerEvents = 'none'; } catch (e) {} }
        } catch (e) {
            console.warn(`${TAG} reshape ghost render failed:`, e);
        }
        reshapeState = { issueId, ghost, pending: null, previewLayer: null };
        bindDrawSession(map);
        buildReshapeToolbar('idle');
        showToast('Reshape — old shape is grey dashed. Click-drag = rectangle, Shift+click = polygon. Esc to cancel.', 5000);
        console.log(`${TAG} reshape started for ${issueId}`);
    }

    // Tear down the reshape session and restore the issue's normal rendering.
    function cancelReshape(opts) {
        opts = opts || {};
        if (!reshapeState) return;
        const st = reshapeState;
        // Null FIRST so discardDraw / renderOneIssue behave normally below.
        reshapeState = null;
        const map = getLeafletMap();
        try { if (st.ghost && map) map.removeLayer(st.ghost); } catch (e) {}
        try { if (st.previewLayer && map) map.removeLayer(st.previewLayer); } catch (e) {}
        discardDraw({ silent: true });   // clears any in-progress sketch + toolbar
        unbindDrawSession();
        const issue = currentSiteIssues.find(i => i.id === st.issueId);
        if (issue && !issue.deleted) renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        if (!opts.silent) showToast('Reshape cancelled — original shape kept.', 2500);
    }

    // A finished draw in reshape mode is STAGED, not applied — the green
    // preview + Apply/Redraw/Cancel toolbar guard against an accidental
    // rectangle drag silently overwriting the shape.
    function stageReshapePending(shape, latlngsObjs) {
        if (!reshapeState) return;
        const map = getLeafletMap();
        const L = getL();
        reshapeState.pending = { shape, latlngsObjs };
        try {
            if (reshapeState.previewLayer && map) map.removeLayer(reshapeState.previewLayer);
            reshapeState.previewLayer = null;
            if (map && L) {
                reshapeState.previewLayer = L.polygon(latlngsObjs.map(c => [c.lat, c.lng]), {
                    color: '#5fff5f', weight: 3, opacity: 0.95, dashArray: '8,6',
                    fillColor: '#5fff5f', fillOpacity: 0.12,
                    interactive: false, bubblingMouseEvents: false,
                }).addTo(map);
                if (reshapeState.previewLayer._path) {
                    try { reshapeState.previewLayer._path.style.pointerEvents = 'none'; } catch (e) {}
                }
            }
        } catch (e) { console.warn(`${TAG} reshape preview render failed:`, e); }
        buildReshapeToolbar('pending');
    }

    function discardReshapePending() {
        if (!reshapeState || !reshapeState.pending) return;
        const map = getLeafletMap();
        try { if (reshapeState.previewLayer && map) map.removeLayer(reshapeState.previewLayer); } catch (e) {}
        reshapeState.previewLayer = null;
        reshapeState.pending = null;
        buildReshapeToolbar('idle');
    }

    function confirmReshape() {
        if (!reshapeState || !reshapeState.pending) return;
        const st = reshapeState;
        const { shape, latlngsObjs } = st.pending;
        const issue = currentSiteIssues.find(i => i.id === st.issueId);
        // Tear the session down BEFORE mutating so renderOneIssue (called by
        // applyReshape) paints the new shape instead of being skipped.
        reshapeState = null;
        const map = getLeafletMap();
        try { if (st.ghost && map) map.removeLayer(st.ghost); } catch (e) {}
        try { if (st.previewLayer && map) map.removeLayer(st.previewLayer); } catch (e) {}
        tearDownDrawToolbar();
        unbindDrawSession();
        if (!issue || issue.deleted) {
            showToast('Issue vanished mid-reshape — nothing changed.', 3500);
            return;
        }
        applyReshape(issue, shape, latlngsObjs.map(c => [c.lat, c.lng]));
    }

    // The mutation. Mirrors applyComment's save + sync + Slack pattern.
    // v1.38: optional `note` rides in the history entry + Slack reply (the
    // ↩ Undo path uses it to label the entry as an undo).
    function applyReshape(issue, shape, polygon, note) {
        const nowIso = new Date().toISOString();
        const by = cachedUsername || 'local-only';
        if (!Array.isArray(issue.history)) issue.history = [];
        // The NEW polygon rides in the history entry — that's what lets the
        // reshape survive distributed sync (mergeIssueObjects re-derives
        // polygon/shape from the latest reshape entry in the union history).
        // v1.38: the PRE-reshape polygon is recorded too (fromPolygon) so an
        // issue's FIRST reshape is undoable — without it the creation polygon
        // exists nowhere in the history and undo would have no target.
        issue.history.push({
            at: nowIso,
            by,
            fromStatus: issue.status || 'open',
            toStatus: issue.status || 'open',
            kind: 'reshape',
            fromShape: issue.shape || null,
            fromPolygon: (Array.isArray(issue.polygon) && issue.polygon.length >= 3) ? issue.polygon : null,
            toShape: shape,
            polygon,
            note: note || '',
        });
        issue.shape = shape;
        issue.polygon = polygon;
        // v1.37: a redrawn polygon invalidates any hand-placed icon spot —
        // back to automatic placement (markerPosFromHistory applies the same
        // rule on merge, keyed off the reshape being chronologically newer).
        issue.markerPos = null;
        issueAffectedCache.delete(issue.id);   // affected entities must recompute
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        renderButtonState();
        if (panelEl) renderIssuesPanel();
        console.log(`${TAG} reshaped ${issue.id} → ${shape}, ${polygon.length} vertices by @${by}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast('Issue reshaped — pushing to GitHub…', 2500);
            commitIssuesToGitHub(`@${by}: reshape ${issue.id.slice(0, 14)}`);
            postSlackReshape(issue, by, note);
        } else {
            showToast('Issue reshaped (local only).', 2500);
        }
    }

    // Reshape-mode toolbar (replaces the standard draw toolbar slot).
    // stage 'idle' = waiting for a draw; 'pending' = staged shape awaiting
    // Apply/Redraw/Cancel. While actually sketching, the standard
    // buildDrawToolbar takes over; discardDraw restores 'idle'.
    function buildReshapeToolbar(stage) {
        tearDownDrawToolbar();
        const tb = document.createElement('div');
        tb.id = 'aim-issues-draw-toolbar';
        tb.style.cssText = `
            position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
            background:#1f2228;border:2px solid #9aa0a6;border-radius:8px;
            padding:10px 16px;z-index:99999;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;display:flex;align-items:center;gap:12px;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
        `;
        const label = document.createElement('span');
        label.style.cssText = 'color:#c8cdd4;font-weight:600';
        tb.appendChild(label);
        if (stage === 'pending') {
            label.textContent = '✏ New shape staged (green) — apply it?';
            const applyBtn = document.createElement('button');
            applyBtn.textContent = '✓ Apply new shape';
            applyBtn.style.cssText = 'padding:7px 14px;background:#5fff5f;color:#000;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700';
            applyBtn.onclick = () => confirmReshape();
            tb.appendChild(applyBtn);
            const redrawBtn = document.createElement('button');
            redrawBtn.textContent = '↶ Redraw';
            redrawBtn.style.cssText = 'padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
            redrawBtn.onclick = () => discardReshapePending();
            tb.appendChild(redrawBtn);
        } else {
            label.textContent = '✏ Reshaping issue — drag = rectangle · Shift+click = polygon';
        }
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '✗ Cancel reshape (Esc)';
        cancelBtn.style.cssText = 'padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
        cancelBtn.onclick = () => cancelReshape({ silent: false });
        tb.appendChild(cancelBtn);
        document.body.appendChild(tb);
        drawToolbarEl = tb;
    }

    // ------- v1.37: Move icon (custom marker position) -------
    // Entered ONLY from the status modal's 📍 Move icon button. The issue's
    // marker becomes draggable; the drop is STAGED (green toolbar) and only
    // persists on Apply. The position rides in a kind:'markermove' history
    // entry so it survives distributed sync (mergeIssueObjects re-derives
    // markerPos from the union history, mirroring reshape). "Reset to auto"
    // applies markerPos:null → back to bestInteriorPoint placement.
    function startMarkerMove(issueId) {
        const issue = currentSiteIssues.find(i => i.id === issueId);
        if (!issue) { showToast('Issue not found — it may have been deleted in a sync.', 3500); return; }
        if (issue.deleted) { showToast('Deleted issues cannot be edited.', 3000); return; }
        if (issue.source === 'validator') { showToast('Validator issues are regenerated on each run — move not applicable.', 3500); return; }
        const map = getLeafletMap();
        const L = getL();
        if (!map || !L) { showToast('Map not ready — try again in a second.', 3000); return; }
        if (flagModeActive) setFlagMode(false);   // one edit mode at a time
        cancelReshape({ silent: true });
        cancelMarkerMove({ silent: true });       // idempotent restart
        markerMoveState = { issueId, pending: null };
        renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        buildMarkerMoveToolbar('idle');
        showToast('Move icon — drag the marker to where you want it, then Apply.', 4000);
        console.log(`${TAG} marker move started for ${issueId}`);
    }

    function cancelMarkerMove(opts) {
        opts = opts || {};
        if (!markerMoveState) return;
        const st = markerMoveState;
        // Null FIRST so renderOneIssue paints the normal (non-draggable)
        // marker back at its stored/auto position.
        markerMoveState = null;
        tearDownDrawToolbar();
        const issue = currentSiteIssues.find(i => i.id === st.issueId);
        if (issue && !issue.deleted) renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        if (!opts.silent) showToast('Move cancelled — icon position kept.', 2500);
    }

    function confirmMarkerMove(resetToAuto) {
        if (!markerMoveState) return;
        const st = markerMoveState;
        if (!resetToAuto && !st.pending) { showToast('Drag the icon first (or use ↺ Reset to auto).', 3000); return; }
        markerMoveState = null;
        tearDownDrawToolbar();
        const issue = currentSiteIssues.find(i => i.id === st.issueId);
        if (!issue || issue.deleted) {
            showToast('Issue vanished mid-move — nothing changed.', 3500);
            return;
        }
        applyMarkerMove(issue, resetToAuto ? null : st.pending);
    }

    // The mutation. Mirrors applyReshape's save + sync pattern, minus Slack —
    // an icon nudge is cosmetic, so the watermark advances silently to keep
    // the backfill sweep from posting a catch-up line about it.
    function applyMarkerMove(issue, markerPos, note) {
        const nowIso = new Date().toISOString();
        const by = cachedUsername || 'local-only';
        if (!Array.isArray(issue.history)) issue.history = [];
        issue.history.push({
            at: nowIso,
            by,
            fromStatus: issue.status || 'open',
            toStatus: issue.status || 'open',
            kind: 'markermove',
            markerPos: markerPos || null,
            note: note || '',
        });
        issue.markerPos = markerPos || null;
        // Silent Slack watermark bump — see comment above.
        if (issue.createdBy !== 'local-only' && issue.slackPostedHistoryLen != null) {
            issue.slackPostedHistoryLen = issue.history.length;
        }
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        if (panelEl) renderIssuesPanel();
        console.log(`${TAG} marker ${markerPos ? `moved to [${markerPos[0].toFixed(6)}, ${markerPos[1].toFixed(6)}]` : 'reset to auto'} on ${issue.id} by @${by}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast(markerPos ? 'Icon moved — pushing to GitHub…' : 'Icon reset to auto — pushing to GitHub…', 2500);
            commitIssuesToGitHub(`@${by}: move icon ${issue.id.slice(0, 14)}`);
        } else {
            showToast(markerPos ? 'Icon moved (local only).' : 'Icon reset to auto (local only).', 2500);
        }
    }

    // Move-icon toolbar. stage 'idle' = not dragged yet; 'pending' = a drop
    // is staged awaiting Apply/Cancel. Reuses the shared draw-toolbar slot.
    function buildMarkerMoveToolbar(stage) {
        tearDownDrawToolbar();
        const tb = document.createElement('div');
        tb.id = 'aim-issues-draw-toolbar';
        tb.style.cssText = `
            position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
            background:#1f2228;border:2px solid #9aa0a6;border-radius:8px;
            padding:10px 16px;z-index:99999;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;display:flex;align-items:center;gap:12px;
            box-shadow:0 4px 16px rgba(0,0,0,0.5);
        `;
        const label = document.createElement('span');
        label.style.cssText = 'color:#c8cdd4;font-weight:600';
        tb.appendChild(label);
        if (stage === 'pending') {
            label.textContent = '📍 New spot staged — apply it?';
            const applyBtn = document.createElement('button');
            applyBtn.textContent = '✓ Apply new spot';
            applyBtn.style.cssText = 'padding:7px 14px;background:#5fff5f;color:#000;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700';
            applyBtn.onclick = () => confirmMarkerMove(false);
            tb.appendChild(applyBtn);
        } else {
            label.textContent = '📍 Drag the issue icon to its new spot';
        }
        const resetBtn = document.createElement('button');
        resetBtn.textContent = '↺ Reset to auto';
        resetBtn.title = 'Put the icon back at its automatic (computed) position';
        resetBtn.style.cssText = 'padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
        resetBtn.onclick = () => confirmMarkerMove(true);
        tb.appendChild(resetBtn);
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '✗ Cancel (Esc)';
        cancelBtn.style.cssText = 'padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit';
        cancelBtn.onclick = () => cancelMarkerMove({ silent: false });
        tb.appendChild(cancelBtn);
        document.body.appendChild(tb);
        drawToolbarEl = tb;
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
        // v1.31: type picker — normal Issue vs Unshielded Route. Unshielded
        // routes render purple + shield-✕, stay visible when approved, and
        // are separately filterable in the panel.
        const catMeta = CATEGORY_META.unshielded;
        const typeRowHtml = `
            <div style="font-size:12px;color:#aaa;margin-bottom:6px">Type</div>
            <div id="aim-issues-type-row" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
                <button type="button" class="aim-issues-type-chip" data-category=""
                    style="padding:5px 12px;background:#ff4d4d;color:#fff;border:1.5px solid #ff4d4d;border-radius:14px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">
                    🚩 Issue
                </button>
                <button type="button" class="aim-issues-type-chip" data-category="unshielded"
                    style="padding:5px 12px;background:transparent;color:${catMeta.color};border:1.5px solid ${catMeta.color};border-radius:14px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">
                    🛡✕ Unshielded Route
                </button>
            </div>`;
        card.innerHTML = `
            <div style="font-size:15px;font-weight:600;color:#ff8585;margin-bottom:10px">
                New issue · ${shape} · ${latlngsObjs.length} vertex${latlngsObjs.length === 1 ? '' : 'es'}
            </div>
            ${typeRowHtml}
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
        // v1.31: type chips — single-select, default normal Issue. Same
        // pointerdown+click debounce as the priority chips.
        let selectedCategory = null;   // null = normal issue
        const typeChips = card.querySelectorAll('.aim-issues-type-chip');
        const paintTypeChips = () => {
            typeChips.forEach(c => {
                const cat = c.dataset.category || null;
                const isSel = (selectedCategory === cat);
                const color = cat ? CATEGORY_META.unshielded.color : '#ff4d4d';
                c.style.background = isSel ? color : 'transparent';
                c.style.color = isSel ? (cat ? '#1a0d26' : '#fff') : color;
            });
        };
        let lastTypeFire = 0;
        typeChips.forEach(c => {
            const h = (e) => {
                e.preventDefault(); e.stopPropagation();
                const now = Date.now();
                if (now - lastTypeFire < 250) return;   // ignore the paired event
                lastTypeFire = now;
                selectedCategory = c.dataset.category || null;
                paintTypeChips();
            };
            c.addEventListener('pointerdown', h, true);
            c.addEventListener('click', h, true);
        });
        paintTypeChips();
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
                createIssue({ shape, latlngsObjs, note, priority: selectedPriority, notify: Array.from(notifySelected), category: selectedCategory });
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

    function createIssue({ shape, latlngsObjs, note, priority, notify, category }) {
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
        // v1.31: category. Only stamped when non-default so normal issues
        // keep their pre-v1.31 record shape byte-for-byte.
        if (category === 'unshielded') issue.category = 'unshielded';
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
        const ctx = ctxForIssue(id);   // v1.41: site or fleet context
        const issue = ctx ? ctx.issues.find(i => i.id === id) : null;
        if (!issue) return;
        const isCreator = !!(issue.createdBy && cachedUsername && issue.createdBy === cachedUsername);
        // v0.7: anyone can delete a local-only issue regardless of token
        // state — they're throwaway entries with no real owner.
        const isLocalOnly = (issue.createdBy === 'local-only');
        // v1.25: approvers can delete ANY issue (oversight power, matches their
        // approve/reject/direct-resolve role). Lets them clean up TEST/junk
        // issues they didn't create. The deletion is attributed to the
        // approver in history + tombstone, so the audit log stays honest.
        // v1.31: per-issue (category approvers count for their category).
        const canModerate = isApproverFor(issue);
        if (!isCreator && !isLocalOnly && !canModerate) {
            showToast(`Only @${issue.createdBy} or an approver can delete this issue.`, 4500);
            return;
        }
        // Drop visual layers (current site only — fleet issues of other
        // sites have no layers on this map)
        if (ctx.isSite) {
            const map = getLeafletMap();
            const layers = issueLayers.get(id);
            if (layers && map) {
                try { if (layers.polygon) map.removeLayer(layers.polygon); } catch (e) {}
                try { if (layers.marker)  map.removeLayer(layers.marker);  } catch (e) {}
            }
            issueLayers.delete(id);
            hiddenIds.delete(id);
        }

        // v0.25: TOMBSTONE for synced issues. Removing-and-committing didn't
        // survive: Tab 2 (with the issue still present in its stale local
        // state) would race and re-upload it during a 409 retry. Tombstones
        // make delete a state CHANGE not a state REMOVAL — survives merges
        // via delete-wins. Local-only issues never sync so we just yank
        // them outright (no tombstone needed).
        if (isLocalOnly) {
            ctx.issues = ctx.issues.filter(i => i.id !== id);
            persistCtx(ctx);
            rerenderCtx(ctx, null);
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
        persistCtx(ctx);
        rerenderCtx(ctx, null);
        console.log(`${TAG} tombstoned issue ${id} by @${by}`);
        if (cachedToken) {
            showToast('Issue deleted — pushing to GitHub…', 2500);
            commitCtx(ctx, `tombstone issue by @${by}`);
            // v1.05: log the deletion in the issue's Slack thread.
            fireSlack(() => postSlackDelete(issue, by));
        } else {
            showToast('Issue deleted locally (no GitHub token).', 3000);
        }
    }

    // v1.26: approver-only reinstate. Reverses a tombstone by flipping deleted
    // off + recording a 'reinstate' history entry. Because the merge derives
    // the deleted flag from the union history (latest delete-vs-reinstate
    // wins), this SURVIVES sync against a coworker's still-tombstoned copy —
    // unlike a naive deleted=false, which the old delete-wins merge re-killed.
    function reinstateIssue(id) {
        const ctx = ctxForIssue(id);   // v1.41: site or fleet context
        const issue = ctx ? ctx.issues.find(i => i.id === id) : null;
        if (!issue) return;
        // Belt-and-suspenders — the UI only shows the button to approvers, but
        // re-assert here in case a future entry point forgets.
        if (!isApproverFor(issue)) {
            showToast('Only an approver can reinstate a deleted issue.', 4500);
            return;
        }
        if (!issue.deleted) {
            showToast('That issue is not deleted.', 3000);
            return;
        }
        // Restore the status the issue held immediately before its deletion —
        // the fromStatus on the most recent delete history entry.
        let restoreStatus = issue.status || 'open';
        const h0 = issue.history || [];
        for (let i = h0.length - 1; i >= 0; i--) {
            if (h0[i].toStatus === 'deleted') { restoreStatus = h0[i].fromStatus || 'open'; break; }
        }
        const nowIso = new Date().toISOString();
        const by = cachedUsername || 'local-only';
        issue.deleted = false;
        issue.reinstatedAt = nowIso;
        issue.reinstatedBy = by;
        issue.status = restoreStatus;
        if (!Array.isArray(issue.history)) issue.history = [];
        issue.history.push({
            at: nowIso,
            by,
            kind: 'reinstate',
            fromStatus: 'deleted',
            toStatus: restoreStatus,
            note: '(reinstated)',
        });
        persistCtx(ctx);
        // Redraw map layers (the issue is live again) + refresh panel/badge.
        if (ctx.isSite) renderAllIssues();
        rerenderCtx(ctx, null);
        if (panelEl) renderIssuesPanel();
        console.log(`${TAG} reinstated issue ${id} by @${by} → ${restoreStatus}`);
        if (cachedToken) {
            showToast('Issue reinstated — pushing to GitHub…', 2500);
            commitCtx(ctx, `reinstate issue by @${by}`);
            fireSlack(() => postSlackReinstate(issue, by));
        } else {
            showToast('Issue reinstated locally (no GitHub token).', 3000);
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
        // The map + issue overlays live in the IFRAME — the TOP frame has no map, so a
        // render there just retries 60× and dumps a giant async stack on give-up (e.g. on
        // a ?aim_issue deep-link). Rendering is iframe-owned; bail in TOP.
        if (IS_TOP) return;
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

    // v1.28: geometry helpers for TRUE polygon overlap. The old vertex-only
    // test missed the common case where the issue polygon is drawn INSIDE a
    // larger asset (none of the asset's corners land in the small issue poly).
    // Normalize both formats — issue.polygon is [lat,lng] pairs, entity coords
    // are {lat,lng} objects — to [[lat,lng]] rings, then test overlap as:
    // any vertex of either ring inside the other, OR any pair of edges crossing.
    function normRing(ring) {
        const out = [];
        for (const p of (ring || [])) {
            if (!p) continue;
            const lat = Array.isArray(p) ? p[0] : p.lat;
            const lng = Array.isArray(p) ? p[1] : p.lng;
            if (Number.isFinite(lat) && Number.isFinite(lng)) out.push([lat, lng]);
        }
        return out;
    }
    // point-in-ring on a normalized [[lat,lng]] ring (lat=y, lng=x).
    function pointInRing(lat, lng, ring) {
        if (!ring || ring.length < 3) return false;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const yi = ring[i][0], xi = ring[i][1];
            const yj = ring[j][0], xj = ring[j][1];
            const intersect = ((yi > lat) !== (yj > lat))
                && (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    // Do segments p1->p2 and p3->p4 intersect? Points are [lat,lng] (y,x).
    function segsCross(p1, p2, p3, p4) {
        const orient = (a, b, c) => {
            const v = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
            return v > 1e-12 ? 1 : (v < -1e-12 ? 2 : 0);
        };
        const onSeg = (a, b, c) =>
            Math.min(a[1], c[1]) <= b[1] && b[1] <= Math.max(a[1], c[1]) &&
            Math.min(a[0], c[0]) <= b[0] && b[0] <= Math.max(a[0], c[0]);
        const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4);
        const o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
        if (o1 !== o2 && o3 !== o4) return true;
        if (o1 === 0 && onSeg(p1, p3, p2)) return true;
        if (o2 === 0 && onSeg(p1, p4, p2)) return true;
        if (o3 === 0 && onSeg(p3, p1, p4)) return true;
        if (o4 === 0 && onSeg(p3, p2, p4)) return true;
        return false;
    }
    // Full overlap test for two normalized closed rings.
    function ringsOverlap(a, b) {
        if (a.length < 3 || b.length < 3) return false;
        for (const p of a) if (pointInRing(p[0], p[1], b)) return true;
        for (const p of b) if (pointInRing(p[0], p[1], a)) return true;
        for (let i = 0; i < a.length; i++) {
            const a1 = a[i], a2 = a[(i + 1) % a.length];
            for (let j = 0; j < b.length; j++) {
                const b1 = b[j], b2 = b[(j + 1) % b.length];
                if (segsCross(a1, a2, b1, b2)) return true;
            }
        }
        return false;
    }
    // Does any segment of an (open) polyline cross/enter the closed ring?
    function polylineHitsRing(pts, ring) {
        if (pts.length < 1 || ring.length < 3) return false;
        for (const p of pts) if (pointInRing(p[0], p[1], ring)) return true;
        for (let i = 0; i < pts.length - 1; i++) {
            for (let j = 0; j < ring.length; j++) {
                const b1 = ring[j], b2 = ring[(j + 1) % ring.length];
                if (segsCross(pts[i], pts[i + 1], b1, b2)) return true;
            }
        }
        return false;
    }

    // For each entity, "affected" means its geometry OVERLAPS the issue
    // polygon (v1.28: true overlap, not just a vertex landing inside).
    function affectedEntitiesFor(issue) {
        if (!issue || !Array.isArray(issue.polygon) || issue.polygon.length < 3) return [];
        // v1.41: a fleet issue belongs to ANOTHER site — its polygon must never
        // be tested against this site's entities (overlapping sites, #250,
        // would produce real false hits that then post to Slack).
        const owner = ctxForIssue(issue.id);
        if (owner && !owner.isSite) return [];
        if (issueAffectedCache.has(issue.id)) return issueAffectedCache.get(issue.id);
        const out = [];
        if (!mapObjects || mapObjects.siteID !== siteID || !Array.isArray(mapObjects.entities)) {
            return out;
        }
        const poly = issue.polygon;
        const polyRing = normRing(poly);   // issue polygon as [[lat,lng]], once
        for (const e of mapObjects.entities) {
            if (!e || typeof e.type !== 'number') continue;
            let hit = false;
            if (e.type === 3 || e.type === 4 || e.type === 16) {
                // Polygon entities (asset / FFZ / NFZ) — TRUE polygon overlap so
                // an issue drawn inside a larger asset is still captured.
                if (Array.isArray(e.coords)) {
                    hit = ringsOverlap(normRing(e.coords), polyRing);
                }
            } else if (e.type === 15) {
                // Flight path — polyline crosses/enters the issue polygon.
                // Build an ordered point list from coords (preferred) or arcs.
                let pts = Array.isArray(e.coords) ? normRing(e.coords) : [];
                if (pts.length < 2 && Array.isArray(e.arcs)) {
                    const ap = [];
                    for (const a of e.arcs) {
                        if (!a) continue;
                        if (a.point_a && Number.isFinite(a.point_a.lat)) ap.push([a.point_a.lat, a.point_a.lng]);
                        if (a.point_b && Number.isFinite(a.point_b.lat)) ap.push([a.point_b.lat, a.point_b.lng]);
                    }
                    pts = ap;
                }
                hit = polylineHitsRing(pts, polyRing);
            } else if (e.type === 19) {
                if (Array.isArray(e.coords) && e.coords[0]) {
                    hit = pointInRing(e.coords[0].lat, e.coords[0].lng, polyRing);
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

    // v1.41: `siteOf(issue)` → {sid, name} lets the fleet panel export a
    // multi-site table; omitted = single site (siteId / siteName_ as before).
    function buildIssuesHtmlForSheets(issues, siteId, siteName_, siteOf) {
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
                h.kind === 'comment' || (h.fromStatus && h.fromStatus === h.toStatus
                    && h.kind !== 'priority' && h.kind !== 'assign' && h.kind !== 'reshape' && h.kind !== 'category' && h.kind !== 'markermove')
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
                else if (h.kind === 'reshape') trans = `reshaped (${Array.isArray(h.polygon) ? h.polygon.length : '?'}-point ${h.toShape || 'polygon'})`;
                else if (h.kind === 'markermove') trans = h.markerPos ? 'moved the map icon' : 'reset the map icon';
                else if (h.kind === 'category') trans = (h.toCategory === 'unshielded') ? 'marked as Unshielded Route' : 'converted to normal issue';
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
            const sInfo = siteOf ? (siteOf(issue) || {}) : { sid: siteId, name: siteName_ };
            const rowSid = sInfo.sid || '', rowSiteName = sInfo.name || '';
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top">${escHtml(rowSid)}</td>`);
            // v0.29: Site Name is a link to the site-setup URL. Sheets +
            // Excel both honor <a href> in pasted HTML — cell becomes
            // clickable, displays the name as link text.
            const siteUrl = rowSid ? `${location.origin}/#/site/${encodeURIComponent(rowSid)}/control-panel/site-setup` : '';
            const siteNameCell = (rowSiteName && siteUrl)
                ? `<a href="${siteUrl}" style="color:#1a73e8;text-decoration:underline">${escHtml(rowSiteName)}</a>`
                : escHtml(rowSiteName || '');
            out.push(`<td style="padding:6px 10px;border:1px solid #444;vertical-align:top">${siteNameCell}</td>`);
            out.push('</tr>');
        });
        out.push('</tbody></table>');
        return out.join('');
    }

    function buildIssuesTsv(issues, siteId, siteName_, siteOf) {
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
                h.kind === 'comment' || (h.fromStatus && h.fromStatus === h.toStatus
                    && h.kind !== 'priority' && h.kind !== 'assign' && h.kind !== 'reshape' && h.kind !== 'category' && h.kind !== 'markermove')
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
                else if (h.kind === 'reshape') trans = `reshaped (${Array.isArray(h.polygon) ? h.polygon.length : '?'}-point ${h.toShape || 'polygon'})`;
                else if (h.kind === 'markermove') trans = h.markerPos ? 'moved the map icon' : 'reset the map icon';
                else if (h.kind === 'category') trans = (h.toCategory === 'unshielded') ? 'marked as Unshielded Route' : 'converted to normal issue';
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
                siteOf ? ((siteOf(issue) || {}).sid || '') : siteId,
                siteOf ? ((siteOf(issue) || {}).name || '') : (siteName_ || ''),
            ].map(safe).join('\t'));
        });
        return lines.join('\n');
    }

    async function copyIssuesToSheets(issues, siteId, siteName_, siteOf) {
        if (!issues || issues.length === 0) {
            showToast('Nothing to export — no issues match current filters.', 3000);
            return;
        }
        const html = buildIssuesHtmlForSheets(issues, siteId, siteName_, siteOf);
        const tsv = buildIssuesTsv(issues, siteId, siteName_, siteOf);
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

    // v1.31: category-aware wrappers. Unshielded routes render CONSTANT
    // purple (the color says "unshielded route", not a status) with a
    // shield-✕ glyph; status still shows via dash pattern + the approved ✓
    // chip. Normal issues fall through to the status-driven look.
    function styleForIssue(issue) {
        if (!isUnshielded(issue)) return styleForStatus(issue.status);
        const c = CATEGORY_META.unshielded.color;
        // Approved (resolved) = permanent accepted marker: solid outline.
        // Everything else keeps the dashed "work item" look. Ignored dims
        // via isIssueDimmed like a normal issue.
        const solid = (issue.status === 'resolved');
        return { color: c, fill: c, fillOpacity: 0.15, dashArray: solid ? null : '10,6', weight: 3 };
    }
    // Shield with an ✕ struck through, layered in HTML (no such emoji
    // exists). Returned as glyphHtml — renderOneIssue drops it into the
    // divIcon. The approved ✓ chip rides bottom-right, mirroring the green
    // "?" activity badge top-right.
    function iconForIssue(issue) {
        if (!isUnshielded(issue)) return { glyphHtml: iconForStatus(issue.status).glyph, color: iconForStatus(issue.status).color };
        const c = CATEGORY_META.unshielded.color;
        const approvedTick = (issue.status === 'resolved') ? `
            <span style="position:absolute;bottom:-5px;right:-5px;
                         width:13px;height:13px;border-radius:50%;
                         background:#5fff5f;color:#000;
                         display:flex;align-items:center;justify-content:center;
                         font-size:9px;font-weight:900;line-height:1;
                         border:1.5px solid rgba(0,0,0,0.65);
                         pointer-events:none;z-index:2">✓</span>` : '';
        // v1.33: the marker's SILHOUETTE is now the shield — renderOneIssue
        // drops the dark circular disc for this category, so the purple
        // shield shape itself is the marker (unmistakable at a glance), with
        // a white-cased red prohibition ring + slash on top. v1.32's
        // shield-inside-a-circle left no room for either shape to read at
        // normal marker sizes.
        const glyphHtml = `
            <svg viewBox="0 0 24 24" style="width:100%;height:100%;display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.85))">
                <path d="M12 1 L21 4.2 V11 C21 17 17.2 21.3 12 23 C6.8 21.3 3 17 3 11 V4.2 Z"
                      fill="${c}" stroke="#14171b" stroke-width="2"/>
                <path d="M12 2.6 L19.6 5.4 V11 C19.6 16.2 16.4 19.9 12 21.4 C7.6 19.9 4.4 16.2 4.4 11 V5.4 Z"
                      fill="none" stroke="#f1e8ff" stroke-width="0.9" opacity="0.85"/>
                <g opacity="0.7" stroke="#e01414">
                    <circle cx="12" cy="11.5" r="5.8" fill="none" stroke-width="2.2"/>
                    <line x1="7.9" y1="7.4" x2="16.1" y2="15.6" stroke-width="2.2" stroke-linecap="round"/>
                </g>
            </svg>${approvedTick}`;
        return { glyphHtml, color: c, shieldMarker: true };
    }

    function renderOneIssue(issue, opts) {
        if (!issue) return;
        // v1.30: while this issue is being reshaped, the grey ghost owns the
        // visual — skip normal rendering so a background re-render (sync,
        // toggle change) doesn't paint the old shape back under the session.
        if (reshapeState && reshapeState.issueId === issue.id) return;
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
        const st = styleForIssue(issue);
        const icoMeta = iconForIssue(issue);
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
        // v1.37: a hand-placed position (📍 Move icon) overrides the
        // automatic one. During an active move session, a staged-but-not-
        // applied drop wins so a background sync re-render can't snap the
        // marker back mid-session.
        const inMoveSession = !!(markerMoveState && markerMoveState.issueId === issue.id);
        const mp = issue.markerPos;
        const customPos = (Array.isArray(mp) && mp.length === 2 && isFinite(mp[0]) && isFinite(mp[1])) ? mp : null;
        const c = (inMoveSession && markerMoveState.pending)
            ? markerMoveState.pending
            : (customPos || bestInteriorPoint(issue.polygon));
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
            // v1.33: unshielded markers ARE the shield — no dark disc around
            // the glyph (the SVG silhouette is the marker), bumped 25% so the
            // shield shape + prohibition sign read at normal sizes.
            const shieldMarker = !!icoMeta.shieldMarker;
            const effSize = shieldMarker ? Math.round(markerSize * 1.25) : markerSize;
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
                    width:${effSize}px;height:${effSize}px;border-radius:${shieldMarker ? 0 : effSize / 2}px;
                    background:${shieldMarker ? 'transparent' : `rgba(20,23,27,${isHidden ? 0.6 : 0.92})`};
                    border:${shieldMarker ? 'none' : `${borderWidth}px ${isHidden ? 'dashed' : 'solid'} ${icoMeta.color}`};
                    color:${icoMeta.color};
                    opacity:${markerOpacity};
                    display:flex;align-items:center;justify-content:center;
                    font-size:${fontSize}px;font-weight:700;
                    box-shadow:${(isHidden || shieldMarker) ? 'none' : '0 2px 6px rgba(0,0,0,0.6)'};
                    pointer-events:auto;
                    cursor:pointer;
                    ${isHidden ? 'filter:grayscale(0.3);' : ''}
                ">${icoMeta.glyphHtml}${activityBadge}</div>`,
                iconSize: [effSize, effSize],
                iconAnchor: [effSize / 2, effSize / 2],
            });
            const markerPane = (map.getPane && map.getPane('aim-issues-markers')) ? 'aim-issues-markers' : undefined;
            marker = L.marker(c, { icon: divIcon, interactive: true, bubblingMouseEvents: false, pane: markerPane, draggable: inMoveSession });
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
            if (inMoveSession) {
                // v1.37: in a move session the marker is a drag handle only —
                // click/contextmenu are suppressed so a sloppy drop can't
                // toggle hide or pop the modal. Each drop stages the position
                // for the Apply/Cancel toolbar.
                marker.on('click', swallow);
                marker.on('contextmenu', swallow);
                marker.on('dragend', () => {
                    if (!markerMoveState || markerMoveState.issueId !== issue.id) return;
                    try {
                        const ll = marker.getLatLng();
                        markerMoveState.pending = [ll.lat, ll.lng];
                        buildMarkerMoveToolbar('pending');
                    } catch (e) { console.warn(`${TAG} marker dragend failed:`, e); }
                });
            } else {
                marker.on('click', (ev) => {
                    swallow(ev);
                    toggleSessionHide(issue.id);
                });
                marker.on('contextmenu', (ev) => {
                    swallow(ev);
                    openStatusModal(issue);
                });
            }
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
        // v1.30: assign/reshape must precede the comment fallback — both also
        // have fromStatus === toStatus (assign previously mislabeled as
        // "Commented" in the panel/tooltip last-event line).
        if (last.kind === 'assign') {
            return last.toAssignee ? `👤 Assigned → @${last.toAssignee}` : '👤 Unassigned';
        }
        if (last.kind === 'reshape') return '✏ Reshaped';
        if (last.kind === 'markermove') return '📍 Icon moved';
        if (last.kind === 'category') return (last.toCategory === 'unshielded') ? '🛡 Marked Unshielded' : '🚩 Marked Issue';
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
        if (h.kind === 'reshape') {
            return `✏ <b>@${by}</b> reshaped the area`;
        }
        if (h.kind === 'markermove') {
            return h.markerPos ? `📍 <b>@${by}</b> moved the map icon` : `📍 <b>@${by}</b> reset the map icon`;
        }
        if (h.kind === 'category') {
            return (h.toCategory === 'unshielded')
                ? `🛡 <b>@${by}</b> marked as Unshielded Route`
                : `🚩 <b>@${by}</b> converted to normal issue`;
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
        // v1.31: unshielded-route chip inline with the header line
        const catHtml = isUnshielded(issue)
            ? `<span style="display:inline-block;padding:1px 6px;border-radius:8px;background:${CATEGORY_META.unshielded.color};color:#1a0d26;font-size:9px;font-weight:700;letter-spacing:0.5px;margin-left:6px">🛡✕ UNSHIELDED ROUTE</span>`
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
                <div style="font-weight:700;color:${headerColor};font-size:13px;margin-bottom:6px">${headerLabel} &middot; ${age}${catHtml}${priHtml}</div>
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
        // v1.31: an APPROVED unshielded route is a permanent "known-accepted
        // unshielded section" marker — it stays fully visible. Ignored still
        // dims (an ignored flag isn't an accepted route).
        if (isUnshielded(issue) && issue.status === 'resolved') return false;
        if (issue.status === 'resolved' || issue.status === 'ignored') return true;
        return false;
    }

    function toggleSessionHide(id) {
        const issue = currentSiteIssues.find(i => i.id === id);
        if (!issue) return;
        // v0.8: resolved/ignored are background by status — M1 is a no-op
        // on those (toggling session-hide wouldn't change anything visually
        // and would just confuse the user). v1.31: EXCEPT approved unshielded
        // routes, which stay fully visible by design — allow session-hide so
        // they can still be tucked away temporarily.
        const approvedUnshielded = isUnshielded(issue) && issue.status === 'resolved';
        if ((issue.status === 'resolved' || issue.status === 'ignored') && !approvedUnshielded) {
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
        const ctx = ctxForIssue(issueId);   // v1.41: site or fleet context
        const issue = ctx ? ctx.issues.find(i => i.id === issueId) : null;
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
        persistCtx(ctx);
        rerenderCtx(ctx, issue);
        console.log(`${TAG} transition ${issueId}: ${fromStatus} → ${transition.to} by @${by}${trimmedNote ? ` (note: ${trimmedNote.slice(0, 80)})` : ''}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        const targetLabel = (STATUS_LABEL[transition.to] || { text: transition.to.toUpperCase() }).text;
        if (cachedToken && !wasLocalOnly) {
            showToast(`Status → ${targetLabel} — pushing to GitHub…`, 2500);
            commitCtx(ctx, `@${by}: ${fromStatus} → ${transition.to}`);
            // v1.03: threaded Slack reply with role-aware @-mentions.
            fireSlack(() => postSlackTransition(issue, fromStatus, transition, trimmedNote, by));
        } else {
            showToast(`Status → ${targetLabel} (local only).`, 2500);
        }
        return true;
    }

    function escHtml(s) {
        // v1.41: also escapes " so site names are safe inside title="…" attributes.
        return (s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    }

    // v0.28: comments. Don't change status — just append a history entry
    // where fromStatus === toStatus. Required note. Same audit / sync
    // pipeline as transitions.
    function applyComment(issueId, note, notifyLogins) {
        const ctx = ctxForIssue(issueId);   // v1.41: site or fleet context
        const issue = ctx ? ctx.issues.find(i => i.id === issueId) : null;
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
        persistCtx(ctx);
        rerenderCtx(ctx, null);
        console.log(`${TAG} comment on ${issueId} by @${by}: ${trimmedNote.slice(0, 80)}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast(`Comment added — pushing to GitHub…`, 2500);
            commitCtx(ctx, `@${by}: comment`);
            // v1.03: threaded Slack reply. v1.10: + @-mentions from picker.
            fireSlack(() => postSlackComment(issue, trimmedNote, by, notifyLogins));
        } else {
            showToast('Comment added (local only).', 2500);
        }
        return true;
    }

    // v1.12: assignment. Doesn't change status. Audited via a history entry
    // with kind='assign' + fromAssignee/toAssignee. Anyone can (re)assign.
    // null assignee = unassigned. Mirrors applyComment's sync + Slack pattern.
    function applyAssignment(issueId, newAssignee) {
        const ctx = ctxForIssue(issueId);   // v1.41: site or fleet context
        const issue = ctx ? ctx.issues.find(i => i.id === issueId) : null;
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
        persistCtx(ctx);
        rerenderCtx(ctx, issue);
        if (panelEl) renderIssuesPanel();
        console.log(`${TAG} assign ${issueId}: ${from || '(none)'} → ${to || '(none)'} by @${by}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast(to ? `Assigned to @${to} — pushing…` : 'Unassigned — pushing…', 2500);
            commitCtx(ctx, `@${by}: assign → ${to || 'none'}`);
            fireSlack(() => postSlackAssignment(issue, from, to, by));
        } else {
            showToast(to ? `Assigned to @${to} (local only).` : 'Unassigned (local only).', 2500);
        }
        return true;
    }

    // v1.31: category conversion (normal Issue ↔ Unshielded Route). Doesn't
    // change status. Audited via kind:'category' + fromCategory/toCategory —
    // mergeIssueObjects derives category from the latest such entry so the
    // conversion survives distributed sync. Gate matches delete (creator /
    // local-only / per-issue approver); re-asserted here belt-and-suspenders.
    function applyCategoryChange(issueId, newCategory) {
        const ctx = ctxForIssue(issueId);   // v1.41: site or fleet context
        const issue = ctx ? ctx.issues.find(i => i.id === issueId) : null;
        if (!issue) return false;
        const from = issueCategory(issue);
        const to = (newCategory === 'unshielded') ? 'unshielded' : 'issue';
        if (from === to) return false;   // no-op
        const isCreator = !!(issue.createdBy && cachedUsername && issue.createdBy === cachedUsername);
        const isLocalOnly = (issue.createdBy === 'local-only');
        if (!isCreator && !isLocalOnly && !isApproverFor(issue)) {
            showToast(`Only @${issue.createdBy} or an approver can convert this issue.`, 4500);
            return false;
        }
        const nowIso = new Date().toISOString();
        const by = cachedUsername || 'local-only';
        if (!Array.isArray(issue.history)) issue.history = [];
        issue.history.push({
            at: nowIso,
            by,
            fromStatus: issue.status || 'open',
            toStatus: issue.status || 'open',
            kind: 'category',
            fromCategory: from,
            toCategory: to,
            note: '',
        });
        if (to === 'unshielded') issue.category = 'unshielded';
        else delete issue.category;
        persistCtx(ctx);
        rerenderCtx(ctx, issue);
        if (panelEl) renderIssuesPanel();
        console.log(`${TAG} category ${issueId}: ${from} → ${to} by @${by}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast(to === 'unshielded' ? 'Marked as Unshielded Route — pushing…' : 'Converted to normal issue — pushing…', 2500);
            commitCtx(ctx, `@${by}: category → ${to}`);
            fireSlack(() => postSlackCategoryChange(issue, from, to, by));
        } else {
            showToast(to === 'unshielded' ? 'Marked as Unshielded Route (local only).' : 'Converted to normal issue (local only).', 2500);
        }
        return true;
    }

    // v0.28: priority change. Doesn't change status. Audited via a history
    // entry with kind='priority' + fromPriority/toPriority fields.
    function applyPriorityChange(issueId, newPriority, optionalNote) {
        const ctx = ctxForIssue(issueId);   // v1.41: site or fleet context
        const issue = ctx ? ctx.issues.find(i => i.id === issueId) : null;
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
        persistCtx(ctx);
        rerenderCtx(ctx, issue);
        const fromLabel = fromPriority ? priorityMeta(fromPriority).text : 'NONE';
        const toLabel = newPriority ? priorityMeta(newPriority).text : 'NONE';
        console.log(`${TAG} priority ${issueId}: ${fromLabel} → ${toLabel} by @${by}`);
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast(`Priority → ${toLabel} — pushing to GitHub…`, 2500);
            commitCtx(ctx, `@${by}: priority ${fromLabel} → ${toLabel}`);
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
    // v1.41: `opts.arm` pre-arms an action from the fleet panel's inline
    // buttons: { to: 'resolved' } (a transition target) or { kind: 'comment' }.
    function openStatusModal(issue, opts) {
        closeStatusModal();
        opts = opts || {};
        // v1.41: which context owns this issue — the fleet panel opens the
        // same modal for OTHER sites' issues. Map-bound actions (reshape,
        // move icon, zoom) are hidden for those; everything else is identical.
        const modalCtx = ctxForIssue(issue.id) || siteCtx();
        const isSiteIssue = !!modalCtx.isSite;
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
        if (opts.arm && opts.arm.kind === 'comment') armed = { kind: 'comment' };
        else if (opts.arm && opts.arm.to) {
            const t = (STATUS_TRANSITIONS[issue.status || 'open'] || []).find(x => x.to === opts.arm.to);
            if (t) armed = t;
        }
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
            const liveIssue = resolveIssue(issue.id) || issue;
            const safeNote = escHtml(liveIssue.note);
            const status = liveIssue.status || 'open';
            const statusMeta = STATUS_LABEL[status] || { text: status.toUpperCase(), color: '#ff8585' };
            // v1.00: role-gated transition list. CSMs see Propose buttons;
            // approvers see Direct + Approve/Reject. Transitions with no
            // `roles` field are shown to everyone (e.g. Re-open).
            // v1.31: role is PER-ISSUE — categoryApprovers members are
            // approvers only on issues of their category.
            const role = roleFor(liveIssue);
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
            // v1.38: permission gates hoisted above the history render — the
            // ↩ Undo chips need them, and the action buttons below reuse them.
            const isCreator = !!(liveIssue.createdBy && cachedUsername && liveIssue.createdBy === cachedUsername);
            const isLocalOnly = (liveIssue.createdBy === 'local-only');
            // v1.25: approvers can delete any issue (see deleteIssue). The
            // label flags WHY the button is available so the deleter knows
            // they're acting as an approver on someone else's issue.
            // v1.31: per-issue (global approver, or category approver on
            // issues of their category).
            const canModerate = isApproverFor(liveIssue);
            // v1.26: a tombstoned issue shows Reinstate (approver-only) instead
            // of Delete, and suppresses all transition/comment/priority actions.
            const isDeleted = !!liveIssue.deleted;
            // v1.38: shared gate for geometry edits (reshape / move icon /
            // their undos) — creator, local-only, or approver, on live,
            // non-validator issues (validator shapes regenerate each run).
            const canEditGeometry = (isCreator || isLocalOnly || canModerate) && !isDeleted
                && liveIssue.source !== 'validator';
            // v1.38: ↩ Undo — offered ONLY on the single entry whose effect
            // IS the current state (latest reshape / latest icon move). An
            // undo appends a compensating entry, so it syncs like any edit
            // and is itself undoable.
            // v1.41: geometry undos go through the site-only applyReshape /
            // applyMarkerMove — hidden for fleet-opened issues like Reshape.
            const reshapeUndo = (canEditGeometry && isSiteIssue) ? reshapeUndoTarget(liveIssue) : null;
            const markerUndo = (canEditGeometry && isSiteIssue) ? markerMoveUndoTarget(liveIssue) : null;
            const undoBtnHtml = (kind) => `<button class="aim-issues-hist-undo" data-undo="${kind}"
                title="${kind === 'reshape'
                    ? 'Restore the shape this reshape replaced. Adds an undo entry — history is never removed.'
                    : 'Restore the icon position this move replaced. Adds an undo entry — history is never removed.'}"
                style="padding:1px 8px;background:#2a2f36;color:#ffd24d;border:1px solid rgba(255,210,77,0.4);
                       border-radius:3px;cursor:pointer;font:inherit;font-size:10px;font-weight:700;flex-shrink:0">↩ Undo</button>`;
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
                } else if (h.kind === 'reshape') {
                    // v1.30: must precede the comment branch — reshape entries
                    // also have fromStatus === toStatus.
                    const nVerts = Array.isArray(h.polygon) ? h.polygon.length : '?';
                    label = `✏ <span style="color:#c8cdd4;font-weight:700">reshaped</span> → ${nVerts}-point ${escHtml(h.toShape || 'polygon')}`;
                } else if (h.kind === 'markermove') {
                    // v1.37: must precede the comment branch — markermove
                    // entries also have fromStatus === toStatus.
                    label = h.markerPos
                        ? `📍 <span style="color:#c8cdd4;font-weight:700">moved the map icon</span>`
                        : `📍 <span style="color:#888;font-weight:700">reset the map icon to auto</span>`;
                } else if (h.kind === 'category') {
                    label = (h.toCategory === 'unshielded')
                        ? `🛡 marked as <span style="color:${CATEGORY_META.unshielded.color};font-weight:700">UNSHIELDED ROUTE</span>`
                        : `🚩 converted to <span style="color:#ff8585;font-weight:700">normal issue</span>`;
                } else if (h.kind === 'comment' || h.fromStatus === h.toStatus) {
                    label = `💬 commented`;
                    labelColor = '#a8c4ff';
                } else {
                    label = `${statusPill(h.fromStatus)} → ${statusPill(h.toStatus)}`;
                }
                // v1.38: ↩ Undo chip on the entry that owns the current
                // geometry / icon position (reference equality — sortedHistory
                // and the undo targets both hold refs into liveIssue.history).
                const undoHtml = (reshapeUndo && h === reshapeUndo.entry) ? undoBtnHtml('reshape')
                    : (markerUndo && h === markerUndo.entry) ? undoBtnHtml('markermove') : '';
                return `<div style="padding:6px 8px;border-bottom:1px dotted rgba(255,255,255,0.08);font-size:12px">
                    <div style="color:#a8c4ff;font-size:11px;font-weight:600">${fmtDateTime(h.at)} &middot; @${safeBy}</div>
                    <div style="color:${labelColor};margin-top:2px;display:flex;align-items:center;gap:8px"><span>${label}</span>${undoHtml}</div>
                    ${safeHistNote ? `<div style="color:#bbb;font-size:11px;margin-top:2px">"${safeHistNote}"</div>` : ''}
                </div>`;
            }).join('');

            // v1.38: isCreator / isLocalOnly / canModerate / isDeleted are
            // declared above the history render (the ↩ Undo chips need them).
            const canDelete = (isCreator || isLocalOnly || canModerate) && !isDeleted;
            const canReinstate = isDeleted && canModerate;
            const deleteLabel = isCreator ? ' (you created this)'
                : isLocalOnly ? ' (local-only)'
                : ` (approver — @${escHtml(liveIssue.createdBy || '?')}'s issue)`;
            const deleteBtnHtml = canDelete
                ? `<button id="aim-issues-modal-delete"
                       style="padding:7px 14px;background:#5a2222;color:#ff8585;border:1px solid #ff4d4d;border-radius:4px;cursor:pointer;font:inherit;font-weight:700;margin-right:auto">
                       🗑 Delete${deleteLabel}
                   </button>`
                : '';
            const reinstateBtnHtml = canReinstate
                ? `<button id="aim-issues-modal-reinstate"
                       style="padding:7px 14px;background:#10331f;color:#5fff5f;border:1px solid #5fff5f;border-radius:4px;cursor:pointer;font:inherit;font-weight:700;margin-right:auto">
                       ♻ Reinstate this issue
                   </button>`
                : '';
            // v1.29: approver-only "Resend to Slack" — recovers a notification
            // that silently failed (e.g. before the watermark existed). Shown
            // for normal, non-deleted, Slack-eligible issues.
            const canResend = canModerate && !isDeleted
                && liveIssue.createdBy !== 'local-only' && liveIssue.source !== 'validator';
            // v1.30: reshape (redraw the polygon). Same gate as delete —
            // creator, local-only, or approver — on live, non-validator
            // issues (validator shapes are regenerated on each run).
            // v1.38: shared with the ↩ Undo chips as canEditGeometry.
            // v1.41: reshape / move icon need THIS site's map — hidden when
            // the modal was opened from the fleet panel for another site.
            const canReshape = canEditGeometry && isSiteIssue;
            const reshapeBtnHtml = canReshape
                ? `<button id="aim-issues-modal-reshape"
                       title="Redraw this issue's shape — the current shape shows grey dashed while you draw the replacement"
                       style="padding:7px 14px;background:#2a2f36;color:#c8cdd4;border:1px solid #9aa0a6;border-radius:4px;cursor:pointer;font:inherit;font-weight:700">
                       ✏ Reshape
                   </button>`
                : '';
            // v1.37: move icon — same gate as reshape. Lets the user drag
            // the issue's marker to a custom spot (the automatic interior-
            // point placement isn't always visually centered, e.g. long thin
            // unshielded-route corridors).
            const moveIconBtnHtml = canReshape
                ? `<button id="aim-issues-modal-moveicon"
                       title="Drag this issue's map icon to a custom spot (Apply/Cancel toolbar guards the drop; reshaping later resets it to automatic)"
                       style="padding:7px 14px;background:#2a2f36;color:#c8cdd4;border:1px solid #9aa0a6;border-radius:4px;cursor:pointer;font:inherit;font-weight:700">
                       📍 Move icon
                   </button>`
                : '';
            // v1.31: category convert — same gate as reshape. Toggles between
            // normal Issue and Unshielded Route (one-click migration for
            // sections that were flagged as plain issues pre-v1.31).
            const canConvert = canEditGeometry;   // v1.41: no map needed — allowed from the fleet panel
            const isUnsh = isUnshielded(liveIssue);
            const convertBtnHtml = canConvert
                ? `<button id="aim-issues-modal-convert"
                       title="${isUnsh ? 'Convert back to a normal issue' : 'Mark as an Unshielded Route — purple shield-✕ marker that stays visible when approved'}"
                       style="padding:7px 14px;background:#241536;color:${CATEGORY_META.unshielded.color};border:1px solid ${CATEGORY_META.unshielded.color};border-radius:4px;cursor:pointer;font:inherit;font-weight:700">
                       ${isUnsh ? '🚩 Mark as Issue' : '🛡 Mark Unshielded'}
                   </button>`
                : '';
            const resendBtnHtml = canResend
                ? `<button id="aim-issues-modal-resend"
                       title="Re-post this issue's current status to its Slack thread (creates the thread if missing)"
                       style="padding:7px 14px;background:#13294a;color:#5fb3ff;border:1px solid #5fb3ff;border-radius:4px;cursor:pointer;font:inherit;font-weight:700">
                       📣 Resend to Slack
                   </button>`
                : '';

            // v0.28: armed can be one of:
            //   transition object: { to, color, textColor, noteRequired, notePrompt, label } — status change
            //   { kind: 'comment' } — add a comment (required note)
            //   { kind: 'priority', to: 'high' | 'medium' | 'low' | null } — priority change (optional note)
            //   null — show all action buttons (transitions + comment + priority chips)
            let actionSectionHtml = '';
            if (isDeleted) {
                // v1.26: deleted issues show a banner + (for approvers) the
                // Reinstate button in the footer. No transitions/comments —
                // the issue must be reinstated before it can be acted on.
                const delBy = escHtml(liveIssue.deletedBy || '?');
                const delWhen = liveIssue.deletedAt ? fmtDateTime(liveIssue.deletedAt) : 'unknown time';
                actionSectionHtml = `
                    <div style="margin-top:14px;padding:12px;background:#1a1010;border:1px solid rgba(255,77,77,0.45);border-radius:6px">
                        <div style="color:#ff8585;font-size:13px;font-weight:700;margin-bottom:4px">🗑 This issue was deleted</div>
                        <div style="color:#bbb;font-size:11px">by <b>@${delBy}</b> · ${delWhen}</div>
                        <div style="color:#888;font-size:11px;margin-top:6px;font-style:italic">${canReinstate
                            ? 'Use ♻ Reinstate below to restore it (returns to its pre-delete status).'
                            : 'Only an approver can reinstate a deleted issue.'}</div>
                    </div>
                `;
            } else if (armed && armed.kind === 'comment') {
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
                // v1.19: validator findings default to NO Slack. This toggle
                // lets the user escalate a specific finding to Slack on demand
                // (turning it on backfills the parent thread). Shown only for
                // source==='validator' issues.
                const isValidator = (liveIssue.source === 'validator');
                const optedIn = !!liveIssue.slackNotifyOptIn;
                const validatorSlackToggle = isValidator ? `
                    <div style="margin-top:14px;padding:10px 12px;background:#14171b;border:1px solid ${optedIn ? 'rgba(95,255,95,0.40)' : 'rgba(255,255,255,0.12)'};border-radius:6px">
                        <button class="aim-issues-slacknotify-toggle"
                            title="Validator findings don't post to Slack by default. Turn this on to escalate THIS finding to the channel."
                            style="display:inline-flex;align-items:center;gap:8px;padding:6px 12px;font:inherit;font-size:12px;font-weight:700;
                                   border:1.5px solid ${optedIn ? '#5fff5f' : '#777'};border-radius:14px;cursor:pointer;
                                   background:${optedIn ? '#10331f' : 'transparent'};color:${optedIn ? '#5fff5f' : '#aaa'}">
                            🔔 Notify Slack: ${optedIn ? 'ON' : 'OFF'}
                        </button>
                        <span style="color:#888;font-size:10px;margin-left:8px;font-style:italic">${optedIn ? 'this finding is posting to Slack' : 'validator findings are silent by default'}</span>
                    </div>` : '';
                actionSectionHtml = `
                    ${validatorSlackToggle}
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
            const entitiesNote = !isSiteIssue
                ? `<span style="color:#888;font-style:italic">Affected entities are detected when this site is open — use ↗ Open in site.</span>`
                : !mapObjects
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
                // v1.15.1: real <button> so the header drag handler skips it
                // (it skips buttons) and the click fires reliably. Opens via
                // GM_openInTab (iframe sandbox blocks <a target=_blank>).
                slackBadge = `<button type="button" class="aim-issues-slack-link" data-href="${permalink}"
                        title="Reported to Slack — click to open the thread"
                        style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:9px;
                               background:#10331f;color:#5fff5f;font:inherit;font-size:9px;font-weight:700;
                               border:1px solid rgba(95,255,95,0.45);letter-spacing:0.5px;cursor:pointer">
                       ✓ SLACK
                   </button>`;
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
            } else if (canDelete || canReinstate || canResend || canReshape || canConvert || !isSiteIssue) {
                // deleteBtnHtml carries margin-right:auto, pushing the
                // non-destructive actions (convert/reshape/resend) to the
                // right edge; if there's no delete button, they still align
                // right via the spacer.
                const spacer = deleteBtnHtml ? '' : '<span style="margin-right:auto"></span>';
                // v1.41: fleet-opened issue → ↗ Open in site (new tab, deep-linked)
                const openSiteBtnHtml = !isSiteIssue
                    ? `<button id="aim-issues-modal-opensite"
                           title="Open site ${escHtml(String(modalCtx.sid))} in a new tab, zoomed to this issue"
                           style="padding:7px 14px;background:#13294a;color:#5fb3ff;border:1px solid #5fb3ff;border-radius:4px;cursor:pointer;font:inherit;font-weight:700">
                           ↗ Open in site
                       </button>`
                    : '';
                footerHtml = `<div style="${footerBase}">${deleteBtnHtml}${reinstateBtnHtml}${spacer}${openSiteBtnHtml}${convertBtnHtml}${reshapeBtnHtml}${moveIconBtnHtml}${resendBtnHtml}</div>`;
            }
            card.innerHTML = `
                <div id="aim-issues-modal-header"
                     style="padding:10px 14px;background:#14171b;border-bottom:1px solid rgba(255,255,255,0.10);
                            display:flex;align-items:center;gap:10px;cursor:move;user-select:none;flex-shrink:0"
                     title="Drag to move the popup">
                    <span style="color:#aaa;font-size:14px;font-weight:600">Issue ·</span>
                    <span style="color:${statusMeta.color};font-weight:700;font-size:14px">${statusMeta.text}</span>
                    ${!isSiteIssue ? `<span title="Site ${escHtml(String(modalCtx.sid))}" style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:9px;background:#1a2029;color:#7adfe6;font-size:9px;font-weight:700;border:1px solid rgba(122,223,230,0.45);letter-spacing:0.3px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🌐 ${escHtml(modalCtx.name || ('site ' + modalCtx.sid))}</span>` : ''}
                    ${isUnshielded(liveIssue) ? `<span title="Unshielded Route — stays visible on the map when approved" style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:9px;background:#241536;color:${CATEGORY_META.unshielded.color};font-size:9px;font-weight:700;border:1px solid ${CATEGORY_META.unshielded.color}77;letter-spacing:0.3px">🛡✕ UNSHIELDED</span>` : ''}
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
                // v1.15: the badge sits in the draggable header, which was
                // eating the click — bind capture-phase pointerdown (like the
                // chips) so it fires before the drag logic. Always toast so we
                // know it fired even if opening is blocked.
                let lastOpen = 0;
                const openSlack = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const now = Date.now();
                    if (now - lastOpen < 400) return;   // ignore the paired event
                    lastOpen = now;
                    const href = slackLink.dataset.href;
                    if (!href) return;
                    let opened = false;
                    if (typeof GM_openInTab === 'function') {
                        try { GM_openInTab(href, { active: true, insert: true, setParent: true }); opened = true; } catch (e2) {}
                    }
                    if (!opened) { try { opened = !!(window.top || window).open(href, '_blank'); } catch (e3) {} }
                    if (opened) {
                        showToast('Opening Slack thread…', 1500);
                    } else {
                        copyTextToClipboard(href)
                            .then(() => showToast('Slack link copied — paste it in your browser.', 3500))
                            .catch(() => showToast('Could not open Slack link.', 3000));
                    }
                };
                slackLink.addEventListener('pointerdown', openSlack, true);
                slackLink.addEventListener('click', openSlack, true);
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

            // v1.19: validator "🔔 Notify Slack" opt-in toggle. Turning it ON
            // sets the flag (so slackPostable now passes) then backfills the
            // parent thread; OFF just stops future posts (existing thread stays).
            const slackToggle = card.querySelector('.aim-issues-slacknotify-toggle');
            if (slackToggle) {
                let lastToggle = 0;
                const onToggle = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const now = Date.now();
                    if (now - lastToggle < 350) return;
                    lastToggle = now;
                    const issueObj = resolveIssue(liveIssue.id) || liveIssue;
                    const turningOn = !issueObj.slackNotifyOptIn;
                    issueObj.slackNotifyOptIn = turningOn;
                    if (turningOn) {
                        showToast('Escalating finding to Slack…', 2000);
                        ensureSlackThread(issueObj).then((ts) => {
                            if (!ts) showToast('Could not post to Slack — see console.', 4000);
                            render();
                        });
                    } else {
                        showToast('Slack notifications off for this finding (existing thread kept).', 3000);
                    }
                    render();
                };
                slackToggle.addEventListener('pointerdown', onToggle, true);
                slackToggle.addEventListener('click', onToggle, true);
            }

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
            // v1.26: Reinstate (two-stage confirm, mirrors Delete).
            const reinstateBtn = card.querySelector('#aim-issues-modal-reinstate');
            if (reinstateBtn) {
                reinstateBtn.onclick = () => {
                    if (reinstateBtn.dataset.armed === '1') {
                        reinstateIssue(liveIssue.id);
                        closeStatusModal();
                        return;
                    }
                    reinstateBtn.dataset.armed = '1';
                    reinstateBtn.textContent = '♻ Click again to confirm reinstate';
                    reinstateBtn.style.background = '#5fff5f';
                    reinstateBtn.style.color = '#06210f';
                    setTimeout(() => {
                        if (!reinstateBtn || reinstateBtn.dataset.armed !== '1') return;
                        reinstateBtn.dataset.armed = '0';
                        render();
                    }, 5000);
                };
            }
            // v1.29: Resend to Slack (single click — non-destructive).
            const resendBtn = card.querySelector('#aim-issues-modal-resend');
            if (resendBtn) {
                resendBtn.onclick = () => {
                    resendBtn.disabled = true;
                    resendBtn.textContent = '📣 Sending…';
                    resendIssueToSlack(liveIssue.id);
                    // Re-render shortly so the button resets (the async resend
                    // toasts its own outcome).
                    setTimeout(() => { try { render(); } catch (e) {} }, 1500);
                };
            }
            // v1.30: Reshape — closes the modal (the ghost + draw session
            // take over the map; the modal would just cover it). Single
            // click is safe: the reshape has its own Apply/Cancel confirm.
            const reshapeBtn = card.querySelector('#aim-issues-modal-reshape');
            if (reshapeBtn) {
                reshapeBtn.onclick = () => {
                    closeStatusModal();
                    startReshape(liveIssue.id);
                };
            }
            // v1.37: Move icon — closes the modal (the draggable marker +
            // Apply/Cancel toolbar take over the map). Single click is safe:
            // the move has its own staged confirm.
            const moveIconBtn = card.querySelector('#aim-issues-modal-moveicon');
            if (moveIconBtn) {
                moveIconBtn.onclick = () => {
                    closeStatusModal();
                    startMarkerMove(liveIssue.id);
                };
            }
            // v1.38: ↩ Undo chips in the history list. Single click — the
            // undo is audited (compensating history entry) and itself
            // undoable, same safety class as Convert. Targets recompute at
            // click time in case a sync landed since the render.
            card.querySelectorAll('.aim-issues-hist-undo').forEach(btn => {
                btn.onclick = () => {
                    // Re-resolve by id — a background sync may have replaced
                    // the issue object since this render (merges build new
                    // objects; mutating a stale ref would be lost on save).
                    const live = resolveIssue(liveIssue.id);
                    if (!live || live.deleted) { showToast('Issue vanished in a sync — nothing changed.', 3500); return; }
                    const kind = btn.getAttribute('data-undo');
                    if (kind === 'reshape') {
                        const t = reshapeUndoTarget(live);
                        if (!t) { showToast('Nothing to undo — the pre-reshape shape was never recorded.', 3500); return; }
                        applyReshape(live, t.shape, t.polygon, `↩ undo of reshape by @${t.entry.by || '?'}`);
                    } else if (kind === 'markermove') {
                        const t = markerMoveUndoTarget(live);
                        if (!t) { showToast('Nothing to undo — the icon position is already automatic.', 3000); return; }
                        applyMarkerMove(live, t.pos, `↩ undo of icon move by @${t.entry.by || '?'}`);
                    }
                    render();
                };
            });
            // v1.31: category convert toggle. Non-destructive + audited, so
            // single click; re-render reflects the new chip/buttons.
            const convertBtn = card.querySelector('#aim-issues-modal-convert');
            if (convertBtn) {
                convertBtn.onclick = () => {
                    applyCategoryChange(liveIssue.id, isUnshielded(liveIssue) ? 'issue' : 'unshielded');
                    render();
                };
            }
            // v1.41: ↗ Open in site — deep link (same URL shape Slack uses).
            const openSiteBtn = card.querySelector('#aim-issues-modal-opensite');
            if (openSiteBtn) {
                openSiteBtn.onclick = () => openIssueInSite(modalCtx.sid, liveIssue.id);
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
                    // v1.15.1: also skip the ✓ SLACK badge so clicking it
                    // opens the thread instead of starting a drag.
                    if (e.target.closest('button, input, textarea, .aim-issues-slack-link')) return;
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
            if (isSiteIssue) renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
            if (panelEl) renderIssuesPanel();
            if (fleetPanelEl) renderFleetPanel();
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

    // ============================================================
    // v1.41 — FLEET ISSUES (#257). Every site's issues in one panel,
    // reviewable/actionable without entering the site. Lives here (not in
    // Fleet Tools) so there is ONE copy of the merge rules, the Slack
    // watermark, the role gates and the status modal. Fleet Tools is the
    // landing-page front door (tab-local DOM events on `document`).
    //
    // Loading: ONE issues/ listing (sha per file) → GM cache diff → only
    // changed files re-download → intersect with live /sites/ (names +
    // access; sites the user can't see are hidden + COUNTED, never silently
    // dropped; no /sites/ at all = fail closed). The current site is never
    // duplicated: ctxForSid(siteID) aliases the live list.
    //
    // Writing: same apply* mutations as in-site, resolved by issue id to a
    // per-site context; commitFleetSite PUTs that site's file (serialized
    // per site, 409/422 → refetch + union-merge + one retry). Slack goes
    // through the same posters (siteLabelForSlack resolves the site from
    // the issue's context).
    // ============================================================
    const FLEET_LAYOUT_KEY = 'aim-issues-fleet-layout';
    const FLEET_ATTENTION_STATUSES = ['open', 'pending_fix', 'pending_ignore', 'ready-for-review'];
    let fleetLayout = null;
    let fleetDragInFlight = false;
    let fleetFilters = new Set(FLEET_ATTENTION_STATUSES);   // default view = "Needs attention"
    let fleetPriorityFilters = new Set(['high', 'medium', 'low', 'none']);
    let fleetCategoryFilters = new Set(['issue', 'unshielded']);
    let fleetSearch = '';
    let fleetSoloSid = null;         // left-rail solo (null = all sites)
    let fleetOnlyMyReview = false;   // ⚡ pendings I can approve
    let fleetOnlyMine = false;       // 👤 assigned to me
    let fleetOnlyUnseen = false;     // ? unseen activity
    let fleetShowDeleted = false;    // approver-only tombstone view
    const fleetCollapsedSites = new Set();
    // v1.42: bulk selection (issue ids) + stale filter
    const fleetSelected = new Set();
    let fleetOnlyStale = false;
    let fleetStaleDays = 14;

    function fleetCacheReadAll() {
        try {
            const raw = gmGet(FLEET_CACHE_KEY, '');
            if (!raw) return {};
            const obj = JSON.parse(raw);
            return (obj && typeof obj === 'object') ? obj : {};
        } catch (e) { console.warn(`${TAG} fleet cache unreadable — starting fresh:`, e); return {}; }
    }
    function fleetCacheWriteAll(obj) {
        try { gmSet(FLEET_CACHE_KEY, JSON.stringify(obj)); }
        catch (e) { console.warn(`${TAG} fleet cache write failed:`, e); }
    }
    // Persist one context's issues into the cache (after a local mutation or
    // a successful PUT). Validator/local-only never reach a fleet ctx, but
    // filter anyway so the cache mirrors the file.
    function fleetCacheWrite(ctx) {
        if (!ctx || ctx.isSite) return;
        const all = fleetCacheReadAll();
        all[String(ctx.sid)] = {
            sha: ctx.sha || null,
            name: ctx.name || '',
            issues: (ctx.issues || []).filter(i => i && i.createdBy !== 'local-only' && i.source !== 'validator'),
        };
        fleetCacheWriteAll(all);
    }

    // /sites/ → Map<sid, {name, status}>. Same tolerant parsing as
    // fetchSiteNames (which the old stale sweep used) but keeps status.
    async function fetchSitesFull() {
        const resp = await fetch('/sites/', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
        if (!resp.ok) throw new Error(`/sites/ HTTP ${resp.status}`);
        const ct = resp.headers.get('content-type') || '';
        if (!/json/i.test(ct)) throw new Error('/sites/ returned non-JSON (logged out?)');
        const data = await resp.json();
        let list = Array.isArray(data) ? data : null;
        if (!list && data && typeof data === 'object') {
            for (const k of ['results', 'objects', 'data', 'sites', 'items']) {
                if (Array.isArray(data[k])) { list = data[k]; break; }
            }
        }
        const map = new Map();
        (list || []).forEach(s => {
            const id = String(s.id != null ? s.id : (s.site_id != null ? s.site_id : (s.pk != null ? s.pk : '')));
            const name = String(s.name || s.site_name || s.title || '').trim();
            if (id) map.set(id, { name: name || `site ${id}`, status: String(s.status || '') });
        });
        return map;
    }

    // issues/ listing → [{sid, sha}] for THIS environment's files only.
    async function listIssueFilesWithSha() {
        const url = `${GITHUB_API_BASE}/repos/${ISSUES_REPO}/contents/issues?ref=${ISSUES_BRANCH}`;
        const resp = await ghRequest({
            method: 'GET', url,
            headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github+json' },
            timeout: 20000,
        });
        if (resp.status === 404) return [];
        if (resp.status !== 200) throw new Error(`list issues/ HTTP ${resp.status}`);
        const arr = JSON.parse(resp.responseText);
        if (!Array.isArray(arr)) return [];
        const fileRe = IS_QA ? /^qa-(\d+)-issues\.json$/ : /^(\d+)-issues\.json$/;
        const out = [];
        for (const f of arr) {
            const m = f && f.name && f.name.match(fileRe);
            if (m) out.push({ sid: m[1], sha: f.sha || null });
        }
        return out;
    }

    // Load (or refresh) every site's issues. `force` re-downloads everything
    // regardless of sha. Safe to call repeatedly; concurrent calls coalesce.
    async function fleetLoad(force) {
        if (fleetLoading) return;
        if (!cachedToken) { fleetLoadError = 'No GitHub token — save your PAT in AIM Controls.'; fleetEmitSummary(); if (fleetPanelEl) renderFleetPanel(); return; }
        fleetLoading = true;
        fleetLoadError = '';
        if (fleetPanelEl) renderFleetPanel();
        try {
            // 1. Access authority — fail closed without it.
            let sites;
            try { sites = await fetchSitesFull(); }
            catch (e) { throw new Error(`could not verify site access (${e.message || e}) — nothing shown`); }
            fleetSites = sites;
            // 2. File listing (sha per site file).
            const files = await listIssueFilesWithSha();
            const cache = fleetCacheReadAll();
            const next = new Map();
            let fetched = 0, reused = 0, failed = 0;
            fleetHiddenNoAccess = 0;
            for (const f of files) {
                const sid = String(f.sid);
                const site = sites.get(sid);
                if (!site) { fleetHiddenNoAccess++; continue; }   // not the user's site — hidden + counted
                const isCurrent = siteID && sid === String(siteID) && !IS_TOP;
                const cached = cache[sid];
                let issues = null, sha = f.sha;
                if (!force && cached && cached.sha && cached.sha === f.sha && Array.isArray(cached.issues)) {
                    issues = cached.issues; reused++;
                } else {
                    try {
                        const remote = await fetchRemoteIssues(sid);
                        if (remote) { issues = remote.issues; sha = remote.sha; fetched++; }
                        else issues = [];
                    } catch (e) {
                        failed++;
                        console.warn(`${TAG} fleet: site ${sid} fetch failed:`, e);
                        if (cached && Array.isArray(cached.issues)) { issues = cached.issues; sha = cached.sha; }
                        else continue;
                    }
                }
                // An existing fleet ctx is REUSED in place (never replaced):
                // commitFleetSite holds a reference to it across an in-flight
                // PUT and clears `committing` on THAT object — a fresh object
                // would keep committing:true forever and never PUT again.
                // Its issues are always union-merged onto the fresh copy so an
                // un-synced edit (failed/in-flight commit) is never dropped —
                // same reason refetchIssues merges local+remote in-site.
                const prev = fleetStore.get(sid);
                const merged = (prev && !prev.isSite) ? mergeIssueLists(prev.issues, issues) : issues;
                if (prev && !prev.isSite) {
                    Object.assign(prev, { name: site.name, status: site.status, issues: merged, isCurrentAlias: !!isCurrent });
                    if (!prev.committing) prev.sha = sha;   // mid-PUT: the PUT response owns the sha
                    next.set(sid, prev);
                } else {
                    next.set(sid, {
                        sid, name: site.name, status: site.status, isSite: false,
                        issues: merged, sha, committing: false, commitAgain: false,
                        isCurrentAlias: !!isCurrent,
                    });
                }
                cache[sid] = { sha, name: site.name, issues: merged.filter(i => i && i.createdBy !== 'local-only' && i.source !== 'validator') };
            }
            // Drop cache entries for files that no longer exist.
            Object.keys(cache).forEach(k => { if (!files.some(f => String(f.sid) === k)) delete cache[k]; });
            fleetCacheWriteAll(cache);
            fleetStore.clear();
            next.forEach((v, k) => fleetStore.set(k, v));
            fleetLoadedAt = Date.now();
            Array.from(fleetSelected).forEach(id => { if (!resolveIssue(id)) fleetSelected.delete(id); });
            console.log(`${TAG} fleet loaded: ${fleetStore.size} site(s) · ${fetched} fetched · ${reused} cached · ${failed} failed · ${fleetHiddenNoAccess} hidden (no access)`);
            if (failed) fleetLoadError = `${failed} site file(s) failed to download — showing cached copies where available`;
        } catch (e) {
            fleetLoadError = String(e && e.message || e);
            console.error(`${TAG} fleet load failed:`, e);
        } finally {
            fleetLoading = false;
            fleetEmitSummary();
            if (fleetPanelEl) renderFleetPanel();
        }
    }

    // Per-site serialized PUT for a fleet context. Mirrors
    // commitIssuesToGitHub's guarantees: one in-flight PUT per site, a
    // follow-up if edits landed mid-flight, 409/422 → refetch + union-merge +
    // one retry, and the new sha banked on success.
    async function commitFleetSite(ctx, reason, isRetry) {
        if (!ctx || ctx.isSite || !cachedToken) return false;
        if (ctx.committing) { ctx.commitAgain = true; return false; }
        ctx.committing = true;
        setSyncStatus('syncing');
        const sid = String(ctx.sid);
        try {
            const issuesToSync = (ctx.issues || []).filter(i => i && i.createdBy !== 'local-only' && i.source !== 'validator');
            const url = `${GITHUB_API_BASE}/repos/${ISSUES_REPO}/contents/${encodeURIComponent(ISSUES_PATH(sid))}`;
            const body = {
                message: `[AIM site ${sid}] issues: ${reason || 'fleet update'}`,
                content: textToB64(JSON.stringify({ version: 1, siteID: sid, issues: issuesToSync }, null, 2)),
                branch: ISSUES_BRANCH,
            };
            if (ctx.sha) body.sha = ctx.sha;
            const resp = await ghRequest({
                method: 'PUT', url,
                headers: { 'Authorization': `Bearer ${cachedToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
                data: JSON.stringify(body),
                timeout: 25000,
            });
            if (resp.status === 200 || resp.status === 201) {
                const ret = JSON.parse(resp.responseText);
                if (ret && ret.content && ret.content.sha) ctx.sha = ret.content.sha;
                fleetCacheWrite(ctx);
                setSyncStatus('ok');
                showToast(`✓ Site ${ctx.name || sid} synced to GitHub.`, 2500);
                return true;
            }
            if ((resp.status === 409 || resp.status === 422) && !isRetry) {
                console.warn(`${TAG} fleet commit conflict on site ${sid} (HTTP ${resp.status}) — refetch + merge + retry`);
                const remote = await fetchRemoteIssues(sid);
                if (remote) { ctx.issues = mergeIssueLists(ctx.issues, remote.issues); ctx.sha = remote.sha; }
                else ctx.sha = null;
                ctx.committing = false;
                if (fleetPanelEl) renderFleetPanel();
                return commitFleetSite(ctx, reason, true);
            }
            setSyncStatus('error');
            if (resp.status === 401 || resp.status === 403) showToast('GitHub denied write — PAT needs contents:write on aim-userscripts-data.', 8000);
            else showToast(`Commit failed for site ${sid}: HTTP ${resp.status}.`, 4500);
            console.warn(`${TAG} fleet commit site ${sid} HTTP ${resp.status}:`, (resp.responseText || '').slice(0, 600));
            return false;
        } catch (e) {
            setSyncStatus('error');
            showToast(`Commit failed for site ${sid}: ${e.message || 'network error'}.`, 4500);
            console.error(`${TAG} fleet commit threw:`, e);
            return false;
        } finally {
            ctx.committing = false;
            if (ctx.commitAgain) {
                ctx.commitAgain = false;
                setTimeout(() => commitFleetSite(ctx, 'follow-up after concurrent change'), 100);
            }
        }
    }

    // Deep link — same URL shape the Slack messages carry; AIM Issues in the
    // target tab zooms to + opens the issue via maybeFocusPendingIssue.
    function issueDeepLink(sid, issueId) {
        const q = issueId ? `?aim_issue=${encodeURIComponent(issueId)}` : '';
        return `${location.origin}/${q}#/site/${encodeURIComponent(String(sid))}/control-panel/site-setup`;
    }
    function openIssueInSite(sid, issueId) {
        const href = issueDeepLink(sid, issueId);
        let opened = false;
        if (typeof GM_openInTab === 'function') {
            try { GM_openInTab(href, { active: true, insert: true, setParent: true }); opened = true; } catch (e) {}
        }
        if (!opened) { try { opened = !!(window.top || window).open(href, '_blank'); } catch (e) {} }
        if (opened) showToast('Opening site in a new tab…', 1500);
        else copyTextToClipboard(href).then(() => showToast('Site link copied — paste it in your browser.', 3500))
                                      .catch(() => showToast('Could not open the site link.', 3000));
    }

    // ---- Fleet Tools bridge (tab-local DOM events; NOT BroadcastChannel) ----
    function fleetSummary() {
        let open = 0, pending = 0, myPending = 0, unseen = 0, total = 0;
        fleetStore.forEach(ctx => {
            liveIssues(ctx.issues).forEach(i => {
                if (i.source === 'validator') return;
                total++;
                if (i.status === 'open' || i.status === 'ready-for-review') open++;
                if (i.status === 'pending_fix' || i.status === 'pending_ignore') {
                    pending++;
                    if (isApproverFor(i)) myPending++;
                }
                if (unseenHistoryFor(i).length) unseen++;
            });
        });
        return {
            open, pending, myPending: isAnyApprover() ? myPending : 0, unseen, total,
            sites: fleetStore.size, hiddenNoAccess: fleetHiddenNoAccess,
            loadedAt: fleetLoadedAt, loading: fleetLoading, error: fleetLoadError,
            hasToken: !!cachedToken, version: SCRIPT_VERSION,
        };
    }
    function fleetEmitSummary() {
        try { document.dispatchEvent(new CustomEvent('aim-fleet:issues-summary', { detail: fleetSummary() })); }
        catch (e) { console.warn(`${TAG} fleet summary event threw:`, e); }
    }
    function setupFleetBridge() {
        document.addEventListener('aim-fleet:open-issues', () => {
            try { openFleetPanel(); } catch (e) { console.error(`${TAG} open fleet panel threw:`, e); }
        });
        document.addEventListener('aim-fleet:issues-request', () => {
            fleetEmitSummary();
            if (!fleetLoadedAt && !fleetLoading && cachedToken) fleetLoad(false);
        });
    }

    // ---- Fleet panel ----
    function loadFleetLayout() {
        try { const raw = localStorage.getItem(FLEET_LAYOUT_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === 'object') ? o : null; }
        catch (e) { return null; }
    }
    function saveFleetLayout(l) { try { localStorage.setItem(FLEET_LAYOUT_KEY, JSON.stringify(l)); } catch (e) {} }
    function clampFleetLayout(l) {
        const minW = 640, minH = 320;
        const vw = window.innerWidth, vh = window.innerHeight;
        const out = { ...l };
        out.width  = Math.max(minW, Math.min(out.width  || 980, vw - 20));
        out.height = Math.max(minH, Math.min(out.height || 660, vh - 20));
        out.left = Math.max(10 - out.width + 80, Math.min(out.left, vw - 80));
        out.top  = Math.max(10, Math.min(out.top, vh - 40));
        return out;
    }
    function openFleetPanel() {
        if (fleetPanelEl) { renderFleetPanel(); return; }
        const stored = loadFleetLayout();
        fleetLayout = clampFleetLayout(stored || {
            left: Math.max(10, Math.round((window.innerWidth - 980) / 2)),
            top: 50, width: 980, height: Math.min(680, window.innerHeight - 80),
        });
        const panel = document.createElement('div');
        panel.id = 'aim-issues-fleet-panel';
        panel.style.cssText = `
            position:fixed;left:${fleetLayout.left}px;top:${fleetLayout.top}px;
            width:${fleetLayout.width}px;height:${fleetLayout.height}px;
            background:#1f2228;border:1px solid rgba(122,223,230,0.55);border-radius:10px;
            box-shadow:0 8px 32px rgba(0,0,0,0.6);z-index:99100;color:#e6e6e6;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            display:flex;flex-direction:column;overflow:hidden;
        `;
        ['mousedown','pointerdown','wheel','dblclick','click','contextmenu','touchstart'].forEach(evt => {
            panel.addEventListener(evt, (e) => e.stopPropagation(), false);
        });
        document.body.appendChild(panel);
        fleetPanelEl = panel;
        renderFleetPanel();
        console.log(`${TAG} fleet panel opened`);
        if (!fleetLoadedAt && !fleetLoading) fleetLoad(false);
        else if (fleetLoadedAt && Date.now() - fleetLoadedAt > 5 * 60000) fleetLoad(false);   // stale → refresh in place
    }
    function closeFleetPanel() {
        if (fleetPanelEl) { try { fleetPanelEl.remove(); } catch (e) {} }
        fleetPanelEl = null;
        closeBulkModal();
        closeFleetSummary();
    }

    function fleetIssueMatches(issue, ctx) {
        const st = issue.status || 'open';
        if (!fleetFilters.has(st)) return false;
        if (!fleetCategoryFilters.has(issueCategory(issue))) return false;
        if (!fleetPriorityFilters.has(issue.priority || 'none')) return false;
        if (fleetOnlyMyReview && !((st === 'pending_fix' || st === 'pending_ignore') && isApproverFor(issue))) return false;
        if (fleetOnlyMine && (issue.assignee || null) !== (cachedUsername || null)) return false;
        if (fleetOnlyUnseen && !unseenHistoryFor(issue).length) return false;
        if (fleetOnlyStale && (Date.now() - new Date(lastEventAt(issue)).getTime()) < fleetStaleDays * 86400000) return false;
        const q = fleetSearch.trim().toLowerCase();
        if (!q) return true;
        if ((issue.note || '').toLowerCase().includes(q)) return true;
        if ((issue.createdBy || '').toLowerCase().includes(q)) return true;
        if ((issue.assignee || '').toLowerCase().includes(q)) return true;
        if ((ctx.name || '').toLowerCase().includes(q) || String(ctx.sid) === q) return true;
        if (issue.id.toLowerCase() === q) return true;
        return (issue.history || []).some(h => (h.note || '').toLowerCase().includes(q) || (h.by || '').toLowerCase() === q);
    }

    // Every fleet context INCLUDING the current site (aliased to the live
    // list so in-site edits show without a refetch).
    function fleetContexts() {
        const out = [];
        fleetStore.forEach(ctx => {
            if (ctx.isCurrentAlias && !IS_TOP) out.push({ ...siteCtx(), name: ctx.name || siteName, status: ctx.status, fleetSha: ctx.sha });
            else out.push(ctx);
        });
        return out;
    }

    function renderFleetPanel() {
        if (!fleetPanelEl || fleetDragInFlight) return;
        const ae = document.activeElement;
        const wasSearchFocused = ae && ae.id === 'aim-issues-fleet-search';
        const selS = wasSearchFocused ? ae.selectionStart : null, selE = wasSearchFocused ? ae.selectionEnd : null;

        const contexts = fleetContexts();
        const showingDeleted = fleetShowDeleted && isAnyApprover();
        const perSite = contexts.map(ctx => {
            const live = liveIssues(ctx.issues).filter(i => i.source !== 'validator');
            const deleted = (ctx.issues || []).filter(i => i && i.deleted && i.source !== 'validator');
            const base = showingDeleted ? deleted : live;
            const visible = base.filter(i => fleetIssueMatches(i, ctx))
                .sort((a, b) => new Date(lastEventAt(b)).getTime() - new Date(lastEventAt(a)).getTime());
            const open = live.filter(i => i.status === 'open' || i.status === 'ready-for-review').length;
            const pending = live.filter(i => i.status === 'pending_fix' || i.status === 'pending_ignore').length;
            const myPending = isAnyApprover() ? live.filter(i => (i.status === 'pending_fix' || i.status === 'pending_ignore') && isApproverFor(i)).length : 0;
            const unseen = live.filter(i => unseenHistoryFor(i).length > 0).length;
            const mine = cachedUsername ? live.filter(i => (i.assignee || null) === cachedUsername).length : 0;
            return { ctx, live, deleted, visible, open, pending, myPending, unseen, mine };
        });
        // Left rail order: my review queue first, then open count, then name.
        perSite.sort((a, b) => (b.myPending - a.myPending) || (b.open - a.open) || (b.pending - a.pending)
            || String(a.ctx.name || '').localeCompare(String(b.ctx.name || '')));
        const allLive = perSite.flatMap(p => p.live);
        const counts = { open: 0, pending_fix: 0, pending_ignore: 0, 'ready-for-review': 0, resolved: 0, ignored: 0 };
        allLive.forEach(i => { const s = i.status || 'open'; if (counts[s] !== undefined) counts[s]++; });
        const catCounts = { issue: 0, unshielded: 0 };
        allLive.forEach(i => { catCounts[issueCategory(i)]++; });
        const priCounts = { high: 0, medium: 0, low: 0, none: 0 };
        allLive.forEach(i => { const k = i.priority || 'none'; if (priCounts[k] !== undefined) priCounts[k]++; });
        const totalMyPending = perSite.reduce((n, p) => n + p.myPending, 0);
        const totalUnseen = perSite.reduce((n, p) => n + p.unseen, 0);
        const totalMine = perSite.reduce((n, p) => n + p.mine, 0);
        const totalDeleted = perSite.reduce((n, p) => n + p.deleted.length, 0);
        const shown = perSite.filter(p => !fleetSoloSid || String(p.ctx.sid) === String(fleetSoloSid));
        const visibleAll = shown.flatMap(p => p.visible.map(i => ({ issue: i, ctx: p.ctx })));

        const DARK = new Set(['pending_fix', 'ready-for-review', 'resolved']);
        const chip = (cls, data, active, color, label, n, fg, title, dashed) =>
            `<button class="${cls}" ${data} title="${escHtml(title || '')}"
                style="padding:4px 9px;border-radius:13px;font:inherit;font-size:11px;font-weight:700;
                       border:1.5px ${dashed ? 'dashed' : 'solid'} ${color};background:${active ? color : 'transparent'};
                       color:${active ? fg : color};cursor:pointer;opacity:${active ? 1 : 0.55};
                       display:inline-flex;align-items:center;gap:5px">
                <span>${label}</span>
                <span style="background:rgba(0,0,0,0.25);padding:1px 5px;border-radius:8px;font-size:10px">${n}</span>
            </button>`;
        const statusChips = PANEL_STATUS_ORDER.map(st => {
            const m = STATUS_LABEL[st] || { text: st.toUpperCase(), color: '#888' };
            if (st === 'ready-for-review' && !counts[st]) return '';
            return chip('aim-fleet-chip', `data-status="${st}"`, fleetFilters.has(st), m.color, m.text, counts[st] || 0,
                DARK.has(st) ? '#000' : '#fff', `M1 toggle · M2 solo ${m.text.toLowerCase()}`);
        }).join('');
        const catChips = [
            { key: 'issue', label: '🚩 Issues', color: '#ff8585', fg: '#2a0d0d' },
            { key: 'unshielded', label: '🛡✕ Unshielded', color: CATEGORY_META.unshielded.color, fg: '#1a0d26' },
        ].map(c => chip('aim-fleet-catchip', `data-category="${c.key}"`, fleetCategoryFilters.has(c.key), c.color, c.label, catCounts[c.key], c.fg, 'M1 toggle · M2 solo')).join('');
        const priChips = ['high', 'medium', 'low', 'none'].map(p => {
            const m = p === 'none' ? { text: 'NONE', color: '#888', textColor: '#fff' } : priorityMeta(p);
            return chip('aim-fleet-prichip', `data-priority="${p}"`, fleetPriorityFilters.has(p), m.color, `${p === 'none' ? '—' : '🎯'} ${m.text}`, priCounts[p], m.textColor, 'M1 toggle · M2 solo');
        }).join('');
        const quickChips = [
            isAnyApprover() ? chip('aim-fleet-quick', 'data-quick="review"', fleetOnlyMyReview, '#5fff5f', '⚡ Needs my review', totalMyPending, '#06210f', 'Only pending proposals YOU can approve', true) : '',
            cachedUsername ? chip('aim-fleet-quick', 'data-quick="mine"', fleetOnlyMine, '#5fb3ff', '👤 Assigned to me', totalMine, '#0a1a2a', 'Only issues assigned to you', true) : '',
            chip('aim-fleet-quick', 'data-quick="unseen"', fleetOnlyUnseen, '#00FF7F', '? Unseen activity', totalUnseen, '#003318', 'Only issues with activity you have not viewed yet', true),
            chip('aim-fleet-quick', 'data-quick="stale"', fleetOnlyStale, '#ffa726', `⏳ Stale ≥ ${fleetStaleDays} d`,
                allLive.filter(i => (i.status === 'open' || i.status === 'ready-for-review' || (i.status || '').startsWith('pending')) && (Date.now() - new Date(lastEventAt(i)).getTime()) >= fleetStaleDays * 86400000).length,
                '#2a1a00', 'Only issues with no activity for at least this many days (set the days in the box)', true)
            + `<input id="aim-issues-fleet-staledays" type="number" min="1" max="365" value="${fleetStaleDays}" title="Stale threshold in days" style="width:44px;background:#0e1115;color:#fff;border:1px solid rgba(255,167,38,0.4);border-radius:3px;font:inherit;font-size:10px;padding:2px 4px">`,
            isAnyApprover() ? chip('aim-fleet-quick', 'data-quick="deleted"', showingDeleted, '#ff8585', '🗑 Deleted', totalDeleted, '#2a0d0d', 'Show tombstoned issues (reinstate from the modal)', true) : '',
        ].join('');
        // v1.42: saved views (built-in + user) in a select; any manual chip
        // change flips the select to "Custom" until a view is picked again.
        const userViews = fleetUserViews();
        const viewOpts = fleetBuiltinViews().map(v => `<option value="b:${v.key}" ${fleetActiveViewKey === v.key ? 'selected' : ''}>${escHtml(v.name)}</option>`).join('')
            + (userViews.length ? `<optgroup label="My views">${userViews.map((v, i) => `<option value="u:${i}" ${fleetActiveViewKey === 'u:' + i ? 'selected' : ''}>💾 ${escHtml(v.name)}</option>`).join('')}</optgroup>` : '')
            + `<option value="custom" ${fleetActiveViewKey === 'custom' ? 'selected' : ''} disabled>Custom…</option>`;
        const isUserView = fleetActiveViewKey.startsWith('u:');
        const viewBtns = `
            <span style="color:#888;font-size:10px;font-weight:600">VIEW:</span>
            <select id="aim-issues-fleet-viewsel" title="Saved views — pick one, or adjust the chips and 💾 save your own"
                style="padding:4px 6px;border-radius:4px;font:inherit;font-size:11px;font-weight:700;cursor:pointer;border:1px solid rgba(122,223,230,0.5);background:#1a3a40;color:#7adfe6">${viewOpts}</select>
            <button id="aim-issues-fleet-viewsave" title="Save the current chips / search as a named view" style="padding:4px 8px;border-radius:4px;font:inherit;font-size:11px;cursor:pointer;border:1px solid rgba(122,223,230,0.35);background:transparent;color:#7adfe6">💾</button>
            ${isUserView ? `<button id="aim-issues-fleet-viewdel" title="Delete this saved view" style="padding:4px 8px;border-radius:4px;font:inherit;font-size:11px;cursor:pointer;border:1px solid rgba(255,133,133,0.35);background:transparent;color:#ff8585">🗑</button>` : ''}`;

        // Left rail
        const railRows = [`<div class="aim-fleet-site" data-sid="" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);
                background:${!fleetSoloSid ? 'rgba(122,223,230,0.12)' : 'transparent'};font-weight:700;color:#7adfe6">
                🌐 All sites <span style="color:#888;font-weight:400;font-size:10px">(${perSite.length})</span></div>`]
            .concat(perSite.map(p => {
                const solo = fleetSoloSid && String(p.ctx.sid) === String(fleetSoloSid);
                const badges = [
                    p.myPending ? `<span title="pending your review" style="background:#ffa726;color:#000;padding:0 5px;border-radius:7px;font-size:9px;font-weight:700">⚡${p.myPending}</span>` : (p.pending ? `<span title="pending review" style="background:#8000FF;color:#fff;padding:0 5px;border-radius:7px;font-size:9px;font-weight:700">${p.pending}</span>` : ''),
                    p.open ? `<span title="open" style="background:#ff4d4d;color:#fff;padding:0 5px;border-radius:7px;font-size:9px;font-weight:700">${p.open}</span>` : '',
                    p.unseen ? `<span class="aim-issues-activity-dot" title="${p.unseen} with unseen activity" style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:#00FF7F;color:#000;font-size:9px;font-weight:900">?</span>` : '',
                ].join(' ');
                const dim = !p.open && !p.pending;
                return `<div class="aim-fleet-site" data-sid="${escHtml(String(p.ctx.sid))}" title="Site ${escHtml(String(p.ctx.sid))} · ${p.live.length} live issue(s) · click to solo"
                    style="padding:6px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;gap:6px;
                           background:${solo ? 'rgba(122,223,230,0.12)' : 'transparent'};opacity:${dim ? 0.6 : 1}">
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:${p.ctx.isSite ? '#5fff5f' : '#e6e6e6'}">${escHtml(p.ctx.name || ('site ' + p.ctx.sid))}</span>
                    ${badges}
                </div>`;
            }));

        // Rows (grouped by site unless soloed)
        let rowsHtml = '';
        if (!cachedToken) {
            rowsHtml = `<div style="padding:30px;color:#888;text-align:center;font-style:italic">No GitHub token — save your PAT in AIM Controls (gear) to load fleet issues.</div>`;
        } else if (fleetLoadError && !fleetStore.size) {
            rowsHtml = `<div style="padding:30px;color:#ff8585;text-align:center">⚠ ${escHtml(fleetLoadError)}</div>`;
        } else if (fleetLoading && !fleetStore.size) {
            rowsHtml = `<div style="padding:30px;color:#888;text-align:center;font-style:italic">⏳ Loading every site's issues…</div>`;
        } else if (!visibleAll.length) {
            rowsHtml = `<div style="padding:30px;color:#888;text-align:center;font-style:italic">${allLive.length ? 'No issues match the current filters.' : 'No issues anywhere yet.'}</div>`;
        } else {
            const rowHtml = (issue, ctx) => {
                const meta = STATUS_LABEL[issue.status || 'open'] || { text: 'OPEN', color: '#ff4d4d' };
                const priM = issue.priority ? priorityMeta(issue.priority) : null;
                const unseen = unseenHistoryFor(issue);
                const isPending = issue.status === 'pending_fix' || issue.status === 'pending_ignore';
                const canReview = isPending && isApproverFor(issue) && !issue.deleted;
                const approveTo = issue.status === 'pending_fix' ? 'resolved' : 'ignored';
                const actions = issue.deleted ? '' : `
                    ${canReview ? `<button class="aim-fleet-act" data-act="approve" data-id="${issue.id}" title="Approve this proposal" style="padding:3px 8px;background:#10331f;color:#5fff5f;border:1px solid #5fff5f;border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">✓</button>
                                   <button class="aim-fleet-act" data-act="reject" data-id="${issue.id}" title="Reject → back to Open (note required)" style="padding:3px 8px;background:#5a2222;color:#ff8585;border:1px solid #ff4d4d;border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">✗</button>` : ''}
                    <button class="aim-fleet-act" data-act="comment" data-id="${issue.id}" title="Add a comment" style="padding:3px 8px;background:#1a2333;color:#a8c4ff;border:1px solid #a8c4ff66;border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">💬</button>
                    <button class="aim-fleet-act" data-act="site" data-id="${issue.id}" data-sid="${escHtml(String(ctx.sid))}" title="${ctx.isSite ? 'Zoom to this issue on the map' : 'Open the site in a new tab, zoomed to this issue'}" style="padding:3px 8px;background:#13294a;color:#5fb3ff;border:1px solid #5fb3ff66;border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">${ctx.isSite ? '🎯' : '↗'}</button>`;
                const sel = fleetSelected.has(issue.id);
                return `<div class="aim-fleet-row" data-id="${issue.id}" title="Click to open the issue"
                    style="padding:7px 12px;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;
                           display:grid;grid-template-columns:20px 96px 1fr 120px 110px auto;gap:8px;align-items:center;
                           background:${sel ? 'rgba(122,223,230,0.08)' : 'transparent'};
                           opacity:${(issue.status === 'resolved' || issue.status === 'ignored') ? 0.6 : 1}">
                    <input type="checkbox" class="aim-fleet-sel" data-id="${issue.id}" ${sel ? 'checked' : ''} title="Select for a bulk action" style="cursor:pointer;margin:0">
                    <div>
                        <span style="display:inline-block;padding:2px 6px;border-radius:8px;background:${meta.color};color:${DARK.has(issue.status) ? '#000' : '#fff'};font-size:10px;font-weight:700">${meta.text}</span>
                        ${priM ? `<div style="margin-top:2px"><span style="display:inline-block;padding:1px 5px;border-radius:6px;background:${priM.color};color:${priM.textColor};font-size:9px;font-weight:700">🎯 ${priM.text}</span></div>` : ''}
                        ${isUnshielded(issue) ? `<div style="margin-top:2px"><span style="display:inline-block;padding:1px 5px;border-radius:6px;background:${CATEGORY_META.unshielded.color};color:#1a0d26;font-size:9px;font-weight:700">🛡✕</span></div>` : ''}
                        ${issue.deleted ? `<div style="font-size:9px;color:#ff8585;margin-top:2px;font-weight:700">🗑 DELETED</div>` : ''}
                    </div>
                    <div style="color:#e6e6e6;font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;${issue.deleted ? 'text-decoration:line-through;color:#999' : ''}">${escHtml(issue.note)}</div>
                    <div style="color:#a8c4ff;font-size:11px;font-weight:600;overflow:hidden">
                        ${escHtml(lastEventLabel(issue))}${unseen.length ? `<span class="aim-issues-activity-dot" title="${unseen.length} unseen event(s) — open to dismiss" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#00FF7F;color:#000;font-size:10px;font-weight:900;margin-left:5px;vertical-align:middle">?</span>` : ''}
                        <div style="color:#888;font-weight:400;font-size:10px">${relativeAge(lastEventAt(issue))}</div>
                    </div>
                    <div style="color:#a8c4ff;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@${escHtml(issue.createdBy || '?')}
                        ${issue.assignee ? `<div style="color:#5fb3ff;font-size:10px">👤 ${escHtml(issue.assignee)}</div>` : ''}</div>
                    <div style="display:flex;gap:4px;white-space:nowrap">${actions}</div>
                </div>`;
            };
            rowsHtml = shown.filter(p => p.visible.length).map(p => {
                const collapsed = fleetCollapsedSites.has(String(p.ctx.sid)) && !fleetSoloSid;
                const head = `<div class="aim-fleet-group" data-sid="${escHtml(String(p.ctx.sid))}"
                    style="padding:6px 12px;background:#181b21;border-bottom:1px solid rgba(255,255,255,0.08);border-top:1px solid rgba(255,255,255,0.04);
                           display:flex;align-items:center;gap:8px;cursor:pointer;position:sticky;top:0;z-index:1">
                    <input type="checkbox" class="aim-fleet-selsite" data-sid="${escHtml(String(p.ctx.sid))}" ${p.visible.length && p.visible.every(i => fleetSelected.has(i.id)) ? 'checked' : ''} title="Select / clear every shown issue on this site" style="cursor:pointer;margin:0">
                    <span style="color:#7adfe6;font-size:10px">${collapsed ? '▶' : '▼'}</span>
                    <span style="font-weight:700;color:${p.ctx.isSite ? '#5fff5f' : '#7adfe6'}">${escHtml(p.ctx.name || ('site ' + p.ctx.sid))}</span>
                    <span style="color:#666;font-size:10px">#${escHtml(String(p.ctx.sid))}${p.ctx.isSite ? ' · this site' : ''}</span>
                    <span style="color:#888;font-size:10px">· ${p.visible.length} shown · ${p.open} open · ${p.pending} pending</span>
                    <button class="aim-fleet-act" data-act="opensite" data-sid="${escHtml(String(p.ctx.sid))}" title="Open this site's Site Setup in a new tab"
                        style="margin-left:auto;padding:2px 8px;background:transparent;color:#5fb3ff;border:1px solid #5fb3ff55;border-radius:4px;cursor:pointer;font:inherit;font-size:10px;font-weight:700">↗ site</button>
                </div>`;
                return head + (collapsed ? '' : p.visible.map(i => rowHtml(i, p.ctx)).join(''));
            }).join('');
        }

        const loadedAgo = fleetLoadedAt ? relativeAge(new Date(fleetLoadedAt).toISOString()) : 'never';
        const syncDot = ({ 'no-token': '#777', 'syncing': '#ffb347', 'ok': '#5fff5f', 'pending': '#ffb347', 'error': '#ff4d4d' })[syncStatus] || '#777';
        fleetPanelEl.innerHTML = `
            <div id="aim-issues-fleet-header" style="padding:9px 14px;background:#14171b;border-bottom:1px solid rgba(255,255,255,0.10);
                        display:flex;align-items:center;gap:10px;cursor:move;user-select:none;flex-shrink:0" title="Drag to move">
                <span style="font-size:16px">🌐</span>
                <span style="font-weight:700;color:#7adfe6">Fleet Issues</span>
                <span style="color:#888;font-size:11px">· ${perSite.length} site${perSite.length === 1 ? '' : 's'} · ${allLive.length} live</span>
                ${fleetHiddenNoAccess ? `<span style="color:#ffa030;font-size:10px" title="Issue files exist for sites that are not in your /sites/ list — hidden, never silently dropped">· ${fleetHiddenNoAccess} hidden (no access)</span>` : ''}
                <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px"><span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${syncDot}"></span><span style="color:#aaa">${cachedUsername ? '@' + escHtml(cachedUsername) : 'no token'}</span></span>
                <span style="color:#666;font-size:10px">· loaded ${escHtml(loadedAgo)}${fleetLoading ? ' · ⏳ refreshing…' : ''}</span>
                ${fleetLoadError && fleetStore.size ? `<span style="color:#ffa030;font-size:10px" title="${escHtml(fleetLoadError)}">⚠ partial</span>` : ''}
                <span style="margin-left:auto;display:flex;gap:6px">
                    <button id="aim-issues-fleet-summary" title="Fleet-wide summary: per-site counts, aging, pending queue, resolution stats — with Sheets / text export"
                        style="padding:4px 10px;background:#1a3a40;color:#7adfe6;border:1px solid rgba(122,223,230,0.5);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">📊 Summary</button>
                    <button id="aim-issues-fleet-export" ${visibleAll.length ? '' : 'disabled'} title="Copy the ${visibleAll.length} visible issue(s) as a formatted table — paste into Google Sheets / Excel"
                        style="padding:4px 10px;background:#3a3f48;color:#ffd54f;border:1px solid rgba(255,213,79,0.4);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700;opacity:${visibleAll.length ? 1 : 0.4}">📊 Copy → Sheets (${visibleAll.length})</button>
                    <button id="aim-issues-fleet-refresh" ${fleetLoading ? 'disabled' : ''} title="Re-check every site file on GitHub (only changed files download)"
                        style="padding:4px 10px;background:#3a3f48;color:#a8c4ff;border:1px solid rgba(168,196,255,0.3);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">↻ Refresh</button>
                    <button id="aim-issues-fleet-close" title="Close" style="padding:4px 10px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px">✕</button>
                </span>
            </div>
            <div style="padding:8px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,0.06);background:#181b21">
                ${viewBtns}<span style="width:1px;height:18px;background:rgba(255,255,255,0.12);margin:0 4px"></span>
                ${statusChips}<span style="width:1px;height:18px;background:rgba(255,255,255,0.12);margin:0 4px"></span>${catChips}
            </div>
            <div style="padding:6px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,0.06);background:#181b21">
                ${quickChips}<span style="width:1px;height:18px;background:rgba(255,255,255,0.12);margin:0 4px"></span>
                <span style="color:#888;font-size:10px;font-weight:600">PRIORITY:</span>${priChips}
                <input id="aim-issues-fleet-search" type="text" placeholder="Search notes / sites / people / history…" value="${escHtml(fleetSearch)}"
                    style="margin-left:auto;min-width:220px;flex:1;max-width:340px;padding:5px 10px;background:#0e1115;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:4px;font:inherit;font-size:12px;box-sizing:border-box">
            </div>
            ${fleetSelected.size ? `<div id="aim-issues-fleet-bulkbar" style="padding:6px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;border-bottom:1px solid rgba(122,223,230,0.35);background:#16262a">
                <span style="color:#7adfe6;font-weight:700;font-size:12px">☑ ${fleetSelected.size} selected</span>
                <button class="aim-fleet-bulk" data-op="all" title="Select every shown issue" style="padding:3px 8px;background:transparent;color:#aaa;border:1px solid #555;border-radius:4px;cursor:pointer;font:inherit;font-size:10px">all shown (${visibleAll.length})</button>
                <button class="aim-fleet-bulk" data-op="none" title="Clear the selection" style="padding:3px 8px;background:transparent;color:#aaa;border:1px solid #555;border-radius:4px;cursor:pointer;font:inherit;font-size:10px">clear</button>
                <span style="width:1px;height:18px;background:rgba(255,255,255,0.12);margin:0 4px"></span>
                ${(showingDeleted ? ['reinstate'] : ['approve', 'reject', 'resolve', 'ignore', 'reopen', 'priority', 'assign', 'comment', 'delete']).map(k => { const o = BULK_OPS[k]; return `<button class="aim-fleet-bulk" data-op="${k}" title="${escHtml(o.help)}" style="padding:4px 9px;background:${o.color};color:${o.fg};border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">${o.label}</button>`; }).join('')}
            </div>` : ''}
            <div style="display:flex;flex:1;min-height:0">
                <div id="aim-issues-fleet-rail" style="width:200px;flex-shrink:0;overflow:auto;border-right:1px solid rgba(255,255,255,0.08);background:#1a1d23">${railRows.join('')}</div>
                <div id="aim-issues-fleet-rows" style="flex:1;overflow:auto;min-width:0">${rowsHtml}</div>
            </div>
            <div style="padding:5px 14px;background:#14171b;border-top:1px solid rgba(255,255,255,0.06);color:#666;font-size:10px;font-style:italic;flex-shrink:0">
                Row: open issue · ☑ select for bulk · ✓ approve · ✗ reject · 💬 comment · ↗ open in site (new tab) · rail: click a site to solo · M2 chip: solo
            </div>
            <div id="aim-issues-fleet-resize" title="Drag to resize"
                 style="position:absolute;bottom:0;right:0;width:18px;height:18px;cursor:nwse-resize;
                        background:linear-gradient(135deg,transparent 0%,transparent 45%,rgba(122,223,230,0.55) 45%,rgba(122,223,230,0.55) 60%,transparent 60%,transparent 75%,rgba(122,223,230,0.55) 75%,rgba(122,223,230,0.55) 90%,transparent 90%);"></div>
        `;

        // ---- wiring ----
        const P = fleetPanelEl;
        P.querySelector('#aim-issues-fleet-close').onclick = closeFleetPanel;
        P.querySelector('#aim-issues-fleet-refresh').onclick = () => fleetLoad(true);
        const exportBtn = P.querySelector('#aim-issues-fleet-export');
        if (exportBtn && !exportBtn.disabled) {
            exportBtn.onclick = () => {
                const bySid = new Map(); visibleAll.forEach(v => bySid.set(v.issue.id, v.ctx));
                copyIssuesToSheets(visibleAll.map(v => v.issue), '', '', (issue) => {
                    const c = bySid.get(issue.id); return { sid: c ? String(c.sid) : '', name: c ? (c.name || '') : '' };
                });
            };
        }
        const search = P.querySelector('#aim-issues-fleet-search');
        if (search) {
            let t = null;
            search.oninput = () => { fleetSearch = search.value; fleetActiveViewKey = 'custom'; clearTimeout(t); t = setTimeout(() => { if (fleetPanelEl) renderFleetPanel(); }, 150); };
        }
        const summaryBtn = P.querySelector('#aim-issues-fleet-summary');
        if (summaryBtn) summaryBtn.onclick = () => { try { openFleetSummary(); } catch (e) { console.error(`${TAG} fleet summary threw:`, e); showToast('Summary failed — see console.', 3000); } };
        const viewSel = P.querySelector('#aim-issues-fleet-viewsel');
        if (viewSel) viewSel.onchange = () => {
            const v = viewSel.value;
            if (v.startsWith('b:')) { const bv = fleetBuiltinViews().find(x => x.key === v.slice(2)); if (bv) { fleetApplyView({ ...bv.view }); fleetActiveViewKey = bv.key; } }
            else if (v.startsWith('u:')) { const uv = fleetUserViews()[Number(v.slice(2))]; if (uv) { fleetApplyView(uv.view); fleetActiveViewKey = v; } }
            renderFleetPanel();
        };
        const viewSave = P.querySelector('#aim-issues-fleet-viewsave');
        if (viewSave) viewSave.onclick = () => {
            const name = (prompt('Name this view (the current chips + search are saved):', '') || '').trim();
            if (!name) return;
            const list = fleetUserViews().filter(v => v.name !== name);
            list.push({ name, view: fleetCurrentView() });
            fleetSaveUserViews(list);
            fleetActiveViewKey = 'u:' + (list.length - 1);
            showToast(`View "${name}" saved.`, 2500);
            renderFleetPanel();
        };
        const viewDel = P.querySelector('#aim-issues-fleet-viewdel');
        if (viewDel) viewDel.onclick = () => {
            const i = Number(fleetActiveViewKey.slice(2));
            const list = fleetUserViews(); const v = list[i];
            if (!v) return;
            if (!confirm(`Delete saved view "${v.name}"?`)) return;
            list.splice(i, 1); fleetSaveUserViews(list); fleetActiveViewKey = 'custom';
            renderFleetPanel();
        };
        const staleDays = P.querySelector('#aim-issues-fleet-staledays');
        if (staleDays) {
            staleDays.onclick = (e) => e.stopPropagation();
            staleDays.onchange = (e) => { e.stopPropagation(); const v = Number(staleDays.value); if (v > 0) fleetStaleDays = v; fleetActiveViewKey = 'custom'; renderFleetPanel(); };
        }
        // v1.42: selection + bulk bar
        P.querySelectorAll('.aim-fleet-sel').forEach(cb => {
            cb.onclick = (e) => { e.stopPropagation(); if (cb.checked) fleetSelected.add(cb.dataset.id); else fleetSelected.delete(cb.dataset.id); renderFleetPanel(); };
        });
        P.querySelectorAll('.aim-fleet-selsite').forEach(cb => {
            cb.onclick = (e) => {
                e.stopPropagation();
                const p = shown.find(x => String(x.ctx.sid) === cb.dataset.sid);
                if (!p) return;
                p.visible.forEach(i => { if (cb.checked) fleetSelected.add(i.id); else fleetSelected.delete(i.id); });
                renderFleetPanel();
            };
        });
        P.querySelectorAll('.aim-fleet-bulk').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                const op = b.dataset.op;
                if (op === 'all') { visibleAll.forEach(v => fleetSelected.add(v.issue.id)); renderFleetPanel(); return; }
                if (op === 'none') { fleetSelected.clear(); renderFleetPanel(); return; }
                openBulkModal(op);
            };
        });
        const wireChips = (cls, key, set, all) => {
            P.querySelectorAll(cls).forEach(c => {
                const v = c.dataset[key];
                c.onclick = () => { if (set.has(v)) set.delete(v); else set.add(v); fleetActiveViewKey = 'custom'; renderFleetPanel(); };
                c.oncontextmenu = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const solo = set.size === 1 && set.has(v);
                    set.clear();
                    if (solo) all.forEach(x => set.add(x)); else set.add(v);
                    fleetActiveViewKey = 'custom';
                    renderFleetPanel();
                };
            });
        };
        wireChips('.aim-fleet-chip', 'status', fleetFilters, PANEL_STATUS_ORDER);
        wireChips('.aim-fleet-catchip', 'category', fleetCategoryFilters, ['issue', 'unshielded']);
        wireChips('.aim-fleet-prichip', 'priority', fleetPriorityFilters, ['high', 'medium', 'low', 'none']);
        P.querySelectorAll('.aim-fleet-quick').forEach(c => {
            c.onclick = () => {
                const q = c.dataset.quick;
                if (q === 'review') fleetOnlyMyReview = !fleetOnlyMyReview;
                else if (q === 'mine') fleetOnlyMine = !fleetOnlyMine;
                else if (q === 'unseen') fleetOnlyUnseen = !fleetOnlyUnseen;
                else if (q === 'stale') fleetOnlyStale = !fleetOnlyStale;
                else if (q === 'deleted') { fleetShowDeleted = !fleetShowDeleted; fleetSelected.clear(); }
                fleetActiveViewKey = 'custom';
                // "Needs my review" implies the pending statuses are visible.
                if (q === 'review' && fleetOnlyMyReview) { fleetFilters.add('pending_fix'); fleetFilters.add('pending_ignore'); }
                renderFleetPanel();
            };
        });
        P.querySelectorAll('.aim-fleet-site').forEach(r => {
            r.onclick = () => {
                const sid = r.dataset.sid || null;
                fleetSoloSid = (sid && String(fleetSoloSid) !== String(sid)) ? sid : null;
                renderFleetPanel();
            };
        });
        P.querySelectorAll('.aim-fleet-group').forEach(g => {
            g.onclick = (e) => {
                if (e.target.closest('.aim-fleet-act, .aim-fleet-selsite')) return;
                const sid = g.dataset.sid;
                if (fleetCollapsedSites.has(sid)) fleetCollapsedSites.delete(sid); else fleetCollapsedSites.add(sid);
                renderFleetPanel();
            };
        });
        P.querySelectorAll('.aim-fleet-row').forEach(r => {
            r.onclick = (e) => {
                if (e.target.closest('.aim-fleet-act, .aim-fleet-sel')) return;
                const issue = resolveIssue(r.dataset.id);
                if (!issue) { showToast('Issue not found — refresh the fleet list.', 3000); return; }
                const ctx = ctxForIssue(issue.id);
                if (ctx && ctx.isSite) zoomToIssue(issue);
                openStatusModal(issue);
            };
        });
        P.querySelectorAll('.aim-fleet-act').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                const act = b.dataset.act;
                if (act === 'opensite') { openIssueInSite(b.dataset.sid, null); return; }
                const issue = resolveIssue(b.dataset.id);
                if (!issue) { showToast('Issue not found — refresh the fleet list.', 3000); return; }
                const ctx = ctxForIssue(issue.id);
                if (act === 'site') {
                    if (ctx && ctx.isSite) { zoomToIssue(issue); openStatusModal(issue); }
                    else openIssueInSite(b.dataset.sid, issue.id);
                } else if (act === 'approve') {
                    openStatusModal(issue, { arm: { to: issue.status === 'pending_fix' ? 'resolved' : 'ignored' } });
                } else if (act === 'reject') {
                    openStatusModal(issue, { arm: { to: 'open' } });
                } else if (act === 'comment') {
                    openStatusModal(issue, { arm: { kind: 'comment' } });
                }
            };
        });
        // drag + resize
        const header = P.querySelector('#aim-issues-fleet-header');
        const handle = P.querySelector('#aim-issues-fleet-resize');
        const startDrag = (downEvent, mode) => {
            fleetDragInFlight = true;
            const sx = downEvent.clientX, sy = downEvent.clientY;
            const s0 = { ...fleetLayout };
            const onMove = (ev) => {
                const dx = ev.clientX - sx, dy = ev.clientY - sy;
                const next = mode === 'move' ? { ...fleetLayout, left: s0.left + dx, top: s0.top + dy }
                                             : { ...fleetLayout, width: s0.width + dx, height: s0.height + dy };
                fleetLayout = clampFleetLayout(next);
                P.style.left = `${fleetLayout.left}px`; P.style.top = `${fleetLayout.top}px`;
                P.style.width = `${fleetLayout.width}px`; P.style.height = `${fleetLayout.height}px`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove, true);
                document.removeEventListener('mouseup', onUp, true);
                fleetDragInFlight = false;
                saveFleetLayout(fleetLayout);
                renderFleetPanel();
            };
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
        };
        if (header) header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button, input')) return;
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation(); startDrag(e, 'move');
        });
        if (handle) handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation(); startDrag(e, 'resize');
        });
        if (wasSearchFocused) {
            const s2 = P.querySelector('#aim-issues-fleet-search');
            if (s2) { s2.focus(); if (selS !== null) { try { s2.setSelectionRange(selS, selE); } catch (e) {} } }
        }
    }

    // ============================================================
    // v1.42 — FLEET ISSUES Phase 2: bulk actions · saved views · summary.
    // ============================================================

    // ---- Bulk batch: defer commits (one per site) + queue Slack posts ----
    // While `bulkBatch` is set, commitCtx() records the touched contexts
    // instead of PUTting, and fireSlack() queues the poster instead of
    // running it. runBulk() then commits each touched site ONCE, runs the
    // Slack queue sequentially (each post advances the watermark through
    // the same deferral), and flushes once more so the watermarks land.
    let bulkBatch = null;   // { touched: Map<sid, ctx>, slack: Fn[], reasons: string[] }
    function fireSlack(fn) {
        if (bulkBatch) { bulkBatch.slack.push(fn); return; }
        try { const r = fn(); if (r && r.catch) r.catch(e => console.warn(`${TAG} slack poster threw:`, e)); }
        catch (e) { console.warn(`${TAG} slack poster threw:`, e); }
    }
    async function flushBulkCommits(touchedMap, label) {
        const touched = Array.from(touchedMap.values());
        touchedMap.clear();
        let ok = 0; const failed = [];
        for (const ctx of touched) {
            try {
                // A commit already in flight for this site would make the
                // call return false (queued follow-up) — wait for it instead
                // of reporting a false failure. Capped at ~30 s.
                let waited = 0;
                while ((ctx.isSite ? pendingCommit : ctx.committing) && waited < 30000) {
                    await new Promise(r => setTimeout(r, 150)); waited += 150;
                }
                const res = ctx.isSite ? await commitIssuesToGitHub(label) : await commitFleetSite(ctx, label);
                if (res) ok++; else failed.push(String(ctx.name || ctx.sid));
            } catch (e) { failed.push(String(ctx.name || ctx.sid)); console.warn(`${TAG} bulk commit threw for site ${ctx.sid}:`, e); }
        }
        return { ok, failed };
    }

    // Which bulk ops exist, and how each applies to ONE issue. `plan(issue)`
    // returns { ok:true, transition? } or { ok:false, why }. Transitions are
    // resolved through STATUS_TRANSITIONS + the user's per-issue role, so a
    // bulk op can never do what the modal wouldn't allow.
    function bulkTransitionFor(issue, to) {
        if (issue.deleted) return { ok: false, why: 'deleted' };
        const st = issue.status || 'open';
        const t = (STATUS_TRANSITIONS[st] || []).find(x => x.to === to);
        if (!t) return { ok: false, why: `no ${(STATUS_LABEL[to] || { text: to }).text.toLowerCase()} path from ${(STATUS_LABEL[st] || { text: st }).text}` };
        if (t.roles && !t.roles.includes(roleFor(issue))) return { ok: false, why: `${t.label.replace(/^[^A-Za-z]+/, '')} needs an approver` };
        return { ok: true, transition: t };
    }
    const BULK_OPS = {
        approve:  { label: '✓ Approve', color: '#5fff5f', fg: '#06210f', help: 'Approve pending proposals (fix → resolved, ignore → ignored)',
                    plan: (i) => (i.status === 'pending_fix') ? bulkTransitionFor(i, 'resolved')
                              : (i.status === 'pending_ignore') ? bulkTransitionFor(i, 'ignored')
                              : { ok: false, why: 'not pending' } },
        reject:   { label: '✗ Reject', color: '#ff4d4d', fg: '#fff', help: 'Reject pending proposals → back to Open (note required)',
                    plan: (i) => (i.status === 'pending_fix' || i.status === 'pending_ignore') ? bulkTransitionFor(i, 'open') : { ok: false, why: 'not pending' } },
        resolve:  { label: '✓ Resolve / Propose fix', color: '#FFD700', fg: '#000', help: 'Approvers resolve directly; CSMs propose a fix (note required)',
                    plan: (i) => { const d = bulkTransitionFor(i, 'resolved'); return d.ok ? d : bulkTransitionFor(i, 'pending_fix'); } },
        ignore:   { label: '⊘ Ignore / Propose ignore', color: '#788cb4', fg: '#fff', help: 'Approvers ignore directly; CSMs propose ignore (note required)',
                    plan: (i) => { const d = bulkTransitionFor(i, 'ignored'); return d.ok ? d : bulkTransitionFor(i, 'pending_ignore'); } },
        reopen:   { label: '↺ Re-open', color: '#ff8585', fg: '#2a0d0d', help: 'Re-open resolved / ignored issues (note required)',
                    plan: (i) => (i.status === 'resolved' || i.status === 'ignored') ? bulkTransitionFor(i, 'open') : { ok: false, why: 'not resolved/ignored' } },
        priority: { label: '🎯 Priority', color: '#ffa726', fg: '#000', help: 'Set the same priority on every selected issue', needsPick: 'priority',
                    plan: (i, args) => i.deleted ? { ok: false, why: 'deleted' } : ((i.priority || null) === (args.priority || null)) ? { ok: false, why: 'already that priority' } : { ok: true } },
        assign:   { label: '👤 Assign', color: '#5fb3ff', fg: '#0a1a2a', help: 'Assign every selected issue to one person', needsPick: 'assignee',
                    plan: (i, args) => i.deleted ? { ok: false, why: 'deleted' } : ((i.assignee || null) === (args.assignee || null)) ? { ok: false, why: 'already assigned so' } : { ok: true } },
        comment:  { label: '💬 Comment', color: '#a8c4ff', fg: '#000', help: 'Post the same comment on every selected issue (note required)', noteRequired: true,
                    plan: (i) => i.deleted ? { ok: false, why: 'deleted' } : { ok: true } },
        delete:   { label: '🗑 Delete', color: '#5a2222', fg: '#ff8585', help: 'Tombstone (reinstatable by an approver)', danger: true,
                    plan: (i) => (i.deleted ? { ok: false, why: 'already deleted' }
                        : (isApproverFor(i) || (i.createdBy && i.createdBy === cachedUsername) || i.createdBy === 'local-only') ? { ok: true }
                        : { ok: false, why: `only @${i.createdBy} or an approver` }) },
        reinstate:{ label: '♻ Reinstate', color: '#5fff5f', fg: '#06210f', help: 'Restore deleted issues (approver only)',
                    plan: (i) => (!i.deleted ? { ok: false, why: 'not deleted' } : isApproverFor(i) ? { ok: true } : { ok: false, why: 'approver only' }) },
    };

    // Apply one bulk op to the selected ids. Sequential, same per-issue
    // functions the modal uses (history entry + role gates + Slack reply
    // per issue), one GitHub commit per site. Returns a summary.
    async function runBulk(opKey, ids, args, onProgress) {
        const op = BULK_OPS[opKey];
        if (!op) throw new Error(`unknown bulk op ${opKey}`);
        const note = (args.note || '').trim();
        const applied = [], skipped = [];
        bulkBatch = { touched: new Map(), slack: [], reasons: [] };
        try {
            let n = 0;
            for (const id of ids) {
                n++;
                if (onProgress) onProgress(n, ids.length);
                const issue = resolveIssue(id);
                if (!issue) { skipped.push({ id, why: 'not found (refresh?)' }); continue; }
                if (issue.deleted && opKey !== 'reinstate') { skipped.push({ id, why: 'deleted', issue }); continue; }
                const plan = op.plan(issue, args);
                if (!plan.ok) { skipped.push({ id, why: plan.why, issue }); continue; }
                let ok = false;
                try {
                    if (plan.transition) {
                        if (plan.transition.noteRequired && !note) { skipped.push({ id, why: 'note required', issue }); continue; }
                        ok = applyTransition(id, plan.transition, note);
                    } else if (opKey === 'priority') ok = applyPriorityChange(id, args.priority || null, note);
                    else if (opKey === 'assign') ok = applyAssignment(id, args.assignee || null);
                    else if (opKey === 'comment') ok = applyComment(id, note, args.notify || []);
                    else if (opKey === 'delete') { deleteIssue(id); ok = !!(resolveIssue(id) || {}).deleted || !resolveIssue(id); }
                    else if (opKey === 'reinstate') { reinstateIssue(id); ok = !(resolveIssue(id) || {}).deleted; }
                } catch (e) {
                    console.error(`${TAG} bulk ${opKey} threw on ${id}:`, e);
                    skipped.push({ id, why: `error: ${e.message || e}`, issue }); continue;
                }
                if (ok) applied.push({ id, issue }); else skipped.push({ id, why: 'refused by the action', issue });
                await new Promise(r => setTimeout(r, 0));   // keep the UI breathing
            }
            const label = `bulk ${opKey} by @${cachedUsername || 'local-only'} (${applied.length})`;
            const c1 = await flushBulkCommits(bulkBatch.touched, label);
            // Slack: sequential so thread order matches the action order. The
            // posters' watermark/thread commits are deferred into the batch.
            let slackErrors = 0;
            const slackQueue = bulkBatch.slack; bulkBatch.slack = [];
            for (const fn of slackQueue) {
                try { await fn(); } catch (e) { slackErrors++; console.warn(`${TAG} bulk slack post threw:`, e); }
            }
            // Final flush with the batch CLEARED first — anything that commits
            // while these PUTs are in flight (a click behind the progress card)
            // must go straight through, not into a map nobody flushes.
            const last = bulkBatch; bulkBatch = null;
            const c2 = await flushBulkCommits(last.touched, `${label} — slack watermarks`);
            return { applied, skipped, commits: c1.ok + c2.ok, commitFailed: c1.failed.concat(c2.failed), slackErrors };
        } finally {
            bulkBatch = null;
            fleetEmitSummary();
            if (fleetPanelEl) renderFleetPanel();
        }
    }

    // Bulk confirm/progress modal. Preflights every selected issue against the
    // op so the user sees exactly what will and won't happen before applying.
    let bulkModalEl = null;
    function closeBulkModal() { if (bulkModalEl) { try { bulkModalEl.remove(); } catch (e) {} } bulkModalEl = null; }
    function openBulkModal(opKey) {
        closeBulkModal();
        const op = BULK_OPS[opKey];
        if (!op) return;
        const ids = Array.from(fleetSelected).filter(id => resolveIssue(id));
        if (!ids.length) { showToast('Nothing selected.', 2500); return; }
        const args = { note: '', priority: 'high', assignee: cachedUsername || null, notify: [] };
        const card = document.createElement('div');
        card.id = 'aim-issues-bulk-modal';
        card.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:560px;max-width:94vw;max-height:84vh;
            background:#1f2228;border:1px solid ${op.color}88;border-radius:10px;color:#e6e6e6;z-index:99600;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.7);
            display:flex;flex-direction:column;overflow:hidden`;
        ['mousedown','pointerdown','wheel','dblclick','click','contextmenu','touchstart'].forEach(evt => card.addEventListener(evt, e => e.stopPropagation(), false));
        document.body.appendChild(card);
        bulkModalEl = card;
        let running = false;
        const render = () => {
            const plans = ids.map(id => { const issue = resolveIssue(id); const plan = issue ? op.plan(issue, args) : { ok: false, why: 'not found' }; return { id, issue, plan }; });
            const eligible = plans.filter(p => p.plan.ok);
            const skippedP = plans.filter(p => !p.plan.ok);
            const noteRequired = !!op.noteRequired || eligible.some(p => p.plan.transition && p.plan.transition.noteRequired);
            const bySite = new Map();
            eligible.forEach(p => { const c = ctxForIssue(p.id); const k = c ? (c.name || c.sid) : '?'; bySite.set(k, (bySite.get(k) || 0) + 1); });
            const roster = new Set(slackEnabled() ? Object.keys(slackConfig.users || {}) : []);
            if (cachedUsername) roster.add(cachedUsername);
            const pickHtml = op.needsPick === 'priority'
                ? `<div style="margin:10px 0 4px;color:#aaa;font-size:11px">Priority</div><div style="display:flex;gap:6px;flex-wrap:wrap">${['high','medium','low',null].map(p => { const m = p ? priorityMeta(p) : { text: 'None', color: '#888', textColor: '#fff' }; const on = (args.priority || null) === p; return `<button class="aim-bulk-pick" data-priority="${p || ''}" style="padding:4px 10px;border-radius:14px;border:1.5px solid ${m.color};background:${on ? m.color : 'transparent'};color:${on ? m.textColor : m.color};cursor:pointer;font:inherit;font-size:11px;font-weight:700">${m.text}</button>`; }).join('')}</div>`
                : op.needsPick === 'assignee'
                ? `<div style="margin:10px 0 4px;color:#aaa;font-size:11px">Assignee</div><div style="display:flex;gap:5px;flex-wrap:wrap">${Array.from(roster).sort().map(u => { const on = args.assignee === u; return `<button class="aim-bulk-pick" data-assignee="${escHtml(u)}" style="padding:4px 9px;border-radius:12px;border:1.5px solid #5fb3ff;background:${on ? '#5fb3ff' : 'transparent'};color:${on ? '#0a1a2a' : '#5fb3ff'};cursor:pointer;font:inherit;font-size:10px;font-weight:700">${u === cachedUsername ? '⭐ ' : ''}@${escHtml(u)}</button>`; }).join('')}<button class="aim-bulk-pick" data-assignee="" style="padding:4px 9px;border-radius:12px;border:1.5px solid #777;background:${args.assignee ? 'transparent' : '#555'};color:${args.assignee ? '#888' : '#fff'};cursor:pointer;font:inherit;font-size:10px;font-weight:700">Unassign</button></div>`
                : '';
            const notifyHtml = (opKey === 'comment' && roster.size) ? `<div style="margin:8px 0 4px;color:#aaa;font-size:11px">Tag on Slack (optional)</div><div style="display:flex;gap:5px;flex-wrap:wrap">${Array.from(roster).sort().filter(u => u !== cachedUsername).map(u => { const on = args.notify.includes(u); return `<button class="aim-bulk-notify" data-login="${escHtml(u)}" style="padding:4px 9px;border-radius:12px;border:1.5px solid #5fb3ff;background:${on ? '#5fb3ff' : 'transparent'};color:${on ? '#0a1a2a' : '#5fb3ff'};cursor:pointer;font:inherit;font-size:10px;font-weight:700">@${escHtml(u)}</button>`; }).join('')}</div>` : '';
            const skippedHtml = skippedP.length ? `<details style="margin-top:8px"><summary style="color:#ffa030;cursor:pointer;font-size:11px">${skippedP.length} will be skipped</summary><div style="max-height:120px;overflow:auto;font-size:11px;color:#bbb;margin-top:4px">${skippedP.map(p => `<div>• ${escHtml((p.issue && p.issue.note || p.id).slice(0, 60))} — <span style="color:#ffa030">${escHtml(p.plan.why)}</span></div>`).join('')}</div></details>` : '';
            card.innerHTML = `
                <div style="padding:10px 14px;background:#14171b;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;gap:10px">
                    <span style="font-weight:700;color:${op.color === '#5a2222' ? '#ff8585' : op.color}">${op.label}</span>
                    <span style="color:#888;font-size:11px">· ${ids.length} selected</span>
                    <button id="aim-bulk-close" style="margin-left:auto;padding:3px 9px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px">✕</button>
                </div>
                <div id="aim-bulk-body" style="padding:12px 14px;overflow:auto;flex:1;min-height:0">
                    <div style="color:#bbb;font-size:12px">${escHtml(op.help)}.</div>
                    <div style="margin-top:8px;font-size:12px"><b style="color:#5fff5f">${eligible.length}</b> will be applied across <b>${bySite.size}</b> site${bySite.size === 1 ? '' : 's'}
                        <span style="color:#888;font-size:11px">(${Array.from(bySite.entries()).map(([k, v]) => `${escHtml(String(k))} ${v}`).join(' · ')})</span></div>
                    ${skippedHtml}
                    ${pickHtml}
                    ${notifyHtml}
                    ${(opKey === 'delete' || opKey === 'reinstate' || opKey === 'assign') ? '' : `
                    <div style="margin:10px 0 4px;color:#aaa;font-size:11px">Note ${noteRequired ? '<span style="color:#ff8585">(required)</span>' : '<span style="color:#888">(optional)</span>'} — the same note goes on every issue</div>
                    <textarea id="aim-bulk-note" style="width:100%;min-height:64px;background:#0e1115;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:6px 8px;font:inherit;font-size:12px;resize:vertical;box-sizing:border-box">${escHtml(args.note)}</textarea>`}
                    <div id="aim-bulk-err" style="color:#ff8585;font-size:11px;min-height:14px;margin-top:4px"></div>
                    <div style="color:#666;font-size:10px;font-style:italic;margin-top:6px">Each issue gets its own history entry and Slack reply; each site gets one GitHub commit.</div>
                </div>
                <div style="padding:10px 14px;background:#14171b;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:8px;justify-content:flex-end">
                    <button id="aim-bulk-cancel" style="padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit">Cancel</button>
                    <button id="aim-bulk-go" ${eligible.length ? '' : 'disabled'} style="padding:7px 14px;background:${op.color};color:${op.fg};border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700;opacity:${eligible.length ? 1 : 0.4}">${op.danger ? '⚠ ' : ''}Apply to ${eligible.length}</button>
                </div>`;
            card.querySelector('#aim-bulk-close').onclick = closeBulkModal;
            card.querySelector('#aim-bulk-cancel').onclick = closeBulkModal;
            const noteEl = card.querySelector('#aim-bulk-note');
            if (noteEl) noteEl.oninput = () => { args.note = noteEl.value; };
            card.querySelectorAll('.aim-bulk-pick').forEach(b => b.onclick = () => {
                if (b.dataset.priority !== undefined) args.priority = b.dataset.priority || null;
                if (b.dataset.assignee !== undefined) args.assignee = b.dataset.assignee || null;
                render();
            });
            card.querySelectorAll('.aim-bulk-notify').forEach(b => b.onclick = () => {
                const l = b.dataset.login; const i = args.notify.indexOf(l);
                if (i >= 0) args.notify.splice(i, 1); else args.notify.push(l);
                render();
            });
            const go = card.querySelector('#aim-bulk-go');
            if (go && !go.disabled) go.onclick = async () => {
                if (running) return;
                if (noteRequired && !(args.note || '').trim()) { card.querySelector('#aim-bulk-err').textContent = 'A note is required for this action.'; if (noteEl) noteEl.focus(); return; }
                if (op.danger && go.dataset.armed !== '1') { go.dataset.armed = '1'; go.textContent = `⚠ Click again to ${op.label.replace(/^[^A-Za-z]+/, '').toLowerCase()} ${eligible.length}`; setTimeout(() => { if (go.dataset.armed === '1') { go.dataset.armed = '0'; go.textContent = `⚠ Apply to ${eligible.length}`; } }, 5000); return; }
                running = true;
                const body = card.querySelector('#aim-bulk-body');
                const foot = go.parentElement;
                foot.innerHTML = '';
                body.innerHTML = `<div style="padding:20px;text-align:center;color:#a8c4ff">⏳ Applying… <span id="aim-bulk-prog">0/${eligible.length}</span></div>`;
                const eligibleIds = eligible.map(p => p.id);
                let res;
                try {
                    res = await runBulk(opKey, eligibleIds, args, (n, t) => { const p = card.querySelector('#aim-bulk-prog'); if (p) p.textContent = `${n}/${t}`; });
                } catch (e) {
                    console.error(`${TAG} runBulk threw:`, e);
                    body.innerHTML = `<div style="padding:20px;color:#ff8585">⚠ Bulk action failed: ${escHtml(String(e.message || e))}. Check the console; refresh the fleet list to see what landed.</div>`;
                    foot.innerHTML = '<button id="aim-bulk-done" style="padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit">Close</button>';
                    card.querySelector('#aim-bulk-done').onclick = closeBulkModal;
                    return;
                }
                eligibleIds.forEach(id => fleetSelected.delete(id));
                const skippedRows = res.skipped.map(s => `<div>• ${escHtml(((s.issue && s.issue.note) || s.id).slice(0, 60))} — <span style="color:#ffa030">${escHtml(s.why)}</span></div>`).join('');
                body.innerHTML = `
                    <div style="font-size:13px"><b style="color:#5fff5f">${res.applied.length}</b> applied · <b style="color:${res.skipped.length ? '#ffa030' : '#888'}">${res.skipped.length}</b> skipped · <b>${res.commits}</b> site commit${res.commits === 1 ? '' : 's'}${res.slackErrors ? ` · <span style="color:#ff8585">${res.slackErrors} Slack post(s) failed</span>` : ''}</div>
                    ${res.commitFailed.length ? `<div style="color:#ff8585;font-size:12px;margin-top:6px">⚠ Commit FAILED for: ${escHtml(res.commitFailed.join(', '))} — the edits are held locally; use ↻ Refresh then retry.</div>` : ''}
                    ${skippedRows ? `<div style="margin-top:8px;font-size:11px;color:#bbb">${skippedRows}</div>` : ''}`;
                foot.innerHTML = '<button id="aim-bulk-done" style="padding:7px 14px;background:#5fff5f;color:#06210f;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:700">Done</button>';
                card.querySelector('#aim-bulk-done').onclick = closeBulkModal;
                if (fleetPanelEl) renderFleetPanel();
            };
        };
        render();
        setTimeout(() => { const n = card.querySelector('#aim-bulk-note'); if (n) n.focus(); }, 30);
    }

    // ---- Saved views ----
    const FLEET_VIEWS_KEY = 'aim-issues-fleet-views';
    function fleetCurrentView() {
        return {
            statuses: Array.from(fleetFilters), priorities: Array.from(fleetPriorityFilters), categories: Array.from(fleetCategoryFilters),
            myReview: fleetOnlyMyReview, mine: fleetOnlyMine, unseen: fleetOnlyUnseen, stale: fleetOnlyStale, staleDays: fleetStaleDays,
            deleted: fleetShowDeleted, search: fleetSearch,
        };
    }
    function fleetApplyView(v) {
        if (!v) return;
        if (!!v.deleted !== fleetShowDeleted) fleetSelected.clear();   // live vs tombstone selections never mix
        fleetFilters = new Set(Array.isArray(v.statuses) && v.statuses.length ? v.statuses : FLEET_ATTENTION_STATUSES);
        fleetPriorityFilters = new Set(Array.isArray(v.priorities) && v.priorities.length ? v.priorities : ['high', 'medium', 'low', 'none']);
        fleetCategoryFilters = new Set(Array.isArray(v.categories) && v.categories.length ? v.categories : ['issue', 'unshielded']);
        fleetOnlyMyReview = !!v.myReview; fleetOnlyMine = !!v.mine; fleetOnlyUnseen = !!v.unseen;
        fleetOnlyStale = !!v.stale; if (Number.isFinite(Number(v.staleDays)) && Number(v.staleDays) > 0) fleetStaleDays = Number(v.staleDays);
        fleetShowDeleted = !!v.deleted; fleetSearch = String(v.search || '');
    }
    // Function, not a const: PANEL_STATUS_ORDER is declared further down the
    // IIFE and a top-level const here would hit its TDZ at load.
    function fleetBuiltinViews() { return [
        { key: 'attention', name: 'Needs attention', view: { statuses: FLEET_ATTENTION_STATUSES } },
        { key: 'review',    name: '⚡ Pending my review', view: { statuses: ['pending_fix', 'pending_ignore'], myReview: true } },
        { key: 'mine',      name: '👤 My queue', view: { statuses: FLEET_ATTENTION_STATUSES, mine: true } },
        { key: 'stale',     name: '⏳ Stale ≥ 14 d', view: { statuses: FLEET_ATTENTION_STATUSES, stale: true, staleDays: 14 } },
        { key: 'high',      name: '🎯 High priority', view: { statuses: FLEET_ATTENTION_STATUSES, priorities: ['high'] } },
        { key: 'unseen',    name: '? Unseen activity', view: { statuses: PANEL_STATUS_ORDER, unseen: true } },
        { key: 'all',       name: 'All statuses', view: { statuses: PANEL_STATUS_ORDER } },
    ]; }
    function fleetUserViews() {
        try { const raw = gmGet(FLEET_VIEWS_KEY, ''); const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; }
        catch (e) { console.warn(`${TAG} saved views unreadable:`, e); return []; }
    }
    function fleetSaveUserViews(list) { try { gmSet(FLEET_VIEWS_KEY, JSON.stringify(list)); } catch (e) { console.warn(`${TAG} saved views write failed:`, e); } }
    let fleetActiveViewKey = 'attention';

    // ---- 📊 Fleet issues summary ----
    function fleetSummaryStats() {
        const now = Date.now();
        const day = 86400000;
        const contexts = fleetContexts();
        const sites = [];
        const people = new Map();   // login → { created, assigned, resolved }
        let allLive = [];
        const bucket = { '<7d': 0, '7–30d': 0, '30–90d': 0, '>90d': 0 };
        const pendingByCat = { issue: 0, unshielded: 0 };
        let resolvedWeek = 0, resolvedMonth = 0;
        const ttr90 = [], ttrAll = [];
        contexts.forEach(ctx => {
            const live = liveIssues(ctx.issues).filter(i => i.source !== 'validator');
            allLive = allLive.concat(live);
            const row = { sid: String(ctx.sid), name: ctx.name || ('site ' + ctx.sid), open: 0, pending: 0, resolved: 0, ignored: 0, total: live.length, oldestOpenDays: 0, unseen: 0, high: 0 };
            live.forEach(i => {
                const st = i.status || 'open';
                if (st === 'open' || st === 'ready-for-review') row.open++;
                else if (st === 'pending_fix' || st === 'pending_ignore') { row.pending++; pendingByCat[issueCategory(i)]++; }
                else if (st === 'resolved') row.resolved++;
                else if (st === 'ignored') row.ignored++;
                if (i.priority === 'high' && (st === 'open' || st.startsWith('pending'))) row.high++;
                if (unseenHistoryFor(i).length) row.unseen++;
                const ageDays = (now - new Date(i.createdAt).getTime()) / day;
                if (st === 'open' || st === 'ready-for-review' || st.startsWith('pending')) {
                    row.oldestOpenDays = Math.max(row.oldestOpenDays, Math.floor(ageDays));
                    if (ageDays < 7) bucket['<7d']++; else if (ageDays < 30) bucket['7–30d']++; else if (ageDays < 90) bucket['30–90d']++; else bucket['>90d']++;
                }
                const by = i.createdBy || '?';
                const pc = people.get(by) || { created: 0, assigned: 0, resolved: 0 }; pc.created++; people.set(by, pc);
                if (i.assignee && (st === 'open' || st.startsWith('pending'))) { const pa = people.get(i.assignee) || { created: 0, assigned: 0, resolved: 0 }; pa.assigned++; people.set(i.assignee, pa); }
                // First terminal transition = time-to-resolve.
                const h = i.history || [];
                const term = h.find(e => e && e.fromStatus && e.fromStatus !== e.toStatus && (e.toStatus === 'resolved' || e.toStatus === 'ignored') && !e.kind);
                if (term) {
                    const tAt = new Date(term.at).getTime();
                    const ttr = (tAt - new Date(i.createdAt).getTime()) / day;
                    if (Number.isFinite(ttr) && ttr >= 0) { ttrAll.push(ttr); if (now - tAt < 90 * day) ttr90.push(ttr); }
                    const pr = people.get(term.by || '?') || { created: 0, assigned: 0, resolved: 0 }; pr.resolved++; people.set(term.by || '?', pr);
                }
                h.forEach(e => {
                    if (!e || e.kind || !e.fromStatus || e.fromStatus === e.toStatus) return;
                    if (e.toStatus !== 'resolved' && e.toStatus !== 'ignored') return;
                    const t = new Date(e.at).getTime();
                    if (now - t < 7 * day) resolvedWeek++;
                    if (now - t < 30 * day) resolvedMonth++;
                });
            });
            sites.push(row);
        });
        sites.sort((a, b) => (b.open + b.pending) - (a.open + a.pending) || b.total - a.total || a.name.localeCompare(b.name));
        const median = (arr) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
        const totals = sites.reduce((t, r) => ({ open: t.open + r.open, pending: t.pending + r.pending, resolved: t.resolved + r.resolved, ignored: t.ignored + r.ignored, total: t.total + r.total, high: t.high + r.high, unseen: t.unseen + r.unseen }), { open: 0, pending: 0, resolved: 0, ignored: 0, total: 0, high: 0, unseen: 0 });
        const approversFor = { issue: approversList.slice(), unshielded: approversList.concat(categoryApprovers.unshielded || []) };
        return { sites, totals, bucket, pendingByCat, approversFor, resolvedWeek, resolvedMonth, medianTtr90: median(ttr90), medianTtrAll: median(ttrAll), nTtr90: ttr90.length, nTtrAll: ttrAll.length,
                 people: Array.from(people.entries()).map(([login, c]) => ({ login, ...c })).sort((a, b) => (b.assigned + b.created) - (a.assigned + a.created)), hiddenNoAccess: fleetHiddenNoAccess, at: new Date() };
    }
    function fleetSummaryText(S) {
        const d1 = (v) => v == null ? '—' : (v < 1 ? `${Math.round(v * 24)} h` : `${v.toFixed(1)} d`);
        const L = [];
        L.push(`AIM Fleet Issues summary — ${S.at.toLocaleString()} (${location.hostname})`);
        L.push(`Sites: ${S.sites.length}${S.hiddenNoAccess ? ` (+${S.hiddenNoAccess} hidden, no access)` : ''} · live issues: ${S.totals.total} · OPEN ${S.totals.open} · PENDING ${S.totals.pending} · resolved ${S.totals.resolved} · ignored ${S.totals.ignored} · high-priority open ${S.totals.high}`);
        L.push(`Resolved/ignored: last 7 d ${S.resolvedWeek} · last 30 d ${S.resolvedMonth} · median time-to-resolve: ${d1(S.medianTtr90)} (last 90 d, n=${S.nTtr90}) / ${d1(S.medianTtrAll)} (all, n=${S.nTtrAll})`);
        L.push(`Open+pending age: <7 d ${S.bucket['<7d']} · 7–30 d ${S.bucket['7–30d']} · 30–90 d ${S.bucket['30–90d']} · >90 d ${S.bucket['>90d']}`);
        L.push(`Pending review: issues ${S.pendingByCat.issue} (approvers: ${S.approversFor.issue.join(', ') || '—'}) · unshielded ${S.pendingByCat.unshielded} (approvers: ${S.approversFor.unshielded.join(', ') || '—'})`);
        L.push('');
        L.push('Site | Open | Pending | Resolved | Ignored | Total | Oldest open | High | Unseen');
        S.sites.forEach(r => L.push(`${r.name} (#${r.sid}) | ${r.open} | ${r.pending} | ${r.resolved} | ${r.ignored} | ${r.total} | ${r.oldestOpenDays ? r.oldestOpenDays + ' d' : '—'} | ${r.high} | ${r.unseen}`));
        L.push('');
        L.push('People (created / assigned-open / resolved):');
        S.people.slice(0, 20).forEach(p => L.push(`  @${p.login}: ${p.created} / ${p.assigned} / ${p.resolved}`));
        return L.join('\n');
    }
    function fleetSummaryHtml(S) {
        const td = (v, extra) => `<td style="padding:5px 8px;border:1px solid #444;vertical-align:top;${extra || ''}">${v}</td>`;
        const th = (v) => `<th style="background:#14171b;color:#fff;padding:6px 8px;border:1px solid #444;text-align:left">${v}</th>`;
        const d1 = (v) => v == null ? '—' : (v < 1 ? `${Math.round(v * 24)} h` : `${v.toFixed(1)} d`);
        const out = [];
        out.push(`<p><b>AIM Fleet Issues summary</b> — ${escHtml(S.at.toLocaleString())}</p>`);
        out.push('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><tr>' + ['Live', 'Open', 'Pending', 'Resolved', 'Ignored', 'High open', 'Resolved 7 d', 'Resolved 30 d', 'Median TTR 90 d', 'Median TTR all', '<7 d', '7–30 d', '30–90 d', '>90 d'].map(th).join('') + '</tr><tr>'
            + [S.totals.total, S.totals.open, S.totals.pending, S.totals.resolved, S.totals.ignored, S.totals.high, S.resolvedWeek, S.resolvedMonth, d1(S.medianTtr90), d1(S.medianTtrAll), S.bucket['<7d'], S.bucket['7–30d'], S.bucket['30–90d'], S.bucket['>90d']].map(v => td(escHtml(String(v)))).join('') + '</tr></table><br>');
        out.push('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><tr>' + ['Site', 'Site ID', 'Open', 'Pending', 'Resolved', 'Ignored', 'Total', 'Oldest open (d)', 'High open', 'Unseen'].map(th).join('') + '</tr>');
        S.sites.forEach(r => {
            const url = `${location.origin}/#/site/${encodeURIComponent(r.sid)}/control-panel/site-setup`;
            out.push('<tr>' + td(`<a href="${url}" style="color:#1a73e8">${escHtml(r.name)}</a>`) + td(escHtml(r.sid)) + td(r.open, r.open ? 'background:#ff4d4d;color:#fff;font-weight:bold' : '') + td(r.pending, r.pending ? 'background:#8000FF;color:#fff;font-weight:bold' : '') + td(r.resolved) + td(r.ignored) + td(r.total) + td(r.oldestOpenDays || '') + td(r.high) + td(r.unseen) + '</tr>');
        });
        out.push('<tr>' + td('<b>Fleet</b>') + td('') + td(`<b>${S.totals.open}</b>`) + td(`<b>${S.totals.pending}</b>`) + td(`<b>${S.totals.resolved}</b>`) + td(`<b>${S.totals.ignored}</b>`) + td(`<b>${S.totals.total}</b>`) + td('') + td(`<b>${S.totals.high}</b>`) + td(`<b>${S.totals.unseen}</b>`) + '</tr></table><br>');
        out.push('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><tr>' + ['Person', 'Created', 'Assigned (open)', 'Resolved'].map(th).join('') + '</tr>' + S.people.map(p => '<tr>' + td('@' + escHtml(p.login)) + td(p.created) + td(p.assigned) + td(p.resolved) + '</tr>').join('') + '</table>');
        return out.join('');
    }
    let fleetSummaryEl = null;
    let fleetSummaryKeyH = null;
    function closeFleetSummary() {
        if (fleetSummaryEl) { try { fleetSummaryEl.remove(); } catch (e) {} }
        fleetSummaryEl = null;
        if (fleetSummaryKeyH) { try { document.removeEventListener('keydown', fleetSummaryKeyH, true); } catch (e) {} fleetSummaryKeyH = null; }
    }
    function openFleetSummary() {
        closeFleetSummary();
        const S = fleetSummaryStats();
        const d1 = (v) => v == null ? '—' : (v < 1 ? `${Math.round(v * 24)} h` : `${v.toFixed(1)} d`);
        const card = document.createElement('div');
        card.id = 'aim-issues-fleet-summary';
        card.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:860px;max-width:95vw;max-height:88vh;
            background:#1f2228;border:1px solid rgba(122,223,230,0.55);border-radius:10px;color:#e6e6e6;z-index:99550;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.7);display:flex;flex-direction:column;overflow:hidden`;
        ['mousedown','pointerdown','wheel','dblclick','click','contextmenu','touchstart'].forEach(evt => card.addEventListener(evt, e => e.stopPropagation(), false));
        const stat = (label, v, color) => `<div style="background:#14171b;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 10px;min-width:96px"><div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">${label}</div><div style="color:${color || '#e6e6e6'};font-size:20px;font-weight:700">${v}</div></div>`;
        const bar = (label, n, total, color) => `<div style="display:flex;align-items:center;gap:8px;font-size:11px;margin:2px 0"><span style="width:60px;color:#aaa">${label}</span><div style="flex:1;height:10px;background:#0e1115;border-radius:5px;overflow:hidden"><div style="width:${total ? Math.round(100 * n / total) : 0}%;height:100%;background:${color}"></div></div><span style="width:30px;text-align:right;font-weight:700">${n}</span></div>`;
        const openPending = S.totals.open + S.totals.pending;
        card.innerHTML = `
            <div style="padding:10px 14px;background:#14171b;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;gap:10px">
                <span style="font-size:16px">📊</span><span style="font-weight:700;color:#7adfe6">Fleet Issues summary</span>
                <span style="color:#888;font-size:11px">· ${S.sites.length} site${S.sites.length === 1 ? '' : 's'}${S.hiddenNoAccess ? ` · ${S.hiddenNoAccess} hidden (no access)` : ''} · ${escHtml(S.at.toLocaleString())}</span>
                <span style="margin-left:auto;display:flex;gap:6px">
                    <button id="aim-fsum-sheets" style="padding:4px 10px;background:#3a3f48;color:#ffd54f;border:1px solid rgba(255,213,79,0.4);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">📊 Copy → Sheets</button>
                    <button id="aim-fsum-text" style="padding:4px 10px;background:#3a3f48;color:#a8c4ff;border:1px solid rgba(168,196,255,0.3);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">📋 Copy text</button>
                    <button id="aim-fsum-close" style="padding:4px 10px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px">✕</button>
                </span>
            </div>
            <div style="padding:12px 14px;overflow:auto;flex:1;min-height:0">
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    ${stat('Open', S.totals.open, '#ff4d4d')}${stat('Pending', S.totals.pending, '#b478ff')}${stat('High open', S.totals.high, '#ffa726')}${stat('Unseen', S.totals.unseen, '#00FF7F')}
                    ${stat('Resolved 7 d', S.resolvedWeek, '#5fff5f')}${stat('Resolved 30 d', S.resolvedMonth, '#5fff5f')}${stat('Median TTR 90 d', d1(S.medianTtr90), '#7adfe6')}${stat('Median TTR all', d1(S.medianTtrAll), '#7adfe6')}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:12px">
                    <div style="background:#14171b;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 10px">
                        <div style="color:#7adfe6;font-weight:700;font-size:11px;margin-bottom:4px">OPEN + PENDING BY AGE (${openPending})</div>
                        ${bar('< 7 d', S.bucket['<7d'], openPending, '#5fff5f')}${bar('7–30 d', S.bucket['7–30d'], openPending, '#ffd54f')}${bar('30–90 d', S.bucket['30–90d'], openPending, '#ffa726')}${bar('> 90 d', S.bucket['>90d'], openPending, '#ff4d4d')}
                    </div>
                    <div style="background:#14171b;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 10px">
                        <div style="color:#7adfe6;font-weight:700;font-size:11px;margin-bottom:4px">PENDING REVIEW QUEUE</div>
                        <div style="font-size:11px">🚩 Issues: <b>${S.pendingByCat.issue}</b> <span style="color:#888">→ ${S.approversFor.issue.map(a => '@' + escHtml(a)).join(', ') || '—'}</span></div>
                        <div style="font-size:11px;margin-top:3px">🛡✕ Unshielded: <b>${S.pendingByCat.unshielded}</b> <span style="color:#888">→ ${S.approversFor.unshielded.map(a => '@' + escHtml(a)).join(', ') || '—'}</span></div>
                        <div style="color:#7adfe6;font-weight:700;font-size:11px;margin:8px 0 4px">PEOPLE <span style="color:#888;font-weight:400">created · assigned open · resolved</span></div>
                        ${S.people.slice(0, 8).map(p => `<div style="font-size:11px">@${escHtml(p.login)}: ${p.created} · <span style="color:#5fb3ff">${p.assigned}</span> · <span style="color:#5fff5f">${p.resolved}</span></div>`).join('') || '<div style="color:#888;font-size:11px">—</div>'}
                    </div>
                </div>
                <div style="margin-top:12px;overflow:auto">
                    <table style="width:100%;border-collapse:collapse;font-size:11px">
                        <tr style="color:#888;text-align:left"><th style="padding:4px 6px">Site</th><th style="padding:4px 6px">Open</th><th style="padding:4px 6px">Pending</th><th style="padding:4px 6px">Resolved</th><th style="padding:4px 6px">Ignored</th><th style="padding:4px 6px">Total</th><th style="padding:4px 6px">Oldest open</th><th style="padding:4px 6px">High</th><th style="padding:4px 6px">?</th></tr>
                        ${S.sites.map(r => `<tr class="aim-fsum-row" data-sid="${escHtml(r.sid)}" style="cursor:pointer;border-top:1px solid rgba(255,255,255,0.06)" title="Click to solo this site in the fleet panel">
                            <td style="padding:4px 6px;color:#7adfe6">${escHtml(r.name)} <span style="color:#666">#${escHtml(r.sid)}</span></td>
                            <td style="padding:4px 6px;font-weight:700;color:${r.open ? '#ff4d4d' : '#666'}">${r.open}</td>
                            <td style="padding:4px 6px;font-weight:700;color:${r.pending ? '#b478ff' : '#666'}">${r.pending}</td>
                            <td style="padding:4px 6px;color:#aaa">${r.resolved}</td><td style="padding:4px 6px;color:#aaa">${r.ignored}</td><td style="padding:4px 6px">${r.total}</td>
                            <td style="padding:4px 6px;color:${r.oldestOpenDays > 30 ? '#ffa726' : '#aaa'}">${r.oldestOpenDays ? r.oldestOpenDays + ' d' : '—'}</td>
                            <td style="padding:4px 6px;color:${r.high ? '#ffa726' : '#666'}">${r.high}</td><td style="padding:4px 6px;color:${r.unseen ? '#00FF7F' : '#666'}">${r.unseen}</td></tr>`).join('')}
                    </table>
                </div>
            </div>`;
        document.body.appendChild(card);
        fleetSummaryEl = card;
        card.querySelector('#aim-fsum-close').onclick = closeFleetSummary;
        card.querySelector('#aim-fsum-text').onclick = () => copyTextToClipboard(fleetSummaryText(S)).then(() => showToast('Summary copied as text.', 2500)).catch(() => showToast('Copy failed.', 2500));
        card.querySelector('#aim-fsum-sheets').onclick = async () => {
            const html = fleetSummaryHtml(S), text = fleetSummaryText(S);
            try {
                if (navigator.clipboard && window.ClipboardItem) {
                    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
                    showToast('Summary copied — paste into Google Sheets / Excel.', 3000); return;
                }
            } catch (e) { console.warn(`${TAG} summary clipboard write failed, falling back to text:`, e); }
            copyTextToClipboard(text).then(() => showToast('Copied as plain text (HTML clipboard unavailable).', 3000)).catch(() => showToast('Copy failed.', 2500));
        };
        card.querySelectorAll('.aim-fsum-row').forEach(r => r.onclick = () => { fleetSoloSid = r.dataset.sid; closeFleetSummary(); if (!fleetPanelEl) openFleetPanel(); else renderFleetPanel(); });
        fleetSummaryKeyH = (e) => { if (e.key === 'Escape' && fleetSummaryEl) { e.preventDefault(); closeFleetSummary(); } };
        document.addEventListener('keydown', fleetSummaryKeyH, true);
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
        // v1.31: category filter (normal issues vs unshielded routes).
        if (!panelCategoryFilters.has(issueCategory(issue))) return false;
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
        // v1.26: approver-only "Deleted" view. When toggled on, the row list is
        // built from tombstoned issues (excluding ephemeral validator ones)
        // instead of the live list; counts/chips below still reflect live.
        const deletedSiteIssues = currentSiteIssues.filter(i =>
            i && i.deleted && i.source !== 'validator');
        const showingDeleted = panelShowDeleted && isApprover();
        const baseList = showingDeleted ? deletedSiteIssues : liveSiteIssues;
        const issuesSorted = baseList
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
        // v1.00's flat pendingCount replaced in v1.31 by myPendingCount
        // (per-issue approval power) computed below with the shortcut chip.

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

        // v1.31: category chips — 🚩 Issues vs 🛡✕ Unshielded Routes. Same
        // M1 toggle / M2 solo semantics as the status chips.
        const catCounts = { issue: 0, unshielded: 0 };
        liveSiteIssues.forEach(i => { catCounts[issueCategory(i)]++; });
        const catChipsHtml = [
            { key: 'issue', label: '🚩 Issues', color: '#ff8585' },
            { key: 'unshielded', label: '🛡✕ Unshielded', color: CATEGORY_META.unshielded.color },
        ].map(c => {
            const active = panelCategoryFilters.has(c.key);
            return `<button class="aim-issues-panel-catchip" data-category="${c.key}"
                title="${active ? 'Click to hide' : 'Click to show'} ${c.key === 'unshielded' ? 'unshielded routes' : 'normal issues'} — M2 to solo"
                style="
                    padding:5px 10px;border-radius:14px;font:inherit;font-size:11px;font-weight:700;
                    border:1.5px solid ${c.color};
                    background:${active ? c.color : 'transparent'};
                    color:${active ? (c.key === 'unshielded' ? '#1a0d26' : '#2a0d0d') : c.color};
                    cursor:pointer;opacity:${active ? 1 : 0.55};
                    display:inline-flex;align-items:center;gap:6px">
                <span>${c.label}</span>
                <span style="background:rgba(0,0,0,0.25);padding:1px 5px;border-radius:8px;font-size:10px">${catCounts[c.key]}</span>
            </button>`;
        }).join('');

        // v1.00: "Pending my review" shortcut chip — approvers only.
        // M1 click: solo pending_fix + pending_ignore (hide everything else).
        // Always visible when role=approver, even if count is 0.
        // v1.31: shown to ANYONE with approval power (global or category);
        // the count only includes pendings THIS user can approve.
        const role = currentRole();
        const canReviewSomething = isAnyApprover();
        const myPendingCount = canReviewSomething
            ? liveSiteIssues.filter(i =>
                (i.status === 'pending_fix' || i.status === 'pending_ignore') && isApproverFor(i)).length
            : 0;
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
        const pendingShortcutHtml = canReviewSomething ? `
            <button id="aim-issues-panel-pending-shortcut"
                title="Solo pending issues (Pending Fix + Pending Ignore) — for your review"
                style="
                    padding:5px 10px;border-radius:14px;font:inherit;font-size:11px;font-weight:700;
                    border:1.5px dashed #5fff5f;
                    background:transparent;color:#5fff5f;
                    cursor:pointer;opacity:${myPendingCount > 0 ? 1 : 0.7};
                    display:inline-flex;align-items:center;gap:6px">
                <span>⚡ Pending my review</span>
                <span style="background:${myPendingCount > 0 ? '#ffa726' : 'rgba(0,0,0,0.25)'};
                             color:${myPendingCount > 0 ? '#000' : '#bbb'};
                             padding:1px 5px;border-radius:8px;font-size:10px">${myPendingCount}</span>
            </button>` : '';
        // v1.26: approver-only "Deleted" toggle chip. Switches the row list to
        // tombstoned issues (struck-through) so an approver can review + ♻
        // reinstate them. Hidden entirely for CSMs.
        const deletedCount = deletedSiteIssues.length;
        const deletedChipHtml = (role === 'approver') ? `
            <button id="aim-issues-panel-deleted-toggle"
                title="${showingDeleted ? 'Back to active issues' : 'Show deleted (tombstoned) issues — click one to reinstate'}"
                style="
                    padding:5px 10px;border-radius:14px;font:inherit;font-size:11px;font-weight:700;
                    border:1.5px dashed #ff8585;
                    background:${showingDeleted ? '#ff8585' : 'transparent'};
                    color:${showingDeleted ? '#2a0d0d' : '#ff8585'};
                    cursor:pointer;opacity:${(deletedCount > 0 || showingDeleted) ? 1 : 0.7};
                    display:inline-flex;align-items:center;gap:6px">
                <span>🗑 Deleted</span>
                <span style="background:rgba(0,0,0,0.25);padding:1px 5px;border-radius:8px;font-size:10px">${deletedCount}</span>
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
        if (baseList.length === 0) {
            rowsHtml = `<div style="padding:30px 12px;color:#888;text-align:center;font-style:italic">
                ${showingDeleted
                    ? 'No deleted issues on this site.'
                    : 'No issues on this site yet. Toggle 🚩 → flag mode → click-drag to create one.'}
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
                // v1.31: unshielded-route chip under the status pill
                const catChip = isUnshielded(issue)
                    ? `<div style="margin-top:3px"><span style="display:inline-block;padding:1px 5px;border-radius:6px;background:${CATEGORY_META.unshielded.color};color:#1a0d26;font-size:9px;font-weight:700">🛡✕ UNSHLD</span></div>`
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
                        if (h.kind === 'assign') return h.toAssignee ? `@${by}: 👤 assigned → @${h.toAssignee}` : `@${by}: 👤 unassigned`;
                        if (h.kind === 'reshape') return `@${by}: ✏ reshaped the area`;
                        if (h.kind === 'markermove') return `@${by}: 📍 moved the map icon`;
                        if (h.kind === 'category') return (h.toCategory === 'unshielded') ? `@${by}: 🛡 marked Unshielded Route` : `@${by}: converted to normal issue`;
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
                        ${catChip}
                        ${priChip}
                        ${issue.deleted ? `<div style="font-size:9px;color:#ff8585;margin-top:2px;font-weight:700" title="Deleted by @${escHtml(issue.deletedBy || '?')}">🗑 DELETED</div>` : ''}
                        ${sessionHidden ? '<div style="font-size:9px;color:#5fff5f;margin-top:2px">HIDDEN</div>' : ''}
                    </div>
                    <div style="color:#a8c4ff;font-size:11px;font-weight:600">
                        ${escHtml(headerLabel)}${activityChip}
                        <div style="color:#888;font-weight:400;font-size:10px;margin-top:1px">${age}</div>
                    </div>
                    <div>
                        <div style="color:#e6e6e6;font-size:12px;line-height:1.35;
                                    ${issue.deleted ? 'text-decoration:line-through;color:#999;' : ''}
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
                <button id="aim-issues-panel-fleet" title="🌐 Fleet Issues — every site's issues in one panel (review, approve, comment without entering each site)"
                    style="margin-left:auto;padding:4px 10px;background:#1a3a40;color:#7adfe6;
                           border:1px solid rgba(122,223,230,0.5);border-radius:4px;cursor:pointer;font:inherit;font-size:11px;font-weight:700">
                    🌐 All sites
                </button>
                <button id="aim-issues-panel-close" title="Close panel"
                    style="padding:4px 10px;background:#3a3f48;color:#e6e6e6;
                           border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px">
                    ✕
                </button>
            </div>
            <div style="padding:10px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
                        border-bottom:1px solid rgba(255,255,255,0.06);background:#181b21">
                ${chipsHtml}
                ${catChipsHtml}
                ${pendingShortcutHtml}
                ${deletedChipHtml}
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
        const fleetBtn = panelEl.querySelector('#aim-issues-panel-fleet');   // v1.41
        if (fleetBtn) fleetBtn.onclick = () => openFleetPanel();

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
        const deletedToggle = panelEl.querySelector('#aim-issues-panel-deleted-toggle');
        if (deletedToggle) {
            deletedToggle.onclick = () => {
                panelShowDeleted = !panelShowDeleted;
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
        // v1.31: category chips — same M1 toggle / M2 solo semantics
        const ALL_CATEGORIES = ['issue', 'unshielded'];
        panelEl.querySelectorAll('.aim-issues-panel-catchip').forEach(chip => {
            chip.onclick = () => {
                const c = chip.dataset.category;
                if (panelCategoryFilters.has(c)) panelCategoryFilters.delete(c);
                else panelCategoryFilters.add(c);
                renderIssuesPanel();
            };
            chip.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const c = chip.dataset.category;
                const isCurrentlySolo = (panelCategoryFilters.size === 1 && panelCategoryFilters.has(c));
                panelCategoryFilters.clear();
                if (isCurrentlySolo) ALL_CATEGORIES.forEach(x => panelCategoryFilters.add(x));
                else panelCategoryFilters.add(c);
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
            // v1.41: siteID isn't read until setCurrentSite below, so topDefers()
            // can't gate these yet — check the hash directly so TOP-inside-a-site
            // keeps deferring the config GETs to the iframe as before (seeding
            // siteID here would make setCurrentSite early-return).
            const topInSite = IS_TOP && !!readSiteIdFromHash();
            if (!topInSite) {
                // Refresh username in the background — handles PAT rotation.
                fetchGithubUsername();
                // v1.00: refresh approver list in the background — handles
                // boss-just-added-me scenario without requiring a script reload.
                fetchApproversList();
                // v1.03: same for the Slack notification config.
                fetchSlackConfig();
            }
        } else {
            syncStatus = 'no-token';
        }
        // v1.39: stale-issue bump timers REMOVED (channel policy 2026-08-27 —
        // Slack only gets issue opened/updated/closed events, no weekly
        // re-pings). runStaleBumpCheck/runGlobalStaleSweep are kept in the file
        // but unscheduled; restore the v1.20/v1.22 timers here to re-enable.
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

        setupFleetBridge();   // v1.41: 'aim-fleet:*' DOM events (Fleet Tools front door)
        if (IS_TOP) {
            // TOP frame: no in-site UI here (the iframe owns it). v1.41: on the
            // LANDING page TOP is the only frame — it hosts the fleet issues
            // panel + status modal, so styles + a warm fleet load are needed.
            injectStyles();
            setCurrentSite(readSiteIdFromHash());
            attachHashListener();
            if (!siteID && cachedToken) setTimeout(() => fleetLoad(false), 1500);
            console.log(`${TAG} v${SCRIPT_VERSION} ready (TOP — ${siteID ? 'no UI in this frame' : 'landing page: fleet issues available'})`);
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
