# Changelog

Human-readable summary of what shipped in each update. Tampermonkey auto-update prompts coworkers to install new versions; this file is what they read to know *what changed*.

Newest entries on top. Each entry calls out the script + version + a one-line summary. Issue references look like `[#7](https://github.com/Ned-Yap/aim-userscripts-issues/issues/7)` and link to the private tracker (only visible to collaborators).

---

## 2026-06-24 — Advanced Draw — flush corners (auto-overshoot + snap to standoff corner) — Asset Inspector v4.100 (dev/latest)

No more guessing how far past a corner to click. (1) **Ctrl now snaps to the asset's standoff *corner*** (the offset-ring vertex), not just the nearest edge point — so wraps land exactly on that "30 ft-past" point you were predicting. (2) **Corners auto-square** — a sharp/gentle turn now overshoots past the pivot by the width into a clean square corner instead of a pinched/pointed one (right-angle turns were already flush). Together you get clean corners around obstacles on or off pads.

---

## 2026-06-24 — Advanced Draw — per-segment width (drag an outer edge) — Asset Inspector v4.98 (dev/latest)

Each corridor segment now has its **own width**. Grab a segment's **outer edge and drag it** to widen/narrow just that box (e.g. push past 30 ft on one stretch) — the corridor re-mitres cleanly at the width change, neighbors stay attached. The **Width** field still sets all segments at once (a global reset); edge-drag overrides individuals. Per-segment widths autosave with the rest of the draw. (Priority on click: grab a vertex → grab an outer edge → else add a point.)

---

## 2026-06-24 — Advanced Draw — visible Ctrl-snap + grab/fix vertices mid-draw — Asset Inspector v4.97 (dev/latest)

Two follow-ups to Advanced Draw: (1) **Ctrl now shows what it's doing** — holding it draws the nearest asset's offset ring in magenta + a marker at the snap point, and the magnet radius is much more generous so it actually catches. (2) **Grab and fix vertices without finishing** — click any placed vertex and drag it (like editing a flight path) to fix the shape mid-draw; the corridor + band update live, no Enter/double-click needed. (Esc still removes the last point; double-click/Enter still finishes.)

---

## 2026-06-24 — Site Setup Generator — ✦ Advanced Draw (interactive zigzag corridor FFZ) — Asset Inspector v4.96 (dev/latest)

New **✦ Advanced Draw** mode in the ⊕ Generate modal for hand-drawing complex FFZs (zigzags/corridors) the auto-generator can't. You click the **inner (asset-facing) edge** point-to-point; each segment is a box of an adjustable **width** (default 30 ft) extending to one side (**F** flips it), and a live **shielding band** of an adjustable **offset** (default 25 ft, customizable color + opacity) rides the inner side so you keep the actual infrastructure clear by eye. **Live full-box preview** follows the cursor; **Shift** angle-snaps to 15° off the previous segment for clean turns; **Ctrl** magnet-snaps the edge to the offset off the nearest asset (release = free, for on-pad drawing); **double-click / Enter** finishes, **Esc** undoes the last point. The whole zigzag commits as **one FFZ** via the normal Commit (DEM/altitude computed at finish only, MSL/AGL-aware). In-progress draws **autosave to localStorage** so a crash/reload doesn't lose them. (Per-segment edge-width drag, branch-from-existing-edge, and the experimental closed-loop "donut" are the next slices.)

---

## 2026-06-24 — Asset Inspector v4.36 (prod) / v4.95 (dev/latest) — asset state styling: outline-only, 4px

Assets are now outline-only (no fill): pink regular, orange unshielded, light-blue unreachable (all 100% opacity, 4px) and white empty at 35% opacity. (Dashed outlines for the non-regular states were requested but KML/Google Earth doesn't support dashed lines, so colour distinguishes them.)

---

## 2026-06-24 — Asset Inspector v4.35 (prod) / v4.94 (dev/latest) — regular assets are now PINK

Per request, regular (normal-state) assets render with a pink ~80% fill instead of white, so they stand out from the satellite. Unshielded stays orange, unreachable light blue, empty 30% white.

---

## 2026-06-24 — AIM Mission Log Table v1.7 — fix: AGL really resolves now (DEM lookup no longer bails on one hiccup)

v1.5's DEM retry overcorrected: it gave up the whole batch if the *first* lookup failed, and didn't retry non-429 hiccups at all — so AGL still showed "n/a". The terrain endpoint is actually healthy and answers on the first try; the lookup now retries transients per-pin and only stops after several consecutive failures, so a single blip can't wipe every AGL. Logs `[AIM MLOG] DEM ground resolved N/11` so it's verifiable.

---

## 2026-06-24 — AIM Mission Log Table v1.6 — flight-path line is now hot pink, width 6

Cosmetic: the KML flight path + track render in hot pink at width 6 (was orange, width 3) for better visibility over terrain.

---

## 2026-06-24 — AIM Mission Log Table v1.5 — fix: waypoint AGL now resolves (DEM retry/backoff)

The per-waypoint **Altitude AGL** was showing "n/a (DEM unavailable)" for every pin. Percepto's terrain endpoint rate-limits with a 429 while a site's elevation tiles are cold — and on the mission-log page they're always cold because the map isn't loaded — so the single-shot lookup always failed. It now retries with backoff (warming the first lookup generously) so AGL fills in, and short-circuits if the endpoint is genuinely unavailable so the download can't hang.

---

## 2026-06-24 — AIM Mission Log Table v1.4 — download any mission's 3D flight path as KML (with waypoints + summary)

Every row in the Mission Log now has a 📥 button in the right-hand actions column. Click it to download that mission's actual drone flight path as a KML — the drone's recorded LAT/LNG/altitude over the whole flight. Opens in Google Earth as a 3D path you can fly through, plus a **time-animated track** (hit ▶ on the time slider to play the flight back). Altitude is true meters-above-sea-level (absolute), so the path sits at the right height over terrain. On top of the line, it drops a **labeled waypoint every 10% of the flight** (plus Takeoff/Landing) — click any pin for altitude (m + ft), **AGL** (derived from terrain), speed (m/s + mph), heading (° + compass), battery %, and the site-local time. The file's top-level description is a **flight summary**: duration, distance flown, altitude range, max AGL, max speed, and battery used. Idle hover points are de-duplicated to keep the file small. No clicks into the mission needed — just the button on the log row.

---

## 2026-06-24 — AIM Issues v1.29 (prod + dev/latest) — Slack catch-up on site-open + manual resend

Building on v1.27, Slack notifications now have a safety net. Each issue tracks a watermark of how much of its history has reached Slack (advanced only after a confirmed post). When you open a site, your session checks every issue and, if any changed while Slack was offline, posts a short 🔄 *Catch-up* reply in the thread and refreshes the status board — automatically, no action needed. Existing issues are migrated to "already caught up" on first open so the backlog isn't re-posted. For a notification that was missed *before* this shipped (like the 06-23 approvals), open the issue and use the new approver-only **📣 Resend to Slack** button to re-post its current status (it creates the Slack thread if one was never made).

---

## 2026-06-24 — AIM Issues v1.28 (prod + dev/latest) — Affected-entity detection now catches assets the issue is drawn inside

Drawing an issue polygon *inside* a larger asset (or FFZ/NFZ) used to capture nothing — the detection only fired when one of the asset's own corners landed inside your issue polygon, which never happens when your polygon is smaller than the asset. It now does a true polygon-overlap test (either shape's vertices inside the other, **or** their edges crossing), so an issue drawn anywhere on top of an asset captures it. Flight paths get the same treatment — a polygon drawn across a flight-path segment (between its vertices) is now detected too.

---

## 2026-06-23 — Lite/Full mode shipped to prod — Control Panel v1.33, Map Nav v0.9, Perf Shield v1.17, Power Line Editor v0.17

The Control Panel now resolves your GitHub login against a CSM whitelist and shows a **🛠️ Full (CSM) / 🪶 Lite** badge in its header (CSMs get a Lite/Full preview toggle). This is the foundation for a separate **Lite install** for regulators/pilots. **For CSMs nothing changes** — your building tools keep working exactly as before (they are not gated in prod). **Map Nav** (WASD pan / Q-E zoom / Alt sprint) and the **Power Line Editor** are now in prod, and **Perf Shield** keeps the weather indicator alive for anyone in Lite. If after updating the panel says you're in Lite but you're a CSM, reload once (or check the console for `mode resolved: <you> → CSM=true`).

---

## 2026-06-24 — AIM Issues v1.27 (prod + dev/latest) — Slack notifications self-heal + stop failing silently

A status change that synced to GitHub but never reached Slack used to look identical to a successful one — the post was skipped or errored with zero feedback. Now, on a normal (non-validator, non-local) issue, if Slack isn't ready when you act, the script attempts one on-demand reload of the Slack config (fixes the case where the config didn't finish loading that session). If it still can't post — or the Slack API rejects it — you get a visible ⚠ toast saying it saved + synced to GitHub but Slack was **not** notified, with the likely reason. No more silent misses, no console digging required.

---

## 2026-06-23 — AIM Issues v1.26 (prod + dev/latest) — View & reinstate deleted issues (approvers)

Deleted issues are no longer gone for good. Approvers get a new **🗑 Deleted** filter chip in the Issues panel that lists tombstoned issues (struck-through, with who/when deleted). Open one and there's a **♻ Reinstate this issue** button (approver-only, two-stage confirm) that restores it to the status it held before deletion. The reinstate is sync-safe: the deleted/live state is now derived from each issue's full history (last delete-vs-reinstate event wins), so a restore survives merging against a coworker's still-deleted copy instead of being silently re-deleted. Slack threads get a `♻ reinstated` reply and the parent message un-strikes. CSMs don't see the Deleted chip or the Reinstate button.

---

## 2026-06-23 — AIM Issues v1.25 (prod + dev/latest) — Approvers can delete any issue

Until now, deleting an issue was creator-only (anyone could also delete throwaway local-only flags). Approvers can now delete **any** issue regardless of who created it — handy for clearing out "TEST" flags and other junk you didn't create. The deletion is still tombstoned and attributed to the approver in the issue history, so the audit log stays honest, and the Delete button's label flags whose issue you're removing (e.g. `🗑 Delete (approver — @someone's issue)`).

---

## 2026-06-23 — Asset Inspector v4.34 (prod) / v4.93 (dev/latest) — asset state colours now actually visible

Follow-up to v4.33: the state colours were too faint to see (no polygon fill in 2D, only ~20% fill in 3D), so assets read as "all white". Fills are now solid (~80% for orange/light-blue, ~50% white regular, 30% white empty) and show in **both** 2D and 3D, with thicker outlines.

---

## 2026-06-23 — Asset Inspector v4.33 (prod) / v4.90 (dev/latest) — Analyzer KML colours assets by health state

Asset polygons in the exported KML are now colour-coded by state (parsed from the subtype, same as the SUM table): **white** for regular, **orange** for unshielded, **light blue** for unreachable, and **30%-opacity white** for empty. Unshielded takes priority when an asset has more than one modifier. Other states (HY, Inactive, normal) stay white.

---

## 2026-06-23 — Asset Inspector v4.32 (prod) / v4.89 (dev/latest) — Analyzer KML now includes Base Stations & Safe Zones

The Site Setup SUM → Analyzer KML export skipped Base Stations (type 8) and Safe Zones (type 98) entirely. They now export as their own top-level folders ("Base Station" / "Safe Zone") with point markers, each toggleable in the "Include folders" list (with counts) like every other entity type. Default ON.

---

## 2026-06-23 — Asset Inspector v4.31 (prod) / v4.88 (dev/latest) — Analyzer KML download now uses the site name

The Site Setup SUM → Analyzer "Download .kml" button named the file by site ID only (`Site_1605_Map_(3D).kml`), even though the KML's internal document name already carried the full site name. The download filename now mirrors that document name — e.g. `Site 1605 Map - Exxon - Lille Midkiff 5 - OFFLINE (3D).kml`. Filesystem-illegal characters (`/ \ : * ? " < > |`) are stripped so the download isn't rejected or mangled.

---

## 2026-06-22 — Mission Bank Tools v1.63 (dev/latest) — Stage steps works on J2A / In-Place missions

Fixes "Need an existing Navigate + Snapshot to copy from" on missions built from a **J2A** (Jump-to-Alert) flight, whose snapshots are **"In Place"** (yaw/tilt, no GPS). Stage now: matches steps by `type_name` **or** type number, sources instructions from the live editor if the cached app is empty, and accepts an In-Place snapshot as a settings template (no GPS required). The staged snapshot itself is forced to a proper **GPS** snapshot (since you place + drag it into position), so it shows on the map and exports/validates correctly. Logs a diagnostic if it still can't find a template. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.62 (dev/latest) — Stage steps: choose where to insert (push the rest down)

Stage steps now has an **"Insert at Nav #"** field. Leave it blank to append at the end (as before), or set it to e.g. **6** and the new Navigate is dropped in as **N6** with everything from the old N6 onward pushed down by one. Because the new block lands in the middle of the list, **the snapshots renumber too** (the new snapshot becomes S6, the old S6→S7, …) — so you no longer have to right-click and renumber by hand. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.59 (dev/latest) — selecting a checkbox no longer jumps the list to the top

Fixes the annoyance from v1.58: ticking a checkbox re-rendered the table without preserving scroll, so the list jumped back to the top. It now saves the scroll position before the re-render and restores it — the list stays put as you keep selecting. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.58 (dev/latest) — spreadsheet-style multi-select in the Summary table

The Summary table's row checkboxes now do **Shift+click range select** (parity with the Site Setup SUM): plain or **Ctrl/Cmd+click** toggles one mission (others stay selected), and **Shift+click** applies that click's new state to the whole range from the last-clicked row to here — like selecting cells in a spreadsheet. Works in both the Mission Bank and Mission Log tables. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.57 (dev/latest) — row-click pan more robust (handles In-Place / no-GPS missions)

Row-click map pan now falls back through snapshot/nav points → **any located instruction** → the server's route points, so a mission whose snapshots are "In Place" (no GPS) still pans to its navs/route instead of silently doing nothing. When it genuinely can't pan, it now logs the reason (`[pan] …`) so we can see why (not-in-cache / no usable GPS / no map). Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.56 (dev/latest) — M1 on the step you're editing is fully native (no self re-open)

Fixes the marker-switch colliding with the step you're currently editing: left-clicking the marker of the step **you're already in** now does **nothing** on our side — fully native, so you can drag/reposition it (including dropping it right next to itself). Every **other** marker still saves the current step and switches to it, as before. Made the "which step is open" detection reliable (tracks the step we opened) so the same-step exemption is precise — only the edited one, never the others. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.55 (dev/latest) — reassign which Nav a Snapshot belongs to (M2 on a snapshot)

Right-clicking a **snapshot** badge on the map now shows two fields: its capture order (**S# →**, as before) **and which Navigate it's attached to** (**Nav N# →**). Type a different nav number and the snapshot's whole block (snapshot + its Thermal/GEM/Wait wrap) is re-homed under that nav as its last capture — the snapshot's own GPS/altitude is unchanged, only which nav the drone flies to before shooting it. Hit SAVE in the editor to persist. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.54 (dev/latest) — natively-added navs/snaps get their N#/S# number immediately

Adding a Navigate (or Snapshot) the normal way (Percepto's **Add Instruction**) no longer leaves the on-map marker blank until you save + reopen. The badge numbering now reads the **live editor order** (which includes the un-saved step in its real position) instead of the last-fetched mission cache — and a live nav/snap count change forces an immediate re-number. (🔄 Refresh couldn't help before because it re-pulls the *server*, which doesn't have the unsaved step yet.) Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.53 (dev/latest) — fix the real page-hang: runaway elevation re-fetch on detail view

**The actual cause of the crash** (RESULT_CODE_HUNG, `fetching 1 elevations` climbing forever): opening a mission's detail view checked **MBT's local** elevation cache to decide what to fetch, but fetches now route through the OTD bridge which caches in **Asset Inspector's** store — so the point never appeared "cached," and each completion re-rendered → re-fetched → re-rendered, endlessly. Now the cache check is **bridge-aware** (so a resolved point counts as cached and the loop stops), unresolvable points get a cooldown so they aren't re-requested every render, and the detail view only re-renders when something actually resolved. (Supersedes the v1.52 edit-pan theory — the hang was on row-click, not Edit.)

---

## 2026-06-22 — Mission Bank Tools v1.52 (dev/latest) — fixes: edit-pan crash, generator buttons mission-bank-only, Stage ergonomics

- **Fixed the Edit ✏️ crash** (RESULT_CODE_HUNG): the map pan now fires *after* the editor finishes opening instead of during the navigation (plus finite-coordinate guards).
- **⊕ Generate / ⛟ Merge now appear ONLY on the Mission Bank page** (they were leaking onto Site Setup via a fallback selector), and **Merge moved beside Generate** instead of stacking into the Summary button.
- **Stage steps**: new Navigates/Snapshots now **copy the LAST** nav/snap's settings (not the first), and are placed in the **middle of the current map view** (fanned out) so you don't have to hunt for them.

Dev-only (latest/). *(Known issue still under investigation: staged Navigates can show a blank N# badge and aren't draggable until you save + reopen the mission.)*

---

## 2026-06-22 — Mission Bank Tools v1.51 (dev/latest) — Summary panel parity with Site Setup SUM

The Mission Bank Summary panel now matches the Site Setup SUM's window behavior: **resize from any edge or corner** (was bottom-right only), the panel stays **locked to the AIM map** (drag/resize clamped to the map region so it can't wander over the sidebar or off-screen), and **clicking a row pans/zooms the map to that mission** — and **Edit ✏️** pans to the pad as it opens the editor. Checkbox selection still stays put (no map jump). Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.50 (dev/latest) — reuse already-cached elevations (stop re-fetching)

Builds on v1.49: instead of re-requesting each asset centroid by exact coordinate, MBT now **reuses a nearby cached DEM point** (within ~50 ft — the same flat-pad ground) via the Inspector bridge's `getNearest`, and the bulk-generate prefetch now **only fetches centroids we don't already have**. Since Asset Inspector already samples every asset's vertices + edge midpoints, most centroids resolve from cache and the generator typically fetches **nothing** — no network, no rate limit. Console logs how many uncached elevations it actually needs. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.49 (dev/latest) — fix bulk-generate "Elevation Not Loaded" (429 storm)

Bulk **Generate All** (and the AGL view / auto-AGL) no longer choke on Percepto's `/location_altitude/` rate limit. MBT now routes its DEM elevation through Asset Inspector's **`__aimAIElevation` bridge** when present — the Open-Topo-Data source (batched, no rate limit) the Inspector already uses — instead of hammering Percepto per-point and getting 429s (which left assets un-built and forced the reload-and-rerun-til-it-catches-up grind). Falls back to MBT's own Percepto fetch if the bridge isn't installed. Requires the **Latest Asset Inspector** (the one with OTD) running. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.48 (dev/latest) — Section + Battery merge (build merged missions in MBT)

New **⛟ Merge** button (next to ⊕ Generate, generator-unlock only): groups the site's solo missions into **battery-tiered merged missions per compass section** (8-way + Central), ordered **furthest→closest from base**. Routed distances are computed with Asset Inspector's exact routing core (flight-path graph + Dijkstra + FFZ-bridging), so the Tattu (≤14k ft) / Tulip (≤18k) tiers match its Battery column. Groups are named `North 1` (Tattu subset) / `North 2` (+Tulip) / `Central 1-2` (all-Tattu). A preview panel shows each group's ordered stops with per-stop **section override**; **Create** builds each merged mission directly in MBT via `saveApp` (ordered concatenation of the solos' bodies wrapped in one takeoff/return — verified faithful to Percepto's official merge) and refreshes the list — no admin-page paste. Dev-only (latest/).

---

## 2026-06-22 — Map Styler **PROMOTED TO PROD v34.77** — Asset Shielding Check + Color assets by state

Map Styler goes from prod v34.70 → **v34.77** for everyone. Two features that were dev-only reach coworkers, both **additive and off-by-default**, so nothing changes unless you opt in:

- **Asset Shielding Check** — a new on-demand validator (its own Control Panel section, beside the FFZ/FP Coverage Validator) that flags **assets too far from any power line to shield**. An asset is "shielded" if its centroid is within *power-line radius + asset radius* (default **200 + 200 = 400 ft**, both editable) of a power-line KML; failures get a high-contrast pin (pickable color) + coverage ring, with each asset's nearest-line distance logged for calibration. **Skips assets Percepto already marks Unshielded** (toggle, on by default). Built to find the assets the SS Generator needs to build FFZs on.
- **Color assets by state** — opt-in toggle that recolors each asset box by health (Normal / Empty / Unshielded / Unreachable / HY / Inactive) with full per-state styling controls.

Promoted as one file (drift-verified to differ from dev only in the 3 expected header lines).

---

## 2026-06-22 — Asset Inspector v4.3 (PROD) — fix: right-click subtype edits vanished when you opened the Summary

If you right-clicked an asset, edited its **Subtype**, and saw the "Queued: …" toast, then opened the **Summary** panel to apply it — the change was silently gone (no Apply button, no pending highlight). The popup-only edit never registered which site it belonged to, so the Summary's site-change guard treated the queue as stale and cleared it on open. Now the queue records its site the moment any edit is added, so popup edits survive until you open SUM and hit **▶ Apply queue**. Surgical fix backported to prod ahead of the larger dev bundle.

---

## 2026-06-22 — Asset Inspector v4.87 (dev/latest) — fix: right-click subtype edits vanished when you opened the Summary

Editing an asset's **Subtype** from the right-click inspector popup queued the change (you saw the "Queued: …" toast), but opening the **Summary** panel to apply it silently wiped the queue — so there was no Apply button and the change never showed. Cause: a popup-only edit never "claimed" the queue for the current site, so the Summary's site-change guard treated the queue as stale and cleared it on the way in. Now the queue claims the site the moment any edit is added, so popup edits survive until you open SUM and hit **▶ Apply queue**. Dev-only (latest/).

---

## 2026-06-22 — Map Styler v34.77 (dev/latest) — Asset Shielding Check skips already-Unshielded assets

The asset check now cross-references each asset's Percepto state: if it's **already marked Unshielded** (the `is_unshielded` flag or "… - Unshielded" in its subtype), there's no point geometrically re-flagging it, so it's **skipped** by default. New **Skip already-Unshielded assets** toggle (on) to turn that off. The console run marks skipped assets with a ⊘ and reports the skip count; pins now only highlight assets that are *geometrically* far from a power line but *not* already known-unshielded — i.e. the ones the SS Generator actually needs to act on. Dev-only (latest/).

---

## 2026-06-22 — Map Styler v34.76 (dev/latest) — Asset Shielding Check pin contrast + color control

Asset pins were hard to see (orange washed out on tan well-pads). Now they default to a high-contrast **deep pink** with a **dark outline**, render **larger**, and the coverage ring is bolder. New **Pin / ring color** picker in the Asset Shielding Check panel lets you set any color; the pin number auto-switches black/white so it stays legible on whatever you pick. (v34.75: each run also logs every asset's nearest-power-line distance, sorted, for threshold calibration.) Dev-only (latest/).

---

## 2026-06-22 — Map Styler v34.74 (dev/latest) — new **Asset Shielding Check** (finds Unshielded assets)

A second, independent validator alongside the FFZ/FP **Coverage Validator**. Where that one checks flight paths/FFZs against power lines, this one checks **assets**: an asset is **shielded** if its centroid sits within **power-line radius + asset radius** of any power-line KML (default **200 + 200 = 400 ft**, both editable in the panel). Assets beyond that get an **orange pin** labeled 1, 2, 3… with a 400 ft coverage circle and the nearest-line distance logged to the console — so you can see at a glance which assets the **SS Generator** needs to build FFZs on. Power-line KMLs are the only shielding source. Lives in its own **Asset Shielding Check** Control Panel section (Run / Clear / show-dismissed); click a pin to dismiss after confirming. Fully independent of the Coverage Validator (separate pins, separate run/clear) and works whether or not "color assets by state" is on. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.47 (dev/latest) — generator refreshes the mission list live (no reload)

After ⊕ Generate / ▣ Generate All, the sidebar mission list now updates **in place** — new missions appear immediately, no page reload. It calls Percepto's own list-loader (the zero-arg refetch that re-pulls `/available_app/`). Generator-only (which is locked off for coworkers), so effectively dev-only. Falls back to the old "reload to see them" message if the loader can't be found.

---

## 2026-06-22 — Mission Bank Tools **PROMOTED TO PROD v1.46** — first real coworker release

Mission Bank Tools goes live for everyone (coworkers jump **v0.51 → v1.46** at next Tampermonkey check). The whole dev arc reaches coworkers in one shot: the **SUM panel** (right-click step inspector, full step table with search/filter/sort/export), **inline altitude batch editing** with DEM elevation + **AGL view toggle**, the **Mission SOP checker**, **KML export** (flight path + N#/S# pins), **auto-AGL on save**, **➕ Stage steps**, **Shift+S** step-save, and **click-a-marker to save & switch steps**. The **Mission Generator** (⊕ Generate / ▣ Generate All — the only tool that *creates* missions) ships **locked off by default** and stays dev-only until a coworker trial; nobody sees or can trigger it. Verified zero content drift between dev and prod before promoting (only the 3 standard header lines differ).

---

## 2026-06-22 — Mission Bank Tools v1.46 (dev/latest) — Mission Generator locked off by default (pre-promotion)

Ahead of pushing Mission Bank Tools live, the **Mission Generator** (⊕ Generate / ▣ Generate All — the only tool that *creates* real missions on a site) is now **locked off by default for everyone**: the buttons don't appear and the generate actions no-op unless an install explicitly unlocks it. Everything else (SUM panel, inspector, altitude editing, SOP check, KML export, auto-AGL, ➕ Stage, click-marker step-switch) is unaffected. Unlock on your own install from the Mission Bank iframe console: `__aimMBGenerator(true)` (persists), `__aimMBGenerator(false)` to re-lock, `__aimMBGenerator()` to check. Dev-only (latest/).

---

## 2026-06-22 — Mission Bank Tools v1.45 (dev/latest) — click a marker to save & switch steps (the native way)

Finetuning steps now works the way you'd expect: while editing a step, **click a different step's marker on the map** and it **saves the current step (Shift+S) and opens the clicked one** — no buttons. Crucially it **blocks Percepto's native "move the open step to where you clicked"**, which was sliding snapshots to the wrong spot. Clicking the marker of the step you're already editing stays fully native (drag to reposition); with no editor open, a marker click just opens that step. Nothing auto-saves on reload/close — only switching steps commits (and only the in-session step draft, not the server). The on-step **Save ⏭** button from v1.44 is gone; the **Shift+D** hotkey (save + advance to the next step in order) stays as an optional shortcut. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.34 (dev/latest) — "Stage steps" (add N navs + M snaps to a mission) + bulk skips existing

New **➕ Stage** button in the mission editor: say how many **Navigates** and **Snapshots** you want (with optional inspection-scan wrap), and it adds them to the open mission, **placed next to the existing ones** so you can drag each into position. Navigates keep "Based on FFZ min alt"; snapshots auto-set their elevation on drop if 📷 Auto-AGL is armed — much faster than hand-adding steps. Also: the bulk **Generate All** now **skips assets that already have a mission** (split into to-create / already-have / skip-state). Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.32 (dev/latest) — Generator: bulk "Generate All"

With the ⊕ Generate overlay on, a **▣ Generate All** button opens a panel listing every **valid** asset (Empty/Unreachable/Unshielded skipped + shown separately), each with its mission name + nav/snap preview and a checkbox. Toggle **Inspection scan** for the whole batch, pick which to include, and **⊕ Create** generates them all in one go (sequential `saveApp`, progress readout, server-routed). Reuses the same per-asset build as the single-asset path. Dev-only (latest/) — test on a TEST site.

---

## 2026-06-21 — Mission Bank Tools v1.29 (dev/latest) — Generator: nav nudged inside FFZ + skip-state coloring

Two refinements to the Mission Generator. The generated **Navigate** is now nudged **~1 m inside the FFZ edge** (it was landing right on the boundary, where Percepto could read it as *outside* the FFZ — which the SOP checker flags). And the overlay now reflects **skip-state**: assets that are Unreachable / Unshielded / Empty draw **red**, valid ones white; the right-click popup warns if an asset is in a skip-state (you can still generate it manually). This is the predicate the upcoming bulk "generate all" will use to auto-skip bad-state assets.

---

## 2026-06-21 — Mission Bank Tools v1.26 (dev/latest) — Mission Generator, Increment 2 (actually creates the mission)

Right-clicking an asset on the Mission Bank map now opens a small **⊕ Generate mission** popup (preview + an **Inspection scan** checkbox), and **Generate** actually builds and creates the mission via the editor's own `saveApp` — then opens it so you can nudge the points. The mission is named **`<section> - <asset>`** (N/E/S/W from the base station) and contains takeoff → Navigate (in the FFZ, "Based on FFZ min alt") → Snapshot (asset center, ground + your AGL) → optional Thermal/GEM/Wait wrap → returnHome — the server computes the flight route. Built as a reusable per-asset function so the future "generate all assets" batch drops on top. Test on a TEST site first. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.23 (dev/latest) — Mission Generator, Increment 1 (asset overlay + scan preview)

First slice of the Mission Generator. A **⊕ Generate** button on the Mission Bank map draws the site's **assets (white) + FFZs (green)**; **right-click an asset** to preview its generated scan — the drone **Navigate** point (closest safe spot inside the FFZ at ~100 ft from the asset, at FFZ-min-alt) and the **Snapshot** point (asset centroid at ground + your default AGL), drawn as a blue→pink line with the standoff distance in a toast. **No mission is written yet** — this proves the data, drawing, hit-testing, and geometry before the save step (Increment 2). Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.18 (dev/latest) — AGL/MSL toggle on the compact cards

Each Navigate/Snapshot step in the compact editor list now shows its altitude as **AGL** (height above ground) by default, with a **📐 AGL / 📏 MSL** toggle in the editor button row to swap back and forth (AGL reads naturally; flip to MSL to verify the stored value). The label carries the unit suffix so it's never ambiguous. AGL uses each step's DEM ground; while the elevation loads it briefly shows MSL, then flips to AGL. Preference is remembered. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.17 (dev/latest) — LIVE snapshot auto-AGL on move + live editor sync

The snapshot auto-AGL is now **live**: with the **📷 Auto-AGL** toggle ON, the moment you drag a snapshot to a new spot the editor sets its altitude to that point's **DEM ground + your default AGL** — no save needed, you see it immediately (it writes Percepto's own editor state via the mission editor's `updateInstruction`). It only touches snapshots you **move after arming** (existing/flare snapshots are left alone), and the on-save pass still backstops everything. Also fixes the **stale-altitude / vanishing-badge** lag: MBT now mirrors the live editor state every ~0.7 s, so the compact card altitudes and the N#/S# map badges update right after a native step edit or drag (instead of waiting for a full mission save), and the badge lat/lng match no longer breaks after a drag. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.16 (dev/latest) — re-stamp N#/S# badges on editor mutations

(see commit) Percepto re-renders a step's marker after a per-step save, wiping the injected N#/S# number; MBT now re-stamps badges on editor mutations so the number returns promptly instead of waiting for the next pass.

---

## 2026-06-21 — Mission Bank Tools v1.15 (dev/latest) — Snapshot auto-AGL on save (safety-gated)

Replaces the v1.14 manual button with an automatic, opt-in behavior: a **📷 Auto-AGL** toggle in the native-editor button row. While it's **ON**, every mission save re-sets all snapshots to their **DEM ground + a default AGL** (so snapshots you drag can't end up underground) — using each snapshot's current coordinates straight from the save body. **Safety:** it's OFF by default and **resets to OFF every time you (re)enter the Mission Bank**, so you have to arm it deliberately; turning it on shows a warning toast and a bright **on-map banner** while armed. Turn it OFF for the occasional elevated target (e.g. a flare-stack snapshot). The default AGL is set in the Control Panel ("Default snapshot AGL", default 10 ft). Out-of-range snapshots are still flagged by the Mission SOP checker. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.13 (dev/latest) — KML routed path rides at altitude

The captured flight path is 2D, so it was snapping to the ground. Each route vertex now takes the altitude of the nearest navigate (and switches to `absolute` altitude mode), so the white line rides up with the nav pins instead of lying on the terrain. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.12 (dev/latest) — KML uses AIM's real routed path + site name in title

The KML's flight path is now the **actual routed line from AIM** — Percepto's white dashed route that follows the flight paths / FFZs (base → each step → back), captured off the map and converted to lat/lng — instead of a straight nav→nav line. Falls back to the straight line (and says so in the toast) when the routed line can't be read (e.g. exporting from the SUM drill-down). The KML **title now includes the site**: `Site 1502 - <site name> - <mission name>`. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.11 (dev/latest) — KML colors + true flight path + standoff distances

Refined the KML export: pins + labels now use your **AIM step colors** (blue Navigate / pink Snapshot, following whatever you pick in the Control Panel). Split the path geometry so it's accurate: a **white line** connects nav→nav (the real flight path) and separate **purple sightlines** run from each Navigate to its snapshots (what it's looking at) — no more nav→snap→nav zigzag. Each sightline is labeled with the **nav↔snapshot standoff distance** (e.g. `N2→S2 · 104 ft`) so you can confirm the ~100 ft target, and the distance also shows in the Navigate and Snapshot pin descriptions. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.10 (dev/latest) — richer KML export

Mission KML export is now a full flight-path file instead of loose pins. Adds: a **flight-path LineString** through the navigate+snapshot points in order (3D, at altitude); **N#/S# order labels** on the pins (matching the map badges); and **per-stop step detail in each pin's description** — click a Navigate pin in Google Earth and it lists the stop's altitude/speed plus its bundled snapshots and their Thermal/GEM/Wait scan steps; snapshot pins list their own scan steps. Also added a **⬇ KML button on the native-editor row** (next to 🔄) so you can export the open mission directly (uses the live on-screen order, so an unsaved reorder still exports correctly) — the SUM drill-down's Export KML button uses the same builder. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.08 (dev/latest) — dead-code cleanup (no behavior change)

Removed the retired floating-Composer panel and the old separate-badge map path now that map-editing (in-place native-marker badges) is the workflow. Deleted `renderComposer`/`openComposer`/`closeComposer`/`composerGroup`/`composerMoveRow` and the `composerDrawBadges`/`composerBadgeIcon`/`composerClearBadges`/`composerBadgeLayer` cluster plus their unused state (`composerSel`, `composerRows`, `COMPOSER_PANEL_ID`, `COMPOSER_MAPMODE_KEY`). ~200 lines lighter; the live reorder + marker-styling path is unchanged. Dev-only (latest/).

---

## 2026-06-21 — Mission Bank Tools v1.04–v1.07 (dev/latest) — customizable per-step colors

The compact-card text in the native mission editor and the on-map N#/S# order badges now read their colors from a new **Step colors** section in the Control Panel (under Mission Bank Tools). Pick any color for Navigate, Snapshot, Thermal On/Off, GEM On/Off, and Wait — changes apply live to the editor cards, the map badges, and the reorder popup. One color per type, stored per user. Dev-only (latest/); not promoted.

---

## 2026-06-20 — AIM Issues PROMOTED to PROD v1.24 — Slack notifications + assignees + stale-bump go live for everyone

Coworkers jump **v1.01 → v1.24** on the next Tampermonkey check — the entire Slack-notifications arc that was dev-only is now in prod. What's now reaching everyone: issues post to **#CSM-Site-Issues** (parent = live status board, thread = history), `@`-mention picker, **assignee** field (popup + panel + filter + Sheets export), clickable deep-links that focus the issue on the map, comment tagging, validator findings with per-issue Slack opt-in (off by default), and **weekly stale-issue auto-bump**. The new **global cross-site stale sweep** (bumps stale issues across all sites without opening each one, and shows real site names) ships too but is **approver-gated** — only approvers run it. Requires `slack-config.json` + `approvers.json` in the data repo (already present). No prod-only code was overwritten (verified zero drift beyond the 3 allowed header lines).

---

## 2026-06-20 — AIM Issues — fix existing "site ID" boards on next sweep — AIM Issues v1.24 (dev/latest only)

v1.23's board-refresh was sitting behind the "bumped within 7 days" guard, so the boards already posted with an ID wouldn't have corrected for a week. Moved the name reconciliation ahead of the bump gate (once per browser session) so the existing "site 1595" boards update to the real name on the very next sweep — no need to delete and re-run. chat.update is silent and idempotent, so already-correct boards are untouched.

---

## 2026-06-20 — AIM Issues — global sweep shows site NAMES, not IDs — AIM Issues v1.23 (dev/latest only)

Follow-up to v1.22: the global sweep posts/adopts issues for sites it never opens, so it had no friendly site name and Slack showed "site 1595" instead of the name. Fixed — the sweep now pulls every site's name from Percepto's own `/sites/` endpoint (one same-origin request per sweep) and threads it through. Also refreshes any parent board that was already posted with an ID so it corrects to the name on the next sweep.

---

## 2026-06-20 — AIM Issues — stale-bump works without opening a site — AIM Issues v1.22 (dev/latest only)

The weekly stale-issue auto-bump (open/pending >7 days → ping assignee + approvers) used to only fire for the **one site you had open** — it lived in the map iframe and only ever scanned that site's issues. Now there's a **global cross-site sweep** that runs in the top frame (which exists everywhere, even the landing page with no site open). It lists every site's issue file on GitHub, finds stale issues across **all** sites, and bumps them — no need to navigate into each site. Approver-gated (so every CSM's browser isn't sweeping every site); the currently-open site is left to the existing iframe path; same 7-day dedup window, so a bump another browser already posted this week is skipped. Kicks ~30s after load, then hourly.

---

## 2026-06-20 — Mission Bank Tools — map reorder works + auto-refresh — Mission Bank Tools v0.92 (dev/latest only)

Editing a Navigate badge to renumber a stop now actually reorders and persists. The bug was that Percepto's `reorderInstructions` is a fresh function on every render, so reusing one across a multi-step group move ran every move against the original order (scrambling/crashing the editor) — now it re-fetches before each move. Also: the Composer **auto-refetches** the mission when the cache is stale (you added/edited steps), and there's a **🔄** button in the Composer header to force a resync — so you no longer have to open the SUM first. The diagnostic 🧪 probe was removed.

---

## 2026-06-20 — Mission Bank Tools — map-editing UX + compact card view — Mission Bank Tools v0.94–v0.98 (dev/latest only)

The mission editor got a big workflow upgrade:

- **Edit on the map.** Percepto's own navigate/snapshot markers are recolored in place — blue **N#**, pink **S#** — same spot/size. **Right-click** a badge to renumber/reorder (snapshots follow their navigate); **left-click** opens that step's Edit form. No floating panel, no toggle; a **🔄 Resync** button covers cache refreshes. (Needs Asset Inspector v4.85, which now ignores right-clicks on mission markers so it doesn't double-pop.)
- **Compact card view** (replaces the old max-height collapse): each instruction card is one line with the key value on the right — Navigate/Snapshot show altitude (blue/pink), Wait shows "10s", and Camera Type / GEM Mode are renamed to **Thermal On/Off** (orange) and **GEM On/Off** (green). Native drag-drop stays intact. Toggle in the sidebar.
- Reorder no longer flashes the original icons (color is now CSS-driven).

---

## 2026-06-20 — Mission Bank Tools — editable Navigate order badges — Mission Bank Tools v0.87 (dev/latest only)

The blue **N#** badges on the map are now **editable**: click one, type a new number, and that whole stop — the navigate plus its snapshots and scan steps — moves to that position, cascading everyone else's numbers. Snapshots auto-follow (you only edit one number). It drives Percepto's reorder via single-step group swaps, so the native list reorders live; then hit SAVE. Snapshot **S#** badges are display-only for now (editable next). The list ▲▼ arrows still work too.

---

## 2026-06-20 — Mission Bank Tools — Composer map order badges — Mission Bank Tools v0.86 (dev/latest only)

Reordering from a list was hard to follow, so the Composer now puts **order-number badges on the map** (the real source of truth for flight order): each **Navigate** gets a blue **N1, N2…** badge and each **Snapshot** a pink **S1, S2…** badge, numbered in flight order, drawn at each instruction's location as real Leaflet markers (so they ride zoom/pan and re-number after a reorder). Display-only this version — next, click a Navigate badge to retype its number and have the whole stop (snapshot + scan steps) move there, cascading the rest. Ports the Map Styler's Leaflet-map access.

---

## 2026-06-20 — Mission Bank Tools — Composer block reorder — Mission Bank Tools v0.85 (dev/latest only)

Composer Increment 2: **move a whole inspection block** (a Snapshot + its 5 Thermal/GEM/Wait steps) or a Navigate **as a unit** with ▲▼ buttons on each row. It drives Percepto's own `reorderInstructions` (ported from the Quick Mission Editor — fiber walk + completion wait), so the native list reorders live; then you hit the editor's **SAVE** to persist. Arrows disable at the real ends. (v0.84: docked the Composer to the right edge, locked, so it sits beside the left native editor.) Bulk param edit + GPS-pick are the next increments.

---

## 2026-06-20 — Mission Bank Tools — Mission Composer (Increment 1: grouped view) — Mission Bank Tools v0.83 (dev/latest only)

First piece of the Mission Composer — a better editor that groups the redundant steps and (next) lets you reorder/bulk-edit them. A "🧩 Composer" button in Percepto's editor sidebar opens a docked panel that identifies your open mission (by matching the on-screen instruction-card ids to the cached mission — no fiber, no guessing) and shows it as **inspection blocks**: Navigate rows and Snapshot blocks (each snapshot + its Thermal/GEM/Wait steps as one unit), with multi-select checkboxes. Read-only for now; block **reorder** (move a snapshot + its 5 steps together), **bulk param edit**, and **GPS pick-on-map** build on this next. No mission-save capture needed — the write paths (reorderInstructions + the POST body-splice) already exist in the codebase.

---

## 2026-06-19 — Mission Bank Tools — collapse the Thermal card too + sidebar toggle — Mission Bank Tools v0.82 (dev/latest only)

Two fixes to the native-editor collapse: (1) the Thermal card was the only one not collapsing because its title is "Camera **type**" (lowercase t) and the match was case-sensitive — now case-insensitive, so all three collapse. (2) Added a **collapse/expand toggle button right in Percepto's editor sidebar** (next to "Add instruction") so you can flip it without opening the Control Panel; its label reflects the current state and stays in sync with the Control Panel toggle.

---

## 2026-06-19 — Mission Bank Tools — fix native-editor collapse (match by title) — Mission Bank Tools v0.81 (dev/latest only)

The v0.80 native-editor collapse no-op'd because it keyed off the mission id in the URL, which Percepto's editor doesn't expose. Switched to matching the redundant cards by their visible title text (Camera Type / GEM Mode / Wait) — no mission-id needed — and added a one-time diagnostic log of the card structure so any remaining selector/height tuning is quick. Same toggle + capped-height collapse as before.

---

## 2026-06-19 — Mission Bank Tools — collapse redundant cards in Percepto's editor — Mission Bank Tools v0.80 (dev/latest only)

The redundant Camera Type / GEM Mode / Wait cards in Percepto's **own** mission editor (the 100+-instruction left list) now collapse to thin one-line rows, so the editor is actually scannable. Toggle: Control Panel → Mission Bank Tools → "Collapse scan-block cards in the native editor" (on by default). The cards are matched by instruction id → type (from the open mission) and capped in height — kept in the DOM with a real box so drag-reorder isn't disturbed. A MutationObserver re-applies it as the list mounts/scrolls.

---

## 2026-06-19 — Mission Bank Tools — hide all redundant map markers — Mission Bank Tools v0.79 (dev/latest only)

The "Hide scan-block map icons" toggle now hides **all three** redundant marker types — GEM (`gem-mode`), Thermal (`camera-type`), and Wait (`wait`) — so the Mission Bank map shows only Navigate + Snapshot. (v0.78 only had the confirmed GEM filename; the Thermal + Wait filenames are now confirmed from the live DOM and safe — the Snapshot icon is a different camera file.)

---

## 2026-06-19 — Mission Bank Tools — declutter redundant scan-block steps — Mission Bank Tools v0.78 (dev/latest only)

The Thermal-on / GEM-on / Wait / GEM-off / Thermal-off block that every snapshot needs but that clogs the editor and map is now collapsible:

- **Editor:** a "Collapse scan blocks" toggle (on by default) in the mission detail view replaces each snapshot's 5 redundant rows with one compact summary row (🔥 Scan block · Thermal · GEM · Wait, with a ✓/⚠ on whether it's the canonical block). Data is untouched — pure view filter; turn it off to see every step.
- **Map:** a "Hide scan-block map icons" Control Panel toggle (on by default) hides the redundant GEM/Thermal/Wait markers on the Mission Bank map (CSS `:has()` so it survives Leaflet redraws), keeping only Navigate + Snapshot. Currently hides the confirmed GEM icon; the Thermal + Wait icon names are being captured from the live map (logged to console) so they can be added without risking the Snapshot/camera icon.

---

## 2026-06-19 — Mission Bank Tools — green SUM button + snap-docking + Mission SOP Validators — Mission Bank Tools v0.77 (dev/latest only)

Three additions to the dev build of Mission Bank Tools:

- **Snap-docking on the SUM panel** — ported from the Site Setup SUM so the two behave identically. Header now carries ◧ ◨ ⬓ ❐ buttons to dock the panel to the **left / right / bottom of the map** or float/restore. Position, size, and dock state persist across opens; dragging the header un-docks; a docked panel re-fits when the window/sidebar resizes.

- **SUM button + panel header** rebuilt to match the Site Setup SUM button exactly: neon green (#39ff14) fill, **black label**, pulse-glow, full label **"Mission Bank Summary"** (was a teal "SUM"). Black text is forced with inline `!important` (Percepto's white `-webkit-text-fill-color` beat a CSS-rule override). The panel header reads "Mission Bank Summary", left-justified (room on the right for the upcoming generator button). The "📋 LOG SUM" launcher stays cyan to keep the execution-log summary visually distinct.
- **Mission SOP Validators** — a new Control Panel section ("Mission SOP", scope Mission Bank) with a **site-type preset** selector (OIL · Upstream / OIL · Downstream / T&D), per-check enables + editable thresholds, and a **🚩 Run SOP check** button that lists every violation in a floating report (click a mission to open it). Five checks: Navigate inside an FFZ, Navigate ≥ FFZ floor, Snapshot ≥ min AGL (0 ft default), scan-block balance (one Thermal/GEM/Wait set per snapshot), and Navigate↔Snapshot distance (96–204 ft, Upstream). Upstream ships the live numbers; the other presets inherit them (editable) until their SOPs are defined. Existing bulk altitude editing is unchanged.

---

## 2026-06-18 — Flight Path Editor → renamed "AIM Map Editor" — Map Editor v0.46

Renamed the script: it started as a flight-path tool but now also edits FFZ altitudes and carries the AGL view, so "Flight Path Editor" was misleading. Now **AIM Map Editor** (file `AIM_Map_Editor.user.js`). Settings + Control Panel customizations carry over (internal ids unchanged); the Control Panel entry now reads "Map Editor". Since it's a dev/personal script, the old install just needs a one-time uninstall + reinstall of the renamed one. No behavior change.

---

## 2026-06-18 — Flight Path Editor — AGL view now works on FFZs too — Flight Path Editor v0.45

The AGL view now appears when you open a **free-fly zone** natively, not just flight paths. Same panel over the native form, same Shift+G toggle, same color-coded AGL / Δ / MSL columns that live-link and write behind the scenes — but a single altitude band (the FFZ's restrictions) instead of per-segment, using the max ground under the zone's polygon. FFZ altitudes allow decimals, so there's no whole-metre snap on these.

---

## 2026-06-18 — Flight Path Editor — AGL editing actually works now (id type bug) — Flight Path Editor v0.44

Editing a band did nothing (no message, value snapped back) because the working-copy lookup compared the flight-path id as a number against the same id read from a DOM attribute as a string — so it never matched and the edit was silently dropped. Coerced both sides; AGL/Δ/MSL edits (and the live cross-update) now commit to the path as intended.

---

## 2026-06-18 — Flight Path Editor — AGL view: color coding, aligned columns, edit feedback — Flight Path Editor v0.43

The AGL/Δ/MSL columns are now **color-coded** (AGL blue, Δ yellow, MSL orange — titles and boxes) and the **headers line up** with the input boxes (fixed table layout). Editing now gives clear feedback: a small change that's below the **whole-metre storage step** (~3 ft) tells you it snapped back (try ≥3 ft), and a successful edit confirms the stored band — so "it reverted" is never silent. Tooltip AGL also falls back to the nearest segment's ground so it shows up reliably.

---

## 2026-06-18 — Flight Path Editor — AGL edits actually stick + tooltip polish — Flight Path Editor v0.41

Fixes from testing: (1) **editing now sticks** — a band edit was reverting because changing one segment broke the altitude overlap connected segments require; it now auto-bridges the neighbour (raises only its ceiling to reconnect, the same fix smart-altitude uses), so your value holds. (2) **hover tooltip** — no more duplicate AGL line (only the outermost match is augmented), and the **AGL line is now on top and larger** with Percepto's MSL kept smaller below.

---

## 2026-06-18 — Flight Path Editor — AGL view: AGL/Δ/MSL all editable + live-linked, loads every segment — Flight Path Editor v0.40

Round of AGL-view improvements: (1) every segment's ground now **loads top-to-bottom** without scrolling the native list (the per-segment terrain sampling was way too heavy — capped it, so a long path actually finishes); (2) each row now shows **AGL min, AGL max, Δ, MSL min, MSL max — all editable**, and they **cross-update live as you type** (change the AGL and the MSL/Δ move with it, no save needed; it commits to the live path on blur); (3) a **best-effort AGL on Percepto's own hover tooltip** — when you hover an FFZ/FP line and Percepto shows "ALT(ft) … MSL", we append "≈ X – Y ft AGL" (MSL sites only; matched by content since it's Percepto's tooltip, not ours).

---

## 2026-06-18 — Flight Path Editor — AGL view sits over the native form + looks native — Flight Path Editor v0.39

The AGL view now positions itself **exactly over Percepto's native entity form** (`.upsert-entity__form`) and is restyled to match the site-setup sidebar (flush dark panel, native labels, Ant-style inputs, a "Path sections — AGL ft" heading) so it reads as the native panel rather than a floating box. SAVE/Cancel sit outside the form, so they stay visible/clickable. Shift+G / the "MSL view" button flips back to the native MSL display.

---

## 2026-06-18 — Flight Path Editor — AGL view now covers the native sidebar + loads every segment — Flight Path Editor v0.38

Two fixes to the new AGL view: (1) it now **covers the native FP sidebar** (overlays it, ending just above the SAVE/Cancel bar so those stay clickable) instead of stacking on top of it with two scrollbars; (2) it **loads the ground for every segment**, not just the ones visible in the native list — a rate-limited terrain lookup was getting cached as "no data" and freezing the lower rows on "ground…". Now it retries until quota recovers, fills top-to-bottom on its own (with a "loading ground N/M…" note), and backs off when the quota is paused. Shift+G still flips back to the native MSL view.

---

## 2026-06-18 — Flight Path Editor — AGL view for MSL sites (see + type altitudes as AGL) — Flight Path Editor v0.37

On a Mountain-terrain (MSL) site the native Min/Max altitude fields show absolute MSL (e.g. 2685 ft), which makes it hard to tell your real clearance. New **▲ AGL view** HUD docks beside the editor and shows each flight-path segment's band as **AGL** (= MSL − the max ground under that segment) with the MSL right next to it for verification — and you can **type the band in AGL** and it writes the MSL behind the scenes (backend stays MSL, same safe live-edit path, auto-reverts if it would break the path). Toggle with **Shift+G**, the HUD's "MSL only" button, or the Control Panel — so you can flip back to confirm the MSL values any time. On AGL sites the stored value already is AGL, shown directly with the MSL for reference. (First surface; the SUM panel, FFZ editor, and generator tooltips get the same AGL view next.)

---

## 2026-06-18 — Flight Path Editor — Smart Altitude no longer clobbers AGL-site flight paths (latest/ dev only) — Flight Path Editor v0.36

On a non-mountain (AGL) site, moving a flight-path vertex was auto-rewriting that segment's altitude to a ground+100 ft **MSL** value — e.g. a correct **167 ft** band jumped to **~965 ft AGL**. Smart Altitude is terrain-following, which only applies to **Mountain-terrain (MSL)** sites; on AGL sites the stored value is already height-above-ground, so a lateral move must not touch it. The editor now reads the site's Mountain-terrain flag: on AGL sites it **preserves an existing band** on a move and only applies a flat raw-AGL band (floor / floor+band, no ground, no terrain steps) to genuinely new segments; on MSL sites it's unchanged. If the flag can't be read, it leaves altitudes alone. (⛰ Smart-fill button still force-applies the configured band on purpose.)

---

## 2026-06-18 — Site Setup Generator — MSL vs AGL site awareness for FFZ altitudes (latest/ dev only) — Asset Inspector v4.84

The generator now knows whether a site stores altitudes as **absolute MSL** or **height-above-ground (AGL)** and writes the right reference — getting this wrong would put a drone thousands of feet off. It reads the site's **Mountain terrain** flag (`mountain_terrain`: on = MSL, off = AGL), shows the detected mode in an **Altitude reference** banner you can override, and converts accordingly: MSL sites store `DEM ground + AGL`, AGL sites store the raw AGL height (no ground). Generating, recompute-on-edit, and the FFZ tooltips are all mode-aware (tooltip shows "ft AGL" vs "ft MSL"). If the flag can't be read, altitude writes are blocked until you pick a mode. Confirmed against live sites 1502 (MSL) and 285 (AGL).

---

## 2026-06-18 — Site Setup Generator — editing an existing FFZ no longer rewrites its altitude unless asked (latest/ dev only) — Asset Inspector v4.83

Moving/resizing a loaded existing FFZ was silently re-applying the DEM AGL band on every drop. Now it **keeps the zone's saved altitude by default** — a new **"Recompute alt when I edit an existing FFZ"** checkbox (Altitude section) arms re-applying the AGL floor + delta on drop, using the numbers you type. Off by default so a move never changes altitude.

---

## 2026-06-17 — Site Setup Generator — EDIT existing FFZs with the generator's geometry (latest/ dev only, NOT promoted) — Asset Inspector v4.82

New **📥 Load site FFZs** button in the ⊕ Generate modal loads the site's existing FFZs (amber) into the same editable preview the generated drafts use — so an existing FFZ can be **moved (drag), rotated (Q/E), re-snapped to any pad edge auto-sized at the 15 ft standoff (Alt+drag), and resized (drag the yellow ends)**, exactly like a generated draft. Altitude auto-recomputes from DEM on every drop. **💾 Save FFZ edits** writes the changed zones back **in place** (id preserved — an update, not a new DRAFT): a rollback file downloads first, and any pilot-validated zone you moved prompts per-edit whether to reset its validated flag. Dev-only while the generator stays in `latest/`.

---

## 2026-06-16 — Control Panel — gear button gets the neon-green pulsing glow (PROD) — Control Panel v1.29

The ⚙ Controls button in the map toolbar now has the signature **neon-green pulsing glow** (same effect as the Site Setup Summary button), with a green gear icon — easier to spot in the toolbar. Respects reduced-motion.

---

## 2026-06-16 — Control Panel — search now filters to the matching CONTROLS (PROD) — Control Panel v1.28

Fixed search showing unrelated settings: it matched at the whole-tool level, so typing "Flight" surfaced all of Outlines (Assets and everything else) because the tool happened to contain a flight-path control. Now it **prunes to just the matching controls** — searching "Flight" shows only flight-path settings, with their category auto-expanded. Searching a tool or group name (e.g. "Outlines", "Power Lines") still shows that whole tool/group.

---

## 2026-06-16 — Control Panel — collapsible sub-sections + search (PROD) — Control Panel v1.27

Two ergonomics wins on top of the new grouping:
- **Collapsible sub-sections** — inside a group (e.g. Map Display), each tool is now its own collapsible row. Open a group and you get a tidy list of titles; click one (e.g. Outlines) to expand just it. No more a whole group dumping everything at once.
- **Search box** — type in the search field at the top to instantly filter to the settings you want; it matches section names, tool names, and individual toggle/hotkey labels, and auto-expands the matches. Clear with the ×.

*(Both apply to the whole panel; nothing about how the controls work changed.)*

---

## 2026-06-16 — Control Panel — reorganized into intuitive groups (Phase 1, PROD) — Control Panel v1.26

The ⚙ panel is now organized into clear, task-themed sections instead of scattering related controls: **Map Display** (outlines/buffers, performance, defaults, map nav) · **Power Lines** · **Site Setup** (the Site Setup Tools, validators, New Entity macro) · **Map Tools** (altitude, ruler, clear all) · **Missions** · **Issues**. Each control still works exactly as before — only where it *appears* changed — and sections still hide on pages they don't apply to. The whole layout is now driven by one central map in the Control Panel, so it's easy to keep tidy. *(Phase 2 will move the distro/trans line styling out of "Outlines" to sit with the Power Line Editor under "Power Lines.")*

---

## 2026-06-16 — Power Line Editor — convert + merge **promoted to PROD** — Power Line Editor v0.15 · Map Styler v34.70

The ⇄ Convert and ⛓ Merge tools (below) are now in **prod** — coworkers on the Power Line Editor get them on the next Tampermonkey check. **Only** these two features shipped: the dev-only "color/hide assets by state" Map Styler work stays in `latest/`. Prod Power Line Editor jumps v0.14 → v0.15, prod Map Styler v34.69 → v34.70.

(Note for maintainers: prod Map Styler v34.70 = convert/merge only. The `latest/` v34.70–34.72 are a *different* set of changes — color-assets-by-state — still dev-only. The two version histories are independent installs.)

---

## 2026-06-16 — Power Line Editor — convert distro↔trans + merge segments (dev/latest) — PLE v0.15 · Map Styler v34.73

Two new tools in the ⚡ Power Lines strip (dev-only, not promoted):
- **⇄ Convert mode** — arm it, then M1 a power line to flip it to the OTHER type (a distribution line becomes transmission, or vice versa). Under the hood it's a delete on the source file + an add on the target file, so the ✓ commit pushes both. If the target type has no KML yet, one is created on commit.
- **⛓ Merge mode** — arm it, then M1 connected file segments to select them (they light up magenta). Click **⛓✓** to stitch them into a single line. They must join end-to-end — if there's a gap or a branch, it refuses and tells you. This is the inverse of the existing “Split multi-segment lines” button: combine a run of short segments back into one editable polyline.

The 🗑/⇄/⛓ modes are mutually exclusive (one armed at a time); with none armed, M1 a line still enters vertex edit as before.

The script formerly shown as **Asset Inspector** (and originally “Copy Asset Name”) is now called **AIM Site Setup Tools** — a better fit now that it does inspection, the site-wide SUM panel, bulk edits, the KML analyzer, and SOP validators. **No reinstall needed:** it's a display-name change only (`@name:en`), so Tampermonkey keeps auto-updating your existing install — you'll just see the new name in your dashboard, the Control Panel, the panel title, and the button tooltip on the next update. Same hotkeys, same settings, same everything.

---

## 2026-06-16 — Asset Inspector — Summary panel fixes for everyone (PROD) — Asset Inspector v4.1

Backported three self-contained Summary-panel fixes from the dev line to **prod** so coworkers get them now:
- **Row hover no longer gets stuck** — hovering the table used to leave several rows highlighted (especially while elevations were loading); fixed.
- **Resize from any edge or corner** — not just the bottom-right grip. Dragging the left/top edge resizes inward instead of sliding the panel.
- **Panel stays fully on-screen** when you drag it — it could previously slide off the right/bottom edge leaving only a sliver.

Update via Tampermonkey dashboard → *Check for userscript updates*. *(Snap-to-dock buttons, reload-persistence, and the button restyle stay on the dev line for now.)*

---

## 2026-06-16 — Asset Inspector — fix stuck row-hover highlights in the Summary table (dev-only) — Asset Inspector v4.80

Fixed the Summary table leaving **multiple rows stuck highlighted** when hovering. Row hover was per-row JS `mouseenter`/`mouseleave`; when the table redrew mid-hover (e.g. while DEM elevations stream in) the `mouseleave` never fired on the replaced row, stranding the highlight. Hover is now **CSS `:hover`** (browser-managed, can't get stuck), with the frozen Name column getting the opaque hover tint via its `data-frozen-key`. *(Dev/latest only. The same bug exists in prod v4.0 — can backport if you want it out to coworkers now.)*

---

## 2026-06-16 — Asset Inspector — Summary panel: remember position/size/dock across reloads (dev-only) — Asset Inspector v4.79

The Site Setup Summary panel now **remembers its position, size, and dock across page reloads** (was reset every refresh). Saved on drag-end / resize-end / dock / float to Tampermonkey storage. A restored dock **re-fits the current map size** on open, and a restored floating position is clamped on-screen in case the window shrank since last session. *(Completes the panel-ergonomics batch: any-edge resize → on-screen clamp → snap docks → persistence. Dev/latest only.)*

---

## 2026-06-16 — Asset Inspector — Summary panel: snap-to-dock buttons (dev-only) — Asset Inspector v4.78

The Site Setup Summary header now has **dock buttons** — **◧ left**, **◨ right**, **⬓ bottom**, **❐ float/restore**. Click one to snap the panel to fill that edge of the **map** (it docks to the `.leaflet-container`, so it lines up with the imagery, not the sidebar): sides fill full map height at your current width (capped at 70%), bottom fills full width at ~45% height. Docked panels **re-fit automatically** when the window/sidebar resizes; dragging or resizing the panel pops it back to floating, and **❐** restores the pre-dock size/position. *(Next: persistence so dock + size survive reloads. Dev/latest only.)*

---

## 2026-06-16 — Asset Inspector — Summary panel: resize from any edge + keep fully on-screen (dev-only) — Asset Inspector v4.76–v4.77

The Site Setup Summary panel can now be **resized from any edge or corner**, not just the bottom-right grip. Dragging the left or top edge resizes inward (the opposite edge stays put) instead of sliding the panel. Same 480×300 min / 96vw×90vh max. **v4.77:** dragging now keeps the **whole** panel on-screen on every edge — it used to let the panel slide off the right/bottom leaving only a thin sliver (the top/left already locked). *(Panel-ergonomics batch — snap-to-side/bottom buttons + reload-persistence coming next. Dev/latest only.)*

---

## 2026-06-16 — Asset Inspector — SUM button restyle: "Site Setup Summary" neon-green pill (dev-only) — Asset Inspector v4.72–v4.75

With the old ALT/VAL buttons gone there's room to spell it out: the **SUM** button now reads **Site Setup Summary**, styled **neon green with black bold text** and a **subtle pulsing glow** (the same breathing box-shadow effect AIM Issues uses for unseen activity, recolored green; glow only, no bounce). Same click behavior. **v4.73–v4.74:** force the text truly black — Percepto sets the white text with `!important`, so plain `color` (even inline) lost; now set with an inline `!important` priority (`setProperty('-webkit-text-fill-color','#000','important')`), which is the strongest author declaration and wins. **v4.75:** center the button in its toolbar row (was left-aligned from when ALT/VAL sat beside it). *(Dev/latest only — ships to prod at the next Asset Inspector promotion.)*

---

## 2026-06-16 — Removed: AIM Bulk Altitude Updater (replaced by Asset Inspector's SUM bulk altitude tools)

**AIM Bulk Altitude Updater** (the `Shift+E` prep-pass → pause → final-pass altitude tool) has been **retired**. Its job is now done from the **Asset Inspector SUM panel** — **Bulk → AGL**, **Bulk → Delta**, **Bulk → Min**, **Bulk → Max** — which set altitudes across FP segments + FFZs from the live entity table with a preview, dry-run, rollback file, and per-write verify, via the fast Direct-API path. Those buttons already shipped to prod in Asset Inspector v4.0, so there's no gap. The script is removed from prod + `latest/` and from the install guides. **If you have it installed, remove "AIM Bulk Altitude Updater" from your Tampermonkey dashboard** — it won't auto-uninstall, and its `Shift+E` hotkey keeps working off the copy you already have until you do.

---

## 2026-06-16 — Removed: AIM Bulk Validator (replaced by Asset Inspector's SUM **Bulk → Valid**)

**AIM Bulk Validator** (the `VAL` toolbar button + `Shift+V` paste-a-list modal) has been **retired**. Its job — bulk validate/unvalidate FFZs + FPs — is now done from the **Asset Inspector SUM panel → Bulk → Valid**, which works off the live entity table (scope, type filter, preview) and saves via the fast Direct-API path instead of clicking through Percepto's editor one entity at a time. The script is removed from prod + `latest/` and from the install guides. **If you have it installed, remove "AIM Bulk Validator" from your Tampermonkey dashboard** — it won't auto-uninstall, and its `Shift+V` / `VAL` button keep working off the copy you already have until you do.

---

## 2026-06-16 — Asset Inspector — Direct-API apply: one-click Reload to sync the native view (dev-only) — Asset Inspector v4.71

The **⚡ Direct-API apply report** now offers a **🔄 Reload page** button + a note. Direct-API writes save to the server and the SUM table instantly, but Percepto's **native sidebar + map** render from their own React store, which only re-reads on a full page load — so the change didn't show in the native UI until you refreshed. The reload button does that in one click. Applies to every Direct-API bulk apply (AGL/Delta/Min/Max/Valid), not just validation. *(Dev/latest only.)*

---

## 2026-06-16 — Asset Inspector — Bulk → Valid: bulk pilot validation flag (dev-only) — Asset Inspector v4.70

New **Bulk → Valid** button in the SUM bulk row flips the **pilot Validation flag** (✓/✗) across every **FFZ + FP** in scope in one shot — the pilot's post-flight sign-off ("flew it, no airspace obstacles, cleared for autonomous flight"), so it's a plain manual ON/OFF, fully separate from the SOP Validators. Pick ✓ Valid / ✗ Invalid, scope (all or selected), and an FFZ/FP type filter; the preview counts how many will flip (already-correct entities are skipped). Rides the same **⚡ Direct-API** upsert as the altitude bulk tools — same rollback file, and the verify rail now confirms the server actually **persisted** the flag (fails loudly if not). Queued flips show the target in yellow in the Valid column until Apply. *(Requires ⚡ Direct API; the editor path can't toggle the flag. Dev/latest only.)*

---

## 2026-06-15 — AIM Issues — stale-issue auto-bump (dev-only) — AIM Issues v1.20

Issues that sit unresolved get a nudge: any issue in **open / pending fix / pending ignore / ready-for-review for more than 7 days** now posts a Slack bump pinging the **assignee + approvers**, re-bumping **weekly** until it's resolved/ignored. It runs **inside AIM Issues** (on site load + hourly while open), threads under the issue (adopting pre-Slack issues into a thread first), and records a `kind:'bump'` history entry so it never double-fires across browsers. Uses the GitHub token the browser already has — no extra setup. *(Dev/latest only. Replaces the planned cloud routine, which was blocked on cloud GitHub authorization.)*

---

## 2026-06-15 — Site Setup Generator — 🧲 CTRL-snap for native FP drawing (dev-only) — Asset Inspector v4.63

New **🧲 CTRL-snap** toggle: arm it, then draw flight paths with Percepto's **own** draw tool — **hold CTRL** while clicking a waypoint and it snaps ~50 ft parallel to the nearest power line (a purple dot shows where it'll land); **release CTRL** for a free point. Works by intercepting the map click and re-firing it at the snapped pixel into Percepto's native draw handler, so snapping happens inside the tool you already use. Finish the path with CTRL released. *(Dev/latest only; fragile by design — falls back to a normal click if anything misses.)*

## 2026-06-15 — Site Setup Generator — clean up natively-drawn FPs (dev-only) — Asset Inspector v4.62

Pivoted the flight-path workflow: **draw FPs natively in Percepto, then clean them up here**. New **📥 Load site FPs** button pulls the site's existing flight-path entities into the editable preview — out-of-band segments show **orange** immediately so you can see what's off the shielding band. Then **✨ Snap & Clean** snaps the whole network ~50 ft parallel to the power lines + simplifies (segs keep their source-FP id so a later save can write back per entity). Removed the in-script Draw FP tool (you draw natively now). *(Save-back + elevation pass next. Dev/latest only.)*

## 2026-06-15 — Site Setup Generator — free-draw FP + ✨ Snap & Clean (dev-only) — Asset Inspector v4.61

Split drawing from cleanup so sketching stops fighting you. **Draw FP is now a free sketch** — no per-click power-line snapping; draw roughly where you want paths (clicking an existing waypoint/segment still snaps so you can **branch**). Then the new **✨ Snap & Clean** button does a batch pass over the whole drawn network: densifies every segment, snaps each sample ~50 ft parallel off the nearest power line (following line bends), and Douglas-Peucker-simplifies to a few clean verts. Shared junction/branch verts snap once so connectivity survives; points farther than ~220 ft from any line stay where drawn (open-ground / base connectors). Result stays fully editable (drag/insert/delete). *(Elevation points next. Dev/latest only.)*

## 2026-06-14 — Site Setup Generator — Draw FP: multiple paths + branching (dev-only) — Asset Inspector v4.60

Draw FP now supports **multiple flight paths and branching** (was one-path-only). Each finished path **adds** to the graph instead of replacing it, and clicks **snap onto existing FP waypoints/segments** so you can **branch** off a path (clicking mid-segment splits it into a T-junction). Draw FP also **stays active** after a double-click so you can sketch the next path right away — toggle the button off when done. Everything stays in the editable corridor (drag/insert/delete). *(Dev/latest only.)*

---

## 2026-06-14 — SOP Validators: no more page hang on large sites — Asset Inspector v4.59 (latest, dev-only)

On a big site the validator did all its work in one synchronous burst and froze the tab (Chrome "page unresponsive"). It now (1) runs **asynchronously, yielding to the browser** periodically so the page stays responsive with a "Validating site…" indicator, and (2) uses a **bounding-box spatial prefilter** on the heavy proximity/angle checks so each entity only compares against nearby ones — roughly 100× less work on large sites. Results are identical (the prefilter only skips pairs that are provably too far to match).

## 2026-06-14 — SOP Validators: FP→FFZ angle = angle to the edge it lands on — Asset Inspector v4.58 (latest, dev-only)

Corrected: FPs connect to an FFZ **mid-edge**, never at a corner. The check now just measures the angle between the approaching FP segment and the **edge it terminates on**, flagging **< 15°** (grazing). Detection is "FP endpoint on an FFZ edge"; only the approach leg is measured. Site 1583: 55 connections, all 50–90° → 0 false positives (the prior corner/long-axis attempt wrongly flagged 23).

## 2026-06-14 — SOP Validators: FP→FFZ angle reworked (vertex connection vs long axis) — Asset Inspector v4.57 (latest, dev-only)

The FP→FFZ angle check now matches how FPs actually connect — at an FFZ **corner (vertex)**, not crossing an edge mid-span. It measures the angle between the connecting FP segment and the FFZ's **long axis** and flags anything **< 15°** (ideal 45°): an FP grazing in nearly parallel to the long edge is "too sharp". Deduped per connection point, drawn at the vertex.

## 2026-06-14 — SOP Validators: FP→FFZ crossing angle — Asset Inspector v4.56 (latest, dev-only)

New check: where an FP segment crosses an FFZ boundary, the angle between the segment and that edge must be **≥ 15°** (editable; ideal 45°). A near-parallel / grazing crossing is "too sharp" and gets flagged at the entry point, naming the segment, the FFZ and the measured angle. Own enable + threshold in the SOP Validators panel.

## 2026-06-14 — SOP Validators: Tower GM standoff — Asset Inspector v4.55 (latest, dev-only)

New check: general markers of type **"tower"** must stay **≥ 60 ft** (editable) from every FFZ edge and every flight-path segment. Flags any tower closer than that, naming the offending FFZ and/or FP with the measured distance. Own enable + threshold in the SOP Validators panel.

## 2026-06-14 — SOP Validators: flag on the displayed value — Asset Inspector v4.54 (latest, dev-only)

A floor of 89.6 ft AGL was flagged but rendered "90 ft AGL (min 90 ft)" — the rounded note disagreed with the raw comparison, so a finding could look compliant. Now every threshold check flags on the **same rounded number it shows**: "90 (min 90)" never flags, only "89 (min 90)" or lower. Applied to AGL floor, FFZ→Asset, FP→Asset, FFZ↔FFZ, NFZ size/proximity and band height. (FP alt-overlap now shows 1 decimal since its 6.56 ft threshold is sub-foot.)

## 2026-06-14 — SOP Validators: FP overlap segment IDs + junction grouping — Asset Inspector v4.53 (latest, dev-only)

FP alt-band overlap findings now name each segment as **"FP <name> seg #N (id <arc.id>)"** (N = on-map segment number) instead of the ambiguous "flight_path_1 ↔ flight_path_1". And a 3-way junction is now **one** issue listing every under-overlap pair at that vertex (e.g. "#67↔#69: 7 ft; #68↔#69: 10 ft") rather than duplicate-looking rows. Segment #/id also added to the FP↔FFZ, AGL-floor, band-height, inverted-band and degenerate-arc notes.

## 2026-06-14 — SOP Validators fix: false "FFZ N ft from asset" flags — Asset Inspector v4.52 (latest, dev-only)

The FFZ→Asset / FP→Asset checks were running every asset pad through `simplifyPolygon` (an angular-sort meant only for bowtie well-pads). On multi-vertex BATTERY/COMPRESSOR pads that **scrambled** the boundary into phantom edges, which then measured a few feet from a neighboring FFZ — producing bogus violations like "FFZ is 4 ft from asset" that don't exist on the map. Now the validator uses the **raw drawn polygon** (the true boundary) and only repairs genuine self-intersecting bowtie pads (via convex hull). No effect on real near-misses; removes the phantom ones.

## 2026-06-14 — SOP Validators (Phase 4b/4c) — Asset Inspector v4.51 (latest, dev-only)

Adds 7 more SOP checks to the validator, each with its own enable + editable threshold in the **SOP Validators** Control Panel section:

- **FP alt-band overlap** — connected flight-path segments (sharing a waypoint) **and** an FP segment passing through an FFZ must share **≥ 2 m (6.56 ft)** of altitude band so the drone has a continuous band to transition. (Compared in meters so arcs that overlap by *exactly* 2 m aren't false-flagged.)
- **AGL floor band** — the floor (min altitude − DEM ground) of FP segments **and FFZs** must sit **90–210 ft AGL**: too low = 🔴, too high = 🔵. Ground is fetched on run.
- **NFZ minimum size** — NFZ bounding box must be ≥ **30 × 30 ft**.
- **NFZ proximity** — an NFZ must stay ≥ **15 ft** from other NFZs and from any FFZ edge.
- **Alt-band height** — soft-warn over **40 ft**, hard-flag over **200 ft** (the latter is almost always a data-entry typo).
- **Inverted / zero alt band** — min ≥ max altitude.
- **Zero-length / duplicate FP arc.**

Note: AIM Issues draws every validator finding in its red "open" style, so the 🔴/🔵 distinction is in the note text, not the marker color. Offline-validated against site 1583 (0 false positives on the compliant FP-overlap set; 11 band-height soft warnings). Coworkers unaffected (root prod has no validator code).

## 2026-06-14 — AIM Issues — per-issue Slack opt-in for validator findings (dev-only) — AIM Issues v1.19

Validator findings (the ephemeral SOP-validator issues) stay **silent on Slack by default** — they're for self-diagnose-and-fix, not channel noise. A new **🔔 Notify Slack** toggle on the issue popup (validator findings only) lets you **escalate a specific finding to Slack on demand**: flipping it on posts a full thread for that finding, and later comments/assignments thread under it. It's session-scoped (resets when the finding is re-drawn) — a deliberate "push this one now" action. Normal issues are unchanged (still auto-ping). *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — adopt pre-Slack issues on first touch (dev-only) — AIM Issues v1.18

Issues created before Slack notifications existed had no thread, so acting on them posted loose standalone messages. Now the **first action** (transition / comment / assignment) on such an issue **backfills a full parent status board + original-report + affected-entities seed** and threads the action under it — from then on it behaves like a natively-created issue. (Deletes don't adopt — no point creating a thread just to strike it.) *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — filer no longer pinged on the parent (dev-only) — AIM Issues v1.17

The "filed by @you" on the **parent** message was still a real @-mention (v1.14's plain-text change only landed on the thread reply, not the parent) — so filing an issue pinged you *and* made you follow the thread, which is why you kept getting notified of every later reply. Now the filer is plain text on the parent too. New issues won't ping or auto-follow you; existing issues created before this still will until muted/deleted. *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — Slack badge click (real fix) (dev-only) — AIM Issues v1.16

The ✓ SLACK badge was being grabbed by the header's drag handler (dragging it moved the popup; clicking did nothing). The drag handler skipped `button/input/textarea` but the badge was a `<span>`. Now the badge is a real `<button>` and the drag handler explicitly skips it — so clicking opens the thread. *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — Slack badge click (capture-phase) (dev-only) — AIM Issues v1.15

The ✓ SLACK badge still wasn't opening — it lives in the draggable header, which was swallowing the click. Now bound on capture-phase pointerdown (same pattern as the chips) so it fires before the drag logic, with a toast confirming it fired (and a clipboard-copy fallback if the browser blocks the open). *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — real self-ping fix + ping rules + Slack badge (dev-only) — AIM Issues v1.14

The actual self-ping cause: every message header @-mentioned the actor (a real `<@id>`), so you pinged yourself on every action (assign, comment, etc.). Now the "who did it" text is plain `@name` (no ping) and real mentions are reserved for intended recipients. **Ping rules now:** propose → the *other* approvers; **approve/reject → the assigned CSM** (falls back to the proposer); comment → only the people you tag (multiple supported). Also: the **✓ SLACK badge** now opens via `GM_openInTab` (the previous fix still didn't work — the iframe sandbox blocked it; falls back to clipboard-copy). **Note: this adds a `GM_openInTab` grant, so Tampermonkey will prompt to re-approve on update.** *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — no self-pings + clickable Slack badge (dev-only) — AIM Issues v1.13

Two fixes: **(1)** the **✓ SLACK badge** in the issue header now actually **opens the thread** (it was a dead link — the map iframe's sandbox blocks `target="_blank"`; now it opens via the top window). **(2) No more self-pings** — you no longer get @-mentioned for your own actions (filing, proposing, commenting). An approver proposing their own find now pings the *other* approvers, not themselves; the create-issue cc no longer defaults to (or includes) you. Cuts the notification noise a lot. *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — assignees (dev-only) — AIM Issues v1.12

Issues can now be **assigned**. **Anyone** can assign or reassign (or unassign) an issue to any teammate — pick from the assignee chips in the issue popup (⭐ marks you; one click). The assignee shows in the **popup header**, on every **panel row**, and as a new **Assignee column** in the Copy→Sheets export, with an **"👤 Assigned to me" filter** in the panel. Assignments post a **threaded Slack reply** that pings the new assignee, and the **parent status board shows the current assignee**. Assign events are recorded in the issue history (👤). *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — issue-popup polish (dev-only) — AIM Issues v1.11

Cleaned up the issue popup: **history defaults to newest-first**, the **action area (status / priority / Add comment) moved above the history** so it's the first thing you reach, and **history entries now show the same emoji + status colors as Slack** (🚩 OPEN, 🟡 PENDING FIX, 🟣 PENDING IGNORE, ✅ RESOLVED, ⊘ IGNORED, 🗑 DELETED) so transitions are readable at a glance. Added a **✓ SLACK badge in the header** that confirms the issue was reported to Slack and **links straight to its thread** (amber ⧗ if it hasn't posted yet). *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — tag teammates in comments (dev-only) — AIM Issues v1.10

Comments can now **@-mention teammates**: the comment box has a **Tag on Slack** chip picker, and typing **`@TeammateLogin`** inline in the comment text auto-converts to a real Slack ping for any mapped user. Tagged people get pinged in the threaded comment. Also removed **Ned-Yap** from the approvers list (`approvers.json`). *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — snappier issue-modal chips (dev-only) — AIM Issues v1.09

Chased the laggy chip feedback in the New-issue modal. The modal now **stops its pointer/click events from leaking to Percepto's global map handlers** (the status modal already did this; the note modal didn't — every click was being processed by the map too), and the **priority chips now respond on pointerdown** like the notify chips. Selecting a priority then a name should feel immediate. *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — parent = live status board, thread = full history (dev-only) — AIM Issues v1.08

Reworked the Slack message model. The **parent message is now a live status board**: it's edited on *every* transition so the channel shows current state at a glance — 🚩 OPEN → 🟡 PENDING FIX / 🟣 PENDING IGNORE → ✅ RESOLVED / ⊘ IGNORED / 🗑 DELETED (terminal states strike the description). Because the parent now changes, the **thread carries the full immutable history**: reply 1 is the **original report** (preserved verbatim), reply 2 is the **affected entities**, and every status change appends after. So you can read state from the parent without opening the thread, and never lose the original request. *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — sticky Confirm/Cancel footer (dev-only) — AIM Issues v1.07

Fixed a confusing flow in the issue popup: when you armed a transition (e.g. Propose Fix), the **Confirm/Cancel** buttons were buried at the bottom of the scrollable body while a "Close" button sat pinned below — so it was easy to hit Close and silently lose your status change. Now **Confirm/Cancel are pinned in the footer** (always visible, no scrolling), the note field auto-scrolls into view + focuses when armed, and the **redundant bottom "Close" is gone** (the top-right ✕ is the single close). *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — deep-link focus + approver-propose (dev-only) — AIM Issues v1.06

More from the feedback round: **(1) Deep-link focus** — clicking an issue's Slack link now lands you on the site *and* AIM Issues pans/zooms to that issue and opens its box automatically (the link carries `?aim_issue=<id>`; the param is stripped after focusing). **(2) Delete** now also strikes + badges the **original** Slack message (`🗑 DELETED`), matching resolve/ignore. **(3) Approvers can now Propose** (Fix/Ignore), not just direct-resolve — so an approver can route their own find through another approver instead of self-approving. **(4)** Fixed the **Notify chip needing 2-3 taps** (Leaflet was swallowing the first clicks; now pointerdown+click with a debounce). *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — Slack notification polish (dev-only) — AIM Issues v1.05

Round of refinements on the Slack notifications: **(1)** the site name in each post is now a **clickable link** straight to that site's Site Setup. **(2)** A new issue's first threaded reply lists the **affected entities** it overlaps. **(3) Deletes** are logged in the thread (`🗑 @user deleted this issue`) so the thread reads created → … → deleted. **(4)** The **Notify** picker now includes yourself (tag an issue for your own follow-up), and if you tag nobody it **defaults to the creator**. **(5)** When an issue is **resolved/ignored**, the bot **edits the original message** — strikes the description and prefixes ✅ RESOLVED / ⊘ IGNORED; re-opening restores it. *(Dev/latest only.)*

---

## 2026-06-14 — AIM Issues — Slack notifications (dev-only) — AIM Issues v1.03 → v1.04

AIM Issues now posts to the **CSM-Site-Issues** Slack channel via the `csmissues` bot. **New issues** post a parent message; **comments, proposals, approvals/rejections** post as **threaded replies** under that issue, so the channel stays one line per issue. **@-mentions**: proposing a fix/ignore pings the approvers to review; approving/rejecting cc's the original proposer; the create-issue modal gains an optional **Notify** picker to @-mention specific teammates on creation. Config (bot token + channel + GitHub-login→Slack-ID map) lives in the private `aim-userscripts-data/slack-config.json`. Degrades silently to no-post when unconfigured. **v1.04:** also load the Slack config on the init path (not just the token-broadcast path) so it loads on a normal page load. *(Dev/latest only — not yet promoted to the prod build coworkers run.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 FFZ-connection points editable (dev-only) — Asset Inspector v4.51

The **green FFZ-connection dots** are now editable too (they weren't before — they're branch endpoints, not corridor vertices): **drag** one to move where the path meets the FFZ (it snaps to the FFZ edge), or **right-click** it to drop that branch. Closes the "the vertex that connects to the FFZ can't be moved or deleted" gap. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 corridor insert/delete waypoints (dev-only) — Asset Inspector v4.50

Corridor editing now has **insert + delete**: **click directly on a corridor line** to drop a new waypoint there (and immediately drag it), and **right-click a waypoint** to delete it (its two neighbours bridge so the path stays connected). Flags recompute on every edit; changes flow into the export. Full drag / add / remove. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 EDITABLE corridor (drag to fix) (dev-only) — Asset Inspector v4.49

The corridor preview is now **editable**: every waypoint has a **white dot you can drag** to move the path. Flags recompute **live** — drag an orange (out-of-band / over-a-pad/FFZ) stretch clear and it turns cyan. The asset branches + base launch re-attach to the corridor as you move it, and edits flow into the JSON export. This makes "flag the problem" actually actionable — the CSM drags the few flagged spots instead of the tool trying (and failing) to auto-perfect them. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 clean offset + flag (drop the dodging) (dev-only) — Asset Inspector v4.48

Changed approach: the auto-dodging around obstacles was the source of the zigzags/crossings/extra vertices. Now the corridor is a **clean flat ~50 ft offset** of each power line to one consistent side — no dodging — and any point that **leaves the 40–65 ft band or crosses a pad/FFZ is flagged orange** for the CSM to drag-fix. Predictable, stable, far fewer vertices. The foundation-then-tune model. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 avoid FFZs+pads, both-side, bowtie fix (dev-only) — Asset Inspector v4.47

Three corridor fixes (calibrated offline with proper buffers vs the real FP). (1) The trunk now **avoids FFZ interiors too**, not just pads (the real FP never traverses an FFZ — it only connects in at a branch tip). (2) When the asset side of a line is fully blocked, the offset **crosses to the other side** (a deliberate perpendicular crossing) instead of plowing through. (3) Fixed a real bug: type-3 pad rings are stored **bowtie**-ordered, so the 15-ft pad buffer was being built from a malformed ring and blocking the whole band — now `simplifyPolygon`'d first. Offline result: pad overlaps 43→10, FFZ overlaps 82→1, median 50 ft. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 stable corridor (no sawtooth) + clipboard export (dev-only) — Asset Inspector v4.46

Replaced the per-node corridor offset (which sawtoothed — adjacent nodes flipping the perpendicular sign) with the **ordered feature-offset** that worked in offline testing: each power line is offset as a single ordered walk, so the perpendicular orientation is stable along the whole line. One majority asset-side per line; pad-clear search; base launch leg drawn from the base to the nearest corridor point. Also: **⧉ Copy JSON** now copies the route export straight to the clipboard (no download/open/copy dance). *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 fix junction zigzags (dev-only) — Asset Inspector v4.45

Fixed the corridor zigzagging at power-line junctions (live result diverged from the offline model). Two causes: (1) the routed tree includes **connector hops** (cross-line jumps) and the base launch leg — offsetting their interior perpendicular threw it into open space; now any edge longer than ~1.8× the node spacing draws **direct** between its offset endpoints. (2) a node's line-direction was taken from its first two neighbours, which could be a far connector → wrong perpendicular; now it uses the **two nearest** neighbours (the real same-line direction). *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 corridor matches the real FP (dev-only) — Asset Inspector v4.44

Rewrote the corridor offset, calibrated **offline against the real site-1502 flight path + power-line KML**. The trunk now offsets ~50 ft to the asset side and, where it would hit a **pad buffer** (the hard "never enter"), searches the nearest clear offset — preferring in-band, then outward (safe), then inward. **FFZs are flag-only** (the path connects into them), not avoided. Result vs the real FP in offline tests: corridor sits at **median ~50 ft from the lines (real FP: 47 ft) with ~85% in the 40–65 band** — versus the previous build's 26 ft / 6% (it was hugging the lines, dangerously close). Pads cleared, no line-crossings. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 trunk+branches, no swings, reach all (dev-only) — Asset Inspector v4.43

Rebuilt to match the real flight path (diagnosed by comparing the route export against the actual site-1502 FP). (1) The trunk now **clamps its offset toward the line** instead of pushing to an obstacle's far edge — so it stays line-side of pads/FFZs at the largest shielded offset that's clear, killing the 200 ft swings near big pads. (2) **Every asset now connects** — dropped the hard "unreachable beyond 220 ft" cutoff; a long approach is drawn and flagged (red), never excluded. Trunk hugs the lines, branches hug the FFZ edges. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 route JSON export (dev-only) — Asset Inspector v4.42

Added a **⤓ JSON** button next to 🛩 Routes that downloads the last route result (base, corridor segments, per-asset connections, stats, tunables) as `aim-route-site<id>.json` — and stashes it at `window.__aimRoute` — so the exact routing output can be shared for debugging instead of guessing from screenshots. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 simplified corridor + close X (dev-only) — Asset Inspector v4.41

Added the obvious missing **✕ close button** to the Generator modal. And killed the "scribble": the dense pushed corridor is now **collapsed to few clean vertices** — one connected graph, deleting every degree-2 vertex within 14 ft of the straight line between its neighbours, keeping only corners, branch points, and ends (offline: 181 samples → 6 verts). The stat line now reports the corridor vertex count so we can compare against a real flight path (~19 for a whole site). *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 connected corridor + consistent side (dev-only) — Asset Inspector v4.40

Rebuilt the corridor geometry to fix the disconnections. It now offsets at **shared nodes** (one position per node) so the network is **connected by construction** — no gaps; every FFZ links back to the base (out-of-shield assets included, they just fly a longer flagged approach). The offset **side is majority-smoothed** across neighbours so it no longer jumps across the line on isolated ~50 ft segments. And every FFZ connection goes to an **edge** (never the centre, no dashed) — including out-of-shield ones. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.2 obstacle-aware shielded corridor (dev-only) — Asset Inspector v4.39

First A2.2 slice: the corridor is no longer the bare centerline on the power line. It now **offsets ~50 ft toward the asset side**, then **pushes out of every pad buffer (15 ft) and FFZ interior** — NEVER entering them, hugging their near edges instead — and **flags** any stretch where the resulting shield distance falls outside **40–65 ft** (drawn orange; the stat line shows total flagged feet). Resolves the "flight path runs through an FFZ" problem. Still preview-only (no altitudes/commit). *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.1 connect at FFZ edge, not the interior (dev-only) — Asset Inspector v4.38

The branch now connects to the **middle of the FFZ's near edge** (the actual entry point) with the marker on the edge, as a **solid** leg off the trunk — no more dashed line running into the FFZ centroid. Cleaner read of where the flight path actually meets the zone. *(Dev/latest only.)*

---

## 2026-06-14 — Site Setup Generator — A2.1 follow lines exactly (no corner-cutting) (dev-only) — Asset Inspector v4.37

The real cause of the parallel "extra segment" + paths not following the power line + cutting across a pad: my **connector edges were chording across a single line's own bends** (two densified nodes either side of a bend are <130 ft apart, so a shortcut got added). Rebuilt the graph with **line membership** — each power line is densified as its own chain (followed exactly), and connectors now bridge **only between different lines** (one closest bridge per line pair, no zigzag). So routes hug the power lines and stop shortcutting over pads. Offline-verified: a bent line gets 0 cross-bend chords; two distinct lines get exactly one bridge. *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — A2.1 single corridor + clean T-branches (dev-only) — Asset Inspector v4.36

Two routing-quality fixes. (1) **No more parallel double-back corridors** — distro + trans power lines trace the same corridor a few ft apart, so both were being densified into parallel runs and the tree split between them. Now overlapping/parallel PL segments (within 60 ft) are deduped to one corridor before graphing, so a branch T's off cleanly instead of running parallel. (2) **Branch connects to the FFZ middle via a clean perpendicular T** off the trunk (the foot of the perpendicular from the FFZ centroid), not from the nearest discrete graph node. *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — A2.1 routes connect to FFZs, not pad centers (dev-only) — Asset Inspector v4.35

Routing now targets the **asset's FFZ** (committed or in the current generator preview) instead of the pad center — a big pad's center sits 100+ ft inside, so pads were wrongly flagged out-of-shield even though their FFZ is right next to the corridor. Each asset connects to its nearest FFZ within 70 ft of the pad edge; if it has no FFZ yet, it falls back to the nearest **pad edge** vertex (never the center). Stats now show how many routed via FFZ vs pad edge. So the intended flow is FFZs first → Routes, but it works either way. *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — A2.1 shielded flight-path routing (preview) (dev-only) — Asset Inspector v4.34

First slice of **A2: base→asset shielded flight-path generation**. New **🛩 Routes** button in the Generator builds a branching tree from the base station that snakes along power-line corridors to every near-line asset. Builds a routing graph from the power-line KML (densified vertices + corridor-hop connectors within 130 ft), connects the base + each asset (launch + approach legs), runs Dijkstra, and previews the result: **cyan = shielded corridor tree**, **dashed green/red = final approach** (reachable vs out-of-shield), **yellow ring = base**. Reports reachable/out-of-shield counts + launch distance. PREVIEW ONLY — no 40–65 ft offset, no altitudes, no commit yet (those are A2.2/A2.3). *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — draw: junctions at any zoom + two-asset corners (dev-only) — Asset Inspector v4.33

Fixes the corridor corner made of **two different assets** that wouldn't lock. Two causes: (1) snap-targets skipped any pad whose **centroid** was off-screen, so zooming into a corner dropped both pads and their junction — now all pads are considered, and the view only decides which dots to *draw*. (2) Junctions required a strict offset-ring crossing; a corner where the two pads' offset edges merely *touch* found nothing — now a near-perpendicular pair whose intersection lands on **both** edges (within ~12 ft) counts, so the two-asset corner gets a magenta lock dot. Added a `[AIM GEN] snap targets: N corner + M junction` console line. *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — draw: ortho right-angle mode (dev-only) — Asset Inspector v4.32

For the corridor corner that has no pad/junction dot to lock to (pads too far apart for their offset rings to meet), Draw now **squares the corner automatically**: in open space the next leg snaps to either straight-ahead or an exact 90° turn off the previous leg (the cursor's dominant axis decides). The ghost marker turns **cyan** when ortho-locked (green = corner, yellow = edge). Hold **Shift** for fully free placement (no snap, no ortho). *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — draw: 1-vert corners + back-to-back junction dots (dev-only) — Asset Inspector v4.31

Two draw fixes. (1) **Outer corners are now a single vertex** — a miter-limit bug (`off*4` is negative for the right-hand offset, so that side always beveled into 2 verts) is fixed with `Math.abs`. Every corner now strokes to one clean point. (2) **Back-to-back pads now get a magenta junction dot** to lock the corridor's between-pads corner — it sits where the two pads' 15-ft offset rings cross (15 ft from *both* pads), so you no longer have to free-aim at a spot with no target and end up closer than 15 ft. Junction snap takes priority over edge snap. *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — draw: visible corner snap-targets (dev-only) — Asset Inspector v4.30

Drawing a corridor is now aim-at-the-dot instead of hunting pixels. While Draw is on, every nearby pad's offset-ring **corners show as cyan target dots** (the exact points a click locks to), and a live **ghost marker** tracks the cursor — it turns **big green when you're magnetised to a corner**, small yellow on an edge. The corner magnet was widened to 22 ft so locking is forgiving. Target dots re-sync as you pan/zoom. This stops the "clicked slightly off → strip starts inside the asset" problem. *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — draw: pad-follow + corner cleanup (dev-only) — Asset Inspector v4.29

Restored the pad-following corner-tracing in Draw (v4.28's pure-WYSIWYG removed it, which lost square corners and the 15-ft standoff between clicks). Two clicks on the same pad again trace its offset-ring corners so the strip hugs the pad at a constant 15 ft with true right angles. The old downside (1–2 extra facet points at a corner) is fixed by a new **clamped collinear cleanup** that collapses each corner to a single point without touching real 90° corners (offline-verified: 9-pt L-path → 3 clean corners). *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — WYSIWYG draw corners (dev-only) — Asset Inspector v4.28

Refined click-to-place draw: removed the auto corner-tracing that inserted pad-outline vertices on top of your clicks (it was adding 1–2 extra points at some corners). Now **one click = exactly one corner** — the corner-magnet still snaps each click onto the nearest pad corner/edge, so every corner is a single clean point, matching the rest. *(Dev/latest only.)*

---

## 2026-06-13 — Site Setup Generator — click-to-place corridor draw (dev-only) — Asset Inspector v4.27

Replaced the freehand press-drag Draw mode (which kept blobbing on inside corners and pad-to-pad transitions) with **click-to-place corners**. In Draw mode you now **click each corner** of the corridor — every click snaps to a nearby pad's 15-ft offset outline, and clicks near a pad **corner snap to that exact corner** (16 ft magnet) for true right angles. A dashed rubber-band previews the strip to the cursor; cyan dots mark placed corners. **Double-click** (or toggle Draw off) finishes; **Esc** cancels. Crossing between two edges of the same pad still auto-traces the corner vertices, so a single corridor can span two adjacent pads cleanly with few vertices. *(Dev/latest only — not promoted.)*

---

## 2026-06-12 — AIM Mission Log CT v1.0 (new script)

New standalone userscript: **AIM Mission Log CT**. On a site's **Mission Log** page it rewrites the TIME column from the site's fixed **GMT-5** stamps into real local **Central Time** — `Jun 11, 2026 13:28` → `06/11/2026 - 1:28pm CT` — and relabels the header site clock to CT. Each GMT-5 stamp is read as an absolute instant and re-rendered through `America/Chicago`, so summer missions read identically (GMT-5 = CDT) while winter missions correctly drop an hour. Layout survives Percepto's React re-renders via a MutationObserver. No hotkeys; brand-new install (not auto-distributed). *(Follow-up in progress: a richer Mission Log SUM folded into Mission Bank Tools.)*

---

## 2026-06-12 — Site Setup Generator — revert v4.25 corner cleaner (dev-only) — Asset Inspector v4.26

v4.25 tried to drop near-collinear vertices from the strip outline, but the collinearity test used the infinite-line distance and removed essential vertices — collapsing the strip back into a filled blob. **Reverted to v4.24's behavior** (the good one). The minor extra vertices at outer bends stay for now; not worth the blob risk. A safer corner-cleanup can come later (or via a click-to-place draw variant).

## 2026-06-12 — Site Setup Generator — Draw mode: fewer vertices, no blob (dev-only) — Asset Inspector v4.24

- **No more filled-blob FFZ.** The corner-tracing could pick the *wrong way around* a pad when the snap flickered between far-apart edges, wrapping the strip into itself (which the cleanup then filled solid). It now only traces across **adjacent** edges (1–2 steps) — a real corner — and ignores big edge jumps.
- **Far fewer vertices.** The drawn centerline is now **Douglas-Peucker simplified** before stroking (a ~38-point freehand L collapses to ~3 vertices), so you get a clean strip with sharp **right angles on both the inner and outer edges** and only a handful of points to hand-edit. The live preview simplifies too, so what you see is what you commit.

## 2026-06-12 — Site Setup Generator — Draw mode turns real right angles (dev-only) — Asset Inspector v4.23

The corners were still cutting at 45° because the drawn centerline *skipped* the corner between samples. Now, when the draw crosses from one edge of an asset's offset outline to the next, it **inserts the actual corner vertex** into the path — so the corridor turns the pad's true right angle instead of beveling across it. (Builds on v4.22's offset-outline snap + self-intersection cleanup.)

## 2026-06-12 — Site Setup Generator — Draw mode: sharp corners + no twist (dev-only) — Asset Inspector v4.22

Two fixes to the freehand Draw corridor:
- **Right-angle corners.** It now snaps to the asset's **mitered 15-ft-offset outline** (sharp corners) instead of the nearest border point (which arced around corners), so the strip follows the pad's actual right angles.
- **No more inner-corner twist.** The finished strip is run through a self-intersection cleanup that snips out any loops, so it's always a valid simple polygon — fixes the knot where the corridor turned back on itself at concave joins.

## 2026-06-12 — Site Setup Generator — ✏️ freehand Draw mode (dev-only) — Asset Inspector v4.21

A new way to make FFZs that sidesteps the multi-pad snake's geometry problems entirely. Click **✏️ Draw**, then **press and drag** to paint a corridor: it lays down a **30 ft-wide strip** along your cursor path. Whenever the path passes near an **asset it snaps to 15 ft off that asset's border** (so the strip hugs it), and **away from assets it follows your cursor freely** — so you can draw across gaps to connect pads, then snap onto the next one. Release to drop the FFZ (DEM-altitude'd, named after the nearest asset, fully editable like any other preview, commits the same way). Because it's a symmetric stroke of a centerline (and snapping to the nearest asset *point* rounds corners), it stays a clean simple polygon — no bowtie, no spikes. This is the robust answer to "one FFZ across an L / multiple pads." (v4.20: the old multi-pad snake now fails gracefully to single-pad on concave joins.)

## 2026-06-12 — Site Setup Generator — two-pad snake now actually works (dev-only) — Asset Inspector v4.17–v4.19

Got the cross-pad snake working after live debugging:
- **v4.17/v4.18** — the bridge wasn't firing because it required the neighbor pad to be *strictly nearest*, which never happens next to a big pad. Now it bridges on **proximity** (cursor within 90 ft of any pad ≤320 ft away), and the active pad stops extending past 90 ft so it doesn't keep wrapping the first pad.
- **v4.19** — fixed the two real bugs the console revealed: (1) the combined ribbon **self-intersected at the L corner** where the two pads' edges meet — rebuilt it to offset **one combined path on a single consistent side** (no more bowtie), and (2) on very close pads (12 ft apart) it **flickered between bridging and un-bridging** — added hysteresis so it only switches when the cursor is genuinely closer to the other pad. Validated offline: an L across two pads is now one clean, simple polygon.

## 2026-06-12 — Site Setup Generator — snake one FFZ across two pads (dev-only) — Asset Inspector v4.16

**Snake a single FFZ across two (or more) adjacent pads.** When you Ctrl-snake and the cursor reaches a nearby neighbor pad (within ~160 ft), the ribbon **auto-bridges the gap** and keeps going on that pad — one FFZ covering both assets. Each pad's portion still holds the **15 ft standoff on the side you're snaking** (your "whichever side I'm snaking" choice); only the straight bridge across the gap crosses open ground (the intended "other than connecting two pads" exception). Reverse back over the bridge and it un-bridges. Multi-pad FFZs commit like any other; resize end-handles stay on single-pad ribbons (re-snake to reshape a multi-pad one). Validated offline: two adjacent pads → one simple polygon spanning both with a clean standoff band + gap bridge.

## 2026-06-12 — Site Setup Generator — committed-FFZ popup + handle de-flicker (dev-only) — Asset Inspector v4.15

- **Clicking a committed (locked, green) FFZ now pops up a short note** explaining it's saved and needs a page reload to be natively selectable in Percepto — with a 🔄 Reload button right there. (Stops the "it's there but I can't use it" confusion.)
- **End-resize handles no longer flicker** while you move or snake an FFZ — they hide during any drag/snake and come back on hover when you're done.

## 2026-06-12 — Site Setup Generator — no-reload commit + end-resize handles (dev-only) — Asset Inspector v4.14

- **Committed FFZs now show on the map immediately — no reload needed.** After Commit, the FFZs stay drawn as a solid-green, locked overlay (Percepto's own map still needs a reload to make them *natively* editable, but you can see them right away; our tools also re-fetch so they're real for routing/validators). Remove drops those overlays too. (The reload button stays on Remove for any FFZs Percepto rendered in an earlier session.)
- **Resize an FFZ from either end.** Hover a snapped/snaked FFZ and two yellow **end-handles** appear; drag one to shorten or lengthen *that* end along the pad — the rest of the shape stays put, and dragging an end past a corner snakes it around (and back). No more redrawing the whole thing just to trim one side.

## 2026-06-12 — Site Setup Generator — movable panel + reload prompt (dev-only) — Asset Inspector v4.13

- **The Generate panel is now a floating, draggable, resizable window** instead of a full-screen dimming dialog. Drag it by the title, resize from the ↘ corner, and — because there's no backdrop anymore — the **map stays visible and editable** while it's open (so you can preview, then snake/move FFZs without closing it).
- **Commit and Remove now offer a one-click 🔄 Reload** — direct-API writes don't refresh Percepto's live map (it renders from its own React state), so committed/deleted FFZs only appear on the map after a reload (they show in the native sidebar immediately). The button saves the manual F5.

## 2026-06-12 — Site Setup Generator — legal FFZ names (dev-only) — Asset Inspector v4.12

Commit was 400ing because Percepto only allows **letters, numbers, spaces, `_` and `-`** in entity names/descriptions — the `[DRAFT]` brackets were illegal. The draft prefix is now **`DRAFT `** (no brackets), every generated name is **sanitized** to the legal character set (e.g. `well#7 (north)` → `DRAFT well 7 north FFZ`), the description is forced empty, and the re-home (Alt-snap / Ctrl-snake) updates the name to the new pad. Bulk-undo now matches the `DRAFT ` prefix.

## 2026-06-12 — Site Setup Generator — COMMIT the draft FFZs (dev-only) — Asset Inspector v4.11

Closes the generate → tune → **commit** loop. A new **Commit** section in the ⊕ Generate modal:
- **✓ Commit draft FFZs** writes every previewed (and hand-edited) FFZ to the site as a new entity via the Site Setup save (`POST /map_objects/`, cookie + CSRF). Each is created with its `[DRAFT] ` name, `validated:false`, the DEM-derived MSL altitude band, and all the fields a real freezone carries (cloned from an existing FFZ as a template). FFZs still missing a DEM altitude are skipped + reported.
- **Dry run** (on by default) builds + counts everything without writing — run it first.
- On a real commit it **downloads a manifest** of the created IDs, clears the preview, and refreshes the SUM panel.
- **🗑 Remove [DRAFT] FFZs** is the bulk-undo — deletes every FFZ on the site still named `[DRAFT] …` (zones a CSM has accepted, with the prefix stripped, are left alone). Also has a dry-run that just counts.

Per-FFZ success/failure is reported in the modal. Validated offline: the create body carries the full FFZ field set with no id (so the upsert creates), correct type/name/points/restrictions.

## 2026-06-12 — Site Setup Generator — snake both ways + right-click info (dev-only) — Asset Inspector v4.10

- **The FFZ info popup now shows on right-click (M2) only**, not on hover — the hover tooltip was covering the pad while you were trying to snake/move. Right-click any draft FFZ to see its name, side, altitude band, and the control hints.
- **Snake now grows both directions and past halfway.** The previous version locked the direction from your first drag (so the other way just shrank to nothing, and it stalled around the halfway mark). It now tracks a continuous **signed** perimeter offset from the anchor, so dragging one way grows that way, dragging back shrinks and then grows the other way, and you can wrap most of the pad (up to nearly a full loop — it won't close into a ring). Validated offline: clean L / U / near-C in either direction, all simple polygons.

## 2026-06-12 — Site Setup Generator — snake fixes + edit controls (dev-only) — Asset Inspector v4.9

From testing the snake:
- **Split the modifiers** so you're not overloading one key: **Alt + drag = snap to a single edge**, **Ctrl + drag (along the pad) = snake** around corners. Plain drag still moves.
- **Snake direction is locked from your drag** — it no longer flips to the other side of the pad when you pass the halfway point (was taking the shortest arc; now it follows the way you're dragging).
- **Snake no longer twists near power lines.** Two guards: it only extends while the cursor is **within ~120 ft of the pad** (dragging off toward a line stops growing it instead of swinging the end around the pad), and any ribbon that **would self-intersect is rejected** (keeps the last good shape).
- **Scroll no longer rotates** the hovered FFZ — the wheel just zooms the map again. Rotation is **Q / E only** (while dragging).

Validated offline: direction follows the drag (short vs long arc by gesture), convex snakes stay simple, twisting ribbons are rejected.

## 2026-06-12 — Site Setup Generator — snake FFZs around corners (dev-only) — Asset Inspector v4.8

FFZs can now follow a pad **around its corners** into L / C / U shapes:
- **Hold Alt and drag along the pad outline** — the FFZ anchors where you press Alt and **auto-extends edge by edge** to the cursor, wrapping around each corner it passes. Let go to set the length; release Alt to free-move again.
- **Corners are mitered to a single right-angle vertex** (not rounded/beveled) — so each turn is one inside corner the drone stops at and resumes from, instead of multiple stops. (Extreme-angle spikes bevel as a safety cap.)
- Keeps the 15 ft standoff on every edge; the ribbon is the offset band [15 ft … 15 ft + depth] around the chosen run of the boundary. Short Alt taps still snap a single edge.

Validated offline: a corner run produces a clean L with one mitered inner corner, 15 ft off each edge, simple (non-self-intersecting) polygon.

## 2026-06-12 — Site Setup Generator — edit ergonomics (dev-only) — Asset Inspector v4.7 + Map Nav v0.9

Refinements to the hand-edit tool from testing:
- **Q / E rotate the FFZ while dragging** (10° per press) — easier than scrolling with the mouse button held. Scroll-rotate still works on hover. During a drag the map's zoom is suspended, and **Map Nav v0.9** releases its Q/E zoom (coordinated via a shared `__AIM_FFZ_DRAG` flag) so the keys rotate instead of zooming.
- **Snap now follows the cursor and matches a single real edge.** Alt-snap targets the polygon edge nearest the *cursor* (not the FFZ's old center, which made it snap back where you started), and it sizes to **that one edge** — so an irregular/notched pad no longer gets one FFZ spanning the whole bounding side; you get the actual edge you're pointing at.
- **Delete** removes the hovered/active FFZ from the preview (Del key).

Validated offline: edge-snap sits 15 ft off the chosen edge, length = that edge, outward.

## 2026-06-12 — Site Setup Generator — hand-edit FFZs on the preview (dev-only) — Asset Inspector v4.6

The draft FFZ previews are now **hand-editable on the map** before commit:
- **Drag** any FFZ to move it (the map stays put while you drag).
- **Scroll** over an FFZ to **rotate it 10°** per notch around its center — orient the edge to the side you want.
- **Hold Alt while dragging** to **snap** the FFZ onto the nearest face of whatever pad is closest, at the 15 ft standoff (re-homes it to that pad — drop it near a better side and tap Alt to clean it up).
- On drop, the FFZ's **DEM altitude and power-line flag recompute** for the new position (color updates: green clean / blue existing-FFZ / red couldn't-clear). Rotating recomputes the line flag live.

Previews now render as SVG so each is individually grabbable. Edits carry straight into the commit step (coming next). Validated offline: rotate preserves shape + center, snap picks the correct side.

## 2026-06-12 — Site Setup Generator (Phase A1 dial-in, dev-only) — Asset Inspector v4.5

Tuning from the first on-map test:
- **Skip only Unreachable / Unshielded / Empty** assets (now keeps Normal + Inactive + HY) — broader than the old "Normal only" (56 vs 44 eligible on site 1583). Toggleable.
- **Auto-avoid power lines instead of flagging them red.** A side that would lie *parallel over* a line is now resolved automatically — the box is either nudged **off the line** (stepping the standoff outward, up to ~80 ft, beyond the 15 ft buffer) or the FFZ is placed on the **next-closest clean side**. Each of the 4 faces is scored by closeness to a line (best shielding) minus an offset penalty; the best clean placement wins. *Crossing* a line stays fine. Red is now reserved for the rare case no side can clear — those still want a manual reposition (drag/rotate tool, next slice). Validated offline: a line laid along a face yields a clean +10 ft-off placement, not a red flag.
- **Flag pads that already have an FFZ** (drawn blue) — overlaps or within 60 ft of an existing FFZ; optional "skip" toggle. The preview summary reports flag counts + skip reasons; FFZ tooltips show the chosen side, any off-line offset, and distance to the nearest line.

## 2026-06-11 — Site Setup Generator (Phase A1, dev-only) — Asset Inspector v4.3

First slice of the **Site Setup Generator** — a new **⊕ Generate** button on the SUM toolbar (next to 🗺️ Analyzer) that auto-builds the *foundation* of a site setup for a CSM to finetune (the inverse of the Analyzer, which exports a finished one). Phase A1 generates **one inspection FFZ per qualifying asset** and **previews it on the map** — nothing is written yet.

- **One open edge box per asset** (not a full outline): a min-area oriented bounding box → a single thin rectangle on the asset face **nearest a power line** (the shielded side), inner edge **15 ft off the asset** (standoff), ≥30 ft deep. FFZs are stored **open** (4 distinct corners — never closed or looped), matching how Percepto stores them.
- **Filters:** only **Normal** assets (no `poi_type_str` state suffix — skips empty/inactive/unshielded/unreachable/hy) that are **within ~400 ft of a power line** (200 ft line + 200 ft asset reach). Both tunable.
- **Altitudes are DEM-checked per FFZ:** floor = ground + **100 ft AGL**, ceiling = floor + **30 ft** delta, stored absolute MSL. Pulls ground via Percepto's `/location_altitude/`.
- Needs the site's **power-line KML** (auto-requested from Map Styler; the modal shows load status + a ↻ Refresh). **👁 Preview** draws green **DRAFT** polygons (tooltip shows shielded side, distance to line, MSL band) and reports how many assets were skipped and why. **Commit is the next slice** — through the existing Apply-queue rails (dry-run, rollback, verify); generated FFZ names carry a `[DRAFT] ` prefix for bulk-undo.
- Geometry validated offline against site 1583 (44 Normal assets): single-edge depth exactly 30 ft, standoff 15 ft, edge-pick correctly chooses the face toward the line.

Coworkers (prod) are unaffected — they run Asset Inspector v4.0. Design + full roadmap (Tool A generator + Tool B ortho-CV shielding extractor, two parallel tracks): `ShortKeys/AIM_Site_Setup_Generator_Design.md`.

---

## 2026-06-11 — AIM Flight Path Editor v0.19 (latest, dev-only) — OPEN PATH "save + refresh" reminder

The v0.18 positional-coords change did NOT fix the post-open live-drag jank, which confirms the cause is Percepto's editor not re-binding the vertex marker after a junction is restructured (the saved data is correct — verified clean on a 65-arc production path: 1 component, 0 orphans). Decision: leave it. OPEN PATH's success toast now reminds you to **SAVE then REFRESH before editing that path again**, since the freed vertex only drags cleanly after a refresh re-seeds the markers. Also added `ShortKeys/AIM_FP_Check.js` — a standalone console integrity checker for the live server copy of every flight path on a site.

---

## 2026-06-11 — AIM Flight Path Editor v0.18 (latest, dev-only) — post-edit integrity checker + OPEN PATH jank fix

**Integrity checker on every edit.** Added `checkFlightPath()` — flags non-finite coords, a severed (disconnected) path, coords/arcs mismatch (orphan coords or arc endpoints missing from coords), zero-length arcs, inverted altitude bands, and connected-arc altitude-band gaps. Both split and OPEN PATH now snapshot the path's health *before* the edit and re-check *after*; if the edit introduced **any new problem** (or didn't apply with the expected arc count), it **auto-reverts** and says why. So every edit is verified not to have hurt the path — pre-existing issues aren't blamed on us. New manual command `window.__aim_fpe_check()` prints the integrity of every open flight path on demand.

**OPEN PATH live-drag jank fix.** The freed vertex is now inserted **positionally** in the coords list (right after the junction it split from) instead of appended at the end — appending left Percepto's editor mis-binding the marker until a refresh; matching the splitter's positional insert should keep the live marker↔arc binding consistent (no refresh needed to drag).

---

## 2026-06-11 — AIM Flight Path Editor v0.17 (latest, dev-only) — OPEN PATH shows on first open

v0.16's "OPEN PATH" item sometimes only appeared after closing and reopening the vertex popup — Percepto renders the menu via React *after* `popupopen` fired, wiping our one-shot injection. v0.17 re-injects the item under a MutationObserver for the popup's lifetime (disconnected on `popupclose`), so it's reliably present on the first open.

---

## 2026-06-11 — AIM Flight Path Editor v0.16 (latest, dev-only) — OPEN PATH (un-close a snapped loop)

New companion to the splitter: reverse Percepto's native **CLOSE PATH**. Native "close" snaps a loose end onto an existing vertex (byte-identical coords) so two vertices merge and the loop closes — and there's no native way to undo it, so a segment trapped inside a closed loop can't be cleaned up if it goes unshielded. v0.16 adds an **"OPEN PATH"** item to Percepto's own double-click vertex popup (`flight-path-vertex-popup__menu`), shown only when the clicked vertex sits on a loop. Clicking it detaches the **loop-closing arc** to a fresh coordinate ~50 px off the junction (a draggable loose end), re-opening the loop.

Picking the right arc is provably safe: among the arcs meeting at that vertex it only ever detaches a **cycle edge (non-bridge)** — never a tail/bridge — so the operation can *never* sever the path into two pieces; it verifies full graph connectivity before and refuses otherwise. Same working-copy splice + validation-gate + instant-undo machinery as the segment splitter; native Save persists it, no refresh.

---

## 2026-06-11 — SOP Validators (Phase 4a) — Asset Inspector v4.2 + AIM Issues v1.02 (latest, dev-only)

First slice of the Site-Setup SOP validators. Geometric proximity checks run off the same entity data the SUM already loads and flag each violation on the map as an issue.

- **New "SOP Validators" Control Panel section** (Site Setup only) with a master toggle, per-check enable, and an **editable threshold** for each check:
  - **FFZ → Asset** standoff (default ≥ 15 ft from the asset boundary)
  - **FP → Asset** standoff (default ≥ 15 ft)
  - **FFZ ↔ FFZ** overlap / separation (default: flag overlap only; raise to flag near-misses)
- **🚩 Draw issues** runs the checks and hands each violation to **AIM Issues**, which draws the offending shape on the map authored as **"Validator"** with the note `violation: …` (includes the measured ft vs the threshold). **Clear validator issues** removes them.
- Validator issues are **ephemeral** — never saved, never synced to GitHub; re-running replaces them. (Needs AIM Issues enabled for the on-map drawing; the section + thresholds work regardless.)
- Validated offline against site 1583 (163 assets / 42 FFZs / 4 FPs): 10 FFZ→Asset and 1 FP→Asset near-misses surfaced; FFZ↔FFZ correctly clean (closest pair 62 ft).

Coworkers (prod) are unaffected — they run Asset Inspector v4.0 (no validators) and AIM Issues v1.01; the v1.02 bridge is dormant until a v4.2 Asset Inspector sends it findings.

## 2026-06-11 — AIM Map Styler v34.72 (latest, dev-only) — refresh stale asset data

The styler caches each site's asset state/equipment at load, so editing an asset in Percepto (e.g. fixing a mislabeled "- Empty") left its color/visibility stale. Two ways to refresh now:

- A new **↻ Refresh asset data** button in the **Assets** category re-pulls the entity list and recolors/re-filters immediately.
- **Shift+K** (Kick) now also force-refreshes the asset data, since that's the natural reflex.

## 2026-06-11 — AIM Map Styler v34.71 (latest, dev-only) — hide assets by type / state

Builds on v34.70's color-by-state. The **Assets** category now has **show/hide checkboxes** so you can declutter the map while building:

- **By equipment type** — one checkbox per type the site actually contains (battery, v-well, h-well, sat, …), auto-populated when the site loads.
- **By state** — one checkbox per state (Normal / Empty / Unshielded / Unreachable / HY / Inactive), sitting next to that state's color controls.
- An asset shows only if **both** its equipment type **and** its state are checked. Hiding removes the box and its halo; re-check to bring it back. Works whether or not by-state coloring is on.

## 2026-06-11 — AIM Map Styler v34.70 (latest, dev-only) — color assets by state

Assets used to all render as identical white boxes, so you had to right-click each one to know whether to build to it. New opt-in **"Color assets by state"** toggle in the **Assets** category styles every asset by its health at a glance:

- **Normal** = pink solid (with a subtle fill so the good ones pop), **Empty** = grey dashed, **Unreachable** = white dashed, **Unshielded** = orange-red dashed — plus **HY** (cyan) and **Inactive** (orange) for sites that use them.
- **Fully customizable per state:** outline color, outline width, dashed/solid, fill on/off, fill color, fill opacity. The halo/buffer tints to match the state color.
- Self-contained: the styler fetches the site's entities itself (no dependency on the Asset Inspector), derives state from each asset's subtype + unshielded flag, and geometry-matches each box to its asset. When an asset has multiple problems, the most safety-critical one wins the color (Unreachable > Unshielded > Empty > Inactive > HY > Normal).
- Toggle off = exactly the old uniform white behavior.

## 2026-06-11 — AIM Asset Inspector **v4.0 PROMOTED TO PROD** — Smarter SUM reaches everyone

The whole Smarter SUM arc below is now in **prod** — coworkers jump **v3.81 → v4.0** on the next Tampermonkey check. That's a big update: 7 new SUM columns, a frozen/resizable/reorderable table with numeric range filters, built-in + export preset views, **basestation→asset routing with a recommended-battery column** (Tattu/Tulip, editable thresholds), Base Station + Safe Zone entities with a hand-entered-altitude-vs-ground safety check, and pixel-perfect right-click on map markers. Full feature detail in the dev entry directly below. (AIM Map Nav stays dev-only / personal — not promoted.)

If anything reads oddly right after updating, an empty-cache + hard reload clears stale Tampermonkey state.

---

## 2026-06-11 — AIM Asset Inspector v3.82 → v4.0 + AIM Map Nav v0.8 (latest, dev-only) — Smarter SUM: columns, routing, battery

A large arc on the SUM (Site Setup Summary) panel — all on the `latest/` channel, **not yet promoted to prod root**. Headlines:

- **More data (v3.82):** 7 new off-by-default columns — Unshielded, Notes, Equipment, State (severity-colored), GM Group, Emergency Alt, Segment Length.
- **Table ergonomics (v3.83–v3.84):** the Name column is now a **frozen left pane**, headers **drag-to-reorder**, hover **✕** to hide a column, and columns are **resizable** (drag the right edge, double-click to reset; widths persist).
- **Numeric range filters (v3.84):** a **Ranges ▾** menu — min/max on AGL, Delta, Elevation, Route, etc. (entered in your display unit, stored in meters so a ft↔m toggle never breaks them).
- **Built-in preset views (v3.85):** read-only **★ Built-in** views above your saved ones — FP Altitude Audit, AGL Safety (<90 ft), Unvalidated Triage, Asset Roster, Shielding Review, Base Stations, Safe Zones, Route from Base.
- **Export presets (v3.87):** a **📤 Export ▾** that copies *any* preset's table (its own columns + filters) to the clipboard for Sheets without changing your live view; plus "Copy ALL (stacked)".
- **Shift-click range select (v3.94–v3.95):** click a checkbox, Shift-click another, everything between toggles — instant.
- **Basestation → asset routing (v3.88–v3.93):** a **Route** column giving each asset's one-way flight-path distance from the base (📍 Base picker auto-detects the installed type-8 base, else a "…base…" marker; closest of multiple wins). Reachability is gated on an inspection FFZ within 70 ft of the pad **edge** plus a flight path that reaches it. The big find: **FFZ connectors bridge separate flight paths** — without that the base only reached ~10 assets; with it, 32. Validated to ~0.4% against a manual measure.
- **Base Station + Safe Zone entities (v3.96):** type 8 and type 98 are now first-class SUM rows (filter chips, sortable, inspector detail, columns for ID / Altitude / Drone / Drone ID).
- **Ground-elevation safety check (v3.97):** because the base/safe-zone altitude is hand-entered, the inspector now pulls the **DEM ground** at that GPS and flags an **⚠ MISMATCH** if the stored altitude is off by >50 ft (land-into-the-ground guard).
- **Right-click precision (v3.98–v3.99):** Base/Safe/GM markers (which sit inside FFZs) are now detected **pixel-perfectly** off the marker icon, so a point only wins when you click directly on it; and the FFZ no longer false-hits outside its green border.
- **Battery recommendation (v4.0):** a **Battery** column — Tattu ≤ 14k ft, Tulip ≤ 18k ft, beyond = ⚠ out of range — with a **🔋 Battery ▾** menu to edit the thresholds. On a sample site: 25 Tattu / 5 Tulip / 2 over of 32 routable assets.
- **Map Nav v0.8:** fixed the Alt+diagonal WASD hang — ALT now `preventDefault`s so the browser can't steal keyboard focus to the menu bar.

---

## 2026-06-11 — AIM Flight Path Editor v0.15 (latest, dev-only) — pre-write validation gate + self-check

Hardening so the splitter can **never** push a malformed flight path into Percepto's state. Before any split is written, a validation gate asserts: arc/coord counts grew by exactly 1; every resulting coordinate is a finite number (also refuses to edit an already-corrupt path); the split preserves the chain `A→M→B` exactly (`am.point_a==src.point_a`, `mb.point_b==src.point_b`, `am.point_b==mb.point_a==M`); the midpoint isn't degenerate (never manufactures a zero-length arc); both halves inherit the parent's `min_alt`/`max_alt`/`min_emergency_alt`/`wait_until_approved`; the source band is strictly positive (`max>min`); and `mapobject` ownership is unchanged. **If any check fails, it aborts — writes nothing, leaves the path untouched, and shows a visible error.** A post-write self-check then confirms the edit actually landed (and rolls back bookkeeping if it didn't). `doInsert` is wrapped so a throw can't leave partial state. Backs the data-integrity write-up (`ShortKeys/AIM_FPE_Data_Integrity_Writeup.md`).

---

## 2026-06-10 — AIM Asset Inspector v3.81 (PROD + latest) — refresh cache after native saves

Native Percepto saves (including FPE vertex splits) weren't visible to the right-click inspector until you reloaded the page. Cause: the inspector caches `/map_objects/` per site on first need and never refetches on its own; the save writes Percepto's live state and the server, but the inspector's snapshot stays frozen at page-load.

**Fix:** install a one-time wrapper around `fetch` + `XHR.prototype.send` in the iframe context. Any successful `POST /map_objects/` from any source — native Save, FPE split, AI's own Apply pipeline — deletes the current site's cache and triggers a background refetch 300 ms later. Next right-click sees fresh data with no manual reload.

Coexists with v3.77's in-place cache update inside AI's own Apply pipeline (which overwrites `bucket.entities[idx]`). The wrapper-driven refetch fires shortly after, replacing the entire bucket with the server's authoritative shape — a small redundancy that means freshness is guaranteed regardless of code path.

Idempotent — guarded on `window.__aim_ai_save_invalidator_installed` so it doesn't double-wrap if AI loads twice. Logs `cache invalidated for site <id> after POST /map_objects/` when it fires, so you can see it working.

---

## 2026-06-10 — AIM Asset Inspector v3.80 (PROD + latest) — don't steal FP vertex right-clicks

v3.78 fixed the shadowing-pip bug that had quietly broken Asset/FFZ right-click since v3.67. Side effect: with the inspector hit-test now actually firing on Flight Paths, it also fired on **flight-path vertex markers** — stealing Percepto's native "delete vertex" right-click. Same for the segment-number badges (which Flight Path Editor's own right-click uses).

**Fix:** one-line bail in `installRightClickHandler`, slotted next to the existing `path[data-kml-type]` (power-line) bail. Right-click on `.map-marker__flight-path-vertex` or `.map-marker__arc-index` now falls through to Percepto / FPE instead of popping the inspector.

---

## 2026-06-10 — AIM Asset Inspector v3.79 (PROD + latest) — RIGHT_CLICK_DEBUG off by default

v3.76 left right-click debug logging on by default while we hunted the hit-test bug. Right-click is now stable since v3.78 fixed the actual root cause. v3.79 flips `RIGHT_CLICK_DEBUG = false` so the console stops spamming `RC handler fired` / `RC HIT → ...` on every right-click. The instrumentation stays in the code — opt back in with `window.__aim_ai_debug = true` if a future right-click mystery shows up.

---

## 2026-06-10 — AIM Flight Path Editor v0.14 (latest, dev-only) — quiet the phantom-guard log

The v0.13 phantom guard logged on every vertex drag, which buries the console during heavy editing. Now silent by default; set `window.__aim_fpe_debug = true` to see each block, and `window.__aim_fpe_blocked` holds a running count either way. No behavior change.

---

## 2026-06-10 — AIM Flight Path Editor v0.13 (latest, dev-only) — auto-kill the native "phantom vertex on drop" bug

Long-standing **native** Percepto annoyance (reproduces with Tampermonkey fully off): when you drag a flight-path vertex and release, a synthetic `click` fires at the drop point and Percepto spawns a stray zero-length branch vertex *on top of* the one you moved — invisible until you zoom all the way in, then you have to right-click it off. Probe traced it precisely: `mousedown` on a `.map-marker__flight-path-vertex` → drag → `mouseup` → a `click` with a large `movedΔ` → arc count ++.

v0.13 swallows exactly that click — and only that one: the press must have **started on a vertex**, the pointer must have **moved past ~5px** (a drag, not a click), and an **FP editor must be open**. Intentional click-to-add (no preceding drag), vertex-select (no move), panning, and our segment-split are all untouched, so building paths still works normally. No toggle needed — the phantom is uniquely identifiable, so it's just gone. Console logs `blocked Percepto's phantom "drop = new vertex" click` each time it fires.

---

## 2026-06-10 — AIM Flight Path Editor v0.12 (latest, dev-only) — drop the button, split on a plain segment-number click

No more ✚ toggle. A native click on a segment number does nothing (the numbers are info-only), so while you're natively editing a flight path, **a plain click on a segment number just splits it** — no button, no mode. The numbers show a copy-cursor and glow green on hover so the capability is discoverable. A small "↩ Undo split (N)" chip appears bottom-right after a split (also `window.__aim_fpe_undo()`). Both halves of a split inherit the original segment's full altitude band (`min_alt`/`max_alt`/`min_emergency_alt`/`wait_until_approved`).

---

## 2026-06-10 — AIM Flight Path Editor v0.11 (latest, dev-only) — splice the editor working copy, not hook0 (coexist with native drags)

v0.10 still couldn't split a segment *after* you dragged a waypoint ("Couldn't match segment to a path"). Root cause, nailed by probes 6–8: a native waypoint drag does **not** touch `hook0` (the site-wide entities array we were writing) — `hook0` stays at the page-load snapshot during editing. The live geometry a drag mutates, and that a Save serializes, is a **per-flight-path editor working copy**: a React `useState` (component `JBe`) whose value is the FP object itself (`{id,name,type:15,arcs,coords,…}`). We were reading the wrong state, so after a drag our arc midpoints no longer lined up with the rendered segment badges.

v0.11 finds that working copy (function-component hook whose state is a `type:15` object with `arcs`+`coords`+dispatch) and value-dispatches the spliced FP object into it. Now badge↔segment matching always agrees with what's on screen, and a split **coexists with dragged waypoints** — insert, drag, insert again, branch, Save, all without a refresh. Undo reverts the working copy.

---

## 2026-06-10 — AIM Flight Path Editor v0.10 (latest, dev-only) — fix stale-state read after an insert

v0.9 could only insert once per session: the second click failed with "Couldn't match segment to a path." Cause — React double-buffering. The Leaflet container's `__reactFiber$` pointer is the fiber that was current *at mount*; after our first dispatch the live tree became its `alternate`, but our reader kept walking the stale one, so the arc midpoints it computed were at the pre-insert geometry and no longer lined up with Percepto's (correctly re-rendered) segment badges. Fixed by resolving the **FiberRoot's `.current`** (the committed tree) and DFS-ing from there every read. Multiple inserts in a row now work.

---

## 2026-06-10 — AIM Flight Path Editor v0.9 (latest, dev-only) — click Percepto's own segment numbers

v0.8 drew its own cyan "+" handles, which (a) sat on top of Percepto's segment-number badges (hard to see) and (b) didn't follow a waypoint when you dragged it (they only rebuilt on pan/zoom). v0.9 drops our handles entirely and **piggybacks on Percepto's segment-number badges** (`.map-marker__arc-index`) — they're already at each segment midpoint, zoom-animated, and re-rendered by Percepto on every geometry change, so they never drift or overlap.

The ✚ button is now a plain **insert-mode toggle** (no more click-the-path focus step). With it on, the segment numbers glow green and **clicking a number splits that segment** at its midpoint (matched to the nearest arc in live state; native badge click suppressed in capture phase). Workflow: open the flight path's native editor → toggle ✚ → click a segment number → vertex appears live → drag/branch natively → Save.

---

## 2026-06-09 — AIM Flight Path Editor v0.8 (latest, dev-only) — SEAMLESS vertex insert (Path B), no refresh

**The refresh dance is dead.** v0.7 inserted a mid-segment vertex via `POST /map_objects/`, but Percepto caches the flight path at page load — so you had to refresh before editing natively, and a native Save on an un-refreshed insert silently overwrote it (the footgun).

**v0.8 inserts the vertex straight into Percepto's live React editor state** (the map-object array `useState` hook inside its `Route`/`g$e` component — found by walking the React fiber tree from the Leaflet container). Clicking a "+" handle splices the arc `A→B` into `A→M`, `M→B` and calls the hook's own dispatch. The new waypoint appears **instantly** as a real draggable/branchable/deletable vertex, and because the native Save reads from this same state, it **persists with no refresh**. No API POST, no pending counter, no "Refresh to apply", no footgun.

- Undo is now an instant local state-revert (stacked); or just don't Save.
- New vertices land at the segment midpoint — drag natively to fine-tune.
- Still dev-only / personal, not promoted. Reverse-engineering recon in `ShortKeys/AIM_Editor_Probe[2-5].js`.

---

## 2026-06-09 — AIM Asset Inspector v3.78 (PROD + latest) — THE actual fix: shadowing pointInPolygon

After v3.75, v3.76, and v3.77 each chasing different theories, the diagnostic for v3.77 showed: fresh-fetch pip finds `UNIVERSITY 10-3 5H` at the click coord; AI's pip on the same coord returns nothing. Identical code, identical inputs. Impossible — unless the code AI calls isn't the code we think.

It wasn't.

**Two functions named `pointInPolygon` in the same IIFE:**
- Line 766: hit-test version, `pointInPolygon(lat, lng, poly)` — 3 args
- Line 3326: overlap-self-check version added in v3.67 for the Direct-API rails, `pointInPolygon(pt, poly)` — 2 args

JavaScript function-declaration hoisting + same scope = the SECOND declaration wins for every call site. Every hit-test call was actually invoking the 2-arg version with `lat` as `pt` (a number, not an object) and `lng` as `poly` (also a number). The 2-arg version checks `Array.isArray(poly)` → false → returns `false`. Silently. For every right-click on every Asset and FFZ. Since v3.67 (mid-day 2026-06-09).

**Fix:** rename line 3326's helper → `pointInPolyPt`. Update the two overlap-check callers (`fpCrossesPolygon`). Now the hit-test calls correctly resolve to the line-766 version.

The bowtie analysis (v3.75) + sort regression rollback (v3.76) + points/coords fallback (v3.77) all still ship in v3.78 — they were defensive improvements that just couldn't fire because every pip call was hitting the wrong function. With the shadow fixed they now actually run.

Diagnostic value: v3.76's debug logs + v3.77's diagnostic snippet were the only way to localize this — without them we'd have kept guessing at the polygon shape or the cache contents. Lesson for the next time: **when "fresh code returns X, AI returns Y" with identical inputs, suspect name collision in the script body before suspecting the data**.

---

## 2026-06-09 — AIM Asset Inspector v3.77 (PROD + latest) — points→coords fallback for Apply'd entities

**Real root cause found.** Right-click on Assets/FFZs at Exxon site 1599 was failing for entities AI had hit-tested fine before. v3.76's debug logs caught it: AI's pip on the cached entity returned no match, but a parallel pip on a fresh live fetch of the same entity DID find it. Same code, same coords, different result → cache must hold different data than the live response.

**Diagnosis:** The Direct-API Apply pipeline (shipped in v3.67-v3.74) POSTs entity changes to `/map_objects/` and overwrites `bucket.entities[idx]` with the server's echoed entity. The server's echo is in **WRITE shape** (`.points` instead of `.coords`). After any Apply run, those cached entities had `.points` set but `.coords` missing. `findEntityAtLatLng` checked `Array.isArray(e.coords)` → false → skipped the entity → "no entity at lat,lng" bail → browser context menu won. Silent hit-test rot, growing worse with every Apply.

**Fix (two layers, defense in depth):**
1. **`entityCoords(e)` helper** — returns `e.coords` if it's a non-empty array, falls back to `e.points`. Used everywhere we'd reach for `e.coords` in hit-test: type 3 (Asset) / type 4 (NFZ) / type 16 (FFZ) polygon test, type 15 (Flight Path) coords-fallback when arcs absent, type 19 (General Marker) distance test.
2. **Alias at the cache-mutation point** — when `bucket.entities[idx] = saved` runs in the Apply pipeline, if `saved.coords` is missing but `saved.points` exists, set `saved.coords = saved.points` BEFORE storing. Logs `Direct-API echo missing .coords, aliasing .points → .coords for <name>` so we can see future cases of this.

Coworkers right-clicking on an asset that previously had altitude-Applied: works again. Future Apply runs: no rot.

(v3.76's debug logging stays in place — `RIGHT_CLICK_DEBUG = true` const — so if a similar mystery surfaces we triage in one round instead of three.)

---

## 2026-06-09 — AIM Asset Inspector v3.76 (PROD + latest) — Right-click hit-test rollback + debug logs

v3.75 used angular-sort polygon as the SOLE hit-test path. Turned out the sort regressed some normal FFZs (specifically `freezone_4` in site 1599) — their sort produced a polygon shape that excluded the click point the raw polygon included. Result: right-click missed valid FFZ entities.

v3.76 makes it **raw-first, sort-fallback**:
1. `pointInPolygon(lat, lng, e.coords)` on the raw vertex order (matches v3.74 behavior, works for all normal polygons).
2. If raw misses, `pointInPolygon(lat, lng, simplifyPolygon(e.coords))` on the angular-sorted polygon (covers Percepto's bowtie-shaped well-pad coords).

Same effect as v3.75 for bowtie wells, but no regression for normal FFZs.

**Debug logging added** to the right-click handler so we can diagnose future "browser menu appears instead of Inspector popup" reports. Every bail logs its reason (`[AIM INSPECT IFRAME] RC bail: master OFF`, `bail: no entity at <lat>,<lng> — bucket has N`, etc.). Default ON in v3.76 (`RIGHT_CLICK_DEBUG = true` at top of `installRightClickHandler`); flip to `false` once stable. Also catchable from outside via `window.__aim_ai_debug = true` (when the const is false).

---

## 2026-06-09 — AIM Asset Inspector v3.75 (PROD + latest) — Right-click finds well-pad assets again

Bugfix. Right-clicking Assets and FFZs on some sites (notably Exxon-style well pads with horizontal-drilling sites) brought up Chrome's native context menu instead of the Inspector popup. Flight Paths kept working.

**Cause:** Percepto stores well-pad asset polygons as `[NE_corner, well-head-point, SE_corner, SW_corner, NW_corner]` — i.e. the 4 corners of the pad PLUS the surface well-head as an interior 5th vertex. In that raw vertex order the polygon is self-intersecting (a "bowtie"), which makes standard ray-casting return nonsense. AI's hit-test ran ray-cast on the raw coords, missed the entity, fell through, native menu won.

**Fix:** `simplifyPolygon()` — sorts vertices by angle around the centroid before pip-testing. Converts any star-shaped polygon (which well pads + reasonable FFZs all are) into a proper simple polygon. Now ray-cast works correctly on these.

Applied to Asset (type 3), NFZ (type 4), and FFZ (type 16) hit-tests. Flight-path hit-test unchanged (already used per-segment distance, not pip).

---

## 2026-06-09 — AIM Asset Inspector v3.74 (was 3.59) — ⚡ bulk altitude editing that actually saves, + 30 ft SOP default

Big jump for the Inspector — everything from the dev line lands for everyone. Headline: **bulk Min/Max altitude edits now apply in one shot**, even across the FFZ↔Flight-Path overlap rules that used to make a bulk save impossible.

- **⚡ Direct API apply (opt-in).** Tick "⚡ Direct API" in the Apply launcher and queued altitude edits are written straight to the server instead of opening each entity's editor one by one. This sidesteps the "Mismatched Altitude Ranges" wall that blocked bulk AGL/DELTA shifts (raise the zones and the path together — it just goes). Four safety rails: a **rollback file is downloaded before any write**, every write is **verified**, a final **FP↔FFZ overlap self-check** runs, and a **Dry Run** previews everything with zero writes. One-click **↩ Roll back this run** in the report.
- **Auto-bridges terrain seams on flight paths.** When AGL-following over a hill would leave two connected segments without an overlapping band (the server rejects that), it nudges *only the ceiling* up at the seam so the path stays continuous — your AGL floor is untouched. Branch points included.
- **Bulk → Delta now defaults to 30 ft** for both Flight Paths and Free Zones (new SOP), with the 2 m overlap as slack. Both boxes are still editable per run.
- Clearer apply progress (Back up → Update → Safety check phases, counts in entities not raw edits) and a richer completion report.

Carries forward everything from 3.59 (right-click inspector, SUM panel, 📊 Site Summary, Find in Map Entities, etc.).

---

## 2026-06-09 — AIM Issues v1.01 — 🚩 flag mode no longer needs Map Styler enabled

- **Fix:** placing an issue on the map (left-click the 🚩, "flag mode") would report **"Map not ready"** and refuse to activate for anyone whose Map Styler master toggle was OFF. Right-clicking the 🚩 (the issues menu) was unaffected. Cause: AIM Issues found the Leaflet map only via a container tag that *Map Styler* sets, and Map Styler only sets it while it's enabled — so with Map Styler off, the map was never tagged and flag mode couldn't find it. AIM Issues now installs its own map-detection hook at startup, so flag mode works whether or not Map Styler is enabled or installed.

---

## 2026-06-08 — AIM Site Watch v0.1 (NEW SCRIPT, DEV/personal) — adaptive site-setup change auditor

Brand-new background auditor (dev/personal, `latest/` only — not enabled for coworkers). Polls every site's setup JSON from your own logged-in session and records what changed over time.

- **Adaptive schedule** per site: COLD (checked daily) until a change, then HOT (every 3h) on a rolling 24h window that resets on each new change, then back to COLD. Most sites stay COLD, so hundreds of sites cost only a handful of fetches per hour. All intervals configurable in the Control Panel ("Site Watch").
- **Cheap detection** — JSON normalized (keys sorted) + SHA-256 hashed; only the tiny hash is kept locally to decide changed/not.
- **On change** — diffs against the previous snapshot and appends field-level rows (`what was / what is / when`) to `site-watch/changes.csv`, plus stores the new JSON as `latest.json.gz` + a 10-deep rotating snapshot ring, committed to the private `aim-userscripts-data` repo.
- **Robust by design** — auth-loss freeze (weekend logout never corrupts baselines, resumes Monday), timestamp scheduler with wake catch-up (nightly sleep just delays), single-tab leader lease (only one tab polls). Optional Slack webhook on change (set in the panel when available).
- **v0.2 (same day)** — per-site progress logging during a cycle (baselining no longer looks frozen) + a 20s abort timeout on every Percepto fetch so one hung site can't stall the whole cycle. First live run enumerated 443 sites correctly.
- **v0.3 (same day)** — fix a leader-lease deadlock: refreshing the page left a stale lease from the old (now-gone) tab that blocked the new one for up to 45 min, so cycles silently never ran. Now: lease frees on `pagehide` (refresh/close), short 90s TTL + 30s heartbeat re-elects a vanished leader, "Check all due now" steals leadership to the clicking tab, and standing-by now logs instead of going silent.
- **v0.4 (same day)** — new **"Show status (console)"** button in the panel: dumps a `console.table` of every site checked so far with its COLD/HOT state, last-checked / next-due time, and snapshot count, plus a one-line summary (N/443 checked · X HOT · due now · paused · leader).

## 2026-06-08 — Map Styler v34.69 (DEV) — Saving a drawn line creates the KML if it's missing

Follow-up to v34.68. Pressing ✓ to save a drawn power line on a site with no KML used to fail with a 404 (the commit fetches the file's SHA first, and there's no file). Now the save **self-heals**: if the file doesn't exist and you're only adding lines, it creates `<siteID>-<type>.kml` from a blank skeleton with your drawn lines baked in (single create instead of failing). This covers a line drawn before the file existed, a leftover pending line from earlier, or a declined create-on-draw prompt. (DEV-only.)

## 2026-06-08 — Map Styler v34.68 (DEV) — +D / +T offers to create a blank KML when none exists

When you press **+D** (distribution) or **+T** (transmission) in the Power Line Editor strip on a site that has **no power-line KML yet**, the styler now warns you instead of silently dropping you into draw mode (where a commit would later fail). You get a prompt: *"No distribution power-line KML exists for this site yet — if you already have power lines, upload the KML to the data repo first; otherwise click OK to create a new empty one now and start drawing."* OK creates a blank `<siteID>-distro.kml` (or `-trans.kml`) in the data repo and drops you straight into draw mode — draw, then ✓ to commit as usual. Use this for new areas with no existing lines, or new transmission lines that aren't in the repo yet. (DEV-only — Power Line Editor is dev-only.)

## 2026-06-08 — Map Styler v34.67 — KML shielding now renders on entity-less sites

Fixes power-line / shielding KMLs not appearing on **brand-new sites that have no native entities yet** (no FFZs, flight paths, or assets — e.g. a site that's just ortho + power lines). Leaflet only creates its overlay `<svg>` the moment the first vector layer is added, so on an entity-less site the styler had nowhere to draw — the KML loaded fine (hundreds of lines) but rendered nothing until you dropped any entity. The styler now forces Leaflet to create the overlay SVG itself (`L.svg().addTo(map)`) whenever it has KML features to draw, so lines appear immediately on a fresh site. Shipped in both root (prod) and `latest/` (DEV).

## 2026-06-08 — Asset Inspector v3.66 (DEV) — Tab walks the column for Min/Max/AGL + Bulk → Min / Bulk → Max

- **Tab now goes down.** When editing a **Min Alt / Max Alt / AGL** cell, **Tab** commits and drops to the same column on the next editable row (**Shift+Tab** = up, **Enter** = commit + done). Previously Tab just closed the editor — only the Subtype/Name columns had the row-walk.
- **Bulk → Min** and **Bulk → Max** buttons (next to Bulk → AGL/Delta) — set an *absolute* Min or Max altitude across all FP segments + FFZs (or just the selected rows), with a live "will queue N · skipping M already at target" preview. Accepts formulas (e.g. `2650+50`). Queues through the same pending/Apply pipeline as the inline edits.

## 2026-06-08 — Asset Inspector v3.65 (DEV) — Saved view presets (columns + filters + sort)

New **Presets ▾** button in the Site Setup SUM toolbar (next to Columns ▾). A preset saves your whole view — **visible columns + order, the type filter, the validation filters, the sort, and ft/m** — so you can flip between layouts without re-toggling everything by hand:

- **Apply** any saved preset with one click; **⟳** overwrites it with the current view, **×** deletes it.
- **＋ Save** the current view under a name (inline — no popups). Saving an existing name updates it.
- **↺ Default view** — back to all columns, no filters, default sort, feet.
- Ships with one example preset, **"GMs · Name/Lat/Long"** (General Markers only, just those three columns) — exactly the "switch to GMs, Copy → Sheets, switch back" workflow. Presets are per-user and global across sites; search text is intentionally not captured (it's per-task).

(Mission Bank Tools' detail table doesn't use the same column system yet — presets there are a possible follow-up.)

## 2026-06-08 — Lat / Long / GPS columns — Asset Inspector v3.64 + Mission Bank Tools v0.72 (DEV)

Both SUM tables get three coordinate columns:

- **Lat** and **Long** — click *or* right-click copies the raw number (6-decimal). In Site Setup these show for **point entities only (General Markers + Assets)**; lines/polygons (FP/FFZ/NFZ) stay blank. In MBT they show for every GPS step.
- **GPS** — shows the **`lat, lng` pair (6 decimals)** as the clickable link: **left-click opens Google Maps in a new tab**, right-click copies the link. (Replaces MBT's old combined Location column.)
- Lat/Long/GPS are included in the CSV/TSV exports too.

**Coming next:** making Lat/Long **editable** (M1) to move a marker / waypoint — held as a fast-follow while I confirm Percepto's editors expose a numeric lat/lng field (vs map-drag). For now these columns are read/copy/link only. Dev-only in `latest/`.

## 2026-06-07 — Mission Bank Tools v0.70 (DEV) — Editable AGL + Bulk → AGL/ALT + row selection (Site Setup SUM parity)

The Mission Summary step table now matches the **Site Setup SUM** for altitude editing:

- **Editable AGL Δ cell** — click the AGL number and type a target clearance; the altitude back-solves to *ground elevation + AGL* (just like editing AGL on Site Setup sets Min Alt = Elevation + AGL). Editing the Value cell and the AGL cell now stay in sync — change one, the other follows. Right-click still copies the raw AGL; formulas (`100+10`) work.
- **Row-selection checkboxes** + select-all (respects the active type filter).
- **Bulk → AGL** and **Bulk → ALT** buttons (gold, like the Site Setup bulk toolbar). Scope mirrors Site Setup: **nothing selected → all visible editable steps; any selected → just those.** Bulk → AGL recomputes each step's altitude from its *own* ground elevation; Bulk → ALT sets one absolute altitude.
- **Keyboard:** **Tab** commits and moves to the next editable cell in the *same* column (Value→Value, AGL→AGL — no longer hops columns); **Enter** commits and finishes (no advance); **Esc** cancels.
- **Filter chips:** **right-click (M2)** a step-type chip to solo *only* that type (like the Site Setup type chips), instead of toggling each on/off.

Everything queues through the existing pipeline — so per-step **Commit** and **⚡ Fast bulk save** apply unchanged, with the same strict/fail-closed safety. Dev-only in `latest/`.

## 2026-06-07 — Mission Bank Tools v0.68 (DEV) — Fast bulk altitude save (interceptor, opt-in) + per-step persistence fix

Bulk-editing 30-50 step altitudes via the per-step dialog is ~1-2s/step. New **⚡ Fast bulk save** option: stage your altitude changes in the SUM table, flip the toggle in the pending banner, then **Save the mission** — all staged changes are spliced into that one save request at once (instant). Built on measured per-type rules: snapshot → set altitude; navigate → set altitude + drop "use freezone min". Safety: **OFF by default and resets every reload** (a save is never modified unless you opt in that session), strict unique matching (location + original value — skips anything ambiguous), **fail-closed** (any hiccup → your original save goes through untouched), and a "patched N (skipped M)" toast + per-step console audit. Only ever changes the altitude (+ the one navigate flag) on steps you staged; Site Setup still governs the flight envelope. Per-step **Commit** stays as the in-form alternative. Dev-only in `latest/`.

## 2026-06-06 — Install pages revamp — guided setup wizard + plain-English tool guide

No script changes — the GitHub Pages site (https://ned-yap.github.io/aim-userscripts/) got a big friendliness overhaul for non-technical coworkers.

- **Install page** slimmed to a simple, dummy-proof 3-step layout (Tampermonkey → tools → token) with screenshot drop-zones, the full 19-script list tucked behind one expander, and all the fiddly bits in a quiet "More help" area.
- **New guided setup wizard** — the "Set it up →" button now launches a one-question-at-a-time walkthrough that asks "did it work?" at each step: **Yes** advances, **No** drops into an automated troubleshooting mini-chat. Shows only the current step, nothing else.
- **New tool guide** (`guide.html`) — every tool as a tappable card grouped by job (drawing/measuring, looking things up, bulk editing, getting around, etc.), each with **How to use it**, **Everything it can do**, and **Good for**. Expand-all / collapse-all included.

## 2026-06-06 — AIM Defaults v1.0 (NEW SCRIPT) — smart site navigation + map-layer defaults

Brand-new script that automates the repetitive navigation + layer chores. Configurable in the AIM Control Panel (new "AIM Defaults" section, Navigation / Map Layers).

**Smart navigation:**
- Pick a site from the **landing search** → lands straight on your default section (Site Setup for CSMs), skipping the slow Data Map detour.
- **Switch sites via the in-page dropdown** → keeps you in the *same* section on the new site (Mission Bank → Mission Bank, etc.). Session memory; toggle it off to always use the default.
- Smart enough to redirect site-unique deep links — e.g. switching sites from a specific **past mission** sends you to that site's **Mission Log** instead of a dead link.
- Default section is configurable (Site Setup / Data Map / Mission Bank / Insight Manager / Dashboard), so non-CSM roles can pick their own.

**Map-layer defaults** (on each new site): auto-turn-off any layers you choose (Street labels / Site setup / General markers / Assets / Feeder Line / Map) and the **Feeder Line bring-to-top** fix (off→on so it draws over the ortho) — done automatically instead of by hand every time.

Notes: settings are personal (Control Panel). The nav fix relies on `localStorage` (Percepto wipes `sessionStorage` mid-session). Dev copy in `latest/` too.

## 2026-06-06 — AIM Bulk User Sites v1.10 (NEW SCRIPT) — bulk-fill the admin User↔Site page

Brand-new script for the Django admin **User Site batch create** page (`/admin/percepto/usersite/batch_create/`). That page's Users/Sites pickers are giant native multi-selects with no real search — you had to click-and-type fast or Ctrl+F your way through. This replaces all of that with a floating panel (**⚡ Bulk Fill** button next to Create, or **Shift+B**):

- **Paste** emails (Users) and site names (Sites), one per line → **Apply** selects every exact match in the real lists (case/space-insensitive). Unmatched lines are reported, never silently dropped. **Apply & Create** also clicks the page's Create.
- **Live search** for both lists — substring match, so `@example.com` surfaces every user on that domain. Click / Enter to add one, **➕ Add all matches** to add every match at once, **✗ Clear box** to reset.
- **Favorites** per list — pin the people/sites you add over and over; checked pins go in on every Apply. **✓ All / ✗ None** to toggle, **Edit** mode for delete (✕) + drag-to-reorder.
- **Presets** — save a named group of users + role; Load checks matching pins and drops the rest in the box. For onboarding the same teams repeatedly.
- **Role** defaults to *Percepto Admin*.

Personal-only (favorites/presets live in your Tampermonkey storage; nothing synced). Admin-page only — does nothing elsewhere. Dev copy in `latest/` as well.

## 2026-06-05 — Mission Bank Tools v0.54 (DEV) — force the form-model commit

Diagnostics (v0.53) proved the altitude input was set correctly to the new value and *held* it — but Save still persisted the original. That means the synthetic `input` event wasn't reaching Ant InputNumber's React `onChange`, so the form's committed value never changed (box showed new, model held old). v0.54 calls the input's React `onChange` prop **directly** (same fiber/props trick as the radio handler) and adds an **Enter** keypress to commit + mark the field dirty. Also logs the Save button's disabled state to confirm. Test path unchanged: queue → Commit → check the step holds before saving the mission.

## 2026-06-05 — TDZ fixes + MBT save diagnostics (DEV)

- **Perf Shield v1.14** — fixed a second load-time TDZ (`notifObserverInstalled` referenced before init); moved it up with the other pre-init state. The notification kill now initializes cleanly.
- **Quick Mission Editor v0.3** — fixed a TDZ crash in the launcher (`launcherLabel` used before its `const`), which was throwing on every Mission Bank load and could block the launcher.
- **Mission Bank Tools v0.53** — snapshot altitude still wasn't saving after v0.52 (value visibly changes but reverts). Added always-on `[edit][diag]` logging to the commit path (candidate inputs + their values, the chosen input's before/after value, and a +400ms revert check) to pinpoint whether it's matching the wrong input, the value reverting, or save not committing. No behavior change yet — diagnostics to nail the fix.

## 2026-06-05 — Mission Bank Tools v0.52 (DEV) — snapshot altitude actually saves

Fixed SUM-table altitude commits not sticking — the step would revert to its original value (0) the moment the instruction saved, before you even saved the mission. Root cause: Ant InputNumber holds the typed value in an internal buffer and only commits it to the form on **blur**; MBT's value-setter dispatched `input`+`change` but no blur, so Save read the original. Added the trailing `blur` (matching the Asset Inspector's working Apply). Note: you still save the overall mission yourself after the queue finishes — MBT commits each step into the mission draft. Dev-only in `latest/`.

## 2026-06-05 — Asset Inspector v3.62 (DEV) — SUM Apply picks the exact entity

Fixed SUM-table **Apply** opening the wrong entity when names share a prefix. Searching the sidebar for `freezone_2` filters to everything *containing* it (`freezone_2`, `freezone_20`, `freezone_21`, …), and the old code clicked the first row — often the longer name — so the edit landed on / was rejected for the wrong FFZ (red toast). Apply now matches the row whose **name exactly equals** the target (comparing the inner name span, not the whole row), falling back only to a lone filtered row. Affects every type with prefix-overlapping names (FFZs, assets, FPs), not just FFZs. Dev-only in `latest/` — promote to root with the other apply fixes.

## 2026-06-05 — Right-click fixes + mission-notification kill (DEV / Latest)

Three annoyances fixed:

- **Asset Inspector v3.61** — right-clicking the **gear / 🚩 Issues / ⚡ Power buttons** (in `.map-tools`) no longer pops the asset inspector for the entity *behind* the button; the button's own M1/M2 action runs. The inspector also bails when you right-click a **power-line** (`path[data-kml-type]`), so Map Styler owns that contextmenu (vertex delete / hide menu) even when an asset/FFZ/FP overlaps the line. Two new DOM-target guards on the capture-phase contextmenu handler, mirroring the existing Issues-icon bail.
- **Perf Shield v1.12** — new **"Mission notifications → Kill mission toasts"** toggle (off by default). Hides Percepto's pilot toasts ("Drone took off", "Snapshot taken", …) that stole focus, blocked button clicks, and chimed. CSS hides the toast stack; an `HTMLAudioElement.play()` patch silences the chime while the toggle is on. For site builders who aren't flying.

**Update (same day):** the right-click guards are now **promoted to PROD as Asset Inspector v3.59** — coworkers get the fix at their next Tampermonkey check (the gear/🚩 button steal + power-line steal both affected them too). The mission-notification kill stays dev-only for now. **Perf Shield bumped to v1.13 (DEV)**: fixed a load-time TDZ error (`NOTIF_BLOCK_STYLE_ID` referenced before init), and the chime suppressor is now **scoped to the toast** — it only mutes audio coinciding with a notification appearing, so your other audio keeps playing.

## 2026-06-04 — Asset Inspector v3.60 (DEV / Latest) — GM radius circles in KML export

Site Setup Analyzer (Site setup → KML) gains an **off-by-default "GM Radius Circles"** option. When enabled, configurable-radius flat ground circles are drawn around every General Marker and emitted in their own `General Marker Radius Circles` folder. Each radius defaults to **0.5 mi** and accepts **miles or feet** via a unit dropdown; the control block only appears when the toggle is on.

**v3.60 — multiple rings.** A **+ Add ring** button adds more radii (new rows default to the next preset: 0.5 / 1 / 5 / 10 mi). Each ring is its own GE subfolder. A single ring keeps its faint fill; **multiple rings render as outlines only** (same purple) so overlaps stay readable. Each row has a × to remove it (last row can't be removed). Circles are clamped to ground (horizontal buffer) in both 2D and 3D exports. Dev-only in `latest/` — not yet promoted to coworkers.

---

## 2026-06-03 — AIM Issues v1.00 PROMOTED TO PROD

Big release — coworkers update at the next Tampermonkey check (or use the dashboard's "Check for userscript updates" to grab it now). Jumps prod from v0.27 → v1.00 in one bundle. Includes everything from v0.28 → v0.31 PLUS the v1.00 oversight redesign + activity indicator (see entries below for full feature lists).

**Heads up for coworkers when you update:**

- **The flow is different now.** Instead of clicking Ignore or Resolve directly, you'll see **Propose Ignore** (purple) or **Propose Fix** (yellow). The issue stays visible (in its new pending color) until an approver accepts or rejects it. This is intentional — it gives someone a second pair of eyes before issues are silently dismissed.
- **If you're an approver** (currently: PaydenW-Percepto, Ned-Yap — add yours by editing `approvers.json` in the data repo or asking Iden), you'll see direct-action buttons that skip the pending step, plus Approve / Reject on whatever others have proposed.
- **Green ? badges**: when something happens on an issue you haven't looked at since (comment, transition, priority change), a pulsing green ? badge appears on the map marker and the panel row. Open the issue to clear it.
- **Comments + Priority**: new in this batch. Add comments without changing status. Set priority high/medium/low; filter the panel by priority.
- **Floating status modal**: M2 on an issue no longer dims the whole map — it pops a draggable / resizable window in the bottom-right by default. Move it where you want; its position persists.

**If you preferred the old direct flow** — open an issue and tell Iden. Either you can be added to `approvers.json` (you'll have the direct-action buttons) or we can rethink the oversight rule.

---

## 2026-06-03 — AIM Issues v1.00 (DEV) — Approver oversight + activity indicator

Major redesign of the AIM Issues state machine. CSMs no longer directly ignore or resolve issues — they **propose** changes and an approver accepts or rejects them. Switches the version scheme to X.YY (`major.minor`) starting now; this is v1.00 because it's a sweeping interface change.

**New state machine:**
- `open` (red) — initial state, also where rejections land
- `pending_fix` (yellow #FFD700) — CSM proposed fix, awaiting approver review
- `pending_ignore` (purple #8000FF) — CSM proposed ignore, awaiting approver review
- `resolved` / `ignored` (grey) — approved by an approver
- Existing `ready-for-review` issues are grandfathered (still render, can transition); chip is hidden in the panel when count is 0.

**Role gating:**
- Approver allowlist lives in `aim-userscripts-data/approvers.json` (seeded with Iden; add boss + others via PR or GitHub web UI). Loaded with the existing PAT, cached in GM storage so role survives refresh-without-network.
- **CSMs** see `→ Propose Fix` (yellow) and `→ Propose Ignore` (purple) buttons on open issues. On pending issues they see a "⏳ Awaiting approver review" banner instead of action buttons.
- **Approvers** see direct-action `✓ Resolve (direct)` and `⊘ Ignore (direct)` on open issues — bypassing the pending step. On pending issues they see `✓ Approve` (green) and `✗ Reject` (red) buttons.
- Modal header now shows a role chip — `✓ APPROVER` (green outline) or `CSM` (grey) — so you know at a glance what buttons you have access to.

**Self-approval block:** scaffolded but disabled (`SELF_APPROVAL_BLOCK_ENABLED = false`). When the team grows past a single active reviewer, flip the constant and approvers will be blocked from approving their own proposals (toast: "You can't approve your own proposed change…"). Today's single-active-reviewer setup keeps it off so the bypass works.

**Activity indicator (pulsing green ?):**
- Per-user lastSeen timestamp stored in `localStorage` (key `aim-issues-lastseen-<username>`). Excludes your own actions — only OTHERS' events trigger the pulse.
- Map marker: small pulsing green ? badge in the top-right corner of the icon when there are unseen history entries.
- Panel row: green ? chip next to the issue's last-event label; native tooltip on hover summarizes the unseen events.
- Map-marker tooltip on hover: green-bordered "🟢 New since you last looked (N)" block listing the most recent 5 events.
- Clears the moment you open the issue's status modal.

**Panel changes:**
- New chips: `PENDING FIX` (gold) and `PENDING IGNORE` (purple).
- **Pending my review** shortcut chip (approvers only — green dashed border, ⚡ icon). One click solos both pending status filters; click again restores the full set.
- Filter chips now hide the legacy `READY FOR REVIEW` chip when no issues are in it.

**Toolbar 🚩 badge:**
- For approvers: when pending issues exist, the badge morphs from red+total-count to **orange+pending-count** so "stuff awaits your review" is visible at a glance from the toolbar. Falls back to plain red total when no pending work.

**Carried forward unchanged:** tombstone deletes, history-union merge, push-back-after-merge sync, dedicated panel, /map_objects affected-entities, entity-pill M1 copy / M2 sidebar, Sheets HTML export, priority field + filter chips, floating draggable status modal, history sort toggle.

**Promotion plan:** v0.31's dev-only batch (Comments, Priority, Priority filter, floating modal) + this v1.00 oversight redesign all stay in `latest/` until tested in dev. Prod stays at v0.27 until promote.

---

## 2026-06-02 — AIM Issues v0.31 (DEV ONLY) — History grows with modal height

v0.30's status modal was resizable but the history container had a hardcoded `max-height:200px` so resizing the modal taller didn't give you more history rows — just more empty space. v0.31 drops the inner max-height; history now grows with the modal, and the modal body's own scrollbar handles overflow.

---

## 2026-06-02 — AIM Issues v0.30 (DEV ONLY) — Status modal is now a floating window

The M2 status modal was a full-screen overlay that dimmed the map and blocked review. v0.30 turns it into a real floating window:

- **No more backdrop dim** — the map stays visible behind the modal
- **Draggable** — header bar (Issue / status / priority chip / ✕) is a drag handle. `cursor:move` on hover.
- **Resizable** — red striped corner handle at the bottom-right (same look as the panel)
- **Defaults to bottom-right** corner of the viewport so it doesn't cover whatever you just right-clicked
- **Persists size + position** to `localStorage` (key `aim-issues-statusmodal-layout`) so it opens where you left it across refreshes
- **Body is scrollable** with a fixed header + footer — long histories don't push the action buttons off-screen
- New small ✕ button in the header (in addition to the Close button in the footer)
- Esc still works — armed → cancel, otherwise close

**History sort toggle**: clicking the "History" title cycles the sort direction. Default = oldest first (▲); click → newest first (▼); click again → oldest first. The arrow + "oldest first / newest first" label shows current direction. Direction is per-modal-session (not persisted — defaults to oldest-first on each open).

---

## 2026-06-02 — AIM Issues v0.29 (DEV ONLY) — Priority filter + clickable Site Name

Two tweaks. `latest/` only.

- **Priority filter chips row** in the panel under the status chips. Four chips: `🎯 HIGH` / `🎯 MEDIUM` / `🎯 LOW` / `— NONE` (for issues with no priority set). Same UX as status chips: M1 toggle individual, M2 solo. Default all 4 active. Counts in each chip update live.
- **Sheets export — Site Name is now a clickable link** to the site-setup URL (`https://percepto.app/#/site/<id>/control-panel/site-setup`). Pasting into Google Sheets or Excel produces a hyperlink cell that displays the friendly name (`Exxon - Lille Midkiff 5`) but clicks through to the site. TSV fallback stays plain text.

---

## 2026-06-02 — AIM Issues v0.28 (DEV ONLY) — Comments + Priority

Two requested features. `latest/` only — prod still on v0.27.

### Comments
- New `💬 Add comment` button in the status modal alongside transition buttons
- Required note; doesn't change status
- Appends a history entry with `kind: 'comment'` and `fromStatus === toStatus`
- Renders as `💬 Commented` in the audit log + last-event label

### Priority (high / medium / low / none)
- New `priority` field on each issue (default `null`)
- Picker chips in the create modal (None / Low / Medium / High)
- Priority chips in the status modal — click to arm a change, optional note, Confirm
- History entry on change: `kind: 'priority'` + `fromPriority` + `toPriority`
- Display: tooltip header chip, status modal header chip, panel row chip, Sheets export adds `Priority` (color-coded) + `Comments #` columns

### Internal
- `PRIORITY_LABEL` map (color / textColor / rank / short)
- `applyComment(issueId, note)` + `applyPriorityChange(issueId, newPriority, note)` — same audit + sync shape as `applyTransition`
- Status modal's `armed` state polymorphic: transition object | `{kind:'comment'}` | `{kind:'priority', to:X}` | null
- `lastEventLabel` + history rendering distinguish 5 entry types: created / transition / comment / priority / deleted

### Skipped
- **Notifications** — punted this session. Real push needs a backend (Slack webhook or similar); browser-only via polling could come later.

---

## 2026-06-01 — AIM Issues v0.27 — push-back-after-merge for history deltas

Two-tab ignore: after both tabs ignored a shared issue, Tab 2's "Ignored 2" stayed local-only and never propagated. Root: `refetchIssues` only pushed back when `localOnlyCount > 0` (entirely-missing issues). Didn't detect **history deltas** — issues that exist in both local and remote but local has MORE entries.

Fix: also count `historyDeltaCount` (any merged issue's history longer than remote's) and `tombstoneDeltaCount` (local-deleted, remote-not). Push back if any are non-zero. Now both tabs converge on the unified history after either refreshes.

---

## 2026-06-01 — AIM Issues v0.26 — merge diagnostics

User reported 2-tab ignore-overwrite still happening after v0.24's history-union fix. Code path looked correct on paper but data wasn't showing the issue clearly. Added three diagnostic log lines so the next test reveals exactly what's happening:

- `mergeIssueObjects(id): local hist=A + remote hist=B → merged=C, status=X` — per-issue merge
- `mergeIssueLists: local=A + remote=B → C` — totals
- `PUT (reason) sha=X hist counts: id1:Nh id2:Mh` — what's actually being uploaded

Logs helped pin v0.27's root cause: merge was correct but the result was never PUSHED back.

---

## 2026-06-01 — AIM Issues v0.25 — tombstone-based delete (survives merges)

User deleted the same issue 3 times; each refresh brought it back. Classic distributed-sync bug — when one tab deletes and another tab still has the issue + commits something else, the conflict-merge sees "remote: gone, local: present → keep it (local-only)" and the delete gets undone.

Fix: **tombstones**. Deleting a synced issue now sets `deleted: true` + `deletedAt` + `deletedBy` on the issue object instead of removing it from the list. The tombstone propagates to GitHub like any other change and survives subsequent merges via a **delete-wins** rule in `mergeIssueObjects` — if either copy has `deleted: true`, the merged result is also tombstoned (with the earliest `deletedAt` as the canonical record).

Tombstones are also appended as a history entry (`fromStatus: <prev>, toStatus: 'deleted'`) so the audit log shows the deletion.

Display: tombstoned issues are filtered out everywhere they'd be visible — map render, panel rows, chip counts, badge, "N total" header, empty-state check, createIssue toast count. A new `liveIssues(list)` helper does the filter.

Storage + GitHub: tombstones STAY in `currentSiteIssues` and in the PUT payload (that's the whole point — they need to propagate). Only `local-only` issues (which never sync at all) are still removed outright on delete.

**Note on the 2-tab ignore-overwrite bug**: that was v0.24's history-union fix. If you tested before v0.24 landed in Tampermonkey, the fix wasn't live yet. After v0.25 auto-updates (or you manually trigger update), both bugs should be resolved together.

---

## 2026-06-01 — AIM Issues v0.24 — concurrent transitions both kept

Two CSMs each opened the same issue from stale views and ignored it with different notes. One transition was kept, the other discarded.

Root cause: `mergeIssueLists` picked whichever WHOLE issue object had the later `history[last].at` — so A's whole copy (including A's history entries) was thrown away in favor of B's whole copy. Meant the audit log lost A's transition entirely.

Fix: for same-id issues, **merge histories** instead of picking one whole object.

- `mergeHistoryArrays(a, b)` unions both histories, dedupes by `at|by|fromStatus|toStatus|note`, sorts chronologically
- `mergeIssueObjects(a, b)` merges histories + recomputes current `status` from `history[last].toStatus`. Immutable fields (polygon, note, surface, shape, createdAt, createdBy, id) are identical in both copies so taking either is fine
- Result: A's `[created, ignored-by-A]` + B's `[created, ignored-by-B]` → `[created, ignored-by-A, ignored-by-B]`. Both transitions preserved in audit log. Final status = ignored (whichever was last by timestamp).

Edge: if two CSMs reach DIFFERENT terminal states on the same issue (one resolves, one ignores), the merged status is whichever happened last by browser clock. Audit log shows both — user can re-open from either terminal state to re-arbitrate.

---

## 2026-06-01 — AIM Issues v0.23 — icon always inside the polygon

For L-shaped, C-shaped, or any concave polygon, the arithmetic centroid can fall OUTSIDE the polygon (the empty corner of the L). User reported the ⚠ icon landing outside the dashed outline. Fixed with `bestInteriorPoint()`:

1. If the arithmetic centroid is inside the polygon → use it (fast, ideal for convex shapes — the common case)
2. Else: grid-search 20×20 candidates in the bounding box, return the interior candidate with maximum distance to the nearest edge (pole-of-inaccessibility approximation, ~50 lines, fast enough for 4-100 vertex polygons)
3. Degenerate fallback: first vertex if grid finds nothing inside

Both the icon placement and the "row click → pan" fallback now use the new helper.

---

## 2026-06-01 — AIM Issues v0.22 — first-issue icon-render bug

Root cause finally pinned (thanks to v0.21's try/catch console diagnostic):

```
[AIM ISSUES] marker render failed for issue iss_...:
  TypeError: Cannot read properties of undefined (reading 'appendChild')
    at L.Marker._initIcon ... at marker.addTo ... at renderOneIssue
    at createIssue at save.onclick
```

`ensureCustomPanes(map)` was only called from `renderAllIssues`. But `createIssue` calls `renderOneIssue` DIRECTLY. On a fresh site with no issues yet, the panes were never created when the user created their first one — the marker was constructed with `pane: 'aim-issues-markers'`, then `marker.addTo` blew up trying to `appendChild` to the missing pane.

Fix: call `ensureCustomPanes(map)` at the top of `renderOneIssue`. Idempotent (gated by `map._aim_issues_panes_created`), no perf cost on subsequent calls. Bumped `RENDER_MAX_RETRIES` from 30 → 60 (15s → 30s) too — earlier log showed "gave up after 30 tries" during a slow load colliding with a Map Styler kick.

---

## 2026-06-01 — Asset Inspector v3.58 — visible version log

Console startup was hardcoded to "v2.0 loading" / "v2.0 ready" — had been stuck there for ~50 versions, which made auto-update verification impossible from the console (user saw "v2.0" no matter what was actually loaded). Fixed to use the `SCRIPT_VERSION` constant.

---

## 2026-06-01 — Asset Inspector v3.57 — two more whitespace bugs

The trailing-whitespace saga continues. Two more sites un-trimmed:

### Phantom name/subtype rename on no-op blur (v3.55 didn't fully fix this)
v3.55 only addressed the trim mismatch in `queueNameEdit` itself. The actual repro was different: if there was already a pending rename (or subtype), `effectiveName(entity)` returned the **pending newValue**, so the cell input opened showing the pending value (e.g. "Tank 14B Revised"). Clicking out without typing → `commit()` called `queueNameEdit(entity, "Tank 14B Revised")`. Inside queueNameEdit, that gets compared against `entity.name` ("Tank 14B" — the original) → mismatch → queued again.

Fix: in both `startInlineNameEdit` and `startInlineSubtypeEdit`'s `commit()`, compare the new value against `startVal` (what the user opened with), not against `entity.name`. If unchanged from when the cell was opened, skip queue entirely. Catches both the "no pending" trim case AND the "has pending" case in one check.

### Bulk subtype Apply failing on entities with trailing whitespace
Log evidence: `apply: starting asset "ATKINS 47-02 UNIT 1 0212AH_ID 10100 " subtype → "h-well - test" (NEW)` — note the trailing space inside the closing quote. v3.56 trimmed the editor-title verification, but `findAndClickSidebarItem` still pasted the raw name (with trailing space) into Percepto's search input. If Percepto's search filter doesn't trim its query, no items match and Apply returns "not found in sidebar" → fail.

Fix: paste the trimmed name into the search input. The internal `matchLower` already trimmed; now the search paste does too. Single root cause, all surfaces aligned.

---

## 2026-06-01 — Asset Inspector v3.56 — trim editor-title verification

Same root as the v3.55 phantom-rename fix, different surface. Bulk subtype Apply on 7 entities was reporting `4 errors: wrong entity in editor (got "X")` where the "X" looked identical to the expected name — because the editor's title had trailing whitespace and the equality check trimmed neither side.

Fix: trim both `openedName` and `label` before the lowercase comparison. Two call sites in `applyOneEntity` (subtype path + name/altitude path); both patched via `replace_all`. Apply runs now finish cleanly when Percepto's data has stray trailing spaces.

---

## 2026-06-01 — Bug-fix patch (Asset Inspector v3.55 + AIM Issues v0.21)

Two field-reported bugs from morning testing. Shipped directly to prod.

### Asset Inspector v3.55 — phantom rename on no-op blur
Clicking a Name cell and tabbing/clicking out without typing a change was queueing a phantom rename — original strikethrough, same value in yellow as the "new" — with no way to undo just that one entry in the middle of a batch.

Root cause: `queueNameEdit` trimmed `newRaw` but not `entity.name`. Percepto data occasionally has trailing whitespace; the trimmed new value didn't match the untrimmed current value, so the equality check passed when it shouldn't have.

Fix: trim `entity.name` too. One-line change.

### AIM Issues v0.21 — duplicate creates from broken Create button
Coworker drew an issue, hit Create — modal didn't close, polygon rendered but icon didn't. They hit Create twice more and got 2 duplicate issues.

Two compounding bugs:
- **`createIssue` could throw mid-execution** (somewhere in `renderOneIssue`'s marker code, likely; specific failure not yet identified). The `closeNoteModal()` call in `save.onclick` ran AFTER `createIssue` so when `createIssue` threw, modal stayed open + button stayed enabled.
- **`save.onclick` had no double-click guard**, so subsequent clicks each ran a full create cycle.

Fix:
- `save.onclick` now locks the button on first click (`data-locked` + `disabled` + "Creating…" label), closes the modal IMMEDIATELY, then runs `createIssue` inside `try/catch`. Any thrown error is logged + a toast asks the user to refresh.
- Wrapped the marker block in `renderOneIssue` with try/catch so the polygon at least registers if marker code fails, and we get a console error to diagnose the next occurrence.

---

## 2026-06-01 — Production rollout

Promoted today's accumulated dev/`latest` work to the repo root so coworker installs (which point at the root via `@updateURL`) pick up the changes on their next Tampermonkey auto-check (~24h).

### Versions promoted to prod
| Script | Prod was | Prod now | What's new |
|---|---|---|---|
| AIM Control Panel | 1.24 | **1.25** | debounce + idempotency fix |
| AIM Map Styler | 34.43 | **34.66** | PLE pipeline (vertex edit, draw, branch, snap to vertex/segment); modify/delete clobber + green-line delete fixes; toast positioning |
| AIM Asset Inspector | 3.39 | **3.54** | inline subtype + name editing → Apply queue (drives Percepto's Ant Select via React fiber); SUM table per-entity 👁 visibility; M2-solo on chips; Bulk → Subtype; sidebar-search lookup; bail on `.aim-issues-icon-marker` (coexists with Issues) |
| **AIM Power Line Editor** | — | **0.14 NEW** | ⚡ button in `.map-tools` drives Map Styler's vertex-edit + draw + delete-line modes |
| **AIM Map Nav** | — | **0.7 NEW** | WASD pan / Q-E zoom / Alt sprint / Space fit-to-site keyboard nav (Shift+drag = native Leaflet box-zoom) |
| **AIM Issues** | — | **0.20 NEW** | CSM-collaborative issue flagging — 🚩 in `.map-tools` draws rect/polygon, required note, GitHub sync with per-user identity, full status state machine (Open → Ready → Resolved/Ignored with re-open), per-issue creator-only delete, dedicated floating panel with drag/resize/filter/search/solo, affected-entities detection via point-in-polygon against `/map_objects/`, Google Sheets export, Site ID + Site Name columns |

Coworker installs get all of this on their next Tampermonkey check.

### Other housekeeping
- README.md install table updated with the 3 new scripts
- `docs/index.html` install guide updated with 3 new install cards
- `features.csv` updated with v0.15-v0.20 Asset Inspector + AIM Issues rows
- Memory snapshot rewritten as `project_status_2026-06-01.md`

---

## 2026-06-01 — AIM Issues v0.20 (Site Name in export + panel header)

- **Site column split** in the export — `Site` renamed to `Site ID` (the numeric id, unchanged), and a new `Site Name` column added with the human-readable name (e.g. "Exxon - Lille Midkiff 5"). HTML table + TSV both updated.
- **Reads the name from Percepto's `.site-select .ant-select-selection-item`** (lives in TOP frame's header). Prefers the `title` attribute, falls back to `textContent`. Same-origin so the cross-frame query works.
- **Retry tick**: the site-select widget can mount a few hundred ms after a site nav. `tickReadSiteName` retries every 500ms for up to ~10s until a name appears, then re-renders the panel so the header updates.
- **Bonus**: panel header now shows `Site 1245 · Exxon - Lille Midkiff 5` in blue when the name is available. Just the site id alone when it's not.

---

## 2026-06-01 — AIM Issues v0.19 (Google Sheets export)

New `📊 Copy → Sheets (N)` button in the panel header (next to ↻ Refresh). Click → copies the **currently visible** issues (after chip filter + search) to the clipboard as a formatted HTML table that pastes directly into Google Sheets or Excel with colors + line breaks intact.

### Columns (one row per issue)
1. **Status** — colored background (red Open / yellow Ready / grey Resolved / grey-blue Ignored)
2. **Note** — the issue's main note text
3. **Created** — full datetime: `MM-DD-YYYY h:mm AM/PM TZ`
4. **By** — `@github-login` of creator
5. **Last Event** — semantic label (Re-opened / Rejected / Ready for Review / etc.)
6. **Last Event When** — full datetime
7. **Last Event By** — `@user` of last transition
8. **Affects #** — count of Percepto entities under polygon
9. **Affected Entities** — one per line: `AST Tank 14B (Storage Tank)` etc. Type short-code + name + subtype.
10. **Full History** — every transition in one cell, newline-separated: `[date] @user: from → to — "note"`
11. **Issue ID** — for traceability
12. **Site** — site ID

### Clipboard write
- Primary: multi-MIME `ClipboardItem` with both `text/html` and `text/plain` (TSV). Sheets/Excel pick the HTML for formatting; plain-text editors fall back to the TSV.
- Fallback: hidden `<div>` + `execCommand('copy')` for older browsers / restricted Clipboard API.
- Toast: `Copied N issues — paste into Google Sheets / Excel`.

### Respects filters
- Honors current chip filter (Open / Ready / Resolved / Ignored)
- Honors search box
- Button shows count of what's about to be exported: `📊 Copy → Sheets (5)`
- Disabled (greyed out) when 0 issues match.

### Internal
- `buildIssuesHtmlForSheets(issues, siteId)` — inline-styled `<table>` builder
- `buildIssuesTsv(issues, siteId)` — tab-separated rows, tabs/newlines collapsed to spaces in cells
- `copyIssuesToSheets(issues, siteId)` — multi-MIME write + fallbacks
- Same `ClipboardItem` + `execCommand` pattern Asset Inspector uses for its Stats popup `Copy → Sheets`.

---

## 2026-06-01 — AIM Issues v0.18 (entity pill interactivity + panel expansion)

Affected-entity pills are now interactive in both the status modal and the panel, and the panel rows have an expand/collapse arrow for the entity list.

### Modal entity pills (status modal)
- **M1** on a pill → copy the entity name to clipboard with `navigator.clipboard.writeText` (fallback to `execCommand('copy')` for older browsers). Toast confirms.
- **M2** on a pill → paste the name into Percepto's `input.ant-input[placeholder="Search entity"]` via the React-aware value setter, then auto-click the matching result in the filtered sidebar. Same trick Asset Inspector uses (duplicated into Issues so it works standalone — doesn't depend on AI being installed).
- Section header now hints: `· M1 copy · M2 sidebar`

### Panel rows — expand/collapse affected entities
- **▶ arrow** (yellow) next to the `Affects N:` tally → click to expand a stacked list of entity pills below the tally. ▼ when expanded; ▶ when collapsed.
- Expansion state per-issue, tracked in `expandedIssueIds` Set (session-only — resets on page refresh).
- Expanded pills are single-column with full width, type short-code chip + name + subtype. Same M1 copy / M2 sidebar behavior as the modal pills.
- Row-click handler now ignores clicks on the arrow or any entity pill (prevents the row from zooming + opening the modal when the user actually wanted to copy a name).
- Footer hint updated: `Row: zoom + open modal · M1 chip: toggle · M2 chip: solo · ▶ expand entities · M1 pill: copy · M2 pill: sidebar`.

### Internal
- `copyTextToClipboard(text)` helper with navigator/execCommand fallback
- `findSidebarInput()` walks current doc + top doc + same-origin iframes
- `findEntityInSidebar(name)` does the React-aware paste + dispatchEvent + auto-click
- `expandedIssueIds` Set tracks panel expansion state

---

## 2026-06-01 — AIM Issues v0.17 (Phase 5b — affected-entities detection)

Each issue now knows which Percepto entities (assets / FFZs / NFZs / flight paths / general markers) sit underneath it.

### How it works
- On every site change, fetches `https://percepto.app/map_objects/?getPoiMapObjectsAsList=true&site_id=<id>` (cookie auth, same endpoint Asset Inspector uses — no PAT needed). Cached in memory; invalidated on site nav.
- For each issue, runs a ray-casting **point-in-polygon** check: an entity is "affected" if ANY of its vertices / arc endpoints / marker point falls inside the issue polygon. Catches "issue contains entity" and "issue overlaps entity"; misses the rare "entity surrounds issue" case (uncommon for typical issue rectangles).
- Results cached per issue id. Cache cleared whenever entities are re-fetched.

### Where it shows up
- **Tooltip** (hover the ⚠ icon): `Affects 3:` plus per-type tally (e.g. `2 AST · 1 FFZ`) with color-coded counts (white=Asset, green=FFZ, red=NFZ, blue=FP, purple=GM).
- **Status modal** (M2 on icon): new "Affected entities (N)" section right under the note. Each entity rendered as a colored pill: type short-code chip + name + subtype.
- **Panel rows**: per-type tally as a sub-line under each issue's note. Loading state shown while entities are still being fetched.

### Color palette (matches Asset Inspector)
- `3` Asset → white
- `4` NFZ → red
- `15` Flight Path → blue
- `16` FFZ → green
- `19` General Marker → purple

### Internal
- New `fetchSiteEntities(sid)` + `MAP_OBJECTS_URL` constant
- `pointInPolygon(lat, lng, polygon)` ray-casting helper
- `affectedEntitiesFor(issue)` does the per-issue detection with caching
- `ENTITY_TYPE_META` map drives label/short/color per type code
- `mapObjects` / `issueAffectedCache` / `mapObjectsFetching` state
- Cache invalidated in `setCurrentSite` (along with entities reload)

### What's next
- v0.18 = Google Sheets export from the panel (HTML-clipboard write so paste produces formatted cells with the affected-entities columns)
- Future: click an entity pill in the modal to pan-zoom to it
- Future: filter the panel by "issues affecting Asset X"

---

## 2026-06-01 — AIM Issues v0.16 (panel polish — drag/resize/solo/zoom)

Four UX upgrades to the v0.15 panel:

- **Drag to move.** Header bar is a drag handle (`cursor:move`). Mousedown on the bar (avoiding inner buttons/inputs) → drag. Position persists to `localStorage` key `aim-issues-panel-layout` so it reopens where you left it across refreshes.
- **Resize from the bottom-right corner.** Red striped handle in the corner (`cursor:nwse-resize`). Min size 360×240; clamped to viewport. Saves alongside position.
- **M2 on a status chip = solo.** Audio-mixer pattern (matches Asset Inspector). M2 on a chip turns off all other statuses and keeps only that one active. M2 again on the same chip restores all statuses. M1 still toggles individual chips.
- **Row click now zoom-to-fit, not just pan.** Uses `map.fitBounds(L.latLngBounds(issue.polygon), {padding:[80,80], maxZoom:19})` so the polygon fills a comfortable area with context around it. The `maxZoom:19` cap prevents a tiny issue from snapping to building-level zoom.

Internal:
- New `panelDragInFlight` flag suppresses panel re-renders while the user is dragging or resizing (would re-wire stale handlers mid-drag).
- `clampPanelLayout` keeps position+size inside the viewport with min-visible constraints.
- Footer hint text updated to mention the chip solo + zoom-to-issue behavior.

Next up — v0.17 = affected-entities detection (per-issue list of Percepto entities under the polygon, shown in tooltip + modal + as a panel column). Then v0.18 = Google Sheets export from the panel.

---

## 2026-06-01 — AIM Issues v0.15 (Phase 5a — dedicated panel)

First half of Phase 5: a floating 🚩 panel listing every issue on the current site. Triggered by **M2 on the 🚩 toolbar button** (was "un-hide all" before — that action moved into a button inside the panel header). Panel includes:

- **Header**: site ID, total count, sync-status dot (green/orange/red) + author tag, close button
- **Status chips** with live counts: Open / Ready for Review / Resolved / Ignored. Click a chip to toggle that status in/out of the list. Chip color follows the status color.
- **Action buttons** (header right): `↺ Un-hide all (N)` (only shown when N > 0), `↻ Refresh` (re-fetches from GitHub)
- **Search box**: filters by note text, by author, AND by any history-entry note. 150ms debounced. Focus + cursor position preserved across re-renders.
- **Issue rows** sorted by last-event-at descending: status pill / last-transition label + age / note (clamped to 2 lines) / @author. Resolved + ignored + session-hidden rows render with reduced opacity.
- **Click a row** → pans the map to the issue centroid (no zoom change) + opens its status modal.

Side touches:
- Panel re-renders automatically after any data mutation (create, delete, transition, hide/un-hide, sync) — wired into `renderButtonState` since that's already called from every mutation site.
- Mouse events on the panel `stopPropagation` so Leaflet doesn't try to pan/zoom underneath.
- Toolbar 🚩 button title text updated: "M2 open Issues panel" (was "M2 un-hide all").

What's still ahead in Phase 5b:
- Affected-entities detection (per-issue list of Percepto entities under the polygon). Next ship — v0.16.
- SUM-table integration (issues as rows in Asset Inspector's table). Deferred pending Asset Inspector changes.

---

## 2026-06-01 — AIM Issues v0.14 (tooltip header describes last transition)

Tooltip header was always "Open · 1h ago" (or whatever the current status is) — didn't reflect that the issue had just been re-opened or rejected. v0.14 swaps in the last-event label + age:

- Creation: status label (Open / Ready for Review / etc.)
- `open → ready-for-review`: **Ready for Review**
- `open → ignored`: **Ignored**
- `ready-for-review → resolved`: **Resolved**
- `ready-for-review → open`: **Rejected**
- `resolved → open`: **Re-opened**
- `ignored → open`: **Un-ignored**

Age now counts from the last history entry's timestamp, not the original `createdAt`. So a 3-day-old issue that was re-opened 2 minutes ago shows "Re-opened · 2 min ago" instead of "Open · 3d ago" — much more useful at a glance.

Header text color also follows the destination status (red/yellow/grey/grey-blue) so it matches the icon.

---

## 2026-06-01 — AIM Issues v0.13 (per-transition note prompts)

Note textarea placeholder was a generic "Required — what was fixed / why ignoring / etc." regardless of which transition you picked, which read oddly on Re-open. v0.13 adds a `notePrompt` field per transition so each one asks the right question:

- Open → Ready for Review: `What was fixed? e.g. "Added missing H-Well to Site Setup"`
- Open → Ignore: `Why are you ignoring this? e.g. "Not within our scope"`
- Ready for Review → Resolve: `Optional acceptance comment (e.g. "Verified, looks good")`
- Ready for Review → Reject: `Why is this being rejected? What still needs to be done?`
- Resolved → Re-open: `Why is this being re-opened? What came back or what was missed?`
- Ignored → Un-ignore: `Why are you un-ignoring this? What changed?`

---

## 2026-06-01 — AIM Issues v0.12 (re-open resolved)

Resolved is no longer terminal. Adds a `re-open` transition from Resolved back to Open — anyone can do it (trust-based, like every other transition), note required for the audit log.

Single-line state-machine extension; the existing modal already renders `STATUS_TRANSITIONS[status]` buttons dynamically so the `↺ Re-open` button appears automatically when M2 is clicked on a resolved issue. On confirm: appends a history entry `{from: 'resolved', to: 'open', note}`, switches status, re-renders the issue back to red, commits to GitHub with `@user: resolved → open`. The issue's polygon comes out of the dimmed-background style automatically (via the existing `isIssueDimmed` helper — resolved was the trigger).

Diverges slightly from the original design doc (which had Resolved → terminal). User override — practical experience says things come back and need to be re-flagged.

---

## 2026-06-01 — AIM Issues v0.11 + Asset Inspector v3.54 (tooltip width + click-priority)

Two-script fix for the lingering v0.10 issues. The polygon and Asset Inspector were both fighting for clicks; now only the icon is the interactive surface.

### AIM Issues v0.11
- **Tooltip dynamic-width-with-cap finally works.** `width: max-content !important` + `max-width: 420px !important` — max-content tells the browser to use the natural one-line width, max-width caps it. Long notes wrap inside 420px; short notes get a compact box. v0.10's plain shrink-to-fit was being squeezed to a column by something in the page CSS chain.
- **Polygon is now fully click-through.** `interactive: false` always (was true when visible) + force `pointer-events: none` on the SVG path. M2 inside the polygon area passes through to whatever entity is beneath. Removed polygon's `bindTooltip` + click/contextmenu handlers — tooltip and interactions move to the icon only.
- **Icon M2 hardened.** Marker click + contextmenu handlers now call `stopImmediatePropagation` on the originalEvent so other bubble-phase listeners are stopped cold. Works in tandem with the Asset Inspector v3.54 bail check below.
- **`data-issue-id`** added to the divIcon's inner HTML — a clean handle for cross-script detection (Asset Inspector uses it via the `.aim-issues-icon-marker` class but the id is there for future scripts).

### AIM Asset Inspector v3.54 (bug fix for Issues coexistence)
- Asset Inspector's window-capture contextmenu handler now bails when the right-click target is inside `.aim-issues-icon-marker`. Without this, AI's capture-phase handler ran *before* Issues' element-level marker handler and popped its inspector for an entity underneath the issue icon — even though z-index put the issue icon on top visually. One-line guard at the top of the handler, after the input/editable check.

---

## 2026-06-01 — AIM Issues v0.10 (tooltip dynamic sizing)

v0.9's `min-width: 320px` was forcing every tooltip to that width, even for short notes. v0.10 drops `min-width` entirely. The browser's shrink-to-fit on absolute-positioned elements + word-boundary wrapping (which v0.8's removal of `overflow-wrap:break-word` enabled) gives the right shape for any content length: short notes compact, long notes wrap to the 420px max.

---

## 2026-06-01 — AIM Issues v0.9 (tooltip widescreen)

Tooltip was rendering as a narrow column at low zoom after v0.8 — `overflow-wrap: break-word !important` let the browser break words at any character, so it shrank the tooltip to fit the narrowest possible layout. Removed `overflow-wrap` and `word-wrap`; words now wrap at word boundaries normally. Added `min-width: 320px !important` so the tooltip stays a reasonable widescreen shape regardless of content length, with `max-width: 420px !important` as the upper cap. Inner div lost its own `max-width:320px` (the outer rule drives it now).

---

## 2026-06-01 — AIM Issues v0.8 (Phase 3 — real status state machine + 2 bug fixes)

Two bug fixes from v0.7 testing plus Phase 3 (status workflow).

### Bug fixes
- **Tooltip text not wrapping.** Leaflet's default `.leaflet-tooltip` has `white-space:nowrap` — my v0.3 override didn't unset it, so long notes blew past the container at low zoom. v0.8 adds `white-space:normal !important`, `max-width:340px !important`, and `overflow-wrap:break-word` to the `.aim-issues-tooltip` rule.
- **Issue icons sitting underneath Percepto markers.** When an issue marker overlapped an asset, M2 on the icon hit Percepto's asset M2 menu instead of the status modal. Fix: create three custom Leaflet panes at startup — `aim-issues-polygons` (z-index 750), `aim-issues-markers` (800), and `aim-issues-tooltips` (850) — well above the default `markerPane` (600) and `popupPane` (700). Polygon/marker/tooltip create calls now pass `pane:` to use them.

### Phase 3 — status state machine
M2 now opens a real status modal (was a stub showing only history). Full workflow per the design doc:

- **Open** → `→ Ready for Review` (note required) or `→ Ignore` (note required)
- **Ready-for-Review** → `→ Resolve` (note optional, acceptance comment) or `↺ Reject (back to Open)` (note required, rejection reason)
- **Resolved** → terminal (no further transitions)
- **Ignored** → `↺ Un-ignore (back to Open)` (note required)

UX:
- Modal opens with history + transition buttons colored to match the target status (yellow for ready, green for resolve, etc.).
- Clicking a transition button arms it — note input slides in below with required/optional label + Confirm/Cancel buttons.
- Confirm appends a history entry `{at, by, fromStatus, toStatus, note}`, updates `issue.status`, saves locally, re-renders the issue with the new color/dim, and (with token) commits to GitHub with message `@user: open → ready-for-review`.
- Esc on armed view → cancels back to transition list; Esc on transition list → closes modal.
- Ctrl/Cmd+Enter in the note textarea = confirm.
- Trust-based per design: anyone can do any transition. Audit log shows everything.
- Creator-only delete (from v0.6) preserved in the modal footer.

### Status-driven render
- **Resolved + Ignored** now render dimmed automatically (per design — those statuses are meant to be background). Combines with session-hide via a new `isIssueDimmed(issue)` helper.
- M1 on resolved/ignored issues is a no-op now (was creating ghost hidden-ids that wouldn't change anything visually); toast says "Already in background (resolved)".

### Tooltip hint text
- "M2 = status (stub)" → "M2 = change status".

---

## 2026-06-01 — AIM Issues v0.7 (local-only is truly local)

Local-only issues (those created with no GitHub token cached) now have clean semantics:

- **Never sync to GitHub.** `commitIssuesToGitHub` filters `createdBy === 'local-only'` out of the PUT payload. The shared `Ned-Yap/aim-userscripts-data/issues/<sid>-issues.json` only ever contains real-identity reports.
- **Always deletable.** v0.6 required `!cachedUsername` for local-only delete — meaning the moment you had a token, you could no longer remove old local-only test issues from the map. v0.7 drops that gate. Anyone can delete a local-only issue (it has no real owner).
- **Auto-purge on load.** `loadIssuesFromStorage` strips `local-only` entries on every load and writes the cleaned list back. Stale test issues from v0.1-v0.4 evaporate on next refresh.
- **Delete of local-only is local-only.** Skips the GitHub PUT (the issue was never there). Toast says "Local-only issue deleted (not synced to GitHub)".
- **404 migration is smarter.** Only counts authored issues when deciding whether to push as the initial commit — won't re-pollute a wiped file with stragglers.

Also wiped the existing `issues/1245-issues.json` from the data repo (commit `6b063aa`) so the user starts clean with no test contamination.

---

## 2026-06-01 — AIM Issues v0.6 (Phase 2 polish + creator-delete)

Three follow-ups from v0.5 testing:

- **Polygon-not-rendering bug — likely fix.** Adding `@grant` directives in v0.5 silently flipped Tampermonkey into sandbox mode; `window.L` is then the sandbox proxy's L, not the page's actual Leaflet. Polygons created via the sandbox L attached but rendered invisibly. Marker (divIcon) happened to work because it's DOM-only. Fix: `getL()` now prefers `unsafeWindow.L` (same trick Map Styler uses). Added a one-line render diagnostic so future polygon-disappears bugs surface with the exact options + point count in console.
- **Creator-only delete.** M2 status modal now shows a red 🗑 "Delete (you created this)" button — visible only when `issue.createdBy === cachedUsername` (or when the issue is `local-only` and you have no token, so v0.1-v0.4 test issues are still removable). Two-stage confirm: first click flips the button to "Click again to confirm delete" for 5 seconds. On confirm, removes locally and PUTs the new list to GitHub with commit message "delete issue by @user".
- **Date/time format.** History rows in the status modal were rendering raw ISO strings (`2026-06-01T01:21:15.967Z` — ugly and timezone-ambiguous). New `fmtDateTime` helper renders `MM-DD-YYYY h:mm AM/PM TZ` in the viewer's local timezone with the short tz token (e.g. `06-01-2026 8:23 PM CDT`). Built via `Intl.DateTimeFormat.formatToParts` for reliable zero-padding + token order. Tooltips still show relative age (`13 min ago`) — that's the right grain for hover.
- Also bumped internal `SCRIPT_VERSION` constant to 0.6 (was stuck at 0.4 in v0.5 — header @version was right but the runtime log line lied).

---

## 2026-06-01 — AIM Issues v0.5 (Phase 2 — GitHub sync)

Issues now persist to GitHub instead of just `localStorage`. All Phase 2 design lines (private repo, PAT-driven, per-site JSON, real GitHub identity) landed in one cut.

### What changed
- **`@grant`** widened to `GM_xmlhttpRequest / GM_setValue / GM_getValue` + `@connect api.github.com`.
- **Token plumbing.** Subscribes to `TOKEN_VALUE` on `AIM_CONTROL_CHANNEL` (same channel Map Styler uses); also recovers token from GM storage on refresh so we can sync before the panel broadcasts. On token change → `GET /user` once, cache the login. `REFETCH_KMLS` (Map Styler's "token changed" signal) triggers a re-pull of issues too.
- **Site-change fetch.** `setCurrentSite` calls `refetchIssues` when a token is present. Reads `issues/<siteID>-issues.json` from `Ned-Yap/aim-userscripts-data` via the Contents API (always-fresh, not raw CDN). Caches SHA per site.
  - **200**: union-merges remote + local by ID. Conflicts pick the one with the later `history[last].at`. If local had IDs the remote didn't, immediately PUTs the merge.
  - **404**: no file yet. If local has issues, PUTs them as the initial commit (this is the v0.1-v0.4 migration path).
- **Create commit.** `createIssue` now uses the cached GitHub username for `createdBy` + each `history` entry. Token present → fires `commitIssuesToGitHub` (PUT with cached SHA). 409/422 conflicts re-GET + union-merge + retry once. A concurrent second create during an in-flight commit is queued and pushed on a follow-up.
- **Sync status dot.** Small colored circle in the 🚩 button's top-left corner (count badge stays top-right):
  - **grey** = no token (local-only)
  - **green** = synced
  - **orange** = syncing or pending (glows during a request in flight)
  - **red** = error (glows; check console)
- **TOP-frame gate.** The script runs in both top and iframe contexts, but all `fetchRemoteIssues` / `commitIssuesToGitHub` / `fetchGithubUsername` calls early-return on TOP to avoid duplicate GitHub round trips. Sync is iframe-only.

### What's still ahead
- Phase 3: real status state machine (Open → Ready-for-Review → Resolved/Ignored with required notes, real M2 status modal).
- Phase 5: dedicated 🚩 panel + SUM-table integration.
- Phase 6: Mission Bank surface filter.

---

## 2026-06-01 — AIM Issues v0.4 (Phase 1 startup-race fix)

Bug: on page refresh, issues didn't render. Only way to see them was to toggle Enable off/on or move any Issue Rendering slider — both of those re-fire `renderAllIssues` after Leaflet has mounted, hiding the underlying race.

Root cause: `setCurrentSite` (called from init) fired `renderAllIssues` before Leaflet had constructed the iframe map. `getLeafletMap()` returned null, `renderOneIssue` silently no-op'd, and nothing reached the map.

Fix: `renderAllIssues` now retries every 500ms (up to ~15s) until `getLeafletMap()` returns a real map, then renders. Any new explicit call (toggle change, site nav, M2 un-hide) resets the retry budget. Removed the old `setTimeout(renderAllIssues, 1500)` fallback in init — superseded by the retry loop.

---

## 2026-06-01 — AIM Issues v0.3 (Phase 1 polish)

Second round of v0.1 testing fixes:

- **Tooltip readability.** Leaflet's default `.leaflet-tooltip` is white-on-white-ish — the issue note text washed out. Injected a `.aim-issues-tooltip` style override: dark background `rgba(15,18,22,0.96)`, red border, bright `#ffffff` bold note text, blue username. Tooltip arrow color updated for all four directions.
- **M2 on 🚩 simplified to "un-hide all non-resolved".** v0.2's "toggle showHidden" mode was confusing. v0.3: M2 simply un-hides every session-hidden issue whose status is NOT `resolved` or `ignored`. Resolved/ignored stay hidden by design (they're meant to be background). For Phase 1 (only `open` issues exist), it's effectively un-hide-all. `showHidden` state removed; hidden issues always render dimmed until un-hid or refresh.
- **Control Panel "Issue rendering" category.** Eight sliders for tuning visible + hidden style. All re-render live on change.
  - Visible stroke weight (1-6 px, default 3)
  - Visible stroke opacity (0.4-1, default 0.95)
  - Visible fill opacity (0-0.5, default 0.15)
  - Visible marker size (16-44 px, default 26)
  - Hidden stroke opacity (0.05-0.8, default 0.25)
  - Hidden fill opacity (0-0.3, default 0.04)
  - Hidden stroke weight (0.5-3 px, default 1.5)
  - Hidden marker size (10-40 px, default 20)
- Marker font size auto-derives from marker size now (no separate toggle).
- Status colors + dash patterns are NOT in the toggles — they encode meaning (red=open, yellow=ready-for-review, etc.) and shouldn't be user-overridden.

Still LOCAL-ONLY — Phase 2 brings GitHub identity + sync.

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
