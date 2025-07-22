import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { LLMModule } from '@ci/domains/llm';
import { EmbeddingModule } from '@ci/domains/search';

import { AnswersController } from './controllers/AnswersController';
import { QuestionsController } from './controllers/QuestionsController';
import { AnswerEntity } from './entities/AnswerEntity';
import { QuestionEntity } from './entities/QuestionEntity';
import { AnswerService } from './services/AnswerService';
import { QuestionService } from './services/QuestionService';

@Module({
  imports: [
    TypeOrmModule.forFeature([AnswerEntity, QuestionEntity]),
    EventsModule,
    LLMModule,
    EmbeddingModule,
  ],
  providers: [AnswerService, QuestionService],
  controllers: [AnswersController, QuestionsController],
  exports: [AnswerService, QuestionService],
})
export class IntelligenceModule {}

// Entities
export { AnswerEntity, QuestionEntity };

// Services
export { AnswerService, QuestionService };

// Types
export type { Answer, Question } from './types';
