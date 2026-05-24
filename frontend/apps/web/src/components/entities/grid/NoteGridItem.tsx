import { type MouseEvent } from 'react';

import DOMPurify from 'dompurify';
import parse from 'html-react-parser';

import { NoteIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const NOTE_FRAGMENT = gql(`
  fragment NoteGridItemData on NoteType {
    id
    title
    content
  }
`);

interface Props {
  note: FragmentType<typeof NOTE_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function NoteGridItem({ note, onClick }: Props) {
  const data = useFragment(NOTE_FRAGMENT, note);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <NoteIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.title}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">
          {data.content ? parse(DOMPurify.sanitize(data.content)) : null}
        </div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Note</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
