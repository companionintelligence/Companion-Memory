import { type RefObject, useMemo } from 'react';

import { cn } from '@ci/shadcn';

import { Markdown } from '@/components/Markdown';

interface Props {
  content?: string;
  renderEmptyContent?: boolean;
  createdAt?: string;
  streamingRef?: RefObject<HTMLDivElement | null> | ((el: HTMLDivElement | null) => void);
}

function AssistantMessage({ content, renderEmptyContent = false, streamingRef, createdAt }: Props) {
  const trimmedContent = useMemo(() => content?.trim(), [content]);

  if (!trimmedContent && !renderEmptyContent) {
    return null;
  }

  return (
    <div
      className={cn(
        'relative rounded-lg rounded-tl-none px-4 py-3 shadow-xs bg-slate-200 dark:bg-secondary text-foreground',
        'has-[>.streaming-content:empty]:hidden',
      )}
    >
      <div className="streaming-content prose dark:prose-invert max-w-none" ref={streamingRef}>
        {trimmedContent && <Markdown>{trimmedContent}</Markdown>}
        {createdAt && (
          <div className={cn('pt-1 text-xs text-foreground text-right')}>
            {new Date(createdAt).toLocaleString()}
          </div>
        )}
      </div>
    </div>
  );
}

export { AssistantMessage };
