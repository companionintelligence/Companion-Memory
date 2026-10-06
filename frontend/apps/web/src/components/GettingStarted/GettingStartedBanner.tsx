import { useState } from 'react';

import { useQuery } from '@apollo/client';
import { useDeviceLayout } from '@ci/common';
import { Button, IconButton, useToast } from '@ci/shadcn';
import { AlertCircle, Check, Circle, Loader2, Sparkles, X } from '@ci/shadcn/icons';
import { Link, useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { GET_CONNECTIONS } from '@/components/connect/ConnectedAccountsSection';
import { useCurrentUser, useModel } from '@/hooks';
import { settingsSectionTarget } from '@/layouts/Main/SecondaryNavigation/selfSections';
import { dismissGettingStarted, isGettingStartedActive } from '@/lib/gettingStarted';
import { useActiveImports, useImportApi } from '@/pages/ImportPage/useImportApi';

import { deriveChecklist, type ChecklistStep, type StepStatus } from './firstSync';
import { useFirstSyncStatus } from './useFirstSyncStatus';

const STATUS_ICON: Record<StepStatus, { Icon: typeof Check; className: string; spin?: boolean }> = {
  done: { Icon: Check, className: 'text-primary' },
  working: { Icon: Loader2, className: 'text-muted-foreground', spin: true },
  attention: { Icon: AlertCircle, className: 'text-amber-600 dark:text-amber-400' },
  todo: { Icon: Circle, className: 'text-muted-foreground' },
  unknown: { Icon: Circle, className: 'text-muted-foreground/40' },
};

/**
 * The strip that answers "did the wizard do anything?" after onboarding.
 *
 * A nine-step setup used to end on an empty Tasks page, with the first sync
 * fired off and forgotten. This sits over whatever page the user lands on and
 * says, in live numbers, what has reached their memory, what is still being
 * read or indexed, and what only they can do next: choose a chat model, add a
 * source, save an import that parsed but was never pushed.
 *
 * It is owed only to someone who has just finished onboarding (see
 * lib/gettingStarted), and the outer component costs nothing for everyone else:
 * the polling lives in the body, which is not mounted unless the banner is.
 */
export function GettingStartedBanner() {
  const { user } = useCurrentUser();
  const userId = user?.id ?? null;
  // Local override so closing takes effect at once instead of on the next
  // render that happens to re-read storage.
  const [closed, setClosed] = useState(false);

  if (!userId || closed || !isGettingStartedActive(userId)) {
    return null;
  }

  return (
    <GettingStartedBannerBody
      onDismiss={() => {
        dismissGettingStarted(userId);
        setClosed(true);
      }}
    />
  );
}

function GettingStartedBannerBody({ onDismiss }: { onDismiss: () => void }) {
  const { toast } = useToast();
  const location = useLocation();
  const { isMobile } = useDeviceLayout();
  const { isFeatureEnabled } = useFeatures();
  const importsEnabled = isFeatureEnabled('import.page');

  const [{ activeModels, loading: modelsLoading }] = useModel();
  const { data: connectionData } = useQuery(GET_CONNECTIONS, { pollInterval: 30_000 });
  const { snapshot, refresh: refreshImports } = useActiveImports(2_000, 30_000, importsEnabled);
  const status = useFirstSyncStatus(true, importsEnabled);
  const { startPush } = useImportApi();

  // Open on desktop, folded to one line on a phone where every row of height is
  // taken from the page underneath. `null` until the user chooses.
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const expanded = expandedChoice ?? isMobile === false;
  const [saving, setSaving] = useState(false);

  const checklist = deriveChecklist({
    hasModel: activeModels.length > 0,
    modelsLoading,
    connectionCount: connectionData ? connectionData.connections.totalCount : null,
    unpushedRuns: status.unpushedRuns,
    runningImports: importsEnabled ? (snapshot ? snapshot.batch.running + snapshot.batch.queued : null) : 0,
    runningRecords: snapshot?.batch.records ?? 0,
    totals: status.totals,
    indexingItems: status.indexingItems,
  });

  const modelTarget = settingsSectionTarget('model', isMobile, location) ?? { to: '/settings/model' };

  const saveToMemory = async () => {
    setSaving(true);

    try {
      const { runs } = await startPush();
      toast.success(`Saving ${runs.length} import${runs.length === 1 ? '' : 's'} to your memory.`);
      status.refresh();
      refreshImports();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'The save could not be started.');
    } finally {
      setSaving(false);
    }
  };

  const nextStep = checklist.steps.find((step) => step.status !== 'done' && step.status !== 'unknown');
  const headline = checklist.allDone ? 'You’re all set' : `Getting started · ${checklist.doneCount} of 3`;
  // Folded, the summary names the next thing to do; open, the rows below already
  // say it, and repeating the same sentence twice in a strip is just noise.
  const summary = checklist.countsLine
    ? `In your memory now: ${checklist.countsLine}`
    : expanded
      ? 'Here’s what’s left.'
      : (nextStep?.title ?? 'Checking on your setup…');

  const action = (step: ChecklistStep) => {
    if (step.id === 'model' && step.status === 'todo') {
      return (
        <Button asChild size="sm" variant="outline">
          <Link to={modelTarget.to} state={modelTarget.state}>
            Set up a model
          </Link>
        </Button>
      );
    }

    if (step.id === 'data' && step.status === 'todo') {
      return (
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/sources/connect">Connect a source</Link>
          </Button>
          {importsEnabled ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/sources/import">Import data</Link>
            </Button>
          ) : null}
        </div>
      );
    }

    if (step.id === 'memory' && step.status === 'attention') {
      return (
        <Button size="sm" onClick={() => void saveToMemory()} disabled={saving}>
          {saving ? 'Saving…' : 'Save to memory'}
        </Button>
      );
    }

    if (step.id === 'memory' && step.status === 'working' && importsEnabled) {
      return (
        <Button asChild size="sm" variant="ghost">
          <Link to="/sources/import">See progress</Link>
        </Button>
      );
    }

    return null;
  };

  return (
    <section
      aria-label="Getting started"
      data-testid="getting-started"
      className="shrink-0 border-b border-border bg-card/90 px-4 py-2 text-sm"
    >
      <div className="flex items-center gap-3">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.5} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{headline}</p>
          <p role="status" className="truncate text-xs text-muted-foreground">
            {summary}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpandedChoice(!expanded)}
        >
          {expanded ? 'Hide' : 'Details'}
        </Button>
        <IconButton
          variant="ghost"
          label="Dismiss getting started"
          tooltip="Dismiss"
          onClick={onDismiss}
          className="shrink-0"
        >
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      {expanded ? (
        <ol className="mt-2 space-y-2 pb-1">
          {checklist.steps.map((step) => {
            const { Icon, className, spin } = STATUS_ICON[step.status];
            const stepAction = action(step);

            return (
              <li
                key={step.id}
                data-step={step.id}
                data-status={step.status}
                className="flex items-start gap-3"
              >
                <Icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${className}${spin ? ' animate-spin' : ''}`}
                  strokeWidth={1.5}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className={step.status === 'done' ? 'text-muted-foreground' : 'font-medium'}>
                    {step.title}
                  </p>
                  {step.detail ? <p className="text-xs text-muted-foreground">{step.detail}</p> : null}
                </div>
                {stepAction ? <div className="shrink-0">{stepAction}</div> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
