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
  canonicalSystem,
  fallbackId,
  isRegisteredSystem,
  platformIdentity,
} from './registry';
export {
  emailAttachmentIdentity,
  emailFallbackIdentity,
  emailIdentity,
  messageIdFromHeaders,
  normalizeMessageId,
} from './email';
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
