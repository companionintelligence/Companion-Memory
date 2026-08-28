import { randomUUID } from 'node:crypto';

import { PersonalizationService, type TrustMode } from '@ci/domains/personalization';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REAL TRUST DIAL, SET TO A GIVEN MODE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A spec that wants to know what the dial answers must ask the dial. Stubbing
 * `decideAction` to return a decision and then asserting that decision back is
 * how an unreachable branch — and the counter behind it — shipped in
 * `EntityTypeAuditService` in the first place.
 *
 * So the service under test is the real {@link PersonalizationService}, with
 * `decide()` and `profileForTrustMode()` untouched. Only its two READ
 * dependencies are doubled, because a trust mode is stored on the self Person
 * and reading it is the one thing that needs a database.
 *
 * @param trustMode `null` leaves no self identity at all, which is how the
 *   service falls back to its default mode — the mode an appliance that has
 *   never opened the setting actually runs under.
 */
export function personalizationWithTrustMode(trustMode: TrustMode | null): PersonalizationService {
  const selfEntityId = randomUUID();
  const userContextService = {
    getSelfIdentity: async () => (trustMode == null ? null : { entityId: selfEntityId }),
  };
  const personService = {
    findById: async () => ({ id: selfEntityId, properties: { planner: { trust_mode: trustMode } } }),
  };

  return new PersonalizationService(personService as never, userContextService as never);
}

/**
 * Keyed on `TrustMode` rather than listed, so a fourth mode added to the union
 * fails to compile here instead of quietly going untested.
 */
const EVERY_TRUST_MODE: Record<TrustMode, true> = {
  cautious: true,
  balanced: true,
  hands_off: true,
};

/** Every mode an appliance can be in, plus `null` for the unset default. */
export const ALL_TRUST_MODES: ReadonlyArray<TrustMode | null> = [
  null,
  ...(Object.keys(EVERY_TRUST_MODE) as TrustMode[]),
];
