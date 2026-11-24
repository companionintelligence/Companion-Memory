import type { LoggerService } from '@ci/common/logging';

import { ContextPromptGenerateService } from '../ContextPromptGenerateService';

/**
 * The entity-pick selectors (`loadEntities`) and the "how do you know …?" gaps (`collectGaps`)
 * must never offer the owner their own Person. Both used to leave it out by its linked key,
 * `import:self`, which only the Person the import provisions — and, since onboarding moved onto
 * that key, the one a new signup makes — carries. An account onboarded earlier holds its self
 * Person with no linked key at all, so it was offered to its own owner.
 *
 * What a mocked `query` can prove is what is sent, so these pin the clause and its parameter: by
 * identity (the account's pointer, and the `is_self` claim), with the pointer compared NULL-safely
 * — it is NULL until the account has a self Person, and `<> NULL` would leave out every row.
 */
const USER = '00000000-0000-0000-0000-0000000000aa';

interface Internals {
  loadEntities(userId: string, entityType: string | null): Promise<Array<{ id: string; label: string }>>;
  collectGaps(userId: string): Promise<unknown[]>;
}

function setup() {
  // Declare the call signature on jest.fn itself, so `mock.calls[n]` is a (sql, params) tuple.
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as LoggerService;
  // collectGaps goes on to place the user in time; stopping it there keeps this to the entity queries.
  const placement = { timezoneFor: jest.fn().mockRejectedValue(new Error('past the entity queries')) };

  const service = new ContextPromptGenerateService(
    { query } as never,
    {} as never,
    {} as never,
    placement as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    logger,
  );

  return { service: service as unknown as Internals, query };
}

/** The SQL text, whitespace-normalized so assertions ignore formatting. */
const normalized = (sql: string) => sql.replace(/\s+/g, ' ');

describe('ContextPromptGenerateService leaves the owner out of entity prompts', () => {
  describe('loadEntities', () => {
    async function sent(entityType: string | null = 'Person') {
      const { service, query } = setup();
      await service.loadEntities(USER, entityType);

      expect(query).toHaveBeenCalledTimes(1);

      return { sql: normalized(query.mock.calls[0][0]), params: query.mock.calls[0][1] };
    }

    it("excludes the row the account points at, NULL-safely, by the owner's id", async () => {
      const { sql, params } = await sent();

      expect(sql).toContain(
        'ci.entities.entity_id IS DISTINCT FROM (SELECT u.entity_id FROM ci.users u WHERE u.id = $1)',
      );
      expect(sql).toContain('owner_user_id = $1');
      expect(params).toEqual([USER, 'Person']);
    });

    it('excludes any row claiming to be the owner, keyed or not', async () => {
      const { sql } = await sent(null);

      expect(sql).toContain('ci.entities.is_self IS NOT TRUE');
      expect(sql).toContain("COALESCE(ci.entities.linked_table, '') <> 'import:self'");
      expect(sql).not.toMatch(/entity_id <> \(SELECT/);
    });
  });

  describe('collectGaps', () => {
    async function peopleQuery() {
      const { service, query } = setup();
      await expect(service.collectGaps(USER)).rejects.toThrow('past the entity queries');

      const people = query.mock.calls.find(([sql]) => sql.includes('I do not know how you know'));
      expect(people).toBeDefined();

      return { sql: normalized(people![0]), params: people![1] };
    }

    it('asks how the owner knows anyone but themselves, by identity', async () => {
      const { sql, params } = await peopleQuery();

      expect(sql).toContain(
        'e.entity_id IS DISTINCT FROM (SELECT u.entity_id FROM ci.users u WHERE u.id = $1)',
      );
      expect(sql).toContain('e.is_self IS NOT TRUE');
      expect(sql).toContain("COALESCE(e.linked_table, '') <> 'import:self'");
      expect(params).toEqual([USER]);
    });
  });
});
