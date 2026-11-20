# Release tooling

`npm run release -- <command>` (`compiler/release/main.ts`). Design: update-strategy notes §3, §7.
Everything here runs locally. The store commands are **dry-run by default** and talk to a recorded-contract fake.

| Command | Task | What it does |
|---|---|---|
| `record --zip <zip> [--out <file>]` | P2-01 | Release record: version, SHA-256 of the zip, SHA-256 per unpacked file (E1 input) |
| `repack --base <zip> [--rulesets-dir public] [--snapshot <ISO>] [--out dist/release]` | P2-01 | Ruleset release candidate: the base zip with new safe rulesets and the version `MAJOR.MINOR.RULES_DAY.RULES_HHMM` |
| `gate --base <zip> --candidate <zip> --record <file> --ledgers-before <published ledgers> [--ledgers-after] [--regex-results] [--store-state <file>] [--no-load]` | P2-02 | Eligibility gate E1–E11; exit 0 publish, 1 abort, 3 open a PR, 4 route to the full release, 5 skip |
| `state --candidate <zip> --base-record <file> [--ledger-dir] [--out]` | P2-05 | `ruleset-state` commit files, tag `rules/<version>`, release assets with `SHA256SUMS` (dry run: written to a directory, nothing committed or pushed) |
| `version --tag v<MAJOR>.<MINOR> [--snapshot <ISO>]` | P2-06 | Full-release version: code line from the tag, rules day and time from the snapshot |
| `assets --zip <zip> --source <zip> --out <dir>` | P2-06 | Release assets: zip, source zip, record, `SHA256SUMS` |
| `upload-full --zip <zip>` / `submit-full --zip <zip> --version <v>` | P2-06 | Full release in two steps around the approval: draft upload, then the approved bytes uploaded again and submitted for standard review with staged publishing. Exit 0 ok, 1 refused, 2 manual action |
| `verify-store --crx <published.crx> --zip <release zip> --record <file> [--issue <file>]` | P2-07 | Unpacked contents of the published package vs the record (the store re-signs, adds `_metadata/` and `update_url`); exit 1 and an issue body on a mismatch |
| `match --zip <zip> --url <u> [--url …] [--type main_frame]` | P2-51 | Whether a release blocks a URL: its rulesets (default state) in Chromium, `testMatchOutcome`. Nothing is fetched |
| `drill-bad-rule --zip <zip> --out <dir> --ledger <file> --host <host>` | P2-51 | Drill input only: the release's safe rulesets plus one bad, eligible block of `host`'s documents |
| `status [--fake-published <v>] [--live]` | P2-04 | Store item state in the form the gate's `--store-state` reads |
| `publish-ruleset --zip <zip> --verdict <gate output> [--fake-scenario live\|stays-in-review\|refused\|pending-full-release] [--live]` | P2-04 | Refuses unless the gate verdict says `publish` for these exact bytes; then upload, publish with skip review, poll until live; never falls back to standard review. Exit 0 live, 1 failed, 2 manual action required, 5 skipped |

## Rules the tooling enforces

- A ruleset release changes only safe ruleset files and the manifest `version`. `-x` files, other files and other manifest
  keys cannot be repacked. If they changed, the gate sends the change to the full-release train or aborts.
- The version keeps the base's `MAJOR.MINOR`, must be later than the base, and must not be ahead of the clock.
- The ruleset path can only publish with `skipReview: true`. If the submission is still `PENDING_REVIEW` 15 min after the
  publish call, or at 60 min, the tool cancels **its own** submission (the version must match) and fails. A cancel
  that fails, or an unexpected state after it, exits 2 ("manual action required"). The tool never retries.
- The store contract in `compiler/store/contract.ts` was written from the documentation and is **unverified**. S-12 corrects
  it, together with `fake.ts` and `classifyPoll`.

## Incident: a bad ruleset release (update-strategy notes §8)

Roll forward; never roll back. `scripts/incident-rehearsal.sh <base zip> <work dir> [<site url>]` rehearses it with the
fake store (P2-51). Live, the same steps are:

1. Confirm: `npm run release -- match --zip <live zip> --url <broken site>` says `blocked`.
2. Take the lock of the last good release from its `rules/<version>` tag on `ruleset-state` and put it in
   `lists/lists.lock.json`. Keep the **current** ledgers, so ids are never reused.
3. `lists:fetch` (locked), then `lists:build`.
4. `repack --base <live zip>` with the current time as the snapshot, so the version is higher than the bad one.
5. `gate`, then `publish-ruleset --verdict`, then `state`.
6. Confirm with `match` that the site is `allowed`. Report upstream. If one filter is the cause, add a dated
   `lists/overrides/` entry.

Rehearsed time from detection to the candidate being published: about 39 s locally. Live time adds the store's
skip-review turnaround (minutes, S-12) and Chrome's update interval.

## What the owner must supply (NEEDS MAINTAINER)

1. The developer account and the unlisted item (P1-47, S-12). Then put the publisher id and the item id into
   `compiler/store/store.config.json` in place of the `OWNER_…` placeholders.
2. A Google service account that has access to the item. Its JSON key goes only into the protected CI environment.
   Set `GLASSMERE_CWS_KEY_FILE` to the key file's path. The key is never committed and never logged.
3. Verified uploads, if they are enabled: the signing key and the signing step. These are not built yet. P2-06 owns them.
4. The release record of the first published zip: `npm run release -- record --zip <published zip>`, kept on
   `ruleset-state` (tooling notes §7).

`--live` refuses to run until items 1 and 2 are in place. It has not been run yet.
