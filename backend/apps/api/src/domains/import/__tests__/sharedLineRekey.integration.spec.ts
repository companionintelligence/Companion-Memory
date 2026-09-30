import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DataSource, type DataSourceOptions } from 'typeorm';

import {
  EntityIdentifierEntity,
  EntityIdentifierService,
  GraphIngestService,
  type ImportedEntityRekey,
  NodeEntity,
  RelationshipEntity,
} from '@ci/domains/graph';
import { BaseEntity, GraphDeltaWriter, PersonEntity, PersonMergeService } from '@ci/domains/memory';

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
 * build of the parser. Merges into such a row are made by the real
 * `PersonMergeService`. Invented data throughout.
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

  describe('when the collapsed row is a merge survivor', () => {
    let merging: DataSource;
    let merges: PersonMergeService;

    beforeAll(async () => {
      const quiet = {
        setContext: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      } as never;

      // PersonMergeService works through PersonEntity, which the staging
      // harness does not register: a second connection to the same database.
      merging = new DataSource({
        ...harness.dataSource.options,
        entities: [BaseEntity, PersonEntity],
      } as DataSourceOptions);
      await merging.initialize();

      merges = new PersonMergeService(
        merging.getRepository(PersonEntity),
        quiet,
        { send: jest.fn(async () => undefined) } as never,
        new GraphDeltaWriter(merging, quiet),
      );
    });

    afterAll(async () => {
      if (merging?.isInitialized) {
        await merging.destroy();
      }
    });

    const scope = () => ({ userId: harness.userId });

    /** A Person another lane minted, a mail or phone participant, at no import coordinate. */
    async function stub(name: string | null, properties: Record<string, unknown>): Promise<string> {
      const [{ entity_id }] = await harness.dataSource.query<Array<{ entity_id: string }>>(
        `INSERT INTO ci.entities (entity_type, name, properties, owner_user_id)
         VALUES ('Person', $1, $2::jsonb, $3::uuid)
         RETURNING entity_id`,
        [name, JSON.stringify(properties), harness.userId],
      );

      return entity_id;
    }

    async function update(sql: string, params: unknown[]): Promise<void> {
      await harness.dataSource.query(sql, params);
    }

    async function propertiesOf(entityId: string): Promise<Record<string, unknown>> {
      const [row] = await harness.dataSource.query<Array<{ properties: Record<string, unknown> }>>(
        `SELECT properties FROM ci.entities WHERE entity_id = $1::uuid`,
        [entityId],
      );

      return row.properties;
    }

    async function mergedInto(entityIds: string[]): Promise<Array<string | null>> {
      const rows = await harness.dataSource.query<
        Array<{ entity_id: string; merged_into_entity_id: string | null }>
      >(`SELECT entity_id, merged_into_entity_id FROM ci.entities WHERE entity_id = ANY($1::uuid[])`, [
        entityIds,
      ]);

      return entityIds.map((id) => rows.find((row) => row.entity_id === id)?.merged_into_entity_id ?? null);
    }

    it('keeps what the heir’s own merges brought in, and lets go of what a colleague’s did', async () => {
      await pushTheOldWay({
        name: 'Mei Chen',
        identityKey: '5550100300',
        metadata: {
          Source: 'vCard',
          Names: ['Mei Chen', 'Arjun Rao'],
          Emails: ['mei@example.org', 'arjun@example.org'],
          Phones: ['(555) 010-0300', '(555) 010-0342'],
        },
      });
      const collapsed = (await personAt('contact:5550100300'))!;

      // Mei's own mail stub, merged into what showed as her card. And two of
      // Arjun's, which the collapse itself pulled in because the row carried
      // his address and his line: the auto-merge folds a shared email whatever
      // the names say, and a stub named by its number says nothing.
      const meiMail = await stub('Mei Chen', {
        names: ['Mei Chen'],
        emails: ['mei.chen@mail.example'],
        phones: ['5550100377', '5550100399'],
        Phones: ['+1 555-010-0377', '+1 555-010-0399'],
      });
      const arjunMail = await stub('Arjun Rao', { names: ['Arjun Rao'], emails: ['arjun@example.org'] });
      const arjunLine = await stub('+1 (555) 010-0342', {
        phones: ['5550100342'],
        Phones: ['+1 (555) 010-0342'],
      });

      await merges.mergePeople(scope(), [meiMail, arjunMail, arjunLine], collapsed.entity_id);

      // A later repair took 555-0399 off Mei's stub: it was never hers.
      await update(
        `UPDATE ci.entities
            SET properties = properties || '{"phones": ["5550100377"], "Phones": ["+1 555-010-0377"]}'::jsonb
          WHERE entity_id = $1::uuid`,
        [meiMail],
      );

      // The row as the reset left it, read between the move and the ingest
      // after it. What survives the whole push is the ingest's call: today it
      // replaces the bag with the card's, and once refresh-as-merge lands it
      // unions the card into this.
      const rekey = graph.rekeyImportedEntities.bind(graph);
      const planned: ImportedEntityRekey[] = [];
      let rebuilt: Record<string, unknown> | null = null;
      const spy = jest.spyOn(graph, 'rekeyImportedEntities').mockImplementation(async (context, moves) => {
        planned.push(...moves);
        const moved = await rekey(context, moves);
        rebuilt = await propertiesOf(collapsed.entity_id);

        return moved;
      });

      try {
        await importVcf(
          'BEGIN:VCARD\nFN:Mei Chen\nEMAIL:mei@example.org\nTEL;TYPE=WORK:(555) 010-0300\nEND:VCARD\n' +
            'BEGIN:VCARD\nFN:Arjun Rao\nEMAIL:arjun@example.org\nTEL;TYPE=WORK:(555) 010-0300\n' +
            'TEL;TYPE=CELL:(555) 010-0342\nEND:VCARD\n',
        );
      } finally {
        spy.mockRestore();
      }

      // Both of Arjun's stubs were told apart from Mei's…
      expect(planned).toEqual([
        expect.objectContaining({ fromKey: 'contact:5550100300', toKey: 'contact:mei@example.org' }),
      ]);
      expect([...(planned[0].dropMergedFrom ?? [])].sort()).toEqual([arjunMail, arjunLine].sort());

      // …so the reset kept what Mei's stub still vouches for, and nothing of
      // the cards' or of Arjun's.
      expect(rebuilt).toEqual({
        emails: ['mei.chen@mail.example'],
        phones: ['5550100377'],
        names: ['Mei Chen'],
        Phones: ['+1 555-010-0377'],
      });

      // The row is Mei's, with none of Arjun on it whichever way ingest folds…
      const mei = (await personAt('contact:mei@example.org'))!;
      expect(mei.entity_id).toBe(collapsed.entity_id);
      expect(mei.name).toBe('Mei Chen');
      expect(JSON.stringify(mei.properties)).not.toMatch(/arjun|0342/i);

      // …Arjun is a person of his own, and every merge still stands.
      expect((await personAt('contact:5550100342'))?.name).toBe('Arjun Rao');
      expect(await mergedInto([meiMail, arjunMail, arjunLine])).toEqual([
        collapsed.entity_id,
        collapsed.entity_id,
        collapsed.entity_id,
      ]);
    });

    it('keeps only what a merge that still stands brought in, as the survivor repair reads one', async () => {
      await pushTheOldWay({
        name: 'Rosa Diaz',
        identityKey: '5550100400',
        metadata: { Source: 'vCard', Names: ['Rosa Diaz'], Phones: ['(555) 010-0455'] },
      });
      const row = (await personAt('contact:5550100400'))!;

      // One hop. A stub was merged into another Person, and that Person into
      // this row; in between, a pre-fix re-import of that Person's card erased
      // the stub's address, and #2796's repair has since put it back on this
      // row. A reset after the repair must not take it off again.
      const middle = await stub('Rosa M. Diaz', { names: ['Rosa M. Diaz'], Phones: ['555.010.0455'] });
      const hop = await stub('Rosa D.', { emails: ['rosa.d@mail.example'] });

      await merges.mergePeople(scope(), [hop], middle);
      await update(
        `UPDATE ci.entities SET properties = '{"names": ["Rosa M. Diaz"], "Phones": ["555.010.0455"]}'::jsonb
          WHERE entity_id = $1::uuid`,
        [middle],
      );

      // And merges that no longer stand, or no longer vouch for a value.
      const elsewhere = await stub('Somebody Else', {});
      const repointed = await stub('Rosa', { phones: ['5550100411'] });
      const retyped = await stub('Rosa Diaz', { Faxes: ['555-010-0419'] });
      const renamed = await stub('Missed call from Rosa', { names: ['Missed call from Rosa'] });
      const released = await stub('Rosa Diaz', { emails: ['rosa.diaz@mail.example'] });

      await merges.mergePeople(scope(), [middle, repointed, retyped, renamed, released], row.entity_id);

      // A tombstone that points somewhere else now…
      await update(`UPDATE ci.entities SET merged_into_entity_id = $2::uuid WHERE entity_id = $1::uuid`, [
        repointed,
        elsewhere,
      ]);
      // …one a repair retyped out of Person…
      await update(`UPDATE ci.entities SET entity_type = 'Concept' WHERE entity_id = $1::uuid`, [retyped]);
      // …one whose junk name a repair rewrote, into a name the row holds anyway…
      await update(
        `UPDATE ci.entities SET properties = '{"names": ["Rosa Diaz"]}'::jsonb WHERE entity_id = $1::uuid`,
        [renamed],
      );
      // …and the repair's restore of the one-hop address, as it leaves the row.
      await update(
        `UPDATE ci.entities
            SET properties = jsonb_set(properties, '{emails}', (properties -> 'emails') || '["rosa.d@mail.example"]')
          WHERE entity_id = $1::uuid`,
        [row.entity_id],
      );

      const moved = await graph.rekeyImportedEntities(scope(), [
        {
          entityType: 'Person',
          sourceSystem: 'vcard',
          fromKey: 'contact:5550100400',
          toKey: 'contact:rosa@example.org',
          resetProperties: true,
          dropMergedFrom: [released],
        },
      ]);

      expect(moved).toEqual([expect.objectContaining({ entityId: row.entity_id })]);
      // The typed number comes through in the row's own spelling: the fold
      // compares `Phones` by digits and kept the first it saw.
      expect(await propertiesOf(row.entity_id)).toEqual({
        emails: ['rosa.d@mail.example'],
        names: ['Rosa M. Diaz'],
        Phones: ['(555) 010-0455'],
      });
    });
  });
});
