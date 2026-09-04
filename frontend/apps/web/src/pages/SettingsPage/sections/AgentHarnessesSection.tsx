import { useCallback } from 'react';

import { Button, Card, IconButton } from '@ci/shadcn';
import { Bot, CheckCircle2, Circle, ExternalLink, Info, Link2 } from '@ci/shadcn/icons';

import { useAgentHarnesses, type AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { openAgentHarness } from '@/lib/agentChat';

interface StatusField {
  key: 'installed' | 'connectedToMemory' | 'running' | 'accessible';
  label: string;
  /** Shown as an info tooltip next to the label — used for `accessible`, which
   *  is only an alias for `running` today rather than an independent signal. */
  note?: string;
}

const STATUS_FIELDS: StatusField[] = [
  { key: 'installed', label: 'Installed' },
  { key: 'connectedToMemory', label: 'Connected to Memory' },
  { key: 'running', label: 'Running' },
  {
    key: 'accessible',
    label: 'Accessible',
    note: 'Currently just mirrors "Running" — not an independent signal yet.',
  },
];

function StatusIndicator({ value }: { value: boolean }) {
  return value ? (
    <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-500" />
  ) : (
    <Circle className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
  );
}

/** Why the Open action is disabled — null when it's clickable. */
export function openDisabledReason(harness: AgentHarnessStatus): string | null {
  if (!harness.installed) {
    return 'Not installed — install it from the Companion Hub first.';
  }

  if (!harness.openUrl) {
    return 'No open URL available for this app yet.';
  }

  if (!harness.running) {
    return 'Not running — start it on your device first.';
  }

  return null;
}

/**
 * Connect has no in-app entry point yet — a harness only becomes
 * `connectedToMemory` through the Hub's own "Connect Memory" flow (see
 * ApiKeysSection's `isHubManagedKey`). Always disabled; the reason just
 * explains which side of that gap the harness is currently on.
 */
export function connectDisabledReason(harness: AgentHarnessStatus): string {
  return harness.connectedToMemory
    ? `${harness.name} is already connected to Memory.`
    : 'Connect this app to Memory from the Companion Hub — there is no in-app flow for that yet.';
}

function HarnessCard({ harness }: { harness: AgentHarnessStatus }) {
  const openReason = openDisabledReason(harness);
  const connectReason = connectDisabledReason(harness);

  const handleOpen = useCallback(() => {
    if (harness.openUrl) {
      openAgentHarness(harness.openUrl, { title: `Open ${harness.name}` });
    }
  }, [harness]);

  return (
    <Card>
      <Card.Content className="space-y-4 pt-6">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-700 dark:text-teal-300">
            <Bot className="h-4 w-4" />
          </div>
          <h3 className="text-base font-semibold text-foreground">{harness.name}</h3>
        </div>

        <div className="grid gap-2 border-t border-border pt-4 sm:grid-cols-2">
          {STATUS_FIELDS.map((field) => {
            const value = harness[field.key];

            return (
              <div key={field.key} className="flex items-center gap-1.5 text-sm">
                <StatusIndicator value={value} />
                <span className={value ? 'text-foreground' : 'text-muted-foreground'}>{field.label}</span>
                {field.note && (
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    label={field.note}
                    className="h-4 w-4 text-muted-foreground hover:text-foreground"
                  >
                    <Info className="h-3 w-3" />
                  </IconButton>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <IconButton
            variant="outline"
            size="sm"
            label={openReason ? `Open ${harness.name} — ${openReason}` : `Open ${harness.name}`}
            disabled={openReason != null}
            onClick={handleOpen}
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} />
            Open
          </IconButton>

          <IconButton
            variant="outline"
            size="sm"
            label={`Connect ${harness.name} to Memory — ${connectReason}`}
            disabled
          >
            <Link2 className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} />
            Connect
          </IconButton>
        </div>
      </Card.Content>
    </Card>
  );
}

export function AgentHarnessesSection() {
  const { harnesses, loading, error, reload } = useAgentHarnesses();

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Agents</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Hermes and OpenClaw agent harnesses discovered through the Companion Hub — open one directly, or see
          why it isn't reachable yet.
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {error}
          <Button size="sm" variant="outline" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : harnesses.length === 0 ? (
        <Card>
          <Card.Content className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">No agent harnesses found.</p>
          </Card.Content>
        </Card>
      ) : (
        <div className="space-y-3">
          {harnesses.map((harness) => (
            <HarnessCard key={harness.id} harness={harness} />
          ))}
        </div>
      )}
    </>
  );
}
