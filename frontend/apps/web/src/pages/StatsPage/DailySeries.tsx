import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { Card } from '@ci/shadcn';
import { Line, LineChart, XAxis, YAxis } from 'recharts';

import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';

const GET_DAILY_METRICS = gql`
  query StatsDailyMetrics($from: String!, $to: String!) {
    dailyMetrics(from: $from, to: $to) {
      date
      nMessages
      nPlaces
      kmTraveled
    }
  }
`;

const CHART_CONFIG = {
  nMessages: { label: 'Messages', color: 'var(--chart-1)' },
  nPlaces: { label: 'Places', color: 'var(--chart-2)' },
  kmTraveled: { label: 'Km', color: 'var(--chart-3)' },
} satisfies ChartConfig;

function isoDay(value: string | undefined, fallbackDaysBack: number): string {
  if (value) {
    return value.slice(0, 10);
  }

  const date = new Date();
  date.setUTCDate(date.getUTCDate() - fallbackDaysBack);

  return date.toISOString().slice(0, 10);
}

export function DailySeries({ from, to }: { from?: string; to?: string }) {
  const { data } = useQuery(GET_DAILY_METRICS, {
    variables: { from: isoDay(from, 730), to: isoDay(to, 0) },
    errorPolicy: 'all',
  });

  const rows = data?.dailyMetrics ?? [];
  if (rows.length === 0) {
    return null;
  }

  return (
    <Card>
      <Card.Content className="flex flex-col gap-3 pt-6">
        <span className="text-xs font-medium text-muted-foreground">Daily series</span>
        <ChartContainer config={CHART_CONFIG} className="h-56 w-full">
          <LineChart data={rows}>
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Line type="monotone" dataKey="nMessages" stroke="var(--color-nMessages)" dot={false} />
            <Line type="monotone" dataKey="nPlaces" stroke="var(--color-nPlaces)" dot={false} />
            <Line type="monotone" dataKey="kmTraveled" stroke="var(--color-kmTraveled)" dot={false} />
          </LineChart>
        </ChartContainer>
      </Card.Content>
    </Card>
  );
}
