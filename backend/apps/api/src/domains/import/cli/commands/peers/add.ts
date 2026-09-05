import type { CliContext } from '../../context';
import { json } from '../../output';
import { PEER_TRUST_TIERS, parseEnumFlag, type PeerTrustTierFlag } from '../memoryShared';

export interface PeersAddOptions {
  displayName?: string;
  tier?: string;
  json?: boolean;
}

/**
 * Link a peer Companion by hand.
 *
 * There is no directory lookup for `memoryEndpoint` to fill in for you —
 * `PeerLinkResolver`'s own docstring explains why: resolving a handle needs a
 * CI-Portal access token nothing in this request context holds, so "a manual
 * step" was the honest choice over "a lookup that pretends to verify an
 * identity it never checked." The operator supplies the endpoint directly.
 *
 * Defaults to `stranger`, the narrowest trust tier — the same default the
 * resolver itself falls back to, and for the same reason: adding a person to
 * the address book is not the same gesture as trusting them with anything.
 */
export async function peersAddCommand(
  ctx: CliContext,
  peerHandle: string,
  memoryEndpoint: string,
  options: PeersAddOptions = {},
): Promise<void> {
  const trustTier = parseEnumFlag<PeerTrustTierFlag>('--tier', options.tier, PEER_TRUST_TIERS);

  const { peerLink } = await ctx.graphql.createPeerLink({
    peerHandle,
    memoryEndpoint,
    displayName: options.displayName,
    trustTier,
  });

  if (options.json) {
    json(ctx.term, peerLink);

    return;
  }

  ctx.term.out(`Linked ${peerLink?.peerHandle} (${peerLink?.id}), tier ${peerLink?.trustTier}.`);
}
