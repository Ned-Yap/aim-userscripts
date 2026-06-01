# Changelog

Human-readable summary of what shipped in each update. Tampermonkey auto-update prompts coworkers to install new versions; this file is what they read to know *what changed*.

Newest entries on top. Each entry calls out the script + version + a one-line summary. Issue references look like `[#7](https://github.com/Ned-Yap/aim-userscripts-issues/issues/7)` and link to the private tracker (only visible to collaborators).

---

## 2026-06-01 — AIM Issues v0.2 (Phase 1 follow-up)

First-look feedback fixes from testing v0.1:

- **CRITICAL bug fix — persistence broken on refresh.** v0.1's `readSiteIdFromHash` read `location.hash` from the iframe context. But the map iframe's URL is `/static/dist/react-pages/*` and has NO site info — only the top window carries `#/site/<id>/...`. So after refresh, siteID came up null, localStorage lookup failed, issues vanished. Fix: read `window.top.location.hash` first (same-origin so cross-frame works), fall back to own hash. Hashchange listener also attaches to top now.
- **Hide UX overhaul.** v0.1 removed the layer on M1 click — only way to bring it back was page refresh. v0.2 keeps the layer but switches it to a **dimmed** style (opacity ~0.25, thin stroke, near-zero fill, dashed-border marker shrunk to 20px) and forces `pointer-events:none` on the polygon so clicks fall through to Percepto entities underneath. The small ⚠ icon stays clickable — M1 it to un-hide.
- **M2 on 🚩 button: toggle `showHidden`.** Default ON = hidden issues render dimmed. Flip OFF = hidden issues vanish entirely until you flip back (or refresh resets `hiddenIds`).
- Button title + tooltip on hidden issues both updated to reflect the new behaviors.

Still LOCAL-ONLY — Phase 2 brings GitHub identity + sync.

---

## 2026-06-01 — AIM Issues v0.1 (NEW script, Phase 1)

First slice of the **CSM-collaborative issue flagging** tool. `latest/AIM_Issues.user.js` only — coworker installs at the repo root are not affected.

Phase 1 scope (this version):
- New 🚩 button injected into `.map-tools` — inserts itself immediately **before** PLE's ⚡ so the two coexist without fighting for the LAST-child slot. Layout: gear → 🚩 → ⚡.
- M1 toggles **flag mode** (icon glows red, crosshair cursor on map, map drag temporarily disabled to keep drag-draw clean).
- In flag mode:
  - **Click-drag** = rectangle. Release commits.
  - **Shift+click** = polygon mode (sticky — subsequent clicks add vertices without holding Shift). Enter or double-click finishes; Esc cancels.
  - Floating draw toolbar (Cancel always present; Finish + Undo shown for polygon).
- Required **note modal** after draw completes (textarea, Ctrl/Cmd+Enter to save).
- **localStorage** per-site persistence (`aim-issues-site-<siteID>`). Phase 2 swaps this for GitHub sync.
- Render: dashed red `L.polygon` + ⚠ `L.divIcon` marker at centroid. Style switches by status (yellow for ready-for-review, grey for resolved, grey-blue for ignored) — Phase 1 only creates `open` issues so only the red style is exercised.
- **M1 on issue** = session-hide (resets on page refresh per design).
- **M2 on issue** = stub status modal showing the note + full history audit trail. Phase 3 wires the real state machine and transition buttons.
- Hover tooltip with status, age ("3 min ago"), note, author.
- Registered with AIM Controls under "Issues" with a single master toggle.
- Log tag `[AIM ISSUES]`.

Not in Phase 1 — Phase 2 adds GitHub sync, Phase 3 adds the multi-status state machine, Phase 5 adds SUM table integration + dedicated 🚩 panel, Phase 6 adds Mission Bank surface filtering. See `~/.claude/projects/-home-link-projects-ShortKeys/memory/project_aim_issues_design.md` for the full spec.

---

## 2026-05-31 (continued — Asset Inspector v3.40 → v3.53)

Massive Asset Inspector arc. All `latest/` only. The headline: end-to-end **asset subtype + name editing** via SUM table or right-click popup → queue → Apply pipeline drives Percepto's editor. Plus a new visibility eye column, M2-solo on entity-type filters, Tab/Shift+Tab navigation between inline edits, and several bug fixes in the Find-in-Sidebar + Apply path.

### Subtype editing arc (the headline feature)
- **v3.40** — drop Unshielded + Validated rows from the asset right-click popup (not meaningful for assets).
- **v3.41** — Phase 2+3 of asset cleanup: inline subtype edit on SUM table + right-click popup; Apply queue extended with `applyAssetSubtypeChange` that drives Percepto's Ant Select dropdown.
- **v3.42** — fix two bugs from initial subtype testing: (a) clicking the input bubbled to the cell's onclick and wiped the edit (`stopPropagation` on input mousedown+click), (b) DOM-driven Ant Select dropdown was unreliable — replaced PRIMARY path with React fiber walk per `feedback-react-fiber-walk-for-ant-actions`. DOM path kept as fallback.
- **v3.43** — clicking a subtype cell now auto-pans the map to that asset (removes the extra click).
- **v3.50** — Name cell is also click-to-edit (queues a rename) for non-segment entity rows. M2 always copies. Apply pipeline extended to handle name + subtype together for assets and name + altitudes for FFZ/FP/NFZ/GM.
- **v3.51** — Apply queue Find-in-Sidebar: replaced scroll-walking the virtualized list with paste-into-search lookup. User reported 1/4 asset edits succeeded — scroll cap of ~30 viewport-heights was missing entities below it. Search filter always brings the target into the small visible window regardless of position. Bonus: clear the search at end of pipeline so the sidebar doesn't show stale state.
- **v3.52** — keyboard-driven rhythm: (a) Subtype + Name cells get `nowrap + ellipsis` so the pending overlay doesn't double row height; (b) `tableWrap.scrollTop` preserved across redraws — every commit was dumping you to the top; (c) Tab/Shift+Tab in inline edits walks to the next/prev row's same-column cell, committing + opening edit in one keystroke. Spreadsheet-like rapid-fire edits.
- **v3.53** — new "Bulk → Subtype" button alongside Bulk → AGL / Bulk → Delta. Same datalist autocomplete as inline editor. Scope: selected (default if any) / all assets. Free-text values get the "Enter new type" path during Apply.

### Right-click popup
- **v3.45** — fix Find in Map Entities regression. Two functions both named `findEntityInSidebar` — JS hoisting made the later (apply-queue, takes string name) shadow the earlier (popup, takes entity object). Popup silently called the wrong one. Renamed apply-side to `findAndClickSidebarItem`.
- **v3.46** — Find in Map Entities now auto-clicks the result row after filter — no more separate manual click to open the editor.

### Entity-type filter chips
- **v3.44** — M2 on any filter chip "solos" that type (all others off). M2 again restores all. Saves 4 clicks when narrowing to a single type. M1 still toggles individually.

### Per-entity visibility (NEW column)
- **v3.47** — new 👁 column at the left of the SUM table. M1 toggles that one entity's visibility on the map (drives Percepto's sidebar checkbox). M2 solos (uncheck + collapse every section, then search + check just this one). M2 again unsolos. Architecture drives Percepto's native sidebar checkboxes via the search filter + section parent checkboxes — avoids the virtualized-list problem.
- **v3.48** — fix M2 solo only turning off FFZ. Loop `walkSidebarSections` until stable (scroll-to-top each pass + re-query); virtualized list only renders top 1-2 section headers when sections are expanded. Diagnostic console.log per pass.
- **v3.49** — fix M2 unsolo only restoring FFZ + speed-up. New `collapse-only` walk mode used before the `on` walk during unsolo — clicking a section's parent checkbox while collapsed auto-expands the section, filling the viewport and pushing the rest off the virtualized list. Collapse everything first → check everything second. Halved most sleeps.

### Other
Smaller scroll/scroll-tracking fixes baked into the rhythm work in v3.52.

---

## 2026-05-31 (`latest/` dev work)

Power Line Editor **Phase 3 SHIPPED** (was backlog at end of yesterday): branch from vertex + snap to vertex AND segments. Plus a series of modify/delete op fixes, and a brand-new **AIM Map Nav** script for keyboard navigation. All `latest/` only — coworker installs at the repo root are unchanged.

### Power Line Editor Phase 3 — branch + snap

- **Map Styler v34.61** — Phase 3a: **branch from vertex**. Ctrl+click any cyan vertex handle during vertex-edit → saves current line's edits, then enters draw mode with vertex 0 seeded at the source vertex's coords. New line is same kmlType as parent. `enterDrawMode(type, seedCoord?)` extended with optional seedCoord; `ENTER_DRAW_MODE` bridge message accepts optional `seedCoord {lat,lng}`. Draw toolbar label becomes "Branching new …" when seeded.
- **Map Styler v34.62** — toast positioning fix. `showKMLToast` bottom moved 80px → 170px so it sits ABOVE the draw / vertex-edit toolbars (both at bottom:100px) instead of stacking behind them.
- **Map Styler v34.63** — Phase 3b: **snap to vertex**. While dragging a vertex (vertex-edit) or clicking to place one (draw mode), if the candidate position is within 10px of an existing power-line vertex (file or pending-add, distro or trans, except the line being edited/drawn), coord snaps to that vertex's exact lat/lng. Yellow ring marker shows the snap target.
- **Map Styler v34.64 + PLE v0.14** — purple snap glow + green-line delete fix. Snap indicator switched from yellow → bright light purple (`#d49eff`), 22px → 28px circle with double-layered glow. PLE bug: `deleteLineMode` was only checked in the file-line branch of onLineClick; green pending-add line clicks fell through to vertex-edit. Now PLE sends `DISCARD_ADDED_LINE`; Map Styler splices `co.added[addedIdx]` (after exiting any active added-line vertex edit to avoid a stale `addedIdx` after the array shift).
- **Map Styler v34.65** — modify/delete op clobber fix. Two related bugs around `co.ops[pmIdx]` mutual exclusion: (a) `exitVertexEdit({save:true})` unconditionally wrote 'modify', silently overwriting a pending 'delete' → line "turned back to yellow" after save. Now checks existing op; if 'delete', refuses save and toasts "vertex edits discarded — unmark deletion first if you want to keep edits". (b) Right-click menu hid "Mark for deletion" entirely when a 'modify' was pending. Now always shown; with a modify the label becomes "🗑 Mark for deletion (discards pending edits)" and clicking replaces modify with delete in one step. Also: darker snap purple (`#9333ea`, purple-600).
- **Map Styler v34.66** — **snap to segments**. `findSnapCandidate` now also tests perpendicular foot onto every line segment (clamped to `t in (0,1)` so endpoints stay vertex-test territory — vertex snap still wins when near a corner). Unified `testLine()` walks coords once, hitting every vertex + every segment in a single pass. Result: snap latches onto any point along another power line, not just at vertex endpoints.

### NEW DEV SCRIPT — `latest/AIM_Map_Nav.user.js` (Phase 4)

**Map Nav v0.7** (after a ton of iteration: v0.1 → v0.7). Keyboard nav for the Percepto map.

Final bindings:
- **WASD** = pan up/left/down/right (always-on)
- **Q/E** = zoom out/in (always-on)
- **Alt** + any nav key = sprint (3x pan, 1.0 zoom-levels)
- **Space** = zoom-to-fit entire site setup
- **Shift+drag** = native Leaflet box-zoom (built-in, not us)

Critical design rule: **Shift + ANY nav key passes through to the existing macros** (Shift+D Delete, Shift+A Altitude, Shift+R Ruler, Shift+B Bulk, Shift+C Clear, etc.). **Ctrl + ANY nav key passes through to browser shortcuts** (Ctrl+W close tab, Ctrl+S save, …). Map Nav never preventDefaults when those modifiers are held.

Iteration history:
- **v0.1** — always-on WASD with Shift sprint. Broke every Shift+letter macro on the user's system (Shift+D Delete most painful).
- **v0.2** — hold-Space modal. User found it ergonomically awkward; slip-off still triggered macros.
- **v0.3** — current architecture. WASD/QE always-on, Alt for sprint, Space for fit-to-site. Shift/Ctrl bypass via early-return.
- **v0.4** — added Shift+Space → zoom in close at cursor.
- **v0.5** — cross-frame map lookup. Critical fix: when focus is on TOP frame, keydown fires there but the map lives in the iframe. `getLeafletMap` now walks same-origin iframe `contentDocument`s so TOP can find and operate on the iframe's map directly. Fixed "WASD doesn't work until M1 click" bug.
- **v0.6** — reduced Shift+Space target zoom + added `AIM_MAP_NAV_FORWARD` channel. When the cursor enters the iframe area, the OS stops sending mousemove events to TOP — TOP's cursor tracker froze at the boundary. Iframe always has fresh cursor. TOP now forwards Space chords to iframe.
- **v0.7** — dropped Shift+Space entirely. User discovered Leaflet's built-in Shift+drag box-zoom. Strictly better. Net -132 lines.

Registers with AIM Controls as "Map Nav" section: master + WASD pan + Q/E zoom + Space toggles.

Architecture notes:
- rAF tick while any motion key held → smooth ~60fps pan
- Zoom throttled to one step per 200ms (OS auto-repeat at ~30Hz would otherwise burn 30 zoom levels per second)
- Alt tracked via dedicated AltLeft/AltRight keydown/keyup so speed multiplier updates instantly mid-pan
- blur clears all state so tab-away doesn't strand a panning map
- Self-contained Leaflet detection — works without Map Styler installed, but uses `__aim_map__` hint when present

---

## 2026-05-30 (continued — `latest/` dev work)

These versions live in `latest/` only and are NOT yet promoted to prod. They form the first complete arc of the **AIM Power Line Editor** — a new dev-only userscript paired with major Map Styler bridge + commit-pipeline improvements. Coworker installs at the repo root are unchanged.

### NEW DEV SCRIPT — `latest/AIM_Power_Line_Editor.user.js`

**Power Line Editor v0.1 → v0.13** — discoverable UX layer on top of Map Styler's existing KML edit infrastructure. Floating ⚡ button at the bottom of `.map-tools` (below the gear). M1 click toggles a small persistent icon strip below it. M2 (right-click) toggles edit mode (bolt glows neon green when on, greyscales when off). Inside the strip:
- `[+D]` / `[+T]` — add new distribution / transmission line (click map to add vertices, Esc cancels, Save in the green floating toolbar)
- `[🗑]` — toggle delete-line mode. While armed, M1 on any power line marks the whole line for deletion (instead of entering vertex edit). Crosshair cursor over lines when armed. Session-only, never persists across reloads.
- `[✓]` — commit all pending changes to GitHub (only appears when dirty)
- `[✗]` — discard ALL pending (only appears when dirty)

Also registers with AIM Controls as a "Power Lines" section (master toggle + edit mode toggle there too, both kept in sync with ⚡).

**Phase 1 complete**: enter edit on M1 click of any power line, drag vertex handles, Save/Discard, Commit pipeline. Pending changes survive across reloads in GM storage.

**Phase 1.5 complete**: edit saved-but-uncommitted (green) lines. M1 a green line → cyan handles drop, drag → edits write back to `commitOps.added[addedIdx]`. Line stays green/pending until Commit pushes the modified coords to GitHub.

**Phase 2 complete**: delete individual vertices (M2 right-click any handle — refuses if it would leave <2 vertices), add new vertices on existing segments (click any dim midpoint ghost handle — inserts a new vertex at that position), delete entire lines (delete-line mode toggle).

### Map Styler bridge + commit improvements paired with PLE

- **v34.44** — initial PLE bridge over `AIM_POWER_LINE_EDIT` channel + status broadcast.
- **v34.45** — fix TDZ on `powerLineEditorChannel` (was declared after first use).
- **v34.46** — fix commit bridge: was calling legacy `commitKMLChanges` (hides only); now calls `commitPendingOps` (modify/delete/added). Also dropped the redundant draw-mode showKMLToast (the floating green draw toolbar already tells the user what to do).
- **v34.47** — Phase 1.5 backend: `enterAddedVertexEdit(type, addedIdx)` for green pending-add lines. Live-drag feedback via `vertexEditState.currentCoords` check in the render loop.
- **v34.48** — fix double-fire on PLE bridge. `isActive` was true in BOTH TOP + IFRAME (auto-activation timer); added `getLeafletMap()` check so only the iframe-with-the-map actually fires commands. Previously caused duplicate PUTs → first succeeded, second 409'd.
- **v34.49** — cache post-PUT SHA + xmlText, skip GET on subsequent commits. Fixes "add → commit → delete-something → commit → 409 Conflict" caused by api.github.com eventual-consistency. Invalidates cache on 409 so a retry does a fresh GET.
- **v34.50, v34.51** — diagnostic logging for commit pipeline.
- **v34.52** — added a 5-min trust window for local cache (skip network fetch if just-committed) to avoid stale CDN content overwriting local. **Removed in v34.53.**
- **v34.53** — switch KML fetches from `raw.githubusercontent.com` (5-min CDN cache, ignores cache-busters) to `api.github.com/repos/.../contents/...` (always fresh, rate-limited to 5000/hr per PAT — way more than our usage). Eliminates staleness entirely; coworker commits visible on any refresh.
- **v34.54** — prune stale commitOps with out-of-bounds pmIdx on every KML load + every commit attempt. Fixes "delete a line, commit, line still there" caused by a stale pmIdx (from a previous session) referencing a line that no longer exists post-other-deletes. Toast tells user when stale marks were dropped.
- **v34.55** — Phase 2 backend: right-click a vertex handle in vertex-edit to delete that vertex (refuses if <2 left). New `MARK_LINE_FOR_DELETE` bridge message for PLE's delete-line mode.
- **v34.56** — fix vertex drag closure bug (`vertexIdx` captured at creation went stale after a delete shifted the array; now uses `handles.indexOf(e.target)`). Also: `discardCommitOps` now cleanly exits any active vertex-edit / draw-mode session so floating toolbars + handles tear down together.
- **v34.57** — Phase 2 ghost midpoint handles: between every pair of adjacent vertex handles, render a smaller dim cyan ghost. Click → inserts a new vertex at the midpoint. Refactored into shared `rebuildVertexHandles()` helper for enterVertexEdit + enterAddedVertexEdit.
- **v34.58** — diagnostic logging for PLE click → bridge chain.
- **v34.59** — make pending-add (green) lines always clickable regardless of edit-mode. Root cause unclear — `editMode` flag should have gated yellow and green the same way but only yellow was clickable. Brute-force fix: green lines never need the gate (they're transient user-drawn content).
- **v34.60** — midpoint handles follow vertex during drag (was snap-on-drop). `rebuildMidpointPositions()` now fires per drag event instead of just dragend.

### Control Panel v1.25
- Shifted the dropdown's right anchor from `0` to `35px` so the new PLE icon strip below ⚡ doesn't get covered by the AIM Controls panel.

### latest/ folder housekeeping
- New `latest/AIM_Power_Line_Editor.user.js` added to the install list in `latest/README.md`.
- Updated `latest/README.md` to call out that the GitHub PAT is per-`@name` GM storage and needs to be re-pasted into the Latest Control Panel when first installing the `latest/` set.

---

## 2026-05-30

- **AIM Control Panel v1.24** — **STABILITY FIX: hide-satellite checkbox unresponsive + several inputs need multiple clicks before they accept edits.** Both bugs shared one root cause. When you opened the panel, the broadcast `REQUEST_REGISTRATIONS` made every script in both TOP and IFRAME (~28 contexts) re-register. Each REGISTER triggered a full `renderPanel()` that wiped the panel's innerHTML, plus echoed N `SET_TOGGLE` messages — and each echo bounced back through the cross-context panel triggering ANOTHER renderPanel. The panel was re-rendering dozens of times in the first ~500ms after open. If you clicked a checkbox or input during that burst, the element was destroyed mid-click and the change event was lost. Three coordinated fixes:
  - **rAF-debounced render**: all internal re-render triggers now coalesce into one `requestAnimationFrame` callback. Burst of 28+ render requests = 1 actual render.
  - **Idempotent `handleRegister`**: re-registers with structurally identical payloads (same toggles, hotkeys, version) skip both the SET_TOGGLE echo broadcast AND the re-render.
  - **Idempotent SET_TOGGLE echo**: if the broadcast value matches what's already in prefs, no re-render is triggered.
  - **Symptom check after install**: open the panel, click "Hide satellite base tiles" — should toggle on the first click every time. Click any number/color input — should accept focus on the first click. Watch console for any new errors (none expected).

---

## 2026-05-29

- **AIM Asset Inspector v3.39** — **NEW: shared elevation DB on the team's GitHub data repo.** First-visit fetches per site are now a thing of the past for any teammate who comes after you.
  - **Three-layer cache**: in-memory → GM_setValue (per-user local) → `Ned-Yap/aim-userscripts-data/elevations/<siteID>-elevation.json` (team-shared).
  - **On SUM panel open**: if local cache doesn't fully cover this site's sample points, pull the shared file from GitHub and merge non-overlapping entries into the local cache. Skipped entirely if local already has everything (no GitHub round-trip on a warm-cache reload).
  - **On bulk-fetch completion** (when N new points were just fetched from Percepto): auto-push the updated cache back to the shared file. Throttled to one push per site per session.
  - **Auth**: uses the GitHub PAT broadcast by Control Panel (same `TOKEN_VALUE` pattern Map Styler + MBT use). No PAT = read-only mode (still pulls shared data, just doesn't push).
  - **New permissions**: `@grant GM_xmlhttpRequest` + `@connect api.github.com` + `@connect raw.githubusercontent.com`. Tampermonkey will prompt on update — approve to enable.
  - **Conflict handling**: if a teammate pushes during your run (409), we skip and re-pull next session. No silent overwrites.
  - **Data repo prep**: created `elevations/` directory with a README so first PUT doesn't fail with a path-not-found.
- **AIM Asset Inspector v3.38** — **CRITICAL FIX: `@grant none` was making EVERY persistence call a silent no-op.** Has been broken since v3.12 when persistence was first added. The `elevGmGet`/`elevGmSet` helpers checked `typeof GM_getValue === 'function'` and silently did nothing when the function didn't exist — `@grant none` makes GM_* unavailable. The v3.37 "checkpoint persisted N entries" log was lying — no actual storage call ever happened. Affected: DEM elevation cache, column-order persistence, show-samples toggle, column-customization. Added `@grant GM_getValue` + `@grant GM_setValue` headers. Also added a loud one-time `console.warn` if these somehow go missing again, so it can't silently break.
- **AIM Asset Inspector v3.37** + **AIM Mission Bank Tools v0.51** — **fix persistent DEM cache.** Diagnostic in v3.36 confirmed it: every page reload was loading 0 cached points and re-fetching everything. **Root cause:** GM_setValue is async in Tampermonkey (Chrome's `chrome.storage` backend). The old 1-second debounced write never had a chance to fire mid-bulk-fetch (every completion reset the timer). On page refresh, `beforeunload` tried to flush but the async write didn't complete in time. Cache evaporated. **Fix:** checkpoint write every 50 new entries during the fetch — commit-as-you-go. Trailing 1s debounce still catches the tail. Both scripts use the same pattern so both got the same fix. Console now logs `[AIM AI] DEM cache checkpoint: N total entries persisted` every batch so you can watch the cache grow. After this version, the second page-load on a site should show high cache hits (close to 100%) until you add new entities.
- **AIM Asset Inspector v3.36** — Power line height configuration + DEM cache diagnostics.
  - **Power lines now sit at realistic wire height in 3D** instead of flat on ground. New "Power line heights (3D only)" panel in the Analyzer modal: Distribution default **35 ft AGL** (Permian Basin typical 30-45 ft), Transmission default **80 ft AGL** (varies 40-150 ft by voltage class). Inputs are per-export so you can dial per site. Folder labels include the height (`Power Lines - Distribution (218) @ 35 ft AGL`). 2D mode unchanged (lines clamp to ground).
  - **DEM elevation cache diagnostics.** On every page load you'll see in console: `[AIM AI] DEM elevation cache loaded: N points (KB)` so you can verify the persistent cache survived between sessions. On every SUM panel open: `[AIM AI] DEM bulk for site X: N unique sample points · M cache hits · K new (need fetch)`. If "new" stays high across reloads, that's the smoking gun the cache isn't persisting (Tampermonkey storage eviction, key mismatch, etc.). Report back with the numbers.
- **AIM Asset Inspector v3.35** — Power Lines KML colors now match Exxon Powerlines standard. Distro = YELLOW thin lines at ~50% opacity (`8000ffff`); Trans = RED slightly thicker at ~70% opacity (`b30000ff`). V-Buffer moved from yellow → BLUE (`ffff0000`) so it doesn't clash with the distro standard. V-Buffer is used less often than Power Lines, so it gets the new color.
- **AIM Asset Inspector v3.34** + **AIM Map Styler v34.43** — KML Analyzer per-entity elevation + Power Lines import.
  - **Asset Inspector v3.34: per-entity elevation from existing DEM data.** Stopped trying to guess a single "Site Datum Elevation" from asset-elevation averages — that was wrong because assets vary across the site (hill vs valley). Now each placemark shows its OWN `Ground Elevation (here)` (max DEM at this entity's sample points — the data we already fetch for the SUM panel). AGL is computed per-entity against that local ground, not a global guess. If DEM hasn't loaded yet for an entity, the AGL line gracefully omits and shows MSL only.
  - **Asset Inspector v3.34: Power Lines folder import.** New "Power Lines" checkbox in the Analyzer modal. Requests parsed KML features from Map Styler over a dedicated `AIM_KML_DATA` BroadcastChannel; renders distro lines as cyan + transmission lines as red folders in the export. Hidden lines (user marked them hidden in Map Styler) are skipped. Status text in the modal live-updates: "(requesting…)" → "(loaded N lines)" or "(not loaded — open Map Styler tab to fetch)". Disables the checkbox if no data is available.
  - **Map Styler v34.43**: responds to `REQUEST_KML_FEATURES` on the `AIM_KML_DATA` channel with the parsed features for the requesting site. Only responds if data is loaded for that exact site (no stale-data leak across site navigations). Doesn't re-fetch from GitHub — just shares what's already in memory.
- **AIM Asset Inspector v3.33** — Site Setup Analyzer description + altitude polish:
  - **Assets no longer underground.** Switched Assets + NFZs from `absolute` altitude (which needed an accurate site_ground_elevation — we don't always have one) to `relativeToGround`. Google Earth now follows the actual terrain at each entity's exact location, so Assets sit at ~20 ft above the surface they're on, regardless of site datum. NFZ columns are 400 ft tall above local ground.
  - **Restored full description data.** v3.32 missed the raw `item.description` field — that's where Percepto's "Desig: x | Div: y | Cat: z | Type: w | ID: nnnn" header lives for assets. Now included verbatim as the first description block (matches Python).
  - **AGL + MSL dual altitudes** in all altitude lines, formatted like Python: `Min Altitude (AGL): 102.7 ft / 31.3 m | (MSL): 3,056.0 ft / 931.5 m`. Site Datum Elevation prominent in each placemark.
  - **Better Site Datum calculation.** Three-tier fallback: (1) average of all asset `custom.elevation_asl` values — most reliable, real Percepto MSL data; (2) average of DEM-cached centroids; (3) zero with the line omitted. Was always falling to zero before because DEM cache often empty at export time.
- **AIM Asset Inspector v3.32** — Site Setup Analyzer rewritten for **exact Python parity** (after v3.30's restructure diverged too far from what coworkers expect in Google Earth).
  - **Colors now match AIM exactly** — Freezone GREEN (`ff00ff00`), No-fly RED (`ff0000ff`), Flight Path CYAN (`ffffff00`), Asset WHITE, Vertical Buffer YELLOW, Horizontal Buffer ORANGE. Same KML color values the Python stand-alone uses + same Percepto on-screen colors.
  - **Folder structure mirrors Python output** — separate top-level folders: `Asset`, `Flight Path`, `Freezone`, `No-fly`, `General Marker - General/Tower/Hazard` (3 separate folders, not consolidated). Plus `Freezone Vertical Buffers` + `Flight Path Vertical Buffers` for 3D.
  - **FP segments now have visible vertical height in 3D** — emitted as a rectangular WALL polygon spanning min_alt → max_alt, not a flat 3D line. This was the major v3.30 bug.
  - **FFZ in 3D is now a proper extruded box** — bottom cap + top cap + one wall polygon per edge, all wrapped in MultiGeometry. Renders as solid 3D volume in Google Earth (v3.30's 2-polygon attempt rendered as wireframe).
  - **NFZ in 3D now extrudes from ground** — polygon at 400ft AGL with `extrude=1`, matches Python.
  - **Asset in 3D extrudes** — polygon at 10ft AGL with `extrude=1`.
  - Style IDs match Python (`freezone_style`, `flightpath_style`, etc.) so anyone diffing both outputs sees the same structure.
- **AIM Asset Inspector v3.31** — fix: KML download blocked by iframe sandbox. Percepto loads us into a sandboxed iframe that lacks `allow-downloads`, so the v3.30 anchor-click download failed silently with a console message. Fix: do the blob creation + anchor + click in the TOP window's context (parent frame, not sandboxed). Falls back to in-frame attempt if `window.top` is cross-origin. If both fail, the existing "Copy to clipboard" path still works.
- **AIM Asset Inspector v3.30** — **NEW: Site Setup Analyzer (KML export, Phase 1).** Replaces the Stand_Alone_AIM_SS_Generator_V8.pyw workflow for the common case (Google Earth visualization). New 🗺️ **Analyzer** button in the SUM panel toolbar (next to 📊 Summary) opens a modal:
  - **2D mode** — all geometry clamped to ground (flat polygons + lines + pins).
  - **3D mode** — Assets extruded to their claimed `elevation_asl`; FFZ/NFZ extruded as `MultiGeometry` boxes from `min_alt` to `max_alt`; FP segments drawn as 3D lines at `min_alt`; markers at `marker_height` (when set). Includes optional **Vertical Buffers** (50 ft below FFZ min + FP min) as separate folders.
  - **Folder structure restructured for clarity** vs the Python output: General Markers consolidated into ONE parent folder with subfolders by type (Tower / Hazard / General) instead of 3 sibling top-level folders. Folder names spelled out ("Free-Fly Zones" not "Freezone"). Short style IDs to shave file size.
  - **Per-folder include checkboxes** in the modal — exclude anything you don't want in the output.
  - **Two export paths**: 📋 Copy to clipboard or ⬇ Download `.kml` (browser blob download). Filename: `Site_<id>_Map_(<mode>).kml` (matches the Python naming convention).
  - **Description blocks** are compact single-line HTML (no padding `<br><br><br>` like the Python). Each entity shows site datum, subtype, dual-unit altitudes (ft AGL / ft MSL), notes if present, ⚠ Unshielded flag if set. FP segments also show parent FP name, segment number + ID, distance, and an ⚠ Approval Required flag.
  - **NOT in this phase** (deferred to v3.31+): H-Buffer geometry (needs shapely-equivalent polygon buffer math), validation rules + Violations folder, GitHub upload of generated KML to `aim-userscripts-data`.
- **AIM Map Styler v34.42** — **NEW: "Unhide all file-hidden lines" button** in both Distro and Trans category settings. One-click recovery for broken KML exports (the 1598-distro.kml situation we hit earlier — Google Earth had shipped every placemark with `<visibility>0</visibility>`, making them all invisible with no easy way to interact). The button walks the parsed features for the category, finds every placemark the FILE says is hidden, and creates a local-pending override flipping it visible. Idempotent (re-running does nothing if all lines are already showing). No GitHub roundtrip — purely a local view override. Toast confirms how many lines were unhid. Pairs with the existing "Clear all my local hides" — that one wipes pending overrides; this one ADDS overrides to flip file-hidden lines visible.
- **AIM Asset Inspector v3.29** — search box now matches Segment ID too. Type "2571" to find arc 2571233. Search placeholder updated to "Search name, subtype, or Seg ID…".
- **AIM Asset Inspector v3.28** — **NEW: Segment ID column** in the SUM panel.
  - Shows `arc.id` for FP segment rows (the value from Percepto's JSON), dash for everything else.
  - **Right-click → copy** the raw ID for cross-ref into JSON exports / screenshots / coworker chats.
  - **Caveat in tooltip + commit msg**: arc IDs are NOT stable across Percepto saves — they regenerate on every FP edit. Useful as a snapshot reference, not as a permanent identifier. The segment NUMBER (1, 2, 3…) IS stable.
  - **Migration**: existing users' saved column orders auto-merge the new `segId` column in its default position (between Name and Subtype). You won't need to manually toggle it on.
- **AIM Asset Inspector v3.27** — **remove post-save verification entirely.** The verification step I added in v3.24 has caused more problems than it solved: Percepto stores integer meters internally, so writing 39 ft (= 11.887 m) round-trips back as either 11 m → 36 ft or 12 m → 39 ft depending on Percepto's rounding direction. Either way the verification flags it as a "mismatch" because the round-trip drift is ~3 ft. Bumping the tolerance in v3.26 helped but didn't solve it — drifts on bigger numbers (e.g. 2746 → 2743) still trip the alarm. The bulk-altitude-updater this pipeline is modeled on doesn't verify either, and it's solid. New behavior: editor closed cleanly + no validation error toast = save succeeded. Stop trying to second-guess Percepto.
  - Pre-flight checks (duplicate names, stale-queue warnings, validation-error detection during save) stay — those caught real issues. Just the after-save re-read is gone.
  - Audit log still written.
  - Auto-refresh after run still fires.
- **AIM Asset Inspector v3.26** — fix stale-data false verification failures.
  - **ROOT CAUSE**: `fetchMapObjects()` was NOT awaitable — returned `undefined` synchronously while firing a background fetch. My `await fetchMapObjects(...)` in the verification step did nothing. The read happened against the in-memory cache which still held the **pre-save** snapshot. Plus the fetch had no cache-busting, so even when it did complete, HTTP/CDN caches could return the stale response.
  - **Fix 1**: `fetchMapObjects()` now returns a `Promise` that resolves after `mapObjectsBySite` is updated. Callers' `await` actually waits.
  - **Fix 2**: When called with `force=true`, the URL gets a `&_t={timestamp}` cache-buster + `Cache-Control: no-cache` headers + `cache: 'no-store'` fetch option. Bypasses browser, CDN, and any reverse-proxy cache.
  - **Fix 3**: `force=true` also bypasses the in-flight dedup so a stale concurrent request can't cause us to short-circuit out of getting fresh data.
  - **Fix 4**: Backend commit window — verification now sleeps 1 s after editor close before re-fetch (was 600 ms after re-fetch). FP saves with many segments need that.
  - **Fix 5**: Verification tolerance bumped from 0.5 m to 1 m (2 ft) and now compares in DISPLAY UNITS. Percepto stores integer meters internally, so writing 39 ft (= 11.887 m) may round-trip back as either 12 m → 39 ft or 11 m → 36 ft depending on Percepto's rounding direction. The new tolerance covers both. Stale-queue check tolerance bumped the same.
  - **Better error logs**: failure message now includes the actual mismatched values (`min_alt: wrote 39 got 36`) instead of just a count.
- **AIM Asset Inspector v3.25** — fix Percepto's arc-ID regeneration false-failures + auto-refresh after apply.
  - **ROOT CAUSE**: when Percepto saves an FP, it regenerates every arc with a new `id` (e.g. 2558017 → 2571233). v3.24's post-save verification looked up arcs by `arcId` to confirm the new value stuck — `find()` returned nothing for the new IDs → reported "save succeeded but 28/28 value(s) didn't stick" even though the data actually saved correctly. Same bug bit the apply step on retries: stale queue arc IDs no longer matched the editor's current arc list.
  - **Fix**: queue entries now also store `arcIndex` (position in `entity.arcs`). That position is stable across saves. Both apply and verification now try `arcId` first, fall back to `arcIndex` when the ID lookup fails. Console logs the fallback when it kicks in.
  - **NEW: auto-refresh after apply.** When a live run finishes with at least one successful save, the SUM panel auto-refreshes (refetch + re-render). User sees the updated state immediately without clicking Refresh. Dry runs and aborted runs skip the refresh (nothing to show).
- **AIM Asset Inspector v3.24** — **Bulletproof apply** pass. After the first successful live run (v3.23), hardening across nine specific failure modes:
  - **FFZ matcher fix.** v3.23 picked up `Minimum emergency altitude` as a Min match (harmless because we only wrote to `minInputs[0]`, but a risk if Percepto ever reordered the inputs). Now explicitly excludes any label containing "emergency" / "emerg".
  - **Pre-flight: duplicate name detection.** If any queued entity has a same-named sibling on the site, the run REFUSES to start (we couldn't safely click "the right one"). Shows which names are duplicates.
  - **Pre-flight: stale-queue check.** Each queued edit's `oldValueM` is compared to Percepto's CURRENT value (re-read from the in-memory bucket). Drift = someone else edited the entity, or a partial prior apply succeeded. Surfaces as a yellow warning panel in the launcher modal — user can still proceed (apply will overwrite) or cancel.
  - **Post-save verification.** After save closes the editor, the script force-fetches `map_objects` and re-reads the entity. If the value we wrote isn't what's actually in Percepto's data (rounding / silent rejection / etc.), the entity is marked failed even though the editor closed cleanly. Catches silent rejections that v3.23 would have falsely called "SAVED ✓".
  - **Validation-error detection.** After save click, the script scans for `.ant-message-error`, `.ant-notification-notice-error`, and `.ant-form-item-explain-error`. Any visible error → entity marked failed with the actual error text in the audit log.
  - **Longer timeouts.** Editor open + save waits bumped from 8 s → 15 s. Tolerates slow networks + heavy entities (FPs with many segments take ~3-4 s to save on a busy site).
  - **Bulletproof state cleanup.** Outer try/catch around the whole pipeline guarantees `applyState.running` returns to `false` even on unhandled exception. Without this, a thrown error would leave the UI stuck thinking a run is in flight forever until page refresh.
  - **NEW: Dry-run mode.** Launcher modal now offers a purple `🧪 Dry Run (no save)` button alongside the green `▶ Apply for real`. Dry run walks the entire pipeline (opens editors, sets values, scans for validation errors) but **cancels instead of saving** — verify the script targets correctly without touching live data.
  - **NEW: Audit log.** After every run, `window.__aim_ai_lastApplyLog` holds per-entity outcomes: site, timestamps, total duration, edits requested vs applied, success/failure with reason, per-edit before/after values, post-save verification result. Console-accessible for after-action review (`copy(JSON.stringify(window.__aim_ai_lastApplyLog, null, 2))` to clipboard for paste into a Sheet).
  - **NEW: Launcher modal.** Replaces the plain `confirm()` with a richer dialog: edit + entity counts, FFZ-first order callout, ETA, stale-queue warnings panel (when present), dry-run explainer, three clear buttons (Cancel / Dry Run / Apply).
- **AIM Asset Inspector v3.23** — apply-pipeline fixes after first live test.
  - **Fixed: editor detection.** v3.22 looked for `.upsert-entity__title` which doesn't exist in current Percepto. Switched to reading the entity name from the `#upsert-entity-form-name` input value. This was the root cause of every "editor did not open" failure.
  - **Relaxed match.** If the editor opens but the name doesn't match what we clicked, we now WARN + skip (don't write wrong values) instead of looping forever waiting for the right title. Removes the 8-second per-entity stall on mismatch.
  - **One-click retry.** If the editor doesn't open within 8 s of the first sidebar click, retry the click once (Percepto's sidebar occasionally drops a click mid-render).
  - **Multiple sidebar item selectors** — tries `.map-entities__entity-item`, `.map-entities__entity`, `.map-entities__list-item`, etc. so a future Percepto class rename doesn't break the entire pipeline.
  - **Diagnostic logging** — every step prints to console with the `[AIM AI] apply: ...` tag. Per entity: starting · clicking sidebar item · editor open · found N Min/Max inputs · set N values · SAVED. Failures log the specific reason. Re-run + share the console output if anything still misbehaves.
- **AIM Asset Inspector v3.22** — **▶ Apply queue — automated commit of pending altitude edits.** New green button in the queue footer drives Percepto's entity editor for every queued Min/Max edit. Behavior:
  - **Grouped by entity** — an FP with 6 queued segments opens the editor ONCE and saves ONCE.
  - **FFZ-first ordering** — all FFZs apply before any FP segment. Required by AIM's overlap/steepness safety checks (FP saves fail if FFZ endpoints haven't moved yet).
  - **Strong confirm dialog** before launch — estimates time, warns the user not to click around.
  - **Modal progress overlay** during run: live label "X of Y: entity_name (N edits)", progress bar, per-entity error list as they happen.
  - **Per-entity error handling** — missing input, editor failed to open, save timed out → log + skip, continue. Successful edits get popped from the queue; failures stay so the user can retry.
  - **Abort button** in the modal — finishes the current entity then stops cleanly. Already-applied edits remain applied.
  - **Final summary toast** — `✓ Applied N successfully` or `Applied X · N failed (see console)`.
  - Patterns lifted from `AIM_Bulk_Altitude_Updater.user.js` (proven on Percepto's live UI): `.upsert-entity` panel detection, `.flight-path-form-content__table-row` for FP segment inputs, label-text matching for FFZ inputs, React-aware value setter, `.upsert-entity__save-button` + last-primary-button modal confirm.
- **AIM Asset Inspector v3.21** — sample-point polish.
  - **Bigger + higher-contrast dots:** radius 3 → 6, black border + bright gold fill so they pop against any base layer (satellite, KML, drawing). Hovering is now actually doable.
  - **Skip NFZ + Asset from DEM sampling.** NFZs extend infinitely up (no flight planning under them). Assets carry their claimed `elevation_asl` (auto-set during creation) so a DEM lookup is redundant. Cuts ~30-40% of first-load queries on a typical site. FP segments + FFZs still sampled.
- **AIM Asset Inspector v3.20** — **Show elevation sample points on map** (verification tool). New toggle in the SUM panel toolbar (light purple) drops a small purple circle on the Leaflet map for every sample point used to compute each row's elevation. Hover any dot for a tooltip showing the entity name + that exact point's elevation in ft / m. Off by default, persists per user (GM_setValue). Refreshes whenever the filtered row set changes — filter the table to one FP, see just that segment's samples on the map. Uses Leaflet's canvas renderer so 1000+ markers stay responsive. Clears markers automatically when the SUM panel closes.
- **AIM Asset Inspector v3.19** — **Multi-point elevation sampling** with variable density per shape. Replaces v3.18's single-centroid-per-row sampling with a max-across-samples approach so the displayed Elevation is the **highest ground point the entity overlaps** — conservative for AGL planning.
  - **FP segments by length:** `<200 ft` = 3 samples (0/50/100%), `200-500 ft` = 5 samples (0/25/50/75/100%), `500-1000 ft` = 7 samples, `≥1000 ft` = 9 samples.
  - **Polygons (FFZ / NFZ / Asset):** every vertex + edge midpoints + extra subdivisions on edges longer than ~200 ft. Handles L / U / C corridor shapes natively — the perimeter traces the corridor and gets sampled along its entire length.
  - **Markers:** single point (unchanged).
  - **Assets:** still display their claimed `custom.elevation_asl`; DEM samples populate the cache as a side effect (no overwrite of the asset's claimed value).
  - **Display:** Elevation cell tooltip clarifies "Max DEM elevation across sampled points." AGL = Min Alt − this max. Same color rules.
  - **Performance:** first-load query count goes from ~N entities to roughly 5-10× that. Cache + in-flight dedup are unchanged so repeat visits are still instant. For a 323-entity site expect ~1500-2000 unique points, ~30-45 s on a fresh site. Progress bar accurately tracks all sample points.
- **AIM Asset Inspector v3.18** — Bulk → Delta + FFZ editing + DEM progress bar + FFZ-first commit ordering hooks.

- **AIM Asset Inspector v3.17** — **Live derived columns + AGL inline edit + Bulk → AGL button.**
  - **NEW: Bulk → Delta** button (yellow, next to Bulk → AGL). Popover has separate inputs for FP segments (default 20 ft) and FFZ entities (default 30 ft) — SOPs. Queues Max Alt = effective Min + target delta. Chains correctly after Bulk → AGL (uses the in-queue Min, not the original).
  - **FFZ inline editing** — FFZ Min / Max / AGL cells are now click-to-edit just like FP segments. Generalized the underlying `queueAltEdit` + `isEditableRow` helpers so any future entity type that supports altitude edits gets parity for free.
  - **Bulk → AGL** now includes FFZ rows (was FP segments only).
  - **DEM progress bar** appears above the table during elevation fetch. Shows `N / total (pct%)` with a moving fill; auto-hides ~600 ms after the bulk fetch completes. No bar at all when the cache already covers everything.
  - **Copy queue → Sheets** now exports a `Type` column (FFZ / FP) as the first column and sorts FFZs first — same order the v3.19 automated apply path will use (AIM's overlap/steepness checks block FP saves when their FFZ endpoints haven't moved yet).
  - Queue entries now carry an `isFfz` flag for the apply pipeline.

  - **Min/Max Delta** and **AGL** now update **live** when you edit Min or Max — both cells show the original value strikethrough + the new derived value in yellow. Edit one, watch the rest of the row reflect the new math instantly.
  - **AGL is now inline-editable on FP segment rows.** Click an AGL cell → text input pre-filled with current AGL. Type a target value (or formula). The script computes `new Min Alt = Elevation + target AGL` and queues a Min Alt edit. So you can approach altitude planning from either direction (Min ↔ AGL). Editor blocks if elevation hasn't loaded yet.
  - **NEW: Bulk → AGL** button in the toolbar (yellow). Opens a popover:
    - Target AGL input (defaults to `100` ft / `30` m).
    - Scope radio: **All FP segments** or **Selected segments only** (auto-selects "selected" when you have a multi-select).
    - Live preview: `Will queue N edits · skipping M already at target`.
    - One click → queues all eligible Min Alt edits in one shot. Skips segments already at the target value. You can still un-queue individual segments after by clicking the cell + typing back the old value, or by hitting Discard queue.
  - Right-click on Min/Max/Delta/AGL cells now copies the EFFECTIVE value (the new one if pending), not the original — matches what you see.
- **AIM Asset Inspector v3.16** — **NEW: inline edit + pending queue for FP segment altitudes (phase 1).**
  - **Click any Min Alt or Max Alt cell on an FP segment row** → cell turns into a text input. Type a new whole-foot value (or a formula like `2720+50` or `(2720+50)*2`). Enter/Tab/blur queues the edit; Esc cancels. Right-click on a cell with a pending edit copies the NEW value.
  - **Yellow pending markers:** queued cells show the original value struck-through plus the new value in yellow (`2,720` `2,800`). Hover for "was X, will be Y" tooltip.
  - **Queue UI in footer:** pill shows count (`📋 5 queued edits`); `Copy queue → Sheets` button copies TSV (Entity / Segment / Field / Old / New / Δ) for paste into your planning sheet; `Discard queue` button wipes the queue. UI only appears when there's something queued.
  - **Site-aware** — queue clears automatically when the user navigates to a different site (entity IDs wouldn't match anymore).
  - **NOT INCLUDED:** applying the edits to Percepto. This is the planning/queue half. v3.17 will add the "Apply via editor" button that drives Percepto's entity edit dialog for each pending change.
  - Matches MBT's `pendingAltitudes` pattern + formula parser.
- **AIM Asset Inspector v3.15** — SUM panel polish pass on top of v3.14:
  - **Reorderable + persistent columns.** Columns ▾ menu now mirrors MBT: visible columns at the top with ↑/↓ arrows to reorder + checkboxes to hide, hidden columns below the divider with checkboxes to add, Reset button to restore defaults. Order persists across reloads via GM storage (`aim-ai-column-order`).
  - **Comma-formatted altitudes** — Min Alt, Max Alt, Min/Max Delta now display as `2,633` instead of `2633`. Elevation already had this. AGL too.
  - **Right-click → copy raw** now works on Min Alt + Max Alt + Min/Max Delta cells (previously only Elevation). Copies unformatted whole feet (no commas, no units).
  - Renamed **Δ Alt** column → **Min/Max Delta** (clearer that it's the vertical span).
  - **AGL blue threshold** bumped from >170 ft to >200 ft. Color rule is now: red <90 / green 90-200 / blue >200.
- **AIM Asset Inspector v3.14** — **MAJOR: FP segments are now first-class table rows.** Replaced the v3.13 chevron+inline-sub-table design with a flat-table approach: each FP arc becomes its own row named `flight_path_N - Seg M`, sorts/filters/exports/multi-selects with every other row, no special expansion UI. Row click on a segment fits the map to that segment's bounding box (point_a + point_b) so you see the exact arc. Column layout reorganized: dropped Emergency Alt entirely; dropped separate "Asset Elev" + "DEM Elev" columns and merged into one **Elevation** column (assets show their claimed elevation_asl, everything else shows DEM at centroid/midpoint); renamed Δ Min−DEM → **AGL**; added **Δ Alt** column (Max − Min = vertical altitude span per row, useful for the Python "FP Vertical Span Violation" check we'll port later). Elevation column is MBT-style: light purple, bold, comma-grouped (`2,633`), **right-click copies raw unformatted number** for paste into formulas. Multi-select keys switched from `entity.id` to a composite `rowKey` so each segment row is independently checkable. JSON export dedups parent FPs (one entry per real entity, not one per segment row). Next step: bulk inline editing of segment altitudes with MBT-style queue + commit (v3.15).
- **AIM Asset Inspector v3.13** — **NEW: Flight Path row expansion.** Each FP row in the SUM panel now has a `▶` chevron on its Type cell. Click it to drop down a per-segment table showing: #, Segment ID, Distance, Min Alt, Max Alt, Emergency Alt, **Ground elevation at segment midpoint** (DEM, light purple), **Δ Min−Ground clearance per segment** (color-coded same as parent row: red <90 ft / green 90-170 / blue >170), and **Approval Required** flag (yellow YES pill when true). Lazy fetch — DEM only loads when the chevron is expanded; the rest of the row uses arc data already in the JSON. Sub-table inherits the panel's ft/m unit toggle. Per-row expansion state resets when the panel closes (it's an ephemeral view, not a saved preference). First step toward the FP Analyzer modal that'll add topology graph + violation rules + KML export in v3.14+.
- **AIM Asset Inspector v3.12** — **NEW: DEM ground elevation + Min−DEM clearance delta columns** in the SUM panel entity table. Ports the MBT v0.40-v0.50 pattern: same Percepto `/location_altitude/` endpoint, same cache + dedup + bulk fetch + one-render-at-end. New "DEM Elev (ground)" column (light purple) shows terrain elevation at each entity centroid (centroid derivation handles assets/markers/polygons/flight-path arcs). New "Δ (Min Alt − DEM)" column shows flight-clearance for FFZ/FP/NFZ — color coded RED <90 ft / GREEN 90-170 / BLUE >170 (matches navigate AGL thresholds). Existing "Elev" relabeled "Asset Elev" for clarity vs the new ground value. Both new columns toggleable + CSV/TSV exportable.

## 2026-05-28

- **AIM Map Styler v34.41** — full idempotency on the SET_TOGGLE handler. Single `if (newVal === prev) return;` guard at the top short-circuits ALL special-case logic for duplicate broadcasts (which arrive 2-4× per real toggle change because Control Panel runs in both TOP+IFRAME and re-broadcasts on every script REGISTER). Stops asset-lock CSS thrashing, redundant `setActiveState` calls, redundant edit-mode auto-on echoes, etc. Companion fix to Perf Shield v1.11 — together they cut the toggle-flicker cascade.

- **AIM Performance Shield v1.11** — full idempotency on all SET_TOGGLE handlers. Every toggle path (hide-satellite, ortho-lowres, ortho-lowres-zoom, suppress-debug-logs, plus all group toggles: block-intercom, block-weather, session-replay) now early-returns when the incoming value matches current state. Stops the toggle-flicker cascade where echoed SET_TOGGLE broadcasts (from Control Panel running in both TOP + IFRAME contexts) were each doing full work — write to GM, apply CSS, broadcast PERF_TOGGLE to Map Styler, trigger ortho recompute. Same change pattern is the model for future Map Styler / other-script stability passes.

- **AIM Mission Bank Tools v0.40 → v0.50** — DEM elevation feature + a sweep of perf hardening on top of the v0.39 architecture.
  - **v0.40 NEW: DEM ground elevation + AGL per step.** Piggybacks Percepto's own `/location_altitude/?location={lat,lng}` endpoint (returns `{altitude: meters}`, cookie-auth, same-origin) — found via DevTools while testing the Shift+A "Absolute altitude" tool. New `Elevation` column between Type and Value in the drill-down instructions table. New `AGL Δ` column (altitude − ground elevation) with color coding. New "Terrain / AGL" stats card with Min/Avg/Max AGL + ground-elevation range. GM-storage cache keyed by lat/lng rounded to 5 decimals (~1m precision); cache survives reloads + persists across sessions; bulk fetcher throttled to 4 concurrent. Cells show "…" while fetching.
  - **v0.41**: per-step-type AGL thresholds. Navigate steps use flight-clearance rules (RED <90 ft, GREEN 90-170, BLUE >170). Snapshot steps use camera-target rules (RED <0, GREEN 0-39, BLUE ≥40 — snapshots intentionally point at ground). Aggregate Min/Avg/Max AGL stats EXCLUDE snapshots so a low snapshot AGL doesn't drag the "minimum flight clearance" metric.
  - **v0.42**: snapshot high threshold tuned 50 → 40.
  - **v0.43 / v0.44**: visual polish — "Elev" → "Elevation" header, light purple elevation value (`#c4b5fd`), navigate row text switched green → soft teal (`#2dd4bf`) so it stops fighting the AGL pass green, GPS location coords switched cyan → white with underline.
  - **v0.45**: ELV caps to match ALT convention. Right-click any altitude value (Value column) copies the raw whole number (no comma, no unit). Step types display Capitalized (`navigate` → `Navigate`). Pen-edit on a step works even when already viewing that mission's editor (was failing with "Mission not found in sidebar" because the sidebar link query returns null in editor view) — now detects via URL hash AND falls back to a DOM presence check.
  - **v0.46**: elevation in-flight deduplication. Without it, every re-render re-queued uncached points; in-flight points aren't in the cache yet, so the SAME GPS was being fetched up to 8× per bulk load (96→81→66→51→…→1 = 366 requests for 96 unique points). Now `elevInFlight {key→Promise}` map; duplicate requests share one fetch. Also: right-click on Elev + AGL Δ cells now copies raw (matches altitude's right-click behavior).
  - **v0.47**: pen-edit "already in mission editor" detection switched from URL hash check (unreliable across TOP/IFRAME frames) to direct DOM check: `[data-rfd-draggable-id="<instructionId>"]` exists → skip navigation entirely → straight to opening the edit dialog.
  - **v0.48**: perf — was full re-rendering the drill-down detail view every 5 elevation completions during a bulk fetch (~20 full DOM rebuilds for 96 points), thrashing the main thread and lagging the Control Panel. Now ONE re-render at completion. Progress shown via inline title text update: "Instructions — fetching elevations 12/96…". Verbose `[edit] / [queue] / [fiber]` logs (15 sites) gated behind `window.__AIM_MB_DEBUG = true`.
  - **v0.49**: debounce passes — search input was triggering full table re-render on every keystroke (98 missions × 13 cols × per-row event re-wire per character); now debounced 250ms. `saveElevationCache()` was firing on every elevation completion (96 synchronous GM_setValue writes of the full cache during a bulk fetch); now debounced 1s with `flushElevationCache()` on beforeunload. SUM injection interval bumped 2s → 4s.
  - **v0.50**: settings popover (⚙ button in SUM toolbar) shows elevation cache size + a "Clear elevation cache" button. Helps users verify MBT isn't a storage hog and reset on demand.

- **AIM Mission Bank Tools v0.7 → v0.39** — major drill-down + batch-edit pass, then a long bugfix odyssey ending in a clean architecture.
  - **v0.7**: stat-card reorder, click-to-copy raw altitude, step-count split (Thermal/GEM On/Off), unit-aware altitude in instructions table, fixed importance ordering.
  - **v0.8 / v0.9**: reorderable + persistent column UI (↑↓ arrows + drag of toggles), dynamic step-type columns auto-discovered from loaded missions, zebra-striped rows.
  - **v0.10 / v0.11**: altitude rounded + comma-formatted + "ALT" suffix; drill-down power tools (copy mission name, Copy → Sheets export, sticky header fix, multi-filter step-type chips, Export KML with 3D altitude pins).
  - **v0.12 / v0.13**: multi-select filter chips, KML pin colors (navigate green, snapshot orange), "Edit" button on drill-down header that jumps to Percepto's mission editor.
  - **v0.14 / v0.15**: Edit button reliability — finds the actual sidebar `<a>` link and clicks it (works through the iframe sandbox); panel stays open after navigation.
  - **v0.16 / v0.17 / v0.18 / v0.19**: per-step 🔭 (center map on GPS) + ✏️ (open this step in editor) icons. Programmatic step-edit opens via React-handler injection on the dots SVG (after multiple iterations on CSS `:hover` workarounds for the hidden dots).
  - **v0.20**: layout polish — 🔭 + ✏️ moved left of step number; step numbers are plain text now (reordering stays in Quick Mission Editor).
  - **v0.21 / v0.22**: "Opening step editor…" / "Saving current step…" progress toasts; auto-save the currently-open step before opening another.
  - **v0.23**: **NEW: inline altitude editor + batch commit.** Click any navigate/snapshot altitude in the drill-down → edit inline → press Enter → cell turns orange (⏳). A "N altitude changes pending" banner appears with [Commit] + [Discard]. Commit processor opens each step's edit dialog → sets the altitude → saves → moves to next. ~2 seconds per step; confirms before bulk commits >5.
  - **v0.24**: Navigate's altitude radio gating handled — clicks "Custom altitude" radio before setting the value.
  - **v0.25**: "(new: X ft)" marker shows committed-but-not-refetched values in drill-down (cache is stale until Refresh).
  - **v0.26**: yellow committed marker (was green), scroll preservation across re-renders, Enter/Tab auto-advance to next editable altitude, **formula input** (type `2974+15` → evaluates to 2989).
  - **v0.27 / v0.28 / v0.29**: queue corruption fixed via Edit-item snapshot diff (handles Ant's singleton dropdown portal reuse), then snapshot altitude label match ("Target altitude (ft)"), then more diagnostic logging.
  - **v0.30 / v0.31 / v0.32 / v0.33 / v0.34 / v0.35**: value-anchored altitude matching (find by current value, not label text), class-based dot reveal, paired onMouseLeave/onMouseEnter cleanup, deferred state clearing after navigation — all attempts to fix Ant's hover-state corruption that broke manual hover on edited steps post-commit.
  - **v0.36**: catastrophic regression — DOM injection of Edit/Delete buttons into React-managed elements caused page-wide reconciliation crash (`Failed to execute 'removeChild' on 'Node'`). Emergency revert.
  - **v0.37 / v0.38**: alternate attempts (always-visible CSS dots, click-intercept popup with body-attached menu). Better but still triggered the underlying Ant state corruption when used.
  - **v0.39**: **ROOT CAUSE FIX.** Bypass Ant Dropdown's UI entirely. `triggerInstructionAction(draggable, 'edit')` walks Percepto's React fiber tree from the dots SVG to find the Ant Dropdown component's `menu` prop, then calls `menu.onClick` or `menu.items[edit].onClick` directly. Ant's hover state is never touched, so manual hover continues to work on every step including ones just edited. All v0.37/v0.38 UI grafts removed — native UI fully restored.

- **AIM Mission Bank Tools v0.6** — **NEW: right-click mission inspector.** (features.csv #50)
  - Plain right-click on any mission row in Percepto's `.missions-list` sidebar opens a floating popup with mission stats, flight-phase breakdown, and dynamic step-type counts.
  - **Shift+right-click bypasses MBT** so coworkers can still use Chrome's native menu (Open Link in New Tab, Copy Link Address, etc).
  - **"Open in SUM →"** button drops you directly into the mission's detail view inside the Summary panel for the full step list.
  - Delegated `contextmenu` listener on the iframe document so React rebuilds of `ul.missions-list__items` don't kill the handler. Mission ID parsed from the `<a href="#/.../mission-bank/<id>">` via regex. Data reuses the existing missionsBySite cache and fetches if cold — first right-click on a fresh load primes the cache for everything else.
  - Popup: draggable header (pointer events + setPointerCapture), close X, Esc/outside-click close, click-to-copy stat cards, viewport-clamped positioning so near-edge right-clicks don't escape.

- **AIM Mission Bank Tools v0.5** — SUM placement polish.
  - Dedicated `aim-mb-toolbar-row` div injected as a sibling immediately after `.missions-list__header`. SUM lives there now instead of crowding the same row as the "MISSIONS" title + "+ New Mission" button. Future MBT buttons join the same flex/gap row (`Stats`, `Inspect`, etc.).
  - `hideSumButton` tears down the row when master toggle goes off. React-rebuild guard keys off the row instead of the button alone.

- **AIM Mission Bank Tools v0.4** — fix double SUM + sandboxed Google Maps popup.
  - **Double SUM cause**: v0.3 dropped a floating fallback on the first 2-second interval tick (before React mounted `.missions-list__header`), then the "already injected" early-return prevented future ticks from moving it to the real header. The TOP-frame `hashchange` handler also called `runSumInjection` in TOP, dropping a second floating button.
  - **Fix**: removed `injectFloatingButton` entirely. `injectSumButton` now waits for `.missions-list__header` to exist before injecting, and re-injects if React rebuilds the header without our button. `runSumInjection` early-returns unless `CONTEXT === 'IFRAME'`.
  - **Google Maps blocked**: Percepto's iframe sandbox lacks `allow-popups`, so detail-view location links produced "Blocked opening '<URL>'" in the console. Now opens via `(window.top || window).open()` since the top frame is same-origin + not sandboxed. Falls back to clipboard-copy with a warning toast if even that fails.

- **AIM Mission Bank Tools v0.3** — real-world testing pass after v0.2 ship.
  - **SUM injection** uses the correct `.missions-list__header` selector (per user DevTools picker) and inserts next to `.missions-list__new-button`, reusing its className for native Ant Design styling. Recursive iframe walk removed.
  - **Drag + resize** switched to pointer events with `setPointerCapture` so cursor leaving the handle no longer drops the gesture.
  - **Columns + Settings menus** appended to `document.body` with `position:fixed` so they aren't clipped by the panel, don't jump on re-anchor, and survive table re-renders. Both gained explicit close (✕) buttons.
  - **Panel body** restructured as flex column — toolbar + footer pinned, only the table scrolls. Search no longer steals focus from settings inputs on every keystroke.
  - **Title** shows actual site name (`.ant-select-selection-item` `title` attribute) instead of `Site <id>`.
  - **Step type renames** in detail: `cameraSelect` → "Thermal", `gemMode` → "GEM", boolean/0-1 values render as "On"/"Off".
  - **Step Counts card** auto-builds from all distinct step types instead of the fixed snapshot/navigate/wait/other quad.
  - **Instructions table**: navigate rows bold neon green (`#5fff5f`), snapshot rows bold orange (`#ff9800`).
  - **Location cells** are clickable Google Maps links (left-click opens, right-click copies coords) — popup blocking fixed in v0.4.
  - **Detail view** gains its own mi/km unit toggle; numeric stat cards are click-to-copy with hover outline.
  - **`fmtPct`** adds a space before % per user spec.

## 2026-05-26

- **AIM Mission Bank Tools v0.2** — **NEW: Mission Summary panel.** Replaces the v0.1 skeleton with the first real Mission Bank feature.
  - **SUM button** injected on the Mission Bank toolbar (with floating bottom-right fallback if Percepto's DOM doesn't match the expected header selector). Same styling pattern as Asset Inspector's SUM.
  - **Floating draggable/resizable panel** listing all missions on the current site with per-mission stats. Click any row → master-detail swap to drill-down view; Back button restores table at scroll position.
  - **22 columns, 9 default-visible**, toggle-able via `Columns ▾` menu, visibility persisted in GM storage. Active dot, Site Name, Mission Name, Steps (excluding takeoff/return), Flight Time, Flight Distance, Battery %, Est. Flights, Total Consumption % visible by default. Per-phase Time + Consumption (Nav/Wait/Extra/Landing/Takeoff = 10 cols), Description, Robot Types, ID toggle-able.
  - **Default sort: Flight Distance DESC** — clusters multi-missions (S- / N- / E- / W- prefixed pad-based missions) at top per user's build workflow. 3-state column sort cycle (asc → desc → reset).
  - **Distance unit toggle** (mi ↔ km) in toolbar, default imperial, saved to GM storage.
  - **Battery → Flights estimate column** using user's IFS formula (default thresholds 560/480/360/270/180/90). Settings cog (⚙) opens a popover with 7 number inputs to tune live + reset-to-default; persisted.
  - **Drill-down detail view**: Mission Stats card + Flight Phase Breakdown card + Step Counts card (Snapshots/Navigates/Waits/Other) + Instructions table (filters out takeoff + returnHome, Step 1 = first real step) + Description + robot types.
  - **Multi-select + exports**: Copy CSV (visible cols only, Active excluded), Copy → Sheets (TSV), Copy JSON (full raw mission objects). Selection wins over filter set.
  - **Data**: one fetch per site to `/available_app/?site_id=X&type=1` (cookie auth, no PAT). Cached in memory; Refresh button forces re-fetch.

- **AIM Quick Mission Editor v0.2** — reliability + UX pass after v0.1.
  - **Cache `reorderFn` once at queue start** — was walking the React fiber tree for every item. Pre-flight check now aborts before snapshot/cleanup if the function can't be found.
  - **Defensive fiber walk** — 4 candidate paths tried in order; clean `console.warn` with depth on full-walk failure. Future-proofs against a Percepto context-provider refactor.
  - **Validate selection at confirm time** — stale draggable IDs → modal stays open with `"N selections no longer exist — reselect"` error instead of silent mid-queue drops.
  - **Confirm-large-moves** — moves ≥20 items pop a `confirm()` with count + rough time estimate. Misclick saved.
  - **`hashchange` cancels in-flight queue** — navigating to another mission mid-move now aborts cleanly with toast instead of applying remaining moves to the wrong mission.
  - **Launcher click opens modal** — clicking the bolt ⚡ or `QUICK MISSION EDITOR` label opens the move dialog. Alternative to Enter, more discoverable.

- **AIM Quick Mission Editor v0.1** — **NEW. First Mission Bank tool.** Port of a coworker's ReactFiber Mission Editor v19.5 with full toolkit integration + reliability hardening.
  - **What it does**: bulk-reorder mission instructions on the mission editor page. Ctrl+Click drag handles to select instructions; consecutive picks auto-merge into ranges. Enter opens a modal with bubble selections + range input (`153-197` format) + target-position input + Move ⚡ button. Queue processor moves items one at a time with progress HUD, scroll-to, green-flash confirmation per move.
  - **Core trick (preserved from coworker)**: walks React's fiber tree to find Percepto's own `reorderInstructions(from, to)` function on its context provider, then calls it directly. Bypasses `react-beautiful-dnd` synthetic-drag entirely.
  - **MutationObserver as PRIMARY completion signal** — observes the actual DOM reorder of the moved ID. Console.log hijack kept as fallback. Protects against a 200-item move silently degrading to 10 minutes if Percepto ever drops the `"Reordering instructions:"` log line.
  - **Abort after 3 consecutive failures** (not-found / exception / timeout) — prevents "burn through 197 items firing red toasts" mode if state corrupts.
  - **Pre-move snapshot** at `window.__aqme_lastSnapshot` — array of pre-move draggable IDs for manual recovery if something goes sideways.
  - **Ant Design-aware input guard** on Enter + Esc handlers — `.ant-input` / `.ant-select` / `role="textbox"`.
  - **IS_TOP gate** so Enter / Esc don't fire twice across top + iframe contexts.

- **AIM Control Panel v1.23** — activate Mission Bank Macros panel section.
  - Was a comment-only placeholder in v1.22 `SECTION_PRIORITY`. Now active so registered scripts with `group:'Mission Bank Macros'` render on `/control-panel/mission-bank` URLs. First member: Quick Mission Editor.

- **AIM Performance Shield v1.10** — log suppressor regex rewrite to catch single-arg log forms.
  - v1.8/v1.9 patterns required multi-arg `console.log` calls (e.g. `console.log("Drone", 5, "already exists in OGI")`). Real Percepto logs are mostly single-arg strings. Patterns now use regex with `^\s*` (leading-whitespace tolerant) on `args[0]` for prefix matches AND a `joinArgs(a)` regex for multi-arg patterns like `"Drone N already exists in OGI state"`.
  - Three more patterns added from real Mission Bank logs: `Initializing library`, `ws.init called with ip:`, `createNewSocket connecting`.

- **AIM Performance Shield v1.9** — fix sandboxed-console bug from v1.8.
  - v1.8 wrapped `console.log` directly. Perf Shield has `@grant GM_setValue` etc. → runs in Tampermonkey's **sandboxed context**. The sandbox `console` is a per-script copy that Percepto's logs never go through, so the v1.8 wrap intercepted nothing.
  - Fix: wrap `unsafeWindow.console` (the page console). Wrap now sits outside Inspector's wrap (since Perf Shield loads after Inspector per dashboard #) and catches Percepto traffic. Classic Tampermonkey sandbox gotcha — documented in memory for future.

- **AIM Performance Shield v1.8** — **NEW: "Suppress noisy Percepto debug logs" toggle (default ON).**
  - **Why**: Percepto floods `console.log` with ~10 patterns of non-actionable state-change spam (RAZTEST, `WeatherStore:_calcweather`, STATE CHANGED, `Drone N already exists in OGI`, Amplitude EOI, `'Possibly unhandled rejection: {}'`, etc.). When DevTools is open, browser pays format + render cost for every line — major Mission Bank perf drag.
  - **What**: new "Console" panel section with one toggle (default ON). When ON, matched lines are silently dropped from `console.log/info/warn/debug`. Per-pattern counters at `window.__aim_perf_log_counts` for diagnostics.
  - **Safety rails**: never filters lines starting with `[AIM ` (our own diagnostics) or args containing `Error` instances (real exceptions).
  - **Result reported by user**: Mission Bank load time went from 20+s (sometimes unusable) to "SUPER FAST" once v1.9 + v1.10 fixed the wrap location and broadened the patterns.

- **AIM Map Styler v34.40** — **auto-kick safety net for the "stuck after refresh" bug.**
  - Long-standing intermittent bug: after refresh, KMLs load + script ACTIVATES but tile layers and overlays don't render. User had to press Shift+K manually to recover (documented in `project_stuck_after_refresh.md` memory).
  - **New**: after each `🟢 ACTIVATED`, a one-shot 4-second timer checks the documented stuck symptoms — `getLeafletMap()` null, empty `.leaflet-tile-pane`, or KML features loaded but no `path[data-buffer-kind^="kml-"]` overlays in DOM. If stuck → silently auto-fires the same Kick the user would manually trigger.
  - Latched at one auto-kick per page load to prevent loops. Page reload resets the latch. Manual Shift+K still works as fallback if the auto-kick doesn't recover.
  - Kick recovery sequence extracted into shared `performKick(reason)` so manual + auto paths use identical code. Log includes the reason string so post-mortems can distinguish manual vs auto trigger.

- **AIM Map Styler v34.39** — fix TDZ crash from v34.38 cosmetic edit.
  - v34.38 changed the init log from a hardcoded `'34.19'` literal to `SCRIPT_VERSION`. But `SCRIPT_VERSION` was declared 16 lines later → Temporal Dead Zone violation → Map Styler crashed on every load with `Uncaught (in promise) ReferenceError: Cannot access 'SCRIPT_VERSION' before initialization`.
  - Net effect of the v34.38 bug: Map Styler init threw, never activated, never rendered. Mission Bank felt fast as a side effect (no Map Styler doing its work) — masquerading as the Perf Shield log suppressor working perfectly.
  - Fix: hoisted `SCRIPT_VERSION` to top of IIFE next to other init-phase constants. Third documented TDZ incident in this codebase; memory file `feedback_perf_shield_tdz_pattern.md` now flags "any edit to the first 50 lines of an IIFE" as a TDZ-check trigger.

- **AIM Map Styler v34.38** + **AIM Inspector v1.8** — cosmetic version string sync (Map Styler v34.38 introduced the TDZ bug, v34.39 fixed it).
  - Map Styler had hardcoded `'34.19'` in the init log template — every load reported v34.19 regardless of actual version. Inspector's inner `VERSION = '1.6'` didn't match `@version 1.7` in the header. Both fixed to interpolate `SCRIPT_VERSION` and stay in sync going forward.

---

## 2026-05-22

- **AIM Map Styler v34.37** — fix Split-then-refresh revert via cache-bust on raw URL.
  - User reported the Split-multi-segment-lines tool's commit landed on GitHub correctly but a page refresh appeared to revert the split. Diagnosis: `fetchKMLForSite` pulls from `raw.githubusercontent.com` which serves `Cache-Control: max-age=300` (5-min CDN cache). After Split → local features updated correctly → user refresh → fetch returned the pre-split CDN-cached file → overwrote local features → looked like revert.
  - Fix: append `?_=${Date.now()}` to the raw URL so the CDN treats every fetch as unique. Local GM cache layer above still provides instant first-render. Same hazard family as v34.34's commit-bug, different code path.

- **AIM Mission Bank Tools v0.1** — **NEW skeleton script** (no functionality yet).
  - Installable now so coworkers auto-update to future Mission Bank features without re-installing manually. Registers nothing today — does nothing beyond a `[AIM MB TOOLS] init` log line.
  - Inline comment block walks through exactly what to uncomment when first real feature ships (REGISTER call + `'group:Mission Bank Macros': 50` entry in Control Panel `SECTION_PRIORITY`).
  - README + Pages install guide updated with install row #13.

- **AIM Asset Inspector v3.11** + **AIM Map Styler v34.36** — ignore synthetic contextmenu events.
  - Bug: dropping an Absolute Altitude or Ruler pin near an entity (or near a KML line in edit mode) popped the Asset Inspector / KML hide menu unexpectedly. Root cause: Altitude / Ruler use the documented "Pin & Clean" pattern that dispatches a synthetic `contextmenu` event via `dispatchEvent(new MouseEvent('contextmenu'))` to clean up Leaflet's stray vertex. Asset Inspector + Map Styler caught these synthetic events as if the user right-clicked.
  - Fix in both scripts: `if (!e.isTrusted) return;` early-return at the top of the contextmenu handler. `isTrusted` is browser-set: `true` only for real user input, `false` for `dispatchEvent`-fired events. Surgical fix; Leaflet's own contextmenu handler still receives the synthetic event because event capture isn't affected by our early return.

- **AIM Control Panel v1.22** + **four site-setup scripts** (New Entity Macro v1.8, Bulk Altitude Updater v4.12, Bulk Validator v1.4, Bulk Mission Adder v1.13) — **page-aware panel filtering.**
  - **REGISTER schema extended with optional `scope` field**: `'site-setup'`, `'mission-bank'`, `'admin-merge'` (or undefined → always visible). Control Panel reads `window.top.location` to compute current URL scope and filters rendered groups + HOTKEY_FIRED routing accordingly. On `hashchange` it recomputes scope + re-renders if changed.
  - **Three URL classes recognized**: Site Setup (`/control-panel/site-setup`), Mission Bank (`/control-panel/mission-bank` + deep children), Admin merge_available_apps (`/admin/percepto/availableapp/merge_available_apps/stepN/`).
  - **Net behavior on Site Setup URL**: panel shows "Site Setup Macros" group with New Entity Macro / Bulk Altitude Updater / Bulk Validator. On Mission Bank URL, that group is hidden and the hotkeys silently no-op. Bulk Mission Adder scoped to `admin-merge` so it never appears in the panel anywhere (admin page has no map → panel UI doesn't render there either). Universal hotkeys (Altitude, Ruler, Clear All) work everywhere.

---

## 2026-05-21

- **AIM Map Styler v34.35** — **KML editing Phase E4: draw new lines on the map and commit to GitHub.** Completes the editing bundle.
  - New "Add new line (draw on map)" button per category in the Pending commits section. Click → cursor becomes crosshair → each map click drops a vertex (dashed green preview) → floating toolbar shows running vertex count with Save / Undo / Cancel buttons → Save opens a name-input modal (Enter saves, Esc cancels) → line stages as a pending-add (solid green visual) and feeds the existing Commit pipeline.
  - Esc cancels drawing; `hashchange` silently discards in-progress draw.
  - Right-click pending-add line (with edit mode on) → menu offers "🗑 Discard this new line".
  - **Visual key now complete across all commit ops**: 🟢 solid green = pending add, 🟢 dashed green = in-progress draw, 🟡 yellow solid = pending modify, 🔴 red dashed = pending delete, ⚪ gray dashed = local hide, category color = normal.
  - Commit message format: `[AIM site <id>] <type>: N deletes · M modifications · K new lines` (only includes parts that apply).

- **AIM Map Styler v34.34** — fix post-commit refetch returning stale CDN cache.
  - Diagnosed during v34.33 testing: after a commit + edit-again + commit, the second commit's local render reverted to the first commit's position. Root cause: post-commit refresh called `fetchKMLForSite(force=true)` which pulls via `raw.githubusercontent.com` (5-min CDN cache). The second refetch returned the previous commit's content from cache, overwriting our correct in-memory state.
  - Fix: new `applyCommittedXmlToLocalState(siteID, type, xmlText)` helper. After every successful PUT, parse the exact XML bytes we just sent (authoritative — GitHub accepted them) and stuff straight into `kmlFeatures` + GM cache. No network round-trip, no CDN risk.
  - Applied to all three commit paths (commit-ops, hide-commit, split). Fallback to forced refetch preserved inside the helper for the impossible "we can't parse our own XML" case.

- **AIM Map Styler v34.33** — **KML editing Phase E3: vertex edit with in-map drag handles.**
  - Right-click any line in edit mode → new "✏️ Edit vertices" menu option (yellow). Clicking drops a cyan circular drag handle on every vertex of that line + a floating Save / Discard toolbar.
  - Drag handles to reshape — SVG path follows in real time (via `effectiveCoordsForFeature` resolving live edit → saved modify-op → original file coords in priority order).
  - Save → stages a `modify` commit-op (yellow solid visual until committed). Discard → exits cleanly, no save.
  - Right-click a line with a saved modify → menu offers "✏️ Edit vertices again" + "↩ Revert vertex edits".
  - Site change silently discards in-progress edit so handles don't follow to the next mission.
  - Save with float-tolerance: `<1e-9 deg` delta treated as unchanged (no phantom commit from drag-end float drift).

- **AIM Map Styler v34.32** — **KML editing Phase E2: mark and commit line deletions to GitHub.** Foundation for E3/E4 layered on top of the same plumbing.
  - Right-click any line in edit mode → new "🗑 Mark for deletion (commits to GitHub)" menu option (red). Marked lines render with red, thicker, dashed strikethrough — distinct from gray local-hide ghost so the difference is obvious at a glance. Marked-for-commit lines **always** render even if locally hidden (never commit something the user can't see).
  - New "Pending commits to GitHub" panel section per category with Commit / Discard pending buttons.
  - **Separate commit-ops storage** (`KML_COMMIT_OPS_PREFIX`) from local hides — hide stays local-only-forever (per-user view filter), delete is the only path that commits canonically.
  - Storage schema: `{ ops: {pmIdx: {op:'delete'|'modify',coords?}}, added: [{name,coords}] }` — laid foundation in v34.32 so v34.33 (modify) and v34.35 (add) slotted in without re-architecture.
  - Single batched commit per click: `[AIM site <id>] <type>: N deletes`. Delete ops sorted descending so removing one doesn't shift remaining delete indices.
  - After successful commit: clears commit-ops AND local hides for that type (since indices shifted, stored pmIdx refs would be stale).
  - Split-multi-segment-lines function now also refuses if commit-ops pending (parallel to the existing local-hides refusal — same index-shift hazard).

- **AIM Asset Inspector v3.10** — three small Stats popup tweaks.
  - **Validation labels reworded** — `✓ Valid` / `✗ Invalid` → `✓ Validated` / `✗ Unvalidated`. Matches Percepto's terminology and the way the team actually uses the flag (per user: "Validated = pilot has flown this entity and confirmed it as safe; Unvalidated = area to fly with caution").
  - **Hover tooltip** added to the Validation card title with that pilot-flown framing — anyone wondering what "Validated" means gets the answer without leaving the popup.
  - **Unreachable color → purple `#a855f7`** in the Asset Health by Equipment legend + stacked bars. The previous `#ff5555` red was too close to Unshielded's `#ff5722` orange-red. Purple still reads as "worst/anomalous" while clearly differentiating from Unshielded at a glance.
  - **Asset Health by Equipment auto-adapts** to whatever subtypes a site has — equipment names come straight from the data, so non-upstream sites (midstream / downstream / T&D inspection) will show their own subtype taxonomies. The state palette is currently tuned for upstream conventions (Normal / HY / Empty / Inactive / Unshielded / Unreachable); unrecognized states fall through to gray. If team needs first-class color treatment for non-upstream states (e.g. "Active" / "Passive" / "Tagged for repair"), let me know which sites + which state terms and we can map them.
- **AIM Asset Inspector v3.9** — tabular alignment + "Normal" baseline in states.
  - **Keyword cards now use proper `<table>` layout** — Asset Equipment / Asset States / GM Groups / Asset Health by Equipment. Each has a header row with the columns labeled (`Subtype`/`State`/`Group`/`Equipment`, `%`, `#`, `Share` or `Health`), and `table-layout:fixed` + `<colgroup>` so the `%`, `#`, and bar columns line up exactly across rows. Bars now all start at the same X position and end relative to each other's proportion of the row max — no more ragged-edge bars or numbers drifting left/right.
  - **Column order is now Subtype → % → # → Bar** (was Subtype → # → % → Bar). Reading the % right next to the label feels more natural for a stats card.
  - **"Normal" added to Asset States (auto)** — assets with no state modifier in their subtype (the baseline-good condition per Percepto's classification) now show up as a "Normal" row. Each asset is counted toward exactly one state so the percentages add to **100%** of total assets — the missing piece you flagged.
  - Bars cleanly fill their cells (`fillCell: true` option on `makeProportionBar`) so they always stretch the full bar column regardless of label length or popup width.
  - Equipment Health matrix card uses the same table layout for column alignment: `Equipment | # | Health`. The stacked bar still segments by state in canonical order (positive states left → negatives right, same v3.8 palette).
- **AIM Asset Inspector v3.8** — four Stats popup fixes from v3.7 testing.
  - **Equipment split bug fixed** — was splitting subtype on bare `-` so "v-well - empty" became `["v", "well", "empty"]` and the equipment showed as "V" with state "Well". Now splits on literal ` - ` (with spaces) so "v-well" stays intact. Same fix applied to state extraction + Equipment × State matrix.
  - **Dropped name-tag pass for equipment auto-detect** — earlier surfaced false positives (TEXAS, PU, ARICK, OVAL, LONG, YATER, LEONA — all asset-name prefixes, not equipment types). Per user feedback: subtype is the only source of truth.
  - **Percentages on the keyword cards** — Asset Equipment / Asset States / GM Groups rows now show `count · % of total` (% of total assets for the asset cards, % of total GMs for the GM card). Quick read on what proportion of the site each category represents.
  - **Equipment × State matrix rebranded "Asset Health by Equipment"** with semantic colors per Percepto's classification scheme: **POSITIVE states** rendered green-family (Normal = `#5fff5f` neon green per user request, HY = `#00e5ff` bright cyan for High Yield bonus); **NEGATIVE states** rendered in escalating warning palette (Empty yellow → Inactive orange → Unshielded orange-red → Unreachable red). Segments in each bar render in canonical order so positive states are always on the left and severity escalates rightward — at a glance you see the green/warning transition for each equipment type's health.
  - Hover any segment for `<state>: <count> (X% of <equipment>)` tooltip.
- **AIM Asset Inspector v3.7** — Stats popup goes auto-detect + adds a real Google Sheets export. Big quality-of-life push.
  - **Auto-detected Asset equipment** — was a hardcoded 6-item list (H-Well / V-Well / Compressor / Battery / SAT / SWD). Now extracted from the data: split each asset's `poi_type_str` on " - " and use the first part as the equipment kind. Names like "MILLIKEN C 3D SWD" with no SWD in subtype get caught by a secondary "all-caps token in name" pass with stopword filtering. Surfaces new equipment kinds (Compressor, SAT, anything Percepto adds later) without code changes.
  - **Auto-detected Asset states** — was hardcoded Empty / Unshielded / Unreachable. Now extracts everything after " - " in subtype as a state tag and groups counts.
  - **Auto-detected GM groups** — was hardcoded Elevators / Flare / Guy wire / Bridge. Now strips trailing numeric tokens from each GM name to find its "base" group. "Elevator 1" / "Elevator 2" → "Elevator". "Tattu Range N5 - 14K" / "Tattu Range S5 - 14K" → "Tattu Range". "general_marker_4" → "general marker". Top 12 surfaced sorted by count.
  - **New card: Asset Equipment × State Matrix** — stacked horizontal bars per equipment kind, colored by state (Normal=white, Empty=yellow, Unshielded=orange, Unreachable=red). Bar width is proportional to the equipment's share of the biggest equipment total. Hover any segment for state + count tooltip. Legend at top of card documents the colors. Lets you instantly see "of 46 V-Wells, how many are empty / unshielded / unreachable" at a glance.
  - **Fixed bar overflow** in keyword cards (V-Well, Empty, Guy wire were spilling past card edges in the responsive grid). Bars now use `flex:1 1 auto; max-width:160px; min-width:0`, labels use `text-overflow:ellipsis` for long names, rows use `overflow:hidden` as a hard stop.
  - **New "Copy → Sheets" button** in the footer — writes a **formatted HTML table** to the clipboard as `text/html` (alongside a plain-text fallback as `text/plain`). Paste into Google Sheets or Excel: gets proper cells, bolded section headers, color-coded type bands (left border colored per type), right-aligned numbers, the full Equipment × State matrix as a real spreadsheet sub-table. Charts don't carry over from HTML — Sheets users can insert a chart from the pasted data in two clicks. Uses the Clipboard API's `ClipboardItem` for multi-MIME write; falls back to `execCommand('copy')` on a hidden contenteditable when Clipboard API isn't available.
  - Existing "Copy as Text" stays for plain-text use (Slack code blocks, email, etc.) — now demoted to secondary footer button.
  - Plain-text export updated for the new auto-detected dicts + equipment matrix.

## 2026-05-20

- **AIM Map Styler v34.31** — **kill diagnostic log spam.** v34.23 added a per-render `render[distro/trans] site=… feats=… vis=… hidden=…` log to debug the KML right-click pipeline. Stayed in v34.24–v34.30 by accident. With distro Edit mode ON, runUpdate fires constantly (mutation observer + 3 s heartbeat) so the log was emitting **600+ lines/min** — enough to make Chrome DevTools effectively unresponsive (user reported "I can no longer right-click on elements"). Also removed the matching contextmenu-target diagnostic from v34.23. KML hide/show is stable now; the diagnostics served their purpose.
- **AIM Asset Inspector v3.6** — three Stats popup polish items.
  - **Validation split into per-type donuts** — separate chart for FPs and FFZs (NFZs too, if any exist on the site). Each chart has its own title in the type color, its own validated/unvalidated ring, and its own ✓/✗ count list. Empty types are skipped entirely so you don't get hollow donuts for NFZs on sites without any.
  - **Numbers now use thousands separators** — `138634` becomes `138,634`, `42256` becomes `42,256`. Applied throughout: entity counts, percentages, FP segments/lengths, keyword counts, "Other" stats, donut center totals, and the plain-text export. `toLocaleString('en-US')` everywhere via a `fmtNum` helper.
  - **Responsive card layout** — popup body now uses `display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`. When you resize the popup wider, cards re-flow horizontally into 2-, 3-, even 4-column layouts; resize narrower and they stack vertically. Combined with the existing resize handle this lets you tile a wide-screenshot view (great for site reviews) or keep a narrow column for a side-by-side workspace.
  - Plain-text export now reflects the per-type validation structure too (`Flight Paths: / Validated: 80 / Unvalidated: 12 / FFZs: / Validated: 50 / Unvalidated: 8 / ...`).
- **AIM Asset Inspector v3.5** — three Summary popup fixes.
  - **Site name in both panel headers.** Pulled from the TOP-frame `.site-select .ant-select-selection-item`'s `title` attribute (e.g. "Exxon 34 - Texas Ten Y Pu 3901H"). SUM panel header is now `AIM Entities · <name> · Site 1596`; Stats popup is `Site Summary · <name>` with a `Site 1596 · X entities total` subtitle. Falls back to just the ID if the site dropdown hasn't rendered yet. Long names truncate with ellipsis so the close button isn't pushed off the panel.
  - **Stats popup is now draggable** — same pattern as the SUM panel (drag the header). Position persists across reopens in a new `statsPopupState`.
  - **Stats popup is now resizable** — bottom-right corner grip, min 400×300, max 96vw×90vh. Size persists across reopens. Default first-open is centered.
  - All document-level mousemove/mouseup listeners are cleaned up when the popup closes (wrapped `popup.remove`) to avoid leaks.
- **AIM Asset Inspector v3.4** — **Site Summary stats popup**. New 📊 Summary button on the SUM panel toolbar (next to "Show in feet") opens a centered modal with statistical breakdowns of the whole site.
  - **Entity Types card** — SVG donut chart with five segments (FPs / FFZs / NFZs / Assets / GMs in their proper colors) + a legend showing count + percentage per type. Center of the donut = total entity count.
  - **Validation card** — secondary donut for the validatable types only (FFZ + FP + NFZ). Green = validated, red = unvalidated.
  - **Flight Paths card** — entity count · total segments (sum of `arc.length`s) · total length in ft / m / mi / km.
  - **Asset · States card** — keyword counts (Empty / Unshielded / Unreachable) from poi_type_str subtypes, each with a proportional bar showing relative size.
  - **Asset · Equipment card** — H-Well / V-Well / Compressor / Battery / SAT / SWD counts. SWD matches against name (since it lives there, e.g. "MILLIKEN C 3D SWD") while the rest match subtype; row search unifies both.
  - **GMs · Keywords card** — Elevators / Flare / Guy wire / Bridge counts. "Guy wire" matches both "guywire" and "guy wire" since AIM data uses both spellings.
  - **Other card** — Total with notes · Total unshielded.
  - **Copy as Text** button — pretty-formatted plain-text export (section headers, padded numbers) you can paste into Slack `code` blocks, emails, spreadsheet cells, etc.
  - Reflects the full site dataset always — not the SUM panel's current filter. The popup is meant as an at-a-glance site report.
  - Deferred to v3.5: column reorder + per-column resize.
- **AIM Asset Inspector v3.3** — quick polish on top of v3.2.
  - **Shorter chip labels** — "Flight Paths" → "FPs", "Markers" → "GMs". Five chips now fit comfortably without wrapping.
  - **Colored chips** when active — each chip uses its type's color (FP cyan / FFZ neon green / NFZ red / Asset white / GMs light purple) at ~22% background + full-color text + 67% border. Inactive chips stay subtle gray. Toolbar visually mirrors the colored Type column.
  - **3-state column sort cycle** — click 1 = asc · click 2 = desc · click 3 = reset to default sort (type-grouped, A→Z within). Previously you could click into a sort but couldn't get back to the grouped default without a page refresh.
  - **Columns menu no longer triggers a page scrollbar** — switched the popover from `position: absolute` to `fixed`, plus a clamp pass that keeps it inside the viewport (flips above the button if there's no room below).
  - Deferred to v3.4: draggable column reorder + per-column resize.
- **AIM Asset Inspector v3.2** — second round of summary-panel polish. A lot in one push.
  - **NFZ (No-Fly Zone) entity type 4** now recognized everywhere: right-click matching, type chip in the toolbar, sort priority, type color (red — opposite of FFZ green). NFZs use the same `restrictions.minAlt/maxAlt` schema as FFZs.
  - **Validation only applies to FFZ / FP / NFZ.** Assets and Markers hide Percepto's Validated toggle entirely; v3.1 was incorrectly treating their `validated: false` as a real "unvalidated" status. Now those types render `—` in the Valid column and the Validated / Unvalidated filters exclude them (they have no valid/invalid state to match).
  - **Red ✗ for unvalidated FFZ/FP/NFZ** (was just dim `—`). Green ✓ for validated. Makes invalid stuff visually obvious in a long list.
  - **Marker color** → light purple `#c084fc` (was orange) to match AIM's altitude marker palette.
  - **Default sort** → by type priority (FP → FFZ → NFZ → Asset → Marker), then A→Z by name within each group. Click any column header to override.
  - **Unit toggle** (ft / m) — checkbox in the toolbar. Affects Elev / Min Alt / Max Alt column headers and cell values. Default = ft. Sort is unit-agnostic (uses raw meters internally, so order is identical).
  - **Columns ▾ menu** — toggle visibility per column (Type / Name / Subtype / Elev / Min Alt / Max Alt / Valid). Hidden columns are also omitted from CSV / TSV exports.
  - **Multi-select via row checkboxes** — first column. Select-all checkbox in the header (with indeterminate state when partial). When any rows are selected, Copy buttons act on the **selection** instead of the filter; when nothing is selected, they fall back to the current filtered set.
  - **Copy → Sheets** button (TSV format) — paste directly into Google Sheets / Excel and it auto-splits into rows/columns. Cell contents have embedded tabs/newlines stripped to keep the layout intact.
  - **Inspector popup × close button** in the top-right corner — was previously close-on-outside-click only, which the user reported as unintuitive.
  - Deferred to v3.3: draggable column reorder + individual column resize.
- **AIM Asset Inspector v3.1** — Summary panel polish based on first-test feedback.
  - **New filters**: **Unvalidated only**, **Unshielded only**, **Has notes**. The Validated/Unvalidated pair is mutually exclusive (toggling one auto-clears the other — both ON would show nothing).
  - **"Valid" column header** (was just `✓` which wasn't clear). Same `✓ / —` data in the cells.
  - **Resizable panel** — drag the bottom-right corner. Min 480 × 300, max 96 vw × 90 vh. Final size persists across open/close alongside the position.
  - Deferred to v3.2: column visibility toggle, per-row checkboxes for selective export.
  - Big future phase: **live editing of entity values in the SUM panel**. Two viable approaches under consideration — direct PATCH to Percepto's update endpoint, or driving the existing edit dialog programmatically. Will scope after v3.1 testing.
- **AIM Asset Inspector v3.0** — **Summary of All Entities** panel — the big phase the user previously called out. New **SUM** button injected next to the existing ALT and VAL buttons on Percepto's entity toolbar (same `#aim-automation-container` + `setInterval(2000)` re-injection pattern as Bulk Altitude Updater / Bulk Validator → native look, survives React re-renders, hides in edit mode). Click SUM to open a floating draggable panel listing every entity on the site:
  - **Search** (live filter by name or subtype)
  - **Type chips**: Assets / Flight Paths / FFZs / Markers (multi-select toggle)
  - **Validated only** checkbox
  - **Sortable columns**: Type · Name · Subtype · Elev (ft) · Min Alt · Max Alt · ✓
  - **Click a row** → pans/zooms the map to the entity AND opens the inspector popup beside the summary panel
  - **Copy CSV** — visible-columns snapshot of the current filter+sort
  - **Copy JSON** — full raw entity records from the API for the current filter+sort
  - **Refresh** — re-fetches `/map_objects/` (catches changes other teammates made)
  - Panel is draggable from the header; position persists across open/close. Resizing deferred to a later version.
  - Reuses the same `/map_objects/` cache the right-click inspector built — no duplicate fetches. Build pipeline pre-computes Elev/Alt in feet (converted from JSON meters) so sort works numerically and column display is the unit the user actually wants.
- **AIM Asset Inspector v2.4** — **"Find in Map Entities" button now auto-pastes + filters** instead of just copying to clipboard. Targets the sidebar input `input.ant-input[placeholder="Search entity"]` (always-open sidebar per user confirmation). Uses the React-aware value-setter trick (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name)` + bubbling `input` event) since direct `input.value = …` doesn't trip Ant Design's onChange. After fire: input is focused so user can keyboard-arrow through results. v2.5 can auto-click the first result row once we have its outerHTML.
- **AIM Asset Inspector v2.3** — **"Open in editor" replaced with reliable "Copy name → paste in Map Entities".** v2.0–v2.2 chased synthetic events to trigger Percepto's native edit dialog. v2.2 console proved the layer matching works (sub-meter matches) but the dispatched click events were no-ops — Percepto's selection handler isn't bound via Leaflet's `.on('click', …)` or any DOM listener we could reach. The button now just copies the entity name to clipboard with a "paste in Map Entities sidebar" toast — same manual workflow you were already doing, just one-click. Once we have the sidebar's DOM selectors, v2.4 can fully automate the paste + filter.
- **AIM Asset Inspector v2.2** — two fixes.
  - **Dual-unit altitudes / elevations / distances.** Percepto's JSON stores altitudes/elevations in **meters** even though the UI shows them in feet. v2.0–v2.1 displayed the raw meter number suffixed with " ft" — incorrect by a factor of ~3.28. Now every altitude/elevation/distance row shows **`2855 ft / 870.2 m`** style with each number individually click-to-copy. Units (ft/m) are display-only — never copied. Affects Elev ASL, Altitude, Height AGL, Min/Max Alt (assets + FFZs + flight paths), Total len (flight paths).
  - **Open in editor — retry chain.** v2.1's pure `layer.fire('click', ...)` worked the first time but not subsequent opens (Percepto seems to detach/rebind handlers when its edit dialog opens, so the fired Leaflet event reaches the original handler but not the rebound one). v2.2 fires BOTH the Leaflet event AND a DOM Shift+click sequence at the centroid — at least one of them survives Percepto's handler-shuffling. Toast fires if either path executes.
- **AIM Asset Inspector v2.1** — "Open in editor" rewrite. v2.0's synthetic `Shift+click` MouseEvent didn't trigger Percepto's selection handlers because Leaflet uses its own internal click dispatcher (it doesn't trust DOM `click` events — it computes "click" from mousedown+mouseup itself). Now uses `layer.fire('click', {...})` to call Percepto's bound handlers directly on the matched Leaflet layer. Falls back to copying the entity name to the clipboard with a "paste into Map Entities sidebar" hint if no layer matches within 30 m — same workflow you were doing manually, just one click. Logs include the layer-match distance so we can debug if it picks the wrong neighbor.
- **AIM Asset Inspector v2.0** — major rebrand of the old "Copy Asset Name" script. Right-click any entity (asset, free fly zone, flight path, general marker) on the map → small floating popup with name, type, ID, elevation ASL, altitude range, notes, and more. **Each row click-to-copy** (toast confirms). Two buttons at the bottom: **"Open in editor"** simulates a Shift+click at the entity's centroid to trigger Percepto's native edit dialog (Shift bypasses the asset lock from Map Styler v34.30, so this works whether locked or not), and **"Copy JSON"** dumps the full entity record. Works whether assets are locked, hidden, or normally rendered — uses map-coord matching against cached entity data instead of SVG hit-testing.
  - **Data source**: `/map_objects/?getPoiMapObjectsAsList=true&site_id=<id>` — internal Percepto endpoint, cookie-auth (no API token needed — uses your existing AIM session). Fetched on site load + on hashchange + on demand via the panel's "Refresh entity data" button. Cached per-site in memory, ~50 KB / ~50 ms.
  - **Matching**: point-in-polygon for assets (type 3) and FFZs (type 16) — prefers smaller polygon area on overlap so a tiny asset inside a larger zone wins. Distance-to-segment within 8 m for flight paths (type 15). Nearest-within-15 m for point markers (type 19). Bails to native context menu when no entity is at the cursor.
  - **Removed**: the old Shift+Ctrl+Q hotkey + tooltip-grab logic — fragile and broken since the asset-lock change. Inspector replaces it entirely.
  - **Filename + Tampermonkey @name preserved** as "AIM Copy Asset Name" for auto-update continuity (renaming would force coworkers to uninstall + reinstall). Panel now displays it as "Asset Inspector" via the REGISTER message's `name` field.
  - **Foundation for the planned "Summary of All Entities" view** (next phase) — the cached entity bucket per site is reusable for a future panel that lists/filters/exports all entities in one place.
- **AIM Map Styler v34.30** — **fix asset lock blocking pan + pin-drop.** v34.29 and earlier used a capture-phase event handler that `stopImmediatePropagation`'d clicks on asset paths — which also killed map panning over assets AND prevented pin-drop tools from firing inside asset areas (the entire reason the feature existed). Switched to CSS `pointer-events: none` on locked asset paths: clicks pass through to the map underneath so pan + pin-drop work; the asset's own click handler never fires because no events reach the element. Shift held temporarily lifts the lock for asset interaction (bypass). Tradeoff: hover-tooltips on assets don't appear while locked, so Copy Asset Name (Shift+Ctrl+Q) needs the user to move cursor across the asset while holding Shift to see the tooltip first.
- **AIM Map Styler v34.29** — **multi-candidate KML fetch + .kmz support.** Two ergonomic upgrades for the data repo workflow.
  - **Case-tolerant filename fetch.** GitHub raw URLs are case-sensitive, so `1596-Distro.kml` returned 404 when the script asked for `1596-distro.kml`. Now tries up to four candidates in order: `siteID-type.kml` (preferred), `siteID-Type.kml`, `siteID-type.kmz`, `siteID-Type.kmz`. First 200 wins; only one entry in the console.
  - **.kmz support.** KMZ is a ZIP wrapping a `.kml` plus optional resources. Added JSZip via `@require` (cdnjs). On a .kmz hit we pull as `arraybuffer`, unzip in-browser, pick `doc.kml` or the first .kml entry, and parse like a normal KML. Coworkers can upload Google Earth's default `.kmz` save format without converting first.
  - **Resolved-path tracking.** The fetcher records which filename actually returned 200 in `kmlResolvedPath[siteID|type]`. Subsequent operations (Split, future Commit) target that same file so writes don't drift into a different case/extension. Cached to GM along with features so the resolution survives reloads.
  - **Split now rejects .kmz** (until we add ZIP repacking). Toast hints to convert to .kml first.
  - **KML cache key bumped to `aim-kml-cache-v3-`** so the new cache schema (with `path`) isn't merged with v2 entries; one-time refetch on first load.
- **AIM Map Styler v34.28** — gate TRIGGER_ACTION + HOTKEY_FIRED to focused tab. Multi-tab safety: clicking Split on site 1597 in Tab A no longer fires confirm() in Tab B's site 1599. Uses `document.hasFocus()` — only the OS-focused tab handles the action; others silently ignore.
- **AIM Map Styler v34.27** — gate TRIGGER_ACTION to IFRAME context only. Was firing in both TOP + IFRAME (BroadcastChannel delivers to all), causing Split's confirm dialog to appear twice + risking double GitHub PUT.
- **AIM Map Styler v34.26** — **E1 model pivot: hide/show is now per-user view only, never commits to GitHub.** Treating the KML as the canonical ~100%-of-real-world-infrastructure source of truth and pulling hide/show out of the commit path entirely.
  - **Removed** the per-category "Commit pending changes to GitHub" button. Hide/Unhide writes only to local GM storage now; nothing syncs to the repo.
  - **Added "Clear all my hides for this site"** button per category — wipes local pending in one click + re-renders.
  - **Added "Hidden color" color picker** per category (default `#888888` gray) — ghost-render dashed stroke uses this color so you can pick whatever stands out for your eye.
  - **Renamed "Edit mode" → "Hide mode"** to make the local-only nature obvious.
  - **Renamed "Show hidden lines (dashed gray)" → "Show my hidden lines (dashed)"** for the same reason.
  - **Reorganized the Editing sub-section** of each category into two sub-headers: **"Local hides (per-user view)"** and **"KML data (commits to GitHub)"**. The Split button stays in the GitHub section since splitting is a real data improvement that benefits all coworkers.
  - **Commit infrastructure preserved** — `commitKMLChanges` / `applyPendingToKML` / `putKMLToGitHub` are kept in place but no UI path reaches them. They're the exact pipeline E2 (delete bogus lines), E3 (vertex edit), and E4 (add new line) will need when those phases ship.
- **AIM Map Styler v34.25** — **per-category "Split multi-segment lines (one-time)" button** + ghost-render hit-area fix.
  - **Split button** (one per Distribution / Transmission Editing sub-section). Walks the current site's KML, finds every Placemark whose single `<LineString>` has 3+ coordinates, replaces it with N-1 single-segment placemarks (each gets the original's `<name>` suffixed with ` (seg i/N)`, plus the original's `<styleUrl>` + `<visibility>`). Single commit per category. Confirmation dialog first; refuses to run if there are pending E1 hide/show changes (those reference the OLD `pmIdx` values and would silently apply to different placemarks after the split). File size grows ~3-4× but parser + render time stay sub-10ms.
  - **Purpose:** the original KMLs have huge multi-vertex polylines as single placemarks, so E1's right-click-to-hide was hiding half-mile chunks instead of single spans. After splitting, every right-click acts on exactly one segment. Once-per-file operation; future E4 (add line) will auto-split new lines on commit so the file never grows multi-segment again.
  - **Google Earth compatibility:** still 100% spec-compliant — single-segment placemarks open identically. Loses only the semantic grouping of "these 5 segments are one line run," which our workflow doesn't need.
  - **Ghost-render hit-area fix:** dashed-gray hidden lines now match the category's normal stroke width instead of a fixed 2px. v34.21–v34.24 made them very hard to right-click on dense maps; right-click → Unhide now has the same hit-target as a visible line.
- **AIM Map Styler v34.24** — fixed: KML right-click context menu opened but the action click never fired. Outside-click closer used `mousedown` in capture phase, removing the menu before the button's click event could run. Now only closes when the mousedown lands outside the menu.
- **AIM Map Styler v34.22 / v34.23** — KML right-click groundwork: added `leaflet-interactive` class + `pointer-events: visibleStroke` on shielding paths in edit mode (Leaflet's overlay-pane SVG has pointer-events:none by default; our paths inherited that). Added diagnostic logs in click + render to pinpoint v34.21's silent failure.
- **AIM Map Styler v34.21** — **KML editing Phase E1: hide / show with 2-way GitHub sync.** First write-back feature for the data repo.
  - **Right-click any rendered KML line** (yellow distro or red trans) → small menu with **Hide / Unhide** (the option flips based on current state). Only armed when the matching category's **Edit mode** toggle is ON, so right-clicks fall through to Leaflet normally otherwise.
  - **Separate edit state per category.** Distribution lines and Transmission lines each get their own Edit mode toggle, their own Show hidden lines toggle, their own pending queue, and their own Commit button. Lets you edit + commit one type without touching the other.
  - **Hidden lines render as thin dashed gray** when "Show hidden" is on (auto-flips on with Edit mode but can be independently controlled). Right-click a ghost-rendered line → Unhide.
  - **Local persistence:** each edit immediately saves to GM storage (`aim-kml-pending-<siteID>-<type>`) so a page refresh doesn't lose work. A toast shows the pending count after every action ("Hid distro line #5. 3 pending — click Commit to push.").
  - **Commit flow:** `Commit pending changes to GitHub` button GETs current file SHA via Contents API → mutates the XML to insert/update `<visibility>0/1</visibility>` per pending entry → PUTs with the SHA. Single commit per click. Commit message: `[AIM site <id>] <type>: hide N · unhide M`. On success, clears pending + refetches.
  - **Conflict handling:** GitHub 409 (file changed since open) → toast tells user their local pending is kept; refresh + retry. 401/403 → toast hints PAT needs `contents:write`. 422 / network / timeout all surface clearly.
  - **Parser carries placemark identity** (`pmIdx` + file `<visibility>`) so the renderer knows what's hidden and the commit knows which placemark to mutate. KML cache key bumped to `aim-kml-cache-v2-` so old cached features (without `pmIdx`) don't get used; one-time refetch on first load.
  - **PAT scope reminder:** read-only PATs still fetch but commits will toast a "needs write scope" hint. Update your token to `contents:read+write` on `aim-userscripts-data` to enable commits.
  - **What's NOT in E1:** Delete (E2), vertex edit (E3), Add new line (E4). Right-click menu shows only Hide / Unhide for now.
- **Panel layout overhaul** — second-pass cleanup of ordering and wording across the whole panel; no functional behavior changed.
  - **AIM Control Panel v1.21**:
    - New `type: 'header'` for visual sub-section dividers in flat toggle lists. Used by Perf Shield to split its toggles into "Map performance" and "Network blocks" without forcing a master checkbox per sub-section.
    - **Per-script `priority` field** for ordering scripts inside a group. The Hotkeys group now sorts simple per-click hotkeys first (Absolute Altitude / Ruler / Clear All / Copy Asset Name), then macros (New Entity Macro), then bulk multi-step tools (Bulk Mission Adder / Altitude Updater / Validator). Scripts without `priority` default to 100 and fall back to alphabetical ordering.
  - **AIM Map Styler v34.20** — category reorder + label cleanup:
    - Reordered Outlines categories to match drone-mission flow: **Flight Path → Free Fly Zone → Assets → Altitude markers → Distribution lines → Transmission lines → Orthomosaic → Coverage Validator → Advanced**.
    - Dropped noisy suffixes: "Free Fly Zone (FFZ) - Overlays" → **"Free Fly Zone"**, "Asset - Overlays" → **"Assets"**, "Flight Path (FP) - Overlays" → **"Flight Path"**, "Altitude marker shield" → **"Altitude markers"**, "Distribution Lines (User KML)" → **"Distribution lines"** (KML noted in meta), etc.
    - Master rename: "Show Overlays (Master)" → **"Show all overlays"**.
    - **Ortho low-res controls moved out** of the Orthomosaic category into Perf Shield (see below). Orthomosaic category now has just Brightness.
    - Toggle IDs are unchanged → all existing per-user prefs (colors / opacities / category masters) carry over with no migration needed.
  - **AIM Performance Shield v1.7** — split into two sub-groups via the new header type:
    - **Map performance**: Hide satellite base tiles · **Low-res orthomosaic (caps tile zoom)** + **Cap zoom at** *[both moved from Map Styler]* — driven via PERF_TOGGLE broadcast (same pattern as hide-satellite). Map Styler still owns the actual tile-cap implementation; Perf Shield just persists the preference + broadcasts it.
    - **Network blocks**: Block session-replay recorder · Block chat widget (Zendesk · Intercom) · Block weather indicator (pilots only).
    - Wording polish: "Block weather API (Percepto /weather_for_indication/)" → "Block weather indicator (pilots only)"; "Hide satellite base tiles (use when ortho covers site)" → "Hide satellite base tiles" (descriptions belong elsewhere, not in toggle labels).
  - **Hotkeys group `priority` field** — added to all 8 hotkey scripts so they sort in intuitive order instead of alphabetical:
    - **AIM Absolute Altitude v1.8** (priority 10)
    - **AIM Measure / Ruler v2.7** (priority 20)
    - **AIM Clear All v1.4** (priority 30)
    - **AIM Copy Asset Name v1.6** (priority 40)
    - **AIM New Entity Macro v1.7** (priority 50)
    - **AIM Bulk Mission Adder v1.12** (priority 70)
    - **AIM Bulk Altitude Updater v4.11** (priority 80)
    - **AIM Bulk Validator v1.3** (priority 90)
- **AIM Control Panel v1.20** — panel cleanup pass:
  - **Reset-to-default arrow on every customized control** (boolean / number / color / select). Same `↺` icon already used for hotkey rebinds; only appears when the value differs from the schema default. Click → deletes the user's override from prefs, broadcasts `SET_TOGGLE` with the default, owning script updates immediately. Type-aware comparison so e.g. `"0.5"` vs `0.5` doesn't show a stale arrow.
  - **Section order made intuitive** instead of pure alphabetical. New `SECTION_PRIORITY` map: Outlines (primary feature) → Performance → Hotkeys (now includes the bulk scripts) → anything else (alphabetical) → GitHub Connection (always last, lives outside the priority map). Easy to edit if you want a different order.
- **Bulk scripts moved into the Hotkeys group** (each previously had its own top-level section, cluttering the panel). All three register with `group: 'Hotkeys'` now:
  - **Bulk Mission Adder v1.10 → v1.11**
  - **Bulk Altitude Updater v4.9 → v4.10**
  - **Bulk Validator v1.1 → v1.2**
- **AIM Map Styler v34.19** — Kick now also forces tile redraw. v34.18 testing confirmed the map ref captures correctly via the resize trick, but ortho tiles stayed stale until the user manually zoomed in/out. Leaflet's tile pipeline caches the rendered viewport and `invalidateSize` alone doesn't trigger a re-fetch. v34.19 explicitly walks `map.eachLayer` and calls `layer.redraw()` on each tile layer 200ms after the resize event (giving the map-capture step time to settle). Also calls `map.invalidateSize()` directly and `runUpdate()` so our overlays render against the freshly-captured + refreshed map state. Should make Kick a one-keystroke full recovery — no more manual zoom needed.
- **AIM Map Styler v34.18** — diagnosed stuck-state root cause + made Kick actually work. Diagnostic in stuck state showed: `__aim_map__: false`, `L.Map.prototype.initialize patched: true`, AND no map-like property anywhere on the container (enumerable, non-enumerable, React fiber, window globals). Conclusion: Percepto's Leaflet map was instantiated BEFORE our `initialize` patch took effect AND the instance is held in a WeakMap or closure that's unreachable from the DOM. v34.17's Kick was clearing state and re-activating but `getLeafletMap()` still returned null → apply functions silently no-op'd. v34.18 fixes:
  - **`patchLeafletMap()` now hooks 7 prototype methods** (initialize, getPane, addLayer, invalidateSize, setView, panTo, _animateZoom) instead of just initialize. Each one captures `this._container.__aim_map__ = this` on first call. Next time Percepto does ANY map operation, we capture the reference even for maps that pre-existed our patch.
  - **Kick now dispatches a synthetic `window resize` event** after re-activating. Leaflet's built-in resize handler calls `invalidateSize` on every map → our patched method intercepts → captures `this` → sets `__aim_map__` on container. Deterministic — no waiting for the user to interact.
  - **`getLeafletMap()` also iterates non-enumerable properties** via `Object.getOwnPropertyNames` as a fallback (catches some Percepto wrapper scenarios).
- **Bulk scripts — Control Panel integration** (older Phase 2 done). Three scripts now register with AIM Controls under their own panel sections, alongside their existing UI (no buttons removed, no functionality changed):
  - **AIM Bulk Mission Adder v1.10** — Shift+B (rebindable). Action only fires on `/merge_available_apps/step2/`, matching the existing behavior.
  - **AIM Bulk Altitude Updater v4.9** — Shift+E (rebindable). Master toggle + invoke hotkey.
  - **AIM Bulk Validator v1.1** — Shift+V (rebindable). Master toggle + invoke hotkey.
  - Standard integration pattern: existing keydown handlers defer to the panel's hotkey router once detected (prevents Shift+X double-firing); IS_TOP gate on HOTKEY_FIRED handler prevents double-execution from BroadcastChannel delivery to all frames; each script gets its own panel section (NOT in the Hotkeys group — they're bulkier features). User can now disable individual bulk scripts or rebind their hotkeys via the panel.
- **AIM Absolute Altitude v1.7** — two fixes for v1.6's popup behavior:
  - **AIM altitude button path now also auto-closes the popup**. v1.6's cleanup only ran when `aimPendingPin` was set, which only `performAction()` (Shift+A) did — so clicking Percepto's native button skipped the cleanup entirely and the popup stayed open. v1.7 hooks the button click directly: any click on `img[title="Absolute altitude"]` sets `aimPendingPin = true`, so the subsequent map click goes through the same cleanup path as Shift+A.
  - **Stacked popups no longer close the wrong one ("offset" symptom)**. v1.6 used `querySelector('.leaflet-popup-close-button')` which returns the first match in DOM order — typically the OLDEST popup, not the newly-opened one. v1.7 snapshots the set of `.leaflet-popup` elements at the start of pin-drop cleanup, then closes only the ones that are NEW since the snapshot. Result: old popups stay open if you intentionally left them, only the just-opened one dismisses.
- **AIM Map Styler v34.17** — **Kick hotkey (Shift+K) for the "stuck after refresh" recovery**. Diagnostic confirmed twice (working state AND stuck state) that no service worker or cache storage is involved, so this isn't a browser-cache issue we can address by clearing caches. The bug is internal to our scripts' state — most likely a stale `leafletMapRef` or observer attachment. The Kick hotkey does the script-side equivalent of "Empty Cache and Hard Reload" for our scripts: `setActiveState(false)` → drop `leafletMapRef` + `observerTarget` → reset warmup → `setActiveState(true)` after a 100ms delay. If the bug is in our cached state, this recovers overlays without a page reload. If Kick doesn't help when stuck, the issue is deeper (probably in Percepto's React state) and we need to keep digging. Hotkey is rebindable in the panel under Outlines → Hotkeys.
- **AIM Absolute Altitude v1.6** — two fixes/features:
  - **Popup default-closed actually works now**. v1.5 only *skipped the re-click* on pin drop, but Percepto opens the popup natively before our code touches it, so skipping had no effect — popup stayed open. v1.6 actively clicks `.leaflet-popup-close-button` 50ms after the pin drops when the toggle is on, so the popup is dismissed. Click the pin yourself to re-open it.
  - **Right-click an altitude pin to delete it** (Phase C). Detects pins by their `altitude-shadow` / `altitude-marker` SVG src (stable across Percepto's build-hashed filenames). Finds the Leaflet marker that owns the DOM element via `map.eachLayer()` and calls `removeLayer()` so Leaflet forgets it entirely (otherwise React could re-render it). Falls back to DOM `.remove()` if the Leaflet map isn't reachable (Map Styler's L.Map patch normally exposes it on the container). Logs `🗑️ Deleted altitude pin via right-click` on success.
- **AIM Map Styler v34.16** — vertex toggle now actually works. v34.12-v34.15 had an "auto-show vertex dots when editing" feature that auto-detected edit mode via `EDIT_MODE_SELECTOR`. Diagnostic-confirmed: that selector matches ~70 elements at idle (it picks up the always-present native FFZ + FP dashed outlines, not just the actively-being-edited line), so `inEditMode` was effectively pinned true and dots were never hidden no matter what the user toggled. Removed the auto-detect entirely. Toggle is now the sole control: **ON = always show, OFF = always hide** (red/disconnect/error variants still preserved). Label updated to match. Auto-show-when-editing can come back later if we find a tighter edit-mode signal — needs DevTools inspection of an actively-edited line for a distinguishing class or dasharray value.
- **AIM Map Styler v34.15** — bulletproof vertex hide. v34.12-v34.14 relied on a class-selector CSS rule with `!important` (`.cls.cls { display: none !important }`) to hide flight-path vertex dots when not in edit mode. Inspector-confirmed: the rule was present in our injected style tag but the dot's computed `display` was still `flex` — Percepto's rules were winning the specificity/order battle. Switched to per-element inline `style.setProperty('display', 'none', 'important')`. Inline `!important` beats any class selector regardless of specificity or source order. Red/disconnect/error variants still preserved via className substring check. Cleanup on master-off clears the inline display so Percepto's natives return.

## 2026-05-19

- **AIM Map Styler v34.14** — cap the TOP-frame `.leaflet-map-pane` retry at 5 attempts (1s) instead of 150 (30s). Same logic as the Control Panel v1.19 fix: Percepto's Leaflet map is always in the IFRAME, so the TOP-frame styler's 30s retry-then-warn loop was producing dozens of stack traces per page load for no benefit. IFRAME keeps the full 30s budget (its first load can take ~7s on some pages). TOP now logs once that it's expected to have no map-pane, then quiets down.
- **AIM Map Styler v34.13 + AIM Control Panel v1.19** — two recovery/cleanup fixes after a laptop-sleep-then-soft-refresh produced a stuck no-overlay state:
  - **Map Styler v34.13 — first-render watchdog**: after the styler activates, the heartbeat now bypasses the hash-skip optimization for the first 10 ticks (~30s). Without this, the very first `runUpdate` after activation could fire before Leaflet's overlay-pane SVG was mounted, producing zero overlays (`ourN=0`), and every subsequent heartbeat would see the same hash and skip — leaving overlays absent indefinitely. Now we always run for 30s post-activation, then settle into hash-skip mode once things have stabilized. Recovers from the suspend/wake symptom without needing a hard refresh.
  - **AIM Control Panel v1.19 — skip button injection in TOP frame**: `.map-tools` only ever exists in the iframe where Percepto mounts its Leaflet map; the TOP-frame Control Panel was running its 60-attempt-over-30s `ensureButton` retry loop in the wrong frame and producing dozens of `[AIM CONTROL TOP] gave up injecting after 60 tries` stack traces per page load. Now logs once at startup that injection is skipped in TOP, then stays quiet. TOP instance keeps doing its real job (BroadcastChannel routing, GM storage) without the noise. — vertex dot visibility redesigned around the actual workflow:
  - Toggle renamed to **"Always show vertex dots (off: only while editing)"**, default OFF.
  - When OFF (default): vertex dots are hidden EXCEPT (a) red disconnected/error variants — always shown, (b) when any line is in edit mode (auto-detected via the black-dashed edit-mode line) — at which point all vertex dots become visible so the user can grab them.
  - When ON: vertex dots always visible (the v34.10/11 behavior, opt-in now).
  - This means in normal building you see ~zero dots (good for perf + visual clarity on dense sites); click an FP to edit and all the dots appear automatically.
  - Specificity bump on the hide rule (`.cls.cls`) to beat Percepto's CSS — the single-class selector was being overridden in some cases, leaving dots painted at full opacity hidden in plain sight under the buffer color. — two fixes on top of v34.10:
  - **Buffers were inheriting the line's inline stroke** (so FP buffers looked the same color/opacity as the FP line, making the line appear "too big"). Cause: `line.cloneNode(true)` copied the inline `style.stroke` we set for line-color overrides; inline style wins over the buffer's `setAttribute('stroke', …)`. Fix: clear the clone's inline `style.stroke` and `style.strokeOpacity` immediately after `cloneNode`, before applying the buffer's own attributes. Applies to all three clone sites (40ft buffer, 65ft band, shielding band).
  - **"Show flight-path vertex dots" toggle now keeps the disconnected/error variants visible** when toggled OFF. The bare hide rule was hiding ALL vertex dots including the red ones that signal a disconnected segment — those are important for the builder to see. Now uses attribute-substring selectors (`[class*="disconnect" i]`, `[class*="error" i]`, etc.) to keep them visible. If your build uses a different class name for the disconnected variant, share the HTML and I'll widen the pattern.
- **AIM Map Styler v34.10** — Phase B (granular color/opacity) + Phase D (FP vertex dots) bundled:
  - **FP 65ft outer band now has its own color + opacity** controls (`65ft band color`, `65ft band opacity` in the Flight Path category). Defaults preserve the prior shared-with-40ft behavior (`#1ca0de`, `0.225` ≈ the old 0.5 × 0.45 multiplier).
  - **Line color + opacity overrides** added to FFZ, Asset, and FP categories. Applied as inline `style.stroke` / `style.strokeOpacity` so the host's stroke attribute is untouched (our other selectors still match). Cleared when the category master is off. Defaults match Percepto's native colors so no visible change unless you tweak them.
  - **Asset fill color + opacity** controls (separate from line color). Active only when `Show asset fill` is on. Defaults to white at full opacity (the prior behavior).
  - **Flight-path vertex dot styling** (Phase D): three new controls in the Flight Path category — `Show flight-path vertex dots` (toggle, default ON), `Vertex dot color`, `Vertex dot size` (2–20px, default 10). Implemented via injected `<style>` targeting `.map-marker__flight-path-vertex` with `!important`; persists across Percepto's re-renders since CSS rules don't need re-application like inline styles do. Hide them on dense sites if they're cluttering the view.
- **AIM Sidebar Resizer v3.3 — TEMPORARILY DISABLED** — was breaking AIM from loading correctly. v3.3 is a kill-switch release: the entire script body is gated on a `DISABLED = true` constant and returns at init with a clear console log (`[AIM SIDEBAR RESIZER] v3.3 DISABLED — script no-ops until further notice`). Safe to leave installed; existing installs will auto-update to the no-op on Tampermonkey's next check. Removed from the install list on both the README and the Pages install guide so new users don't pick it up. Will be re-enabled once we identify what was breaking — the script itself wasn't changed, just gated.
- **AIM Map Styler v34.9 + AIM Absolute Altitude v1.5** — Phase A site-builder QoL bundle:
  - **Asset lockdown** (Map Styler, in Asset category, default OFF): toggle locks all white-asset paths against clicks. Capture-phase mousedown/click interceptor swallows events on locked assets *unless* you hold Shift — Shift+click is the per-asset bypass. Useful when building so you don't accidentally drag/select assets while panning.
  - **Orthomosaic brightness slider** (Map Styler, new Orthomosaic category): 0.2× to 1.0× CSS `filter: brightness()` on the ortho tile-layer container. Default 1.0× (no change). GPU-accelerated, near-zero cost.
  - **Orthomosaic low-res mode** (same category, default OFF): caps `maxNativeZoom` on the ortho TileLayer (default cap = 15). Leaflet auto-upsamples beyond that — blurrier when zoomed in but ~10× fewer tile fetches. Use when actively building and you don't need to read asset labels.
  - **Altitude pin popup default-closed** (Altitude script, default ON for this user — flip OFF to restore the old auto-open behavior): suppresses the 50ms post-creation re-click that v1.4 used to recover from the stray-vertex cleanup closing the popup. Pin gets dropped, popup stays closed. Click the pin manually to open it. Default toggle value is **ON** because the user explicitly asked for this; coworkers who liked the auto-popup can flip it OFF in the panel. — cosmetic-only cleanup of the v34.7 noise:
  - `SET_TOGGLE master=...` now only logs when the value actually transitions. The Control Panel echoes a SET_TOGGLE storm whenever any script re-registers (and with several scripts × TOP+IFRAME contexts there are dozens per page load) — v34.7's logging was firing on every redundant arrival. `setActiveState` is already idempotent so the repeated calls weren't doing any harm, just spamming the console.
  - "hide-satellite is ON but no tile layer matched" warning no longer fires when *no* tile layers have been seen yet — that just means the first runUpdate happened before Leaflet finished adding the host's tile layers, not that the URL pattern is wrong. Only warns once we've seen ≥1 tile layer and still found no match.
- **AIM Map Styler v34.7** — fixes "won't even load" symptom that started after a browser-cache clear. Root cause: master toggle defaulted to `false` in the schema, so a fresh install (or one whose Control Panel storage got wiped) stayed dormant — KMLs loaded into memory but `runUpdate` never ran, so nothing rendered and the satellite-hide never applied. Two fixes:
  1. Master toggle now defaults to `true`. New installs and post-cache-clear users get a working styler out of the box.
  2. Safety net: if no `SET_TOGGLE master=...` message arrives from the Control Panel within 1.5s of register, auto-activate (and log "auto-activating (schema default)"). Catches the case where the panel's storage was wiped or it never echoes the toggle for some reason. Skipped if a SET_TOGGLE *did* arrive with `master=false` (user explicitly off).
  Also logs `SET_TOGGLE master=true|false` when received so future "did the toggle arrive?" debugging is one-line obvious in the console.
- **AIM Map Styler v34.6** — fixes "satellite reappears, KMLs/buffers/shielding randomly stop showing" on both Site Setup and Data View. Root cause: Percepto's React was wiping our SVG overlays (and re-creating tile layers) without changing any of the counts in our heartbeat hash — so the hash-skip optimization in v34.0 was preventing the next heartbeat tick from rebuilding. Validator pins survived because they sit in a more stable container, which masked the issue. Two fixes:
  1. Include our own overlay count (elements with `data-custom-buffer-v24="true"`) in the heartbeat hash. If Percepto wipes them, count drops, hash changes, next heartbeat rebuilds them within 3s. Same mechanism re-applies the satellite-hide on freshly added HERE tile layers.
  2. If the observer's target node was detached between ticks (Percepto re-mounted the overlay-pane), force a `runUpdate` from the heartbeat to trigger the existing self-heal path — bypasses the hash check so we recover even if counts happen to coincide.
  Also: log version at init (`Initializing v34.6...`) so version mismatches are obvious in the console.
- **AIM Performance Shield v1.6** — TDZ fix. v1.5's chat-CSS-hide block referenced `const`s that hadn't been evaluated yet when the init code ran (function declarations hoist but `const` doesn't), so the chat CSS never applied on initial page load and the console showed `ReferenceError: Cannot access 'CHAT_BLOCK_STYLE_ID' before initialization`. Toggle-driven re-apply still worked, and the network block already removed the bubble, so visible impact was zero — but the error was noise. Consts now live at the top of the IIFE alongside other state.
- **AIM Performance Shield v1.5** — fixes the "I turned on Block chat widget but the bubble is still there" case:
  - Added Zendesk Web Widget patterns (`zdassets.com`, `zopim.com`, `zendesk.com`) to the chat block — Percepto's actual chat vendor turned out to be Zendesk, not Intercom. Toggle relabeled to "Block chat widget (Zendesk + Intercom)" since it now covers both.
  - Added CSS hide for any already-rendered chat bubble (`iframe#launcher`, `iframe[title*="messaging window"]`, `button[aria-label="Open messaging window"]`, plus standard Intercom selectors). Script-blocking alone can't undo a bubble that loaded before the block was on; the CSS applies instantly and is reversible via toggle.
- **AIM Map Styler v34.5** — added `maps.hereapi.com` to satellite URL patterns. Percepto uses HERE Maps for its base imagery (and a second HERE layer for the labels overlay); both get hidden when Hide-Satellite is on, leaving just the orthomosaic and overlays visible.
- **AIM Map Styler v34.4** — diagnostic logging for the Hide-Satellite toggle. When no tile layer matched a built-in satellite URL pattern, the toggle silently did nothing; v34.4 logs every unique TileLayer URL it walks (`tile layer present: <url>`) and warns once if the toggle is on but nothing matched. Made it possible to identify the HERE Maps URLs that v34.5 then patterns against.
- **AIM Performance Shield v1.4** — section renamed to **Performance** in the panel and restructured around peer toggles (each block category is independent — turning off session-replay no longer disables the other blockers). Three new toggles, all default OFF:
  - **Hide satellite base tiles** — useful when an orthomosaic already covers the site; suppresses the redundant satellite tile layer so paint/decoding cost goes away on every zoom/pan. Detection is heuristic (ESRI/ArcGIS, Mapbox satellite, Bing, Google, generic `/satellite|aerial|imagery`); if your provider isn't recognized, send the tile URL and I'll add the pattern. Implementation lives in the Map Styler (which already has the Leaflet map reference); the toggle in Perf Shield drives it via a `PERF_TOGGLE` broadcast.
  - **Block weather API** — drops every request to Percepto's `/weather_for_indication/<siteID>/`. WeatherStore goes idle once data stops arriving, so the whole `recalcWeather` cascade stops too. Useful only to pilots; safe to leave off for site building.
  - **Block Intercom chat widget** — drops requests to `intercom.io` / `intercomcdn.com` / `intercomassets.com` / `widget.intercom`. Cuts the chat-support bundle entirely.
- **AIM Map Styler v34.3** — implementation hook for the Perf Shield satellite-hide toggle (listens for `PERF_TOGGLE` on the control channel). No new panel UI here — the toggle lives in Perf Shield's Performance section.

## 2026-05-18

- **AIM Map Styler v34.1** — stop spamming "no GitHub token cached yet" warning. The Control Panel echoes one SET_TOGGLE per toggle whenever the panel opens (or scripts re-register); each one triggered a render → fetch attempt → warning → token request. Resulted in ~14 spam lines + 14 cascading REQUEST_TOKEN messages per panel open. Now warns + requests once per token-lost period.
- **AIM Performance Shield v1.2** — stop spamming "ENABLED — reload page" log on every panel open. The Control Panel echoes a SET_TOGGLE message back to the script on every REGISTER (which happens whenever the panel opens, plus on every REQUEST_REGISTRATIONS), so the shield was treating each echo as a "user just changed the toggle" event and logging the reload reminder. Now only logs on actual state transitions.
- **AIM Performance Shield v1.1** — two bug fixes in v1.0 that materially blunted its effect:
  - TDZ (temporal dead zone) reference error during init prevented Control Panel registration (and possibly some blocker installation).
  - `new Response('', { status: 204 })` throws because HTTP 204 must have a null body. Every blocked fetch was throwing instead of returning a fake response, so the host's network layer saw failures and retried. Fixed to use `null` body.
  - Also added: HTMLScriptElement.prototype.src setter override + setAttribute interception (catches `<script>` tag loads BEFORE the browser starts them — more reliable than the MutationObserver fallback alone). Every install* call now individually try-wrapped so one failure can't take the rest down.
- **AIM Performance Shield v1.0 (NEW SCRIPT)** — blocks the host app's session-replay recorder. Per the perf trace, that recorder was leaking ~200MB heap + ~600K DOM nodes per 30 seconds on dense sites, AND consuming ~30% of total CPU. Surgical block — only `plugin-session-replay-browser` and `rrweb` URLs are dropped; main product analytics (`analytics-browser.js`) still flows. Toggle via AIM Controls; default ON. New script — install once via the README link.
- **AIM Map Styler v34.0** — performance tuning for dense sites (lots of KML lines, FFZs, FPs, validator pins). Heartbeat now skips the full wipe+rebuild when nothing has changed (line counts, zoom, KML features, toggles, validator results all hashed). Heartbeat cadence reduced 1.5s → 3s. Mutation-storm debounce hard cap 150ms → 300ms. Combined effect: idle CPU near zero, interactive CPU halved during zoom/pan. No visual change when nothing is happening.
- **AIM Control Panel v1.18** — After Save & Test of a GitHub PAT, the status message now tells you to hard-reload (Ctrl+Shift+R) if shielding KMLs don't appear within ~10 seconds. Works around an intermittent first-time-setup race we haven't fully diagnosed.

## 2026-05-17 (initial public release)

Everything before this point was iterated rapidly during initial development; see git history for per-commit detail. High-level summary of what's in the first public release:

- **AIM Control Panel v1.17** — schema-driven settings hub with cyan collapsible sections, group support (Hotkeys), per-hotkey enable + colored labels (New Entity Macro), hotkey collision detection, GitHub PAT compact section with auto-test status dot, event-delegation click handling.
- **AIM Map Styler v33.x** — buffers/outlines/violations for FFZ/asset/FP, dual-type shielding KML loader (distro yellow, trans red), Coverage Validator (on-demand FAA 200ft check with persistent dismissible pins + red highlight of failing outline segments).
- **AIM New Entity Macro v1.6** — per-entity enable toggles, color-coded entity labels, Shift+D double-press delete for safety.
- **AIM Inspector v1.7** — cross-frame Leaflet diagnostic panel (Shift+I).
- **Hotkey scripts** (Altitude, Ruler, Clear All, Copy Asset Name) — all integrated with Control Panel under a "Hotkeys" group.
- **Bulk scripts** (Mission Adder, Altitude Updater, Validator) — original UI preserved; panel integration pending.
- **Sidebar Resizer** — auto-runs, restores map visibility.
- **Distribution** — all scripts at `*.user.js` so install links auto-prompt Tampermonkey, with `@updateURL` headers for automatic daily update checks.
