import type { CliContext } from '../../context';
import { json } from '../../output';
import { requireSuccess } from '../memoryShared';

export interface AsksDeclineOptions {
  json?: boolean;
}

/** Decline an ask under review. Terminal — a declined ask cannot later be answered. */
export async function asksDeclineCommand(
  ctx: CliContext,
  id: string,
  options: AsksDeclineOptions = {},
): Promise<void> {
  const { ask } = requireSuccess(await ctx.graphql.declineAsk(id));

  if (options.json) {
    json(ctx.term, ask);

    return;
  }

  ctx.term.out(`Declined ${ask?.id}.`);
}
