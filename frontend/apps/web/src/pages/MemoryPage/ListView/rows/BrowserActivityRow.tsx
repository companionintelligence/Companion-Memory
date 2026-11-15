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

  // Text that is not an address (see webAddress) shows plainly. It is left out
  // when it only repeats the title above it.
  let subtitle: ReactNode = data.url !== data.title ? data.url : null;

  if (address) {
    subtitle = (
      <a
        href={address.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:text-blue-800 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {address.hostname + address.pathname}
      </a>
    );
  }

  return (
    <EntityRow
      icon={<BrowserActivityIcon />}
      title={data.title || 'Untitled page'}
      subtitle={subtitle}
      time={time}
      onClick={onClick}
    />
  );
}
