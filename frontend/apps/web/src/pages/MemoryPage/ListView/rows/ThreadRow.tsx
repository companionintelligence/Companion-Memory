import { type MouseEvent, type ReactNode } from 'react';

import { ThreadIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

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

  return (
    <EntityRow
      icon={<ThreadIcon />}
      title={data.name}
      subtitle={data.description}
      time={time}
      onClick={onClick}
    />
  );
}
