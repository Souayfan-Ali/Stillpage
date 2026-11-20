/**
 * In-memory `scripting` registrations with Chrome's all-or-nothing calls: one invalid match pattern,
 * duplicate id or unknown id fails the whole call and changes nothing (S-04).
 */
import type { ScriptRegistration } from '../../../../src/core/reconcile/types.js';
import type { CssInjection, ScriptingPort } from '../../../../src/platform/ports.js';
import { copy } from './ruleChecks.js';

/** Match-pattern grammar Chrome accepts for content scripts (the subset we could ever emit). */
const MATCH_PATTERN =
  /^(?:<all_urls>|(?:\*|https?|wss?|ftp):\/\/(?:\*|(?:\*\.)?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)(?::(?:\*|\d{1,5}))?\/.*)$/;

function checkScript(script: ScriptRegistration): void {
  if (script.id.startsWith('_')) throw new Error(`Script with ID '${script.id}' must not start with '_'.`);
  if (script.matches.length === 0) throw new Error(`Script with ID '${script.id}' must specify 'matches'.`);
  const bad = [...script.matches, ...script.excludeMatches].find((p) => !MATCH_PATTERN.test(p));
  if (bad !== undefined) throw new Error(`Script with ID '${script.id}' has invalid match pattern: Invalid url pattern '${bad}'.`);
}

export interface FakeScripting {
  readonly port: ScriptingPort;
  /** Every `insertCSS` call so far. */
  readonly inserted: () => readonly CssInjection[];
  /** Update semantics: every registration is cleared (S-17). */
  readonly clear: () => void;
  /** Browser restart: registrations made with `persistAcrossSessions: false` are gone (P2-65). */
  readonly endSession: () => void;
}

export function createFakeScripting(): FakeScripting {
  let scripts: readonly ScriptRegistration[] = [];
  let inserted: readonly CssInjection[] = [];
  const has = (id: string): boolean => scripts.some((s) => s.id === id);
  const sorted = (list: readonly ScriptRegistration[]): ScriptRegistration[] =>
    [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const port: ScriptingPort = {
    getRegisteredContentScripts: () => Promise.resolve(copy(sorted(scripts))),
    registerContentScripts: async (list) => {
      list.forEach(checkScript);
      const ids = list.map((s) => s.id);
      const duplicate = ids.find((id, i) => has(id) || ids.indexOf(id) !== i);
      if (duplicate !== undefined) throw new Error(`Duplicate script ID '${duplicate}'`);
      scripts = [...scripts, ...copy(list)];
      await Promise.resolve();
    },
    updateContentScripts: async (list) => {
      list.forEach(checkScript);
      const missing = list.find((s) => !has(s.id));
      if (missing !== undefined) throw new Error(`Nonexistent script ID '${missing.id}'`);
      scripts = scripts.map((s) => copy(list.find((u) => u.id === s.id) ?? s));
      await Promise.resolve();
    },
    unregisterContentScripts: async (ids) => {
      const missing = ids.find((id) => !has(id));
      if (missing !== undefined) throw new Error(`Nonexistent script ID '${missing}'`);
      scripts = scripts.filter((s) => !ids.includes(s.id));
      await Promise.resolve();
    },
    insertCSS: async (d) => {
      inserted = [...inserted, copy(d)];
      await Promise.resolve();
    },
  };
  return {
    port,
    clear: () => { scripts = []; },
    endSession: () => { scripts = scripts.filter((s) => s.persistAcrossSessions); },
    inserted: () => [...inserted],
  };
}
