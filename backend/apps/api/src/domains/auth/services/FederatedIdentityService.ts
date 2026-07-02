import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { FederatedIdentityEntity, type FederatedIdentity } from '../entities/FederatedIdentityEntity';

/**
 * Persists and resolves the (issuer, subject) -> local-user binding that backs
 * federated login. This is the identity handle PortalTokenService trusts instead
 * of the email claim (see unified-identity-plan.md, Track B item B2).
 */
@Injectable()
export class FederatedIdentityService {
  constructor(
    @InjectRepository(FederatedIdentityEntity)
    private readonly repository: Repository<FederatedIdentityEntity>,
  ) {}

  /**
   * Resolve the local user id bound to an external (issuer, subject), or null if
   * this external identity has never been linked.
   */
  async findUserId(issuer: string, subject: string): Promise<string | null> {
    const row = await this.repository.findOne({ where: { issuer, subject } });

    return row ? row.user_id : null;
  }

  /**
   * Bind an external (issuer, subject) to a local user. Idempotent: a concurrent
   * or repeated link for the same pair is ignored (the UNIQUE (issuer, subject)
   * index is the upsert key), and the already-persisted binding is returned.
   */
  async link(issuer: string, subject: string, userId: string): Promise<FederatedIdentity> {
    await this.repository
      .createQueryBuilder()
      .insert()
      .into(FederatedIdentityEntity)
      .values({ id: uuidv7(), issuer, subject, user_id: userId })
      .orIgnore()
      .execute();

    // Read back so the returned row reflects the winning binding even when the
    // insert was a no-op due to a pre-existing (issuer, subject).
    const row = await this.repository.findOneOrFail({ where: { issuer, subject } });

    return FederatedIdentityEntity.toEgressType(row);
  }
}
