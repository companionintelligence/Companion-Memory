import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import type { ApiKeyCapability } from '@ci/common/decorators';
import { LoggerService } from '@ci/common/logging';

import type { ToolResult } from '../core/types';
import type { PendingAction } from '../entities/PendingActionEntity';
import { capabilityAllows, capabilityRequiredFor } from '../policy';
import { ToolRegistry } from '../registry/ToolRegistry';

import { PendingActionService } from './PendingActionService';

export interface ConfirmOutcome {
  action: PendingAction;
  result: ToolResult;
}

/**
 * Runs a pending action the owner has confirmed.
 *
 * Lives apart from {@link PendingActionService} so the dependency graph stays a
 * line rather than a loop: `ToolRegistry → PendingActionService` (ask the gate,
 * write the row), and `PendingActionConfirmService → { ToolRegistry,
 * PendingActionService }` (replay it). Nothing needs a `forwardRef`.
 *
 * ## The rule this class exists to hold
 *
 * **Approval re-runs the capability check against the CONFIRMING principal.**
 * `ci.pending_actions.actor` records the authority the proposing caller had, and
 * this path deliberately ignores it. A read-only key tapping approve on a
 * `memory.forget` proposed by a full-capability dispatcher gets a 403 and the
 * row stays `proposed` — otherwise the queue would be a capability escalator:
 * park work as one principal, confirm it as a weaker one, have it run with the
 * stronger one's authority.
 *
 * The check is made twice on purpose. Here, so approval fails loudly with an
 * HTTP status and no state change; and again inside
 * `ToolRegistry.executeTool`, which is the chokepoint every dispatcher passes
 * and the only place that can be trusted to have been reached.
 */
@Injectable()
export class PendingActionConfirmService {
  constructor(
    private readonly pending: PendingActionService,
    private readonly registry: ToolRegistry,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PendingActionConfirmService.name);
  }

  async confirm(
    userId: string,
    id: string,
    capability: ApiKeyCapability,
    now: Date = new Date(),
  ): Promise<ConfirmOutcome> {
    const row = await this.pending.findForUser(userId, id);

    if (!row) {
      throw new NotFoundException(`Unknown pending action: ${id}`);
    }

    if (row.status !== 'proposed') {
      throw new ConflictException(`Pending action ${id} is already ${row.status}`);
    }

    if (row.expiresAt != null && row.expiresAt.getTime() <= now.getTime()) {
      // Retire it here rather than leaving it for the sweep: the owner is
      // looking at it right now, and "it says pending but refuses to run" is a
      // worse answer than "it expired".
      await this.pending.expire(userId, id);

      throw new ConflictException(`Pending action ${id} has expired`);
    }

    const tool = this.registry.getTool(row.tool);

    if (!tool) {
      throw new ConflictException(`Intent '${row.intent}' is no longer registered on this appliance`);
    }

    const { privacy } = tool.schema;

    if (!capabilityAllows(privacy, capability)) {
      const required = capabilityRequiredFor(privacy);

      this.logger.warn(`Refused confirmation of pending action ${id}`, {
        intent: row.intent,
        userId,
        confirmingCapability: capability,
        proposingCapability: row.actor,
        requiredCapability: required,
      });

      throw new ForbiddenException(
        `Confirming '${row.intent}' requires "${required}" access, but this caller is "${capability}"`,
      );
    }

    await this.pending.markApproved(userId, id);

    // Back through the ONE chokepoint, with the confirming principal's
    // authority — not the proposing one's — and the row id, which is the only
    // thing that lets the gate stand aside (and only after re-reading the row
    // and finding it `approved`).
    const result = await this.registry.executeTool(
      row.tool,
      { userId, capability, pendingActionId: id },
      row.input,
    );

    const action = await this.pending.markExecuted(userId, id, result);

    this.logger.log(`Executed confirmed pending action ${id}`, {
      intent: row.intent,
      userId,
      confirmingCapability: capability,
      proposingCapability: row.actor,
      success: result.success,
    });

    return { action, result };
  }

  async decline(userId: string, id: string): Promise<PendingAction> {
    const row = await this.pending.findForUser(userId, id);

    if (!row) {
      throw new NotFoundException(`Unknown pending action: ${id}`);
    }

    if (row.status !== 'proposed') {
      throw new ConflictException(`Pending action ${id} is already ${row.status}`);
    }

    return this.pending.decline(userId, id);
  }
}
