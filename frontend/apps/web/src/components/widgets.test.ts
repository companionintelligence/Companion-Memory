import { buildWidgetSnapshot, parseWidgetDestination } from '@ci/common';
import { describe, expect, it } from 'vitest';

describe('native widget snapshot', () => {
  it('limits and sanitizes task content, excludes completed tasks, and sorts by date', () => {
    const snapshot = buildWidgetSnapshot({
      now: new Date('2026-11-11T12:00:00.000Z'),
      tasks: [
        { id: 'late', title: 'Later task', status: 'todo', dueAt: '2026-11-14T10:00:00Z' },
        { id: 'done', title: 'Finished', status: 'done' },
        { id: 'skipped', title: 'Skipped', status: 'skipped' },
        { id: 'soon', title: '<b>Call the clinic</b>', status: 'todo', scheduledFor: '2026-11-12' },
        { id: 'open', title: 'No date', status: 'todo' },
      ],
    });

    expect(snapshot.plan.openCount).toBe(3);
    expect(snapshot.plan.tasks.map(({ id }) => id)).toEqual(['soon', 'late', 'open']);
    expect(snapshot.plan.tasks[0]?.title).toBe('Call the clinic');
    expect(snapshot.plan.tasks[0]?.dueAt).toBe('2026-11-12');
    expect(snapshot.plan.openCount).toBe(3);
    expect(snapshot.plan.tasks.every(({ title }) => title.length <= 72)).toBe(true);
  });

  it('shows forecast probability and daily totals with safe defaults for bad values', () => {
    const snapshot = buildWidgetSnapshot({
      now: new Date('2026-11-11T12:00:00.000Z'),
      forecast: {
        generatedAt: '2026-11-11T11:00:00Z',
        systemStatus: '<script>READY</script>',
        stillLearning: true,
        buckets: [
          {
            startTime: '2026-11-11T12:30:00Z',
            predictedL0: 'Work',
            l0Probs: [{ label: 'Work', probability: 1.4 }],
          },
        ],
      },
      metrics: [{ nMessages: 5, nPlaces: 2, kmTraveled: 3.26 }],
      jobs: { summary: { pending: 4, active: 2, failed: -1, deadLettered: 1, completed: 9 } },
    });

    expect(snapshot.insight.systemStatus).toBe('READY');
    expect(snapshot.insight.prediction).toBe('Work');
    expect(snapshot.insight.confidence).toBe(1);
    expect(snapshot.insight.messages).toBe(5);
    expect(snapshot.insight.kilometers).toBe(3.3);
    expect(snapshot.jobs).toMatchObject({ pending: 4, active: 2, failed: 0, deadLettered: 1, completed: 9 });
    expect(JSON.stringify(snapshot)).not.toMatch(/script|note body|apiKey/i);
  });

  it('words the prediction with predictionLabel and still finds its probability under the raw label', () => {
    const forecast = {
      generatedAt: '2026-11-11T11:00:00Z',
      systemStatus: 'READY',
      buckets: [
        {
          startTime: '2026-11-11T12:30:00Z',
          predictedL0: 'UNKNOWN',
          l0Probs: [
            { label: 'WORK', probability: 0.9 },
            { label: 'UNKNOWN', probability: 0.4 },
          ],
        },
      ],
    };
    const now = new Date('2026-11-11T12:00:00.000Z');

    const worded = buildWidgetSnapshot({
      now,
      forecast,
      predictionLabel: (raw) => `<b>${raw.toLowerCase()}</b>`,
    });

    expect(worded.insight.prediction).toBe('unknown');
    expect(worded.insight.confidence).toBe(0.4);
    expect(buildWidgetSnapshot({ now, forecast }).insight.prediction).toBe('UNKNOWN');
  });

  // HBPE dates the 24h histogram from the next UTC midnight, so every bucket is
  // in the future; the first one after `now` was always 00:00 UTC.
  it('picks the bucket for the next slot by time of day, not the first one dated after now', () => {
    const bucket = (startTime: string, predictedL0: string) => ({
      startTime,
      predictedL0,
      l0Probs: [{ label: predictedL0, probability: 0.6 }],
    });
    const snapshot = buildWidgetSnapshot({
      now: new Date('2026-11-11T12:05:00.000Z'),
      forecast: {
        generatedAt: '2026-11-11T11:00:00Z',
        systemStatus: 'READY',
        buckets: [
          bucket('2026-11-12T00:00:00Z', 'SLEEP'),
          bucket('2026-11-12T12:00:00Z', 'SOCIAL'),
          bucket('2026-11-12T12:15:00Z', 'WORK'),
          bucket('2026-11-12T12:30:00Z', 'ERRAND'),
        ],
      },
    });

    expect(snapshot.insight.prediction).toBe('WORK');
  });

  // Until the account has history the service answers with its starter prior,
  // the same class for every slot. The home-screen widgets and the Widgets card
  // printed it as a prediction ("Work, 12% likely").
  it('carries no prediction until the forecast has been built', () => {
    const now = new Date('2026-11-11T12:00:00.000Z');
    const insight = (systemStatus: string, modelVersion: string | null | undefined, stillLearning: boolean) =>
      buildWidgetSnapshot({
        now,
        forecast: {
          generatedAt: '2026-11-11T11:00:00Z',
          systemStatus,
          modelVersion,
          stillLearning,
          buckets: [
            {
              startTime: '2026-11-12T12:15:00Z',
              predictedL0: 'WORK',
              l0Probs: [{ label: 'WORK', probability: 0.97 }],
            },
          ],
        },
      }).insight;

    // The starter prior: nothing has run yet, or the first run is still labeling.
    for (const status of ['COLD_START', 'BOOTSTRAP:label', 'NIGHTLY:label', 'READY']) {
      expect(insight(status, 'b2', true)).toMatchObject({
        prediction: null,
        confidence: null,
        systemStatus: status,
      });
    }

    // COLD_START says nothing has run, whatever the model.
    expect(insight('COLD_START', null, false)).toMatchObject({ prediction: null, confidence: null });
    // A status the service does not send, or none, is not a built forecast.
    expect(insight('', 'logit', false)).toMatchObject({ prediction: null, systemStatus: 'UNKNOWN' });
    expect(insight('TRAINING', 'logit', false)).toMatchObject({ prediction: null });

    // Built from the account's history, between runs and during a later run,
    // still learning or not.
    for (const status of ['READY', 'NIGHTLY:label', 'BOOTSTRAP:train']) {
      expect(insight(status, 'b1', true)).toMatchObject({ prediction: 'WORK', confidence: 0.97 });
      expect(insight(status, 'logit', false)).toMatchObject({ prediction: 'WORK', confidence: 0.97 });
    }

    expect(insight('NIGHTLY:label', 'hmt', false)).toMatchObject({ prediction: 'WORK' });
    // A trained account the scores serve the b2 baseline to.
    expect(insight('READY', 'b2', false)).toMatchObject({ prediction: 'WORK', confidence: 0.97 });
  });

  // The native widgets print the likelihood under "No forecast yet", so one
  // without a named class read "No forecast yet, 97% likely".
  it('carries no likelihood when the slot names no class', () => {
    const snapshot = buildWidgetSnapshot({
      now: new Date('2026-11-11T12:00:00.000Z'),
      forecast: {
        generatedAt: '2026-11-11T11:00:00Z',
        systemStatus: 'READY',
        buckets: [
          {
            startTime: '2026-11-12T12:15:00Z',
            predictedL0: null,
            l0Probs: [
              { label: null, probability: 0.97 },
              { label: 'WORK', probability: 0.6 },
            ],
          },
        ],
      },
    });

    expect(snapshot.insight).toMatchObject({ prediction: null, confidence: null });
  });

  it('caps extreme server counts so native Int-backed widgets can still decode the snapshot', () => {
    const snapshot = buildWidgetSnapshot({
      now: new Date('2026-11-11T12:00:00.000Z'),
      metrics: [
        { nMessages: Number.MAX_VALUE, nPlaces: Number.MAX_VALUE, kmTraveled: Number.MAX_VALUE },
        { nMessages: Number.MAX_VALUE, nPlaces: Number.MAX_VALUE, kmTraveled: Number.MAX_VALUE },
      ],
      jobs: {
        summary: {
          pending: Number.MAX_VALUE,
          active: Number.MAX_VALUE,
          failed: Number.MAX_VALUE,
          deadLettered: Number.MAX_VALUE,
          completed: Number.MAX_VALUE,
        },
      },
    });

    expect(snapshot.insight.messages).toBe(1_000_000_000);
    expect(snapshot.insight.places).toBe(1_000_000_000);
    expect(snapshot.insight.kilometers).toBe(1_000_000_000);
    expect(snapshot.jobs).toMatchObject({
      pending: 1_000_000_000,
      active: 1_000_000_000,
      failed: 1_000_000_000,
      deadLettered: 1_000_000_000,
      completed: 1_000_000_000,
    });
    expect(Number.isFinite(snapshot.insight.kilometers)).toBe(true);
  });
});

describe('widget deep links', () => {
  it.each([
    ['companion://widget/plan', 'plan'],
    ['companion://widget/ask', 'ask'],
    ['companion://widget/questions', 'questions'],
    ['companion://widget/stats', 'stats'],
    ['companion://widget/jobs', 'jobs'],
  ])('accepts fixed destination %s', (url, destination) => {
    expect(parseWidgetDestination(url)).toBe(destination);
  });

  it.each([
    'companion://widget/plan?redirect=https://attacker.example',
    'companion://widget:123/plan',
    'companion://user@widget/plan',
    'companion://widget/plan/../../settings',
    'companion://oidc/callback',
    'https://example.com/widget/plan',
    'companion://widget/unknown',
  ])('rejects untrusted destination %s', (url) => {
    expect(parseWidgetDestination(url)).toBeNull();
  });
});
