import { useEffect } from 'react';

import { useApolloClient } from '@apollo/client';

import { apolloMediaLinkRefresher, installMediaLinkRefresh } from '@/lib/mediaLinkRefresh';

/**
 * Gives every photo, video and download link on the page a fresh signed link when the one it
 * holds has expired (see `lib/mediaLinkRefresh.ts`). Renders nothing; mount once, inside Apollo.
 */
export function MediaLinkRefresh() {
  const client = useApolloClient();

  useEffect(() => installMediaLinkRefresh(apolloMediaLinkRefresher(client)), [client]);

  return null;
}
