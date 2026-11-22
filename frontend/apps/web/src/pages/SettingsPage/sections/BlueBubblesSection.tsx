import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson, getWebOrigin } from '@ci/common';
import { Button, IconButton, Input, Label, Switch } from '@ci/shadcn';
import { AlertCircle, Check, CheckCircle2, ClipboardCopy, Clock, Pencil, RefreshCw } from '@ci/shadcn/icons';

import { useSessionAuth } from '@/hooks';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

import {
  SettingsFacts,
  SettingsFooter,
  SettingsGroup,
  SettingsHint,
  SettingsLoading,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from '../kit';

/**
 * What an administrator gets back. Everyone else gets {@link BlueBubblesStatusResponse}: the host,
 * the error text and the webhook URL (whose secret lets anyone post messages into the owner's
 * memory) are the administrator's to see.
 */
interface BlueBubblesConfigResponse {
  canEdit: true;
  host: string;
  port: number;
  useHttps: boolean;
  /** Never the raw password — see BlueBubblesConfigController's masked GET response. */
  hasPassword: boolean;
  hasPrivateApi: boolean;
  enabled: boolean;
  /**
   * Path (not a full URL) of this appliance's webhook endpoint, secret segment
   * included — the address the user pastes into BlueBubbles Server. The origin
   * is added here rather than server-side because the appliance is reached at
   * whatever address this browser used, which the server cannot know.
   */
  webhookPath: string;
  connectionStatus: 'connected' | 'error' | 'unknown';
  lastError: string | null;
  lastSyncCursor: string | null;
  lastWebhookReceivedAt: string | null;
}

/** The status-only answer `GET /api/bluebubbles/config` gives an account that is not an administrator. */
interface BlueBubblesStatusResponse {
  canEdit: false;
  enabled: boolean;
  connectionStatus: 'connected' | 'error' | 'unknown';
  lastSyncCursor: string | null;
  lastWebhookReceivedAt: string | null;
}

interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

const DEFAULT_PORT = '1234';

function formatTimestamp(value: string | null, fmt: DateTimeFormatter): string {
  if (!value) {
    return 'never';
  }

  return fmt.tryDateTime(value) ?? value;
}

/**
 * A ref for a status line that brings it into view when a value arrives for it.
 *
 * This form is taller than a phone's screen and its button row sits near the
 * bottom edge of it, so what a button reports is drawn BELOW the fold: tapping
 * "Test connection" looked like it did nothing until the person scrolled down and
 * found the answer under "Sync now". `nearest` moves the page only as far as it
 * takes to show the line, and not at all when it is already on screen.
 */
function useRevealWhenSet(value: unknown) {
  const ref = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (value) {
      ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  }, [value]);

  return ref;
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
  // `ready`, not `authToken`: the token is the web JWT, which the native shell never has — its
  // credential is a keystore API key that `fetchJson` attaches as `x-api-key`. Gating on the token
  // meant the saved connection never filled the form on the phone, and `dirty` (which needs a loaded
  // config) kept Save disabled for good. The controller is `JwtOrApiKeyAuthGuard`.
  const { ready, headers: authHeaders } = useSessionAuth();
  const fmt = useDateTimeFormat();
  // The BlueBubbles connection is one configuration for the whole appliance, and "test
  // connection" makes the appliance dial an arbitrary host. Both are administrator actions on
  // the server (ApplianceAdminGuard). The server also decides who sees the settings at all: an
  // account it does not treat as an administrator gets a status-only answer, so the form and the
  // webhook URL are never in this page's hands to show.
  const [status, setStatus] = useState<BlueBubblesStatusResponse | null>(null);
  const [config, setConfig] = useState<BlueBubblesConfigResponse | null>(null);
  const isAdmin = config != null;
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

  const [webhookCopied, setWebhookCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const testResultRef = useRevealWhenSet(testResult);
  const syncMessageRef = useRevealWhenSet(syncMessage);
  const saveErrorRef = useRevealWhenSet(saveError);

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
    if (!ready) {
      setLoading(false);

      return;
    }

    setLoading(true);
    setLoadError(null);

    try {
      const data = await fetchJson<BlueBubblesConfigResponse | BlueBubblesStatusResponse>(
        '/api/bluebubbles/config',
        { headers: authHeaders },
      );

      // Each answer replaces the other: `isAdmin` is read off `config`, so a status answer after an
      // earlier full one (the account lost its role) must not leave the old settings on screen.
      if (data?.canEdit === true) {
        setStatus(null);
        applyConfig(data);
      } else if (data) {
        setConfig(null);
        setStatus(data);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load BlueBubbles settings.');
    } finally {
      setLoading(false);
    }
  }, [ready, authHeaders, applyConfig]);

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

  // getWebOrigin(), not window.location.origin: on the phone that is the app's own
  // `capacitor://localhost`, which BlueBubbles Server could never call.
  const webhookUrl = config?.webhookPath ? `${getWebOrigin()}${config.webhookPath}` : null;

  /**
   * Issue a new webhook secret. The old URL stops working the moment this succeeds, so it asks
   * first, and it only swaps the URL into the page: unsaved edits in the form above stay as they are.
   */
  const handleRotateWebhook = async () => {
    const confirmed = window.confirm(
      'Make a new webhook URL? The current one stops working right away. Until you paste the new ' +
        'URL into BlueBubbles Server, new messages only arrive on the ten-minute backstop poll.',
    );

    if (!confirmed) {
      return;
    }

    setRotating(true);
    setRotateError(null);

    try {
      const data = await fetchJson<BlueBubblesConfigResponse>('/api/bluebubbles/rotate-webhook-secret', {
        method: 'POST',
        headers: authHeaders,
      });

      if (data?.webhookPath) {
        setConfig((previous) => (previous ? { ...previous, webhookPath: data.webhookPath } : previous));
      }
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : 'Could not make a new webhook URL.');
    } finally {
      setRotating(false);
    }
  };

  const handleCopyWebhookUrl = async () => {
    if (!webhookUrl) {
      return;
    }

    await navigator.clipboard.writeText(webhookUrl);
    setWebhookCopied(true);
    window.setTimeout(() => setWebhookCopied(false), 2000);
  };

  const statusIcon = () => {
    switch ((config ?? status)?.connectionStatus) {
      case 'connected':
        return (
          <CheckCircle2 className="size-4 shrink-0 text-teal-700 dark:text-teal-300" aria-hidden="true" />
        );
      case 'error':
        return <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
      default:
        return <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
    }
  };

  const statusGroup = (state: {
    label: string;
    lastError?: string | null;
    lastSyncCursor: string | null;
    lastWebhookReceivedAt: string | null;
  }) => (
    <SettingsGroup title="Status">
      <SettingsRow>
        <SettingsFacts
          items={[
            {
              label: 'Connection',
              value: (
                <span className="inline-flex items-center gap-1.5">
                  {statusIcon()}
                  <span className="capitalize">{state.label}</span>
                </span>
              ),
            },
            { label: 'Last sync', value: formatTimestamp(state.lastSyncCursor, fmt) },
            { label: 'Last webhook received', value: formatTimestamp(state.lastWebhookReceivedAt, fmt) },
          ]}
        />
        {state.lastError ? <SettingsHint className="text-destructive">{state.lastError}</SettingsHint> : null}
      </SettingsRow>
    </SettingsGroup>
  );

  const sectionProps = {
    title: 'BlueBubbles',
    description: 'Bring in iMessage and SMS history from a Mac running BlueBubbles Server.',
    help: (
      <>
        <p>
          Companion keeps the history in sync and lets the assistant send and read messages on your behalf.
        </p>
        <p>
          See{' '}
          <a href="https://bluebubbles.app" target="_blank" rel="noreferrer">
            bluebubbles.app
          </a>{' '}
          to set up the server on your Mac.
        </p>
      </>
    ),
  };

  // Not an administrator: the server sent on/off and activity times only. The connection belongs
  // to the account an administrator set it up for, and only that account's assistant can read or
  // send messages through it.
  if (!loading && !isAdmin) {
    return (
      <SettingsSection {...sectionProps}>
        <SettingsNotice>
          An administrator of this Companion sets up BlueBubbles, for their own Mac. The assistant&apos;s
          messaging tools work only for the account it was set up for.
        </SettingsNotice>
        {loadError ? <SettingsStatus tone="error">{loadError}</SettingsStatus> : null}

        {status
          ? statusGroup({
              label: status.enabled ? status.connectionStatus : 'off',
              lastSyncCursor: status.lastSyncCursor,
              lastWebhookReceivedAt: status.lastWebhookReceivedAt,
            })
          : null}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection {...sectionProps}>
      <SettingsGroup title="Connection" description="The Mac running BlueBubbles Server.">
        {loading ? (
          <SettingsLoading>Loading BlueBubbles settings…</SettingsLoading>
        ) : (
          <>
            <SettingsRow>
              <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
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
            </SettingsRow>

            <SettingsRow
              label="Use HTTPS"
              htmlFor="bb-https"
              control={<Switch id="bb-https" checked={useHttps} onCheckedChange={setUseHttps} />}
            />

            <SettingsRow label="Server password" htmlFor="bb-password">
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
                  <Button type="button" variant="outline" onClick={() => setPasswordEditing(true)}>
                    <Pencil aria-hidden="true" />
                    Change
                  </Button>
                </div>
              )}
            </SettingsRow>

            <SettingsRow
              label="Private API enabled on the server"
              htmlFor="bb-private-api"
              hint="Required for the assistant to send messages (messaging.send)."
              control={
                <Switch id="bb-private-api" checked={hasPrivateApi} onCheckedChange={setHasPrivateApi} />
              }
            />

            <SettingsRow
              label="Enabled"
              htmlFor="bb-enabled"
              hint="Import history, accept live webhooks and let the assistant use messaging tools."
              control={<Switch id="bb-enabled" checked={enabled} onCheckedChange={setEnabled} />}
            />

            <SettingsFooter
              status={
                testResult || syncMessage || saveError || loadError || saved ? (
                  <div className="space-y-1">
                    {saved ? <SettingsStatus tone="success">Saved</SettingsStatus> : null}
                    {testResult ? (
                      <SettingsStatus ref={testResultRef} tone={testResult.ok ? 'success' : 'error'}>
                        {testResult.ok
                          ? `Connected${testResult.latencyMs != null ? ` (${testResult.latencyMs}ms)` : ''}.`
                          : (testResult.error ?? 'Connection failed.')}
                      </SettingsStatus>
                    ) : null}
                    {syncMessage ? <SettingsStatus ref={syncMessageRef}>{syncMessage}</SettingsStatus> : null}
                    {saveError ? (
                      <SettingsStatus ref={saveErrorRef} tone="error">
                        {saveError}
                      </SettingsStatus>
                    ) : null}
                    {loadError ? <SettingsStatus tone="error">{loadError}</SettingsStatus> : null}
                  </div>
                ) : null
              }
            >
              <Button
                type="button"
                variant="outline"
                disabled={syncing || !config?.enabled}
                onClick={() => void handleSyncNow()}
              >
                {syncing ? 'Starting…' : 'Sync now'}
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
                disabled={!dirty || saving || !hostValid || !portValid}
                onClick={() => void handleSave()}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </SettingsFooter>
          </>
        )}
      </SettingsGroup>

      {webhookUrl && !loading ? (
        <SettingsGroup
          title="Live updates"
          help={
            <>
              <p>
                Paste the URL into BlueBubbles Server under Settings &gt; Webhooks, subscribed to{' '}
                <code>new-message</code> and <code>updated-message</code>. Without it, new messages only
                arrive on the ten-minute backstop poll.
              </p>
              <p>
                The Mac must be able to reach this address. If you are viewing this over a different hostname
                than the Mac would use, substitute that one.
              </p>
            </>
          }
        >
          <SettingsRow
            label="Webhook URL"
            hint="Paste this into BlueBubbles Server under Settings > Webhooks. It contains this appliance's webhook secret, so treat it like a password."
          >
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{webhookUrl}</span>
              <IconButton
                type="button"
                variant="ghost"
                size="icon-sm"
                label="Copy webhook URL"
                onClick={() => void handleCopyWebhookUrl()}
              >
                {webhookCopied ? <Check className="text-teal-700 dark:text-teal-300" /> : <ClipboardCopy />}
              </IconButton>
            </div>
          </SettingsRow>

          <SettingsRow
            label="Replace the URL"
            hint="Do this if the URL was shown to someone who should not have it."
            control={
              <Button
                type="button"
                variant="outline"
                disabled={rotating}
                onClick={() => void handleRotateWebhook()}
              >
                <RefreshCw aria-hidden="true" />
                {rotating ? 'Making a new URL…' : 'Make a new URL'}
              </Button>
            }
          >
            {rotateError ? <SettingsStatus tone="error">{rotateError}</SettingsStatus> : null}
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {config && !loading
        ? statusGroup({
            label: config.connectionStatus,
            lastError: config.lastError,
            lastSyncCursor: config.lastSyncCursor,
            lastWebhookReceivedAt: config.lastWebhookReceivedAt,
          })
        : null}
    </SettingsSection>
  );
}
