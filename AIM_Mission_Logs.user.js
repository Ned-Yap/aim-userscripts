// ==UserScript==
// @name         AIM Mission Logs
// @namespace    http://tampermonkey.net/
// @version      0.8
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Logs.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Logs.user.js
// @description  v0.8: Signal KML points, pins and track sit at the drone's flown altitude (absolute MSL, extruded to the ground) instead of clamped to the ground. v0.7: names the CARRIER from the LTE bands the modem camped on (B13 = Verizon-only spectrum, B14/B17/B29/B30 = AT&T, B71/B41/B25/B26 = T-Mobile; shared bands prove nothing); every outage, handover and the worst-signal sample now carries the drone's position at that moment (click 📍 to copy lat,lng — paste into Map Nav 🧭); 📍 Signal KML button exports the flown track with each signal sample colored Good/Fair/Weak/Edge plus outage and handover pins (open in Google Earth or Fleet Tools → KML Layers) to see WHERE the link was bad. v0.6: outage detection now also uses 100%-loss ping runs, IP-lease loss (udhcpc deconfigured→bound) and LTE-manager restarts — a reconnect the TCP checks never saw (238589) was reported as 'dropped 0 times' in red; outages are tagged before takeoff / in flight / after landing and the Simple card downgrades a drop that happened on the base to amber. v0.5: Simple / Advanced view toggle (remembered) — Simple is plain English for pilots and customers: one bold bottom line per card + bullets (signal as bars, response time, packet loss, blips, tower hopping, what to do) with the full technical card under 'Technical details ▸'. v0.4: reads the older EM7565 modem's status fields (RSRP_(dBm) / PCC_RxM_RSSI / Tx_Power) — v0.3 saw no RSRP and flagged a false 33-min outage; a sample is lost only with no band / stuck handover / no cell+no RSRP; isolated 10 s TCP blips = amber POOR link (loss %, avg/worst rtt) not red; unknown formats raise a ⚠ with lte.rawSample; mission duration is ms. v0.3: LTE card gains an Outages line (each loss window with start → recovery and duration, from no-cell / stuck-handover samples and failing TCP checks) and a Coverage line (median RSRP, % weak / very weak / no cell); dropped verdict names the outages. v0.2: row 🔎 anchors on the dashboard's own Get App Logs control (not table structure); prefill from the FILTER box or the single visible row only; server reply shown when a mission has no archive. Pull a mission's log archives straight from the Mission Dashboard (no download → unzip → hunt) and extract what matters: LTE link health (modem registration, TCP/ping checks, signal, cell handovers, RTK-stream gaps), mission event timeline (stages, aborts, go-to-base), DAA aircraft with closest approach to the drone, warnings/errors by process. v0.1 (#286): POC on percepto.app/dashboard — 🔎 per mission row + floating launcher; engine (fetch → gunzip → untar → extractors) is self-contained for the later Fleet Tools site/date sweep.
// @author       Payden
// @match        *://percepto.app/dashboard*
// @match        *://qa.percepto.app/dashboard*
// @connect      d2lb831xgi5b1q.cloudfront.net
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

// AIM Mission Logs — reads a mission's app-log + DAA archives in memory and
// turns them into answers ("did LTE drop?", "why did it abort?", "what was
// the aircraft?") without the download → unzip → grep loop.
// Pages: the Mission Dashboard (/dashboard/#/, All Missions table).
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
    const SCRIPT_VERSION = '0.8';
    const CONTROL_CHANNEL_NAME = 'AIM_CONTROL_CHANNEL';
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
        const abortEv = events.aborts.find(e => /droneErr|safetyInit/.test(e.type)) || events.aborts[0] || null;
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
        return { roles, files, meta, events, lte, daa, droneTrack, warnings, abortEv, extra: extra || {}, syslogLineCount: syslogLines.length };
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
                <button id="aim-ml-close" title="Close">✕</button>
            </div>
            <div id="aim-ml-status">Enter a mission ID (or click 🔎 on a table row) and press Analyze.</div>
            <div id="aim-ml-body"></div>`;
        document.body.appendChild(p);
        ui.panel = p; ui.status = p.querySelector('#aim-ml-status'); ui.body = p.querySelector('#aim-ml-body');
        p.querySelector('#aim-ml-close').addEventListener('click', () => { p.style.display = 'none'; });
        p.querySelector('#aim-ml-run').addEventListener('click', () => { const v = p.querySelector('#aim-ml-id').value.trim(); if (/^\d+$/.test(v)) analyzeMission(v); else setStatus('Mission ID must be a number.', 'red'); });
        p.querySelector('#aim-ml-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') p.querySelector('#aim-ml-run').click(); });
        p.querySelector('#aim-ml-daa').addEventListener('change', (e) => { wantDaa = !!e.target.checked; });
        p.querySelectorAll('#aim-ml-mode button').forEach(b => b.addEventListener('click', () => setViewMode(b.getAttribute('data-mode'))));
        setViewMode(viewMode);
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
            let files = mlUntar(await mlGunzip(appBytes));
            if (wantDaa) {
                try {
                    setStatus(`Asking for the DAA archive link…`);
                    const daaLink = await mlGetJson(`/missions/${missionId}/logs/daa_file/`);
                    if (daaLink && daaLink.download_link) {
                        const daaBytes = await mlFetchBinary(daaLink.download_link, (l, t) => setStatus(`Downloading DAA logs… ${fmtMB(l)}${t ? ' / ' + fmtMB(t) : ''}`));
                        files = files.concat(mlUntar(await mlGunzip(daaBytes)));
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
        addCard('files', card('🗂 Files', `<div style="display:flex;flex-wrap:wrap;gap:6px">${dl}</div><div class="m" style="margin-top:6px">Full result object: <code>window.__aimMissionLogs</code> in the console.</div>`));
        ui.body.innerHTML = viewMode === 'advanced' ? parts.join('') : renderSimple(res, adv);
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
        const ended = abort ? `It was <b>cut short at ${mlHms(abort.t)} UTC</b> because ${abortPlain(abort.type)}, and it flew home.` : (td ? 'It flew its plan and landed normally.' : 'No landing was recorded in these logs.');
        out.push(simpleCard(`🛸 Mission ${esc(res.missionId)}${m.app && m.app.name ? ' · ' + esc(m.app.name) : ''}`, abort ? 'amber' : 'green',
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
        if (lte.outages.length && lte.verdict.level !== 'red') lteBullets.push(`<b>Blips:</b> ${lte.outages.map(w => `${mlHms(w.from)} (${w.s} s)${pin(w.at)}`).join(', ')} — came back on its own each time. Click 📍 to copy where it happened.`);
        if (lte.outages.some(w => w.at) || lte.handovers.some(h => h.at)) lteBullets.push(`<b>Where:</b> 📍 Signal KML (top right of this card) maps every signal reading along the flight, colored good → weak, with the blips and tower switches pinned — open it in Google Earth or Fleet Tools → KML Layers.`);
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
        if (abort) evBullets.push(`<b>${mlHms(abort.t)}:</b> mission stopped because ${abortPlain(abort.type)}${events.aborts.length > 1 ? `; then ${events.aborts.slice(1).map(a => `${mlHms(a.t)} ${abortPlain(a.type)}`).join('; ')}` : ''}.`);
        const warnEv = events.all.filter(e => /_warn_/.test(e.type) && !/mainLoopStall/.test(e.type));
        if (warnEv.length) evBullets.push(`Other warnings from the drone: ${Array.from(new Set(warnEv.map(e => abortPlain(e.type)))).slice(0, 5).map(esc).join(', ')}.`);
        out.push(simpleCard('🧭 What happened', abort ? 'amber' : 'green', abort ? `The mission <b>did not finish</b>: ${abortPlain(abort.type)} at ${mlHms(abort.t)} UTC and the drone returned to base.` : `The mission <b>ran start to finish</b> with no safety events.`, evBullets, tech('events', adv), copyBtn('events')));

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
        else if (key === 'warnings') rows = [['Process', 'Count', 'First UTC', 'Sample'], ...res.warnings.map(w => [w.proc, w.n, mlHms(w.first), w.samples.map(s => s.msg).join(' | ')])];
        const tsv = rows.map(r => r.map(c => String(c == null ? '' : c).replace(/\t|\n/g, ' ')).join('\t')).join('\n');
        const html = `<table>${rows.map((r, i) => `<tr>${r.map(c => `<t${i === 0 ? 'h' : 'd'}>${esc(c)}</t${i === 0 ? 'h' : 'd'}>`).join('')}</tr>`).join('')}</table>`;
        try {
            if (navigator.clipboard && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([tsv], { type: 'text/plain' }) })]);
            else await navigator.clipboard.writeText(tsv);
            const old = btn.textContent; btn.textContent = '✓ copied'; setTimeout(() => { btn.textContent = old; }, 1500);
        } catch (e) { console.warn(`${TAG} clipboard failed`, e); btn.textContent = '✗ clipboard'; }
    }

    // ---------------- dashboard injection ----------------
    function injectLauncher() {
        if (document.getElementById('aim-ml-launch')) return;
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
                if (msg.toggleId === 'daa') { wantDaa = !!v; const cb = document.getElementById('aim-ml-daa'); if (cb) cb.checked = wantDaa; }
            }
        };
    }
    function registerWithControlPanel() {
        if (!controlChannel) return;
        try {
            controlChannel.postMessage({
                type: 'REGISTER', scriptId: SCRIPT_ID, name: 'Mission Logs', version: SCRIPT_VERSION, group: 'Fleet',
                toggles: [
                    { id: 'master', label: 'Enable Mission Logs (dashboard 🔎)', type: 'boolean', default: true, master: true },
                    { id: 'daa', label: 'Also fetch the DAA (ADS-B/radar) archive', type: 'boolean', default: true },
                ],
                hotkeys: [],
            });
        } catch (e) { console.warn(`${TAG} register failed`, e); }
    }

    // ---------------- boot ----------------
    setupControlPanel();
    registerWithControlPanel();
    scheduleInject();
    new MutationObserver(scheduleInject).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', scheduleInject);
    console.log(`${TAG} ready v${SCRIPT_VERSION} — 🔎 Logs launcher + per-row buttons on the All Missions table`);
})();
