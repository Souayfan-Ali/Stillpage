import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { runCosmeticSpecific } from '../content/cosmetic-specific/apply.js';
import { sendCssFallback } from '../platform/contentMessages.js';

// A WXT unlisted script (S-01, D-14): registered by the worker, ISOLATED world, `document_start`,
// listed last in every shard registration. No ContentScriptContext, so nothing is posted to the page.
export default defineUnlistedScript(() => {
  runCosmeticSpecific({ scope: self, document, location, newSheet: () => new CSSStyleSheet(), fallback: sendCssFallback });
});
