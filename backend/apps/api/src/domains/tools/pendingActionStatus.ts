/**
 * The pending-action lifecycle, as a pure transition table.
 *
 * Deliberately the same shape as `domains/asks/askStatus.ts` — `ASK_TRANSITIONS`
 * + `canTransitionAsk` + `assertAskTransition` + `IllegalAskTransitionError` —
 * because that module is the one place in this codebase where a security-bearing
 * state machine is asserted BEFORE the side effect rather than validated after
 * it, and this queue holds the same kind of decision: an action the user has not
 * yet authorised.
 *
 * No Nest wiring, no repository: every rule here is testable without a database,
 * which is the point.
 */

export const PENDING_ACTION_STATUSES = ['proposed', 'approved', 'executed', 'declined', 'expired'] as const;

export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];

/**
 * Legal forward transitions.
 *
 * ```
 * proposed → approved → executed
 *    ↘ declined          (terminal)
 *    ↘ expired
 * ```
 *
 * `approved` carries NO `declined` edge and NO `expired` edge, and both
 * omissions are load-bearing:
 *
 * - **declined**: once the owner has said yes, the tool call is already in
 *   flight through `ToolRegistry.executeTool`. "Un-approving" it would record a
 *   refusal for work that may well have happened — a lie in the audit trail,
 *   and worse than an honest `executed` row whose `result` says it failed.
 * - **expired**: the deadline exists to stop an *unanswered* proposal from
 *   staying answerable forever. An approved action was answered. Letting the
 *   sweep retire it would race the confirmed run and could mark as "expired"
 *   an action that fired one second earlier.
 *
 * A run that never reports back therefore parks in `approved`, visibly, instead
 * of being tidied into a terminal state that misdescribes it.
 */
export const PENDING_ACTION_TRANSITIONS: Readonly<
  Record<PendingActionStatus, readonly PendingActionStatus[]>
> = {
  proposed: ['approved', 'declined', 'expired'],
  approved: ['executed'],
  executed: [],
  declined: [],
  expired: [],
};

export const TERMINAL_PENDING_ACTION_STATUSES: readonly PendingActionStatus[] = [
  'executed',
  'declined',
  'expired',
];

export function isTerminalPendingActionStatus(status: PendingActionStatus): boolean {
  return TERMINAL_PENDING_ACTION_STATUSES.includes(status);
}

export function canTransitionPendingAction(from: PendingActionStatus, to: PendingActionStatus): boolean {
  return PENDING_ACTION_TRANSITIONS[from].includes(to);
}

/** Thrown when a pending action is moved along an illegal edge of the lifecycle. */
export class IllegalPendingActionTransitionError extends Error {
  constructor(
    public readonly from: PendingActionStatus,
    public readonly to: PendingActionStatus,
  ) {
    super(`Illegal pending action transition: ${from} → ${to}`);
    this.name = 'IllegalPendingActionTransitionError';
  }
}

/** Returns `to` if the transition is legal, otherwise throws. Pure. */
export function assertPendingActionTransition(
  from: PendingActionStatus,
  to: PendingActionStatus,
): PendingActionStatus {
  if (!canTransitionPendingAction(from, to)) {
    throw new IllegalPendingActionTransitionError(from, to);
  }

  return to;
}

/**
 * Whether this row may still authorise a run.
 *
 * Extracted for the same reason `isAnswerable` was in the asks domain: the
 * check has to be available BEFORE the side effect. `ToolRegistry.executeTool`
 * asks it when a caller presents a `pendingActionId`, and only an `approved`
 * row — one the owner actually said yes to — lets the gate stand aside.
 */
export function authorisesExecution(status: PendingActionStatus): boolean {
  return status === 'approved';
}
