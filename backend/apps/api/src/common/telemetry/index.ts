export { scrubEvent, scrubString } from './scrubEvent';
export {
  dropWhenUserOptedOut,
  gateSentryTransport,
  isCrashReportsUserEnabled,
  setCrashReportsUserEnabled,
} from './runtimeGate';
export {
  isLocalOnly,
  isTelemetryOptedOut,
  resolveTelemetrySettings,
  type TelemetryDisabledReason,
  type TelemetrySettings,
} from './settings';
