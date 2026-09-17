import { icsRecurrenceInstant } from '../identity/calendar';

import { DEFAULT_LIMITS, expandSeries, occurrenceEnd } from './expandSeries';
import { occurrenceEventId, seriesUidOf } from './occurrenceIdentity';
import { parseRecurrence, type RecurringSeriesRow } from './parseRecurrence';
import type { ExpansionDiagnostic, ExpansionLimits, ExpansionWindow, OccurrenceSpec } from './types';

export interface ExpandAllOptions {
  fallbackTimeZone: string;
  fallbackTimeZoneSource?: 'user' | 'server';
  limits?: Partial<ExpansionLimits>;
  onDiagnostic?: (diagnostic: ExpansionDiagnostic) => void;
}

/**
 * Every occurrence the given series masters put inside `window`.
 *
 * The DTSTART occurrence is deliberately skipped: the master row IS that
 * occurrence, it is already in the caller's result set, and synthesizing a
 * second one under a different id would show the user two standups on the day
 * the series began — the exact duplication this whole design exists to avoid.
 *
 * Overrides are NOT suppressed here; that needs a query, and it lives in
 * queries.ts so this file stays pure and testable without a database.
 */
export function expandAll(
  masters: readonly RecurringSeriesRow[],
  window: ExpansionWindow,
  opts: ExpandAllOptions,
): OccurrenceSpec[] {
  const caps = { ...DEFAULT_LIMITS, ...opts.limits };
  const diagnose = opts.onDiagnostic ?? (() => {});
  const specs: OccurrenceSpec[] = [];

  for (const master of masters) {
    if (specs.length >= caps.maxTotalOccurrences) {
      diagnose({ kind: 'truncated', seriesId: master.id, limit: 'maxTotalOccurrences' });
      break;
    }

    const spec = parseRecurrence(master, {
      fallbackTimeZone: opts.fallbackTimeZone,
      fallbackTimeZoneSource: opts.fallbackTimeZoneSource,
      onDiagnostic: diagnose,
    });

    if (!spec) {
      continue;
    }

    const uid = seriesUidOf(master.sourceId);

    if (!uid) {
      diagnose({ kind: 'unfederated-identity', seriesId: master.id });
      continue;
    }

    const { starts, truncated, limit } = expandSeries(spec, window, caps);

    if (truncated) {
      diagnose({ kind: 'truncated', seriesId: master.id, limit: limit ?? 'maxOccurrencesPerSeries' });
    }

    for (const start of starts) {
      if (start.getTime() === master.startTime.getTime()) {
        continue;
      }

      if (specs.length >= caps.maxTotalOccurrences) {
        diagnose({ kind: 'truncated', seriesId: master.id, limit: 'maxTotalOccurrences' });
        break;
      }

      const recurrenceInstant = icsRecurrenceInstant(start);

      specs.push({
        seriesId: master.id,
        occurrenceId: occurrenceEventId(master.id, recurrenceInstant),
        startTime: start,
        endTime: occurrenceEnd(spec, start),
        recurrenceInstant,
        overrideSourceId: `${uid}#${recurrenceInstant}`,
        timeZoneSource: spec.timeZoneSource,
      });
    }
  }

  return specs;
}
