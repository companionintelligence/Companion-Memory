import { type MouseEvent } from 'react';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { BentoCard } from '../../components/BentoCard';

export const SUMMARY_CARD_FRAGMENT = gql(`
  fragment SummaryCardData on SummaryType {
    id
    title
    periodType
    seen
    summaryText
    keyInsights
    tags
    activityCounts {
      total
    }
  }
`);

interface Props {
  summary: FragmentType<typeof SUMMARY_CARD_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onDismiss?: () => void;
  className?: string;
}

export function SummaryCard({ summary, onClick, onDismiss, className }: Props) {
  const data = useFragment(SUMMARY_CARD_FRAGMENT, summary);

  const description = (
    <div className="flex flex-col gap-3">
      <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="px-2 py-0.5 rounded bg-muted">{data.periodType}</span>
        <span className="px-2 py-0.5 rounded bg-muted">{data.activityCounts.total} activities</span>
      </div>
      <p className="text-base text-foreground">{data.summaryText}</p>
      {data.keyInsights && data.keyInsights.length > 0 && (
        <ul className="list-disc pl-5 space-y-1.5 text-base text-muted-foreground">
          {data.keyInsights.slice(0, 3).map((insight, idx) => (
            <li key={idx}>{insight}</li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <BentoCard
      title={data.title || 'Summary'}
      description={description}
      tags={data.tags}
      onClick={onClick}
      onDismiss={onDismiss}
      dismissLabel="Dismiss summary"
      showUnseenIndicator={!data.seen}
      className={className}
    />
  );
}
