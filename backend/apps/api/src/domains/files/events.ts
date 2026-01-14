import { defineEvent } from '@ci/domains/events';

/**
 * Event emitted when creating a new user.
 *
 * @see {@link UserService.create} - The method that emits this event
 */
export const FileCreatedEvent = 'file.created';
export const FileUpdatedEvent = 'file.updated';
export const FileUploadedEvent = 'file.uploaded';
export const FileRemovedEvent = 'file.deleted';

/**
 * Event payload of the event {@link FileCreatedEvent}.
 *
 * @see {@link FileCreatedEvent} - The event this payload is associated with
 * @see {@link FileService.create} - The method that emits this event payload
 */
export type FileCreatedPayload = {
  /** The identifier of the newly created user */
  fileId: string;
};

export type FileUploadedPayload = {
  /** The identifier of the newly created user */
  fileId: string;
  userId: string;
};

/**
 * Event payload of the event {@link FileUpdatedEvent}.
 *
 * @see {@link FileUpdatedEvent} - The event this payload is associated with
 * @see {@link FileService.update} - The method that emits this event payload
 */
export type FileUpdatedPayload = {
  /** The identifier of the newly created user */
  fileId: string;
};

/**
 * Event payload of the event {@link FileRemovedEvent}.
 *
 * @see {@link FileRemovedEvent} - The event this payload is associated with
 * @see {@link FileService.remove} - The method that emits this event payload
 */
export type FileDeletedPayload = {
  /** The identifier of the newly created user */
  fileId: string;
};

defineEvent<FileCreatedPayload>(FileCreatedEvent);
defineEvent<FileUpdatedPayload>(FileUpdatedEvent);
defineEvent<FileUploadedPayload>(FileUploadedEvent);
defineEvent<FileDeletedPayload>(FileRemovedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [FileCreatedEvent]: FileCreatedPayload;
    [FileUpdatedEvent]: FileUpdatedPayload;
    [FileUploadedEvent]: FileUploadedPayload;
    [FileRemovedEvent]: FileDeletedPayload;
  }
}

/**
 * Event emitted when creating a new user.
 *
 * @see {@link UserService.create} - The method that emits this event
 */
export const SavedSearchCreatedEvent = 'savedSearch.created';
export const SavedSearchUpdatedEvent = 'savedSearch.updated';
export const SavedSearchUploadedEvent = 'savedSearch.uploaded';
export const SavedSearchDeletedEvent = 'savedSearch.deleted';

/**
 * Event payload of the event {@link SavedSearchCreatedEvent}.
 *
 * @see {@link SavedSearchCreatedEvent} - The event this payload is associated with
 * @see {@link SavedSearchService.create} - The method that emits this event payload
 */
export type SavedSearchCreatedPayload = {
  /** The identifier of the newly created user */
  savedSearchId: string;
};

/**
 * Event payload of the event {@link SavedSearchUpdatedEvent}.
 *
 * @see {@link SavedSearchUpdatedEvent} - The event this payload is associated with
 * @see {@link SavedSearchService.update} - The method that emits this event payload
 */
export type SavedSearchUpdatedPayload = {
  /** The identifier of the newly created user */
  savedSearchId: string;
};

/**
 * Event payload of the event {@link SavedSearchDeletedEvent}.
 *
 * @see {@link SavedSearchDeletedEvent} - The event this payload is associated with
 * @see {@link SavedSearchService.remove} - The method that emits this event payload
 */
export type SavedSearchDeletedPayload = {
  /** The identifier of the newly created user */
  savedSearchId: string;
};

defineEvent<SavedSearchCreatedPayload>(SavedSearchCreatedEvent);
defineEvent<SavedSearchUpdatedPayload>(SavedSearchUpdatedEvent);
defineEvent<SavedSearchDeletedPayload>(SavedSearchDeletedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [SavedSearchCreatedEvent]: SavedSearchCreatedPayload;
    [SavedSearchUpdatedEvent]: SavedSearchUpdatedPayload;
    [SavedSearchDeletedEvent]: SavedSearchDeletedPayload;
  }
}
