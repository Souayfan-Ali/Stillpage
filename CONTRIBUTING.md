# Contributing

Thank you for helping. Glassmere is licensed GPL-3.0-or-later; by contributing you agree that your
contribution is released under the same licence.

Glassmere is a Chrome MV3 content blocker. It is fully declarative: Chrome enforces the DNR rules and injects
the registered content scripts; the service worker only configures them. A build-time compiler turns filter
lists into rulesets, cosmetic data and scriptlet bundles. The product name lives only in `src/core/brand.ts`.

## Before you start

- Node 22 (see `.nvmrc`). Install with `npm ci --ignore-scripts`.
- Pinned CLI tools and the secret-scanning pre-commit hook: `npm run tools:install && npm run hooks:install`.
- Playwright's bundled Chromium: `npm run test:e2e:install`.
- Read the rules below and the maintainer documents in `docs/` (start with `docs/README.md`).
- Internal ids such as ADR-0NN, S-NN, D-NN and P2-NN in code comments refer to unpublished maintainer design
  notes.

## Rules for this repository

- TypeScript strict, ESM. Immutable updates only (return new objects; never mutate inputs or shared state).
- Files at most 400 lines, functions at most 50 lines, nesting at most 4. No `console.*` (use the logger).
- Test first. A change without a test that encodes its behaviour is not ready.
- Validate at every boundary: Valibot in extension pages and the worker, hand-written guards in content
  scripts, Zod in `compiler/`.
- `src/core/` is pure: no `chrome.*`, no imports from `src/platform/` or `src/features/`.
- `src/content/` scripts import no npm packages and do no work at module top level.

## Never

- Never add a listener for `webRequest`, `webNavigation` or `tabs`, a long-lived port, or any keep-alive.
  Nothing on the page-load path may need the service worker. Blocking a pop-up must not wake it either.
- Never put a decision, a constant or data in `popup-shim` (MAIN world): it only asks the sentinel. Never
  let the in-page notice or any content script change a persistent pop-up policy.
- Never add a pop-up guard rule without a fixture in `tests/fixtures/popups*` and shadow-run evidence.
- Never add a network request (`fetch`, XHR, WebSocket, beacon) to shipped code. v1 makes zero requests.
- Never use `eval`, `new Function`, string timers, `innerHTML`/`outerHTML`/`insertAdjacentHTML`.
- Never build code from data: scriptlet arguments are JSON data passed as arguments.
- Never accept a command from a content script. Commands come only from extension pages; check `sender`.
- Never derive a DNR rule, a registration or a setting from `chrome.storage.local`. It is readable and
  writable from content-script contexts. Authoritative state lives in the vault.
- Never apply a stock selector with anything but `display:none!important`; `:style()` declarations go
  through `src/core/sanitise`.
- Never put an unsafe rule (`redirect`, `modifyHeaders`) in a non-`-x` ruleset, change a rule id by hand,
  or add/remove a ruleset slot outside a full release.
- Never change any file outside `rule_resources` in a ruleset-only release ("repack, don't rebuild").
- Never add a permission without an architecture decision record and an entry in `docs/permissions.md`.
- Never edit the ledger (`lists/ledger/`) or `lists/lists.lock.json` by hand; the compiler writes them.
- Never run tests against the live web outside the nightly job.

## Map

- `src/core` state, reconcile, levels, messaging schemas, sanitiser · `src/platform` Chrome adapters
- `src/background` worker entry (listeners only) · `src/content/*` one folder per registered script
- `src/core/popup` pop-up decision table · `src/content/popup-sentinel`, `src/content/popup-shim` the guard ·
  `src/features/blocked-page` target of pop-up redirects
- `src/features/*` popup, picker-panel, onboarding, dashboard · `src/ui` shared UI
- `compiler/*` fetch → parse → normalise → convert → postpass → emit → verify; `compiler/eligibility`
- `lists/` sources, budgets, entities, overrides · `vendor/` pinned uBO resources
- `tests/` unit, dnr, e2e, fixtures, golden, perf · `bench/` performance harness
- `.github/workflows` ci, rulesets (daily, skip review), release, verify-store, issue-idmap

## Where the limits live

- Chrome limits and our budgets: `src/core/limits.ts`, `lists/lists.config.json`, `.size-limit.json`
- Permissions and their justifications: `docs/permissions.md` (checked against the manifest by the unit tests)

## Checks

```sh
npm run verify      # typecheck, lint, knip, unit tests with coverage (>= 80 %), build, size-limit
npm run test:dnr    # the compiled rulesets in a real Chromium
npm run test:e2e    # Playwright against the built extension
```

All checks must pass before review.

### Fresh clone

```sh
npm ci
npx playwright install chromium
npm run vendor:fetch
npm run lists:fetch -- --drop-pending
npm run lists:build -- --drop-pending
```

Then run the checks above. `typecheck`, `size` and the E2E tests need the generated data in `public/`, so run them
after the list build. Never: `lists/snapshots/` is written only by `npm run lists:fetch`; never add, edit or remove a file there by hand.

## Commits

Conventional commits: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
