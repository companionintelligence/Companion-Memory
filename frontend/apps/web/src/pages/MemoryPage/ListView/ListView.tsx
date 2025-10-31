import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Table } from '@ci/shadcn';
import { Search } from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';
import { useMemoryService } from '@/pages/MemoryPage/useMemoryService.tsx';

export function ListView() {
  usePageTitle('Search - Companion Intelligence');
  const { searchQuery, searchResults } = useMemoryService();

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Search</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Results Display */}
        {searchResults.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">
                  {searchResults.length > 0 ? `Found ${searchResults.length} results` : 'No results found'}
                </h3>
                {searchResults.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    Sorted by relevance • Most similar results appear first
                  </p>
                )}
              </div>
            </div>

            {searchResults.length > 0 ? (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Type</Table.Head>
                    <Table.Head>Content</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {searchResults.map((result) => (
                    <Table.Row key={result.id}>
                      <Table.Cell className="capitalize">{result.type.replace('_', ' ')}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{result.text}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            ) : (
              searchQuery?.length > 0 &&
              searchResults?.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <p>No results found for your search query.</p>
                  <p className="text-sm mt-2">Try using different keywords or a more general search term.</p>
                </div>
              )
            )}
          </>
        )}

        {/* Initial State */}
        {searchQuery?.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg">Enter a search query to find relevant content</p>
            <p className="text-sm mt-2">The search uses semantic similarity to find related information</p>
          </div>
        )}
      </PageContent>
    </>
  );
}
