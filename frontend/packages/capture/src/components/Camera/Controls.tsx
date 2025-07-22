import { Button, Tooltip, cn } from '@ci/shadcn';
import { type LucideIcon } from '@ci/shadcn/icons';
import { type ReactNode } from 'react';

interface ControlsProps {
  children: ReactNode;
}

function Controls({ children }: ControlsProps) {
  return (
    <Tooltip.Provider>
      <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex p-1 gap-1 rounded-lg bg-black/60 backdrop-blur-sm">
        {children}
      </div>
    </Tooltip.Provider>
  );
}

interface ControlsIconProps {
  icon: LucideIcon;
  tooltip?: string;
  className?: string;
  onClick?: () => void;
}

function ControlsIcon({ icon, tooltip, className, onClick }: ControlsIconProps) {
  const Icon = icon;

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 p-0 cursor-pointer hover:bg-white/10 active:scale-80 transition-transform transition group"
          onClick={onClick}
        >
          <Icon
            className={cn(
              'h-1 w-1 text-white hover:drop-shadow-[0_0_2px_rgba(255,255,255,0.5)] transition-transform',
              className,
            )}
          />
        </Button>
      </Tooltip.Trigger>
      {tooltip && <Tooltip.Content side="bottom">{tooltip}</Tooltip.Content>}
    </Tooltip>
  );
}

function ControlsDivider() {
  return <div className="w-px self-stretch bg-white/20 mx-1" />;
}

type ControlsComponent = typeof Controls & {
  Icon: typeof ControlsIcon;
  Divider: typeof ControlsDivider;
};

const AugmentedControls = Controls as ControlsComponent;

AugmentedControls.Icon = ControlsIcon;
AugmentedControls.Divider = ControlsDivider;

export { AugmentedControls as Controls };
