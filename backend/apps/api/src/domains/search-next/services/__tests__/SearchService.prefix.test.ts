import type { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import type { EventService } from '@ci/domains/events';
import { RETRIEVAL_POLICY_DEFAULTS, type RetrievalPolicyService } from '@ci/domains/retrieval-policy';

import { SearchService, prefixTermOf } from '../SearchService';

/**
 * `prefix: true` is search as you type, for a note's `[[` link menu: "Jor"
 * must find Jordan before the word is finished. `websearch_to_tsquery` alone
 * matches whole stemmed words, so the keyword query gains the last word as a
 * `:*` prefix. Stubbed DataSource; the SQL itself runs against Postgres in
 * the scoping integration spec.
 */
const CONTEXT = { userId: 'user-1' } as unknown as UserServiceContext;

function makeService() {
  const query = jest.fn().mockResolvedValue([]);
  const generateEmbeddingString = jest.fn();
  const service = new SearchService(
    { query } as unknown as DataSource,
    { generateEmbeddingString } as unknown as EmbeddingGenerationService,
    { get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS) } as unknown as RetrievalPolicyService,
    { send: jest.fn().mockResolvedValue([]) } as unknown as EventService,
  );

  return { service, query, generateEmbeddingString };
}

describe('prefixTermOf', () => {
  it('takes the last word as typed, for Postgres to lower-case', () => {
    expect(prefixTermOf('Jor')).toBe('Jor');
    expect(prefixTermOf('  coffee with Jor  ')).toBe('Jor');
    // JavaScript lowers "İ" to "i" plus a combining dot; Postgres, which built
    // the index, lowers it to "i".
    expect(prefixTermOf('İst')).toBe('İst');
  });

  it('keeps letters, marks and digits only, so no tsquery syntax reaches the query', () => {
    expect(prefixTermOf('jor:* | !xy')).toBe('xy');
    expect(prefixTermOf('Zoë')).toBe('Zoë');
    expect(prefixTermOf('3M')).toBe('3M');
  });

  it('keeps combining marks inside the word, as Postgres does', () => {
    // Devanagari vowel signs are marks; "राहुल" is indexed as one lexeme.
    expect(prefixTermOf('राहु')).toBe('राहु');
    // "Zoë" typed as "e" plus a combining diaeresis.
    expect(prefixTermOf('Zoe\u0308')).toBe('Zoe\u0308');
  });

  it('takes the part after an apostrophe or hyphen, as Postgres splits the word', () => {
    // "O'Brien" is indexed as `o` and `brien`, "Jean-Pierre" with a `pierr` part.
    expect(prefixTermOf("O'Br")).toBe('Br');
    expect(prefixTermOf('Jean-Pi')).toBe('Pi');
  });

  it('is null when nothing usable is left', () => {
    expect(prefixTermOf('')).toBeNull();
    expect(prefixTermOf('   ')).toBeNull();
    expect(prefixTermOf(':*')).toBeNull();
  });

  it('is null for a single letter, which would match nearly every row', () => {
    expect(prefixTermOf('J')).toBeNull();
    expect(prefixTermOf('Jordan H')).toBeNull();
    expect(prefixTermOf('Jo')).toBe('Jo');
  });
});

describe('SearchService keyword search with prefix', () => {
  it('ORs the last word in as a prefix and binds it as the last parameter', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'Jor', mode: 'keyword', prefix: true });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    // $3 is the default type exclusion list, so the prefix is $4.
    expect(sql).toContain(`|| to_tsquery('simple', $4 || ':*')`);
    expect(params).toHaveLength(4);
    expect(params.slice(0, 2)).toEqual(['user-1', 'Jor']);
    expect(params[3]).toBe('Jor');
  });

  it('numbers the prefix after the type and time filters', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, {
      query: 'Jor',
      mode: 'keyword',
      prefix: true,
      includeTypes: ['person', 'note'],
      since: new Date('2026-01-01T00:00:00.000Z'),
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain(`to_tsquery('simple', $5 || ':*')`);
    expect(params).toHaveLength(5);
    expect(params[4]).toBe('Jor');
  });

  it('runs keyword search for an auto-mode query of any length', async () => {
    const { service, query, generateEmbeddingString } = makeService();

    // Five words: left to the word count, auto would pick boosted and drop the prefix.
    await service.search(CONTEXT, { query: 'coffee with Jordan at Ha', prefix: true });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    expect(generateEmbeddingString).not.toHaveBeenCalled();
    expect(sql).toContain(`to_tsquery('simple', $4 || ':*')`);
    expect(params[3]).toBe('Ha');
  });

  it('leaves the query as it was without the flag', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'Jor', mode: 'keyword' });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).not.toContain(':*');
    expect(params).toHaveLength(3);
  });
});
