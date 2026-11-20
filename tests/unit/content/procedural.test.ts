// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { programsFor, runProcedural, STATE_KEY, type ProceduralEnv } from '../../../src/content/cosmetic-procedural/glue.js';
import type { Hostname } from '../../../src/core/ids.js';
import type { ShardData } from '../../../src/core/content/shard-data.js';

const ENGINE = path.resolve(import.meta.dirname, '../../../vendor/resources/platform/mv3/extension/js/scripting/css-procedural-api.js');
const GLUE = path.resolve(import.meta.dirname, '../../../src/content/cosmetic-procedural/glue.ts');

const program = (o: object): string => JSON.stringify(o);
const shard = (procedural: readonly string[]): ShardData => ({
  v: 1, pack: 'ads', shard: 0, hosts: ['proc.example'] as Hostname[], entries: [{ p: procedural.map((_, i) => i) }],
  selectors: [], styles: [], procedural, invocations: [],
});

const css: string[] = [];
let frames: (() => void)[] = [];

function env(queue: unknown[], scope: Record<string, unknown> = self as unknown as Record<string, unknown>): ProceduralEnv {
  Reflect.set(scope, '__cs_q', queue);
  return {
    scope,
    document: document,
    location: { hostname: 'www.proc.example', origin: 'https://www.proc.example' },
    clock: { now: () => performance.now(), frame: (cb) => { frames.push(cb); }, timeout: (cb) => { frames.push(cb); } },
    newObserver: (cb) => new MutationObserver((r) => { cb(r); }),
    newSheet: () => ({ replaceSync: (text: string) => { css.push(text); } }),
  };
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  const f = frames; frames = []; f.forEach((cb) => { cb(); });
};

describe('programsFor', () => {
  test('host and parents, de-duplicated, malformed programs skipped; the queue is not taken', () => {
    const scope: Record<string, unknown> = { __cs_q: [shard([program({ selector: '.a', tasks: [['has-text', 'x']] }), '{bad', '[1]'])] };
    expect(programsFor(scope, { hostname: 'shop.proc.example', origin: '' })).toEqual([{ selector: '.a', tasks: [['has-text', 'x']] }]);
    expect(Array.isArray(scope['__cs_q'])).toBe(true);
    expect(programsFor(scope, { hostname: 'other.example', origin: '' })).toEqual([]);
  });
});

describe.skipIf(!existsSync(ENGINE))('uBO engine + glue (P1-36)', () => {
  const sendMessage = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    document.body.innerHTML = '';
    css.length = 0;
    frames = [];
    for (const k of ['ProceduralFiltererAPI', 'cssAPI', STATE_KEY, '__cs_q']) Reflect.deleteProperty(self, k);
    (document as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets = [];
    Reflect.set(self, 'chrome', { runtime: { sendMessage } });
    sendMessage.mockClear();
    (0, eval)(readFileSync(ENGINE, 'utf8'));
  });

  test('hides matches through a style token, follows DOM changes, and never messages the worker', async () => {
    document.body.innerHTML = '<div class="card">Sponsored</div><div class="card keep">News</div>';
    const p = program({ selector: '.card', tasks: [['has-text', 'Sponsored']] });
    expect(runProcedural(env([shard([p])]))).toBe(1);
    const token = (el: Element | null): readonly string[] => el?.getAttributeNames().filter((n) => n !== 'class') ?? [];
    expect(token(document.querySelector('.card:not(.keep)'))).toHaveLength(1);
    expect(token(document.querySelector('.keep'))).toEqual([]);
    expect(css.join('\n')).toMatch(/\{display:none!important;\}/);
    const late = document.createElement('div');
    late.className = 'card';
    late.textContent = 'Sponsored late';
    document.body.append(late);
    await flush();
    expect(token(late)).toHaveLength(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test(':remove() and :remove-class() actions; a second injection reuses the one engine instance', () => {
    document.body.innerHTML = '<div class="overlay"></div><div class="content blurred"></div>';
    const e = env([shard([program({ selector: '.overlay', action: ['remove', ''] })])]);
    runProcedural(e);
    const first: unknown = Reflect.get(self, STATE_KEY);
    runProcedural(env([shard([program({ selector: '.content', action: ['remove-class', 'blurred'] })])]));
    expect(Reflect.get(self, STATE_KEY)).toBe(first);
    expect(document.querySelector('.overlay')).toBeNull();
    expect(document.querySelector('.content')?.className).toBe('content');
  });

  test('the engine observer is replaced by the budgeted one', () => {
    runProcedural(env([shard([program({ selector: '.x', tasks: [['has-text', 'y']] })])]));
    const state = Reflect.get(self, STATE_KEY) as { api: { domObserver: unknown }; observer: unknown };
    expect(state.api.domObserver).toBe(state.observer);
  });

  test('nothing to do: no engine instance, no observer', () => {
    expect(runProcedural(env([]))).toBe(0);
    expect(Reflect.get(self, STATE_KEY)).toBeUndefined();
  });
});

test('the glue never calls reset(), chrome.* or the runtime', () => {
  const code = readFileSync(GLUE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(code).not.toMatch(/\.reset\(|\bchrome\b|sendMessage|runtime/);
});
