// ==UserScript==
// @name         Latest - AIM Copy Asset Name
// @namespace    http://tampermonkey.net/
// @version      3.91
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Copy_Asset_Name.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Copy_Asset_Name.user.js
// @description  Right-click any entity (asset, FFZ, flight path, marker) to pop up an inspector with name/type/elevation/notes. Each row click-to-copy. "Open in editor" triggers Percepto's native edit dialog. Replaces the old Shift+Ctrl+Q hotkey. Panel display name: "Asset Inspector".
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @connect      raw.githubusercontent.com
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

    const SCRIPT_ID = 'aim-copy-asset'; // preserved for prefs continuity
    const SCRIPT_VERSION = '3.91';
    // v3.58: log SCRIPT_VERSION instead of hardcoded "v2.0" so updates
    // are visible in the console (was stuck reading "v2.0 loading" for
    // ~50 versions, which made auto-update verification impossible).
    console.log(`${TAG} v${SCRIPT_VERSION} loading`);
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

    // Pull the human-readable site name from the page header's site
    // dropdown. Lives in the TOP frame (Percepto's app shell — the
    // map iframe doesn't have it). Same-origin so cross-frame access
    // works. Returns null if the dropdown hasn't rendered yet — the
    // caller can fall back to showing just the site ID.
    function getCurrentSiteName() {
        try {
            const topDoc = (window.top || window).document;
            const el = topDoc.querySelector('.site-select .ant-select-selection-item');
            if (el) {
                const t = el.getAttribute('title') || el.textContent || '';
                return t.trim() || null;
            }
        } catch (e) {
            // Cross-origin or DOM access issue — fall through to null
        }
        return null;
    }
    // Combined "Site 1596 · Exxon 34 - Texas Ten" string for headers.
    // If no name resolves, just returns "Site 1596".
    function siteHeaderLabel(siteID) {
        const name = getCurrentSiteName();
        if (name) return `${name} · Site ${siteID}`;
        return `Site ${siteID}`;
    }

    // ============================================================
    // Data fetch — internal endpoint, cookie auth (no token needed)
    // ============================================================
    // Returns a Promise that resolves AFTER the new data is in
    // mapObjectsBySite. Callers can `await` to ensure post-save reads
    // see the fresh server state. With force=true, bypasses both the
    // in-flight dedup AND any HTTP cache (Percepto + browser).
    function fetchMapObjects(siteID, force) {
        if (!siteID) return Promise.resolve();
        // Force bypasses in-flight dedup — verification needs FRESH
        // data, not whatever's already on the wire (could be a stale
        // pre-save request triggered by an unrelated Percepto event).
        if (!force && fetchingSites.has(siteID)) return Promise.resolve();
        if (!force && mapObjectsBySite[siteID]) return Promise.resolve();
        fetchingSites.add(siteID);
        // Cache-bust query param when forcing — defeats HTTP cache +
        // any CDN/proxy layer. The endpoint ignores unknown params.
        let url = MAP_OBJECTS_URL + encodeURIComponent(siteID);
        if (force) url += `&_t=${Date.now()}`;
        console.log(`${TAG} fetching map_objects for site ${siteID}${force ? ' (force, cache-bust)' : ''}`);
        const headers = force ? { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } : {};
        return fetch(url, { credentials: 'same-origin', cache: force ? 'no-store' : 'default', headers })
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
    // v3.81: save-invalidator. The inspector caches /map_objects/ per
    // site at page load and never refetches on native saves. Result:
    // after Percepto's editor saves (including FPE splits), the new
    // geometry exists on the server + in Percepto's live state but the
    // inspector's cache is the page-load snapshot → right-click on the
    // new segment bails with "no entity". Reload was the workaround.
    //
    // Fix: wrap fetch + XHR so any successful POST /map_objects/ from
    // ANY source (native Save, FPE, AI's own Apply) invalidates the
    // current site's cache and triggers a background refetch. Next
    // right-click sees fresh data with no manual refresh.
    //
    // Wraps run in the IFRAME (where Percepto's editor lives) on
    // unsafeWindow so we catch the page's real fetch/XHR, not the
    // sandbox proxies. Idempotent via __aim_ai_save_invalidator_installed.
    // ============================================================
    const SAVE_URL_RE = /\/map_objects\/?(\?|$)/;
    function installSaveInvalidator() {
        if (CONTEXT === 'TOP') return; // saves happen in iframe
        const realWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        try {
            if (realWin.__aim_ai_save_invalidator_installed) return;
            realWin.__aim_ai_save_invalidator_installed = true;

            const onSaveSuccess = () => {
                const sid = getCurrentSiteID();
                if (!sid) return;
                if (!mapObjectsBySite[sid]) return; // already empty, nothing to invalidate
                delete mapObjectsBySite[sid];
                console.log(`${TAG} cache invalidated for site ${sid} after POST /map_objects/`);
                // Short delay: let the save finish + give the server a moment
                // before we re-read. 300 ms is plenty for same-host writes.
                setTimeout(() => fetchMapObjects(sid).catch(() => {}), 300);
            };

            // ---- fetch wrapper ----
            const origFetch = realWin.fetch;
            if (typeof origFetch === 'function') {
                realWin.fetch = function (input, init) {
                    let url, method;
                    try {
                        url = (input && typeof input === 'object' && 'url' in input) ? input.url : input;
                        method = ((init && init.method) || (input && input.method) || 'GET').toString().toUpperCase();
                    } catch (e) {}
                    const p = origFetch.apply(this, arguments);
                    try {
                        if (method === 'POST' && typeof url === 'string' && SAVE_URL_RE.test(url)) {
                            p.then(resp => { if (resp && resp.ok) onSaveSuccess(); }).catch(() => {});
                        }
                    } catch (e) {}
                    return p;
                };
            }

            // ---- XHR wrapper (Axios + Percepto's classic save path) ----
            const XHR = realWin.XMLHttpRequest;
            if (XHR && XHR.prototype && !XHR.prototype.__aim_ai_save_xhr_wrapped) {
                XHR.prototype.__aim_ai_save_xhr_wrapped = true;
                const origOpen = XHR.prototype.open;
                const origSend = XHR.prototype.send;
                XHR.prototype.open = function (method, url) {
                    try { this.__aim_ai_method = method; this.__aim_ai_url = url; } catch (e) {}
                    return origOpen.apply(this, arguments);
                };
                XHR.prototype.send = function () {
                    try {
                        const m = String(this.__aim_ai_method || 'GET').toUpperCase();
                        if (m === 'POST' && typeof this.__aim_ai_url === 'string' && SAVE_URL_RE.test(this.__aim_ai_url)) {
                            this.addEventListener('load', () => {
                                try { if (this.status >= 200 && this.status < 300) onSaveSuccess(); } catch (e) {}
                            });
                        }
                    } catch (e) {}
                    return origSend.apply(this, arguments);
                };
            }
            console.log(`${TAG} save-invalidator armed (cache refreshes after any /map_objects/ save)`);
        } catch (e) {
            console.warn(`${TAG} installSaveInvalidator failed:`, e);
        }
    }

    // ============================================================
    // DEM ground elevation — piggybacks Percepto's own endpoint.
    // Same pattern as MBT v0.40+; see feedback-percepto-location-
    // altitude-endpoint memory for the discovery story.
    // ============================================================
    const CACHE_KEY_ELEVATIONS = 'aim-ai-elev-cache'; // ai = Asset Inspector
    const CACHE_KEY_COLUMN_ORDER = 'aim-ai-column-order'; // ordered list of visible column keys
    const CACHE_KEY_COLUMN_WIDTHS = 'aim-ai-column-widths'; // {colKey: px} per-user resized widths
    const CACHE_KEY_BASE_GM = 'aim-ai-base-gm';            // {siteID: gmEntityId} chosen basestation marker (route feature)
    const CACHE_KEY_SHOW_SAMPLES = 'aim-ai-show-samples'; // boolean — sample dots on map
    const CACHE_KEY_VIEW_PRESETS = 'aim-ai-view-presets'; // [{name, columnOrder, typeFilter, ...filters, sortKey, sortDir, unitsFt}]
    const ELEV_KEY_PRECISION = 5; // 5 decimals ≈ 1m
    const ELEV_CONCURRENCY = 4;
    let elevationCache = null;
    let elevQueue = [];
    let elevActive = 0;
    const elevInFlight = {};

    // Loud one-time warning if GM_* are missing. Critical because if
    // these no-op, EVERYTHING that "persists" silently doesn't —
    // elevation cache, column order, panel preferences, etc. v3.37 and
    // earlier had `@grant none` which made these unavailable; the
    // helpers checked typeof === 'function' and silently no-opped.
    let _gmWarnedMissing = false;
    function elevGmGet(key, def) {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, def);
        } catch (e) {}
        if (!_gmWarnedMissing) {
            _gmWarnedMissing = true;
            console.warn(`${TAG} ⚠ GM_getValue/GM_setValue not available — check @grant directives. Persistence is BROKEN until fixed.`);
        }
        return def;
    }
    function elevGmSet(key, val) {
        try {
            if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
        } catch (e) { console.warn(`${TAG} GM_setValue threw:`, e); return; }
        if (!_gmWarnedMissing) {
            _gmWarnedMissing = true;
            console.warn(`${TAG} ⚠ GM_setValue not available — check @grant directives. Persistence is BROKEN until fixed.`);
        }
    }
    function loadElevationCache() {
        if (elevationCache) return elevationCache;
        try { elevationCache = elevGmGet(CACHE_KEY_ELEVATIONS, {}) || {}; }
        catch (e) { elevationCache = {}; }
        const n = Object.keys(elevationCache).length;
        const sizeKb = Math.round(JSON.stringify(elevationCache).length / 1024);
        console.log(`${TAG} DEM elevation cache loaded: ${n.toLocaleString()} points (${sizeKb} KB)${n === 0 ? ' — empty (first run / cleared / Tampermonkey storage evicted)' : ''}`);
        return elevationCache;
    }
    // Cache write strategy (v3.37):
    //   - CHECKPOINT every ELEV_SAVE_BATCH new entries (50).
    //     Don't wait for the debounce to fire; commit-as-you-go.
    //   - TRAILING debounce 1 s after the last entry catches the
    //     tail of a fetch run that ends below the batch threshold.
    //   - beforeunload flush is best-effort (GM_setValue is async
    //     in Tampermonkey/Chrome — may not complete before unload).
    // v3.36 + earlier used only the debounce, so a 1000+-point bulk
    // fetch could finish without ever writing if the page was
    // refreshed before the 1 s idle window elapsed. End result was
    // every page load re-fetching everything from scratch.
    const ELEV_SAVE_BATCH = 50;
    let elevDirtyCount = 0;
    let elevSaveTimer = null;
    function saveElevationCache() {
        if (!elevationCache) return;
        elevDirtyCount++;
        if (elevDirtyCount >= ELEV_SAVE_BATCH) {
            if (elevSaveTimer) { clearTimeout(elevSaveTimer); elevSaveTimer = null; }
            const totalCount = Object.keys(elevationCache).length;
            elevDirtyCount = 0;
            try { elevGmSet(CACHE_KEY_ELEVATIONS, elevationCache); }
            catch (e) { console.warn(`${TAG} elevation cache write failed:`, e); }
            console.log(`${TAG} DEM cache checkpoint: ${totalCount.toLocaleString()} total entries persisted`);
            return;
        }
        if (elevSaveTimer) clearTimeout(elevSaveTimer);
        elevSaveTimer = setTimeout(() => {
            elevSaveTimer = null;
            elevDirtyCount = 0;
            try { elevGmSet(CACHE_KEY_ELEVATIONS, elevationCache); }
            catch (e) { console.warn(`${TAG} elevation cache trailing-write failed:`, e); }
        }, 1000);
    }
    function flushElevationCache() {
        if (elevSaveTimer) { clearTimeout(elevSaveTimer); elevSaveTimer = null; }
        if (!elevationCache) return;
        elevDirtyCount = 0;
        try { elevGmSet(CACHE_KEY_ELEVATIONS, elevationCache); }
        catch (e) {}
    }
    function elevCacheKey(lat, lng) {
        return `${Number(lat).toFixed(ELEV_KEY_PRECISION)},${Number(lng).toFixed(ELEV_KEY_PRECISION)}`;
    }
    function getElevationFromCache(lat, lng) {
        return loadElevationCache()[elevCacheKey(lat, lng)];
    }
    function fetchElevation(lat, lng) {
        const key = elevCacheKey(lat, lng);
        const cache = loadElevationCache();
        if (cache[key] != null) return Promise.resolve(cache[key]);
        if (elevInFlight[key]) return elevInFlight[key];
        const p = new Promise(resolve => {
            elevQueue.push({ lat, lng, key, resolve });
            pumpElevQueue();
        }).then(meters => { delete elevInFlight[key]; return meters; });
        elevInFlight[key] = p;
        return p;
    }
    function pumpElevQueue() {
        while (elevActive < ELEV_CONCURRENCY && elevQueue.length > 0) {
            const task = elevQueue.shift();
            elevActive++;
            const url = `/location_altitude/?location=${encodeURIComponent(JSON.stringify({ lat: task.lat, lng: task.lng }))}`;
            fetch(url, { credentials: 'include' })
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                    const meters = data && typeof data.altitude === 'number' ? data.altitude : null;
                    if (meters != null) {
                        loadElevationCache()[task.key] = meters;
                        saveElevationCache();
                    }
                    task.resolve(meters);
                })
                .catch(() => task.resolve(null))
                .finally(() => { elevActive--; pumpElevQueue(); });
        }
    }
    function bulkFetchElevations(points, onProgress) {
        if (!points || points.length === 0) return Promise.resolve();
        let done = 0;
        return Promise.all(points.map(p =>
            fetchElevation(p.lat, p.lng).finally(() => {
                done++;
                if (onProgress) onProgress(done, points.length);
            })
        ));
    }

    // Best-effort centroid for any entity type. Returns {lat, lng} or null.
    // Assets/Markers: first coord. Polygons (FFZ/NFZ): average of coords.
    // Flight Paths (arcs): midpoint of first arc.
    function getEntityCentroid(e) {
        if (!e) return null;
        // Assets, Markers
        if (Array.isArray(e.coords) && e.coords.length > 0) {
            const cs = e.coords.filter(c => c && typeof c.lat === 'number' && typeof c.lng === 'number');
            if (cs.length === 0) return null;
            const lat = cs.reduce((s, c) => s + c.lat, 0) / cs.length;
            const lng = cs.reduce((s, c) => s + c.lng, 0) / cs.length;
            return { lat, lng };
        }
        // Flight paths
        if (Array.isArray(e.arcs) && e.arcs.length > 0) {
            const a = e.arcs[0];
            if (a && a.point_a && a.point_b
                && typeof a.point_a.lat === 'number' && typeof a.point_b.lat === 'number') {
                return {
                    lat: (a.point_a.lat + a.point_b.lat) / 2,
                    lng: (a.point_a.lng + a.point_b.lng) / 2,
                };
            }
        }
        return null;
    }

    // Midpoint of an arc — kept for backward-compat callers (the new
    // multi-point sampling helpers below supersede single-midpoint use).
    function getArcMidpoint(arc) {
        if (!arc || !arc.point_a || !arc.point_b) return null;
        if (typeof arc.point_a.lat !== 'number' || typeof arc.point_b.lat !== 'number') return null;
        return {
            lat: (arc.point_a.lat + arc.point_b.lat) / 2,
            lng: (arc.point_a.lng + arc.point_b.lng) / 2,
        };
    }

    // ============================================================
    // Multi-point elevation sampling (v3.19)
    //
    // Replaces v3.18's single-centroid-per-row sampling. For each row
    // we sample N points along the segment / inside the polygon, then
    // take the MAX elevation across samples as the row's ground
    // elevation. Conservative — catches the highest terrain feature
    // the entity overlaps so AGL planning has the right safety floor.
    //
    // Sample density follows the user's hand-tuned rules:
    //   FP segments by length:
    //     < 200 ft → 3 samples  (0% / 50% / 100%)
    //     200-500  → 5 samples  (0/25/50/75/100%)
    //     500-1000 → 7 samples
    //     ≥ 1000   → 9 samples
    //   Polygons (FFZ / NFZ / Asset): every vertex + edge midpoints,
    //     plus extra subdivisions on edges longer than ~200 ft so
    //     long L/U/C corridor shapes get adequate midline coverage.
    //   Markers: their single point.
    // ============================================================
    function segmentSampleCount(distanceM) {
        const ft = (distanceM || 0) * 3.28084;
        if (ft < 200) return 3;
        if (ft < 500) return 5;
        if (ft < 1000) return 7;
        return 9;
    }
    function sampleAlongSegment(a, b, n) {
        if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return [];
        const pts = [];
        for (let i = 0; i < n; i++) {
            const t = n === 1 ? 0.5 : i / (n - 1);
            pts.push({
                lat: a.lat + (b.lat - a.lat) * t,
                lng: a.lng + (b.lng - a.lng) * t,
            });
        }
        return pts;
    }
    function samplePolygon(coords) {
        if (!Array.isArray(coords) || coords.length < 3) return [];
        const pts = [];
        for (let i = 0; i < coords.length; i++) {
            const a = coords[i];
            const b = coords[(i + 1) % coords.length];
            if (!a || typeof a.lat !== 'number') continue;
            pts.push({ lat: a.lat, lng: a.lng });
            if (!b || typeof b.lat !== 'number') continue;
            // Subdivide long edges: 1 extra point per ~200 ft of edge
            // length. Captures terrain along long thin corridor shapes
            // (typical FFZ along a power line) without exploding
            // sample counts on small entities.
            const edgeFt = approxMeters(a.lat, a.lng, b.lat, b.lng) * 3.28084;
            const extras = Math.max(1, Math.floor(edgeFt / 200));
            for (let k = 1; k <= extras; k++) {
                const t = k / (extras + 1);
                pts.push({
                    lat: a.lat + (b.lat - a.lat) * t,
                    lng: a.lng + (b.lng - a.lng) * t,
                });
            }
        }
        return pts;
    }
    // Returns the list of sample points for a non-segment entity.
    // Segment rows compute their own sample list from arc data inside
    // buildSummaryRows.
    //
    // SKIPPED on purpose (v3.21):
    //   - NFZ (type 4): no-fly zones extend infinitely up — ground
    //     elevation under them is meaningless for flight planning.
    //   - Asset (type 3): the asset's claimed elevation_asl is the
    //     source of truth (auto-set during entity creation); a DEM
    //     sample would just be redundant data we never display.
    // Skipping these cuts ~30-40% of DEM queries on a typical site.
    function getSamplePointsForEntity(e) {
        if (!e) return [];
        if (e.type === 16 && Array.isArray(e.coords) && e.coords.length >= 3) {
            return samplePolygon(e.coords);
        }
        // FFZ only — NFZ + Asset intentionally return no sample points.
        return [];
    }
    // ---- Sample-point map visualization (v3.20) ----
    // Drops a small purple dot on the Leaflet map for each sample
    // point we used to compute that row's max ground elevation.
    // Off by default; toggled from the SUM panel toolbar. Lets the
    // user audit that we're sampling the right places.
    //
    // Leaflet's `L` global lives in the iframe (Percepto's map runs
    // there). When the SUM panel is open, this script is also in
    // the iframe so `unsafeWindow.L` resolves correctly. Wrapped in
    // try/catch so we degrade gracefully if Leaflet isn't reachable.
    let sampleMarkers = [];
    let sampleMarkersRenderer = null;
    function getLeafletL() {
        try { return unsafeWindow && unsafeWindow.L; } catch (e) {}
        try { return window.L; } catch (e) {}
        return null;
    }
    function hideSampleMarkers() {
        const map = getLeafletMap();
        sampleMarkers.forEach(m => {
            try { if (map) map.removeLayer(m); } catch (e) {}
        });
        sampleMarkers = [];
    }
    function showSampleMarkersFor(rows) {
        hideSampleMarkers();
        const L = getLeafletL();
        const map = getLeafletMap();
        if (!L || !map) {
            console.warn(`${TAG} can't show sample markers — Leaflet or map missing`);
            return;
        }
        // Canvas renderer keeps perf reasonable at 1000+ markers (a
        // busy site can hit that). Single renderer shared across all
        // markers; recreated whenever we re-render.
        try {
            sampleMarkersRenderer = L.canvas({ padding: 0.5 });
        } catch (e) {
            sampleMarkersRenderer = null;
        }
        rows.forEach(r => {
            const sps = r._samplePoints;
            if (!Array.isArray(sps) || sps.length === 0) return;
            sps.forEach(p => {
                if (!p || typeof p.lat !== 'number') return;
                try {
                    const opts = {
                        radius: 6,                  // up from 3 — easier to hover
                        color: '#000000',           // black border for contrast on any base
                        weight: 1.5,
                        fillColor: '#ffd700',       // bright gold — pops against satellite + KML
                        fillOpacity: 1.0,
                        opacity: 1.0,
                        interactive: true,
                        bubblingMouseEvents: false,
                    };
                    if (sampleMarkersRenderer) opts.renderer = sampleMarkersRenderer;
                    const marker = L.circleMarker([p.lat, p.lng], opts);
                    // Tooltip: row name + this sample's elevation
                    const elev = getElevationFromCache(p.lat, p.lng);
                    let tip;
                    if (elev != null) {
                        const ft = Math.round(elev * 3.28084);
                        tip = `${r.name}<br>${ft.toLocaleString()} ft / ${elev.toFixed(1)} m`;
                    } else {
                        tip = `${r.name}<br>(elevation loading…)`;
                    }
                    marker.bindTooltip(tip, { sticky: true, opacity: 0.95 });
                    marker.addTo(map);
                    sampleMarkers.push(marker);
                } catch (e) {
                    // One bad marker shouldn't kill the rest.
                }
            });
        });
        console.log(`${TAG} rendered ${sampleMarkers.length} sample-point markers`);
    }

    // Returns the MAX elevation across an array of sample points,
    // pulling from the cache only. Null if no samples are cached yet.
    function maxCachedElevation(points) {
        if (!Array.isArray(points) || points.length === 0) return null;
        let max = null;
        for (const p of points) {
            if (!p || typeof p.lat !== 'number') continue;
            const v = getElevationFromCache(p.lat, p.lng);
            if (v != null && (max == null || v > max)) max = v;
        }
        return max;
    }

    window.addEventListener('beforeunload', () => flushElevationCache());

    // ============================================================
    // SHARED ELEVATION DB (v3.39) — GitHub-backed team cache
    //
    // Layered cache:
    //   1. In-memory (elevationCache) — fastest, per session
    //   2. GM_setValue (persistent, per user/computer)
    //   3. GitHub repo (shared across team — Ned-Yap/aim-userscripts-data
    //      under `elevations/<siteID>-elevation.json`)
    //
    // Flow:
    //   - On site open: fetch shared file, merge new entries into local
    //     cache. Only points NOT in either layer get fetched from
    //     Percepto's /location_altitude/.
    //   - After bulk fetch completes with N>0 new points: auto-push
    //     merged cache back to GitHub so the next teammate to visit
    //     this site gets them for free.
    //   - Throttled to one push per site per session.
    //
    // Auth via shared PAT broadcast by Control Panel (TOKEN_VALUE
    // message). Same pattern Map Styler uses for KML commits.
    // ============================================================
    const ELEV_REPO = 'Ned-Yap/aim-userscripts-data';
    const ELEV_REPO_BRANCH = 'main';
    const ELEV_GITHUB_API = 'https://api.github.com';
    const ELEV_RAW_BASE = `https://raw.githubusercontent.com/${ELEV_REPO}/${ELEV_REPO_BRANCH}`;
    const elevPathFor = (siteID) => `elevations/${siteID}-elevation.json`;
    let elevSharedToken = '';
    const elevRemoteMerged = new Set();    // sites we've already pulled this session
    const elevRemoteSha = {};              // sha per site for PUT conflict-aware update
    const elevPushedThisSession = new Set(); // throttle to 1 push per site per session
    let elevPushPending = null;            // pending push debounce timer

    // GM_xmlhttpRequest wrapper that returns a Promise. Required for
    // cross-origin requests to github.com APIs (regular fetch would hit
    // CORS). Mirrors Map Styler's request pattern.
    function elevGmRequest(opts) {
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    ...opts,
                    onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, responseText: r.responseText, responseHeaders: r.responseHeaders }),
                    onerror: () => resolve({ ok: false, status: 0, responseText: '' }),
                    ontimeout: () => resolve({ ok: false, status: 0, responseText: '' }),
                });
            } catch (e) { resolve({ ok: false, status: 0, responseText: '' }); }
        });
    }

    // Pull the shared elevation cache for `siteID` from GitHub and
    // merge non-overlapping entries into the local cache. Idempotent
    // per site per session — won't re-fetch if already merged.
    // Returns the count of entries added from remote.
    async function fetchSharedElevationCache(siteID) {
        if (!siteID || elevRemoteMerged.has(String(siteID))) return 0;
        elevRemoteMerged.add(String(siteID));
        const path = elevPathFor(siteID);
        // First try raw.githubusercontent.com — no auth needed, faster.
        // Fall back to Contents API if raw 404s (file may exist on a
        // branch the raw CDN hasn't cached yet).
        const rawUrl = `${ELEV_RAW_BASE}/${path}?_t=${Date.now()}`;
        let body = null;
        try {
            const r = await elevGmRequest({ method: 'GET', url: rawUrl, timeout: 8000 });
            if (r.ok) body = r.responseText;
        } catch (e) {}
        if (!body) {
            // No shared cache yet for this site — that's fine.
            console.log(`${TAG} no shared elevation cache for site ${siteID} (first user on this site)`);
            return 0;
        }
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) {
            console.warn(`${TAG} shared elevation cache for site ${siteID} is malformed:`, e);
            return 0;
        }
        if (!parsed || typeof parsed.entries !== 'object') return 0;
        const cache = loadElevationCache();
        let added = 0;
        Object.keys(parsed.entries).forEach(k => {
            if (cache[k] == null && typeof parsed.entries[k] === 'number') {
                cache[k] = parsed.entries[k];
                added++;
            }
        });
        if (added > 0) {
            try { elevGmSet(CACHE_KEY_ELEVATIONS, cache); } catch (e) {}
            console.log(`${TAG} merged shared cache for site ${siteID}: +${added.toLocaleString()} points from teammates (updated ${parsed.updatedAt || '?'})`);
        } else {
            console.log(`${TAG} shared cache for site ${siteID} loaded, but local already has all ${Object.keys(parsed.entries).length.toLocaleString()} entries`);
        }
        return added;
    }

    // Look up the GitHub file SHA so a PUT can update it without
    // 409-conflict. Returns null if file doesn't exist yet (PUT will
    // create it).
    async function fetchElevationFileSha(siteID, token) {
        if (!token) return null;
        const path = elevPathFor(siteID);
        const url = `${ELEV_GITHUB_API}/repos/${ELEV_REPO}/contents/${encodeURIComponent(path)}?ref=${ELEV_REPO_BRANCH}`;
        const r = await elevGmRequest({
            method: 'GET',
            url,
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
            timeout: 8000,
        });
        if (!r.ok) return null;
        try {
            const j = JSON.parse(r.responseText);
            return j.sha || null;
        } catch (e) { return null; }
    }

    // Push the local cache (filtered to entries for `siteID`'s sample
    // points if computable; else entire local cache) back to the
    // shared repo. Throttled to one push per site per session.
    async function pushSharedElevationCache(siteID, sitePointKeys) {
        if (!siteID) return;
        if (elevPushedThisSession.has(String(siteID))) return;
        const token = elevSharedToken;
        if (!token) {
            console.log(`${TAG} no PAT cached — skipping shared cache push for site ${siteID} (open Control Panel + set token to enable)`);
            return;
        }
        // Build the file payload from the LOCAL cache, optionally
        // filtered to this site's sample-point keys (avoids polluting
        // one site's file with cache entries from another).
        const cache = loadElevationCache();
        const entries = {};
        if (sitePointKeys && sitePointKeys.size > 0) {
            sitePointKeys.forEach(k => {
                if (cache[k] != null) entries[k] = cache[k];
            });
        } else {
            // Fallback — push everything we have. Shouldn't normally
            // happen since callers pass the site's point keys.
            Object.assign(entries, cache);
        }
        const count = Object.keys(entries).length;
        if (count === 0) return;
        const payload = {
            site: Number(siteID),
            updatedAt: new Date().toISOString(),
            entries,
        };
        const json = JSON.stringify(payload);
        const sha = await fetchElevationFileSha(siteID, token);
        const utf8 = new TextEncoder().encode(json);
        let bin = '';
        for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
        const contentB64 = btoa(bin);
        const body = {
            message: `[AIM site ${siteID}] elevation cache update (${count.toLocaleString()} points)`,
            content: contentB64,
            branch: ELEV_REPO_BRANCH,
        };
        if (sha) body.sha = sha;
        const url = `${ELEV_GITHUB_API}/repos/${ELEV_REPO}/contents/${encodeURIComponent(elevPathFor(siteID))}`;
        const r = await elevGmRequest({
            method: 'PUT',
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
            },
            data: JSON.stringify(body),
            timeout: 20000,
        });
        if (r.ok) {
            elevPushedThisSession.add(String(siteID));
            console.log(`${TAG} ✓ pushed ${count.toLocaleString()} elevation points to shared cache for site ${siteID}`);
        } else if (r.status === 401 || r.status === 403) {
            console.warn(`${TAG} ⚠ shared elev push denied (HTTP ${r.status}) — PAT needs contents:write on ${ELEV_REPO}`);
        } else if (r.status === 409) {
            console.warn(`${TAG} ⚠ shared elev push conflict (HTTP 409) — another teammate pushed during our run; will retry next session`);
            elevRemoteMerged.delete(String(siteID)); // allow re-pull next time
        } else {
            console.warn(`${TAG} shared elev push failed (HTTP ${r.status}):`, (r.responseText || '').substring(0, 200));
        }
    }

    // Debounced trigger — after a bulk fetch completes, wait briefly
    // then push. Lets multiple completion events (e.g. user toggles
    // the panel a couple times) coalesce into a single push.
    function schedulePushSharedCache(siteID, sitePointKeys) {
        if (elevPushPending) { clearTimeout(elevPushPending); elevPushPending = null; }
        elevPushPending = setTimeout(() => {
            elevPushPending = null;
            pushSharedElevationCache(siteID, sitePointKeys).catch(e =>
                console.warn(`${TAG} push exception:`, e));
        }, 3000);
    }

    // Bulk DEM fetch for the SUM panel — dedup by cache key (multiple
    // entities at same lat/lng share one request). One re-render at end.
    let demFetchInFlight = false;
    async function kickOffDemFetch(siteID, rows) {
        if (demFetchInFlight) return;
        // Layered lookup. Cheap first: count what's missing from local
        // cache. If local already covers everything → skip the GitHub
        // round-trip entirely (saves a ~500ms hit on cache-hit reloads).
        // Otherwise → pull shared cache, then re-check, then fetch what's
        // STILL missing from Percepto. Push back any new entries.
        const sitePointKeys = new Set();
        let preCheckNeed = 0;
        rows.forEach(r => {
            const sps = r._samplePoints;
            if (!Array.isArray(sps)) return;
            sps.forEach(p => {
                if (!p || typeof p.lat !== 'number') return;
                const key = elevCacheKey(p.lat, p.lng);
                if (sitePointKeys.has(key)) return;
                sitePointKeys.add(key);
                if (loadElevationCache()[key] == null) preCheckNeed++;
            });
        });
        if (preCheckNeed > 0) {
            await fetchSharedElevationCache(siteID);
        }
        // Re-check after potential merge from shared cache.
        const points = [];
        const seen = new Set();
        let cacheHits = 0;
        rows.forEach(r => {
            const sps = r._samplePoints;
            if (!Array.isArray(sps)) return;
            sps.forEach(p => {
                if (!p || typeof p.lat !== 'number') return;
                const key = elevCacheKey(p.lat, p.lng);
                if (seen.has(key)) return;
                seen.add(key);
                const cache = loadElevationCache();
                if (cache[key] != null) { cacheHits++; return; }
                if (elevInFlight[key]) return;
                points.push({ lat: p.lat, lng: p.lng });
            });
        });
        console.log(`${TAG} DEM bulk for site ${siteID}: ${seen.size} unique sample points · ${cacheHits} cache hits · ${points.length} new (need fetch)`);
        if (points.length === 0) {
            if (window.__aim_ai_onDemReady) window.__aim_ai_onDemReady();
            return;
        }
        demFetchInFlight = true;
        console.log(`${TAG} fetching ${points.length} DEM elevations for site ${siteID}`);
        if (window.__aim_ai_onDemProgress) window.__aim_ai_onDemProgress(0, points.length);
        bulkFetchElevations(points, (done, total) => {
            if (window.__aim_ai_onDemProgress) window.__aim_ai_onDemProgress(done, total);
        }).then(() => {
            demFetchInFlight = false;
            if (window.__aim_ai_onDemProgress) window.__aim_ai_onDemProgress(points.length, points.length, true);
            if (window.__aim_ai_onDemReady) window.__aim_ai_onDemReady();
            // Push new entries back to shared cache so teammates benefit
            // on their next visit. Throttled to one push per site per
            // session (see schedulePushSharedCache).
            schedulePushSharedCache(siteID, sitePointKeys);
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
    // v3.77: After the Direct-API Apply pipeline POSTs to /map_objects/,
    // the server echoes the entity back in the WRITE shape — `points`
    // instead of `coords`. That `saved` then overwrites bucket.entities[idx]
    // in the cache. Subsequent right-clicks miss because findEntityAtLatLng
    // tests Array.isArray(e.coords), which is now false. This helper returns
    // whichever vertex array is populated. Fixes silent hit-test rot after
    // any Apply run. (Diagnosed via PIP HITS finding the entity on a live
    // fetch but AI's cached pip returning null on the same coord.)
    function entityCoords(e) {
        if (!e) return null;
        if (Array.isArray(e.coords) && e.coords.length > 0) return e.coords;
        if (Array.isArray(e.points) && e.points.length > 0) return e.points;
        return null;
    }
    // v3.75: Percepto stores some asset polygons as [corner, well-head-point,
    // corner, corner, corner] — i.e. 4 rectangle corners + 1 interior point.
    // In the raw vertex order this forms a self-intersecting "bowtie" that
    // breaks ray-casting. Sort by angle around the centroid to convert any
    // star-shaped polygon (which well pads + reasonable FFZs all are) into
    // a proper simple polygon before pip-testing.
    function simplifyPolygon(poly) {
        if (!poly || poly.length < 3) return poly || [];
        let cLat = 0, cLng = 0;
        for (const p of poly) { cLat += p.lat; cLng += p.lng; }
        cLat /= poly.length; cLng /= poly.length;
        return poly.slice().sort((a, b) =>
            Math.atan2(a.lat - cLat, a.lng - cLng)
          - Math.atan2(b.lat - cLat, b.lng - cLng)
        );
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

    // ============================================================
    // SPATIAL CORE (v3.88) — flight-path graph + shortest path.
    // Shared by the route/battery feature (Phase 3) and, later, the
    // SOP proximity/overlap validators (Phase 4). Connectivity uses the
    // established 6-decimal shared-vertex model: two arcs are adjacent
    // iff they share a waypoint rounded to 6 dp (~0.1 m). Edge weight is
    // the server's arc.distance (meters), falling back to approxMeters.
    // ============================================================
    function vkey(p) {
        return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
    }
    // Build the undirected flight-path graph for a site's entities.
    // Returns { adj: Map<vkey,[{to,w}]>, verts: Map<vkey,{lat,lng}> }.
    function buildFlightPathGraph(entities) {
        const adj = new Map();
        const verts = new Map();
        const addVert = (p) => {
            const k = vkey(p);
            if (!verts.has(k)) verts.set(k, { lat: p.lat, lng: p.lng });
            if (!adj.has(k)) adj.set(k, []);
            return k;
        };
        (entities || []).forEach(e => {
            if (e.type !== 15 || !Array.isArray(e.arcs)) return;
            e.arcs.forEach(arc => {
                if (!arc.point_a || !arc.point_b) return;
                if (typeof arc.point_a.lat !== 'number' || typeof arc.point_b.lat !== 'number') return;
                const ka = addVert(arc.point_a), kb = addVert(arc.point_b);
                if (ka === kb) return; // degenerate zero-length arc
                const w = (typeof arc.distance === 'number' && arc.distance > 0)
                    ? arc.distance
                    : approxMeters(arc.point_a.lat, arc.point_a.lng, arc.point_b.lat, arc.point_b.lng);
                adj.get(ka).push({ to: kb, w });
                adj.get(kb).push({ to: ka, w });
            });
        });
        return { adj, verts };
    }
    // Single-source Dijkstra from a start vertex key. Returns Map<vkey,
    // distMeters>. Linear extract-min — graphs here are a few hundred
    // vertices at most, so O(V²) is negligible and avoids a heap dep.
    function dijkstraFrom(graph, startKey) {
        const dist = new Map();
        if (!graph.adj.has(startKey)) return dist;
        dist.set(startKey, 0);
        const visited = new Set();
        const pq = [{ k: startKey, d: 0 }];
        while (pq.length) {
            let mi = 0;
            for (let i = 1; i < pq.length; i++) if (pq[i].d < pq[mi].d) mi = i;
            const { k, d } = pq.splice(mi, 1)[0];
            if (visited.has(k)) continue;
            visited.add(k);
            (graph.adj.get(k) || []).forEach(({ to, w }) => {
                const nd = d + w;
                if (nd < (dist.has(to) ? dist.get(to) : Infinity)) {
                    dist.set(to, nd);
                    pq.push({ k: to, d: nd });
                }
            });
        }
        return dist;
    }
    // Nearest graph vertex to a lat/lng. Returns {key, dist(m), vert}|null.
    function nearestGraphVertex(graph, lat, lng) {
        let best = null;
        graph.verts.forEach((v, k) => {
            const d = approxMeters(lat, lng, v.lat, v.lng);
            if (!best || d < best.dist) best = { key: k, dist: d, vert: v };
        });
        return best;
    }
    // Ray-casting point-in-polygon. ring = [{lat,lng}…] (open or closed).
    function pointInPolygon(lat, lng, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].lng, yi = ring[i].lat;
            const xj = ring[j].lng, yj = ring[j].lat;
            const intersect = ((yi > lat) !== (yj > lat)) &&
                (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    // Distance (m) from a point to a polygon: 0 if inside, else min edge dist.
    function pointToPolygonMeters(lat, lng, ring) {
        if (pointInPolygon(lat, lng, ring)) return 0;
        let best = Infinity;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const d = pointToSegMeters(lat, lng, ring[j], ring[i]);
            if (d < best) best = d;
        }
        return best;
    }
    function findEntityAtLatLng(lat, lng, siteID) {
        const bucket = mapObjectsBySite[siteID];
        if (!bucket) return null;
        const entities = bucket.entities || [];
        // 1. Polygon hit (assets type 3, NFZs type 4, FFZs type 16). v3.77:
        //    use entityCoords(e) helper so Apply'd entities (whose `.coords`
        //    was replaced with `.points` by the server's write-shape echo)
        //    still hit-test. Raw first, sort fallback for bowtie wells.
        let bestPoly = null, bestPolyArea = Infinity;
        for (const e of entities) {
            if (e.type === 3 || e.type === 4 || e.type === 16) {
                const polyCoords = entityCoords(e);
                if (!polyCoords || polyCoords.length < 3) continue;
                let inside = pointInPolygon(lat, lng, polyCoords);
                if (!inside) inside = pointInPolygon(lat, lng, simplifyPolygon(polyCoords));
                if (inside) {
                    // Rough area via bounding box (cheap, no real area calc).
                    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
                    for (const c of polyCoords) {
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
        // 2. Flight paths (type 15) — distance to nearest segment < 8m.
        //    Arcs preferred; if missing, fall back to entityCoords (v3.77).
        let bestFP = null, bestFPDist = 8;
        for (const e of entities) {
            if (e.type !== 15) continue;
            if (Array.isArray(e.arcs) && e.arcs.length) {
                for (const arc of e.arcs) {
                    if (arc && arc.point_a && arc.point_b) {
                        const d = pointToSegMeters(lat, lng, arc.point_a, arc.point_b);
                        if (d < bestFPDist) { bestFP = e; bestFPDist = d; }
                    }
                }
            } else {
                const fpCoords = entityCoords(e);
                if (fpCoords && fpCoords.length >= 2) {
                    for (let i = 0; i < fpCoords.length - 1; i++) {
                        const d = pointToSegMeters(lat, lng, fpCoords[i], fpCoords[i+1]);
                        if (d < bestFPDist) { bestFP = e; bestFPDist = d; }
                    }
                }
            }
        }
        if (bestFP) return bestFP;
        // 3. Point markers (type 19) — nearest within 15m. v3.77 entityCoords fallback.
        let bestPt = null, bestPtDist = 15;
        for (const e of entities) {
            if (e.type !== 19) continue;
            const mc = entityCoords(e);
            if (!mc || !mc[0]) continue;
            const d = approxMeters(lat, lng, mc[0].lat, mc[0].lng);
            if (d < bestPtDist) { bestPt = e; bestPtDist = d; }
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
            // v3.40: Unshielded + Validated rows removed for assets — they're
            // for other entity types (FFZ/FP/NFZ) and not meaningful here.
            // Other entity types still get Validated via the type-agnostic
            // push below.
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
        // v3.40: skip Validated for assets (the field exists on Percepto's
        // model but isn't meaningful for assets — only FFZ/FP/NFZ care).
        if (e.type !== 3) {
            out.push({ label: 'Validated', value: e.validated ? 'yes' : 'no' });
        }
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
            // v3.41 exception: the Subtype row for assets is click-to-EDIT
            // (opens inline editor), pencil icon instead of copy icon.
            if (value === '' || value === null || value === undefined) return;
            const isSubtypeEditable = (label === 'Subtype' && entity.type === 3);
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;padding:5px 12px;cursor:pointer;align-items:flex-start;gap:8px';
            row.onmouseenter = () => { row.style.background = 'rgba(20,210,220,0.12)'; };
            row.onmouseleave = () => { row.style.background = 'transparent'; };
            const lbl = document.createElement('span');
            lbl.style.cssText = 'flex:0 0 75px;color:#888;font-size:11px;line-height:1.4';
            lbl.textContent = label;
            const val = document.createElement('span');
            val.style.cssText = 'flex:1;color:#e6e6e6;font-size:12px;word-break:break-word;line-height:1.4';
            const icon = document.createElement('span');
            icon.style.cssText = 'flex:0 0 14px;color:#7adfe6;font-size:11px;text-align:right;opacity:0.55';
            if (isSubtypeEditable) {
                // Show effective value + pending visual; click to edit.
                const eff = effectiveSubtype(entity);
                if (eff.pending && eff.oldValue) {
                    const oldSpan = document.createElement('span');
                    oldSpan.textContent = eff.oldValue;
                    oldSpan.style.cssText = 'color:#888;text-decoration:line-through;margin-right:5px';
                    const newSpan = document.createElement('span');
                    newSpan.textContent = eff.value + (eff.isNew ? ' ✨' : '');
                    newSpan.style.cssText = 'color:#ffd54f;font-weight:700';
                    val.appendChild(oldSpan);
                    val.appendChild(newSpan);
                } else {
                    val.textContent = String(eff.value || '');
                }
                icon.textContent = '✎';
                icon.title = 'Click to edit subtype';
                row.title = 'Click: edit subtype · queues to apply';
                row.onclick = (ev) => {
                    ev.stopPropagation();
                    startInlineSubtypeEdit(val, entity, (queued) => {
                        // Refresh just this row's display by closing +
                        // re-opening would also work, but we already have
                        // the popup state; the next click on the entity
                        // will re-build from the freshly-queued data.
                        if (queued) closeInspector();
                    });
                };
            } else {
                val.textContent = String(value);
                icon.textContent = '⧉';
                row.onclick = (ev) => {
                    ev.stopPropagation();
                    copyToClipboard(String(value), `Copied ${label}`);
                };
            }
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
            // v3.46: after the filter settles, auto-click the matching
            // result row so the user lands directly in the entity editor
            // instead of having to do an extra M1 on the result.
            const inputDoc = input.ownerDocument || document;
            const matchLower = name.trim().toLowerCase();
            setTimeout(() => {
                let target = null;
                const items = inputDoc.querySelectorAll('.map-entities__entity-item');
                // Prefer an exact name match. Fall back to "the only visible row"
                // after the filter (if there's just one, it's our target).
                for (const item of items) {
                    const txt = (item.textContent || '').trim().toLowerCase();
                    if (txt.includes(matchLower)) { target = item; break; }
                }
                if (!target && items.length === 1) target = items[0];
                if (target) {
                    try { clickElDispatch(target, inputDoc); } catch (e) {}
                    showToast(`Opened ${name}`);
                } else {
                    showToast(`Filtered Map Entities to "${name}" — click the result to open`);
                }
            }, 300);
        } catch (e) {
            console.warn(`${TAG} sidebar paste failed, falling back to clipboard:`, e);
            copyToClipboard(name, `Copied "${name}" — paste in Map Entities sidebar`);
        }
    }

    // ============================================================
    // Visibility control (v3.47) — drive Percepto's sidebar checkboxes
    //
    // Per-entity visibility toggle backed by Percepto's native sidebar:
    //   M1 on the eye → search + click that one entity's checkbox.
    //   M2 on a visible eye → solo: uncheck + collapse every section, then
    //     search + check just the target.
    //   M2 on a hidden eye → unsolo: check every section, clear search.
    //
    // Why drive sidebar checkboxes (vs hiding Leaflet layers directly):
    //   The sidebar is the source of truth for Percepto's per-entity
    //   visibility state. Driving it keeps everything in sync (visual
    //   checkbox state, map render). Bypassing it would desync.
    //
    // Virtualization caveat: rows not in the viewport don't exist in the
    //   DOM. We sidestep that by using SECTION-level checkboxes (always
    //   in DOM) for bulk on/off, then the search filter to bring the
    //   target into view.
    //
    // Resync caveat: Percepto resets its per-session visibility when
    //   editors close. Our `sumPanelState.visibility` reflects USER INTENT,
    //   not Percepto's current state. Re-M2 between edits as needed.
    // ============================================================

    function getSidebarDoc() {
        // Sidebar is in whichever doc has the search input.
        if (document.querySelector(SIDEBAR_INPUT_SELECTOR)) return document;
        try {
            if (window.top && window.top.document.querySelector(SIDEBAR_INPUT_SELECTOR)) return window.top.document;
            const frames = Array.from(window.top.document.querySelectorAll('iframe'));
            for (const f of frames) {
                try {
                    const d = f.contentDocument;
                    if (d && d.querySelector(SIDEBAR_INPUT_SELECTOR)) return d;
                } catch (e) {}
            }
        } catch (e) {}
        return null;
    }

    function getSidebarSections(doc) {
        if (!doc) return [];
        const out = [];
        doc.querySelectorAll('.map-entities__header-wrapper').forEach(wrap => {
            const title = (wrap.querySelector('.map-entities__type-title')?.textContent || '').trim();
            const checkbox = wrap.querySelector('.map-entities__type-checkbox input.ant-checkbox-input');
            const toggleBtn = wrap.querySelector('.map-entities__toggle-button');
            out.push({ wrap, title, checkbox, toggleBtn });
        });
        return out;
    }

    function pasteSidebarSearch(doc, text) {
        if (!doc) return false;
        const input = doc.querySelector(SIDEBAR_INPUT_SELECTOR);
        if (!input) return false;
        try {
            const proto = window.HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(input, String(text));
            else input.value = String(text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        } catch (e) { return false; }
    }

    function findSidebarItemByName(doc, name) {
        if (!doc || !name) return null;
        const lower = name.trim().toLowerCase();
        const items = doc.querySelectorAll('.map-entities__entity-item');
        for (const item of items) {
            const txt = (item.textContent || '').trim().toLowerCase();
            if (txt.includes(lower)) return item;
        }
        return items.length === 1 ? items[0] : null;
    }

    function getEntityCheckboxFromItem(item) {
        return item && item.querySelector('.map-entities__entity-checkbox input.ant-checkbox-input');
    }

    function ensurePanelVisibility(siteID) {
        if (sumPanelState.visibilitySite !== siteID) {
            sumPanelState.visibility = new Map();
            sumPanelState.visibilitySite = siteID;
        }
    }
    function isEntityVisible(entityId) {
        // Default to true (visible) — missing entries = "all on".
        const v = sumPanelState.visibility.get(entityId);
        return v === undefined ? true : !!v;
    }
    function setEntityVisible(entityId, on) {
        if (on) sumPanelState.visibility.delete(entityId);
        else sumPanelState.visibility.set(entityId, false);
    }

    // M1 toggle: search for this entity in the sidebar, click its checkbox.
    // Leaves the search filter set (per user pref).
    async function toggleEntityVisibility(entity) {
        const doc = getSidebarDoc();
        if (!doc) { showToast('Sidebar not found — open the entity panel?', 'rgba(255,96,96,0.55)'); return; }
        const ok = pasteSidebarSearch(doc, entity.name);
        if (!ok) { showToast('Could not paste into sidebar search', 'rgba(255,96,96,0.55)'); return; }
        await sleep(200);
        const item = findSidebarItemByName(doc, entity.name);
        if (!item) {
            showToast(`"${entity.name}" not in sidebar after filter`, 'rgba(255,180,0,0.55)');
            return;
        }
        const cb = getEntityCheckboxFromItem(item);
        if (!cb) { showToast('No checkbox on sidebar item', 'rgba(255,96,96,0.55)'); return; }
        try { cb.click(); } catch (e) { return; }
        const nowVisible = !isEntityVisible(entity.id);
        setEntityVisible(entity.id, nowVisible);
        showToast(`${entity.name} → ${nowVisible ? 'visible' : 'hidden'}`);
        if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
    }

    // v3.48: scroll the virtualized sidebar list to top so subsequent
    // section walks start from the first header. Walk for the inner
    // scrollable container — the .map-entities__autosizer wraps the
    // virtualized list and is the actual scroll surface in Ant.
    function scrollSidebarToTop(doc) {
        if (!doc) return;
        const candidates = doc.querySelectorAll('.map-entities__list, .map-entities__autosizer, .map-entities__virtualized-list');
        candidates.forEach(el => { try { el.scrollTop = 0; } catch (e) {} });
    }

    // v3.48: walk + act on sidebar sections REPEATEDLY until none satisfy
    // the predicate (i.e. nothing left to do). The sidebar is virtualized:
    // when sections are expanded with many children, only the top 1-2
    // section headers exist in the DOM. After unchecking + collapsing
    // those, the remaining sections come into view and we can act on
    // them. wantState='off' means uncheck + collapse; 'on' means check
    // (don't touch collapse state on the way back).
    // wantState modes:
    //   'off'           — uncheck section + collapse it (M2 solo)
    //   'on'            — check section parent (M2 unsolo, after collapse-only)
    //   'collapse-only' — JUST collapse, don't touch checkbox (used before 'on'
    //                     so 6 collapsed headers all fit in viewport before we
    //                     start checking — otherwise checking the first section
    //                     expands it and pushes the rest off-screen)
    async function walkSidebarSections(doc, wantState, maxPasses = 8) {
        let pass = 0;
        while (pass < maxPasses) {
            scrollSidebarToTop(doc);
            await sleep(25);
            const sections = getSidebarSections(doc);
            if (sections.length === 0) {
                console.log(`${TAG} walkSidebarSections(${wantState}) pass ${pass}: 0 sections in DOM — bailing`);
                break;
            }
            let didWork = false;
            const titles = [];
            for (const s of sections) {
                titles.push(s.title);
                if (wantState === 'off') {
                    if (s.checkbox && s.checkbox.checked) {
                        try { s.checkbox.click(); didWork = true; } catch (e) {}
                    }
                    if (s.toggleBtn && s.toggleBtn.getAttribute('aria-label') === 'Collapse') {
                        try { s.toggleBtn.click(); didWork = true; } catch (e) {}
                    }
                } else if (wantState === 'on') {
                    if (s.checkbox && !s.checkbox.checked) {
                        try { s.checkbox.click(); didWork = true; } catch (e) {}
                    }
                } else if (wantState === 'collapse-only') {
                    if (s.toggleBtn && s.toggleBtn.getAttribute('aria-label') === 'Collapse') {
                        try { s.toggleBtn.click(); didWork = true; } catch (e) {}
                    }
                }
                await sleep(25);
            }
            console.log(`${TAG} walkSidebarSections(${wantState}) pass ${pass}: [${titles.join(', ')}] didWork=${didWork}`);
            if (!didWork) break;
            pass++;
            // Wait for the virtualized list to re-layout (sections below
            // shift up into view as the ones above collapse).
            await sleep(120);
        }
    }

    // M2 solo: uncheck + collapse every section, then check just this one.
    async function soloEntityVisibility(entity, allEntityIds) {
        const doc = getSidebarDoc();
        if (!doc) { showToast('Sidebar not found — open the entity panel?', 'rgba(255,96,96,0.55)'); return; }
        // 1. Uncheck + collapse all sections (loops until stable to
        // handle the virtualized list — top-most sections get acted on
        // first, then their children disappear and the next sections
        // come into view).
        await walkSidebarSections(doc, 'off');
        // 2. Search + check the target
        pasteSidebarSearch(doc, entity.name);
        await sleep(220);
        const item = findSidebarItemByName(doc, entity.name);
        if (item) {
            const cb = getEntityCheckboxFromItem(item);
            if (cb && !cb.checked) { try { cb.click(); } catch (e) {} }
        } else {
            showToast(`Soloed but "${entity.name}" not visible in sidebar — check name match`, 'rgba(255,180,0,0.55)');
        }
        // 3. Update state — everyone false except this one
        sumPanelState.visibility = new Map();
        (allEntityIds || []).forEach(id => { if (id !== entity.id) sumPanelState.visibility.set(id, false); });
        showToast(`Soloed ${entity.name}`);
        if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
    }

    // M2 unsolo: check every section, clear search.
    async function unsoloAllVisibility() {
        const doc = getSidebarDoc();
        if (!doc) { showToast('Sidebar not found', 'rgba(255,96,96,0.55)'); return; }
        // Clear search first so the section headers are all in the
        // virtualized list (the search filter hides them otherwise).
        pasteSidebarSearch(doc, '');
        await sleep(120);
        // v3.49: COLLAPSE first, then CHECK. Checking a section's
        // parent checkbox while the section is collapsed auto-expands
        // it (Percepto's behavior), and the expanded section fills the
        // viewport — the next sections get pushed off the virtualized
        // list. By ensuring everything is collapsed first, the 6
        // section headers all stay in the DOM during the check pass.
        await walkSidebarSections(doc, 'collapse-only');
        await walkSidebarSections(doc, 'on');
        sumPanelState.visibility = new Map();
        showToast('All entities visible');
        if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
    }

    // ============================================================
    // Right-click handler — capture phase on window, gated to map area
    // ============================================================
    function installRightClickHandler() {
        // v3.76: opt-in debug. Set window.__aim_ai_debug = true in console
        // (or toggle below) to log every step of the right-click handler.
        // Helps triage "right-click brings up native menu" reports.
        const RIGHT_CLICK_DEBUG = false; // v3.79: now stable, default OFF. Opt-in via window.__aim_ai_debug = true.
        function dbg(...args) {
            if (RIGHT_CLICK_DEBUG || (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__aim_ai_debug) {
                try { console.log(TAG, 'RC', ...args); } catch (e) {}
            }
        }
        window.addEventListener('contextmenu', (e) => {
            if (!masterEnabled) {
                if (e.isTrusted) dbg('bail: master OFF');
                return;
            }
            // Skip synthetic events (e.isTrusted=false). The Altitude and
            // Ruler scripts dispatch synthetic 'contextmenu' as part of
            // their Pin & Clean cleanup pattern — those are meant for
            // Leaflet's internal vertex-delete handler, NOT for us.
            // Without this guard, dropping an altitude pin near an entity
            // would pop the inspector unexpectedly.
            if (!e.isTrusted) return;
            dbg('handler fired');
            const target = e.target;
            // Don't intercept inputs / editable areas — preserve native context menu there
            if (target && target.tagName) {
                const tn = target.tagName;
                if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT' || target.isContentEditable) { dbg('bail: input/editable'); return; }
                if (target.closest && target.closest('.ant-input, .ant-select')) { dbg('bail: ant-input/ant-select'); return; }
            }
            // v3.54: AIM Issues icons sit ON TOP of Percepto entities. If
            // the right-click landed on an issue marker, bail — let the
            // Issues script's marker handler open the status modal. Without
            // this, AI's capture-phase handler runs first and pops its own
            // inspector popup over an entity that happens to be beneath the
            // issue icon.
            if (target && target.closest && target.closest('.aim-issues-icon-marker')) { dbg('bail: issue marker'); return; }
            // v3.61: Don't steal right-clicks meant for UI controls. The
            // Control Panel gear, Issues 🚩, and Power ⚡ buttons all inject
            // into .map-tools and each have their own M2 (right-click)
            // action. Our capture-phase handler otherwise hit-tests the
            // entity *behind* the button by lat/lng and pops the inspector
            // instead of letting the button toggle. Bail on any toolbar
            // button / Leaflet control / generic button.
            if (target && target.closest && target.closest('.map-tools, .map-tools__button, .leaflet-control, button, .ant-btn')) { dbg('bail: toolbar/button'); return; }
            // v3.61: Power-line paths are owned by Map Styler's contextmenu
            // handler (vertex delete / hide menu in edit mode). We hit-test
            // by lat/lng, so whenever an asset/FFZ/FP polygon overlapped a
            // power line we'd steal the right-click. If the click landed on
            // a KML power-line path, bail and let Map Styler handle it.
            if (target && target.closest && target.closest('path[data-kml-type]')) { dbg('bail: kml-path'); return; }
            // v3.80: Flight-path vertex right-click is Percepto's native
            // "delete vertex" action. Before v3.78 fixed the shadowing pip
            // bug, the inspector silently missed FP polygons and the user's
            // right-click fell through to Percepto. v3.78 restored the
            // inspector — and accidentally stole the FP vertex right-click.
            // Bail when the target is a vertex marker (.map-marker__flight-path-vertex)
            // OR a segment-number badge (.map-marker__arc-index — Flight Path
            // Editor's own right-click target too). Both stay native.
            if (target && target.closest && target.closest('.map-marker__flight-path-vertex, .map-marker__arc-index')) { dbg('bail: fp-vertex/arc-index'); return; }
            const map = getLeafletMap();
            if (!map) { dbg('bail: no map (Map Styler off?)'); return; }
            const container = map.getContainer();
            // Must be a right-click inside the map's container
            if (!container.contains(target)) { dbg('bail: target not in map container — target=', target.tagName, target.className); return; }
            const siteID = getCurrentSiteID();
            if (!siteID) { dbg('bail: no siteID'); return; }
            const cRect = container.getBoundingClientRect();
            const px = e.clientX - cRect.left;
            const py = e.clientY - cRect.top;
            let latlng;
            try { latlng = map.containerPointToLatLng([px, py]); }
            catch (err) { dbg('bail: containerPointToLatLng threw', err); return; }
            if (!latlng) { dbg('bail: no latlng'); return; }
            // Lazy-fetch if not loaded yet
            if (!mapObjectsBySite[siteID] && !fetchingSites.has(siteID)) {
                fetchMapObjects(siteID);
                dbg('bail: cache empty for site', siteID, '— triggered fetch');
                showToast('Loading site entities — try right-click again in a sec', 'rgba(255,180,0,0.55)');
                return;
            }
            if (fetchingSites.has(siteID)) {
                dbg('bail: cache still fetching for site', siteID);
                showToast('Still loading…', 'rgba(255,180,0,0.55)');
                return;
            }
            const bucketSize = (mapObjectsBySite[siteID]?.entities || []).length;
            const entity = findEntityAtLatLng(latlng.lat, latlng.lng, siteID);
            if (!entity) {
                // Don't intercept — let native context menu show (user
                // right-clicked on empty map). Could toast "no entity here"
                // but that would be annoying for normal map right-clicks.
                dbg('bail: no entity at', latlng.lat.toFixed(6), latlng.lng.toFixed(6), '— bucket has', bucketSize);
                return;
            }
            dbg('HIT →', entity.name, 'type', entity.type);
            e.preventDefault();
            e.stopPropagation();
            try {
                showInspectorPopup(e.clientX, e.clientY, entity);
            } catch (err) {
                dbg('showInspectorPopup threw', err);
            }
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
            else if (msg.type === 'TOKEN_VALUE') {
                // PAT broadcast — caches in memory for shared elevation
                // cache pulls/pushes. Same pattern Map Styler + MBT use.
                const newToken = msg.token || '';
                if (newToken !== elevSharedToken) {
                    elevSharedToken = newToken;
                    if (newToken) console.log(`${TAG} GitHub PAT cached (shared elev cache push enabled)`);
                }
            }
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
    // Ask Control Panel to replay the GitHub PAT — covers the case
    // where we loaded after the panel's initial TOKEN_VALUE broadcast.
    if (controlChannel) controlChannel.postMessage({ type: 'REQUEST_TOKEN' });
    installRightClickHandler();
    installSaveInvalidator();

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
    // Source-of-truth column order — used as the default when the user
    // hasn't customized + as the upper bound when validating stored order.
    // ALL_COL_KEYS = every KNOWN column, in canonical display order.
    // DEFAULT_COL_KEYS = the subset shown by default on a fresh install.
    // The optional columns added 2026-06-10 (equipment/state/gmGroup/
    // emergAlt/segLen/unshielded/notes) are known but OFF by default —
    // they'd be mostly-blank for most rows. They surface via the Columns ▾
    // menu's "Hidden" list, or get switched on by a built-in preset.
    const ALL_COL_KEYS = ['visibility', 'typeShort', 'name', 'segId', 'subtype', 'equipment', 'state', 'gmGroup', 'altMin', 'altMax', 'emergAlt', 'altDelta', 'elevation', 'agl', 'segLen', 'route', 'validated', 'unshielded', 'notes', 'lat', 'long', 'gps'];
    const DEFAULT_COL_KEYS = ['visibility', 'typeShort', 'name', 'segId', 'subtype', 'altMin', 'altMax', 'altDelta', 'elevation', 'agl', 'validated', 'lat', 'long', 'gps'];

    // Load the persisted column order from GM storage. Falls back to the
    // default order. Filters out any unknown keys (forwards-compat with
    // older stored states that may reference dropped columns).
    function loadColumnOrder() {
        const stored = elevGmGet(CACHE_KEY_COLUMN_ORDER, null);
        if (Array.isArray(stored) && stored.length > 0) {
            const known = new Set(ALL_COL_KEYS);
            const cleaned = stored.filter(k => known.has(k));
            // MIGRATION: if ALL_COL_KEYS has new columns the user's
            // stored order doesn't know about (e.g. 'segId' added in
            // v3.28), append them in their default position so the
            // user actually SEES the new column instead of having to
            // manually toggle it on from the hidden list.
            const storedSet = new Set(cleaned);
            // Only auto-append columns that are DEFAULT-ON. Optional columns
            // (off by default) must NOT suddenly appear in an existing user's
            // view — they'd be 7 mostly-blank columns. They stay in the
            // Columns ▾ "Hidden" list until toggled on or enabled by a preset.
            const newKeys = DEFAULT_COL_KEYS.filter(k => !storedSet.has(k));
            if (cleaned.length > 0) {
                if (newKeys.length > 0) {
                    // Insert each new key right after its left neighbor
                    // in the canonical ALL_COL_KEYS order so the user's
                    // existing order is preserved + the new col lands
                    // in its intended position.
                    const out = cleaned.slice();
                    newKeys.forEach(nk => {
                        const idx = ALL_COL_KEYS.indexOf(nk);
                        let insertAt = out.length;
                        // Walk left in ALL_COL_KEYS — first existing
                        // sibling tells us where to slot in.
                        for (let i = idx - 1; i >= 0; i--) {
                            const leftK = ALL_COL_KEYS[i];
                            const pos = out.indexOf(leftK);
                            if (pos >= 0) { insertAt = pos + 1; break; }
                        }
                        out.splice(insertAt, 0, nk);
                    });
                    return out;
                }
                return cleaned;
            }
        }
        return DEFAULT_COL_KEYS.slice();
    }
    function saveColumnOrder(order) {
        elevGmSet(CACHE_KEY_COLUMN_ORDER, order);
    }
    // v3.83: per-column pixel widths the user set by dragging a header edge.
    // {colKey: px}. Absent key → fall back to the column def's default `w`.
    function loadColumnWidths() {
        const w = elevGmGet(CACHE_KEY_COLUMN_WIDTHS, {});
        return (w && typeof w === 'object' && !Array.isArray(w)) ? w : {};
    }
    function saveColWidths() {
        elevGmSet(CACHE_KEY_COLUMN_WIDTHS, sumPanelState.columnWidths || {});
    }

    // ── View presets (per-user) ─────────────────────────────────────────────
    // A preset is a saved snapshot of the SUM view: visible columns + order,
    // the type filter, the validation filters, the sort, and ft/m units.
    // Search text is intentionally NOT captured (it's transient, per-task).
    // Stored in GM storage so it survives reloads and is global across sites.
    function loadViewPresets() {
        // User-saved views only. The canonical starter views now live in
        // BUILTIN_PRESETS (read-only, always current), so there's nothing to
        // seed — a brand-new user still sees the built-ins in the menu.
        const stored = elevGmGet(CACHE_KEY_VIEW_PRESETS, null);
        return Array.isArray(stored) ? stored : [];
    }
    // v3.85: curated built-in views. Read-only / apply-only, shown above the
    // user's saved views in the Presets ▾ menu, and always current because
    // they live in code. Only the fields that DIFFER from default need to be
    // set — applyViewPreset coerces missing booleans to false and missing
    // numericFilters to {}, so applying a built-in fully (re)defines the view.
    // numericFilters are stored in METERS (90 ft ≈ 27.43 m).
    const FT_TO_M = 1 / 3.28084;
    const BUILTIN_PRESETS = [
        {
            name: 'FP Altitude Audit',
            desc: 'Every flight-path segment with the full altitude picture — lowest AGL first.',
            columnOrder: ['name', 'segId', 'altMin', 'altMax', 'emergAlt', 'altDelta', 'elevation', 'agl', 'segLen', 'validated'],
            typeFilter: ['15'], sortKey: 'aglM', sortDir: 1, unitsFt: true,
        },
        {
            name: 'AGL Safety (< 90 ft)',
            desc: 'Flight-path segments flying below 90 ft AGL — the red danger band.',
            columnOrder: ['name', 'segId', 'altMin', 'elevation', 'agl', 'segLen', 'validated'],
            typeFilter: ['15'], numericFilters: { agl: { min: null, max: 90 * FT_TO_M } },
            sortKey: 'aglM', sortDir: 1, unitsFt: true,
        },
        {
            name: 'Unvalidated Triage',
            desc: 'Everything not yet validated (FFZ / FP / NFZ), grouped by type.',
            columnOrder: ['typeShort', 'name', 'subtype', 'validated', 'notes'],
            typeFilter: ['3', '4', '15', '16', '19'], unvalidatedOnly: true,
            sortKey: 'typePrio', sortDir: 1, unitsFt: true,
        },
        {
            name: 'Asset Roster',
            desc: 'All assets with equipment, state/health, notes, elevation + coordinates.',
            columnOrder: ['name', 'subtype', 'equipment', 'state', 'notes', 'elevation', 'lat', 'long', 'gps'],
            typeFilter: ['3'], sortKey: 'name', sortDir: 1, unitsFt: true,
        },
        {
            name: 'Shielding Review',
            desc: 'FFZs + assets with shielded/unshielded status + altitudes.',
            columnOrder: ['typeShort', 'name', 'subtype', 'unshielded', 'altMin', 'altMax', 'notes'],
            typeFilter: ['16', '3'], sortKey: 'typePrio', sortDir: 1, unitsFt: true,
        },
        {
            name: 'Route from Base',
            desc: 'Assets by flight-path distance from the basestation (set the base via 📍 Base), nearest first.',
            columnOrder: ['name', 'subtype', 'equipment', 'route'],
            typeFilter: ['3'], sortKey: 'routeM', sortDir: 1, unitsFt: true,
        },
        {
            name: 'GMs · Name/Lat/Long',
            desc: 'General markers with coordinates — for Copy → Sheets.',
            columnOrder: ['name', 'lat', 'long'],
            typeFilter: ['19'], sortKey: 'name', sortDir: 1, unitsFt: true,
        },
    ];
    function saveViewPresets(arr) {
        elevGmSet(CACHE_KEY_VIEW_PRESETS, arr);
    }

    // ---- v3.87 (Phase 2): cross-preset export ----
    // Copy ANY preset's table (its columns + filters) to the clipboard,
    // Sheets-ready, WITHOUT switching the live view — so the user can pull
    // several field-sets in a row. Built standalone (the live table's column
    // defs live inside redrawTable's closure).
    function presetToFilterState(p) {
        return {
            search: '',
            typeFilter: new Set((Array.isArray(p.typeFilter) ? p.typeFilter : ['3', '4', '15', '16', '19']).map(String)),
            validatedOnly: !!p.validatedOnly,
            unvalidatedOnly: !!p.unvalidatedOnly,
            unshieldedOnly: !!p.unshieldedOnly,
            notesOnly: !!p.notesOnly,
            numericFilters: (p.numericFilters && typeof p.numericFilters === 'object') ? p.numericFilters : {},
            sortKey: p.sortKey || 'typePrio',
            sortDir: (p.sortDir === 1 || p.sortDir === -1) ? p.sortDir : 1,
        };
    }
    // Column label + value-extractor registry for export. unitsFt controls the
    // altitude/distance m→ft conversion + the (ft|m) label suffix.
    function exportColumnDefs(columnKeys, unitsFt) {
        const u = unitsFt ? 'ft' : 'm';
        const num = (m) => m == null ? '' : (unitsFt ? Math.round(m * 3.28084).toString() : m.toFixed(1));
        const reg = {
            visibility: { label: 'Visibility', val: () => '' },
            typeShort: { label: 'Type', val: r => r.typeShort || '' },
            name: { label: 'Name', val: r => r.name || '' },
            segId: { label: 'Seg ID', val: r => r._segId != null ? String(r._segId) : '' },
            subtype: { label: 'Subtype', val: r => r.subtype || '' },
            equipment: { label: 'Equipment', val: r => r.equipment || '' },
            state: { label: 'State', val: r => r.state || '' },
            gmGroup: { label: 'GM Group', val: r => r.gmGroup || '' },
            altMin: { label: `Min Alt (${u})`, val: r => num(r.altMinM) },
            altMax: { label: `Max Alt (${u})`, val: r => num(r.altMaxM) },
            emergAlt: { label: `Emerg Alt (${u})`, val: r => num(r.emergAltM) },
            altDelta: { label: `Delta (${u})`, val: r => num(r.altDeltaM) },
            elevation: { label: `Elevation (${u})`, val: r => num(r.elevationM) },
            agl: { label: `AGL (${u})`, val: r => num(r.aglM) },
            segLen: { label: `Seg Len (${u})`, val: r => num(r.segLenM) },
            route: { label: `Route (${u})`, val: r => num(r.routeM) },
            validated: { label: 'Valid', val: r => r.validated === true ? 'yes' : (r.validated === false ? 'no' : '') },
            unshielded: { label: 'Unshielded', val: r => r.unshielded ? 'yes' : ((r.type === 16 || r.type === 3) ? 'no' : '') },
            notes: { label: 'Notes', val: r => r.notesText || '' },
            lat: { label: 'Lat', val: r => r._lat != null ? r._lat.toFixed(6) : '' },
            long: { label: 'Long', val: r => r._lng != null ? r._lng.toFixed(6) : '' },
            gps: { label: 'GPS', val: r => r._lat != null ? `https://www.google.com/maps?q=${r._lat},${r._lng}` : '' },
        };
        return (columnKeys || []).map(k => reg[k]).filter(Boolean);
    }
    const exportHtmlEscape = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Build {html, text, count} for one preset against the given row set.
    function buildPresetExport(p, allRows) {
        const rows = filterAndSortRows(allRows, presetToFilterState(p));
        const cols = exportColumnDefs(p.columnOrder, typeof p.unitsFt === 'boolean' ? p.unitsFt : true);
        const headHtml = '<tr>' + cols.map(c => `<th style="background:#1f2933;color:#ffffff;border:1px solid #888888;padding:3px 7px;text-align:left;font-weight:bold">${exportHtmlEscape(c.label)}</th>`).join('') + '</tr>';
        const bodyHtml = rows.map(r => '<tr>' + cols.map(c => `<td style="border:1px solid #cccccc;padding:2px 7px">${exportHtmlEscape(c.val(r))}</td>`).join('') + '</tr>').join('');
        const html = `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">${headHtml}${bodyHtml}</table>`;
        const text = [cols.map(c => c.label).join('\t')]
            .concat(rows.map(r => cols.map(c => String(c.val(r)).replace(/[\t\n\r]/g, ' ')).join('\t')))
            .join('\n');
        return { html, text, count: rows.length };
    }
    // Generic rich-clipboard writer (text/html + text/plain) — mirrors
    // copyStatsAsSheet's path.
    async function writeSheetsClipboard(html, text, toastMsg) {
        try {
            if (navigator.clipboard && window.ClipboardItem) {
                const item = new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([text], { type: 'text/plain' }),
                });
                await navigator.clipboard.write([item]);
                showToast(toastMsg);
                return;
            }
        } catch (e) {
            console.warn(`${TAG} export ClipboardItem write failed, falling back:`, e);
        }
        try {
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            tmp.style.cssText = 'position:fixed;top:-9999px;opacity:0';
            document.body.appendChild(tmp);
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(tmp);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('copy');
            sel.removeAllRanges();
            document.body.removeChild(tmp);
            showToast(toastMsg);
        } catch (e) {
            console.error(`${TAG} export Sheets fallback failed:`, e);
            copyToClipboard(text, 'Copied as plain text (HTML copy unavailable)');
        }
    }
    function allExportPresets() {
        return BUILTIN_PRESETS.concat(loadViewPresets());
    }

    // Snapshot the live SUM state into a plain preset object (sans name).
    function captureCurrentView() {
        return {
            columnOrder: sumPanelState.columnOrder.slice(),
            typeFilter: Array.from(sumPanelState.typeFilter),
            validatedOnly: sumPanelState.validatedOnly,
            unvalidatedOnly: sumPanelState.unvalidatedOnly,
            unshieldedOnly: sumPanelState.unshieldedOnly,
            notesOnly: sumPanelState.notesOnly,
            numericFilters: JSON.parse(JSON.stringify(sumPanelState.numericFilters || {})),
            sortKey: sumPanelState.sortKey,
            sortDir: sumPanelState.sortDir,
            unitsFt: sumPanelState.unitsFt,
        };
    }
    // Apply a preset to the live state and re-render the whole panel (which
    // rebuilds every toolbar control from sumPanelState, so chips/checkboxes/
    // sort indicators all reflect the preset). Drag position is preserved.
    function applyViewPreset(p, siteID) {
        if (!p) return;
        if (Array.isArray(p.columnOrder) && p.columnOrder.length) {
            sumPanelState.columnOrder = p.columnOrder.filter(k => ALL_COL_KEYS.includes(k));
            saveColumnOrder(sumPanelState.columnOrder);
        }
        if (Array.isArray(p.typeFilter)) sumPanelState.typeFilter = new Set(p.typeFilter.map(String));
        sumPanelState.validatedOnly = !!p.validatedOnly;
        sumPanelState.unvalidatedOnly = !!p.unvalidatedOnly;
        sumPanelState.unshieldedOnly = !!p.unshieldedOnly;
        sumPanelState.notesOnly = !!p.notesOnly;
        sumPanelState.numericFilters = (p.numericFilters && typeof p.numericFilters === 'object' && !Array.isArray(p.numericFilters))
            ? JSON.parse(JSON.stringify(p.numericFilters)) : {};
        if (p.sortKey) sumPanelState.sortKey = p.sortKey;
        if (p.sortDir === 1 || p.sortDir === -1) sumPanelState.sortDir = p.sortDir;
        if (typeof p.unitsFt === 'boolean') sumPanelState.unitsFt = p.unitsFt;
        renderSummaryPanel(siteID);
    }
    // Reset to the out-of-box view: all columns, all types, no filters,
    // default type-grouped sort, feet, no search.
    function resetToDefaultView(siteID) {
        sumPanelState.columnOrder = DEFAULT_COL_KEYS.slice();
        saveColumnOrder(sumPanelState.columnOrder);
        sumPanelState.columnWidths = {};
        saveColWidths();
        sumPanelState.typeFilter = new Set(['3', '4', '15', '16', '19']);
        sumPanelState.validatedOnly = false;
        sumPanelState.unvalidatedOnly = false;
        sumPanelState.unshieldedOnly = false;
        sumPanelState.notesOnly = false;
        sumPanelState.numericFilters = {};
        sumPanelState.sortKey = 'typePrio';
        sumPanelState.sortDir = 1;
        sumPanelState.unitsFt = true;
        sumPanelState.search = '';
        renderSummaryPanel(siteID);
    }

    // ============================================================
    // Pending segment-altitude edits (v3.16 phase 1 — queue only).
    //
    // In-memory store keyed by `${entityId}:${arcId}:${field}` so each
    // segment can have one pending Min edit + one pending Max edit
    // independently. Cleared when the site changes (rowKeys would no
    // longer match the loaded entity set) or via Discard All. Survives
    // closing the panel so the user doesn't lose work on accidental
    // close — matches the MBT pendingAltitudes pattern.
    //
    // v3.17 will add the "Apply" path that drives Percepto's entity
    // editor for each pending edit. Phase 1 ships queue + clipboard
    // export only so the user gets the planning value immediately.
    // ============================================================
    const pendingSegmentEdits = {};
    let pendingEditsSite = null;     // siteID the edits belong to
    // Key shape: `${entityId}:${arcId|''}:${field}`. FFZ entity-level
    // edits (and any future entity-level edit type) use arcId=null which
    // serialises to ''. Segment edits use the arc ID. The empty-string
    // form keeps FFZ vs first-arc-of-FP from colliding because their
    // entity IDs are disjoint per Percepto's data model anyway.
    function pendingEditKey(entityId, arcId, field) {
        return `${entityId}:${arcId == null ? '' : arcId}:${field}`;
    }
    function getPendingEdit(entityId, arcId, field) {
        return pendingSegmentEdits[pendingEditKey(entityId, arcId, field)];
    }
    function queuePendingEdit(entry) {
        pendingSegmentEdits[pendingEditKey(entry.entityId, entry.arcId, entry.field)] = entry;
    }
    function discardPendingEdit(entityId, arcId, field) {
        delete pendingSegmentEdits[pendingEditKey(entityId, arcId, field)];
    }
    function clearAllPendingEdits() {
        Object.keys(pendingSegmentEdits).forEach(k => delete pendingSegmentEdits[k]);
    }
    function pendingEditCount() {
        return Object.keys(pendingSegmentEdits).length;
    }
    function ensurePendingForSite(siteID) {
        if (pendingEditsSite !== siteID) {
            if (pendingEditCount() > 0) {
                console.log(`${TAG} site changed (${pendingEditsSite} → ${siteID}) — clearing ${pendingEditCount()} pending edits`);
            }
            clearAllPendingEdits();
            pendingEditsSite = siteID;
        }
    }

    // Computes the EFFECTIVE values for a row, honoring any pending
    // min_alt / max_alt edits in the queue. Used by every renderer that
    // shows derived data (Delta, AGL) so a queued Min edit reflects
    // immediately on those derived cells in yellow. Returns flags so
    // the cell renderer knows whether to paint pending state.
    function effectiveValues(r) {
        let effMin = r.altMinM;
        let effMax = r.altMaxM;
        let minP = null, maxP = null;
        // FP segments key by arcId; FFZ entities key by arcId=null
        // (entity-level edit). Other types are not currently editable.
        if (r._isSegment && r.arc) {
            minP = getPendingEdit(r.entity.id, r.arc.id, 'min_alt');
            maxP = getPendingEdit(r.entity.id, r.arc.id, 'max_alt');
        } else if (r.type === 16 && r.entity) {
            minP = getPendingEdit(r.entity.id, null, 'min_alt');
            maxP = getPendingEdit(r.entity.id, null, 'max_alt');
        }
        if (minP) effMin = minP.newValueM;
        if (maxP) effMax = maxP.newValueM;
        const effDelta = (effMin != null && effMax != null) ? (effMax - effMin) : null;
        const effAgl = (effMin != null && r.elevationM != null) ? (effMin - r.elevationM) : null;
        return {
            effMin, effMax, effDelta, effAgl,
            minPending: !!minP, maxPending: !!maxP,
            // A derived cell is "pending" when its inputs changed.
            deltaPending: !!(minP || maxP),
            aglPending: !!minP,
        };
    }

    // Returns true if the row supports inline editing of Min/Max/AGL
    // through the pending-edits queue. FP segments and FFZ entities
    // qualify; assets/NFZs/markers do not (different Percepto editor
    // surface, deferred to a future version).
    function isEditableRow(r) {
        if (!r || !r.entity) return false;
        if (r._isSegment && r.arc) return true;
        if (r.type === 16) return true;
        return false;
    }

    // v3.41: assets are editable for SUBTYPE only via a separate
    // Percepto editor path (Ant Select dropdown with creatable input,
    // not number inputs). Branches off in startInlineSubtypeEdit +
    // applyAssetSubtypeChange.
    function isAssetEditableForSubtype(r) {
        return !!(r && r.type === 3 && r.entity);
    }

    // Distinct subtype strings currently observed across all loaded
    // assets on the given site. Used to populate the inline editor's
    // datalist (autocomplete) AND to decide whether a queued subtype
    // is "existing" (just-select in the Percepto dropdown) or "new"
    // (needs the "Enter new type" + Add path during apply).
    function observedSubtypesForSite(siteID) {
        const bucket = siteID ? mapObjectsBySite[siteID] : null;
        if (!bucket) return [];
        const set = new Set();
        (bucket.entities || []).forEach(en => {
            if (en.type === 3 && en.custom && en.custom.poi_type_str) {
                const s = String(en.custom.poi_type_str).trim();
                if (s) set.add(s);
            }
        });
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }

    // Queue entry for subtype changes. arcId=null, field='subtype'.
    // Stores plain strings rather than meter values; the Apply pipeline
    // branches on field === 'subtype' to use the Ant Select path.
    function getPendingSubtype(entityId) {
        return getPendingEdit(entityId, null, 'subtype');
    }
    function queueSubtypeEdit(entity, newValueRaw) {
        if (!entity || entity.type !== 3) return false;
        const newValue = String(newValueRaw || '').trim();
        if (!newValue) return false;
        const current = (entity.custom && entity.custom.poi_type_str) || '';
        if (newValue === current) {
            // No-op — if there was a pending edit for this entity,
            // clear it (user typed back to original).
            if (getPendingSubtype(entity.id)) {
                discardPendingEdit(entity.id, null, 'subtype');
                return false;
            }
            return false;
        }
        const siteID = getCurrentSiteID();
        const observed = new Set(observedSubtypesForSite(siteID));
        queuePendingEdit({
            entityId: entity.id,
            arcId: null,
            arcIndex: null,
            isFfz: false,
            isAsset: true,
            field: 'subtype',
            oldValue: current,
            newValue,
            isNewSubtype: !observed.has(newValue),
            // For grouping + display. Mirrors fpName for FP/FFZ edits.
            fpName: entity.name || '(unnamed)',
            entityName: entity.name || '(unnamed)',
            segmentName: entity.name || '(unnamed)',
        });
        return true;
    }

    // v3.50: name editing for all non-segment entity rows.
    function getPendingName(entityId) {
        return getPendingEdit(entityId, null, 'name');
    }
    function queueNameEdit(entity, newRaw) {
        if (!entity) return false;
        const newValue = String(newRaw || '').trim();
        if (!newValue) return false;
        // v3.55: trim entity.name too — Percepto data sometimes has trailing
        // whitespace. Without this trim, newValue ("Tank 14B") didn't match
        // current ("Tank 14B ") and the cell queued a phantom rename to the
        // same visible value (strikethrough original + same value in yellow,
        // with no way to undo just that one edit in the middle of a batch).
        const current = (entity.name || '').trim();
        if (newValue === current) {
            if (getPendingName(entity.id)) {
                discardPendingEdit(entity.id, null, 'name');
                return false;
            }
            return false;
        }
        queuePendingEdit({
            entityId: entity.id,
            arcId: null,
            arcIndex: null,
            isFfz: entity.type === 16,
            isAsset: entity.type === 3,
            field: 'name',
            oldValue: current,
            newValue,
            // For Apply pipeline lookup + display. Mirrors fpName/segmentName
            // shape from FP/FFZ edits — uses the CURRENT name so sidebar
            // lookups succeed (Percepto's data hasn't been renamed yet).
            fpName: current,
            entityName: current,
            segmentName: current,
        });
        return true;
    }
    function effectiveName(entity) {
        const orig = (entity && entity.name) || '';
        if (!entity) return { value: orig, pending: false };
        const p = getPendingName(entity.id);
        if (!p) return { value: orig, pending: false };
        return { value: p.newValue, pending: true, oldValue: orig };
    }

    // Returns the EFFECTIVE subtype value for an entity, honoring any
    // pending edit. { value, pending, isNew } — pending=true means a
    // queued subtype edit overrides the original; isNew=true means the
    // queued value isn't yet in the existing dropdown list.
    function effectiveSubtype(entity) {
        const orig = (entity && entity.custom && entity.custom.poi_type_str) || '';
        if (!entity) return { value: orig, pending: false, isNew: false };
        const p = getPendingSubtype(entity.id);
        if (!p) return { value: orig, pending: false, isNew: false };
        return { value: p.newValue, pending: true, isNew: !!p.isNewSubtype, oldValue: orig };
    }
    // Helper: pull the arcId for the queue entry shape (null for FFZ).
    function rowArcId(r) {
        return (r._isSegment && r.arc) ? r.arc.id : null;
    }
    // True for FFZ entity rows (used for "isFfz" flag in queue entries
    // + commit-order sequencing in v3.19 — FFZs apply BEFORE FP segs
    // because AIM's overlap/steepness safety checks block FP saves
    // when there's no FFZ to anchor the endpoints).
    function isFfzRow(r) {
        return !!(r && r.type === 16);
    }

    // Helper used by both inline AGL edit + bulk AGL apply. Given a
    // target AGL (in meters) for a segment row, computes the new Min
    // Alt = elevation + AGL and queues it as a min_alt pending edit.
    // Returns true if the edit was queued, false if no-op or invalid.
    function queueMinForAgl(row, targetAglM) {
        if (!isEditableRow(row)) return false;
        if (row.elevationM == null) return false;
        if (!isFinite(targetAglM)) return false;
        const newMinM = row.elevationM + targetAglM;
        return queueAltEdit(row, 'min_alt', newMinM);
    }

    // Generic min/max queue helper. Handles FP-segment + FFZ rows.
    // Compares in display units to avoid sub-foot float drift, clears
    // any prior pending edit if the new value equals the original, and
    // stores the rounded value in meters (the queue can be re-displayed
    // in either unit without further drift).
    function queueAltEdit(row, field, newValueM) {
        if (!isEditableRow(row)) return false;
        if (!isFinite(newValueM)) return false;
        const useFt = !!sumPanelState.unitsFt;
        const currentM = field === 'min_alt' ? row.altMinM : row.altMaxM;
        if (currentM == null) return false;
        const arcId = rowArcId(row);
        const newDisp = useFt ? Math.round(newValueM * 3.28084) : Number(newValueM.toFixed(1));
        const curDisp = useFt ? Math.round(currentM * 3.28084) : Number(currentM.toFixed(1));
        if (newDisp === curDisp) {
            if (getPendingEdit(row.entity.id, arcId, field)) {
                discardPendingEdit(row.entity.id, arcId, field);
            }
            return false;
        }
        const quantizedM = useFt ? newDisp / 3.28084 : newDisp;
        queuePendingEdit({
            entityId: row.entity.id,
            arcId,
            // CRITICAL: arcIndex is the stable identifier for FP
            // segments. Percepto regenerates arc IDs on save, so
            // matching by arcId post-save would fail. arcIndex
            // (position in entity.arcs) survives saves.
            arcIndex: row._isSegment ? row._arcIndex : null,
            isFfz: isFfzRow(row),
            field,
            oldValueM: currentM,
            newValueM: quantizedM,
            segmentName: row.name,
            fpName: row.entity.name || '',
        });
        return true;
    }

    // Parse a number OR a math formula (e.g. "2974+15", "(2974+15)*2").
    // Strips any non-math chars before eval — only digits, dot, +, -,
    // *, /, parens, spaces allowed. Same impl as MBT.
    function parseFormulaValue(s) {
        if (s == null) return NaN;
        const trimmed = String(s).trim().replace(/^=/, ''); // tolerate leading "="
        if (!trimmed) return NaN;
        if (/[+\-*/()]/.test(trimmed)) {
            const clean = trimmed.replace(/[^0-9.+\-*/()\s]/g, '');
            if (!clean) return NaN;
            try {
                const result = Function(`"use strict"; return (${clean})`)();
                return Number(result);
            } catch (e) { return NaN; }
        }
        return Number(trimmed);
    }

    // ============================================================
    // APPLY QUEUE — automated commit of pending edits (v3.22)
    //
    // Drives Percepto's entity edit dialog for each pending edit by:
    //   1. Grouping queue by entity (one editor open per entity, not
    //      one per edit — an FP with 6 queued segments is one save).
    //   2. Sorting groups FFZ-FIRST, then FP — matches AIM's safety
    //      check order (FFZ endpoints must already be in place before
    //      FP saves don't trip the overlap/steepness validators).
    //   3. For each group, asynchronously: find entity in sidebar,
    //      click to select, wait for `.upsert-entity` panel, populate
    //      Min/Max inputs via React-aware setter, click Save, wait
    //      for confirm modal, click confirm, wait for editor to
    //      close. Conservative ~800-2000 ms delays between steps.
    //   4. Per-entity error handling: timeout, missing input, save
    //      failure all log + skip to next instead of stalling. Final
    //      report shows successes / skipped / errors.
    //
    // Patterns lifted from AIM_Bulk_Altitude_Updater.user.js — that
    // script proves this DOM approach works on Percepto's current UI.
    // ============================================================

    // Scan TOP + iframe(s) for elements matching a selector. Returns
    // an array of { el, doc } so callers can dispatch events from
    // the correct document context.
    function scanAllDocs(selector, textSearch = '') {
        const results = [];
        function recurse(win) {
            try {
                const doc = win.document;
                let els = Array.from(doc.querySelectorAll(selector));
                if (textSearch) {
                    els = els.filter(el => el.textContent.toLowerCase().includes(textSearch.toLowerCase()));
                }
                els.forEach(el => results.push({ el, doc }));
                const frames = doc.querySelectorAll('iframe');
                frames.forEach(f => { if (f.contentWindow) recurse(f.contentWindow); });
            } catch (e) { /* cross-origin frame — skip */ }
        }
        recurse(window);
        try { if (window.top && window.top !== window) recurse(window.top); } catch (e) {}
        return results;
    }

    function clickElDispatch(el, doc) {
        if (!el) return;
        const opts = { bubbles: true, cancelable: true, view: doc.defaultView || window };
        ['mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
    }

    // React-aware value setter — bypasses React's synthetic event
    // system so setting input.value actually registers in state.
    function setReactInputValue(input, value) {
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    }

    // Helper — wait until the predicate returns truthy or we hit the
    // timeout. Returns a Promise that resolves to the predicate value
    // (or null on timeout). Polls every 200 ms.
    function waitForCondition(predicate, timeoutMs = 8000, pollMs = 200) {
        const startedAt = Date.now();
        return new Promise(resolve => {
            const tick = () => {
                let v = null;
                try { v = predicate(); } catch (e) {}
                if (v) return resolve(v);
                if (Date.now() - startedAt >= timeoutMs) return resolve(null);
                setTimeout(tick, pollMs);
            };
            tick();
        });
    }
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Locate the editor panel currently open. Returns { panel, doc }
    // or null. Multiple panels can race during transitions — we take
    // the LAST one (most-recently opened) for stability.
    function findOpenEditor() {
        const panels = scanAllDocs('.upsert-entity');
        if (panels.length === 0) return null;
        return panels[panels.length - 1];
    }

    // Read the entity name from the open editor. Current Percepto stores
    // it in `#upsert-entity-form-name` (an `<input>`), not in a title
    // element. We fall back to a couple of older selectors in case the
    // markup shifts back.
    function getEditorTitle(panelDoc) {
        const nameInput = panelDoc.querySelector('#upsert-entity-form-name');
        if (nameInput && typeof nameInput.value === 'string' && nameInput.value.trim()) {
            return nameInput.value.trim();
        }
        const t = panelDoc.querySelector('.upsert-entity__title')
            || panelDoc.querySelector('.site-setup-header__title');
        return t ? (t.textContent || '').trim() : '';
    }
    // True iff an editor panel is open AND it actually has a populated
    // name input. Filters out half-rendered editor shells that may
    // exist during transition frames.
    function findOpenEditorWithName() {
        const panels = scanAllDocs('.upsert-entity');
        for (let i = panels.length - 1; i >= 0; i--) {
            const t = getEditorTitle(panels[i].doc);
            if (t) return panels[i];
        }
        return null;
    }

    // Find the FP-segment Min/Max inputs in the editor. Returns
    // { minInputs, maxInputs } arrays indexed by table-row order
    // (which corresponds to arc order in Percepto's UI). For FFZ
    // there's only one set of inputs (entity-level) — falls back
    // to label-text matching when the table layout isn't present.
    function findEditorInputs(panelDoc) {
        const minInputs = [], maxInputs = [];
        const tableRows = panelDoc.querySelectorAll('.flight-path-form-content__table-row');
        if (tableRows.length > 0) {
            tableRows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 3) {
                    const mn = cells[1].querySelector('input.ant-input-number-input');
                    const mx = cells[2].querySelector('input.ant-input-number-input');
                    if (mn) minInputs.push(mn);
                    if (mx) maxInputs.push(mx);
                }
            });
            return { minInputs, maxInputs };
        }
        // FFZ path — find by label. BULLETPROOF: explicitly exclude
        // "emergency" / "emerg" from Min/Max matches. Without this, the
        // "Minimum emergency altitude" label also matched "min + alt"
        // and ended up in minInputs[1] (harmless in v3.23 since we only
        // write to index 0, but a risk if Percepto ever reorders the
        // inputs).
        Array.from(panelDoc.querySelectorAll('label')).forEach(label => {
            const txt = (label.textContent || '').toLowerCase();
            if (txt.includes('emergency') || txt.includes('emerg')) return;
            const isMin = txt.includes('min') && (txt.includes('alt') || txt.includes('elev'));
            const isMax = txt.includes('max') && (txt.includes('alt') || txt.includes('elev'));
            if (!isMin && !isMax) return;
            let input = label.getAttribute('for') ? panelDoc.getElementById(label.getAttribute('for')) : null;
            if (!input) input = (label.closest('.ant-form-item') || label.parentElement)
                .querySelector('input.ant-input-number-input, input.ant-input, input[type="number"]');
            if (input) {
                if (isMin) minInputs.push(input);
                if (isMax) maxInputs.push(input);
            }
        });
        return { minInputs, maxInputs };
    }

    // Find an entity in the Map Entities sidebar by name. The
    // SIDEBAR_ITEM_SELECTORS list tries multiple known class shapes
    // (Percepto has gone through a few). The first that matches
    // anything is used for the whole search.
    const SIDEBAR_ITEM_SELECTORS = [
        '.map-entities__entity-item',
        '.map-entities__entity',
        '.map-entities__list-item',
        '.map-entities .entity-item',
    ];
    function findSidebarItems() {
        for (const sel of SIDEBAR_ITEM_SELECTORS) {
            const hits = scanAllDocs(sel);
            if (hits.length > 0) return hits;
        }
        return [];
    }
    function getSidebarItemName(item) {
        // Try the inner name span class; fall back to the item's own
        // text content (trimmed) if the inner selector misses.
        const nm = item.el.querySelector('.map-entities__entity-name')
            || item.el.querySelector('.entity-name')
            || item.el.querySelector('[class*="entity-name"]');
        if (nm && nm.textContent) return nm.textContent.trim();
        return (item.el.textContent || '').trim();
    }
    // v3.45: renamed from findEntityInSidebar — the popup's "Find in
    // Map Entities" button has its OWN findEntityInSidebar(entity) at
    // line ~1254 that pastes the name into the sidebar search input.
    // The duplicate name meant the popup call dispatched here (because
    // function declarations get hoisted, last-wins) and the apply path
    // was getting called with an entity object instead of a name string.
    // v3.51: switched from virtualized-list scroll walking to a search-
    // based lookup. The scroll walk had a cap (~30 viewport-heights) and
    // missed entities below it — explains why 3 of 4 queued asset edits
    // failed: only the first asset's row was in initial viewport range,
    // the rest were past the scrollLimit. The sidebar search input
    // filters the list down to just our target, which always brings it
    // into the (small) visible viewport regardless of the original
    // position. Same shape returned as before: { el, doc } or null.
    async function findAndClickSidebarItem(name, _scrollLimit) {
        const matchLower = (name || '').trim().toLowerCase();
        if (!matchLower) return null;

        // Find the sidebar search input in whichever doc has it.
        let inputDoc = null, input = null;
        const docs = [document];
        try { if (window.top && window.top !== window) docs.push(window.top.document); } catch (e) {}
        for (const d of docs) {
            const i = d.querySelector(SIDEBAR_INPUT_SELECTOR);
            if (i) { inputDoc = d; input = i; break; }
        }
        if (!input) {
            try {
                const frames = Array.from(window.top.document.querySelectorAll('iframe'));
                for (const f of frames) {
                    try {
                        const d = f.contentDocument;
                        const i = d && d.querySelector(SIDEBAR_INPUT_SELECTOR);
                        if (i) { inputDoc = d; input = i; break; }
                    } catch (e) {}
                }
            } catch (e) {}
        }
        if (!input || !inputDoc) {
            console.warn(`${TAG} apply: sidebar search input not found via "${SIDEBAR_INPUT_SELECTOR}"`);
            return null;
        }

        // Paste the name via React-aware value setter so React's onChange fires.
        // v3.57: paste the TRIMMED name. Percepto data sometimes has trailing
        // whitespace baked into entity names; if Percepto's filter doesn't
        // trim the query, the search returns no matches and Apply fails with
        // "not found in sidebar" or "wrong entity in editor". This matches
        // the trim we already do in matchLower below.
        const nameTrimmed = (name || '').trim();
        try {
            const proto = window.HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(input, nameTrimmed);
            else input.value = nameTrimmed;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
            console.warn(`${TAG} apply: failed to paste search:`, e);
            return null;
        }

        // Wait for the filter to apply, then find the matching item.
        // v3.62: EXACT name match wins. The old code took the first row whose
        // full text merely *included* the query — so searching "freezone_2"
        // could grab "freezone_21" (or any longer name sharing the prefix),
        // open the wrong entity, and trip the name-mismatch guard → red toast.
        // We now compare against each row's inner NAME span (not the whole
        // row text, which also carries subtype/altitude badges), pick the
        // exact match, and only fall back to "the single remaining row" when
        // the filter narrowed to exactly one. No substring guessing.
        const itemNameLower = (item) => {
            const nm = item.querySelector('.map-entities__entity-name')
                || item.querySelector('.entity-name')
                || item.querySelector('[class*="entity-name"]');
            return (((nm && nm.textContent) || item.textContent || '').trim().toLowerCase());
        };
        const matched = await waitForCondition(() => {
            const items = inputDoc.querySelectorAll('.map-entities__entity-item');
            if (items.length === 0) return null;
            // 1. Exact name match — the only safe choice when names share a prefix.
            for (const item of items) {
                if (itemNameLower(item) === matchLower) return { el: item, doc: inputDoc };
            }
            // 2. Filter narrowed to a single row — unambiguous, take it (covers
            //    minor name-extraction differences like a trailing badge).
            if (items.length === 1) return { el: items[0], doc: inputDoc };
            // 3. Multiple rows, none exact yet — keep waiting; the filter may
            //    still be settling. Never fall back to a substring pick.
            return null;
        }, 2000, 100);

        if (!matched) {
            console.warn(`${TAG} apply: "${name}" not in filtered sidebar after 2s`);
        }
        return matched;
    }

    // Close any open editor by clicking its Cancel button — used to
    // reset state if a previous entity left the editor open or if
    // we landed in the wrong one.
    async function closeEditor() {
        const ed = findOpenEditor();
        if (!ed) return true;
        const cancel = ed.doc.querySelector('.upsert-entity__cancel-button');
        if (cancel) {
            clickElDispatch(cancel, ed.doc);
            await waitForCondition(() => !findOpenEditor(), 4000, 200);
        }
        return !findOpenEditor();
    }

    // Save the current editor — clicks Save, then handles the
    // confirmation modal if one appears (.ant-btn-primary with
    // "Save" text, last visible). Waits for editor to close.
    async function saveCurrentEditor() {
        const ed = findOpenEditor();
        if (!ed) return false;
        const save = ed.doc.querySelector('.upsert-entity__save-button')
            || Array.from(ed.doc.querySelectorAll('button')).find(b => /save/i.test(b.textContent || ''));
        if (!save) return false;
        clickElDispatch(save, ed.doc);
        // Confirm modal — appears for some entity types. Click the
        // LAST primary button matching "save" (modals nest behind
        // earlier ones; last is foremost).
        await sleep(800);
        const confirmBtns = scanAllDocs('button.ant-btn-primary').filter(it => /save/i.test(it.el.textContent || ''));
        if (confirmBtns.length > 0) {
            const last = confirmBtns[confirmBtns.length - 1];
            clickElDispatch(last.el, last.doc);
        }
        // Wait for editor to vanish — that's our "save succeeded" signal.
        // 15s tolerates slow networks + heavy entities (FPs with many
        // segments take ~3-4s to save on a busy site).
        const closed = await waitForCondition(() => !findOpenEditor(), 15000, 250);
        return !!closed;
    }

    // Look for Percepto validation toasts that appear when a save is
    // rejected. Currently checked: ant-message-error (toast), and
    // ant-notification-notice with error icon. Returns the first
    // error text found, or null if none.
    function findValidationError() {
        const messageErrs = scanAllDocs('.ant-message-error');
        if (messageErrs.length > 0) {
            const txt = (messageErrs[0].el.textContent || '').trim();
            if (txt) return txt;
        }
        const noticeErrs = scanAllDocs('.ant-notification-notice-error');
        if (noticeErrs.length > 0) {
            const txt = (noticeErrs[0].el.textContent || '').trim();
            if (txt) return txt;
        }
        // Inline form-field errors — flag the first one we find.
        const fieldErrs = scanAllDocs('.ant-form-item-explain-error');
        if (fieldErrs.length > 0) {
            const txt = (fieldErrs[0].el.textContent || '').trim();
            if (txt) return txt;
        }
        return null;
    }

    // Apply pipeline state. Held in module scope so the UI can poll
    // for status updates + the abort flag works mid-flight.
    const applyState = {
        running: false,
        aborted: false,
        total: 0,
        done: 0,
        errors: [],          // [{entityName, reason}, ...]
        currentLabel: '',
    };

    // Group the pending queue by entity. Returns an array of:
    //   { entityName, entityId, isFfz, edits: [pendingEntry, ...] }
    // FFZ groups come first, then FP groups. Sort within groups by
    // arc id so segment edits run in deterministic order.
    function groupPendingByEntity() {
        const byKey = new Map();
        Object.values(pendingSegmentEdits).forEach(e => {
            const kind = e.isAsset ? 'ast' : (e.isFfz ? 'ffz' : 'fp');
            const key = `${kind}:${e.entityId}`;
            if (!byKey.has(key)) {
                byKey.set(key, {
                    entityName: e.entityName || e.fpName || '',
                    entityId: e.entityId,
                    isFfz: !!e.isFfz,
                    isAsset: !!e.isAsset,
                    edits: [],
                });
            }
            byKey.get(key).edits.push(e);
        });
        const groups = Array.from(byKey.values());
        groups.forEach(g => {
            g.edits.sort((a, b) => {
                const ra = a.arcId == null ? -1 : a.arcId;
                const rb = b.arcId == null ? -1 : b.arcId;
                return ra - rb;
            });
        });
        // Order: FFZs first (FP altitude safety), then FPs, then Assets
        // (subtype changes). Within each kind, alpha by entity name.
        groups.sort((a, b) => {
            const aRank = a.isFfz ? 0 : a.isAsset ? 2 : 1;
            const bRank = b.isFfz ? 0 : b.isAsset ? 2 : 1;
            if (aRank !== bRank) return aRank - bRank;
            return String(a.entityName).localeCompare(String(b.entityName));
        });
        return groups;
    }

    // Launcher modal — shown BEFORE the apply run starts. Replaces
    // the plain confirm() with a richer UI that surfaces stale-queue
    // warnings + offers the dry-run option. User picks Live or Dry
    // Run; clicking either invokes opts.onLaunch({dryRun}).
    const APPLY_LAUNCHER_ID = 'aim-ai-apply-launcher';
    function openApplyLauncher(cfg) {
        closeApplyLauncher();
        const { editCount, groupCount, fpCount, ffzCount, astCount = 0, warnings, onLaunch } = cfg;
        const m = document.createElement('div');
        m.id = APPLY_LAUNCHER_ID;
        m.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        const box = document.createElement('div');
        box.style.cssText = 'background:#1f2228;border:1px solid rgba(95,255,95,0.5);border-radius:8px;padding:22px 28px;min-width:520px;max-width:90vw;max-height:90vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 8px 32px rgba(0,0,0,0.7)';
        const etaMin = Math.ceil(groupCount * 5 / 60);
        const warnHtml = warnings.length > 0
            ? `<div style="margin-top:12px;padding:10px 12px;background:rgba(255,213,79,0.10);border:1px solid rgba(255,213,79,0.40);border-radius:4px">
                 <div style="color:#ffd54f;font-weight:700;font-size:12px;margin-bottom:6px">⚠ ${warnings.length} stale-queue warning${warnings.length === 1 ? '' : 's'} — Percepto data changed since queue was built</div>
                 <div style="color:#cfd6dc;font-size:11px;max-height:180px;overflow-y:auto;line-height:1.5">${warnings.map(w => '• ' + w.replace(/</g, '&lt;')).join('<br>')}</div>
                 <div style="color:#888;font-size:10px;margin-top:6px">Applying will OVERWRITE the current values with what's queued.</div>
               </div>`
            : '';
        box.innerHTML = `
            <div style="color:#5fff5f;font-weight:700;font-size:16px;margin-bottom:4px">▶ Apply queue</div>
            <div style="color:#888;font-size:11px;margin-bottom:12px">FFZs first, then FP segments. Per-entity ~3-6 s.</div>
            <div style="color:#cfd6dc;font-size:13px;line-height:1.7">
                <strong>${editCount}</strong> edit${editCount === 1 ? '' : 's'} across <strong>${groupCount}</strong> entit${groupCount === 1 ? 'y' : 'ies'}<br>
                Order: <strong style="color:#5fff5f">${ffzCount}</strong> FFZ${ffzCount === 1 ? '' : 's'}, then <strong style="color:#7adfe6">${fpCount}</strong> FP${fpCount === 1 ? '' : 's'}${astCount > 0 ? `, then <strong style="color:#ffffff">${astCount}</strong> Asset${astCount === 1 ? '' : 's'}` : ''}<br>
                Estimated total: ~<strong>${etaMin}</strong> min
            </div>
            ${warnHtml}
            <div style="margin-top:14px;padding:10px 12px;background:rgba(196,181,253,0.08);border:1px solid rgba(196,181,253,0.30);border-radius:4px;color:#c4b5fd;font-size:11px;line-height:1.5">
                <strong>Dry Run</strong> walks the pipeline but <strong>does not save</strong>. In ⚡ Direct API mode it builds each body + runs the projected overlap check with zero POSTs. Use it to preview without touching live data.
            </div>
            <label style="margin-top:12px;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;background:rgba(255,193,71,0.08);border:1px solid rgba(255,193,71,0.35);border-radius:4px;cursor:pointer">
                <input type="checkbox" id="aim-ai-launch-directapi" style="margin-top:2px">
                <span style="color:#ffd479;font-size:11px;line-height:1.5">
                    <strong>⚡ Direct API (fast)</strong> — POST each entity to the server instead of driving the editor. Skips the per-entity dialog <em>and</em> the "Mismatched Altitude Ranges" block, so bulk AGL/DELTA shifts go through. Auto-downloads a rollback file first, verifies every write, and runs a final FP↔FFZ overlap check. FFZs + FPs only (assets still use the editor).
                </span>
            </label>
            <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
                <button id="aim-ai-launch-cancel" style="background:transparent;color:#888;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:8px 16px;cursor:pointer;font:inherit;font-size:12px">Cancel</button>
                <button id="aim-ai-launch-dry" style="background:rgba(196,181,253,0.18);color:#c4b5fd;border:1px solid rgba(196,181,253,0.55);border-radius:3px;padding:8px 16px;cursor:pointer;font:inherit;font-size:12px;font-weight:600">🧪 Dry Run (no save)</button>
                <button id="aim-ai-launch-live" style="background:rgba(95,255,95,0.18);color:#5fff5f;border:1px solid rgba(95,255,95,0.55);border-radius:3px;padding:8px 18px;cursor:pointer;font:inherit;font-size:12px;font-weight:700">▶ Apply for real</button>
            </div>
        `;
        m.appendChild(box);
        document.body.appendChild(m);
        box.querySelector('#aim-ai-launch-cancel').onclick = closeApplyLauncher;
        const directApiChecked = () => {
            const cb = box.querySelector('#aim-ai-launch-directapi');
            return !!(cb && cb.checked);
        };
        box.querySelector('#aim-ai-launch-dry').onclick = () => {
            const directApi = directApiChecked();
            closeApplyLauncher();
            onLaunch({ dryRun: true, directApi });
        };
        box.querySelector('#aim-ai-launch-live').onclick = () => {
            const directApi = directApiChecked();
            closeApplyLauncher();
            onLaunch({ dryRun: false, directApi });
        };
    }
    function closeApplyLauncher() {
        const m = document.getElementById(APPLY_LAUNCHER_ID);
        if (m) m.remove();
    }

    // Modal shown during apply — large floating progress + abort
    // button. Locks the user out of clicking elsewhere on the SUM
    // panel while a run is in flight (clicks during apply can race
    // with the script setting input values).
    const APPLY_MODAL_ID = 'aim-ai-apply-modal';
    function openApplyProgressModal(groups) {
        closeApplyProgressModal();
        const m = document.createElement('div');
        m.id = APPLY_MODAL_ID;
        m.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        const box = document.createElement('div');
        box.style.cssText = 'background:#1f2228;border:1px solid rgba(95,255,95,0.5);border-radius:8px;padding:20px 28px;min-width:460px;max-width:90vw;color:#e6e6e6;box-shadow:0 8px 32px rgba(0,0,0,0.7)';
        box.innerHTML = `
            <div style="color:#5fff5f;font-weight:700;font-size:15px;margin-bottom:8px">▶ Applying changes</div>
            <div id="aim-ai-apply-phase" style="display:flex;gap:6px;align-items:center;margin-bottom:12px;font-size:11px;flex-wrap:wrap"></div>
            <div id="aim-ai-apply-label" style="color:#e6e6e6;font-size:13px;font-weight:600;margin-bottom:8px;min-height:18px">Getting ready…</div>
            <div style="height:10px;background:rgba(95,255,95,0.15);border-radius:5px;overflow:hidden;margin-bottom:8px">
                <div id="aim-ai-apply-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#5fff5f,#3fcf3f);transition:width 250ms ease-out"></div>
            </div>
            <div id="aim-ai-apply-stats" style="color:#9ad;font-size:12px;font-variant-numeric:tabular-nums;min-height:16px"></div>
            <div id="aim-ai-apply-sub" style="color:#888;font-size:10px;margin-top:3px;min-height:13px"></div>
            <div id="aim-ai-apply-errors" style="color:#ff8a80;font-size:11px;margin-top:8px;max-height:120px;overflow-y:auto"></div>
            <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
                <button id="aim-ai-apply-abort" style="background:rgba(255,138,128,0.15);color:#ff8a80;border:1px solid rgba(255,138,128,0.55);border-radius:3px;padding:6px 14px;cursor:pointer;font:inherit;font-size:11px;font-weight:600">Abort after current entity</button>
            </div>
        `;
        m.appendChild(box);
        document.body.appendChild(m);
        const abort = box.querySelector('#aim-ai-apply-abort');
        abort.onclick = () => {
            applyState.aborted = true;
            abort.disabled = true;
            abort.textContent = 'Aborting after current entity…';
            abort.style.opacity = '0.5';
        };
    }
    function updateApplyProgressModal(st) {
        const m = document.getElementById(APPLY_MODAL_ID);
        if (!m) return;
        const phaseEl = m.querySelector('#aim-ai-apply-phase');
        const labelEl = m.querySelector('#aim-ai-apply-label');
        const fillEl = m.querySelector('#aim-ai-apply-fill');
        const statsEl = m.querySelector('#aim-ai-apply-stats');
        const subEl = m.querySelector('#aim-ai-apply-sub');
        const errEl = m.querySelector('#aim-ai-apply-errors');

        const phase = st.phase || (st.running ? 'writing' : 'done');
        const total = st.entityTotal || 0;
        const idx = Math.min(st.entityIndex || 0, total);
        const failed = st.errors.length;

        // Phase strip — only for ⚡ direct-API runs (it has the
        // backup + safety-check stages). Editor runs hide it.
        if (phaseEl) {
            if (st.directApi) {
                const order = ['snapshot', 'writing', 'checking'];
                const steps = [['snapshot', '📸 Back up'], ['writing', '✏️ Update'], ['checking', '🔍 Safety check']];
                const curRank = phase === 'done' ? 3 : order.indexOf(phase);
                phaseEl.innerHTML = steps.map(([k, lbl], i) => {
                    const isCur = k === phase;
                    const isDone = i < curRank;
                    const color = isCur ? '#5fff5f' : isDone ? '#7fbf7f' : '#5a5a5a';
                    const weight = isCur ? '700' : '400';
                    const mark = isDone ? '✓ ' : '';
                    const arrow = i < steps.length - 1 ? `<span style="color:#444;margin:0 2px">→</span>` : '';
                    return `<span style="color:${color};font-weight:${weight}">${mark}${lbl}</span>${arrow}`;
                }).join('');
                phaseEl.style.display = 'flex';
            } else {
                phaseEl.style.display = 'none';
            }
        }

        // Big plain-language line for what's happening right now.
        let label;
        if (phase === 'snapshot') label = '📸 Saving a backup of everything first…';
        else if (phase === 'checking') label = '🔍 Double-checking the whole map for any road poking above its zone…';
        else if (phase === 'done' || !st.running) label = '✓ All done!';
        else if (st.currentEntity) label = `✏️ Updating ${st.currentEntity}`;
        else label = 'Working…';
        if (labelEl) labelEl.textContent = label;

        // Bar: full during the safety check / when done; entity-based
        // while updating; a sliver during backup so it's clearly alive.
        let pct;
        if (phase === 'checking' || phase === 'done' || !st.running) pct = 100;
        else if (phase === 'snapshot') pct = 4;
        else pct = total > 0 ? Math.round((Math.max(0, idx - 1) / total) * 100) : 0;
        if (fillEl) fillEl.style.width = pct + '%';

        // Stats in ENTITIES (what you see on the map), not raw edits.
        if (statsEl) {
            if (phase === 'snapshot') statsEl.textContent = `Backing up ${total} item${total === 1 ? '' : 's'}…`;
            else if (phase === 'checking') statsEl.textContent = `Updated ${total - failed} of ${total} — now checking the map…`;
            else if (phase === 'done' || !st.running) statsEl.textContent = `${total - failed} of ${total} updated${failed ? ` · ${failed} need a look` : ' ✓'}`;
            else statsEl.textContent = `Item ${idx} of ${total}${failed ? ` · ${failed} need a look` : ''}`;
        }
        // Quiet secondary line with the raw edit count for the curious.
        if (subEl) subEl.textContent = st.total ? `(${st.done} of ${st.total} altitude values written)` : '';

        if (errEl) {
            errEl.innerHTML = '';
            st.errors.forEach(e => {
                const r = document.createElement('div');
                r.textContent = `• ${e.entityName}: ${e.reason}`;
                errEl.appendChild(r);
            });
        }
    }
    function closeApplyProgressModal() {
        const m = document.getElementById(APPLY_MODAL_ID);
        if (m) m.remove();
    }

    // ⚡ Direct-API completion report — shows applied/failed counts, the
    // overlap self-check result (the safety net), and a one-click
    // rollback for live runs. broken = applyState.overlapBroken.
    const DIRECT_REPORT_ID = 'aim-ai-direct-report';
    function openDirectApiReport(st, opts) {
        const old = document.getElementById(DIRECT_REPORT_ID);
        if (old) old.remove();
        const dryRun = !!(opts && opts.dryRun);
        const failed = st.errors.length;
        const ok = st.done;
        const broken = Array.isArray(st.overlapBroken) ? st.overlapBroken : [];
        const useFt = !!sumPanelState.unitsFt;
        const band = (b) => {
            const c = (m) => useFt ? Math.round(m * 3.28084) : Number(m.toFixed(1));
            return `${c(b[0])}–${c(b[1])}${useFt ? 'ft' : 'm'}`;
        };
        const m = document.createElement('div');
        m.id = DIRECT_REPORT_ID;
        m.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);z-index:100001;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        const box = document.createElement('div');
        const accent = broken.length ? '#ff8a80' : '#5fff5f';
        box.style.cssText = `background:#1f2228;border:1px solid ${accent}88;border-radius:8px;padding:20px 26px;min-width:480px;max-width:90vw;max-height:88vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 8px 32px rgba(0,0,0,0.7)`;
        const errHtml = failed ? `<div style="margin-top:10px;color:#ff8a80;font-size:11px;max-height:140px;overflow-y:auto">${st.errors.map(e => `• ${String(e.entityName).replace(/</g, '&lt;')}: ${String(e.reason).replace(/</g, '&lt;')}`).join('<br>')}</div>` : '';
        const overlapHtml = broken.length
            ? `<div style="margin-top:14px;padding:10px 12px;background:rgba(255,138,128,0.10);border:1px solid rgba(255,138,128,0.45);border-radius:4px">
                 <div style="color:#ff8a80;font-weight:700;font-size:12px;margin-bottom:6px">⚠ ${broken.length} FP↔FFZ pair${broken.length === 1 ? '' : 's'} now have DISJOINT altitude bands</div>
                 <div style="color:#cfd6dc;font-size:11px;max-height:200px;overflow-y:auto;line-height:1.6">${broken.map(b => `• FFZ <strong>${String(b.ffz).replace(/</g, '&lt;')}</strong> (${band(b.ffzBand)}) ✕ FP <strong>${String(b.fp).replace(/</g, '&lt;')}</strong> (${band(b.fpBand)})`).join('<br>')}</div>
                 <div style="color:#888;font-size:10px;margin-top:6px">${dryRun ? 'This is the PROJECTED end state — fix the queue before applying.' : 'These would have been blocked by Percepto\'s guard. Review them, or roll back below.'}</div>
               </div>`
            : `<div style="margin-top:14px;padding:8px 12px;background:rgba(95,255,95,0.08);border:1px solid rgba(95,255,95,0.35);border-radius:4px;color:#5fff5f;font-size:11px">✓ Overlap self-check passed — every crossing FP shares an altitude band with its FFZ${dryRun ? ' (projected end state)' : ''}.</div>`;
        // Bridges — terrain seams auto-widened to keep paths continuous.
        const bridgeGroups = Array.isArray(st.bridges) ? st.bridges : [];
        const bridgeCount = bridgeGroups.reduce((s, g) => s + g.bridges.length, 0);
        const ftc = (m) => useFt ? Math.round(m * 3.28084) : Math.round(m);
        const bridgeHtml = bridgeCount
            ? `<div style="margin-top:14px;padding:10px 12px;background:rgba(122,223,230,0.08);border:1px solid rgba(122,223,230,0.40);border-radius:4px">
                 <div style="color:#7adfe6;font-weight:700;font-size:12px;margin-bottom:6px">🌉 Bridged ${bridgeCount} terrain seam${bridgeCount === 1 ? '' : 's'} ${dryRun ? 'would be raised' : 'raised'} to keep flight-path segments continuous</div>
                 <div style="color:#cfd6dc;font-size:11px;max-height:160px;overflow-y:auto;line-height:1.6">${bridgeGroups.map(g => g.bridges.map(br => `• ${String(g.entityName).replace(/</g, '&lt;')} seg ${br.seg}: ceiling ${ftc(br.fromM)}→${ftc(br.toM)}${useFt ? 'ft' : 'm'}`).join('<br>')).join('<br>')}</div>
                 <div style="color:#888;font-size:10px;margin-top:6px">Floors (AGL) unchanged — only the ceiling was raised at the steep steps so neighbouring segments overlap.</div>
               </div>`
            : '';
        const rollbackBtn = (!dryRun && window.__aim_ai_directApiRollback)
            ? `<button id="aim-ai-report-rollback" style="background:rgba(255,193,71,0.16);color:#ffd479;border:1px solid rgba(255,193,71,0.55);border-radius:3px;padding:8px 16px;cursor:pointer;font:inherit;font-size:12px;font-weight:600">↩ Roll back this run</button>`
            : '';
        box.innerHTML = `
            <div style="color:${accent};font-weight:700;font-size:16px;margin-bottom:4px">⚡ ${dryRun ? 'Dry run preview' : 'Direct-API apply'} — ${dryRun ? 'no data written' : 'complete'}</div>
            <div style="color:#cfd6dc;font-size:13px;margin-top:8px">
                <strong style="color:#5fff5f">${ok}</strong> edit${ok === 1 ? '' : 's'} ${dryRun ? 'simulated' : 'applied + verified'}${failed ? ` · <strong style="color:#ff8a80">${failed}</strong> failed` : ''}
            </div>
            ${errHtml}
            ${bridgeHtml}
            ${overlapHtml}
            <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
                ${rollbackBtn}
                <button id="aim-ai-report-close" style="background:rgba(95,255,95,0.16);color:#5fff5f;border:1px solid rgba(95,255,95,0.5);border-radius:3px;padding:8px 18px;cursor:pointer;font:inherit;font-size:12px;font-weight:700">Close</button>
            </div>
        `;
        m.appendChild(box);
        document.body.appendChild(m);
        box.querySelector('#aim-ai-report-close').onclick = () => m.remove();
        const rb = box.querySelector('#aim-ai-report-rollback');
        if (rb) {
            rb.onclick = async () => {
                if (!confirm(`Roll back ${window.__aim_ai_directApiRollback.count} entit${window.__aim_ai_directApiRollback.count === 1 ? 'y' : 'ies'} to their pre-run altitudes?`)) return;
                rb.disabled = true; rb.textContent = 'Rolling back…';
                const res = await rollbackDirectApiRun();
                rb.textContent = res.ok ? `↩ Restored ${res.restored}` : `↩ ${res.restored} ok · ${res.failed} failed`;
                showToast(res.ok ? `Rolled back ${res.restored} entities` : `Rollback: ${res.restored} ok, ${res.failed} failed (see console)`, res.ok ? 'rgba(255,193,71,0.6)' : 'rgba(255,138,128,0.6)');
            };
        }
    }

    // Pre-flight checks before any save runs. Returns
    //   { ok: true } on clean pass
    //   { ok: false, blocking: [...], warnings: [...] }
    // BLOCKING failures stop the apply entirely (e.g. duplicate names —
    // we'd pick the wrong entity). WARNINGS surface to the user but
    // they can proceed (e.g. stale queue — entity changed since queue
    // was built, but maybe that's expected after a partial apply).
    function preflightCheckQueue() {
        const result = { ok: true, blocking: [], warnings: [] };
        const siteID = getCurrentSiteID();
        const bucket = siteID ? mapObjectsBySite[siteID] : null;
        const entities = bucket ? (bucket.entities || []) : [];
        if (entities.length === 0) {
            result.ok = false;
            result.blocking.push('No entities loaded for this site — refresh first.');
            return result;
        }
        // 1. Duplicate name check. For every queued entity name,
        //    count how many entities on the site share that name.
        //    >1 = ambiguous; we can't safely click "the right one".
        const queuedNames = new Set();
        Object.values(pendingSegmentEdits).forEach(e => {
            if (e.fpName) queuedNames.add(e.fpName);
        });
        queuedNames.forEach(name => {
            const matches = entities.filter(en => (en.name || '').trim() === name.trim());
            if (matches.length > 1) {
                result.ok = false;
                result.blocking.push(`Duplicate entity name "${name}" (${matches.length} matches) — script can't pick the right one.`);
            }
            if (matches.length === 0) {
                result.ok = false;
                result.blocking.push(`Entity "${name}" no longer exists on this site (deleted since queue built?).`);
            }
        });
        // 2. Stale-queue check. For every queued edit, compare its
        //    `oldValueM` against the entity's CURRENT value. Drift =
        //    Percepto data changed since the queue was built (someone
        //    else edited, or a partial prior apply succeeded). Warning,
        //    not blocking — user might want to overwrite anyway.
        // Tolerance matches the apply verification — covers Percepto's
        // internal integer-meter rounding (~3 ft round-trip drift).
        const tolM = 1.0;
        Object.values(pendingSegmentEdits).forEach(e => {
            const ent = entities.find(en => en.id === e.entityId);
            if (!ent) return; // already caught above
            // v3.41: subtype path is string-valued, not numeric.
            if (e.isAsset && e.field === 'subtype') {
                const cur = (ent.custom && ent.custom.poi_type_str) || '';
                if (cur && cur !== e.oldValue) {
                    result.warnings.push(`${e.entityName} subtype: queued from "${e.oldValue}" but current value is "${cur}" (Percepto data changed since queue built — apply will overwrite).`);
                }
                return;
            }
            // v3.50: name path is also string-valued.
            if (e.field === 'name') {
                const cur = ent.name || '';
                if (cur !== e.oldValue) {
                    result.warnings.push(`"${e.oldValue}" name: queued rename to "${e.newValue}" but current name is "${cur}" (Percepto data changed since queue built — apply will overwrite).`);
                }
                return;
            }
            let currentM = null;
            if (e.isFfz) {
                if (ent.restrictions) {
                    currentM = e.field === 'min_alt' ? ent.restrictions.minAlt : ent.restrictions.maxAlt;
                }
            } else if (Array.isArray(ent.arcs)) {
                const arc = ent.arcs.find(a => a && a.id === e.arcId);
                if (arc) currentM = e.field === 'min_alt' ? arc.min_alt : arc.max_alt;
            }
            if (currentM != null && Math.abs(currentM - e.oldValueM) > tolM) {
                const useFt = !!sumPanelState.unitsFt;
                const conv = (m) => useFt ? Math.round(m * 3.28084) : Number(m.toFixed(1));
                const unit = useFt ? 'ft' : 'm';
                const fld = e.field === 'min_alt' ? 'Min' : 'Max';
                result.warnings.push(`${e.segmentName} ${fld}: queued from ${conv(e.oldValueM)}${unit} but current value is ${conv(currentM)}${unit} (Percepto data changed since queue built — apply will overwrite).`);
            }
        });
        return result;
    }

    // Returns the entity's CURRENT Min/Max altitude in meters for a
    // queued edit, pulled live from the bucket. Used for post-save
    // verification — confirms what we wrote actually stuck.
    function readCurrentAltForEdit(edit) {
        const siteID = getCurrentSiteID();
        const bucket = siteID ? mapObjectsBySite[siteID] : null;
        if (!bucket) return null;
        const ent = (bucket.entities || []).find(en => en.id === edit.entityId);
        if (!ent) return null;
        if (edit.isFfz) {
            if (!ent.restrictions) return null;
            return edit.field === 'min_alt' ? ent.restrictions.minAlt : ent.restrictions.maxAlt;
        }
        // FP segment: try arcId first, then fall back to arcIndex.
        // Percepto regenerates arc IDs on save, so post-save lookups by
        // ID return null. arcIndex (position) survives saves.
        if (!Array.isArray(ent.arcs)) return null;
        let arc = ent.arcs.find(a => a && a.id === edit.arcId);
        if (!arc && edit.arcIndex != null && edit.arcIndex < ent.arcs.length) {
            arc = ent.arcs[edit.arcIndex];
        }
        if (!arc) return null;
        return edit.field === 'min_alt' ? arc.min_alt : arc.max_alt;
    }

    // ============================================================
    // ⚡ DIRECT API APPLY (v3.67)
    //
    // Instead of driving Percepto's editor per entity (slow, and its
    // React layer blocks the "Mismatched Altitude Ranges" overlap
    // case so bulk AGL/DELTA shifts can't be saved), we POST the
    // entity straight to `/map_objects/`. Recon (2026-06-09) proved
    // the overlap check is CLIENT-ONLY — the server accepts a
    // non-overlapping save with 200 + warnings:[]. See memory
    // reference_map_objects_save_endpoint.
    //
    // The catch: bypassing the guard means the END STATE's validity
    // is on us. Four rails make that safe:
    //   1. Snapshot + rollback file (download + in-memory) before any
    //      write — failure to snapshot ABORTS before writing.
    //   2. Per-POST verify-after: the response echoes the saved
    //      entity; confirm altitudes landed AND structure (coord/arc
    //      counts) is intact — a structural anomaly is treated as a
    //      hard failure.
    //   3. Final FP↔FFZ overlap self-check on fresh data (live) or the
    //      projected end state (dry-run) — replaces the guard we
    //      removed and flags any genuinely-disjoint band.
    //   4. Dry-run builds bodies + runs the projected overlap check
    //      WITHOUT any POST.
    // ============================================================

    // Per-site config cache. `/sites/<id>/` exposes `mountain_terrain`
    // (the editor sends it as `mountain_terrain_site` in the write
    // body — a terrain-relative-vs-MSL flag we must NOT guess).
    const siteCfgCache = {};
    async function fetchSiteConfig(siteID, force) {
        if (!siteID) throw new Error('no siteID');
        if (!force && siteCfgCache[siteID]) return siteCfgCache[siteID];
        const r = await fetch(`https://percepto.app/sites/${encodeURIComponent(siteID)}/`, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`/sites/${siteID}/ HTTP ${r.status}`);
        const j = await r.json();
        siteCfgCache[siteID] = j;
        return j;
    }

    function getCsrfToken() {
        const m = (document.cookie || '').match(/(?:^|;\s*)csrftoken=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    // Convert a fetched (read-shape) entity into the exact write body
    // Percepto's editor POSTs. Confirmed field mapping (FFZ + FP):
    //   site_id ← site · points ← coords · strip site/coords/polygon/
    //   asset_waypoints · mountain_terrain_site ← site cfg · each arc
    //   gets points:[point_a,point_b]. We clone so the bucket entity
    //   is never mutated.
    function buildWriteBody(entity, siteCfg) {
        const b = JSON.parse(JSON.stringify(entity));
        b.site_id = entity.site;
        b.points = Array.isArray(entity.coords) ? entity.coords : [];
        delete b.site;
        delete b.coords;
        delete b.polygon;
        delete b.asset_waypoints;
        b.mountain_terrain_site = !!(siteCfg && siteCfg.mountain_terrain);
        if (Array.isArray(b.arcs)) {
            b.arcs.forEach(a => {
                if (a && a.point_a && a.point_b && !Array.isArray(a.points)) {
                    a.points = [a.point_a, a.point_b];
                }
            });
        }
        return b;
    }

    // FP arc altitudes are stored as INTEGER meters server-side (the
    // server floors a sub-meter float — e.g. 880.6 → 880). Round our
    // target to the nearest integer meter so the write matches intent
    // (closer than the server's floor) AND verify is exact. FFZ
    // restrictions accept decimals, so they're left untouched.
    function fpArcAltMeters(m) { return Math.round(m); }

    // Mutate a write body in place with the group's queued edits.
    // newValueM is meters (the queue's storage unit) — FFZ restrictions
    // keep decimals; FP arc min_alt/max_alt round to integer meters.
    function applyEditsToBody(body, edits) {
        edits.forEach(e => {
            if (e.field === 'name') { body.name = e.newValue; return; }
            if (e.isFfz) {
                if (!body.restrictions || typeof body.restrictions !== 'object') body.restrictions = {};
                if (e.field === 'min_alt') body.restrictions.minAlt = e.newValueM;
                else if (e.field === 'max_alt') body.restrictions.maxAlt = e.newValueM;
            } else if (Array.isArray(body.arcs)) {
                // arcId first, fall back to arcIndex (IDs regenerate on save).
                let arc = body.arcs.find(a => a && a.id === e.arcId);
                if (!arc && e.arcIndex != null && e.arcIndex < body.arcs.length) arc = body.arcs[e.arcIndex];
                if (arc) {
                    if (e.field === 'min_alt') arc.min_alt = fpArcAltMeters(e.newValueM);
                    else if (e.field === 'max_alt') arc.max_alt = fpArcAltMeters(e.newValueM);
                }
            }
        });
    }

    // Server rule: any two CONNECTED FP segments must share an altitude
    // band, or POST 400s ("Arcs N and M have no overlapping altitude
    // range"). A flight path is a BRANCHING GRAPH — segments connect at
    // shared waypoints, NOT just by list order — so connected pairs can
    // be far apart in the array (e.g. arcs 47 & 52 meeting at a branch).
    // We build adjacency from each arc's point_a/point_b, then for every
    // connected pair whose bands are disjoint we RAISE only the lower
    // arc's CEILING to reconnect — each segment keeps its AGL floor, the
    // band just fattens at the seam. Ceilings only ever rise (floors
    // fixed) so repeated passes converge; we cap at 8. Returns the net
    // per-segment ceiling change (1-indexed) for reporting.
    function bridgeArcContinuity(arcs) {
        if (!Array.isArray(arcs) || arcs.length < 2) return [];
        const OVERLAP_M = 2; // raise ceilings 2 m past the neighbour's floor for a clear, non-touching overlap
        const vkey = (p) => (p && typeof p.lat === 'number' && typeof p.lng === 'number') ? `${p.lat.toFixed(6)},${p.lng.toFixed(6)}` : null;
        const origMax = arcs.map(a => (a && typeof a.max_alt === 'number') ? a.max_alt : null);
        // Group arc indices by shared vertex (point_a + point_b).
        const byVertex = new Map();
        arcs.forEach((a, i) => {
            if (!a) return;
            [vkey(a.point_a), vkey(a.point_b)].forEach(k => {
                if (!k) return;
                if (!byVertex.has(k)) byVertex.set(k, []);
                byVertex.get(k).push(i);
            });
        });
        // Every unordered pair of arcs meeting at any vertex = an edge.
        const edges = new Set();
        for (const idxs of byVertex.values()) {
            for (let x = 0; x < idxs.length; x++) {
                for (let y = x + 1; y < idxs.length; y++) {
                    edges.add(Math.min(idxs[x], idxs[y]) + ':' + Math.max(idxs[x], idxs[y]));
                }
            }
        }
        const edgeList = [...edges].map(s => s.split(':').map(Number));
        for (let pass = 0; pass < 8; pass++) {
            let changed = false;
            for (const [i, j] of edgeList) {
                const A = arcs[i], B = arcs[j];
                if (!A || !B) continue;
                if (typeof A.min_alt !== 'number' || typeof A.max_alt !== 'number' ||
                    typeof B.min_alt !== 'number' || typeof B.max_alt !== 'number') continue;
                // STRICT overlap: the server rejects bands that only TOUCH
                // at a single altitude (max == min) — it needs a positive
                // intersection. So use > not >=, and bridge the touchers.
                if (A.max_alt > B.min_alt && B.max_alt > A.min_alt) continue; // already strictly overlap
                if (A.max_alt <= B.min_alt) { A.max_alt = B.min_alt + OVERLAP_M; changed = true; }
                else { B.max_alt = A.min_alt + OVERLAP_M; changed = true; }
            }
            if (!changed) break;
        }
        const bridges = [];
        arcs.forEach((a, i) => {
            if (origMax[i] != null && a && typeof a.max_alt === 'number' && a.max_alt > origMax[i] + 0.01) {
                bridges.push({ seg: i + 1, fromM: origMax[i], toM: a.max_alt });
            }
        });
        return bridges;
    }

    // Rail 2 — verify the server's echoed object matches WHAT WE SENT
    // (sentBody), not the raw queue — so auto-bridged ceilings verify
    // correctly. Checks every arc/restriction round-tripped + structure
    // (coord/arc counts) intact; a count change is a STRUCTURAL anomaly.
    function verifyDirectSave(saved, sentBody, original) {
        if (!saved) return { ok: false, reason: 'no saved object in response', structural: true };
        const oc = (original.coords || []).length, sc = (saved.coords || []).length;
        if (oc !== sc) return { ok: false, reason: `coord count changed ${oc}→${sc}`, structural: true };
        const oa = (original.arcs || []).length, sa = (saved.arcs || []).length;
        if (oa !== sa) return { ok: false, reason: `arc count changed ${oa}→${sa}`, structural: true };
        const tolM = 0.5;
        // FFZ restrictions (object, decimals).
        if (sentBody.restrictions && typeof sentBody.restrictions === 'object' && !Array.isArray(sentBody.restrictions)) {
            const sr = saved.restrictions || {};
            for (const k of ['minAlt', 'maxAlt']) {
                if (typeof sentBody.restrictions[k] === 'number' &&
                    (typeof sr[k] !== 'number' || Math.abs(sr[k] - sentBody.restrictions[k]) > tolM)) {
                    return { ok: false, reason: `FFZ ${k}: sent ${sentBody.restrictions[k].toFixed(1)}m, got ${typeof sr[k] === 'number' ? sr[k].toFixed(1) : 'null'}m`, structural: false };
                }
            }
        }
        // FP arcs, by INDEX (ids regenerate on save).
        if (Array.isArray(sentBody.arcs)) {
            for (let i = 0; i < sentBody.arcs.length; i++) {
                const sentA = sentBody.arcs[i], savA = (saved.arcs || [])[i];
                if (!savA) return { ok: false, reason: `segment ${i + 1} missing in response`, structural: true };
                for (const k of ['min_alt', 'max_alt']) {
                    if (typeof sentA[k] === 'number' &&
                        (typeof savA[k] !== 'number' || Math.abs(savA[k] - sentA[k]) > tolM)) {
                        return { ok: false, reason: `seg ${i + 1} ${k}: sent ${sentA[k]}m, got ${typeof savA[k] === 'number' ? savA[k] : 'null'}m`, structural: false };
                    }
                }
            }
        }
        return { ok: true };
    }

    // POST one entity group directly. Returns the same outcome shape as
    // applyOneEntity: { ok, reason, appliedCount, verified, structural }.
    async function applyOneEntityDirect(group, opts) {
        const { dryRun } = opts || {};
        const label = group.entityName || '(unnamed)';
        const siteID = getCurrentSiteID();
        const bucket = siteID ? mapObjectsBySite[siteID] : null;
        const entity = bucket ? (bucket.entities || []).find(en => en.id === group.entityId) : null;
        if (!entity) {
            applyState.errors.push({ entityName: label, reason: 'entity not in fetched data (refresh first)' });
            return { ok: false, reason: 'entity not in fetched data', appliedCount: 0 };
        }
        let siteCfg;
        try { siteCfg = await fetchSiteConfig(siteID); }
        catch (e) {
            applyState.errors.push({ entityName: label, reason: `site config read failed (${e && e.message || e})` });
            return { ok: false, reason: 'site config read failed', appliedCount: 0 };
        }
        const body = buildWriteBody(entity, siteCfg);
        applyEditsToBody(body, group.edits);
        // Auto-bridge terrain seams on flight paths so adjacent segments
        // overlap (server rule) — raises ceilings only, AGL floor kept.
        let bridges = [];
        if (!group.isFfz && Array.isArray(body.arcs)) {
            bridges = bridgeArcContinuity(body.arcs);
            if (bridges.length) {
                const useFt = !!sumPanelState.unitsFt;
                const maxRaise = Math.max(...bridges.map(br => br.toM - br.fromM));
                console.log(`${TAG} ⚡ ${label} — bridged ${bridges.length} terrain seam(s) (raised ceiling up to ${useFt ? Math.round(maxRaise * 3.28084) + 'ft' : maxRaise.toFixed(0) + 'm'}) to keep segments continuous`);
            }
        }

        if (dryRun) {
            console.log(`${TAG} ⚡[DRY] ${label} — built body (${group.edits.length} edit${group.edits.length === 1 ? '' : 's'}${bridges.length ? ', ' + bridges.length + ' seam(s) to bridge' : ''}), NOT posting`);
            return { ok: true, reason: 'dry-run (no POST)', appliedCount: group.edits.length, verified: false, simulated: true, bridges };
        }

        const csrf = getCsrfToken();
        if (!csrf) {
            applyState.errors.push({ entityName: label, reason: 'no csrftoken cookie — cannot authenticate POST' });
            return { ok: false, reason: 'no csrftoken', appliedCount: 0 };
        }
        let resp;
        try {
            const r = await fetch('https://percepto.app/map_objects/', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'X-CSRFToken': csrf },
                body: JSON.stringify(body),
            });
            const txt = await r.text();
            let json = null; try { json = JSON.parse(txt); } catch (e) {}
            resp = { status: r.status, json, raw: txt };
        } catch (e) {
            applyState.errors.push({ entityName: label, reason: `POST threw: ${e && e.message || e}` });
            return { ok: false, reason: 'POST threw', appliedCount: 0 };
        }
        if (resp.status !== 200) {
            const snippet = (resp.raw || '').slice(0, 200);
            // Targeted diagnostic for the arc-overlap 400 — dump the named
            // segments FROM THE BODY WE SENT so we can see why they're
            // considered connected-but-disjoint (floors too far / a link
            // we can't detect / numbering mismatch). Server numbering is
            // unknown, so dump both 0- and 1-indexed candidates + check
            // whether they share a vertex per our matcher.
            const mArc = /Arcs?\s+(\d+)\s+and\s+(\d+)/i.exec(resp.raw || '');
            if (mArc && Array.isArray(body.arcs)) {
                const ft = (m) => (typeof m === 'number') ? Math.round(m * 3.28084) : '?';
                const vk = (p) => (p && typeof p.lat === 'number') ? `${p.lat.toFixed(6)},${p.lng.toFixed(6)}` : 'none';
                const desc = (n) => {
                    const a = body.arcs[n];
                    if (!a) return `[idx ${n}: none]`;
                    return `idx ${n}: ${ft(a.min_alt)}-${ft(a.max_alt)}ft  A=${vk(a.point_a)}  B=${vk(a.point_b)}`;
                };
                const n1 = Number(mArc[1]), n2 = Number(mArc[2]);
                console.warn(`${TAG} ⚡ 400 ARC DIAGNOSTIC — server says arcs ${n1} & ${n2} don't overlap. Body arcs (try 0- and 1-indexed):`);
                [n1, n1 - 1].forEach(n => console.warn(`${TAG}   ${desc(n)}`));
                console.warn(`${TAG}   ----`);
                [n2, n2 - 1].forEach(n => console.warn(`${TAG}   ${desc(n)}`));
                // Do any of the candidate pairs share a vertex (our model)?
                const share = (i, j) => {
                    const A = body.arcs[i], B = body.arcs[j];
                    if (!A || !B) return false;
                    const ka = [vk(A.point_a), vk(A.point_b)], kb = [vk(B.point_a), vk(B.point_b)];
                    return ka.some(k => k !== 'none' && kb.includes(k));
                };
                console.warn(`${TAG}   share-vertex? [${n1},${n2}]=${share(n1, n2)} [${n1 - 1},${n2 - 1}]=${share(n1 - 1, n2 - 1)} [${n1},${n2 - 1}]=${share(n1, n2 - 1)} [${n1 - 1},${n2}]=${share(n1 - 1, n2)}`);
            }
            applyState.errors.push({ entityName: label, reason: `server ${resp.status}: ${snippet}` });
            return { ok: false, reason: `server ${resp.status}`, appliedCount: 0 };
        }
        const saved = resp.json && resp.json.map_objects;
        const verify = verifyDirectSave(saved, body, entity);
        // Refresh the in-memory bucket with the server's echoed object so
        // downstream reads (and the overlap check) see truth, not stale.
        if (saved && bucket) {
            // v3.77: server echoes entity in WRITE shape (.points, not .coords).
            // If we stored it as-is, subsequent right-click hit-tests would
            // miss this entity (findEntityAtLatLng checked .coords). Alias
            // .points → .coords so the cached entity stays read-shape and
            // hit-test keeps working. Also log so we can see it happening.
            if (saved && !Array.isArray(saved.coords) && Array.isArray(saved.points)) {
                console.log(`${TAG} Direct-API echo missing .coords, aliasing .points (${saved.points.length}) → .coords for ${saved.name || saved.id}`);
                saved.coords = saved.points;
            }
            const idx = bucket.entities.findIndex(en => en.id === group.entityId);
            if (idx >= 0) bucket.entities[idx] = saved;
        }
        if (!verify.ok) {
            applyState.errors.push({ entityName: label, reason: `verify ${verify.structural ? 'STRUCTURAL ' : ''}failed: ${verify.reason}` });
            return { ok: false, reason: `verify: ${verify.reason}`, appliedCount: 0, verified: false, structural: !!verify.structural, bridges };
        }
        console.log(`${TAG} ⚡ ${label} — POSTed + verified ✓ (${group.edits.length} edit${group.edits.length === 1 ? '' : 's'}${bridges.length ? `, ${bridges.length} seam(s) bridged` : ''})`);
        return { ok: true, appliedCount: group.edits.length, verified: true, bridges };
    }

    // Rail 1 — snapshot the CURRENT write body of every target entity so
    // a bad run can be re-POSTed verbatim. Returns a portable object we
    // both stash in memory/GM and download as a file.
    async function collectRollbackSnapshot(groups, siteID, siteCfg) {
        const bucket = siteID ? mapObjectsBySite[siteID] : null;
        const entities = [];
        for (const g of groups) {
            if (g.isAsset) continue; // asset edits still go the editor path
            const ent = bucket ? (bucket.entities || []).find(en => en.id === g.entityId) : null;
            if (!ent) throw new Error(`snapshot: entity ${g.entityId} (${g.entityName}) not in fetched data`);
            entities.push({ id: ent.id, name: ent.name, type: ent.type, body: buildWriteBody(ent, siteCfg) });
        }
        return { siteID, when: new Date().toISOString(), count: entities.length, entities };
    }

    function downloadRollback(snap) {
        try {
            const json = JSON.stringify(snap, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            // window.top bypasses the map-iframe sandbox for downloads.
            const topDoc = (window.top && window.top.document) ? window.top.document : document;
            const a = topDoc.createElement('a');
            a.href = url;
            a.download = `aim-rollback-site${snap.siteID}-${snap.when.replace(/[:.]/g, '-')}.json`;
            (topDoc.body || document.body).appendChild(a);
            a.click();
            setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch (e) {} }, 1500);
        } catch (e) {
            console.warn(`${TAG} ⚡ rollback download failed (snapshot still in window.__aim_ai_directApiRollback):`, e);
        }
    }

    // One-click restore: re-POST every snapshotted body verbatim. Exposed
    // as window.__aim_ai_rollback() and wired to the report modal button.
    async function rollbackDirectApiRun(snap) {
        snap = snap || window.__aim_ai_directApiRollback;
        if (!snap || !Array.isArray(snap.entities) || !snap.entities.length) {
            console.warn(`${TAG} ⚡ no rollback snapshot available`);
            return { ok: false, restored: 0, failed: 0, reason: 'no snapshot' };
        }
        const csrf = getCsrfToken();
        if (!csrf) { console.warn(`${TAG} ⚡ rollback: no csrftoken`); return { ok: false, restored: 0, failed: 0, reason: 'no csrftoken' }; }
        let restored = 0, failed = 0;
        for (const ent of snap.entities) {
            try {
                const r = await fetch('https://percepto.app/map_objects/', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'X-CSRFToken': csrf },
                    body: JSON.stringify(ent.body),
                });
                if (r.status === 200) restored++;
                else { failed++; console.warn(`${TAG} ⚡ rollback ${ent.name}: server ${r.status}`); }
            } catch (e) { failed++; console.warn(`${TAG} ⚡ rollback ${ent.name} threw:`, e); }
            await sleep(150);
        }
        console.log(`${TAG} ⚡ rollback complete — restored ${restored}, failed ${failed}`);
        try {
            const sid = getCurrentSiteID();
            if (sid) { await fetchMapObjects(sid, true); if (document.getElementById(SUM_PANEL_ID)) renderSummaryPanel(sid); }
        } catch (e) {}
        return { ok: failed === 0, restored, failed };
    }
    window.__aim_ai_rollback = () => rollbackDirectApiRun();

    // ---- Overlap self-check geometry (rail 3) ----
    // lat/lng treated as planar x/y — fine at site scale. Ray-cast PIP.
    // v3.78: renamed from pointInPolygon → pointInPolyPt to stop shadowing
    // the 3-arg pointInPolygon at line 766. JS function-declaration hoisting
    // made this 2-arg version win for ALL call sites — including the hit-test
    // pip that takes (lat, lng, poly). Result: right-click on Asset/FFZ
    // silently called this 2-arg version with `lat` as `pt` and `lng` as
    // `poly`, always returned false. Hit-test never matched anything → bail.
    // Live since v3.67 when this overlap-check pip was first added.
    function pointInPolyPt(pt, poly) {
        if (!pt || !Array.isArray(poly) || poly.length < 3) return false;
        const x = pt.lng, y = pt.lat;
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].lng, yi = poly[i].lat, xj = poly[j].lng, yj = poly[j].lat;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    function segIntersect(a, b, c, d) {
        if (!a || !b || !c || !d) return false;
        const o = (p, q, r) => Math.sign((q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng));
        const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
        return o1 !== o2 && o3 !== o4;
    }
    // True if FP geometrically crosses the FFZ polygon. Uses ARCS (the
    // real flight segments — FPs can branch, so consecutive coords are
    // NOT reliable segments) and tests both endpoint-inside and
    // segment-crosses-edge (the point-to-SEGMENT lesson, not just
    // point-to-vertex).
    function fpCrossesPolygon(fp, poly) {
        const arcs = Array.isArray(fp.arcs) ? fp.arcs : [];
        for (const a of arcs) {
            if (a.point_a && pointInPolyPt(a.point_a, poly)) return true;
            if (a.point_b && pointInPolyPt(a.point_b, poly)) return true;
            if (a.point_a && a.point_b) {
                for (let j = 0; j < poly.length; j++) {
                    if (segIntersect(a.point_a, a.point_b, poly[j], poly[(j + 1) % poly.length])) return true;
                }
            }
        }
        return false;
    }
    // Returns [{ffz, fp, ffzBand:[min,max], fpBand:[min,max]}] for every
    // crossing FP whose overall altitude band is DISJOINT from the FFZ's.
    function runOverlapSelfCheck(entities) {
        const list = Array.isArray(entities) ? entities : [];
        const ffzs = list.filter(e => e.type === 16 && e.restrictions && Array.isArray(e.coords) && e.coords.length >= 3);
        const fps = list.filter(e => e.type === 15 && Array.isArray(e.arcs) && e.arcs.length);
        const broken = [];
        for (const ffz of ffzs) {
            const fMin = ffz.restrictions.minAlt, fMax = ffz.restrictions.maxAlt;
            if (typeof fMin !== 'number' || typeof fMax !== 'number') continue;
            for (const fp of fps) {
                if (!fpCrossesPolygon(fp, ffz.coords)) continue;
                let pMin = Infinity, pMax = -Infinity;
                fp.arcs.forEach(a => {
                    if (typeof a.min_alt === 'number') pMin = Math.min(pMin, a.min_alt);
                    if (typeof a.max_alt === 'number') pMax = Math.max(pMax, a.max_alt);
                });
                if (!isFinite(pMin) || !isFinite(pMax)) continue;
                if (pMax < fMin || pMin > fMax) {
                    broken.push({ ffz: ffz.name, fp: fp.name, ffzBand: [fMin, fMax], fpBand: [pMin, pMax] });
                }
            }
        }
        return broken;
    }
    // Dry-run projection: clone fetched entities, apply ALL queued edits
    // in memory, return the projected end state for the overlap check.
    function projectQueueOntoEntities(siteID) {
        const bucket = siteID ? mapObjectsBySite[siteID] : null;
        if (!bucket) return [];
        const clones = JSON.parse(JSON.stringify(bucket.entities || []));
        const byId = new Map(clones.map(e => [e.id, e]));
        Object.values(pendingSegmentEdits).forEach(e => {
            const ent = byId.get(e.entityId);
            if (!ent) return;
            if (e.field === 'name') { ent.name = e.newValue; return; }
            if (e.isFfz) {
                if (!ent.restrictions) ent.restrictions = {};
                if (e.field === 'min_alt') ent.restrictions.minAlt = e.newValueM;
                else if (e.field === 'max_alt') ent.restrictions.maxAlt = e.newValueM;
            } else if (Array.isArray(ent.arcs)) {
                let arc = ent.arcs.find(a => a && a.id === e.arcId);
                if (!arc && e.arcIndex != null && e.arcIndex < ent.arcs.length) arc = ent.arcs[e.arcIndex];
                if (arc) {
                    if (e.field === 'min_alt') arc.min_alt = fpArcAltMeters(e.newValueM);
                    else if (e.field === 'max_alt') arc.max_alt = fpArcAltMeters(e.newValueM);
                }
            }
        });
        return clones;
    }

    // The actual apply pipeline — async, processes one group at a
    // time. Calls onProgress(state) on every step so the UI can
    // update. Honors applyState.aborted between groups.
    async function runApplyPipeline(onProgress, opts) {
        const { dryRun, directApi } = opts || {};
        const groups = groupPendingByEntity();
        applyState.total = groups.reduce((s, g) => s + g.edits.length, 0);
        applyState.done = 0;
        applyState.errors = [];
        applyState.running = true;
        applyState.aborted = false;
        applyState.dryRun = !!dryRun;
        applyState.directApi = !!directApi;
        applyState.overlapBroken = undefined;
        applyState.bridges = [];
        applyState.entityTotal = groups.length;
        applyState.entityIndex = 0;
        applyState.currentEntity = '';
        applyState.phase = 'writing';
        applyState.startTime = Date.now();
        const auditEntries = [];
        // Outer try/catch — bulletproof guarantee that applyState.running
        // returns to false even on unhandled exception. Without this, a
        // thrown error inside the loop would leave the UI thinking a run
        // is in flight forever (blocking future runs until page refresh).
        try {
            await closeEditor();
            // Rail 1 — snapshot + rollback file BEFORE any direct-API
            // write. If the snapshot can't be built we ABORT before
            // touching live data (no safety net = no run).
            let snapshotFailed = false;
            if (directApi && !dryRun) {
                applyState.phase = 'snapshot';
                onProgress(applyState);
                try {
                    const sid = getCurrentSiteID();
                    const cfg = await fetchSiteConfig(sid);
                    const snap = await collectRollbackSnapshot(groups, sid, cfg);
                    window.__aim_ai_directApiRollback = snap;
                    try { elevGmSet('aim-ai-directapi-rollback', snap); } catch (e) {}
                    downloadRollback(snap);
                    console.log(`${TAG} ⚡ rollback snapshot saved (${snap.count} entities) + downloaded`);
                } catch (e) {
                    snapshotFailed = true;
                    applyState.errors.push({ entityName: '(rollback snapshot)', reason: `FAILED: ${e && e.message || e} — run aborted before any write` });
                    console.error(`${TAG} ⚡ rollback snapshot failed — aborting before writes:`, e);
                }
            }
            for (let gi = 0; gi < groups.length && !snapshotFailed; gi++) {
                if (applyState.aborted) break;
                const g = groups[gi];
                applyState.phase = 'writing';
                applyState.entityIndex = gi + 1;
                applyState.currentEntity = g.entityName;
                applyState.currentLabel = `${gi + 1} of ${groups.length}: ${g.entityName} (${g.edits.length} edit${g.edits.length === 1 ? '' : 's'})${dryRun ? ' [DRY RUN]' : ''}`;
                onProgress(applyState);
                const entityStart = Date.now();
                let outcome;
                try {
                    outcome = await applyOneEntity(g, { dryRun, directApi });
                } catch (err) {
                    outcome = { ok: false, reason: `unhandled exception: ${err && err.message ? err.message : err}`, appliedCount: 0 };
                    applyState.errors.push({ entityName: g.entityName, reason: outcome.reason });
                    console.error(`${TAG} apply: ${g.entityName} threw:`, err);
                }
                const durationMs = Date.now() - entityStart;
                auditEntries.push({
                    entityName: g.entityName,
                    entityId: g.entityId,
                    isFfz: g.isFfz,
                    isAsset: !!g.isAsset,
                    editsAttempted: g.edits.length,
                    editsApplied: outcome.appliedCount || 0,
                    success: !!outcome.ok,
                    reason: outcome.reason || '',
                    verified: outcome.verified === true,
                    durationMs,
                    edits: g.edits.map(e => (e.field === 'subtype' || e.field === 'name') ? ({
                        field: e.field,
                        oldValue: e.oldValue,
                        newValue: e.newValue,
                        isNewSubtype: !!e.isNewSubtype,
                    }) : ({
                        field: e.field,
                        arcId: e.arcId,
                        oldValueM: e.oldValueM,
                        newValueM: e.newValueM,
                    })),
                });
                if (outcome.bridges && outcome.bridges.length) {
                    applyState.bridges.push({ entityName: g.entityName, bridges: outcome.bridges });
                }
                if (outcome.ok) {
                    applyState.done += g.edits.length;
                    if (!dryRun) {
                        g.edits.forEach(e => {
                            discardPendingEdit(e.entityId, e.arcId, e.field);
                        });
                    }
                }
                // A STRUCTURAL verify failure means we sent a malformed
                // body (coord/arc count changed) — stop immediately so a
                // body-shape bug can't damage entity after entity.
                if (outcome.structural) {
                    applyState.aborted = true;
                    applyState.errors.push({ entityName: '(safety abort)', reason: `structural anomaly on ${g.entityName} — run halted; rollback available` });
                    console.error(`${TAG} ⚡ STRUCTURAL anomaly on ${g.entityName} — halting run. Use window.__aim_ai_rollback() or the report button.`);
                }
                onProgress(applyState);
                await sleep(directApi && !dryRun ? 250 : 600);
            }
        } catch (err) {
            console.error(`${TAG} apply pipeline unhandled exception:`, err);
            applyState.errors.push({ entityName: '(pipeline)', reason: `unhandled: ${err && err.message ? err.message : err}` });
        } finally {
            applyState.running = false;
            applyState.currentLabel = '';
            window.__aim_ai_lastApplyLog = {
                site: getCurrentSiteID(),
                startTime: new Date(applyState.startTime).toISOString(),
                endTime: new Date().toISOString(),
                totalDurationMs: Date.now() - applyState.startTime,
                dryRun: !!dryRun,
                editsRequested: applyState.total,
                editsApplied: applyState.done,
                errors: applyState.errors.slice(),
                entities: auditEntries,
            };
            console.log(`${TAG} apply: audit log → window.__aim_ai_lastApplyLog`);
            // v3.51: clear the sidebar search filter we left set from the
            // last entity's search. Otherwise the user reopens the sidebar
            // and sees just the last-edited entity, which is confusing.
            try {
                const docs = [document];
                try { if (window.top && window.top !== window) docs.push(window.top.document); } catch (e) {}
                let sidebarInput = null;
                for (const d of docs) {
                    sidebarInput = d.querySelector(SIDEBAR_INPUT_SELECTOR);
                    if (sidebarInput) break;
                }
                if (!sidebarInput) {
                    const frames = Array.from(window.top.document.querySelectorAll('iframe'));
                    for (const f of frames) {
                        try { sidebarInput = f.contentDocument && f.contentDocument.querySelector(SIDEBAR_INPUT_SELECTOR); }
                        catch (e) {}
                        if (sidebarInput) break;
                    }
                }
                if (sidebarInput && sidebarInput.value) {
                    const proto = window.HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc && desc.set) desc.set.call(sidebarInput, '');
                    else sidebarInput.value = '';
                    sidebarInput.dispatchEvent(new Event('input', { bubbles: true }));
                    sidebarInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) {}
            // ⚡ Direct-API: the refresh + overlap check below take a
            // couple seconds with the bar full — label that "checking"
            // so it doesn't look frozen. (running is already false, so
            // the modal's checking branch must win over the done case.)
            if (directApi && !applyState.aborted) applyState.phase = 'checking';
            onProgress(applyState);
            // AUTO-REFRESH after a live run that wrote anything. Force
            // a final fetch + re-render the SUM panel so the user sees
            // the updated state immediately (otherwise they'd need to
            // manually click Refresh to see the new values + queue).
            // Skipped for dry runs (no data changed) and aborted runs
            // (user explicitly stopped — don't surprise them).
            if (!dryRun && applyState.done > 0 && !applyState.aborted) {
                try {
                    const sid = getCurrentSiteID();
                    if (sid) {
                        await fetchMapObjects(sid, true);
                        await sleep(200);
                        // Re-render — preserves sumPanelState (column
                        // order, filters, selection, etc.) since that's
                        // module-scoped.
                        if (document.getElementById(SUM_PANEL_ID)) {
                            renderSummaryPanel(sid);
                        }
                    }
                } catch (e) {
                    console.warn(`${TAG} apply: auto-refresh failed:`, e);
                }
            }
            // Rail 3 — final FP↔FFZ overlap self-check. Live: on the
            // freshly-fetched data above. Dry-run: on the PROJECTED end
            // state (clone + apply queued edits). This is the safety net
            // that replaces the client guard we bypassed.
            if (directApi) {
                try {
                    const sid = getCurrentSiteID();
                    const ents = dryRun ? projectQueueOntoEntities(sid) : ((mapObjectsBySite[sid] || {}).entities || []);
                    applyState.overlapBroken = runOverlapSelfCheck(ents);
                    console.log(`${TAG} ⚡ overlap self-check (${dryRun ? 'projected end state' : 'live'}): ${applyState.overlapBroken.length} disjoint FP↔FFZ pair(s)`, applyState.overlapBroken);
                } catch (e) {
                    applyState.overlapBroken = null;
                    console.warn(`${TAG} ⚡ overlap self-check failed:`, e);
                }
            }
            applyState.phase = 'done';
            onProgress(applyState);
        }
    }

    // Process one entity group: open editor, set all values, save.
    // Returns true if save succeeded, false otherwise (with the
    // failure recorded in applyState.errors).
    // v3.42: walk React fiber from an element looking for a props
    // object that matches the predicate. Stops at first match. Returns
    // the props object (so caller can grab the handler). Same primitive
    // as feedback-react-fiber-walk-for-ant-actions — fiber walks beat
    // DOM-driven Ant dropdown opens (which corrupt hover state and have
    // bad mousedown timing).
    function findReactPropsByPredicate(el, predicate, maxDepth = 30) {
        if (!el) return null;
        const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) return null;
        let fiber = el[fiberKey];
        let depth = 0;
        while (fiber && depth < maxDepth) {
            const props = fiber.memoizedProps || (fiber.stateNode && fiber.stateNode.props);
            if (props && predicate(props)) return props;
            fiber = fiber.return;
            depth++;
        }
        return null;
    }

    // v3.42: Apply automation for asset subtype changes via React fiber.
    // Instead of clicking the Ant Select dropdown open (which had click-
    // timing + portal-mount issues), walk the fiber from #asset-form-type
    // to find the Ant Select's onChange handler and call it directly.
    // Works for both existing and new subtypes — Ant Form accepts any
    // value via onChange; Percepto's save persists it regardless of
    // whether it was in the options list.
    //
    // If fiber walk fails (Percepto markup changed), falls back to DOM-
    // driving the dropdown (the v3.41 path, less reliable).
    //
    // Only the first edit in the group is applied — subtype is entity-
    // level (one value per asset). Multiple queued subtype edits on the
    // same entity collapse to the latest by virtue of the queue's
    // pendingEditKey shape (entityId:'':subtype).
    async function applyAssetSubtypeChange(group, opts) {
        const { dryRun } = opts || {};
        const label = group.entityName || '(unnamed)';
        // v3.50: support both 'subtype' and 'name' edits on the same asset
        // in one editor session.
        const subtypeEdit = group.edits.find(e => e.field === 'subtype');
        const nameEdit = group.edits.find(e => e.field === 'name');
        if (!subtypeEdit && !nameEdit) {
            return { ok: false, reason: 'no actionable edits in group', appliedCount: 0 };
        }
        const targetSubtype = subtypeEdit ? String(subtypeEdit.newValue || '').trim() : null;
        const targetName = nameEdit ? String(nameEdit.newValue || '').trim() : null;
        const fields = [];
        if (targetName) fields.push(`name → "${targetName}"`);
        if (targetSubtype) fields.push(`subtype → "${targetSubtype}"${subtypeEdit.isNewSubtype ? ' (NEW)' : ''}`);
        console.log(`${TAG} apply: starting asset "${label}" ${fields.join(', ')}${dryRun ? ' [DRY RUN]' : ''}`);

        await closeEditor();
        const hit = await findAndClickSidebarItem(label);
        if (!hit) {
            applyState.errors.push({ entityName: label, reason: 'not found in sidebar' });
            return { ok: false, reason: 'not found in sidebar', appliedCount: 0 };
        }
        clickElDispatch(hit.el, hit.doc);
        const editor = await waitForCondition(() => findOpenEditorWithName(), 15000, 250);
        if (!editor) {
            // One retry — same pattern as FP/FFZ path
            clickElDispatch(hit.el, hit.doc);
            const retry = await waitForCondition(() => findOpenEditorWithName(), 10000, 250);
            if (!retry) {
                applyState.errors.push({ entityName: label, reason: 'editor did not open (after retry)' });
                return { ok: false, reason: 'editor did not open', appliedCount: 0 };
            }
        }
        const finalEditor = findOpenEditorWithName();
        if (!finalEditor) {
            applyState.errors.push({ entityName: label, reason: 'editor lost between open + read' });
            return { ok: false, reason: 'editor lost', appliedCount: 0 };
        }
        // v3.56: trim both sides — Percepto data sometimes has trailing
        // whitespace, causing identical-looking strings to fail equality.
        // Same root as the v3.55 phantom-rename fix.
        const openedName = (getEditorTitle(finalEditor.doc) || '').trim();
        const labelTrim = (label || '').trim();
        if (openedName && openedName.toLowerCase() !== labelTrim.toLowerCase()) {
            applyState.errors.push({ entityName: label, reason: `wrong entity in editor (got "${openedName}")` });
            return { ok: false, reason: `wrong entity ("${openedName}")`, appliedCount: 0 };
        }
        const panelDoc = finalEditor.doc;
        let appliedCount = 0;

        // v3.50: set the entity name first if it's pending. Doing this
        // before subtype keeps the same editor session for both edits.
        if (targetName) {
            const nameInput = panelDoc.getElementById('upsert-entity-form-name');
            if (nameInput) {
                console.log(`${TAG} apply: ${label} — setting name → "${targetName}"`);
                setReactInputValue(nameInput, targetName);
                await sleep(180);
                appliedCount++;
            } else {
                applyState.errors.push({ entityName: label, reason: 'name input not found (#upsert-entity-form-name)' });
                // Don't bail — subtype may still succeed.
            }
        }

        // No subtype edit → skip the dropdown driving + go straight to save.
        if (!targetSubtype) {
            if (appliedCount === 0) {
                applyState.errors.push({ entityName: label, reason: 'no edits applied (name input missing?)' });
                await closeEditor();
                return { ok: false, reason: 'no edits applied', appliedCount: 0 };
            }
            if (dryRun) {
                await sleep(400);
                await closeEditor();
                return { ok: true, reason: '[DRY RUN] name set + cancelled', appliedCount, verified: false };
            }
            await sleep(250);
            const saved = await saveCurrentEditor();
            const valErr = findValidationError();
            if (valErr) {
                applyState.errors.push({ entityName: label, reason: `Percepto validation error: ${valErr}` });
                await closeEditor();
                return { ok: false, reason: `validation: ${valErr}`, appliedCount };
            }
            if (!saved) {
                applyState.errors.push({ entityName: label, reason: 'save timed out (no editor close)' });
                return { ok: false, reason: 'save timed out', appliedCount };
            }
            console.log(`${TAG} apply: ${label} — name saved`);
            return { ok: true, reason: 'saved', appliedCount, verified: false };
        }

        // Find the Type combobox. ID 'asset-form-type' is the input
        // inside Percepto's Ant Select trigger.
        const combo = panelDoc.getElementById('asset-form-type');
        if (!combo) {
            applyState.errors.push({ entityName: label, reason: 'Type input not found (#asset-form-type)' });
            await closeEditor();
            return { ok: false, reason: 'Type input not found', appliedCount };
        }

        // v3.42: PRIMARY PATH — React fiber walk. Find the Ant Select's
        // onChange handler and call it directly. No dropdown opening, no
        // mousedown timing games, no portal scanning. The Ant Form Item
        // (parent component) picks up the change via its onChange context
        // and persists when the user (us) clicks Save.
        const selectProps = findReactPropsByPredicate(combo, (p) => {
            // Ant Select v5: onChange + optionFilterProp or options/children.
            // We want the Select that controls Type, not some other ancestor.
            // Heuristic: must have onChange + a typeof string value (current
            // subtype is a string).
            return typeof p.onChange === 'function'
                && (typeof p.value === 'string' || p.value == null)
                && !!p.options !== false; // options is array OR options derived from children — allow both
        });
        let fiberSucceeded = false;
        if (selectProps && typeof selectProps.onChange === 'function') {
            console.log(`${TAG} apply: ${label} — calling Ant Select onChange via fiber (value="${targetSubtype}")`);
            try {
                // Build a minimal option object that matches Ant's contract.
                // For unknown values, Ant tends to accept { label, value }.
                const opt = { label: targetSubtype, value: targetSubtype, key: targetSubtype };
                selectProps.onChange(targetSubtype, opt);
                fiberSucceeded = true;
            } catch (e) {
                console.warn(`${TAG} apply: ${label} — fiber onChange threw, falling back to DOM path:`, e);
            }
            // Brief settle for React to flush + Form context to update.
            await sleep(200);
        } else {
            console.log(`${TAG} apply: ${label} — fiber walk found no Select onChange, falling back to DOM path`);
        }

        // FALLBACK: DOM-driven dropdown (v3.41 path). Only runs if the
        // fiber walk didn't find onChange. Kept for robustness in case
        // Percepto reshapes the Select wrapper.
        if (!fiberSucceeded) {
            const selectWrap = combo.closest('.ant-select');
            const selectorEl = (selectWrap && selectWrap.querySelector('.ant-select-selector')) || selectWrap || combo;
            try { combo.focus(); } catch (e) {}
            // Mousedown is what Ant Select listens for to toggle open.
            selectorEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: panelDoc.defaultView || window }));
            selectorEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: panelDoc.defaultView || window }));
            selectorEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: panelDoc.defaultView || window }));

            const findDropdown = () => {
                const docs = [panelDoc, document];
                try { if (panelDoc.defaultView && panelDoc.defaultView.top) docs.push(panelDoc.defaultView.top.document); } catch (e) {}
                for (const d of docs) {
                    if (!d) continue;
                    const list = d.querySelector('.pr-creatable-dropdown, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .rc-virtual-list');
                    if (list) {
                        const cd = list.closest('.pr-creatable-dropdown') || list.closest('.ant-select-dropdown') || list;
                        return { dropdown: cd, doc: d };
                    }
                }
                return null;
            };
            let dd = await waitForCondition(findDropdown, 4000, 100);
            if (!dd) {
                applyState.errors.push({ entityName: label, reason: 'Type dropdown did not open (DOM fallback)' });
                await closeEditor();
                return { ok: false, reason: 'Type dropdown did not open', appliedCount };
            }
            await sleep(150);
            const findOption = (root) => {
                const opts = root.querySelectorAll('.ant-select-item-option');
                for (const o of opts) {
                    const title = o.getAttribute('title') || '';
                    const txt = (o.querySelector('.ant-select-item-option-content')?.textContent || '').trim();
                    if (title === targetSubtype || txt === targetSubtype) return o;
                }
                return null;
            };
            let optEl = findOption(dd.dropdown);
            if (!optEl) {
                const newInput = dd.dropdown.querySelector('.pr-creatable-dropdown__input');
                const addBtn = dd.dropdown.querySelector('.pr-creatable-dropdown__button');
                if (!newInput || !addBtn) {
                    applyState.errors.push({ entityName: label, reason: `subtype "${targetSubtype}" not found and no creatable footer` });
                    await closeEditor();
                    return { ok: false, reason: 'no creatable footer', appliedCount };
                }
                setReactInputValue(newInput, targetSubtype);
                await sleep(200);
                await waitForCondition(() => !addBtn.disabled, 1500, 50);
                if (addBtn.disabled) {
                    applyState.errors.push({ entityName: label, reason: 'Add button never enabled' });
                    await closeEditor();
                    return { ok: false, reason: 'Add button disabled', appliedCount };
                }
                clickElDispatch(addBtn, dd.doc);
                optEl = await waitForCondition(() => findOption(dd.dropdown), 4000, 100);
                if (!optEl) {
                    applyState.errors.push({ entityName: label, reason: `subtype "${targetSubtype}" never appeared after Add` });
                    await closeEditor();
                    return { ok: false, reason: 'new option never appeared', appliedCount };
                }
                await sleep(100);
            }
            clickElDispatch(optEl, dd.doc);
            await waitForCondition(
                () => optEl.getAttribute('aria-selected') === 'true' || (combo.value && combo.value.includes(targetSubtype)),
                1500, 100,
            );
            await sleep(200);
        }

        // Verify the form picked up the new value before saving.
        // combo.value is the search-input's text; Ant Select shows the
        // selected label in .ant-select-selection-item.
        const selectedItem = (combo.closest('.ant-select') || panelDoc).querySelector('.ant-select-selection-item');
        const selectedText = selectedItem ? (selectedItem.getAttribute('title') || selectedItem.textContent || '').trim() : '';
        console.log(`${TAG} apply: ${label} — selection-item now reads "${selectedText}" (target was "${targetSubtype}")`);
        if (selectedText && selectedText !== targetSubtype) {
            applyState.errors.push({ entityName: label, reason: `selection-item reads "${selectedText}" not "${targetSubtype}" — onChange may not have stuck` });
            await closeEditor();
            return { ok: false, reason: `value not applied (shows "${selectedText}")`, appliedCount };
        }
        appliedCount++;

        if (dryRun) {
            await sleep(500);
            await closeEditor();
            return { ok: true, reason: '[DRY RUN] edits applied + cancelled', appliedCount, verified: false };
        }

        // Save.
        await sleep(300);
        const saved = await saveCurrentEditor();
        const valErr = findValidationError();
        if (valErr) {
            applyState.errors.push({ entityName: label, reason: `Percepto validation error: ${valErr}` });
            await closeEditor();
            return { ok: false, reason: `validation: ${valErr}`, appliedCount };
        }
        if (!saved) {
            applyState.errors.push({ entityName: label, reason: 'save timed out (no editor close)' });
            return { ok: false, reason: 'save timed out', appliedCount };
        }
        console.log(`${TAG} apply: ${label} — saved (${appliedCount} edit${appliedCount === 1 ? '' : 's'})`);
        return { ok: true, reason: 'saved', appliedCount, verified: false };
    }

    async function applyOneEntity(group, opts) {
        const { dryRun } = opts || {};
        const label = group.entityName || '(unnamed)';
        // v3.67: ⚡ direct-API path — POST /map_objects/ instead of
        // driving the editor. FFZ + FP only; assets keep the editor
        // path (subtype edit is an Ant Select, not an altitude POST).
        if (opts && opts.directApi && !group.isAsset) {
            return applyOneEntityDirect(group, opts);
        }
        // v3.41: branch to the asset path for subtype-only edits. The
        // FP/FFZ path operates on number inputs; assets need the Ant
        // Select dropdown ("Type" field with creatable footer).
        if (group.isAsset) {
            return applyAssetSubtypeChange(group, opts);
        }
        const kindLabel = group.isFfz ? 'FFZ' : 'FP';
        console.log(`${TAG} apply: starting "${label}" (${group.edits.length} edit${group.edits.length === 1 ? '' : 's'}, ${kindLabel})${dryRun ? ' [DRY RUN]' : ''}`);
        // 1. Close any existing editor (we may have landed in the
        //    wrong one from a previous step).
        await closeEditor();
        // 2. Find + click the entity in the sidebar.
        const hit = await findAndClickSidebarItem(label);
        if (!hit) {
            applyState.errors.push({ entityName: label, reason: 'not found in sidebar' });
            console.warn(`${TAG} apply: ${label} — entity not in sidebar`);
            return { ok: false, reason: 'not found in sidebar', appliedCount: 0 };
        }
        console.log(`${TAG} apply: ${label} — clicking sidebar item`);
        clickElDispatch(hit.el, hit.doc);
        // 3. Wait for ANY editor with a populated name input to render.
        //    Then verify the name matches ours; if not, warn but proceed
        //    (matches the Bulk Altitude Updater pattern — relying on
        //    "we just clicked this item" as the source of truth).
        const editor = await waitForCondition(
            () => findOpenEditorWithName(),
            15000, 250,
        );
        if (!editor) {
            console.warn(`${TAG} apply: ${label} — no editor after 15s, retrying click`);
            clickElDispatch(hit.el, hit.doc);
            const retry = await waitForCondition(() => findOpenEditorWithName(), 10000, 250);
            if (!retry) {
                applyState.errors.push({ entityName: label, reason: 'editor did not open (after retry)' });
                console.warn(`${TAG} apply: ${label} — editor still not open after retry`);
                return { ok: false, reason: 'editor did not open', appliedCount: 0 };
            }
        }
        const finalEditor = findOpenEditorWithName();
        if (!finalEditor) {
            applyState.errors.push({ entityName: label, reason: 'editor lost between open + read' });
            return { ok: false, reason: 'editor lost', appliedCount: 0 };
        }
        // v3.56: trim both sides — Percepto data sometimes has trailing
        // whitespace, causing identical-looking strings to fail equality.
        // Same root as the v3.55 phantom-rename fix.
        const openedName = (getEditorTitle(finalEditor.doc) || '').trim();
        const labelTrim = (label || '').trim();
        if (openedName && openedName.toLowerCase() !== labelTrim.toLowerCase()) {
            console.warn(`${TAG} apply: ${label} — editor shows different entity "${openedName}" — skipping`);
            applyState.errors.push({ entityName: label, reason: `wrong entity in editor (got "${openedName}")` });
            return { ok: false, reason: `wrong entity ("${openedName}")`, appliedCount: 0 };
        }
        console.log(`${TAG} apply: ${label} — editor open, name="${openedName}"`);
        // v3.50: split edits by field. Name + altitudes can coexist; for
        // NFZ/GM there may only be a name edit (no Min/Max inputs exist).
        const altEdits = group.edits.filter(e => e.field === 'min_alt' || e.field === 'max_alt');
        const nameEdit = group.edits.find(e => e.field === 'name');
        let appliedCount = 0;
        // 4a. Apply name edit if present.
        if (nameEdit) {
            const nameInput = finalEditor.doc.getElementById('upsert-entity-form-name');
            if (nameInput) {
                console.log(`${TAG} apply: ${label} — setting name → "${nameEdit.newValue}"`);
                setReactInputValue(nameInput, nameEdit.newValue);
                await sleep(180);
                appliedCount++;
            } else {
                applyState.errors.push({ entityName: label, reason: 'name input not found (#upsert-entity-form-name)' });
                // Continue — altitudes may still succeed.
            }
        }
        // 4b. Find the alt inputs (only needed if there are alt edits).
        let minInputs = [], maxInputs = [];
        if (altEdits.length > 0) {
            ({ minInputs, maxInputs } = findEditorInputs(finalEditor.doc));
            console.log(`${TAG} apply: ${label} — found ${minInputs.length} Min input(s), ${maxInputs.length} Max input(s)`);
            if (minInputs.length === 0 && maxInputs.length === 0) {
                applyState.errors.push({ entityName: label, reason: 'no Min/Max inputs found' });
                console.warn(`${TAG} apply: no inputs found for ${label}`);
                await closeEditor();
                return { ok: false, reason: 'no Min/Max inputs found', appliedCount };
            }
        }
        // 5. Set values. For FP segment edits, index = arc order in
        //    the buildSummaryRows pass. We re-resolve from the
        //    entity's arcs to compute the right row index per edit.
        const entityFromGroup = (() => {
            const siteID = getCurrentSiteID();
            const bucket = siteID ? mapObjectsBySite[siteID] : null;
            return bucket ? (bucket.entities || []).find(en => en.id === group.entityId) : null;
        })();
        // Convert each alt edit into an input mutation.
        for (const ed of altEdits) {
            const valFt = Math.round(ed.newValueM * 3.28084); // Percepto's inputs are feet
            const isMin = ed.field === 'min_alt';
            // FFZ: single Min/Max inputs (use index 0).
            // FP segment: index = position of this arc in entity.arcs.
            //   Prefer arc.id match (works when queue is fresh) but
            //   fall back to stored arcIndex (works when Percepto has
            //   regenerated arc IDs since the queue was built — that
            //   happens automatically after every FP save).
            let idx = 0;
            if (!group.isFfz) {
                const arcs = (entityFromGroup && Array.isArray(entityFromGroup.arcs)) ? entityFromGroup.arcs : [];
                idx = arcs.findIndex(a => a && a.id === ed.arcId);
                if (idx < 0 && ed.arcIndex != null && ed.arcIndex < arcs.length) {
                    idx = ed.arcIndex;
                    console.log(`${TAG} apply: ${label} — arc ${ed.arcId} not found, falling back to arcIndex=${ed.arcIndex}`);
                }
                if (idx < 0) {
                    console.warn(`${TAG} apply: arc ${ed.arcId} (idx ${ed.arcIndex}) not found in ${label}; skipping this edit`);
                    continue;
                }
            }
            const targetInputs = isMin ? minInputs : maxInputs;
            const target = targetInputs[idx];
            if (!target) {
                console.warn(`${TAG} apply: input ${isMin ? 'Min' : 'Max'}[${idx}] missing for ${label}; skipping`);
                continue;
            }
            setReactInputValue(target, valFt);
            appliedCount++;
            await sleep(80);
        }
        if (appliedCount === 0) {
            applyState.errors.push({ entityName: label, reason: 'no edits applied (no name input + no matching alt inputs)' });
            await closeEditor();
            return { ok: false, reason: 'no edits applied', appliedCount: 0 };
        }
        console.log(`${TAG} apply: ${label} — set ${appliedCount} input value(s)${dryRun ? ' [DRY RUN — skipping save]' : ', saving…'}`);
        // DRY RUN — don't click save. Cancel out instead so the
        // user's data isn't touched. Return success so the audit log
        // reflects what would have been written.
        if (dryRun) {
            await sleep(800);
            // Check for any pre-save validation warning visible right
            // away (Percepto sometimes flags out-of-range values
            // immediately on input).
            const valErr = findValidationError();
            await closeEditor();
            if (valErr) {
                console.warn(`${TAG} apply: ${label} — [DRY RUN] Percepto would reject this save: ${valErr}`);
                applyState.errors.push({ entityName: label, reason: `[DRY] would fail: ${valErr}` });
                return { ok: false, reason: `[DRY] would fail: ${valErr}`, appliedCount };
            }
            return { ok: true, reason: '[DRY RUN] values set + cancelled', appliedCount, verified: false };
        }
        // 6. Save + watch for validation errors during the save.
        await sleep(400);
        const saved = await saveCurrentEditor();
        // After save: scan for validation toasts/errors. If present,
        // mark as failed even if the editor closed cleanly.
        const valErr = findValidationError();
        if (valErr) {
            applyState.errors.push({ entityName: label, reason: `Percepto validation error: ${valErr}` });
            console.warn(`${TAG} apply: ${label} — validation error: ${valErr}`);
            await closeEditor(); // best-effort cleanup
            return { ok: false, reason: `validation: ${valErr}`, appliedCount };
        }
        if (!saved) {
            applyState.errors.push({ entityName: label, reason: 'save timed out (no editor close)' });
            console.warn(`${TAG} apply: ${label} — save did NOT close editor within timeout`);
            return { ok: false, reason: 'save timed out', appliedCount };
        }
        // Editor closed cleanly + no validation error toast = save
        // succeeded. We deliberately don't re-fetch and compare values:
        // Percepto stores INTEGER meters internally, so a write of
        // 39 ft (11.887 m) round-trips back as 11 m → 36 ft, or 12 m
        // → 39 ft, depending on Percepto's rounding direction. Either
        // way it's ~3 ft "off" from what we wrote, and that's noise —
        // not a real failure. The bulk-altitude-updater this pipeline
        // is modeled on doesn't verify either, and it's been solid.
        console.log(`${TAG} apply: ${label} — SAVED ✓`);
        return { ok: true, reason: '', appliedCount, verified: true };
    }
    let sumPanelState = {
        search: '',
        typeFilter: new Set(['3', '4', '15', '16', '19']), // All types on by default
        validatedOnly: false,
        unvalidatedOnly: false,
        unshieldedOnly: false,
        notesOnly: false,
        // v3.84: numeric range filters {colKey: {min, max}} in METERS.
        // Task-specific (like search) — in-memory + captured into presets,
        // not GM-persisted globally.
        numericFilters: {},
        unitsFt: true,             // false → display meters
        // Default sort = by type-priority (FP → FFZ → NFZ → Asset → Marker),
        // then A→Z within each type group. Sort by 'typePrio' uses the
        // numeric priority; the secondary tie-break by name happens in
        // filterAndSortRows when sortKey === 'typePrio'.
        sortKey: 'typePrio',
        sortDir: 1,
        x: null, y: null,          // last drag position (px from viewport)
        w: 720, h: null,           // last drag size (null = use default max-height)
        selectedIds: new Set(),    // multi-select state — keys are rowKey strings (entity.id OR `${entity.id}:${arc.id}` for FP segment rows)
        // v3.47: per-entity visibility state we drive via Percepto's
        // sidebar checkboxes. Map<entityId, boolean>. Missing entries
        // default to visible=true. Session-only; reset on site change.
        // Percepto resets its own state when an editor closes, so this
        // can desync — that's accepted (user re-M2s as needed).
        visibility: new Map(),
        visibilitySite: null,      // siteID this Map belongs to
        // Ordered list of visible column keys. Persisted to GM_setValue
        // so it survives reloads. Hidden columns are simply absent from
        // this array. Reorder via ↑/↓ in the Columns ▾ menu.
        columnOrder: loadColumnOrder(),
        // v3.83: per-column widths the user dragged (px). {} = all defaults.
        columnWidths: loadColumnWidths(),
        // Persistent: when ON, the SUM panel drops a small purple dot
        // on the Leaflet map for every sample point used to compute
        // each row's elevation. Off by default to keep the map clean.
        showSamples: elevGmGet(CACHE_KEY_SHOW_SAMPLES, false),
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
        // Clear any sample-point markers when the panel closes — they'd
        // be dangling without the toggle to manage them. Toggle state
        // itself persists, so reopening with showSamples=true rebuilds.
        hideSampleMarkers();
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
        const out = [];
        (bucket.entities || []).forEach(e => {
            const reg = typeReg(e.type);
            // Flight paths (type 15) explode into one row PER arc/segment.
            // Naming: `${fp.name} - Seg ${i+1}`. Sort + filter + multi-select
            // operate on segments as first-class rows. Single-arc FPs still
            // get the "- Seg 1" suffix for consistency. FPs with no arcs
            // fall back to a single parent-only row so the FP still appears
            // (rare edge case: corrupt JSON).
            if (e.type === 15 && Array.isArray(e.arcs) && e.arcs.length > 0) {
                e.arcs.forEach((arc, i) => {
                    const samples = sampleAlongSegment(
                        arc.point_a, arc.point_b, segmentSampleCount(arc.distance),
                    );
                    const elevM = maxCachedElevation(samples);
                    const minA = typeof arc.min_alt === 'number' ? arc.min_alt : null;
                    const maxA = typeof arc.max_alt === 'number' ? arc.max_alt : null;
                    out.push({
                        entity: e,
                        arc,                                       // segment-specific data
                        _arcIndex: i,                              // position in entity.arcs — stable across Percepto saves (arc IDs aren't)
                        _segId: arc.id != null ? arc.id : null,    // arc.id from Percepto JSON — NOT stable; regenerates on FP save
                        _isSegment: true,
                        _rowKey: `${e.id}:${arc.id != null ? arc.id : i}`,
                        type: e.type,
                        typeShort: reg.short,
                        typePrio: reg.sortPrio,
                        name: `${e.name || ''} - Seg ${i + 1}`,
                        subtype: '',
                        altMinM: minA,
                        altMaxM: maxA,
                        altDeltaM: (minA != null && maxA != null) ? (maxA - minA) : null,
                        elevationM: elevM,                         // MAX DEM across segment samples
                        aglM: (minA != null && elevM != null) ? (minA - elevM) : null,
                        _samplePoints: samples,                    // multi-point sampling for bulk DEM fetch
                        validated: reg.hasValidStatus ? !!e.validated : null,
                        unshielded: !!e.is_unshielded,
                        hasNotes: !!(e.description && String(e.description).trim()),
                        // v3.82 columns. Emergency ceiling + segment length are
                        // per-arc. Notes come from the parent FP (shared across
                        // its segments). Equipment/state/gmGroup don't apply to
                        // FP segments — left undefined → blank cell.
                        emergAltM: typeof arc.min_emergency_alt === 'number' ? arc.min_emergency_alt : null,
                        segLenM: typeof arc.distance === 'number' ? arc.distance
                            : (arc.point_a && arc.point_b ? approxMeters(arc.point_a.lat, arc.point_a.lng, arc.point_b.lat, arc.point_b.lng) : null),
                        notesText: e.description ? String(e.description).trim() : '',
                    });
                });
                return;
            }
            // Everything else (Assets, FFZ, NFZ, Markers) = one row per entity.
            // Sample points walk the polygon perimeter (vertex + edge
            // midpoints + long-edge subdivisions). For markers, just the
            // single coord. Asset rows still override elevationM with
            // their claimed elevation_asl below; the DEM samples populate
            // the cache for future use but don't overwrite the asset's
            // claimed value.
            const samples = getSamplePointsForEntity(e);
            const row = {
                entity: e,
                _isSegment: false,
                _rowKey: String(e.id),
                type: e.type,
                typeShort: reg.short,
                typePrio: reg.sortPrio,
                name: e.name || '',
                subtype: '',
                altMinM: null,
                altMaxM: null,
                altDeltaM: null,
                elevationM: null,
                aglM: null,
                _samplePoints: samples,
                validated: reg.hasValidStatus ? !!e.validated : null,
                unshielded: !!e.is_unshielded,
                hasNotes: !!(e.description && String(e.description).trim()),
                // v3.82 columns. notesText is the raw description; equipment/
                // state (assets) + gmGroup (markers) are parsed below. emergAlt/
                // segLen are FP-segment-only → null here.
                notesText: e.description ? String(e.description).trim() : '',
                equipment: '',
                state: '',
                gmGroup: '',
                emergAltM: null,
                segLenM: null,
            };
            if (e.type === 3 && e.custom) {
                row.subtype = e.custom.poi_type_str || '';
                if (typeof e.custom.elevation_asl === 'number') {
                    row.elevationM = e.custom.elevation_asl;
                }
            }
            // NFZ (4) and FFZ (16) both store altitude range in restrictions.
            if ((e.type === 4 || e.type === 16) && e.restrictions && typeof e.restrictions === 'object') {
                if (typeof e.restrictions.minAlt === 'number') row.altMinM = e.restrictions.minAlt;
                if (typeof e.restrictions.maxAlt === 'number') row.altMaxM = e.restrictions.maxAlt;
                if (row.altMinM != null && row.altMaxM != null) row.altDeltaM = row.altMaxM - row.altMinM;
            }
            if (e.type === 19) row.subtype = e.general_marker_type || '';
            // v3.82: parse Equipment + State from the asset subtype, and
            // GM Group from the marker name — mirrors computeSiteStats so the
            // columns read identically to the 📊 Stats popup. Equipment = head
            // before " - "; State = first modifier after " - " (no modifier =
            // "Normal", the baseline-good state). GM Group = name with trailing
            // numeric tokens stripped ("Elevator 1"/"Elevator 2" → "Elevator").
            if (e.type === 3 && row.subtype) {
                const parts = row.subtype.split(' - ');
                row.equipment = prettyKey((parts[0] || '').trim());
                const mods = parts.slice(1).map(s => prettyKey(s.trim())).filter(Boolean);
                row.state = mods.length ? mods.join(' + ') : 'Normal';
            }
            if (e.type === 19) row.gmGroup = gmBaseName(e.name || '');
            // Point coordinate — only single-point entities (GMs type 19,
            // Assets type 3) have a meaningful lat/lng. Polygons/lines leave
            // these null so the Lat/Long/GPS cells render blank.
            if ((e.type === 19 || e.type === 3) && Array.isArray(e.coords) && e.coords[0]
                && typeof e.coords[0].lat === 'number') {
                row._lat = e.coords[0].lat;
                row._lng = e.coords[0].lng;
            }
            // For non-asset rows, elevation = MAX DEM across sample
            // points (asset row already populated above from its
            // claimed elevation_asl — that takes priority).
            if (e.type !== 3) {
                const maxDem = maxCachedElevation(samples);
                if (maxDem != null) row.elevationM = maxDem;
            }
            if (row.altMinM != null && row.elevationM != null) {
                row.aglM = row.altMinM - row.elevationM;
            }
            out.push(row);
        });
        return out;
    }

    // ---- Route from basestation (Phase 3, v3.90) ----
    // Operational model (per user): drone leaves the base (which sits in its
    // own FFZ) → flies connected FP segments → reaches the ASSET's inspection
    // FFZ → must traverse the FULL FFZ to its far edge. All one-way.
    //   • Base = type-8 installed base(s) if present, else GM named /base/i.
    //     With multiple bases, each asset routes from the CLOSEST (min route).
    //   • Reachable = an FFZ lies within REACH_FFZ_FT of the asset AND a flight
    //     path actually reaches that FFZ (an FP vertex inside it). Otherwise the
    //     asset is unreachable (no route).
    //   • Distance = base→nearest FP vertex (straight) + on-network (Dijkstra)
    //     to the FP vertex inside the asset's FFZ + that entry → the FFZ's far
    //     edge (the full-FFZ traversal).
    const REACH_FFZ_FT = 70;            // asset pad EDGE → FFZ gate (starting value; tunable)
    const ENTRY_FFZ_FT = 25;            // FP vertex counts as reaching an FFZ if inside or within this (ft)
    function loadBaseGmMap() {
        const m = elevGmGet(CACHE_KEY_BASE_GM, {});
        return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
    }
    function setBaseGmId(siteID, gmId) {
        const m = loadBaseGmMap();
        if (gmId == null) delete m[String(siteID)];
        else m[String(siteID)] = gmId;
        elevGmSet(CACHE_KEY_BASE_GM, m);
    }
    function gmPoint(e) {
        return (e && Array.isArray(e.coords) && e.coords[0] && typeof e.coords[0].lat === 'number')
            ? { lat: e.coords[0].lat, lng: e.coords[0].lng } : null;
    }
    // Resolve the basestation entities for a site. A stored override pins ONE
    // (type-8 or GM). Otherwise: all type-8 installed bases, else all GMs named
    // /base/i. Returns { bases: [entity…], auto: boolean }.
    function resolveBases(siteID, entities) {
        const stored = loadBaseGmMap()[String(siteID)];
        if (stored != null) {
            const e = (entities || []).find(x => (x.type === 8 || x.type === 19) && x.id === stored && gmPoint(x));
            if (e) return { bases: [e], auto: false };
        }
        const type8 = (entities || []).filter(e => e.type === 8 && gmPoint(e));
        if (type8.length) return { bases: type8, auto: true };
        const gmBases = (entities || []).filter(e => e.type === 19 && e.name && /base/i.test(e.name) && gmPoint(e));
        return { bases: gmBases, auto: true };
    }
    // Annotate ASSET rows in-place with routeM (base→FFZ-far-edge, meters,
    // following connected flight paths) + breakdown + the base used. Returns a
    // summary for the base-picker UI.
    function annotateRoutes(siteID, rows) {
        const bucket = mapObjectsBySite[siteID];
        const entities = bucket ? (bucket.entities || []) : [];
        const summary = { bases: [], baseAuto: true, graphVerts: 0, reachable: 0, unreachable: 0, reason: '' };
        const resolved = resolveBases(siteID, entities);
        summary.bases = resolved.bases; summary.baseAuto = resolved.auto;
        if (!resolved.bases.length) { summary.reason = 'no-base'; return summary; }
        const graph = buildFlightPathGraph(entities);
        summary.graphVerts = graph.verts.size;
        if (graph.verts.size === 0) { summary.reason = 'no-flight-paths'; return summary; }
        // Per base: nearest FP vertex + Dijkstra map + base→vertex connector.
        const baseRuns = resolved.bases.map(b => {
            const pt = gmPoint(b);
            if (!pt) return null;
            const bv = nearestGraphVertex(graph, pt.lat, pt.lng);
            return { entity: b, baseConn: bv.dist, dist: dijkstraFrom(graph, bv.key) };
        }).filter(Boolean);
        if (!baseRuns.length) { summary.reason = 'base-no-coord'; return summary; }
        // FFZ polygons + flat list of FP vertices (for in-FFZ entry detection).
        const ffzs = entities.filter(e => e.type === 16 && Array.isArray(e.coords) && e.coords.length >= 3);
        const fpVerts = [];
        graph.verts.forEach((v, k) => fpVerts.push({ key: k, lat: v.lat, lng: v.lng }));
        const reachM = REACH_FFZ_FT / 3.28084;
        const entryMarginM = ENTRY_FFZ_FT / 3.28084;
        rows.forEach(r => {
            if (r.type !== 3 || r._isSegment) return;
            // Asset FOOTPRINT: the pad polygon (multiple coords) or its single
            // point. Measure from ANY edge/vertex of the pad, NOT the center —
            // the center can sit 100+ ft inside the pad, so center-only
            // distance wrongly excludes assets whose FFZ hugs the pad edge.
            const ac = (r.entity && Array.isArray(r.entity.coords) && r.entity.coords.length)
                ? r.entity.coords
                : (typeof r._lat === 'number' ? [{ lat: r._lat, lng: r._lng }] : null);
            if (!ac) return;
            const padToFfz = (ring) => {
                let best = Infinity;
                ac.forEach(c => { const d = pointToPolygonMeters(c.lat, c.lng, ring); if (d < best) best = d; });
                return best;
            };
            // 1. Asset's FFZ = nearest FFZ within REACH_FFZ_FT of the pad edge.
            let ffz = null, ffzD = Infinity;
            ffzs.forEach(f => {
                const d = padToFfz(f.coords);
                if (d < ffzD) { ffzD = d; ffz = f; }
            });
            if (!ffz || ffzD > reachM) { r.routeM = null; r._routeReason = 'no-ffz'; summary.unreachable++; return; }
            r._ffzEntity = ffz;
            // 2. Entry candidates = FP vertices inside the FFZ OR within
            //    ENTRY_FFZ_FT of it (an FP that reaches the pad, vertex-at-edge
            //    included — strict inside-only missed edge-terminating FPs).
            const entries = fpVerts.filter(v => pointToPolygonMeters(v.lat, v.lng, ffz.coords) <= entryMarginM);
            if (!entries.length) { r.routeM = null; r._routeReason = 'ffz-no-fp'; summary.unreachable++; return; }
            // 3. Route = min over (base, entry) of baseConn + net(entry) +
            //    (entry → FFZ far edge). Closest base + best entry win.
            let best = null;
            baseRuns.forEach(br => {
                entries.forEach(en => {
                    const net = br.dist.has(en.key) ? br.dist.get(en.key) : null;
                    if (net == null) return;
                    let far = 0;
                    ffz.coords.forEach(p => { const dd = approxMeters(en.lat, en.lng, p.lat, p.lng); if (dd > far) far = dd; });
                    const total = br.baseConn + net + far;
                    if (!best || total < best.total) best = { total, base: br.entity, inM: br.baseConn, netM: net, ffzM: far };
                });
            });
            if (!best) { r.routeM = null; r._routeReason = 'unreachable'; summary.unreachable++; return; }
            r.routeM = best.total;
            r._routeBreak = { inM: best.inM, netM: best.netM, ffzM: best.ffzM };
            r._routeBase = best.base;
            r._routeReason = '';
            summary.reachable++;
        });
        return summary;
    }

    // v3.84: numeric range filters. Each meter-valued column can be range-
    // filtered. Values are stored in METERS in sumPanelState.numericFilters[key]
    // = {min, max}; the menu shows/accepts them in the current display unit.
    const NUMERIC_FILTER_COLS = [
        { key: 'altMin',    label: 'Min Alt',   dataKey: 'altMinM' },
        { key: 'altMax',    label: 'Max Alt',   dataKey: 'altMaxM' },
        { key: 'emergAlt',  label: 'Emerg Alt', dataKey: 'emergAltM' },
        { key: 'altDelta',  label: 'Delta',     dataKey: 'altDeltaM' },
        { key: 'elevation', label: 'Elevation', dataKey: 'elevationM' },
        { key: 'agl',       label: 'AGL',       dataKey: 'aglM' },
        { key: 'segLen',    label: 'Seg Len',   dataKey: 'segLenM' },
        { key: 'route',     label: 'Route',     dataKey: 'routeM' },
    ];
    const NUMERIC_FILTER_DATAKEY = Object.fromEntries(NUMERIC_FILTER_COLS.map(c => [c.key, c.dataKey]));
    // How many range filters are actually active (have a min and/or max).
    function activeNumericFilterCount(nf) {
        if (!nf) return 0;
        let n = 0;
        for (const k in nf) { const f = nf[k]; if (f && (f.min != null || f.max != null)) n++; }
        return n;
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
            // v3.84: numeric range filters (stored in METERS). A row with no
            // value for an active metric is excluded — an AGL range hides
            // Asset/Marker rows (no AGL); a Seg Len range hides all but FP segs.
            const nf = state.numericFilters;
            if (nf) {
                for (const k in nf) {
                    const f = nf[k];
                    if (!f || (f.min == null && f.max == null)) continue;
                    const dk = NUMERIC_FILTER_DATAKEY[k];
                    if (!dk) continue;
                    const v = r[dk];
                    if (v == null) return false;
                    if (f.min != null && v < f.min) return false;
                    if (f.max != null && v > f.max) return false;
                }
            }
            if (q) {
                // Matches name, subtype, OR Seg ID (segment rows only).
                // Seg ID stringified so partial matches work — searching
                // "2571" hits arc 2571233, 2571234, etc.
                const matches = r.name.toLowerCase().includes(q)
                    || r.subtype.toLowerCase().includes(q)
                    || (r._segId != null && String(r._segId).includes(q));
                if (!matches) return false;
            }
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

    // ============================================================
    // SITE SETUP ANALYZER (v3.30) — KML EXPORT
    //
    // Generates a Google-Earth-ready KML of the entire site setup
    // from in-memory mapObjectsBySite data (no extra fetch needed).
    // Two modes:
    //   2D — everything clamped to ground (flat polygons)
    //   3D — FFZ/NFZ extruded boxes from min_alt to max_alt,
    //        FP segments at min_alt, Assets extruded at claimed elev,
    //        plus optional V-Buffer overlays below FP min_alt + FFZ
    //
    // Output structure (improved over the Python source):
    //   Document
    //     Styles (compact short IDs)
    //     Folder: Assets
    //     Folder: Flight Paths
    //       Folder per FP > Placemark per segment
    //     Folder: Free-Fly Zones
    //     Folder: No-Fly Zones
    //     Folder: General Markers (consolidated, w/ subfolders by type)
    //     [3D] Folder: Vertical Buffers > FFZ & FP sub-folders
    // ============================================================
    const KML_FT = 3.28084;
    const KML_FT_TO_M = 1 / KML_FT;
    const KML_BUFFER_OFFSET_FT = 50;  // V-buffer is 50 ft below min_alt

    // ---- Power-line KML import via Map Styler broadcast (v3.34) ----
    // Map Styler caches parsed KML features for each site's distro +
    // transmission lines. We request them on demand via a dedicated
    // BroadcastChannel so the Site Setup Analyzer can include them as
    // folders in the exported KML without re-fetching from GitHub.
    let powerLinesKml = { siteID: null, distro: [], trans: [], receivedAt: 0 };
    let powerLinesChannel = null;
    function setupPowerLinesChannel() {
        if (powerLinesChannel) return;
        try { powerLinesChannel = new BroadcastChannel('AIM_KML_DATA'); }
        catch (e) { return; }
        powerLinesChannel.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type !== 'KML_FEATURES_RESPONSE') return;
            powerLinesKml = {
                siteID: m.siteID,
                distro: Array.isArray(m.distro) ? m.distro : [],
                trans: Array.isArray(m.trans) ? m.trans : [],
                receivedAt: Date.now(),
            };
            console.log(`${TAG} got KML features from Map Styler v${m.fromVersion || '?'} for site ${m.siteID}: ${powerLinesKml.distro.length} distro + ${powerLinesKml.trans.length} trans`);
        };
    }
    function requestPowerLinesKml(siteID) {
        setupPowerLinesChannel();
        if (!powerLinesChannel || !siteID) return;
        powerLinesChannel.postMessage({ type: 'REQUEST_KML_FEATURES', siteID });
    }
    // Returns true if we have fresh-enough power line data for this site.
    function hasPowerLinesFor(siteID) {
        return powerLinesKml.siteID === siteID
            && (powerLinesKml.distro.length > 0 || powerLinesKml.trans.length > 0);
    }
    // Render a single Map Styler feature as KML. Features are
    // { type: 'line'|'polygon', coords: [{lat,lng},...], pmIdx, visible }.
    // In 3D, lines are raised to `heightFt` above local terrain
    // (relativeToGround) so they sit at realistic wire altitude for
    // visual drone-clearance planning. Defaults:
    //   Distribution: 35 ft (Permian Basin typical 30-45 ft)
    //   Transmission: 80 ft (varies 40-150 ft by voltage class)
    function kmlPowerLineFeature(feat, mode, heightFt) {
        if (!feat || !Array.isArray(feat.coords) || feat.coords.length < 2) return '';
        if (feat.visible === false) return '';
        if (mode === '3D' && typeof heightFt === 'number' && heightFt > 0) {
            const altM = heightFt * KML_FT_TO_M;
            if (feat.type === 'line') {
                return `<LineString><altitudeMode>relativeToGround</altitudeMode><coordinates>${kmlCoords(feat.coords, altM)}</coordinates></LineString>`;
            }
            if (feat.type === 'polygon') {
                const ring = closeRing(feat.coords);
                return `<Polygon><altitudeMode>relativeToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, altM)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
            }
            return '';
        }
        // 2D mode — ground-clamped.
        if (feat.type === 'line') {
            return `<LineString><altitudeMode>clampToGround</altitudeMode><coordinates>${kmlCoords(feat.coords, 0)}</coordinates></LineString>`;
        }
        if (feat.type === 'polygon') {
            const ring = closeRing(feat.coords);
            return `<Polygon><altitudeMode>clampToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, 0)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
        }
        return '';
    }
    // Setup channel at script load — Map Styler may broadcast for an
    // existing request before our modal opens.
    setupPowerLinesChannel();
    // Style palette ported from Stand_Alone_AIM_SS_Generator_V8.pyw —
    // these are the AIM-matching colors coworkers are used to seeing in
    // both Percepto and the Python KML output. KML color = aabbggrr.
    //   Freezone        = ff00ff00  GREEN
    //   No-fly          = ff0000ff  RED
    //   Flight Path     = ffffff00  CYAN
    //   Asset           = ffffffff  WHITE
    //   Vertical Buf    = ff00ffff  YELLOW
    //   Horizontal Buf  = ff00a5ff  ORANGE
    // Per-mode variants: 3D uses translucent fill (33xxxxxx), 2D uses
    // no fill (<fill>0</fill>) so polygons read as outlines on terrain.
    function buildKmlStyles(mode) {
        const m3 = mode === '3D';
        const fillFreezone   = m3 ? '<color>3300ff00</color>' : '<fill>0</fill>';
        const fillNFZ        = m3 ? '<color>330000ff</color>' : '<fill>0</fill>';
        const fillAsset      = m3 ? '<color>33ffffff</color>' : '<fill>0</fill>';
        return [
            '<Style id="asset_style"><LineStyle><color>ffffffff</color><width>1</width></LineStyle><PolyStyle>' + fillAsset + '</PolyStyle></Style>',
            '<Style id="freezone_style"><LineStyle><color>ff00ff00</color><width>2</width></LineStyle><PolyStyle>' + fillFreezone + '</PolyStyle></Style>',
            '<Style id="nofly_style"><LineStyle><color>ff0000ff</color><width>2</width></LineStyle><PolyStyle>' + fillNFZ + '</PolyStyle></Style>',
            '<Style id="flightpath_style"><LineStyle><color>ffffff00</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>',
            '<Style id="generalmarker-general_style"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/paddle/purple-circle.png</href></Icon></IconStyle></Style>',
            '<Style id="generalmarker-tower_style"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/flag.png</href></Icon></IconStyle></Style>',
            '<Style id="generalmarker-hazard_style"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/caution.png</href></Icon></IconStyle></Style>',
            // GM radius circles — purple outline (ties to the purple GM
            // icon), faint purple fill so the ring reads without hiding
            // what's underneath. KML aabbggrr: ff f020a0 = full-alpha
            // purple outline; 30 f020a0 = ~19% fill.
            '<Style id="gmradius_style"><LineStyle><color>fff020a0</color><width>2</width></LineStyle><PolyStyle><color>30f020a0</color></PolyStyle></Style>',
            // Same purple outline, no fill — used when multiple rings are
            // drawn so overlapping fills don't muddy the map.
            '<Style id="gmradius_outline_style"><LineStyle><color>fff020a0</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>',
            // V-Buffer: BLUE (moved from yellow — yellow is now reserved
            // for distro power lines per Exxon Powerlines KML standard).
            // KML color aabbggrr: ffff0000 = full alpha + pure blue.
            '<Style id="verticalbuffer_style"><LineStyle><color>ffff0000</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>',
            '<Style id="horizontalbuffer_style"><LineStyle><color>ff00a5ff</color><width>2</width></LineStyle><PolyStyle><color>4D00a5ff</color></PolyStyle></Style>',
            // Power lines — Exxon Powerlines KML standard colors:
            //   distro = YELLOW thin lines, ~50% opacity (8000ffff)
            //   trans  = RED slightly thicker, ~70% opacity (b30000ff)
            // KML format is aabbggrr: alpha+blue+green+red.
            '<Style id="powerline_distro_style"><LineStyle><color>8000ffff</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>',
            '<Style id="powerline_trans_style"><LineStyle><color>b30000ff</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>',
        ].join('\n');
    }
    // Escape XML-unsafe chars for use in element text + attributes.
    function xmlEscape(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    }
    // KML wants `lng,lat,alt` triples space-separated. Defaults alt=0.
    function kmlCoords(points, alt) {
        if (!Array.isArray(points)) return '';
        return points.filter(p => p && typeof p.lat === 'number' && typeof p.lng === 'number')
            .map(p => `${p.lng},${p.lat},${alt != null ? alt : 0}`)
            .join(' ');
    }
    // Polygon ring needs explicit closing coord (first == last).
    function closeRing(points) {
        if (!Array.isArray(points) || points.length < 2) return points;
        const first = points[0], last = points[points.length - 1];
        if (first.lat === last.lat && first.lng === last.lng) return points;
        return points.concat([first]);
    }
    // Closed polygon ring approximating a circle of `radiusM` meters
    // around (lat,lng). Equirectangular projection — accurate to well
    // under a meter at site scale (sub-km radii). Returns segments+1
    // points (last == first, already closed). 48 segments reads as a
    // smooth circle in Google Earth.
    function kmlCircleRing(lat, lng, radiusM, segments) {
        const n = segments || 48;
        const mPerDegLat = 111320;
        const mPerDegLng = 111320 * Math.cos(lat * Math.PI / 180) || 1e-9;
        const pts = [];
        for (let i = 0; i <= n; i++) {
            const theta = (i / n) * 2 * Math.PI;
            const dx = radiusM * Math.sin(theta); // east
            const dy = radiusM * Math.cos(theta); // north
            pts.push({ lat: lat + dy / mPerDegLat, lng: lng + dx / mPerDegLng });
        }
        return pts;
    }
    // GM radius circle as a ground-clamped Polygon. Flat circle on the
    // ground regardless of 2D/3D mode — it's a horizontal buffer.
    function kmlGmCircleGeometry(item, radiusM) {
        const c = (Array.isArray(item.coords) && item.coords[0]) || null;
        if (!c) return '';
        const ring = kmlCircleRing(c.lat, c.lng, radiusM, 48);
        return `<Polygon><altitudeMode>clampToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, 0)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    }
    // Format a dual-line "Label (AGL): ftAGL / mAGL | (MSL): ftMSL / mMSL"
    // entry — matches Python's _format_alt_line output exactly. Bold ft
    // values stand out against m secondary readout.
    function fmtAltLineKML(label, aglM, mslM) {
        const aglFt = aglM * KML_FT;
        const mslFt = mslM * KML_FT;
        return `<b>${label} (AGL):</b> <b><font color="#00008B">${aglFt.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ft</font></b> / ${aglM.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m | <b>(MSL):</b> <b><font color="#00008B">${mslFt.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ft</font></b> / ${mslM.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m`;
    }
    // PER-ENTITY ground elevation (MSL) — uses the DEM data we ALREADY
    // fetch via the SUM panel's bulk-elevation pipeline. Each entity's
    // ground reference is the MAX DEM value across its own sample
    // points (consistent with how AGL is computed in the SUM panel).
    // Falls back to null if DEM hasn't loaded yet for this entity.
    function kmlEntityGroundElevation(item) {
        const samples = getSamplePointsForEntity(item);
        return maxCachedElevation(samples);
    }
    function kmlArcGroundElevation(arc) {
        if (!arc || !arc.point_a || !arc.point_b) return null;
        const samples = sampleAlongSegment(
            arc.point_a, arc.point_b, segmentSampleCount(arc.distance),
        );
        return maxCachedElevation(samples);
    }

    // Build the CDATA description for an entity placemark. Uses PER-
    // ENTITY ground elevation (max DEM at this entity's sample points)
    // for accurate AGL math — not a global "site datum" guess. Raw
    // item.description is preserved verbatim so Percepto's asset
    // designation header stays intact.
    function kmlDescription(item, opts) {
        const parts = [];
        // 1. Original description from Percepto (asset designation, etc.)
        if (item.description && String(item.description).trim()) {
            parts.push(xmlEscape(String(item.description).trim()));
        }
        // 2. Object Details — per-entity ground elevation + altitudes
        const details = ['<b>--- Object Details ---</b>'];
        const groundM = kmlEntityGroundElevation(item);
        if (groundM != null) {
            const groundFt = groundM * KML_FT;
            details.push(`<b>Ground Elevation (here):</b> <b><font color="#00008B">${groundFt.toLocaleString('en-US', { maximumFractionDigits: 0 })} ft</font></b> / ${groundM.toLocaleString('en-US', { maximumFractionDigits: 1 })} m MSL`);
        }
        // Altitudes — FFZ/NFZ from restrictions, Asset from custom
        let minAltM = null, maxAltM = null;
        if (item.type === 4 || item.type === 16) {
            if (item.restrictions) {
                minAltM = item.restrictions.minAlt;
                maxAltM = item.restrictions.maxAlt;
            }
        } else if (item.type === 3 && item.custom) {
            if (typeof item.custom.elevation_asl === 'number') {
                const aslM = item.custom.elevation_asl;
                const groundDiffM = groundM != null ? (aslM - groundM) : null;
                const groundDiffFt = groundDiffM != null ? (groundDiffM * KML_FT) : null;
                let line = `<b>Asset Elevation:</b> <b><font color="#00008B">${(aslM * KML_FT).toLocaleString('en-US', { maximumFractionDigits: 0 })} ft</font></b> / ${aslM.toLocaleString('en-US', { maximumFractionDigits: 1 })} m MSL`;
                if (groundDiffFt != null) {
                    line += ` (${groundDiffFt >= 0 ? '+' : ''}${groundDiffFt.toFixed(0)} ft vs ground here)`;
                }
                details.push(line);
            }
            if (typeof item.custom.relative_alt === 'number' && item.custom.relative_alt > 0) {
                details.push(`<b>Height AGL:</b> ${(item.custom.relative_alt * KML_FT).toFixed(0)} ft / ${item.custom.relative_alt.toFixed(1)} m`);
            }
        }
        if (minAltM != null) {
            const aglM = groundM != null ? (minAltM - groundM) : null;
            details.push(fmtAltLineKMLOptionalAgl('Min Altitude', aglM, minAltM));
        }
        if (maxAltM != null) {
            const aglM = groundM != null ? (maxAltM - groundM) : null;
            details.push(fmtAltLineKMLOptionalAgl('Max Altitude', aglM, maxAltM));
        }
        if (item.is_unshielded) details.push('<b><font color="#ff6060">⚠ Unshielded</font></b>');
        parts.push(details.join('<br><br>'));
        return `<![CDATA[${parts.join('<br><br>')}]]>`;
    }
    // AGL line that gracefully omits the AGL half if ground elevation
    // wasn't available for this entity (DEM cache miss). Avoids
    // showing meaningless "Min Altitude (AGL): 3,056 ft" when AGL == MSL.
    function fmtAltLineKMLOptionalAgl(label, aglM, mslM) {
        const mslFt = mslM * KML_FT;
        const mslPart = `<b><font color="#00008B">${mslFt.toLocaleString('en-US', { maximumFractionDigits: 0 })} ft</font></b> / ${mslM.toLocaleString('en-US', { maximumFractionDigits: 1 })} m MSL`;
        if (aglM == null) {
            return `<b>${label}:</b> ${mslPart}`;
        }
        const aglFt = aglM * KML_FT;
        const aglPart = `<b><font color="#00008B">${aglFt.toLocaleString('en-US', { maximumFractionDigits: 0 })} ft</font></b> / ${aglM.toLocaleString('en-US', { maximumFractionDigits: 1 })} m AGL`;
        return `<b>${label} (AGL):</b> ${aglPart} | <b>(MSL):</b> ${mslPart}`;
    }
    // FP arc description — per-segment ground elevation + altitudes.
    function kmlArcDescription(fp, arc, idx, opts) {
        const parts = [`<b>Parent Path:</b> <a href="#pm_${fp.id};flyto">${xmlEscape(fp.name)}</a>`];
        const details = ['<b>--- Object Details ---</b>'];
        const groundM = kmlArcGroundElevation(arc);
        if (groundM != null) {
            const groundFt = groundM * KML_FT;
            details.push(`<b>Ground Elevation (along segment):</b> <b><font color="#00008B">${groundFt.toLocaleString('en-US', { maximumFractionDigits: 0 })} ft</font></b> / ${groundM.toLocaleString('en-US', { maximumFractionDigits: 1 })} m MSL`);
        }
        if (typeof arc.distance === 'number') {
            details.push(`<b>Segment Length:</b> ${(arc.distance * KML_FT).toFixed(0)} ft / ${arc.distance.toFixed(1)} m`);
        }
        if (typeof arc.min_alt === 'number') {
            const aglM = groundM != null ? (arc.min_alt - groundM) : null;
            details.push(fmtAltLineKMLOptionalAgl('Min Altitude', aglM, arc.min_alt));
        }
        if (typeof arc.max_alt === 'number') {
            const aglM = groundM != null ? (arc.max_alt - groundM) : null;
            details.push(fmtAltLineKMLOptionalAgl('Max Altitude', aglM, arc.max_alt));
        }
        if (arc.wait_until_approved === true) {
            details.push('<b><font color="#ff9800">⚠ Approval Required</font></b>');
        }
        parts.push(details.join('<br><br>'));
        return `<![CDATA[${parts.join('<br><br>')}]]>`;
    }
    // Asset polygon. Python uses absolute altitude with site_ground_elev
    // baked in — but that requires accurate terrain data we don't always
    // have. We use `relativeToGround` instead: Google Earth follows the
    // actual terrain at the asset's exact location, so assets sit ON
    // the ground regardless of whether our site datum is correct.
    // Height: 20 ft (bumped from Python's 10 ft per user preference).
    function kmlAssetGeometry(item, mode) {
        if (!Array.isArray(item.coords) || item.coords.length < 3) {
            if (item.coords && item.coords[0]) {
                return `<Point><altitudeMode>clampToGround</altitudeMode><coordinates>${kmlCoords([item.coords[0]])}</coordinates></Point>`;
            }
            return '';
        }
        const ring = closeRing(item.coords);
        if (mode === '3D') {
            const altM = 20 * KML_FT_TO_M; // 20 ft above terrain
            return `<Polygon><extrude>1</extrude><altitudeMode>relativeToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, altM)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
        }
        return `<Polygon><altitudeMode>clampToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, 0)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    }
    // FFZ polygon in 3D = full extruded BOX = bottom cap + top cap +
    // one rectangular wall per edge. All in a MultiGeometry so Google
    // Earth renders the solid 3D volume. Matches Python output structure.
    function kmlFreezoneGeometry(item, mode) {
        if (!Array.isArray(item.coords) || item.coords.length < 3) return '';
        const ring = closeRing(item.coords);
        if (mode === '3D') {
            const r = item.restrictions || {};
            if (r.minAlt == null) return ''; // Python skips FFZ without min_alt
            const minA = r.minAlt;
            const maxA = r.maxAlt != null ? r.maxAlt : minA + 37; // ~120 ft default span if missing
            const faces = [];
            // Bottom cap at min_alt
            faces.push(`<Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, minA)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`);
            // Top cap at max_alt
            faces.push(`<Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, maxA)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`);
            // One wall polygon per edge: rectangle p1-p2 (bottom) ↔ p2-p1 (top)
            const coords = item.coords; // unclosed (not the ring)
            for (let i = 0; i < coords.length; i++) {
                const p1 = coords[i];
                const p2 = coords[(i + 1) % coords.length];
                const wall = `${p1.lng},${p1.lat},${minA} ${p2.lng},${p2.lat},${minA} ${p2.lng},${p2.lat},${maxA} ${p1.lng},${p1.lat},${maxA} ${p1.lng},${p1.lat},${minA}`;
                faces.push(`<Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${wall}</coordinates></LinearRing></outerBoundaryIs></Polygon>`);
            }
            return `<MultiGeometry>${faces.join('')}</MultiGeometry>`;
        }
        return `<Polygon><altitudeMode>clampToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, 0)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    }
    // NFZ polygon. 3D = polygon at 400 ft above terrain (relativeToGround)
    // with extrude=1, so Google Earth draws walls from the polygon down
    // to actual ground level — gives a 400ft tall column following the
    // real terrain underneath. 2D = ground-clamped.
    function kmlNFZGeometry(item, mode) {
        if (!Array.isArray(item.coords) || item.coords.length < 3) return '';
        const ring = closeRing(item.coords);
        if (mode === '3D') {
            const altM = 400 * KML_FT_TO_M;
            return `<Polygon><extrude>1</extrude><altitudeMode>relativeToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, altM)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
        }
        return `<Polygon><altitudeMode>clampToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, 0)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    }
    // FP segment. Python rule: 3D = rectangular VERTICAL WALL polygon
    // spanning min_alt → max_alt over the arc footprint. NOT a flat
    // line — gives the FP visible height in Google Earth so users can
    // see the vertical envelope. 2D = ground-clamped LineString.
    function kmlArcGeometry(arc, mode) {
        if (!arc || !arc.point_a || !arc.point_b) return '';
        const p1 = arc.point_a, p2 = arc.point_b;
        if (mode === '3D' && typeof arc.min_alt === 'number' && typeof arc.max_alt === 'number') {
            const wall = `${p1.lng},${p1.lat},${arc.min_alt} ${p2.lng},${p2.lat},${arc.min_alt} ${p2.lng},${p2.lat},${arc.max_alt} ${p1.lng},${p1.lat},${arc.max_alt} ${p1.lng},${p1.lat},${arc.min_alt}`;
            return `<MultiGeometry><Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${wall}</coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry>`;
        }
        return `<LineString><altitudeMode>clampToGround</altitudeMode><coordinates>${kmlCoords([p1, p2], 0)}</coordinates></LineString>`;
    }
    // Marker as a Point.
    function kmlMarkerGeometry(item, mode) {
        const c = (Array.isArray(item.coords) && item.coords[0]) || null;
        if (!c) return '';
        if (mode === '3D' && typeof item.marker_height === 'number' && item.marker_height > 0) {
            return `<Point><extrude>1</extrude><altitudeMode>relativeToGround</altitudeMode><coordinates>${c.lng},${c.lat},${item.marker_height}</coordinates></Point>`;
        }
        return `<Point><altitudeMode>clampToGround</altitudeMode><coordinates>${c.lng},${c.lat},0</coordinates></Point>`;
    }
    // V-Buffer geometry for an FFZ — same polygon shape, offset below min_alt.
    function kmlVBufferZone(item) {
        if (!Array.isArray(item.coords) || item.coords.length < 3) return '';
        if (!item.restrictions || item.restrictions.minAlt == null) return '';
        const ring = closeRing(item.coords);
        const alt = item.restrictions.minAlt - (KML_BUFFER_OFFSET_FT / KML_FT);
        return `<Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(ring, alt)}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    }
    // V-Buffer geometry for an FP segment — same line, offset below min_alt.
    function kmlVBufferArc(arc) {
        if (!arc || !arc.point_a || !arc.point_b || typeof arc.min_alt !== 'number') return '';
        const alt = arc.min_alt - (KML_BUFFER_OFFSET_FT / KML_FT);
        return `<LineString><altitudeMode>absolute</altitudeMode><coordinates>${kmlCoords([arc.point_a, arc.point_b], alt)}</coordinates></LineString>`;
    }
    // Mark-pin marker style by general_marker_type.
    function kmlMarkerStyleId(item) {
        const t = (item.general_marker_type || 'general').toLowerCase();
        if (t === 'tower') return 's_mk_tower';
        if (t === 'hazard') return 's_mk_hazard';
        return 's_mk_general';
    }
    // Main entry point — builds the entire KML string.
    function buildSiteKML(siteID, options) {
        const { mode, include, siteName } = options;
        const bucket = mapObjectsBySite[siteID];
        if (!bucket) return null;
        const entities = bucket.entities || [];
        // Site datum elevation (MSL) — three-tier fallback:
        //   1. Average of all asset `custom.elevation_asl` values
        //      (assets store real MSL elevations from Percepto, the
        //      most reliable source — no DEM cache dependency).
        //   2. Average of DEM-cached entity centroids (if asset elev
        //      is missing or sparse — works when SUM panel has been
        //      open long enough for the bulk fetch to populate).
        //   3. 0 (last-resort; description omits site datum line).
        let siteDatumM = 0;
        const assetAlts = entities
            .filter(e => e.type === 3 && e.custom && typeof e.custom.elevation_asl === 'number')
            .map(e => e.custom.elevation_asl);
        if (assetAlts.length > 0) {
            siteDatumM = assetAlts.reduce((s, v) => s + v, 0) / assetAlts.length;
        } else {
            let demSum = 0, demCount = 0;
            entities.forEach(e => {
                const c = getEntityCentroid(e);
                if (!c) return;
                const v = getElevationFromCache(c.lat, c.lng);
                if (v != null) { demSum += v; demCount++; }
            });
            if (demCount > 0) siteDatumM = demSum / demCount;
        }
        const opts = { siteDatumM };

        // Bucket entities by type for folder construction
        const byType = { 3: [], 4: [], 15: [], 16: [], 19: { general: [], tower: [], hazard: [] } };
        entities.forEach(e => {
            if (e.type === 19) {
                const t = (e.general_marker_type || 'general').toLowerCase();
                if (t === 'tower') byType[19].tower.push(e);
                else if (t === 'hazard') byType[19].hazard.push(e);
                else byType[19].general.push(e);
            } else if (byType[e.type] !== undefined) {
                byType[e.type].push(e);
            }
        });

        const xml = [];
        xml.push('<?xml version="1.0" encoding="UTF-8"?>');
        xml.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
        xml.push(`<Document><name>${xmlEscape(siteName || `Site ${siteID}`)} (${mode})</name>`);
        xml.push(`<description><![CDATA[Generated by AIM Asset Inspector v${SCRIPT_VERSION} · ${new Date().toISOString().slice(0, 10)}<br>Site datum: ${(siteDatumM * KML_FT).toFixed(1)} ft / ${siteDatumM.toFixed(1)} m MSL]]></description>`);
        xml.push(buildKmlStyles(mode));

        // Folder structure ports the Python tool's exact layout —
        // separate top-level folders for each entity type so Google
        // Earth's tree matches what coworkers are used to seeing in
        // the PYW output.

        // Assets
        if (include.assets && byType[3].length > 0) {
            xml.push('<Folder><name>Asset</name>');
            byType[3].forEach(e => {
                const geom = kmlAssetGeometry(e, mode);
                if (!geom) return;
                xml.push(`<Placemark id="pm_${e.id}"><name>${xmlEscape(e.name)}</name><description>${kmlDescription(e, opts)}</description><styleUrl>#asset_style</styleUrl>${geom}</Placemark>`);
            });
            xml.push('</Folder>');
        }
        // Flight Paths — each FP is its own subfolder of placemarks (one per arc)
        if (include.fps && byType[15].length > 0) {
            xml.push('<Folder><name>Flight Path</name>');
            byType[15].forEach(e => {
                const arcs = Array.isArray(e.arcs) ? e.arcs : [];
                xml.push(`<Folder id="fp_${e.id}"><name>${xmlEscape(e.name)}</name>`);
                arcs.forEach((arc, i) => {
                    const geom = kmlArcGeometry(arc, mode);
                    if (!geom) return;
                    const pmName = mode === '3D' ? `${e.name} - Segment ${arc.id != null ? arc.id : (i + 1)}` : e.name;
                    xml.push(`<Placemark id="arc_${arc.id != null ? arc.id : i}"><name>${xmlEscape(pmName)}</name><description>${kmlArcDescription(e, arc, i, opts)}</description><styleUrl>#flightpath_style</styleUrl>${geom}</Placemark>`);
                });
                xml.push('</Folder>');
            });
            xml.push('</Folder>');
        }
        // Freezone
        if (include.ffzs && byType[16].length > 0) {
            xml.push('<Folder><name>Freezone</name>');
            byType[16].forEach(e => {
                const geom = kmlFreezoneGeometry(e, mode);
                if (!geom) return;
                xml.push(`<Placemark id="pm_${e.id}"><name>${xmlEscape(e.name)}</name><description>${kmlDescription(e, opts)}</description><styleUrl>#freezone_style</styleUrl>${geom}</Placemark>`);
            });
            xml.push('</Folder>');
        }
        // No-fly Zones
        if (include.nfzs && byType[4].length > 0) {
            xml.push('<Folder><name>No-fly</name>');
            byType[4].forEach(e => {
                const geom = kmlNFZGeometry(e, mode);
                if (!geom) return;
                xml.push(`<Placemark id="pm_${e.id}"><name>${xmlEscape(e.name)}</name><description>${kmlDescription(e, opts)}</description><styleUrl>#nofly_style</styleUrl>${geom}</Placemark>`);
            });
            xml.push('</Folder>');
        }
        // General Markers — separate top-level folders per subtype to
        // match Python output ("General Marker - Tower" etc.). This
        // makes the Google Earth tree filterable per subtype like
        // coworkers expect.
        if (include.markers) {
            const subTypes = [
                { label: 'General Marker - General', items: byType[19].general, styleId: 'generalmarker-general_style' },
                { label: 'General Marker - Tower',   items: byType[19].tower,   styleId: 'generalmarker-tower_style' },
                { label: 'General Marker - Hazard',  items: byType[19].hazard,  styleId: 'generalmarker-hazard_style' },
            ];
            subTypes.forEach(s => {
                if (s.items.length === 0) return;
                xml.push(`<Folder><name>${s.label}</name>`);
                s.items.forEach(e => {
                    const geom = kmlMarkerGeometry(e, mode);
                    if (!geom) return;
                    xml.push(`<Placemark id="pm_${e.id}"><name>${xmlEscape(e.name)}</name><description>${kmlDescription(e, opts)}</description><styleUrl>#${s.styleId}</styleUrl>${geom}</Placemark>`);
                });
                xml.push('</Folder>');
            });
        }
        // General Marker radius circles — OFF by default. One or more
        // horizontal buffer rings (clamped to ground) around every GM
        // regardless of subtype. Radii are user-configurable (default a
        // single 0.5-mi ring). Each radius gets its own subfolder so the
        // Google Earth tree is filterable per ring. A single ring gets a
        // faint fill; multiple rings render as outlines only.
        if (include.gmCircles) {
            const rings = (Array.isArray(options.gmRings) && options.gmRings.length > 0)
                ? options.gmRings
                : [{ meters: 804.672, label: '0.5 mi' }];
            const allGms = byType[19].general.concat(byType[19].tower, byType[19].hazard);
            if (allGms.length > 0) {
                const styleId = rings.length > 1 ? 'gmradius_outline_style' : 'gmradius_style';
                xml.push('<Folder><name>General Marker Radius Circles</name>');
                rings.forEach((ring, ri) => {
                    const radiusM = (typeof ring.meters === 'number' && ring.meters > 0) ? ring.meters : 804.672;
                    const radLabel = ring.label || `${(radiusM / 1609.344).toFixed(2)} mi`;
                    xml.push(`<Folder><name>${xmlEscape(radLabel)}</name>`);
                    allGms.forEach(e => {
                        const geom = kmlGmCircleGeometry(e, radiusM);
                        if (!geom) return;
                        xml.push(`<Placemark id="gmcircle_${e.id}_r${ri}"><name>${xmlEscape(e.name)} - ${xmlEscape(radLabel)} radius</name><styleUrl>#${styleId}</styleUrl>${geom}</Placemark>`);
                    });
                    xml.push('</Folder>');
                });
                xml.push('</Folder>');
            }
        }
        // Power Lines — pulled from Map Styler's loaded KML data via
        // BroadcastChannel. Two separate folders (Distribution, Trans-
        // mission) matching Map Styler's category split. Only emitted
        // when the requested data has actually arrived for THIS site
        // (avoids stale data from a previous site nav).
        if (include.powerlines && hasPowerLinesFor(siteID)) {
            const distroN = powerLinesKml.distro.length;
            const transN = powerLinesKml.trans.length;
            const distroHt = (typeof options.distroHeightFt === 'number' && options.distroHeightFt >= 0) ? options.distroHeightFt : 35;
            const transHt = (typeof options.transHeightFt === 'number' && options.transHeightFt >= 0) ? options.transHeightFt : 80;
            if (distroN > 0) {
                const htLabel = mode === '3D' ? ` @ ${distroHt} ft AGL` : '';
                xml.push(`<Folder><name>Power Lines - Distribution (${distroN})${htLabel}</name>`);
                powerLinesKml.distro.forEach((feat, i) => {
                    const geom = kmlPowerLineFeature(feat, mode, distroHt);
                    if (!geom) return;
                    xml.push(`<Placemark id="distro_${i}"><name>Distro line ${i + 1}</name><styleUrl>#powerline_distro_style</styleUrl>${geom}</Placemark>`);
                });
                xml.push('</Folder>');
            }
            if (transN > 0) {
                const htLabel = mode === '3D' ? ` @ ${transHt} ft AGL` : '';
                xml.push(`<Folder><name>Power Lines - Transmission (${transN})${htLabel}</name>`);
                powerLinesKml.trans.forEach((feat, i) => {
                    const geom = kmlPowerLineFeature(feat, mode, transHt);
                    if (!geom) return;
                    xml.push(`<Placemark id="trans_${i}"><name>Trans line ${i + 1}</name><styleUrl>#powerline_trans_style</styleUrl>${geom}</Placemark>`);
                });
                xml.push('</Folder>');
            }
        }
        // 3D-only: Vertical Buffers — separate FFZ + FP folders (matches Python)
        if (mode === '3D' && include.vbuffers) {
            const ffzWithMin = byType[16].filter(e => e.restrictions && e.restrictions.minAlt != null);
            if (ffzWithMin.length > 0) {
                xml.push('<Folder><name>Freezone Vertical Buffers</name>');
                ffzWithMin.forEach(e => {
                    const geom = kmlVBufferZone(e);
                    if (!geom) return;
                    xml.push(`<Placemark id="vbuffer_pm_${e.id}"><name>${xmlEscape(e.name)} - VBuffer</name><styleUrl>#verticalbuffer_style</styleUrl>${geom}</Placemark>`);
                });
                xml.push('</Folder>');
            }
            const fpWithArcs = byType[15].filter(e => Array.isArray(e.arcs) && e.arcs.length > 0);
            if (fpWithArcs.length > 0) {
                xml.push('<Folder><name>Flight Path Vertical Buffers</name>');
                fpWithArcs.forEach(e => {
                    e.arcs.forEach((arc, i) => {
                        const geom = kmlVBufferArc(arc);
                        if (!geom) return;
                        xml.push(`<Placemark id="vbuffer_arc_${arc.id != null ? arc.id : i}"><name>${xmlEscape(e.name)} - Segment ${arc.id != null ? arc.id : (i + 1)} - VBuffer</name><styleUrl>#verticalbuffer_style</styleUrl>${geom}</Placemark>`);
                    });
                });
                xml.push('</Folder>');
            }
        }
        xml.push('</Document></kml>');
        return xml.join('\n');
    }
    // Trigger a browser file download of `content` as a .kml file.
    //
    // Percepto loads us into a sandboxed iframe with allow-scripts +
    // allow-same-origin but NOT allow-downloads. anchor.click() with
    // a download attribute is blocked from inside that iframe. The
    // workaround is to do the WHOLE thing (blob creation + anchor +
    // click) in the TOP window's context — the parent frame isn't
    // sandboxed. Same-origin so we can reach into it.
    //
    // Falls through to a same-frame attempt if window.top isn't
    // reachable (e.g. cross-origin parent) and that fails too →
    // returns false so the caller can fall back to clipboard.
    function downloadKMLFile(filename, content) {
        const tryDownload = (win, doc) => {
            const blob = new win.Blob([content], { type: 'application/vnd.google-earth.kml+xml' });
            const url = win.URL.createObjectURL(blob);
            const a = doc.createElement('a');
            a.href = url;
            a.download = filename;
            doc.body.appendChild(a);
            a.click();
            setTimeout(() => {
                try { win.URL.revokeObjectURL(url); } catch (e) {}
                try { a.remove(); } catch (e) {}
            }, 100);
        };
        try {
            const topWin = window.top || window;
            tryDownload(topWin, topWin.document);
            return true;
        } catch (e) {
            console.warn(`${TAG} download via top frame failed (${e && e.message}); retrying in-frame`);
        }
        try {
            tryDownload(window, document);
            return true;
        } catch (e) {
            console.warn(`${TAG} download failed entirely:`, e);
            return false;
        }
    }

    // Site Setup Analyzer modal — KML format toggle + folder
    // checkboxes + download/copy buttons. Floating draggable like
    // the Stats popup; closes on Cancel or outside-click.
    const ANALYZER_MODAL_ID = 'aim-ai-analyzer-modal';
    function openSiteAnalyzer(siteID) {
        closeSiteAnalyzer();
        const bucket = mapObjectsBySite[siteID];
        if (!bucket || !bucket.entities) {
            showToast('No site data loaded', 'rgba(255,82,82,0.6)');
            return;
        }
        const entities = bucket.entities;
        const counts = {
            assets: entities.filter(e => e.type === 3).length,
            fps: entities.filter(e => e.type === 15).length,
            ffzs: entities.filter(e => e.type === 16).length,
            nfzs: entities.filter(e => e.type === 4).length,
            markers: entities.filter(e => e.type === 19).length,
        };
        const m = document.createElement('div');
        m.id = ANALYZER_MODAL_ID;
        m.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        const box = document.createElement('div');
        box.style.cssText = 'background:#1f2228;border:1px solid rgba(122,223,230,0.5);border-radius:8px;padding:20px 24px;min-width:480px;max-width:90vw;max-height:90vh;overflow-y:auto;color:#e6e6e6;box-shadow:0 8px 32px rgba(0,0,0,0.7)';
        const siteName = getCurrentSiteName() || `Site ${siteID}`;
        box.innerHTML = `
            <div style="color:#7adfe6;font-weight:700;font-size:15px;margin-bottom:4px">🗺️ Site Setup Analyzer</div>
            <div style="color:#888;font-size:11px;margin-bottom:14px">${xmlEscape(siteName)} · ${entities.length} entities · KML export</div>
            <div style="margin-bottom:14px">
                <div style="font-size:11px;color:#9ad;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Format</div>
                <label style="display:inline-flex;align-items:center;gap:6px;margin-right:18px;cursor:pointer"><input type="radio" name="aim-ai-kml-mode" value="3D" checked style="accent-color:#7adfe6"> 3D (extruded, V-Buffers)</label>
                <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="aim-ai-kml-mode" value="2D" style="accent-color:#7adfe6"> 2D (clamped to ground)</label>
            </div>
            <div style="margin-bottom:14px">
                <div style="font-size:11px;color:#9ad;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Include folders</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;font-size:12px">
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-inc="assets" checked style="accent-color:#7adfe6"> Assets (${counts.assets})</label>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-inc="fps" checked style="accent-color:#7adfe6"> Flight Paths (${counts.fps})</label>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-inc="ffzs" checked style="accent-color:#7adfe6"> Free-Fly Zones (${counts.ffzs})</label>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-inc="nfzs" checked style="accent-color:#7adfe6"> No-Fly Zones (${counts.nfzs})</label>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-inc="markers" checked style="accent-color:#7adfe6"> General Markers (${counts.markers})</label>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer" id="aim-ai-gmcircles-label"><input type="checkbox" data-inc="gmCircles" style="accent-color:#7adfe6"> GM Radius Circles</label>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer" id="aim-ai-vbuffers-label"><input type="checkbox" data-inc="vbuffers" checked style="accent-color:#7adfe6"> Vertical Buffers (3D only)</label>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer" id="aim-ai-powerlines-label"><input type="checkbox" data-inc="powerlines" checked style="accent-color:#7adfe6"> Power Lines <span id="aim-ai-pl-status" style="color:#888;font-size:10px">(requesting…)</span></label>
                </div>
            </div>
            <div id="aim-ai-pl-heights" style="margin-bottom:14px;padding:8px 10px;background:rgba(255,213,79,0.05);border:1px dashed rgba(255,213,79,0.25);border-radius:3px">
                <div style="font-size:11px;color:#ffd54f;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Power line heights (3D only)</div>
                <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px">
                    <label style="display:flex;align-items:center;gap:6px"><span style="color:#cfd6dc">Distribution:</span><input type="number" id="aim-ai-distro-ht" value="35" min="0" max="200" step="5" style="width:60px;background:#1a1d23;border:1px solid rgba(255,213,79,0.45);color:#fff;padding:3px 6px;border-radius:3px;font:inherit;font-size:11px;text-align:right"><span style="color:#888">ft AGL</span></label>
                    <label style="display:flex;align-items:center;gap:6px"><span style="color:#cfd6dc">Transmission:</span><input type="number" id="aim-ai-trans-ht" value="80" min="0" max="300" step="5" style="width:60px;background:#1a1d23;border:1px solid rgba(255,213,79,0.45);color:#fff;padding:3px 6px;border-radius:3px;font:inherit;font-size:11px;text-align:right"><span style="color:#888">ft AGL</span></label>
                </div>
                <div style="color:#888;font-size:10px;margin-top:6px;line-height:1.4">Permian Basin: distro typically 30-45 ft (35 default), trans 40-150 ft depending on voltage (80 default for safety). Adjust per-site.</div>
            </div>
            <div id="aim-ai-gm-radius" style="display:none;margin-bottom:14px;padding:8px 10px;background:rgba(240,32,160,0.06);border:1px dashed rgba(240,32,160,0.30);border-radius:3px">
                <div style="font-size:11px;color:#f070c0;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">GM radius circles</div>
                <div id="aim-ai-gm-rings"></div>
                <button id="aim-ai-gm-add-ring" type="button" style="margin-top:2px;background:rgba(240,32,160,0.12);color:#f070c0;border:1px solid rgba(240,32,160,0.45);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;font-weight:600">+ Add ring</button>
                <div style="color:#888;font-size:10px;margin-top:6px;line-height:1.4">Each ring draws a flat ground circle of that radius around every General Marker. With one ring it gets a faint fill; with multiple, rings render as outlines only. Off by default.</div>
            </div>
            <div id="aim-ai-kml-stats" style="color:#9ad;font-size:11px;margin-bottom:10px;padding:6px 8px;background:rgba(122,223,230,0.08);border-radius:3px"></div>
            <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
                <button id="aim-ai-kml-cancel" style="background:transparent;color:#888;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:8px 14px;cursor:pointer;font:inherit;font-size:12px">Close</button>
                <button id="aim-ai-kml-copy" style="background:rgba(122,223,230,0.15);color:#7adfe6;border:1px solid rgba(122,223,230,0.55);border-radius:3px;padding:8px 14px;cursor:pointer;font:inherit;font-size:12px">📋 Copy to clipboard</button>
                <button id="aim-ai-kml-dl" style="background:rgba(95,255,95,0.15);color:#5fff5f;border:1px solid rgba(95,255,95,0.55);border-radius:3px;padding:8px 18px;cursor:pointer;font:inherit;font-size:12px;font-weight:600">⬇ Download .kml</button>
            </div>
        `;
        m.appendChild(box);
        document.body.appendChild(m);
        m.onclick = (ev) => { if (ev.target === m) closeSiteAnalyzer(); };

        const readOpts = () => {
            const mode = box.querySelector('input[name="aim-ai-kml-mode"]:checked').value;
            const include = {};
            box.querySelectorAll('input[data-inc]').forEach(cb => {
                include[cb.dataset.inc] = cb.checked;
            });
            const distroIn = box.querySelector('#aim-ai-distro-ht');
            const transIn = box.querySelector('#aim-ai-trans-ht');
            const distroHeightFt = distroIn ? parseFloat(distroIn.value) : 35;
            const transHeightFt = transIn ? parseFloat(transIn.value) : 80;
            // GM radius circles — collect every ring row, convert value+unit
            // to meters. Skip blank/invalid rows. Fall back to one 0.5-mi ring.
            const gmRings = [];
            box.querySelectorAll('#aim-ai-gm-rings .aim-ai-gm-ring').forEach(row => {
                const raw = parseFloat(row.querySelector('.aim-ai-gm-ring-val').value);
                if (!isFinite(raw) || raw <= 0) return;
                const unit = row.querySelector('.aim-ai-gm-ring-unit').value;
                const meters = unit === 'ft' ? raw / KML_FT : raw * 1609.344;
                gmRings.push({ meters, label: unit === 'ft' ? `${raw} ft` : `${raw} mi` });
            });
            if (gmRings.length === 0) gmRings.push({ meters: 0.5 * 1609.344, label: '0.5 mi' });
            return {
                mode, include,
                distroHeightFt: isFinite(distroHeightFt) ? distroHeightFt : 35,
                transHeightFt: isFinite(transHeightFt) ? transHeightFt : 80,
                gmRings,
                siteName: `Site ${siteID} Map - ${siteName}`,
            };
        };
        const updateStats = () => {
            const opts = readOpts();
            const kml = buildSiteKML(siteID, opts);
            const sizeKb = kml ? (new Blob([kml]).size / 1024).toFixed(0) : 0;
            const stats = box.querySelector('#aim-ai-kml-stats');
            stats.textContent = `${opts.mode} export · ~${sizeKb} KB`;
        };
        // V-Buffers checkbox only relevant for 3D — show/hide based on mode.
        const updateVbufferVis = () => {
            const mode = box.querySelector('input[name="aim-ai-kml-mode"]:checked').value;
            const lbl = box.querySelector('#aim-ai-vbuffers-label');
            lbl.style.display = mode === '3D' ? '' : 'none';
            // Power line heights only matter in 3D — 2D is ground-clamped.
            const phts = box.querySelector('#aim-ai-pl-heights');
            if (phts) phts.style.display = mode === '3D' ? '' : 'none';
            updateStats();
        };
        // GM radius control block only shown when GM Radius Circles is on.
        const updateGmRadiusVis = () => {
            const cb = box.querySelector('input[data-inc="gmCircles"]');
            const blk = box.querySelector('#aim-ai-gm-radius');
            if (blk) blk.style.display = (cb && cb.checked) ? '' : 'none';
        };
        // GM radius rings — dynamic list. Each + adds a row defaulting to
        // the next preset (0.5 / 1 / 5 / 10 mi), then 10 mi thereafter.
        // The × removes a row; the last remaining row can't be removed.
        const GM_RING_PRESETS = [0.5, 1, 5, 10];
        const ringsHost = box.querySelector('#aim-ai-gm-rings');
        const syncRingDelButtons = () => {
            const rows = ringsHost.querySelectorAll('.aim-ai-gm-ring');
            rows.forEach(r => {
                const del = r.querySelector('.aim-ai-gm-ring-del');
                if (del) del.style.visibility = rows.length > 1 ? 'visible' : 'hidden';
            });
        };
        const addRingRow = (value, unit) => {
            const idx = ringsHost.querySelectorAll('.aim-ai-gm-ring').length;
            const v = (value != null) ? value : (GM_RING_PRESETS[idx] != null ? GM_RING_PRESETS[idx] : 10);
            const u = unit || 'mi';
            const row = document.createElement('div');
            row.className = 'aim-ai-gm-ring';
            row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:11px';
            row.innerHTML = `
                <span style="color:#cfd6dc">Radius:</span>
                <input type="number" class="aim-ai-gm-ring-val" value="${v}" min="0" step="0.1" style="width:70px;background:#1a1d23;border:1px solid rgba(240,32,160,0.45);color:#fff;padding:3px 6px;border-radius:3px;font:inherit;font-size:11px;text-align:right">
                <select class="aim-ai-gm-ring-unit" style="background:#1a1d23;border:1px solid rgba(240,32,160,0.45);color:#fff;padding:3px 6px;border-radius:3px;font:inherit;font-size:11px">
                    <option value="mi"${u === 'mi' ? ' selected' : ''}>miles</option>
                    <option value="ft"${u === 'ft' ? ' selected' : ''}>feet</option>
                </select>
                <button type="button" class="aim-ai-gm-ring-del" title="Remove ring" style="background:transparent;color:#f070c0;border:1px solid rgba(240,32,160,0.45);border-radius:3px;width:22px;height:22px;line-height:1;cursor:pointer;font:inherit;font-size:13px;padding:0">×</button>
            `;
            row.querySelector('.aim-ai-gm-ring-val').oninput = updateStats;
            row.querySelector('.aim-ai-gm-ring-unit').onchange = updateStats;
            row.querySelector('.aim-ai-gm-ring-del').onclick = () => {
                if (ringsHost.querySelectorAll('.aim-ai-gm-ring').length <= 1) return;
                row.remove();
                syncRingDelButtons();
                updateStats();
            };
            ringsHost.appendChild(row);
            syncRingDelButtons();
        };
        addRingRow(0.5, 'mi'); // seed first ring
        box.querySelector('#aim-ai-gm-add-ring').onclick = () => { addRingRow(); updateStats(); };
        // Live preview on height input changes.
        const dh = box.querySelector('#aim-ai-distro-ht');
        const th = box.querySelector('#aim-ai-trans-ht');
        if (dh) dh.oninput = updateStats;
        if (th) th.oninput = updateStats;
        box.querySelectorAll('input[name="aim-ai-kml-mode"]').forEach(r => r.onchange = updateVbufferVis);
        box.querySelectorAll('input[data-inc]').forEach(cb => cb.onchange = () => { updateGmRadiusVis(); updateStats(); });
        updateGmRadiusVis();
        updateVbufferVis();

        // Power Lines: request from Map Styler + poll for response.
        // Status text live-updates so the user sees "loaded N lines"
        // before they hit Download.
        const plStatus = box.querySelector('#aim-ai-pl-status');
        const plLabel = box.querySelector('#aim-ai-powerlines-label');
        const plCheckbox = plLabel.querySelector('input');
        const refreshPlStatus = () => {
            if (hasPowerLinesFor(siteID)) {
                const n = powerLinesKml.distro.length + powerLinesKml.trans.length;
                plStatus.textContent = `(loaded ${n} line${n === 1 ? '' : 's'})`;
                plStatus.style.color = '#5fff5f';
                plCheckbox.disabled = false;
                plLabel.style.opacity = '1';
                updateStats();
            } else {
                plStatus.textContent = '(not loaded — open Map Styler tab to fetch)';
                plStatus.style.color = '#888';
                plCheckbox.disabled = true;
                plLabel.style.opacity = '0.55';
            }
        };
        refreshPlStatus();
        // Kick off a request — Map Styler responds if it has the data.
        requestPowerLinesKml(siteID);
        // Poll for the response over 3 seconds so the UI updates without
        // the user having to wait/refresh.
        let plPollCount = 0;
        const plPoller = setInterval(() => {
            plPollCount++;
            refreshPlStatus();
            if (plPollCount > 15 || hasPowerLinesFor(siteID)) clearInterval(plPoller);
        }, 200);
        // Clean up the poller if the modal closes mid-poll.
        const origClose = closeSiteAnalyzer;
        // (No need to override — closeSiteAnalyzer just removes the el;
        //  the interval keeps firing harmlessly until count hits 15.
        //  Cheap enough at 200ms × 15 = 3s max wasted poll.)

        box.querySelector('#aim-ai-kml-cancel').onclick = closeSiteAnalyzer;
        box.querySelector('#aim-ai-kml-copy').onclick = () => {
            const opts = readOpts();
            const kml = buildSiteKML(siteID, opts);
            if (!kml) { showToast('Failed to build KML'); return; }
            copyToClipboard(kml, `Copied ${opts.mode} KML to clipboard (${(new Blob([kml]).size / 1024).toFixed(0)} KB)`);
        };
        box.querySelector('#aim-ai-kml-dl').onclick = () => {
            const opts = readOpts();
            const kml = buildSiteKML(siteID, opts);
            if (!kml) { showToast('Failed to build KML'); return; }
            // Filename: Site_<id>_Map_(<mode>).kml — matches Python pattern
            const fname = `Site_${siteID}_Map_(${opts.mode}).kml`;
            if (downloadKMLFile(fname, kml)) {
                showToast(`Downloaded ${fname}`, 'rgba(95,255,95,0.6)');
            } else {
                showToast('Download failed — try Copy to clipboard', 'rgba(255,82,82,0.6)');
            }
        };
    }
    function closeSiteAnalyzer() {
        const m = document.getElementById(ANALYZER_MODAL_ID);
        if (m) m.remove();
    }

    function renderSummaryPanel(siteID) {
        closeSummaryPanel();
        ensurePendingForSite(siteID);
        ensurePanelVisibility(siteID);
        const allRows = buildSummaryRows(siteID);
        // v3.88: annotate asset rows with route-from-base distance (one graph
        // build + one Dijkstra). routeSummary feeds the 📍 Base picker below.
        const routeSummary = annotateRoutes(siteID, allRows);
        // Hook for the async DEM fetch to refresh elevationM/aglM values on
        // existing rows + redraw once the bulk load completes. Captured
        // by closure here, called by kickOffDemFetch (defined outside
        // this function). One window-scoped reference is enough since
        // only one SUM panel can be open at a time.
        window.__aim_ai_onDemReady = () => {
            allRows.forEach(r => {
                if (!Array.isArray(r._samplePoints) || r._samplePoints.length === 0) return;
                // Asset rows: keep their CLAIMED elevation_asl, ignore DEM.
                if (r.type === 3 && r.entity && r.entity.custom
                    && typeof r.entity.custom.elevation_asl === 'number') return;
                const maxE = maxCachedElevation(r._samplePoints);
                if (maxE != null) {
                    r.elevationM = maxE;
                    if (r.altMinM != null) r.aglM = r.altMinM - maxE;
                }
            });
            if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
            // redrawTable re-renders markers with the now-loaded
            // elevations in their tooltips (replacing the placeholder
            // "(loading…)" text shown before the cache hit).
        };
        kickOffDemFetch(siteID, allRows);

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
        title.style.cssText = 'flex:1;color:#7adfe6;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        // Include the human-readable site name if the page header has
        // rendered it; otherwise fall back to just the ID. Ellipsis
        // for long names so the close button doesn't get pushed off.
        title.textContent = `AIM Entities · ${siteHeaderLabel(siteID)}`;
        title.title = title.textContent; // tooltip with full text on hover
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
        searchInput.placeholder = '🔍  Search name, subtype, or Seg ID…';
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
        // v3.44: chipUpdates collects every chip's update fn so M2-solo
        // can refresh ALL chips' visual state, not just the clicked one.
        const chipUpdates = [];
        chipDefs.forEach(({ tNum, label }) => {
            const reg = typeReg(parseInt(tNum, 10));
            const color = reg.color;
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.title = 'M1: toggle this type · M2: solo (only this type ON, rest OFF; M2 again restores all)';
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
            // v3.44: M2 = solo. If this type is already the only one ON,
            // restore all (undo solo). Otherwise clear + add just this one.
            chip.oncontextmenu = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const allTypes = chipDefs.map(d => d.tNum);
                const isSoloed = sumPanelState.typeFilter.size === 1 && sumPanelState.typeFilter.has(tNum);
                sumPanelState.typeFilter.clear();
                if (isSoloed) {
                    allTypes.forEach(t => sumPanelState.typeFilter.add(t));
                } else {
                    sumPanelState.typeFilter.add(tNum);
                }
                chipUpdates.forEach(fn => fn());
                redrawTable();
            };
            update();
            chipRow.appendChild(chip);
            chipUpdates.push(update);
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

        // Show-sample-points toggle (v3.20). When ON, drops a small
        // purple dot on the Leaflet map for every sample point used
        // to compute each (filtered) row's elevation. Persists across
        // panel reopens. Refreshes whenever the filtered row set
        // changes (driven from redrawTable below).
        const samplesLbl = document.createElement('label');
        samplesLbl.style.cssText = 'display:flex;align-items:center;gap:4px;color:#c4b5fd;font-size:11px;cursor:pointer;margin-left:6px';
        samplesLbl.title = 'Drop purple dots on the map at every sample location used for elevation. Hover a dot for its elevation.';
        const samplesCb = document.createElement('input');
        samplesCb.type = 'checkbox';
        samplesCb.checked = !!sumPanelState.showSamples;
        samplesCb.style.cssText = 'accent-color:#c4b5fd;cursor:pointer';
        samplesCb.onchange = () => {
            sumPanelState.showSamples = samplesCb.checked;
            elevGmSet(CACHE_KEY_SHOW_SAMPLES, sumPanelState.showSamples);
            if (samplesCb.checked) {
                showSampleMarkersFor(filterAndSortRows(allRows, sumPanelState));
            } else {
                hideSampleMarkers();
            }
        };
        samplesLbl.appendChild(samplesCb);
        samplesLbl.appendChild(document.createTextNode('Show elevation sample points on map'));
        optsRow.appendChild(samplesLbl);

        // "Summary" button — opens the site stats popup.
        const summaryBtn = document.createElement('button');
        summaryBtn.type = 'button';
        summaryBtn.textContent = '📊 Summary';
        summaryBtn.title = 'Statistical summary of all entities on this site';
        summaryBtn.style.cssText = 'background:rgba(20,210,220,0.15);color:#7adfe6;border:1px solid rgba(20,210,220,0.45);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;margin-left:8px';
        summaryBtn.onclick = (ev) => {
            ev.stopPropagation();
            openStatsPopup(siteID);
        };
        optsRow.appendChild(summaryBtn);

        // "Analyzer" button — opens the Site Setup Analyzer modal
        // (KML export pipeline). Placed next to Summary for visual grouping
        // (both are site-wide overview tools).
        const analyzerBtn = document.createElement('button');
        analyzerBtn.type = 'button';
        analyzerBtn.textContent = '🗺️ Analyzer';
        analyzerBtn.title = 'Site Setup Analyzer — export 2D / 3D KML for Google Earth';
        analyzerBtn.style.cssText = 'background:rgba(20,210,220,0.15);color:#7adfe6;border:1px solid rgba(20,210,220,0.45);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px';
        analyzerBtn.onclick = (ev) => {
            ev.stopPropagation();
            openSiteAnalyzer(siteID);
        };
        optsRow.appendChild(analyzerBtn);

        // v3.88: 📍 Base picker — choose the basestation GM used by the Route
        // column. Auto-detected (name contains "base") unless overridden per site.
        const baseBtn = document.createElement('button');
        baseBtn.type = 'button';
        baseBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px';
        const bases = (routeSummary && routeSummary.bases) || [];
        const baseLabelText = () => {
            if (!bases.length) return '📍 Base: (none) ▾';
            if (bases.length === 1) {
                const raw = bases[0].name || `#${bases[0].id}`;
                const nm = raw.length > 20 ? raw.slice(0, 19) + '…' : raw;
                return `📍 Base: ${nm}${routeSummary.baseAuto ? ' (auto)' : ''} ▾`;
            }
            return `📍 Base: ${bases.length} bases${routeSummary.baseAuto ? ' (auto)' : ''} ▾`;
        };
        baseBtn.textContent = baseLabelText();
        baseBtn.title = bases.length
            ? `Routing from ${bases.length === 1 ? `"${bases[0].name}"` : bases.length + ' bases (closest wins)'} — ${routeSummary.reachable} asset(s) reachable, ${routeSummary.unreachable} not. Click to change.`
            : (routeSummary && routeSummary.reason === 'no-flight-paths'
                ? 'No flight paths on this site — routing unavailable.'
                : 'No basestation found (no type-8 base, no GM named "…base…"). Click to pick one.');
        if (bases.length) { baseBtn.style.borderColor = 'rgba(20,210,220,0.55)'; baseBtn.style.color = '#7adfe6'; }
        let baseMenuEl = null;
        const closeBaseMenu = () => { if (baseMenuEl) { baseMenuEl.remove(); baseMenuEl = null; } };
        baseBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (baseMenuEl) { closeBaseMenu(); return; }
            baseMenuEl = document.createElement('div');
            baseMenuEl.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(20,210,220,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:6px 0;z-index:99999;font-size:11px;color:#e6e6e6;min-width:250px;max-height:60vh;overflow:auto';
            const bhead = document.createElement('div');
            bhead.style.cssText = 'font-size:9px;text-transform:uppercase;color:#14d2dc;letter-spacing:0.05em;padding:6px 12px 2px;font-weight:700';
            bhead.textContent = 'Basestation (for Route column)';
            baseMenuEl.appendChild(bhead);
            const bucket = mapObjectsBySite[siteID];
            const ents = bucket ? (bucket.entities || []) : [];
            const type8 = ents.filter(e => e.type === 8 && gmPoint(e));
            const gms = ents.filter(e => e.type === 19 && gmPoint(e));
            const overrideId = loadBaseGmMap()[String(siteID)];
            const mkBaseRow = (label, onPick, opts) => {
                opts = opts || {};
                const row = document.createElement('div');
                row.style.cssText = `display:flex;align-items:center;padding:3px 12px;cursor:pointer;${opts.accent ? 'color:' + opts.accent : ''}`;
                row.onmouseenter = () => { row.style.background = 'rgba(20,210,220,0.10)'; };
                row.onmouseleave = () => { row.style.background = 'transparent'; };
                const lbl = document.createElement('span');
                lbl.textContent = (opts.check ? '✓ ' : '') + label;
                lbl.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
                row.appendChild(lbl);
                row.onclick = onPick;
                return row;
            };
            const sect = (txt) => {
                const h = document.createElement('div');
                h.style.cssText = 'font-size:9px;text-transform:uppercase;color:#888;letter-spacing:0.05em;padding:5px 12px 2px;font-weight:700';
                h.textContent = txt;
                baseMenuEl.appendChild(h);
            };
            baseMenuEl.appendChild(mkBaseRow(`Auto-detect (installed type-8 base → else GM "…base…")`, () => {
                closeBaseMenu(); setBaseGmId(siteID, null); renderSummaryPanel(siteID);
            }, { check: overrideId == null, accent: '#cfe8ec' }));
            const bhr = document.createElement('div');
            bhr.style.cssText = 'border-top:1px solid rgba(255,255,255,0.10);margin:5px 0';
            baseMenuEl.appendChild(bhr);
            if (type8.length) {
                sect('Installed bases (type 8)');
                type8.forEach(g => baseMenuEl.appendChild(mkBaseRow(g.name || `#${g.id}`, () => {
                    closeBaseMenu(); setBaseGmId(siteID, g.id); renderSummaryPanel(siteID);
                }, { check: overrideId === g.id })));
            }
            sect('General Markers');
            if (!gms.length) {
                const empty = document.createElement('div');
                empty.style.cssText = 'padding:3px 12px;color:#888';
                empty.textContent = 'No General Markers on this site.';
                baseMenuEl.appendChild(empty);
            }
            gms.forEach(g => {
                baseMenuEl.appendChild(mkBaseRow(g.name || `#${g.id}`, () => {
                    closeBaseMenu(); setBaseGmId(siteID, g.id); renderSummaryPanel(siteID);
                }, { check: overrideId === g.id }));
            });
            const br = baseBtn.getBoundingClientRect();
            baseMenuEl.style.left = br.left + 'px';
            baseMenuEl.style.top = (br.bottom + 4) + 'px';
            document.body.appendChild(baseMenuEl);
            const bmr = baseMenuEl.getBoundingClientRect();
            if (bmr.right > window.innerWidth - 8) baseMenuEl.style.left = Math.max(8, window.innerWidth - bmr.width - 8) + 'px';
            if (bmr.bottom > window.innerHeight - 8) baseMenuEl.style.top = Math.max(8, br.top - bmr.height - 4) + 'px';
            const onDocClick = (e) => {
                if (baseMenuEl && !baseMenuEl.contains(e.target) && e.target !== baseBtn) {
                    closeBaseMenu();
                    document.removeEventListener('mousedown', onDocClick, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
        };
        optsRow.appendChild(baseBtn);

        // v3.84: Ranges menu — numeric range filters (min/max) per meter-valued
        // column. Values entered in the current display unit, stored in meters.
        const rangesBtn = document.createElement('button');
        rangesBtn.type = 'button';
        rangesBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;margin-left:auto';
        const updateRangesBtn = () => {
            const n = activeNumericFilterCount(sumPanelState.numericFilters);
            rangesBtn.textContent = n > 0 ? `Ranges (${n}) ▾` : 'Ranges ▾';
            rangesBtn.style.borderColor = n > 0 ? 'rgba(20,210,220,0.7)' : 'rgba(255,255,255,0.20)';
            rangesBtn.style.color = n > 0 ? '#7adfe6' : '#bbb';
        };
        updateRangesBtn();
        let rangesMenuEl = null;
        rangesBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (rangesMenuEl) { rangesMenuEl.remove(); rangesMenuEl = null; return; }
            rangesMenuEl = document.createElement('div');
            rangesMenuEl.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(20,210,220,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:6px 0;z-index:99999;font-size:11px;color:#e6e6e6;min-width:230px';
            const rebuildRangesMenu = () => {
                rangesMenuEl.innerHTML = '';
                const unit = sumPanelState.unitsFt ? 'ft' : 'm';
                const toDisp = (m) => {
                    if (m == null) return '';
                    const v = sumPanelState.unitsFt ? m * 3.28084 : m;
                    return String(Math.round(v * 10) / 10).replace(/\.0$/, '');
                };
                const fromDisp = (s) => {
                    const n = parseFloat(s);
                    if (!isFinite(n)) return null;
                    return sumPanelState.unitsFt ? n / 3.28084 : n;
                };
                const head = document.createElement('div');
                head.style.cssText = 'font-size:9px;text-transform:uppercase;color:#14d2dc;letter-spacing:0.05em;padding:6px 12px 4px;font-weight:700';
                head.textContent = `Numeric ranges (${unit})`;
                rangesMenuEl.appendChild(head);
                NUMERIC_FILTER_COLS.forEach(fc => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:5px;padding:3px 12px';
                    const lbl = document.createElement('span');
                    lbl.textContent = fc.label;
                    lbl.style.cssText = 'flex:0 0 64px;color:#cdd6e0';
                    row.appendChild(lbl);
                    const mkInput = (which, ph) => {
                        const inp = document.createElement('input');
                        inp.type = 'number';
                        inp.placeholder = ph;
                        const f = sumPanelState.numericFilters[fc.key] || {};
                        inp.value = toDisp(f[which]);
                        inp.style.cssText = 'width:56px;background:#15171b;border:1px solid rgba(255,255,255,0.2);border-radius:3px;color:#e6e6e6;font:inherit;font-size:11px;padding:2px 4px';
                        inp.onchange = () => {
                            const m = fromDisp(inp.value);
                            if (!sumPanelState.numericFilters[fc.key]) sumPanelState.numericFilters[fc.key] = { min: null, max: null };
                            sumPanelState.numericFilters[fc.key][which] = m;
                            const cur = sumPanelState.numericFilters[fc.key];
                            if (cur.min == null && cur.max == null) delete sumPanelState.numericFilters[fc.key];
                            redrawTable();
                            updateRangesBtn();
                        };
                        return inp;
                    };
                    row.appendChild(mkInput('min', 'min'));
                    const dash = document.createElement('span');
                    dash.textContent = '–';
                    dash.style.color = '#888';
                    row.appendChild(dash);
                    row.appendChild(mkInput('max', 'max'));
                    rangesMenuEl.appendChild(row);
                });
                const hr = document.createElement('div');
                hr.style.cssText = 'border-top:1px solid rgba(255,255,255,0.10);margin:6px 0';
                rangesMenuEl.appendChild(hr);
                const clearBtn = document.createElement('button');
                clearBtn.type = 'button';
                clearBtn.textContent = 'Clear all ranges';
                clearBtn.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.20);color:#bbb;border-radius:3px;padding:4px 10px;cursor:pointer;font:inherit;font-size:10px;display:block;margin:0 12px 4px';
                clearBtn.onclick = () => {
                    sumPanelState.numericFilters = {};
                    redrawTable();
                    updateRangesBtn();
                    rebuildRangesMenu();
                };
                rangesMenuEl.appendChild(clearBtn);
                const note = document.createElement('div');
                note.style.cssText = 'font-size:9px;color:#888;padding:0 12px 6px;max-width:230px;line-height:1.3';
                note.textContent = 'Rows with no value for a filtered metric are hidden (AGL hides assets; Seg Len shows only FP segments).';
                rangesMenuEl.appendChild(note);
            };
            rebuildRangesMenu();
            const r = rangesBtn.getBoundingClientRect();
            rangesMenuEl.style.left = r.left + 'px';
            rangesMenuEl.style.top = (r.bottom + 4) + 'px';
            document.body.appendChild(rangesMenuEl);
            const mr = rangesMenuEl.getBoundingClientRect();
            if (mr.right > window.innerWidth - 8) rangesMenuEl.style.left = (window.innerWidth - mr.width - 8) + 'px';
            if (mr.bottom > window.innerHeight - 8) rangesMenuEl.style.top = (r.top - mr.height - 4) + 'px';
            const onDocClick = (e) => {
                if (rangesMenuEl && !rangesMenuEl.contains(e.target) && e.target !== rangesBtn) {
                    rangesMenuEl.remove(); rangesMenuEl = null;
                    document.removeEventListener('mousedown', onDocClick, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
        };
        optsRow.appendChild(rangesBtn);

        // Columns menu — opens a small popover with one checkbox per column.
        // Hidden columns are also omitted from CSV/TSV exports.
        const colsBtn = document.createElement('button');
        colsBtn.type = 'button';
        colsBtn.textContent = 'Columns ▾';
        colsBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;margin-left:6px';
        let colsMenuEl = null;
        colsBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (colsMenuEl) { colsMenuEl.remove(); colsMenuEl = null; return; }
            colsMenuEl = document.createElement('div');
            // position:fixed so the menu doesn't extend the document scroll
            // region — `absolute` was pinning to the body and adding right-
            // edge / bottom-edge horizontal scrollbars to the page when the
            // menu sat near the panel's right corner.
            colsMenuEl.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(20,210,220,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:6px 0;z-index:99999;font-size:11px;color:#e6e6e6;min-width:240px';
            const COL_LABELS = {
                typeShort: 'Type',
                name:      'Name',
                segId:     'Segment ID',
                subtype:   'Subtype',
                equipment: 'Equipment (asset)',
                state:     'State / Health (asset)',
                gmGroup:   'GM Group',
                altMin:    'Min Alt',
                altMax:    'Max Alt',
                emergAlt:  'Emergency Alt (FP seg)',
                altDelta:  'Min/Max Delta',
                elevation: 'Elevation',
                agl:       'AGL (Min Alt − Elev)',
                segLen:    'Segment Length (FP seg)',
                route:     'Route from base (asset)',
                validated: 'Valid',
                unshielded:'Unshielded',
                notes:     'Notes',
            };
            // MBT-style menu: visible columns first with ↑/↓ reorder
            // arrows + remove checkbox, then a divider, then hidden
            // columns with an add checkbox. State persists per
            // user (GM_setValue). Re-renders the menu in place after
            // each change so the user can do multiple edits.
            function rebuildColsMenu() {
                colsMenuEl.innerHTML = '';
                const visible = sumPanelState.columnOrder.slice();
                const visSet = new Set(visible);
                const hidden = ALL_COL_KEYS.filter(k => !visSet.has(k));
                const head = document.createElement('div');
                head.style.cssText = 'font-size:9px;text-transform:uppercase;color:#14d2dc;letter-spacing:0.05em;padding:4px 12px 4px;font-weight:700';
                head.textContent = 'Visible (use ↑↓ to reorder)';
                colsMenuEl.appendChild(head);
                visible.forEach((key, i) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 12px';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = true;
                    cb.title = 'Hide column';
                    cb.style.cssText = 'accent-color:rgb(20,210,220);cursor:pointer';
                    cb.onchange = () => {
                        if (!cb.checked) {
                            sumPanelState.columnOrder = sumPanelState.columnOrder.filter(k => k !== key);
                            saveColumnOrder(sumPanelState.columnOrder);
                            redrawTable();
                            rebuildColsMenu();
                        }
                    };
                    row.appendChild(cb);
                    const lbl = document.createElement('span');
                    lbl.textContent = COL_LABELS[key] || key;
                    lbl.style.cssText = 'flex:1';
                    row.appendChild(lbl);
                    const arrowBtnStyle = 'background:transparent;border:1px solid rgba(255,255,255,0.20);color:#bbb;border-radius:3px;width:22px;height:20px;cursor:pointer;font-size:11px;padding:0;line-height:1';
                    const upBtn = document.createElement('button');
                    upBtn.textContent = '↑';
                    upBtn.title = 'Move up';
                    upBtn.style.cssText = arrowBtnStyle;
                    upBtn.disabled = i === 0;
                    if (upBtn.disabled) upBtn.style.opacity = '0.35';
                    upBtn.onclick = () => {
                        const arr = sumPanelState.columnOrder;
                        const idx = arr.indexOf(key);
                        if (idx > 0) {
                            arr.splice(idx, 1);
                            arr.splice(idx - 1, 0, key);
                            saveColumnOrder(arr);
                            redrawTable();
                            rebuildColsMenu();
                        }
                    };
                    const dnBtn = document.createElement('button');
                    dnBtn.textContent = '↓';
                    dnBtn.title = 'Move down';
                    dnBtn.style.cssText = arrowBtnStyle;
                    dnBtn.disabled = i === visible.length - 1;
                    if (dnBtn.disabled) dnBtn.style.opacity = '0.35';
                    dnBtn.onclick = () => {
                        const arr = sumPanelState.columnOrder;
                        const idx = arr.indexOf(key);
                        if (idx >= 0 && idx < arr.length - 1) {
                            arr.splice(idx, 1);
                            arr.splice(idx + 1, 0, key);
                            saveColumnOrder(arr);
                            redrawTable();
                            rebuildColsMenu();
                        }
                    };
                    row.appendChild(upBtn);
                    row.appendChild(dnBtn);
                    colsMenuEl.appendChild(row);
                });
                if (hidden.length > 0) {
                    const hr = document.createElement('div');
                    hr.style.cssText = 'border-top:1px solid rgba(255,255,255,0.10);margin:6px 0';
                    colsMenuEl.appendChild(hr);
                    const head2 = document.createElement('div');
                    head2.style.cssText = 'font-size:9px;text-transform:uppercase;color:#888;letter-spacing:0.05em;padding:2px 12px 4px;font-weight:700';
                    head2.textContent = 'Hidden';
                    colsMenuEl.appendChild(head2);
                    hidden.forEach(key => {
                        const row = document.createElement('label');
                        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 12px;cursor:pointer';
                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.checked = false;
                        cb.style.cssText = 'accent-color:rgb(20,210,220);cursor:pointer';
                        cb.onchange = () => {
                            if (cb.checked) {
                                sumPanelState.columnOrder.push(key);
                                saveColumnOrder(sumPanelState.columnOrder);
                                redrawTable();
                                rebuildColsMenu();
                            }
                        };
                        row.appendChild(cb);
                        row.appendChild(document.createTextNode(COL_LABELS[key] || key));
                        colsMenuEl.appendChild(row);
                    });
                }
                const hr2 = document.createElement('div');
                hr2.style.cssText = 'border-top:1px solid rgba(255,255,255,0.10);margin:6px 0';
                colsMenuEl.appendChild(hr2);
                const resetBtn = document.createElement('button');
                resetBtn.type = 'button';
                resetBtn.textContent = 'Reset to defaults';
                resetBtn.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.20);color:#bbb;border-radius:3px;padding:4px 10px;cursor:pointer;font:inherit;font-size:10px;display:block;margin:0 12px 4px';
                resetBtn.onclick = () => {
                    sumPanelState.columnOrder = DEFAULT_COL_KEYS.slice();
                    saveColumnOrder(sumPanelState.columnOrder);
                    redrawTable();
                    rebuildColsMenu();
                };
                colsMenuEl.appendChild(resetBtn);
            }
            rebuildColsMenu();
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

        // --- Presets menu — saved views (columns + filters + sort + units) ---
        // Per-user, global across sites. Lets the user flip to e.g. "GMs ·
        // Name/Lat/Long" to Copy → Sheets, then jump back to their usual view
        // without re-toggling every column/filter by hand.
        const presetsBtn = document.createElement('button');
        presetsBtn.type = 'button';
        presetsBtn.textContent = 'Presets ▾';
        presetsBtn.title = 'Saved views — columns, filters, and sort. Apply a preset, save the current view, or reset to default.';
        presetsBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px';
        let presetsMenuEl = null;
        let presetsDocClick = null;
        const closePresetsMenu = () => {
            if (presetsMenuEl) { presetsMenuEl.remove(); presetsMenuEl = null; }
            if (presetsDocClick) { document.removeEventListener('mousedown', presetsDocClick, true); presetsDocClick = null; }
        };
        presetsBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (presetsMenuEl) { closePresetsMenu(); return; }
            presetsMenuEl = document.createElement('div');
            presetsMenuEl.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(20,210,220,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:6px 0;z-index:99999;font-size:11px;color:#e6e6e6;min-width:260px;max-height:65vh;overflow:auto';
            const rebuildPresetsMenu = () => {
                presetsMenuEl.innerHTML = '';
                // --- Built-in views (read-only, apply-only) ---
                const biHead = document.createElement('div');
                biHead.style.cssText = 'font-size:9px;text-transform:uppercase;color:#14d2dc;letter-spacing:0.05em;padding:6px 12px 4px;font-weight:700';
                biHead.textContent = '★ Built-in views';
                presetsMenuEl.appendChild(biHead);
                BUILTIN_PRESETS.forEach(p => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 12px;cursor:pointer';
                    row.onmouseenter = () => { row.style.background = 'rgba(20,210,220,0.10)'; };
                    row.onmouseleave = () => { row.style.background = 'transparent'; };
                    row.title = p.desc || 'Apply this view';
                    const lbl = document.createElement('span');
                    lbl.textContent = p.name;
                    lbl.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cfe8ec';
                    row.appendChild(lbl);
                    row.onclick = () => { closePresetsMenu(); applyViewPreset(p, siteID); showToast(`View: ${p.name}`, 'rgba(20,210,220,0.55)'); };
                    presetsMenuEl.appendChild(row);
                });
                const biHr = document.createElement('div');
                biHr.style.cssText = 'border-top:1px solid rgba(255,255,255,0.10);margin:6px 0';
                presetsMenuEl.appendChild(biHr);
                // --- User-saved views ---
                const head = document.createElement('div');
                head.style.cssText = 'font-size:9px;text-transform:uppercase;color:#14d2dc;letter-spacing:0.05em;padding:4px 12px 4px;font-weight:700';
                head.textContent = 'Apply a saved view';
                presetsMenuEl.appendChild(head);
                const presets = loadViewPresets();
                if (presets.length === 0) {
                    const empty = document.createElement('div');
                    empty.style.cssText = 'padding:3px 12px;color:#888';
                    empty.textContent = 'No presets yet — save the current view below.';
                    presetsMenuEl.appendChild(empty);
                }
                presets.forEach((p, i) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 12px';
                    row.onmouseenter = () => { row.style.background = 'rgba(20,210,220,0.10)'; };
                    row.onmouseleave = () => { row.style.background = 'transparent'; };
                    const lbl = document.createElement('span');
                    lbl.textContent = p.name;
                    lbl.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer';
                    lbl.title = 'Apply this view';
                    lbl.onclick = () => { closePresetsMenu(); applyViewPreset(p, siteID); showToast(`View: ${p.name}`, 'rgba(20,210,220,0.55)'); };
                    row.appendChild(lbl);
                    const upd = document.createElement('button');
                    upd.textContent = '⟳';
                    upd.title = 'Overwrite this preset with the current view';
                    upd.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.20);color:#bbb;border-radius:3px;width:22px;height:20px;cursor:pointer;font-size:11px;padding:0;line-height:1';
                    upd.onclick = (e2) => {
                        e2.stopPropagation();
                        const arr = loadViewPresets();
                        arr[i] = Object.assign({ name: p.name }, captureCurrentView());
                        saveViewPresets(arr);
                        showToast(`Updated: ${p.name}`, 'rgba(95,255,95,0.5)');
                        rebuildPresetsMenu();
                    };
                    row.appendChild(upd);
                    const del = document.createElement('button');
                    del.textContent = '×';
                    del.title = 'Delete this preset';
                    del.style.cssText = 'background:transparent;border:1px solid rgba(255,120,120,0.4);color:#ff8a80;border-radius:3px;width:22px;height:20px;cursor:pointer;font-size:12px;padding:0;line-height:1';
                    del.onclick = (e2) => {
                        e2.stopPropagation();
                        const arr = loadViewPresets();
                        arr.splice(i, 1);
                        saveViewPresets(arr);
                        rebuildPresetsMenu();
                    };
                    row.appendChild(del);
                    presetsMenuEl.appendChild(row);
                });
                const hr = document.createElement('div');
                hr.style.cssText = 'border-top:1px solid rgba(255,255,255,0.10);margin:6px 0';
                presetsMenuEl.appendChild(hr);
                // Reset to default view
                const defBtn = document.createElement('button');
                defBtn.type = 'button';
                defBtn.textContent = '↺ Default view (all columns · no filters)';
                defBtn.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.20);color:#bbb;border-radius:3px;padding:4px 10px;cursor:pointer;font:inherit;font-size:10px;display:block;margin:0 12px 6px;width:calc(100% - 24px);text-align:left';
                defBtn.onclick = () => { closePresetsMenu(); resetToDefaultView(siteID); showToast('Default view', 'rgba(20,210,220,0.55)'); };
                presetsMenuEl.appendChild(defBtn);
                // Save current view (inline name input — sandbox-safe, no prompt())
                const saveRow = document.createElement('div');
                saveRow.style.cssText = 'display:flex;gap:6px;padding:0 12px 4px';
                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.placeholder = 'Name this view…';
                nameInput.style.cssText = 'flex:1;background:#1a1d23;border:1px solid rgba(255,255,255,0.20);color:#e6e6e6;border-radius:3px;padding:3px 6px;font:inherit;font-size:11px;outline:none';
                nameInput.onfocus = () => { nameInput.style.borderColor = '#14d2dc'; };
                nameInput.onblur = () => { nameInput.style.borderColor = 'rgba(255,255,255,0.20)'; };
                const saveBtn2 = document.createElement('button');
                saveBtn2.type = 'button';
                saveBtn2.textContent = '＋ Save';
                saveBtn2.title = 'Save the current columns + filters + sort as a new preset';
                saveBtn2.style.cssText = 'background:rgba(20,210,220,0.15);color:#7adfe6;border:1px solid rgba(20,210,220,0.45);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;white-space:nowrap';
                const doSave = () => {
                    const name = (nameInput.value || '').trim();
                    if (!name) { nameInput.focus(); return; }
                    const arr = loadViewPresets();
                    const existing = arr.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
                    const entry = Object.assign({ name }, captureCurrentView());
                    let verb = 'Saved';
                    if (existing >= 0) { arr[existing] = entry; verb = 'Updated'; }
                    else arr.push(entry);
                    saveViewPresets(arr);
                    showToast(`${verb}: ${name}`, 'rgba(95,255,95,0.5)');
                    rebuildPresetsMenu();
                };
                saveBtn2.onclick = (e2) => { e2.stopPropagation(); doSave(); };
                nameInput.onkeydown = (e2) => {
                    if (e2.key === 'Enter') { e2.preventDefault(); e2.stopPropagation(); doSave(); }
                    else if (e2.key === 'Escape') { e2.preventDefault(); e2.stopPropagation(); closePresetsMenu(); }
                };
                saveRow.appendChild(nameInput);
                saveRow.appendChild(saveBtn2);
                presetsMenuEl.appendChild(saveRow);
            };
            rebuildPresetsMenu();
            const r = presetsBtn.getBoundingClientRect();
            presetsMenuEl.style.left = r.left + 'px';
            presetsMenuEl.style.top = (r.bottom + 4) + 'px';
            document.body.appendChild(presetsMenuEl);
            const mr = presetsMenuEl.getBoundingClientRect();
            if (mr.right > window.innerWidth - 8) presetsMenuEl.style.left = (window.innerWidth - mr.width - 8) + 'px';
            if (mr.bottom > window.innerHeight - 8) presetsMenuEl.style.top = (r.top - mr.height - 4) + 'px';
            presetsDocClick = (e) => {
                if (presetsMenuEl && !presetsMenuEl.contains(e.target) && e.target !== presetsBtn) closePresetsMenu();
            };
            setTimeout(() => document.addEventListener('mousedown', presetsDocClick, true), 0);
        };
        optsRow.appendChild(presetsBtn);

        // --- Bulk → AGL button ---
        // Opens a popover that lets the user queue Min Alt edits across
        // all FP segments (or just the selected ones) targeting a single
        // AGL value. Defaults to 100 ft per the user's standard (floor
        // of every FP at 100 ft AGL except in specific situations they
        // can manually unqueue).
        const bulkBtn = document.createElement('button');
        bulkBtn.type = 'button';
        bulkBtn.textContent = 'Bulk → AGL';
        bulkBtn.title = 'Queue Min Alt edits across FP segments to hit a target AGL';
        bulkBtn.style.cssText = 'background:transparent;color:#ffd54f;border:1px solid rgba(255,213,79,0.45);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px';
        let bulkPopEl = null;
        bulkBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (bulkPopEl) { bulkPopEl.remove(); bulkPopEl = null; return; }
            bulkPopEl = buildBulkAglPopover(bulkBtn, () => {
                if (bulkPopEl) { bulkPopEl.remove(); bulkPopEl = null; }
            });
            document.body.appendChild(bulkPopEl);
            const r = bulkBtn.getBoundingClientRect();
            bulkPopEl.style.left = r.left + 'px';
            bulkPopEl.style.top = (r.bottom + 4) + 'px';
            const rect = bulkPopEl.getBoundingClientRect();
            if (rect.right > window.innerWidth - 8) {
                bulkPopEl.style.left = (window.innerWidth - rect.width - 8) + 'px';
            }
            const onDocClick = (e) => {
                if (bulkPopEl && !bulkPopEl.contains(e.target) && e.target !== bulkBtn) {
                    bulkPopEl.remove(); bulkPopEl = null;
                    document.removeEventListener('mousedown', onDocClick, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
        };
        optsRow.appendChild(bulkBtn);

        // --- Bulk → Delta button ---
        // Queues a Max Alt = Min Alt + targetDelta edit for every
        // eligible row. SOP defaults: FP segments 20 ft / FFZ 30 ft.
        // Uses the EFFECTIVE Min (with any queued Min edits applied)
        // so chaining "Bulk → AGL" then "Bulk → Delta" produces the
        // correct stacked result.
        const deltaBtn = document.createElement('button');
        deltaBtn.type = 'button';
        deltaBtn.textContent = 'Bulk → Delta';
        deltaBtn.title = 'Queue Max Alt edits to enforce Min/Max delta SOP (FP 20 ft, FFZ 30 ft)';
        deltaBtn.style.cssText = 'background:transparent;color:#ffd54f;border:1px solid rgba(255,213,79,0.45);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px';
        let deltaPopEl = null;
        deltaBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (deltaPopEl) { deltaPopEl.remove(); deltaPopEl = null; return; }
            deltaPopEl = buildBulkDeltaPopover(deltaBtn, () => {
                if (deltaPopEl) { deltaPopEl.remove(); deltaPopEl = null; }
            });
            document.body.appendChild(deltaPopEl);
            const r = deltaBtn.getBoundingClientRect();
            deltaPopEl.style.left = r.left + 'px';
            deltaPopEl.style.top = (r.bottom + 4) + 'px';
            const rect = deltaPopEl.getBoundingClientRect();
            if (rect.right > window.innerWidth - 8) {
                deltaPopEl.style.left = (window.innerWidth - rect.width - 8) + 'px';
            }
            const onDocClick = (e) => {
                if (deltaPopEl && !deltaPopEl.contains(e.target) && e.target !== deltaBtn) {
                    deltaPopEl.remove(); deltaPopEl = null;
                    document.removeEventListener('mousedown', onDocClick, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
        };
        optsRow.appendChild(deltaBtn);

        // --- Bulk → Min / Bulk → Max buttons ---
        // Set an ABSOLUTE Min (or Max) Alt across every eligible FP segment +
        // FFZ (or just the selected rows). Complements Bulk → AGL (Min from
        // elevation) and Bulk → Delta (Max from Min). Shared toggle/position/
        // outside-click wiring via attachBulkPopover.
        const attachBulkPopover = (btn, builder) => {
            let popEl = null;
            btn.onclick = (ev) => {
                ev.stopPropagation();
                if (popEl) { popEl.remove(); popEl = null; return; }
                popEl = builder(btn, () => { if (popEl) { popEl.remove(); popEl = null; } });
                document.body.appendChild(popEl);
                const r = btn.getBoundingClientRect();
                popEl.style.left = r.left + 'px';
                popEl.style.top = (r.bottom + 4) + 'px';
                const rect = popEl.getBoundingClientRect();
                if (rect.right > window.innerWidth - 8) popEl.style.left = (window.innerWidth - rect.width - 8) + 'px';
                const onDocClick = (e) => {
                    if (popEl && !popEl.contains(e.target) && e.target !== btn) {
                        popEl.remove(); popEl = null;
                        document.removeEventListener('mousedown', onDocClick, true);
                    }
                };
                setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
            };
        };
        const bulkBtnStyle = 'background:transparent;color:#ffd54f;border:1px solid rgba(255,213,79,0.45);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px';
        const minBtn = document.createElement('button');
        minBtn.type = 'button';
        minBtn.textContent = 'Bulk → Min';
        minBtn.title = 'Set an absolute Min Alt across FP segments + FFZs (selected, or all)';
        minBtn.style.cssText = bulkBtnStyle;
        attachBulkPopover(minBtn, (anchor, onClose) => buildBulkMinMaxPopover(anchor, onClose, 'min_alt'));
        optsRow.appendChild(minBtn);
        const maxBtn = document.createElement('button');
        maxBtn.type = 'button';
        maxBtn.textContent = 'Bulk → Max';
        maxBtn.title = 'Set an absolute Max Alt across FP segments + FFZs (selected, or all)';
        maxBtn.style.cssText = bulkBtnStyle;
        attachBulkPopover(maxBtn, (anchor, onClose) => buildBulkMinMaxPopover(anchor, onClose, 'max_alt'));
        optsRow.appendChild(maxBtn);

        // --- v3.53: Bulk → Subtype button ---
        // Queues a subtype edit for every selected asset row (or all asset
        // rows if none selected). Uses the same datalist of observed
        // subtypes as the inline editor. Free-text values not in the list
        // flow through the same "Enter new type" path during Apply.
        const subBtn = document.createElement('button');
        subBtn.type = 'button';
        subBtn.textContent = 'Bulk → Subtype';
        subBtn.title = 'Queue subtype edits across selected assets (or all assets)';
        subBtn.style.cssText = 'background:transparent;color:#ffd54f;border:1px solid rgba(255,213,79,0.45);border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px';
        let subPopEl = null;
        subBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (subPopEl) { subPopEl.remove(); subPopEl = null; return; }
            subPopEl = buildBulkSubtypePopover(subBtn, () => {
                if (subPopEl) { subPopEl.remove(); subPopEl = null; }
            });
            document.body.appendChild(subPopEl);
            const r = subBtn.getBoundingClientRect();
            subPopEl.style.left = r.left + 'px';
            subPopEl.style.top = (r.bottom + 4) + 'px';
            const rect = subPopEl.getBoundingClientRect();
            if (rect.right > window.innerWidth - 8) {
                subPopEl.style.left = (window.innerWidth - rect.width - 8) + 'px';
            }
            const onDocClick = (e) => {
                if (subPopEl && !subPopEl.contains(e.target) && e.target !== subBtn) {
                    subPopEl.remove(); subPopEl = null;
                    document.removeEventListener('mousedown', onDocClick, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
        };
        optsRow.appendChild(subBtn);

        function buildBulkSubtypePopover(anchor, onClose) {
            const pop = document.createElement('div');
            pop.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(255,213,79,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:12px 14px;z-index:99999;font-size:12px;color:#e6e6e6;min-width:340px';
            const title = document.createElement('div');
            title.style.cssText = 'color:#ffd54f;font-weight:700;font-size:13px;margin-bottom:8px';
            title.textContent = '🏷  Bulk Set Asset Subtype';
            pop.appendChild(title);
            const help = document.createElement('div');
            help.style.cssText = 'color:#888;font-size:10px;margin-bottom:10px;line-height:1.4';
            help.textContent = 'Queues a subtype change for every targeted asset. Pick from the list or type a new value — new values get added via the "Enter new type" path during Apply.';
            pop.appendChild(help);

            // Target subtype input — datalist of observed subtypes
            const siteIDLocal = getCurrentSiteID();
            const dlId = `aim-bulk-sub-dl-${Date.now()}`;
            const dl = document.createElement('datalist');
            dl.id = dlId;
            observedSubtypesForSite(siteIDLocal).forEach(s => {
                const o = document.createElement('option');
                o.value = s;
                dl.appendChild(o);
            });
            pop.appendChild(dl);

            const row1 = document.createElement('div');
            row1.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px';
            const lbl1 = document.createElement('label');
            lbl1.textContent = 'Target subtype:';
            lbl1.style.cssText = 'flex:0 0 110px;color:#cfd6dc';
            row1.appendChild(lbl1);
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.setAttribute('list', dlId);
            inp.placeholder = 'e.g. v-well - empty';
            inp.style.cssText = 'flex:1;background:#1a1d23;border:1px solid rgba(255,255,255,0.20);color:#fff;padding:4px 6px;border-radius:3px;font:inherit;font-size:12px';
            row1.appendChild(inp);
            pop.appendChild(row1);

            // Scope radio
            const selCount = sumPanelState.selectedIds.size;
            const row2 = document.createElement('div');
            row2.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-bottom:10px';
            const mkScope = (val, label, dis) => {
                const l = document.createElement('label');
                l.style.cssText = `display:flex;align-items:center;gap:6px;cursor:${dis ? 'not-allowed' : 'pointer'};color:${dis ? '#666' : '#cfd6dc'}`;
                const r = document.createElement('input');
                r.type = 'radio';
                r.name = 'aim-ai-bulk-sub-scope';
                r.value = val;
                if (dis) r.disabled = true;
                r.style.cssText = 'accent-color:rgb(255,213,79);cursor:inherit';
                l.appendChild(r);
                l.appendChild(document.createTextNode(label));
                return { l, r };
            };
            const allScope = mkScope('all', 'All assets on this site', false);
            const selScope = mkScope('sel', `Selected only (${selCount} selected)`, selCount === 0);
            if (selCount > 0) selScope.r.checked = true;
            else allScope.r.checked = true;
            row2.appendChild(allScope.l);
            row2.appendChild(selScope.l);
            pop.appendChild(row2);

            const preview = document.createElement('div');
            preview.style.cssText = 'color:#9ad;font-size:11px;margin-bottom:10px;padding:6px 8px;background:rgba(255,213,79,0.08);border-radius:3px;min-height:20px';
            pop.appendChild(preview);

            const computeEligible = () => {
                const target = String(inp.value || '').trim();
                if (!target) return { eligible: [], target: '', candidates: [] };
                const scope = selScope.r.checked ? 'sel' : 'all';
                const candidates = allRows.filter(r => {
                    if (r.type !== 3 || !r.entity) return false; // assets only
                    if (r._isSegment) return false;
                    if (scope === 'sel' && !sumPanelState.selectedIds.has(r._rowKey)) return false;
                    return true;
                });
                const eligible = candidates.filter(r => {
                    const cur = (r.entity.custom && r.entity.custom.poi_type_str) || '';
                    return cur !== target;
                });
                return { eligible, target, candidates };
            };
            const refreshPreview = () => {
                const { eligible, target, candidates } = computeEligible();
                if (!target) { preview.textContent = '⚠️ Type or pick a target subtype'; return; }
                if (candidates.length === 0) { preview.textContent = '⚠️ No eligible assets in scope'; return; }
                const observed = new Set(observedSubtypesForSite(siteIDLocal));
                const isNew = !observed.has(target);
                preview.innerHTML = `Will queue <strong style="color:#ffd54f">${eligible.length}</strong> edit${eligible.length === 1 ? '' : 's'} · skipping ${candidates.length - eligible.length} already at "${target}"${isNew ? ' · <span style="color:#c4b5fd">NEW type</span>' : ''}`;
            };
            refreshPreview();
            inp.oninput = refreshPreview;
            allScope.r.onchange = refreshPreview;
            selScope.r.onchange = refreshPreview;

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:5px 12px;cursor:pointer;font:inherit;font-size:11px';
            cancelBtn.onclick = onClose;
            const queueBtn = document.createElement('button');
            queueBtn.type = 'button';
            queueBtn.textContent = 'Queue edits';
            queueBtn.style.cssText = 'background:rgba(255,213,79,0.18);color:#ffd54f;border:1px solid rgba(255,213,79,0.55);border-radius:3px;padding:5px 14px;cursor:pointer;font:inherit;font-size:11px;font-weight:600';
            queueBtn.onclick = () => {
                const { eligible, target } = computeEligible();
                if (!target) { showToast('Pick a target subtype first', 'rgba(255,82,82,0.6)'); return; }
                if (eligible.length === 0) { showToast('Nothing to queue — all eligible assets already at target'); return; }
                let queued = 0;
                eligible.forEach(r => { if (queueSubtypeEdit(r.entity, target)) queued++; });
                showToast(`Queued ${queued} subtype edit${queued === 1 ? '' : 's'} → "${target}"`, 'rgba(255,213,79,0.7)');
                onClose();
                redrawTable();
            };
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(queueBtn);
            pop.appendChild(btnRow);
            return pop;
        }

        // Builds the Bulk → Delta popover. Separate inputs for FP (20)
        // and FFZ (30) defaults — different SOPs per the user. One
        // dialog so the user can normalize both with one action.
        function buildBulkDeltaPopover(anchor, onClose) {
            const pop = document.createElement('div');
            pop.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(255,213,79,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:12px 14px;z-index:99999;font-size:12px;color:#e6e6e6;min-width:330px';
            const useFt = !!sumPanelState.unitsFt;
            const unitTxt = useFt ? 'ft' : 'm';
            const title = document.createElement('div');
            title.style.cssText = 'color:#ffd54f;font-weight:700;font-size:13px;margin-bottom:8px';
            title.textContent = '📏 Bulk Set Min/Max Delta';
            pop.appendChild(title);
            const help = document.createElement('div');
            help.style.cssText = 'color:#888;font-size:10px;margin-bottom:10px;line-height:1.4';
            help.textContent = 'Queues Max Alt = effective Min + target delta. Uses the in-queue Min if you\'ve already edited it (chain after Bulk → AGL).';
            pop.appendChild(help);

            // FP delta input
            const mkRow = (label, defaultVal) => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px';
                const l = document.createElement('label');
                l.textContent = label;
                l.style.cssText = 'flex:1;color:#cfd6dc';
                row.appendChild(l);
                const i = document.createElement('input');
                i.type = 'number';
                i.value = String(defaultVal);
                i.min = '0';
                i.step = useFt ? '5' : '1';
                i.style.cssText = 'width:80px;background:#1a1d23;border:1px solid rgba(255,255,255,0.20);color:#fff;padding:4px 6px;border-radius:3px;font:inherit;font-size:12px;text-align:right';
                row.appendChild(i);
                return { row, input: i };
            };
            // SOP 2026-06-09: 30 ft delta for everything (FFZ + FP), with
            // the 2 m bridge overlap as slack. A 30 ft band tolerates ~23 ft
            // of terrain step between segments before overlap drops under
            // 2 m (vs 20 ft = zero headroom), so far fewer bridges/splits.
            const fpDeltaDefault = useFt ? 30 : 9;     // 30 ft ≈ 9 m
            const ffzDeltaDefault = useFt ? 30 : 9;    // 30 ft ≈ 9 m
            const fp = mkRow(`FP segments — target delta (${unitTxt}):`, fpDeltaDefault);
            const ffz = mkRow(`FFZ entities — target delta (${unitTxt}):`, ffzDeltaDefault);
            pop.appendChild(fp.row);
            pop.appendChild(ffz.row);

            // Scope radio (same as Bulk → AGL).
            const selCount = sumPanelState.selectedIds.size;
            const row2 = document.createElement('div');
            row2.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-bottom:10px';
            const mkScope = (val, label, dis) => {
                const l = document.createElement('label');
                l.style.cssText = `display:flex;align-items:center;gap:6px;cursor:${dis ? 'not-allowed' : 'pointer'};color:${dis ? '#666' : '#cfd6dc'}`;
                const r = document.createElement('input');
                r.type = 'radio';
                r.name = 'aim-ai-bulk-delta-scope';
                r.value = val;
                if (dis) r.disabled = true;
                r.style.cssText = 'accent-color:rgb(255,213,79);cursor:inherit';
                l.appendChild(r);
                l.appendChild(document.createTextNode(label));
                return { l, r };
            };
            const allScope = mkScope('all', 'All FPs/FFZs on this site', false);
            const selScope = mkScope('sel', `Selected only (${selCount} selected)`, selCount === 0);
            if (selCount > 0) selScope.r.checked = true;
            else allScope.r.checked = true;
            row2.appendChild(allScope.l);
            row2.appendChild(selScope.l);
            pop.appendChild(row2);

            // Preview — count FP edits + FFZ edits separately so user
            // can sanity-check the split before queuing.
            const preview = document.createElement('div');
            preview.style.cssText = 'color:#9ad;font-size:11px;margin-bottom:10px;padding:6px 8px;background:rgba(255,213,79,0.08);border-radius:3px;min-height:20px';
            pop.appendChild(preview);

            const computeEligible = () => {
                const fpTargetVal = parseFloat(fp.input.value);
                const ffzTargetVal = parseFloat(ffz.input.value);
                if (!isFinite(fpTargetVal) || !isFinite(ffzTargetVal)) {
                    return null;
                }
                const fpTargetM = useFt ? fpTargetVal / 3.28084 : fpTargetVal;
                const ffzTargetM = useFt ? ffzTargetVal / 3.28084 : ffzTargetVal;
                const scope = selScope.r.checked ? 'sel' : 'all';
                const out = { fpEdits: [], ffzEdits: [] };
                allRows.forEach(r => {
                    if (!isEditableRow(r)) return;
                    if (scope === 'sel' && !sumPanelState.selectedIds.has(r._rowKey)) return;
                    const eff = effectiveValues(r);
                    if (eff.effMin == null) return;
                    const isFfz = isFfzRow(r);
                    const target = isFfz ? ffzTargetM : fpTargetM;
                    const newMaxM = eff.effMin + target;
                    const newDisp = useFt ? Math.round(newMaxM * 3.28084) : Number(newMaxM.toFixed(1));
                    const curMaxRef = r.altMaxM;
                    if (curMaxRef == null) return;
                    const curDisp = useFt ? Math.round(curMaxRef * 3.28084) : Number(curMaxRef.toFixed(1));
                    if (newDisp === curDisp) return;
                    (isFfz ? out.ffzEdits : out.fpEdits).push({ row: r, newMaxM });
                });
                return out;
            };
            const refreshPreview = () => {
                const elig = computeEligible();
                if (!elig) {
                    preview.textContent = '⚠️ Invalid target value';
                    return;
                }
                preview.innerHTML = `Will queue <strong style="color:#ffd54f">${elig.fpEdits.length}</strong> FP edit${elig.fpEdits.length === 1 ? '' : 's'} + <strong style="color:#ffd54f">${elig.ffzEdits.length}</strong> FFZ edit${elig.ffzEdits.length === 1 ? '' : 's'}.`;
            };
            refreshPreview();
            fp.input.oninput = refreshPreview;
            ffz.input.oninput = refreshPreview;
            allScope.r.onchange = refreshPreview;
            selScope.r.onchange = refreshPreview;

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:5px 12px;cursor:pointer;font:inherit;font-size:11px';
            cancelBtn.onclick = onClose;
            const queueBtn = document.createElement('button');
            queueBtn.type = 'button';
            queueBtn.textContent = 'Queue edits';
            queueBtn.style.cssText = 'background:rgba(255,213,79,0.18);color:#ffd54f;border:1px solid rgba(255,213,79,0.55);border-radius:3px;padding:5px 14px;cursor:pointer;font:inherit;font-size:11px;font-weight:600';
            queueBtn.onclick = () => {
                const elig = computeEligible();
                if (!elig) {
                    showToast('Invalid target value', 'rgba(255,82,82,0.6)');
                    return;
                }
                let queued = 0;
                [...elig.fpEdits, ...elig.ffzEdits].forEach(e => {
                    if (queueAltEdit(e.row, 'max_alt', e.newMaxM)) queued++;
                });
                showToast(`Queued ${queued} Max Alt edit${queued === 1 ? '' : 's'}`, 'rgba(255,213,79,0.7)');
                onClose();
                redrawTable();
            };
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(queueBtn);
            pop.appendChild(btnRow);
            return pop;
        }

        toolbar.appendChild(optsRow);
        panel.appendChild(toolbar);

        // Builds the popover shown when the user clicks "Bulk → AGL".
        // Captures the current rows + selection state when called, so
        // the "Queue N edits" preview reflects what would actually
        // happen. Re-builds whenever the target AGL changes.
        function buildBulkAglPopover(anchor, onClose) {
            const pop = document.createElement('div');
            pop.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(255,213,79,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:12px 14px;z-index:99999;font-size:12px;color:#e6e6e6;min-width:300px';
            const useFt = !!sumPanelState.unitsFt;
            const unitTxt = useFt ? 'ft' : 'm';
            const title = document.createElement('div');
            title.style.cssText = 'color:#ffd54f;font-weight:700;font-size:13px;margin-bottom:8px';
            title.textContent = '🎯 Bulk Set Min Alt to Target AGL';
            pop.appendChild(title);
            const help = document.createElement('div');
            help.style.cssText = 'color:#888;font-size:10px;margin-bottom:10px;line-height:1.4';
            help.textContent = 'For each FP segment + FFZ entity, queues Min Alt = elevation + target AGL. Skips rows already at target. After, you can run Bulk → Delta to enforce Max = Min + SOP delta.';
            pop.appendChild(help);

            // Target input
            const row1 = document.createElement('div');
            row1.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px';
            const lbl1 = document.createElement('label');
            lbl1.textContent = `Target AGL (${unitTxt}):`;
            lbl1.style.cssText = 'flex:1;color:#cfd6dc';
            row1.appendChild(lbl1);
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.value = useFt ? '100' : '30';
            inp.min = '0';
            inp.step = useFt ? '10' : '5';
            inp.style.cssText = 'width:80px;background:#1a1d23;border:1px solid rgba(255,255,255,0.20);color:#fff;padding:4px 6px;border-radius:3px;font:inherit;font-size:12px;text-align:right';
            row1.appendChild(inp);
            pop.appendChild(row1);

            // Scope radio
            const selCount = sumPanelState.selectedIds.size;
            const row2 = document.createElement('div');
            row2.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-bottom:10px';
            const mkScope = (val, label, dis) => {
                const l = document.createElement('label');
                l.style.cssText = `display:flex;align-items:center;gap:6px;cursor:${dis ? 'not-allowed' : 'pointer'};color:${dis ? '#666' : '#cfd6dc'}`;
                const r = document.createElement('input');
                r.type = 'radio';
                r.name = 'aim-ai-bulk-scope';
                r.value = val;
                if (dis) r.disabled = true;
                r.style.cssText = 'accent-color:rgb(255,213,79);cursor:inherit';
                l.appendChild(r);
                l.appendChild(document.createTextNode(label));
                return { l, r };
            };
            const allScope = mkScope('all', 'All FPs/FFZs on this site', false);
            const selScope = mkScope('sel', `Selected only (${selCount} selected)`, selCount === 0);
            // Default: if user has a selection, use it; else all.
            if (selCount > 0) selScope.r.checked = true;
            else allScope.r.checked = true;
            row2.appendChild(allScope.l);
            row2.appendChild(selScope.l);
            pop.appendChild(row2);

            // Live preview — "X edits would be queued" updates as user
            // changes target or scope. computeEligible returns the
            // segment-rows that need an edit (rows that don't already
            // match the target).
            const preview = document.createElement('div');
            preview.style.cssText = 'color:#9ad;font-size:11px;margin-bottom:10px;padding:6px 8px;background:rgba(255,213,79,0.08);border-radius:3px;min-height:20px';
            pop.appendChild(preview);

            const computeEligible = () => {
                const targetVal = parseFloat(inp.value);
                if (!isFinite(targetVal)) return { eligible: [], targetM: NaN };
                const targetM = useFt ? targetVal / 3.28084 : targetVal;
                const scope = selScope.r.checked ? 'sel' : 'all';
                // Eligible rows = FP segments + FFZ entities with a
                // loaded elevation (else we can't compute Min from AGL).
                const candidates = allRows.filter(r => {
                    if (!isEditableRow(r)) return false;
                    if (r.elevationM == null) return false;
                    if (scope === 'sel' && !sumPanelState.selectedIds.has(r._rowKey)) return false;
                    return true;
                });
                const eligible = candidates.filter(r => {
                    const newMinM = r.elevationM + targetM;
                    const newDisp = useFt ? Math.round(newMinM * 3.28084) : Number(newMinM.toFixed(1));
                    const curDisp = useFt ? Math.round(r.altMinM * 3.28084) : Number(r.altMinM.toFixed(1));
                    return newDisp !== curDisp;
                });
                return { eligible, targetM, totalSegments: candidates.length };
            };
            const refreshPreview = () => {
                const { eligible, targetM, totalSegments } = computeEligible();
                if (!isFinite(targetM)) {
                    preview.textContent = '⚠️ Invalid target value';
                    return;
                }
                if (totalSegments === 0) {
                    preview.textContent = '⚠️ No eligible segments (need loaded elevation).';
                    return;
                }
                preview.innerHTML = `Will queue <strong style="color:#ffd54f">${eligible.length}</strong> edit${eligible.length === 1 ? '' : 's'} · skipping ${totalSegments - eligible.length} already at target.`;
            };
            refreshPreview();
            inp.oninput = refreshPreview;
            allScope.r.onchange = refreshPreview;
            selScope.r.onchange = refreshPreview;

            // Buttons
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:5px 12px;cursor:pointer;font:inherit;font-size:11px';
            cancelBtn.onclick = onClose;
            const queueBtn = document.createElement('button');
            queueBtn.type = 'button';
            queueBtn.textContent = 'Queue edits';
            queueBtn.style.cssText = 'background:rgba(255,213,79,0.18);color:#ffd54f;border:1px solid rgba(255,213,79,0.55);border-radius:3px;padding:5px 14px;cursor:pointer;font:inherit;font-size:11px;font-weight:600';
            queueBtn.onclick = () => {
                const { eligible, targetM } = computeEligible();
                if (!isFinite(targetM)) {
                    showToast('Invalid target value', 'rgba(255,82,82,0.6)');
                    return;
                }
                if (eligible.length === 0) {
                    showToast('Nothing to queue — all eligible segments already at target');
                    return;
                }
                let queued = 0;
                eligible.forEach(r => { if (queueMinForAgl(r, targetM)) queued++; });
                const tDisp = useFt ? Math.round(targetM * 3.28084) : Number(targetM.toFixed(1));
                showToast(`Queued ${queued} Min Alt edit${queued === 1 ? '' : 's'} → ${tDisp}${unitTxt} AGL`, 'rgba(255,213,79,0.7)');
                onClose();
                redrawTable();
            };
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(queueBtn);
            pop.appendChild(btnRow);
            return pop;
        }

        // Builds the Bulk → Min / Bulk → Max popover. Sets an ABSOLUTE target
        // altitude (not derived from elevation/delta) on each eligible row.
        // field = 'min_alt' | 'max_alt'.
        function buildBulkMinMaxPopover(anchor, onClose, field) {
            const isMin = field === 'min_alt';
            const lblWord = isMin ? 'Min' : 'Max';
            const pop = document.createElement('div');
            pop.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(255,213,79,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:12px 14px;z-index:99999;font-size:12px;color:#e6e6e6;min-width:300px';
            const useFt = !!sumPanelState.unitsFt;
            const unitTxt = useFt ? 'ft' : 'm';
            const title = document.createElement('div');
            title.style.cssText = 'color:#ffd54f;font-weight:700;font-size:13px;margin-bottom:8px';
            title.textContent = `🎯 Bulk Set ${lblWord} Alt`;
            pop.appendChild(title);
            const help = document.createElement('div');
            help.style.cssText = 'color:#888;font-size:10px;margin-bottom:10px;line-height:1.4';
            help.textContent = `Sets ${lblWord} Alt to this absolute value for each FP segment + FFZ in scope. Skips rows already at target.`;
            pop.appendChild(help);

            // Target input — accepts a number or a formula (2650+50).
            const row1 = document.createElement('div');
            row1.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px';
            const lbl1 = document.createElement('label');
            lbl1.textContent = `Target ${lblWord} (${unitTxt}):`;
            lbl1.style.cssText = 'flex:1;color:#cfd6dc';
            row1.appendChild(lbl1);
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.placeholder = useFt ? 'e.g. 2700' : 'e.g. 820';
            inp.title = 'A number or formula (e.g. 2700 or 2650+50).';
            inp.style.cssText = 'width:90px;background:#1a1d23;border:1px solid rgba(255,255,255,0.20);color:#fff;padding:4px 6px;border-radius:3px;font:inherit;font-size:12px;text-align:right';
            row1.appendChild(inp);
            pop.appendChild(row1);

            // Scope radio (same convention as Bulk → AGL/Delta).
            const selCount = sumPanelState.selectedIds.size;
            const row2 = document.createElement('div');
            row2.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-bottom:10px';
            const mkScope = (val, label, dis) => {
                const l = document.createElement('label');
                l.style.cssText = `display:flex;align-items:center;gap:6px;cursor:${dis ? 'not-allowed' : 'pointer'};color:${dis ? '#666' : '#cfd6dc'}`;
                const r = document.createElement('input');
                r.type = 'radio';
                r.name = 'aim-ai-bulk-mm-scope';
                r.value = val;
                if (dis) r.disabled = true;
                r.style.cssText = 'accent-color:rgb(255,213,79);cursor:inherit';
                l.appendChild(r);
                l.appendChild(document.createTextNode(label));
                return { l, r };
            };
            const allScope = mkScope('all', 'All FPs/FFZs on this site', false);
            const selScope = mkScope('sel', `Selected only (${selCount} selected)`, selCount === 0);
            if (selCount > 0) selScope.r.checked = true;
            else allScope.r.checked = true;
            row2.appendChild(allScope.l);
            row2.appendChild(selScope.l);
            pop.appendChild(row2);

            const preview = document.createElement('div');
            preview.style.cssText = 'color:#9ad;font-size:11px;margin-bottom:10px;padding:6px 8px;background:rgba(255,213,79,0.08);border-radius:3px;min-height:20px';
            pop.appendChild(preview);

            const curM = (r) => isMin ? r.altMinM : r.altMaxM;
            const computeEligible = () => {
                const parsed = parseFormulaValue(inp.value);
                if (!isFinite(parsed)) return { eligible: [], newValueM: NaN, total: 0 };
                const newDisp = useFt ? Math.round(parsed) : Number(parsed.toFixed(1));
                const newValueM = useFt ? newDisp / 3.28084 : newDisp;
                const scope = selScope.r.checked ? 'sel' : 'all';
                const candidates = allRows.filter(r => {
                    if (!isEditableRow(r)) return false;
                    if (scope === 'sel' && !sumPanelState.selectedIds.has(r._rowKey)) return false;
                    return true;
                });
                const eligible = candidates.filter(r => {
                    const cm = curM(r);
                    if (cm == null) return true; // no current value → setting one counts
                    const curDisp = useFt ? Math.round(cm * 3.28084) : Number(cm.toFixed(1));
                    return newDisp !== curDisp;
                });
                return { eligible, newValueM, total: candidates.length };
            };
            const refreshPreview = () => {
                const { eligible, newValueM, total } = computeEligible();
                if (!isFinite(newValueM)) { preview.textContent = 'Enter a target altitude.'; return; }
                if (total === 0) { preview.textContent = '⚠️ No eligible FP/FFZ rows in scope.'; return; }
                preview.innerHTML = `Will queue <strong style="color:#ffd54f">${eligible.length}</strong> ${lblWord} edit${eligible.length === 1 ? '' : 's'} · skipping ${total - eligible.length} already at target.`;
            };
            refreshPreview();
            inp.oninput = refreshPreview;
            allScope.r.onchange = refreshPreview;
            selScope.r.onchange = refreshPreview;

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:5px 12px;cursor:pointer;font:inherit;font-size:11px';
            cancelBtn.onclick = onClose;
            const queueBtn = document.createElement('button');
            queueBtn.type = 'button';
            queueBtn.textContent = 'Queue edits';
            queueBtn.style.cssText = 'background:rgba(255,213,79,0.18);color:#ffd54f;border:1px solid rgba(255,213,79,0.55);border-radius:3px;padding:5px 14px;cursor:pointer;font:inherit;font-size:11px;font-weight:600';
            queueBtn.onclick = () => {
                const { eligible, newValueM } = computeEligible();
                if (!isFinite(newValueM)) { showToast('Invalid target value', 'rgba(255,82,82,0.6)'); return; }
                if (eligible.length === 0) { showToast('Nothing to queue — all eligible rows already at target'); return; }
                let queued = 0;
                eligible.forEach(r => { if (queueAltEdit(r, field, newValueM)) queued++; });
                const tDisp = useFt ? Math.round(newValueM * 3.28084) : Number(newValueM.toFixed(1));
                showToast(`Queued ${queued} ${lblWord} Alt edit${queued === 1 ? '' : 's'} → ${tDisp}${unitTxt}`, 'rgba(255,213,79,0.7)');
                onClose();
                redrawTable();
            };
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(queueBtn);
            pop.appendChild(btnRow);
            return pop;
        }

        // --- DEM progress strip ---
        // Hidden by default. Shows during the bulk elevation fetch with
        // a moving fill + count. Hides itself when the fetch is done.
        const demProgress = document.createElement('div');
        demProgress.style.cssText = 'display:none;padding:4px 12px;background:rgba(196,181,253,0.08);border-bottom:1px solid rgba(196,181,253,0.20);font-size:11px;color:#c4b5fd;display:none;align-items:center;gap:8px';
        const demProgressLabel = document.createElement('span');
        demProgressLabel.style.cssText = 'flex:0 0 auto;font-weight:600';
        demProgressLabel.textContent = 'Loading elevations…';
        const demProgressBar = document.createElement('div');
        demProgressBar.style.cssText = 'flex:1;height:6px;background:rgba(196,181,253,0.15);border-radius:3px;overflow:hidden;position:relative';
        const demProgressFill = document.createElement('div');
        demProgressFill.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#c4b5fd,#a78bfa);transition:width 200ms ease-out';
        demProgressBar.appendChild(demProgressFill);
        const demProgressCount = document.createElement('span');
        demProgressCount.style.cssText = 'flex:0 0 auto;font-variant-numeric:tabular-nums;min-width:60px;text-align:right';
        demProgressCount.textContent = '';
        demProgress.appendChild(demProgressLabel);
        demProgress.appendChild(demProgressBar);
        demProgress.appendChild(demProgressCount);
        panel.appendChild(demProgress);
        // Wire the progress callback. Hides itself ~600 ms after
        // completion so the user sees "100%" briefly before it goes.
        let demProgressHideTimer = null;
        window.__aim_ai_onDemProgress = (done, total, finished) => {
            if (demProgressHideTimer) { clearTimeout(demProgressHideTimer); demProgressHideTimer = null; }
            if (total === 0) {
                demProgress.style.display = 'none';
                return;
            }
            demProgress.style.display = 'flex';
            const pct = Math.round((done / total) * 100);
            demProgressFill.style.width = pct + '%';
            demProgressCount.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
            if (finished) {
                demProgressHideTimer = setTimeout(() => {
                    demProgress.style.display = 'none';
                }, 600);
            }
        };

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
        // v3.87 (Phase 2): Export ▾ — copy ANY preset's table (its columns +
        // filters) to the clipboard, Sheets-ready, without changing the live
        // view. The CSV/Sheets/JSON buttons export the CURRENT view; this
        // exports a chosen preset's view so you can pull several field-sets
        // back-to-back.
        const exportBtn = document.createElement('button');
        exportBtn.textContent = '📤 Export ▾';
        exportBtn.title = 'Copy a preset\'s table (its own columns + filters) for paste into Sheets — without switching your current view';
        exportBtn.style.cssText = BTN_CSS;
        let exportMenuEl = null;
        const closeExportMenu = () => { if (exportMenuEl) { exportMenuEl.remove(); exportMenuEl = null; } };
        exportBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (exportMenuEl) { closeExportMenu(); return; }
            exportMenuEl = document.createElement('div');
            exportMenuEl.style.cssText = 'position:fixed;background:#1f2228;border:1px solid rgba(20,210,220,0.55);border-radius:5px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:6px 0;z-index:99999;font-size:11px;color:#e6e6e6;min-width:240px;max-height:65vh;overflow:auto';
            const head = document.createElement('div');
            head.style.cssText = 'font-size:9px;text-transform:uppercase;color:#14d2dc;letter-spacing:0.05em;padding:6px 12px 2px;font-weight:700';
            head.textContent = 'Copy a preset → Sheets';
            exportMenuEl.appendChild(head);
            const sub = document.createElement('div');
            sub.style.cssText = 'font-size:9px;color:#888;padding:0 12px 4px;max-width:236px;line-height:1.3';
            sub.textContent = "Uses that preset's columns + filters, not your current view.";
            exportMenuEl.appendChild(sub);
            const mkRow = (label, desc, onPick, accent) => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;padding:3px 12px;cursor:pointer';
                row.onmouseenter = () => { row.style.background = 'rgba(20,210,220,0.10)'; };
                row.onmouseleave = () => { row.style.background = 'transparent'; };
                if (desc) row.title = desc;
                const lbl = document.createElement('span');
                lbl.textContent = label;
                lbl.style.cssText = `flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${accent ? 'color:' + accent : ''}`;
                row.appendChild(lbl);
                row.onclick = onPick;
                return row;
            };
            const doExport = (p) => {
                closeExportMenu();
                try {
                    const { html, text, count } = buildPresetExport(p, allRows);
                    writeSheetsClipboard(html, text, `Copied "${p.name}" (${count} row${count === 1 ? '' : 's'}) → paste into Sheets`);
                } catch (e) {
                    console.error(`${TAG} export "${p.name}" failed:`, e);
                    showToast(`Export failed: ${p.name}`, 'rgba(255,96,96,0.55)');
                }
            };
            const biHead = document.createElement('div');
            biHead.style.cssText = 'font-size:9px;text-transform:uppercase;color:#888;letter-spacing:0.05em;padding:4px 12px 2px;font-weight:700';
            biHead.textContent = '★ Built-in';
            exportMenuEl.appendChild(biHead);
            BUILTIN_PRESETS.forEach(p => exportMenuEl.appendChild(mkRow(p.name, p.desc, () => doExport(p), '#cfe8ec')));
            const userPresets = loadViewPresets();
            if (userPresets.length) {
                const uHead = document.createElement('div');
                uHead.style.cssText = 'font-size:9px;text-transform:uppercase;color:#888;letter-spacing:0.05em;padding:6px 12px 2px;font-weight:700';
                uHead.textContent = 'Saved';
                exportMenuEl.appendChild(uHead);
                userPresets.forEach(p => exportMenuEl.appendChild(mkRow(p.name, 'Your saved view', () => doExport(p))));
            }
            const hr = document.createElement('div');
            hr.style.cssText = 'border-top:1px solid rgba(255,255,255,0.10);margin:6px 0';
            exportMenuEl.appendChild(hr);
            exportMenuEl.appendChild(mkRow('⧉ Copy ALL (stacked)', 'Every preset stacked into one plain-text paste, section by section (best for a single multi-section paste)', () => {
                closeExportMenu();
                try {
                    const all = allExportPresets();
                    const sections = all.map(p => {
                        const { text, count } = buildPresetExport(p, allRows);
                        return `=== ${p.name} (${count} row${count === 1 ? '' : 's'}) ===\n${text}`;
                    });
                    copyToClipboard(sections.join('\n\n'), `Copied ALL ${all.length} preset tables (stacked, plain text)`);
                } catch (e) {
                    console.error(`${TAG} export ALL failed:`, e);
                    showToast('Export ALL failed', 'rgba(255,96,96,0.55)');
                }
            }, '#ffd54f'));
            const r = exportBtn.getBoundingClientRect();
            exportMenuEl.style.left = r.left + 'px';
            exportMenuEl.style.top = (r.bottom + 4) + 'px';
            document.body.appendChild(exportMenuEl);
            const mr = exportMenuEl.getBoundingClientRect();
            if (mr.right > window.innerWidth - 8) exportMenuEl.style.left = Math.max(8, window.innerWidth - mr.width - 8) + 'px';
            // Footer sits near the bottom — flip the menu up if it would
            // overflow below the viewport.
            if (mr.bottom > window.innerHeight - 8) exportMenuEl.style.top = Math.max(8, r.top - mr.height - 4) + 'px';
            const onDocClick = (e) => {
                if (exportMenuEl && !exportMenuEl.contains(e.target) && e.target !== exportBtn) {
                    closeExportMenu();
                    document.removeEventListener('mousedown', onDocClick, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
        };
        footer.appendChild(csvBtn);
        footer.appendChild(tsvBtn);
        footer.appendChild(exportBtn);
        footer.appendChild(jsonBtn);
        footer.appendChild(refreshBtn);

        // --- Pending-edits queue area (v3.16) ---
        // Sits to the right of the normal copy buttons. Only visible
        // when at least one Min/Max edit is queued. "Queue: N" pill
        // is informational; the two buttons let the user copy the
        // queue for Sheets (paste into their planning sheet) or
        // discard it entirely. Apply-via-editor is v3.17.
        const queueDivider = document.createElement('div');
        queueDivider.style.cssText = 'width:1px;height:18px;background:rgba(255,255,255,0.12);margin:0 2px';
        const queuePill = document.createElement('span');
        queuePill.style.cssText = 'color:#ffd54f;font-size:11px;font-weight:700;padding:3px 8px;background:rgba(255,213,79,0.10);border:1px solid rgba(255,213,79,0.35);border-radius:3px;cursor:default;letter-spacing:0.3px';
        queuePill.title = 'Pending altitude edits — queued, not yet applied';
        const queueCopyBtn = document.createElement('button');
        queueCopyBtn.textContent = 'Copy queue → Sheets';
        queueCopyBtn.style.cssText = BTN_CSS + ';color:#ffd54f;border-color:rgba(255,213,79,0.45)';
        queueCopyBtn.title = 'Copy the pending-edits queue as TSV for paste into Google Sheets / Excel';
        const queueDiscardBtn = document.createElement('button');
        queueDiscardBtn.textContent = 'Discard queue';
        queueDiscardBtn.style.cssText = BTN_CSS + ';color:#ff8a80;border-color:rgba(255,138,128,0.35)';
        queueDiscardBtn.title = 'Throw away all pending altitude edits';
        // Apply queue — drives Percepto's entity editor for each
        // pending edit. Destructive: writes to the live site. Strong
        // confirm + per-entity error handling + abort button.
        const queueApplyBtn = document.createElement('button');
        queueApplyBtn.textContent = '▶ Apply queue';
        queueApplyBtn.style.cssText = BTN_CSS + ';color:#5fff5f;border-color:rgba(95,255,95,0.55);font-weight:600';
        queueApplyBtn.title = 'Open Percepto\'s entity editor for each pending edit, set values, save. FFZs first, then FP segments.';
        footer.appendChild(queueDivider);
        footer.appendChild(queuePill);
        footer.appendChild(queueApplyBtn);
        footer.appendChild(queueCopyBtn);
        footer.appendChild(queueDiscardBtn);
        // refreshQueueUi() — show/hide based on count, update pill text.
        // Called on every redraw + after queue mutations.
        function refreshQueueUi() {
            const n = pendingEditCount();
            const visible = n > 0;
            queueDivider.style.display = visible ? '' : 'none';
            queuePill.style.display = visible ? '' : 'none';
            queueCopyBtn.style.display = visible ? '' : 'none';
            queueDiscardBtn.style.display = visible ? '' : 'none';
            queueApplyBtn.style.display = visible ? '' : 'none';
            // Disable Apply while a run is in progress so the user
            // can't double-launch. The button's onclick also guards.
            queueApplyBtn.disabled = applyState.running;
            queueApplyBtn.style.opacity = applyState.running ? '0.5' : '';
            queuePill.textContent = `📋 ${n} queued edit${n === 1 ? '' : 's'}`;
        }
        refreshQueueUi();
        queueCopyBtn.onclick = () => {
            const n = pendingEditCount();
            if (n === 0) return;
            const useFt = !!sumPanelState.unitsFt;
            const conv = (m) => useFt ? Math.round(m * 3.28084) : Number(m.toFixed(1));
            const unit = useFt ? 'ft' : 'm';
            const header = ['Type', 'Entity', 'Segment', 'Field', `Old (${unit})`, `New (${unit})`, `Δ (${unit})`];
            const lines = [header.join('\t')];
            // Sort: FFZs first (FP-safety order), then FPs, then Assets
            // (subtype changes). Matches the Apply queue commit order.
            const sorted = Object.values(pendingSegmentEdits).sort((a, b) => {
                const aRank = a.isFfz ? 0 : a.isAsset ? 2 : 1;
                const bRank = b.isFfz ? 0 : b.isAsset ? 2 : 1;
                return aRank - bRank;
            });
            sorted.forEach(e => {
                // v3.50: name is a string field — Old/New hold the names; Δ empty.
                if (e.field === 'name') {
                    const typeLabel = e.isAsset ? 'Asset' : e.isFfz ? 'FFZ' : 'Entity';
                    lines.push([
                        typeLabel,
                        e.oldValue || '',
                        '(entity)',
                        'Name',
                        e.oldValue || '',
                        e.newValue || '',
                        '',
                    ].join('\t'));
                    return;
                }
                // v3.41: subtype is a string field, not numeric. The Old/New
                // columns hold the raw subtype text; Δ is empty.
                if (e.isAsset && e.field === 'subtype') {
                    lines.push([
                        'Asset',
                        e.entityName || e.fpName || '',
                        '(entity)',
                        'Subtype' + (e.isNewSubtype ? ' (NEW)' : ''),
                        e.oldValue || '',
                        e.newValue || '',
                        '',
                    ].join('\t'));
                    return;
                }
                const oldV = conv(e.oldValueM);
                const newV = conv(e.newValueM);
                const delta = newV - oldV;
                const sign = delta > 0 ? '+' : '';
                const segMatch = e.segmentName.match(/^(.+?) - (Seg \d+)$/);
                const entName = segMatch ? segMatch[1] : (e.fpName || e.segmentName);
                const segName = segMatch ? segMatch[2] : (e.isFfz ? '(entity)' : '');
                lines.push([
                    e.isFfz ? 'FFZ' : 'FP',
                    entName,
                    segName,
                    e.field === 'min_alt' ? 'Min Alt' : 'Max Alt',
                    String(oldV),
                    String(newV),
                    `${sign}${delta}`,
                ].join('\t'));
            });
            copyToClipboard(lines.join('\n'), `Copied ${n} pending edit${n === 1 ? '' : 's'} for Sheets`);
        };
        queueDiscardBtn.onclick = () => {
            const n = pendingEditCount();
            if (n === 0) return;
            if (!confirm(`Discard ${n} pending altitude edit${n === 1 ? '' : 's'}?`)) return;
            clearAllPendingEdits();
            redrawTable();
            refreshQueueUi();
            showToast('Pending edits cleared');
        };
        queueApplyBtn.onclick = () => {
            const n = pendingEditCount();
            if (n === 0) return;
            if (applyState.running) return;
            // Pre-flight: catch blocking issues + surface warnings
            // BEFORE the user commits to a run. Blocking = refuse;
            // warnings = show + ask permission.
            const pre = preflightCheckQueue();
            if (!pre.ok) {
                alert(`Cannot apply queue — blocking issues:\n\n${pre.blocking.map(b => '• ' + b).join('\n')}\n\nFix these and try again.`);
                return;
            }
            const groups = groupPendingByEntity();
            const ffzCount = groups.filter(g => g.isFfz).length;
            const astCount = groups.filter(g => g.isAsset).length;
            const fpCount = groups.length - ffzCount - astCount;
            // Open the launcher modal — picks dry-run vs live + shows
            // warnings before any action. Replaces the bare confirm()
            // dialog so the user can see drift warnings.
            openApplyLauncher({
                editCount: n,
                groupCount: groups.length,
                fpCount,
                ffzCount,
                astCount,
                warnings: pre.warnings,
                onLaunch: (opts) => {
                    openApplyProgressModal(groups);
                    runApplyPipeline((st) => {
                        updateApplyProgressModal(st);
                        refreshQueueUi();
                        redrawTable();
                    }, opts).then(() => {
                        closeApplyProgressModal();
                        const failed = applyState.errors.length;
                        const ok = applyState.done;
                        const tag = opts.dryRun ? '[DRY RUN] ' : '';
                        // ⚡ Direct-API runs get the richer report modal
                        // (overlap self-check + rollback). Editor runs keep
                        // the lightweight toast.
                        if (opts.directApi) {
                            openDirectApiReport(applyState, opts);
                            if (failed) console.warn(`${TAG} ⚡ apply failures:`, applyState.errors);
                            console.log(`${TAG} ⚡ audit log at window.__aim_ai_lastApplyLog`);
                        } else if (failed === 0) {
                            showToast(`${tag}✓ ${opts.dryRun ? 'Walked' : 'Applied'} ${ok} edit${ok === 1 ? '' : 's'} successfully`, 'rgba(95,255,95,0.6)');
                        } else {
                            showToast(`${tag}${opts.dryRun ? 'Walked' : 'Applied'} ${ok} · ${failed} failed (see console)`, 'rgba(255,138,128,0.6)');
                            console.warn(`${TAG} apply failures:`, applyState.errors);
                            console.log(`${TAG} apply: full audit log at window.__aim_ai_lastApplyLog`);
                        }
                    });
                },
            });
        };
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
        // Also exposed on window so kickOffDemFetch's completion callback
        // can trigger a redraw after async DEM elevations populate.
        window.__aim_ai_redrawTable = function redrawTableExposed() {
            redrawTable();
        };
        function redrawTable() {
            // v3.52: preserve scroll position across redraws. Without
            // this, every inline-edit commit wiped tableWrap.scrollTop
            // and dumped the user at the top of the table — exactly
            // what they complained about ruining the Tab-down rhythm.
            const prevScrollTop = tableWrap.scrollTop;
            const rows = filterAndSortRows(allRows, sumPanelState);
            // v3.52: expose current visible rows in display order so
            // Tab-navigation in inline edits can find next/prev row.
            window.__aim_ai_visibleRows = rows;
            tableWrap.innerHTML = '';
            const table = document.createElement('table');
            // v3.83: table-layout:fixed + an explicit <colgroup> give every
            // column a known, controllable width — the basis for both
            // resize and the frozen-left pane (sticky offsets = cumulative
            // widths, computed without measuring the DOM).
            table.style.cssText = 'border-collapse:collapse;font-size:12px;table-layout:fixed';

            // Build the active column list — checkbox column always first,
            // then user-selected columns in canonical order. Each col has
            // dataKey (the property on the row for the value) and a render
            // function for the cell.
            const unitLbl = sumPanelState.unitsFt ? 'ft' : 'm';
            // Display: comma-grouped whole feet (or meters with one
            // decimal). Used for every altitude/elevation column so the
            // numbers line up + are easy to read at a glance.
            const fmtAlt = (m) => {
                if (m == null) return '—';
                const v = sumPanelState.unitsFt ? Math.round(m * 3.28084) : Number(m.toFixed(1));
                return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
            };
            // Raw value for right-click → copy (no commas, no units).
            const fmtRaw = (m) => {
                if (m == null) return '';
                return sumPanelState.unitsFt ? String(Math.round(m * 3.28084)) : m.toFixed(1);
            };
            // v3.82: State→color, mirroring the Stats popup's STATE_COLORS so
            // the State column reads as health-at-a-glance. "Normal" is muted
            // (it's the healthy baseline — no need to shout); any modifier
            // state gets its semantic color so problems pop while scanning.
            const SUM_STATE_COLORS = { 'HY': '#00e5ff', 'Empty': '#ffd54f', 'Inactive': '#ff9800', 'Unshielded': '#ff5722', 'Unreachable': '#a855f7' };
            const stateCellColor = (s) => {
                if (!s) return '#555';
                if (s === 'Normal') return '#7a8a92';
                return SUM_STATE_COLORS[s] || '#ffb347'; // unknown modifier → amber flag
            };
            const allColDefs = [
                { key: 'visibility', label: '👁',            w: 28,  num: false, dataKey: '_vis' },
                { key: 'typeShort', label: 'Type',           w: 50,  num: false, dataKey: 'typeShort' },
                { key: 'name',      label: 'Name',           w: 240, num: false, dataKey: 'name' },
                { key: 'segId',     label: 'Seg ID',         w: 80,  num: true,  dataKey: '_segId' },
                { key: 'subtype',   label: 'Subtype',        w: 100, num: false, dataKey: 'subtype' },
                { key: 'equipment', label: 'Equipment',      w: 110, num: false, dataKey: 'equipment' },
                { key: 'state',     label: 'State',          w: 100, num: false, dataKey: 'state' },
                { key: 'gmGroup',   label: 'GM Group',       w: 120, num: false, dataKey: 'gmGroup' },
                { key: 'altMin',    label: `Min Alt (${unitLbl})`,       w: 80,  num: true, dataKey: 'altMinM',   fmt: fmtAlt, raw: fmtRaw },
                { key: 'altMax',    label: `Max Alt (${unitLbl})`,       w: 80,  num: true, dataKey: 'altMaxM',   fmt: fmtAlt, raw: fmtRaw },
                { key: 'emergAlt',  label: `Emerg Alt (${unitLbl})`,     w: 90,  num: true, dataKey: 'emergAltM', fmt: fmtAlt, raw: fmtRaw },
                { key: 'altDelta',  label: `Min/Max Delta (${unitLbl})`, w: 100, num: true, dataKey: 'altDeltaM', fmt: fmtAlt, raw: fmtRaw },
                { key: 'elevation', label: `Elevation (${unitLbl})`,     w: 100, num: true, dataKey: 'elevationM', fmt: fmtAlt, raw: fmtRaw },
                { key: 'agl',       label: `AGL (${unitLbl})`,           w: 80,  num: true, dataKey: 'aglM',      fmt: fmtAlt, raw: fmtRaw },
                { key: 'segLen',    label: `Seg Len (${unitLbl})`,       w: 90,  num: true, dataKey: 'segLenM',   fmt: fmtAlt, raw: fmtRaw },
                { key: 'route',     label: `Route (${unitLbl})`,         w: 95,  num: true, dataKey: 'routeM',    fmt: fmtAlt, raw: fmtRaw },
                { key: 'validated', label: 'Valid',          w: 50,  num: false, dataKey: 'validated' },
                { key: 'unshielded',label: 'Unshielded',     w: 80,  num: false, dataKey: 'unshielded' },
                { key: 'notes',     label: 'Notes',          w: 220, num: false, dataKey: 'notesText' },
                // Point-entity coordinates — populated only for GMs + Assets.
                { key: 'lat',       label: 'Lat',            w: 90,  num: true,  dataKey: '_lat' },
                { key: 'long',      label: 'Long',           w: 90,  num: true,  dataKey: '_lng' },
                { key: 'gps',       label: 'GPS',            w: 150, num: false, dataKey: '_gps' },
            ];
            const COL_BY_KEY = Object.fromEntries(allColDefs.map(c => [c.key, c]));
            // Honor the user's persisted order — visibleCols was replaced
            // by columnOrder (an ordered array). Map order → defs and
            // drop any keys we don't know about (forwards compat).
            const cols = sumPanelState.columnOrder
                .map(k => COL_BY_KEY[k])
                .filter(Boolean);

            // ---- v3.83: column widths (persisted; default = col def `w`) ----
            const SEL_W = 32; // checkbox column
            const colWidth = (col) => {
                const w = sumPanelState.columnWidths[col.key];
                return (typeof w === 'number' && w >= 40) ? w : col.w;
            };
            // <colgroup> drives the widths. Table width is set to the EXACT
            // sum (not 100%) so fixed-layout doesn't redistribute leftover
            // space, which would desync the frozen offsets.
            const colgroup = document.createElement('colgroup');
            const colEls = {};
            const colSel = document.createElement('col');
            colSel.style.width = SEL_W + 'px';
            colgroup.appendChild(colSel);
            cols.forEach(col => {
                const cEl = document.createElement('col');
                cEl.style.width = colWidth(col) + 'px';
                colEls[col.key] = cEl;
                colgroup.appendChild(cEl);
            });
            table.appendChild(colgroup);
            const totalW = () => SEL_W + cols.reduce((s, c) => s + colWidth(c), 0);
            table.style.width = totalW() + 'px';

            // ---- Frozen-left pane: checkbox + every column THROUGH Name ----
            // Sticky panes must be contiguous from the left edge, so we freeze
            // the run from the checkbox up to and including Name. Drag Name
            // leftward (or hide columns left of it) to freeze fewer columns.
            const nameIdx = cols.findIndex(c => c.key === 'name');
            const frozenCount = nameIdx >= 0 ? nameIdx + 1 : 0;
            const frozenCols = cols.slice(0, frozenCount);
            const frozenKeys = new Set(frozenCols.map(c => c.key));
            const lastFrozenKey = frozenCount > 0 ? frozenCols[frozenCount - 1].key : '__sel__';
            const frozenLeft = {};
            const recomputeFrozenLeft = () => {
                let acc = SEL_W;
                frozenCols.forEach(c => { frozenLeft[c.key] = acc; acc += colWidth(c); });
            };
            recomputeFrozenLeft();
            const FROZEN_BODY_BG = '#1f2228', FROZEN_BODY_HOVER = '#1e333a', FROZEN_HEAD_BG = '#262a31';
            // The pane divider is an INSET box-shadow on the last frozen
            // cell, NOT border-right: with border-collapse the shared border
            // gets owned by the (scrolling) next cell and drifts off the
            // frozen edge. A box-shadow paints with the sticky cell, so it
            // stays anchored to Name's right edge while scrolling.
            const frozenShadow = 'inset -2px 0 0 0 rgba(20,210,220,0.45)';
            // Apply sticky-left styling to one cell (th or td).
            const applyFrozen = (cell, key, isHead) => {
                cell.setAttribute('data-frozen-key', key);
                cell.style.position = 'sticky';
                cell.style.left = (key === '__sel__' ? 0 : frozenLeft[key]) + 'px';
                cell.style.zIndex = isHead ? '2' : '1';
                cell.style.background = isHead ? FROZEN_HEAD_BG : FROZEN_BODY_BG;
                if (key === lastFrozenKey) cell.style.boxShadow = frozenShadow;
            };
            // Live-resize: set one column's width, retotal the table, and
            // reposition frozen cells in place — no full rebuild.
            const setColWidth = (col, px) => {
                px = Math.max(40, Math.round(px));
                sumPanelState.columnWidths[col.key] = px;
                if (colEls[col.key]) colEls[col.key].style.width = px + 'px';
                table.style.width = totalW() + 'px';
                recomputeFrozenLeft();
                tableWrap.querySelectorAll('[data-frozen-key]').forEach(el => {
                    const k = el.getAttribute('data-frozen-key');
                    if (k && k !== '__sel__' && frozenLeft[k] != null) el.style.left = frozenLeft[k] + 'px';
                });
            };

            // Header row — first cell is the select-all checkbox, then
            // user-selected columns sorted by their canonical position.
            const thead = document.createElement('thead');
            // z-index:5 keeps the sticky header above frozen BODY cells
            // (which sit at z-index:1) during vertical scroll.
            thead.style.cssText = 'position:sticky;top:0;background:#262a31;z-index:5';
            const headRow = document.createElement('tr');
            // Select-all checkbox
            const thSel = document.createElement('th');
            thSel.style.cssText = 'padding:6px 6px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.12)';
            applyFrozen(thSel, '__sel__', true);
            const selAll = document.createElement('input');
            selAll.type = 'checkbox';
            selAll.style.cssText = 'accent-color:rgb(20,210,220);cursor:pointer';
            // Indeterminate when partial selection
            const rowIds = rows.map(r => r._rowKey);
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
                // position:relative anchors the × + resize grip; 18px right
                // padding reserves room for them; overflow:hidden clips long
                // labels (the inner span ellipsizes).
                th.style.cssText = `position:relative;padding:6px 18px 6px 8px;text-align:${col.num ? 'right' : 'left'};color:${isSorted ? '#7adfe6' : '#bbb'};font-weight:600;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.12);cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden`;
                const lblSpan = document.createElement('span');
                lblSpan.textContent = col.label + (isSorted ? (sumPanelState.sortDir === 1 ? ' ▲' : ' ▼') : '');
                lblSpan.style.cssText = 'display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom';
                th.appendChild(lblSpan);

                // Sort: asc → desc → default (3-state). The × + grip below
                // stopPropagation so they never trigger a sort.
                th.title = isSorted
                    ? (sumPanelState.sortDir === 1 ? 'Click → descending; again → reset · drag to reorder · drag right edge to resize' : 'Click → reset to default sort · drag to reorder · drag right edge to resize')
                    : 'Click to sort ascending · drag to reorder · drag right edge to resize';
                th.onclick = () => {
                    if (sumPanelState.sortKey !== key) {
                        sumPanelState.sortKey = key;
                        sumPanelState.sortDir = 1;
                    } else if (sumPanelState.sortDir === 1) {
                        sumPanelState.sortDir = -1;
                    } else {
                        sumPanelState.sortKey = 'typePrio';
                        sumPanelState.sortDir = 1;
                    }
                    redrawTable();
                };

                // Drag-to-reorder (HTML5 DnD). Drop inserts the dragged column
                // immediately BEFORE this one.
                th.draggable = true;
                th.ondragstart = (ev) => {
                    ev.dataTransfer.effectAllowed = 'move';
                    ev.dataTransfer.setData('text/plain', col.key);
                    th.style.opacity = '0.4';
                };
                th.ondragend = () => { th.style.opacity = '1'; };
                th.ondragover = (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; th.style.boxShadow = 'inset 3px 0 0 #14d2dc'; };
                th.ondragleave = () => { th.style.boxShadow = ''; };
                th.ondrop = (ev) => {
                    ev.preventDefault();
                    th.style.boxShadow = '';
                    const fromKey = ev.dataTransfer.getData('text/plain');
                    if (!fromKey || fromKey === col.key) return;
                    const order = sumPanelState.columnOrder.slice();
                    const fi = order.indexOf(fromKey);
                    if (fi < 0) return;
                    order.splice(fi, 1);
                    const ti = order.indexOf(col.key);
                    if (ti < 0) return;
                    order.splice(ti, 0, fromKey);
                    sumPanelState.columnOrder = order;
                    saveColumnOrder(order);
                    redrawTable();
                };

                // Inline × — hide this column (re-add via Columns ▾). Shows on
                // header hover so it doesn't clutter the resting state.
                const xBtn = document.createElement('span');
                xBtn.textContent = '×';
                xBtn.title = 'Hide this column (re-add via Columns ▾)';
                xBtn.draggable = false;
                xBtn.style.cssText = 'position:absolute;top:3px;right:7px;color:#999;font-size:13px;line-height:1;cursor:pointer;opacity:0;transition:opacity .1s;padding:0 2px;z-index:1';
                xBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    sumPanelState.columnOrder = sumPanelState.columnOrder.filter(k => k !== col.key);
                    saveColumnOrder(sumPanelState.columnOrder);
                    redrawTable();
                };
                th.onmouseenter = () => { xBtn.style.opacity = '1'; };
                th.onmouseleave = () => { xBtn.style.opacity = '0'; };
                th.appendChild(xBtn);

                // Resize grip on the right edge. Drag = resize (live, no
                // rebuild); double-click = reset that column to default width.
                const grip = document.createElement('div');
                grip.title = 'Drag to resize · double-click to reset width';
                grip.draggable = false;
                grip.style.cssText = 'position:absolute;top:0;right:0;width:6px;height:100%;cursor:col-resize;z-index:2';
                grip.onclick = (ev) => ev.stopPropagation();
                grip.onmousedown = (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    th.draggable = false; // stop DnD hijacking the resize drag
                    const startX = ev.clientX;
                    const startW = colWidth(col);
                    const onMove = (e2) => setColWidth(col, startW + (e2.clientX - startX));
                    const onUp = () => {
                        document.removeEventListener('mousemove', onMove, true);
                        document.removeEventListener('mouseup', onUp, true);
                        th.draggable = true;
                        saveColWidths();
                    };
                    document.addEventListener('mousemove', onMove, true);
                    document.addEventListener('mouseup', onUp, true);
                };
                grip.ondblclick = (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    delete sumPanelState.columnWidths[col.key];
                    saveColWidths();
                    redrawTable();
                };
                th.appendChild(grip);

                if (frozenKeys.has(col.key)) applyFrozen(th, col.key, true);
                headRow.appendChild(th);
            });
            thead.appendChild(headRow);
            table.appendChild(thead);

            // Body rows
            const tbody = document.createElement('tbody');
            rows.forEach((r) => {
                const tr = document.createElement('tr');
                // v3.52: data-row-key enables Tab-navigation between
                // inline edits — startInlineSubtypeEdit/NameEdit finds
                // the next row's cell via querySelector after commit.
                tr.setAttribute('data-row-key', r._rowKey);
                tr.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.05)';
                // Frozen (sticky-left) cells need an OPAQUE background or the
                // scrolling columns show through them; collect them so the
                // row-hover tint stays in sync across the whole row.
                const frozenTds = [];
                tr.onmouseenter = () => { tr.style.background = 'rgba(20,210,220,0.10)'; frozenTds.forEach(td => td.style.background = FROZEN_BODY_HOVER); };
                tr.onmouseleave = () => { tr.style.background = 'transparent'; frozenTds.forEach(td => td.style.background = FROZEN_BODY_BG); };

                // Checkbox cell — clicks here don't trigger row navigation.
                const tdSel = document.createElement('td');
                tdSel.style.cssText = 'padding:5px 6px;text-align:center';
                applyFrozen(tdSel, '__sel__', false);
                frozenTds.push(tdSel);
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = sumPanelState.selectedIds.has(r._rowKey);
                cb.style.cssText = 'accent-color:rgb(20,210,220);cursor:pointer';
                cb.onclick = (ev) => ev.stopPropagation();
                cb.onchange = () => {
                    if (cb.checked) sumPanelState.selectedIds.add(r._rowKey);
                    else sumPanelState.selectedIds.delete(r._rowKey);
                    // Update header select-all state without full redraw
                    const newSel = rowIds.filter(id => sumPanelState.selectedIds.has(id)).length;
                    selAll.checked = newSel > 0 && newSel === rows.length;
                    selAll.indeterminate = newSel > 0 && newSel < rows.length;
                    countEl.textContent = makeCountText(rows.length, allRows.length, sumPanelState.selectedIds.size);
                };
                tdSel.appendChild(cb);
                tr.appendChild(tdSel);

                // Body cell click → row action. For segment rows, pan/zoom
                // to the segment specifically (bounds-fit on point_a + b);
                // for entity rows, pan to centroid + open inspector. The
                // inspector still uses the parent FP entity for segment
                // rows — segment-specific data is already in the cells.
                const onRowClick = () => {
                    if (r._isSegment && r.arc) {
                        panToSegment(r.arc);
                    } else {
                        panToEntity(r.entity);
                    }
                    const px = sumPanelState.x != null ? sumPanelState.x + (sumPanelState.w || 720) + 10 : 60;
                    const py = sumPanelState.y != null ? sumPanelState.y + 40 : 100;
                    showInspectorPopup(
                        Math.min(px, window.innerWidth - 360),
                        Math.min(py, window.innerHeight - 380),
                        r.entity
                    );
                };

                // Compute the effective Min/Max/Delta/AGL once per row
                // (with any pending edits applied) so every column that
                // depends on these values stays consistent — editing Min
                // immediately yellow-tints Delta + AGL too, and editing
                // AGL routes through Min and yellow-tints Min + Delta.
                const eff = effectiveValues(r);
                // AGL color (used in two places — color the AGL cell + the
                // bulk-target preview).
                const aglColor = (() => {
                    if (eff.effAgl == null) return '#bbb';
                    const ft = eff.effAgl * 3.28084;
                    if (ft < 90) return '#ff5252';
                    if (ft > 200) return '#3399ff';
                    return '#5fff5f';
                })();

                cols.forEach(col => {
                    const td = document.createElement('td');
                    td.style.cursor = 'pointer';
                    td.onclick = onRowClick;
                    td.setAttribute('data-col-key', col.key);
                    if (col.key === 'visibility') {
                        // v3.47: per-entity eye icon. M1 toggles, M2 solos.
                        // Only applies to entity rows — segments inherit from
                        // their parent FP, so segment rows show a dim em-dash.
                        td.style.cssText = 'padding:5px 4px;text-align:center;cursor:pointer;font-size:14px;line-height:1';
                        if (r._isSegment) {
                            td.textContent = '—';
                            td.style.color = '#555';
                            td.title = 'Segments inherit visibility from the parent flight path';
                        } else {
                            const visible = isEntityVisible(r.entity.id);
                            td.textContent = '👁';
                            td.style.color = visible ? '#14d2dc' : '#555';
                            td.style.opacity = visible ? '1' : '0.35';
                            td.style.textDecoration = visible ? 'none' : 'line-through';
                            td.title = visible
                                ? 'M1: hide this entity · M2: SOLO (hide all others)'
                                : 'M1: show this entity · M2: show ALL entities again';
                            td.onclick = (ev) => {
                                ev.stopPropagation();
                                toggleEntityVisibility(r.entity);
                            };
                            td.oncontextmenu = (ev) => {
                                ev.preventDefault();
                                ev.stopPropagation();
                                if (visible) {
                                    // Solo this one — collect all entity IDs
                                    // from the current bucket so the state
                                    // reflects "everyone but this one".
                                    const siteID = getCurrentSiteID();
                                    ensurePanelVisibility(siteID);
                                    const bucket = siteID ? mapObjectsBySite[siteID] : null;
                                    const allIds = bucket ? (bucket.entities || []).map(e => e.id) : [];
                                    soloEntityVisibility(r.entity, allIds);
                                } else {
                                    unsoloAllVisibility();
                                }
                            };
                        }
                    } else if (col.key === 'typeShort') {
                        td.style.cssText = `padding:5px 8px;color:${typeBadgeColor(r.type)};font-weight:600;font-size:11px;cursor:pointer`;
                        td.textContent = r.typeShort;
                    } else if (col.key === 'name') {
                        // v3.50: Name cell is click-to-EDIT (queues rename)
                        // for non-segment entity rows. M2 always copies the
                        // current name to clipboard.
                        // Segment rows stay click-to-pan/inspect (row default).
                        const isEditable = !r._isSegment && r.entity;
                        const nameColor = r._isSegment ? '#a8c8d2' : '#e6e6e6';
                        const eff = isEditable ? effectiveName(r.entity) : { value: r.name || '', pending: false };
                        // v3.52: nowrap so the pending overlay doesn't double row height.
                        const nameNowrap = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px';
                        if (eff.pending && eff.oldValue) {
                            td.style.cssText = `padding:5px 8px;cursor:pointer;border-bottom:1px dotted rgba(122,223,230,0.30);${nameNowrap}`;
                            const oldSpan = document.createElement('span');
                            oldSpan.textContent = eff.oldValue;
                            oldSpan.style.cssText = 'color:#888;text-decoration:line-through;margin-right:5px';
                            const newSpan = document.createElement('span');
                            newSpan.textContent = eff.value;
                            newSpan.style.cssText = 'color:#ffd54f;font-weight:700';
                            td.appendChild(oldSpan);
                            td.appendChild(newSpan);
                            td.title = `Was "${eff.oldValue}", will be "${eff.value}". M1: re-edit · M2: copy original.`;
                        } else {
                            td.style.cssText = `padding:5px 8px;color:${nameColor};cursor:pointer${isEditable ? ';border-bottom:1px dotted rgba(122,223,230,0.30)' : ''};${nameNowrap}`;
                            td.textContent = eff.value || '(unnamed)';
                            td.title = isEditable
                                ? 'M1: edit name (queues) · M2: copy to clipboard'
                                : 'M2: copy to clipboard';
                        }
                        if (isEditable) {
                            td.onclick = (ev) => {
                                ev.stopPropagation();
                                // v3.89: pan to the asset too, so clicking the
                                // (frozen, prominent) Name cell still moves the
                                // map — not just opens the rename editor. No
                                // inspector popup here so it doesn't cover the
                                // inline editor.
                                if (r._isSegment && r.arc) panToSegment(r.arc); else panToEntity(r.entity);
                                startInlineNameEdit(td, r.entity);
                            };
                        }
                        td.oncontextmenu = (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            // Copy the EFFECTIVE (pending if any, else current)
                            // name. Matches the subtype cell's pattern.
                            const txt = (eff && eff.value) || r.name || '';
                            if (!txt) return;
                            copyToClipboard(txt, `Copied "${txt}"`);
                        };
                    } else if (col.key === 'segId') {
                        // FP segment rows show the arc's ID from Percepto's
                        // JSON. NOT stable across saves — Percepto
                        // regenerates IDs when an FP is edited. Useful as
                        // a snapshot reference (cross-ref JSON / screenshots
                        // / coworker chats), not as a stable identifier.
                        // Non-segment rows show a dash.
                        td.style.cssText = 'padding:5px 8px;color:#7a8a92;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer';
                        td.textContent = r._segId != null ? String(r._segId) : '—';
                        td.title = r._segId != null
                            ? `Arc ID ${r._segId} from current site data. Right-click: copy. NOTE: Percepto regenerates this on every FP save — use Seg # for stable identity.`
                            : 'Only FP segment rows have a Seg ID.';
                        td.oncontextmenu = (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            if (r._segId == null) return;
                            copyToClipboard(String(r._segId), `Copied ${r._segId}`);
                        };
                    } else if (col.key === 'subtype') {
                        // v3.41: asset subtype cells are inline-editable.
                        // Non-asset rows (FP/FFZ/NFZ/markers) stay plain text.
                        // v3.52: force single-line via nowrap+ellipsis so the
                        // pending overlay (old strikethrough + new) doesn't
                        // double row height and ruin the Tab-down rhythm.
                        const isAsset = r.type === 3 && r.entity;
                        const eff = isAsset ? effectiveSubtype(r.entity) : { value: r.subtype || '', pending: false };
                        const baseColor = eff.pending ? '#ffd54f' : '#bbb';
                        td.style.cssText = `padding:5px 8px;color:${baseColor};font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px${isAsset ? ';border-bottom:1px dotted rgba(122,223,230,0.30)' : ''}`;
                        if (eff.pending && eff.oldValue) {
                            const oldSpan = document.createElement('span');
                            oldSpan.textContent = eff.oldValue;
                            oldSpan.style.cssText = 'color:#888;text-decoration:line-through;margin-right:5px;font-weight:normal';
                            const newSpan = document.createElement('span');
                            newSpan.textContent = eff.value + (eff.isNew ? ' ✨' : '');
                            newSpan.style.cssText = 'color:#ffd54f;font-weight:700';
                            td.appendChild(oldSpan);
                            td.appendChild(newSpan);
                            td.title = `Was "${eff.oldValue}", will be "${eff.value}"${eff.isNew ? ' (NEW type — will be added to Percepto)' : ''}. Click to re-edit · Right-click: copy current value.`;
                        } else {
                            td.textContent = eff.value || '—';
                            td.title = isAsset
                                ? 'Click: edit subtype · Right-click: copy'
                                : (r.subtype ? 'Right-click: copy' : 'No subtype');
                        }
                        if (isAsset) {
                            td.onclick = (ev) => {
                                ev.stopPropagation();
                                panToEntity(r.entity); // v3.89: pan + edit (see Name cell)
                                startInlineSubtypeEdit(td, r.entity);
                            };
                        }
                        td.oncontextmenu = (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            const txt = eff.value || r.subtype || '';
                            if (!txt) return;
                            copyToClipboard(txt, `Copied "${txt}"`);
                        };
                    } else if (col.key === 'altMin' || col.key === 'altMax' || col.key === 'altDelta') {
                        // Min, Max, and Delta cells. Min/Max on FP segment
                        // rows are inline-editable. Delta is derived; never
                        // directly editable but updates live when Min/Max
                        // change (pending=true if either input is pending).
                        const editable = isEditableRow(r) && (col.key === 'altMin' || col.key === 'altMax');
                        const fieldName = col.key === 'altMin' ? 'min_alt' : 'max_alt';
                        // Pending check — for Delta, true if EITHER min/max
                        // has a pending edit; for Min/Max, true iff that
                        // exact field has a pending edit.
                        let pending = false, origM = null, newM = null;
                        if (col.key === 'altMin') {
                            pending = eff.minPending;
                            origM = r.altMinM;
                            newM = eff.effMin;
                        } else if (col.key === 'altMax') {
                            pending = eff.maxPending;
                            origM = r.altMaxM;
                            newM = eff.effMax;
                        } else { // altDelta
                            pending = eff.deltaPending;
                            origM = r.altDeltaM;
                            newM = eff.effDelta;
                        }
                        const baseColor = pending ? '#ffd54f' : '#e6e6e6';
                        td.style.cssText = `padding:5px 8px;color:${baseColor};text-align:right;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer${editable ? ';border-bottom:1px dotted rgba(122,223,230,0.30)' : ''}`;
                        if (pending && origM != null) {
                            const oldSpan = document.createElement('span');
                            oldSpan.textContent = col.fmt(origM);
                            oldSpan.style.cssText = 'color:#888;text-decoration:line-through;margin-right:5px;font-weight:normal';
                            const newSpan = document.createElement('span');
                            newSpan.textContent = col.fmt(newM);
                            newSpan.style.cssText = 'color:#ffd54f;font-weight:700';
                            td.appendChild(oldSpan);
                            td.appendChild(newSpan);
                            td.title = `Was ${col.raw(origM)}, will be ${col.raw(newM)}.${editable ? ' Click to re-edit · Right-click: copy raw.' : ' Derived — edit Min or Max to change.'}`;
                        } else {
                            td.textContent = col.fmt(newM);
                            if (editable) {
                                td.title = 'Click: edit · Right-click: copy raw';
                            } else {
                                td.title = 'Click: pan/inspect · Right-click: copy raw';
                            }
                        }
                        if (editable) {
                            td.onclick = (ev) => {
                                ev.stopPropagation();
                                startInlineSegmentEdit(td, r, fieldName);
                            };
                        }
                        td.oncontextmenu = (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            // Right-click copies the EFFECTIVE value (new
                            // if pending, otherwise current). That's what
                            // the user sees and wants in the paste.
                            if (newM == null) return;
                            const raw = col.raw(newM);
                            copyToClipboard(raw, `Copied ${raw}`);
                        };
                    } else if (col.key === 'elevation') {
                        // MBT-style: light purple, bold, comma-grouped.
                        // Right-click copies the raw unformatted number
                        // (no commas, no units) for paste into formulas.
                        td.style.cssText = 'padding:5px 8px;color:#c4b5fd;text-align:right;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer';
                        td.textContent = col.fmt(r.elevationM);
                        td.oncontextmenu = (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            if (r.elevationM == null) return;
                            const raw = col.raw(r.elevationM);
                            copyToClipboard(raw, `Copied ${raw}`);
                        };
                        td.title = r.type === 3
                            ? 'Asset\'s claimed elevation (custom.elevation_asl). Click: pan · Right-click: copy raw.'
                            : 'Max DEM elevation across sampled points along the segment/polygon. Click: pan · Right-click: copy raw.';
                    } else if (col.key === 'agl') {
                        // AGL is derived (Min − Elevation). For FP segment
                        // rows it's also INLINE-EDITABLE: editing AGL
                        // queues a Min edit equal to elevation + AGL.
                        // Lets the user approach altitude from either
                        // direction. Live-updates when Min changes too.
                        const editable = isEditableRow(r) && r.elevationM != null;
                        td.style.cssText = `padding:5px 8px;color:${aglColor};text-align:right;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;cursor:pointer${editable ? ';border-bottom:1px dotted rgba(122,223,230,0.30)' : ''}`;
                        if (eff.aglPending && r.aglM != null) {
                            // Pending: show OLD AGL strikethrough + NEW
                            // AGL in yellow (overriding the color rule
                            // so the user sees this is a queued change).
                            const oldSpan = document.createElement('span');
                            oldSpan.textContent = col.fmt(r.aglM);
                            oldSpan.style.cssText = 'color:#888;text-decoration:line-through;margin-right:5px;font-weight:normal';
                            const newSpan = document.createElement('span');
                            newSpan.textContent = col.fmt(eff.effAgl);
                            newSpan.style.cssText = 'color:#ffd54f;font-weight:700';
                            td.appendChild(oldSpan);
                            td.appendChild(newSpan);
                            td.title = `AGL was ${col.raw(r.aglM)}, will be ${col.raw(eff.effAgl)}.${editable ? ' Click to re-edit.' : ''}`;
                        } else {
                            td.textContent = col.fmt(eff.effAgl);
                            if (editable) {
                                td.title = 'Click: edit AGL (will queue Min Alt = Elev + AGL) · Right-click: copy raw';
                            } else {
                                td.title = 'Click: pan/inspect · Right-click: copy raw';
                            }
                        }
                        if (editable) {
                            td.onclick = (ev) => {
                                ev.stopPropagation();
                                startInlineSegmentEdit(td, r, 'agl');
                            };
                        }
                        td.oncontextmenu = (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            if (eff.effAgl == null) return;
                            const raw = col.raw(eff.effAgl);
                            copyToClipboard(raw, `Copied ${raw}`);
                        };
                    } else if (col.key === 'validated') {
                        // null → N/A (Assets/Markers — Percepto hides the toggle for these).
                        // true → green ✓, false → red ✗ for FFZ/FP/NFZ.
                        let txt = '—', color = '#666';
                        if (r.validated === true) { txt = '✓'; color = '#5fff5f'; }
                        else if (r.validated === false) { txt = '✗'; color = '#ff5555'; }
                        td.style.cssText = `padding:5px 8px;text-align:center;color:${color};cursor:pointer;font-weight:600`;
                        td.textContent = txt;
                    } else if (col.key === 'lat' || col.key === 'long') {
                        // Point coordinate (GMs + Assets only). Click or
                        // right-click copies the raw number. M1-edit to move
                        // the marker is a planned fast-follow.
                        const v = col.key === 'lat' ? r._lat : r._lng;
                        td.style.cssText = 'padding:5px 8px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer';
                        if (v == null) {
                            td.textContent = '—';
                            td.style.color = '#555';
                            td.title = 'Only point entities (General Markers, Assets) have a single coordinate';
                        } else {
                            td.style.color = '#cdd6e0';
                            td.textContent = v.toFixed(6);
                            td.title = 'Click or right-click to copy. (Editing — moving the marker — coming soon.)';
                            const copy = (ev) => { ev.preventDefault(); ev.stopPropagation(); copyToClipboard(String(v), `Copied ${v.toFixed(6)}`); };
                            td.onclick = copy;
                            td.oncontextmenu = copy;
                        }
                    } else if (col.key === 'gps') {
                        // Google Maps link — shows the "lat, lng" pair (6 dp) as
                        // the link text. M1 opens a new tab, M2 copies the URL.
                        td.style.cssText = 'padding:5px 8px;text-align:left;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer';
                        if (r._lat == null) {
                            td.textContent = '—';
                            td.style.color = '#555';
                            td.title = 'Only point entities (General Markers, Assets) have a coordinate';
                        } else {
                            const url = `https://www.google.com/maps?q=${r._lat},${r._lng}`;
                            const a = document.createElement('span');
                            a.textContent = `${r._lat.toFixed(6)}, ${r._lng.toFixed(6)}`;
                            a.style.cssText = 'color:#8ab4f8;text-decoration:underline;white-space:nowrap';
                            td.appendChild(a);
                            td.title = 'Click: open in Google Maps (new tab). Right-click: copy the Maps link.';
                            td.onclick = (ev) => {
                                ev.preventDefault();
                                ev.stopPropagation();
                                let opened = null;
                                try { opened = (window.top || window).open(url, '_blank'); }
                                catch (e2) { opened = null; }
                                if (!opened) copyToClipboard(url, 'Popup blocked — copied link');
                            };
                            td.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); copyToClipboard(url, 'Copied Maps link'); };
                        }
                    } else if (col.key === 'equipment' || col.key === 'gmGroup') {
                        // Plain text (asset equipment / GM group). Blank for
                        // rows the field doesn't apply to. Right-click copies.
                        const v = r[col.dataKey] || '';
                        const color = col.key === 'gmGroup' ? '#c4a8f0' : '#cdd6e0';
                        td.style.cssText = `padding:5px 8px;color:${v ? color : '#555'};font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:${col.w + 20}px`;
                        td.textContent = v || '—';
                        if (v) {
                            td.title = `${v} — Right-click: copy`;
                            td.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); copyToClipboard(v, `Copied "${v}"`); };
                        } else {
                            td.title = col.key === 'gmGroup' ? 'GM Group applies to general markers only' : 'Equipment is parsed from asset subtype (before " - ")';
                        }
                    } else if (col.key === 'state') {
                        // Asset state, colored by severity (Normal muted, any
                        // modifier in its semantic color so problems pop).
                        const v = r.state || '';
                        td.style.cssText = `padding:5px 8px;color:${stateCellColor(v)};font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap`;
                        td.textContent = v || '—';
                        if (v) {
                            td.title = `Asset state "${v}" (subtype after " - "; no modifier = Normal). Right-click: copy`;
                            td.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); copyToClipboard(v, `Copied "${v}"`); };
                        } else {
                            td.title = 'State applies to assets only';
                        }
                    } else if (col.key === 'emergAlt' || col.key === 'segLen') {
                        // FP-segment-only numerics. fmt/raw convert m→ft per
                        // the unit toggle, same as the other altitude columns.
                        const m = r[col.dataKey];
                        td.style.cssText = `padding:5px 8px;color:${m == null ? '#555' : '#cdd6e0'};text-align:right;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer`;
                        td.textContent = col.fmt(m);
                        if (m == null) {
                            td.title = col.key === 'emergAlt' ? 'Emergency altitude — FP segments only' : 'Segment length — FP segments only';
                        } else {
                            td.title = (col.key === 'emergAlt' ? 'Emergency ceiling (arc.min_emergency_alt). ' : 'Segment length (arc.distance). ') + 'Right-click: copy raw';
                            td.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); const raw = col.raw(m); copyToClipboard(raw, `Copied ${raw}`); };
                        }
                    } else if (col.key === 'route') {
                        // Route from base → asset's FFZ far edge along connected
                        // flight paths (asset rows only). Hover = breakdown.
                        // — non-asset / no base; ⚠ unreachable (no FFZ / no FP).
                        const m = r.routeM;
                        const isAsset = r.type === 3 && !r._isSegment;
                        td.style.cssText = `padding:5px 8px;color:${m == null ? '#555' : '#cdd6e0'};text-align:right;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer`;
                        if (m == null) {
                            const reasons = {
                                'no-ffz': `Unreachable — no inspection FFZ within ${REACH_FFZ_FT} ft of this asset.`,
                                'ffz-no-fp': "Unreachable — the asset's FFZ has no flight path reaching it.",
                                'unreachable': "Unreachable — no connected flight-path route from the base reaches the asset's FFZ.",
                            };
                            td.textContent = (isAsset && r._routeReason) ? '⚠' : '—';
                            td.title = !isAsset ? 'Route is computed for assets only'
                                : (reasons[r._routeReason] || 'No route — set a basestation via 📍 Base, and ensure flight paths exist on this site');
                        } else {
                            td.textContent = col.fmt(m);
                            const bk = r._routeBreak;
                            const u = sumPanelState.unitsFt ? 'ft' : 'm';
                            const baseNm = (r._routeBase && r._routeBase.name) ? r._routeBase.name : 'base';
                            td.title = bk
                                ? `Route ≈ ${col.fmt(m)} ${u} one-way, from "${baseNm}" to the far edge of this asset's FFZ.\nBase→FP ${col.fmt(bk.inM)} + along FPs ${col.fmt(bk.netM)} + FFZ traversal ${col.fmt(bk.ffzM)}.\nRight-click: copy raw.`
                                : 'Route from base. Right-click: copy raw.';
                            td.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); const raw = col.raw(m); copyToClipboard(raw, `Copied ${raw}`); };
                        }
                    } else if (col.key === 'unshielded') {
                        // ✓ = unshielded (a drone-safety concern), ✗ = shielded,
                        // — = N/A. The flag is meaningful for FFZ + Assets.
                        let txt = '—', color = '#666';
                        if (r.unshielded) { txt = '✓'; color = '#ff5722'; }
                        else if (r.type === 16 || r.type === 3) { txt = '✗'; color = '#5fff5f'; }
                        td.style.cssText = `padding:5px 8px;text-align:center;color:${color};cursor:pointer;font-weight:600`;
                        td.textContent = txt;
                        td.title = (r.type === 16 || r.type === 3)
                            ? (r.unshielded ? 'Unshielded (drone-safety concern)' : 'Shielded')
                            : 'Unshielded flag applies to FFZ + Assets';
                    } else if (col.key === 'notes') {
                        // Description text, single-line with full text on hover.
                        const v = r.notesText || '';
                        td.style.cssText = `padding:5px 8px;color:${v ? '#b8c2cc' : '#555'};font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px`;
                        td.textContent = v || '—';
                        if (v) {
                            td.title = v + '\n\nRight-click: copy';
                            td.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); copyToClipboard(v, 'Copied note'); };
                        } else {
                            td.title = 'No notes';
                        }
                    }
                    if (frozenKeys.has(col.key)) {
                        applyFrozen(td, col.key, false);
                        frozenTds.push(td);
                    }
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            tableWrap.appendChild(table);
            // v3.52: restore the scroll position we saved at the top of
            // redrawTable. Inline-edit commits trigger a full redraw;
            // keeping the user in the same vertical position is what
            // makes Tab-to-next-row feel like a continuous edit flow.
            try { tableWrap.scrollTop = prevScrollTop; } catch (e) {}

            countEl.textContent = makeCountText(rows.length, allRows.length, sumPanelState.selectedIds.size);
            refreshQueueUi();
            // Re-render sample-point markers whenever the filtered row
            // set changes — keeps the map in sync with what's visible.
            // Honors the persisted toggle so reopens stay consistent.
            if (sumPanelState.showSamples) showSampleMarkersFor(rows);

            // Helper — pick which rows to export. Selection wins when any
            // are checked; otherwise the current filter+sort snapshot.
            const exportRows = () => {
                if (sumPanelState.selectedIds.size > 0) {
                    return rows.filter(r => sumPanelState.selectedIds.has(r._rowKey));
                }
                return rows;
            };

            // Tabular row generator — used for both CSV and TSV. Returns
            // [header, ...dataRows] where each row is an array of stringy
            // cell values. Only includes visible columns (the user toggled
            // them off, so they don't want them in exports either).
            const tabular = () => {
                const header = cols.map(c => c.label);
                const num = (m) => {
                    if (m == null) return '';
                    return sumPanelState.unitsFt ? Math.round(m * 3.28084).toString() : m.toFixed(1);
                };
                const data = exportRows().map(r => cols.map(col => {
                    if (col.key === 'visibility') {
                        // Visibility is UI state, not data. Empty cell in
                        // exports keeps the column count consistent with
                        // the header without leaking emoji into spreadsheets.
                        return '';
                    }
                    if (col.key === 'typeShort') return r.typeShort;
                    if (col.key === 'name') return r.name || '';
                    if (col.key === 'segId') return r._segId != null ? String(r._segId) : '';
                    if (col.key === 'subtype') return r.subtype || '';
                    if (col.key === 'equipment') return r.equipment || '';
                    if (col.key === 'state') return r.state || '';
                    if (col.key === 'gmGroup') return r.gmGroup || '';
                    if (col.key === 'altMin' || col.key === 'altMax' || col.key === 'altDelta'
                        || col.key === 'elevation' || col.key === 'agl'
                        || col.key === 'emergAlt' || col.key === 'segLen' || col.key === 'route') {
                        return num(r[col.dataKey]);
                    }
                    if (col.key === 'validated') {
                        if (r.validated === true) return 'yes';
                        if (r.validated === false) return 'no';
                        return ''; // N/A
                    }
                    if (col.key === 'unshielded') {
                        if (r.unshielded) return 'yes';
                        if (r.type === 16 || r.type === 3) return 'no';
                        return ''; // N/A
                    }
                    if (col.key === 'notes') return r.notesText || '';
                    if (col.key === 'lat') return r._lat != null ? r._lat.toFixed(6) : '';
                    if (col.key === 'long') return r._lng != null ? r._lng.toFixed(6) : '';
                    if (col.key === 'gps') return r._lat != null ? `https://www.google.com/maps?q=${r._lat},${r._lng}` : '';
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
                // FP segment rows share their parent entity — dedup by id
                // so the JSON output is one entry per real entity, not one
                // per row (otherwise an FP with 20 segments serializes 20×).
                const seen = new Set();
                const fullEntities = [];
                exportRows().forEach(r => {
                    if (!r.entity || seen.has(r.entity.id)) return;
                    seen.add(r.entity.id);
                    fullEntities.push(r.entity);
                });
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

    // Open an inline editor on a Min Alt / Max Alt / AGL cell of an FP
    // segment row. Replaces cell content with a text input pre-filled
    // with the current (or pending-derived) value. Accepts plain
    // numbers or formulas ("2720+50", "(2720+50)*2"). Enter/Tab/blur
    // commits to the pending queue; Escape cancels.
    //
    // AGL is a derived field — editing AGL queues a min_alt edit
    // computed as `elevation + targetAGL`. The user can approach the
    // altitude from either direction.
    function startInlineSegmentEdit(td, row, field) {
        if (!isEditableRow(row)) return;
        const isMin = field === 'min_alt';
        const isMax = field === 'max_alt';
        const isAgl = field === 'agl';
        // AGL editing requires loaded elevation — otherwise we can't
        // translate target AGL → Min Alt.
        if (isAgl && row.elevationM == null) {
            showToast('Elevation not loaded yet — can\'t edit AGL', 'rgba(255,82,82,0.6)');
            return;
        }
        // Pull current value depending on which field we're editing.
        // For Min/Max, use the source-of-truth altMinM/altMaxM (the
        // pending overlay is layered in via `existing` below). For AGL,
        // start from the EFFECTIVE AGL so a chain of Min then AGL edits
        // pre-fills the input with the most recently displayed value.
        let currentM;
        if (isMin) currentM = row.altMinM;
        else if (isMax) currentM = row.altMaxM;
        else if (isAgl) currentM = effectiveValues(row).effAgl;
        if (currentM == null) return;
        const useFt = !!sumPanelState.unitsFt;
        // Only Min/Max have direct pending entries — AGL pulls from the
        // derived state. existing is null for AGL edits.
        const existing = !isAgl ? getPendingEdit(row.entity.id, rowArcId(row), field) : null;
        const startValM = existing ? existing.newValueM : currentM;
        const startDisp = useFt ? Math.round(startValM * 3.28084) : Number(startValM.toFixed(1));

        const input = document.createElement('input');
        input.type = 'text';
        input.value = String(startDisp);
        input.title = 'Type a number or formula (e.g. 2720+50). Enter = queue · Esc = cancel.';
        input.style.cssText = 'width:70px;background:#1a1d23;border:1px solid #14d2dc;color:#fff;padding:2px 4px;border-radius:3px;font:inherit;font-size:11px;text-align:right;font-variant-numeric:tabular-nums';
        td.innerHTML = '';
        td.appendChild(input);
        input.focus();
        input.select();

        let cancelled = false;
        const commit = () => {
            if (cancelled) return;
            const parsed = parseFormulaValue(input.value);
            if (!isFinite(parsed)) {
                showToast('Invalid value or formula', 'rgba(255,82,82,0.6)');
                if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
                return;
            }
            const newDisp = useFt ? Math.round(parsed) : Number(parsed.toFixed(1));
            const newValueM = useFt ? newDisp / 3.28084 : newDisp;
            const unitTxt = useFt ? 'ft' : 'm';

            // AGL edit → translate to a Min Alt edit through queueMinForAgl.
            // We pass the new target AGL in meters; the helper handles the
            // elevation lookup, no-op detection, and rounding.
            if (isAgl) {
                const queued = queueMinForAgl(row, newValueM);
                if (queued) {
                    showToast(`Queued: ${row.name} AGL → ${newDisp.toLocaleString()} ${unitTxt}`, 'rgba(255,213,79,0.7)');
                } else {
                    showToast('AGL already at target — no change');
                }
                if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
                return;
            }

            // Min/Max path — queueAltEdit handles the no-op-clears-pending
            // case + rounding + meter quantization. Returns false if no
            // change was queued (already at target).
            const queued = queueAltEdit(row, field, newValueM);
            const lbl = isMin ? 'Min' : 'Max';
            if (queued) {
                showToast(`Queued: ${row.name} ${lbl} → ${newDisp.toLocaleString()} ${unitTxt}`, 'rgba(255,213,79,0.7)');
            } else if (existing) {
                showToast('Reverted to original value');
            }
            if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
        };
        input.onblur = commit;
        // Tab advances to the SAME column on the next editable row (Shift+Tab
        // = previous); Enter commits and finishes. Mirrors the Subtype/Name
        // editors so Min/Max/AGL get the same keyboard-driven row walk.
        const fieldColKey = isMin ? 'altMin' : (isMax ? 'altMax' : 'agl');
        input.onkeydown = (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const dir = e.shiftKey ? -1 : 1;
                // AGL needs a loaded elevation to be editable — skip rows
                // without one so the Tab chain doesn't dead-end on a toast.
                const next = findNextRowForCol(row._rowKey, dir, r =>
                    isEditableRow(r) && (!isAgl || r.elevationM != null));
                input.blur(); // commit + redraw
                if (next) {
                    requestAnimationFrame(() => {
                        const nextTd = findCellAfterRedraw(next._rowKey, fieldColKey);
                        if (nextTd) {
                            try { nextTd.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (err) {}
                            startInlineSegmentEdit(nextTd, next, field);
                        }
                    });
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelled = true;
                input.onblur = null;
                if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
            }
        };
    }

    // v3.41: open an inline editor on an asset's Subtype cell — either
    // the SUM table column or the right-click popup row. Replaces the
    // cell content with a text input pre-filled with the current (or
    // pending-derived) value, with a datalist of observed subtypes for
    // autocomplete. Enter/Tab/blur commits to the pending queue; Esc
    // cancels. Free-text values not in the list get isNewSubtype=true
    // and apply via the "Enter new type" + Add path in Percepto's editor.
    //
    // td: the cell element to swap in the input
    // entity: the asset entity (must be type === 3)
    // v3.52: Tab navigation in inline edits. Given the currently-edited
    // row's _rowKey, find the next/prev row in display order that has an
    // editable cell for this column. After a commit + table redraw,
    // openInlineForRow opens an inline editor on the resolved cell.
    //
    // Filter: subtype edits only walk to asset rows (type === 3). Name
    // edits walk to any non-segment entity row.
    function findNextRowForCol(currentRowKey, direction, filter) {
        const rows = window.__aim_ai_visibleRows || [];
        const idx = rows.findIndex(r => r._rowKey === currentRowKey);
        if (idx < 0) return null;
        for (let i = 1; i <= rows.length; i++) {
            const ci = idx + i * direction;
            if (ci < 0 || ci >= rows.length) return null; // don't wrap
            const cand = rows[ci];
            if (filter(cand)) return cand;
        }
        return null;
    }
    // Finds the cell in the rendered table for a given rowKey + colKey.
    // Called inside requestAnimationFrame after a commit-triggered redraw.
    function findCellAfterRedraw(rowKey, colKey) {
        return document.querySelector(`tr[data-row-key="${CSS.escape(rowKey)}"] td[data-col-key="${colKey}"]`);
    }

    // onCommit: optional callback fired AFTER successful queue (used
    //   for the popup path so it can close itself; the SUM table path
    //   redraws via window.__aim_ai_redrawTable).
    function startInlineSubtypeEdit(td, entity, onCommit) {
        if (!entity || entity.type !== 3) return;
        // v3.43: starting an edit implicitly means "I'm focused on this
        // asset" — pan the map to it so the user can see the entity
        // they're about to relabel without an extra click on the row.
        try { panToEntity(entity); } catch (e) {}
        const eff = effectiveSubtype(entity);
        const startVal = eff.value;

        // Build a unique datalist id so multiple cells don't collide.
        const dlId = `aim-subtype-dl-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const dl = document.createElement('datalist');
        dl.id = dlId;
        const siteID = getCurrentSiteID();
        observedSubtypesForSite(siteID).forEach(s => {
            const o = document.createElement('option');
            o.value = s;
            dl.appendChild(o);
        });

        const input = document.createElement('input');
        input.type = 'text';
        input.value = startVal || '';
        input.setAttribute('list', dlId);
        input.title = 'Pick from list OR type a new subtype. Enter = queue · Esc = cancel.';
        input.style.cssText = 'width:160px;background:#1a1d23;border:1px solid #14d2dc;color:#fff;padding:2px 4px;border-radius:3px;font:inherit;font-size:11px';
        // v3.42: critical — stop click/mousedown propagation. Without
        // this, clicking the input bubbles to the cell's onclick which
        // re-runs startInlineSubtypeEdit and wipes the input mid-edit
        // (looks like "dropdown opens then immediately closes").
        input.onmousedown = (e) => e.stopPropagation();
        input.onclick = (e) => e.stopPropagation();

        td.innerHTML = '';
        td.appendChild(input);
        td.appendChild(dl);
        input.focus();
        input.select();

        let cancelled = false;
        const startValTrimmed = (startVal || '').trim();
        const commit = () => {
            if (cancelled) return;
            const raw = input.value;
            const newVal = String(raw || '').trim();
            if (!newVal) {
                if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
                return;
            }
            // v3.57: same fix as name editor — no phantom queue when the
            // value matches what we opened with (handles already-pending
            // subtype edits cleanly).
            if (newVal === startValTrimmed) {
                if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
                return;
            }
            const queued = queueSubtypeEdit(entity, newVal);
            if (queued) {
                const observed = new Set(observedSubtypesForSite(siteID));
                const isNew = !observed.has(newVal);
                showToast(
                    `Queued: ${entity.name || 'asset'} subtype → ${newVal}${isNew ? ' (will be added as new type)' : ''}`,
                    'rgba(255,213,79,0.7)'
                );
            } else if (newVal === ((entity.custom && entity.custom.poi_type_str) || '')) {
                // No-op — either typed back to original, or never changed
                if (getPendingSubtype(entity.id) === undefined && eff.pending) {
                    // (eff.pending was true at start but cleared above by no-op)
                    showToast('Reverted to original subtype');
                }
            }
            if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
            if (typeof onCommit === 'function') {
                try { onCommit(queued); } catch (e) {}
            }
        };
        input.onblur = commit;
        input.onkeydown = (e) => {
            if (e.key === 'Tab') {
                // v3.52: Tab → next asset row's Subtype cell; Shift+Tab → prev.
                // Commits current edit + opens edit on the next cell so the
                // user never leaves the keyboard.
                e.preventDefault();
                const dir = e.shiftKey ? -1 : 1;
                const next = findNextRowForCol(String(entity.id), dir, r => r.type === 3 && !r._isSegment);
                input.blur(); // triggers commit + redraw
                if (next) {
                    requestAnimationFrame(() => {
                        const nextTd = findCellAfterRedraw(next._rowKey, 'subtype');
                        if (nextTd) {
                            try { nextTd.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (err) {}
                            startInlineSubtypeEdit(nextTd, next.entity);
                        }
                    });
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelled = true;
                input.onblur = null;
                if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
                if (typeof onCommit === 'function') {
                    try { onCommit(false); } catch (e2) {}
                }
            }
        };
    }

    // v3.50: inline editor for entity name. Plain text input (no datalist
    // — names are unique-by-intent, no autocomplete needed). Same click-
    // propagation guards as subtype edit. Auto-pans to entity on edit.
    function startInlineNameEdit(td, entity, onCommit) {
        if (!entity) return;
        try { panToEntity(entity); } catch (e) {}
        const eff = effectiveName(entity);
        const startVal = eff.value || '';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = startVal;
        input.title = 'Enter new name. Enter = queue · Esc = cancel.';
        input.style.cssText = 'width:220px;background:#1a1d23;border:1px solid #14d2dc;color:#fff;padding:2px 4px;border-radius:3px;font:inherit;font-size:12px';
        input.onmousedown = (e) => e.stopPropagation();
        input.onclick = (e) => e.stopPropagation();

        td.innerHTML = '';
        td.appendChild(input);
        input.focus();
        input.select();

        let cancelled = false;
        const startValTrimmed = (startVal || '').trim();
        const commit = () => {
            if (cancelled) return;
            const newVal = String(input.value || '').trim();
            if (!newVal) {
                if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
                return;
            }
            // v3.57: only queue if the value actually changed from what
            // the user opened the cell with. Without this, opening + closing
            // a cell that already had a pending rename re-queues a phantom
            // edit (effectiveName returns the pending newValue, queueNameEdit
            // compares against entity.name = original → mismatch → queue).
            if (newVal === startValTrimmed) {
                if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
                return;
            }
            const queued = queueNameEdit(entity, newVal);
            if (queued) {
                showToast(`Queued: rename "${entity.name}" → "${newVal}"`, 'rgba(255,213,79,0.7)');
            } else if (newVal === (entity.name || '')) {
                if (eff.pending) showToast('Reverted to original name');
            }
            if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
            if (typeof onCommit === 'function') {
                try { onCommit(queued); } catch (e) {}
            }
        };
        input.onblur = commit;
        input.onkeydown = (e) => {
            if (e.key === 'Tab') {
                // v3.52: Tab → next non-segment entity row's Name cell.
                e.preventDefault();
                const dir = e.shiftKey ? -1 : 1;
                const next = findNextRowForCol(String(entity.id), dir, r => !r._isSegment && r.entity);
                input.blur();
                if (next) {
                    requestAnimationFrame(() => {
                        const nextTd = findCellAfterRedraw(next._rowKey, 'name');
                        if (nextTd) {
                            try { nextTd.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (err) {}
                            startInlineNameEdit(nextTd, next.entity);
                        }
                    });
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelled = true;
                input.onblur = null;
                if (window.__aim_ai_redrawTable) window.__aim_ai_redrawTable();
            }
        };
    }

    // Fit the map to a single FP arc — uses both endpoints as the bounds
    // so the user sees the whole segment, not just its midpoint. Falls
    // back to a centered setView if Leaflet's fitBounds throws.
    function panToSegment(arc) {
        const map = getLeafletMap();
        if (!map || !arc || !arc.point_a || !arc.point_b) return;
        try {
            const bounds = [
                [arc.point_a.lat, arc.point_a.lng],
                [arc.point_b.lat, arc.point_b.lng],
            ];
            map.fitBounds(bounds, { padding: [60, 60], maxZoom: 20 });
        } catch (e) {
            const lat = (arc.point_a.lat + arc.point_b.lat) / 2;
            const lng = (arc.point_a.lng + arc.point_b.lng) / 2;
            try { map.setView([lat, lng], Math.max(19, map.getZoom())); }
            catch (e2) { console.warn(`${TAG} panToSegment failed:`, e2); }
        }
    }

    // ============================================================
    // SITE STATS POPUP — opened by the "Summary" button on the SUM
    // panel toolbar. Shows counts/breakdowns + a donut chart + a
    // "Copy as Text" export. Always reflects the full site dataset
    // (not the SUM panel's current filter) — it's meant as an
    // at-a-glance site report, not a filtered summary.
    // ============================================================
    const STATS_POPUP_ID = 'aim-stats-popup';
    // Persistent position + size for the stats popup. Mirrors the SUM
    // panel's pattern so users get the same draggable/resizable UX
    // throughout. null = use default (centered on first open).
    let statsPopupState = {
        x: null, y: null,
        w: 620, h: null,
    };

    function closeStatsPopup() {
        const el = document.getElementById(STATS_POPUP_ID);
        if (el) el.remove();
    }

    // Pretty-print integers with thousands separators. Decimals already
    // formatted to a fixed width are passed through (toLocaleString
    // would re-format them). Falls through for null / non-finite.
    function fmtNum(n) {
        if (n == null) return '';
        if (typeof n === 'string') return n; // already-formatted strings (e.g. "26.26")
        if (!isFinite(n)) return String(n);
        if (Number.isInteger(n)) return n.toLocaleString('en-US');
        return n.toLocaleString('en-US');
    }

    // Case-insensitive substring search across a row's name + subtype.
    // SWD appears in asset NAMES (e.g. "MILLIKEN C 3D SWD") not in
    // their poi_type_str subtype, so unifying name+subtype catches all
    // the keywords the user listed without per-keyword routing.
    function rowContains(r, keyword) {
        const k = keyword.toLowerCase();
        const n = (r.name || '').toLowerCase();
        const s = (r.subtype || '').toLowerCase();
        return n.includes(k) || s.includes(k);
    }
    function countContains(rows, keyword) {
        return rows.filter(r => rowContains(r, keyword)).length;
    }

    function computeSiteStats(siteID) {
        const bucket = mapObjectsBySite[siteID];
        if (!bucket) return null;
        const entities = bucket.entities || [];
        const allRows = buildSummaryRows(siteID); // reuses the same row shape as the SUM panel
        const byType = {
            15: allRows.filter(r => r.type === 15), // FPs
            16: allRows.filter(r => r.type === 16), // FFZs
            4:  allRows.filter(r => r.type === 4),  // NFZs
            3:  allRows.filter(r => r.type === 3),  // Assets
            19: allRows.filter(r => r.type === 19), // GMs
        };
        // Per-type validation counts so the popup can render separate
        // donuts for FPs / FFZs / NFZs. Only types with a meaningful
        // validated flag have a chart; Assets and GMs (validated=null)
        // are excluded entirely.
        const validationByType = {};
        [15, 16, 4].forEach(t => {
            const rows = byType[t] || [];
            const v = rows.filter(r => r.validated === true).length;
            const u = rows.filter(r => r.validated === false).length;
            validationByType[t] = { validated: v, unvalidated: u, total: v + u };
        });
        // Flight-path totals — segments + cumulative distance (meters).
        // Sum of arc.distance across every FP entity.
        let fpSegments = 0, fpDistanceM = 0;
        entities.forEach(e => {
            if (e.type !== 15) return;
            if (Array.isArray(e.arcs)) {
                fpSegments += e.arcs.length;
                e.arcs.forEach(a => { if (typeof a.distance === 'number') fpDistanceM += a.distance; });
            }
        });
        // ---- Auto-detected breakdowns from subtype ONLY ----
        // Subtypes use " - " (space-dash-space) as the equipment/state
        // separator: e.g. "battery - empty", "v-well - unreachable".
        // The equipment names themselves CONTAIN hyphens ("v-well",
        // "h-well") so splitting on a bare `-` broke them apart into
        // "v" + "well". Required: split only on " - " with surrounding
        // spaces.
        //
        // Names are NOT used for equipment auto-detect — earlier
        // versions had a name-tag pass that surfaced false positives
        // like "TEXAS", "PU", "ARICK" (asset name prefixes, not
        // equipment types). Per user feedback, subtype is the only
        // source of truth here.
        const SPLIT = ' - ';
        const equipMap = {};
        byType[3].forEach(r => {
            const sub = (r.subtype || '').trim();
            if (!sub) return;
            const head = sub.split(SPLIT)[0].trim();
            if (!head) return;
            const key = prettyKey(head);
            equipMap[key] = (equipMap[key] || 0) + 1;
        });
        const assetEquipment = sortAndCap(equipMap, 12);

        // States = parts AFTER " - " in subtype, plus an implicit
        // "Normal" bucket for assets that have NO modifier (the
        // baseline-good state — per Percepto's classification, no
        // modifier means the asset is healthy). Each asset counts
        // toward exactly one state so the percentages add to 100%
        // and the card gives a true distribution.
        // "battery - empty" → state = "Empty"
        // "v-well"          → state = "Normal"
        // Multi-modifier subtypes are rare in practice; if seen, we
        // bucket on the FIRST modifier to preserve the 100%-sum.
        const stateMap = {};
        byType[3].forEach(r => {
            const sub = (r.subtype || '').trim();
            if (!sub) return;
            const parts = sub.split(SPLIT).slice(1);
            if (parts.length === 0) {
                stateMap['Normal'] = (stateMap['Normal'] || 0) + 1;
                return;
            }
            const firstMod = (parts[0] || '').trim();
            if (!firstMod) {
                stateMap['Normal'] = (stateMap['Normal'] || 0) + 1;
                return;
            }
            const key = prettyKey(firstMod);
            stateMap[key] = (stateMap[key] || 0) + 1;
        });
        const assetStates = sortAndCap(stateMap, 10);

        // Auto-detect GM groups from names. Strategy:
        //   1. tokenize on whitespace / underscore / dash
        //   2. drop trailing tokens that contain digits ("1", "2-2", "14K")
        //   3. join the remaining tokens — that's the group name
        // Result: "Elevator 1", "Elevator 2" both → "Elevator".
        // "Tattu Range N5 - 14K" → "Tattu Range". Site-agnostic.
        const gmMap = {};
        byType[19].forEach(r => {
            const base = gmBaseName(r.name || '');
            if (!base) return;
            gmMap[base] = (gmMap[base] || 0) + 1;
        });
        const gmGroups = sortAndCap(gmMap, 12);

        // Equipment × State matrix — for each equipment kind, count
        // how many are in each state. "Normal" means no state suffix
        // on the subtype = the asset is in good operating condition
        // (per Percepto's convention: no modifier = baseline-good).
        // Splits use " - " (with spaces) so "v-well" stays intact.
        const equipStateMatrix = {};
        byType[3].forEach(r => {
            const sub = (r.subtype || '').trim();
            const head = prettyKey((sub.split(SPLIT)[0] || '').trim());
            if (!head) return;
            const states = sub.split(SPLIT).slice(1).map(s => prettyKey(s.trim())).filter(Boolean);
            const stateKey = states.length ? states.join(' + ') : 'Normal';
            if (!equipStateMatrix[head]) equipStateMatrix[head] = {};
            equipStateMatrix[head][stateKey] = (equipStateMatrix[head][stateKey] || 0) + 1;
        });
        // Other rolled-up stats — useful at a glance.
        const other = {
            'With notes': allRows.filter(r => r.hasNotes).length,
            'Unshielded (all types)': allRows.filter(r => r.unshielded).length,
        };
        return {
            siteID,
            totalEntities: allRows.length,
            byType,
            counts: {
                15: byType[15].length, 16: byType[16].length, 4: byType[4].length,
                3: byType[3].length, 19: byType[19].length,
            },
            validationByType,
            flightPaths: { entities: byType[15].length, segments: fpSegments, distanceM: fpDistanceM },
            assetStates, assetEquipment, equipStateMatrix,
            gmGroups, other,
        };
    }

    // Title-case-ish key normalizer: turn "h-well" → "H-Well",
    // "battery" → "Battery", "v-well" → "V-Well". Preserves embedded
    // hyphens (the "-Well" suffix) and uppercases ALL-CAPS tokens.
    function prettyKey(raw) {
        return raw.split(/\s+/).map(word =>
            word.split('-').map(part => {
                if (!part) return part;
                if (part.length <= 3 && part === part.toUpperCase()) return part; // SAT, SWD, NFZ
                return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            }).join('-')
        ).join(' ');
    }

    // Strip trailing numeric/short-alphanumeric tokens from a GM name
    // to find its "group base". Detail in computeSiteStats; called by
    // the gmMap aggregator.
    function gmBaseName(name) {
        if (!name) return '';
        const tokens = name.split(/[\s_\-]+/).filter(Boolean);
        while (tokens.length > 1 && /\d/.test(tokens[tokens.length - 1])) {
            tokens.pop();
        }
        const base = tokens.join(' ').trim();
        return base || name.trim();
    }

    function sortAndCap(dict, cap) {
        const entries = Object.entries(dict).sort((a, b) => b[1] - a[1]);
        const capped = cap ? entries.slice(0, cap) : entries;
        const out = {};
        capped.forEach(([k, v]) => { out[k] = v; });
        return out;
    }

    // Small SVG donut chart. Items: [{label, count, color}, ...].
    // Total is sum of counts. Empty (count=0) segments skipped so the
    // chart isn't polluted with zero-length arcs.
    function makeDonutChart(items, total, size) {
        const sz = size || 110;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${sz} ${sz}`);
        svg.setAttribute('width', sz);
        svg.setAttribute('height', sz);
        const cx = sz / 2, cy = sz / 2;
        const r = sz * 0.4;
        const sw = sz * 0.18;
        const C = 2 * Math.PI * r;
        // Background ring so even at total=0 the chart still draws.
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', r);
        bg.setAttribute('fill', 'none'); bg.setAttribute('stroke', '#2a2e36'); bg.setAttribute('stroke-width', sw);
        svg.appendChild(bg);
        if (total > 0) {
            let offsetFrac = 0;
            items.forEach(item => {
                if (!item.count) return;
                const frac = item.count / total;
                const seg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                seg.setAttribute('cx', cx); seg.setAttribute('cy', cy); seg.setAttribute('r', r);
                seg.setAttribute('fill', 'none');
                seg.setAttribute('stroke', item.color);
                seg.setAttribute('stroke-width', sw);
                seg.setAttribute('stroke-dasharray', `${C * frac} ${C * (1 - frac)}`);
                seg.setAttribute('stroke-dashoffset', `${-offsetFrac * C}`);
                seg.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
                svg.appendChild(seg);
                offsetFrac += frac;
            });
        }
        // Center text — total count.
        const totalText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        totalText.setAttribute('x', cx); totalText.setAttribute('y', cy - 3);
        totalText.setAttribute('text-anchor', 'middle');
        totalText.setAttribute('fill', '#e6e6e6');
        totalText.setAttribute('font-size', sz * 0.18);
        totalText.setAttribute('font-weight', '600');
        totalText.textContent = (typeof total === 'number') ? total.toLocaleString('en-US') : String(total);
        svg.appendChild(totalText);
        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', cx); lbl.setAttribute('y', cy + 10);
        lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('fill', '#888');
        lbl.setAttribute('font-size', sz * 0.10);
        lbl.textContent = 'TOTAL';
        svg.appendChild(lbl);
        return svg;
    }

    // Simple proportional bar for keyword breakdown rows. Returns a
    // span the renderer can append after the count.
    // makeProportionBar — small horizontal bar showing value/max.
    // `opts.fillCell: true` makes the bar fill its container 100%
    //   (use when placing inside a fixed-width table cell so all
    //   bars start at the same column position and end relative to
    //   each other's proportion of `max`).
    // No options = legacy flex-sized bar with a 160px cap (kept for
    //   any callers still using the old free-flow layout).
    function makeProportionBar(value, max, color, opts) {
        opts = opts || {};
        const wrap = document.createElement('span');
        if (opts.fillCell) {
            wrap.style.cssText = 'display:block;width:100%;height:6px;background:rgba(255,255,255,0.08);border-radius:3px';
        } else {
            wrap.style.cssText = 'flex:1 1 auto;min-width:0;max-width:160px;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;display:block';
        }
        const fill = document.createElement('span');
        const pct = max > 0 ? (value / max) * 100 : 0;
        fill.style.cssText = `display:block;width:${pct.toFixed(1)}%;height:100%;background:${color};border-radius:3px`;
        wrap.appendChild(fill);
        return wrap;
    }

    // Asset Health by Equipment — stacked horizontal bars per
    // equipment kind, segmented by status. Per user's classification:
    //   POSITIVE: no modifier = "Normal" (good baseline), HY (High
    //             Yield bonus). Both rendered with green-family colors.
    //   NEGATIVE: Empty, Inactive, Unshielded, Unreachable. Escalating
    //             warning palette from yellow → orange → red.
    // Segment order in each bar matches the legend order so positive
    // states are always on the left, negatives on the right increasing
    // in severity — at a glance you see "how much of this equipment
    // is healthy" by where the bar transitions from green to warning.
    function makeEquipStateMatrixCard(matrix, cardBuilder) {
        const c = cardBuilder('Asset Health by Equipment');
        // Semantic palette per state. Tweaked greens for the positive
        // bloc so they stand apart from the validation-card greens.
        const STATE_COLORS = {
            'Normal':      '#5fff5f',   // baseline good (no modifier)
            'HY':          '#00e5ff',   // High Yield bonus modifier
            'Empty':       '#ffd54f',   // mild concern
            'Inactive':    '#ff9800',   // moderate concern
            'Unshielded':  '#ff5722',   // drone-safety concern (orange-red)
            'Unreachable': '#a855f7',   // worst — purple for clear contrast vs Unshielded
        };
        const STATE_ORDER = ['Normal', 'HY', 'Empty', 'Inactive', 'Unshielded', 'Unreachable'];
        const stateColor = (s) => STATE_COLORS[s] || '#888888';
        const orderIndex = (s) => {
            const i = STATE_ORDER.indexOf(s);
            return i === -1 ? STATE_ORDER.length : i; // unknowns at end
        };
        // Compute totals per equipment + global max for proportional sizing.
        const equipTotals = Object.entries(matrix).map(([eq, states]) => {
            const total = Object.values(states).reduce((a, b) => a + b, 0);
            return { eq, states, total };
        }).sort((a, b) => b.total - a.total);
        const globalMax = Math.max(0, ...equipTotals.map(x => x.total));
        // Legend at top — known states first (in canonical order),
        // any unrecognized states appended alphabetically.
        const legend = document.createElement('div');
        legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:10px';
        const seenStates = new Set();
        equipTotals.forEach(({ states }) => Object.keys(states).forEach(s => seenStates.add(s)));
        const orderedLegendStates = Array.from(seenStates).sort((a, b) => {
            const da = orderIndex(a), db = orderIndex(b);
            if (da !== db) return da - db;
            return a.localeCompare(b);
        });
        orderedLegendStates.forEach(s => {
            const item = document.createElement('span');
            item.style.cssText = 'display:flex;align-items:center;gap:4px;color:#bbb';
            const sw = document.createElement('span');
            sw.style.cssText = `display:inline-block;width:9px;height:9px;background:${stateColor(s)};border-radius:2px`;
            item.appendChild(sw);
            item.appendChild(document.createTextNode(s));
            legend.appendChild(item);
        });
        c.appendChild(legend);
        // Table layout matches the kwCards: [Equipment] [#] [Stacked bar]
        // so labels + counts + bars all line up in the same columns
        // across cards. % column omitted — the stacked bar itself
        // visually shows the per-state split, so an extra % column
        // would be redundant.
        if (equipTotals.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:#888;font-size:12px;padding:8px 0;text-align:center';
            empty.textContent = 'No asset equipment data on this site.';
            c.appendChild(empty);
            return c;
        }
        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed';
        const cg = document.createElement('colgroup');
        cg.innerHTML = '<col><col style="width:50px"><col style="width:55%">';
        table.appendChild(cg);
        const HEADER_CSS = 'color:#888;font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:0.4px;padding:0 6px 5px;border-bottom:1px solid rgba(255,255,255,0.08)';
        const thead = document.createElement('thead');
        const thr = document.createElement('tr');
        [['Equipment', 'left'], ['#', 'right'], ['Health', 'left']].forEach(([txt, align]) => {
            const th = document.createElement('th');
            th.textContent = txt;
            th.style.cssText = `${HEADER_CSS};text-align:${align}`;
            thr.appendChild(th);
        });
        thead.appendChild(thr);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        equipTotals.forEach(({ eq, states, total }) => {
            const tr = document.createElement('tr');
            const tdName = document.createElement('td');
            tdName.style.cssText = 'padding:5px 6px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
            tdName.title = eq;
            tdName.textContent = eq;
            tr.appendChild(tdName);
            const tdCnt = document.createElement('td');
            tdCnt.style.cssText = 'padding:5px 6px;color:#e6e6e6;text-align:right;font-weight:600;font-variant-numeric:tabular-nums';
            tdCnt.textContent = fmtNum(total);
            tr.appendChild(tdCnt);
            const tdBar = document.createElement('td');
            tdBar.style.cssText = 'padding:5px 6px;vertical-align:middle';
            // Stacked bar fills the cell width; the proportion of the
            // cell that's painted (vs the gray track) is total/globalMax
            // so cross-row comparison of equipment sizes is still visible.
            const barTrack = document.createElement('span');
            barTrack.style.cssText = 'display:block;width:100%;height:10px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden';
            const barTotalPct = globalMax > 0 ? (total / globalMax) * 100 : 0;
            const stackInner = document.createElement('span');
            stackInner.style.cssText = `display:flex;width:${barTotalPct.toFixed(1)}%;height:100%;border-radius:3px;overflow:hidden`;
            const orderedStateEntries = Object.entries(states).sort((a, b) => orderIndex(a[0]) - orderIndex(b[0]));
            orderedStateEntries.forEach(([state, count]) => {
                if (!count) return;
                const seg = document.createElement('span');
                const segPct = total > 0 ? (count / total) * 100 : 0;
                seg.style.cssText = `display:inline-block;width:${segPct.toFixed(1)}%;height:100%;background:${stateColor(state)}`;
                seg.title = `${state}: ${fmtNum(count)} (${(count / total * 100).toFixed(1)}% of ${eq})`;
                stackInner.appendChild(seg);
            });
            barTrack.appendChild(stackInner);
            tdBar.appendChild(barTrack);
            tr.appendChild(tdBar);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        c.appendChild(table);
        return c;
    }

    function openStatsPopup(siteID) {
        closeStatsPopup();
        const stats = computeSiteStats(siteID);
        if (!stats) {
            showToast('No entity data loaded yet — refresh and try again', 'rgba(255,180,0,0.55)');
            return;
        }
        const popup = document.createElement('div');
        popup.id = STATS_POPUP_ID;
        // Explicit left/top driven by state — first open centers, then
        // user-dragged position persists across reopens.
        const startW = statsPopupState.w || 620;
        const startH = statsPopupState.h;
        const startX = statsPopupState.x != null ? statsPopupState.x : Math.max(0, (window.innerWidth - startW) / 2);
        const startY = statsPopupState.y != null ? statsPopupState.y : Math.max(0, (window.innerHeight - 600) / 2);
        popup.style.cssText = `
            position:fixed;left:${startX}px;top:${startY}px;z-index:100000;
            width:${startW}px;${startH ? `height:${startH}px;` : 'max-height:90vh;'}
            max-width:96vw;display:flex;flex-direction:column;
            background:#1f2228;border:1px solid rgba(20,210,220,0.55);border-radius:8px;
            box-shadow:0 10px 40px rgba(0,0,0,0.75);
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
            color:#e6e6e6;
        `;

        // Header — draggable. Two-line layout: site name on top (bigger),
        // ID + entity count subtitle below. Falls back to "Site <id>" if
        // the page header's site name isn't readable.
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(20,210,220,0.06);border-radius:8px 8px 0 0;cursor:move;user-select:none';
        const titleWrap = document.createElement('div');
        titleWrap.style.cssText = 'flex:1;min-width:0';
        const title = document.createElement('div');
        title.style.cssText = 'color:#7adfe6;font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        const siteName = getCurrentSiteName();
        title.textContent = siteName ? `Site Summary · ${siteName}` : `Site Summary · Site ${siteID}`;
        title.title = title.textContent;
        const subtitle = document.createElement('div');
        subtitle.style.cssText = 'color:#888;font-size:11px;font-weight:normal;margin-top:2px';
        subtitle.textContent = siteName ? `Site ${siteID} · ${stats.totalEntities} entities total` : `${stats.totalEntities} entities total`;
        titleWrap.appendChild(title);
        titleWrap.appendChild(subtitle);
        const xBtn = document.createElement('button');
        xBtn.textContent = '×';
        xBtn.style.cssText = 'background:transparent;border:none;color:#bbb;font-size:20px;cursor:pointer;padding:0 6px;line-height:1;flex:0 0 auto';
        xBtn.onclick = closeStatsPopup;
        head.appendChild(titleWrap);
        head.appendChild(xBtn);
        popup.appendChild(head);

        // Drag — same pattern as the SUM panel. Track on header
        // mousedown, follow mousemove, clamp to viewport. Final
        // position lands in statsPopupState so it survives reopen.
        let dragging = false, dragOffX = 0, dragOffY = 0;
        head.addEventListener('mousedown', (e) => {
            if (e.target === xBtn) return;
            dragging = true;
            const r = popup.getBoundingClientRect();
            dragOffX = e.clientX - r.left;
            dragOffY = e.clientY - r.top;
            e.preventDefault();
        });
        const onDragMove = (e) => {
            if (!dragging) return;
            let nx = e.clientX - dragOffX, ny = e.clientY - dragOffY;
            nx = Math.max(0, Math.min(window.innerWidth - 80, nx));
            ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
            popup.style.left = nx + 'px';
            popup.style.top = ny + 'px';
            statsPopupState.x = nx; statsPopupState.y = ny;
        };
        const onDragUp = () => { dragging = false; };
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragUp);

        // Scrollable body — CSS grid with auto-fit so cards re-flow
        // horizontally when the popup is widened, vertically when
        // narrowed. minmax(280px, 1fr) gives one column under ~280px
        // and packs additional columns when there's room (great for
        // wide-screenshot exports).
        const body = document.createElement('div');
        body.style.cssText = 'flex:1;overflow:auto;padding:12px 14px;min-height:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;align-content:start';
        popup.appendChild(body);

        // --- Card helper ---
        const card = (titleText) => {
            const c = document.createElement('div');
            c.style.cssText = 'border:1px solid rgba(255,255,255,0.10);border-radius:6px;padding:10px 12px;background:rgba(0,0,0,0.18)';
            const h = document.createElement('div');
            h.style.cssText = 'color:#7adfe6;font-size:10px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase;margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid rgba(20,210,220,0.20)';
            h.textContent = titleText;
            c.appendChild(h);
            return c;
        };
        const kvRow = (label, value, color) => {
            const r = document.createElement('div');
            r.style.cssText = 'display:flex;align-items:center;padding:3px 0;font-size:12px';
            const l = document.createElement('span');
            l.style.cssText = `flex:1;color:${color || '#bbb'}`;
            l.textContent = label;
            const v = document.createElement('span');
            v.style.cssText = 'color:#e6e6e6;font-variant-numeric:tabular-nums;font-weight:600;min-width:60px;text-align:right';
            // Comma-format integers; pass through pre-formatted strings.
            v.textContent = fmtNum(value);
            r.appendChild(l); r.appendChild(v);
            return r;
        };

        // --- TYPES card with donut + counts ---
        const cTypes = card('Entity Types');
        const typesGrid = document.createElement('div');
        typesGrid.style.cssText = 'display:flex;align-items:center;gap:16px';
        const donutItems = [
            { label: 'FPs',    count: stats.counts[15], color: typeReg(15).color },
            { label: 'FFZs',   count: stats.counts[16], color: typeReg(16).color },
            { label: 'NFZs',   count: stats.counts[4],  color: typeReg(4).color  },
            { label: 'Assets', count: stats.counts[3],  color: typeReg(3).color  },
            { label: 'GMs',    count: stats.counts[19], color: typeReg(19).color },
        ];
        typesGrid.appendChild(makeDonutChart(donutItems, stats.totalEntities, 110));
        const legend = document.createElement('div');
        legend.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:3px';
        donutItems.forEach(it => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px';
            const sw = document.createElement('span');
            sw.style.cssText = `width:10px;height:10px;background:${it.color};border-radius:2px;flex:0 0 auto`;
            const lbl = document.createElement('span');
            lbl.style.cssText = `flex:1;color:${it.color};font-weight:600`;
            lbl.textContent = it.label;
            const cnt = document.createElement('span');
            cnt.style.cssText = 'color:#e6e6e6;font-weight:600;font-variant-numeric:tabular-nums';
            cnt.textContent = fmtNum(it.count);
            const pct = document.createElement('span');
            pct.style.cssText = 'color:#888;font-size:10px;min-width:38px;text-align:right;font-variant-numeric:tabular-nums';
            pct.textContent = stats.totalEntities > 0 ? `${(it.count / stats.totalEntities * 100).toFixed(1)}%` : '—';
            row.appendChild(sw); row.appendChild(lbl); row.appendChild(cnt); row.appendChild(pct);
            legend.appendChild(row);
        });
        typesGrid.appendChild(legend);
        cTypes.appendChild(typesGrid);
        body.appendChild(cTypes);

        // --- VALIDATION card with separate donuts per type ---
        // One mini-donut per validatable type (FPs / FFZs / NFZs).
        // NFZs are only shown when the site actually has any — no
        // sense rendering an empty ring with no slices for sites
        // without NFZ data.
        const cVal = card('Validation');
        // Tooltip on the card title with the pilot-flown framing —
        // makes the validation semantics explicit for anyone who's
        // looking at the donuts and wondering what "Validated" means.
        try {
            const h = cVal.firstChild;
            if (h) h.title = 'Validated = pilot has flown this entity and confirmed it as safe. Unvalidated = area to fly with caution.';
        } catch (e) {}
        const valFlex = document.createElement('div');
        valFlex.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;justify-content:space-around';
        const validationCharts = [
            { type: 15, label: 'Flight Paths', color: typeReg(15).color },
            { type: 16, label: 'FFZs',         color: typeReg(16).color },
            { type: 4,  label: 'NFZs',         color: typeReg(4).color  },
        ];
        validationCharts.forEach(({ type, label, color }) => {
            const v = stats.validationByType[type];
            // Skip empty charts for types that don't exist on this
            // site (NFZs on most sites).
            if (!v || v.total === 0) return;
            const sub = document.createElement('div');
            sub.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;min-width:100px';
            const subTitle = document.createElement('div');
            subTitle.style.cssText = `color:${color};font-weight:600;font-size:11px;letter-spacing:0.4px`;
            subTitle.textContent = label;
            sub.appendChild(subTitle);
            const donutItems = [
                { label: 'Validated',   count: v.validated,   color: '#5fff5f' },
                { label: 'Unvalidated', count: v.unvalidated, color: '#ff5555' },
            ];
            sub.appendChild(makeDonutChart(donutItems, v.total, 90));
            const legend = document.createElement('div');
            legend.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:11px;width:100%';
            // ✓ row
            const okRow = document.createElement('div');
            okRow.style.cssText = 'display:flex;justify-content:space-between;color:#5fff5f';
            const okL = document.createElement('span'); okL.textContent = '✓ Validated';
            const okR = document.createElement('span'); okR.style.cssText = 'font-weight:600;font-variant-numeric:tabular-nums';
            okR.textContent = fmtNum(v.validated);
            okRow.appendChild(okL); okRow.appendChild(okR);
            legend.appendChild(okRow);
            // ✗ row
            const noRow = document.createElement('div');
            noRow.style.cssText = 'display:flex;justify-content:space-between;color:#ff5555';
            const noL = document.createElement('span'); noL.textContent = '✗ Unvalidated';
            const noR = document.createElement('span'); noR.style.cssText = 'font-weight:600;font-variant-numeric:tabular-nums';
            noR.textContent = fmtNum(v.unvalidated);
            noRow.appendChild(noL); noRow.appendChild(noR);
            legend.appendChild(noRow);
            sub.appendChild(legend);
            valFlex.appendChild(sub);
        });
        // If somehow nothing showed (no FPs/FFZs/NFZs on the site),
        // render a clear "nothing to validate" message instead of an
        // empty card body.
        if (valFlex.childElementCount === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:#888;font-size:12px;padding:8px 0;text-align:center';
            empty.textContent = 'No FPs, FFZs, or NFZs on this site.';
            cVal.appendChild(empty);
        } else {
            cVal.appendChild(valFlex);
        }
        body.appendChild(cVal);

        // --- FLIGHT PATHS card ---
        const cFP = card('Flight Paths');
        cFP.appendChild(kvRow('Flight path entities', stats.flightPaths.entities, typeReg(15).color));
        cFP.appendChild(kvRow('Total segments', stats.flightPaths.segments));
        const distM = stats.flightPaths.distanceM;
        const distFt = distM * 3.28084;
        const distMi = distM / 1609.34;
        const distKm = distM / 1000;
        // Pre-format integers + decimals before passing to kvRow (which
        // routes through fmtNum). Integers get commas; the mi/km combo
        // is pre-built so both numbers are visible in one cell.
        cFP.appendChild(kvRow('Total length (ft)', Math.round(distFt)));
        cFP.appendChild(kvRow('Total length (m)',  Math.round(distM)));
        cFP.appendChild(kvRow('Total length (mi / km)', `${distMi.toFixed(2)} / ${distKm.toFixed(2)}`));
        body.appendChild(cFP);

        // --- KEYWORD BREAKDOWN cards (with proportional bars) ---
        // kwCard renders a keyword breakdown as a 4-column table:
        //   [Type/Subtype] [%] [#] [Bar share]
        // The table layout lets numbers stack in straight columns and
        // every bar start at the same X position regardless of label
        // length. Header row labels the columns (per user request —
        // each tile is its own little table).
        //
        // denominator: what each row's count divides into for the %.
        //   Pass total assets / total GMs / etc. so percentages read
        //   as "X% of all assets" rather than "X% of this card's sum"
        //   (which would be misleading when items partially overlap).
        // labelHeader: customize the first column header (defaults to
        //   "Type" — but "Subtype" or "Group" reads better in context).
        const kwCard = (titleText, dict, color, denominator, labelHeader) => {
            const c = card(titleText);
            const maxVal = Math.max(0, ...Object.values(dict));
            const denom = denominator != null ? denominator : Object.values(dict).reduce((a, b) => a + b, 0);
            const table = document.createElement('table');
            // table-layout:fixed + colgroup so the % / # / Bar columns
            // have predictable widths even with mixed label lengths.
            table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed';
            const cg = document.createElement('colgroup');
            cg.innerHTML = '<col><col style="width:52px"><col style="width:46px"><col style="width:38%">';
            table.appendChild(cg);

            const HEADER_CSS = 'color:#888;font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:0.4px;padding:0 6px 5px;border-bottom:1px solid rgba(255,255,255,0.08)';
            const thead = document.createElement('thead');
            const thr = document.createElement('tr');
            const headers = [
                { txt: labelHeader || 'Type', align: 'left' },
                { txt: '%',  align: 'right' },
                { txt: '#',  align: 'right' },
                { txt: 'Share', align: 'left' },
            ];
            headers.forEach(h => {
                const th = document.createElement('th');
                th.textContent = h.txt;
                th.style.cssText = `${HEADER_CSS};text-align:${h.align}`;
                thr.appendChild(th);
            });
            thead.appendChild(thr);
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            Object.entries(dict).forEach(([k, v]) => {
                const tr = document.createElement('tr');
                const tdName = document.createElement('td');
                tdName.style.cssText = 'padding:4px 6px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
                tdName.title = k;
                tdName.textContent = k;
                tr.appendChild(tdName);

                const tdPct = document.createElement('td');
                tdPct.style.cssText = 'padding:4px 6px;color:#888;text-align:right;font-variant-numeric:tabular-nums;font-size:11px';
                tdPct.textContent = denom > 0 ? `${(v / denom * 100).toFixed(1)}%` : '—';
                tr.appendChild(tdPct);

                const tdCnt = document.createElement('td');
                tdCnt.style.cssText = 'padding:4px 6px;color:#e6e6e6;text-align:right;font-weight:600;font-variant-numeric:tabular-nums';
                tdCnt.textContent = fmtNum(v);
                tr.appendChild(tdCnt);

                const tdBar = document.createElement('td');
                tdBar.style.cssText = 'padding:4px 6px;vertical-align:middle';
                tdBar.appendChild(makeProportionBar(v, maxVal, color, { fillCell: true }));
                tr.appendChild(tdBar);

                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            c.appendChild(table);
            return c;
        };
        // Asset percentages are vs total assets so each row reads as
        // "X% of all assets on the site" — natural denominator for
        // both equipment and state cards.
        const totalAssets = stats.counts[3];
        const totalGMs = stats.counts[19];
        body.appendChild(kwCard('Asset · Equipment (auto)', stats.assetEquipment, typeReg(3).color, totalAssets, 'Subtype'));
        body.appendChild(kwCard('Asset · States (auto)', stats.assetStates, '#ffb74d', totalAssets, 'State'));
        // Equipment Health matrix — stacked horizontal bars per
        // equipment kind, segmented by status. See makeEquipStateMatrixCard.
        body.appendChild(makeEquipStateMatrixCard(stats.equipStateMatrix, card));
        body.appendChild(kwCard('General Markers · Groups (auto)', stats.gmGroups, typeReg(19).color, totalGMs, 'Group'));

        // --- OTHER card ---
        const cOther = card('Other');
        Object.entries(stats.other).forEach(([k, v]) => cOther.appendChild(kvRow(k, v)));
        body.appendChild(cOther);

        // Footer with Copy + Close
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;gap:6px;padding:8px 12px;border-top:1px solid rgba(255,255,255,0.08);background:rgba(0,0,0,0.15);border-radius:0 0 8px 8px';
        const spacer = document.createElement('div');
        spacer.style.cssText = 'flex:1';
        footer.appendChild(spacer);
        const sheetBtn = document.createElement('button');
        sheetBtn.innerHTML = '📊 Copy → Sheets';
        sheetBtn.title = 'Copy as formatted HTML table — paste directly into Google Sheets / Excel with colors + bolding';
        sheetBtn.style.cssText = 'background:rgba(20,210,220,0.18);color:#7adfe6;border:1px solid rgba(20,210,220,0.45);border-radius:3px;padding:5px 12px;cursor:pointer;font:inherit;font-size:11px';
        sheetBtn.onclick = () => copyStatsAsSheet(stats, getCurrentSiteName());
        const copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 Copy as Text';
        copyBtn.title = 'Copy as plain text — ASCII headers, padded numbers, paste into Slack / email';
        copyBtn.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:5px 12px;cursor:pointer;font:inherit;font-size:11px';
        copyBtn.onclick = () => copyToClipboard(formatStatsAsText(stats), 'Copied site summary as plain text');
        const closeBtn2 = document.createElement('button');
        closeBtn2.textContent = 'Close';
        closeBtn2.style.cssText = 'background:transparent;color:#bbb;border:1px solid rgba(255,255,255,0.20);border-radius:3px;padding:5px 12px;cursor:pointer;font:inherit;font-size:11px';
        closeBtn2.onclick = closeStatsPopup;
        footer.appendChild(sheetBtn);
        footer.appendChild(copyBtn);
        footer.appendChild(closeBtn2);
        popup.appendChild(footer);

        // Resize handle — bottom-right corner. Min 400x300, max 96vw x 90vh.
        const resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = 'position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 40%,rgba(20,210,220,0.55) 40%,rgba(20,210,220,0.55) 50%,transparent 50%,transparent 65%,rgba(20,210,220,0.45) 65%,rgba(20,210,220,0.45) 75%,transparent 75%);border-bottom-right-radius:8px';
        let resizing = false, rStartX = 0, rStartY = 0, rStartW = 0, rStartH = 0;
        resizeHandle.addEventListener('mousedown', (e) => {
            resizing = true;
            const r = popup.getBoundingClientRect();
            rStartX = e.clientX; rStartY = e.clientY;
            rStartW = r.width; rStartH = r.height;
            e.preventDefault();
            e.stopPropagation();
        });
        const onResizeMove = (e) => {
            if (!resizing) return;
            const nw = Math.max(400, Math.min(window.innerWidth * 0.96, rStartW + (e.clientX - rStartX)));
            const nh = Math.max(300, Math.min(window.innerHeight * 0.90, rStartH + (e.clientY - rStartY)));
            popup.style.width = nw + 'px';
            popup.style.height = nh + 'px';
            popup.style.maxHeight = 'none';
            statsPopupState.w = nw;
            statsPopupState.h = nh;
        };
        const onResizeUp = () => { resizing = false; };
        document.addEventListener('mousemove', onResizeMove);
        document.addEventListener('mouseup', onResizeUp);
        popup.appendChild(resizeHandle);

        // Cleanup — drop all document-level listeners when popup closes
        // so we don't leak. Wrap the native remove() rather than relying
        // on every close path remembering to do it manually.
        const origRemove = popup.remove.bind(popup);
        popup.remove = () => {
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragUp);
            document.removeEventListener('mousemove', onResizeMove);
            document.removeEventListener('mouseup', onResizeUp);
            origRemove();
        };

        document.body.appendChild(popup);
    }

    // Pretty plain-text export — drops into any chat / email / spreadsheet
    // cell preserving the section layout. Numbers right-aligned in a
    // monospace-friendly way so the user can paste straight into a
    // ```code``` block on Slack.
    function formatStatsAsText(stats) {
        // Numbers get thousands separators in the text export too —
        // matches what the popup shows so copy-paste reads identically.
        const f = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
        const pad = (label, val, w) => `  ${label.padEnd(w || 22)} ${f(val).padStart(8)}`;
        const lines = [];
        lines.push(`SITE SUMMARY · Site ${stats.siteID}`);
        lines.push('='.repeat(40));
        lines.push('');
        lines.push('ENTITY TYPES');
        lines.push(pad('FPs',    stats.counts[15]));
        lines.push(pad('FFZs',   stats.counts[16]));
        lines.push(pad('NFZs',   stats.counts[4]));
        lines.push(pad('Assets', stats.counts[3]));
        lines.push(pad('GMs',    stats.counts[19]));
        lines.push(pad('TOTAL',  stats.totalEntities));
        lines.push('');
        lines.push('VALIDATION');
        const valDefs = [
            { type: 15, label: 'Flight Paths' },
            { type: 16, label: 'FFZs' },
            { type: 4,  label: 'NFZs' },
        ];
        valDefs.forEach(({ type, label }) => {
            const v = stats.validationByType[type];
            if (!v || v.total === 0) return;
            lines.push(`  ${label}:`);
            lines.push(pad('    Validated',   v.validated));
            lines.push(pad('    Unvalidated', v.unvalidated));
        });
        lines.push('');
        lines.push('FLIGHT PATHS');
        lines.push(pad('Entities', stats.flightPaths.entities));
        lines.push(pad('Total segments', stats.flightPaths.segments));
        const distFt = stats.flightPaths.distanceM * 3.28084;
        const distMi = stats.flightPaths.distanceM / 1609.34;
        lines.push(pad('Total length (ft)', Math.round(distFt)));
        lines.push(pad('Total length (m)',  Math.round(stats.flightPaths.distanceM)));
        lines.push(pad('Total length (mi)', distMi.toFixed(2)));
        lines.push('');
        lines.push('ASSET · EQUIPMENT (auto-detected)');
        Object.entries(stats.assetEquipment).forEach(([k, v]) => lines.push(pad(k, v)));
        lines.push('');
        lines.push('ASSET · STATES (auto-detected)');
        Object.entries(stats.assetStates).forEach(([k, v]) => lines.push(pad(k, v)));
        lines.push('');
        lines.push('EQUIPMENT × STATE MATRIX');
        Object.entries(stats.equipStateMatrix).forEach(([eq, states]) => {
            lines.push(`  ${eq}:`);
            Object.entries(states).forEach(([s, n]) => lines.push(pad(`    ${s}`, n)));
        });
        lines.push('');
        lines.push('GENERAL MARKERS · GROUPS (auto-detected)');
        Object.entries(stats.gmGroups).forEach(([k, v]) => lines.push(pad(k, v)));
        lines.push('');
        lines.push('OTHER');
        Object.entries(stats.other).forEach(([k, v]) => lines.push(pad(k, v)));
        return lines.join('\n');
    }

    // ============================================================
    // Google Sheets / Excel export — copies rich HTML to the
    // clipboard as text/html alongside a plain-text fallback. When
    // pasted into Google Sheets or Excel, the spreadsheet engine
    // parses the HTML table and lays out properly formatted cells
    // (headers bolded, color-coded section bands, right-aligned
    // numbers). Charts don't carry over from HTML — the user can
    // insert a chart from the pasted data in two clicks.
    // ============================================================
    function buildStatsHtmlForSheets(stats, siteName) {
        const tdNum = 'style="text-align:right;font-variant-numeric:tabular-nums"';
        const tdLbl = 'style="text-align:left"';
        const sectionTr = (title, color) =>
            `<tr><td colspan="3" style="background:${color || '#1f2228'};color:#7adfe6;font-weight:bold;padding:6px 8px;letter-spacing:0.5px">${title}</td></tr>`;
        const dataTr = (label, value, extra) =>
            `<tr><td ${tdLbl}>${label}</td><td ${tdNum}>${fmtNum(value)}</td><td ${tdNum}>${extra || ''}</td></tr>`;
        const cellsToString = (cells) => cells.map(c => `<td ${tdLbl}>${c}</td>`).join('');

        const hdr = siteName ? `Site Summary — ${siteName} (Site ${stats.siteID})` : `Site Summary — Site ${stats.siteID}`;
        const out = [];
        out.push('<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:11pt">');
        out.push(`<tr><td colspan="3" style="background:#1f2228;color:#7adfe6;font-weight:bold;font-size:13pt;padding:8px">${hdr}</td></tr>`);
        out.push(`<tr><td colspan="3" style="color:#666;padding:4px 8px">${fmtNum(stats.totalEntities)} entities total</td></tr>`);

        // Type breakdown
        out.push(sectionTr('ENTITY TYPES'));
        const typeRows = [
            ['FPs',    stats.counts[15], '#1ca0de'],
            ['FFZs',   stats.counts[16], '#5fff5f'],
            ['NFZs',   stats.counts[4],  '#ff5555'],
            ['Assets', stats.counts[3],  '#ffffff'],
            ['GMs',    stats.counts[19], '#c084fc'],
        ];
        typeRows.forEach(([label, n, color]) => {
            const pct = stats.totalEntities > 0 ? `${(n / stats.totalEntities * 100).toFixed(1)}%` : '';
            out.push(`<tr><td ${tdLbl} style="border-left:3px solid ${color};padding-left:8px">${label}</td><td ${tdNum}>${fmtNum(n)}</td><td ${tdNum} style="color:#888">${pct}</td></tr>`);
        });
        out.push(`<tr><td ${tdLbl} style="font-weight:bold">TOTAL</td><td ${tdNum} style="font-weight:bold">${fmtNum(stats.totalEntities)}</td><td></td></tr>`);

        // Validation per type
        out.push(sectionTr('VALIDATION'));
        out.push(`<tr><th ${tdLbl}>Type</th><th ${tdNum}>Validated</th><th ${tdNum}>Unvalidated</th></tr>`);
        [[15, 'Flight Paths'], [16, 'FFZs'], [4, 'NFZs']].forEach(([t, label]) => {
            const v = stats.validationByType[t];
            if (!v || v.total === 0) return;
            out.push(`<tr><td ${tdLbl}>${label}</td><td ${tdNum} style="color:#0a0">${fmtNum(v.validated)}</td><td ${tdNum} style="color:#a00">${fmtNum(v.unvalidated)}</td></tr>`);
        });

        // Flight path totals
        out.push(sectionTr('FLIGHT PATHS'));
        out.push(dataTr('Entities', stats.flightPaths.entities));
        out.push(dataTr('Total segments', stats.flightPaths.segments));
        out.push(dataTr('Total length (ft)', Math.round(stats.flightPaths.distanceM * 3.28084)));
        out.push(dataTr('Total length (m)',  Math.round(stats.flightPaths.distanceM)));
        out.push(dataTr('Total length (mi)', (stats.flightPaths.distanceM / 1609.34).toFixed(2)));

        // Asset equipment / states / matrix
        out.push(sectionTr('ASSET — EQUIPMENT'));
        Object.entries(stats.assetEquipment).forEach(([k, v]) => out.push(dataTr(k, v)));
        out.push(sectionTr('ASSET — STATES'));
        Object.entries(stats.assetStates).forEach(([k, v]) => out.push(dataTr(k, v)));

        // Equipment × State matrix as its own sub-table for clarity
        out.push(sectionTr('EQUIPMENT × STATE MATRIX'));
        const states = new Set();
        Object.values(stats.equipStateMatrix).forEach(obj => Object.keys(obj).forEach(s => states.add(s)));
        const stateList = Array.from(states).sort();
        out.push(`<tr><th ${tdLbl}>Equipment</th>${stateList.map(s => `<th ${tdNum}>${s}</th>`).join('')}<th ${tdNum} style="font-weight:bold">TOTAL</th></tr>`);
        Object.entries(stats.equipStateMatrix).forEach(([eq, smap]) => {
            const total = Object.values(smap).reduce((a, b) => a + b, 0);
            const cells = stateList.map(s => `<td ${tdNum}>${smap[s] ? fmtNum(smap[s]) : ''}</td>`).join('');
            out.push(`<tr><td ${tdLbl}>${eq}</td>${cells}<td ${tdNum} style="font-weight:bold">${fmtNum(total)}</td></tr>`);
        });

        // GM groups
        out.push(sectionTr('GENERAL MARKERS — GROUPS'));
        Object.entries(stats.gmGroups).forEach(([k, v]) => out.push(dataTr(k, v)));

        // Other
        out.push(sectionTr('OTHER'));
        Object.entries(stats.other).forEach(([k, v]) => out.push(dataTr(k, v)));

        out.push('</table>');
        return out.join('');
    }

    // Multi-MIME clipboard write — Sheets and Excel pick up text/html,
    // plain-text editors fall back to the .toLocaleString() text. We
    // wrap both in a single ClipboardItem so the OS clipboard carries
    // both flavors and the destination app picks the best one.
    async function copyStatsAsSheet(stats, siteName) {
        const html = buildStatsHtmlForSheets(stats, siteName);
        const text = formatStatsAsText(stats);
        try {
            if (navigator.clipboard && window.ClipboardItem) {
                const item = new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([text], { type: 'text/plain' }),
                });
                await navigator.clipboard.write([item]);
                showToast('Copied as formatted table — paste into Google Sheets / Excel');
                return;
            }
        } catch (e) {
            console.warn(`${TAG} ClipboardItem write failed, falling back:`, e);
        }
        // Fallback: write HTML via execCommand on a contenteditable div
        // — works in older browsers / when Clipboard API is restricted.
        try {
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            tmp.style.cssText = 'position:fixed;top:-9999px;opacity:0';
            document.body.appendChild(tmp);
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(tmp);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('copy');
            sel.removeAllRanges();
            document.body.removeChild(tmp);
            showToast('Copied as formatted table — paste into Google Sheets / Excel');
        } catch (e) {
            console.error(`${TAG} Sheets fallback also failed:`, e);
            copyToClipboard(text, 'Copied as plain text (HTML copy unavailable)');
        }
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

    console.log(`${TAG} v${SCRIPT_VERSION} ready`);
})();
