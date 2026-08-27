export { EmptyState } from './src/components/EmptyState';
export { ErrorPage } from './src/components/error-page';
export { LoadingPage } from './src/components/loading-page';
export { Portal } from './src/components/portal';
export { MOBILE_BREAKPOINT, DeviceLayoutProvider, useDeviceLayout, usePageTitle } from './src/hooks';
export { GlobalUID } from './src/utils/GlobalUID';
export { apiKeyHeaders, getApiKey, setApiKey } from './src/utils/apiAuth';
export {
  buildApiUrl,
  getApiBaseUrl,
  initApiBaseUrl,
  isIosPlatform,
  isLocalApplianceOrigin,
  isNativePlatform,
  needsNativeCloudConnect,
  persistApiBaseUrl,
  resolveHttpOrigin,
  setApiBaseUrl,
  subscribeApiBaseUrl,
} from './src/utils/apiBase';
export {
  CONNECTION_REPROBE_INTERVAL_MS,
  LOCAL_PROBE_TIMEOUT_MS,
  REMOTE_PROBE_TIMEOUT_MS,
  ConnectionModeProvider,
  resolveConnectionMode,
  useConnectionMode,
} from './src/utils/connectionMode';
export type { ConnectionMode } from './src/utils/connectionMode';
export { createHookContext } from './src/utils/createHookContext';
export {
  BACKGROUND_MAX_ACCURACY_METERS,
  BACKGROUND_MIN_DISTANCE_METERS,
  BACKGROUND_MIN_INTERVAL_MS,
  HOME_GEOFENCE_RADIUS_METERS,
  LOCATION_ENABLED_STORAGE_KEY,
  LOCATION_MODE_CHANGE_EVENT,
  LOCATION_MODE_STORAGE_KEY,
  LOCATION_TRACKING_MODES,
  MIN_DISTANCE_METERS,
  MIN_INTERVAL_MS,
  buildNoteRecord,
  buildPositionRecord,
  captureLocationFix,
  captureNote,
  createLocationSampler,
  deviceSourceKey,
  fixFromBackgroundGeolocationLocation,
  fixFromGeolocationPosition,
  forgetQueuedNote,
  haversineMeters,
  isLocationTrackingEnabled,
  isLocationTrackingMode,
  isQueuedNote,
  newNoteId,
  positionSourceId,
  publishLocationTrackingMode,
  readLocationTrackingMode,
  rememberQueuedNote,
  writeLocationTrackingMode,
} from './src/utils/deviceSources';
export type {
  BackgroundGeolocationLocation,
  CaptureLocationOptions,
  DeviceLocationFix,
  LocationCaptureOutcome,
  LocationSample,
  LocationSampler,
  LocationSourceKind,
  LocationTrackingMode,
  NoteCaptureOutcome,
  NoteRecord,
  PositionRecord,
  PositionRecordOptions,
} from './src/utils/deviceSources';
export { FetchJsonError, apiFetch, fetchJson, type FetchJsonIssue } from './src/utils/fetchJson';
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
  addBackgroundLocationWatcher,
  closeBrowser,
  exitApp,
  getCurrentDeviceLocation,
  getLaunchUrl,
  getNativeCurrentLocation,
  hasNotificationPermission,
  hideSplashScreen,
  isBarcodeScanError,
  isDeviceLocationError,
  openExternalUrl,
  openNativeAppSettings,
  openNativeLocationSettings,
  removeBackgroundLocationWatcher,
  requestNotificationPermission,
  scanQrCode,
  scheduleLocalNotification,
  secureStorageGet,
  secureStorageRemove,
  secureStorageSet,
  setStatusBarStyle,
  syncNativeIntentConfig,
  takeNativePhoto,
} from './src/utils/nativeBridge';
export type {
  BackgroundGeolocationError,
  BarcodeScanErrorCode,
  DeviceLocationErrorCode,
  LocalNotification,
  NativeCurrentLocation,
} from './src/utils/nativeBridge';
export { BarcodeScanError, DeviceLocationError } from './src/utils/nativeBridge';
export {
  OIDC_NATIVE_CALLBACK_URL,
  OIDC_NATIVE_CLIENT_FLAG,
  OIDC_NATIVE_SCHEME,
  claimNativeOidcCode,
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
