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

export interface FacebookPost {
  id: string;
  created_time: string;
  link: string;
  type: string;
  full_picture?: string;
  picture?: string;
  attachments?: {
    data: Array<{
      target?: {
        id: string;
        url: string;
      };
      type: string;
      url: string;
      media?: {
        image?: {
          height: number;
          src: string;
          width: number;
        };
        source?: string;
      };
      subattachments?: {
        data: Array<{
          media?: {
            image?: {
              height: number;
              src: string;
              width: number;
            };
            source: string;
          };
          target?: {
            id: string;
            url: string;
          };
          type?: string;
          url?: string;
        }>;
      };
    }>;
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
  picture?: {
    height: number;
    width: number;
    url: string;
    is_silhouette: boolean;
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

export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{
      name: string;
      value: string;
    }>;
    body?: {
      size?: number;
      data?: string;
    };
    parts?: Array<{
      mimeType?: string;
      body?: {
        size?: number;
        data?: string;
      };
    }>;
  };
  sizeEstimate?: number;
  historyId?: string;
  internalDate?: string;
}

export interface EmailParticipant {
  email: string;
  name: string;
  type: 'from' | 'to' | 'cc' | 'bcc';
}
