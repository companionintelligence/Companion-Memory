import { Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { CONSUMPTION_STORE, type ConsumptionStore } from '@ci/domains/consumption';
import { PeerAskService, PeerLinkService, PeerRateLimitService, jwkThumbprint } from '@ci/domains/peers';

import { signerFromJwk } from './boxSigner';
import type { ConsumeMeta, TransportIdentity } from './consumer';
import { StoreDuplicateGuard } from './duplicateGuard';
import { SOVEREIGN_ISSUER, TrustTasksEngine, type EngineReply } from './engine';
import { SovereignKeriVidResolver, isSovereignVidShape, sovereignJwk } from './vid';

/** What `AskChannelProvenance.covered` reports for a Trust Task: the proof covers the whole document. */
const PROOF_COVERAGE = 'trust-task:eddsa-jcs-2022';

/** Whether two public JWKs are the same key, by RFC 7638 thumbprint. A malformed one is not the same. */
function sameKey(left: unknown, right: Record<string, unknown>): boolean {
  try {
    return jwkThumbprint(left as Record<string, unknown>) === jwkThumbprint(right);
  } catch {
    return false;
  }
}

/**
 * The Nest-facing half of the Trust Tasks surface: it builds the {@link TrustTasksEngine} from this
 * box's real collaborators and exposes one method to the controller.
 *
 * ═══ THE KEY THE LINK RECORDS ALWAYS WINS ═══
 *
 * Admission asks whether an ACTIVE peer link names this AID, and — as `PeerAskController` does for the
 * RFC 9421 path — refuses an AID whose link records a DIFFERENT key. A `did:keri:D<x>` spells out its
 * own key, so a proof that verifies under it proves control of that key; the link is what says whether
 * the owner has ever agreed to deal with it, and which key they agreed to. A link with no key recorded
 * falls back to the key the AID spells out, which is the point of a self-certifying identifier.
 *
 * ═══ NO KEY, NO SURFACE ═══
 *
 * The engine needs this box's own signing key: every response carries a proof (§7.3 item 8 for the Asks
 * family), and an unsigned answer would be one this box's own specifications call non-conforming. With
 * no usable `peers.signingKeyJwk` the service is not ready and the controller refuses as if the route
 * did not exist.
 */
@Injectable()
export class TrustTasksService {
  private readonly engine: TrustTasksEngine | null;

  constructor(
    @Inject(CONSUMPTION_STORE) store: ConsumptionStore,
    asks: PeerAskService,
    private readonly links: PeerLinkService,
    throttle: PeerRateLimitService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TrustTasksService.name);

    const signer = signerFromJwk(config.peers?.signingKeyJwk);
    if (signer == null) {
      // Only an operator who turned the feature on needs to hear that it cannot work. Every default install
      // has the flag off and no key, and must not be told anything.
      if (config.features['trust.tasks']) {
        this.logger.warn(
          'trust tasks closed: peers.signingKeyJwk is absent or is not a usable Ed25519 private JWK',
        );
      }

      this.engine = null;

      return;
    }

    this.engine = new TrustTasksEngine({
      signer,
      resolver: new SovereignKeriVidResolver(),
      guard: new StoreDuplicateGuard(store),
      asks,
      throttle,
      admit: (vid) => this.admits(vid),
      provenance: (vid, verifiedAt) => {
        const spelled = sovereignJwk(vid);
        if (spelled == null) {
          return null;
        }

        try {
          return { keyThumbprint: jwkThumbprint(spelled), verifiedAt, covered: [PROOF_COVERAGE] };
        } catch {
          return null;
        }
      },
      log: (message) => this.logger.warn(message),
    });
  }

  /** Whether the surface can answer: this box holds a usable signing key. */
  get ready(): boolean {
    return this.engine !== null;
  }

  /** The largest request body any served specification accepts: the bound the controller applies first. */
  get maxBodyBytes(): number {
    return this.engine?.maxDocumentBytes ?? 0;
  }

  /** This box's Trust Task VID — the AID peers address documents to — or null when the surface is closed. */
  get vid(): string | null {
    return this.engine?.vid ?? null;
  }

  async handle(
    received: unknown,
    transport: TransportIdentity = {},
    meta: ConsumeMeta = {},
  ): Promise<EngineReply> {
    if (this.engine == null) {
      return { kind: 'refused' };
    }

    return this.engine.handle(received, transport, meta);
  }

  /**
   * Whether an active link names this AID. Called with a CLAIMED identity before any signature is checked,
   * so it is ordered cheapest first: a string test, one indexed look-up, and only for an AID that is
   * actually linked the curve arithmetic that makes sure the key is one anybody could be held to.
   */
  private async admits(vid: string): Promise<boolean> {
    if (!isSovereignVidShape(vid)) {
      return false;
    }

    const links = await this.links.findActiveByPeerIdentity(SOVEREIGN_ISSUER, vid);
    if (links.length === 0) {
      return false;
    }

    const spelled = sovereignJwk(vid);
    if (spelled == null) {
      return false;
    }

    return links.some((link) => link.peerKeyJwk == null || sameKey(link.peerKeyJwk, spelled));
  }
}
