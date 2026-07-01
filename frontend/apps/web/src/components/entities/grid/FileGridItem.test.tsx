import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { FILE_FRAGMENT, FileGridItem } from './FileGridItem';

function makeFile(overrides: Record<string, unknown> = {}) {
  return makeFragmentData(
    {
      __typename: 'FileType' as const,
      id: 'f1',
      filename: 'photo.jpg',
      previewUrl: null,
      contentType: 'image/jpeg',
      sourceUrl: null,
      title: null,
      description: null,
      size: null,
      createdAt: null,
      ...overrides,
    },
    FILE_FRAGMENT,
  );
}

describe('FileGridItem', () => {
  it('renders a thumbnail (prefixed with /static) when a preview exists', () => {
    renderWithProviders(<FileGridItem file={makeFile({ previewUrl: '/p/thumb.jpg' })} />);

    expect(screen.getByRole('img')).toHaveAttribute('src', '/static/p/thumb.jpg');
  });

  it('falls back to the filename and icon when there is no preview', () => {
    renderWithProviders(<FileGridItem file={makeFile({ filename: 'report.pdf' })} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<FileGridItem file={makeFile()} onClick={onClick} />);

    fireEvent.click(screen.getByText('photo.jpg'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
