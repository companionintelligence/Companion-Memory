import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { STAGE_IDS } from '../constants';
import { PipelineStateService } from '../services/PipelineStateService';
import { DuplicateDetectStage } from '../stages/clean/DuplicateDetectStage';
import { stageVersion } from '../versions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PRE-FIX MERGE'S EVIDENCE REACHES ITS SURVIVOR, AND ITS "NO" GOES FIRST.
 * IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Until 2026-09-29 a Person merge left the source's `ci.identifier_claims` and
 * `ci.entity_merge_blocks` on the tombstone. {@link MIGRATION} carries both for
 * every merge already made, and re-opens the duplicate detector for each
 * survivor that gained claims.
 *
 * The pre-fix state is built by hand rather than by calling
 * `PersonMergeService`, because once the fix lands the real merge carries both
 * itself and can no longer produce what this repairs. So every case writes
 * exactly what the old merge left: the source pointed at its target and
 * deactivated, an audit row without `claims` / `blocksCarried`, and everything
 * else where it was.
 *
 * Two kinds of assertion follow. First, the rows: which claims moved and that
 * nothing but `entity_id` did; which blocks were recorded; which ledger rows
 * were re-opened; and that nothing else was rewritten (a row's `ctid` moves on
 * every UPDATE). Second, the point of it all, driven through the REAL
 * `PipelineStateService.selectStale` and `DuplicateDetectStage` — the sweep and
 * the stage production runs:
 *
 *  - before the migration, the detector proposes nothing for the survivor:
 *    the evidence is on a tombstone;
 *  - after it, the sweep offers the survivor again, and the detector proposes
 *    the third copy that shares only the merged-away card's address;
 *  - the stranger the user ruled out against the source is NOT proposed —
 *    and is, once the carried block is taken away. That is what makes the
 *    block assertion non-vacuous.
 *
 * Everything happens in one transaction, rolled back in `afterAll`: the
 * migration is global, and a committed run would repair whatever else is in the
 * database. Opt-in like its neighbours — set `PIPELINE_TEST_DATABASE_URL` to a
 * migrated database of your OWN: a private `ci/database` container with
 * `yarn workspace @ci/be-api migrate` run against it. Host port 5432 usually
 * belongs to another worktree's stack.
 *
 *   PIPELINE_TEST_DATABASE_URL=postgres://companion:…@127.0.0.1:<port>/companion \
 *     yarn workspace @ci/be-api jest carryPreFixPersonMergeEvidence.migration
 *
 * Every person and address here is invented: `.example` domains, 555-01XX
 * numbers.
 */

const MIGRATION = '20260930040502_carry_pre_fix_person_merge_evidence.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/postgres/migrations');

/** The `-- migrate:up` half of the migration, as dbmate would run it. */
function migrationUpSql(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return down === -1 ? sql : sql.slice(0, down);
}

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/carryPreFixPersonMergeEvidence.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const logger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
} as unknown as LoggerService;

/** What every seeded row's timestamps say, so a bump is visible. */
const SEEDED_AT = '2026-09-01T00:00:00Z';

interface ClaimRow {
  claim_id: string;
  entity_id: string | null;
  /** Every other column, as one value, so "nothing else moved" is one comparison. */
  rest: Record<string, unknown>;
  ctid: string;
}

interface BlockRow {
  block_id: string;
  owner_user_id: string;
  entity_id_a: string;
  entity_id_b: string;
  reason: string | null;
  created_at: Date;
}

interface LedgerRow {
  entity_type: string;
  entity_id: string;
  stage: string;
  stage_version: number;
  status: string;
  ctid: string;
}

describeWithDb(`carrying the evidence of pre-fix person merges (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let state: PipelineStateService;
  let detect: DuplicateDetectStage;
  let owner: string;
  let otherOwner: string;
  let ctx: UserServiceContext;

  /** Every row a case made, by label. */
  const ids = new Map<string, string>();
  const claimIds = new Map<string, string>();

  // Captured in beforeAll, around the one migration run the assertions read.
  let claimsBefore: Map<string, ClaimRow>;
  let claimsAfter: Map<string, ClaimRow>;
  let blocksBefore: BlockRow[];
  let blocksAfter: BlockRow[];
  let ledgerBefore: LedgerRow[];
  let ledgerAfter: LedgerRow[];
  let entitiesBefore: Map<string, string>;
  let entitiesAfter: Map<string, string>;
  let auditBefore: unknown[];
  let auditAfter: unknown[];
  let staleBefore: string[];
  let proposedForAdaBefore: string[];

  function q<T>(sql: string, params?: unknown[]): Promise<T> {
    return runner.query(sql, params) as Promise<T>;
  }

  function id(label: string): string {
    const found = ids.get(label);

    if (found == null) {
      throw new Error(`no row seeded as "${label}"`);
    }

    return found;
  }

  function labelOf(entityId: string | null): string | null {
    if (entityId == null) {
      return null;
    }

    for (const [label, value] of ids) {
      if (value === entityId) {
        return label;
      }
    }

    return `<unknown ${entityId}>`;
  }

  function claimId(label: string): string {
    const found = claimIds.get(label);

    if (found == null) {
      throw new Error(`no claim seeded as "${label}"`);
    }

    return found;
  }

  // ── Seeding: what the pre-fix merge left behind ───────────────────────────

  /**
   * An id that sorts before (`low`) or after (`high`) every other id here.
   *
   * A block stores its pair ordered (`entity_id_a < entity_id_b`), and the
   * migration guards each end separately, so a case about ONE end has to know
   * which end its tombstone lands on. Seeded ids cannot say. `ci.gen_uuid_v7()`
   * calls the pg_uuidv7 extension's `uuid_generate_v7()`, which the
   * `ci/database` image does not ship, so it falls back to a random v4, and the
   * order of two seeded rows changes from run to run. With the ends left to
   * chance, a mutation that removed one end's guard survived. The tail is
   * random so two concurrent runs of this suite cannot collide.
   */
  function edgeId(edge: 'low' | 'high'): string {
    const tail = uuidv7().slice(-12);

    return edge === 'low' ? `00000000-0000-4000-8000-${tail}` : `ffffffff-ffff-4fff-bfff-${tail}`;
  }

  async function entity(
    label: string,
    name: string,
    opts: { owner?: string; type?: string; active?: boolean; entityId?: string } = {},
  ): Promise<void> {
    const [{ entity_id }] = await q<Array<{ entity_id: string }>>(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, is_active, updated_at)
       VALUES (COALESCE($1::uuid, ci.gen_uuid_v7()), $2, $3, $4, '{}'::jsonb, $5, $6)
       RETURNING entity_id`,
      [
        opts.entityId ?? null,
        opts.type ?? 'Person',
        opts.owner ?? owner,
        name,
        opts.active ?? true,
        SEEDED_AT,
      ],
    );

    ids.set(label, entity_id);
  }

  /**
   * All the old merge did to a source that matters here: point it at its
   * target and deactivate it. Its claims and blocks stay exactly where they are.
   */
  async function tombstone(source: string, into: string): Promise<void> {
    await q(`UPDATE ci.entities SET merged_into_entity_id = $2, is_active = FALSE WHERE entity_id = $1`, [
      id(source),
      id(into),
    ]);
  }

  /** The old merge's audit row: counts, but no `claims` and no `blocksCarried`. */
  async function audit(source: string, target: string, auditOwner = owner): Promise<void> {
    await q(
      `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details, created_at)
       VALUES ($1, $2, $3, 'Person', $4::jsonb, '2026-08-12T10:00:00Z')`,
      [
        auditOwner,
        id(source),
        id(target),
        JSON.stringify({ counts: { identifiers: 1, communicationsFrom: 2 }, sourceProperties: {} }),
      ],
    );
  }

  interface ClaimSpec {
    /** The entity the observation resolved to; null for an unresolved one. */
    holder: string | null;
    kind: 'email' | 'phone';
    value: string;
    e164?: string;
    /**
     * 'self' is the holder's own card asserting it (`enrich.person_self_claim`);
     * a role is a message naming it in that slot (`enrich.person_link`).
     */
    role?: 'self' | 'from' | 'to' | 'cc';
    disposition?: 'confirmed' | 'rejected';
    claimOwner?: string;
  }

  async function claim(label: string, spec: ClaimSpec): Promise<void> {
    const role = spec.role ?? 'self';
    const self = role === 'self';
    const holder = spec.holder == null ? null : id(spec.holder);
    const resolved = holder != null;

    const [{ claim_id }] = await q<Array<{ claim_id: string }>>(
      `INSERT INTO ci.identifier_claims
         (owner_user_id, subject_type, subject_id, role, kind, value_normalized, value_e164, raw_value,
          entity_id, confidence, method, stage, source, spec_version, disposition, disposed_at,
          observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $15, $16, $16)
       RETURNING claim_id`,
      [
        spec.claimOwner ?? owner,
        self ? 'person' : 'communication',
        self ? holder : uuidv7(),
        role,
        spec.kind,
        spec.value,
        spec.e164 ?? null,
        spec.e164 ?? spec.value,
        holder,
        resolved ? (self ? 1 : 0.95) : null,
        resolved ? (self ? 'self_asserted' : spec.kind === 'email' ? 'email_exact' : 'phone_e164') : null,
        self ? STAGE_IDS.ENRICH_PERSON_SELF_CLAIM : STAGE_IDS.ENRICH_PERSON_LINK,
        self ? null : 'import:google',
        spec.disposition ?? null,
        spec.disposition == null ? null : '2026-08-20T09:00:00Z',
        SEEDED_AT,
      ],
    );

    claimIds.set(label, claim_id);
  }

  async function block(x: string, y: string, reason: string | null, createdAt: string, blockOwner = owner) {
    const [a, b] = [id(x), id(y)].sort();

    await q(
      `INSERT INTO ci.entity_merge_blocks (owner_user_id, entity_id_a, entity_id_b, reason, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [blockOwner, a, b, reason, createdAt],
    );
  }

  /**
   * A ledger row for `stage` about `label`, at the stage's CURRENT version and
   * under the `entity_type` the stage itself declares, which is what a sweep
   * that had converged leaves behind.
   *
   * `normalize` is there because it shares the detector's spelling: it sweeps
   * `ci.entities` too, under `entity_type = 'entity'`, so every survivor has a
   * row of it that only the stage filter tells apart.
   */
  async function ledger(
    label: string,
    stage: 'detect' | 'selfClaim' | 'normalize',
    opts: { status?: string; ledgerOwner?: string; nextAttemptAt?: Date } = {},
  ): Promise<void> {
    const [entityType, stageId, version] =
      stage === 'detect'
        ? [detect.entityTypes[0], detect.id, detect.version]
        : stage === 'selfClaim'
          ? ['Person', STAGE_IDS.ENRICH_PERSON_SELF_CLAIM, stageVersion(STAGE_IDS.ENRICH_PERSON_SELF_CLAIM)]
          : [
              'entity',
              STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE,
              stageVersion(STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE),
            ];

    await q(
      `INSERT INTO ci.pipeline_state
         (entity_type, entity_id, stage, stage_version, status, attempts, next_attempt_at, user_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)`,
      [
        entityType,
        id(label),
        stageId,
        version,
        opts.status ?? 'done',
        opts.nextAttemptAt ?? null,
        opts.ledgerOwner ?? owner,
        SEEDED_AT,
      ],
    );
  }

  // ── Reading back ──────────────────────────────────────────────────────────

  async function claimRows(): Promise<Map<string, ClaimRow>> {
    const rows = await q<ClaimRow[]>(
      `SELECT claim_id, entity_id, to_jsonb(c) - 'entity_id' AS rest, ctid::text AS ctid
         FROM ci.identifier_claims c
        WHERE owner_user_id = ANY($1::uuid[])`,
      [[owner, otherOwner]],
    );

    return new Map(rows.map((row) => [row.claim_id, row]));
  }

  async function blockRows(): Promise<BlockRow[]> {
    return q<BlockRow[]>(
      `SELECT block_id, owner_user_id, entity_id_a, entity_id_b, reason, created_at
         FROM ci.entity_merge_blocks
        WHERE owner_user_id = ANY($1::uuid[])
        ORDER BY block_id`,
      [[owner, otherOwner]],
    );
  }

  async function ledgerRows(): Promise<LedgerRow[]> {
    return q<LedgerRow[]>(
      `SELECT entity_type, entity_id, stage, stage_version, status, ctid::text AS ctid
         FROM ci.pipeline_state
        WHERE user_id = ANY($1::uuid[])
        ORDER BY entity_id, stage`,
      [[owner, otherOwner]],
    );
  }

  async function entityCtids(): Promise<Map<string, string>> {
    const rows = await q<Array<{ entity_id: string; ctid: string }>>(
      `SELECT entity_id, ctid::text AS ctid FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])`,
      [[owner, otherOwner]],
    );

    return new Map(rows.map((row) => [row.entity_id, row.ctid]));
  }

  async function auditRows(): Promise<unknown[]> {
    return q<unknown[]>(
      `SELECT merge_id, source_entity_id, target_entity_id, details, created_at
         FROM ci.entity_merges
        WHERE owner_user_id = ANY($1::uuid[])
        ORDER BY merge_id`,
      [[owner, otherOwner]],
    );
  }

  /** A block as "<label>~<label>:<reason>", its endpoints in label order. */
  function describeBlock(row: BlockRow): string {
    const [a, b] = [labelOf(row.entity_id_a), labelOf(row.entity_id_b)].sort();

    return `${a}~${b}:${row.reason ?? 'null'}`;
  }

  /** Everyone the user's pending review queue pairs `label` with, by label. */
  async function proposedFor(label: string): Promise<string[]> {
    const rows = await q<Array<{ other: string }>>(
      `SELECT CASE WHEN entity_id_a = $2 THEN entity_id_b ELSE entity_id_a END AS other
         FROM ci.merge_candidates
        WHERE owner_user_id = $1
          AND status = 'pending'
          AND $2 IN (entity_id_a, entity_id_b)`,
      [owner, id(label)],
    );

    return rows.map((row) => labelOf(row.other) ?? '').sort();
  }

  // ── The cases ─────────────────────────────────────────────────────────────

  // Ada's card and a stub of her, merged by the old code. Nothing but the
  // stub's evidence connects Ada to the other two people who share the stub's
  // address: a third copy of her, and Xavier, whom the user had ruled out
  // against the stub. Names share no token, so the name pass pairs nobody.
  async function seedAda(): Promise<void> {
    await entity('ada', 'Ada Quill');
    await entity('ada-stub', 'Ada Q');
    await entity('ada-third', 'Mailroom Desk');
    await entity('xavier', 'Xavier Lund');
    // Two more copies of Ada merged into her, pinned to either end of any pair,
    // for the blocks another owner filed against her (seedOtherOwner).
    await entity('ada-stub-low', 'Quill Mobile', { entityId: edgeId('low') });
    await entity('ada-stub-high', 'Quill Home', { entityId: edgeId('high') });
    await tombstone('ada-stub-low', 'ada');
    await tombstone('ada-stub-high', 'ada');

    await claim('ada.self', { holder: 'ada', kind: 'email', value: 'ada.quill@firm.example' });
    await claim('ada-stub.self', { holder: 'ada-stub', kind: 'email', value: 'ada.q@mail.example' });
    await claim('ada-stub.from', {
      holder: 'ada-stub',
      kind: 'email',
      value: 'ada.q@mail.example',
      role: 'from',
    });
    await claim('ada-stub.to.rejected', {
      holder: 'ada-stub',
      kind: 'email',
      value: 'ada.quill@firm.example',
      role: 'to',
      disposition: 'rejected',
    });
    await claim('ada-stub.cc.confirmed', {
      holder: 'ada-stub',
      kind: 'email',
      value: 'ada.q@mail.example',
      role: 'cc',
      disposition: 'confirmed',
    });
    await claim('ada-third.self', { holder: 'ada-third', kind: 'email', value: 'ada.q@mail.example' });
    await claim('xavier.self', { holder: 'xavier', kind: 'email', value: 'ada.q@mail.example' });

    await block('ada-stub', 'xavier', 'user_rejected', '2026-08-10T09:00:00Z');
    await tombstone('ada-stub', 'ada');
    await audit('ada-stub', 'ada');
  }

  // Bo's chain predates path compression (#1840): the stub still points at a
  // tombstone. Both tombstones' claims and the stub's block end at Bo. Bo's
  // detector row FAILED, and a failed row has its own retry gate.
  async function seedBo(): Promise<void> {
    await entity('bo', 'Bo Tanaka');
    await entity('bo-mid', 'Tanaka Mobile');
    await entity('bo-stub', 'B Tanaka');
    await entity('yara', 'Yara Voss');

    await claim('bo-stub.phone', {
      holder: 'bo-stub',
      kind: 'phone',
      value: '3125550122',
      e164: '+13125550122',
    });
    await claim('bo-mid.from', { holder: 'bo-mid', kind: 'email', value: 'bo@tanaka.example', role: 'from' });

    await block('bo-stub', 'yara', 'user_rejected', '2026-08-02T09:00:00Z');
    await tombstone('bo-stub', 'bo-mid');
    await tombstone('bo-mid', 'bo');
    await audit('bo-stub', 'bo-mid');
    await audit('bo-mid', 'bo');
  }

  // Cy and Dee were each merged into since the user said their stubs were
  // different people: both ends of the block move. Cy's detector row was
  // SKIPPED, which re-opens like `done`.
  async function seedCyDee(): Promise<void> {
    await entity('cy', 'Cy Stone');
    await entity('cy-stub', 'Cy S');
    await entity('dee', 'Dee Park');
    await entity('dee-stub', 'D Park');

    await claim('cy-stub.self', { holder: 'cy-stub', kind: 'email', value: 'cy@stone.example' });

    await block('cy-stub', 'dee-stub', 'user_rejected', '2026-08-03T09:00:00Z');
    await tombstone('cy-stub', 'cy');
    await tombstone('dee-stub', 'dee');
  }

  // The user said Eve's stubs were not each other, nor Eve — then merged both
  // into her anyway. The merge was the later decision.
  async function seedEve(): Promise<void> {
    await entity('eve', 'Eve Adler');
    await entity('eve-stub-1', 'Evie');
    await entity('eve-stub-2', 'E Adler');

    await block('eve-stub-1', 'eve-stub-2', 'user_rejected', '2026-08-04T09:00:00Z');
    await block('eve-stub-1', 'eve', 'user_rejected', '2026-08-04T09:05:00Z');
    await tombstone('eve-stub-1', 'eve');
    await tombstone('eve-stub-2', 'eve');
  }

  // Fay already holds the block against Zed, under its own reason and date.
  async function seedFay(): Promise<void> {
    await entity('fay', 'Fay Oduya');
    await entity('fay-stub', 'F Oduya');
    await entity('zed', 'Zed Imrie');

    await block('fay-stub', 'zed', 'user_rejected', '2026-08-10T09:00:00Z');
    await block('fay', 'zed', 'unmerged', '2026-08-12T09:00:00Z');
    await tombstone('fay-stub', 'fay');
  }

  // Two of Gus's stubs were each ruled out against Wren, the later one seeded
  // first: the earliest decision's reason is the one carried.
  async function seedGus(): Promise<void> {
    await entity('gus', 'Gus Brandt');
    await entity('gus-stub-1', 'G Brandt');
    await entity('gus-stub-2', 'Brandt Office');
    await entity('wren', 'Wren Hale');

    await block('gus-stub-2', 'wren', 'user_rejected', '2026-08-15T09:00:00Z');
    await block('gus-stub-1', 'wren', 'unmerged', '2026-08-01T09:00:00Z');
    await tombstone('gus-stub-1', 'gus');
    await tombstone('gus-stub-2', 'gus');
  }

  // Chains that no longer stand. Each resolves to nobody; its evidence stays.
  async function seedBrokenChains(): Promise<void> {
    // The survivor was deleted since, so Hal's stubs resolve to nobody and none
    // of their blocks is carried: not the one against a live person, and not
    // the two against Ada's stub, whose own end does resolve. Those two pin
    // the unresolved stub to each end of the pair, one guard each.
    await entity('hal', 'Hal Moss', { active: false });
    await entity('hal-stub', 'H Moss');
    await entity('hal-stub-low', 'Moss Studio', { entityId: edgeId('low') });
    await entity('hal-stub-high', 'Moss Workshop', { entityId: edgeId('high') });
    await entity('ines', 'Ines Varga');
    await claim('hal-stub.self', { holder: 'hal-stub', kind: 'email', value: 'hal@moss.example' });
    await block('hal-stub', 'ines', 'user_rejected', '2026-08-05T09:00:00Z');
    await block('hal-stub-low', 'ada-stub', 'user_rejected', '2026-08-05T10:00:00Z');
    await block('ada-stub', 'hal-stub-high', 'user_rejected', '2026-08-05T11:00:00Z');
    await tombstone('hal-stub', 'hal');
    await tombstone('hal-stub-low', 'hal');
    await tombstone('hal-stub-high', 'hal');

    // The chain runs through a row a later repair retyped out of Person.
    await entity('ivy', 'Ivy Lin');
    await entity('ivy-mid', 'Ivy Alerts', { type: 'Concept' });
    await entity('ivy-stub', 'I Lin');
    await claim('ivy-stub.self', { holder: 'ivy-stub', kind: 'email', value: 'ivy@lin.example' });
    await tombstone('ivy-mid', 'ivy');
    await tombstone('ivy-stub', 'ivy-mid');

    // The source itself was retyped out of Person after its merge.
    await entity('jo', 'Jo Reyes');
    await entity('jo-stub', '55501', { type: 'Concept' });
    await claim('jo-stub.self', { holder: 'jo-stub', kind: 'phone', value: '55501' });
    await tombstone('jo-stub', 'jo');

    // The survivor was retyped out of Person.
    await entity('kai', 'Kai Kalani', { type: 'Concept' });
    await entity('kai-stub', 'K Kalani');
    await claim('kai-stub.self', { holder: 'kai-stub', kind: 'email', value: 'kai@kalani.example' });
    await tombstone('kai-stub', 'kai');

    // A cycle, which no merge path makes. The walk must still end.
    await entity('lu-a', 'Lu Chen');
    await entity('lu-b', 'L Chen');
    await claim('lu-a.self', { holder: 'lu-a', kind: 'email', value: 'lu@chen.example' });
    await tombstone('lu-a', 'lu-b');
    await tombstone('lu-b', 'lu-a');

    // A pointer into another owner's rows — as the first hop, and as a middle
    // one that leads back to a live person of the right owner.
    await entity('mo-elsewhere', 'Mo Ellery', { owner: otherOwner });
    await entity('mo-stub', 'M Ellery');
    await claim('mo-stub.self', { holder: 'mo-stub', kind: 'email', value: 'mo@ellery.example' });
    await tombstone('mo-stub', 'mo-elsewhere');

    await entity('pat', 'Pat Okoro');
    await entity('pat-mid', 'P Okoro', { owner: otherOwner });
    await entity('pat-stub', 'Okoro Home');
    await claim('pat-stub.self', { holder: 'pat-stub', kind: 'email', value: 'pat@okoro.example' });
    await tombstone('pat-mid', 'pat');
    await tombstone('pat-stub', 'pat-mid');

    // A place merge: out of scope, as it is for the fix.
    await entity('place', 'Harbour Office', { type: 'Place' });
    await entity('place-stub', 'Harbor Office', { type: 'Place' });
    await entity('place-other', 'Harbour Annex', { type: 'Place' });
    await block('place-stub', 'place-other', 'user_rejected', '2026-08-06T09:00:00Z');
    await tombstone('place-stub', 'place');
  }

  // Another owner's merge is repaired with that owner's rows alone.
  async function seedOtherOwner(): Promise<void> {
    await entity('vic', 'Vic Soto', { owner: otherOwner });
    await entity('vic-stub', 'V Soto', { owner: otherOwner });
    await entity('vera', 'Vera Nunez', { owner: otherOwner });

    await claim('vic-stub.self', {
      holder: 'vic-stub',
      kind: 'email',
      value: 'vic@soto.example',
      claimOwner: otherOwner,
    });
    await block('vic-stub', 'vera', 'user_rejected', '2026-08-07T09:00:00Z', otherOwner);
    await tombstone('vic-stub', 'vic');
    await audit('vic-stub', 'vic', otherOwner);

    // Rows filed under the wrong owner: a claim and two blocks of this owner's
    // that name the FIRST owner's tombstones — the blocks with the tombstone at
    // each end of the pair. None may reach that owner's people.
    await claim('stray.other-owner', {
      holder: 'ada-stub',
      kind: 'email',
      value: 'stray@elsewhere.example',
      role: 'from',
      claimOwner: otherOwner,
    });
    await block('ada-stub-low', 'xavier', 'user_rejected', '2026-08-08T09:00:00Z', otherOwner);
    await block('xavier', 'ada-stub-high', 'user_rejected', '2026-08-08T10:00:00Z', otherOwner);
  }

  async function seedLooseClaims(): Promise<void> {
    await claim('unresolved.from', {
      holder: null,
      kind: 'email',
      value: 'nobody@nowhere.example',
      role: 'from',
    });
  }

  /**
   * The ledger of a sweep that had converged: every live person of the owner
   * decided at the detector's current version — Bo's decision failed and is
   * waiting out its retry, Cy's was a skip — and Ada's self claims derived.
   */
  async function seedLedger(): Promise<void> {
    for (const label of ['ada', 'ada-third', 'xavier', 'yara', 'dee', 'eve', 'fay', 'zed', 'gus', 'wren']) {
      await ledger(label, 'detect');
    }

    for (const label of ['ines', 'ivy', 'jo', 'pat']) {
      await ledger(label, 'detect');
    }

    await ledger('bo', 'detect', { status: 'failed', nextAttemptAt: new Date(Date.now() + 86_400_000) });
    await ledger('cy', 'detect', { status: 'skipped' });
    await ledger('ada', 'selfClaim');
    await ledger('ada', 'normalize');
    await ledger('vic', 'detect', { ledgerOwner: otherOwner });
    await ledger('vera', 'detect', { ledgerOwner: otherOwner });
    await ledger('mo-elsewhere', 'detect', { ledgerOwner: otherOwner });
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
      synchronize: false,
      logging: false,
      extra: { max: 3 },
    });
    await dataSource.initialize();

    // The migration row-locks every claim on a tombstone it moves, whoever
    // owns it, for as long as this transaction is open.
    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'pipeline/carryPreFixPersonMergeEvidence.migration',
    );

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    // The real sweep and the real stage, pointed at the transaction: both only
    // ever call `query`, so their reads see the seeded rows and their writes
    // roll back with the rest.
    const inTransaction = {
      query: (sql: string, params?: unknown[]) => runner.query(sql, params),
    } as unknown as DataSource;

    state = new PipelineStateService(inTransaction, logger);
    detect = new DuplicateDetectStage(inTransaction, logger);

    owner = await createSyntheticTestUser((sql, params) => q(sql, params), 'MergeEvidenceBackfill');
    otherOwner = await createSyntheticTestUser((sql, params) => q(sql, params), 'MergeEvidenceBackfillOther');
    ctx = { userId: owner } as UserServiceContext;

    await seedAda();
    await seedBo();
    await seedCyDee();
    await seedEve();
    await seedFay();
    await seedGus();
    await seedBrokenChains();
    await seedOtherOwner();
    await seedLooseClaims();
    await seedLedger();

    // The pre-fix world, as the detector sees it.
    staleBefore = await state.selectStale(detect, owner, null, 100);
    await detect.run(ctx, [id('ada')]);
    proposedForAdaBefore = await proposedFor('ada');

    claimsBefore = await claimRows();
    blocksBefore = await blockRows();
    ledgerBefore = await ledgerRows();
    entitiesBefore = await entityCtids();
    auditBefore = await auditRows();

    await q(migrationUpSql());

    claimsAfter = await claimRows();
    blocksAfter = await blockRows();
    ledgerAfter = await ledgerRows();
    entitiesAfter = await entityCtids();
    auditAfter = await auditRows();
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    await schemaLock?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  // ── The fixture reproduces the bug ────────────────────────────────────────

  it('starts from a converged sweep in which the stub’s evidence counts for nobody', () => {
    expect(staleBefore).toEqual([]);
    // Xavier and the third copy share the stub's address, but the stub is a
    // tombstone, so the detector pairs Ada with neither.
    expect(proposedForAdaBefore).toEqual([]);
  });

  // ── Claims ────────────────────────────────────────────────────────────────

  it('re-points every claim on a merged-away source to the live person at the end of its chain', () => {
    const holders = Object.fromEntries(
      [
        'ada-stub.self',
        'ada-stub.from',
        'ada-stub.to.rejected',
        'ada-stub.cc.confirmed',
        'bo-stub.phone',
        'bo-mid.from',
        'cy-stub.self',
        'vic-stub.self',
      ].map((label) => [label, labelOf(claimsAfter.get(claimId(label))!.entity_id)]),
    );

    expect(holders).toEqual({
      'ada-stub.self': 'ada',
      'ada-stub.from': 'ada',
      'ada-stub.to.rejected': 'ada',
      'ada-stub.cc.confirmed': 'ada',
      // Two hops: the stub still pointed at a tombstone.
      'bo-stub.phone': 'bo',
      'bo-mid.from': 'bo',
      'cy-stub.self': 'cy',
      // Another owner's merge, within that owner's rows.
      'vic-stub.self': 'vic',
    });
  });

  it('moves nothing but entity_id — a human’s disposition included', () => {
    for (const [claim, before] of claimsBefore) {
      const after = claimsAfter.get(claim)!;

      expect([claim, after.rest]).toEqual([claim, before.rest]);
    }

    expect(claimsAfter.get(claimId('ada-stub.to.rejected'))!.rest).toMatchObject({ disposition: 'rejected' });
    expect(claimsAfter.get(claimId('ada-stub.cc.confirmed'))!.rest).toMatchObject({
      disposition: 'confirmed',
    });
  });

  it.each([
    ['a survivor deleted since', 'hal-stub.self', 'hal-stub'],
    ['a chain through a row retyped out of Person', 'ivy-stub.self', 'ivy-stub'],
    ['a source retyped out of Person', 'jo-stub.self', 'jo-stub'],
    ['a survivor retyped out of Person', 'kai-stub.self', 'kai-stub'],
    ['a cycle', 'lu-a.self', 'lu-a'],
    ['a pointer into another owner’s rows', 'mo-stub.self', 'mo-stub'],
    ['a chain whose middle hop is another owner’s', 'pat-stub.self', 'pat-stub'],
    ['another owner, filed against this owner’s tombstone', 'stray.other-owner', 'ada-stub'],
  ])('leaves the claims of %s where they are', (_case, label, holder) => {
    const after = claimsAfter.get(claimId(label))!;

    expect(labelOf(after.entity_id)).toBe(holder);
    expect(after.ctid).toBe(claimsBefore.get(claimId(label))!.ctid);
  });

  it('rewrites exactly the claims it moves', () => {
    const rewritten = [...claimsAfter]
      .filter(([claim, row]) => row.ctid !== claimsBefore.get(claim)!.ctid)
      .map(([claim]) => [...claimIds].find(([, value]) => value === claim)![0])
      .sort();

    expect(rewritten).toEqual(
      [
        'ada-stub.cc.confirmed',
        'ada-stub.from',
        'ada-stub.self',
        'ada-stub.to.rejected',
        'bo-mid.from',
        'bo-stub.phone',
        'cy-stub.self',
        'vic-stub.self',
      ].sort(),
    );
  });

  // ── Blocks ────────────────────────────────────────────────────────────────

  it('records each stranded block between the canonical people, with the earliest reason', () => {
    const before = new Set(blocksBefore.map((row) => row.block_id));
    const added = blocksAfter.filter((row) => !before.has(row.block_id));

    expect(added.map(describeBlock).sort()).toEqual(
      [
        'ada~xavier:user_rejected',
        // Two hops.
        'bo~yara:user_rejected',
        // Both ends were merged away.
        'cy~dee:user_rejected',
        // Two blocks land on one pair; the earlier decision's reason.
        'gus~wren:unmerged',
        'vera~vic:user_rejected',
      ].sort(),
    );

    const vic = added.find((row) => describeBlock(row) === 'vera~vic:user_rejected')!;

    expect(vic.owner_user_id).toBe(otherOwner);
    expect(added.filter((row) => row !== vic).every((row) => row.owner_user_id === owner)).toBe(true);
  });

  it('keeps every original block exactly as it was — including the one a pair already held', () => {
    const after = new Map(blocksAfter.map((row) => [row.block_id, row]));

    for (const row of blocksBefore) {
      expect(after.get(row.block_id)).toEqual(row);
    }

    const fayZed = blocksAfter.filter((row) => describeBlock(row).startsWith('fay~zed:'));

    expect(fayZed.map(describeBlock)).toEqual(['fay~zed:unmerged']);
  });

  it('carries no block the merges overruled, none with an end that resolves to nobody, no place’s, and none across owners', () => {
    const before = new Set(blocksBefore.map((row) => row.block_id));
    const added = blocksAfter.filter((row) => !before.has(row.block_id));

    expect(added).toHaveLength(5);

    const endpoints = new Set(added.flatMap((row) => [labelOf(row.entity_id_a), labelOf(row.entity_id_b)]));

    // Eve's blocks would collapse to eve~eve. Hal's survivor is deleted, so
    // none of his stubs' blocks has a second person to name — those whose
    // OTHER end is Ada's stub included. The place merge is not a Person merge.
    expect(endpoints.has('eve')).toBe(false);
    expect(endpoints.has('hal')).toBe(false);
    expect(['hal-stub', 'hal-stub-low', 'hal-stub-high'].filter((label) => endpoints.has(label))).toEqual([]);
    expect(endpoints.has('place')).toBe(false);
    // The second owner's blocks against the first owner's people stay theirs.
    expect(added.filter((row) => row.owner_user_id === otherOwner).map(describeBlock)).toEqual([
      'vera~vic:user_rejected',
    ]);
  });

  it('pins a tombstone to each end of a pair where only one end is guarded', () => {
    // The two cases above are only half-tested if their tombstone lands on the
    // same end every time; each end has its own guard in the migration.
    const pair = (x: string, y: string) =>
      blocksBefore.find(
        (row) => [row.entity_id_a, row.entity_id_b].sort().join() === [id(x), id(y)].sort().join(),
      );

    expect(pair('hal-stub-low', 'ada-stub')!.entity_id_a).toBe(id('hal-stub-low'));
    expect(pair('ada-stub', 'hal-stub-high')!.entity_id_b).toBe(id('hal-stub-high'));
    expect(pair('ada-stub-low', 'xavier')!.entity_id_a).toBe(id('ada-stub-low'));
    expect(pair('xavier', 'ada-stub-high')!.entity_id_b).toBe(id('ada-stub-high'));
  });

  // ── The ledger ────────────────────────────────────────────────────────────

  it('re-opens the detector’s decision about each survivor that gained claims, and nothing else', () => {
    const before = new Map(ledgerBefore.map((row) => [`${row.entity_id}|${row.stage}`, row]));
    const changed = ledgerAfter
      .filter((row) => row.ctid !== before.get(`${row.entity_id}|${row.stage}`)!.ctid)
      .map((row) => ({
        who: labelOf(row.entity_id),
        entityType: row.entity_type,
        stage: row.stage,
        version: Number(row.stage_version),
        status: row.status,
      }))
      .sort((a, b) => String(a.who).localeCompare(String(b.who)));

    expect(ledgerAfter).toHaveLength(ledgerBefore.length);
    expect(changed).toEqual([
      {
        who: 'ada',
        entityType: 'entity',
        stage: STAGE_IDS.CLEAN_DUPLICATE_DETECT,
        version: 0,
        status: 'done',
      },
      {
        who: 'cy',
        entityType: 'entity',
        stage: STAGE_IDS.CLEAN_DUPLICATE_DETECT,
        version: 0,
        status: 'skipped',
      },
      {
        who: 'vic',
        entityType: 'entity',
        stage: STAGE_IDS.CLEAN_DUPLICATE_DETECT,
        version: 0,
        status: 'done',
      },
    ]);
  });

  // ── What it leaves alone ──────────────────────────────────────────────────

  it('rewrites no entity and stamps no audit row', () => {
    expect(entitiesAfter).toEqual(entitiesBefore);
    expect(auditAfter).toEqual(auditBefore);
    expect(JSON.stringify(auditAfter)).not.toContain('blocksCarried');
  });

  // ── What the detector makes of it ─────────────────────────────────────────

  it('lets the real sweep find the survivors again, and the detector pair Ada with the third copy but not with Xavier', async () => {
    const stale = await state.selectStale(detect, owner, null, 100);

    expect(stale.map(labelOf).sort()).toEqual(['ada', 'cy']);

    const entityType = detect.entityTypes[0];
    const claimed = await state.claim(detect, entityType, stale, owner);

    await state.complete(detect, entityType, await detect.run(ctx, claimed));

    expect(await proposedFor('ada')).toEqual(['ada-third']);

    const [evidence] = await q<Array<{ evidence: Array<{ kind: string; value: string }> }>>(
      `SELECT evidence FROM ci.merge_candidates
        WHERE owner_user_id = $1 AND entity_id_a = LEAST($2::uuid, $3::uuid) AND entity_id_b = GREATEST($2::uuid, $3::uuid)`,
      [owner, id('ada'), id('ada-third')],
    );

    expect(evidence.evidence).toContainEqual(
      expect.objectContaining({ kind: 'email', value: 'ada.q@mail.example' }),
    );

    // Converged again: the re-opened decisions are decided.
    expect(await state.selectStale(detect, owner, null, 100)).toEqual([]);
  });

  it('is kept from proposing Xavier by the carried block, and by nothing else', async () => {
    await q('SAVEPOINT without_the_carried_block');

    try {
      const [a, b] = [id('ada'), id('xavier')].sort();

      await q(
        `DELETE FROM ci.entity_merge_blocks WHERE owner_user_id = $1 AND entity_id_a = $2 AND entity_id_b = $3`,
        [owner, a, b],
      );
      await detect.run(ctx, [id('ada')]);

      expect(await proposedFor('ada')).toEqual(['ada-third', 'xavier']);
    } finally {
      await q('ROLLBACK TO SAVEPOINT without_the_carried_block');
    }

    expect(await proposedFor('ada')).toEqual(['ada-third']);
  });

  // ── Last: it must be safe to run again ────────────────────────────────────

  it('changes nothing when run a second time', async () => {
    const claims = await claimRows();
    const blocks = await blockRows();
    const ledgerRowsBefore = await ledgerRows();

    await q(migrationUpSql());

    const claimsAgain = await claimRows();

    for (const [claim, row] of claims) {
      expect([claim, claimsAgain.get(claim)!.ctid]).toEqual([claim, row.ctid]);
    }

    expect(await blockRows()).toEqual(blocks);
    expect(await ledgerRows()).toEqual(ledgerRowsBefore);
  });
});
