import { useCallback, useEffect } from 'react';

import { Button } from '@ci/shadcn';
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from '@ci/shadcn/icons';

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

  const goPrev = useCallback(() => {
    onIndexChange(Math.max(0, index - 1));
  }, [index, onIndexChange]);

  const goNext = useCallback(() => {
    onIndexChange(Math.min(count - 1, index + 1));
  }, [count, index, onIndexChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft') {
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

  return (
    <div
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
            {...(canDownload ? { download: true } : {})}
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
          {current.kind === 'video' ? (
            <video
              key={current.fullUrl}
              src={current.fullUrl}
              controls
              className="max-h-[82vh] max-w-[92vw] rounded-lg"
            />
          ) : (
            <img
              key={current.fullUrl}
              src={current.fullUrl}
              alt={current.title}
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
