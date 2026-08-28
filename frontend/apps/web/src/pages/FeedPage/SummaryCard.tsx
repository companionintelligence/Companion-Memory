import { type MouseEvent } from 'react';

import { useTranslation } from 'react-i18next';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { BentoCard } from '../../components/BentoCard';
import { Markdown } from '../../components/Markdown';

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
  const { t } = useTranslation();
  const data = useFragment(SUMMARY_CARD_FRAGMENT, summary);

  const description = (
    <div className="flex flex-col gap-3">
      <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="px-2 py-0.5 rounded bg-muted">{data.periodType}</span>
        <span className="px-2 py-0.5 rounded bg-muted">{data.activityCounts.total} activities</span>
      </div>
      {/* A div, not a p — see the matching note in InsightCard. */}
      <div className="text-base text-foreground">
        <Markdown>{data.summaryText}</Markdown>
      </div>
      {data.keyInsights && data.keyInsights.length > 0 && (
        <ul className="list-disc pl-5 space-y-1.5 text-base text-muted-foreground">
          {data.keyInsights.slice(0, 3).map((insight, idx) => (
            <li key={idx}>
              {/* inline so the marker from list-disc stays on the same line. */}
              <Markdown inline>{insight}</Markdown>
            </li>
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
      dismissLabel={t('FEED_CARD_DISMISS_SUMMARY')}
      showUnseenIndicator={!data.seen}
      className={className}
    />
  );
}
