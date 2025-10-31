import type { MemoryItem } from '../../types';

import { BrowserActivityCard } from './BrowserActivityCard';
import { CommunicationCard } from './CommunicationCard';
import { ConceptCard } from './ConceptCard';
import { ContactCard } from './ContactCard';
import { ContentCard } from './ContentCard';
import { EventCard } from './EventCard';
import { OtherCard } from './OtherCard';
import { PersonCard } from './PersonCard';
import { PlaceCard } from './PlaceCard';
import { ThingCard } from './ThingCard';

export interface Props {
  memory: MemoryItem;
}

export function MemoryCard({ memory }: Props) {
  switch (memory.type) {
    case 'browser':
      return <BrowserActivityCard memory={memory} />;
    case 'event':
      return <EventCard memory={memory} />;
    case 'communication':
      return <CommunicationCard memory={memory} />;
    case 'content':
      return <ContentCard memory={memory} />;
    case 'thing':
      return <ThingCard memory={memory} />;
    case 'person':
      return <PersonCard memory={memory} />;
    case 'contact':
      return <ContactCard memory={memory} />;
    case 'place':
      return <PlaceCard memory={memory} />;
    case 'concept':
      return <ConceptCard memory={memory} />;
    case 'other':
      return <OtherCard memory={memory} />;
    default:
      return null;
  }
}
