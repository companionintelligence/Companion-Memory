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

import { FilesController } from './controllers/FilesController';
import { FileEntity, type File, type SignedFile } from './entities/FileEntity';
import { SavedSearchEntity, type SavedSearch } from './entities/SavedSearchEntity';
import { FilePreviewGenerationListener } from './listeners/FilePreviewGenerationListener';
import { FileService } from './services/FileService';
import { SavedSearchService } from './services/SavedSearchService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([FileEntity, SavedSearchEntity]), EventsModule],
  providers: [FileService, SavedSearchService, FilePreviewGenerationListener],
  controllers: [FilesController],
  exports: [FileService, SavedSearchService],
})
export class FilesModule {}

export { FileEntity, FileService, SavedSearchEntity, SavedSearchService };
export type { File, SignedFile, SavedSearch };
export {
  FileCreatedEvent,
  FileUpdatedEvent,
  FileUploadedEvent,
  FileRemovedEvent,
  PreviewGeneratedEvent,
  SavedSearchCreatedEvent,
  SavedSearchUpdatedEvent,
  SavedSearchDeletedEvent,
  type FileCreatedPayload,
  type FileUpdatedPayload,
  type FileUploadedPayload,
  type FileDeletedPayload,
  type PreviewGeneratedPayload,
  type SavedSearchCreatedPayload,
  type SavedSearchUpdatedPayload,
  type SavedSearchDeletedPayload,
} from './events';
export { FileVariant } from './types';
