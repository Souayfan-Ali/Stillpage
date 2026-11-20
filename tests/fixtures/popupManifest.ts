/**
 * The pop-up rows of `fixtures.json` (P2-61, testing notes §3, pop-up notes §14–15): families `popups/` (must block),
 * `popups-allow/` (must pass), `popup-destinations/` (L2, known destinations) and `notify/`. A row
 * names the trusted user action (`act`), the address the page tries to open (`target`) and the verdict
 * expected in each mode:
 * - `guardOff`: the build as it is, guard off — for `popups/` and `popups-allow/` the window must
 *   really open (the fixture bites), for `popup-destinations/` the `popups` ruleset decides;
 * - `smart`, `strict`: with the guard on (`miss` = the guard lets it through and the gate allows it);
 * - `packOn`, `packOff`: `notify/` rows, the Notification prompts pack on or off.
 * `pending` names the task whose feature the row's guarded part needs. For `popups/` and `popups-allow/`
 * the `guardOff` baseline still runs; a pending `popup-destinations/` or `notify/` row is skipped whole.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as v from 'valibot';
import { FIXTURES_DIR } from './manifest.js';

export const POPUP_FAMILIES = ['popups', 'popups-allow', 'popup-destinations', 'notify'] as const;

/** The guard-alone set of pop-up notes §14: P1–P8, P11, P12 and the double open (14 pages). */
export const GUARD_ALONE = ['P1', 'P2', 'P2b', 'P3', 'P4a', 'P4b', 'P5', 'P6', 'P7', 'P8a', 'P8b', 'P11', 'P12', 'DOUBLE'] as const;

const https = v.pipe(v.string(), v.url(), v.startsWith('https://'));
const selector = v.pipe(v.string(), v.regex(/^[#.][a-z][a-z0-9-]*$/));
const hostname = v.pipe(v.string(), v.regex(/^[a-z0-9.-]+\.[a-z]+$/));

const Act = v.union([
  v.strictObject({ click: selector, modifiers: v.optional(v.tuple([v.literal('ControlOrMeta')])), button: v.optional(v.literal('middle')) }),
  v.strictObject({ clickAt: v.tuple([v.number(), v.number()]) }),
  v.strictObject({ focus: selector, press: v.picklist(['Enter', 'Space']) }),
  v.strictObject({ frame: v.literal('iframe'), click: selector }),
  v.strictObject({ navigate: https }),
  v.strictObject({ none: v.literal(true) }),
]);

const Verdict = v.picklist(['opened', 'blocked']);
const GuardVerdict = v.picklist(['opened', 'blocked', 'miss']);
const Prompt = v.picklist(['prompted', 'suppressed']);
const Expect = v.strictObject({
  guardOff: v.optional(Verdict),
  smart: v.optional(GuardVerdict),
  strict: v.optional(GuardVerdict),
  packOn: v.optional(Prompt),
  packOff: v.optional(Prompt),
});
const Also = v.strictObject({ global: v.pipe(v.string(), v.regex(/^__[a-zA-Z]+$/)), is: v.union([v.string(), v.boolean()]) });

const Row = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z-]+\/[a-z0-9-]+$/)),
  family: v.picklist(POPUP_FAMILIES),
  technique: v.pipe(v.string(), v.regex(/^(?:[PADSN]\d+[a-z]?|DOUBLE|H\d)$/)),
  page: https,
  file: v.pipe(v.string(), v.regex(/^[a-z-]+\/[a-z0-9-]+\.html$/)),
  uses: v.optional(v.array(v.string())),
  act: Act,
  /** The address the page tries to open; `blob:` for a blob URL the page makes itself. */
  target: v.optional(v.union([https, v.literal('blob:')])),
  filters: v.optional(v.array(v.string())),
  guardAlone: v.optional(v.literal(true)),
  expect: Expect,
  also: v.optional(v.array(Also)),
  /** Hostname the in-page notice names (P2-59). */
  notice: v.optional(hostname),
  /** What the blocked page does (P2-55, pop-up notes §6.2). */
  blockedPage: v.optional(v.picklist(['closed', 'close-tab', 'go-back', 'proceed-once'])),
  setup: v.optional(v.strictObject({ access: v.optional(v.literal('none')), sitePolicy: v.optional(v.literal('allow')) })),
  note: v.optional(v.string()),
  pending: v.optional(v.pipe(v.string(), v.regex(/^P2-\d\d: .{20,}/))),
});

/** Each family carries the verdicts its spec reads. */
const complete = (r: v.InferOutput<typeof Row>): boolean => {
  const e = r.expect;
  if (r.family === 'notify') return e.packOn !== undefined && e.packOff !== undefined && r.target === undefined;
  if (r.target === undefined || e.guardOff === undefined) return false;
  return r.family === 'popup-destinations' || (e.smart !== undefined && e.strict !== undefined);
};
const CheckedRow = v.pipe(Row, v.check(complete, 'a row lacks the target or the verdicts its family needs'));
const Manifest = v.object({ popups: v.array(CheckedRow) });

export type PopupRow = v.InferOutput<typeof Row>;
export type PopupAct = v.InferOutput<typeof Act>;
export type PopupVerdict = v.InferOutput<typeof Verdict>;

export function loadPopupFixtures(file = path.join(FIXTURES_DIR, 'fixtures.json')): readonly PopupRow[] {
  return v.parse(Manifest, JSON.parse(readFileSync(file, 'utf8'))).popups;
}

/** A `popup-destinations/` or `notify/` row that cannot run at all yet. */
export const skippedWhole = (r: PopupRow): boolean => r.pending !== undefined && (r.family === 'popup-destinations' || r.family === 'notify');
