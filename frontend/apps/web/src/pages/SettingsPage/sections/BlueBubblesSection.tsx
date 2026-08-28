import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Button, Card, Checkbox, Input, Label, Switch } from '@ci/shadcn';
import { AlertCircle, CheckCircle2, Clock, MessageSquare, Pencil } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

interface BlueBubblesConfigResponse {
  host: string;
  port: number;
  useHttps: boolean;
  /** Never the raw password — see BlueBubblesConfigController's masked GET response. */
  hasPassword: boolean;
  hasPrivateApi: boolean;
  enabled: boolean;
  connectionStatus: 'connected' | 'error' | 'unknown';
  lastError: string | null;
  lastSyncCursor: string | null;
  lastWebhookReceivedAt: string | null;
}

interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

const DEFAULT_PORT = '1234';

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'never';
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

/**
 * BlueBubbles (https://github.com/BlueBubblesApp/bluebubbles-app) connection
 * settings: host/port/credentials for the appliance-wide iMessage/SMS
 * connector, a Test connection round trip, and a Sync now trigger.
 *
 * No dedicated inbox UI here on purpose — this section only configures the
 * connection. Reading/sending messages happens through the AI assistant's
 * `messaging.*` tools, and historical/ongoing ingestion lands wherever every
 * other imported source does (Memory, Import Runs).
 */
export function BlueBubblesSection() {
  const [{ authToken }] = useAuth();

  const [config, setConfig] = useState<BlueBubblesConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [host, setHost] = useState('');
  const [port, setPort] = useState(DEFAULT_PORT);
  const [useHttps, setUseHttps] = useState(false);
  const [hasPrivateApi, setHasPrivateApi] = useState(false);
  const [enabled, setEnabled] = useState(false);

  // The password field is never pre-filled with anything real — only whether
  // one is already saved. Editing it is an explicit "Change" affordance so an
  // untouched field can stay omitted from the PUT body (backend contract:
  // omitted = keep the existing stored password).
  const [passwordEditing, setPasswordEditing] = useState(false);
  const [password, setPassword] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const authHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {};

    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    return headers;
  }, [authToken]);

  const applyConfig = useCallback((next: BlueBubblesConfigResponse) => {
    setConfig(next);
    setHost(next.host);
    setPort(String(next.port || DEFAULT_PORT));
    setUseHttps(next.useHttps);
    setHasPrivateApi(next.hasPrivateApi);
    setEnabled(next.enabled);
    setPasswordEditing(false);
    setPassword('');
  }, []);

  const load = useCallback(async () => {
    if (!authToken) {
      setLoading(false);

      return;
    }

    setLoading(true);
    setLoadError(null);

    try {
      const data = await fetchJson<BlueBubblesConfigResponse>('/api/bluebubbles/config', {
        headers: authHeaders,
      });

      if (data) {
        applyConfig(data);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load BlueBubbles settings.');
    } finally {
      setLoading(false);
    }
  }, [authToken, authHeaders, applyConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  const portNumber = Number.parseInt(port, 10);
  const portValid = Number.isFinite(portNumber) && portNumber > 0 && portNumber <= 65535;
  const hostValid = host.trim().length > 0;

  const dirty =
    config != null &&
    (host !== config.host ||
      String(portNumber) !== String(config.port) ||
      useHttps !== config.useHttps ||
      hasPrivateApi !== config.hasPrivateApi ||
      enabled !== config.enabled ||
      (passwordEditing && password.trim().length > 0));

  const handleSave = async () => {
    if (!hostValid || !portValid) {
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      const data = await fetchJson<BlueBubblesConfigResponse>('/api/bluebubbles/config', {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: host.trim(),
          port: portNumber,
          useHttps,
          hasPrivateApi,
          enabled,
          ...(passwordEditing && password.trim() ? { password: password.trim() } : {}),
        }),
      });

      if (data) {
        applyConfig(data);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2500);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save BlueBubbles settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const result = await fetchJson<TestConnectionResult>('/api/bluebubbles/test-connection', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: host.trim() || undefined,
          port: portValid ? portNumber : undefined,
          useHttps,
          ...(passwordEditing && password.trim() ? { password: password.trim() } : {}),
        }),
      });

      setTestResult(result ?? { ok: false, error: 'No response from server.' });
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test connection failed.' });
    } finally {
      setTesting(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncMessage(null);

    try {
      await fetchJson('/api/bluebubbles/sync-now', {
        method: 'POST',
        headers: authHeaders,
      });
      setSyncMessage('Sync started — check Import Runs for progress.');
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Could not start sync.');
    } finally {
      setSyncing(false);
      window.setTimeout(() => setSyncMessage(null), 5000);
    }
  };

  const statusIcon = () => {
    switch (config?.connectionStatus) {
      case 'connected':
        return <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 flex-shrink-0" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-500 flex-shrink-0" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    }
  };

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">BlueBubbles</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect a BlueBubbles server to bring iMessage/SMS history in, keep it in sync, and let the
          assistant send and read messages on your behalf.
        </p>
      </div>

      <Card className="mb-6">
        <Card.Content className="space-y-5 pt-6">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-700 dark:text-teal-300">
              <MessageSquare className="h-4 w-4" />
            </div>
            <div className="space-y-1 min-w-0">
              <h3 className="text-base font-semibold text-foreground">Connection</h3>
              <p className="text-sm text-muted-foreground leading-snug">
                The Mac running BlueBubbles Server — see{' '}
                <a
                  href="https://bluebubbles.app"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  bluebubbles.app
                </a>{' '}
                for setup.
              </p>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading BlueBubbles settings…</p>
          ) : (
            <div className="space-y-4 border-t border-border pt-4">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="grid gap-2">
                  <Label htmlFor="bb-host">Host</Label>
                  <Input
                    id="bb-host"
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder="192.168.1.50"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="bb-port">Port</Label>
                  <Input
                    id="bb-port"
                    inputMode="numeric"
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    placeholder={DEFAULT_PORT}
                    className="sm:w-28"
                  />
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Checkbox
                  id="bb-https"
                  checked={useHttps}
                  onCheckedChange={(checked) => setUseHttps(checked === true)}
                />
                <Label htmlFor="bb-https" className="cursor-pointer font-normal">
                  Use HTTPS
                </Label>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="bb-password">Server password</Label>
                {passwordEditing ? (
                  <Input
                    id="bb-password"
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="BlueBubbles server password"
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <Input
                      id="bb-password"
                      type="password"
                      value={config?.hasPassword ? '••••••••' : ''}
                      disabled
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPasswordEditing(true)}
                    >
                      <Pencil className="h-3.5 w-3.5 mr-1.5" />
                      Change
                    </Button>
                  </div>
                )}
              </div>

              <div className="flex items-start gap-3">
                <Checkbox
                  id="bb-private-api"
                  checked={hasPrivateApi}
                  onCheckedChange={(checked) => setHasPrivateApi(checked === true)}
                />
                <div className="grid gap-0.5">
                  <Label htmlFor="bb-private-api" className="cursor-pointer font-normal">
                    Private API enabled on the server
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    Required for the assistant to send messages (messaging.send).
                  </span>
                </div>
              </div>

              <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
                <div className="space-y-0.5">
                  <Label htmlFor="bb-enabled">Enabled</Label>
                  <p className="text-xs text-muted-foreground">
                    Import history, accept live webhooks, and let the assistant use messaging tools.
                  </p>
                </div>
                <Switch id="bb-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button
                  type="button"
                  disabled={!dirty || saving || !hostValid || !portValid}
                  onClick={() => void handleSave()}
                >
                  {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={testing || !hostValid || !portValid}
                  onClick={() => void handleTestConnection()}
                >
                  {testing ? 'Testing…' : 'Test connection'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={syncing || !config?.enabled}
                  onClick={() => void handleSyncNow()}
                >
                  {syncing ? 'Starting…' : 'Sync now'}
                </Button>
                {saved && <span className="text-sm text-teal-700 dark:text-teal-300">Saved</span>}
              </div>

              {testResult ? (
                <p
                  className={`text-sm ${testResult.ok ? 'text-teal-700 dark:text-teal-300' : 'text-destructive'}`}
                >
                  {testResult.ok
                    ? `Connected${testResult.latencyMs != null ? ` (${testResult.latencyMs}ms)` : ''}.`
                    : (testResult.error ?? 'Connection failed.')}
                </p>
              ) : null}

              {syncMessage ? <p className="text-sm text-muted-foreground">{syncMessage}</p> : null}
              {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}
              {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
            </div>
          )}
        </Card.Content>
      </Card>

      {config && !loading ? (
        <Card>
          <Card.Content className="space-y-3 pt-6">
            <h3 className="text-base font-semibold text-foreground">Status</h3>
            <div className="flex items-center gap-2 text-sm">
              {statusIcon()}
              <span className="capitalize">{config.connectionStatus}</span>
              {config.lastError ? <span className="text-muted-foreground">— {config.lastError}</span> : null}
            </div>
            <dl className="grid gap-1 text-sm text-muted-foreground">
              <div className="flex justify-between gap-4">
                <dt>Last sync</dt>
                <dd>{formatTimestamp(config.lastSyncCursor)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Last webhook received</dt>
                <dd>{formatTimestamp(config.lastWebhookReceivedAt)}</dd>
              </div>
            </dl>
          </Card.Content>
        </Card>
      ) : null}
    </>
  );
}
