import config from '@ci/configuration';

/**
 * The contract CI-Portal and Memory share for addressing a Portal token to one appliance.
 *
 * CI-Portal's `apps/hono-app/src/domains/core/services/applianceAudience.ts` holds the other half.
 * The two must agree on every value here:
 *
 * - An appliance is named by `urn:ci:device:<device id>`, where the device id is the Hub's own id,
 *   the one the Hub pairs with and passes to its apps as `HUB_DEVICE_ID`.
 * - A token addressed to an appliance carries that URN as a second `aud` value, after the client id:
 *   `"aud": ["ci-server", "urn:ci:device:<id>"]`, with `"azp"` naming the client.
 * - Every token a Portal mints once it can address tokens carries `"ci_appliance_binding": 1`, so a
 *   token without an appliance audience from that Portal is known to be unaddressed rather than
 *   older than the feature.
 */
export const APPLIANCE_AUDIENCE_PREFIX = 'urn:ci:device:';

/** The claim a Portal that addresses tokens to appliances puts on every token it mints. */
export const APPLIANCE_BINDING_CLAIM = 'ci_appliance_binding';

/** The audience value naming the appliance with this Hub device id. */
export function applianceAudienceFor(deviceId: string): string {
  return `${APPLIANCE_AUDIENCE_PREFIX}${deviceId}`;
}

/** Whether an `aud` value names an appliance (any appliance), rather than a client. */
export function isApplianceAudience(value: string): boolean {
  return value.startsWith(APPLIANCE_AUDIENCE_PREFIX) && value.length > APPLIANCE_AUDIENCE_PREFIX.length;
}

/**
 * This appliance's own audience, or null when it has none.
 *
 * `auth.portal.applianceAudience` (`PORTAL_APPLIANCE_AUDIENCE`) wins when set. Otherwise it is
 * derived from the Hub device id the Hub already passes in (`HUB_DEVICE_ID`). An install without a
 * Hub has neither, so no Portal token is ever addressed to it.
 *
 * A configured bare device id is read as that device's audience. Taken as it stands it could
 * never equal an `aud` value the Portal writes, and every token addressed here would be refused
 * as addressed elsewhere.
 */
export function thisApplianceAudience(): string | null {
  const configured = config.auth.portal.applianceAudience?.trim();
  if (configured) {
    return isApplianceAudience(configured) ? configured : applianceAudienceFor(configured);
  }

  const deviceId = config.ciPortal.deviceId?.trim();

  return deviceId ? applianceAudienceFor(deviceId) : null;
}

/** Whether a verified token's claims say the Portal that minted it addresses tokens to appliances. */
export function mintedByAddressingPortal(payload: Record<string, unknown>): boolean {
  const marker = payload[APPLIANCE_BINDING_CLAIM];

  return typeof marker === 'number' && marker >= 1;
}
