import '../styles.css';

import type { MemoryEntity } from '../../../MemoryPage/useEntityService';

import { BrowserActivityDetails } from './BrowserActivityDetails';
import { CommunicationDetails } from './CommunicationDetails';
import { EventDetails } from './EventDetails';
import { GenericDetails } from './GenericDetails';

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
    case 'GenericEntity':
      return <GenericDetails entity={entity} />;
    default:
      return null;
  }
}

export function EntityDetails({ entity }: Props) {
  return getCategoryComponent({ entity });
}
