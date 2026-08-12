import type { ComponentType } from 'react';

import { Tag as TagIcon } from '@ci/shadcn/icons';

import {
  BrowserActivityIcon,
  CommunicationIcon,
  ContentIcon,
  EventIcon,
  FileIcon,
  ItemIcon,
  NoteIcon,
  PersonIcon,
  PlaceIcon,
} from '@/components/icons';

export type EntityTypeIcon = ComponentType<{ className?: string; colorized?: boolean }>;

export type WhatEntityTypeItem = {
  entityType: string;
  label: string;
  icon?: EntityTypeIcon;
};

export type WhatCategory =
  | {
      kind: 'standalone';
      id: string;
      label: string;
      entityType: string;
      icon: EntityTypeIcon;
    }
  | {
      kind: 'group';
      id: string;
      label: string;
      icon: EntityTypeIcon;
      items: WhatEntityTypeItem[];
    }
  | {
      /**
       * Events are one entity type with many KINDS (`event_type`: visited,
       * messaged, traveled, …), so their dropdown lists the account's distinct
       * event types (the How dimension) instead of a fixed entity-type list.
       */
      kind: 'events';
      id: 'events';
      label: 'Events';
      entityType: 'Event';
      icon: EntityTypeIcon;
    }
  | {
      kind: 'tag';
      id: 'tag';
      label: 'Tag';
      icon: typeof TagIcon;
    };

/** Grouped "What" categories for the Memory explorer nav. */
export const WHAT_CATEGORIES: WhatCategory[] = [
  {
    kind: 'standalone',
    id: 'people',
    label: 'People',
    entityType: 'Person',
    icon: PersonIcon,
  },
  {
    kind: 'standalone',
    id: 'places',
    label: 'Places',
    entityType: 'Place',
    icon: PlaceIcon,
  },
  {
    kind: 'standalone',
    id: 'messages',
    label: 'Messages',
    entityType: 'Communication',
    icon: CommunicationIcon,
  },
  {
    kind: 'events',
    id: 'events',
    label: 'Events',
    entityType: 'Event',
    icon: EventIcon,
  },
  {
    kind: 'group',
    id: 'content',
    label: 'Content',
    icon: ContentIcon,
    items: [
      { entityType: 'Browser', label: 'Browser', icon: BrowserActivityIcon },
      { entityType: 'Content', label: 'Content', icon: ContentIcon },
      { entityType: 'File', label: 'Files', icon: FileIcon },
      { entityType: 'Note', label: 'Notes', icon: NoteIcon },
    ],
  },
  {
    kind: 'standalone',
    id: 'thing',
    label: 'Thing',
    entityType: 'Thing',
    icon: ItemIcon,
  },
  {
    kind: 'tag',
    id: 'tag',
    label: 'Tag',
    icon: TagIcon,
  },
];

export function entityTypesForCategory(category: WhatCategory): string[] {
  if (category.kind === 'standalone' || category.kind === 'events') {
    return [category.entityType];
  }

  if (category.kind === 'group') {
    return category.items.map((item) => item.entityType);
  }

  return [];
}

/** Slightly darker in light mode, lighter in dark — tuned for the Memory What bar. */
export const WHAT_BAR_ICON_CLASS: Record<string, string> = {
  people: 'text-indigo-600 dark:text-indigo-400',
  places: 'text-red-600 dark:text-red-400',
  messages: 'text-green-600 dark:text-green-400',
  events: 'text-purple-600 dark:text-purple-400',
  content: 'text-pink-600 dark:text-pink-400',
  thing: 'text-yellow-600 dark:text-yellow-400',
  tag: 'text-orange-600 dark:text-orange-400',
};

export const WHAT_BAR_ITEM_ICON_CLASS: Record<string, string> = {
  Browser: 'text-emerald-600 dark:text-emerald-400',
  Content: 'text-pink-600 dark:text-pink-400',
  File: 'text-gray-600 dark:text-gray-400',
  Note: 'text-teal-700 dark:text-teal-400',
};
