import { useMemo } from 'react';

import { useDeviceLayout } from '@ci/common';
import { cn } from '@ci/shadcn';
import { SendHorizonal } from '@ci/shadcn/icons';

import { Markdown } from '@/components/Markdown';

interface Props {
  content: string;
}

export function UserMessage({ content }: Props) {
  const { isMobile } = useDeviceLayout();

  const maxWidth = useMemo(() => (isMobile ? 'max-w-[60%]' : 'max-w-[40%]'), [isMobile]);

  return (
    <div
      className={cn(
        'relative self-end rounded-xl rounded-br-none px-4 py-3 shadow-sm bg-gradient-to-br from-primary to-primary/90 text-primary-foreground',
        maxWidth,
      )}
    >
      <div className="prose-invert dark:prose max-w-none">
        <Markdown>{content}</Markdown>
      </div>

      {!isMobile && (
        <div className="absolute -bottom-2 -right-2 p-1 rounded-full bg-gradient-to-br from-gray-400 to-gray-400">
          <SendHorizonal className="h-4 w-4 text-primary-foreground z-10 -rotate-120" />
        </div>
      )}
    </div>
  );
}
