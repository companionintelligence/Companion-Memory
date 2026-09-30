import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EntityIdentifierEntity,
  EntityIdentifierService,
  GraphIngestService,
  NodeEntity,
  RelationshipEntity,
} from '@ci/domains/graph';
import { GraphDeltaWriter } from '@ci/domains/memory';

import type { ImportParams } from '../datasources/timeline';
import { VCardFileImporter } from '../datasources/vcard';
import { findCheck } from '../doctor/checks';
import { PushStage } from '../stages/PushStage';
import type { StageRunContext } from '../types';

import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COLLEAGUES ON ONE OFFICE LINE, AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A vCard used to key on its smallest handle, so colleagues whose cards all list
 * the switchboard keyed on it and were pushed as ONE Person. The parsers now
 * pass over shared handles, which MOVES those contacts' keys — and ingest
 * resolves by key alone. This is the path that keeps a re-import from minting a
 * second Person beside every moved contact, end to end: the real parser, the
 * real StagedWriter, the real push, the real ingest, a real `ci.entities`.
 *
 * The "before" world is written the way the old rule wrote it — one staged row
 * keyed on the switchboard carrying all three names — rather than by an old
 * build of the parser. Invented data throughout.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/sharedLineRekey.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

const OFFICE_VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Priya Natarajan',
  'EMAIL;TYPE=INTERNET;TYPE=pref:priya@example.com',
  'TEL;TYPE=WORK;TYPE=VOICE:(555) 010-0100',
  'TEL;TYPE=WORK;TYPE=FAX:(555) 010-0101',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Tom Becker',
  'EMAIL;TYPE=INTERNET:tom@example.com',
  'TEL;TYPE=CELL;TYPE=pref:(555) 010-0100',
  'TEL:(555) 010-0101',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Lena Ortiz',
  'EMAIL;TYPE=INTERNET:lena@example.com',
  'TEL;TYPE=WORK:(555) 010-0100',
  'TEL;TYPE=CELL:(555) 010-0142',
  'END:VCARD',
  '',
].join('\r\n');

describeWithDatabase(`contacts on a shared office line (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let stage: {
    pushEntities(context: StageRunContext, trustMode: string, selfEntityId: string | null): Promise<unknown>;
  };
  let tmp: string;
  let graph: GraphIngestService;

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());

    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    };
    graph = new GraphIngestService(
      harness.dataSource.getRepository(NodeEntity),
      harness.dataSource.getRepository(RelationshipEntity),
      new EntityIdentifierService(harness.dataSource.getRepository(EntityIdentifierEntity), logger as never),
      logger as never,
      new GraphDeltaWriter(harness.dataSource, logger as never),
    );
    const noop = {} as never;

    // Only the entity lane runs here; every record destination stays a stub.
    stage = new PushStage(
      harness.dataSource,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      graph as never,
      noop,
      logger as never,
    ) as unknown as typeof stage;

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-shared-line-'));
  });

  afterAll(async () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    await teardown();
  });

  function contextFor(runId: string): StageRunContext {
    return {
      userId: harness.userId,
      runId,
      stageId: '44444444-4444-4444-8444-444444444444',
      scratchDir: tmp,
      progress: async () => undefined,
    };
  }

  /** Push one staged row exactly as the OLD rule staged it: keyed on `identityKey`. */
  async function pushTheOldWay(row: {
    name: string;
    identityKey: string;
    metadata: Record<string, unknown>;
  }) {
    const runId = await harness.startRun();

    await harness.dataSource.query(
      `INSERT INTO ci_import.staged_entities (run_id, user_id, type, name, metadata, identity_key, data_source)
            VALUES ($1::uuid, $2::uuid, 'contact', $3, $4::jsonb, $5, 'vcard')`,
      [runId, harness.userId, row.name, JSON.stringify(row.metadata), row.identityKey],
    );

    await stage.pushEntities(contextFor(runId), 'balanced', null);
  }

  /** Import a .vcf the way the parse stage does today, then push it. */
  async function importVcf(raw: string): Promise<void> {
    const file = path.join(tmp, `contacts-${Math.random().toString(36).slice(2)}.vcf`);
    fs.writeFileSync(file, raw);

    const { writer, runId } = await harness.writerFor('vcard');

    await new VCardFileImporter().fileImport({}, { filename: path.basename(file), fullPath: file }, {
      pipeline: writer,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    await writer.settled();

    await stage.pushEntities(contextFor(runId), 'balanced', null);
  }

  async function personAt(key: string) {
    const rows = await harness.dataSource.query<
      Array<{ entity_id: string; name: string | null; properties: Record<string, unknown> }>
    >(
      `SELECT entity_id, name, properties FROM ci.entities
        WHERE owner_user_id = $1::uuid AND entity_type = 'Person'
          AND linked_table = 'import:vcard' AND linked_id = $2::uuid`,
      [harness.userId, GraphIngestService.linkedIdFor(key)],
    );

    return rows[0] ?? null;
  }

  async function vcardPeople(): Promise<string[]> {
    const rows = await harness.dataSource.query<Array<{ name: string }>>(
      `SELECT name FROM ci.entities
        WHERE owner_user_id = $1::uuid AND entity_type = 'Person' AND linked_table = 'import:vcard'
        ORDER BY name`,
      [harness.userId],
    );

    return rows.map((row) => row.name);
  }

  it('separates a collapsed office Person on re-import, keeping the old row for its namesake', async () => {
    await pushTheOldWay({
      name: 'Priya Natarajan',
      identityKey: '5550100100',
      metadata: {
        Source: 'vCard',
        Names: ['Priya Natarajan', 'Tom Becker', 'Lena Ortiz'],
        Emails: ['priya@example.com', 'tom@example.com', 'lena@example.com'],
        Phones: ['(555) 010-0100', '(555) 010-0101', '(555) 010-0142'],
      },
    });

    const collapsed = await personAt('contact:5550100100');
    expect(collapsed?.properties.Names).toEqual(['Priya Natarajan', 'Tom Becker', 'Lena Ortiz']);

    await importVcf(OFFICE_VCF);

    // Nothing is left on the switchboard's key…
    expect(await personAt('contact:5550100100')).toBeNull();

    // …the old row, same id, is Priya's alone now: the ingest after the move
    // rewrote it with her card and nobody else's.
    const priya = await personAt('contact:priya@example.com');
    expect(priya?.entity_id).toBe(collapsed!.entity_id);
    expect(priya?.name).toBe('Priya Natarajan');
    expect(priya?.properties.Names).toEqual(['Priya Natarajan']);
    expect(priya?.properties.Emails).toEqual(['priya@example.com']);

    // …and her colleagues are people of their own.
    expect((await personAt('contact:tom@example.com'))?.name).toBe('Tom Becker');
    expect((await personAt('contact:5550100142'))?.name).toBe('Lena Ortiz');
    expect(await vcardPeople()).toEqual(['Lena Ortiz', 'Priya Natarajan', 'Tom Becker']);
  });

  it('is a no-op the next time the same export is imported', async () => {
    const before = await personAt('contact:priya@example.com');

    await importVcf(OFFICE_VCF);

    expect((await personAt('contact:priya@example.com'))?.entity_id).toBe(before?.entity_id);
    expect(await vcardPeople()).toEqual(['Lena Ortiz', 'Priya Natarajan', 'Tom Becker']);
  });

  it('moves a contact keyed on a fax onto its own line instead of minting it twice', async () => {
    await pushTheOldWay({
      name: 'Omar Haddad',
      identityKey: '5550100150',
      metadata: { Source: 'vCard', Names: ['Omar Haddad'], Phones: ['555-010-0150', '555-010-0177'] },
    });
    const old = await personAt('contact:5550100150');

    await importVcf(
      'BEGIN:VCARD\nFN:Omar Haddad\nTEL;TYPE=WORK;TYPE=FAX:555-010-0150\nTEL:555-010-0177\nEND:VCARD\n',
    );

    expect(await personAt('contact:5550100150')).toBeNull();
    expect((await personAt('contact:5550100177'))?.entity_id).toBe(old?.entity_id);
    expect((await vcardPeople()).filter((name) => name === 'Omar Haddad')).toHaveLength(1);
  });

  it('keeps a collapsed row that no card in the export is named after', async () => {
    // The row carries the name of whoever staged first — here someone this
    // export no longer lists. Handing it to a colleague would give them her
    // history, so it stays, for the doctor check to report.
    await pushTheOldWay({
      name: 'Grace Whitaker',
      identityKey: '5550100200',
      metadata: { Source: 'vCard', Names: ['Grace Whitaker', 'Ines de Souza'] },
    });
    const kept = await personAt('contact:5550100200');

    await importVcf(
      'BEGIN:VCARD\nFN:Ines de Souza\nEMAIL:ines@example.com\nTEL:555-010-0200\nEND:VCARD\n' +
        'BEGIN:VCARD\nFN:Paul de Groot\nEMAIL:paul@example.com\nTEL:555-010-0200\nEND:VCARD\n',
    );

    expect((await personAt('contact:5550100200'))?.entity_id).toBe(kept?.entity_id);
    expect((await personAt('contact:ines@example.com'))?.name).toBe('Ines de Souza');
    expect((await personAt('contact:paul@example.com'))?.name).toBe('Paul de Groot');
  });

  it('empties a moved row\u2019s properties only when asked, under the same free-destination guard', async () => {
    // What makes the heal independent of ingest semantics: a row that held
    // several people starts empty on its new key, so whether ingest replaces
    // properties or unions lists into them, only the heir's card is left.
    await pushTheOldWay({
      name: 'Dana Reyes',
      identityKey: '5550100210',
      metadata: { Source: 'vCard', Names: ['Dana Reyes', 'Sam Tully'] },
    });
    await pushTheOldWay({
      name: 'Ana Ruiz',
      identityKey: '5550100220',
      metadata: { Source: 'vCard', Names: ['Ana Ruiz'] },
    });
    const scope = { userId: harness.userId };
    const move = (fromKey: string, toKey: string, resetProperties: boolean) => ({
      entityType: 'Person',
      sourceSystem: 'vcard',
      fromKey,
      toKey,
      resetProperties,
    });

    const moved = await graph.rekeyImportedEntities(scope, [
      move('contact:5550100210', 'contact:dana@example.com', true),
      move('contact:5550100220', 'contact:ana@example.com', false),
      // Onto a key that is taken: refused by the statement itself.
      move('contact:5550100142', 'contact:priya@example.com', true),
    ]);

    expect(moved.map((m) => m.toKey)).toEqual(['contact:dana@example.com', 'contact:ana@example.com']);
    expect((await personAt('contact:dana@example.com'))?.properties).toEqual({});
    expect((await personAt('contact:ana@example.com'))?.properties.Names).toEqual(['Ana Ruiz']);
    expect((await personAt('contact:5550100142'))?.properties.Names).toEqual(['Lena Ortiz']);
  });

  it('counts a collapsed Person in the doctor check, and not the ways one person is spelled', async () => {
    const check = findCheck('contact-person-merges-several-people')!;
    const runner = harness.dataSource.createQueryRunner();
    await runner.connect();

    try {
      // One snapshot for the baseline and the measurement, with the seeded rows
      // visible only to it: concurrent suites cannot move the delta.
      await runner.startTransaction('REPEATABLE READ');
      const count = async () => Number((await runner.query(check.sql))[0].count);
      const baseline = await count();

      const seed = async (names: string[]) =>
        runner.query(
          `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
           VALUES (gen_random_uuid(), 'Person', $1, $2::jsonb, $3::uuid, 'import:vcard', gen_random_uuid())`,
          [names[0], JSON.stringify({ Names: names }), harness.userId],
        );

      await seed(['Priya Natarajan', 'Tom Becker']);
      await seed(['Matt Okafor', 'Matthew Okafor']);
      await seed(['José Núñez', 'Jose Nunez']);
      await seed(['Dr. Omar Haddad', 'Omar Haddad PhD']);
      await seed(["Tom's mom", 'Grace Whitaker']);
      await seed(['Ana Ruiz', 'Luis Ruiz']);
      await seed(['tom@example.com', 'Grace Whitaker']);
      await seed(['Ines de Souza', 'Paul de Groot']);

      // Two different people: the office pair, and the pair sharing only "de".
      expect((await count()) - baseline).toBe(2);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
