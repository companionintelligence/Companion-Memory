import { type MouseEvent } from 'react';

import { CommunicationIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { formatDateTime } from '@/pages/MemoryPage/Components/utils';

import { EntityGridItem } from './EntityGridItem';
import { SourceBadge } from './SourceBadge';

export const COMMUNICATION_FRAGMENT = gql(`
  fragment CommunicationGridItemData on CommunicationType {
    id
    subject
    preview
    time
    type
    direction
    from {
      id
      name
    }
  }
`);

interface Props {
  communication: FragmentType<typeof COMMUNICATION_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function CommunicationGridItem({ communication, onClick }: Props) {
  const data = useFragment(COMMUNICATION_FRAGMENT, communication);

  const sender = data.from?.name;
  const heading =
    data.subject || (sender ? `${data.direction === 'outgoing' ? 'To' : 'From'} ${sender}` : null);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <CommunicationIcon className="shrink-0" />

        {/* No subject and no sender: render no heading at all — the preview
            below is the item's text — instead of a "Message" placeholder. */}
        {heading && <div className="text-md font-semibold truncate">{heading}</div>}
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight text-sm text-muted-foreground">{data.preview}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="justify-between">
        <EntityGridItem.Meta>
          {data.time && <span className="truncate">{formatDateTime(data.time)}</span>}
          {sender && data.subject && <span className="truncate">{sender}</span>}
        </EntityGridItem.Meta>
        <SourceBadge source={data.type} fallback="Message" />
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
