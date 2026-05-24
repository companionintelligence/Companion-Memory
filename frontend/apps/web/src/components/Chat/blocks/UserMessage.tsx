import { useMemo } from 'react';

import { useDeviceLayout } from '@ci/common';
import { cn } from '@ci/shadcn';

import { Markdown } from '@/components/Markdown';

interface Props {
  content: string;
  createdAt?: string;
}

export function UserMessage({ content, createdAt }: Props) {
  const { isMobile } = useDeviceLayout();

  const maxWidth = useMemo(() => (isMobile ? 'max-w-[60%]' : 'max-w-[40%]'), [isMobile]);

  return (
    <div
      className={cn(
        'relative self-end rounded-lg rounded-br-none px-4 py-3 shadow-xs bg-primary text-primary-foreground prose-invert dark:prose max-w-none',
        maxWidth,
      )}
    >
      <Markdown>{content}</Markdown>
      {createdAt && (
        <div className={cn('pt-1 text-xs text-primary-foreground text-right')}>
          {new Date(createdAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
