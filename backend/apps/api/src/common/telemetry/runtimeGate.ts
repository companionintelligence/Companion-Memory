/**
 * The runtime half of the crash-report switch.
 *
 * `settings.ts` decides, once, at process start and from the environment,
 * whether Sentry is initialised at all. That cannot express "the user turned
 * crash reports off from Settings while the box was running": `Sentry.init` has
 * already happened, and it happened in `instrument.ts`, before Nest exists and
 * therefore before anything that could read `ci.outbound_settings`.
 *
 * So the switch is a tiny module-level flag that `instrument.ts` consults on
 * every outgoing item, and that the outbound policy store flips whenever it
 * loads or changes the user's choice. A plain boolean rather than a store
 * import on purpose: this file must stay a leaf that `instrument.ts` can import
 * with no DI, no database and no cycle.
 *
 * ── Defaults, and the boot window ──────────────────────────────────────────
 *
 * The flag starts TRUE — the shipped default, and what an appliance that never
 * touched the setting should do. The consequence is a short window between
 * `Sentry.init` and the policy service's first read of the table in which a
 * user who HAS opted out is still governed by the default: a crash while Nest
 * is still wiring its modules can be reported. It is small (the first read is
 * awaited in `onModuleInit`), and closing it would mean either dropping every
 * boot-time crash report or reading Postgres before Sentry initialises. The
 * operator kill switches (`CI_TELEMETRY=off`, `CI_LOCAL_ONLY=true`) have no such
 * window — they are resolved before `Sentry.init` and stop it running at all.
 *
 * ── Why two layers ─────────────────────────────────────────────────────────
 *
 * {@link dropWhenUserOptedOut} is wired into the SDK's `beforeSend*` hooks: it
 * stops an item early, before it is serialised or buffered. But those hooks are
 * per item type, and the SDK sends more than the four it exposes — sessions,
 * client reports, profiles, check-ins. {@link gateSentryTransport} wraps the
 * transport, the one place every envelope passes through, so anything the hooks
 * do not cover is still dropped. The hooks are the fast path; the transport is
 * the guarantee.
 */

let crashReportsUserEnabled = true;

/** Set by the outbound policy store on every load and every change. */
export function setCrashReportsUserEnabled(enabled: boolean): void {
  crashReportsUserEnabled = enabled;
}

/** True unless the user has turned crash reports off. Says nothing about the env kill switches. */
export function isCrashReportsUserEnabled(): boolean {
  return crashReportsUserEnabled;
}

/**
 * Adapter for Sentry's `beforeSend`-family hooks: returns the item unchanged
 * while reporting is on, `null` (which the SDK treats as "discard") when the
 * user has turned it off.
 */
export function dropWhenUserOptedOut<T>(item: T): T | null {
  return crashReportsUserEnabled ? item : null;
}

/** The two members of a Sentry `Transport` this gate touches. */
interface EnvelopeTransport {
  send(envelope: never): PromiseLike<unknown>;
  flush(timeout?: number): PromiseLike<boolean>;
}

/**
 * Wrap a Sentry transport so nothing leaves while the user has crash reports
 * off.
 *
 * A dropped envelope resolves with an empty response rather than rejecting: the
 * SDK reads a rejection as a network failure and would retry or record a
 * client report about it, which is exactly the traffic being suppressed.
 * `flush` is passed straight through — there is nothing buffered here to flush,
 * and the inner transport may still be draining envelopes queued before the
 * user changed their mind.
 */
export function gateSentryTransport<T extends EnvelopeTransport>(inner: T): T {
  return {
    ...inner,
    send: (envelope: never) =>
      crashReportsUserEnabled ? inner.send(envelope) : Promise.resolve({}),
    flush: (timeout?: number) => inner.flush(timeout),
  } as T;
}
