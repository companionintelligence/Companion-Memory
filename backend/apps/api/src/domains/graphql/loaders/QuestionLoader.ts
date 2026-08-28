import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Question, QuestionService } from '@ci/domains/intelligence';

import { Loader } from './Loader';

@Injectable()
export class QuestionLoader extends Loader<Question | null, string> {
  constructor(
    private readonly questionService: QuestionService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(QuestionLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    questionIds: readonly string[],
  ): Promise<readonly (Question | null)[]> {
    // `QuestionService.findByIds` is an `IN (...)` lookup that returns the set of
    // questions this caller can see — in the planner's order, and short by one
    // for every id that is missing or private to somebody else. It is the only
    // findByIds behind a loader here that does not already re-key (EventService,
    // PlaceService, ContentService and ThreadService all do), and DataLoader
    // pairs results with keys by POSITION, so passing it through captioned each
    // answer with a different answer's question — "I follow hockey." under "What
    // city were you born in?" — silently, and only once a page held more than one.
    const questions = await this.questionService.findByIds(context, [...questionIds]);
    const byId = new Map(questions.map((question) => [question.id, question]));

    return questionIds.map((questionId) => byId.get(questionId) ?? null);
  }
}
