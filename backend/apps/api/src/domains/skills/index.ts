/**
 * Plan 02 — Skills module.
 *
 * Today this module exposes entities + CRUD only. Executors (deterministic,
 * LLM, composite), MCP tool/prompt registration, and Marketplace channel
 * integration land in subsequent commits.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ToolsModule } from '@ci/domains/tools';

import { SkillEntity } from './entities/SkillEntity';
import { SkillInvocationEntity } from './entities/SkillInvocationEntity';
import { SkillVersionEntity } from './entities/SkillVersionEntity';
import { UserSkillInstallEntity } from './entities/UserSkillInstallEntity';
import { DeterministicExecutor } from './services/DeterministicExecutor';
import { SkillExecutorService } from './services/SkillExecutorService';
import { SkillsService } from './services/SkillsService';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SkillEntity,
      SkillVersionEntity,
      UserSkillInstallEntity,
      SkillInvocationEntity,
    ]),
    ToolsModule,
  ],
  providers: [SkillsService, DeterministicExecutor, SkillExecutorService],
  exports: [SkillsService, SkillExecutorService],
})
export class SkillsModule {}

export { SkillsService } from './services/SkillsService';
export { SkillExecutorService } from './services/SkillExecutorService';
export type { SkillInvocationResult } from './services/SkillExecutorService';
export { DeterministicExecutor } from './services/DeterministicExecutor';
export type { DeterministicResult, StepTrace } from './services/DeterministicExecutor';
export { SkillEntity, type Skill, type SkillSource } from './entities/SkillEntity';
export {
  SkillVersionEntity,
  type SkillSpec,
  type SkillKind,
  type DeterministicStep,
} from './entities/SkillVersionEntity';
export { UserSkillInstallEntity } from './entities/UserSkillInstallEntity';
export { SkillInvocationEntity, type SkillInvocationStatus } from './entities/SkillInvocationEntity';
