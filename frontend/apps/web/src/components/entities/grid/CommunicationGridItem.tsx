import { type MouseEvent } from 'react';

import { CommunicationIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const COMMUNICATION_FRAGMENT = gql(`
  fragment CommunicationGridItemData on CommunicationType {
    id
    subject
    preview
  }
`);

interface Props {
  communication: FragmentType<typeof COMMUNICATION_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function CommunicationGridItem({ communication, onClick }: Props) {
  const data = useFragment(COMMUNICATION_FRAGMENT, communication);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <CommunicationIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.subject}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">{data.preview}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Communication</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
