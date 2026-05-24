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
    return this.questionService.findByIds(context, [...questionIds]);
  }
}
