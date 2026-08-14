export { EmptyState } from './src/components/EmptyState';
export { ErrorPage } from './src/components/error-page';
export { LoadingPage } from './src/components/loading-page';
export { Portal } from './src/components/portal';
export { DeviceLayoutProvider, useDeviceLayout, usePageTitle } from './src/hooks';
export { GlobalUID } from './src/utils/GlobalUID';
export { apiKeyHeaders, getApiKey, setApiKey } from './src/utils/apiAuth';
export {
  buildApiUrl,
  getApiBaseUrl,
  initApiBaseUrl,
  isNativePlatform,
  persistApiBaseUrl,
  setApiBaseUrl,
} from './src/utils/apiBase';
export {
  CONNECTION_PROBE_TIMEOUT_MS,
  ConnectionModeProvider,
  resolveConnectionMode,
  useConnectionMode,
} from './src/utils/connectionMode';
export type { ConnectionMode } from './src/utils/connectionMode';
export { createHookContext } from './src/utils/createHookContext';
export {
  MIN_DISTANCE_METERS,
  MIN_INTERVAL_MS,
  buildNoteRecord,
  buildPositionRecord,
  captureLocationFix,
  captureNote,
  createLocationSampler,
  deviceSourceKey,
  fixFromGeolocationPosition,
  forgetQueuedNote,
  haversineMeters,
  isQueuedNote,
  newNoteId,
  positionSourceId,
  rememberQueuedNote,
} from './src/utils/deviceSources';
export type {
  CaptureLocationOptions,
  DeviceLocationFix,
  LocationCaptureOutcome,
  LocationSample,
  LocationSampler,
  LocationSourceKind,
  NoteCaptureOutcome,
  NoteRecord,
  PositionRecord,
  PositionRecordOptions,
} from './src/utils/deviceSources';
export { FetchJsonError, fetchJson, type FetchJsonIssue } from './src/utils/fetchJson';
export { localHubPlugin, localHubSession, type LocalHubSession } from './src/utils/localHub';
export {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_ITEMS,
  OUTBOX_WARN_AT,
  enqueueOutboxItem,
  getOutboxItem,
  listOutbox,
  recordOutboxAttempt,
  removeOutboxItem,
  retryOutboxItem,
} from './src/utils/outbox';
export type {
  OutboxAttemptOutcome,
  OutboxCapacity,
  OutboxCounts,
  OutboxEnqueueAck,
  OutboxEnqueueInput,
  OutboxFailureReason,
  OutboxItem,
  OutboxListing,
  OutboxResult,
  OutboxStatus,
  OutboxStatusFilter,
} from './src/utils/outbox';
export {
  INGEST_FINISH_MIN_INTERVAL_MS,
  INGEST_FINISH_PATH,
  NOTE_OUTBOX_KIND,
  POSITION_OUTBOX_KIND,
  OutboxQueueProvider,
  finishStagesFor,
  flushOutbox,
  isPermanentFlushFailure,
  outboxEndpointFor,
  oweIngestFinish,
  registerOutboxKind,
  resetIngestFinishState,
  settleIngestFinish,
  useOutboxQueue,
} from './src/utils/outboxFlush';
export type { FlushOutboxOptions, FlushOutboxSummary, OutboxQueueState } from './src/utils/outboxFlush';
export {
  addAppStateListener,
  addAppUrlOpenListener,
  addBackButtonListener,
  exitApp,
  hasNotificationPermission,
  hideSplashScreen,
  openExternalUrl,
  requestNotificationPermission,
  scheduleLocalNotification,
  secureStorageGet,
  secureStorageRemove,
  secureStorageSet,
  setStatusBarStyle,
  syncNativeIntentConfig,
} from './src/utils/nativeBridge';
export type { LocalNotification } from './src/utils/nativeBridge';
export {
  OIDC_NATIVE_CALLBACK_URL,
  OIDC_NATIVE_CLIENT_FLAG,
  OIDC_NATIVE_SCHEME,
  parseOidcCallbackUrl,
} from './src/utils/oidcNative';
export type { OidcCallbackParams } from './src/utils/oidcNative';
export {
  WEB_SPEECH_UNAVAILABLE_REASON,
  downloadRecognitionLanguage,
  ensureSpeechPermissions,
  installSynthesisLanguage,
  isSpeaking,
  listRecognitionLanguages,
  listSpeechVoices,
  listSynthesisLanguages,
  probeSpeechRecognition,
  probeSpeechSynthesis,
  speakText,
  speechPlugin,
  startDictation,
  stopSpeaking,
} from './src/utils/speech';
export type {
  DictationOptions,
  DictationSession,
  SpeakTextOptions,
  SpeechEndReason,
  SpeechErrorCode,
  SpeechLanguagePackState,
  SpeechOnDevicePolicy,
  SpeechRecognitionCapability,
  SpeechRecognitionMode,
  SpeechRecognitionTier,
  SpeechSynthesisCapability,
  SpeechSynthesisLanguage,
  SpeechSynthesisLanguageStatus,
  SpeechVoice,
} from './src/utils/speech';
