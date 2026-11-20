import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { runUserCosmetic } from '../content/user-cosmetic/apply.js';
import { onStorageChanged, readLocal } from '../platform/contentStorage.js';

// A WXT unlisted script registered as `user-cosmetic` (P2-20): ISOLATED, `document_start`, all frames,
// on hosts with user filters. It reads the untrusted `uf:*` mirror and applies `display:none` only,
// and keeps it live while the page is open (D-80).
export default defineUnlistedScript(() => {
  // Quiet by design on a hostile page (CONTRIBUTING.md): a frame whose sheet cannot be adopted hides nothing.
  void runUserCosmetic({
    document, location, read: readLocal, newSheet: () => new CSSStyleSheet(),
    onChanged: onStorageChanged,
    setTimer: (run, ms) => { setTimeout(run, ms); },
  }).catch(() => undefined);
});
