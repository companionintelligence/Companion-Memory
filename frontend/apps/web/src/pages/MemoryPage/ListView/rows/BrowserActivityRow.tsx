import { type MouseEvent, useMemo } from 'react';

import { BrowserActivityIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

export const BROWSER_ACTIVITY_FRAGMENT = gql(`
  fragment TableBrowserActivityRowData on BrowserActivityType {
    id
    title
    url
  }
`);

interface Props {
  browserActivity: FragmentType<typeof BROWSER_ACTIVITY_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function BrowserActivityRow({ browserActivity, onClick }: Props) {
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
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-0 px-2.5">
        <BrowserActivityIcon />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.title}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle">
        <a
          href={data.url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline text-blue-600 hover:text-blue-800"
        >
          {domain}
        </a>
      </SearchTable.Cell>
    </SearchTable.Row>
  );
}
