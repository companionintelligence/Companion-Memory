import type { IndexableEntity } from '@ci/domains/search-next';

export enum FileVariant {
  ORIGINAL = 'ORIGINAL',
  PREVIEW = 'PREVIEW',
  THUMBNAIL = 'THUMBNAIL',
  /** Browser-playable H.264 rendition of a video ORIGINAL whose codec browsers cannot rely on (HEVC etc.). */
  PLAYBACK = 'PLAYBACK',
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
  /**
   * The connection whose sync wrote this row. Set only for POINTER rows (a
   * cloud-drive file recorded by link, no bytes here), so a disconnect can
   * delete what it created. See migration 20261005214652.
   */
  connectionId?: string | null;
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
   * The user saved this file to Memory on purpose — the phone's Capture
   * sheet, as opposed to a chat attachment or a CI-Capture screenshot. Rides
   * on FileUploadedEvent so the memory domain can catalogue it as content
   * (CaptureContentListener); nothing in the files domain reads it.
   */
  memoryCapture?: boolean;
  /**
   * When the device made this media, for a memory capture taken with the
   * phone's own camera or recorder (NOT a library pick, whose bytes may be
   * years old). The listener prefers the taken-at embedded in the bytes
   * (EXIF, container) and falls back to this; with neither, the capture is
   * content only and gets no timeline event. Validated by the controller.
   */
  capturedAt?: Date;
};

export type UpdateFileDto = Pick<CreateFileDto, 'title' | 'description' | 'externalUpdatedAt'>;

/**
 * Secondary explorer dimensions a saved search persists alongside the primary
 * query / entityTypes / tags, so it round-trips the full search the user built
 * (and a shared search runs with all of them). Mirrors the LifeScope-parity
 * SearchInput filter fields; pagination (first/after) is intentionally
 * excluded as transient. The map area (`bbox`) is NOT transient: a search
 * saved from the map keeps its rectangle, so "New Zealand Trip" is a place on
 * the globe rather than a name match.
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
  /** Narrow files to these kinds (`image`, `video`, `audio`, `document`); other types are untouched. */
  fileKinds?: string[];
  /** The explorer view to open in (`list`, `gallery`, `map`, `graph`, `timeline`). Presentation, not a predicate. */
  view?: string;
  /**
   * The map areas the search is confined to, each `[minLon, minLat, maxLon, maxLat]`
   * (WGS84), ORed: an event matches inside ANY of them. Geographic, unlike
   * `places`, which matches a location's name: an event at "Queenstown" is
   * inside New Zealand's rectangle but never matches the name "New Zealand".
   * Every entry is exactly four finite numbers.
   */
  areas?: number[][];
  /**
   * The single-rectangle form `areas` replaced. Still READ (as a one-entry
   * `areas`) so rows saved before the list existed keep working; nothing
   * writes it any more. See {@link savedSearchAreas}.
   */
  bbox?: number[];
}

/** Whether `bbox` is a usable map area: exactly four finite numbers. */
export function isValidBbox(bbox: unknown): bbox is [number, number, number, number] {
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every((value) => Number.isFinite(value));
}

/** Whether `areas` is a usable list of map areas: every entry a valid bbox. */
export function isValidAreas(areas: unknown): areas is [number, number, number, number][] {
  return Array.isArray(areas) && areas.every(isValidBbox);
}

/**
 * The map areas a saved filter set confines the search to, or undefined for
 * none. Prefers `areas`; falls back to the legacy single `bbox`.
 */
export function savedSearchAreas(
  filters: Pick<SavedSearchFilters, 'areas' | 'bbox'> | null | undefined,
): number[][] | undefined {
  if (filters == null) {
    return undefined;
  }

  if (isValidAreas(filters.areas) && filters.areas.length > 0) {
    return filters.areas;
  }

  return isValidBbox(filters.bbox) ? [filters.bbox] : undefined;
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
