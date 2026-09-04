import {
  GraphQLError,
  Kind,
  type ASTVisitor,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';

/**
 * Depth of the deepest field chain reachable from `selectionSet`.
 *
 * Fragments are resolved rather than skipped: counting only what is written
 * inline would let any depth be reached by spreading a fragment, which is the
 * standard way around a naive depth check.
 *
 * `fragmentDepths` memoizes each fragment's measured depth for the document
 * being validated. Without it a document whose fragments each spread the next
 * one twice costs 2^n work, so the rule meant to bound a request would itself
 * be an unauthenticated way to block the event loop.
 */
function selectionSetDepth(
  selectionSet: SelectionSetNode,
  context: ValidationContext,
  visitedFragments: ReadonlySet<string>,
  fragmentDepths: Map<string, number>,
): number {
  let deepest = 0;

  for (const selection of selectionSet.selections) {
    let depth = 0;

    switch (selection.kind) {
      case Kind.FIELD: {
        // Introspection meta-fields are exempt. graphql-js's own introspection
        // query nests `ofType` seven deep and measures 15 by this rule, so
        // counting it would break codegen and GraphiQL against a dev server for
        // no security gain: it reads the schema, never user data, and is
        // already off in production (see the driver options in ./index.ts).
        const isMetaField = selection.name.value.startsWith('__');

        depth =
          selection.selectionSet && !isMetaField
            ? 1 + selectionSetDepth(selection.selectionSet, context, visitedFragments, fragmentDepths)
            : 1;
        break;
      }

      case Kind.INLINE_FRAGMENT:
        // A type condition is not a level of nesting — `... on FileType { size }`
        // costs the resolver exactly what a bare `size` costs.
        depth = selectionSetDepth(selection.selectionSet, context, visitedFragments, fragmentDepths);
        break;

      case Kind.FRAGMENT_SPREAD: {
        const name = selection.name.value;
        const fragment = context.getFragment(name);

        // An undefined or cyclic spread is already reported by
        // `NoUndefinedVariablesRule` / `NoFragmentCyclesRule`; bailing out here
        // only keeps this rule from recursing forever on such a document.
        if (!fragment || visitedFragments.has(name)) {
          break;
        }

        const memoized = fragmentDepths.get(name);

        if (memoized !== undefined) {
          depth = memoized;
          break;
        }

        depth = selectionSetDepth(
          fragment.selectionSet,
          context,
          new Set([...visitedFragments, name]),
          fragmentDepths,
        );

        // In a *cyclic* document this cached depth is path-dependent — the
        // bail-out above truncates wherever the cycle was first closed, so a
        // later spread reached by another path may read a value that is too
        // small. Harmless, and deliberately not worked around: `validate()`
        // runs `NoFragmentCyclesRule` in the same pass, which rejects such a
        // document whatever this rule reports.
        fragmentDepths.set(name, depth);
        break;
      }
    }

    if (depth > deepest) {
      deepest = depth;
    }
  }

  return deepest;
}

/**
 * Rejects operations nested deeper than `maxDepth`.
 *
 * `graphql-query-complexity` (see `plugins/ComplexityPlugin`) bounds how *many*
 * fields a query selects, which a narrow but deeply recursive selection keeps
 * small while still walking the resolver graph far further than any real client
 * does — `PlaceType.parent: PlaceType` and the `EventType.contents` →
 * `ContentType.event` cycle are both walkable without limit. Hand-written
 * against the `graphql` visitor API rather than pulled in as a dependency: the
 * whole rule is the function above.
 */
export function createDepthLimitRule(maxDepth: number): ValidationRule {
  return (context: ValidationContext): ASTVisitor => {
    // Per validation context, i.e. per document: fragment names are chosen by
    // the caller, so a cache outliving the document would answer one request
    // with another's `fragment Foo` and grow without bound — the rule object
    // itself is built once at startup and shared by every request.
    const fragmentDepths = new Map<string, number>();

    return {
      OperationDefinition(operation: OperationDefinitionNode) {
        const depth = selectionSetDepth(operation.selectionSet, context, new Set(), fragmentDepths);

        if (depth > maxDepth) {
          const label = operation.name ? `"${operation.name.value}" ` : '';
          const message = `Query ${label}is too deeply nested: ${depth}. Maximum allowed depth: ${maxDepth}`;

          context.reportError(new GraphQLError(message, { nodes: [operation] }));
        }

        // The whole operation has just been measured; letting the visitor
        // descend would re-walk every sub-selection without changing the answer.
        return false;
      },
    };
  };
}
