import { z } from 'zod';

import { booleanish, coerceBooleanish } from '../booleanish';

/**
 * `z.coerce.boolean()` is `Boolean(value)`, which makes "false" true. This
 * helper maps only the spellings a model plausibly sends and leaves anything
 * else to fail validation as before.
 */
describe('booleanish', () => {
  it.each([
    ['true', true],
    ['True', true],
    [' yes ', true],
    ['1', true],
    ['on', true],
    ['false', false],
    ['FALSE', false],
    ['no', false],
    ['0', false],
    ['off', false],
  ])('maps %j to %s', (input, expected) => {
    expect(coerceBooleanish(input)).toBe(expected);
  });

  it('passes real booleans and non-strings through untouched', () => {
    expect(coerceBooleanish(true)).toBe(true);
    expect(coerceBooleanish(false)).toBe(false);
    expect(coerceBooleanish(undefined)).toBeUndefined();
    expect(coerceBooleanish(1)).toBe(1);
  });

  it('leaves an unrecognised string alone so the schema still rejects it', () => {
    expect(coerceBooleanish('maybe')).toBe('maybe');
    expect(booleanish().safeParse('maybe').success).toBe(false);
  });

  it('chains with .optional() and .default() like z.boolean()', () => {
    const schema = z.object({ a: booleanish().optional(), b: booleanish().default(true) });

    expect(schema.parse({})).toEqual({ b: true });
    expect(schema.parse({ a: 'false', b: 'no' })).toEqual({ a: false, b: false });
  });
});
