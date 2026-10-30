import { type MouseEvent, type ReactNode } from 'react';

import { ThreadIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import { threadIdOf, threadLabel } from '@/pages/ChatPage/useRecentThreads';

import { EntityRow } from './EntityRow';

export const THREAD_FRAGMENT = gql(`
  fragment TableThreadRowData on ThreadType {
    id
    name
    description
  }
`);

interface Props {
  thread: FragmentType<typeof THREAD_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ThreadRow({ thread, time, onClick }: Props) {
  const data = useFragment(THREAD_FRAGMENT, thread);
  const fmt = useDateTimeFormat();

  return (
    <EntityRow
      icon={<ThreadIcon />}
      // A chat's title is written by a background job after the first reply, so
      // a thread started from Chat has none for a while (or for good, if that
      // job never ran). Until then it has the name Chat gives it.
      title={threadLabel({ id: threadIdOf(data.id), name: data.name }, fmt)}
      subtitle={data.description}
      time={time}
      onClick={onClick}
    />
  );
}
