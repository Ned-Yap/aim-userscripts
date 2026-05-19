# Changelog

Human-readable summary of what shipped in each update. Tampermonkey auto-update prompts coworkers to install new versions; this file is what they read to know *what changed*.

Newest entries on top. Each entry calls out the script + version + a one-line summary. Issue references look like `[#7](https://github.com/Ned-Yap/aim-userscripts-issues/issues/7)` and link to the private tracker (only visible to collaborators).

---

## 2026-05-18

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
