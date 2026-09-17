import {
  effectiveQueueConcurrency,
  maxQueueConcurrency,
  perProcessGlobalConcurrency,
  perQueueDefaultConcurrency,
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
    // On a single-process appliance the shipped ceiling is 10, so 12 is a RAISE
    // and clamps. This case used to assert 12 — the suite's own header states
    // property 2 and this line quietly contradicted it, which is how the
    // behaviour survived review.
    expect(perProcessGlobalConcurrency(12, 10, 1)).toBe(10);
    expect(perProcessGlobalConcurrency(8, 10, 1)).toBe(8);
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

  it('refuses to raise the appliance above what the build ships with', () => {
    // Property 2, on the control that most obviously breaks it. `MAX_CONCURRENCY`
    // is 64 and the API accepts it, so without this clamp typing 64 into "Jobs at
    // once, whole appliance" put six times the shipped load on the box — from the
    // page whose reason for existing is that the box is already too hot.
    expect(perProcessGlobalConcurrency(64, 10, 1)).toBe(10);
    expect(perProcessGlobalConcurrency(64, 10, 2)).toBe(10);
  });

  it('clamps at the shipped APPLIANCE figure, not the per-process one', () => {
    // On a split deployment the shipped appliance ceiling is 20, so 16 is a real
    // reduction and must be honoured rather than being read as "above 10".
    expect(perProcessGlobalConcurrency(16, 10, 2)).toBe(8);
  });
});

describe('perQueueDefaultConcurrency', () => {
  it('is the shipped default when the operator has no opinion', () => {
    expect(perQueueDefaultConcurrency(null, 6)).toBe(6);
  });

  it('honours a lower default', () => {
    expect(perQueueDefaultConcurrency(2, 6)).toBe(2);
  });

  it('refuses to raise the default above what the build ships with', () => {
    // The subtle half of property 2. Every queue's ceiling is derived from this
    // number, so a raise here is a raise on every queue at once — and each queue
    // would then clamp faithfully to the raised figure and look correct doing it.
    expect(perQueueDefaultConcurrency(64, 6)).toBe(6);
  });

  it('never returns zero', () => {
    expect(perQueueDefaultConcurrency(null, 0)).toBe(1);
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

  it('cannot be raised through the global per-queue default either', () => {
    // The composition the two functions have to satisfy together: the operator
    // raises the global default to 64 AND asks this queue for 64. Clamping only
    // against the default they just raised would answer 64.
    const perQueueDefault = perQueueDefaultConcurrency(64, 6);

    expect(effectiveQueueConcurrency({ perQueueDefault, requested: 64, declared: null })).toBe(6);
  });
});
