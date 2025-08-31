import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { RequestContext } from '@ci/common/types';

import { QuestionEntity } from '../entities/QuestionEntity';
import type { Question } from '../types';
import { AnswerService } from './AnswerService';

@Injectable()
export class QuestionService {
  constructor(
    @InjectRepository(QuestionEntity)
    private readonly questionRepository: Repository<QuestionEntity>,
    private readonly answerService: AnswerService,
  ) {}

  async findAll(context: RequestContext): Promise<Question[]> {
    const result = await this.questionRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
      relations: ['user'],
    });

    return result.map((entity) => entity.toQuestion());
  }

  async findOne(context: RequestContext, id: string): Promise<Question | null> {
    // TODO: This is a footgun that we shouldn't leave here for long.
    //
    // What we're actually interested in doing is returning questions owned by the user in
    // addition to those that are unowned (user_id IS NULL). There isn't a clean way to
    // do this with the TypeORM query API, so we'd have to write raw SQL. Not inherently
    // a problem, but out of scope when this change was made.
    //
    // In the short term we're assuming that `findUnansweredByUserId` is sufficiently
    // secure and that no events are spawned manually that would undermine that security.
    const whereUser =
      context.userId == null
        ? {}
        : {
            user: {
              id: context.userId,
            },
          };

    const result = await this.questionRepository.findOne({
      where: {
        id,
        ...whereUser,
      },
      relations: ['user'],
    });

    return result?.toQuestion() ?? null;
  }

  async findUnansweredByUserId(): Promise<Map<string, string[]>> {
    // TODO: We need to refine how we're selecting "unanswered questions".
    //
    // This first cut gets the fundamentals roughly nailed down.
    //
    // OK, so what about multiple tenants on a server box? How do we make sure
    // that we're not choking out user answer processing because of a noisy neighbor?
    // We can consider querying for top 5 for every user.
    //
    // How do we achieve stability? It's likely the best answer we're going to get to
    // a question is a user-provided one. We might consider answers "stable" if they
    // have such an answer. We can offer users a way to correct LLM infererences.
    //
    // Otherwise how could we consider an answer good enough? It's possible we
    // could infer a second answer that would be worse than the first.
    //
    // Point being that there are rough edges here that we need to refine. But the
    // concept of "get me unaswered questions by user," can clearly live here.

    return this.answerService.findUnansweredQuestionsByUserId(5);
  }
}
