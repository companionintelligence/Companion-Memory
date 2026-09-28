import { PushStage, entityErrorMessage, entityErrorMessagesByKey, entityErrorsByKey } from '../PushStage';

/**
 * People resolution when graph ingest fails a whole batch.
 *
 * Ingest reports a batch-level failure once PER INPUT (`entity <key>: <msg>`).
 * The push used to record `errors.join('; ')` against every failed row and log
 * it once per row, so one failed 4,873-entity Google Takeout batch wrote a
 * ~500KB reason into each row and each log line — 552MB of dev log before the
 * worker died with the run stuck at 'running'. Each row must now carry its OWN
 * entry, bounded.
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

function stageWith(count: number, ingestMessage: string) {
  const staged = Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    runId: RUN_ID,
    userId: USER_ID,
    type: 'contact',
    name: `Contact ${i}`,
    metadata: {},
    identityKey: `555010${String(i).padStart(4, '0')}`,
    dataSource: 'google_voice',
  }));
  const marks: Array<{ id: string; status: string; error: string | null }> = [];

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM ci_import.staged_entities')) {
        return staged;
      }

      if (sql.includes('UPDATE ci_import.staged_entities')) {
        marks.push({
          id: String(params[0]),
          status: String(params[1]),
          error: (params[2] as string) ?? null,
        });

        return [];
      }

      // readSelfIdentity's lookups: its caller swallows a failure.
      throw new Error(`unexpected query: ${sql}`);
    }),
  };

  const graph = {
    ingest: jest.fn(async (_ctx: unknown, input: { entities: Array<{ key: string }> }) => ({
      entities: [],
      relationships: [],
      errors: input.entities.map((e) => `entity ${e.key}: ${ingestMessage}`),
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

  return { stage, marks, logger, graph };
}

describe('PushStage people resolution', () => {
  it('charges each failed entity with its own error, not the whole batch', async () => {
    const message = 'bind message has 2686 parameter formats but 0 parameters';
    const { stage, marks, logger } = stageWith(500, message);

    const result = await stage.pushEntities(
      { runId: RUN_ID, userId: USER_ID, progress: async () => undefined },
      'balanced',
      null,
    );

    expect(result.failed).toBe(500);
    expect(marks).toHaveLength(500);

    for (const mark of marks) {
      expect(mark.status).toBe('failed');
      // Its own key and message only — before the fix this was all 500 joined.
      expect(mark.error).toMatch(new RegExp(`^entity \\S+: ${message}$`));
      expect(mark.error!.length).toBeLessThan(200);
    }

    // Two different rows name two different keys.
    expect(marks[0].error).not.toBe(marks[1].error);

    // Log volume is linear in the batch: no warn line carries another row's error.
    for (const [, fields] of logger.warn.mock.calls as Array<[string, { error: string }]>) {
      expect(fields.error.length).toBeLessThan(200);
    }
  });

  it('bounds a single enormous error', async () => {
    const { stage, marks } = stageWith(1, 'x'.repeat(50_000));

    await stage.pushEntities(
      { runId: RUN_ID, userId: USER_ID, progress: async () => undefined },
      'balanced',
      null,
    );

    expect(marks[0].error!.length).toBeLessThanOrEqual(1_001);
  });
});

describe('entityErrorsByKey', () => {
  it('maps each `entity <key>: <message>` to its key, including keys that contain a colon', () => {
    const map = entityErrorsByKey([
      'entity contact:alice: boom',
      'entity contact:a: b: second',
      'relationship x->y: endpoint not found in batch',
    ]);

    expect(map.get('contact:alice')).toBe('entity contact:alice: boom');
    expect(map.get('contact:a: b')).toBe('entity contact:a: b: second');
    expect([...map.values()].some((v) => v.startsWith('relationship'))).toBe(false);
  });
});

describe('entityErrorMessagesByKey / entityErrorMessage', () => {
  it('keeps the key out of the message a classifier reads', () => {
    const errors = [
      'entity contact:EPIPE Crew: value too long for type character varying(255)',
      'entity contact:a: b: the database system is in recovery mode',
    ];
    const map = entityErrorMessagesByKey(errors);

    // The key carries a socket code; the message does not.
    expect(map.get('contact:EPIPE Crew')).toBe('value too long for type character varying(255)');
    expect(map.get('contact:a: b')).toBe('the database system is in recovery mode');
  });

  it('strips the longest key the caller actually sent, and leaves an unknown one whole', () => {
    const error = 'entity contact:a: b: ECONNRESET is the band name';

    expect(entityErrorMessage(error, new Set(['contact:a', 'contact:a: b']))).toBe(
      'ECONNRESET is the band name',
    );
    expect(entityErrorMessage(error, new Set(['contact:zzz']))).toBe(error);
    expect(entityErrorMessage('relationship x->y: endpoint not found in batch', new Set(['x']))).toBe(
      'relationship x->y: endpoint not found in batch',
    );
  });
});
