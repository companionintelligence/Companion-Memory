import { type MouseEvent, useMemo } from 'react';

import { BrowserActivityIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { webAddress } from '@/lib/webAddress';

import { EntityGridItem } from './EntityGridItem';

export const BROWSER_ACTIVITY_FRAGMENT = gql(`
  fragment BrowserActivityGridItemData on BrowserActivityType {
    id
    title
    url
  }
`);

interface Props {
  browserActivity: FragmentType<typeof BROWSER_ACTIVITY_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function BrowserActivityGridItem({ browserActivity, onClick }: Props) {
  const data = useFragment(BROWSER_ACTIVITY_FRAGMENT, browserActivity);

  const address = useMemo(() => webAddress(data.url), [data.url]);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <BrowserActivityIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">Page view</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content className="min-w-0 items-center justify-center gap-2 text-center">
        <div className="line-clamp-3 w-full min-w-0 break-words leading-tight">{data.title}</div>
        {address ? (
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full min-w-0 truncate text-blue-600 hover:text-blue-800 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {address.hostname}
          </a>
        ) : data.url !== data.title ? (
          // Not an address (see webAddress), so not a link.
          <div className="w-full min-w-0 truncate text-muted-foreground">{data.url}</div>
        ) : null}
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Page view</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
