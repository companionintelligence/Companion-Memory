import '../styles.css';

import type { MemoryEntity } from '../../../MemoryPage/useEntityService';

import { BrowserActivityDetails } from './BrowserActivityDetails';
import { CommunicationDetails } from './CommunicationDetails';
import { EventDetails } from './EventDetails';
import { FallbackDetails } from './FallbackDetails';
import { GenericDetails } from './GenericDetails';
import { PlaceDetails } from './PlaceDetails';

export interface Props {
  entity: MemoryEntity;
}

function getCategoryComponent({ entity }: Props) {
  switch (entity.__typename) {
    case 'BrowserActivityType':
      return <BrowserActivityDetails entity={entity} />;
    case 'CommunicationType':
      return <CommunicationDetails entity={entity} />;
    case 'EventType':
      return <EventDetails entity={entity} />;
    case 'PlaceType':
      return <PlaceDetails entity={entity} />;
    // Graph nodes (REST) arrive as a synthetic GenericEntity.
    case 'GenericEntity':
      return <GenericDetails entity={entity} />;
    // Remaining explorer union members (Person, Content, Note, Concept, Item, …).
    default:
      return <FallbackDetails entity={entity} />;
  }
}

export function EntityDetails({ entity }: Props) {
  return getCategoryComponent({ entity });
}
