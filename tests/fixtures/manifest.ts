/**
 * `fixtures.json` (P1-42, testing notes §3): fixture → filters → expected observations, validated here so the
 * table tests (unit and E2E) read one checked shape. Observation kinds:
 * - `request`: `blocked` means the fixture server never saw that address (path and query), `loaded`
 *   that it did;
 * - `navigation`: a top-level navigation that must fail with `ERR_BLOCKED_BY_CLIENT`;
 * - `global`: a page global, `null` for absent; `attribute`: an attribute of `<html>`, `null` for absent.
 * `pending` marks a fixture whose feature does not exist yet; its spec is skipped with that reason.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as v from 'valibot';

export const FIXTURES_DIR = import.meta.dirname;
export const FAMILIES = [
  'net',
  'redirect',
  'levels',
  'permissions',
  'cosmetic-specific',
  'cosmetic-procedural',
  'cosmetic-generic',
  'scriptlets',
  'anti-adblock',
] as const;
const LEVEL_VALUES = ['off', 'light', 'standard', 'thorough'] as const;
const ACCESS = ['all', 'none', 'site'] as const;

const url = v.pipe(v.string(), v.url(), v.startsWith('https://'));
const Observation = v.union([
  v.strictObject({ request: url, is: v.picklist(['blocked', 'loaded']) }),
  v.strictObject({ navigation: url, is: v.literal('blocked') }),
  v.strictObject({
    global: v.pipe(v.string(), v.regex(/^__[a-zA-Z]+$/)),
    is: v.nullable(v.union([v.string(), v.number(), v.boolean()])),
  }),
  v.strictObject({
    attribute: v.pipe(v.string(), v.regex(/^data-[a-z-]+$/)),
    is: v.nullable(v.string()),
  }),
  v.strictObject({ element: v.string(), is: v.picklist(['hidden', 'shown']) }),
]);
const Setup = v.strictObject({
  registrations: v.optional(
    v.array(
      v.strictObject({
        hosts: v.array(v.string()),
        world: v.optional(v.picklist(['ISOLATED', 'MAIN'])),
      }),
    ),
  ),
  siteLevels: v.optional(v.record(v.string(), v.picklist(LEVEL_VALUES))),
  pauseSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  duringPause: v.optional(v.array(Observation)),
  access: v.optional(v.array(v.picklist(ACCESS))),
  /** An element the spec clicks once the page has loaded, before observing (e.g. a route change). */
  click: v.optional(v.pipe(v.string(), v.regex(/^#[a-z][a-z0-9-]*$/))),
});
const Fixture = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z-]+\/[a-z0-9-]+$/)),
  family: v.picklist(FAMILIES),
  page: url,
  file: v.pipe(v.string(), v.regex(/^[a-z-]+\/[a-z0-9-]+\.html$/)),
  filters: v.pipe(v.array(v.string()), v.minLength(1)),
  uses: v.optional(v.array(v.string())),
  setup: v.optional(Setup),
  expect: v.pipe(v.array(Observation), v.minLength(1)),
  note: v.optional(v.string()),
  pending: v.optional(v.string()),
});
const Manifest = v.object({ schema: v.literal(1), fixtures: v.array(Fixture) });

export type FixtureEntry = v.InferOutput<typeof Fixture>;
export type Observation = v.InferOutput<typeof Observation>;

export function loadFixtures(file = path.join(FIXTURES_DIR, 'fixtures.json')): readonly FixtureEntry[] {
  return v.parse(Manifest, JSON.parse(readFileSync(file, 'utf8'))).fixtures;
}
