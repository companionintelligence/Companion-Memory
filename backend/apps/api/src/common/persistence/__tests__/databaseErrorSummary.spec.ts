import { summarizeDatabaseError } from '../databaseErrorSummary';

/** Shaped like TypeORM's QueryFailedError: the driver's fields copied onto it and kept on `driverError`. */
function queryFailed(message: string, fields: { code: string; constraint?: string }): Error {
  return Object.assign(new Error(message), { ...fields, driverError: { ...fields } });
}

describe('summarizeDatabaseError', () => {
  it('names a refusal by its SQLSTATE and constraint, not its message', () => {
    const err = queryFailed(
      'new row for relation "_hyper_13_2_chunk" violates check constraint "valid_positioning"',
      { code: '23514', constraint: 'valid_positioning' },
    );

    expect(summarizeDatabaseError(err)).toEqual({
      kind: 'refused',
      code: '23514',
      constraint: 'valid_positioning',
    });
  });

  it('calls a server that was away unavailable, socket codes included', () => {
    expect(
      summarizeDatabaseError(queryFailed('the database system is in recovery mode', { code: '57P03' })),
    ).toEqual({ kind: 'unavailable', code: '57P03', constraint: null });
    expect(
      summarizeDatabaseError(
        Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), { code: 'ECONNREFUSED' }),
      ),
    ).toMatchObject({ kind: 'unavailable', code: 'ECONNREFUSED' });
    // Five capitals like a SQLSTATE, but a socket that broke.
    expect(summarizeDatabaseError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('leaves an error with no code to its caller', () => {
    expect(summarizeDatabaseError(new Error('A position needs a timestamp.'))).toBeNull();
    expect(summarizeDatabaseError('plain string')).toBeNull();
    expect(summarizeDatabaseError(null)).toBeNull();
  });
});
