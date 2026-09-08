import type { CliContext } from '../../context';
import { json } from '../../output';
import { requireSuccess } from '../memoryShared';

export interface GrantsRevokeOptions {
  json?: boolean;
}

/** Revoke a standing grant. Retroactive: an ask pre-authorized by this grant loses that authorization immediately, even if it has not been answered yet. */
export async function grantsRevokeCommand(
  ctx: CliContext,
  id: string,
  options: GrantsRevokeOptions = {},
): Promise<void> {
  const { grant } = requireSuccess(await ctx.graphql.revokeAskGrant(id));

  if (options.json) {
    json(ctx.term, grant);

    return;
  }

  ctx.term.out(`Revoked grant ${grant?.id ?? id}.`);
}
