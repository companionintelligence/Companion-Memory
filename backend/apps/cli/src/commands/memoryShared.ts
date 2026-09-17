import { CliError, type CliContext } from '../context';
import type { AskGrantSummary } from '../graphqlClient';

/**
 * Small pieces shared by the `peers`, `grants` and `asks` command groups —
 * the closed vocabularies GraphQL enums already enforce (checked here too, for
 * a message a person wrote rather than a variable-coercion error naming a
 * GraphQL type), the "the ask feature is off" reading of `{ success: false }`,
 * and the grantee-resolution rule that keeps `grants create` from ever being
 * able to trip `ask_grants_grantee_chk`.
 *
 * Deliberately NOT validated here: `queryType` (the ask archetype). The server
 * is the single source of that vocabulary on purpose — see
 * `askInput.ts#parseAskQueryType` — and a second copy here is a second place
 * for the two to drift. A bad `queryType` is meant to come back as the
 * server's own `BAD_USER_INPUT`, verbatim.
 */

export const GRANT_MODES = ['auto', 'review', 'block'] as const;
export type GrantModeFlag = (typeof GRANT_MODES)[number];

export const PEER_TRUST_TIERS = ['family', 'peer', 'stranger', 'trusted'] as const;
export type PeerTrustTierFlag = (typeof PEER_TRUST_TIERS)[number];

export const DISCLOSURE_RUNGS = ['none', 'boolean', 'count', 'summary', 'redacted', 'full'] as const;
export type DisclosureRungFlag = (typeof DISCLOSURE_RUNGS)[number];

export const ANSWER_FORMS = ['attribute', 'boolean', 'existence', 'identity', 'retrieval'] as const;
export type AnswerFormFlag = (typeof ANSWER_FORMS)[number];

/** A flag's value against a closed vocabulary, or `undefined` when the flag was not passed. */
export function parseEnumFlag<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value == null) {
    return undefined;
  }

  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(`${flag} must be one of: ${allowed.join(', ')} (got "${value}").`);
  }

  return value as T;
}

/**
 * The message every ask/grant mutation's `{ success: false }` means. Every one
 * of these mutations is gated by the `ask` feature flag
 * (`FeatureService.isFeatureEnabled('ask')`) and answers this shape — never a
 * thrown error — while the flag is off, which is otherwise indistinguishable
 * from a mutation that quietly did nothing.
 */
export const ASK_FEATURE_DISABLED_MESSAGE =
  "The ask feature is disabled on this appliance (feature flag 'ask' is off) — nothing was refused, nothing ran.";

/** Turn `{ success: false }` into a CliError naming the one thing it can mean, rather than a payload with everything null. */
export function requireSuccess<T extends { success: boolean }>(payload: T): T {
  if (!payload.success) {
    throw new CliError(ASK_FEATURE_DISABLED_MESSAGE, 2);
  }

  return payload;
}

/**
 * Resolve `<granteeHandleOrUserId>` into exactly one of `createAskGrant`'s two
 * grantee kinds — never both, never neither, which is what
 * `ask_grants_grantee_chk` (and the resolver's own 400) requires and what a raw
 * GraphQL caller has to get right by hand.
 *
 * A peer's `peerHandle` (as `peers list` shows it) is checked first; anything
 * that matches none of the caller's peer links is passed through as a raw
 * `granteeId` — a household member's opaque user id, which has no
 * more-memorable form on this surface today.
 */
export async function resolveGrantee(
  ctx: CliContext,
  value: string,
): Promise<{ granteeId?: string; granteePeerLinkId?: string }> {
  const links = await ctx.graphql.myPeerLinks();
  const match = links.find((link) => link.peerHandle === value);

  return match ? { granteePeerLinkId: match.id } : { granteeId: value };
}

/** A prompt or summary, shortened for a table cell — the full text is `--json`'s job. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A grant's grantee, printed the same way `resolveGrantee` reads one back in. */
export function describeGrantee(grant: Pick<AskGrantSummary, 'granteeId' | 'granteePeerLinkId'>): string {
  return grant.granteeId != null ? `user:${grant.granteeId}` : `peer-link:${grant.granteePeerLinkId}`;
}
