# Credits

> **DRAFT — NOT LEGALLY REVIEWED.** Evidence table built in S-13 (P0-24) on 2026-11-13 from the list
> headers and upstream repositories; method and raw evidence in
> spike S-13. **Owner sign-off pending** (NEEDS MAINTAINER, P2-52). Not legal advice.

Glassmere is free software under the GNU General Public License, version 3 or (at your option) any later
version. See [LICENSE](LICENSE). Because bundled components are GPL-3.0 without "or later", the package as a
whole is conveyed under GPL-3.0 (ADR-002).

## Filter lists

Filter lists are bundled only when their licence has been cleared with evidence from the list header or
upstream repository. Non-commercial lists are excluded. **Unclear means excluded.** Compiled rulesets and
cosmetic data carry the licence of their source lists. Where a list offers a choice, the option we take is in
bold.

Status key: **Cleared** = evidence found, bundled in v1.0 if its pack ships; **Pending** = evidence found, our reading not yet confirmed by the owner; left out of the published build and of lists/snapshots/ until confirmed; **Excluded** = not in the v1.0
package.

### Default-on

| List | Authors | Homepage | Licence | Evidence (2026-11-13) | Status |
|---|---|---|---|---|---|
| uBlock filters (ads), – Privacy, – Unbreak, – Quick fixes, uBO Lite filters | uBlock Origin team (uAssets contributors) | https://github.com/uBlockOrigin/uAssets | GPL-3.0 | Header `License: https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE` in each file; that file is the GPL-3.0 text | Cleared |
| uBlock filters – Badware risks | uBlock Origin team | https://github.com/uBlockOrigin/uAssets | GPL-3.0 | Same header and LICENSE | Cleared |
| EasyList | The EasyList authors | https://easylist.to/ | **GPL-3.0-or-later** or CC BY-SA 3.0-or-later | Header `Licence: https://easylist.to/pages/licence.html`; the page dual-licenses the contents of github.com/easylist and names EasyList explicitly | Cleared |
| EasyPrivacy | The EasyList authors | https://easylist.to/ | **GPL-3.0-or-later** or CC BY-SA 3.0-or-later | Same; named explicitly on the licence page | Cleared |
| Malicious Hosts Blocklist (URLhaus, hosts variant) | curbengh (malware-filter); data: abuse.ch URLhaus | https://gitlab.com/malware-filter/urlhaus-filter | CC0-1.0 (list) / MIT (scripts); URLhaus data CC0 | Header `License: https://gitlab.com/malware-filter/urlhaus-filter#license`; README §License: "Creative Commons Zero v1.0 Universal and MIT License", "URLhaus: CC0" | Cleared |

### Optional packs

| Pack | List | Authors | Licence | Evidence | Status |
|---|---|---|---|---|---|
| Cookie banners | EasyList – Cookie Notices / Easylist Cookie List | The EasyList authors | **CC BY 3.0** (attribution) — conflicting evidence, the stricter reading taken | uAssets mirror header points to the dual-licence page; the upstream `fanboy-cookiemonster.txt` header says `License: http://creativecommons.org/licenses/by/3.0/` | Cleared (CC BY with header evidence, Q-02) |
| Cookie banners | uBlock filters – Cookie Notices | uBlock Origin team | GPL-3.0 | uAssets header + LICENSE | Cleared |
| Overlays | EasyList – Newsletter Notices; uBlock filters – Other Annoyances | The EasyList authors; uBlock Origin team | **GPL-3.0-or-later** / CC BY-SA 3.0; GPL-3.0 | Headers: licence page (built from the easylist/easylist repository); uAssets LICENSE | Cleared |
| Social | EasyList – Social Widgets | The EasyList authors | **GPL-3.0-or-later** / CC BY-SA 3.0 | Header → licence page. Conflict: the uBO wiki lists Fanboy Social as CC BY 3.0; the file header (primary source) is taken | Cleared |
| Widgets | EasyList – Chat Widgets | The EasyList authors | **GPL-3.0-or-later** / CC BY-SA 3.0 | Header → licence page | Cleared |
| Other annoyances | EasyList – Annoyances | The EasyList authors | **GPL-3.0-or-later** / CC BY-SA 3.0 | Header → licence page | Cleared |
| Notifications | EasyList – Notifications | The EasyList authors | **GPL-3.0-or-later** / CC BY-SA 3.0 | Header → licence page | Cleared |
| Tracking parameters | AdGuard/uBO – URL Tracking Protection (`privacy-removeparam.txt`) | uBlock Origin team, from AdGuard's URL Tracking filter | GPL-3.0 | uAssets header + LICENSE; AdGuard URL Tracking filter header → AdguardFilters LICENSE (GPL-3.0) | Cleared |
| Regional — German | EasyList Germany | The EasyList authors | **GPL-3.0-or-later** / CC BY-SA 3.0 | Header → licence page; named explicitly on the page | Cleared |
| Regional — Italian | EasyList Italy | The EasyList authors | **GPL-3.0-or-later** / CC BY-SA 3.0 | Header (`Licenza:`) → licence page; named explicitly | Cleared |
| Regional — Japanese | AdGuard Japanese filter | AdGuard | GPL-3.0 | Header `License: https://github.com/AdguardTeam/AdguardFilters/blob/master/LICENSE` (GPL-3.0 text) | Cleared |
| Regional — Chinese | EasyList China | The EasyList authors | **GPL-3.0-or-later** / CC BY-SA 3.0 | Header → licence page; the list lives in the github.com/easylist organisation the page covers. Note: the page warns that files "hosted externally …, including but not limited to subscriptions other than EasyList, EasyPrivacy, EasyList Germany and EasyList Italy, may be available under other conditions" — owner to confirm our reading (the list is not hosted externally) | Pending (owner to confirm) |
| Regional — Spanish/Portuguese | EasyList Spanish; EasyList Portuguese | The EasyList authors | **GPL-3.0-or-later** / CC BY-SA 3.0 | Header → licence page; same note as EasyList China | Pending (owner to confirm) |
| Regional — Dutch | AdGuard Dutch filter | AdGuard | GPL-3.0 | Header → AdguardFilters LICENSE (GPL-3.0). Alternative EasyDutch: repository licence GPL-3.0, no licence line in the file | Cleared |
| Regional — French | Liste FR | Liste FR authors | CC BY-SA 3.0 only | Header `Licence : https://creativecommons.org/licenses/by-sa/3.0/`. Share-alike 3.0 content compiled into a GPL-3.0 package is a legal question (BY-SA 3.0 is not GPL-compatible) | **Excluded** — pack dropped (Q-17); AdGuard French (GPL-3.0) is an owner option |
| Regional — Russian | RU AdList | RU AdList authors | Not stated | No licence line in `RuAdList-uBO.txt` or `advblock+cssfixes.txt`; the repository has no licence file. Only secondary source: the uBO wiki (CC BY 3.0) | **Excluded** — unclear, pack dropped (Q-17) |

### Excluded by policy

| List | Reason | Evidence |
|---|---|---|
| Peter Lowe's list | Non-commercial terms reported (research notes 03 §3.5); no licence statement in the file or on its policy page | `serverlist.php` header has credits and a policy link, no licence; `policy.php` states inclusion policy only |
| Dan Pollock's hosts | Non-commercial (research notes 03 §3.5) | Not re-fetched |
| Liste AR | Excluded in filter-pipeline notes §3.3. Conflict: research says CC BY-NC-SA 3.0; the file header says `Licence : https://creativecommons.org/licenses/by-sa/3.0/` | Header, 2026-11-13 |
| Anti-paywall lists | Store policy | filter-pipeline notes §3.3 |

Unmodified copies of the unversioned lists pinned by lists/lists.lock.json are kept in lists/snapshots/, each under its own licence as listed above; lists whose status is not "Cleared" are not kept there.

## Tracker-entity databases

| Database | Licence | Evidence | Status |
|---|---|---|---|
| DuckDuckGo Tracker Radar | CC BY-NC-SA 4.0 | `LICENSE`: "Licensed under the CC BY-NC-SA 4.0 license" | **Excluded** (non-commercial). Used only to measure bucket cost in S-02b; nothing from it ships |
| Ghostery TrackerDB | CC BY-NC-SA 4.0 | `LICENSE`: "Licensed under the CC-BY-NC-SA-4.0 license" | **Excluded** (non-commercial) |
| Our `lists/entities.json` (≤ 300 companies, hand-maintained) | GPL-3.0-or-later | Ours | Planned (filter-pipeline notes §6.2) |

## Vendored code and runtime libraries

| Component | Upstream | Version / commit | Licence | Status |
|---|---|---|---|---|
| uBO scriptlets, redirect resources, procedural engine (ADR-005) | https://github.com/gorhill/uBlock | `2bc679d99afe5bddd8fe3ab60137966a12123f41`, every file pinned by SHA-256 in `vendor/vendor.lock.json` | GPL-3.0-or-later (file headers); repository `LICENSE.txt` GPL-3.0 | Vendored. Shipped: uBOL's `css-procedural-api.js` verbatim as `cosmetic/procedural-engine.js` (its GPL header kept, P1-28); the referenced scriptlet functions (P1-29) and redirect resources (P1-30). Build time only: `static-filtering-parser.js`, `arglist-parser.js`, `jsonpath.js` (uBO's own selector compiler and argument parser, no dialect translation) |
| css-tree (as vendored in uBO, build time only, not shipped) | https://github.com/csstree/csstree via uBO `src/lib/csstree/` | same uBO commit | MIT (`src/lib/csstree/LICENSE`) | Vendored for uBO's selector compiler |
| `@adguard/agtree` (build time only, not shipped) | https://github.com/AdguardTeam/tsurlfilter | 4.4.0 | MIT | Planned |
| `@adguard/dnr-converter` (build time only, not shipped) | https://github.com/AdguardTeam/tsurlfilter | 2.1.0 | GPL-3.0-only | Planned |
