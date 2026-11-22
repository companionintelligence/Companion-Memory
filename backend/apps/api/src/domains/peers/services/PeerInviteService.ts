import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod/v3';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { isDidKeyId } from '../didKeyId';
import { type PeerInviteStatus, PeerInviteEntity, inviteStatus } from '../entities/PeerInviteEntity';
import { type PeerLink } from '../entities/PeerLinkEntity';
import {
  cleanPersonName,
  encodeInviteCode,
  handleFromName,
  hashInviteSecret,
  isInviteSecret,
  newInviteSecret,
  parseInviteCode,
  uniqueHandle,
} from '../inviteCode';
import { publishedBase } from '../peerRequest';
import { DID_KEY_ISSUER } from '../selfCertifyingKeyId';

import { PeerExchangeClient } from './PeerExchangeClient';
import { PeerIdentityService } from './PeerIdentityService';
import { PeerLinkService } from './PeerLinkService';

/** How long an invite can be accepted for. Long enough to send it and be answered tomorrow. */
export const INVITE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Most invites one person may have waiting at once, so a stuck client cannot fill the table. */
const MAX_PENDING_INVITES = 20;

/** The path, under the inviter's `/agent/v1`, where an invite is accepted. */
export const INVITE_ACCEPT_PATH = '/invites/accept';

/** What the accepting box sends, signed by the accepting person's key. */
const acceptBodySchema = z.object({
  v: z.literal(1),
  secret: z.string().refine(isInviteSecret),
  didKey: z.string().refine(isDidKeyId),
  endpoint: z.string().max(500),
  name: z.string().max(200),
});

/** What the inviting box answers. Untrusted on the accepting side; checked there. */
export interface InviteAcceptance {
  v: 1;
  didKey: string;
  name: string;
}

/** An invite as its owner sees it. The secret is not part of it: it exists only in the code. */
export interface PeerInviteView {
  id: string;
  label: string | null;
  inviterName: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  status: PeerInviteStatus;
}

/** One refusal for every way an invite is not acceptable, so a caller learns nothing about which. */
const NO_SUCH_INVITE = 'This invite has expired, was already used, or was withdrawn';

/**
 * Linking two people's Companions with one shared code.
 *
 * ═══ THE FLOW ═══
 *
 *   A (inviter)                                   B (accepts)
 *   create → code {A's address, A's did:key,
 *                  secret, A's name}  ── handed to B by the people ──▶ paste
 *                                                 verify A's address holds A's key
 *   ◀──────── POST /invites/accept {secret, B's did:key, B's address, B's name},
 *             signed by B's key ─────────────────
 *   check the signature is B's key
 *   check the secret names a live invite
 *   verify B's address holds B's key
 *   claim the invite (once), link B by key
 *   ──────── {A's did:key, A's name} ───────────▶ link A by key
 *
 * Both links are at `stranger`, the narrowest tier; each owner raises theirs by
 * choice. Neither box ever learns a key it did not check against the address
 * it will send asks to, and Portal is not involved at any step, so it never
 * learns who is linked to whom.
 */
@Injectable()
export class PeerInviteService {
  constructor(
    @InjectRepository(PeerInviteEntity)
    private readonly repository: Repository<PeerInviteEntity>,
    private readonly identityService: PeerIdentityService,
    private readonly peerLinkService: PeerLinkService,
    private readonly exchangeClient: PeerExchangeClient,
    private readonly userService: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerInviteService.name);
  }

  /** Make an invite. The code is returned once, here, and never again. */
  async create(
    context: UserServiceContext,
    options: { name?: string | null; label?: string | null } = {},
    now: Date = new Date(),
  ): Promise<{ invite: PeerInviteView; code: string }> {
    const endpoint = this.ownEndpoint();
    const pending = await this.repository.count({
      where: { ownerUserId: context.userId, usedAt: IsNull(), revokedAt: IsNull(), expiresAt: MoreThan(now) },
    });

    if (pending >= MAX_PENDING_INVITES) {
      throw new BadRequestException(`You have ${pending} invites waiting. Withdraw some before making more.`);
    }

    const identity = await this.identityService.identityFor(context.userId);
    const name = cleanPersonName(options.name) ?? (await this.ownName(context)) ?? 'A Companion';
    const secret = newInviteSecret();

    const row = this.repository.create({
      id: uuidv7(),
      ownerUserId: context.userId,
      secretHash: hashInviteSecret(secret),
      inviterDidKey: identity.didKey,
      inviterName: name,
      label: cleanPersonName(options.label),
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
      usedAt: null,
      usedLinkId: null,
      revokedAt: null,
    });
    const saved = await this.repository.save(row);

    return {
      invite: toView(saved, now),
      code: encodeInviteCode({ endpoint, didKey: identity.didKey, secret, name }),
    };
  }

  /** The owner's invites, newest first. */
  async list(context: UserServiceContext, now: Date = new Date()): Promise<PeerInviteView[]> {
    const rows = await this.repository.find({
      where: { ownerUserId: context.userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });

    return rows.map((row) => toView(row, now));
  }

  /** Withdraw a waiting invite. One already used or expired is left as it is. */
  async revoke(context: UserServiceContext, id: string, now: Date = new Date()): Promise<PeerInviteView> {
    await this.repository.update(
      { id, ownerUserId: context.userId, usedAt: IsNull(), revokedAt: IsNull() },
      { revokedAt: now },
    );

    const row = await this.repository.findOne({ where: { id, ownerUserId: context.userId } });
    if (row == null) {
      throw new NotFoundException('No such invite');
    }

    return toView(row, now);
  }

  /**
   * ACCEPTING SIDE: link to the person whose invite `rawCode` is, and have
   * their box link back. Returns the new link on this box.
   */
  async accept(
    context: UserServiceContext,
    rawCode: string,
    options: { displayName?: string | null; myName?: string | null } = {},
  ): Promise<PeerLink> {
    const code = parseInviteCode(rawCode);
    if (code == null) {
      throw new BadRequestException('That is not an invite code');
    }

    const myEndpoint = this.ownEndpoint();
    const me = await this.identityService.identityFor(context.userId);

    if (code.didKey === me.didKey) {
      throw new BadRequestException('This is your own invite');
    }

    if (
      (await this.peerLinkService.findActiveByIssuerSubject(context.userId, DID_KEY_ISSUER, code.didKey)) !=
      null
    ) {
      throw new ConflictException('You are already linked to them');
    }

    // Before anything is sent: their address must hold the key the code names.
    // Otherwise a code edited on the way could point this box at someone else.
    const proof = await this.exchangeClient.verifyIdentity(code.endpoint, code.didKey);
    if (!proof.ok) {
      this.logger.warn(`invite refused: their Companion did not prove its key (${proof.reason})`);
      throw new BadRequestException(
        'Their Companion could not be reached, or did not confirm the key in this invite',
      );
    }

    const myName = cleanPersonName(options.myName) ?? (await this.ownName(context)) ?? 'A Companion';
    const reply = await this.exchangeClient.postSigned(
      code.endpoint,
      INVITE_ACCEPT_PATH,
      { v: 1, secret: code.secret, didKey: me.didKey, endpoint: myEndpoint, name: myName },
      me.signer,
    );

    if (!reply.ok) {
      throw new BadRequestException(
        reply.status === 404 ? NO_SUCH_INVITE : 'Their Companion did not accept the invite. Try again later.',
      );
    }

    const acceptance = reply.value as Partial<InviteAcceptance> | null;
    if (acceptance?.v !== 1 || acceptance.didKey !== code.didKey) {
      throw new BadRequestException('Their Companion answered with a different key than the invite named');
    }

    const name = cleanPersonName(options.displayName) ?? cleanPersonName(acceptance.name) ?? code.name;

    return this.linkByKey(context.userId, { didKey: code.didKey, endpoint: code.endpoint, name });
  }

  /**
   * INVITING SIDE: the other person's box presents an invite's secret, in a
   * request the controller has already verified was signed by `senderDidKey`.
   */
  async receive(senderDidKey: string, body: unknown, now: Date = new Date()): Promise<InviteAcceptance> {
    const parsed = acceptBodySchema.safeParse(body);
    if (!parsed.success || parsed.data.didKey !== senderDidKey) {
      throw new BadRequestException('Malformed invite acceptance');
    }

    const endpoint = publishedBase(parsed.data.endpoint);
    const name = cleanPersonName(parsed.data.name);
    if (endpoint == null || !endpoint.startsWith('https://') || name == null) {
      throw new BadRequestException('Malformed invite acceptance');
    }

    const invite = await this.repository.findOne({
      where: { secretHash: hashInviteSecret(parsed.data.secret) },
    });

    // The checks that need no network go first, so a caller without a live
    // invite's secret can never make this box dial anywhere.
    if (
      invite == null ||
      inviteStatus(invite, now) !== 'pending' ||
      invite.inviterDidKey === senderDidKey ||
      (await this.identityService.existingDidKeyFor(invite.ownerUserId)) !== invite.inviterDidKey
    ) {
      throw new NotFoundException(NO_SUCH_INVITE);
    }

    const proof = await this.exchangeClient.verifyIdentity(endpoint, senderDidKey);
    if (!proof.ok) {
      this.logger.warn(
        `invite acceptance refused: the accepting Companion did not prove its key (${proof.reason})`,
      );
      throw new BadRequestException(
        'Could not confirm your Companion holds your key at the address you gave',
      );
    }

    // Once, whoever races: only the update that finds it still unused wins.
    const claimed = await this.repository.update(
      { id: invite.id, usedAt: IsNull(), revokedAt: IsNull(), expiresAt: MoreThan(now) },
      { usedAt: now },
    );
    if (!claimed.affected) {
      throw new NotFoundException(NO_SUCH_INVITE);
    }

    let link: PeerLink;
    try {
      link = await this.linkByKey(invite.ownerUserId, { didKey: senderDidKey, endpoint, name });
    } catch (error) {
      // Give the invite back: nothing was linked, so it has not been used.
      await this.repository.update({ id: invite.id }, { usedAt: null });
      throw error;
    }

    await this.repository.update({ id: invite.id }, { usedLinkId: link.id });
    this.logger.log(`invite accepted: linked ${link.peerHandle} by key`);

    return { v: 1, didKey: invite.inviterDidKey, name: invite.inviterName };
  }

  /**
   * The owner's live link to `didKey`, made now at `stranger` if there is
   * none. The handle is made from the name and is one this owner has never
   * used, ended links included: reusing an ended link's handle would read as
   * adding that person back.
   */
  private async linkByKey(
    ownerUserId: string,
    peer: { didKey: string; endpoint: string; name: string },
  ): Promise<PeerLink> {
    const existing = await this.peerLinkService.findActiveByIssuerSubject(
      ownerUserId,
      DID_KEY_ISSUER,
      peer.didKey,
    );
    if (existing != null) {
      return existing;
    }

    const context: UserServiceContext = { userId: ownerUserId };
    const taken = new Set((await this.peerLinkService.findAll(context)).map((link) => link.peerHandle));

    return this.peerLinkService.upsert(context, {
      peerHandle: uniqueHandle(handleFromName(peer.name), taken),
      memoryEndpoint: peer.endpoint,
      displayName: peer.name,
      peerIssuer: DID_KEY_ISSUER,
      peerSubject: peer.didKey,
      trustTier: 'stranger',
      status: 'active',
    });
  }

  /** This box's `/agent/v1` address as peers must dial it, or a refusal naming what is missing. */
  private ownEndpoint(): string {
    const endpoint = publishedBase(config.peers?.memoryEndpoint);
    if (endpoint == null || !endpoint.startsWith('https://')) {
      throw new BadRequestException(
        'This Companion has no https address other Companions can reach it at (peers.memoryEndpoint), so it cannot link with anyone yet',
      );
    }

    return endpoint;
  }

  private async ownName(context: UserServiceContext): Promise<string | null> {
    const user = await this.userService.findById(context, context.userId);

    return cleanPersonName(user?.name);
  }
}

function toView(row: PeerInviteEntity, now: Date): PeerInviteView {
  return {
    id: row.id,
    label: row.label,
    inviterName: row.inviterName,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
    status: inviteStatus(row, now),
  };
}
