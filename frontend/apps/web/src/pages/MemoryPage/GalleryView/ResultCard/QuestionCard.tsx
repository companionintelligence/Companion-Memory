import { Card, Badge } from '@ci/shadcn';
import { Hash } from '@ci/shadcn/icons';

import { formatPath, truncateText } from '@/pages/MemoryPage/ListView/utils.tsx';
import type { SearchResult } from '@/pages/MemoryPage/types.ts';

export interface Props {
  result: SearchResult;
}

export function QuestionCard({ result }: Props) {
  return (
    <Card className="group hover:shadow-lg transition-shadow duration-200 overflow-hidden">
      <Card.Header className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <Badge
            variant="secondary"
            className={`bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200 flex items-center gap-1`}
          >
            <Hash className="h-4 w-4" />
            <span className="capitalize">{result.type}</span>
          </Badge>
          <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
            {result.id.substring(0, 8)}...
          </code>
        </div>

        {result.path && (
          <div className="text-xs text-muted-foreground font-mono">{formatPath(result.path)}</div>
        )}
      </Card.Header>

      <Card.Content>
        <p className="text-sm text-muted-foreground line-clamp-4">{truncateText(result.text, 200)}</p>

        {result.metadata && Object.keys(result.metadata).length > 0 && (
          <div className="mt-4 pt-4 border-t">
            <div className="flex flex-wrap gap-2">
              {Object.entries(result.metadata)
                .slice(0, 3)
                .map(([key, value]) => (
                  <div key={key} className="text-xs">
                    <span className="text-muted-foreground">{key}:</span>{' '}
                    <span className="font-medium">{String(value)}</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
