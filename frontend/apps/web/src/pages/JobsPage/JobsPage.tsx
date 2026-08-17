import { useMemo } from 'react';

import { usePageTitle } from '@ci/common';
import { Badge, Button, Card, Skeleton } from '@ci/shadcn';
import { AlertTriangle, RefreshCcw } from '@ci/shadcn/icons';
import { Cell, Pie, PieChart } from 'recharts';

import { PageContent } from '@/components/layout';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';

import {
  expandActiveJobDistribution,
  formatJobHandlerLabel,
  formatSmartRotationJobTitle,
  SMART_ROTATION_WORK_LABELS,
} from './smartRotationLabels';
import {
  useJobsDashboard,
  type ArchivedJobRecord,
  type JobQueue,
  type JobRecord,
  type JobSchedule,
  type JobsDashboardResponse,
} from './useJobsDashboard';

const palette = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

export function JobsPage() {
  usePageTitle('Jobs - Companion Intelligence');

  const { data, loading, error, refresh } = useJobsDashboard();

  const jobs = data?.jobs ?? [];
  const archive = data?.archive ?? [];

  const activeJobs = useMemo(() => jobs.filter((job) => job.state !== 'completed'), [jobs]);

  const completedJobs = useMemo<ArchivedJobRecord[]>(() => {
    const archiveIds = new Set(archive.map((item) => item.id));

    const completedFromJobs = jobs
      .filter((job) => job.state === 'completed' && !archiveIds.has(job.id))
      .map<ArchivedJobRecord>((job) => ({
        ...job,
        archivedOn: job.completedOn ?? job.createdOn,
      }));

    const combined: ArchivedJobRecord[] = [...archive, ...completedFromJobs];

    return combined.sort((a, b) => {
      const aTime = new Date(a.archivedOn).getTime();
      const bTime = new Date(b.archivedOn).getTime();

      return bTime - aTime;
    });
  }, [archive, jobs]);
  const activeDistribution = useMemo(() => {
    if (!data?.activeDistribution?.length) {
      return [];
    }

    return expandActiveJobDistribution(data.activeDistribution, data.smartRotationDistribution ?? []).map(
      (segment, index) => ({
        ...segment,
        color: palette[index % palette.length],
        key: `active-${segment.jobName}-${index}`,
      }),
    );
  }, [data?.activeDistribution, data?.smartRotationDistribution]);

  const archiveDistribution = useMemo(() => {
    if (!data?.archiveDistribution?.length) {
      return [];
    }

    return data.archiveDistribution.map((segment, index) => ({
      ...segment,
      jobName: formatJobHandlerLabel(segment.jobName),
      color: palette[index % palette.length],
      key: `archive-${index}`,
    }));
  }, [data?.archiveDistribution]);

  return (
    <>
      <PageContent>
        <div className="flex flex-col gap-4">
          <SummaryCard
            loading={loading}
            error={error}
            activeDistribution={activeDistribution}
            archiveDistribution={archiveDistribution}
            queueDistribution={data?.queueDistribution ?? []}
            smartRotationDistribution={data?.smartRotationDistribution ?? []}
            summary={data?.summary}
            onRefresh={refresh}
          />

          <ColumnsGrid
            loading={loading}
            activeJobs={activeJobs}
            completed={completedJobs}
            schedules={data?.schedules ?? []}
            queues={data?.queues ?? []}
          />
        </div>
      </PageContent>
    </>
  );
}

type SummaryCardProps = {
  loading: boolean;
  error: string | null;
  summary?: JobsDashboardResponse['summary'];
  activeDistribution: Array<{
    readonly key: string;
    readonly jobName: string;
    readonly count: number;
    readonly color: string;
  }>;
  archiveDistribution: Array<{
    readonly key: string;
    readonly jobName: string;
    readonly count: number;
    readonly color: string;
  }>;
  queueDistribution: ReadonlyArray<{ readonly queue: string; readonly count: number }>;
  smartRotationDistribution: ReadonlyArray<{ readonly workType: string; readonly count: number }>;
  onRefresh: () => void;
};

function SummaryCard({
  loading,
  error,
  summary,
  activeDistribution,
  archiveDistribution,
  queueDistribution,
  smartRotationDistribution,
  onRefresh,
}: SummaryCardProps) {
  const summaryItems = useMemo(
    () => [
      { label: 'Pending', value: summary?.pending ?? 0 },
      { label: 'Running', value: summary?.active ?? 0 },
      { label: 'Completed (lifetime)', value: summary?.completed ?? 0 },
      { label: 'Failed', value: summary?.failed ?? 0 },
    ],
    [summary?.pending, summary?.active, summary?.completed, summary?.failed],
  );

  return (
    <Card>
      <Card.Header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <Card.Title className="text-xl">Queue Activity</Card.Title>
          <Card.Description>Current job workload and recent completions</Card.Description>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} className="w-full md:w-auto">
          <RefreshCcw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </Card.Header>
      <Card.Content className="space-y-4">
        {error ? <ErrorBanner message={error} /> : null}
        {loading && !summary ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="grid gap-3 md:grid-cols-4">
            {summaryItems.map((item) => (
              <StatTile key={item.label} label={item.label} value={item.value} />
            ))}
          </div>
        )}

        {loading && !activeDistribution.length && !archiveDistribution.length ? (
          <Skeleton className="h-60 w-full" />
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <DistributionChart
              title="Active jobs by handler"
              description="Pending and in-flight work — smart rotation split by work type"
              data={activeDistribution}
              emptyMessage="No active jobs in the queue."
            />
            <DistributionChart
              title="Completed jobs by handler (lifetime)"
              description="Historical volume from the job archive"
              data={archiveDistribution}
              emptyMessage="No completed jobs have been archived yet."
            />
          </div>
        )}

        {(queueDistribution.length > 0 || smartRotationDistribution.length > 0) && (
          <div className="grid gap-4 md:grid-cols-2">
            {queueDistribution.length > 0 ? (
              <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
                <h3 className="text-sm font-medium">Active jobs by queue</h3>
                <dl className="mt-3 space-y-2">
                  {queueDistribution.map((item) => (
                    <div key={item.queue} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{item.queue}</span>
                      <span className="font-medium">{item.count.toLocaleString()}</span>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
            {smartRotationDistribution.length > 0 ? (
              <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
                <h3 className="text-sm font-medium">Smart rotation (active / retrying)</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Same jobs as above, grouped by what each run is trying to do.
                </p>
                <dl className="mt-3 space-y-2">
                  {smartRotationDistribution.map((item) => (
                    <div key={item.workType} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground">
                        {SMART_ROTATION_WORK_LABELS[item.workType] ?? item.workType}
                      </span>
                      <span className="font-medium tabular-nums">{item.count.toLocaleString()}</span>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

type ColumnsGridProps = {
  loading: boolean;
  activeJobs: readonly JobRecord[];
  completed: readonly ArchivedJobRecord[];
  schedules: readonly JobSchedule[];
  queues: readonly JobQueue[];
};

function ColumnsGrid({ loading, activeJobs, completed, schedules, queues }: ColumnsGridProps) {
  return (
    <div className="grid gap-4 xl:grid-cols-4">
      <DataColumn
        title="Active Jobs"
        description="Jobs waiting to run or currently executing"
        loading={loading}
        items={activeJobs}
        renderItem={(job) => <JobCard key={job.id} job={job} />}
      />
      <DataColumn
        title="Completed Jobs"
        description="Recently completed or failed jobs (including unarchived completions)"
        loading={loading}
        items={completed}
        renderItem={(job) => <ArchivedJobCard key={job.id} job={job} />}
      />
      <DataColumn
        title="Schedules"
        description="Recurring system jobs"
        loading={loading}
        items={schedules}
        renderItem={(schedule) => <ScheduleCard key={schedule.name} schedule={schedule} />}
      />
      <DataColumn
        title="Queues"
        description="Queue configuration and policies"
        loading={loading}
        items={queues}
        renderItem={(queue) => <QueueCard key={queue.name} queue={queue} />}
      />
    </div>
  );
}

type DataColumnProps<T> = {
  title: string;
  description: string;
  loading: boolean;
  items: readonly T[];
  renderItem: (item: T) => React.ReactNode;
};

function DataColumn<T>({ title, description, loading, items, renderItem }: DataColumnProps<T>) {
  return (
    <Card className="flex h-full flex-col">
      <Card.Header>
        <Card.Title className="text-base">{title}</Card.Title>
        <Card.Description>{description}</Card.Description>
      </Card.Header>
      <Card.Content className="flex-1">
        {loading && !items.length ? (
          <Skeleton className="h-[320px] w-full" />
        ) : items.length ? (
          <div className="flex max-h-[420px] flex-col gap-3 overflow-y-auto pr-1">
            {items.map((item) => renderItem(item))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No data available.</p>
        )}
      </Card.Content>
    </Card>
  );
}

type JobCardProps = {
  job: JobRecord;
};

function JobCard({ job }: JobCardProps) {
  const { title, subtitle } = getJobDisplay(job.data);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="block font-medium truncate" title={title}>
            {title}
          </span>
          {subtitle ? (
            <span className="block truncate text-xs text-muted-foreground" title={subtitle}>
              {subtitle}
            </span>
          ) : null}
        </div>
        <Badge variant="outline" className="shrink-0 text-xs uppercase">
          {job.state}
        </Badge>
      </div>
      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        <KeyValue label="Queue" value={job.queue} />
        <KeyValue label="Created" value={formatTimestamp(job.createdOn)} />
        <KeyValue label="Start after" value={formatTimestamp(job.startAfter)} />
        {job.startedOn ? <KeyValue label="Started" value={formatTimestamp(job.startedOn)} /> : null}
        {job.completedOn ? <KeyValue label="Completed" value={formatTimestamp(job.completedOn)} /> : null}
        <KeyValue label="Retries" value={`${job.retryCount}/${job.retryLimit}`} />
      </dl>
    </div>
  );
}

type ArchivedJobCardProps = {
  job: ArchivedJobRecord;
};

function ArchivedJobCard({ job }: ArchivedJobCardProps) {
  const { title, subtitle } = getJobDisplay(job.data);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="block font-medium truncate" title={title}>
            {title}
          </span>
          {subtitle ? (
            <span className="block truncate text-xs text-muted-foreground" title={subtitle}>
              {subtitle}
            </span>
          ) : null}
        </div>
        <Badge
          variant={job.state === 'completed' ? 'secondary' : 'destructive'}
          className="shrink-0 text-xs uppercase"
        >
          {job.state}
        </Badge>
      </div>
      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        <KeyValue label="Queue" value={job.queue} />
        <KeyValue label="Archived" value={formatTimestamp(job.archivedOn)} />
        {job.completedOn ? <KeyValue label="Completed" value={formatTimestamp(job.completedOn)} /> : null}
        {job.deadLetter ? <KeyValue label="Dead letter" value={job.deadLetter} /> : null}
        <KeyValue label="Retries" value={`${job.retryCount}/${job.retryLimit}`} />
      </dl>
    </div>
  );
}

type ScheduleCardProps = {
  schedule: JobSchedule;
};

function ScheduleCard({ schedule }: ScheduleCardProps) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium truncate" title={schedule.name}>
          {schedule.name}
        </span>
        <Badge variant="outline" className="text-xs uppercase">
          cron
        </Badge>
      </div>
      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        <KeyValue label="Expression" value={schedule.cron} />
        {schedule.timezone ? <KeyValue label="Time zone" value={schedule.timezone} /> : null}
        <KeyValue label="Created" value={formatTimestamp(schedule.createdOn)} />
        <KeyValue label="Updated" value={formatTimestamp(schedule.updatedOn)} />
      </dl>
    </div>
  );
}

type QueueCardProps = {
  queue: JobQueue;
};

function QueueCard({ queue }: QueueCardProps) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium truncate" title={queue.name}>
          {queue.name}
        </span>
        <Badge variant="outline" className="text-xs uppercase">
          {queue.policy ?? 'standard'}
        </Badge>
      </div>
      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        <KeyValue label="Retry limit" value={String(queue.retryLimit)} />
        <KeyValue label="Retry delay" value={`${queue.retryDelay}s`} />
        <KeyValue label="Backoff" value={queue.retryBackoff ? 'enabled' : 'disabled'} />
        {queue.expireInSeconds !== null && queue.expireInSeconds !== undefined ? (
          <KeyValue label="Expires" value={`${queue.expireInSeconds}s`} />
        ) : null}
        {queue.retentionMinutes !== null && queue.retentionMinutes !== undefined ? (
          <KeyValue label="Retention" value={`${queue.retentionMinutes}m`} />
        ) : null}
        <KeyValue label="Created" value={formatTimestamp(queue.createdOn)} />
        <KeyValue label="Updated" value={queue.updatedOn ? formatTimestamp(queue.updatedOn) : '—'} />
        {queue.deadLetter ? <KeyValue label="DLQ" value={queue.deadLetter} /> : null}
      </dl>
    </div>
  );
}

type KeyValueProps = {
  label: string;
  value: string;
};

function KeyValue({ label, value }: KeyValueProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground/80">{label}</span>
      <span className="font-medium text-foreground/80">{value}</span>
    </div>
  );
}

type StatTileProps = {
  label: string;
  value: number;
};

function StatTile({ label, value }: StatTileProps) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
    </div>
  );
}

type ErrorBannerProps = {
  message: string;
};

function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4" />
      <span className="truncate">{message}</span>
    </div>
  );
}

function DistributionChart({
  title,
  description,
  data,
  emptyMessage,
}: {
  title: string;
  description: string;
  data: Array<{
    readonly key: string;
    readonly jobName: string;
    readonly count: number;
    readonly color: string;
  }>;
  emptyMessage: string;
}) {
  if (!data.length) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
      <ChartContainer config={{}} className="mt-2 h-[240px] w-full">
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="jobName"
            innerRadius={60}
            outerRadius={100}
            paddingAngle={2}
            stroke="transparent"
          >
            {data.map((segment) => (
              <Cell key={segment.key} fill={segment.color} />
            ))}
          </Pie>
          <ChartTooltip
            cursor={{ fill: 'hsla(var(--muted), 0.35)' }}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, _name, { payload }) => {
                  return (
                    <div className="flex w-full items-center justify-between gap-6">
                      <span>{payload.jobName}</span>
                      <span className="font-medium">{value as number}</span>
                    </div>
                  );
                }}
              />
            }
          />
        </PieChart>
      </ChartContainer>
    </div>
  );
}

function formatTimestamp(value?: string) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function getJobDisplay(data: Record<string, unknown> | null): { title: string; subtitle?: string } {
  const rotationTitle = formatSmartRotationJobTitle(data);

  if (rotationTitle) {
    return { title: rotationTitle, subtitle: 'smart.rotation.work' };
  }

  if (!data || typeof data !== 'object') {
    return { title: 'Unnamed job' };
  }

  const name = data['name'];

  return {
    title: typeof name === 'string' && name.length > 0 ? name : 'Unnamed job',
  };
}
