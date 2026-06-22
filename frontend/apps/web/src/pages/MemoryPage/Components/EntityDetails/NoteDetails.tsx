import { useMutation } from '@apollo/client';

import { NOTE_FRAGMENT } from '@/components/entities/grid/NoteGridItem';
import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold } from './EntityDetailScaffold';

// `updateNote` decodes the GlobalUID server-side, so pass the encoded id.
const UPDATE_NOTE = gql(`
  mutation UpdateNoteDetail($input: UpdateNoteInput!) {
    updateNote(input: $input) {
      success
      note {
        id
        title
        content
      }
    }
  }
`);

interface Props {
  entity: MemoryEntityOf<'NoteType'>;
}

export function NoteDetails({ entity }: Props) {
  const data = useFragment(NOTE_FRAGMENT, entity);
  const [updateNote] = useMutation(UPDATE_NOTE);

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.title || 'Note'}
      subtitle="Note"
      taggable
      editFields={[
        { key: 'title', label: 'Title', value: data.title ?? '' },
        { key: 'content', label: 'Content', value: data.content ?? '', multiline: true },
      ]}
      onSave={async (values) => {
        await updateNote({
          variables: { input: { id: entity.id, title: values.title, content: values.content } },
        });
      }}
      rawData={data}
    />
  );
}
