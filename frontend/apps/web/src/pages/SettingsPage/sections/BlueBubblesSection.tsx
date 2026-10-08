import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson, getWebOrigin } from '@ci/common';
import { Button, Card, Checkbox, Input, Label, Switch } from '@ci/shadcn';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ClipboardCopy,
  Clock,
  MessageSquare,
  Pencil,
  RefreshCw,
} from '@ci/shadcn/icons';

import { useSessionAuth } from '@/hooks';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

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

  try {
    return fmt.dateTime(value);
  } catch {
    return value;
  }
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
        return <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 flex-shrink-0" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-500 flex-shrink-0" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    }
  };

  const heading = (
    <div className="mb-6">
      <h2 className="text-xl font-semibold">BlueBubbles</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Connect a BlueBubbles server to bring iMessage/SMS history in, keep it in sync, and let the assistant
        send and read messages on your behalf.
      </p>
    </div>
  );

  // Not an administrator: the server sent on/off and activity times only. The connection belongs
  // to the account an administrator set it up for, and only that account's assistant can read or
  // send messages through it.
  if (!loading && !isAdmin) {
    return (
      <>
        {heading}
        <Card className="mb-6">
          <Card.Content className="space-y-3 pt-6">
            <h3 className="text-base font-semibold text-foreground">Connection</h3>
            <p className="text-sm text-muted-foreground leading-snug">
              An administrator of this Companion sets up BlueBubbles, for their own Mac. The assistant&apos;s
              messaging tools work only for the account it was set up for.
            </p>
            {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
          </Card.Content>
        </Card>

        {status ? (
          <Card>
            <Card.Content className="space-y-3 pt-6">
              <h3 className="text-base font-semibold text-foreground">Status</h3>
              <div className="flex items-center gap-2 text-sm">
                {statusIcon()}
                <span className="capitalize">{status.enabled ? status.connectionStatus : 'off'}</span>
              </div>
              <dl className="grid gap-1 text-sm text-muted-foreground">
                <div className="flex justify-between gap-4">
                  <dt>Last sync</dt>
                  <dd>{formatTimestamp(status.lastSyncCursor, fmt)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Last webhook received</dt>
                  <dd>{formatTimestamp(status.lastWebhookReceivedAt, fmt)}</dd>
                </div>
              </dl>
            </Card.Content>
          </Card>
        ) : null}
      </>
    );
  }

  return (
    <>
      {heading}

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
                  ref={testResultRef}
                  className={`text-sm ${testResult.ok ? 'text-teal-700 dark:text-teal-300' : 'text-destructive'}`}
                >
                  {testResult.ok
                    ? `Connected${testResult.latencyMs != null ? ` (${testResult.latencyMs}ms)` : ''}.`
                    : (testResult.error ?? 'Connection failed.')}
                </p>
              ) : null}

              {syncMessage ? (
                <p ref={syncMessageRef} className="text-sm text-muted-foreground">
                  {syncMessage}
                </p>
              ) : null}
              {saveError ? (
                <p ref={saveErrorRef} className="text-sm text-destructive">
                  {saveError}
                </p>
              ) : null}
              {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
            </div>
          )}
        </Card.Content>
      </Card>

      {webhookUrl && !loading ? (
        <Card className="mb-6">
          <Card.Content className="space-y-3 pt-6">
            <h3 className="text-base font-semibold text-foreground">Live updates</h3>
            <p className="text-sm text-muted-foreground leading-snug">
              Paste this into BlueBubbles Server under Settings → Webhooks, subscribed to{' '}
              <span className="font-mono">new-message</span> and{' '}
              <span className="font-mono">updated-message</span>. Without it, new messages only arrive on the
              ten-minute backstop poll.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{webhookUrl}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Copy webhook URL"
                onClick={() => void handleCopyWebhookUrl()}
              >
                {webhookCopied ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <ClipboardCopy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The URL contains this appliance&apos;s webhook secret — treat it like a password. The Mac must
              be able to reach this address; if you are viewing this over a different hostname than the Mac
              would use, substitute that one.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rotating}
                onClick={() => void handleRotateWebhook()}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {rotating ? 'Making a new URL…' : 'Make a new URL'}
              </Button>
              <span className="text-xs text-muted-foreground">
                Do this if the URL was shown to someone who should not have it.
              </span>
            </div>
            {rotateError ? <p className="text-sm text-destructive">{rotateError}</p> : null}
          </Card.Content>
        </Card>
      ) : null}

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
                <dd>{formatTimestamp(config.lastSyncCursor, fmt)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Last webhook received</dt>
                <dd>{formatTimestamp(config.lastWebhookReceivedAt, fmt)}</dd>
              </div>
            </dl>
          </Card.Content>
        </Card>
      ) : null}
    </>
  );
}
