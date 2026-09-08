import { CliError, type CliContext } from '../../context';
import { json } from '../../output';
import { PEER_TRUST_TIERS, parseEnumFlag, type PeerTrustTierFlag } from '../memoryShared';

export interface PeersUpdateOptions {
  displayName?: string;
  tier?: string;
  peerIssuer?: string;
  peerSubject?: string;
  json?: boolean;
}

/**
 * Change a linked peer's display name, trust tier, or the OIDC identity its
 * inbound asks are matched on. All optional, but one of them is the point.
 *
 * Omitting a field LEAVES IT ALONE — a rename must never silently unbind a
 * federated peer — so `--peer-issuer` and `--peer-subject` must be given
 * together on a link that is not already bound. The server enforces the same
 * pairing rule (`PeerLinkService.upsert`); refusing here just makes it a
 * terminal error rather than a round trip.
 */
export async function peersUpdateCommand(
  ctx: CliContext,
  id: string,
  options: PeersUpdateOptions = {},
): Promise<void> {
  const trustTier = parseEnumFlag<PeerTrustTierFlag>('--tier', options.tier, PEER_TRUST_TIERS);

  if ((options.peerIssuer == null) !== (options.peerSubject == null)) {
    throw new CliError('--peer-issuer and --peer-subject must be given together.');
  }

  if (
    trustTier == null &&
    options.displayName == null &&
    options.peerIssuer == null &&
    options.peerSubject == null
  ) {
    throw new CliError(
      'Nothing to update — pass --tier, --display-name and/or --peer-issuer with --peer-subject.',
    );
  }

  const { peerLink } = await ctx.graphql.updatePeerLink({
    id,
    displayName: options.displayName,
    trustTier,
    peerIssuer: options.peerIssuer,
    peerSubject: options.peerSubject,
  });

  if (options.json) {
    json(ctx.term, peerLink);

    return;
  }

  ctx.term.out(
    `Updated ${peerLink?.peerHandle} (${peerLink?.id}): tier ${peerLink?.trustTier}, ` +
      `name ${peerLink?.displayName ?? '(none)'}.`,
  );
}
