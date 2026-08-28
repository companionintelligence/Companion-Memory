import type { ComponentProps } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Dialog, Sheet, cn } from '@ci/shadcn';

/**
 * Dialog on desktop, bottom sheet that slides up on a phone.
 *
 * Same compound API as `Dialog` so existing create/edit chrome can swap the
 * import without rewriting headers and footers.
 */
function ResponsiveDialog(props: ComponentProps<typeof Dialog>) {
  const { isMobile } = useDeviceLayout();
  const Overlay = isMobile ? Sheet : Dialog;

  return <Overlay {...props} />;
}

type ContentProps = ComponentProps<typeof Dialog.Content> & {
  overlayClassName?: string;
};

function ResponsiveDialogContent({
  className,
  showCloseButton,
  overlayClassName,
  children,
  ...props
}: ContentProps) {
  const { isMobile } = useDeviceLayout();

  if (isMobile) {
    return (
      <Sheet.Content
        side="bottom"
        showCloseButton={showCloseButton}
        overlayClassName={overlayClassName}
        className={cn(
          'bottom-0 max-h-[min(90dvh,var(--vv-height,100dvh))] gap-4 overflow-y-auto rounded-t-2xl rounded-b-none px-6 pt-3 pb-[max(1.5rem,var(--safe-area-bottom),var(--keyboard-inset,0px))]',
          className,
        )}
        {...props}
      >
        <div className="mx-auto h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />
        {children}
      </Sheet.Content>
    );
  }

  return (
    <Dialog.Content className={className} showCloseButton={showCloseButton} {...props}>
      {children}
    </Dialog.Content>
  );
}

const ResponsiveDialogComponent = ResponsiveDialog as typeof ResponsiveDialog & {
  Close: typeof Dialog.Close;
  Content: typeof ResponsiveDialogContent;
  Description: typeof Dialog.Description;
  Footer: typeof Dialog.Footer;
  Header: typeof Dialog.Header;
  Title: typeof Dialog.Title;
};

ResponsiveDialogComponent.Close = Dialog.Close;
ResponsiveDialogComponent.Content = ResponsiveDialogContent;
ResponsiveDialogComponent.Description = Dialog.Description;
ResponsiveDialogComponent.Footer = Dialog.Footer;
ResponsiveDialogComponent.Header = Dialog.Header;
ResponsiveDialogComponent.Title = Dialog.Title;

export { ResponsiveDialogComponent as ResponsiveDialog };
