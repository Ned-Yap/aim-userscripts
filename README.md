# AIM Userscripts

A set of browser userscripts that streamline the AIM drone-mission workflow on `percepto.app`. Distributed via Tampermonkey + GitHub — install once, get auto-updates.

> 📖 **For coworkers installing:** the friendly install guide lives at **[ned-yap.github.io/aim-userscripts](https://ned-yap.github.io/aim-userscripts/)** — styled, click-through, 5 minutes end to end. The README below is the same content in raw form (good if you're already poking around the repo).

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

Click each link below. Because the filenames end in `.user.js`, Tampermonkey will automatically pop up an install prompt for each — click **Install**. After install, the script auto-updates on its own going forward (Tampermonkey checks daily; you can also trigger manually via Dashboard → "Check for userscript updates").

**Install the Control Panel first** so the others show up inside it when they load. Other than that, order doesn't matter.

| # | Script | Install link |
|---|---|---|
| 1 | **AIM Control Panel** (the gear icon + settings hub) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Control_Panel.user.js) |
| 2 | **AIM Map Styler** (outlines, buffers, KML shielding, Coverage Validator — Shift+O; Shift+K kicks the map if it gets stuck after refresh) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_SS_Outlines_Tampermonkey.user.js) |
| 3 | **AIM Inspector** (Leaflet diagnostic panel — Shift+I) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Inspector.user.js) |
| 4 | **AIM Absolute Altitude** (Shift+A) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Altitude_Tampermonkey.user.js) |
| 5 | **AIM Measure / Ruler** (Shift+R) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Ruler_Tampermonkey.user.js) |
| 6 | **AIM Clear All** (Shift+C) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Clear_All_Tampermonkey.user.js) |
| 7 | **AIM Asset Inspector** (right-click any entity for inspector popup; SUM button on the toolbar opens the Summary panel + 📊 site stats — installs as `AIM Copy Asset Name`) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Copy_Asset_Name.user.js) |
| 8 | **AIM New Entity Macro** (1–6 to create, Shift+S/D D/Z/X) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_New_Entity_Macro.user.js) |
| 9 | **AIM Bulk Mission Adder** (Shift+B) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Bulk_Mission_Adder.user.js) |
| 10 | **AIM Bulk Altitude Updater** (Shift+E) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Bulk_Altitude_Updater.user.js) |
| 11 | **AIM Bulk Validator** (Shift+V) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Bulk_Validator.user.js) |
| 12 | **AIM Performance Shield** (blocks session-replay + chat + weather network traffic; optional hide-satellite / ortho low-res for slow hardware) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Perf_Shield.user.js) |
| 13 | **AIM Mission Bank Tools** (placeholder — installs now so you get future Mission Bank features automatically; does nothing today) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Mission_Bank_Tools.user.js) |
| 14 | **AIM Quick Mission Editor** (bulk-reorder mission instructions — Ctrl+Click drag handles to select, Enter to open move dialog) | [Install](https://raw.githubusercontent.com/Ned-Yap/aim-userscripts/main/AIM_Quick_Mission_Editor.user.js) |

> ⚠ **AIM Sidebar Resizer** is temporarily unavailable (was breaking AIM load). Existing installs will auto-update to a no-op version on Tampermonkey's next check — safe to leave installed. Will be re-added once fixed.

**If a link doesn't auto-prompt** (rare — usually means your Tampermonkey is configured to skip auto-detection): paste the URL into Tampermonkey Dashboard → Utilities → "Import from URL" section, or copy the page source and paste into a new userscript (Dashboard → **+** tab → delete template → paste → Save).

**Verify:** open `percepto.app` and a site. You should see a gear icon (⚙) added to the map toolbar. Click it — that's the AIM Controls panel.

---

## 3. Set up the GitHub token (for shielding KMLs)

The Map Styler can overlay power lines (yellow distro / red trans) and run a Coverage Validator. These features pull per-site KML data from a private GitHub repo. To unlock them you need a GitHub account with access to that repo + a personal access token.

> **Why GitHub?** GitHub is a free, widely-used code/file hosting platform owned by Microsoft. Our dev team already uses it. For this setup, your account is only used as an identity for repository permissions — no data is shared with your employer, no commits or code from you are required, and the account is yours to keep / delete whenever. The only thing you'll have access to is one private repo of shielding KML files.

### 3a. Create a GitHub account (if you don't have one)

1. Go to [github.com/signup](https://github.com/signup)
2. Use your work email or personal email — either works. The email isn't shown publicly.
3. Pick a username (lowercase letters / digits / dashes; it's permanent so pick something you're OK with). **Suggested:** `aim-<firstname><lastInitial>` or `<initials>-aim` (e.g. `aim-johnd` or `jd-aim`) — project-scoped, doesn't expose your employer in your public profile. Avoid putting your company name in the username if you want a clean separation. Personal accounts work fine too.
4. Verify the email when GitHub sends the verification link.

That's it — no payment, no further setup. **Skip this step if you already have an account.**

### 3b. Get added to the private repo

GitHub doesn't have a "request access" link for personal-account private repos, so the access has to be granted by Payden directly. Two steps:

1. **DM / email Payden your GitHub username** (just the username, e.g. `flast` — usernames are public, no risk).
2. Watch your email for a message from GitHub titled something like *"@Ned-Yap invited you to Ned-Yap/aim-userscripts-data"*. Click **View invitation** → **Accept invitation**.

After accepting, you can view the repo at [github.com/Ned-Yap/aim-userscripts-data](https://github.com/Ned-Yap/aim-userscripts-data) (it'll 404 until then — that's expected, it's private).

<details>
<summary>For Payden: how to add a coworker</summary>

1. Go to https://github.com/Ned-Yap/aim-userscripts-data/settings/access
2. Click **Add people**
3. Type their GitHub username, click their profile when it appears
4. Choose **Read** access (Contents read-only is all that's needed — they don't need to push)
5. Click **Add NAME to this repository** → GitHub sends them the invite email

</details>

### 3c. Generate a personal access token

⚠ **Important:** Use a **classic** personal access token (not fine-grained). Fine-grained PATs can't access private repos owned by another personal account — that's a GitHub limitation for collaborators, not something we can work around with the current setup. Classic PATs work fine here.

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) (Settings → Developer settings → Personal access tokens → **Tokens (classic)**)
2. Click **Generate new token** → **Generate new token (classic)**
3. Fill in:
   - **Note:** `AIM KML reader` (or whatever helps you find it later)
   - **Expiration:** 1 year (or whatever you prefer)
   - **Scopes:** check the **`repo`** box (this is the only scope you need — gives read access to private repos you have access to)
4. Click **Generate token** at the bottom
5. **Copy the token** (starts with `ghp_…`) — you only see it once. If you lose it, just generate a new one.

> **Why classic and not fine-grained?** GitHub's newer fine-grained tokens can only access repos owned by *your* account or organizations you're a member of. Since the KML repo is owned by Payden's personal account, fine-grained tokens won't list it as an option. Classic tokens use scopes that apply across all repos you have access to.

---

## 4. Paste the token into AIM Controls

1. Reload Percepto on any site
2. Click the gear icon (⚙) in the map toolbar
3. Scroll to the bottom — find **GitHub Connection (KMLs)**
4. Click to expand → paste your token → **Save & Test**
5. Status dot should turn **green** with "Connected"

That's it. The token stays in Tampermonkey's storage on your machine — it never leaves your browser.

> **If KMLs don't appear within ~10 seconds after a successful Save & Test:** do a hard reload — **Ctrl+Shift+R** (⌘+Shift+R on Mac). This forces the browser to clear cached script state from the install burst. Once it works the first time, it stays working — no future hard reloads needed.

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

**"GitHub Connection stays gray / red"** — Token isn't reaching the script. Re-paste it; make sure you copied the full `ghp_…` string with no whitespace. Check that the token has `repo` scope enabled.

**"Power lines render in the wrong place / not at all"** — The site might not have KMLs uploaded yet. Ask Payden.

---

## Reporting bugs & requesting features

We use a **private** GitHub repo for issue tracking so screenshots, videos, and descriptions can include real site data without ending up indexable on the public internet.

1. Go to **[github.com/Ned-Yap/aim-userscripts-issues/issues/new/choose](https://github.com/Ned-Yap/aim-userscripts-issues/issues/new/choose)**
2. Pick **Bug report** or **Feature request** — both have templates that prompt you for what to include
3. Fill in everything you can. Console logs are the single most useful thing for bugs — open DevTools (F12) → Console → reproduce the bug → copy any `[AIM …]` lines plus any red errors

You'll need access to that repo first — same flow as the KMLs repo: send Payden your GitHub username, accept the email invite. (If you've already done that for KMLs, you're set for issues too — just ask to be added.)

## What's changed?

See [**CHANGELOG.md**](https://github.com/Ned-Yap/aim-userscripts/blob/main/CHANGELOG.md) for the running list of what shipped in each update.
