import { isIntegrityConstraintViolation } from '../constants';

describe('isIntegrityConstraintViolation', () => {
  // SQLSTATE class 23: restrict, not-null, foreign key, unique, check, exclusion.
  it.each(['23000', '23001', '23502', '23503', '23505', '23514', '23P01'])(
    'is true for %s, whether it is on the error or on TypeORM’s driverError',
    (code) => {
      expect(isIntegrityConstraintViolation({ code })).toBe(true);
      expect(isIntegrityConstraintViolation({ driverError: { code } })).toBe(true);
      expect(isIntegrityConstraintViolation(Object.assign(new Error('boom'), { code }))).toBe(true);
    },
  );

  // What is worth a second try: contention and connections. And the other classes, which are
  // not integrity violations at all.
  it.each(['40P01', '40001', '55P03', '57014', '08006', '42P01', '22P02', 'ECONNRESET', 'ETIMEDOUT'])(
    'is false for %s',
    (code) => {
      expect(isIntegrityConstraintViolation({ code })).toBe(false);
      expect(isIntegrityConstraintViolation({ driverError: { code } })).toBe(false);
    },
  );

  it('is false for anything that is not carrying a string code', () => {
    expect(isIntegrityConstraintViolation(undefined)).toBe(false);
    expect(isIntegrityConstraintViolation(null)).toBe(false);
    expect(isIntegrityConstraintViolation('23503')).toBe(false);
    expect(isIntegrityConstraintViolation(23503)).toBe(false);
    expect(isIntegrityConstraintViolation({ code: 23503 })).toBe(false);
    expect(isIntegrityConstraintViolation({})).toBe(false);
    expect(isIntegrityConstraintViolation(new Error('23503'))).toBe(false);
  });
});
