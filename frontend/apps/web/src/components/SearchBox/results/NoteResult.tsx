import { NoteIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchResultRow } from './SearchResultRow';

export const NOTE_FRAGMENT = gql(`
  fragment SearchResultNoteData on NoteType {
    id
    title
  }
`);

interface Props {
  note: FragmentType<typeof NOTE_FRAGMENT>;
}

export function NoteResult({ note }: Props) {
  const data = useFragment(NOTE_FRAGMENT, note);

  return <SearchResultRow icon={<NoteIcon />} title={data.title} kind="Note" />;
}
