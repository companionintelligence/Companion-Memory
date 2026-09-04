import type { Buffer } from 'node:buffer';

export interface TokenExchange {
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: Date | null;
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface Calendar {
  id: string;
  name: string;
  isDefaultCalendar: boolean;
  changeKey: string;
  owner: {
    name: string;
    address: string;
  };
  events?: unknown[];
}

export interface CalendarEvent {
  id: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  changeKey: string;
  categories: string[];
  originalStartTimeZone: string;
  originalEndTimeZone: string;
  iCalUId: string;
  reminderMinutesBeforeStart: number;
  isReminderOn: boolean;
  hasAttachments: boolean;
  subject: string;
  bodyPreview: string;
  importance: string;
  sensitivity: string;
  isAllDay: boolean;
  isCancelled: boolean;
  isOrganizer: boolean;
  responseRequested: boolean;
  seriesMasterId?: string;
  attachments?: OutlookAttachment[];
}

export interface OneDriveUser {
  email: string;
  displayName: string;
}

export interface OneDrivePageEntity {
  '@odata.etag': string;
  createdDateTime: string;
  eTag: string;
  id: string;
  lastModifiedDateTime: string;
  webUrl: string;
  createdBy: {
    user: OneDriveUser;
  };
  lastModifiedBy: {
    user: OneDriveUser;
  };
  file?: Record<string, unknown>;
  content?: OneDriveFileEntity;
}

export interface OneDriveFileEntity {
  '@microsoft.graph.downloadUrl': string;
  createdDateTime: string;
  eTag: string;
  id: string;
  lastModifiedDateTime: string;
  name: string;
  webUrl: string;
  size: number;
  createdBy: {
    user: OneDriveUser;
  };
  lastModifiedBy: {
    user: OneDriveUser;
  };
  file: {
    mimeType: string;
    hashes: {
      [key: string]: string;
    };
  };
  image?: {
    height: number;
    width: number;
  };
  photo?: {
    orientation?: number;
  };
  raw?: Buffer;
}

export interface OutlookAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentBytes?: string;
  lastModifiedDateTime: string;
}

export interface OutlookMailMessageEntity {
  id: string;
  subject: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  changeKey: string;
  categories: string[];
  receivedDateTime: string;
  sentDateTime: string;
  hasAttachments: boolean;
  conversationId?: string;
  internetMessageId?: string;
  webLink?: string;
  isDraft?: boolean;
  isRead?: boolean;
  importance?: string;
  inferenceClassification?: string;
  internetMessageHeaders?: Array<{
    name: string;
    value: string;
  }>;
  bodyPreview?: string;
  body?: {
    contentType: string;
    content: string | null;
  };
  from?: {
    emailAddress: {
      name: string;
      address: string;
    };
  };
  toRecipients?: Array<{
    emailAddress: {
      name: string;
      address: string;
    };
  }>;
  ccRecipients?: Array<{
    emailAddress: {
      name: string;
      address: string;
    };
  }>;
  bccRecipients?: Array<{
    emailAddress: {
      name: string;
      address: string;
    };
  }>;
  attachments?: OutlookAttachment[];
}

/**
 * One entry of a post's `attachments{...}` edge, or of an album attachment's
 * `subattachments{...}`. `target.id` is the Graph id of the photo/video the
 * attachment points at — the same id `/me/photos` and `/me/videos` list — so
 * a post's media and the standalone media endpoints resolve to one object.
 */
export interface FacebookPostAttachment {
  target?: {
    id: string;
    url: string;
  };
  /** e.g. `photo`, `video_inline`, `album`, `share`, `cover_photo`. */
  type?: string;
  /** e.g. `photo`, `video`, `album`, `link`. Narrower than `type`. */
  media_type?: string;
  url?: string;
  media?: {
    image?: {
      height: number;
      src: string;
      width: number;
    };
    /** Direct (CDN, expiring) URL of the video file for video attachments. */
    source?: string;
  };
  subattachments?: {
    data: FacebookPostAttachment[];
  };
}

export interface FacebookPost {
  id: string;
  created_time: string;
  message?: string;
  story?: string;
  link?: string;
  type?: string;
  permalink_url?: string;
  full_picture?: string;
  picture?: string;
  from?: {
    id: string;
    name: string;
  };
  attachments?: {
    data: FacebookPostAttachment[];
  };
}

export interface FacebookLike {
  id: string;
  name: string;
  category: string;
  link: string;
  created_time: string;
  cover?: {
    cover_id: string;
    offset_x: number;
    offset_y: number;
    source: string;
    id: string;
  };
}

export interface FacebookFriend {
  id: string;
  name: string;
  // The Graph API returns "picture" wrapped like a connection response, not
  // flat -- matches what /me/friends?fields=id,name,picture actually sends.
  picture?: {
    data: {
      height: number;
      width: number;
      url: string;
      is_silhouette: boolean;
    };
  };
}

export interface FacebookPhoto {
  id: string;
  name?: string;
  created_time: string;
  images: Array<{
    height: number;
    width: number;
    source: string;
  }>;
  link: string;
  picture?: string;
  place?: {
    name: string;
    location: {
      city?: string;
      country?: string;
      latitude?: number;
      longitude?: number;
      state?: string;
      street?: string;
      zip?: string;
    };
  };
}

export interface FacebookVideo {
  id: string;
  title?: string;
  description?: string;
  created_time: string;
  source: string;
  permalink_url: string;
  length: number;
  thumbnails?: {
    data: Array<{
      id: string;
      uri: string;
      height: number;
      width: number;
    }>;
  };
}

/**
 * One node of a Gmail API message's MIME tree.
 *
 * `parts` is RECURSIVE because the tree is. `SyncGmail` fetches
 * `/gmail/v1/users/me/messages/{id}` with no `format` param — Gmail's default
 * `format=full` — so the whole MIME structure arrives. Rich-text mail with an
 * attachment comes back as
 * `multipart/mixed → [multipart/alternative → [text/plain, text/html], …]`,
 * putting the body leaves two levels down. This type used to declare a single
 * flat level, which made a depth-first body walk unwriteable; such messages
 * silently stored Gmail's ~200-character snippet as their body instead.
 *
 * `filename` is what separates an inline body leaf (Gmail sends `""`) from an
 * attached `.txt`/`.html` file, so the walk can skip attachments.
 */
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{
    name: string;
    value: string;
  }>;
  body?: {
    size?: number;
    data?: string;
    attachmentId?: string;
  };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
  sizeEstimate?: number;
  historyId?: string;
  internalDate?: string;
}

export interface EmailParticipant {
  email: string;
  name: string;
  type: 'from' | 'to' | 'cc' | 'bcc';
}
