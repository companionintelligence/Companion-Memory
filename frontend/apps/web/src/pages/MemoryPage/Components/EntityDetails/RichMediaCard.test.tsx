import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';

import { RICH_MEDIA_FRAGMENT, RichMediaCard } from './RichMediaCard';

type CapacitorWindow = { Capacitor?: unknown };

function content() {
  return makeFragmentData(
    {
      __typename: 'ContentType' as const,
      player: {
        __typename: 'EmbedPlayerType' as const,
        provider: 'spotify',
        playerUrl: 'https://open.spotify.com/embed/track/xyz',
        posterUrl: null,
        aspectRatio: 1,
        mediaKind: 'audio',
      },
      unfurl: null,
    },
    RICH_MEDIA_FRAGMENT,
  );
}

afterEach(() => {
  delete (window as unknown as CapacitorWindow).Capacitor;
});

describe('RichMediaCard', () => {
  it('plays inline in the web app once asked', () => {
    const { container } = render(<RichMediaCard content={content() as never} title="A track" />);

    fireEvent.click(screen.getByRole('button', { name: /Play on Spotify/ }));

    expect(container.querySelector('iframe')).toHaveAttribute(
      'src',
      'https://open.spotify.com/embed/track/xyz',
    );
  });

  it('hands play to whatever opens the link outside the phone apps, and mounts no frame', () => {
    const openUrl = vi.fn(async () => {});
    (window as unknown as CapacitorWindow).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { LocalHub: { openUrl } },
    };

    const { container } = render(
      <RichMediaCard content={content() as never} title="A track" url="https://open.spotify.com/track/xyz" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Play on Spotify/ }));

    expect(openUrl).toHaveBeenCalledWith({ url: 'https://open.spotify.com/track/xyz', external: true });
    expect(container.querySelector('iframe')).toBeNull();
  });
});
