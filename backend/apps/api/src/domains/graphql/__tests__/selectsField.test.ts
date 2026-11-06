import {
  type FragmentDefinitionNode,
  type GraphQLResolveInfo,
  Kind,
  type OperationDefinitionNode,
  parse,
} from 'graphql';

import { selectsField } from '../selectsField';

/** The resolve info `contents` would see for the given operation document. */
function infoFor(document: string): GraphQLResolveInfo {
  const parsed = parse(document);
  const operation = parsed.definitions.find(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  );
  const fragments = Object.fromEntries(
    parsed.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((definition) => [definition.name.value, definition]),
  );
  const root = operation?.selectionSet.selections[0];

  if (!root || root.kind !== Kind.FIELD) {
    throw new Error('document must start with a field');
  }

  return { fieldNodes: [root], fragments } as unknown as GraphQLResolveInfo;
}

describe('selectsField', () => {
  it('sees a field selected directly', () => {
    expect(selectsField(infoFor('{ contents { totalCount edges { cursor } } }'), 'totalCount')).toBe(true);
  });

  it('does not see a field the operation leaves out', () => {
    expect(
      selectsField(infoFor('{ contents { edges { node { id } } pageInfo { hasNextPage } } }'), 'totalCount'),
    ).toBe(false);
  });

  it('does not mistake a nested field of the same name for the direct one', () => {
    expect(selectsField(infoFor('{ contents { edges { node { totalCount } } } }'), 'totalCount')).toBe(false);
  });

  it('sees through an alias', () => {
    expect(selectsField(infoFor('{ contents { howMany: totalCount } }'), 'totalCount')).toBe(true);
  });

  it('sees through an inline fragment', () => {
    expect(
      selectsField(infoFor('{ contents { ... on ContentConnection { totalCount } } }'), 'totalCount'),
    ).toBe(true);
  });

  it('sees through a fragment spread, including one nested in another', () => {
    const document = `
      { contents { ...Page } }
      fragment Page on ContentConnection { edges { cursor } ...Count }
      fragment Count on ContentConnection { totalCount }
    `;

    expect(selectsField(infoFor(document), 'totalCount')).toBe(true);
  });

  it('answers false, not a hang, for a fragment that spreads itself', () => {
    const document = `
      { contents { ...Loop } }
      fragment Loop on ContentConnection { edges { cursor } ...Loop }
    `;

    expect(selectsField(infoFor(document), 'totalCount')).toBe(false);
  });

  it('reads a missing info as selected, so a direct caller gets the work done', () => {
    expect(selectsField(undefined, 'totalCount')).toBe(true);
  });
});
