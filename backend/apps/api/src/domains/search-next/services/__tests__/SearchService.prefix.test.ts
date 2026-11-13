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
  const service = new SearchService(
    { query } as unknown as DataSource,
    { generateEmbeddingString: jest.fn() } as unknown as EmbeddingGenerationService,
    { get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS) } as unknown as RetrievalPolicyService,
    { send: jest.fn().mockResolvedValue([]) } as unknown as EventService,
  );

  return { service, query };
}

describe('prefixTermOf', () => {
  it('takes the last word, lower-cased', () => {
    expect(prefixTermOf('Jor')).toBe('jor');
    expect(prefixTermOf('  coffee with Jor  ')).toBe('jor');
  });

  it('keeps letters and digits only, so no tsquery syntax reaches the query', () => {
    expect(prefixTermOf("O'Br")).toBe('obr');
    expect(prefixTermOf('jor:* | !x')).toBe('x');
    expect(prefixTermOf('Zoë')).toBe('zoë');
  });

  it('is null when nothing usable is left', () => {
    expect(prefixTermOf('')).toBeNull();
    expect(prefixTermOf('   ')).toBeNull();
    expect(prefixTermOf('coffee :*')).toBeNull();
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
    expect(params[3]).toBe('jor');
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
    expect(params[4]).toBe('jor');
  });

  it('leaves the query as it was without the flag', async () => {
    const { service, query } = makeService();

    await service.search(CONTEXT, { query: 'Jor', mode: 'keyword' });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    expect(sql).not.toContain(':*');
    expect(params).toHaveLength(3);
    expect(params).not.toContain('jor');
  });
});
