import { ThreadIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchResultRow } from './SearchResultRow';

export const THREAD_FRAGMENT = gql(`
  fragment SearchResultThreadData on ThreadType {
    id
    name
    description
  }
`);

interface Props {
  thread: FragmentType<typeof THREAD_FRAGMENT>;
}

export function ThreadResult({ thread }: Props) {
  const data = useFragment(THREAD_FRAGMENT, thread);

  return <SearchResultRow icon={<ThreadIcon />} title={data.name?.trim() || 'Untitled chat'} kind="Thread" />;
}
