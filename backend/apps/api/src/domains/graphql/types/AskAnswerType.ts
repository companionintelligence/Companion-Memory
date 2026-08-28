import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import type { AskAnswer, DisclosedItem } from '@ci/domains/asks';
import { countFreeSummary, formDisclosesItems } from '@ci/domains/asks';

import { GlobalUID } from './GlobalUID';

export enum AnswerFormEnum {
  boolean = 'boolean',
  existence = 'existence',
  attribute = 'attribute',
  retrieval = 'retrieval',
  identity = 'identity',
}
registerEnumType(AnswerFormEnum, { name: 'AnswerForm' });

export enum AnswerSourceEnum {
  self = 'self',
  peer = 'peer',
}
registerEnumType(AnswerSourceEnum, { name: 'AnswerSource' });

/** A disclosed entity reference — id + type only, never raw content. */
@ObjectType()
export class DisclosedItemType {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  type!: string;

  static toType(item: DisclosedItem): DisclosedItemType {
    return { id: item.id, type: item.type };
  }
}

/**
 * The disclosure-filtered answer produced for an ask. Carries item references,
 * counts, form, and a templated summary — never raw node content or signed URLs.
 */
@ObjectType()
export class AskAnswerType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  askId!: string;

  @Field(() => AnswerFormEnum)
  form!: AnswerFormEnum;

  @Field(() => AnswerSourceEnum)
  answerSource!: AnswerSourceEnum;

  @Field(() => String, { nullable: true })
  summary!: string | null;

  /** Item references — populated for the `retrieval` form only. */
  @Field(() => [DisclosedItemType])
  items!: DisclosedItemType[];

  @Field(() => Int)
  disclosedCount!: number;

  /** Matched items the owner withheld ("deny all but X") — count only. */
  @Field(() => Int)
  withheldCount!: number;

  @Field(() => String, { nullable: true })
  consentBasis!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  /**
   * `isResponder` decides whether the exact magnitudes and the consent basis are
   * included.
   *
   * A form that does not itemize must not ship a count to the ASKER. A `boolean`
   * answer returning `disclosedCount: 9` beside "They confirmed a match" hands
   * over a precise magnitude — and by varying the prompt, a count ORACLE over the
   * responder's corpus — while every ask stays labelled a mere yes/no. The
   * withheld count goes with it: how much the owner chose to hide is as much of a
   * signal as how much they shared.
   *
   * The owner sees the true numbers, because "you shared 4 of 6" is their
   * receipt, and the stored record keeps them because the audit is written from
   * it. Only the projection to the asker is narrowed — and an omitted argument
   * gets the narrow one, so a caller that forgets cannot leak.
   *
   * TWO THINGS THE FIRST PASS AT THIS MISSED, both because they leave by a
   * different door than `disclosedCount`:
   *
   * - The SUMMARY embeds the same count in prose. Zeroing the numeric field
   *   while passing "3 matching items." straight through did not remove the
   *   oracle, it relocated it. The asker gets {@link countFreeSummary} instead.
   * - The ITEMS were emitted unconditionally. The stored row should already be
   *   empty for a non-itemizing form, but "should already" is not an invariant
   *   this layer can check — a `boolean` row with entity references in it would
   *   have shipped them, under a form the asker was told answers yes/no. Gating
   *   on the form makes it structurally impossible instead of merely unlikely.
   */
  static toType(answer: AskAnswer, isResponder = false): AskAnswerType {
    const itemizes = formDisclosesItems(answer.form);
    const showCounts = isResponder || itemizes;

    return {
      id: GlobalUID.encode('ask-answer', answer.id),
      askId: GlobalUID.encode('ask', answer.askId),
      form: answer.form as AnswerFormEnum,
      answerSource: answer.answerSource as AnswerSourceEnum,
      // A null summary stays null: the projection narrows what was said, it
      // does not invent an answer where the responder produced none.
      summary:
        showCounts || answer.summary == null
          ? answer.summary
          : countFreeSummary(answer.form, answer.disclosedCount > 0),
      items: itemizes ? answer.disclosedEntities.map(DisclosedItemType.toType) : [],
      disclosedCount: showCounts ? answer.disclosedCount : 0,
      withheldCount: showCounts ? answer.withheldCount : 0,
      consentBasis: isResponder ? answer.consentBasis : null,
      createdAt: answer.createdAt,
    };
  }
}
