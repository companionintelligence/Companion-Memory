/**
 * Peer federation — two Companion Memory boxes exchanging asks.
 *
 * Discovery is CI-Portal's job (handle → endpoint + issuer); the relationship,
 * the consent policy, and every answer stay on the two boxes involved, so the
 * cloud plane never accumulates the social graph. See `protocol.ts` for the
 * wire contract and `docs/peer-federation.md` for the end-to-end flow.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AskEntity, AsksModule } from '@ci/domains/asks';
import { AuthModule } from '@ci/domains/auth';
import { MemoryModule, EventEntity } from '@ci/domains/memory';

import { PeerAskController } from './controllers/PeerAskController';
import { PeerAskCorrelationEntity } from './entities/PeerAskCorrelationEntity';
import { PeerLinkEntity } from './entities/PeerLinkEntity';
import { OutboundAskService } from './services/OutboundAskService';
import { PeerAskClient } from './services/PeerAskClient';
import { PeerAskCorrelationService } from './services/PeerAskCorrelationService';
import { PeerAskService } from './services/PeerAskService';
import { PeerDirectoryService } from './services/PeerDirectoryService';
import { PeerLinkService } from './services/PeerLinkService';
import { PeerRateLimitService } from './services/PeerRateLimitService';
import { PeerSignatureService } from './services/PeerSignatureService';

@Module({
  imports: [
    // `AskEntity` is registered here so the OUTBOUND path can open a
    // transaction and drive its own ask to `answered`: an outbound ask carries
    // a null responder, so `AskService.complete` — `responderOwned` by
    // construction — can never see it.
    TypeOrmModule.forFeature([PeerLinkEntity, PeerAskCorrelationEntity, EventEntity, AskEntity]),
    AsksModule,
    AuthModule,
    MemoryModule,
  ],
  controllers: [PeerAskController],
  providers: [
    PeerLinkService,
    PeerDirectoryService,
    PeerAskClient,
    PeerAskCorrelationService,
    PeerAskService,
    PeerRateLimitService,
    PeerSignatureService,
    OutboundAskService,
  ],
  exports: [
    PeerLinkService,
    PeerDirectoryService,
    PeerAskClient,
    PeerAskCorrelationService,
    PeerAskService,
    PeerRateLimitService,
    PeerSignatureService,
    OutboundAskService,
  ],
})
export class PeersModule {}

export { PeerLinkEntity, PeerAskCorrelationEntity };
export { PeerRateLimitService } from './services/PeerRateLimitService';
export { PeerSignatureService } from './services/PeerSignatureService';
export type { SignatureFailure, VerificationResult } from './services/PeerSignatureService';
export {
  PEER_SIGNATURE_ALG,
  PEER_SIGNATURE_LABEL,
  contentDigest,
  jwkThumbprint,
  publicKeyFromJwk,
} from './httpSignature';
export { OutboundAskService } from './services/OutboundAskService';
export type { SendAskDto, SendAskResult } from './services/OutboundAskService';
export { PeerLinkService, PeerDirectoryService, PeerAskClient, PeerAskService };
export { PeerAskCorrelationService } from './services/PeerAskCorrelationService';
export type { PeerAskCorrelation } from './entities/PeerAskCorrelationEntity';
export {
  coarsenFreeBusy,
  computeFreeBusy,
  summarizeAvailability,
  REDACTED_SLOT_GRANULARITY_MINUTES,
} from './availability';
export {
  PEER_ASK_ARCHETYPES,
  PEER_ASK_PENDING,
  PEER_ASK_NO_ANSWER_REASON,
  PEER_ASK_ID_PATTERN,
  peerAskBodySchema,
  peerAskPending,
} from './protocol';
export { PEER_TRUST_TIERS, isPeerTrustTier } from './entities/PeerLinkEntity';
export type { PeerLink, PeerTrustTier, PeerLinkStatus } from './entities/PeerLinkEntity';
export type {
  AskerVisiblePeerReply,
  PeerAskArchetype,
  PeerAskBody,
  PeerAskRequest,
  PeerAskResponse,
  PeerDescriptor,
  BusyInterval,
} from './protocol';
