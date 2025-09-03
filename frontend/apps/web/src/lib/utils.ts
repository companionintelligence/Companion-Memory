import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Utility function to get media type from mimetype
export function getMediaType(mimetype: string | undefined | null): 'video' | 'image' | 'audio' | null {
  if (!mimetype) {
    return null;
  }

  if (mimetype.startsWith('image/')) {
    return 'image';
  }

  if (mimetype.startsWith('video/')) {
    return 'video';
  }

  if (mimetype.startsWith('audio/')) {
    return 'audio';
  }

  return null;
}
