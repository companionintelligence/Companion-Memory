import { type MouseEvent } from 'react';

import { cn } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { BentoCard } from '../../components/BentoCard';
import { Markdown } from '../../components/Markdown';

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
  const { t } = useTranslation();
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

      {/* A div, not a p: summaryText is model-authored and may be several
          paragraphs or a list, and ReactMarkdown emits block elements that
          cannot legally nest inside a <p>. */}
      <div className="text-base text-foreground">
        <Markdown>{data.summaryText}</Markdown>
      </div>

      {data.keyActions && data.keyActions.length > 0 && (
        <div className="mt-1">
          <div className="text-xs font-medium text-muted-foreground mb-1.5 uppercase">Suggested Actions</div>
          <ul className="space-y-2">
            {data.keyActions.map((action, idx) => (
              <li key={idx} className="flex items-start gap-2 text-sm text-foreground/90">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                {/* inline: the li already provides the block and its own bullet
                    glyph, so a paragraph wrapper here would break the flex row. */}
                <span>
                  <Markdown inline>{action}</Markdown>
                </span>
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
      dismissLabel={t('FEED_CARD_DISMISS_INSIGHT')}
      showUnseenIndicator={!isSeen}
      className={cn('border-l-4 border-l-blue-500', className)}
    />
  );
}
