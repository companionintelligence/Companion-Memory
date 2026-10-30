import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@ci/shadcn';

import { useWizardNav } from '@/components/WizardNav';

import { useImportApi, type CatalogSource, type ImportBundle } from '../useImportApi';

import { ExportStep } from './ExportStep';
import { PickStep } from './PickStep';
import { exportEntries } from './sources';
import { SyncStep } from './SyncStep';

type Step = 'pick' | 'export' | 'sync';

/** What SyncStep publishes about itself so the footer's primary can be the sync. */
interface SyncNavState {
  canSync: boolean;
  busy: boolean;
  sync: () => void;
}

/**
 * The umbrella experience for "back up my life", in three steps:
 *
 *   1. PICK   — which platforms and services do you use?
 *   2. EXPORT — one card per pick: instructions + the upload, parse on arrival
 *   3. SYNC   — one button pushes everything staged into ci.*
 *
 * State is in-memory only. A refresh returns to Pick, and nothing is lost by
 * that: uploads became runs the moment they landed, the History tab holds
 * them, and Sync finds every unpushed run again regardless of who started it.
 */
export interface ImportWizardProps {
  /**
   * Drive the wizard from outside.
   *
   * The page host owns the step, because the row of step buttons lives up
   * there — combined with the Inbox/History tabs into one navigation row —
   * and has to keep working while this component is unmounted on another tab.
   * Left undefined (onboarding), the wizard keeps its own step.
   */
  step?: Step;
  /** Told the current phase whenever it changes, for hosts that narrate it. */
  onStepChange?: (step: Step) => void;
  /** Whether Export is reachable yet, for a host rendering the step buttons. */
  onCanExportChange?: (canExport: boolean) => void;
  /**
   * `contained` pins Continue and scrolls only the catalog. `page` is the
   * /sources/import column and onboarding: the host scrolls, so the search
   * box and catalog grow with the header and steps above them.
   */
  scroll?: 'contained' | 'page';
  /**
   * Who draws the forward/back controls.
   *
   * `inline` (default, /sources/import) keeps them inside each phase. `host`
   * hands them to the surrounding wizard's single footer via `WizardNav`, so
   * onboarding shows one control row instead of this flow's row stacked above
   * onboarding's own — see `WizardNav` for why that mattered.
   */
  nav?: 'inline' | 'host';
}

export function ImportWizard({
  step: controlledStep,
  onStepChange,
  onCanExportChange,
  scroll = 'contained',
  nav = 'inline',
}: ImportWizardProps = {}) {
  const api = useImportApi();
  const [ownStep, setOwnStep] = useState<Step>('pick');
  const step = controlledStep ?? ownStep;

  const setStep = useCallback(
    (next: Step) => {
      setOwnStep(next);
      onStepChange?.(next);
    },
    [onStepChange],
  );

  useEffect(() => {
    onStepChange?.(step);
  }, [step, onStepChange]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [exportIdx, setExportIdx] = useState(0);
  const [catalog, setCatalog] = useState<readonly CatalogSource[]>([]);
  const [bundles, setBundles] = useState<readonly ImportBundle[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [runsByEntry, setRunsByEntry] = useState<ReadonlyMap<string, readonly string[]>>(new Map());

  useEffect(() => {
    if (!api.ready) {
      return;
    }

    let cancelled = false;

    // Both halves of the authored catalog, shown together: a picker drawn
    // from the sources alone would list every Takeout product as its own
    // button for a moment, then collapse them into the bundle.
    Promise.all([api.listCatalog(), api.listBundles()])
      .then(([sources, bundleList]) => {
        if (!cancelled) {
          setBundles(bundleList);
          setCatalog(sources);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCatalogError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const entries = useMemo(() => exportEntries(catalog, bundles, picked), [catalog, bundles, picked]);

  useEffect(() => {
    onCanExportChange?.(picked.size > 0);
  }, [picked.size, onCanExportChange]);

  const togglePicked = useCallback((key: string) => {
    setPicked((previous) => {
      const next = new Set(previous);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }, []);

  const recordRuns = useCallback((entryKey: string, runIds: readonly string[]) => {
    setRunsByEntry((previous) => {
      const next = new Map(previous);
      // Idempotent append: a re-reported run id must not become a second row
      // (and a second React key) in the live run list — reporting is
      // per-unit-incremental, but dedup here means a repeated report can
      // never multiply the display again.
      const existing = previous.get(entryKey) ?? [];
      const merged = [...existing, ...runIds.filter((id) => !existing.includes(id))];

      next.set(entryKey, merged);

      return next;
    });
  }, []);

  const hostNav = nav === 'host';
  // Published by SyncStep, because the sync handler lives there. ImportWizard
  // stays the single owner of the footer slot — see SyncStep's onNavState.
  const [syncNav, setSyncNav] = useState<SyncNavState | null>(null);
  const lastExportIdx = Math.max(entries.length - 1, 0);
  const clampedExportIdx = Math.min(exportIdx, lastExportIdx);

  const goToExport = useCallback(() => {
    setExportIdx(0);
    setStep('export');
  }, [setStep]);

  // One description of "forward" and "backward" for whichever phase is showing,
  // handed to the host footer. Nothing is registered in `inline` mode, so
  // /sources/import keeps the controls inside the phases.
  useWizardNav(
    !hostNav
      ? null
      : step === 'pick'
        ? {
            // Nothing picked is a legitimate answer here — most people arrive
            // without an export yet — so the button stays live and means "move
            // on" rather than going dead and pointing at Skip.
            // Just the count, not "N selected": the footer's primary shares a
            // 375px row with Back and Skip, and the longer phrasing ellipsized
            // exactly the digit that carries the information. What is selected
            // is already on screen as ticked tiles.
            primaryLabel: picked.size > 0 ? `Continue → ${picked.size}` : 'Next',
            onPrimary: picked.size > 0 ? goToExport : undefined,
          }
        : step === 'export'
          ? {
              primaryLabel: clampedExportIdx >= lastExportIdx ? 'Finish → Sync' : 'Next →',
              onPrimary: () =>
                clampedExportIdx >= lastExportIdx ? setStep('sync') : setExportIdx(clampedExportIdx + 1),
              onBack: () => (clampedExportIdx === 0 ? setStep('pick') : setExportIdx(clampedExportIdx - 1)),
            }
          : {
              // The primary IS the sync. It read "Next" for one revision, which
              // made the biggest button on the last screen of an import quietly
              // abandon the import the previous screen had promised to finish.
              primaryLabel: syncNav?.busy
                ? 'Starting…'
                : syncNav && !syncNav.canSync
                  ? 'Done'
                  : 'Sync to my memory',
              primaryDisabled: syncNav?.busy ?? false,
              onPrimary: syncNav?.canSync ? syncNav.sync : undefined,
              onBack: () => setStep('export'),
            },
  );

  const pageScroll = scroll === 'page';

  return (
    <div className={cn('flex flex-col gap-6', pageScroll ? '' : 'h-full min-h-0')}>
      {catalogError != null && <p className="shrink-0 text-sm text-destructive">{catalogError}</p>}

      {/* Contained: Pick pins Continue and this wrapper is the scroller.
          Page (onboarding): the catalog grows; the host page is the scroller. */}
      <div
        className={cn(
          pageScroll ? '' : 'min-h-0 flex-1',
          pageScroll ? '' : step === 'pick' ? 'overflow-hidden' : 'overflow-y-auto',
        )}
      >
        {step === 'pick' && (
          <PickStep
            catalog={catalog}
            bundles={bundles}
            picked={picked}
            onToggle={togglePicked}
            pinContinue={!pageScroll}
            showContinue={!hostNav}
            onContinue={goToExport}
          />
        )}

        {step === 'export' && (
          <ExportStep
            entries={entries}
            index={exportIdx}
            runsByEntry={runsByEntry}
            onRunsStarted={recordRuns}
            onIndex={setExportIdx}
            onBackToPick={() => setStep('pick')}
            onFinish={() => setStep('sync')}
            showNav={!hostNav}
          />
        )}

        {step === 'sync' && (
          <SyncStep
            onBackToExport={() => setStep('export')}
            showNav={!hostNav}
            onNavState={hostNav ? setSyncNav : undefined}
          />
        )}
      </div>
    </div>
  );
}
