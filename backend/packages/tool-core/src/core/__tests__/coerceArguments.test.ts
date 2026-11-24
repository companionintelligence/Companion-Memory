import { coerceArgumentsToSchema } from '../coerceArguments';
import type { JSONSchema } from '../types';

const schema: JSONSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    maxResults: { type: 'integer', minimum: 1 },
    threshold: { type: 'number' },
    includeHidden: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    counts: { type: 'array', items: { type: 'integer' } },
    filter: { type: 'object', properties: { limit: { type: 'integer' } } },
    when: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    size: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  },
};

describe('coerceArgumentsToSchema', () => {
  it('types the strings a salvaged Qwen call carries, as the schema declares them', () => {
    // What Lemonade handed media_findPhotos on 2026-09-30, and what Zod then refused.
    expect(coerceArgumentsToSchema({ query: 'rabbits', maxResults: '15' }, schema)).toEqual({
      query: 'rabbits',
      maxResults: 15,
    });
    expect(coerceArgumentsToSchema({ threshold: ' 0.75 ', includeHidden: 'true' }, schema)).toEqual({
      threshold: 0.75,
      includeHidden: true,
    });
  });

  it('never reinterprets a string the schema allows to be a string', () => {
    expect(coerceArgumentsToSchema({ query: '2024' }, schema)).toEqual({ query: '2024' });
    expect(coerceArgumentsToSchema({ when: 'null' }, schema)).toEqual({ when: 'null' });
  });

  it('leaves a string that does not spell the declared type for the validator to refuse', () => {
    expect(coerceArgumentsToSchema({ maxResults: 'fifteen' }, schema)).toEqual({ maxResults: 'fifteen' });
    expect(coerceArgumentsToSchema({ maxResults: '1.5' }, schema)).toEqual({ maxResults: '1.5' });
    expect(coerceArgumentsToSchema({ includeHidden: 'yes' }, schema)).toEqual({ includeHidden: 'yes' });
  });

  it('follows anyOf branches, arrays and nested objects, and parses JSON text for structured params', () => {
    expect(coerceArgumentsToSchema({ size: '3' }, schema)).toEqual({ size: 3 });
    expect(coerceArgumentsToSchema({ size: 'null' }, schema)).toEqual({ size: null });
    expect(coerceArgumentsToSchema({ counts: ['1', '2'], tags: ['a'] }, schema)).toEqual({
      counts: [1, 2],
      tags: ['a'],
    });
    expect(coerceArgumentsToSchema({ counts: '["4", 5]' }, schema)).toEqual({ counts: [4, 5] });
    expect(coerceArgumentsToSchema({ filter: '{"limit": "7"}' }, schema)).toEqual({ filter: { limit: 7 } });
    expect(coerceArgumentsToSchema({ filter: { limit: '8' } }, schema)).toEqual({ filter: { limit: 8 } });
  });

  it('passes through anything the schema does not describe', () => {
    expect(coerceArgumentsToSchema({ unknown: '1' }, schema)).toEqual({ unknown: '1' });
    expect(coerceArgumentsToSchema({ maxResults: '15' }, undefined)).toEqual({ maxResults: '15' });
    expect(coerceArgumentsToSchema(null, schema)).toBeNull();
    expect(coerceArgumentsToSchema(7, schema)).toBe(7);
  });
});
