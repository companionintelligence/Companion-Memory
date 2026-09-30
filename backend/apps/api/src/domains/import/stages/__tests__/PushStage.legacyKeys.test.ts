import { PushStage } from '../PushStage';

/**
 * The push moves a contact's old Person row onto its new key BEFORE ingest
 * looks it up — otherwise a contact whose key moved (an office line or a fax
 * stopped being its key) is minted a second time beside its old row.
 *
 * The ordering is the whole contract: ingest resolves by key alone, so a move
 * that lands after it has already minted the duplicate. Invented data.
 */

type EntityPusher = {
  pushEntities(
    context: { runId: string; userId: string; progress: (p: unknown) => Promise<void> },
    trustMode: string,
    selfEntityId: string | null,
  ): Promise<{ resolved: number; failed: number }>;
};

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

interface StagedRow {
  name: string;
  identityKey: string | null;
  legacyIdentityKey: string | null;
}

function stageWith(rows: StagedRow[], legacyRowName: string | null) {
  const staged = rows.map((row, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    runId: RUN_ID,
    userId: USER_ID,
    type: 'contact',
    metadata: {},
    dataSource: 'vcard',
    ...row,
  }));

  const dataSource = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM ci_import.staged_entities')) {
        return staged;
      }

      if (
        sql.includes('UPDATE ci_import.staged_entities') ||
        sql.includes('INSERT INTO ci_import.entity_mappings')
      ) {
        return [];
      }

      // readSelfIdentity's lookups: its caller swallows a failure.
      throw new Error(`unexpected query: ${sql}`);
    }),
  };

  const graph = {
    findImportedEntities: jest.fn(
      async (_ctx: unknown, refs: Array<{ entityType: string; sourceSystem: string; key: string }>) =>
        refs
          .filter((ref) => ref.key === 'contact:5550100100')
          .map((ref) => ({
            ...ref,
            entityId: 'collapsed-row',
            name: legacyRowName,
            mergedIntoEntityId: null,
          })),
    ),
    rekeyImportedEntities: jest.fn(async (_ctx: unknown, moves: Array<Record<string, string>>) =>
      moves.map((move) => ({ ...move, entityId: 'collapsed-row' })),
    ),
    ingest: jest.fn(async (_ctx: unknown, input: { entities: Array<{ key: string }> }) => ({
      entities: input.entities.map((e, i) => ({ key: e.key, entityId: `entity-${i}` })),
      relationships: [],
      errors: [],
    })),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };

  const noop = {} as never;
  const stage = new PushStage(
    dataSource as never,
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
  ) as unknown as EntityPusher;

  return { stage, graph };
}

const context = { runId: RUN_ID, userId: USER_ID, progress: async () => undefined };

describe('PushStage moving contacts onto their new keys', () => {
  // Three colleagues who all used to key on the switchboard, 555-0100.
  const office: StagedRow[] = [
    { name: 'Priya Natarajan', identityKey: 'priya@example.com', legacyIdentityKey: '5550100100' },
    { name: 'Tom Becker', identityKey: 'tom@example.com', legacyIdentityKey: '5550100100' },
    { name: 'Lena Ortiz', identityKey: '5550100142', legacyIdentityKey: '5550100100' },
  ];

  it('moves the collapsed row to the colleague it is named after, before ingest', async () => {
    const { stage, graph } = stageWith(office, 'Priya Natarajan');

    const result = await stage.pushEntities(context, 'balanced', null);

    expect(result.resolved).toBe(3);
    expect(graph.rekeyImportedEntities).toHaveBeenCalledWith({ userId: USER_ID }, [
      {
        entityType: 'Person',
        sourceSystem: 'vcard',
        fromKey: 'contact:5550100100',
        toKey: 'contact:priya@example.com',
        resetProperties: true,
      },
    ]);
    expect(graph.rekeyImportedEntities.mock.invocationCallOrder[0]).toBeLessThan(
      graph.ingest.mock.invocationCallOrder[0],
    );
  });

  it('asks about the old key and every new key in one lookup', async () => {
    const { stage, graph } = stageWith(office, 'Priya Natarajan');

    await stage.pushEntities(context, 'balanced', null);

    expect(graph.findImportedEntities).toHaveBeenCalledTimes(1);
    expect(graph.findImportedEntities.mock.calls[0][1].map((ref: { key: string }) => ref.key).sort()).toEqual(
      ['contact:5550100100', 'contact:5550100142', 'contact:priya@example.com', 'contact:tom@example.com'],
    );
  });

  it('moves nothing when the old row is named after none of them', async () => {
    const { stage, graph } = stageWith(office, 'Grace Whitaker');

    await stage.pushEntities(context, 'balanced', null);

    expect(graph.findImportedEntities).toHaveBeenCalledTimes(1);
    expect(graph.rekeyImportedEntities).not.toHaveBeenCalled();
    expect(graph.ingest).toHaveBeenCalledTimes(1);
  });

  it('never looks when no key moved — the push of every other source is untouched', async () => {
    const { stage, graph } = stageWith(
      [{ name: 'Omar Haddad', identityKey: '5550100177', legacyIdentityKey: null }],
      null,
    );

    await stage.pushEntities(context, 'balanced', null);

    expect(graph.findImportedEntities).not.toHaveBeenCalled();
    expect(graph.rekeyImportedEntities).not.toHaveBeenCalled();
    expect(graph.ingest).toHaveBeenCalledTimes(1);
  });
});
