import { IconButton } from '@ci/shadcn';
import { Trash } from '@ci/shadcn/icons';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

/**
 * A row from PowerSync's local `notes` table (see `@/api/powersync/schema.ts`) — the
 * raw note uuid, unlike the GraphQL-facing `NoteType.id` elsewhere in this app, which
 * is a base64 `"note:<uuid>"` global id. `NotePage`'s `/notes/:id?` route already
 * expects the raw uuid (it encodes internally before querying), so no encode/decode
 * is needed here.
 */
export interface NoteRow {
  id: string;
  title: string | null;
  content: string | null;
}

interface Props {
  note: NoteRow;
  onDelete: (e: React.MouseEvent) => void;
}

export function Note({ note, onDelete }: Props) {
  const { t } = useTranslation();

  return (
    <Link to={`/notes/${note.id}`} key={note.id}>
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
          <IconButton onClick={onDelete} variant="ghost" label={t('NOTES_DELETE')}>
            <Trash className="w-4 h-4" />
          </IconButton>
        </div>
      </div>
    </Link>
  );
}
