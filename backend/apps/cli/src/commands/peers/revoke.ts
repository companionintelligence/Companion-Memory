import type { CliContext } from '../../context';
import { json } from '../../output';

export interface PeersRevokeOptions {
  json?: boolean;
}

/**
 * Stop exchanging asks with a peer. Immediate and non-destructive: the link
 * row stays readable (`peers list` still shows it, as `revoked`) so the owner
 * can see the relationship existed, but the next inbound ask from that peer's
 * token fails to resolve a link before any policy runs.
 */
export async function peersRevokeCommand(
  ctx: CliContext,
  id: string,
  options: PeersRevokeOptions = {},
): Promise<void> {
  const { peerLink } = await ctx.graphql.revokePeerLink(id);

  if (options.json) {
    json(ctx.term, peerLink);

    return;
  }

  ctx.term.out(`Revoked ${peerLink?.peerHandle ?? id}.`);
}
