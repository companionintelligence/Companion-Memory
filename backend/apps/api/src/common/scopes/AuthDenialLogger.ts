import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { AuthDenialEntity, type AuthDenialReason } from './AuthDenialEntity';

export interface AuthDenialRecord {
  actorId?: string;
  apiKeyId?: string;
  reason: AuthDenialReason;
  requiredScopes?: string[];
  grantedScopes?: string[];
  route?: string;
  toolName?: string;
  extra?: Record<string, unknown>;
}

/**
 * Plan 07 §3.4 — best-effort persistence of authorization denials. Never
 * throws; a failed log must not mask the underlying 403/429 that the caller
 * is already receiving.
 */
@Injectable()
export class AuthDenialLogger {
  constructor(
    @InjectRepository(AuthDenialEntity)
    private readonly repo: Repository<AuthDenialEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AuthDenialLogger.name);
  }

  async record(record: AuthDenialRecord): Promise<void> {
    try {
      const entity = this.repo.create({
        id: uuidv7(),
        actor_id: record.actorId ?? null,
        api_key_id: record.apiKeyId ?? null,
        reason: record.reason,
        required_scopes: record.requiredScopes ?? [],
        granted_scopes: record.grantedScopes ?? [],
        route: record.route ?? null,
        tool_name: record.toolName ?? null,
        extra: record.extra ?? null,
      });

      await this.repo.save(entity);
    } catch (error) {
      this.logger.warn('Failed to persist auth denial', {
        reason: record.reason,
        actorId: record.actorId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
