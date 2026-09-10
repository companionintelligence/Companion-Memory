import config from '@ci/configuration';

/**
 * Whether this appliance is configured to ring Hub's doorbell — and if not, why.
 *
 * ## Why this is not in `domains/agent` beside the doorbell itself
 *
 * Two callers need the same answer, in two domains. `HubDoorbellService`
 * (domains/agent) needs it to decide whether to attempt a wake;
 * `AgentHarnessService` (domains/persona) needs it to decide whether the UI
 * should offer a Dispatch button at all. `no-cross-domain-internals` would make
 * the second reach through `@ci/domains/agent`'s barrel, which is a Nest module
 * — pulling the whole provider graph into a unit test to ask whether two
 * strings are set.
 *
 * So it lives here, as a leaf that imports nothing but configuration.
 *
 * ## Why it is shared at all
 *
 * `resolveReadiness` used to decide `dispatchReady` purely from whether OpenClaw
 * was installed, connected and running — none of which says the appliance can
 * REACH it. On a dev stack, where neither key is set, all three were true and
 * the UI offered a Dispatch button that created a job, woke nothing, and died
 * two minutes later reporting that OpenClaw had not checked in.
 *
 * One definition, not two matching `if`s, so the button and the doorbell cannot
 * come to disagree about what "configured" means.
 */
export type DoorbellBlocker = 'no_hub_url' | 'no_shared_secret' | null;

export function doorbellBlocker(): DoorbellBlocker {
  // Trailing slash stripped the same way the doorbell strips it, so a value of
  // "/" is treated as empty by both rather than as a base URL by one of them.
  if (!(config.auth.connect.hubInternalUrl?.replace(/\/$/, '') || '')) {
    return 'no_hub_url';
  }

  if (!config.auth.hubForwardAuth.secret) {
    return 'no_shared_secret';
  }

  return null;
}
