// ==UserScript==
// @name         Latest - AIM Mission Logs
// @namespace    http://tampermonkey.net/
// @version      0.96
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Mission_Logs.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Mission_Logs.user.js
// @description  v0.96: no floating 🔎 Logs button on a site's Mission Log (it covered Percepto's own buttons; every row has 🔎 AIM). v0.95: incident review gets a “Where it happened” map — the flown track around the event, the numbered moments, and the site's flight paths, FFZs and NFZs from the archive. v0.94: 🚨 Possible incident card (shows when the flight did not end normally) + Run incident review — reads the flight controller's own log for the first abnormal moment (outside-force stop, jolts, loss of control, motor stall, hard impact, parachute command). ⬇ Logs — save the app-log archive. v0.93: also on a site's Mission Log (🔎 AIM on every row) and on Mission Playback (🔎 Logs, mission prefilled). v0.92: ⬇ Report — saves the analysis on screen as one self-contained HTML file (charts included as pictures; opens anywhere, no login). v0.91: deep link — /dashboard/?aim-ml=<mission id> opens the panel and analyzes that mission (used by the Fleet Tools ⚙ ESC Sweep rows). v0.9: ⚙ Motors / ESC card — reads the ESC telemetry log + the main drone log and says whether the drone's critical_current_rpm_ratio alert was a false positive (motor-controller readings arriving under 3 per second) or real; interactive per-ESC charts (drag to zoom all, double-click to reset, hover for values, switch the top chart between ratio / rpm / current / throttle / voltage / temperatures), editable thresholds, stretch table, per-ESC stats, Sheets copy. v0.8: Signal KML points, pins and track sit at the drone's flown altitude (absolute MSL, extruded to the ground) instead of clamped to the ground. v0.7: names the CARRIER from the LTE bands the modem camped on (B13 = Verizon-only spectrum, B14/B17/B29/B30 = AT&T, B71/B41/B25/B26 = T-Mobile; shared bands prove nothing); every outage, handover and the worst-signal sample now carries the drone's position at that moment (click 📍 to copy lat,lng — paste into Map Nav 🧭); 📍 Signal KML button exports the flown track with each signal sample colored Good/Fair/Weak/Edge plus outage and handover pins (open in Google Earth or Fleet Tools → KML Layers) to see WHERE the link was bad. v0.6: outage detection now also uses 100%-loss ping runs, IP-lease loss (udhcpc deconfigured→bound) and LTE-manager restarts — a reconnect the TCP checks never saw (238589) was reported as 'dropped 0 times' in red; outages are tagged before takeoff / in flight / after landing and the Simple card downgrades a drop that happened on the base to amber. v0.5: Simple / Advanced view toggle (remembered) — Simple is plain English for pilots and customers: one bold bottom line per card + bullets (signal as bars, response time, packet loss, blips, tower hopping, what to do) with the full technical card under 'Technical details ▸'. v0.4: reads the older EM7565 modem's status fields (RSRP_(dBm) / PCC_RxM_RSSI / Tx_Power) — v0.3 saw no RSRP and flagged a false 33-min outage; a sample is lost only with no band / stuck handover / no cell+no RSRP; isolated 10 s TCP blips = amber POOR link (loss %, avg/worst rtt) not red; unknown formats raise a ⚠ with lte.rawSample; mission duration is ms. v0.3: LTE card gains an Outages line (each loss window with start → recovery and duration, from no-cell / stuck-handover samples and failing TCP checks) and a Coverage line (median RSRP, % weak / very weak / no cell); dropped verdict names the outages. v0.2: row 🔎 anchors on the dashboard's own Get App Logs control (not table structure); prefill from the FILTER box or the single visible row only; server reply shown when a mission has no archive. Pull a mission's log archives straight from the Mission Dashboard (no download → unzip → hunt) and extract what matters: LTE link health (modem registration, TCP/ping checks, signal, cell handovers, RTK-stream gaps), mission event timeline (stages, aborts, go-to-base), DAA aircraft with closest approach to the drone, warnings/errors by process. v0.1 (#286): POC on percepto.app/dashboard — 🔎 per mission row + floating launcher; engine (fetch → gunzip → untar → extractors) is self-contained for the later Fleet Tools site/date sweep.
// @author       Payden
// @match        *://percepto.app/*
// @match        *://qa.percepto.app/*
// @connect      d2lb831xgi5b1q.cloudfront.net
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

// AIM Mission Logs — reads a mission's app-log + DAA archives in memory and
// turns them into answers ("did LTE drop?", "why did it abort?", "what was
// the aircraft?", "was the ESC alert a false positive?") without the
// download → unzip → grep loop.
// Pages: the Mission Dashboard (/dashboard/#/, All Missions table); since v0.93 also a site's
//   Mission Log (/#/site/<sid>/mission-log — 🔎 AIM on every row) and Mission Playback
//   (/#/site/<sid>/control-panel/past-mission/<mid> — 🔎 Logs with the mission prefilled).
//   Runs in the TOP window only; the Mission Log table lives in the same-origin react-pages
//   iframe and is reached through iframe.contentDocument.
// Endpoints (probed 2026-10-05, see memory reference_mission_log_endpoints):
//   GET /missions/<id>/logs/new_app_log/  → {download_link: CloudFront signed .tar.gz}
//   GET /missions/<id>/logs/daa_file/     → {download_link: CloudFront signed .tar.gz}
//   GET /missions/<id>/                    → mission record
// CloudFront is cross-origin → GM_xmlhttpRequest (arraybuffer) + @connect.
// The [AIM_ML_ENGINE] block below has NO DOM / page assumptions — copy it
// verbatim into Fleet Tools for the bulk (sites × dates) sweep.
// No hotkeys. Log tag: [AIM MLOGS]

(function () {
    'use strict';

    const TAG = '[AIM MLOGS]';
    if (window !== window.top) return;

    const SCRIPT_ID = 'aim-mission-logs';
    const SCRIPT_VERSION = '0.96';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
    // v0.93 — where are we? 'dash' = Mission Dashboard · 'log' = a site's Mission Log · 'playback' = Mission Playback · null = any other page (stay out of the way)
    const ON_DASH = /^\/dashboard/.test(location.pathname);
    const SITE_LOG_RX = /#\/site\/\d+\/mission-log/;
    const SITE_PB_RX = /#\/site\/\d+\/control-panel\/past-mission\/(\d+)/;
    const routeKind = () => { const h = location.hash || ''; return ON_DASH ? 'dash' : SITE_LOG_RX.test(h) ? 'log' : SITE_PB_RX.test(h) ? 'playback' : null; };
    let masterEnabled = true;
    const IS_QA = location.hostname === 'qa.percepto.app' || location.hostname.endsWith('.qa.percepto.app');

    console.log(`${TAG} init v${SCRIPT_VERSION} on ${location.href}`);

    // ==================================================================
    // [AIM_ML_ENGINE] — fetch → gunzip → untar → extract. Pure functions,
    // no DOM. Keep this block identical wherever it is copied.
    // ==================================================================
    const ML_RTCM_GAP_S = 8;          // normal RTCM cadence has gaps up to ~7 s; longer = stall
    const ML_PING_LOSS_WARN = 1;      // any packet loss in a 4-packet ping = degraded
    const ML_NOISE_RE = /Unexpected key in configuration json|No WPSIE|wl_cfg80211|reverse_shell|Full Sattelite|Failures on past mission|LD_PRELOAD|serial-getty|ttyGS0|nv_update_engine|Reverse Shell/i;

    function mlFetchWithTimeout(url, init, ms) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), ms || 30000);
        return fetch(url, Object.assign({}, init, { signal: ctl.signal })).finally(() => clearTimeout(t));
    }

    async function mlGetJson(path, ms) {
        const resp = await mlFetchWithTimeout(path, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } }, ms || 30000);
        if (resp.status === 401 || resp.status === 403) throw new Error(`not permitted (${resp.status}) for ${path}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${path}`);
        const text = await resp.text();
        if (!/json/i.test(resp.headers.get('content-type') || '')) {
            if (/<form|login|sign\s*in|password/i.test(text)) throw new Error('login page returned — session expired?');
            throw new Error(`non-JSON response for ${path}`);
        }
        return JSON.parse(text);
    }

    // Cross-origin binary GET (CloudFront signed URL). onProgress(loadedBytes, totalBytes|null).
    function mlFetchBinary(url, onProgress) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest unavailable (check @grant)')); return; }
            GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'arraybuffer', timeout: 180000,
                onprogress: (p) => { try { if (onProgress) onProgress(p.loaded, p.lengthComputable ? p.total : null); } catch (e) { /* ui only */ } },
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300 && r.response) resolve(new Uint8Array(r.response));
                    else reject(new Error(`archive HTTP ${r.status}`));
                },
                onerror: (e) => reject(new Error('archive fetch failed: ' + (e && e.error ? e.error : 'network'))),
                ontimeout: () => reject(new Error('archive fetch timed out')),
            });
        });
    }

    async function mlGunzip(u8) {
        if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return u8;     // not gzip → assume plain tar
        const ds = new DecompressionStream('gzip');
        const w = ds.writable.getWriter();
        w.write(u8); w.close();
        const ab = await new Response(ds.readable).arrayBuffer();
        return new Uint8Array(ab);
    }

    // Minimal tar reader (ustar + GNU longname). Returns [{name, base, bytes}].
    function mlUntar(u8) {
        const td = new TextDecoder('utf-8');
        const out = [];
        let off = 0, pendingLong = null;
        const str = (a, b) => { const s = td.decode(u8.subarray(a, b)); const z = s.indexOf('\0'); return (z >= 0 ? s.slice(0, z) : s).trim(); };
        while (off + 512 <= u8.length) {
            const hdr = u8.subarray(off, off + 512);
            if (hdr.every(b => b === 0)) break;
            let name = str(off, off + 100);
            const sizeStr = str(off + 124, off + 136);
            const size = parseInt(sizeStr, 8) || 0;
            const type = String.fromCharCode(u8[off + 156] || 48);
            const magic = str(off + 257, off + 262);
            if (magic === 'ustar') { const prefix = str(off + 345, off + 500); if (prefix) name = prefix + '/' + name; }
            const dataStart = off + 512, dataEnd = dataStart + size;
            if (type === 'L') { pendingLong = str(dataStart, dataEnd); }
            else if (type === '0' || type === '\0' || type === '7') {
                if (pendingLong) { name = pendingLong; pendingLong = null; }
                const base = name.split('/').pop();
                out.push({ name, base, bytes: u8.subarray(dataStart, dataEnd) });
            } else { pendingLong = null; }     // dirs, pax headers, links: skip
            off = dataStart + Math.ceil(size / 512) * 512;
        }
        return out;
    }

    const mlText = (bytes) => new TextDecoder('utf-8').decode(bytes);
    const mlHav = (la1, lo1, la2, lo2) => {
        const R = 6371000, p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180, dp = p2 - p1, dl = (lo2 - lo1) * Math.PI / 180;
        const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    };
    const mlFt = (m) => Math.round(m * 3.28084);
    const mlPad = (n) => String(n).padStart(2, '0');
    const mlHms = (date) => date ? `${mlPad(date.getUTCHours())}:${mlPad(date.getUTCMinutes())}:${mlPad(date.getUTCSeconds())}` : '—';

    // US ICAO hex → N-number (FAA allocation algorithm). null outside the US block.
    function mlIcaoToN(hex) {
        let icao = parseInt(hex, 16);
        if (!(icao >= 0xA00001 && icao <= 0xADF7C7)) return null;
        icao -= 0xA00001;
        const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        const suffix = (rem) => { if (rem === 0) return ''; rem -= 1; const a = Math.floor(rem / 25), b = rem % 25; return L[a] + (b > 0 ? L[b - 1] : ''); };
        let n = 'N';
        n += String(Math.floor(icao / 101711) + 1); icao %= 101711;
        if (icao < 601) return n + suffix(icao); icao -= 601;
        n += String(Math.floor(icao / 10111)); icao %= 10111;
        if (icao < 601) return n + suffix(icao); icao -= 601;
        n += String(Math.floor(icao / 951)); icao %= 951;
        if (icao < 601) return n + suffix(icao); icao -= 601;
        n += String(Math.floor(icao / 35)); icao %= 35;
        if (icao === 0) return n; icao -= 1;
        return icao < 24 ? n + L[icao] : n + String(icao - 24);
    }

    // Classify archive members by role.
    function mlClassify(files) {
        const roles = {};
        const pick = (role, re) => { const f = files.find(x => re.test(x.base)); if (f) roles[role] = f; };
        pick('syslog', /^syslog_\d+\.log$/i);
        pick('events', /_eventsReport\.log$/i);
        pick('meta', /^\d+\.json$/);
        pick('collision', /_collision\.log$/i);
        pick('landing', /_landing\.log$/i);
        pick('takeoff', /_takeoff\.log$/i);
        pick('daaDrone', /__daa\.log$/i);
        pick('perfmon', /_perfmon\.log$/i);
        pick('siteData', /_siteData\.log\.json$/i);
        pick('ardupilot', /_ardupilot\.log\.bin$/i);
        pick('pingstation', /^pingstation\d*$/i);
        pick('radars', /^radars_service\.log$/i);
        return roles;
    }

    // syslog "Oct 01 19:04:53.143" → Date (UTC) using year/month/day hints from the mission start.
    function mlSyslogDate(line, hint) {
        const m = /^([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(line);
        if (!m) return null;
        const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
        const year = hint && hint.year ? hint.year : new Date().getUTCFullYear();
        return new Date(Date.UTC(year, months[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), m[6] ? Math.round(Number('0.' + m[6]) * 1000) : 0));
    }

    function mlParseMeta(roles) {
        const out = { json: null, events: null, startDate: null };
        try { if (roles.meta) out.json = JSON.parse(mlText(roles.meta.bytes)); } catch (e) { console.warn(`${TAG} meta json parse failed`, e); }
        try { if (roles.events) out.events = JSON.parse(mlText(roles.events.bytes)); } catch (e) { console.warn(`${TAG} eventsReport parse failed`, e); }
        const st = out.json && out.json.start_time;
        const m = st && /^(\d{4})_(\d{2})_(\d{2})__(\d{2})_(\d{2})_(\d{2})$/.exec(st);
        if (m) out.startDate = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
        return out;
    }

    // Drone track from collision.log (TSV, ~10 Hz).
    function mlParseDroneTrack(roles) {
        if (!roles.collision) return [];
        const lines = mlText(roles.collision.bytes).split('\n');
        let hdr = null, iT, iLa, iLo, iAl, iSt;
        const track = [];
        for (const line of lines) {
            const p = line.split('\t');
            if (!hdr) {
                if (p[0] === 'Time') { hdr = p; iT = 0; iLa = p.indexOf('PositionLat'); iLo = p.indexOf('PositionLon'); iAl = p.indexOf('Alt'); iSt = p.indexOf('Stage'); }
                continue;
            }
            if (p.length < hdr.length || iLa < 0) continue;
            let la = Number(p[iLa]), lo = Number(p[iLo]);
            if (!isFinite(la) || !isFinite(lo) || Math.abs(la) < 1) continue;
            if (Math.abs(la) > 90) la /= 1e7;
            if (Math.abs(lo) > 180) lo /= 1e7;
            const d = new Date(p[iT].replace(' ', 'T').replace(',', '.') + 'Z');
            if (isNaN(d)) continue;
            track.push({ t: d.getTime(), lat: la, lon: lo, alt: Number(p[iAl]), stage: p[iSt] });
        }
        return track;
    }

    // Drone position at tMs: linear interpolation between neighbours when the log has a gap
    // (collision.log pauses for seconds at a time), else the nearest sample within 5 s.
    // v0.7 — which network was the drone on? The logs carry no PLMN / operator
    // name, but US LTE band ownership is near-exclusive for a few bands:
    // B13 (700 MHz upper C) is Verizon only; B14 is FirstNet (AT&T); B17 /
    // B29 / B30 are AT&T; B71 (600 MHz), B41, B25, B26 are T-Mobile (incl.
    // ex-Sprint). B2 / B4 / B5 / B12 / B66 / B48 are shared and prove nothing.
    // The drone SIMs are roaming IoT SIMs (+CREG 0,5), so the camped network
    // can differ flight to flight — this is per-flight evidence, not a rule.
    const ML_BAND_OWNER = { 13: 'Verizon', 14: 'AT&T', 17: 'AT&T', 29: 'AT&T', 30: 'AT&T', 71: 'T-Mobile', 41: 'T-Mobile', 25: 'T-Mobile', 26: 'T-Mobile' };
    function mlInferCarrier(bands) {
        const hits = {};
        (bands || []).forEach(b => {
            const n = parseInt(String(b).replace(/\D/g, ''), 10);
            const who = ML_BAND_OWNER[n];
            if (who) (hits[who] = hits[who] || []).push(`B${n}`);
        });
        const names = Object.keys(hits);
        if (!names.length) return { name: null, how: (bands || []).length ? `only shared bands seen (${(bands || []).join(', ')}) — not identifiable from bands` : 'no band data in the log' };
        if (names.length === 1) return { name: names[0], how: `from LTE band ${hits[names[0]].join(' / ')} — ${names[0]}-only spectrum` };
        return { name: names.join(' then ') , how: `bands from more than one carrier (${names.map(n => `${n}: ${hits[n].join('/')}`).join('; ')}) — the roaming SIM switched networks during the flight` };
    }
    function mlDroneAt(track, tMs) {
        if (!track.length) return null;
        let lo = 0, hi = track.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (track[mid].t < tMs) lo = mid + 1; else hi = mid; }
        const next = track[lo], prev = lo > 0 ? track[lo - 1] : null;
        if (prev && next && prev.t <= tMs && next.t >= tMs && next.t - prev.t <= 120000 && next.t > prev.t) {
            const f = (tMs - prev.t) / (next.t - prev.t);
            return { t: tMs, lat: prev.lat + (next.lat - prev.lat) * f, lon: prev.lon + (next.lon - prev.lon) * f, alt: prev.alt + (next.alt - prev.alt) * f, stage: next.stage, interpolated: true };
        }
        const near = prev && Math.abs(prev.t - tMs) < Math.abs(next.t - tMs) ? prev : next;
        return Math.abs(near.t - tMs) <= 5000 ? near : null;
    }

    // Server waypoint summaries (/mission_positions_summaries/<id>/) → sparse track points, merged into the drone track.
    function mlSummariesToTrack(summaries) {
        if (!Array.isArray(summaries)) return [];
        const out = [];
        for (const s of summaries) {
            const t = s && s.timestamp ? Date.parse(s.timestamp) : NaN;
            if (!isFinite(t) || !s.position || typeof s.position.lat !== 'number') continue;
            out.push({ t, lat: s.position.lat, lon: s.position.lng, alt: typeof s.altitude_asl === 'number' ? s.altitude_asl : (s.alt || 0), stage: s.stage != null ? String(s.stage) : '', fromServer: true });
        }
        return out;
    }

    // Amplitude mission events from syslog (perfmon "Sending to Amplitude [...]").
    function mlExtractEvents(syslogLines, hint) {
        const events = [];
        for (const line of syslogLines) {
            const i = line.indexOf('Sending to Amplitude ');
            if (i < 0) continue;
            const d = mlSyslogDate(line, hint);
            let arr = null;
            try { arr = JSON.parse(line.slice(i + 'Sending to Amplitude '.length)); } catch (e) { arr = null; }
            if (!Array.isArray(arr)) {
                // fallback: regex each event (type + stage names + duration) out of a truncated line
                const re = /"event_type":"([^"]+)","event_properties":\{([^]*?)(?=\},?\{"event_type"|\}\]|$)/g; let m;
                while ((m = re.exec(line))) {
                    if (m[1] === 'edge.periodic') continue;
                    const props = {}; const body = m[2];
                    const g = (k) => { const mm = new RegExp(`"${k}":("([^"]*)"|-?[\\d.]+)`).exec(body); return mm ? (mm[2] !== undefined ? mm[2] : Number(mm[1])) : undefined; };
                    for (const k of ['stageName', 'stageNameBefore', 'status', 'DURATION_US']) { const v = g(k); if (v !== undefined) props[k] = v; }
                    events.push({ t: d, type: m[1], props });
                }
                continue;
            }
            for (const ev of arr) {
                if (!ev || ev.event_type === 'edge.periodic') continue;
                const pr = ev.event_properties || {};
                const props = {};
                for (const k of Object.keys(pr)) if (!/^(temp\.|battery\.|fuelGauge\.)/.test(k)) props[k] = pr[k];
                events.push({ t: d, type: ev.event_type, props });
            }
        }
        const label = (e) => {
            const p = e.props || {};
            if (e.type === 'edge.stageUpdate') return (p.stageName || p.stageNameBefore) ? `${p.stageNameBefore || '?'} → ${p.stageName || '?'}` : 'stage update (names not in log line)';
            if (e.type === 'edge.mission') return `mission ${p.status || ''}`.trim();
            if (/mainLoopStall/.test(e.type)) return `main loop stall ${p.DURATION_US ? Math.round(p.DURATION_US / 1000) + ' ms' : ''}`.trim();
            if (/^edge\.notify\./.test(e.type)) return e.type.replace('edge.notify.', '').replace(/_/g, ' ');
            if (e.type === 'edge.energy_nav' || e.type === 'edge.nav_moving_delay') return null;   // too chatty for the timeline
            return e.type.replace(/^edge\./, '');
        };
        const timeline = events.map(e => ({ t: e.t, type: e.type, label: label(e), props: e.props })).filter(e => e.label);
        const find = (re) => events.find(e => re.test(e.type));
        const takeoff = find(/takeoffExecuting|STG_TAKEOFF_IN_PROGRESS/) || events.find(e => e.type === 'edge.stageUpdate' && /TAKEOFF/.test(e.props.stageName || ''));
        const touchdown = events.find(e => e.type === 'edge.stageUpdate' && /TOUCHDOWN/.test(e.props.stageName || ''));
        const aborts = events.filter(e => /droneErr|safetyInit|emergency|failsafe|_warn_(?!mainLoopStall)/i.test(e.type));
        return { all: events, timeline, takeoff, touchdown, aborts };
    }

    // LTE link health from syslog (lte_manager / qmi_modem / udhcpc / telemetry_server RTCM).
    function mlExtractLte(syslogLines, hint) {
        const r = { modem: null, sim: null, apn: null, tcp: { ok: 0, fail: 0, firstOk: null, lastOk: null, fails: [], oks: [] }, pings: [], gstatus: [], creg: {}, dhcp: [], managerRestarts: 0, managerStarts: [], rtcm: { packets: 0, gaps: [] }, resets: new Set() };
        let lastRtcm = null;
        // Python-repr dict field reader: 'key': 'quoted string' | 'key': -12.5 | 'key': 1234
        const num = (s, key) => {
            const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            let m = new RegExp(`'${k}': '([^']*)'`).exec(s);
            if (m) { const v = Number(m[1]); return m[1] !== '' && isFinite(v) ? v : m[1]; }
            m = new RegExp(`'${k}': (-?[\\d.]+)`).exec(s);
            return m ? Number(m[1]) : null;
        };
        for (const line of syslogLines) {
            if (line.includes('telemetry_server') && line.includes('GPS_RTCM_DATA')) {
                const d = mlSyslogDate(line, hint); if (!d) continue;
                r.rtcm.packets++;
                if (lastRtcm && d - lastRtcm > ML_RTCM_GAP_S * 1000) r.rtcm.gaps.push({ from: lastRtcm, to: d, s: Math.round((d - lastRtcm) / 100) / 10 });
                lastRtcm = d; continue;
            }
            if (line.includes('lte_manager')) {
                const d = mlSyslogDate(line, hint);
                if (line.includes('LTE Manager started')) { r.managerRestarts++; if (d) r.managerStarts.push(d); continue; }
                if (line.includes('TCP check succesfull') || line.includes('TCP check successful')) { r.tcp.ok++; if (!r.tcp.firstOk) r.tcp.firstOk = d; r.tcp.lastOk = d; if (d) r.tcp.oks.push(d); continue; }
                if (/TCP check failed|TCP check.*fail/i.test(line)) { r.tcp.fail++; r.tcp.fails.push(d); continue; }
                let m = /Latency Test for: ([\d.]+) : (\d+) packets transmitted, (\d+) received,.*?([\d.]+)% packet loss(?:.*?rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+))?/.exec(line);
                if (m) { r.pings.push({ t: d, host: m[1], sent: +m[2], recv: +m[3], loss: +m[4], avg: m[6] ? +m[6] : null, max: m[7] ? +m[7] : null }); continue; }
                if (/Latency Test for: ([\d.]+) failed/.test(line)) { r.pings.push({ t: d, host: /for: ([\d.]+)/.exec(line)[1], sent: 0, recv: 0, loss: 100, avg: null, max: null, failed: true }); continue; }
                if (line.includes("'Manufacturer'")) { r.modem = { make: num(line, 'Manufacturer'), model: num(line, 'Model'), rev: num(line, 'Revision'), imei: num(line, 'IMEI') }; continue; }
                m = /SIM id: (\d+)/.exec(line); if (m) { r.sim = m[1]; continue; }
                m = /APN suggestion is: (\S+)/.exec(line); if (m) { r.apn = m[1]; continue; }
                if (line.includes("'!GSTATUS'")) {
                    // Field names differ by modem: EM9291 (Airmax) uses PCC_Rx0_RSRP / PCC_Rx0_RSSI / PCC_Tx_Power;
                    // EM7565 (older Sparrow/OGI) uses RSRP_(dBm) / PCC_RxM_RSSI / Tx_Power. First numeric alias wins.
                    const numAny = (keys) => { for (const k of keys) { const v = num(line, k); if (typeof v === 'number') return v; } return null; };
                    if (!r.rawSample) r.rawSample = line.slice(line.indexOf("{'!GSTATUS'"), line.indexOf("{'!GSTATUS'") + 900);
                    r.gstatus.push({ t: d, mode: num(line, 'System_mode'), band: num(line, 'LTE_band'), bw: num(line, 'LTE_bw'),
                        rsrp: numAny(['PCC_Rx0_RSRP', 'RSRP_(dBm)', 'PCC_RxM_RSRP', 'RSRP']), rsrp1: numAny(['PCC_Rx1_RSRP', 'PCC_RxD_RSRP']),
                        rssi: numAny(['PCC_Rx0_RSSI', 'PCC_RxM_RSSI', 'RSSI']), rsrq: numAny(['RSRQ_(dB)', 'RSRQ']), sinr: numAny(['SINR_(dB)', 'SINR']),
                        tx: numAny(['PCC_Tx_Power', 'Tx_Power']), nrRsrp: num(line, 'NR5G_RSRP_(dBm)'), nrSinr: num(line, 'NR5G_SINR_(dB)'),
                        cell: String(num(line, 'Cell_ID') || '').slice(0, 8), rrc: num(line, 'RRC_state'), ps: num(line, 'PS_state'), emm: num(line, 'EMM_state'), temp: num(line, 'Temperature'), reset: num(line, 'Reset_Counter') });
                    const rc = num(line, 'Reset_Counter'); if (rc != null) r.resets.add(rc);
                    continue;
                }
                continue;
            }
            if (line.includes('qmi_modem') && line.includes('+CREG:')) { const m = /\+CREG: (\d,\d)/.exec(line); if (m) r.creg[m[1]] = (r.creg[m[1]] || 0) + 1; continue; }
            if (line.includes('udhcpc')) { const m = /udhcpc\[\d+\]: (\S+): (bound|deconfigured|leasefail|renew)\b(.*)$/.exec(line); if (m) r.dhcp.push({ t: mlSyslogDate(line, hint), iface: m[1], ev: m[2], detail: m[3].trim().slice(0, 120) }); continue; }
        }
        // handovers
        r.handovers = [];
        for (let i = 1; i < r.gstatus.length; i++) {
            const a = r.gstatus[i - 1], b = r.gstatus[i];
            if (a.cell && b.cell && a.cell !== b.cell) r.handovers.push({ t: b.t, from: a.cell, to: b.cell, band: b.band, rsrq: b.rsrq, sinr: b.sinr });
        }
        const worst = (key, pick) => r.gstatus.reduce((w, g) => (typeof g[key] === 'number' && (w == null || pick(g[key], w[key]))) ? g : w, null);
        r.worstRsrp = worst('rsrp', (a, b) => a < b);
        r.worstSinr = worst('sinr', (a, b) => a < b);
        r.worstRsrq = worst('rsrq', (a, b) => a < b);
        r.bands = Array.from(new Set(r.gstatus.map(g => g.band).filter(Boolean)));
        r.modes = Array.from(new Set(r.gstatus.map(g => g.mode).filter(Boolean)));
        r.carrier = mlInferCarrier(r.bands);
        r.lossyPings = r.pings.filter(p => p.loss >= ML_PING_LOSS_WARN && p.t && (!r.tcp.firstOk || p.t > r.tcp.firstOk));
        r.failsAfterUp = r.tcp.fails.filter(d => r.tcp.firstOk && d > r.tcp.firstOk);
        r.deconfAfterUp = r.dhcp.filter(x => x.ev !== 'bound' && r.tcp.firstOk && x.t > r.tcp.firstOk);
        r.resetCount = r.resets.size;
        // outages: windows where the modem reports no cell (No band / RRC Idle / waiting for RRC) or TCP checks fail,
        // each spanning from the last good sample to the next good one.
        // "RRC Idle" alone is NOT a loss (attached, no data in flight); no RSRP / "No band" / a stuck handover is.
        // A sample is "lost" when the modem reports no band, a stuck handover, or no cell AND no RSRP. A missing RSRP
        // alone is not a loss — it may just be a field name this parser doesn't know (surfaced as formatWarning).
        const hasCell = (s) => /^[0-9A-F]{4,}$/i.test(String(s.cell || '')) && !/^F+$/i.test(String(s.cell || ''));
        const lostSample = (s) => /no band/i.test(String(s.band || '')) || /waiting/i.test(String(s.rrc || '')) || (typeof s.rsrp !== 'number' && !hasCell(s));
        r.formatWarning = r.gstatus.length && !r.gstatus.some(s => typeof s.rsrp === 'number') ? 'RSRP not found in this modem\'s status format — signal and coverage are unavailable; paste window.__aimMissionLogs.lte.rawSample to AIM so the parser can learn it' : null;
        const windows = [];
        let open = null, lastGood = null;
        for (const s of r.gstatus) {
            if (!s.t) continue;
            if (lostSample(s)) { if (!open) open = { from: s.t, prevGood: lastGood, firstLost: s.t, samples: 0, kind: 'no cell' }; open.samples++; }
            else { if (open) { open.to = s.t; windows.push(open); open = null; } lastGood = s.t; }
        }
        if (open) { open.to = r.gstatus[r.gstatus.length - 1].t; open.unresolved = true; windows.push(open); }
        // Four more loss signals, all after link-up. Each becomes a window [from, to]:
        const up = r.tcp.firstOk;
        const okTimes = r.tcp.oks.slice().sort((a, b) => a - b);
        const nextOkAfter = (t) => okTimes.find(o => o > t) || null;
        // (a) TCP-check failures, clustered when ≤ 60 s apart
        let cl = null;
        for (const f of r.tcp.fails.filter(d => d && up && d > up).sort((a, b) => a - b)) {
            if (cl && f - cl.lastFail <= 60000) { cl.lastFail = f; cl.samples++; continue; }
            if (cl) windows.push(cl);
            cl = { from: f, firstLost: f, lastFail: f, samples: 1, kind: 'TCP checks failing' };
        }
        if (cl) windows.push(cl);
        // (b) ping tests with 100 % loss, clustered when ≤ 30 s apart; ends at the next ping that gets replies
        const pings = r.pings.filter(p => p.t && up && p.t > up).sort((a, b) => a.t - b.t);
        let pc = null;
        for (let i = 0; i < pings.length; i++) {
            const p = pings[i];
            if (p.loss >= 100) { if (pc && p.t - pc.lastFail <= 30000) { pc.lastFail = p.t; pc.samples++; } else { if (pc) windows.push(pc); pc = { from: p.t, firstLost: p.t, lastFail: p.t, samples: 1, kind: 'no internet (pings 100% lost)' }; } }
            else if (pc) { pc.to = p.t; windows.push(pc); pc = null; }
        }
        if (pc) windows.push(pc);
        // (c) DHCP lease lost on the LTE interface → next 'bound'
        const dh = r.dhcp.filter(x => x.t && up && x.t > up).sort((a, b) => a.t - b.t);
        for (let i = 0; i < dh.length; i++) {
            if (dh[i].ev === 'bound') continue;
            const rebound = dh.slice(i + 1).find(x => x.ev === 'bound');
            windows.push({ from: dh[i].t, firstLost: dh[i].t, lastFail: dh[i].t, to: rebound ? rebound.t : undefined, samples: 1, kind: 'IP lease lost' });
        }
        // (d) the LTE manager itself restarted (re-dial) → from the last good check before it to the first after
        for (const st of r.managerStarts.filter(d => up && d > up)) {
            const prevOk = okTimes.filter(o => o < st).pop() || st;
            windows.push({ from: prevOk, firstLost: st, lastFail: st, samples: 1, kind: 'modem reconnect' });
        }
        for (const w of windows) { if (!w.to) { const n = nextOkAfter(w.lastFail || w.firstLost); w.to = n || w.lastFail || w.firstLost; w.unresolved = !n; } w.s = Math.round((w.to - w.from) / 1000); }
        // merge windows that overlap or sit within 20 s of each other — one outage, several symptoms
        windows.sort((a, b) => a.from - b.from);
        r.outages = [];
        for (const w of windows) {
            const last = r.outages[r.outages.length - 1];
            // Date arithmetic: subtraction coerces to ms (Date + number would concatenate strings)
            if (last && (w.from - last.to) <= 20000) { if (w.to > last.to) last.to = w.to; last.s = Math.round((last.to - last.from) / 1000); if (!last.kind.includes(w.kind)) last.kind += ' + ' + w.kind; last.samples += w.samples; last.unresolved = last.unresolved || w.unresolved; }
            else r.outages.push(Object.assign({}, w));
        }
        r.longestOutageS = r.outages.reduce((m, w) => Math.max(m, w.s || 0), 0);
        // coverage quality from RSRP samples
        const rs = r.gstatus.map(s => s.rsrp).filter(v => typeof v === 'number').sort((a, b) => a - b);
        r.coverage = rs.length ? { n: rs.length, median: rs[Math.floor(rs.length / 2)], weakPct: Math.round(100 * rs.filter(v => v <= -100).length / rs.length), veryWeakPct: Math.round(100 * rs.filter(v => v <= -110).length / rs.length), noCellPct: Math.round(100 * r.gstatus.filter(lostSample).length / r.gstatus.length) } : null;
        // verdict
        if (!r.tcp.firstOk) r.verdict = { level: 'red', text: 'LTE never came up (no successful TCP check in the log)' };
        else {
            // A real drop = an outage of ≥ 30 s or with ≥ 2 consecutive bad samples, a DHCP lease loss, or a modem reset.
            // One failed TCP check that passes again 10 s later is a blip, reported as degraded, not dropped.
            const realOutages = r.outages.filter(w => (w.s || 0) >= 30 || w.samples >= 2 || /lease|reconnect|no internet/.test(w.kind));
            const blips = r.outages.filter(w => !realOutages.includes(w));
            const withRtt = r.pings.filter(p => p.avg != null);
            const avgRtt = withRtt.length ? Math.round(withRtt.reduce((s, p) => s + p.avg, 0) / withRtt.length) : null;
            const worstRtt = withRtt.length ? Math.round(Math.max(...withRtt.map(p => p.max || 0))) : null;
            const lossShare = r.pings.length ? Math.round(100 * r.lossyPings.length / r.pings.length) : 0;
            const quality = `${r.lossyPings.length}/${r.pings.length} ping tests with loss (${lossShare}%)${avgRtt != null ? `, avg rtt ${avgRtt} ms, worst ${worstRtt} ms` : ''}${r.rtcm.packets ? `, ${r.rtcm.gaps.length} RTK-stream gap(s) > ${ML_RTCM_GAP_S} s` : ''}`;
            r.avgRtt = avgRtt; r.worstRtt = worstRtt; r.lossShare = lossShare;
            if (realOutages.length || r.deconfAfterUp.length || r.resetCount > 1) r.verdict = { level: 'red', text: `LTE DROPPED — ${realOutages.length} outage(s), longest ${r.longestOutageS} s${realOutages.length ? ' (' + realOutages.slice(0, 3).map(w => `${mlHms(w.from)}→${mlHms(w.to)}`).join(', ') + (realOutages.length > 3 ? ', …' : '') + ')' : ''} · ${r.failsAfterUp.length} failed TCP check(s) · ${r.deconfAfterUp.length} DHCP loss event(s) · ${r.resetCount > 1 ? 'modem reset seen' : 'no modem reset'}` };
            else if (blips.length || lossShare >= 25 || (avgRtt != null && avgRtt >= 400)) r.verdict = { level: 'amber', text: `No disconnect, but a POOR link — ${blips.length ? blips.length + ' brief blip(s) (' + blips.map(w => mlHms(w.from) + ' ' + w.s + ' s').join(', ') + '), ' : ''}${quality}` };
            else if (r.lossyPings.length || r.rtcm.gaps.length) r.verdict = { level: 'amber', text: `No disconnect — link stayed up, minor degradation: ${quality}` };
        }
        if (!r.verdict) r.verdict = { level: 'green', text: 'No disconnect — every TCP check and ping passed, no DHCP loss, no modem reset' };
        return r;
    }

    // DAA: ADS-B feed (pingstation NDJSON) + radars_service tracks, vs the drone track.
    function mlExtractDaa(roles, droneTrack, abortTimeMs) {
        const out = { aircraft: [], source: null, radarTracks: 0, notes: [] };
        const addPos = (map, key, rec) => { if (!map.has(key)) map.set(key, { key, pts: [], meta: {} }); map.get(key).pts.push(rec); };
        const byKey = new Map();
        if (roles.pingstation) {
            out.source = 'pingstation (ADS-B)';
            const text = mlText(roles.pingstation.bytes);
            let depth = 0, start = 0, parsed = 0, bad = 0;
            for (let i = 0; i < text.length; i++) {
                const c = text[i];
                if (c === '{') { if (depth === 0) start = i; depth++; }
                else if (c === '}') {
                    depth--;
                    if (depth === 0) {
                        try {
                            const rec = JSON.parse(text.slice(start, i + 1)); parsed++;
                            for (const a of (rec.aircraft || [])) {
                                if (typeof a.latDD !== 'number') continue;
                                const key = String(a.icaoAddress || '?');
                                const t = a.timeStamp ? Date.parse(a.timeStamp) : NaN;
                                addPos(byKey, key, { t, lat: a.latDD, lon: a.lonDD, altM: (a.altitudeMM || 0) / 1000, hdg: a.headingDE2 != null ? a.headingDE2 / 100 : null, spdMs: a.horVelocityCMS != null ? a.horVelocityCMS / 100 : null });
                                const m = byKey.get(key).meta;
                                if (a.callsign && String(a.callsign).trim()) m.callsign = String(a.callsign).trim();
                                if (a.emitterType != null) m.emitter = a.emitterType;
                                if (a.squawk != null) (m.squawks = m.squawks || new Set()).add(a.squawk);
                            }
                        } catch (e) { bad++; }
                    }
                }
            }
            if (bad) out.notes.push(`${bad} unparsable ADS-B record(s) skipped`);
            out.notes.push(`${parsed} ADS-B records`);
        }
        if (roles.radars) {
            const lines = mlText(roles.radars.bytes).split('\n');
            let n = 0;
            for (const line of lines) if (line.includes('Radars tracks published')) n++;
            out.radarTracks = n;
        }
        const EMITTER = { 0: 'unknown', 1: 'light (<15.5k lb)', 2: 'small (15.5–75k lb)', 3: 'large', 4: 'high-vortex large', 5: 'heavy', 6: 'high performance', 7: 'rotorcraft', 9: 'glider', 10: 'lighter-than-air', 11: 'parachutist', 12: 'ultralight', 14: 'UAV', 15: 'space' };
        for (const ac of byKey.values()) {
            const pts = ac.pts.filter(p => isFinite(p.t)).sort((a, b) => a.t - b.t);
            if (!pts.length) continue;
            let closest = null, atAbort = null;
            for (const p of pts) {
                const d = mlDroneAt(droneTrack, p.t);
                if (d) { const dist = mlHav(p.lat, p.lon, d.lat, d.lon); if (!closest || dist < closest.dist) closest = { dist, t: p.t, acAltM: p.altM, droneAltM: d.alt }; }
                if (abortTimeMs && Math.abs(p.t - abortTimeMs) <= 2000 && !atAbort) { const dd = mlDroneAt(droneTrack, abortTimeMs); if (dd) atAbort = { dist: mlHav(p.lat, p.lon, dd.lat, dd.lon), acAltM: p.altM, droneAltM: dd.alt }; }
            }
            const alts = pts.map(p => p.altM);
            out.aircraft.push({
                icao: ac.key, nNumber: mlIcaoToN(ac.key), callsign: ac.meta.callsign || '', emitter: EMITTER[ac.meta.emitter] || (ac.meta.emitter != null ? String(ac.meta.emitter) : '—'),
                squawks: ac.meta.squawks ? Array.from(ac.meta.squawks) : [], first: pts[0].t, last: pts[pts.length - 1].t, n: pts.length,
                altMinM: Math.min(...alts), altMaxM: Math.max(...alts), spdMaxMs: Math.max(...pts.map(p => p.spdMs || 0)), closest, atAbort,
            });
        }
        out.aircraft.sort((a, b) => ((a.closest ? a.closest.dist : 1e12) - (b.closest ? b.closest.dist : 1e12)));
        return out;
    }

    // Warnings / errors by process inside the flight window.
    function mlExtractWarnings(syslogLines, hint, fromMs, toMs) {
        const byProc = new Map();
        for (const line of syslogLines) {
            // level-gated: a DEBUG/INFO line mentioning "failed" in prose is not a warning
            if (/\[(DEBUG|INFO ?)\]| - (DEBUG|INFO) - /.test(line)) continue;
            if (!/\[(WARN(ING)?|ERROR|ERRO|CRITICAL|FATAL)\]| - (WARNING|ERROR|CRITICAL) - |\b(WARN|ERRO|ERROR|CRITICAL|FATAL)\b|\bfailed\b|\btimed? ?out\b|\bFailed\b/.test(line) || ML_NOISE_RE.test(line)) continue;
            const d = mlSyslogDate(line, hint); if (!d) continue;
            if (fromMs && d < fromMs) continue;
            if (toMs && d > toMs) continue;
            const m = /^[A-Z][a-z]{2} \d{2} [\d:.]+ (\S+?)(?:\[\d+\])?: ?(.*)$/.exec(line);
            const proc = m ? m[1] : '?'; const msg = (m ? m[2] : line).replace(/^\d{4}-\d{2}-\d{2} [\d:,]+\s+/, '').slice(0, 220);
            if (!byProc.has(proc)) byProc.set(proc, { proc, n: 0, first: d, samples: [] });
            const e = byProc.get(proc); e.n++; if (e.samples.length < 3 && !e.samples.some(s => s.msg === msg)) e.samples.push({ t: d, msg });
        }
        return Array.from(byProc.values()).sort((a, b) => b.n - a.n);
    }

    // ---- ESC telemetry (motor controllers) — v0.9 ---------------------------
    // Port of Support's ESC-alert review (Niv, 2026-11). The drone raises
    // "escN critical_current_rpm_ratio alert (value = … > 1)" and returns home. When the
    // ESC agent was logging only a few readings per second at that moment, the alert is
    // judged a likely FALSE POSITIVE; with normal sampling it is treated as real.
    // Inputs: *esc_telemetry*.log (per-ESC samples + the agent's "IPC publishing" summaries
    // carrying msg_in_sec) and the date-named main drone log(s) (the alert + action lines).
    const ML_ESC_RATIO_THR = 1.0;     // ratio above this = an above-threshold stretch
    const ML_ESC_SAMP_THR = 3;        // fewer readings per second than this = low sampling
    const ML_ESC_ALERT_LOOKBACK_S = 60;   // the drone alerts late (it only sees published values) — judge stretches this close before the alert
    const ML_ESC_FIELDS = ['throttle_in', 'throttle_out', 'rpm', 'voltage', 'current', 'mosfet_temp', 'capacitor_temp', 'status_code', 'critical_current_rpm_ratio'];
    const ML_DRONE_LOG_RE = /^\d{4}_\d\d_\d\d__\d\d_\d\d_\d\d\.log$/;

    // "2026-10-01 18:59:49,263" at offset i → epoch ms (null when the text there is not a stamp).
    // The on-board log clock is UTC — the same clock as syslog and the mission start_time.
    function mlLogTs(s, i) {
        if (s.length < i + 23 || s[i + 4] !== '-' || s[i + 10] !== ' ' || s[i + 19] !== ',') return null;
        const n = (a, b) => +s.slice(i + a, i + b);
        const t = Date.UTC(n(0, 4), n(5, 7) - 1, n(8, 10), n(11, 13), n(14, 16), n(17, 19), n(20, 23));
        return isFinite(t) ? t : null;
    }
    const mlHmsMs = (ms) => { const d = new Date(ms); return `${mlHms(d)}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`; };
    function mlLowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; } return lo; }

    function mlParseEscLog(text) {
        const series = {}, pubs = {}, pubTimes = [];
        let powerTrain = null, enumerated = null, t0 = null, t1 = null, samples = 0;
        const kvRe = /'(\w+)': (-?\d[\d.]*(?:[eE][-+]?\d+)?)/g;
        const pubRe = /'(esc\d+)': \{([^}]*)\}/g;
        let pos = 0;
        while (pos < text.length) {
            let nl = text.indexOf('\n', pos); if (nl < 0) nl = text.length;
            const line = text.slice(pos, nl); pos = nl + 1;
            const t = mlLogTs(line, 0); if (t == null) continue;
            const rest = line.slice(24);
            if (t0 == null || t < t0) t0 = t;
            if (t1 == null || t > t1) t1 = t;
            if (/^esc\d+:\{/.test(rest)) {
                const name = rest.slice(0, rest.indexOf(':'));
                let s = series[name];
                if (!s) { s = series[name] = { t: [] }; for (const f of ML_ESC_FIELDS) s[f] = []; }
                const row = {}; let m; kvRe.lastIndex = 0;
                while ((m = kvRe.exec(rest))) row[m[1]] = +m[2];
                s.t.push(t);
                for (const f of ML_ESC_FIELDS) s[f].push(row[f] != null ? row[f] : NaN);
                samples++;
            } else if (rest.startsWith('IPC publishing')) {
                let m, any = false; pubRe.lastIndex = 0;
                while ((m = pubRe.exec(rest))) {
                    const mm = /'msg_in_sec': (-?[\d.]+)/.exec(m[2]); if (!mm) continue;
                    const p = pubs[m[1]] || (pubs[m[1]] = { t: [], v: [] });
                    p.t.push(t); p.v.push(+mm[1]); any = true;
                }
                if (any) pubTimes.push(t);
            } else {
                const pt = /configured power train is (\S+)/.exec(rest); if (pt) powerTrain = pt[1];
                const en = /Enumerated ESCs: \[(.*)\]/.exec(rest); if (en) enumerated = en[1];
            }
        }
        return { series, pubs, pubTimes, powerTrain, enumerated, t0, t1, samples };
    }

    // Alert + action lines from the main drone log(s). Each alert: {t, esc, value, limit, line, file}.
    function mlFindEscAlerts(files) {
        const logs = files.filter(f => ML_DRONE_LOG_RE.test(f.base));
        const alerts = [], actions = [], seen = new Set();
        const hitRe = /critical_current_rpm_ratio alert|Motor Malfunction Detected/gi;
        const alertRe = /(esc\d+)\W{0,12}critical_current_rpm_ratio alert[^\n(]*\(\s*value\s*=\s*([-\d.eE+]+)\s*>\s*([-\d.eE+]+)/i;
        for (const f of logs) {
            const text = mlText(f.bytes);
            let m; hitRe.lastIndex = 0;
            while ((m = hitRe.exec(text))) {
                const a = text.lastIndexOf('\n', m.index) + 1; let b = text.indexOf('\n', m.index); if (b < 0) b = text.length;
                const line = text.slice(a, b).replace(/\r$/, ''); hitRe.lastIndex = b;
                const t = mlLogTs(line, 0), key = `${t}|${line.slice(24)}`;
                if (seen.has(key)) continue; seen.add(key);
                if (/Motor Malfunction Detected/i.test(m[0])) { const i = line.search(/ESC and\/or Motor|Motor Malfunction/i); actions.push({ t, text: line.slice(i).trim().slice(0, 200), file: f.base }); continue; }
                const am = alertRe.exec(line);
                alerts.push({ t, esc: am ? am[1].toLowerCase() : null, value: am ? +am[2] : null, limit: am ? +am[3] : null, line: line.slice(0, 300), file: f.base });
            }
        }
        alerts.sort((x, y) => (x.t || 0) - (y.t || 0)); actions.sort((x, y) => (x.t || 0) - (y.t || 0));
        return { alerts, actions, mainLogs: logs.map(f => f.base) };
    }

    function mlExtractEsc(files, roles) {
        const found = mlFindEscAlerts(files);
        const main = files.filter(f => ML_DRONE_LOG_RE.test(f.base)).sort((a, b) => b.bytes.length - a.bytes.length)[0];
        if (main) roles.droneLog = main;
        const escFiles = files.filter(f => /esc_telemetry.*\.log$/i.test(f.base)).sort((a, b) => b.bytes.length - a.bytes.length);
        if (!escFiles.length) return Object.assign({ present: false, note: 'no *esc_telemetry*.log in this archive' }, found);
        roles.esc = escFiles[0];
        const p = mlParseEscLog(mlText(escFiles[0].bytes));
        const names = Object.keys(p.series).sort((a, b) => (parseInt(a.slice(3), 10) || 0) - (parseInt(b.slice(3), 10) || 0));
        if (!names.length) return Object.assign({ present: false, note: `${escFiles[0].base} has no ESC telemetry lines` }, found);
        // dense per-clock-second sample counts per ESC (a second with no reading counts as 0)
        const perSec = {};
        let runFrom = null, runTo = null;
        for (const n of names) {
            const s = p.series[n], T = s.t, s0 = Math.floor(T[0] / 1000);
            const counts = new Array(Math.floor(T[T.length - 1] / 1000) - s0 + 1).fill(0);
            for (let i = 0; i < T.length; i++) {
                counts[Math.floor(T[i] / 1000) - s0]++;
                if (s.rpm[i] > 0) { if (runFrom == null || T[i] < runFrom) runFrom = T[i]; if (runTo == null || T[i] > runTo) runTo = T[i]; }
            }
            perSec[n] = { s0, counts };
        }
        const gaps = []; for (let i = 1; i < p.pubTimes.length; i++) gaps.push(p.pubTimes[i] - p.pubTimes[i - 1]);
        gaps.sort((a, b) => a - b);
        const pubInterval = gaps.length ? gaps[gaps.length >> 1] : 4000;
        const unparsed = found.alerts.filter(a => !a.esc || a.t == null).length;
        return Object.assign({ present: true, file: escFiles[0].base, otherFiles: escFiles.slice(1).map(f => f.base), names, perSec, pubInterval, run: runFrom != null ? { from: runFrom, to: runTo } : null,
            formatWarning: unparsed ? `${unparsed} ESC alert line(s) in the drone log did not match the expected "escN critical_current_rpm_ratio alert (value = X > Y)" shape — verdict may be incomplete` : null }, p, found);
    }

    // Re-runnable with different thresholds (the card's controls) — no re-parse.
    function mlEscAnalyze(e, ratioThr, sampThr) {
        const stretches = [], stats = [];
        for (const name of e.names) {
            const s = e.series[name], T = s.t, Rr = s.critical_current_rpm_ratio, ps = e.perSec[name], pb = e.pubs[name];
            let a = -1;
            for (let i = 0; i <= T.length; i++) {
                if (i < T.length && Rr[i] > ratioThr) { if (a < 0) a = i; continue; }
                if (a < 0) continue;
                const b = i - 1, from = T[a], to = T[b];
                let peak = -Infinity, peakT = from;
                for (let k = a; k <= b; k++) if (Rr[k] > peak) { peak = Rr[k]; peakT = T[k]; }
                const k0 = Math.floor(from / 1000) - ps.s0, k1 = Math.floor(to / 1000) - ps.s0;
                let minPerSec = Infinity, secsBelow = 0;
                for (let k = k0; k <= k1; k++) { const c = ps.counts[k] || 0; if (c < minPerSec) minPerSec = c; if (c < sampThr) secsBelow++; }
                // each publish describes the seconds just before it → include one publish interval past the end
                let minMsg = null;
                if (pb) for (let j = mlLowerBound(pb.t, from); j < pb.t.length && pb.t[j] <= to + e.pubInterval; j++) if (minMsg == null || pb.v[j] < minMsg) minMsg = pb.v[j];
                stretches.push({ esc: name, from, to, s: (to - from) / 1000, samples: b - a + 1, peak, peakT, minPerSec, secsBelow, secsTotal: k1 - k0 + 1, minMsg, low: minPerSec < sampThr || (minMsg != null && minMsg < sampThr) });
                a = -1;
            }
            // per-ESC stats while the motors were running
            const st = { esc: name, n: 0, thrIn: 0, thrOut: 0, rpmAvg: 0, rpmMax: -Infinity, curAvg: 0, curMax: -Infinity, voltMin: Infinity, mosMax: -Infinity, capMax: -Infinity, ratioMax: -Infinity, over: 0, statusNonZero: 0 };
            if (e.run) for (let i = mlLowerBound(T, e.run.from); i < T.length && T[i] <= e.run.to; i++) {
                st.n++; st.thrIn += s.throttle_in[i] || 0; st.thrOut += s.throttle_out[i] || 0; st.rpmAvg += s.rpm[i] || 0; st.curAvg += s.current[i] || 0;
                if (s.rpm[i] > st.rpmMax) st.rpmMax = s.rpm[i];
                if (s.current[i] > st.curMax) st.curMax = s.current[i];
                if (s.voltage[i] < st.voltMin) st.voltMin = s.voltage[i];
                if (s.mosfet_temp[i] > st.mosMax) st.mosMax = s.mosfet_temp[i];
                if (s.capacitor_temp[i] > st.capMax) st.capMax = s.capacitor_temp[i];
                if (Rr[i] > st.ratioMax) st.ratioMax = Rr[i];
                if (Rr[i] > ratioThr) st.over++;
                if (s.status_code[i]) st.statusNonZero++;
            }
            if (st.n) { st.thrIn /= st.n; st.thrOut /= st.n; st.rpmAvg /= st.n; st.curAvg /= st.n; st.overPct = 100 * st.over / st.n; }
            stats.push(st);
        }
        stretches.sort((x, y) => x.from - y.from);
        const alertEscs = Array.from(new Set(e.alerts.map(x => x.esc).filter(Boolean)));
        // Which stretches count: with an alert, the alerted ESC's stretches CLOSE to the alert. A healthy
        // flight already crosses 1.0 for a few seconds at takeoff with normal sampling (237893: all four
        // ESCs), so judging every stretch of the flight would turn each false positive into "real".
        // No stretch near the alert → CHECK, never a guess from an unrelated stretch.
        let judged = stretches;
        if (alertEscs.length) {
            const look = ML_ESC_ALERT_LOOKBACK_S * 1000;
            judged = stretches.filter(x => e.alerts.some(al => al.esc === x.esc && al.t != null && x.from <= al.t + 2000 && x.to >= al.t - look));
        }
        for (const x of stretches) x.judged = judged.includes(x);
        const scopeTxt = `in the ${ML_ESC_ALERT_LOOKBACK_S} s before the alert`;
        const real = judged.filter(x => !x.low);
        const span = (x) => `${x.esc} ${mlHms(new Date(x.from))}–${mlHms(new Date(x.to))} (peak ${x.peak.toFixed(3)})`;
        const worst = stretches.reduce((m, x) => (!m || x.peak > m.peak ? x : m), null);
        let verdict;
        if (e.alerts.length) {
            const who = alertEscs.join(', ') || 'an ESC';
            if (!judged.length) verdict = { code: 'check', level: 'amber', text: `CHECK — the drone alerted on ${who}, but that ESC is not above ${ratioThr} ${scopeTxt} in this log; the log may not cover the alert time` };
            else if (!real.length) verdict = { code: 'false', level: 'amber', text: `YES, false positive — every stretch above ${ratioThr} on ${who} ${scopeTxt} (${judged.length}) had low sampling (under ${sampThr}/s)` };
            else verdict = { code: 'real', level: 'red', text: `NO, not a false positive — treat as real: ${span(real[0])} was above ${ratioThr} with normal sampling${real.length > 1 ? ` (+${real.length - 1} more)` : ''}, ${scopeTxt}` };
        } else if (!stretches.length) verdict = { code: 'none', level: 'green', text: `No alert — no ESC went above ${ratioThr}` };
        else if (e.mainLogs.length) verdict = { code: 'quiet', level: 'green', text: `No ESC alert in the drone log. The ratio did go above ${ratioThr} in ${stretches.length} stretch(es) (${stretches.length - stretches.filter(x => x.low).length} with normal sampling; peak ${worst.peak.toFixed(3)} on ${worst.esc}) without the drone alerting` };
        else if (!real.length) verdict = { code: 'nolog-false', level: 'amber', text: `No drone log in the archive to confirm an alert. Every stretch above ${ratioThr} (${stretches.length}) had low sampling — an alert here would be a false positive` };
        else verdict = { code: 'nolog-real', level: 'amber', text: `No drone log in the archive to confirm an alert. ${span(real[0])} was above ${ratioThr} with normal sampling — an alert here would be real` };
        return { ratioThr, sampThr, stretches, judged, stats, alertEscs, verdict };
    }

    // ===================== [AIM_ML_INCIDENT] ===========================
    // Flight-controller log (ArduPilot DataFlash .bin) decode + incident checks. No DOM.
    // DataFlash is self-describing: every record starts A3 95 <type>; type 128 (FMT) defines the others.
    const ML_DF_SIZE = { a: 64, b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4, d: 8, n: 4, N: 16, Z: 64, c: 2, C: 2, e: 4, E: 4, L: 4, M: 1, q: 8, Q: 8 };
    // Only these messages / columns are kept (the log is tens of MB). where = keep rows with that column value only.
    const ML_DF_WANT = {
        GPS: { cols: ['TimeUS', 'Status', 'GMS', 'GWk', 'Spd'], where: ['I', 0] },
        POS: { cols: ['TimeUS', 'Lat', 'Lng', 'Alt'] },
        ATT: { cols: ['TimeUS', 'DesRoll', 'Roll', 'DesPitch', 'Pitch'] },
        IMU: { cols: ['TimeUS', 'AccX', 'AccY', 'AccZ'], where: ['I', 0] },
        CTUN: { cols: ['TimeUS', 'ThO'] },
        RCOU: { cols: ['TimeUS', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14'] },
        MSG: { cols: ['TimeUS', 'Message'] },
        PARM: { cols: ['Name', 'Value'] },
    };
    function mlDfParse(u8) {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = u8.length;
        const str = (off, len) => { let s = ''; for (let k = 0; k < len; k++) { const c = u8[off + k]; if (!c) break; s += String.fromCharCode(c); } return s; };
        const read = (ch, o) => {
            switch (ch) {
                case 'b': return dv.getInt8(o); case 'B': case 'M': return dv.getUint8(o);
                case 'h': return dv.getInt16(o, true); case 'H': return dv.getUint16(o, true);
                case 'i': return dv.getInt32(o, true); case 'I': return dv.getUint32(o, true);
                case 'f': return dv.getFloat32(o, true); case 'd': return dv.getFloat64(o, true);
                case 'c': return dv.getInt16(o, true) * 0.01; case 'C': return dv.getUint16(o, true) * 0.01;
                case 'e': return dv.getInt32(o, true) * 0.01; case 'E': return dv.getUint32(o, true) * 0.01;
                case 'L': return dv.getInt32(o, true) * 1e-7;
                case 'q': return Number(dv.getBigInt64(o, true)); case 'Q': return Number(dv.getBigUint64(o, true));
                case 'n': return str(o, 4); case 'N': return str(o, 16); case 'Z': return str(o, 64);
                default: return null;
            }
        };
        const defs = new Array(256).fill(null);
        defs[128] = { name: 'FMT', len: 89 };
        const out = {}, seen = {};
        let i = 0, bad = 0, records = 0;
        while (i < n - 3) {
            if (u8[i] !== 0xA3 || u8[i + 1] !== 0x95) { i++; bad++; continue; }
            const t = u8[i + 2], d = defs[t];
            if (!d) { i++; bad++; continue; }
            if (i + d.len > n) break;
            if (t === 128) {
                const type = u8[i + 3], len = u8[i + 4], name = str(i + 5, 4), fmt = str(i + 9, 16), cols = str(i + 25, 64).split(',');
                let size = 3, ok = len >= 3 && cols.length === fmt.length;
                const fields = [];
                for (let k = 0; k < fmt.length && ok; k++) { const sz = ML_DF_SIZE[fmt[k]]; if (!sz) { ok = false; break; } fields.push({ name: cols[k], ch: fmt[k], off: size }); size += sz; }
                if (ok && size === len && type !== 128) {
                    const def = { name, len, pick: null, where: null, out: null };
                    const want = ML_DF_WANT[name];
                    if (want) {
                        def.pick = fields.filter(f => want.cols.includes(f.name));
                        if (want.where) { const wf = fields.find(f => f.name === want.where[0]); if (wf) def.where = { f: wf, v: want.where[1] }; }
                        def.out = out[name] || (out[name] = {});
                        for (const f of def.pick) if (!def.out[f.name]) def.out[f.name] = [];
                    }
                    defs[type] = def; seen[name] = 0;
                }
            } else {
                records++; seen[d.name]++;
                if (d.pick && (!d.where || read(d.where.f.ch, i + d.where.f.off) === d.where.v)) for (const f of d.pick) d.out[f.name].push(read(f.ch, i + f.off));
            }
            i += d.len;
        }
        // UTC: GPS week + ms-of-week (GPS time runs 18 s ahead of UTC since 2017)
        let utcOff = null;
        const G = out.GPS;
        if (G && G.TimeUS) for (let k = 0; k < G.TimeUS.length; k++) if (G.Status[k] >= 3 && G.GWk[k] > 1000) { utcOff = Date.UTC(1980, 0, 6) + G.GWk[k] * 604800000 + G.GMS[k] - 18000 - G.TimeUS[k] / 1000; break; }
        if (utcOff != null) for (const m of Object.keys(out)) if (out[m].TimeUS) out[m].t = out[m].TimeUS.map(us => utcOff + us / 1000);
        return { msgs: out, utcOff, bad, records, seen };
    }

    const ML_G = 9.80665;
    const ML_INC = { stopFromMs: 5, stopDropMs: 4, forceG: 0.8, dragG: 0.1, slowMs: 4, upsetDeg: 60, devDeg: 25, impactG: 4, motorFullPwm: 1900, motorWeakFrac: 0.8, motorStallPwm: 1500, motorStallFrac: 0.35 };
    const mlMean = (arr, a, b) => { let s = 0; for (let k = a; k < b; k++) s += arr[k]; return b > a ? s / (b - a) : NaN; };

    // Cheap signals from the mission events already parsed — decides whether the red card shows.
    function mlIncidentSignals(events, escData) {
        const to = events.takeoff && events.takeoff.t ? events.takeoff.t.getTime() : null;
        const inFlight = (e) => e.t && (to == null || e.t.getTime() >= to);
        const first = (re) => events.all.find(e => re.test(e.type) && inFlight(e)) || null;
        const defs = [
            ['parachute', /parachuteReleased/i, 'strong', 'Parachute released'],
            ['landInPlace', /safetyInit_landInPlace/i, 'strong', 'Land-in-place: it was told to come straight down where it was'],
            ['hardRestriction', /siteHardRestrictions/i, 'strong', 'Left the allowed flight area (hard limit)'],
            ['motorAlarm', /escMotorAlert/i, 'strong', 'Motor / ESC alarm'],
            ['batteryCritical', /batteryCritical/i, 'weak', 'Battery critical'],
            ['restriction', /droneErr_siteRestrictions|safetyInit_goToBreach/i, 'weak', 'Left its flight path / zone (soft limit)'],
            ['safetySwitch', /safetySwitch/i, 'weak', 'Control taken over the backup safety link'],
        ];
        const signals = [];
        for (const [id, re, weight, text] of defs) { const e = first(re); if (e) signals.push({ id, weight, text, t: e.t.getTime(), type: e.type }); }
        if (to != null && !events.touchdown) signals.push({ id: 'noTouchdown', weight: 'weak', text: 'No normal touchdown recorded after takeoff', t: null, type: null });
        if (escData && escData.alerts && escData.alerts.length && !signals.some(s => s.id === 'motorAlarm') && escData.alerts[0].t != null && (to == null || escData.alerts[0].t >= to)) signals.push({ id: 'motorAlarm', weight: 'strong', text: 'Motor / ESC alarm (drone log)', t: escData.alerts[0].t, type: null });
        signals.sort((a, b) => (a.t == null ? Infinity : a.t) - (b.t == null ? Infinity : b.t));
        const strong = signals.filter(s => s.weight === 'strong').length;
        // why did it leave its plan? = the first safety action / drone error in flight
        const why = events.all.find(e => inFlight(e) && /safetyInit|droneErr_(?!gimbal|ai_)/i.test(e.type)) || null;
        return { show: strong > 0 || signals.length >= 2, strong, signals, firstTrigger: why ? { t: why.t.getTime(), type: why.type } : null };
    }

    // Deep review. df = mlDfParse() result; escData = mlExtractEsc() result (may be absent); signals = mlIncidentSignals().
    function mlIncidentDeep(df, escData, signals) {
        const M = df.msgs, need = ['GPS', 'POS', 'ATT', 'IMU'];
        const missing = need.filter(k => !M[k] || !M[k].t || M[k].t.length < 20);
        if (df.utcOff == null) return { ok: false, note: 'The flight-controller log has no GPS time, so its records cannot be placed on the clock.' };
        if (missing.length) return { ok: false, note: `The flight-controller log is missing ${missing.join(', ')} records (seen: ${Object.keys(df.seen).length} message types).` };
        const G = M.GPS, P = M.POS, A = M.ATT, I = M.IMU, C = M.CTUN, R = M.RCOU;
        const at = (S, col, t) => { const k = Math.min(S.t.length - 1, Math.max(0, mlLowerBound(S.t, t))); return S[col][k]; };
        const posAt = (t) => ({ lat: at(P, 'Lat', t), lon: at(P, 'Lng', t), alt: at(P, 'Alt', t) });
        // --- airborne window: height above the starting height ---
        // (POS.Alt = height above sea level. RelHomeAlt is no use here: Percepto moves the home height after start-up.)
        const alt0 = P.Alt.slice(0, Math.min(50, P.t.length)).sort((x, y) => x - y)[Math.min(25, P.t.length >> 1)];
        let a0 = -1;
        for (let k = 0; k < P.t.length; k++) if (P.Alt[k] - alt0 > 5) { a0 = k; break; }
        if (a0 < 0) return { ok: false, note: 'The flight-controller log never shows the drone more than 15 ft above where it started.' };
        const tAir0 = P.t[a0], tLog1 = P.t[P.t.length - 1];
        // --- body-frame horizontal force, smoothed over ~0.12 s (kills vibration, keeps a real shove) ---
        const nI = I.t.length, bx = new Float64Array(nI), by = new Float64Array(nI), tot = new Float64Array(nI);
        { let lo = 0, sx = 0, sy = 0;
            for (let k = 0; k < nI; k++) {
                sx += I.AccX[k]; sy += I.AccY[k];
                while (I.t[k] - I.t[lo] > 120) { sx -= I.AccX[lo]; sy -= I.AccY[lo]; lo++; }
                bx[k] = sx / (k - lo + 1) / ML_G; by[k] = sy / (k - lo + 1) / ML_G;
                tot[k] = Math.hypot(I.AccX[k], I.AccY[k], I.AccZ[k]) / ML_G;
            } }
        const iA0 = mlLowerBound(I.t, tAir0 + 3000);
        // --- hard impact: first raw reading at or above impactG while airborne ---
        let impact = null;
        for (let k = iA0; k < nI; k++) if (tot[k] >= ML_INC.impactG) {
            let peak = tot[k]; for (let j = k; j < nI && I.t[j] - I.t[k] < 1000; j++) if (tot[j] > peak) peak = tot[j];
            impact = Object.assign({ t: I.t[k], peakG: peak }, posAt(I.t[k])); break;
        }
        const tStopScan = impact ? impact.t : tLog1;
        // --- jolts: smoothed body-horizontal force at or above joltG, before any impact ---
        const jolts = [];
        for (let k = iA0; k < nI && I.t[k] < tStopScan - 200; k++) {
            const h = Math.hypot(bx[k], by[k]);
            if (h < ML_INC.forceG) continue;
            const last = jolts[jolts.length - 1];
            if (last && I.t[k] - last.to < 1000) { last.to = I.t[k]; if (h > last.peakG) { last.peakG = h; last.peakT = I.t[k]; last.bx = bx[k]; last.by = by[k]; } }
            else jolts.push({ from: I.t[k], to: I.t[k], peakG: h, peakT: I.t[k], bx: bx[k], by: by[k] });
        }
        // --- sudden stop: lost stopDropMs within 1 s from stopFromMs or faster, with a body-frame shove in the same second ---
        // (a drone that brakes on its own tilts back and pushes with its props: that shows as almost no force along the body)
        let stop = null;
        for (let k = mlLowerBound(G.t, tAir0); k < G.t.length && G.t[k] < tStopScan && !stop; k++) {
            if (G.Spd[k] < ML_INC.stopFromMs) continue;
            const j = mlLowerBound(G.t, G.t[k] + 1000);
            if (j >= G.t.length || G.Spd[k] - G.Spd[j] < ML_INC.stopDropMs) continue;
            const jl = jolts.find(x => x.to >= G.t[k] - 300 && x.from <= G.t[j] + 300);
            if (!jl) continue;
            // speed just before the shove and where it settled just after
            let kb = mlLowerBound(G.t, jl.from - 400); kb = Math.max(0, Math.min(G.t.length - 1, kb));
            let ka = mlLowerBound(G.t, jl.to + 400); ka = Math.min(G.t.length - 1, ka);
            stop = Object.assign({ from: jl.from, to: jl.to, spdS: (G.t[ka] - G.t[kb]) / 1000, peakG: jl.peakG, peakT: jl.peakT, bx: jl.bx, by: jl.by, spdBefore: G.Spd[kb], spdAfter: G.Spd[ka], pitch: at(A, 'Pitch', jl.peakT), roll: at(A, 'Roll', jl.peakT) }, posAt(jl.peakT));
        }
        // --- attitude: stopped following commands / tipped over ---
        let deviation = null, upset = null;
        for (let k = mlLowerBound(A.t, tAir0 + 3000), run = -1; k < A.t.length && A.t[k] < tStopScan; k++) {
            const dev = Math.max(Math.abs(A.Roll[k] - A.DesRoll[k]), Math.abs(A.Pitch[k] - A.DesPitch[k]));
            if (dev >= ML_INC.devDeg) { if (run < 0) run = k; if (!deviation && A.t[k] - A.t[run] >= 200) deviation = { t: A.t[run], dev, roll: A.Roll[k], pitch: A.Pitch[k] }; } else run = -1;
            if (!upset && Math.max(Math.abs(A.Roll[k]), Math.abs(A.Pitch[k])) >= ML_INC.upsetDeg) upset = { t: A.t[k], roll: A.Roll[k], pitch: A.Pitch[k], alt: at(P, 'Alt', A.t[k]) };
            if (deviation && upset) break;
        }
        // --- steady push along the body while almost stationary (towing / dragging something, or a damaged airframe) ---
        const slowMean = (tFrom, tTo) => {
            let sx = 0, sy = 0, n = 0, ms = 0;
            for (let k = mlLowerBound(G.t, tFrom); k < G.t.length - 1 && G.t[k] < tTo; k++) {
                if (G.Spd[k] >= ML_INC.slowMs) continue;
                const ia = mlLowerBound(I.t, G.t[k]), ib = mlLowerBound(I.t, G.t[k + 1]);
                for (let q = ia; q < ib; q++) { sx += I.AccX[q]; sy += I.AccY[q]; n++; }
                ms += G.t[k + 1] - G.t[k];
            }
            return n ? { g: Math.hypot(sx / n, sy / n) / ML_G, bx: sx / n / ML_G, by: sy / n / ML_G, s: ms / 1000 } : null;
        };
        const thrShare = (tFrom, tTo) => { if (!C || !C.t) return null; const a = mlLowerBound(C.t, tFrom), b = mlLowerBound(C.t, tTo); if (b - a < 5) return null; let hi = 0; for (let k = a; k < b; k++) if (C.ThO[k] >= 0.95) hi++; return { mean: mlMean(C.ThO, a, b), fullPct: 100 * hi / (b - a) }; };
        let drag = null;
        if (stop) {
            const tTo = Math.min(tStopScan, upset ? upset.t : Infinity);
            const after = slowMean(stop.to + 3000, tTo), before = slowMean(tAir0 + 5000, stop.from - 2000);
            if (after && after.s >= 10) drag = { from: stop.to + 3000, to: tTo, after, before: before && before.s >= 10 ? before : null, thrAfter: thrShare(stop.to + 3000, tTo), thrBefore: thrShare(tAir0 + 5000, stop.from - 2000), flagged: after.g >= ML_INC.dragG && (!before || before.s < 10 || after.g >= before.g + 0.08) };
        }
        // --- parachute: the autopilot's own release command (servo function 27) ---
        let chute = null;
        if (M.PARM && R && R.t) {
            for (let k = 0; k < M.PARM.Name.length && !chute; k++) {
                const m = /^SERVO(\d+)_FUNCTION$/.exec(M.PARM.Name[k]);
                if (!m || Math.round(M.PARM.Value[k]) !== 27) continue;
                const col = R['C' + m[1]];
                if (!col) { chute = { ch: +m[1], t: null, note: 'channel not logged' }; break; }
                chute = { ch: +m[1], t: null };
                for (let q = 1; q < col.length; q++) if (Math.abs(col[q] - col[0]) >= 300) { chute.t = R.t[q]; chute.from = col[0]; chute.toPwm = col[q]; break; }
            }
        }
        // --- motors: commanded near full, turning far slower than that motor managed earlier (ESC telemetry) ---
        const motors = [];
        if (escData && escData.present) {
            // healthy rpm per volt at full command, pooled over every motor for the whole flight
            const pool = [];
            for (const name of escData.names) { const s = escData.series[name]; for (let k = mlLowerBound(s.t, tAir0), b = mlLowerBound(s.t, tLog1); k < b; k++) if (s.throttle_out[k] >= ML_INC.motorFullPwm && s.throttle_out[k] <= 2100 && s.voltage[k] > 5) pool.push(s.rpm[k] / s.voltage[k]); }
            pool.sort((x, y) => x - y);
            const kRef = pool.length >= 20 ? pool[pool.length >> 1] : null;
            for (const name of (kRef ? escData.names : [])) {
                const s = escData.series[name], T = s.t, a = mlLowerBound(T, tAir0), b = mlLowerBound(T, tLog1);
                if (b - a < 50) continue;
                // weak = commanded full, turning under motorWeakFrac of what a healthy motor does at that battery voltage; stall = commanded above hover, barely turning
                let hit = null; const recent = [];
                for (let k = a; k < b && !hit; k++) {
                    const thr = s.throttle_out[k], v = s.voltage[k];
                    if (!(v > 5) || !(thr <= 2100) || s.rpm[k] !== s.rpm[k]) continue;
                    const kk = s.rpm[k] / v;
                    const kind = thr >= ML_INC.motorStallPwm && kk < ML_INC.motorStallFrac * kRef ? 'stall' : thr >= ML_INC.motorFullPwm && kk < ML_INC.motorWeakFrac * kRef ? 'weak' : null;
                    if (!kind) continue;
                    recent.push(k);
                    while (T[k] - T[recent[0]] > 2000) recent.shift();
                    if (recent.length >= 5) { const q = recent[0]; let sr = 0, sc = 0, sv = 0; for (const z of recent) { sr += s.rpm[z]; sc += s.current[z]; sv += s.voltage[z]; } hit = { esc: name, t: T[q], kind, rpm: sr / recent.length, cur: sc / recent.length, expect: kRef * sv / recent.length * (kind === 'weak' ? 1 : (s.throttle_out[q] - 1000) / 1000) }; }
                }
                if (hit) { hit.inAir = !impact || hit.t < impact.t; motors.push(hit); }
            }
            motors.sort((x, y) => x.t - y.t);
        }
        // --- the autopilot's own text messages ---
        const msgs = [];
        if (M.MSG && M.MSG.t) for (let k = 0; k < M.MSG.t.length; k++) if (M.MSG.t[k] >= tAir0) msgs.push({ t: M.MSG.t[k], text: M.MSG.Message[k], flag: /thrust loss|crash|ekf|failsafe|parachute|vibration|err|bad|lost|emergency|yaw imbalance|glitch|unhealthy/i.test(M.MSG.Message[k]) });
        // --- ordered findings ---
        const F = [];
        const mph = (ms) => Math.round(ms * 2.23694);
        const dir = (x, y) => Math.abs(x) >= Math.abs(y) ? (x < 0 ? 'from the front (pushing it backwards)' : 'from behind') : (y < 0 ? 'from the right side' : 'from the left side');
        if (stop) F.push({ t: stop.from, id: 'stop', level: 'red', title: 'Stopped by an outside force', text: `Went from ${mph(stop.spdBefore)} to ${mph(stop.spdAfter)} mph in ${stop.spdS.toFixed(1)} s while a force of ${stop.peakG.toFixed(1)} g hit it ${dir(stop.bx, stop.by)}. A drone that brakes on its own tilts back and pushes with its propellers, which shows almost no force along the body, so this push came from outside the drone.`, at: { lat: stop.lat, lon: stop.lon } });
        { const rest = jolts.filter(j => !stop || j.from !== stop.from);
            if (rest.length === 1) F.push({ t: rest[0].from, id: 'jolt', level: 'amber', title: 'Jolt', text: `A ${rest[0].peakG.toFixed(1)} g shove ${dir(rest[0].bx, rest[0].by)}.` });
            else if (rest.length) F.push({ t: rest[0].from, id: 'jolt', level: 'amber', title: `${rest.length} more jolts`, text: `Shoves of ${Math.min(...rest.map(j => j.peakG)).toFixed(1)}–${Math.max(...rest.map(j => j.peakG)).toFixed(1)} g kept coming until ${mlHms(new Date(rest[rest.length - 1].to))}.` }); }
        if (drag && drag.flagged) F.push({ t: drag.from, id: 'drag', level: 'red', title: 'Held back by something', text: `For the next ${Math.round(drag.after.s)} s it was almost stationary yet felt a steady ${drag.after.g.toFixed(2)} g push along its body${drag.before ? ` (earlier in this flight, when slow, it was ${drag.before.g.toFixed(2)} g)` : ''}${drag.thrAfter ? `, with the throttle at full ${Math.round(drag.thrAfter.fullPct)}% of the time${drag.thrBefore ? ` (before: ${Math.round(drag.thrBefore.fullPct)}%)` : ''}` : ''}. That is what towing or dragging something looks like; a healthy drone at that speed feels almost none.` });
        if (deviation) F.push({ t: deviation.t, id: 'deviation', level: 'amber', title: 'Stopped following its own commands', text: `Its tilt was ${Math.round(deviation.dev)}° away from what the autopilot asked for (roll ${Math.round(deviation.roll)}°, pitch ${Math.round(deviation.pitch)}°).` });
        if (upset) F.push({ t: upset.t, id: 'upset', level: 'red', title: 'Lost control', text: `Tipped past ${ML_INC.upsetDeg}° (roll ${Math.round(upset.roll)}°, pitch ${Math.round(upset.pitch)}°), at a height ${Math.round((upset.alt - alt0) * 3.28084)} ft above the takeoff point.` });
        for (const m of motors) F.push({ t: m.t, id: 'motor', level: m.inAir ? 'red' : 'm', title: `${m.esc} lost speed${m.inAir ? ' in the air' : ' (after the impact)'}`, text: `${m.kind === 'weak' ? 'Commanded at full' : 'Commanded well above hover'}, it turned ${Math.round(m.rpm)} rpm at ${Math.round(m.cur)} A; a healthy motor on this drone turns about ${Math.round(m.expect / 100) * 100} rpm there. A motor that draws current but cannot turn is jammed, fouled or damaged.` });
        if (impact) F.push({ t: impact.t, id: 'impact', level: 'red', title: 'Hard impact', text: `${impact.peakG.toFixed(1)} g${upset ? `, ${((impact.t - upset.t) / 1000).toFixed(0)} s after it lost control` : ''}.`, at: { lat: impact.lat, lon: impact.lon } });
        if (chute && chute.t != null) F.push({ t: chute.t, id: 'chute', level: 'amber', title: 'Autopilot commanded the parachute', text: `Release channel ${chute.ch} switched${impact ? (chute.t > impact.t ? ` ${((chute.t - impact.t) / 1000).toFixed(1)} s AFTER the hard impact — this command did not open a parachute in the air` : ` ${((impact.t - chute.t) / 1000).toFixed(1)} s before the hard impact`) : ''}. This is the command only; the log cannot see the canopy itself.` });
        { const groups = new Map();
            for (const m of msgs) {
                if (!m.flag || /alignment complete|origin set|is using|initiali[sz]ed/i.test(m.text)) continue;
                const key = m.text.replace(/[\d(): ]+$/, '').replace(/\(\d+\)/g, '').trim();
                const g = groups.get(key); if (g) { g.n++; g.last = m.t; } else groups.set(key, { key, t: m.t, last: m.t, n: 1, text: m.text });
            }
            for (const g of groups.values()) F.push({ t: g.t, id: 'msg', level: 'm', title: 'Autopilot message', text: g.n > 1 ? `“${g.key}” — ${g.n} times, the last at ${mlHms(new Date(g.last))}` : `“${g.text}”` }); }
        for (const s of (signals ? signals.signals : [])) if (s.t != null) F.push({ t: s.t, id: 'sig', level: 'm', title: 'Drone app', text: s.text });
        if (escData && escData.alerts) for (const al of escData.alerts) if (al.t != null && al.t >= tAir0) F.push({ t: al.t, id: 'escAlarm', level: 'm', title: 'Motor / ESC alarm raised', text: al.esc ? `${al.esc}, value ${al.value} > ${al.limit}` : 'see the Motors card' });
        for (const f of F) if (/^(stop|jolt|drag|deviation|upset|motor|impact|chute)$/.test(f.id)) f.pos = posAt(f.t);
        F.sort((x, y) => x.t - y.t);
        const physical = F.filter(f => /^(stop|jolt|drag|deviation|upset|motor|impact)$/.test(f.id) && f.level !== 'm');
        const first = physical[0] || null;
        const escAl = escData && escData.alerts && escData.alerts.find(al => al.t != null && al.t >= tAir0);
        const notes = [];
        if (first && escAl) notes.push(escAl.t > first.t ? `The motor / ESC alarm came ${Math.round((escAl.t - first.t) / 1000)} s AFTER the first abnormal moment, so it is a result of what happened, not the start of it.` : `The motor / ESC alarm came ${Math.round((first.t - escAl.t) / 1000)} s BEFORE the first physical sign, so the motors are where to look first.`);
        if (signals && signals.firstTrigger && first) notes.push(signals.firstTrigger.t < first.t ? `It had already left its plan ${Math.round((first.t - signals.firstTrigger.t) / 1000)} s earlier (${signals.firstTrigger.type.replace(/^edge\.notify\.drone_/, '').replace(/_/g, ' ')}); that is why it was heading home, not why it came down.` : '');
        if (!chute) notes.push('No parachute release channel is configured in this autopilot log, so a parachute command cannot be checked.');
        else if (chute.t == null) notes.push(`The autopilot never switched its parachute channel (${chute.ch}) in this log.`);
        // --- chart series: 30 s before the first abnormal moment → end ---
        const cFrom = Math.max(tAir0, (first ? first.t : (impact ? impact.t : tLog1)) - 30000), cTo = Math.min(tLog1, (impact ? impact.t : tLog1) + 8000);
        const cut = (S, cols) => { const a = mlLowerBound(S.t, cFrom), b = mlLowerBound(S.t, cTo); const o = { t: S.t.slice(a, b) }; for (const c of cols) o[c] = S[c].slice(a, b); return o; };
        const ia = mlLowerBound(I.t, cFrom), ib = mlLowerBound(I.t, cTo);
        const chart = { from: cFrom, to: cTo, gps: cut(G, ['Spd']), att: cut(A, ['Roll', 'Pitch']), thr: C && C.t ? cut(C, ['ThO']) : null, imu: { t: I.t.slice(ia, ib), bx: Array.from(bx.subarray(ia, ib)) } };
        // --- map: the whole flight thinned out + the chart window at full detail ---
        const pa = mlLowerBound(P.t, tAir0), stepN = Math.max(1, Math.ceil((P.t.length - pa) / 1500));
        const flight = []; for (let k = pa; k < P.t.length; k += stepN) flight.push([P.Lat[k], P.Lng[k]]);
        const wa = mlLowerBound(P.t, cFrom), wb = mlLowerBound(P.t, cTo);
        const track = { flight, t: P.t.slice(wa, wb), lat: P.Lat.slice(wa, wb), lon: P.Lng.slice(wa, wb), alt: P.Alt.slice(wa, wb) };
        return { ok: true, tAir0, tLog1, alt0, track, stop, jolts, drag, deviation, upset, impact, chute, motors, msgs, findings: F, first, notes: notes.filter(Boolean), chart, stats: { records: df.records, bad: df.bad, imuHz: Math.round(nI / ((I.t[nI - 1] - I.t[0]) / 1000)) } };
    }
    // Site setup as the drone had it for this flight (the archive's *_siteData.log.json): flight paths, FFZs, NFZs.
    function mlSiteGeometry(roles) {
        if (!roles.siteData) return null;
        const d = JSON.parse(mlText(roles.siteData.bytes));
        const ok = (p) => p && typeof p.lat === 'number' && typeof p.lon === 'number';
        const routes = [], ffz = [], nfz = [];
        for (const [name, pts] of Object.entries(d.routes || {})) {
            if (!Array.isArray(pts)) continue;
            const segs = [];
            pts.forEach((p, i) => { if (ok(p)) for (const a of (p.arcs || [])) { const q = pts[a[0]]; if (a[0] > i && ok(q)) segs.push([p.lat, p.lon, q.lat, q.lon]); } });
            if (segs.length) routes.push({ name, segs });
        }
        for (const [name, z] of Object.entries(d.free_zones || {})) {
            if (!z || typeof z !== 'object') continue;
            if (Array.isArray(z.coordinates)) { const ring = z.coordinates.filter(ok).map(p => [p.lat, p.lon]); if (ring.length >= 3) ffz.push({ name, ring }); }
            for (const [k, v] of Object.entries(z)) if (k !== 'coordinates' && Array.isArray(v)) { const ring = v.filter(ok).map(p => [p.lat, p.lon]); if (ring.length >= 3) nfz.push({ name: k, ring }); }
        }
        return { routes, ffz, nfz };
    }
    // ===================== end [AIM_ML_INCIDENT] =======================

    // Top-level: everything about one mission from its archives (+ optional server JSON).
    async function mlAnalyze(files, extra) {
        const roles = mlClassify(files);
        const meta = mlParseMeta(roles);
        const hint = meta.startDate ? { year: meta.startDate.getUTCFullYear() } : null;
        const syslogLines = roles.syslog ? mlText(roles.syslog.bytes).split('\n') : [];
        const events = mlExtractEvents(syslogLines, hint);
        const lte = mlExtractLte(syslogLines, hint);
        let droneTrack = mlParseDroneTrack(roles);
        if (extra && extra.positionsSummaries) {
            const sv = mlSummariesToTrack(extra.positionsSummaries);
            if (sv.length) { const seen = new Set(droneTrack.map(p => p.t)); droneTrack = droneTrack.concat(sv.filter(p => !seen.has(p.t))).sort((a, b) => a.t - b.t); }
        }
        // v0.94 — an error raised on the base before takeoff is not why the flight was cut short
        const tTakeoff = events.takeoff && events.takeoff.t ? events.takeoff.t.getTime() : null;
        const flightAborts = tTakeoff == null ? events.aborts : events.aborts.filter(e => e.t && e.t.getTime() >= tTakeoff);
        const abortEv = flightAborts.find(e => /droneErr_(?!gimbal|ai_)|safetyInit/.test(e.type)) || flightAborts.find(e => /droneErr|safetyInit/.test(e.type)) || flightAborts[0] || null;
        const daa = mlExtractDaa(roles, droneTrack, abortEv && abortEv.t ? abortEv.t.getTime() : null);
        const fromMs = events.takeoff && events.takeoff.t ? events.takeoff.t.getTime() - 60000 : null;
        const toMs = events.touchdown && events.touchdown.t ? events.touchdown.t.getTime() + 30000 : null;
        const warnings = mlExtractWarnings(syslogLines, hint, fromMs, toMs);
        // when in the flight did each LTE outage happen?
        const tTo = events.takeoff && events.takeoff.t ? events.takeoff.t.getTime() : null, tTd = events.touchdown && events.touchdown.t ? events.touchdown.t.getTime() : null;
        for (const w of lte.outages) w.phase = tTo == null ? '' : (w.to < tTo ? 'before takeoff' : (tTd != null && w.from > tTd) ? 'after landing' : 'in flight');
        lte.inFlightOutages = lte.outages.filter(w => w.phase === 'in flight');
        // v0.7 — WHERE was the drone for each outage / handover / worst sample?
        const at = (d) => { const p = d instanceof Date ? mlDroneAt(droneTrack, d.getTime()) : (typeof d === 'number' ? mlDroneAt(droneTrack, d) : null); return p ? { lat: p.lat, lon: p.lon, alt: p.alt } : null; };
        for (const w of lte.outages) w.at = at(w.from);
        for (const h of lte.handovers) h.at = at(h.t);
        if (lte.worstRsrp) lte.worstRsrp.at = at(lte.worstRsrp.t);
        // v0.9 — ESC telemetry + the drone's ratio alert
        let escData;
        try { escData = mlExtractEsc(files, roles); }
        catch (e) { escData = { present: false, error: true, note: 'ESC telemetry could not be parsed: ' + (e && e.message || e), alerts: [], actions: [], mainLogs: [] }; }
        const escAnalysis = escData.present ? mlEscAnalyze(escData, ML_ESC_RATIO_THR, ML_ESC_SAMP_THR) : null;
        let incident;
        try { incident = mlIncidentSignals(events, escData); }
        catch (e) { console.error(`${TAG} incident signals failed:`, e); incident = { show: false, strong: 0, signals: [], firstTrigger: null, error: String(e && e.message || e) }; }
        return { roles, files, meta, events, lte, daa, droneTrack, warnings, abortEv, flightAborts, incident, incidentDeep: null, esc: escData, escAnalysis, extra: extra || {}, syslogLineCount: syslogLines.length };
    }
    // ===================== end [AIM_ML_ENGINE] =========================

    // ------------------------------------------------------------------
    // Dashboard glue — resolve a mission id → archives → report panel.
    // ------------------------------------------------------------------
    const ui = { panel: null, status: null, body: null, busy: false };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB';
    const fmtDist = (m) => m == null ? '—' : (m >= 1609 ? `${(m / 1609.34).toFixed(2)} mi (${Math.round(m).toLocaleString()} m)` : `${mlFt(m).toLocaleString()} ft (${Math.round(m)} m)`);
    let wantDaa = true;
    // View mode: 'simple' (plain-English, default) | 'advanced' (full technical cards). Remembered per user.
    const MODE_KEY = 'aim-ml-view-mode';
    let viewMode = 'simple';
    try { if (typeof GM_getValue === 'function') { const v = GM_getValue(MODE_KEY, 'simple'); if (v === 'advanced' || v === 'simple') viewMode = v; } } catch (e) { console.warn(`${TAG} mode read failed`, e); }
    let lastResult = null;
    function setViewMode(mode) {
        viewMode = mode === 'advanced' ? 'advanced' : 'simple';
        try { if (typeof GM_setValue === 'function') GM_setValue(MODE_KEY, viewMode); } catch (e) { console.warn(`${TAG} mode save failed`, e); }
        const seg = document.getElementById('aim-ml-mode');
        if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.getAttribute('data-mode') === viewMode));
        if (lastResult) render(lastResult);
    }

    function setStatus(html, level) {
        if (!ui.status) return;
        ui.status.innerHTML = html;
        ui.status.style.color = level === 'red' ? '#ff5f5f' : level === 'amber' ? '#ffb347' : level === 'green' ? '#5fff5f' : '#aaa';
    }

    function ensureStyles() {
        if (document.getElementById('aim-ml-style')) return;
        const st = document.createElement('style');
        st.id = 'aim-ml-style';
        st.textContent = `
            #aim-ml-launch{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#0e1115;color:#7adfe6;border:1px solid #2a3240;border-radius:8px;padding:8px 12px;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5)}
            #aim-ml-launch:hover{border-color:#7adfe6}
            .aim-ml-row-btn{display:inline-block;margin-left:6px;padding:1px 6px;border:1px solid #2a3240;border-radius:4px;background:#0e1115;color:#7adfe6;font-size:11px;cursor:pointer;vertical-align:middle}
            .aim-ml-row-btn:hover{border-color:#7adfe6}
            #aim-ml-panel{position:fixed;top:60px;right:18px;width:min(900px,calc(100vw - 36px));max-height:calc(100vh - 80px);z-index:2147483001;background:#0e1115;color:#ddd;border:1px solid #2a3240;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.6);font:12px/1.45 system-ui,sans-serif;display:flex;flex-direction:column;overflow:hidden}
            #aim-ml-head{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#141922;border-bottom:1px solid #222834;cursor:move;user-select:none}
            #aim-ml-head b{color:#7adfe6;font-size:13px}
            #aim-ml-head input{width:110px;background:#0b0e12;color:#eee;border:1px solid #2a3240;border-radius:4px;padding:3px 6px;font:12px system-ui}
            #aim-ml-head button,.aim-ml-btn{background:#1b2230;color:#ddd;border:1px solid #2a3240;border-radius:4px;padding:3px 8px;cursor:pointer;font:12px system-ui}
            #aim-ml-head button:hover,.aim-ml-btn:hover{border-color:#7adfe6;color:#fff}
            #aim-ml-head button:disabled{opacity:.4;cursor:default;border-color:#2a3240;color:#ddd}
            .aim-ml-seg{display:inline-flex;border:1px solid #2a3240;border-radius:6px;overflow:hidden}
            .aim-ml-seg button{background:#0b0e12;color:#999;border:0;border-right:1px solid #2a3240;padding:3px 10px;cursor:pointer;font:12px system-ui}
            .aim-ml-seg button:last-child{border-right:0}
            .aim-ml-seg button.on{background:#1b2a33;color:#7adfe6;font-weight:700}
            .aim-ml-bottom{font-size:14px;font-weight:700;line-height:1.4;padding:8px 10px;border-radius:6px;margin-bottom:8px;border:1px solid #222834;background:rgba(255,255,255,.03)}
            .aim-ml-bottom.g{border-color:#224a22}.aim-ml-bottom.a{border-color:#4a3a1a}.aim-ml-bottom.r{border-color:#4a2222}
            .aim-ml-plain{margin:0;padding-left:18px;font-size:12.5px;line-height:1.55}
            .aim-ml-plain li{margin:2px 0}
            .aim-ml-plain b{color:#eee}
            .aim-ml-tech{margin-top:8px}
            .aim-ml-tech>summary{cursor:pointer;color:#7adfe6;font-size:11.5px;user-select:none}
            .aim-ml-tech>summary:hover{text-decoration:underline}
            .aim-ml-tech .aim-ml-card{margin-top:6px}
            #aim-ml-status{padding:6px 12px;border-bottom:1px solid #222834;color:#aaa;min-height:18px}
            #aim-ml-body{overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}
            .aim-ml-card{border:1px solid #222834;border-radius:8px;background:#11151b}
            .aim-ml-card>h4{margin:0;padding:6px 10px;border-bottom:1px solid #222834;color:#7adfe6;font-size:12px;display:flex;align-items:center;gap:8px}
            .aim-ml-card>h4 .sp{flex:1}
            .aim-ml-card>div{padding:8px 10px}
            .aim-ml-verdict{font-weight:700;font-size:13px;padding:6px 10px;border-radius:6px;margin-bottom:8px}
            .aim-ml-kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}
            .aim-ml-kv span:nth-child(odd){color:#888}
            table.aim-ml{width:100%;border-collapse:collapse;font-size:11.5px}
            table.aim-ml th{text-align:left;color:#888;font-weight:600;padding:3px 6px;border-bottom:1px solid #222834}
            table.aim-ml td{padding:3px 6px;border-top:1px solid rgba(255,255,255,.05);vertical-align:top}
            .g{color:#5fff5f}.a{color:#ffb347}.r{color:#ff5f5f}.m{color:#888}.c{color:#7adfe6}
            .aim-ml-tag{display:inline-block;padding:0 6px;border:1px solid currentColor;border-radius:9px;font-size:10.5px;font-weight:600;white-space:nowrap}
            .aim-ml-esc-ctl{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin:10px 0 4px;color:#888}
            .aim-ml-esc-ctl input,.aim-ml-esc-ctl select{background:#0b0e12;color:#eee;border:1px solid #2a3240;border-radius:4px;padding:2px 5px;font:12px system-ui}
            .aim-ml-esc-ctl input{width:62px}
            .aim-ml-esc-ro{position:sticky;top:-10px;z-index:1;background:#11151b;padding:5px 0;min-height:34px;font-size:11.5px;line-height:1.5;border-bottom:1px solid #222834}
            .aim-ml-esc-h{margin:8px 0 2px}
            canvas[data-aim-ml-esc-cv]{display:block;width:100%;height:230px;cursor:crosshair;touch-action:none;user-select:none}
            tr[data-aim-ml-esc-zoom]:hover td{background:rgba(122,223,230,.07)}
            .aim-ml-card.inc{border-color:#6a2a2a}
            .aim-ml-card.inc>h4{color:#ff7a7a;border-bottom-color:#4a2222}
            canvas[data-aim-ml-inc-cv]{display:block;width:100%;height:430px;cursor:crosshair}
            canvas[data-aim-ml-inc-map]{display:block;width:100%;height:440px;cursor:crosshair;border-radius:4px}
            .aim-ml-inc-h{margin:14px 0 4px;color:#7adfe6;font-weight:700;font-size:12px}
            .aim-ml-inc-leg{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;color:#aaa;font-size:11px}
            .aim-ml-inc-leg i{display:inline-block;width:16px;height:0;border-top:3px solid;vertical-align:middle;margin-right:5px}
            .aim-ml-inc-leg i.box{height:9px;border:1.5px solid;border-radius:2px}
            .aim-ml-inc-ro{min-height:18px;font-size:11.5px;margin:8px 0 2px}
            .aim-ml-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;color:#bbb}
        `;
        document.head.appendChild(st);
    }

    function ensurePanel() {
        ensureStyles();
        if (ui.panel) return ui.panel;
        const p = document.createElement('div');
        p.id = 'aim-ml-panel';
        p.innerHTML = `
            <div id="aim-ml-head"><b>🔎 AIM Mission Logs</b><span class="m">v${SCRIPT_VERSION}${IS_QA ? ' · QA' : ''}</span>
                <span id="aim-ml-mode" class="aim-ml-seg" title="Simple = plain English for pilots and customers · Advanced = every technical detail"><button data-mode="simple">Simple</button><button data-mode="advanced">Advanced</button></span>
                <span style="flex:1"></span>
                <label class="m">Mission ID <input id="aim-ml-id" type="text" inputmode="numeric" placeholder="237893"></label>
                <label class="m" title="Also fetch the DAA (ADS-B / radar) archive"><input id="aim-ml-daa" type="checkbox" checked> DAA</label>
                <button id="aim-ml-run">Analyze</button>
                <button id="aim-ml-zip" disabled title="Save this mission's app-log archive (.tar.gz) to your computer — the same file as “Get App Logs”">⬇ Logs</button>
                <button id="aim-ml-export" disabled title="Save this analysis as one HTML file you can open, send or print — no dashboard or login needed">⬇ Report</button>
                <button id="aim-ml-close" title="Close">✕</button>
            </div>
            <div id="aim-ml-status">Enter a mission ID (or click 🔎 on a table row) and press Analyze.</div>
            <div id="aim-ml-body"></div>`;
        document.body.appendChild(p);
        ui.panel = p; ui.status = p.querySelector('#aim-ml-status'); ui.body = p.querySelector('#aim-ml-body');
        p.querySelector('#aim-ml-close').addEventListener('click', () => { p.style.display = 'none'; });
        p.querySelector('#aim-ml-run').addEventListener('click', () => { const v = p.querySelector('#aim-ml-id').value.trim(); if (/^\d+$/.test(v)) analyzeMission(v); else setStatus('Mission ID must be a number.', 'red'); });
        p.querySelector('#aim-ml-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') p.querySelector('#aim-ml-run').click(); });
        p.querySelector('#aim-ml-zip').addEventListener('click', () => {
            try { downloadArchive(lastResult, 0); }
            catch (e) { console.error(`${TAG} archive download failed:`, e); setStatus(`Archive download failed: ${esc(e.message || e)}`, 'red'); }
        });
        p.querySelector('#aim-ml-export').addEventListener('click', () => {
            try { exportHtmlReport(); }
            catch (e) { console.error(`${TAG} HTML report failed:`, e); setStatus(`HTML report failed: ${esc(e.message || e)}`, 'red'); }
        });
        p.querySelector('#aim-ml-daa').addEventListener('change', (e) => { wantDaa = !!e.target.checked; });
        p.querySelectorAll('#aim-ml-mode button').forEach(b => b.addEventListener('click', () => setViewMode(b.getAttribute('data-mode'))));
        setViewMode(viewMode);
        // ESC charts size themselves from the canvas box — redraw when a <details> opens (toggle does not bubble → capture) or the window resizes
        ui.body.addEventListener('toggle', () => escRedrawAll(), true);
        let escResizeTimer = null;
        window.addEventListener('resize', () => { clearTimeout(escResizeTimer); escResizeTimer = setTimeout(() => { escRedrawAll(); incRedraw(); }, 150); });
        // drag
        const head = p.querySelector('#aim-ml-head');
        let drag = null;
        head.addEventListener('pointerdown', (e) => { if (e.target.closest('input,button,label')) return; drag = { x: e.clientX - p.offsetLeft, y: e.clientY - p.offsetTop }; head.setPointerCapture(e.pointerId); });
        head.addEventListener('pointermove', (e) => { if (!drag) return; p.style.left = Math.max(0, e.clientX - drag.x) + 'px'; p.style.top = Math.max(0, e.clientY - drag.y) + 'px'; p.style.right = 'auto'; });
        head.addEventListener('pointerup', () => { drag = null; });
        return p;
    }

    function openPanel(missionId) {
        const p = ensurePanel();
        p.style.display = 'flex';
        if (missionId) p.querySelector('#aim-ml-id').value = missionId;
        else { const guess = guessFilterMissionId(); if (guess && !p.querySelector('#aim-ml-id').value) p.querySelector('#aim-ml-id').value = guess; }
    }

    // Prefill order: (1) the dashboard's own mission filter box = the input right before the FILTER
    // button, (2) the only row's ID when the table shows exactly one mission. Never a random input.
    function guessFilterMissionId() {
        const pb = (location.hash || '').match(SITE_PB_RX);
        if (pb) return pb[1];                       // Mission Playback: the mission on screen
        if (!ON_DASH) return null;
        try {
            const filterBtn = Array.from(document.querySelectorAll('button, [role="button"], a')).find(b => /^\s*filter\s*$/i.test(b.textContent || '') && !b.closest('#aim-ml-panel'));
            if (filterBtn) {
                let scope = filterBtn.parentElement;
                for (let i = 0; i < 4 && scope; i++, scope = scope.parentElement) {
                    const inputs = Array.from(scope.querySelectorAll('input')).filter(x => x.compareDocumentPosition(filterBtn) & Node.DOCUMENT_POSITION_FOLLOWING);
                    const hit = inputs.reverse().find(x => /^\d{4,9}$/.test((x.value || '').trim()));
                    if (hit) return hit.value.trim();
                    if (inputs.length) break;
                }
            }
            const rows = findMissionRows();
            if (rows.length === 1) return rows[0].id;
        } catch (e) { console.warn(`${TAG} prefill guess failed`, e); }
        return null;
    }

    async function analyzeMission(missionId) {
        if (ui.busy) { setStatus('Already running — wait for the current analysis.', 'amber'); return; }
        ui.busy = true;
        ui.body.innerHTML = '';
        lastResult = null;
        setExportEnabled(false);
        const t0 = performance.now();
        try {
            setStatus(`Mission ${missionId}: asking Percepto for the app-log archive link…`);
            const extra = {};
            try { extra.mission = await mlGetJson(`/missions/${missionId}/`); } catch (e) { console.warn(`${TAG} /missions/${missionId}/ failed`, e); extra.missionError = String(e.message || e); }
            const appLink = await mlGetJson(`/missions/${missionId}/logs/new_app_log/`);
            if (!appLink || !appLink.download_link) throw new Error(`mission ${missionId}: no app-log archive on the server — new_app_log replied ${JSON.stringify(appLink).slice(0, 160)}`);
            setStatus(`Downloading app logs…`);
            const appBytes = await mlFetchBinary(appLink.download_link, (l, t) => setStatus(`Downloading app logs… ${fmtMB(l)}${t ? ' / ' + fmtMB(t) : ''}`));
            setStatus(`Unpacking app logs (${fmtMB(appBytes.length)} compressed)…`);
            const archName = (link, fallback) => { try { const b = decodeURIComponent(new URL(link, location.href).pathname.split('/').pop() || ''); return /\.(tar\.gz|tgz|zip)$/i.test(b) ? b : fallback; } catch (e) { console.warn(`${TAG} archive name not readable from its link:`, e); return fallback; } };
            const archives = [{ label: 'App logs', name: archName(appLink.download_link, `apps__${missionId}.tar.gz`), bytes: appBytes }];
            let files = mlUntar(await mlGunzip(appBytes));
            if (wantDaa) {
                try {
                    setStatus(`Asking for the DAA archive link…`);
                    const daaLink = await mlGetJson(`/missions/${missionId}/logs/daa_file/`);
                    if (daaLink && daaLink.download_link) {
                        const daaBytes = await mlFetchBinary(daaLink.download_link, (l, t) => setStatus(`Downloading DAA logs… ${fmtMB(l)}${t ? ' / ' + fmtMB(t) : ''}`));
                        files = files.concat(mlUntar(await mlGunzip(daaBytes)));
                        archives.push({ label: 'DAA logs', name: archName(daaLink.download_link, `daa__${missionId}.tar.gz`), bytes: daaBytes });
                    } else extra.daaNote = 'no DAA archive link for this mission';
                } catch (e) { console.warn(`${TAG} DAA archive skipped:`, e); extra.daaNote = 'DAA archive unavailable: ' + (e.message || e); }
            }
            // server waypoint summaries fill gaps in the on-board track (the abort position is one of them)
            try { extra.positionsSummaries = await mlGetJson(`/mission_positions_summaries/${missionId}/`, 15000); } catch (e) { console.warn(`${TAG} positions summaries skipped:`, e); }
            // optional same-origin DAA positions probe (shape unverified — surfaced raw)
            try { extra.daaPositions = await mlGetJson(`/mission_daa_positions/${missionId}/`, 15000); } catch (e) { extra.daaPositionsError = String(e.message || e); }
            setStatus(`Extracting from ${files.length} file(s)…`);
            await new Promise(r => setTimeout(r, 0));
            const res = await mlAnalyze(files, extra);
            res.missionId = missionId;
            res.archives = archives;
            escResetUi();
            render(res);
            const secs = ((performance.now() - t0) / 1000).toFixed(1);
            setStatus(`Mission ${missionId} · ${files.length} files · ${res.syslogLineCount.toLocaleString()} syslog lines · ${secs} s`, res.lte.verdict.level);
            console.log(`${TAG} analysis complete for ${missionId} in ${secs}s`, res);
            window.__aimMissionLogs = res;
        } catch (e) {
            console.error(`${TAG} analysis failed for ${missionId}:`, e);
            setStatus(`Failed: ${esc(e.message || e)}`, 'red');
        } finally { ui.busy = false; }
    }

    // ---------------- rendering ----------------
    function card(title, inner, actions) {
        return `<div class="aim-ml-card"><h4>${title}<span class="sp"></span>${actions || ''}</h4><div>${inner}</div></div>`;
    }
    const kv = (pairs) => `<div class="aim-ml-kv">${pairs.map(([k, v]) => `<span>${esc(k)}</span><span>${v}</span>`).join('')}</div>`;
    const tbl = (cols, rows) => `<table class="aim-ml"><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
    const lv = (level) => level === 'green' ? 'g' : level === 'amber' ? 'a' : level === 'red' ? 'r' : 'm';

    function render(res) {
        const { lte, events, daa, warnings, meta, extra } = res;
        const parts = [];
        const adv = {};
        const addCard = (key, html) => { adv[key] = html; parts.push(html); };
        lastResult = res;
        setExportEnabled(true);
        // --- v0.94: possible incident (both views, always first) ---
        let incHtml = '';
        try { incHtml = incCard(res); } catch (e) { console.error(`${TAG} incident card failed:`, e); incHtml = card('🚨 Possible incident', `<span class="r">This card could not be built: ${esc(e.message || e)}</span>`); }
        if (incHtml) parts.push(incHtml);
        // --- mission header ---
        const mj = meta.json || {}, m = extra.mission || {};
        const durS = m.duration != null ? Math.round(Number(m.duration) / 1000) : null;   // server duration is milliseconds (Fleet Tools convention)
        const dur = durS != null && isFinite(durS) ? `${Math.floor(durS / 60)}:${mlPad(durS % 60)}` : '—';
        addCard('mission', card(`🛸 Mission ${esc(res.missionId)} ${esc(m.app && m.app.name ? '· ' + m.app.name : '')}`, kv([
            ['Site', `${esc(mj.site_name || (m.site && m.site.name) || '—')} <span class="m">${esc(mj.site_status || '')}</span>`],
            ['Drone', `${esc(mj.vehicle_name || (m.drone && m.drone.name) || '—')} <span class="m">${esc(mj.app_version ? 'app ' + mj.app_version : '')}</span>`],
            ['Start (UTC)', `${esc(mj.start_time || m.when || '—')} <span class="m">· duration ${esc(dur)}</span>`],
            ['Pilot', esc(m.created_by && (m.created_by.full_name || m.created_by.username) || '—')],
            ['Events report', meta.events ? Object.entries(meta.events).map(([k, v]) => `<span class="${v ? 'a' : 'm'}">${esc(k)}=${esc(v)}</span>`).join(' · ') : '—'],
            ['Archive', `${res.files.length} files · ${res.files.map(f => `<span class="m" title="${esc(f.name)}">${esc(f.base)}</span>`).join(', ')}`],
        ])));
        // --- LTE ---
        const g = lte.gstatus;
        const rows = [];
        if (lte.handovers.length) rows.push(['Cell handovers', `${lte.handovers.length} — ${lte.handovers.slice(0, 12).map(h => `<span class="m">${mlHms(h.t)}</span> ${esc(h.from)}→${esc(h.to)}${pin(h.at)}`).join(' · ')}${lte.handovers.length > 12 ? ' …' : ''}`]);
        const lteInner = `
            <div class="aim-ml-verdict ${lv(lte.verdict.level)}" style="background:rgba(255,255,255,.03);border:1px solid #222834">${esc(lte.verdict.text)}</div>
            ${lte.formatWarning ? `<div class="a" style="margin:-4px 0 8px">⚠ ${esc(lte.formatWarning)}</div>` : ''}
            ${kv([
                ['Modem', lte.modem ? `${esc(lte.modem.make)} ${esc(lte.modem.model)} <span class="m">${esc(lte.modem.rev)}</span>` : '—'],
                ['SIM / APN', `${esc(lte.sim || '—')} / ${esc(lte.apn || '—')}`],
                ['Carrier', lte.carrier && lte.carrier.name ? `<b>${esc(lte.carrier.name)}</b> <span class="m">${esc(lte.carrier.how)}${lte.creg && lte.creg['0,5'] ? ' · roaming SIM' : ''}</span>` : `<span class="m">unknown — ${esc(lte.carrier ? lte.carrier.how : 'no band data')}</span>`],
                ['Link up', lte.tcp.firstOk ? `${mlHms(lte.tcp.firstOk)} UTC <span class="m">(first successful TCP check)</span>` : '<span class="r">never</span>'],
                ['TCP checks', `<span class="g">${lte.tcp.ok} ok</span> · <span class="${lte.tcp.fail ? 'r' : 'm'}">${lte.tcp.fail} failed</span>${lte.failsAfterUp.length ? ' — ' + lte.failsAfterUp.map(mlHms).join(', ') : ''}`],
                ['Ping tests', `${lte.pings.length} · <span class="${lte.lossyPings.length ? 'a' : 'm'}">${lte.lossyPings.length} with loss</span>${lte.lossyPings.length ? ' — ' + lte.lossyPings.slice(0, 8).map(p => `${mlHms(p.t)} ${p.loss}%`).join(', ') : ''}${lte.pings.filter(p => p.avg != null).length ? ` · avg rtt ${Math.round(lte.pings.filter(p => p.avg != null).reduce((s, p) => s + p.avg, 0) / lte.pings.filter(p => p.avg != null).length)} ms, worst max ${Math.round(Math.max(...lte.pings.map(p => p.max || 0)))} ms` : ''}`],
                ['Registration', Object.keys(lte.creg).length ? Object.entries(lte.creg).map(([k, v]) => `<span class="${/^0,[15]$/.test(k) ? 'g' : 'r'}">+CREG ${esc(k)} ×${v}</span>`).join(' · ') + ' <span class="m">(0,1 home · 0,5 roaming · other = lost)</span>' : '—'],
                ['DHCP (LTE iface)', lte.dhcp.length ? lte.dhcp.map(d => `<span class="${d.ev === 'bound' ? 'g' : 'a'}">${mlHms(d.t)} ${esc(d.iface)} ${esc(d.ev)}</span>`).join(' · ') : '—'],
                ['Modem resets', `<span class="${lte.resetCount > 1 ? 'r' : 'm'}">${lte.resetCount > 1 ? 'YES' : 'none'}</span> <span class="m">(Reset_Counter values seen: ${lte.resetCount})</span> · LTE manager starts: ${lte.managerRestarts}`],
                ['Bands / mode', `${esc(lte.bands.join(', ') || '—')} · ${esc(lte.modes.join(', ') || '—')}`],
                ['Outages', lte.outages.length ? lte.outages.map(w => `<span class="r">${mlHms(w.from)} → ${mlHms(w.to)}</span> <b>${w.s} s</b>${w.phase ? ` <span class="${w.phase === 'in flight' ? 'r' : 'a'}">${esc(w.phase)}</span>` : ''}${pin(w.at)} <span class="m">${esc(w.kind)}, ${w.samples} sample(s)${w.unresolved ? ', never recovered in the log' : ''}</span>`).join('<br>') : '<span class="g">none — no lost cell, failed TCP check, 100%-loss ping run, IP-lease loss or modem reconnect after link-up</span>'],
                ['Coverage', lte.coverage ? `median RSRP <b>${lte.coverage.median}</b> dBm · <span class="${lte.coverage.weakPct >= 50 ? 'r' : lte.coverage.weakPct >= 20 ? 'a' : 'g'}">${lte.coverage.weakPct}% of samples weak (≤ -100)</span> · <span class="${lte.coverage.veryWeakPct ? 'r' : 'm'}">${lte.coverage.veryWeakPct}% very weak (≤ -110)</span> · <span class="${lte.coverage.noCellPct ? 'r' : 'm'}">${lte.coverage.noCellPct}% no cell</span> <span class="m">(RSRP: > -90 good · -90…-100 fair · ≤ -100 weak · ≤ -110 edge of service)</span>` : '—'],
                ['Signal (worst)', g.length ? `RSRP ${lte.worstRsrp ? `<b>${lte.worstRsrp.rsrp}</b> dBm @ ${mlHms(lte.worstRsrp.t)}${pin(lte.worstRsrp.at)}` : '—'} · RSRQ ${lte.worstRsrq ? `<b>${lte.worstRsrq.rsrq}</b> dB @ ${mlHms(lte.worstRsrq.t)}` : '—'} · SINR ${lte.worstSinr ? `<b>${lte.worstSinr.sinr}</b> dB @ ${mlHms(lte.worstSinr.t)}` : '—'} <span class="m">(${g.length} samples)</span>` : '— (no GSTATUS samples)'],
                ['RTK stream', `${lte.rtcm.packets.toLocaleString()} RTCM packets · <span class="${lte.rtcm.gaps.length ? 'a' : 'g'}">${lte.rtcm.gaps.length} gap(s) > ${ML_RTCM_GAP_S} s</span>${lte.rtcm.gaps.length ? ' — ' + lte.rtcm.gaps.slice(0, 8).map(x => `${mlHms(x.from)}→${mlHms(x.to)} (${x.s} s)`).join(', ') : ''}`],
                ...rows,
            ])}
            ${g.length ? `<details style="margin-top:6px"><summary class="m" style="cursor:pointer">Signal samples (${g.length})</summary>${tbl(['UTC', 'Mode', 'Band', 'RSRP', 'RSRQ', 'SINR', 'Tx', '5G RSRP', '5G SINR', 'Cell', 'RRC'], g.map(s => [mlHms(s.t), esc(s.mode), esc(s.band), esc(s.rsrp), esc(s.rsrq), esc(s.sinr), esc(s.tx), esc(s.nrRsrp), esc(s.nrSinr), esc(s.cell), esc(s.rrc)]))}</details>` : ''}`;
        addCard('lte', card('📶 LTE link', lteInner, kmlBtn() + copyBtn('lte')));
        // --- Events ---
        const tl = events.timeline;
        const evInner = tl.length ? `
            ${events.aborts.length ? `<div class="aim-ml-verdict r" style="background:rgba(255,95,95,.08);border:1px solid #3a2222">${events.aborts.map(a => `${mlHms(a.t)} ${esc(a.type.replace('edge.notify.', '').replace(/_/g, ' '))}`).join(' · ')}</div>` : '<div class="aim-ml-verdict g" style="background:rgba(95,255,95,.05);border:1px solid #223a22">No abort / safety event</div>'}
            ${tbl(['UTC', 'Event', 'Detail'], tl.map(e => [`<span class="m">${mlHms(e.t)}</span>`, `<span class="${/droneErr|safetyInit|emergency|failsafe/i.test(e.type) ? 'r' : /warn/i.test(e.type) ? 'a' : /stageUpdate/.test(e.type) ? 'm' : 'c'}">${esc(e.type.replace(/^edge\.(notify\.)?/, ''))}</span>`, esc(e.label)]))}` : '<span class="m">no Amplitude mission events found in syslog</span>';
        addCard('events', card(`🧭 Mission events (${tl.length})`, evInner, copyBtn('events')));
        // --- ESC ---
        addCard('esc', escCardAdv(res));
        // --- DAA ---
        let daaInner;
        if (daa.aircraft.length) {
            daaInner = `<div class="m" style="margin-bottom:6px">${esc(daa.source || '')} · ${daa.notes.map(esc).join(' · ')}${daa.radarTracks ? ` · ${daa.radarTracks} radar-service track publications` : ''}${res.abortEv ? ` · abort at <b>${mlHms(res.abortEv.t)}</b>` : ''}</div>` +
                tbl(['Aircraft', 'Type · squawk', 'Seen (UTC)', 'Altitude MSL', 'Max speed', 'Closest to drone', res.abortEv ? 'At abort' : ''], daa.aircraft.map(a => [
                    `<b>${esc(a.callsign || '—')}</b> <span class="m">${esc(a.icao)}${a.nNumber && a.nNumber !== a.callsign ? ' → ' + esc(a.nNumber) : ''}</span>`,
                    `${esc(a.emitter)} <span class="m">${a.squawks.map(esc).join('/')}</span>`,
                    `${mlHms(new Date(a.first))}–${mlHms(new Date(a.last))} <span class="m">(${a.n})</span>`,
                    `${mlFt(a.altMinM).toLocaleString()}–${mlFt(a.altMaxM).toLocaleString()} ft`,
                    a.spdMaxMs ? `${Math.round(a.spdMaxMs * 1.944)} kt` : '—',
                    a.closest ? `<span class="${a.closest.dist < 1852 ? 'r' : a.closest.dist < 5556 ? 'a' : 'g'}">${fmtDist(a.closest.dist)}</span> <span class="m">@ ${mlHms(new Date(a.closest.t))}, ${mlFt(a.closest.acAltM)} ft vs drone ${mlFt(a.closest.droneAltM)} ft</span>` : '<span class="m">no overlap with drone track</span>',
                    res.abortEv ? (a.atAbort ? `${fmtDist(a.atAbort.dist)} <span class="m">· ${mlFt(a.atAbort.acAltM)} ft</span>` : '<span class="m">—</span>') : '',
                ]));
        } else daaInner = `<span class="m">${esc(extra.daaNote || (res.roles.pingstation ? 'no aircraft positions in the ADS-B feed' : 'DAA archive not fetched'))}</span>`;
        if (extra.daaPositions) {
            const dp = extra.daaPositions; const n = Array.isArray(dp) ? dp.length : (dp && typeof dp === 'object' ? Object.keys(dp).length : 0);
            const sample = Array.isArray(dp) && dp.length ? dp[0] : dp;
            daaInner += `<details style="margin-top:8px"><summary class="m" style="cursor:pointer">Server /mission_daa_positions/ (${n} ${Array.isArray(dp) ? 'rows' : 'keys'}) — shape probe</summary><div class="aim-ml-mono">${esc(JSON.stringify(sample, null, 1).slice(0, 2500))}</div></details>`;
        } else if (extra.daaPositionsError) daaInner += `<div class="m" style="margin-top:6px">/mission_daa_positions/: ${esc(extra.daaPositionsError)}</div>`;
        addCard('daa', card(`✈ DAA — aircraft near the flight (${daa.aircraft.length})`, daaInner, copyBtn('daa')));
        // --- Warnings ---
        const wInner = warnings.length ? tbl(['Process', 'Count', 'First', 'Samples'], warnings.map(w => [esc(w.proc), String(w.n), `<span class="m">${mlHms(w.first)}</span>`, w.samples.map(s => `<div><span class="m">${mlHms(s.t)}</span> ${esc(s.msg)}</div>`).join('')])) : '<span class="g">nothing flagged in the flight window</span>';
        addCard('warnings', card(`⚠ Warnings / errors in the flight window (${warnings.reduce((s, w) => s + w.n, 0)})`, wInner, copyBtn('warnings')));
        // --- raw files ---
        const dl = Object.entries(res.roles).filter(([k, f]) => f && !/ardupilot/.test(k)).map(([k, f]) => `<button class="aim-ml-btn" data-aim-ml-dl="${esc(f.name)}" title="${esc(f.name)}">⬇ ${esc(k)} <span class="m">${fmtMB(f.bytes.length)}</span></button>`).join(' ');
        const arch = (res.archives || []).map((a, i) => `<button class="aim-ml-btn" data-aim-ml-arch="${i}" title="${esc(a.name)}">⬇ ${esc(a.label)} archive <span class="m">${fmtMB(a.bytes.length)}</span></button>`).join(' ');
        addCard('files', card('🗂 Files', `${arch ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${arch}</div>` : ''}<div style="display:flex;flex-wrap:wrap;gap:6px">${dl}</div><div class="m" style="margin-top:6px">Full result object: <code>window.__aimMissionLogs</code> in the console.</div>`));
        ui.body.innerHTML = viewMode === 'advanced' ? parts.join('') : incHtml + renderSimple(res, adv);
        try { escWire(res); } catch (e) { console.error(`${TAG} ESC card wiring failed:`, e); }
        try { incWire(res); } catch (e) { console.error(`${TAG} incident card wiring failed:`, e); }
        ui.body.querySelectorAll('[data-aim-ml-arch]').forEach(b => b.addEventListener('click', () => {
            try { downloadArchive(res, +b.getAttribute('data-aim-ml-arch')); } catch (e) { console.error(`${TAG} archive download failed:`, e); setStatus(`Archive download failed: ${esc(e.message || e)}`, 'red'); }
        }));
        ui.body.querySelectorAll('[data-aim-ml-dl]').forEach(b => b.addEventListener('click', () => {
            const f = res.files.find(x => x.name === b.getAttribute('data-aim-ml-dl')); if (!f) return;
            const blob = new Blob([f.bytes], { type: 'application/octet-stream' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.base; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }));
        ui.body.querySelectorAll('[data-aim-ml-copy]').forEach(b => b.addEventListener('click', () => copySection(res, b.getAttribute('data-aim-ml-copy'), b)));
        ui.body.querySelectorAll('[data-aim-ml-ll]').forEach(b => b.addEventListener('click', async () => {
            const ll = b.getAttribute('data-aim-ml-ll');
            try { await navigator.clipboard.writeText(ll); const old = b.textContent; b.textContent = '✓ copied'; setTimeout(() => { b.textContent = old; }, 1500); }
            catch (e) { console.warn(`${TAG} copy failed`, e); window.prompt('Coordinates (copy):', ll); }
        }));
        ui.body.querySelectorAll('[data-aim-ml-kml]').forEach(b => b.addEventListener('click', () => {
            try { downloadSignalKml(res); } catch (e) { console.warn(`${TAG} signal KML failed`, e); setStatus('Signal KML failed — see console'); }
        }));
    }
    // v0.7 — 📍 coordinate chip: click copies "lat,lng" (Map Nav 🧭 / Google Maps paste).
    const pin = (at) => at ? ` <span class="c" data-aim-ml-ll="${at.lat.toFixed(6)},${at.lon.toFixed(6)}" title="Drone position at that moment — click to copy lat,lng (paste into Map Nav 🧭)" style="cursor:pointer">📍 ${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}</span>` : '';
    const kmlBtn = () => `<button class="aim-ml-btn" data-aim-ml-kml="signal" title="KML of the flown track with every signal sample colored good → weak, plus outage and tower-switch pins — open in Google Earth or Fleet Tools → KML Layers">📍 Signal KML</button>`;
    // Same words as the LTE card: > -90 good · -90…-100 fair · ≤ -100 weak · ≤ -110 edge. KML colors are aabbggrr.
    const ML_SIG_STYLES = [
        { id: 'good', min: -90, word: 'Good', kml: 'ff76e600' },
        { id: 'fair', min: -100, word: 'Fair', kml: 'ff00eaff' },
        { id: 'weak', min: -110, word: 'Weak', kml: 'ff00a0ff' },
        { id: 'edge', min: -Infinity, word: 'Edge', kml: 'ff0000d5' },
    ];
    const mlSigStyle = (rsrp) => { if (typeof rsrp !== 'number') return { id: 'none', word: 'No signal', kml: 'ff7a6e54' }; for (const s of ML_SIG_STYLES) { if (rsrp > s.min) return s; } return ML_SIG_STYLES[ML_SIG_STYLES.length - 1]; };
    function downloadSignalKml(res) {
        const { lte, droneTrack } = res;
        const x = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const styles = ML_SIG_STYLES.concat([{ id: 'none', kml: 'ff7a6e54' }]).map(s => `<Style id="sig-${s.id}"><IconStyle><scale>0.6</scale><color>${s.kml}</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style>`).join('')
            + '<Style id="outage"><IconStyle><scale>1.2</scale><color>ff2020ff</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/forbidden.png</href></Icon></IconStyle></Style>'
            + '<Style id="handover"><IconStyle><scale>0.7</scale><color>ffffffff</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/triangle.png</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style>'
            + '<Style id="track"><LineStyle><color>80ffffff</color><width>2</width></LineStyle></Style>';
        // Track altitude is metres above sea level (collision.log Alt / summaries altitude_asl — the DAA
        // card already compares it with aircraft MSL), so KML uses absolute + extrude (a drop line to the ground).
        const altM = (a) => (a && typeof a.alt === 'number' && isFinite(a.alt) && a.alt > 0) ? a.alt.toFixed(1) : '0';
        const pm = (name, style, at, desc, when) => at ? `<Placemark><name>${x(name)}</name><styleUrl>#${style}</styleUrl>${when ? `<TimeStamp><when>${when.toISOString()}</when></TimeStamp>` : ''}${desc ? `<description>${x(desc)}</description>` : ''}<Point><extrude>1</extrude><altitudeMode>absolute</altitudeMode><coordinates>${at.lon.toFixed(7)},${at.lat.toFixed(7)},${altM(at)}</coordinates></Point></Placemark>` : '';
        const samples = [], seen = new Set();
        let placed = 0;
        lte.gstatus.forEach(s => {
            const p = mlDroneAt(droneTrack, s.t.getTime());
            if (!p) return;
            placed++;
            const st = mlSigStyle(s.rsrp);
            samples.push(pm(`${st.word} ${typeof s.rsrp === 'number' ? s.rsrp + ' dBm' : ''} ${mlHms(s.t)}`, `sig-${st.id}`, p,
                `RSRP ${s.rsrp ?? '—'} dBm · RSRQ ${s.rsrq ?? '—'} dB · SINR ${s.sinr ?? '—'} dB · band ${s.band ?? '—'} · mode ${s.mode ?? '—'} · cell ${s.cell || '—'} · ${Math.round((p.alt || 0) * 3.28084)} ft MSL`, s.t));
        });
        const outages = lte.outages.map(w => pm(`Outage ${w.s} s · ${mlHms(w.from)}`, 'outage', w.at, `${w.kind} · ${w.phase || ''} · ${mlHms(w.from)} → ${mlHms(w.to)} UTC`, w.from)).join('');
        const handovers = lte.handovers.map(h => pm(`Tower switch ${h.from}→${h.to} · ${mlHms(h.t)}`, 'handover', h.at, `cell ${h.from} → ${h.to} · band ${h.band ?? '—'} · RSRQ ${h.rsrq ?? '—'} · SINR ${h.sinr ?? '—'}`, h.t)).join('');
        const line = droneTrack.length ? `<Placemark><name>Flown track</name><styleUrl>#track</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>${droneTrack.filter((p, i) => i % 5 === 0).map(p => `${p.lon.toFixed(7)},${p.lat.toFixed(7)},${altM(p)}`).join(' ')}</coordinates></LineString></Placemark>` : '';
        const name = `Mission ${res.missionId} — LTE signal${lte.carrier && lte.carrier.name ? ` (${lte.carrier.name})` : ''}`;
        const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(name)}</name><description>${x(lte.verdict.text)} · ${placed} of ${lte.gstatus.length} signal samples placed on the flown track · Good &gt; -90 dBm · Fair -90…-100 · Weak ≤ -100 · Edge ≤ -110 · generated by AIM Mission Logs v${SCRIPT_VERSION}</description>${styles}`
            + `<Folder><name>Signal samples (${placed})</name>${samples.join('')}</Folder>`
            + `<Folder><name>Outages (${lte.outages.length})</name>${outages}</Folder>`
            + `<Folder><name>Tower switches (${lte.handovers.length})</name>${handovers}</Folder>`
            + line + '</Document></kml>';
        const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mission-${res.missionId}-lte-signal.kml`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        setStatus(`Signal KML: ${placed} samples, ${lte.outages.filter(w => w.at).length} outage pin(s), ${lte.handovers.filter(h => h.at).length} tower switch pin(s)${placed < lte.gstatus.length ? ` · ${lte.gstatus.length - placed} sample(s) had no position (before takeoff / after landing)` : ''}`);
    }

    // ---------------- ⚙ Motors / ESC card (v0.9) ----------------
    // Verdict + stretch table + interactive charts (vanilla canvas, no library). Both the
    // Advanced card and the Simple card's "Technical details" hold the same markup; every
    // region is addressed by data-aim-ml-esc* so a threshold change refreshes it in place.
    const ESC_METRICS = [['critical_current_rpm_ratio', 'current / rpm ratio'], ['rpm', 'rpm'], ['current', 'current (A)'], ['throttle_in', 'throttle in'], ['throttle_out', 'throttle out'], ['voltage', 'voltage (V)'], ['mosfet_temp', 'MOSFET temp (°C)'], ['capacitor_temp', 'capacitor temp (°C)']];
    const ESC_MAX_ROWS = 60;
    const escUi = { ratioThr: ML_ESC_RATIO_THR, sampThr: ML_ESC_SAMP_THR, metric: 'critical_current_rpm_ratio', win: 'run', view: null, hoverT: null, sel: null, raf: 0 };
    const escT = (ms) => ms == null ? '—' : mlHms(new Date(ms));
    const escNum = (v, d) => v == null || !isFinite(v) ? '—' : Number(v).toFixed(d);
    const escMetricLabel = () => (ESC_METRICS.find(m => m[0] === escUi.metric) || ESC_METRICS[0])[1];
    const escTag = (text, cls) => `<span class="aim-ml-tag ${cls}">${esc(text)}</span>`;
    function escResetUi() { escUi.ratioThr = ML_ESC_RATIO_THR; escUi.sampThr = ML_ESC_SAMP_THR; escUi.view = null; escUi.hoverT = null; escUi.sel = null; escUi.win = 'run'; }

    function escVerdictHtml(res) {
        const e = res.esc, an = res.escAnalysis, v = an.verdict;
        const lines = e.alerts.map(a => `<div><span class="r">${escT(a.t)} UTC</span> ${a.esc ? `<b>${esc(a.esc)}</b> ratio alert, value ${esc(a.value)} &gt; ${esc(a.limit)}` : esc(a.line)} <span class="m">${esc(a.file)}</span></div>`)
            .concat(e.actions.map(a => `<div><span class="a">${escT(a.t)} UTC</span> ${esc(a.text)}</div>`));
        return `<div class="aim-ml-verdict ${lv(v.level)}" style="background:rgba(255,255,255,.03);border:1px solid #222834">${esc(v.text)}</div>
            ${e.formatWarning ? `<div class="a" style="margin:-4px 0 8px">⚠ ${esc(e.formatWarning)}</div>` : ''}
            ${lines.length ? `<div style="margin:-2px 0 8px">${lines.join('')}</div>` : (e.mainLogs.length ? '' : '<div class="a" style="margin:-4px 0 8px">⚠ No main drone log in the archive — cannot tell whether the drone alerted.</div>')}
            <div class="m" style="margin-bottom:6px">Rule: a stretch above the ratio threshold counts as <b>low sampling</b> when that ESC logged fewer than ${esc(an.sampThr)} readings in any clock second of it, or the agent's own msg_in_sec fell below ${esc(an.sampThr)}. With a drone alert, only the alerted ESC's stretches in the ${ML_ESC_ALERT_LOOKBACK_S} s before the alert are judged: all low sampling = false positive, any normal = real.</div>`;
    }

    function escStretchesHtml(res) {
        const an = res.escAnalysis, alerted = new Set(an.alertEscs);
        if (!an.stretches.length) return `<span class="g">No ESC went above ${esc(an.ratioThr)}.</span>`;
        const sorted = an.stretches.slice().sort((x, y) => (y.judged ? 1 : 0) - (x.judged ? 1 : 0) || x.from - y.from);
        const rows = sorted.slice(0, ESC_MAX_ROWS).map(x => `<tr data-aim-ml-esc-zoom="${x.from},${x.to}" style="cursor:pointer" title="Click to zoom the charts to this stretch">
            <td><b>${esc(x.esc)}</b>${alerted.has(x.esc) ? ' ' + escTag('alerted', 'r') : ''}${x.judged && alerted.size ? ' ' + escTag('judged', 'c') : ''}</td>
            <td>${escT(x.from)}</td><td>${escT(x.to)}</td><td>${escNum(x.s, 1)} s</td>
            <td>${escNum(x.peak, 3)} <span class="m">@ ${escT(x.peakT)}</span></td>
            <td class="${x.minPerSec < an.sampThr ? 'a' : ''}">${esc(x.minPerSec)}</td>
            <td>${x.secsBelow} of ${x.secsTotal}</td>
            <td class="${x.minMsg != null && x.minMsg < an.sampThr ? 'a' : ''}">${escNum(x.minMsg, 2)}</td>
            <td>${x.low ? escTag('Low sampling', 'a') : escTag('Normal sampling', 'g')}</td></tr>`).join('');
        return `<table class="aim-ml"><tr>${['ESC', 'Start UTC', 'End', 'Duration', 'Peak ratio', 'Min samples/s', 'Seconds below', 'Min msg_in_sec', 'Sampling'].map(c => `<th>${c}</th>`).join('')}</tr>${rows}</table>
            ${sorted.length > ESC_MAX_ROWS ? `<div class="m">+${sorted.length - ESC_MAX_ROWS} more stretch(es)<span data-aim-ml-live> — 📋 Sheets copies all of them</span>.</div>` : ''}`;
    }

    function escStatsHtml(res) {
        return tbl(['ESC', 'Throttle in / out (avg)', 'rpm avg / max', 'Current avg / max (A)', 'Min voltage', 'Max MOSFET °C', 'Max capacitor °C', 'Max ratio', '% of run above', 'Non-zero status'],
            res.escAnalysis.stats.map(s => s.n ? [`<b>${esc(s.esc)}</b>`, `${escNum(s.thrIn, 0)} / ${escNum(s.thrOut, 0)}`, `${escNum(s.rpmAvg, 0)} / ${escNum(s.rpmMax, 0)}`, `${escNum(s.curAvg, 1)} / ${escNum(s.curMax, 1)}`, escNum(s.voltMin, 1), escNum(s.mosMax, 1), escNum(s.capMax, 1), `<span class="${s.ratioMax > res.escAnalysis.ratioThr ? 'a' : ''}">${escNum(s.ratioMax, 3)}</span>`, `${escNum(s.overPct, 2)}%`, `<span class="${s.statusNonZero ? 'a' : 'm'}">${s.statusNonZero}</span>`]
                : [`<b>${esc(s.esc)}</b>`, '<span class="m">no samples while motors ran</span>', '', '', '', '', '', '', '', '']));
    }

    function escCardAdv(res) {
        const e = res.esc;
        if (!e || !e.present) return card('⚙ Motors / ESC telemetry', `<span class="${e && e.error ? 'r' : 'm'}">${esc(e ? e.note : 'not analyzed')}</span>${e && e.alerts && e.alerts.length ? `<div class="r" style="margin-top:6px">The drone log has ${e.alerts.length} ESC ratio alert(s): ${e.alerts.map(a => `${escT(a.t)} ${esc(a.esc || '?')}`).join(', ')} — but there is no ESC log to judge them.</div>` : ''}`);
        return card(`⚙ Motors / ESC telemetry (${e.names.length} ESCs${e.powerTrain ? ' · ' + esc(e.powerTrain) : ''})`, `
            <div data-aim-ml-esc="verdict"></div>
            <div data-aim-ml-esc="stretches"></div>
            <details style="margin-top:6px"><summary class="m" style="cursor:pointer">Per-ESC stats while motors running</summary><div data-aim-ml-esc="stats"></div></details>
            <div class="aim-ml-esc-ctl">
                <label>Ratio above <input type="number" step="0.05" min="0" data-aim-ml-esc-ctl="ratio"></label>
                <label>Sampling below (/s) <input type="number" step="0.5" min="0" data-aim-ml-esc-ctl="samp"></label>
                <label>Top chart <select data-aim-ml-esc-ctl="metric">${ESC_METRICS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
                <span class="aim-ml-seg"><button data-aim-ml-esc-win="run" title="Zoom to first → last sample with rpm above 0">Motor run</button><button data-aim-ml-esc-win="full">Full log</button></span>
            </div>
            <div data-aim-ml-esc="readout" class="aim-ml-esc-ro"></div>
            ${e.names.map(n => `<div class="aim-ml-esc-h"><b>${esc(n)}</b> <span data-aim-ml-esc-tag="${esc(n)}"></span></div><canvas data-aim-ml-esc-cv="${esc(n)}"></canvas>`).join('')}
            <div class="m" style="margin-top:6px">Top: one dot per reading (no connecting line, so gaps show) · red dots / red band = above the ratio threshold · grey band = motors running. Bottom: grey dots = readings counted per second · green line = msg_in_sec · dashed orange = sampling threshold. Red vertical line = the drone's alert (solid on the ESC that alerted). Times are the log's own clock (UTC). Source: ${esc(e.file)}${e.otherFiles.length ? ` <span class="a">(+${e.otherFiles.length} other ESC log(s) in the archive not shown: ${esc(e.otherFiles.join(', '))})</span>` : ''}.</div>`, copyBtn('esc'));
    }

    // Plain-English bottom line + bullets (Simple view).
    function escSimpleInner(res) {
        const e = res.esc, an = res.escAnalysis, v = an.verdict, a0 = e.alerts[0];
        const when = a0 ? `at <b>${escT(a0.t)} UTC</b>` : '';
        const home = e.actions.length ? ' and turned back for home' : '';
        const who = an.alertEscs.join(', ') || 'a motor controller';
        const bullets = [];
        let bottom;
        const rate = (x) => `${x.esc} was above the alarm level from ${escT(x.from)} to ${escT(x.to)} (${escNum(x.s, 1)} s, peak ${escNum(x.peak, 2)}); in its slowest second it logged <b>${x.minPerSec}</b> reading${x.minPerSec === 1 ? '' : 's'}${x.minMsg != null ? `, and the controller software reported ${escNum(x.minMsg, 1)} per second` : ''} (normal is ${an.sampThr} or more)`;
        if (v.code === 'false') {
            bottom = `The drone raised a <b>motor / ESC alarm</b> ${when}${home}, but the logs point to a <b>false alarm</b>. The motor-controller readings were arriving too slowly at that moment, and that throws off the number the alarm is based on.`;
            for (const x of an.judged.slice(0, 3)) bullets.push(rate(x) + '.');
            bullets.push(`<b>What to do:</b> no sign of a real motor problem in this log. If the same alarm repeats on this drone, send the mission ID to support. This check cannot say why the readings slowed down.`);
        } else if (v.code === 'real') {
            bottom = `The drone raised a <b>motor / ESC alarm</b> ${when}${home}, and the readings behind it look <b>genuine</b>. Treat it as a real motor or motor-controller problem on <b>${esc(who)}</b>.`;
            for (const x of an.judged.filter(y => !y.low).slice(0, 3)) bullets.push(rate(x) + ' — a normal reading rate, so the number can be trusted.');
            bullets.push(`<b>What to do:</b> have the drone inspected before it flies again, and send this mission ID to support.`);
        } else if (v.code === 'check') {
            bottom = `The drone raised a <b>motor / ESC alarm</b> ${when}${home}, but the motor-controller log does not show ${esc(who)} over the alarm level around that time. <b>Needs a manual look.</b>`;
            bullets.push(`The log may have stopped before the alarm, or the alarm came from a value that was never written to this log.`);
        } else if (v.code === 'none') {
            bottom = `<b>No motor or ESC alarm</b> on this flight, and no motor controller reached the alarm level.`;
        } else if (v.code === 'quiet') {
            const longest = an.stretches.reduce((m, x) => (x.s > m.s ? x : m));
            bottom = `<b>No motor or ESC alarm</b> on this flight.`;
            bullets.push(`The motor load number briefly went over the alarm level ${an.stretches.length} time${an.stretches.length === 1 ? '' : 's'} (longest ${escNum(longest.s, 1)} s at ${escT(longest.from)}) without the drone raising an alarm. A few seconds of this at takeoff is normal.`);
        } else {
            bottom = `The motor-controller log shows the motor load number over the alarm level, but the main drone log is missing from this archive, so <b>it is unknown whether the drone raised an alarm</b>.`;
            bullets.push(v.code === 'nolog-false' ? `Every time it was over the level, the readings were arriving too slowly to trust — an alarm here would be a false alarm.` : `At least once it was over the level with a normal reading rate — an alarm here would be genuine.`);
        }
        const st = an.stats.filter(s => s.n);
        if (st.length) {
            const hot = st.reduce((m, s) => (s.mosMax > m.mosMax ? s : m)), amp = st.reduce((m, s) => (s.curMax > m.curMax ? s : m)), vmin = Math.min(...st.map(s => s.voltMin));
            bullets.push(`<b>In flight:</b> hottest motor controller ${esc(hot.esc)} at ${escNum(hot.mosMax, 0)} °C, highest current ${escNum(amp.curMax, 0)} A on ${esc(amp.esc)}, lowest battery voltage ${escNum(vmin, 1)} V.`);
            const bad = st.filter(s => s.statusNonZero);
            if (bad.length) bullets.push(`<b>Status codes:</b> ${bad.map(s => `${esc(s.esc)} reported a non-zero status ${s.statusNonZero} time${s.statusNonZero === 1 ? '' : 's'}`).join('; ')}.`);
        }
        if (e.formatWarning) bullets.push(`⚠ ${esc(e.formatWarning)}`);
        return `<div class="aim-ml-bottom ${lv(v.level)}">${bottom}</div>${bullets.length ? `<ul class="aim-ml-plain">${bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : ''}`;
    }
    function escCardSimple(res, adv) {
        const e = res.esc;
        if (!e || !e.present) return card('⚙ Motors (ESC)', `<div class="aim-ml-bottom ${e && (e.error || (e.alerts && e.alerts.length)) ? 'r' : 'm'}">${e && e.alerts && e.alerts.length ? `The drone raised a <b>motor / ESC alarm</b> at ${escT(e.alerts[0].t)} UTC, but the motor-controller log is not in this archive, so it cannot be checked here.` : `No motor-controller log to check for this flight (${esc(e ? e.note : 'not analyzed')}).`}</div>`);
        return card('⚙ Motors (ESC)', `<div data-aim-ml-esc="simple"></div>${tech('esc', adv)}`, copyBtn('esc'));
    }

    function escView(res) {
        if (escUi.view) return escUi.view;
        const e = res.esc;
        if (escUi.win === 'run' && e.run) { const pad = Math.max(2000, (e.run.to - e.run.from) * 0.02); return [e.run.from - pad, e.run.to + pad]; }
        return [e.t0, Math.max(e.t1, e.t0 + 1000)];
    }

    // Render one ESC's two stacked plots into an offscreen bitmap (cv._aimBase); escPaint blits it + the hover/selection overlay.
    function escDrawBase(cv, res) {
        const name = cv.getAttribute('data-aim-ml-esc-cv');
        const W = cv.clientWidth, H = cv.clientHeight;
        const e = res.esc, an = res.escAnalysis, s = e.series[name];
        if (!W || !H || !s) return false;            // hidden (inside a closed <details>) — drawn on toggle
        const dpr = window.devicePixelRatio || 1;
        const base = cv._aimBase || (cv._aimBase = document.createElement('canvas'));
        base.width = cv.width = Math.round(W * dpr); base.height = cv.height = Math.round(H * dpr);
        const g = base.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        const [x0, x1] = escView(res);
        const L = 48, R = 8, pw = Math.max(10, W - L - R);
        const top = { y: 6, h: Math.round((H - 42) * 0.62) };
        const bot = { y: top.y + top.h + 12, h: 0 }; bot.h = H - bot.y - 18;
        const X = (t) => L + (t - x0) / (x1 - x0) * pw;
        const plots = [top, bot];
        g.font = '10px system-ui,sans-serif';
        for (const p of plots) { g.fillStyle = '#0b0e12'; g.fillRect(L, p.y, pw, p.h); }
        const band = (a, b, color) => { const xa = Math.max(L, X(a)), xb = Math.min(L + pw, Math.max(X(b), X(a) + 2)); if (xb <= L || xa >= L + pw) return; g.fillStyle = color; for (const p of plots) g.fillRect(xa, p.y, xb - xa, p.h); };
        if (e.run) band(e.run.from, e.run.to, 'rgba(255,255,255,.05)');
        for (const st of an.stretches) if (st.esc === name) band(st.from, st.to, 'rgba(255,95,95,.22)');
        // x grid + labels
        const spanS = (x1 - x0) / 1000;
        const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find(v => spanS / v <= 7) || 7200;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        for (let t = Math.ceil(x0 / (step * 1000)) * step * 1000; t <= x1; t += step * 1000) {
            const x = X(t);
            g.fillStyle = 'rgba(255,255,255,.06)'; for (const p of plots) g.fillRect(x, p.y, 1, p.h);
            g.fillStyle = '#888'; g.fillText(step < 1 ? mlHmsMs(t).slice(0, 10) : escT(t), x, H - 8);
        }
        // ---- top: the chosen metric, dots only ----
        const T = s.t, M = s[escUi.metric] || [], isRatio = escUi.metric === 'critical_current_rpm_ratio';
        const i0 = mlLowerBound(T, x0), i1 = mlLowerBound(T, x1);
        let lo = Infinity, hi = -Infinity;
        for (let i = i0; i < i1; i++) { const v = M[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
        if (isRatio) { lo = Math.min(lo, 0); hi = Math.max(hi, an.ratioThr * 1.1); }
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        if (hi - lo < 1e-9) hi = lo + 1;
        const padY = (hi - lo) * 0.08; hi += padY; if (!isRatio) lo -= padY;
        const Yt = (v) => top.y + top.h - (v - lo) / (hi - lo) * top.h;
        g.save(); g.beginPath(); g.rect(L, top.y, pw, top.h); g.clip();
        if (isRatio) { g.strokeStyle = '#ff5f5f'; g.lineWidth = 1; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(L, Yt(an.ratioThr)); g.lineTo(L + pw, Yt(an.ratioThr)); g.stroke(); g.setLineDash([]); }
        g.fillStyle = '#7adfe6';
        for (let i = i0; i < i1; i++) { const v = M[i]; if (v !== v || (isRatio && v > an.ratioThr)) continue; g.fillRect(X(T[i]) - 1, Yt(v) - 1, 2, 2); }
        if (isRatio) { g.fillStyle = '#ff5f5f'; for (let i = i0; i < i1; i++) { const v = M[i]; if (v > an.ratioThr) g.fillRect(X(T[i]) - 1.5, Yt(v) - 1.5, 3, 3); } }
        g.restore();
        // ---- bottom: samples per second (dots) + msg_in_sec (line) ----
        const ps = e.perSec[name], pb = e.pubs[name] || { t: [], v: [] };
        const k0 = Math.max(0, Math.floor(x0 / 1000) - ps.s0), k1 = Math.min(ps.counts.length - 1, Math.floor(x1 / 1000) - ps.s0);
        const j0 = Math.max(0, mlLowerBound(pb.t, x0) - 1), j1 = Math.min(pb.t.length, mlLowerBound(pb.t, x1) + 1);
        let bhi = an.sampThr;
        for (let k = k0; k <= k1; k++) if (ps.counts[k] > bhi) bhi = ps.counts[k];
        for (let j = j0; j < j1; j++) if (pb.v[j] > bhi) bhi = pb.v[j];
        const bmax = bhi; bhi *= 1.15;
        const Yb = (v) => bot.y + bot.h - v / bhi * bot.h;
        g.save(); g.beginPath(); g.rect(L, bot.y, pw, bot.h); g.clip();
        g.strokeStyle = '#ffb347'; g.lineWidth = 1; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(L, Yb(an.sampThr)); g.lineTo(L + pw, Yb(an.sampThr)); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#8a93a0';
        for (let k = k0; k <= k1; k++) g.fillRect(X((ps.s0 + k) * 1000 + 500) - 1, Yb(ps.counts[k]) - 1, 2, 2);
        if (j1 - j0 > 0) { g.strokeStyle = '#5fff5f'; g.lineWidth = 1.3; g.beginPath(); for (let j = j0; j < j1; j++) { const x = X(pb.t[j]), y = Yb(pb.v[j]); if (j === j0) g.moveTo(x, y); else g.lineTo(x, y); } g.stroke(); }
        g.restore();
        // ---- the drone's alert time ----
        for (const al of e.alerts) {
            if (al.t == null || al.t < x0 || al.t > x1) continue;
            g.strokeStyle = '#ff5f5f'; g.lineWidth = al.esc === name ? 2 : 1; g.setLineDash(al.esc === name ? [] : [2, 4]);
            g.beginPath(); g.moveTo(X(al.t), top.y); g.lineTo(X(al.t), bot.y + bot.h); g.stroke(); g.setLineDash([]);
        }
        // ---- y labels + captions ----
        const fmt = (v) => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
        g.fillStyle = '#888'; g.textAlign = 'right';
        g.fillText(fmt(hi), L - 4, top.y + 5); g.fillText(fmt((lo + hi) / 2), L - 4, top.y + top.h / 2); g.fillText(fmt(lo), L - 4, top.y + top.h - 5);
        g.fillText(Number.isInteger(bmax) ? String(bmax) : fmt(bmax), L - 4, Yb(bmax)); g.fillText('0', L - 4, bot.y + bot.h - 5);
        // captions sit on a dark chip in the top-right corner so they never hide the data underneath
        g.textAlign = 'right';
        for (const [txt, p] of [[escMetricLabel(), top], ['readings / s (dots) · msg_in_sec (line)', bot]]) {
            const w = g.measureText(txt).width + 8;
            g.fillStyle = 'rgba(11,14,18,.8)'; g.fillRect(L + pw - w - 2, p.y + 2, w, 13);
            g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText(txt, L + pw - 6, p.y + 9);
        }
        cv._aim = { x0, x1, L, pw, top, bot, W, H, dpr };
        return true;
    }

    function escPaint(cv) {
        const a = cv._aim, base = cv._aimBase;
        if (!a || !base || !base.width) return;
        const g = cv.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, cv.width, cv.height);
        g.drawImage(base, 0, 0);
        g.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
        const X = (t) => a.L + (t - a.x0) / (a.x1 - a.x0) * a.pw, y0 = a.top.y, y1 = a.bot.y + a.bot.h;
        if (escUi.sel) { const xa = X(Math.min(escUi.sel.a, escUi.sel.b)), xb = X(Math.max(escUi.sel.a, escUi.sel.b)); g.fillStyle = 'rgba(122,223,230,.18)'; g.fillRect(xa, y0, xb - xa, y1 - y0); }
        if (escUi.hoverT != null && escUi.hoverT >= a.x0 && escUi.hoverT <= a.x1) { g.fillStyle = 'rgba(255,255,255,.45)'; g.fillRect(X(escUi.hoverT), y0, 1, y1 - y0); }
    }

    const escCanvases = () => ui.body ? Array.from(ui.body.querySelectorAll('canvas[data-aim-ml-esc-cv]')) : [];
    function escReadout(res) {
        const els = ui.body.querySelectorAll('[data-aim-ml-esc="readout"]');
        if (!els.length) return;
        const t = escUi.hoverT, e = res.esc;
        let html = '<span class="m">Move the cursor over a chart for exact values · drag across a chart to zoom all of them · double-click to reset</span>';
        if (t != null) {
            html = `<b>${mlHmsMs(t)} UTC</b> <span class="m">+${((t - e.t0) / 1000).toFixed(1)} s · ${esc(escMetricLabel())} · readings/s · msg_in_sec</span><br>` + e.names.map(n => {
                const s = e.series[n], T = s.t;
                let i = mlLowerBound(T, t); if (i >= T.length || (i > 0 && t - T[i - 1] < T[i] - t)) i--;
                const v = i >= 0 && Math.abs(T[i] - t) <= 1500 ? s[escUi.metric][i] : null;
                const ps = e.perSec[n], k = Math.floor(t / 1000) - ps.s0, c = k >= 0 && k < ps.counts.length ? ps.counts[k] : 0;
                const pb = e.pubs[n]; let msg = null;
                if (pb) { const j = mlLowerBound(pb.t, t); if (j < pb.t.length && pb.t[j] - t <= 2 * e.pubInterval) msg = pb.v[j]; }
                return `<span class="c">${esc(n)}</span> <b>${escNum(v, 3)}</b> · ${c}/s · ${escNum(msg, 2)}`;
            }).join(' &nbsp;│&nbsp; ');
        }
        els.forEach(el => { el.innerHTML = html; });
    }
    function escRedrawAll() {
        const res = lastResult;
        if (!res || !res.esc || !res.esc.present || !ui.body) return;
        try { for (const cv of escCanvases()) if (escDrawBase(cv, res)) escPaint(cv); escReadout(res); }
        catch (err) { console.error(`${TAG} ESC chart draw failed:`, err); }
    }
    function escSchedulePaint() {
        if (escUi.raf) return;
        escUi.raf = requestAnimationFrame(() => {
            escUi.raf = 0;
            try { for (const cv of escCanvases()) escPaint(cv); if (lastResult && lastResult.esc && lastResult.esc.present) escReadout(lastResult); }
            catch (err) { console.error(`${TAG} ESC chart paint failed:`, err); }
        });
    }

    // Re-run the verdict with the current thresholds and refresh every ESC region in place.
    function escRefresh(res) {
        try { res.escAnalysis = mlEscAnalyze(res.esc, escUi.ratioThr, escUi.sampThr); }
        catch (err) { console.error(`${TAG} ESC analysis failed:`, err); setStatus('ESC analysis failed — see console', 'red'); return; }
        const an = res.escAnalysis, root = ui.body;
        const fill = (key, html) => root.querySelectorAll(`[data-aim-ml-esc="${key}"]`).forEach(el => { el.innerHTML = html; });
        fill('verdict', escVerdictHtml(res)); fill('stretches', escStretchesHtml(res)); fill('stats', escStatsHtml(res)); fill('simple', escSimpleInner(res));
        root.querySelectorAll('[data-aim-ml-esc-ctl]').forEach(el => { const k = el.getAttribute('data-aim-ml-esc-ctl'); el.value = k === 'ratio' ? escUi.ratioThr : k === 'samp' ? escUi.sampThr : escUi.metric; });
        root.querySelectorAll('[data-aim-ml-esc-win]').forEach(b => b.classList.toggle('on', !escUi.view && b.getAttribute('data-aim-ml-esc-win') === escUi.win));
        root.querySelectorAll('[data-aim-ml-esc-tag]').forEach(el => {
            const n = el.getAttribute('data-aim-ml-esc-tag'), mine = an.stretches.filter(x => x.esc === n);
            el.innerHTML = `${an.alertEscs.includes(n) ? escTag('alerted', 'r') + ' ' : ''}<span class="m">${mine.length ? `${mine.length} stretch${mine.length === 1 ? '' : 'es'} above ${esc(an.ratioThr)} · ${mine.filter(x => x.low).length} low sampling` : `never above ${esc(an.ratioThr)}`}</span>`;
        });
        escRedrawAll();
    }

    // Called by render() after the panel body is (re)built.
    function escWire(res) {
        if (!res.esc || !res.esc.present) return;
        const root = ui.body;
        escRefresh(res);
        root.querySelectorAll('[data-aim-ml-esc-ctl]').forEach(el => el.addEventListener('change', () => {
            const k = el.getAttribute('data-aim-ml-esc-ctl');
            if (k === 'metric') escUi.metric = ESC_METRICS.some(m => m[0] === el.value) ? el.value : ESC_METRICS[0][0];
            else {
                const v = parseFloat(el.value);
                if (!isFinite(v) || v <= 0) { console.warn(`${TAG} ESC threshold ignored (not a positive number):`, el.value); setStatus('Threshold must be a positive number — kept the previous value.', 'amber'); }
                else if (k === 'ratio') escUi.ratioThr = v; else escUi.sampThr = v;
            }
            escRefresh(res);
        }));
        root.querySelectorAll('[data-aim-ml-esc-win]').forEach(b => b.addEventListener('click', () => { escUi.win = b.getAttribute('data-aim-ml-esc-win') === 'full' ? 'full' : 'run'; escUi.view = null; escRefresh(res); }));
        root.querySelectorAll('[data-aim-ml-esc="stretches"]').forEach(el => el.addEventListener('click', (ev) => {
            const row = ev.target.closest('[data-aim-ml-esc-zoom]'); if (!row) return;
            const [a, b] = row.getAttribute('data-aim-ml-esc-zoom').split(',').map(Number);
            const pad = Math.max(10000, (b - a) * 0.5);
            escUi.view = [a - pad, b + pad]; escRefresh(res);
            const cv = escCanvases().find(c => c.clientWidth); if (cv) cv.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }));
        const tAt = (cv, ev) => { const a = cv._aim; if (!a) return null; const r = cv.getBoundingClientRect(); const x = Math.min(a.L + a.pw, Math.max(a.L, ev.clientX - r.left)); return a.x0 + (x - a.L) / a.pw * (a.x1 - a.x0); };
        for (const cv of escCanvases()) {
            cv.addEventListener('pointerdown', (ev) => {
                if (ev.button !== 0) return;
                const t = tAt(cv, ev); if (t == null) return;
                escUi.sel = { a: t, b: t, px: ev.clientX };
                try { cv.setPointerCapture(ev.pointerId); } catch (err) { console.warn(`${TAG} pointer capture failed`, err); }
            });
            cv.addEventListener('pointermove', (ev) => { const t = tAt(cv, ev); if (t == null) return; escUi.hoverT = t; if (escUi.sel) escUi.sel.b = t; escSchedulePaint(); });
            cv.addEventListener('pointerup', (ev) => {
                const sel = escUi.sel; escUi.sel = null;
                if (sel && Math.abs(ev.clientX - sel.px) > 6 && Math.abs(sel.b - sel.a) >= 300) { escUi.view = [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)]; escRefresh(res); }
                else escSchedulePaint();
            });
            cv.addEventListener('pointercancel', () => { escUi.sel = null; escSchedulePaint(); });
            cv.addEventListener('pointerleave', () => { if (escUi.sel) return; escUi.hoverT = null; escSchedulePaint(); });
            cv.addEventListener('dblclick', () => { escUi.view = null; escRefresh(res); });
        }
    }

    // ---------------- Simple mode: plain English for pilots / customers ----------------
    const PROC_PLAIN = { image_processor: 'camera image processing', video_source: 'video streaming', video_source_0: 'video streaming', video_source_1: 'video streaming', video_source_2: 'video streaming', teleport: 'remote-support tunnel', pdb_server: 'power board', telemetry_server: 'flight-controller telemetry link', lte_manager: 'cellular modem manager', qmi_modem: 'cellular modem', kernel: 'operating system', systemd: 'operating system services', perfmon: 'performance monitor', gimbal_telemetry: 'gimbal', esc_telemetry: 'motor controllers', temps_server: 'temperature monitor', odid_service: 'Remote ID broadcast', odid_client: 'Remote ID broadcast', python3: 'drone app', supervisord: 'app supervisor', das: 'app supervisor', 'apt-helper': 'software updater', nv_update_engine: 'software updater' };
    const CRITICAL_PROCS = /^(pdb_server|esc_telemetry|telemetry_server|lte_manager|qmi_modem|kernel|gimbal_telemetry)$/;
    const abortPlain = (type) => {
        if (/flyingobject/i.test(type)) return 'it detected another aircraft nearby';
        if (/goToBase/i.test(type)) return 'a safety rule sent it back to base';
        if (/lowbattery|battery/i.test(type)) return 'the battery got low';
        if (/gps|navigation/i.test(type)) return 'it lost confidence in its GPS position';
        if (/link|comm|connection/i.test(type)) return 'it lost its communication link';
        if (/wind|weather/i.test(type)) return 'the weather exceeded its limits';
        if (/geofence|nfz|zone/i.test(type)) return 'it reached a no-fly boundary';
        return type.replace(/^edge\.(notify\.)?/, '').replace(/^drone_/, '').replace(/_/g, ' ');
    };
    const barsPlain = (rsrp) => rsrp == null ? null : rsrp > -90 ? 'full bars' : rsrp > -100 ? 'two bars' : rsrp > -110 ? 'one bar' : 'barely any signal';
    const lagPlain = (ms) => ms == null ? null : ms < 250 ? 'normal' : ms < 500 ? 'a little slow' : ms < 1000 ? 'slow' : 'very slow';
    const tech = (key, adv) => adv[key] ? `<details class="aim-ml-tech"><summary>Technical details ▸</summary>${adv[key]}</details>` : '';
    const simpleCard = (title, level, bottom, bullets, techHtml, actions) => card(title, `<div class="aim-ml-bottom ${lv(level)}">${bottom}</div>${bullets.length ? `<ul class="aim-ml-plain">${bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : ''}${techHtml}`, actions);

    function renderSimple(res, adv) {
        const { lte, events, daa, warnings, meta, extra } = res;
        const out = [];
        const mj = meta.json || {}, m = extra.mission || {};
        const site = mj.site_name || (m.site && m.site.name) || 'this site';
        const droneName = mj.vehicle_name || (m.drone && m.drone.name) || 'the drone';
        const to = events.takeoff && events.takeoff.t, td = events.touchdown && events.touchdown.t;
        const airMin = to && td ? Math.round((td - to) / 60000) : null;
        const abort = res.abortEv;

        // --- Mission ---
        const flags = [];
        if (meta.events) {
            if (meta.events.mainLoopStall) flags.push(`The flight computer hiccupped <b>${meta.events.mainLoopStall}</b> time(s) (brief freezes well under a second). Not a network issue; worth reporting if it repeats on this drone.`);
            if (meta.events.landingLowIPS) flags.push(`The landing camera had trouble seeing the pad during landing (low frame rate). The landing still completed.`);
            if (meta.events.takeoffFail) flags.push(`<b>Takeoff failed ${meta.events.takeoffFail} time(s)</b> before it got airborne.`);
            if (meta.events.navigationFail) flags.push(`<b>Navigation failed ${meta.events.navigationFail} time(s).</b>`);
            if (meta.events.safetySwitch) flags.push(`<b>The safety switch tripped ${meta.events.safetySwitch} time(s).</b>`);
        }
        const inc = res.incident && res.incident.show;
        const ended = abort ? `It was <b>cut short at ${mlHms(abort.t)} UTC</b> because ${abortPlain(abort.type)}${inc ? '. <b>It did not get home normally</b> — see “Possible incident” above.' : ', and it flew home.'}` : (td ? 'It flew its plan and landed normally.' : 'No landing was recorded in these logs.');
        out.push(simpleCard(`🛸 Mission ${esc(res.missionId)}${m.app && m.app.name ? ' · ' + esc(m.app.name) : ''}`, inc ? 'red' : abort ? 'amber' : 'green',
            `${esc(droneName)} flew <b>${esc(site)}</b>${airMin != null ? ` for about <b>${airMin} minute${airMin === 1 ? '' : 's'}</b>` : ''}${to ? ` (took off ${mlHms(to)} UTC)` : ''}. ${ended}`,
            [`Pilot: <b>${esc(m.created_by && (m.created_by.full_name || m.created_by.username) || '—')}</b>. Drone software ${esc(mj.app_version || '—')}.`, ...flags], tech('mission', adv)));

        // --- LTE ---
        const med = lte.coverage ? lte.coverage.median : null, bars = barsPlain(med), lag = lagPlain(lte.avgRtt);
        let lteBottom, lteBullets = [], lteLevelOverride = null;
        if (!lte.tcp.firstOk) lteBottom = `${esc(droneName)} <b>never got an internet connection</b> in these logs.`;
        else if (lte.verdict.level === 'red') {
            const real = lte.outages.filter(w => (w.s || 0) >= 30 || w.samples >= 2 || /lease|reconnect|no internet/.test(w.kind));
            const inFlight = real.filter(w => w.phase === 'in flight');
            const where = (w) => w.phase === 'before takeoff' ? 'before takeoff, while on the base' : w.phase === 'after landing' ? 'after landing' : 'in flight';
            if (real.length && !inFlight.length) {
                lteLevelOverride = 'amber';
                lteBottom = `The connection <b>dropped ${real.length === 1 ? 'once' : real.length + ' times'} but not while flying</b>: ${real.map(w => `${mlHms(w.from)} UTC for ${w.s} s (${where(w)})`).join('; ')}. In the air the drone stayed connected.`;
            } else if (real.length) {
                const longest = real.reduce((a, b) => (b.s > a.s ? b : a));
                lteBottom = `The connection <b>dropped ${real.length === 1 ? 'once' : real.length + ' times'} while flying</b>, the longest for <b>${longest.s} seconds</b> starting ${mlHms(longest.from)} UTC. The drone keeps flying its plan on its own during a gap, but you cannot see or control it until the link returns.`;
            } else {
                lteBottom = `The modem <b>${lte.resetCount > 1 ? 'restarted' : 'had to reconnect'}</b> during the flight${lte.deconfAfterUp.length ? ` (${lte.deconfAfterUp.length} IP-lease loss event${lte.deconfAfterUp.length === 1 ? '' : 's'})` : ''}; the link came back on its own.`;
            }
        } else if (lte.verdict.level === 'amber' && /POOR/.test(lte.verdict.text)) lteBottom = `The drone <b>stayed connected, but the connection was poor</b>: ${bars ? `${bars} of signal` : 'weak signal'}${lag ? `, ${lag} response` : ''}. Expect choppy video and delayed commands.`;
        else if (lte.verdict.level === 'amber') lteBottom = `The drone <b>stayed connected</b> with a few slow moments. Nothing a pilot would notice beyond a brief stutter.`;
        else lteBottom = `The drone <b>stayed connected the whole flight</b> with a healthy connection.`;
        if (lte.carrier && lte.carrier.name) lteBullets.push(`<b>Carrier:</b> the drone was on <b>${esc(lte.carrier.name)}</b>'s network (worked out from the LTE bands it used${lte.creg && lte.creg['0,5'] ? '; the SIM roams, so this can differ by flight' : ''}).`);
        else if (lte.bands.length) lteBullets.push(`<b>Carrier:</b> could not be told from this flight's bands (${esc(lte.bands.join(', '))} are shared by several carriers).`);
        if (bars) lteBullets.push(`<b>Signal:</b> ${bars} most of the flight${lte.coverage.weakPct ? `; weak for ${lte.coverage.weakPct}% of the time` : ''}${lte.worstRsrp ? `, worst at ${mlHms(lte.worstRsrp.t)}` : ''}.`);
        if (lte.avgRtt != null) lteBullets.push(`<b>Response time:</b> ${lag} (about ${lte.avgRtt} ms per round trip; a good site is near 150 ms, worst moment ${lte.worstRtt} ms).`);
        const lossShare = lte.lossShare != null ? lte.lossShare : (lte.pings.length ? Math.round(100 * lte.lossyPings.length / lte.pings.length) : 0);
        if (lte.pings.length) lteBullets.push(`<b>Packet loss:</b> ${lossShare}% of the test pings lost something${lossShare >= 25 ? ' — that is a lot' : lossShare ? ' — minor' : ' — clean'}.`);
        if (lte.outages.length && lte.verdict.level !== 'red') lteBullets.push(`<b>Blips:</b> ${lte.outages.map(w => `${mlHms(w.from)} (${w.s} s)${pin(w.at)}`).join(', ')} — came back on its own each time.<span data-aim-ml-live> Click 📍 to copy where it happened.</span>`);
        if (lte.outages.some(w => w.at) || lte.handovers.some(h => h.at)) lteBullets.push(`<span data-aim-ml-live><b>Where:</b> 📍 Signal KML (top right of this card) maps every signal reading along the flight, colored good → weak, with the blips and tower switches pinned — open it in Google Earth or Fleet Tools → KML Layers.</span>`);
        if (lte.handovers.length > 6) lteBullets.push(`<b>Tower hopping:</b> switched cell towers ${lte.handovers.length} times. Flying between overlapping towers usually means momentary stalls at each switch.`);
        if (lte.modes.includes('ENDC')) lteBullets.push(`<b>5G</b> was available for part of the flight.`);
        if (lte.resetCount > 1) lteBullets.push(`<b>The modem restarted</b> during the flight.`);
        if (lte.formatWarning) lteBullets.push(`⚠ ${esc(lte.formatWarning)}`);
        const advice = lte.verdict.level === 'green' ? null
            : (med != null && med <= -100) ? `<b>What to do:</b> this site has weak cellular coverage. Options: a different carrier SIM, an antenna/booster if the drone supports one, or accept the lag. Nothing points to a fault in the drone or base.`
            : lte.handovers.length > 6 ? `<b>What to do:</b> the route crosses several towers. If stalls bother the pilot, try a flight path or altitude that stays in one tower's area.`
            : lte.verdict.level === 'red' ? `<b>What to do:</b> check whether this drop repeats at the same place on other flights; if so it is coverage, if not it may be the carrier or modem.`
            : null;
        if (advice) lteBullets.push(advice);
        out.push(simpleCard('📶 Connection (LTE)', lteLevelOverride || lte.verdict.level, lteBottom, lteBullets, tech('lte', adv), kmlBtn() + copyBtn('lte')));

        // --- Events ---
        const stalls = events.all.filter(e => /mainLoopStall/.test(e.type)).length;
        const evBullets = [];
        if (to) evBullets.push(`Took off <b>${mlHms(to)}</b> UTC${td ? `, landed <b>${mlHms(td)}</b>` : ''}${airMin != null ? ` (${airMin} min in the air)` : ''}.`);
        if (abort) evBullets.push(`<b>${mlHms(abort.t)}:</b> mission stopped because ${abortPlain(abort.type)}${(() => { const later = (res.flightAborts || []).filter(a => a !== abort && !/_warn_/.test(a.type)); return later.length ? `; then ${later.map(a => `${mlHms(a.t)} ${abortPlain(a.type)}`).join('; ')}` : ''; })()}.`);
        const warnEv = events.all.filter(e => /_warn_/.test(e.type) && !/mainLoopStall/.test(e.type));
        if (warnEv.length) evBullets.push(`Other warnings from the drone: ${Array.from(new Set(warnEv.map(e => abortPlain(e.type)))).slice(0, 5).map(esc).join(', ')}.`);
        out.push(simpleCard('🧭 What happened', inc ? 'red' : abort ? 'amber' : 'green', abort ? `The mission <b>did not finish</b>: ${abortPlain(abort.type)} at ${mlHms(abort.t)} UTC${inc ? ', and the drone did not get home normally.' : ' and the drone returned to base.'}` : `The mission <b>ran start to finish</b> with no safety events.`, evBullets, tech('events', adv), copyBtn('events')));

        // --- ESC ---
        out.push(escCardSimple(res, adv));

        // --- DAA ---
        let daaBottom, daaBullets = [], daaLevel = 'green';
        if (!res.roles.pingstation && !res.roles.radars) { daaBottom = extra.daaNote ? `Aircraft data was not available: ${esc(extra.daaNote)}.` : 'Aircraft data was not fetched (DAA box unticked).'; daaLevel = 'm'; }
        else if (!daa.aircraft.length) daaBottom = 'No aircraft were heard near the site during the flight.';
        else {
            const near = daa.aircraft.filter(a => a.closest);
            const c = near[0];
            if (c) {
                daaLevel = c.closest.dist < 1852 ? 'red' : c.closest.dist < 5556 ? 'amber' : 'green';
                daaBottom = `<b>${daa.aircraft.length}</b> aircraft ${daa.aircraft.length === 1 ? 'was' : 'were'} heard nearby. The closest, <b>${esc(c.callsign || c.nNumber || c.icao)}</b> (${esc(c.emitter)}), came within <b>${fmtDist(c.closest.dist)}</b> at ${mlHms(new Date(c.closest.t))} UTC, flying at ${mlFt(c.closest.acAltM).toLocaleString()} ft while the drone was at ${mlFt(c.closest.droneAltM)} ft.`;
                if (abort && /flyingobject/i.test(abort.type)) { const trig = daa.aircraft.find(a => a.atAbort) || c; daaBullets.push(`<b>This is the aircraft that stopped the mission.</b> At ${mlHms(abort.t)} it was ${trig.atAbort ? fmtDist(trig.atAbort.dist) : 'closing in'} from the drone${trig.atAbort ? ` at ${mlFt(trig.atAbort.acAltM).toLocaleString()} ft` : ''}. The drone did the right thing by going home.`); }
                const nearish = near.slice(1).filter(a => a.closest.dist < 10000);
                for (const a of nearish.slice(0, 3)) daaBullets.push(`${esc(a.callsign || a.nNumber || a.icao)} (${esc(a.emitter)}): closest ${fmtDist(a.closest.dist)} at ${mlHms(new Date(a.closest.t))}, ${mlFt(a.closest.acAltM).toLocaleString()} ft.`);
                const far = daa.aircraft.length - 1 - nearish.length; if (far > 0) daaBullets.push(`${far} more ${far === 1 ? 'was' : 'were'} heard but never near the drone's flight path (airliners passing high overhead, typically).`);
            } else { daaBottom = `${daa.aircraft.length} aircraft ${daa.aircraft.length === 1 ? 'was' : 'were'} heard in the area, none anywhere near the drone's path.`; }
            daaBullets.push(`<span class="m">Red = within 1 nautical mile, amber = within 3. Heard by the base station's ADS-B receiver; aircraft without a transponder are not seen.</span>`);
        }
        out.push(simpleCard('✈ Aircraft nearby', daaLevel, daaBottom, daaBullets, tech('daa', adv), copyBtn('daa')));

        // --- Warnings ---
        const total = warnings.reduce((s, w) => s + w.n, 0);
        const crit = warnings.filter(w => CRITICAL_PROCS.test(w.proc));
        const wBullets = warnings.slice(0, 4).map(w => `<b>${esc(PROC_PLAIN[w.proc] || w.proc)}</b>: ${w.n} message${w.n === 1 ? '' : 's'}${w.samples[0] ? ` — e.g. “${esc(w.samples[0].msg.replace(/^\S+\s+T_\S+\s+\[[A-Z ]+\]\s+/, '').slice(0, 110))}”` : ''}.`);
        out.push(simpleCard('⚠ Software warnings during the flight', total ? (crit.length ? 'amber' : 'm') : 'green',
            total ? `${total} warning${total === 1 ? '' : 's'} from the drone's software${crit.length ? `, including from <b>${crit.map(w => PROC_PLAIN[w.proc] || w.proc).join(', ')}</b> — worth a look` : ', none from flight-critical parts'}.` : 'No warnings from the drone\'s software during the flight.',
            wBullets, tech('warnings', adv), copyBtn('warnings')));

        out.push(adv.files || '');
        return out.join('');
    }

    const copyBtn = (key) => `<button class="aim-ml-btn" data-aim-ml-copy="${key}" title="Copy as a table (paste into Sheets)">📋 Sheets</button>`;

    async function copySection(res, key, btn) {
        let rows = [];
        if (key === 'lte') {
            rows = [['UTC', 'Mode', 'Band', 'RSRP dBm', 'RSRQ dB', 'SINR dB', 'Tx', '5G RSRP', '5G SINR', 'Cell', 'RRC', 'Temp'], ...res.lte.gstatus.map(s => [mlHms(s.t), s.mode, s.band, s.rsrp, s.rsrq, s.sinr, s.tx, s.nrRsrp, s.nrSinr, s.cell, s.rrc, s.temp])];
            const cov = res.lte.coverage;
            rows.unshift(['Verdict', res.lte.verdict.text], ...res.lte.outages.map(w => ['Outage', `${mlHms(w.from)} → ${mlHms(w.to)}`, `${w.s} s`, w.kind]), cov ? ['Coverage', `median RSRP ${cov.median} dBm`, `${cov.weakPct}% weak`, `${cov.veryWeakPct}% very weak`, `${cov.noCellPct}% no cell`] : [], []);
        } else if (key === 'events') rows = [['UTC', 'Event', 'Detail'], ...res.events.timeline.map(e => [mlHms(e.t), e.type, e.label])];
        else if (key === 'daa') rows = [['Callsign', 'ICAO', 'N-number', 'Type', 'Squawk', 'First UTC', 'Last UTC', 'Alt min ft', 'Alt max ft', 'Max kt', 'Closest m', 'Closest UTC', 'At abort m'], ...res.daa.aircraft.map(a => [a.callsign, a.icao, a.nNumber || '', a.emitter, a.squawks.join('/'), mlHms(new Date(a.first)), mlHms(new Date(a.last)), mlFt(a.altMinM), mlFt(a.altMaxM), a.spdMaxMs ? Math.round(a.spdMaxMs * 1.944) : '', a.closest ? Math.round(a.closest.dist) : '', a.closest ? mlHms(new Date(a.closest.t)) : '', a.atAbort ? Math.round(a.atAbort.dist) : ''])];
        else if (key === 'esc' && res.esc && res.esc.present) {
            const e = res.esc, an = res.escAnalysis;
            rows = [['Verdict', an.verdict.text], ['Thresholds', `ratio above ${an.ratioThr}`, `sampling below ${an.sampThr}/s`], ...e.alerts.map(a => ['Drone alert', escT(a.t), a.esc || '', a.value, a.limit]), ...e.actions.map(a => ['Drone action', escT(a.t), a.text]), [],
                ['ESC', 'Start UTC', 'End UTC', 'Duration s', 'Peak ratio', 'Peak UTC', 'Min samples/s', 'Seconds below', 'Seconds total', 'Min msg_in_sec', 'Sampling', 'Judged'],
                ...an.stretches.map(x => [x.esc, mlHmsMs(x.from), mlHmsMs(x.to), x.s.toFixed(1), x.peak.toFixed(4), mlHmsMs(x.peakT), x.minPerSec, x.secsBelow, x.secsTotal, x.minMsg == null ? '' : x.minMsg, x.low ? 'Low' : 'Normal', x.judged ? 'yes' : '']), [],
                ['ESC (motors running)', 'Throttle in avg', 'Throttle out avg', 'rpm avg', 'rpm max', 'Current avg A', 'Current max A', 'Min voltage', 'Max MOSFET C', 'Max capacitor C', 'Max ratio', '% of run above', 'Non-zero status samples'],
                ...an.stats.filter(s => s.n).map(s => [s.esc, s.thrIn.toFixed(0), s.thrOut.toFixed(0), s.rpmAvg.toFixed(0), s.rpmMax.toFixed(0), s.curAvg.toFixed(1), s.curMax.toFixed(1), s.voltMin, s.mosMax, s.capMax, s.ratioMax.toFixed(4), s.overPct.toFixed(2), s.statusNonZero])];
        }
        else if (key === 'warnings') rows = [['Process', 'Count', 'First UTC', 'Sample'], ...res.warnings.map(w => [w.proc, w.n, mlHms(w.first), w.samples.map(s => s.msg).join(' | ')])];
        const tsv = rows.map(r => r.map(c => String(c == null ? '' : c).replace(/\t|\n/g, ' ')).join('\t')).join('\n');
        const html = `<table>${rows.map((r, i) => `<tr>${r.map(c => `<t${i === 0 ? 'h' : 'd'}>${esc(c)}</t${i === 0 ? 'h' : 'd'}>`).join('')}</tr>`).join('')}</table>`;
        try {
            if (navigator.clipboard && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([tsv], { type: 'text/plain' }) })]);
            else await navigator.clipboard.writeText(tsv);
            const old = btn.textContent; btn.textContent = '✓ copied'; setTimeout(() => { btn.textContent = old; }, 1500);
        } catch (e) { console.warn(`${TAG} clipboard failed`, e); btn.textContent = '✗ clipboard'; }
    }

    // ---------------- v0.94 — 🚨 Possible incident card + incident review ----------------
    function downloadArchive(res, i) {
        const a0 = res && res.archives && res.archives[i];
        if (!a0) { setStatus('No archive in memory — analyze the mission first.', 'amber'); return; }
        const blob = new Blob([a0.bytes], { type: 'application/gzip' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = a0.name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        console.log(`${TAG} archive saved: ${a0.name} (${fmtMB(a0.bytes.length)})`);
        setStatus(`Saved ${esc(a0.name)} (${fmtMB(a0.bytes.length)})`, 'green');
    }
    const incT = (ms) => mlHmsMs(ms).slice(0, 10);
    function incCard(res) {
        const inc = res.incident;
        if (!inc || !inc.show) return '';
        const deep = res.incidentDeep, bin = res.roles.ardupilot;
        const sigRows = inc.signals.map(s => `<li>${s.t != null ? `<span class="m">${mlHms(new Date(s.t))}</span> ` : ''}<b class="${s.weight === 'strong' ? 'r' : 'a'}">${esc(s.text)}</b></li>`).join('');
        const trig = inc.firstTrigger;
        let inner = `<div class="aim-ml-bottom r"><b>This flight did not end normally.</b> ${inc.signals.length} warning sign${inc.signals.length === 1 ? '' : 's'} in the drone's own event log (times are UTC):</div>
            <ul class="aim-ml-plain">${sigRows}</ul>
            ${trig ? `<div style="margin-top:6px">It first left its plan at <b>${mlHms(new Date(trig.t))}</b> because ${esc(abortPlain(trig.type))}.</div>` : ''}`;
        if (!deep) {
            inner += `<div class="m" style="margin-top:6px">The first alarm is often a result, not the cause. The incident review reads the flight controller's own log for the first abnormal moment: a sudden stop, jolts, loss of control, a stalled motor, a hard impact, the parachute command.</div>
                <div style="margin-top:8px">${bin ? `<button class="aim-ml-btn" data-aim-ml-inc-run style="border-color:#ff5f5f;color:#ff9a9a;font-weight:700;padding:5px 12px">🚨 Run incident review <span class="m">(${fmtMB(bin.bytes.length)} flight-controller log)</span></button>` : '<span class="a">⚠ No flight-controller log (ardupilot.log.bin) in this archive, so the incident review cannot run.</span>'}</div>`;
        } else if (!deep.ok) {
            inner += `<div class="a" style="margin-top:8px">⚠ Incident review could not run: ${esc(deep.note)}</div>`;
        } else {
            const f1 = deep.first;
            const shown = deep.findings;
            let n = 0;
            inner += `<div class="aim-ml-bottom ${f1 ? 'r' : 'g'}" style="margin-top:10px">${f1 ? `First abnormal moment: <b>${incT(f1.t)} UTC — ${esc(f1.title)}</b>` : 'The flight controller recorded no sudden stop, jolt, loss of control, stalled motor or hard impact.'}</div>
                ${deep.notes.length ? `<ul class="aim-ml-plain">${deep.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
                <table class="aim-ml" style="margin-top:6px"><tr><th>#</th><th>UTC</th><th>What</th><th>Detail</th></tr>${shown.map(f => { const mark = f.level === 'red' || f.level === 'amber'; if (mark) n++; return `<tr><td class="m">${mark ? n : ''}</td><td class="m" style="white-space:nowrap">${incT(f.t)}</td><td class="${lv(f.level)}" style="white-space:nowrap"><b>${esc(f.title)}</b></td><td>${esc(f.text)}${f.at ? pin(f.at) : ''}</td></tr>`; }).join('')}</table>
                <div class="aim-ml-inc-ro" data-aim-ml-inc-ro><span class="m" data-aim-ml-live>Move the cursor over the chart for exact values.</span></div>
                <canvas data-aim-ml-inc-cv></canvas>
                <div class="m" style="margin-top:6px">Chart: 30 s before the first abnormal moment to 8 s after the impact. Numbered lines are the red and orange rows above. “Push along the body” is the force the drone felt front-to-back apart from its own propellers; near zero is normal.</div>
                <div class="aim-ml-inc-h">Where it happened</div>
                <div class="aim-ml-inc-ro" data-aim-ml-inc-mro><span class="m" data-aim-ml-live>Move the cursor along the track for the time, speed and height at that point.</span></div>
                <canvas data-aim-ml-inc-map></canvas>
                <div class="aim-ml-inc-leg"><span><i style="border-color:#7adfe6"></i>flown, before the first abnormal moment</span><span><i style="border-color:#ffb347"></i>flown, after it</span><span><i style="border-color:#55617a"></i>rest of the flight</span>${res.siteGeo ? '<span><i style="border-color:#c9c9d6;border-top-style:dashed"></i>planned flight path</span><span><i class="box" style="border-color:#3c9a3c"></i>FFZ</span><span><i class="box" style="border-color:#c04a4a"></i>NFZ</span>' : ''}</div>
                <div class="m" style="margin-top:6px">${incNearestRoute(res)}North is up. Numbers match the table. ${res.siteGeo ? 'Flight paths and zones are the site setup the drone carried on this flight.' : 'No site setup file in this archive, so flight paths and zones are not drawn.'} Power lines and other obstacles are not in the drone's logs and are not drawn.</div>
                <div class="m" style="margin-top:6px">This review reports what the sensors recorded. It cannot see what the drone touched or whether a parachute canopy was out — check the video and the airframe. Source: ${esc(bin ? bin.base : '')} · ${deep.stats.records.toLocaleString()} records${deep.stats.bad ? ` · ${deep.stats.bad} unreadable bytes skipped` : ''}.</div>`;
        }
        return `<div class="aim-ml-card inc"><h4>🚨 Possible incident<span class="sp"></span></h4><div>${inner}</div></div>`;
    }
    function incRun(res) {
        const bin = res.roles.ardupilot;
        if (!bin) { setStatus('No flight-controller log in this archive.', 'amber'); return; }
        if (ui.busy) { setStatus('Busy — wait for the current step.', 'amber'); return; }
        ui.busy = true;
        setStatus(`Reading the flight-controller log (${fmtMB(bin.bytes.length)})…`);
        setTimeout(() => {
            const t0 = performance.now();
            try {
                const df = mlDfParse(bin.bytes);
                res.incidentDeep = mlIncidentDeep(df, res.esc, res.incident);
                if (res.siteGeo === undefined) {
                    try { res.siteGeo = mlSiteGeometry(res.roles); }
                    catch (e) { console.warn(`${TAG} site setup file in the archive could not be read — the map is drawn without flight paths and zones:`, e); res.siteGeo = null; }
                }
                console.log(`${TAG} incident review done in ${((performance.now() - t0) / 1000).toFixed(1)} s`, res.incidentDeep);
                setStatus(res.incidentDeep.ok ? `Incident review done · ${df.records.toLocaleString()} flight-controller records · ${((performance.now() - t0) / 1000).toFixed(1)} s` : `Incident review could not run: ${esc(res.incidentDeep.note)}`, res.incidentDeep.ok ? 'red' : 'amber');
            } catch (e) {
                console.error(`${TAG} incident review failed:`, e);
                res.incidentDeep = { ok: false, note: `the log could not be decoded (${e && e.message || e})` };
                setStatus(`Incident review failed: ${esc(e.message || e)}`, 'red');
            } finally { ui.busy = false; }
            if (lastResult === res) render(res);
        }, 30);
    }
    // One canvas, four stacked plots sharing the time axis.
    const INC_PLOTS = [
        { key: 'spd', label: 'Ground speed (mph)', series: [['#7adfe6', 'speed']] },
        { key: 'bx', label: 'Push along the body (g) — negative = pushed backwards', series: [['#7adfe6', 'push']] },
        { key: 'thr', label: 'Throttle (%)', series: [['#7adfe6', 'throttle']] },
        { key: 'att', label: 'Tilt (°)', series: [['#7adfe6', 'roll'], ['#ffb347', 'pitch']] },
    ];
    function incSeries(deep) {
        const c = deep.chart;
        return {
            spd: [{ t: c.gps.t, v: c.gps.Spd.map(x => x * 2.23694) }],
            bx: [{ t: c.imu.t, v: c.imu.bx }],
            thr: [c.thr ? { t: c.thr.t, v: c.thr.ThO.map(x => x * 100) } : { t: [], v: [] }],
            att: [{ t: c.att.t, v: c.att.Roll }, { t: c.att.t, v: c.att.Pitch }],
        };
    }
    function incDraw(cv, res, hoverT) {
        const deep = res.incidentDeep;
        const W = cv.clientWidth, H = cv.clientHeight;
        if (!deep || !deep.ok || !W || !H) return;
        const dpr = window.devicePixelRatio || 1;
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        const g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        g.font = '10px system-ui,sans-serif';
        const S = cv._aimSeries || (cv._aimSeries = incSeries(deep));
        const x0 = deep.chart.from, x1 = deep.chart.to, L = 40, R = 8, pw = Math.max(10, W - L - R);
        const top0 = 16, gap = 18, ph = (H - top0 - 18 - gap * (INC_PLOTS.length - 1)) / INC_PLOTS.length;
        const X = (t) => L + (t - x0) / (x1 - x0) * pw;
        const marks = deep.findings.filter(f => f.level === 'red' || f.level === 'amber');
        INC_PLOTS.forEach((p, pi) => {
            const y = top0 + pi * (ph + gap), ser = S[p.key];
            let lo = Infinity, hi = -Infinity;
            for (const s of ser) for (const v of s.v) { if (v < lo) lo = v; if (v > hi) hi = v; }
            if (!isFinite(lo)) { lo = 0; hi = 1; }
            if (p.key === 'spd' || p.key === 'thr') lo = 0;
            if (p.key === 'thr') hi = 100;
            if (p.key === 'bx' || p.key === 'att') { const m = Math.max(Math.abs(lo), Math.abs(hi), p.key === 'bx' ? 0.5 : 30); lo = -m; hi = m; }
            if (hi - lo < 1e-9) hi = lo + 1;
            const Y = (v) => y + ph - (v - lo) / (hi - lo) * ph;
            g.fillStyle = '#0b0e12'; g.fillRect(L, y, pw, ph);
            g.fillStyle = 'rgba(255,255,255,.12)'; if (lo < 0) g.fillRect(L, Y(0), pw, 1);
            g.save(); g.beginPath(); g.rect(L, y, pw, ph); g.clip();
            ser.forEach((s, si) => { g.strokeStyle = p.series[si][0]; g.lineWidth = 1.4; g.beginPath(); for (let k = 0; k < s.t.length; k++) { const px = X(s.t[k]), py = Y(s.v[k]); if (k) g.lineTo(px, py); else g.moveTo(px, py); } g.stroke(); });
            g.restore();
            const fmt = (v) => Math.abs(hi - lo) < 5 ? v.toFixed(1) : String(Math.round(v));
            g.fillStyle = '#888'; g.textAlign = 'right'; g.textBaseline = 'middle';
            g.fillText(fmt(hi), L - 4, y + 5); g.fillText(fmt(lo), L - 4, y + ph - 5); if (lo < 0) g.fillText('0', L - 4, Y(0));
            g.textAlign = 'left'; g.fillStyle = 'rgba(255,255,255,.6)';
            let lx = L + 4; g.fillText(p.label, lx, y - 7); lx += g.measureText(p.label).width + 12;
            if (p.series.length > 1) for (const [color, name] of p.series) { g.fillStyle = color; g.fillRect(lx, y - 9, 10, 3); g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText(name, lx + 14, y - 7); lx += g.measureText(name).width + 28; }
        });
        const yTop = top0, yBot = H - 18;
        // time axis
        const spanS = (x1 - x0) / 1000, step = [1, 2, 5, 10, 15, 30, 60, 120].find(v => spanS / v <= 8) || 300;
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#888';
        for (let t = Math.ceil(x0 / (step * 1000)) * step * 1000; t <= x1; t += step * 1000) { g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(X(t), yTop, 1, yBot - yTop); g.fillStyle = '#888'; g.fillText(mlHms(new Date(t)), X(t), H - 8); }
        // numbered event lines (same numbers as the table); labels step down so neighbours do not overlap
        let lastX = -99, row = 0;
        marks.forEach((f, i) => {
            if (f.t < x0 || f.t > x1) return;
            const x = X(f.t), col = f.level === 'red' ? '#ff5f5f' : '#ffb347';
            g.fillStyle = col; g.globalAlpha = 0.7; g.fillRect(x, yTop, 1, yBot - yTop); g.globalAlpha = 1;
            row = x - lastX < 14 ? row + 1 : 0; lastX = x;
            const ly = yTop + 7 + (row % 4) * 12;
            g.fillStyle = '#0e1115'; g.fillRect(x + 2, ly - 6, 13, 12); g.fillStyle = col; g.textAlign = 'left'; g.fillText(String(i + 1), x + 4, ly);
        });
        if (hoverT != null && hoverT >= x0 && hoverT <= x1) { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(X(hoverT), yTop, 1, yBot - yTop); }
        cv._aim = { x0, x1, L, pw };
    }
    function incRedraw() {
        const res = lastResult;
        if (!res || !ui.body) return;
        try { ui.body.querySelectorAll('canvas[data-aim-ml-inc-cv]').forEach(cv => incDraw(cv, res, null)); ui.body.querySelectorAll('canvas[data-aim-ml-inc-map]').forEach(cv => incMapDraw(cv, res, null)); }
        catch (e) { console.error(`${TAG} incident chart draw failed:`, e); }
    }
    function incWire(res) {
        ui.body.querySelectorAll('[data-aim-ml-inc-run]').forEach(b => b.addEventListener('click', () => incRun(res)));
        const cv = ui.body.querySelector('canvas[data-aim-ml-inc-cv]');
        if (!cv || !res.incidentDeep || !res.incidentDeep.ok) return;
        try { incMapWire(res); } catch (e) { console.error(`${TAG} incident map failed:`, e); }
        incDraw(cv, res, null);
        const ro = ui.body.querySelector('[data-aim-ml-inc-ro]'), idle = ro ? ro.innerHTML : '';
        const near = (s, t) => { if (!s.t.length) return null; let k = mlLowerBound(s.t, t); if (k >= s.t.length || (k > 0 && t - s.t[k - 1] < s.t[k] - t)) k--; return s.v[k]; };
        let raf = 0, pending = null;
        cv.addEventListener('pointermove', (ev) => {
            const a = cv._aim; if (!a) return;
            const r = cv.getBoundingClientRect(), x = Math.min(a.L + a.pw, Math.max(a.L, ev.clientX - r.left));
            pending = a.x0 + (x - a.L) / a.pw * (a.x1 - a.x0);
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                try {
                    const t = pending, S = cv._aimSeries;
                    incDraw(cv, res, t);
                    const n = (v, d) => v == null || !isFinite(v) ? '—' : v.toFixed(d);
                    if (ro && S) ro.innerHTML = `<b>${incT(t)} UTC</b> &nbsp; speed <b>${n(near(S.spd[0], t), 0)}</b> mph &nbsp;│&nbsp; push <b>${n(near(S.bx[0], t), 2)}</b> g &nbsp;│&nbsp; throttle <b>${n(near(S.thr[0], t), 0)}</b>% &nbsp;│&nbsp; roll <b>${n(near(S.att[0], t), 0)}</b>° &nbsp;│&nbsp; pitch <b>${n(near(S.att[1], t), 0)}</b>°`;
                } catch (e) { console.error(`${TAG} incident chart hover failed:`, e); }
            });
        });
        cv.addEventListener('pointerleave', () => { try { incDraw(cv, res, null); if (ro) ro.innerHTML = idle; } catch (e) { console.error(`${TAG} incident chart redraw failed:`, e); } });
    }

    // ---- v0.95: "Where it happened" map (own canvas, no tiles: works offline and in the saved report) ----
    const incMph = (ms) => ms * 2.23694;
    function incMapFrame(res, W, H) {
        const deep = res.incidentDeep, tr = deep.track;
        const marks = deep.findings.filter(f => f.level === 'red' || f.level === 'amber');
        const pts = []; for (let k = 0; k < tr.lat.length; k++) pts.push([tr.lat[k], tr.lon[k]]);
        for (const f of marks) if (f.pos) pts.push([f.pos.lat, f.pos.lon]);
        if (!pts.length) return null;
        let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
        for (const [la, lo] of pts) { if (la < la0) la0 = la; if (la > la1) la1 = la; if (lo < lo0) lo0 = lo; if (lo > lo1) lo1 = lo; }
        const latC = (la0 + la1) / 2, lonC = (lo0 + lo1) / 2, mLat = 110540, mLon = 111320 * Math.cos(latC * Math.PI / 180);
        // metres per pixel: fit the event with a 30% margin, never tighter than 90 m across
        const spanX = Math.max((lo1 - lo0) * mLon, 90), spanY = Math.max((la1 - la0) * mLat, 90);
        const mpp = Math.max(spanX / (W * 0.7), spanY / (H * 0.7));
        return { marks, mpp, X: (lon) => W / 2 + (lon - lonC) * mLon / mpp, Y: (lat) => H / 2 - (lat - latC) * mLat / mpp, mLat, mLon };
    }
    function incMapDraw(cv, res, hoverK) {
        const deep = res.incidentDeep;
        const W = cv.clientWidth, H = cv.clientHeight;
        if (!deep || !deep.ok || !deep.track || !W || !H) return;
        const fr = incMapFrame(res, W, H);
        if (!fr) return;
        const dpr = window.devicePixelRatio || 1;
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        const g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = '#0b0e12'; g.fillRect(0, 0, W, H);
        g.font = '10px system-ui,sans-serif'; g.lineJoin = 'round'; g.lineCap = 'round';
        const { X, Y } = fr, geo = res.siteGeo, tr = deep.track;
        const inView = (ring) => ring.some(([la, lo]) => { const x = X(lo), y = Y(la); return x > -W && x < 2 * W && y > -H && y < 2 * H; });
        const poly = (ring) => { g.beginPath(); ring.forEach(([la, lo], i) => { if (i) g.lineTo(X(lo), Y(la)); else g.moveTo(X(lo), Y(la)); }); g.closePath(); };
        const labels = [];
        if (geo) {
            for (const z of geo.ffz) if (inView(z.ring)) { poly(z.ring); g.fillStyle = 'rgba(95,255,95,.06)'; g.fill(); g.strokeStyle = '#3c9a3c'; g.lineWidth = 1.5; g.stroke(); const cx = z.ring.reduce((a, p) => a + X(p[1]), 0) / z.ring.length, cy = z.ring.reduce((a, p) => a + Y(p[0]), 0) / z.ring.length; if (cx > 0 && cx < W && cy > 0 && cy < H) labels.push([z.name, cx, cy]); }
            for (const z of geo.nfz) if (inView(z.ring)) { poly(z.ring); g.fillStyle = 'rgba(255,95,95,.10)'; g.fill(); g.strokeStyle = '#c04a4a'; g.lineWidth = 1.5; g.stroke(); }
            g.strokeStyle = '#c9c9d6'; g.lineWidth = 1.5; g.setLineDash([6, 5]);
            for (const r of geo.routes) for (const [a, b, c, d] of r.segs) { const x1 = X(b), y1 = Y(a), x2 = X(d), y2 = Y(c); if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > W || Math.max(y1, y2) < 0 || Math.min(y1, y2) > H) continue; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
            g.setLineDash([]);
        }
        // whole flight, faint
        g.strokeStyle = '#55617a'; g.lineWidth = 1; g.beginPath();
        tr.flight.forEach(([la, lo], i) => { if (i) g.lineTo(X(lo), Y(la)); else g.moveTo(X(lo), Y(la)); }); g.stroke();
        // the event window: before / after the first abnormal moment
        const kSplit = deep.first ? mlLowerBound(tr.t, deep.first.t) : tr.t.length;
        const seg = (a, b, color) => { if (b - a < 2) return; g.strokeStyle = '#0b0e12'; g.lineWidth = 5; g.beginPath(); for (let k = a; k < b; k++) { if (k > a) g.lineTo(X(tr.lon[k]), Y(tr.lat[k])); else g.moveTo(X(tr.lon[k]), Y(tr.lat[k])); } g.stroke(); g.strokeStyle = color; g.lineWidth = 2.5; g.stroke(); };
        seg(0, Math.min(tr.t.length, kSplit + 1), '#7adfe6'); seg(Math.max(0, kSplit), tr.t.length, '#ffb347');
        // direction of travel: an arrowhead on the "before" part
        if (kSplit > 12) { const k = Math.max(6, Math.floor(kSplit * 0.5)), x = X(tr.lon[k]), y = Y(tr.lat[k]), ang = Math.atan2(y - Y(tr.lat[k - 5]), x - X(tr.lon[k - 5])); g.fillStyle = '#7adfe6'; g.beginPath(); g.moveTo(x + 9 * Math.cos(ang), y + 9 * Math.sin(ang)); g.lineTo(x + 6 * Math.cos(ang + 2.5), y + 6 * Math.sin(ang + 2.5)); g.lineTo(x + 6 * Math.cos(ang - 2.5), y + 6 * Math.sin(ang - 2.5)); g.closePath(); g.fill(); }
        // FFZ names
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(140,200,140,.75)';
        for (const [name, x, y] of labels.slice(0, 12)) g.fillText(name.replace(/^FFZ - /, ''), x, y);
        // numbered moments; markers that land on top of each other share one dot and list their numbers
        const groups = [];
        fr.marks.forEach((f, i) => { if (!f.pos) return; const x = X(f.pos.lon), y = Y(f.pos.lat); const gph = groups.find(q => Math.hypot(q.x - x, q.y - y) < 13); if (gph) { gph.n.push(i + 1); if (f.level === 'red') gph.red = true; } else groups.push({ x, y, n: [i + 1], red: f.level === 'red' }); });
        for (const q of groups) {
            const col = q.red ? '#ff5f5f' : '#ffb347', txt = q.n.join(' · ');
            g.fillStyle = '#0b0e12'; g.beginPath(); g.arc(q.x, q.y, 7, 0, 6.2832); g.fill();
            g.fillStyle = col; g.beginPath(); g.arc(q.x, q.y, 5, 0, 6.2832); g.fill();
            g.font = '700 11px system-ui,sans-serif'; g.textAlign = 'left';
            const w = g.measureText(txt).width + 8;
            const crowded = groups.some(o => o !== q && o.x > q.x && o.x < q.x + w + 22 && Math.abs(o.y - q.y) < 14);   // a neighbour sits where the label would go
            const lx = (q.x + 10 + w > W || crowded) && q.x - 10 - w > 0 ? q.x - 10 - w : q.x + 10;
            g.fillStyle = 'rgba(11,14,18,.85)'; g.fillRect(lx, q.y - 8, w, 16); g.fillStyle = col; g.fillText(txt, lx + 4, q.y);
            g.font = '10px system-ui,sans-serif';
        }
        if (hoverK != null && hoverK >= 0 && hoverK < tr.t.length) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(X(tr.lon[hoverK]), Y(tr.lat[hoverK]), 6, 0, 6.2832); g.stroke(); }
        // scale bar (feet) + north
        const ftPerPx = fr.mpp * 3.28084, nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find(v => v / ftPerPx >= 70) || 10000, bw = nice / ftPerPx;
        g.fillStyle = 'rgba(11,14,18,.8)'; g.fillRect(8, H - 28, bw + 16, 22);
        g.fillStyle = '#ddd'; g.fillRect(16, H - 12, bw, 2); g.fillRect(16, H - 16, 1, 6); g.fillRect(16 + bw - 1, H - 16, 1, 6);
        g.textAlign = 'center'; g.fillText(`${nice.toLocaleString()} ft`, 16 + bw / 2, H - 20);
        g.fillStyle = 'rgba(11,14,18,.8)'; g.fillRect(W - 30, 8, 22, 34); g.fillStyle = '#ddd'; g.fillText('N', W - 19, 16);
        g.beginPath(); g.moveTo(W - 19, 22); g.lineTo(W - 14, 36); g.lineTo(W - 19, 32); g.lineTo(W - 24, 36); g.closePath(); g.fill();
        cv._aim = { X, Y };
    }
    // Which planned flight path was the first abnormal moment on? (distance to the nearest segment, never to a vertex)
    function incNearestRoute(res) {
        const deep = res.incidentDeep, geo = res.siteGeo, f = deep && deep.first;
        if (!geo || !f || !f.pos) return '';
        const mLat = 110540, mLon = 111320 * Math.cos(f.pos.lat * Math.PI / 180);
        let best = null;
        for (const r of geo.routes) for (const [a, b, c, d] of r.segs) {
            const ax = (b - f.pos.lon) * mLon, ay = (a - f.pos.lat) * mLat, bx = (d - f.pos.lon) * mLon, by = (c - f.pos.lat) * mLat;
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, u = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
            const dist = Math.hypot(ax + u * dx, ay + u * dy);
            if (!best || dist < best.dist) best = { dist, name: r.name };
        }
        if (!best) return '';
        const ft = Math.round(best.dist * 3.28084);
        return `The first abnormal moment was <b>${ft} ft</b> from the planned flight path “${esc(best.name)}”${ft <= 30 ? ' — on its path' : ' — off its path'}. `;
    }
    function incMapWire(res) {
        const cv = ui.body.querySelector('canvas[data-aim-ml-inc-map]');
        if (!cv) return;
        incMapDraw(cv, res, null);
        const ro = ui.body.querySelector('[data-aim-ml-inc-mro]'), idle = ro ? ro.innerHTML : '';
        const deep = res.incidentDeep, tr = deep.track, gps = deep.chart.gps;
        let raf = 0, last = null;
        cv.addEventListener('pointermove', (ev) => {
            last = ev;
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                try {
                    const a = cv._aim; if (!a) return;
                    const r = cv.getBoundingClientRect(), mx = last.clientX - r.left, my = last.clientY - r.top;
                    let bk = -1, bd = 18 * 18;
                    for (let k = 0; k < tr.t.length; k++) { const dx = a.X(tr.lon[k]) - mx, dy = a.Y(tr.lat[k]) - my, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; bk = k; } }
                    incMapDraw(cv, res, bk >= 0 ? bk : null);
                    if (!ro) return;
                    if (bk < 0) { ro.innerHTML = idle; return; }
                    const gk = Math.min(gps.t.length - 1, mlLowerBound(gps.t, tr.t[bk]));
                    ro.innerHTML = `<b>${incT(tr.t[bk])} UTC</b> &nbsp; speed <b>${gps.t.length ? Math.round(incMph(gps.Spd[gk])) : '—'}</b> mph &nbsp;│&nbsp; <b>${Math.round((tr.alt[bk] - deep.alt0) * 3.28084)}</b> ft above the takeoff point &nbsp;│&nbsp; <span class="m">${tr.lat[bk].toFixed(6)}, ${tr.lon[bk].toFixed(6)}</span>`;
                } catch (e) { console.error(`${TAG} incident map hover failed:`, e); }
            });
        });
        cv.addEventListener('pointerleave', () => { try { incMapDraw(cv, res, null); if (ro) ro.innerHTML = idle; } catch (e) { console.error(`${TAG} incident map redraw failed:`, e); } });
    }

    // ---------------- v0.92 — ⬇ Report: the analysis on screen as one HTML file ----------------
    function setExportEnabled(on) {
        const b = ui.panel && ui.panel.querySelector('#aim-ml-export');
        if (b) b.disabled = !on;
        const z = ui.panel && ui.panel.querySelector('#aim-ml-zip');
        if (z) z.disabled = !(on && lastResult && lastResult.archives && lastResult.archives.length);
    }
    // Charts are canvases — a saved page cannot redraw them, so each becomes a picture.
    // A canvas inside a closed "Technical details" has no size and was never drawn: open those
    // for the capture, then put them back the way the user had them (all in one task, no flicker).
    function exportChartImages() {
        const closed = [];
        const all = () => Array.from(ui.body.querySelectorAll('canvas[data-aim-ml-esc-cv], canvas[data-aim-ml-inc-cv], canvas[data-aim-ml-inc-map]'));
        for (const cv of all()) {
            for (let d = cv.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
                if (!d.open) { d.open = true; closed.push(d); }
            }
        }
        const shots = [];
        try {
            if (closed.length) escRedrawAll();
            for (const cv of all()) {
                let url = null;
                try { if (cv.width && cv.height && cv._aim) url = cv.toDataURL('image/png'); }
                catch (e) { console.warn(`${TAG} chart capture failed for ${cv.getAttribute('data-aim-ml-esc-cv') || 'incident'}:`, e); }
                shots.push(url);
            }
        } finally { for (const d of closed) d.open = false; }
        return shots;
    }
    function exportHtmlReport() {
        const res = lastResult;
        if (!res || !ui.body || !ui.body.children.length) { setStatus('Nothing to export yet — analyze a mission first.', 'amber'); return; }
        const shots = exportChartImages();
        const clone = ui.body.cloneNode(true);
        const cvs = Array.from(clone.querySelectorAll('canvas[data-aim-ml-esc-cv], canvas[data-aim-ml-inc-cv], canvas[data-aim-ml-inc-map]'));
        let missing = 0;
        cvs.forEach((cv, i) => {
            const url = shots[i];
            if (!url) { missing++; const d = document.createElement('div'); d.className = 'a'; d.textContent = '⚠ This chart could not be captured — open the mission in AIM Mission Logs to see it.'; cv.replaceWith(d); return; }
            const img = document.createElement('img');
            img.src = url; img.alt = cv.hasAttribute('data-aim-ml-inc-map') ? 'map of where it happened' : `${cv.getAttribute('data-aim-ml-esc-cv') || 'incident'} chart`; img.className = 'aim-ml-chart';
            cv.replaceWith(img);
        });
        // live-only pieces: raw-file downloads, buttons, chart controls, hover readout, "click here" hints
        const filesCard = clone.querySelector('[data-aim-ml-dl]');
        if (filesCard && filesCard.closest('.aim-ml-card')) filesCard.closest('.aim-ml-card').remove();
        clone.querySelectorAll('button, .aim-ml-esc-ctl, [data-aim-ml-esc="readout"], [data-aim-ml-inc-ro], [data-aim-ml-inc-mro]').forEach(el => el.remove());
        clone.querySelectorAll('[data-aim-ml-live]').forEach(el => { const li = el.closest('li'); el.remove(); if (li && !li.textContent.trim()) li.remove(); });
        clone.querySelectorAll('[data-aim-ml-ll], [data-aim-ml-esc-zoom]').forEach(el => { el.removeAttribute('title'); el.style.cursor = ''; });
        const zoomed = !!escUi.view && clone.querySelectorAll('img.aim-ml-chart').length > (res.incidentDeep && res.incidentDeep.ok ? 2 : 0);

        const mj = res.meta.json || {}, m = res.extra.mission || {};
        const site = mj.site_name || (m.site && m.site.name) || '';
        const drone = mj.vehicle_name || (m.drone && m.drone.name) || '';
        const appName = m.app && m.app.name ? m.app.name : '';
        const start = mj.start_time || m.when || '';
        const now = new Date();
        const made = `${now.getFullYear()}-${mlPad(now.getMonth() + 1)}-${mlPad(now.getDate())} ${mlPad(now.getHours())}:${mlPad(now.getMinutes())}`;
        const title = `Mission ${res.missionId}${appName ? ' · ' + appName : ''} — log report`;
        const styleEl = document.getElementById('aim-ml-style');
        const css = (styleEl ? styleEl.textContent : '') + `
            html,body{margin:0;background:#0e1115;color:#ddd;font:12px/1.45 system-ui,sans-serif}
            #aim-ml-report{max-width:980px;margin:0 auto;padding:18px 16px 40px}
            #aim-ml-report>header{margin-bottom:12px}
            #aim-ml-report h1{margin:0 0 4px;font-size:18px;color:#7adfe6;font-weight:700}
            #aim-ml-report .sub{color:#aaa}
            #aim-ml-report #aim-ml-body{overflow:visible;padding:0}
            img.aim-ml-chart{display:block;width:100%;height:auto;border-radius:4px}
            @media print{
                html,body{background:#fff;color:#111}
                #aim-ml-report h1,.aim-ml-card>h4,.aim-ml-tech>summary,.c{color:#0b6a72}
                .aim-ml-card,.aim-ml-bottom,.aim-ml-verdict{background:#fff !important;border-color:#bbb !important;break-inside:avoid}
                .aim-ml-card>h4,table.aim-ml th,table.aim-ml td{border-color:#ccc}
                .aim-ml-plain b{color:#000}
                .g{color:#1a7f1a}.a{color:#a05a00}.r{color:#c01818}.m,#aim-ml-report .sub,table.aim-ml th,.aim-ml-kv span:nth-child(odd){color:#666}
                .aim-ml-mono{color:#333}
            }`;
        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${css}</style></head>
<body><div id="aim-ml-report">
<header><h1>${esc(title)}</h1>
<div class="sub">${[site, drone, start ? 'started ' + start + ' UTC' : ''].filter(Boolean).map(esc).join(' · ')}</div>
<div class="sub">All times are UTC. ${viewMode === 'advanced' ? 'Advanced view.' : 'Simple view — open “Technical details” under a section for the full numbers.'}${cvs.length ? ` Charts are pictures${zoomed ? ', zoomed the way they were on screen when this was saved' : ''}.` : ''}</div>
<div class="sub">Saved ${esc(made)} from AIM Mission Logs v${SCRIPT_VERSION}${IS_QA ? ' (QA server)' : ''}.</div></header>
<div id="aim-ml-body">${clone.innerHTML}</div>
</div>
<script>addEventListener('beforeprint',function(){document.querySelectorAll('details').forEach(function(d){d.open=true;});});<\/script>
</body></html>`;
        const safe = (x) => String(x).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
        const name = ['Mission', res.missionId, safe(site), 'log_report'].filter(Boolean).join('_') + '.html';
        const blob = new Blob([html], { type: 'text/html' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        console.log(`${TAG} HTML report saved: ${name} (${fmtMB(blob.size)}, ${cvs.length - missing}/${cvs.length} charts)`);
        setStatus(`Saved ${esc(name)} (${fmtMB(blob.size)})${missing ? ` — ${missing} chart(s) could not be captured, see console` : ''}`, missing ? 'amber' : 'green');
    }

    // ---------------- dashboard injection ----------------
    function injectLauncher() {
        const have = document.getElementById('aim-ml-launch');
        // v0.96 — not on a site's Mission Log: the corner there belongs to Percepto's own buttons, and every row has 🔎 AIM
        const kind = routeKind();
        if (!masterEnabled || !kind || kind === 'log') { if (have) have.remove(); return; }
        if (have) return;
        ensureStyles();
        const b = document.createElement('button');
        b.id = 'aim-ml-launch'; b.textContent = '🔎 Logs';
        b.title = 'AIM Mission Logs — analyze a mission\'s log archives in place';
        b.addEventListener('click', () => openPanel(null));
        document.body.appendChild(b);
    }

    // Mission rows are anchored on the dashboard's own "Get App Logs" control (one per mission), not on
    // <table>/<thead> structure, which the dashboard may not use. The mission ID comes from the row's
    // ID column when a header row is found, else from the largest ≥6-digit number in the row (mission
    // IDs are 6+ digits; mission-group IDs are shorter).
    function findMissionRows() {
        const out = [];
        const anchors = Array.from(document.querySelectorAll('button, a, span, div, td')).filter(el => el.children.length === 0 && /^\s*Get App Logs\s*$/i.test(el.textContent || ''));
        for (const a of anchors) {
            let row = a.closest('tr, [role="row"]');
            if (!row) { row = a.parentElement; for (let i = 0; i < 6 && row; i++) { const txt = row.textContent || ''; if (/\d{5,}/.test(txt) && /Get App Logs/.test(txt) && (txt.match(/\d{5,}/g) || []).length >= 1 && row.children.length >= 4) break; row = row.parentElement; } }
            if (!row) continue;
            let id = null;
            const table = row.closest('table');
            const headRow = table && Array.from(table.querySelectorAll('tr')).find(tr => Array.from(tr.children).some(c => (c.textContent || '').trim().toUpperCase() === 'ID'));
            if (headRow && row.children.length === headRow.children.length) {
                const idx = Array.from(headRow.children).findIndex(c => (c.textContent || '').trim().toUpperCase() === 'ID');
                const v = (row.children[idx].textContent || '').trim();
                if (/^\d{3,9}$/.test(v)) id = v;
            }
            if (!id) {
                const nums = (row.textContent.match(/\b\d{6,9}\b/g) || []).map(Number);
                if (nums.length) id = String(Math.max(...nums));
            }
            if (id) out.push({ id, row, anchor: a });
        }
        return out;
    }

    let lastRowLog = '';
    function injectRowButtons() {
        if (!masterEnabled) { document.querySelectorAll('.aim-ml-row-btn').forEach(b => b.remove()); document.querySelectorAll('[data-aim-ml]').forEach(r => r.removeAttribute('data-aim-ml')); lastRowLog = ''; return; }
        const rows = findMissionRows();
        const sig = rows.map(r => r.id).join(',');
        if (sig !== lastRowLog) { lastRowLog = sig; console.log(`${TAG} mission rows detected: ${rows.length}${rows.length ? ' → ' + sig : ' (no "Get App Logs" controls on the page yet)'}`); }
        for (const { id, row, anchor } of rows) {
            if (row.getAttribute('data-aim-ml') === id) continue;
            row.setAttribute('data-aim-ml', id);
            row.querySelectorAll('.aim-ml-row-btn').forEach(b => b.remove());
            const btn = document.createElement('span');
            btn.className = 'aim-ml-row-btn'; btn.textContent = '🔎 AIM'; btn.title = `AIM Mission Logs — analyze mission ${id} in place`;
            btn.setAttribute('data-aim-ml-id', id);
            btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPanel(id); analyzeMission(id); }, true);
            const host = anchor.closest('td, [role="cell"]') || anchor.parentElement;
            host.appendChild(btn);
        }
    }

    // v0.93 — a site's Mission Log: native Ant table inside the same-origin react-pages iframe. Every row carries
    // data-row-key="mission-<id>". Our button is found by data-* (React rewrites className) and styled inline
    // (the iframe has its own document, so the panel stylesheet does not reach it).
    const SITE_ROW_SEL = 'tr.ant-table-row[data-row-key^="mission-"]';
    function siteLogDocs() {
        const docs = [document];
        for (const f of document.querySelectorAll('iframe')) { const d = f.contentDocument; if (d && d.body) docs.push(d); }   // contentDocument is null for a cross-origin frame
        return docs;
    }
    function removeSiteRowButtons() { for (const d of siteLogDocs()) d.querySelectorAll('[data-aim-ml-row]').forEach(b => b.remove()); }
    let lastSiteRowLog = '';
    function injectSiteRowButtons() {
        if (!masterEnabled || routeKind() !== 'log') { if (lastSiteRowLog) { removeSiteRowButtons(); lastSiteRowLog = ''; } return; }
        let n = 0;
        for (const d of siteLogDocs()) {
            for (const tr of d.querySelectorAll(SITE_ROW_SEL)) {
                const m = (tr.getAttribute('data-row-key') || '').match(/^mission-(\d+)$/);
                if (!m) continue;
                const id = m[1];
                n++;
                const old = tr.querySelector('[data-aim-ml-row]');
                if (old && old.getAttribute('data-aim-ml-row') === id) continue;
                if (old) old.remove();                                   // React reused the row for another mission
                const cell = tr.querySelector('.action-column-cell') || tr.lastElementChild;
                if (!cell) continue;
                const btn = d.createElement('span');
                btn.setAttribute('data-aim-ml-row', id);
                btn.textContent = '🔎 AIM';
                btn.title = `AIM Mission Logs — analyze mission ${id}'s logs`;
                btn.style.cssText = 'display:inline-block;margin-right:6px;padding:1px 6px;border:1px solid #2a3240;border-radius:4px;background:#0e1115;color:#7adfe6;font-size:11px;line-height:1.5;cursor:pointer;vertical-align:middle;white-space:nowrap';
                // the row itself is clickable (opens playback) — keep our click from reaching it
                const stop = (e) => e.stopPropagation();
                btn.addEventListener('mousedown', stop); btn.addEventListener('pointerdown', stop);
                btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPanel(id); analyzeMission(id); });
                cell.insertBefore(btn, cell.firstChild);
            }
        }
        const sig = 'rows:' + n;
        if (sig !== lastSiteRowLog) { lastSiteRowLog = sig; console.log(`${TAG} site Mission Log rows detected: ${n}${n ? '' : ' (table not on the page yet)'}`); }
    }
    function siteTick() { try { injectLauncher(); injectSiteRowButtons(); } catch (e) { console.warn(`${TAG} site inject error`, e); } }

    let injectTimer = null;
    function scheduleInject() { if (injectTimer) return; injectTimer = setTimeout(() => { injectTimer = null; try { injectLauncher(); injectRowButtons(); } catch (e) { console.warn(`${TAG} inject error`, e); } }, 300); }

    // ---------------- Control Panel (harmless if the panel isn't on this page) ----------------
    let controlChannel = null;
    function setupControlPanel() {
        try { controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME); } catch (e) { console.warn(`${TAG} control channel unavailable:`, e); return; }
        controlChannel.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'REQUEST_REGISTRATIONS') registerWithControlPanel();
            else if (msg.type === 'SET_TOGGLE' && msg.scriptId === SCRIPT_ID) {
                const v = msg.value !== undefined ? msg.value : msg.enabled;
                if (msg.toggleId === 'master') { masterEnabled = !!v; if (ON_DASH) scheduleInject(); else siteTick(); if (!masterEnabled && ui.panel) ui.panel.style.display = 'none'; }
                else if (msg.toggleId === 'daa') { wantDaa = !!v; const cb = document.getElementById('aim-ml-daa'); if (cb) cb.checked = wantDaa; }
            }
        };
    }
    function registerWithControlPanel() {
        if (!controlChannel) return;
        try {
            controlChannel.postMessage({
                type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Mission Logs', version: SCRIPT_VERSION, group: 'Fleet',
                toggles: [
                    { id: 'master', label: 'Enable Mission Logs (🔎 on the dashboard, Mission Log and Playback)', type: 'boolean', default: true, master: true },
                    { id: 'daa', label: 'Also fetch the DAA (ADS-B/radar) archive', type: 'boolean', default: true },
                ],
                hotkeys: [],
            });
        } catch (e) { console.warn(`${TAG} register failed`, e); }
    }

    // ---------------- boot ----------------
    setupControlPanel();
    registerWithControlPanel();
    // v0.91 — deep link: /dashboard/?aim-ml=<mission id> opens the panel and analyzes that mission (Fleet Tools ⚙ ESC Sweep rows link here)
    try {
        const deep = new URLSearchParams(location.search).get('aim-ml');
        if (deep && /^\d{1,12}$/.test(deep)) setTimeout(() => { try { openPanel(deep); analyzeMission(deep); } catch (e) { console.error(`${TAG} deep link failed:`, e); } }, 1200);
        else if (deep) console.warn(`${TAG} deep link ignored — aim-ml must be a mission id, got:`, deep);
    } catch (e) { console.warn(`${TAG} deep link parse failed:`, e); }
    if (ON_DASH) {
        scheduleInject();
        new MutationObserver(scheduleInject).observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('hashchange', scheduleInject);
    } else {
        // The site app is heavy: no subtree observer here. A light tick that does nothing off the two routes.
        siteTick();
        setInterval(siteTick, 1500);
        window.addEventListener('hashchange', siteTick);
    }
    console.log(`${TAG} ready v${SCRIPT_VERSION} — ${ON_DASH ? '🔎 Logs launcher + per-row buttons on the All Missions table' : '🔎 on a site\'s Mission Log rows + Mission Playback'}`);
})();
