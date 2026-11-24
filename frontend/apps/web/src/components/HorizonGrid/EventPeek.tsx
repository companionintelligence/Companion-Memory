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
  actions,
  children,
}: {
  label: string;
  side?: TooltipSide;
  content: ReactNode;
  /**
   * Controls shown under the body, dialog only — a tooltip is not a surface a
   * finger or a keyboard can reach into. Passing them is what makes a click
   * open the dialog on every pointer; see `clickOpensDialog` below.
   */
  actions?: (close: () => void) => ReactNode;
  children: ReactElement<{ onClick?: (event: MouseEvent<HTMLElement>) => void }>;
}) {
  const tapOpensDialog = useTapOpensDialog();
  const [open, setOpen] = useState(false);
  /**
   * A media query may decide whether hover can show a tooltip. It must NOT
   * decide whether the actions are reachable at all: `(hover: none), (pointer:
   * coarse)` answers false on a touchscreen laptop, which then got neither the
   * dialog nor a drag that a finger can start. Anywhere there is something to
   * do, a click opens the dialog — a mouse user simply has both routes.
   */
  const clickOpensDialog = tapOpensDialog || Boolean(actions);

  if (!clickOpensDialog) {
    return (
      <Tooltip>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Content side={side}>{content}</Tooltip.Content>
      </Tooltip>
    );
  }

  const trigger = cloneElement(children, {
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
  });

  return (
    <>
      {tapOpensDialog ? (
        trigger
      ) : (
        <Tooltip>
          <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
          <Tooltip.Content side={side}>{content}</Tooltip.Content>
        </Tooltip>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <Dialog.Content
          className="max-w-sm gap-3 p-4"
          aria-label={label}
          // Radix would focus the first tabbable thing here, which is the Move
          // form's date input — and focusing a date input is what raises iOS's
          // native picker, over the whole screen before anyone has touched
          // anything. Land on the dialog itself instead; the fields are one tap
          // (or one Tab) away, and a screen reader still announces the dialog.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
          }}
        >
          <Dialog.Header>
            <Dialog.Title className="sr-only">{label}</Dialog.Title>
            <Dialog.Description className="sr-only">Event details</Dialog.Description>
          </Dialog.Header>
          {content}
          {actions?.(() => setOpen(false))}
        </Dialog.Content>
      </Dialog>
    </>
  );
}
