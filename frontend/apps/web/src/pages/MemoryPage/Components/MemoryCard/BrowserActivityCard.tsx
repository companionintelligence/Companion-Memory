import { Card, cn } from '@ci/shadcn';
import { Globe, Clock, MousePointer, TrendingUp } from '@ci/shadcn/icons';

import type { MemoryItem } from '../../types';

export interface Props {
  memory: MemoryItem;
}

export function BrowserActivityCard({ memory }: Props) {
  const actionType = memory.metadata?.actionType as string | undefined;
  const durationSeconds = memory.metadata?.durationSeconds as number | undefined;
  const scrollDepthPercent = memory.metadata?.scrollDepthPercent as number | undefined;
  const productivityScore = memory.metadata?.productivityScore as number | undefined;
  const url = memory.metadata?.url as string | undefined;

  const formatDuration = (seconds: number) => {
    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
      return `${Math.round(seconds / 60)}m`;
    } else {
      return `${Math.round(seconds / 3600)}h`;
    }
  };

  const getActionTypeIcon = (action: string) => {
    switch (action?.toLowerCase()) {
      case 'click':
        return <MousePointer className="h-4 w-4" />;
      case 'scroll':
        return <TrendingUp className="h-4 w-4" />;
      default:
        return <Globe className="h-4 w-4" />;
    }
  };

  const getProductivityColor = (score: number) => {
    if (score > 0.7) {
      return 'text-green-600';
    }

    if (score > 0.4) {
      return 'text-yellow-600';
    }

    return 'text-red-600';
  };

  return (
    <Card className="!gap-2 !py-4 px-6 hover:shadow-lg transition-shadow duration-200">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-1">
          <Globe className="h-6 w-6 text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-card-foreground truncate">{memory.title}</h3>
          </div>
          <p className="text-sm text-muted-foreground">{memory.category}</p>
        </div>
      </div>

      {memory.description && (
        <div className="pt-3 pb-3">
          <p className="text-sm text-muted-foreground leading-relaxed">{memory.description}</p>
        </div>
      )}

      {/* Browser Activity Specific Metadata */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {actionType && (
          <div className="flex items-center gap-1">
            {getActionTypeIcon(actionType)}
            <span className="capitalize">{actionType}</span>
          </div>
        )}

        {durationSeconds && (
          <div className="flex items-center gap-1">
            <Clock className="h-4 w-4" />
            <span>{formatDuration(durationSeconds)}</span>
          </div>
        )}

        {scrollDepthPercent && (
          <div className="flex items-center gap-1">
            <TrendingUp className="h-4 w-4" />
            <span>{Math.round(scrollDepthPercent)}% scrolled</span>
          </div>
        )}

        {productivityScore && (
          <div className="flex items-center gap-1">
            <span className={cn('font-medium', getProductivityColor(productivityScore))}>
              {Math.round(productivityScore * 100)}% productive
            </span>
          </div>
        )}
      </div>

      {memory.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {memory.tags.map((tag, index) => (
            <span key={index} className="px-2 py-1 bg-muted text-muted-foreground text-xs rounded-full">
              {tag}
            </span>
          ))}
        </div>
      )}

      {url && (
        <div className="pt-2">
          <p className="text-xs text-muted-foreground truncate">{url}</p>
        </div>
      )}
    </Card>
  );
}
