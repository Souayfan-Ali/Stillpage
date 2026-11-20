import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { installNotifyGate, type GateScope } from '../content/notify-gate/gate.js';

// A WXT unlisted script (P2-63): registered by the worker in the MAIN world, `document_start`, while the
// Notification prompts pack is on. Everything runs inside the callback (WXT imports this module in Node).
export default defineUnlistedScript(() => {
  installNotifyGate(globalThis as unknown as GateScope);
});
