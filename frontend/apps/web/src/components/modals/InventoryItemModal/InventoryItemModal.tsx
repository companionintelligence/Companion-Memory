import { useEffect, useState } from 'react';

import { useMutation, type Reference, isReference } from '@apollo/client';
import { Button, Dialog, Input, Label, Textarea, cn } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { gql } from '@/graphql';
import { GET_ITEM } from '@/pages/ItemPage/ItemPage';

export interface InventoryItem {
  id: string;
  name: string;
  category?: string | null;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  currentValue?: number | null;
  file?: {
    sourceUrl: string;
  } | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  item: InventoryItem | null;
  create: boolean;
  detailPagePath?: string;
}

const CREATE_INVENTORY_ITEM = gql(`
  mutation CreateItem($input: CreateItemInput!) {
    createItem(input: $input) {
      item {
        id
        name
        category
        description
        brand
        model
        currentValue
        tags {
          id
          label
        }
      }
      success
    }
  }
`);

const UPDATE_INVENTORY_ITEM = gql(`
  mutation UpdateItem($input: UpdateItemInput!) {
    updateItem(input: $input) {
      item {
        id
        name
        category
        description
        brand
        model
        currentValue
        tags {
          id
          label
        }
      }
      success
    }
  }
`);

export function InventoryItemModal({ open, onClose, item, create = false, detailPagePath }: Props) {
  const [formData, setFormData] = useState<Partial<InventoryItem>>({});

  useEffect(() => {
    if (item) {
      setFormData({
        name: item.name ?? '',
        category: item.category ?? '',
        description: item.description ?? '',
        brand: item.brand ?? '',
        model: item.model ?? '',
        currentValue: item.currentValue ?? 0,
      });
    }
  }, [item]);

  const handleSubmit = async () => {
    if (create) {
      await createItem({
        variables: {
          input: {
            name: formData.name || '',
            category: formData.category,
            description: formData.description,
            brand: formData.brand,
            model: formData.model,
            currentValue: formData.currentValue ? Number(formData.currentValue) : 0,
          },
        },
      });
      setFormData({});
      onClose();
    } else {
      await updateItem({
        variables: {
          input: {
            id: item!.id,
            name: formData.name || '',
            category: formData.category,
            description: formData.description,
            brand: formData.brand,
            model: formData.model,
            currentValue: formData.currentValue ? Number(formData.currentValue) : 0,
          },
        },
      });
      setFormData({});
      onClose();
    }
  };

  const [createItem] = useMutation(CREATE_INVENTORY_ITEM, {
    update(cache, { data }) {
      if (data?.createItem && data.createItem.success && data.createItem.item) {
        cache.writeQuery({
          query: GET_ITEM,
          variables: {
            id: data.createItem.item.id,
          },
          data: {
            item: data.createItem.item,
          },
        });

        cache.modify({
          fields: {
            items(existingItems = { edges: [] }) {
              const newItemRef = cache.writeFragment({
                data: data.createItem.item,
                fragment: gql(`
                  fragment NewItem on ItemType {
                    id
                    name
                    category
                    description
                    brand
                    model
                    currentValue
                  }
                `),
              });

              return {
                ...existingItems,
                edges: [{ node: newItemRef }, ...existingItems.edges],
              };
            },
          },
        });
      }
    },
  });

  const [updateItem] = useMutation(UPDATE_INVENTORY_ITEM, {
    update(cache, { data }) {
      const updatedItemId = data?.updateItem?.item?.id;

      if (updatedItemId) {
        cache.modify({
          fields: {
            items(
              existingItems:
                | {
                    edges: { node: Reference }[];
                  }
                | Reference = { edges: [] },
              { readField },
            ) {
              if (isReference(existingItems)) {
                return existingItems;
              }

              return {
                ...existingItems,
                edges: existingItems.edges.map((edge) => {
                  const edgeNodeId = readField('id', edge.node);

                  if (!data?.updateItem?.item) {
                    return edge;
                  }

                  return edgeNodeId !== updatedItemId
                    ? edge
                    : {
                        ...edge,
                        ...data.updateItem.item,
                      };
                }),
              };
            },
          },
        });
      }
    },
  });

  const imageUrl = item?.file?.sourceUrl ? `/static${item.file.sourceUrl}` : null;
  const showDetailLink = !create && Boolean(detailPagePath);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <Dialog.Content className="sm:max-w-[800px] overflow-hidden">
        <div className="flex flex-col md:flex-row h-[80vh] md:h-[600px]">
          {/* Image Section */}
          {!create && (
            <div className="w-full md:w-1/2 bg-stone-100 dark:bg-zinc-900 flex items-center justify-center overflow-hidden">
              {imageUrl ? (
                <img src={imageUrl} alt={item!.name} className="w-full h-full object-contain" />
              ) : (
                <div className="text-gray-400">No image available</div>
              )}
            </div>
          )}

          {/* Form Section */}
          <div className={cn('w-full p-6 flex flex-col gap-4 overflow-y-auto', !create && 'md:w-1/2')}>
            <Dialog.Header>
              <Dialog.Title>{create ? 'Create item' : 'Item details'}</Dialog.Title>
            </Dialog.Header>

            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={formData.name || ''}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="category">Category</Label>
                <Input
                  id="category"
                  value={formData.category || ''}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description || ''}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="min-h-[100px]"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="brand">Brand</Label>
                  <Input
                    id="brand"
                    value={formData.brand || ''}
                    onChange={(e) => setFormData({ ...formData, brand: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="model">Model</Label>
                  <Input
                    id="model"
                    value={formData.model || ''}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="value">Estimated Value ($)</Label>
                <Input
                  id="value"
                  type="number"
                  value={formData.currentValue || 0}
                  onChange={(e) => setFormData({ ...formData, currentValue: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        </div>
        <Dialog.Footer className="flex gap-2 justify-end">
          {showDetailLink && (
            <Button asChild type="button" variant="outline">
              <Link to={detailPagePath!}>View details</Link>
            </Button>
          )}
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              setFormData({});
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" className="bg-green-600 hover:bg-green-700" onClick={handleSubmit}>
            {create ? 'Add' : 'Update'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}
