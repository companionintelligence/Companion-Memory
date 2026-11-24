import { cn } from '@ci/shadcn';

import { Markdown } from '@/components/Markdown';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

interface Props {
  content: string;
  createdAt?: string;
}

export function UserMessage({ content, createdAt }: Props) {
  const fmt = useDateTimeFormat();

  return (
    <div
      className={cn(
        'relative min-w-0 max-w-[94%] self-end rounded-xl rounded-br-sm bg-primary px-3 py-2.5 text-primary-foreground shadow-xs prose-invert dark:prose',
        'device:max-w-[40%] device:rounded-lg device:rounded-br-none device:px-4 device:py-3',
      )}
    >
      <Markdown>{content}</Markdown>
      {createdAt && (
        <div className={cn('pt-1 text-xs text-primary-foreground text-right')}>{fmt.dateTime(createdAt)}</div>
      )}
    </div>
  );
}
