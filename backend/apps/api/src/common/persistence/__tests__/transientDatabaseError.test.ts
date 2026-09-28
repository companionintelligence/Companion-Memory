import {
  classifyDatabaseError,
  classifyDatabaseMessage,
  DatabaseCrashedError,
  DatabaseNotReadyError,
  DatabaseUnavailableError,
  TransientDatabaseError,
  isDatabaseCrashError,
  isDatabaseNotReadyError,
  isTransientDatabaseError,
  isTransientDatabaseMessage,
  retryOnTransientDatabaseError,
  type TransientRetryPolicy,
} from '../transientDatabaseError';

/**
 * "The database is away" versus "the database said no" — and, within the
 * first, "it never took the statement" versus "it went down with the statement
 * in flight".
 *
 * The first case below is the incident this module exists for: a Postgres
 * crash-restart answered a live import push with SQLSTATE 57P03 for a few
 * seconds, and the push quarantined 437 good rows as if each one were poisoned.
 * The second is the reason the module does not resend everything it waits
 * for: a statement can crash Postgres, and resending it into every recovery
 * crashes it again every time.
 */

/** The shape TypeORM's QueryFailedError takes: the code on the error AND on driverError. */
function queryFailed(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: 'QueryFailedError',
    code,
    driverError: Object.assign(new Error(message), { code }),
  });
}

/** A Node system error, as `net` raises it. */
function socketError(code: string, syscall: string, message: string): Error {
  return Object.assign(new Error(message), { code, syscall });
}

describe('classifyDatabaseError', () => {
  it.each([
    ['57P03 in recovery', queryFailed('57P03', 'the database system is in recovery mode')],
    ['57P03 not accepting', queryFailed('57P03', 'the database system is not yet accepting connections')],
    ['57P03 shutting down', queryFailed('57P03', 'the database system is shutting down')],
    ['53300 full', queryFailed('53300', 'sorry, too many clients already')],
    ['08001 refused at connect', queryFailed('08001', 'could not connect to server')],
    ['a refused socket', socketError('ECONNREFUSED', 'connect', 'connect ECONNREFUSED 172.18.0.2:5432')],
    ['an unreachable host', socketError('EHOSTUNREACH', 'connect', 'connect EHOSTUNREACH 172.18.0.2:5432')],
    ['a DNS miss mid-restart', socketError('EAI_AGAIN', 'getaddrinfo', 'getaddrinfo EAI_AGAIN database')],
    ['a connect that timed out', socketError('ETIMEDOUT', 'connect', 'connect ETIMEDOUT 172.18.0.2:5432')],
    ['a pool with no free connection', new Error('timeout exceeded when trying to connect')],
    [
      // pg-pool kills the socket itself and wraps what pg says about it: the
      // outer, specific link decides, not the crash-shaped cause.
      'a pool connect timeout',
      new Error('Connection terminated due to connection timeout', {
        cause: new Error('Connection terminated unexpectedly'),
      }),
    ],
    [
      'a client pg already knows is dead',
      new Error('Client has encountered a connection error and is not queryable'),
    ],
  ])('calls %s NOT READY: the statement never ran', (_label, err) => {
    expect(classifyDatabaseError(err)).toBe('not_ready');
    expect(isDatabaseNotReadyError(err)).toBe(true);
    expect(isDatabaseCrashError(err)).toBe(false);
    expect(isTransientDatabaseError(err)).toBe(true);
  });

  it.each([
    ['57P01 admin shutdown', queryFailed('57P01', 'terminating connection due to administrator command')],
    [
      '57P02 crash of another backend',
      queryFailed('57P02', 'terminating connection because of crash of another server process'),
    ],
    ['08006 connection failure', queryFailed('08006', 'connection failure')],
    ['a reset socket', socketError('ECONNRESET', 'read', 'read ECONNRESET')],
    // Our write meeting a closed socket. The query goes out in one write, so
    // the pipe may have broken after the server had it: not provably unsent.
    ['a broken pipe', socketError('EPIPE', 'write', 'write EPIPE')],
    ['an open socket that stopped answering', socketError('ETIMEDOUT', 'read', 'read ETIMEDOUT')],
    // The backend running OUR statement died: pg says only this, with no code.
    ['pg losing the socket', new Error('Connection terminated unexpectedly')],
    [
      'a wrapped crash',
      new Error('bulk insert failed', {
        cause: queryFailed('57P02', 'terminating connection because of crash of another server process'),
      }),
    ],
  ])('calls %s a CRASH: the statement may have been in flight', (_label, err) => {
    expect(classifyDatabaseError(err)).toBe('crashed');
    expect(isDatabaseCrashError(err)).toBe(true);
    expect(isDatabaseNotReadyError(err)).toBe(false);
    expect(isTransientDatabaseError(err)).toBe(true);
  });

  it('reads the code off driverError when TypeORM did not copy it up', () => {
    const err = Object.assign(new Error('the database system is in recovery mode'), {
      driverError: { code: '57P03' },
    });

    expect(classifyDatabaseError(err)).toBe('not_ready');
  });

  it('looks inside an AggregateError, which is how a multi-address connect fails', () => {
    const err = new AggregateError([
      socketError('ECONNREFUSED', 'connect', 'connect ECONNREFUSED ::1:5432'),
      socketError('ECONNREFUSED', 'connect', 'connect ECONNREFUSED 127.0.0.1:5432'),
    ]);

    expect(classifyDatabaseError(err)).toBe('not_ready');
  });

  it('keeps a real rejection a rejection', () => {
    expect(
      classifyDatabaseError(
        queryFailed('23502', 'null value in column "content" violates not-null constraint'),
      ),
    ).toBeNull();
    expect(
      classifyDatabaseError(queryFailed('23505', 'duplicate key value violates unique constraint')),
    ).toBeNull();
    // Out of disk is its own stage failure (isOutOfDiskError), not a wait.
    expect(
      classifyDatabaseError(queryFailed('53100', 'could not extend file: No space left on device')),
    ).toBeNull();
    expect(classifyDatabaseError(new Error('Unexpected token in JSON'))).toBeNull();
    expect(classifyDatabaseError(null)).toBeNull();
    expect(classifyDatabaseError('the database system is in recovery mode')).toBeNull();
    expect(isTransientDatabaseError(queryFailed('23505', 'duplicate key'))).toBe(false);
  });

  it('lets a non-transient CODE win over transient-looking prose in the message', () => {
    // A value quoted into an error message is user data; the code is the verdict.
    expect(
      classifyDatabaseError(
        queryFailed('22P02', 'invalid input syntax for type uuid: "Connection terminated unexpectedly"'),
      ),
    ).toBeNull();
    expect(
      classifyDatabaseError(queryFailed('57P03', 'Connection terminated unexpectedly while starting up')),
    ).toBe('not_ready');
  });

  it('honours a verdict already carried by class, without reading through it', () => {
    const crash = new Error('Connection terminated unexpectedly');
    const recovering = queryFailed('57P03', 'the database system is in recovery mode');

    expect(classifyDatabaseError(new DatabaseNotReadyError('entity k: in recovery'))).toBe('not_ready');
    expect(classifyDatabaseError(new DatabaseUnavailableError('pushing', 3, 90_000, recovering))).toBe(
      'not_ready',
    );
    expect(classifyDatabaseError(new DatabaseCrashedError('pushing', crash))).toBe('crashed');
    // Wrapped in turn — a stage context, say — the verdict still stands.
    expect(
      classifyDatabaseError(new Error('push failed', { cause: new DatabaseCrashedError('x', crash) })),
    ).toBe('crashed');
    // A crash verdict wrapping a not-ready cause is still a crash: the class decided.
    expect(classifyDatabaseError(new DatabaseCrashedError('pushing', recovering))).toBe('crashed');
  });

  it('reads a bare TransientDatabaseError the safe way: away, and not provably unsent', () => {
    const err = new TransientDatabaseError('entity k: something about the database');

    expect(isTransientDatabaseError(err)).toBe(true);
    expect(classifyDatabaseError(err)).toBe('crashed');
  });
});

describe('DatabaseCrashedError', () => {
  it('is transient — never a reason to quarantine a row — and says it was not resent', () => {
    const crash = new DatabaseCrashedError(
      'writing a batch',
      new Error('Connection terminated unexpectedly'),
    );

    expect(crash).toBeInstanceOf(TransientDatabaseError);
    expect(isTransientDatabaseError(crash)).toBe(true);
    expect(crash.operation).toBe('writing a batch');
    expect(crash.message).toBe(
      'the database went down with writing a batch possibly in flight, so it was not sent again ' +
        '(last error: Connection terminated unexpectedly)',
    );
  });
});

describe('classifyDatabaseMessage', () => {
  it('recognises the text a string-only error channel is left with', () => {
    // GraphIngestService reports each failed entity as `entity <key>: <message>`.
    expect(classifyDatabaseMessage('the database system is in recovery mode')).toBe('not_ready');
    expect(classifyDatabaseMessage('connect ECONNREFUSED 10.0.0.4:5432')).toBe('not_ready');
    expect(classifyDatabaseMessage('connect ETIMEDOUT 10.0.0.4:5432')).toBe('not_ready');
    expect(classifyDatabaseMessage('Connection terminated unexpectedly')).toBe('crashed');
    expect(classifyDatabaseMessage('read ECONNRESET')).toBe('crashed');
    expect(classifyDatabaseMessage('write EPIPE')).toBe('crashed');
    expect(classifyDatabaseMessage('read ETIMEDOUT')).toBe('crashed');
    expect(classifyDatabaseMessage('terminating connection because of crash of another server process')).toBe(
      'crashed',
    );
    expect(classifyDatabaseMessage('value too long for type character varying(255)')).toBeNull();
    expect(classifyDatabaseMessage(null)).toBeNull();
    expect(isTransientDatabaseMessage('the database system is in recovery mode')).toBe(true);
    expect(isTransientDatabaseMessage('value too long for type character varying(255)')).toBe(false);
  });

  it('calls text naming both moments a crash: it cannot be shown to be the harmless one', () => {
    expect(
      classifyDatabaseMessage(
        'Connection terminated unexpectedly; then: the database system is in recovery mode',
      ),
    ).toBe('crashed');
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
  const crashed = () => new Error('Connection terminated unexpectedly');

  it('waits out a server that is not ready and returns what the operation eventually produced', async () => {
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

  it('never resends an operation the database went down under, and does not wait', async () => {
    const policy = clock();
    const cause = crashed();
    let calls = 0;

    const failure = await retryOnTransientDatabaseError(
      'writing a batch',
      async () => {
        calls += 1;

        throw cause;
      },
      policy,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DatabaseCrashedError);
    expect(failure).toMatchObject({ operation: 'writing a batch', cause });
    expect(calls).toBe(1);
    expect(policy.slept).toEqual([]);
  });

  it('raises the crash even after waiting out recovery first', async () => {
    // Not ready, not ready, then taken — and the server went down under it.
    const outcomes = [recovering, recovering, crashed];
    const policy = clock();
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
    expect(calls).toBe(3);
    expect(policy.slept).toEqual([1_000, 2_000]);
  });

  it('waits out a crash too, for an operation whose policy says it cannot be the cause', async () => {
    const policy = { ...clock(), resendAfterCrash: true };
    let calls = 0;

    const result = await retryOnTransientDatabaseError(
      'recording a stage failure',
      async () => {
        calls += 1;

        if (calls === 1) {
          throw crashed();
        }

        if (calls === 2) {
          throw recovering();
        }

        return 'recorded';
      },
      policy,
    );

    expect(result).toBe('recorded');
    expect(policy.slept).toEqual([1_000, 2_000]);
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

  it('passes a nested verdict straight up: no second budget, no resend past a crash', async () => {
    const nestedUnavailable = new DatabaseUnavailableError('reading the batch', 9, 170_000, recovering());
    const nestedCrash = new DatabaseCrashedError('writing a row', crashed());

    for (const nested of [nestedUnavailable, nestedCrash]) {
      const policy = { ...clock(), resendAfterCrash: true };
      let calls = 0;

      await expect(
        retryOnTransientDatabaseError(
          'pushing a batch',
          async () => {
            calls += 1;

            throw nested;
          },
          policy,
        ),
      ).rejects.toBe(nested);
      expect(calls).toBe(1);
      expect(policy.slept).toEqual([]);
    }
  });

  it('resends on an explicit not-ready verdict, and raises a bare transient one as a crash', async () => {
    const policy = clock();
    let calls = 0;

    await retryOnTransientDatabaseError(
      'resolving entities',
      async () => {
        calls += 1;

        if (calls === 1) {
          throw new DatabaseNotReadyError('entity k: the database system is in recovery mode');
        }

        return true;
      },
      policy,
    );

    expect(calls).toBe(2);

    await expect(
      retryOnTransientDatabaseError(
        'resolving entities',
        async () => {
          throw new TransientDatabaseError('entity k: gone');
        },
        clock(),
      ),
    ).rejects.toBeInstanceOf(DatabaseCrashedError);
  });
});
