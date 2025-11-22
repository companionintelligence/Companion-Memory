export interface CalendarSyncState {
  syncToken?: string;
  lastFullSyncAt?: string;
  lastUpdatedMinUsed?: string;
}

export interface GmailSyncState {
  lastHistoryId?: string;
  trackedLabels?: string[];
  watchChannelId?: string;
  watchResourceId?: string;
  watchExpiration?: string;
}

export interface DriveSyncState {
  startPageToken?: string;
  lastSyncAt?: string;
}

export interface ContactsSyncState {
  syncToken?: string;
  lastSyncAt?: string;
}

export interface YouTubeSyncState {
  lastSyncAt?: string;
  lastLikesItemId?: string;
  lastPlaylistId?: string;
  lastSubscriptionId?: string;
  lastActivityId?: string;
}

export interface GoogleSyncState {
  calendar?: CalendarSyncState;
  gmail?: GmailSyncState;
  drive?: DriveSyncState;
  contacts?: ContactsSyncState;
  youtube?: YouTubeSyncState;
  [key: string]: unknown;
}

export interface SyncResult {
  data: unknown;
  syncState:
    | CalendarSyncState
    | GmailSyncState
    | DriveSyncState
    | ContactsSyncState
    | YouTubeSyncState
    | OutlookMailSyncState
    | OutlookCalendarsSyncState
    | OneDriveSyncState;
}

export interface CalendarSyncResult {
  data: unknown;
  syncState: CalendarSyncState;
}

export interface GmailSyncResult {
  data: unknown;
  syncState: GmailSyncState;
}

export interface OutlookMailSyncState {
  skip?: string;
}

export interface OutlookCalendarsSyncState {
  [key: string]: OutlookCalendarSyncState;
}

export interface OutlookCalendarSyncState {
  skip?: string;
}

export interface OneDriveSyncState {
  nextLink?: string | undefined;
}

export interface InstagramProfileSyncState {
  lastSyncAt?: string;
  igUserId?: string;
}

export interface InstagramMediaSyncState {
  lastSyncAt?: string;
  lastMediaId?: string;
  paginationCursor?: string; // Instagram's 'after' cursor for pagination
}

export interface InstagramCommentsSyncState {
  lastSyncAt?: string;
  lastCommentId?: string;
  lastMediaId?: string; // Track which media we're currently syncing comments for
  mediaPaginationCursor?: string; // Cursor for paginating through media list
  commentPaginationCursor?: string; // Cursor for paginating through comments for current media
}

export interface InstagramInsightsSyncState {
  lastSyncAt?: string;
  lastMetric?: string; // Track which metric we're currently syncing
  lastPeriod?: string; // Track which period we're currently syncing
  lastMediaId?: string; // Track which media we're currently syncing insights for
  mediaPaginationCursor?: string; // Cursor for paginating through media list
}

export interface InstagramStoriesSyncState {
  lastSyncAt?: string;
  paginationCursor?: string; // Instagram's 'after' cursor for pagination
}

export interface InstagramDMSyncState {
  lastSyncAt?: string;
  lastConversationId?: string;
  conversationPaginationCursor?: string; // Cursor for paginating through conversations
  messagePaginationCursor?: string; // Cursor for paginating through messages in current conversation
  currentConversationId?: string; // Track which conversation we're currently syncing messages for
}

export interface InstagramLikedMediaSyncState {
  lastSyncAt?: string;
  lastLikedMediaId?: string;
  paginationCursor?: string; // Instagram's 'after' cursor for pagination
}

export interface InstagramUserCommentsSyncState {
  lastSyncAt?: string;
  lastCommentId?: string;
  paginationCursor?: string; // Instagram's 'after' cursor for pagination
}

export interface InstagramSavedMediaSyncState {
  lastSyncAt?: string;
  lastSavedMediaId?: string;
  paginationCursor?: string; // Instagram's 'after' cursor for pagination
}

export interface InstagramSyncState {
  profile?: InstagramProfileSyncState;
  media?: InstagramMediaSyncState;
  stories?: InstagramStoriesSyncState;
  dms?: InstagramDMSyncState;
  [key: string]: unknown;
}
