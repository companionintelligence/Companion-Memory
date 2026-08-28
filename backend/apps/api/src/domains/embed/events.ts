/**
 * The embed domain's event surface: one request event, so the importer can
 * ask for a link-preview sweep without importing this domain's module (the
 * `events.ts` leaf is the one cross-domain import the dependency rules allow,
 * and it reaches nothing that leads back to the importer).
 */
import { defineEvent } from '@ci/domains/events';

/**
 * "Start an `enrich.unfurl` sweep for this user." Emitted by the importer's
 * push stage when it wrote content rows (the Sync step of the import wizard
 * ends in that push), and consumed by the pipeline's
 * `UnfurlSweepRequestListener`, which starts the sweep. Idempotent: a sweep
 * over rows the ledger already marks done returns nothing, so a second kick
 * costs one query.
 */
export const UnfurlSweepRequestEvent = 'embed.unfurl-sweep-request';

/** Its own queue, so a burst of imports cannot crowd the default one. */
export const UNFURL_SWEEP_QUEUE = 'unfurl-sweep';

export type UnfurlSweepRequestPayload = {
  /** Owner whose content rows are swept; required. */
  userId?: string;
  /** Free-form provenance for the log line, e.g. `import-run:<uuid>`. */
  requestedBy?: string;
};

defineEvent<UnfurlSweepRequestPayload>(UnfurlSweepRequestEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [UnfurlSweepRequestEvent]: UnfurlSweepRequestPayload;
  }
}
