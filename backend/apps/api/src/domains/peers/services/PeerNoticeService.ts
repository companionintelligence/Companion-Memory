import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { type PeerLink } from '../entities/PeerLinkEntity';
import { KEY_ROTATION_PATH, UNLINK_PATH, rotationNotice } from '../keyNotices';
import { DID_KEY_ISSUER } from '../selfCertifyingKeyId';

import { PeerExchangeClient } from './PeerExchangeClient';
import { type PeerIdentity, PeerIdentityService } from './PeerIdentityService';
import { PeerLinkService } from './PeerLinkService';

/** Who was told, and who could not be: by link handle, the owner's own names for them. */
export interface NoticeOutcome {
  notified: string[];
  unreachable: string[];
}

/**
 * Keeping both ends of a link in step: telling the other person's box when
 * this person gets a new key or ends the link, and applying those notices when
 * they arrive.
 *
 * Sending is best effort and never undoes anything here: a key is rotated and a
 * link is ended on this box whether or not the other box hears. What the owner
 * is told is who was reached, so they can try again (rotation) or tell the
 * other person themselves.
 *
 * Applying is quiet: an arriving notice that matches no link changes nothing,
 * and the sender is answered the same either way, so a notice cannot be used to
 * find out who is linked to whom here.
 */
@Injectable()
export class PeerNoticeService {
  constructor(
    private readonly identityService: PeerIdentityService,
    private readonly peerLinkService: PeerLinkService,
    private readonly exchangeClient: PeerExchangeClient,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerNoticeService.name);
  }

  /** Give this person a new key and tell everyone they are linked to by key. */
  async rotateKey(context: UserServiceContext): Promise<NoticeOutcome> {
    const { previous, current } = await this.identityService.rotate(context.userId);

    return previous == null
      ? { notified: [], unreachable: [] }
      : this.announceRotation(context, previous, current);
  }

  /**
   * Tell everyone again, signed by the key retired last. For peers that were
   * unreachable the first time; one that already moved has no link naming the
   * old key any more, and the notice changes nothing there.
   */
  async resendRotation(context: UserServiceContext): Promise<NoticeOutcome> {
    const previous = await this.identityService.latestRetiredFor(context.userId);
    if (previous == null) {
      return { notified: [], unreachable: [] };
    }

    const current = await this.identityService.identityFor(context.userId);

    return this.announceRotation(context, previous, current);
  }

  /** Tell the other side `link` was ended. True when their box took the notice. */
  async announceUnlink(context: UserServiceContext, link: PeerLink): Promise<boolean> {
    if (link.peerIssuer !== DID_KEY_ISSUER || link.peerSubject == null) {
      return false;
    }

    const me = await this.identityService.identityFor(context.userId);
    const result = await this.exchangeClient.postSigned(
      link.memoryEndpoint,
      UNLINK_PATH,
      { v: 1, recipient: link.peerSubject },
      me.signer,
    );

    return result.ok;
  }

  /**
   * An arriving rotation notice, already verified: the request was signed by
   * `oldDidKey` and the proof by `newDidKey`. Moves the recipient's link from
   * the old key to the new one, keeping its tier, name and grants.
   */
  async applyRotation(oldDidKey: string, newDidKey: string, recipient: string): Promise<void> {
    const owner = await this.identityService.findActiveByDidKey(recipient);
    if (owner == null) {
      return;
    }

    const link = await this.peerLinkService.findActiveByIssuerSubject(
      owner.userId,
      DID_KEY_ISSUER,
      oldDidKey,
    );
    if (link == null) {
      return;
    }

    try {
      await this.peerLinkService.upsert(
        { userId: owner.userId },
        {
          peerHandle: link.peerHandle,
          memoryEndpoint: link.memoryEndpoint,
          peerIssuer: DID_KEY_ISSUER,
          peerSubject: newDidKey,
          expectedLinkId: link.id,
        },
      );
      this.logger.log(`peer ${link.peerHandle} moved to a new key`);
    } catch (error) {
      // Most likely the owner already has a link naming the new key. Leave both as they are.
      this.logger.warn(
        `rotation notice for ${link.peerHandle} not applied: ${error instanceof Error ? error.message : 'error'}`,
      );
    }
  }

  /** An arriving unlink notice, signed by `senderDidKey`: end the recipient's link to them. */
  async applyUnlink(senderDidKey: string, recipient: string): Promise<void> {
    const owner = await this.identityService.findActiveByDidKey(recipient);
    if (owner == null) {
      return;
    }

    const link = await this.peerLinkService.findActiveByIssuerSubject(
      owner.userId,
      DID_KEY_ISSUER,
      senderDidKey,
    );
    if (link == null) {
      return;
    }

    await this.peerLinkService.revoke({ userId: owner.userId }, link.peerHandle);
    this.logger.log(`peer ${link.peerHandle} ended the link from their side`);
  }

  private async announceRotation(
    context: UserServiceContext,
    previous: PeerIdentity,
    current: PeerIdentity,
  ): Promise<NoticeOutcome> {
    const links = (await this.peerLinkService.findAll(context)).filter(
      (link) =>
        link.status === 'active' &&
        link.revokedAt == null &&
        link.peerIssuer === DID_KEY_ISSUER &&
        link.peerSubject != null,
    );
    const outcome: NoticeOutcome = { notified: [], unreachable: [] };

    for (const link of links) {
      const notice = rotationNotice({
        oldDidKey: previous.didKey,
        newDidKey: current.didKey,
        newKey: current.signer.key,
        recipient: link.peerSubject as string,
      });
      const result = await this.exchangeClient.postSigned(
        link.memoryEndpoint,
        KEY_ROTATION_PATH,
        notice,
        previous.signer,
      );

      (result.ok ? outcome.notified : outcome.unreachable).push(link.peerHandle);
    }

    return outcome;
  }
}
