import { BadRequestException, Body, Controller, Get, NotFoundException, Post } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';

import { DidcommAgent } from './agent';
import { DISCOVER_FEATURES_PROTOCOL } from './discoverFeatures';
import { DidcommError } from './errors';
import { generateDidPeerIdentity, secretsOf } from './identity';
import { type DidcommMessage } from './message';
import { buildInvitation, decodeInvitationUrl, encodeInvitationUrl, OOB_PROTOCOL } from './outOfBand';
import { InMemoryReplayGuard } from './replayGuard';
import { createDidResolver } from './resolver';
import { TRUST_PING_PROTOCOL } from './trustPing';

export interface CreateOobInvitationBody {
  goalCode?: string;
  goal?: string;
  accept?: string[];
  /** Optional HTTPS base URL to encode the `_oob=` invitation parameter into. */
  baseUrl?: string;
  expiresTime?: number;
}

/**
 * Controller for DIDComm Messaging v2.1 facade (`/didcomm/*`).
 * Gated by `didcomm.messaging` feature flag (off by default; returns 404 when disabled).
 */
@Controller('didcomm')
export class DidcommController {
  private agent: DidcommAgent | null = null;

  private readonly resolver = createDidResolver();

  constructor(private readonly features: FeatureService) {}

  private getAgent(): DidcommAgent {
    if (!this.agent) {
      const identity = generateDidPeerIdentity({
        uri: 'https://localhost/didcomm/message',
        accept: ['didcomm/v2'],
      });
      this.agent = new DidcommAgent({
        did: identity.did,
        resolver: this.resolver,
        secrets: secretsOf(identity),
        replayGuard: new InMemoryReplayGuard(),
      });
    }

    return this.agent;
  }

  @Get('did')
  async getDid(): Promise<{ did: string; protocols: string[]; accept: string[] }> {
    if (!(await this.features.isFeatureEnabled('didcomm.messaging'))) {
      throw new NotFoundException();
    }

    return {
      did: this.getAgentDid(),
      protocols: [TRUST_PING_PROTOCOL, DISCOVER_FEATURES_PROTOCOL, OOB_PROTOCOL],
      accept: ['didcomm/v2'],
    };
  }

  /** Creates a DIDComm Out-of-Band 2.0 invitation for peering with this box's ephemeral `did:peer`. */
  @Post('oob')
  async createOobInvitation(
    @Body() body: CreateOobInvitationBody = {},
  ): Promise<{ invitation: DidcommMessage; invitationUrl?: string }> {
    if (!(await this.features.isFeatureEnabled('didcomm.messaging'))) {
      throw new NotFoundException();
    }

    try {
      const invitation = buildInvitation({
        from: this.getAgentDid(),
        goalCode: body?.goalCode,
        goal: body?.goal,
        accept: body?.accept ?? ['didcomm/v2'],
        expiresTime: body?.expiresTime,
      });

      const invitationUrl =
        typeof body?.baseUrl === 'string' && body.baseUrl.length > 0
          ? encodeInvitationUrl(body.baseUrl, invitation)
          : undefined;

      return {
        invitation,
        ...(invitationUrl ? { invitationUrl } : {}),
      };
    } catch (err) {
      if (err instanceof DidcommError) {
        throw new BadRequestException(err.message);
      }

      throw err;
    }
  }

  /**
   * Parses and validates a DIDComm Out-of-Band 2.0 `_oob=` invitation URL offline.
   * Short URLs (`_oobid=`) are refused rather than fetched to preserve zero-SSRF fail-closed posture.
   */
  @Post('oob/parse')
  async parseOobInvitation(
    @Body() body: { url?: string },
  ): Promise<{ valid: boolean; invitation?: DidcommMessage; code?: string; error?: string }> {
    if (!(await this.features.isFeatureEnabled('didcomm.messaging'))) {
      throw new NotFoundException();
    }

    if (typeof body?.url !== 'string' || body.url.trim().length === 0) {
      return { valid: false, code: 'malformed-message', error: 'url must be a non-empty string' };
    }

    try {
      const invitation = decodeInvitationUrl(body.url.trim());

      return { valid: true, invitation };
    } catch (err) {
      if (err instanceof DidcommError) {
        return { valid: false, code: err.code, error: err.message };
      }

      return {
        valid: false,
        code: 'malformed-message',
        error: err instanceof Error ? err.message : 'DIDCOMM_OOB_PARSE_FAILED',
      };
    }
  }

  @Post('message')
  async handleMessage(@Body() body: Record<string, unknown> | string): Promise<{
    handled: boolean;
    messageId?: string;
    type?: string;
    repliesCount?: number;
    replies?: Array<{ to: string; type: string; packed: Record<string, unknown> }>;
    error?: string;
  }> {
    if (!(await this.features.isFeatureEnabled('didcomm.messaging'))) {
      throw new NotFoundException();
    }

    try {
      const agent = this.getAgent();
      const result = await agent.receive(body as string | Record<string, unknown>);

      return {
        handled: result.handled,
        messageId: result.message.id,
        type: result.message.type,
        repliesCount: result.replies.length,
        replies: result.replies.map((reply) => ({
          to: reply.to,
          type: reply.message.type,
          packed: JSON.parse(reply.packed) as Record<string, unknown>,
        })),
      };
    } catch (err) {
      return {
        handled: false,
        error: err instanceof Error && err.message ? err.message : 'DIDCOMM_RECEIVE_FAILED',
      };
    }
  }

  getAgentDid(): string {
    return this.getAgent().did;
  }
}
