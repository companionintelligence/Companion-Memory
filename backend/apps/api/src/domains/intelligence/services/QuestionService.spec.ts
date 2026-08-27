import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';

import { QuestionEntity } from '../entities/QuestionEntity';

import { QuestionService, FEED_QUESTION_STALE_MS } from './QuestionService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

const CONTEXT: ServiceContext = { userId: USER } as ServiceContext;
const SYSTEM_CONTEXT: ServiceContext = { userId: SYSTEM_USER } as ServiceContext;

function makeInsertBuilder(record: { values?: unknown[]; inserted: boolean }) {
  const qb: Record<string, unknown> = {};
  qb.insert = jest.fn(() => qb);
  qb.into = jest.fn(() => qb);
  qb.values = jest.fn((v: unknown[]) => {
    record.values = v;

    return qb;
  });
  qb.execute = jest.fn(async () => {
    record.inserted = true;

    return { raw: [] };
  });

  return qb;
}

function makeService() {
  const insertRecord = { inserted: false } as { values?: unknown[]; inserted: boolean };
  const created: QuestionEntity[] = [];

  const create = jest.fn((partial: Partial<QuestionEntity>) => {
    const entity = Object.assign(new QuestionEntity(), partial);
    created.push(entity);

    return entity;
  });

  const save = jest.fn(async (entity: QuestionEntity) => entity);
  const find = jest.fn(async () => created);

  const repository = {
    create,
    save,
    find,
    // 15 persisted columns, matching repository.metadata.columns.length; drives
    // computeChunkSize in createMany.
    metadata: { target: QuestionEntity, columns: { length: 15 } },
    createQueryBuilder: jest.fn(() => makeInsertBuilder(insertRecord)),
  };

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);
  const dataSource = { query: jest.fn(async () => []) };

  const service = new QuestionService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
  );

  return { service, send, insert: insertRecord, save };
}

describe('QuestionService bulk createMany', () => {
  it('inserts set-based (one INSERT, no per-row save) and does NOT emit a per-row QuestionCreatedEvent', async () => {
    const { service, send, insert, save } = makeService();

    const result = await service.createMany(CONTEXT, [
      { id: 'q1', text: 'How are you?', category: 'wellbeing' },
      { id: 'q2', text: 'Where are you?', category: 'location' },
    ]);

    expect(insert.inserted).toBe(true);
    expect(insert.values).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
    expect(result.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves is_private_to per row (real caller privatizes to self)', async () => {
    const { service, insert } = makeService();

    await service.createMany(CONTEXT, [{ id: 'q1', text: 'Private?', category: 'x' }]);

    const values = insert.values as Array<{ isPrivateTo?: string | null }>;
    expect(values[0].isPrivateTo).toBe(USER);
  });

  it('leaves is_private_to null for a system caller', async () => {
    const { service, insert } = makeService();

    await service.createMany({ userId: SYSTEM_USER } as ServiceContext, [
      { id: 'q1', text: 'Public?', category: 'x' },
    ]);

    const values = insert.values as Array<{ isPrivateTo?: string | null }>;
    expect(values[0].isPrivateTo).toBeNull();
  });

  it('returns an empty array (and issues no INSERT) for empty input', async () => {
    const { service, send, insert } = makeService();

    const result = await service.createMany(CONTEXT, []);

    expect(result).toEqual([]);
    expect(insert.inserted).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('QuestionService feed rotation', () => {
  function makeRotationService() {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });

        if (sql.includes('SELECT') && sql.includes('feed_queue_id') && sql.includes('LIMIT 1')) {
          return [
            {
              feed_queue_id: 'fq-1',
              question_id: 'q-1',
              metadata: {
                lastPresentedAt: new Date(Date.now() - FEED_QUESTION_STALE_MS - 1000).toISOString(),
              },
            },
          ];
        }

        if (sql.includes('UPDATE ci.feed_queue') && sql.includes('rotatedAt')) {
          return [];
        }

        if (sql.includes('GAP_AWARE') || sql.includes('category_coverage')) {
          return [{ id: 'q-2' }];
        }

        if (sql.includes('INSERT INTO ci.feed_queue')) {
          return [{ question_id: 'q-2' }];
        }

        if (sql.includes('COUNT(*)')) {
          return [{ count: '1' }];
        }

        return [];
      }),
    };

    const service = new QuestionService(
      dataSource as never,
      { create: jest.fn(), save: jest.fn(), find: jest.fn(), metadata: { columns: { length: 15 } } } as never,
      { send: jest.fn() } as never,
    );

    return { service, dataSource, queries };
  }

  it('rotates a stale front-of-queue question and enqueues a replacement', async () => {
    const { service, dataSource } = makeRotationService();

    const rotated = await service.rotateStaleFeedQuestions(USER);

    expect(rotated).toBe(true);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('rotatedAt'),
      expect.arrayContaining(['fq-1']),
    );
  });
});

describe('QuestionService single create still emits', () => {
  it('emits QuestionCreatedEvent on a single interactive create', async () => {
    const { service, send } = makeService();

    await service.create(CONTEXT, { id: 'q1', text: 'How are you?', category: 'wellbeing' });

    expect(send).toHaveBeenCalledTimes(1);
    const [, payload] = send.mock.calls[0];
    expect(payload).toEqual({ questionId: 'q1' });
  });

  it('suppresses the event when emitCreated: false is passed', async () => {
    const { service, send } = makeService();

    await service.create(
      CONTEXT,
      { id: 'q1', text: 'How are you?', category: 'wellbeing' },
      { emitCreated: false },
    );

    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * A minimal in-memory fake that HONORS the `where` clause it is given — including
 * TypeORM's array-of-clauses OR semantics and the In()/IsNull() FindOperators —
 * the way Postgres row filtering would. This lets the privacy tests below prove
 * the is_private_to scoping by observing actual returned rows: a dropped or
 * inverted `context.userId !== SYSTEM_USER` predicate, or a missing isPrivateTo
 * clause, would make these tests fail rather than just assert on mock call args.
 */
type FindOperatorLike = { _type: string; _value?: unknown };

function isFindOperator(value: unknown): value is FindOperatorLike {
  return typeof value === 'object' && value !== null && '_type' in value;
}

function matchesClause(row: QuestionEntity, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([key, expected]) => {
    const actual = (row as unknown as Record<string, unknown>)[key];

    if (isFindOperator(expected)) {
      if (expected._type === 'in') {
        return Array.isArray(expected._value) && expected._value.includes(actual);
      }

      if (expected._type === 'isNull') {
        return actual === null || actual === undefined;
      }

      if (expected._type === 'not') {
        const inner = expected._value;

        if (isFindOperator(inner)) {
          return inner._type === 'isNull' ? actual !== null && actual !== undefined : false;
        }

        return actual !== inner;
      }

      return false;
    }

    return actual === expected;
  });
}

function matchesWhere(
  row: QuestionEntity,
  where: Record<string, unknown> | Record<string, unknown>[],
): boolean {
  const clauses = Array.isArray(where) ? where : [where];

  return clauses.some((clause) => matchesClause(row, clause));
}

function makeQuestion(
  id: string,
  opts: {
    isPrivateTo?: string | null;
    isActive?: boolean;
    isSeedQuestion?: boolean;
    createdByLlm?: boolean;
    forkedFromQuestionId?: string | null;
  } = {},
): QuestionEntity {
  return Object.assign(new QuestionEntity(), {
    id,
    text: `question-${id}`,
    category: 'general',
    isActive: opts.isActive ?? true,
    isPrivateTo: opts.isPrivateTo ?? null,
    isSeedQuestion: opts.isSeedQuestion ?? false,
    createdByLlm: opts.createdByLlm ?? false,
    forkedFromQuestionId: opts.forkedFromQuestionId ?? null,
  });
}

/** A shipped catalogue row: shared with everyone, seeded, human-written. */
function makeSeedQuestion(id: string): QuestionEntity {
  return makeQuestion(id, { isPrivateTo: null, isSeedQuestion: true, createdByLlm: false });
}

function makeScopedService(rows: QuestionEntity[]) {
  const find = jest.fn(async (options: { where: Record<string, unknown> | Record<string, unknown>[] }) => {
    return rows.filter((row) => matchesWhere(row, options.where));
  });
  const findOne = jest.fn(async (options: { where: Record<string, unknown> | Record<string, unknown>[] }) => {
    return rows.find((row) => matchesWhere(row, options.where)) ?? null;
  });
  const create = jest.fn((partial: Partial<QuestionEntity>) => Object.assign(new QuestionEntity(), partial));
  // A save of a row the store has not seen INSERTS it, so a fork minted mid-test
  // is visible to every later read the way it would be in Postgres.
  const save = jest.fn(async (entity: QuestionEntity) => {
    if (!rows.includes(entity)) {
      rows.push(entity);
    }

    return entity;
  });
  const deleteFn = jest.fn(async () => ({ affected: 1 }));

  const repository = { find, findOne, create, save, delete: deleteFn };
  const send = jest.fn(async () => []);
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });

      return [];
    }),
  };

  const service = new QuestionService(dataSource as never, repository as never, { send } as never);

  return { service, rows, find, findOne, create, save, delete: deleteFn, send, queries };
}

describe('QuestionService privacy scoping (is_private_to)', () => {
  describe('findAll', () => {
    it("returns public questions plus the caller's own private questions, never another user's private ones", async () => {
      const { service } = makeScopedService([
        makeQuestion('public-1'),
        makeQuestion('mine-1', { isPrivateTo: USER }),
        makeQuestion('theirs-1', { isPrivateTo: OTHER_USER }),
      ]);

      const result = await service.findAll(CONTEXT);
      const ids = result.map((q) => q.id).sort();

      expect(ids).toEqual(['mine-1', 'public-1']);
      expect(ids).not.toContain('theirs-1');
    });

    it('SYSTEM_USER only sees public questions (no user id to match private ones against)', async () => {
      const { service } = makeScopedService([
        makeQuestion('public-1'),
        makeQuestion('mine-1', { isPrivateTo: USER }),
      ]);

      const result = await service.findAll(SYSTEM_CONTEXT);

      expect(result.map((q) => q.id)).toEqual(['public-1']);
    });
  });

  describe('findById', () => {
    it('returns a public question to any caller', async () => {
      const { service } = makeScopedService([makeQuestion('public-1')]);

      await expect(service.findById(CONTEXT, 'public-1')).resolves.toMatchObject({ id: 'public-1' });
    });

    it("returns the caller's own private question", async () => {
      const { service } = makeScopedService([makeQuestion('mine-1', { isPrivateTo: USER })]);

      await expect(service.findById(CONTEXT, 'mine-1')).resolves.toMatchObject({ id: 'mine-1' });
    });

    it("rejects (returns null for) another user's private question — the tenancy leak case", async () => {
      const { service } = makeScopedService([makeQuestion('theirs-1', { isPrivateTo: OTHER_USER })]);

      await expect(service.findById(CONTEXT, 'theirs-1')).resolves.toBeNull();
    });
  });

  describe('findByIds', () => {
    it('filters out ids private to another user while keeping public and own-private ids, deduped', async () => {
      const { service } = makeScopedService([
        makeQuestion('public-1'),
        makeQuestion('mine-1', { isPrivateTo: USER }),
        makeQuestion('theirs-1', { isPrivateTo: OTHER_USER }),
      ]);

      const result = await service.findByIds(CONTEXT, ['public-1', 'mine-1', 'theirs-1']);
      const ids = result.map((q) => q.id).sort();

      expect(ids).toEqual(['mine-1', 'public-1']);
    });
  });

  describe('update on a row the caller owns', () => {
    it('lets the owner update their own private question in place', async () => {
      const { service, save } = makeScopedService([makeQuestion('mine-1', { isPrivateTo: USER })]);

      const result = await service.update(CONTEXT, 'mine-1', { text: 'updated' });

      expect(result?.id).toBe('mine-1');
      expect(save).toHaveBeenCalled();
    });

    it('rejects a non-owner update of a private question (returns null, no save)', async () => {
      const { service, save } = makeScopedService([makeQuestion('theirs-1', { isPrivateTo: OTHER_USER })]);

      const result = await service.update(CONTEXT, 'theirs-1', { text: 'hijacked' });

      expect(result).toBeNull();
      expect(save).not.toHaveBeenCalled();
    });

    it('lets a system caller edit a shared catalogue row in place (no fork)', async () => {
      const seed = makeSeedQuestion('seed-1');
      const { service, rows } = makeScopedService([seed]);

      const result = await service.update(SYSTEM_CONTEXT, 'seed-1', { text: 'corrected' });

      expect(result?.id).toBe('seed-1');
      expect(seed.text).toBe('corrected');
      expect(rows).toHaveLength(1);
    });
  });

  /**
   * The access rule this whole mechanism exists for.
   *
   * `ci.questions` mixes ~1.3k shared rows every user on the appliance is asked
   * from with each person's own private ones. When the browsable catalogue
   * shipped, write scope was widened to match read scope, which meant any
   * authenticated user could reword, recategorise or retire
   * (`isActive: false`) a shared row FOR EVERYONE. These tests pin the
   * replacement: a shared row is read-only, and an edit lands on a private copy.
   */
  describe('update on a shared catalogue row forks instead of writing through', () => {
    it('leaves the shared row untouched and returns a private copy carrying the edit', async () => {
      const seed = makeSeedQuestion('seed-1');
      const { service, rows } = makeScopedService([seed]);

      const result = await service.update(CONTEXT, 'seed-1', { text: 'my wording' });

      expect(seed.text).toBe('question-seed-1');
      expect(seed.isPrivateTo).toBeNull();

      expect(result?.id).not.toBe('seed-1');
      expect(result?.text).toBe('my wording');
      expect(result?.isPrivateTo).toBe(USER);
      expect(result?.forkedFromQuestionId).toBe('seed-1');
      expect(rows).toHaveLength(2);
    });

    it("retiring a shared row retires only the caller's copy, never the shared row", async () => {
      const seed = makeSeedQuestion('seed-1');
      const { service } = makeScopedService([seed]);

      const result = await service.update(CONTEXT, 'seed-1', { isActive: false });

      expect(result?.isActive).toBe(false);
      expect(seed.isActive).toBe(true);

      // The other user's view of the catalogue is unchanged.
      const theirs = await service.findAll({ userId: OTHER_USER } as ServiceContext);
      expect(theirs.map((q) => q.id)).toEqual(['seed-1']);
    });

    it("carries the origin's stable key onto the copy, so a curated surface keeps the question", async () => {
      // A curated surface (the Self page's "Life details" grid) fetches by
      // question_key, and the shared origin is hidden from whoever forked it.
      // A keyless copy would therefore blank that question for exactly the one
      // user who cared enough to edit it. questions_question_key_owner_uniq is
      // scoped to (question_key, is_private_to) so both rows can hold the key.
      const seed = makeSeedQuestion('seed-1');
      seed.key = 'blood_type';
      const { service } = makeScopedService([seed]);

      const result = await service.update(CONTEXT, 'seed-1', { text: 'my wording' });

      expect(result?.key).toBe('blood_type');
      expect(result?.id).not.toBe('seed-1');
      expect(seed.key).toBe('blood_type');
    });

    it('marks the copy as neither seed content nor LLM-written, whatever the origin was', async () => {
      const { service } = makeScopedService([makeSeedQuestion('seed-1')]);

      const result = await service.update(CONTEXT, 'seed-1', { text: 'mine' });

      expect(result?.isSeedQuestion).toBe(false);
      expect(result?.createdByLlm).toBe(false);
    });

    it('cannot be talked into handing the copy to another user via isPrivateTo', async () => {
      const { service } = makeScopedService([makeSeedQuestion('seed-1')]);

      const result = await service.update(CONTEXT, 'seed-1', {
        text: 'mine',
        isPrivateTo: OTHER_USER,
      });

      expect(result?.isPrivateTo).toBe(USER);
      expect(result?.forkedFromQuestionId).toBe('seed-1');
    });

    it('reuses the same copy on a second edit rather than minting another', async () => {
      const { service, rows } = makeScopedService([makeSeedQuestion('seed-1')]);

      const first = await service.update(CONTEXT, 'seed-1', { text: 'first' });
      const second = await service.update(CONTEXT, 'seed-1', { text: 'second' });

      expect(second?.id).toBe(first?.id);
      expect(second?.text).toBe('second');
      expect(rows).toHaveLength(2);
    });

    it('gives two users independent copies of the same shared row', async () => {
      const seed = makeSeedQuestion('seed-1');
      const { service } = makeScopedService([seed]);

      const mine = await service.update(CONTEXT, 'seed-1', { text: 'mine' });
      const theirs = await service.update({ userId: OTHER_USER } as ServiceContext, 'seed-1', {
        text: 'theirs',
      });

      expect(mine?.id).not.toBe(theirs?.id);
      expect(mine?.text).toBe('mine');
      expect(theirs?.text).toBe('theirs');
      expect(seed.text).toBe('question-seed-1');
    });

    it("moves only the caller's own answers onto the copy", async () => {
      const { service, queries } = makeScopedService([makeSeedQuestion('seed-1')]);

      const fork = await service.update(CONTEXT, 'seed-1', { text: 'mine' });

      const answerUpdate = queries.find((call) => call.sql.includes('UPDATE ci.answers'));

      expect(answerUpdate).toBeDefined();
      expect(answerUpdate?.sql).toContain('user_id = $1');
      expect(answerUpdate?.params).toEqual([USER, 'seed-1', fork?.id]);
    });

    it("drops the origin from the caller's feed queue so it is not asked again", async () => {
      const { service, queries } = makeScopedService([makeSeedQuestion('seed-1')]);

      await service.update(CONTEXT, 'seed-1', { isActive: false });

      const feedDelete = queries.find((call) => call.sql.includes('DELETE FROM ci.feed_queue'));

      expect(feedDelete?.params).toEqual([USER, 'seed-1']);
    });
  });

  describe('findAll hides a shared row the caller has replaced', () => {
    it('returns the copy instead of the original, for that caller only', async () => {
      const rows = [
        makeSeedQuestion('seed-1'),
        makeQuestion('my-copy', { isPrivateTo: USER, forkedFromQuestionId: 'seed-1' }),
      ];
      const { service } = makeScopedService(rows);

      const mine = await service.findAll(CONTEXT);
      expect(mine.map((q) => q.id)).toEqual(['my-copy']);

      const theirs = await service.findAll({ userId: OTHER_USER } as ServiceContext);
      expect(theirs.map((q) => q.id)).toEqual(['seed-1']);
    });

    it('keeps the original hidden even when the copy was retired', async () => {
      const rows = [
        makeSeedQuestion('seed-1'),
        makeQuestion('my-copy', {
          isPrivateTo: USER,
          forkedFromQuestionId: 'seed-1',
          isActive: false,
        }),
      ];
      const { service } = makeScopedService(rows);

      // The point of "retire this reflection": neither row comes back.
      await expect(service.findAll(CONTEXT)).resolves.toEqual([]);
    });
  });

  describe('remove', () => {
    it('lets the owner remove their own private question', async () => {
      const { service, delete: deleteFn } = makeScopedService([
        makeQuestion('mine-1', { isPrivateTo: USER }),
      ]);

      await expect(service.remove(CONTEXT, 'mine-1')).resolves.toBe(true);
      expect(deleteFn).toHaveBeenCalled();
    });

    it('rejects a non-owner remove of a private question (returns false, no delete)', async () => {
      const { service, delete: deleteFn } = makeScopedService([
        makeQuestion('theirs-1', { isPrivateTo: OTHER_USER }),
      ]);

      await expect(service.remove(CONTEXT, 'theirs-1')).resolves.toBe(false);
      expect(deleteFn).not.toHaveBeenCalled();
    });

    // Delete does NOT fork and is NOT widened to the shared catalogue: ci.answers
    // and ci.feed_queue both cascade from ci.questions, so deleting a shared row
    // would destroy answers other people wrote. Retiring one is isActive: false.
    it('rejects a remove of a shared catalogue row the caller can plainly see', async () => {
      const { service, delete: deleteFn } = makeScopedService([makeSeedQuestion('seed-1')]);

      await expect(service.findById(CONTEXT, 'seed-1')).resolves.not.toBeNull();
      await expect(service.remove(CONTEXT, 'seed-1')).resolves.toBe(false);
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('lets a system caller remove a shared catalogue row', async () => {
      const { service, delete: deleteFn } = makeScopedService([makeSeedQuestion('seed-1')]);

      await expect(service.remove(SYSTEM_CONTEXT, 'seed-1')).resolves.toBe(true);
      expect(deleteFn).toHaveBeenCalled();
    });
  });
});

describe('QuestionService.enqueueNextFeedQueueQuestion', () => {
  function makeQueueService(overrides: {
    queueCount?: string;
    candidate?: { id: string } | undefined;
    insertedRows?: Array<{ question_id: string }>;
  }) {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });

        if (sql.includes('DELETE FROM ci.feed_queue')) {
          return [];
        }

        if (sql.includes('COUNT(*)')) {
          return [{ count: overrides.queueCount ?? '0' }];
        }

        if (sql.includes('category_coverage')) {
          return overrides.candidate ? [overrides.candidate] : [];
        }

        if (sql.includes('INSERT INTO ci.feed_queue')) {
          return overrides.insertedRows ?? [];
        }

        return [];
      }),
    };

    const service = new QuestionService(
      dataSource as never,
      { create: jest.fn(), save: jest.fn(), find: jest.fn(), metadata: { columns: { length: 15 } } } as never,
      { send: jest.fn() } as never,
    );

    return { service, dataSource, queries };
  }

  it('returns false without querying for a candidate when the queue is already full', async () => {
    const { service, queries } = makeQueueService({ queueCount: '3' });

    const result = await service.enqueueNextFeedQueueQuestion('user-1', 3);

    expect(result).toBe(false);
    expect(queries.some((q) => q.sql.includes('category_coverage'))).toBe(false);
  });

  it('never offers back a shared question the user has replaced with their own copy', async () => {
    const { service, queries } = makeQueueService({ queueCount: '0', candidate: { id: 'q1' } });

    await service.enqueueNextFeedQueueQuestion('user-1', 3);

    const candidateQuery = queries.find((q) => q.sql.includes('category_coverage'));

    expect(candidateQuery?.sql).toContain('fork.forked_from_question_id = q.question_id');
    expect(candidateQuery?.sql).toContain('fork.is_private_to = $1');
  });

  it('returns false when the queue has room but there is no gap-aware candidate', async () => {
    const { service } = makeQueueService({ queueCount: '0', candidate: undefined });

    const result = await service.enqueueNextFeedQueueQuestion('user-1', 3);

    expect(result).toBe(false);
  });

  it('inserts the candidate and returns true when the queue has room and a candidate exists', async () => {
    const { service } = makeQueueService({
      queueCount: '0',
      candidate: { id: 'q-new' },
      insertedRows: [{ question_id: 'q-new' }],
    });

    const result = await service.enqueueNextFeedQueueQuestion('user-1', 3);

    expect(result).toBe(true);
  });

  it('returns false when the INSERT ON CONFLICT DO NOTHING no-ops (race with another enqueue)', async () => {
    const { service } = makeQueueService({
      queueCount: '0',
      candidate: { id: 'q-new' },
      insertedRows: [],
    });

    const result = await service.enqueueNextFeedQueueQuestion('user-1', 3);

    expect(result).toBe(false);
  });
});

describe('QuestionService.findUnansweredByUserId', () => {
  it('groups unanswered question ids by user id', async () => {
    const dataSource = {
      query: jest.fn(async () => [
        { id: 'q-1', user_id: 'user-1' },
        { id: 'q-2', user_id: 'user-1' },
        { id: 'q-3', user_id: 'user-2' },
      ]),
    };

    const service = new QuestionService(
      dataSource as never,
      { create: jest.fn(), save: jest.fn(), find: jest.fn(), metadata: { columns: { length: 15 } } } as never,
      { send: jest.fn() } as never,
    );

    const result = await service.findUnansweredByUserId();

    expect(result.get('user-1')).toEqual(['q-1', 'q-2']);
    expect(result.get('user-2')).toEqual(['q-3']);
  });

  it('returns an empty map when there are no unanswered questions', async () => {
    const dataSource = { query: jest.fn(async () => []) };

    const service = new QuestionService(
      dataSource as never,
      { create: jest.fn(), save: jest.fn(), find: jest.fn(), metadata: { columns: { length: 15 } } } as never,
      { send: jest.fn() } as never,
    );

    const result = await service.findUnansweredByUserId();

    expect(result.size).toBe(0);
  });
});

describe('QuestionService asks the functional questions first', () => {
  // The catalogue is deliberately weighted toward questions that settle a fact,
  // and `answer_tier` exists so selection can honour that ordering. These guard
  // the ordering itself: a later edit that reinstates "oldest first" or
  // "least-covered category first" as the PRIMARY sort would silently go back to
  // leading with the abstract, pre-catalogue questions (which sort last as NULL).
  function capturedSql(service: QuestionService, run: () => Promise<unknown>) {
    const seen: string[] = [];
    const ds = (service as unknown as { dataSource: { query: jest.Mock } }).dataSource;

    ds.query.mockImplementation((sql: string) => {
      seen.push(sql);

      return Promise.resolve([]);
    });

    return run().then(() => seen);
  }

  function makeService() {
    const dataSource = { query: jest.fn().mockResolvedValue([]) };

    return new QuestionService(
      dataSource as never,
      { create: jest.fn(), save: jest.fn() } as never,
      { send: jest.fn() } as never,
    );
  }

  const TIER_RANK =
    /CASE\s+q\.answer_tier[\s\S]*?'factual'\s+THEN 0[\s\S]*?'preference'\s+THEN 1[\s\S]*?'narrative'\s+THEN 2/;

  it('ranks factual before preference before narrative, and untiered last', async () => {
    const service = makeService();
    const [sql] = await capturedSql(service, () => service.findUnansweredByUserId());

    expect(sql).toMatch(TIER_RANK);
    // NULL (pre-catalogue) must sort AFTER narrative, not before it.
    expect(sql).toMatch(/ELSE 3\s*\n?\s*END/);
  });

  it('never offers a hand-entry question to the inference job', async () => {
    const service = makeService();
    const [sql] = await capturedSql(service, () => service.findUnansweredByUserId());

    // Body measurements, medical facts and household config cannot be grounded
    // in an email/browser/receipt corpus. Without this filter the model returns
    // a refusal, and the NOT EXISTS guard below then counts that refusal as an
    // answer — permanently occupying the slot. See migration
    // 20260825074747_add_question_evidence_class.
    expect(sql).toMatch(/q\.evidence_class\s*<>\s*'hand_entry'/);
  });

  it('sorts by tier before it sorts by age', async () => {
    const service = makeService();
    const [sql] = await capturedSql(service, () => service.findUnansweredByUserId());

    const order = sql.slice(sql.indexOf('ROW_NUMBER'));
    const tierAt = order.search(/CASE\s+q\.answer_tier/);
    const createdAt = order.indexOf('q.created_at');

    expect(tierAt).toBeGreaterThan(-1);
    expect(createdAt).toBeGreaterThan(-1);
    expect(tierAt).toBeLessThan(createdAt);
  });
});

describe('QuestionService.findCatalogue', () => {
  const CATALOGUE_QUERY = {
    status: 'active',
    answered: 'all',
    limit: 25,
    offset: 0,
  } as const;

  type Call = { sql: string; params: unknown[] };

  function makeCatalogueService(responses: unknown[][]) {
    const calls: Call[] = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });

      return responses[calls.length - 1] ?? [];
    });

    const service = new QuestionService(
      { query } as never,
      { find: jest.fn(), findOne: jest.fn() } as never,
      { send: jest.fn() } as never,
    );

    return { service, calls };
  }

  function catalogueRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'q1',
      question_key: null,
      text: 'What foods are you allergic to?',
      category: 'Health & Body',
      answer_tier: 'factual',
      question_type: 'open_ended',
      frequency_recommendation: null,
      is_active: true,
      is_seed_question: true,
      created_by_llm: false,
      is_private_to: null,
      forked_from_question_id: null,
      times_asked: 3,
      times_answered: 1,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
      answer_id: null,
      answer_text: null,
      answer_source: null,
      answer_confidence: null,
      answer_rationale: null,
      answered_at: null,
      total_count: 1284,
      ...overrides,
    };
  }

  it('pages, and reports the window total rather than the page length', async () => {
    const { service, calls } = makeCatalogueService([[catalogueRow()], []]);

    const page = await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, offset: 50 });

    expect(page.data).toHaveLength(1);
    expect(page.totalCount).toBe(1284);
    expect(page.offset).toBe(50);
    expect(calls[0].sql).toContain('LIMIT $7 OFFSET $8');
    expect(calls[0].params[6]).toBe(25);
    expect(calls[0].params[7]).toBe(50);
  });

  it('scopes to the caller: public rows plus their own, and only their own answers', async () => {
    const { service, calls } = makeCatalogueService([[], []]);

    await service.findCatalogue(CONTEXT, CATALOGUE_QUERY);

    expect(calls[0].sql).toContain('q.is_private_to IS NULL OR q.is_private_to = $1::uuid');
    expect(calls[0].sql).toContain('a.user_id = $1::uuid');
    expect(calls[0].params[0]).toBe(USER);
  });

  it('hides a shared row the caller has replaced with their own copy', async () => {
    const { service, calls } = makeCatalogueService([[], []]);

    await service.findCatalogue(CONTEXT, CATALOGUE_QUERY);

    for (const call of calls) {
      expect(call.sql).toContain('fork.forked_from_question_id = q.question_id');
      expect(call.sql).toContain('fork.is_private_to = $1::uuid');
    }
  });

  it('passes NULL for a system caller so no private row and no answer can leak', async () => {
    const { service, calls } = makeCatalogueService([[], []]);

    await service.findCatalogue(SYSTEM_CONTEXT, CATALOGUE_QUERY);

    expect(calls[0].params[0]).toBeNull();
  });

  it('escapes LIKE wildcards in the search term', async () => {
    const { service, calls } = makeCatalogueService([[], []]);

    await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, search: '100%_off' });

    expect(calls[0].params[2]).toBe('100\\%\\_off');
  });

  it('sends no search term at all when the search is empty', async () => {
    const { service, calls } = makeCatalogueService([[], []]);

    await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, search: '' });

    expect(calls[0].params[2]).toBeNull();
  });

  it('computes facets from the pre-category predicate so the picker does not collapse', async () => {
    const { service, calls } = makeCatalogueService([
      [],
      [
        { category: 'Health & Body', answer_tier: 'factual', count: 101, answered_count: 4 },
        { category: 'Work & Money', answer_tier: 'narrative', count: 18, answered_count: 0 },
      ],
    ]);

    const page = await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, category: 'Health & Body' });

    // The page query is narrowed by $4; the facet query is handed only $1..$3.
    expect(calls[0].params[3]).toBe('Health & Body');
    expect(calls[1].params).toHaveLength(3);
    expect(page.facets.categories.map((bucket) => bucket.value)).toEqual(['Health & Body', 'Work & Money']);
    expect(page.facets.answeredCount).toBe(4);
    expect(page.facets.unansweredCount).toBe(115);
  });

  it('shapes the answer (and its provenance) onto the row when one exists', async () => {
    const { service } = makeCatalogueService([
      [
        catalogueRow({
          answer_id: 'a1',
          answer_text: 'Shellfish.',
          answer_source: 'inferred',
          answer_confidence: 0.82,
          answer_rationale: 'Two prior answers mention an allergy.',
          answered_at: new Date('2026-02-01T00:00:00Z'),
        }),
      ],
      [],
    ]);

    const page = await service.findCatalogue(CONTEXT, CATALOGUE_QUERY);

    expect(page.data[0].answer).toEqual({
      id: 'a1',
      text: 'Shellfish.',
      source: 'inferred',
      confidence: 0.82,
      rationale: 'Two prior answers mention an allergy.',
      answeredAt: new Date('2026-02-01T00:00:00Z'),
    });
  });

  it('leaves the answer null on an unanswered row', async () => {
    const { service } = makeCatalogueService([[catalogueRow()], []]);

    const page = await service.findCatalogue(CONTEXT, CATALOGUE_QUERY);

    expect(page.data[0].answer).toBeNull();
  });

  it('re-counts rather than reporting zero when a page lands past the end', async () => {
    const { service, calls } = makeCatalogueService([[], [], [{ total_count: 1284 }]]);

    const page = await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, offset: 5000 });

    expect(page.totalCount).toBe(1284);
    expect(calls).toHaveLength(3);
  });

  it('does not spend a count query on an empty first page', async () => {
    const { service, calls } = makeCatalogueService([[], []]);

    const page = await service.findCatalogue(CONTEXT, CATALOGUE_QUERY);

    expect(page.totalCount).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('filters the page query to an explicit id allow-list, appended as its own trailing param', async () => {
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
    const { service, calls } = makeCatalogueService([[catalogueRow()], []]);

    await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, ids });

    expect(calls[0].sql).toContain('AND q.question_id = ANY($9::uuid[])');
    expect(calls[0].params[8]).toEqual(ids);
  });

  it('leaves the query text and facet params untouched when no allow-list is given', async () => {
    const { service, calls } = makeCatalogueService([[], []]);

    await service.findCatalogue(CONTEXT, CATALOGUE_QUERY);

    expect(calls[0].sql).not.toContain('question_id = ANY');
    expect(calls[0].sql).not.toContain('question_key = ANY');
    expect(calls[0].params).toHaveLength(8);
    // No allow-list means the facet query still sees exactly $1..$3.
    expect(calls[1].params).toHaveLength(3);
  });

  it('applies the id allow-list to the facet query too, not just the page', async () => {
    // Facets used to be computed over the whole catalogue regardless, so an
    // ids-filtered request described a set the caller had not asked for.
    const ids = ['11111111-1111-1111-1111-111111111111'];
    const { service, calls } = makeCatalogueService([[catalogueRow()], []]);

    await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, ids });

    // $4 here, not $9: the facet statement binds only $1..$3, so the allow-list
    // takes the next free position in THAT query rather than the page query's.
    expect(calls[1].sql).toContain('AND q.question_id = ANY($4::uuid[])');
    expect(calls[1].params).toHaveLength(4);
    expect(calls[1].params[3]).toEqual(ids);
  });

  it('applies the id allow-list to the past-the-end count fallback', async () => {
    // The fallback exists so a page past the end can still tell the pager how
    // far back to go. Counting the unfiltered catalogue there offered pages
    // that cannot exist.
    const ids = ['11111111-1111-1111-1111-111111111111'];
    const { service, calls } = makeCatalogueService([[], [], [{ total_count: 1 }]]);

    await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, ids, offset: 25 });

    const countCall = calls[calls.length - 1];
    expect(countCall.sql).toContain('AND q.question_id = ANY($7::uuid[])');
    expect(countCall.params).toHaveLength(7);
    expect(countCall.params[6]).toEqual(ids);
  });

  // `keys` is what a fixed, curated surface addresses the catalogue by. Ids are
  // minted per appliance (`gen_uuid_v7()`), so client code that hardcoded them
  // matched nothing on any other database and silently rendered a dead section;
  // a key is written by the seed migration and means the same thing everywhere.
  it('filters the page query to an explicit key allow-list, and the facets with it', async () => {
    const keys = ['blood_type', 'food_allergies'];
    const { service, calls } = makeCatalogueService([[catalogueRow()], []]);

    await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, keys });

    expect(calls[0].sql).toContain('AND q.question_key = ANY($9::text[])');
    expect(calls[0].params[8]).toEqual(keys);
    // Same per-query positioning the ids allow-list gets: $4 in the facet
    // statement, which binds only $1..$3.
    expect(calls[1].sql).toContain('AND q.question_key = ANY($4::text[])');
    expect(calls[1].params).toHaveLength(4);
    expect(calls[1].params[3]).toEqual(keys);
  });

  it('takes the next free position for each allow-list when both are sent', async () => {
    const ids = ['11111111-1111-1111-1111-111111111111'];
    const keys = ['blood_type'];
    const { service, calls } = makeCatalogueService([[], []]);

    await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, ids, keys });

    // Neither clause may assume it is the only one appended: a fixed $9 for
    // `keys` would read the ids array as a text[] and match nothing.
    expect(calls[0].sql).toContain('AND q.question_id = ANY($9::uuid[])');
    expect(calls[0].sql).toContain('AND q.question_key = ANY($10::text[])');
    expect(calls[0].params[8]).toEqual(ids);
    expect(calls[0].params[9]).toEqual(keys);
    // And they renumber together against the facet query's shorter prefix.
    expect(calls[1].sql).toContain('AND q.question_id = ANY($4::uuid[])');
    expect(calls[1].sql).toContain('AND q.question_key = ANY($5::text[])');
    expect(calls[1].params).toEqual([USER, 'active', null, ids, keys]);
  });

  it("reports each row's stable key so a caller that asked by key can index by it", async () => {
    const { service } = makeCatalogueService([[catalogueRow({ question_key: 'food_allergies' })], []]);

    const page = await service.findCatalogue(CONTEXT, { ...CATALOGUE_QUERY, keys: ['food_allergies'] });

    expect(page.data[0].key).toBe('food_allergies');
  });

  it('reports a null key for the catalogue rows nobody addresses by name', async () => {
    const { service } = makeCatalogueService([[catalogueRow()], []]);

    const page = await service.findCatalogue(CONTEXT, CATALOGUE_QUERY);

    expect(page.data[0].key).toBeNull();
  });
});

/**
 * The writer for `ci.questions.times_answered`, which had none at all: the
 * column was selected into the catalogue payload (`q.times_answered` in
 * findCatalogue) and typed through to the frontend while stuck at its
 * `DEFAULT 0`.
 *
 * There is no database in this suite, so what is checked here is the STATEMENT:
 * that the bump is a relative UPDATE the database applies, not a value this
 * process computed from a row it read a moment ago. That distinction is the
 * whole point — a read-modify-write loses one of two concurrent answers, which
 * is a live bug elsewhere in this repo (PR #2378).
 */
describe('QuestionService.recordQuestionAnswered', () => {
  function makeCountingService() {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });

        return [];
      }),
    };

    const service = new QuestionService(
      dataSource as never,
      { create: jest.fn(), save: jest.fn() } as never,
      { send: jest.fn() } as never,
    );

    return { service, calls };
  }

  it('increments in the database, in one statement, with no prior read', async () => {
    const { service, calls } = makeCountingService();

    await service.recordQuestionAnswered('q-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/UPDATE ci\.questions/);
    expect(calls[0].sql).toMatch(/SET times_answered\s*=\s*times_answered\s*\+\s*1/);
    expect(calls[0].sql).toMatch(/WHERE question_id = \$1/);
    expect(calls[0].params).toStrictEqual(['q-1']);

    // A read-modify-write would need to SELECT the current value first. Nothing
    // may select it, and nothing may assign it a value this process computed.
    expect(calls[0].sql).not.toMatch(/SELECT/i);
    expect(calls[0].sql).not.toMatch(/SET times_answered\s*=\s*\$/);
  });

  it('answering twice issues two increments of 1, not one write of 2', async () => {
    const { service, calls } = makeCountingService();

    await service.recordQuestionAnswered('q-1');
    await service.recordQuestionAnswered('q-1');

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toMatch(/times_answered\s*=\s*times_answered\s*\+\s*1/);
      expect(call.params).toStrictEqual(['q-1']);
    }
  });

  it('folds a batch into per-question counts and adds them relatively', async () => {
    const { service, calls } = makeCountingService();

    await service.recordManyQuestionsAnswered(['q-1', 'q-2', 'q-1']);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/SET times_answered\s*=\s*q\.times_answered\s*\+\s*c\.n/);
    expect(calls[0].sql).not.toMatch(/SELECT times_answered/i);

    // Two answers to q-1 count twice — the batch is aggregated, not deduped.
    const [ids, counts] = calls[0].params as [string[], number[]];
    expect(ids).toHaveLength(2);
    expect(counts).toHaveLength(2);
    const byId = new Map(ids.map((id, index) => [id, counts[index]]));
    expect(byId.get('q-1')).toBe(2);
    expect(byId.get('q-2')).toBe(1);
  });

  it('issues no statement for an empty batch', async () => {
    const { service, calls } = makeCountingService();

    await service.recordManyQuestionsAnswered([]);

    expect(calls).toStrictEqual([]);
  });
});
