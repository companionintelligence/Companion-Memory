import { type RefObject, useMemo } from 'react';

import { cn } from '@ci/shadcn';

import { Markdown } from '@/components/Markdown';

interface Props {
  content?: string;
  renderEmptyContent?: boolean;
  createdAt?: string;
  source?: 'openclaw' | 'memory' | 'user';
  streamingRef?: RefObject<HTMLDivElement | null> | ((el: HTMLDivElement | null) => void);
}

function AssistantMessage({
  content,
  renderEmptyContent = false,
  streamingRef,
  createdAt,
  source,
}: Props) {
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
      {source === 'openclaw' ? (
        <span
          className="absolute -left-2 -top-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white"
          title="OpenClaw"
          aria-label="OpenClaw"
        >
          C
        </span>
      ) : null}
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
