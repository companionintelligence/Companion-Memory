/**
 * The archive importer, ported from CI-Import-Tools.
 *
 * Takes a bulk export a person downloaded from a service they use — Google
 * Takeout, a Twitter archive, an iCloud photo dump, a browser history database —
 * and turns it into ci.* records. This is the path for data nobody has a live
 * API for, which is most of a person's history.
 *
 * ### Shape
 *
 * Three phases, each a PGBoss job, each a row in `ci_import.import_stages`:
 *
 *   unpack → parse → push
 *
 * `unpack` explodes the uploaded archive; `parse` runs the datasource parsers
 * over it and writes `ci_import.staged_*`; `push` fans those staged rows out
 * into ci.* through the ingest services, in-process.
 *
 * Upstream, phase one wrote a local SQLite file and phase two shipped it to
 * CI-Server over HTTP — roughly 8.6k lines of split-retry, gzip and capability
 * probing that evaporates when both ends are the same process. The split itself
 * is worth keeping regardless: parsing a 40GB Takeout is slow and re-runnable,
 * pushing is transactional and resumable, and a run that dies between the two
 * resumes from staged rows instead of re-reading the archive.
 *
 * ### Staging is run-scoped
 *
 * Every `staged_*` row hangs off an `import_runs` row with `ON DELETE CASCADE`,
 * so deleting a run is the complete cleanup. These tables are a scratchpad, not
 * a second copy of the user's data: cross-run and cross-source deduplication
 * belongs to ci.* (content_sha256, identifier claims, entity resolution), and
 * re-implementing it here is how the two would drift apart. Within-run dedup IS
 * enforced, because it is a parser contract — a photo library replicates one
 * file into every album folder it belongs to, and those must collapse to a
 * single staged item.
 *
 * ### Not the operator console
 *
 * `ci_import.import_runs` / `import_stages` are the USER-facing progress
 * surface, in a stage vocabulary that means something to the person who uploaded
 * the file. pg-boss still holds the work and `/jobs` still renders pg-boss for
 * an operator. Different questions, different audiences — the two surfaces are
 * deliberately not merged.
 *
 * NOTE: `./datasources` is intentionally NOT re-exported here. Importing that
 * barrel registers all ~71 parsers as a side effect, which callers who only want
 * an entity type should not pay for.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
import { GraphModule } from '@ci/domains/graph';
import { MemoryModule } from '@ci/domains/memory';
import { PositionModule } from '@ci/domains/position';
import { UserModule } from '@ci/domains/user';

import { ImportDoctorController } from './controllers/ImportDoctorController';
import { ImportInboxController } from './controllers/ImportInboxController';
import { ImportRunsController } from './controllers/ImportRunsController';
import { ImportUploadsController } from './controllers/ImportUploadsController';
import { ImportDoctorService } from './doctor/ImportDoctorService';
import { EntityMappingEntity } from './entities/EntityMappingEntity';
import { ImportRunEntity } from './entities/ImportRunEntity';
import { ImportStageEntity } from './entities/ImportStageEntity';
import { StagedEntityEntity } from './entities/StagedEntityEntity';
import { StagedItemEntity } from './entities/StagedItemEntity';
import { StagedRelationshipEntity } from './entities/StagedRelationshipEntity';
import { StagedSourceEntity } from './entities/StagedSourceEntity';
import { ImportRetentionCron } from './listeners/ImportRetentionCron';
import { ImportStageListener } from './listeners/ImportStageListener';
import { InboxProvisionListener } from './listeners/InboxProvisionListener';
import { StagedUploadPurgeCron } from './listeners/StagedUploadPurgeCron';
import { DataSourceCatalogService } from './services/DataSourceCatalogService';
import { ImportInboxService } from './services/ImportInboxService';
import { ImportRetentionService } from './services/ImportRetentionService';
import { ImportRunService } from './services/ImportRunService';
import { ImportScratchService } from './services/ImportScratchService';
import { ObjectCountService } from './services/ObjectCountService';
import { StagedSourceService } from './services/StagedSourceService';
import { MediaStage } from './stages/MediaStage';
import { ParseStage } from './stages/ParseStage';
import { PushStage } from './stages/PushStage';
import { UnpackStage } from './stages/UnpackStage';

/**
 * @internal
 *
 * `EventsModule` is imported for the pg-boss queue behind
 * {@link ImportStageListener}: the queue is created, and its workers started,
 * from the `@OnEvent` decorator this module's registration makes visible.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EntityMappingEntity,
      ImportRunEntity,
      ImportStageEntity,
      StagedSourceEntity,
      StagedEntityEntity,
      StagedItemEntity,
      StagedRelationshipEntity,
    ]),
    EventsModule,
    BrowserActivityModule,
    FilesModule,
    GraphModule,
    MemoryModule,
    PositionModule,
    UserModule,
  ],
  providers: [
    DataSourceCatalogService,
    ImportDoctorService,
    ImportInboxService,
    ImportRetentionService,
    ImportRunService,
    ImportScratchService,
    ObjectCountService,
    StagedSourceService,
    UnpackStage,
    ParseStage,
    MediaStage,
    PushStage,
    ImportStageListener,
    InboxProvisionListener,
    StagedUploadPurgeCron,
    ImportRetentionCron,
  ],
  controllers: [ImportUploadsController, ImportRunsController, ImportInboxController, ImportDoctorController],
  exports: [
    DataSourceCatalogService,
    ImportDoctorService,
    ImportInboxService,
    ImportRetentionService,
    ImportRunService,
    ImportScratchService,
    StagedSourceService,
    // Exported so a small, non-archive API sync (BlueBubblesSyncService) can
    // drive the same stage machinery in-process, without the full pg-boss
    // claim/heartbeat stage graph archive imports use. See
    // domains/bluebubbles/services/BlueBubblesSyncService.ts. MediaStage comes
    // with it because a connector's attachments need storing exactly like an
    // archive's: it is the only writer of `AttachmentFileIds`, so a run without
    // it downloads every attachment and then catalogues none of them.
    MediaStage,
    PushStage,
  ],
})
export class ImportModule {}

export { StagedSourceService, UPLOAD_TTL_MS } from './services/StagedSourceService';
export { StagedUploadPurgeCron, STAGED_UPLOAD_PURGE_CRON } from './listeners/StagedUploadPurgeCron';
export { ImportRetentionCron, IMPORT_RETENTION_CRON } from './listeners/ImportRetentionCron';
export { ImportRetentionService } from './services/ImportRetentionService';
export type { DiscardedRun, RetentionSweepResult } from './services/ImportRetentionService';
export type { RegisterUploadInput } from './services/StagedSourceService';

export { ImportInboxService, MAX_INBOX_BATCH_UNITS } from './services/ImportInboxService';
export type {
  InboxBatchResult,
  InboxScan,
  InboxUnit,
  InboxUnitResult,
  StartInboxBatchInput,
} from './services/ImportInboxService';
export { ImportRunService } from './services/ImportRunService';
export type {
  StartPushInput,
  StartRunInput,
  StartRunLocalSource,
  StartRunResult,
  UnpushedRun,
} from './services/ImportRunService';
export { ImportScratchService } from './services/ImportScratchService';

export { IMPORT_QUEUE, IMPORT_STAGE_KINDS, IMPORT_STAGE_WEIGHTS } from './constants';
export type { ImportStageKindName } from './constants';
export { ImportStageEvent } from './events';
export { ImportStageListener } from './listeners/ImportStageListener';
export {
  configuredImportRoots,
  resolveWithinImportRoots,
  uploadsRoot,
  userInboxDisplayDir,
  PathOutsideImportRootsError,
} from './sources/importRoots';
// Re-exported for the import tools, which live in the tools domain (that is
// where the native provider is assembled) and must reach this domain through
// its barrel rather than into its internals.
export { dataSourcesRecognize } from './datasources/registry';
export type { DirEntry, DataSourceRecognition } from './datasources/registry';
export { recognizePathWithinRoots } from './datasources/recognizePath';
export { mimeForFile } from './datasources/timeline';
export type { PathRecognition, PathRecognitionMatch } from './datasources/recognizePath';
// Re-exported for the bluebubbles domain, whose DI-friendly sync service/webhook
// controller drive this framework-free importer's mapping logic and must reach it
// through this barrel rather than into its internals.
export {
  attachmentDestination,
  BlueBubblesAPIImporter,
  blueBubblesBodyText,
  downloadAttachments,
  mapBlueBubblesMessageToGraph,
} from './datasources/bluebubbles';
export type { BlueBubblesMapOptions } from './datasources/bluebubbles';
export { BlueBubblesApiClient, BLUEBUBBLES_PAGE_LIMIT, redactUrl } from './datasources/bluebubblesApiClient';
// Shared mail policy for live Gmail/Outlook ETL. Leaf files, not the
// datasources barrel — importing that barrel would register every parser.
export {
  headersFromGmailApi,
  headersFromOutlookMessage,
  isHumanCorrespondence,
  liveMailDropReason,
  mailIncludeBulkEnabled,
} from './datasources/human_correspondence';
export type { LiveMailDropSlug } from './datasources/human_correspondence';
// Same rule: leaf files. The live Gmail transform derives direction from a
// message's own headers with the SAME function the mbox/eml importers use, so
// an API sync and a Takeout import of one message agree, and flattens a
// text/html body with the SAME flattener email_mime.ts uses.
export { emailDirection } from './datasources/email_direction';
export { htmlToText } from './datasources/htmlToText';
export { emailThreadId } from './datasources/email_thread';
export type {
  BlueBubblesClientConfig,
  BlueBubblesHandle,
  BlueBubblesChat,
  BlueBubblesAttachment,
  BlueBubblesMessage,
} from './datasources/bluebubblesApiClient';

export { MediaStage } from './stages/MediaStage';
export { ParseStage } from './stages/ParseStage';
export { PushStage } from './stages/PushStage';
export { UnpackStage } from './stages/UnpackStage';
export { importStagePayloadSchema } from './types';
export type { ImportStagePayload, ImportStageRunner, StageOutcome, StageRunContext } from './types';

export { StagedWriter, DEFAULT_FLUSH_THRESHOLD } from './staging/StagedWriter';
export type { StagedCounts } from './staging/StagedWriter';
export {
  CONTACT_STAGED_TYPE,
  SHORT_CODE_STAGED_TYPE,
  entityIdentityKey,
  entityKey,
  hasContactIdentity,
  hashItem,
  isShortCode,
  mergeAccumulatedMetadata,
  normalizeHandle,
  resolveEntityType,
  stagedNaturalKey,
} from './staging/identity';
export { entityTypeFor, naturalKeyFor } from './push/entities';
export { firstRedditMediaLink, redditLinkMedia, redditMediaKind } from './push/redditMedia';
export type { RedditMediaKind, RedditMediaRef } from './push/redditMedia';

export { ImportDoctorController } from './controllers/ImportDoctorController';
export type { DoctorCheckSummary } from './controllers/ImportDoctorController';
export { ImportDoctorService, DEFAULT_STATEMENT_TIMEOUT_MS } from './doctor/ImportDoctorService';
export type { DoctorFinding, DoctorReport, DoctorStatus } from './doctor/ImportDoctorService';
export { DOCTOR_CHECKS, DOCTOR_CHECK_IDS, findCheck } from './doctor/checks';
export type { DoctorCheck, DoctorSeverity } from './doctor/checks';

export { ImportRunsController } from './controllers/ImportRunsController';
export type {
  RecognizeBody,
  RunDetail,
  RunSummary,
  StageSummary,
  StartPushBody,
  StartRunBody,
  UnpushedRunSummary,
} from './controllers/ImportRunsController';
export { DataSourceCatalogService } from './services/DataSourceCatalogService';
export type { DataSourceSummary, SourceCatalogEntry } from './services/DataSourceCatalogService';
export { ObjectCountService, assembleObjectCounts } from './services/ObjectCountService';
export type { ObjectCountEntry, RawObjectCountData } from './services/ObjectCountService';
export { ImportUploadsController } from './controllers/ImportUploadsController';
export type { DropSummary } from './controllers/ImportUploadsController';

export {
  CorruptArchiveError,
  InsufficientDiskError,
  REJECTED_DIR,
  diagnoseArchive,
  freeBytesAt,
  unpackArchives,
} from './archive/unpack';
export type { RejectedArchive, UnpackOptions, UnpackResult } from './archive/unpack';

export { extractUploadedArchive, isExtractableArchive } from './archive/extract';
export type { ExtractLimits, ExtractResult } from './archive/extract';

export { EntityMappingEntity } from './entities/EntityMappingEntity';
export type { EntityMapping } from './entities/EntityMappingEntity';

export { ImportRunEntity } from './entities/ImportRunEntity';
export type { ImportRun, ImportRunSource, ImportRunStatus } from './entities/ImportRunEntity';

export { ImportStageEntity } from './entities/ImportStageEntity';
export type { ImportStage, ImportStageKind, ImportStageStatus } from './entities/ImportStageEntity';

export { StagedSourceEntity } from './entities/StagedSourceEntity';
export type {
  StagedSource,
  StagedSourceKind,
  StagedSourceOrigin,
  StagedSourceStatus,
} from './entities/StagedSourceEntity';
export { sanitizeFilename } from './sources/sanitizeFilename';

export { StagedEntityEntity } from './entities/StagedEntityEntity';
export type { StagedEntity } from './entities/StagedEntityEntity';

export { StagedItemEntity } from './entities/StagedItemEntity';
export type { StagedItem, StagedItemPushRef } from './entities/StagedItemEntity';

export { StagedRelationshipEntity } from './entities/StagedRelationshipEntity';
export type { StagedRelationship } from './entities/StagedRelationshipEntity';

export type { StagedPushStatus } from './entities/pushState';

export {
  makeIsSelf,
  matchOwner,
  isExactOwnerIdentifier,
  shouldMapContactToSelf,
  decideSelfCollation,
  readSelfIdentity,
  NOBODY_IS_SELF,
  OWNER_MATCH_CONFIDENCE,
} from './push/self';
export type { IsSelf, OwnerMatch, OwnerMatchKind, SelfIdentity, SelfIdentityReader } from './push/self';
