import { useMemo, useState } from 'react';

import { Badge, Button, Card, Collapsible, ToggleGroup } from '@ci/shadcn';
import { ChevronDown, SlidersHorizontal } from '@ci/shadcn/icons';

import {
  type EvolutionChangeType,
  type EvolutionDelta,
  type EvolutionNodeType,
  useEntityEvolutionService,
} from '@/api/useEntityEvolutionService';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

/** Matches the hook's default. Held here too so the panel can tell a full page from a complete one. */
const EVOLUTION_PAGE_LIMIT = 200;

/** Below this there is nothing worth filtering, and three rows of chips just bury the content. */
const MIN_DELTAS_FOR_FILTERS = 4;

const TIME_WINDOWS = ['all', '7d', '30d', '90d'] as const;
type TimeWindow = (typeof TIME_WINDOWS)[number];

const CHANGE_TYPES: Array<EvolutionChangeType | 'all'> = [
  'all',
  'created',
  'updated',
  'archived',
  'deleted',
  'merged',
];
const NODE_TYPE_FILTERS: Array<EvolutionNodeType | 'all'> = ['all', 'entity', 'relationship'];

/** Change types the summary badges can show, in the order they are shown. */
const SUMMARY_CHANGE_TYPES: EvolutionChangeType[] = ['created', 'updated', 'archived', 'deleted', 'merged'];

interface Props {
  entityId: string;
  /** Names the subject in the panel's description, so it reads as a sentence rather than a label. */
  entityName?: string | null;
  /** Bump to load the history again, so an edit made on the page shows without a reload. */
  refreshKey?: number;
}

function toTitleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDate(value: string, fmt: DateTimeFormatter): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return fmt.dateTime(date, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDiffValue(value: unknown): string {
  if (value == null || value === '') {
    return 'empty';
  }

  if (typeof value === 'string') {
    return value.length > 70 ? `${value.slice(0, 67)}...` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const formatted = value
      .map((item) =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? item : '...',
      )
      .slice(0, 4);

    return `[${formatted.join(', ')}${value.length > 4 ? ', ...' : ''}]`;
  }

  // A truncated JSON blob ('{"URL":"https://www.linkedin.com/in/abd...') tells a reader nothing they
  // can act on. The KEYS say what kind of thing changed, which is the question this panel answers;
  // the full value is on the element's `title`.
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      return 'empty';
    }

    const shown = keys.slice(0, 4).join(', ');

    return `${keys.length} field${keys.length === 1 ? '' : 's'}: ${shown}${keys.length > 4 ? ', ...' : ''}`;
  }

  return String(value);
}

/** The raw value, for the tooltip — the summary above is deliberately lossy. */
function fullDiffValue(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function withinTimeWindow(changedAt: string, window: TimeWindow): boolean {
  if (window === 'all') {
    return true;
  }

  const days = Number.parseInt(window.replace('d', ''), 10);
  const then = new Date(changedAt);
  if (Number.isNaN(then.getTime())) {
    return false;
  }

  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  return then.getTime() >= cutoff;
}

function renderTimelineTitle(delta: EvolutionDelta): string {
  if (delta.nodeType === 'entity') {
    const targetName = delta.entity?.name ?? delta.entityType ?? 'Entity';

    return targetName;
  }

  const left = delta.fromEntity?.name ?? 'Unknown entity';
  const right = delta.toEntity?.name ?? 'Unknown entity';
  const relationship = delta.relationshipType ? toTitleCase(delta.relationshipType) : 'Relationship';

  return `${relationship}: ${left} -> ${right}`;
}

function getRelationshipChangeLabel(changeType: EvolutionChangeType): 'New' | 'Changed' | 'Removed' {
  if (changeType === 'created') {
    return 'New';
  }

  if (changeType === 'deleted' || changeType === 'archived') {
    return 'Removed';
  }

  return 'Changed';
}

function getRelatedEntityName(delta: EvolutionDelta, focusEntityId: string): string {
  if (delta.fromEntity?.entityId === focusEntityId) {
    return delta.toEntity?.name ?? delta.toEntity?.entityType ?? 'Unknown entity';
  }

  if (delta.toEntity?.entityId === focusEntityId) {
    return delta.fromEntity?.name ?? delta.fromEntity?.entityType ?? 'Unknown entity';
  }

  return delta.toEntity?.name ?? delta.fromEntity?.name ?? 'Unknown entity';
}

/**
 * Whether a field's two sides are the same value.
 *
 * Compares the RAW values, never their rendered form. `formatDiffValue` is deliberately lossy — it
 * clips long strings and reduces an object to its key list — so comparing what is displayed would
 * report `{URL: 'a'}` -> `{URL: 'b'}` as unchanged and hide a genuine edit from an audit trail.
 *
 * Errs towards showing: an unserialisable value, or one whose keys are merely in a different order,
 * counts as changed. Over-reporting a change in a change log is recoverable; hiding one is not.
 */
function isSameValue(oldValue: unknown, newValue: unknown): boolean {
  if (oldValue === newValue) {
    return true;
  }

  // A column that went from null to '' (or back) did not change in any sense the reader cares about.
  const oldEmpty = oldValue == null || oldValue === '';
  const newEmpty = newValue == null || newValue === '';
  if (oldEmpty || newEmpty) {
    return oldEmpty && newEmpty;
  }

  try {
    return JSON.stringify(oldValue) === JSON.stringify(newValue);
  } catch {
    return false;
  }
}

/**
 * Field edits worth showing.
 *
 * A record created from an import writes a delta for every column it touched, including the ones it
 * left alone — which rendered as "Description: empty -> empty". Identical sides are not a change.
 */
function meaningfulFieldChanges(delta: EvolutionDelta) {
  return delta.fieldChanges.filter((change) => !isSameValue(change.oldValue, change.newValue));
}

export function EntityEvolutionPanel({ entityId, entityName, refreshKey }: Props) {
  const { data, loading, error } = useEntityEvolutionService({
    entityId,
    limit: EVOLUTION_PAGE_LIMIT,
    skip: !entityId,
    refreshKey,
  });
  const fmt = useDateTimeFormat();

  const [nodeTypeFilter, setNodeTypeFilter] = useState<EvolutionNodeType | 'all'>('all');
  const [changeTypeFilter, setChangeTypeFilter] = useState<EvolutionChangeType | 'all'>('all');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const allDeltas = useMemo(() => data?.deltas ?? [], [data]);
  const filteredDeltas = useMemo(
    () =>
      allDeltas.filter((delta) => {
        if (nodeTypeFilter !== 'all' && delta.nodeType !== nodeTypeFilter) {
          return false;
        }

        if (changeTypeFilter !== 'all' && delta.changeType !== changeTypeFilter) {
          return false;
        }

        return withinTimeWindow(delta.changedAt, timeWindow);
      }),
    [allDeltas, changeTypeFilter, nodeTypeFilter, timeWindow],
  );

  const filteredStats = useMemo(() => {
    const stats: Record<EvolutionChangeType, number> = {
      created: 0,
      updated: 0,
      archived: 0,
      deleted: 0,
      merged: 0,
    };

    for (const delta of filteredDeltas) {
      stats[delta.changeType] += 1;
    }

    return stats;
  }, [filteredDeltas]);

  const activeFilterCount =
    (nodeTypeFilter === 'all' ? 0 : 1) +
    (changeTypeFilter === 'all' ? 0 : 1) +
    (timeWindow === 'all' ? 0 : 1);
  const isFiltered = activeFilterCount > 0;
  // `stats.total` is computed over the page the API returned, so a full page means "at least this
  // many" rather than "this many". Saying "12 of 12" when there are 900 would be a lie.
  const pageIsFull = allDeltas.length >= EVOLUTION_PAGE_LIMIT;
  const subject = entityName?.trim() ? entityName.trim() : 'this record';

  const description = isFiltered
    ? `Showing ${filteredDeltas.length} of ${allDeltas.length}${pageIsFull ? '+' : ''} recorded changes.`
    : `Every recorded change to ${subject} and its relationships — what changed, when, and where it came from.`;

  return (
    <Card className="p-0">
      <Card.Content className="p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Change History</h2>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          {/* Only the change types that actually occurred. A row reading "Updated 0 / Deleted 0"
              spends the panel's most prominent space saying nothing happened. */}
          <div className="flex flex-wrap items-center gap-2">
            {SUMMARY_CHANGE_TYPES.filter((type) => filteredStats[type] > 0).map((type) => (
              <Badge key={type} variant="secondary">
                {toTitleCase(type)} {filteredStats[type]}
              </Badge>
            ))}
          </div>
        </div>

        {allDeltas.length >= MIN_DELTAS_FOR_FILTERS && (
          <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
            <Collapsible.Trigger asChild>
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs">
                <SlidersHorizontal className="size-3.5" />
                Filters
                {activeFilterCount > 0 && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    {activeFilterCount}
                  </Badge>
                )}
                <ChevronDown className={`size-3.5 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
              </Button>
            </Collapsible.Trigger>

            <Collapsible.Content className="flex flex-col gap-3 pt-3">
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={nodeTypeFilter}
                onValueChange={(value) => setNodeTypeFilter((value || 'all') as EvolutionNodeType | 'all')}
                className="flex-wrap justify-start"
              >
                {NODE_TYPE_FILTERS.map((filter) => (
                  <ToggleGroup.Item key={filter} value={filter} className="text-xs">
                    {/*
                      "Everything", not "All Changes": this group filters WHAT changed — the
                      entity's own fields or its relationships — while the group below filters what
                      HAPPENED to it. Naming both after changes made the two indistinguishable.
                    */}
                    {filter === 'all' ? 'Everything' : filter === 'entity' ? 'Own Fields' : 'Relationships'}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup>

              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={changeTypeFilter}
                onValueChange={(value) =>
                  setChangeTypeFilter((value || 'all') as EvolutionChangeType | 'all')
                }
                className="flex-wrap justify-start"
              >
                {CHANGE_TYPES.map((filter) => (
                  <ToggleGroup.Item key={filter} value={filter} className="text-xs">
                    {filter === 'all' ? 'Any Action' : toTitleCase(filter)}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup>

              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={timeWindow}
                onValueChange={(value) => setTimeWindow((value || 'all') as TimeWindow)}
                className="flex-wrap justify-start"
              >
                {TIME_WINDOWS.map((window) => (
                  <ToggleGroup.Item key={window} value={window} className="text-xs">
                    {window === 'all' ? 'All Time' : `Last ${window.replace('d', ' days')}`}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup>
            </Collapsible.Content>
          </Collapsible>
        )}

        {loading && <p className="text-sm text-muted-foreground">Loading change history...</p>}
        {error && <p className="text-sm text-destructive">Unable to load change history: {error.message}</p>}
        {!loading && !error && filteredDeltas.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {allDeltas.length === 0
              ? 'No changes recorded yet. Edits to this record and its relationships will show up here.'
              : 'No changes match the selected filters.'}
          </p>
        )}

        {!loading && !error && filteredDeltas.length > 0 && (
          <div className="space-y-3">
            {filteredDeltas.map((delta) => {
              const fieldChanges = meaningfulFieldChanges(delta);
              const isCreation = delta.changeType === 'created';

              return (
                <div key={delta.deltaId} className="rounded-md border border-border/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{toTitleCase(delta.changeType)}</Badge>
                      <Badge variant="secondary">
                        {delta.nodeType === 'relationship' ? 'Relationship' : 'Own Fields'}
                      </Badge>
                      {delta.relationshipType && (
                        <Badge variant="secondary">{toTitleCase(delta.relationshipType)}</Badge>
                      )}
                    </div>
                    <p className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(delta.changedAt, fmt)}
                    </p>
                  </div>

                  {delta.nodeType === 'relationship' ? (
                    <p className="mt-2 text-sm font-medium">
                      {getRelationshipChangeLabel(delta.changeType)} link to{' '}
                      {getRelatedEntityName(delta, entityId)}
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 text-sm font-medium">
                        {isCreation
                          ? `Added to your graph as ${renderTimelineTitle(delta)}`
                          : 'Fields edited'}
                      </p>

                      {fieldChanges.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {fieldChanges.map((change) => (
                            <p
                              key={`${delta.deltaId}-${change.field}`}
                              className="text-xs"
                              title={fullDiffValue(change.newValue)}
                            >
                              <span className="text-muted-foreground">{toTitleCase(change.field)}:</span>{' '}
                              {/* On creation there is no "before" — showing "empty -> Abdul Ameer"
                                  reads as a defect rather than as the record being born. */}
                              {isCreation ? (
                                <span className="text-foreground">{formatDiffValue(change.newValue)}</span>
                              ) : (
                                <>
                                  <span className="text-foreground/85">
                                    {formatDiffValue(change.oldValue)}
                                  </span>
                                  <span className="text-muted-foreground">{' -> '}</span>
                                  <span className="text-foreground">{formatDiffValue(change.newValue)}</span>
                                </>
                              )}
                            </p>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* Provenance, and only when there is any. The old three-column grid rendered a
                      "Changed At" tile duplicating the timestamp above it, next to two tiles showing
                      an em dash — three columns of chrome for zero information. */}
                  {(delta.changeSource || delta.changeReason) && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {delta.changeSource && <span>Source: {toTitleCase(delta.changeSource)}</span>}
                      {delta.changeReason && <span>Reason: {delta.changeReason}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
