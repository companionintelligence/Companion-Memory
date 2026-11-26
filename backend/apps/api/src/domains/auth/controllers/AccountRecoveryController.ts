import { Body, Controller, Header, HttpCode, HttpException, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod/v3';

import { ValidationPipe } from '@ci/common/pipes';

import { CsrfGuard } from '../guards/CsrfGuard';
import { AccountRecoveryService } from '../services/AccountRecoveryService';
import { LoginThrottleService } from '../services/LoginThrottleService';
import { newPasswordSchema } from '../utils/passwordPolicy';

const recoveryInput = z.object({
  email: z.string().trim().email().max(320),
  code: z.string().min(1).max(200),
  newPassword: newPasswordSchema,
});

@Controller('account-recovery')
export class AccountRecoveryController {
  constructor(
    private readonly recovery: AccountRecoveryService,
    private readonly throttle: LoginThrottleService,
  ) {}

  @Post()
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @UseGuards(CsrfGuard)
  async recover(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ValidationPipe(recoveryInput)) body: z.infer<typeof recoveryInput>,
  ): Promise<void> {
    const identity = `recovery:${body.email.trim().toLowerCase()}`;
    const throttled = this.throttle.check(req.ip, identity);
    if (throttled.locked) {
      res.setHeader('Retry-After', String(throttled.retryAfterSeconds));
      throw new HttpException('Too many recovery attempts. Try again later.', 429);
    }

    try {
      await this.recovery.recover(body.email, body.code, body.newPassword);
      this.throttle.recordSuccess(req.ip, identity);
    } catch (error) {
      this.throttle.recordFailure(req.ip, identity);
      throw error;
    }
  }
}
