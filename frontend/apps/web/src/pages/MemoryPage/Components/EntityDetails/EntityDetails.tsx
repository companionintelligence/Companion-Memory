import '../styles.css';

import type { MemoryEntity } from '../../useEntityService';

import { BrowserActivityDetails } from './BrowserActivityDetails';
import { CommunicationDetails } from './CommunicationDetails';
import { ConceptDetails } from './ConceptDetails';
import { ContentDetails } from './ContentDetails';
import { EventDetails } from './EventDetails';
import { FallbackDetails } from './FallbackDetails';
import { FileDetails } from './FileDetails';
import { GenericDetails } from './GenericDetails';
import { ItemDetails } from './ItemDetails';
import { NoteDetails } from './NoteDetails';
import { PersonDetails } from './PersonDetails';
import { PlaceDetails } from './PlaceDetails';
import { ReadOnlyProvider } from './readOnly';

export interface Props {
  entity: MemoryEntity;
  /** Suppress edit/tag/open-full-page affordances (shared-search viewer). */
  readOnly?: boolean;
}

function getCategoryComponent({ entity }: Props) {
  switch (entity.__typename) {
    case 'BrowserActivityType':
      return <BrowserActivityDetails entity={entity} />;
    case 'CommunicationType':
      return <CommunicationDetails entity={entity} />;
    case 'ConceptType':
      return <ConceptDetails entity={entity} />;
    case 'ContentType':
      return <ContentDetails entity={entity} />;
    case 'EventType':
      return <EventDetails entity={entity} />;
    case 'FileType':
      return <FileDetails entity={entity} />;
    case 'ItemType':
      return <ItemDetails entity={entity} />;
    case 'NoteType':
      return <NoteDetails entity={entity} />;
    case 'PersonType':
      return <PersonDetails entity={entity} />;
    case 'PlaceType':
      return <PlaceDetails entity={entity} />;
    // Graph nodes (REST) arrive as a synthetic GenericEntity.
    case 'GenericEntity':
      return <GenericDetails entity={entity} />;
    // Remaining explorer union members (Answer, Thread, …).
    default:
      return <FallbackDetails entity={entity} />;
  }
}

export function EntityDetails({ entity, readOnly = false }: Props) {
  return <ReadOnlyProvider value={readOnly}>{getCategoryComponent({ entity })}</ReadOnlyProvider>;
}
