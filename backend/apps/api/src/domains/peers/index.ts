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
import { UserModule } from '@ci/domains/user';

import { PeerAskController } from './controllers/PeerAskController';
import { PeerExchangeController } from './controllers/PeerExchangeController';
import { PeerAnswerCollectionCron } from './cron/PeerAnswerCollectionCron';
import { PeerAskCorrelationEntity } from './entities/PeerAskCorrelationEntity';
import { PeerIdentityKeyEntity } from './entities/PeerIdentityKeyEntity';
import { PeerLinkEntity } from './entities/PeerLinkEntity';
import { LocalPubDiscoveryService } from './services/LocalPubDiscoveryService';
import { OutboundAskService } from './services/OutboundAskService';
import { PeerAskClient } from './services/PeerAskClient';
import { PeerAskCorrelationService } from './services/PeerAskCorrelationService';
import { PeerAskService } from './services/PeerAskService';
import { PeerDirectoryService } from './services/PeerDirectoryService';
import { PeerExchangeClient } from './services/PeerExchangeClient';
import { PeerIdentityService } from './services/PeerIdentityService';
import { PeerLinkService } from './services/PeerLinkService';
import { PeerRateLimitService } from './services/PeerRateLimitService';
import { PeerSignatureService } from './services/PeerSignatureService';

@Module({
  imports: [
    // `AskEntity` is registered here so the OUTBOUND path can open a
    // transaction and drive its own ask to `answered`: an outbound ask carries
    // a null responder, so `AskService.complete` — `responderOwned` by
    // construction — can never see it.
    TypeOrmModule.forFeature([
      PeerLinkEntity,
      PeerAskCorrelationEntity,
      PeerIdentityKeyEntity,
      EventEntity,
      AskEntity,
    ]),
    AsksModule,
    AuthModule,
    MemoryModule,
    // `OutboundAskService` reads the sender's name for `askerHandle`.
    UserModule,
  ],
  controllers: [PeerAskController, PeerExchangeController],
  providers: [
    PeerLinkService,
    PeerDirectoryService,
    LocalPubDiscoveryService,
    PeerAskClient,
    PeerExchangeClient,
    PeerAskCorrelationService,
    PeerAskService,
    PeerRateLimitService,
    PeerSignatureService,
    PeerIdentityService,
    OutboundAskService,
    PeerAnswerCollectionCron,
  ],
  exports: [
    PeerLinkService,
    PeerDirectoryService,
    LocalPubDiscoveryService,
    PeerAskClient,
    PeerAskCorrelationService,
    PeerAskService,
    PeerRateLimitService,
    PeerSignatureService,
    PeerIdentityService,
    OutboundAskService,
  ],
})
export class PeersModule {}

export { PeerLinkEntity, PeerAskCorrelationEntity, PeerIdentityKeyEntity };
export { PeerIdentityService } from './services/PeerIdentityService';
export type { PeerIdentity, PeerSigner } from './services/PeerIdentityService';
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
export { LocalPubDiscoveryService };
export type { LocalPubLookupFailure, LocalPubLookupResult } from './services/LocalPubDiscoveryService';
export type { LocalPubCandidate } from './localPubProfile';
export { didKeyIdFor, didKeyPublicJwk, isDidKeyId } from './didKeyId';
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
export { isSelfCertifyingIssuer } from './selfCertifyingKeyId';
