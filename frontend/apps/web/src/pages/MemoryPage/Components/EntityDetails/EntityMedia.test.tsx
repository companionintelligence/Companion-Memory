import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntityMedia, MediaRefreshProvider } from './EntityDetailScaffold';

/**
 * The detail pane renders the ORIGINAL image, painting the low-res PREVIEW
 * only while the original downloads. jsdom never loads images, so the probe
 * `Image` is stubbed with a controllable fake: the test decides when (and for
 * which src) onload fires.
 */
class FakeImage {
  static instances: FakeImage[] = [];

  onload: (() => void) | null = null;

  src = '';

  constructor() {
    FakeImage.instances.push(this);
  }
}

const ORIGINAL = '/static/companion/original';
const PREVIEW = '/static/companion/preview';

describe('EntityMedia progressive image', () => {
  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal('Image', FakeImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paints the preview first, then swaps to the original when it loads', () => {
    render(<EntityMedia src={ORIGINAL} previewSrc={PREVIEW} contentType="image/jpeg" alt="photo" />);

    // Preview immediately; the original is being probed off-DOM.
    expect(screen.getByAltText('photo')).toHaveAttribute('src', PREVIEW);
    expect(FakeImage.instances).toHaveLength(1);
    expect(FakeImage.instances[0].src).toBe(ORIGINAL);

    act(() => FakeImage.instances[0].onload?.());

    expect(screen.getByAltText('photo')).toHaveAttribute('src', ORIGINAL);
  });

  it('renders the original directly when no preview exists', () => {
    render(<EntityMedia src={ORIGINAL} contentType="image/jpeg" alt="photo" />);

    expect(screen.getByAltText('photo')).toHaveAttribute('src', ORIGINAL);
    expect(FakeImage.instances).toHaveLength(0);
  });

  it('renders the preview when the original url is missing', () => {
    render(<EntityMedia src={null} previewSrc={PREVIEW} contentType="image/jpeg" alt="photo" />);

    expect(screen.getByAltText('photo')).toHaveAttribute('src', PREVIEW);
  });

  it('does not swap the new preview for a STALE original after the entity changes', () => {
    const { rerender } = render(
      <EntityMedia src={ORIGINAL} previewSrc={PREVIEW} contentType="image/jpeg" alt="photo" />,
    );

    rerender(
      <EntityMedia
        src="/static/companion/other"
        previewSrc="/static/companion/other-preview"
        contentType="image/jpeg"
        alt="photo"
      />,
    );

    // The first probe finishing late must not flip the src: its onload was
    // detached on cleanup, and the shown src tracks the CURRENT original only.
    act(() => FakeImage.instances[0].onload?.());
    expect(screen.getByAltText('photo')).toHaveAttribute('src', '/static/companion/other-preview');

    act(() => FakeImage.instances[1].onload?.());
    expect(screen.getByAltText('photo')).toHaveAttribute('src', '/static/companion/other');
  });
});

describe('EntityMedia load failure', () => {
  /**
   * Regression: a content row whose `url` is a provider web page
   * (photos.google.com/photo/…) was rendered as an <img>; the browser blocks
   * the non-image response (ERR_BLOCKED_BY_ORB) and left a broken glyph.
   */
  it('swaps to an unavailable notice with a link to the original when the image fails', () => {
    render(
      <EntityMedia
        src="https://photos.google.com/photo/abc"
        contentType="image/jpeg"
        alt="photo"
        fallbackHref="https://photos.google.com/photo/abc"
      />,
    );

    fireEvent.error(screen.getByRole('img', { name: 'photo' }));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent("Media couldn't be loaded");
    const link = screen.getByRole('link', { name: /open original/i });
    expect(link).toHaveAttribute('href', 'https://photos.google.com/photo/abc');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('retries when the source changes to a new entity', () => {
    const { rerender } = render(<EntityMedia src="/static/a" contentType="image/png" alt="a" />);

    fireEvent.error(screen.getByRole('img', { name: 'a' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    rerender(<EntityMedia src="/static/b" contentType="image/png" alt="b" />);
    expect(screen.getByRole('img', { name: 'b' })).toBeInTheDocument();
  });
});

describe('EntityMedia video with a playback rendition', () => {
  // The drawer hands the element the server's H.264 rendition as `src` and the
  // original as `fallbackHref`, so what plays is the rendition and what the
  // user opens or saves is still the original bytes.
  it('plays the rendition and, should it still fail, offers the original', () => {
    const { container } = render(
      <EntityMedia
        src="/static/companion/clip-h264.mp4"
        previewSrc="/static/companion/poster.jpg"
        contentType="video/mp4"
        alt="clip"
        fallbackHref="/static/companion/clip.mov"
      />,
    );

    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', '/static/companion/clip-h264.mp4');

    fireEvent.error(video!);

    expect(screen.getByRole('link', { name: /open or save the original/i })).toHaveAttribute(
      'href',
      '/static/companion/clip.mov',
    );
  });
});

describe('EntityMedia video the browser cannot decode', () => {
  // Phone recordings since ~2023 are HEVC, which Chrome on Linux does not
  // decode; the element fires `error` although the bytes served fine. The
  // block must say so, keep the poster up, and hand over the original.
  it('keeps the poster, says the format is the problem, and offers the original', () => {
    const { container } = render(
      <EntityMedia
        src="/static/companion/clip.mp4"
        previewSrc="/static/companion/poster.jpg"
        contentType="video/mp4"
        alt="clip"
      />,
    );

    const video = container.querySelector('video');
    expect(video).toHaveAttribute('poster', '/static/companion/poster.jpg');

    fireEvent.error(video!);

    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent("can't play this video");
    expect(screen.getByRole('status')).not.toHaveTextContent("Media couldn't be loaded");
    expect(screen.getByRole('img', { name: 'clip' })).toHaveAttribute('src', '/static/companion/poster.jpg');
    expect(screen.getByRole('link', { name: /open or save the original/i })).toHaveAttribute(
      'href',
      '/static/companion/clip.mp4',
    );
  });

  it('still offers the original without a poster', () => {
    const { container } = render(
      <EntityMedia src="/static/companion/clip.mp4" contentType="video/mp4" alt="clip" />,
    );

    fireEvent.error(container.querySelector('video')!);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open or save the original/i })).toHaveAttribute(
      'href',
      '/static/companion/clip.mp4',
    );
  });
});

/** jsdom never sets `MediaError`; stamp one on the element before firing `error`. */
function failWith(el: HTMLMediaElement, code: number) {
  if (typeof (globalThis as { MediaError?: unknown }).MediaError === 'undefined') {
    Object.assign(globalThis, {
      MediaError: {
        MEDIA_ERR_ABORTED: 1,
        MEDIA_ERR_NETWORK: 2,
        MEDIA_ERR_DECODE: 3,
        MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
      },
    });
  }

  Object.defineProperty(el, 'error', { configurable: true, value: { code, message: `code ${code}` } });
  fireEvent.error(el);
}

describe('EntityMedia decode failure', () => {
  // The 4K HEVC clips on this box die in Chrome's decoder: MediaError 3,
  // PIPELINE_ERROR_DECODE. A fresh link cannot cure that, so no refetch — the
  // earlier refresh-on-any-error produced a GetDrawerNode per play click.
  it('does not refetch on a decode error; it says the browser cannot decode the video', async () => {
    const refresh = vi.fn(async () => true);
    const { container } = render(
      <MediaRefreshProvider refresh={refresh}>
        <EntityMedia
          src="/static/companion/clip.mp4"
          previewSrc="/static/companion/poster.jpg"
          contentType="video/mp4"
          alt="clip"
        />
      </MediaRefreshProvider>,
    );

    failWith(container.querySelector('video')!, 3);
    await act(async () => {});

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent("can't play this video");
    expect(screen.getByRole('img', { name: 'clip' })).toHaveAttribute('src', '/static/companion/poster.jpg');
  });
});

describe('EntityMedia expired signed link', () => {
  // Signed media links expire an hour after the query that carried them; a
  // video is only fetched when its drawer opens, so the object store answers
  // 403 and the element errors. One refresh of the node brings a fresh link.
  it('refreshes the node once and retries when the new link differs', async () => {
    const refresh = vi.fn(async () => true);
    const { container, rerender } = render(
      <MediaRefreshProvider refresh={refresh}>
        <EntityMedia
          src="/static/companion/clip.mp4?X-Amz-Signature=old"
          contentType="video/mp4"
          alt="clip"
        />
      </MediaRefreshProvider>,
    );

    failWith(container.querySelector('video')!, 2);

    expect(refresh).toHaveBeenCalledTimes(1);
    // The details re-render with the re-minted link; the element is back, no notice.
    rerender(
      <MediaRefreshProvider refresh={refresh}>
        <EntityMedia
          src="/static/companion/clip.mp4?X-Amz-Signature=new"
          contentType="video/mp4"
          alt="clip"
        />
      </MediaRefreshProvider>,
    );
    await act(async () => {});

    expect(container.querySelector('video')).toHaveAttribute(
      'src',
      '/static/companion/clip.mp4?X-Amz-Signature=new',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('retries once after a refresh even when the link reads the same, then gives up on a second failure', async () => {
    // Two mints in the same second are byte-identical, so the retry must not
    // hinge on the text changing; but a second error on the same link is final.
    const refresh = vi.fn(async () => true);
    const { container } = render(
      <MediaRefreshProvider refresh={refresh}>
        <EntityMedia src="/static/companion/clip.mp4" contentType="video/mp4" alt="clip" />
      </MediaRefreshProvider>,
    );

    failWith(container.querySelector('video')!, 4);
    await act(async () => {});

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(container.querySelector('video')).not.toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    failWith(container.querySelector('video')!, 4);
    await act(async () => {});

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent("can't play this video");
  });

  it('shows the unavailable state at once when nothing can be refreshed', async () => {
    const refresh = vi.fn(async () => false);
    render(
      <MediaRefreshProvider refresh={refresh}>
        <EntityMedia src="/static/a.png" contentType="image/png" alt="a" />
      </MediaRefreshProvider>,
    );

    fireEvent.error(screen.getByRole('img', { name: 'a' }));
    await act(async () => {});

    expect(screen.getByRole('status')).toHaveTextContent("Media couldn't be loaded");
  });
});
