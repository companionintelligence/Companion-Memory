import { ConflictException, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  OUTBOUND_DEFAULT_ENABLED,
  OUTBOUND_PATH_KEYS,
  OutboundPolicyStore,
  outboundLockedReason,
  type OutboundPathKey,
} from '@ci/common/outbound';

/** One outbound path as the Settings card renders it. */
export interface OutboundPathDto {
  readonly key: OutboundPathKey;
  /** What the person chose. True when they have never chosen (the shipped default). */
  readonly enabled: boolean;
  /** What the appliance does right now: the choice, unless the operator forced the path off. */
  readonly effective: boolean;
  readonly default: boolean;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly updatedAt: string | null;
}

export interface OutboundSettingsDto {
  readonly paths: readonly OutboundPathDto[];
}

/**
 * Reads and writes `ci.outbound_settings`, and hands the process-wide
 * {@link OutboundPolicyStore} its connection at boot.
 *
 * `onModuleInit` awaits the first read for the reason `JobControlTracker` does:
 * the window after a restart is exactly when someone who switched a path off is
 * watching to see that it stayed off.
 */
@Injectable()
export class OutboundPolicyService implements OnModuleInit, OnModuleDestroy {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await OutboundPolicyStore.configure(this.dataSource);
  }

  onModuleDestroy(): void {
    OutboundPolicyStore.stop();
  }

  get(): OutboundSettingsDto {
    return { paths: OUTBOUND_PATH_KEYS.map(describe) };
  }

  /**
   * Record the user's choice for one path.
   *
   * Turning a locked path ON is refused — the operator's kill switch wins, and
   * accepting the write would show a switch that does nothing. Turning it OFF is
   * always allowed, so the choice is waiting if the operator later lifts the lock.
   */
  async set(key: OutboundPathKey, enabled: boolean, userId: string | undefined): Promise<OutboundSettingsDto> {
    const lockedReason = outboundLockedReason(key);

    if (enabled && lockedReason) {
      throw new ConflictException(lockedReason);
    }

    const rows = await this.dataSource.query<Array<{ updated_at: Date }>>(
      `INSERT INTO ci.outbound_settings (key, enabled, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE
         SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
       RETURNING updated_at`,
      [key, enabled, userId ?? null],
    );

    OutboundPolicyStore.applyLocal({
      key,
      enabled,
      updatedAt: rows[0]?.updated_at ?? new Date(),
      updatedBy: userId ?? null,
    });

    return this.get();
  }
}

function describe(key: OutboundPathKey): OutboundPathDto {
  const row = OutboundPolicyStore.row(key);
  const enabled = row?.enabled ?? OUTBOUND_DEFAULT_ENABLED;
  const lockedReason = outboundLockedReason(key);

  return {
    key,
    enabled,
    effective: enabled && !lockedReason,
    default: OUTBOUND_DEFAULT_ENABLED,
    locked: lockedReason !== null,
    lockedReason,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}
