import { CliError, type CliContext } from '../../context';
import { json } from '../../output';

export interface AsksShowOptions {
  json?: boolean;
}

/**
 * One ask's detail, and its answer once there is one.
 *
 * `askAnswer` is only fetched when `status === 'answered'` — the query itself
 * enforces this (it returns null for any other status, since an answer row
 * can exist for an ask that never reached a terminal state), so skipping the
 * call otherwise saves a round trip that would come back empty anyway.
 */
export async function asksShowCommand(
  ctx: CliContext,
  id: string,
  options: AsksShowOptions = {},
): Promise<void> {
  const ask = await ctx.graphql.ask(id);

  if (ask == null) {
    throw new CliError(`Ask ${id} not found (or the ask feature is disabled on this appliance).`);
  }

  const answer = ask.status === 'answered' ? await ctx.graphql.askAnswer(id) : null;

  if (options.json) {
    json(ctx.term, { ask, answer });

    return;
  }

  ctx.term.out(`${ask.id}  ${ask.direction}  ${ask.status}`);
  ctx.term.out(`with     ${ask.peerHandle ?? ask.askerId ?? ask.responderId ?? ''}`);
  ctx.term.out(`query    ${ask.query.queryType}${ask.query.dataClass ? ` (${ask.query.dataClass})` : ''}`);
  ctx.term.out(`prompt   ${ask.query.prompt}`);

  if (ask.consentBasis) {
    ctx.term.out(`basis    ${ask.consentBasis}`);
  }

  if (answer != null) {
    ctx.term.out('');
    ctx.term.out(`answer    ${answer.summary ?? '(no summary)'}`);
    ctx.term.out(`disclosed ${answer.disclosedCount}  withheld ${answer.withheldCount}  form ${answer.form}`);
  }
}
