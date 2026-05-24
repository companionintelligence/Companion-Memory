import { type MouseEvent } from 'react';

import { ContentIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const CONTENT_FRAGMENT = gql(`
  fragment ContentGridItemData on ContentType {
    id
    title
    text
  }
`);

interface Props {
  content: FragmentType<typeof CONTENT_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ContentGridItem({ content, onClick }: Props) {
  const data = useFragment(CONTENT_FRAGMENT, content);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <ContentIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.title}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">{data.text}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Content</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
