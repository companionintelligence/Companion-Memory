import { type MouseEvent } from 'react';

import { cn } from '@ci/shadcn';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { BentoCard } from '../../components/BentoCard';

export const INSIGHT_CARD_FRAGMENT = gql(`
  fragment InsightCardData on InsightItemType {
    title
    summaryText
    keyActions
    relevanceScore
    tags
    relatedEntityIds
  }
`);

interface Props {
  insight: FragmentType<typeof INSIGHT_CARD_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onDismiss?: () => void;
  isSeen?: boolean;
  className?: string;
}

export function InsightCard({ insight, onClick, onDismiss, isSeen = false, className }: Props) {
  const data = useFragment(INSIGHT_CARD_FRAGMENT, insight);

  const description = (
    <div className="flex flex-col gap-3">
      <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-500 font-medium">Insight</span>
        {data.relevanceScore > 0.8 && (
          <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 font-medium">
            High Relevance
          </span>
        )}
      </div>

      <p className="text-base text-foreground">{data.summaryText}</p>

      {data.keyActions && data.keyActions.length > 0 && (
        <div className="mt-1">
          <div className="text-xs font-medium text-muted-foreground mb-1.5 uppercase">Suggested Actions</div>
          <ul className="space-y-2">
            {data.keyActions.map((action, idx) => (
              <li key={idx} className="flex items-start gap-2 text-sm text-foreground/90">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                <span>{action}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  return (
    <BentoCard
      title={data.title}
      description={description}
      tags={data.tags}
      onClick={onClick}
      onDismiss={onDismiss}
      dismissLabel="Dismiss insight"
      showUnseenIndicator={!isSeen}
      className={cn('border-l-4 border-l-blue-500', className)}
    />
  );
}
