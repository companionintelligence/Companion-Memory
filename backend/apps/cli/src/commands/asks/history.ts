import { CliError, type CliContext } from '../../context';
import type { AskAuditSummary } from '../../graphqlClient';
import { csv, json, stamp, table } from '../../output';

export interface AsksHistoryOptions {
  counterparty?: string;
  outcome?: string;
  from?: string;
  to?: string;
  limit?: string;
  json?: boolean;
}

/** This responder's disclosure history — asks they answered, declined, or that expired, newest first. */
export async function asksHistoryCommand(ctx: CliContext, options: AsksHistoryOptions = {}): Promise<void> {
  const limit = options.limit == null ? undefined : Number(options.limit);

  if (limit != null && (options.limit?.trim() === '' || !Number.isInteger(limit) || limit < 1)) {
    throw new CliError(`--limit takes a whole number, at least 1, got "${options.limit}".`);
  }

  const { rows, truncated } = await ctx.graphql.askDisclosureHistory({
    counterpartyKey: options.counterparty,
    outcomes: csv(options.outcome),
    from: options.from,
    to: options.to,
    limit,
  });

  if (options.json) {
    json(ctx.term, { rows, truncated });

    return;
  }

  ctx.term.out(
    table(
      rows,
      [
        { header: 'when', value: (row: AskAuditSummary) => stamp(row.createdAt) },
        { header: 'with', value: (row) => row.peerHandle ?? row.askerId ?? '' },
        { header: 'type', value: (row) => row.query.queryType },
        { header: 'outcome', value: (row) => row.outcome },
        { header: 'disclosed', value: (row) => String(row.disclosedCount), align: 'right' },
        { header: 'basis', value: (row) => row.consentBasis ?? '' },
      ],
      'No disclosure history yet.',
    ),
  );

  if (truncated) {
    ctx.term.out('\n(truncated — narrow with --from/--to/--limit)');
  }
}
