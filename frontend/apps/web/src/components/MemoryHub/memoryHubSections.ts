import type { ComponentType } from 'react';

import {
  ContentIcon,
  EventIcon,
  ItemIcon,
  NoteIcon,
  PersonIcon,
  PlaceIcon,
  ReceiptIcon,
  TagIcon,
  ThreadIcon,
} from '@/components/icons';
import { CHAT_BASE } from '@/pages/ChatPage/chatPaths';

export type MemoryHubIcon = ComponentType<{ className?: string; colorized?: boolean }>;

export type MemoryHubSection = {
  to: string;
  label: string;
  match: (path: string) => boolean;
  flag?: string;
  icon: MemoryHubIcon;
};

/**
 * Memory hub destinations — shared by the in-page hub tabs and the Power Rail
 * Memory submenu so labels, routes, matchers, and flags stay in lockstep.
 */
export const MEMORY_HUB_SECTIONS: MemoryHubSection[] = [
  {
    to: '/memory/events',
    label: 'Events',
    match: (p) => p === '/memory/events',
    icon: EventIcon,
  },
  {
    to: '/memory/people',
    label: 'People',
    match: (p) => p === '/memory/people' || p.startsWith('/people/'),
    icon: PersonIcon,
  },
  {
    to: '/memory/places',
    label: 'Places',
    match: (p) => p === '/memory/places' || p.startsWith('/places/'),
    icon: PlaceIcon,
  },
  {
    to: '/memory/things',
    label: 'Things',
    // `/items/:id` is the Thing detail page, so it has to keep this tab lit —
    // the old matcher only covered the retired `/inventory` alias.
    match: (p) => p === '/memory/things' || p.startsWith('/inventory') || p.startsWith('/items/'),
    icon: ItemIcon,
  },
  {
    to: '/memory/receipts',
    label: 'Receipts',
    match: (p) => p === '/memory/receipts' || p.startsWith('/receipts'),
    icon: ReceiptIcon,
  },
  {
    to: '/memory/content',
    label: 'Content',
    // `/memory/content/:fileId` opens a file viewer on this same page, so it
    // has to keep the Content tab lit rather than dropping the whole hub nav.
    match: (p) => p === '/memory/content' || p.startsWith('/memory/content/'),
    flag: 'files.page',
    icon: ContentIcon,
  },
  {
    to: '/memory/tags',
    label: 'Tags',
    match: (p) => p === '/memory/tags',
    flag: 'tags.page',
    icon: TagIcon,
  },
  {
    to: '/memory/notes',
    label: 'Notes',
    // /notes/:id? is the create/edit page and stays at its own top-level
    // path (same as /people/:id, /receipts/:id) — it still has to keep this
    // tab lit.
    match: (p) => p === '/memory/notes' || p.startsWith('/notes/'),
    icon: NoteIcon,
  },
  {
    to: CHAT_BASE,
    label: 'Chat',
    // A thread deep-link (`/memory/chat/:id`) has to keep this tab lit, same
    // as Content's `/memory/content/:fileId`.
    match: (p) => p === CHAT_BASE || p.startsWith(`${CHAT_BASE}/`),
    flag: 'chat.page',
    icon: ThreadIcon,
  },
];

export function isMemoryHubPath(pathname: string): boolean {
  if (pathname === '/memory' || pathname.startsWith('/memory/')) {
    return true;
  }

  // Legacy detail routes that still live outside /memory/*.
  return MEMORY_HUB_SECTIONS.some((section) => section.match(pathname));
}

export function isMemoryExplorerPath(pathname: string): boolean {
  return pathname === '/memory/events' || pathname === '/memory';
}

/**
 * Memory pages whose list reads its search text from `?search=`, so the
 * header search box writes the query into the page in place — filters and
 * sort untouched — instead of jumping to the explorer. The explorer itself,
 * plus every hub list that used to carry its own search input (people,
 * places, things, tags) and the content library. A detail route nested under
 * one of them (`/memory/places/42`, `/memory/content/42`) still renders that
 * list, so it counts too. A standalone detail page (`/people/42`,
 * `/places/42`, `/items/42`) does not: the section's tab stays lit there
 * (`MEMORY_HUB_SECTIONS.match`), but there is no list for `?search=` to
 * filter, so a query committed on one used to vanish into the URL. Those, like
 * notes and chat, keep the box as a launcher.
 */
const LIVE_SEARCH_SECTIONS = new Set([
  '/memory/people',
  '/memory/places',
  '/memory/things',
  '/memory/content',
  '/memory/tags',
]);

export function isLiveSearchPath(pathname: string): boolean {
  if (isMemoryExplorerPath(pathname)) {
    return true;
  }

  // The list route itself, or a route nested under it. Not the section's
  // `match`, which also lights the tab on standalone detail pages.
  for (const list of LIVE_SEARCH_SECTIONS) {
    if (pathname === list || pathname.startsWith(`${list}/`)) {
      return true;
    }
  }

  return false;
}
