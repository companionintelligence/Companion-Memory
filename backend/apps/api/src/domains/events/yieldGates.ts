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
 * gate closed finishes normally; the worker loop yields between jobs, never
 * inside one. A job that is itself several generations in a row asks the
 * gate between them (ImageDescriptionListener, for a video's frames).
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

/**
 * The longest a worker loop waits on a gate's answer before treating it as
 * open. A gate is a lookup (the chat gate is one indexed count), so a healthy
 * one answers in milliseconds; five seconds can only be a database that has
 * stopped answering.
 *
 * Without a bound, a gate that neither resolved nor rejected was the one wait
 * on the fetch path nothing limited: every yielding queue's loop sits on the
 * same pending lookup (the chat gate shares one in-flight query between all of
 * them), so `llm-background`, `image-description`, `thing-vision` and
 * `browser-activity-insight` all stop fetching at once, with nothing logged,
 * while their senders keep enqueueing. Treating the timeout as OPEN is the
 * rule this registry already applies to a missing or throwing gate.
 */
export const YIELD_GATE_TIMEOUT_MS = 5_000;

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
   * stand aside. Unknown gates, gates that throw and gates that do not answer
   * within {@link YIELD_GATE_TIMEOUT_MS} all read as open; the caller
   * distinguishes "unknown" via {@link has} for its one-time warning.
   */
  static async shouldYield(name: string, timeoutMs: number = YIELD_GATE_TIMEOUT_MS): Promise<boolean> {
    const gate = this.gates.get(name);

    if (gate == null) {
      return false;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unanswered = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });

    try {
      // `then(() => gate())` so a gate that throws synchronously lands in the
      // catch like an async one. A late rejection after the timeout is absorbed
      // by the race, which has already subscribed to it.
      return (await Promise.race([Promise.resolve().then(() => gate()), unanswered])) === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Test-only: forget every gate. */
  static clear(): void {
    this.gates.clear();
  }
}
