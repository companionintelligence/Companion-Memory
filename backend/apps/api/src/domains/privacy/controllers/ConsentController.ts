import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { Scopes, ScopesGuard, SCOPES } from '@ci/common/scopes';

import { DataCategory } from '../entities/ConsentPreferenceEntity';
import { ConsentService, UpdateCategoryPreferencesDto } from '../services/ConsentService';

/**
 * Plan 09 §3 — HTTP endpoints for user consent and data-retention preferences.
 *
 *  GET  /me/consent       — current preferences (PRIVACY_READ)
 *  PUT  /me/consent       — update per-category preferences (PRIVACY_WRITE)
 *  POST /me/erase         — request right-to-erasure (PRIVACY_WRITE)
 */
@UseGuards(JwtOrApiKeyAuthGuard, ScopesGuard)
@Controller('me')
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  // ─── GET /me/consent ───────────────────────────────────────────────────────

  @Scopes(SCOPES.PRIVACY_READ)
  @Get('consent')
  async getConsent(@Context() context: RequestContext) {
    const { userId } = toServiceContext(context);

    return this.consentService.findByUserId(userId);
  }

  // ─── PUT /me/consent ───────────────────────────────────────────────────────

  @Scopes(SCOPES.PRIVACY_WRITE)
  @Put('consent')
  async updateConsent(
    @Context() context: RequestContext,
    @Body()
    body: {
      dataCategories: Partial<Record<DataCategory, { enabled?: boolean; retentionDays?: number | null }>>;
    },
  ) {
    const { userId } = toServiceContext(context);
    const dto: UpdateCategoryPreferencesDto = {
      dataCategories: body.dataCategories,
    };

    return this.consentService.updateCategories(userId, dto);
  }

  // ─── POST /me/erase ────────────────────────────────────────────────────────

  @Scopes(SCOPES.PRIVACY_WRITE)
  @Post('erase')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestErasure(@Context() context: RequestContext) {
    const { userId } = toServiceContext(context);
    const result = await this.consentService.requestErasure(userId);

    return {
      accepted: true,
      erasureRequestedAt: result.erasureRequestedAt,
      message: 'Your erasure request has been queued. All personal data will be removed within 30 days.',
    };
  }
}
