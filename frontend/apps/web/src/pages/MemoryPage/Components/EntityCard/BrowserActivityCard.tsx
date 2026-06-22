import { Card, Tooltip } from '@ci/shadcn';
import { Globe, Clock, MousePointer, TrendingUp } from '@ci/shadcn/icons';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { useEntityService } from '../../../MemoryPage/useEntityService';

export interface Props {
  entity: FragmentType<typeof BROWSER_ACTIVITY_FRAGMENT>;
}

export const BROWSER_ACTIVITY_FRAGMENT = gql(`
  fragment TimelineBrowserActivityCardData on BrowserActivityType {
    id
    title
    url
    actionType
    duration
    time
    tags {
      label
    }
  }
`);

export function BrowserActivityCard({ entity }: Props) {
  const [, { setActiveEntity }] = useEntityService();
  const data = useFragment(BROWSER_ACTIVITY_FRAGMENT, entity);
  const actionType = data.actionType as string | undefined;
  const durationSeconds = data.duration as number | undefined;
  const url = data.url as string | undefined;

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

  return (
    <Card
      className="!gap-2 !py-4 px-6 cursor-pointer hover:shadow-lg transition-shadow duration-200"
      onClick={() => setActiveEntity({ ...data, __typename: 'BrowserActivityType', bucketTime: data.time })}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-1">
          <Globe className="h-6 w-6 text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <Tooltip>
            <Tooltip.Trigger asChild>
              <h3 className="text-lg font-semibold text-card-foreground truncate cursor-default">
                {data.title || 'Untitled page'}
              </h3>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>{data.title || 'Untitled page'}</p>
            </Tooltip.Content>
          </Tooltip>
          <p className="text-sm text-muted-foreground">{data.actionType}</p>
        </div>
      </div>

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
      </div>

      {/*{data.tags.length > 0 && (*/}
      {/*  <div className="flex flex-wrap gap-2 pt-2">*/}
      {/*    {data.tags.map((tag, index) => (*/}
      {/*      <Tag key={index} text={tag} />*/}
      {/*    ))}*/}
      {/*  </div>*/}
      {/*)}*/}

      {url && (
        <div className="pt-2">
          <p className="text-xs text-muted-foreground truncate">{url}</p>
        </div>
      )}
    </Card>
  );
}
