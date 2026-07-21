import { defineEvent } from '@ci/domains/events';

export const DocumentParsedEvent = 'document.parsed';

export type DocumentParsedPayload = {
  fileId: string;
  userId: string;
  chunkIds: string[];
};

defineEvent<DocumentParsedPayload>(DocumentParsedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [DocumentParsedEvent]: DocumentParsedPayload;
  }
}
