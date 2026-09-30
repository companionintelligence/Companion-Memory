import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { SOURCE_CHANGE_GRACE_SECONDS } from '../constants';
import { PipelineStateService } from '../services/PipelineStateService';
import {
  ENRICH_PERSON_SELF_CLAIM_STAGE_ID,
  PersonSelfClaimStage,
} from '../stages/enrich/PersonSelfClaimStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DECISION ABOUT A ROW THAT HAS SINCE CHANGED IS NOT A DECISION. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ONE RULE re-selects a decided row only when its stage's version moves.
 * `PipelineStateService.reopenChangedSources` is the second way back, for a
 * stage that declares `source.changedAtColumn`: a row whose source row was
 * stamped after it was decided goes back to `stage_version = 0`. Driven here
 * through the real ledger primitives — `claim`, the real
 * `enrich.person_self_claim` stage, `complete` — over real `ci.entities` rows,
 * because every property below is a comparison between two tables' timestamps:
 *
 *  1. a row changed after its decision is re-opened; one changed before it is
 *     not — except inside {@link SOURCE_CHANGE_GRACE_SECONDS}, where the change
 *     may have committed while the slice was running;
 *  2. `running`, `failed` and already-stale rows are left to their own arms,
 *     and another user's rows are not this user's to re-open;
 *  3. a second call re-opens nothing, and the re-run closes the loop: the
 *     Person is re-read, its stale claims retracted, and it is not re-found.
 *
 * Timestamps are SET, not waited for: every decision is placed two hours ago,
 * and each change is placed relative to it.
 *
 *   PIPELINE_TEST_DATABASE_URL=postgres://… yarn workspace @ci/be-api jest sourceChangeReopen.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/sourceChangeReopen.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const ENTITY_TYPE = 'Person';

describeWithDb(
  `a Person whose record changed after its decision is re-opened (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let stage: PersonSelfClaimStage;
    let state: PipelineStateService;

    const ctx = { userId: uuidv7() } as UserServiceContext;
    const other = { userId: uuidv7() } as UserServiceContext;

    async function insertPerson(
      owner: UserServiceContext,
      name: string,
      properties: Record<string, unknown>,
    ) {
      const id = uuidv7();

      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, properties)
       VALUES ($1::uuid, 'Person', $2, $3::uuid, $4::jsonb)`,
        [id, name, owner.userId, JSON.stringify(properties)],
      );

      return id;
    }

    /** One slice, the way `PipelineSliceListener` runs it. */
    async function decide(owner: UserServiceContext, ids: string[]): Promise<void> {
      const claimed = await state.claim(stage, ENTITY_TYPE, ids, owner.userId);
      const results = await stage.run(owner, claimed);

      await state.complete(stage, ENTITY_TYPE, results);
    }

    /** Move a decision (or any ledger row) to a fixed moment. */
    async function decidedAt(ids: string[], expression: string): Promise<void> {
      await dataSource.query(
        `UPDATE ci.pipeline_state SET updated_at = ${expression}
        WHERE entity_type = $1 AND stage = $2 AND entity_id = ANY($3::uuid[])`,
        [ENTITY_TYPE, ENRICH_PERSON_SELF_CLAIM_STAGE_ID, ids],
      );
    }

    /** Move a source row's change stamp to a fixed moment. */
    async function changedAt(ids: string[], expression: string): Promise<void> {
      await dataSource.query(
        `UPDATE ci.entities SET updated_at = ${expression} WHERE entity_id = ANY($1::uuid[])`,
        [ids],
      );
    }

    async function ledger(id: string): Promise<{ stage_version: number; status: string } | undefined> {
      const [row] = await dataSource.query<Array<{ stage_version: number; status: string }>>(
        `SELECT stage_version, status FROM ci.pipeline_state
        WHERE entity_type = $1 AND stage = $2 AND entity_id = $3::uuid`,
        [ENTITY_TYPE, ENRICH_PERSON_SELF_CLAIM_STAGE_ID, id],
      );

      return row;
    }

    function selfClaims(id: string): Promise<Array<{ kind: string; value_normalized: string }>> {
      return dataSource.query(
        `SELECT kind, value_normalized FROM ci.identifier_claims
        WHERE subject_type = 'person' AND role = 'self' AND subject_id = $1::uuid
        ORDER BY kind, value_normalized`,
        [id],
      );
    }

    beforeAll(async () => {
      const connection = resolveConnection({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });

      if (connection == null) {
        throw new Error('databaseAvailability passed but no connection resolved');
      }

      dataSource = new DataSource({
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
        entities: [],
      });
      await dataSource.initialize();

      schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/sourceChangeReopen.integration');

      for (const owner of [ctx, other]) {
        await dataSource.query(
          `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [owner.userId, 'Source change spec fixture', `sourcechange.${owner.userId}@example.invalid`],
        );
      }

      stage = new PersonSelfClaimStage(dataSource, new LoggerService());
      state = new PipelineStateService(dataSource, new LoggerService());
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        const owners = [ctx.userId, other.userId];

        await dataSource.query(
          `DELETE FROM ci.pipeline_state WHERE stage = $1 AND user_id = ANY($2::uuid[])`,
          [ENRICH_PERSON_SELF_CLAIM_STAGE_ID, owners],
        );
        await dataSource.query('DELETE FROM ci.identifier_claims WHERE owner_user_id = ANY($1::uuid[])', [
          owners,
        ]);
        await dataSource.query(
          'DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[]) AND merged_into_entity_id IS NOT NULL',
          [owners],
        );
        await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [owners]);
        await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [owners]);
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    it('declares the change stamp the re-open reads', () => {
      expect(stage.source.changedAtColumn).toBe('updated_at');
      // The grace is the claim lease: the longest a live slice can sit between
      // reading its rows and recording its answer.
      expect(SOURCE_CHANGE_GRACE_SECONDS).toBe(15 * 60);
    });

    it('re-opens the rows changed after their decision, re-runs them, and does not find them again', async () => {
      const edited = await insertPerson(ctx, 'Hana Ito', { phones: ['3035550111', '3035550112'] });
      const raced = await insertPerson(ctx, 'Omar Diaz', { emails: ['omar@example.com'] });
      const untouched = await insertPerson(ctx, 'Ruth Bell', { emails: ['ruth@example.com'] });
      const mergedAway = await insertPerson(ctx, 'Hana I', { phones: ['3035550111'] });
      const all = [edited, raced, untouched, mergedAway];

      await decide(ctx, all);
      await decidedAt(all, `now() - interval '2 hours'`);

      // Every row last changed long before its decision: the converged state.
      await changedAt(all, `now() - interval '1 day'`);

      await expect(state.reopenChangedSources(stage, ctx.userId)).resolves.toBe(0);
      await expect(state.selectStale(stage, ctx.userId, null, 100)).resolves.toEqual([]);

      // A re-import drops a number from Hana's card, an hour after the decision.
      await dataSource.query(
        `UPDATE ci.entities SET properties = '{"phones": ["3035550112"]}'::jsonb, updated_at = now() - interval '1 hour'
        WHERE entity_id = $1::uuid`,
        [edited],
      );
      // Omar's row was stamped five minutes BEFORE the decision — a writer whose
      // transaction began then and committed while the slice was running.
      await changedAt([raced], `now() - interval '2 hours 5 minutes'`);
      // Ruth's change is older than the grace: the decision really did see it.
      await changedAt([untouched], `now() - interval '2 hours 20 minutes'`);
      // Hana's duplicate is merged into her half an hour ago.
      await dataSource.query(
        `UPDATE ci.entities
          SET merged_into_entity_id = $2::uuid, is_active = FALSE, updated_at = now() - interval '30 minutes'
        WHERE entity_id = $1::uuid`,
        [mergedAway, edited],
      );

      await expect(state.reopenChangedSources(stage, ctx.userId)).resolves.toBe(3);

      expect(await ledger(edited)).toEqual({ stage_version: 0, status: 'done' });
      expect(await ledger(raced)).toEqual({ stage_version: 0, status: 'done' });
      expect(await ledger(mergedAway)).toEqual({ stage_version: 0, status: 'done' });
      expect(await ledger(untouched)).toEqual({ stage_version: stage.version, status: 'done' });

      // Already re-opened: a second call has nothing left to move.
      await expect(state.reopenChangedSources(stage, ctx.userId)).resolves.toBe(0);

      // THE ONE RULE now offers exactly those three, and nothing else.
      const stale = await state.selectStale(stage, ctx.userId, null, 100);

      expect([...stale].sort()).toEqual([edited, raced, mergedAway].sort());

      // The re-run reads the record as it is now …
      await decide(ctx, stale);

      expect(await selfClaims(edited)).toEqual([
        { kind: 'name', value_normalized: 'hana ito' },
        { kind: 'phone', value_normalized: '3035550112' },
      ]);
      expect(await selfClaims(mergedAway)).toEqual([]);
      expect(await ledger(mergedAway)).toEqual({ stage_version: stage.version, status: 'skipped' });

      // … and, decided after every change plus the grace, is not found again.
      await expect(state.reopenChangedSources(stage, ctx.userId)).resolves.toBe(0);
      await expect(state.selectStale(stage, ctx.userId, null, 100)).resolves.toEqual([]);
    });

    it('leaves running, failed and already-stale rows to their own arms', async () => {
      const running = await insertPerson(ctx, 'Ian Kerr', { emails: ['ian@example.com'] });
      const failed = await insertPerson(ctx, 'Jae Lim', { emails: ['jae@example.com'] });
      const belowVersion = await insertPerson(ctx, 'Kai Ono', { emails: ['kai@example.com'] });
      const rows = [running, failed, belowVersion];

      await decide(ctx, rows);

      // A live claim, a failure with its own retry gate, and a row an earlier
      // version decided — none of them is a decision this call may re-open.
      await dataSource.query(
        `UPDATE ci.pipeline_state
          SET status        = CASE entity_id WHEN $2::uuid THEN 'running' WHEN $3::uuid THEN 'failed' ELSE status END,
              reason        = CASE entity_id WHEN $3::uuid THEN 'stage_threw: boom' ELSE reason END,
              next_attempt_at = CASE entity_id WHEN $3::uuid THEN now() + interval '1 hour' ELSE next_attempt_at END,
              stage_version = CASE entity_id WHEN $4::uuid THEN $5::int - 1 ELSE stage_version END
        WHERE entity_type = 'Person' AND stage = $1 AND entity_id = ANY(ARRAY[$2, $3, $4]::uuid[])`,
        [ENRICH_PERSON_SELF_CLAIM_STAGE_ID, running, failed, belowVersion, stage.version],
      );
      await decidedAt(rows, `now() - interval '2 hours'`);
      await changedAt(rows, `now()`);

      const before = await Promise.all(rows.map((id) => ledger(id)));

      await expect(state.reopenChangedSources(stage, ctx.userId)).resolves.toBe(0);
      await expect(Promise.all(rows.map((id) => ledger(id)))).resolves.toEqual(before);
    });

    it("does not re-open another user's rows", async () => {
      const theirs = await insertPerson(other, 'Lea Moss', { emails: ['lea@example.com'] });

      await decide(other, [theirs]);
      await decidedAt([theirs], `now() - interval '2 hours'`);
      await changedAt([theirs], `now()`);

      await expect(state.reopenChangedSources(stage, ctx.userId)).resolves.toBe(0);
      expect(await ledger(theirs)).toEqual({ stage_version: stage.version, status: 'done' });

      await expect(state.reopenChangedSources(stage, other.userId)).resolves.toBe(1);
    });
  },
);
