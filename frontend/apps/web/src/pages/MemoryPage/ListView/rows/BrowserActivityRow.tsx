import { type MouseEvent, type ReactNode, useMemo } from 'react';

import { BrowserActivityIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { webAddress } from '@/lib/webAddress';

import { EntityRow } from './EntityRow';

export const BROWSER_ACTIVITY_FRAGMENT = gql(`
  fragment TableBrowserActivityRowData on BrowserActivityType {
    id
    title
    url
  }
`);

interface Props {
  browserActivity: FragmentType<typeof BROWSER_ACTIVITY_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function BrowserActivityRow({ browserActivity, time, onClick }: Props) {
  const data = useFragment(BROWSER_ACTIVITY_FRAGMENT, browserActivity);

  const address = useMemo(() => webAddress(data.url), [data.url]);

  return (
    <EntityRow
      icon={<BrowserActivityIcon />}
      title={data.title || 'Untitled page'}
      subtitle={
        address ? (
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {address.hostname + address.pathname}
          </a>
        ) : // Not an address (see webAddress): plain text, and none at all when
        // it only repeats the title above it.
        data.url !== data.title ? (
          data.url
        ) : null
      }
      time={time}
      onClick={onClick}
    />
  );
}
