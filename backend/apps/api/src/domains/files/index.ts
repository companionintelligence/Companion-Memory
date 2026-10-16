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
import { VideoPlaybackGenerationListener } from './listeners/VideoPlaybackGenerationListener';
import { FilePreviewService } from './services/FilePreviewService';
import { FileService } from './services/FileService';
import { MediaDimensionsService } from './services/MediaDimensionsService';
import { SavedSearchService } from './services/SavedSearchService';
import { VideoFrameSampleService } from './services/VideoFrameSampleService';
import { VideoPlaybackService } from './services/VideoPlaybackService';
import { VipsService } from './services/VipsService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([FileEntity, SavedSearchEntity]), EventsModule],
  providers: [
    FileService,
    SavedSearchService,
    MediaDimensionsService,
    VipsService,
    VideoFrameSampleService,
    FilePreviewService,
    VideoPlaybackService,
    FilePreviewGenerationListener,
    VideoPlaybackGenerationListener,
    MediaDimensionsBackfillListener,
    SeedDefaultSavedSearchesListener,
  ],
  controllers: [FilesController, BulkFilesController],
  exports: [
    FileService,
    SavedSearchService,
    MediaDimensionsService,
    VipsService,
    VideoFrameSampleService,
    FilePreviewService,
    VideoPlaybackService,
  ],
})
export class FilesModule {}

export { FileEntity, FileService, SavedSearchEntity, SavedSearchService };
export { FilePreviewService } from './services/FilePreviewService';
export type { PreviewOutcome, PreviewSkipReason } from './services/FilePreviewService';
export { FilePreviewSweepRequestEvent, FILE_PREVIEW_SWEEP_QUEUE } from './events';
export type { FilePreviewSweepRequestPayload } from './events';
export {
  VideoPlaybackRequestEvent,
  VIDEO_PLAYBACK_QUEUE,
  VideoPlaybackSweepRequestEvent,
  VIDEO_PLAYBACK_SWEEP_QUEUE,
} from './events';
export type { VideoPlaybackRequestPayload, VideoPlaybackSweepRequestPayload } from './events';
export {
  VideoPlaybackService,
  PlaybackEnvironmentError,
  BROWSER_SAFE_VIDEO_CODECS,
  PLAYBACK_MAX_EDGE,
  ORIGINAL_RESOLUTION,
  needsPlaybackRendition,
  playbackFilterChain,
} from './services/VideoPlaybackService';
export type { PlaybackOutcome, PlaybackSkipReason, VideoStreamProbe } from './services/VideoPlaybackService';
export { BulkFilesController, MAX_FILES_PER_BATCH } from './controllers/BulkFilesController';
export type { BulkFileUploadResult } from './controllers/BulkFilesController';
export { MediaDimensionsService } from './services/MediaDimensionsService';
export { VipsDecodeError, VipsService, VipsUnavailableError } from './services/VipsService';
export {
  VideoFrameSampleService,
  frameTimestamps,
  parseIso6709,
  parseRecordedAt,
  MIN_FRAME_SPACING_SECONDS,
} from './services/VideoFrameSampleService';
export type {
  SampleVideoOptions,
  SampleableFile,
  VideoCaptureMetadata,
  VideoFrame,
  VideoFrameSample,
} from './services/VideoFrameSampleService';
export type { ImageProbe, JpegRenderOptions, RenderedJpeg } from './services/VipsService';
export type { MediaDimensions } from './services/MediaDimensionsService';
export { MEDIA_DIMENSIONS_QUEUE } from './listeners/MediaDimensionsBackfillListener';
export type { File, SignedFile, SavedSearch };
export type { SavedSearchFilters } from './types';
export { isValidAreas, isValidBbox, savedSearchAreas } from './types';
export { resolveSavedSearchDateRange, isRollingDatePreset } from './seeds/resolveDatePreset';
export { DEFAULT_SAVED_SEARCHES } from './seeds/defaultSavedSearches';
export { FILE_KINDS, type FileKind, fileKindsPredicate, isFileKind, normalizeFileKinds } from './fileKinds';
export {
  FileCreatedEvent,
  FileUpdatedEvent,
  FileUploadedEvent,
  FileRemovedEvent,
  PreviewGeneratedEvent,
  MediaDimensionsBackfillRequestEvent,
  ImageDescriptionBackfillRequestEvent,
  SavedSearchCreatedEvent,
  SavedSearchUpdatedEvent,
  SavedSearchDeletedEvent,
  type FileCreatedPayload,
  type FileUpdatedPayload,
  type FileUploadedPayload,
  type FileDeletedPayload,
  type PreviewGeneratedPayload,
  type MediaDimensionsBackfillRequestPayload,
  type ImageDescriptionBackfillRequestPayload,
  type SavedSearchCreatedPayload,
  type SavedSearchUpdatedPayload,
  type SavedSearchDeletedPayload,
} from './events';
export { FileVariant } from './types';
