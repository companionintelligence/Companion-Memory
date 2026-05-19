/**
 * Plan 02 — Skills module.
 *
 * Today this module exposes entities + CRUD only. Executors (deterministic,
 * LLM, composite), MCP tool/prompt registration, and Marketplace channel
 * integration land in subsequent commits.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SkillEntity } from './entities/SkillEntity';
import { SkillInvocationEntity } from './entities/SkillInvocationEntity';
import { SkillVersionEntity } from './entities/SkillVersionEntity';
import { UserSkillInstallEntity } from './entities/UserSkillInstallEntity';
import { SkillsService } from './services/SkillsService';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SkillEntity,
      SkillVersionEntity,
      UserSkillInstallEntity,
      SkillInvocationEntity,
    ]),
  ],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}

export { SkillsService } from './services/SkillsService';
export { SkillEntity, type Skill, type SkillSource } from './entities/SkillEntity';
export { SkillVersionEntity, type SkillSpec, type SkillKind } from './entities/SkillVersionEntity';
export { UserSkillInstallEntity } from './entities/UserSkillInstallEntity';
export { SkillInvocationEntity, type SkillInvocationStatus } from './entities/SkillInvocationEntity';
