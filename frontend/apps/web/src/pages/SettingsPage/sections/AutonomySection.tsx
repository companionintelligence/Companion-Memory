import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Button } from '@ci/shadcn';

import { useSessionAuth } from '@/hooks';

import { TRUST_OPTIONS } from '../../OnboardingPage/TrustDialStep';
import { ChoiceList, SettingsFooter, SettingsGroup, SettingsSection, SettingsStatus } from '../kit';

type TrustMode = 'cautious' | 'balanced' | 'hands_off';

type PersonalizationProfile = {
  trustMode: TrustMode;
};

export function AutonomySection() {
  // `ready`, not `authToken`: the token is the web JWT, which the native shell never has — its
  // credential is a keystore API key that `fetchJson` attaches as `x-api-key`. Gating on the token
  // left every option and Save disabled forever on the phone, though `/personalization/*` accepts
  // the key (`JwtOrApiKeyAuthGuard`).
  const { ready, headers } = useSessionAuth();
  const [selected, setSelected] = useState<TrustMode>('balanced');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ready) {
      return;
    }

    setLoading(true);
    try {
      const profile = await fetchJson<PersonalizationProfile>('/api/personalization/profile', {
        headers,
      });
      setSelected(profile?.trustMode ?? 'balanced');
    } catch {
      setError('Failed to load autonomy settings.');
    } finally {
      setLoading(false);
    }
  }, [ready, headers]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    if (!ready) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await fetchJson('/api/personalization/trust-mode', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ trustMode: selected }),
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Failed to save autonomy settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="Autonomy"
      description="Choose how much Companion does on its own."
      help={
        <>
          <p>
            Inbox triage into tasks, calendar placement, graph growth, inferred answers and feed actions all
            follow this setting.
          </p>
          <p>In chat, these wait for your approval unless you choose Hands-off:</p>
          <ul>
            <li>deleting data, importing the inbox, sending a message or completing a task</li>
            <li>every tool from a connected MCP server</li>
            <li>anything chat changes right after looking something up in the same reply</li>
            <li>
              a question chat then sends to a third-party service such as a streaming catalog (reading your
              texts off your own Mac doesn&apos;t count)
            </li>
          </ul>
          <p>
            Reading from an outside service at your request (your messages, streaming availability) asks first
            only on Cautious.
          </p>
        </>
      }
    >
      <SettingsGroup>
        <ChoiceList
          label="Autonomy"
          value={selected}
          options={TRUST_OPTIONS}
          onChange={setSelected}
          disabled={loading}
        />

        <SettingsFooter
          status={
            error ? (
              <SettingsStatus tone="error">{error}</SettingsStatus>
            ) : saved ? (
              <SettingsStatus tone="success">Saved</SettingsStatus>
            ) : null
          }
        >
          <Button onClick={handleSave} disabled={loading || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </SettingsFooter>
      </SettingsGroup>
    </SettingsSection>
  );
}
