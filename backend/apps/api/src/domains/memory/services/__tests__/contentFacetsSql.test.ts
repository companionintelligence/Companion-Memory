import { contentTypeFilterSql, contentTypeOptions } from '../contentFacetsSql';

describe('contentTypeOptions', () => {
  it('offers media rows by kind and folds a raw kind-named type into the same option', () => {
    // Raw column: one Reddit row typed `video`, everything imported typed `media`.
    expect(contentTypeOptions(['like', 'media', 'note', 'video'], ['image', 'video', 'media'])).toEqual([
      'image',
      'like',
      'media',
      'note',
      'video',
    ]);
  });

  it('never offers bare media when no media row escapes the kinds', () => {
    expect(contentTypeOptions(['media', 'post'], ['image'])).toEqual(['image', 'post']);
  });
});

describe('contentTypeFilterSql', () => {
  it('matches a kind as its raw type OR a media row of that mimetype', () => {
    const { sql, parameters } = contentTypeFilterSql('content', ['video']);

    expect(sql).toBe(
      "((content.type = 'media' AND content.mimetype LIKE 'video/%') OR content.type IN (:...contentTypes))",
    );
    expect(parameters).toEqual({ contentTypes: ['video'] });
  });

  it('matches bare media as the rows no kind claims', () => {
    const { sql, parameters } = contentTypeFilterSql('c', ['media']);

    expect(sql).toBe(
      "((c.type = 'media' AND (c.mimetype IS NULL OR (c.mimetype NOT LIKE 'image/%' AND c.mimetype NOT LIKE 'video/%' AND c.mimetype NOT LIKE 'audio/%'))))",
    );
    expect(parameters).toEqual({});
  });

  it('passes other types through and ORs a mixed selection', () => {
    const { sql, parameters } = contentTypeFilterSql('c', ['note', 'image', 'post']);

    expect(sql).toBe("((c.type = 'media' AND c.mimetype LIKE 'image/%') OR c.type IN (:...contentTypes))");
    expect(parameters).toEqual({ contentTypes: ['note', 'image', 'post'] });
  });
});
