import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { CONTENT_FRAGMENT, ContentGridItem } from './ContentGridItem';

function makeContent(overrides: Record<string, unknown> = {}) {
  return makeFragmentData(
    {
      __typename: 'ContentType' as const,
      id: 'c1',
      title: 'A note',
      text: 'some body text',
      contentUrl: null,
      sourceUrl: null,
      mimetype: null,
      ...overrides,
    },
    CONTENT_FRAGMENT,
  );
}

describe('ContentGridItem', () => {
  it('renders an image tile for image content (relative URL → /static)', () => {
    renderWithProviders(
      <ContentGridItem content={makeContent({ mimetype: 'image/png', contentUrl: '/c/x.png' })} />,
    );

    expect(screen.getByRole('img')).toHaveAttribute('src', '/static/c/x.png');
  });

  it('passes through absolute image URLs', () => {
    renderWithProviders(
      <ContentGridItem content={makeContent({ mimetype: 'image/png', contentUrl: 'https://cdn/x.png' })} />,
    );

    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://cdn/x.png');
  });

  it('renders a text tile for non-image content', () => {
    renderWithProviders(<ContentGridItem content={makeContent()} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('A note')).toBeInTheDocument();
    expect(screen.getByText('some body text')).toBeInTheDocument();
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<ContentGridItem content={makeContent()} onClick={onClick} />);

    fireEvent.click(screen.getByText('A note'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
