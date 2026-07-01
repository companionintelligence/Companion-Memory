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
}

export type UploadFileDto = Omit<
  CreateFileDto,
  'variant' | 'title' | 'description' | 'externalId' | 'parentId' | 'externalCreatedAt' | 'externalUpdatedAt'
> & {
  inventoryCapture?: boolean;
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
