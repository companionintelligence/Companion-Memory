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
    // `QuestionService.findByIds` used to hand back the SET of questions this
    // caller can see — planner order, and short by one for every id that is
    // missing or private to somebody else. DataLoader pairs results with keys
    // by POSITION, so passing that through captioned each answer with a
    // different answer's question — "I follow hockey." under "What city were
    // you born in?" — silently, and only once a page held more than one.
    const questions = await this.questionService.findByIds(context, [...questionIds]);

    return this.rekey(questionIds, questions, (question) => question.id);
  }
}
