type FileChunkLike = {
  sectionTitle?: string | null;
  content?: string;
  chunkContent?: string;
  sourceLocator?: Record<string, unknown> | null;
  file?: {
    filename?: string | null;
  } | null;
};

export function getFileChunkTitle(chunk: FileChunkLike): string {
  return chunk.sectionTitle?.trim() || chunk.file?.filename?.trim() || 'Document excerpt';
}

export function getFileChunkSubtitle(chunk: FileChunkLike): string | null {
  const parts = [
    chunk.file?.filename?.trim() || null,
    formatFileChunkSourceLocator(chunk.sourceLocator),
  ].filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' • ');
}

export function getFileChunkPreview(content: string, maxLength = 220): string {
  const normalized = content.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

export function formatFileChunkSourceLocator(sourceLocator?: Record<string, unknown> | null): string | null {
  if (sourceLocator == null) {
    return null;
  }

  const parts: string[] = [];
  const page = asNumber(sourceLocator.page);
  const pageStart = asNumber(sourceLocator.pageStart);
  const pageEnd = asNumber(sourceLocator.pageEnd);
  const sheet = asString(sourceLocator.sheet);
  const rowStart = asNumber(sourceLocator.rowStart);
  const rowEnd = asNumber(sourceLocator.rowEnd);
  const headingPath = Array.isArray(sourceLocator.headingPath)
    ? sourceLocator.headingPath.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : [];

  if (page != null) {
    parts.push(`Page ${page}`);
  } else if (pageStart != null && pageEnd != null) {
    parts.push(pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`);
  }

  if (sheet) {
    parts.push(`Sheet ${sheet}`);
  }

  if (rowStart != null && rowEnd != null) {
    parts.push(rowStart === rowEnd ? `Row ${rowStart}` : `Rows ${rowStart}-${rowEnd}`);
  } else if (rowStart != null) {
    parts.push(`Row ${rowStart}`);
  }

  if (headingPath.length > 0) {
    parts.push(headingPath.join(' / '));
  }

  if (parts.length > 0) {
    return parts.join(' • ');
  }

  return Object.entries(sourceLocator)
    .slice(0, 3)
    .map(([key, value]) => `${humanizeKey(key)} ${formatValue(value)}`)
    .join(' • ');
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function humanizeKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ');
  }

  if (typeof value === 'object' && value != null) {
    return JSON.stringify(value);
  }

  return String(value);
}
