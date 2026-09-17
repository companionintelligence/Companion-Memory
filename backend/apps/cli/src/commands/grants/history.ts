import type { CliContext } from '../../context';
import type { AskGrantSummary } from '../../graphqlClient';
import { json, table } from '../../output';

export interface GrantsHistoryOptions {
  json?: boolean;
}

/**
 * Every grant this owner has ever written — active, revoked and superseded —
 * newest first.
 *
 * `myAskGrantHistory` takes NO id: it is the caller's whole ledger, not one
 * grant's log, because a "change" (`grants update`) writes an entirely new row
 * rather than editing in place — see `GrantService.supersede`. Passing `[id]`
 * here narrows to that one grant's OWN chain (itself, plus whatever it
 * superseded, plus whatever superseded it) by walking `supersedesGrantId`
 * client-side; there is no server-side "just this chain" filter to call
 * instead, so this is the CLI doing a bit of work the schema does not.
 */
export async function grantsHistoryCommand(
  ctx: CliContext,
  id: string | undefined,
  options: GrantsHistoryOptions = {},
): Promise<void> {
  const all = await ctx.graphql.myAskGrantHistory();
  const rows = id == null ? all : chainOf(all, id);

  if (options.json) {
    json(ctx.term, rows);

    return;
  }

  ctx.term.out(
    table(
      rows,
      [
        { header: 'id', value: (grant: AskGrantSummary) => grant.id },
        { header: 'v', value: (grant) => String(grant.version), align: 'right' },
        { header: 'mode', value: (grant) => grant.mode },
        { header: 'active', value: (grant) => (grant.active ? 'yes' : 'no') },
        { header: 'reason', value: (grant) => grant.revocationReason ?? '' },
        { header: 'supersedes', value: (grant) => grant.supersedesGrantId ?? '' },
      ],
      id == null ? 'No grants have ever been written.' : `No history found for grant ${id}.`,
    ),
  );
}

function chainOf(all: readonly AskGrantSummary[], id: string): AskGrantSummary[] {
  const byId = new Map(all.map((grant) => [grant.id, grant]));

  if (!byId.has(id)) {
    return [];
  }

  const chain = new Set<string>([id]);

  // Walk backward through what this grant superseded…
  let cursor = byId.get(id);
  while (cursor?.supersedesGrantId != null && !chain.has(cursor.supersedesGrantId)) {
    chain.add(cursor.supersedesGrantId);
    cursor = byId.get(cursor.supersedesGrantId);
  }

  // …and forward through whatever superseded it, one link at a time.
  let next = all.find(
    (grant) => grant.supersedesGrantId != null && chain.has(grant.supersedesGrantId) && !chain.has(grant.id),
  );
  while (next != null) {
    chain.add(next.id);
    next = all.find(
      (grant) =>
        grant.supersedesGrantId != null && chain.has(grant.supersedesGrantId) && !chain.has(grant.id),
    );
  }

  return all.filter((grant) => chain.has(grant.id));
}
