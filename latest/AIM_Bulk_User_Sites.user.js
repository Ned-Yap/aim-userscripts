// ==UserScript==
// @name         Latest - AIM Bulk User Sites
// @namespace    http://tampermonkey.net/
// @version      1.10
// @updateURL    https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Bulk_User_Sites.user.js
// @downloadURL  https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Bulk_User_Sites.user.js
// @description  Bulk-fill the Admin "User Site batch create" page. Paste emails + site names (one per line), auto-selects matches in the lists. Favorites strip for users/sites you add over and over. Hotkey Shift+B.
// @author       Payden
// @match        *://percepto.app/admin/percepto/usersite/batch_create*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
//
// What it does:
//   - Floating "⚡ Bulk Fill" launcher + Shift+B opens a dark panel.
//   - Paste emails (Users) and site names (Sites), one per line. Apply selects
//     every exact match in the real <select multiple> lists (case/space-insensitive).
//   - List search (Users + Sites): substring filter the page's full list (e.g.
//     "@example.com" shows every user on that domain). Click / Enter to add one,
//     "Add all matches" to add every match, "Clear box" to reset.
//   - Favorites strip per list: pin the users/sites you add over and over,
//     check the ones you want, they get included on every Apply. Persisted via GM storage.
//     Edit mode reveals ✕ delete + drag-to-reorder (group people together).
//   - Presets: named bundles of (Users + Role). Load replaces the Users box + sets
//     the role; sites chosen fresh each time. Save as… / Update / Delete. Personal, GM-stored.
//   - Role defaults to "Percepto Admin".
//   - Unmatched lines are reported so nothing fails silently.
// Hotkey:  Shift+B  (open/close panel)
// Log tag: [AIM USERSITE]

(function() {
    'use strict';

    const TAG = '[AIM USERSITE]';
    const log = (...a) => console.log(TAG, ...a);
    const warn = (...a) => console.warn(TAG, ...a);
    const err = (...a) => console.error(TAG, ...a);

    log('🛰️ loading…');

    const FAV_USERS_KEY = 'AIM_USERSITE_FAV_USERS';
    const FAV_SITES_KEY = 'AIM_USERSITE_FAV_SITES';
    const PRESETS_KEY = 'AIM_USERSITE_PRESETS';
    const DEFAULT_ROLE_LABEL = 'Percepto Admin';

    // --- GM storage helpers (favorites persist across page loads / sessions) ---
    // @grant GM_setValue/GM_getValue declared above — without them these silently no-op.
    function gmGet(key, fallback) {
        try {
            if (typeof GM_getValue !== 'function') { warn('GM_getValue unavailable — favorites will not persist'); return fallback; }
            const raw = GM_getValue(key, null);
            if (raw == null) return fallback;
            return JSON.parse(raw);
        } catch (e) { err('gmGet failed for', key, e); return fallback; }
    }
    function gmSet(key, val) {
        try {
            if (typeof GM_setValue !== 'function') { warn('GM_setValue unavailable — favorites will not persist'); return; }
            GM_setValue(key, JSON.stringify(val));
        } catch (e) { err('gmSet failed for', key, e); }
    }

    // Favorites are [{ v: '<text>', on: <bool> }]. `v` is the email or site name
    // as it appears in the option text; `on` is whether it's checked by default.
    let favUsers = gmGet(FAV_USERS_KEY, []);
    let favSites = gmGet(FAV_SITES_KEY, []);

    // Per-strip "edit mode" — the remove (✕) buttons only show while editing, so
    // a stray click checks/unchecks a pin instead of deleting it. Edit mode also
    // enables drag-and-drop reordering of pins (group people together).
    const favEditMode = { [FAV_USERS_KEY]: false, [FAV_SITES_KEY]: false };
    let favDragIdx = null;   // index of the chip being dragged
    let favDragKey = null;   // which strip the drag started in (no cross-strip drops)

    // Presets: named bundles of { name, users:[email...], roleValue, roleLabel }.
    // A preset captures a group of people + the role they get; sites are chosen
    // fresh each time. Loading replaces the Users box and sets the Role.
    let presets = gmGet(PRESETS_KEY, []);

    // --- page element accessors -------------------------------------------------
    const getUsersSelect = () => document.getElementById('id_users');
    const getSitesSelect = () => document.getElementById('id_sites');
    const getRoleSelect = () => document.getElementById('id_role');
    const getCreateBtn = () => document.querySelector('input[name="_create"]');

    function isTargetPage() {
        return /\/admin\/percepto\/usersite\/batch_create/.test(location.pathname);
    }

    // Normalize for matching: collapse whitespace, lowercase, trim.
    const norm = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().toLowerCase();

    // Build normalized-text -> option index map for a <select>.
    function buildIndex(select) {
        const map = new Map();
        if (!select) return map;
        for (let i = 0; i < select.options.length; i++) {
            const key = norm(select.options[i].text);
            if (key && !map.has(key)) map.set(key, select.options[i]);
        }
        return map;
    }

    // Given raw lines + a select, set selection to EXACTLY the matched options
    // (deselect everything else first so re-applying is predictable).
    // Returns { matched: [text...], unmatched: [text...], count }.
    function applyToSelect(select, lines) {
        const result = { matched: [], unmatched: [], count: 0 };
        if (!select) { err('select not found'); return result; }
        const index = buildIndex(select);

        // Deselect all first.
        for (let i = 0; i < select.options.length; i++) select.options[i].selected = false;

        const seen = new Set();
        for (const raw of lines) {
            const key = norm(raw);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const opt = index.get(key);
            if (opt) {
                opt.selected = true;
                result.matched.push(opt.text.trim());
            } else {
                result.unmatched.push(raw.trim());
            }
        }
        result.count = result.matched.length;
        // Plain HTML select — a change event is enough; no React value setter here.
        select.dispatchEvent(new Event('change', { bubbles: true }));
        // Scroll first match into view for visual confirmation.
        const first = Array.from(select.options).find(o => o.selected);
        if (first && typeof first.scrollIntoView === 'function') {
            try { first.scrollIntoView({ block: 'nearest' }); } catch (e) { /* non-fatal */ }
        }
        return result;
    }

    function setDefaultRole() {
        const role = getRoleSelect();
        if (!role) return;
        const target = Array.from(role.options).find(o => norm(o.text) === norm(DEFAULT_ROLE_LABEL));
        if (target) {
            role.value = target.value;
            role.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // ---------------------------------------------------------------------------
    // Panel
    // ---------------------------------------------------------------------------
    let panelEl = null;

    function parseLines(text) {
        return text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    }

    function checkedFavValues(favList) {
        return favList.filter(f => f.on).map(f => f.v);
    }

    function buildPanel() {
        if (panelEl) { panelEl.style.display = 'block'; return; }

        panelEl = document.createElement('div');
        panelEl.id = 'aim-usersite-panel';
        Object.assign(panelEl.style, {
            position: 'fixed', top: '70px', right: '24px', width: '540px',
            maxHeight: 'calc(100vh - 110px)', overflowY: 'auto',
            background: '#1b1b1b', color: '#eee', border: '2px solid #2b7a99',
            borderRadius: '10px', zIndex: '2147483000', boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
            fontFamily: 'system-ui, sans-serif', fontSize: '13px'
        });

        panelEl.innerHTML = `
            <style>
                #aim-usersite-panel .aim-us-pbtn {
                    background:#3a3a3a; color:#eee; border:1px solid #555; border-radius:4px;
                    padding:5px 9px; cursor:pointer; font-size:12px; white-space:nowrap;
                }
                #aim-usersite-panel .aim-us-pbtn:hover { background:#4a4a4a; }
            </style>
            <div id="aim-us-header" style="cursor:move; display:flex; align-items:center; justify-content:space-between;
                 padding:10px 14px; background:#11333f; border-bottom:1px solid #2b7a99; border-radius:8px 8px 0 0;">
                <strong style="color:#5fd0ff; font-size:14px;">⚡ Bulk User → Sites</strong>
                <button id="aim-us-close" title="Close" style="background:none; border:none; color:#aaa; font-size:18px; cursor:pointer; line-height:1;">✕</button>
            </div>
            <div style="padding:12px 14px;">

                <!-- PRESETS -->
                <div style="display:flex; gap:6px; align-items:center; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid #333; flex-wrap:wrap;">
                    <span style="color:#5fd0ff; font-weight:bold;">Preset</span>
                    <select id="aim-us-preset-sel" title="Saved presets (users + role)"
                        style="flex:1; min-width:130px; background:#0e0e0e; color:#eee; border:1px solid #444; border-radius:5px; padding:5px;"></select>
                    <button id="aim-us-preset-load"   class="aim-us-pbtn" title="Load preset into the Users box + Role">Load</button>
                    <button id="aim-us-preset-saveas" class="aim-us-pbtn" title="Save the current Users box + Role as a new preset">Save as…</button>
                    <button id="aim-us-preset-update" class="aim-us-pbtn" title="Overwrite the selected preset with the current Users box + Role">Update</button>
                    <button id="aim-us-preset-del"    class="aim-us-pbtn" title="Delete the selected preset" style="color:#ff8a8a;">Delete</button>
                </div>

                <!-- USERS -->
                <div style="margin-bottom:6px; color:#5fd0ff; font-weight:bold;">Users (emails — one per line)</div>
                <div id="aim-us-fav-users" class="aim-us-favwrap"></div>
                <div id="aim-us-users-search-wrap" style="margin-bottom:6px;">
                    <input id="aim-us-users-search" type="text" placeholder="🔍 search all users (try @example.com) — click to add, Enter adds top"
                        style="width:100%; box-sizing:border-box; background:#0e0e0e; color:#eee; border:1px solid #444; border-radius:5px; padding:6px; font-size:12px;">
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <button id="aim-us-users-addall" class="aim-us-pbtn" style="flex:1;" title="Add every user matching the current search to the box">➕ Add all matches</button>
                        <button id="aim-us-users-clear"  class="aim-us-pbtn" style="flex:1; color:#ff8a8a;" title="Empty the Users box">✗ Clear box</button>
                    </div>
                    <div id="aim-us-users-results" style="display:none; max-height:190px; overflow-y:auto; border:1px solid #444; border-radius:5px; margin-top:4px; background:#0e0e0e;"></div>
                </div>
                <textarea id="aim-us-users" placeholder="jane.doe@example.com&#10;john.smith@example.com"
                    style="width:100%; height:120px; box-sizing:border-box; background:#0e0e0e; color:#eee;
                    border:1px solid #444; border-radius:5px; padding:6px; resize:vertical; font-family:monospace; font-size:12px;"></textarea>

                <div style="height:14px;"></div>

                <!-- SITES -->
                <div style="margin-bottom:6px; color:#5fd0ff; font-weight:bold;">Sites (names — one per line)</div>
                <div id="aim-us-fav-sites" class="aim-us-favwrap"></div>
                <div id="aim-us-sites-search-wrap" style="margin-bottom:6px;">
                    <input id="aim-us-sites-search" type="text" placeholder="🔍 search all sites — click to add, Enter adds top match"
                        style="width:100%; box-sizing:border-box; background:#0e0e0e; color:#eee; border:1px solid #444; border-radius:5px; padding:6px; font-size:12px;">
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <button id="aim-us-sites-addall" class="aim-us-pbtn" style="flex:1;" title="Add every site matching the current search to the box">➕ Add all matches</button>
                        <button id="aim-us-sites-clear"  class="aim-us-pbtn" style="flex:1; color:#ff8a8a;" title="Empty the Sites box">✗ Clear box</button>
                    </div>
                    <div id="aim-us-sites-results" style="display:none; max-height:190px; overflow-y:auto; border:1px solid #444; border-radius:5px; margin-top:4px; background:#0e0e0e;"></div>
                </div>
                <textarea id="aim-us-sites" placeholder="Example Site A&#10;Example Site B"
                    style="width:100%; height:120px; box-sizing:border-box; background:#0e0e0e; color:#eee;
                    border:1px solid #444; border-radius:5px; padding:6px; resize:vertical; font-family:monospace; font-size:12px;"></textarea>

                <div style="height:14px;"></div>

                <!-- ROLE -->
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                    <span style="color:#5fd0ff; font-weight:bold;">Role</span>
                    <select id="aim-us-role" style="flex:1; background:#0e0e0e; color:#eee; border:1px solid #444; border-radius:5px; padding:5px;"></select>
                </div>

                <!-- ACTIONS -->
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button id="aim-us-apply" style="flex:1; min-width:140px; padding:9px; border:none; border-radius:5px; background:#2b7a99; color:#fff; font-weight:bold; cursor:pointer;">Apply selections</button>
                    <button id="aim-us-create" style="flex:1; min-width:140px; padding:9px; border:none; border-radius:5px; background:#2e7d32; color:#fff; font-weight:bold; cursor:pointer;">Apply &amp; Create</button>
                </div>

                <div id="aim-us-report" style="margin-top:12px; font-size:12px; line-height:1.5;"></div>
            </div>
        `;
        document.body.appendChild(panelEl);

        // Role dropdown mirror — populate from the real select, default Percepto Admin.
        const realRole = getRoleSelect();
        const roleSel = panelEl.querySelector('#aim-us-role');
        if (realRole) {
            for (const o of realRole.options) {
                const opt = document.createElement('option');
                opt.value = o.value; opt.textContent = o.text;
                if (norm(o.text) === norm(DEFAULT_ROLE_LABEL)) opt.selected = true;
                roleSel.appendChild(opt);
            }
        }

        // Wire controls
        panelEl.querySelector('#aim-us-close').onclick = () => { panelEl.style.display = 'none'; };
        panelEl.querySelector('#aim-us-apply').onclick = () => doApply(false);
        panelEl.querySelector('#aim-us-create').onclick = () => doApply(true);

        wirePresets();
        wireListSearch({
            noun: 'User', boxSel: '#aim-us-users', getSelect: getUsersSelect,
            ids: { input: '#aim-us-users-search', results: '#aim-us-users-results', addall: '#aim-us-users-addall', clear: '#aim-us-users-clear' }
        });
        wireListSearch({
            noun: 'Site', boxSel: '#aim-us-sites', getSelect: getSitesSelect,
            ids: { input: '#aim-us-sites-search', results: '#aim-us-sites-results', addall: '#aim-us-sites-addall', clear: '#aim-us-sites-clear' }
        });
        makeDraggable(panelEl, panelEl.querySelector('#aim-us-header'));
        renderFavs();
    }

    // --- List search (Users + Sites) -------------------------------------------
    // Type to filter the page's full list; substring match, so "@example.com"
    // surfaces every user on that domain. Click a result (or Enter for the top
    // one) to append it to the box; "Add all matches" adds every match.
    function addLineToBox(textareaSel, name) {
        const ta = panelEl.querySelector(textareaSel);
        if (!ta) return false;
        const lines = parseLines(ta.value);
        if (lines.some(l => norm(l) === norm(name))) return false; // already there
        lines.push(name);
        ta.value = lines.join('\n');
        return true;
    }

    // cfg: { noun, boxSel, getSelect, ids:{input,results,addall,clear} }
    function wireListSearch(cfg) {
        const input = panelEl.querySelector(cfg.ids.input);
        const results = panelEl.querySelector(cfg.ids.results);
        const box = panelEl.querySelector(cfg.boxSel);
        const addAllBtn = panelEl.querySelector(cfg.ids.addall);
        const clearBtn = panelEl.querySelector(cfg.ids.clear);
        if (!input || !results || !box) return;

        let allMatches = [];     // every option matching the query (uncapped — for Add all)
        const MAX = 80;          // how many we actually render

        const matching = (q) => {
            const sel = cfg.getSelect();
            if (!sel || !q) return [];
            const out = [];
            for (const o of sel.options) {
                if (norm(o.text).includes(q)) out.push(o.text.trim());
            }
            return out;
        };

        const updateAddAllLabel = () => {
            if (!addAllBtn) return;
            addAllBtn.textContent = allMatches.length ? `➕ Add all matches (${allMatches.length})` : '➕ Add all matches';
            addAllBtn.disabled = !allMatches.length;
            addAllBtn.style.opacity = allMatches.length ? '1' : '0.5';
        };

        const render = () => {
            const q = norm(input.value);
            const sel = cfg.getSelect();
            if (!q) {
                allMatches = [];
                results.style.display = 'none'; results.innerHTML = '';
                updateAddAllLabel();
                return;
            }
            if (!sel) {
                allMatches = [];
                results.innerHTML = `<div style="padding:6px; color:#ff8a8a;">${cfg.noun} list not found on the page.</div>`;
                results.style.display = 'block'; updateAddAllLabel(); return;
            }
            allMatches = matching(q);
            updateAddAllLabel();
            const existing = new Set(parseLines(box.value).map(norm));
            if (!allMatches.length) {
                results.innerHTML = `<div style="padding:6px; color:#888;">no matching ${cfg.noun.toLowerCase()}s</div>`;
                results.style.display = 'block'; return;
            }
            results.innerHTML = '';
            allMatches.slice(0, MAX).forEach(name => {
                const already = existing.has(norm(name));
                const row = document.createElement('div');
                row.textContent = (already ? '✓ ' : '+ ') + name;
                Object.assign(row.style, {
                    padding: '5px 8px', cursor: already ? 'default' : 'pointer', fontSize: '12px',
                    color: already ? '#7fd97f' : '#eee', borderBottom: '1px solid #222', whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis'
                });
                if (!already) {
                    row.onmouseenter = () => { row.style.background = '#163a47'; };
                    row.onmouseleave = () => { row.style.background = 'transparent'; };
                    row.onclick = () => { addLineToBox(cfg.boxSel, name); render(); };
                }
                results.appendChild(row);
            });
            if (allMatches.length > MAX) {
                const more = document.createElement('div');
                more.textContent = `…showing first ${MAX} of ${allMatches.length} — use “Add all matches” or keep typing`;
                Object.assign(more.style, { padding: '5px 8px', fontSize: '11px', color: '#888', fontStyle: 'italic' });
                results.appendChild(more);
            }
            results.style.display = 'block';
        };

        input.addEventListener('input', render);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                // Add the first not-yet-added match, then clear for the next search.
                const existing = new Set(parseLines(box.value).map(norm));
                const next = allMatches.find(m => !existing.has(norm(m)));
                if (next) { addLineToBox(cfg.boxSel, next); }
                input.value = ''; render();
            } else if (e.key === 'Escape') {
                input.value = ''; render();
            }
        });

        if (addAllBtn) addAllBtn.onclick = () => {
            if (!allMatches.length) { alert(`Type a search first — Add all adds every ${cfg.noun.toLowerCase()} matching it.`); return; }
            let added = 0;
            allMatches.forEach(name => { if (addLineToBox(cfg.boxSel, name)) added++; });
            log(`${cfg.noun.toLowerCase()} search: added all ${added} match(es) for "${input.value.trim()}"`);
            render();
        };

        if (clearBtn) clearBtn.onclick = () => {
            const n = parseLines(box.value).length;
            if (!n) return;
            if (!confirm(`Clear all ${n} ${cfg.noun.toLowerCase()}(s) from the box?`)) return;
            box.value = '';
            render();
        };
    }

    // --- Presets ----------------------------------------------------------------
    function persistPresets() { gmSet(PRESETS_KEY, presets); }

    function renderPresetDropdown(selectName) {
        const sel = panelEl.querySelector('#aim-us-preset-sel');
        if (!sel) return;
        sel.innerHTML = '';
        if (!presets.length) {
            const o = document.createElement('option');
            o.value = ''; o.textContent = '— no presets yet —'; o.disabled = true; o.selected = true;
            sel.appendChild(o);
            return;
        }
        const placeholder = document.createElement('option');
        placeholder.value = ''; placeholder.textContent = '— choose a preset —';
        sel.appendChild(placeholder);
        presets.forEach((p, i) => {
            const o = document.createElement('option');
            o.value = String(i);
            o.textContent = `${p.name} (${(p.users || []).length} · ${p.roleLabel || 'role?'})`;
            if (selectName && p.name === selectName) o.selected = true;
            sel.appendChild(o);
        });
    }

    function selectedPresetIndex() {
        const sel = panelEl.querySelector('#aim-us-preset-sel');
        if (!sel || sel.value === '') return -1;
        return parseInt(sel.value, 10);
    }

    // The people a preset captures = checked user pins + typed Users box lines,
    // deduped (case/space-insensitive), preserving order (pins first).
    function collectPresetUsers(usersTa) {
        const out = [];
        const seen = new Set();
        for (const v of [...checkedFavValues(favUsers), ...parseLines(usersTa.value)]) {
            const k = norm(v);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push(v.trim());
        }
        return out;
    }

    function wirePresets() {
        renderPresetDropdown();
        const roleSel = panelEl.querySelector('#aim-us-role');
        const usersTa = panelEl.querySelector('#aim-us-users');

        panelEl.querySelector('#aim-us-preset-load').onclick = () => {
            const i = selectedPresetIndex();
            if (i < 0) { alert('Pick a preset to load first.'); return; }
            const p = presets[i];
            const presetUsers = p.users || [];

            // Replace semantics: uncheck every user pin first, then check the ones
            // this preset names. People that aren't pins go into the Users box.
            favUsers.forEach(f => { f.on = false; });
            const leftover = [];
            let pinnedCount = 0;
            for (const u of presetUsers) {
                const pin = favUsers.find(f => norm(f.v) === norm(u));
                if (pin) { pin.on = true; pinnedCount++; }
                else leftover.push(u);
            }
            persistFav(FAV_USERS_KEY);
            usersTa.value = leftover.join('\n');                  // only non-pinned go to the box
            renderFavs();                                         // reflect new checked state

            if (p.roleValue != null) {                            // set the role
                const match = Array.from(roleSel.options).find(o => o.value === String(p.roleValue));
                if (match) roleSel.value = match.value;
            }
            log(`loaded preset "${p.name}" — ${pinnedCount} via pins, ${leftover.length} to box, role ${p.roleLabel}`);
            flashReport(`Loaded preset <strong style="color:#eee;">${escapeHtml(p.name)}</strong> — ` +
                `${pinnedCount} pin(s) checked` + (leftover.length ? ` + ${leftover.length} into the box` : '') +
                `, role <strong style="color:#eee;">${escapeHtml(p.roleLabel || '?')}</strong>. Sites left as-is. Hit Apply when ready.`);
        };

        panelEl.querySelector('#aim-us-preset-saveas').onclick = () => {
            const users = collectPresetUsers(usersTa);
            if (!users.length) { alert('No users to save — type emails in the box and/or check some pins, then Save as…'); return; }
            const name = (prompt('Name this preset:') || '').trim();
            if (!name) return;
            const existing = presets.findIndex(p => norm(p.name) === norm(name));
            const roleOpt = roleSel.options[roleSel.selectedIndex] || {};
            const rec = { name, users, roleValue: roleSel.value, roleLabel: roleOpt.text || '' };
            if (existing >= 0) {
                if (!confirm(`A preset named "${name}" already exists. Overwrite it?`)) return;
                presets[existing] = rec;
            } else {
                presets.push(rec);
            }
            persistPresets();
            renderPresetDropdown(name);
            log(`saved preset "${name}"`);
            flashReport(`Saved preset <strong style="color:#eee;">${escapeHtml(name)}</strong> (${users.length} user(s), role ${escapeHtml(rec.roleLabel)}).`);
        };

        panelEl.querySelector('#aim-us-preset-update').onclick = () => {
            const i = selectedPresetIndex();
            if (i < 0) { alert('Pick the preset you want to overwrite first.'); return; }
            const users = collectPresetUsers(usersTa);
            if (!users.length) { alert('No users to save — type emails in the box and/or check some pins first.'); return; }
            const roleOpt = roleSel.options[roleSel.selectedIndex] || {};
            const name = presets[i].name;
            if (!confirm(`Overwrite preset "${name}" with the current Users box (${users.length}) + role "${roleOpt.text}"?`)) return;
            presets[i] = { name, users, roleValue: roleSel.value, roleLabel: roleOpt.text || '' };
            persistPresets();
            renderPresetDropdown(name);
            flashReport(`Updated preset <strong style="color:#eee;">${escapeHtml(name)}</strong>.`);
        };

        panelEl.querySelector('#aim-us-preset-del').onclick = () => {
            const i = selectedPresetIndex();
            if (i < 0) { alert('Pick a preset to delete first.'); return; }
            const name = presets[i].name;
            if (!confirm(`Delete preset "${name}"? This can't be undone.`)) return;
            presets.splice(i, 1);
            persistPresets();
            renderPresetDropdown();
            flashReport(`Deleted preset <strong style="color:#eee;">${escapeHtml(name)}</strong>.`);
        };
    }

    function flashReport(html) {
        const rep = panelEl.querySelector('#aim-us-report');
        if (rep) rep.innerHTML = `<div style="color:#bbb;">${html}</div>`;
    }

    // --- Favorites strips -------------------------------------------------------
    function renderFavs() {
        renderFavStrip(panelEl.querySelector('#aim-us-fav-users'), favUsers, FAV_USERS_KEY, '#aim-us-users');
        renderFavStrip(panelEl.querySelector('#aim-us-fav-sites'), favSites, FAV_SITES_KEY, '#aim-us-sites');
    }

    function persistFav(key) {
        gmSet(key, key === FAV_USERS_KEY ? favUsers : favSites);
    }
    function favListFor(key) { return key === FAV_USERS_KEY ? favUsers : favSites; }

    function renderFavStrip(wrap, favList, key, textareaSel) {
        if (!wrap) return;
        wrap.innerHTML = '';
        Object.assign(wrap.style, { marginBottom: '6px' });
        const editing = favEditMode[key];

        if (favList.length) {
            const chips = document.createElement('div');
            Object.assign(chips.style, { display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '6px' });
            favList.forEach((fav, idx) => {
                const chip = document.createElement('label');
                Object.assign(chip.style, {
                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                    background: fav.on ? '#163a47' : '#262626', border: '1px solid ' + (fav.on ? '#2b7a99' : '#444'),
                    borderRadius: '12px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer'
                });
                const cb = document.createElement('input');
                cb.type = 'checkbox'; cb.checked = !!fav.on;
                cb.style.cursor = 'pointer';
                // While editing, the checkbox is disabled so clicks only target deletes.
                cb.disabled = editing;
                cb.onchange = () => { fav.on = cb.checked; persistFav(key); chip.style.background = fav.on ? '#163a47' : '#262626'; chip.style.borderColor = fav.on ? '#2b7a99' : '#444'; };
                const txt = document.createElement('span');
                txt.textContent = fav.v;
                txt.style.color = '#ddd';
                // In edit mode: drag handle (grip) first, then checkbox + label.
                if (editing) {
                    const grip = document.createElement('span');
                    grip.textContent = '⠿';
                    Object.assign(grip.style, { color: '#888', cursor: 'grab', fontWeight: 'bold', marginRight: '1px' });
                    chip.appendChild(grip);
                }
                chip.appendChild(cb); chip.appendChild(txt);
                // Remove ✕ only appears in edit mode.
                if (editing) {
                    const rm = document.createElement('span');
                    rm.textContent = '✕'; rm.title = 'Remove favorite';
                    Object.assign(rm.style, { color: '#ff6b6b', marginLeft: '2px', cursor: 'pointer', fontWeight: 'bold' });
                    rm.onclick = (e) => { e.preventDefault(); e.stopPropagation(); favList.splice(idx, 1); persistFav(key); renderFavStrip(wrap, favListFor(key), key, textareaSel); };
                    chip.appendChild(rm);

                    // Drag-and-drop reorder (within this strip only).
                    chip.draggable = true;
                    chip.style.cursor = 'grab';
                    chip.addEventListener('dragstart', (e) => {
                        favDragIdx = idx; favDragKey = key;
                        chip.style.opacity = '0.4';
                        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)); } catch (_) { /* non-fatal */ }
                    });
                    chip.addEventListener('dragend', () => { chip.style.opacity = '1'; });
                    chip.addEventListener('dragover', (e) => {
                        if (favDragKey !== key || favDragIdx === null) return;
                        e.preventDefault();
                        chip.style.borderColor = '#5fd0ff';
                    });
                    chip.addEventListener('dragleave', () => { chip.style.borderColor = fav.on ? '#2b7a99' : '#444'; });
                    chip.addEventListener('drop', (e) => {
                        e.preventDefault();
                        if (favDragKey !== key || favDragIdx === null || favDragIdx === idx) { favDragIdx = favDragKey = null; return; }
                        const list = favListFor(key);
                        const [moved] = list.splice(favDragIdx, 1);
                        list.splice(idx, 0, moved);
                        favDragIdx = favDragKey = null;
                        persistFav(key);
                        renderFavStrip(wrap, list, key, textareaSel);
                    });
                }
                chips.appendChild(chip);
            });
            wrap.appendChild(chips);
        }

        // Add-to-favorites controls
        const ctl = document.createElement('div');
        Object.assign(ctl.style, { display: 'flex', gap: '6px', marginBottom: '4px' });
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = (key === FAV_USERS_KEY ? 'pin an email…' : 'pin a site name…');
        Object.assign(inp.style, { flex: '1', background: '#0e0e0e', color: '#eee', border: '1px solid #444', borderRadius: '4px', padding: '4px 6px', fontSize: '11px' });
        const addOne = () => {
            const v = inp.value.trim();
            if (v) { addFav(key, v); inp.value = ''; renderFavStrip(wrap, favListFor(key), key, textareaSel); }
        };
        inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } };
        const addBtn = document.createElement('button');
        addBtn.textContent = '⭐ Pin';
        Object.assign(addBtn.style, { background: '#3a3a3a', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px' });
        addBtn.onclick = addOne;
        const pinPasted = document.createElement('button');
        pinPasted.textContent = '⭐ Pin pasted';
        pinPasted.title = 'Add every line in the box below to favorites';
        Object.assign(pinPasted.style, { background: '#3a3a3a', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px', whiteSpace: 'nowrap' });
        pinPasted.onclick = () => {
            const ta = panelEl.querySelector(textareaSel);
            const lines = parseLines(ta ? ta.value : '');
            lines.forEach(l => addFav(key, l));
            renderFavStrip(wrap, favListFor(key), key, textareaSel);
        };
        ctl.appendChild(inp); ctl.appendChild(addBtn); ctl.appendChild(pinPasted);

        // Check-all / uncheck-all the pins (toggles `on`, does NOT delete them).
        // Only shown when there's at least one pin to manage.
        if (favList.length) {
            const setAll = (val) => {
                favList.forEach(f => { f.on = val; });
                persistFav(key);
                renderFavStrip(wrap, favListFor(key), key, textareaSel);
            };
            const allBtn = document.createElement('button');
            allBtn.textContent = '✓ All';
            allBtn.title = 'Check every pin (include all on next Apply)';
            Object.assign(allBtn.style, { background: '#3a3a3a', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px', whiteSpace: 'nowrap' });
            allBtn.onclick = () => setAll(true);
            const noneBtn = document.createElement('button');
            noneBtn.textContent = '✗ None';
            noneBtn.title = 'Uncheck every pin (they stay pinned, just not selected)';
            Object.assign(noneBtn.style, { background: '#3a3a3a', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px', whiteSpace: 'nowrap' });
            noneBtn.onclick = () => setAll(false);
            ctl.appendChild(allBtn); ctl.appendChild(noneBtn);
        }

        // Edit toggle — reveals the ✕ delete buttons on the chips. Only shown
        // when there's at least one pin to manage.
        if (favList.length) {
            const editBtn = document.createElement('button');
            editBtn.textContent = editing ? '✓ Done' : '✎ Edit';
            editBtn.title = editing ? 'Finish editing pins' : 'Show delete (✕) buttons on pins';
            Object.assign(editBtn.style, { background: editing ? '#5a3a3a' : '#3a3a3a', color: '#eee', border: '1px solid #555', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px', whiteSpace: 'nowrap' });
            editBtn.onclick = () => { favEditMode[key] = !favEditMode[key]; renderFavStrip(wrap, favListFor(key), key, textareaSel); };
            ctl.appendChild(editBtn);
        }
        wrap.appendChild(ctl);
    }

    function addFav(key, value) {
        const list = favListFor(key);
        if (list.some(f => norm(f.v) === norm(value))) return; // dedupe
        list.push({ v: value, on: true });
        persistFav(key);
    }

    // --- Apply ------------------------------------------------------------------
    function doApply(thenCreate) {
        try {
            const usersTa = panelEl.querySelector('#aim-us-users');
            const sitesTa = panelEl.querySelector('#aim-us-sites');
            const roleSel = panelEl.querySelector('#aim-us-role');

            const userLines = [...checkedFavValues(favUsers), ...parseLines(usersTa.value)];
            const siteLines = [...checkedFavValues(favSites), ...parseLines(sitesTa.value)];

            const uRes = applyToSelect(getUsersSelect(), userLines);
            const sRes = applyToSelect(getSitesSelect(), siteLines);

            // Apply role
            const realRole = getRoleSelect();
            if (realRole && roleSel) {
                realRole.value = roleSel.value;
                realRole.dispatchEvent(new Event('change', { bubbles: true }));
            }

            renderReport(uRes, sRes, realRole ? (realRole.options[realRole.selectedIndex] || {}).text : '?');
            log(`applied — users ${uRes.count} matched / ${uRes.unmatched.length} missed; sites ${sRes.count} matched / ${sRes.unmatched.length} missed`);

            if (thenCreate) {
                if (uRes.unmatched.length || sRes.unmatched.length) {
                    const ok = confirm(
                        `Some entries did not match and will be skipped:\n\n` +
                        (uRes.unmatched.length ? `Users:\n  ${uRes.unmatched.join('\n  ')}\n\n` : '') +
                        (sRes.unmatched.length ? `Sites:\n  ${sRes.unmatched.join('\n  ')}\n\n` : '') +
                        `Create with the ${uRes.count} user(s) × ${sRes.count} site(s) that DID match?`
                    );
                    if (!ok) return;
                }
                if (!uRes.count || !sRes.count) {
                    alert('Need at least one matched user AND one matched site to Create.');
                    return;
                }
                const btn = getCreateBtn();
                if (btn) { log('clicking Create'); btn.click(); }
                else { err('Create button not found'); alert('Could not find the Create button.'); }
            }
        } catch (e) {
            err('doApply failed', e);
            alert('Bulk fill error: ' + e.message);
        }
    }

    function renderReport(uRes, sRes, roleText) {
        const rep = panelEl.querySelector('#aim-us-report');
        if (!rep) return;
        const block = (title, res) => {
            let h = `<div style="margin-top:6px;"><strong style="color:#5fd0ff;">${title}:</strong> ` +
                `<span style="color:#7fd97f;">${res.count} selected</span>`;
            if (res.unmatched.length) {
                h += ` · <span style="color:#ff8a8a;">${res.unmatched.length} not found</span>`;
                h += `<div style="color:#ff8a8a; font-family:monospace; font-size:11px; margin-top:3px; padding-left:8px;">` +
                     res.unmatched.map(x => '• ' + escapeHtml(x)).join('<br>') + `</div>`;
            }
            h += `</div>`;
            return h;
        };
        rep.innerHTML = block('Users', uRes) + block('Sites', sRes) +
            `<div style="margin-top:6px; color:#bbb;">Role set to <strong style="color:#eee;">${escapeHtml(roleText || '?')}</strong></div>`;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // --- dragging ---------------------------------------------------------------
    function makeDraggable(el, handle) {
        let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.id === 'aim-us-close') return;
            dragging = true;
            const r = el.getBoundingClientRect();
            ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
            el.style.right = 'auto'; el.style.left = ox + 'px'; el.style.top = oy + 'px';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            el.style.left = (ox + e.clientX - sx) + 'px';
            el.style.top = (oy + e.clientY - sy) + 'px';
        });
        window.addEventListener('mouseup', () => { dragging = false; });
    }

    // --- launcher button + hotkey ----------------------------------------------
    function installLauncher() {
        if (document.getElementById('aim-us-launcher')) return;
        const btn = document.createElement('button');
        btn.id = 'aim-us-launcher';
        btn.type = 'button';
        btn.textContent = '⚡ Bulk Fill';
        btn.onclick = togglePanel;

        // Prefer placing it inside the form's submit-row so it lines up with the
        // page's Create button. Django floats .submit-row inputs right, so a
        // float:right button appended after Create sits just to its left.
        const submitRow = document.querySelector('.submit-row');
        if (submitRow) {
            Object.assign(btn.style, {
                float: 'right', margin: '0 12px 0 0', padding: '8px 16px',
                background: '#2ecc71', color: '#000', border: 'none', borderRadius: '4px',
                fontWeight: 'bold', cursor: 'pointer', fontSize: '14px'
            });
            submitRow.appendChild(btn);
        } else {
            // Fallback: float bottom-right if the submit-row isn't there.
            Object.assign(btn.style, {
                position: 'fixed', bottom: '22px', right: '22px', zIndex: '2147482000',
                padding: '10px 16px', background: '#2ecc71', color: '#000', border: 'none',
                borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px',
                boxShadow: '0 3px 12px rgba(0,0,0,0.5)'
            });
            document.body.appendChild(btn);
        }
    }

    function togglePanel() {
        if (panelEl && panelEl.style.display !== 'none') { panelEl.style.display = 'none'; }
        else { buildPanel(); }
    }

    function onKeydown(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        if (e.shiftKey && e.key && e.key.toLowerCase() === 'b') {
            e.preventDefault(); e.stopPropagation();
            togglePanel();
        }
    }

    // --- init -------------------------------------------------------------------
    function init() {
        if (!isTargetPage()) { log('not the batch_create page — idle'); return; }
        log('🚀 init on', location.pathname);
        try { setDefaultRole(); } catch (e) { err('setDefaultRole', e); }
        installLauncher();
        window.addEventListener('keydown', onKeydown, true);
        log('ready — Shift+B or ⚡ Bulk Fill button. ' + favUsers.length + ' fav user(s), ' + favSites.length + ' fav site(s).');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') init();
    else window.addEventListener('DOMContentLoaded', init);
})();
