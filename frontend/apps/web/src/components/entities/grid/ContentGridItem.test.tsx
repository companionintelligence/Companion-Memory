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
      sourceType: null,
      sourceSystem: null,
      sourceId: null,
      createdAt: '2026-08-26T12:00:00.000Z',
      mimetype: null,
      mediaUrl: null,
      mediaFilename: null,
      mediaSize: null,
      player: null,
      unfurl: null,
      ...overrides,
    },
    CONTENT_FRAGMENT,
  );
}

describe('ContentGridItem', () => {
  it('renders an image tile for image content (relative URL → /static)', () => {
    const { container } = renderWithProviders(
      <ContentGridItem content={makeContent({ mimetype: 'image/png', contentUrl: '/c/x.png' })} />,
    );

    expect(container.querySelector('img')).toHaveAttribute('src', '/static/c/x.png');
  });

  it('passes through absolute image URLs', () => {
    const { container } = renderWithProviders(
      <ContentGridItem content={makeContent({ mimetype: 'image/png', contentUrl: 'https://cdn/x.png' })} />,
    );

    expect(container.querySelector('img')).toHaveAttribute('src', 'https://cdn/x.png');
  });

  it('renders a text tile for non-image content', () => {
    renderWithProviders(<ContentGridItem content={makeContent()} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('A note')).toBeInTheDocument();
    expect(screen.getByText('some body text')).toBeInTheDocument();
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  // Photo/video events with no linked content row (fixed today) leave an image-typed
  // entity with both contentUrl and sourceUrl null. Before the fix this rendered a
  // broken <img> tag; it must fall back to the same placeholder tile as text content.
  it('falls back to the placeholder tile for image content with no thumbnail URL at all', () => {
    renderWithProviders(
      <ContentGridItem
        content={makeContent({ mimetype: 'image/jpeg', contentUrl: null, sourceUrl: null })}
      />,
    );

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('A note')).toBeInTheDocument();
    expect(screen.getByText('some body text')).toBeInTheDocument();
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  // A Spotify track has no linked image (mimetype audio/ogg); once the
  // enrich.unfurl stage has cached its poster, the tile should show it
  // instead of falling to the plain text card.
  it("shows the unfurl stage's cached poster for a non-image row (Spotify cover art)", () => {
    const { container } = renderWithProviders(
      <ContentGridItem
        content={makeContent({
          mimetype: 'audio/ogg',
          unfurl: {
            __typename: 'UnfurlType' as const,
            status: 'ok',
            thumbnailUrl: 'https://i.scdn.co/image/ab67616d00001e02abc',
          },
        })}
      />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://i.scdn.co/image/ab67616d00001e02abc',
    );
  });

  it("falls back to the player's templated poster when there is no unfurl thumbnail", () => {
    const { container } = renderWithProviders(
      <ContentGridItem
        content={makeContent({
          mimetype: 'video/mp4',
          player: {
            __typename: 'EmbedPlayerType' as const,
            posterUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
          },
        })}
      />,
    );

    expect(container.querySelector('img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/abc/hqdefault.jpg');
  });

  it('does not show a picture for a non-image row before the unfurl stage has visited it', () => {
    renderWithProviders(<ContentGridItem content={makeContent({ mimetype: 'audio/ogg' })} />);

    expect(screen.queryByRole('img')).toBeNull();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<ContentGridItem content={makeContent()} onClick={onClick} />);

    fireEvent.click(screen.getByText('A note'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
