import { describe, expect, it } from 'vitest';

import { jobVerdicts } from './jobVerdicts';

/**
 * The verdict band is the page's only opinion, so its failure mode is a
 * confident wrong sentence. These pin the cases where being wrong would be
 * worse than saying nothing — several of them regressions a review caught.
 */
describe('jobVerdicts', () => {
  it('says nothing at all when it knows nothing', () => {
    // A page that reassures before it has read anything has lied once, and an
    // operator who catches it doing that cannot trust the band afterwards.
    expect(jobVerdicts({ stateCounts: {}, categoryCounts: {} })).toEqual([]);
  });

  it('leads with mass failure', () => {
    const [first] = jobVerdicts({
      stateCounts: { 'dead-letter': 8431, completed: 11120 },
      categoryCounts: { ingest: 13753, search: 4492 },
    });

    expect(first?.tone).toBe('critical');
    expect(first?.headline).toBe('8,431 jobs have given up.');
    expect(first?.filter).toMatchObject({ state: 'dead-letter' });
  });

  // ── Regressions a review caught ─────────────────────────────────────────

  it('claims no percentage of "everything", because the two sides are not comparable', () => {
    // The dead-letter queue keeps 30 days; pg-boss deletes completed and failed
    // rows after `deleteAfterHours`. A job that exhausted its retries is also
    // counted twice — once as the `failed` origin, once as the copy. The old
    // ratio was a 30-day pile over a half-day window, and it understated worst
    // during the mass failure the verdict exists to announce.
    const [first] = jobVerdicts({
      stateCounts: { 'dead-letter': 8431, failed: 2000, completed: 9000 },
      categoryCounts: {},
    });

    expect(first?.detail).not.toMatch(/%/);
    expect(first?.detail).not.toMatch(/everything on this appliance/);
  });

  it('does not name a cause it cannot know', () => {
    // `categoryCounts` counts EVERY state, so its largest bucket is the busiest
    // category on the box — not the failing one. On an appliance that is 90%
    // search and failing entirely on ingest, the old copy blamed search.
    const [first] = jobVerdicts({
      stateCounts: { 'dead-letter': 500, completed: 9500 },
      categoryCounts: { search: 9000, ingest: 1000 },
    });

    expect(first?.detail).not.toMatch(/search/i);
    expect(first?.detail).not.toMatch(/most of it/i);
  });

  it('does not clear the filters the number was counted under', () => {
    // On /jobs?category=llm the server scopes stateCounts to llm, so the
    // sentence is about llm. A click-through that cleared `category` opened a
    // table of every category — a different, larger set than the one claimed.
    const [first] = jobVerdicts({
      stateCounts: { 'dead-letter': 12, completed: 250 },
      categoryCounts: { llm: 262 },
    });

    expect(first?.filter).not.toHaveProperty('category');
    expect(first?.filter).not.toHaveProperty('type');
  });

  it('reads pg-boss state semantics the right way round', () => {
    // `retry` is the state with attempts LEFT. `failed` is terminal — it is what
    // mints the dead-letter copy. The old single verdict counted `failed` and
    // called it "failing but still retrying … these have attempts left", which
    // reassured about exactly the jobs that had died.
    const verdicts = jobVerdicts({
      stateCounts: { retry: 7, failed: 2000, completed: 900 },
      categoryCounts: {},
    });

    const retrying = verdicts.find((v) => v.id === 'retrying');
    const failed = verdicts.find((v) => v.id === 'failed');

    expect(retrying?.headline).toBe('7 jobs are retrying.');
    expect(retrying?.detail).toMatch(/attempts left/);
    expect(retrying?.filter).toMatchObject({ state: 'retry' });

    expect(failed?.headline).toBe('2,000 jobs have failed outright.');
    expect(failed?.detail).toMatch(/spent|exhausted/i);
    expect(failed?.detail).not.toMatch(/attempts left/);
    expect(failed?.filter).toMatchObject({ state: 'failed' });
  });

  // ── Distinctions worth keeping ──────────────────────────────────────────

  it('separates work that is stuck from work that is merely queued', () => {
    // Queued WITH a worker running is a busy box; queued with nothing running
    // is a dead worker. Same number, opposite actions.
    const stalled = jobVerdicts({ stateCounts: { created: 400, active: 0 }, categoryCounts: {} });
    const busy = jobVerdicts({ stateCounts: { created: 400, active: 6 }, categoryCounts: {} });

    expect(stalled[0]?.id).toBe('stalled');
    expect(stalled[0]?.tone).toBe('critical');
    expect(busy.find((v) => v.id === 'backlog')?.tone).toBe('warning');
    expect(busy.find((v) => v.id === 'stalled')).toBeUndefined();
  });

  it('reports a schedule that has fired and never succeeded', () => {
    // `running` is not health and "last run" is not "last success" — a schedule
    // failing every tick is invisible on a list that only shows the former.
    const verdicts = jobVerdicts({
      stateCounts: { completed: 10 },
      categoryCounts: {},
      crons: [
        { name: 'DerivationCron.deriveNightly', lastRunAt: '2026-09-01T04:40:00Z', lastSuccessAt: null },
        {
          name: 'PipelineTickCron.runOnSchedule',
          lastRunAt: '2026-09-01T12:00:00Z',
          lastSuccessAt: '2026-09-01T12:00:00Z',
        },
      ],
    });

    const verdict = verdicts.find((v) => v.id === 'never-succeeded');

    expect(verdict?.tone).toBe('critical');
    expect(verdict?.headline).toBe('1 schedule has run and never succeeded.');
    expect(verdict?.detail).toContain('DerivationCron');
  });

  it('gives the all-clear only when it is alone', () => {
    const healthy = jobVerdicts({
      stateCounts: { completed: 5000, active: 2 },
      categoryCounts: { ingest: 5000 },
    });

    expect(healthy).toHaveLength(1);
    expect(healthy[0]?.id).toBe('healthy');

    const unhealthy = jobVerdicts({
      stateCounts: { completed: 5000, 'dead-letter': 3 },
      categoryCounts: {},
    });

    expect(unhealthy.map((v) => v.id)).not.toContain('healthy');
  });

  it('sorts worst first, so the top line is the thing to act on', () => {
    const verdicts = jobVerdicts({
      stateCounts: { created: 10, active: 0, failed: 4, 'dead-letter': 900, completed: 90 },
      categoryCounts: { ingest: 900, unclassified: 7 },
    });

    const tones = verdicts.map((v) => v.tone);
    const firstWarning = tones.indexOf('warning');

    expect(tones[0]).toBe('critical');
    expect(tones.slice(0, firstWarning).every((tone) => tone === 'critical')).toBe(true);
  });
});
