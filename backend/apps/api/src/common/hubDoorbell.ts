import config from '@ci/configuration';

/** Why this appliance cannot ring Hub. */
export type DoorbellBlocker = 'no_hub_url' | 'no_shared_secret' | null;

/**
 * Why the REAL path — Memory rings Hub, Hub rings OpenClaw — is unavailable.
 *
 * Separate from {@link doorbellBlocker} because the two answer different
 * questions. This one decides which path `wakeOpenClaw` takes; the other
 * decides whether a Dispatch button is honest. Collapsing them would make the
 * dev path a FALLBACK after a Hub failure, which it must never be.
 */
export function hubBlocker(): DoorbellBlocker {
  // Trailing slash stripped the same way the doorbell strips it, so a value of
  // "/" is empty to both rather than a base URL to one of them.
  if (!(config.auth.connect.hubInternalUrl?.replace(/\/$/, '') || '')) {
    return 'no_hub_url';
  }

  if (!config.auth.hubForwardAuth.secret) {
    return 'no_shared_secret';
  }

  return null;
}

/**
 * The dev-only direct wake, if it is armed.
 *
 * BOTH halves required: a URL with no bearer would POST an unauthenticated
 * request that OpenClaw rejects — a silent miss dressed up as a configured
 * path. The URL is loopback-enforced at config parse time (see
 * `isEmptyOrLoopback` in `configuration.ts`), so an appliance that somehow had
 * it pointing off-box refuses to boot rather than warning about it.
 */
export function devDirectWake(): { url: string; token: string } | null {
  const url = config.auth.connect.devDirectWakeUrl?.replace(/\/$/, '') || '';
  const token = config.auth.connect.devDirectWakeToken || '';

  return url && token ? { url, token } : null;
}

/**
 * Can this appliance wake OpenClaw AT ALL — by any path?
 *
 * ## Why this is shared, and not in `domains/agent`
 *
 * Two callers need the same answer in two domains. `HubDoorbellService`
 * (domains/agent) needs it to decide whether to attempt a wake;
 * `AgentHarnessService` (domains/persona) needs it to decide whether the UI
 * should offer a Dispatch button. `no-cross-domain-internals` would make the
 * second reach through `@ci/domains/agent`'s barrel, which is a Nest module —
 * pulling the whole provider graph into a unit test to ask whether two strings
 * are set. So it lives here, importing nothing but configuration.
 *
 * ## Why it is shared at all
 *
 * `resolveReadiness` used to decide `dispatchReady` purely from whether
 * OpenClaw was installed, connected and running — none of which says the
 * appliance can REACH it. On a dev stack all three were true and the UI offered
 * a Dispatch button that created a job, woke nothing, and died two minutes
 * later reporting that OpenClaw had not checked in.
 *
 * One definition, not two matching `if`s, so the button and the doorbell cannot
 * come to disagree about what "configured" means.
 */
export function doorbellBlocker(): DoorbellBlocker {
  const blocker = hubBlocker();

  if (blocker == null) {
    return null;
  }

  // The dev path is a working doorbell for readiness purposes — otherwise the
  // button would stay hidden on precisely the stack it exists to make work.
  return devDirectWake() != null ? null : blocker;
}
