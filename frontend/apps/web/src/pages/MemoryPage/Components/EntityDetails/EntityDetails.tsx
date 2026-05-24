import '../styles.css';

import type { EntityItem } from '../../../MemoryPage/useEntityService';

import { BrowserActivityDetails } from './BrowserActivityDetails';
import { CommunicationDetails } from './CommunicationDetails';
import { EventDetails } from './EventDetails';

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
    default:
      return null;
  }
}

export function EntityDetails({ entity }: Props) {
  return getCategoryComponent({ entity });
}
