import { Sheet } from '@ci/shadcn';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FILE_FRAGMENT } from '@/components/entities/grid/FileGridItem';
import { makeFragmentData } from '@/graphql';
import { enterNativeShell, NATIVE_MEMORY_ORIGIN } from '@/test/nativeShell';
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

function makeEntity(overrides: Record<string, unknown> = {}) {
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
        ...overrides,
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

  describe('on the native shell', () => {
    let leaveNativeShell: () => void = () => undefined;

    afterEach(() => leaveNativeShell());

    // QA MEM-06 / MEM-07: the bundled app is served from capacitor://localhost,
    // so the drawer's bare /static/... URLs asked the WebView itself for the
    // photo ("Media couldn't be loaded"), and Download navigated the whole
    // WebView to the app's own 404 page with only "Go Home" to get back. The
    // links have to be absolute URLs on the paired Memory, which Capacitor
    // hands to the system browser.
    it('loads the photo and links Open / Download on the paired Memory origin', async () => {
      leaveNativeShell = enterNativeShell();

      renderWithProviders(
        <EntityDrawerHostProvider value={host}>
          <Sheet open>
            <FileDetails
              entity={
                makeEntity({
                  filename: 'IMG_0001.jpg',
                  contentType: 'image/jpeg',
                  previewUrl: '/companion/preview-key?X-Amz-Signature=p',
                  sourceUrl: '/companion/original-key?X-Amz-Signature=o',
                }) as never
              }
            />
          </Sheet>
        </EntityDrawerHostProvider>,
      );

      const original = `${NATIVE_MEMORY_ORIGIN}/static/companion/original-key?X-Amz-Signature=o`;

      expect(await screen.findByRole('img', { name: 'IMG_0001.jpg' })).toHaveAttribute(
        'src',
        `${NATIVE_MEMORY_ORIGIN}/static/companion/preview-key?X-Amz-Signature=p`,
      );

      const open = screen.getByRole('link', { name: 'Open' });
      expect(open).toHaveAttribute('href', original);
      expect(open).toHaveAttribute('target', '_blank');

      // Exactly one Download: the media's own corner icon is only offered for a
      // same-origin file, and on the phone the file lives on the Memory server.
      const [download, ...rest] = screen.getAllByRole('link', { name: 'Download' });
      expect(rest).toHaveLength(0);
      expect(download).toHaveAttribute('href', original);
      expect(download).toHaveAttribute('target', '_blank');
    });
  });
});
