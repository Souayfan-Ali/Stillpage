/**
 * Payload schemas for every v1 message (P1-12, architecture notes §7). Payloads are strict objects: an extra
 * key is a rejection, so a tab id can never ride in where the sender's tab is meant.
 */
import * as v from 'valibot';
import { REGISTRATION_ID } from '../catalog/registrations.js';
import { parseHostname } from '../hostname/validate.js';
import { parsePackId } from '../ids.js';
import { MAX_BACKUP_BYTES, MAX_ID_LENGTH } from '../limits.js';
import { sanitiseSelector } from '../sanitise/selector.js';
import { LEVELS } from '../state/types.js';
import { SETTINGS_PAGE_PAYLOAD_SCHEMAS } from './settingsPageSchemas.js';

/** Pause lengths offered by the UI (ADR-015): 30 minutes, 1 hour, or until turned back on (`null`). */
const PAUSE_MINUTES = [30, 60] as const;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

const hostname = v.pipe(v.string(), v.check((h) => parseHostname(h) === h, 'invalid hostname'));
const tabId = v.pipe(v.number(), v.integer(), v.minValue(0));
const selector = v.pipe(v.string(), v.check((s) => sanitiseSelector(s) === s, 'invalid selector'));
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export const PAYLOAD_SCHEMAS = {
  'q/tabState': v.strictObject({ tabId }),
  'q/matchedRules': v.strictObject({ tabId }),
  'c/setSiteLevel': v.strictObject({ hostname, level: v.picklist([...LEVELS, 'inherit']) }),
  'c/pauseSite': v.strictObject({ hostname, minutes: v.nullable(v.picklist(PAUSE_MINUTES)) }),
  'c/setDefaultLevel': v.strictObject({ level: v.picklist(['light', 'standard', 'thorough']) }),
  'c/setPack': v.strictObject({
    pack: v.pipe(v.string(), v.check((p) => parsePackId(p) === p, 'invalid pack id')),
    enabled: v.boolean(),
  }),
  'c/setGpc': v.strictObject({ enabled: v.boolean() }),
  'c/startPicker': v.strictObject({ tabId, mode: v.picklist(['zap', 'hide']) }),
  'c/saveUserFilter': v.strictObject({ hostname, selector, nonce: v.pipe(v.string(), v.regex(NONCE)) }),
  'c/removeUserFilter': v.strictObject({ hostname, selector }),
  'c/importBackup': v.strictObject({
    json: v.pipe(
      v.string(),
      v.maxLength(MAX_BACKUP_BYTES),
      v.check((s) => utf8Bytes(s) <= MAX_BACKUP_BYTES, 'backup too large'),
    ),
    /** The preview's digest: the import applies only the plan the user saw (P2-37, security review M2). */
    expect: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  }),
  'c/setPopupMode': v.strictObject({ mode: v.picklist(['off', 'smart', 'strict']) }),
  /** "Tell me when a pop-up is blocked" (P2-60b; the in-page notice reads it, P2-59). */
  'c/setPopupNotice': v.strictObject({ enabled: v.boolean() }),
  'c/setSitePopupPolicy': v.strictObject({ hostname, policy: v.picklist(['allow', 'strict', 'inherit']) }),
  'c/proceedOnce': v.strictObject({ hostname }),
  'c/reconcile': v.strictObject({}),
  /** D-32: the user dismissed the settings-reset notice (toolbar panel and dashboard only). */
  'c/dismissNotice': v.strictObject({}),
  'cs/cssFallback': v.strictObject({
    registration: v.pipe(v.string(), v.maxLength(MAX_ID_LENGTH * 2), v.regex(REGISTRATION_ID)),
  }),
  ...SETTINGS_PAGE_PAYLOAD_SCHEMAS,
} as const;

export type MessageType = keyof typeof PAYLOAD_SCHEMAS;
export type PayloadOf<T extends MessageType> = v.InferOutput<(typeof PAYLOAD_SCHEMAS)[T]>;

/** Who may send each type: extension pages, `blocked.html` only, or our content scripts. */
export type SenderPolicy = 'extension-page' | 'blocked-page' | 'content-script';

export function senderPolicyOf(type: MessageType): SenderPolicy {
  if (type === 'c/proceedOnce') return 'blocked-page';
  return type.startsWith('cs/') ? 'content-script' : 'extension-page';
}
