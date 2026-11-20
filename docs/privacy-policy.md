# Privacy policy

Effective 2026-11-15. This policy covers the Glassmere extension for Chrome.

## 1. Who we are

Glassmere is a browser extension for Chrome that blocks ads, trackers and malicious sites. It is
published on the Chrome Web Store by Souayfan-Ali (https://github.com/Souayfan-Ali). Contact: the
publisher e-mail address shown on the extension's Chrome Web Store page, or an issue at
https://github.com/Souayfan-Ali/Glassmere/issues. Security problems: see `SECURITY.md`.

## 2. In short

- The extension makes no network requests. Nothing leaves your device unless you send it yourself: the
  one case is a problem report you choose to open on GitHub (section 6).
- There are no accounts.
- There is no telemetry, no analytics and no crash reporting.

## 3. What the extension processes on your device, and why

To block content, the extension handles your web browsing on your device:

- **Requests.** Chrome itself compares each request a page makes with the filter rules packaged in the
  extension (`declarativeNetRequest`) and blocks the matches. The extension does not see these requests.
  When you open the toolbar panel, Chrome tells it which rules matched in that tab (`activeTab`), so it
  can show counts. The counts are kept in session storage under a one-way hash of the page address (not
  the address), reused for 30 seconds, and cleared when the browser closes.
- **Pages.** With access to all sites (`<all_urls>`), packaged scripts run inside the pages you visit
  to hide leftover ad boxes and stop ad scripts, and, when the pop-up guard is on, to stop pages opening
  ad pop-ups (`scripting`). They work inside the page and send nothing out of it.
- **The element hider.** When you choose "Hide this…" (`contextMenus`, the toolbar panel or the
  keyboard shortcut), the extension works in that one tab and saves a rule that names the site and the
  element.
- **The pop-up blocked page.** When a page tries to open a site known for pop-up ads, Chrome shows the
  extension's own page instead. It reads the blocked address and where it was opened from, on your
  device, to decide whether to close the tab or show you the site's name (and, for some sites, the exact
  address you would proceed to). Nothing is sent.
- **Do not sell or share (GPC).** Off unless you turn it on. When on, Chrome adds the standard Global
  Privacy Control signal to the requests you make and pages can read it. It is the same for every user
  and identifies no one.

## 4. What is stored on your device

| What | Where | Removed by |
|---|---|---|
| Your settings: default level, packs, and the level, pause and pop-up choice of each site you set (site names only, never page addresses) | The extension's own database on your device (`storage`, `unlimitedStorage`, so Chrome does not delete it when the disk is nearly full) | The dashboard's Sites section, one site at a time; uninstalling |
| Elements you chose to hide, with the name of their site | Extension storage on your device | "Undo" right after hiding; "Remove" in the panel's "What you hid on this site" or in the dashboard's "Hidden items"; uninstalling |
| A timer that ends a pause | Chrome's alarms (`alarms`) | It ends on its own |
| Short-lived state (what the panel showed, a breakage check in progress) | Session storage, cleared when the browser closes | Closing the browser |
| The packaged filter rules | The extension package | They are public; updates replace them |

No browsing history is kept. A backup file is written only when you export one yourself, and only to the
place you choose.

**Private windows.** Private windows run a separate copy of the extension. Settings you change in a
private window may be saved on your device like any other setting; this is not yet verified. Nothing is
sent anywhere in either case.

## 5. Network requests

None in this version. New filter rules arrive only through Chrome's own extension updates from the Chrome
Web Store; the extension never fetches anything itself. This is checked by an automated test that
records every request the extension could make (`tests/e2e/noNetwork.spec.ts`) and by a test that
allows only reads of the extension's own files (`tests/unit/platform/boundaries.test.ts`).

Features that would make the extension contact a host: none exist. If one is added, it will be off until
you turn it on, and this policy, the extension's privacy page and the store listing will name the host,
the purpose and what is sent, in the same release.

One button opens a website: "Open a new issue" in the problem report opens `github.com` in a new tab
(section 6). Your browser loads that page as it does any link you click. The extension makes no request
of its own and reads nothing back.

## 6. Problem reports

The breakage flow ("Something wrong on this page?") writes a report on your device and shows it to you
in a box you can edit. Nothing leaves your device while you read or edit it.

What the extension writes in the report:

- the site's hostname only (never the page address, its path, query or fragment);
- the problem you chose and the fixes you tried;
- the extension's version, Chrome's major version, the level, the packs that are on, the pop-up setting
  and whether the extension has access to all sites, this site or none;
- the numbers of up to 20 rules that matched on the page, and how many more there were;
- how many pop-ups were blocked on the page and the codes of the checks that blocked them (never where
  they led).

It contains no account, no identifier of you or your installation, and no page content. Anything you type
into the box is sent as you typed it.

You then choose one of two buttons:

- **Copy report** puts the text on your clipboard. Nothing is sent.
- **Open a new issue** opens a new tab on the extension's public issue tracker,
  `https://github.com/Souayfan-Ali/Glassmere`. The address of that tab carries the report's title (the
  problem and the hostname) and the text in the box, so GitHub receives them when the tab opens. If the
  report is too long for an address, it is copied to your clipboard and the tab carries only the title
  and a note asking you to paste it.

The report becomes a public issue only when you submit it on GitHub, signed in to your GitHub account. If
you close the tab, nothing is published. From the moment the tab opens, GitHub's own privacy statement
and terms apply: GitHub is the recipient, not us. A submitted issue is public, shows your GitHub user
name, and can be read by anyone, including the maintainers. You can edit or delete it on GitHub.

In a private window the report is the same and still names the site; the panel says so before you send.

The extension itself sends nothing in either case: it opens a browser tab and makes no request.

## 7. Sharing, selling, sync

The extension sends us no data, so we have none to share or sell. A problem report you submit on GitHub
(section 6) is public there by your own act; we read it there like anyone else and keep no copy
elsewhere. Chrome Sync is not used.

## 8. Children and your rights

The extension is not directed at children and collects no data from anyone, children included. Because
the extension sends us no personal data, requests to access or delete data held by us have nothing to act on; everything is on
your device and removed by uninstalling. The one exception is a problem report you submitted on GitHub:
it is stored by GitHub under your account, and you can edit or delete it there.

## 9. Permissions

Each permission and why it is needed: `declarativeNetRequest`, `<all_urls>`, `scripting`, `storage`,
`unlimitedStorage`, `activeTab`, `contextMenus`, `alarms`. Full text: `docs/permissions.md` and the
extension's privacy page.

## 10. Changes to this policy

The policy is kept in the extension's source repository with its history. A material change is announced
in the extension before it takes effect.
