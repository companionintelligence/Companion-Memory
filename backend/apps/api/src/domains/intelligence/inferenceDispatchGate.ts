/**
 * Whether ONE owner may be sent another answer-inference job right now.
 *
 * Both inference selectors — `QuestionService.findUnansweredByUserId`
 * (AnswerInferenceCron) and the smart-rotation `answer_infer` work, through
 * `QuestionService.isInferenceDispatchOpen` — take this one definition, for
 * the same reason they take one rotation order from questionOrder.ts: two
 * copies of a gate drift, and the looser one decides.
 *
 * ═══ WHAT IT ASKS ═══
 *
 * Two things, both read from pg-boss's own rows (the attempt history the
 * selectors already use — no new table):
 *
 *   1. Is a job for this owner still OUTSTANDING — `created`, `retry`, or
 *      `active` inside its lease? Then nothing more is sent until it settles.
 *      This is the cap that was missing. The cron used to send one job a minute
 *      per owner whatever the queue held. On core-1 (2026-10-17) that was
 *      four owners, 240 jobs an hour, against one `ollama-background` slot that
 *      could not keep up: the queue fell ~4 h behind with 941 waiting — each a
 *      different question, because a waiting job counts as an attempt and
 *      pushes the selector onto the next one. With this, a queue that is
 *      saturated or stalled holds at most one waiting job per owner, so the
 *      dispatch rate can never outrun what the GPU actually finishes.
 *
 *   2. Was one CREATED for this owner within the interval
 *      (`llm.answerInferenceIntervalMinutes`)? Then not yet. This is the
 *      cadence, and it is per owner, not per tick: the cron still wakes every
 *      minute, but an owner is only dispatched to once per interval, so how
 *      often the clock runs no longer decides how often the GPU does.
 *
 * ═══ WHY AN EXPIRED LEASE DOES NOT COUNT ═══
 *
 * An `active` row past `started_on + expire_in` is one pg-boss should already
 * have expired. Counting it would let one stuck row silence that owner's
 * inference for good, with nothing in the log to say why. Not counting it lets
 * one fresh job through, which then waits `created` — and (1) holds from
 * there. So the worst case on a stuck queue is still one waiting job per
 * owner, and the owner resumes on their own once the queue does.
 *
 * Owner ids live in the job payload as text (`data->>'ownerId'`), so
 * `ownerText` must be a text-typed SQL expression. Qualify it: pgboss.job has
 * its own `id`, so a bare `id` inside these subqueries is the JOB's id.
 */
export function inferenceDispatchOpenSql(params: {
  /** Text-typed SQL expression for the owner, e.g. `usr.id::text` or `$5`. */
  ownerText: string;
  /** Placeholder for the pg-boss queue the inference is dispatched on. */
  queue: string;
  /** Placeholder for the event name carried in `data->>'name'`. */
  eventName: string;
  /** Placeholder for the minimum interval, in whole minutes. */
  intervalMinutes: string;
}): string {
  const { ownerText, queue, eventName, intervalMinutes } = params;

  return `
    NOT EXISTS (
      SELECT 1
      FROM pgboss.job pending
      WHERE pending.name = ${queue}
        AND pending.data->>'name' = ${eventName}
        AND pending.data->>'ownerId' = ${ownerText}
        AND (
          pending.state IN ('created', 'retry')
          OR (pending.state = 'active' AND pending.started_on + pending.expire_in > NOW())
          OR pending.created_on > NOW() - make_interval(mins => ${intervalMinutes})
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pgboss.archive settled
      WHERE settled.name = ${queue}
        AND settled.data->>'name' = ${eventName}
        AND settled.data->>'ownerId' = ${ownerText}
        AND settled.created_on > NOW() - make_interval(mins => ${intervalMinutes})
    )
  `;
}
