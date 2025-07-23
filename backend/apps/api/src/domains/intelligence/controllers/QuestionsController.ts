import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import { EventService, Events, EventPayloads, OnEvent } from '@ci/domains/events';
import { OllamaService } from '@ci/domains/llm';
import { EmbeddingService } from '@ci/domains/search';

import { AnswerService } from '../services/AnswerService';
import { QuestionService } from '../services/QuestionService';

@Controller('questions')
export class QuestionsController {
  private logger = new LoggerService(QuestionsController.name);

  constructor(
    private readonly answerService: AnswerService,
    private readonly embeddingService: EmbeddingService,
    private readonly eventService: EventService,
    private readonly ollamaService: OllamaService,
    private readonly questionService: QuestionService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Context() context: RequestContext) {
    return this.questionService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Context() context: RequestContext, @Param('id') id: string) {
    return this.questionService.findOne(context, id);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async cronProcessQuestions() {
    this.logger.log('Processing question answer inference cron');

    const unansweredQuestions = await this.questionService.findUnansweredByUserId();

    for (const [userId, questionIds] of unansweredQuestions) {
      for (const questionId of questionIds) {
        this.eventService.send(Events.INFER_QUESTION_ANSWER, {
          ownerId: userId,
          questionId: questionId,
        });
      }
    }
  }

  @OnEvent(Events.INFER_QUESTION_ANSWER)
  async inferQuestionAnswer(payload: EventPayloads[Events.INFER_QUESTION_ANSWER]) {
    const context: RequestContext = {
      userId: payload.ownerId,
    };

    this.logger.log('Inferring answer to question', {
      userId: payload.ownerId,
      questionId: payload.questionId,
    });

    const question = await this.questionService.findOne({}, payload.questionId);

    if (question) {
      const associatedAnswers = await this.embeddingService.findNearest(context, question.text, 'answer', 10);

      const resolvedAnswers = await this.answerService.findSome(
        context,
        associatedAnswers.map((embedding) => embedding.id),
      );

      const ragThread = [
        {
          prompt: true,
          text: `
            I am going to provide you a question that I would ask a user directly.
            I am also going to provide you a list of questions and answers the user has already provided that I consider related context.
            I want you to impersonate the user and infer an answer for the question I provide.
            That is to say your answer should be in the first person as if you were the user.
            You are impersonating a human being, so you must not reveal that you're a machine in any way.

            Please keep the answer short (within 2 to 3 sentences).
            You MUST ONLY return your inferred answer with no additional text.
            You MUST NOT indicate that the answer is inferred.
            Your answer MUST NOT include filler words like "honestly." We are assuming you're being honest.
            Your answer MUST NOT compliment the question in any way. Stick straight to the answer.
          `,
        },
        {
          prompt: true,
          text: 'The next message will be a list of related questions that the user has responded to.',
        },
        {
          prompt: true,
          text: resolvedAnswers
            .map(
              (answer) => `
            Question: ${answer.question?.text}
            Answer: ${answer.answer}
          `,
            )
            .join('\n\n'),
        },
        {
          prompt: true,
          text: 'The next message will be the question I need you to generate an inferred answer for while impersonating the user.',
        },
        {
          prompt: true,
          text: question.text,
        },
      ];

      // TODO: How can we improve the RAG thread?
      //
      // I was thinking we could include related questions as a start?
      // We should consider cleaning up the ergonomics of embeddingService too though. Holy shit this is dirty.
      //
      // const associatedQuestions = await this.embeddingService.findNearest({}, question.text, 'question', 5);

      const llmResponse = await this.ollamaService.chat({}, ragThread);

      this.logger.log('Inferred answer to question', {
        userId: payload.ownerId,
        questionId: payload.questionId,
        question: question.text,
        response: llmResponse.message.content,
      });

      const userAnswer = await this.answerService.findByQuestionId(context, payload.questionId);

      if (userAnswer) {
        this.logger.log('Answer exists, updating existing with RAG response');

        await this.answerService.update(context, userAnswer.id, {
          rag_answer_1: llmResponse.message.content,
        });
      } else {
        this.logger.log('Answer does not exist, creating a new one with a RAG response');
      }
    }
  }
}
