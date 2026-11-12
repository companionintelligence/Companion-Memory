import { Body, Controller, NotFoundException, Post } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';

import { DidcommAgent } from './agent';
import { generateDidPeerIdentity, secretsOf } from './identity';
import { InMemoryReplayGuard } from './replayGuard';
import { createDidResolver } from './resolver';

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
        uri: 'http://localhost/didcomm/message',
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

  @Post('message')
  async handleMessage(@Body() body: Record<string, unknown> | string): Promise<{
    handled: boolean;
    messageId?: string;
    type?: string;
    repliesCount?: number;
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
      };
    } catch (err) {
      return {
        handled: false,
        error: (err as Error).message || 'DIDCOMM_RECEIVE_FAILED',
      };
    }
  }

  getAgentDid(): string {
    return this.getAgent().did;
  }
}
