import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { Check } from '@ci/shadcn/icons';

import { useSessionAuth } from '@/hooks';

import { TRUST_OPTIONS } from '../../OnboardingPage/TrustDialStep';

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
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Autonomy</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Control how much Companion does on its own — inbox triage into tasks, calendar placement, graph
          growth, inferred answers, and feed actions all respect this setting. So does chat: deleting data,
          importing the inbox, sending a message, completing a task, and every tool from a connected MCP
          server wait for your approval unless you choose Hands-off. Reading from an outside service — your
          messages, streaming availability — asks first only on Cautious.
        </p>
      </div>

      <Card>
        <Card.Content className="space-y-4 pt-6">
          <div className="flex flex-col gap-3">
            {TRUST_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={selected === opt.value}
                disabled={loading}
                className={`rounded-xl border border-border px-5 py-4 text-left transition-colors hover:border-teal-600/60 ${
                  selected === opt.value ? 'border-teal-600 bg-teal-500/10' : ''
                }`}
                onClick={() => setSelected(opt.value)}
              >
                <span className="block text-lg font-medium">{opt.label}</span>
                <span className="block text-sm text-muted-foreground mt-1">{opt.hint}</span>
              </button>
            ))}
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={loading || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {saved ? (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <Check className="h-4 w-4" />
                Saved
              </span>
            ) : null}
          </div>
        </Card.Content>
      </Card>
    </>
  );
}
