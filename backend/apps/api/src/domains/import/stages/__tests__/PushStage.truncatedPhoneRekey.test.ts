import { DatabaseCrashedError } from '@ci/common/persistence';
import { GraphIngestService } from '@ci/domains/graph';

import { DatabaseCrashedDuringPushError } from '../DatabaseCrashedDuringPushError';
import { PushStage } from '../PushStage';

/**
 * The push's side of undoing a truncated phone key: which cards it offers,
 * that it runs AFTER the legacy-key move (the row must be under the card's key)
 * and BEFORE ingest, and that it is best effort. What the repair does to the
 * rows is `truncatedPhoneRekey.integration.spec.ts`, against Postgres.
 *
 * Numbers are invented: `(212) 555-0147;229` truncated to `5550147229`.
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
const CONTEXT = { runId: RUN_ID, userId: USER_ID, progress: async () => undefined };

/** Staged as `StagedWriter` stages it: the fixed key, and the truncation it was minted under. */
const OFFICE_CARD = {
  id: '00000000-0000-4000-8000-000000000001',
  runId: RUN_ID,
  userId: USER_ID,
  type: 'contact',
  name: 'Dana Quill',
  metadata: { Phones: ['(212) 555-0147;229'], Emails: ['dana.quill@example.com'] },
  identityKey: 'dana.quill@example.com',
  legacyIdentityKey: '5550147229',
  dataSource: 'apple_contacts',
};

const PLAIN_CARD = {
  id: '00000000-0000-4000-8000-000000000002',
  runId: RUN_ID,
  userId: USER_ID,
  type: 'contact',
  name: 'Rae Holt',
  metadata: { Phones: ['(212) 555-0199'] },
  identityKey: '2125550199',
  legacyIdentityKey: null,
  dataSource: 'apple_contacts',
};

function stageWith(transaction: jest.Mock, cards: unknown[] = [OFFICE_CARD, PLAIN_CARD]) {
  const order: string[] = [];

  const dataSource = {
    query: jest.fn(async (sql: string) => (sql.includes('FROM ci_import.staged_entities') ? cards : [])),
    transaction: jest.fn(async (...args: unknown[]) => {
      order.push('repair');

      return transaction(...args);
    }),
  };

  const graph = {
    // The old row, found at the truncated coordinate and moved onto the new key.
    findImportedEntities: jest.fn(async () => {
      order.push('find');

      return [
        {
          entityType: 'Person',
          sourceSystem: 'apple_contacts',
          key: 'contact:5550147229',
          entityId: 'old-row',
          name: 'Dana Quill',
          properties: {},
          mergedIntoEntityId: null,
        },
      ];
    }),
    rekeyImportedEntities: jest.fn(async (_ctx: unknown, moves: Array<Record<string, unknown>>) => {
      order.push('move');

      return moves.map((move) => ({ ...move, entityId: 'old-row' }));
    }),
    ingest: jest.fn(async (_ctx: unknown, input: { entities: Array<{ key: string }> }) => {
      order.push('ingest');

      return {
        entities: input.entities.map((e, i) => ({ key: e.key, entityId: `entity-${i}` })),
        relationships: [],
        errors: [],
      };
    }),
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

  return { stage, order, graph, logger, dataSource };
}

describe('PushStage — undoing what a truncated phone key reached', () => {
  it('offers only the card minted under a truncation, after the move and before ingest', async () => {
    const probes: unknown[] = [];
    const manager = {
      query: jest.fn(async (_sql: string, params: unknown[]) => {
        probes.push(JSON.parse(String(params[2])));

        // Nothing under the card's key: the probe reports it absent.
        return [];
      }),
    };
    const { stage, order, graph } = stageWith(
      jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
    );

    const result = await stage.pushEntities(CONTEXT, 'balanced', null);

    expect(result).toMatchObject({ resolved: 2, failed: 0 });
    expect(order).toEqual(['find', 'move', 'repair', 'ingest']);
    expect(graph.rekeyImportedEntities).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ fromKey: 'contact:5550147229', toKey: 'contact:dana.quill@example.com' }),
    ]);
    // Looked for under the card's CURRENT key — where the row now sits.
    expect(probes).toEqual([
      [
        expect.objectContaining({
          linked_id: GraphIngestService.linkedIdFor('contact:dana.quill@example.com'),
          linked_table: 'import:apple_contacts',
          old_key: '5550147229',
          data_source: 'apple_contacts',
          staged_type: 'contact',
        }),
      ],
    ]);
  });

  it('pushes on, the row keeping what it had, when the repair fails for a reason about the rows', async () => {
    const refusal = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const { stage, graph, logger } = stageWith(jest.fn(async () => Promise.reject(refusal)));

    const result = await stage.pushEntities(CONTEXT, 'balanced', null);

    expect(result).toMatchObject({ resolved: 2, failed: 0 });
    expect(graph.ingest).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not undo what truncated phone keys had reached; the rows keep it',
      expect.objectContaining({ candidates: 1, error: refusal.message }),
    );
  });

  it('fails the push when the database went away under it, as the ingest would', async () => {
    const crash = new DatabaseCrashedError(
      'undoing what truncated phone keys reached',
      new Error('ECONNRESET'),
    );
    const { stage, graph } = stageWith(jest.fn(async () => Promise.reject(crash)));

    // The push's own verdict, with the way back in — the same one the ingest's
    // step would raise — and nothing after it runs.
    await expect(stage.pushEntities(CONTEXT, 'balanced', null)).rejects.toBeInstanceOf(
      DatabaseCrashedDuringPushError,
    );
    expect(graph.ingest).not.toHaveBeenCalled();
  });

  it('never opens a transaction for a run with no such card', async () => {
    const { stage, dataSource } = stageWith(jest.fn(), [PLAIN_CARD]);

    await stage.pushEntities(CONTEXT, 'balanced', null);

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
