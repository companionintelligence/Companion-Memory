import { Controller, Get, HttpCode } from '@nestjs/common';

import {
  isCrashReportsUserEnabled,
  resolveTelemetrySettings,
  type TelemetryDisabledReason,
} from '@ci/common/telemetry';

/**
 * Why the browser is told not to report. The first three come from the
 * environment (`resolveTelemetrySettings`); `user-setting` is the person using
 * the appliance having turned crash reports off from Settings -> Privacy.
 */
export type TelemetryConfigDisabledReason = TelemetryDisabledReason | 'user-setting';

/**
 * Runtime error-reporting consent for the web UI.
 *
 * A DSN baked into the bundle at build time cannot be turned off afterwards,
 * so the `CI_TELEMETRY` / `CI_LOCAL_ONLY` kill switches — including the
 * marketplace "Share crash reports" toggle, which sets `CI_TELEMETRY` on the
 * container — would silently not apply to the browser. This endpoint lets the
 * frontend ask the appliance whether reporting is permitted before it
 * initialises, for the same reason MapsConfigController exists.
 *
 * Deliberately unauthenticated: the browser must consult it before login, since
 * errors happen on the login page too. It exposes no secret — a Sentry DSN is a
 * public client credential, and when reporting is off there is nothing to
 * expose at all.
 *
 * The user's own switch is read from an in-process flag that the outbound
 * policy store keeps current (`common/telemetry/runtimeGate.ts`), never from the
 * database: this route is unauthenticated, so a query per request would let
 * anyone who can reach the appliance drive load on Postgres. The environment
 * kill switches are checked first and win — the reason reported is the
 * operator's when both apply, since that is the one the user cannot undo. The
 * choice reaches a browser at its next page load, because the SPA asks once,
 * before it initialises Sentry.
 */
@Controller('config')
export class TelemetryConfigController {
  @Get('telemetry')
  @HttpCode(200)
  telemetry() {
    // The browser reports as its own component, so resolve against the web
    // component name rather than the API's.
    const settings = resolveTelemetrySettings(process.env, 'ci-server-web');

    if (!settings.enabled) {
      return { enabled: false as const, reason: settings.disabledReason as TelemetryConfigDisabledReason };
    }

    if (!isCrashReportsUserEnabled()) {
      return { enabled: false as const, reason: 'user-setting' as TelemetryConfigDisabledReason };
    }

    return {
      enabled: true as const,
      environment: settings.environment,
      release: settings.release,
    };
  }
}
