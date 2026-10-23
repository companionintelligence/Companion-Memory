import type { ReactNode } from 'react';

import { FileText, ListTodo } from '@ci/shadcn/icons';

import type { LocalDocument } from '@/api/powersync/localSearch';
import {
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
  ProductIcon,
  ReceiptIcon,
  ThreadIcon,
} from '@/components/icons';

import { EntityRow } from '../ListView/rows/EntityRow';

/** The glyph each device-record type shows, matching the online rows'. */
export function localDocumentIcon(entityType: string): ReactNode {
  switch (entityType) {
    case 'browser-activity':
      return <BrowserActivityIcon />;

    case 'communication':
      return <CommunicationIcon />;

    case 'concept':
      return <ConceptIcon />;

    case 'content':
      return <ContentIcon />;

    case 'event':
      return <EventIcon />;

    case 'file':
      return <FileIcon />;

    // An excerpt of a parsed document: the online FileChunkRow's glyph.
    case 'file-chunk':
      return <FileText className="text-muted-foreground" size={24} strokeWidth={1.5} />;

    case 'item':
      return <ItemIcon />;

    case 'note':
      return <NoteIcon />;

    case 'person':
      return <PersonIcon />;

    case 'place':
      return <PlaceIcon />;

    case 'product':
      return <ProductIcon />;

    case 'receipt':
      return <ReceiptIcon />;

    case 'task':
      return <ListTodo className="text-muted-foreground" size={24} strokeWidth={1.5} />;

    case 'thread':
      return <ThreadIcon />;

    default:
      return null;
  }
}

const UNTITLED: Record<string, string> = {
  'browser-activity': 'Untitled page',
  communication: 'Message',
  concept: 'Untitled concept',
  content: 'Untitled content',
  event: 'Untitled event',
  file: 'Untitled file',
  'file-chunk': 'Document excerpt',
  item: 'Untitled thing',
  note: 'Untitled note',
  person: 'Unnamed person',
  place: 'Unnamed place',
  product: 'Untitled product',
  receipt: 'Receipt',
  task: 'Untitled task',
  thread: 'Untitled chat',
};

const SNIPPET_MAX_CHARS = 160;

/**
 * The row's two lines from a device record: the title, or the body where the
 * type has no title (a chat message's text is its body), with the body as the
 * snippet under a real title. Online rows read richer fields per type; the
 * record carries the one text the search index has, so every type shares
 * this one layout.
 */
export function localDocumentLines(document: LocalDocument): { title: string; subtitle: string | null } {
  const body = document.body?.replace(/\s+/g, ' ').trim() ?? '';
  const snippet = body.length > SNIPPET_MAX_CHARS ? `${body.slice(0, SNIPPET_MAX_CHARS - 1)}…` : body;

  if (document.title) {
    return { title: document.title, subtitle: snippet || null };
  }

  if (snippet) {
    return { title: snippet, subtitle: null };
  }

  return { title: UNTITLED[document.entityType] ?? 'Untitled', subtitle: null };
}

export function LocalDocumentRow({
  document,
  time,
  onClick,
  className,
}: {
  document: LocalDocument;
  time?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const { title, subtitle } = localDocumentLines(document);

  return (
    <EntityRow
      icon={localDocumentIcon(document.entityType)}
      title={title}
      subtitle={subtitle}
      time={time}
      onClick={onClick}
      className={className}
    />
  );
}
