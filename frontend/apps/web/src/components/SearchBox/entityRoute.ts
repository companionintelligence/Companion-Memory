import { chatThreadPath } from '@/pages/ChatPage/chatPaths';

/**
 * The offline record page for an entity (`pages/LocalRecordPage`): what a
 * tap opens when the answer came from this phone, for every type alike —
 * the per-type pages below need the appliance. Raw id in the path, like
 * `/people/:id`.
 */
export function savedRecordRoute(type: string, id: string): string {
  return `/memory/saved/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

/**
 * Where a tap on an entity goes, by its lower-case type and raw id — the one
 * table the header box's suggestions and the offline Memory list share, so a
 * type that opens somewhere opens there from both.
 *
 * Files have no page of their own: they open in the explorer's details drawer
 * from a list or the gallery. Until the offline record page (plan U4) gives
 * them one, a file tap opens the gallery searched for its name — the file is
 * one tap away there instead of nowhere, which is what it was.
 *
 * `null` for a type with no destination yet (products, tasks); callers leave
 * the tap inert rather than guess a route.
 */
export function routeForEntity(
  type: string,
  id: string,
  options: { title?: string | null } = {},
): string | null {
  switch (type) {
    case 'communication':
      return `/communications/${id}`;

    case 'concept':
      return `/concepts/${id}`;

    case 'content':
      return `/content/${id}`;

    case 'event':
      return `/events/${id}`;

    case 'file': {
      const title = options.title?.trim();

      return title ? `/memory?view=gallery&search=${encodeURIComponent(title)}` : '/memory?view=gallery';
    }

    case 'item':
      return `/items/${id}`;

    case 'note':
      return `/notes/${id}`;

    case 'person':
      return `/people/${id}`;

    case 'place':
      return `/places/${id}`;

    case 'receipt':
      return `/receipts/${id}`;

    case 'thread':
      return chatThreadPath(id);

    default:
      return null;
  }
}
