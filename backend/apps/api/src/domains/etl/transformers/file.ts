/**
 * File-specific transformer functions
 */

/**
 * Extract file metadata from provider response
 */
export function extractFileMetadata(input: unknown): Record<string, unknown> {
  const file = input as {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string | number;
    createdTime?: string;
    modifiedTime?: string;
    owners?: Array<{ displayName?: string; emailAddress?: string }>;
  };

  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: typeof file.size === 'string' ? parseInt(file.size, 10) : file.size,
    createdAt: file.createdTime ? new Date(file.createdTime) : undefined,
    modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
    owner: file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress,
  };
}

/**
 * Generate thumbnail URL for file
 */
export function generateThumbnailUrl(input: unknown, params?: Record<string, unknown>): string | null {
  const file = input as {
    thumbnailLink?: string;
    webContentLink?: string;
    id?: string;
  };

  const size = (params?.size as number) || 200;

  // Use existing thumbnail if available
  if (file.thumbnailLink) {
    return file.thumbnailLink;
  }

  // Generate thumbnail URL for Google Drive
  if (file.id && params?.provider === 'google') {
    return `https://drive.google.com/thumbnail?id=${file.id}&sz=w${size}`;
  }

  return null;
}

/**
 * Format file size to human-readable string
 */
export function formatFileSize(input: unknown): string {
  const bytes = typeof input === 'string' ? parseInt(input, 10) : (input as number);

  if (!bytes || isNaN(bytes)) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Determine file category from MIME type
 */
export function categorizeFile(input: unknown): string {
  const mimeType = (input as string) || '';

  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType.includes('pdf')) {
    return 'pdf';
  }
  if (mimeType.includes('document') || mimeType.includes('word')) {
    return 'document';
  }
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
    return 'spreadsheet';
  }
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) {
    return 'presentation';
  }
  if (mimeType.startsWith('text/')) {
    return 'text';
  }

  return 'other';
}

/**
 * Extract file extension from name
 */
export function extractFileExtension(input: unknown): string {
  const name = (input as string) || '';
  const match = name.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}
