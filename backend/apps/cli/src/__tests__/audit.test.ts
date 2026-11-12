import {
  auditDeadLettersCommand,
  auditDeltasCommand,
  auditJobsCommand,
  auditPipelineCommand,
} from '../commands/audit';
import { CliError } from '../context';

import { harness } from './support/harness';

describe('ci audit', () => {
  it('renders chronological entity evolution deltas', async () => {
    const ctx = harness({
      getAuditDeltas: async (q) => ({
        entityId: q.entityId,
        count: 1,
        deltas: [
          {
            id: 'd_1',
            entityId: q.entityId,
            entityType: 'person',
            changeType: 'updated',
            changedFields: { email: { before: null, after: 'ada@example.com' } },
            sourceType: 'enrichment',
            sourceId: 's_1',
            confidence: 0.95,
            occurredAt: '2026-11-12T09:00:00.000Z',
          },
        ],
      }),
    });

    await auditDeltasCommand(ctx, 'ent-123', { changeType: 'updated' });
    expect(ctx.term.text()).toContain('ent-123 (1 delta)');
    expect(ctx.term.text()).toContain('email');

    await expect(
      auditDeltasCommand(ctx, 'ent-123', { changeType: 'not-a-type' }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('renders the 37-stage pipeline coverage table', async () => {
    const ctx = harness({
      getPipelineState: async () => ({
        summary: {
          totalItems: 1000,
          fullyProcessed: 950,
          withFailures: 10,
          quarantined: 2,
        },
        stages: [
          {
            stage: 'embed',
            done: 988,
            pending: 10,
            failed: 2,
            quarantined: 0,
            stale: 0,
            avgAttempts: 1.0,
            coverage: 0.988,
          },
        ],
      }),
    });

    await auditPipelineCommand(ctx);
    expect(ctx.term.text()).toContain('total=1000  fully_processed=950');
    expect(ctx.term.text()).toContain('embed');
    expect(ctx.term.text()).toContain('98.8%');
  });

  it('renders dead-lettered pipeline jobs and PgBoss job queues', async () => {
    const ctx = harness({
      getDeadLetters: async () => ({
        count: 1,
        items: [
          {
            id: 'dl_1',
            queueName: 'enrichment-pipeline',
            jobId: 'j_1',
            entityId: 'e_1',
            entityType: 'item',
            stage: 'summarize',
            errorMessage: 'LLM endpoint timeout after 30000ms',
            attempts: 3,
            createdAt: '2026-11-12T07:00:00.000Z',
            replayedAt: null,
          },
        ],
      }),
      getJobsDashboard: async () => ({
        generatedAt: '2026-11-12T10:00:00.000Z',
        engine: { enabled: true, started: true },
        summary: {
          totalQueues: 1,
          activeJobs: 2,
          queuedJobs: 5,
          failedJobs: 0,
          registeredCrons: 1,
        },
        queues: [
          {
            name: 'hbpe-scheduled',
            domain: 'predictions',
            description: 'Nightly HBPE pipeline',
            counts: { created: 5, retry: 0, active: 2, completed: 40, failed: 0 },
          },
        ],
        crons: [
          {
            name: 'hbpe-nightly',
            cron: '0 3 * * *',
            domain: 'predictions',
            description: 'Nightly HBPE run',
            enabled: true,
          },
        ],
      }),
    });

    await auditDeadLettersCommand(ctx);
    expect(ctx.term.text()).toContain('enrichment-pipeline');
    expect(ctx.term.text()).toContain('LLM endpoint timeout');

    ctx.term.lines.length = 0;
    await auditJobsCommand(ctx);
    expect(ctx.term.text()).toContain('hbpe-scheduled');
    expect(ctx.term.text()).toContain('0 3 * * *');
  });
});
