import { useState, type ReactNode } from 'react';

import { Badge, Button, Card, Collapsible, Input, Skeleton, cn } from '@ci/shadcn';
import { AlertTriangle, ChevronDown, ChevronRight } from '@ci/shadcn/icons';

import { FoldCard, cardPad, usePhone } from './Fold';
import { categoryDot, categoryLabel, categoryStyle } from './jobCategories';
import type { JobFilters, JobListItem, JobListResponse } from './useJobsList';
import type { JobTypesResponse } from './useJobTypes';

type Props = {
  data: JobListResponse | null;
  loading: boolean;
  error: string | null;
  filters: JobFilters;
  categories: readonly string[];
  /** The job taxonomy, for the type filter. Null while it loads. */
  jobTypes: JobTypesResponse | null;
  onChange: (next: Partial<JobFilters>) => void;
};

/**
 * The state tabs.
 *
 * `dead-letter` is not a pg-boss state — dead-lettered jobs are stored as
 * `created` on the dead-letter queue, which is exactly why they used to be
 * counted as pending work. It gets its own tab because "gave up" is the state an
 * operator actually cares about, whatever the column says.
 */
const STATE_TABS = [
  { key: '', label: 'All' },
  { key: 'created', label: 'Waiting' },
  { key: 'active', label: 'Running' },
  { key: 'retry', label: 'Retrying' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'dead-letter', label: 'Dead-lettered' },
] as const;

/**
 * One table for every job, with the filters that make it navigable.
 *
 * This replaces five fixed card columns that each showed 25 rows selected by
 * the server with no way to change them — so the answer to "why did that job
 * fail?" was "it is probably not one of these 125". Everything here is a server
 * query: filtering and paging over `pgboss.job` cannot be done in the browser
 * when the table routinely holds tens of thousands of rows.
 */
export function JobsTable({ data, loading, error, filters, categories, jobTypes, onChange }: Props) {
  const phone = usePhone();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : filters.offset + 1;
  const to = Math.min(filters.offset + filters.limit, total);

  // Type options, narrowed to the selected category. 76 events in one flat list
  // is a wall; scoped to a category it is a short, useful menu.
  const visibleTypes = Object.entries(jobTypes?.types ?? {})
    .filter(([, descriptor]) => !filters.category || descriptor.category === filters.category)
    .map(([event, descriptor]) => ({ value: event, label: descriptor.label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Every state bucket added up — what "All" means under the non-state filters.
  const allStatesTotal = Object.values(data?.stateCounts ?? {}).reduce((sum, count) => sum + count, 0);

  const extraFilterCount = [filters.category, filters.type, filters.queue].filter(Boolean).length;

  const stateTabs = (
    <div
      className={
        phone
          ? 'scrollbar-none flex gap-1 overflow-x-auto overscroll-x-contain pb-0.5'
          : 'flex flex-wrap gap-1'
      }
      role="tablist"
      aria-label="Job state"
    >
      {STATE_TABS.map((tab) => {
        // `stateCounts` deliberately ignores the state filter, so every tab
        // shows what picking it would yield. `total` does NOT — it reflects
        // the active filter — so using it for "All" made the All tab count
        // collapse to the current selection the moment one was made.
        const count = tab.key ? data?.stateCounts?.[tab.key] : allStatesTotal;
        // A ghost button on a dark card reads as text, so the selected tab
        // was easy to lose. Selection now carries a filled surface AND a
        // ring; unselected tabs keep a border so they read as controls.
        const selected = filters.state === tab.key;

        return (
          <Button
            key={tab.key || 'all'}
            role="tab"
            aria-selected={selected}
            size="sm"
            variant="ghost"
            onClick={() => onChange({ state: tab.key, offset: 0 })}
            className={cn(
              'shrink-0',
              selected
                ? 'border border-primary/60 bg-primary/15 text-foreground ring-1 ring-primary/40'
                : 'border border-border/70 text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {count != null ? (
              <span
                className={`ml-1.5 rounded px-1 tabular-nums text-xs ${
                  selected ? 'bg-primary/20 text-foreground' : 'text-muted-foreground'
                }`}
              >
                {count.toLocaleString()}
              </span>
            ) : null}
          </Button>
        );
      })}
    </div>
  );

  const filterSelects = (
    <>
      <FilterSelect
        label="Category"
        value={filters.category}
        options={categories.map((category) => ({
          value: category,
          label: categoryLabel(category),
        }))}
        stacked={phone}
        onChange={(category) =>
          // Changing category invalidates a type from a different category,
          // so clear it rather than leaving a filter pair that matches nothing.
          onChange({ category, type: '', offset: 0 })
        }
      />
      <FilterSelect
        label="Job type"
        value={filters.type}
        options={visibleTypes}
        stacked={phone}
        onChange={(type) => onChange({ type, offset: 0 })}
      />
      <FilterSelect
        label="Queue"
        value={filters.queue}
        options={(data?.queues ?? []).map((queue) => ({ value: queue, label: queue }))}
        stacked={phone}
        onChange={(queue) => onChange({ queue, offset: 0 })}
      />
      {(filters.state || filters.queue || filters.category || filters.type || filters.search) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange({ state: '', queue: '', category: '', type: '', search: '', offset: 0 })}
        >
          Clear
        </Button>
      )}
    </>
  );

  return (
    <FoldCard>
      <Card.Header className={cn('gap-2.5', cardPad(phone))}>
        <div className="flex flex-col gap-1">
          <Card.Title className="text-base">Jobs</Card.Title>
          <Card.Description>
            {loading && !data
              ? 'Loading…'
              : total === 0
                ? 'No jobs match these filters.'
                : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}
          </Card.Description>
        </div>

        {stateTabs}

        {/* Filters sit on their own tinted rail so they read as controls rather
            than as part of the table chrome — the old row blended into the
            header and was easy to miss entirely. */}
        {phone ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-2">
            <Input
              value={filters.search}
              onChange={(event) => onChange({ search: event.target.value, offset: 0 })}
              placeholder="Search event, queue or error…"
              aria-label="Search jobs"
            />
            <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
              <Collapsible.Trigger asChild>
                <Button size="sm" variant="ghost" className="w-full justify-between">
                  <span>
                    Filters
                    {extraFilterCount > 0 ? (
                      <span className="ml-1.5 tabular-nums text-muted-foreground">({extraFilterCount})</span>
                    ) : null}
                  </span>
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-muted-foreground transition-transform',
                      filtersOpen && 'rotate-180',
                    )}
                  />
                </Button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <div className="flex flex-col gap-2 pt-2">{filterSelects}</div>
              </Collapsible.Content>
            </Collapsible>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-2 md:flex-row md:flex-wrap md:items-center">
            <Input
              value={filters.search}
              onChange={(event) => onChange({ search: event.target.value, offset: 0 })}
              placeholder="Search event, queue or error message…"
              aria-label="Search jobs"
              className="md:max-w-xs"
            />
            {filterSelects}
          </div>
        )}
      </Card.Header>

      <Card.Content className={cn('space-y-2', cardPad(phone))}>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {loading && !data ? (
          <Skeleton className={phone ? 'h-48 w-full' : 'h-[400px] w-full'} />
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nothing matches these filters.</p>
        ) : phone ? (
          <ul>
            {items.map((job) => (
              <li key={job.id}>
                <JobCard
                  job={job}
                  expanded={expanded === job.id}
                  onToggle={() => setExpanded((current) => (current === job.id ? null : job.id))}
                />
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-xs uppercase text-muted-foreground">
                  <th scope="col" className="w-8 py-1.5" />
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Job
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Queue
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    State
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    Duration
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    Retries
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    expanded={expanded === job.id}
                    onToggle={() => setExpanded((current) => (current === job.id ? null : job.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={filters.offset === 0}
            onClick={() => onChange({ offset: Math.max(filters.offset - filters.limit, 0) })}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {Math.floor(filters.offset / filters.limit) + 1} of{' '}
            {Math.max(Math.ceil(total / filters.limit), 1)}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={filters.offset + filters.limit >= total}
            onClick={() => onChange({ offset: filters.offset + filters.limit })}
          >
            Next
          </Button>
        </div>
      </Card.Content>
    </FoldCard>
  );
}

function JobRow({ job, expanded, onToggle }: { job: JobListItem; expanded: boolean; onToggle: () => void }) {
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <>
      <tr className="cursor-pointer border-b border-border/40 align-top hover:bg-muted/40" onClick={onToggle}>
        <td className="py-1.5">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`Details for ${job.label}`}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          >
            <Chevron className="h-4 w-4" />
          </button>
        </td>
        <td className="py-1.5 pr-3">
          <div className="flex flex-col">
            <span className="flex items-center gap-1.5 font-medium">
              {/* Category as a colour cue on every row, so a subsystem's work is
                  scannable in a wall of thousands. The written category is in the
                  expanded detail and the filter — colour is never the only
                  channel (WCAG 1.4.1). */}
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${categoryDot(job.category)}`} />
              {job.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {job.event ?? 'no event name'}
              {job.interactive ? ' · interactive' : ''}
            </span>
          </div>
          {job.failure ? (
            <span className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-destructive">
              <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" />
              <span className="truncate" title={job.failure.message}>
                {job.failure.message}
              </span>
            </span>
          ) : null}
        </td>
        <td className="py-1.5 pr-3 text-xs text-muted-foreground">{job.queue}</td>
        <td className="py-1.5 pr-3">
          <StateBadge job={job} />
        </td>
        <td className="py-1.5 pr-3 text-right tabular-nums text-xs text-muted-foreground">
          {formatDuration(job.durationMs)}
        </td>
        <td className="py-1.5 pr-3 text-right tabular-nums text-xs text-muted-foreground">
          {job.retryCount}/{job.retryLimit}
        </td>
        <td className="py-1.5 text-right text-xs text-muted-foreground">{formatTimestamp(job.createdOn)}</td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border/40 bg-muted/20">
          <td />
          <td colSpan={6} className="py-2 pr-3">
            <JobDetails job={job} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function JobCard({ job, expanded, onToggle }: { job: JobListItem; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Details for ${job.label}`}
        onClick={onToggle}
        className="flex w-full flex-col gap-1 py-2.5 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${categoryDot(job.category)}`} />
            <span className="truncate">{job.label}</span>
          </span>
          <StateBadge job={job} />
        </div>
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {job.event ?? 'no event name'}
          {job.interactive ? ' · interactive' : ''}
          {' · '}
          {job.queue}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatDuration(job.durationMs)}
          {' · '}
          {job.retryCount}/{job.retryLimit}
          {' · '}
          {formatTimestamp(job.createdOn)}
        </p>
        {job.failure ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-xs text-destructive">
            <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" />
            <span className="truncate" title={job.failure.message}>
              {job.failure.message}
            </span>
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="pb-3">
          <JobDetails job={job} />
        </div>
      ) : null}
    </div>
  );
}

function JobDetails({ job }: { job: JobListItem }) {
  return (
    <>
      <p className="mb-2 max-w-3xl text-xs text-muted-foreground">{job.description}</p>
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <Detail label="Job id" value={job.id} mono />
        <Detail
          label="Category"
          value={
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${categoryStyle(job.category)}`}
            >
              {categoryLabel(job.category)}
            </span>
          }
        />
        <Detail label="Payload" value={`${job.payloadBytes.toLocaleString()} bytes`} />
        <Detail label="Started" value={formatTimestamp(job.startedOn)} />
        <Detail label="Completed" value={formatTimestamp(job.completedOn)} />
        {job.workType ? <Detail label="Work type" value={job.workType} /> : null}
      </dl>
      {job.failure ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-2">
          <p className="text-xs font-medium text-destructive">{job.failure.message}</p>
          {job.failure.failedAt ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Failed {formatTimestamp(job.failure.failedAt)}
            </p>
          ) : null}
          {job.failure.stack ? (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-[11px] leading-snug text-muted-foreground">
              {job.failure.stack}
            </pre>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function StateBadge({ job }: { job: JobListItem }) {
  if (job.deadLettered) {
    return (
      <Badge variant="destructive" className="text-xs uppercase">
        dead-lettered
      </Badge>
    );
  }

  const variant =
    job.state === 'failed' ? 'destructive' : job.state === 'completed' ? 'secondary' : 'outline';

  return (
    <Badge variant={variant} className="text-xs uppercase">
      {job.state}
    </Badge>
  );
}

function Detail({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 truncate ${mono ? 'font-mono text-[11px]' : ''}`}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
  stacked = false,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  stacked?: boolean;
}) {
  return (
    <label className={cn('flex gap-1.5 text-xs', stacked ? 'flex-col items-stretch' : 'items-center')}>
      <span className="whitespace-nowrap font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className={`h-9 rounded-md border px-2 text-sm text-foreground ${stacked ? 'w-full' : ''} ${
          value ? 'border-primary/60 bg-primary/10' : 'border-input bg-background'
        }`}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Seconds once past a second — "33.5s" reads faster than "33546ms". */
function formatDuration(ms: number | null): string {
  if (ms == null) {
    return '—';
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTimestamp(value?: string | null): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}
