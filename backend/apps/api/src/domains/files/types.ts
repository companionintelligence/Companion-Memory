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

export interface CreateSavedSearchDto {
  id?: string;
  name?: string;
  description?: string;
  query?: string;
  entityTypes?: IndexableEntity[];
  tags?: string[];
}

export interface UpdateSavedSearchDto {
  name?: string;
  description?: string;
  query?: string;
  entityTypes?: IndexableEntity[];
  tags?: string[];
}
