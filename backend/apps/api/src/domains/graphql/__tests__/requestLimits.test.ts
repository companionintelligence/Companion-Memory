import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildSchema,
  getIntrospectionQuery,
  Kind,
  Lexer,
  parse,
  print,
  Source,
  specifiedRules,
  TokenKind,
  validate,
  visit,
  type DocumentNode,
  type FieldNode,
  type SelectionSetNode,
} from 'graphql';

import { GRAPHQL_LIMITS, graphqlSourceViolation, measureBreadth } from '../requestLimits';

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');

/**
 * Every operation the web app ships, as graphql-codegen's client preset
 * generated it. Re-measured on every run so the limits cannot silently fall
 * below what the app sends: a new or grown query that would be refused fails
 * here, in the change that grows it.
 */
function webAppDocuments(): Array<{ name: string; document: DocumentNode }> {
  const generated = readFileSync(path.join(REPO_ROOT, 'frontend/apps/web/src/graphql/graphql.ts'), 'utf8');
  const pattern = /export const (\w+)Document = (\{.*?\}) as unknown as DocumentNode/g;
  const documents: Array<{ name: string; document: DocumentNode }> = [];

  for (const match of generated.matchAll(pattern)) {
    documents.push({ name: match[1], document: JSON.parse(match[2]) as DocumentNode });
  }

  return documents;
}

/**
 * What Apollo Client 3 actually puts on the wire: its `addTypename` default adds
 * `__typename` to every selection set below the operation root.
 */
function withTypename(document: DocumentNode): DocumentNode {
  const typename: FieldNode = { kind: Kind.FIELD, name: { kind: Kind.NAME, value: '__typename' } };

  return visit(document, {
    SelectionSet(node: SelectionSetNode, _key, parent) {
      if (
        parent &&
        !Array.isArray(parent) &&
        (parent as { kind?: string }).kind === Kind.OPERATION_DEFINITION
      ) {
        return undefined;
      }

      if (node.selections.some((s) => s.kind === Kind.FIELD && s.name.value === '__typename' && !s.alias)) {
        return undefined;
      }

      return { ...node, selections: [...node.selections, typename] };
    },
  });
}

function elapsedMs(run: () => unknown): number {
  const started = process.hrtime.bigint();
  run();

  return Number(process.hrtime.bigint() - started) / 1e6;
}

/** `count` copies of `field` in one selection set, with no aliases. */
function repeated(field: string, count: number): string {
  return `{ ${Array.from({ length: count }, () => field).join(' ')} }`;
}

describe('GraphQL request limits', () => {
  describe('first-party documents', () => {
    const documents = webAppDocuments();

    it('finds the generated web documents', () => {
      expect(documents.length).toBeGreaterThan(100);
    });

    it('accepts every document the web app sends, with headroom', () => {
      let largest = { chars: 0, tokens: 0, aliases: 0, fragments: 0, expandedFields: 0, sameNamePairs: 0 };

      for (const { name, document } of documents) {
        const wire = print(withTypename(document));

        expect({ name, violation: graphqlSourceViolation(wire) }).toEqual({ name, violation: null });

        const { breadth } = measureBreadth(parse(wire));
        const tokens = countTokens(wire);

        largest = {
          chars: Math.max(largest.chars, wire.length),
          tokens: Math.max(largest.tokens, tokens),
          aliases: Math.max(largest.aliases, breadth.aliases),
          fragments: Math.max(
            largest.fragments,
            document.definitions.filter((definition) => definition.kind === Kind.FRAGMENT_DEFINITION).length,
          ),
          expandedFields: Math.max(largest.expandedFields, breadth.expandedFields),
          sameNamePairs: Math.max(largest.sameNamePairs, breadth.sameNamePairs),
        };
      }

      // At least twice what the largest shipped document needs on every axis,
      // so ordinary growth of a query does not start failing in production.
      expect(largest.chars * 2).toBeLessThanOrEqual(GRAPHQL_LIMITS.maxDocumentChars);
      expect(largest.tokens * 2).toBeLessThanOrEqual(GRAPHQL_LIMITS.maxTokens);
      expect(largest.aliases * 2).toBeLessThanOrEqual(GRAPHQL_LIMITS.maxAliases);
      expect(largest.fragments * 2).toBeLessThanOrEqual(GRAPHQL_LIMITS.maxFragments);
      expect(largest.expandedFields * 2).toBeLessThanOrEqual(GRAPHQL_LIMITS.maxExpandedFields);
      expect(largest.sameNamePairs * 2).toBeLessThanOrEqual(GRAPHQL_LIMITS.maxSameNamePairs);
    });

    it('accepts the bulk mutations the importer and the CLI send', () => {
      // Rows travel as variables, so the document stays this size at any batch size.
      for (const source of [
        'mutation BulkEvents($input: [CreateEventInput!]!) {\n  createEvents(input: $input) { id }\n}',
        'mutation Bulk_createCommunications($input: [CreateCommunicationInput!]!) {\n  createCommunications(input: $input) { id }\n}',
        'mutation ImporterCreateContents($input: [CreateContentInput!]!) { createContents(input: $input) { id } }',
        'query { me { id } }',
      ]) {
        expect(graphqlSourceViolation(source)).toBeNull();
      }
    });

    it('accepts the standard introspection query (codegen and GraphiQL in development)', () => {
      expect(
        graphqlSourceViolation(getIntrospectionQuery({ descriptions: true, specifiedByUrl: true })),
      ).toBeNull();
    });
  });

  describe('documents that would make validation expensive', () => {
    it('refuses one field repeated many times in a selection set', () => {
      expect(graphqlSourceViolation(repeated('__typename', 1_000))).toMatch(/same field too often/);
    });

    it('refuses a repeated field with a sub-selection well inside the token limit', () => {
      // ~400 tokens; graphql-js took 60 ms on this shape before the check.
      expect(graphqlSourceViolation(repeated('me { __typename }', 100))).toMatch(/same field too often/);
    });

    it('refuses a document past the length limit before parsing it', () => {
      // One token however long, so the token limit never sees it; 40 copies of
      // a field with the same 240 KB literal took 1.9 s to validate.
      const long = `{ ${Array.from({ length: 40 }, () => `actions(after: "${'x'.repeat(240_000)}") { totalCount }`).join(' ')} }`;

      expect(graphqlSourceViolation(long)).toMatch(/too long/);
      expect(elapsedMs(() => graphqlSourceViolation(long))).toBeLessThan(50);
      expect(graphqlSourceViolation(`{ actions(after: "${'x'.repeat(90_000)}") { totalCount } }`)).toBeNull();
    });

    it('refuses repetition spread across fragments', () => {
      const fragments = Array.from({ length: 80 }, (_, i) => `fragment F${i} on Query { me { id } }`);
      const spreads = fragments.map((_, i) => `...F${i}`).join(' ');

      expect(graphqlSourceViolation(`{ ${spreads} } ${fragments.join(' ')}`)).toMatch(/same field too often/);
    });

    it('refuses repetition inside a fragment no operation uses', () => {
      // graphql-js validates every fragment definition, used or not.
      expect(
        graphqlSourceViolation(`{ __typename } fragment Unused on Query ${repeated('me { id }', 100)}`),
      ).toMatch(/same field too often/);
    });

    it('refuses repetition inside a fragment a later definition of the same name shadows', () => {
      expect(
        graphqlSourceViolation(
          `{ ...X } fragment X on Query ${repeated('me { id }', 100)} fragment X on Query { __typename }`,
        ),
      ).toMatch(/same field too often/);
    });

    it('measures a used fragment once, through the operation that spreads it', () => {
      const fragment = 'fragment F on Query { me { id } }';

      expect(measureBreadth(parse(`{ ...F } ${fragment}`)).breadth).toEqual(
        measureBreadth(parse('{ me { id } }')).breadth,
      );
    });

    it('refuses repetition that only multiplies out across nested levels', () => {
      // Five of each at three levels: 5 + 25 + 125 fields written, but the
      // merged third level holds 125 copies of one name.
      const nested = (levels: string[]): string =>
        levels.length === 0
          ? 'name'
          : Array(5)
              .fill(`${levels[0]} { ${nested(levels.slice(1))} }`)
              .join(' ');

      expect(graphqlSourceViolation(`{ ${nested(['__schema', 'types', 'fields'])} }`)).toMatch(
        /same field too often/,
      );
    });

    it('refuses a fragment tree that doubles at each level', () => {
      const fragments = Array.from(
        { length: 24 },
        (_, i) => `fragment F${i} on Query { a${i}: me { ...F${i + 1} } b${i}: me { ...F${i + 1} } }`,
      );

      expect(
        graphqlSourceViolation(`{ ...F0 } ${fragments.join(' ')} fragment F24 on UserType { id }`),
      ).toMatch(/too many fields|too deeply nested/);
    });

    it('ends on a fragment cycle instead of walking it forever', () => {
      expect(
        graphqlSourceViolation(
          '{ ...A } fragment A on Query { me { ...B } } fragment B on UserType { x { ...A } }',
        ),
      ).toMatch(/too many fields|too deeply nested/);
    });

    it('refuses a document past the expanded-field limit', () => {
      const wide = `{ ${Array.from({ length: 12 }, (_, i) => `a${i}: me { id }`).join(' ')} }`;

      expect(measureBreadth(parse(wide), { ...GRAPHQL_LIMITS, maxExpandedFields: 20 }).violation).toMatch(
        /too many fields/,
      );
      expect(measureBreadth(parse(wide), { ...GRAPHQL_LIMITS, maxExpandedFields: 24 }).violation).toBeNull();
    });

    it('stops walking past the merged depth limit', () => {
      const deep = '{ me { a: me { b: me { c: me { id } } } } }';

      expect(measureBreadth(parse(deep), { ...GRAPHQL_LIMITS, maxMergedDepth: 3 }).violation).toMatch(
        /too deeply nested/,
      );
      expect(measureBreadth(parse(deep), { ...GRAPHQL_LIMITS, maxMergedDepth: 5 }).violation).toBeNull();
    });

    it('refuses too many aliases', () => {
      const aliased = Array.from(
        { length: GRAPHQL_LIMITS.maxAliases + 1 },
        (_, i) => `a${i}: __typename`,
      ).join(' ');

      expect(graphqlSourceViolation(`{ ${aliased} }`)).toMatch(/too many aliases/);
    });

    it('refuses too many fragments, which validation compares pair by pair', () => {
      const count = GRAPHQL_LIMITS.maxFragments + 1;
      const spreads = Array.from({ length: count }, (_, i) => `...F${i}`).join(' ');
      const fragments = Array.from(
        { length: count },
        (_, i) => `fragment F${i} on Query { f${i}: __typename }`,
      );

      expect(graphqlSourceViolation(`{ ${spreads} } ${fragments.join(' ')}`)).toMatch(/too many fragments/);
    });

    it('leaves a document past the token limit, or one that does not parse, to Apollo', () => {
      // Apollo parses with the same maxTokens and answers with its own syntax
      // error, so the check must not pre-empt that message.
      expect(graphqlSourceViolation(repeated('a: __typename', 2_000))).toBeNull();
      expect(graphqlSourceViolation('{ me { ')).toBeNull();
    });
  });

  describe('cost', () => {
    const schema = buildSchema(readFileSync(path.join(__dirname, '../__generated__/schema.graphql'), 'utf8'));

    it('keeps validation of the broadest accepted document cheap', () => {
      // As many copies of a field with a sub-selection as the pair limit lets
      // through: the shape graphql-js finds most expensive per token.
      let copies = 2;

      while (graphqlSourceViolation(repeated('me { id }', copies + 1)) === null) {
        copies += 1;
      }

      const source = repeated('me { id }', copies);

      validate(schema, parse('{ __typename }'), specifiedRules);
      const accepted = elapsedMs(() => validate(schema, parse(source), specifiedRules));

      // Measured at about 120 ms, the same order as the web app's own `Search`.
      // Without the check, the same shape inside the token limit took over 4 s.
      // Loose enough that a loaded machine cannot flake it.
      expect(accepted).toBeLessThan(2_000);
    });

    it('keeps validation cheap when the repeated field carries long literals', () => {
      // The pair limit counts a literal as one node, so the length limit is what
      // bounds the printing graphql-js does per pair. The longest literal that
      // fits alongside as many copies as the pair limit allows:
      let copies = 2;

      while (graphqlSourceViolation(repeated('actions(after: "x") { totalCount }', copies + 1)) === null) {
        copies += 1;
      }

      const literal = 'x'.repeat(Math.floor(GRAPHQL_LIMITS.maxDocumentChars / copies) - 40);
      const source = repeated(`actions(after: "${literal}") { totalCount }`, copies);

      expect(graphqlSourceViolation(source)).toBeNull();

      const parsed = parse(source);

      // Measured at about 60 ms.
      expect(elapsedMs(() => validate(schema, parsed, specifiedRules))).toBeLessThan(1_000);
    });

    it('keeps validation cheap when every accepted fragment is spread side by side', () => {
      // Distinct field names, so no same-name pair is counted: the cost is the
      // pairwise fragment comparison alone. 500 of these took about 400 ms.
      const count = GRAPHQL_LIMITS.maxFragments;
      const spreads = Array.from({ length: count }, (_, i) => `...F${i}`).join(' ');
      const fragments = Array.from(
        { length: count },
        (_, i) =>
          `fragment F${i} on Query { ${Array.from({ length: 30 }, (_, j) => `f${i}x${j}`).join(' ')} ...F${(i + 1) % count} }`,
      );
      const source = `{ ${spreads} } ${fragments.join(' ')}`;

      expect(graphqlSourceViolation(source)).toBeNull();

      const parsed = parse(source);

      // Measured at 100 to 160 ms, the same order as the web app's own `Search`.
      expect(elapsedMs(() => validate(schema, parsed, specifiedRules))).toBeLessThan(1_000);
    });

    it('measures a maximal document in linear time', () => {
      const flat = repeated('__typename', GRAPHQL_LIMITS.maxTokens - 2);
      const nestedAliases = `{ ${Array.from({ length: 1_200 }, (_, i) => `a${i}: me { id }`).join(' ')} }`;

      for (const source of [flat, nestedAliases]) {
        expect(elapsedMs(() => graphqlSourceViolation(source))).toBeLessThan(500);
      }
    });
  });
});

function countTokens(source: string): number {
  const lexer = new Lexer(new Source(source));
  let count = 0;

  for (let token = lexer.advance(); token.kind !== TokenKind.EOF; token = lexer.advance()) {
    count += 1;
  }

  return count;
}
