import { useCallback, useState } from 'react';

import { useQuery } from '@apollo/client';
import { LoadingPage, Portal, usePageTitle } from '@ci/common';
import { Breadcrumb } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { FileModal } from '@/components/modals/FileModal';
import { gql } from '@/graphql';

import { GridItem } from './GridItem';

const GET_FILES = gql(`
  query GetFiles($first: Int, $after: String) {
    files(first: $first, after: $after) {
      edges {
        node {
          id
          ...FileGridItemFragment
        }
      }
    }
  }
`);

export function FilesPage() {
  usePageTitle('Files - Companion Intelligence');

  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const { data, loading } = useQuery(GET_FILES, {
    variables: { first: 50 },
    fetchPolicy: 'cache-and-network',
  });

  const handleClose = useCallback(() => setSelectedFile(null), []);

  if (loading) {
    return <LoadingPage />;
  }

  const files = data?.files.edges.map((edge) => edge.node) || [];

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
              <Breadcrumb.Page>Files</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {files.map((file) => (
            <GridItem key={file.id} file={file} onSelect={setSelectedFile} />
          ))}
        </div>

        <FileModal fileId={selectedFile ?? null} onClose={handleClose} />
      </PageContent>
    </>
  );
}
