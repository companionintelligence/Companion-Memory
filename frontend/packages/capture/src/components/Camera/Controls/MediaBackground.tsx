import { cn } from '@ci/shadcn';
import { useState, useEffect } from 'react';

interface Props {
  file: File;
  className?: string;
}

export function MediaBackground({ file, className }: Props) {
  const [backgroundUrl, setBackgroundUrl] = useState('');

  useEffect(() => {
    if (!file) {
      setBackgroundUrl('');

      return;
    }

    let objectUrl: string;

    if (file.type.startsWith('image/')) {
      objectUrl = URL.createObjectURL(file);

      setBackgroundUrl(objectUrl);
    } else if (file.type.startsWith('video/')) {
      const video = document.createElement('video');

      objectUrl = URL.createObjectURL(file);

      video.src = objectUrl;
      video.muted = true;
      video.playsInline = true;

      video.addEventListener('loadeddata', () => {
        setTimeout(() => {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;

          const ctx = canvas.getContext('2d');
          ctx!.drawImage(video, 0, 0, canvas.width, canvas.height);

          setBackgroundUrl(canvas.toDataURL());

          URL.revokeObjectURL(objectUrl);
        }, 100);
      });

      video.play().catch((err) => {
        console.error('Video playback failed:', err);
      });
    }

    return () => {
      if (objectUrl && file.type.startsWith('image/')) {
        // We can't revoke the URL immediately after setBackgroundUrl for images because the
        // browser's rendering engine still needs that active URL to actually fetch and display
        // the image.
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [file]);

  const style = backgroundUrl ? { backgroundImage: `url(${backgroundUrl})` } : {};

  return <div className={cn('w-full h-full bg-cover bg-center bg-no-repeat', className)} style={style} />;
}
