import { Input, Label, Sheet } from '@ci/shadcn';

import type { EntityItem } from '../../../MemoryPage/useEntityService';

interface Props {
  entity: EntityItem;
}

// Turn a GraphQL __typename (e.g. "BrowserActivityType") into a human label
// ("Browser Activity").
function prettyKind(typename: string): string {
  return typename
    .replace(/Type$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function firstDate(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || value instanceof Date) {
      const date = new Date(value as string | number | Date);
      if (!isNaN(date.getTime())) {
        return date.toLocaleString();
      }
    }
  }

  return null;
}

/**
 * Fallback detail panel for explorer entity kinds that don't have a bespoke
 * component (Person, Content, Note, Concept, Item, …). Reads display fields
 * defensively off the result object so clicking any map marker / list row /
 * gallery tile always opens a populated sheet. (Graph nodes use GenericDetails.)
 */
export function FallbackDetails({ entity }: Props) {
  // The fields exist on the result object at runtime (the grid fragments select
  // them); the union type just masks them, so read them off a record view.
  const record = entity as unknown as Record<string, unknown>;
  const kind = prettyKind(entity.__typename);

  const title = firstString(record, ['title', 'name', 'filename', 'label', 'subject']) ?? kind;
  const body = firstString(record, ['description', 'text', 'content', 'summary', 'snippet']);
  const url = firstString(record, ['url', 'sourceUrl', 'previewUrl']);
  const when = firstDate(record, ['time', 'startTime', 'createdAt', 'updatedAt']);

  return (
    <Sheet.Content className="z-index-1000">
      <Sheet.Header>
        <Sheet.Title>{title}</Sheet.Title>
        <Sheet.Description>{kind}</Sheet.Description>
      </Sheet.Header>
      <div className="grid flex-1 auto-rows-min gap-6 px-4">
        {body && (
          <div className="grid gap-3">
            <Label>Details</Label>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-[12]">{body}</p>
          </div>
        )}
        {when && (
          <div className="grid gap-3">
            <Label htmlFor="when">When</Label>
            <Input id="when" disabled defaultValue={when} />
          </div>
        )}
        {url && (
          <div className="grid gap-3">
            <Label htmlFor="url">Link</Label>
            <a
              id="url"
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-blue-500 underline break-all"
            >
              {url}
            </a>
          </div>
        )}
      </div>
    </Sheet.Content>
  );
}
