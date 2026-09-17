import type { CliContext } from '../../context';
import type { PeerLinkSummary } from '../../graphqlClient';
import { json, stamp, table } from '../../output';

export interface PeersListOptions {
  json?: boolean;
}

/**
 * Every peer this box knows, revoked ones included — `myPeerLinks` returns the
 * owner's whole relationship history rather than filtering, so a link the
 * owner revoked stays visible with `status revoked` and a `revokedAt` stamp
 * instead of disappearing. See `PeerLinkResolver.myPeerLinks`'s own docstring:
 * "who did I used to share with" is a question the owner is entitled to ask.
 */
export async function peersListCommand(ctx: CliContext, options: PeersListOptions = {}): Promise<void> {
  const links = await ctx.graphql.myPeerLinks();

  if (options.json) {
    json(ctx.term, links);

    return;
  }

  ctx.term.out(
    table(
      links,
      [
        { header: 'id', value: (link: PeerLinkSummary) => link.id },
        { header: 'handle', value: (link) => link.peerHandle },
        { header: 'name', value: (link) => link.displayName ?? '' },
        { header: 'tier', value: (link) => link.trustTier },
        { header: 'status', value: (link) => link.status },
        { header: 'endpoint', value: (link) => link.memoryEndpoint },
        { header: 'linked', value: (link) => stamp(link.createdAt) },
      ],
      'No peer links yet — `ci peers add <handle> <memoryEndpoint>`.',
    ),
  );
}
