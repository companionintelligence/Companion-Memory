import { readdirSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type EntityMetadata, type EntityTarget, type ObjectLiteral } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import { PipelineDeadLetterEntity } from '../PipelineDeadLetterEntity';
import { PipelineRunEntity } from '../PipelineRunEntity';
import { PipelineShardEntity } from '../PipelineShardEntity';
import { PipelineStateEntity } from '../PipelineStateEntity';
import { RecordRejectionEntity } from '../RecordRejectionEntity';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ENTITIES AGREE WITH THE MIGRATION. VERIFIED AGAINST THE LIVE DDL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md states the rule: the SQL files in `db/postgres/migrations/` are
 * hand-written and are the SOURCE OF TRUTH; the TypeORM entities are updated to
 * match. Nothing enforced it. `synchronize` is off (it must be — pointed at this
 * database it would be destructive), so TypeORM never compares the two, and the
 * pipeline itself speaks raw SQL, so the entities are not even exercised by the
 * integration suite next door.
 *
 * That combination makes a drifted entity a uniquely nasty class of bug:
 *
 *  - `tsc` is happy — the entity is internally consistent TypeScript.
 *  - Every unit test is happy — they mock the repository, and a mock agrees
 *    with whatever the entity claims.
 *  - `pipeline.integration.spec.ts` is happy — it drives raw SQL through
 *    `PipelineStateService` and never loads an entity at all.
 *  - The first thing that notices is a `QueryFailedError: column
 *    PipelineRunEntity.foo does not exist`, in production, on the first request
 *    that happens to use a repository instead of a hand-written query.
 *
 * So this file asks Postgres. It reads `information_schema` for the five
 * control-plane tables and compares the LIVE DDL against the metadata TypeORM
 * built from the decorators — the same metadata a `Repository<T>` would use to
 * write SQL.
 *
 * ── What is compared, and what deliberately is not ─────────────────────────
 *
 * Compared:
 *
 *  1. **Table identity** — the entity resolves to the `ci.<table>` the migration
 *     creates. A typo in `@Entity({ name })` produces a repository that queries
 *     a table nobody made.
 *  2. **Columns, in BOTH directions.** An entity property with no column is the
 *     obvious failure. The other direction is the one that actually happens: a
 *     later migration adds a column, nobody adds the property, and every
 *     `repository.save()` from then on writes an INSERT/UPDATE whose column list
 *     omits it — so the value silently reverts to the column default. That is
 *     data loss with a green test suite, so an unmapped column is a failure
 *     here, not a warning.
 *  3. **Nullability**, which is a claim about the TypeScript type. `reason!:
 *     string | null` against a `NOT NULL` column (or the reverse) is a lie the
 *     compiler propagates into every caller.
 *  4. **Primary keys**, as an ORDERED list. Order is not cosmetic on
 *     `ci.pipeline_state`: the PK index IS the index the staleness sweep's LEFT
 *     JOIN uses, and it is only an index lookup if the leading columns are the
 *     ones the join binds.
 *
 * Not compared, on purpose:
 *
 *  - **Exact type strings.** `timestamptz` vs `timestamp with time zone` vs
 *    TypeORM's normalized spelling are the same type written three ways; a test
 *    that failed on that would be a formatting test that people learn to
 *    silence. Types are compared by FAMILY (uuid / text / integer / timestamptz
 *    / jsonb …), which still catches the drift that matters — a `uuid` column
 *    mapped as `text`, a `jsonb` mapped as `text` — while `timestamptz` and
 *    `timestamp` stay separate families, because losing the time zone is a real
 *    bug and not a spelling.
 *  - **Defaults, CHECKs and indexes.** Those live in the migration and are
 *    enforced by Postgres whether or not an entity mentions them — the CHECK on
 *    `status`, the partial unique index behind one-active-run-per-user — and the
 *    entities intentionally do not restate them.
 *
 * ── Why the comparisons are pure functions ────────────────────────────────
 *
 * A drift test passes on the day it is written, which means nothing has ever
 * demonstrated that it CAN fail. The four comparisons are therefore ordinary
 * functions over plain data, and the last block in this file feeds them
 * hand-built drift — a renamed property, an unmapped column, a flipped
 * nullability, a `uuid` mapped as `text`, a reordered PK — and asserts each one
 * is caught. That block needs no database, so the falsifiability is checked on
 * every CI run, not only on a developer machine with the stack up.
 *
 * ── Skipping ───────────────────────────────────────────────────────────────
 *
 * Same contract as `pipeline.integration.spec.ts`, using the same synchronous
 * probe: no reachable database SKIPS (the repo's CI runs `yarn test` with no
 * Postgres service), while a database that IS reachable but missing the control
 * plane FAILS, naming the migrate command. See `__tests__/harness/README.md`.
 */

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

/** One entity and the table `20260809032723_create_pipeline_control_plane.sql` makes for it. */
interface ControlPlaneTable {
  entity: EntityTarget<ObjectLiteral>;
  /** Spelled out here rather than read off the entity: this is the expectation, not the claim. */
  table: string;
}

/**
 * The five control-plane tables.
 *
 * Written out by hand, exactly like `STAGE_REGISTRY`, and for the same reason:
 * a list derived from the entities could only ever agree with them. This one is
 * an independent statement of what the migration created, so a renamed
 * `@Entity({ name })` fails instead of being followed.
 */
const CONTROL_PLANE: readonly ControlPlaneTable[] = [
  { entity: PipelineStateEntity, table: 'pipeline_state' },
  { entity: PipelineRunEntity, table: 'pipeline_runs' },
  { entity: PipelineShardEntity, table: 'pipeline_shards' },
  { entity: PipelineDeadLetterEntity, table: 'pipeline_dead_letters' },
  { entity: RecordRejectionEntity, table: 'record_rejections' },
];

/** Every control-plane table lives here. Hardcoded so a stray `schema:` is caught. */
const CONTROL_PLANE_SCHEMA = 'ci';

// ---------------------------------------------------------------------------
// Type families
// ---------------------------------------------------------------------------

/**
 * Postgres and TypeORM spell the same type several ways — `information_schema`
 * says `timestamp with time zone`, `udt_name` says `timestamptz`, the decorator
 * says `timestamptz`, and TypeORM's driver normalizes back to `timestamp with
 * time zone`. Folding all of them onto one token is what makes this a DRIFT test
 * rather than a spelling test.
 *
 * The folds are only ever between genuinely interchangeable spellings.
 * `timestamp` and `timestamptz` are kept apart because a column that quietly
 * loses its time zone is exactly the kind of bug this file exists to catch, and
 * likewise `json` is not folded into `jsonb`.
 */
const TYPE_FAMILY_GROUPS: ReadonlyArray<readonly [family: string, spellings: readonly string[]]> = [
  ['uuid', ['uuid']],
  ['text', ['text', 'varchar', 'character varying', 'char', 'character', 'bpchar', 'citext', 'name']],
  ['integer', ['integer', 'int', 'int2', 'int4', 'int8', 'smallint', 'bigint', 'serial', 'bigserial']],
  ['timestamptz', ['timestamptz', 'timestamp with time zone']],
  ['timestamp', ['timestamp', 'timestamp without time zone']],
  ['jsonb', ['jsonb']],
  ['json', ['json']],
  ['boolean', ['bool', 'boolean']],
  ['numeric', ['numeric', 'decimal', 'float4', 'float8', 'real', 'double precision']],
  ['date', ['date']],
  ['bytea', ['bytea']],
];

const TYPE_FAMILIES = new Map<string, string>(
  TYPE_FAMILY_GROUPS.flatMap(([family, spellings]) =>
    spellings.map((spelling): [string, string] => [spelling, family]),
  ),
);

/**
 * Collapse one type spelling onto its family.
 *
 * An unrecognised type falls through as itself rather than throwing, so an
 * exotic column (a domain, an enum, `vector(768)`) still compares equal to the
 * same exotic column on the other side. Only a genuine difference fails.
 */
function typeFamily(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    // `character varying(255)`, `numeric(10,2)` — the modifier is not the type.
    .replace(/\s*\([^)]*\)/g, '')
    .trim();

  return TYPE_FAMILIES.get(cleaned) ?? cleaned;
}

// ---------------------------------------------------------------------------
// The two sides, reduced to plain data
// ---------------------------------------------------------------------------

/** One entity column, reduced to the three facts this file compares. */
interface DeclaredColumn {
  /** `ColumnMetadata.databaseName` — the name TypeORM will actually put in SQL. */
  name: string;
  nullable: boolean;
  /** Driver-normalized type string, folded through {@link typeFamily} when compared. */
  type: string;
}

/** One `information_schema.columns` row, narrowed the same way. */
interface DdlColumn {
  nullable: boolean;
  /** `udt_name` — `timestamptz`, `int4`, `jsonb`. */
  type: string;
}

/** The live shape of one table. */
interface DdlTable {
  columns: Map<string, DdlColumn>;
  /** PK columns in constraint order, which is the index's column order. */
  primaryKey: string[];
}

/** Two same-keyed records, for a jest diff that reads as "entity vs database". */
interface Comparison {
  entity: Record<string, unknown>;
  database: Record<string, unknown>;
}

/**
 * Properties the entity declares that the migration never created.
 *
 * Every column of an entity appears in the SELECT list TypeORM generates, so one
 * bad property breaks every READ of the table, not just the writes that touch
 * it.
 */
function columnsWithNoDdl(declared: readonly DeclaredColumn[], live: DdlTable): string[] {
  return declared.filter((column) => !live.columns.has(column.name)).map((column) => column.name);
}

/**
 * Columns the migration created that no property maps.
 *
 * The direction nobody remembers to check, and the one that actually happens:
 * an unmapped column is omitted from every INSERT and UPDATE the repository
 * builds, so its value reverts to the column default on every save.
 */
function columnsWithNoProperty(declared: readonly DeclaredColumn[], live: DdlTable): string[] {
  const names = new Set(declared.map((column) => column.name));

  return [...live.columns.keys()].filter((name) => !names.has(name));
}

/**
 * Columns both sides know about.
 *
 * Comparisons are restricted to these on purpose: a name mismatch is already
 * reported by the two functions above, and letting it fail the nullability and
 * type checks as well would bury the real message under two derived ones.
 */
function shared(declared: readonly DeclaredColumn[], live: DdlTable): DeclaredColumn[] {
  return declared.filter((column) => live.columns.has(column.name));
}

/** Nullability, entity vs database, over the shared columns. */
function compareNullability(declared: readonly DeclaredColumn[], live: DdlTable): Comparison {
  const columns = shared(declared, live);

  return {
    entity: Object.fromEntries(columns.map((column) => [column.name, column.nullable])),
    database: Object.fromEntries(
      columns.map((column) => [column.name, live.columns.get(column.name)!.nullable]),
    ),
  };
}

/** Type FAMILIES, entity vs database, over the shared columns. */
function compareTypeFamilies(declared: readonly DeclaredColumn[], live: DdlTable): Comparison {
  const columns = shared(declared, live);

  return {
    entity: Object.fromEntries(columns.map((column) => [column.name, typeFamily(column.type)])),
    database: Object.fromEntries(
      columns.map((column) => [column.name, typeFamily(live.columns.get(column.name)!.type)]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Suite gating
// ---------------------------------------------------------------------------

const availability = databaseAvailability();

const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once per run so a skipped suite is never mistaken for a passing one.
  console.warn(`[entitySchemaAgreement] SKIPPED — ${availability.reason}`);
}

// One connection, one round of introspection. Nowhere near jest's 5 s default in
// practice, but that default is not a budget worth flaking over.
jest.setTimeout(60_000);

// ---------------------------------------------------------------------------
// The folder guard — no database required
// ---------------------------------------------------------------------------

describe('the control-plane declaration', () => {
  it('pins every entity in this folder', () => {
    // A sixth control-plane entity is exactly the moment this file stops
    // covering the control plane, and it is the moment nobody thinks to open
    // it. Reading the directory means the omission fails here instead of
    // surviving until that entity's first repository call in production.
    const onDisk = readdirSync(path.resolve(__dirname, '..'))
      .filter((file) => file.endsWith('Entity.ts'))
      .sort();

    const pinned = CONTROL_PLANE.map((entry) => `${(entry.entity as { name: string }).name}.ts`).sort();

    expect(onDisk).toEqual(pinned);
  });
});

// ---------------------------------------------------------------------------
// The agreement
// ---------------------------------------------------------------------------

describeWithDatabase(`entity ↔ migration agreement (${availability.target})`, () => {
  let dataSource: DataSource;

  /** The live DDL, keyed by table name. Populated once. */
  const ddl = new Map<string, DdlTable>();

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error(
        'entitySchemaAgreement ran with no database configured. The suite is gated on ' +
          'databaseAvailability().available; reaching here means the gate broke.',
      );
    }

    dataSource = new DataSource({
      type: 'postgres',
      // Discrete fields when there is no URL, so a password containing URL
      // metacharacters (the dev one ends in `!`) never has to survive a round
      // trip through percent-encoding.
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      // The entities are loaded for their METADATA, not to query through. And
      // `synchronize` must stay false: pointed at the dev database, TypeORM
      // would happily "fix" the drift this file exists to report — by rewriting
      // the source of truth to match the copy.
      entities: [
        PipelineStateEntity,
        PipelineRunEntity,
        PipelineShardEntity,
        PipelineDeadLetterEntity,
        RecordRejectionEntity,
      ],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });

    await dataSource.initialize();

    try {
      await introspect();
    } catch (err: unknown) {
      await dataSource.destroy();

      throw err;
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  /**
   * Read `information_schema` once for all five tables.
   *
   * A reachable database missing the control plane THROWS, with the migrate
   * command in the message — the same split the harness makes. Skipping there
   * would turn a migration mistake into a green run, the exact silence this
   * subsystem was rebuilt to remove.
   */
  async function introspect(): Promise<void> {
    const tables = CONTROL_PLANE.map((entry) => entry.table);

    const columns = await dataSource.query<
      Array<{ table_name: string; column_name: string; is_nullable: string; udt_name: string }>
    >(
      `SELECT table_name, column_name, is_nullable, udt_name
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = ANY($2::text[])
        ORDER BY table_name, ordinal_position`,
      [CONTROL_PLANE_SCHEMA, tables],
    );

    const primaryKeys = await dataSource.query<Array<{ table_name: string; column_name: string }>>(
      // `key_column_usage.ordinal_position` is the column's position WITHIN the
      // constraint — i.e. the PK index's column order, which is the thing worth
      // asserting.
      `SELECT tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = $1
          AND tc.table_name = ANY($2::text[])
        ORDER BY tc.table_name, kcu.ordinal_position`,
      [CONTROL_PLANE_SCHEMA, tables],
    );

    for (const table of tables) {
      const own = columns.filter((row) => row.table_name === table);

      if (own.length === 0) {
        throw new Error(
          `${CONTROL_PLANE_SCHEMA}.${table} is missing from this database. Run ` +
            '`yarn workspace @ci/be-api migrate` and try again.',
        );
      }

      ddl.set(table, {
        columns: new Map(
          own.map((row): [string, DdlColumn] => [
            row.column_name,
            { nullable: row.is_nullable === 'YES', type: row.udt_name },
          ]),
        ),
        primaryKey: primaryKeys.filter((row) => row.table_name === table).map((row) => row.column_name),
      });
    }
  }

  /** The live DDL for a table. */
  function live(table: string): DdlTable {
    const found = ddl.get(table);

    if (found == null) {
      throw new Error(`No introspection recorded for ${CONTROL_PLANE_SCHEMA}.${table}.`);
    }

    return found;
  }

  /**
   * The entity's columns as plain data.
   *
   * The type comes from the DRIVER's normalization rather than the raw string in
   * the decorator, so what is compared is the type TypeORM believes the column
   * has — the same answer it would use to build DDL.
   */
  function declaredColumns(metadata: EntityMetadata): DeclaredColumn[] {
    return metadata.columns.map((column) => ({
      name: column.databaseName,
      nullable: column.isNullable,
      type: dataSource.driver.normalizeType(column),
    }));
  }

  describe.each(CONTROL_PLANE)('$table', ({ entity, table }: ControlPlaneTable) => {
    let metadata: EntityMetadata;
    let declared: DeclaredColumn[];

    beforeAll(() => {
      metadata = dataSource.getMetadata(entity);
      declared = declaredColumns(metadata);
    });

    it(`resolves to ${CONTROL_PLANE_SCHEMA}.${table}`, () => {
      // Everything below reads the live DDL for the table NAMED HERE, so if the
      // entity pointed somewhere else the rest of this block would be comparing
      // it against a table it never touches.
      expect({ schema: metadata.schema, table: metadata.tableName }).toEqual({
        schema: CONTROL_PLANE_SCHEMA,
        table,
      });
    });

    it('declares no column the migration did not create', () => {
      expect(columnsWithNoDdl(declared, live(table))).toEqual([]);
    });

    it('maps every column the migration created', () => {
      expect(columnsWithNoProperty(declared, live(table))).toEqual([]);
    });

    it('agrees with the migration on nullability', () => {
      // Nullability is a claim about the TYPE. `reason!: string | null` over a
      // NOT NULL column, or `payload!: Record<string, unknown>` over a nullable
      // one, is a lie `tsc` then propagates into every caller — the second form
      // being the dangerous one, since it removes the null check the caller
      // would otherwise have been forced to write.
      const comparison = compareNullability(declared, live(table));

      expect(comparison.entity).toEqual(comparison.database);
    });

    it('agrees with the migration on column type families', () => {
      // Families, not strings: `timestamptz` and `timestamp with time zone` are
      // the same column. `uuid` mapped as `text` is not, and neither is `jsonb`
      // mapped as `text` — that one silently double-encodes every write.
      const comparison = compareTypeFamilies(declared, live(table));

      expect(comparison.entity).toEqual(comparison.database);
    });

    it('agrees with the migration on the primary key, in order', () => {
      // Ordered, not a set. On `ci.pipeline_state` the PK index IS the index
      // THE ONE RULE's LEFT JOIN rides — `(entity_type, entity_id, stage)` in
      // that order — and a composite index only serves a lookup that binds its
      // LEADING columns. Reordering the PrimaryColumns would leave every
      // assertion about correctness true and turn the sweep's index lookup into
      // a scan of the whole ledger.
      expect(metadata.primaryColumns.map((column) => column.databaseName)).toEqual(live(table).primaryKey);
    });
  });
});

// ---------------------------------------------------------------------------
// The checks can fail — demonstrated, not assumed. No database required.
// ---------------------------------------------------------------------------

describe('the drift checks themselves', () => {
  /** `ci.pipeline_state` as the migration creates it, as plain data. */
  const LIVE: DdlTable = {
    columns: new Map<string, DdlColumn>([
      ['entity_type', { nullable: false, type: 'text' }],
      ['entity_id', { nullable: false, type: 'uuid' }],
      ['stage', { nullable: false, type: 'text' }],
      ['stage_version', { nullable: false, type: 'int4' }],
      ['status', { nullable: false, type: 'text' }],
      ['reason', { nullable: true, type: 'text' }],
      ['attempts', { nullable: false, type: 'int4' }],
      ['next_attempt_at', { nullable: true, type: 'timestamptz' }],
      ['user_id', { nullable: true, type: 'uuid' }],
      ['updated_at', { nullable: false, type: 'timestamptz' }],
    ]),
    primaryKey: ['entity_type', 'entity_id', 'stage'],
  };

  /** The matching entity side, spelled the way TypeORM's driver normalizes. */
  const MATCHING: DeclaredColumn[] = [
    { name: 'entity_type', nullable: false, type: 'text' },
    { name: 'entity_id', nullable: false, type: 'uuid' },
    { name: 'stage', nullable: false, type: 'text' },
    { name: 'stage_version', nullable: false, type: 'integer' },
    { name: 'status', nullable: false, type: 'text' },
    { name: 'reason', nullable: true, type: 'text' },
    { name: 'attempts', nullable: false, type: 'integer' },
    { name: 'next_attempt_at', nullable: true, type: 'timestamp with time zone' },
    { name: 'user_id', nullable: true, type: 'uuid' },
    { name: 'updated_at', nullable: false, type: 'timestamp with time zone' },
  ];

  /** `MATCHING` with one column replaced — the shape a single drift takes. */
  function withColumn(name: string, patch: Partial<DeclaredColumn>): DeclaredColumn[] {
    return MATCHING.map((column) => (column.name === name ? { ...column, ...patch } : column));
  }

  it('passes on an entity that matches, across every spelling difference', () => {
    // The baseline. `int4` vs `integer` and `timestamptz` vs `timestamp with
    // time zone` are the same columns written differently, and a check that
    // failed on those would be turned off within a week.
    expect(columnsWithNoDdl(MATCHING, LIVE)).toEqual([]);
    expect(columnsWithNoProperty(MATCHING, LIVE)).toEqual([]);

    const nullability = compareNullability(MATCHING, LIVE);
    const types = compareTypeFamilies(MATCHING, LIVE);

    expect(nullability.entity).toEqual(nullability.database);
    expect(types.entity).toEqual(types.database);
  });

  it('catches a property whose column does not exist', () => {
    // A renamed column in a later migration, or a `name:` typo. In production
    // this breaks every SELECT of the table, because TypeORM names every column
    // explicitly.
    const drifted = withColumn('next_attempt_at', { name: 'retry_after' });

    expect(columnsWithNoDdl(drifted, LIVE)).toEqual(['retry_after']);
  });

  it('catches a column no property maps', () => {
    const drifted = MATCHING.filter((column) => column.name !== 'user_id');

    // The silent one: `save()` would omit `user_id` from every INSERT and
    // UPDATE, so the denormalized user the sweep and the reaper filter on would
    // revert to NULL on any write through the repository.
    expect(columnsWithNoProperty(drifted, LIVE)).toEqual(['user_id']);
  });

  it('catches a nullability flip in the dangerous direction', () => {
    // Entity says NOT NULL, database says nullable: `tsc` hands every caller a
    // `string` that is really `string | null`, and the null check nobody was
    // forced to write is the crash.
    const drifted = withColumn('reason', { nullable: false });
    const comparison = compareNullability(drifted, LIVE);

    expect(comparison.entity).not.toEqual(comparison.database);
    expect(comparison.entity.reason).toBe(false);
    expect(comparison.database.reason).toBe(true);
  });

  it('catches a nullability flip in the other direction too', () => {
    const drifted = withColumn('status', { nullable: true });
    const comparison = compareNullability(drifted, LIVE);

    expect(comparison.entity).not.toEqual(comparison.database);
  });

  it('catches a uuid mapped as text', () => {
    // Different families, so this fails — as it must: the column still reads,
    // but every comparison and every index lookup silently changes semantics.
    const drifted = withColumn('entity_id', { type: 'text' });
    const comparison = compareTypeFamilies(drifted, LIVE);

    expect(comparison.entity).not.toEqual(comparison.database);
    expect(comparison.entity.entity_id).toBe('text');
    expect(comparison.database.entity_id).toBe('uuid');
  });

  it('catches a timestamptz mapped as a bare timestamp', () => {
    // The fold that is deliberately NOT made. Losing the time zone is a real
    // defect — the retry gate would be compared against the wrong instant — so
    // these stay separate families however similar the spellings look.
    const drifted = withColumn('updated_at', { type: 'timestamp without time zone' });
    const comparison = compareTypeFamilies(drifted, LIVE);

    expect(comparison.entity).not.toEqual(comparison.database);
    expect(typeFamily('timestamp without time zone')).not.toBe(typeFamily('timestamptz'));
  });

  it('catches a jsonb mapped as text', () => {
    expect(typeFamily('jsonb')).not.toBe(typeFamily('text'));
    expect(typeFamily('jsonb')).not.toBe(typeFamily('json'));
  });

  it('reports drift on the shared columns only, so one rename does not fail four checks', () => {
    const drifted = withColumn('reason', { name: 'why' });
    const nullability = compareNullability(drifted, LIVE);

    // `why` is absent from both sides of the nullability comparison; the rename
    // is reported once, by columnsWithNoDdl/columnsWithNoProperty, instead of
    // cascading into two more failures that say nothing new.
    expect(nullability.entity).toEqual(nullability.database);
    expect(nullability.entity).not.toHaveProperty('why');
    expect(nullability.entity).not.toHaveProperty('reason');
  });

  it('catches a reordered primary key, which a set comparison would not', () => {
    const declaredPk = ['entity_id', 'entity_type', 'stage'];

    expect(declaredPk).not.toEqual(LIVE.primaryKey);
    // The same three columns — which is why this has to be an ordered
    // comparison. A composite index only serves a lookup that binds its leading
    // columns, and THE ONE RULE binds entity_type first.
    expect([...declaredPk].sort()).toEqual([...LIVE.primaryKey].sort());
  });
});
