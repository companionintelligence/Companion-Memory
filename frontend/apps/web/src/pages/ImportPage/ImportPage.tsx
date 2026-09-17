import { useCallback, useState } from 'react';

import { cn } from '@ci/shadcn';

import { ImportActivity } from '@/components/ImportActivity';
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
  /**
   * `host` hands the wizard's forward/back controls to the surrounding
   * wizard's footer (onboarding) instead of drawing them per phase.
   */
  nav?: 'inline' | 'host';
}

/**
 * The import machinery, embeddable in the import half of /sources and in an
 * onboarding dialog.
 *
 * The wizard is the default surface: pick your services, export each one with
 * the instructions on the card, sync everything staged in one go. Inbox is
 * the batch alternative — a mounted folder to move archives into, imported all
 * at once and consumed as they go. History is every run the appliance has done,
 * with the live pipeline for whatever is still going. Those two are tabs rather
 * than more of the page because the wizard is a flow someone walks once per
 * archive-gathering session, while Inbox and History are what they come back
 * to. The wizard has a tab of its own alongside them; its step row belongs to
 * the wizard and shows only with it.
 *
 * On /sources/import the tiles stay put and this whole surface scrolls under
 * them — path header, steps, search, catalog — same as Connect and Devices.
 * Onboarding's dialog is the scroller, so the surface just grows.
 */
/** The three things the import surface can be showing. */
type Surface = 'import' | 'inbox' | 'history';

export function ImportSurface({ variant = 'page', onStageChange, nav = 'inline' }: ImportSurfaceProps) {
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
    <div className="flex flex-col gap-4">
      {/* Wizard, Inbox and History ride the path's own heading, level with the
          name of the thing they belong to. Inbox and History spent one revision
          at the end of the step row, which read as a fourth and fifth step of a
          sequence they are not steps of.

          Below is the wizard's step row, and only while the wizard is showing.
          For a while it stayed up on Inbox and History as the way back — every
          step a return button, none marked current — but nobody read a step as
          a way out of the folder view, and three greyed steps over a run list
          were chrome for a flow you had left. The Wizard button is the way
          back now, so the row can be what it looks like: where you are in the
          wizard.

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
                aria-label="Import views"
                className="flex shrink-0 gap-1 rounded-md bg-muted p-1 text-sm"
              >
                <SurfaceToggle active={surface === 'import'} onClick={() => setSurface('import')}>
                  Wizard
                </SurfaceToggle>
                <SurfaceToggle active={surface === 'inbox'} onClick={() => setSurface('inbox')}>
                  Inbox
                </SurfaceToggle>
                <SurfaceToggle active={surface === 'history'} onClick={() => setSurface('history')}>
                  History
                </SurfaceToggle>
              </div>
            }
          />

          {surface === 'import' ? (
            <WizardSteps step={stage} canExport={canExport} onStep={handleStage} />
          ) : null}
        </>
      ) : null}

      {/* Visible on every step and both tabs.

          Before this, an import in flight was invisible from the page whose
          entire subject is importing. `/sources/import` opens on Pick — a
          service picker — and the run pipeline lived inside History, or on the
          Export/Sync card that had happened to start the run. A real 13-source
          import ran for an hour with a source picker on screen and no
          indication that anything was happening at all.

          Outside the step-switching region on purpose: the wizard is a flow
          someone walks, and what the appliance is doing right now is not part
          of that flow — it is true on every step, including the ones that are
          about a completely different archive.

          Renders nothing when nothing is unfinished, which is what lets it be
          mounted unconditionally. Onboarding gets it too — a first-run import
          is exactly when someone most needs to see that it started.

          No height cap here: the path column under the tiles is the scroller,
          so a long run list pushes the picker down and you scroll to it. The
          old 8.5rem / 50% ceilings existed because this column did not scroll
          and a tall region ate the catalog. */}
      <ImportActivity className="max-h-none" />

      {/* The wizard stays MOUNTED and is hidden, never unmounted.

          Everything it holds — the services you picked, which export card you
          are on, and which runs each card has already started — lives in its
          own state. Unmounting it threw all of that away, so glancing at
          History and clicking back to Export returned you to an Export step
          with nothing in it: silent loss of work that the persistent step row
          actively invites you to risk. `hidden` costs a hidden subtree and
          keeps the work.

          The host column scrolls; the wizard grows with its catalog. */}
      <div className={cn(surface !== 'import' && 'hidden')}>
        <ImportWizard
          step={variant === 'page' ? stage : undefined}
          onStepChange={handleStage}
          onCanExportChange={setCanExport}
          scroll="page"
          nav={nav}
        />
      </div>

      {/* Inbox and History hold nothing you can lose — both re-read the server
          on mount — so they are mounted only while shown. They grow into the
          same host scroller as the wizard; they used to be nested scroll panes
          because the header and steps were pinned above them. */}
      {variant === 'page' && surface === 'inbox' ? <InboxPanel /> : null}

      {variant === 'page' && surface === 'history' ? <HistoryTab /> : null}
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
      // One of three, exactly one pressed: clicking shows that surface and
      // clicking it again keeps it there. It used to toggle back to the wizard,
      // which turned a re-click into a surprise trip elsewhere. Not a tablist —
      // see the test file for why.
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
