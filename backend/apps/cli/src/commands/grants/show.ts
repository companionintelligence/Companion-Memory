import { CliError, type CliContext } from '../../context';
import { json } from '../../output';
import { describeGrantee } from '../memoryShared';

export interface GrantsShowOptions {
  json?: boolean;
}

/**
 * One grant's full detail — a convenience wrapping `askGrant(id)`, which
 * `myAskGrants` (list-only) never exposed a CLI path to on its own before now.
 */
export async function grantsShowCommand(
  ctx: CliContext,
  id: string,
  options: GrantsShowOptions = {},
): Promise<void> {
  const grant = await ctx.graphql.askGrant(id);

  if (grant == null) {
    throw new CliError(`Grant ${id} not found (or the ask feature is disabled on this appliance).`);
  }

  if (options.json) {
    json(ctx.term, grant);

    return;
  }

  ctx.term.out(`${grant.id}  v${grant.version}  ${grant.active ? 'active' : 'inactive'}`);
  ctx.term.out(`grantee   ${describeGrantee(grant)}`);
  ctx.term.out(`query     ${grant.queryType}${grant.dataClass ? ` (${grant.dataClass})` : ''}`);
  ctx.term.out(`mode      ${grant.mode}`);
  ctx.term.out(`uses      ${grant.useCount}${grant.lastUsedAt ? ` — last ${grant.lastUsedAt}` : ''}`);

  if (grant.purpose) {
    ctx.term.out(`purpose   ${grant.purpose}`);
  }

  if (grant.expiresAt) {
    ctx.term.out(`expires   ${grant.expiresAt}`);
  }

  if (grant.revokedAt) {
    ctx.term.out(
      `revoked   ${grant.revokedAt}${grant.revocationReason ? ` (${grant.revocationReason})` : ''}`,
    );
  }

  if (grant.supersedesGrantId) {
    ctx.term.out(`supersedes ${grant.supersedesGrantId}`);
  }
}
