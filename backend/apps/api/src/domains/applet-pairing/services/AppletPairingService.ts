import * as crypto from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { UserEntity } from '@ci/domains/user';

import { type AppletPairing, AppletPairingEntity } from '../entities/AppletPairingEntity';
import { UserSnapshotEntity } from '../entities/UserSnapshotEntity';

// The applet stores its token persistently and has no refresh flow, so the
// approval mints a long-lived device access token.
const APPLET_TOKEN_DURATION = '365d';
// A pending pairing must be approved within this window.
const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface SnapshotInput {
  deviceId: string;
  sessionId: string;
  snapshotKind: string;
  observedAt: string;
  monotonicMs: number;
  payload: Record<string, unknown>;
  focusApp?: string | null;
  focusTitle?: string | null;
  cwd?: string | null;
  fsEventCount: number;
}

@Injectable()
export class AppletPairingService {
  constructor(
    @InjectRepository(AppletPairingEntity)
    private readonly pairingRepository: Repository<AppletPairingEntity>,
    @InjectRepository(UserSnapshotEntity)
    private readonly snapshotRepository: Repository<UserSnapshotEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly jwtService: JwtService,
  ) {}

  /** Begin a pairing: the applet gets a shared pairing token + a secret poll key. */
  async start(): Promise<AppletPairing> {
    const pairing = this.pairingRepository.create({
      id: uuidv7(),
      pairing_token: crypto.randomBytes(32).toString('hex'),
      poll_key: crypto.randomBytes(32).toString('hex'),
      status: 'PENDING',
      expires_at: new Date(Date.now() + PAIRING_TTL_MS),
    });

    return this.pairingRepository.save(pairing);
  }

  /**
   * Poll a pairing's status. The poll key must match — a wrong key reads as
   * "not found" so it can't be used to probe for valid tokens or read a token.
   */
  async status(pairingToken: string, pollKey: string): Promise<AppletPairing | null> {
    const pairing = await this.pairingRepository.findOne({
      where: { pairing_token: pairingToken },
    });

    if (!pairing || pairing.poll_key !== pollKey) {
      return null;
    }

    return pairing;
  }

  /**
   * Approve a pending pairing for the authenticated user: mint a long-lived
   * device token and assign a device id. Returns null when the token is
   * unknown, already used, or expired.
   */
  async approve(pairingToken: string, userId: string): Promise<AppletPairing | null> {
    const pairing = await this.pairingRepository.findOne({
      where: { pairing_token: pairingToken },
    });

    if (!pairing || pairing.status !== 'PENDING' || this.isExpired(pairing)) {
      return null;
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    const deviceId = uuidv7();
    const appletAccessToken = this.jwtService.sign(
      { sub: userId },
      { expiresIn: APPLET_TOKEN_DURATION },
    );

    await this.pairingRepository.update(pairing.id, {
      status: 'COMPLETED',
      user_id: userId,
      user_name: user?.name ?? null,
      user_email: user?.email ?? null,
      device_id: deviceId,
      applet_access_token: appletAccessToken,
    });

    return this.pairingRepository.findOne({ where: { id: pairing.id } });
  }

  /** Persist one activity snapshot streamed by a paired applet. */
  async recordSnapshot(userId: string, input: SnapshotInput): Promise<void> {
    const snapshot = this.snapshotRepository.create({
      id: uuidv7(),
      user_id: userId,
      device_id: input.deviceId,
      session_id: input.sessionId,
      snapshot_kind: input.snapshotKind,
      observed_at: new Date(input.observedAt),
      monotonic_ms: String(input.monotonicMs),
      payload: input.payload ?? {},
      focus_app: input.focusApp ?? null,
      focus_title: input.focusTitle ?? null,
      cwd: input.cwd ?? null,
      fs_event_count: input.fsEventCount ?? 0,
    });

    await this.snapshotRepository.save(snapshot);
  }

  isExpired(pairing: AppletPairing): boolean {
    return pairing.status === 'PENDING' && pairing.expires_at.getTime() < Date.now();
  }
}
