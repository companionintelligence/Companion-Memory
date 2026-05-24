import { type MouseEvent } from 'react';

import DOMPurify from 'dompurify';
import parse from 'html-react-parser';

import { NoteIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

export const NOTE_FRAGMENT = gql(`
  fragment TableNoteRowData on NoteType {
    id
    title
    content
  }
`);

interface Props {
  note: FragmentType<typeof NOTE_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function NoteRow({ note, onClick }: Props) {
  const data = useFragment(NOTE_FRAGMENT, note);

  return (
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-0 px-2.5">
        <NoteIcon />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.title}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle truncate">
        {data.content ? parse(DOMPurify.sanitize(data.content, { ALLOWED_TAGS: [] })) : null}
      </SearchTable.Cell>
    </SearchTable.Row>
  );
}
