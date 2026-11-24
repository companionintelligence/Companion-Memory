import { useState } from 'react';

import { useQuery } from '@apollo/client/react';

import { PERSON_FRAGMENT } from '@/components/entities/grid/PersonGridItem';
import { EditPersonModal, PERSON_EDITOR_FIELDS } from '@/components/modals/AddItemModal/EditPersonModal';
import { PersonProfileCard } from '@/components/PersonForm';
import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold } from './EntityDetailScaffold';
import { useReadOnly } from './readOnly';

const GET_PERSON_PROFILE = gql(`
  query GetPersonProfileForDrawer($id: ID!) {
    person(id: $id) {
      ...PersonEditorFields
    }
  }
`);

interface Props {
  entity: MemoryEntityOf<'PersonType'>;
}

export function PersonDetails({ entity }: Props) {
  const data = useFragment(PERSON_FRAGMENT, entity);
  const [editOpen, setEditOpen] = useState(false);
  // Shared-search viewers see the same card, minus the edit affordance — the
  // update is owner-scoped and would fail silently.
  const readOnly = useReadOnly();

  // The list/gallery row that opened this drawer carries only the grid fields,
  // so the full profile is fetched here rather than threaded through every
  // caller. Cached after the first open.
  const { data: profileData } = useQuery(GET_PERSON_PROFILE, { variables: { id: entity.id } });
  const profile = useFragment(PERSON_EDITOR_FIELDS, profileData?.person);

  return (
    <>
      <EntityDetailScaffold
        entity={entity}
        title={data.name || 'Person'}
        subtitle="Person"
        taggable
        tagsEditable
        detailSections={
          profile && (
            <PersonProfileCard person={profile} onEdit={readOnly ? undefined : () => setEditOpen(true)} />
          )
        }
        rawData={profile ?? data}
      />

      {!readOnly && (
        <EditPersonModal personId={entity.id} open={editOpen} onClose={() => setEditOpen(false)} />
      )}
    </>
  );
}
