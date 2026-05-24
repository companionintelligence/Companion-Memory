import { createUnionType } from '@nestjs/graphql';

import { ActionType } from './ActionType';
import { BrowserActivityType } from './BrowserActivityType';
import { CommunicationType } from './CommunicationType';
import { ConceptType } from './ConceptType';
import { ContentType } from './ContentType';
import { EventType } from './EventType';
import { FileType } from './FileType';
import { GlobalUID } from './GlobalUID';
import { ItemType } from './ItemType';
import type { Node } from './Node';
import { NoteType } from './NoteType';
import { PersonType } from './PersonType';
import { PlaceType } from './PlaceType';
import { ThreadType } from './ThreadType';

export const TaggableEntityType = createUnionType({
  name: 'TaggableEntityType',
  types: () =>
    [
      ActionType,
      BrowserActivityType,
      CommunicationType,
      ConceptType,
      ContentType,
      EventType,
      FileType,
      ItemType,
      NoteType,
      PersonType,
      PlaceType,
      ThreadType,
    ] as const,
  resolveType(instance): typeof Node {
    const { type } = GlobalUID.decode(instance.id);

    switch (type) {
      case 'action':
        return ActionType;
      case 'browser-activity':
        return BrowserActivityType;
      case 'communication':
        return CommunicationType;
      case 'concept':
        return ConceptType;
      case 'content':
        return ContentType;
      case 'event':
        return EventType;
      case 'file':
        return FileType;
      case 'item':
        return ItemType;
      case 'note':
        return NoteType;
      case 'person':
        return PersonType;
      case 'place':
        return PlaceType;
      case 'thread':
        return ThreadType;
      default:
        throw new Error('Invalid type');
    }
  },
});

export type TaggableEntity = typeof TaggableEntityType;
