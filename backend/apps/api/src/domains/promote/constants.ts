/**
 * API Log scope constants for promotion events
 */
export const ApiLogScopes = {
  GMAIL: 'Gmail',
  GOOGLE_CALENDAR: 'Google Calendar',
  YOUTUBE: 'YouTube',
  GOOGLE_DRIVE: 'Google Drive',
  GOOGLE_CONTACTS: 'Google Contacts',
  OUTLOOK_MAIL: 'Microsoft Graph - Mail',
  OUTLOOK_CALENDAR: 'Microsoft Graph - Calendar',
  ONEDRIVE_FILES: 'Microsoft Graph - OneDrive Files',
  FACEBOOK_PROFILE: 'facebook profile',
  FACEBOOK_POSTS: 'facebook posts',
  FACEBOOK_PHOTOS: 'facebook photos',
  FACEBOOK_VIDEOS: 'facebook videos',
  FACEBOOK_FRIENDS: 'facebook friends',
  FACEBOOK_LIKES: 'facebook likes',
} as const;

export type ApiLogScope = (typeof ApiLogScopes)[keyof typeof ApiLogScopes];
