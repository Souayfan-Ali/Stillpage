/**
 * The user-feature handlers of one worker wake (P2-20, P2-21, P2-55), built once in `createWorker` and
 * handed to the router: user filters, the picker start, "Proceed once".
 */
import type { Response } from '../core/messaging/parse.js';
import type { SenderInfo } from '../core/messaging/sender.js';
import type { Ports } from '../platform/ports.js';
import { startPickerMessage } from './picker.js';
import { createProceedOnce, type ProceedOnce } from './proceedOnce.js';
import { createUserFilterService, type UserFilterService } from './userFilters.js';

export interface Features {
  readonly userFilters: UserFilterService;
  readonly proceedOnce: ProceedOnce;
  readonly startPicker: (payload: { readonly tabId: number; readonly mode: 'zap' | 'hide' }, sender: SenderInfo) => Promise<Response<null>>;
}

export function createFeatures(ports: Ports, runtimeId: string, destinations: () => Promise<readonly string[]>, requestReconcile: () => void): Features {
  return {
    userFilters: createUserFilterService(ports, runtimeId, requestReconcile),
    proceedOnce: createProceedOnce(ports, runtimeId, destinations),
    startPicker: (payload, sender) => startPickerMessage(ports, runtimeId, payload, sender),
  };
}
