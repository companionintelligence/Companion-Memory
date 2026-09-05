import { CliError, type CliContext } from '../../context';
import { json } from '../../output';
import { requireSuccess } from '../memoryShared';

export interface AsksSendOptions {
  queryType?: string;
  dataClass?: string;
  json?: boolean;
}

/**
 * Submit a LOCAL ask — `createAsk`'s `responderId` names another account ON
 * THIS BOX (Phase 0, intra-household; epic #1712). If the owner has a standing
 * `auto` grant covering it, the answer comes back already produced
 * (`decision`/`status` moves straight to `answered`) — see `AskResolver.createAsk`.
 *
 * For a linked peer's OWN appliance, use `asks send-peer` instead: that is the
 * federated protocol (`sendPeerAsk`), a different mutation with a different
 * shape (it needs a Portal-issued access token this box never mints).
 */
export async function asksSendCommand(
  ctx: CliContext,
  responderId: string,
  prompt: string,
  options: AsksSendOptions = {},
): Promise<void> {
  if (options.queryType == null) {
    throw new CliError(
      '--query-type is required: one of relationship, content, availability, attribute, identity.',
    );
  }

  const { ask, decision } = requireSuccess(
    await ctx.graphql.createAsk({
      responderId,
      query: { queryType: options.queryType, prompt, dataClass: options.dataClass },
    }),
  );

  if (options.json) {
    json(ctx.term, { ask, decision });

    return;
  }

  ctx.term.out(`Sent ${ask?.id} to ${responderId} — ${ask?.status}.`);
}
