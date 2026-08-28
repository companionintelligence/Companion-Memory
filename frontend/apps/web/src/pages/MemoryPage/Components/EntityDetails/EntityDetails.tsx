import '../styles.css';

import { Sheet } from '@ci/shadcn';

import type { MemoryEntity } from '../../useEntityService';
import { ErrorState } from '../ErrorState';
import { ViewCrashBoundary } from '../ViewCrashBoundary';

import { AnswerDetails } from './AnswerDetails';
import { BrowserActivityDetails } from './BrowserActivityDetails';
import { CommunicationDetails } from './CommunicationDetails';
import { ConceptDetails } from './ConceptDetails';
import { ContentDetails } from './ContentDetails';
import { EventDetails } from './EventDetails';
import { FallbackDetails } from './FallbackDetails';
import { FileDetails } from './FileDetails';
import { ItemDetails } from './ItemDetails';
import { NoteDetails } from './NoteDetails';
import { PersonDetails } from './PersonDetails';
import { PlaceDetails } from './PlaceDetails';
import { ProductDetails } from './ProductDetails';
import { ReadOnlyProvider } from './readOnly';
import { ReceiptDetails } from './ReceiptDetails';
import { ResolvedGenericDetails } from './ResolvedGenericDetails';

export interface Props {
  entity: MemoryEntity;
  /** Suppress edit/tag/open-full-page affordances (shared-search viewer). */
  readOnly?: boolean;
}

function getCategoryComponent({ entity }: Props) {
  switch (entity.__typename) {
    case 'AnswerType':
      return <AnswerDetails entity={entity} />;
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
    case 'ProductModelType':
      return <ProductDetails entity={entity} />;
    case 'ReceiptType':
      return <ReceiptDetails entity={entity} />;
    // Graph nodes / relationship cards (REST) arrive as a synthetic GenericEntity
    // stub; resolve it to the real node so the drawer shows full details.
    case 'GenericEntity':
      return <ResolvedGenericDetails entity={entity} />;
    // Remaining explorer union members (Answer, Thread, …).
    default:
      return <FallbackDetails entity={entity} />;
  }
}

export function EntityDetails({ entity, readOnly = false }: Props) {
  return (
    <ReadOnlyProvider value={readOnly}>
      <ViewCrashBoundary
        resetKey={entity.id}
        fallback={(retry) => (
          <Sheet.Content
            data-testid="entity-detail-sheet"
            className="z-[1000] w-full sm:max-w-xl pt-[var(--safe-area-top)] pb-[var(--safe-area-bottom)]"
          >
            <ErrorState
              description="This memory's details could not be shown. Close the drawer or try again."
              onRetry={retry}
            />
          </Sheet.Content>
        )}
      >
        {getCategoryComponent({ entity })}
      </ViewCrashBoundary>
    </ReadOnlyProvider>
  );
}
