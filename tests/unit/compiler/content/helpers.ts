import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Fact, FactKind } from '../../../../compiler/content/facts.js';
import type { Hostname } from '../../../../src/core/ids.js';
import type { Entry } from '../../../../compiler/parse/parse-list.js';
import { classify } from '../../../../compiler/parse/classify.js';

export const VENDOR_PRESENT = existsSync(path.resolve(import.meta.dirname, '../../../../vendor/resources/src/js/static-filtering-parser.js'));

export const fact = (host: string, kind: FactKind, value: string, list = 'l'): Fact =>
  ({ host: host as Hostname, kind, value, source: { list, line: 1, text: `${host}:${kind}:${value}` } });

export function entry(text: string, list = 'l', trusted = true): Entry {
  return { ...classify(text), source: { list, line: 1, text }, trusted };
}
