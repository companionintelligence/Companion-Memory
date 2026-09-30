import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { DuplicateDetectStage } from '../clean/DuplicateDetectStage';
import {
  ENRICH_PERSON_SELF_CLAIM_STAGE_ID,
  PERSON_SELF_CLAIM_GENERATION,
  PersonSelfClaimStage,
} from '../enrich/PersonSelfClaimStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SELF CLAIM LIVES EXACTLY AS LONG AS THE RECORD SAYS IT. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The stage's one statement is an upsert and a DELETE as sibling CTEs. Which
 * rows the DELETE takes is decided by six predicates and a NOT EXISTS against
 * the upsert's own input, and a fake `DataSource` agrees with whatever the
 * statement says — so every property below is a property of ROWS:
 *
 *  1. a value the record no longer yields loses its claim, and nothing else
 *     does — not the values it still yields (updated in place, same
 *     `claim_id`), not another Person's claim on the same number, not a claim
 *     `enrich.person_link` wrote because a message resolved to this Person,
 *     not a self claim some other producer wrote;
 *  2. a claim a human DISPOSED survives the value leaving the record;
 *  3. a Person merged away, edited down to nothing, or deleted keeps none;
 *  4. a second run over an unchanged record changes nothing;
 *  5. end to end: the stale claim is what made `clean.duplicate_detect`
 *     re-propose a pair the review queue had retired, and once it is
 *     retracted the pair stays retired.
 *
 * Opt-in like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a database with the migrations applied. The suite
 * SKIPS legibly when nothing is reachable.
 *
 *   PIPELINE_TEST_DATABASE_URL=postgres://… yarn workspace @ci/be-api jest PersonSelfClaimStage.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/PersonSelfClaimStage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

interface ClaimRow {
  claim_id: string;
  subject_type: string;
  subject_id: string;
  role: string;
  kind: string;
  value_normalized: string;
  value_e164: string | null;
  raw_value: string | null;
  entity_id: string | null;
  confidence: number | null;
  method: string | null;
  stage: string | null;
  spec_version: number;
  disposition: string | null;
  observed_at: Date;
}

describeWithDb(
  `enrich.person_self_claim keeps self claims in step with the record (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let stage: PersonSelfClaimStage;

    const ctx = { userId: uuidv7() } as UserServiceContext;

    async function insertPerson(
      name: string | null,
      properties: Record<string, unknown>,
      options: { id?: string } = {},
    ): Promise<string> {
      const id = options.id ?? uuidv7();

      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, properties)
       VALUES ($1::uuid, 'Person', $2, $3::uuid, $4::jsonb)`,
        [id, name, ctx.userId, JSON.stringify(properties)],
      );

      return id;
    }

    /** What a re-import, a merge or an edit does to the row — including the stamp. */
    async function rewriteRecord(id: string, name: string | null, properties: Record<string, unknown>) {
      await dataSource.query(
        `UPDATE ci.entities SET name = $2, properties = $3::jsonb, updated_at = now() WHERE entity_id = $1::uuid`,
        [id, name, JSON.stringify(properties)],
      );
    }

    function claimsOf(subjectId: string): Promise<ClaimRow[]> {
      return dataSource.query(
        `SELECT claim_id, subject_type, subject_id, role, kind, value_normalized, value_e164, raw_value,
              entity_id, confidence, method, stage, spec_version, disposition, observed_at
         FROM ci.identifier_claims
        WHERE owner_user_id = $1::uuid AND subject_id = $2::uuid
        ORDER BY kind, value_normalized, role`,
        [ctx.userId, subjectId],
      );
    }

    /** Sorted in JS: `ORDER BY` follows the database's collation, which need not be C. */
    function selfValues(rows: ClaimRow[]): string[] {
      return rows
        .filter((row) => row.subject_type === 'person' && row.role === 'self')
        .map((row) => `${row.kind}:${row.value_normalized}`)
        .sort();
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

      schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/PersonSelfClaimStage.integration');

      await dataSource.query(
        `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [ctx.userId, 'Self claim spec fixture', `selfclaim.${ctx.userId}@example.invalid`],
      );

      stage = new PersonSelfClaimStage(dataSource, new LoggerService());
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await dataSource.query('DELETE FROM ci.merge_candidates WHERE owner_user_id = $1', [ctx.userId]);
        await dataSource.query('DELETE FROM ci.identifier_claims WHERE owner_user_id = $1', [ctx.userId]);
        await dataSource.query(
          `DELETE FROM ci.entities WHERE owner_user_id = $1 AND merged_into_entity_id IS NOT NULL`,
          [ctx.userId],
        );
        await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
        await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    it('asserts what the record yields, as self-asserted claims on the Person itself', async () => {
      const ann = await insertPerson('Ann Lee', {
        emails: ['Ann@Example.com'],
        phones: ['+1 (303) 517-6726'],
      });

      const results = await stage.run(ctx, [ann]);

      expect(results.get(ann)).toEqual({ outcome: 'done', detail: { claims: 3, retracted: 0 } });

      const rows = await claimsOf(ann);

      expect(selfValues(rows)).toEqual(['email:ann@example.com', 'name:ann lee', 'phone:3035176726']);

      for (const row of rows) {
        expect(row).toEqual(
          expect.objectContaining({
            entity_id: ann,
            method: 'self_asserted',
            stage: ENRICH_PERSON_SELF_CLAIM_STAGE_ID,
            spec_version: PERSON_SELF_CLAIM_GENERATION,
            disposition: null,
          }),
        );
        expect(Number(row.confidence)).toBe(1);
      }

      expect(rows.find((row) => row.kind === 'phone')).toEqual(
        expect.objectContaining({ value_e164: '+13035176726', raw_value: '+1 (303) 517-6726' }),
      );
    });

    it('retracts a number the record dropped, and nothing else', async () => {
      const ann = await insertPerson('Ann Lee', {
        emails: ['ann@example.com'],
        phones: ['3035176726', '7205550100'],
      });
      const bob = await insertPerson('Bob Stone', { phones: ['3035176726'] });

      await stage.run(ctx, [ann, bob]);

      // Evidence ANOTHER stage wrote about this Person: a message whose sender
      // resolved to Ann by the same number. It is a fact about the message and
      // must outlive the number leaving Ann's card.
      const message = uuidv7();

      await dataSource.query(
        `INSERT INTO ci.identifier_claims
              (owner_user_id, subject_type, subject_id, role, kind, value_normalized,
               entity_id, confidence, method, stage, spec_version)
       VALUES ($1::uuid, 'communication', $2::uuid, 'from', 'phone', '3035176726',
               $3::uuid, 0.9, 'phone_last10', 'enrich.person_link', 2)`,
        [ctx.userId, message, ann],
      );

      // A self claim some OTHER producer wrote (the migration reserves the shape
      // for a contact importer). Not this stage's to retract.
      await dataSource.query(
        `INSERT INTO ci.identifier_claims
              (owner_user_id, subject_type, subject_id, role, kind, value_normalized,
               entity_id, confidence, method, stage, spec_version)
       VALUES ($1::uuid, 'person', $2::uuid, 'self', 'email', 'ann.old@example.com',
               $2::uuid, 1.0, 'self_asserted', 'import:vcard', 1)`,
        [ctx.userId, ann],
      );

      const before = await claimsOf(ann);
      const keptBefore = before.filter(
        (row) => row.kind !== 'phone' || row.value_normalized === '7205550100',
      );

      // A re-import rewrites the card from the source, which no longer lists
      // the first number.
      await rewriteRecord(ann, 'Ann Lee', { emails: ['ann@example.com'], phones: ['7205550100'] });

      const results = await stage.run(ctx, [ann]);

      expect(results.get(ann)).toEqual({ outcome: 'done', detail: { claims: 3, retracted: 1 } });
      expect(selfValues(await claimsOf(ann))).toEqual([
        'email:ann.old@example.com',
        'email:ann@example.com',
        'name:ann lee',
        'phone:7205550100',
      ]);

      // The survivors were refreshed IN PLACE — same rows, not deleted and
      // re-inserted — which is what keeps a claim's history (and any id held
      // elsewhere) stable across runs.
      const after = await claimsOf(ann);

      expect(after.map((row) => row.claim_id).sort()).toEqual(keptBefore.map((row) => row.claim_id).sort());

      // Bob still holds the number, and so does the message's claim about Ann.
      expect(selfValues(await claimsOf(bob))).toEqual(['name:bob stone', 'phone:3035176726']);
      expect(await claimsOf(message)).toEqual([
        expect.objectContaining({
          role: 'from',
          kind: 'phone',
          value_normalized: '3035176726',
          entity_id: ann,
        }),
      ]);
    });

    it('never retracts a claim a human disposed, even when the record stops yielding it', async () => {
      const cleo = await insertPerson('Cleo Park', {
        emails: ['cleo@example.com', 'shared-desk@example.com'],
        phones: ['4155550199'],
      });

      await stage.run(ctx, [cleo]);

      await dataSource.query(
        `UPDATE ci.identifier_claims
          SET disposition = CASE kind WHEN 'email' THEN 'rejected' ELSE 'confirmed' END,
              disposed_at = now()
        WHERE subject_id = $1::uuid
          AND (value_normalized = 'shared-desk@example.com' OR kind = 'phone')`,
        [cleo],
      );

      await rewriteRecord(cleo, 'Cleo Park', { emails: ['cleo@example.com'] });

      const results = await stage.run(ctx, [cleo]);

      // Nothing undisposed left the record, so nothing was retracted — and both
      // human verdicts are still on the table to be honoured next time.
      expect(results.get(cleo)).toEqual({ outcome: 'done', detail: { claims: 2, retracted: 0 } });

      const rows = await claimsOf(cleo);

      expect(rows.map((row) => `${row.kind}:${row.value_normalized}:${row.disposition}`).sort()).toEqual([
        'email:cleo@example.com:null',
        'email:shared-desk@example.com:rejected',
        'name:cleo park:null',
        'phone:4155550199:confirmed',
      ]);
    });

    it('keeps no claims for a Person merged away, and answers skipped: merged', async () => {
      const target = await insertPerson('Dana Ruiz', { phones: ['6175550123'] });
      const dup = await insertPerson('Dana R', { phones: ['6175550123'], emails: ['dana.r@example.com'] });

      await stage.run(ctx, [target, dup]);
      expect(selfValues(await claimsOf(dup))).toHaveLength(3);

      // What PersonMergeService does to a source: tombstone it, bump the stamp.
      await dataSource.query(
        `UPDATE ci.entities
          SET merged_into_entity_id = $2::uuid, is_active = FALSE, updated_at = now()
        WHERE entity_id = $1::uuid`,
        [dup, target],
      );

      const results = await stage.run(ctx, [dup]);

      expect(results.get(dup)).toEqual({ outcome: 'skipped', reason: 'merged', detail: { retracted: 3 } });
      expect(await claimsOf(dup)).toEqual([]);

      // The target still holds the number. A tombstone holding it too would
      // have counted as a second holder in every group-size cap.
      expect(selfValues(await claimsOf(target))).toEqual(['name:dana ruiz', 'phone:6175550123']);
    });

    it('retracts everything from a record edited down to nothing', async () => {
      const eli = await insertPerson('Eli Moss', { emails: ['eli@example.com'] });

      await stage.run(ctx, [eli]);
      await rewriteRecord(eli, null, {});

      const results = await stage.run(ctx, [eli]);

      expect(results.get(eli)).toEqual({ outcome: 'done', detail: { claims: 0, retracted: 2 } });
      expect(await claimsOf(eli)).toEqual([]);
    });

    it('retracts the claims of a Person deleted between the sweep and the slice', async () => {
      const fay = await insertPerson('Fay Wong', { emails: ['fay@example.com'] });

      await stage.run(ctx, [fay]);
      await dataSource.query(`DELETE FROM ci.entities WHERE entity_id = $1::uuid`, [fay]);

      const results = await stage.run(ctx, [fay]);

      expect(results.get(fay)).toEqual({
        outcome: 'skipped',
        reason: 'source_row_missing',
        detail: { retracted: 2 },
      });
      expect(await claimsOf(fay)).toEqual([]);
    });

    it('is idempotent — a second run over an unchanged record retracts nothing and keeps every row', async () => {
      const gus = await insertPerson('Gus Hall', { emails: ['gus@example.com'], phones: ['2125550142'] });

      await stage.run(ctx, [gus]);
      const first = await claimsOf(gus);

      const results = await stage.run(ctx, [gus]);
      const second = await claimsOf(gus);

      expect(results.get(gus)).toEqual({ outcome: 'done', detail: { claims: 3, retracted: 0 } });
      expect(second.map((row) => row.claim_id)).toEqual(first.map((row) => row.claim_id));

      // Re-observed, not merely left alone.
      for (const [index, row] of second.entries()) {
        expect(row.observed_at.getTime()).toBeGreaterThanOrEqual(first[index].observed_at.getTime());
      }
    });

    /**
     * The reported defect, end to end. Two people whose cards shared a number;
     * a re-import drops it from one card. The review queue retires the pair
     * (the branch that re-checks phone evidence against live records DELETEs a
     * pending row nothing supports any more) — and the next duplicate-detect
     * run, the one a scoring-generation bump triggers, proposes it again from
     * the stale self claim. Retracting the claim is what ends the loop.
     */
    it('stops clean.duplicate_detect re-proposing a retired pair from a number neither card carries', async () => {
      const detector = new DuplicateDetectStage(dataSource, new LoggerService());
      const ivy = await insertPerson('Ivy Nakamura', { phones: ['5035550187'] });
      const jon = await insertPerson('Jon Petrakis', { phones: ['5035550187'] });
      const [a, b] = ivy < jon ? [ivy, jon] : [jon, ivy];

      const pendingPair = async () =>
        (
          await dataSource.query<Array<{ evidence: Array<{ kind: string; value: string }> }>>(
            `SELECT evidence FROM ci.merge_candidates
            WHERE owner_user_id = $1::uuid AND entity_id_a = $2::uuid AND entity_id_b = $3::uuid
              AND status = 'pending'`,
            [ctx.userId, a, b],
          )
        )[0] ?? null;

      const retire = () =>
        dataSource.query(
          `DELETE FROM ci.merge_candidates
          WHERE owner_user_id = $1::uuid AND entity_id_a = $2::uuid AND entity_id_b = $3::uuid`,
          [ctx.userId, a, b],
        );

      await stage.run(ctx, [ivy, jon]);
      await detector.run(ctx, [ivy, jon]);

      // Both cards carry the number: a legitimate proposal.
      expect(await pendingPair()).not.toBeNull();

      await rewriteRecord(jon, 'Jon Petrakis', { phones: ['9715550166'] });
      await retire();

      // THE DEFECT, reproduced: until the self claims are reconciled, Jon's
      // stale claim on the old number still carries the pair.
      await detector.run(ctx, [ivy, jon]);
      const reproposed = await pendingPair();

      expect(reproposed?.evidence).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'phone', value: '5035550187' })]),
      );

      await retire();

      // THE FIX: the next pass over Jon retracts the claim …
      const results = await stage.run(ctx, [jon]);

      expect(results.get(jon)).toEqual({ outcome: 'done', detail: { claims: 2, retracted: 1 } });

      // … and the next detector run has nothing to propose the pair on.
      await detector.run(ctx, [ivy, jon]);

      expect(await pendingPair()).toBeNull();
    });
  },
);
