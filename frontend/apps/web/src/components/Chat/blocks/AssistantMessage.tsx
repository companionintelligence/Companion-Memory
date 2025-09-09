import { type RefObject, useMemo } from 'react';

import { useDeviceLayout } from '@ci/common';
import { cn } from '@ci/shadcn';
import { Bot } from '@ci/shadcn/icons';

import { Markdown } from '@/components/Markdown';

interface Props {
  content?: string;
  renderEmptyContent?: boolean;
  streamingRef?: RefObject<HTMLDivElement | null> | ((el: HTMLDivElement | null) => void);
}

function AssistantMessage({ content, renderEmptyContent = false, streamingRef }: Props) {
  const { isMobile } = useDeviceLayout();

  const trimmedContent = useMemo(() => content?.trim(), [content]);

  if (!trimmedContent && !renderEmptyContent) {
    return null;
  }

  return (
    <div
      className={cn(
        'relative rounded-xl rounded-tl-none px-4 py-3 shadow-sm bg-gradient-to-br from-muted to-muted/80 text-foreground border border-border/50 backdrop-blur-sm',
        'has-[>.streaming-content:empty]:hidden',
      )}
    >
      <div className="streaming-content prose dark:prose-invert max-w-none" ref={streamingRef}>
        {trimmedContent && <Markdown>{trimmedContent}</Markdown>}
      </div>

      {!isMobile && (
        <div className="absolute -top-2 -left-2 p-1 rounded-full bg-gradient-to-br from-gray-400 to-gray-400">
          <Bot className="h-4 w-4 text-primary-foreground z-10" />
        </div>
      )}
    </div>
  );
}

export { AssistantMessage };
