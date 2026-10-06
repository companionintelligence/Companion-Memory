import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import type { IntentPrivacy, ToolResult } from '../core/types';

/**
 * A way to run a confirmed pending action whose tool is not in the {@link ToolRegistry}.
 *
 * Everything the registry runs is replayed through `ToolRegistry.executeTool`, which is the one
 * chokepoint. The GraphQL plane of `/api/mcp` is the exception: its tools are the GraphQL schema's
 * root fields, run through the GraphQL executor with the caller's HTTP request as context, and they
 * were never registry tools. Before they were gated, a `mutation_deletePerson` over MCP ran at once
 * while `memory_forget` over the same connection waited for a card. They are gated now, and a
 * gated call needs a way back when the owner says yes. The MCP domain registers that way here, so
 * the tools domain never has to import it (the dependency runs `mcp → tools`).
 */
export interface PendingActionReplayer {
  /** The label `tool` is gated and capability-checked by, or `undefined` when this replayer does not run it. */
  privacyOf(tool: string): IntentPrivacy | undefined;

  /**
   * Refuse, before the row is marked approved, a confirming request that could not run `tool` on
   * this plane at all. Throws an HTTP exception; returns nothing when the request may.
   */
  assertMayReplay(tool: string, request: Request | undefined): void;

  /**
   * Run the approved call as the confirming request. Never throws: a failure is a failed result.
   * `origin` says who asked for the call, for the ledger: the confirming request is the owner's.
   */
  replay(tool: string, input: unknown, request: Request, origin?: PendingActionOrigin): Promise<ToolResult>;
}

/** Who asked for a pending action, read from its row: the asking app, or `null` for the owner. */
export interface PendingActionOrigin {
  principalName: string | null;
}

/** The replayers other domains have registered, consulted by `PendingActionConfirmService`. */
@Injectable()
export class PendingActionReplayRegistry {
  private readonly replayers: PendingActionReplayer[] = [];

  register(replayer: PendingActionReplayer): void {
    this.replayers.push(replayer);
  }

  /** The replayer that runs `tool`, with the label it is judged by. */
  find(tool: string): { replayer: PendingActionReplayer; privacy: IntentPrivacy } | undefined {
    for (const replayer of this.replayers) {
      const privacy = replayer.privacyOf(tool);

      if (privacy) {
        return { replayer, privacy };
      }
    }

    return undefined;
  }
}
