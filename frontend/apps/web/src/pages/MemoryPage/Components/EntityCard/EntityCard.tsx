import type { EntityItem } from '../../useEntityService';

import { BrowserActivityCard } from './BrowserActivityCard';
import { CommunicationCard } from './CommunicationCard';
import { EventCard } from './EventCard';
import { FileChunkCard } from './FileChunkCard';

export interface Props {
  entity: EntityItem;
}

export function EntityCard({ entity }: Props) {
  switch (entity.__typename) {
    case 'BrowserActivityType':
      return <BrowserActivityCard entity={entity} />;
    case 'EventType':
      return <EventCard entity={entity} />;
    case 'CommunicationType':
      return <CommunicationCard entity={entity} />;
    case 'FileChunkType':
      return <FileChunkCard entity={entity} />;
    default:
      return null;
  }
}
