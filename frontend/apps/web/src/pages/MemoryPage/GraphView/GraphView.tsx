import { cn } from '@ci/shadcn';

import { GraphTabPanel } from './GraphExplorerModal';
export interface GraphViewProps {
  variant?: 'desktop' | 'mobile';
}

export function GraphView({ variant = 'desktop' }: GraphViewProps) {
  return (
    <div className={cn('flex flex-col gap-6', variant === 'mobile' ? 'p-2 pt-0' : 'p-4 pt-0')}>
      <GraphTabPanel variant={variant} />
    </div>
  );
}
