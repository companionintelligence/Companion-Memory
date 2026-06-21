import { type ComponentType } from 'react';

import { Squircle } from '@ci/shadcn/icons';

import {
  AnswerIcon,
  BrowserActivityIcon,
  CommunicationIcon,
  ConceptIcon,
  ContentIcon,
  EventIcon,
  FileIcon,
  ItemIcon,
  NoteIcon,
  PersonIcon,
  PlaceIcon,
  ThreadIcon,
} from '@/components/icons';

/**
 * Single source of truth for per-entity-type visuals (LifeScope-parity colour +
 * icon + label), shared by the map markers, list rows, gallery tiles and graph
 * nodes so a "place" looks the same everywhere.
 *
 * Colours are the authentic LifeScope theme palette
 *   $blue #2AC1DE  $orange #FF9933  $green #6CC644  $red #BD2C00  $purple #6E5494
 * extended with complementary hues for the kinds LifeScope didn't map.
 */
export type EntityKind =
  | 'place'
  | 'event'
  | 'person'
  | 'content'
  | 'file'
  | 'concept'
  | 'browser-activity'
  | 'item'
  | 'note'
  | 'communication'
  | 'answer'
  | 'thread'
  | 'action';

export interface EntityVisual {
  color: string;
  Icon: ComponentType<{ className?: string }>;
  label: string;
}

export const ENTITY_VISUALS: Record<EntityKind, EntityVisual> = {
  place: { color: '#6E5494', Icon: PlaceIcon, label: 'Place' },
  event: { color: '#BD2C00', Icon: EventIcon, label: 'Event' },
  person: { color: '#2AC1DE', Icon: PersonIcon, label: 'Person' },
  content: { color: '#6CC644', Icon: ContentIcon, label: 'Content' },
  file: { color: '#FF9933', Icon: FileIcon, label: 'File' },
  concept: { color: '#A232CB', Icon: ConceptIcon, label: 'Concept' },
  'browser-activity': { color: '#00C2E0', Icon: BrowserActivityIcon, label: 'Browser activity' },
  item: { color: '#618685', Icon: ItemIcon, label: 'Item' },
  note: { color: '#E6A817', Icon: NoteIcon, label: 'Note' },
  communication: { color: '#D64161', Icon: CommunicationIcon, label: 'Communication' },
  answer: { color: '#7A5C8E', Icon: AnswerIcon, label: 'Answer' },
  thread: { color: '#36486B', Icon: ThreadIcon, label: 'Thread' },
  action: { color: '#0EA5E9', Icon: AnswerIcon, label: 'Action' },
};

export const DEFAULT_ENTITY_VISUAL: EntityVisual = {
  color: '#64748B',
  Icon: Squircle,
  label: 'Item',
};

// GraphQL union member name -> kind, e.g. "PlaceType" -> "place".
const TYPENAME_TO_KIND: Record<string, EntityKind> = {
  PlaceType: 'place',
  EventType: 'event',
  PersonType: 'person',
  ContentType: 'content',
  FileType: 'file',
  ConceptType: 'concept',
  BrowserActivityType: 'browser-activity',
  ItemType: 'item',
  NoteType: 'note',
  CommunicationType: 'communication',
  AnswerType: 'answer',
  ThreadType: 'thread',
  ActionType: 'action',
};

// Raw/back-end type strings (graph REST uses capitalised/aliased values like
// "Person", "Location", "Object") -> kind.
const RAW_TYPE_ALIASES: Record<string, EntityKind> = {
  location: 'place',
  object: 'item',
  thing: 'item',
  contact: 'person',
  message: 'communication',
  communications: 'communication',
  'browser activity': 'browser-activity',
  browseractivity: 'browser-activity',
  webpage: 'browser-activity',
};

export function kindFromTypename(typename?: string | null): EntityKind | null {
  if (!typename) {
    return null;
  }

  return TYPENAME_TO_KIND[typename] ?? null;
}

export function kindFromRawType(raw?: string | null): EntityKind | null {
  if (!raw) {
    return null;
  }

  const normalized = raw.trim().toLowerCase();

  if (normalized in ENTITY_VISUALS) {
    return normalized as EntityKind;
  }

  if (normalized in RAW_TYPE_ALIASES) {
    return RAW_TYPE_ALIASES[normalized];
  }

  // Tolerate trailing "type" / plurals, e.g. "events" -> "event".
  const singular = normalized.replace(/s$/, '');

  if (singular in ENTITY_VISUALS) {
    return singular as EntityKind;
  }

  return null;
}

/** Visual for a GraphQL __typename (falls back to a neutral default). */
export function visualForTypename(typename?: string | null): EntityVisual {
  const kind = kindFromTypename(typename);

  return kind ? ENTITY_VISUALS[kind] : DEFAULT_ENTITY_VISUAL;
}

/** Visual for a raw/back-end type string (graph nodes). */
export function visualForRawType(raw?: string | null): EntityVisual {
  const kind = kindFromRawType(raw);

  return kind ? ENTITY_VISUALS[kind] : DEFAULT_ENTITY_VISUAL;
}

/** Colour for a raw/back-end type string; convenient for canvas/graph renderers. */
export function colorForRawType(raw?: string | null): string {
  return visualForRawType(raw).color;
}
