import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Turn a backend enum into something a person can read: `WORKS_WITH` -> `Works With`.
 *
 * The graph's relationship filter chips used to print the enum verbatim, so the
 * memory graph showed a row reading `CHILD_OF DISLIKES FRIENDS_WITH PARENT_OF
 * PREFERS SIBLING_OF SPOUSE WORKS_WITH`. Title Case (not sentence case) is
 * deliberate: it is what `EntityRelationshipCards` has always rendered, and this
 * function exists so the two agree rather than drifting a fourth time.
 */
export function formatEnumLabel(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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
