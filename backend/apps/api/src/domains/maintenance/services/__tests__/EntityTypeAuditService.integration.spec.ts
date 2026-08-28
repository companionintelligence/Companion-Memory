import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import { GraphIngestService } from '@ci/domains/graph';
import { CONTACT_STAGED_TYPE, isShortCode } from '@ci/domains/import';
import { type TrustMode } from '@ci/domains/personalization';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import {
  ALL_TRUST_MODES,
  personalizationWithTrustMode,
} from '../../../__tests__/support/personalizationTrustMode';
import {
  EntityTypeAuditService,
  KEYED_AS_CONTACT_SCORE,
  PHONE_SHAPED_SQL,
  UNPROVEN_KEY_SCORE,
} from '../EntityTypeAuditService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE CLAIMS THAT LET THIS AUDIT RUN ON A TIMER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **It never writes user data.** Under the default trust mode — and under
 *     `hands_off`, the only mode that can answer `auto` — `ci.entities` and
 *     `ci_search.*` must come out of a run byte-identical. A mocked DataSource
 *     cannot show that: the only proof is running the real SQL against the real
 *     schema and reading the rows back.
 *  2. **A proposal carries the new linked_id, not just the new type**, and it
 *     records that leaving `Person` strands the person search index. Both are
 *     columns, and both are what an eventual atomic apply would read.
 *  3. **The SQL window is a superset of the classifier.** The window prefilters
 *     on PHONE_SHAPED restated in POSIX; the digit threshold stays in
 *     `isShortCode`. If the prefilter ever narrowed past the classifier, rows
 *     would go unaudited silently, so the implication is asserted against the
 *     live regex engine rather than by eye.
 *
 * `PersonalizationService` is the real one (see `personalizationTrustMode.ts`:
 * only the two reads that fetch a trust mode off the self Person are doubled),
 * so `decide()` and `profileForTrustMode()` run untouched. What it can and
 * cannot answer for this call shape is pinned in `entityTypeAuditGate.spec.ts`.
 *
 * Fixtures are COMMITTED rather than wrapped in an outer transaction: the
 * service takes a DataSource and runs each statement on its own pooled
 * connection. Teardown deletes them by owner.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/EntityTypeAuditService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

describeWithDatabase(`EntityTypeAuditService against the live schema (${availability.target})`, () => {
  let dataSource: DataSource;

  const userId = randomUUID();
  /** A Google Voice SMS short code that landed as a Person. The thing being found. */
  const shortCode = randomUUID();
  const SHORT_CODE_NAME = '262966';
  /** A real contact whose display name is their full number. Must be left alone. */
  const realContact = randomUUID();
  const REAL_CONTACT_NAME = '+1 (555) 010-9999';
  /**
   * The case only the digit THRESHOLD separates: same phone shape, same absence
   * of any identifier or `properties.phones`, seven-plus digits. Nothing but
   * `isShortCode` distinguishes it from the short code above.
   */
  const bareNumberPerson = randomUUID();
  const BARE_NUMBER_NAME = '5550107777';

  const contactLinkedId = (name: string): string =>
    GraphIngestService.linkedIdFor(`${CONTACT_STAGED_TYPE}:${name.trim().toLowerCase()}`);

  const auditFor = (trustMode: TrustMode | null): EntityTypeAuditService =>
    new EntityTypeAuditService(dataSource, personalizationWithTrustMode(trustMode), noopLogger);

  const proposals = async (): Promise<Array<Record<string, unknown>>> =>
    (await dataSource.query(
      `SELECT entity_id, current_entity_type, proposed_entity_type, current_linked_id,
              proposed_linked_id, proposed_natural_key, conflicting_entity_id,
              search_index_action, search_index_rows, score, autonomy, status,
              detected_by, detector_version, evidence
         FROM ci.entity_type_proposals
        WHERE owner_user_id = $1
        ORDER BY score DESC`,
      [userId],
    )) as Array<Record<string, unknown>>;

  const entityRow = async (entityId: string): Promise<Record<string, unknown>> => {
    const [row] = (await dataSource.query(
      'SELECT entity_type, linked_id, updated_at FROM ci.entities WHERE entity_id = $1',
      [entityId],
    )) as Array<Record<string, unknown>>;

    return row;
  };

  const indexRowCount = async (entityId: string): Promise<number> => {
    const [row] = (await dataSource.query(
      `SELECT (SELECT count(*) FROM ci_search.vectors    WHERE entity_id = $1::uuid)
            + (SELECT count(*) FROM ci_search.embeddings WHERE entity_id = $1::uuid)
            + (SELECT count(*) FROM ci.pipeline_state    WHERE entity_id = $1::uuid) AS n`,
      [entityId],
    )) as Array<{ n: string }>;

    return Number(row.n);
  };

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('databaseAvailability() said available but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      database: connection.database,
      synchronize: false,
      logging: false,
    });

    await dataSource.initialize();
    await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params),
      'entity-type-audit',
      userId,
    );

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, owner_user_id, entity_type, name, linked_table, linked_id, properties)
            VALUES ($1, $2, 'Person', $3, 'import:google_voice', $4, '{"names": ["262966"]}'::jsonb),
                   ($5, $2, 'Person', $6, 'import:google_voice', $7,
                    '{"names": ["Sam"], "phones": ["5550109999"]}'::jsonb),
                   ($8, $2, 'Person', $9, 'import:google_voice', $10, '{"names": ["5550107777"]}'::jsonb)`,
      [
        shortCode,
        userId,
        SHORT_CODE_NAME,
        contactLinkedId(SHORT_CODE_NAME),
        realContact,
        REAL_CONTACT_NAME,
        contactLinkedId('5550109999'),
        bareNumberPerson,
        BARE_NUMBER_NAME,
        contactLinkedId(BARE_NUMBER_NAME),
      ],
    );

    // The person-search rows the short code should never have had — the half a
    // retype has to dismantle in the same transaction.
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, user_id)
            VALUES (ci.gen_uuid_v7(), 'person', $1, $2)`,
      [shortCode, userId],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
            VALUES (ci.gen_uuid_v7(), 'person', $1, $2)`,
      [shortCode, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, stage_version, status, user_id)
            VALUES ('person', $1, 'index.embed_person', 1, 'done', $2)`,
      [shortCode, userId],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.entity_type_proposals WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.pipeline_state WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM ci.entity_type_proposals WHERE owner_user_id = $1', [userId]);
  });

  it('proposes a retype for the short code and carries the new linked_id with it', async () => {
    const result = await auditFor(null).audit(userId);

    expect(result.findings).toBe(1);
    expect(result.proposed).toBe(1);

    const [proposal] = await proposals();

    expect(proposal.entity_id).toBe(shortCode);
    expect(proposal.current_entity_type).toBe('Person');
    expect(proposal.proposed_entity_type).toBe('Concept');
    expect(proposal.proposed_natural_key).toBe('short_code:262966');
    // A type change moves the natural key. Both halves, or the next import
    // mints a second entity for a code that already has one.
    expect(proposal.proposed_linked_id).toBe(GraphIngestService.linkedIdFor('short_code:262966'));
    expect(proposal.current_linked_id).toBe(contactLinkedId(SHORT_CODE_NAME));
    expect(proposal.proposed_linked_id).not.toBe(proposal.current_linked_id);
    expect(Number(proposal.score)).toBe(KEYED_AS_CONTACT_SCORE);
    expect(proposal.status).toBe('pending');
  });

  it('records that the retype must purge the person search index, and what is there', async () => {
    await auditFor(null).audit(userId);

    const [proposal] = await proposals();

    expect(proposal.search_index_action).toBe('purge_person_index');
    expect(proposal.search_index_rows).toEqual({
      vectors: 1,
      embeddings: 1,
      index_skips: 0,
      pipeline_state: 1,
    });
  });

  it('leaves a Person whose name is a reachable number alone', async () => {
    const result = await auditFor(null).audit(userId);

    // All three fixtures are phone-shaped, so all three reach the classifier:
    // the window narrows on SHAPE and the digit threshold decides.
    expect(result.examined).toBe(3);

    const filed = await proposals();

    expect(filed.map((row) => row.entity_id)).toEqual([shortCode]);
    expect(await entityRow(realContact)).toMatchObject({ entity_type: 'Person' });
    // Nothing but isShortCode separates this row from the short code: same
    // shape, same empty properties, no identifiers.
    expect(await entityRow(bareNumberPerson)).toMatchObject({ entity_type: 'Person' });
  });

  it('UPDATEs nothing under the default trust mode', async () => {
    const before = await entityRow(shortCode);
    const indexBefore = await indexRowCount(shortCode);

    const result = await auditFor(null).audit(userId);

    expect(result.proposed).toBe(1);
    expect((await proposals())[0].autonomy).toBe('review');
    expect(await entityRow(shortCode)).toEqual(before);
    expect(await indexRowCount(shortCode)).toBe(indexBefore);
  });

  it('UPDATEs nothing in hands_off either — the dial decision is recorded, not obeyed', async () => {
    const before = await entityRow(shortCode);
    const indexBefore = await indexRowCount(shortCode);

    await auditFor('hands_off').audit(userId);

    expect((await proposals())[0].autonomy).toBe('auto');
    expect(await entityRow(shortCode)).toEqual(before);
    expect(await indexRowCount(shortCode)).toBe(indexBefore);
  });

  it('files in every trust mode, and gives only hands_off an auto', async () => {
    const expected = [
      [null, 'review'],
      ['cautious', 'review'],
      ['balanced', 'review'],
      ['hands_off', 'auto'],
    ] as const;

    expect(expected.map(([trustMode]) => trustMode)).toEqual([...ALL_TRUST_MODES]);

    for (const [trustMode, autonomy] of expected) {
      const result = await auditFor(trustMode).audit(userId);
      const filed = await proposals();

      // The dial picks the autonomy a proposal is FILED with; it has no answer
      // that withholds the row, which is why the result carries no `skipped`.
      expect([trustMode, result.findings, result.proposed, filed.length]).toEqual([trustMode, 1, 1, 1]);
      expect([trustMode, filed[0].autonomy]).toEqual([trustMode, autonomy]);
    }
  });

  it('rescores in place rather than piling up, and never resurrects a rejected proposal', async () => {
    await auditFor('hands_off').audit(userId);
    await dataSource.query(
      `UPDATE ci.entity_type_proposals SET status = 'rejected' WHERE owner_user_id = $1`,
      [userId],
    );

    await auditFor(null).audit(userId);

    const filed = await proposals();

    expect(filed).toHaveLength(1);
    expect(filed[0].status).toBe('rejected');
    // The window excludes a settled proposal, so the human's decision is not
    // even rescored back to `review`.
    expect(filed[0].autonomy).toBe('auto');
  });

  it('caps a proposal whose target coordinate is already occupied', async () => {
    const occupant = randomUUID();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, owner_user_id, entity_type, name, linked_table, linked_id)
            VALUES ($1, $2, 'Concept', $3, 'import:google_voice', $4)`,
      [occupant, userId, SHORT_CODE_NAME, GraphIngestService.linkedIdFor('short_code:262966')],
    );

    try {
      await auditFor('hands_off').audit(userId);

      const [proposal] = await proposals();

      expect(proposal.conflicting_entity_id).toBe(occupant);
      expect(Number(proposal.score)).toBe(UNPROVEN_KEY_SCORE);
      // Below 0.7, so not even hands_off may pre-authorise it.
      expect(proposal.autonomy).toBe('review');
    } finally {
      await dataSource.query('DELETE FROM ci.entities WHERE entity_id = $1', [occupant]);
    }
  });

  it('prefilters with a strict superset of isShortCode', async () => {
    const samples = [
      '262966',
      '411',
      '+411',
      '1112',
      '888222',
      '  32665  ',
      '+1 (555) 010-9999',
      '5550109999',
      'Adrian Kelly',
      'alice@example.invalid',
      '',
      'Group Conversation',
    ];

    for (const sample of samples) {
      const [row] = (await dataSource.query(`SELECT btrim($1, E' \\t\\r\\n') ~ $2 AS shaped`, [
        sample,
        PHONE_SHAPED_SQL,
      ])) as Array<{ shaped: boolean }>;

      // One direction only, and deliberately: the SQL is a cheap narrowing, and
      // `isShortCode` — with the single digit threshold — decides.
      expect([sample, !isShortCode(sample) || row.shaped]).toEqual([sample, true]);
    }
  });
});
