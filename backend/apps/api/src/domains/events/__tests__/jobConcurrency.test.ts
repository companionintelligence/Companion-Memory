import {
  effectiveQueueConcurrency,
  maxQueueConcurrency,
  perProcessGlobalConcurrency,
} from '../jobConcurrency';

/**
 * The arithmetic behind every number on the Controls card.
 *
 * Two properties have to hold or the feature is worse than not having it:
 *
 *  1. **An unconfigured appliance behaves exactly as it did before.** The
 *     acceptance criterion is that defaults change nothing for anyone who never
 *     opens the page, and the division by process count is the one place that
 *     could quietly break it.
 *  2. **A setting can only ever make the box quieter.** Nothing an operator can
 *     save may raise a ceiling above what the build already allowed — otherwise
 *     a control added to stop a box overheating becomes a way to overheat it.
 */

describe('perProcessGlobalConcurrency', () => {
  it('leaves a single-process appliance at its shipped ceiling when nothing is set', () => {
    expect(perProcessGlobalConcurrency(null, 10, 1)).toBe(10);
  });

  it('leaves a split appliance at its shipped ceiling when nothing is set', () => {
    // Today, web and worker each run a 10-slot semaphore, so the appliance-wide
    // ceiling is 20. The default has to divide back to 10 per process or turning
    // this feature on would silently halve a split deployment's throughput.
    expect(perProcessGlobalConcurrency(null, 10, 2)).toBe(10);
  });

  it('splits an operator cap evenly across the processes that enforce it', () => {
    expect(perProcessGlobalConcurrency(12, 10, 2)).toBe(6);
    expect(perProcessGlobalConcurrency(12, 10, 1)).toBe(12);
  });

  it('rounds the split down, so the appliance never exceeds the cap', () => {
    // 7 across two processes is 3 each, i.e. 6 — under the cap. Rounding up
    // would put 8 in flight on a box told to allow 7.
    expect(perProcessGlobalConcurrency(7, 10, 2)).toBe(3);
  });

  it('never hands a process zero slots', () => {
    // The one case that rounds UP, and it is that or a queue with no worker: a
    // process with zero slots has stopped, and "cap at 1" must not mean "switch
    // the appliance off".
    expect(perProcessGlobalConcurrency(1, 10, 2)).toBe(1);
  });
});

describe('maxQueueConcurrency', () => {
  it('is the global per-queue default when the queue declares nothing', () => {
    expect(maxQueueConcurrency(6, null)).toBe(6);
  });

  it("is the queue's own declaration when that is tighter", () => {
    // `llm` declares 1 because two chat generations at once thrash the model.
    // No number typed into a settings page gets to overrule that.
    expect(maxQueueConcurrency(6, 1)).toBe(1);
  });

  it('does not let a queue declaration raise the ceiling', () => {
    expect(maxQueueConcurrency(4, 10)).toBe(4);
  });
});

describe('effectiveQueueConcurrency', () => {
  it('falls back to the ceiling when the operator has no opinion', () => {
    expect(effectiveQueueConcurrency({ perQueueDefault: 6, requested: null, declared: null })).toBe(6);
  });

  it('honours a request that lowers the ceiling', () => {
    expect(effectiveQueueConcurrency({ perQueueDefault: 6, requested: 2, declared: null })).toBe(2);
  });

  it('clamps a request that would raise it', () => {
    // The safety property: a saved setting can only make the queue quieter.
    expect(effectiveQueueConcurrency({ perQueueDefault: 6, requested: 40, declared: null })).toBe(6);
  });

  it("clamps to the queue's declared ceiling even when the request is under the global default", () => {
    expect(effectiveQueueConcurrency({ perQueueDefault: 6, requested: 4, declared: 1 })).toBe(1);
  });

  it('never returns zero', () => {
    expect(effectiveQueueConcurrency({ perQueueDefault: 0, requested: null, declared: 0 })).toBe(1);
  });
});
