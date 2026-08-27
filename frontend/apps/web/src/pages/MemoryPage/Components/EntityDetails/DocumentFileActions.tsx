import { Download, ExternalLink } from '@ci/shadcn/icons';

const LINK_CLASS =
  'inline-flex w-fit items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent';

export function isHttpUrl(value?: string | null): boolean {
  return /^https?:\/\//.test(value ?? '');
}

export function formatBytes(bytes?: number | null): string | null {
  if (bytes == null) {
    return null;
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Open a stored file (or an http origin) in a new tab. Download is optional —
 * FileDetails keeps it; Content just needs to view the bytes.
 */
export function DocumentFileActions({
  href,
  filename,
  download = false,
  label = 'Open',
}: {
  href: string;
  filename?: string | null;
  download?: boolean;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
        <ExternalLink className="size-4" aria-hidden />
        {label}
      </a>
      {download && (
        <a
          href={href}
          download={filename ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK_CLASS}
        >
          <Download className="size-4" aria-hidden />
          Download
        </a>
      )}
    </div>
  );
}
