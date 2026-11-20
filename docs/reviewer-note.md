# Reviewer note (template)

Pasted into the "notes for the reviewer" field on every full submission (store notes §6). Fill in the
*owner* fields per release; keep the rest as is unless the code changed.
Draft of 2026-11-14 (P2-49).

---

**Release:** *version* · source tag *tag* · unpacked tree hash *sha256* (owner, per release)

**What changed since the last full release:** *owner, per release*

**Single purpose.** Glassmere blocks unwanted content (advertising, tracking and malicious requests and
page elements) to protect the user's privacy and attention. Every setting is a variant of that: filter
packs (cookie banners, annoyances, regional lists), tracking-parameter removal and the "do not sell or
share" signal (GPC) are content blocking and privacy protection.

**No remote code, no network.** The extension makes no network requests at all. There is no `eval`, no
`new Function`, no string timer and no external script; the extension pages run under
`script-src 'self'; object-src 'none'; base-uri 'none'`. The only `fetch` in the code reads files of the
extension's own package (`src/platform/catalog.ts`, constant `chrome-extension://` URLs). Tests:
`tests/e2e/noNetwork.spec.ts` records every request from the worker, the extension pages and the pages
visited during a full session and asserts there are none; `tests/unit/platform/boundaries.test.ts`
keeps network access out of the rest of the code. Filter updates arrive only as new store versions.

**Where the page scripts are.** All code and data that runs in pages is in the package:

| Package path | What it is |
|---|---|
| `rulesets/` | `declarativeNetRequest` rulesets compiled at build time from the public filter lists named in `CREDITS.md`. Rulesets whose ids end in `-x` contain redirect or header rules and are `enabled: false` in the manifest; the worker enables them only while access to all sites is granted |
| `scriptlets/<pack>.main.js`, `scriptlets/<pack>.isolated.js` | The anti-ad scripts ("scriptlets"): uBlock Origin's open-source scriptlet code at a pinned commit, unmodified apart from whitespace. They run in the MAIN world because they must wrap page functions (for example `setTimeout` or `fetch`) before page scripts do. They make no requests |
| `scriptlets/<pack>/…` | The data saying which scriptlet runs on which host with which arguments. Arguments are JSON data passed to the packaged functions; no string is ever evaluated |
| `cosmetic/`, `registrations.json` | Element-hiding selectors per host, and the list of content-script registrations (with a SHA-256 checked by the worker). Selectors are applied only as `display:none!important` |
| `gpc.js` | MAIN-world, registered only when the user turns on "Do not sell or share": sets `navigator.globalPrivacyControl` to true. Nothing else |
| `cosmetic-*.js`, `user-cosmetic.js`, `picker.js` | ISOLATED-world scripts: element hiding, and the element hider, which is injected only into the tab where the user starts it |
| `surrogates/` | Harmless stand-ins that redirect rules serve instead of ad scripts (uBlock Origin's resources). One inert HTML file, `noop.html`, has no script and is pinned by hash |

All content scripts are registered by the service worker with `chrome.scripting`; the manifest has no
`content_scripts` key.

**Web-accessible resources.** All with `use_dynamic_url: true`.

| Resource | Why |
|---|---|
| `surrogates/*` | Targets of redirect rules (above) |
| `picker-panel.html` | The element hider's panel, framed inside the page the user is editing (http and https pages only) |
| `blocked.html` | Where a navigation to a site known for pop-up ads lands (see below) |

**Pop-up protection.**

<!-- guard-scripts: registered -->
Status in this build: guard scripts registered when the user turns the guard on.

- `blocked.html` (on by default). Navigations to hosts on the packaged pop-up lists are redirected by a
  `declarativeNetRequest` rule to this extension page; the request to the listed host is never sent.
  These redirect rules exist only while access to all sites is granted. The page is static HTML and a
  small script; it reads only the hostname from its URL fragment and shows it as text. It closes **only
  its own tab**, and only when that tab is a fresh tab whose opener's guard script (so only with the guard
  on) confirms that a page script opened it moments before and reports no real click on a visible link
  to that host. Otherwise it stays and offers Close tab, Go
  back or "Proceed once"; "Proceed once" asks the service worker for a session rule that allows that one
  host in that one tab.
- `popup-shim.js` (MAIN world) and `popup-sentinel.js` (ISOLATED world), the optional pop-up guard,
  **off by default**; registered only when the user turns it on, in top-level documents only, with sites
  the user exempted excluded. The shim is a small packaged file that wraps `window.open`, the three-argument
  `document.open` (its alias) and the frame getters through which a page can reach another same-origin
  realm's `open`, and asks the sentinel, through an event type agreed per document before page scripts
  run, whether to let the call through; the sentinel judges it by the user's click that came before and a
  short packaged list of sign-in and payment windows. It
  carries no data, makes no request, evaluates no string, and calls the native function on any error.
  The sentinel stores nothing; it keeps at most 20 blocked hostnames in page memory and answers only
  the extension's own pages. `popup-strict.js` is a one-line flag file for the Strict mode, and `popup-quiet.js` one for
  "Tell me when a pop-up is blocked" turned off.

**Permissions.** Each has a justification in the privacy-practices tab and in `docs/permissions.md`.
`<all_urls>` is required at install. Without it the extension still blocks requests everywhere, and
never installs a redirect rule it could not apply.

**Minified, not obfuscated.** Chunk names are readable. The build is reproducible from the source tag:
`docs/verify-a-build.md` has the commands and the hashes to compare. *Owner: link to the public tag.*

**Requirements.** Chrome 145 or later. No test account is needed: every feature works on any public
page, and there is no sign-in.
