import type { ApolloClient } from '@apollo/client';

import { resolveMediaUrl } from '@/components/entities/resolveMediaUrl';
import { gql } from '@/graphql';

/**
 * Fresh links for photos and videos whose signed link expired while it sat in the app.
 *
 * Every `/static/` link the API hands out is signed for `staticfiles.auth.signatureTTL` (five
 * minutes). The links ride in Apollo's cache, which keeps them for as long as the app is open,
 * so a tile re-created after scrolling, a page revisited, a photo opened full size or a video
 * still playing after that asks the object store with an expired signature and gets a 403.
 *
 * Rather than every image component handling that, the document listens (capture phase -- media
 * `error` events do not bubble) for an <img>, <video>, <audio> or <source> that failed on a
 * signed `/static/` link, asks the API to re-sign it (`refreshMediaUrls`, batched), and puts the
 * fresh link on the element. A video resumes where it was. Each element gets one retry per link,
 * so a file that is really gone does not loop. Clicks on a signed link that has expired, or is
 * about to, are held until a fresh one is in hand, so "Download" and "Open original" work too.
 *
 * Setting `src` on the element directly is deliberate: React leaves an attribute alone until its
 * prop changes, so the fresh link stays put, and a later prop change replaces both.
 */

export const REFRESH_MEDIA_URLS = gql(`
  query RefreshMediaUrls($urls: [String!]!) {
    refreshMediaUrls(urls: $urls)
  }
`);

/** Whether `url` is a signed object-store link served under `/static/`. */
export function isSignedStaticUrl(url: string | null | undefined): url is string {
  return Boolean(url && /\/static\//.test(url) && /[?&]X-Amz-Signature=/.test(url));
}

/** When a signed link stops working, from its `X-Amz-Date` and `X-Amz-Expires`; null if unreadable. */
export function signedUrlExpiresAt(url: string): number | null {
  let params: URLSearchParams;

  try {
    params = new URL(url, 'http://placeholder.invalid').searchParams;
  } catch {
    return null;
  }

  const date = params.get('X-Amz-Date');
  const expires = Number(params.get('X-Amz-Expires'));
  const match = date?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);

  if (!match || !Number.isFinite(expires)) {
    return null;
  }

  const [, y, mo, d, h, mi, s] = match.map(Number);

  return Date.UTC(y, mo - 1, d, h, mi, s) + expires * 1000;
}

/** Margin under which a link counts as expired: long enough for the request to land in time. */
const EXPIRY_MARGIN_MS = 30_000;
/** How long a batch waits for more failures; a screenful of tiles fails within a few ms. */
const BATCH_DELAY_MS = 40;
/** `FileResolver.MAX_REFRESH_LINKS`. */
const MAX_BATCH = 100;

type Resolve = (fresh: string | null) => void;

/** Re-signs links in batches, remembering answers so a re-mounted tile reuses the fresh link. */
export class MediaLinkRefresher {
  private readonly fresh = new Map<string, string>();

  private readonly waiting = new Map<string, Resolve[]>();

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly resign: (urls: string[]) => Promise<(string | null)[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /** A working link for the same file, or null if there is none. */
  refresh(url: string): Promise<string | null> {
    const known = this.fresh.get(url);

    if (known && (signedUrlExpiresAt(known) ?? 0) > this.now() + EXPIRY_MARGIN_MS) {
      return Promise.resolve(known);
    }

    return new Promise((resolve) => {
      const queue = this.waiting.get(url);

      if (queue) {
        queue.push(resolve);

        return;
      }

      this.waiting.set(url, [resolve]);
      this.timer ??= setTimeout(() => void this.flush(), BATCH_DELAY_MS);
    });
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const batch = [...this.waiting.entries()].slice(0, MAX_BATCH);

    for (const [url] of batch) {
      this.waiting.delete(url);
    }

    if (this.waiting.size > 0) {
      this.timer = setTimeout(() => void this.flush(), 0);
    }

    let answers: (string | null)[] = [];

    try {
      answers = await this.resign(batch.map(([url]) => url));
    } catch {
      // Unreachable appliance or a refused request: nothing better to offer than the old link.
    }

    batch.forEach(([url, resolvers], index) => {
      const signed = answers[index];
      const absolute = signed ? (resolveMediaUrl(signed) ?? null) : null;

      if (absolute) {
        this.fresh.set(url, absolute);
      }

      resolvers.forEach((resolve) => resolve(absolute));
    });
  }
}

type MediaElement = HTMLImageElement | HTMLMediaElement | HTMLSourceElement;

/** The link an element tried to load, as the element reports it. */
function failedUrl(element: MediaElement): string | null {
  if (element instanceof HTMLMediaElement) {
    return element.currentSrc || element.src || null;
  }

  return element.src || null;
}

/**
 * Installs the document-wide handlers. Returns the uninstaller. `retried` remembers, per
 * element, the links already retried, so a refreshed link that fails too is left failed.
 */
export function installMediaLinkRefresh(refresher: MediaLinkRefresher, doc: Document = document): () => void {
  const retried = new WeakMap<Element, Set<string>>();

  const onError = (event: Event) => {
    const element = event.target;

    if (!(
      element instanceof HTMLImageElement ||
      element instanceof HTMLMediaElement ||
      element instanceof HTMLSourceElement
    )) {
      return;
    }

    const url = failedUrl(element);

    if (!isSignedStaticUrl(url)) {
      return;
    }

    const seen = retried.get(element) ?? new Set<string>();

    if (seen.has(url)) {
      return;
    }

    seen.add(url);
    retried.set(element, seen);

    void refresher.refresh(url).then((fresh) => {
      if (!fresh || fresh === url) {
        return;
      }

      seen.add(fresh);

      if (element instanceof HTMLSourceElement) {
        element.src = fresh;
        (element.parentElement as HTMLMediaElement | null)?.load?.();

        return;
      }

      if (element instanceof HTMLMediaElement) {
        resumeWith(element, fresh);

        return;
      }

      element.src = fresh;
    });
  };

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }

    const anchor = (event.target as Element | null)?.closest?.('a[href]');

    if (!(anchor instanceof HTMLAnchorElement) || anchor.dataset.mediaLinkFresh === 'true') {
      return;
    }

    const url = anchor.href;

    if (!isSignedStaticUrl(url) || (signedUrlExpiresAt(url) ?? Infinity) > Date.now() + EXPIRY_MARGIN_MS) {
      return;
    }

    event.preventDefault();
    void refresher.refresh(url).then((fresh) => {
      const link = anchor.cloneNode(false) as HTMLAnchorElement;

      link.href = fresh ?? url;
      link.dataset.mediaLinkFresh = 'true';
      link.style.display = 'none';
      doc.body.appendChild(link);
      link.click();
      link.remove();
    });
  };

  doc.addEventListener('error', onError, true);
  doc.addEventListener('click', onClick, true);

  return () => {
    doc.removeEventListener('error', onError, true);
    doc.removeEventListener('click', onClick, true);
  };
}

/** Swap a video's or audio's source without losing the viewer's place. */
function resumeWith(media: HTMLMediaElement, fresh: string): void {
  const position = media.currentTime;
  const playing = !media.paused || media.autoplay;

  media.addEventListener(
    'loadedmetadata',
    () => {
      if (position > 0) {
        media.currentTime = position;
      }

      if (playing) {
        void media.play().catch(() => undefined);
      }
    },
    { once: true },
  );
  media.src = fresh;
  media.load();
}

/** The refresher backed by the app's Apollo client. */
export function apolloMediaLinkRefresher(client: ApolloClient<unknown>): MediaLinkRefresher {
  return new MediaLinkRefresher(async (urls) => {
    const { data } = await client.query({
      query: REFRESH_MEDIA_URLS,
      variables: { urls },
      fetchPolicy: 'no-cache',
    });

    return data?.refreshMediaUrls ?? urls.map(() => null);
  });
}
