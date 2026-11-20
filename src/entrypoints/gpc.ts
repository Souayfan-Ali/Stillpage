import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { defineGpc } from '../content/gpc/property.js';

// A WXT unlisted script (P2-31): registered by the worker in the MAIN world while GPC is on.
export default defineUnlistedScript(() => {
  defineGpc((globalThis as { Navigator?: { prototype: object } }).Navigator?.prototype);
});
