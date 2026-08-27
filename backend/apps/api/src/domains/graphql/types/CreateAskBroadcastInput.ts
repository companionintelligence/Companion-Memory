import { Field, ID, InputType } from '@nestjs/graphql';

import { MAX_BROADCAST_RECIPIENTS, MIN_BROADCAST_RECIPIENTS } from '@ci/domains/asks';

import { AskQueryInput } from './AskInputs';

@InputType()
export class CreateAskBroadcastInput {
  /**
   * Who to ask. Deduped, the asker removed, order preserved.
   *
   * Bounded to `MAX_BROADCAST_RECIPIENTS` in the service — an ABUSE control,
   * not a cost bound: every recipient is an ask in a HUMAN's review inbox, and
   * the per-asker rate limit counts requests, of which this is one.
   */
  @Field(() => [ID], {
    description: `${MIN_BROADCAST_RECIPIENTS}–${MAX_BROADCAST_RECIPIENTS} recipients.`,
  })
  responderIds!: string[];

  /** The question, asked once and stamped on every child ask. */
  @Field(() => AskQueryInput)
  query!: AskQueryInput;
}
