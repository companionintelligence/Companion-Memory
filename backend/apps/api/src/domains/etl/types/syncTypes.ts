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
    | OutlookCalendarsSyncState;
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
