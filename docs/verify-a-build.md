# Verify a build

Draft (P2-48). Glassmere's release builds are reproducible: the same source tag, lock files and list
snapshots give the same bytes, so anyone can check that a package was built from the published source
(tooling notes §8, security notes §8). This page has the commands.

## What is published per release

- The source tag.
- `SHA256SUMS`: one line `<sha256>  <path>` per file of the unpacked extension, sorted by path.
- The **unpacked tree hash**: the SHA-256 of that `SHA256SUMS` file.
- The SHA-256 of the zip uploaded to the Chrome Web Store.

The store re-signs packages and adds a `_metadata/` folder, so compare **unpacked contents**, not the
CRX or the zip you download from the store.

## Rebuild from the tag

Needs Node 22, npm, git, and Playwright's Chromium (`npx playwright install chromium`; the list build
uses it to check regular expressions).

```sh
git clone <repository> glassmere && cd glassmere
git checkout <tag>
npm ci
npm run lists:fetch -- --drop-pending   # git-pinned lists are downloaded, hash-checked; unversioned lists come from lists/snapshots/
npm run vendor:fetch     # downloads uBO's resources named in vendor.lock.json, hash-checked
npm run lists:build -- --drop-pending   # the store zip is this build (packs whose licence is not cleared are left out)
npm run build
npm run zip
```

A list snapshot whose hash does not match the lock file stops the build; it never builds from other
bytes.

## Compare

Compute the unpacked tree hash of your build:

```sh
cd .output/chrome-mv3
find . -type f | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do sha256sum "$f"; done > ../SHA256SUMS
sha256sum ../SHA256SUMS
```

The last line must equal the published unpacked tree hash; `diff` your `SHA256SUMS` with the published
one names any file that differs. `sha256sum .output/glassmere-*-chrome.zip` must equal the published zip
hash.

To check the package the store serves, download the CRX for the extension id, strip the CRX header
(any CRX-to-zip tool), unzip it, delete `_metadata/`, and run the same `find … sha256sum` commands in
that folder.

## The project's own gate

`npm run repro` does the comparison for every change: two clean checkouts of `HEAD`, with different
file dates, time zones, locales and umasks, the second built in a `node:22-bookworm-slim` container
(the build step without network). It compares `public/` and the unpacked extension file by file,
binary surrogates included, and the two zips, and prints the unpacked tree hash. It also fails if the
production build contains the pop-up guard's log-only path (`GLASSMERE_POPUP_LOG_ONLY`,
`__POPUP_GUARD_LOG_ONLY__`, `data-sp-log`), which only test builds may carry. `npm run lists:build --
--check-determinism` repeats the list build in one process and compares the shipped, debug and binary
outputs.

## Limits

- A second physical machine has not yet reproduced a release; the container stands in for it until
  the owner runs the check elsewhere (P2-48 is PARTIAL on this point).
- Hashes for a release are published by the release workflow, which is not built yet.
