import { GlobalUID } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Trash } from '@ci/shadcn/icons';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { Link } from 'react-router-dom';

import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';

interface Props {
  note: FragmentType<typeof NoteGridItemFragment>;
  onDelete: (e: React.MouseEvent) => void;
}

const NoteGridItemFragment = gql(`
  fragment NoteGridItemFragment on NoteType {
    id
    title
    content
  }
`);

export function Note({ note: noteMasked, onDelete }: Props) {
  const note = useFragment(NoteGridItemFragment, noteMasked);

  return (
    <Link to={`/notes/${GlobalUID.parse('note', note.id)}`} key={note.id}>
      <div className="h-full w-full flex flex-col border border-border bg-card text-card-foreground shadow-md rounded-lg cursor-pointer select-none p-3 gap-3 hover:shadow-lg transition-shadow duration-75">
        <div className="flex items-center gap-2">
          <div className="text-md font-semibold truncate">{note.title ?? 'Untitled Note'}</div>
        </div>
        <div className="flex-1 flex flex-col gap-2 min-h-0">
          <div className="line-clamp-3 leading-tight">
            {note.content ? parse(DOMPurify.sanitize(note.content)) : null}
          </div>
        </div>
        <div className="flex items-center justify-end">
          <Button onClick={onDelete} size="icon" variant="ghost" aria-label="Delete note">
            <Trash className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Link>
  );
}
