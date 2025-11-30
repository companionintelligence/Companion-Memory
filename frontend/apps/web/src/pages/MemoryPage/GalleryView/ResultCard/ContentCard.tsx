import { Card, Badge } from '@ci/shadcn';
import { Image, Headphones, BadgeQuestionMark, SquarePlay } from '@ci/shadcn/icons';

import { truncateText } from '@/pages/MemoryPage/ListView/utils.tsx';
import type { MemoryItem } from '@/pages/MemoryPage/types.ts';

export interface Props {
  result: MemoryItem;
}

function getContentTypeIcon(type: string) {
  switch (type.split('/')[0]) {
    case 'image':
      return <Image className="h-4 w-4" />;
    case 'video':
      return <SquarePlay className="h-4 w-4" />;
    case 'audio':
      return <Headphones className="h-4 w-4" />;
    default:
      return <BadgeQuestionMark className="h-4 w-4" />;
  }
}

export function ContentCard({ result }: Props) {
  return (
    <Card className="group hover:shadow-lg transition-shadow duration-200 overflow-hidden">
      <Card.Header className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <Badge
            variant="secondary"
            className={`bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 flex items-center gap-1`}
          >
            <Image className="h-4 w-4" />
            <span className="capitalize">{result.type}</span>
          </Badge>
          <Badge
            variant="secondary"
            className={`bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 flex items-center gap-1`}
          >
            {getContentTypeIcon(result?.file?.contentType || '')}
            <span className="capitalize">{result?.file?.contentType?.replace('_', ' ')}</span>
          </Badge>
          <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
            {result.id.substring(0, 8)}...
          </code>
        </div>
      </Card.Header>

      <Card.Content>
        {result?.title && (
          <p className="text-sm text-muted-foreground line-clamp-4">{truncateText(result.title, 200)}</p>
        )}

        {result?.file?.contentType?.startsWith('image/') && (
          <div key={result.id} className="flex flex-col items-center border rounded-lg p-2 bg-gray-50 shadow">
            <img
              src={`/static/${result.file.url}`.replace('//', '/')} //Handle if url has leading slash
              alt={result.file.name}
              className="w-full h-48 object-cover rounded mb-2"
              loading="lazy"
            />
            <div className="text-xs font-medium truncate w-full text-center" title={result.file.name}>
              {result.file.name}
            </div>
            <div className="text-[10px] text-gray-400">{(Number(result.file.size) / 1024).toFixed(1)} KB</div>
          </div>
        )}

        {result?.file?.contentType?.startsWith('video/') && (
          <div key={result.id} className="flex flex-col items-center border rounded-lg p-2 bg-gray-50 shadow">
            <video
              src={result.file.url}
              controls
              className="w-full h-48 object-cover rounded mb-2 bg-black"
              preload="metadata"
            />
            <div className="text-xs font-medium truncate w-full text-center" title={result.file.name}>
              {result.file.name}
            </div>
            <div className="text-[10px] text-gray-400">
              {(Number(result.file.size) / 1024 / 1024).toFixed(1)} MB
            </div>
          </div>
        )}
        {result?.description != null && (
          <div className="mt-4 pt-4 border-t">
            <div className="flex flex-wrap gap-2">
              <div className="text-xs">
                <span className="text-muted-foreground">{result.description}</span>
              </div>
            </div>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
