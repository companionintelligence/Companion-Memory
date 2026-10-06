import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { Context, type RequestContext } from '@ci/common/context';
import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import type { SignupCode } from '../entities/SignupCodeEntity';
import { SignupCodeService } from '../services/SignupCodeService';

/** `ci.signup_code.id` is a bigint identity; anything else names no code. */
const SIGNUP_CODE_ID = /^[1-9][0-9]{0,18}$/;

function toResponse(code: SignupCode) {
  return {
    id: String(code.id),
    signup_code: code.signup_code,
    created_at: code.createdAt,
    expires_at: code.expiresAt,
  };
}

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
 * else's memory, so a person has to choose to issue it. Each code records who
 * issued it, expires after a week, can be withdrawn before anyone uses it, and
 * dies with the account that issued it.
 */
@Controller('signup-codes')
@UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
export class SignupCodeController {
  constructor(private readonly signupCodeService: SignupCodeService) {}

  /** Codes that still admit someone, so the owner can re-read one they already issued. */
  @Get()
  async list() {
    const codes = await this.signupCodeService.findUnused();

    return codes.map(toResponse);
  }

  @Post()
  async mint(@Context() context: RequestContext) {
    const code = await this.signupCodeService.create(context.userId ?? null);

    return toResponse(code);
  }

  /**
   * Withdraw an invitation nobody has used yet.
   *
   * The parameter is not called `id`: the global `IdFormatGuard` 404s any route parameter whose
   * name ends in `id` unless its value is a uuid, and an invitation's id is a bigint. Named `:id`,
   * this route answered 404 to every request before reaching the handler.
   */
  @Delete(':invitation')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param('invitation') id: string): Promise<void> {
    if (!SIGNUP_CODE_ID.test(id)) {
      throw new BadRequestException('Invalid invitation id');
    }

    if (!(await this.signupCodeService.revoke(id))) {
      throw new NotFoundException('Invitation not found');
    }
  }
}
