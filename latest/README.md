# Latest (Unstable) — dev versions

This folder holds work-in-progress copies of every userscript. Coworkers' Tampermonkey installs point at the production scripts in the repo root and are not affected by anything here.

**Use this folder when:** you're testing a new feature or a fix and don't want to ship to coworkers yet.
**Promote to prod when:** the feature is stable and ready for everyone to auto-update to.

---

## Install on your own machine

Visit each raw URL and Tampermonkey will prompt to install. Each script's `@name` starts with `Latest - ` so it appears alongside the production version in your Tampermonkey dashboard.

- [Latest - AIM Control Panel](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Control_Panel.user.js)
- [Latest - AIM Map Styler](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_SS_Outlines_Tampermonkey.user.js)
- [Latest - AIM Performance Shield](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Perf_Shield.user.js)
- [Latest - AIM Inspector](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Inspector.user.js)
- [Latest - AIM Copy Asset Name](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Copy_Asset_Name.user.js) (Asset Inspector)
- [Latest - AIM Mission Bank Tools](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Mission_Bank_Tools.user.js)
- [Latest - AIM Power Line Editor](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Power_Line_Editor.user.js) — **NEW (dev-only)**: floating ⚡ toolbar, M1-to-edit power lines. No prod counterpart yet.
- [Latest - AIM Map Nav](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Map_Nav.user.js) — **NEW (dev-only)**: HOLD SPACE + WASD pan / Q-E zoom / Shift sprint / Ctrl precise. Modal so existing Shift+letter macros (Shift+D Delete, etc.) keep working when Space isn't held. No prod counterpart yet.
- [Latest - AIM Quick Mission Editor](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Quick_Mission_Editor.user.js)
- [Latest - AIM Absolute Altitude](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Altitude_Tampermonkey.user.js)
- [Latest - AIM Measure / Ruler](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Ruler_Tampermonkey.user.js)
- [Latest - AIM Clear All](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Clear_All_Tampermonkey.user.js)
- [Latest - AIM New Entity Macro](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_New_Entity_Macro.user.js)
- [Latest - AIM Bulk Mission Adder](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Bulk_Mission_Adder.user.js)
- [Latest - AIM Bulk Altitude Updater](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Bulk_Altitude_Updater.user.js)
- [Latest - AIM Bulk Validator](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Bulk_Validator.user.js)
- [Latest - AIM Sidebar Resizer](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/latest/AIM_Sidebar_Resizer.user.js)

After installing, every `Latest - ...` script will auto-update from this folder whenever a new commit lands here.

---

## Active-mode rule — IMPORTANT

Dev and prod scripts share the same internals (SCRIPT_ID, GM storage keys, BroadcastChannel names, DOM IDs). If both are **enabled** at the same time they will fight:
- Duplicate hotkey handlers
- Two Control Panel button injections
- Two registrations under the same `scriptId`
- Two SUM buttons in the entity-table toolbar
- Etc.

**Rule:** in Tampermonkey, disable the production version of a script before enabling its `Latest - ` counterpart. Toggle is a single click on the script's row in the dashboard.

### What resets when you first enable a Latest script

Tampermonkey GM storage is per-`@name`. Latest copies start with an empty GM namespace. Things that **do not carry over** from prod and need to be re-set via the Latest Control Panel:

- **GitHub PAT** (the big one) — open Latest Control Panel → GitHub Connection → Edit → paste PAT → Save & Test. Without this, Map Styler can't fetch KMLs and Asset Inspector can't pull the shared elevation cache.
- **Perf Shield**: hide-satellite, ortho-lowres, suppress-debug-logs, every network-block toggle.
- **Map Styler**: KML cache (rebuilds on activation, but only after PAT is set).
- **Asset Inspector**: DEM cache, column order, show-samples toggle.

Things that **do carry over** (localStorage is shared across @names):
- Hotkey rebinds
- Control Panel toggle prefs that go through `setToggle()` (most of the visible checkboxes per script).

---

## Iteration workflow

1. Edit a `latest/FILE.user.js` and bump its `@version` (Tampermonkey only prompts an update when the version changes).
2. `git commit && git push`.
3. Open Tampermonkey dashboard → "Check for userscript updates" (or wait ~24h for auto-poll).
4. Hard refresh the Percepto tab and test.

When iterating fast, bump `@version` by `0.01` (e.g. `1.24` → `1.25`) so each commit triggers an update. The `SCRIPT_VERSION` constant inside the IIFE is for logging only — bump it to match `@version` so console logs match what's installed.

---

## Promote to prod

When a `latest/FILE.user.js` is stable and ready for coworkers:

1. Copy the dev file's content into the corresponding root `FILE.user.js`.
2. In the root file, change `@name` back (drop the `Latest - ` prefix) and change `@updateURL` + `@downloadURL` back (drop the `/latest/` path segment).
3. Set the root file's `@version` to whatever the dev file is currently at, OR bump higher — just make sure it's greater than the previous prod version so coworkers' Tampermonkey detects the update.
4. Add a CHANGELOG.md entry at the repo root.
5. `git commit && git push`.
6. Coworkers' Tampermonkey installs auto-detect within ~24h (or they click "Check for userscript updates").

The `latest/FILE.user.js` can stay as-is for the next feature iteration, or be reset to match prod if you want a clean starting point.

---

## What's different from production

After the initial copy (2026-05-30):
- `@name` → prefixed with `Latest - `
- `@updateURL` + `@downloadURL` → `/main/FILE.user.js` → `/main/latest/FILE.user.js`
- Nothing else.

Internal identifiers (SCRIPT_ID, storage keys, channel names, DOM IDs) are unchanged. This is why you can only run one at a time. If you ever want to run both simultaneously for side-by-side comparison, every dev script needs its identifiers prefixed with `latest-` — bigger lift, deferred until needed.
