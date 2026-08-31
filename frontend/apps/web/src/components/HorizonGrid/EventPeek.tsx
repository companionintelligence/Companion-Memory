import { cloneElement, useEffect, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';

import { Dialog, Tooltip } from '@ci/shadcn';

type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * Hover/focus shows a tooltip. On a coarse pointer (a phone), that never
 * fires, so the same body opens in a dialog on tap instead.
 *
 * Links inside the chip keep their own job: tapping a URL must not also
 * open the dialog.
 */
function useTapOpensDialog(): boolean {
  const [tapOpens, setTapOpens] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(hover: none), (pointer: coarse)');
    const sync = () => setTapOpens(query.matches);
    sync();
    query.addEventListener('change', sync);

    return () => query.removeEventListener('change', sync);
  }, []);

  return tapOpens;
}

export function EventPeek({
  label,
  side = 'top',
  content,
  children,
}: {
  label: string;
  side?: TooltipSide;
  content: ReactNode;
  children: ReactElement<{ onClick?: (event: MouseEvent<HTMLElement>) => void }>;
}) {
  const tapOpensDialog = useTapOpensDialog();
  const [open, setOpen] = useState(false);

  if (tapOpensDialog) {
    return (
      <>
        {cloneElement(children, {
          onClick: (event) => {
            children.props.onClick?.(event);
            if (event.defaultPrevented) {
              return;
            }

            if ((event.target as HTMLElement | null)?.closest?.('a')) {
              return;
            }

            setOpen(true);
          },
        })}
        <Dialog open={open} onOpenChange={setOpen}>
          <Dialog.Content className="max-w-sm gap-3 p-4" aria-label={label}>
            <Dialog.Header>
              <Dialog.Title className="sr-only">{label}</Dialog.Title>
              <Dialog.Description className="sr-only">Event details</Dialog.Description>
            </Dialog.Header>
            {content}
          </Dialog.Content>
        </Dialog>
      </>
    );
  }

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Content side={side}>{content}</Tooltip.Content>
    </Tooltip>
  );
}
