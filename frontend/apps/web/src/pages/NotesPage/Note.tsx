import { GlobalUID } from '@ci/common';
import { IconButton } from '@ci/shadcn';
import { Trash } from '@ci/shadcn/icons';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';

interface Props {
  note: FragmentType<typeof NoteGridItemFragment>;
  onDelete: (e: React.MouseEvent) => void;
}

export const NoteGridItemFragment = gql(`
  fragment NoteGridItemFragment on NoteType {
    id
    title
    content
  }
`);

export function Note({ note: noteMasked, onDelete }: Props) {
  const { t } = useTranslation();
  const note = useFragment(NoteGridItemFragment, noteMasked);

  return (
    <Link to={`/notes/${GlobalUID.parse('note', note.id)}`} className="block min-w-0 device:h-full">
      <div
        data-testid="note-row"
        className="flex w-full cursor-pointer select-none items-center gap-2 rounded-md border border-border bg-card p-2 text-card-foreground transition duration-75 hover:bg-accent device:h-full device:flex-col device:items-stretch device:rounded-lg device:shadow-md device:hover:bg-card device:hover:shadow-lg"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 device:min-h-0 device:gap-2">
          <div className="truncate text-sm font-semibold device:text-base">
            {note.title ?? 'Untitled Note'}
          </div>
          <div className="line-clamp-1 text-sm leading-tight text-muted-foreground device:line-clamp-3 device:text-base device:text-foreground">
            {note.content ? parse(DOMPurify.sanitize(note.content)) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end">
          <IconButton
            onClick={onDelete}
            variant="ghost"
            label={t('NOTES_DELETE')}
            className="size-8 device:size-9"
          >
            <Trash className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </Link>
  );
}
