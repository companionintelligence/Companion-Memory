import type { IndexableEntity } from '@ci/domains/search-next';

export enum FileVariant {
  ORIGINAL = 'ORIGINAL',
  PREVIEW = 'PREVIEW',
  THUMBNAIL = 'THUMBNAIL',
}

export interface CreateFileDto extends Partial<Pick<Express.Multer.File, 'path' | 'buffer'>> {
  filename?: string | null;
  contentType?: string | null;
  size?: number | null;
  height?: number | null;
  width?: number | null;
  variant?: FileVariant;
  title?: string | null;
  description?: string | null;
  externalId?: string | null;
  parentId?: string | null;
  externalCreatedAt?: Date | null;
  externalUpdatedAt?: Date | null;
  /**
   * The ci.events row this file was captured alongside, already resolved (by
   * an explicit id, or by triple — see {@link UploadFileDto}). Callers that
   * already know the event id (e.g. a resolved upload) pass it straight
   * through; {@link FileService.create} does no further resolution.
   */
  eventId?: string | null;
}

export type UploadFileDto = Omit<
  CreateFileDto,
  'variant' | 'title' | 'description' | 'externalId' | 'parentId' | 'externalCreatedAt' | 'externalUpdatedAt'
> & {
  /**
   * The user asserted, on THIS upload, that the photo is of their own
   * belongings — the camera's "thing" mode. Gates {@link ThingVisionListener}.
   */
  thingCapture?: boolean;
  /**
   * When true, the capture source produced its own title/description (and writes
   * them via PATCH /files/:id), so the server skips the Ollama description pass.
   */
  skipDescription?: boolean;
  model?: string;
  /**
   * Provenance for auto-linking this upload to the `ci.events` row it was
   * captured alongside (e.g. CI-Capture sends a screenshot and a
   * desktop-activity event from the same worker tick). An explicit `eventId`
   * wins; otherwise, when `sourceType` + `sourceId` are present,
   * {@link FileService.uploadWithDedupInfo} resolves them against `ci.events`
   * by the (source_type, source_system, source_id) triple — the same
   * resolution ContentService uses to auto-link `ci.content.event_id` (see
   * `@ci/common/persistence`'s `resolveEventIdsByTriple`). Absent/unmatched
   * triples simply leave `ci.files.event_id` null.
   */
  eventId?: string;
  sourceType?: string;
  sourceSystem?: string;
  sourceId?: string;
};

export type UpdateFileDto = Pick<CreateFileDto, 'title' | 'description' | 'externalUpdatedAt'>;

/**
 * Secondary explorer dimensions a saved search persists alongside the primary
 * query / entityTypes / tags, so it round-trips the full search the user built
 * (and a shared search runs with all of them). Mirrors the LifeScope-parity
 * SearchInput filter fields; pagination/viewport (first/after/bbox) are
 * intentionally excluded as transient.
 */
export interface SavedSearchFilters {
  eventTypes?: string[];
  /** Rolling When preset (`yesterday`, `last-week`, `last-month`); resolved at run time. */
  datePreset?: string;
  startTime?: string;
  endTime?: string;
  sortBy?: string;
  sortOrder?: string;
  connectors?: string[];
  people?: string[];
  places?: string[];
  hasLocation?: boolean;
  semantic?: boolean;
}

export interface CreateSavedSearchDto {
  id?: string;
  name?: string;
  description?: string;
  query?: string;
  entityTypes?: IndexableEntity[];
  tags?: string[];
  filters?: SavedSearchFilters | null;
}

export interface UpdateSavedSearchDto {
  name?: string;
  description?: string;
  query?: string;
  entityTypes?: IndexableEntity[];
  tags?: string[];
  filters?: SavedSearchFilters | null;
}
