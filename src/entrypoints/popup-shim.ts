import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { installShim } from '../content/popup-shim/shim.js';

// `popup-shim` (P2-58): registered by the worker beside `popup-sentinel`, MAIN world, top-level documents,
// `document_start`. Decides nothing; asks the sentinel over the handshake channel.
export default defineUnlistedScript(() => {
  installShim(window);
});
