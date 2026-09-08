import type { CliContext } from '../../context';
import type { AskSummary } from '../../graphqlClient';
import { json, stamp, table } from '../../output';
import { truncate } from '../memoryShared';

export interface AsksInboxOptions {
  json?: boolean;
}

/**
 * The responder's review inbox — asks awaiting a decision.
 *
 * An empty inbox is ambiguous by construction: it means either "nothing is
 * waiting" or "the `ask` feature is disabled on this appliance", since
 * `askInbox` answers `[]` for both (see `AskResolver.enabled`). `grants list`
 * or `asks send` surface the disabled state explicitly (their mutations answer
 * `{ success: false }`); this query cannot.
 */
export async function asksInboxCommand(ctx: CliContext, options: AsksInboxOptions = {}): Promise<void> {
  const asks = await ctx.graphql.askInbox();

  if (options.json) {
    json(ctx.term, asks);

    return;
  }

  ctx.term.out(
    table(
      asks,
      [
        { header: 'id', value: (ask: AskSummary) => ask.id },
        { header: 'from', value: (ask) => ask.peerHandle ?? ask.askerId ?? '' },
        { header: 'type', value: (ask) => ask.query.queryType },
        { header: 'status', value: (ask) => ask.status },
        { header: 'prompt', value: (ask) => truncate(ask.query.prompt, 50) },
        { header: 'received', value: (ask) => stamp(ask.createdAt) },
      ],
      'Nothing waiting for review.',
    ),
  );
}
