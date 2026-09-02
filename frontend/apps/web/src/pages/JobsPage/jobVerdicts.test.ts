import { describe, expect, it } from 'vitest';

import { jobVerdicts } from './jobVerdicts';

/**
 * The verdict band is the page's only opinion, so its failure mode is a
 * confident wrong sentence. These pin the cases where being wrong would be
 * worse than saying nothing.
 */
const label = (key: string) => ({ ingest: 'Ingest', search: 'Search index' })[key] ?? key;

describe('jobVerdicts', () => {
  it('says nothing at all when it knows nothing', () => {
    // A page that reassures before it has read anything has lied once, and an
    // operator who catches it doing that cannot trust the band afterwards.
    expect(jobVerdicts({ stateCounts: {}, categoryCounts: {}, categoryLabel: label })).toEqual([]);
  });

  it('leads with mass failure, and names the category carrying it', () => {
    // The live shape this was built against: 8,431 of 19,606 dead-lettered,
    // ingest dominant. That fact used to be a tab label next to "Retrying 2".
    const [first] = jobVerdicts({
      stateCounts: { 'dead-letter': 8431, completed: 11120, failed: 55 },
      categoryCounts: { ingest: 13753, search: 4492, pipeline: 304 },
      categoryLabel: label,
    });

    expect(first?.tone).toBe('critical');
    expect(first?.headline).toBe('8,431 jobs have given up.');
    expect(first?.detail).toContain('43%');
    expect(first?.detail).toContain('ingest');
    // The claim has to be clickable, and click to exactly what it counted.
    expect(first?.filter).toMatchObject({ state: 'dead-letter' });
  });

  it('separates work that is stuck from work that is merely queued', () => {
    // Queued WITH a worker running is a busy box; queued with nothing running
    // is a dead worker. Same number, opposite actions.
    const stalled = jobVerdicts({
      stateCounts: { created: 400, active: 0 },
      categoryCounts: {},
      categoryLabel: label,
    });
    const busy = jobVerdicts({
      stateCounts: { created: 400, active: 6 },
      categoryCounts: {},
      categoryLabel: label,
    });

    expect(stalled[0]?.id).toBe('stalled');
    expect(stalled[0]?.tone).toBe('critical');
    expect(busy.find((v) => v.id === 'backlog')?.tone).toBe('warning');
    expect(busy.find((v) => v.id === 'stalled')).toBeUndefined();
  });

  it('keeps "failing" and "gave up" apart', () => {
    // A failed job still has retries; a dead letter has none. Merging them
    // hides which direction the box is going.
    const verdicts = jobVerdicts({
      stateCounts: { failed: 55, 'dead-letter': 12, completed: 900 },
      categoryCounts: {},
      categoryLabel: label,
    });

    expect(verdicts.map((v) => v.id)).toEqual(expect.arrayContaining(['failing', 'dead-lettered']));
    expect(verdicts.find((v) => v.id === 'failing')?.filter).toMatchObject({ state: 'failed' });
  });

  it('reports a schedule that has fired and never succeeded', () => {
    // `running` is not health and "last run" is not "last success" — a schedule
    // failing every tick is invisible on a list that only shows the former.
    const verdicts = jobVerdicts({
      stateCounts: { completed: 10 },
      categoryCounts: {},
      categoryLabel: label,
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
      categoryLabel: label,
    });

    expect(healthy).toHaveLength(1);
    expect(healthy[0]?.id).toBe('healthy');

    // …and never beside something that needs attention.
    const unhealthy = jobVerdicts({
      stateCounts: { completed: 5000, 'dead-letter': 3 },
      categoryCounts: {},
      categoryLabel: label,
    });

    expect(unhealthy.map((v) => v.id)).not.toContain('healthy');
  });

  it('sorts worst first, so the top line is the thing to act on', () => {
    const verdicts = jobVerdicts({
      stateCounts: { created: 10, active: 0, failed: 4, 'dead-letter': 900, completed: 90 },
      categoryCounts: { ingest: 900, unclassified: 7 },
      categoryLabel: label,
    });

    const tones = verdicts.map((v) => v.tone);
    const firstWarning = tones.indexOf('warning');

    expect(tones[0]).toBe('critical');
    expect(tones.slice(0, firstWarning).every((tone) => tone === 'critical')).toBe(true);
  });
});
