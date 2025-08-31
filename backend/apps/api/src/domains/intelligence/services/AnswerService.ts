import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import type { RequestContext } from '@ci/common/types';

import { AnswerEntity } from '../entities/AnswerEntity';
import type { Answer, UpdateAnswerDto } from '../types';

@Injectable()
export class AnswerService {
  constructor(
    @InjectRepository(AnswerEntity)
    private readonly answerRepository: Repository<AnswerEntity>,
  ) {}

  async findAll(context: RequestContext): Promise<Answer[]> {
    const result = await this.answerRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
      relations: ['user', 'question'],
    });

    return result.map((entity) => entity.toAnswer());
  }

  async findSome(context: RequestContext, ids: string[]): Promise<Answer[]> {
    if (ids.length === 0) {
      return [];
    }

    const result = await this.answerRepository.find({
      where: {
        user: {
          id: context.userId,
        },
        id: In(ids),
      },
      relations: ['user', 'question'],
    });

    return result.map((entity) => entity.toAnswer());
  }

  async findOne(context: RequestContext, id: string): Promise<Answer | null> {
    const result = await this.answerRepository.findOne({
      where: {
        user: {
          id: context.userId,
        },
        id,
      },
      relations: ['user', 'question'],
    });

    return result?.toAnswer() ?? null;
  }

  async findByQuestionId(context: RequestContext, questionId: string): Promise<Answer | null> {
    const result = await this.answerRepository.findOne({
      where: {
        user: {
          id: context.userId,
        },
        question: {
          id: questionId,
        },
      },
      relations: ['user', 'question'],
    });

    return result?.toAnswer() ?? null;
  }

  async update(context: RequestContext, id: string, data: UpdateAnswerDto): Promise<boolean> {
    const result = await this.answerRepository.update(
      {
        id,
        user: {
          id: context.userId,
        },
      },
      data,
    );

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return true;
  }

  /**
   * Find unanswered questions grouped by user ID.
   * Used by services that need to identify questions requiring answers.
   */
  async findUnansweredQuestionsByUserId(limit = 5): Promise<Map<string, string[]>> {
    type Row = {
      id: string;
      user_id: string;
    };

    const rows = (await this.answerRepository.query(`
      SELECT
        questions.id as id,
        answers.user_id as user_id
      FROM
        questions
      LEFT JOIN answers ON answers.question_id = questions.id
      WHERE answers.rag_answer_1 IS NULL
      LIMIT $1;
    `, [limit])) satisfies Array<Row>;

    const groupedByUserId = new Map<string, string[]>();

    for (const row of rows) {
      const userId = row.user_id;

      if (!groupedByUserId.has(userId)) {
        groupedByUserId.set(userId, []);
      }

      groupedByUserId.get(userId)!.push(row.id);
    }

    return groupedByUserId;
  }

  /**
   * Find user preferences by subcategory (e.g., 'Food', 'Entertainment')
   * Used by LLM tools to get personalized recommendations.
   */
  async findPreferencesBySubcategory(subcategory: string): Promise<Array<{
    id: string;
    label: string;
    category?: string;
    subcategory?: string;
    userId: string;
    createdAt: Date;
    question?: string;
    answer?: string;
  }>> {
    const result = await this.answerRepository.query(`
      SELECT 
        q.text as question,
        a.give_answer_1 as answer,
        q.category,
        q.subcategory,
        a.user_id as "userId",
        q.created_at as "createdAt"
      FROM questions q
      JOIN answers a ON q.id = a.question_id  
      WHERE q.subcategory = $1
        AND a.give_answer_1 IS NOT NULL
      ORDER BY q.created_at
    `, [subcategory]);

    return result.map((row: any) => ({
      id: `${row.userId}-${row.createdAt.getTime()}`, // Generate a unique ID
      label: `${row.question}: ${row.answer}`,
      category: row.category,
      subcategory: row.subcategory,
      userId: row.userId,
      createdAt: row.createdAt,
      question: row.question,
      answer: row.answer,
    }));
  }
}
