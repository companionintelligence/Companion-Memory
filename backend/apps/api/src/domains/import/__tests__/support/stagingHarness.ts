import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { DataSource } from 'typeorm';

import type { EventService } from '@ci/domains/events';
import { EntityIdentifierEntity, NodeEntity, RelationshipEntity } from '@ci/domains/graph';

import { SYNTHETIC_TEST_USER_DOMAIN, syntheticTestUserEmail } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock } from '../../../__tests__/support/schemaLock';
import type { ImportStageKindName } from '../../constants';
import { EntityMappingEntity } from '../../entities/EntityMappingEntity';
import { ImportRunEntity } from '../../entities/ImportRunEntity';
import { ImportStageEntity } from '../../entities/ImportStageEntity';
import { StagedEntityEntity } from '../../entities/StagedEntityEntity';
import { StagedItemEntity } from '../../entities/StagedItemEntity';
import { StagedRelationshipEntity } from '../../entities/StagedRelationshipEntity';
import { StagedSourceEntity } from '../../entities/StagedSourceEntity';
import { ImportRunService, type StartRunResult } from '../../services/ImportRunService';
import { StagedSourceService } from '../../services/StagedSourceService';
import { userInboxDir } from '../../sources/importRoots';
import { StagedWriter } from '../../staging/StagedWriter';

/**
 * Shared setup for the specs that write real `ci_import` rows.
 *
 * Every one of them needs the same four things — a DataSource, the schema
 * present, a drop to start a run against, and cleanup that respects the
 * cascade — and a second copy of that boilerplate is a second place for the
 * isolation rules to drift.
 *
 * ## Isolation
 *
 * Each harness mints its own user id, so concurrent suites cannot see each
 * other's rows. Cleanup deletes the runs, which CASCADEs every `staged_*` row
 * by design, then the drops — `staged_sources.run_id` is ON DELETE SET NULL
 * precisely so deleting a run cannot orphan stored bytes, which means the drop
 * rows outlive their runs and have to go explicitly.
 */

/** Suite-specific override so this work can be pointed at a scratch database. */
export const IMPORT_DATABASE_ENV = {
  urlEnvVar: 'IMPORT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'IMPORT_TEST_PROBE_TIMEOUT_MS',
};

/** Whether these specs can run at all. Consulted at collection time. */
export const importDatabase = databaseAvailability(IMPORT_DATABASE_ENV);

/**
 * Remove the inbox folder the appliance scaffolds for a synthetic user.
 *
 * These suites never touch the real inbox themselves, but the API does it for
 * them: it provisions `<inboxRoot>/<user id>` for EVERY `ci.users` row — at boot
 * and on user-created events (`ImportInboxService.onModuleInit`,
 * `InboxProvisionListener`) — so a dev server running alongside a test run
 * scaffolds folders for the harness's users. Deleting the row does not delete
 * the folder, and that litter accumulated in the real inbox until teardown
 * learned to sweep it. Best-effort by nature: the folder only exists if the
 * server provisioned while the row did, and a server that boots mid-teardown
 * can still recreate it a beat later.
 *
 * Takes the id (the folder is keyed on it now) and the email, and refuses a
 * non-synthetic address: this is a recursive delete under a shared mount whose
 * other folders are real accounts' drop targets.
 */
export async function removeSyntheticUserInbox(userId: string, email: string): Promise<void> {
  if (!email.endsWith(`@${SYNTHETIC_TEST_USER_DOMAIN}`)) {
    throw new Error(`Refusing to remove the inbox folder of a non-synthetic address: ${email}`);
  }

  await rm(userInboxDir(userId), { recursive: true, force: true });
}

export interface StagingHarness {
  dataSource: DataSource;
  service: ImportRunService;
  stagedSources: StagedSourceService;
  /**
   * Records what {@link ImportRunService} enqueued, in place of a real queue —
   * unless the suite handed the harness a real event service, in which case
   * this stub is unused.
   */
  events: { send: jest.Mock; getJob: jest.Mock; failJob: jest.Mock };
  userId: string;
  /** Stage a drop the way the upload endpoint would, and return its dropId. */
  stageDrop(filename?: string): Promise<string>;
  /** Start a run against a fresh drop and return its id. */
  startRun(filename?: string): Promise<string>;
  /**
   * Start a run against an existing drop, registering it for cleanup.
   *
   * Callers that reach for `service.startRun` directly leak their run past
   * teardown, so anything that needs the full result goes through here.
   */
  startRunForDrop(dropId: string, stages?: readonly ImportStageKindName[]): Promise<StartRunResult>;
  /** A writer scoped to a fresh run. */
  writerFor(dataSourceName: string): Promise<{ writer: StagedWriter; runId: string }>;
}

/**
 * Connect, verify the schema, and hand back the pieces plus a teardown.
 *
 * A reachable database MISSING `ci_import` fails loudly, naming the command that
 * fixes it: a missing migration must never read as a passing test.
 *
 * `eventService` swaps the queue stub for a real one — the orphan-recovery
 * spec hands in a `PGBossEventService` on a private pg-boss schema, because
 * what it asserts is pg-boss's own behaviour. Everything else stays shared,
 * cleanup included.
 */
export async function createStagingHarness(options: { eventService?: EventService } = {}): Promise<{
  harness: StagingHarness;
  teardown: () => Promise<void>;
}> {
  const connection = resolveConnection(IMPORT_DATABASE_ENV);

  if (connection == null) {
    throw new Error('availability said yes but no connection resolved');
  }

  const dataSource = new DataSource({
    type: 'postgres',
    ...(connection.url != null
      ? { url: connection.url }
      : {
          host: connection.host,
          port: connection.port,
          username: connection.username,
          password: connection.password,
          database: connection.database,
        }),
    entities: [
      // The graph entities are registered so a spec can run a REAL
      // GraphIngestService against this connection. The entity lane's identity
      // rules live in the server, not in the importer, and a mocked stand-in is
      // exactly what hid a handle being written into a uuid column.
      EntityIdentifierEntity,
      NodeEntity,
      RelationshipEntity,
      EntityMappingEntity,
      ImportRunEntity,
      ImportStageEntity,
      StagedSourceEntity,
      StagedEntityEntity,
      StagedItemEntity,
      StagedRelationshipEntity,
    ],
    synchronize: false,
    extra: { options: '-c search_path=ci,public' },
  });

  await dataSource.initialize();

  // SHARED, held for the life of the harness. This harness commits real
  // `ci.entities` / `ci.entity_identifiers` / `ci.users` rows and deletes them
  // again, which is the DML half of the deadlock documented in
  // `__tests__/support/schemaLock.ts`. Shared holders never block each other,
  // so the several import suites using this harness stay as parallel as they
  // were; they now only ever wait on a suite that is applying a migration.
  const schemaLock = await acquireSchemaWriteLock(dataSource, 'import staging harness');

  const [{ present }] = await dataSource.query<Array<{ present: boolean }>>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'ci_import') AS present`,
  );

  if (!present) {
    await dataSource.destroy();

    throw new Error(
      'The ci_import schema is missing from this database. Run `yarn workspace @ci/be-api migrate` ' +
        'before this suite — a missing migration must not read as a passing test.',
    );
  }

  const stubLogger = () =>
    ({
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }) as never;

  const events = {
    send: jest.fn(async () => undefined),
    // This stub has no queue, so it cannot say what became of a job — and it
    // REFUSES to, rather than answering "no such job". The difference matters
    // because every suite on this database shares one appliance-wide sweep:
    // `reclaimOrphanedStages` asks about a stage's job before it touches the
    // stage, and "no such job" would send a sibling suite's sweep off to
    // re-queue a stage that the orphan-recovery spec is holding against a REAL
    // pg-boss. A refusal is caught and logged per stage, and leaves it alone.
    getJob: jest.fn(async () => {
      throw new Error('the staging harness has no queue to look a job up in');
    }),
    failJob: jest.fn(async () => false),
  };
  // A REAL StagedSourceService over the same connection: the spine specs assert
  // claim/consume/release transitions, and a mock would agree with whatever
  // the spec author believed.
  const stagedSources = new StagedSourceService(dataSource.getRepository(StagedSourceEntity), stubLogger());
  const service = new ImportRunService(
    dataSource,
    (options.eventService ?? events) as never,
    stagedSources,
    stubLogger(),
  );

  const userId = randomUUID();
  const userEmail = syntheticTestUserEmail('import-harness', userId);
  const createdRuns: string[] = [];
  const createdDrops: string[] = [];

  // A REAL `ci.users` row, not just a uuid.
  //
  // Nothing in `ci_import` references the user, so a bare uuid was enough for as
  // long as these specs stayed inside the staging schema. The push stage leaves
  // it: `ci.entities.owner_user_id` carries a foreign key, and every entity a
  // run resolves fails on it if the owner does not exist.
  await dataSource.query(
    `INSERT INTO ci.users (id, name, email) VALUES ($1::uuid, 'import harness', $2)
     ON CONFLICT (id) DO NOTHING`,
    // The email is the marker that keeps other suites off this row while it
    // exists — see `__tests__/support/applianceUser.ts`, which owns both halves.
    [userId, userEmail],
  );

  const stageDrop = async (filename = 'export.zip'): Promise<string> => {
    const dropId = randomUUID();

    // A fabricated source_path is fine here: these specs exercise the claim
    // SQL and the run spine, never the filesystem. Suites that need real
    // bytes (stagedSourceSpine) seed their own tmp uploads dir instead.
    await dataSource.query(
      `INSERT INTO ci_import.staged_sources
         (user_id, origin, drop_id, source_path, kind, original_filename, status, expires_at)
       VALUES ($1::uuid, 'upload', $2, $3, 'file', $4, 'staged', now() + interval '1 day')`,
      [userId, dropId, `/nonexistent/uploads/${dropId}/${filename}`, filename],
    );

    createdDrops.push(dropId);

    return dropId;
  };

  const startRunForDrop = async (
    dropId: string,
    stages?: readonly ImportStageKindName[],
  ): Promise<StartRunResult> => {
    const result = await service.startRun({ userId }, { dropId, stages });

    createdRuns.push(result.run.id);

    return result;
  };

  const startRun = async (filename?: string): Promise<string> => {
    const { run } = await startRunForDrop(await stageDrop(filename));

    return run.id;
  };

  const harness: StagingHarness = {
    dataSource,
    service,
    stagedSources,
    events,
    userId,
    stageDrop,
    startRun,
    startRunForDrop,
    writerFor: async (dataSourceName: string) => {
      const runId = await startRun();

      return {
        runId,
        writer: new StagedWriter(dataSource.manager, { userId, runId, dataSource: dataSourceName }),
      };
    },
  };

  const teardown = async (): Promise<void> => {
    if (!dataSource.isInitialized) {
      return;
    }

    // ── Why every step runs even after one of them fails ──────────────────
    //
    // This used to be a straight sequence, and the `ci.users` delete was last.
    // One failing statement anywhere above it — a run that would not delete, a
    // connection that blipped — therefore leaked the harness's user row into
    // the appliance's `ci.users`, permanently, wearing an @example.invalid
    // address nobody would recognise. Two such rows were found in the dev
    // database, and while they own nothing, they are what the specs that pick
    // a user with `LIMIT 1` could latch onto.
    //
    // So the steps are independent and the failures accumulate: whatever else
    // goes wrong, the user row is still attempted, and the first error is
    // rethrown afterwards so a broken teardown is still LOUD rather than
    // swallowed.
    const failures: unknown[] = [];

    const attempt = async (sql: string, params: unknown[]): Promise<void> => {
      try {
        await dataSource.query(sql, params);
      } catch (err: unknown) {
        failures.push(err);
      }
    };

    for (const runId of createdRuns) {
      await attempt(`DELETE FROM ci_import.import_runs WHERE id = $1::uuid`, [runId]);
    }

    for (const dropId of createdDrops) {
      await attempt(`DELETE FROM ci_import.staged_sources WHERE user_id = $1::uuid AND drop_id = $2`, [
        userId,
        dropId,
      ]);
    }

    // Whatever the push stage resolved into `ci.*` belongs to this harness user
    // alone, so it goes with them. Entities before identifiers and the user
    // last: both reference what precedes them.
    await attempt(`DELETE FROM ci.entity_identifiers WHERE owner_user_id = $1::uuid`, [userId]);
    await attempt(`DELETE FROM ci.entities WHERE owner_user_id = $1::uuid`, [userId]);
    await attempt(`DELETE FROM ci.users WHERE id = $1::uuid`, [userId]);

    // The row is gone; the inbox folder a running server scaffolded for it is
    // not, and nothing else will ever remove it (see removeSyntheticUserInbox).
    try {
      await removeSyntheticUserInbox(userId, userEmail);
    } catch (err: unknown) {
      failures.push(err);
    }

    // Before `destroy()`, and before the rethrow: a lock this harness failed to
    // release would stall every DDL suite for LOCK_TIMEOUT_MS.
    await schemaLock.release();

    await dataSource.destroy();

    if (failures.length > 0) {
      throw failures[0];
    }
  };

  return { harness, teardown };
}
