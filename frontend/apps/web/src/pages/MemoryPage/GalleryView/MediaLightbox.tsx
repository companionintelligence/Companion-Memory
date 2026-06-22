import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@ci/shadcn';
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from '@ci/shadcn/icons';

import { FileIcon } from '@/components/icons';

import type { EntityMedia } from './media';

interface Props {
  entries: EntityMedia[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

// The `download` attribute is silently ignored for cross-origin URLs — the
// browser navigates/opens the file instead of saving it. So we only offer a real
// "Download" for same-origin media (our /static object store) and fall back to an
// "Open original" affordance for external sources.
function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Full-screen quick-look for gallery media. Esc closes, ←/→ step between
 * entries, the backdrop and ✕ close, and the source can be downloaded.
 */
export function MediaLightbox({ entries, index, onClose, onIndexChange }: Props) {
  const count = entries.length;
  const current = entries[index];

  const containerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Keyed by URL so navigating to a new entry clears the broken state without an
  // extra effect: the next render simply compares against a different fullUrl.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  const goPrev = useCallback(() => {
    onIndexChange(Math.max(0, index - 1));
  }, [index, onIndexChange]);

  const goNext = useCallback(() => {
    onIndexChange(Math.min(count - 1, index + 1));
  }, [count, index, onIndexChange]);

  // Modal hygiene for the hand-rolled overlay: move focus in on mount, restore it
  // on unmount, and lock body scroll while open (the shared Radix Dialog gives
  // this for free, but its styled Content fights a full-screen lightbox layout).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();

        return;
      }

      // Trap Tab within the overlay so focus can't escape to the inert page.
      if (e.key === 'Tab') {
        const root = containerRef.current;
        if (!root) {
          return;
        }

        const focusables = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), video, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) {
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (e.shiftKey && (active === first || !root.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !root.contains(active))) {
          e.preventDefault();
          first.focus();
        }

        return;
      }

      // Let a focused video keep its native ←/→ scrubbing; only the buttons step
      // between entries when a video is in focus. Escape stays global (above).
      if (e.target instanceof HTMLElement && e.target.tagName === 'VIDEO') {
        return;
      }

      if (e.key === 'ArrowLeft') {
        goPrev();
      } else if (e.key === 'ArrowRight') {
        goNext();
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, goPrev, goNext]);

  if (!current) {
    return null;
  }

  const hasPrev = index > 0;
  const hasNext = index < count - 1;
  const canDownload = isSameOrigin(current.fullUrl);
  const isBroken = brokenUrl === current.fullUrl;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Media viewer"
      onClick={onClose}
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between gap-2 p-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-sm tabular-nums text-white/70">
          {index + 1} / {count}
        </span>
        <div className="flex items-center gap-1">
          <a
            href={current.fullUrl}
            {...(canDownload ? { download: current.title } : {})}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/15 hover:text-white"
              aria-label={canDownload ? 'Download' : 'Open original'}
              title={canDownload ? 'Download' : 'Open original'}
            >
              {canDownload ? <Download /> : <ExternalLink />}
            </Button>
          </a>
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/15 hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            <X />
          </Button>
        </div>
      </div>

      {/* Stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-2" onClick={onClose}>
        {hasPrev && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous"
            onClick={(e) => {
              e.stopPropagation();
              goPrev();
            }}
            className="absolute left-2 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-black/60 hover:text-white"
          >
            <ChevronLeft className="h-6 w-6" />
          </Button>
        )}

        <div
          className="flex max-h-full max-w-full items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          {isBroken ? (
            // Mirrors MediaTile's broken-thumbnail fallback: when the full media
            // can't load, keep the open-original/download affordance reachable
            // instead of showing a blank stage.
            <div className="flex flex-col items-center gap-3 rounded-lg bg-white/5 px-10 py-12 text-center">
              <FileIcon className="h-12 w-12 text-white/50" />
              <p className="text-sm text-white/80">Couldn&apos;t load this media.</p>
              <a
                href={current.fullUrl}
                {...(canDownload ? { download: current.title } : {})}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-white/20 px-3 py-1.5 text-sm text-white hover:bg-white/10"
              >
                {canDownload ? <Download className="h-4 w-4" /> : <ExternalLink className="h-4 w-4" />}
                {canDownload ? 'Download' : 'Open original'}
              </a>
            </div>
          ) : current.kind === 'video' ? (
            <video
              key={current.fullUrl}
              src={current.fullUrl}
              controls
              onError={() => setBrokenUrl(current.fullUrl)}
              className="max-h-[82vh] max-w-[92vw] rounded-lg"
            />
          ) : (
            <img
              key={current.fullUrl}
              src={current.fullUrl}
              alt={current.title}
              onError={() => setBrokenUrl(current.fullUrl)}
              className="max-h-[82vh] max-w-[92vw] rounded-lg object-contain"
            />
          )}
        </div>

        {hasNext && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next"
            onClick={(e) => {
              e.stopPropagation();
              goNext();
            }}
            className="absolute right-2 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-black/60 hover:text-white"
          >
            <ChevronRight className="h-6 w-6" />
          </Button>
        )}
      </div>

      {/* Caption */}
      <div
        className="truncate px-4 pb-4 text-center text-sm text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        {current.title}
      </div>
    </div>
  );
}
