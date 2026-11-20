/**
 * The sentinel's `x/popupLog` answer as the toolbar panel reads it (P2-62): blocks on the page since it
 * loaded, their distinct codes (judge rule `G1`–`G13`, `TU` tab-under, `D` known destination) and up to
 * 20 destination hosts. A content script's answer is untrusted (a compromised renderer can forge it), so
 * it is validated in full; anything else reads as "no sentinel". Pure.
 */
import * as v from 'valibot';
import { parseHostname } from '../hostname/validate.js';

const MAX_HOSTS = 20;
const MAX_BLOCKED = 10_000;
const CODES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'TU', 'D'] as const;

const PopupLogSchema = v.strictObject({
  hosts: v.pipe(
    v.array(
      v.pipe(
        v.string(),
        v.check((h) => parseHostname(h) === h, 'invalid host'),
      ),
    ),
    v.maxLength(MAX_HOSTS),
  ),
  blocked: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_BLOCKED)),
  codes: v.pipe(v.array(v.picklist(CODES)), v.maxLength(CODES.length)),
});

export type PopupLog = v.InferOutput<typeof PopupLogSchema>;

/** The validated log, or `null` when the page has no sentinel or answered something else. */
export function readPopupLog(raw: unknown): PopupLog | null {
  const parsed = v.safeParse(PopupLogSchema, raw);
  return parsed.success ? parsed.output : null;
}
