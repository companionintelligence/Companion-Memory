import { ButtonGroup, IconButton, cn } from '@ci/shadcn';
import { Crosshair, Minus, Plus } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

/**
 * Dressed like the memory map's zoom controls (components/Map/Controls.tsx), and with its crosshair
 * for "frame everything", so the app's two zoomable canvases offer the same buttons in the same
 * place in the hand.
 */
const CONTROL_BUTTON_CLASS =
  'border-border bg-card text-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:text-accent-foreground dark:border-border dark:bg-card dark:hover:bg-accent';

interface Props {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** Placement overrides; the cluster sits in the canvas's bottom-right corner by default. */
  className?: string;
}

/**
 * Zoom in, zoom out and show-the-whole-graph for the force graph, for anyone without a wheel or a
 * second finger free: one-handed on a phone, or on a keyboard.
 *
 * A compact column in a corner, where a fitted graph leaves the canvas emptiest, and small enough to
 * leave the picture alone. Real buttons, so Tab reaches them and Enter or Space presses them.
 */
export function ZoomControls({ onZoomIn, onZoomOut, onFit, className }: Props) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="force-graph-zoom-controls"
      className={cn('absolute bottom-3 right-3 z-10 flex flex-col gap-2', className)}
    >
      <ButtonGroup orientation="vertical">
        <IconButton
          type="button"
          variant="outline"
          size="icon-sm"
          side="left"
          className={CONTROL_BUTTON_CLASS}
          label={t('GRAPH_ZOOM_IN')}
          onClick={onZoomIn}
        >
          <Plus />
        </IconButton>
        <IconButton
          type="button"
          variant="outline"
          size="icon-sm"
          side="left"
          className={CONTROL_BUTTON_CLASS}
          label={t('GRAPH_ZOOM_OUT')}
          onClick={onZoomOut}
        >
          <Minus />
        </IconButton>
      </ButtonGroup>
      <IconButton
        type="button"
        variant="outline"
        size="icon-sm"
        side="left"
        className={CONTROL_BUTTON_CLASS}
        label={t('GRAPH_FIT')}
        onClick={onFit}
      >
        <Crosshair />
      </IconButton>
    </div>
  );
}
