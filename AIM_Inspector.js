// ==UserScript==
// @name         AIM Inspector
// @namespace    http://tampermonkey.net/
// @version      1.7
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Inspector.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Inspector.js
// @description  Cross-frame Leaflet / AIM investigation & control panel. Toggle with Shift+I. Snapshot with Shift+Alt+I.
// @author       Payden
// @match        *://percepto.app/*
// @match        https://percepto.app/*
// @match        https://percepto.app/static/dist/react-pages/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// Hotkeys:
//   Shift+I       — toggle the inspector panel (top frame only)
//   Shift+Alt+I   — instant multi-frame snapshot to clipboard
// Console API (top frame):
//   AIM.dump()              — multi-frame snapshot (returns Promise)
//   AIM.find(sel)           — querySelectorAll across frames
//   AIM.watch(sel, attr?)   — log mutations on matching elements
//   AIM.colorize(c, sel)    — visually highlight matching elements
//   AIM.broadcast(ch, msg)  — send a message on a BroadcastChannel
//   AIM.scripts()           — list detected AIM scripts (from console log signatures)
//   AIM.channels()          — list channels being monitored
// Log tag: [AIM INSPECT]

(function() {
    'use strict';

    // ============================================================
    // 1. CONSTANTS
    // ============================================================
    const VERSION = '1.6';
    const IS_TOP = window === window.top;
    const FRAME_ID = (IS_TOP ? 'TOP' : 'IFRAME') + '@' + location.pathname;
    const TAG = `[AIM INSPECT ${IS_TOP ? 'TOP' : 'IF'}]`;
    const CHANNEL_NAME = 'AIM_INSPECTOR_CHANNEL';
    const SNAPSHOT_TIMEOUT_MS = 600;
    const PANEL_REFRESH_MS = 1000;
    const RECORDER_DEFAULT_MS = 10000;
    const CHANNEL_HISTORY_MAX = 50;
    const SCRIPT_LOG_HISTORY_MAX = 100;

    // Channels we monitor for traffic display.
    // Add more here as new AIM scripts grow channels.
    const KNOWN_CHANNELS = [
        'AIM_STYLER_CHANNEL',
        'AIM_ALTITUDE_SYNC',
        'AIM_RULER_CHANNEL',
        'AIM_INSPECTOR_CHANNEL',
    ];

    // ============================================================
    // 2. STATE
    // ============================================================
    const state = {
        panelOpen: false,
        panelEl: null,
        pickerActive: false,
        pickerHoverEl: null,
        recorder: null, // { observer, mutations:[], startedAt, durationMs, timerId }
        channelTraffic: [], // {ts, channel, frame, data}
        scriptLogs: [], // {ts, frame, line}
        knownScripts: new Map(), // tag -> {firstSeen, lastSeen, frame, count}
        snapshotPending: null, // { resolve, partials, requestId, timerId }
        snapA: null, // saved snapshot for A/B comparison
        snapB: null,
        lastSelectorTested: '',
        lastSelectorHighlightUndo: null,
    };

    const channels = {
        inspector: null,
        taps: [], // BroadcastChannels we tap into for monitoring
    };

    console.log(`${TAG} v${VERSION} loading in ${FRAME_ID}`);

    // ============================================================
    // 3. UTILS
    // ============================================================
    function nowIso() { return new Date().toISOString().slice(11, 23); }

    function uid() { return Math.random().toString(36).slice(2, 10); }

    function safe(fn, fallback) {
        try { return fn(); } catch (e) { return fallback; }
    }

    function inputGuard(e) {
        const el = e.target;
        if (!el) return false;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
        if (el.isContentEditable) return true;
        if (el.closest && (el.closest('.ant-input') || el.closest('.ant-select'))) return true;
        if (el.getAttribute && el.getAttribute('role') === 'textbox') return true;
        return false;
    }

    function copyToClipboard(text) {
        // Use modern API if available, fallback to textarea hack.
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(
                () => true,
                err => { console.error(`${TAG} clipboard failed:`, err); return false; }
            );
        }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return Promise.resolve(ok);
        } catch (e) {
            console.error(`${TAG} clipboard fallback failed:`, e);
            return Promise.resolve(false);
        }
    }

    function countMatches(sel) {
        try { return document.querySelectorAll(sel).length; } catch (e) { return -1; }
    }

    function positionalSelector(el) {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body) {
            let part = node.tagName.toLowerCase();
            if (node.classList && node.classList.length) {
                part += '.' + Array.from(node.classList).map(c => CSS.escape(c)).join('.');
            }
            const parent = node.parentNode;
            if (parent) {
                const sameTag = Array.from(parent.children).filter(c => c.tagName === node.tagName);
                if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
            }
            parts.unshift(part);
            if (parts.length > 6) break;
            node = node.parentNode;
        }
        return parts.join(' > ');
    }

    // Returns ranked candidate selectors. Highest score first; consumer can
    // pick the best one or display all to the user.
    function rankedSelectors(el) {
        if (!el || el.nodeType !== 1) return [];
        const out = [];
        const seen = new Set();
        const add = (selector, score) => {
            if (!selector || seen.has(selector)) return;
            seen.add(selector);
            const matchCount = countMatches(selector);
            // Penalize selectors that match many things or fail to match the target.
            let unique = matchCount === 1;
            try { if (!el.matches(selector)) unique = false; } catch (e) {}
            out.push({ selector, score: unique ? score : Math.max(score - 30, 1), matchCount });
        };

        // 1. ID
        if (el.id) add('#' + CSS.escape(el.id), 100);

        // 2. Single attribute with strong identifying value
        if (el.attributes) {
            for (const a of el.attributes) {
                if (a.name.startsWith('data-') || a.name === 'role' || a.name === 'aria-label' || a.name === 'name' || a.name === 'title') {
                    add(`[${a.name}="${String(a.value).replace(/"/g, '\\"')}"]`, 90);
                }
            }
        }

        // 3. Tag + identifying attribute
        if (el.attributes) {
            for (const a of el.attributes) {
                if (a.name.startsWith('data-') || a.name === 'role' || a.name === 'name') {
                    add(`${el.tagName.toLowerCase()}[${a.name}="${String(a.value).replace(/"/g, '\\"')}"]`, 85);
                }
            }
        }

        // 4. Single-class selectors. A semantically-named class (e.g. .map-layer-menu)
        // that uniquely identifies the element is the most durable selector you
        // can hand to a userscript. Try each class on its own.
        if (el.classList && el.classList.length) {
            for (const c of el.classList) {
                // Skip framework / utility classes that rarely identify anything specific.
                if (/^(ng-|ant-|css-|leaflet-|sc-|jsx-)/.test(c)) continue;
                add('.' + CSS.escape(c), 80);
            }
        }

        // 5. ID-anchored short path from nearest ancestor with an ID.
        // Demote when the anchor is a framework mount point (#root, #app, etc.) —
        // those just say "somewhere in the React/Vue app", which is barely better
        // than a positional selector.
        const FRAMEWORK_ROOTS = new Set(['root', 'app', '__next', '__nuxt', 'main', 'app-root']);
        let anchor = el.parentNode;
        while (anchor && anchor.nodeType === 1 && !anchor.id) anchor = anchor.parentNode;
        if (anchor && anchor.id && anchor !== document.body) {
            const parts = [];
            let node = el;
            while (node && node !== anchor) {
                let part = node.tagName.toLowerCase();
                if (node.classList && node.classList.length) {
                    part = part + '.' + Array.from(node.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
                }
                parts.unshift(part);
                node = node.parentNode;
            }
            const anchorScore = FRAMEWORK_ROOTS.has(anchor.id) ? 30 : 70;
            add(`#${CSS.escape(anchor.id)} ${parts.join(' ')}`, anchorScore);
        }

        // 6. Tag + all classes (more specific than single-class, but brittle if
        // any one class changes; still useful as a fallback).
        if (el.classList && el.classList.length) {
            const sel = el.tagName.toLowerCase() + '.' + Array.from(el.classList).map(c => CSS.escape(c)).join('.');
            add(sel, 60);
        }

        // 7. Positional fallback
        add(positionalSelector(el), 10);

        return out.sort((a, b) => b.score - a.score);
    }


    // ============================================================
    // 4. CROSS-FRAME CHANNEL
    // ============================================================
    function setupInspectorChannel() {
        try {
            channels.inspector = new BroadcastChannel(CHANNEL_NAME);
            channels.inspector.onmessage = handleInspectorMessage;
        } catch (e) {
            console.error(`${TAG} BroadcastChannel unavailable:`, e);
        }
    }

    function handleInspectorMessage(event) {
        const msg = event.data || {};
        if (msg.type === 'COLLECT' && msg.requestId) {
            // Any frame (including top) responds with its local snapshot.
            const data = collectLocalSnapshot();
            channels.inspector.postMessage({
                type: 'COLLECT_RESPONSE',
                requestId: msg.requestId,
                frameId: FRAME_ID,
                data,
            });
        } else if (msg.type === 'COLLECT_RESPONSE' && state.snapshotPending && state.snapshotPending.requestId === msg.requestId) {
            state.snapshotPending.partials.push({ frameId: msg.frameId, data: msg.data });
        } else if (msg.type === 'PICKER_ACTIVATE') {
            enablePicker(false);
        } else if (msg.type === 'PICKER_DEACTIVATE') {
            disablePicker(false);
        } else if (msg.type === 'PANEL_TOGGLE_REQUEST' && IS_TOP) {
            togglePanel();
        } else if (msg.type === 'SIMULATE_HOTKEY' && msg.opts) {
            // Dispatch locally without re-broadcasting (avoid loops).
            simulateHotkey({ ...msg.opts, broadcast: false });
        } else if (msg.type === 'PICKED' && IS_TOP) {
            // Another frame picked something — flash status in our panel.
            flashPanel(`👆 picked from ${msg.frameId}: <${msg.summary.tag.toLowerCase()}>${msg.summary.ownedBy ? ' [' + msg.summary.ownedBy + ']' : ''}`);
        }
    }

    function setupChannelTaps() {
        KNOWN_CHANNELS.forEach(name => {
            try {
                const ch = new BroadcastChannel(name);
                ch.onmessage = (ev) => {
                    state.channelTraffic.push({
                        ts: nowIso(),
                        channel: name,
                        frame: FRAME_ID,
                        data: safe(() => JSON.parse(JSON.stringify(ev.data)), '(unserializable)'),
                    });
                    if (state.channelTraffic.length > CHANNEL_HISTORY_MAX) {
                        state.channelTraffic.splice(0, state.channelTraffic.length - CHANNEL_HISTORY_MAX);
                    }
                };
                channels.taps.push({ name, channel: ch });
            } catch (e) { /* ignore */ }
        });
    }

    // ============================================================
    // 5. DATA COLLECTORS
    // ============================================================
    function getMapState() {
        const container = document.querySelector('.leaflet-container');
        if (!container) return { hasMap: false };
        const cls = container.className || '';
        // Try to read zoom from a leaflet-zoom-X class or from internal _leaflet_id'd map.
        let zoomGuess = null;
        const zMatch = cls.match(/leaflet-zoom-(\d+)/);
        if (zMatch) zoomGuess = parseInt(zMatch[1], 10);
        const rect = container.getBoundingClientRect();
        const overlay = container.querySelector('.leaflet-overlay-pane svg');
        return {
            hasMap: true,
            classes: cls,
            zoomGuess,
            sizePx: { w: Math.round(rect.width), h: Math.round(rect.height) },
            overlayTransform: overlay && overlay.getAttribute('transform'),
            overlayStyle: overlay && overlay.getAttribute('style'),
        };
    }

    function getSvgTransforms() {
        const out = [];
        document.querySelectorAll('.leaflet-zoom-animated').forEach(g => {
            out.push({
                tag: g.tagName,
                transform: g.getAttribute('transform'),
                style: g.getAttribute('style'),
            });
        });
        return out;
    }

    function getPathCensus() {
        const all = document.querySelectorAll('path.leaflet-interactive');
        const byKey = {};
        all.forEach(p => {
            const stroke = p.getAttribute('stroke') || '(none)';
            const op = p.getAttribute('stroke-opacity') || '1';
            const w = p.getAttribute('stroke-width') || '(none)';
            const dash = p.getAttribute('stroke-dasharray') || '';
            const key = `${stroke}|op=${op}|w=${w}|dash=${dash}`;
            byKey[key] = (byKey[key] || 0) + 1;
        });
        return { total: all.length, byKey };
    }

    function getCustomBufferCount() {
        return document.querySelectorAll('[data-custom-buffer-v24="true"]').length;
    }

    function getNativeBuffers() {
        // Heuristic: paths with stroke-opacity=0.4 are usually buffers in the host app.
        const out = [];
        document.querySelectorAll('path.leaflet-interactive[stroke-opacity="0.4"]').forEach(p => {
            out.push({
                stroke: p.getAttribute('stroke'),
                width: parseFloat(p.getAttribute('stroke-width')) || null,
            });
        });
        return out;
    }

    function getVisibleSvgRoots() {
        const out = [];
        document.querySelectorAll('svg').forEach(svg => {
            const r = svg.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                out.push({
                    classes: svg.getAttribute('class'),
                    viewBox: svg.getAttribute('viewBox'),
                    transform: svg.getAttribute('transform'),
                    sizePx: { w: Math.round(r.width), h: Math.round(r.height) },
                });
            }
        });
        return out;
    }

    function collectLocalSnapshot() {
        return {
            frameId: FRAME_ID,
            url: location.href,
            ts: nowIso(),
            map: getMapState(),
            transforms: getSvgTransforms(),
            paths: getPathCensus(),
            customBuffers: getCustomBufferCount(),
            nativeBuffers: getNativeBuffers(),
            svgRoots: getVisibleSvgRoots(),
            scripts: Array.from(state.knownScripts.entries()).map(([tag, meta]) => ({ tag, ...meta })),
        };
    }

    // ============================================================
    // 6. SCRIPT REGISTRY (via console.log hook)
    // ============================================================
    function hookConsoleForRegistry() {
        const orig = console.log;
        console.log = function(...args) {
            try {
                // Look for [AIM XXX] or [AIM-XXX] patterns in first arg.
                const first = args[0];
                if (typeof first === 'string') {
                    const m = first.match(/\[(AIM[ -][A-Z0-9 _.-]+?)\]/);
                    if (m) {
                        const tag = m[1].trim();
                        const existing = state.knownScripts.get(tag);
                        if (existing) {
                            existing.lastSeen = nowIso();
                            existing.count++;
                        } else {
                            state.knownScripts.set(tag, { firstSeen: nowIso(), lastSeen: nowIso(), frame: FRAME_ID, count: 1 });
                        }
                        state.scriptLogs.push({ ts: nowIso(), frame: FRAME_ID, tag, line: first.slice(0, 200) });
                        if (state.scriptLogs.length > SCRIPT_LOG_HISTORY_MAX) {
                            state.scriptLogs.splice(0, state.scriptLogs.length - SCRIPT_LOG_HISTORY_MAX);
                        }
                    }
                }
            } catch (e) { /* never let logging break logging */ }
            return orig.apply(console, args);
        };
    }

    // ============================================================
    // 7. SNAPSHOT (cross-frame)
    // ============================================================
    function takeSnapshot() {
        return new Promise((resolve) => {
            const requestId = uid();
            const partials = [];
            // Always include local first, in case channel is unavailable.
            partials.push({ frameId: FRAME_ID, data: collectLocalSnapshot() });
            state.snapshotPending = { requestId, partials, resolve, timerId: null };
            if (channels.inspector) {
                channels.inspector.postMessage({ type: 'COLLECT', requestId });
            }
            state.snapshotPending.timerId = setTimeout(() => {
                const finalSnapshot = {
                    inspectorVersion: VERSION,
                    capturedAt: new Date().toISOString(),
                    frameCount: partials.length,
                    frames: partials,
                    channelTraffic: state.channelTraffic.slice(-CHANNEL_HISTORY_MAX),
                };
                state.snapshotPending = null;
                resolve(finalSnapshot);
            }, SNAPSHOT_TIMEOUT_MS);
        });
    }

    async function snapshotToClipboard() {
        const snap = await takeSnapshot();
        const json = JSON.stringify(snap, null, 2);
        const ok = await copyToClipboard(json);
        console.groupCollapsed(`${TAG} 📸 snapshot (${snap.frameCount} frames, ${json.length} chars) — ${ok ? 'copied to clipboard' : 'CLIPBOARD FAILED — see object below'}`);
        console.log(snap);
        console.groupEnd();
        if (state.panelEl) flashPanel('📸 snapshot copied');
        return snap;
    }

    async function captureSlot(slot /* 'A' | 'B' */) {
        const snap = await takeSnapshot();
        if (slot === 'A') state.snapA = snap; else state.snapB = snap;
        console.log(`${TAG} 📋 stored snapshot ${slot} (${snap.frameCount} frames)`);
        if (state.panelEl) { flashPanel(`📋 captured ${slot}`); updatePanel(); }
        return snap;
    }

    function diffFrameData(a, b) {
        const out = {};
        if (a.url !== b.url) out.url = { from: a.url, to: b.url };
        if (a.map.zoomGuess !== b.map.zoomGuess) out.zoomGuess = { from: a.map.zoomGuess, to: b.map.zoomGuess };
        if (a.map.overlayTransform !== b.map.overlayTransform) {
            out.overlayTransform = { from: a.map.overlayTransform, to: b.map.overlayTransform };
        }
        if (a.paths.total !== b.paths.total) out.pathTotal = { from: a.paths.total, to: b.paths.total };
        if (a.customBuffers !== b.customBuffers) out.customBuffers = { from: a.customBuffers, to: b.customBuffers };
        const allKeys = new Set([...Object.keys(a.paths.byKey), ...Object.keys(b.paths.byKey)]);
        const pathDiff = {};
        allKeys.forEach(k => {
            const va = a.paths.byKey[k] || 0;
            const vb = b.paths.byKey[k] || 0;
            if (va !== vb) pathDiff[k] = { from: va, to: vb };
        });
        if (Object.keys(pathDiff).length) out.pathsByKey = pathDiff;
        return out;
    }

    function diffSnapshots(a, b) {
        if (!a || !b) return { error: 'Need both A and B captured first' };
        const out = { frameCountChange: b.frameCount - a.frameCount, frames: {} };
        const allFrameIds = new Set([
            ...a.frames.map(f => f.frameId),
            ...b.frames.map(f => f.frameId),
        ]);
        allFrameIds.forEach(fid => {
            const fa = (a.frames.find(f => f.frameId === fid) || {}).data;
            const fb = (b.frames.find(f => f.frameId === fid) || {}).data;
            if (!fa) { out.frames[fid] = { added: true }; return; }
            if (!fb) { out.frames[fid] = { removed: true }; return; }
            const d = diffFrameData(fa, fb);
            if (Object.keys(d).length) out.frames[fid] = d;
        });
        return out;
    }

    async function diffAB() {
        const result = diffSnapshots(state.snapA, state.snapB);
        const json = JSON.stringify(result, null, 2);
        const ok = await copyToClipboard(json);
        console.groupCollapsed(`${TAG} ⊿ diff A↔B — ${ok ? 'copied to clipboard' : 'CLIPBOARD FAILED'}`);
        console.log(result);
        console.groupEnd();
        if (state.panelEl) flashPanel('⊿ diff copied');
        return result;
    }

    function testSelector(sel, highlight) {
        if (state.lastSelectorHighlightUndo) { state.lastSelectorHighlightUndo(); state.lastSelectorHighlightUndo = null; }
        let count = -1, els = [];
        try {
            els = Array.from(document.querySelectorAll(sel));
            count = els.length;
        } catch (e) {
            console.warn(`${TAG} 🔍 invalid selector:`, sel, e.message);
            return { error: e.message, count: -1 };
        }
        state.lastSelectorTested = sel;
        if (highlight && count > 0) {
            els.forEach(el => {
                el.style.outline = '3px solid #ff00aa';
                el.style.outlineOffset = '2px';
            });
            state.lastSelectorHighlightUndo = () => els.forEach(el => { el.style.outline = ''; el.style.outlineOffset = ''; });
        }
        console.log(`${TAG} 🔍 ${sel} → ${count} match(es)`, els);
        return { count, els };
    }

    function simulateHotkey(opts) {
        // opts: { key, code, shiftKey, ctrlKey, altKey, broadcast: true|false }
        const desc = `${opts.shiftKey?'Shift+':''}${opts.ctrlKey?'Ctrl+':''}${opts.altKey?'Alt+':''}${opts.key}`;
        const ev = new KeyboardEvent('keydown', {
            key: opts.key,
            code: opts.code || ('Key' + opts.key.toUpperCase()),
            shiftKey: !!opts.shiftKey, ctrlKey: !!opts.ctrlKey, altKey: !!opts.altKey,
            bubbles: true, cancelable: true,
        });
        window.dispatchEvent(ev);
        // Cross-frame: ask other frames to dispatch locally too
        if (opts.broadcast !== false && channels.inspector) {
            channels.inspector.postMessage({ type: 'SIMULATE_HOTKEY', opts: { ...opts, broadcast: false } });
        }
        console.log(`${TAG} ⌨ simulated ${desc}`);
        if (state.panelEl) flashPanel(`⌨ ${desc}`);
    }

    // Common AIM hotkeys for the simulator panel.
    const PRESET_HOTKEYS = [
        { label: 'Shift+O Outlines', key: 'O', code: 'KeyO', shiftKey: true },
        { label: 'Shift+R Ruler', key: 'R', code: 'KeyR', shiftKey: true },
        { label: 'Shift+A Altitude', key: 'A', code: 'KeyA', shiftKey: true },
        { label: 'Shift+B Bulk', key: 'B', code: 'KeyB', shiftKey: true },
        { label: 'Shift+C Clear', key: 'C', code: 'KeyC', shiftKey: true },
    ];

    // ============================================================
    // 8. MUTATION RECORDER
    // ============================================================
    function startRecording(durationMs = RECORDER_DEFAULT_MS) {
        if (state.recorder) {
            console.warn(`${TAG} recorder already running`);
            return;
        }
        const target = document.querySelector('.leaflet-overlay-pane') || document.body;
        const mutations = [];
        const startedAt = performance.now();
        const observer = new MutationObserver(records => {
            records.forEach(r => {
                mutations.push({
                    t: Math.round(performance.now() - startedAt),
                    type: r.type,
                    target: r.target.nodeName,
                    targetClass: r.target.getAttribute && r.target.getAttribute('class'),
                    attr: r.attributeName,
                    oldVal: r.oldValue,
                    newVal: r.attributeName ? safe(() => r.target.getAttribute(r.attributeName), null) : null,
                    addedNodes: r.addedNodes.length,
                    removedNodes: r.removedNodes.length,
                });
            });
        });
        observer.observe(target, {
            attributes: true, childList: true, subtree: true, attributeOldValue: true,
        });
        const timerId = setTimeout(() => stopRecording(), durationMs);
        state.recorder = { observer, mutations, startedAt, durationMs, timerId, target };
        console.log(`${TAG} 🎬 recording mutations on`, target, `for ${durationMs}ms (${mutations.length} so far)`);
        if (state.panelEl) updatePanel();
    }

    function stopRecording() {
        if (!state.recorder) return null;
        const { observer, mutations, durationMs, timerId, target } = state.recorder;
        observer.disconnect();
        clearTimeout(timerId);
        state.recorder = null;
        const summary = summarizeMutations(mutations);
        console.groupCollapsed(`${TAG} 🎬 recording done — ${mutations.length} mutations in ${durationMs}ms on`, target);
        console.log('summary:', summary);
        console.log('full timeline:', mutations);
        console.groupEnd();
        if (state.panelEl) { flashPanel(`🎬 recorded ${mutations.length} mutations`); updatePanel(); }
        return { mutations, summary };
    }

    function summarizeMutations(mutations) {
        const byKey = {};
        mutations.forEach(m => {
            const key = `${m.type}|${m.target}|${m.attr || ''}`;
            byKey[key] = (byKey[key] || 0) + 1;
        });
        return byKey;
    }

    // ============================================================
    // 9. ELEMENT PICKER
    // ============================================================
    let pickerOverlayEl = null;

    function enablePicker(broadcast = true) {
        if (state.pickerActive) return;
        if (!document.body) return; // Picker needs DOM; called too early during document-start
        state.pickerActive = true;
        pickerOverlayEl = document.createElement('div');
        pickerOverlayEl.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #ff00aa;background:rgba(255,0,170,0.1);z-index:2147483646;transition:all 60ms';
        document.body.appendChild(pickerOverlayEl);
        document.addEventListener('mousemove', pickerMouseMove, true);
        document.addEventListener('click', pickerClick, true);
        document.addEventListener('keydown', pickerKey, true);
        console.log(`${TAG} 👆 picker active in ${FRAME_ID} — click an element (Esc to cancel)`);
        // Broadcast so other frames also enable — needed because elements inside
        // the map iframe (Leaflet paths, toolbars, entities) only receive clicks
        // in their own document, not via the top frame.
        if (broadcast && channels.inspector) {
            channels.inspector.postMessage({ type: 'PICKER_ACTIVATE' });
        }
        if (state.panelEl) flashPanel('👆 picker on (all frames)');
    }

    function disablePicker(broadcast = true) {
        if (!state.pickerActive) return;
        state.pickerActive = false;
        document.removeEventListener('mousemove', pickerMouseMove, true);
        document.removeEventListener('click', pickerClick, true);
        document.removeEventListener('keydown', pickerKey, true);
        if (pickerOverlayEl) { pickerOverlayEl.remove(); pickerOverlayEl = null; }
        if (broadcast && channels.inspector) {
            channels.inspector.postMessage({ type: 'PICKER_DEACTIVATE' });
        }
    }

    function pickerMouseMove(e) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === pickerOverlayEl) return;
        state.pickerHoverEl = el;
        const r = el.getBoundingClientRect();
        pickerOverlayEl.style.left = r.left + 'px';
        pickerOverlayEl.style.top = r.top + 'px';
        pickerOverlayEl.style.width = r.width + 'px';
        pickerOverlayEl.style.height = r.height + 'px';
    }

    function pickerClick(e) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        // Use the actual click coordinate, not the last mousemove. Mousemove
        // can lag fast clicks, picking the wrong element. elementFromPoint
        // also correctly skips our overlay (which has pointer-events:none).
        let el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === pickerOverlayEl) el = e.target;
        disablePicker(true);
        if (el) dumpElementInfo(el);
    }

    function pickerKey(e) {
        if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation();
            disablePicker(true);
            console.log(`${TAG} 👆 picker cancelled`);
        }
    }

    function detectAimOwnership(el) {
        // Walk up looking for known AIM markers.
        let n = el;
        while (n && n.nodeType === 1) {
            if (n.hasAttribute && n.hasAttribute('data-custom-buffer-v24')) return 'AIM Styler (custom buffer)';
            if (n.id === 'aim-inspector-panel') return 'AIM Inspector (this panel)';
            if (n.id && n.id.startsWith('aim-')) return `AIM (${n.id})`;
            n = n.parentNode;
        }
        return null;
    }

    function detectReact(el) {
        if (!el) return null;
        const keys = Object.keys(el);
        const propsKey = keys.find(k => k.startsWith('__reactProps$'));
        const fiberKey = keys.find(k => k.startsWith('__reactFiber$'));
        if (!propsKey && !fiberKey) return null;
        return {
            hasReact: true,
            propsKey: propsKey || null,
            propKeys: propsKey ? safe(() => Object.keys(el[propsKey]), null) : null,
            handlers: propsKey ? safe(() => Object.keys(el[propsKey]).filter(k => k.startsWith('on')), null) : null,
        };
    }

    function round2(n) { return Math.round(n * 100) / 100; }

    // Tells whether an element looks "clickable" — it has a handler, or
    // a tag/role/class that strongly implies one. Used to walk up from
    // a picked icon/svg to the actual button.
    function isInteractiveElement(n, opts) {
        opts = opts || {};
        if (!n || n.nodeType !== 1) return null;
        if (n.tagName === 'BUTTON' || n.tagName === 'A') return 'tag=' + n.tagName.toLowerCase();
        const role = n.getAttribute && n.getAttribute('role');
        if (role && /^(button|link|menuitem|tab|checkbox|switch|option)$/.test(role)) return 'role=' + role;
        if (n.classList) {
            if (n.classList.contains('ant-dropdown-trigger')) return 'class=ant-dropdown-trigger';
            if (n.classList.contains('ant-btn')) return 'class=ant-btn';
            if (n.classList.contains('leaflet-control')) return 'class=leaflet-control';
        }
        const propsKey = Object.keys(n).find(k => k.startsWith('__reactProps$'));
        if (propsKey) {
            const props = safe(() => n[propsKey], null);
            if (props && (props.onClick || props.onMouseDown || props.onMouseUp || props.onPointerDown)) {
                return 'react-handler';
            }
        }
        if (opts.includeCursor) {
            const cs = safe(() => getComputedStyle(n), null);
            if (cs && cs.cursor === 'pointer') return 'cursor=pointer';
        }
        return null;
    }

    // Walks up from the picked element (skipping itself) for the nearest
    // ancestor that handles clicks. Returns null if the picked element is
    // already interactive.
    function findInteractiveAncestor(el) {
        if (!el || el.nodeType !== 1) return null;
        // If the picked element itself is interactive, no ancestor to point at.
        if (isInteractiveElement(el, { includeCursor: false })) return null;
        let n = el.parentNode;
        let depth = 1;
        while (n && n.nodeType === 1 && n !== document.body && depth < 10) {
            const reason = isInteractiveElement(n, { includeCursor: depth <= 3 });
            if (reason) {
                const ranked = rankedSelectors(n);
                return {
                    tag: n.tagName,
                    classes: n.className && (typeof n.className === 'string' ? n.className.split(/\s+/).filter(Boolean) : Array.from(n.classList)),
                    bestSelector: ranked[0] && ranked[0].selector,
                    selectors: ranked.slice(0, 3),
                    depth,
                    reason,
                };
            }
            n = n.parentNode;
            depth++;
        }
        return null;
    }

    // Walks up looking for an ancestor whose strongest selector beats the
    // picked element's own. Useful when the picked element has no semantic
    // identifier (e.g. an <img>) but a parent has data-* / unique class.
    function findBetterAncestorSelector(el) {
        if (!el || el.nodeType !== 1) return null;
        const myRanked = rankedSelectors(el);
        const myBestScore = myRanked.length ? myRanked[0].score : 0;
        if (myBestScore >= 90) return null; // Already strong, no ancestor will beat it
        let n = el.parentNode;
        let depth = 1;
        let best = null;
        while (n && n.nodeType === 1 && n !== document.body && depth < 6) {
            const ranked = rankedSelectors(n);
            const top = ranked[0];
            if (top && top.score > myBestScore && top.matchCount === 1) {
                if (!best || top.score > best.score) {
                    best = {
                        selector: top.selector,
                        score: top.score,
                        matchCount: top.matchCount,
                        depth,
                        ancestorTag: n.tagName,
                    };
                }
            }
            n = n.parentNode;
            depth++;
        }
        return best;
    }

    function dumpElementInfo(el) {
        const ranked = rankedSelectors(el);
        const info = {
            inspectorVersion: VERSION,
            frame: FRAME_ID,
            tag: el.tagName,
            id: el.id || null,
            classes: el.className && (typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : Array.from(el.classList)),
            ownedBy: detectAimOwnership(el),
            react: detectReact(el),
            attributes: {},
            selectors: ranked.slice(0, 5),
            bestSelector: ranked[0] && ranked[0].selector,
            interactiveAncestor: findInteractiveAncestor(el),
            betterAncestorSelector: findBetterAncestorSelector(el),
            bboxClient: safe(() => { const r = el.getBoundingClientRect(); return { x: round2(r.x), y: round2(r.y), w: round2(r.width), h: round2(r.height) }; }, null),
            bboxSvg: safe(() => { const b = el.getBBox(); return { x: round2(b.x), y: round2(b.y), w: round2(b.width), h: round2(b.height) }; }, null),
            computed: {},
            outerHTMLPreview: el.outerHTML ? el.outerHTML.slice(0, 600) : null,
            parentChain: [],
        };
        if (el.attributes) {
            for (const a of el.attributes) info.attributes[a.name] = a.value;
        }
        const cs = getComputedStyle(el);
        ['display','position','visibility','opacity','pointer-events','cursor','transform','stroke','stroke-width','stroke-opacity','fill','z-index','background-color','color','border'].forEach(p => {
            info.computed[p] = cs.getPropertyValue(p);
        });
        let p = el.parentNode;
        let depth = 0;
        while (p && p.nodeType === 1 && depth < 6) {
            info.parentChain.push({ tag: p.tagName, id: p.id || null, classes: p.className && (typeof p.className === 'string' ? p.className : (p.className.baseVal || '')) });
            p = p.parentNode; depth++;
        }
        console.groupCollapsed(`${TAG} 👆 picked: <${el.tagName.toLowerCase()}>${info.ownedBy ? ' [' + info.ownedBy + ']' : ''}`, el);
        console.log(info);
        console.groupEnd();
        copyToClipboard(JSON.stringify(info, null, 2)).then(ok => {
            if (state.panelEl) flashPanel(ok ? '👆 element info copied' : '👆 picked (copy failed)');
        });
        // Tell the top frame what was picked, so its panel can flash even if
        // the pick happened inside the map iframe.
        if (!IS_TOP && channels.inspector) {
            channels.inspector.postMessage({
                type: 'PICKED',
                frameId: FRAME_ID,
                summary: { tag: info.tag, ownedBy: info.ownedBy, bestSelector: info.bestSelector },
            });
        }
    }

    // ============================================================
    // 10. PANEL UI (top frame only)
    // ============================================================
    function createPanel() {
        if (!IS_TOP) return;
        if (state.panelEl) return;
        const root = document.createElement('div');
        root.id = 'aim-inspector-panel';
        root.style.cssText = [
            'position:fixed','top:60px','right:12px','width:340px','max-height:80vh',
            'background:rgba(20,22,28,0.94)','color:#e6e6e6','font:12px/1.4 ui-monospace,Menlo,Consolas,monospace',
            'border:1px solid #444','border-radius:8px','box-shadow:0 6px 20px rgba(0,0,0,0.5)',
            'z-index:2147483647','overflow:hidden','display:flex','flex-direction:column','user-select:none',
        ].join(';');
        root.innerHTML = `
            <div id="aim-i-header" style="cursor:move;background:#2a2d36;padding:6px 10px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #444">
                <span style="font-weight:bold;color:#bada55">AIM Inspector</span>
                <span style="opacity:0.6">v${VERSION}</span>
                <span id="aim-i-flash" style="margin-left:auto;color:#ffcc66;font-size:11px"></span>
                <button id="aim-i-min" style="background:transparent;color:#aaa;border:none;cursor:pointer;font-size:14px;padding:0 4px">_</button>
                <button id="aim-i-close" style="background:transparent;color:#aaa;border:none;cursor:pointer;font-size:14px;padding:0 4px">×</button>
            </div>
            <div id="aim-i-body" style="padding:8px 10px;overflow-y:auto;flex:1">
                <div id="aim-i-actions" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
                    <button data-act="snapshot" style="${btnCss()}">📸 Snapshot</button>
                    <button data-act="pick" style="${btnCss()}">👆 Pick</button>
                    <button data-act="record" style="${btnCss()}">🎬 Record 10s</button>
                </div>
                <div id="aim-i-ab" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;align-items:center">
                    <button data-act="snapA" style="${btnCss()}">📋 A</button>
                    <button data-act="snapB" style="${btnCss()}">📋 B</button>
                    <button data-act="diff" style="${btnCss()}">⊿ Diff A↔B</button>
                    <span id="aim-i-ab-status" style="color:#888;font-size:11px"></span>
                </div>
                <div id="aim-i-selector" style="margin-bottom:8px">
                    <div style="color:#888;margin-bottom:4px">🔍 Selector tester</div>
                    <div style="display:flex;gap:4px">
                        <input id="aim-i-sel-input" type="text" placeholder="e.g. path[stroke=&quot;var(--color-green)&quot;]" style="flex:1;background:#1a1c22;color:#e6e6e6;border:1px solid #444;border-radius:4px;padding:3px 6px;font:inherit"/>
                        <button data-act="sel-test" style="${btnCss()}">Test</button>
                        <button data-act="sel-show" style="${btnCss()}">Show</button>
                    </div>
                    <div id="aim-i-sel-result" style="font-size:11px;color:#aaa;margin-top:4px"></div>
                </div>
                <div id="aim-i-hotkeys" style="margin-bottom:8px">
                    <div style="color:#888;margin-bottom:4px">⌨ Hotkey simulator</div>
                    <div id="aim-i-hk-buttons" style="display:flex;gap:4px;flex-wrap:wrap"></div>
                </div>
                <div id="aim-i-frame"></div>
                <div id="aim-i-map"></div>
                <div id="aim-i-paths"></div>
                <div id="aim-i-scripts"></div>
                <div id="aim-i-channels"></div>
            </div>
        `;
        document.body.appendChild(root);
        state.panelEl = root;
        loadPanelPosition(root);
        // Header drag
        makeDraggable(root.querySelector('#aim-i-header'), root);
        root.querySelector('#aim-i-min').onclick = () => {
            const body = root.querySelector('#aim-i-body');
            body.style.display = body.style.display === 'none' ? '' : 'none';
        };
        root.querySelector('#aim-i-close').onclick = () => togglePanel(false);
        // Action buttons
        const handleAction = (e) => {
            const act = e.target && e.target.dataset && e.target.dataset.act;
            if (!act) return;
            if (act === 'snapshot') snapshotToClipboard();
            else if (act === 'pick') enablePicker();
            else if (act === 'record') { if (state.recorder) stopRecording(); else startRecording(); }
            else if (act === 'snapA') captureSlot('A');
            else if (act === 'snapB') captureSlot('B');
            else if (act === 'diff') diffAB();
            else if (act === 'sel-test') {
                const v = root.querySelector('#aim-i-sel-input').value.trim();
                if (v) renderSelectorResult(testSelector(v, false), v);
            } else if (act === 'sel-show') {
                const v = root.querySelector('#aim-i-sel-input').value.trim();
                if (v) renderSelectorResult(testSelector(v, true), v);
            }
        };
        root.querySelector('#aim-i-actions').onclick = handleAction;
        root.querySelector('#aim-i-ab').onclick = handleAction;
        root.querySelector('#aim-i-selector').onclick = handleAction;
        // Enter in selector input runs Test
        root.querySelector('#aim-i-sel-input').addEventListener('keydown', (e) => {
            e.stopPropagation(); // never let inspector hotkeys fire while typing here
            if (e.key === 'Enter') {
                const v = e.target.value.trim();
                if (v) renderSelectorResult(testSelector(v, e.shiftKey), v);
            }
        });
        // Hotkey simulator buttons (rendered once)
        const hkRoot = root.querySelector('#aim-i-hk-buttons');
        PRESET_HOTKEYS.forEach(hk => {
            const b = document.createElement('button');
            b.textContent = hk.label;
            b.style.cssText = btnCss();
            b.onclick = () => simulateHotkey(hk);
            hkRoot.appendChild(b);
        });
        // Periodic refresh
        setInterval(() => { if (state.panelOpen) updatePanel(); }, PANEL_REFRESH_MS);
    }

    function renderSelectorResult(result, sel) {
        if (!state.panelEl) return;
        const el = state.panelEl.querySelector('#aim-i-sel-result');
        if (!el) return;
        if (result.error) {
            el.innerHTML = `<span style="color:#ff8080">invalid: ${escapeHtml(result.error)}</span>`;
        } else {
            el.innerHTML = `→ <b>${result.count}</b> match${result.count === 1 ? '' : 'es'} for <code style="color:#bada55">${escapeHtml(sel)}</code>`;
        }
    }

    function btnCss() {
        return [
            'background:#3a3d48','color:#e6e6e6','border:1px solid #555','border-radius:4px',
            'padding:4px 8px','cursor:pointer','font:inherit',
        ].join(';');
    }

    const POS_KEY = 'aim-inspector-pos';

    function loadPanelPosition(root) {
        try {
            const raw = localStorage.getItem(POS_KEY);
            if (!raw) return;
            const { left, top } = JSON.parse(raw);
            if (typeof left === 'number' && typeof top === 'number') {
                root.style.left = left + 'px';
                root.style.top = top + 'px';
                root.style.right = '';
            }
        } catch (e) { /* ignore corrupt prefs */ }
    }

    function savePanelPosition(root) {
        try {
            const r = root.getBoundingClientRect();
            localStorage.setItem(POS_KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
        } catch (e) { /* localStorage may be disabled */ }
    }

    function makeDraggable(handle, root) {
        let dragging = false, ox = 0, oy = 0;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            const r = root.getBoundingClientRect();
            ox = e.clientX - r.left; oy = e.clientY - r.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            root.style.left = (e.clientX - ox) + 'px';
            root.style.top = (e.clientY - oy) + 'px';
            root.style.right = '';
        });
        document.addEventListener('mouseup', () => {
            if (dragging) { dragging = false; savePanelPosition(root); }
        });
    }

    function togglePanel(force) {
        if (!IS_TOP) {
            if (channels.inspector) channels.inspector.postMessage({ type: 'PANEL_TOGGLE_REQUEST' });
            return;
        }
        if (!state.panelEl) createPanel();
        const next = typeof force === 'boolean' ? force : !state.panelOpen;
        state.panelOpen = next;
        state.panelEl.style.display = next ? 'flex' : 'none';
        if (next) updatePanel();
    }

    let flashTimer = null;
    function flashPanel(msg) {
        if (!state.panelEl) return;
        const el = state.panelEl.querySelector('#aim-i-flash');
        if (!el) return;
        el.textContent = msg;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { el.textContent = ''; }, 2000);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
    }

    function updatePanel() {
        if (!state.panelEl || !state.panelOpen) return;
        const local = collectLocalSnapshot();
        const $ = (s) => state.panelEl.querySelector(s);

        const abStatus = $('#aim-i-ab-status');
        if (abStatus) {
            abStatus.textContent = `A: ${state.snapA ? '✓ ' + state.snapA.frameCount + 'f' : '—'}   B: ${state.snapB ? '✓ ' + state.snapB.frameCount + 'f' : '—'}`;
        }

        $('#aim-i-frame').innerHTML = `
            <div style="margin-bottom:6px;color:#888">Frame</div>
            <div style="margin-bottom:8px">${escapeHtml(FRAME_ID)}</div>
        `;

        if (local.map.hasMap) {
            $('#aim-i-map').innerHTML = `
                <div style="color:#888;margin-bottom:4px">Map</div>
                <div style="margin-bottom:8px">
                    zoomGuess: ${local.map.zoomGuess == null ? '?' : local.map.zoomGuess}<br>
                    size: ${local.map.sizePx.w}×${local.map.sizePx.h}px<br>
                    transform: <span style="color:#bada55">${escapeHtml((local.map.overlayTransform || '').slice(0, 60))}</span>
                </div>
            `;
        } else {
            $('#aim-i-map').innerHTML = `<div style="color:#888;margin-bottom:8px">Map: <em>not present in this frame</em></div>`;
        }

        const topPaths = Object.entries(local.paths.byKey).sort((a, b) => b[1] - a[1]).slice(0, 6);
        $('#aim-i-paths').innerHTML = `
            <div style="color:#888;margin-bottom:4px">Paths (${local.paths.total} total, ${local.customBuffers} custom buffers)</div>
            <div style="margin-bottom:8px;font-size:11px">
                ${topPaths.map(([k, v]) => `<div>×${v} <span style="color:#aaa">${escapeHtml(k)}</span></div>`).join('') || '<em style="color:#666">none</em>'}
            </div>
        `;

        $('#aim-i-scripts').innerHTML = `
            <div style="color:#888;margin-bottom:4px">AIM Scripts seen (${state.knownScripts.size})</div>
            <div style="margin-bottom:8px;font-size:11px">
                ${Array.from(state.knownScripts.entries()).slice(0, 10).map(([tag, m]) => `<div>${escapeHtml(tag)} <span style="color:#666">×${m.count}</span></div>`).join('') || '<em style="color:#666">none yet</em>'}
            </div>
        `;

        const recent = state.channelTraffic.slice(-5).reverse();
        $('#aim-i-channels').innerHTML = `
            <div style="color:#888;margin-bottom:4px">Channel traffic (last 5 of ${state.channelTraffic.length})</div>
            <div style="font-size:11px">
                ${recent.map(t => `<div style="margin-bottom:2px"><span style="color:#666">${t.ts}</span> <span style="color:#bada55">${escapeHtml(t.channel)}</span> ${escapeHtml(JSON.stringify(t.data).slice(0, 80))}</div>`).join('') || '<em style="color:#666">no traffic yet</em>'}
            </div>
            ${state.recorder ? `<div style="margin-top:8px;padding:4px;background:#3a1a1a;border-radius:4px">🎬 RECORDING — ${state.recorder.mutations.length} mutations so far</div>` : ''}
        `;
    }

    // ============================================================
    // 11. PUBLIC API (top frame)
    // ============================================================
    function installPublicApi() {
        if (!IS_TOP) return;
        const api = {
            version: VERSION,
            dump: () => takeSnapshot(),
            dumpToClipboard: () => snapshotToClipboard(),
            find: (sel) => Array.from(document.querySelectorAll(sel)),
            watch: (sel, attr) => {
                const els = Array.from(document.querySelectorAll(sel));
                const obs = new MutationObserver(records => {
                    records.forEach(r => console.log(`${TAG} watch:`, r.type, r.attributeName, r.target));
                });
                els.forEach(el => obs.observe(el, { attributes: true, attributeFilter: attr ? [attr] : undefined, childList: true, subtree: false }));
                console.log(`${TAG} watching ${els.length} elements`, els);
                return () => obs.disconnect();
            },
            colorize: (color, sel) => {
                const els = Array.from(document.querySelectorAll(sel));
                els.forEach(el => {
                    el.style.outline = `3px solid ${color}`;
                    el.style.outlineOffset = '2px';
                });
                console.log(`${TAG} colorized ${els.length} elements`);
                return () => els.forEach(el => { el.style.outline = ''; el.style.outlineOffset = ''; });
            },
            broadcast: (channelName, data) => {
                try {
                    const ch = new BroadcastChannel(channelName);
                    ch.postMessage(data);
                    setTimeout(() => ch.close(), 100);
                    console.log(`${TAG} broadcast to ${channelName}:`, data);
                } catch (e) { console.error(e); }
            },
            scripts: () => Array.from(state.knownScripts.entries()).map(([tag, m]) => ({ tag, ...m })),
            channels: () => channels.taps.map(t => t.name),
            channelHistory: () => state.channelTraffic.slice(),
            startRecording, stopRecording,
            pickElement: enablePicker,
            togglePanel: () => togglePanel(),
            // A/B snapshot tools
            snapA: () => captureSlot('A'),
            snapB: () => captureSlot('B'),
            diff: () => diffAB(),
            getSnapA: () => state.snapA,
            getSnapB: () => state.snapB,
            // Selector + element inspection
            test: (sel, highlight) => testSelector(sel, highlight),
            selectorsFor: (el) => rankedSelectors(el),
            // Hotkey simulation
            hotkey: simulateHotkey,
            presetHotkeys: PRESET_HOTKEYS,
            // Escape hatch — direct access for power users.
            _state: state,
        };
        window.AIM = api;
        console.log(`${TAG} window.AIM API installed. Try: AIM.test('path[stroke="#1ca0de"]', true), AIM.snapA() then AIM.snapB() then AIM.diff(), AIM.hotkey({key:'O',code:'KeyO',shiftKey:true})`);
    }

    // ============================================================
    // 12. HOTKEY LISTENER
    // ============================================================
    function installHotkeys() {
        window.addEventListener('keydown', (e) => {
            if (inputGuard(e)) return;
            // Shift+Alt+I → instant snapshot to clipboard (works in any frame; top assembles)
            if (e.shiftKey && e.altKey && (e.code === 'KeyI' || e.key === 'I' || e.key === 'i')) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                if (IS_TOP) {
                    snapshotToClipboard();
                } else if (channels.inspector) {
                    // Iframe just asks top to do it
                    channels.inspector.postMessage({ type: 'PANEL_TOGGLE_REQUEST' });
                    snapshotToClipboard();
                }
                return;
            }
            // Shift+I → toggle panel
            if (e.shiftKey && !e.altKey && !e.ctrlKey && (e.code === 'KeyI' || e.key === 'I' || e.key === 'i')) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                togglePanel();
                return;
            }
        }, true);
    }

    // ============================================================
    // 13. INIT
    // ============================================================
    function init() {
        hookConsoleForRegistry(); // First — catch other scripts' init logs
        setupInspectorChannel();
        setupChannelTaps();
        installHotkeys();
        if (IS_TOP) {
            // Wait for body before installing panel/API
            const ready = () => { installPublicApi(); /* panel created lazily on first toggle */ };
            if (document.body) ready();
            else document.addEventListener('DOMContentLoaded', ready, { once: true });
        }
        console.log(`${TAG} ready (Shift+I: panel, Shift+Alt+I: snapshot)`);
    }

    init();
})();
