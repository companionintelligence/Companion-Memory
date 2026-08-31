import { checkSlidingWindow } from './slidingWindow';

describe('checkSlidingWindow', () => {
  it('allows attempts under the limit and appends the new timestamp', () => {
    const { kept, decision } = checkSlidingWindow([1000, 2000], 3000, 60_000, 5);

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(2); // 5 max - 3 kept
    expect(kept).toEqual([1000, 2000, 3000]);
  });

  it('blocks at the limit and reports retry-after from the oldest in-window attempt', () => {
    const now = 10_000;
    const window = 60_000;
    const { kept, decision } = checkSlidingWindow([5000, 6000, 7000], now, window, 3);

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    // oldest (5000) + window (60000) - now (10000) = 55000
    expect(decision.retryAfterMs).toBe(55_000);
    expect(kept).toEqual([5000, 6000, 7000]); // new attempt NOT appended when blocked
  });

  it('drops attempts outside the window so the limit slides', () => {
    // Two old attempts fall outside a 1s window; only the recent one counts.
    const { kept, decision } = checkSlidingWindow([100, 200, 9500], 10_000, 1000, 2);

    expect(decision.allowed).toBe(true);
    expect(kept).toEqual([9500, 10_000]); // expired 100/200 dropped
  });
});
