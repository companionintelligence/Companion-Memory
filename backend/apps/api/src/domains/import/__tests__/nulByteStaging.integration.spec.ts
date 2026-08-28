import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * A record carrying U+0000 must stage, not fail its batch.
 *
 * JSON allows `\u0000` and real exports contain it — a Discord package held one
 * message with a pasted WebGL shader log, NUL terminators included. Postgres
 * rejects U+0000 in text and jsonb, so before `StagedWriter` stripped it the
 * INSERT failed with `unsupported Unicode escape sequence`, and one poisoned
 * record discarded its whole batch plus every batch queued after it.
 *
 * Against real Postgres because the failure lives in the driver/DB boundary:
 * a mocked repository accepts any string, which is exactly how this shipped.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/nulByteStaging.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`NUL bytes in staged records (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());
  });

  afterAll(async () => {
    await teardown();
  });

  it('stages an item, entity and edge whose strings carry U+0000', async () => {
    const { writer, runId } = await harness.writerFor('discord');

    writer.push({
      item: {
        classification: 'com.discord.message',
        timestamp: new Date('2021-12-21T00:00:00Z'),
        metadata: {
          text: 'Program Info Log: Vertex shader is not compiled.\n\u0000\nVERTEX',
          ['bad\u0000key']: 'value',
        },
      },
      entity: {
        type: 'person',
        name: 'some\u0000one',
        attributes: [{ name: 'email', value: 'nul\u0000case@example.invalid', identity: true }],
      },
      edges: [
        {
          relation: 'from',
          to: {
            entity: {
              type: 'person',
              name: 'peer',
              attributes: [{ name: 'email', value: 'peer@example.invalid', identity: true }],
            },
          },
          metadata: { channel: 'group\u0000dm' },
        },
      ],
    });

    // The regression: this threw `unsupported Unicode escape sequence`.
    await writer.settled();

    const items = await harness.dataSource.query<Array<{ metadata: Record<string, unknown> }>>(
      `SELECT metadata FROM ci_import.staged_items WHERE run_id = $1::uuid`,
      [runId],
    );

    expect(items).toHaveLength(1);
    expect(items[0].metadata.text).toBe('Program Info Log: Vertex shader is not compiled.\n\nVERTEX');
    expect(items[0].metadata.badkey).toBe('value');

    const entities = await harness.dataSource.query<Array<{ name: string; identity_key: string | null }>>(
      `SELECT name, identity_key FROM ci_import.staged_entities WHERE run_id = $1::uuid ORDER BY name`,
      [runId],
    );

    expect(entities.map((row) => row.name)).toEqual(['peer', 'someone']);

    for (const row of entities) {
      expect(row.identity_key ?? '').not.toContain('\u0000');
    }

    const edges = await harness.dataSource.query<Array<{ metadata: Record<string, unknown> }>>(
      `SELECT sr.metadata FROM ci_import.staged_relationships sr
        WHERE sr.run_id = $1::uuid AND sr.relation = 'from'`,
      [runId],
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].metadata.channel).toBe('groupdm');
  });
});
