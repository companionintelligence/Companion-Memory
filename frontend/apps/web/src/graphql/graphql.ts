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
  tags: Array<EntityTagType>;
  text: Scalars['String']['output'];
  thread?: Maybe<ThreadType>;
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type ActivityCountsType = {
  __typename?: 'ActivityCountsType';
  activities?: Maybe<Scalars['Int']['output']>;
  apiLogs?: Maybe<Scalars['Int']['output']>;
  browserActivity?: Maybe<Scalars['Int']['output']>;
  communications?: Maybe<Scalars['Int']['output']>;
  events?: Maybe<Scalars['Int']['output']>;
  files?: Maybe<Scalars['Int']['output']>;
  measurements?: Maybe<Scalars['Int']['output']>;
  messages?: Maybe<Scalars['Int']['output']>;
  positions?: Maybe<Scalars['Int']['output']>;
  screenCaptures?: Maybe<Scalars['Int']['output']>;
  total: Scalars['Int']['output'];
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

export type AnswerType = Node & {
  __typename?: 'AnswerType';
  answer: Scalars['String']['output'];
  answerMethod: Scalars['String']['output'];
  answerSource?: Maybe<Scalars['String']['output']>;
  answeredAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  question: QuestionType;
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
  content: Scalars['String']['output'];
  direction: Scalars['String']['output'];
  from?: Maybe<PersonType>;
  id: Scalars['ID']['output'];
  preview?: Maybe<Scalars['String']['output']>;
  subject?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
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

export type ContentType = Node & Taggable & {
  __typename?: 'ContentType';
  event?: Maybe<EventType>;
  externalId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  mimetype?: Maybe<Scalars['String']['output']>;
  sourceData?: Maybe<Scalars['JSON']['output']>;
  sourceUrl?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  text?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  type?: Maybe<Scalars['String']['output']>;
  url?: Maybe<Scalars['String']['output']>;
};

export type CreateAnswerInput = {
  answer: Scalars['String']['input'];
  questionId: Scalars['String']['input'];
};

export type CreateConceptInput = {
  description?: InputMaybe<Scalars['String']['input']>;
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
  externalId?: InputMaybe<Scalars['String']['input']>;
  mimetype?: InputMaybe<Scalars['String']['input']>;
  sourceData?: InputMaybe<Scalars['JSON']['input']>;
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
  sourceId?: InputMaybe<Scalars['ID']['input']>;
  sourceSystem?: InputMaybe<Scalars['String']['input']>;
  sourceType?: InputMaybe<Scalars['String']['input']>;
  startTime: Scalars['DateTime']['input'];
  status?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type CreateItemInput = {
  brand?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  currentValue?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
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

export type CreatePersonInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
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
  locationBoundary?: InputMaybe<Scalars['JSON']['input']>;
  name: Scalars['String']['input'];
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
  name?: InputMaybe<Scalars['String']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type CreateSavedSearchPayload = {
  __typename?: 'CreateSavedSearchPayload';
  savedSearch?: Maybe<SavedSearchType>;
  success: Scalars['Boolean']['output'];
};

export type DeleteByIdInput = {
  id: Scalars['String']['input'];
};

export type DeleteByIdPayload = {
  __typename?: 'DeleteByIdPayload';
  deletedId?: Maybe<Scalars['ID']['output']>;
  success: Scalars['Boolean']['output'];
};

export type Edge = {
  cursor: Scalars['String']['output'];
  node: Node;
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
  description?: Maybe<Scalars['String']['output']>;
  durationMinutes?: Maybe<Scalars['Int']['output']>;
  endTime?: Maybe<Scalars['DateTime']['output']>;
  eventType?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isAllDay?: Maybe<Scalars['Boolean']['output']>;
  isRecurring?: Maybe<Scalars['Boolean']['output']>;
  location?: Maybe<PlaceType>;
  locationCoordinates?: Maybe<Scalars['JSON']['output']>;
  locationEntityId?: Maybe<Scalars['ID']['output']>;
  locationName?: Maybe<Scalars['String']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  organizer?: Maybe<PersonType>;
  organizerEntityId?: Maybe<Scalars['ID']['output']>;
  participantEntityIds?: Maybe<Array<Scalars['ID']['output']>>;
  participants: PersonConnection;
  sourceId?: Maybe<Scalars['ID']['output']>;
  sourceSystem?: Maybe<Scalars['String']['output']>;
  sourceType?: Maybe<Scalars['String']['output']>;
  startTime: Scalars['DateTime']['output'];
  status?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  title?: Maybe<Scalars['String']['output']>;
};


export type EventTypeParticipantsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
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

export type InsightItemType = {
  __typename?: 'InsightItemType';
  keyActions: Array<Scalars['String']['output']>;
  relatedEntityIds?: Maybe<Array<Scalars['String']['output']>>;
  relevanceScore: Scalars['Float']['output'];
  summaryText: Scalars['String']['output'];
  tags: Array<Scalars['String']['output']>;
  title: Scalars['String']['output'];
};

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

export type ItemEdge = Edge & {
  __typename?: 'ItemEdge';
  cursor: Scalars['String']['output'];
  node: ItemType;
};

export type ItemType = Node & Taggable & {
  __typename?: 'ItemType';
  acquiredAt?: Maybe<Scalars['DateTime']['output']>;
  brand?: Maybe<Scalars['String']['output']>;
  category?: Maybe<Scalars['String']['output']>;
  condition?: Maybe<ItemCondition>;
  createdAt: Scalars['DateTime']['output'];
  currency: Scalars['String']['output'];
  currentValue?: Maybe<Scalars['Float']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  file?: Maybe<FileType>;
  id: Scalars['ID']['output'];
  metadata?: Maybe<Scalars['JSON']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  subcategory?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
  updatedAt: Scalars['DateTime']['output'];
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

export type Mutation = {
  __typename?: 'Mutation';
  createAnswer: AnswerType;
  createConcept: CreateConceptPayload;
  createConnection: CreateConnectionPayload;
  createConnectionSyncJob: CreateConnectionSyncJobPayload;
  createContent: ContentType;
  createEvent: EventType;
  createItem: CreateItemPayload;
  createNote: CreateNotePayload;
  createPerson: CreatePersonPayload;
  createPlace: PlaceType;
  createProviderKey: ProviderKeyType;
  createQuestion: QuestionType;
  createRelationship: CreateRelationshipPayload;
  createSavedSearch: CreateSavedSearchPayload;
  deleteConcept: DeleteByIdPayload;
  deleteConnection: DeleteByIdPayload;
  deleteConnectionSyncJob: DeleteByIdPayload;
  deleteItem: DeleteByIdPayload;
  deleteNote: DeleteByIdPayload;
  deletePerson: DeleteByIdPayload;
  deleteProviderKey: Scalars['Boolean']['output'];
  deleteRelationship: DeleteByIdPayload;
  deleteSavedSearch: DeleteByIdPayload;
  /** Mark an action as dismissed */
  markActionAsDismissed?: Maybe<ActionType>;
  /** Mark an action as seen */
  markActionAsSeen?: Maybe<ActionType>;
  /** Mark a summary as dismissed */
  markSummaryAsDismissed?: Maybe<SummaryType>;
  /** Mark a summary as seen */
  markSummaryAsSeen?: Maybe<SummaryType>;
  removeAnswer: Scalars['Boolean']['output'];
  removeContent: Scalars['Boolean']['output'];
  removeEvent: Scalars['Boolean']['output'];
  removePlace: Scalars['Boolean']['output'];
  removeQuestion: Scalars['Boolean']['output'];
  tagEntities: Array<TaggableEntityType>;
  untagEntities: Array<TaggableEntityType>;
  updateAnswer?: Maybe<AnswerType>;
  updateConcept: UpdateConceptPayload;
  updateConnection: UpdateConnectionPayload;
  updateConnectionSyncJob: UpdateConnectionSyncJobPayload;
  updateContent?: Maybe<ContentType>;
  updateEvent?: Maybe<EventType>;
  updateItem: UpdateItemPayload;
  updateNote: UpdateNotePayload;
  updatePerson: UpdatePersonPayload;
  updatePlace?: Maybe<PlaceType>;
  updateProviderKey?: Maybe<ProviderKeyType>;
  updateQuestion?: Maybe<QuestionType>;
  updateRelationship: UpdateRelationshipPayload;
  updateSavedSearch: UpdateSavedSearchPayload;
};


export type MutationCreateAnswerArgs = {
  input: CreateAnswerInput;
};


export type MutationCreateConceptArgs = {
  input: CreateConceptInput;
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


export type MutationCreateEventArgs = {
  input: CreateEventInput;
};


export type MutationCreateItemArgs = {
  input: CreateItemInput;
};


export type MutationCreateNoteArgs = {
  input: CreateNoteInput;
};


export type MutationCreatePersonArgs = {
  input: CreatePersonInput;
};


export type MutationCreatePlaceArgs = {
  input: CreatePlaceInput;
};


export type MutationCreateProviderKeyArgs = {
  input: CreateProviderKeyInput;
};


export type MutationCreateQuestionArgs = {
  input: CreateQuestionInput;
};


export type MutationCreateRelationshipArgs = {
  input: CreateRelationshipInput;
};


export type MutationCreateSavedSearchArgs = {
  input: CreateSavedSearchInput;
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


export type MutationDeleteItemArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteNoteArgs = {
  input: DeleteByIdInput;
};


export type MutationDeletePersonArgs = {
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


export type MutationRemoveAnswerArgs = {
  id: Scalars['String']['input'];
};


export type MutationRemoveContentArgs = {
  id: Scalars['String']['input'];
};


export type MutationRemoveEventArgs = {
  id: Scalars['String']['input'];
};


export type MutationRemovePlaceArgs = {
  id: Scalars['String']['input'];
};


export type MutationRemoveQuestionArgs = {
  id: Scalars['String']['input'];
};


export type MutationTagEntitiesArgs = {
  input: TagEntitiesInput;
};


export type MutationUntagEntitiesArgs = {
  input: TagEntitiesInput;
};


export type MutationUpdateAnswerArgs = {
  input: UpdateAnswerInput;
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


export type MutationUpdateEventArgs = {
  input: UpdateEventInput;
};


export type MutationUpdateItemArgs = {
  input: UpdateItemInput;
};


export type MutationUpdateNoteArgs = {
  input: UpdateNoteInput;
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

export type PageInfo = {
  __typename?: 'PageInfo';
  endCursor?: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
  hasPreviousPage: Scalars['Boolean']['output'];
  startCursor?: Maybe<Scalars['String']['output']>;
};

export type PersonConnection = Connection & {
  __typename?: 'PersonConnection';
  edges: Array<PersonEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type PersonEdge = Edge & {
  __typename?: 'PersonEdge';
  cursor: Scalars['String']['output'];
  node: PersonType;
};

export type PersonType = Node & Taggable & {
  __typename?: 'PersonType';
  address?: Maybe<Scalars['String']['output']>;
  avatarUrl?: Maybe<Scalars['String']['output']>;
  city?: Maybe<Scalars['String']['output']>;
  country?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  firstName?: Maybe<Scalars['String']['output']>;
  gender?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  lastName?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  postalCode?: Maybe<Scalars['String']['output']>;
  region?: Maybe<Scalars['String']['output']>;
  streetAddress?: Maybe<Scalars['String']['output']>;
  streetAddress2?: Maybe<Scalars['String']['output']>;
  tags: Array<EntityTagType>;
};

export type PlaceConnection = Connection & {
  __typename?: 'PlaceConnection';
  edges: Array<PlaceEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type PlaceEdge = Edge & {
  __typename?: 'PlaceEdge';
  cursor: Scalars['String']['output'];
  node: PlaceType;
};

export type PlaceType = Node & Taggable & {
  __typename?: 'PlaceType';
  description?: Maybe<Scalars['String']['output']>;
  entityType: Scalars['String']['output'];
  estimated?: Maybe<Scalars['Boolean']['output']>;
  geoFormat?: Maybe<Scalars['String']['output']>;
  geolocation?: Maybe<Scalars['JSON']['output']>;
  id: Scalars['ID']['output'];
  locationBoundary?: Maybe<Scalars['JSON']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  properties: Scalars['JSON']['output'];
  tags: Array<EntityTagType>;
  tracked?: Maybe<Scalars['Boolean']['output']>;
  type?: Maybe<Scalars['String']['output']>;
  uploaded?: Maybe<Scalars['Boolean']['output']>;
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
  TTL: Scalars['Float']['output'];
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
  description?: Maybe<Scalars['String']['output']>;
  endpoints: Array<ProviderEndpointType>;
  id: Scalars['ID']['output'];
  logoUrl?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  providerKeys?: Maybe<ProviderKeyType>;
  theme?: Maybe<ProviderThemeType>;
};

export type Query = {
  __typename?: 'Query';
  action?: Maybe<ActionType>;
  actions: ActionConnection;
  answer?: Maybe<AnswerType>;
  answers: AnswerConnection;
  browserActivities: BrowserActivityConnection;
  browserActivity?: Maybe<BrowserActivityType>;
  communication?: Maybe<CommunicationType>;
  communications: CommunicationConnection;
  concept?: Maybe<ConceptType>;
  concepts: ConceptConnection;
  connection?: Maybe<ConnectionType>;
  connectionSyncJob?: Maybe<ConnectionSyncJobType>;
  connectionSyncJobs: ConnectionSyncJobConnection;
  connections: ConnectionConnection;
  content?: Maybe<ContentType>;
  contents: ContentConnection;
  event?: Maybe<EventType>;
  events: EventConnection;
  /** Get actions for the feed, prioritizing unseen actions */
  feedActions: Array<ActionType>;
  file?: Maybe<FileType>;
  files: FileConnection;
  item?: Maybe<ItemType>;
  items: ItemConnection;
  me?: Maybe<UserType>;
  node?: Maybe<Node>;
  note?: Maybe<NoteType>;
  notes: NoteConnection;
  people: PersonConnection;
  person?: Maybe<PersonType>;
  place?: Maybe<PlaceType>;
  places: PlaceConnection;
  provider?: Maybe<ProviderType>;
  providers: ProviderConnection;
  question?: Maybe<QuestionType>;
  questions: QuestionConnection;
  relationship?: Maybe<RelationshipType>;
  relationships: RelationshipConnection;
  savedSearch?: Maybe<SavedSearchType>;
  savedSearches: SavedSearchConnection;
  search: SearchResultConnection;
  summaries: SummaryConnection;
  summary?: Maybe<SummaryType>;
  tag?: Maybe<TagType>;
  tags: TagConnection;
  thread?: Maybe<ThreadType>;
  threads: ThreadConnection;
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


export type QueryAnswerArgs = {
  id: Scalars['ID']['input'];
};


export type QueryAnswersArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
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
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
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
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
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


export type QueryItemArgs = {
  id: Scalars['ID']['input'];
};


export type QueryItemsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
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


export type QueryPeopleArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryPersonArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPlaceArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPlacesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
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


export type QueryRelationshipArgs = {
  id: Scalars['ID']['input'];
};


export type QueryRelationshipsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySavedSearchArgs = {
  id: Scalars['ID']['input'];
};


export type QuerySavedSearchesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySearchArgs = {
  input: SearchInput;
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


export type QueryThreadArgs = {
  id: Scalars['ID']['input'];
};


export type QueryThreadsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
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
  category: Scalars['String']['output'];
  createdByLlm?: Maybe<Scalars['Boolean']['output']>;
  id: Scalars['ID']['output'];
  isSeedQuestion?: Maybe<Scalars['Boolean']['output']>;
  questionType?: Maybe<Scalars['String']['output']>;
  text: Scalars['String']['output'];
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

export type SavedSearchType = Node & {
  __typename?: 'SavedSearchType';
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  entityTypes?: Maybe<Array<Scalars['String']['output']>>;
  id: Scalars['ID']['output'];
  name?: Maybe<Scalars['String']['output']>;
  query?: Maybe<Scalars['String']['output']>;
  tags?: Maybe<Array<Scalars['String']['output']>>;
  updatedAt: Scalars['DateTime']['output'];
};

export type SearchInput = {
  endTime?: InputMaybe<Scalars['String']['input']>;
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  includeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  query?: InputMaybe<Scalars['String']['input']>;
  startTime?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type SearchResultConnection = {
  __typename?: 'SearchResultConnection';
  edges: Array<SearchResultEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type SearchResultEdge = {
  __typename?: 'SearchResultEdge';
  cursor: Scalars['String']['output'];
  node: SearchResultType;
};

export type SearchResultType = AnswerType | BrowserActivityType | CommunicationType | ConceptType | ContentType | EventType | FileType | ItemType | NoteType | PersonType | PlaceType | ThreadType;

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

export type TaggableEntityType = ActionType | BrowserActivityType | CommunicationType | ConceptType | ContentType | EventType | FileType | ItemType | NoteType | PersonType | PlaceType | ThreadType;

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

export type UpdateAnswerInput = {
  answer: Scalars['String']['input'];
  id: Scalars['String']['input'];
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

export type UpdateItemInput = {
  brand?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  currentValue?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
};

export type UpdateItemPayload = {
  __typename?: 'UpdateItemPayload';
  item?: Maybe<ItemType>;
  success: Scalars['Boolean']['output'];
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

export type UpdatePersonInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['String']['input'];
  name: Scalars['String']['input'];
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
  locationBoundary?: InputMaybe<Scalars['JSON']['input']>;
  name: Scalars['String']['input'];
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
  id: Scalars['String']['input'];
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

export type UserType = Node & {
  __typename?: 'UserType';
  email: Scalars['String']['output'];
  entity?: Maybe<PersonType>;
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  onboarded: Scalars['Boolean']['output'];
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
    | { __typename?: 'ThreadType', id: string, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> }
  > };

export type GetNodeTagsForRelationshipCardQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetNodeTagsForRelationshipCardQuery = { __typename?: 'Query', node?:
    | { __typename: 'ActionType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'AnswerType' }
    | { __typename: 'BrowserActivityType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'CommunicationType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'ConceptType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'ConnectionSyncJobType' }
    | { __typename: 'ConnectionType' }
    | { __typename: 'ContentType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'EntityTagType' }
    | { __typename: 'EventType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'FileType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'ItemType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'MessageType' }
    | { __typename: 'NoteType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'PersonType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'PlaceType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'ProviderKeyType' }
    | { __typename: 'ProviderType' }
    | { __typename: 'QuestionType' }
    | { __typename: 'RelationshipType' }
    | { __typename: 'SavedSearchType' }
    | { __typename: 'SummaryType' }
    | { __typename: 'TagType' }
    | { __typename: 'ThreadType', tags: Array<{ __typename?: 'EntityTagType', label: string }> }
    | { __typename: 'UserType' }
   | null };

export type ActionGridItemDataFragment = { __typename?: 'ActionType', id: string, actionTitle: string, actionText: string } & { ' $fragmentName'?: 'ActionGridItemDataFragment' };

export type AnswerGridItemDataFragment = { __typename?: 'AnswerType', id: string, answer: string, question: { __typename?: 'QuestionType', id: string, text: string } } & { ' $fragmentName'?: 'AnswerGridItemDataFragment' };

export type BrowserActivityGridItemDataFragment = { __typename?: 'BrowserActivityType', id: string, title?: string | null, url: string } & { ' $fragmentName'?: 'BrowserActivityGridItemDataFragment' };

export type CommunicationGridItemDataFragment = { __typename?: 'CommunicationType', id: string, subject?: string | null, preview?: string | null } & { ' $fragmentName'?: 'CommunicationGridItemDataFragment' };

export type ConceptGridItemDataFragment = { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'ConceptGridItemDataFragment' };

export type ContentGridItemDataFragment = { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null } & { ' $fragmentName'?: 'ContentGridItemDataFragment' };

export type EventGridItemDataFragment = { __typename?: 'EventType', id: string, title?: string | null, description?: string | null } & { ' $fragmentName'?: 'EventGridItemDataFragment' };

export type FileGridItemDataFragment = { __typename?: 'FileType', id: string, filename?: string | null, previewUrl?: string | null } & { ' $fragmentName'?: 'FileGridItemDataFragment' };

export type ItemGridItemDataFragment = { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, file?: { __typename?: 'FileType', id: string, sourceUrl?: string | null } | null } & { ' $fragmentName'?: 'ItemGridItemDataFragment' };

export type NoteGridItemDataFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null } & { ' $fragmentName'?: 'NoteGridItemDataFragment' };

export type PersonGridItemDataFragment = { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'PersonGridItemDataFragment' };

export type PlaceGridItemDataFragment = { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'PlaceGridItemDataFragment' };

export type ThreadGridItemDataFragment = { __typename?: 'ThreadType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'ThreadGridItemDataFragment' };

export type CreateConceptMutationVariables = Exact<{
  input: CreateConceptInput;
}>;


export type CreateConceptMutation = { __typename?: 'Mutation', createConcept: { __typename?: 'CreateConceptPayload', success: boolean, concept?: { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null } | null } };

export type CreatePersonMutationVariables = Exact<{
  input: CreatePersonInput;
}>;


export type CreatePersonMutation = { __typename?: 'Mutation', createPerson: { __typename?: 'CreatePersonPayload', success: boolean, person?: { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null } | null } };

export type CreateRelationshipMutationVariables = Exact<{
  input: CreateRelationshipInput;
}>;


export type CreateRelationshipMutation = { __typename?: 'Mutation', createRelationship: { __typename?: 'CreateRelationshipPayload', success: boolean, relationship?: { __typename?: 'RelationshipType', id: string, fromNodeId: string, fromNodeType: string, toNodeId: string, toNodeType: string, type: string, properties?: any | null, isBidirectional: boolean, startDate?: any | null, endDate?: any | null } | null } };

export type GetFilePreviewQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetFilePreviewQuery = { __typename?: 'Query', file?: { __typename?: 'FileType', id: string, filename?: string | null, contentType: string, sourceUrl?: string | null, previewUrl?: string | null, createdAt: any } | null };

export type CreateItemMutationVariables = Exact<{
  input: CreateItemInput;
}>;


export type CreateItemMutation = { __typename?: 'Mutation', createItem: { __typename?: 'CreateItemPayload', success: boolean, item?: { __typename?: 'ItemType', id: string, name?: string | null, category?: string | null, description?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null } };

export type UpdateItemMutationVariables = Exact<{
  input: UpdateItemInput;
}>;


export type UpdateItemMutation = { __typename?: 'Mutation', updateItem: { __typename?: 'UpdateItemPayload', success: boolean, item?: { __typename?: 'ItemType', id: string, name?: string | null, category?: string | null, description?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null } };

export type NewItemFragment = { __typename?: 'ItemType', id: string, name?: string | null, category?: string | null, description?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null } & { ' $fragmentName'?: 'NewItemFragment' };

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
}>;


export type SearchBoxQueryQuery = { __typename?: 'Query', search: { __typename?: 'SearchResultConnection', edges: Array<{ __typename?: 'SearchResultEdge', node:
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
          { __typename: 'PersonType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultPersonDataFragment': SearchResultPersonDataFragment } }
        )
        | (
          { __typename: 'PlaceType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultPlaceDataFragment': SearchResultPlaceDataFragment } }
        )
        | (
          { __typename: 'ThreadType', id: string }
          & { ' $fragmentRefs'?: { 'SearchResultThreadDataFragment': SearchResultThreadDataFragment } }
        )
       }> } };

export type GetUserDataQueryVariables = Exact<{ [key: string]: never; }>;


export type GetUserDataQuery = { __typename?: 'Query', me?: { __typename?: 'UserType', id: string, name: string, email: string, onboarded: boolean, entity?: { __typename?: 'PersonType', id: string } | null } | null };

export type GetFeedBadgeCountQueryVariables = Exact<{
  actionLimit?: InputMaybe<Scalars['Int']['input']>;
  summaryFirst?: InputMaybe<Scalars['Int']['input']>;
}>;


export type GetFeedBadgeCountQuery = { __typename?: 'Query', feedActions: Array<{ __typename?: 'ActionType', id: string, seen: boolean, dismissed: boolean }>, summaries: { __typename?: 'SummaryConnection', edges: Array<{ __typename?: 'SummaryEdge', node: { __typename?: 'SummaryType', id: string, seen: boolean, dismissed: boolean } }> } };

export type GetCommunicationQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetCommunicationQuery = { __typename?: 'Query', communication?: { __typename?: 'CommunicationType', id: string, type: string, subject?: string | null, preview?: string | null, content: string, from?: { __typename?: 'PersonType', id: string, name?: string | null } | null, to: { __typename?: 'PersonConnection', edges: Array<{ __typename?: 'PersonEdge', node: { __typename?: 'PersonType', id: string, name?: string | null } }> }, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null };

export type GetConceptQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetConceptQuery = { __typename?: 'Query', concept?: { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null };

export type GetConnectionsLightQueryVariables = Exact<{ [key: string]: never; }>;


export type GetConnectionsLightQuery = { __typename?: 'Query', connections: { __typename?: 'ConnectionConnection', totalCount: number, edges: Array<{ __typename?: 'ConnectionEdge', cursor: string, node: { __typename?: 'ConnectionType', id: string, providerId: string } }>, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, hasPreviousPage: boolean, startCursor?: string | null, endCursor?: string | null } } };

export type GetConnectionQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetConnectionQuery = { __typename?: 'Query', connection?: { __typename?: 'ConnectionType', id: string, name?: string | null, active: boolean, schedule?: string | null, tokenExpiry?: any | null, syncState?: any | null, activeEndpoints: Array<string>, providerId: string, needsReauth: boolean, externalId?: string | null, provider: { __typename?: 'ProviderType', id: string, name?: string | null, endpoints: Array<{ __typename?: 'ProviderEndpointType', name: string, description: string }> } } | null };

export type UpdateConnectionMutationVariables = Exact<{
  input: UpdateConnectionInput;
}>;


export type UpdateConnectionMutation = { __typename?: 'Mutation', updateConnection: { __typename?: 'UpdateConnectionPayload', success: boolean, connection?: { __typename?: 'ConnectionType', id: string, name?: string | null, active: boolean, schedule?: string | null, tokenExpiry?: any | null, syncState?: any | null, activeEndpoints: Array<string>, providerId: string, needsReauth: boolean, externalId?: string | null, provider: { __typename?: 'ProviderType', id: string, name?: string | null, endpoints: Array<{ __typename?: 'ProviderEndpointType', name: string, description: string }> } } | null } };

export type DeleteConnectionMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteConnectionMutation = { __typename?: 'Mutation', deleteConnection: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type GetConnectionSyncJobsQueryVariables = Exact<{
  connectionId: Scalars['ID']['input'];
}>;


export type GetConnectionSyncJobsQuery = { __typename?: 'Query', connectionSyncJobs: { __typename?: 'ConnectionSyncJobConnection', totalCount: number, edges: Array<{ __typename?: 'ConnectionSyncJobEdge', cursor: string, node: { __typename?: 'ConnectionSyncJobType', id: string, cursor?: any | null, endpointName: string, nextCursor?: any | null, connectionId: string, status: string, type: string, createdAt: any, updatedAt: any, completedAt?: any | null, error?: any | null } }>, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, hasPreviousPage: boolean, startCursor?: string | null, endCursor?: string | null } } };

export type GetConnectionsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetConnectionsQuery = { __typename?: 'Query', connections: { __typename?: 'ConnectionConnection', totalCount: number, edges: Array<{ __typename?: 'ConnectionEdge', cursor: string, node: { __typename?: 'ConnectionType', id: string, name?: string | null, active: boolean, schedule?: string | null, tokenExpiry?: any | null, syncState?: any | null, activeEndpoints: Array<string>, providerId: string, needsReauth: boolean, externalId?: string | null, provider: { __typename?: 'ProviderType', id: string, name?: string | null, endpoints: Array<{ __typename?: 'ProviderEndpointType', name: string, description: string }> } } }>, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, hasPreviousPage: boolean, startCursor?: string | null, endCursor?: string | null } } };

export type GetContentQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetContentQuery = { __typename?: 'Query', content?: { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null };

export type GetEventQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetEventQuery = { __typename?: 'Query', event?: { __typename?: 'EventType', id: string, title?: string | null, description?: string | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }>, location?: { __typename?: 'PlaceType', id: string, name?: string | null, properties: any } | null, organizer?: { __typename?: 'PersonType', id: string, name?: string | null } | null, participants: { __typename?: 'PersonConnection', edges: Array<{ __typename?: 'PersonEdge', node: { __typename?: 'PersonType', id: string, name?: string | null } }> } } | null };

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

export type GetFilesQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetFilesQuery = { __typename?: 'Query', files: { __typename?: 'FileConnection', edges: Array<{ __typename?: 'FileEdge', node: (
        { __typename?: 'FileType', id: string }
        & { ' $fragmentRefs'?: { 'FileGridItemFragmentFragment': FileGridItemFragmentFragment } }
      ) }> } };

export type FileGridItemFragmentFragment = { __typename?: 'FileType', id: string, filename?: string | null, previewUrl?: string | null } & { ' $fragmentName'?: 'FileGridItemFragmentFragment' };

export type GetInventoryItemsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetInventoryItemsQuery = { __typename?: 'Query', items: { __typename?: 'ItemConnection', edges: Array<{ __typename?: 'ItemEdge', node: { __typename?: 'ItemType', id: string, name?: string | null, category?: string | null, description?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null, file?: { __typename?: 'FileType', sourceUrl?: string | null } | null } }> } };

export type GetItemQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetItemQuery = { __typename?: 'Query', item?: { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null };

export type TimelineBrowserActivityCardDataFragment = { __typename?: 'BrowserActivityType', id: string, title?: string | null, url: string, actionType?: string | null, duration?: number | null, time: any } & { ' $fragmentName'?: 'TimelineBrowserActivityCardDataFragment' };

export type TimelineCommunicationCardDataFragment = { __typename?: 'CommunicationType', id: string, subject?: string | null, preview?: string | null, time: any, type: string, direction: string, communicationContent: string, from?: { __typename?: 'PersonType', id: string, name?: string | null } | null, to: { __typename?: 'PersonConnection', edges: Array<{ __typename?: 'PersonEdge', node: { __typename?: 'PersonType', id: string, name?: string | null } }> } } & { ' $fragmentName'?: 'TimelineCommunicationCardDataFragment' };

export type TimelineEventCardDataFragment = { __typename?: 'EventType', id: string, title?: string | null, description?: string | null, startTime: any, endTime?: any | null, location?: { __typename?: 'PlaceType', id: string, name?: string | null, properties: any } | null } & { ' $fragmentName'?: 'TimelineEventCardDataFragment' };

export type CreateSavedSearchMutationVariables = Exact<{
  input: CreateSavedSearchInput;
}>;


export type CreateSavedSearchMutation = { __typename?: 'Mutation', createSavedSearch: { __typename?: 'CreateSavedSearchPayload', savedSearch?: { __typename?: 'SavedSearchType', id: string, name?: string | null, description?: string | null, query?: string | null, entityTypes?: Array<string> | null, tags?: Array<string> | null } | null } };

export type GetSavedSearchQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetSavedSearchQuery = { __typename?: 'Query', savedSearch?: { __typename?: 'SavedSearchType', id: string, name?: string | null, description?: string | null, query?: string | null, entityTypes?: Array<string> | null, tags?: Array<string> | null } | null };

export type TableAnswerRowDataFragment = { __typename?: 'AnswerType', id: string, answer: string, question: { __typename?: 'QuestionType', id: string, text: string } } & { ' $fragmentName'?: 'TableAnswerRowDataFragment' };

export type TableBrowserActivityRowDataFragment = { __typename?: 'BrowserActivityType', id: string, title?: string | null, url: string } & { ' $fragmentName'?: 'TableBrowserActivityRowDataFragment' };

export type TableCommunicationRowDataFragment = { __typename?: 'CommunicationType', id: string, subject?: string | null, preview?: string | null } & { ' $fragmentName'?: 'TableCommunicationRowDataFragment' };

export type TableConceptRowDataFragment = { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TableConceptRowDataFragment' };

export type TableContentRowDataFragment = { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null } & { ' $fragmentName'?: 'TableContentRowDataFragment' };

export type TableEventRowDataFragment = { __typename?: 'EventType', id: string, title?: string | null, description?: string | null } & { ' $fragmentName'?: 'TableEventRowDataFragment' };

export type TableFileRowDataFragment = { __typename?: 'FileType', id: string, filename?: string | null, title?: string | null, previewUrl?: string | null, contentType: string } & { ' $fragmentName'?: 'TableFileRowDataFragment' };

export type TableItemRowDataFragment = { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, file?: { __typename?: 'FileType', id: string, sourceUrl?: string | null } | null } & { ' $fragmentName'?: 'TableItemRowDataFragment' };

export type TableNoteRowDataFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null } & { ' $fragmentName'?: 'TableNoteRowDataFragment' };

export type TablePersonRowDataFragment = { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TablePersonRowDataFragment' };

export type TablePlaceRowDataFragment = { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TablePlaceRowDataFragment' };

export type TableThreadRowDataFragment = { __typename?: 'ThreadType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TableThreadRowDataFragment' };

export type SearchQueryVariables = Exact<{
  query: Scalars['String']['input'];
  includeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
}>;


export type SearchQuery = { __typename?: 'Query', search: { __typename?: 'SearchResultConnection', edges: Array<{ __typename?: 'SearchResultEdge', node:
        | (
          { __typename: 'AnswerType', id: string }
          & { ' $fragmentRefs'?: { 'AnswerGridItemDataFragment': AnswerGridItemDataFragment;'TableAnswerRowDataFragment': TableAnswerRowDataFragment } }
        )
        | (
          { __typename: 'BrowserActivityType', id: string }
          & { ' $fragmentRefs'?: { 'BrowserActivityGridItemDataFragment': BrowserActivityGridItemDataFragment;'TableBrowserActivityRowDataFragment': TableBrowserActivityRowDataFragment;'TimelineBrowserActivityCardDataFragment': TimelineBrowserActivityCardDataFragment } }
        )
        | (
          { __typename: 'CommunicationType', id: string }
          & { ' $fragmentRefs'?: { 'CommunicationGridItemDataFragment': CommunicationGridItemDataFragment;'TableCommunicationRowDataFragment': TableCommunicationRowDataFragment;'TimelineCommunicationCardDataFragment': TimelineCommunicationCardDataFragment } }
        )
        | (
          { __typename: 'ConceptType', id: string }
          & { ' $fragmentRefs'?: { 'ConceptGridItemDataFragment': ConceptGridItemDataFragment;'TableConceptRowDataFragment': TableConceptRowDataFragment } }
        )
        | (
          { __typename: 'ContentType', id: string }
          & { ' $fragmentRefs'?: { 'ContentGridItemDataFragment': ContentGridItemDataFragment;'TableContentRowDataFragment': TableContentRowDataFragment } }
        )
        | (
          { __typename: 'EventType', id: string }
          & { ' $fragmentRefs'?: { 'EventGridItemDataFragment': EventGridItemDataFragment;'TableEventRowDataFragment': TableEventRowDataFragment;'TimelineEventCardDataFragment': TimelineEventCardDataFragment } }
        )
        | (
          { __typename: 'FileType', id: string }
          & { ' $fragmentRefs'?: { 'FileGridItemDataFragment': FileGridItemDataFragment;'TableFileRowDataFragment': TableFileRowDataFragment } }
        )
        | (
          { __typename: 'ItemType', id: string }
          & { ' $fragmentRefs'?: { 'ItemGridItemDataFragment': ItemGridItemDataFragment;'TableItemRowDataFragment': TableItemRowDataFragment } }
        )
        | (
          { __typename: 'NoteType', id: string }
          & { ' $fragmentRefs'?: { 'NoteGridItemDataFragment': NoteGridItemDataFragment;'TableNoteRowDataFragment': TableNoteRowDataFragment } }
        )
        | (
          { __typename: 'PersonType', id: string }
          & { ' $fragmentRefs'?: { 'PersonGridItemDataFragment': PersonGridItemDataFragment;'TablePersonRowDataFragment': TablePersonRowDataFragment } }
        )
        | (
          { __typename: 'PlaceType', id: string }
          & { ' $fragmentRefs'?: { 'PlaceGridItemDataFragment': PlaceGridItemDataFragment;'TablePlaceRowDataFragment': TablePlaceRowDataFragment } }
        )
        | (
          { __typename: 'ThreadType', id: string }
          & { ' $fragmentRefs'?: { 'ThreadGridItemDataFragment': ThreadGridItemDataFragment;'TableThreadRowDataFragment': TableThreadRowDataFragment } }
        )
       }> } };

export type GetNoteQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetNoteQuery = { __typename?: 'Query', note?: { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null, updatedAt: any } | null };

export type UpdateNoteMutationVariables = Exact<{
  input: UpdateNoteInput;
}>;


export type UpdateNoteMutation = { __typename?: 'Mutation', updateNote: { __typename?: 'UpdateNotePayload', success: boolean, note?: { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null, updatedAt: any } | null } };

export type CreateNoteMutationVariables = Exact<{
  input: CreateNoteInput;
}>;


export type CreateNoteMutation = { __typename?: 'Mutation', createNote: { __typename?: 'CreateNotePayload', success: boolean, note?: { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null, updatedAt: any } | null } };

export type NewNoteFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null, updatedAt: any } & { ' $fragmentName'?: 'NewNoteFragment' };

export type DeleteNoteMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteNoteMutation = { __typename?: 'Mutation', deleteNote: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type NoteGridItemFragmentFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null } & { ' $fragmentName'?: 'NoteGridItemFragmentFragment' };

export type GetNotesQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetNotesQuery = { __typename?: 'Query', notes: { __typename?: 'NoteConnection', edges: Array<{ __typename?: 'NoteEdge', node: (
        { __typename?: 'NoteType', id: string }
        & { ' $fragmentRefs'?: { 'NoteGridItemFragmentFragment': NoteGridItemFragmentFragment } }
      ) }> } };

export type GetPersonQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetPersonQuery = { __typename?: 'Query', person?: { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null };

export type GetPlaceQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetPlaceQuery = { __typename?: 'Query', place?: { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null, properties: any, tags: Array<{ __typename?: 'EntityTagType', id: string, label: string }> } | null };

export type ProviderEndpointsFragmentFragment = { __typename?: 'ProviderType', endpoints: Array<{ __typename?: 'ProviderEndpointType', name: string, description: string }> } & { ' $fragmentName'?: 'ProviderEndpointsFragmentFragment' };

export type GetProviderQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetProviderQuery = { __typename?: 'Query', provider?: (
    { __typename?: 'ProviderType', id: string, name?: string | null, description?: string | null, logoUrl?: string | null, theme?: { __typename?: 'ProviderThemeType', backgroundColor?: string | null, borderColor?: string | null } | null }
    & { ' $fragmentRefs'?: { 'ProviderEndpointsFragmentFragment': ProviderEndpointsFragmentFragment } }
  ) | null };

export type DeleteSavedSearchMutationVariables = Exact<{
  input: DeleteByIdInput;
}>;


export type DeleteSavedSearchMutation = { __typename?: 'Mutation', deleteSavedSearch: { __typename?: 'DeleteByIdPayload', success: boolean, deletedId?: string | null } };

export type UpdateSavedSearchMutationVariables = Exact<{
  input: UpdateSavedSearchInput;
}>;


export type UpdateSavedSearchMutation = { __typename?: 'Mutation', updateSavedSearch: { __typename?: 'UpdateSavedSearchPayload', success: boolean, savedSearch?: { __typename?: 'SavedSearchType', id: string, name?: string | null, description?: string | null, query?: string | null, entityTypes?: Array<string> | null, tags?: Array<string> | null } | null } };

export type SavedSearchGridItemFragmentFragment = { __typename?: 'SavedSearchType', id: string, name?: string | null, description?: string | null, query?: string | null, entityTypes?: Array<string> | null, tags?: Array<string> | null } & { ' $fragmentName'?: 'SavedSearchGridItemFragmentFragment' };

export type GetSavedSearchesQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetSavedSearchesQuery = { __typename?: 'Query', savedSearches: { __typename?: 'SavedSearchConnection', edges: Array<{ __typename?: 'SavedSearchEdge', node: (
        { __typename?: 'SavedSearchType', id: string }
        & { ' $fragmentRefs'?: { 'SavedSearchGridItemFragmentFragment': SavedSearchGridItemFragmentFragment } }
      ) }> } };

export type GetProvidersQueryVariables = Exact<{ [key: string]: never; }>;


export type GetProvidersQuery = { __typename?: 'Query', providers: { __typename?: 'ProviderConnection', edges: Array<{ __typename?: 'ProviderEdge', cursor: string, node: { __typename?: 'ProviderType', id: string, name?: string | null, description?: string | null, logoUrl?: string | null, providerKeys?: { __typename?: 'ProviderKeyType', id: string, clientId: string, clientSecret: string } | null } }> } };

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

export type GetSummaryQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetSummaryQuery = { __typename?: 'Query', summary?: { __typename?: 'SummaryType', id: string, title?: string | null, periodType: string, periodStart: any, periodEnd: any, summaryText: string, keyInsights: Array<string>, notableEvents: Array<string>, anomalies: Array<string>, tags: Array<string>, dailyRhythm?: Array<string> | null, productivityPatterns?: Array<string> | null, socialInteractions?: Array<string> | null, keyAccomplishments?: Array<string> | null, moodIndicators?: Array<string> | null, confidenceScore?: number | null, createdAt: any, updatedAt: any, activityCounts: { __typename?: 'ActivityCountsType', total: number, browserActivity?: number | null, communications?: number | null, files?: number | null, events?: number | null, messages?: number | null, screenCaptures?: number | null, apiLogs?: number | null, positions?: number | null, activities?: number | null, measurements?: number | null } } | null };

export type GetTagQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetTagQuery = { __typename?: 'Query', tag?: { __typename?: 'TagType', id: string, label: string, description?: string | null, entities: { __typename?: 'TaggableEntityConnection', edges: Array<{ __typename?: 'TaggableEntityEdge', node:
          | (
            { __typename: 'ActionType', id: string }
            & { ' $fragmentRefs'?: { 'ActionGridItemDataFragment': ActionGridItemDataFragment } }
          )
          | (
            { __typename: 'BrowserActivityType', id: string }
            & { ' $fragmentRefs'?: { 'BrowserActivityGridItemDataFragment': BrowserActivityGridItemDataFragment } }
          )
          | (
            { __typename: 'CommunicationType', id: string }
            & { ' $fragmentRefs'?: { 'CommunicationGridItemDataFragment': CommunicationGridItemDataFragment } }
          )
          | (
            { __typename: 'ConceptType', id: string }
            & { ' $fragmentRefs'?: { 'ConceptGridItemDataFragment': ConceptGridItemDataFragment } }
          )
          | (
            { __typename: 'ContentType', id: string }
            & { ' $fragmentRefs'?: { 'ContentGridItemDataFragment': ContentGridItemDataFragment } }
          )
          | (
            { __typename: 'EventType', id: string }
            & { ' $fragmentRefs'?: { 'EventGridItemDataFragment': EventGridItemDataFragment } }
          )
          | (
            { __typename: 'FileType', id: string }
            & { ' $fragmentRefs'?: { 'FileGridItemDataFragment': FileGridItemDataFragment } }
          )
          | (
            { __typename: 'ItemType', id: string }
            & { ' $fragmentRefs'?: { 'ItemGridItemDataFragment': ItemGridItemDataFragment } }
          )
          | (
            { __typename: 'NoteType', id: string }
            & { ' $fragmentRefs'?: { 'NoteGridItemDataFragment': NoteGridItemDataFragment } }
          )
          | (
            { __typename: 'PersonType', id: string }
            & { ' $fragmentRefs'?: { 'PersonGridItemDataFragment': PersonGridItemDataFragment } }
          )
          | (
            { __typename: 'PlaceType', id: string }
            & { ' $fragmentRefs'?: { 'PlaceGridItemDataFragment': PlaceGridItemDataFragment } }
          )
          | (
            { __typename: 'ThreadType', id: string }
            & { ' $fragmentRefs'?: { 'ThreadGridItemDataFragment': ThreadGridItemDataFragment } }
          )
         }> } } | null };

export type GetTagsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetTagsQuery = { __typename?: 'Query', tags: { __typename?: 'TagConnection', edges: Array<{ __typename?: 'TagEdge', node: { __typename?: 'TagType', id: string, label: string, description?: string | null } }> } };

export const ActionGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ActionGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ActionType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","alias":{"kind":"Name","value":"actionTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"actionText"},"name":{"kind":"Name","value":"text"}}]}}]} as unknown as DocumentNode<ActionGridItemDataFragment, unknown>;
export const AnswerGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"AnswerGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<AnswerGridItemDataFragment, unknown>;
export const BrowserActivityGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"BrowserActivityGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]} as unknown as DocumentNode<BrowserActivityGridItemDataFragment, unknown>;
export const CommunicationGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"CommunicationGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}}]} as unknown as DocumentNode<CommunicationGridItemDataFragment, unknown>;
export const ConceptGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ConceptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<ConceptGridItemDataFragment, unknown>;
export const ContentGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]} as unknown as DocumentNode<ContentGridItemDataFragment, unknown>;
export const EventGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<EventGridItemDataFragment, unknown>;
export const FileGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}}]}}]} as unknown as DocumentNode<FileGridItemDataFragment, unknown>;
export const ItemGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ItemGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}}]} as unknown as DocumentNode<ItemGridItemDataFragment, unknown>;
export const NoteGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<NoteGridItemDataFragment, unknown>;
export const PersonGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<PersonGridItemDataFragment, unknown>;
export const PlaceGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PlaceGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<PlaceGridItemDataFragment, unknown>;
export const ThreadGridItemDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ThreadGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<ThreadGridItemDataFragment, unknown>;
export const NewItemFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NewItem"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}}]}}]} as unknown as DocumentNode<NewItemFragment, unknown>;
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
export const InsightCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"InsightCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"InsightItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyActions"}},{"kind":"Field","name":{"kind":"Name","value":"relevanceScore"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"relatedEntityIds"}}]}}]} as unknown as DocumentNode<InsightCardDataFragment, unknown>;
export const SummaryCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SummaryCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SummaryType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"periodType"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyInsights"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"activityCounts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"total"}}]}}]}}]} as unknown as DocumentNode<SummaryCardDataFragment, unknown>;
export const FileGridItemFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}}]}}]} as unknown as DocumentNode<FileGridItemFragmentFragment, unknown>;
export const TimelineBrowserActivityCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineBrowserActivityCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"actionType"}},{"kind":"Field","name":{"kind":"Name","value":"duration"}},{"kind":"Field","name":{"kind":"Name","value":"time"}}]}}]} as unknown as DocumentNode<TimelineBrowserActivityCardDataFragment, unknown>;
export const TimelineCommunicationCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineCommunicationCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","alias":{"kind":"Name","value":"communicationContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"to"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}}]}}]} as unknown as DocumentNode<TimelineCommunicationCardDataFragment, unknown>;
export const TimelineEventCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineEventCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"location"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}}]}}]} as unknown as DocumentNode<TimelineEventCardDataFragment, unknown>;
export const TableAnswerRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableAnswerRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<TableAnswerRowDataFragment, unknown>;
export const TableBrowserActivityRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableBrowserActivityRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]} as unknown as DocumentNode<TableBrowserActivityRowDataFragment, unknown>;
export const TableCommunicationRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableCommunicationRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}}]} as unknown as DocumentNode<TableCommunicationRowDataFragment, unknown>;
export const TableConceptRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableConceptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TableConceptRowDataFragment, unknown>;
export const TableContentRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableContentRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]} as unknown as DocumentNode<TableContentRowDataFragment, unknown>;
export const TableEventRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableEventRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TableEventRowDataFragment, unknown>;
export const TableFileRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}}]}}]} as unknown as DocumentNode<TableFileRowDataFragment, unknown>;
export const TableItemRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableItemRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}}]} as unknown as DocumentNode<TableItemRowDataFragment, unknown>;
export const TableNoteRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableNoteRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<TableNoteRowDataFragment, unknown>;
export const TablePersonRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePersonRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TablePersonRowDataFragment, unknown>;
export const TablePlaceRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePlaceRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TablePlaceRowDataFragment, unknown>;
export const TableThreadRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableThreadRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TableThreadRowDataFragment, unknown>;
export const NewNoteFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NewNote"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]} as unknown as DocumentNode<NewNoteFragment, unknown>;
export const NoteGridItemFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<NoteGridItemFragmentFragment, unknown>;
export const ProviderEndpointsFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProviderEndpointsFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProviderType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<ProviderEndpointsFragmentFragment, unknown>;
export const SavedSearchGridItemFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SavedSearchGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SavedSearchType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}}]}}]} as unknown as DocumentNode<SavedSearchGridItemFragmentFragment, unknown>;
export const GetFeedActionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetFeedActions"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"feedActions"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"imageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"context"}},{"kind":"Field","name":{"kind":"Name","value":"relatedPerson"}}]}},{"kind":"Field","name":{"kind":"Name","value":"thread"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]}}]} as unknown as DocumentNode<GetFeedActionsQuery, GetFeedActionsQueryVariables>;
export const MarkActionAsSeenDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkActionAsSeen"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markActionAsSeen"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}}]}}]}}]} as unknown as DocumentNode<MarkActionAsSeenMutation, MarkActionAsSeenMutationVariables>;
export const MarkActionAsDismissedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkActionAsDismissed"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markActionAsDismissed"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}}]}}]} as unknown as DocumentNode<MarkActionAsDismissedMutation, MarkActionAsDismissedMutationVariables>;
export const TagEntitiesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"TagEntities"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TagEntitiesInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tagEntities"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Taggable"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]} as unknown as DocumentNode<TagEntitiesMutation, TagEntitiesMutationVariables>;
export const UntagEntitiesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UntagEntities"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TagEntitiesInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"untagEntities"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Taggable"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]} as unknown as DocumentNode<UntagEntitiesMutation, UntagEntitiesMutationVariables>;
export const GetNodeTagsForRelationshipCardDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetNodeTagsForRelationshipCard"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Taggable"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetNodeTagsForRelationshipCardQuery, GetNodeTagsForRelationshipCardQueryVariables>;
export const CreateConceptDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateConcept"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateConceptInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createConcept"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"concept"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]} as unknown as DocumentNode<CreateConceptMutation, CreateConceptMutationVariables>;
export const CreatePersonDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreatePerson"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreatePersonInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createPerson"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"person"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]} as unknown as DocumentNode<CreatePersonMutation, CreatePersonMutationVariables>;
export const CreateRelationshipDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateRelationship"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateRelationshipInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createRelationship"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"relationship"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"fromNodeId"}},{"kind":"Field","name":{"kind":"Name","value":"fromNodeType"}},{"kind":"Field","name":{"kind":"Name","value":"toNodeId"}},{"kind":"Field","name":{"kind":"Name","value":"toNodeType"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}},{"kind":"Field","name":{"kind":"Name","value":"isBidirectional"}},{"kind":"Field","name":{"kind":"Name","value":"startDate"}},{"kind":"Field","name":{"kind":"Name","value":"endDate"}}]}}]}}]}}]} as unknown as DocumentNode<CreateRelationshipMutation, CreateRelationshipMutationVariables>;
export const GetFilePreviewDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetFilePreview"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"file"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]} as unknown as DocumentNode<GetFilePreviewQuery, GetFilePreviewQueryVariables>;
export const CreateItemDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateItem"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateItemInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createItem"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"success"}}]}}]}}]} as unknown as DocumentNode<CreateItemMutation, CreateItemMutationVariables>;
export const UpdateItemDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateItem"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateItemInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateItem"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"success"}}]}}]}}]} as unknown as DocumentNode<UpdateItemMutation, UpdateItemMutationVariables>;
export const SearchBoxQueryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"SearchBoxQuery"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"search"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"includeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"excludeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}}}]}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultCommunicationData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultConceptData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultContentData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultEventData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultFileData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultNoteData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultPersonData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultPlaceData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SearchResultThreadData"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultCommunicationData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","name":{"kind":"Name","value":"time"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultConceptData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultContentData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultEventData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultFileData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultNoteData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultPersonData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultPlaceData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SearchResultThreadData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<SearchBoxQueryQuery, SearchBoxQueryQueryVariables>;
export const GetUserDataDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetUserData"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"me"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"onboarded"}},{"kind":"Field","name":{"kind":"Name","value":"entity"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]}}]} as unknown as DocumentNode<GetUserDataQuery, GetUserDataQueryVariables>;
export const GetFeedBadgeCountDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetFeedBadgeCount"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"actionLimit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"summaryFirst"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"feedActions"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"actionLimit"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}},{"kind":"Field","name":{"kind":"Name","value":"summaries"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"summaryFirst"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetFeedBadgeCountQuery, GetFeedBadgeCountQueryVariables>;
export const GetCommunicationDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetCommunication"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"communication"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"to"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]} as unknown as DocumentNode<GetCommunicationQuery, GetCommunicationQueryVariables>;
export const GetConceptDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConcept"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"concept"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]} as unknown as DocumentNode<GetConceptQuery, GetConceptQueryVariables>;
export const GetConnectionsLightDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConnectionsLight"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"hasPreviousPage"}},{"kind":"Field","name":{"kind":"Name","value":"startCursor"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"totalCount"}}]}}]}}]} as unknown as DocumentNode<GetConnectionsLightQuery, GetConnectionsLightQueryVariables>;
export const GetConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"schedule"}},{"kind":"Field","name":{"kind":"Name","value":"tokenExpiry"}},{"kind":"Field","name":{"kind":"Name","value":"syncState"}},{"kind":"Field","name":{"kind":"Name","value":"activeEndpoints"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}},{"kind":"Field","name":{"kind":"Name","value":"needsReauth"}},{"kind":"Field","name":{"kind":"Name","value":"externalId"}},{"kind":"Field","name":{"kind":"Name","value":"provider"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetConnectionQuery, GetConnectionQueryVariables>;
export const UpdateConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateConnectionInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"connection"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"schedule"}},{"kind":"Field","name":{"kind":"Name","value":"tokenExpiry"}},{"kind":"Field","name":{"kind":"Name","value":"syncState"}},{"kind":"Field","name":{"kind":"Name","value":"activeEndpoints"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}},{"kind":"Field","name":{"kind":"Name","value":"needsReauth"}},{"kind":"Field","name":{"kind":"Name","value":"externalId"}},{"kind":"Field","name":{"kind":"Name","value":"provider"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<UpdateConnectionMutation, UpdateConnectionMutationVariables>;
export const DeleteConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteConnectionMutation, DeleteConnectionMutationVariables>;
export const GetConnectionSyncJobsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConnectionSyncJobs"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionSyncJobs"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"connectionId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"endpointName"}},{"kind":"Field","name":{"kind":"Name","value":"nextCursor"}},{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}},{"kind":"Field","name":{"kind":"Name","value":"error"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"hasPreviousPage"}},{"kind":"Field","name":{"kind":"Name","value":"startCursor"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"totalCount"}}]}}]}}]} as unknown as DocumentNode<GetConnectionSyncJobsQuery, GetConnectionSyncJobsQueryVariables>;
export const GetConnectionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"active"}},{"kind":"Field","name":{"kind":"Name","value":"schedule"}},{"kind":"Field","name":{"kind":"Name","value":"tokenExpiry"}},{"kind":"Field","name":{"kind":"Name","value":"syncState"}},{"kind":"Field","name":{"kind":"Name","value":"activeEndpoints"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}},{"kind":"Field","name":{"kind":"Name","value":"needsReauth"}},{"kind":"Field","name":{"kind":"Name","value":"externalId"}},{"kind":"Field","name":{"kind":"Name","value":"provider"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"hasPreviousPage"}},{"kind":"Field","name":{"kind":"Name","value":"startCursor"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"totalCount"}}]}}]}}]} as unknown as DocumentNode<GetConnectionsQuery, GetConnectionsQueryVariables>;
export const GetContentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetContent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"content"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]} as unknown as DocumentNode<GetContentQuery, GetContentQueryVariables>;
export const GetEventDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetEvent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}},{"kind":"Field","name":{"kind":"Name","value":"location"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}},{"kind":"Field","name":{"kind":"Name","value":"organizer"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"participants"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetEventQuery, GetEventQueryVariables>;
export const GetSummariesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSummaries"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"summaries"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"periodType"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyInsights"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"activityCounts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"total"}}]}},{"kind":"Field","name":{"kind":"Name","value":"insights"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyActions"}},{"kind":"Field","name":{"kind":"Name","value":"relevanceScore"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"relatedEntityIds"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}}]}},{"kind":"Field","name":{"kind":"Name","value":"totalCount"}}]}}]}}]} as unknown as DocumentNode<GetSummariesQuery, GetSummariesQueryVariables>;
export const MarkSummaryAsSeenDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkSummaryAsSeen"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markSummaryAsSeen"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"seen"}}]}}]}}]} as unknown as DocumentNode<MarkSummaryAsSeenMutation, MarkSummaryAsSeenMutationVariables>;
export const MarkSummaryAsDismissedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkSummaryAsDismissed"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markSummaryAsDismissed"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"dismissed"}}]}}]}}]} as unknown as DocumentNode<MarkSummaryAsDismissedMutation, MarkSummaryAsDismissedMutationVariables>;
export const GetFilesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetFiles"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"files"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"FileGridItemFragment"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}}]}}]} as unknown as DocumentNode<GetFilesQuery, GetFilesQueryVariables>;
export const GetInventoryItemsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetInventoryItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetInventoryItemsQuery, GetInventoryItemsQueryVariables>;
export const GetItemDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetItem"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"item"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]} as unknown as DocumentNode<GetItemQuery, GetItemQueryVariables>;
export const CreateSavedSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateSavedSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateSavedSearchInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createSavedSearch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"savedSearch"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}}]}}]}}]}}]} as unknown as DocumentNode<CreateSavedSearchMutation, CreateSavedSearchMutationVariables>;
export const GetSavedSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSavedSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"savedSearch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}}]}}]}}]} as unknown as DocumentNode<GetSavedSearchQuery, GetSavedSearchQueryVariables>;
export const SearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Search"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"search"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"includeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"excludeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}}}]}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"AnswerGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"BrowserActivityGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"CommunicationGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ConceptGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ContentGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"FileGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"NoteGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ItemGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PlaceGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ThreadGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableAnswerRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableCommunicationRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableConceptRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableContentRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableEventRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableFileRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableItemRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableNoteRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePersonRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePlaceRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableThreadRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableBrowserActivityRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineBrowserActivityCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineCommunicationCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TimelineEventCardData"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"AnswerGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"BrowserActivityGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"CommunicationGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ConceptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ItemGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PlaceGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ThreadGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableAnswerRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableCommunicationRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableConceptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableContentRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableEventRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableItemRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableNoteRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePersonRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePlaceRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableThreadRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableBrowserActivityRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineBrowserActivityCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"actionType"}},{"kind":"Field","name":{"kind":"Name","value":"duration"}},{"kind":"Field","name":{"kind":"Name","value":"time"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineCommunicationCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}},{"kind":"Field","alias":{"kind":"Name","value":"communicationContent"},"name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"time"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"direction"}},{"kind":"Field","name":{"kind":"Name","value":"from"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"to"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TimelineEventCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"location"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}}]}}]}}]}}]} as unknown as DocumentNode<SearchQuery, SearchQueryVariables>;
export const GetNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"note"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]} as unknown as DocumentNode<GetNoteQuery, GetNoteQueryVariables>;
export const UpdateNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateNoteInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"note"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateNoteMutation, UpdateNoteMutationVariables>;
export const CreateNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateNoteInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"note"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]}}]} as unknown as DocumentNode<CreateNoteMutation, CreateNoteMutationVariables>;
export const DeleteNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteNoteMutation, DeleteNoteMutationVariables>;
export const GetNotesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetNotes"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"notes"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"NoteGridItemFragment"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<GetNotesQuery, GetNotesQueryVariables>;
export const GetPersonDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPerson"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"person"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]} as unknown as DocumentNode<GetPersonQuery, GetPersonQueryVariables>;
export const GetPlaceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPlace"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"place"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"properties"}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]} as unknown as DocumentNode<GetPlaceQuery, GetPlaceQueryVariables>;
export const GetProviderDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetProvider"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"logoUrl"}},{"kind":"Field","name":{"kind":"Name","value":"theme"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"backgroundColor"}},{"kind":"Field","name":{"kind":"Name","value":"borderColor"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ProviderEndpointsFragment"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProviderEndpointsFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProviderType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<GetProviderQuery, GetProviderQueryVariables>;
export const DeleteSavedSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteSavedSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteSavedSearch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteSavedSearchMutation, DeleteSavedSearchMutationVariables>;
export const UpdateSavedSearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateSavedSearch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateSavedSearchInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateSavedSearch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"savedSearch"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateSavedSearchMutation, UpdateSavedSearchMutationVariables>;
export const GetSavedSearchesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSavedSearches"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"savedSearches"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"SavedSearchGridItemFragment"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SavedSearchGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"SavedSearchType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"query"}},{"kind":"Field","name":{"kind":"Name","value":"entityTypes"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}}]}}]} as unknown as DocumentNode<GetSavedSearchesQuery, GetSavedSearchesQueryVariables>;
export const GetProvidersDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetProviders"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"providers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"logoUrl"}},{"kind":"Field","name":{"kind":"Name","value":"providerKeys"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"clientId"}},{"kind":"Field","name":{"kind":"Name","value":"clientSecret"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetProvidersQuery, GetProvidersQueryVariables>;
export const CreateProviderKeyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateProviderKey"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateProviderKeyInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createProviderKey"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"providerId"}},{"kind":"Field","name":{"kind":"Name","value":"clientId"}},{"kind":"Field","name":{"kind":"Name","value":"clientSecret"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}}]}}]}}]} as unknown as DocumentNode<CreateProviderKeyMutation, CreateProviderKeyMutationVariables>;
export const UpdateProviderKeyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateProviderKey"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateProviderKeyInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateProviderKey"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"clientId"}},{"kind":"Field","name":{"kind":"Name","value":"clientSecret"}}]}}]}}]} as unknown as DocumentNode<UpdateProviderKeyMutation, UpdateProviderKeyMutationVariables>;
export const DeleteProviderKeyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteProviderKey"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteProviderKey"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}]}]}}]} as unknown as DocumentNode<DeleteProviderKeyMutation, DeleteProviderKeyMutationVariables>;
export const GetSummaryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetSummary"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"summary"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"periodType"}},{"kind":"Field","name":{"kind":"Name","value":"periodStart"}},{"kind":"Field","name":{"kind":"Name","value":"periodEnd"}},{"kind":"Field","name":{"kind":"Name","value":"summaryText"}},{"kind":"Field","name":{"kind":"Name","value":"keyInsights"}},{"kind":"Field","name":{"kind":"Name","value":"notableEvents"}},{"kind":"Field","name":{"kind":"Name","value":"anomalies"}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"activityCounts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"total"}},{"kind":"Field","name":{"kind":"Name","value":"browserActivity"}},{"kind":"Field","name":{"kind":"Name","value":"communications"}},{"kind":"Field","name":{"kind":"Name","value":"files"}},{"kind":"Field","name":{"kind":"Name","value":"events"}},{"kind":"Field","name":{"kind":"Name","value":"messages"}},{"kind":"Field","name":{"kind":"Name","value":"screenCaptures"}},{"kind":"Field","name":{"kind":"Name","value":"apiLogs"}},{"kind":"Field","name":{"kind":"Name","value":"positions"}},{"kind":"Field","name":{"kind":"Name","value":"activities"}},{"kind":"Field","name":{"kind":"Name","value":"measurements"}}]}},{"kind":"Field","name":{"kind":"Name","value":"dailyRhythm"}},{"kind":"Field","name":{"kind":"Name","value":"productivityPatterns"}},{"kind":"Field","name":{"kind":"Name","value":"socialInteractions"}},{"kind":"Field","name":{"kind":"Name","value":"keyAccomplishments"}},{"kind":"Field","name":{"kind":"Name","value":"moodIndicators"}},{"kind":"Field","name":{"kind":"Name","value":"confidenceScore"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]} as unknown as DocumentNode<GetSummaryQuery, GetSummaryQueryVariables>;
export const GetTagDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetTag"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tag"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"entities"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ActionGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"BrowserActivityGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"CommunicationGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ConceptGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ContentGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"FileGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"NoteGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ItemGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PersonGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"PlaceGridItemData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ThreadGridItemData"}}]}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ActionGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ActionType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","alias":{"kind":"Name","value":"actionTitle"},"name":{"kind":"Name","value":"title"}},{"kind":"Field","alias":{"kind":"Name","value":"actionText"},"name":{"kind":"Name","value":"text"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"BrowserActivityGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"CommunicationGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ConceptGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ContentGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"previewUrl"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ItemGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sourceUrl"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PersonGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PlaceGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ThreadGridItemData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<GetTagQuery, GetTagQueryVariables>;
export const GetTagsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetTags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetTagsQuery, GetTagsQueryVariables>;