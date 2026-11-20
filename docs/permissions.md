# Permissions

**DRAFT, not legally reviewed.** (Q-09.) Source of truth for what the manifest declares and why
(ADR-007). `tests/unit/core/manifest.test.ts` checks that every
`declared` row below is in the manifest and nothing else is. The user-facing table on the privacy page
(P2-36) is generated from `src/features/dashboard/privacy/permissions.ts`, which a unit test checks against
this file and the manifest.

| Permission | Status | Why | Added by |
|---|---|---|---|
| `declarativeNetRequest` | declared | Chrome blocks requests from our rulesets; no host access needed for `block`/`allow`. The plain variant keeps skip-review eligibility | P1-13 |
| `scripting` | declared | Register the cosmetic, scriptlet and pop-up guard content scripts, which Chrome injects with the worker asleep. The toolbar panel's "Show on page" (P2-22b, D-50): the panel itself (no worker message) calls `executeScript` on its tab's top frame with one packaged function (`features/popup/hidden/showOnPage.ts`) and the selector as a JSON argument; it only outlines and un-hides for 20 s, writes nothing (no storage, nothing left in the page) and reverts on its timer or when the panel closes | P1-13, P2-22b |
| `storage` | declared | `storage.session` for the reconcile flag; `storage.local` only for user cosmetic filters (P2) | P1-13 |
| `unlimitedStorage` | declared | Keeps the IndexedDB vault (settings) out of quota eviction; no install warning. Re-checked in P1-09: still needed for eviction protection, not for capacity | P1-13 |
| `alarms` | declared | Pause expiry; daily integrity audit (P2) | P1-13 |
| `<all_urls>` | declared | Host access for cosmetic filtering, scriptlets, surrogates and the blocked page (T2, Q-04). Required; Light still works without it | P1-13 |
| `activeTab` | declared | Injects the on-demand element hider into the tab the user started it in (toolbar button, context menu, shortcut); the toolbar panel's per-tab grant: `getMatchedRules` for the privacy panel's counts (UI notes §4) and the panel on "on click" profiles (architecture notes §8); "Show on page" for a hidden item in that tab (P2-22b), so it also works where the user withheld site access. No install warning. The grant after a real toolbar click is checked by hand on the release checklist: Playwright cannot click the toolbar, so the E2E (J10) uses a test-only copy with `declarativeNetRequestFeedback`, which the build itself refuses | P2-11, P2-21, P2-22b |
| `contextMenus` | declared | "Hide this…" in the page's context menu (element hider entry). No install warning (S-10) | P2-21 |

Never declared (ADR-007 item 3): `tabs`, `webNavigation`, `webRequest`, `declarativeNetRequestFeedback`,
`declarativeNetRequestWithHostAccess`. Release gate: before the first unlisted or public submission
the declared set must equal the frozen ADR-007 v1.0 set (no `pending` row left).

## Store justification text

<!-- guard-scripts: registered -->
Status in this build: guard scripts registered when the user turns the guard on. The pop-up guard sentences below describe
the opt-in guard (off by default).

The text pasted into the Chrome Web Store's privacy-practices form, one paragraph per permission
(store notes §4.1). `tests/unit/repo/docs.test.ts` checks that this table names exactly the permissions the
manifest declares. The user-facing wording on the privacy page is `src/features/dashboard/privacy/permissions.ts`.

| Permission | Justification |
|---|---|
| `declarativeNetRequest` | Core function: blocks ad, tracker and malware requests with Chrome's built-in rule engine. The rules are packaged in the extension; the extension does not see the requests. It also blocks navigations to sites known for pop-up ads |
| `<all_urls>` | Needed to hide leftover ad containers and stop ad scripts on any site the user visits, for redirect rules that replace ad scripts with packaged harmless files, and to send pop-up ad navigations to the extension's own explanation page (`blocked.html`), and, only if the user turns on the optional pop-up guard, to stop windows a page opens without the user asking, by checking the click that preceded them; no page content leaves the page. Page content is never read out, stored or transmitted. If the user withholds this access, the extension keeps blocking requests on every site (Light mode) |
| `scripting` | Registers the packaged content scripts that apply element hiding and the packaged anti-ad scripts, so Chrome injects them while the service worker sleeps; registers the optional pop-up guard scripts when the user turns the guard on; injects the element hider into the current tab when the user starts it; when the user asks to see an element they hid, temporarily outlines it in the current tab |
| `storage` | Keeps the user's hidden-element rules and short-lived session state on the device |
| `unlimitedStorage` | Keeps the on-device settings database out of Chrome's quota eviction, so the user's settings are not deleted when the disk is nearly full |
| `activeTab` | After the user clicks the toolbar button, the context-menu item or the keyboard shortcut, lets the extension show which rules matched in that one tab, start the element hider there and briefly outline an element the user hid there |
| `contextMenus` | Adds "Hide this…" to the page's context menu |
| `alarms` | Ends a timed pause the user chose; runs a daily on-device integrity check of the user's hidden-element rules, only while there are any |
