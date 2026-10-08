import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbedPlayer } from './EmbedPlayer';

const player = {
  provider: 'youtube',
  playerUrl: 'https://www.youtube-nocookie.com/embed/abc123',
  posterUrl: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
  aspectRatio: 16 / 9,
  mediaKind: 'video',
};

type CapacitorWindow = { Capacitor?: unknown };

/** The phone apps: Capacitor present, with LocalHub's opener. */
function enterPhoneApp() {
  const openUrl = vi.fn(async () => {});

  (window as unknown as CapacitorWindow).Capacitor = {
    isNativePlatform: () => true,
    Plugins: { LocalHub: { openUrl } },
  };

  return openUrl;
}

afterEach(() => {
  delete (window as unknown as CapacitorWindow).Capacitor;
});

describe('EmbedPlayer', () => {
  it('mounts the provider player in the web app', () => {
    const { container } = render(<EmbedPlayer player={player} title="A video" />);

    expect(container.querySelector('iframe')).toHaveAttribute('src', player.playerUrl);
  });

  it('never mounts a provider frame in the phone apps, where frames can reach native plugins', () => {
    enterPhoneApp();

    const { container } = render(<EmbedPlayer player={player} title="A video" />);

    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('button', { name: /Open in YouTube/ })).toBeInTheDocument();
  });

  it('opens the content page outside the app instead, not through the sign-in tab', () => {
    const openUrl = enterPhoneApp();

    render(<EmbedPlayer player={player} title="A video" pageUrl="https://www.youtube.com/watch?v=abc123" />);
    fireEvent.click(screen.getByRole('button', { name: /Open in YouTube/ }));

    expect(openUrl).toHaveBeenCalledWith({ url: 'https://www.youtube.com/watch?v=abc123', external: true });
  });

  it('falls back to the server-built player URL when the page is not a plain web address', () => {
    const openUrl = enterPhoneApp();

    render(<EmbedPlayer player={player} title="A video" pageUrl="intent://watch/abc123#Intent;end" />);
    fireEvent.click(screen.getByRole('button', { name: /Open in YouTube/ }));

    expect(openUrl).toHaveBeenCalledWith({ url: player.playerUrl, external: true });
  });
});
