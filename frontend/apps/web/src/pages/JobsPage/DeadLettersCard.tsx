import { useCallback, useMemo, useState } from 'react';

import { Badge, Button, Card, Checkbox, Skeleton, cn } from '@ci/shadcn';
import { AlertTriangle, RotateCcw } from '@ci/shadcn/icons';

import { FoldBody, FoldCard, FoldTrigger, cardPad, usePhone } from './Fold';
import { DEAD_LETTER_PAGE } from './useDeadLetters';
import type { DeadLetterGroup, DeadLetterReplayResponse } from './useDeadLetters';

type Props = {
  groups: readonly DeadLetterGroup[];
  total: number;
  loading: boolean;
  error: string | null;
  onReplay: (ids: readonly string[]) => Promise<DeadLetterReplayResponse | null>;
};

/**
 * Coarse age of a group's newest failure. Coarse on purpose — the question this
 * column answers is "is this still happening?", not "when exactly".
 */
export function formatAge(from: number, now: number = Date.now()): string {
  const seconds = Math.max(Math.round((now - from) / 1000), 0);

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 48) {
    return `${hours}h ago`;
  }

  return `${Math.round(hours / 24)}d ago`;
}

/** One-line summary of what a replay actually did, for the status strip. */
export function describeReplay(result: DeadLetterReplayResponse): string {
  const parts = [`Re-emitted ${result.replayed.length}`];

  if (result.failed.length > 0) {
    // Named, not counted: a replay that fails the same way it failed the first
    // time is the single most likely outcome for a config error, and an operator
    // who cannot see that will press the button again.
    const [first] = result.failed;

    parts.push(`${result.failed.length} failed again (${first.reason})`.slice(0, 200));
  }

  if (result.skipped.length > 0) {
    parts.push(`${result.skipped.length} already replayed`);
  }

  // Distinct from `skipped` on purpose: these were never looked at, so the
  // honest instruction is "press it again", not "nothing to do".
  if (result.notAttempted != null && result.notAttempted.length > 0) {
    parts.push(`${result.notAttempted.length} not attempted (batch limit) — replay again`);
  }

  return `${parts.join(' · ')}.`;
}

/**
 * Dead letters, grouped by cause, with a replay button.
 *
 * ── Why this card exists ───────────────────────────────────────────────────
 *
 * The rest of this page reads `pgboss.job`. `ci.pipeline_dead_letters` is a
 * different table with a different job: pg-boss archives and eventually deletes
 * its rows, while a dead letter keeps the PAYLOAD forever so the lost work can
 * be re-run. Nothing in the product read it — the appliance this was built
 * against held 94 letters and had never replayed one, because the only way to
 * was a uuid at a time through curl.
 *
 * ── Grouped, and why selection is per-cause ────────────────────────────────
 *
 * Those 94 letters were eight causes; one of them (`Invalid model specified:
 * qwen/qwen3-vl-30b`) accounted for 36. A flat list of 94 rows hides that, and
 * more importantly it invites replaying all of them — which for a config error
 * re-runs it against the same broken config and writes 36 fresh letters. So the
 * unit of selection is a CAUSE, the count and age are shown next to it, and
 * there is deliberately no "select all" affordance.
 */
export function DeadLettersCard({ groups, total, loading, error, onReplay }: Props) {
  const phone = usePhone();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const toggle = useCallback((key: string) => {
    setSelected((current) => {
      const next = new Set(current);

      if (!next.delete(key)) {
        next.add(key);
      }

      return next;
    });
  }, []);

  const selectedIds = useMemo(
    () => groups.filter((group) => selected.has(group.key)).flatMap((group) => [...group.ids]),
    [groups, selected],
  );

  const replaySelected = useCallback(async () => {
    if (selectedIds.length === 0 || busy) {
      return;
    }

    setBusy(true);
    setReplayError(null);

    try {
      const result = await onReplay(selectedIds);

      setStatus(result ? describeReplay(result) : null);
      setSelected(new Set());
    } catch (err: unknown) {
      setReplayError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, onReplay, selectedIds]);

  const replayButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={selectedIds.length === 0 || busy}
      onClick={() => void replaySelected()}
      className={phone ? 'w-full' : 'w-full md:w-auto'}
    >
      <RotateCcw className="mr-2 h-4 w-4" />
      {busy ? 'Replaying…' : `Replay selected (${selectedIds.length})`}
    </Button>
  );

  return (
    <FoldCard fold>
      <Card.Header
        className={cn(
          'flex gap-2',
          phone ? 'flex-col' : 'flex-col md:flex-row md:items-center md:justify-between',
          cardPad(phone),
        )}
      >
        <FoldTrigger>
          <Card.Title className="text-base">Dead letters</Card.Title>
          <Card.Description>
            {loading && groups.length === 0
              ? 'Loading…'
              : total === 0
                ? 'Nothing has been dead-lettered.'
                : // `total` is the length of ONE page, and the request asks for
                  // at most DEAD_LETTER_PAGE of them — so on an appliance with
                  // thousands it read exactly "200 un-replayed", which looks
                  // like a count and is really the ceiling. Next to a Health
                  // card saying "8,535 jobs have given up", that is two
                  // unexplained numbers for the same thing.
                  `${
                    total >= DEAD_LETTER_PAGE ? `First ${DEAD_LETTER_PAGE.toLocaleString()}` : total.toLocaleString()
                  } un-replayed across ${groups.length.toLocaleString()} ${
                    groups.length === 1 ? 'cause' : 'causes'
                  }${total >= DEAD_LETTER_PAGE ? ' — there are more' : ''}`}
          </Card.Description>
        </FoldTrigger>
        {phone ? null : replayButton}
      </Card.Header>

      <FoldBody>
        <Card.Content className={cn('space-y-2', cardPad(phone))}>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {replayError ? (
            <p role="alert" className="text-sm text-destructive">
              {replayError}
            </p>
          ) : null}

          {status ? (
            <p role="status" className="text-sm text-muted-foreground">
              {status}
            </p>
          ) : null}

          {loading && groups.length === 0 ? (
            <Skeleton className="h-32 w-full" />
          ) : groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No job has given up and parked its payload here.
            </p>
          ) : phone ? (
            <ul>
              {groups.map((group) => (
                <li key={group.key}>
                  <GroupCard
                    group={group}
                    selected={selected.has(group.key)}
                    expanded={expanded === group.key}
                    onToggleSelected={() => toggle(group.key)}
                    onToggleExpanded={() =>
                      setExpanded((current) => (current === group.key ? null : group.key))
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-xs uppercase text-muted-foreground">
                    <th scope="col" className="w-8 py-1.5" />
                    <th scope="col" className="py-1.5 pr-3 font-medium">
                      Error
                    </th>
                    <th scope="col" className="py-1.5 pr-3 font-medium">
                      Event
                    </th>
                    <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                      Count
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Last failure
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <GroupRow
                      key={group.key}
                      group={group}
                      selected={selected.has(group.key)}
                      expanded={expanded === group.key}
                      onToggleSelected={() => toggle(group.key)}
                      onToggleExpanded={() =>
                        setExpanded((current) => (current === group.key ? null : group.key))
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {phone ? <div className="pt-1">{replayButton}</div> : null}
        </Card.Content>
      </FoldBody>
    </FoldCard>
  );
}

function GroupRow({
  group,
  selected,
  expanded,
  onToggleSelected,
  onToggleExpanded,
}: {
  group: DeadLetterGroup;
  selected: boolean;
  expanded: boolean;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
}) {
  return (
    <>
      <tr className="border-b border-border/40">
        <td className="py-1.5 align-top">
          <Checkbox
            checked={selected}
            onCheckedChange={onToggleSelected}
            aria-label={`Select ${group.count} ${group.eventName} failures: ${group.error}`}
          />
        </td>
        <td className="py-1.5 pr-3">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="flex items-start gap-1.5 text-left"
            aria-expanded={expanded}
          >
            <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 break-words">{group.error}</span>
          </button>
        </td>
        <td className="py-1.5 pr-3">
          <Badge variant="secondary" className="text-[10px]">
            {group.eventName}
          </Badge>
        </td>
        <td className="py-1.5 pr-3 text-right tabular-nums">{group.count.toLocaleString()}</td>
        <td className="py-1.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
          {formatAge(group.lastFailedAt)}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border/40">
          <td />
          <td colSpan={4} className="py-2 pr-3">
            <GroupDetail group={group} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function GroupCard({
  group,
  selected,
  expanded,
  onToggleSelected,
  onToggleExpanded,
}: {
  group: DeadLetterGroup;
  selected: boolean;
  expanded: boolean;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
}) {
  return (
    <div className="flex gap-2 border-b border-border/40 py-2.5 last:border-0">
      <Checkbox
        checked={selected}
        onCheckedChange={onToggleSelected}
        aria-label={`Select ${group.count} ${group.eventName} failures: ${group.error}`}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="w-full text-left"
          aria-expanded={expanded}
        >
          <span className="flex items-start gap-1.5">
            <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 break-words text-sm">{group.error}</span>
          </span>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge variant="secondary" className="text-[10px]">
              {group.eventName}
            </Badge>
            <span className="tabular-nums">{group.count.toLocaleString()}</span>
            <span>{formatAge(group.lastFailedAt)}</span>
          </p>
        </button>
        {expanded ? (
          <div className="pt-2">
            <GroupDetail group={group} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GroupDetail({ group }: { group: DeadLetterGroup }) {
  return (
    <>
      {/* The full error WITH stack. It is the reason the row is worth
          keeping, and it is what tells an operator whether a replay has any
          chance — a stack in `validateModel` is a config error, and
          replaying it will fail identically. */}
      <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap">
        {group.detail}
      </pre>
      <p className="pt-1 text-xs text-muted-foreground">First seen {formatAge(group.firstFailedAt)}.</p>
    </>
  );
}
