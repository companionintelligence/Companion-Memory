import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { BrowserActivityInsightPreferenceService } from '@ci/domains/llm/browser-activity-insight-preference.module';
import { ChatModelPreferenceService } from '@ci/domains/llm/chat-model-preference.module';
import { ImageDescriptionPreferenceService } from '@ci/domains/llm/image-description-preference.module';

import { PersonalizationService } from '../services/PersonalizationService';
import { TrustModeSchema, type TrustMode } from '../types';

/**
 * The `@Body()` type annotations below are erased at runtime, so without these
 * schemas any string would have been persisted as the trust mode — the setting
 * that decides whether LLM jobs may act unattended. `TrustModeSchema` is derived
 * from `TRUST_MODES`, so the accepted values cannot drift from the type.
 */
export const trustModeSchema = z.object({ trustMode: TrustModeSchema }).strip();

export const enabledSchema = z.object({ enabled: z.boolean() }).strip();

/**
 * `enabled: null` is a real, distinct request from `false` here (unlike
 * {@link enabledSchema} elsewhere): it clears the user's per-model "Describe
 * images" override and returns to that model's automatic default, rather
 * than forcing the setting off for every model going forward.
 */
export const nullableEnabledSchema = z.object({ enabled: z.boolean().nullable() }).strip();

/** `chatModel: null` clears the override and returns to the appliance default. */
export const chatModelSchema = z.object({ chatModel: z.string().trim().min(1).nullable() }).strip();

@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('personalization')
export class PersonalizationController {
  constructor(
    private readonly personalizationService: PersonalizationService,
    private readonly imageDescriptionPreference: ImageDescriptionPreferenceService,
    private readonly browserActivityInsightPreference: BrowserActivityInsightPreferenceService,
    private readonly chatModelPreference: ChatModelPreferenceService,
  ) {}

  @Get('profile')
  async getProfile(@Context() context: RequestContext) {
    const profile = await this.personalizationService.getProfile(context.userId!);

    return profile;
  }

  @Post('trust-mode')
  async updateTrustMode(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(trustModeSchema)) body: { trustMode: TrustMode },
  ) {
    const profile = await this.personalizationService.updateTrustMode(
      toServiceContext(context),
      body.trustMode,
    );

    return profile;
  }

  /**
   * Settings → Model "Describe images". Kept off GET /profile so the trust
   * payload stays a trust payload; this flag is an inference preference.
   */
  @Get('image-description')
  async getImageDescription(@Context() context: RequestContext) {
    const enabled = await this.imageDescriptionPreference.isEnabled(context.userId!);

    return { enabled };
  }

  /**
   * `enabled: null` clears the explicit override for whichever model the
   * user is currently on and returns to that model's automatic default (on
   * if it reports vision, off otherwise) — see
   * {@link ImageDescriptionPreferenceService}.
   */
  @Post('image-description')
  async updateImageDescription(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(nullableEnabledSchema)) body: { enabled: boolean | null },
  ) {
    const enabled = await this.imageDescriptionPreference.setEnabled(toServiceContext(context), body.enabled);

    return { enabled };
  }

  /**
   * Settings → Model: which chat model this user talks to, and their Tools /
   * Thinking preferences. Moved server-side (from `localStorage`) so they
   * survive a cleared profile, follow the user across devices, and — for the
   * chat model specifically — are visible to background vision work
   * (`OllamaService.resolveVisionModel`), not just to the browser tab that
   * set them.
   */
  @Get('chat-model')
  async getChatModel(@Context() context: RequestContext) {
    const chatModel = await this.chatModelPreference.getChatModel(context.userId!);

    return { chatModel };
  }

  @Post('chat-model')
  async updateChatModel(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(chatModelSchema)) body: { chatModel: string | null },
  ) {
    const chatModel = await this.chatModelPreference.setChatModel(toServiceContext(context), body.chatModel);

    return { chatModel };
  }

  @Get('tools')
  async getTools(@Context() context: RequestContext) {
    const enabled = await this.chatModelPreference.getToolsEnabled(context.userId!);

    return { enabled };
  }

  @Post('tools')
  async updateTools(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(enabledSchema)) body: { enabled: boolean },
  ) {
    const enabled = await this.chatModelPreference.setToolsEnabled(toServiceContext(context), body.enabled);

    return { enabled };
  }

  @Get('thinking')
  async getThinking(@Context() context: RequestContext) {
    const enabled = await this.chatModelPreference.getThinkingEnabled(context.userId!);

    return { enabled };
  }

  @Post('thinking')
  async updateThinking(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(enabledSchema)) body: { enabled: boolean },
  ) {
    const enabled = await this.chatModelPreference.setThinkingEnabled(
      toServiceContext(context),
      body.enabled,
    );

    return { enabled };
  }

  /**
   * Settings → Model "Categorize browsing activity". Off by default — see
   * BrowserActivityInsightPreferenceService for why.
   */
  @Get('browser-activity-insight')
  async getBrowserActivityInsight(@Context() context: RequestContext) {
    const enabled = await this.browserActivityInsightPreference.isEnabled(context.userId!);

    return { enabled };
  }

  @Post('browser-activity-insight')
  async updateBrowserActivityInsight(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(enabledSchema)) body: { enabled: boolean },
  ) {
    const enabled = await this.browserActivityInsightPreference.setEnabled(
      toServiceContext(context),
      body.enabled,
    );

    return { enabled };
  }
}
