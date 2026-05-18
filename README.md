# AIM Userscripts

A set of browser userscripts that streamline the AIM drone-mission workflow on `percepto.app`. Distributed via Tampermonkey + GitHub — install once, get auto-updates.

---

## Quick start (5 minutes)

1. [Install Tampermonkey](#1-install-tampermonkey)
2. [Already have older AIM scripts? Back up + remove them](#1a-already-have-older-aim-scripts-back-up--remove-them)
3. [Install the new userscripts](#2-install-the-userscripts) — click each link below
4. [Get repo access + a GitHub token](#3-set-up-the-github-token-for-shielding-kmls) (only needed for the Map Styler's KML overlays)
5. [Configure in Percepto](#4-paste-the-token-into-aim-controls)

Auto-updates take over after that — new versions install themselves.

---

## 1. Install Tampermonkey

Tampermonkey is the browser extension that runs userscripts.

- **Chrome / Edge / Brave:** [Tampermonkey on the Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- **Firefox:** [Tampermonkey on AMO](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
- **Safari:** [Tampermonkey on the App Store](https://apps.apple.com/app/tampermonkey/id1482490089)

Click "Add to browser" and confirm.

---

## 1a. Already have older AIM scripts? Back up + remove them

**Skip this section if you're installing Tampermonkey for the first time.**

If Payden has previously sent you AIM scripts manually (copy-paste into Tampermonkey), those are the *old* style and don't talk to the new Control Panel. Leaving them installed will cause duplicate behavior (e.g. Shift+A firing twice) or stale UI. Replace them with the new versions below.

### Back up first (in case you want to roll back)

1. Open the Tampermonkey **Dashboard** (click the Tampermonkey icon in your browser → Dashboard)
2. Top toolbar → **Utilities**
3. Under the **Export** section, click **Export** — choose either "Export to file" or "Export to zip"
4. Save the file somewhere safe. It contains every script you currently have installed; if anything goes sideways you can re-import.

### Then delete every AIM-named script

Back in the Tampermonkey Dashboard main list:

1. Find each script with a name starting with `AIM ` or `Percepto ` (older ones were named `Percepto Altitude Fix`, `PerceptoRulerFix`, etc.)
2. Click the **trash icon** next to each one to delete it
3. When you're done, the script list should NOT contain any AIM or Percepto scripts — you'll reinstall them all from the next section.

Once the old ones are gone, move on to [Install the userscripts](#2-install-the-userscripts) below.

---

## 2. Install the userscripts

Each link below opens the script's raw source in a new tab — it does NOT auto-install. You need to install each one manually via Tampermonkey. Two methods, **try Method A first**:

### Method A — Install from URL (fastest, if your Tampermonkey supports it)

1. Open the Tampermonkey **Dashboard**
2. Top toolbar → **Utilities**
3. Scroll to the **Import from URL** or **Install from URL** section
4. Paste the script's raw GitHub URL (from the table below — right-click the link → Copy Link Address)
5. Click **Install** → confirm the prompt
6. Repeat for each script

### Method B — Copy and paste (always works)

1. Click the script link below — the raw source code opens in your browser
2. Select all (**Ctrl+A**) and copy (**Ctrl+C**)
3. Open the Tampermonkey **Dashboard**
4. Click the **+** tab at the top to create a new userscript
5. **Delete the default template** that appears in the editor
6. Paste your copied code (**Ctrl+V**)
7. Save: **Ctrl+S** (or **File → Save**)
8. Repeat for each script

Once installed, scripts auto-update on their own going forward (Tampermonkey checks daily; you can also trigger manually via Dashboard → "Check for userscript updates").

**Install the Control Panel first** so the others show up inside it when they load. Other than that, order doesn't matter.

| # | Script | Install link |
|---|---|---|
| 1 | **AIM Control Panel** (the gear icon + settings hub) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Control_Panel.js) |
| 2 | **AIM Map Styler** (outlines, buffers, KML shielding, Coverage Validator — Shift+O) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_SS_Outlines_Tampermonkey.js) |
| 3 | **AIM Inspector** (Leaflet diagnostic panel — Shift+I) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Inspector.js) |
| 4 | **AIM Absolute Altitude** (Shift+A) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Altitude_Tampermonkey.js) |
| 5 | **AIM Measure / Ruler** (Shift+R) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Ruler_Tampermonkey.js) |
| 6 | **AIM Clear All** (Shift+C) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Clear_All_Tampermonkey.js) |
| 7 | **AIM Copy Asset Name** (Shift+Ctrl+Q on a hovered asset) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Copy_Asset_Name.js) |
| 8 | **AIM New Entity Macro** (1–6 to create, Shift+S/D D/Z/X) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_New_Entity_Macro.js) |
| 9 | **AIM Bulk Mission Adder** (Shift+B) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Bulk_Mission_Adder.js) |
| 10 | **AIM Bulk Altitude Updater** | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Bulk_Altitude_Updater.js) |
| 11 | **AIM Bulk Validator** | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Bulk_Validator.js) |
| 12 | **AIM Sidebar Resizer** (map visibility fix) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Sidebar_Resizer.js) |

**Verify:** open `percepto.app` and a site. You should see a gear icon (⚙) added to the map toolbar. Click it — that's the AIM Controls panel.

---

## 3. Set up the GitHub token (for shielding KMLs)

The Map Styler can overlay power lines (yellow distro / red trans) and run a Coverage Validator. These features pull per-site KML data from a private GitHub repo. To unlock them you need:

### 3a. Ask Payden to add you as a collaborator

You'll get a GitHub email invite. Accept it.

### 3b. Generate a fine-grained personal access token

1. Go to [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)
2. Click **Generate new token** → **Fine-grained personal access token**
3. Fill in:
   - **Token name:** `AIM KML reader` (or whatever helps you find it later)
   - **Expiration:** 1 year (or as desired)
   - **Resource owner:** `Ned-Yap`
   - **Repository access:** "Only select repositories" → tick `aim-userscripts-data`
   - **Permissions** → expand **Repository permissions** → find **Contents** → set to **Read-only**
4. Click **Generate token**
5. **Copy the token** (starts with `github_pat_…`) — you only see it once

---

## 4. Paste the token into AIM Controls

1. Reload Percepto on any site
2. Click the gear icon (⚙) in the map toolbar
3. Scroll to the bottom — find **GitHub Connection (KMLs)**
4. Click to expand → paste your token → **Save & Test**
5. Status dot should turn **green** with "Connected"

That's it. The token stays in Tampermonkey's storage on your machine — it never leaves your browser.

---

## Verification

A working install on a site that has shielding KMLs configured will show:

- ⚙ Gear icon in the map toolbar
- Press **Shift+O** → map outlines/buffers appear (Map Styler activated)
- Open the panel, expand **Outlines** → toggle **Distribution Lines** on → orange/yellow power lines render under the map
- Coverage Validator → **Run coverage check** → numbered red pins on any spots >200ft from shielding

If KMLs don't appear:
- Check the GitHub Connection dot is **green**, not red/gray
- Check the browser console for `[AIM STYLER …] no GitHub token cached` warnings
- Some sites have no KMLs configured yet — that's normal, you'll see `no … KML for site XXXX (404)`

---

## Auto-updates

Tampermonkey checks for new versions roughly daily. You'll see an update prompt when a script changes. Most updates take 10 seconds to accept.

To check manually: Tampermonkey dashboard → "Check for userscript updates" (top toolbar).

⚠ Some updates request new browser permissions (e.g. for the Map Styler's GitHub fetch). When you see the diff highlighted in yellow, that's expected — accept it.

---

## Troubleshooting

**"Gear icon doesn't appear in the map toolbar"** — Make sure AIM Control Panel is installed and enabled in Tampermonkey. Reload the Percepto page.

**"Hotkeys do nothing"** — Tampermonkey might be paused. Open the dashboard, make sure each AIM script is enabled (toggle in the top row).

**"My panel settings are out of date / scripts look weird after lots of updates"** — Hard refresh: empty cache + reload (Ctrl+Shift+Delete → cached images, or DevTools → Network tab → "Disable cache" while devtools open + reload).

**"GitHub Connection stays gray / red"** — Token isn't reaching the script. Re-paste it; make sure you copied the full `github_pat_…` string with no whitespace. Check that the token has Contents: Read on `aim-userscripts-data` specifically.

**"Power lines render in the wrong place / not at all"** — The site might not have KMLs uploaded yet. Ask Payden.

---

## Reporting bugs

Open the browser console (F12), reproduce the issue, copy any `[AIM …]` log lines plus any red errors, and send them to Payden along with: site ID, what you were trying to do, what happened instead.
