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
  /** Direct link to the ci.events row this file was captured alongside. Wins over `captureTickId`. */
  eventId?: string | null;
  /**
   * Per-tick correlator (see EventEntity.captureTickId) used to resolve
   * `eventId` when the caller doesn't know it directly — CI-Capture's
   * screenshot upload sends this, not eventId, since the two capture paths
   * race independently and the applet never learns the server's event id.
   */
  captureTickId?: string | null;
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
  /** Message direction to keep (`inbound` received, `outbound` sent); pins the browse to communications. */
  direction?: string;
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
