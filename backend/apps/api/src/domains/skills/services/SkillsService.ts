import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SkillEntity, type Skill, type SkillSource } from '../entities/SkillEntity';
import { SkillVersionEntity, type SkillSpec } from '../entities/SkillVersionEntity';
import { UserSkillInstallEntity } from '../entities/UserSkillInstallEntity';

/**
 * Plan 02 — minimal CRUD over the skills tables. Executors (deterministic,
 * LLM, composite) and MCP exposure land in follow-ups.
 */
@Injectable()
export class SkillsService {
  constructor(
    @InjectRepository(SkillEntity)
    private readonly skillRepository: Repository<SkillEntity>,
    @InjectRepository(SkillVersionEntity)
    private readonly versionRepository: Repository<SkillVersionEntity>,
    @InjectRepository(UserSkillInstallEntity)
    private readonly installRepository: Repository<UserSkillInstallEntity>,
  ) {}

  async listSkills(): Promise<Skill[]> {
    const rows = await this.skillRepository.find({ order: { name: 'ASC' } });

    return rows;
  }

  async getSkill(name: string): Promise<Skill | null> {
    return this.skillRepository.findOne({ where: { name } });
  }

  async upsertSkill(input: {
    name: string;
    source: SkillSource;
    description?: string;
    owner_actor_id?: string;
  }): Promise<Skill> {
    const existing = await this.skillRepository.findOne({ where: { name: input.name } });

    if (existing) {
      existing.source = input.source;
      existing.description = input.description ?? existing.description;
      existing.owner_actor_id = input.owner_actor_id ?? existing.owner_actor_id;

      return this.skillRepository.save(existing);
    }

    return this.skillRepository.save({
      id: uuidv7(),
      name: input.name,
      source: input.source,
      description: input.description ?? null,
      owner_actor_id: input.owner_actor_id ?? null,
    });
  }

  async publishVersion(input: {
    skillId: string;
    version: string;
    spec: SkillSpec;
    instructions_md?: string;
  }): Promise<SkillVersionEntity> {
    return this.versionRepository.save({
      id: uuidv7(),
      skill_id: input.skillId,
      version: input.version,
      spec: input.spec,
      instructions_md: input.instructions_md ?? null,
    });
  }

  async listVersions(skillId: string): Promise<SkillVersionEntity[]> {
    return this.versionRepository.find({
      where: { skill_id: skillId },
      order: { published_at: 'DESC' },
    });
  }

  async install(input: {
    actorId: string;
    skillVersionId: string;
    config?: Record<string, unknown>;
  }): Promise<UserSkillInstallEntity> {
    const existing = await this.installRepository.findOne({
      where: { actor_id: input.actorId, skill_version_id: input.skillVersionId },
    });

    if (existing) {
      existing.config = input.config ?? existing.config;
      existing.enabled = true;

      return this.installRepository.save(existing);
    }

    return this.installRepository.save({
      id: uuidv7(),
      actor_id: input.actorId,
      skill_version_id: input.skillVersionId,
      config: input.config ?? {},
      enabled: true,
    });
  }

  async listInstallsForActor(actorId: string): Promise<UserSkillInstallEntity[]> {
    return this.installRepository.find({ where: { actor_id: actorId, enabled: true } });
  }

  async getInstalledVersionsForActor(actorId: string): Promise<SkillVersionEntity[]> {
    const installs = await this.listInstallsForActor(actorId);

    if (installs.length === 0) {
      return [];
    }

    return this.versionRepository.find({
      where: { id: In(installs.map((i) => i.skill_version_id)) },
    });
  }
}
