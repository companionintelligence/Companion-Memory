import type { EntityItem } from '../../useEntityService';

import { EntityDetailScaffold, type MetaItem } from './EntityDetailScaffold';

interface Props {
  entity: EntityItem;
}

// Turn a GraphQL __typename (e.g. "ThreadType") into a human label ("Thread").
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
 * Read-only fallback for explorer entity kinds without a bespoke component
 * (Answer, Thread, …). Reads display fields defensively off the result object so
 * clicking any row/tile/marker always opens a populated drawer.
 */
export function FallbackDetails({ entity }: Props) {
  // The fields exist on the result object at runtime (the grid fragments select
  // them); the union type just masks them, so read them off a record view.
  const record = entity as unknown as Record<string, unknown>;
  const kind = prettyKind(entity.__typename);

  const question =
    record.question && typeof record.question === 'object'
      ? firstString(record.question as Record<string, unknown>, ['text', 'question'])
      : null;
  const title =
    question ?? firstString(record, ['title', 'name', 'filename', 'label', 'subject', 'answer']) ?? kind;
  const body = firstString(record, [
    'answer',
    'description',
    'text',
    'content',
    'summary',
    'snippet',
    'preview',
  ]);
  const url = firstString(record, ['url', 'sourceUrl', 'previewUrl']);
  const when = firstDate(record, ['time', 'startTime', 'createdAt', 'updatedAt']);

  const metaItems: MetaItem[] = [
    { label: 'Type', value: kind },
    { label: 'When', value: when },
    {
      label: 'Link',
      value: url ? (
        <a href={url} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">
          {url}
        </a>
      ) : null,
    },
  ];

  return (
    <EntityDetailScaffold entity={entity} title={title} subtitle={kind} taggable metaItems={metaItems}>
      {body && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{body}</p>}
    </EntityDetailScaffold>
  );
}
