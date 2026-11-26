import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';

import config from '@ci/configuration';
import { LiveChangesService } from '@ci/domains/live-changes';
import { normalizeEmail } from '@ci/domains/user';

export function recoveryCodeDigest(code: string): string | null {
  const normalized = code.trim().toUpperCase().replace(/[\s-]/g, '');

  return /^CMR[A-F0-9]{40}$/.test(normalized) ? createHash('sha256').update(normalized).digest('hex') : null;
}

@Injectable()
export class AccountRecoveryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly liveChanges?: LiveChangesService,
  ) {}

  async generate(userId: string, expectedCredentialsResetAt: Date | null = null): Promise<string[]> {
    const codes = Array.from(
      { length: 8 },
      () =>
        `CMR-${randomBytes(20)
          .toString('hex')
          .toUpperCase()
          .match(/.{1,5}/g)!
          .join('-')}`,
    );
    await this.dataSource.transaction(async (manager) => {
      // Serialize rotation and redemption on the owner, so replacing a list
      // cannot leave one newly generated code behind an older transaction.
      const rows = await manager.query(
        'SELECT id, credentials_reset_at FROM ci.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [userId],
      );
      if (
        !rows.length ||
        (rows[0].credentials_reset_at?.getTime() ?? null) !== (expectedCredentialsResetAt?.getTime() ?? null)
      ) {
        throw new UnauthorizedException('Credentials changed. Sign in again.');
      }

      await manager.query('DELETE FROM ci.account_recovery_codes WHERE user_id = $1', [userId]);
      await manager.query(
        `INSERT INTO ci.account_recovery_codes(user_id, code_digest)
        SELECT $1::uuid, unnest($2::text[])`,
        [userId, codes.map(recoveryCodeDigest)],
      );
    });

    return codes;
  }

  async recover(email: string, code: string, newPassword: string): Promise<void> {
    const digest = recoveryCodeDigest(code);
    if (!digest) {
      throw new UnauthorizedException('Email or recovery code is incorrect or has already been used');
    }

    // Hash before acquiring a row lock; neither the plaintext nor the code is logged.
    const password = await bcrypt.hash(newPassword, config.auth.local.saltRounds);
    const userId = await this.dataSource.transaction(async (manager) => {
      const users = await manager.query(
        'SELECT id FROM ci.users WHERE LOWER(email) = $1 AND deleted_at IS NULL FOR UPDATE',
        [normalizeEmail(email)],
      );
      const id: string | undefined = users[0]?.id;
      if (!id) {
        throw new UnauthorizedException('Email or recovery code is incorrect or has already been used');
      }

      const rows = await manager.query(
        `UPDATE ci.account_recovery_codes SET consumed_at = now()
        WHERE user_id = $1 AND code_digest = $2 AND consumed_at IS NULL RETURNING id`,
        [id, digest],
      );
      // TypeORM's raw UPDATE RETURNING returns [rows, count].
      if (!Array.isArray(rows[0]) || rows[0].length !== 1) {
        throw new UnauthorizedException('Email or recovery code is incorrect or has already been used');
      }

      await manager.query(
        `UPDATE ci.users SET password = $2, password_set_at = $3,
        credentials_reset_at = $3, updated_at = $3 WHERE id = $1`,
        [id, password, new Date()],
      );
      await manager.query('DELETE FROM ci.sessions WHERE user_id = $1', [id]);
      await manager.query("DELETE FROM ci.api_keys WHERE user_id = $1 AND managed_by = 'sign_in'", [id]);

      return id;
    });

    // After the commit, so the open live-update streams that re-check now see the deleted rows.
    await this.liveChanges?.publishRevoked(userId);
  }
}
