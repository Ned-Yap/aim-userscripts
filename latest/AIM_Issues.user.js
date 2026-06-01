// ==UserScript==
// @name         Latest - AIM Issues
// @namespace    http://tampermonkey.net/
// @version      0.14
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Issues.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Issues.user.js
// @description  CSM-collaborative issue flagging. 🚩 button in .map-tools. M1 ⚡ flag mode → click-drag rectangle or Shift+click polygon → required note. Renders dashed red. M1 on issue = session-hide. M2 on issue = stub status modal (Phase 1 — full state machine arrives in Phase 3). Phase 1 LOCAL-ONLY (localStorage); Phase 2 swaps to GitHub.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.github.com
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
    const SCRIPT_VERSION = '0.14';
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
    const TOKEN_KEY = 'aim-github-token';          // shared with Map Styler
    const USERNAME_KEY = 'aim-issues-github-login'; // ours

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
    let currentSiteIssues = [];                  // Issue[] for current site
    const hiddenIds = new Set();                 // session-only — resets on reload

    // GitHub sync state (v0.5)
    let cachedToken = gmGet(TOKEN_KEY, '') || '';       // recovered after refresh; also via TOKEN_VALUE broadcast
    let cachedUsername = gmGet(USERNAME_KEY, '') || ''; // fetched once on first token, persisted
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
    const issueLayers = new Map();               // issueId → { polygon, marker }
    let drawingState = null;
    let drawToolbarEl = null;
    let noteModalEl = null;
    let statusModalEl = null;
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
        console.log(`${TAG} site changed → ${siteID} (${currentSiteIssues.length} local issue${currentSiteIssues.length === 1 ? '' : 's'})`);
        renderAllIssues();
        renderButtonState();
        // v0.5: if we have a token, pull authoritative data from GitHub.
        // refetchIssues merges remote + local by ID and pushes any local-only
        // additions back. No token → local-only fallback (Phase 1 behavior).
        if (siteID && cachedToken) refetchIssues();
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

    // Union by ID — pick whichever copy has the later history tail.
    function mergeIssueLists(localList, remoteList) {
        const byId = new Map();
        const stamp = (issue) => byId.set(issue.id, issue);
        (remoteList || []).forEach(stamp);
        (localList || []).forEach(l => {
            const r = byId.get(l.id);
            if (!r) { byId.set(l.id, l); return; }
            byId.set(l.id, lastHistAt(l) >= lastHistAt(r) ? l : r);
        });
        return Array.from(byId.values());
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
                const authoredCount = currentSiteIssues.filter(i => i.createdBy !== 'local-only').length;
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
            shaBySite[sid] = remote.sha;
            currentSiteIssues = merged;
            saveIssuesToStorage(sid, currentSiteIssues);
            renderAllIssues();
            renderButtonState();
            if (localOnlyCount > 0) {
                console.log(`${TAG} merged remote (${remote.issues.length}) with local (${beforeLocalCount}) → ${merged.length} total; ${localOnlyCount} local-only being pushed`);
                await commitIssuesToGitHub(`merge ${localOnlyCount} local-only issue${localOnlyCount === 1 ? '' : 's'}`);
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
            const issuesToSync = currentSiteIssues.filter(i => i.createdBy !== 'local-only');
            const payload = { version: 1, siteID: sid, issues: issuesToSync };
            const b64 = textToB64(JSON.stringify(payload, null, 2));
            const sha = shaBySite[sid];
            const reason = reasonOverride || `update (${issuesToSync.length} total)`;
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
            unhideAllNonResolved();
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
        const hiddenSuffix = hiddenCount > 0 ? ` · ${hiddenCount} hidden — M2 un-hides non-resolved` : '';
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
                : `Issues · M1 toggle flag mode · M2 un-hide all non-resolved${hiddenSuffix}${syncSuffix}`;

        // Badge: count for current site (top-right corner)
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
        // v0.5: createdBy is the GitHub login when authenticated; falls
        // back to 'local-only' when there's no PAT.
        const by = cachedUsername || 'local-only';
        const issue = {
            id,
            surface: 'site-setup',
            shape,
            polygon,
            note,
            status: 'open',
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
        const localCount = currentSiteIssues.length;
        if (cachedToken) {
            showToast(`Issue created — pushing to GitHub…`, 2500);
            commitIssuesToGitHub(`add issue by @${by}`);
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
        // Drop layers
        const map = getLeafletMap();
        const layers = issueLayers.get(id);
        if (layers && map) {
            try { if (layers.polygon) map.removeLayer(layers.polygon); } catch (e) {}
            try { if (layers.marker)  map.removeLayer(layers.marker);  } catch (e) {}
        }
        issueLayers.delete(id);
        hiddenIds.delete(id);
        currentSiteIssues = currentSiteIssues.filter(i => i.id !== id);
        saveIssuesToStorage(siteID, currentSiteIssues);
        renderButtonState();
        console.log(`${TAG} deleted issue ${id} by @${cachedUsername || 'local-only'}`);
        // v0.7: local-only issues never went to GitHub (see commitIssuesToGitHub
        // filter), so no commit is needed when one is deleted.
        const wasLocalOnly = (issue.createdBy === 'local-only');
        if (cachedToken && !wasLocalOnly) {
            showToast('Issue deleted — pushing to GitHub…', 2500);
            commitIssuesToGitHub(`delete issue by @${cachedUsername || 'local-only'}`);
        } else if (wasLocalOnly) {
            showToast('Local-only issue deleted (not synced to GitHub).', 3000);
        } else {
            showToast('Issue deleted locally (no GitHub token).', 3000);
        }
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
    const RENDER_MAX_RETRIES = 30;
    const RENDER_RETRY_MS = 500;

    function renderAllIssues() {
        if (renderRetryTimer) { clearTimeout(renderRetryTimer); renderRetryTimer = null; }
        renderAllIssuesAttempt(0);
    }

    function renderAllIssuesAttempt(attempt) {
        renderRetryTimer = null;
        clearIssueLayers();
        if (!masterEnabled) return;
        if (currentSiteIssues.length === 0) return;
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
        currentSiteIssues.forEach((issue) => {
            renderOneIssue(issue, { isHidden: isIssueDimmed(issue) });
        });
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

        const c = centroidOfLatLngs(issue.polygon);
        let marker = null;
        if (c) {
            const vMarker = Number(getT('render.visible-marker-size')) || 26;
            const hMarker = Number(getT('render.hidden-marker-size')) || 20;
            const markerOpacity = isHidden ? 0.45 : 1;
            const markerSize = isHidden ? hMarker : vMarker;
            const fontSize = Math.max(9, Math.round(markerSize * 0.55));
            const borderWidth = isHidden ? 1 : 2;
            // v0.11: data-issue-id lets other AIM scripts (notably Asset
            // Inspector with its window-capture contextmenu handler) detect
            // an issue icon and bail before they steal the click. Class
            // .aim-issues-icon-marker is also a selector for the same purpose.
            const divIcon = L.divIcon({
                className: 'aim-issues-icon-marker',
                html: `<div data-issue-id="${issue.id}" style="
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
        if (!last.fromStatus) {
            // Creation entry
            return (STATUS_LABEL[last.toStatus] || { text: (last.toStatus || 'open').toUpperCase() }).text;
        }
        // Transition — describe semantically
        const key = `${last.fromStatus}|${last.toStatus}`;
        const map = {
            'open|ready-for-review':    'Ready for Review',
            'open|ignored':             'Ignored',
            'ready-for-review|resolved': 'Resolved',
            'ready-for-review|open':    'Rejected',
            'resolved|open':            'Re-opened',
            'ignored|open':             'Un-ignored',
        };
        return map[key] || (STATUS_LABEL[last.toStatus] || { text: (last.toStatus || '').toUpperCase() }).text;
    }

    function lastEventAt(issue) {
        const hist = (issue && issue.history) || [];
        if (hist.length === 0) return issue.createdAt;
        return hist[hist.length - 1].at;
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
        return `
            <div style="line-height:1.35">
                <div style="font-weight:700;color:${headerColor};font-size:13px;margin-bottom:6px">${headerLabel} &middot; ${age}</div>
                <div style="color:#ffffff;font-size:13px;font-weight:600;margin-bottom:6px">${safeNote}</div>
                <div style="color:#a8c4ff;font-size:11px;font-weight:600">@${safeBy}</div>
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

    // ------- Phase 3: status state machine -------
    //
    // Per design doc (project_aim_issues_design.md):
    //
    //   [create]
    //     ↓                                                  (Ignored stays
    //   Open ──→ Ready-for-Review ──→ Resolved (terminal)     hidden by
    //     ↑      │                                            design)
    //     ├──────┘ (Rejected — note required)
    //     ↑
    //   Ignored ──→ Open (un-ignore — note required)
    //
    // Trust-based: anyone can do any transition. Audit log shows everything.
    // No `delete` transition — delete lives separately (creator-only).
    //
    // Each transition: target status, button label, whether note is required,
    // and a button color matching the destination's render color.
    // v0.13: notePrompt drives the textarea placeholder so the prompt
    // matches what we're asking the user about. Was a single generic line
    // before — confusing on transitions like Re-open.
    const STATUS_TRANSITIONS = {
        'open': [
            { to: 'ready-for-review', label: '→ Ready for Review', noteRequired: true,  color: '#ffd54f', textColor: '#000',
              notePrompt: 'What was fixed? e.g. "Added missing H-Well to Site Setup"' },
            { to: 'ignored',          label: '→ Ignore',            noteRequired: true,  color: '#788cb4', textColor: '#fff',
              notePrompt: 'Why are you ignoring this? e.g. "Not within our scope" or "Duplicate of #..."' },
        ],
        'ready-for-review': [
            { to: 'resolved', label: '→ Resolve',                noteRequired: false, color: '#5fff5f', textColor: '#000',
              notePrompt: 'Optional acceptance comment (e.g. "Verified, looks good")' },
            { to: 'open',     label: '↺ Reject (back to Open)',  noteRequired: true,  color: '#ff4d4d', textColor: '#fff',
              notePrompt: 'Why is this being rejected? What still needs to be done?' },
        ],
        // v0.12: resolved is no longer terminal. Trust-based — anyone can
        // re-open a resolved issue if something comes back. Note required
        // (why it's being re-opened) for the audit log.
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
        'open':              { text: 'OPEN',              color: '#ff4d4d' },
        'ready-for-review':  { text: 'READY FOR REVIEW',  color: '#ffd54f' },
        'resolved':          { text: 'RESOLVED',          color: '#888'    },
        'ignored':           { text: 'IGNORED',           color: '#788cb4' },
    };

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
        } else {
            showToast(`Status → ${targetLabel} (local only).`, 2500);
        }
        return true;
    }

    function escHtml(s) {
        return (s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
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
            border-radius:10px;padding:18px 22px;width:540px;max-width:94vw;
            color:#e6e6e6;box-shadow:0 8px 32px rgba(0,0,0,0.6);
        `;
        overlay.appendChild(card);

        // Local UI state — armed transition (null = pick a transition;
        // non-null = note prompt for that transition).
        let armed = null;
        let pendingNote = '';     // preserved across re-renders if user typed something

        function render() {
            // Re-resolve issue from current state in case it changed
            const liveIssue = currentSiteIssues.find(i => i.id === issue.id) || issue;
            const safeNote = escHtml(liveIssue.note);
            const status = liveIssue.status || 'open';
            const statusMeta = STATUS_LABEL[status] || { text: status.toUpperCase(), color: '#ff8585' };
            const transitions = STATUS_TRANSITIONS[status] || [];
            const histRows = (liveIssue.history || []).map(h => {
                const safeHistNote = escHtml(h.note);
                const safeBy = escHtml(h.by || '?');
                const trans = h.fromStatus
                    ? `${(STATUS_LABEL[h.fromStatus] || {text:h.fromStatus}).text} → ${(STATUS_LABEL[h.toStatus] || {text:h.toStatus}).text}`
                    : `created (${(STATUS_LABEL[h.toStatus] || {text:h.toStatus}).text})`;
                return `<div style="padding:6px 8px;border-bottom:1px dotted rgba(255,255,255,0.08);font-size:12px">
                    <div style="color:#a8c4ff;font-size:11px;font-weight:600">${fmtDateTime(h.at)} &middot; @${safeBy}</div>
                    <div style="color:#e6e6e6;margin-top:2px">${trans}</div>
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

            // Transitions section OR armed-note section
            let actionSectionHtml = '';
            if (armed) {
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
                        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:4px">
                            <button id="aim-issues-modal-cancel-transition"
                                style="padding:6px 12px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px">
                                Cancel
                            </button>
                            <button id="aim-issues-modal-confirm-transition"
                                style="padding:6px 12px;background:${armed.color};color:${armed.textColor};border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px;font-weight:700">
                                Confirm → ${tgtLabel}
                            </button>
                        </div>
                    </div>
                `;
            } else if (transitions.length === 0) {
                actionSectionHtml = `
                    <div style="margin-top:14px;color:#888;font-size:11px;font-style:italic">
                        Terminal status — no further transitions.
                    </div>
                `;
            } else {
                const btns = transitions.map((t, i) => `
                    <button data-tidx="${i}"
                        class="aim-issues-modal-transbtn"
                        style="padding:7px 12px;background:${t.color};color:${t.textColor};border:none;border-radius:4px;cursor:pointer;font:inherit;font-size:12px;font-weight:700">
                        ${t.label}
                    </button>
                `).join('');
                actionSectionHtml = `
                    <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        <span style="color:#aaa;font-size:12px;margin-right:4px">Change status:</span>
                        ${btns}
                    </div>
                `;
            }

            card.innerHTML = `
                <div style="font-size:15px;font-weight:600;margin-bottom:6px;display:flex;align-items:baseline;gap:8px">
                    <span style="color:#aaa">Issue ·</span>
                    <span style="color:${statusMeta.color};font-weight:700">${statusMeta.text}</span>
                </div>
                <div style="color:#e6e6e6;font-size:13px;margin-bottom:12px;line-height:1.4">${safeNote}</div>
                <div style="color:#888;font-size:11px;margin-bottom:4px">History</div>
                <div style="max-height:200px;overflow:auto;border:1px solid rgba(255,255,255,0.10);border-radius:4px;background:#14171b">${histRows}</div>
                ${actionSectionHtml}
                <div style="display:flex;gap:8px;align-items:center;margin-top:14px">
                    ${deleteBtnHtml}
                    <button id="aim-issues-modal-close"
                        style="padding:7px 14px;background:#3a3f48;color:#e6e6e6;border:none;border-radius:4px;cursor:pointer;font:inherit;margin-left:${canDelete ? '0' : 'auto'}">
                        Close
                    </button>
                </div>
            `;
            wireHandlers(liveIssue, transitions);
        }

        function wireHandlers(liveIssue, transitions) {
            card.querySelector('#aim-issues-modal-close').onclick = closeStatusModal;

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

            // Armed-mode buttons
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
                    if (armed.noteRequired && !note) {
                        const err = card.querySelector('#aim-issues-modal-noteerr');
                        if (err) err.textContent = 'Note required for this transition.';
                        if (noteInput) noteInput.focus();
                        return;
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

        render();
        document.body.appendChild(overlay);
        statusModalEl = overlay;
        const keyH = (e) => {
            if (e.key !== 'Escape') return;
            // Escape during armed cancels back to transition list; from
            // transition list it closes the modal.
            if (armed) { armed = null; pendingNote = ''; render(); }
            else closeStatusModal();
        };
        overlay.addEventListener('keydown', keyH, true);
    }

    function closeStatusModal() {
        if (statusModalEl) { try { statusModalEl.remove(); } catch (e) {} }
        statusModalEl = null;
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
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    // ------- Init -------
    function init() {
        setupControlChannel();
        registerWithControlPanel();
        // v0.5: seed sync status from the cached token recovered from
        // GM storage (survives refresh). Control Panel will broadcast
        // the authoritative TOKEN_VALUE shortly after; that path also
        // (re)fetches the username.
        if (cachedToken) {
            syncStatus = cachedUsername ? 'ok' : 'syncing';
            // Refresh username in the background — handles PAT rotation.
            fetchGithubUsername();
        } else {
            syncStatus = 'no-token';
        }
        // Always ask the Control Panel for the current token so we get
        // the latest if the user updated it elsewhere.
        try { if (controlChannel) controlChannel.postMessage({ type: 'REQUEST_TOKEN' }); } catch (e) {}

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
