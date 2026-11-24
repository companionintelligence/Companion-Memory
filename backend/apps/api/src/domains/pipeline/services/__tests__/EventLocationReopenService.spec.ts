import { STAGE_IDS } from '../../constants';
import { EstimateLocationStage } from '../../stages/enrich/EstimateLocationStage';
import { EventReverseStage } from '../../stages/enrich/EventReverseStage';
import { GeocodeStage } from '../../stages/enrich/GeocodeStage';
import { PlacePromoteStage } from '../../stages/promote/PlacePromoteStage';
import type { Stage } from '../../types';
import { EVENT_LOCATION_STAGES, EventLocationReopenService } from '../EventLocationReopenService';

/**
 * The pipeline side of `EVENT_LOCATION_REOPENER`: when an event's source moves
 * its place, CalendarEventService names the event, and this re-opens every stage
 * that decided on the old one — under the ledger entity type each stage actually
 * keys on, on the refresh's own transaction. The real stage classes supply the
 * entity types, as in EventTimeReopenService.spec.ts.
 */
describe('EventLocationReopenService', () => {
  const logger = () =>
    ({ setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) as never;
  const stages = new Map<string, Stage>([
    [STAGE_IDS.ENRICH_GEOCODE, new GeocodeStage({} as never, {} as never, logger())],
    [STAGE_IDS.ENRICH_EVENT_REVERSE, new EventReverseStage({} as never, {} as never, logger(), {} as never)],
    [STAGE_IDS.ENRICH_ESTIMATE_LOCATION, new EstimateLocationStage({} as never, logger())],
    [STAGE_IDS.PROMOTE_PLACE, new PlacePromoteStage({} as never, {} as never, logger())],
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

    return {
      service: new EventLocationReopenService(stateService as never, registry as never),
      stateService,
    };
  }

  const manager = { query: jest.fn() };

  it('re-opens the geocode, the reverse geocode, the estimate and the place link, under "event", on the caller\'s transaction', async () => {
    const { service, stateService } = make(1);

    await expect(service.reopenLocationDecisions(['e1', 'e2'], manager)).resolves.toBe(4);

    expect(EVENT_LOCATION_STAGES).toEqual([
      STAGE_IDS.ENRICH_GEOCODE,
      STAGE_IDS.ENRICH_EVENT_REVERSE,
      STAGE_IDS.ENRICH_ESTIMATE_LOCATION,
      STAGE_IDS.PROMOTE_PLACE,
    ]);
    expect(stateService.reopen.mock.calls).toEqual(
      EVENT_LOCATION_STAGES.map((stage) => ['event', stage, ['e1', 'e2'], manager]),
    );
  });

  it('leaves the edge leg to promote.place, which re-opens it when the new link lands', async () => {
    // Re-opening promote.edge_event here would re-decide the event before its new
    // link exists. STAGE_REOPENS does it, in the right order, once promote.place
    // records `done`.
    expect(EVENT_LOCATION_STAGES).not.toContain(STAGE_IDS.PROMOTE_EDGE_EVENT);
  });

  it('writes nothing for no events', async () => {
    const { service, stateService } = make();

    await expect(service.reopenLocationDecisions([], manager)).resolves.toBe(0);
    expect(stateService.reopen).not.toHaveBeenCalled();
  });
});
