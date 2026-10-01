import * as crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { type SignupCode, SignupCodeEntity } from '../entities/SignupCodeEntity';

@Injectable()
export class SignupCodeService {
  constructor(
    @InjectRepository(SignupCodeEntity)
    private readonly signupCodeRepository: Repository<SignupCodeEntity>,
  ) {}

  async create(): Promise<SignupCode> {
    const signupCode = this.signupCodeRepository.create({
      signup_code: crypto.randomBytes(6).toString('hex'),
    });

    return await this.signupCodeRepository.save(signupCode);
  }

  /** Unused codes, newest first — what the owner sees after minting one. */
  async findUnused(): Promise<SignupCode[]> {
    return this.signupCodeRepository.find({
      where: { used: false },
      order: { createdAt: 'DESC' },
      take: 20,
    });
  }

  /**
   * The code, if it is unused right now.
   *
   * ⚠️ An answer for this instant, good only for refusing early. Every request presenting the same
   * code gets the same answer until one of them redeems it, so admitting anyone on the strength of
   * it lets one invitation admit as many people as arrive together. That decision is
   * {@link consume}'s.
   */
  async findOne(signup_code: string): Promise<SignupCode | null> {
    const result = await this.signupCodeRepository.findOne({
      where: {
        signup_code,
        used: false,
      },
    });

    return result ?? null;
  }

  /**
   * Redeem an invitation: mark `signup_code` used if, and only if, it is still unused — in one
   * statement, so that of any number of requests presenting the same code exactly one is told it
   * has it.
   *
   * The UPDATE locks the row it changes, so a concurrent redemption of the same code waits for this
   * transaction to end and then re-reads the row: if this one committed, it finds the code used and
   * redeems nothing; if this one rolled back, it redeems the code itself.
   *
   * @param manager the transaction to redeem in. Pass the one that creates the account the code
   *   admits, so the code is spent exactly when that account exists: an account that fails to be
   *   created rolls its redemption back with it, and the invitation is still there for another try.
   * @returns whether THIS call redeemed it. `false` for a code that does not exist, was already
   *   used, or was redeemed by a concurrent request first.
   */
  async consume(
    signup_code: string,
    manager: EntityManager = this.signupCodeRepository.manager,
  ): Promise<boolean> {
    // Wrapped in a CTE so the OUTER command is a SELECT, the only shape TypeORM's Postgres driver
    // resolves to the rows themselves. A bare `UPDATE ... RETURNING` resolves to the pair
    // `[rows, rowCount]`, whose length is 2 whatever the UPDATE matched — every request would be
    // told it had redeemed the code.
    const redeemed = await manager.query<Array<{ id: string }>>(
      `WITH redeemed AS (
         UPDATE ci.signup_code
            SET used = true
          WHERE signup_code = $1
            AND used = false
        RETURNING id)
       SELECT id FROM redeemed`,
      [signup_code],
    );

    return redeemed.length > 0;
  }
}
