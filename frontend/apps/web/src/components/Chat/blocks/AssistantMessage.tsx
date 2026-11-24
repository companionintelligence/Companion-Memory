import { type RefObject, useMemo } from 'react';

import { cn } from '@ci/shadcn';

import { Markdown } from '@/components/Markdown';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

interface Props {
  content?: string;
  renderEmptyContent?: boolean;
  createdAt?: string;
  source?: 'openclaw' | 'memory' | 'user';
  streamingRef?: RefObject<HTMLDivElement | null> | ((el: HTMLDivElement | null) => void);
}

function AssistantMessage({ content, renderEmptyContent = false, streamingRef, createdAt, source }: Props) {
  const trimmedContent = useMemo(() => content?.trim(), [content]);
  const fmt = useDateTimeFormat();

  if (!trimmedContent && !renderEmptyContent) {
    return null;
  }

  return (
    <div
      className={cn(
        'relative min-w-0 max-w-[94%] self-start rounded-xl rounded-tl-sm bg-slate-200 px-3 py-2.5 text-foreground shadow-xs dark:bg-secondary',
        'device:max-w-none device:self-stretch device:rounded-lg device:rounded-tl-none device:px-4 device:py-3',
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
          <div className={cn('pt-1 text-xs text-foreground text-right')}>{fmt.dateTime(createdAt)}</div>
        )}
      </div>
    </div>
  );
}

export { AssistantMessage };
