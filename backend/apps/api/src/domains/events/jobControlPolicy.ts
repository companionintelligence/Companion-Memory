import { DEAD_LETTER_QUEUE } from './constants';

/**
 * The jobs an operator may not switch off.
 *
 * ── Why there is a list at all ─────────────────────────────────────────────
 *
 * A control plane that can disable its own instrumentation is a control plane
 * that can lie to you. Turn off the metrics collector and the Jobs page's charts
 * flatten to a straight line — which reads exactly like a healthy idle
 * appliance, and is the single most misleading thing this page could show.
 *
 * The bar for being on this list is deliberately high, because the whole point
 * of the feature is that the operator is in charge: something that, if switched
 * off, either **breaks the appliance's ability to tell you it is broken**, or
 * **fails an obligation the appliance has to the user rather than to itself**.
 * Everything else — every enrichment, every import, every model call, every
 * search index write — is the operator's to stop, however expensive stopping it
 * turns out to be.
 *
 * That is six schedules and one queue out of 53 and 38. If a seventh needs
 * adding, it needs a sentence here saying which of the two tests it meets.
 */
export const PROTECTED_CRONS: Readonly<Record<string, string>> = {
  'JobMetricsCollector.sampleOnSchedule':
    'Samples the queue depths this page charts. pg-boss keeps roughly 36 hours of working set and no history, so these samples are the only record that yesterday happened — switching it off makes the Jobs page unable to report that anything is wrong.',
  'JobMetricsCollector.purgeOnSchedule':
    'Retention for ci.job_metrics. Without it that table grows without bound on an appliance nobody is administering.',
  'DeadLetterReaperListener.reapOnSchedule':
    'Copies exhausted jobs into ci.pipeline_dead_letters before pg-boss expires them. It is the only thing standing between a failure and it being unrecoverable, and the Dead Letters card on this page is its output.',
  'AccountPurgeCron.purgeDueAccounts':
    'Carries out account deletions the user has already requested. That is an obligation to the person, not a workload knob — a disabled purge silently keeps data someone asked to have erased.',
  'StagedUploadPurgeCron.runOnSchedule':
    'Frees the disk that abandoned uploads sit on. Disabling it fills the volume the rest of the appliance writes to, which fails everything else on the way down.',
  'McpController.reapStaleSessions':
    'Closes abandoned MCP sessions. Each one holds a transport open; without the sweep they accumulate for the life of the process.',
};

/**
 * Queues an operator may not switch off.
 *
 * Only the dead-letter queue, and for the same reason as the reaper above: it is
 * where failures go to stay inspectable. Nothing else here is structural — the
 * `llm` queue is left switchable even though disabling it breaks chat, because
 * "stop the model" is one of the most legitimate reasons to open this page at
 * all, and the UI is explicit about what it costs.
 *
 * **This entry is currently unreachable, and deliberately kept.** `dead-letter`
 * has no `@OnEvent` handler — registering one would silently destroy the dead
 * letters of every event but the one subscribed, which `DeadLetterReaperListener`
 * explains — so it never enters `queueInventory()`, never appears on the card,
 * and is rejected as an unknown queue before this list is consulted. It stays so
 * that the day somebody does register a handler there, the queue arrives already
 * protected rather than switchable.
 */
export const PROTECTED_QUEUES: Readonly<Record<string, string>> = {
  [DEAD_LETTER_QUEUE]:
    'Where jobs that exhausted their retries are kept so a failure stays diagnosable. Nothing works this queue by design — the reaper polls it instead — so there is nothing here to stop.',
};

export function protectedCronReason(name: string): string | null {
  return PROTECTED_CRONS[name] ?? null;
}

export function protectedQueueReason(queue: string): string | null {
  return PROTECTED_QUEUES[queue] ?? null;
}
