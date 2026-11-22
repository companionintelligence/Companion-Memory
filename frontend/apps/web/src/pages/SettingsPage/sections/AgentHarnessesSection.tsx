import { useCallback } from 'react';

import { Button, IconButton } from '@ci/shadcn';
import { Bot, CheckCircle2, Circle, ExternalLink, Link2 } from '@ci/shadcn/icons';

import { useAgentHarnesses, type AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { openAgentHarness } from '@/lib/agentChat';

import {
  InfoTip,
  SettingsCard,
  SettingsEmpty,
  SettingsLoading,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
} from '../kit';

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
    <CheckCircle2 className="size-4 shrink-0 text-teal-700 dark:text-teal-300" aria-hidden="true" />
  ) : (
    <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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

function HarnessRow({ harness }: { harness: AgentHarnessStatus }) {
  const openReason = openDisabledReason(harness);
  const connectReason = connectDisabledReason(harness);

  const handleOpen = useCallback(() => {
    if (harness.openUrl) {
      openAgentHarness(harness.openUrl, { title: `Open ${harness.name}` });
    }
  }, [harness]);

  return (
    <SettingsRow
      label={harness.name}
      control={
        <>
          <IconButton
            variant="outline"
            size="default"
            label={openReason ? `Open ${harness.name} — ${openReason}` : `Open ${harness.name}`}
            disabled={openReason != null}
            onClick={handleOpen}
          >
            <ExternalLink aria-hidden="true" />
            Open
          </IconButton>

          <IconButton
            variant="outline"
            size="default"
            label={`Connect ${harness.name} to Memory — ${connectReason}`}
            disabled
          >
            <Link2 aria-hidden="true" />
            Connect
          </IconButton>
        </>
      }
    >
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {STATUS_FIELDS.map((field) => {
          const value = harness[field.key];

          return (
            <div key={field.key} className="flex items-center gap-1.5 text-sm">
              <StatusIndicator value={value} />
              <span className={value ? 'text-foreground' : 'text-muted-foreground'}>{field.label}</span>
              {field.note ? (
                <InfoTip label={`About ${field.label.toLowerCase()}`}>{field.note}</InfoTip>
              ) : null}
            </div>
          );
        })}
      </div>
    </SettingsRow>
  );
}

export function AgentHarnessesSection() {
  const { harnesses, loading, error, reload } = useAgentHarnesses();

  return (
    <SettingsSection
      title="Agents"
      description="Agent apps Memory found through the Companion Hub."
      help="Hermes and OpenClaw agent harnesses discovered through the Companion Hub. Open one directly, or see why it isn't reachable yet."
    >
      {error ? (
        <SettingsNotice
          tone="error"
          action={
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          }
        >
          {error}
        </SettingsNotice>
      ) : null}

      {loading ? (
        <SettingsCard>
          <SettingsLoading />
        </SettingsCard>
      ) : harnesses.length === 0 ? (
        error ? null : (
          <SettingsCard>
            <SettingsEmpty icon={<Bot />} title="No agent harnesses found." />
          </SettingsCard>
        )
      ) : (
        <SettingsCard>
          {harnesses.map((harness) => (
            <HarnessRow key={harness.id} harness={harness} />
          ))}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
