import { Card, Badge } from '@ci/shadcn';
import { Database } from '@ci/shadcn/icons';

import { formatPath, truncateText } from '@/pages/MemoryPage/ListView/utils.tsx';
import type { SearchResult } from '@/pages/MemoryPage/types.ts';

export interface Props {
  result: SearchResult;
}

export function DocumentCard({ result }: Props) {
  return (
    <Card className="group hover:shadow-lg transition-shadow duration-200 overflow-hidden">
      {result.imageUrl && (
        <div className="aspect-video w-full overflow-hidden bg-muted">
          <img
            src={result.imageUrl}
            alt={`Preview for ${result.type}`}
            className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-200"
            onError={(e) => {
              // Hide image if it fails to load
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
        </div>
      )}

      <Card.Header className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <Badge
            variant="secondary"
            className={`bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 flex items-center gap-1`}
          >
            <Database className="h-4 w-4" />
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
