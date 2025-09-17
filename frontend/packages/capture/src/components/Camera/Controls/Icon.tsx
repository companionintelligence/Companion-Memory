import { useDeviceLayout } from '@ci/common';
import { Button, Tooltip, cn } from '@ci/shadcn';
import { type LucideIcon } from '@ci/shadcn/icons';

interface Props {
  icon: LucideIcon;
  tooltip?: string;
  className?: string;
  onClick?: () => void;
}

export function Icon({ icon: Icon, tooltip, className, onClick }: Props) {
  const { isMobile } = useDeviceLayout();

  const button = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'p-0 cursor-pointer hover:bg-white/10 active:scale-80 transition-transform transition group',
        isMobile ? 'h-10 w-10' : '',
      )}
      onClick={onClick}
      asChild={isMobile}
    >
      <Icon
        strokeWidth={isMobile ? 0.75 : undefined}
        className={cn(
          'text-white hover:drop-shadow-[0_0_2px_rgba(255,255,255,0.5)] transition-transform',
          className,
        )}
      />
    </Button>
  );

  if (isMobile) {
    return button;
  }

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      {tooltip && <Tooltip.Content side="bottom">{tooltip}</Tooltip.Content>}
    </Tooltip>
  );
}
