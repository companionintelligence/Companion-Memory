/**
 * Read-time RRULE expansion.
 *
 * Barrel for `domains/memory`'s own public surface only — inside this domain,
 * import the files directly (`.dependency-cruiser.mjs`'s
 * `no-intra-domain-via-barrel`).
 */
export { expandAll, type ExpandAllOptions } from './expandAll';
export { DEFAULT_LIMITS, expandSeries, occurrenceEnd, type SeriesExpansion } from './expandSeries';
export { OCCURRENCE_NAMESPACE, occurrenceEventId, seriesUidOf } from './occurrenceIdentity';
export {
  parseRecurrence,
  seriesRuleOf,
  type ParseRecurrenceOptions,
  type RecurringSeriesRow,
  type SeriesRuleLines,
} from './parseRecurrence';
export {
  MAX_RECURRING_MASTERS,
  clearExpansionZoneCache,
  dropExistingOverrides,
  findRecurringMasters,
  resolveExpansionZone,
  type ExpansionZone,
} from './queries';
export type {
  ExpansionDiagnostic,
  ExpansionLimits,
  ExpansionWindow,
  OccurrenceSpec,
  RecurrenceSpec,
} from './types';
