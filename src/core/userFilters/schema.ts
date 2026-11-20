/**
 * Valibot schema of the user filters as they cross a boundary (P2-22): the worker's answers to the
 * extension pages and the `userFilters` field of a backup file. Strict: every host valid, every
 * selector exactly as the sanitiser leaves it, unique, within the store's caps. Not for content scripts
 * (they import no npm packages and use `readMirrorEntry`).
 */
import * as v from 'valibot';
import { parseHostname } from '../hostname/validate.js';
import { sanitiseSelector } from '../sanitise/selector.js';
import { MAX_HOSTS, MAX_SELECTORS_PER_HOST } from './store.js';

const hostname = v.pipe(
  v.string(),
  v.check((h) => parseHostname(h) === h, 'invalid hostname'),
);
const selector = v.pipe(
  v.string(),
  v.check((s) => sanitiseSelector(s) === s, 'invalid selector'),
);

export const UserFilterHostsSchema = v.pipe(
  v.record(
    hostname,
    v.pipe(
      v.array(selector),
      v.minLength(1),
      v.maxLength(MAX_SELECTORS_PER_HOST),
      v.check((list) => new Set(list).size === list.length, 'duplicate selector'),
      v.readonly(),
    ),
  ),
  v.check((hosts) => Object.keys(hosts).length <= MAX_HOSTS, 'too many hosts'),
  v.readonly(),
);
