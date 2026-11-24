import { ORIGIN_ID, StampClock, compareStamps } from './stamp';
import type { Stamp } from './stamp';

const T = new Date('2026-11-05T12:00:00.000Z');
const at = (ms: number): Date => new Date(T.getTime() + ms);
const stamp = (updatedAt: string, updatedAtCounter: number, originId = 'o'): Stamp => ({
  updatedAt,
  updatedAtCounter,
  originId,
});

describe('StampClock.tick', () => {
  it('stamps at millisecond precision with a zero counter when the time advanced', () => {
    const clock = new StampClock('origin-1');
    expect(clock.tick(T)).toEqual({
      updatedAt: '2026-11-05T12:00:00.000Z',
      updatedAtCounter: 0,
      originId: 'origin-1',
    });
    expect(clock.tick(at(1)).updatedAt).toBe('2026-11-05T12:00:00.001Z');
    expect(clock.tick(at(1)).updatedAt).toBe('2026-11-05T12:00:00.001Z');
  });

  it('ticks the counter when the millisecond did not advance, and resets it when it does', () => {
    const clock = new StampClock('o');
    expect(clock.tick(T).updatedAtCounter).toBe(0);
    expect(clock.tick(T).updatedAtCounter).toBe(1);
    expect(clock.tick(T).updatedAtCounter).toBe(2);
    expect(clock.tick(at(1)).updatedAtCounter).toBe(0);
  });

  it('never goes backwards when the wall clock does', () => {
    const clock = new StampClock('o');
    const first = clock.tick(at(5000));
    const second = clock.tick(T);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.updatedAtCounter).toBe(first.updatedAtCounter + 1);
    expect(compareStamps(second, first)).toBeGreaterThan(0);
  });

  it('mints strictly increasing stamps whatever the clock does', () => {
    const clock = new StampClock('o');
    const times = [0, 0, 3, 1, 1, 2, 9, 9, 9, 4, 10];
    let last: Stamp | undefined;
    for (const ms of times) {
      const next = clock.tick(at(ms));
      if (last) {
        expect(compareStamps(next, last)).toBeGreaterThan(0);
      }

      last = next;
    }
  });
});

describe('StampClock.observe', () => {
  it('moves the clock past a stored stamp, so a restart cannot mint one that sorts before it', () => {
    const clock = new StampClock('o');
    clock.observe(stamp('2026-11-05T12:00:10.000Z', 5));
    const next = clock.tick(T);
    expect(next.updatedAt).toBe('2026-11-05T12:00:10.000Z');
    expect(next.updatedAtCounter).toBe(6);
  });

  it('ignores a stamp older than the clock', () => {
    const clock = new StampClock('o');
    clock.tick(at(5000));
    clock.observe(stamp('2026-11-05T12:00:00.000Z', 9));
    expect(clock.tick(at(5000))).toMatchObject({
      updatedAt: '2026-11-05T12:00:05.000Z',
      updatedAtCounter: 1,
    });
  });

  it('keeps the higher counter within one millisecond', () => {
    const clock = new StampClock('o');
    clock.tick(T);
    clock.observe(stamp('2026-11-05T12:00:00.000Z', 7));
    expect(clock.tick(T).updatedAtCounter).toBe(8);
    clock.observe(stamp('2026-11-05T12:00:00.000Z', 2));
    expect(clock.tick(T).updatedAtCounter).toBe(9);
  });
});

describe('originId', () => {
  it('is random per clock and legal by default', () => {
    const a = new StampClock();
    const b = new StampClock();
    expect(a.originId).toMatch(ORIGIN_ID);
    expect(a.originId).not.toBe(b.originId);
  });

  it.each(['a', 'A-z_0', 'x'.repeat(64)])('accepts %s', (id) => {
    expect(new StampClock(id).originId).toBe(id);
  });

  it.each(['', 'has space', 'dot.ed', 'slash/', 'x'.repeat(65), 'é', 'a\n'])('refuses %j', (id) => {
    expect(() => new StampClock(id)).toThrow(TypeError);
  });
});

describe('compareStamps', () => {
  it('orders by time, then counter, then origin', () => {
    const a = stamp('2026-11-05T12:00:00.000Z', 0, 'a');
    expect(compareStamps(a, stamp('2026-11-05T12:00:00.001Z', 0, 'a'))).toBeLessThan(0);
    expect(compareStamps(stamp('2026-11-05T12:00:00.001Z', 0, 'a'), a)).toBeGreaterThan(0);
    expect(compareStamps(a, stamp('2026-11-05T12:00:00.000Z', 1, 'a'))).toBeLessThan(0);
    expect(compareStamps(a, stamp('2026-11-05T12:00:00.000Z', 0, 'b'))).toBeLessThan(0);
    expect(compareStamps(stamp('2026-11-05T12:00:00.000Z', 0, 'b'), a)).toBeGreaterThan(0);
    expect(compareStamps(a, { ...a })).toBe(0);
  });

  it('puts a later time before a higher counter', () => {
    expect(
      compareStamps(stamp('2026-11-05T12:00:01.000Z', 0), stamp('2026-11-05T12:00:00.999Z', 99)),
    ).toBeGreaterThan(0);
  });
});
