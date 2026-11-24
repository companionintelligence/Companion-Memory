import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Switch } from '@ci/shadcn';

import { useAuth } from '@/hooks';

import { SettingsGroup, SettingsNotice, SettingsRow, SettingsSection, SettingsStatus } from '../kit';

export type OutboundKey = 'crash_reports' | 'place_lookups' | 'link_previews' | 'portal_oauth';

interface OutboundPath {
  key: OutboundKey;
  enabled: boolean;
  effective: boolean;
  locked: boolean;
  lockedReason: string | null;
}

interface OutboundSettings {
  paths: OutboundPath[];
  canEdit: boolean;
}

/** What each path sends, and where. Mirrors "What leaves your appliance" in the docs. */
export const OUTBOUND_COPY: Record<OutboundKey, { label: string; sends: string }> = {
  crash_reports: {
    label: 'Crash reports',
    sends:
      'Error details (stack traces, app version) go to Sentry when something breaks. No memories, messages or file contents.',
  },
  place_lookups: {
    label: 'Place lookups',
    sends:
      'Place names and coordinates go through CI Portal to turn addresses into map positions and back. Without this, places stay unresolved.',
  },
  link_previews: {
    label: 'Link previews',
    sends:
      'The appliance fetches linked pages from the open web to read their title, image and description. Without this, links show as plain URLs.',
  },
  portal_oauth: {
    label: 'Sign-in through Portal',
    sends:
      'Connecting Google, Microsoft and similar services starts through CI Portal. Services you already connected keep working; new ones need your own OAuth credentials.',
  },
};

const KEYS = Object.keys(OUTBOUND_COPY) as OutboundKey[];

export function PrivacySection() {
  const [{ authToken }] = useAuth();
  const [settings, setSettings] = useState<OutboundSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<OutboundKey | null>(null);

  const headers = useCallback(
    (): Record<string, string> => ({
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    }),
    [authToken],
  );

  useEffect(() => {
    if (!authToken) {
      return;
    }

    fetchJson<OutboundSettings>('/api/privacy/outbound', { headers: headers() })
      .then((loaded) => setSettings(loaded ?? null))
      .catch(() => setError('Failed to load privacy settings.'));
  }, [authToken, headers]);

  const toggle = async (key: OutboundKey, enabled: boolean) => {
    setPending(key);
    setError(null);

    try {
      const next = await fetchJson<Omit<OutboundSettings, 'canEdit'>>('/api/privacy/outbound', {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ key, enabled }),
      });
      const paths = next?.paths;

      if (paths) {
        setSettings((prev) => (prev ? { ...prev, paths } : prev));
      }
    } catch {
      setError('Could not save that change.');
    } finally {
      setPending(null);
    }
  };

  const byKey = new Map(settings?.paths.map((path) => [path.key, path]));

  return (
    <SettingsSection
      title="Privacy"
      description="The few things that can leave this appliance. Each one can be switched off."
      help="Your memory stays on this appliance. Everything else (search, chat with a local model, sync) never leaves."
    >
      {settings && !settings.canEdit ? (
        <SettingsNotice>Only an administrator can change these.</SettingsNotice>
      ) : null}

      <SettingsGroup>
        {KEYS.map((key) => {
          const path = byKey.get(key);
          const copy = OUTBOUND_COPY[key];

          return (
            <SettingsRow
              key={key}
              label={copy.label}
              htmlFor={`outbound-${key}`}
              align="start"
              hint={
                <>
                  {copy.sends}
                  {path?.locked ? <span className="mt-1 block">{path.lockedReason}</span> : null}
                </>
              }
              control={
                <Switch
                  id={`outbound-${key}`}
                  aria-label={copy.label}
                  checked={path?.effective ?? true}
                  disabled={!path || !settings?.canEdit || pending === key || (path.locked && !path.enabled)}
                  onCheckedChange={(checked) => void toggle(key, checked)}
                />
              }
            />
          );
        })}

        {error ? (
          <SettingsRow>
            <SettingsStatus tone="error">{error}</SettingsStatus>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </SettingsSection>
  );
}
