import { NoteIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

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

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <NoteIcon />
        <div className="font-medium">{data.title}</div>
      </div>
      <div className="text-muted-foreground">Note</div>
    </div>
  );
}
