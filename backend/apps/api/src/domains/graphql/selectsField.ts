import { type GraphQLResolveInfo, Kind, type SelectionNode } from 'graphql';

/**
 * Whether the operation selects `name` directly under the field being resolved —
 * through any inline fragment or fragment spread, under any alias. For a
 * resolver that can leave out work the client did not ask for: a connection's
 * `totalCount` is a `COUNT(*)` over every row the user owns, and the page itself
 * never needs it.
 *
 * No `info` at all — a direct call from a test or from another resolver — reads
 * as selected: the safe answer is to do the work.
 */
export function selectsField(info: GraphQLResolveInfo | undefined, name: string): boolean {
  if (!info) {
    return true;
  }

  const spreadsSeen = new Set<string>();

  const selects = (selections: readonly SelectionNode[]): boolean =>
    selections.some((selection) => {
      switch (selection.kind) {
        case Kind.FIELD:
          return selection.name.value === name;
        case Kind.INLINE_FRAGMENT:
          return selects(selection.selectionSet.selections);
        case Kind.FRAGMENT_SPREAD: {
          const fragment = info.fragments[selection.name.value];

          if (!fragment || spreadsSeen.has(selection.name.value)) {
            return false;
          }

          spreadsSeen.add(selection.name.value);

          return selects(fragment.selectionSet.selections);
        }

        default:
          return false;
      }
    });

  return info.fieldNodes.some((node) => node.selectionSet != null && selects(node.selectionSet.selections));
}
