# Trust pledge

**DRAFT, not legally reviewed.** Pledge **v0 (draft)**, adopted on 2026-11-13
(Q-03). It becomes v1 only when the owner signs it.

The product name, Glassmere, lives in one constant, `src/core/brand.ts`.

## The pledge (v0, draft)

1. No paid allowlisting, no "acceptable ads", no affiliate links, no ads of our own.
2. No telemetry. No analytics. No remote configuration.
3. No network request unless you turn on a feature that needs one; each such feature is listed here with the exact host it contacts.
4. Minimal permissions, each explained on this page; new ones only for a shipped feature.
5. Every store release can be rebuilt from its public source, and the hashes are published.
6. The listing will not be sold or transferred without 90 days of public notice.
7. Publishing needs verified uploads and two-step verification; who can publish is public.
8. Changes to this pledge are versioned and announced in the changelog.

The text above is the one shown on the extension's privacy page
(`src/features/dashboard/privacy/strings.ts`); `tests/unit/repo/docs.test.ts` fails if the two differ.
"This page" in items 3 and 4 is that privacy page.

## How each item is kept today

| # | Kind | State in this build |
|---|---|---|
| 1 | Promise | No allowlisting deal exists. Nothing in the package can add an exception except the public filter lists and the user |
| 2 | Promise, checked | No analytics or error-reporting code. Settings are local; nothing is fetched to change behaviour |
| 3 | Promise, checked | No feature contacts a host, so the list of such features is empty. J16 (`tests/e2e/noNetwork.spec.ts`) asserts zero extension-initiated requests; `tests/unit/platform/boundaries.test.ts` keeps the only `fetch` to our own package files. The problem report's "Open a new issue" opens `github.com` in a browser tab on the user's click; the extension makes no request (privacy policy §6) |
| 4 | Promise, checked | `docs/permissions.md` justifies each permission; `tests/unit/core/manifest.test.ts` checks the manifest against it |
| 5 | Checkable | The reproducible build gate and `docs/verify-a-build.md` exist. **Not yet true:** the source is public and version 1.0.0 is published, but its hashes are not |
| 6 | Promise | The listing is published and has not been sold or transferred |
| 7 | Checkable | **Not yet true:** there is no public list of publishers, and verified uploads and two-step verification are not yet confirmed here |
| 8 | Promise | This file is versioned in git. There is no changelog file yet (P2-38 follow-up) |

## Before this pledge is published

- The owner signs it and publishes who can publish.
- Items 5 and 7 become true.
- A changelog exists for item 8.
- The privacy page drops "draft" in the same full release.
