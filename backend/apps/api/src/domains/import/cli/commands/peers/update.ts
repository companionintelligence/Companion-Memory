import { CliError, type CliContext } from '../../context';
import { json } from '../../output';
import { PEER_TRUST_TIERS, parseEnumFlag, type PeerTrustTierFlag } from '../memoryShared';

export interface PeersUpdateOptions {
  displayName?: string;
  tier?: string;
  json?: boolean;
}

/** Change a linked peer's display name or trust tier. Both are optional, but one of them is the point. */
export async function peersUpdateCommand(
  ctx: CliContext,
  id: string,
  options: PeersUpdateOptions = {},
): Promise<void> {
  const trustTier = parseEnumFlag<PeerTrustTierFlag>('--tier', options.tier, PEER_TRUST_TIERS);

  if (trustTier == null && options.displayName == null) {
    throw new CliError('Nothing to update — pass --tier and/or --display-name.');
  }

  const { peerLink } = await ctx.graphql.updatePeerLink({ id, displayName: options.displayName, trustTier });

  if (options.json) {
    json(ctx.term, peerLink);

    return;
  }

  ctx.term.out(
    `Updated ${peerLink?.peerHandle} (${peerLink?.id}): tier ${peerLink?.trustTier}, ` +
      `name ${peerLink?.displayName ?? '(none)'}.`,
  );
}
