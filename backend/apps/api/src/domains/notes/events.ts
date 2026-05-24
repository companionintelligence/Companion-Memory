import { defineEvent } from '@ci/domains/events';

export const NoteCreatedEvent = 'note.created';
export const NoteUpdatedEvent = 'note.updated';
export const NoteRemovedEvent = 'note.deleted';

export type NoteCreatedPayload = {
  noteId: string;
};

export type NoteUpdatedPayload = {
  noteId: string;
};

export type NoteRemovedPayload = {
  noteId: string;
};

defineEvent<NoteCreatedPayload>(NoteCreatedEvent);
defineEvent<NoteUpdatedPayload>(NoteUpdatedEvent);
defineEvent<NoteRemovedPayload>(NoteRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [NoteCreatedEvent]: NoteCreatedPayload;
    [NoteUpdatedEvent]: NoteUpdatedPayload;
    [NoteRemovedEvent]: NoteRemovedPayload;
  }
}
