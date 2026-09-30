import { DatabaseCrashedError } from '@ci/common/persistence';
import { GraphIngestService } from '@ci/domains/graph';

import { DatabaseCrashedDuringPushError } from '../DatabaseCrashedDuringPushError';
import { PushStage } from '../PushStage';

/**
 * The push's side of the truncated-phone re-key: which cards it offers, that
 * it runs BEFORE ingest (after would be too late — ingest would already have
 * minted the duplicate), and that it is best effort. What the re-key does to
 * the rows is `truncatedPhoneRekey.integration.spec.ts`, against Postgres.
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

const OFFICE_CARD = {
  id: '00000000-0000-4000-8000-000000000001',
  runId: RUN_ID,
  userId: USER_ID,
  type: 'contact',
  name: 'Dana Quill',
  metadata: { Phones: ['(212) 555-0147;229'], Emails: ['dana.quill@example.com'] },
  identityKey: 'dana.quill@example.com',
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
  dataSource: 'apple_contacts',
};

function stageWith(transaction: jest.Mock) {
  const order: string[] = [];

  const dataSource = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM ci_import.staged_entities')) {
        return [OFFICE_CARD, PLAIN_CARD];
      }

      // Ledger writes and readSelfIdentity's lookups: nothing to report.
      return [];
    }),
    transaction: jest.fn(async (...args: unknown[]) => {
      order.push('rekey');

      return transaction(...args);
    }),
  };

  const graph = {
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

describe('PushStage — moving contacts off truncated phone keys', () => {
  it('offers only the card whose typed extension line was its key, and before ingest', async () => {
    const probes: unknown[] = [];
    const manager = {
      query: jest.fn(async (_sql: string, params: unknown[]) => {
        probes.push(JSON.parse(String(params[2])));

        // Nothing sits at the old coordinate: a first import on the fixed parser.
        return [];
      }),
    };
    const { stage, order } = stageWith(
      jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
    );

    const result = await stage.pushEntities(CONTEXT, 'balanced', null);

    expect(result).toMatchObject({ resolved: 2, failed: 0 });
    expect(order).toEqual(['rekey', 'ingest']);
    expect(probes).toEqual([
      [
        expect.objectContaining({
          old_linked_id: GraphIngestService.linkedIdFor('contact:5550147229'),
          new_linked_id: GraphIngestService.linkedIdFor('contact:dana.quill@example.com'),
          old_key: '5550147229',
          linked_table: 'import:apple_contacts',
          data_source: 'apple_contacts',
          staged_type: 'contact',
        }),
      ],
    ]);
  });

  it('pushes on, minting as before, when the re-key fails for a reason about the rows', async () => {
    const refusal = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const { stage, graph, logger } = stageWith(jest.fn(async () => Promise.reject(refusal)));

    const result = await stage.pushEntities(CONTEXT, 'balanced', null);

    expect(result).toMatchObject({ resolved: 2, failed: 0 });
    expect(graph.ingest).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not move contacts off truncated phone keys; they resolve as new rows',
      expect.objectContaining({ candidates: 1, error: refusal.message }),
    );
  });

  it('fails the push when the database went away under it, as the ingest would', async () => {
    const crash = new DatabaseCrashedError(
      'moving contacts off truncated phone keys',
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

  it('never touches the database for a run with no such card', async () => {
    const transaction = jest.fn();
    const { stage, dataSource } = stageWith(transaction);
    dataSource.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM ci_import.staged_entities') ? [PLAIN_CARD] : [],
    );

    await stage.pushEntities(CONTEXT, 'balanced', null);

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
