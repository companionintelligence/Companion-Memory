import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Like, Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { HUB_ISSUER_PREFIX } from '@ci/common/crypto';
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

  /**
   * Bind an external identity to a local user (idempotent on (issuer, subject)).
   *
   * @param manager the transaction to write in, when the binding has to commit or roll back with
   *   something else — the account it binds, when a sign-in claims an empty appliance
   *   (`UserService.createFirstAccount`).
   */
  async bind(
    data: {
      userId: string;
      issuer: string;
      subject: string;
      email?: string | null;
      bindMethod?: 'sub' | 'email_link';
    },
    manager?: EntityManager,
  ): Promise<FederatedIdentity> {
    const repository = manager?.getRepository(FederatedIdentityEntity) ?? this.repository;

    const existing = await repository.findOne({
      where: { issuer: data.issuer, subject: data.subject },
    });

    if (existing != null) {
      return FederatedIdentityEntity.toEgressType(existing);
    }

    const record = repository.create({
      id: uuidv7(),
      userId: data.userId,
      issuer: data.issuer,
      subject: data.subject,
      email: data.email ?? null,
      bindMethod: data.bindMethod ?? 'sub',
      lastSeenAt: new Date(),
    });

    const saved = await repository.save(record);
    this.logger.log(`bound ${data.issuer}#${data.subject} → user ${data.userId} (${saved.bindMethod})`);

    return FederatedIdentityEntity.toEgressType(saved);
  }

  /**
   * All external identities bound to a local user.
   *
   * @param options.oidcOnly leave out Hub forward-auth identities (`urn:ci-hub:` issuers). The
   *   one-time Portal email link asks this: its "already bound" refusal stops a second OIDC
   *   identity adopting an account a first one claimed, and a Hub person's own binding must not
   *   turn their first Portal sign-in into `account_linked_elsewhere`.
   */
  async listForUser(userId: string, options: { oidcOnly?: boolean } = {}): Promise<FederatedIdentity[]> {
    const entities = await this.repository.find({
      where: options.oidcOnly ? { userId, issuer: Not(Like(`${HUB_ISSUER_PREFIX}%`)) } : { userId },
    });

    return entities.map(FederatedIdentityEntity.toEgressType);
  }

  /**
   * The binding `userId` holds from one issuer — for a Hub user directory, the one person of that
   * Hub the account belongs to (a partial unique index allows at most one) — or null.
   */
  async findForUserFromIssuer(userId: string, issuer: string): Promise<FederatedIdentity | null> {
    const entity = await this.repository.findOne({ where: { userId, issuer } });

    return entity ? FederatedIdentityEntity.toEgressType(entity) : null;
  }
}
