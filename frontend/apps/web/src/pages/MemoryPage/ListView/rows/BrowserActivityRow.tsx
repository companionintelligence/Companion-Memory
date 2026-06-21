import { type MouseEvent, type ReactNode, useMemo } from 'react';

import { BrowserActivityIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

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

  const domain = useMemo(() => {
    try {
      const urlObj = new URL(data.url);

      return urlObj.hostname + urlObj.pathname;
    } catch {
      return data.url;
    }
  }, [data.url]);

  return (
    <EntityRow
      icon={<BrowserActivityIcon />}
      title={data.title}
      subtitle={
        <a
          href={data.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {domain}
        </a>
      }
      time={time}
      onClick={onClick}
    />
  );
}
