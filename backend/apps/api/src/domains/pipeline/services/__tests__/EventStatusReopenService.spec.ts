import type { EntityManager } from 'typeorm';

import { STAGE_IDS } from '../../constants';
import { EstimateLocationStage, ESTIMATED_CONFIDENCE } from '../../stages/enrich/EstimateLocationStage';
import type { Stage } from '../../types';
import { EVENT_STATUS_STAGES, EventStatusReopenService } from '../EventStatusReopenService';

/**
 * The pipeline side of `EVENT_STATUS_REOPENER`: when a status write calls an
 * event off or reinstates it, CalendarEventService names the event, and this
 * takes back what an event that did not happen was lent and re-opens the
 * decision made on whether it happened — under the ledger entity type the
 * stage actually keys on, on the writer's own transaction. The real stage class
 * supplies the entity type, as in EventTimeReopenService.spec.ts. What it does
 * to real rows is EventWritesSettlePipeline.integration.spec.ts.
 */
describe('EventStatusReopenService', () => {
  const logger = () =>
    ({ setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) as never;
  const stages = new Map<string, Stage>([
    [STAGE_IDS.ENRICH_ESTIMATE_LOCATION, new EstimateLocationStage({} as never, logger())],
  ]);

  function make(moved = 1) {
    const stateService = { reopen: jest.fn(async () => moved) };
    const registry = {
      get: jest.fn((stageId: string) => {
        const stage = stages.get(stageId);

        if (stage == null) {
          throw new Error(`Unknown pipeline stage "${stageId}".`);
        }

        return stage;
      }),
    };

    return { service: new EventStatusReopenService(stateService as never, registry as never), stateService };
  }

  /** A transaction that answers the withdrawal with the rows it took an estimate from. */
  const transaction = (withdrawn: string[] = []) => {
    const query = jest.fn(async (..._args: unknown[]) => withdrawn.map((event_id) => ({ event_id })));

    return Object.assign({ query } as unknown as Pick<EntityManager, 'query'>, { calls: query });
  };

  it('re-opens the location estimate under "event", on the caller\'s transaction', async () => {
    const { service, stateService } = make(1);
    const manager = transaction();

    await expect(service.reopenStatusDecisions(['e1', 'e2'], manager)).resolves.toBe(1);

    expect(EVENT_STATUS_STAGES).toEqual([STAGE_IDS.ENRICH_ESTIMATE_LOCATION]);
    expect(stateService.reopen.mock.calls).toEqual([
      ['event', STAGE_IDS.ENRICH_ESTIMATE_LOCATION, ['e1', 'e2'], manager],
    ]);
  });

  it('takes back the estimates of the events it is given, on that same transaction', async () => {
    const { service } = make();
    const manager = transaction(['e1']);

    await service.reopenStatusDecisions(['e1', 'e2'], manager);

    expect(manager.calls).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.calls.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/UPDATE ci\.events/);
    expect(params).toEqual([['e1', 'e2'], ESTIMATED_CONFIDENCE, 'estimated']);
  });

  it('answers with the ledger rows it moved, not the estimates it took back', async () => {
    const { service } = make(3);

    await expect(service.reopenStatusDecisions(['e1'], transaction(['e1']))).resolves.toBe(3);
  });

  it('writes nothing for no events', async () => {
    const { service, stateService } = make();
    const manager = transaction();

    await expect(service.reopenStatusDecisions([], manager)).resolves.toBe(0);
    expect(manager.calls).not.toHaveBeenCalled();
    expect(stateService.reopen).not.toHaveBeenCalled();
  });

  it('lets a failure of the withdrawal reach the writer, whose transaction then rolls back whole', async () => {
    const { service } = make();
    const manager = {
      query: jest.fn(async () => Promise.reject(new Error('lock timeout'))),
    } as unknown as Pick<EntityManager, 'query'>;

    await expect(service.reopenStatusDecisions(['e1'], manager)).rejects.toThrow('lock timeout');
  });

  it('lets a failure of the re-open reach the writer too', async () => {
    const { service, stateService } = make();
    stateService.reopen.mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(service.reopenStatusDecisions(['e1'], transaction())).rejects.toThrow('ledger unavailable');
  });
});
