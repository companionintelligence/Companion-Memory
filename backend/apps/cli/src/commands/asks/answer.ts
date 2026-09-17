import type { CliContext } from '../../context';
import { csv, json } from '../../output';
import { ANSWER_FORMS, type AnswerFormFlag, parseEnumFlag, requireSuccess } from '../memoryShared';

export interface AsksAnswerOptions {
  redact?: string;
  disclosureForm?: string;
  json?: boolean;
}

/**
 * Run an answerable ask (owner-approved, or auto-authorized) as the
 * responder — `runAsk`, the mutation that actually produces a disclosure.
 *
 * `--redact` is the owner's "deny all but these" set: comma-separated entity
 * ids to withhold from an otherwise-disclosable answer (counted, never named,
 * to the asker). `--disclosure-form` can only ever NARROW what the ask's
 * archetype already implies (`AskResolver.runAsk`'s own docstring, via
 * `narrowerForm`) — passing a wider one than the archetype allows is safe by
 * construction; the server clamps it rather than the CLI needing to.
 */
export async function asksAnswerCommand(
  ctx: CliContext,
  id: string,
  options: AsksAnswerOptions = {},
): Promise<void> {
  const disclosureForm = parseEnumFlag<AnswerFormFlag>(
    '--disclosure-form',
    options.disclosureForm,
    ANSWER_FORMS,
  );
  const redactItemIds = csv(options.redact);

  const { ask, answer, disclosedCount, withheldCount } = requireSuccess(
    await ctx.graphql.runAsk(id, { redactItemIds, disclosureForm }),
  );

  if (options.json) {
    json(ctx.term, { ask, answer, disclosedCount, withheldCount });

    return;
  }

  ctx.term.out(
    `Answered ${ask?.id ?? id} — disclosed ${disclosedCount ?? 0}, withheld ${withheldCount ?? 0}, ` +
      `form ${answer?.form ?? ''}.`,
  );

  if (answer?.summary) {
    ctx.term.out(answer.summary);
  }
}
