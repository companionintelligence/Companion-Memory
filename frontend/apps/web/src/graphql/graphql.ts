/* ------------------------------------------------------- */
/*  THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)  */
/* ------------------------------------------------------- */

/* eslint-disable */
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
export type Maybe<T> = T | null;
export type InputMaybe<T> = T | null | undefined;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /** A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format. */
  DateTime: { input: any; output: any; }
  /** The `JSON` scalar type represents JSON values as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf). */
  JSON: { input: any; output: any; }
};

export type ActionConnection = Connection & {
  __typename?: 'ActionConnection';
  edges: Array<ActionEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ActionEdge = Edge & {
  __typename?: 'ActionEdge';
  cursor: Scalars['String']['output'];
  node: ActionType;
};

/** Metadata associated with an action */
export type ActionMetadataType = {
  __typename?: 'ActionMetadataType';
  /** Context explaining why this action is relevant */
  context?: Maybe<Scalars['String']['output']>;
  /** Name of related person if applicable */
  relatedPerson?: Maybe<Scalars['String']['output']>;
  /** Whether the user has seen/interacted with this action */
  seen: Scalars['Boolean']['output'];
  /** Type of action: conversation_starter or time_suggestion */
  type?: Maybe<Scalars['String']['output']>;
};

export type ActionType = Node & Taggable & {
  __typename?: 'ActionType';
  createdAt: Scalars['DateTime']['output'];
  dismissed: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  imageUrl?: Maybe<Scalars['String']['output']>;
  /** Action metadata including seen status */
  metadata: ActionMetadataType;
  /** Priority/relevance level 1-10 */
  priority?: Maybe<Scalars['Int']['output']>;
  seen: Scalars['Boolean']['output'];
  /** Provenance: legacy | correlation | anomaly | suggestion */
  source?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  text: Scalars['String']['output'];
  thread?: Maybe<ThreadType>;
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Activity count for one local calendar day, rolled up from hourly UTC buckets */
export type ActivityBucketType = {
  __typename?: 'ActivityBucketType';
  count: Scalars['Int']['output'];
  /** Local calendar day, yyyy-MM-dd, in the user profile timezone */
  date: Scalars['String']['output'];
};

export type ActivityCountsType = {
  __typename?: 'ActivityCountsType';
  /** @deprecated Retired summary source; only set on summaries written before it was dropped. */
  activities?: Maybe<Scalars['Int']['output']>;
  answers?: Maybe<Scalars['Int']['output']>;
  /** @deprecated Retired summary source; only set on summaries written before it was dropped. */
  apiLogs?: Maybe<Scalars['Int']['output']>;
  browserActivity?: Maybe<Scalars['Int']['output']>;
  communications?: Maybe<Scalars['Int']['output']>;
  content?: Maybe<Scalars['Int']['output']>;
  events?: Maybe<Scalars['Int']['output']>;
  fileChunks?: Maybe<Scalars['Int']['output']>;
  files?: Maybe<Scalars['Int']['output']>;
  /** @deprecated Retired summary source; only set on summaries written before it was dropped. */
  measurements?: Maybe<Scalars['Int']['output']>;
  messages?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['Int']['output']>;
  objectObservations?: Maybe<Scalars['Int']['output']>;
  objects?: Maybe<Scalars['Int']['output']>;
  position?: Maybe<Scalars['Int']['output']>;
  /** @deprecated Never populated — the source has always been named `position`. Use `position`. */
  positions?: Maybe<Scalars['Int']['output']>;
  receiptLineItems?: Maybe<Scalars['Int']['output']>;
  receipts?: Maybe<Scalars['Int']['output']>;
  /** @deprecated Retired summary source; only set on summaries written before it was dropped. */
  screenCaptures?: Maybe<Scalars['Int']['output']>;
  tasks?: Maybe<Scalars['Int']['output']>;
  toolInvocations?: Maybe<Scalars['Int']['output']>;
  total: Scalars['Int']['output'];
};

/** Optional filters applied to the activity heatmap — mirrors the Memory explorer search filters. */
export type ActivityTimelineFiltersInput = {
  /** Restrict to events from these connectors */
  connectors?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Restrict to these event types (How filter) */
  eventTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Exclude these indexable entity types */
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Include only these indexable entity types */
  includeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Restrict to events mentioning these people */
  people?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Restrict to events at these places */
  places?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Free-text search query */
  query?: InputMaybe<Scalars['String']['input']>;
  /** Restrict to entities carrying these tags */
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type AddItemIdentifierInput = {
  itemId: Scalars['ID']['input'];
  namespace: ObjectIdentifierNamespace;
  scope?: InputMaybe<ObjectIdentifierScopeInput>;
  value: Scalars['String']['input'];
};

export type AddPersonIdentifierInput = {
  kind: Scalars['String']['input'];
  label?: InputMaybe<Scalars['String']['input']>;
  personId: Scalars['ID']['input'];
  value: Scalars['String']['input'];
};

export type AnswerConnection = Connection & {
  __typename?: 'AnswerConnection';
  edges: Array<AnswerEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type AnswerEdge = Edge & {
  __typename?: 'AnswerEdge';
  cursor: Scalars['String']['output'];
  node: AnswerType;
};

export type AnswerForm =
  | 'attribute'
  | 'boolean'
  | 'existence'
  | 'identity'
  | 'retrieval';

export type AnswerProvenanceType = {
  __typename?: 'AnswerProvenanceType';
  coveragePct: Scalars['Int']['output'];
  daysWithData: Scalars['Int']['output'];
  metric: Scalars['String']['output'];
  sources: Array<Scalars['String']['output']>;
};

export type AnswerSource =
  | 'peer'
  | 'self';

export type AnswerType = Node & {
  __typename?: 'AnswerType';
  answer: Scalars['String']['output'];
  answerConfidence?: Maybe<Scalars['Float']['output']>;
  answerEvidence?: Maybe<Scalars['JSON']['output']>;
  answerMethod: Scalars['String']['output'];
  answerRationale?: Maybe<Scalars['String']['output']>;
  answerSource?: Maybe<Scalars['String']['output']>;
  answeredAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  question: QuestionType;
};

export type AskActorInput = {
  kind: Scalars['String']['input'];
  label?: InputMaybe<Scalars['String']['input']>;
};

export type AskActorType = {
  __typename?: 'AskActorType';
  kind: Scalars['String']['output'];
  label?: Maybe<Scalars['String']['output']>;
};

export type AskAnswerType = {
  __typename?: 'AskAnswerType';
  answerSource: AnswerSource;
  askId: Scalars['ID']['output'];
  consentBasis?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  disclosedCount: Scalars['Int']['output'];
  form: AnswerForm;
  id: Scalars['ID']['output'];
  items: Array<DisclosedItemType>;
  summary?: Maybe<Scalars['String']['output']>;
  withheldCount: Scalars['Int']['output'];
};

export type AskAuditOutcome =
  | 'answered'
  | 'auto_answered'
  | 'declined'
  | 'expired';

export type AskAuditType = {
  __typename?: 'AskAuditType';
  askId?: Maybe<Scalars['ID']['output']>;
  askerId?: Maybe<Scalars['ID']['output']>;
  consentBasis?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  disclosedCount: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  outcome: AskAuditOutcome;
  peerHandle?: Maybe<Scalars['String']['output']>;
  query: AskQueryType;
  responderId?: Maybe<Scalars['ID']['output']>;
};

export type AskBroadcastType = {
  __typename?: 'AskBroadcastType';
  answered: Scalars['Int']['output'];
  createdAt: Scalars['DateTime']['output'];
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  query: AskQueryType;
  recipients: Scalars['Int']['output'];
  waiting: Scalars['Int']['output'];
};

export type AskChannelType = {
  __typename?: 'AskChannelType';
  covered: Array<Scalars['String']['output']>;
  keyThumbprint: Scalars['String']['output'];
  verifiedAt: Scalars['DateTime']['output'];
};

export type AskDisclosureHistoryInput = {
  counterpartyKey?: InputMaybe<Scalars['String']['input']>;
  from?: InputMaybe<Scalars['DateTime']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  outcomes?: InputMaybe<Array<Scalars['String']['input']>>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
};

export type AskDisclosureHistoryPayload = {
  __typename?: 'AskDisclosureHistoryPayload';
  rows: Array<AskAuditType>;
  truncated: Scalars['Boolean']['output'];
};

export type AskDisclosureSummaryInput = {
  windowDays?: InputMaybe<Scalars['Int']['input']>;
};

export type AskDisclosureSummaryPayload = {
  __typename?: 'AskDisclosureSummaryPayload';
  summaries: Array<AskDisclosureSummaryType>;
  truncated: Scalars['Boolean']['output'];
};

export type AskDisclosureSummaryType = {
  __typename?: 'AskDisclosureSummaryType';
  askerId?: Maybe<Scalars['ID']['output']>;
  asksInWindow: Scalars['Int']['output'];
  autoAnswered: Scalars['Int']['output'];
  declined: Scalars['Int']['output'];
  expired: Scalars['Int']['output'];
  firstAt: Scalars['DateTime']['output'];
  itemsDisclosed: Scalars['Int']['output'];
  itemsInWindow: Scalars['Int']['output'];
  key: Scalars['String']['output'];
  lastAt: Scalars['DateTime']['output'];
  peerHandle?: Maybe<Scalars['String']['output']>;
  peerLinkId?: Maybe<Scalars['ID']['output']>;
  reviewed: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

export type AskGrantPayload = {
  __typename?: 'AskGrantPayload';
  grant?: Maybe<AskGrantType>;
  success: Scalars['Boolean']['output'];
};

export type AskGrantType = {
  __typename?: 'AskGrantType';
  active: Scalars['Boolean']['output'];
  createdAt: Scalars['DateTime']['output'];
  dataClass?: Maybe<Scalars['String']['output']>;
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  granteeId?: Maybe<Scalars['ID']['output']>;
  granteePeerLinkId?: Maybe<Scalars['ID']['output']>;
  id: Scalars['ID']['output'];
  lastUsedAt?: Maybe<Scalars['DateTime']['output']>;
  mode: GrantMode;
  purpose?: Maybe<Scalars['String']['output']>;
  queryType: Scalars['String']['output'];
  revocationReason?: Maybe<Scalars['String']['output']>;
  revokedAt?: Maybe<Scalars['DateTime']['output']>;
  supersedesGrantId?: Maybe<Scalars['ID']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  useCount: Scalars['Int']['output'];
  version: Scalars['Int']['output'];
};

export type AskPayload = {
  __typename?: 'AskPayload';
  ask?: Maybe<AskType>;
  success: Scalars['Boolean']['output'];
};

export type AskQueryInput = {
  actor?: InputMaybe<AskActorInput>;
  dataClass?: InputMaybe<Scalars['String']['input']>;
  prompt: Scalars['String']['input'];
  queryType: Scalars['String']['input'];
};

export type AskQueryType = {
  __typename?: 'AskQueryType';
  actor?: Maybe<AskActorType>;
  dataClass?: Maybe<Scalars['String']['output']>;
  prompt: Scalars['String']['output'];
  purpose?: Maybe<Scalars['String']['output']>;
  queryType: Scalars['String']['output'];
};

export type AskStatus =
  | 'answered'
  | 'answering'
  | 'declined'
  | 'delivered'
  | 'expired'
  | 'sent'
  | 'under_review';

export type AskType = {
  __typename?: 'AskType';
  askerId?: Maybe<Scalars['ID']['output']>;
  broadcastId?: Maybe<Scalars['ID']['output']>;
  channel?: Maybe<AskChannelType>;
  consentBasis?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  direction: Scalars['String']['output'];
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  peerHandle?: Maybe<Scalars['String']['output']>;
  query: AskQueryType;
  responderId?: Maybe<Scalars['ID']['output']>;
  status: AskStatus;
  updatedAt: Scalars['DateTime']['output'];
};

export type BoundingBoxType = {
  __typename?: 'BoundingBoxType';
  h: Scalars['Float']['output'];
  w: Scalars['Float']['output'];
  x: Scalars['Float']['output'];
  y: Scalars['Float']['output'];
};

/** One competing future at a clock step */
export type BranchialBranchType = {
  __typename?: 'BranchialBranchType';
  id: Scalars['String']['output'];
  /** Parent L0 class (WORK, LEISURE, ...) */
  l0: Scalars['String']['output'];
  mass: Scalars['Float']['output'];
  permutations: Array<BranchialPermutationType>;
  title: Scalars['String']['output'];
  why: Scalars['String']['output'];
};

/** Who or what under a named future (slider 2, laid out in time) */
export type BranchialPermutationType = {
  __typename?: 'BranchialPermutationType';
  id: Scalars['String']['output'];
  mass: Scalars['Float']['output'];
  title: Scalars['String']['output'];
};

/** A remaining daypart or week-ahead day */
export type BranchialStepType = {
  __typename?: 'BranchialStepType';
  branches: Array<BranchialBranchType>;
  id: Scalars['String']['output'];
  label: Scalars['String']['output'];
  startTime: Scalars['String']['output'];
};

/** Branchial-time tree: occupancy spine from the histogram/week forecast, optionally named by an LLM guess from memory */
export type BranchialTreeType = {
  __typename?: 'BranchialTreeType';
  /** True when branch titles came from the memory guess, not raw L0 labels */
  guessed: Scalars['Boolean']['output'];
  question: Scalars['String']['output'];
  steps: Array<BranchialStepType>;
};

export type BrowserActivityConnection = Connection & {
  __typename?: 'BrowserActivityConnection';
  edges: Array<BrowserActivityEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type BrowserActivityEdge = Edge & {
  __typename?: 'BrowserActivityEdge';
  cursor: Scalars['String']['output'];
  node: BrowserActivityType;
};

export type BrowserActivityType = Node & Taggable & {
  __typename?: 'BrowserActivityType';
  actionType?: Maybe<Scalars['String']['output']>;
  duration?: Maybe<Scalars['Float']['output']>;
  id: Scalars['ID']['output'];
  scrollDepth?: Maybe<Scalars['Float']['output']>;
  tags: Array<EntityTagType>;
  time: Scalars['DateTime']['output'];
  title?: Maybe<Scalars['String']['output']>;
  url: Scalars['String']['output'];
};

export type BulkGraphEntityMapping = {
  __typename?: 'BulkGraphEntityMapping';
  entityId: Scalars['ID']['output'];
  key: Scalars['String']['output'];
};

export type BulkGraphInput = {
  entities: Array<GraphEntityInput>;
  relationships?: InputMaybe<Array<GraphRelationshipInput>>;
};

export type BulkGraphPayload = {
  __typename?: 'BulkGraphPayload';
  entities: Array<BulkGraphEntityMapping>;
  entitiesProcessed: Scalars['Int']['output'];
  errors: Array<Scalars['String']['output']>;
  relationshipsProcessed: Scalars['Int']['output'];
  success: Scalars['Boolean']['output'];
};

export type BulkItemRelationshipResult = {
  __typename?: 'BulkItemRelationshipResult';
  inserted: Scalars['Int']['output'];
  skipped: Scalars['Int']['output'];
};

export type CalibrationScoreType = {
  __typename?: 'CalibrationScoreType';
  brier?: Maybe<Scalars['Float']['output']>;
  coverage?: Maybe<Scalars['Float']['output']>;
  driftFlag: Scalars['Boolean']['output'];
  ece?: Maybe<Scalars['Float']['output']>;
  l0Top1Acc?: Maybe<Scalars['Float']['output']>;
  l1Top3Acc?: Maybe<Scalars['Float']['output']>;
  /** hmt / b0 / b1 / b2 */
  modelVersion?: Maybe<Scalars['String']['output']>;
  nBuckets?: Maybe<Scalars['Int']['output']>;
  scoredAt: Scalars['String']['output'];
};

export type CommunicationAttachmentType = {
  __typename?: 'CommunicationAttachmentType';
  contentId?: Maybe<Scalars['ID']['output']>;
  contentType?: Maybe<Scalars['String']['output']>;
  fileId?: Maybe<Scalars['ID']['output']>;
  filename?: Maybe<Scalars['String']['output']>;
  height?: Maybe<Scalars['Int']['output']>;
  previewUrl?: Maybe<Scalars['String']['output']>;
  size?: Maybe<Scalars['Float']['output']>;
  url?: Maybe<Scalars['String']['output']>;
  width?: Maybe<Scalars['Int']['output']>;
};

export type CommunicationConnection = Connection & {
  __typename?: 'CommunicationConnection';
  edges: Array<CommunicationEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type CommunicationEdge = Edge & {
  __typename?: 'CommunicationEdge';
  cursor: Scalars['String']['output'];
  node: CommunicationType;
};

export type CommunicationType = Node & Taggable & {
  __typename?: 'CommunicationType';
  attachments: Array<CommunicationAttachmentType>;
  content: Scalars['String']['output'];
  direction: Scalars['String']['output'];
  from?: Maybe<PersonType>;
  id: Scalars['ID']['output'];
  metadata: Scalars['JSON']['output'];
  participantsMetadata: Scalars['JSON']['output'];
  preview?: Maybe<Scalars['String']['output']>;
  sourceId?: Maybe<Scalars['String']['output']>;
  sourceSystem?: Maybe<Scalars['String']['output']>;
  sourceType?: Maybe<Scalars['String']['output']>;
  subject?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  threadId?: Maybe<Scalars['String']['output']>;
  time: Scalars['DateTime']['output'];
  to: PersonConnection;
  type: Scalars['String']['output'];
};


export type CommunicationTypeToArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};

export type ConceptConnection = Connection & {
  __typename?: 'ConceptConnection';
  edges: Array<ConceptEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ConceptEdge = Edge & {
  __typename?: 'ConceptEdge';
  cursor: Scalars['String']['output'];
  node: ConceptType;
};

export type ConceptType = Node & Taggable & {
  __typename?: 'ConceptType';
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
};

export type Connection = {
  edges: Array<Edge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ConnectionConnection = Connection & {
  __typename?: 'ConnectionConnection';
  edges: Array<ConnectionEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ConnectionEdge = Edge & {
  __typename?: 'ConnectionEdge';
  cursor: Scalars['String']['output'];
  node: ConnectionType;
};

export type ConnectionSyncJobConnection = Connection & {
  __typename?: 'ConnectionSyncJobConnection';
  edges: Array<ConnectionSyncJobEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ConnectionSyncJobEdge = Edge & {
  __typename?: 'ConnectionSyncJobEdge';
  cursor: Scalars['String']['output'];
  node: ConnectionSyncJobType;
};

export type ConnectionSyncJobType = Node & {
  __typename?: 'ConnectionSyncJobType';
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  connection?: Maybe<ConnectionType>;
  connectionId: Scalars['ID']['output'];
  createdAt: Scalars['DateTime']['output'];
  cursor?: Maybe<Scalars['JSON']['output']>;
  data: Scalars['JSON']['output'];
  endpointName: Scalars['String']['output'];
  error?: Maybe<Scalars['JSON']['output']>;
  id: Scalars['ID']['output'];
  jobId?: Maybe<Scalars['ID']['output']>;
  nextCursor?: Maybe<Scalars['JSON']['output']>;
  properties?: Maybe<Scalars['JSON']['output']>;
  status: Scalars['String']['output'];
  type: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  userId: Scalars['ID']['output'];
};

export type ConnectionType = Node & {
  __typename?: 'ConnectionType';
  accountLabel?: Maybe<Scalars['String']['output']>;
  active: Scalars['Boolean']['output'];
  activeEndpoints: Array<Scalars['String']['output']>;
  externalId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name?: Maybe<Scalars['String']['output']>;
  needsReauth: Scalars['Boolean']['output'];
  provider: ProviderType;
  providerId: Scalars['ID']['output'];
  schedule?: Maybe<Scalars['String']['output']>;
  syncState?: Maybe<Scalars['JSON']['output']>;
  tokenExpiry?: Maybe<Scalars['DateTime']['output']>;
};

export type ContentConnection = Connection & {
  __typename?: 'ContentConnection';
  edges: Array<ContentEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ContentEdge = Edge & {
  __typename?: 'ContentEdge';
  cursor: Scalars['String']['output'];
  node: ContentType;
};

export type ContentFacets = {
  __typename?: 'ContentFacets';
  /** Distinct `mimetype` values. */
  mimetypes: Array<Scalars['String']['output']>;
  /** Distinct `source_system` values — the How filter, over content alone. */
  sourceSystems: Array<Scalars['String']['output']>;
  /** Distinct `type` values (image, post, note, …). */
  types: Array<Scalars['String']['output']>;
};

export type ContentType = Node & Taggable & {
  __typename?: 'ContentType';
  createdAt: Scalars['DateTime']['output'];
  event?: Maybe<EventType>;
  externalId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  mediaFilename?: Maybe<Scalars['String']['output']>;
  mediaSize?: Maybe<Scalars['Float']['output']>;
  mediaUrl?: Maybe<Scalars['String']['output']>;
  mimetype?: Maybe<Scalars['String']['output']>;
  player?: Maybe<EmbedPlayerType>;
  previewUrl?: Maybe<Scalars['String']['output']>;
  sourceData?: Maybe<Scalars['JSON']['output']>;
  sourceId?: Maybe<Scalars['String']['output']>;
  sourceSystem?: Maybe<Scalars['String']['output']>;
  sourceType?: Maybe<Scalars['String']['output']>;
  sourceUrl?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  text?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  type?: Maybe<Scalars['String']['output']>;
  unfurl?: Maybe<UnfurlType>;
  url?: Maybe<Scalars['String']['output']>;
};

export type CreateAnswerInput = {
  answer: Scalars['String']['input'];
  questionId: Scalars['String']['input'];
};

export type CreateAskBroadcastInput = {
  query: AskQueryInput;
  /** 2–25 recipients. */
  responderIds: Array<Scalars['ID']['input']>;
};

export type CreateAskGrantInput = {
  dataClass?: InputMaybe<Scalars['String']['input']>;
  dataClasses?: InputMaybe<Array<Scalars['String']['input']>>;
  delegation?: InputMaybe<Scalars['String']['input']>;
  granteeId?: InputMaybe<Scalars['ID']['input']>;
  granteePeerLinkId?: InputMaybe<Scalars['ID']['input']>;
  maxDisclosure?: InputMaybe<DisclosureRung>;
  mode: GrantMode;
  purpose?: InputMaybe<Scalars['String']['input']>;
  queryType: Scalars['String']['input'];
};

export type CreateAskInput = {
  query: AskQueryInput;
  responderId: Scalars['ID']['input'];
};

export type CreateAskPayload = {
  __typename?: 'CreateAskPayload';
  ask?: Maybe<AskType>;
  decision?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type CreateBrowserActivityInput = {
  actionType?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  containsSensitive?: InputMaybe<Scalars['Boolean']['input']>;
  deviceId?: InputMaybe<Scalars['String']['input']>;
  durationSeconds?: InputMaybe<Scalars['Int']['input']>;
  isIncognito?: InputMaybe<Scalars['Boolean']['input']>;
  pageSummary?: InputMaybe<Scalars['String']['input']>;
  productivityScore?: InputMaybe<Scalars['Float']['input']>;
  properties?: InputMaybe<Scalars['JSON']['input']>;
  scrollDepthPercent?: InputMaybe<Scalars['Float']['input']>;
  sourceId?: InputMaybe<Scalars['String']['input']>;
  sourceSystem?: InputMaybe<Scalars['String']['input']>;
  sourceType?: InputMaybe<Scalars['String']['input']>;
  time: Scalars['DateTime']['input'];
  title?: InputMaybe<Scalars['String']['input']>;
  url: Scalars['String']['input'];
};

export type CreateCommunicationInput = {
  attachments?: InputMaybe<Array<Scalars['JSON']['input']>>;
  communicationType: Scalars['String']['input'];
  content: Scalars['String']['input'];
  direction?: InputMaybe<Scalars['String']['input']>;
  durationSeconds?: InputMaybe<Scalars['Int']['input']>;
  fromEntityId?: InputMaybe<Scalars['String']['input']>;
  participantsMetadata?: InputMaybe<Scalars['JSON']['input']>;
  preview?: InputMaybe<Scalars['String']['input']>;
  sourceId?: InputMaybe<Scalars['String']['input']>;
  sourceSystem?: InputMaybe<Scalars['String']['input']>;
  sourceType?: InputMaybe<Scalars['String']['input']>;
  subject?: InputMaybe<Scalars['String']['input']>;
  threadId?: InputMaybe<Scalars['String']['input']>;
  time: Scalars['DateTime']['input'];
  toEntityIds?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type CreateConceptInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  linkedId?: InputMaybe<Scalars['String']['input']>;
  linkedTable?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
};

export type CreateConceptPayload = {
  __typename?: 'CreateConceptPayload';
  concept?: Maybe<ConceptType>;
  success: Scalars['Boolean']['output'];
};

export type CreateConnectionInput = {
  accessToken?: InputMaybe<Scalars['String']['input']>;
  activeEndpoints: Array<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  needsReauth?: InputMaybe<Scalars['Boolean']['input']>;
  providerId: Scalars['ID']['input'];
  refreshToken?: InputMaybe<Scalars['String']['input']>;
  schedule?: InputMaybe<Scalars['String']['input']>;
  syncState?: InputMaybe<Scalars['JSON']['input']>;
  tokenExpiry?: InputMaybe<Scalars['DateTime']['input']>;
};

export type CreateConnectionPayload = {
  __typename?: 'CreateConnectionPayload';
  connection?: Maybe<ConnectionType>;
  success: Scalars['Boolean']['output'];
};

export type CreateConnectionSyncJobInput = {
  connectionId: Scalars['ID']['input'];
  cursor?: InputMaybe<Scalars['JSON']['input']>;
  data?: InputMaybe<Scalars['JSON']['input']>;
  endpointName: Scalars['String']['input'];
  error?: InputMaybe<Scalars['JSON']['input']>;
  id?: InputMaybe<Scalars['ID']['input']>;
  jobId?: InputMaybe<Scalars['ID']['input']>;
  nextCursor?: InputMaybe<Scalars['JSON']['input']>;
  properties?: InputMaybe<Scalars['JSON']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  type: Scalars['String']['input'];
  userId: Scalars['ID']['input'];
};

export type CreateConnectionSyncJobPayload = {
  __typename?: 'CreateConnectionSyncJobPayload';
  connectionSyncJob?: Maybe<ConnectionSyncJobType>;
  success: Scalars['Boolean']['output'];
};

export type CreateContentInput = {
  eventId?: InputMaybe<Scalars['ID']['input']>;
  externalId?: InputMaybe<Scalars['String']['input']>;
  mimetype?: InputMaybe<Scalars['String']['input']>;
  sourceData?: InputMaybe<Scalars['JSON']['input']>;
  sourceId?: InputMaybe<Scalars['String']['input']>;
  sourceSystem?: InputMaybe<Scalars['String']['input']>;
  sourceType?: InputMaybe<Scalars['String']['input']>;
  sourceUrl?: InputMaybe<Scalars['String']['input']>;
  text?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<Scalars['String']['input']>;
  url?: InputMaybe<Scalars['String']['input']>;
};

export type CreateEventInput = {
  category?: InputMaybe<Scalars['String']['input']>;
  confidenceScore?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  durationMinutes?: InputMaybe<Scalars['Int']['input']>;
  endTime?: InputMaybe<Scalars['DateTime']['input']>;
  eventType?: InputMaybe<Scalars['String']['input']>;
  isAllDay?: InputMaybe<Scalars['Boolean']['input']>;
  isRecurring?: InputMaybe<Scalars['Boolean']['input']>;
  locationCoordinates?: InputMaybe<Scalars['JSON']['input']>;
  locationEntityId?: InputMaybe<Scalars['ID']['input']>;
  locationName?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  organizerEntityId?: InputMaybe<Scalars['ID']['input']>;
  participantEntityIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  sharingLevel?: InputMaybe<Scalars['String']['input']>;
  sourceId?: InputMaybe<Scalars['ID']['input']>;
  sourceSystem?: InputMaybe<Scalars['String']['input']>;
  sourceType?: InputMaybe<Scalars['String']['input']>;
  startTime: Scalars['DateTime']['input'];
  status?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type CreateItemInput = {
  /** When it was bought or received. */
  acquiredAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** Seller, giver or source, as free text. */
  acquiredFrom?: InputMaybe<Scalars['String']['input']>;
  acquisitionMethod?: InputMaybe<ItemAcquisitionMethod>;
  brand?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  /** Dominant colour as #rrggbb. */
  colorHex?: InputMaybe<Scalars['String']['input']>;
  /** Colour names, dominant first. */
  colors?: InputMaybe<Array<Scalars['String']['input']>>;
  /** {material: fraction} summing to at most 1. Percentages are accepted and converted. */
  composition?: InputMaybe<Scalars['JSON']['input']>;
  condition?: InputMaybe<ItemCondition>;
  currency?: InputMaybe<Scalars['String']['input']>;
  currentValue?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  /** Shorthand such as "12 x 8 x 2 in". Fills only the axes not given individually. */
  dimensions?: InputMaybe<Scalars['String']['input']>;
  /** When it stops being usable. Distinct from a warranty, which is a contract. */
  expiresAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** Height, in millimetres. */
  heightMm?: InputMaybe<Scalars['Float']['input']>;
  /** Serial number, UPC, ISBN, order id, … */
  identifierCodes?: InputMaybe<Scalars['JSON']['input']>;
  /** A digital item is refused a mass, a size and a volume. */
  isDigital?: InputMaybe<Scalars['Boolean']['input']>;
  /** Longest dimension, in millimetres. */
  lengthMm?: InputMaybe<Scalars['Float']['input']>;
  /** When the object was made, not when it was acquired. */
  manufacturedAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** As-owned mass, in grams. */
  massG?: InputMaybe<Scalars['Float']['input']>;
  /** What the object is made of. */
  materials?: InputMaybe<Array<Scalars['String']['input']>>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  purchasePrice?: InputMaybe<Scalars['Float']['input']>;
  quantity?: InputMaybe<Scalars['Int']['input']>;
  subcategory?: InputMaybe<Scalars['String']['input']>;
  unitSystem?: InputMaybe<ItemUnitSystem>;
  /** Capacity — what it holds — in millilitres. */
  volumeMl?: InputMaybe<Scalars['Float']['input']>;
  /** Width, in millimetres. */
  widthMm?: InputMaybe<Scalars['Float']['input']>;
};

export type CreateItemPayload = {
  __typename?: 'CreateItemPayload';
  item?: Maybe<ItemType>;
  success: Scalars['Boolean']['output'];
};

export type CreateNoteInput = {
  content?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type CreateNotePayload = {
  __typename?: 'CreateNotePayload';
  note?: Maybe<NoteType>;
  success: Scalars['Boolean']['output'];
};

export type CreatePeerLinkInput = {
  displayName?: InputMaybe<Scalars['String']['input']>;
  memoryEndpoint: Scalars['String']['input'];
  peerHandle: Scalars['String']['input'];
  personEntityId?: InputMaybe<Scalars['ID']['input']>;
  trustTier?: InputMaybe<PeerTrustTier>;
};

export type CreatePersonInput = {
  addresses?: InputMaybe<Array<PersonAddressInput>>;
  avatarUrl?: InputMaybe<Scalars['String']['input']>;
  birthDate?: InputMaybe<Scalars['String']['input']>;
  city?: InputMaybe<Scalars['String']['input']>;
  contacts?: InputMaybe<Array<PersonContactInput>>;
  country?: InputMaybe<Scalars['String']['input']>;
  department?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  emails?: InputMaybe<Array<Scalars['String']['input']>>;
  firstName?: InputMaybe<Scalars['String']['input']>;
  gender?: InputMaybe<Scalars['String']['input']>;
  jobTitle?: InputMaybe<Scalars['String']['input']>;
  lastName?: InputMaybe<Scalars['String']['input']>;
  linkedId?: InputMaybe<Scalars['String']['input']>;
  linkedTable?: InputMaybe<Scalars['String']['input']>;
  middleName?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  nickname?: InputMaybe<Scalars['String']['input']>;
  organization?: InputMaybe<Scalars['String']['input']>;
  phones?: InputMaybe<Array<Scalars['String']['input']>>;
  postalCode?: InputMaybe<Scalars['String']['input']>;
  pronouns?: InputMaybe<Scalars['String']['input']>;
  region?: InputMaybe<Scalars['String']['input']>;
  streetAddress?: InputMaybe<Scalars['String']['input']>;
  streetAddress2?: InputMaybe<Scalars['String']['input']>;
  website?: InputMaybe<Scalars['String']['input']>;
};

export type CreatePersonPayload = {
  __typename?: 'CreatePersonPayload';
  person?: Maybe<PersonType>;
  success: Scalars['Boolean']['output'];
};

export type CreatePlaceInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  estimated?: InputMaybe<Scalars['Boolean']['input']>;
  geoFormat?: InputMaybe<Scalars['String']['input']>;
  geolocation?: InputMaybe<Scalars['JSON']['input']>;
  latitude?: InputMaybe<Scalars['Float']['input']>;
  locationBoundary?: InputMaybe<Scalars['JSON']['input']>;
  longitude?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  parentId?: InputMaybe<Scalars['String']['input']>;
  placeKind?: InputMaybe<Scalars['String']['input']>;
  properties?: InputMaybe<Scalars['JSON']['input']>;
  tracked?: InputMaybe<Scalars['Boolean']['input']>;
  type?: InputMaybe<Scalars['String']['input']>;
  uploaded?: InputMaybe<Scalars['Boolean']['input']>;
};

export type CreateProviderKeyInput = {
  clientId: Scalars['String']['input'];
  clientSecret: Scalars['String']['input'];
  providerId: Scalars['ID']['input'];
};

export type CreateQuestionInput = {
  category: Scalars['String']['input'];
  text: Scalars['String']['input'];
};

export type CreateRelationshipInput = {
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  fromNodeId: Scalars['ID']['input'];
  fromNodeType: Scalars['String']['input'];
  isBidirectional?: InputMaybe<Scalars['Boolean']['input']>;
  properties?: InputMaybe<Scalars['JSON']['input']>;
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
  strength?: InputMaybe<Scalars['Float']['input']>;
  toNodeId: Scalars['String']['input'];
  toNodeType: Scalars['String']['input'];
  type: Scalars['String']['input'];
};

export type CreateRelationshipPayload = {
  __typename?: 'CreateRelationshipPayload';
  relationship?: Maybe<RelationshipType>;
  success: Scalars['Boolean']['output'];
};

export type CreateSavedSearchInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  entityTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  filters?: InputMaybe<SavedSearchFiltersInput>;
  name?: InputMaybe<Scalars['String']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type CreateSavedSearchPayload = {
  __typename?: 'CreateSavedSearchPayload';
  savedSearch?: Maybe<SavedSearchType>;
  success: Scalars['Boolean']['output'];
};

export type CreateTaskInput = {
  /** User-local calendar date, `YYYY-MM-DD`. */
  deferUntil?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  dueAt?: InputMaybe<Scalars['DateTime']['input']>;
  estimatedMinutes?: InputMaybe<Scalars['Int']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  parentId?: InputMaybe<Scalars['ID']['input']>;
  /** 0 (highest) to 5 (lowest). Defaults to 3. */
  priority?: InputMaybe<Scalars['Int']['input']>;
  /** User-local calendar date, `YYYY-MM-DD`. */
  scheduledFor?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<TaskStatus>;
  /** Wall-clock `HH:MM`, user timezone. Zoneless. */
  taskTime?: InputMaybe<Scalars['String']['input']>;
  title: Scalars['String']['input'];
};

export type CreateTaskPayload = {
  __typename?: 'CreateTaskPayload';
  success: Scalars['Boolean']['output'];
  task?: Maybe<TaskType>;
};

export type CreateThingInput = {
  acquiredAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** Seller, giver or source, as free text. */
  acquiredFrom?: InputMaybe<Scalars['String']['input']>;
  acquisitionMethod?: InputMaybe<ItemAcquisitionMethod>;
  brand?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  /** Dominant colour as #rrggbb. */
  colorHex?: InputMaybe<Scalars['String']['input']>;
  /** Colour names, dominant first. */
  colors?: InputMaybe<Array<Scalars['String']['input']>>;
  /** {material: fraction} summing to at most 1. Percentages are accepted and converted. */
  composition?: InputMaybe<Scalars['JSON']['input']>;
  condition?: InputMaybe<ItemCondition>;
  currency?: InputMaybe<Scalars['String']['input']>;
  currentValue?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  /** Shorthand such as "12 x 8 x 2 in". Fills only the axes not given individually. */
  dimensions?: InputMaybe<Scalars['String']['input']>;
  /** When it stops being usable. Distinct from a warranty, which is a contract. */
  expiresAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** Height, in millimetres. */
  heightMm?: InputMaybe<Scalars['Float']['input']>;
  identifierCodes?: InputMaybe<Scalars['JSON']['input']>;
  /** A digital item is refused a mass, a size and a volume. */
  isDigital?: InputMaybe<Scalars['Boolean']['input']>;
  /** Longest dimension, in millimetres. */
  lengthMm?: InputMaybe<Scalars['Float']['input']>;
  /** When the object was made, not when it was acquired. */
  manufacturedAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** As-owned mass, in grams. */
  massG?: InputMaybe<Scalars['Float']['input']>;
  /** What the object is made of. */
  materials?: InputMaybe<Array<Scalars['String']['input']>>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  purchasePrice?: InputMaybe<Scalars['Float']['input']>;
  sourceId?: InputMaybe<Scalars['String']['input']>;
  sourceSystem?: InputMaybe<Scalars['String']['input']>;
  sourceType?: InputMaybe<Scalars['String']['input']>;
  subcategory?: InputMaybe<Scalars['String']['input']>;
  unitSystem?: InputMaybe<ItemUnitSystem>;
  /** Capacity — what it holds — in millilitres. */
  volumeMl?: InputMaybe<Scalars['Float']['input']>;
  /** Width, in millimetres. */
  widthMm?: InputMaybe<Scalars['Float']['input']>;
};

/** One local-day row from the daily feature store */
export type DailyMetricsType = {
  __typename?: 'DailyMetricsType';
  avgSentiment?: Maybe<Scalars['Float']['output']>;
  /** ISO-8601 when this row was last computed */
  computedAt: Scalars['String']['output'];
  date: Scalars['String']['output'];
  kmTraveled?: Maybe<Scalars['Float']['output']>;
  meetingMinutes?: Maybe<Scalars['Float']['output']>;
  nConversations?: Maybe<Scalars['Int']['output']>;
  nDomains?: Maybe<Scalars['Int']['output']>;
  nMessages?: Maybe<Scalars['Int']['output']>;
  nPlaces?: Maybe<Scalars['Int']['output']>;
  nUniqueContacts?: Maybe<Scalars['Int']['output']>;
  outboundRatio?: Maybe<Scalars['Float']['output']>;
  screenMinutes?: Maybe<Scalars['Float']['output']>;
  sleepMinutes?: Maybe<Scalars['Float']['output']>;
  spendTotal?: Maybe<Scalars['Float']['output']>;
  timeAtHome?: Maybe<Scalars['Float']['output']>;
  timezone: Scalars['String']['output'];
};

export type DeleteByIdInput = {
  id: Scalars['String']['input'];
};

export type DeleteByIdPayload = {
  __typename?: 'DeleteByIdPayload';
  deletedId?: Maybe<Scalars['ID']['output']>;
  success: Scalars['Boolean']['output'];
};

/** A grounded catalog answer. The number is computed; the sentence is phrasing only. */
export type DescriptiveAnswerType = {
  __typename?: 'DescriptiveAnswerType';
  category: Scalars['String']['output'];
  key: Scalars['String']['output'];
  provenance: AnswerProvenanceType;
  question: Scalars['String']['output'];
  text: Scalars['String']['output'];
  timeframe: Scalars['String']['output'];
  unit?: Maybe<Scalars['String']['output']>;
  value?: Maybe<Scalars['Float']['output']>;
};

/** A catalog question the compute-then-narrate engine can answer */
export type DescriptiveQuestionType = {
  __typename?: 'DescriptiveQuestionType';
  /** descriptive | predictive | correlational | anomaly | optimization */
  analyticType?: Maybe<Scalars['String']['output']>;
  category: Scalars['String']['output'];
  key: Scalars['String']['output'];
  question: Scalars['String']['output'];
};

export type DisclosedItemType = {
  __typename?: 'DisclosedItemType';
  id: Scalars['String']['output'];
  type: Scalars['String']['output'];
};

export type DisclosureRung =
  | 'boolean'
  | 'count'
  | 'full'
  | 'none'
  | 'redacted'
  | 'summary';

/** HBPE renewal predictions: periodic behaviors coming due or overdue */
export type DueForecastType = {
  __typename?: 'DueForecastType';
  due: Array<DueItemType>;
  /** ISO-8601 timestamp when this list was generated */
  generatedAt: Scalars['String']['output'];
};

/** A periodic behavior and when it is next expected (renewal prediction) */
export type DueItemType = {
  __typename?: 'DueItemType';
  clusterId: Scalars['String']['output'];
  /** Periodicity confidence in [0,1] */
  confidence: Scalars['Float']['output'];
  daysSinceLast: Scalars['Int']['output'];
  /** Days until due (negative = past the median interval) */
  dueInDays: Scalars['Float']['output'];
  /** Parent L0 behavioral class */
  l0Class: Scalars['String']['output'];
  /** ISO date of the last observed occurrence */
  lastSeen: Scalars['String']['output'];
  medianIntervalDays: Scalars['Float']['output'];
  /** Human-readable cluster name */
  name: Scalars['String']['output'];
  /** True once the gap exceeds the p90 inter-arrival interval */
  overdue: Scalars['Boolean']['output'];
  /** ISO date of the next matching booked calendar event, or null if none */
  scheduledDate?: Maybe<Scalars['String']['output']>;
  /** Credible due window [earliest, latest] in days from now */
  window: Array<Scalars['Float']['output']>;
};

export type Edge = {
  cursor: Scalars['String']['output'];
  node: Node;
};

export type EmbedPlayerType = {
  __typename?: 'EmbedPlayerType';
  aspectRatio: Scalars['Float']['output'];
  mediaKind: Scalars['String']['output'];
  playerUrl: Scalars['String']['output'];
  posterUrl?: Maybe<Scalars['String']['output']>;
  provider: Scalars['String']['output'];
  providerRef: Scalars['String']['output'];
};

export type EntityTagType = Node & {
  __typename?: 'EntityTagType';
  id: Scalars['ID']['output'];
  label: Scalars['String']['output'];
  taggedAt: Scalars['DateTime']['output'];
};

export type EventConnection = Connection & {
  __typename?: 'EventConnection';
  edges: Array<EventEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type EventEdge = Edge & {
  __typename?: 'EventEdge';
  cursor: Scalars['String']['output'];
  node: EventType;
};

export type EventType = Node & Taggable & {
  __typename?: 'EventType';
  category?: Maybe<Scalars['String']['output']>;
  confidenceScore?: Maybe<Scalars['Float']['output']>;
  /** Content rows linked to this event via ci.content.event_id. */
  contents: ContentConnection;
  description?: Maybe<Scalars['String']['output']>;
  durationMinutes?: Maybe<Scalars['Int']['output']>;
  endTime?: Maybe<Scalars['DateTime']['output']>;
  eventType?: Maybe<Scalars['String']['output']>;
  /** 'pending' when the local row has been changed here but not pushed back to `sourceSystem`. */
  externalSyncStatus?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isAllDay?: Maybe<Scalars['Boolean']['output']>;
  isRecurring?: Maybe<Scalars['Boolean']['output']>;
  location?: Maybe<PlaceType>;
  locationCoordinates?: Maybe<Scalars['JSON']['output']>;
  locationEntityId?: Maybe<Scalars['ID']['output']>;
  locationName?: Maybe<Scalars['String']['output']>;
  mediaContentType?: Maybe<Scalars['String']['output']>;
  mediaHeight?: Maybe<Scalars['Int']['output']>;
  mediaSize?: Maybe<Scalars['Float']['output']>;
  mediaUrl?: Maybe<Scalars['String']['output']>;
  mediaWidth?: Maybe<Scalars['Int']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  organizer?: Maybe<PersonType>;
  organizerEntityId?: Maybe<Scalars['ID']['output']>;
  /** Parent event for sub-events / follow-ups. Children: filter by this id. */
  parentEventId?: Maybe<Scalars['ID']['output']>;
  participantEntityIds?: Maybe<Array<Scalars['ID']['output']>>;
  participants: PersonConnection;
  /** Intended minutes for a planned block. Distinct from generated durationMinutes. */
  plannedMinutes?: Maybe<Scalars['Int']['output']>;
  previewUrl?: Maybe<Scalars['String']['output']>;
  sourceId?: Maybe<Scalars['ID']['output']>;
  sourceSystem?: Maybe<Scalars['String']['output']>;
  sourceType?: Maybe<Scalars['String']['output']>;
  startTime: Scalars['DateTime']['output'];
  status?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  /** Task this planned block schedules (`event_type = planned_block`). */
  taskId?: Maybe<Scalars['ID']['output']>;
  /** How much of `startTime` is meaningful: 'second' | 'minute' | 'day' | 'ambiguous' | 'unknown'. 'unknown' pairs with `timeSource = 'ingest'` — no field of the stored instant carries information (see EventEntity.timePrecision). */
  timePrecision?: Maybe<Scalars['String']['output']>;
  /** Provenance for `startTime`: 'source' | 'user' | 'repaired' | 'ingest', or null for a row written before this column existed. 'ingest' means the value is NOT a real date — the source gave this record no time, and `startTime` carries the import wall clock only because the column is NOT NULL. A client MUST treat 'ingest' as "no date" rather than sort or display it as a real instant (see EventEntity.timeSource). */
  timeSource?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};


export type EventTypeContentsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type EventTypeParticipantsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};

export type FileChunkType = Node & {
  __typename?: 'FileChunkType';
  chunkIndex: Scalars['Int']['output'];
  chunkerVersion: Scalars['String']['output'];
  content: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  file?: Maybe<FileType>;
  fileId: Scalars['ID']['output'];
  id: Scalars['ID']['output'];
  parserName: Scalars['String']['output'];
  parserVersion: Scalars['String']['output'];
  sectionTitle?: Maybe<Scalars['String']['output']>;
  sourceLocator?: Maybe<Scalars['JSON']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type FileConnection = Connection & {
  __typename?: 'FileConnection';
  edges: Array<FileEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type FileEdge = Edge & {
  __typename?: 'FileEdge';
  cursor: Scalars['String']['output'];
  node: FileType;
};

export type FileType = Node & Taggable & {
  __typename?: 'FileType';
  contentType: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  externalId?: Maybe<Scalars['String']['output']>;
  filename?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  items?: Maybe<ItemConnection>;
  parseError?: Maybe<Scalars['String']['output']>;
  parseStatus?: Maybe<Scalars['String']['output']>;
  parsedAt?: Maybe<Scalars['DateTime']['output']>;
  previewUrl?: Maybe<Scalars['String']['output']>;
  size?: Maybe<Scalars['Float']['output']>;
  sourceUrl?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  title?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};


export type FileTypeItemsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};

/** One Saturday hypothesis in the forage joint */
export type ForageBranchType = {
  __typename?: 'ForageBranchType';
  id: Scalars['String']['output'];
  mass: Scalars['Float']['output'];
  past: Scalars['Boolean']['output'];
  pinned: Scalars['Boolean']['output'];
  ready: Scalars['Boolean']['output'];
  topTexture?: Maybe<Scalars['String']['output']>;
};

/** Activities that hang off (branch, who) */
export type ForageInterestType = {
  __typename?: 'ForageInterestType';
  activities: Array<Scalars['String']['output']>;
  person: Scalars['String']['output'];
};

/** A lake item scored as a saccade (expected free energy G) */
export type ForageItemType = {
  __typename?: 'ForageItemType';
  ambiguity: Scalars['Float']['output'];
  epistemic: Scalars['Float']['output'];
  g: Scalars['Float']['output'];
  gaze: Scalars['Int']['output'];
  id: Scalars['String']['output'];
  label: Scalars['String']['output'];
  read: Scalars['Boolean']['output'];
  risk: Scalars['Float']['output'];
  /** Index the fact came from: person, place, event, search, graph, derived */
  source?: Maybe<Scalars['String']['output']>;
};

/** A named probability mass (branch, person, or delta) */
export type ForageMassType = {
  __typename?: 'ForageMassType';
  label: Scalars['String']['output'];
  mass: Scalars['Float']['output'];
};

/** One fact the eye already read */
export type ForageReadType = {
  __typename?: 'ForageReadType';
  branchDelta: Array<ForageMassType>;
  cue: Scalars['String']['output'];
  epistemic: Scalars['Float']['output'];
  g: Scalars['Float']['output'];
  itemId: Scalars['String']['output'];
};

/** CI Forager trial: discrete active inference over a memory lake. Not the occupancy histogram. */
export type ForageTrialType = {
  __typename?: 'ForageTrialType';
  attention: Array<ForageItemType>;
  branches: Array<ForageBranchType>;
  horizon: Scalars['String']['output'];
  interests: Array<ForageInterestType>;
  /** demo or memory */
  kind?: Maybe<Scalars['String']['output']>;
  permutationBranch: Scalars['String']['output'];
  permutations: Array<ForageMassType>;
  pick?: Maybe<Scalars['String']['output']>;
  pin?: Maybe<Scalars['String']['output']>;
  question: Scalars['String']['output'];
  reads: Array<ForageReadType>;
  ready: Scalars['Boolean']['output'];
  resolved: Scalars['Boolean']['output'];
  texture?: Maybe<Scalars['String']['output']>;
  textureMass?: Maybe<Scalars['Float']['output']>;
};

/** One 15-minute forecast bucket from the HBPE histogram */
export type ForecastBucketType = {
  __typename?: 'ForecastBucketType';
  bucketIndex: Scalars['Int']['output'];
  l0Probs: Array<ProbabilityEntryType>;
  l1Probs: Array<ProbabilityEntryType>;
  l2Probs?: Maybe<Array<ProbabilityEntryType>>;
  q10: Scalars['Float']['output'];
  q50: Scalars['Float']['output'];
  q90: Scalars['Float']['output'];
  /** ISO-8601 start time for this bucket */
  startTime: Scalars['String']['output'];
};

export type ForecastHistoryBucketType = {
  __typename?: 'ForecastHistoryBucketType';
  actualL0?: Maybe<Scalars['String']['output']>;
  bucketIndex: Scalars['Int']['output'];
  predictedL0: Array<ForecastHistoryProbType>;
};

/** One past local day of logged forecast buckets */
export type ForecastHistoryDayType = {
  __typename?: 'ForecastHistoryDayType';
  buckets: Array<ForecastHistoryBucketType>;
  date: Scalars['String']['output'];
};

export type ForecastHistoryProbType = {
  __typename?: 'ForecastHistoryProbType';
  label: Scalars['String']['output'];
  probability: Scalars['Float']['output'];
};

/** 96-bucket (15-min) HBPE day-ahead forecast */
export type ForecastType = {
  __typename?: 'ForecastType';
  buckets: Array<ForecastBucketType>;
  /** ISO-8601 timestamp when this forecast was generated */
  generatedAt: Scalars['String']['output'];
  /** Forecast horizon, e.g. "48h" */
  horizon: Scalars['String']['output'];
  /** Served histogram model: hmt, b1, or b2 (D3 gate). */
  modelVersion?: Maybe<Scalars['String']['output']>;
  /** Live progress inside the active step, e.g. "1200 of 8400". */
  pipelineDetail?: Maybe<Scalars['String']['output']>;
  /** Estimated seconds remaining in the active Predict/nightly step. */
  pipelineEtaSeconds?: Maybe<Scalars['Int']['output']>;
  /** True when the histogram is a cold-start baseline, not a trained HMT. */
  stillLearning: Scalars['Boolean']['output'];
  /** System status of the HBPE engine (COLD_START, TRAINING, READY) */
  systemStatus: Scalars['String']['output'];
};

export type GrantMode =
  | 'auto'
  | 'block'
  | 'review';

/** A directed typed edge (ci.relationships row) */
export type GraphEdgeType = {
  __typename?: 'GraphEdgeType';
  fromEntityId: Scalars['ID']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  properties?: Maybe<Scalars['JSON']['output']>;
  strength?: Maybe<Scalars['Float']['output']>;
  toEntityId: Scalars['ID']['output'];
  type: Scalars['String']['output'];
};

export type GraphEntityInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  entityType: Scalars['String']['input'];
  key: Scalars['String']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  properties?: InputMaybe<Scalars['JSON']['input']>;
  sourceSystem: Scalars['String']['input'];
};

/** A graph node (ci.entities row, including CTI bases) */
export type GraphNodeType = {
  __typename?: 'GraphNodeType';
  description?: Maybe<Scalars['String']['output']>;
  entityType: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  linkedId?: Maybe<Scalars['String']['output']>;
  linkedTable?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  properties?: Maybe<Scalars['JSON']['output']>;
};

export type GraphRelationshipInput = {
  fromKey: Scalars['String']['input'];
  properties?: InputMaybe<Scalars['JSON']['input']>;
  toKey: Scalars['String']['input'];
  type: Scalars['String']['input'];
};

/** Knowledge graph projection over entities + relationships */
export type GraphType = {
  __typename?: 'GraphType';
  edges: Array<GraphEdgeType>;
  nodes: Array<GraphNodeType>;
};

export type HouseholdTierType = {
  __typename?: 'HouseholdTierType';
  id: Scalars['ID']['output'];
  memberId: Scalars['ID']['output'];
  trustTier: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type InsightItemType = {
  __typename?: 'InsightItemType';
  keyActions: Array<Scalars['String']['output']>;
  relatedEntityIds?: Maybe<Array<Scalars['String']['output']>>;
  relevanceScore: Scalars['Float']['output'];
  summaryText: Scalars['String']['output'];
  tags: Array<Scalars['String']['output']>;
  title: Scalars['String']['output'];
};

/** How an item came to be owned. A purchase and a gift mean different things by acquiredAt. */
export type ItemAcquisitionMethod =
  | 'BORROWED'
  | 'FOUND'
  | 'GIFT'
  | 'INHERITED'
  | 'MADE'
  | 'PURCHASED'
  | 'SAMPLE'
  | 'TRADED'
  | 'UNKNOWN';

export type ItemCondition =
  | 'BROKEN'
  | 'FAIR'
  | 'GOOD'
  | 'LIKE_NEW'
  | 'NA'
  | 'NEW'
  | 'POOR';

export type ItemConnection = Connection & {
  __typename?: 'ItemConnection';
  edges: Array<ItemEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ItemDuplicateGroupType = {
  __typename?: 'ItemDuplicateGroupType';
  items: Array<ItemType>;
  reason: ItemDuplicateReason;
  totalItems: Scalars['Int']['output'];
  value: Scalars['String']['output'];
};

/** What a duplicate group collapsed on: a shared identifier, the same product, or the same brand+model bought on the same day. */
export type ItemDuplicateReason =
  | 'BRAND_MODEL'
  | 'IDENTIFIER'
  | 'PRODUCT_NAME';

export type ItemDuplicatesPayload = {
  __typename?: 'ItemDuplicatesPayload';
  groups: Array<ItemDuplicateGroupType>;
  hasMore: Scalars['Boolean']['output'];
  totalCount: Scalars['Int']['output'];
};

export type ItemEdge = Edge & {
  __typename?: 'ItemEdge';
  cursor: Scalars['String']['output'];
  node: ItemType;
};

/** Ownership state. A disposed thing is still a thing that happened, so it is never deleted. */
export type ItemLifecycleState =
  | 'ACTIVE'
  | 'ARCHIVED'
  | 'CONSUMED'
  | 'DISPOSED'
  | 'LENT_OUT'
  | 'LOST'
  | 'RETURNED'
  | 'STORED';

export type ItemRelationshipInput = {
  fromSourceId: Scalars['String']['input'];
  fromSourceSystem: Scalars['String']['input'];
  fromSourceType: Scalars['String']['input'];
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  relation: Scalars['String']['input'];
  toSourceId: Scalars['String']['input'];
  toSourceSystem: Scalars['String']['input'];
  toSourceType: Scalars['String']['input'];
};

/** How to order the things list. NEWEST is served by the keyset index; the others order a bounded window of it. */
export type ItemSortOrder =
  | 'NAME_ASC'
  | 'NAME_DESC'
  | 'NEWEST'
  | 'OLDEST'
  | 'RECENTLY_ACQUIRED'
  | 'RECENTLY_SEEN'
  | 'VALUE_ASC'
  | 'VALUE_DESC';

export type ItemType = Node & Taggable & {
  __typename?: 'ItemType';
  /** When it was bought or received. */
  acquiredAt?: Maybe<Scalars['DateTime']['output']>;
  /** Seller, giver or source. */
  acquiredFrom?: Maybe<Scalars['String']['output']>;
  acquisition?: Maybe<ReceiptLineItemType>;
  acquisitionMethod?: Maybe<ItemAcquisitionMethod>;
  brand?: Maybe<Scalars['String']['output']>;
  category?: Maybe<Scalars['String']['output']>;
  /** Dominant colour as #rrggbb. */
  colorHex?: Maybe<Scalars['String']['output']>;
  /** Colour names, dominant first. */
  colors?: Maybe<Array<Scalars['String']['output']>>;
  /** {material: fraction}; {} when the proportions are unknown. */
  composition: Scalars['JSON']['output'];
  condition?: Maybe<ItemCondition>;
  createdAt: Scalars['DateTime']['output'];
  currency: Scalars['String']['output'];
  currentValue?: Maybe<Scalars['Float']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  /** When it stops being usable. */
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  file?: Maybe<FileType>;
  /** Height, in millimetres. */
  heightMm?: Maybe<Scalars['Float']['output']>;
  id: Scalars['ID']['output'];
  identifiers: Array<ObjectIdentifierType>;
  /** How sure we are this row is one real, distinct thing. 1.0 = a human said so or a barcode was scanned; lower = minted from a receipt line or guessed from a photo. */
  identityConfidence: Scalars['Float']['output'];
  isDigital: Scalars['Boolean']['output'];
  /** When this thing was last SEEN — by a confirmed sighting, not by being edited. */
  lastSeenAt?: Maybe<Scalars['DateTime']['output']>;
  /** Longest dimension, in millimetres. */
  lengthMm?: Maybe<Scalars['Float']['output']>;
  /** Ownership state. A disposed thing keeps its row — it still happened. */
  lifecycleState: ItemLifecycleState;
  /** When the object was made. */
  manufacturedAt?: Maybe<Scalars['DateTime']['output']>;
  /** As-owned mass, in grams. */
  massG?: Maybe<Scalars['Float']['output']>;
  /** What the object is made of. */
  materials?: Maybe<Array<Scalars['String']['output']>>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  observations: Array<ObjectObservationType>;
  product?: Maybe<ProductModelType>;
  purchasePrice?: Maybe<Scalars['Float']['output']>;
  quantity: Scalars['Int']['output'];
  sourceId?: Maybe<Scalars['String']['output']>;
  sourceSystem?: Maybe<Scalars['String']['output']>;
  sourceType?: Maybe<Scalars['String']['output']>;
  subcategory?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  /** The unit system these measurements were entered in. Presentation only. */
  unitSystem?: Maybe<ItemUnitSystem>;
  updatedAt: Scalars['DateTime']['output'];
  /** Capacity — what it holds — in millilitres. */
  volumeMl?: Maybe<Scalars['Float']['output']>;
  /** Width, in millimetres. */
  widthMm?: Maybe<Scalars['Float']['output']>;
};

/** Display preference for measurements. Stored values are always SI (millimetres, grams, millilitres) whichever this is. */
export type ItemUnitSystem =
  | 'IMPERIAL'
  | 'METRIC';

export type KnownPlaceCandidateType = {
  __typename?: 'KnownPlaceCandidateType';
  confidence: Scalars['Float']['output'];
  eventCount: Scalars['Int']['output'];
  kind: Scalars['String']['output'];
  label: Scalars['String']['output'];
  lat: Scalars['Float']['output'];
  lng: Scalars['Float']['output'];
  locationId?: Maybe<Scalars['String']['output']>;
};

export type KnownPlaceCoordinates = {
  __typename?: 'KnownPlaceCoordinates';
  lat: Scalars['Float']['output'];
  lng: Scalars['Float']['output'];
};

export type KnownPlaceCoordinatesInput = {
  lat: Scalars['Float']['input'];
  lng: Scalars['Float']['input'];
};

export type KnownPlaceType = {
  __typename?: 'KnownPlaceType';
  activeFrom?: Maybe<Scalars['String']['output']>;
  activeTo?: Maybe<Scalars['String']['output']>;
  aliases: Array<Scalars['String']['output']>;
  confidence: Scalars['Float']['output'];
  coordinates?: Maybe<KnownPlaceCoordinates>;
  id: Scalars['ID']['output'];
  kind: Scalars['String']['output'];
  label: Scalars['String']['output'];
  locationId?: Maybe<Scalars['String']['output']>;
  source: Scalars['String']['output'];
};

export type LinkItemToProductInput = {
  itemId: Scalars['ID']['input'];
  productId?: InputMaybe<Scalars['ID']['input']>;
};

export type MapPinType = {
  __typename?: 'MapPinType';
  endTime?: Maybe<Scalars['DateTime']['output']>;
  eventType?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  latitude: Scalars['Float']['output'];
  locationName?: Maybe<Scalars['String']['output']>;
  longitude: Scalars['Float']['output'];
  startTime?: Maybe<Scalars['DateTime']['output']>;
  timeSource?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export type MapPinsType = {
  __typename?: 'MapPinsType';
  pins: Array<MapPinType>;
  totalCount: Scalars['Int']['output'];
  truncated: Scalars['Boolean']['output'];
};

export type MergeCandidateConnection = {
  __typename?: 'MergeCandidateConnection';
  edges: Array<MergeCandidateEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type MergeCandidateEdge = {
  __typename?: 'MergeCandidateEdge';
  cursor: Scalars['String']['output'];
  node: MergeCandidateType;
};

export type MergeCandidateEvidenceType = {
  __typename?: 'MergeCandidateEvidenceType';
  kind: Scalars['String']['output'];
  score?: Maybe<Scalars['Float']['output']>;
  value: Scalars['String']['output'];
};

export type MergeCandidateType = {
  __typename?: 'MergeCandidateType';
  createdAt: Scalars['DateTime']['output'];
  detectedBy: Scalars['String']['output'];
  detectorVersion: Scalars['Int']['output'];
  entityType: Scalars['String']['output'];
  evidence: Array<MergeCandidateEvidenceType>;
  id: Scalars['ID']['output'];
  people: Array<PersonType>;
  score: Scalars['Float']['output'];
  status: Scalars['String']['output'];
};

export type MergeItemsInput = {
  sourceIds: Array<Scalars['ID']['input']>;
  targetId: Scalars['ID']['input'];
};

export type MergeItemsPayload = {
  __typename?: 'MergeItemsPayload';
  counts?: Maybe<ObjectMergeCountsType>;
  item?: Maybe<ItemType>;
  success: Scalars['Boolean']['output'];
};

export type MergePeopleInput = {
  sourceIds: Array<Scalars['ID']['input']>;
  targetId: Scalars['ID']['input'];
};

export type MergePeoplePayload = {
  __typename?: 'MergePeoplePayload';
  person?: Maybe<PersonType>;
  success: Scalars['Boolean']['output'];
};

export type MergePlacesInput = {
  sourceIds: Array<Scalars['ID']['input']>;
  targetId: Scalars['ID']['input'];
};

export type MergePlacesPayload = {
  __typename?: 'MergePlacesPayload';
  counts?: Maybe<PlaceMergeCountsType>;
  place?: Maybe<PlaceType>;
  success: Scalars['Boolean']['output'];
};

export type MergeProductModelsInput = {
  sourceIds: Array<Scalars['ID']['input']>;
  targetId: Scalars['ID']['input'];
};

export type MergeProductModelsPayload = {
  __typename?: 'MergeProductModelsPayload';
  counts?: Maybe<ProductMergeCountsType>;
  product?: Maybe<ProductModelType>;
  success: Scalars['Boolean']['output'];
};

export type MessageConnection = Connection & {
  __typename?: 'MessageConnection';
  edges: Array<MessageEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type MessageEdge = Edge & {
  __typename?: 'MessageEdge';
  cursor: Scalars['String']['output'];
  node: MessageType;
};

export type MessageType = Node & {
  __typename?: 'MessageType';
  content: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  role?: Maybe<Scalars['String']['output']>;
  threadId: Scalars['ID']['output'];
};

/** A dated metric or behavioral anomaly. Computed, not LLM-invented. */
export type MetricAnomalyType = {
  __typename?: 'MetricAnomalyType';
  baseline?: Maybe<Scalars['Float']['output']>;
  coverage: Scalars['Float']['output'];
  date: Scalars['String']['output'];
  detector: Scalars['String']['output'];
  direction: Scalars['String']['output'];
  id: Scalars['String']['output'];
  metadata: Scalars['JSON']['output'];
  metric: Scalars['String']['output'];
  score: Scalars['Float']['output'];
  value?: Maybe<Scalars['Float']['output']>;
};

/** A pairwise / lagged association over daily_metrics. Language is hypothesis ("associated with"), never cause. */
export type MetricCorrelationType = {
  __typename?: 'MetricCorrelationType';
  coverageMean?: Maybe<Scalars['Float']['output']>;
  effect?: Maybe<Scalars['Float']['output']>;
  id: Scalars['String']['output'];
  lagDays: Scalars['Int']['output'];
  metricA: Scalars['String']['output'];
  metricB: Scalars['String']['output'];
  n: Scalars['Int']['output'];
  novelty: Scalars['Float']['output'];
  pValue?: Maybe<Scalars['Float']['output']>;
  pearson?: Maybe<Scalars['Float']['output']>;
  qValue?: Maybe<Scalars['Float']['output']>;
  robust: Scalars['Boolean']['output'];
  spearman?: Maybe<Scalars['Float']['output']>;
  windowDays: Scalars['Int']['output'];
};

/** One forecast day with its q10/q50/q90 band */
export type MetricForecastPointType = {
  __typename?: 'MetricForecastPointType';
  /** YYYY-MM-DD */
  date: Scalars['String']['output'];
  q10: Scalars['Float']['output'];
  q50: Scalars['Float']['output'];
  q90: Scalars['Float']['output'];
};

/** Seasonal-naive + EWMA forecast of a daily-metrics scalar */
export type MetricForecastType = {
  __typename?: 'MetricForecastType';
  /** Fraction of the 90-day history window that had a value */
  coverage: Scalars['Float']['output'];
  horizonDays: Scalars['Int']['output'];
  metric: Scalars['String']['output'];
  points: Array<MetricForecastPointType>;
  /** OK, NOT_ENOUGH_SIGNAL, or UNKNOWN_METRIC */
  status: Scalars['String']['output'];
};

/** An evidence-linked suggestion. Never emitted without a correlation or anomaly FK. */
export type MetricSuggestionType = {
  __typename?: 'MetricSuggestionType';
  acceptedAt?: Maybe<Scalars['String']['output']>;
  dismissedAt?: Maybe<Scalars['String']['output']>;
  evidence: Scalars['JSON']['output'];
  id: Scalars['String']['output'];
  key: Scalars['String']['output'];
  priority?: Maybe<Scalars['Int']['output']>;
  text: Scalars['String']['output'];
  title: Scalars['String']['output'];
};

export type Mutation = {
  __typename?: 'Mutation';
  /** Accept a candidate at a chosen time, minting a real event */
  acceptCandidate: EventType;
  /** Accept a proposed task into the open backlog. Keeps any preferred date as a hint; does not place a calendar block. */
  acceptProposedTask?: Maybe<TaskType>;
  /** Apply a pending automation change (mutate / complete / event revise). */
  acceptTaskPendingChange: ResolveTaskPendingChangePayload;
  addItemIdentifier: Array<ObjectIdentifierType>;
  addPersonIdentifier: Array<PersonIdentifierType>;
  approveAsk: AskPayload;
  /** Break free text into schedule candidates. Adds to the slate; schedules nothing. */
  breakDownTasks: Array<ScheduleCandidateType>;
  bulkIngestGraph: BulkGraphPayload;
  bulkIngestItemRelationships: BulkItemRelationshipResult;
  /** Mark a task done. Idempotent — the original completion instant is preserved. */
  completeTask?: Maybe<TaskType>;
  confirmObservation?: Maybe<ObjectObservationType>;
  createAnswer: AnswerType;
  createAnswers: Array<AnswerType>;
  createAsk: CreateAskPayload;
  createAskBroadcast: AskBroadcastType;
  createAskGrant: AskGrantPayload;
  createBrowserActivities: Array<BrowserActivityType>;
  createCommunications: Array<CommunicationType>;
  createConcept: CreateConceptPayload;
  createConcepts: Array<ConceptType>;
  createConnection: CreateConnectionPayload;
  createConnectionSyncJob: CreateConnectionSyncJobPayload;
  createContent: ContentType;
  createContents: Array<ContentType>;
  createEvent: EventType;
  createEvents: Array<EventType>;
  createItem: CreateItemPayload;
  createNote: CreateNotePayload;
  createNotes: Array<NoteType>;
  createPeerLink: PeerLinkPayload;
  createPeople: Array<PersonType>;
  createPerson: CreatePersonPayload;
  createPlace: PlaceType;
  createPlaces: Array<PlaceType>;
  createProviderKey: ProviderKeyType;
  createQuestion: QuestionType;
  createQuestions: Array<QuestionType>;
  createRelationship: CreateRelationshipPayload;
  createSavedSearch: CreateSavedSearchPayload;
  createTask: CreateTaskPayload;
  createThings: Array<ItemType>;
  declineAsk: AskPayload;
  /** Reject a candidate. reason: not_now | wrong_time | not_like_this | never */
  declineCandidate: ScheduleCandidateType;
  /** Decline a proposed task (archives it). */
  declineProposedTask?: Maybe<TaskType>;
  /** Dismiss a pending automation change without applying it. */
  declineTaskPendingChange: ResolveTaskPendingChangePayload;
  /** Push a task to a later user-local date (`YYYY-MM-DD`) and count the push. */
  deferTask?: Maybe<TaskType>;
  deleteBrowserActivity: DeleteByIdPayload;
  deleteCommunication: DeleteByIdPayload;
  deleteConcept: DeleteByIdPayload;
  deleteConnection: DeleteByIdPayload;
  deleteConnectionSyncJob: DeleteByIdPayload;
  deleteContent: DeleteByIdPayload;
  deleteEvent: DeleteByIdPayload;
  deleteItem: DeleteByIdPayload;
  deleteNote: DeleteByIdPayload;
  deletePerson: DeleteByIdPayload;
  deletePlace: DeleteByIdPayload;
  deleteProviderKey: Scalars['Boolean']['output'];
  deleteRelationship: DeleteByIdPayload;
  deleteSavedSearch: DeleteByIdPayload;
  deleteTag: DeleteByIdPayload;
  deleteTask: DeleteByIdPayload;
  /** Pin a branch so the eye hunts inside it */
  foragePin?: Maybe<ForageTrialType>;
  /** Rebuild the memory lake from people, places, events, and indexes */
  forageReset?: Maybe<ForageTrialType>;
  /** Read the next lake item by expected free energy; may query indexes when the lake runs thin */
  forageSample?: Maybe<ForageTrialType>;
  /** Name occupancy branches from memory via the LLM; falls back to occupancy labels on failure */
  guessBranchialForecast?: Maybe<BranchialTreeType>;
  linkItemToProduct: UpdateItemPayload;
  /** Mark an action as dismissed */
  markActionAsDismissed?: Maybe<ActionType>;
  /** Mark an action as seen */
  markActionAsSeen?: Maybe<ActionType>;
  /** Mark a summary as dismissed */
  markSummaryAsDismissed?: Maybe<SummaryType>;
  /** Mark a summary as seen */
  markSummaryAsSeen?: Maybe<SummaryType>;
  mergeItems: MergeItemsPayload;
  mergePeople: MergePeoplePayload;
  mergePlaces: MergePlacesPayload;
  mergeProductModels: MergeProductModelsPayload;
  /** Accept into Unscheduled: open if proposed, drop pending suggestions, remove any calendar block. */
  planTask?: Maybe<TaskType>;
  /** Rebuild stay-point clusters and recency-decayed transitions for the current user */
  rebuildPlaces: Scalars['String']['output'];
  /** Recompute and upsert a trailing window of daily metrics for the signed-in user. */
  refreshDailyMetrics: Array<DailyMetricsType>;
  /** Mark a suggested duplicate group as distinct things, so it is never re-proposed */
  rejectItemDuplicates: Scalars['Boolean']['output'];
  rejectObservation?: Maybe<ObjectObservationType>;
  /** Mark a suggested duplicate group as distinct people, so it is never re-proposed */
  rejectPersonDuplicates: Scalars['Boolean']['output'];
  /** Mark a suggested duplicate group as distinct places, so it is never re-proposed */
  rejectPlaceDuplicates: Scalars['Boolean']['output'];
  removeAnswer: Scalars['Boolean']['output'];
  removeContent: Scalars['Boolean']['output'];
  removeEvent: Scalars['Boolean']['output'];
  removeItemIdentifier: Array<ObjectIdentifierType>;
  removePersonIdentifier: Array<PersonIdentifierType>;
  removePlace: Scalars['Boolean']['output'];
  removeQuestion: Scalars['Boolean']['output'];
  /** Move a completed task back to open. */
  reopenTask?: Maybe<TaskType>;
  /** Move an event to a new time, keeping its duration. Externally-sourced events are moved locally only and marked pending — the change is not pushed to the source calendar. */
  rescheduleEvent?: Maybe<EventType>;
  restoreEvent?: Maybe<EventType>;
  /** Return a placed event to the slate, deleting the event it minted */
  returnEventToSlate: ScheduleCandidateType;
  revokeAskGrant: AskGrantPayload;
  revokePeerLink: PeerLinkPayload;
  runAsk: RunAskPayload;
  /** Place an open task into the next free workday gap as a planned calendar block. The click is consent — trust dial does not re-ask. */
  scheduleTask: ScheduleTaskPayload;
  sendPeerAsk: SendPeerAskPayload;
  setHouseholdTier: HouseholdTierType;
  setSavedSearchSharing: UpdateSavedSearchPayload;
  /** Defer a candidate until a future instant */
  snoozeCandidate: ScheduleCandidateType;
  /** Refresh the slate from current actions and insight key_actions. Idempotent; returns rows written. */
  syncScheduleSuggestions: Scalars['Int']['output'];
  tagEntities: Array<TaggableEntityType>;
  /** Manually trigger the HBPE pipeline for the current user */
  triggerHbpe: Scalars['String']['output'];
  /** Remove the planned block for this task and clear scheduledFor. */
  unscheduleTask?: Maybe<TaskType>;
  untagEntities: Array<TaggableEntityType>;
  updateAnswer?: Maybe<AnswerType>;
  updateAskGrant: AskGrantPayload;
  updateBrowserActivity?: Maybe<BrowserActivityType>;
  updateCommunication?: Maybe<CommunicationType>;
  updateConcept: UpdateConceptPayload;
  updateConnection: UpdateConnectionPayload;
  updateConnectionSyncJob: UpdateConnectionSyncJobPayload;
  updateContent?: Maybe<ContentType>;
  updateCurrentUser?: Maybe<UserType>;
  updateEvent?: Maybe<EventType>;
  updateFile?: Maybe<FileType>;
  updateItem: UpdateItemPayload;
  updateKnownPlace: KnownPlaceType;
  updateNote: UpdateNotePayload;
  updatePeerLink: PeerLinkPayload;
  updatePerson: UpdatePersonPayload;
  updatePlace?: Maybe<PlaceType>;
  updateProviderKey?: Maybe<ProviderKeyType>;
  updateQuestion?: Maybe<QuestionType>;
  updateRelationship: UpdateRelationshipPayload;
  updateSavedSearch: UpdateSavedSearchPayload;
  updateTag: UpdateTagPayload;
  updateTask: UpdateTaskPayload;
};


export type MutationAcceptCandidateArgs = {
  endTime?: InputMaybe<Scalars['DateTime']['input']>;
  id: Scalars['ID']['input'];
  startTime: Scalars['DateTime']['input'];
};


export type MutationAcceptProposedTaskArgs = {
  id: Scalars['ID']['input'];
};


export type MutationAcceptTaskPendingChangeArgs = {
  id: Scalars['ID']['input'];
};


export type MutationAddItemIdentifierArgs = {
  input: AddItemIdentifierInput;
};


export type MutationAddPersonIdentifierArgs = {
  input: AddPersonIdentifierInput;
};


export type MutationApproveAskArgs = {
  id: Scalars['ID']['input'];
};


export type MutationBreakDownTasksArgs = {
  text: Scalars['String']['input'];
};


export type MutationBulkIngestGraphArgs = {
  input: BulkGraphInput;
};


export type MutationBulkIngestItemRelationshipsArgs = {
  input: Array<ItemRelationshipInput>;
};


export type MutationCompleteTaskArgs = {
  actualMinutes?: InputMaybe<Scalars['Int']['input']>;
  id: Scalars['ID']['input'];
};


export type MutationConfirmObservationArgs = {
  id: Scalars['ID']['input'];
  itemId?: InputMaybe<Scalars['ID']['input']>;
  productId?: InputMaybe<Scalars['ID']['input']>;
};


export type MutationCreateAnswerArgs = {
  input: CreateAnswerInput;
};


export type MutationCreateAnswersArgs = {
  input: Array<CreateAnswerInput>;
};


export type MutationCreateAskArgs = {
  input: CreateAskInput;
};


export type MutationCreateAskBroadcastArgs = {
  input: CreateAskBroadcastInput;
};


export type MutationCreateAskGrantArgs = {
  input: CreateAskGrantInput;
};


export type MutationCreateBrowserActivitiesArgs = {
  input: Array<CreateBrowserActivityInput>;
};


export type MutationCreateCommunicationsArgs = {
  input: Array<CreateCommunicationInput>;
};


export type MutationCreateConceptArgs = {
  input: CreateConceptInput;
};


export type MutationCreateConceptsArgs = {
  input: Array<CreateConceptInput>;
};


export type MutationCreateConnectionArgs = {
  input: CreateConnectionInput;
};


export type MutationCreateConnectionSyncJobArgs = {
  input: CreateConnectionSyncJobInput;
};


export type MutationCreateContentArgs = {
  input: CreateContentInput;
};


export type MutationCreateContentsArgs = {
  input: Array<CreateContentInput>;
};


export type MutationCreateEventArgs = {
  input: CreateEventInput;
};


export type MutationCreateEventsArgs = {
  input: Array<CreateEventInput>;
};


export type MutationCreateItemArgs = {
  input: CreateItemInput;
};


export type MutationCreateNoteArgs = {
  input: CreateNoteInput;
};


export type MutationCreateNotesArgs = {
  input: Array<CreateNoteInput>;
};


export type MutationCreatePeerLinkArgs = {
  input: CreatePeerLinkInput;
};


export type MutationCreatePeopleArgs = {
  input: Array<CreatePersonInput>;
};


export type MutationCreatePersonArgs = {
  input: CreatePersonInput;
};


export type MutationCreatePlaceArgs = {
  input: CreatePlaceInput;
};


export type MutationCreatePlacesArgs = {
  input: Array<CreatePlaceInput>;
};


export type MutationCreateProviderKeyArgs = {
  input: CreateProviderKeyInput;
};


export type MutationCreateQuestionArgs = {
  input: CreateQuestionInput;
};


export type MutationCreateQuestionsArgs = {
  input: Array<CreateQuestionInput>;
};


export type MutationCreateRelationshipArgs = {
  input: CreateRelationshipInput;
};


export type MutationCreateSavedSearchArgs = {
  input: CreateSavedSearchInput;
};


export type MutationCreateTaskArgs = {
  input: CreateTaskInput;
};


export type MutationCreateThingsArgs = {
  input: Array<CreateThingInput>;
};


export type MutationDeclineAskArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeclineCandidateArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};


export type MutationDeclineProposedTaskArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeclineTaskPendingChangeArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeferTaskArgs = {
  id: Scalars['ID']['input'];
  until: Scalars['String']['input'];
};


export type MutationDeleteBrowserActivityArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteCommunicationArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteConceptArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteConnectionArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteConnectionSyncJobArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteContentArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteEventArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteItemArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteNoteArgs = {
  input: DeleteByIdInput;
};


export type MutationDeletePersonArgs = {
  input: DeleteByIdInput;
};


export type MutationDeletePlaceArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteProviderKeyArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeleteRelationshipArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteSavedSearchArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteTagArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteTaskArgs = {
  input: DeleteByIdInput;
};


export type MutationForagePinArgs = {
  branch: Scalars['String']['input'];
};


export type MutationLinkItemToProductArgs = {
  input: LinkItemToProductInput;
};


export type MutationMarkActionAsDismissedArgs = {
  id: Scalars['ID']['input'];
};


export type MutationMarkActionAsSeenArgs = {
  id: Scalars['ID']['input'];
};


export type MutationMarkSummaryAsDismissedArgs = {
  id: Scalars['ID']['input'];
};


export type MutationMarkSummaryAsSeenArgs = {
  id: Scalars['ID']['input'];
};


export type MutationMergeItemsArgs = {
  input: MergeItemsInput;
};


export type MutationMergePeopleArgs = {
  input: MergePeopleInput;
};


export type MutationMergePlacesArgs = {
  input: MergePlacesInput;
};


export type MutationMergeProductModelsArgs = {
  input: MergeProductModelsInput;
};


export type MutationPlanTaskArgs = {
  id: Scalars['ID']['input'];
};


export type MutationRefreshDailyMetricsArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
  timezone?: InputMaybe<Scalars['String']['input']>;
};


export type MutationRejectItemDuplicatesArgs = {
  itemIds: Array<Scalars['ID']['input']>;
};


export type MutationRejectObservationArgs = {
  id: Scalars['ID']['input'];
};


export type MutationRejectPersonDuplicatesArgs = {
  personIds: Array<Scalars['ID']['input']>;
};


export type MutationRejectPlaceDuplicatesArgs = {
  placeIds: Array<Scalars['ID']['input']>;
};


export type MutationRemoveAnswerArgs = {
  id: Scalars['ID']['input'];
};


export type MutationRemoveContentArgs = {
  id: Scalars['ID']['input'];
};


export type MutationRemoveEventArgs = {
  id: Scalars['ID']['input'];
};


export type MutationRemoveItemIdentifierArgs = {
  input: RemoveItemIdentifierInput;
};


export type MutationRemovePersonIdentifierArgs = {
  input: RemovePersonIdentifierInput;
};


export type MutationRemovePlaceArgs = {
  id: Scalars['ID']['input'];
};


export type MutationRemoveQuestionArgs = {
  id: Scalars['ID']['input'];
};


export type MutationReopenTaskArgs = {
  id: Scalars['ID']['input'];
};


export type MutationRescheduleEventArgs = {
  endTime?: InputMaybe<Scalars['DateTime']['input']>;
  id: Scalars['ID']['input'];
  startTime: Scalars['DateTime']['input'];
};


export type MutationRestoreEventArgs = {
  input: RestoreByIdInput;
};


export type MutationReturnEventToSlateArgs = {
  eventId: Scalars['ID']['input'];
};


export type MutationRevokeAskGrantArgs = {
  id: Scalars['ID']['input'];
};


export type MutationRevokePeerLinkArgs = {
  id: Scalars['ID']['input'];
};


export type MutationRunAskArgs = {
  disclosureForm?: InputMaybe<AnswerForm>;
  id: Scalars['ID']['input'];
  redactItemIds?: InputMaybe<Array<Scalars['String']['input']>>;
};


export type MutationScheduleTaskArgs = {
  date?: InputMaybe<Scalars['String']['input']>;
  endTime?: InputMaybe<Scalars['DateTime']['input']>;
  estimatedMinutes?: InputMaybe<Scalars['Int']['input']>;
  id: Scalars['ID']['input'];
  startTime?: InputMaybe<Scalars['DateTime']['input']>;
};


export type MutationSendPeerAskArgs = {
  input: SendPeerAskInput;
};


export type MutationSetHouseholdTierArgs = {
  input: SetHouseholdTierInput;
};


export type MutationSetSavedSearchSharingArgs = {
  input: SetSavedSearchSharingInput;
};


export type MutationSnoozeCandidateArgs = {
  id: Scalars['ID']['input'];
  until: Scalars['DateTime']['input'];
};


export type MutationTagEntitiesArgs = {
  input: TagEntitiesInput;
};


export type MutationUnscheduleTaskArgs = {
  id: Scalars['ID']['input'];
};


export type MutationUntagEntitiesArgs = {
  input: TagEntitiesInput;
};


export type MutationUpdateAnswerArgs = {
  input: UpdateAnswerInput;
};


export type MutationUpdateAskGrantArgs = {
  id: Scalars['ID']['input'];
  input: UpdateAskGrantInput;
};


export type MutationUpdateBrowserActivityArgs = {
  input: UpdateBrowserActivityInput;
};


export type MutationUpdateCommunicationArgs = {
  input: UpdateCommunicationInput;
};


export type MutationUpdateConceptArgs = {
  input: UpdateConceptInput;
};


export type MutationUpdateConnectionArgs = {
  input: UpdateConnectionInput;
};


export type MutationUpdateConnectionSyncJobArgs = {
  input: UpdateConnectionSyncJobInput;
};


export type MutationUpdateContentArgs = {
  input: UpdateContentInput;
};


export type MutationUpdateCurrentUserArgs = {
  input: UpdateCurrentUserInput;
};


export type MutationUpdateEventArgs = {
  input: UpdateEventInput;
};


export type MutationUpdateFileArgs = {
  input: UpdateFileInput;
};


export type MutationUpdateItemArgs = {
  input: UpdateItemInput;
};


export type MutationUpdateKnownPlaceArgs = {
  input: UpdateKnownPlaceInput;
};


export type MutationUpdateNoteArgs = {
  input: UpdateNoteInput;
};


export type MutationUpdatePeerLinkArgs = {
  input: UpdatePeerLinkInput;
};


export type MutationUpdatePersonArgs = {
  input: UpdatePersonInput;
};


export type MutationUpdatePlaceArgs = {
  input: UpdatePlaceInput;
};


export type MutationUpdateProviderKeyArgs = {
  id: Scalars['ID']['input'];
  input: UpdateProviderKeyInput;
};


export type MutationUpdateQuestionArgs = {
  input: UpdateQuestionInput;
};


export type MutationUpdateRelationshipArgs = {
  input: UpdateRelationshipInput;
};


export type MutationUpdateSavedSearchArgs = {
  input: UpdateSavedSearchInput;
};


export type MutationUpdateTagArgs = {
  input: UpdateTagInput;
};


export type MutationUpdateTaskArgs = {
  input: UpdateTaskInput;
};

export type Node = {
  id: Scalars['ID']['output'];
};

export type NoteConnection = Connection & {
  __typename?: 'NoteConnection';
  edges: Array<NoteEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type NoteEdge = Edge & {
  __typename?: 'NoteEdge';
  cursor: Scalars['String']['output'];
  node: NoteType;
};

export type NoteType = Node & Taggable & {
  __typename?: 'NoteType';
  content?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  tags: Array<EntityTagType>;
  title?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type ObjectByIdentifierPayload = {
  __typename?: 'ObjectByIdentifierPayload';
  /** Confidence in the CLAIM that was matched. */
  confidence?: Maybe<Scalars['Float']['output']>;
  item?: Maybe<ItemType>;
  matched: Scalars['Boolean']['output'];
  /** The namespace the value normalized into — not always the one asked for. */
  namespace?: Maybe<ObjectIdentifierNamespace>;
  product?: Maybe<ProductModelType>;
  subjectType?: Maybe<ObjectIdentifierSubjectType>;
  value?: Maybe<Scalars['String']['output']>;
};

/** What kind of code an identifier is. gtin/isbn/asin/imei/vin are globally unique; the rest are unique only within a scope. */
export type ObjectIdentifierNamespace =
  | 'ASIN'
  | 'CUSTOM'
  | 'GTIN'
  | 'IMEI'
  | 'ISBN'
  | 'MPN'
  | 'ORDER_ID'
  | 'QR'
  | 'RFID'
  | 'SERIAL'
  | 'SKU'
  | 'VIN';

export type ObjectIdentifierScopeInput = {
  brand?: InputMaybe<Scalars['String']['input']>;
  sourceSystem?: InputMaybe<Scalars['String']['input']>;
};

/** Whether a claim identifies a catalog MODEL (every unit shares a GTIN) or one owned INSTANCE (a serial). */
export type ObjectIdentifierSubjectType =
  | 'OBJECT_INSTANCE'
  | 'PRODUCT_MODEL';

export type ObjectIdentifierType = {
  __typename?: 'ObjectIdentifierType';
  confidence: Scalars['Float']['output'];
  createdAt: Scalars['DateTime']['output'];
  isPrimary: Scalars['Boolean']['output'];
  namespace: ObjectIdentifierNamespace;
  qualifier: Scalars['String']['output'];
  rawValue?: Maybe<Scalars['String']['output']>;
  source?: Maybe<Scalars['String']['output']>;
  value: Scalars['String']['output'];
};

export type ObjectMergeCountsType = {
  __typename?: 'ObjectMergeCountsType';
  identifiers: Scalars['Int']['output'];
  objectParent: Scalars['Int']['output'];
  objectRelated: Scalars['Int']['output'];
  observations: Scalars['Int']['output'];
  receiptLineItems: Scalars['Int']['output'];
  searchRowsDeleted: Scalars['Int']['output'];
  tagLinksMoved: Scalars['Int']['output'];
};

export type ObjectObservationType = Node & {
  __typename?: 'ObjectObservationType';
  attributes: Scalars['JSON']['output'];
  bbox?: Maybe<BoundingBoxType>;
  /** A human confirmed this link. Written only by confirmObservation. */
  confirmedByUser: Scalars['Boolean']['output'];
  contentId?: Maybe<Scalars['ID']['output']>;
  createdAt: Scalars['DateTime']['output'];
  cropContentId?: Maybe<Scalars['ID']['output']>;
  /** How sure the detector was it saw something. */
  detectionConfidence?: Maybe<Scalars['Float']['output']>;
  detector?: Maybe<Scalars['String']['output']>;
  detectorVersion?: Maybe<Scalars['String']['output']>;
  eventId?: Maybe<Scalars['ID']['output']>;
  fileId?: Maybe<Scalars['ID']['output']>;
  id: Scalars['ID']['output'];
  label: Scalars['String']['output'];
  labelSource?: Maybe<ObservationLabelSource>;
  /** The cropped thumbnail of the sighting, or the whole frame when there is no crop. */
  media?: Maybe<ContentType>;
  metadata: Scalars['JSON']['output'];
  observedAt: Scalars['DateTime']['output'];
  place?: Maybe<PlaceType>;
  placeEntityId?: Maybe<Scalars['ID']['output']>;
  /** How sure the ladder was about the link. */
  resolutionConfidence?: Maybe<Scalars['Float']['output']>;
  resolutionMethod: ObservationResolutionMethod;
  resolvedObjectId?: Maybe<Scalars['ID']['output']>;
  resolvedProductId?: Maybe<Scalars['ID']['output']>;
  sourceKind: ObservationSourceKind;
  updatedAt: Scalars['DateTime']['output'];
};

/** What produced the label. */
export type ObservationLabelSource =
  | 'CLIP'
  | 'IMPORT'
  | 'OLLAMA_VISION'
  | 'USER'
  | 'YOLO';

/** Which rung of the resolution ladder linked the sighting to an owned unit. */
export type ObservationResolutionMethod =
  | 'EMBEDDING'
  | 'IDENTIFIER'
  | 'LABEL'
  | 'NONE'
  | 'PLACE_PRIOR'
  | 'USER';

/** What kind of frame the sighting came from. */
export type ObservationSourceKind =
  | 'LIVE_CAMERA'
  | 'MANUAL'
  | 'PHOTO'
  | 'SCREENSHOT'
  | 'VIDEO_FRAME';

export type PageInfo = {
  __typename?: 'PageInfo';
  endCursor?: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
  hasPreviousPage: Scalars['Boolean']['output'];
  startCursor?: Maybe<Scalars['String']['output']>;
};

export type PeerLinkPayload = {
  __typename?: 'PeerLinkPayload';
  peerLink?: Maybe<PeerLinkType>;
  success: Scalars['Boolean']['output'];
};

export type PeerLinkStatus =
  | 'active'
  | 'pending'
  | 'revoked';

export type PeerLinkType = {
  __typename?: 'PeerLinkType';
  avatarUrl?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  displayName?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  memoryEndpoint: Scalars['String']['output'];
  peerHandle: Scalars['String']['output'];
  personEntityId?: Maybe<Scalars['ID']['output']>;
  revokedAt?: Maybe<Scalars['DateTime']['output']>;
  status: PeerLinkStatus;
  trustTier: PeerTrustTier;
  updatedAt: Scalars['DateTime']['output'];
};

export type PeerTrustTier =
  | 'family'
  | 'peer'
  | 'stranger'
  | 'trusted';

export type PersonAddressInput = {
  city?: InputMaybe<Scalars['String']['input']>;
  country?: InputMaybe<Scalars['String']['input']>;
  isPrimary?: InputMaybe<Scalars['Boolean']['input']>;
  label?: InputMaybe<Scalars['String']['input']>;
  postalCode?: InputMaybe<Scalars['String']['input']>;
  region?: InputMaybe<Scalars['String']['input']>;
  streetAddress?: InputMaybe<Scalars['String']['input']>;
  streetAddress2?: InputMaybe<Scalars['String']['input']>;
};

export type PersonAddressType = {
  __typename?: 'PersonAddressType';
  city?: Maybe<Scalars['String']['output']>;
  country?: Maybe<Scalars['String']['output']>;
  formatted?: Maybe<Scalars['String']['output']>;
  isPrimary: Scalars['Boolean']['output'];
  label?: Maybe<Scalars['String']['output']>;
  postalCode?: Maybe<Scalars['String']['output']>;
  region?: Maybe<Scalars['String']['output']>;
  streetAddress?: Maybe<Scalars['String']['output']>;
  streetAddress2?: Maybe<Scalars['String']['output']>;
};

export type PersonConnection = Connection & {
  __typename?: 'PersonConnection';
  edges: Array<PersonEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type PersonContactInput = {
  isPrimary?: InputMaybe<Scalars['Boolean']['input']>;
  kind: Scalars['String']['input'];
  label?: InputMaybe<Scalars['String']['input']>;
  value: Scalars['String']['input'];
};

export type PersonDuplicateGroupType = {
  __typename?: 'PersonDuplicateGroupType';
  people: Array<PersonType>;
  reason: Scalars['String']['output'];
  totalPeople: Scalars['Int']['output'];
  value: Scalars['String']['output'];
};

export type PersonDuplicatesPayload = {
  __typename?: 'PersonDuplicatesPayload';
  groups: Array<PersonDuplicateGroupType>;
  hasMore: Scalars['Boolean']['output'];
  totalCount: Scalars['Int']['output'];
};

export type PersonEdge = Edge & {
  __typename?: 'PersonEdge';
  cursor: Scalars['String']['output'];
  node: PersonType;
};

export type PersonIdentifierType = {
  __typename?: 'PersonIdentifierType';
  isPrimary: Scalars['Boolean']['output'];
  kind: Scalars['String']['output'];
  label?: Maybe<Scalars['String']['output']>;
  rawValue?: Maybe<Scalars['String']['output']>;
  source?: Maybe<Scalars['String']['output']>;
  value: Scalars['String']['output'];
  verifiedAt?: Maybe<Scalars['DateTime']['output']>;
};

export type PersonInteractionStatsType = {
  __typename?: 'PersonInteractionStatsType';
  communicationCount: Scalars['Int']['output'];
  eventCount: Scalars['Int']['output'];
  lastInteractionAt?: Maybe<Scalars['DateTime']['output']>;
};

export type PersonType = Node & Taggable & {
  __typename?: 'PersonType';
  address?: Maybe<Scalars['String']['output']>;
  addresses: Array<PersonAddressType>;
  appearedAt?: Maybe<Scalars['DateTime']['output']>;
  avatarUrl?: Maybe<Scalars['String']['output']>;
  birthDate?: Maybe<Scalars['String']['output']>;
  city?: Maybe<Scalars['String']['output']>;
  country?: Maybe<Scalars['String']['output']>;
  department?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  firstName?: Maybe<Scalars['String']['output']>;
  gender?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  identifiers: Array<PersonIdentifierType>;
  incomingRelationships?: Maybe<Array<RelationshipType>>;
  interactionStats: PersonInteractionStatsType;
  isSelf: Scalars['Boolean']['output'];
  jobTitle?: Maybe<Scalars['String']['output']>;
  lastName?: Maybe<Scalars['String']['output']>;
  middleName?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  nickname?: Maybe<Scalars['String']['output']>;
  organization?: Maybe<Scalars['String']['output']>;
  outgoingRelationships?: Maybe<Array<RelationshipType>>;
  postalCode?: Maybe<Scalars['String']['output']>;
  pronouns?: Maybe<Scalars['String']['output']>;
  region?: Maybe<Scalars['String']['output']>;
  streetAddress?: Maybe<Scalars['String']['output']>;
  streetAddress2?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  website?: Maybe<Scalars['String']['output']>;
};


export type PersonTypeIncomingRelationshipsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type PersonTypeOutgoingRelationshipsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};

export type PlaceConnection = Connection & {
  __typename?: 'PlaceConnection';
  edges: Array<PlaceEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type PlaceDuplicateGroupType = {
  __typename?: 'PlaceDuplicateGroupType';
  places: Array<PlaceType>;
  reason: PlaceDuplicateReason;
  totalPlaces: Scalars['Int']['output'];
  value: Scalars['String']['output'];
};

/** What a duplicate place group collapsed on: the same provider place id, or the same name within 150 m. */
export type PlaceDuplicateReason =
  | 'NAME_PROXIMITY'
  | 'PLACE_ID';

export type PlaceDuplicatesPayload = {
  __typename?: 'PlaceDuplicatesPayload';
  groups: Array<PlaceDuplicateGroupType>;
  hasMore: Scalars['Boolean']['output'];
  totalCount: Scalars['Int']['output'];
};

export type PlaceEdge = Edge & {
  __typename?: 'PlaceEdge';
  cursor: Scalars['String']['output'];
  node: PlaceType;
};

/** A likely next place from the stay-point transition model (recency-decayed, hour/dow backoff) */
export type PlaceForecastItemType = {
  __typename?: 'PlaceForecastItemType';
  backoffLevel?: Maybe<Scalars['String']['output']>;
  clusterId?: Maybe<Scalars['String']['output']>;
  label?: Maybe<Scalars['String']['output']>;
  lastSeen?: Maybe<Scalars['String']['output']>;
  lat: Scalars['Float']['output'];
  lng: Scalars['Float']['output'];
  probability: Scalars['Float']['output'];
  share: Scalars['Float']['output'];
  visits: Scalars['Int']['output'];
};

export type PlaceMergeCountsType = {
  __typename?: 'PlaceMergeCountsType';
  childPlaces: Scalars['Int']['output'];
  events: Scalars['Int']['output'];
  identifiers: Scalars['Int']['output'];
  objects: Scalars['Int']['output'];
  observations: Scalars['Int']['output'];
  positions: Scalars['Int']['output'];
  receipts: Scalars['Int']['output'];
  relationshipsDropped: Scalars['Int']['output'];
  relationshipsFrom: Scalars['Int']['output'];
  relationshipsTo: Scalars['Int']['output'];
  searchRowsDeleted: Scalars['Int']['output'];
  tagLinksMoved: Scalars['Int']['output'];
};

export type PlaceNearType = {
  __typename?: 'PlaceNearType';
  distanceMeters: Scalars['Float']['output'];
  place: PlaceType;
};

export type PlaceType = Node & Taggable & {
  __typename?: 'PlaceType';
  appearedAt?: Maybe<Scalars['DateTime']['output']>;
  boundary?: Maybe<Scalars['JSON']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  entityType: Scalars['String']['output'];
  estimated?: Maybe<Scalars['Boolean']['output']>;
  geoFormat?: Maybe<Scalars['String']['output']>;
  geolocation?: Maybe<Scalars['JSON']['output']>;
  id: Scalars['ID']['output'];
  incomingRelationships?: Maybe<Array<RelationshipType>>;
  latitude?: Maybe<Scalars['Float']['output']>;
  locationBoundary?: Maybe<Scalars['JSON']['output']>;
  longitude?: Maybe<Scalars['Float']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  outgoingRelationships?: Maybe<Array<RelationshipType>>;
  parent?: Maybe<PlaceType>;
  parentId?: Maybe<Scalars['ID']['output']>;
  placeKind?: Maybe<Scalars['String']['output']>;
  properties: Scalars['JSON']['output'];
  tags: Array<EntityTagType>;
  tracked?: Maybe<Scalars['Boolean']['output']>;
  type?: Maybe<Scalars['String']['output']>;
  uploaded?: Maybe<Scalars['Boolean']['output']>;
  visitStats: PlaceVisitStatsType;
};


export type PlaceTypeIncomingRelationshipsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type PlaceTypeOutgoingRelationshipsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};

export type PlaceVisitStatsType = {
  __typename?: 'PlaceVisitStatsType';
  firstVisitAt?: Maybe<Scalars['DateTime']['output']>;
  lastVisitAt?: Maybe<Scalars['DateTime']['output']>;
  status: Scalars['String']['output'];
  visitCount: Scalars['Int']['output'];
};

export type PositionPointType = {
  __typename?: 'PositionPointType';
  activityType?: Maybe<Scalars['String']['output']>;
  cursor: Scalars['String']['output'];
  endTime: Scalars['DateTime']['output'];
  fixCount: Scalars['Int']['output'];
  latitude: Scalars['Float']['output'];
  longitude: Scalars['Float']['output'];
  startTime: Scalars['DateTime']['output'];
};

export type PositionTrackExtentType = {
  __typename?: 'PositionTrackExtentType';
  count: Scalars['Int']['output'];
  end: Scalars['DateTime']['output'];
  start: Scalars['DateTime']['output'];
};

export type PositionTrackInput = {
  after?: InputMaybe<Scalars['String']['input']>;
  bbox?: InputMaybe<Array<Scalars['Float']['input']>>;
  endTime?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  maxPoints?: InputMaybe<Scalars['Int']['input']>;
  startTime?: InputMaybe<Scalars['String']['input']>;
};

export type PositionTrackType = {
  __typename?: 'PositionTrackType';
  bucketSeconds?: Maybe<Scalars['Int']['output']>;
  endCursor?: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
  points: Array<PositionPointType>;
  totalCount?: Maybe<Scalars['Int']['output']>;
};

/** Forecast self-consistency against Qwen-derived behavior labels — not ground-truth accuracy. */
export type PredictionCalibrationType = {
  __typename?: 'PredictionCalibrationType';
  basis: Scalars['String']['output'];
  history: Array<CalibrationScoreType>;
  latest?: Maybe<CalibrationScoreType>;
};

/** A single label→probability entry from the HBPE histogram */
export type ProbabilityEntryType = {
  __typename?: 'ProbabilityEntryType';
  label: Scalars['String']['output'];
  probability: Scalars['Float']['output'];
};

export type ProductMergeCountsType = {
  __typename?: 'ProductMergeCountsType';
  identifiers: Scalars['Int']['output'];
  objectProduct: Scalars['Int']['output'];
  observations: Scalars['Int']['output'];
  receiptLineItems: Scalars['Int']['output'];
};

export type ProductModelConnection = Connection & {
  __typename?: 'ProductModelConnection';
  edges: Array<ProductModelEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ProductModelEdge = Edge & {
  __typename?: 'ProductModelEdge';
  cursor: Scalars['String']['output'];
  node: ProductModelType;
};

export type ProductModelType = Node & Taggable & {
  __typename?: 'ProductModelType';
  brand?: Maybe<Scalars['String']['output']>;
  category?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  currency?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  identifiers: Array<ObjectIdentifierType>;
  /** How sure we are this model is a real, distinct product. 1.0 = asserted by a human or a catalog; lower = derived from a receipt line or a vision guess. */
  identityConfidence: Scalars['Float']['output'];
  image?: Maybe<ContentType>;
  /** ci.content row holding the catalog image. */
  imageContentId?: Maybe<Scalars['ID']['output']>;
  isDigital: Scalars['Boolean']['output'];
  /** ci.content rows holding manuals. */
  manualContentIds?: Maybe<Array<Scalars['ID']['output']>>;
  manufacturer?: Maybe<Scalars['String']['output']>;
  metadata: Scalars['JSON']['output'];
  modelNumber?: Maybe<Scalars['String']['output']>;
  /** Manufacturer list price in integer MINOR units of `currency`. */
  msrpMinor?: Maybe<Scalars['Int']['output']>;
  /** The ci.entities node mirroring this model. */
  productEntityId?: Maybe<Scalars['ID']['output']>;
  productType?: Maybe<Scalars['String']['output']>;
  sourceId?: Maybe<Scalars['String']['output']>;
  sourceSystem?: Maybe<Scalars['String']['output']>;
  sourceType?: Maybe<Scalars['String']['output']>;
  /** Descriptive specifications. */
  spec: Scalars['JSON']['output'];
  subcategory?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  /** Variant AXES only ({color, capacity, size}) — never descriptive specs. */
  variantAttributes: Scalars['JSON']['output'];
};

export type ProviderConnection = Connection & {
  __typename?: 'ProviderConnection';
  edges: Array<ProviderEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ProviderEdge = Edge & {
  __typename?: 'ProviderEdge';
  cursor: Scalars['String']['output'];
  node: ProviderType;
};

export type ProviderEndpointType = {
  __typename?: 'ProviderEndpointType';
  TTL?: Maybe<Scalars['Float']['output']>;
  description: Scalars['String']['output'];
  iterationType: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type ProviderKeyType = Node & {
  __typename?: 'ProviderKeyType';
  clientId: Scalars['String']['output'];
  clientSecret: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  providerId: Scalars['ID']['output'];
  updatedAt: Scalars['DateTime']['output'];
  userId: Scalars['ID']['output'];
};

export type ProviderThemeType = {
  __typename?: 'ProviderThemeType';
  backgroundColor?: Maybe<Scalars['String']['output']>;
  borderColor?: Maybe<Scalars['String']['output']>;
};

export type ProviderType = Node & {
  __typename?: 'ProviderType';
  appSetupUrl?: Maybe<Scalars['String']['output']>;
  authType?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  endpoints: Array<ProviderEndpointType>;
  id: Scalars['ID']['output'];
  localOnly: Scalars['Boolean']['output'];
  logoUrl?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  openidKeyLink?: Maybe<Scalars['String']['output']>;
  providerKeys?: Maybe<ProviderKeyType>;
  scopes?: Maybe<Array<Scalars['String']['output']>>;
  theme?: Maybe<ProviderThemeType>;
};

export type Query = {
  __typename?: 'Query';
  action?: Maybe<ActionType>;
  actions: ActionConnection;
  /** Precomputed activity counts per local calendar day, with day boundaries in the user profile timezone. Eventually consistent: refreshed from the source tables every 15 minutes. When filters are supplied, counts reflect the same Memory explorer constraints as the search results. */
  activityTimeline: Array<ActivityBucketType>;
  answer?: Maybe<AnswerType>;
  answers: AnswerConnection;
  ask?: Maybe<AskType>;
  askAnswer?: Maybe<AskAnswerType>;
  askDisclosureHistory: AskDisclosureHistoryPayload;
  askDisclosureSummary: AskDisclosureSummaryPayload;
  askGrant?: Maybe<AskGrantType>;
  askInbox: Array<AskType>;
  askOutbox: Array<AskType>;
  /** Occupancy spine: remaining dayparts and week-ahead days as a walkable tree */
  branchialForecast?: Maybe<BranchialTreeType>;
  browserActivities: BrowserActivityConnection;
  browserActivity?: Maybe<BrowserActivityType>;
  /** Answers catalog questions of one analytic type (descriptive, correlational, anomaly, optimization, predictive). */
  catalogAnswers: Array<DescriptiveAnswerType>;
  communication?: Maybe<CommunicationType>;
  communications: CommunicationConnection;
  concept?: Maybe<ConceptType>;
  concepts: ConceptConnection;
  connection?: Maybe<ConnectionType>;
  connectionSyncJob?: Maybe<ConnectionSyncJobType>;
  connectionSyncJobs: ConnectionSyncJobConnection;
  connections: ConnectionConnection;
  content?: Maybe<ContentType>;
  /** The distinct type / mimetype / source values the content library can filter by. */
  contentFacets: ContentFacets;
  contents: ContentConnection;
  /** Precomputed daily feature-store rows for the signed-in user over an inclusive yyyy-MM-dd range. */
  dailyMetrics: Array<DailyMetricsType>;
  /** Answers every catalog question from stored daily_metrics. */
  descriptiveAnswers: Array<DescriptiveAnswerType>;
  /** The question catalog the compute-then-narrate engine can answer. */
  descriptiveQuestions: Array<DescriptiveQuestionType>;
  /** Fetch HBPE renewal predictions: periodic behaviors coming due or overdue */
  dueForecast?: Maybe<DueForecastType>;
  event?: Maybe<EventType>;
  /** Distinct data sources / connectors (event.source_system) present for the user. */
  eventSources: Array<Scalars['String']['output']>;
  /** Distinct event types ("how things happened") present for the user. */
  eventTypes: Array<Scalars['String']['output']>;
  events: EventConnection;
  /** Events overlapping [from, to) — calendar read path. Excludes cancelled/no-show; keeps tentative. Allowlisted types: calendar_event, meeting, appointment, planned_block, plus events with no event_type (user-created and accepted suggestions). */
  eventsInRange: Array<EventType>;
  /** Get actions for the feed, prioritizing unseen actions */
  feedActions: Array<ActionType>;
  file?: Maybe<FileType>;
  files: FileConnection;
  /** CI Forager over the user memory lake: people, places, events, search indexes, and derived forecasts */
  forage?: Maybe<ForageTrialType>;
  /** Fetch the HBPE day-ahead forecast histogram */
  forecast?: Maybe<ForecastType>;
  /** Past forecast-vs-actual buckets from hbpe.prediction_log */
  forecastHistory: Array<ForecastHistoryDayType>;
  geocodingConfigured: Scalars['Boolean']['output'];
  /** User knowledge graph (entities + relationships). Preferred over REST /api/graph/*. */
  graph: GraphType;
  item?: Maybe<ItemType>;
  itemDuplicates: ItemDuplicatesPayload;
  items: ItemConnection;
  knownPlaceCandidates: Array<KnownPlaceCandidateType>;
  knownPlaces: Array<KnownPlaceType>;
  /** Located events as map markers for the given filters. Events-only and located-only; returns the whole matching set in one read (capped at 20000 pins), not a page. */
  mapPins: MapPinsType;
  me?: Maybe<UserType>;
  mergeCandidates: MergeCandidateConnection;
  /** Computed metric and behavioral anomalies. Not the free-text list inside summaries. */
  metricAnomalies: Array<MetricAnomalyType>;
  /** Pairwise / lagged associations. Hypotheses ("associated with"), never causes. */
  metricCorrelations: Array<MetricCorrelationType>;
  /** 1–7 day seasonal-naive + EWMA forecast of daily-metrics scalars */
  metricForecast: Array<MetricForecastType>;
  /** Evidence-linked suggestions. Findings persist even when derivation.engines is off. */
  metricSuggestions: Array<MetricSuggestionType>;
  myAskBroadcasts: Array<AskBroadcastType>;
  myAskGrantHistory: Array<AskGrantType>;
  myAskGrants: Array<AskGrantType>;
  myHouseholdTiers: Array<HouseholdTierType>;
  myPeerLinks: Array<PeerLinkType>;
  node?: Maybe<Node>;
  note?: Maybe<NoteType>;
  notes: NoteConnection;
  oAuthCallbackUrl: Scalars['String']['output'];
  objectByIdentifier: ObjectByIdentifierPayload;
  peerLink?: Maybe<PeerLinkType>;
  people: PersonConnection;
  person?: Maybe<PersonType>;
  personDuplicates: PersonDuplicatesPayload;
  place?: Maybe<PlaceType>;
  placeDuplicates: PlaceDuplicatesPayload;
  /** Likely next places from the stay-point transition model (recency-decayed, hour/dow backoff) */
  placeForecast: Array<PlaceForecastItemType>;
  places: PlaceConnection;
  placesContaining: Array<PlaceType>;
  placesNear: Array<PlaceNearType>;
  /** Planned blocks (`event_type = planned_block`) overlapping [from, to). SQL-pushdown, not the explorer events() feed. */
  plannedBlocks: Array<EventType>;
  /** The signed-in user's location history (ci.position) as a downsampled, keyset-paged trace for the map. Filtered by viewport bounding box and time range. */
  positionTrack: PositionTrackType;
  /** The signed-in user's whole ci.position history (first fix, last fix, count), unpaged. */
  positionTrackExtent?: Maybe<PositionTrackExtentType>;
  /** Forecast self-consistency scores (not ground-truth accuracy) */
  predictionCalibration?: Maybe<PredictionCalibrationType>;
  productModel?: Maybe<ProductModelType>;
  productModels: ProductModelConnection;
  provider?: Maybe<ProviderType>;
  providers: ProviderConnection;
  question?: Maybe<QuestionType>;
  questions: QuestionConnection;
  receipt?: Maybe<ReceiptType>;
  receipts: ReceiptConnection;
  relationship?: Maybe<RelationshipType>;
  relationships: RelationshipConnection;
  reverseGeocode: ReverseGeocodeResultType;
  savedSearch?: Maybe<SavedSearchType>;
  savedSearches: SavedSearchConnection;
  /** Open schedule candidates whose plausible window overlaps [from, to) */
  scheduleCandidates: Array<ScheduleCandidateType>;
  search: SearchResultConnection;
  sharedSavedSearch?: Maybe<SavedSearchType>;
  /** Distinct data sources (source_system) present for the user across every browsed table — events, communications, content, browser activity, receipts, products and things. The How picker's option list; `eventSources` is the events-only subset. Takes the same includeTypes / excludeTypes pair as `search`, so the list is pared to the kinds a What selection has in play — a source no selected kind carries would select nothing. */
  sourceSystems: Array<Scalars['String']['output']>;
  summaries: SummaryConnection;
  summary?: Maybe<SummaryType>;
  tag?: Maybe<TagType>;
  tags: TagConnection;
  task?: Maybe<TaskType>;
  /** Pending trust-dial confirmations for mutate/complete/revise/schedule. */
  taskPendingChanges: Array<TaskPendingChangeType>;
  tasks: TaskConnection;
  thread?: Maybe<ThreadType>;
  threads: ThreadConnection;
  unresolvedObservations: Array<ObjectObservationType>;
  /** Fetch the HBPE week-horizon occurrence forecast (per-day cluster probabilities) */
  weekForecast?: Maybe<WeekForecastType>;
};


export type QueryActionArgs = {
  id: Scalars['ID']['input'];
};


export type QueryActionsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryActivityTimelineArgs = {
  end: Scalars['String']['input'];
  filters?: InputMaybe<ActivityTimelineFiltersInput>;
  start: Scalars['String']['input'];
};


export type QueryAnswerArgs = {
  id: Scalars['ID']['input'];
};


export type QueryAnswersArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryAskArgs = {
  id: Scalars['ID']['input'];
};


export type QueryAskAnswerArgs = {
  id: Scalars['ID']['input'];
};


export type QueryAskDisclosureHistoryArgs = {
  input?: InputMaybe<AskDisclosureHistoryInput>;
};


export type QueryAskDisclosureSummaryArgs = {
  input?: InputMaybe<AskDisclosureSummaryInput>;
};


export type QueryAskGrantArgs = {
  id: Scalars['ID']['input'];
};


export type QueryBrowserActivitiesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryBrowserActivityArgs = {
  id: Scalars['ID']['input'];
};


export type QueryCatalogAnswersArgs = {
  analyticType: Scalars['String']['input'];
  date?: InputMaybe<Scalars['String']['input']>;
};


export type QueryCommunicationArgs = {
  id: Scalars['ID']['input'];
};


export type QueryCommunicationsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryConceptArgs = {
  id: Scalars['ID']['input'];
};


export type QueryConceptsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryConnectionArgs = {
  id: Scalars['ID']['input'];
};


export type QueryConnectionSyncJobArgs = {
  id: Scalars['ID']['input'];
};


export type QueryConnectionSyncJobsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  connectionId?: InputMaybe<Scalars['ID']['input']>;
  endpointName?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
  type?: InputMaybe<Scalars['String']['input']>;
};


export type QueryConnectionsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryContentArgs = {
  id: Scalars['ID']['input'];
};


export type QueryContentsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  connectors?: InputMaybe<Array<Scalars['String']['input']>>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
  mimetypes?: InputMaybe<Array<Scalars['String']['input']>>;
  query?: InputMaybe<Scalars['String']['input']>;
  types?: InputMaybe<Array<Scalars['String']['input']>>;
};


export type QueryDailyMetricsArgs = {
  from: Scalars['String']['input'];
  to: Scalars['String']['input'];
};


export type QueryDescriptiveAnswersArgs = {
  date?: InputMaybe<Scalars['String']['input']>;
};


export type QueryDescriptiveQuestionsArgs = {
  analyticType?: InputMaybe<Scalars['String']['input']>;
};


export type QueryEventArgs = {
  id: Scalars['ID']['input'];
};


export type QueryEventsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryEventsInRangeArgs = {
  from: Scalars['DateTime']['input'];
  to: Scalars['DateTime']['input'];
};


export type QueryFeedActionsArgs = {
  limit?: Scalars['Int']['input'];
};


export type QueryFileArgs = {
  id: Scalars['ID']['input'];
};


export type QueryFilesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryForecastArgs = {
  horizon?: InputMaybe<Scalars['String']['input']>;
};


export type QueryForecastHistoryArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryGraphArgs = {
  entityType?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryItemArgs = {
  id: Scalars['ID']['input'];
};


export type QueryItemDuplicatesArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryItemsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  brand?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  condition?: InputMaybe<ItemCondition>;
  first?: InputMaybe<Scalars['Int']['input']>;
  hasIdentifier?: InputMaybe<Scalars['Boolean']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
  lifecycleState?: InputMaybe<ItemLifecycleState>;
  query?: InputMaybe<Scalars['String']['input']>;
  sort?: InputMaybe<ItemSortOrder>;
};


export type QueryKnownPlacesArgs = {
  kind?: InputMaybe<Scalars['String']['input']>;
};


export type QueryMapPinsArgs = {
  input: SearchInput;
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryMergeCandidatesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};


export type QueryMetricAnomaliesArgs = {
  metric?: InputMaybe<Scalars['String']['input']>;
  since?: InputMaybe<Scalars['String']['input']>;
};


export type QueryMetricCorrelationsArgs = {
  robustOnly?: InputMaybe<Scalars['Boolean']['input']>;
  windowDays?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryMetricForecastArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryMetricSuggestionsArgs = {
  includeDismissed?: InputMaybe<Scalars['Boolean']['input']>;
};


export type QueryNodeArgs = {
  id: Scalars['ID']['input'];
};


export type QueryNoteArgs = {
  id: Scalars['ID']['input'];
};


export type QueryNotesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryObjectByIdentifierArgs = {
  brand?: InputMaybe<Scalars['String']['input']>;
  namespace: ObjectIdentifierNamespace;
  sourceSystem?: InputMaybe<Scalars['String']['input']>;
  value: Scalars['String']['input'];
};


export type QueryPeerLinkArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPeopleArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
};


export type QueryPersonArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPersonDuplicatesArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  reasons?: InputMaybe<Array<Scalars['String']['input']>>;
};


export type QueryPlaceArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPlaceDuplicatesArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryPlaceForecastArgs = {
  horizonHours?: InputMaybe<Scalars['Int']['input']>;
  k?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryPlacesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
};


export type QueryPlacesContainingArgs = {
  latitude: Scalars['Float']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
  longitude: Scalars['Float']['input'];
};


export type QueryPlacesNearArgs = {
  latitude: Scalars['Float']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
  longitude: Scalars['Float']['input'];
  radiusMeters?: InputMaybe<Scalars['Float']['input']>;
};


export type QueryPlannedBlocksArgs = {
  from: Scalars['DateTime']['input'];
  to: Scalars['DateTime']['input'];
};


export type QueryPositionTrackArgs = {
  input?: InputMaybe<PositionTrackInput>;
};


export type QueryPositionTrackExtentArgs = {
  input?: InputMaybe<PositionTrackInput>;
};


export type QueryPredictionCalibrationArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryProductModelArgs = {
  id: Scalars['ID']['input'];
};


export type QueryProductModelsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  brand?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  isDigital?: InputMaybe<Scalars['Boolean']['input']>;
  productType?: InputMaybe<Scalars['String']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  subcategory?: InputMaybe<Scalars['String']['input']>;
};


export type QueryProviderArgs = {
  id: Scalars['ID']['input'];
};


export type QueryProvidersArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryQuestionArgs = {
  id: Scalars['ID']['input'];
};


export type QueryQuestionsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryReceiptArgs = {
  id: Scalars['ID']['input'];
};


export type QueryReceiptsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  extractionState?: InputMaybe<ReceiptExtractionState>;
  first?: InputMaybe<Scalars['Int']['input']>;
  merchantName?: InputMaybe<Scalars['String']['input']>;
  purchasedFrom?: InputMaybe<Scalars['DateTime']['input']>;
  purchasedTo?: InputMaybe<Scalars['DateTime']['input']>;
};


export type QueryRelationshipArgs = {
  id: Scalars['ID']['input'];
};


export type QueryRelationshipsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryReverseGeocodeArgs = {
  latitude: Scalars['Float']['input'];
  longitude: Scalars['Float']['input'];
};


export type QuerySavedSearchArgs = {
  id: Scalars['ID']['input'];
};


export type QuerySavedSearchesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  isSeed?: InputMaybe<Scalars['Boolean']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
};


export type QueryScheduleCandidatesArgs = {
  from: Scalars['DateTime']['input'];
  to: Scalars['DateTime']['input'];
};


export type QuerySearchArgs = {
  input: SearchInput;
};


export type QuerySharedSavedSearchArgs = {
  token: Scalars['String']['input'];
};


export type QuerySourceSystemsArgs = {
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  includeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
};


export type QuerySummariesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySummaryArgs = {
  id: Scalars['ID']['input'];
};


export type QueryTagArgs = {
  id: Scalars['ID']['input'];
};


export type QueryTagsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryTaskArgs = {
  id: Scalars['ID']['input'];
};


export type QueryTaskPendingChangesArgs = {
  taskId?: InputMaybe<Scalars['ID']['input']>;
};


export type QueryTasksArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
  parentId?: InputMaybe<Scalars['ID']['input']>;
  scheduledFor?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Array<TaskStatus>>;
};


export type QueryThreadArgs = {
  id: Scalars['ID']['input'];
};


export type QueryThreadsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryUnresolvedObservationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryWeekForecastArgs = {
  includeToday?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QuestionConnection = Connection & {
  __typename?: 'QuestionConnection';
  edges: Array<QuestionEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type QuestionEdge = Edge & {
  __typename?: 'QuestionEdge';
  cursor: Scalars['String']['output'];
  node: QuestionType;
};

export type QuestionType = Node & {
  __typename?: 'QuestionType';
  answerTier?: Maybe<Scalars['String']['output']>;
  category: Scalars['String']['output'];
  createdByLlm?: Maybe<Scalars['Boolean']['output']>;
  id: Scalars['ID']['output'];
  isSeedQuestion?: Maybe<Scalars['Boolean']['output']>;
  questionType?: Maybe<Scalars['String']['output']>;
  text: Scalars['String']['output'];
};

/** Where a candidate came from — the "because" behind a suggestion */
export type RationaleSourceType = {
  __typename?: 'RationaleSourceType';
  id: Scalars['ID']['output'];
  /** summary | insight | answer | item | relationship | due | action */
  kind: Scalars['String']['output'];
  note?: Maybe<Scalars['String']['output']>;
};

/** Where the purchase happened. */
export type ReceiptChannel =
  | 'APP'
  | 'IN_STORE'
  | 'ONLINE'
  | 'PHONE'
  | 'UNKNOWN';

export type ReceiptConnection = Connection & {
  __typename?: 'ReceiptConnection';
  edges: Array<ReceiptEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ReceiptEdge = Edge & {
  __typename?: 'ReceiptEdge';
  cursor: Scalars['String']['output'];
  node: ReceiptType;
};

/** How far structured extraction got on the receipt document. */
export type ReceiptExtractionState =
  | 'EXTRACTED'
  | 'FAILED'
  | 'MANUAL'
  | 'NOT_APPLICABLE'
  | 'PENDING';

export type ReceiptLineItemType = {
  __typename?: 'ReceiptLineItemType';
  brand?: Maybe<Scalars['String']['output']>;
  category?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  currency?: Maybe<Scalars['String']['output']>;
  description: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  /** False for ebooks, subscriptions and gift cards. Only physical lines mint owned units. */
  isPhysical: Scalars['Boolean']['output'];
  lineNumber: Scalars['Int']['output'];
  metadata: Scalars['JSON']['output'];
  mintedObjectId?: Maybe<Scalars['ID']['output']>;
  modelNumber?: Maybe<Scalars['String']['output']>;
  productId?: Maybe<Scalars['ID']['output']>;
  quantity: Scalars['Float']['output'];
  receiptId: Scalars['ID']['output'];
  /** Integer MINOR units of `currency`. */
  totalPriceMinor?: Maybe<Scalars['Int']['output']>;
  /** Integer MINOR units of `currency`. */
  unitPriceMinor?: Maybe<Scalars['Int']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type ReceiptType = Node & Taggable & {
  __typename?: 'ReceiptType';
  channel?: Maybe<ReceiptChannel>;
  createdAt: Scalars['DateTime']['output'];
  currency?: Maybe<Scalars['String']['output']>;
  /** Integer MINOR units of `currency`. */
  discountMinor?: Maybe<Scalars['Int']['output']>;
  documentContentId?: Maybe<Scalars['ID']['output']>;
  eventId?: Maybe<Scalars['ID']['output']>;
  extractionConfidence?: Maybe<Scalars['Float']['output']>;
  extractionError?: Maybe<Scalars['String']['output']>;
  extractionModel?: Maybe<Scalars['String']['output']>;
  extractionState: ReceiptExtractionState;
  id: Scalars['ID']['output'];
  lineItems: Array<ReceiptLineItemType>;
  merchantEntityId?: Maybe<Scalars['ID']['output']>;
  merchantName?: Maybe<Scalars['String']['output']>;
  metadata: Scalars['JSON']['output'];
  orderNumber?: Maybe<Scalars['String']['output']>;
  /** Last four digits only. A full card number is never stored. */
  paymentLast4?: Maybe<Scalars['String']['output']>;
  paymentMethod?: Maybe<Scalars['String']['output']>;
  placeEntityId?: Maybe<Scalars['ID']['output']>;
  purchasedAt?: Maybe<Scalars['DateTime']['output']>;
  /** Integer MINOR units of `currency`. */
  shippingMinor?: Maybe<Scalars['Int']['output']>;
  sourceFileId?: Maybe<Scalars['ID']['output']>;
  sourceId?: Maybe<Scalars['String']['output']>;
  sourceMessageId?: Maybe<Scalars['String']['output']>;
  sourceSystem?: Maybe<Scalars['String']['output']>;
  sourceType?: Maybe<Scalars['String']['output']>;
  /** Integer MINOR units of `currency`. */
  subtotalMinor?: Maybe<Scalars['Int']['output']>;
  tags: Array<EntityTagType>;
  /** Integer MINOR units of `currency`. */
  taxMinor?: Maybe<Scalars['Int']['output']>;
  /** Integer MINOR units of `currency`. */
  tipMinor?: Maybe<Scalars['Int']['output']>;
  /** Integer MINOR units of `currency`. */
  totalMinor?: Maybe<Scalars['Int']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type RelationshipConnection = Connection & {
  __typename?: 'RelationshipConnection';
  edges: Array<RelationshipEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type RelationshipEdge = Edge & {
  __typename?: 'RelationshipEdge';
  cursor: Scalars['String']['output'];
  node: RelationshipType;
};

export type RelationshipType = Node & {
  __typename?: 'RelationshipType';
  endDate?: Maybe<Scalars['DateTime']['output']>;
  fromNodeId: Scalars['ID']['output'];
  fromNodeType: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isBidirectional: Scalars['Boolean']['output'];
  properties?: Maybe<Scalars['JSON']['output']>;
  startDate?: Maybe<Scalars['DateTime']['output']>;
  strength?: Maybe<Scalars['Float']['output']>;
  toNodeId: Scalars['ID']['output'];
  toNodeType: Scalars['String']['output'];
  type: Scalars['String']['output'];
};

export type RemoveItemIdentifierInput = {
  itemId: Scalars['ID']['input'];
  namespace: ObjectIdentifierNamespace;
  scope?: InputMaybe<ObjectIdentifierScopeInput>;
  value: Scalars['String']['input'];
};

export type RemovePersonIdentifierInput = {
  kind: Scalars['String']['input'];
  personId: Scalars['ID']['input'];
  value: Scalars['String']['input'];
};

export type ResolveTaskPendingChangePayload = {
  __typename?: 'ResolveTaskPendingChangePayload';
  change?: Maybe<TaskPendingChangeType>;
  success: Scalars['Boolean']['output'];
  task?: Maybe<TaskType>;
};

export type RestoreByIdInput = {
  id: Scalars['String']['input'];
};

export type ReverseGeocodeResultType = {
  __typename?: 'ReverseGeocodeResultType';
  placeName?: Maybe<Scalars['String']['output']>;
  status: Scalars['String']['output'];
};

export type RunAskPayload = {
  __typename?: 'RunAskPayload';
  answer?: Maybe<AskAnswerType>;
  ask?: Maybe<AskType>;
  disclosedCount?: Maybe<Scalars['Int']['output']>;
  success: Scalars['Boolean']['output'];
  withheldCount?: Maybe<Scalars['Int']['output']>;
};

export type SavedSearchConnection = Connection & {
  __typename?: 'SavedSearchConnection';
  edges: Array<SavedSearchEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type SavedSearchEdge = Edge & {
  __typename?: 'SavedSearchEdge';
  cursor: Scalars['String']['output'];
  node: SavedSearchType;
};

export type SavedSearchFiltersInput = {
  connectors?: InputMaybe<Array<Scalars['String']['input']>>;
  datePreset?: InputMaybe<Scalars['String']['input']>;
  endTime?: InputMaybe<Scalars['String']['input']>;
  eventTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  hasLocation?: InputMaybe<Scalars['Boolean']['input']>;
  people?: InputMaybe<Array<Scalars['String']['input']>>;
  places?: InputMaybe<Array<Scalars['String']['input']>>;
  semantic?: InputMaybe<Scalars['Boolean']['input']>;
  sortBy?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['String']['input']>;
  startTime?: InputMaybe<Scalars['String']['input']>;
};

export type SavedSearchFiltersType = {
  __typename?: 'SavedSearchFiltersType';
  connectors?: Maybe<Array<Scalars['String']['output']>>;
  datePreset?: Maybe<Scalars['String']['output']>;
  endTime?: Maybe<Scalars['String']['output']>;
  eventTypes?: Maybe<Array<Scalars['String']['output']>>;
  hasLocation?: Maybe<Scalars['Boolean']['output']>;
  people?: Maybe<Array<Scalars['String']['output']>>;
  places?: Maybe<Array<Scalars['String']['output']>>;
  semantic?: Maybe<Scalars['Boolean']['output']>;
  sortBy?: Maybe<Scalars['String']['output']>;
  sortOrder?: Maybe<Scalars['String']['output']>;
  startTime?: Maybe<Scalars['String']['output']>;
};

export type SavedSearchType = Node & {
  __typename?: 'SavedSearchType';
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  entityTypes?: Maybe<Array<Scalars['String']['output']>>;
  filters?: Maybe<SavedSearchFiltersType>;
  id: Scalars['ID']['output'];
  isPublic: Scalars['Boolean']['output'];
  isSeed: Scalars['Boolean']['output'];
  name?: Maybe<Scalars['String']['output']>;
  query?: Maybe<Scalars['String']['output']>;
  shareExpiresAt?: Maybe<Scalars['DateTime']['output']>;
  shareMaxDisclosure?: Maybe<Scalars['String']['output']>;
  shareToken?: Maybe<Scalars['String']['output']>;
  tags?: Maybe<Array<Scalars['String']['output']>>;
  updatedAt: Scalars['DateTime']['output'];
};

/** A proposed activity — the "possible" layer of the schedule */
export type ScheduleCandidateType = {
  __typename?: 'ScheduleCandidateType';
  confidence?: Maybe<Scalars['Float']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  durationMinutes?: Maybe<Scalars['Int']['output']>;
  energyCost?: Maybe<Scalars['Int']['output']>;
  /** Best-slot score; null until the solver runs */
  fitScore?: Maybe<Scalars['Float']['output']>;
  generator?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  l0Class?: Maybe<Scalars['String']['output']>;
  /** Saved how-you'd-do-it compose for this card, when the user has personalized it */
  personalization?: Maybe<Scalars['JSON']['output']>;
  /** The sentence shown to the user. Never empty. */
  rationale: Scalars['String']['output'];
  rationaleSources: Array<RationaleSourceType>;
  status: Scalars['String']['output'];
  /** exact | day | week | month | season */
  timeFlex: Scalars['String']['output'];
  title: Scalars['String']['output'];
  windowEnd: Scalars['DateTime']['output'];
  windowStart: Scalars['DateTime']['output'];
};

export type ScheduleTaskPayload = {
  __typename?: 'ScheduleTaskPayload';
  event?: Maybe<EventType>;
  /** placed | proposed | already_placed | no_gap | skipped */
  status?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
  task?: Maybe<TaskType>;
};

export type SearchInput = {
  after?: InputMaybe<Scalars['String']['input']>;
  bbox?: InputMaybe<Array<Scalars['Float']['input']>>;
  connectors?: InputMaybe<Array<Scalars['String']['input']>>;
  endTime?: InputMaybe<Scalars['String']['input']>;
  eventTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  first?: InputMaybe<Scalars['Int']['input']>;
  hasLocation?: InputMaybe<Scalars['Boolean']['input']>;
  includeFiles?: InputMaybe<Scalars['Boolean']['input']>;
  includeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  people?: InputMaybe<Array<Scalars['String']['input']>>;
  places?: InputMaybe<Array<Scalars['String']['input']>>;
  query?: InputMaybe<Scalars['String']['input']>;
  semantic?: InputMaybe<Scalars['Boolean']['input']>;
  shareToken?: InputMaybe<Scalars['String']['input']>;
  sortBy?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['String']['input']>;
  startTime?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type SearchResultConnection = {
  __typename?: 'SearchResultConnection';
  edges: Array<SearchResultEdge>;
  matchingTags: Array<TagType>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type SearchResultEdge = {
  __typename?: 'SearchResultEdge';
  cursor: Scalars['String']['output'];
  node: SearchResultType;
};

export type SearchResultType = ActionType | AnswerType | BrowserActivityType | CommunicationType | ConceptType | ContentType | EventType | FileChunkType | FileType | ItemType | NoteType | PersonType | PlaceType | ProductModelType | ReceiptType | TaskType | ThreadType;

export type SendPeerAskInput = {
  archetype: Scalars['String']['input'];
  dataClass?: InputMaybe<Scalars['String']['input']>;
  from?: InputMaybe<Scalars['String']['input']>;
  handle: Scalars['String']['input'];
  minMinutes?: InputMaybe<Scalars['Int']['input']>;
  peerAccessToken: Scalars['String']['input'];
  prompt: Scalars['String']['input'];
  purpose?: InputMaybe<Scalars['String']['input']>;
  subject?: InputMaybe<Scalars['String']['input']>;
  to?: InputMaybe<Scalars['String']['input']>;
};

export type SendPeerAskPayload = {
  __typename?: 'SendPeerAskPayload';
  answer?: Maybe<AskAnswerType>;
  ask?: Maybe<AskType>;
  reason?: Maybe<Scalars['String']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type SetHouseholdTierInput = {
  memberId: Scalars['ID']['input'];
  /** One of: household, family, trusted, peer, stranger */
  trustTier: Scalars['String']['input'];
};

export type SetSavedSearchSharingInput = {
  expiresAt?: InputMaybe<Scalars['DateTime']['input']>;
  id: Scalars['ID']['input'];
  isPublic: Scalars['Boolean']['input'];
  maxDisclosure?: InputMaybe<Scalars['String']['input']>;
};

export type SummaryConnection = Connection & {
  __typename?: 'SummaryConnection';
  edges: Array<SummaryEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type SummaryEdge = Edge & {
  __typename?: 'SummaryEdge';
  cursor: Scalars['String']['output'];
  node: SummaryType;
};

export type SummaryType = Node & {
  __typename?: 'SummaryType';
  activityCounts: ActivityCountsType;
  anomalies: Array<Scalars['String']['output']>;
  confidenceScore?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  dailyRhythm?: Maybe<Array<Scalars['String']['output']>>;
  dismissed: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  insights: Array<InsightItemType>;
  keyAccomplishments?: Maybe<Array<Scalars['String']['output']>>;
  keyInsights: Array<Scalars['String']['output']>;
  moodIndicators?: Maybe<Array<Scalars['String']['output']>>;
  notableEvents: Array<Scalars['String']['output']>;
  periodEnd: Scalars['DateTime']['output'];
  periodStart: Scalars['DateTime']['output'];
  periodType: Scalars['String']['output'];
  productivityPatterns?: Maybe<Array<Scalars['String']['output']>>;
  seen: Scalars['Boolean']['output'];
  socialInteractions?: Maybe<Array<Scalars['String']['output']>>;
  sourceTypes: Array<Scalars['String']['output']>;
  summaryText: Scalars['String']['output'];
  tags: Array<Scalars['String']['output']>;
  timezone: Scalars['String']['output'];
  title?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type TagConnection = Connection & {
  __typename?: 'TagConnection';
  edges: Array<TagEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type TagEdge = Edge & {
  __typename?: 'TagEdge';
  cursor: Scalars['String']['output'];
  node: TagType;
};

export type TagEntitiesInput = {
  ids: Array<Scalars['ID']['input']>;
  labels: Array<Scalars['String']['input']>;
};

export type TagType = Node & {
  __typename?: 'TagType';
  description?: Maybe<Scalars['String']['output']>;
  entities: TaggableEntityConnection;
  entityCount: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  label: Scalars['String']['output'];
};


export type TagTypeEntitiesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};

export type Taggable = {
  tags: Array<EntityTagType>;
};

export type TaggableEntityConnection = {
  __typename?: 'TaggableEntityConnection';
  edges: Array<TaggableEntityEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type TaggableEntityEdge = {
  __typename?: 'TaggableEntityEdge';
  cursor: Scalars['String']['output'];
  node: TaggableEntityType;
};

export type TaggableEntityType = ActionType | BrowserActivityType | CommunicationType | ConceptType | ContentType | EventType | FileType | ItemType | NoteType | PersonType | PlaceType | ProductModelType | ReceiptType | TaskType | ThreadType;

export type TaskConnection = Connection & {
  __typename?: 'TaskConnection';
  edges: Array<TaskEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type TaskEdge = Edge & {
  __typename?: 'TaskEdge';
  cursor: Scalars['String']['output'];
  node: TaskType;
};

/** What automation wants to do to a task (or its planned event). */
export type TaskPendingChangeKind =
  | 'complete'
  | 'event_revise'
  | 'mutate'
  | 'schedule';

export type TaskPendingChangeStatus =
  | 'accepted'
  | 'declined'
  | 'pending';

export type TaskPendingChangeType = Node & {
  __typename?: 'TaskPendingChangeType';
  confidence?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  kind: TaskPendingChangeKind;
  patch: Scalars['JSON']['output'];
  rationale?: Maybe<Scalars['String']['output']>;
  resolvedAt?: Maybe<Scalars['DateTime']['output']>;
  status: TaskPendingChangeStatus;
  taskId: Scalars['ID']['output'];
};

/** Lifecycle state of a planning task. */
export type TaskStatus =
  | 'archived'
  | 'delegated'
  | 'done'
  | 'in_progress'
  | 'open'
  | 'proposed'
  | 'skipped';

export type TaskType = Node & Taggable & {
  __typename?: 'TaskType';
  actualMinutes: Scalars['Int']['output'];
  /** Direct children. Nesting is parent_id only — walk this field for a tree. */
  children: Array<TaskType>;
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  createdAt: Scalars['DateTime']['output'];
  /** How many times this task has been pushed to a later day. */
  deferCount: Scalars['Int']['output'];
  /** User-local calendar date, `YYYY-MM-DD`, before which the task stays hidden. */
  deferUntil?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  /** Deadline, as an instant. */
  dueAt?: Maybe<Scalars['DateTime']['output']>;
  estimatedMinutes?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  /** Parent task, for subtasks. */
  parentId?: Maybe<Scalars['ID']['output']>;
  /** True when a planned calendar block exists. `scheduledFor` alone is a preferred date, not a placement. */
  placedOnCalendar: Scalars['Boolean']['output'];
  /** 0 (highest) to 5 (lowest). Defaults to 3. */
  priority: Scalars['Int']['output'];
  /** User-local calendar date, `YYYY-MM-DD`. Not an instant. */
  scheduledFor?: Maybe<Scalars['String']['output']>;
  /** Where the task came from: `manual`, or an ingest source. */
  sourceKind: Scalars['String']['output'];
  status: TaskStatus;
  tags: Array<EntityTagType>;
  /** Wall-clock time of day, `HH:MM:SS`, in the user timezone. Zoneless by design. */
  taskTime?: Maybe<Scalars['String']['output']>;
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type ThreadConnection = Connection & {
  __typename?: 'ThreadConnection';
  edges: Array<ThreadEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ThreadEdge = Edge & {
  __typename?: 'ThreadEdge';
  cursor: Scalars['String']['output'];
  node: ThreadType;
};

export type ThreadType = Node & Taggable & {
  __typename?: 'ThreadType';
  description?: Maybe<Scalars['String']['output']>;
  generationStatus: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  messages: MessageConnection;
  name?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
};


export type ThreadTypeMessagesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};

export type UnfurlType = {
  __typename?: 'UnfurlType';
  authorName?: Maybe<Scalars['String']['output']>;
  authorUrl?: Maybe<Scalars['String']['output']>;
  canonicalUrl?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  durationSeconds?: Maybe<Scalars['Int']['output']>;
  externalRef?: Maybe<Scalars['String']['output']>;
  fetchedAt: Scalars['DateTime']['output'];
  payload: Scalars['JSON']['output'];
  resolver: Scalars['String']['output'];
  siteName?: Maybe<Scalars['String']['output']>;
  status: Scalars['String']['output'];
  thumbnailUrl?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export type UpdateAnswerInput = {
  answer: Scalars['String']['input'];
  id: Scalars['ID']['input'];
};

export type UpdateAskGrantInput = {
  clearExpiry?: InputMaybe<Scalars['Boolean']['input']>;
  dataClass?: InputMaybe<Scalars['String']['input']>;
  dataClasses?: InputMaybe<Array<Scalars['String']['input']>>;
  expiresAt?: InputMaybe<Scalars['DateTime']['input']>;
  maxDisclosure?: InputMaybe<DisclosureRung>;
  mode?: InputMaybe<GrantMode>;
  purpose?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateBrowserActivityInput = {
  id: Scalars['ID']['input'];
  title?: InputMaybe<Scalars['String']['input']>;
  url?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateCommunicationInput = {
  content?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  subject?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateConceptInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['String']['input'];
  name: Scalars['String']['input'];
};

export type UpdateConceptPayload = {
  __typename?: 'UpdateConceptPayload';
  concept?: Maybe<ConceptType>;
  success: Scalars['Boolean']['output'];
};

export type UpdateConnectionInput = {
  accessToken?: InputMaybe<Scalars['String']['input']>;
  active?: InputMaybe<Scalars['Boolean']['input']>;
  activeEndpoints?: InputMaybe<Array<Scalars['String']['input']>>;
  externalId?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  needsReauth?: InputMaybe<Scalars['Boolean']['input']>;
  refreshToken?: InputMaybe<Scalars['String']['input']>;
  schedule?: InputMaybe<Scalars['String']['input']>;
  syncState?: InputMaybe<Scalars['JSON']['input']>;
  tokenExpiry?: InputMaybe<Scalars['DateTime']['input']>;
};

export type UpdateConnectionPayload = {
  __typename?: 'UpdateConnectionPayload';
  connection?: Maybe<ConnectionType>;
  success: Scalars['Boolean']['output'];
};

export type UpdateConnectionSyncJobInput = {
  completedAt?: InputMaybe<Scalars['DateTime']['input']>;
  cursor?: InputMaybe<Scalars['JSON']['input']>;
  data?: InputMaybe<Scalars['JSON']['input']>;
  endpointName?: InputMaybe<Scalars['String']['input']>;
  error?: InputMaybe<Scalars['JSON']['input']>;
  id: Scalars['ID']['input'];
  jobId?: InputMaybe<Scalars['ID']['input']>;
  nextCursor?: InputMaybe<Scalars['JSON']['input']>;
  properties?: InputMaybe<Scalars['JSON']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateConnectionSyncJobPayload = {
  __typename?: 'UpdateConnectionSyncJobPayload';
  connectionSyncJob?: Maybe<ConnectionSyncJobType>;
  success: Scalars['Boolean']['output'];
};

export type UpdateContentInput = {
  externalId?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  mimetype?: InputMaybe<Scalars['String']['input']>;
  sourceData?: InputMaybe<Scalars['JSON']['input']>;
  sourceUrl?: InputMaybe<Scalars['String']['input']>;
  text?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<Scalars['String']['input']>;
  url?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateCurrentUserInput = {
  timezone?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateEventInput = {
  category?: InputMaybe<Scalars['String']['input']>;
  confidenceScore?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  durationMinutes?: InputMaybe<Scalars['Int']['input']>;
  endTime?: InputMaybe<Scalars['DateTime']['input']>;
  eventType?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isAllDay?: InputMaybe<Scalars['Boolean']['input']>;
  isRecurring?: InputMaybe<Scalars['Boolean']['input']>;
  locationCoordinates?: InputMaybe<Scalars['JSON']['input']>;
  locationEntityId?: InputMaybe<Scalars['ID']['input']>;
  locationName?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  organizerEntityId?: InputMaybe<Scalars['ID']['input']>;
  participantEntityIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  sourceId?: InputMaybe<Scalars['ID']['input']>;
  sourceSystem?: InputMaybe<Scalars['String']['input']>;
  sourceType?: InputMaybe<Scalars['String']['input']>;
  startTime?: InputMaybe<Scalars['DateTime']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateFileInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateItemInput = {
  /** When it was bought or received. */
  acquiredAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** Seller, giver or source, as free text. */
  acquiredFrom?: InputMaybe<Scalars['String']['input']>;
  acquisitionMethod?: InputMaybe<ItemAcquisitionMethod>;
  brand?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  /** Dominant colour as #rrggbb. */
  colorHex?: InputMaybe<Scalars['String']['input']>;
  /** Colour names, dominant first. */
  colors?: InputMaybe<Array<Scalars['String']['input']>>;
  /** {material: fraction} summing to at most 1. Percentages are accepted and converted. */
  composition?: InputMaybe<Scalars['JSON']['input']>;
  condition?: InputMaybe<ItemCondition>;
  currency?: InputMaybe<Scalars['String']['input']>;
  currentValue?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  /** Shorthand such as "12 x 8 x 2 in". Fills only the axes not given individually. */
  dimensions?: InputMaybe<Scalars['String']['input']>;
  /** When it stops being usable. Distinct from a warranty, which is a contract. */
  expiresAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** Height, in millimetres. */
  heightMm?: InputMaybe<Scalars['Float']['input']>;
  id: Scalars['ID']['input'];
  /** A digital item is refused a mass, a size and a volume. */
  isDigital?: InputMaybe<Scalars['Boolean']['input']>;
  /** Longest dimension, in millimetres. */
  lengthMm?: InputMaybe<Scalars['Float']['input']>;
  lifecycleState?: InputMaybe<ItemLifecycleState>;
  /** When the object was made, not when it was acquired. */
  manufacturedAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** As-owned mass, in grams. */
  massG?: InputMaybe<Scalars['Float']['input']>;
  /** What the object is made of. */
  materials?: InputMaybe<Array<Scalars['String']['input']>>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  purchasePrice?: InputMaybe<Scalars['Float']['input']>;
  subcategory?: InputMaybe<Scalars['String']['input']>;
  unitSystem?: InputMaybe<ItemUnitSystem>;
  /** Capacity — what it holds — in millilitres. */
  volumeMl?: InputMaybe<Scalars['Float']['input']>;
  /** Width, in millimetres. */
  widthMm?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateItemPayload = {
  __typename?: 'UpdateItemPayload';
  item?: Maybe<ItemType>;
  success: Scalars['Boolean']['output'];
};

export type UpdateKnownPlaceInput = {
  activeFrom?: InputMaybe<Scalars['String']['input']>;
  activeTo?: InputMaybe<Scalars['String']['input']>;
  aliases?: InputMaybe<Array<Scalars['String']['input']>>;
  confidence?: InputMaybe<Scalars['Float']['input']>;
  coordinates?: InputMaybe<KnownPlaceCoordinatesInput>;
  kind: Scalars['String']['input'];
  label: Scalars['String']['input'];
  locationId?: InputMaybe<Scalars['String']['input']>;
  source?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateNoteInput = {
  content?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['String']['input'];
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateNotePayload = {
  __typename?: 'UpdateNotePayload';
  note?: Maybe<NoteType>;
  success: Scalars['Boolean']['output'];
};

export type UpdatePeerLinkInput = {
  displayName?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  personEntityId?: InputMaybe<Scalars['ID']['input']>;
  trustTier?: InputMaybe<PeerTrustTier>;
};

export type UpdatePersonInput = {
  addresses?: InputMaybe<Array<PersonAddressInput>>;
  avatarUrl?: InputMaybe<Scalars['String']['input']>;
  birthDate?: InputMaybe<Scalars['String']['input']>;
  city?: InputMaybe<Scalars['String']['input']>;
  contacts?: InputMaybe<Array<PersonContactInput>>;
  country?: InputMaybe<Scalars['String']['input']>;
  department?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  firstName?: InputMaybe<Scalars['String']['input']>;
  gender?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['String']['input'];
  jobTitle?: InputMaybe<Scalars['String']['input']>;
  lastName?: InputMaybe<Scalars['String']['input']>;
  middleName?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  nickname?: InputMaybe<Scalars['String']['input']>;
  organization?: InputMaybe<Scalars['String']['input']>;
  postalCode?: InputMaybe<Scalars['String']['input']>;
  pronouns?: InputMaybe<Scalars['String']['input']>;
  region?: InputMaybe<Scalars['String']['input']>;
  streetAddress?: InputMaybe<Scalars['String']['input']>;
  streetAddress2?: InputMaybe<Scalars['String']['input']>;
  website?: InputMaybe<Scalars['String']['input']>;
};

export type UpdatePersonPayload = {
  __typename?: 'UpdatePersonPayload';
  person?: Maybe<PersonType>;
  success: Scalars['Boolean']['output'];
};

export type UpdatePlaceInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  estimated?: InputMaybe<Scalars['Boolean']['input']>;
  geoFormat?: InputMaybe<Scalars['String']['input']>;
  geolocation?: InputMaybe<Scalars['JSON']['input']>;
  id: Scalars['String']['input'];
  latitude?: InputMaybe<Scalars['Float']['input']>;
  locationBoundary?: InputMaybe<Scalars['JSON']['input']>;
  longitude?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  parentId?: InputMaybe<Scalars['String']['input']>;
  placeKind?: InputMaybe<Scalars['String']['input']>;
  properties?: InputMaybe<Scalars['JSON']['input']>;
  tracked?: InputMaybe<Scalars['Boolean']['input']>;
  type?: InputMaybe<Scalars['String']['input']>;
  uploaded?: InputMaybe<Scalars['Boolean']['input']>;
};

export type UpdateProviderKeyInput = {
  clientId?: InputMaybe<Scalars['String']['input']>;
  clientSecret?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateQuestionInput = {
  category: Scalars['String']['input'];
  id: Scalars['ID']['input'];
  text: Scalars['String']['input'];
};

export type UpdateRelationshipInput = {
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  id: Scalars['ID']['input'];
  isBidirectional?: InputMaybe<Scalars['Boolean']['input']>;
  properties?: InputMaybe<Scalars['JSON']['input']>;
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
  strength?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateRelationshipPayload = {
  __typename?: 'UpdateRelationshipPayload';
  relationship?: Maybe<RelationshipType>;
  success: Scalars['Boolean']['output'];
};

export type UpdateSavedSearchInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  entityTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  filters?: InputMaybe<SavedSearchFiltersInput>;
  id: Scalars['ID']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type UpdateSavedSearchPayload = {
  __typename?: 'UpdateSavedSearchPayload';
  savedSearch?: Maybe<SavedSearchType>;
  success: Scalars['Boolean']['output'];
};

export type UpdateTagInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  label?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateTagPayload = {
  __typename?: 'UpdateTagPayload';
  merged: Scalars['Boolean']['output'];
  movedEntityCount: Scalars['Int']['output'];
  success: Scalars['Boolean']['output'];
  tag?: Maybe<TagType>;
  updatedSavedSearchCount: Scalars['Int']['output'];
};

export type UpdateTaskInput = {
  actualMinutes?: InputMaybe<Scalars['Int']['input']>;
  /** User-local calendar date, `YYYY-MM-DD`. */
  deferUntil?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  dueAt?: InputMaybe<Scalars['DateTime']['input']>;
  estimatedMinutes?: InputMaybe<Scalars['Int']['input']>;
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  parentId?: InputMaybe<Scalars['ID']['input']>;
  priority?: InputMaybe<Scalars['Int']['input']>;
  /** User-local calendar date, `YYYY-MM-DD`. */
  scheduledFor?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<TaskStatus>;
  /** Wall-clock `HH:MM`, user timezone. Zoneless. */
  taskTime?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateTaskPayload = {
  __typename?: 'UpdateTaskPayload';
  success: Scalars['Boolean']['output'];
  task?: Maybe<TaskType>;
};

export type UserType = Node & {
  __typename?: 'UserType';
  avatarUrl?: Maybe<Scalars['String']['output']>;
  email: Scalars['String']['output'];
  entity?: Maybe<PersonType>;
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  needsIdentityStep: Scalars['Boolean']['output'];
  onboarded: Scalars['Boolean']['output'];
  timezone: Scalars['String']['output'];
};

/** One L1 cluster likely to occur on a forecast day */
export type WeekForecastClusterType = {
  __typename?: 'WeekForecastClusterType';
  clusterId: Scalars['String']['output'];
  /** Time-of-day tendency (night/morning/afternoon/evening shares) */
  daypartProbs: Array<ProbabilityEntryType>;
  /** Parent L0 behavioral class (WORK, EXERCISE, ...) */
  l0Class: Scalars['String']['output'];
  /** Human-readable cluster name (user-specific, discovered from behavior) */
  name: Scalars['String']['output'];
  /** Probability the cluster occurs at least once that day */
  pOccur: Scalars['Float']['output'];
  /** True when a booked calendar event pins this cell (known, not predicted) */
  scheduled: Scalars['Boolean']['output'];
};

/** Occurrence forecast for a single day of the week horizon */
export type WeekForecastDayType = {
  __typename?: 'WeekForecastDayType';
  clusters: Array<WeekForecastClusterType>;
  /** ISO date (UTC calendar day) */
  date: Scalars['String']['output'];
  /** Day-of-week name */
  dow: Scalars['String']['output'];
};

/** HBPE week-horizon occurrence forecast (event-level, not bucket occupancy) */
export type WeekForecastType = {
  __typename?: 'WeekForecastType';
  days: Array<WeekForecastDayType>;
  /** ISO-8601 timestamp when this forecast was generated */
  generatedAt: Scalars['String']['output'];
  horizon: Scalars['String']['output'];
};

export type GetFeedActionsQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
}>;


export type GetFeedActionsQuery = { __typename?: 'Query', feedActions: Array<{ __typename?: 'ActionType', id: string, title: string, text: string, imageUrl?: string | null, priority?: number | null, seen: boolean, dismissed: boolean, metadata: { __typename?: 'ActionMetadataType', seen: boolean, type?: string | null, context?: string | null, relatedPerson?: string | null }, thread?: { __typename?: 'ThreadType', id: string } | null }> };

export type MarkActionAsSeenMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type MarkActionAsSeenMutation = { __typename?: 'Mutation', markActionAsSeen?: { __typename?: 'ActionType', id: string, seen: boolean } | null };

export type MarkActionAsDismissedMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type MarkActionAsDismissedMutation = { __typename?: 'Mutation', markActionAsDismissed?: { __typename?: 'ActionType', id: string, dismissed: boolean } | null };

export type GetForecastQueryVariables = Exact<{
  horizon?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetForecastQuery = { __typename?: 'Query', forecast?: { __typename?: 'ForecastType', horizon: string, generatedAt: string, systemStatus: string, modelVersion?: string | null, stillLearning: boolean, pipelineEtaSeconds?: number | null, pipelineDetail?: string | null, buckets: Array<{ __typename?: 'ForecastBucketType', bucketIndex: number, startTime: string, q10: number, q50: number, q90: number, l0Probs: Array<{ __typename?: 'ProbabilityEntryType', label: string, probability: number }>, l1Probs: Array<{ __typename?: 'ProbabilityEntryType', label: string, probability: number }>, l2Probs?: Array<{ __typename?: 'ProbabilityEntryType', label: string, probability: number }> | null }> } | null };

export type RescheduleEventMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  startTime: Scalars['DateTime']['input'];
  endTime?: InputMaybe<Scalars['DateTime']['input']>;
}>;


export type RescheduleEventMutation = { __typename?: 'Mutation', rescheduleEvent?: { __typename?: 'EventType', id: string, title?: string | null, startTime: any, endTime?: any | null, externalSyncStatus?: string | null } | null };

export type GetScheduleCandidatesQueryVariables = Exact<{
  from: Scalars['DateTime']['input'];
  to: Scalars['DateTime']['input'];
}>;


export type GetScheduleCandidatesQuery = { __typename?: 'Query', scheduleCandidates: Array<{ __typename?: 'ScheduleCandidateType', id: string, title: string, description?: string | null, rationale: string, windowStart: any, windowEnd: any, timeFlex: string, durationMinutes?: number | null, l0Class?: string | null, fitScore?: number | null, status: string, generator?: string | null, confidence?: number | null, personalization?: any | null, rationaleSources: Array<{ __typename?: 'RationaleSourceType', kind: string, id: string, note?: string | null }> }> };

export type SyncScheduleSuggestionsMutationVariables = Exact<{ [key: string]: never; }>;


export type SyncScheduleSuggestionsMutation = { __typename?: 'Mutation', syncScheduleSuggestions: number };

export type AcceptCandidateMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  startTime: Scalars['DateTime']['input'];
  endTime?: InputMaybe<Scalars['DateTime']['input']>;
}>;


export type AcceptCandidateMutation = { __typename?: 'Mutation', acceptCandidate: { __typename?: 'EventType', id: string, title?: string | null, startTime: any, endTime?: any | null, status?: string | null } };

export type DeclineCandidateMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
}>;


export type DeclineCandidateMutation = { __typename?: 'Mutation', declineCandidate: { __typename?: 'ScheduleCandidateType', id: string, status: string } };

export type SnoozeCandidateMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  until: Scalars['DateTime']['input'];
}>;


export type SnoozeCandidateMutation = { __typename?: 'Mutation', snoozeCandidate: { __typename?: 'ScheduleCandidateType', id: string, status: string } };

export type BreakDownTasksMutationVariables = Exact<{
  text: Scalars['String']['input'];
}>;


export type BreakDownTasksMutation = { __typename?: 'Mutation', breakDownTasks: Array<{ __typename?: 'ScheduleCandidateType', id: string, title: string }> };

export type ReturnEventToSlateMutationVariables = Exact<{
  eventId: Scalars['ID']['input'];
}>;


export type ReturnEventToSlateMutation = { __typename?: 'Mutation', returnEventToSlate: { __typename?: 'ScheduleCandidateType', id: string, status: string } };

export type GetScheduleQueryVariables = Exact<{
  from: Scalars['DateTime']['input'];
  to: Scalars['DateTime']['input'];
}>;


export type GetScheduleQuery = { __typename?: 'Query', eventsInRange: Array<{ __typename?: 'EventType', id: string, title?: string | null, description?: string | null, startTime: any, endTime?: any | null, isAllDay?: boolean | null, status?: string | null, category?: string | null, locationName?: string | null, sourceSystem?: string | null, externalSyncStatus?: string | null, metadata?: any | null }>, weekForecast?: { __typename?: 'WeekForecastType', generatedAt: string, days: Array<{ __typename?: 'WeekForecastDayType', date: string, dow: string, clusters: Array<{ __typename?: 'WeekForecastClusterType', clusterId: string, name: string, l0Class: string, pOccur: number, scheduled: boolean, daypartProbs: Array<{ __typename?: 'ProbabilityEntryType', label: string, probability: number }> }> }> } | null };

export type TagEntitiesMutationVariables = Exact<{
  input: TagEntitiesInput;
}>;


export type TagEntitiesMutation = { __typename?: 'Mutation', tagEntities: Array<
    | { __typename?: 'ActionType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'BrowserActivityType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'CommunicationType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ConceptType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ContentType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'EventType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'FileType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ItemType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'NoteType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'PersonType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'PlaceType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ProductModelType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ReceiptType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'TaskType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ThreadType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
  > };

export type UntagEntitiesMutationVariables = Exact<{
  input: TagEntitiesInput;
}>;


export type UntagEntitiesMutation = { __typename?: 'Mutation', untagEntities: Array<
    | { __typename?: 'ActionType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'BrowserActivityType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'CommunicationType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ConceptType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ContentType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'EventType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'FileType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ItemType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'NoteType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'PersonType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'PlaceType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ProductModelType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ReceiptType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'TaskType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    | { __typename?: 'ThreadType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
  > };

export type TriggerHbpeMutationVariables = Exact<{ [key: string]: never; }>;


export type TriggerHbpeMutation = { __typename?: 'Mutation', triggerHbpe: string };

export type GetWeekAheadQueryVariables = Exact<{ [key: string]: never; }>;


export type GetWeekAheadQuery = { __typename?: 'Query', weekForecast?: { __typename?: 'WeekForecastType', horizon: string, generatedAt: string, days: Array<{ __typename?: 'WeekForecastDayType', date: string, dow: string, clusters: Array<{ __typename?: 'WeekForecastClusterType', clusterId: string, name: string, l0Class: string, pOccur: number, scheduled: boolean, daypartProbs: Array<{ __typename?: 'ProbabilityEntryType', label: string, probability: number }> }> }> } | null, dueForecast?: { __typename?: 'DueForecastType', generatedAt: string, due: Array<{ __typename?: 'DueItemType', clusterId: string, name: string, l0Class: string, lastSeen: string, daysSinceLast: number, medianIntervalDays: number, dueInDays: number, window: Array<number>, overdue: boolean, scheduledDate?: string | null, confidence: number }> } | null };

export type GetTagsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetTagsQuery = { __typename?: 'Query', tags: { __typename?: 'TagConnection', edges: Array<{ __typename?: 'TagEdge', node: { __typename?: 'TagType', id: string, label: string, description?: string | null } }> } };

export type WhatBarEventTypesQueryVariables = Exact<{ [key: string]: never; }>;


export type WhatBarEventTypesQuery = { __typename?: 'Query', eventTypes: Array<string> };

export type ReverseGeocodeQueryVariables = Exact<{
  latitude: Scalars['Float']['input'];
  longitude: Scalars['Float']['input'];
}>;


export type ReverseGeocodeQuery = { __typename?: 'Query', reverseGeocode: { __typename?: 'ReverseGeocodeResultType', status: string, placeName?: string | null } };

export type SourceSystemsQueryVariables = Exact<{
  includeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
}>;


export type SourceSystemsQuery = { __typename?: 'Query', sourceSystems: Array<string> };

export type EventTypesQueryVariables = Exact<{ [key: string]: never; }>;


export type EventTypesQuery = { __typename?: 'Query', eventTypes: Array<string> };

export type SearchResultCommunicationDataFragment = { __typename?: 'CommunicationType', id: string, preview?: string | null, time: any } & { ' $fragmentName'?: 'SearchResultCommunicationDataFragment' };

export type SearchResultConceptDataFragment = { __typename?: 'ConceptType', id: string, name?: string | null } & { ' $fragmentName'?: 'SearchResultConceptDataFragment' };

export type SearchResultContentDataFragment = { __typename?: 'ContentType', id: string, title?: string | null } & { ' $fragmentName'?: 'SearchResultContentDataFragment' };

export type SearchResultEventDataFragment = { __typename?: 'EventType', id: string, title?: string | null, startTime: any } & { ' $fragmentName'?: 'SearchResultEventDataFragment' };

export type SearchResultFileDataFragment = { __typename?: 'FileType', id: string, filename?: string | null, previewUrl?: string | null } & { ' $fragmentName'?: 'SearchResultFileDataFragment' };

export type SearchResultItemDataFragment = { __typename?: 'ItemType', id: string, name?: string | null } & { ' $fragmentName'?: 'SearchResultItemDataFragment' };

export type SearchResultNoteDataFragment = { __typename?: 'NoteType', id: string, title?: string | null } & { ' $fragmentName'?: 'SearchResultNoteDataFragment' };

export type SearchResultPersonDataFragment = { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'SearchResultPersonDataFragment' };

export type SearchResultPlaceDataFragment = { __typename?: 'PlaceType', id: string, name?: string | null } & { ' $fragmentName'?: 'SearchResultPlaceDataFragment' };

export type SearchResultThreadDataFragment = { __typename?: 'ThreadType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'SearchResultThreadDataFragment' };

export type SearchBoxQueryQueryVariables = Exact<{
  query: Scalars['String']['input'];
  includeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  semantic?: InputMaybe<Scalars['Boolean']['input']>;
}>;


export type SearchBoxQueryQuery = { __typename?: 'Query', search: { __typename?: 'SearchResultConnection', matchingTags: Array<{ __typename?: 'TagType', id: string, label: string }>, edges: Array<{ __typename?: 'SearchResultEdge', node:
        | { __typename: 'ActionType', id: string }
        | { __typename: 'AnswerType', id: string }
        | { __typename: 'BrowserActivityType', id: string }
        | (
          { __typename: 'CommunicationType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultCommunicationDataFragment': SearchResultCommunicationDataFragment } }
        )
        | (
          { __typename: 'ConceptType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultConceptDataFragment': SearchResultConceptDataFragment } }
        )
        | (
          { __typename: 'ContentType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultContentDataFragment': SearchResultContentDataFragment } }
        )
        | (
          { __typename: 'EventType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultEventDataFragment': SearchResultEventDataFragment } }
        )
        | { __typename: 'FileChunkType', id: string }
        | (
          { __typename: 'FileType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultFileDataFragment': SearchResultFileDataFragment } }
        )
        | (
          { __typename: 'ItemType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultItemDataFragment': SearchResultItemDataFragment } }
        )
        | (
          { __typename: 'NoteType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultNoteDataFragment': SearchResultNoteDataFragment } }
        )
        | (
          { __typename: 'PersonType', id: string, filterName?: string | null }
          & { ' $fragmentRefs'?: { 'SearchResultPersonDataFragment': SearchResultPersonDataFragment } }
        )
        | (
          { __typename: 'PlaceType', id: string, filterName?: string | null }
          & { ' $fragmentRefs'?: { 'SearchResultPlaceDataFragment': SearchResultPlaceDataFragment } }
        )
        | { __typename: 'ProductModelType', id: string }
        | { __typename: 'ReceiptType', id: string }
        | { __typename: 'TaskType', id: string }
        | (
          { __typename: 'ThreadType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultThreadDataFragment': SearchResultThreadDataFragment } }
        )
       }> } };

export type CreateEventMutationVariables = Exact<{
  input: CreateEventInput;
}>;


export type CreateEventMutation = { __typename?: 'Mutation', createEvent: { __typename?: 'EventType', id: string, title?: string | null, description?: string | null, startTime: any, endTime?: any | null, eventType?: string | null, locationName?: string | null } };

export type GetConnectionsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetConnectionsQuery = { __typename?: 'Query', connections: { __typename?: 'ConnectionConnection', totalCount: number, edges: Array<{ __typename?: 'ConnectionEdge', cursor: string, node: { __typename?: 'ConnectionType', id: string, name?: string | null, active: boolean, schedule?: string | null, tokenExpiry?: any | null, syncState?: any | null, activeEndpoints: Array<string>, providerId: string, needsReauth: boolean, externalId?: string | null, accountLabel?: string | null, provider: { __typename?: 'ProviderType', id: string, name?: string | null, localOnly: boolean, endpoints: Array<{ __typename?: 'ProviderEndpointType', name: string, description: string }> } } }>, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, hasPreviousPage: boolean, startCursor?: string | null, endCursor?: string | null } } };

export type GetConnectionsForOnboardingQueryVariables = Exact<{ [key: string]: never; }>;


export type GetConnectionsForOnboardingQuery = { __typename?: 'Query', connections: { __typename?: 'ConnectionConnection', edges: Array<{ __typename?: 'ConnectionEdge', node: { __typename?: 'ConnectionType', id: string, name?: string | null, active: boolean, needsReauth: boolean, providerId: string, syncState?: any | null } }> } };

export type ObjectIdentifierDataFragment = { __typename?: 'ObjectIdentifierType', namespace: ObjectIdentifierNamespace, value: string, rawValue?: string | null, qualifier: string, isPrimary: boolean, confidence: number, source?: string | null } & { ' $fragmentName'?: 'ObjectIdentifierDataFragment' };

export type AddItemIdentifierMutationVariables = Exact<{
  input: AddItemIdentifierInput;
}>;


export type AddItemIdentifierMutation = { __typename?: 'Mutation', addItemIdentifier: Array<(
    { __typename?: 'ObjectIdentifierType' }
    & { ' $fragmentRefs'?: { 'ObjectIdentifierDataFragment': ObjectIdentifierDataFragment } }
  )> };

export type RemoveItemIdentifierMutationVariables = Exact<{
  input: RemoveItemIdentifierInput;
}>;


export type RemoveItemIdentifierMutation = { __typename?: 'Mutation', removeItemIdentifier: Array<(
    { __typename?: 'ObjectIdentifierType' }
    & { ' $fragmentRefs'?: { 'ObjectIdentifierDataFragment': ObjectIdentifierDataFragment } }
  )> };

export type ObjectByIdentifierLookupQueryVariables = Exact<{
  namespace: ObjectIdentifierNamespace;
  value: Scalars['String']['input'];
}>;


export type ObjectByIdentifierLookupQuery = { __typename?: 'Query', objectByIdentifier: { __typename?: 'ObjectByIdentifierPayload', matched: boolean, namespace?: ObjectIdentifierNamespace | null, value?: string | null, subjectType?: ObjectIdentifierSubjectType | null, confidence?: number | null, item?: { __typename?: 'ItemType', id: string, name?: string | null, brand?: string | null, model?: string | null } | null, product?: { __typename?: 'ProductModelType', id: string, title: string, brand?: string | null } | null } };

export type MergeItemsFromIdentifierMutationVariables = Exact<{
  input: MergeItemsInput;
}>;


export type MergeItemsFromIdentifierMutation = { __typename?: 'Mutation', mergeItems: { __typename?: 'MergeItemsPayload', success: boolean, item?: { __typename?: 'ItemType', id: string, name?: string | null } | null } };

export type ObservationStripDataFragment = { __typename?: 'ObjectObservationType', id: string, label: string, labelSource?: ObservationLabelSource | null, detector?: string | null, detectorVersion?: string | null, detectionConfidence?: number | null, resolutionConfidence?: number | null, resolutionMethod: ObservationResolutionMethod, confirmedByUser: boolean, observedAt: any, sourceKind: ObservationSourceKind, placeEntityId?: string | null, bbox?: { __typename?: 'BoundingBoxType', x: number, y: number, w: number, h: number } | null, media?: { __typename?: 'ContentType', id: string, mimetype?: string | null, previewUrl?: string | null, mediaUrl?: string | null, url?: string | null } | null, place?: { __typename?: 'PlaceType', id: string, name?: string | null } | null } & { ' $fragmentName'?: 'ObservationStripDataFragment' };

export type ProductModelCardDataFragment = { __typename?: 'ProductModelType', id: string, title: string, brand?: string | null, manufacturer?: string | null, modelNumber?: string | null, category?: string | null, subcategory?: string | null, productType?: string | null, isDigital: boolean, msrpMinor?: number | null, currency?: string | null, identityConfidence: number, identifiers: Array<{ __typename?: 'ObjectIdentifierType', namespace: ObjectIdentifierNamespace, value: string, rawValue?: string | null }>, image?: { __typename?: 'ContentType', id: string, previewUrl?: string | null, mediaUrl?: string | null, url?: string | null } | null } & { ' $fragmentName'?: 'ProductModelCardDataFragment' };

export type ActionGridItemDataFragment = { __typename?: 'ActionType', id: string, actionTitle: string, actionText: string } & { ' $fragmentName'?: 'ActionGridItemDataFragment' };

export type AnswerGridItemDataFragment = { __typename?: 'AnswerType', id: string, answer: string, answerSource?: string | null, answerConfidence?: number | null, answerRationale?: string | null, answerEvidence?: any | null, question: { __typename?: 'QuestionType', id: string, text: string } } & { ' $fragmentName'?: 'AnswerGridItemDataFragment' };

export type BrowserActivityGridItemDataFragment = { __typename?: 'BrowserActivityType', id: string, title?: string | null, url: string } & { ' $fragmentName'?: 'BrowserActivityGridItemDataFragment' };

export type CommunicationGridItemDataFragment = { __typename?: 'CommunicationType', id: string, subject?: string | null, preview?: string | null, time: any, type: string, direction: string, from?: { __typename?: 'PersonType', id: string, name?: string | null } | null } & { ' $fragmentName'?: 'CommunicationGridItemDataFragment' };

export type ConceptGridItemDataFragment = { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'ConceptGridItemDataFragment' };

export type ContentGridItemDataFragment = (
  { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null, sourceUrl?: string | null, sourceType?: string | null, sourceSystem?: string | null, sourceId?: string | null, createdAt: any, mimetype?: string | null, mediaUrl?: string | null, mediaFilename?: string | null, mediaSize?: number | null, previewUrl?: string | null, contentUrl?: string | null }
  & { ' $fragmentRefs'?: { 'RichMediaDataFragment': RichMediaDataFragment } }
) & { ' $fragmentName'?: 'ContentGridItemDataFragment' };

export type EventGridItemDataFragment = { __typename?: 'EventType', id: string, title?: string | null, description?: string | null, startTime: any, eventType?: string | null, locationName?: string | null, sourceSystem?: string | null } & { ' $fragmentName'?: 'EventGridItemDataFragment' };

export type FileChunkGridItemDataFragment = { __typename?: 'FileChunkType', id: string, sectionTitle?: string | null, sourceLocator?: any | null, chunkContent: string, file?: { __typename?: 'FileType', id: string, filename?: string | null } | null } & { ' $fragmentName'?: 'FileChunkGridItemDataFragment' };

export type FileGridItemDataFragment = { __typename?: 'FileType', id: string, filename?: string | null, previewUrl?: string | null, contentType: string, sourceUrl?: string | null, title?: string | null, description?: string | null, size?: number | null, createdAt: any } & { ' $fragmentName'?: 'FileGridItemDataFragment' };

export type ItemGridItemDataFragment = { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, category?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null, currency: string, quantity: number, lifecycleState: ItemLifecycleState, lastSeenAt?: any | null, identifiers: Array<{ __typename?: 'ObjectIdentifierType', namespace: ObjectIdentifierNamespace, value: string, rawValue?: string | null }>, product?: { __typename?: 'ProductModelType', id: string, title: string, brand?: string | null } | null, file?: { __typename?: 'FileType', id: string, sourceUrl?: string | null } | null } & { ' $fragmentName'?: 'ItemGridItemDataFragment' };

export type NoteGridItemDataFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null, createdAt: any } & { ' $fragmentName'?: 'NoteGridItemDataFragment' };

export type PersonGridItemDataFragment = { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null, avatarUrl?: string | null, firstName?: string | null, lastName?: string | null, birthDate?: string | null } & { ' $fragmentName'?: 'PersonGridItemDataFragment' };

export type PlaceGridItemDataFragment = { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null, properties: any, latitude?: number | null, longitude?: number | null } & { ' $fragmentName'?: 'PlaceGridItemDataFragment' };

export type ProductGridItemDataFragment = { __typename?: 'ProductModelType', id: string, brand?: string | null, modelNumber?: string | null, category?: string | null, description?: string | null, isDigital: boolean, msrpMinor?: number | null, productTitle: string, productCurrency?: string | null } & { ' $fragmentName'?: 'ProductGridItemDataFragment' };

export type ReceiptGridItemDataFragment = { __typename?: 'ReceiptType', id: string, merchantName?: string | null, purchasedAt?: any | null, totalMinor?: number | null, orderNumber?: string | null, channel?: ReceiptChannel | null, extractionState: ReceiptExtractionState, receiptCurrency?: string | null, lineItems: Array<{ __typename?: 'ReceiptLineItemType', id: string }> } & { ' $fragmentName'?: 'ReceiptGridItemDataFragment' };

export type ThreadGridItemDataFragment = { __typename?: 'ThreadType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'ThreadGridItemDataFragment' };

export type GetItemQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetItemQuery = { __typename?: 'Query', item?: { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, category?: string | null, subcategory?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null, purchasePrice?: number | null, condition?: ItemCondition | null, quantity: number, lifecycleState: ItemLifecycleState, lastSeenAt?: any | null, identityConfidence: number, isDigital: boolean, acquiredAt?: any | null, acquisitionMethod?: ItemAcquisitionMethod | null, acquiredFrom?: string | null, manufacturedAt?: any | null, expiresAt?: any | null, lengthMm?: number | null, widthMm?: number | null, heightMm?: number | null, massG?: number | null, volumeMl?: number | null, unitSystem?: ItemUnitSystem | null, colors?: Array<string> | null, colorHex?: string | null, materials?: Array<string> | null, composition: any, currency: string, file?: { __typename?: 'FileType', id: string, sourceUrl?: string | null } | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }>, identifiers: Array<(
      { __typename?: 'ObjectIdentifierType' }
      & { ' $fragmentRefs'?: { 'ObjectIdentifierDataFragment': ObjectIdentifierDataFragment } }
    )>, product?: (
      { __typename?: 'ProductModelType' }
      & { ' $fragmentRefs'?: { 'ProductModelCardDataFragment': ProductModelCardDataFragment } }
    ) | null, observations: Array<(
      { __typename?: 'ObjectObservationType' }
      & { ' $fragmentRefs'?: { 'ObservationStripDataFragment': ObservationStripDataFragment } }
    )>, acquisition?: { __typename?: 'ReceiptLineItemType', id: string, receiptId: string, lineNumber: number, description: string, brand?: string | null, modelNumber?: string | null, quantity: number, unitPriceMinor?: number | null, totalPriceMinor?: number | null, currency?: string | null, isPhysical: boolean } | null } | null };

export type CreateConceptMutationVariables = Exact<{
  input: CreateConceptInput;
}>;


export type CreateConceptMutation = { __typename?: 'Mutation', createConcept: { __typename?: 'CreateConceptPayload', success: boolean, concept?: { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null } | null } };

export type CreatePersonMutationVariables = Exact<{
  input: CreatePersonInput;
}>;


export type CreatePersonMutation = { __typename?: 'Mutation', createPerson: { __typename?: 'CreatePersonPayload', success: boolean, person?: { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null } | null } };

export type CreatePlaceMutationVariables = Exact<{
  input: CreatePlaceInput;
}>;


export type CreatePlaceMutation = { __typename?: 'Mutation', createPlace: { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null, placeKind?: string | null, latitude?: number | null, longitude?: number | null } };

export type CreateRelationshipMutationVariables = Exact<{
  input: CreateRelationshipInput;
}>;


export type CreateRelationshipMutation = { __typename?: 'Mutation', createRelationship: { __typename?: 'CreateRelationshipPayload', success: boolean, relationship?: { __typename?: 'RelationshipType', id: string, fromNodeId: string, fromNodeType: string, toNodeId: string, toNodeType: string, type: string, properties?: any | null, isBidirectional: boolean, startDate?: any | null, endDate?: any | null } | null } };

export type GetPersonForEditQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetPersonForEditQuery = { __typename?: 'Query', person?: (
    { __typename?: 'PersonType' }
    & { ' $fragmentRefs'?: { 'PersonEditorFieldsFragment': PersonEditorFieldsFragment } }
  ) | null };

export type UpdatePersonProfileMutationVariables = Exact<{
  input: UpdatePersonInput;
}>;


export type UpdatePersonProfileMutation = { __typename?: 'Mutation', updatePerson: { __typename?: 'UpdatePersonPayload', success: boolean, person?: (
      { __typename?: 'PersonType' }
      & { ' $fragmentRefs'?: { 'PersonEditorFieldsFragment': PersonEditorFieldsFragment } }
    ) | null } };

export type PersonEditorFieldsFragment = { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null, firstName?: string | null, middleName?: string | null, lastName?: string | null, nickname?: string | null, pronouns?: string | null, gender?: string | null, birthDate?: string | null, jobTitle?: string | null, organization?: string | null, department?: string | null, website?: string | null, avatarUrl?: string | null, addresses: Array<{ __typename?: 'PersonAddressType', label?: string | null, streetAddress?: string | null, streetAddress2?: string | null, city?: string | null, region?: string | null, postalCode?: string | null, country?: string | null, isPrimary: boolean, formatted?: string | null }>, identifiers: Array<{ __typename?: 'PersonIdentifierType', kind: string, value: string, rawValue?: string | null, label?: string | null, isPrimary: boolean }> } & { ' $fragmentName'?: 'PersonEditorFieldsFragment' };

export type ScanObjectByIdentifierQueryVariables = Exact<{
  namespace: ObjectIdentifierNamespace;
  value: Scalars['String']['input'];
}>;


export type ScanObjectByIdentifierQuery = { __typename?: 'Query', objectByIdentifier: { __typename?: 'ObjectByIdentifierPayload', matched: boolean, namespace?: ObjectIdentifierNamespace | null, value?: string | null, subjectType?: ObjectIdentifierSubjectType | null, confidence?: number | null, item?: { __typename?: 'ItemType', id: string, name?: string | null, brand?: string | null, model?: string | null } | null, product?: { __typename?: 'ProductModelType', id: string, title: string, brand?: string | null } | null } };

export type CreateItemMutationVariables = Exact<{
  input: CreateItemInput;
}>;


export type CreateItemMutation = { __typename?: 'Mutation', createItem: { __typename?: 'CreateItemPayload', success: boolean, item?: { __typename?: 'ItemType', id: string, name?: string | null, category?: string | null, description?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null, purchasePrice?: number | null, condition?: ItemCondition | null, lifecycleState: ItemLifecycleState, quantity: number, acquiredAt?: any | null, acquisitionMethod?: ItemAcquisitionMethod | null, acquiredFrom?: string | null, manufacturedAt?: any | null, expiresAt?: any | null, lengthMm?: number | null, widthMm?: number | null, heightMm?: number | null, massG?: number | null, volumeMl?: number | null, unitSystem?: ItemUnitSystem | null, colors?: Array<string> | null, colorHex?: string | null, materials?: Array<string> | null, composition: any, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null } };

export type UpdateItemMutationVariables = Exact<{
  input: UpdateItemInput;
}>;


export type UpdateItemMutation = { __typename?: 'Mutation', updateItem: { __typename?: 'UpdateItemPayload', success: boolean, item?: { __typename?: 'ItemType', id: string, name?: string | null, category?: string | null, description?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null, purchasePrice?: number | null, condition?: ItemCondition | null, lifecycleState: ItemLifecycleState, quantity: number, acquiredAt?: any | null, acquisitionMethod?: ItemAcquisitionMethod | null, acquiredFrom?: string | null, manufacturedAt?: any | null, expiresAt?: any | null, lengthMm?: number | null, widthMm?: number | null, heightMm?: number | null, massG?: number | null, volumeMl?: number | null, unitSystem?: ItemUnitSystem | null, colors?: Array<string> | null, colorHex?: string | null, materials?: Array<string> | null, composition: any, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null } };

export type GetUserDataQueryVariables = Exact<{ [key: string]: never; }>;


export type GetUserDataQuery = { __typename?: 'Query', me?: { __typename?: 'UserType', id: string, name: string, email: string, onboarded: boolean, needsIdentityStep: boolean, timezone: string, avatarUrl?: string | null, entity?: { __typename?: 'PersonType', id: string } | null } | null };

export type FeedBadgeActionFragment = { __typename?: 'ActionType', id: string, seen: boolean, dismissed: boolean } & { ' $fragmentName'?: 'FeedBadgeActionFragment' };

export type FeedBadgeSummaryFragment = { __typename?: 'SummaryType', id: string, seen: boolean, dismissed: boolean } & { ' $fragmentName'?: 'FeedBadgeSummaryFragment' };

export type GetFeedBadgeCountQueryVariables = Exact<{
  actionLimit?: InputMaybe<Scalars['Int']['input']>;
  summaryFirst?: InputMaybe<Scalars['Int']['input']>;
}>;


export type GetFeedBadgeCountQuery = { __typename?: 'Query', feedActions: Array<(
    { __typename?: 'ActionType' }
    & { ' $fragmentRefs'?: { 'FeedBadgeActionFragment': FeedBadgeActionFragment } }
  )>, summaries: { __typename?: 'SummaryConnection', edges: Array<{ __typename?: 'SummaryEdge', node: (
        { __typename?: 'SummaryType' }
        & { ' $fragmentRefs'?: { 'FeedBadgeSummaryFragment': FeedBadgeSummaryFragment } }
      ) }> } };

export type GetPlanBadgeCountQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
}>;


export type GetPlanBadgeCountQuery = { __typename?: 'Query', tasks: { __typename?: 'TaskConnection', edges: Array<{ __typename?: 'TaskEdge', node: { __typename?: 'TaskType', id: string, status: TaskStatus } }> }, taskPendingChanges: Array<{ __typename?: 'TaskPendingChangeType', taskId: string }> };

export type AskInboxQueryVariables = Exact<{ [key: string]: never; }>;


export type AskInboxQuery = { __typename?: 'Query', askInbox: Array<{ __typename?: 'AskType', id: string, status: AskStatus, createdAt: any, consentBasis?: string | null, askerId?: string | null, peerHandle?: string | null, query: { __typename?: 'AskQueryType', queryType: string, dataClass?: string | null, prompt: string, purpose?: string | null, actor?: { __typename?: 'AskActorType', kind: string, label?: string | null } | null } }> };

export type AskOutboxQueryVariables = Exact<{ [key: string]: never; }>;


export type AskOutboxQuery = { __typename?: 'Query', askOutbox: Array<{ __typename?: 'AskType', id: string, status: AskStatus, createdAt: any, responderId?: string | null, peerHandle?: string | null, query: { __typename?: 'AskQueryType', queryType: string, dataClass?: string | null, prompt: string, purpose?: string | null, actor?: { __typename?: 'AskActorType', kind: string, label?: string | null } | null } }> };

export type MyAskGrantsQueryVariables = Exact<{ [key: string]: never; }>;


export type MyAskGrantsQuery = { __typename?: 'Query', myAskGrants: Array<{ __typename?: 'AskGrantType', id: string, mode: GrantMode, queryType: string, dataClass?: string | null, purpose?: string | null, granteeId?: string | null, granteePeerLinkId?: string | null, revokedAt?: any | null, expiresAt?: any | null, active: boolean, useCount: number, lastUsedAt?: any | null, createdAt: any }> };

export type ApproveAskMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type ApproveAskMutation = { __typename?: 'Mutation', approveAsk: { __typename?: 'AskPayload', success: boolean } };

export type DeclineAskMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type DeclineAskMutation = { __typename?: 'Mutation', declineAsk: { __typename?: 'AskPayload', success: boolean } };

export type RunAskMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  redactItemIds?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  disclosureForm?: InputMaybe<AnswerForm>;
}>;


export type RunAskMutation = { __typename?: 'Mutation', runAsk: { __typename?: 'RunAskPayload', success: boolean, disclosedCount?: number | null, withheldCount?: number | null } };

export type MyAskAddressQueryVariables = Exact<{ [key: string]: never; }>;


export type MyAskAddressQuery = { __typename?: 'Query', me?: { __typename?: 'UserType', id: string } | null };

export type CreateAskGrantMutationVariables = Exact<{
  input: CreateAskGrantInput;
}>;


export type CreateAskGrantMutation = { __typename?: 'Mutation', createAskGrant: { __typename?: 'AskGrantPayload', success: boolean, grant?: { __typename?: 'AskGrantType', id: string, mode: GrantMode, queryType: string, dataClass?: string | null, purpose?: string | null, granteeId?: string | null, granteePeerLinkId?: string | null, revokedAt?: any | null, expiresAt?: any | null, active: boolean, createdAt: any } | null } };

export type RevokeAskGrantMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type RevokeAskGrantMutation = { __typename?: 'Mutation', revokeAskGrant: { __typename?: 'AskGrantPayload', success: boolean } };

export type UpdateAskGrantMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  input: UpdateAskGrantInput;
}>;


export type UpdateAskGrantMutation = { __typename?: 'Mutation', updateAskGrant: { __typename?: 'AskGrantPayload', success: boolean, grant?: { __typename?: 'AskGrantType', id: string, mode: GrantMode, expiresAt?: any | null, active: boolean, revokedAt?: any | null, supersedesGrantId?: string | null } | null } };

export type AskDisclosureHistoryQueryVariables = Exact<{
  input?: InputMaybe<AskDisclosureHistoryInput>;
}>;


export type AskDisclosureHistoryQuery = { __typename?: 'Query', askDisclosureHistory: { __typename?: 'AskDisclosureHistoryPayload', truncated: boolean, rows: Array<{ __typename?: 'AskAuditType', id: string, askId?: string | null, askerId?: string | null, peerHandle?: string | null, responderId?: string | null, consentBasis?: string | null, outcome: AskAuditOutcome, disclosedCount: number, createdAt: any, query: { __typename?: 'AskQueryType', queryType: string, dataClass?: string | null, prompt: string, purpose?: string | null, actor?: { __typename?: 'AskActorType', kind: string, label?: string | null } | null } }> } };

export type AskDisclosureSummaryQueryVariables = Exact<{
  input?: InputMaybe<AskDisclosureSummaryInput>;
}>;


export type AskDisclosureSummaryQuery = { __typename?: 'Query', askDisclosureSummary: { __typename?: 'AskDisclosureSummaryPayload', truncated: boolean, summaries: Array<{ __typename?: 'AskDisclosureSummaryType', key: string, askerId?: string | null, peerLinkId?: string | null, peerHandle?: string | null, total: number, autoAnswered: number, reviewed: number, declined: number, expired: number, itemsDisclosed: number, asksInWindow: number, itemsInWindow: number, firstAt: any, lastAt: any }> } };

export type AskAnswerQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type AskAnswerQuery = { __typename?: 'Query', askAnswer?: { __typename?: 'AskAnswerType', id: string, askId: string, form: AnswerForm, answerSource: AnswerSource, summary?: string | null, disclosedCount: number, withheldCount: number, consentBasis?: string | null, createdAt: any, items: Array<{ __typename?: 'DisclosedItemType', id: string, type: string }> } | null };

export type CreateAskMutationVariables = Exact<{
  input: CreateAskInput;
}>;


export type CreateAskMutation = { __typename?: 'Mutation', createAsk: { __typename?: 'CreateAskPayload', success: boolean, ask?: { __typename?: 'AskType', id: string, status: AskStatus, createdAt: any, responderId?: string | null, peerHandle?: string | null, query: { __typename?: 'AskQueryType', queryType: string, dataClass?: string | null, prompt: string, purpose?: string | null, actor?: { __typename?: 'AskActorType', kind: string, label?: string | null } | null } } | null } };

export type MyPeerLinksQueryVariables = Exact<{ [key: string]: never; }>;


export type MyPeerLinksQuery = { __typename?: 'Query', myPeerLinks: Array<{ __typename?: 'PeerLinkType', id: string, peerHandle: string, displayName?: string | null, memoryEndpoint: string, personEntityId?: string | null, avatarUrl?: string | null, trustTier: PeerTrustTier, status: PeerLinkStatus, revokedAt?: any | null, createdAt: any }> };

export type CreatePeerLinkMutationVariables = Exact<{
  input: CreatePeerLinkInput;
}>;


export type CreatePeerLinkMutation = { __typename?: 'Mutation', createPeerLink: { __typename?: 'PeerLinkPayload', success: boolean, peerLink?: { __typename?: 'PeerLinkType', id: string, peerHandle: string, displayName?: string | null, memoryEndpoint: string, avatarUrl?: string | null, trustTier: PeerTrustTier, status: PeerLinkStatus, revokedAt?: any | null } | null } };

export type UpdatePeerLinkMutationVariables = Exact<{
  input: UpdatePeerLinkInput;
}>;


export type UpdatePeerLinkMutation = { __typename?: 'Mutation', updatePeerLink: { __typename?: 'PeerLinkPayload', success: boolean, peerLink?: { __typename?: 'PeerLinkType', id: string, peerHandle: string, displayName?: string | null, memoryEndpoint: string, avatarUrl?: string | null, trustTier: PeerTrustTier, status: PeerLinkStatus, revokedAt?: any | null } | null } };

export type RevokePeerLinkMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type RevokePeerLinkMutation = { __typename?: 'Mutation', revokePeerLink: { __typename?: 'PeerLinkPayload', success: boolean, peerLink?: { __typename?: 'PeerLinkType', id: string, peerHandle: string, avatarUrl?: string | null, trustTier: PeerTrustTier, status: PeerLinkStatus, revokedAt?: any | null } | null } };

export type SetHouseholdTierMutationVariables = Exact<{
  input: SetHouseholdTierInput;
}>;


export type SetHouseholdTierMutation = { __typename?: 'Mutation', setHouseholdTier: { __typename?: 'HouseholdTierType', id: string, memberId: string, trustTier: string, updatedAt: any } };

export type MyHouseholdTiersQueryVariables = Exact<{ [key: string]: never; }>;


export type MyHouseholdTiersQuery = { __typename?: 'Query', myHouseholdTiers: Array<{ __typename?: 'HouseholdTierType', id: string, memberId: string, trustTier: string, updatedAt: any }> };

export type GetCommunicationQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetCommunicationQuery = { __typename?: 'Query', communication?: { __typename?: 'CommunicationType', id: string, type: string, subject?: string | null, preview?: string | null, content: string, time: any, direction: string, from?: { __typename?: 'PersonType', id: string, name?: string | null } | null, to: { __typename?: 'PersonConnection', edges: Array<{ __typename?: 'PersonEdge', node: { __typename?: 'PersonType', id: string, name?: string | null } }> }, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null };

export type UpdateCommunicationPageFieldsMutationVariables = Exact<{
  input: UpdateCommunicationInput;
}>;


export type UpdateCommunicationPageFieldsMutation = { __typename?: 'Mutation', updateCommunication?: { __typename?: 'CommunicationType', id: string, subject?: string | null, content: string } | null };

export type GetConceptQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetConceptQuery = { __typename?: 'Query', concept?: { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null };

export type UpdateConceptDescriptionMutationVariables = Exact<{
  input: UpdateConceptInput;
}>;


export type UpdateConceptDescriptionMutation = { __typename?: 'Mutation', updateConcept: { __typename?: 'UpdateConceptPayload', success: boolean, concept?: { __typename?: 'ConceptType', id: string, description?: string | null } | null } };

export type GetConnectionQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetConnectionQuery = { __typename?: 'Query', connection?: { __typename?: 'ConnectionType', id: string, name?: string | null, active: boolean, schedule?: string | null, tokenExpiry?: any | null, syncState?: any | null, activeEndpoints: Array<string>, providerId: string, needsReauth: boolean, externalId?: string | null, accountLabel?: string | null, provider: { __typename?: 'ProviderType', id: string, name?: string | null, authType?: string | null, endpoints: Array<{ __typename?: 'ProviderEndpointType', name: string, description: string, iterationType: string, TTL?: number | null }> } } | null };

export type UpdateConnectionMutationVariables = Exact<{
  input: UpdateConnectionInput;
}>;


export type UpdateConnectionMutation = { __typename?: 'Mutation', updateConnection: { __typename?: 'UpdateConnectionPayload', success: boolean, connection?: { __typename?: 'ConnectionType', id: string, name?: string | null, active: boolean, schedule?: string | null, tokenExpiry?: any | null, syncState?: any | null, activeEndpoints: Array<string>, providerId: string, needsReauth: boolean, externalId?: string | null, accountLabel?: string | null, provider: { __typename?: 'ProviderType', id: string, name?: string | null, authType?: string | null, endpoints: Array<{ __typename?: 'ProviderEndpointType', name: string, description: string, iterationType: string, TTL?: number | null }> } } | null } };

export type DeleteConnectionMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteConnectionMutation = { __typename?: 'Mutation', deleteConnection: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type GetConnectionSyncJobsQueryVariables = Exact<{
  connectionId: Scalars['ID']['input'];
  endpointName?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
}>;


export type GetConnectionSyncJobsQuery = { __typename?: 'Query', connectionSyncJobs: { __typename?: 'ConnectionSyncJobConnection', totalCount: number, edges: Array<{ __typename?: 'ConnectionSyncJobEdge', cursor: string, node: { __typename?: 'ConnectionSyncJobType', id: string, cursor?: any | null, endpointName: string, nextCursor?: any | null, connectionId: string, status: string, type: string, createdAt: any, updatedAt: any, completedAt?: any | null, error?: any | null } }>, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, hasPreviousPage: boolean, startCursor?: string | null, endCursor?: string | null } } };

export type GetContentFacetsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetContentFacetsQuery = { __typename?: 'Query', contentFacets: { __typename?: 'ContentFacets', types: Array<string>, mimetypes: Array<string>, sourceSystems: Array<string> } };

export type GetContentsQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  types?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  mimetypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  connectors?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
}>;


export type GetContentsQuery = { __typename?: 'Query', contents: { __typename?: 'ContentConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'ContentEdge', cursor: string, node: (
        { __typename?: 'ContentType', id: string }
        & { ' $fragmentRefs'?: { 'ContentTileFragmentFragment': ContentTileFragmentFragment } }
      ) }> } };

export type GetContentSheetQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetContentSheetQuery = { __typename?: 'Query', content?: (
    { __typename: 'ContentType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    & { ' $fragmentRefs'?: { 'ContentGridItemDataFragment': ContentGridItemDataFragment;'TableContentRowDataFragment': TableContentRowDataFragment } }
  ) | null };

export type ContentTileFragmentFragment = (
  { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null, mimetype?: string | null, sourceUrl?: string | null, previewUrl?: string | null, mediaUrl?: string | null, contentUrl?: string | null }
  & { ' $fragmentRefs'?: { 'RichMediaDataFragment': RichMediaDataFragment } }
) & { ' $fragmentName'?: 'ContentTileFragmentFragment' };

export type GetContentQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetContentQuery = { __typename?: 'Query', content?: (
    { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null, mimetype?: string | null, sourceUrl?: string | null, mediaUrl?: string | null, previewUrl?: string | null, contentUrl?: string | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    & { ' $fragmentRefs'?: { 'RichMediaDataFragment': RichMediaDataFragment } }
  ) | null };

export type UpdateContentPageFieldsMutationVariables = Exact<{
  input: UpdateContentInput;
}>;


export type UpdateContentPageFieldsMutation = { __typename?: 'Mutation', updateContent?: { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null } | null };

export type EventContentTileFragment = (
  { __typename?: 'ContentType', id: string, title?: string | null, mimetype?: string | null, sourceUrl?: string | null, previewUrl?: string | null, mediaUrl?: string | null, contentUrl?: string | null }
  & { ' $fragmentRefs'?: { 'RichMediaDataFragment': RichMediaDataFragment } }
) & { ' $fragmentName'?: 'EventContentTileFragment' };

export type GetEventQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetEventQuery = { __typename?: 'Query', event?: { __typename?: 'EventType', id: string, title?: string | null, description?: string | null, startTime: any, endTime?: any | null, eventType?: string | null, sourceSystem?: string | null, mediaContentType?: string | null, mediaUrl?: string | null, previewUrl?: string | null, contents: { __typename?: 'ContentConnection', edges: Array<{ __typename?: 'ContentEdge', node: (
          { __typename?: 'ContentType', id: string }
          & { ' $fragmentRefs'?: { 'EventContentTileFragment': EventContentTileFragment } }
        ) }> }, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }>, location?: { __typename?: 'PlaceType', id: string, name?: string | null, properties: any } | null, organizer?: { __typename?: 'PersonType', id: string, name?: string | null } | null, participants: { __typename?: 'PersonConnection', edges: Array<{ __typename?: 'PersonEdge', node: { __typename?: 'PersonType', id: string, name?: string | null } }> } } | null };

export type UpdateEventPageFieldsMutationVariables = Exact<{
  input: UpdateEventInput;
}>;


export type UpdateEventPageFieldsMutation = { __typename?: 'Mutation', updateEvent?: { __typename?: 'EventType', id: string, title?: string | null, description?: string | null } | null };

export type InsightCardDataFragment = { __typename?: 'InsightItemType', title: string, summaryText: string, keyActions: Array<string>, relevanceScore: number, tags: Array<string>, relatedEntityIds?: Array<string> | null } & { ' $fragmentName'?: 'InsightCardDataFragment' };

export type SummaryCardDataFragment = { __typename?: 'SummaryType', id: string, title?: string | null, periodType: string, seen: boolean, summaryText: string, keyInsights: Array<string>, tags: Array<string>, activityCounts: { __typename?: 'ActivityCountsType', total: number } } & { ' $fragmentName'?: 'SummaryCardDataFragment' };

export type GetSummariesQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
}>;


export type GetSummariesQuery = { __typename?: 'Query', summaries: { __typename?: 'SummaryConnection', totalCount: number, edges: Array<{ __typename?: 'SummaryEdge', node: { __typename?: 'SummaryType', id: string, title?: string | null, periodType: string, seen: boolean, dismissed: boolean, summaryText: string, keyInsights: Array<string>, tags: Array<string>, activityCounts: { __typename?: 'ActivityCountsType', total: number }, insights: Array<{ __typename?: 'InsightItemType', title: string, summaryText: string, keyActions: Array<string>, relevanceScore: number, tags: Array<string>, relatedEntityIds?: Array<string> | null }> } }>, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean } } };

export type MarkSummaryAsSeenMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type MarkSummaryAsSeenMutation = { __typename?: 'Mutation', markSummaryAsSeen?: { __typename?: 'SummaryType', id: string, seen: boolean } | null };

export type MarkSummaryAsDismissedMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type MarkSummaryAsDismissedMutation = { __typename?: 'Mutation', markSummaryAsDismissed?: { __typename?: 'SummaryType', id: string, dismissed: boolean } | null };

export type GetForecastExtrasQueryVariables = Exact<{ [key: string]: never; }>;


export type GetForecastExtrasQuery = { __typename?: 'Query', placeForecast: Array<{ __typename?: 'PlaceForecastItemType', lat: number, lng: number, visits: number, share: number, label?: string | null, probability: number, backoffLevel?: string | null }>, predictionCalibration?: { __typename?: 'PredictionCalibrationType', basis: string, latest?: { __typename?: 'CalibrationScoreType', driftFlag: boolean } | null } | null, forecastHistory: Array<{ __typename?: 'ForecastHistoryDayType', date: string, buckets: Array<{ __typename?: 'ForecastHistoryBucketType', bucketIndex: number, actualL0?: string | null, predictedL0: Array<{ __typename?: 'ForecastHistoryProbType', label: string, probability: number }> }> }> };

export type GetAcquisitionReceiptQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetAcquisitionReceiptQuery = { __typename?: 'Query', receipt?: { __typename?: 'ReceiptType', id: string, merchantName?: string | null, merchantEntityId?: string | null, placeEntityId?: string | null, purchasedAt?: any | null, orderNumber?: string | null, channel?: ReceiptChannel | null, paymentMethod?: string | null, paymentLast4?: string | null, currency?: string | null, totalMinor?: number | null } | null };

export type GetAcquisitionPlaceQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetAcquisitionPlaceQuery = { __typename?: 'Query', place?: { __typename?: 'PlaceType', id: string, name?: string | null } | null };

export type UpdateItemPageFieldsMutationVariables = Exact<{
  input: UpdateItemInput;
}>;


export type UpdateItemPageFieldsMutation = { __typename?: 'Mutation', updateItem: { __typename?: 'UpdateItemPayload', success: boolean, item?: { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, category?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null } | null } };

export type ConfirmItemObservationMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  itemId?: InputMaybe<Scalars['ID']['input']>;
}>;


export type ConfirmItemObservationMutation = { __typename?: 'Mutation', confirmObservation?: { __typename?: 'ObjectObservationType', id: string, confirmedByUser: boolean, resolvedObjectId?: string | null, resolutionMethod: ObservationResolutionMethod, resolutionConfidence?: number | null } | null };

export type RejectItemObservationMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type RejectItemObservationMutation = { __typename?: 'Mutation', rejectObservation?: { __typename?: 'ObjectObservationType', id: string, confirmedByUser: boolean, resolvedObjectId?: string | null, resolutionMethod: ObservationResolutionMethod, resolutionConfidence?: number | null } | null };

export type ActivityTimelineQueryVariables = Exact<{
  start: Scalars['String']['input'];
  end: Scalars['String']['input'];
  filters?: InputMaybe<ActivityTimelineFiltersInput>;
}>;


export type ActivityTimelineQuery = { __typename?: 'Query', activityTimeline: Array<{ __typename?: 'ActivityBucketType', date: string, count: number }> };

export type TimelineBrowserActivityCardDataFragment = { __typename?: 'BrowserActivityType', id: string, title?: string | null, url: string, actionType?: string | null, duration?: number | null, time: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> } & { ' $fragmentName'?: 'TimelineBrowserActivityCardDataFragment' };

export type TimelineCommunicationCardDataFragment = { __typename?: 'CommunicationType', id: string, subject?: string | null, preview?: string | null, time: any, type: string, direction: string, communicationContent: string, from?: { __typename?: 'PersonType', id: string, name?: string | null } | null, to: { __typename?: 'PersonConnection', edges: Array<{ __typename?: 'PersonEdge', node: { __typename?: 'PersonType', id: string, name?: string | null } }> }, tags: Array<{ __typename?: 'EntityTagType', label: string }> } & { ' $fragmentName'?: 'TimelineCommunicationCardDataFragment' };

export type TimelineEventCardDataFragment = { __typename?: 'EventType', id: string, title?: string | null, description?: string | null, sourceSystem?: string | null, metadata?: any | null, startTime: any, endTime?: any | null, timeSource?: string | null, locationName?: string | null, previewUrl?: string | null, mediaUrl?: string | null, mediaContentType?: string | null, mediaWidth?: number | null, mediaHeight?: number | null, mediaSize?: number | null, location?: { __typename?: 'PlaceType', id: string, name?: string | null, properties: any } | null, tags: Array<{ __typename?: 'EntityTagType', label: string }>, contents: { __typename?: 'ContentConnection', edges: Array<{ __typename?: 'ContentEdge', node: (
        { __typename?: 'ContentType', id: string, title?: string | null, contentUrl?: string | null }
        & { ' $fragmentRefs'?: { 'RichMediaDataFragment': RichMediaDataFragment } }
      ) }> } } & { ' $fragmentName'?: 'TimelineEventCardDataFragment' };

export type TimelineFileChunkCardDataFragment = { __typename?: 'FileChunkType', id: string, sectionTitle?: string | null, sourceLocator?: any | null, createdAt: any, chunkContent: string, file?: { __typename?: 'FileType', id: string, filename?: string | null, sourceUrl?: string | null } | null } & { ' $fragmentName'?: 'TimelineFileChunkCardDataFragment' };

export type UpdateBrowserActivityDetailMutationVariables = Exact<{
  input: UpdateBrowserActivityInput;
}>;


export type UpdateBrowserActivityDetailMutation = { __typename?: 'Mutation', updateBrowserActivity?: { __typename?: 'BrowserActivityType', id: string, title?: string | null, url: string } | null };

export type UpdateCommunicationDetailMutationVariables = Exact<{
  input: UpdateCommunicationInput;
}>;


export type UpdateCommunicationDetailMutation = { __typename?: 'Mutation', updateCommunication?: { __typename?: 'CommunicationType', id: string, subject?: string | null, preview?: string | null, communicationContent: string } | null };

export type GetCommunicationAttachmentsQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetCommunicationAttachmentsQuery = { __typename?: 'Query', node?:
    | { __typename: 'ActionType', id: string }
    | { __typename: 'AnswerType', id: string }
    | { __typename: 'BrowserActivityType', id: string }
    | { __typename: 'CommunicationType', metadata: any, id: string, attachments: Array<{ __typename?: 'CommunicationAttachmentType', fileId?: string | null, contentId?: string | null, filename?: string | null, contentType?: string | null, url?: string | null, previewUrl?: string | null, width?: number | null, height?: number | null, size?: number | null }> }
    | { __typename: 'ConceptType', id: string }
    | { __typename: 'ConnectionSyncJobType', id: string }
    | { __typename: 'ConnectionType', id: string }
    | { __typename: 'ContentType', id: string }
    | { __typename: 'EntityTagType', id: string }
    | { __typename: 'EventType', id: string }
    | { __typename: 'FileChunkType', id: string }
    | { __typename: 'FileType', id: string }
    | { __typename: 'ItemType', id: string }
    | { __typename: 'MessageType', id: string }
    | { __typename: 'NoteType', id: string }
    | { __typename: 'ObjectObservationType', id: string }
    | { __typename: 'PersonType', id: string }
    | { __typename: 'PlaceType', id: string }
    | { __typename: 'ProductModelType', id: string }
    | { __typename: 'ProviderKeyType', id: string }
    | { __typename: 'ProviderType', id: string }
    | { __typename: 'QuestionType', id: string }
    | { __typename: 'ReceiptType', id: string }
    | { __typename: 'RelationshipType', id: string }
    | { __typename: 'SavedSearchType', id: string }
    | { __typename: 'SummaryType', id: string }
    | { __typename: 'TagType', id: string }
    | { __typename: 'TaskPendingChangeType', id: string }
    | { __typename: 'TaskType', id: string }
    | { __typename: 'ThreadType', id: string }
    | { __typename: 'UserType', id: string }
   | null };

export type UpdateConceptDetailMutationVariables = Exact<{
  input: UpdateConceptInput;
}>;


export type UpdateConceptDetailMutation = { __typename?: 'Mutation', updateConcept: { __typename?: 'UpdateConceptPayload', success: boolean, concept?: { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null } | null } };

export type UpdateContentDetailMutationVariables = Exact<{
  input: UpdateContentInput;
}>;


export type UpdateContentDetailMutation = { __typename?: 'Mutation', updateContent?: { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null } | null };

export type UpdateEventDetailMutationVariables = Exact<{
  input: UpdateEventInput;
}>;


export type UpdateEventDetailMutation = { __typename?: 'Mutation', updateEvent?: { __typename?: 'EventType', id: string, title?: string | null, description?: string | null } | null };

export type UpdateFileDetailMutationVariables = Exact<{
  input: UpdateFileInput;
}>;


export type UpdateFileDetailMutation = { __typename?: 'Mutation', updateFile?: { __typename?: 'FileType', id: string, title?: string | null, description?: string | null } | null };

export type UpdateItemDetailMutationVariables = Exact<{
  input: UpdateItemInput;
}>;


export type UpdateItemDetailMutation = { __typename?: 'Mutation', updateItem: { __typename?: 'UpdateItemPayload', success: boolean, item?: { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, category?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null } | null } };

export type UpdateNoteDetailMutationVariables = Exact<{
  input: UpdateNoteInput;
}>;


export type UpdateNoteDetailMutation = { __typename?: 'Mutation', updateNote: { __typename?: 'UpdateNotePayload', success: boolean, note?: { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null } | null } };

export type GetPersonProfileForDrawerQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetPersonProfileForDrawerQuery = { __typename?: 'Query', person?: (
    { __typename?: 'PersonType' }
    & { ' $fragmentRefs'?: { 'PersonEditorFieldsFragment': PersonEditorFieldsFragment } }
  ) | null };

export type UpdatePlaceDetailMutationVariables = Exact<{
  input: UpdatePlaceInput;
}>;


export type UpdatePlaceDetailMutation = { __typename?: 'Mutation', updatePlace?: { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null, properties: any } | null };

export type GetReceiptLinesForDrawerQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetReceiptLinesForDrawerQuery = { __typename?: 'Query', receipt?: { __typename?: 'ReceiptType', id: string, currency?: string | null, documentContentId?: string | null, lineItems: Array<{ __typename?: 'ReceiptLineItemType', id: string, lineNumber: number, description: string, brand?: string | null, modelNumber?: string | null, category?: string | null, quantity: number, unitPriceMinor?: number | null, totalPriceMinor?: number | null, currency?: string | null, isPhysical: boolean, mintedObjectId?: string | null }> } | null };

export type GetReceiptDocumentForDrawerQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetReceiptDocumentForDrawerQuery = { __typename?: 'Query', content?: { __typename?: 'ContentType', id: string, title?: string | null, mimetype?: string | null, url?: string | null, mediaUrl?: string | null, previewUrl?: string | null, text?: string | null } | null };

export type RichMediaDataFragment = { __typename?: 'ContentType', player?: { __typename?: 'EmbedPlayerType', provider: string, playerUrl: string, posterUrl?: string | null, aspectRatio: number, mediaKind: string } | null, unfurl?: { __typename?: 'UnfurlType', status: string, resolver: string, title?: string | null, authorName?: string | null, siteName?: string | null, description?: string | null, canonicalUrl?: string | null, thumbnailUrl?: string | null, durationSeconds?: number | null, payload: any } | null } & { ' $fragmentName'?: 'RichMediaDataFragment' };

export type DeleteMemoryEventMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteMemoryEventMutation = { __typename?: 'Mutation', deleteEvent: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type DeleteMemoryContentMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteMemoryContentMutation = { __typename?: 'Mutation', deleteContent: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type DeleteMemoryPlaceMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteMemoryPlaceMutation = { __typename?: 'Mutation', deletePlace: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type DeleteMemoryPersonMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteMemoryPersonMutation = { __typename?: 'Mutation', deletePerson: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type DeleteMemoryItemMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteMemoryItemMutation = { __typename?: 'Mutation', deleteItem: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type DeleteMemoryConceptMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteMemoryConceptMutation = { __typename?: 'Mutation', deleteConcept: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type DeleteMemoryNoteMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteMemoryNoteMutation = { __typename?: 'Mutation', deleteNote: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type DeleteMemoryCommunicationMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteMemoryCommunicationMutation = { __typename?: 'Mutation', deleteCommunication: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type DeleteMemoryBrowserActivityMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteMemoryBrowserActivityMutation = { __typename?: 'Mutation', deleteBrowserActivity: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type RestoreMemoryEventMutationVariables = Exact<{
  input: RestoreByIdInput;
}>;


export type RestoreMemoryEventMutation = { __typename?: 'Mutation', restoreEvent?: { __typename?: 'EventType', id: string } | null };

export type GetDrawerNodeQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetDrawerNodeQuery = { __typename?: 'Query', node?:
    | { __typename: 'ActionType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | (
      { __typename: 'AnswerType', id: string }
      & { ' $fragmentRefs'?: { 'AnswerGridItemDataFragment': AnswerGridItemDataFragment;'TableAnswerRowDataFragment': TableAnswerRowDataFragment } }
    )
    | (
      { __typename: 'BrowserActivityType', id: string, bucketTime: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'BrowserActivityGridItemDataFragment': BrowserActivityGridItemDataFragment;'TableBrowserActivityRowDataFragment': TableBrowserActivityRowDataFragment;'TimelineBrowserActivityCardDataFragment': TimelineBrowserActivityCardDataFragment } }
    )
    | (
      { __typename: 'CommunicationType', id: string, bucketTime: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'CommunicationGridItemDataFragment': CommunicationGridItemDataFragment;'TableCommunicationRowDataFragment': TableCommunicationRowDataFragment;'TimelineCommunicationCardDataFragment': TimelineCommunicationCardDataFragment } }
    )
    | (
      { __typename: 'ConceptType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'ConceptGridItemDataFragment': ConceptGridItemDataFragment;'TableConceptRowDataFragment': TableConceptRowDataFragment } }
    )
    | { __typename: 'ConnectionSyncJobType', id: string }
    | { __typename: 'ConnectionType', id: string }
    | (
      { __typename: 'ContentType', id: string, galleryMimetype?: string | null, galleryTitle?: string | null, galleryContentUrl?: string | null, galleryContentSourceUrl?: string | null, galleryPreviewUrl?: string | null, galleryFileUrl?: string | null, galleryMediaSize?: number | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'ContentGridItemDataFragment': ContentGridItemDataFragment;'TableContentRowDataFragment': TableContentRowDataFragment } }
    )
    | { __typename: 'EntityTagType', id: string }
    | (
      { __typename: 'EventType', eventType?: string | null, id: string, bucketStartTime: any, mapCoordinates?: any | null, galleryMediaContentType?: string | null, galleryPreviewUrl?: string | null, gallerySourceUrl?: string | null, galleryMediaSize?: number | null, galleryTitle?: string | null, galleryLocationName?: string | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'EventGridItemDataFragment': EventGridItemDataFragment;'TableEventRowDataFragment': TableEventRowDataFragment;'TimelineEventCardDataFragment': TimelineEventCardDataFragment } }
    )
    | (
      { __typename: 'FileChunkType', id: string }
      & { ' $fragmentRefs'?: { 'FileChunkGridItemDataFragment': FileChunkGridItemDataFragment;'TableFileChunkRowDataFragment': TableFileChunkRowDataFragment;'TimelineFileChunkCardDataFragment': TimelineFileChunkCardDataFragment } }
    )
    | (
      { __typename: 'FileType', id: string, galleryContentType: string, galleryFilename?: string | null, galleryPreviewUrl?: string | null, gallerySourceUrl?: string | null, galleryMediaSize?: number | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'FileGridItemDataFragment': FileGridItemDataFragment;'TableFileRowDataFragment': TableFileRowDataFragment } }
    )
    | (
      { __typename: 'ItemType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'ItemGridItemDataFragment': ItemGridItemDataFragment;'TableItemRowDataFragment': TableItemRowDataFragment } }
    )
    | { __typename: 'MessageType', id: string }
    | (
      { __typename: 'NoteType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'NoteGridItemDataFragment': NoteGridItemDataFragment;'TableNoteRowDataFragment': TableNoteRowDataFragment } }
    )
    | { __typename: 'ObjectObservationType', id: string }
    | (
      { __typename: 'PersonType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'PersonGridItemDataFragment': PersonGridItemDataFragment;'TablePersonRowDataFragment': TablePersonRowDataFragment } }
    )
    | (
      { __typename: 'PlaceType', id: string, mapProperties: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'PlaceGridItemDataFragment': PlaceGridItemDataFragment;'TablePlaceRowDataFragment': TablePlaceRowDataFragment } }
    )
    | (
      { __typename: 'ProductModelType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'ProductGridItemDataFragment': ProductGridItemDataFragment;'TableProductRowDataFragment': TableProductRowDataFragment } }
    )
    | { __typename: 'ProviderKeyType', id: string }
    | { __typename: 'ProviderType', id: string }
    | { __typename: 'QuestionType', id: string }
    | (
      { __typename: 'ReceiptType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'ReceiptGridItemDataFragment': ReceiptGridItemDataFragment;'TableReceiptRowDataFragment': TableReceiptRowDataFragment } }
    )
    | { __typename: 'RelationshipType', id: string }
    | { __typename: 'SavedSearchType', id: string }
    | { __typename: 'SummaryType', id: string }
    | { __typename: 'TagType', id: string }
    | { __typename: 'TaskPendingChangeType', id: string }
    | { __typename: 'TaskType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | (
      { __typename: 'ThreadType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'ThreadGridItemDataFragment': ThreadGridItemDataFragment;'TableThreadRowDataFragment': TableThreadRowDataFragment } }
    )
    | { __typename: 'UserType', id: string }
   | null };

export type GetSavedSearchesForPickerQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetSavedSearchesForPickerQuery = { __typename?: 'Query', savedSearches: { __typename?: 'SavedSearchConnection', totalCount: number, edges: Array<{ __typename?: 'SavedSearchEdge', node: { __typename?: 'SavedSearchType', id: string, name?: string | null, description?: string | null } }> } };

export type GraphNodeEntityQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GraphNodeEntityQuery = { __typename?: 'Query', node?:
    | { __typename: 'ActionType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'AnswerType', id: string }
    | { __typename: 'BrowserActivityType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | (
      { __typename: 'CommunicationType', id: string, bucketTime: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'CommunicationGridItemDataFragment': CommunicationGridItemDataFragment;'TableCommunicationRowDataFragment': TableCommunicationRowDataFragment;'TimelineCommunicationCardDataFragment': TimelineCommunicationCardDataFragment } }
    )
    | (
      { __typename: 'ConceptType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'ConceptGridItemDataFragment': ConceptGridItemDataFragment;'TableConceptRowDataFragment': TableConceptRowDataFragment } }
    )
    | { __typename: 'ConnectionSyncJobType', id: string }
    | { __typename: 'ConnectionType', id: string }
    | (
      { __typename: 'ContentType', id: string, galleryMimetype?: string | null, galleryTitle?: string | null, galleryContentUrl?: string | null, galleryContentSourceUrl?: string | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'ContentGridItemDataFragment': ContentGridItemDataFragment;'TableContentRowDataFragment': TableContentRowDataFragment } }
    )
    | { __typename: 'EntityTagType', id: string }
    | (
      { __typename: 'EventType', eventType?: string | null, id: string, bucketStartTime: any, mapCoordinates?: any | null, galleryMediaContentType?: string | null, galleryPreviewUrl?: string | null, gallerySourceUrl?: string | null, galleryTitle?: string | null, galleryLocationName?: string | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'EventGridItemDataFragment': EventGridItemDataFragment;'TableEventRowDataFragment': TableEventRowDataFragment;'TimelineEventCardDataFragment': TimelineEventCardDataFragment } }
    )
    | { __typename: 'FileChunkType', id: string }
    | (
      { __typename: 'FileType', id: string, galleryContentType: string, galleryFilename?: string | null, galleryPreviewUrl?: string | null, gallerySourceUrl?: string | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'FileGridItemDataFragment': FileGridItemDataFragment;'TableFileRowDataFragment': TableFileRowDataFragment } }
    )
    | (
      { __typename: 'ItemType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'ItemGridItemDataFragment': ItemGridItemDataFragment;'TableItemRowDataFragment': TableItemRowDataFragment } }
    )
    | { __typename: 'MessageType', id: string }
    | { __typename: 'NoteType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'ObjectObservationType', id: string }
    | (
      { __typename: 'PersonType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'PersonGridItemDataFragment': PersonGridItemDataFragment;'TablePersonRowDataFragment': TablePersonRowDataFragment } }
    )
    | (
      { __typename: 'PlaceType', id: string, mapProperties: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
      & { ' $fragmentRefs'?: { 'PlaceGridItemDataFragment': PlaceGridItemDataFragment;'TablePlaceRowDataFragment': TablePlaceRowDataFragment } }
    )
    | { __typename: 'ProductModelType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'ProviderKeyType', id: string }
    | { __typename: 'ProviderType', id: string }
    | { __typename: 'QuestionType', id: string }
    | { __typename: 'ReceiptType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'RelationshipType', id: string }
    | { __typename: 'SavedSearchType', id: string }
    | { __typename: 'SummaryType', id: string }
    | { __typename: 'TagType', id: string }
    | { __typename: 'TaskPendingChangeType', id: string }
    | { __typename: 'TaskType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'ThreadType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'UserType', id: string }
   | null };

export type TableAnswerRowDataFragment = { __typename?: 'AnswerType', id: string, answer: string, question: { __typename?: 'QuestionType', id: string, text: string } } & { ' $fragmentName'?: 'TableAnswerRowDataFragment' };

export type TableBrowserActivityRowDataFragment = { __typename?: 'BrowserActivityType', id: string, title?: string | null, url: string } & { ' $fragmentName'?: 'TableBrowserActivityRowDataFragment' };

export type TableCommunicationRowDataFragment = { __typename?: 'CommunicationType', id: string, subject?: string | null, preview?: string | null } & { ' $fragmentName'?: 'TableCommunicationRowDataFragment' };

export type TableConceptRowDataFragment = { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TableConceptRowDataFragment' };

export type TableContentRowDataFragment = { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null } & { ' $fragmentName'?: 'TableContentRowDataFragment' };

export type TableEventRowDataFragment = { __typename?: 'EventType', id: string, title?: string | null, description?: string | null, startTime: any, locationName?: string | null, previewUrl?: string | null, mediaContentType?: string | null } & { ' $fragmentName'?: 'TableEventRowDataFragment' };

export type TableFileChunkRowDataFragment = { __typename?: 'FileChunkType', id: string, sectionTitle?: string | null, sourceLocator?: any | null, chunkContent: string, file?: { __typename?: 'FileType', id: string, filename?: string | null } | null } & { ' $fragmentName'?: 'TableFileChunkRowDataFragment' };

export type TableFileRowDataFragment = { __typename?: 'FileType', id: string, filename?: string | null, title?: string | null, previewUrl?: string | null, sourceUrl?: string | null, contentType: string } & { ' $fragmentName'?: 'TableFileRowDataFragment' };

export type TableItemRowDataFragment = { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, brand?: string | null, model?: string | null, lifecycleState: ItemLifecycleState, lastSeenAt?: any | null, identifiers: Array<{ __typename?: 'ObjectIdentifierType', namespace: ObjectIdentifierNamespace, value: string, rawValue?: string | null }>, product?: { __typename?: 'ProductModelType', id: string, title: string, brand?: string | null } | null, file?: { __typename?: 'FileType', id: string, sourceUrl?: string | null } | null } & { ' $fragmentName'?: 'TableItemRowDataFragment' };

export type TableNoteRowDataFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null } & { ' $fragmentName'?: 'TableNoteRowDataFragment' };

export type TablePersonRowDataFragment = { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TablePersonRowDataFragment' };

export type TablePlaceRowDataFragment = { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TablePlaceRowDataFragment' };

export type TableProductRowDataFragment = { __typename?: 'ProductModelType', id: string, brand?: string | null, modelNumber?: string | null, msrpMinor?: number | null, productTitle: string, productCurrency?: string | null } & { ' $fragmentName'?: 'TableProductRowDataFragment' };

export type TableReceiptRowDataFragment = { __typename?: 'ReceiptType', id: string, merchantName?: string | null, purchasedAt?: any | null, totalMinor?: number | null, receiptCurrency?: string | null, lineItems: Array<{ __typename?: 'ReceiptLineItemType', id: string }> } & { ' $fragmentName'?: 'TableReceiptRowDataFragment' };

export type TableThreadRowDataFragment = { __typename?: 'ThreadType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TableThreadRowDataFragment' };

export type MapPinsQueryVariables = Exact<{
  query: Scalars['String']['input'];
  includeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  eventTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  startTime?: InputMaybe<Scalars['String']['input']>;
  endTime?: InputMaybe<Scalars['String']['input']>;
  connectors?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  people?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  places?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  bbox?: InputMaybe<Array<Scalars['Float']['input']> | Scalars['Float']['input']>;
  semantic?: InputMaybe<Scalars['Boolean']['input']>;
}>;


export type MapPinsQuery = { __typename?: 'Query', mapPins: { __typename?: 'MapPinsType', totalCount: number, truncated: boolean, pins: Array<{ __typename?: 'MapPinType', id: string, title?: string | null, latitude: number, longitude: number, startTime?: any | null, endTime?: any | null, eventType?: string | null, locationName?: string | null, timeSource?: string | null }> } };

export type MapPinEventQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type MapPinEventQuery = { __typename?: 'Query', event?: (
    { __typename?: 'EventType', eventType?: string | null, mapCoordinates?: any | null }
    & { ' $fragmentRefs'?: { 'TimelineEventCardDataFragment': TimelineEventCardDataFragment } }
  ) | null };

export type PositionTrackQueryVariables = Exact<{
  startTime?: InputMaybe<Scalars['String']['input']>;
  endTime?: InputMaybe<Scalars['String']['input']>;
  bbox?: InputMaybe<Array<Scalars['Float']['input']> | Scalars['Float']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
  maxPoints?: InputMaybe<Scalars['Int']['input']>;
}>;


export type PositionTrackQuery = { __typename?: 'Query', positionTrack: { __typename?: 'PositionTrackType', hasNextPage: boolean, endCursor?: string | null, bucketSeconds?: number | null, totalCount?: number | null, points: Array<{ __typename?: 'PositionPointType', latitude: number, longitude: number, startTime: any, endTime: any, fixCount: number }> } };

export type HomeMapPlaceQueryVariables = Exact<{
  query?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
}>;


export type HomeMapPlaceQuery = { __typename?: 'Query', places: { __typename?: 'PlaceConnection', edges: Array<{ __typename?: 'PlaceEdge', node: { __typename?: 'PlaceType', id: string, name?: string | null, latitude?: number | null, longitude?: number | null } }> } };

export type PlaybackPositionTrackPageQueryVariables = Exact<{
  startTime?: InputMaybe<Scalars['String']['input']>;
  endTime?: InputMaybe<Scalars['String']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
}>;


export type PlaybackPositionTrackPageQuery = { __typename?: 'Query', positionTrack: { __typename?: 'PositionTrackType', endCursor?: string | null, hasNextPage: boolean, points: Array<{ __typename?: 'PositionPointType', latitude: number, longitude: number, startTime: any }> } };

export type PlaybackPositionTrackExtentQueryVariables = Exact<{ [key: string]: never; }>;


export type PlaybackPositionTrackExtentQuery = { __typename?: 'Query', positionTrackExtent?: { __typename?: 'PositionTrackExtentType', start: any, end: any, count: number } | null };

export type SearchQueryVariables = Exact<{
  query: Scalars['String']['input'];
  includeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  eventTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  startTime?: InputMaybe<Scalars['String']['input']>;
  endTime?: InputMaybe<Scalars['String']['input']>;
  sortBy?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['String']['input']>;
  connectors?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  people?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  places?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  hasLocation?: InputMaybe<Scalars['Boolean']['input']>;
  bbox?: InputMaybe<Array<Scalars['Float']['input']> | Scalars['Float']['input']>;
  semantic?: InputMaybe<Scalars['Boolean']['input']>;
  shareToken?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type SearchQuery = { __typename?: 'Query', search: { __typename?: 'SearchResultConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'SearchResultEdge', cursor: string, node:
        | { __typename: 'ActionType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
        | (
          { __typename: 'AnswerType', id: string }
          & { ' $fragmentRefs'?: { 'AnswerGridItemDataFragment': AnswerGridItemDataFragment;'TableAnswerRowDataFragment': TableAnswerRowDataFragment } }
        )
        | (
          { __typename: 'BrowserActivityType', id: string, bucketTime: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'BrowserActivityGridItemDataFragment': BrowserActivityGridItemDataFragment;'TableBrowserActivityRowDataFragment': TableBrowserActivityRowDataFragment;'TimelineBrowserActivityCardDataFragment': TimelineBrowserActivityCardDataFragment } }
        )
        | (
          { __typename: 'CommunicationType', id: string, bucketTime: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'CommunicationGridItemDataFragment': CommunicationGridItemDataFragment;'TableCommunicationRowDataFragment': TableCommunicationRowDataFragment;'TimelineCommunicationCardDataFragment': TimelineCommunicationCardDataFragment } }
        )
        | (
          { __typename: 'ConceptType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'ConceptGridItemDataFragment': ConceptGridItemDataFragment;'TableConceptRowDataFragment': TableConceptRowDataFragment } }
        )
        | (
          { __typename: 'ContentType', id: string, galleryMimetype?: string | null, galleryTitle?: string | null, galleryContentUrl?: string | null, galleryContentSourceUrl?: string | null, galleryPreviewUrl?: string | null, galleryFileUrl?: string | null, galleryMediaSize?: number | null, tags: Array<{ __typename?: 'EntityTagType', label: string }>, galleryPlayer?: { __typename?: 'EmbedPlayerType', provider: string, playerUrl: string, posterUrl?: string | null, aspectRatio: number, mediaKind: string } | null, galleryUnfurl?: { __typename?: 'UnfurlType', status: string, title?: string | null, thumbnailUrl?: string | null, canonicalUrl?: string | null } | null }
          & { ' $fragmentRefs'?: { 'ContentGridItemDataFragment': ContentGridItemDataFragment;'TableContentRowDataFragment': TableContentRowDataFragment } }
        )
        | (
          { __typename: 'EventType', id: string, eventType?: string | null, bucketStartTime: any, bucketTimeSource?: string | null, mapCoordinates?: any | null, galleryMediaContentType?: string | null, galleryPreviewUrl?: string | null, gallerySourceUrl?: string | null, galleryMediaSize?: number | null, galleryTitle?: string | null, galleryLocationName?: string | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'EventGridItemDataFragment': EventGridItemDataFragment;'TableEventRowDataFragment': TableEventRowDataFragment;'TimelineEventCardDataFragment': TimelineEventCardDataFragment } }
        )
        | (
          { __typename: 'FileChunkType', id: string }
          & { ' $fragmentRefs'?: { 'FileChunkGridItemDataFragment': FileChunkGridItemDataFragment;'TableFileChunkRowDataFragment': TableFileChunkRowDataFragment;'TimelineFileChunkCardDataFragment': TimelineFileChunkCardDataFragment } }
        )
        | (
          { __typename: 'FileType', id: string, galleryContentType: string, galleryFilename?: string | null, galleryPreviewUrl?: string | null, gallerySourceUrl?: string | null, galleryMediaSize?: number | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'FileGridItemDataFragment': FileGridItemDataFragment;'TableFileRowDataFragment': TableFileRowDataFragment } }
        )
        | (
          { __typename: 'ItemType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'ItemGridItemDataFragment': ItemGridItemDataFragment;'TableItemRowDataFragment': TableItemRowDataFragment } }
        )
        | (
          { __typename: 'NoteType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'NoteGridItemDataFragment': NoteGridItemDataFragment;'TableNoteRowDataFragment': TableNoteRowDataFragment } }
        )
        | (
          { __typename: 'PersonType', id: string, bucketAppearedAt?: any | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'PersonGridItemDataFragment': PersonGridItemDataFragment;'TablePersonRowDataFragment': TablePersonRowDataFragment } }
        )
        | (
          { __typename: 'PlaceType', id: string, bucketAppearedAt?: any | null, mapProperties: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'PlaceGridItemDataFragment': PlaceGridItemDataFragment;'TablePlaceRowDataFragment': TablePlaceRowDataFragment } }
        )
        | (
          { __typename: 'ProductModelType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'ProductGridItemDataFragment': ProductGridItemDataFragment;'TableProductRowDataFragment': TableProductRowDataFragment } }
        )
        | (
          { __typename: 'ReceiptType', id: string, bucketPurchasedAt?: any | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'ReceiptGridItemDataFragment': ReceiptGridItemDataFragment;'TableReceiptRowDataFragment': TableReceiptRowDataFragment } }
        )
        | { __typename: 'TaskType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
        | (
          { __typename: 'ThreadType', id: string, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
          & { ' $fragmentRefs'?: { 'ThreadGridItemDataFragment': ThreadGridItemDataFragment;'TableThreadRowDataFragment': TableThreadRowDataFragment } }
        )
       }> } };

export type GetSavedSearchQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetSavedSearchQuery = { __typename?: 'Query', savedSearch?: { __typename?: 'SavedSearchType', id: string, name?: string | null, description?: string | null, query?: string | null, entityTypes?: Array<string> | null, tags?: Array<string> | null, filters?: { __typename?: 'SavedSearchFiltersType', eventTypes?: Array<string> | null, startTime?: string | null, endTime?: string | null, datePreset?: string | null, sortBy?: string | null, sortOrder?: string | null, connectors?: Array<string> | null, people?: Array<string> | null, places?: Array<string> | null, hasLocation?: boolean | null, semantic?: boolean | null } | null } | null };

export type GetNoteQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetNoteQuery = { __typename?: 'Query', note?: { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null, updatedAt: any } | null };

export type CreateNoteMutationVariables = Exact<{
  input: CreateNoteInput;
}>;


export type CreateNoteMutation = { __typename?: 'Mutation', createNote: { __typename?: 'CreateNotePayload', success: boolean, note?: { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null, updatedAt: any } | null } };

export type UpdateNoteMutationVariables = Exact<{
  input: UpdateNoteInput;
}>;


export type UpdateNoteMutation = { __typename?: 'Mutation', updateNote: { __typename?: 'UpdateNotePayload', success: boolean, note?: { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null, updatedAt: any } | null } };

export type NewNoteFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null, updatedAt: any } & { ' $fragmentName'?: 'NewNoteFragment' };

export type NoteReferenceSearchQueryVariables = Exact<{
  query: Scalars['String']['input'];
  includeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
}>;


export type NoteReferenceSearchQuery = { __typename?: 'Query', search: { __typename?: 'SearchResultConnection', edges: Array<{ __typename?: 'SearchResultEdge', node:
        | { __typename: 'ActionType', id: string }
        | { __typename: 'AnswerType', id: string }
        | { __typename: 'BrowserActivityType', id: string }
        | { __typename: 'CommunicationType', id: string, referencePreview?: string | null }
        | { __typename: 'ConceptType', id: string, conceptReferenceName?: string | null }
        | { __typename: 'ContentType', id: string, contentReferenceTitle?: string | null }
        | { __typename: 'EventType', id: string, eventReferenceTitle?: string | null }
        | { __typename: 'FileChunkType', id: string }
        | { __typename: 'FileType', id: string }
        | { __typename: 'ItemType', id: string, itemReferenceName?: string | null }
        | { __typename: 'NoteType', id: string, referenceTitle?: string | null }
        | { __typename: 'PersonType', id: string, referenceName?: string | null }
        | { __typename: 'PlaceType', id: string, placeReferenceName?: string | null }
        | { __typename: 'ProductModelType', id: string }
        | { __typename: 'ReceiptType', id: string }
        | { __typename: 'TaskType', id: string }
        | { __typename: 'ThreadType', id: string }
       }> } };

export type DeleteNoteMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteNoteMutation = { __typename?: 'Mutation', deleteNote: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type NoteGridItemFragmentFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null } & { ' $fragmentName'?: 'NoteGridItemFragmentFragment' };

export type GetNotesQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetNotesQuery = { __typename?: 'Query', notes: { __typename?: 'NoteConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'NoteEdge', cursor: string, node: (
        { __typename?: 'NoteType', id: string }
        & { ' $fragmentRefs'?: { 'NoteGridItemFragmentFragment': NoteGridItemFragmentFragment } }
      ) }> } };

export type MergePeopleMutationVariables = Exact<{
  input: MergePeopleInput;
}>;


export type MergePeopleMutation = { __typename?: 'Mutation', mergePeople: { __typename?: 'MergePeoplePayload', success: boolean, person?: { __typename?: 'PersonType', id: string, name?: string | null } | null } };

export type RejectPersonDuplicatesMutationVariables = Exact<{
  personIds: Array<Scalars['ID']['input']> | Scalars['ID']['input'];
}>;


export type RejectPersonDuplicatesMutation = { __typename?: 'Mutation', rejectPersonDuplicates: boolean };

export type GetPeopleQueryVariables = Exact<{
  query?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetPeopleQuery = { __typename?: 'Query', people: { __typename?: 'PersonConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'PersonEdge', cursor: string, node: { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null, firstName?: string | null, lastName?: string | null, avatarUrl?: string | null, birthDate?: string | null, isSelf: boolean, identifiers: Array<{ __typename?: 'PersonIdentifierType', kind: string, value: string, rawValue?: string | null, label?: string | null }>, interactionStats: { __typename?: 'PersonInteractionStatsType', eventCount: number, communicationCount: number, lastInteractionAt?: any | null } } }> } };

export type GetMergedPersonQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetMergedPersonQuery = { __typename?: 'Query', person?: { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null, firstName?: string | null, lastName?: string | null, avatarUrl?: string | null, birthDate?: string | null, isSelf: boolean, identifiers: Array<{ __typename?: 'PersonIdentifierType', kind: string, value: string, rawValue?: string | null, label?: string | null }>, interactionStats: { __typename?: 'PersonInteractionStatsType', eventCount: number, communicationCount: number, lastInteractionAt?: any | null } } | null };

export type GetMergeCandidatesQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetMergeCandidatesQuery = { __typename?: 'Query', mergeCandidates: { __typename?: 'MergeCandidateConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'MergeCandidateEdge', cursor: string, node: { __typename?: 'MergeCandidateType', id: string, score: number, status: string, detectedBy: string, createdAt: any, evidence: Array<{ __typename?: 'MergeCandidateEvidenceType', kind: string, value: string, score?: number | null }>, people: Array<{ __typename?: 'PersonType', id: string, name?: string | null, description?: string | null, avatarUrl?: string | null, isSelf: boolean, identifiers: Array<{ __typename?: 'PersonIdentifierType', kind: string, value: string, rawValue?: string | null, label?: string | null, source?: string | null }>, interactionStats: { __typename?: 'PersonInteractionStatsType', eventCount: number, communicationCount: number, lastInteractionAt?: any | null } }> } }> } };

export type GetPersonQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetPersonQuery = { __typename?: 'Query', person?: (
    { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
    & { ' $fragmentRefs'?: { 'PersonEditorFieldsFragment': PersonEditorFieldsFragment } }
  ) | null };

export type UpdatePersonDescriptionMutationVariables = Exact<{
  input: UpdatePersonInput;
}>;


export type UpdatePersonDescriptionMutation = { __typename?: 'Mutation', updatePerson: { __typename?: 'UpdatePersonPayload', success: boolean, person?: { __typename?: 'PersonType', id: string, description?: string | null } | null } };

export type GetPlaceQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetPlaceQuery = { __typename?: 'Query', place?: { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null, properties: any, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null };

export type UpdatePlacePageFieldsMutationVariables = Exact<{
  input: UpdatePlaceInput;
}>;


export type UpdatePlacePageFieldsMutation = { __typename?: 'Mutation', updatePlace?: { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null, properties: any } | null };

export type GetPlaceDuplicatesQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
}>;


export type GetPlaceDuplicatesQuery = { __typename?: 'Query', placeDuplicates: { __typename?: 'PlaceDuplicatesPayload', totalCount: number, hasMore: boolean, groups: Array<{ __typename?: 'PlaceDuplicateGroupType', reason: PlaceDuplicateReason, value: string, totalPlaces: number, places: Array<{ __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null, placeKind?: string | null, properties: any }> }> } };

export type MergePlacesMutationVariables = Exact<{
  input: MergePlacesInput;
}>;


export type MergePlacesMutation = { __typename?: 'Mutation', mergePlaces: { __typename?: 'MergePlacesPayload', success: boolean, place?: { __typename?: 'PlaceType', id: string, name?: string | null } | null, counts?: { __typename?: 'PlaceMergeCountsType', events: number, childPlaces: number, relationshipsFrom: number, relationshipsTo: number } | null } };

export type RejectPlaceDuplicatesMutationVariables = Exact<{
  placeIds: Array<Scalars['ID']['input']> | Scalars['ID']['input'];
}>;


export type RejectPlaceDuplicatesMutation = { __typename?: 'Mutation', rejectPlaceDuplicates: boolean };

export type GetPlaceSheetQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetPlaceSheetQuery = { __typename?: 'Query', place?: (
    { __typename: 'PlaceType', id: string, mapProperties: any, tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    & { ' $fragmentRefs'?: { 'PlaceGridItemDataFragment': PlaceGridItemDataFragment;'TablePlaceRowDataFragment': TablePlaceRowDataFragment } }
  ) | null };

export type GetPlacesQueryVariables = Exact<{
  query?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetPlacesQuery = { __typename?: 'Query', places: { __typename?: 'PlaceConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'PlaceEdge', cursor: string, node: { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null, placeKind?: string | null, latitude?: number | null, longitude?: number | null, parent?: { __typename?: 'PlaceType', id: string, name?: string | null, placeKind?: string | null } | null, visitStats: { __typename?: 'PlaceVisitStatsType', visitCount: number, firstVisitAt?: any | null, lastVisitAt?: any | null, status: string } } }> } };

export type GetKnownPlacesQueryVariables = Exact<{ [key: string]: never; }>;


export type GetKnownPlacesQuery = { __typename?: 'Query', geocodingConfigured: boolean, knownPlaces: Array<{ __typename?: 'KnownPlaceType', id: string, locationId?: string | null, label: string, kind: string, confidence: number, source: string, coordinates?: { __typename?: 'KnownPlaceCoordinates', lat: number, lng: number } | null }>, knownPlaceCandidates: Array<{ __typename?: 'KnownPlaceCandidateType', locationId?: string | null, label: string, kind: string, lat: number, lng: number, eventCount: number, confidence: number }> };

export type ConfirmKnownPlaceMutationVariables = Exact<{
  input: UpdateKnownPlaceInput;
}>;


export type ConfirmKnownPlaceMutation = { __typename?: 'Mutation', updateKnownPlace: { __typename?: 'KnownPlaceType', id: string, label: string, kind: string } };

export type UpdatePlanDayEventMutationVariables = Exact<{
  input: UpdateEventInput;
}>;


export type UpdatePlanDayEventMutation = { __typename?: 'Mutation', updateEvent?: { __typename?: 'EventType', id: string, title?: string | null, startTime: any, endTime?: any | null, eventType?: string | null, taskId?: string | null, status?: string | null } | null };

export type UpdatePlanDayEventTaskMutationVariables = Exact<{
  input: UpdateTaskInput;
}>;


export type UpdatePlanDayEventTaskMutation = { __typename?: 'Mutation', updateTask: { __typename?: 'UpdateTaskPayload', success: boolean, task?: { __typename?: 'TaskType', id: string, title: string, scheduledFor?: string | null, estimatedMinutes?: number | null } | null } };

export type UpdateTaskMutationVariables = Exact<{
  input: UpdateTaskInput;
}>;


export type UpdateTaskMutation = { __typename?: 'Mutation', updateTask: { __typename?: 'UpdateTaskPayload', success: boolean, task?: (
      { __typename?: 'TaskType', id: string }
      & { ' $fragmentRefs'?: { 'TaskRowFragmentFragment': TaskRowFragmentFragment } }
    ) | null } };

export type CreateTaskMutationVariables = Exact<{
  input: CreateTaskInput;
}>;


export type CreateTaskMutation = { __typename?: 'Mutation', createTask: { __typename?: 'CreateTaskPayload', success: boolean, task?: (
      { __typename?: 'TaskType', id: string }
      & { ' $fragmentRefs'?: { 'TaskRowFragmentFragment': TaskRowFragmentFragment } }
    ) | null } };

export type CompleteTaskMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type CompleteTaskMutation = { __typename?: 'Mutation', completeTask?: { __typename?: 'TaskType', id: string, status: TaskStatus, completedAt?: any | null } | null };

export type DeclineTaskPendingChangeMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type DeclineTaskPendingChangeMutation = { __typename?: 'Mutation', declineTaskPendingChange: { __typename?: 'ResolveTaskPendingChangePayload', success: boolean } };

export type ReopenTaskMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type ReopenTaskMutation = { __typename?: 'Mutation', reopenTask?: { __typename?: 'TaskType', id: string, status: TaskStatus, completedAt?: any | null } | null };

export type AcceptTaskPendingChangeMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type AcceptTaskPendingChangeMutation = { __typename?: 'Mutation', acceptTaskPendingChange: { __typename?: 'ResolveTaskPendingChangePayload', success: boolean, task?: { __typename?: 'TaskType', id: string, status: TaskStatus, title: string, notes?: string | null, parentId?: string | null } | null } };

export type TaskRowFragmentFragment = { __typename?: 'TaskType', id: string, title: string, description?: string | null, status: TaskStatus, priority: number, parentId?: string | null, dueAt?: any | null, scheduledFor?: string | null, placedOnCalendar: boolean, deferUntil?: string | null, estimatedMinutes?: number | null, completedAt?: any | null } & { ' $fragmentName'?: 'TaskRowFragmentFragment' };

export type ListTasksForTestQueryVariables = Exact<{ [key: string]: never; }>;


export type ListTasksForTestQuery = { __typename?: 'Query', tasks: { __typename?: 'TaskConnection', edges: Array<{ __typename?: 'TaskEdge', node: { __typename?: 'TaskType', id: string, title: string } }> } };

export type DeleteTaskMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteTaskMutation = { __typename?: 'Mutation', deleteTask: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type GetTasksQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetTasksQuery = { __typename?: 'Query', tasks: { __typename?: 'TaskConnection', totalCount: number, edges: Array<{ __typename?: 'TaskEdge', node: (
        { __typename?: 'TaskType', id: string, status: TaskStatus, priority: number, parentId?: string | null, dueAt?: any | null, scheduledFor?: string | null, placedOnCalendar: boolean, deferUntil?: string | null, title: string }
        & { ' $fragmentRefs'?: { 'TaskRowFragmentFragment': TaskRowFragmentFragment } }
      ) }> }, taskPendingChanges: Array<{ __typename?: 'TaskPendingChangeType', id: string, taskId: string, kind: TaskPendingChangeKind, rationale?: string | null, confidence?: number | null, status: TaskPendingChangeStatus }> };

export type AcceptProposedTaskMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type AcceptProposedTaskMutation = { __typename?: 'Mutation', acceptProposedTask?: { __typename?: 'TaskType', id: string, status: TaskStatus, scheduledFor?: string | null, placedOnCalendar: boolean } | null };

export type DeclineProposedTaskMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type DeclineProposedTaskMutation = { __typename?: 'Mutation', declineProposedTask?: { __typename?: 'TaskType', id: string, status: TaskStatus } | null };

export type PlanTaskMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type PlanTaskMutation = { __typename?: 'Mutation', planTask?: { __typename?: 'TaskType', id: string, status: TaskStatus, dueAt?: any | null, scheduledFor?: string | null, placedOnCalendar: boolean } | null };

export type ScheduleTaskMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  date?: InputMaybe<Scalars['String']['input']>;
}>;


export type ScheduleTaskMutation = { __typename?: 'Mutation', scheduleTask: { __typename?: 'ScheduleTaskPayload', success: boolean, status?: string | null, task?: { __typename?: 'TaskType', id: string, scheduledFor?: string | null, placedOnCalendar: boolean, estimatedMinutes?: number | null } | null } };

export type ScheduleTaskAtMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  startTime: Scalars['DateTime']['input'];
}>;


export type ScheduleTaskAtMutation = { __typename?: 'Mutation', scheduleTask: { __typename?: 'ScheduleTaskPayload', success: boolean, status?: string | null, task?: { __typename?: 'TaskType', id: string, scheduledFor?: string | null, placedOnCalendar: boolean, estimatedMinutes?: number | null } | null, event?: { __typename?: 'EventType', id: string, startTime: any, endTime?: any | null } | null } };

export type ProviderEndpointsFragmentFragment = { __typename?: 'ProviderType', endpoints: Array<{ __typename?: 'ProviderEndpointType', name: string, description: string }> } & { ' $fragmentName'?: 'ProviderEndpointsFragmentFragment' };

export type GetProviderQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetProviderQuery = { __typename?: 'Query', provider?: (
    { __typename?: 'ProviderType', id: string, name?: string | null, description?: string | null, logoUrl?: string | null, authType?: string | null, localOnly: boolean, appSetupUrl?: string | null, openidKeyLink?: string | null, theme?: { __typename?: 'ProviderThemeType', backgroundColor?: string | null, borderColor?: string | null } | null }
    & { ' $fragmentRefs'?: { 'ProviderEndpointsFragmentFragment': ProviderEndpointsFragmentFragment } }
  ) | null };

export type GetReceiptQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetReceiptQuery = { __typename?: 'Query', receipt?: { __typename?: 'ReceiptType', id: string, merchantName?: string | null, merchantEntityId?: string | null, placeEntityId?: string | null, purchasedAt?: any | null, orderNumber?: string | null, channel?: ReceiptChannel | null, paymentMethod?: string | null, paymentLast4?: string | null, currency?: string | null, subtotalMinor?: number | null, taxMinor?: number | null, tipMinor?: number | null, shippingMinor?: number | null, discountMinor?: number | null, totalMinor?: number | null, extractionState: ReceiptExtractionState, extractionModel?: string | null, extractionConfidence?: number | null, extractionError?: string | null, documentContentId?: string | null, sourceFileId?: string | null, sourceSystem?: string | null, sourceType?: string | null, sourceMessageId?: string | null, eventId?: string | null, lineItems: Array<{ __typename?: 'ReceiptLineItemType', id: string, lineNumber: number, description: string, brand?: string | null, modelNumber?: string | null, category?: string | null, quantity: number, unitPriceMinor?: number | null, totalPriceMinor?: number | null, currency?: string | null, isPhysical: boolean, mintedObjectId?: string | null, productId?: string | null }> } | null };

export type GetReceiptDocumentQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetReceiptDocumentQuery = { __typename?: 'Query', content?: { __typename?: 'ContentType', id: string, title?: string | null, mimetype?: string | null, url?: string | null, mediaUrl?: string | null, previewUrl?: string | null, text?: string | null } | null };

export type GetReceiptPlaceQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetReceiptPlaceQuery = { __typename?: 'Query', place?: { __typename?: 'PlaceType', id: string, name?: string | null } | null };

export type GetReceiptsQueryVariables = Exact<{
  merchantName?: InputMaybe<Scalars['String']['input']>;
  extractionState?: InputMaybe<ReceiptExtractionState>;
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetReceiptsQuery = { __typename?: 'Query', receipts: { __typename?: 'ReceiptConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'ReceiptEdge', cursor: string, node: { __typename?: 'ReceiptType', id: string, merchantName?: string | null, purchasedAt?: any | null, totalMinor?: number | null, currency?: string | null, orderNumber?: string | null, channel?: ReceiptChannel | null, extractionState: ReceiptExtractionState, lineItems: Array<{ __typename?: 'ReceiptLineItemType', id: string }> } }> } };

export type CreateSavedSearchMutationVariables = Exact<{
  input: CreateSavedSearchInput;
}>;


export type CreateSavedSearchMutation = { __typename?: 'Mutation', createSavedSearch: { __typename?: 'CreateSavedSearchPayload', success: boolean, savedSearch?: (
      { __typename?: 'SavedSearchType', id: string }
      & { ' $fragmentRefs'?: { 'SavedSearchGridItemFragmentFragment': SavedSearchGridItemFragmentFragment } }
    ) | null } };

export type DeleteSavedSearchMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteSavedSearchMutation = { __typename?: 'Mutation', deleteSavedSearch: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type ListSavedSearchesForTestQueryVariables = Exact<{ [key: string]: never; }>;


export type ListSavedSearchesForTestQuery = { __typename?: 'Query', savedSearches: { __typename?: 'SavedSearchConnection', edges: Array<{ __typename?: 'SavedSearchEdge', node: { __typename?: 'SavedSearchType', id: string, name?: string | null } }> } };

export type UpdateSavedSearchMutationVariables = Exact<{
  input: UpdateSavedSearchInput;
}>;


export type UpdateSavedSearchMutation = { __typename?: 'Mutation', updateSavedSearch: { __typename?: 'UpdateSavedSearchPayload', success: boolean, savedSearch?: { __typename?: 'SavedSearchType', id: string, name?: string | null, description?: string | null, query?: string | null, entityTypes?: Array<string> | null, tags?: Array<string> | null, filters?: { __typename?: 'SavedSearchFiltersType', eventTypes?: Array<string> | null, startTime?: string | null, endTime?: string | null, datePreset?: string | null, sortBy?: string | null, sortOrder?: string | null, connectors?: Array<string> | null, people?: Array<string> | null, places?: Array<string> | null, hasLocation?: boolean | null, semantic?: boolean | null } | null } | null } };

export type SavedSearchGridItemFragmentFragment = { __typename?: 'SavedSearchType', id: string, name?: string | null, description?: string | null, query?: string | null, entityTypes?: Array<string> | null, tags?: Array<string> | null, isPublic: boolean, shareToken?: string | null, isSeed: boolean, filters?: { __typename?: 'SavedSearchFiltersType', eventTypes?: Array<string> | null, startTime?: string | null, endTime?: string | null, datePreset?: string | null, sortBy?: string | null, sortOrder?: string | null, connectors?: Array<string> | null, people?: Array<string> | null, places?: Array<string> | null, hasLocation?: boolean | null, semantic?: boolean | null } | null } & { ' $fragmentName'?: 'SavedSearchGridItemFragmentFragment' };

export type GetSavedSearchesQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  isSeed?: InputMaybe<Scalars['Boolean']['input']>;
}>;


export type GetSavedSearchesQuery = { __typename?: 'Query', savedSearches: { __typename?: 'SavedSearchConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'SavedSearchEdge', cursor: string, node: (
        { __typename?: 'SavedSearchType', id: string }
        & { ' $fragmentRefs'?: { 'SavedSearchGridItemFragmentFragment': SavedSearchGridItemFragmentFragment } }
      ) }> } };

export type SetSavedSearchSharingMutationVariables = Exact<{
  input: SetSavedSearchSharingInput;
}>;


export type SetSavedSearchSharingMutation = { __typename?: 'Mutation', setSavedSearchSharing: { __typename?: 'UpdateSavedSearchPayload', success: boolean, savedSearch?: (
      { __typename?: 'SavedSearchType', id: string, isPublic: boolean, shareToken?: string | null }
      & { ' $fragmentRefs'?: { 'SavedSearchGridItemFragmentFragment': SavedSearchGridItemFragmentFragment } }
    ) | null } };

export type GetSelfProfileQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetSelfProfileQuery = { __typename?: 'Query', person?: (
    { __typename?: 'PersonType' }
    & { ' $fragmentRefs'?: { 'PersonEditorFieldsFragment': PersonEditorFieldsFragment } }
  ) | null };

export type GetProvidersQueryVariables = Exact<{ [key: string]: never; }>;


export type GetProvidersQuery = { __typename?: 'Query', providers: { __typename?: 'ProviderConnection', edges: Array<{ __typename?: 'ProviderEdge', cursor: string, node: { __typename?: 'ProviderType', id: string, name?: string | null, description?: string | null, logoUrl?: string | null, localOnly: boolean, appSetupUrl?: string | null, authType?: string | null, scopes?: Array<string> | null, providerKeys?: { __typename?: 'ProviderKeyType', id: string, clientId: string, clientSecret: string } | null } }> } };

export type CreateProviderKeyMutationVariables = Exact<{
  input: CreateProviderKeyInput;
}>;


export type CreateProviderKeyMutation = { __typename?: 'Mutation', createProviderKey: { __typename?: 'ProviderKeyType', id: string, providerId: string, clientId: string, clientSecret: string, userId: string } };

export type UpdateProviderKeyMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  input: UpdateProviderKeyInput;
}>;


export type UpdateProviderKeyMutation = { __typename?: 'Mutation', updateProviderKey?: { __typename?: 'ProviderKeyType', id: string, clientId: string, clientSecret: string } | null };

export type DeleteProviderKeyMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type DeleteProviderKeyMutation = { __typename?: 'Mutation', deleteProviderKey: boolean };

export type UpdateCurrentUserTimezoneMutationVariables = Exact<{
  input: UpdateCurrentUserInput;
}>;


export type UpdateCurrentUserTimezoneMutation = { __typename?: 'Mutation', updateCurrentUser?: { __typename?: 'UserType', id: string, timezone: string } | null };

export type GetSharedSavedSearchQueryVariables = Exact<{
  token: Scalars['String']['input'];
}>;


export type GetSharedSavedSearchQuery = { __typename?: 'Query', sharedSavedSearch?: { __typename?: 'SavedSearchType', id: string, name?: string | null, description?: string | null } | null };

export type StatsDailyMetricsQueryVariables = Exact<{
  from: Scalars['String']['input'];
  to: Scalars['String']['input'];
}>;


export type StatsDailyMetricsQuery = { __typename?: 'Query', dailyMetrics: Array<{ __typename?: 'DailyMetricsType', date: string, nMessages?: number | null, nPlaces?: number | null, kmTraveled?: number | null }> };

export type GetSummaryQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetSummaryQuery = { __typename?: 'Query', summary?: { __typename?: 'SummaryType', id: string, title?: string | null, periodType: string, periodStart: any, periodEnd: any, summaryText: string, keyInsights: Array<string>, notableEvents: Array<string>, anomalies: Array<string>, tags: Array<string>, dailyRhythm?: Array<string> | null, productivityPatterns?: Array<string> | null, socialInteractions?: Array<string> | null, keyAccomplishments?: Array<string> | null, moodIndicators?: Array<string> | null, confidenceScore?: number | null, createdAt: any, updatedAt: any, activityCounts: { __typename?: 'ActivityCountsType', total: number, browserActivity?: number | null, communications?: number | null, files?: number | null, events?: number | null, messages?: number | null }, insights: Array<{ __typename?: 'InsightItemType', title: string, summaryText: string, keyActions: Array<string>, relevanceScore: number, tags: Array<string>, relatedEntityIds?: Array<string> | null }> } | null };

export type DeleteTagMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteTagMutation = { __typename?: 'Mutation', deleteTag: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type ListTagsForTestQueryVariables = Exact<{ [key: string]: never; }>;


export type ListTagsForTestQuery = { __typename?: 'Query', tags: { __typename?: 'TagConnection', edges: Array<{ __typename?: 'TagEdge', node: { __typename?: 'TagType', id: string, label: string } }> } };

export type UpdateTagMutationVariables = Exact<{
  input: UpdateTagInput;
}>;


export type UpdateTagMutation = { __typename?: 'Mutation', updateTag: { __typename?: 'UpdateTagPayload', success: boolean, merged: boolean, movedEntityCount: number, updatedSavedSearchCount: number, tag?: { __typename?: 'TagType', id: string, label: string, description?: string | null, entityCount: number } | null } };

export type GetTagsWithUsageQueryVariables = Exact<{ [key: string]: never; }>;


export type GetTagsWithUsageQuery = { __typename?: 'Query', tags: { __typename?: 'TagConnection', edges: Array<{ __typename?: 'TagEdge', node: { __typename?: 'TagType', id: string, label: string, description?: string | null, entityCount: number } }> } };

export type GetUnresolvedObservationsQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
}>;


export type GetUnresolvedObservationsQuery = { __typename?: 'Query', unresolvedObservations: Array<(
    { __typename?: 'ObjectObservationType' }
    & { ' $fragmentRefs'?: { 'ObservationStripDataFragment': ObservationStripDataFragment } }
  )> };

export type SearchThingsForObservationQueryVariables = Exact<{
  query?: InputMaybe<Scalars['String']['input']>;
}>;


export type SearchThingsForObservationQuery = { __typename?: 'Query', items: { __typename?: 'ItemConnection', edges: Array<{ __typename?: 'ItemEdge', node: { __typename?: 'ItemType', id: string, name?: string | null, brand?: string | null, model?: string | null, category?: string | null } }> } };

export type ConfirmUnresolvedObservationMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  itemId?: InputMaybe<Scalars['ID']['input']>;
}>;


export type ConfirmUnresolvedObservationMutation = { __typename?: 'Mutation', confirmObservation?: { __typename?: 'ObjectObservationType', id: string, confirmedByUser: boolean, resolvedObjectId?: string | null, resolutionMethod: ObservationResolutionMethod, resolutionConfidence?: number | null } | null };

export type RejectUnresolvedObservationMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type RejectUnresolvedObservationMutation = { __typename?: 'Mutation', rejectObservation?: { __typename?: 'ObjectObservationType', id: string, confirmedByUser: boolean, resolvedObjectId?: string | null, resolutionMethod: ObservationResolutionMethod, resolutionConfidence?: number | null } | null };

export type GetThingsQueryVariables = Exact<{
  query?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  brand?: InputMaybe<Scalars['String']['input']>;
  condition?: InputMaybe<ItemCondition>;
  lifecycleState?: InputMaybe<ItemLifecycleState>;
  hasIdentifier?: InputMaybe<Scalars['Boolean']['input']>;
  sort?: InputMaybe<ItemSortOrder>;
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetThingsQuery = { __typename?: 'Query', items: { __typename?: 'ItemConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'ItemEdge', cursor: string, node: (
        { __typename?: 'ItemType', id: string, name?: string | null }
        & { ' $fragmentRefs'?: { 'ItemGridItemDataFragment': ItemGridItemDataFragment } }
      ) }> } };

export type GetItemDuplicatesQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
}>;


export type GetItemDuplicatesQuery = { __typename?: 'Query', itemDuplicates: { __typename?: 'ItemDuplicatesPayload', totalCount: number, hasMore: boolean, groups: Array<{ __typename?: 'ItemDuplicateGroupType', reason: ItemDuplicateReason, value: string, totalItems: number, items: Array<{ __typename?: 'ItemType', id: string, name?: string | null, brand?: string | null, model?: string | null, category?: string | null, quantity: number, lifecycleState: ItemLifecycleState }> }> } };

export type MergeThingsMutationVariables = Exact<{
  input: MergeItemsInput;
}>;


export type MergeThingsMutation = { __typename?: 'Mutation', mergeItems: { __typename?: 'MergeItemsPayload', success: boolean, item?: { __typename?: 'ItemType', id: string, name?: string | null } | null, counts?: { __typename?: 'ObjectMergeCountsType', identifiers: number, observations: number, receiptLineItems: number } | null } };

export type RejectThingDuplicatesMutationVariables = Exact<{
  itemIds: Array<Scalars['ID']['input']> | Scalars['ID']['input'];
}>;


export type RejectThingDuplicatesMutation = { __typename?: 'Mutation', rejectItemDuplicates: boolean };

export type GetOAuthCallbackUrlQueryVariables = Exact<{ [key: string]: never; }>;


export type GetOAuthCallbackUrlQuery = { __typename?: 'Query', oAuthCallbackUrl: string };

export const SearchResultCommunicationDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultCommunicationData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","name":{"kind":"Name","value":"time"}}]}}]} as unknown as DocumentNode<SearchResultCommunicationDataFragment, unknown>;
export const SearchResultConceptDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultConceptData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]} as unknown as DocumentNode<SearchResultConceptDataFragment, unknown>;
export const SearchResultContentDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultContentData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}}]}}]} as unknown as DocumentNode<SearchResultContentDataFragment, unknown>;
export const SearchResultEventDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultEventData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}}]}}]} as unknown as DocumentNode<SearchResultEventDataFragment, unknown>;
export const SearchResultFileDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultFileData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}}]}}]} as unknown as DocumentNode<SearchResultFileDataFragment, unknown>;
export const SearchResultItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]} as unknown as DocumentNode<SearchResultItemDataFragment, unknown>;
export const SearchResultNoteDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultNoteData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}}]}}]} as unknown as DocumentNode<SearchResultNoteDataFragment, unknown>;
export const SearchResultPersonDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultPersonData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<SearchResultPersonDataFragment, unknown>;
export const SearchResultPlaceDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultPlaceData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]} as unknown as DocumentNode<SearchResultPlaceDataFragment, unknown>;
export const SearchResultThreadDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultThreadData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<SearchResultThreadDataFragment, unknown>;
export const ObjectIdentifierDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ObjectIdentifierData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ObjectIdentifierType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"qualifier"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]} as unknown as DocumentNode<ObjectIdentifierDataFragment, unknown>;
export const ObservationStripDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ObservationStripData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ObjectObservationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"labelSource"}},{"kind":"Field","name":{"kind":"Name","value":"detector"}},{"kind":"Field","name":{"kind":"Name","value":"detectorVersion"}},{"kind":"Field","name":{"kind":"Name","value":"detectionConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"confirmedByUser"}},{"kind":"Field","name":{"kind":"Name","value":"observedAt"}},{"kind":"Field","name":{"kind":"Name","value":"sourceKind"}},{"kind":"Field","name":{"kind":"Name","value":"placeEntityId"}},{"kind":"Field","name":{"kind":"Name","value":"bbox"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"x"}},{"kind":"Field","name":{"kind":"Name","value":"y"}},{"kind":"Field","name":{"kind":"Name","value":"w"}},{"kind":"Field","name":{"kind":"Name","value":"h"}}]}},{"kind":"Field","name":{"kind":"Name","value":"media"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"place"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]} as unknown as DocumentNode<ObservationStripDataFragment, unknown>;
export const ProductModelCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProductModelCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProductModelType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"manufacturer"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"subcategory"}},{"kind":"Field","name":{"kind":"Name","value":"productType"}},{"kind":"Field","name":{"kind":"Name","value":"isDigital"}},{"kind":"Field","name":{"kind":"Name","value":"msrpMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"identityConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"image"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}}]} as unknown as DocumentNode<ProductModelCardDataFragment, unknown>;
export const ActionGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ActionGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ActionType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","alias":{"kind":"Name","value":"actionTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"actionText"},"name":{"kind":"Name","value":"text"}}]}}]} as unknown as DocumentNode<ActionGridItemDataFragment, unknown>;
export const AnswerGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"AnswerGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"answerSource"}},{"kind":"Field","name":{"kind":"Name","value":"answerConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"answerRationale"}},{"kind":"Field","name":{"kind":"Name","value":"answerEvidence"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<AnswerGridItemDataFragment, unknown>;
export const BrowserActivityGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"BrowserActivityGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]} as unknown as DocumentNode<BrowserActivityGridItemDataFragment, unknown>;
export const CommunicationGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"CommunicationGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]} as unknown as DocumentNode<CommunicationGridItemDataFragment, unknown>;
export const ConceptGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ConceptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<ConceptGridItemDataFragment, unknown>;
export const RichMediaDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}}]} as unknown as DocumentNode<RichMediaDataFragment, unknown>;
export const ContentGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"sourceType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"sourceId"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}}]} as unknown as DocumentNode<ContentGridItemDataFragment, unknown>;
export const EventGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}}]}}]} as unknown as DocumentNode<EventGridItemDataFragment, unknown>;
export const FileChunkGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileChunkGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileChunkType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sectionTitle"}},{"kind":"Field","alias":{"kind":"Name","value":"chunkContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLocator"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}}]}}]}}]} as unknown as DocumentNode<FileChunkGridItemDataFragment, unknown>;
export const FileGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"size"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]} as unknown as DocumentNode<FileGridItemDataFragment, unknown>;
export const ItemGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ItemGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}}]} as unknown as DocumentNode<ItemGridItemDataFragment, unknown>;
export const NoteGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]} as unknown as DocumentNode<NoteGridItemDataFragment, unknown>;
export const PersonGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}}]}}]} as unknown as DocumentNode<PersonGridItemDataFragment, unknown>;
export const PlaceGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PlaceGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}},{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}}]}}]} as unknown as DocumentNode<PlaceGridItemDataFragment, unknown>;
export const ProductGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProductGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProductModelType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","alias":{"kind":"Name","value":"productTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"isDigital"}},{"kind":"Field","name":{"kind":"Name","value":"msrpMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"productCurrency"},"name":{"kind":"Name","value":"currency"}}]}}]} as unknown as DocumentNode<ProductGridItemDataFragment, unknown>;
export const ReceiptGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ReceiptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ReceiptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"merchantName"}},{"kind":"Field","name":{"kind":"Name","value":"purchasedAt"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"receiptCurrency"},"name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"orderNumber"}},{"kind":"Field","name":{"kind":"Name","value":"channel"}},{"kind":"Field","name":{"kind":"Name","value":"extractionState"}},{"kind":"Field","name":{"kind":"Name","value":"lineItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]} as unknown as DocumentNode<ReceiptGridItemDataFragment, unknown>;
export const ThreadGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ThreadGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<ThreadGridItemDataFragment, unknown>;
export const PersonEditorFieldsFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonEditorFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"middleName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"nickname"}},{"kind":"Field","name":{"kind":"Name","value":"pronouns"}},{"kind":"Field","name":{"kind":"Name","value":"gender"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}},{"kind":"Field","name":{"kind":"Name","value":"jobTitle"}},{"kind":"Field","name":{"kind":"Name","value":"organization"}},{"kind":"Field","name":{"kind":"Name","value":"department"}},{"kind":"Field","name":{"kind":"Name","value":"website"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"addresses"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress2"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"region"}},{"kind":"Field","name":{"kind":"Name","value":"postalCode"}},{"kind":"Field","name":{"kind":"Name","value":"country"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"formatted"}}]}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}}]}}]}}]} as unknown as DocumentNode<PersonEditorFieldsFragment, unknown>;
export const FeedBadgeActionFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FeedBadgeAction"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ActionType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}}]} as unknown as DocumentNode<FeedBadgeActionFragment, unknown>;
export const FeedBadgeSummaryFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FeedBadgeSummary"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SummaryType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}}]} as unknown as DocumentNode<FeedBadgeSummaryFragment, unknown>;
export const ContentTileFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentTileFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}}]} as unknown as DocumentNode<ContentTileFragmentFragment, unknown>;
export const EventContentTileFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventContentTile"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}}]} as unknown as DocumentNode<EventContentTileFragment, unknown>;
export const InsightCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"InsightCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"InsightItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyActions"}},{"kind":"Field","name":{"kind":"Name","value":"relevanceScore"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"relatedEntityIds"}}]}}]} as unknown as DocumentNode<InsightCardDataFragment, unknown>;
export const SummaryCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SummaryCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SummaryType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"periodType"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyInsights"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"activityCounts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"total"}}]}}]}}]} as unknown as DocumentNode<SummaryCardDataFragment, unknown>;
export const TimelineBrowserActivityCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineBrowserActivityCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"actionType"}},{"kind":"Field","name":{"kind":"Name","value":"duration"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]} as unknown as DocumentNode<TimelineBrowserActivityCardDataFragment, unknown>;
export const TimelineCommunicationCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineCommunicationCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","alias":{"kind":"Name","value":"communicationContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"to"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]} as unknown as DocumentNode<TimelineCommunicationCardDataFragment, unknown>;
export const TimelineEventCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineEventCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"timeSource"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"location"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}},{"kind":"Field","name":{"kind":"Name","value":"mediaWidth"}},{"kind":"Field","name":{"kind":"Name","value":"mediaHeight"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"contents"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"IntValue","value":"3"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}}]} as unknown as DocumentNode<TimelineEventCardDataFragment, unknown>;
export const TimelineFileChunkCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineFileChunkCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileChunkType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sectionTitle"}},{"kind":"Field","alias":{"kind":"Name","value":"chunkContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLocator"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}}]} as unknown as DocumentNode<TimelineFileChunkCardDataFragment, unknown>;
export const TableAnswerRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableAnswerRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<TableAnswerRowDataFragment, unknown>;
export const TableBrowserActivityRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableBrowserActivityRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]} as unknown as DocumentNode<TableBrowserActivityRowDataFragment, unknown>;
export const TableCommunicationRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableCommunicationRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}}]} as unknown as DocumentNode<TableCommunicationRowDataFragment, unknown>;
export const TableConceptRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableConceptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TableConceptRowDataFragment, unknown>;
export const TableContentRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableContentRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]} as unknown as DocumentNode<TableContentRowDataFragment, unknown>;
export const TableEventRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableEventRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}}]}}]} as unknown as DocumentNode<TableEventRowDataFragment, unknown>;
export const TableFileChunkRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileChunkRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileChunkType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sectionTitle"}},{"kind":"Field","alias":{"kind":"Name","value":"chunkContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLocator"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}}]}}]}}]} as unknown as DocumentNode<TableFileChunkRowDataFragment, unknown>;
export const TableFileRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}}]}}]} as unknown as DocumentNode<TableFileRowDataFragment, unknown>;
export const TableItemRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableItemRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}}]} as unknown as DocumentNode<TableItemRowDataFragment, unknown>;
export const TableNoteRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableNoteRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<TableNoteRowDataFragment, unknown>;
export const TablePersonRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePersonRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TablePersonRowDataFragment, unknown>;
export const TablePlaceRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePlaceRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TablePlaceRowDataFragment, unknown>;
export const TableProductRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableProductRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProductModelType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","alias":{"kind":"Name","value":"productTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"msrpMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"productCurrency"},"name":{"kind":"Name","value":"currency"}}]}}]} as unknown as DocumentNode<TableProductRowDataFragment, unknown>;
export const TableReceiptRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableReceiptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ReceiptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"merchantName"}},{"kind":"Field","name":{"kind":"Name","value":"purchasedAt"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"receiptCurrency"},"name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"lineItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]} as unknown as DocumentNode<TableReceiptRowDataFragment, unknown>;
export const TableThreadRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableThreadRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TableThreadRowDataFragment, unknown>;
export const NewNoteFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NewNote"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]} as unknown as DocumentNode<NewNoteFragment, unknown>;
export const NoteGridItemFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<NoteGridItemFragmentFragment, unknown>;
export const TaskRowFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TaskRowFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TaskType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"dueAt"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"placedOnCalendar"}},{"kind":"Field","name":{"kind":"Name","value":"deferUntil"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}}]}}]} as unknown as DocumentNode<TaskRowFragmentFragment, unknown>;
export const ProviderEndpointsFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProviderEndpointsFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProviderType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<ProviderEndpointsFragmentFragment, unknown>;
export const SavedSearchGridItemFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SavedSearchGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SavedSearchType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"filters"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventTypes"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"datePreset"}},{"kind":"Field","name":{"kind":"Name","value":"sortBy"}},{"kind":"Field","name":{"kind":"Name","value":"sortOrder"}},{"kind":"Field","name":{"kind":"Name","value":"connectors"}},{"kind":"Field","name":{"kind":"Name","value":"people"}},{"kind":"Field","name":{"kind":"Name","value":"places"}},{"kind":"Field","name":{"kind":"Name","value":"hasLocation"}},{"kind":"Field","name":{"kind":"Name","value":"semantic"}}]}},{"kind":"Field","name":{"kind":"Name","value":"isPublic"}},{"kind":"Field","name":{"kind":"Name","value":"shareToken"}},{"kind":"Field","name":{"kind":"Name","value":"isSeed"}}]}}]} as unknown as DocumentNode<SavedSearchGridItemFragmentFragment, unknown>;
export const GetFeedActionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetFeedActions"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"feedActions"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"imageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"context"}},{"kind":"Field","name":{"kind":"Name","value":"relatedPerson"}}]}},{"kind":"Field","name":{"kind":"Name","value":"thread"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]}}]} as unknown as DocumentNode<GetFeedActionsQuery, GetFeedActionsQueryVariables>;
export const MarkActionAsSeenDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkActionAsSeen"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markActionAsSeen"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}}]}}]}}]} as unknown as DocumentNode<MarkActionAsSeenMutation, MarkActionAsSeenMutationVariables>;
export const MarkActionAsDismissedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkActionAsDismissed"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markActionAsDismissed"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}}]}}]} as unknown as DocumentNode<MarkActionAsDismissedMutation, MarkActionAsDismissedMutationVariables>;
export const GetForecastDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetForecast"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"horizon"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"forecast"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"horizon"},"value":{"kind":"Variable","name":{"kind":"Name","value":"horizon"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"horizon"}},{"kind":"Field","name":{"kind":"Name","value":"generatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"systemStatus"}},{"kind":"Field","name":{"kind":"Name","value":"modelVersion"}},{"kind":"Field","name":{"kind":"Name","value":"stillLearning"}},{"kind":"Field","name":{"kind":"Name","value":"pipelineEtaSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"pipelineDetail"}},{"kind":"Field","name":{"kind":"Name","value":"buckets"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"bucketIndex"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"l0Probs"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"probability"}}]}},{"kind":"Field","name":{"kind":"Name","value":"l1Probs"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"probability"}}]}},{"kind":"Field","name":{"kind":"Name","value":"l2Probs"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"probability"}}]}},{"kind":"Field","name":{"kind":"Name","value":"q10"}},{"kind":"Field","name":{"kind":"Name","value":"q50"}},{"kind":"Field","name":{"kind":"Name","value":"q90"}}]}}]}}]}}]} as unknown as DocumentNode<GetForecastQuery, GetForecastQueryVariables>;
export const RescheduleEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RescheduleEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"rescheduleEvent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"startTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}}},{"kind":"Argument","name":{"kind":"Name","value":"endTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"externalSyncStatus"}}]}}]}}]} as unknown as DocumentNode<RescheduleEventMutation, RescheduleEventMutationVariables>;
export const GetScheduleCandidatesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetScheduleCandidates"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"from"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"to"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"scheduleCandidates"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"from"},"value":{"kind":"Variable","name":{"kind":"Name","value":"from"}}},{"kind":"Argument","name":{"kind":"Name","value":"to"},"value":{"kind":"Variable","name":{"kind":"Name","value":"to"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"rationale"}},{"kind":"Field","name":{"kind":"Name","value":"rationaleSources"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"note"}}]}},{"kind":"Field","name":{"kind":"Name","value":"windowStart"}},{"kind":"Field","name":{"kind":"Name","value":"windowEnd"}},{"kind":"Field","name":{"kind":"Name","value":"timeFlex"}},{"kind":"Field","name":{"kind":"Name","value":"durationMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"l0Class"}},{"kind":"Field","name":{"kind":"Name","value":"fitScore"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"generator"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}},{"kind":"Field","name":{"kind":"Name","value":"personalization"}}]}}]}}]} as unknown as DocumentNode<GetScheduleCandidatesQuery, GetScheduleCandidatesQueryVariables>;
export const SyncScheduleSuggestionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SyncScheduleSuggestions"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"syncScheduleSuggestions"}}]}}]} as unknown as DocumentNode<SyncScheduleSuggestionsMutation, SyncScheduleSuggestionsMutationVariables>;
export const AcceptCandidateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"AcceptCandidate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"acceptCandidate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"startTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}}},{"kind":"Argument","name":{"kind":"Name","value":"endTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<AcceptCandidateMutation, AcceptCandidateMutationVariables>;
export const DeclineCandidateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeclineCandidate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"reason"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"declineCandidate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"reason"},"value":{"kind":"Variable","name":{"kind":"Name","value":"reason"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<DeclineCandidateMutation, DeclineCandidateMutationVariables>;
export const SnoozeCandidateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SnoozeCandidate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"until"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"snoozeCandidate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"until"},"value":{"kind":"Variable","name":{"kind":"Name","value":"until"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<SnoozeCandidateMutation, SnoozeCandidateMutationVariables>;
export const BreakDownTasksDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"BreakDownTasks"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"text"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"breakDownTasks"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"text"},"value":{"kind":"Variable","name":{"kind":"Name","value":"text"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}}]}}]}}]} as unknown as DocumentNode<BreakDownTasksMutation, BreakDownTasksMutationVariables>;
export const ReturnEventToSlateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ReturnEventToSlate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"returnEventToSlate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"eventId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"eventId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<ReturnEventToSlateMutation, ReturnEventToSlateMutationVariables>;
export const GetScheduleDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSchedule"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"from"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"to"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventsInRange"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"from"},"value":{"kind":"Variable","name":{"kind":"Name","value":"from"}}},{"kind":"Argument","name":{"kind":"Name","value":"to"},"value":{"kind":"Variable","name":{"kind":"Name","value":"to"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"isAllDay"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"externalSyncStatus"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}}]}},{"kind":"Field","name":{"kind":"Name","value":"weekForecast"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"includeToday"},"value":{"kind":"BooleanValue","value":true}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"generatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"days"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"dow"}},{"kind":"Field","name":{"kind":"Name","value":"clusters"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"clusterId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"l0Class"}},{"kind":"Field","name":{"kind":"Name","value":"pOccur"}},{"kind":"Field","name":{"kind":"Name","value":"scheduled"}},{"kind":"Field","name":{"kind":"Name","value":"daypartProbs"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"probability"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetScheduleQuery, GetScheduleQueryVariables>;
export const TagEntitiesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"TagEntities"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TagEntitiesInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tagEntities"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Taggable"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]} as unknown as DocumentNode<TagEntitiesMutation, TagEntitiesMutationVariables>;
export const UntagEntitiesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UntagEntities"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TagEntitiesInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"untagEntities"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Taggable"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]} as unknown as DocumentNode<UntagEntitiesMutation, UntagEntitiesMutationVariables>;
export const TriggerHbpeDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"TriggerHbpe"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"triggerHbpe"}}]}}]} as unknown as DocumentNode<TriggerHbpeMutation, TriggerHbpeMutationVariables>;
export const GetWeekAheadDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetWeekAhead"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"weekForecast"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"horizon"}},{"kind":"Field","name":{"kind":"Name","value":"generatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"days"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"dow"}},{"kind":"Field","name":{"kind":"Name","value":"clusters"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"clusterId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"l0Class"}},{"kind":"Field","name":{"kind":"Name","value":"pOccur"}},{"kind":"Field","name":{"kind":"Name","value":"scheduled"}},{"kind":"Field","name":{"kind":"Name","value":"daypartProbs"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"probability"}}]}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"dueForecast"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"generatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"due"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"clusterId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"l0Class"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeen"}},{"kind":"Field","name":{"kind":"Name","value":"daysSinceLast"}},{"kind":"Field","name":{"kind":"Name","value":"medianIntervalDays"}},{"kind":"Field","name":{"kind":"Name","value":"dueInDays"}},{"kind":"Field","name":{"kind":"Name","value":"window"}},{"kind":"Field","name":{"kind":"Name","value":"overdue"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledDate"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}}]}}]}}]}}]} as unknown as DocumentNode<GetWeekAheadQuery, GetWeekAheadQueryVariables>;
export const GetTagsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetTags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetTagsQuery, GetTagsQueryVariables>;
export const WhatBarEventTypesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"WhatBarEventTypes"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventTypes"}}]}}]} as unknown as DocumentNode<WhatBarEventTypesQuery, WhatBarEventTypesQueryVariables>;
export const ReverseGeocodeDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ReverseGeocode"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"latitude"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Float"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"longitude"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Float"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"reverseGeocode"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"latitude"},"value":{"kind":"Variable","name":{"kind":"Name","value":"latitude"}}},{"kind":"Argument","name":{"kind":"Name","value":"longitude"},"value":{"kind":"Variable","name":{"kind":"Name","value":"longitude"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"placeName"}}]}}]}}]} as unknown as DocumentNode<ReverseGeocodeQuery, ReverseGeocodeQueryVariables>;
export const SourceSystemsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"SourceSystems"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sourceSystems"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"includeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}}},{"kind":"Argument","name":{"kind":"Name","value":"excludeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}}}]}]}}]} as unknown as DocumentNode<SourceSystemsQuery, SourceSystemsQueryVariables>;
export const EventTypesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"EventTypes"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventTypes"}}]}}]} as unknown as DocumentNode<EventTypesQuery, EventTypesQueryVariables>;
export const SearchBoxQueryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"SearchBoxQuery"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"semantic"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Boolean"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"search"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"includeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"excludeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"semantic"},"value":{"kind":"Variable","name":{"kind":"Name","value":"semantic"}}}]}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"matchingTags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"filterName"},"name":{"kind":"Name","value":"name"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"filterName"},"name":{"kind":"Name","value":"name"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultCommunicationData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultConceptData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultContentData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultEventData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultFileData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultNoteData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultPersonData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultPlaceData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultThreadData"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultCommunicationData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","name":{"kind":"Name","value":"time"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultConceptData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultContentData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultEventData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultFileData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultNoteData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultPersonData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultPlaceData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultThreadData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<SearchBoxQueryQuery, SearchBoxQueryQueryVariables>;
export const CreateEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateEventInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createEvent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}}]}}]}}]} as unknown as DocumentNode<CreateEventMutation, CreateEventMutationVariables>;
export const GetConnectionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"schedule"}},{"kind":"Field","name":{"kind":"Name","value":"tokenExpiry"}},{"kind":"Field","name":{"kind":"Name","value":"syncState"}},{"kind":"Field","name":{"kind":"Name","value":"activeEndpoints"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}},{"kind":"Field","name":{"kind":"Name","value":"needsReauth"}},{"kind":"Field","name":{"kind":"Name","value":"externalId"}},{"kind":"Field","name":{"kind":"Name","value":"accountLabel"}},{"kind":"Field","name":{"kind":"Name","value":"provider"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"localOnly"}},{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"hasPreviousPage"}},{"kind":"Field","name":{"kind":"Name","value":"startCursor"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"totalCount"}}]}}]}}]} as unknown as DocumentNode<GetConnectionsQuery, GetConnectionsQueryVariables>;
export const GetConnectionsForOnboardingDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConnectionsForOnboarding"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"needsReauth"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}},{"kind":"Field","name":{"kind":"Name","value":"syncState"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetConnectionsForOnboardingQuery, GetConnectionsForOnboardingQueryVariables>;
export const AddItemIdentifierDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"AddItemIdentifier"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"AddItemIdentifierInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"addItemIdentifier"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ObjectIdentifierData"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ObjectIdentifierData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ObjectIdentifierType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"qualifier"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]} as unknown as DocumentNode<AddItemIdentifierMutation, AddItemIdentifierMutationVariables>;
export const RemoveItemIdentifierDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RemoveItemIdentifier"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RemoveItemIdentifierInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"removeItemIdentifier"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ObjectIdentifierData"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ObjectIdentifierData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ObjectIdentifierType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"qualifier"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]} as unknown as DocumentNode<RemoveItemIdentifierMutation, RemoveItemIdentifierMutationVariables>;
export const ObjectByIdentifierLookupDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ObjectByIdentifierLookup"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"namespace"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ObjectIdentifierNamespace"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"value"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"objectByIdentifier"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"namespace"},"value":{"kind":"Variable","name":{"kind":"Name","value":"namespace"}}},{"kind":"Argument","name":{"kind":"Name","value":"value"},"value":{"kind":"Variable","name":{"kind":"Name","value":"value"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"matched"}},{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"subjectType"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}},{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}}]}}]}}]} as unknown as DocumentNode<ObjectByIdentifierLookupQuery, ObjectByIdentifierLookupQueryVariables>;
export const MergeItemsFromIdentifierDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MergeItemsFromIdentifier"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"MergeItemsInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"mergeItems"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}}]} as unknown as DocumentNode<MergeItemsFromIdentifierMutation, MergeItemsFromIdentifierMutationVariables>;
export const GetItemDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetItem"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"item"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"subcategory"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"purchasePrice"}},{"kind":"Field","name":{"kind":"Name","value":"condition"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identityConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"isDigital"}},{"kind":"Field","name":{"kind":"Name","value":"acquiredAt"}},{"kind":"Field","name":{"kind":"Name","value":"acquisitionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"acquiredFrom"}},{"kind":"Field","name":{"kind":"Name","value":"manufacturedAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"lengthMm"}},{"kind":"Field","name":{"kind":"Name","value":"widthMm"}},{"kind":"Field","name":{"kind":"Name","value":"heightMm"}},{"kind":"Field","name":{"kind":"Name","value":"massG"}},{"kind":"Field","name":{"kind":"Name","value":"volumeMl"}},{"kind":"Field","name":{"kind":"Name","value":"unitSystem"}},{"kind":"Field","name":{"kind":"Name","value":"colors"}},{"kind":"Field","name":{"kind":"Name","value":"colorHex"}},{"kind":"Field","name":{"kind":"Name","value":"materials"}},{"kind":"Field","name":{"kind":"Name","value":"composition"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ObjectIdentifierData"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ProductModelCardData"}}]}},{"kind":"Field","name":{"kind":"Name","value":"observations"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ObservationStripData"}}]}},{"kind":"Field","name":{"kind":"Name","value":"acquisition"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"receiptId"}},{"kind":"Field","name":{"kind":"Name","value":"lineNumber"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"unitPriceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"totalPriceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"isPhysical"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ObjectIdentifierData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ObjectIdentifierType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"qualifier"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProductModelCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProductModelType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"manufacturer"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"subcategory"}},{"kind":"Field","name":{"kind":"Name","value":"productType"}},{"kind":"Field","name":{"kind":"Name","value":"isDigital"}},{"kind":"Field","name":{"kind":"Name","value":"msrpMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"identityConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"image"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ObservationStripData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ObjectObservationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"labelSource"}},{"kind":"Field","name":{"kind":"Name","value":"detector"}},{"kind":"Field","name":{"kind":"Name","value":"detectorVersion"}},{"kind":"Field","name":{"kind":"Name","value":"detectionConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"confirmedByUser"}},{"kind":"Field","name":{"kind":"Name","value":"observedAt"}},{"kind":"Field","name":{"kind":"Name","value":"sourceKind"}},{"kind":"Field","name":{"kind":"Name","value":"placeEntityId"}},{"kind":"Field","name":{"kind":"Name","value":"bbox"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"x"}},{"kind":"Field","name":{"kind":"Name","value":"y"}},{"kind":"Field","name":{"kind":"Name","value":"w"}},{"kind":"Field","name":{"kind":"Name","value":"h"}}]}},{"kind":"Field","name":{"kind":"Name","value":"media"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"place"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]} as unknown as DocumentNode<GetItemQuery, GetItemQueryVariables>;
export const CreateConceptDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateConcept"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateConceptInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createConcept"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"concept"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]} as unknown as DocumentNode<CreateConceptMutation, CreateConceptMutationVariables>;
export const CreatePersonDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreatePerson"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreatePersonInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createPerson"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"person"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]} as unknown as DocumentNode<CreatePersonMutation, CreatePersonMutationVariables>;
export const CreatePlaceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreatePlace"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreatePlaceInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createPlace"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"placeKind"}},{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}}]}}]}}]} as unknown as DocumentNode<CreatePlaceMutation, CreatePlaceMutationVariables>;
export const CreateRelationshipDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateRelationship"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateRelationshipInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createRelationship"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"relationship"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"fromNodeId"}},{"kind":"Field","name":{"kind":"Name","value":"fromNodeType"}},{"kind":"Field","name":{"kind":"Name","value":"toNodeId"}},{"kind":"Field","name":{"kind":"Name","value":"toNodeType"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}},{"kind":"Field","name":{"kind":"Name","value":"isBidirectional"}},{"kind":"Field","name":{"kind":"Name","value":"startDate"}},{"kind":"Field","name":{"kind":"Name","value":"endDate"}}]}}]}}]}}]} as unknown as DocumentNode<CreateRelationshipMutation, CreateRelationshipMutationVariables>;
export const GetPersonForEditDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPersonForEdit"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"person"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonEditorFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonEditorFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"middleName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"nickname"}},{"kind":"Field","name":{"kind":"Name","value":"pronouns"}},{"kind":"Field","name":{"kind":"Name","value":"gender"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}},{"kind":"Field","name":{"kind":"Name","value":"jobTitle"}},{"kind":"Field","name":{"kind":"Name","value":"organization"}},{"kind":"Field","name":{"kind":"Name","value":"department"}},{"kind":"Field","name":{"kind":"Name","value":"website"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"addresses"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress2"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"region"}},{"kind":"Field","name":{"kind":"Name","value":"postalCode"}},{"kind":"Field","name":{"kind":"Name","value":"country"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"formatted"}}]}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}}]}}]}}]} as unknown as DocumentNode<GetPersonForEditQuery, GetPersonForEditQueryVariables>;
export const UpdatePersonProfileDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdatePersonProfile"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdatePersonInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updatePerson"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"person"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonEditorFields"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonEditorFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"middleName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"nickname"}},{"kind":"Field","name":{"kind":"Name","value":"pronouns"}},{"kind":"Field","name":{"kind":"Name","value":"gender"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}},{"kind":"Field","name":{"kind":"Name","value":"jobTitle"}},{"kind":"Field","name":{"kind":"Name","value":"organization"}},{"kind":"Field","name":{"kind":"Name","value":"department"}},{"kind":"Field","name":{"kind":"Name","value":"website"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"addresses"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress2"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"region"}},{"kind":"Field","name":{"kind":"Name","value":"postalCode"}},{"kind":"Field","name":{"kind":"Name","value":"country"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"formatted"}}]}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}}]}}]}}]} as unknown as DocumentNode<UpdatePersonProfileMutation, UpdatePersonProfileMutationVariables>;
export const ScanObjectByIdentifierDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ScanObjectByIdentifier"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"namespace"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ObjectIdentifierNamespace"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"value"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"objectByIdentifier"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"namespace"},"value":{"kind":"Variable","name":{"kind":"Name","value":"namespace"}}},{"kind":"Argument","name":{"kind":"Name","value":"value"},"value":{"kind":"Variable","name":{"kind":"Name","value":"value"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"matched"}},{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"subjectType"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}},{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}}]}}]}}]} as unknown as DocumentNode<ScanObjectByIdentifierQuery, ScanObjectByIdentifierQueryVariables>;
export const CreateItemDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateItem"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateItemInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createItem"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"purchasePrice"}},{"kind":"Field","name":{"kind":"Name","value":"condition"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"acquiredAt"}},{"kind":"Field","name":{"kind":"Name","value":"acquisitionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"acquiredFrom"}},{"kind":"Field","name":{"kind":"Name","value":"manufacturedAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"lengthMm"}},{"kind":"Field","name":{"kind":"Name","value":"widthMm"}},{"kind":"Field","name":{"kind":"Name","value":"heightMm"}},{"kind":"Field","name":{"kind":"Name","value":"massG"}},{"kind":"Field","name":{"kind":"Name","value":"volumeMl"}},{"kind":"Field","name":{"kind":"Name","value":"unitSystem"}},{"kind":"Field","name":{"kind":"Name","value":"colors"}},{"kind":"Field","name":{"kind":"Name","value":"colorHex"}},{"kind":"Field","name":{"kind":"Name","value":"materials"}},{"kind":"Field","name":{"kind":"Name","value":"composition"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"success"}}]}}]}}]} as unknown as DocumentNode<CreateItemMutation, CreateItemMutationVariables>;
export const UpdateItemDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateItem"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateItemInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateItem"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"purchasePrice"}},{"kind":"Field","name":{"kind":"Name","value":"condition"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"acquiredAt"}},{"kind":"Field","name":{"kind":"Name","value":"acquisitionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"acquiredFrom"}},{"kind":"Field","name":{"kind":"Name","value":"manufacturedAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"lengthMm"}},{"kind":"Field","name":{"kind":"Name","value":"widthMm"}},{"kind":"Field","name":{"kind":"Name","value":"heightMm"}},{"kind":"Field","name":{"kind":"Name","value":"massG"}},{"kind":"Field","name":{"kind":"Name","value":"volumeMl"}},{"kind":"Field","name":{"kind":"Name","value":"unitSystem"}},{"kind":"Field","name":{"kind":"Name","value":"colors"}},{"kind":"Field","name":{"kind":"Name","value":"colorHex"}},{"kind":"Field","name":{"kind":"Name","value":"materials"}},{"kind":"Field","name":{"kind":"Name","value":"composition"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"success"}}]}}]}}]} as unknown as DocumentNode<UpdateItemMutation, UpdateItemMutationVariables>;
export const GetUserDataDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetUserData"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"me"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"onboarded"}},{"kind":"Field","name":{"kind":"Name","value":"needsIdentityStep"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"entity"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]}}]} as unknown as DocumentNode<GetUserDataQuery, GetUserDataQueryVariables>;
export const GetFeedBadgeCountDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetFeedBadgeCount"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"actionLimit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"summaryFirst"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"feedActions"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"actionLimit"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FeedBadgeAction"}}]}},{"kind":"Field","name":{"kind":"Name","value":"summaries"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"summaryFirst"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FeedBadgeSummary"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FeedBadgeAction"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ActionType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FeedBadgeSummary"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SummaryType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}}]} as unknown as DocumentNode<GetFeedBadgeCountQuery, GetFeedBadgeCountQueryVariables>;
export const GetPlanBadgeCountDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPlanBadgeCount"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tasks"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"taskPendingChanges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"taskId"}}]}}]}}]} as unknown as DocumentNode<GetPlanBadgeCountQuery, GetPlanBadgeCountQueryVariables>;
export const AskInboxDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AskInbox"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"askInbox"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"consentBasis"}},{"kind":"Field","name":{"kind":"Name","value":"askerId"}},{"kind":"Field","name":{"kind":"Name","value":"peerHandle"}},{"kind":"Field","name":{"kind":"Name","value":"query"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"queryType"}},{"kind":"Field","name":{"kind":"Name","value":"dataClass"}},{"kind":"Field","name":{"kind":"Name","value":"prompt"}},{"kind":"Field","name":{"kind":"Name","value":"purpose"}},{"kind":"Field","name":{"kind":"Name","value":"actor"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]} as unknown as DocumentNode<AskInboxQuery, AskInboxQueryVariables>;
export const AskOutboxDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AskOutbox"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"askOutbox"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"responderId"}},{"kind":"Field","name":{"kind":"Name","value":"peerHandle"}},{"kind":"Field","name":{"kind":"Name","value":"query"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"queryType"}},{"kind":"Field","name":{"kind":"Name","value":"dataClass"}},{"kind":"Field","name":{"kind":"Name","value":"prompt"}},{"kind":"Field","name":{"kind":"Name","value":"purpose"}},{"kind":"Field","name":{"kind":"Name","value":"actor"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]} as unknown as DocumentNode<AskOutboxQuery, AskOutboxQueryVariables>;
export const MyAskGrantsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyAskGrants"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myAskGrants"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"mode"}},{"kind":"Field","name":{"kind":"Name","value":"queryType"}},{"kind":"Field","name":{"kind":"Name","value":"dataClass"}},{"kind":"Field","name":{"kind":"Name","value":"purpose"}},{"kind":"Field","name":{"kind":"Name","value":"granteeId"}},{"kind":"Field","name":{"kind":"Name","value":"granteePeerLinkId"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"useCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastUsedAt"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]} as unknown as DocumentNode<MyAskGrantsQuery, MyAskGrantsQueryVariables>;
export const ApproveAskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ApproveAsk"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"approveAsk"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}}]}}]}}]} as unknown as DocumentNode<ApproveAskMutation, ApproveAskMutationVariables>;
export const DeclineAskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeclineAsk"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"declineAsk"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}}]}}]}}]} as unknown as DocumentNode<DeclineAskMutation, DeclineAskMutationVariables>;
export const RunAskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RunAsk"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"redactItemIds"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"disclosureForm"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerForm"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"runAsk"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"redactItemIds"},"value":{"kind":"Variable","name":{"kind":"Name","value":"redactItemIds"}}},{"kind":"Argument","name":{"kind":"Name","value":"disclosureForm"},"value":{"kind":"Variable","name":{"kind":"Name","value":"disclosureForm"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"disclosedCount"}},{"kind":"Field","name":{"kind":"Name","value":"withheldCount"}}]}}]}}]} as unknown as DocumentNode<RunAskMutation, RunAskMutationVariables>;
export const MyAskAddressDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyAskAddress"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"me"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]} as unknown as DocumentNode<MyAskAddressQuery, MyAskAddressQueryVariables>;
export const CreateAskGrantDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateAskGrant"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateAskGrantInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createAskGrant"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"grant"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"mode"}},{"kind":"Field","name":{"kind":"Name","value":"queryType"}},{"kind":"Field","name":{"kind":"Name","value":"dataClass"}},{"kind":"Field","name":{"kind":"Name","value":"purpose"}},{"kind":"Field","name":{"kind":"Name","value":"granteeId"}},{"kind":"Field","name":{"kind":"Name","value":"granteePeerLinkId"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]}}]} as unknown as DocumentNode<CreateAskGrantMutation, CreateAskGrantMutationVariables>;
export const RevokeAskGrantDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RevokeAskGrant"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"revokeAskGrant"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}}]}}]}}]} as unknown as DocumentNode<RevokeAskGrantMutation, RevokeAskGrantMutationVariables>;
export const UpdateAskGrantDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateAskGrant"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateAskGrantInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateAskGrant"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"grant"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"mode"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}},{"kind":"Field","name":{"kind":"Name","value":"supersedesGrantId"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateAskGrantMutation, UpdateAskGrantMutationVariables>;
export const AskDisclosureHistoryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AskDisclosureHistory"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"AskDisclosureHistoryInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"askDisclosureHistory"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"truncated"}},{"kind":"Field","name":{"kind":"Name","value":"rows"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"askId"}},{"kind":"Field","name":{"kind":"Name","value":"askerId"}},{"kind":"Field","name":{"kind":"Name","value":"peerHandle"}},{"kind":"Field","name":{"kind":"Name","value":"responderId"}},{"kind":"Field","name":{"kind":"Name","value":"consentBasis"}},{"kind":"Field","name":{"kind":"Name","value":"outcome"}},{"kind":"Field","name":{"kind":"Name","value":"disclosedCount"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"query"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"queryType"}},{"kind":"Field","name":{"kind":"Name","value":"dataClass"}},{"kind":"Field","name":{"kind":"Name","value":"prompt"}},{"kind":"Field","name":{"kind":"Name","value":"purpose"}},{"kind":"Field","name":{"kind":"Name","value":"actor"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<AskDisclosureHistoryQuery, AskDisclosureHistoryQueryVariables>;
export const AskDisclosureSummaryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AskDisclosureSummary"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"AskDisclosureSummaryInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"askDisclosureSummary"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"truncated"}},{"kind":"Field","name":{"kind":"Name","value":"summaries"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"askerId"}},{"kind":"Field","name":{"kind":"Name","value":"peerLinkId"}},{"kind":"Field","name":{"kind":"Name","value":"peerHandle"}},{"kind":"Field","name":{"kind":"Name","value":"total"}},{"kind":"Field","name":{"kind":"Name","value":"autoAnswered"}},{"kind":"Field","name":{"kind":"Name","value":"reviewed"}},{"kind":"Field","name":{"kind":"Name","value":"declined"}},{"kind":"Field","name":{"kind":"Name","value":"expired"}},{"kind":"Field","name":{"kind":"Name","value":"itemsDisclosed"}},{"kind":"Field","name":{"kind":"Name","value":"asksInWindow"}},{"kind":"Field","name":{"kind":"Name","value":"itemsInWindow"}},{"kind":"Field","name":{"kind":"Name","value":"firstAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastAt"}}]}}]}}]}}]} as unknown as DocumentNode<AskDisclosureSummaryQuery, AskDisclosureSummaryQueryVariables>;
export const AskAnswerDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AskAnswer"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"askAnswer"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"askId"}},{"kind":"Field","name":{"kind":"Name","value":"form"}},{"kind":"Field","name":{"kind":"Name","value":"answerSource"}},{"kind":"Field","name":{"kind":"Name","value":"summary"}},{"kind":"Field","name":{"kind":"Name","value":"disclosedCount"}},{"kind":"Field","name":{"kind":"Name","value":"withheldCount"}},{"kind":"Field","name":{"kind":"Name","value":"consentBasis"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}}]}}]}}]}}]} as unknown as DocumentNode<AskAnswerQuery, AskAnswerQueryVariables>;
export const CreateAskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateAsk"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateAskInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createAsk"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"ask"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"responderId"}},{"kind":"Field","name":{"kind":"Name","value":"peerHandle"}},{"kind":"Field","name":{"kind":"Name","value":"query"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"queryType"}},{"kind":"Field","name":{"kind":"Name","value":"dataClass"}},{"kind":"Field","name":{"kind":"Name","value":"prompt"}},{"kind":"Field","name":{"kind":"Name","value":"purpose"}},{"kind":"Field","name":{"kind":"Name","value":"actor"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<CreateAskMutation, CreateAskMutationVariables>;
export const MyPeerLinksDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyPeerLinks"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myPeerLinks"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"peerHandle"}},{"kind":"Field","name":{"kind":"Name","value":"displayName"}},{"kind":"Field","name":{"kind":"Name","value":"memoryEndpoint"}},{"kind":"Field","name":{"kind":"Name","value":"personEntityId"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"trustTier"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]} as unknown as DocumentNode<MyPeerLinksQuery, MyPeerLinksQueryVariables>;
export const CreatePeerLinkDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreatePeerLink"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreatePeerLinkInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createPeerLink"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"peerLink"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"peerHandle"}},{"kind":"Field","name":{"kind":"Name","value":"displayName"}},{"kind":"Field","name":{"kind":"Name","value":"memoryEndpoint"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"trustTier"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}}]}}]}}]}}]} as unknown as DocumentNode<CreatePeerLinkMutation, CreatePeerLinkMutationVariables>;
export const UpdatePeerLinkDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdatePeerLink"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdatePeerLinkInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updatePeerLink"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"peerLink"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"peerHandle"}},{"kind":"Field","name":{"kind":"Name","value":"displayName"}},{"kind":"Field","name":{"kind":"Name","value":"memoryEndpoint"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"trustTier"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}}]}}]}}]}}]} as unknown as DocumentNode<UpdatePeerLinkMutation, UpdatePeerLinkMutationVariables>;
export const RevokePeerLinkDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RevokePeerLink"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"revokePeerLink"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"peerLink"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"peerHandle"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"trustTier"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}}]}}]}}]}}]} as unknown as DocumentNode<RevokePeerLinkMutation, RevokePeerLinkMutationVariables>;
export const SetHouseholdTierDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SetHouseholdTier"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SetHouseholdTierInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"setHouseholdTier"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"memberId"}},{"kind":"Field","name":{"kind":"Name","value":"trustTier"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]} as unknown as DocumentNode<SetHouseholdTierMutation, SetHouseholdTierMutationVariables>;
export const MyHouseholdTiersDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyHouseholdTiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myHouseholdTiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"memberId"}},{"kind":"Field","name":{"kind":"Name","value":"trustTier"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]} as unknown as DocumentNode<MyHouseholdTiersQuery, MyHouseholdTiersQueryVariables>;
export const GetCommunicationDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetCommunication"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"communication"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"to"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]} as unknown as DocumentNode<GetCommunicationQuery, GetCommunicationQueryVariables>;
export const UpdateCommunicationPageFieldsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateCommunicationPageFields"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateCommunicationInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateCommunication"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]}}]} as unknown as DocumentNode<UpdateCommunicationPageFieldsMutation, UpdateCommunicationPageFieldsMutationVariables>;
export const GetConceptDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConcept"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"concept"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]} as unknown as DocumentNode<GetConceptQuery, GetConceptQueryVariables>;
export const UpdateConceptDescriptionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateConceptDescription"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateConceptInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateConcept"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"concept"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateConceptDescriptionMutation, UpdateConceptDescriptionMutationVariables>;
export const GetConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"schedule"}},{"kind":"Field","name":{"kind":"Name","value":"tokenExpiry"}},{"kind":"Field","name":{"kind":"Name","value":"syncState"}},{"kind":"Field","name":{"kind":"Name","value":"activeEndpoints"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}},{"kind":"Field","name":{"kind":"Name","value":"needsReauth"}},{"kind":"Field","name":{"kind":"Name","value":"externalId"}},{"kind":"Field","name":{"kind":"Name","value":"accountLabel"}},{"kind":"Field","name":{"kind":"Name","value":"provider"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"authType"}},{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"iterationType"}},{"kind":"Field","name":{"kind":"Name","value":"TTL"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetConnectionQuery, GetConnectionQueryVariables>;
export const UpdateConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateConnectionInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"connection"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"schedule"}},{"kind":"Field","name":{"kind":"Name","value":"tokenExpiry"}},{"kind":"Field","name":{"kind":"Name","value":"syncState"}},{"kind":"Field","name":{"kind":"Name","value":"activeEndpoints"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}},{"kind":"Field","name":{"kind":"Name","value":"needsReauth"}},{"kind":"Field","name":{"kind":"Name","value":"externalId"}},{"kind":"Field","name":{"kind":"Name","value":"accountLabel"}},{"kind":"Field","name":{"kind":"Name","value":"provider"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"authType"}},{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"iterationType"}},{"kind":"Field","name":{"kind":"Name","value":"TTL"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<UpdateConnectionMutation, UpdateConnectionMutationVariables>;
export const DeleteConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteConnectionMutation, DeleteConnectionMutationVariables>;
export const GetConnectionSyncJobsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConnectionSyncJobs"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"endpointName"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"type"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionSyncJobs"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"connectionId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}}},{"kind":"Argument","name":{"kind":"Name","value":"endpointName"},"value":{"kind":"Variable","name":{"kind":"Name","value":"endpointName"}}},{"kind":"Argument","name":{"kind":"Name","value":"type"},"value":{"kind":"Variable","name":{"kind":"Name","value":"type"}}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"endpointName"}},{"kind":"Field","name":{"kind":"Name","value":"nextCursor"}},{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}},{"kind":"Field","name":{"kind":"Name","value":"error"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"hasPreviousPage"}},{"kind":"Field","name":{"kind":"Name","value":"startCursor"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"totalCount"}}]}}]}}]} as unknown as DocumentNode<GetConnectionSyncJobsQuery, GetConnectionSyncJobsQueryVariables>;
export const GetContentFacetsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetContentFacets"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"contentFacets"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"types"}},{"kind":"Field","name":{"kind":"Name","value":"mimetypes"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystems"}}]}}]}}]} as unknown as DocumentNode<GetContentFacetsQuery, GetContentFacetsQueryVariables>;
export const GetContentsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetContents"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"types"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"mimetypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectors"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"contents"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}},{"kind":"Argument","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"Argument","name":{"kind":"Name","value":"types"},"value":{"kind":"Variable","name":{"kind":"Name","value":"types"}}},{"kind":"Argument","name":{"kind":"Name","value":"mimetypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"mimetypes"}}},{"kind":"Argument","name":{"kind":"Name","value":"connectors"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectors"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ContentTileFragment"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentTileFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}}]} as unknown as DocumentNode<GetContentsQuery, GetContentsQueryVariables>;
export const GetContentSheetDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetContentSheet"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"content"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ContentGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableContentRowData"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"sourceType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"sourceId"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableContentRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]} as unknown as DocumentNode<GetContentSheetQuery, GetContentSheetQueryVariables>;
export const GetContentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetContent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"content"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}}]} as unknown as DocumentNode<GetContentQuery, GetContentQueryVariables>;
export const UpdateContentPageFieldsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateContentPageFields"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateContentInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateContent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<UpdateContentPageFieldsMutation, UpdateContentPageFieldsMutationVariables>;
export const GetEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contents"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"IntValue","value":"60"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventContentTile"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"location"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}},{"kind":"Field","name":{"kind":"Name","value":"organizer"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"participants"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventContentTile"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}}]} as unknown as DocumentNode<GetEventQuery, GetEventQueryVariables>;
export const UpdateEventPageFieldsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateEventPageFields"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateEventInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateEvent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<UpdateEventPageFieldsMutation, UpdateEventPageFieldsMutationVariables>;
export const GetSummariesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSummaries"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"summaries"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"periodType"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyInsights"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"activityCounts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"total"}}]}},{"kind":"Field","name":{"kind":"Name","value":"insights"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyActions"}},{"kind":"Field","name":{"kind":"Name","value":"relevanceScore"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"relatedEntityIds"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}}]}},{"kind":"Field","name":{"kind":"Name","value":"totalCount"}}]}}]}}]} as unknown as DocumentNode<GetSummariesQuery, GetSummariesQueryVariables>;
export const MarkSummaryAsSeenDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkSummaryAsSeen"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markSummaryAsSeen"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}}]}}]}}]} as unknown as DocumentNode<MarkSummaryAsSeenMutation, MarkSummaryAsSeenMutationVariables>;
export const MarkSummaryAsDismissedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkSummaryAsDismissed"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markSummaryAsDismissed"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}}]}}]} as unknown as DocumentNode<MarkSummaryAsDismissedMutation, MarkSummaryAsDismissedMutationVariables>;
export const GetForecastExtrasDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetForecastExtras"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"placeForecast"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"k"},"value":{"kind":"IntValue","value":"5"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"lat"}},{"kind":"Field","name":{"kind":"Name","value":"lng"}},{"kind":"Field","name":{"kind":"Name","value":"visits"}},{"kind":"Field","name":{"kind":"Name","value":"share"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"probability"}},{"kind":"Field","name":{"kind":"Name","value":"backoffLevel"}}]}},{"kind":"Field","name":{"kind":"Name","value":"predictionCalibration"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"IntValue","value":"14"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"basis"}},{"kind":"Field","name":{"kind":"Name","value":"latest"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"driftFlag"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"forecastHistory"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"days"},"value":{"kind":"IntValue","value":"5"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"buckets"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"bucketIndex"}},{"kind":"Field","name":{"kind":"Name","value":"predictedL0"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"probability"}}]}},{"kind":"Field","name":{"kind":"Name","value":"actualL0"}}]}}]}}]}}]} as unknown as DocumentNode<GetForecastExtrasQuery, GetForecastExtrasQueryVariables>;
export const GetAcquisitionReceiptDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetAcquisitionReceipt"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"receipt"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"merchantName"}},{"kind":"Field","name":{"kind":"Name","value":"merchantEntityId"}},{"kind":"Field","name":{"kind":"Name","value":"placeEntityId"}},{"kind":"Field","name":{"kind":"Name","value":"purchasedAt"}},{"kind":"Field","name":{"kind":"Name","value":"orderNumber"}},{"kind":"Field","name":{"kind":"Name","value":"channel"}},{"kind":"Field","name":{"kind":"Name","value":"paymentMethod"}},{"kind":"Field","name":{"kind":"Name","value":"paymentLast4"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinor"}}]}}]}}]} as unknown as DocumentNode<GetAcquisitionReceiptQuery, GetAcquisitionReceiptQueryVariables>;
export const GetAcquisitionPlaceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetAcquisitionPlace"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"place"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]} as unknown as DocumentNode<GetAcquisitionPlaceQuery, GetAcquisitionPlaceQueryVariables>;
export const UpdateItemPageFieldsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateItemPageFields"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateItemInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateItem"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateItemPageFieldsMutation, UpdateItemPageFieldsMutationVariables>;
export const ConfirmItemObservationDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ConfirmItemObservation"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"itemId"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"confirmObservation"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"itemId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"itemId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"confirmedByUser"}},{"kind":"Field","name":{"kind":"Name","value":"resolvedObjectId"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionConfidence"}}]}}]}}]} as unknown as DocumentNode<ConfirmItemObservationMutation, ConfirmItemObservationMutationVariables>;
export const RejectItemObservationDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RejectItemObservation"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"rejectObservation"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"confirmedByUser"}},{"kind":"Field","name":{"kind":"Name","value":"resolvedObjectId"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionConfidence"}}]}}]}}]} as unknown as DocumentNode<RejectItemObservationMutation, RejectItemObservationMutationVariables>;
export const ActivityTimelineDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ActivityTimeline"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"start"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"end"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"filters"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ActivityTimelineFiltersInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"activityTimeline"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"start"},"value":{"kind":"Variable","name":{"kind":"Name","value":"start"}}},{"kind":"Argument","name":{"kind":"Name","value":"end"},"value":{"kind":"Variable","name":{"kind":"Name","value":"end"}}},{"kind":"Argument","name":{"kind":"Name","value":"filters"},"value":{"kind":"Variable","name":{"kind":"Name","value":"filters"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"count"}}]}}]}}]} as unknown as DocumentNode<ActivityTimelineQuery, ActivityTimelineQueryVariables>;
export const UpdateBrowserActivityDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateBrowserActivityDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateBrowserActivityInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateBrowserActivity"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}}]} as unknown as DocumentNode<UpdateBrowserActivityDetailMutation, UpdateBrowserActivityDetailMutationVariables>;
export const UpdateCommunicationDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateCommunicationDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateCommunicationInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateCommunication"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","alias":{"kind":"Name","value":"communicationContent"},"name":{"kind":"Name","value":"content"}}]}}]}}]} as unknown as DocumentNode<UpdateCommunicationDetailMutation, UpdateCommunicationDetailMutationVariables>;
export const GetCommunicationAttachmentsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetCommunicationAttachments"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"fileId"}},{"kind":"Field","name":{"kind":"Name","value":"contentId"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"size"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetCommunicationAttachmentsQuery, GetCommunicationAttachmentsQueryVariables>;
export const UpdateConceptDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateConceptDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateConceptInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateConcept"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"concept"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateConceptDetailMutation, UpdateConceptDetailMutationVariables>;
export const UpdateContentDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateContentDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateContentInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateContent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<UpdateContentDetailMutation, UpdateContentDetailMutationVariables>;
export const UpdateEventDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateEventDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateEventInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateEvent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<UpdateEventDetailMutation, UpdateEventDetailMutationVariables>;
export const UpdateFileDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateFileDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateFileInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateFile"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<UpdateFileDetailMutation, UpdateFileDetailMutationVariables>;
export const UpdateItemDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateItemDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateItemInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateItem"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateItemDetailMutation, UpdateItemDetailMutationVariables>;
export const UpdateNoteDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateNoteDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateNoteInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"note"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateNoteDetailMutation, UpdateNoteDetailMutationVariables>;
export const GetPersonProfileForDrawerDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPersonProfileForDrawer"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"person"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonEditorFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonEditorFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"middleName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"nickname"}},{"kind":"Field","name":{"kind":"Name","value":"pronouns"}},{"kind":"Field","name":{"kind":"Name","value":"gender"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}},{"kind":"Field","name":{"kind":"Name","value":"jobTitle"}},{"kind":"Field","name":{"kind":"Name","value":"organization"}},{"kind":"Field","name":{"kind":"Name","value":"department"}},{"kind":"Field","name":{"kind":"Name","value":"website"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"addresses"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress2"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"region"}},{"kind":"Field","name":{"kind":"Name","value":"postalCode"}},{"kind":"Field","name":{"kind":"Name","value":"country"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"formatted"}}]}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}}]}}]}}]} as unknown as DocumentNode<GetPersonProfileForDrawerQuery, GetPersonProfileForDrawerQueryVariables>;
export const UpdatePlaceDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdatePlaceDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdatePlaceInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updatePlace"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}}]} as unknown as DocumentNode<UpdatePlaceDetailMutation, UpdatePlaceDetailMutationVariables>;
export const GetReceiptLinesForDrawerDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetReceiptLinesForDrawer"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"receipt"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"documentContentId"}},{"kind":"Field","name":{"kind":"Name","value":"lineItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"lineNumber"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"unitPriceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"totalPriceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"isPhysical"}},{"kind":"Field","name":{"kind":"Name","value":"mintedObjectId"}}]}}]}}]}}]} as unknown as DocumentNode<GetReceiptLinesForDrawerQuery, GetReceiptLinesForDrawerQueryVariables>;
export const GetReceiptDocumentForDrawerDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetReceiptDocumentForDrawer"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"content"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<GetReceiptDocumentForDrawerQuery, GetReceiptDocumentForDrawerQueryVariables>;
export const DeleteMemoryEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMemoryEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteEvent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteMemoryEventMutation, DeleteMemoryEventMutationVariables>;
export const DeleteMemoryContentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMemoryContent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteContent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteMemoryContentMutation, DeleteMemoryContentMutationVariables>;
export const DeleteMemoryPlaceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMemoryPlace"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deletePlace"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteMemoryPlaceMutation, DeleteMemoryPlaceMutationVariables>;
export const DeleteMemoryPersonDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMemoryPerson"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deletePerson"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteMemoryPersonMutation, DeleteMemoryPersonMutationVariables>;
export const DeleteMemoryItemDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMemoryItem"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteItem"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteMemoryItemMutation, DeleteMemoryItemMutationVariables>;
export const DeleteMemoryConceptDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMemoryConcept"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteConcept"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteMemoryConceptMutation, DeleteMemoryConceptMutationVariables>;
export const DeleteMemoryNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMemoryNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteMemoryNoteMutation, DeleteMemoryNoteMutationVariables>;
export const DeleteMemoryCommunicationDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMemoryCommunication"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteCommunication"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteMemoryCommunicationMutation, DeleteMemoryCommunicationMutationVariables>;
export const DeleteMemoryBrowserActivityDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMemoryBrowserActivity"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteBrowserActivity"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteMemoryBrowserActivityMutation, DeleteMemoryBrowserActivityMutationVariables>;
export const RestoreMemoryEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RestoreMemoryEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RestoreByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"restoreEvent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]} as unknown as DocumentNode<RestoreMemoryEventMutation, RestoreMemoryEventMutationVariables>;
export const GetDrawerNodeDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetDrawerNode"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Taggable"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"galleryContentType"},"name":{"kind":"Name","value":"contentType"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryFilename"},"name":{"kind":"Name","value":"filename"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryPreviewUrl"},"name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"gallerySourceUrl"},"name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryMediaSize"},"name":{"kind":"Name","value":"size"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"galleryMimetype"},"name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryContentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryContentSourceUrl"},"name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryPreviewUrl"},"name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryFileUrl"},"name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryMediaSize"},"name":{"kind":"Name","value":"mediaSize"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"AnswerGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"BrowserActivityGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"CommunicationGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ConceptGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ContentGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"FileChunkGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"FileGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"NoteGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ItemGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PlaceGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ProductGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ReceiptGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ThreadGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableAnswerRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableCommunicationRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableConceptRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableContentRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableEventRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableFileChunkRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableFileRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableItemRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableNoteRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePersonRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePlaceRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableProductRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableReceiptRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableThreadRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableBrowserActivityRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineBrowserActivityCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineCommunicationCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineEventCardData"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketTime"},"name":{"kind":"Name","value":"time"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketTime"},"name":{"kind":"Name","value":"time"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketStartTime"},"name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","alias":{"kind":"Name","value":"mapCoordinates"},"name":{"kind":"Name","value":"locationCoordinates"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryMediaContentType"},"name":{"kind":"Name","value":"mediaContentType"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryPreviewUrl"},"name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"gallerySourceUrl"},"name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryMediaSize"},"name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryLocationName"},"name":{"kind":"Name","value":"locationName"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"mapProperties"},"name":{"kind":"Name","value":"properties"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineFileChunkCardData"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"AnswerGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"answerSource"}},{"kind":"Field","name":{"kind":"Name","value":"answerConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"answerRationale"}},{"kind":"Field","name":{"kind":"Name","value":"answerEvidence"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"BrowserActivityGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"CommunicationGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ConceptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"sourceType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"sourceId"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileChunkGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileChunkType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sectionTitle"}},{"kind":"Field","alias":{"kind":"Name","value":"chunkContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLocator"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"size"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ItemGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PlaceGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}},{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProductGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProductModelType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","alias":{"kind":"Name","value":"productTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"isDigital"}},{"kind":"Field","name":{"kind":"Name","value":"msrpMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"productCurrency"},"name":{"kind":"Name","value":"currency"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ReceiptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ReceiptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"merchantName"}},{"kind":"Field","name":{"kind":"Name","value":"purchasedAt"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"receiptCurrency"},"name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"orderNumber"}},{"kind":"Field","name":{"kind":"Name","value":"channel"}},{"kind":"Field","name":{"kind":"Name","value":"extractionState"}},{"kind":"Field","name":{"kind":"Name","value":"lineItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ThreadGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableAnswerRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableCommunicationRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableConceptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableContentRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableEventRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileChunkRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileChunkType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sectionTitle"}},{"kind":"Field","alias":{"kind":"Name","value":"chunkContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLocator"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableItemRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableNoteRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePersonRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePlaceRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableProductRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProductModelType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","alias":{"kind":"Name","value":"productTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"msrpMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"productCurrency"},"name":{"kind":"Name","value":"currency"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableReceiptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ReceiptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"merchantName"}},{"kind":"Field","name":{"kind":"Name","value":"purchasedAt"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"receiptCurrency"},"name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"lineItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableThreadRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableBrowserActivityRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineBrowserActivityCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"actionType"}},{"kind":"Field","name":{"kind":"Name","value":"duration"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineCommunicationCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","alias":{"kind":"Name","value":"communicationContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"to"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineEventCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"timeSource"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"location"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}},{"kind":"Field","name":{"kind":"Name","value":"mediaWidth"}},{"kind":"Field","name":{"kind":"Name","value":"mediaHeight"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"contents"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"IntValue","value":"3"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineFileChunkCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileChunkType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sectionTitle"}},{"kind":"Field","alias":{"kind":"Name","value":"chunkContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLocator"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}}]} as unknown as DocumentNode<GetDrawerNodeQuery, GetDrawerNodeQueryVariables>;
export const GetSavedSearchesForPickerDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSavedSearchesForPicker"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"savedSearches"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"Argument","name":{"kind":"Name","value":"isSeed"},"value":{"kind":"BooleanValue","value":false}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetSavedSearchesForPickerQuery, GetSavedSearchesForPickerQueryVariables>;
export const GraphNodeEntityDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GraphNodeEntity"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Taggable"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"galleryContentType"},"name":{"kind":"Name","value":"contentType"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryFilename"},"name":{"kind":"Name","value":"filename"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryPreviewUrl"},"name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"gallerySourceUrl"},"name":{"kind":"Name","value":"sourceUrl"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"galleryMimetype"},"name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryContentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryContentSourceUrl"},"name":{"kind":"Name","value":"sourceUrl"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketTime"},"name":{"kind":"Name","value":"time"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketStartTime"},"name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","alias":{"kind":"Name","value":"mapCoordinates"},"name":{"kind":"Name","value":"locationCoordinates"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryMediaContentType"},"name":{"kind":"Name","value":"mediaContentType"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryPreviewUrl"},"name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"gallerySourceUrl"},"name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryLocationName"},"name":{"kind":"Name","value":"locationName"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"mapProperties"},"name":{"kind":"Name","value":"properties"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"CommunicationGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ConceptGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ContentGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"FileGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ItemGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PlaceGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableCommunicationRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableConceptRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableContentRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableEventRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableFileRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableItemRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePersonRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePlaceRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineCommunicationCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineEventCardData"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"CommunicationGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ConceptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"sourceType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"sourceId"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"size"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ItemGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PlaceGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}},{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableCommunicationRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableConceptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableContentRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableEventRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableItemRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePersonRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePlaceRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineCommunicationCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","alias":{"kind":"Name","value":"communicationContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"to"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineEventCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"timeSource"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"location"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}},{"kind":"Field","name":{"kind":"Name","value":"mediaWidth"}},{"kind":"Field","name":{"kind":"Name","value":"mediaHeight"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"contents"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"IntValue","value":"3"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GraphNodeEntityQuery, GraphNodeEntityQueryVariables>;
export const MapPinsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MapPins"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"eventTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"tags"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectors"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"people"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"places"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"bbox"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Float"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"semantic"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Boolean"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"mapPins"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"includeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"excludeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"eventTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"eventTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"tags"},"value":{"kind":"Variable","name":{"kind":"Name","value":"tags"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"startTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"endTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"connectors"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectors"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"people"},"value":{"kind":"Variable","name":{"kind":"Name","value":"people"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"places"},"value":{"kind":"Variable","name":{"kind":"Name","value":"places"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"bbox"},"value":{"kind":"Variable","name":{"kind":"Name","value":"bbox"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"semantic"},"value":{"kind":"Variable","name":{"kind":"Name","value":"semantic"}}}]}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"truncated"}},{"kind":"Field","name":{"kind":"Name","value":"pins"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"timeSource"}}]}}]}}]}}]} as unknown as DocumentNode<MapPinsQuery, MapPinsQueryVariables>;
export const MapPinEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MapPinEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineEventCardData"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","alias":{"kind":"Name","value":"mapCoordinates"},"name":{"kind":"Name","value":"locationCoordinates"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineEventCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"timeSource"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"location"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}},{"kind":"Field","name":{"kind":"Name","value":"mediaWidth"}},{"kind":"Field","name":{"kind":"Name","value":"mediaHeight"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"contents"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"IntValue","value":"3"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}}]}}]}}]}}]} as unknown as DocumentNode<MapPinEventQuery, MapPinEventQueryVariables>;
export const PositionTrackDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"PositionTrack"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"bbox"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Float"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"maxPoints"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"positionTrack"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"startTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"endTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"bbox"},"value":{"kind":"Variable","name":{"kind":"Name","value":"bbox"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"maxPoints"},"value":{"kind":"Variable","name":{"kind":"Name","value":"maxPoints"}}}]}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"points"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"fixCount"}}]}},{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}},{"kind":"Field","name":{"kind":"Name","value":"bucketSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"totalCount"}}]}}]}}]} as unknown as DocumentNode<PositionTrackQuery, PositionTrackQueryVariables>;
export const HomeMapPlaceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"HomeMapPlace"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"places"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}}]}}]}}]}}]}}]} as unknown as DocumentNode<HomeMapPlaceQuery, HomeMapPlaceQueryVariables>;
export const PlaybackPositionTrackPageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"PlaybackPositionTrackPage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"positionTrack"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"startTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"endTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"maxPoints"},"value":{"kind":"IntValue","value":"0"}}]}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"points"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}}]}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}},{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}}]}}]}}]} as unknown as DocumentNode<PlaybackPositionTrackPageQuery, PlaybackPositionTrackPageQueryVariables>;
export const PlaybackPositionTrackExtentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"PlaybackPositionTrackExtent"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"positionTrackExtent"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"start"}},{"kind":"Field","name":{"kind":"Name","value":"end"}},{"kind":"Field","name":{"kind":"Name","value":"count"}}]}}]}}]} as unknown as DocumentNode<PlaybackPositionTrackExtentQuery, PlaybackPositionTrackExtentQueryVariables>;
export const SearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Search"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"eventTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"tags"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"sortBy"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"sortOrder"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectors"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"people"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"places"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"hasLocation"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Boolean"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"bbox"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Float"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"semantic"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Boolean"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"shareToken"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"search"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"includeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"excludeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"eventTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"eventTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"tags"},"value":{"kind":"Variable","name":{"kind":"Name","value":"tags"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"startTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"endTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"endTime"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"sortBy"},"value":{"kind":"Variable","name":{"kind":"Name","value":"sortBy"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"sortOrder"},"value":{"kind":"Variable","name":{"kind":"Name","value":"sortOrder"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"connectors"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectors"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"people"},"value":{"kind":"Variable","name":{"kind":"Name","value":"people"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"places"},"value":{"kind":"Variable","name":{"kind":"Name","value":"places"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"hasLocation"},"value":{"kind":"Variable","name":{"kind":"Name","value":"hasLocation"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"bbox"},"value":{"kind":"Variable","name":{"kind":"Name","value":"bbox"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"semantic"},"value":{"kind":"Variable","name":{"kind":"Name","value":"semantic"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"shareToken"},"value":{"kind":"Variable","name":{"kind":"Name","value":"shareToken"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}]}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Taggable"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"galleryContentType"},"name":{"kind":"Name","value":"contentType"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryFilename"},"name":{"kind":"Name","value":"filename"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryPreviewUrl"},"name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"gallerySourceUrl"},"name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryMediaSize"},"name":{"kind":"Name","value":"size"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"galleryMimetype"},"name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryContentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryContentSourceUrl"},"name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryPreviewUrl"},"name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryFileUrl"},"name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryMediaSize"},"name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryPlayer"},"name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","alias":{"kind":"Name","value":"galleryUnfurl"},"name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}}]}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"AnswerGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"BrowserActivityGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"CommunicationGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ConceptGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ContentGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"FileChunkGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"FileGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"NoteGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ItemGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PlaceGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ProductGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ReceiptGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ThreadGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableAnswerRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableCommunicationRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableConceptRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableContentRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableEventRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableFileChunkRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableFileRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableItemRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableNoteRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePersonRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePlaceRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableProductRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableReceiptRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableThreadRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableBrowserActivityRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineBrowserActivityCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineCommunicationCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineEventCardData"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketTime"},"name":{"kind":"Name","value":"time"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketTime"},"name":{"kind":"Name","value":"time"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketStartTime"},"name":{"kind":"Name","value":"startTime"}},{"kind":"Field","alias":{"kind":"Name","value":"bucketTimeSource"},"name":{"kind":"Name","value":"timeSource"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","alias":{"kind":"Name","value":"mapCoordinates"},"name":{"kind":"Name","value":"locationCoordinates"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryMediaContentType"},"name":{"kind":"Name","value":"mediaContentType"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryPreviewUrl"},"name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"gallerySourceUrl"},"name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryMediaSize"},"name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"galleryLocationName"},"name":{"kind":"Name","value":"locationName"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketAppearedAt"},"name":{"kind":"Name","value":"appearedAt"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ReceiptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketPurchasedAt"},"name":{"kind":"Name","value":"purchasedAt"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"bucketAppearedAt"},"name":{"kind":"Name","value":"appearedAt"}},{"kind":"Field","alias":{"kind":"Name","value":"mapProperties"},"name":{"kind":"Name","value":"properties"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineFileChunkCardData"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RichMediaData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"player"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"}},{"kind":"Field","name":{"kind":"Name","value":"playerUrl"}},{"kind":"Field","name":{"kind":"Name","value":"posterUrl"}},{"kind":"Field","name":{"kind":"Name","value":"aspectRatio"}},{"kind":"Field","name":{"kind":"Name","value":"mediaKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"unfurl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"resolver"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"authorName"}},{"kind":"Field","name":{"kind":"Name","value":"siteName"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"canonicalUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"payload"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"AnswerGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"answerSource"}},{"kind":"Field","name":{"kind":"Name","value":"answerConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"answerRationale"}},{"kind":"Field","name":{"kind":"Name","value":"answerEvidence"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"BrowserActivityGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"CommunicationGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ConceptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"sourceType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"sourceId"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileChunkGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileChunkType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sectionTitle"}},{"kind":"Field","alias":{"kind":"Name","value":"chunkContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLocator"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"size"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ItemGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PlaceGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}},{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProductGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProductModelType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","alias":{"kind":"Name","value":"productTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"isDigital"}},{"kind":"Field","name":{"kind":"Name","value":"msrpMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"productCurrency"},"name":{"kind":"Name","value":"currency"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ReceiptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ReceiptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"merchantName"}},{"kind":"Field","name":{"kind":"Name","value":"purchasedAt"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"receiptCurrency"},"name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"orderNumber"}},{"kind":"Field","name":{"kind":"Name","value":"channel"}},{"kind":"Field","name":{"kind":"Name","value":"extractionState"}},{"kind":"Field","name":{"kind":"Name","value":"lineItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ThreadGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableAnswerRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableCommunicationRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableConceptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableContentRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableEventRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileChunkRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileChunkType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sectionTitle"}},{"kind":"Field","alias":{"kind":"Name","value":"chunkContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLocator"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableItemRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableNoteRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePersonRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePlaceRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableProductRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProductModelType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","alias":{"kind":"Name","value":"productTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"msrpMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"productCurrency"},"name":{"kind":"Name","value":"currency"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableReceiptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ReceiptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"merchantName"}},{"kind":"Field","name":{"kind":"Name","value":"purchasedAt"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinor"}},{"kind":"Field","alias":{"kind":"Name","value":"receiptCurrency"},"name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"lineItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableThreadRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableBrowserActivityRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineBrowserActivityCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"actionType"}},{"kind":"Field","name":{"kind":"Name","value":"duration"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineCommunicationCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","alias":{"kind":"Name","value":"communicationContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"to"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineEventCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"timeSource"}},{"kind":"Field","name":{"kind":"Name","value":"locationName"}},{"kind":"Field","name":{"kind":"Name","value":"location"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaContentType"}},{"kind":"Field","name":{"kind":"Name","value":"mediaWidth"}},{"kind":"Field","name":{"kind":"Name","value":"mediaHeight"}},{"kind":"Field","name":{"kind":"Name","value":"mediaSize"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"contents"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"IntValue","value":"3"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"contentUrl"},"name":{"kind":"Name","value":"url"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"RichMediaData"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineFileChunkCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileChunkType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sectionTitle"}},{"kind":"Field","alias":{"kind":"Name","value":"chunkContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLocator"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}}]} as unknown as DocumentNode<SearchQuery, SearchQueryVariables>;
export const GetSavedSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSavedSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"savedSearch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"filters"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventTypes"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"datePreset"}},{"kind":"Field","name":{"kind":"Name","value":"sortBy"}},{"kind":"Field","name":{"kind":"Name","value":"sortOrder"}},{"kind":"Field","name":{"kind":"Name","value":"connectors"}},{"kind":"Field","name":{"kind":"Name","value":"people"}},{"kind":"Field","name":{"kind":"Name","value":"places"}},{"kind":"Field","name":{"kind":"Name","value":"hasLocation"}},{"kind":"Field","name":{"kind":"Name","value":"semantic"}}]}}]}}]}}]} as unknown as DocumentNode<GetSavedSearchQuery, GetSavedSearchQueryVariables>;
export const GetNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"note"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]} as unknown as DocumentNode<GetNoteQuery, GetNoteQueryVariables>;
export const CreateNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateNoteInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"note"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]}}]} as unknown as DocumentNode<CreateNoteMutation, CreateNoteMutationVariables>;
export const UpdateNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateNoteInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"note"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateNoteMutation, UpdateNoteMutationVariables>;
export const NoteReferenceSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"NoteReferenceSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"search"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"includeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}}}]}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"referenceTitle"},"name":{"kind":"Name","value":"title"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"referenceName"},"name":{"kind":"Name","value":"name"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"placeReferenceName"},"name":{"kind":"Name","value":"name"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"conceptReferenceName"},"name":{"kind":"Name","value":"name"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"itemReferenceName"},"name":{"kind":"Name","value":"name"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"eventReferenceTitle"},"name":{"kind":"Name","value":"title"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"contentReferenceTitle"},"name":{"kind":"Name","value":"title"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"referencePreview"},"name":{"kind":"Name","value":"preview"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<NoteReferenceSearchQuery, NoteReferenceSearchQueryVariables>;
export const DeleteNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteNoteMutation, DeleteNoteMutationVariables>;
export const GetNotesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetNotes"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"notes"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"NoteGridItemFragment"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<GetNotesQuery, GetNotesQueryVariables>;
export const MergePeopleDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MergePeople"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"MergePeopleInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"mergePeople"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"person"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}}]} as unknown as DocumentNode<MergePeopleMutation, MergePeopleMutationVariables>;
export const RejectPersonDuplicatesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RejectPersonDuplicates"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"personIds"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"rejectPersonDuplicates"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"personIds"},"value":{"kind":"Variable","name":{"kind":"Name","value":"personIds"}}}]}]}}]} as unknown as DocumentNode<RejectPersonDuplicatesMutation, RejectPersonDuplicatesMutationVariables>;
export const GetPeopleDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPeople"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"people"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}},{"kind":"Field","name":{"kind":"Name","value":"isSelf"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"interactionStats"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventCount"}},{"kind":"Field","name":{"kind":"Name","value":"communicationCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastInteractionAt"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetPeopleQuery, GetPeopleQueryVariables>;
export const GetMergedPersonDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetMergedPerson"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"person"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}},{"kind":"Field","name":{"kind":"Name","value":"isSelf"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"interactionStats"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventCount"}},{"kind":"Field","name":{"kind":"Name","value":"communicationCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastInteractionAt"}}]}}]}}]}}]} as unknown as DocumentNode<GetMergedPersonQuery, GetMergedPersonQueryVariables>;
export const GetMergeCandidatesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetMergeCandidates"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"mergeCandidates"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"score"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"detectedBy"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"evidence"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"score"}}]}},{"kind":"Field","name":{"kind":"Name","value":"people"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isSelf"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}},{"kind":"Field","name":{"kind":"Name","value":"interactionStats"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventCount"}},{"kind":"Field","name":{"kind":"Name","value":"communicationCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastInteractionAt"}}]}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetMergeCandidatesQuery, GetMergeCandidatesQueryVariables>;
export const GetPersonDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPerson"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"person"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonEditorFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonEditorFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"middleName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"nickname"}},{"kind":"Field","name":{"kind":"Name","value":"pronouns"}},{"kind":"Field","name":{"kind":"Name","value":"gender"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}},{"kind":"Field","name":{"kind":"Name","value":"jobTitle"}},{"kind":"Field","name":{"kind":"Name","value":"organization"}},{"kind":"Field","name":{"kind":"Name","value":"department"}},{"kind":"Field","name":{"kind":"Name","value":"website"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"addresses"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress2"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"region"}},{"kind":"Field","name":{"kind":"Name","value":"postalCode"}},{"kind":"Field","name":{"kind":"Name","value":"country"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"formatted"}}]}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}}]}}]}}]} as unknown as DocumentNode<GetPersonQuery, GetPersonQueryVariables>;
export const UpdatePersonDescriptionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdatePersonDescription"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdatePersonInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updatePerson"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"person"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]} as unknown as DocumentNode<UpdatePersonDescriptionMutation, UpdatePersonDescriptionMutationVariables>;
export const GetPlaceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPlace"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"place"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]} as unknown as DocumentNode<GetPlaceQuery, GetPlaceQueryVariables>;
export const UpdatePlacePageFieldsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdatePlacePageFields"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdatePlaceInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updatePlace"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}}]} as unknown as DocumentNode<UpdatePlacePageFieldsMutation, UpdatePlacePageFieldsMutationVariables>;
export const GetPlaceDuplicatesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPlaceDuplicates"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"offset"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"placeDuplicates"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}},{"kind":"Argument","name":{"kind":"Name","value":"offset"},"value":{"kind":"Variable","name":{"kind":"Name","value":"offset"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"hasMore"}},{"kind":"Field","name":{"kind":"Name","value":"groups"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"reason"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"totalPlaces"}},{"kind":"Field","name":{"kind":"Name","value":"places"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"placeKind"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetPlaceDuplicatesQuery, GetPlaceDuplicatesQueryVariables>;
export const MergePlacesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MergePlaces"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"MergePlacesInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"mergePlaces"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"place"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"counts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"events"}},{"kind":"Field","name":{"kind":"Name","value":"childPlaces"}},{"kind":"Field","name":{"kind":"Name","value":"relationshipsFrom"}},{"kind":"Field","name":{"kind":"Name","value":"relationshipsTo"}}]}}]}}]}}]} as unknown as DocumentNode<MergePlacesMutation, MergePlacesMutationVariables>;
export const RejectPlaceDuplicatesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RejectPlaceDuplicates"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"placeIds"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"rejectPlaceDuplicates"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"placeIds"},"value":{"kind":"Variable","name":{"kind":"Name","value":"placeIds"}}}]}]}}]} as unknown as DocumentNode<RejectPlaceDuplicatesMutation, RejectPlaceDuplicatesMutationVariables>;
export const GetPlaceSheetDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPlaceSheet"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"place"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","alias":{"kind":"Name","value":"mapProperties"},"name":{"kind":"Name","value":"properties"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PlaceGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePlaceRowData"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PlaceGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}},{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePlaceRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<GetPlaceSheetQuery, GetPlaceSheetQueryVariables>;
export const GetPlacesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPlaces"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"places"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"placeKind"}},{"kind":"Field","name":{"kind":"Name","value":"latitude"}},{"kind":"Field","name":{"kind":"Name","value":"longitude"}},{"kind":"Field","name":{"kind":"Name","value":"parent"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"placeKind"}}]}},{"kind":"Field","name":{"kind":"Name","value":"visitStats"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"visitCount"}},{"kind":"Field","name":{"kind":"Name","value":"firstVisitAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastVisitAt"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetPlacesQuery, GetPlacesQueryVariables>;
export const GetKnownPlacesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetKnownPlaces"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"geocodingConfigured"}},{"kind":"Field","name":{"kind":"Name","value":"knownPlaces"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"locationId"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}},{"kind":"Field","name":{"kind":"Name","value":"source"}},{"kind":"Field","name":{"kind":"Name","value":"coordinates"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"lat"}},{"kind":"Field","name":{"kind":"Name","value":"lng"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"knownPlaceCandidates"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"locationId"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"lat"}},{"kind":"Field","name":{"kind":"Name","value":"lng"}},{"kind":"Field","name":{"kind":"Name","value":"eventCount"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}}]}}]}}]} as unknown as DocumentNode<GetKnownPlacesQuery, GetKnownPlacesQueryVariables>;
export const ConfirmKnownPlaceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ConfirmKnownPlace"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateKnownPlaceInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateKnownPlace"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"kind"}}]}}]}}]} as unknown as DocumentNode<ConfirmKnownPlaceMutation, ConfirmKnownPlaceMutationVariables>;
export const UpdatePlanDayEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdatePlanDayEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateEventInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateEvent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","name":{"kind":"Name","value":"taskId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<UpdatePlanDayEventMutation, UpdatePlanDayEventMutationVariables>;
export const UpdatePlanDayEventTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdatePlanDayEventTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateTaskInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"task"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedMinutes"}}]}}]}}]}}]} as unknown as DocumentNode<UpdatePlanDayEventTaskMutation, UpdatePlanDayEventTaskMutationVariables>;
export const UpdateTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateTaskInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"task"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TaskRowFragment"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TaskRowFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TaskType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"dueAt"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"placedOnCalendar"}},{"kind":"Field","name":{"kind":"Name","value":"deferUntil"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}}]}}]} as unknown as DocumentNode<UpdateTaskMutation, UpdateTaskMutationVariables>;
export const CreateTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateTaskInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"task"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TaskRowFragment"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TaskRowFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TaskType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"dueAt"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"placedOnCalendar"}},{"kind":"Field","name":{"kind":"Name","value":"deferUntil"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}}]}}]} as unknown as DocumentNode<CreateTaskMutation, CreateTaskMutationVariables>;
export const CompleteTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CompleteTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"completeTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}}]}}]}}]} as unknown as DocumentNode<CompleteTaskMutation, CompleteTaskMutationVariables>;
export const DeclineTaskPendingChangeDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeclineTaskPendingChange"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"declineTaskPendingChange"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}}]}}]}}]} as unknown as DocumentNode<DeclineTaskPendingChangeMutation, DeclineTaskPendingChangeMutationVariables>;
export const ReopenTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ReopenTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"reopenTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}}]}}]}}]} as unknown as DocumentNode<ReopenTaskMutation, ReopenTaskMutationVariables>;
export const AcceptTaskPendingChangeDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"AcceptTaskPendingChange"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"acceptTaskPendingChange"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"task"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"notes"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}}]}}]}}]}}]} as unknown as DocumentNode<AcceptTaskPendingChangeMutation, AcceptTaskPendingChangeMutationVariables>;
export const ListTasksForTestDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ListTasksForTest"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tasks"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"IntValue","value":"10"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}}]}}]}}]}}]}}]} as unknown as DocumentNode<ListTasksForTestQuery, ListTasksForTestQueryVariables>;
export const DeleteTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteTaskMutation, DeleteTaskMutationVariables>;
export const GetTasksDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetTasks"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tasks"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"dueAt"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"placedOnCalendar"}},{"kind":"Field","name":{"kind":"Name","value":"deferUntil"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TaskRowFragment"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"totalCount"}}]}},{"kind":"Field","name":{"kind":"Name","value":"taskPendingChanges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"taskId"}},{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"rationale"}},{"kind":"Field","name":{"kind":"Name","value":"confidence"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TaskRowFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TaskType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"dueAt"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"placedOnCalendar"}},{"kind":"Field","name":{"kind":"Name","value":"deferUntil"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}}]}}]} as unknown as DocumentNode<GetTasksQuery, GetTasksQueryVariables>;
export const AcceptProposedTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"AcceptProposedTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"acceptProposedTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"placedOnCalendar"}}]}}]}}]} as unknown as DocumentNode<AcceptProposedTaskMutation, AcceptProposedTaskMutationVariables>;
export const DeclineProposedTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeclineProposedTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"declineProposedTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<DeclineProposedTaskMutation, DeclineProposedTaskMutationVariables>;
export const PlanTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"PlanTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"planTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"dueAt"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"placedOnCalendar"}}]}}]}}]} as unknown as DocumentNode<PlanTaskMutation, PlanTaskMutationVariables>;
export const ScheduleTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ScheduleTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"date"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"scheduleTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"date"},"value":{"kind":"Variable","name":{"kind":"Name","value":"date"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"task"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"placedOnCalendar"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedMinutes"}}]}}]}}]}}]} as unknown as DocumentNode<ScheduleTaskMutation, ScheduleTaskMutationVariables>;
export const ScheduleTaskAtDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ScheduleTaskAt"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"scheduleTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"startTime"},"value":{"kind":"Variable","name":{"kind":"Name","value":"startTime"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"task"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledFor"}},{"kind":"Field","name":{"kind":"Name","value":"placedOnCalendar"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedMinutes"}}]}},{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}}]}}]}}]}}]} as unknown as DocumentNode<ScheduleTaskAtMutation, ScheduleTaskAtMutationVariables>;
export const GetProviderDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetProvider"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"logoUrl"}},{"kind":"Field","name":{"kind":"Name","value":"authType"}},{"kind":"Field","name":{"kind":"Name","value":"localOnly"}},{"kind":"Field","name":{"kind":"Name","value":"appSetupUrl"}},{"kind":"Field","name":{"kind":"Name","value":"openidKeyLink"}},{"kind":"Field","name":{"kind":"Name","value":"theme"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"backgroundColor"}},{"kind":"Field","name":{"kind":"Name","value":"borderColor"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ProviderEndpointsFragment"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProviderEndpointsFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProviderType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<GetProviderQuery, GetProviderQueryVariables>;
export const GetReceiptDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetReceipt"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"receipt"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"merchantName"}},{"kind":"Field","name":{"kind":"Name","value":"merchantEntityId"}},{"kind":"Field","name":{"kind":"Name","value":"placeEntityId"}},{"kind":"Field","name":{"kind":"Name","value":"purchasedAt"}},{"kind":"Field","name":{"kind":"Name","value":"orderNumber"}},{"kind":"Field","name":{"kind":"Name","value":"channel"}},{"kind":"Field","name":{"kind":"Name","value":"paymentMethod"}},{"kind":"Field","name":{"kind":"Name","value":"paymentLast4"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"subtotalMinor"}},{"kind":"Field","name":{"kind":"Name","value":"taxMinor"}},{"kind":"Field","name":{"kind":"Name","value":"tipMinor"}},{"kind":"Field","name":{"kind":"Name","value":"shippingMinor"}},{"kind":"Field","name":{"kind":"Name","value":"discountMinor"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinor"}},{"kind":"Field","name":{"kind":"Name","value":"extractionState"}},{"kind":"Field","name":{"kind":"Name","value":"extractionModel"}},{"kind":"Field","name":{"kind":"Name","value":"extractionConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"extractionError"}},{"kind":"Field","name":{"kind":"Name","value":"documentContentId"}},{"kind":"Field","name":{"kind":"Name","value":"sourceFileId"}},{"kind":"Field","name":{"kind":"Name","value":"sourceSystem"}},{"kind":"Field","name":{"kind":"Name","value":"sourceType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceMessageId"}},{"kind":"Field","name":{"kind":"Name","value":"eventId"}},{"kind":"Field","name":{"kind":"Name","value":"lineItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"lineNumber"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"modelNumber"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"unitPriceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"totalPriceMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"isPhysical"}},{"kind":"Field","name":{"kind":"Name","value":"mintedObjectId"}},{"kind":"Field","name":{"kind":"Name","value":"productId"}}]}}]}}]}}]} as unknown as DocumentNode<GetReceiptQuery, GetReceiptQueryVariables>;
export const GetReceiptDocumentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetReceiptDocument"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"content"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<GetReceiptDocumentQuery, GetReceiptDocumentQueryVariables>;
export const GetReceiptPlaceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetReceiptPlace"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"place"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]} as unknown as DocumentNode<GetReceiptPlaceQuery, GetReceiptPlaceQueryVariables>;
export const GetReceiptsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetReceipts"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"merchantName"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"extractionState"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ReceiptExtractionState"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"receipts"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"merchantName"},"value":{"kind":"Variable","name":{"kind":"Name","value":"merchantName"}}},{"kind":"Argument","name":{"kind":"Name","value":"extractionState"},"value":{"kind":"Variable","name":{"kind":"Name","value":"extractionState"}}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"merchantName"}},{"kind":"Field","name":{"kind":"Name","value":"purchasedAt"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinor"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"orderNumber"}},{"kind":"Field","name":{"kind":"Name","value":"channel"}},{"kind":"Field","name":{"kind":"Name","value":"extractionState"}},{"kind":"Field","name":{"kind":"Name","value":"lineItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetReceiptsQuery, GetReceiptsQueryVariables>;
export const CreateSavedSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateSavedSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateSavedSearchInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createSavedSearch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"savedSearch"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SavedSearchGridItemFragment"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SavedSearchGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SavedSearchType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"filters"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventTypes"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"datePreset"}},{"kind":"Field","name":{"kind":"Name","value":"sortBy"}},{"kind":"Field","name":{"kind":"Name","value":"sortOrder"}},{"kind":"Field","name":{"kind":"Name","value":"connectors"}},{"kind":"Field","name":{"kind":"Name","value":"people"}},{"kind":"Field","name":{"kind":"Name","value":"places"}},{"kind":"Field","name":{"kind":"Name","value":"hasLocation"}},{"kind":"Field","name":{"kind":"Name","value":"semantic"}}]}},{"kind":"Field","name":{"kind":"Name","value":"isPublic"}},{"kind":"Field","name":{"kind":"Name","value":"shareToken"}},{"kind":"Field","name":{"kind":"Name","value":"isSeed"}}]}}]} as unknown as DocumentNode<CreateSavedSearchMutation, CreateSavedSearchMutationVariables>;
export const DeleteSavedSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteSavedSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteSavedSearch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteSavedSearchMutation, DeleteSavedSearchMutationVariables>;
export const ListSavedSearchesForTestDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ListSavedSearchesForTest"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"savedSearches"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"IntValue","value":"10"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}}]}}]} as unknown as DocumentNode<ListSavedSearchesForTestQuery, ListSavedSearchesForTestQueryVariables>;
export const UpdateSavedSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateSavedSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateSavedSearchInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateSavedSearch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"savedSearch"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"filters"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventTypes"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"datePreset"}},{"kind":"Field","name":{"kind":"Name","value":"sortBy"}},{"kind":"Field","name":{"kind":"Name","value":"sortOrder"}},{"kind":"Field","name":{"kind":"Name","value":"connectors"}},{"kind":"Field","name":{"kind":"Name","value":"people"}},{"kind":"Field","name":{"kind":"Name","value":"places"}},{"kind":"Field","name":{"kind":"Name","value":"hasLocation"}},{"kind":"Field","name":{"kind":"Name","value":"semantic"}}]}}]}}]}}]}}]} as unknown as DocumentNode<UpdateSavedSearchMutation, UpdateSavedSearchMutationVariables>;
export const GetSavedSearchesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSavedSearches"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"isSeed"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Boolean"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"savedSearches"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}},{"kind":"Argument","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"Argument","name":{"kind":"Name","value":"isSeed"},"value":{"kind":"Variable","name":{"kind":"Name","value":"isSeed"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SavedSearchGridItemFragment"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SavedSearchGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SavedSearchType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"filters"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventTypes"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"datePreset"}},{"kind":"Field","name":{"kind":"Name","value":"sortBy"}},{"kind":"Field","name":{"kind":"Name","value":"sortOrder"}},{"kind":"Field","name":{"kind":"Name","value":"connectors"}},{"kind":"Field","name":{"kind":"Name","value":"people"}},{"kind":"Field","name":{"kind":"Name","value":"places"}},{"kind":"Field","name":{"kind":"Name","value":"hasLocation"}},{"kind":"Field","name":{"kind":"Name","value":"semantic"}}]}},{"kind":"Field","name":{"kind":"Name","value":"isPublic"}},{"kind":"Field","name":{"kind":"Name","value":"shareToken"}},{"kind":"Field","name":{"kind":"Name","value":"isSeed"}}]}}]} as unknown as DocumentNode<GetSavedSearchesQuery, GetSavedSearchesQueryVariables>;
export const SetSavedSearchSharingDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SetSavedSearchSharing"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SetSavedSearchSharingInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"setSavedSearchSharing"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"savedSearch"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"isPublic"}},{"kind":"Field","name":{"kind":"Name","value":"shareToken"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SavedSearchGridItemFragment"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SavedSearchGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SavedSearchType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"filters"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"eventTypes"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"datePreset"}},{"kind":"Field","name":{"kind":"Name","value":"sortBy"}},{"kind":"Field","name":{"kind":"Name","value":"sortOrder"}},{"kind":"Field","name":{"kind":"Name","value":"connectors"}},{"kind":"Field","name":{"kind":"Name","value":"people"}},{"kind":"Field","name":{"kind":"Name","value":"places"}},{"kind":"Field","name":{"kind":"Name","value":"hasLocation"}},{"kind":"Field","name":{"kind":"Name","value":"semantic"}}]}},{"kind":"Field","name":{"kind":"Name","value":"isPublic"}},{"kind":"Field","name":{"kind":"Name","value":"shareToken"}},{"kind":"Field","name":{"kind":"Name","value":"isSeed"}}]}}]} as unknown as DocumentNode<SetSavedSearchSharingMutation, SetSavedSearchSharingMutationVariables>;
export const GetSelfProfileDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSelfProfile"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"person"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonEditorFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonEditorFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"middleName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"nickname"}},{"kind":"Field","name":{"kind":"Name","value":"pronouns"}},{"kind":"Field","name":{"kind":"Name","value":"gender"}},{"kind":"Field","name":{"kind":"Name","value":"birthDate"}},{"kind":"Field","name":{"kind":"Name","value":"jobTitle"}},{"kind":"Field","name":{"kind":"Name","value":"organization"}},{"kind":"Field","name":{"kind":"Name","value":"department"}},{"kind":"Field","name":{"kind":"Name","value":"website"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"addresses"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress"}},{"kind":"Field","name":{"kind":"Name","value":"streetAddress2"}},{"kind":"Field","name":{"kind":"Name","value":"city"}},{"kind":"Field","name":{"kind":"Name","value":"region"}},{"kind":"Field","name":{"kind":"Name","value":"postalCode"}},{"kind":"Field","name":{"kind":"Name","value":"country"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}},{"kind":"Field","name":{"kind":"Name","value":"formatted"}}]}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}}]}}]}}]} as unknown as DocumentNode<GetSelfProfileQuery, GetSelfProfileQueryVariables>;
export const GetProvidersDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetProviders"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"providers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"logoUrl"}},{"kind":"Field","name":{"kind":"Name","value":"localOnly"}},{"kind":"Field","name":{"kind":"Name","value":"appSetupUrl"}},{"kind":"Field","name":{"kind":"Name","value":"authType"}},{"kind":"Field","name":{"kind":"Name","value":"scopes"}},{"kind":"Field","name":{"kind":"Name","value":"providerKeys"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"clientId"}},{"kind":"Field","name":{"kind":"Name","value":"clientSecret"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetProvidersQuery, GetProvidersQueryVariables>;
export const CreateProviderKeyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateProviderKey"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateProviderKeyInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createProviderKey"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}},{"kind":"Field","name":{"kind":"Name","value":"clientId"}},{"kind":"Field","name":{"kind":"Name","value":"clientSecret"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}}]}}]}}]} as unknown as DocumentNode<CreateProviderKeyMutation, CreateProviderKeyMutationVariables>;
export const UpdateProviderKeyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateProviderKey"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateProviderKeyInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateProviderKey"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"clientId"}},{"kind":"Field","name":{"kind":"Name","value":"clientSecret"}}]}}]}}]} as unknown as DocumentNode<UpdateProviderKeyMutation, UpdateProviderKeyMutationVariables>;
export const DeleteProviderKeyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteProviderKey"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteProviderKey"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}]}]}}]} as unknown as DocumentNode<DeleteProviderKeyMutation, DeleteProviderKeyMutationVariables>;
export const UpdateCurrentUserTimezoneDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateCurrentUserTimezone"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateCurrentUserInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateCurrentUser"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"timezone"}}]}}]}}]} as unknown as DocumentNode<UpdateCurrentUserTimezoneMutation, UpdateCurrentUserTimezoneMutationVariables>;
export const GetSharedSavedSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSharedSavedSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"token"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sharedSavedSearch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"token"},"value":{"kind":"Variable","name":{"kind":"Name","value":"token"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<GetSharedSavedSearchQuery, GetSharedSavedSearchQueryVariables>;
export const StatsDailyMetricsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"StatsDailyMetrics"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"from"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"to"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"dailyMetrics"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"from"},"value":{"kind":"Variable","name":{"kind":"Name","value":"from"}}},{"kind":"Argument","name":{"kind":"Name","value":"to"},"value":{"kind":"Variable","name":{"kind":"Name","value":"to"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"nMessages"}},{"kind":"Field","name":{"kind":"Name","value":"nPlaces"}},{"kind":"Field","name":{"kind":"Name","value":"kmTraveled"}}]}}]}}]} as unknown as DocumentNode<StatsDailyMetricsQuery, StatsDailyMetricsQueryVariables>;
export const GetSummaryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSummary"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"summary"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"periodType"}},{"kind":"Field","name":{"kind":"Name","value":"periodStart"}},{"kind":"Field","name":{"kind":"Name","value":"periodEnd"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyInsights"}},{"kind":"Field","name":{"kind":"Name","value":"notableEvents"}},{"kind":"Field","name":{"kind":"Name","value":"anomalies"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"activityCounts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"total"}},{"kind":"Field","name":{"kind":"Name","value":"browserActivity"}},{"kind":"Field","name":{"kind":"Name","value":"communications"}},{"kind":"Field","name":{"kind":"Name","value":"files"}},{"kind":"Field","name":{"kind":"Name","value":"events"}},{"kind":"Field","name":{"kind":"Name","value":"messages"}}]}},{"kind":"Field","name":{"kind":"Name","value":"insights"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyActions"}},{"kind":"Field","name":{"kind":"Name","value":"relevanceScore"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"relatedEntityIds"}}]}},{"kind":"Field","name":{"kind":"Name","value":"dailyRhythm"}},{"kind":"Field","name":{"kind":"Name","value":"productivityPatterns"}},{"kind":"Field","name":{"kind":"Name","value":"socialInteractions"}},{"kind":"Field","name":{"kind":"Name","value":"keyAccomplishments"}},{"kind":"Field","name":{"kind":"Name","value":"moodIndicators"}},{"kind":"Field","name":{"kind":"Name","value":"confidenceScore"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]} as unknown as DocumentNode<GetSummaryQuery, GetSummaryQueryVariables>;
export const DeleteTagDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteTag"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteTag"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteTagMutation, DeleteTagMutationVariables>;
export const ListTagsForTestDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ListTagsForTest"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]} as unknown as DocumentNode<ListTagsForTestQuery, ListTagsForTestQueryVariables>;
export const UpdateTagDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateTag"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateTagInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateTag"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"merged"}},{"kind":"Field","name":{"kind":"Name","value":"movedEntityCount"}},{"kind":"Field","name":{"kind":"Name","value":"updatedSavedSearchCount"}},{"kind":"Field","name":{"kind":"Name","value":"tag"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"entityCount"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateTagMutation, UpdateTagMutationVariables>;
export const GetTagsWithUsageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetTagsWithUsage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"entityCount"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetTagsWithUsageQuery, GetTagsWithUsageQueryVariables>;
export const GetUnresolvedObservationsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetUnresolvedObservations"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"offset"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"unresolvedObservations"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}},{"kind":"Argument","name":{"kind":"Name","value":"offset"},"value":{"kind":"Variable","name":{"kind":"Name","value":"offset"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ObservationStripData"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ObservationStripData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ObjectObservationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"labelSource"}},{"kind":"Field","name":{"kind":"Name","value":"detector"}},{"kind":"Field","name":{"kind":"Name","value":"detectorVersion"}},{"kind":"Field","name":{"kind":"Name","value":"detectionConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionConfidence"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"confirmedByUser"}},{"kind":"Field","name":{"kind":"Name","value":"observedAt"}},{"kind":"Field","name":{"kind":"Name","value":"sourceKind"}},{"kind":"Field","name":{"kind":"Name","value":"placeEntityId"}},{"kind":"Field","name":{"kind":"Name","value":"bbox"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"x"}},{"kind":"Field","name":{"kind":"Name","value":"y"}},{"kind":"Field","name":{"kind":"Name","value":"w"}},{"kind":"Field","name":{"kind":"Name","value":"h"}}]}},{"kind":"Field","name":{"kind":"Name","value":"media"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"mimetype"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"mediaUrl"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"place"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]} as unknown as DocumentNode<GetUnresolvedObservationsQuery, GetUnresolvedObservationsQueryVariables>;
export const SearchThingsForObservationDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"SearchThingsForObservation"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"IntValue","value":"8"}},{"kind":"Argument","name":{"kind":"Name","value":"sort"},"value":{"kind":"EnumValue","value":"RECENTLY_SEEN"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"category"}}]}}]}}]}}]}}]} as unknown as DocumentNode<SearchThingsForObservationQuery, SearchThingsForObservationQueryVariables>;
export const ConfirmUnresolvedObservationDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ConfirmUnresolvedObservation"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"itemId"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"confirmObservation"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"itemId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"itemId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"confirmedByUser"}},{"kind":"Field","name":{"kind":"Name","value":"resolvedObjectId"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionConfidence"}}]}}]}}]} as unknown as DocumentNode<ConfirmUnresolvedObservationMutation, ConfirmUnresolvedObservationMutationVariables>;
export const RejectUnresolvedObservationDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RejectUnresolvedObservation"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"rejectObservation"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"confirmedByUser"}},{"kind":"Field","name":{"kind":"Name","value":"resolvedObjectId"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionMethod"}},{"kind":"Field","name":{"kind":"Name","value":"resolutionConfidence"}}]}}]}}]} as unknown as DocumentNode<RejectUnresolvedObservationMutation, RejectUnresolvedObservationMutationVariables>;
export const GetThingsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetThings"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"category"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"brand"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"condition"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ItemCondition"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"lifecycleState"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ItemLifecycleState"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"hasIdentifier"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Boolean"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"sort"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ItemSortOrder"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"Argument","name":{"kind":"Name","value":"category"},"value":{"kind":"Variable","name":{"kind":"Name","value":"category"}}},{"kind":"Argument","name":{"kind":"Name","value":"brand"},"value":{"kind":"Variable","name":{"kind":"Name","value":"brand"}}},{"kind":"Argument","name":{"kind":"Name","value":"condition"},"value":{"kind":"Variable","name":{"kind":"Name","value":"condition"}}},{"kind":"Argument","name":{"kind":"Name","value":"lifecycleState"},"value":{"kind":"Variable","name":{"kind":"Name","value":"lifecycleState"}}},{"kind":"Argument","name":{"kind":"Name","value":"hasIdentifier"},"value":{"kind":"Variable","name":{"kind":"Name","value":"hasIdentifier"}}},{"kind":"Argument","name":{"kind":"Name","value":"sort"},"value":{"kind":"Variable","name":{"kind":"Name","value":"sort"}}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ItemGridItemData"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ItemGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}},{"kind":"Field","name":{"kind":"Name","value":"identifiers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"rawValue"}}]}},{"kind":"Field","name":{"kind":"Name","value":"product"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}}]}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}}]} as unknown as DocumentNode<GetThingsQuery, GetThingsQueryVariables>;
export const GetItemDuplicatesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetItemDuplicates"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"offset"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"itemDuplicates"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}},{"kind":"Argument","name":{"kind":"Name","value":"offset"},"value":{"kind":"Variable","name":{"kind":"Name","value":"offset"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"hasMore"}},{"kind":"Field","name":{"kind":"Name","value":"groups"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"reason"}},{"kind":"Field","name":{"kind":"Name","value":"value"}},{"kind":"Field","name":{"kind":"Name","value":"totalItems"}},{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"lifecycleState"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetItemDuplicatesQuery, GetItemDuplicatesQueryVariables>;
export const MergeThingsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MergeThings"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"MergeItemsInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"mergeItems"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"counts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"identifiers"}},{"kind":"Field","name":{"kind":"Name","value":"observations"}},{"kind":"Field","name":{"kind":"Name","value":"receiptLineItems"}}]}}]}}]}}]} as unknown as DocumentNode<MergeThingsMutation, MergeThingsMutationVariables>;
export const RejectThingDuplicatesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RejectThingDuplicates"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"itemIds"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"rejectItemDuplicates"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"itemIds"},"value":{"kind":"Variable","name":{"kind":"Name","value":"itemIds"}}}]}]}}]} as unknown as DocumentNode<RejectThingDuplicatesMutation, RejectThingDuplicatesMutationVariables>;
export const GetOAuthCallbackUrlDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetOAuthCallbackUrl"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"oAuthCallbackUrl"}}]}}]} as unknown as DocumentNode<GetOAuthCallbackUrlQuery, GetOAuthCallbackUrlQueryVariables>;
