/** `scripting` registration adapter (P1-10). Reads are normalised onto `ScriptRegistration`. */
import type { ScriptRegistration } from '../core/reconcile/types.js';
import type { ScriptingApi } from './chromeApi.js';
import type { ScriptingPort } from './ports.js';

type Loose = Readonly<Record<string, unknown>>;

/** Fills Chrome's optional fields with their defaults so a read compares equal to what we wrote. */
export function toRegistration(raw: unknown): ScriptRegistration {
  const s = raw as Loose;
  return {
    id: s['id'],
    world: s['world'] ?? 'ISOLATED',
    js: s['js'] ?? [],
    matches: s['matches'] ?? [],
    excludeMatches: s['excludeMatches'] ?? [],
    runAt: s['runAt'] ?? 'document_idle',
    allFrames: s['allFrames'] ?? false,
    matchOriginAsFallback: s['matchOriginAsFallback'] ?? false,
    // A missing flag counts as non-persistent, so a leftover non-persistent registration is drift.
    persistAcrossSessions: s['persistAcrossSessions'] ?? false,
  } as ScriptRegistration;
}

const toChrome = (s: ScriptRegistration): ScriptRegistration => ({
  ...s,
  js: [...s.js],
  matches: [...s.matches],
  excludeMatches: [...s.excludeMatches],
});

export function createScriptingPort(api: ScriptingApi): ScriptingPort {
  return {
    getRegisteredContentScripts: async () => (await api.getRegisteredContentScripts()).map(toRegistration),
    registerContentScripts: (scripts) => api.registerContentScripts(scripts.map(toChrome)),
    updateContentScripts: (scripts) => api.updateContentScripts(scripts.map(toChrome)),
    unregisterContentScripts: (ids) => api.unregisterContentScripts({ ids: [...ids] }),
    insertCSS: (d) => api.insertCSS({ target: { tabId: d.target.tabId, frameIds: [...d.target.frameIds] }, css: d.css, origin: d.origin }),
  };
}
