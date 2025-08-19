import { type ForwardedRef, type RefObject, forwardRef, useMemo, useState } from 'react';

import { ChevronDown, ChevronRight, Brain } from '@ci/shadcn/icons';

import { cn } from '@/lib/utils';

interface Props {
  content?: string;
  renderEmptyContent?: boolean;
  defaultExpanded?: boolean;
  streamingRef?: RefObject<HTMLDivElement | null> | ((el: HTMLDivElement | null) => void);
}

function ThinkBlock(
  { content, renderEmptyContent = false, defaultExpanded = true, streamingRef }: Props,
  ref: ForwardedRef<HTMLDivElement>,
) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const trimmedContent = useMemo(() => content?.trim(), [content]);

  if (!trimmedContent && !renderEmptyContent) {
    return null;
  }

  return (
    <div
      ref={ref}
      className={cn(
        'border border-amber-200 dark:border-amber-800/50 text-sm rounded-lg bg-amber-50/50 dark:bg-amber-950/20',
        'has-[.streaming-content:empty]:hidden',
      )}
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 p-3 hover:bg-amber-100/50 dark:hover:bg-amber-900/20 transition-colors text-left"
      >
        <div className="flex items-center gap-2 flex-1">
          <Brain className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm text-amber-700 dark:text-amber-300">AI thinking</span>
        </div>
        <div className="text-amber-600 dark:text-amber-400">
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>

      {/* Content */}
      <div
        className={cn(
          'transition-all duration-200 ease-in-out overflow-hidden',
          isExpanded ? 'max-h-none opacity-100' : 'max-h-0 opacity-0',
        )}
      >
        <div className="p-3 border-t border-amber-200/50 dark:border-amber-800/30 space-y-2 whitespace-pre-wrap leading-relaxed">
          <div className="streaming-content" ref={streamingRef}>
            {trimmedContent}
          </div>
        </div>
      </div>
    </div>
  );
}

const ThinkBlockRef = forwardRef<HTMLDivElement, Props>(ThinkBlock);

export { ThinkBlockRef as ThinkBlock };
