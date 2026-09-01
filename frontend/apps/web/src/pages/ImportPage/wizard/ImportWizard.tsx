import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@ci/shadcn';

import { useImportApi, type CatalogSource } from '../useImportApi';

import { ExportStep } from './ExportStep';
import { PickStep } from './PickStep';
import { exportEntries } from './sources';
import { SyncStep } from './SyncStep';

type Step = 'pick' | 'export' | 'sync';

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
}

export function ImportWizard({
  step: controlledStep,
  onStepChange,
  onCanExportChange,
  scroll = 'contained',
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
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [runsByEntry, setRunsByEntry] = useState<ReadonlyMap<string, readonly string[]>>(new Map());

  useEffect(() => {
    if (!api.ready) {
      return;
    }

    let cancelled = false;

    api
      .listCatalog()
      .then((sources) => {
        if (!cancelled) {
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

  const entries = useMemo(() => exportEntries(catalog, picked), [catalog, picked]);

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
            picked={picked}
            onToggle={togglePicked}
            pinContinue={!pageScroll}
            onContinue={() => {
              setExportIdx(0);
              setStep('export');
            }}
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
          />
        )}

        {step === 'sync' && <SyncStep onBackToExport={() => setStep('export')} />}
      </div>
    </div>
  );
}
