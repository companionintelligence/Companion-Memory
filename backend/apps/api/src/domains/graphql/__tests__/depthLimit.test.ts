import { buildSchema, getIntrospectionQuery, parse, specifiedRules, validate } from 'graphql';

import { createDepthLimitRule } from '../depthLimit';

/**
 * A self-referential type, which is what makes an unbounded depth reachable at
 * all: `ci.nodes` really does relate to itself, so `child { child { child …` is
 * a valid query of any length that `graphql-query-complexity` scores linearly.
 */
const schema = buildSchema(`
  type Node {
    id: ID!
    label: String
    child: Node
  }

  type Query {
    root: Node
  }
`);

function depthErrors(query: string, maxDepth: number): string[] {
  return validate(schema, parse(query), [createDepthLimitRule(maxDepth)]).map((error) => error.message);
}

const CHAIN_LINKS = 24;

/**
 * `F0 … F23`, each spreading the next one *twice*, leaving `F24` for the caller
 * to define. Two dozen short definitions, but the spread tree has 2^24 leaves,
 * so a rule that re-expands every spread walks 16 million of them — measured at
 * 17 s here before the depths were memoized, i.e. an unauthenticated way to pin
 * the event loop for as long as the client likes.
 */
function doublingFragmentChain(): string {
  const fragments = Array.from(
    { length: CHAIN_LINKS },
    (_unused, index) => `fragment F${index} on Node { child { ...F${index + 1} ...F${index + 1} } }`,
  );

  return `query Bomb { root { ...F0 } } ${fragments.join(' ')}`;
}

describe('createDepthLimitRule', () => {
  it('allows an operation exactly at the limit', () => {
    expect(depthErrors('{ root { child { label } } }', 3)).toEqual([]);
  });

  it('rejects an operation one level past the limit', () => {
    const errors = depthErrors('{ root { child { child { label } } } }', 3);

    expect(errors).toEqual(['Query is too deeply nested: 4. Maximum allowed depth: 3']);
  });

  it('names the operation when it has one', () => {
    const errors = depthErrors('query Deep { root { child { child { label } } } }', 3);

    expect(errors).toEqual(['Query "Deep" is too deeply nested: 4. Maximum allowed depth: 3']);
  });

  it('measures mutations too', () => {
    const mutationSchema = buildSchema(`
      type Node { id: ID!, child: Node }
      type Query { root: Node }
      type Mutation { touch: Node }
    `);
    const document = parse('mutation { touch { child { child { id } } } }');

    const errors = validate(mutationSchema, document, [createDepthLimitRule(3)]);

    expect(errors).toHaveLength(1);
  });

  it('counts through fragment spreads, so a fragment cannot be used to evade it', () => {
    const query = `
      query Sneaky { root { ...Deeper } }
      fragment Deeper on Node { child { child { label } } }
    `;

    // The spread itself is not a level; the three fields under it are, on top
    // of `root`.
    expect(depthErrors(query, 4)).toEqual([]);
    expect(depthErrors(query, 3)).toEqual([
      'Query "Sneaky" is too deeply nested: 4. Maximum allowed depth: 3',
    ]);
  });

  it('does not count a type condition as a level of nesting', () => {
    // `... on Node` costs the resolver nothing, so this is depth 2, not 3.
    expect(depthErrors('{ root { ... on Node { label } } }', 2)).toEqual([]);
  });

  it('terminates on a cyclic fragment instead of recursing forever', () => {
    const query = `
      query Cyclic { root { ...A } }
      fragment A on Node { child { ...B } }
      fragment B on Node { child { ...A } }
    `;

    // NoFragmentCyclesRule is what rejects this document; all this rule owes
    // the caller is an answer.
    expect(() => depthErrors(query, 12)).not.toThrow();
    expect(validate(schema, parse(query), specifiedRules).length).toBeGreaterThan(0);
  });

  it('measures a deep fragment chain in linear time, not exponential', () => {
    const query = `${doublingFragmentChain()} fragment F${CHAIN_LINKS} on Node { label }`;

    const started = Date.now();
    const errors = depthErrors(query, 12);
    const elapsed = Date.now() - started;

    // `root`, then 24 `child` links, then `label`.
    expect(errors).toEqual(['Query "Bomb" is too deeply nested: 26. Maximum allowed depth: 12']);
    // Memoized this is single-digit milliseconds; the threshold is loose only
    // so a busy CI box cannot flake it. Anything near it means the cache is gone.
    expect(elapsed).toBeLessThan(1000);
  });

  it('terminates on a cycle reached through a deep fragment chain', () => {
    // The cycle bail-out and the depth cache have to cooperate: closing the
    // chain back onto its first fragment must neither loop, overflow the stack,
    // nor fall back to re-expanding every spread.
    const query = `${doublingFragmentChain()} fragment F${CHAIN_LINKS} on Node { child { ...F0 } }`;

    const started = Date.now();
    expect(() => depthErrors(query, 12)).not.toThrow();

    expect(Date.now() - started).toBeLessThan(1000);
    // As above, NoFragmentCyclesRule is what rejects this document.
    expect(validate(schema, parse(query), specifiedRules).length).toBeGreaterThan(0);
  });

  it('terminates on a self-referential fragment', () => {
    const query = `query Self { root { ...A } } fragment A on Node { child { ...A } }`;

    expect(() => depthErrors(query, 12)).not.toThrow();
    expect(validate(schema, parse(query), specifiedRules).length).toBeGreaterThan(0);
  });

  it('exempts introspection, which nests deeper than any real query', () => {
    // graphql-js's own introspection query measures 15 by this rule. Counting
    // it would break codegen and GraphiQL against a dev server; introspection
    // is already off in production (see ../index.ts).
    const errors = validate(schema, parse(getIntrospectionQuery()), [createDepthLimitRule(12)]);

    expect(errors).toEqual([]);
  });

  it('leaves the deepest document the web app ships well inside the default 12', () => {
    // `query Search` in frontend/apps/web/src/pages/MemoryPage/useEntityService.tsx
    // measures 8 — the deepest of the 225 operations in the web app. `root`
    // plus six links plus `label` reproduces that.
    const links = 6;
    const query = `{ root ${'{ child '.repeat(links)}{ label }${' }'.repeat(links)} }`;

    expect(depthErrors(query, 12)).toEqual([]);
  });
});
