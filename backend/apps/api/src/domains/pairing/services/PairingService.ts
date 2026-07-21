import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { UserEntity } from '@ci/domains/user';

import { PairingEntity } from '../entities/PairingEntity';

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CLIENT_TOKEN_EXPIRY = '90d';

export interface PairingStatusResult {
  status: 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'NOT_FOUND';
  userId?: string;
  userName?: string;
  userEmail?: string;
  deviceId?: string;
  accessToken?: string;
}

@Injectable()
export class PairingService {
  constructor(
    @InjectRepository(PairingEntity)
    private readonly repo: Repository<PairingEntity>,
    private readonly jwtService: JwtService,
  ) {}

  async startPairing(): Promise<{ pairingToken: string; pollKey: string }> {
    const pairingToken = randomBytes(32).toString('hex');
    const pollKey = randomBytes(32).toString('hex');

    await this.repo.save(
      this.repo.create({
        id: uuidv7(),
        pairing_token: pairingToken,
        poll_key: pollKey,
        status: 'PENDING',
        expires_at: new Date(Date.now() + PAIRING_TTL_MS),
      }),
    );

    return { pairingToken, pollKey };
  }

  async getStatus(pairingToken: string, pollKey: string): Promise<PairingStatusResult> {
    const pairing = await this.repo.findOne({ where: { pairing_token: pairingToken } });

    if (!pairing || pairing.poll_key !== pollKey) {
      return { status: 'NOT_FOUND' };
    }

    if (pairing.status === 'PENDING' && new Date() > pairing.expires_at) {
      pairing.status = 'EXPIRED';
      await this.repo.save(pairing);
    }

    if (pairing.status === 'COMPLETED') {
      return {
        status: 'COMPLETED',
        userId: pairing.user?.id,
        userName: pairing.user?.name,
        userEmail: pairing.user?.email,
        deviceId: pairing.device_id ?? undefined,
        accessToken: pairing.access_token ?? undefined,
      };
    }

    return { status: pairing.status };
  }

  async completePairing(pairingToken: string, userId: string): Promise<void> {
    const pairing = await this.repo.findOne({ where: { pairing_token: pairingToken } });

    if (!pairing || pairing.status !== 'PENDING' || new Date() > pairing.expires_at) {
      throw new BadRequestException('Pairing not found or has expired.');
    }

    const deviceId = uuidv7();
    const accessToken = this.jwtService.sign({ sub: userId }, { expiresIn: CLIENT_TOKEN_EXPIRY });

    pairing.status = 'COMPLETED';
    pairing.device_id = deviceId;
    pairing.access_token = accessToken;
    pairing.user = { id: userId } as UserEntity;

    await this.repo.save(pairing);
  }

  async cleanupExpired(): Promise<void> {
    await this.repo.delete({ status: 'PENDING', expires_at: LessThan(new Date()) });
  }
}
