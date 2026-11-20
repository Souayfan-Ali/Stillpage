# Runbooks

What to do when something goes wrong after release (update-strategy notes §8, security notes §12, store notes §6 and §8). Draft
of 2026-11-14 (P2-49). Nothing here has been run live: every store step needs the developer account. Commands are those of `docs/release-tooling.md`.

Ground rules: roll forward, never back; `lists/overrides/` is the only place we change upstream
behaviour, each entry dated, linked and expiring; every reviewer message goes into the store log
(kept with the release records, not in this repository).

## 1. A new network rule breaks a major site

1. Confirm with the rule ids from the user's report (the report lists `ruleset#id`) and
   `npm run release -- match --zip <live zip> --url <site>`.
2. Add a dated `lists/overrides/` entry: a `$badfilter` or an exception, with the upstream issue link and
   an expiry date.
3. Run the ruleset release (`lists:build`, `repack`, `gate`, `publish-ruleset`, `state`).
4. Report upstream with the evidence. Remove the override when upstream fixes it.

Time to users: minutes plus Chrome's update interval.

## 2. A cosmetic or scriptlet filter breaks a site

These change only in full releases (they are code-adjacent). Add the override, cut an on-demand full
release, and in the meantime tell users the one-click workaround: **Light on this site** in the toolbar
panel. Time to users: days (store review).

## 3. A bad ruleset release (mass breakage)

Roll forward to the previous lock: the steps are in `docs/release-tooling.md` ("Incident: a bad ruleset
release"), rehearsed with `scripts/incident-rehearsal.sh` (P2-51, ≈ 39 s locally to a published
candidate against the fake store).

## 4. A bad full release

1. Stop ruleset releases (eligibility requires a healthy item).
2. If the store offers a rollback, use it (UNVERIFIED). Otherwise re-submit the previous code as a
   higher version with `upload-full` / `submit-full`.
3. Unpublish only as a last resort: it removes the extension from every user.

## 5. Store rejection, warning or takedown

1. Treat a warning or takedown as top severity; stop ruleset releases.
2. Record the message verbatim in the store log.
3. Fix what is asked, answer through the dashboard's appeal flow, and point to `docs/reviewer-note.md`,
   `docs/permissions.md` and `docs/verify-a-build.md`.
4. Never argue in public; never re-submit unchanged.

## 6. Skip review withdrawn or policy changed

Ruleset content joins the full-release train; the cadence becomes review-bound. Publish a notice in the
repository and update the limits page ("A short gap after each update" and the update cadence).

## 7. Publishing credentials suspected compromised

1. Revoke the service-account key in Google Cloud; remove `GLASSMERE_CWS_KEY_FILE` from the protected
   environment.
2. Rotate the verified-uploads signing key (needs store support).
3. Compare every published package with its release record:
   `npm run release -- verify-store --crx <published.crx> --zip <release zip> --record <file>`.
4. Write a post-incident note in the repository.

## 8. Security report

Follow `SECURITY.md`: private report, answer within 72 hours, private fix, on-demand full release,
advisory after the store has published. A network-rule mitigation can go out the same day as a ruleset
release.

## 9. Support triage (weekly, 30 minutes)

- Filter problems: confirm with the rule ids, report upstream; carry an override only when the breakage
  is severe.
- "Not possible in MV3": answer politely with a link to `docs/limits.md`.
- One open issue per site; close duplicates by hostname.
- Store reviews: read daily in the first month, weekly after; reply with concrete steps, link the
  breakage flow, never argue.
