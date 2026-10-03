import { type SyntheticEvent } from 'react';

import { Button, IconButton } from '@ci/shadcn';
import { X } from '@ci/shadcn/icons';

import { useUnsyncedImportsNotice } from './useUnsyncedImportsNotice';

/** A click on the strip is the strip's own: it never reaches a handler further up the tree. */
function keep(event: SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * One row, in the layout flow, when imports finished parsing but were never
 * pushed into memory (see {@link useUnsyncedImportsNotice}).
 *
 * In the flow, not over it, and that is the whole design. It stays up for as
 * long as there is an unsynced import, so it has to coexist with everything:
 *
 * - It takes its own height, so the page starts below it. A floating notice
 *   covered the Sources switch and the Plan Add field after every launch.
 * - It has no z-index and no `position`, so every dialog, sheet and drawer —
 *   all `fixed`, `z-50` or the drawer's `z-40` — paints over it. A toast sat at
 *   z-index 999999999, above an open dialog's title and close button.
 * - It is page content, so when the phone drawer opens and `MobileNavigation`
 *   makes the page `inert` it is covered and inert together. A toast was inert
 *   and still on top, which let a tap on it fall through to the drawer's Capture
 *   row.
 *
 * Nothing is under it to fall through to, and its own clicks are kept to
 * itself regardless: a dismiss dismisses, and does nothing else.
 */
export function UnsyncedImportsBanner({ suppressed = false }: { suppressed?: boolean }) {
  const { visible, syncNow, dismiss } = useUnsyncedImportsNotice({ suppressed });

  // Held back while the getting-started banner is up: it already says "read but
  // not saved yet" with its own Save button, and two prompts for one fact is
  // nagging.
  if (!visible || suppressed) {
    return null;
  }

  return (
    <div
      data-testid="unsynced-imports-notice"
      className="flex shrink-0 touch-manipulation items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-sm text-foreground"
      onClick={keep}
    >
      <p role="status" className="min-w-0 flex-1">
        You have unsynced imports.
      </p>
      <Button type="button" size="sm" onClick={() => syncNow()}>
        Sync now
      </Button>
      <IconButton
        type="button"
        label="Dismiss"
        variant="ghost"
        onClick={(event) => {
          // Explicit here as well as on the strip: a dismiss only dismisses.
          keep(event);
          dismiss();
        }}
      >
        <X />
      </IconButton>
    </div>
  );
}
