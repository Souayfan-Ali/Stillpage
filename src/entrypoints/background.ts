import { defineBackground } from 'wxt/utils/define-background';
import { createWorker } from '../background/worker.js';
import { createChromePorts, runtimeId } from '../platform/chromePorts.js';
import { addWorkerListeners } from '../platform/events.js';

// Listeners only (architecture notes §2): wire the ports, add the listeners synchronously, resume an
// interrupted reconcile. Every decision lives in `background/` and `core/`.
export default defineBackground(() => {
  const worker = createWorker(createChromePorts(), runtimeId());
  addWorkerListeners(worker.handlers);
  void worker.resume();
});
