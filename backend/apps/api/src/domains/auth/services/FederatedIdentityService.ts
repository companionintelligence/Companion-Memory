import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { type FederatedIdentity, FederatedIdentityEntity } from '../entities/FederatedIdentityEntity';

/**
 * Resolves an external OIDC identity to a local user by its (issuer, subject)
 * pair — the only stable, globally unique subject identifier OIDC guarantees.
 *
 * Email is deliberately NOT a matching key here: it is re-assignable and not
 * unique across issuers, so matching on it once a second issuer is trusted
 * yields cross-box account takeover. It survives only as a one-time link for
 * accounts that pre-date this table (recorded as `bind_method='email_link'`).
 */
@Injectable()
export class FederatedIdentityService {
  constructor(
    @InjectRepository(FederatedIdentityEntity)
    private readonly repository: Repository<FederatedIdentityEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FederatedIdentityService.name);
  }

  /** The local user bound to this (issuer, subject), or null if unbound. */
  async findUserId(issuer: string, subject: string): Promise<string | null> {
    const entity = await this.repository.findOne({ where: { issuer, subject } });

    if (entity == null) {
      return null;
    }

    // Best-effort liveness stamp; never fail auth because this write failed.
    void this.repository
      .update({ id: entity.id }, { lastSeenAt: new Date() })
      .catch((error: unknown) => this.logger.warn(`last_seen_at update failed: ${String(error)}`));

    return entity.userId;
  }

  /** Bind an external identity to a local user (idempotent on (issuer, subject)). */
  async bind(data: {
    userId: string;
    issuer: string;
    subject: string;
    email?: string | null;
    bindMethod?: 'sub' | 'email_link';
  }): Promise<FederatedIdentity> {
    const existing = await this.repository.findOne({
      where: { issuer: data.issuer, subject: data.subject },
    });

    if (existing != null) {
      return FederatedIdentityEntity.toEgressType(existing);
    }

    const record = this.repository.create({
      id: uuidv7(),
      userId: data.userId,
      issuer: data.issuer,
      subject: data.subject,
      email: data.email ?? null,
      bindMethod: data.bindMethod ?? 'sub',
      lastSeenAt: new Date(),
    });

    const saved = await this.repository.save(record);
    this.logger.log(`bound ${data.issuer}#${data.subject} → user ${data.userId} (${saved.bindMethod})`);

    return FederatedIdentityEntity.toEgressType(saved);
  }

  /** All external identities bound to a local user. */
  async listForUser(userId: string): Promise<FederatedIdentity[]> {
    const entities = await this.repository.find({ where: { userId } });

    return entities.map(FederatedIdentityEntity.toEgressType);
  }
}
