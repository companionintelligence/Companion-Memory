import { useMemo, useState } from 'react';

import { Button, Card, Badge } from '@ci/shadcn';

import {
  type EvolutionChangeType,
  type EvolutionDelta,
  type EvolutionNodeType,
  useEntityEvolutionService,
} from '@/api/useEntityEvolutionService';

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

interface Props {
  entityId: string;
}

function toTitleCase(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatDiffValue(value: unknown): string {
  if (value == null) {
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

  try {
    const serialized = JSON.stringify(value);

    return serialized.length > 70 ? `${serialized.slice(0, 67)}...` : serialized;
  } catch {
    return String(value);
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

export function EntityEvolutionPanel({ entityId }: Props) {
  const { data, loading, error } = useEntityEvolutionService({ entityId, skip: !entityId });

  const [nodeTypeFilter, setNodeTypeFilter] = useState<EvolutionNodeType | 'all'>('all');
  const [changeTypeFilter, setChangeTypeFilter] = useState<EvolutionChangeType | 'all'>('all');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('all');

  const allDeltas = data?.deltas ?? [];
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
    const stats = {
      total: filteredDeltas.length,
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

  return (
    <Card className="p-0">
      <Card.Content className="p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Evolution</h2>
            <p className="text-xs text-muted-foreground">
              {filteredStats.total} shown of {data?.stats.total ?? 0} captured changes
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Created {filteredStats.created}</Badge>
            <Badge variant="secondary">Updated {filteredStats.updated}</Badge>
            <Badge variant="secondary">Deleted {filteredStats.deleted}</Badge>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {NODE_TYPE_FILTERS.map((filter) => (
            <Button
              key={filter}
              size="sm"
              variant={nodeTypeFilter === filter ? 'default' : 'outline'}
              onClick={() => setNodeTypeFilter(filter)}
            >
              {filter === 'all' ? 'All Nodes' : filter === 'entity' ? 'Entity Fields' : 'Relationships'}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {CHANGE_TYPES.map((filter) => (
            <Button
              key={filter}
              size="sm"
              variant={changeTypeFilter === filter ? 'default' : 'outline'}
              onClick={() => setChangeTypeFilter(filter)}
            >
              {filter === 'all' ? 'All Changes' : toTitleCase(filter)}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {TIME_WINDOWS.map((window) => (
            <Button
              key={window}
              size="sm"
              variant={timeWindow === window ? 'default' : 'outline'}
              onClick={() => setTimeWindow(window)}
            >
              {window === 'all' ? 'All Time' : `Last ${window.replace('d', ' days')}`}
            </Button>
          ))}
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading evolution history...</p>}
        {error && (
          <p className="text-sm text-destructive">Unable to load evolution history: {error.message}</p>
        )}
        {!loading && !error && filteredDeltas.length === 0 && (
          <p className="text-sm text-muted-foreground">No evolution events for the selected filters.</p>
        )}

        {!loading && !error && filteredDeltas.length > 0 && (
          <div className="space-y-3">
            {filteredDeltas.map((delta) => (
              <div key={delta.deltaId} className="rounded-md border border-border/60 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{toTitleCase(delta.changeType)}</Badge>
                    {delta.relationshipType && (
                      <Badge variant="secondary">{toTitleCase(delta.relationshipType)}</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{formatDate(delta.changedAt)}</p>
                </div>

                {delta.nodeType === 'relationship' ? (
                  <>
                    <p className="mt-2 text-sm font-medium">
                      {getRelationshipChangeLabel(delta.changeType)} Relationship with{' '}
                      {getRelatedEntityName(delta, entityId)}
                    </p>
                    {delta.relationshipType && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Type: {toTitleCase(delta.relationshipType)}
                      </p>
                    )}

                    <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                      <div className="rounded-sm bg-muted/40 p-2">
                        <p className="font-medium text-muted-foreground">Change Reason</p>
                        <p className="mt-1 text-foreground">{delta.changeReason?.trim() || '—'}</p>
                      </div>
                      <div className="rounded-sm bg-muted/40 p-2">
                        <p className="font-medium text-muted-foreground">Change Source</p>
                        <p className="mt-1 text-foreground">{delta.changeSource?.trim() || '—'}</p>
                      </div>
                      <div className="rounded-sm bg-muted/40 p-2">
                        <p className="font-medium text-muted-foreground">Changed At</p>
                        <p className="mt-1 text-foreground">{formatDate(delta.changedAt)}</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="mt-2 text-sm font-medium">{renderTimelineTitle(delta)}</p>

                    {delta.fieldChanges.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {delta.fieldChanges.map((change) => (
                          <p key={`${delta.deltaId}-${change.field}`} className="text-xs">
                            <span className="text-muted-foreground">{toTitleCase(change.field)}:</span>{' '}
                            <span className="text-foreground/85">{formatDiffValue(change.oldValue)}</span>
                            <span className="text-muted-foreground">{' -> '}</span>
                            <span className="text-foreground">{formatDiffValue(change.newValue)}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {delta.nodeType === 'entity' && (delta.changeSource || delta.changeReason) && (
                  <div className="mt-2 space-y-1">
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      {delta.changeSource && <span>Source: {delta.changeSource}</span>}
                      {delta.changeReason && <span>Reason: {delta.changeReason}</span>}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
