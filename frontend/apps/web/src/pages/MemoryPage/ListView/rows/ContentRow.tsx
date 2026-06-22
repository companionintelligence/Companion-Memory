import { type MouseEvent, type ReactNode } from 'react';

import { ContentIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const CONTENT_FRAGMENT = gql(`
  fragment TableContentRowData on ContentType {
    id
    title
    text
  }
`);

interface Props {
  content: FragmentType<typeof CONTENT_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ContentRow({ content, time, onClick }: Props) {
  const data = useFragment(CONTENT_FRAGMENT, content);

  return (
    <EntityRow
      icon={<ContentIcon />}
      title={data.title || 'Untitled content'}
      subtitle={data.text}
      time={time}
      onClick={onClick}
    />
  );
}
