import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { ValidationPipe } from '@ci/common/pipes';
import type { MaintenanceOrchestratorService, SearchIndexBackfillService } from '@ci/domains/maintenance';

import type { IngestStatusService } from '../../services/IngestStatusService';
import { ingestFinishSchema } from '../../types';
import { IngestLifecycleController } from '../IngestLifecycleController';

const ctx = { userId: 'user-1' } as RequestContext;

const orchestrateSummary = { ok: true, legs: [], totalDurationMs: 5 };
const backfillResult = { enqueued: 3, perType: {}, embedded: 0, embeddedPerType: {} };
const statusSnapshot = {
  tables: { communications: 1, events: 2, content: 3, inventory: 4, browser_activity: 5, position: 6 },
  searchIndex: { embeddingsByType: {}, skipsByType: {}, queue: { created: 0, active: 0, failed: 0 } },
  at: '2026-01-01T00:00:00.000Z',
};

function makeController() {
  const orchestrator = {
    orchestrate: jest.fn(async () => orchestrateSummary),
    isRunning: jest.fn(() => false),
  } as unknown as MaintenanceOrchestratorService;

  const backfill = {
    backfill: jest.fn(async () => backfillResult),
  } as unknown as SearchIndexBackfillService;

  const status = {
    snapshot: jest.fn(async () => statusSnapshot),
  } as unknown as IngestStatusService;

  return {
    controller: new IngestLifecycleController(orchestrator, backfill, status),
    orchestrator,
    backfill,
    status,
  };
}

describe('IngestLifecycleController', () => {
  describe('POST /v1/ingest/finish', () => {
    it('runs the full orchestration by default and returns its summary', async () => {
      const { controller, orchestrator, backfill } = makeController();

      const res = await controller.finish(ctx, {});

      expect(res).toBe(orchestrateSummary);
      expect(orchestrator.orchestrate).toHaveBeenCalledWith('user-1', { stages: undefined });
      expect(backfill.backfill).not.toHaveBeenCalled();
    });

    it('forwards a stage subset to the orchestrator', async () => {
      const { controller, orchestrator } = makeController();

      await controller.finish(ctx, { stages: ['link_communications', 'search_index'] });

      expect(orchestrator.orchestrate).toHaveBeenCalledWith('user-1', {
        stages: ['link_communications', 'search_index'],
      });
    });

    it('searchIndexOnly runs just the embed backfill sweep, bypassing the orchestrator', async () => {
      const { controller, orchestrator, backfill } = makeController();

      const res = await controller.finish(ctx, { searchIndexOnly: true });

      expect(res).toBe(backfillResult);
      expect(backfill.backfill).toHaveBeenCalledWith({ entityTypes: undefined });
      expect(orchestrator.orchestrate).not.toHaveBeenCalled();
    });

    it('scopes the searchIndexOnly sweep to the given entityTypes (#1671)', async () => {
      const { controller, backfill } = makeController();

      await controller.finish(ctx, {
        searchIndexOnly: true,
        entityTypes: ['communication', 'content'],
      });

      expect(backfill.backfill).toHaveBeenCalledWith({
        entityTypes: ['communication', 'content'],
      });
    });
  });

  describe('GET /v1/ingest/status', () => {
    it('delegates to IngestStatusService', async () => {
      const { controller, status } = makeController();

      await expect(controller.status()).resolves.toBe(statusSnapshot);
      expect(status.snapshot).toHaveBeenCalledTimes(1);
    });
  });
});

describe('finish body validation', () => {
  const pipe = new ValidationPipe(ingestFinishSchema);

  it('accepts an empty body, a stage subset, and searchIndexOnly', () => {
    expect(pipe.transform({})).toEqual({});
    expect(pipe.transform({ stages: ['search_index'] })).toEqual({ stages: ['search_index'] });
    expect(pipe.transform({ searchIndexOnly: true })).toEqual({ searchIndexOnly: true });
  });

  it('rejects an unknown stage name', () => {
    expect(() => pipe.transform({ stages: ['definitely_not_a_stage'] })).toThrow(BadRequestException);
  });

  it('rejects combining stages with searchIndexOnly (mutually exclusive)', () => {
    expect(() => pipe.transform({ stages: ['search_index'], searchIndexOnly: true })).toThrow(
      BadRequestException,
    );
    // searchIndexOnly: false is NOT the bypass, so stages may accompany it.
    expect(pipe.transform({ stages: ['search_index'], searchIndexOnly: false })).toEqual({
      stages: ['search_index'],
      searchIndexOnly: false,
    });
  });

  it('entityTypes rides searchIndexOnly only (#1671)', () => {
    expect(pipe.transform({ searchIndexOnly: true, entityTypes: ['communication'] })).toEqual({
      searchIndexOnly: true,
      entityTypes: ['communication'],
    });
    // Without the sweep there is nothing to scope — reject rather than ignore.
    expect(() => pipe.transform({ entityTypes: ['communication'] })).toThrow(BadRequestException);
    expect(() => pipe.transform({ stages: ['search_index'], entityTypes: ['communication'] })).toThrow(
      BadRequestException,
    );
    // Unknown types are a 400, same as the legacy maintenance route.
    expect(() => pipe.transform({ searchIndexOnly: true, entityTypes: ['not_a_type'] })).toThrow(
      BadRequestException,
    );
  });
});
