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
  ProductIcon,
  ReceiptIcon,
} from '@/components/icons';
import { EVENTS_EXPLORER_TYPES, isEventsExplorer } from '@/pages/MemoryPage/explorerRoute';


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
    // Browser activity is a happening — a visit at a moment — like a message
    // or an event, not a piece of content. It gets its own button beside them
    // on every page, in the order the events browse offers the three.
    kind: 'standalone',
    id: 'browser',
    label: 'Browser',
    entityType: 'Browser',
    icon: BrowserActivityIcon,
  },
  {
    kind: 'group',
    id: 'content',
    label: 'Content',
    icon: ContentIcon,
    items: [
      { entityType: 'Content', label: 'Content', icon: ContentIcon },
      { entityType: 'File', label: 'Files', icon: FileIcon },
      { entityType: 'Note', label: 'Notes', icon: NoteIcon },
    ],
  },
  {
    // Three types, one question: "what do I own, what model is it, and what did
    // it cost". Products and Receipts are search-union members server-side, so
    // leaving them out of the picker would have made them unreachable while
    // still leaking them into every narrowed browse (they ride the same
    // exclude-list as everything in AVAILABLE_ENTITY_TYPES).
    kind: 'group',
    id: 'thing',
    label: 'Things',
    icon: ItemIcon,
    items: [
      { entityType: 'Thing', label: 'Things', icon: ItemIcon },
      { entityType: 'Product', label: 'Products', icon: ProductIcon },
      { entityType: 'Receipt', label: 'Receipts', icon: ReceiptIcon },
    ],
  },
  {
    kind: 'tag',
    id: 'tag',
    label: 'Tag',
    icon: TagIcon,
  },
];

/**
 * The What bar for a page. `/memory/events` only browses the kinds with a
 * moment of their own (EVENTS_EXPLORER_TYPES), so it offers exactly those:
 * Messages, Events and Browser. Tags stay — they are not a kind. Everywhere
 * else the full list applies. (A group member in the allowed set would be
 * lifted out as a standalone button; today all three are standalone already.)
 */
export function whatCategoriesFor(pathname: string): WhatCategory[] {
  if (!isEventsExplorer(pathname)) {
    return WHAT_CATEGORIES;
  }

  const allowed = new Set(EVENTS_EXPLORER_TYPES);
  const categories: WhatCategory[] = [];

  for (const category of WHAT_CATEGORIES) {
    if (category.kind === 'tag') {
      categories.push(category);
    } else if (category.kind === 'group') {
      for (const item of category.items) {
        if (allowed.has(item.entityType)) {
          categories.push({
            kind: 'standalone',
            id: item.entityType.toLowerCase(),
            label: item.label,
            entityType: item.entityType,
            icon: item.icon ?? category.icon,
          });
        }
      }
    } else if (allowed.has(category.entityType)) {
      categories.push(category);
    }
  }

  return categories;
}

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
  Thing: 'text-yellow-600 dark:text-yellow-400',
  Product: 'text-amber-600 dark:text-amber-400',
  Receipt: 'text-lime-700 dark:text-lime-400',
  Content: 'text-pink-600 dark:text-pink-400',
  File: 'text-gray-600 dark:text-gray-400',
  Note: 'text-teal-700 dark:text-teal-400',
};
