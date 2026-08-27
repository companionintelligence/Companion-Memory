import { buildJsonbLeafPatchSql } from '../jsonbLeafPatch';

describe('buildJsonbLeafPatchSql', () => {
  it('targets one leaf path per write instead of replacing the sub-object', () => {
    const { expression, parameters } = buildJsonbLeafPatchSql('properties', [
      { path: ['planner', 'trust_mode'], value: 'cautious' },
    ]);

    // One jsonb_set for the ancestor container, one for the leaf itself.
    expect(expression.match(/jsonb_set\(/g)).toHaveLength(2);
    expect(expression).toContain(`:jsonbLeaf0Path::text[]`);
    expect(expression).toContain(`:jsonbLeaf0Value::jsonb`);
    expect(parameters.jsonbLeaf0Path).toStrictEqual(['planner', 'trust_mode']);
    expect(parameters.jsonbLeaf0Value).toBe('"cautious"');

    // The whole-sub-object shallow merge is what caused the lost update; the
    // leaf builder must never fall back to it.
    expect(expression).not.toContain('||');
  });

  it('creates missing ancestor containers from the row, shallowest first', () => {
    const { expression, parameters } = buildJsonbLeafPatchSql('properties', [
      { path: ['a', 'b', 'c'], value: 1 },
    ]);

    expect(parameters.jsonbLeafAncestor0Path).toStrictEqual(['a']);
    expect(parameters.jsonbLeafAncestor1Path).toStrictEqual(['a', 'b']);
    // `{a}` is materialised in the innermost call, i.e. before `{a,b}` is set on
    // top of it.
    expect(expression.indexOf(':jsonbLeafAncestor0Path')).toBeLessThan(
      expression.indexOf(':jsonbLeafAncestor1Path'),
    );
    // A scalar sitting where a container belongs is replaced rather than
    // raising `cannot set path in scalar`.
    expect(expression).toContain(`jsonb_typeof(properties #> :jsonbLeafAncestor0Path::text[]) = 'object'`);
  });

  it('de-duplicates shared ancestors across leaves', () => {
    const { expression, parameters } = buildJsonbLeafPatchSql('properties', [
      { path: ['planner', 'trust_mode'], value: 'cautious' },
      { path: ['planner', 'image_description_enabled'], value: false },
    ]);

    expect(Object.keys(parameters).filter((key) => key.includes('Ancestor'))).toStrictEqual([
      'jsonbLeafAncestor0Path',
    ]);
    // 1 ancestor + 2 leaves.
    expect(expression.match(/jsonb_set\(/g)).toHaveLength(3);
    expect(parameters.jsonbLeaf1Value).toBe('false');
  });

  it('never interpolates path segments into the SQL text', () => {
    const { expression, parameters } = buildJsonbLeafPatchSql('properties', [
      { path: ['planner', `x'); drop table ci.entities; --`], value: 1 },
    ]);

    expect(expression).not.toContain('drop table');
    expect(parameters.jsonbLeaf0Path).toStrictEqual(['planner', `x'); drop table ci.entities; --`]);
  });

  it('rejects top-level keys, which patch() owns because of the typed columns', () => {
    expect(() => buildJsonbLeafPatchSql('properties', [{ path: ['is_self'], value: true }])).toThrow(
      /at least 2 segments/,
    );
  });

  it('rejects an empty leaf list and empty segments', () => {
    expect(() => buildJsonbLeafPatchSql('properties', [])).toThrow(/at least one leaf/);
    expect(() => buildJsonbLeafPatchSql('properties', [{ path: ['planner', ''], value: 1 }])).toThrow(
      /non-empty strings/,
    );
  });

  it('writes null and false as JSON values rather than dropping them', () => {
    const { parameters } = buildJsonbLeafPatchSql('properties', [
      { path: ['planner', 'a'], value: null },
      { path: ['planner', 'b'], value: false },
      { path: ['planner', 'c'], value: undefined },
    ]);

    expect(parameters.jsonbLeaf0Value).toBe('null');
    expect(parameters.jsonbLeaf1Value).toBe('false');
    expect(parameters.jsonbLeaf2Value).toBe('null');
  });
});
