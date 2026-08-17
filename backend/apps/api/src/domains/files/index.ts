/**
 * Manages file uploads, storage, and retrieval. This module provides the necessary
 * services and controllers to handle file-related operations, persisting file
 * metadata in the database and storing the actual files in an object storage service.
 *
 * ### Key Components:
 * - **FileService**: Contains the core business logic for uploading, downloading,
 *   and managing file metadata.
 * - **FilesController**: Exposes REST API endpoints for client-side file interactions.
 * - **FileEntity**: The TypeORM entity representing file metadata stored in the database.
 * - **Event Integration**: Integrates with the `EventsModule` to publish or handle
 *   events related to file activities, such as post-upload processing.
 *
 * @module FilesModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { BulkFilesController } from './controllers/BulkFilesController';
import { FilesController } from './controllers/FilesController';
import { FileEntity, type File, type SignedFile } from './entities/FileEntity';
import { SavedSearchEntity, type SavedSearch } from './entities/SavedSearchEntity';
import { FilePreviewGenerationListener } from './listeners/FilePreviewGenerationListener';
import { MediaDimensionsBackfillListener } from './listeners/MediaDimensionsBackfillListener';
import { SeedDefaultSavedSearchesListener } from './listeners/SeedDefaultSavedSearchesListener';
import { FileService } from './services/FileService';
import { MediaDimensionsService } from './services/MediaDimensionsService';
import { SavedSearchService } from './services/SavedSearchService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([FileEntity, SavedSearchEntity]), EventsModule],
  providers: [
    FileService,
    SavedSearchService,
    MediaDimensionsService,
    FilePreviewGenerationListener,
    MediaDimensionsBackfillListener,
    SeedDefaultSavedSearchesListener,
  ],
  controllers: [FilesController, BulkFilesController],
  exports: [FileService, SavedSearchService, MediaDimensionsService],
})
export class FilesModule {}

export { FileEntity, FileService, SavedSearchEntity, SavedSearchService };
export { BulkFilesController, MAX_FILES_PER_BATCH } from './controllers/BulkFilesController';
export type { BulkFileUploadResult } from './controllers/BulkFilesController';
export { MediaDimensionsService } from './services/MediaDimensionsService';
export type { MediaDimensions } from './services/MediaDimensionsService';
export { MEDIA_DIMENSIONS_QUEUE } from './listeners/MediaDimensionsBackfillListener';
export type { File, SignedFile, SavedSearch };
export type { SavedSearchFilters } from './types';
export { resolveSavedSearchDateRange, isRollingDatePreset } from './seeds/resolveDatePreset';
export { DEFAULT_SAVED_SEARCHES } from './seeds/defaultSavedSearches';
export {
  FileCreatedEvent,
  FileUpdatedEvent,
  FileUploadedEvent,
  FileRemovedEvent,
  PreviewGeneratedEvent,
  MediaDimensionsBackfillRequestEvent,
  SavedSearchCreatedEvent,
  SavedSearchUpdatedEvent,
  SavedSearchDeletedEvent,
  type FileCreatedPayload,
  type FileUpdatedPayload,
  type FileUploadedPayload,
  type FileDeletedPayload,
  type PreviewGeneratedPayload,
  type MediaDimensionsBackfillRequestPayload,
  type SavedSearchCreatedPayload,
  type SavedSearchUpdatedPayload,
  type SavedSearchDeletedPayload,
} from './events';
export { FileVariant } from './types';
