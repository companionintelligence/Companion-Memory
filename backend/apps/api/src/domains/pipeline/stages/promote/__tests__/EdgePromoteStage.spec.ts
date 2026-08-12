import { type UserServiceContext } from '@ci/common/context';
import type { DeterministicEdgeBackfillService } from '@ci/domains/maintenance';
import { DETERMINISTIC_EDGE_RULES } from '@ci/domains/maintenance';

import { STAGE_IDS } from '../../../constants';
import { STAGE_VERSIONS } from '../../../versions';
import {
  CommunicationEdgePromoteStage,
  ContentEdgePromoteStage,
  DeviceEdgePromoteStage,
  EDGE_PROJECTION_RULE_GENERATION,
  EventEdgePromoteStage,
  FileEdgePromoteStage,
  InventoryEdgePromoteStage,
  ObservationEdgePromoteStage,
  PlaceEdgePromoteStage,
  PositionEdgePromoteStage,
  PROMOTE_EDGE_COMMUNICATION_STAGE_ID,
  PROMOTE_EDGE_COMMUNICATION_VERSION,
  PROMOTE_EDGE_DEVICE_STAGE_ID,
  PROMOTE_EDGE_DEVICE_VERSION,
  PROMOTE_EDGE_EVENT_STAGE_ID,
  PROMOTE_EDGE_EVENT_VERSION,
  PROMOTE_EDGE_FILE_STAGE_ID,
  PROMOTE_EDGE_FILE_VERSION,
  PROMOTE_EDGE_OBSERVATION_STAGE_ID,
  PROMOTE_EDGE_OBSERVATION_VERSION,
  PROMOTE_EDGE_PLACE_STAGE_ID,
  PROMOTE_EDGE_PLACE_VERSION,
  PROMOTE_EDGE_POSITION_STAGE_ID,
  PROMOTE_EDGE_POSITION_VERSION,
  PROMOTE_EDGE_RECEIPT_STAGE_ID,
  PROMOTE_EDGE_RECEIPT_VERSION,
  promoteEdgeStageVersion,
  ReceiptEdgePromoteStage,
} from '../EdgePromoteStage';

const CTX = { userId: 'user-1' } as UserServiceContext;

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as never;
}

function makeService(impl?: (userId: string, source: string, ids: string[]) => Promise<number>) {
  return {
    materializeForSourceIds: jest.fn(impl ?? (() => Promise.resolve(0))),
  } as unknown as DeterministicEdgeBackfillService & {
    materializeForSourceIds: jest.Mock;
  };
}

describe('EdgePromoteStage', () => {
  describe('wiring', () => {
    it('reports the ids the central declarations use', () => {
      expect(PROMOTE_EDGE_COMMUNICATION_STAGE_ID).toBe(STAGE_IDS.PROMOTE_EDGE_COMMUNICATION);
      expect(PROMOTE_EDGE_EVENT_STAGE_ID).toBe(STAGE_IDS.PROMOTE_EDGE_EVENT);
      expect(PROMOTE_EDGE_RECEIPT_STAGE_ID).toBe(STAGE_IDS.PROMOTE_EDGE_RECEIPT);
      expect(PROMOTE_EDGE_OBSERVATION_STAGE_ID).toBe(STAGE_IDS.PROMOTE_EDGE_OBSERVATION);
      expect(PROMOTE_EDGE_POSITION_STAGE_ID).toBe(STAGE_IDS.PROMOTE_EDGE_POSITION);
      expect(PROMOTE_EDGE_DEVICE_STAGE_ID).toBe(STAGE_IDS.PROMOTE_EDGE_DEVICE);
      expect(PROMOTE_EDGE_FILE_STAGE_ID).toBe(STAGE_IDS.PROMOTE_EDGE_FILE);
      expect(PROMOTE_EDGE_PLACE_STAGE_ID).toBe(STAGE_IDS.PROMOTE_EDGE_PLACE);
    });

    it('derives versions that agree with STAGE_VERSIONS', () => {
      // The derivations throw at module load when the mirror disagrees; assert
      // the current values line up so a drift is also named here, in a spec.
      expect(STAGE_VERSIONS[STAGE_IDS.PROMOTE_EDGE_COMMUNICATION]).toBe(PROMOTE_EDGE_COMMUNICATION_VERSION);
      expect(STAGE_VERSIONS[STAGE_IDS.PROMOTE_EDGE_EVENT]).toBe(PROMOTE_EDGE_EVENT_VERSION);
      expect(STAGE_VERSIONS[STAGE_IDS.PROMOTE_EDGE_RECEIPT]).toBe(PROMOTE_EDGE_RECEIPT_VERSION);
      expect(STAGE_VERSIONS[STAGE_IDS.PROMOTE_EDGE_OBSERVATION]).toBe(PROMOTE_EDGE_OBSERVATION_VERSION);
      expect(STAGE_VERSIONS[STAGE_IDS.PROMOTE_EDGE_POSITION]).toBe(PROMOTE_EDGE_POSITION_VERSION);
      expect(STAGE_VERSIONS[STAGE_IDS.PROMOTE_EDGE_DEVICE]).toBe(PROMOTE_EDGE_DEVICE_VERSION);
      expect(STAGE_VERSIONS[STAGE_IDS.PROMOTE_EDGE_FILE]).toBe(PROMOTE_EDGE_FILE_VERSION);
      expect(STAGE_VERSIONS[STAGE_IDS.PROMOTE_EDGE_PLACE]).toBe(PROMOTE_EDGE_PLACE_VERSION);
    });

    it('sweeps every source table the matrix reads — a rule without a stage never runs', async () => {
      const stages = [
        new CommunicationEdgePromoteStage(makeService(), makeLogger()),
        new EventEdgePromoteStage(makeService(), makeLogger()),
        new ContentEdgePromoteStage(makeService(), makeLogger()),
        new InventoryEdgePromoteStage(makeService(), makeLogger()),
        new ReceiptEdgePromoteStage(makeService(), makeLogger()),
        new ObservationEdgePromoteStage(makeService(), makeLogger()),
        new PositionEdgePromoteStage(makeService(), makeLogger()),
        new DeviceEdgePromoteStage(makeService(), makeLogger()),
        new FileEdgePromoteStage(makeService(), makeLogger()),
        new PlaceEdgePromoteStage(makeService(), makeLogger()),
      ];

      // Recover each stage's sourceKind from the call it makes; compare the
      // set against the matrix's sources so adding a rule for a NEW table
      // fails here until a stage sweeps it.
      const sweptSources = new Set<string>();
      for (const stage of stages) {
        const service = makeService();
        const observed = new (stage.constructor as new (
          s: DeterministicEdgeBackfillService,
          l: never,
        ) => typeof stage)(service, makeLogger());
        await observed.run(CTX, ['probe-id']);
        sweptSources.add(service.materializeForSourceIds.mock.calls[0][1]);
      }

      const matrixSources = new Set(DETERMINISTIC_EDGE_RULES.map((rule) => rule.source));
      expect([...matrixSources].sort()).toEqual([...sweptSources].sort());
    });

    it('throws when a STAGE_VERSIONS mirror disagrees with the derivation', () => {
      expect(() =>
        promoteEdgeStageVersion(PROMOTE_EDGE_COMMUNICATION_STAGE_ID, PROMOTE_EDGE_COMMUNICATION_VERSION, {
          [PROMOTE_EDGE_COMMUNICATION_STAGE_ID]: PROMOTE_EDGE_COMMUNICATION_VERSION + 1,
        }),
      ).toThrow(/versions\.ts in the same commit/);
    });

    it('keeps the rule generation an integer >= 1 (versions.ts refuses less)', () => {
      expect(Number.isInteger(EDGE_PROJECTION_RULE_GENERATION)).toBe(true);
      expect(EDGE_PROJECTION_RULE_GENERATION).toBeGreaterThanOrEqual(1);
    });

    it('declares predicates over linkage INPUT columns only', () => {
      const comm = new CommunicationEdgePromoteStage(makeService(), makeLogger());
      const event = new EventEdgePromoteStage(makeService(), makeLogger());

      // The stage writes ci.relationships; its predicates must reference only
      // the columns its producers write, or the ratchet rebuilds itself.
      expect(comm.source.predicate).not.toMatch(/relationship/i);
      expect(event.source.predicate).not.toMatch(/relationship/i);
      expect(comm.source.table).toBe('communications');
      expect(event.source.table).toBe('events');
    });
  });

  describe('run', () => {
    it('projects the slice through the shared service and marks every id done', async () => {
      const service = makeService(() => Promise.resolve(7));
      const stage = new CommunicationEdgePromoteStage(service, makeLogger());

      const results = await stage.run(CTX, ['id-1', 'id-2']);

      expect(service.materializeForSourceIds).toHaveBeenCalledWith('user-1', 'communications', [
        'id-1',
        'id-2',
      ]);
      expect(results.get('id-1')).toEqual({ outcome: 'done' });
      expect(results.get('id-2')).toEqual({ outcome: 'done' });
    });

    it('routes the event leg to the events source', async () => {
      const service = makeService();
      const stage = new EventEdgePromoteStage(service, makeLogger());

      await stage.run(CTX, ['ev-1']);

      expect(service.materializeForSourceIds).toHaveBeenCalledWith('user-1', 'events', ['ev-1']);
    });

    it('marks the whole slice failed when the projection throws', async () => {
      const service = makeService(() => Promise.reject(new Error('connection reset')));
      const stage = new CommunicationEdgePromoteStage(service, makeLogger());

      const results = await stage.run(CTX, ['id-1', 'id-2']);

      for (const id of ['id-1', 'id-2']) {
        expect(results.get(id)).toEqual({
          outcome: 'failed',
          reason: 'edge_projection_failed',
          detail: { message: 'connection reset' },
        });
      }
    });

    it('does nothing for an empty slice', async () => {
      const service = makeService();
      const stage = new EventEdgePromoteStage(service, makeLogger());

      const results = await stage.run(CTX, []);

      expect(results.size).toBe(0);
      expect(service.materializeForSourceIds).not.toHaveBeenCalled();
    });
  });
});
