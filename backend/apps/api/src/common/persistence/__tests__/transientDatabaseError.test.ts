import {
  DatabaseCrashedError,
  DatabaseUnavailableError,
  TransientDatabaseError,
  isDatabaseCrashError,
  isTransientDatabaseError,
  isTransientDatabaseMessage,
  retryOnTransientDatabaseError,
  type TransientRetryPolicy,
} from '../transientDatabaseError';

/**
 * "The database is away" versus "the database said no".
 *
 * The first case below is the incident this module exists for: a Postgres
 * crash-restart answered a live import push with SQLSTATE 57P03 for a few
 * seconds, and the push quarantined 437 good rows as if each one were poisoned.
 */

/** The shape TypeORM's QueryFailedError takes: the code on the error AND on driverError. */
function queryFailed(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: 'QueryFailedError',
    code,
    driverError: Object.assign(new Error(message), { code }),
  });
}

describe('isTransientDatabaseError', () => {
  it.each([
    ['57P03', 'the database system is in recovery mode'],
    ['57P03', 'the database system is not yet accepting connections'],
    ['57P01', 'terminating connection due to administrator command'],
    ['57P02', 'terminating connection because of crash of another server process'],
    ['08006', 'connection failure'],
    ['53300', 'sorry, too many clients already'],
  ])('treats SQLSTATE %s as the server being away', (code, message) => {
    expect(isTransientDatabaseError(queryFailed(code, message))).toBe(true);
  });

  it('reads the code off driverError when TypeORM did not copy it up', () => {
    const err = Object.assign(new Error('the database system is in recovery mode'), {
      driverError: { code: '57P03' },
    });

    expect(isTransientDatabaseError(err)).toBe(true);
  });

  it('treats a refused socket as transient, by its code', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), { code: 'ECONNREFUSED' });

    expect(isTransientDatabaseError(err)).toBe(true);
  });

  it('looks inside an AggregateError, which is how a multi-address connect fails', () => {
    const err = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    ]);

    expect(isTransientDatabaseError(err)).toBe(true);
  });

  it('follows a service that wrapped the driver error with `cause`', () => {
    const inner = queryFailed('57P03', 'the database system is in recovery mode');
    const err = new Error('bulk insert into ci.communications failed', { cause: inner });

    expect(isTransientDatabaseError(err)).toBe(true);
  });

  it('falls back to the wording when pg raised a bare Error with no code', () => {
    expect(isTransientDatabaseError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientDatabaseError(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  it('keeps a real rejection a rejection', () => {
    expect(
      isTransientDatabaseError(
        queryFailed('23502', 'null value in column "content" violates not-null constraint'),
      ),
    ).toBe(false);
    expect(
      isTransientDatabaseError(queryFailed('23505', 'duplicate key value violates unique constraint')),
    ).toBe(false);
    // Out of disk is its own stage failure (isOutOfDiskError), not a wait.
    expect(
      isTransientDatabaseError(queryFailed('53100', 'could not extend file: No space left on device')),
    ).toBe(false);
    expect(isTransientDatabaseError(new Error('Unexpected token in JSON'))).toBe(false);
    expect(isTransientDatabaseError(null)).toBe(false);
    expect(isTransientDatabaseError('the database system is in recovery mode')).toBe(false);
  });

  it('lets a non-transient CODE win over transient-looking prose in the message', () => {
    // A value quoted into an error message is user data; the code is the verdict.
    const err = queryFailed(
      '22P02',
      'invalid input syntax for type uuid: "Connection terminated unexpectedly"',
    );

    expect(isTransientDatabaseError(err)).toBe(false);
  });

  it('honours an explicit TransientDatabaseError, and a DatabaseUnavailableError is one', () => {
    expect(isTransientDatabaseError(new TransientDatabaseError('entity k: recovery'))).toBe(true);
    expect(isTransientDatabaseError(new DatabaseUnavailableError('pushing', 3, 90_000, new Error('x')))).toBe(
      true,
    );
  });
});

describe('isDatabaseCrashError', () => {
  it.each([
    ['57P01', queryFailed('57P01', 'terminating connection due to administrator command')],
    ['57P02', queryFailed('57P02', 'terminating connection because of crash of another server process')],
    ['a reset socket', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    // The backend running OUR statement died: pg says only this, with no code.
    ['pg losing the socket mid-query', new Error('Connection terminated unexpectedly')],
    [
      'a wrapped crash',
      new Error('bulk insert failed', {
        cause: queryFailed('57P02', 'terminating connection because of crash of another server process'),
      }),
    ],
  ])('calls %s a crash with the statement possibly in flight', (_label, err) => {
    expect(isTransientDatabaseError(err)).toBe(true);
    expect(isDatabaseCrashError(err)).toBe(true);
  });

  it.each([
    ['57P03 in recovery', queryFailed('57P03', 'the database system is in recovery mode')],
    ['57P03 not accepting', queryFailed('57P03', 'the database system is not yet accepting connections')],
    [
      'a refused socket',
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:5432'), { code: 'ECONNREFUSED' }),
    ],
    // Our own write failing: the statement never reached the server.
    ['a broken pipe', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
    ['a full server', queryFailed('53300', 'sorry, too many clients already')],
    ['a pool connect timeout', new Error('timeout exceeded when trying to connect')],
  ])('does not call %s a crash: the statement never ran', (_label, err) => {
    expect(isTransientDatabaseError(err)).toBe(true);
    expect(isDatabaseCrashError(err)).toBe(false);
  });

  it('decides by the code when there is one, not by prose that looks like a crash', () => {
    const err = queryFailed('57P03', 'Connection terminated unexpectedly while starting up');

    expect(isDatabaseCrashError(err)).toBe(false);
    expect(isDatabaseCrashError(queryFailed('23505', 'Connection terminated unexpectedly'))).toBe(false);
  });

  it('does not re-open an error whose class already carries a verdict', () => {
    const crash = queryFailed('57P02', 'terminating connection because of crash of another server process');

    expect(isDatabaseCrashError(new DatabaseUnavailableError('pushing', 3, 9_000, crash))).toBe(false);
    expect(isDatabaseCrashError(new DatabaseCrashedError('pushing', 2, crash))).toBe(false);
  });
});

describe('DatabaseCrashedError', () => {
  it('is NOT transient, although its cause is — that is the verdict it exists to carry', () => {
    const crash = new DatabaseCrashedError(
      'writing a batch',
      2,
      new Error('Connection terminated unexpectedly'),
    );

    expect(isTransientDatabaseError(crash)).toBe(false);
    // Nor when something wraps it in turn.
    expect(isTransientDatabaseError(new Error('push failed', { cause: crash }))).toBe(false);
    expect(crash.message).toBe(
      'the database went down 2 time(s) with writing a batch in flight ' +
        '(last error: Connection terminated unexpectedly)',
    );
  });
});

describe('isTransientDatabaseMessage', () => {
  it('recognises the text a string-only error channel is left with', () => {
    // GraphIngestService reports each failed entity as `entity <key>: <message>`.
    expect(isTransientDatabaseMessage('entity person:abc: the database system is in recovery mode')).toBe(
      true,
    );
    expect(isTransientDatabaseMessage('entity person:abc: connect ECONNREFUSED 10.0.0.4:5432')).toBe(true);
    expect(
      isTransientDatabaseMessage('entity person:abc: value too long for type character varying(255)'),
    ).toBe(false);
    expect(isTransientDatabaseMessage(null)).toBe(false);
  });
});

describe('retryOnTransientDatabaseError', () => {
  function clock(): TransientRetryPolicy & { slept: number[] } {
    let at = 0;
    const slept: number[] = [];

    return {
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      budgetMs: 180_000,
      slept,
      now: () => at,
      sleep: async (ms) => {
        slept.push(ms);
        at += ms;
      },
    };
  }

  const recovering = () => queryFailed('57P03', 'the database system is in recovery mode');

  it('waits out a restart and returns what the operation eventually produced', async () => {
    const policy = clock();
    let calls = 0;

    const result = await retryOnTransientDatabaseError(
      'pushing a batch',
      async () => {
        calls += 1;

        if (calls <= 3) {
          throw recovering();
        }

        return 'written';
      },
      policy,
    );

    expect(result).toBe('written');
    expect(calls).toBe(4);
    // Exponential, from the first pause.
    expect(policy.slept).toEqual([1_000, 2_000, 4_000]);
  });

  it('rethrows a real rejection on the attempt it happened, without waiting', async () => {
    const policy = clock();
    const refusal = queryFailed('23502', 'null value in column "content" violates not-null constraint');

    await expect(
      retryOnTransientDatabaseError(
        'pushing a batch',
        async () => {
          throw refusal;
        },
        policy,
      ),
    ).rejects.toBe(refusal);
    expect(policy.slept).toEqual([]);
  });

  it('gives up inside the budget, with the last error as the cause', async () => {
    const policy = clock();
    const notices: number[] = [];

    const failure = await retryOnTransientDatabaseError(
      'pushing a batch',
      async () => {
        throw recovering();
      },
      policy,
      (notice) => notices.push(notice.attempt),
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect((failure as DatabaseUnavailableError).cause).toMatchObject({ code: '57P03' });
    expect((failure as Error).message).toContain('while pushing a batch');
    expect((failure as Error).message).toContain('the database system is in recovery mode');

    const waited = policy.slept.reduce((sum, ms) => sum + ms, 0);

    // Long enough to ride out a crash recovery, never longer than promised.
    expect(waited).toBeLessThanOrEqual(180_000);
    expect(waited).toBeGreaterThan(120_000);
    // Capped per pause.
    expect(Math.max(...policy.slept)).toBe(30_000);
    expect(notices).toHaveLength(policy.slept.length);
  });

  const crashed = () => new Error('Connection terminated unexpectedly');

  it('stops resending, at crashAttempts, only an operation that asked it to', async () => {
    const policy = { ...clock(), crashAttempts: 2 };
    const outcomes = [crashed, recovering, recovering, crashed, recovering];
    let calls = 0;

    const failure = await retryOnTransientDatabaseError(
      'writing a batch',
      async () => {
        calls += 1;

        throw outcomes[calls - 1]();
      },
      policy,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseCrashedError);
    expect(failure).toMatchObject({ operation: 'writing a batch', crashes: 2 });
    // The second crash ended it: the two 57P03s in between — the server not
    // yet taking statements — did not count, and it was not sent a fifth time.
    expect(calls).toBe(4);
    expect(policy.slept).toEqual([1_000, 2_000, 4_000]);

    // Without a limit — a read, a ledger UPDATE by id — every crash is still
    // waited out like any other outage.
    let reads = 0;

    const result = await retryOnTransientDatabaseError(
      'reading the next batch',
      async () => {
        reads += 1;

        if (reads <= 3) {
          throw crashed();
        }

        return 'read';
      },
      clock(),
    );

    expect(result).toBe('read');
    expect(reads).toBe(4);
  });

  it('draws every pause from a shared allowance, so many operations wait one budget in total', async () => {
    const allowance = { remainingMs: 10_000 };
    const policy = { ...clock(), allowance };
    let calls = 0;

    // The first operation meets two pauses (1s + 2s) and succeeds.
    await retryOnTransientDatabaseError(
      'writing row 1',
      async () => {
        calls += 1;

        if (calls <= 2) {
          throw recovering();
        }

        return true;
      },
      policy,
    );

    expect(allowance.remainingMs).toBe(7_000);

    // The second meets an outage that never ends, and gets only what is left:
    // 1s + 2s + 4s, then an 8s pause would overdraw the 0 remaining.
    const failure = await retryOnTransientDatabaseError(
      'writing row 2',
      async () => {
        throw recovering();
      },
      policy,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect(allowance.remainingMs).toBe(0);
    expect(policy.slept).toEqual([1_000, 2_000, 1_000, 2_000, 4_000]);
  });

  it('does not stack a second budget on top of a nested one that already gave up', async () => {
    const policy = clock();
    const nested = new DatabaseUnavailableError('reading the batch', 9, 170_000, recovering());

    await expect(
      retryOnTransientDatabaseError(
        'pushing a batch',
        async () => {
          throw nested;
        },
        policy,
      ),
    ).rejects.toBe(nested);
    expect(policy.slept).toEqual([]);
  });
});
