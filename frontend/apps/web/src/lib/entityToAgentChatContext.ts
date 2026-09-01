import type { AgentChatContext } from '@/lib/agentChat';
import { formatMinor } from '@/lib/money';
import { eventDisplayTitle } from '@/pages/MemoryPage/Components/utils';
import { getFileChunkTitle } from '@/pages/MemoryPage/fileChunks';
import type { MemoryEntity } from '@/pages/MemoryPage/useEntityService';

function asRecord(entity: MemoryEntity): Record<string, unknown> {
  return entity as unknown as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function readNestedString(value: unknown, key: string): string | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }

  const nested = (value as Record<string, unknown>)[key];

  return typeof nested === 'string' && nested.trim().length > 0 ? nested.trim() : null;
}

function stripHtml(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackTitle(kind: string): string {
  return kind.replace(/Type$/, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'This memory';
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatWhen(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(String(value));

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function readTags(record: Record<string, unknown>): string | null {
  const tags = record.tags;

  if (!Array.isArray(tags) || tags.length === 0) {
    return null;
  }

  const labels = tags
    .map((tag) => {
      if (typeof tag === 'string') {
        return tag.trim();
      }

      if (tag != null && typeof tag === 'object' && 'label' in tag) {
        const label = (tag as { label?: unknown }).label;

        return typeof label === 'string' ? label.trim() : '';
      }

      return '';
    })
    .filter((label) => label.length > 0);

  return labels.length > 0 ? labels.join(', ') : null;
}

function readUrl(record: Record<string, unknown>): string | null {
  return (
    readString(record, 'url', 'galleryContentUrl', 'galleryContentSourceUrl') ??
    readNestedString(record.galleryUnfurl, 'canonicalUrl')
  );
}

function readWhen(record: Record<string, unknown>): string | null {
  const timeSource = readString(record, 'bucketTimeSource', 'timeSource');

  // Import wall-clock, not a real event time — skip so chat doesn't cite it.
  if (timeSource === 'ingest') {
    return null;
  }

  return formatWhen(
    record.startTime ?? record.bucketStartTime ?? record.time ?? record.bucketTime ?? record.bucketAppearedAt,
  );
}

const MAX_PROSE = 1200;

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max).trimEnd()}…`;
}

function joinBody(prose: string | null, facts: Array<[string, string | null | undefined]>): string | null {
  const lines = facts
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([label, value]) => `${label}: ${value.trim()}`);
  const clipped = prose && prose.trim().length > 0 ? clip(prose.trim(), MAX_PROSE) : null;

  if (lines.length === 0) {
    return clipped;
  }

  return clipped ? `${lines.join('\n')}\n\n${clipped}` : lines.join('\n');
}

/**
 * Turn a Memory explorer entity into chat-about context. Search results are
 * fragment-masked, so fields are read defensively off the runtime object.
 * List/gallery still expose unmasked aliases (galleryTitle, bucketStartTime,
 * tags, eventType, …) — those go into the draft so chat is specific even
 * when the spread fragment's `description` is hidden.
 */
export function entityToAgentChatContext(entity: MemoryEntity): AgentChatContext {
  const record = asRecord(entity);
  const sourceKind = entity.__typename;
  const sourceId = typeof entity.id === 'string' ? entity.id : undefined;

  let title: string | null = null;
  let prose: string | null = null;

  switch (entity.__typename) {
    case 'EventType':
      title = eventDisplayTitle({
        title: readString(record, 'title', 'galleryTitle'),
        startTime: (record.startTime ?? record.bucketStartTime) as string | Date | null,
        locationName: readString(record, 'locationName', 'galleryLocationName'),
        mediaContentType: readString(record, 'mediaContentType', 'galleryMediaContentType'),
      });
      prose = readString(record, 'description');
      break;

    case 'NoteType': {
      title = readString(record, 'title') ?? 'Untitled note';
      const content = readString(record, 'content');
      prose = content ? stripHtml(content) : null;
      break;
    }

    case 'CommunicationType':
      title = readString(record, 'subject', 'preview') ?? 'Untitled communication';
      prose = readString(record, 'preview');
      break;

    case 'ContentType':
      title =
        readString(record, 'title', 'galleryTitle') ??
        readNestedString(record.galleryUnfurl, 'title') ??
        'Untitled content';
      prose = readString(record, 'text', 'description');
      break;

    case 'PersonType':
    case 'PlaceType':
    case 'ConceptType':
    case 'ThreadType':
    case 'ItemType':
      title = readString(record, 'name') ?? fallbackTitle(entity.__typename);
      prose = readString(record, 'description');
      break;

    case 'FileType':
      title = readString(record, 'title', 'filename', 'galleryFilename') ?? 'Untitled file';
      prose = readString(record, 'description');
      break;

    case 'FileChunkType':
      title = getFileChunkTitle({
        sectionTitle: readString(record, 'sectionTitle'),
        chunkContent: readString(record, 'chunkContent', 'content') ?? undefined,
        sourceLocator: (record.sourceLocator as Record<string, unknown> | null) ?? null,
        file: {
          filename: readNestedString(record.file, 'filename'),
        },
      });
      prose = readString(record, 'chunkContent', 'content');
      break;

    case 'BrowserActivityType':
      title = readString(record, 'title') ?? 'Untitled page';
      // URL is a fact, not prose — list rows often only have title + url.
      prose = null;
      break;

    case 'AnswerType':
      title = readNestedString(record.question, 'text') ?? 'Answer';
      prose = readString(record, 'answer');
      break;

    case 'ReceiptType': {
      title = readString(record, 'merchantName') ?? 'Unknown merchant';
      const total = formatMinor(
        typeof record.totalMinor === 'number' ? record.totalMinor : null,
        readString(record, 'receiptCurrency', 'currency'),
      );
      const lines = Array.isArray(record.lineItems) ? record.lineItems.length : 0;
      prose = [total, lines > 0 ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : null]
        .filter(Boolean)
        .join(' · ');
      break;
    }

    case 'ProductModelType':
      title = readString(record, 'productTitle', 'title') ?? 'Untitled product';
      prose = [readString(record, 'brand'), readString(record, 'modelNumber', 'model')]
        .filter(Boolean)
        .join(' · ');
      break;

    case 'GenericEntity':
      title =
        readString(record, 'name') ??
        (typeof record.entityType === 'string' ? fallbackTitle(record.entityType) : null) ??
        'This memory';
      prose = readString(record, 'description');
      break;

    default:
      title =
        readString(record, 'title', 'name', 'productTitle', 'merchantName', 'filename') ??
        fallbackTitle(sourceKind);
      prose = readString(record, 'description', 'text', 'preview', 'content');
      break;
  }

  const resolvedTitle = title?.trim() || 'This memory';
  const eventKind = readString(record, 'eventType');
  const sourceSystem = readString(record, 'sourceSystem');
  const filename = readString(record, 'filename', 'galleryFilename');
  const uniqueProse = prose && prose.trim() !== resolvedTitle ? prose : null;

  const body = joinBody(uniqueProse, [
    ['When', readWhen(record)],
    ['Where', readString(record, 'locationName', 'galleryLocationName')],
    ['Kind', eventKind ? humanize(eventKind) : null],
    ['Source', sourceSystem ? humanize(sourceSystem) : null],
    ['Tags', readTags(record)],
    ['URL', readUrl(record)],
    ['File', filename && filename !== resolvedTitle ? filename : null],
  ]);

  return {
    title: resolvedTitle,
    body,
    sourceKind,
    sourceId,
  };
}
