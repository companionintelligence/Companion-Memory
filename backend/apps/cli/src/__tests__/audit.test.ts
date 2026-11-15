import {
  auditDeadLettersCommand,
  auditDeltasCommand,
  auditJobsCommand,
  auditPipelineCommand,
} from '../commands/audit';
import { CliError } from '../context';
import type {
  AuditDeltasQuery,
  EntityDeltasResponse,
  JobsDashboardResponse,
  PipelineDeadLettersResponse,
  PipelineStateResponse,
} from '../wire';

import { harness } from './support/harness';
import { wireFixture } from './support/wireFixtures';

/**
 * Queries and responses come from `fixtures/wire/{audit,pipeline,jobs}.json`,
 * which the API's `cliWireContract.test.ts` suites check against the real
 * controllers. The hand-built responses these tests used before matched
 * `wire.ts` and nothing the server sends: all four commands crashed on a real
 * appliance, and `deltas` dropped its time window on the way out.
 */
const audit = wireFixture('audit.json');
const pipeline = wireFixture('pipeline.json');
const jobs = wireFixture('jobs.json');

describe('ci audit', () => {
  it('sends the time window as since/until and reads the { success, data } envelope', async () => {
    let sent: AuditDeltasQuery | undefined;
    const ctx = harness({
      getAuditDeltas: async (query) => {
        sent = query;

        return audit.deltas.response as EntityDeltasResponse;
      },
    });

    await auditDeltasCommand(ctx, '0193a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b', {
      changeType: 'updated',
      from: '2026-11-01',
      to: '2026-11-12T00:00:00Z',
      limit: '50',
    });

    expect(sent).toEqual(audit.deltas.query);
    expect(ctx.term.text()).toContain('0193a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b (1 delta, newest first)');
    expect(ctx.term.text()).toMatch(/2026-11-10 09:00\s+updated\s+Person\s+enrichment\s+email/);
  });

  it('refuses what the route would refuse, before asking it', async () => {
    const ctx = harness({});
    const entityId = '0193a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b';

    await expect(auditDeltasCommand(ctx, entityId, { changeType: 'not-a-type' })).rejects.toBeInstanceOf(
      CliError,
    );
    await expect(auditDeltasCommand(ctx, entityId, { from: 'last tuesday' })).rejects.toThrow(/--from/);
    await expect(auditDeltasCommand(ctx, entityId, { limit: '251' })).rejects.toThrow(/at most 250/);
  });

  it('renders the per-stage ledger from `stages`, the only field the route sends', async () => {
    const ctx = harness({
      getPipelineState: async () => pipeline.state.response as PipelineStateResponse,
    });

    await auditPipelineCommand(ctx);

    expect(ctx.term.text()).toContain('stages  1  failed=7  quarantined=1  stale=40');
    expect(ctx.term.text()).toMatch(/embed\s+3\s+98\.8%\s+1000\s+960\s+28\s+3\s+1\s+7\s+1\s+40/);
  });

  it('lists a page of dead letters from `deadLetters`, first line of each error only', async () => {
    let sent: unknown;
    const ctx = harness({
      getDeadLetters: async (query) => {
        sent = query;

        return pipeline.deadLetters.response as PipelineDeadLettersResponse;
      },
    });

    await auditDeadLettersCommand(ctx, { queue: 'enrichment-pipeline', stage: 'summarize', limit: '20' });

    expect(sent).toEqual(pipeline.deadLetters.query);
    expect(ctx.term.text()).toContain('dead letters  1 shown, newest first');
    expect(ctx.term.text()).toMatch(/enrichment-pipeline\s+pipeline\.stage\.summarize\s+summarize/);
    expect(ctx.term.text()).toContain('LLM endpoint timed out after 30000ms');
    expect(ctx.term.text()).not.toContain('SummaryClient.request');

    await expect(auditDeadLettersCommand(ctx, { limit: '201' })).rejects.toThrow(/at most 200/);
  });

  it('renders job counts, queues with their live jobs, and cron health', async () => {
    const ctx = harness({
      getJobsDashboard: async () => jobs.dashboard.response as JobsDashboardResponse,
    });

    await auditJobsCommand(ctx);

    expect(ctx.term.text()).toContain('jobs  pending=5  active=2  retry=1  failed=3  dead-lettered=1');
    expect(ctx.term.text()).toMatch(/hbpe-scheduled\s+7\s+standard\s+2\s+dead-letter/);
    expect(ctx.term.text()).toMatch(/PythonFunctionCrons\.hbpeNightly\s+0 3 \* \* \*\s+worker/);
    expect(ctx.term.text()).toMatch(/2026-11-12 03:00\s+running/);
  });
});
