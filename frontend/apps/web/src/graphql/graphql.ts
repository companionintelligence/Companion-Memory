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

export type ActionType = Node & Taggable & {
  __typename?: 'ActionType';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  imageUrl: Scalars['String']['output'];
  tags: Array<EntityTagType>;
  text: Scalars['String']['output'];
  thread?: Maybe<ThreadType>;
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
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

export type BrowserActivityType = Node & {
  __typename?: 'BrowserActivityType';
  actionType?: Maybe<Scalars['String']['output']>;
  duration?: Maybe<Scalars['Float']['output']>;
  id: Scalars['ID']['output'];
  scrollDepth?: Maybe<Scalars['Float']['output']>;
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

export type CommunicationType = Node & {
  __typename?: 'CommunicationType';
  content: Scalars['String']['output'];
  direction: Scalars['String']['output'];
  from?: Maybe<PersonType>;
  id: Scalars['ID']['output'];
  preview?: Maybe<Scalars['String']['output']>;
  subject?: Maybe<Scalars['String']['output']>;
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

export type ConceptType = Node & {
  __typename?: 'ConceptType';
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name?: Maybe<Scalars['String']['output']>;
};

export type Connection = {
  edges: Array<Edge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
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

export type ContentType = Node & {
  __typename?: 'ContentType';
  event?: Maybe<EventType>;
  externalId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  mimetype?: Maybe<Scalars['String']['output']>;
  sourceData?: Maybe<Scalars['JSON']['output']>;
  sourceUrl?: Maybe<Scalars['String']['output']>;
  text?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  type?: Maybe<Scalars['String']['output']>;
  url?: Maybe<Scalars['String']['output']>;
};

export type CreateAnswerInput = {
  answer: Scalars['String']['input'];
  questionId: Scalars['String']['input'];
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

export type CreateQuestionInput = {
  category: Scalars['String']['input'];
  text: Scalars['String']['input'];
};

export type CreateSavedSearchInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  entityTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  name?: InputMaybe<Scalars['String']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['ID']['input']>>;
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

export type EntityTagType = {
  __typename?: 'EntityTagType';
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

export type EventType = Node & {
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
  locationCoordinates?: Maybe<Scalars['JSON']['output']>;
  locationEntityId?: Maybe<Scalars['ID']['output']>;
  locationName?: Maybe<Scalars['String']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  organizerEntityId?: Maybe<Scalars['ID']['output']>;
  participantEntityIds?: Maybe<Array<Scalars['ID']['output']>>;
  sourceId?: Maybe<Scalars['ID']['output']>;
  sourceSystem?: Maybe<Scalars['String']['output']>;
  sourceType?: Maybe<Scalars['String']['output']>;
  startTime: Scalars['DateTime']['output'];
  status?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export type FactConnection = Connection & {
  __typename?: 'FactConnection';
  edges: Array<FactEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type FactEdge = Edge & {
  __typename?: 'FactEdge';
  cursor: Scalars['String']['output'];
  node: FactType;
};

export type FactType = Node & {
  __typename?: 'FactType';
  id: Scalars['ID']['output'];
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

export type FileType = Node & {
  __typename?: 'FileType';
  analysisCompleted: Scalars['Boolean']['output'];
  contentType: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  filename: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  items?: Maybe<ItemConnection>;
  originalName: Scalars['String']['output'];
  size: Scalars['Float']['output'];
  updatedAt: Scalars['DateTime']['output'];
  url: Scalars['String']['output'];
};


export type FileTypeItemsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
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

export type ItemType = Node & {
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
  createContent: ContentType;
  createEvent: EventType;
  createNote: CreateNotePayload;
  createPerson: PersonType;
  createPlace: PlaceType;
  createQuestion: QuestionType;
  createSavedSearch: CreateSavedSearchPayload;
  deleteNote: DeleteByIdPayload;
  deleteSavedSearch: DeleteByIdPayload;
  removeAnswer: Scalars['Boolean']['output'];
  removeContent: Scalars['Boolean']['output'];
  removeEvent: Scalars['Boolean']['output'];
  removePerson: Scalars['Boolean']['output'];
  removePlace: Scalars['Boolean']['output'];
  removeQuestion: Scalars['Boolean']['output'];
  tagEntities: Scalars['Boolean']['output'];
  untagEntities: Scalars['Boolean']['output'];
  updateAnswer?: Maybe<AnswerType>;
  updateContent?: Maybe<ContentType>;
  updateEvent?: Maybe<EventType>;
  updateNote: UpdateNotePayload;
  updatePerson?: Maybe<PersonType>;
  updatePlace?: Maybe<PlaceType>;
  updateQuestion?: Maybe<QuestionType>;
  updateSavedSearch: UpdateSavedSearchPayload;
};


export type MutationCreateAnswerArgs = {
  input: CreateAnswerInput;
};


export type MutationCreateContentArgs = {
  input: CreateContentInput;
};


export type MutationCreateEventArgs = {
  input: CreateEventInput;
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


export type MutationCreateQuestionArgs = {
  input: CreateQuestionInput;
};


export type MutationCreateSavedSearchArgs = {
  input: CreateSavedSearchInput;
};


export type MutationDeleteNoteArgs = {
  input: DeleteByIdInput;
};


export type MutationDeleteSavedSearchArgs = {
  input: DeleteByIdInput;
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


export type MutationRemovePersonArgs = {
  input: RemovePersonInput;
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


export type MutationUpdateContentArgs = {
  input: UpdateContentInput;
};


export type MutationUpdateEventArgs = {
  input: UpdateEventInput;
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


export type MutationUpdateQuestionArgs = {
  input: UpdateQuestionInput;
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

export type NoteType = Node & {
  __typename?: 'NoteType';
  content?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
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

export type PlaceType = Node & {
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
  description: Scalars['String']['output'];
  name: Scalars['String']['output'];
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
  content?: Maybe<ContentType>;
  contents: ContentConnection;
  event?: Maybe<EventType>;
  events: EventConnection;
  fact?: Maybe<FactType>;
  facts: FactConnection;
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
  savedSearch?: Maybe<SavedSearchType>;
  savedSearches: SavedSearchConnection;
  search: SearchConnection;
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


export type QueryFactArgs = {
  id: Scalars['ID']['input'];
};


export type QueryFactsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  before?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  last?: InputMaybe<Scalars['Int']['input']>;
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

export type RemovePersonInput = {
  id: Scalars['String']['input'];
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
  tags?: Maybe<Array<Scalars['ID']['output']>>;
  updatedAt: Scalars['DateTime']['output'];
};

export type SearchConnection = {
  __typename?: 'SearchConnection';
  edges: Array<SearchResultEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type SearchInput = {
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  includeTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  query?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type SearchResultEdge = {
  __typename?: 'SearchResultEdge';
  cursor: Scalars['String']['output'];
  node: SearchResultType;
};

export type SearchResultType = AnswerType | BrowserActivityType | CommunicationType | ConceptType | ContentType | EventType | FileType | ItemType | NoteType | PersonType | PlaceType | ThreadType;

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
  id: Scalars['ID']['output'];
  label: Scalars['String']['output'];
};

export type Taggable = {
  tags: Array<EntityTagType>;
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

export type UpdateQuestionInput = {
  category: Scalars['String']['input'];
  id: Scalars['String']['input'];
  text: Scalars['String']['input'];
};

export type UpdateSavedSearchInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  entityTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  id: Scalars['ID']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['ID']['input']>>;
};

export type UpdateSavedSearchPayload = {
  __typename?: 'UpdateSavedSearchPayload';
  savedSearch?: Maybe<SavedSearchType>;
  success: Scalars['Boolean']['output'];
};

export type UserType = Node & {
  __typename?: 'UserType';
  email: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  onboarded: Scalars['Boolean']['output'];
};

export type GetActionsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetActionsQuery = { __typename?: 'Query', actions: { __typename?: 'ActionConnection', edges: Array<{ __typename?: 'ActionEdge', node: { __typename?: 'ActionType', id: string, title: string, text: string, imageUrl: string, thread?: { __typename?: 'ThreadType', id: string } | null, tags: Array<{ __typename?: 'EntityTagType', label: string }> } }> } };

export type FileGridItemFragmentFragment = { __typename?: 'FileType', id: string, filename: string, originalName: string, contentType: string, url: string, createdAt: any } & { ' $fragmentName'?: 'FileGridItemFragmentFragment' };

export type GetFilesQueryVariables = Exact<{
  first?: InputMaybe<Scalars['Int']['input']>;
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type GetFilesQuery = { __typename?: 'Query', files: { __typename?: 'FileConnection', edges: Array<{ __typename?: 'FileEdge', node: (
        { __typename?: 'FileType', id: string }
        & { ' $fragmentRefs'?: { 'FileGridItemFragmentFragment': FileGridItemFragmentFragment } }
      ) }> } };

export type GetInventoryItemsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetInventoryItemsQuery = { __typename?: 'Query', items: { __typename?: 'ItemConnection', edges: Array<{ __typename?: 'ItemEdge', node: { __typename?: 'ItemType', id: string, name?: string | null, category?: string | null, description?: string | null, brand?: string | null, model?: string | null, currentValue?: number | null, file?: { __typename?: 'FileType', url: string } | null } }> } };

export type GalleryAnswerCardDataFragment = { __typename?: 'AnswerType', id: string, answer: string, question: { __typename?: 'QuestionType', id: string, text: string } } & { ' $fragmentName'?: 'GalleryAnswerCardDataFragment' };

export type GalleryBrowserActivityCardDataFragment = { __typename?: 'BrowserActivityType', id: string, title?: string | null, url: string } & { ' $fragmentName'?: 'GalleryBrowserActivityCardDataFragment' };

export type GalleryCommunicationCardDataFragment = { __typename?: 'CommunicationType', id: string, subject?: string | null, preview?: string | null } & { ' $fragmentName'?: 'GalleryCommunicationCardDataFragment' };

export type GalleryConceptCardDataFragment = { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'GalleryConceptCardDataFragment' };

export type GalleryContentCardDataFragment = { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null } & { ' $fragmentName'?: 'GalleryContentCardDataFragment' };

export type GalleryEventCardDataFragment = { __typename?: 'EventType', id: string, title?: string | null, description?: string | null } & { ' $fragmentName'?: 'GalleryEventCardDataFragment' };

export type GalleryFileCardDataFragment = { __typename?: 'FileType', id: string, url: string } & { ' $fragmentName'?: 'GalleryFileCardDataFragment' };

export type GalleryItemCardDataFragment = { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, file?: { __typename?: 'FileType', id: string, url: string } | null } & { ' $fragmentName'?: 'GalleryItemCardDataFragment' };

export type GalleryNoteCardDataFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null } & { ' $fragmentName'?: 'GalleryNoteCardDataFragment' };

export type GalleryPersonCardDataFragment = { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'GalleryPersonCardDataFragment' };

export type GalleryPlaceCardDataFragment = { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'GalleryPlaceCardDataFragment' };

export type GalleryThreadCardDataFragment = { __typename?: 'ThreadType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'GalleryThreadCardDataFragment' };

export type TableAnswerRowDataFragment = { __typename?: 'AnswerType', id: string, answer: string, question: { __typename?: 'QuestionType', id: string, text: string } } & { ' $fragmentName'?: 'TableAnswerRowDataFragment' };

export type TableBrowserActivityRowDataFragment = { __typename?: 'BrowserActivityType', id: string, title?: string | null, url: string } & { ' $fragmentName'?: 'TableBrowserActivityRowDataFragment' };

export type TableCommunicationRowDataFragment = { __typename?: 'CommunicationType', id: string, subject?: string | null, preview?: string | null } & { ' $fragmentName'?: 'TableCommunicationRowDataFragment' };

export type TableConceptRowDataFragment = { __typename?: 'ConceptType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TableConceptRowDataFragment' };

export type TableContentRowDataFragment = { __typename?: 'ContentType', id: string, title?: string | null, text?: string | null } & { ' $fragmentName'?: 'TableContentRowDataFragment' };

export type TableEventRowDataFragment = { __typename?: 'EventType', id: string, title?: string | null, description?: string | null } & { ' $fragmentName'?: 'TableEventRowDataFragment' };

export type TableFileRowDataFragment = { __typename?: 'FileType', id: string, url: string } & { ' $fragmentName'?: 'TableFileRowDataFragment' };

export type TableItemRowDataFragment = { __typename?: 'ItemType', id: string, name?: string | null, description?: string | null, file?: { __typename?: 'FileType', id: string, url: string } | null } & { ' $fragmentName'?: 'TableItemRowDataFragment' };

export type TableNoteRowDataFragment = { __typename?: 'NoteType', id: string, title?: string | null, content?: string | null } & { ' $fragmentName'?: 'TableNoteRowDataFragment' };

export type TablePersonRowDataFragment = { __typename?: 'PersonType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TablePersonRowDataFragment' };

export type TablePlaceRowDataFragment = { __typename?: 'PlaceType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TablePlaceRowDataFragment' };

export type TableThreadRowDataFragment = { __typename?: 'ThreadType', id: string, name?: string | null, description?: string | null } & { ' $fragmentName'?: 'TableThreadRowDataFragment' };

export type SearchQueryVariables = Exact<{
  query: Scalars['String']['input'];
  includeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
  excludeTypes?: InputMaybe<Array<Scalars['String']['input']> | Scalars['String']['input']>;
}>;


export type SearchQuery = { __typename?: 'Query', search: { __typename?: 'SearchConnection', edges: Array<{ __typename?: 'SearchResultEdge', node:
        | (
          { __typename: 'AnswerType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryAnswerCardDataFragment': GalleryAnswerCardDataFragment;'TableAnswerRowDataFragment': TableAnswerRowDataFragment } }
        )
        | (
          { __typename: 'BrowserActivityType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryBrowserActivityCardDataFragment': GalleryBrowserActivityCardDataFragment;'TableBrowserActivityRowDataFragment': TableBrowserActivityRowDataFragment } }
        )
        | (
          { __typename: 'CommunicationType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryCommunicationCardDataFragment': GalleryCommunicationCardDataFragment;'TableCommunicationRowDataFragment': TableCommunicationRowDataFragment } }
        )
        | (
          { __typename: 'ConceptType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryConceptCardDataFragment': GalleryConceptCardDataFragment;'TableConceptRowDataFragment': TableConceptRowDataFragment } }
        )
        | (
          { __typename: 'ContentType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryContentCardDataFragment': GalleryContentCardDataFragment;'TableContentRowDataFragment': TableContentRowDataFragment } }
        )
        | (
          { __typename: 'EventType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryEventCardDataFragment': GalleryEventCardDataFragment;'TableEventRowDataFragment': TableEventRowDataFragment } }
        )
        | (
          { __typename: 'FileType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryFileCardDataFragment': GalleryFileCardDataFragment;'TableFileRowDataFragment': TableFileRowDataFragment } }
        )
        | (
          { __typename: 'ItemType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryItemCardDataFragment': GalleryItemCardDataFragment;'TableItemRowDataFragment': TableItemRowDataFragment } }
        )
        | (
          { __typename: 'NoteType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryNoteCardDataFragment': GalleryNoteCardDataFragment;'TableNoteRowDataFragment': TableNoteRowDataFragment } }
        )
        | (
          { __typename: 'PersonType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryPersonCardDataFragment': GalleryPersonCardDataFragment;'TablePersonRowDataFragment': TablePersonRowDataFragment } }
        )
        | (
          { __typename: 'PlaceType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryPlaceCardDataFragment': GalleryPlaceCardDataFragment;'TablePlaceRowDataFragment': TablePlaceRowDataFragment } }
        )
        | (
          { __typename: 'ThreadType', id: string }
          & { ' $fragmentRefs'?: { 'GalleryThreadCardDataFragment': GalleryThreadCardDataFragment;'TableThreadRowDataFragment': TableThreadRowDataFragment } }
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

export type ProviderEndpointsFragmentFragment = { __typename?: 'ProviderType', endpoints: Array<{ __typename?: 'ProviderEndpointType', name: string, description: string }> } & { ' $fragmentName'?: 'ProviderEndpointsFragmentFragment' };

export type GetProviderQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetProviderQuery = { __typename?: 'Query', provider?: (
    { __typename?: 'ProviderType', id: string, name?: string | null, description?: string | null, logoUrl?: string | null, theme?: { __typename?: 'ProviderThemeType', backgroundColor?: string | null, borderColor?: string | null } | null }
    & { ' $fragmentRefs'?: { 'ProviderEndpointsFragmentFragment': ProviderEndpointsFragmentFragment } }
  ) | null };

export const FileGridItemFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"originalName"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]} as unknown as DocumentNode<FileGridItemFragmentFragment, unknown>;
export const GalleryAnswerCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryAnswerCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<GalleryAnswerCardDataFragment, unknown>;
export const GalleryBrowserActivityCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryBrowserActivityCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]} as unknown as DocumentNode<GalleryBrowserActivityCardDataFragment, unknown>;
export const GalleryCommunicationCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryCommunicationCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}}]} as unknown as DocumentNode<GalleryCommunicationCardDataFragment, unknown>;
export const GalleryConceptCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryConceptCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<GalleryConceptCardDataFragment, unknown>;
export const GalleryContentCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryContentCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]} as unknown as DocumentNode<GalleryContentCardDataFragment, unknown>;
export const GalleryEventCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryEventCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<GalleryEventCardDataFragment, unknown>;
export const GalleryFileCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryFileCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]} as unknown as DocumentNode<GalleryFileCardDataFragment, unknown>;
export const GalleryItemCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryItemCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}}]} as unknown as DocumentNode<GalleryItemCardDataFragment, unknown>;
export const GalleryNoteCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryNoteCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<GalleryNoteCardDataFragment, unknown>;
export const GalleryPersonCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryPersonCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<GalleryPersonCardDataFragment, unknown>;
export const GalleryPlaceCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryPlaceCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<GalleryPlaceCardDataFragment, unknown>;
export const GalleryThreadCardDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryThreadCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<GalleryThreadCardDataFragment, unknown>;
export const TableAnswerRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableAnswerRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}}]} as unknown as DocumentNode<TableAnswerRowDataFragment, unknown>;
export const TableBrowserActivityRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableBrowserActivityRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]} as unknown as DocumentNode<TableBrowserActivityRowDataFragment, unknown>;
export const TableCommunicationRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableCommunicationRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}}]} as unknown as DocumentNode<TableCommunicationRowDataFragment, unknown>;
export const TableConceptRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableConceptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TableConceptRowDataFragment, unknown>;
export const TableContentRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableContentRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]} as unknown as DocumentNode<TableContentRowDataFragment, unknown>;
export const TableEventRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableEventRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TableEventRowDataFragment, unknown>;
export const TableFileRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]} as unknown as DocumentNode<TableFileRowDataFragment, unknown>;
export const TableItemRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableItemRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}}]} as unknown as DocumentNode<TableItemRowDataFragment, unknown>;
export const TableNoteRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableNoteRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<TableNoteRowDataFragment, unknown>;
export const TablePersonRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePersonRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TablePersonRowDataFragment, unknown>;
export const TablePlaceRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePlaceRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TablePlaceRowDataFragment, unknown>;
export const TableThreadRowDataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableThreadRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]} as unknown as DocumentNode<TableThreadRowDataFragment, unknown>;
export const NewNoteFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NewNote"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]} as unknown as DocumentNode<NewNoteFragment, unknown>;
export const NoteGridItemFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<NoteGridItemFragmentFragment, unknown>;
export const ProviderEndpointsFragmentFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProviderEndpointsFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProviderType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<ProviderEndpointsFragmentFragment, unknown>;
export const GetActionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetActions"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"actions"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"imageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"thread"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"label"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetActionsQuery, GetActionsQueryVariables>;
export const GetFilesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetFiles"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"files"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"FileGridItemFragment"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FileGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"filename"}},{"kind":"Field","name":{"kind":"Name","value":"originalName"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]} as unknown as DocumentNode<GetFilesQuery, GetFilesQueryVariables>;
export const GetInventoryItemsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetInventoryItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"brand"}},{"kind":"Field","name":{"kind":"Name","value":"model"}},{"kind":"Field","name":{"kind":"Name","value":"currentValue"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}}]}}]}}]}}]} as unknown as DocumentNode<GetInventoryItemsQuery, GetInventoryItemsQueryVariables>;
export const SearchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Search"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"query"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"search"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"ObjectValue","fields":[{"kind":"ObjectField","name":{"kind":"Name","value":"query"},"value":{"kind":"Variable","name":{"kind":"Name","value":"query"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"includeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"includeTypes"}}},{"kind":"ObjectField","name":{"kind":"Name","value":"excludeTypes"},"value":{"kind":"Variable","name":{"kind":"Name","value":"excludeTypes"}}}]}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Node"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryAnswerCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryBrowserActivityCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryCommunicationCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryConceptCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryContentCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryEventCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryFileCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryNoteCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryItemCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryPersonCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryPlaceCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"GalleryThreadCardData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableAnswerRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableCommunicationRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableConceptRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableContentRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableEventRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableFileRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableItemRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableNoteRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePersonRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TablePlaceRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableThreadRowData"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"TableBrowserActivityRowData"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryAnswerCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryBrowserActivityCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryCommunicationCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryConceptCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryContentCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryEventCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryFileCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryNoteCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryItemCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryPersonCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryPlaceCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"GalleryThreadCardData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableAnswerRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AnswerType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"answer"}},{"kind":"Field","name":{"kind":"Name","value":"question"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableCommunicationRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CommunicationType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"subject"}},{"kind":"Field","name":{"kind":"Name","value":"preview"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableConceptRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ConceptType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableContentRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ContentType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"text"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableEventRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"EventType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableFileRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"FileType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableItemRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ItemType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"file"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableNoteRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePersonRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PersonType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TablePlaceRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PlaceType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableThreadRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ThreadType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TableBrowserActivityRowData"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"BrowserActivityType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]} as unknown as DocumentNode<SearchQuery, SearchQueryVariables>;
export const GetNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"note"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]} as unknown as DocumentNode<GetNoteQuery, GetNoteQueryVariables>;
export const UpdateNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateNoteInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"note"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateNoteMutation, UpdateNoteMutationVariables>;
export const CreateNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateNoteInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"note"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]}}]} as unknown as DocumentNode<CreateNoteMutation, CreateNoteMutationVariables>;
export const DeleteNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DeleteByIdInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"deletedId"}}]}}]}}]} as unknown as DocumentNode<DeleteNoteMutation, DeleteNoteMutationVariables>;
export const GetNotesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetNotes"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"notes"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"NoteGridItemFragment"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"NoteGridItemFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"NoteType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"content"}}]}}]} as unknown as DocumentNode<GetNotesQuery, GetNotesQueryVariables>;
export const GetProviderDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetProvider"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"provider"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"logoUrl"}},{"kind":"Field","name":{"kind":"Name","value":"theme"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"backgroundColor"}},{"kind":"Field","name":{"kind":"Name","value":"borderColor"}}]}},{"kind":"FragmentSpread","name":{"kind":"Name","value":"ProviderEndpointsFragment"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ProviderEndpointsFragment"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ProviderType"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"endpoints"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}}]}}]}}]} as unknown as DocumentNode<GetProviderQuery, GetProviderQueryVariables>;