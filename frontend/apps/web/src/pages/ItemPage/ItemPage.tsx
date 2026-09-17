import { type ReactNode, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, usePageTitle, EmptyState } from '@ci/common';
import { Badge, Button, Card } from '@ci/shadcn';
import { useParams } from 'react-router-dom';

import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { ObjectIdentifierList, ObservationStrip, ProductModelCard } from '@/components/entities';
import { GET_ITEM } from '@/components/entities/itemDocuments';
import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityFieldsCard } from '@/components/EntityFields';
import { EntityGraph } from '@/components/EntityGraph';
import { EntityRelationshipCards } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { EntityEditToggle, EntityTagsDescriptionCard } from '@/components/EntityTagsDescriptionCard';
import { ErrorState } from '@/components/ErrorState';
import { ItemIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';
import { namedChatContext } from '@/lib/agentChat';
import { humanizeEnum } from '@/lib/utils';

import { AcquisitionCard } from './AcquisitionCard';
import { ItemProperties } from './ItemProperties';

export { GET_ITEM };

// Same write the memory drawer makes (UpdateItemDetail), so the page can edit
// the name, category, brand, model and value instead of the description alone.
const UPDATE_ITEM_FIELDS = gql(`
  mutation UpdateItemPageFields($input: UpdateItemInput!) {
    updateItem(input: $input) {
      success
      item {
        id
        name
        description
        category
        brand
        model
        currentValue
      }
    }
  }
`);

const CONFIRM_OBSERVATION = gql(`
  mutation ConfirmItemObservation($id: ID!, $itemId: ID) {
    confirmObservation(id: $id, itemId: $itemId) {
      id
      confirmedByUser
      resolvedObjectId
      resolutionMethod
      resolutionConfidence
    }
  }
`);

const REJECT_OBSERVATION = gql(`
  mutation RejectItemObservation($id: ID!) {
    rejectObservation(id: $id) {
      id
      confirmedByUser
      resolvedObjectId
      resolutionMethod
      resolutionConfidence
    }
  }
`);

export function ItemPage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading, error, refetch } = useQuery(GET_ITEM, {
    variables: {
      id: GlobalUID.encode('item', id!),
    },
  });

  const [updateItemFields] = useMutation(UPDATE_ITEM_FIELDS);
  const [confirmObservation, { loading: confirming }] = useMutation(CONFIRM_OBSERVATION);
  const [rejectObservation, { loading: rejecting }] = useMutation(REJECT_OBSERVATION);

  const item = data?.item;

  const [editMode, setEditMode] = useState(false);

  usePageTitle(item?.name ? `Thing - ${item.name} - Companion Memory` : 'Thing - Companion Memory');

  let content: ReactNode | null = null;

  if (loading && item == null) {
    content = <LoadingPage />;
  } else if (error && item == null) {
    // A failed fetch is not an absent record. Dropping `error` sent a 500, a
    // dead connection or an expired session down the branch below, which told
    // the owner their own thing does not exist.
    content = (
      <ErrorState
        title="Could not load this thing"
        description="This thing is still here — this device could not reach it just now."
        onRetry={() => void refetch()}
      />
    );
  } else if (item == null) {
    content = <EmptyState icon={<ItemIcon size={48} colorized={false} />} message="Thing not found" />;
  } else {
    const lastSeen = item.lastSeenAt ? new Date(item.lastSeenAt) : null;
    const lastSeenLabel =
      lastSeen && !Number.isNaN(lastSeen.getTime()) ? lastSeen.toLocaleDateString() : null;

    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ItemIcon />
            <h1 className="truncate text-2xl font-bold">{item.name || 'Unnamed thing'}</h1>
            {/* A thing that is gone is still a thing that happened. Say where it
                went rather than rendering it identically to one on the shelf. */}
            {item.lifecycleState !== 'ACTIVE' && (
              <Badge variant="secondary">{humanizeEnum(item.lifecycleState)}</Badge>
            )}
            {lastSeenLabel && (
              <span className="hidden text-sm text-muted-foreground sm:inline">
                Last seen {lastSeenLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ChatWithAgentMenu
              context={namedChatContext({
                title: item.name,
                body:
                  [item.description, item.brand, item.model, item.category].filter(Boolean).join(' · ') ||
                  null,
                sourceKind: 'ItemType',
                sourceId: item.id,
              })}
            />
            <EntityEditToggle pressed={editMode} onPressedChange={setEditMode} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-4 md:col-span-2">
            {/* The drawer's field set, so reaching this route directly does not
                silently drop the name, category, brand, model and value editors. */}
            <EntityFieldsCard
              title="Thing"
              resetKey={item.id}
              editMode={editMode}
              onEditModeChange={setEditMode}
              fields={[
                { key: 'name', label: 'Name', value: item.name ?? '' },
                { key: 'category', label: 'Category', value: item.category ?? '' },
                { key: 'brand', label: 'Brand', value: item.brand ?? '' },
                { key: 'model', label: 'Model', value: item.model ?? '' },
                {
                  key: 'currentValue',
                  label: 'Estimated value ($)',
                  value: item.currentValue != null ? String(item.currentValue) : '',
                  inputType: 'number',
                },
              ]}
              onSave={async (values) => {
                // Clearing the field should null out the value, not persist $0. Guard
                // against unparseable input by treating it as cleared too.
                const trimmedValue = values.currentValue?.trim() ?? '';
                const parsedValue = trimmedValue === '' ? null : Number(trimmedValue);
                const currentValue = parsedValue == null || Number.isNaN(parsedValue) ? null : parsedValue;

                const result = await updateItemFields({
                  variables: {
                    input: {
                      id: item.id,
                      name: values.name || '',
                      category: values.category,
                      brand: values.brand,
                      model: values.model,
                      currentValue,
                    },
                  },
                });

                if (!result.data?.updateItem.success) {
                  throw new Error('Update was rejected');
                }
              }}
            />

            <Card>
              <Card.Header>
                <Card.Title className="text-base">Codes</Card.Title>
                <Card.Description>
                  The barcode on the box, the serial on the plate — whatever identifies this exact object.
                </Card.Description>
              </Card.Header>
              <Card.Content>
                <ObjectIdentifierList
                  itemId={item.id}
                  identifiers={item.identifiers}
                  onChanged={() => refetch()}
                />
              </Card.Content>
            </Card>

            <Card>
              <Card.Header>
                <Card.Title className="text-base">Sightings</Card.Title>
                <Card.Description>
                  Frames a detector matched to this thing. Confirming one is what sets its last-seen date.
                </Card.Description>
              </Card.Header>
              <Card.Content>
                <ObservationStrip
                  observations={item.observations}
                  emptyMessage="Nothing has been seen of this thing yet."
                  actions={(target) => (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="flex-1"
                        disabled={confirming || rejecting}
                        onClick={async () => {
                          await confirmObservation({ variables: { id: target.id, itemId: item.id } });
                          await refetch();
                        }}
                      >
                        Yes
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="flex-1"
                        disabled={confirming || rejecting}
                        onClick={async () => {
                          await rejectObservation({ variables: { id: target.id } });
                          await refetch();
                        }}
                      >
                        No
                      </Button>
                    </div>
                  )}
                />
              </Card.Content>
            </Card>

            <EntityGraph entityId={id!} />
          </div>

          <div className="flex flex-col gap-4">
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
                const result = await updateItemFields({
                  variables: { input: { id: item.id, name: item.name ?? '', description: value } },
                });

                if (!result.data?.updateItem.success) {
                  throw new Error('Update was rejected');
                }
              }}
            >
              <ItemProperties item={item} />
            </EntityTagsDescriptionCard>

            {item.product && <ProductModelCard product={item.product} />}

            <AcquisitionCard
              acquisition={item.acquisition}
              acquiredAt={item.acquiredAt}
              acquiredFrom={item.acquiredFrom}
              acquisitionMethod={humanizeEnum(item.acquisitionMethod)}
              purchasePrice={item.purchasePrice}
              currency={item.currency}
            />
          </div>
        </div>

        <EntityRelationshipCards entityId={id!} />
        <EntityEvolutionPanel entityId={id!} entityName={item.name} />
      </PageContent>
    );
  }

  return <>{content}</>;
}
