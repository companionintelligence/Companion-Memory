import { type ReactNode, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, usePageTitle, EmptyState } from '@ci/common';
import { useParams } from 'react-router-dom';

import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityGraph } from '@/components/EntityGraph';
import { EntityRelationshipCards } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { EntityEditToggle, EntityTagsDescriptionCard } from '@/components/EntityTagsDescriptionCard';
import { ItemIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

export const GET_ITEM = gql(`
  query GetItem($id: ID!) {
    item(id: $id) {
      id
      name
      description
      tags {
        id
        label
      }
    }
  }
`);

const UPDATE_ITEM_DESCRIPTION = gql(`
  mutation UpdateItemDescription($input: UpdateItemInput!) {
    updateItem(input: $input) {
      success
      item {
        id
        description
      }
    }
  }
`);

export function ItemPage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading } = useQuery(GET_ITEM, {
    variables: {
      id: GlobalUID.encode('item', id!),
    },
  });

  const [updateItemDescription] = useMutation(UPDATE_ITEM_DESCRIPTION);

  const item = data?.item;

  const [editMode, setEditMode] = useState(false);

  usePageTitle(item?.name ? `Item - ${item.name} - Companion Intelligence` : 'Item - Companion Intelligence');

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (item == null) {
    content = <EmptyState icon={<ItemIcon size={48} colorized={false} />} message="Item not found" />;
  } else {
    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ItemIcon />
            <h1 className="text-2xl font-bold">{item.name}</h1>
          </div>
          <EntityEditToggle pressed={editMode} onPressedChange={setEditMode} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <EntityGraph entityId={id!} />
          </div>
          <EntityTagsDescriptionCard
            entityType="item"
            entityId={id!}
            resetKey={item.id}
            tags={item.tags.map((t) => t.label)}
            description={item.description}
            editMode={editMode}
            onDescriptionSave={async (value) => {
              // UpdateItemInput requires `name`, so a description-only edit has to resend it.
              // That makes this a last-write-wins update on the name as well: if it was renamed
              // elsewhere since this page loaded, the cached value here would win. Same trade the
              // existing MemoryPage detail editors make, and the page has no polling to widen it.
              // The `?? ''` only fires when the stored name is genuinely null — the query selects
              // `name`, so it is not a projection gap — and null and '' both render as 'Unnamed'.
              // Omitting the field instead is not an option: it is non-null on the input.
              const result = await updateItemDescription({
                variables: { input: { id: item.id, name: item.name ?? '', description: value } },
              });

              if (!result.data?.updateItem.success) {
                throw new Error('Update was rejected');
              }
            }}
          />
        </div>

        <EntityRelationshipCards entityId={id!} />
        <EntityEvolutionPanel entityId={id!} entityName={item.name} />
      </PageContent>
    );
  }

  return <>{content}</>;
}
