import '../styles.css';

import type { EntityItem } from '../../../MemoryPage/useEntityService';

import { BrowserActivityDetails } from './BrowserActivityDetails';
import { CommunicationDetails } from './CommunicationDetails';
import { EventDetails } from './EventDetails';
import { GenericDetails } from './GenericDetails';
import { PlaceDetails } from './PlaceDetails';

export interface Props {
  entity: EntityItem;
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
    default:
      return <GenericDetails entity={entity} />;
  }
}

export function EntityDetails({ entity }: Props) {
  return getCategoryComponent({ entity });
}
