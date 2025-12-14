import { createUnionType } from '@nestjs/graphql';

import { GlobalUID } from './GlobalUID';
import type { Node } from './Node';
import { PersonType } from './PersonType';

export const SearchResultType = createUnionType({
  name: 'SearchResultType',
  types: () => [PersonType] as const,
  resolveType(instance): typeof Node {
    const { type } = GlobalUID.decode(instance.id);

    switch (type) {
      case 'person':
        return PersonType;
      default:
        throw new Error('Invalid type');
    }
  },
});

export type SearchResult = typeof SearchResultType;
