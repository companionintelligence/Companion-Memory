import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import {
  BlueBubblesAPIImporter,
  StagedWriter,
  type ImportRunService,
  type ImportScratchService,
  type MediaStage,
  type PushStage,
  type StagedCounts,
} from '@ci/domains/import';
import type { UserService } from '@ci/domains/user';

import type { BlueBubblesConfigEntity } from '../../entities/BlueBubblesConfigEntity';
import type { BlueBubblesConfigService } from '../BlueBubblesConfigService';
import { BlueBubblesSyncService } from '../BlueBubblesSyncService';

const CONFIG_ID = 'cfg-1';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const NEWEST_STAGED = new Date('2026-08-30T12:00:00.000Z');

const EMPTY_TOTALS: StagedCounts = {
  items: 0,
  itemsDeduped: 0,
  entities: 0,
  entitiesGrown: 0,
  relationships: 0,
  drops: {},
  keeps: {},
};

function config(overrides: Partial<BlueBubblesConfigEntity> = {}): BlueBubblesConfigEntity {
  return {
    id: CONFIG_ID,
    host: 'mac.local',
    port: 1234,
    useHttps: false,
    password: 'hunter2',
    hasPrivateApi: false,
    enabled: true,
    webhookSecret: 'secret',
    lastSyncCursor: null,
    lastWebhookReceivedAt: null,
    syncClaimToken: null,
    syncHeartbeatAt: null,
    connectionStatus: 'unknown',
    lastError: null,
    ownerUserId: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as BlueBubblesConfigEntity;
}

/**
 * The service with every collaborator faked, plus a shared ORDER LOG.
 *
 * The order log is the point: the finding this file exists for is not "the
 * cursor is wrong" but "the cursor moves at the wrong TIME", and only a
 * recorded sequence can state that.
 */
function harness(options: { stored?: BlueBubblesConfigEntity; claim?: boolean } = {}) {
  const calls: string[] = [];
  const stored = options.stored ?? config();

  const configService = {
    getOrCreate: jest.fn().mockResolvedValue(stored),
    claimSync: jest.fn().mockResolvedValue(options.claim ?? true),
    heartbeatSync: jest.fn().mockResolvedValue(undefined),
    releaseSync: jest.fn(async () => {
      calls.push('releaseSync');
    }),
    recordConnectionResult: jest.fn(async (_id: string, status: string) => {
      calls.push(`connection:${status}`);
    }),
    recordSyncCursor: jest.fn(async () => {
      calls.push('recordSyncCursor');
    }),
  } as unknown as jest.Mocked<BlueBubblesConfigService> & { [key: string]: jest.Mock };

  const importRunService = {
    createInProcessRun: jest.fn().mockResolvedValue({
      runId: RUN_ID,
      stages: [
        { id: 'stage-parse', kind: 'parse' },
        { id: 'stage-media', kind: 'media' },
        { id: 'stage-push', kind: 'push' },
      ],
    }),
    beginStage: jest.fn(async (stageId: string) => {
      calls.push(`begin:${stageId}`);

      return true;
    }),
    recordProgress: jest.fn().mockResolvedValue(undefined),
    completeStage: jest.fn(async (stageId: string) => {
      calls.push(`complete:${stageId}`);
    }),
    failStage: jest.fn(async (stageId: string) => {
      calls.push(`fail:${stageId}`);
    }),
    finishRun: jest.fn(async () => {
      calls.push('finishRun');
    }),
    hasUnstoredMedia: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<ImportRunService> & { [key: string]: jest.Mock };

  const mediaStage = {
    run: jest.fn(async () => {
      calls.push('mediaStage.run');

      return { processed: 0, total: 0, detail: {} };
    }),
  } as unknown as jest.Mocked<MediaStage> & { run: jest.Mock };

  const pushStage = {
    run: jest.fn(async () => {
      calls.push('pushStage.run');

      return { processed: 0, total: 0, detail: {} };
    }),
  } as unknown as jest.Mocked<PushStage> & { run: jest.Mock };

  const scratchService = {
    ensureDir: jest.fn().mockResolvedValue('/scratch/run'),
    reclaim: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<ImportScratchService> & { [key: string]: jest.Mock };

  const dataSource = {
    manager: {},
    query: jest.fn().mockResolvedValue([{ max: NEWEST_STAGED }]),
  } as unknown as DataSource & { query: jest.Mock };

  // The connector's recorded owner is live; `findById` is how the sync confirms that.
  const userService = {
    findById: jest.fn(async (_ctx: unknown, id: string) => (id === USER_ID ? { id } : null)),
  } as unknown as jest.Mocked<UserService> & { [key: string]: jest.Mock };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;

  const service = new BlueBubblesSyncService(
    dataSource,
    configService as unknown as BlueBubblesConfigService,
    importRunService as unknown as ImportRunService,
    scratchService as unknown as ImportScratchService,
    mediaStage as unknown as MediaStage,
    pushStage as unknown as PushStage,
    userService as unknown as UserService,
    logger,
  );

  return {
    service,
    calls,
    configService,
    userService,
    importRunService,
    mediaStage,
    pushStage,
    scratchService,
    dataSource,
    logger,
  };
}

/** Make `apiImport` a controllable stand-in, so no HTTP is involved. */
function stubImport(behaviour: () => Promise<void> = async () => {}): jest.SpyInstance {
  return jest.spyOn(BlueBubblesAPIImporter.prototype, 'apiImport').mockImplementation(behaviour);
}

/** Pretend the parse staged rows, without a real EntityManager behind the writer. */
function stubStaged(counts: Partial<StagedCounts>): void {
  jest.spyOn(StagedWriter.prototype, 'settled').mockResolvedValue(undefined);
  jest.spyOn(StagedWriter.prototype, 'totals', 'get').mockReturnValue({ ...EMPTY_TOTALS, ...counts });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('BlueBubblesSyncService.runSync', () => {
  it('advances the sync cursor only after the push has landed the rows', async () => {
    // The C1 incident: the cursor advanced BETWEEN parse and push. It is a
    // ratchet, so a push that then failed left those messages staged, never
    // written to ci.*, with every recovery path shut and the cursor already
    // past them.
    stubImport();

    const { service, calls, configService } = harness();

    await service.runSync();

    expect(calls.indexOf('recordSyncCursor')).toBeGreaterThan(calls.indexOf('pushStage.run'));
    expect(calls.indexOf('recordSyncCursor')).toBeLessThan(calls.indexOf('finishRun'));
    expect(configService.recordSyncCursor).toHaveBeenCalledWith(CONFIG_ID, NEWEST_STAGED);
  });

  it('leaves the cursor where it was when the push fails', async () => {
    stubImport();

    const { service, calls, configService, pushStage } = harness();

    pushStage.run.mockRejectedValue(new Error('ci.* is unreachable'));

    await service.runSync();

    expect(configService.recordSyncCursor).not.toHaveBeenCalled();
    expect(calls).toContain('fail:stage-push');
    expect(calls).not.toContain('finishRun');
    expect(configService.recordConnectionResult).toHaveBeenCalledWith(
      CONFIG_ID,
      'error',
      'ci.* is unreachable',
    );
  });

  it('fails the run and says so when the fetch dies before anything is staged', async () => {
    // The C2 incident: 167 runs marked `completed` with connectionStatus
    // 'connected' and lastError NULL, one of them over a 401.
    stubImport(async () => {
      throw new Error('BlueBubbles request failed: 401 Unauthorized');
    });

    const { service, calls, configService } = harness();

    await service.runSync();

    expect(calls).toContain('fail:stage-parse');
    expect(calls).not.toContain('pushStage.run');
    expect(calls).not.toContain('finishRun');
    expect(configService.recordConnectionResult).toHaveBeenCalledWith(
      CONFIG_ID,
      'error',
      expect.stringContaining('401'),
    );
    expect(configService.recordConnectionResult).not.toHaveBeenCalledWith(CONFIG_ID, 'connected', null);
  });

  it('pushes what a half-finished fetch staged, as a partial run that still reports the error', async () => {
    // The Mac dying at page 300 of 434. Those rows are real; the pass is not a
    // success, and the cursor may only advance over what actually landed.
    stubStaged({ items: 300, entities: 12 });
    stubImport(async () => {
      throw new Error('no response within 60s');
    });

    const { service, calls, importRunService, configService } = harness();

    await service.runSync();

    expect(calls).toContain('complete:stage-parse');
    expect(calls).toContain('pushStage.run');
    expect(importRunService.completeStage).toHaveBeenCalledWith(
      'stage-parse',
      expect.objectContaining({ partial: true, processed: 312 }),
    );
    expect(configService.recordConnectionResult).toHaveBeenCalledWith(
      CONFIG_ID,
      'error',
      'no response within 60s',
    );
    expect(configService.recordSyncCursor).toHaveBeenCalled();
  });

  it('reports a clean pass as connected with no error', async () => {
    stubImport();

    const { service, configService } = harness();

    await service.runSync();

    expect(configService.recordConnectionResult).toHaveBeenCalledWith(CONFIG_ID, 'connected', null);
  });

  it('runs the media stage, so attachments are actually stored', async () => {
    // MediaStage is the only writer of AttachmentFileIds, the only key
    // toCommunicationInput reads for attachments. Without it every BlueBubbles
    // attachment was downloaded, written to disk, and then never uploaded.
    stubImport();

    const { service, calls, importRunService } = harness();

    await service.runSync();

    expect(importRunService.createInProcessRun).toHaveBeenCalledWith(
      expect.objectContaining({ stages: ['parse', 'media', 'push'] }),
    );
    expect(calls.indexOf('mediaStage.run')).toBeGreaterThan(calls.indexOf('complete:stage-parse'));
    expect(calls.indexOf('mediaStage.run')).toBeLessThan(calls.indexOf('pushStage.run'));
  });

  it('stages attachments into the run scratch tree, never the OS temp dir', async () => {
    // /tmp is tmpfs on a stock appliance: a large backfill would consume RAM
    // until the machine died, and nothing sweeps it. MediaStage also refuses any
    // path outside the run's scratch directory.
    const apiImport = stubImport();
    const { service, scratchService } = harness();

    await service.runSync();

    expect(scratchService.ensureDir).toHaveBeenCalledWith(USER_ID, RUN_ID);
    expect(apiImport.mock.calls[0][1].mediaStoreDir).toBe('/scratch/run');
  });

  it('keeps the scratch tree when a staged row still has bytes nothing has stored', async () => {
    stubImport();

    const { service, importRunService, scratchService } = harness();

    importRunService.hasUnstoredMedia.mockResolvedValue(true);

    await service.runSync();

    expect(scratchService.reclaim).not.toHaveBeenCalled();
  });

  it('does nothing at all when the connector is not fully configured', async () => {
    // Not an error state: an appliance with a host and a port but no password
    // used to log at ERROR every ten minutes forever.
    const apiImport = stubImport();
    const { service, configService, logger } = harness({ stored: config({ password: '' }) });

    await service.runSync();

    expect(apiImport).not.toHaveBeenCalled();
    expect(configService.claimSync).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips the pass when another process already holds the sync claim', async () => {
    // The cron is registered in BOTH the api and the worker, and "Sync now"
    // adds callers on top: a per-instance flag guarded none of that.
    const apiImport = stubImport();
    const { service, importRunService } = harness({ claim: false });

    await service.runSync();

    expect(apiImport).not.toHaveBeenCalled();
    expect(importRunService.createInProcessRun).not.toHaveBeenCalled();
  });

  it('always hands the claim back, even when the pass throws', async () => {
    stubImport(async () => {
      throw new Error('boom');
    });

    const { service, calls, configService } = harness();

    await service.runSync();

    expect(configService.releaseSync).toHaveBeenCalledWith(CONFIG_ID, expect.any(String));
    expect(calls[calls.length - 1]).toBe('releaseSync');
  });
});

describe('BlueBubblesSyncService.ingestWebhookMessage', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces a burst into ONE run instead of one run per message', async () => {
    // Every delivery used to mint a full run: 2 stage rows, 4 rollups, a cursor
    // MAX(), a whole PushStage.run with its pg_database_size, and 3 pg-boss
    // sweep enqueues. A 1000-message burst was 1000 of those.
    stubStaged({ items: 5 });

    const { service, importRunService } = harness();

    for (let i = 0; i < 5; i += 1) {
      await service.ingestWebhookMessage({ guid: `live-${i}`, dateCreated: Date.now(), text: 'hi' });
    }

    await jest.advanceTimersByTimeAsync(5_000);

    expect(importRunService.createInProcessRun).toHaveBeenCalledTimes(1);
  });

  /**
   * The webhook path never authenticates OUTBOUND — the payload arrives in
   * hand, and the one call it does make (`downloadAttachments`) swallows its
   * own failures. Letting it report connection health re-opened exactly the
   * hole C2 closed: after a 401'd backfill left `error` + a reason on the
   * config row, a single inbound text stamped `connected` and cleared it, so
   * the UI claimed a working sync that was in fact being rejected. Rotate the
   * server password and that is the symptom you get.
   *
   * Inbound liveness is not lost — it has its own field,
   * `last_webhook_received_at`, written by the controller.
   */
  it('leaves the outbound connection status alone, having never tested it', async () => {
    stubStaged({ items: 1 });

    const errored = config({ connectionStatus: 'error', lastError: '401 Unauthorized' });
    const { service, configService } = harness({ stored: errored });

    await service.ingestWebhookMessage({ guid: 'live-1', dateCreated: Date.now(), text: 'hi' });
    await jest.advanceTimersByTimeAsync(5_000);

    expect(configService.recordConnectionResult).not.toHaveBeenCalled();
  });

  it('never lets a live message move the backfill cursor', async () => {
    // M7: recordSyncCursor is a ratchet, so one live text arriving before the
    // backfill has caught up would pin it at "now" and skip the entire history
    // behind it, forever, under a `completed` run with no error.
    stubStaged({ items: 1 });

    const { service, configService, importRunService } = harness();

    await service.ingestWebhookMessage({ guid: 'live-1', dateCreated: Date.now(), text: 'hi' });
    await jest.advanceTimersByTimeAsync(5_000);

    expect(importRunService.createInProcessRun).toHaveBeenCalled();
    expect(configService.recordSyncCursor).not.toHaveBeenCalled();
  });

  it('holds a flush back rather than pushing alongside a running backfill', async () => {
    stubStaged({ items: 1 });

    const { service, configService, importRunService } = harness({ claim: false });

    await service.ingestWebhookMessage({ guid: 'live-1', dateCreated: Date.now(), text: 'hi' });
    await jest.advanceTimersByTimeAsync(5_000);

    expect(importRunService.createInProcessRun).not.toHaveBeenCalled();

    // The batch is kept, not dropped: once the claim frees up it lands.
    configService.claimSync.mockResolvedValue(true);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(importRunService.createInProcessRun).toHaveBeenCalledTimes(1);
  });
});

/**
 * Whose memory the messages go into. This used to be "the first onboarded account", read on every
 * pass, which is not necessarily the person whose Mac it is. It is now the connector's recorded
 * owner, the same account the `messaging.*` tools serve.
 */
describe('BlueBubblesSyncService attribution', () => {
  const OTHER_USER = '33333333-3333-4333-8333-333333333333';

  it("files the pass under the connector's recorded owner", async () => {
    stubImport();

    const { service, importRunService, userService } = harness({ stored: config({ ownerUserId: USER_ID }) });

    await service.runSync();

    expect(userService.findById).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(importRunService.createInProcessRun).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
    );
  });

  it.each([
    ['has no recorded owner', null],
    ["owner's account no longer exists", OTHER_USER],
  ])('ingests nothing when the connector %s', async (_label, ownerUserId) => {
    stubImport();

    const { service, importRunService, logger } = harness({ stored: config({ ownerUserId }) });

    await service.runSync();

    expect(importRunService.createInProcessRun).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'BlueBubbles ingest skipped: the connector has no live owner to attribute messages to',
    );
  });
});
