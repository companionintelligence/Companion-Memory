/**
 * Yield gates: a way for a background queue to stand aside while something
 * more urgent is using the resource its jobs would hold.
 *
 * The case that produced this: `image-description`, `llm` and two Python
 * sidecars all funnel into ONE single-slot Ollama runner. The description queue
 * dispatched its next picture the instant the previous one finished, so the
 * GPU never went idle and an interactive chat turn — which asks Ollama for a
 * different model, hence needs the GPU idle to swap — waited five minutes for
 * a response that never came (measured 2026-09-11: two consecutive turns ended
 * in the "I wasn't able to put together an answer" fallback).
 *
 * A queue opts in with `queueOptions.yieldsTo: '<gate name>'`. Before every
 * fetch the worker loop asks the named gate; while it answers `true` the loop
 * takes no lease — the jobs stay `created`, exactly as `paused` leaves them —
 * and re-asks on a short backoff. The job that was already running when the
 * gate closed finishes normally; yielding is between jobs, never inside one.
 *
 * Gates are registered by NAME because the events domain must not import the
 * domain that knows what "an interactive chat turn is pending" means. The
 * owner registers a predicate at boot (`YieldGateRegistry.register`), and a
 * queue that names a gate nobody registered does NOT yield — a missing gate is
 * logged once and treated as open, so a wiring mistake costs GPU contention,
 * never a silently frozen queue. A gate that THROWS is treated the same way,
 * for the same reason.
 */
export type YieldGate = () => Promise<boolean> | boolean;

export class YieldGateRegistry {
  private static gates = new Map<string, YieldGate>();

  static register(name: string, gate: YieldGate): void {
    this.gates.set(name, gate);
  }

  static has(name: string): boolean {
    return this.gates.has(name);
  }

  /**
   * `true` when the named gate is registered and currently asks the queue to
   * stand aside. Unknown gates and gates that throw both read as open; the
   * caller distinguishes "unknown" via {@link has} for its one-time warning.
   */
  static async shouldYield(name: string): Promise<boolean> {
    const gate = this.gates.get(name);

    if (gate == null) {
      return false;
    }

    try {
      return (await gate()) === true;
    } catch {
      return false;
    }
  }

  /** Test-only: forget every gate. */
  static clear(): void {
    this.gates.clear();
  }
}
