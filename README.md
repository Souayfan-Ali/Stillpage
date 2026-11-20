# Glassmere

A Chrome extension (Manifest V3) that blocks ads, trackers and sites known for malware, quietly. It is
fully declarative: Chrome applies the packaged rules and injects the registered content scripts; the
extension's service worker only configures them. No paid exceptions for advertisers, no telemetry, no
data collection, and the extension makes no network requests.

## Install

Version 1.0.0 is in the Chrome Web Store:
<https://chromewebstore.google.com/detail/glassmere/hcagblaklhbhbpdfaljlcmimpmpipgec>

## Build from source

Needs Node 22 (see `.nvmrc`), npm, git and Playwright's Chromium (the list build uses it).

```sh
npm ci
npx playwright install chromium
npm run lists:fetch -- --drop-pending
npm run vendor:fetch
npm run lists:build -- --drop-pending
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select
`.output/chrome-mv3`.

## Documents

- [Privacy policy](docs/privacy-policy.md) and [trust pledge](docs/pledge.md) (draft)
- [Permissions](docs/permissions.md)
- [Limits](docs/limits.md): what the extension cannot do
- [Verify a build](docs/verify-a-build.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Credits](CREDITS.md)

Website: <https://glassmere-eight.vercel.app/> (source in the separate repository Glassmere-Front).

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE) and, for the bundled filter lists, [CREDITS.md](CREDITS.md).
