import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { ApiKeyCapability } from '@ci/common/decorators';

import type { IntentAccess, IntentDomainKey } from '../core/types';
import type { ToolInvocationOutcome } from '../events';

/**
 * One tool (intent) invocation, written by `ToolInvokedListener` off the durable `tool.invoked`
 * event and read by `ToolInvocationsController`.
 *
 * See migration `20260826202414_create_tool_invocations.sql` for the two things that are NOT here
 * and why: request bodies and response bodies. This is a triage/telemetry table — best-effort,
 * lossy at the retention edge, and deliberately not an audit log (`ci.ask_audit`,
 * `ci.graph_deltas`, `ci.cron_runs` and `ci.data_deletion_audit` are the durable records).
 */
@Entity({ schema: 'ci', name: 'tool_invocations' })
@Index(['userId', 'occurredAt'])
@Index(['tool', 'occurredAt'])
export class ToolInvocationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** NULL for a system / in-process caller acting as the appliance itself. */
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;

  /** Dotted intent id, e.g. `memory.recall`. */
  @Column({ type: 'text', name: 'intent' })
  intent!: string;

  /** Executable name the caller used, e.g. `memory_recall`. */
  @Column({ type: 'text', name: 'tool' })
  tool!: string;

  /** NULL on the GraphQL-over-MCP plane, which has no domain vocabulary. */
  @Column({ type: 'text', name: 'domain', nullable: true })
  domain!: IntentDomainKey | null;

  /** Registry provider name (`native`, `mcp-client`, …) or `graphql`. */
  @Column({ type: 'text', name: 'source' })
  source!: string;

  /** `RequestContext.traceId`. */
  @Column({ type: 'uuid', name: 'correlation_id', nullable: true })
  correlationId!: string | null;

  /**
   * `ci.api_keys.id` of the key that authenticated, stamped by `ApiKeyStrategy`. No FK on purpose:
   * the row must outlive a revoked key, which is exactly when someone reads it.
   */
  @Column({ type: 'uuid', name: 'api_key_id', nullable: true })
  apiKeyId!: string | null;

  @Column({ type: 'text', name: 'capability', nullable: true })
  capability!: ApiKeyCapability | null;

  @Column({ type: 'text', name: 'access', nullable: true })
  access!: IntentAccess | null;

  @Column({ type: 'boolean', name: 'external', default: false })
  external!: boolean;

  @Column({ type: 'boolean', name: 'destructive', default: false })
  destructive!: boolean;

  @Column({ type: 'text', name: 'outcome' })
  outcome!: ToolInvocationOutcome;

  @Column({ type: 'text', name: 'error_code', nullable: true })
  errorCode!: string | null;

  /**
   * Truncated by the writer to TOOL_INVOCATION_ERROR_MAX_LENGTH, and bounded again by a CHECK on
   * the column: this is the only field that can carry a fragment of the user's own content, so the
   * cap lives in the schema as well as in the code that fills it.
   */
  @Column({ type: 'text', name: 'error', nullable: true })
  error!: string | null;

  @Column({ type: 'integer', name: 'duration_ms', nullable: true })
  durationMs!: number | null;
}
