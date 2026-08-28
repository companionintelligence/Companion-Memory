import {
  PENDING_ACTION_STATUSES,
  PENDING_ACTION_TRANSITIONS,
  TERMINAL_PENDING_ACTION_STATUSES,
  assertPendingActionTransition,
  authorisesExecution,
  canTransitionPendingAction,
  isTerminalPendingActionStatus,
  IllegalPendingActionTransitionError,
  type PendingActionStatus,
} from '../pendingActionStatus';

describe('pending action lifecycle', () => {
  it('allows exactly the documented forward edges', () => {
    expect(PENDING_ACTION_TRANSITIONS.proposed).toStrictEqual(['approved', 'declined', 'expired']);
    expect(PENDING_ACTION_TRANSITIONS.approved).toStrictEqual(['executed']);
    expect(PENDING_ACTION_TRANSITIONS.executed).toStrictEqual([]);
    expect(PENDING_ACTION_TRANSITIONS.declined).toStrictEqual([]);
    expect(PENDING_ACTION_TRANSITIONS.expired).toStrictEqual([]);
  });

  it('covers every status in the union, so a new state cannot be added without an edge decision', () => {
    expect(Object.keys(PENDING_ACTION_TRANSITIONS).sort()).toStrictEqual([...PENDING_ACTION_STATUSES].sort());
  });

  it('never re-opens a terminal status', () => {
    for (const status of TERMINAL_PENDING_ACTION_STATUSES) {
      expect(PENDING_ACTION_TRANSITIONS[status]).toHaveLength(0);
      expect(isTerminalPendingActionStatus(status)).toBe(true);
    }
  });

  it('gives an approved action no way back to declined or expired', () => {
    // The two omissions the docblock argues for: once the owner said yes the
    // call is in flight, so a later "declined" would be a lie and a later
    // "expired" would race the confirmed run.
    expect(canTransitionPendingAction('approved', 'declined')).toBe(false);
    expect(canTransitionPendingAction('approved', 'expired')).toBe(false);
    expect(canTransitionPendingAction('approved', 'executed')).toBe(true);
  });

  it('refuses to skip the approval step', () => {
    expect(canTransitionPendingAction('proposed', 'executed')).toBe(false);
    expect(() => assertPendingActionTransition('proposed', 'executed')).toThrow(
      IllegalPendingActionTransitionError,
    );
  });

  it('returns the target status on a legal edge and throws with both ends named on an illegal one', () => {
    expect(assertPendingActionTransition('proposed', 'approved')).toBe('approved');

    let thrown: unknown;
    try {
      assertPendingActionTransition('declined', 'approved');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(IllegalPendingActionTransitionError);
    expect((thrown as IllegalPendingActionTransitionError).from).toBe('declined');
    expect((thrown as IllegalPendingActionTransitionError).to).toBe('approved');
    expect((thrown as Error).message).toContain('declined → approved');
  });

  it('authorises execution from `approved` and from nothing else', () => {
    const authorising = (PENDING_ACTION_STATUSES as readonly PendingActionStatus[]).filter(
      authorisesExecution,
    );

    expect(authorising).toStrictEqual(['approved']);
    expect(authorising).toHaveLength(1);
  });
});
