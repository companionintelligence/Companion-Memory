import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod/v3';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import {
  AGENT_JOBS_SCOPE,
  API_KEY_CAPABILITIES,
  CAPTURE_SCOPE,
  INTENTS_SCOPE,
  MCP_SCOPE,
  MEMORY_SCOPE,
  READ_CAPABILITY,
  RequireCapability,
} from '@ci/common/decorators';
import { ApiKeyGuard, type ApiKeyScopedRequest, JwtOrPortalAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { ApiKeyService } from '../services/ApiKeyService';
import {
  CONNECT_KEY_NAME_PREFIX,
  type CreateApiKeyDto,
  isManagedAppPrincipal,
  PHONE_KEY_NAME,
  SIGN_IN_PROVENANCE,
  type UpdateApiKeyDto,
} from '../types';

/**
 * `app:` is reserved for connection keys minted by the consent flow
 * (`app:<appName>:<store>`). Hub ownership is carried by recorded provenance, not by
 * this prefix, so a colliding name no longer hands a user's key to Hub machinery —
 * but keeping the namespaces distinct still matters: the settings UI badges connect
 * keys as Hub-managed, and a user-created `app:ci-hermes:ci-marketplace` would read as
 * one while behaving as a normal key. Reject the name at the door instead.
 */
const apiKeyName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.startsWith(CONNECT_KEY_NAME_PREFIX), {
    message: `Key names starting with "${CONNECT_KEY_NAME_PREFIX}" are reserved for connected apps`,
  });

/**
 * Scopes are validated against the canonical list rather than accepted as free strings.
 *
 * Enforcement is deny-by-default on a NON-EMPTY scope array, so a typo ('mcpp') would mint a key
 * that authenticates fine and is then refused everywhere — a silent, hard-to-diagnose dead key.
 * An empty array keeps its grandfathered meaning: full user authority.
 */
const apiKeyScopes = z
  .array(z.enum([MEMORY_SCOPE, INTENTS_SCOPE, MCP_SCOPE, CAPTURE_SCOPE, AGENT_JOBS_SCOPE]))
  .optional();

/**
 * What the key may DO on the surfaces its scopes reach. Optional on both create and update so a
 * client that predates the field keeps working: an omitted capability means "unchanged" on update
 * and the default on create, never a silent reset to the strictest or the widest level.
 */
const apiKeyCapability = z.enum(API_KEY_CAPABILITIES).optional();

export const createApiKeySchema = z.object({
  name: apiKeyName,
  scopes: apiKeyScopes,
  capability: apiKeyCapability,
  expires_at: z.string().datetime().optional(),
  /**
   * The phone or desktop app minting the key it will sign in with. Tags it `sign_in`, which a
   * password change, "Sign out everywhere" and the app's own sign-out revoke.
   */
  sign_in: z.boolean().optional(),
});

// The name here is NOT refined: rejecting `app:` on the request body would also 400 a
// client echoing a key's own unchanged name (which the settings dialog always submits),
// making the grandfathered `app:`-named user keys this release unlocks impossible to
// edit. ApiKeyService.update enforces the reservation on an actual RENAME, where it
// can compare against the key's current name.
export const updateApiKeySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  scopes: apiKeyScopes,
  capability: apiKeyCapability,
});

/**
 * Guarded by {@link JwtOrPortalAuthGuard}: a session JWT (settings UI) or a
 * Portal bearer that carries the user's authority here (a phone pairing with a
 * token addressed to this Memory exchanges it for a durable key). Never an api
 * key, so a leaked key cannot mint successors that outlive its revocation, and
 * never a capture client's Portal token, which stays confined to the capture
 * scope instead of becoming a key.
 */
@Controller('keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @UseGuards(JwtOrPortalAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createApiKeySchema)) input: CreateApiKeyDto,
  ) {
    const serviceContext = toServiceContext(context);

    // App builds from before `sign_in` existed send only the key's name, so the name alone tags it
    // too: the same rule migration 20261006065846 applied to the keys already on disk.
    const signIn = input.sign_in === true || PHONE_KEY_NAME.test(input.name);

    return this.apiKeyService.create(serviceContext, input, signIn ? SIGN_IN_PROVENANCE : null);
  }

  /**
   * Revoke the key this request authenticated with: how the phone and desktop apps sign out.
   *
   * They hold nothing but that key, and every other route here takes a session or a Portal bearer
   * precisely so a key cannot mint or manage keys. Giving a key up is the one thing it may do to
   * itself, at any capability: it ends its own access and reaches no other credential. An
   * installed app's key is refused: the Hub owns those and revokes them when the app is
   * disconnected. A scope-limited one never gets here (the guard's scope rule), and an
   * empty-scope one (the bulk importer's) is refused by its provenance.
   *
   * Declared before `:id` so `current` is never read as a key id.
   */
  @UseGuards(ApiKeyGuard)
  @RequireCapability(READ_CAPABILITY)
  @Delete('current')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeCurrent(@Context() context: RequestContext, @Req() req: ApiKeyScopedRequest): Promise<void> {
    if (!req.apiKeyId) {
      throw new UnauthorizedException();
    }

    if (isManagedAppPrincipal({ managedBy: req.apiKeyManagedBy })) {
      throw new ForbiddenException('Your Hub manages this key. Disconnect the app from the Hub instead.');
    }

    await this.apiKeyService.remove(toServiceContext(context), req.apiKeyId);
  }

  @UseGuards(JwtOrPortalAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    return this.apiKeyService.findAllByUser(serviceContext);
  }

  @UseGuards(JwtOrPortalAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') keyId: string) {
    const serviceContext = toServiceContext(context);

    const key = await this.apiKeyService.findOneByUser(serviceContext, keyId);

    if (!key) {
      throw new NotFoundException('API key not found');
    }

    return key;
  }

  @UseGuards(JwtOrPortalAuthGuard)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') keyId: string,
    @Body(new ValidationPipe(updateApiKeySchema)) input: UpdateApiKeyDto,
  ) {
    const serviceContext = toServiceContext(context);

    const key = await this.apiKeyService.update(serviceContext, keyId, input);

    if (!key) {
      throw new NotFoundException('API key not found');
    }

    return key;
  }

  @UseGuards(JwtOrPortalAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Context() context: RequestContext, @Param('id') keyId: string): Promise<void> {
    const serviceContext = toServiceContext(context);

    const removed = await this.apiKeyService.remove(serviceContext, keyId);

    if (!removed) {
      throw new NotFoundException('API key not found');
    }
  }
}
