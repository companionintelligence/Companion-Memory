import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { LLMModule } from '@ci/domains/llm';
import { EmbeddingModule } from '@ci/domains/search';

import { ActionsController } from './controllers/ActionsController';
import { AnswersController } from './controllers/AnswersController';
import { QuestionsController } from './controllers/QuestionsController';
import { ActionEntity } from './entities/ActionEntity';
import { AnswerEntity } from './entities/AnswerEntity';
import { QuestionEntity } from './entities/QuestionEntity';
import { ActionService } from './services/ActionService';
import { AnswerService } from './services/AnswerService';
import { QuestionService } from './services/QuestionService';

@Module({
  imports: [
    TypeOrmModule.forFeature([ActionEntity, AnswerEntity, QuestionEntity]),
    EventsModule,
    LLMModule,
    EmbeddingModule,
  ],
  providers: [ActionService, AnswerService, QuestionService],
  controllers: [ActionsController, AnswersController, QuestionsController],
  exports: [AnswerService, QuestionService],
})
export class IntelligenceModule {}

// Entities
export { ActionEntity, AnswerEntity, QuestionEntity };

// Services
export { AnswerService, QuestionService };

// Types
export type { Answer, Question } from './types';
