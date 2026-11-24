import { setApiBaseUrl } from '@ci/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MediaLinkRefresher,
  installMediaLinkRefresh,
  isSignedStaticUrl,
  signedUrlExpiresAt,
} from './mediaLinkRefresh';

const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A signed link minted at `minted` (ms) for `ttl` seconds, as the API hands it out. */
function signed(minted: number, ttl = 300, signature = 'sig'): string {
  const date = new Date(minted)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

  return `/ci/${KEY}?X-Amz-Date=${date}&X-Amz-Expires=${ttl}&X-Amz-Signature=${signature}`;
}

const ORIGIN = 'https://memory.example';
const NOW = Date.UTC(2026, 9, 30, 19, 0, 0);

beforeEach(() => {
  setApiBaseUrl(ORIGIN);
});

afterEach(() => {
  setApiBaseUrl('');
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('signed link helpers', () => {
  it('recognises signed /static links and reads when they stop working', () => {
    const url = `${ORIGIN}/static${signed(NOW)}`;

    expect(isSignedStaticUrl(url)).toBe(true);
    expect(isSignedStaticUrl(`${ORIGIN}/static/ci/${KEY}`)).toBe(false);
    expect(isSignedStaticUrl('https://elsewhere.example/a.jpg?X-Amz-Signature=x')).toBe(false);
    expect(signedUrlExpiresAt(url)).toBe(NOW + 300_000);
    expect(signedUrlExpiresAt(`${ORIGIN}/static/ci/${KEY}?X-Amz-Signature=x`)).toBeNull();
  });
});

describe('MediaLinkRefresher', () => {
  it('re-signs a screenful of failures in one request and resolves each to an absolute link', async () => {
    const resign = vi.fn(async (urls: string[]) => urls.map((_, i) => signed(NOW, 300, `fresh${i}`)));
    const refresher = new MediaLinkRefresher(resign, () => NOW);

    const answers = await Promise.all([
      refresher.refresh(`${ORIGIN}/static${signed(NOW - 600_000, 300, 'a')}`),
      refresher.refresh(`${ORIGIN}/static${signed(NOW - 600_000, 300, 'b')}`),
      refresher.refresh(`${ORIGIN}/static${signed(NOW - 600_000, 300, 'a')}`),
    ]);

    expect(resign).toHaveBeenCalledTimes(1);
    expect(resign.mock.calls[0][0]).toHaveLength(2);
    expect(answers[0]).toBe(`${ORIGIN}/static${signed(NOW, 300, 'fresh0')}`);
    expect(answers[2]).toBe(answers[0]);
  });

  it('reuses a fresh answer while it is good, and asks again once it is about to expire', async () => {
    let now = NOW;
    const resign = vi.fn(async (urls: string[]) => urls.map(() => signed(now)));
    const refresher = new MediaLinkRefresher(resign, () => now);
    const old = `${ORIGIN}/static${signed(NOW - 600_000)}`;

    await refresher.refresh(old);
    await refresher.refresh(old);
    expect(resign).toHaveBeenCalledTimes(1);

    now += 290_000;
    await refresher.refresh(old);
    expect(resign).toHaveBeenCalledTimes(2);
  });

  it('answers null when the appliance cannot be asked or does not know the file', async () => {
    const down = new MediaLinkRefresher(async () => {
      throw new Error('offline');
    });
    const unknown = new MediaLinkRefresher(async (urls) => urls.map(() => null));

    await expect(down.refresh(`${ORIGIN}/static${signed(NOW)}`)).resolves.toBeNull();
    await expect(unknown.refresh(`${ORIGIN}/static${signed(NOW)}`)).resolves.toBeNull();
  });
});

describe('installMediaLinkRefresh', () => {
  function setup(answer: (url: string) => string | null) {
    const refresher = new MediaLinkRefresher(async (urls) => urls.map(answer));
    const refresh = vi.spyOn(refresher, 'refresh');
    const uninstall = installMediaLinkRefresh(refresher);

    return { refresh, uninstall };
  }

  it('puts a fresh link on an image that failed on an expired one, once', async () => {
    const { refresh, uninstall } = setup(() => signed(NOW, 300, 'fresh'));
    const img = document.createElement('img');
    img.src = `${ORIGIN}/static${signed(NOW - 600_000)}`;
    document.body.appendChild(img);

    img.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(img.src).toContain('X-Amz-Signature=fresh'));

    // The fresh link failing too means the file is really gone: no loop.
    img.dispatchEvent(new Event('error'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(refresh).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it('leaves images that are not signed /static links alone', async () => {
    const { refresh, uninstall } = setup(() => signed(NOW));
    const img = document.createElement('img');
    img.src = 'https://localhost/_capacitor_file_/previews/a.jpg';
    document.body.appendChild(img);

    img.dispatchEvent(new Event('error'));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(refresh).not.toHaveBeenCalled();
    uninstall();
  });

  it('swaps a video to the fresh link and puts it back where it was', async () => {
    const { uninstall } = setup(() => signed(NOW, 300, 'fresh'));
    const video = document.createElement('video');
    video.src = `${ORIGIN}/static${signed(NOW - 600_000)}`;
    document.body.appendChild(video);
    const load = vi.spyOn(video, 'load').mockImplementation(() => undefined);
    Object.defineProperty(video, 'currentTime', { value: 42, writable: true });

    video.dispatchEvent(new Event('error'));
    await vi.waitFor(() => expect(video.src).toContain('X-Amz-Signature=fresh'));
    expect(load).toHaveBeenCalled();

    video.currentTime = 0;
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(42);
    uninstall();
  });

  it('holds a click on an expired download link until a fresh one is in hand', async () => {
    const { uninstall } = setup(() => signed(Date.now(), 300, 'fresh'));
    const anchor = document.createElement('a');
    anchor.href = `${ORIGIN}/static${signed(Date.now() - 600_000)}`;
    anchor.download = 'photo.jpg';
    anchor.textContent = 'Download';
    document.body.appendChild(anchor);
    const followed: string[] = [];
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLAnchorElement;
      if (target.dataset.mediaLinkFresh === 'true') {
        followed.push(target.href);
        event.preventDefault();
      }
    });

    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(followed).toHaveLength(1));
    expect(followed[0]).toContain('X-Amz-Signature=fresh');
    uninstall();
  });

  it('lets a click on a link that is still good go straight through', () => {
    const { refresh, uninstall } = setup(() => signed(Date.now()));
    const anchor = document.createElement('a');
    anchor.href = `${ORIGIN}/static${signed(Date.now())}`;
    document.body.appendChild(anchor);
    document.addEventListener('click', (event) => event.preventDefault(), { once: true });

    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(click);

    expect(refresh).not.toHaveBeenCalled();
    uninstall();
  });
});
