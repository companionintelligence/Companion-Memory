import { type MouseEvent, type ReactNode } from 'react';

import DOMPurify from 'dompurify';
import parse from 'html-react-parser';

import { NoteIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const NOTE_FRAGMENT = gql(`
  fragment TableNoteRowData on NoteType {
    id
    title
    content
  }
`);

interface Props {
  note: FragmentType<typeof NOTE_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function NoteRow({ note, time, onClick }: Props) {
  const data = useFragment(NOTE_FRAGMENT, note);

  return (
    <EntityRow
      icon={<NoteIcon />}
      title={data.title}
      subtitle={data.content ? parse(DOMPurify.sanitize(data.content, { ALLOWED_TAGS: [] })) : null}
      time={time}
      onClick={onClick}
    />
  );
}
