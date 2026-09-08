import { CliError, type CliContext } from '../../context';
import { json } from '../../output';
import { PEER_TRUST_TIERS, parseEnumFlag, type PeerTrustTierFlag } from '../memoryShared';

export interface PeersAddOptions {
  displayName?: string;
  tier?: string;
  peerIssuer?: string;
  peerSubject?: string;
  json?: boolean;
}

/**
 * The two halves of the peer's OIDC identity travel together or not at all.
 *
 * `PeerLinkService.upsert` enforces the same rule server-side and is the real
 * boundary; this refusal exists so the operator finds out at the terminal
 * rather than after a round trip, and so `--peer-issuer` alone cannot look like
 * it worked. A link with only one half set can never match an inbound ask —
 * `findActiveByPeerIdentity` filters on both columns.
 */
function requirePairedIdentity(issuer: string | undefined, subject: string | undefined): void {
  if ((issuer == null) !== (subject == null)) {
    throw new CliError('--peer-issuer and --peer-subject must be given together.');
  }
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
 *
 * `--peer-issuer` / `--peer-subject` bind the link to the OIDC identity INBOUND
 * asks are matched on. Omit them and the link is outbound-only, which is what
 * every link created before this flag existed was — see
 * `docs/peer-federation.md`. They are write-only: `peers list` will not show
 * them back, because `PeerLinkType` deliberately never puts the pair on the
 * wire.
 */
export async function peersAddCommand(
  ctx: CliContext,
  peerHandle: string,
  memoryEndpoint: string,
  options: PeersAddOptions = {},
): Promise<void> {
  const trustTier = parseEnumFlag<PeerTrustTierFlag>('--tier', options.tier, PEER_TRUST_TIERS);

  requirePairedIdentity(options.peerIssuer, options.peerSubject);

  const { peerLink } = await ctx.graphql.createPeerLink({
    peerHandle,
    memoryEndpoint,
    displayName: options.displayName,
    trustTier,
    peerIssuer: options.peerIssuer,
    peerSubject: options.peerSubject,
  });

  if (options.json) {
    json(ctx.term, peerLink);

    return;
  }

  ctx.term.out(`Linked ${peerLink?.peerHandle} (${peerLink?.id}), tier ${peerLink?.trustTier}.`);
}
