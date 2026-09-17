import type { CliContext } from '../../context';
import type { AskSummary } from '../../graphqlClient';
import { json, stamp, table } from '../../output';
import { truncate } from '../memoryShared';

export interface AsksOutboxOptions {
  json?: boolean;
}

/** The asker's outbox — asks this caller has sent, local and federated alike. */
export async function asksOutboxCommand(ctx: CliContext, options: AsksOutboxOptions = {}): Promise<void> {
  const asks = await ctx.graphql.askOutbox();

  if (options.json) {
    json(ctx.term, asks);

    return;
  }

  ctx.term.out(
    table(
      asks,
      [
        { header: 'id', value: (ask: AskSummary) => ask.id },
        { header: 'to', value: (ask) => ask.peerHandle ?? ask.responderId ?? '' },
        { header: 'type', value: (ask) => ask.query.queryType },
        { header: 'status', value: (ask) => ask.status },
        { header: 'prompt', value: (ask) => truncate(ask.query.prompt, 50) },
        { header: 'sent', value: (ask) => stamp(ask.createdAt) },
      ],
      'Nothing sent yet.',
    ),
  );
}
