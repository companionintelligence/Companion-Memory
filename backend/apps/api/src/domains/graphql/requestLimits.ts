import {
  Kind,
  parse,
  type ArgumentNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql';

/**
 * Size and breadth limits checked BEFORE graphql-js validates a document.
 *
 * Validation is not cheap and it is not authenticated. Apollo runs every
 * `specifiedRules` check on a document before `ComplexityPlugin` or any resolver
 * guard gets a say, and one of those rules, `OverlappingFieldsCanBeMergedRule`,
 * compares every pair of fields that share a response name (and, when both have
 * sub-selections, every pair beneath them). A document of a few hundred tokens
 * that repeats one field with a sub-selection was measured at 60 ms to validate;
 * a few thousand tokens of the same shape at over 4 s, all of it synchronous on
 * the one event loop that serves every user. So the bounds below are measured on
 * the parsed document, in linear time, and a document past them never reaches
 * `validate()`.
 *
 * Sized from what first-party clients actually send (see
 * `__tests__/requestLimits.test.ts`, which re-measures the web app's generated
 * documents on every run). On `main` 611460223 the largest, `Search`, measures
 * 1,106 tokens, 44 aliases, 439 expanded fields and 2,020 weighted same-name
 * pairs once Apollo Client has added `__typename` to every selection set, and
 * takes about 60 ms to validate the first time a process sees it. The importer's
 * bulk mutations (`createEvents`, `createCommunications`, `createContents`) send
 * their rows as variables, so their documents are a few dozen tokens whatever
 * the batch size.
 */
export interface GraphqlLimits {
  maxDocumentChars: number;
  maxTokens: number;
  maxAliases: number;
  maxFragments: number;
  maxExpandedFields: number;
  maxSameNamePairs: number;
  maxMergedDepth: number;
}

export const GRAPHQL_LIMITS: Readonly<GraphqlLimits> = {
  /**
   * Characters of document text, checked before anything parses it. The token
   * limit does not bound this: one string literal is one token however long it
   * is, and graphql-js lexes, hashes and prints the text several times over. A
   * single 9 MB literal held the event loop for about 2 s. Variables are not
   * counted, so bulk mutations that send their rows as variables are unaffected.
   */
  maxDocumentChars: 100_000,
  /**
   * Lexical tokens one document may contain; passed to Apollo as
   * `parseOptions.maxTokens` too, so a larger document fails in the parser.
   */
  maxTokens: 5_000,
  /** Aliased fields one document may write. Each alias is a separate resolver call. */
  maxAliases: 200,
  /**
   * Fragment definitions one document may carry. `OverlappingFieldsCanBeMerged`
   * also compares every pair of fragments spread into a selection set, whether
   * or not they share a field name, so none of the field counts below see that
   * work: 500 one-field fragments spread side by side passed them and took
   * about 400 ms to validate. At this limit the worst shape measured takes
   * 100 to 160 ms. The web app's largest document defines 35.
   */
  maxFragments: 80,
  /** Field selections once every fragment spread is expanded where it is used. */
  maxExpandedFields: 2_500,
  /**
   * Pairs of fields that share a response name in one merged selection set,
   * summed over the document and weighted by the size of their arguments. This
   * is the work `OverlappingFieldsCanBeMerged` does (it compares every such pair
   * and prints both argument lists to do it), so it is the bound that keeps
   * validation cheap: about 30 microseconds a pair on this hardware.
   */
  maxSameNamePairs: 4_500,
  /** Merged selection levels walked; deeper than any real query or introspection. */
  maxMergedDepth: 32,
};

/** What a document measured, for the error message and for tests. */
export interface GraphqlBreadth {
  aliases: number;
  expandedFields: number;
  sameNamePairs: number;
}

class BreadthExceeded extends Error {}

/** AST nodes in a value: what graphql-js prints each time it compares two fields' arguments. */
function valueSize(value: ValueNode): number {
  switch (value.kind) {
    case Kind.LIST:
      return value.values.reduce((sum, item) => sum + valueSize(item), 1);
    case Kind.OBJECT:
      return value.fields.reduce((sum, field) => sum + 1 + valueSize(field.value), 1);
    default:
      return 1;
  }
}

function argumentsSize(args: readonly ArgumentNode[] | undefined): number {
  return (args ?? []).reduce((sum, arg) => sum + 1 + valueSize(arg.value), 0);
}

/**
 * Measures `document` against `limits`, stopping as soon as one is passed.
 *
 * Fields are grouped the way `OverlappingFieldsCanBeMergedRule` groups them: by
 * response name within a selection set, with inline fragments and fragment
 * spreads merged in, and the sub-selections of every field in a group merged
 * into the next level. Counting is an over-estimate where graphql-js would
 * de-duplicate (a fragment spread under two different fields counts twice),
 * which only ever errs towards refusing.
 *
 * Runs before validation, so the document may be invalid in any way: unknown or
 * cyclic fragments are tolerated here (validation reports them), and the walk
 * itself is bounded by `maxExpandedFields` and `maxMergedDepth`, so a fragment
 * cycle or a spread tree that doubles at each level ends in a refusal rather
 * than a long walk.
 */
export function measureBreadth(
  document: DocumentNode,
  limits: GraphqlLimits = GRAPHQL_LIMITS,
): { breadth: GraphqlBreadth; violation: string | null } {
  const fragments = new Map<string, FragmentDefinitionNode>();
  const breadth: GraphqlBreadth = { aliases: 0, expandedFields: 0, sameNamePairs: 0 };
  const roots: SelectionSetNode[] = [];
  let fragmentCount = 0;

  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragmentCount += 1;
      fragments.set(definition.name.value, definition);
    } else if (definition.kind === Kind.OPERATION_DEFINITION) {
      roots.push(definition.selectionSet);
    }
  }

  if (fragmentCount > limits.maxFragments) {
    return {
      breadth,
      violation: `Query defines too many fragments: ${fragmentCount}. Maximum allowed: ${limits.maxFragments}`,
    };
  }

  // Written aliases, counted once each where they appear in the text.
  const countAliases = (selectionSet: SelectionSetNode): void => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD && selection.alias) {
        breadth.aliases += 1;
      }

      if (selection.kind !== Kind.FRAGMENT_SPREAD && selection.selectionSet) {
        countAliases(selection.selectionSet);
      }
    }
  };

  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION || definition.kind === Kind.OPERATION_DEFINITION) {
      countAliases(definition.selectionSet);
    }
  }

  if (breadth.aliases > limits.maxAliases) {
    return {
      breadth,
      violation: `Query uses too many aliases: ${breadth.aliases}. Maximum allowed: ${limits.maxAliases}`,
    };
  }

  let violation: string | null = null;
  // Fragment definitions some operation's walk spread into; the rest are walked on their own.
  const expanded = new Set<FragmentDefinitionNode>();

  const refuse = (message: string): never => {
    violation = message;
    throw new BreadthExceeded(message);
  };

  // One merged selection level: every field reachable from `sets` without
  // descending into a sub-selection, grouped by response name.
  const walk = (sets: readonly SelectionSetNode[], depth: number): void => {
    if (depth > limits.maxMergedDepth) {
      refuse(`Query is too deeply nested to check. Maximum merged depth: ${limits.maxMergedDepth}`);
    }

    const groups = new Map<string, { count: number; argumentsSize: number; children: SelectionSetNode[] }>();

    const collect = (selectionSet: SelectionSetNode, spread: Set<string>): void => {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          breadth.expandedFields += 1;

          if (breadth.expandedFields > limits.maxExpandedFields) {
            refuse(
              `Query selects too many fields: more than ${limits.maxExpandedFields} once fragments are expanded`,
            );
          }

          const key = (selection.alias ?? selection.name).value;
          const group = groups.get(key) ?? { count: 0, argumentsSize: 0, children: [] };

          group.count += 1;
          group.argumentsSize = Math.max(group.argumentsSize, argumentsSize(selection.arguments));

          if (selection.selectionSet) {
            group.children.push(selection.selectionSet);
          }

          groups.set(key, group);
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          collect(selection.selectionSet, spread);
        } else {
          // graphql-js collects each fragment name once per selection set.
          const name = selection.name.value;
          const fragment = fragments.get(name);

          if (fragment && !spread.has(name)) {
            spread.add(name);
            expanded.add(fragment);
            collect(fragment.selectionSet, spread);
          }
        }
      }
    };

    for (const selectionSet of sets) {
      collect(selectionSet, new Set());
    }

    for (const group of groups.values()) {
      // Two same-named fields are compared argument by argument, each value
      // printed, so a pair whose arguments are large costs that much more.
      breadth.sameNamePairs += ((group.count * (group.count - 1)) / 2) * (1 + group.argumentsSize);

      if (breadth.sameNamePairs > limits.maxSameNamePairs) {
        refuse(
          `Query repeats the same field too often: more than ${limits.maxSameNamePairs} same-name pairs`,
        );
      }
    }

    for (const group of groups.values()) {
      if (group.children.length > 0) {
        walk(group.children, depth + 1);
      }
    }
  };

  try {
    // Operations are measured together: graphql-js validates every operation in
    // the document, not just the one the request names.
    for (const root of roots) {
      walk([root], 1);
    }

    // graphql-js also validates every fragment definition's own selection set,
    // used or not. An unused fragment, or one whose name a later definition
    // shadows, is never reached from an operation above, so it is measured on
    // its own here. Without this, `{ __typename } fragment F on Query { …1,000
    // copies of a field… }` passed the check and held validation for seconds.
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION && !expanded.has(definition)) {
        walk([definition.selectionSet], 1);
      }
    }
  } catch (error) {
    if (!(error instanceof BreadthExceeded)) {
      throw error;
    }
  }

  return { breadth, violation };
}

/**
 * The reason `source` must not reach validation, or null when it may.
 *
 * A document longer than `maxDocumentChars` is refused before it is parsed.
 * One that does not parse is passed through (null): Apollo parses it again with
 * the same `maxTokens` and answers with its usual syntax error, so this check
 * never changes what a malformed or token-heavy request is told.
 */
export function graphqlSourceViolation(
  source: string,
  limits: GraphqlLimits = GRAPHQL_LIMITS,
): string | null {
  if (source.length > limits.maxDocumentChars) {
    return `Query document is too long: ${source.length} characters. Maximum allowed: ${limits.maxDocumentChars}`;
  }

  let document: DocumentNode;

  try {
    document = parse(source, { maxTokens: limits.maxTokens, noLocation: true });
  } catch {
    return null;
  }

  return measureBreadth(document, limits).violation;
}
