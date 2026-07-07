import type { Summary } from '@ci/domains/summaries';

/**
 * Shared projection helpers for the interim narrative intents (`insights.list`,
 * `anomalies.recent`).
 *
 * Both read the free-LLM summarizer's period summaries (`ci.summaries`) and flatten one of the
 * narrative string arrays each row carries (`keyInsights` / `anomalies`). Results are labelled
 * `basis: 'llm-narrative'` so agents know these are narrative claims, not computed metrics —
 * the grounded compute-then-narrate producers land with the daily feature store
 * (CI-Engineering #63) and the divergence scoring loop.
 */

/** How results were produced. Only narrative sources exist today. */
export type NarrativeBasis = 'llm-narrative';

export const LLM_NARRATIVE: NarrativeBasis = 'llm-narrative';

/** How many recent summary windows to scan per call (newest first). */
export const SUMMARY_SCAN_LIMIT = 100;

/** One narrative statement, tied back to the summary window that produced it. */
export interface NarrativeItem {
  text: string;
  summaryId: string;
  periodStart: string;
  periodEnd: string;
  periodType: string;
}

export interface NarrativeListOutput {
  /** Provenance label: narrative claims from the LLM summarizer, not computed metrics. */
  basis: NarrativeBasis;
  items: NarrativeItem[];
  count: number;
  /** Set when the scan window (newest SUMMARY_SCAN_LIMIT summaries) may not reach `since`. */
  note?: string;
}

/**
 * Flatten `field` across summaries (assumed newest-first) into narrative items, honoring an
 * optional `since` lower bound (on the window's periodEnd) and an item `limit`.
 */
export function projectNarrativeItems(
  summaries: Summary[],
  field: 'keyInsights' | 'anomalies',
  options: { since?: string; limit: number },
): NarrativeListOutput {
  const sinceMs = options.since ? Date.parse(options.since) : undefined;
  const items: NarrativeItem[] = [];

  for (const summary of summaries) {
    if (sinceMs !== undefined && summary.periodEnd.getTime() < sinceMs) {
      continue;
    }

    for (const text of summary[field]) {
      if (typeof text !== 'string' || text.trim() === '') {
        continue;
      }

      items.push({
        text,
        summaryId: summary.summaryId,
        periodStart: summary.periodStart.toISOString(),
        periodEnd: summary.periodEnd.toISOString(),
        periodType: summary.periodType,
      });

      if (items.length >= options.limit) {
        break;
      }
    }

    if (items.length >= options.limit) {
      break;
    }
  }

  const output: NarrativeListOutput = { basis: LLM_NARRATIVE, items, count: items.length };

  // The scan reads the newest SUMMARY_SCAN_LIMIT windows; a `since` further back than the oldest
  // scanned window may have matching rows we never saw. Say so instead of implying completeness.
  if (
    sinceMs !== undefined &&
    summaries.length >= SUMMARY_SCAN_LIMIT &&
    summaries.length > 0 &&
    summaries[summaries.length - 1].periodEnd.getTime() > sinceMs
  ) {
    output.note = `scanned the ${SUMMARY_SCAN_LIMIT} most recent summary windows; older windows matching 'since' may exist`;
  }

  return output;
}
