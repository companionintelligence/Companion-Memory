import { useState } from 'react';

import { cn } from '@ci/shadcn';
import { Image } from '@ci/shadcn/icons';

interface Props {
  src: string;
  /** Extra classes for the picture itself, once it has decoded. */
  className?: string;
  /** Icon size while the picture is not on screen yet. */
  iconClassName?: string;
  onError?: () => void;
}

/**
 * A picture that stays a plain image icon until `src` has decoded, and stays
 * that icon if the request fails. The browser's own broken-image chrome paints
 * the alt text into the box ("IMG_…"), which is what this avoids. No shimmer.
 */
export function PendingImage({ src, className, iconClassName, onError }: Props) {
  return (
    <PendingImageFrame
      key={src}
      src={src}
      className={className}
      iconClassName={iconClassName}
      onError={onError}
    />
  );
}

function PendingImageFrame({ src, className, iconClassName = 'size-4', onError }: Props) {
  const [phase, setPhase] = useState<'pending' | 'loaded' | 'failed'>('pending');

  return (
    <span className="relative flex h-full w-full items-center justify-center self-stretch overflow-hidden rounded-md bg-muted text-muted-foreground">
      {phase !== 'loaded' && <Image className={iconClassName} strokeWidth={1.5} aria-hidden />}
      {phase !== 'failed' && (
        <img
          src={src}
          alt=""
          className={cn(
            'absolute inset-0 h-full w-full object-cover',
            phase === 'loaded' ? 'opacity-100' : 'opacity-0',
            className,
          )}
          onLoad={() => setPhase('loaded')}
          onError={() => {
            setPhase('failed');
            onError?.();
          }}
        />
      )}
    </span>
  );
}
