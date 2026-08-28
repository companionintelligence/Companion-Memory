import { Sheet } from '@ci/shadcn';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FILE_FRAGMENT } from '@/components/entities/grid/FileGridItem';
import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { EntityDrawerHostProvider } from './drawerHost';
import { FileDetails } from './FileDetails';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const FILE_UUID = '01a04136-0ced-7697-99d9-000000000001';
const FILE_GLOBAL_ID = btoa(`file:${FILE_UUID}`);
const host = { setActiveEntity: vi.fn(), refetch: vi.fn() };

function makeEntity() {
  return {
    ...makeFragmentData(
      {
        __typename: 'FileType' as const,
        id: FILE_GLOBAL_ID,
        filename: 'invoice448421297.pdf',
        previewUrl: null,
        contentType: 'application/pdf',
        sourceUrl: '/companion/invoice-key?X-Amz-Signature=sig',
        title: null,
        description: null,
        size: 102400,
        createdAt: '2026-08-26T12:00:00.000Z',
      },
      FILE_FRAGMENT,
    ),
    tags: [],
  };
}

describe('FileDetails', () => {
  it('offers Open in a new tab next to Download', async () => {
    renderWithProviders(
      <EntityDrawerHostProvider value={host}>
        <Sheet open>
          <FileDetails entity={makeEntity() as never} />
        </Sheet>
      </EntityDrawerHostProvider>,
    );

    const href = '/static/companion/invoice-key?X-Amz-Signature=sig';
    const open = await screen.findByRole('link', { name: 'Open' });
    expect(open).toHaveAttribute('href', href);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).not.toHaveAttribute('download');

    const download = screen.getByRole('link', { name: 'Download' });
    expect(download).toHaveAttribute('href', href);
    expect(download).toHaveAttribute('download', 'invoice448421297.pdf');
  });
});
