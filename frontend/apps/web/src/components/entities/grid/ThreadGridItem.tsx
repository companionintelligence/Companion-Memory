import { type MouseEvent } from 'react';

import { ThreadIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const THREAD_FRAGMENT = gql(`
  fragment ThreadGridItemData on ThreadType {
    id
    name
    description
  }
`);

interface Props {
  thread: FragmentType<typeof THREAD_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ThreadGridItem({ thread, onClick }: Props) {
  const data = useFragment(THREAD_FRAGMENT, thread);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <ThreadIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.name}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">{data.description}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Thread</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
