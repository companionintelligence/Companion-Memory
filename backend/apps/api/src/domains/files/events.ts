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
export const PreviewGeneratedEvent = 'preview.generated';

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
  /** The upload was a deliberate thing-capture shot; see ThingVisionListener. */
  thingCapture: boolean;
  skipDescription?: boolean;
  model?: string;
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

export type PreviewGeneratedPayload = {
  userId: string;
  previewId: string;
  model?: string;
  /**
   * When true, the capture source (e.g. Companion Capture with its own vision endpoint)
   * already produced a title/description — it writes them via PATCH /files/:id —
   * so {@link ImageDescriptionListener} skips its Ollama pass. Absent/false means
   * the server should generate the description as usual.
   */
  skipDescription?: boolean;
};

/**
 * Request to backfill `ci.files.width`/`height` for ORIGINAL image/video files
 * that lack them (dimensions weren't captured at ingest before the preview pass
 * recorded them). Consumed out-of-band by {@link MediaDimensionsBackfillListener}.
 */
export const MediaDimensionsBackfillRequestEvent = 'file.media-dimensions-backfill-request';

export type MediaDimensionsBackfillRequestPayload = {
  /** Owner whose files are probed. */
  userId: string;
  /** Max files to record dimensions for in this batch (default: listener's DEFAULT_LIMIT). */
  limit?: number;
};

/**
 * Requeue vision description for originals that still lack a description
 * (skipped while image description was off, or failed on a non-vision model).
 * Fired when the user turns image description back on in Settings.
 */
export const ImageDescriptionBackfillRequestEvent = 'file.image-description-backfill-request';

export type ImageDescriptionBackfillRequestPayload = {
  userId: string;
  /** Max originals to requeue in this batch (default: listener DEFAULT_LIMIT). */
  limit?: number;
};

/**
 * Ask for an `enrich.file_preview` sweep now, rather than at the stage's
 * scheduled cadence: generate the PREVIEW variant for every ORIGINAL image
 * or video of the user's that has none. Consumed by the pipeline domain's
 * `FilePreviewSweepRequestListener`, which starts the sweep — the same
 * handoff shape as `UnfurlSweepRequestEvent`.
 */
export const FilePreviewSweepRequestEvent = 'file.preview-sweep-request';

/** Dedicated queue for the request, so it is not queued behind preview generation itself. */
export const FILE_PREVIEW_SWEEP_QUEUE = 'file-preview-sweep';

export type FilePreviewSweepRequestPayload = {
  userId: string;
  /** Who asked — for the log line. */
  requestedBy: string;
};

defineEvent<FileCreatedPayload>(FileCreatedEvent);
defineEvent<FileUpdatedPayload>(FileUpdatedEvent);
defineEvent<FileUploadedPayload>(FileUploadedEvent);
defineEvent<FileDeletedPayload>(FileRemovedEvent);
defineEvent<PreviewGeneratedPayload>(PreviewGeneratedEvent);
defineEvent<MediaDimensionsBackfillRequestPayload>(MediaDimensionsBackfillRequestEvent);
defineEvent<ImageDescriptionBackfillRequestPayload>(ImageDescriptionBackfillRequestEvent);
defineEvent<FilePreviewSweepRequestPayload>(FilePreviewSweepRequestEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [FileCreatedEvent]: FileCreatedPayload;
    [FileUpdatedEvent]: FileUpdatedPayload;
    [FileUploadedEvent]: FileUploadedPayload;
    [FileRemovedEvent]: FileDeletedPayload;
    [PreviewGeneratedEvent]: PreviewGeneratedPayload;
    [MediaDimensionsBackfillRequestEvent]: MediaDimensionsBackfillRequestPayload;
    [ImageDescriptionBackfillRequestEvent]: ImageDescriptionBackfillRequestPayload;
    [FilePreviewSweepRequestEvent]: FilePreviewSweepRequestPayload;
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
