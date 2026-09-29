/**
 * This module is responsible for managing the application's long-term, structured memory.
 * It functions as a knowledge graph, storing and organizing information about various
 * entities such as people, places, events, and content. This allows the AI to build a
 * persistent and interconnected understanding of the user's world.
 *
 * ### Key Components:
 * - **Entities**: A rich set of entities (`PersonEntity`, `EventEntity`, `ContentEntity`,
 *   `GraphNodeEntity`, `RelationshipEntity`, etc.) that define the structure of the
 *   knowledge graph.
 * - **Services**:
 *   - `GraphUtilityService`: Offers tools for traversing and manipulating the graph structure.
 * - **Controllers**: Expose REST API endpoints (`ContentController`, etc.)
 *   for creating, retrieving, and managing memory entities.
 * - **User Integration**: Connects with the `UserModule` to ensure all memory entities are
 *   scoped to the correct user.
 *
 * @module MemoryModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BrowserActivityModule, BrowserActivityEntity } from '@ci/domains/browser-activity';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';
// Deep file imports, NOT `@ci/domains/graph`. GraphModule already imports
// MemoryModule, so pulling the graph BARREL in here would close a CommonJS
// require cycle between the two index files — whichever loaded second would see
// `{}` for the other, and the class symbols in the @Module() arrays below would
// evaluate to undefined. The two files reached here import only entities and
// utils, so they close no cycle.
import { ObjectIdentifierEntity } from '@ci/domains/graph/entities/ObjectIdentifierEntity';
import { ObjectIdentifierService } from '@ci/domains/graph/services/ObjectIdentifierService';
import { SearchNextModule } from '@ci/domains/search-next';
import { UserModule, UserEntity } from '@ci/domains/user';

import { GraphController } from './controllers/GraphController';
import { DeterministicPersonMergeCron } from './cron/DeterministicPersonMergeCron';
import { BaseEntity } from './entities/BaseEntity';
import { CommunicationBaseEntity } from './entities/CommunicationBaseEntity';
import { type Communication, CommunicationEntity } from './entities/CommunicationEntity';
import { type Concept, ConceptEntity } from './entities/ConceptEntity';
import { ContentBaseEntity } from './entities/ContentBaseEntity';
import { ContentEntity } from './entities/ContentEntity';
import { EntityMergeBlockEntity } from './entities/EntityMergeBlockEntity';
import { EventBaseEntity } from './entities/EventBaseEntity';
import { type Event, EventEntity } from './entities/EventEntity';
import { FileEntity } from './entities/FileEntity';
import { GraphNodeEntity } from './entities/GraphNodeEntity';
import { ItemBaseEntity } from './entities/ItemBaseEntity';
import {
  type Item,
  type ObjectCondition,
  type ObjectIdentityMethod,
  type ObjectLifecycleState,
  ItemEntity,
} from './entities/ItemEntity';
import {
  type ObjectObservation,
  ObjectObservationEntity,
  type ObservationBoundingBox,
  type ObservationLabelSource,
  type ObservationResolutionMethod,
  type ObservationSourceKind,
} from './entities/ObjectObservationEntity';
import { type Person, PersonEntity } from './entities/PersonEntity';
import { type Place, PlaceEntity } from './entities/PlaceEntity';
import { type ProductModel, ProductModelEntity } from './entities/ProductModelEntity';
import {
  type Receipt,
  type ReceiptChannel,
  ReceiptEntity,
  type ReceiptExtractionState,
} from './entities/ReceiptEntity';
import { type ReceiptLineItem, ReceiptLineItemEntity } from './entities/ReceiptLineItemEntity';
import { RelationshipEntity } from './entities/RelationshipEntity';
import { GraphEventListener } from './listeners/GraphEventListener';
import { CalendarEventService } from './services/CalendarEventService';
import { CommunicationService } from './services/CommunicationService';
import { ConceptService } from './services/ConceptService';
import { ContentService } from './services/ContentService';
import { EntityMergeBlockService } from './services/EntityMergeBlockService';
import { FileService } from './services/FileService';
import { GraphDeltaWriter } from './services/GraphDeltaWriter';
import { GraphEventService } from './services/GraphEventService';
import { GraphQueryService } from './services/GraphQueryService';
import { GraphReadService } from './services/GraphReadService';
import { GraphUtilityService } from './services/GraphUtilityService';
import { ItemService } from './services/ItemService';
import { KnownPlacesService } from './services/KnownPlacesService';
import { LifeStatsService } from './services/LifeStatsService';
import { MergeCandidateService } from './services/MergeCandidateService';
import { ObjectDuplicateService } from './services/ObjectDuplicateService';
import { ObjectMergeService } from './services/ObjectMergeService';
import { ObjectMintService } from './services/ObjectMintService';
import { ObjectObservationService } from './services/ObjectObservationService';
import { ObjectResolutionService } from './services/ObjectResolutionService';
import { PersonActivityService } from './services/PersonActivityService';
import { PersonDuplicateService } from './services/PersonDuplicateService';
import { PersonMergeService } from './services/PersonMergeService';
import { PersonService } from './services/PersonService';
import { PlaceDuplicateService } from './services/PlaceDuplicateService';
import { PlaceMergeService } from './services/PlaceMergeService';
import { PlaceService } from './services/PlaceService';
import { ProductModelService } from './services/ProductModelService';
import { ReceiptService } from './services/ReceiptService';
import { SourceSystemService } from './services/SourceSystemService';
import { UserContextService } from './services/UserContextService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EntityMergeBlockEntity,
      CommunicationEntity,
      CommunicationBaseEntity,
      ContentEntity,
      ContentBaseEntity,
      EventEntity,
      EventBaseEntity,
      PersonEntity,
      ConceptEntity,
      PlaceEntity,
      GraphNodeEntity,
      ItemEntity,
      ItemBaseEntity,
      ProductModelEntity,
      ReceiptEntity,
      ReceiptLineItemEntity,
      ObjectObservationEntity,
      // Owned by the graph domain; registered here so MemoryModule can provide
      // its own ObjectIdentifierService instance (see the import note above).
      ObjectIdentifierEntity,
      RelationshipEntity,
      FileEntity,
      BrowserActivityEntity,
      UserEntity,
      RelationshipEntity,
    ]),
    UserModule,
    EventsModule,
    FilesModule,
    BrowserActivityModule,
    SearchNextModule,
  ],
  providers: [
    GraphDeltaWriter,
    CommunicationService,
    ContentService,
    CalendarEventService,
    SourceSystemService,
    GraphEventService,
    GraphUtilityService,
    GraphQueryService,
    GraphReadService,
    ItemService,
    UserContextService,
    GraphEventListener,
    PersonService,
    PersonActivityService,
    EntityMergeBlockService,
    PersonDuplicateService,
    MergeCandidateService,
    // Hourly, worker-role: drains the deterministic merge-candidate backlog
    // (email / E.164 phone / exact profile URL) with a live re-check per pair.
    DeterministicPersonMergeCron,
    PersonMergeService,
    PlaceMergeService,
    PlaceDuplicateService,
    ConceptService,
    FileService,
    PlaceService,
    KnownPlacesService,
    LifeStatsService,
    ObjectObservationService,
    // The graph's identifier service, provided locally rather than imported —
    // GraphModule imports MemoryModule, so the dependency can only go this way.
    // It is stateless (a repository and a logger), so the second instance is a
    // second pointer, not a second source of truth: `ci.object_identifiers` and
    // its first-writer-wins claim index remain the only arbiter.
    ObjectIdentifierService,
    ProductModelService,
    ObjectMintService,
    ReceiptService,
    ObjectResolutionService,
    ObjectMergeService,
    ObjectDuplicateService,
  ],
  controllers: [GraphController],
  exports: [
    CommunicationService,
    ContentService,
    GraphDeltaWriter,
    CalendarEventService,
    SourceSystemService,
    GraphEventService,
    ItemService,
    PersonService,
    PersonActivityService,
    EntityMergeBlockService,
    PersonDuplicateService,
    MergeCandidateService,
    PersonMergeService,
    PlaceMergeService,
    PlaceDuplicateService,
    ConceptService,
    UserContextService,
    GraphUtilityService,
    GraphQueryService,
    GraphReadService,
    FileService,
    PlaceService,
    KnownPlacesService,
    ObjectObservationService,
    // Exported, not just provided: the search-ingress listeners fold an item's
    // and a product's identifier values into their index text, and they reach
    // this domain (not GraphModule) because GraphModule already imports
    // MemoryModule — the dependency can only go this way.
    ObjectIdentifierService,
    ProductModelService,
    ObjectMintService,
    ReceiptService,
    ObjectResolutionService,
    ObjectMergeService,
    ObjectDuplicateService,
  ],
})
export class MemoryModule {}

// FileEntity is deliberately absent: the graph's file row is an internal
// concern maintained by the FileUploadedEvent listener, and re-exporting it
// under that name would collide with the files domain's FileEntity — the
// record it references — at every call site that imports both.
export {
  BaseEntity,
  CommunicationEntity,
  CommunicationBaseEntity,
  ContentEntity,
  ContentBaseEntity,
  EventEntity,
  EventBaseEntity,
  ItemEntity,
  ObjectObservationEntity,
  PersonEntity,
  ConceptEntity,
  PlaceEntity,
  ProductModelEntity,
  ReceiptEntity,
  ReceiptLineItemEntity,
  GraphNodeEntity,
  ItemBaseEntity,
  RelationshipEntity,
};

// Services
export {
  ContentService,
  GraphDeltaWriter,
  CalendarEventService,
  SourceSystemService,
  CommunicationService,
  GraphEventService,
  ItemService,
  PersonService,
  PersonActivityService,
  EntityMergeBlockService,
  PersonDuplicateService,
  MergeCandidateService,
  PersonMergeService,
  PlaceMergeService,
  PlaceDuplicateService,
  ConceptService,
  UserContextService,
  GraphUtilityService,
  GraphQueryService,
  GraphReadService,
  FileService,
  PlaceService,
  KnownPlacesService,
  ObjectObservationService,
  ProductModelService,
  ObjectMintService,
  ReceiptService,
  ObjectResolutionService,
  ObjectMergeService,
  ObjectDuplicateService,
};

export type { Content } from './entities/ContentEntity';
export type { MapPin } from './services/CalendarEventService';
export { DEAD_EVENT_STATUSES, LIVE_EVENT_SQL } from './services/CalendarEventService';
export { MAX_EXPANDED_OCCURRENCES, MAX_RECURRING_MASTERS } from './services/CalendarEventService';
// Read-time RRULE expansion. Exported so `peers` can expand the same series for
// free/busy without routing that read through findInRange, which would silently
// impose SCHEDULE_EVENT_TYPES and LIVE_EVENT_SQL on it.
export * from './recurrence';
export type { PlaceKind } from './entities/PlaceEntity';
export type { PlaceVisitStats } from './services/PlaceService';
export { EntityMergeBlockEntity, orderPair, pairKey } from './entities/EntityMergeBlockEntity';
export { previewFromContent } from './entities/CommunicationEntity';
export type { BlockReason } from './services/EntityMergeBlockService';
export type {
  PersonDuplicateGroup,
  PersonDuplicatePage,
  DuplicateReason,
} from './services/PersonDuplicateService';
export type {
  MergeCandidate,
  MergeCandidateEvidence,
  MergeCandidatePage,
  MergeCandidateStatus,
} from './services/MergeCandidateService';
export {
  DETERMINISTIC_MERGE_CRON,
  encodeMergeCandidateCursor,
  hasEmailEvidence,
  isMergeCandidateStatus,
  MERGE_CANDIDATE_STATUSES,
} from './services/MergeCandidateService';
export type { AutoMergeOptions, AutoMergeResult } from './services/MergeCandidateService';
export type { PersonInteractionStats } from './services/PersonActivityService';
export type { MergeCounts } from './services/PersonMergeService';
export type { PlaceMergeCounts } from './services/PlaceMergeService';
export type {
  PlaceDuplicateGroup,
  PlaceDuplicatePage,
  PlaceDuplicateReason,
} from './services/PlaceDuplicateService';
export type { CreateEventDto, UpdateEventDto, CreateContentDto, UpdateContentDto } from './types';
// Cross-pipeline identity: the ONLY constructors of source_system/source_id.
// Every domain that stamps a provenance pair imports the builders from here —
// see docs/design/cross-pipeline-identity.md.
export * from './identity';
// The `content.external_id_kind` vocabulary and the value-shaped test behind
// it. Exported because every domain that writes a content row (import, etl,
// ingest, graphql) has to agree on what the column means — a second
// implementation of the predicate is a second definition of "is this a file id".
export {
  classifyExternalId,
  EXTERNAL_ID_URI_SHAPE,
  EXTERNAL_ID_UUID_SHAPE,
  SOURCE_NATIVE_EXTERNAL_ID_KIND,
} from './externalIdKind';
export type { ExternalIdKind } from './externalIdKind';
// The remaining ingest DTOs, exported for the same reason as the ones above:
// they are the shapes other domains hand to this one's services, so they belong
// on the public surface rather than behind a reach into ./types.
export type {
  CreateItemDto,
  UpdateItemDto,
  PhysicalItemPropertiesDto,
  CreatePersonDto,
  UpdatePersonDto,
} from './types';
// The physical vocabulary of an item. Exported because the API layer needs the
// same enums the CHECK constraints hold, and importers/listeners need the same
// unit parsing the services use — a second implementation of either is a second
// definition of what a millimetre is.
export {
  ACQUISITION_METHODS,
  MAX_ARRAY_TERMS,
  MAX_DIMENSION_MM,
  MAX_MASS_G,
  MAX_VOLUME_ML,
  PhysicalPropertyError,
  UNIT_SYSTEMS,
  normalizeAcquisitionMethod,
  normalizeColorHex,
  normalizeColors,
  normalizeComposition,
  normalizeMaterials,
  normalizePhysicalProperties,
  normalizeUnitSystem,
  parseDimensions,
  parseLengthMm,
  parseMassG,
  parseVolumeMl,
} from './physicalProperties';
export type { AcquisitionMethod, NormalizedPhysicalProperties, UnitSystem } from './physicalProperties';
// Money conversion for the LEGACY decimal columns. Exported because the
// currency-exponent table must have exactly one definition — a second one is a
// second opinion about whether ¥1,200 is 1200 or 12.
export { minorUnitExponent, minorUnitsToDecimal, minorUnitsTransformer } from './entities/minorUnits';
// The observation ingest shapes. Both the CV listener (llm domain) and the
// `capture.scan` promoter (pipeline domain) hand these to
// ObjectObservationService, so they belong on the public surface for exactly
// the reason the item/person DTOs above do.
export type {
  CreateObjectObservationDto,
  FindObjectObservationsFilter,
  ObservationCoordinates,
  ResolveObjectObservationDto,
} from './types';
export type { ObjectObservationWriteResult } from './services/ObjectObservationService';
export { detectionKeyFor } from './services/ObjectObservationService';
export {
  MEDIA_HIT_TYPES,
  eventsForMatchingMedia,
  mergeIdentifiers,
  searchReachesEvents,
  type MediaEventSearchDeps,
} from './services/mediaEventSearch';
// The object-identity service surface. Exported for the same reason the
// observation DTOs above are: the API layer, the maintenance jobs and the
// import path all speak these shapes, and a second definition of any of them is
// a second definition of what a duplicate (or a mint, or a merge) is.
export type {
  CreateProductModelDto,
  UpdateProductModelDto,
  FindProductModelsFilter,
  CreateReceiptDto,
  UpdateReceiptDto,
  FindReceiptsFilter,
  ReceiptExtraction,
  ReceiptLineItemInput,
  FindItemsFilter,
  ItemKeyset,
  ItemPage,
} from './types';
export { FIND_OR_CREATE_IDENTITY_CONFIDENCE } from './services/ProductModelService';
export type { ReceiptExtractionResult, ReceiptPage, ReceiptWithLines } from './services/ReceiptService';
export { OCR_IDENTIFIER_CONFIDENCE, STRUCTURED_IDENTIFIER_CONFIDENCE } from './services/ReceiptService';
export type { MintLineInput, MintReceiptContext, MintResult } from './services/ObjectMintService';
export {
  MINT_ACQUISITION_METHOD,
  MINT_IDENTITY_CONFIDENCE,
  MINT_IDENTITY_METHOD,
  MINT_LIFECYCLE_STATE,
  MINT_SOURCE_TYPE,
} from './services/ObjectMintService';
export type {
  ObjectResolutionCandidate,
  ObjectResolutionOutcome,
  ResolveOptions,
} from './services/ObjectResolutionService';
export {
  AUTO_RESOLVE_CONFIDENCE_THRESHOLD,
  EMBEDDING_DISTANCE_FLOOR,
  IDENTIFIER_CONFIDENCE,
  LABEL_CONFIDENCE,
  PLACE_PRIOR_CONFIDENCE,
} from './services/ObjectResolutionService';
export type { ObjectMergeCounts, ProductMergeCounts } from './services/ObjectMergeService';
export type {
  ObjectDuplicateGroup,
  ObjectDuplicatePage,
  ObjectDuplicateReason,
} from './services/ObjectDuplicateService';
export type {
  KnownPlace,
  KnownPlaceKind,
  KnownPlaceSource,
  KnownPlaceCandidate,
  KnownPlaceSampleEvent,
} from './services/KnownPlacesService';
export type { Concept, Event, Item, ObjectCondition, Person, Communication, Place };
export type {
  ObjectIdentityMethod,
  ObjectLifecycleState,
  ObjectObservation,
  ObservationBoundingBox,
  ObservationLabelSource,
  ObservationResolutionMethod,
  ObservationSourceKind,
  ProductModel,
  Receipt,
  ReceiptChannel,
  ReceiptExtractionState,
  ReceiptLineItem,
};
export {
  CommunicationDirection,
  CommunicationType,
  CreateCommunicationDto,
  NORMALIZED_PERSON_FIELDS,
  UpdateCommunicationDto,
  ensureSinglePrimary,
  formatPersonAddress,
  isPersonAddressEmpty,
  readPersonAddresses,
  serializePersonAddress,
} from './types';
export type { PersonAddress } from './types';
export {
  type NameOverlap,
  type NameOverlapKind,
  type NameTokenRole,
  type PersonNameToken,
  type TokenizedPersonName,
  NAME_OVERLAP_SCORES,
  compareTokenizedNames,
  hasFamilyConflict,
  indexableTokens,
  isRelationalDescriptor,
  pickFullerName,
  tokenizePersonName,
} from './utils/personNameTokens';
// LinkedIn profile URLs as duplicate evidence. One adjudicator, read by the
// duplicate detector (pipeline domain) and the auto-merger here — a second
// copy of the rule would be a second definition of "the same person".
export {
  type EvidenceLike,
  type ProfileCheckReason,
  type ProfileCorroboration,
  type ProfileEvidenceItem,
  type ProfileFacts,
  type ProfileFactsCorpusRow,
  type ProfileVerdict,
  PROFILE_FACTS_CORPUS_SQL,
  PROFILE_FACT_PROPERTY_KEYS,
  PROFILE_URL_EVIDENCE,
  PROFILE_URL_MAX_HOLDERS,
  PROFILE_URL_PREFILTER_TOKEN,
  PROFILE_URL_SCORES,
  PROFILE_URL_SQL_PREFILTER,
  ProfileUrlHolders,
  adjudicateProfileUrls,
  applyProfileVerdict,
  canonicalConnectedOn,
  extractProfileFacts,
  isProfileUrlEvidenceKind,
  normalizeProfileUrl,
  profileEvidenceFor,
  profileFactsSqlObject,
  profileUrlSqlPrefilter,
} from './utils/profileUrls';
// Phone numbers as duplicate evidence. The same arrangement as profile URLs:
// one adjudicator, read by the duplicate detector and by the auto-merger's
// live re-check, and the only producer of a 0.95 phone item.
export {
  type GivenNameRelation,
  type NanpNumberClass,
  type ParsedPhone,
  type PhoneBasis,
  type PhoneCheckReason,
  type PhoneClaimE164Row,
  type PhoneEvidenceItem,
  type PhoneFacts,
  type PhoneFactsCorpusRow,
  type PhoneLine,
  type PhoneParseStatus,
  type PhonePlaceholder,
  type PhoneReading,
  type PhoneRegion,
  type PhoneUnusableReason,
  type PhoneVerdict,
  NANP_TIMEZONES,
  PHONE_CLAIM_E164_SQL,
  PHONE_EVIDENCE,
  PHONE_FACTS_CORPUS_SQL,
  PHONE_FACT_PROPERTY_KEYS,
  PHONE_IDENTITY_SCORES,
  PHONE_LINE_MAX_IDENTITIES,
  PHONE_MAX_HOLDERS,
  PHONE_REGION_CORROBORATION,
  PhoneHolders,
  applyPhoneVerdict,
  capUnadjudicatedPhones,
  classifyPhoneName,
  derivePhoneRegion,
  extractPhoneFacts,
  generationalSuffix,
  givenNameRelation,
  isNanpE164,
  isPhoneEvidenceKind,
  isPlaceholderPersonName,
  nanpNumberClass,
  parsePhone,
  phoneCorpusFacts,
  phoneEvidenceFor,
  phoneFactsSqlObject,
  sharedPhoneLines,
  statedPhoneNumbers,
} from './utils/phoneIdentity';
