import { useEffect, useState, useCallback } from 'react';

import { Card, Badge } from '@ci/shadcn';
import {
  Dumbbell,
  BriefcaseBusiness,
  Building2,
  Hospital,
  CupSoda,
  Image,
  House,
  Film,
  Music,
  PersonStanding,
  School,
  TreePine,
  BadgeQuestionMark,
  Soup,
} from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';
import { formatPath, truncateText } from '@/pages/MemoryPage/ListView/utils.tsx';
import type { MemoryItem, SearchResult } from '@/pages/MemoryPage/types.ts';

export interface Props {
  result: SearchResult;
}

function getEntityTypeIcon(type: string) {
  switch (type.replace('_', ' ').toLowerCase()) {
    case 'music genre':
      return <Music className="h-4 w-4" />;
    case 'food':
    case 'cuisine':
      return <Soup className="h-4 w-4" />;
    case 'beverage':
      return <CupSoda className="h-4 w-4" />;
    case 'movie genre':
      return <Film className="h-4 w-4" />;
    case 'professional':
      return <BriefcaseBusiness className="h-4 w-4" />;
    case 'activity':
      return <PersonStanding className="h-4 w-4" />;
    case 'residence':
      return <House className="h-4 w-4" />;
    case 'work site':
      return <Building2 className="h-4 w-4" />;
    case 'school':
      return <School className="h-4 w-4" />;
    case 'park':
      return <TreePine className="h-4 w-4" />;
    case 'gym':
      return <Dumbbell className="h-4 w-4" />;
    case 'clinic':
    case 'hospital':
    case 'doctors office':
      return <Hospital className="h-4 w-4" />;
    default:
      return <BadgeQuestionMark className="h-4 w-4" />;
  }
}

export function EntityCard({ result }: Props) {
  const [{ authToken }] = useAuth();
  const [entity, setEntity] = useState<MemoryItem | null>(null);

  const hydrateEntity = useCallback(async () => {
    const question = await (
      await fetch(`/api/memory/${result.id}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      })
    ).json();
    setEntity(question);
  }, [result]);

  useEffect(() => {
    hydrateEntity();
  }, [result]);

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
            {getEntityTypeIcon(entity?.metadata?.properties?.type || '')}
            <span className="capitalize">{entity?.metadata?.properties?.type?.replace('_', ' ')}</span>
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

        {entity?.description != null && (
          <div className="mt-4 pt-4 border-t">
            <div className="flex flex-wrap gap-2">
              <div className="text-xs">
                <span className="text-muted-foreground">{entity.description}</span>
              </div>
            </div>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
