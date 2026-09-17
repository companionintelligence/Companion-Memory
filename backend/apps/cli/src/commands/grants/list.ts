import type { CliContext } from '../../context';
import type { AskGrantSummary } from '../../graphqlClient';
import { json, stamp, table } from '../../output';
import { describeGrantee } from '../memoryShared';

export interface GrantsListOptions {
  json?: boolean;
}

/** Standing grants owned by the caller — the Grant Manager's matrix, active grants only. Lapsed and revoked ones are `grants history`'s job. */
export async function grantsListCommand(ctx: CliContext, options: GrantsListOptions = {}): Promise<void> {
  const grants = await ctx.graphql.myAskGrants();

  if (options.json) {
    json(ctx.term, grants);

    return;
  }

  ctx.term.out(
    table(
      grants,
      [
        { header: 'id', value: (grant: AskGrantSummary) => grant.id },
        { header: 'grantee', value: (grant) => describeGrantee(grant) },
        { header: 'queryType', value: (grant) => grant.queryType },
        { header: 'class', value: (grant) => grant.dataClass ?? '' },
        { header: 'mode', value: (grant) => grant.mode },
        { header: 'uses', value: (grant) => String(grant.useCount), align: 'right' },
        { header: 'expires', value: (grant) => (grant.expiresAt ? stamp(grant.expiresAt) : '') },
      ],
      'No standing grants — `ci grants create <granteeHandleOrUserId> <queryType>`.',
    ),
  );
}
