/**
 * The vocabulary of `ci.outbound_settings`, in one place so the store, the
 * service, the controller and every enforcement point cannot drift apart on
 * what a key means.
 */

/**
 * The documented outbound paths a user can switch off. A CLOSED set, mirrored by
 * a CHECK on the table: widening it is a migration plus an edit here, never a
 * string somebody passes in.
 *
 * The ORDER is the order the API returns them in, so it is part of the contract
 * with the Settings card.
 */
export const OUTBOUND_PATH_KEYS = ['crash_reports', 'place_lookups', 'link_previews', 'portal_oauth'] as const;

export type OutboundPathKey = (typeof OUTBOUND_PATH_KEYS)[number];

export function isOutboundPathKey(value: unknown): value is OutboundPathKey {
  return typeof value === 'string' && (OUTBOUND_PATH_KEYS as readonly string[]).includes(value);
}

/**
 * Every path ships on. Written as a constant rather than left implicit so the
 * API can state it and a test can pin it: "absent row means default" is only a
 * safe rule while the default is the behaviour the appliance had before the
 * switch existed.
 */
export const OUTBOUND_DEFAULT_ENABLED = true;

/** One row of `ci.outbound_settings`, as the store holds it. */
export interface OutboundSettingRow {
  readonly key: OutboundPathKey;
  /** NULL in the database — no opinion, inherit the shipped default. */
  readonly enabled: boolean | null;
  readonly updatedAt: Date | null;
  /** The account that last changed it, when known. */
  readonly updatedBy: string | null;
}
