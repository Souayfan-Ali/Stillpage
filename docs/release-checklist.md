# Release checklist

Run before the first unlisted submission and before every full release (store notes §9). Draft of
2026-11-14 (P2-49). Items marked **manual** cannot be automated; record who ran them, when, on which
build (version and unpacked tree hash) and the result in the release record.

## Automated gates (must be green)

- [ ] `npm run verify` (while the ESLint config is frozen: the steps one by one, lint with
      `npx eslint . --ignore-pattern '.cache/**' --ignore-pattern 'vendor/**' --ignore-pattern 'public/**'`).
- [ ] `npm run test:e2e`, including J16 zero network (`tests/e2e/noNetwork.spec.ts`) and the a11y runs.
- [ ] `npm run size` and the release perf gate on a quiet machine (`npm run test:perf`).
- [ ] Reproducible build: a second clean environment gives the same unpacked tree hash
      (`docs/verify-a-build.md`).
- [ ] Differential oracle reviewed; no unexplained class above its ceiling.
- [ ] Store build made with `--drop-pending`; a `--channel public` build refuses the placeholder
      `ISSUE_TRACKER_URL` and owner-pending packs.

## Documents

- [ ] `docs/permissions.md` matches the built manifest (unit tests green) and the store form's
      justifications are pasted from its "Store justification text" table.
- [ ] Privacy policy reviewed by a qualified person and published; the privacy tab of the
      store matches it; the extension's privacy page drops "draft" in the same release.
- [ ] Pledge signed; `docs/pledge.md` and the privacy page agree (unit test green).
- [ ] `docs/limits.md` re-read against this release.
- [ ] `docs/reviewer-note.md` filled in for this release.
- [ ] `CREDITS.md` and third-party notices signed off (S-13).
- [ ] Listing copy, icon and screenshots final (`store/`), name checked.

## Manual checks (record each)

- [ ] **manual** Toolbar click grants `activeTab`: on a page with blocked requests, click the toolbar
      icon; the privacy panel shows counts. (Playwright cannot click the toolbar; J10 uses a test-only copy.)
- [ ] **manual** Install from the packed zip in a fresh profile: no warning other than "Read and change
      all your data on all websites" (and "Block content on any page"); onboarding opens once.
- [ ] **manual** Site access "On click": the panel says blocking only and offers **Allow on all sites**;
      no ad page loads through a redirect rule.
- [ ] **manual** Private window with the extension allowed in incognito: blocking works; record whether
      a site level set there is still set after closing all private windows (privacy policy §4 says
      "not yet verified").
- [ ] **manual** Screen-reader pass (P2-45 checklist).
- [ ] **manual** Hide element entry points (D-61, P2-21) on a site with site access "On click": right-click →
      "Hide element" starts the picker on the page, and the shortcut (Alt+Shift+H, or the one set in
      `chrome://extensions/shortcuts`) does the same. (E2E J8 dispatches both events from the worker;
      Chrome's own menu and accelerators cannot be driven from Playwright.)
- [ ] **manual** Update from the previous release: settings kept; pages loaded straight after the update
      are filtered again within seconds (limits page).

## Manual pop-up pass (owner, test accounts)

Needs throwaway test accounts (Q-25, S-21); so far only the fixture halves (J17–J19) have been run.
Run with the guard on in **Smart**, then in **Strict**, and once with it off; record per flow: window
opened, blocked, notice shown, flow completed.

- [ ] **manual** sign-in through three providers' sign-in windows (popup-style OAuth); the window opens
      and the sign-in completes (`postMessage` back to the opener works).
- [ ] **manual** payment: two payment windows (one wallet-style window, one card 3-D Secure step).
- [ ] **manual** single sign-on: one SSO flow that opens a window or a new tab.
- [ ] **manual** Strict blocks a window opened right after a click on a real button, and **Allow pop-ups
      on this site** then lets it through.
- [ ] **manual** Blocked page in a **private window** (extension allowed in incognito): a page-opened tab
      to a listed host is closed; a link you really clicked shows Close tab / Proceed once (UNVERIFIED in
      S-19).
- [ ] **manual** A listed host typed into a **new tab** (Ctrl+T) or opened from a bookmark shows the page
      with **Close tab** and **Proceed once**, and is not closed by itself (infra follow-up: Chromium may
      report the active tab as opener).
- [ ] **manual** With site access "On click": a listed host shows Chrome's error page, not the blocked
      page, and no ad page loads.
- [ ] **manual** The notice ("Pop-up blocked · host") appears, does not take focus, and **Open it** opens
      the window from your click.

Decide afterwards (owner): turn the guard on by default (`POPUP_GUARD_DEFAULT`, Q-21) only if every
sign-in, payment and SSO flow completed in Smart.

## Store (owner)

- [ ] Developer account with 2-step verification; verified uploads on.
- [ ] Trader / non-trader declaration.
- [ ] Privacy-practices tab: single purpose, permission justifications, data usage, remote code "No".
- [ ] Incident playbook rehearsed once on the unlisted item (`docs/runbooks.md` §3).

## Going public (owner)

When the repository is published and branch protection is set up:

- [ ] `CODEOWNERS` with the owner's handle (D-59: left to the owner; the handle is not known yet and
      there is no repository or branch protection yet), covering at least `.github/workflows/`, `compiler/`,
      `vendor/`, `lists/*.json` (including `lists/lists.lock.json`), `src/core/manifest.ts` and `docs/permissions.md`; code-owner
      review required on `main`.
