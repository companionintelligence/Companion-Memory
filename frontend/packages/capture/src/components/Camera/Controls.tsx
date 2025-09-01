import { Button, Tooltip, cn } from '@ci/shadcn';
import { type LucideIcon } from '@ci/shadcn/icons';
import { type ReactNode } from 'react';

interface ControlsProps {
  children: ReactNode;
}

function Controls({ children }: ControlsProps) {
  return (
    <Tooltip.Provider>
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex p-2 gap-3 rounded-full bg-black/80 backdrop-blur-md shadow-lg animate-in slide-in-from-bottom-4 duration-300 ease-out">
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
          className="h-12 w-12 p-0 cursor-pointer rounded-full bg-white/20 hover:bg-white/30 active:scale-90 transition-all duration-200 ease-out border border-white/30 backdrop-blur-sm"
          onClick={onClick}
        >
          <Icon
            className={cn(
              'h-6 w-6 text-white drop-shadow-sm transition-all duration-200 ease-out',
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
  return <div className="w-px self-stretch bg-white/40 mx-2 opacity-80" />;
}

type ControlsComponent = typeof Controls & {
  Icon: typeof ControlsIcon;
  Divider: typeof ControlsDivider;
};

const AugmentedControls = Controls as ControlsComponent;

AugmentedControls.Icon = ControlsIcon;
AugmentedControls.Divider = ControlsDivider;

export { AugmentedControls as Controls };
