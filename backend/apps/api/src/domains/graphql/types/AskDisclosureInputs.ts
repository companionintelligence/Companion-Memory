import { Field, InputType, Int } from '@nestjs/graphql';

/**
 * Narrowing for a disclosure-history read.
 *
 * Every field is optional and only ever RESTRICTS — the same contract
 * `AskGrantScope` holds on the consent side, and for the same reason: a filter
 * that could widen a read is a filter that can be used to widen a read.
 *
 * The read is responder-scoped in the service (`listForResponder`), so nothing
 * here can reach another owner's rows. These narrow within the caller's own.
 */
@InputType()
export class AskDisclosureHistoryInput {
  /**
   * One counterparty, as the key from `AskDisclosureSummaryType.key`.
   *
   * A KEY rather than a raw id: the two id columns are mutually exclusive on a
   * row, and letting a client send both would ask the server to decide which
   * one it meant. The key carries that decision already.
   */
  @Field(() => String, { nullable: true })
  counterpartyKey?: string;

  /** Inclusive lower bound on `createdAt`. */
  @Field(() => Date, { nullable: true })
  from?: Date;

  /** Inclusive upper bound on `createdAt`. */
  @Field(() => Date, { nullable: true })
  to?: Date;

  /**
   * Terminal outcomes to include. Omitted means all of them — including
   * `declined`, which belongs in a disclosure history precisely because the
   * gate working is a fact about your data worth keeping.
   */
  @Field(() => [String], { nullable: true })
  outcomes?: string[];

  /** Clamped server-side to `MAX_AUDIT_ROWS`; an unreadable value takes the max. */
  @Field(() => Int, { nullable: true })
  limit?: number;
}

@InputType()
export class AskDisclosureSummaryInput {
  /**
   * The recency window, in days. Defaults to 30 — a month is the unit people
   * reason about consent in.
   */
  @Field(() => Int, { nullable: true })
  windowDays?: number;
}
