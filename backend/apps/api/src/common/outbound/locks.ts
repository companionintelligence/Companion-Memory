import config from '@ci/configuration';

import { isLocalOnly, isTelemetryOptedOut } from '../telemetry';

import type { OutboundPathKey } from './types';

/**
 * Whether the OPERATOR has already forced a path off, and if so, in words the
 * Settings card can show.
 *
 * The line this draws: an explicit kill switch locks a path, a missing
 * configuration does not. `CI_TELEMETRY=off`, `CI_LOCAL_ONLY=true` and
 * `UNFURL_ENABLED=false` are somebody deciding "this appliance must not do
 * that", and the user's toggle must not be able to contradict them — so the
 * path reads as off, and turning it on is refused. "No Sentry DSN" or "no
 * Portal device key" is just a box with nothing to send to; it is not a
 * decision, so those leave the user's switch alone rather than showing a
 * control that can never be flipped.
 *
 * A locked path can still be turned OFF by the user, which records their
 * choice: if the operator later lifts the lock, the user's "off" is still there
 * waiting, which is the direction that must not silently reverse.
 *
 * `env` and `unfurlEnabled` are parameters (defaulting to the real process) so
 * this is a pure function a unit test can drive without re-parsing config.
 */
export function outboundLockedReason(
  key: OutboundPathKey,
  env: NodeJS.ProcessEnv = process.env,
  unfurlEnabled: boolean = config.unfurl.enabled,
): string | null {
  switch (key) {
    case 'crash_reports':
      // Local-only first: it is the stronger statement ("nothing leaves"), and
      // it is the one the startup log reports first as well.
      if (isLocalOnly(env)) {
        return 'Local-only mode is on for this appliance (CI_LOCAL_ONLY), so it never sends crash reports. This is set by whoever runs the appliance.';
      }

      if (isTelemetryOptedOut(env)) {
        return 'Crash reports are turned off by whoever runs this appliance (CI_TELEMETRY=off).';
      }

      return null;

    case 'link_previews':
      return unfurlEnabled
        ? null
        : 'Link previews are turned off in the configuration of this appliance (UNFURL_ENABLED=false), which is set by whoever runs it.';

    case 'place_lookups':
    case 'portal_oauth':
      // No operator kill switch exists for these today. Geocoding with no
      // Portal key configured simply reports "unavailable"; that is missing
      // configuration, not a lock.
      return null;
  }
}
