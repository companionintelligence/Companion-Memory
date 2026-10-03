import { EDGE_STAGES_BY_SOURCE } from '../../listeners/GraphEdgeSweepRequestListener';
import {
  CommunicationEdgePromoteStage,
  EventEdgePromoteStage,
  PROMOTE_EDGE_COMMUNICATION_STAGE_ID,
  PROMOTE_EDGE_EVENT_STAGE_ID,
} from '../../stages/promote/EdgePromoteStage';
import type { Stage } from '../../types';
import { EdgeProjectionReopenService } from '../EdgeProjectionReopenService';

/**
 * The pipeline side of `EDGE_PROJECTION_REOPENER`: a linkage writer that is not
 * a stage names an edge SOURCE, and this re-opens the leg that projects it —
 * under the ledger entity type that leg actually keys on, on the writer's own
 * transaction. The real edge stage classes supply the entity types, because a
 * hand-kept copy is exactly how a re-open lands on rows nothing sweeps.
 */
describe('EdgeProjectionReopenService', () => {
  const logger = () =>
    ({ setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() }) as never;
  const stages = new Map<string, Stage>([
    [PROMOTE_EDGE_COMMUNICATION_STAGE_ID, new CommunicationEdgePromoteStage({} as never, logger())],
    [PROMOTE_EDGE_EVENT_STAGE_ID, new EventEdgePromoteStage({} as never, logger())],
  ]);

  function make(moved = 3) {
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
      service: new EdgeProjectionReopenService(stateService as never, registry as never),
      stateService,
      registry,
    };
  }

  const manager = { query: jest.fn() };

  it("re-opens promote.edge_communication under 'communication' for the communications a linker wrote", async () => {
    const { service, stateService } = make(2);

    await expect(service.reopen('communications', ['c1', 'c2'], manager)).resolves.toBe(2);

    expect(EDGE_STAGES_BY_SOURCE.communications).toBe(PROMOTE_EDGE_COMMUNICATION_STAGE_ID);
    expect(stateService.reopen).toHaveBeenCalledTimes(1);
    // The writer's transaction, passed straight through: the re-open commits
    // with the link or not at all.
    expect(stateService.reopen).toHaveBeenCalledWith(
      'communication',
      PROMOTE_EDGE_COMMUNICATION_STAGE_ID,
      ['c1', 'c2'],
      manager,
    );
  });

  it("re-opens promote.edge_event under 'event' for the events a linker wrote", async () => {
    const { service, stateService } = make(1);

    await expect(service.reopen('events', ['e1'], manager)).resolves.toBe(1);

    expect(stateService.reopen).toHaveBeenCalledWith('event', PROMOTE_EDGE_EVENT_STAGE_ID, ['e1'], manager);
  });

  it('throws for a source no edge leg projects, so the linkage write rolls back with it', async () => {
    const { service, stateService } = make();

    await expect(service.reopen('telepathy' as never, ['x'], manager)).rejects.toThrow(
      /No promote\.edge_\* leg projects edge source "telepathy"/,
    );
    expect(stateService.reopen).not.toHaveBeenCalled();
  });

  it('does nothing for an empty id list', async () => {
    const { service, stateService, registry } = make();

    await expect(service.reopen('communications', [], manager)).resolves.toBe(0);
    expect(stateService.reopen).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
  });
});
