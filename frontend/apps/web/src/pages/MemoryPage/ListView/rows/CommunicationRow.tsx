import { type MouseEvent, type ReactNode } from 'react';

import { CommunicationIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const COMMUNICATION_FRAGMENT = gql(`
  fragment TableCommunicationRowData on CommunicationType {
    id
    subject
    preview
  }
`);

interface Props {
  communication: FragmentType<typeof COMMUNICATION_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function CommunicationRow({ communication, time, onClick }: Props) {
  const data = useFragment(COMMUNICATION_FRAGMENT, communication);

  // Chat-style sources have no subject — show the preview as the row's only
  // line instead of an "Untitled communication" placeholder.
  return (
    <EntityRow
      icon={<CommunicationIcon />}
      title={data.subject || data.preview}
      subtitle={data.subject ? data.preview : undefined}
      time={time}
      onClick={onClick}
    />
  );
}
