import { useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Button, Card, Input, Label, Select, Switch } from '@ci/shadcn';
import { Brain, Eye, Server, Wrench } from '@ci/shadcn/icons';

import { ModelSelector } from '@/components/ModelSelector';
import { useCurrentUser, useModel, useSessionAuth } from '@/hooks';
import { useLlmEndpoint, type LlmBackendKind } from '@/hooks/useLlmEndpoint';

type BackendPreset = 'ollama' | 'lemonade' | 'openai_compatible';

/**
 * What the Backend picker offers. Two of the three are the same wire protocol (`openai_compatible`)
 * with different defaults: Lemonade mounts its OpenAI routes at `/api/v1` on 13305, everything else
 * at `/v1`. The path is editable below the port, so a server that mounts elsewhere still fits.
 */
const BACKEND_OPTIONS: {
  value: BackendPreset;
  backend: LlmBackendKind;
  label: string;
  defaultPort: number;
  defaultBasePath: string;
  hint: string;
}[] = [
  {
    value: 'ollama',
    backend: 'ollama',
    label: 'Ollama',
    defaultPort: 11434,
    defaultBasePath: '/v1',
    hint: 'Native Ollama API on the host.',
  },
  {
    value: 'lemonade',
    backend: 'openai_compatible',
    label: 'Lemonade',
    defaultPort: 13305,
    defaultBasePath: '/api/v1',
    hint: 'Lemonade Server on the host (llama.cpp underneath), through its OpenAI-compatible API.',
  },
  {
    value: 'openai_compatible',
    backend: 'openai_compatible',
    label: 'OpenAI-compatible (vLLM, llama.cpp, SGLang)',
    defaultPort: 8000,
    defaultBasePath: '/v1',
    hint: 'Any server that speaks the OpenAI chat API.',
  },
];

/** The preset a saved endpoint came from, by its defaults; the generic one when none match. */
function presetFor(config: { backend: LlmBackendKind; port: number; basePath?: string }): BackendPreset {
  if (config.backend === 'ollama') {
    return 'ollama';
  }

  const match = BACKEND_OPTIONS.find(
    (option) =>
      option.backend === 'openai_compatible' &&
      option.value !== 'openai_compatible' &&
      option.defaultPort === config.port &&
      option.defaultBasePath === (config.basePath ?? '/v1'),
  );

  return match?.value ?? 'openai_compatible';
}

/**
 * Account-level LLM settings: inference endpoint, active model, and tool/thinking toggles.
 */
export function ModelSection() {
  const { ready, headers } = useSessionAuth();
  const [
    { selectedModel, thinkingSupported, thinkingEnabled, toolsSupported, toolsEnabled, error: modelsError },
    { toggleThinking, toggleTools, refetch: refetchModels },
  ] = useModel();

  const {
    config,
    loading: endpointLoading,
    saving,
    testing,
    error: endpointError,
    preflight,
    saveEndpoint,
    checkEndpoint,
  } = useLlmEndpoint();

  // Repointing the appliance's one inference endpoint is an administrator's decision; the server
  // refuses it for anyone else (ApplianceAdminGuard), so don't offer a button that will 403.
  const { user: currentUser } = useCurrentUser();
  const canEditEndpoint = currentUser?.isAdmin ?? false;

  const [preset, setPreset] = useState<BackendPreset>('ollama');
  const [port, setPort] = useState('11434');
  const [basePath, setBasePath] = useState('/v1');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [imageDescriptionEnabled, setImageDescriptionEnabled] = useState(false);
  const [imageDescriptionLoading, setImageDescriptionLoading] = useState(true);
  const [imageDescriptionSaving, setImageDescriptionSaving] = useState(false);
  const [imageDescriptionError, setImageDescriptionError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) {
      return;
    }

    setPreset(presetFor(config));
    setPort(String(config.port));
    setBasePath(config.basePath ?? '/v1');
    // Keys are write-only. An empty field means "keep the saved key", never
    // "the browser received no key" — the server never sends one back.
    setApiKey('');
    setClearApiKey(false);
  }, [config]);

  useEffect(() => {
    if (!ready) {
      setImageDescriptionLoading(false);

      return;
    }

    let cancelled = false;
    setImageDescriptionLoading(true);
    void fetchJson<{ enabled: boolean }>('/api/personalization/image-description', {
      headers,
    })
      .then((payload) => {
        if (!cancelled) {
          setImageDescriptionEnabled(payload?.enabled === true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImageDescriptionError('Could not load image-description setting.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setImageDescriptionLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [headers, ready]);

  const selectedBackend = useMemo(
    () => BACKEND_OPTIONS.find((option) => option.value === preset) ?? BACKEND_OPTIONS[0],
    [preset],
  );
  const backend = selectedBackend.backend;

  const endpointDirty =
    config != null &&
    !config.locked &&
    (backend !== config.backend ||
      port !== String(config.port) ||
      (backend === 'openai_compatible' && basePath.trim() !== (config.basePath ?? '/v1')) ||
      apiKey.trim().length > 0 ||
      clearApiKey);

  const handleBackendChange = (value: BackendPreset) => {
    setPreset(value);
    const option = BACKEND_OPTIONS.find((item) => item.value === value);

    if (option) {
      setPort(String(option.defaultPort));
      setBasePath(option.defaultBasePath);
    }
  };

  const handleSaveEndpoint = async () => {
    const parsedPort = Number.parseInt(port, 10);

    if (!Number.isFinite(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      return;
    }

    const savedConfig = await saveEndpoint({
      backend,
      port: parsedPort,
      ...(backend === 'openai_compatible' && basePath.trim() ? { basePath: basePath.trim() } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
    });

    if (savedConfig) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
      refetchModels();
    }
  };

  const handleCheckEndpoint = async () => {
    const result = await checkEndpoint();

    if (result?.ok) {
      refetchModels();
    }
  };

  const handleImageDescriptionToggle = async (enabled: boolean) => {
    if (!ready) {
      return;
    }

    const previous = imageDescriptionEnabled;
    setImageDescriptionEnabled(enabled);
    setImageDescriptionSaving(true);
    setImageDescriptionError(null);

    try {
      const payload = await fetchJson<{ enabled: boolean }>('/api/personalization/image-description', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled }),
      });
      setImageDescriptionEnabled(payload?.enabled === true);
    } catch {
      setImageDescriptionEnabled(previous);
      setImageDescriptionError('Could not save image-description setting.');
    } finally {
      setImageDescriptionSaving(false);
    }
  };

  const modelsUnavailable = modelsError != null;
  const showEndpointForm = config != null && !config.locked;

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Model</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Point Companion at your inference server, choose a model, and set tool/thinking preferences.
        </p>
      </div>

      <Card className="mb-6">
        <Card.Content className="space-y-5 pt-6">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-700 dark:text-teal-300">
              <Server className="h-4 w-4" />
            </div>
            <div className="space-y-1 min-w-0">
              <h3 className="text-base font-semibold text-foreground">Inference server</h3>
              <p className="text-sm text-muted-foreground leading-snug">
                {config?.locked
                  ? 'Managed by Companion Hub or the host environment. Change it there, then test it here.'
                  : 'This appliance stores the connection locally. The check runs from the Memory API container.'}
              </p>
              {config ? (
                <code className="block break-all pt-1 text-xs text-muted-foreground">{config.endpoint}</code>
              ) : null}
            </div>
          </div>

          {endpointLoading ? (
            <p className="text-sm text-muted-foreground">Loading endpoint settings…</p>
          ) : showEndpointForm ? (
            <div className="space-y-4 border-t border-border pt-4">
              <div className="grid gap-2">
                <Label htmlFor="llm-backend">Backend</Label>
                <Select value={preset} onValueChange={(value) => handleBackendChange(value as BackendPreset)}>
                  <Select.Trigger id="llm-backend" className="w-full">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {BACKEND_OPTIONS.map((option) => (
                      <Select.Item key={option.value} value={option.value}>
                        {option.label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
                <p className="text-xs text-muted-foreground">{selectedBackend.hint}</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="llm-port">Port</Label>
                <Input
                  id="llm-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  placeholder={String(selectedBackend.defaultPort)}
                />
              </div>

              {backend === 'openai_compatible' && (
                <div className="grid gap-2">
                  <Label htmlFor="llm-base-path">API path</Label>
                  <Input
                    id="llm-base-path"
                    value={basePath}
                    onChange={(event) => setBasePath(event.target.value)}
                    placeholder={selectedBackend.defaultBasePath}
                  />
                  <p className="text-xs text-muted-foreground">
                    Where the server mounts its OpenAI API: <code>/v1</code> for vLLM, llama.cpp and SGLang,{' '}
                    <code>/api/v1</code> for Lemonade.
                  </p>
                </div>
              )}

              {backend === 'openai_compatible' && (
                <div className="grid gap-2">
                  <Label htmlFor="llm-api-key">API key (optional)</Label>
                  <Input
                    id="llm-api-key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setClearApiKey(false);
                    }}
                    placeholder={config.apiKeyConfigured ? 'Replace saved API key' : 'Optional API key'}
                    disabled={clearApiKey}
                  />
                  <p className="text-xs text-muted-foreground">
                    {config.apiKeyConfigured
                      ? 'A credential is already available. It is never shown here; leave this blank to keep it.'
                      : 'Leave blank to use the server default. vLLM often expects a bearer token even locally.'}
                  </p>
                  {config.apiKeyConfigured ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-fit px-0 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => setClearApiKey((current) => !current)}
                    >
                      {clearApiKey ? 'Keep current API key' : 'Remove appliance-saved API key'}
                    </Button>
                  ) : null}
                  {clearApiKey ? (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Saving will remove the key stored by this appliance and fall back to any deployment
                      default.
                    </p>
                  ) : null}
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  disabled={!endpointDirty || saving || !canEditEndpoint}
                  onClick={() => void handleSaveEndpoint()}
                  title={
                    canEditEndpoint ? undefined : 'Only an administrator can change the inference endpoint.'
                  }
                >
                  {saving ? 'Saving…' : 'Save endpoint'}
                </Button>
                {saved && <span className="text-sm text-teal-700 dark:text-teal-300">Saved</span>}
                {!canEditEndpoint && (
                  <span className="text-muted-foreground text-sm">
                    Changing the endpoint is reserved for an administrator of this Companion.
                  </span>
                )}
              </div>
            </div>
          ) : null}

          {!endpointLoading && config ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={testing || endpointDirty}
                onClick={() => void handleCheckEndpoint()}
                title={endpointDirty ? 'Save endpoint changes before testing them.' : undefined}
              >
                {testing ? 'Testing connection…' : 'Test connection'}
              </Button>
              {endpointDirty ? (
                <span className="text-xs text-muted-foreground">
                  Save changes before testing this endpoint.
                </span>
              ) : null}
              {preflight ? (
                <p
                  role="status"
                  className={
                    preflight.ok ? 'text-sm text-teal-700 dark:text-teal-300' : 'text-sm text-destructive'
                  }
                >
                  {preflight.message ?? (preflight.ok ? 'Connected.' : 'Connection failed.')}
                </p>
              ) : null}
            </div>
          ) : null}

          {endpointError ? <p className="text-sm text-destructive">{endpointError}</p> : null}
        </Card.Content>
      </Card>

      <Card>
        <Card.Content className="space-y-6 pt-6">
          {modelsUnavailable ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t load the available models. Check that the LLM service is reachable on port {port}{' '}
              and try again.
            </p>
          ) : (
            <>
              <div className="grid gap-2">
                <Label>Active model</Label>

                <ModelSelector triggerClassName="w-full" />

                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Brain className="size-3.5" /> thinking
                  </span>
                  <span className="flex items-center gap-1">
                    <Wrench className="size-3.5" /> tools
                  </span>
                  <span className="flex items-center gap-1">
                    <Eye className="size-3.5" /> vision
                  </span>
                  <span>— capabilities each model reports.</span>
                </p>
              </div>

              <div className="space-y-4 border-t border-border pt-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="model-tools" className="flex items-center gap-2">
                      <Wrench className="h-4 w-4" />
                      Tools
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {toolsSupported
                        ? 'Let the model call tools to look things up while answering.'
                        : `${selectedModel ?? 'This model'} does not support tools.`}
                    </p>
                  </div>

                  <Switch
                    id="model-tools"
                    checked={toolsEnabled}
                    onCheckedChange={toggleTools}
                    disabled={!toolsSupported}
                  />
                </div>

                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="model-thinking" className="flex items-center gap-2">
                      <Brain className="h-4 w-4" />
                      Thinking
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {thinkingSupported
                        ? 'Let the model reason step by step before it replies. Slower, usually better.'
                        : `${selectedModel ?? 'This model'} does not support thinking.`}
                    </p>
                  </div>

                  <Switch
                    id="model-thinking"
                    checked={thinkingEnabled}
                    onCheckedChange={toggleThinking}
                    disabled={!thinkingSupported}
                  />
                </div>
              </div>
            </>
          )}

          <div className="space-y-4 border-t border-border pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="model-image-description" className="flex items-center gap-2">
                  <Eye className="h-4 w-4" />
                  Describe images
                </Label>
                <p className="text-xs text-muted-foreground">
                  Run vision passes on uploads (titles and captions). On by default when your chat model
                  understands images, off when it does not — this switches with it. Turning it on for a model
                  that was off requeues undescribed photos that were skipped or failed earlier.
                </p>
              </div>

              <Switch
                id="model-image-description"
                checked={imageDescriptionEnabled}
                onCheckedChange={(checked) => void handleImageDescriptionToggle(checked)}
                disabled={imageDescriptionLoading || imageDescriptionSaving || !ready}
              />
            </div>

            {imageDescriptionError ? (
              <p className="text-sm text-destructive">{imageDescriptionError}</p>
            ) : null}
          </div>
        </Card.Content>
      </Card>
    </>
  );
}
