import { STAGE_IDS } from '../../constants';
import { TemporalRepairStage } from '../../stages/clean/TemporalRepairStage';
import { EstimateLocationStage } from '../../stages/enrich/EstimateLocationStage';
import type { Stage } from '../../types';
import { EVENT_TIME_STAGES, EventTimeReopenService } from '../EventTimeReopenService';

/**
 * The pipeline side of `EVENT_TIME_REOPENER`: when an event's source moves its
 * time, CalendarEventService names the event, and this re-opens every stage
 * that decided on the old time — under the ledger entity type each stage
 * actually keys on, on the refresh's own transaction. The real stage classes
 * supply the entity types, as in EdgeProjectionReopenService.spec.ts.
 */
describe('EventTimeReopenService', () => {
  const logger = () =>
    ({ setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) as never;
  const stages = new Map<string, Stage>([
    [STAGE_IDS.CLEAN_TEMPORAL_REPAIR, new TemporalRepairStage({} as never, logger())],
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

    return { service: new EventTimeReopenService(stateService as never, registry as never), stateService };
  }

  const manager = { query: jest.fn() };

  it('re-opens the temporal repair and the location estimate, under "event", on the caller\'s transaction', async () => {
    const { service, stateService } = make(1);

    await expect(service.reopenTimeDecisions(['e1', 'e2'], manager)).resolves.toBe(2);

    expect(EVENT_TIME_STAGES).toEqual([STAGE_IDS.CLEAN_TEMPORAL_REPAIR, STAGE_IDS.ENRICH_ESTIMATE_LOCATION]);
    expect(stateService.reopen.mock.calls).toEqual([
      ['event', STAGE_IDS.CLEAN_TEMPORAL_REPAIR, ['e1', 'e2'], manager],
      ['event', STAGE_IDS.ENRICH_ESTIMATE_LOCATION, ['e1', 'e2'], manager],
    ]);
  });

  it('writes nothing for no events', async () => {
    const { service, stateService } = make();

    await expect(service.reopenTimeDecisions([], manager)).resolves.toBe(0);
    expect(stateService.reopen).not.toHaveBeenCalled();
  });
});
