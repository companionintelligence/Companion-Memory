import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7, validate as uuidValidate } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';

import { UserSnapshotEntity } from '../entities/UserSnapshotEntity';

// Frozen wire value. The client is now called Companion Capture (repo
// CI-Capture), but this string must keep matching what it sends — see
// `producer` in CI-Capture's src/db.rs. Renaming it here breaks ingest.
const APPLET_PRODUCER = 'ci-applet-vizier';
const SNAPSHOT_KINDS = new Set(['snapshot', 'patch']);

export interface CreateUserSnapshotDto {
  deviceId: string;
  sessionId: string;
  snapshotKind: string;
  observedAt: Date;
  monotonicMs: number;
  payload: Record<string, unknown>;
  focusApp?: string | null;
  focusTitle?: string | null;
  cwd?: string | null;
  fsEventCount: number;
}

@Injectable()
export class UserSnapshotService {
  constructor(
    @InjectRepository(UserSnapshotEntity)
    private readonly userSnapshotRepository: Repository<UserSnapshotEntity>,
  ) {}

  async create(context: UserServiceContext, data: CreateUserSnapshotDto): Promise<void> {
    if (!uuidValidate(data.deviceId)) {
      throw new BadRequestException('deviceId must be a UUID.');
    }

    if (!uuidValidate(data.sessionId)) {
      throw new BadRequestException('sessionId must be a UUID.');
    }

    if (!SNAPSHOT_KINDS.has(data.snapshotKind)) {
      throw new BadRequestException('snapshotKind must be either snapshot or patch.');
    }

    if (!(data.observedAt instanceof Date) || Number.isNaN(data.observedAt.getTime())) {
      throw new BadRequestException('observedAt must be a valid timestamp.');
    }

    if (!Number.isFinite(data.monotonicMs) || data.monotonicMs < 0) {
      throw new BadRequestException('monotonicMs must be a non-negative number.');
    }

    if (!Number.isInteger(data.fsEventCount) || data.fsEventCount < 0) {
      throw new BadRequestException('fsEventCount must be a non-negative integer.');
    }

    if (data.payload == null || Array.isArray(data.payload) || typeof data.payload !== 'object') {
      throw new BadRequestException('payload must be a JSON object.');
    }

    const entity = this.userSnapshotRepository.create({
      snapshot_id: uuid7(),
      observed_at: data.observedAt,
      user_id: context.userId,
      device_id: data.deviceId,
      session_id: data.sessionId,
      producer: APPLET_PRODUCER,
      snapshot_kind: data.snapshotKind,
      monotonic_ms: Math.trunc(data.monotonicMs),
      payload: data.payload,
      focus_app: data.focusApp ?? null,
      focus_title: data.focusTitle ?? null,
      cwd: data.cwd ?? null,
      fs_event_count: data.fsEventCount,
    });

    await this.userSnapshotRepository.save(entity);
  }
}
