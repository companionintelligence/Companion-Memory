import { Badge } from '@ci/shadcn';

import { labelForSource } from '@/lib/sourceNames';

interface Props {
  source?: string | null;
  /** Shown when no source_system is present (e.g. a generic type label). */
  fallback?: string;
}

/**
 * Compact connector badge for gallery/list cards — turns a raw `source_system`
 * (`google_voice`, `imessage`, …) into a friendly label so users can tell at a
 * glance where a memory came from.
 */
export function SourceBadge({ source, fallback }: Props) {
  const text = source ? labelForSource(source) : fallback;

  if (!text) {
    return null;
  }

  return (
    <Badge variant="secondary" className="shrink-0 text-xs font-normal">
      {text}
    </Badge>
  );
}
