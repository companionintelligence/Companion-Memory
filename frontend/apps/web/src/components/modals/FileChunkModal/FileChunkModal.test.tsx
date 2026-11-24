import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { FILE_CHUNK_CARD_FRAGMENT } from '@/pages/MemoryPage/Components/EntityCard/FileChunkCard';
import { renderWithProviders } from '@/test/renderWithProviders';

import { FileChunkModal } from './FileChunkModal';

function chunk() {
  return makeFragmentData(
    {
      __typename: 'FileChunkType' as const,
      id: 'chunk-1',
      sectionTitle: 'Totals',
      chunkContent: 'Amount due: 42.00',
      sourceLocator: null,
      createdAt: '2026-08-26T12:00:00.000Z',
      file: {
        __typename: 'FileType' as const,
        id: 'file-1',
        filename: 'notes.txt',
        sourceUrl: '/companion/notes-key?X-Amz-Signature=sig',
      },
    },
    FILE_CHUNK_CARD_FRAGMENT,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FileChunkModal', () => {
  it('opens the stored file in a tab that cannot reach back into the app', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    renderWithProviders(<FileChunkModal entity={chunk() as never} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open File' }));

    // A stored file is served from this origin. Without noopener the new tab's
    // `window.opener` is this app's own window, same-origin and scriptable.
    expect(open).toHaveBeenCalledWith(
      '/static/companion/notes-key?X-Amz-Signature=sig',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
