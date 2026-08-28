import { useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Button, Card, Input, Label, Select, Switch } from '@ci/shadcn';
import { Brain, Eye, Server, Wrench } from '@ci/shadcn/icons';

import { ModelSelector } from '@/components/ModelSelector';
import { useModel, useSessionAuth } from '@/hooks';
import { useLlmEndpoint, type LlmBackendKind } from '@/hooks/useLlmEndpoint';

const BACKEND_OPTIONS: { value: LlmBackendKind; label: string; defaultPort: number; hint: string }[] = [
  {
    value: 'ollama',
    label: 'Ollama',
    defaultPort: 11434,
    hint: 'Native Ollama API on the host.',
  },
  {
    value: 'openai_compatible',
    label: 'OpenAI-compatible (vLLM)',
    defaultPort: 8000,
    hint: 'Any OpenAI-compatible server, including vLLM.',
  },
];

/**
 * Account-level LLM settings: inference endpoint, active model, and tool/thinking toggles.
 */
export function ModelSection() {
  const { ready, headers } = useSessionAuth();
  const [
    { selectedModel, thinkingSupported, thinkingEnabled, toolsSupported, toolsEnabled, error: modelsError },
    { toggleThinking, toggleTools, refetch: refetchModels },
  ] = useModel();

  const { config, loading: endpointLoading, saving, error: endpointError, saveEndpoint } = useLlmEndpoint();

  const [backend, setBackend] = useState<LlmBackendKind>('ollama');
  const [port, setPort] = useState('11434');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [imageDescriptionEnabled, setImageDescriptionEnabled] = useState(false);
  const [imageDescriptionLoading, setImageDescriptionLoading] = useState(true);
  const [imageDescriptionSaving, setImageDescriptionSaving] = useState(false);
  const [imageDescriptionError, setImageDescriptionError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) {
      return;
    }

    setBackend(config.backend);
    setPort(String(config.port));
    setApiKey(config.apiKey ?? '');
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
    () => BACKEND_OPTIONS.find((option) => option.value === backend) ?? BACKEND_OPTIONS[0],
    [backend],
  );

  const endpointDirty =
    config != null &&
    !config.locked &&
    (backend !== config.backend || port !== String(config.port) || apiKey !== (config.apiKey ?? ''));

  const handleBackendChange = (value: LlmBackendKind) => {
    setBackend(value);
    const option = BACKEND_OPTIONS.find((item) => item.value === value);

    if (option) {
      setPort(String(option.defaultPort));
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
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });

    if (savedConfig) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
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
                  ? `Managed by the host environment (${config.hostGateway}:${config.port}).`
                  : `Reachable from the API via ${config?.hostGateway ?? 'host.docker.internal'}.`}
              </p>
            </div>
          </div>

          {endpointLoading ? (
            <p className="text-sm text-muted-foreground">Loading endpoint settings…</p>
          ) : showEndpointForm ? (
            <div className="space-y-4 border-t border-border pt-4">
              <div className="grid gap-2">
                <Label htmlFor="llm-backend">Backend</Label>
                <Select
                  value={backend}
                  onValueChange={(value) => handleBackendChange(value as LlmBackendKind)}
                >
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
                  <Label htmlFor="llm-api-key">API key (optional)</Label>
                  <Input
                    id="llm-api-key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="vllm-local"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank to use the server default. vLLM often expects a bearer token even locally.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  disabled={!endpointDirty || saving}
                  onClick={() => void handleSaveEndpoint()}
                >
                  {saving ? 'Saving…' : 'Save endpoint'}
                </Button>
                {saved && <span className="text-sm text-teal-700 dark:text-teal-300">Saved</span>}
              </div>
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
                  Run vision passes on uploads (titles and captions). Keep this off unless a loaded model
                  actually understands images. Turning it on requeues undescribed photos that were skipped or
                  failed earlier.
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
