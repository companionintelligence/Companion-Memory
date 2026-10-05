/**
 * Python function runner — the pg-boss replacement for Temporal.
 *
 * The NestJS API is the single scheduler: crons fan out per-user jobs onto
 * pg-boss queues, a dispatch listener POSTs each job to the target Python
 * service's `/functions/run` endpoint and defers pg-boss completion, and the
 * Python runner reports the outcome back through an authenticated webhook that
 * completes or fails the job. If the runner dies mid-run, the queue's
 * expiration elapses and pg-boss retries — that is the durability story.
 *
 * @module PythonFunctionsModule
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { LoggingModule } from '@ci/common/logging';
import { EventsModule } from '@ci/domains/events';

import './events';

import { PythonFunctionCallbackController } from './controllers/PythonFunctionCallbackController';
import { PythonFunctionCrons } from './cron/PythonFunctionCrons';
import { PythonRunCallbackGuard } from './guards/PythonRunCallbackGuard';
import { PythonFunctionDispatchListener } from './listeners/PythonFunctionDispatchListener';
import { PythonFunctionService } from './services/PythonFunctionService';
import { PythonFunctionTokenService } from './services/PythonFunctionTokenService';

@Module({
  imports: [EventsModule, LoggingModule, JwtModule.register({})],
  providers: [
    PythonFunctionService,
    PythonFunctionTokenService,
    PythonRunCallbackGuard,
    PythonFunctionDispatchListener,
    PythonFunctionCrons,
  ],
  controllers: [PythonFunctionCallbackController],
  exports: [PythonFunctionService],
})
export class PythonFunctionsModule {}

export { PythonFunctionService };
export { PythonFunctionRunEvent } from './events';
export { PYTHON_FUNCTION_QUEUES, PYTHON_FUNCTIONS } from './types';
export type { PythonFunctionTarget } from './types';
