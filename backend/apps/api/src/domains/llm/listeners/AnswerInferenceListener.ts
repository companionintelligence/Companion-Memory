import { Injectable } from '@nestjs/common';

import { type ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { Events, EventPayloads, OnEvent } from '@ci/domains/events';
import { Answer, AnswerService, QuestionService } from '@ci/domains/intelligence';

import { OllamaService, PROMPT_MODEL } from '../services/OllamaService';

@Injectable()
export class AnswerInferenceListener {
  constructor(
    private readonly answerService: AnswerService,
    private readonly questionService: QuestionService,
    private readonly ollamaService: OllamaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AnswerInferenceListener.name);
  }

  @OnEvent(Events.INFER_QUESTION_ANSWER)
  async inferQuestionAnswer(payload: EventPayloads[Events.INFER_QUESTION_ANSWER]) {
    this.logger.log('Inferring answer to question', {
      userId: payload.ownerId,
      questionId: payload.questionId,
    });

    const serviceContext = {
      userId: payload.ownerId ?? SYSTEM_USER,
    } as ServiceContext;

    const question = await this.questionService.findById(serviceContext, payload.questionId);

    if (question) {
      // const associatedAnswers = await this.embeddingService.findNearest(
      //   context,
      //   question.text,
      //   ['answer'],
      //   10,
      // );
      //
      // const resolvedAnswers = (
      //   await this.answerService.findByIds(
      //     serviceContext,
      //     associatedAnswers.map((embedding) => embedding.id),
      //   )
      // ).filter((answer) => answer != null);

      const resolvedAnswers: Answer[] = [];

      const ragThread = [
        {
          role: 'system',
          content: `
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
          role: 'system',
          content: 'The next message will be a list of related questions that the user has responded to.',
        },
        {
          role: 'system',
          content: resolvedAnswers
            .map(
              (answer) => `
            Question: ${answer.question?.text}
            Answer: ${answer.answer}
          `,
            )
            .join('\n\n'),
        },
        {
          role: 'system',
          content:
            'The next message will be the question I need you to generate an inferred answer for while impersonating the user.',
        },
        {
          role: 'system',
          content: question.text,
        },
      ];

      // TODO: How can we improve the RAG thread?
      //
      // I was thinking we could include related questions as a start?
      // We should consider cleaning up the ergonomics of embeddingService too though. Holy shit this is dirty.
      //
      // const associatedQuestions = await this.embeddingService.findNearest({}, question.text, 'question', 5);

      const llmResponse = await this.ollamaService.chat({}, ragThread, {
        model: PROMPT_MODEL,
      });

      this.logger.log('Inferred answer to question', {
        userId: payload.ownerId,
        questionId: payload.questionId,
        question: question.text,
        response: llmResponse.message.content,
      });

      const userAnswer = await this.answerService.findByQuestionId(serviceContext, payload.questionId);

      if (userAnswer) {
        this.logger.log('Answer exists, updating existing with RAG response');

        await this.answerService.update(serviceContext, userAnswer.id, {
          text: llmResponse.message.content,
        });
      } else {
        this.logger.log('Answer does not exist, creating a new one with a RAG response');
      }
    }
  }
}
