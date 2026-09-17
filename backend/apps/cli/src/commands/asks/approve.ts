import type { CliContext } from '../../context';
import { json } from '../../output';
import { requireSuccess } from '../memoryShared';

export interface AsksApproveOptions {
  json?: boolean;
}

/** Approve an ask under review, without answering it yet — `asks answer` does that, separately. */
export async function asksApproveCommand(
  ctx: CliContext,
  id: string,
  options: AsksApproveOptions = {},
): Promise<void> {
  const { ask } = requireSuccess(await ctx.graphql.approveAsk(id));

  if (options.json) {
    json(ctx.term, ask);

    return;
  }

  ctx.term.out(`Approved ${ask?.id} — status ${ask?.status}.`);
}
