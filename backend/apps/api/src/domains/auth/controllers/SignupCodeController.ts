import { Controller, Get, Post, UseGuards } from '@nestjs/common';

import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { SignupCodeService } from '../services/SignupCodeService';

/**
 * Lets the owner of an appliance invite someone onto it.
 *
 * `SignupCodeService.create()` has existed since signup codes were added, but
 * nothing ever called it — no controller, no CLI, no migration. The table
 * therefore started empty and stayed empty, which made `require.signup.codes`
 * (on by default) unsatisfiable: the gate demanded a code that no one could
 * produce. The first account is exempt, so a fresh appliance still works, but
 * the SECOND had no route in at all.
 *
 * That is what this closes. It is deliberately the owner's decision rather than
 * something the product mints on its own: a code is an invitation to someone
 * else's memory, so a person has to choose to issue it.
 */
@Controller('signup-codes')
@UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
export class SignupCodeController {
  constructor(private readonly signupCodeService: SignupCodeService) {}

  /** Unused codes, so the owner can re-read one they already issued. */
  @Get()
  async list() {
    const codes = await this.signupCodeService.findUnused();

    return codes.map((code) => ({ signup_code: code.signup_code, created_at: code.createdAt }));
  }

  @Post()
  async mint() {
    const code = await this.signupCodeService.create();

    return { signup_code: code.signup_code, created_at: code.createdAt };
  }
}
