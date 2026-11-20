import { describe, expect, test } from 'vitest';
import { createScheduler, type SchedulerClock } from '../../../src/content/cosmetic-procedural/scheduler.js';

/** Fake clock: frames and timeouts run only when the test flushes them. */
function fakeClock() {
  let now = 0;
  let frames: (() => void)[] = [];
  let timers: { at: number; cb: () => void }[] = [];
  const clock: SchedulerClock = {
    now: () => now,
    frame: (cb) => { frames.push(cb); },
    timeout: (cb, ms) => { timers.push({ at: now + ms, cb }); },
  };
  return {
    clock,
    advance(ms: number) { now += ms; const due = timers.filter((t) => t.at <= now); timers = timers.filter((t) => t.at > now); due.forEach((t) => { t.cb(); }); },
    flushFrames() { const f = frames; frames = []; f.forEach((cb) => { cb(); }); },
    pending: () => ({ frames: frames.length, timers: timers.length }),
  };
}

describe('procedural observer budget (cosmetic notes §4)', () => {
  test('mutations are batched into one run in the next animation frame', () => {
    const c = fakeClock();
    let runs = 0;
    const s = createScheduler(() => { runs += 1; }, c.clock);
    s.notify(); s.notify(); s.notify();
    expect(c.pending().frames).toBe(1);
    c.flushFrames();
    expect(runs).toBe(1);
  });

  test('more than 50 ms of work in a 1 s window doubles the interval, capped at 1 s, and counts each backoff', () => {
    const c = fakeClock();
    const s = createScheduler(() => { c.advance(30); }, c.clock);
    const cycle = () => { s.notify(); c.advance(s.stats().intervalMs); c.flushFrames(); };
    cycle(); expect(s.stats().intervalMs).toBe(0);
    cycle(); expect(s.stats()).toMatchObject({ intervalMs: 16, backoffs: 1 });
    for (let i = 0; i < 30 && s.stats().intervalMs < 1000; i += 1) cycle();
    expect(s.stats().intervalMs).toBe(1000);
  });

  test('a quiet period steps the interval back down, one halving per 5 s, to no delay at all', () => {
    const c = fakeClock();
    let cost = 60;
    const s = createScheduler(() => { c.advance(cost); }, c.clock);
    const cycle = () => { s.notify(); c.advance(s.stats().intervalMs); c.flushFrames(); };
    cycle(); cycle(); cycle();
    expect(s.stats()).toMatchObject({ intervalMs: 64, backoffs: 3 });
    cost = 1;
    cycle();
    expect(s.stats().intervalMs).toBe(64);
    c.advance(5_000); cycle();
    expect(s.stats().intervalMs).toBe(32);
    cycle();
    expect(s.stats().intervalMs).toBe(32);
    c.advance(5_000); cycle();
    expect(s.stats().intervalMs).toBe(16);
    c.advance(60_000); cycle();
    expect(s.stats()).toMatchObject({ intervalMs: 0, backoffs: 3 });
    s.notify();
    expect(c.pending()).toEqual({ frames: 1, timers: 0 });
  });

  test('work that stays over the limit keeps the interval at the cap', () => {
    const c = fakeClock();
    const s = createScheduler(() => { c.advance(60); }, c.clock);
    for (let i = 0; i < 40; i += 1) { s.notify(); c.advance(s.stats().intervalMs); c.flushFrames(); }
    expect(s.stats().intervalMs).toBe(1000);
  });

  test('after a backoff the run waits for the interval before its frame', () => {
    const c = fakeClock();
    const s = createScheduler(() => { c.advance(60); }, c.clock);
    s.notify(); c.flushFrames();
    expect(s.stats().intervalMs).toBe(16);
    s.notify();
    expect(c.pending()).toEqual({ frames: 0, timers: 1 });
    c.advance(16);
    expect(c.pending().frames).toBe(1);
  });

  test('hidden: nothing runs; on visible exactly one rescan', () => {
    const c = fakeClock();
    let runs = 0;
    const s = createScheduler(() => { runs += 1; }, c.clock);
    s.setHidden(true);
    s.notify(); s.notify();
    c.flushFrames();
    expect(runs).toBe(0);
    s.setHidden(false);
    c.flushFrames();
    expect(runs).toBe(1);
  });

  test('a throwing pass never stops later passes', () => {
    const c = fakeClock();
    let runs = 0;
    const s = createScheduler(() => { runs += 1; throw new Error('engine'); }, c.clock);
    s.notify(); c.flushFrames(); s.notify(); c.flushFrames();
    expect(runs).toBe(2);
  });
});
