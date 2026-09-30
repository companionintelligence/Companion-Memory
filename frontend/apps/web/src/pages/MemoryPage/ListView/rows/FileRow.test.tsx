import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { FILE_FRAGMENT, FileRow } from './FileRow';

function makeFile(overrides: Record<string, unknown> = {}) {
  return makeFragmentData(
    {
      __typename: 'FileType' as const,
      id: 'f1',
      filename: 'photo.jpg',
      title: 'Photo',
      previewUrl: null,
      sourceUrl: null,
      contentType: 'image/jpeg',
      ...overrides,
    },
    FILE_FRAGMENT,
  );
}

describe('FileRow', () => {
  it('renders a thumb from previewUrl when present', () => {
    const { container } = renderWithProviders(<FileRow file={makeFile({ previewUrl: '/p/thumb.jpg' })} />);

    expect(container.querySelector('img')).toHaveAttribute('src', '/static/p/thumb.jpg');
  });

  it('falls back to sourceUrl for image/png when preview is missing', () => {
    const { container } = renderWithProviders(
      <FileRow
        file={makeFile({
          filename: 'capture.png',
          contentType: 'image/png',
          previewUrl: null,
          sourceUrl: '/u/shot.png',
        })}
      />,
    );

    expect(container.querySelector('img')).toHaveAttribute('src', '/static/u/shot.png');
  });

  /**
   * A non-media file (no preview variant, and resolveFileTileUrl won't fall
   * back to sourceUrl for a type it can't render as an <img>) has no URL to
   * thumbnail at all — the row must fall back to the generic FileIcon glyph
   * rather than rendering a broken <img src="">.
   */
  it('falls back to the generic file icon when there is no thumbnail URL', () => {
    renderWithProviders(
      <FileRow
        file={makeFile({
          filename: 'report.pdf',
          contentType: 'application/pdf',
          previewUrl: null,
          sourceUrl: '/u/report.pdf',
        })}
      />,
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });
});
