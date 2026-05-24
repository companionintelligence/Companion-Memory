import { useState } from 'react';

import { useQuery, gql } from '@apollo/client';
import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { InventoryItemModal } from '@/components/modals/InventoryItemModal';

interface InventoryItem {
  id: string;
  name: string;
  category: string;
  description: string;
  brand: string;
  model: string;
  currentValue: number;
  file: {
    sourceUrl: string;
  } | null;
}

const GET_INVENTORY_ITEMS = gql`
  query GetInventoryItems {
    items {
      edges {
        node {
          id
          name
          category
          description
          brand
          model
          currentValue
          file {
            sourceUrl
          }
        }
      }
    }
  }
`;

export function InventoryPage() {
  usePageTitle('Inventory - Companion Intelligence');

  const { data, loading } = useQuery(GET_INVENTORY_ITEMS, {
    fetchPolicy: 'cache-and-network',
  });

  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);

  const items: InventoryItem[] = data?.items?.edges?.map((edge: { node: InventoryItem }) => edge.node) || [];

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading inventory...</div>;
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Inventory</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <h1 className="text-2xl font-bold">Inventory</h1>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {items.map((item) => (
            <div
              key={item.id}
              className="border rounded-lg overflow-hidden bg-white dark:bg-zinc-900 shadow-sm hover:shadow-md transition-shadow cursor-pointer flex flex-col"
              onClick={() => setSelectedItem(item)}
            >
              <div className="aspect-square bg-stone-100 dark:bg-zinc-800 relative overflow-hidden">
                {item.file?.sourceUrl ? (
                  <img
                    src={`/static${item.file.sourceUrl}`}
                    alt={item.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400">No Image</div>
                )}
              </div>
              <div className="p-4 flex flex-col flex-1">
                <h3 className="font-bold text-lg truncate" title={item.name}>
                  {item.name}
                </h3>
                <p className="text-sm text-gray-500 mb-2">{item.category}</p>
                <div className="mt-auto flex justify-between items-center text-sm">
                  <span className="font-medium">${item.currentValue}</span>
                  <span className="text-gray-400 truncate max-w-[50%]">{item.brand}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {items.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <p>No items in your inventory yet.</p>
            <p className="text-sm mt-2">Use the capture button to add items.</p>
          </div>
        )}

        <InventoryItemModal
          open={!!selectedItem}
          onClose={() => setSelectedItem(null)}
          item={selectedItem}
          create={false}
        />
      </PageContent>
    </>
  );
}
