/**
 * The scriptlet dispatcher (P1-29, hardened by P1-37 with the design review's conditions, security notes T1): fixed text
 * placed after the bundled uBO functions in each code file. It chooses which bundled scriptlet runs with
 * which list arguments, so in the MAIN world it treats the page as hostile:
 * - natives it needs are captured once at the top of the file, before any scriptlet exists; it calls no
 *   page-replaceable prototype method (no spread, no iterator, no `push`/`filter`/`sort` lookups);
 * - MAIN data arrives in a null-prototype holder at fixed slots (`s` shard, `c` common, `x` tampered),
 *   created by our data file's wrapper (`shardFileWrap`); a holder that is an accessor, not
 *   configurable, not null-prototype, marked tampered, or not ours to read runs nothing (fail closed);
 *   it is deleted before any scriptlet runs;
 * - every value is read through own data descriptors (a getter is never called) and validated where it
 *   is used — lazily, so the cost stays inside the 0.3 ms wrapper budget on a 48 kB shard: version and
 *   pack up front, then the host probes of the binary search (strings), the matched entries (integer
 *   indices in range) and each invocation that runs (function index in range, string arguments with a
 *   length cap, copied into a fresh array); a malformed part is skipped; a scriptlet receives only its
 *   string arguments, never the table;
 * - no error, log or global is left behind on rejection.
 * `$` placeholders in the head are replaced with JSON literals only.
 */

/** Captured before anything else in the file runs. */
export const DISPATCHER_HEAD = `const $O = Object, $A = Array, $R = Reflect;
const $gopd = $O.getOwnPropertyDescriptor, $gpo = $O.getPrototypeOf, $isExt = $O.isExtensible, $isArray = $A.isArray, $apply = $R.apply, $del = $R.deleteProperty;
const $isInt = Number.isInteger, $URL = URL, $String = String, $S = String.prototype, $indexOf = $S.indexOf, $slice = $S.slice, $lower = $S.toLowerCase;
const $loc = { hostname: location.hostname, origin: location.origin, parent: location.ancestorOrigins && location.ancestorOrigins.length > 0 ? location.ancestorOrigins[0] : '' };`;

/** Reading, validation and dispatch; `KEY`, `VERSION`, `PACK`, `MAX_ARG` and `fns` come before it. */
const COMMON_PART = `const own = (o, k) => {
  if (o === null || typeof o !== 'object') return undefined;
  const d = $gopd(o, k);
  return d !== undefined && 'value' in d ? d.value : undefined;
};
const size = (a) => {
  if (!$isArray(a)) return -1;
  const n = own(a, 'length');
  return $isInt(n) ? n : -1;
};
const ints = (a, max) => {
  if (a === undefined) return [];
  const n = size(a), out = [];
  if (n < 0) return null;
  for (let i = 0; i < n; i += 1) {
    const x = own(a, i);
    if (!$isInt(x) || x >= max || ~x >= max) return null;
    out[i] = x;
  }
  return out;
};
const invocation = (raw) => {
  const n = size(raw), fn = own(raw, 0), args = [];
  if (n < 1 || !$isInt(fn) || fn < 0 || fn >= fns.length) return null;
  for (let i = 1; i < n; i += 1) {
    const a = own(raw, i);
    if (typeof a !== 'string' || a.length > MAX_ARG) return null;
    args[i - 1] = a;
  }
  return { fn, args };
};
const tables = (d, common) => {
  const hosts = own(d, 'hosts'), entries = own(d, 'entries'), table = own(d, 'invocations');
  if (own(d, 'v') !== VERSION || own(d, 'pack') !== PACK || own(d, 'common') === true) return null;
  if (size(hosts) < 0 || size(entries) !== size(hosts) || size(table) < 0) return null;
  return { hosts, entries, table, common };
};
const commonOf = (d) => (own(d, 'v') === VERSION && own(d, 'pack') === PACK && own(d, 'common') === true && size(own(d, 'invocations')) >= 0 ? own(d, 'invocations') : null);`;

/** MAIN: the null-prototype holder our data files fill (page-reachable world). */
const FROM_HOLDER = `const items = (() => {
  const slot = $gopd(self, KEY);
  if (slot === undefined) return null;
  $del(self, KEY);
  if (!('value' in slot) || !slot.configurable) return null;
  const h = slot.value;
  if (h === null || typeof h !== 'object' || $gpo(h) !== null || !$isExt(h) || own(h, 'x') !== undefined) return null;
  const c = own(h, 'c'), s = own(h, 's');
  const common = c === undefined ? [] : commonOf(c);
  if (common === null || s === undefined) return null;
  const t = tables(s, common);
  return t === null ? null : [t];
})();`;

/** ISOLATED: the queue array (not page-reachable); cosmetic-specific takes it later. */
const FROM_QUEUE = `const items = (() => {
  const q = own(self, KEY), n = size(q), out = [];
  if (n < 0) return null;
  let common = [];
  for (let i = 0; i < n; i += 1) { const c = commonOf(own(q, i)); if (c !== null) common = c; }
  for (let i = 0; i < n; i += 1) { const t = tables(own(q, i), common); if (t !== null) out[out.length] = t; }
  return out;
})();`;

const DISPATCH_PART = `const hostOf = (u) => { try { return u === '' || u === 'null' ? '' : new $URL(u).hostname; } catch { return ''; } };
const find = (hosts, h) => {
  let lo = 0, hi = size(hosts) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, at = own(hosts, mid);
    if (typeof at !== 'string') return -1;
    if (at === h) return mid;
    if (at < h) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
};
/**
 * Sorted insertion without a page-replaceable sort. Order is deterministic, not list order (tables are
 * sorted by value at build time): common entries (~i) by i, then shard entries by index.
 */
const rank = (x) => (x < 0 ? ~x : 1e9 + x);
const insert = (sorted, x) => {
  let i = sorted.length;
  while (i > 0 && rank(sorted[i - 1]) > rank(x)) { sorted[i] = sorted[i - 1]; i -= 1; }
  sorted[i] = x;
};
const dispatch = (t, host) => {
  const run = [], off = { __proto__: null }, seen = { __proto__: null };
  const max = size(t.table) > size(t.common) ? size(t.table) : size(t.common);
  for (let h = host; h !== ''; ) {
    const i = find(t.hosts, h);
    const e = i === -1 ? undefined : own(t.entries, i);
    const j = e === undefined ? null : ints(own(e, 'j'), max), n = e === undefined ? null : ints(own(e, 'n'), max);
    if (j !== null && n !== null) {
      for (let k = 0; k < j.length; k += 1) if (seen[j[k]] !== true) { seen[j[k]] = true; insert(run, j[k]); }
      for (let k = 0; k < n.length; k += 1) off[n[k]] = true;
    }
    const dot = $apply($indexOf, h, ['.']);
    h = dot === -1 ? '' : $apply($slice, h, [dot + 1]);
  }
  for (let k = 0; k < run.length; k += 1) {
    const x = run[k];
    if (off[x] === true) continue;
    const inv = invocation(x >= 0 ? own(t.table, x) : own(t.common, ~x));
    if (inv === null) continue;
    try { $apply(fns[inv.fn], undefined, inv.args); } catch { /* a broken scriptlet never breaks the page */ }
  }
};
const host = $apply($lower, $String($loc.hostname || hostOf($loc.origin) || hostOf($loc.parent)), []);
if (items !== null && host !== '') for (let i = 0; i < items.length; i += 1) dispatch(items[i], host);`;

/** The dispatcher text of one world, as one block (its own names are local to it). */
export function dispatcherSource(world: 'MAIN' | 'ISOLATED'): string {
  return `{\n${COMMON_PART}\n${world === 'MAIN' ? FROM_HOLDER : FROM_QUEUE}\n${DISPATCH_PART}\n}`;
}
