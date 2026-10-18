/**
 * This module forms the core of the application's intelligence layer, responsible for
 * processing user questions, generating answers using the LLM, and managing related
 * actions. It orchestrates interactions between user input, the language model,
 * and the application's data.
 *
 * ### Key Components:
 * - **Q&A Flow (`QuestionService`, `AnswerService`)**: Manages the lifecycle of a user's
 *   query, from receiving a `Question` to generating and storing an `Answer`.
 * - **Action Management (`ActionService`)**: Handles the creation and execution of
 *   actions that may result from an answered question.
 * - **Entities (`QuestionEntity`, `AnswerEntity`, `ActionEntity`)**: Define the database
 *   schema for storing questions, answers, and actions.
 * - **Controllers (`QuestionsController`, `AnswersController`, `ActionsController`)**:
 *   Provide the REST API for clients to ask questions and interact with the intelligence system.
 * - **Module Integration**:
 *   - **`LLMModule`**: Leveraged to process natural language and generate intelligent answers.
 *   - **`EmbeddingModule`**: Used for semantic search and retrieving relevant context to
 *     inform the LLM's responses.
 *   - **`EventsModule`**: Integrated for handling asynchronous tasks related to the Q&A process.
 *
 * Persona × task compose lives in {@link PersonaModule} (`domains/persona`) so this
 * module stays free of Agent/Schedule import cycles.
 *
 * @module IntelligenceModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { ActionsController } from './controllers/ActionsController';
import { AnswersController } from './controllers/AnswersController';
import { QuestionsController } from './controllers/QuestionsController';
import { FeedQueueCron } from './cron/FeedQueueCron';
import { type Action, ActionEntity } from './entities/ActionEntity';
import { type Answer, AnswerEntity } from './entities/AnswerEntity';
import { type Question, QuestionEntity } from './entities/QuestionEntity';
import { ActionService } from './services/ActionService';
import { AnswerService } from './services/AnswerService';
import { QuestionService } from './services/QuestionService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([ActionEntity, AnswerEntity, QuestionEntity]), EventsModule],
  providers: [ActionService, AnswerService, QuestionService, FeedQueueCron],
  controllers: [ActionsController, AnswersController, QuestionsController],
  exports: [ActionService, AnswerService, QuestionService],
})
export class IntelligenceModule {}

// Entities
export { ActionEntity, AnswerEntity, QuestionEntity };

// Services
export { ActionService, AnswerService, QuestionService };

export type { Action, Answer, Question };

// Shared visibility rules for ci.questions
export { excludeForkedOriginsSql } from './questionScope';

// The one rotation order both inference selectors take ci.questions in
export { QUESTION_ROTATION_ORDER_SQL, QUESTION_ROTATION_RANK_SQL } from './questionOrder';

// The one per-owner backlog cap and cadence both inference selectors dispatch under
export { inferenceDispatchOpenSql } from './inferenceDispatchGate';

// Persisted retrieval provenance for an inferred answer (ci.answers.answer_evidence)
export type { AnswerEvidence, AnswerEvidenceCitation } from './types';

// What an answer's text may be, for the doors that do not run the REST schemas
export { answerTextSchema } from './types';
