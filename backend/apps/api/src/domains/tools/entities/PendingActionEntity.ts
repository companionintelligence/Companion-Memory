import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { ApiKeyCapability } from '@ci/common/decorators';

import type { PendingActionStatus } from '../pendingActionStatus';
import type { DispatchTier } from '../policy/dispatchPolicy';
import type { ToolGateReason } from '../policy/toolGate';

/**
 * `ci.pending_actions` — an intent the gate refused to run unconfirmed.
 *
 * The FIRST TypeORM entity in `domains/tools`, which until now had no database
 * access of any kind. That cost is deliberate and named in the PR: the queue the
 * dispatch policy has always described has to live somewhere durable, because
 * its whole purpose is to survive the request that proposed it and wait for a
 * human. Keeping it in memory would reproduce the defect this fixes — a promise
 * with nothing behind it.
 *
 * Mirrors `db/postgres/migrations/20260826202654_create_pending_actions.sql`,
 * which is the source of truth.
 */
@Entity({ schema: 'ci', name: 'pending_actions' })
export class PendingActionEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  /** The owner whose confirmation is required. FK to `ci.users`, cascade delete. */
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** Dotted intent id, e.g. `messaging.send`. */
  @Column({ type: 'text', name: 'intent' })
  intent!: string;

  /** Executable tool name, e.g. `messaging_send` — the key `executeTool` takes. */
  @Column({ type: 'text', name: 'tool' })
  tool!: string;

  /** The exact tool input, so approval replays rather than re-derives. */
  @Column({ type: 'jsonb', name: 'input' })
  input!: unknown;

  @Column({ type: 'text', name: 'reason' })
  reason!: ToolGateReason;

  /** The dispatch tier the proposing call arrived from. */
  @Column({ type: 'text', name: 'origin' })
  origin!: DispatchTier;

  /**
   * The authority the PROPOSING caller held — recorded precisely because the
   * confirm path does not reuse it. See `PendingActionService.approve`.
   */
  @Column({ type: 'text', name: 'actor' })
  actor!: ApiKeyCapability;

  @Column({ type: 'text', name: 'status' })
  status!: PendingActionStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'resolved_at', nullable: true })
  resolvedAt!: Date | null;

  /** The ToolResult of the confirmed run, once there is one. */
  @Column({ type: 'jsonb', name: 'result', nullable: true })
  result!: unknown;
}

export type PendingAction = Readonly<PendingActionEntity>;
