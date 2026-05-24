/*
 * --------------- IMPORTANT NOTE ---------------
 *
 * This file is now considered a legacy implementation and should
 * no longer be modified. For an example of the new implementation
 * please refer to:
 *
 *   backend/apps/api/domains/user/events.ts
 *
 * --------------- IMPORTANT NOTE ---------------
 */

interface EventPayload {
  name?: never;
}

export const enum Events {
  CHAT_SUMMARIZATION = 'chat.summarization',
  INFER_QUESTION_ANSWER = 'infer.question.answer',
  PROMOTE_CONTACTS = 'PROMOTE_CONTACTS',
  PROMOTE_DRIVE_DATA = 'PROMOTE_DRIVE_DATA',
  PROMOTE_YOUTUBE_DATA = 'PROMOTE_YOUTUBE_DATA',
  PROMOTE_CALENDAR_EVENTS = 'PROMOTE_CALENDAR_EVENTS',
  PROMOTE_GMAIL_MESSAGES = 'PROMOTE_GMAIL_MESSAGES',
  GRAPH_PERSON_CREATED = 'graph.person.created',
  GRAPH_FAMILY_MEMBERS_ADDED = 'graph.family.members.added',
  GRAPH_PREFERENCE_ADDED = 'graph.preference.added',
  GRAPH_PREFERENCES_ADDED = 'graph.preferences.added',
  GRAPH_LOCATION_CREATED = 'graph.location.created',
  GRAPH_VISIT_RECORDED = 'graph.visit.recorded',
  GRAPH_CONNECTION_CREATED = 'graph.connection.created',
  GRAPH_NODE_DELETED = 'graph.node.deleted',
  GRAPH_NODE_UPDATED = 'graph.node.updated',
  GRAPH_RELATIONSHIP_DELETED = 'graph.relationship.deleted',
  GRAPH_NODE_UPSERTED = 'graph.node.upserted',
  GRAPH_RELATIONSHIP_UPSERTED = 'graph.relationship.upserted',
  SEARCH_EMBED_ENTITY = 'search.embed.entity',
  PROMOTE_OUTLOOK_MAIL_MESSAGES = 'PROMOTE_OUTLOOK_MAIL_MESSAGES',
  PROMOTE_OUTLOOK_CALENDAR_EVENTS = 'PROMOTE_OUTLOOK_CALENDAR_EVENTS',
  PROMOTE_ONEDRIVE_FILES = 'PROMOTE_ONEDRIVE_FILES',
  PROMOTE_FACEBOOK_PROFILE = 'PROMOTE_FACEBOOK_PROFILE',
  PROMOTE_FACEBOOK_POSTS = 'PROMOTE_FACEBOOK_POSTS',
  PROMOTE_FACEBOOK_PHOTOS = 'PROMOTE_FACEBOOK_PHOTOS',
  PROMOTE_FACEBOOK_VIDEOS = 'PROMOTE_FACEBOOK_VIDEOS',
  PROMOTE_FACEBOOK_FRIENDS = 'PROMOTE_FACEBOOK_FRIENDS',
  PROMOTE_FACEBOOK_LIKES = 'PROMOTE_FACEBOOK_LIKES',
}

interface ChatSummarizationPayload extends EventPayload {
  ownerId: string;
  threadId: string;
}

interface InferQuestionAnswerPayload extends EventPayload {
  ownerId: string | null;
  questionId: string;
}

interface PromoteGmailMessagesPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteCalendarEventsPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteYouTubeDataPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteDriveDataPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteContactsPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface GraphRelationshipInput {
  relationshipId?: string;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: string;
  strength?: number;
  properties?: Record<string, unknown>;
  isBidirectional?: boolean;
  startDate?: string;
  endDate?: string;
}

interface GraphPersonCreatedPayload extends EventPayload {
  ownerId: string;
  person: {
    entityId: string;
    entityType: string;
    name?: string | null;
    description?: string | null;
    properties?: Record<string, unknown>;
  };
  relationships?: GraphRelationshipInput[];
}

interface GraphFamilyMembersAddedPayload extends EventPayload {
  ownerId: string;
  members: Array<{
    entityId: string;
    entityType: string;
    name?: string | null;
    description?: string | null;
    properties?: Record<string, unknown>;
    relationships: GraphRelationshipInput[];
  }>;
}

interface GraphPreferenceAddedPayload extends EventPayload {
  ownerId: string;
  concept: {
    entityId: string;
    entityType: string;
    name?: string | null;
    description?: string | null;
    properties?: Record<string, unknown>;
    ensure?: boolean;
  };
  relationship: GraphRelationshipInput;
}

interface GraphPreferencesAddedPayload extends EventPayload {
  ownerId: string;
  preferences: Array<{
    concept: GraphPreferenceAddedPayload['concept'];
    relationship: GraphRelationshipInput;
  }>;
}

interface GraphLocationCreatedPayload extends EventPayload {
  ownerId: string;
  location: {
    entityId: string;
    entityType: string;
    name?: string | null;
    description?: string | null;
    properties?: Record<string, unknown>;
  };
}

interface GraphVisitRecordedPayload extends EventPayload {
  ownerId: string;
  relationship: GraphRelationshipInput;
}

interface GraphConnectionCreatedPayload extends EventPayload {
  ownerId: string;
  relationship: GraphRelationshipInput;
}

interface GraphNodeDeletedPayload extends EventPayload {
  ownerId: string;
  entityId: string;
}

interface GraphNodeUpdatedPayload extends EventPayload {
  ownerId: string;
  entityId: string;
  nodeName?: string | null;
  description?: string | null;
  properties?: Record<string, unknown>;
}

interface GraphRelationshipDeletedPayload extends EventPayload {
  ownerId: string;
  relationshipId: string;
}

interface GraphNodeUpsertedPayload extends EventPayload {
  ownerId: string;
  node: GraphPersonCreatedPayload['person'] & {
    searchContent?: string | null;
    linkedTable?: string | null;
    linkedId?: string | null;
    mergeProperties?: boolean;
  };
}

interface GraphRelationshipUpsertedPayload extends EventPayload {
  ownerId: string;
  relationship: GraphRelationshipInput & {
    mergeProperties?: boolean;
  };
}

interface SearchEmbedEntityPayload extends EventPayload {
  ownerId: string;
  entityId: string;
  searchContent: string;
  entityType?: string;
}

interface PromoteOutlookMessagesPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteOutlookCalendarEventsPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteOneDriveFilePayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteFacebookProfilePayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteFacebookPostsPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteFacebookPhotosPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteFacebookVideosPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteFacebookFriendsPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

interface PromoteFacebookLikesPayload extends EventPayload {
  apiLogId: string;
  userId: string;
  connectionId: string;
  content: unknown;
}

export type EventPayloads = {
  [Events.CHAT_SUMMARIZATION]: ChatSummarizationPayload;
  [Events.INFER_QUESTION_ANSWER]: InferQuestionAnswerPayload;
  [Events.PROMOTE_GMAIL_MESSAGES]: PromoteGmailMessagesPayload;
  [Events.PROMOTE_CALENDAR_EVENTS]: PromoteCalendarEventsPayload;
  [Events.PROMOTE_YOUTUBE_DATA]: PromoteYouTubeDataPayload;
  [Events.PROMOTE_DRIVE_DATA]: PromoteDriveDataPayload;
  [Events.PROMOTE_CONTACTS]: PromoteContactsPayload;
  [Events.GRAPH_PERSON_CREATED]: GraphPersonCreatedPayload;
  [Events.GRAPH_FAMILY_MEMBERS_ADDED]: GraphFamilyMembersAddedPayload;
  [Events.GRAPH_PREFERENCE_ADDED]: GraphPreferenceAddedPayload;
  [Events.GRAPH_PREFERENCES_ADDED]: GraphPreferencesAddedPayload;
  [Events.GRAPH_LOCATION_CREATED]: GraphLocationCreatedPayload;
  [Events.GRAPH_VISIT_RECORDED]: GraphVisitRecordedPayload;
  [Events.GRAPH_CONNECTION_CREATED]: GraphConnectionCreatedPayload;
  [Events.GRAPH_NODE_DELETED]: GraphNodeDeletedPayload;
  [Events.GRAPH_NODE_UPDATED]: GraphNodeUpdatedPayload;
  [Events.GRAPH_RELATIONSHIP_DELETED]: GraphRelationshipDeletedPayload;
  [Events.GRAPH_NODE_UPSERTED]: GraphNodeUpsertedPayload;
  [Events.GRAPH_RELATIONSHIP_UPSERTED]: GraphRelationshipUpsertedPayload;
  [Events.SEARCH_EMBED_ENTITY]: SearchEmbedEntityPayload;
  [Events.PROMOTE_OUTLOOK_MAIL_MESSAGES]: PromoteOutlookMessagesPayload;
  [Events.PROMOTE_OUTLOOK_CALENDAR_EVENTS]: PromoteOutlookCalendarEventsPayload;
  [Events.PROMOTE_ONEDRIVE_FILES]: PromoteOneDriveFilePayload;
  [Events.PROMOTE_FACEBOOK_PROFILE]: PromoteFacebookProfilePayload;
  [Events.PROMOTE_FACEBOOK_POSTS]: PromoteFacebookPostsPayload;
  [Events.PROMOTE_FACEBOOK_PHOTOS]: PromoteFacebookPhotosPayload;
  [Events.PROMOTE_FACEBOOK_VIDEOS]: PromoteFacebookVideosPayload;
  [Events.PROMOTE_FACEBOOK_FRIENDS]: PromoteFacebookFriendsPayload;
  [Events.PROMOTE_FACEBOOK_LIKES]: PromoteFacebookLikesPayload;
};
