/**
 * Cross-pipeline identity — the only place `source_system` / `source_id` are
 * minted. See docs/design/cross-pipeline-identity.md.
 *
 * Deliberately NOT exported: `asSourceSystem` / `asSourceId` from ./types —
 * arbitrary casts stay inside this directory.
 */
export type { SourceId, SourceIdentity, SourceSystem } from './types';
export {
  FEDERATED_SYSTEMS,
  PLATFORM_SYSTEMS,
  SYSTEM_ALIASES,
  adoptIngestIdentity,
  attachmentIdentity,
  canonicalSystem,
  fallbackId,
  isFederatedSystem,
  isRegisteredSystem,
  ledgerPlatform,
  platformIdentity,
} from './registry';
export {
  GMAIL_THREAD_HEADER,
  cleanMessageId,
  emailAttachmentIdentity,
  emailFallbackIdentity,
  emailIdentity,
  emailThreadKey,
  gmailThreadKeyFromApi,
  gmailThreadKeyFromImap,
  messageIdFromHeaders,
  normalizeMessageId,
  parseMessageIds,
} from './email';
export {
  CHROMIUM_EPOCH_OFFSET_MS,
  browserBookmarkIdentity,
  browserDownloadIdentity,
  browserVisitIdentity,
  unixMsFromApiMillis,
  unixMsFromChromiumMicros,
  unixMsFromMicros,
  type BrowserSystem,
} from './browser';
export { calendarEventIdentity, icsRecurrenceInstant, normalizeIcsRecurrenceId } from './calendar';
export { facebookPostIdentity } from './facebook';
export { fileIdentity } from './file';
export {
  youtubeLikeIdentity,
  youtubePlaylistIdentity,
  youtubeSubscriptionIdentity,
  youtubeUploadIdentity,
  youtubeVideoIdFromUrl,
} from './youtube';
