import { describe, expect, test } from 'vitest';
import { headerOf, type HeaderKind } from '../../../../src/features/popup/header.js';
import { HEADER_TEXT, NOW, TAB_STATES } from '../../../fixtures/panel/tabStates.js';

const KINDS = Object.keys(TAB_STATES) as HeaderKind[];

describe('headerOf (UI notes §3)', () => {
  test.each(KINDS)('the %s fixture gives the %s state with the planned text', (kind) => {
    const header = headerOf(TAB_STATES[kind], NOW);
    expect(header.kind).toBe(kind);
    expect(header.text).toBe(HEADER_TEXT[kind]);
  });

  test('only the protected state is drawn without a banner', () => {
    const plain = KINDS.filter((kind) => headerOf(TAB_STATES[kind], NOW).tone === 'ok');
    expect(plain).toEqual(['normal']);
  });

  test('every state has an icon, and the icons of normal, off, paused and reduced differ', () => {
    const icons = ['normal', 'off', 'paused', 'reduced'].map((k) => headerOf(TAB_STATES[k as HeaderKind], NOW).icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  test('a page Chrome does not let us run on wins over every other state', () => {
    const header = headerOf({ ...TAB_STATES.reduced, page: 'restricted', ready: false, settingsReset: true }, NOW);
    expect(header.kind).toBe('restricted');
    expect(header.showsLevels).toBe(false);
  });

  test('setting up wins over a reset notice and over Off', () => {
    expect(headerOf({ ...TAB_STATES.off, ready: false, settingsReset: true }, NOW).kind).toBe('setup');
  });

  test('Off and paused hide the level selector and offer the way back on', () => {
    expect(headerOf(TAB_STATES.off, NOW)).toMatchObject({
      showsLevels: false,
      actions: ['turnOn'],
    });
    expect(headerOf(TAB_STATES.paused, NOW)).toMatchObject({
      showsLevels: false,
      actions: ['resume'],
    });
  });

  test('a pause shows whole minutes left, rounded up, never less than one', () => {
    expect(headerOf({ ...TAB_STATES.paused, pausedUntil: NOW + 60_000 }, NOW).text).toBe('Paused for 1 more minute');
    expect(headerOf({ ...TAB_STATES.paused, pausedUntil: NOW + 1 }, NOW).text).toBe('Paused for 1 more minute');
    expect(headerOf({ ...TAB_STATES.paused, pausedUntil: NOW - 5 }, NOW).text).toBe('Paused for 1 more minute');
    expect(headerOf({ ...TAB_STATES.paused, pausedUntil: NOW + 30 * 60_000 }, NOW).text).toBe('Paused for 30 more minutes');
  });

  test('reduced mode offers this site only when the address is known', () => {
    expect(headerOf(TAB_STATES.reduced, NOW).actions).toEqual(['allowSite', 'allowAll']);
    expect(headerOf({ ...TAB_STATES.reduced, host: null }, NOW).actions).toEqual(['allowAll']);
  });

  test('access limited to some sites still names the level and asks only for all sites', () => {
    const header = headerOf({ ...TAB_STATES.limited, level: 'thorough' }, NOW);
    expect(header.text).toMatch(/^Protected — Thorough\. /);
    expect(header.actions).toEqual(['allowAll']);
    expect(header.showsLevels).toBe(true);
  });

  test('the protected line names the effective level', () => {
    expect(headerOf({ ...TAB_STATES.normal, level: 'light' }, NOW).text).toBe('Protected — Light');
  });
});
