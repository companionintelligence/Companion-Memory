import {
  quoteIdentifier,
  renderBatchedDelete,
  renderBatchedNull,
  renderDeleteUser,
  renderScope,
} from '../purgeSql';

const NOTES = { schema: 'ci', table: 'notes' };

describe('purge SQL', () => {
  describe('renderScope', () => {
    it('scopes owned rows to the bound account id', () => {
      expect(renderScope({ kind: 'owned', column: 'user_id' })).toBe('"user_id" = $1');
    });

    it('scopes a blocking child through its parent', () => {
      expect(
        renderScope({
          kind: 'referencesPurged',
          column: 'content_id',
          parent: { schema: 'ci', table: 'content', column: 'id' },
          parentScope: { kind: 'owned', column: 'user_id' },
        }),
      ).toBe('"content_id" IN (SELECT "id" FROM "ci"."content" WHERE "user_id" = $1)');
    });

    it('nests to any depth', () => {
      expect(
        renderScope({
          kind: 'referencesPurged',
          column: 'entity_tag_id',
          parent: { schema: 'ci_search', table: 'entity_tag', column: 'id' },
          parentScope: {
            kind: 'referencesPurged',
            column: 'tag_id',
            parent: { schema: 'ci_search', table: 'tags', column: 'id' },
            parentScope: { kind: 'owned', column: 'user_id' },
          },
        }),
      ).toBe(
        '"entity_tag_id" IN (SELECT "id" FROM "ci_search"."entity_tag" WHERE "tag_id" IN (SELECT "id" FROM "ci_search"."tags" WHERE "user_id" = $1))',
      );
    });
  });

  describe('batched statements', () => {
    it('bounds a delete by ctid and reports its own count', () => {
      expect(renderBatchedDelete(NOTES, { kind: 'owned', column: 'user_id' }, 500)).toBe(
        'WITH purge_batch AS (DELETE FROM "ci"."notes" WHERE ctid IN (SELECT ctid FROM "ci"."notes" WHERE "user_id" = $1 LIMIT 500) RETURNING 1) SELECT count(*)::int AS count FROM purge_batch',
      );
    });

    it('guards a null-out against rows it has already nulled', () => {
      // Without `IS NOT NULL` the ci.users.entity_id step, whose scope is
      // `id = $1`, keeps matching the same row after nulling it: a full batch
      // every time, and a loop that never ends.
      expect(
        renderBatchedNull({ schema: 'ci', table: 'users' }, 'entity_id', { kind: 'owned', column: 'id' }, 10),
      ).toContain('WHERE "id" = $1 AND "entity_id" IS NOT NULL LIMIT 10');
    });

    it('rejects a batch size that would unbound the statement', () => {
      expect(() => renderBatchedDelete(NOTES, { kind: 'owned', column: 'user_id' }, 0)).toThrow(
        /Invalid purge batch size/,
      );
      expect(() => renderBatchedDelete(NOTES, { kind: 'owned', column: 'user_id' }, 1_000_000)).toThrow(
        /Invalid purge batch size/,
      );
    });
  });

  it('deletes the account row by id', () => {
    expect(renderDeleteUser({ schema: 'ci', table: 'users' })).toContain(
      'DELETE FROM "ci"."users" WHERE "id" = $1',
    );
  });

  describe('identifier safety', () => {
    it('refuses a name that could not have come from this catalog', () => {
      // Catalog names are not user input, but they are interpolated, and a
      // destructive job is the wrong place to find out that assumption was wrong.
      expect(() => quoteIdentifier('users"; DROP TABLE ci.users; --')).toThrow(/unsafe identifier/);
      expect(() => quoteIdentifier('')).toThrow(/unsafe identifier/);
    });

    it('accepts ordinary catalog names', () => {
      expect(quoteIdentifier('user_id')).toBe('"user_id"');
      expect(quoteIdentifier('_hyper_1_2_chunk')).toBe('"_hyper_1_2_chunk"');
    });
  });
});
