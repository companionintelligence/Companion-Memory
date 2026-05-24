import { type MouseEvent } from 'react';

import { ActionIcon } from '@/components/icons';
import { Markdown } from '@/components/Markdown';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const ACTION_FRAGMENT = gql(`
  fragment ActionGridItemData on ActionType {
    id
    actionTitle: title
    actionText: text
  }
`);

interface Props {
  action: FragmentType<typeof ACTION_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ActionGridItem({ action, onClick }: Props) {
  const data = useFragment(ACTION_FRAGMENT, action);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <ActionIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.actionTitle}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">
          <Markdown>{data.actionText}</Markdown>
        </div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Action</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
