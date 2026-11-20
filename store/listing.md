# Chrome Web Store listing (draft)

**DRAFT, not legally reviewed.** Draft copy of 2026-11-14 (P2-50); name changed to Glassmere on
2026-11-20, version 1.0.0 published. Final copy and approval are the owner's. Field order follows store notes §3.

**Name:** Glassmere - Ad Blocker

**Summary:** Blocks ads and trackers quietly. No paid exceptions for advertisers, no telemetry, no data collection.

The repository is public, so " Open source." can be appended (still under 132 characters).
The store takes the summary from the manifest `description`, which reads it from `_locales/en/messages.json`
(`ext_description`, P2-40); `tests/unit/repo/locales.test.ts` keeps the two equal.

**Category:** Privacy & Security (check the current category list at submission)

**Single purpose:** Blocks unwanted content (advertising, tracking and malicious requests and page
elements) to protect the user's privacy and attention.

**Language:** English

**Mature content:** No

**Links:** homepage: <https://glassmere-eight.vercel.app/>; support: <https://github.com/Souayfan-Ali/Glassmere/issues>;
privacy policy: <https://glassmere-eight.vercel.app/privacy/>

## Description

Glassmere blocks ads, trackers and sites known for malware, quietly, inside Chrome.

What it does
• Blocks ad, tracker and malware requests with Chrome's own rule engine, from well-known public filter lists packaged in the extension.
• Hides leftover ad boxes and stops ad scripts on the sites you visit.
• Three levels per site: Light, Standard and Thorough, plus Off. A broken page has a guided fix: one question, then the next step to try.
• Optional packs: cookie banners, annoyances, regional lists, removing tracking codes from links, and the "do not sell or share" signal (GPC).
• "Hide this…" for anything the lists miss, with Undo.
• A panel that shows what was blocked on the current page, by category.
• Pages known for pop-up ads are stopped. An optional pop-up guard can also stop windows a page opens without your click.

What it does not do
• It makes no network requests. New rules arrive only as extension updates from this store. One thing can leave your device, and only when you choose it: "Open a new issue" in a problem report opens github.com in a browser tab with the report you reviewed.
• No telemetry, no analytics, no accounts.
• It makes no promise about any particular site. Some sites change more often than filter lists can follow; the limits page in the repository lists what Manifest V3 extensions cannot do.

Our pledge (v0, draft)
• No paid allowlisting, no ads of our own, no affiliate links.
• No telemetry, no analytics, no remote configuration.
• No network request unless you turn on a feature that needs one.
• Minimal permissions, each explained.
• Release builds can be rebuilt from the public source and compared with the published hashes.

Permissions
• "Block content on any page": Chrome blocks requests from the packaged rules. The extension never sees your requests.
• "Read and change all your data on all websites": needed to hide leftover ad boxes, stop ad scripts and show the pop-up blocked page. Nothing is read out, stored or sent. Without it, the extension still blocks requests everywhere.
• Everything else (storage, scripting, alarms, context menu, the current tab after your click) is explained on the extension's privacy page.

## Screenshots

Made from the real build with Playwright on local fixture pages (`.example` hosts, invented content), no
network (`tests/e2e/store/storeAssets.spec.ts`, run with `npm run store:assets`). Captions:

1. `store/screenshots/1-panel.png`: "See and change protection for each site from the toolbar."
2. `store/screenshots/2-what-was-blocked.png`: "What was blocked on this page, by category."
3. `store/screenshots/3-fix-this-page.png`: "Something wrong? A guided fix, one step at a time."
4. `store/screenshots/4-hide-element.png`: "Hide anything the lists miss, with a preview."
5. `store/screenshots/5-dashboard-dark.png`: "Packs and settings, in light or dark."

Onboarding is not shown: the store is understood to allow at most five screenshots (check at submission).

## Graphics

- Logo: `store/logo/glassmere-logo.png` (owner-supplied, 1774 × 887: mark and wordmark).
- Icon: `store/icon/icon.svg` (the logo's mark since P3-16: a page with a folded corner and two waves), rendered to
  `store/icon/icon-16.png`, `-32`, `-48`, `-128`. A desaturated "paused" variant is
  `store/icon/icon-paused.svg`. The icon does not depend on the name. The manifest's `icons` key uses
  the PNGs.
- Small promo tile: `store/promo-tile-440x280.png`.

## Claims we do not make

Total-coverage claims ("all ads"), any named site, speed or memory comparisons, any competitor's name (store notes §3,
performance notes §8). `tests/unit/repo/storeListing.test.ts` checks this file.
