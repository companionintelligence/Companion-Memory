import { useCallback, useState } from 'react';

import { cn } from '@ci/shadcn';

import { PathHeader } from '@/pages/SourcesPage/PathHeader';

import { HistoryTab } from './HistoryTab';
import { InboxPanel } from './InboxPanel';
import { ImportWizard } from './wizard/ImportWizard';
import { WizardSteps } from './wizard/WizardSteps';

export type ImportStage = 'pick' | 'export' | 'sync';

export interface ImportSurfaceProps {
  /**
   * Where the surface is hosted. `page` is the import half of /sources;
   * `onboarding` renders it inside a dialog on the connect step, because the
   * onboarding gate bounces every main-app route back to /onboarding — the
   * surface comes to the user instead of navigating them somewhere they will
   * be bounced from. Same machinery either way; only the host differs.
   */
  variant?: 'page' | 'onboarding';
  /** Told the wizard's current phase, so an onboarding host can narrate it. */
  onStageChange?: (stage: ImportStage) => void;
}

/**
 * The import machinery, embeddable wherever there is a bounded-height flex
 * column to live in — the import half of /sources, and an onboarding dialog.
 *
 * The wizard is the default surface: pick your services, export each one with
 * the instructions on the card, sync everything staged in one go. Its three
 * steps double as the navigation row, so it needs no tab of its own. Inbox is
 * the batch alternative — a mounted folder to move archives into, imported all
 * at once and consumed as they go. History is every run the appliance has done,
 * with the live pipeline for whatever is still going. Those two are tabs rather
 * than more of the page because the wizard is a flow someone walks once per
 * archive-gathering session, while Inbox and History are what they come back
 * to.
 *
 * The host must bound this component's height (PageContent does on the page;
 * a fixed-height Dialog.Content does in onboarding): the navigation row is
 * pinned and only what sits below it scrolls, which needs a real ceiling to
 * scroll against.
 */
/** The three things the import surface can be showing. */
type Surface = 'import' | 'inbox' | 'history';

export function ImportSurface({ variant = 'page', onStageChange }: ImportSurfaceProps) {
  const [surface, setSurface] = useState<Surface>('import');
  const [stage, setStage] = useState<ImportStage>('pick');
  const [canExport, setCanExport] = useState(false);

  const handleStage = useCallback(
    (next: ImportStage) => {
      setStage(next);
      onStageChange?.(next);
    },
    [onStageChange],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Inbox and History ride the path's own heading, level with the name of
          the thing they belong to. They spent one revision at the end of the
          step row, which read as a fourth and fifth step of a sequence they are
          not steps of.

          What is left below is the step row alone. The steps ARE the import
          surface — clicking one comes back here from Inbox or History — which
          is why there is no "Import" button among them.

          Onboarding shows none of it. History is meaningless on a first run —
          there are no runs to revisit — and the Inbox is the batch path for
          someone who already knows the appliance owns a folder. Offering three
          destinations before the user has imported anything is a choice asked
          too early; /sources/import carries all of it the moment setup is
          done. What is left is a single linear flow. */}
      {variant === 'page' ? (
        <>
          <PathHeader
            path="import"
            actions={
              <div
                role="group"
                aria-label="Other import views"
                className="flex shrink-0 gap-1 rounded-md bg-muted p-1 text-sm"
              >
                <SurfaceToggle
                  active={surface === 'inbox'}
                  onClick={() => setSurface((current) => (current === 'inbox' ? 'import' : 'inbox'))}
                >
                  Inbox
                </SurfaceToggle>
                <SurfaceToggle
                  active={surface === 'history'}
                  onClick={() => setSurface((current) => (current === 'history' ? 'import' : 'history'))}
                >
                  History
                </SurfaceToggle>
              </div>
            }
          />

          <WizardSteps
            step={surface === 'import' ? stage : null}
            canExport={canExport}
            onStep={(next) => {
              handleStage(next);
              setSurface('import');
            }}
            className="shrink-0"
          />
        </>
      ) : null}

      {/* The wizard stays MOUNTED and is hidden, never unmounted.

          Everything it holds — the services you picked, which export card you
          are on, and which runs each card has already started — lives in its
          own state. Unmounting it threw all of that away, so glancing at
          History and clicking back to Export returned you to an Export step
          with nothing in it: silent loss of work that the persistent step row
          actively invites you to risk. `hidden` costs a hidden subtree and
          keeps the work.

          overflow-hidden, not auto: the wizard scrolls itself below the row. */}
      <div className={cn('min-h-0 flex-1 overflow-hidden', surface !== 'import' && 'hidden')}>
        <ImportWizard
          step={variant === 'page' ? stage : undefined}
          onStepChange={handleStage}
          onCanExportChange={setCanExport}
        />
      </div>

      {/* Inbox and History hold nothing you can lose — both re-read the server
          on mount — so they are mounted only while shown. */}
      {variant === 'page' && surface === 'inbox' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <InboxPanel />
        </div>
      ) : null}

      {variant === 'page' && surface === 'history' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <HistoryTab />
        </div>
      ) : null}
    </div>
  );
}

function SurfaceToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      // A real toggle: pressing the one you are on returns you to the wizard,
      // which is what makes `aria-pressed` the honest state for it.
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-sm px-3 py-1.5 font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
