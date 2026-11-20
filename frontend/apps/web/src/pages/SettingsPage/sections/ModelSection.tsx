import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Button, Input, Select, Switch } from '@ci/shadcn';
import { Brain, Eye, Wrench } from '@ci/shadcn/icons';

import { ModelSelector } from '@/components/ModelSelector';
import { useCurrentUser, useModel, useSessionAuth } from '@/hooks';
import { useLlmEndpoint, type LlmBackendKind, type LlmEndpointConfig } from '@/hooks/useLlmEndpoint';

import {
  SettingsFooter,
  SettingsGroup,
  SettingsHint,
  SettingsLoading,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from '../kit';

import { RecommendedModelCard } from './RecommendedModelCard';

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
    {
      selectedModel,
      chatModelRevision,
      chatModelSaving,
      thinkingSupported,
      thinkingEnabled,
      toolsSupported,
      toolsEnabled,
      error: modelsError,
    },
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
  // The endpoint the last test ran against. A save replaces `config`, and that result then
  // describes an endpoint this page no longer shows.
  const [testedConfig, setTestedConfig] = useState<LlmEndpointConfig | null>(null);
  const [imageDescriptionEnabled, setImageDescriptionEnabled] = useState(false);
  const [imageDescriptionLoading, setImageDescriptionLoading] = useState(true);
  const [imageDescriptionSaving, setImageDescriptionSaving] = useState(false);
  const [imageDescriptionError, setImageDescriptionError] = useState<string | null>(null);
  const [memoryGovernanceEnabled, setMemoryGovernanceEnabled] = useState(true);
  const [memoryRecencyDecayEnabled, setMemoryRecencyDecayEnabled] = useState(true);
  const [contrastiveDecisionEnabled, setContrastiveDecisionEnabled] = useState(true);
  const [generativeDecisionEnabled, setGenerativeDecisionEnabled] = useState(true);
  const [governanceLoading, setGovernanceLoading] = useState(true);
  const [governanceSaving, setGovernanceSaving] = useState(false);
  const [governanceError, setGovernanceError] = useState<string | null>(null);
  const chatModelRevisionRef = useRef(chatModelRevision);

  useEffect(() => {
    chatModelRevisionRef.current = chatModelRevision;
  }, [chatModelRevision]);

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
    // A message left by an earlier load or save no longer describes what this
    // reload is about to show.
    setImageDescriptionError(null);
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
    // `chatModelRevision`: the setting is per model, so a model switch made on
    // this page has to show the new model's value, not the one loaded on mount.
  }, [headers, ready, chatModelRevision]);

  useEffect(() => {
    if (!ready) {
      setGovernanceLoading(false);

      return;
    }

    let cancelled = false;
    setGovernanceLoading(true);
    void Promise.all([
      fetchJson<{ memoryGovernanceEnabled: boolean; memoryRecencyDecayEnabled: boolean }>(
        '/api/personalization/memory-governance',
        { headers },
      ),
      fetchJson<{ contrastiveDecisionEnabled: boolean; generativeDecisionEnabled: boolean }>(
        '/api/personalization/decision-engine',
        { headers },
      ),
    ])
      .then(([gov, dec]) => {
        if (!cancelled) {
          setMemoryGovernanceEnabled(gov?.memoryGovernanceEnabled !== false);
          setMemoryRecencyDecayEnabled(gov?.memoryRecencyDecayEnabled !== false);
          setContrastiveDecisionEnabled(dec?.contrastiveDecisionEnabled !== false);
          setGenerativeDecisionEnabled(dec?.generativeDecisionEnabled !== false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGovernanceError('Could not load memory governance and decision engine settings.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setGovernanceLoading(false);
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
    setTestedConfig(config);
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
    // A model switch that lands while this save is in flight reloads the switch
    // for the new model; this answer is for the old one and must not overwrite it.
    const revision = chatModelRevisionRef.current;
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

      if (chatModelRevisionRef.current === revision) {
        setImageDescriptionEnabled(payload?.enabled === true);
      }
    } catch {
      if (chatModelRevisionRef.current === revision) {
        setImageDescriptionEnabled(previous);
      }

      setImageDescriptionError('Could not save image-description setting.');
    } finally {
      setImageDescriptionSaving(false);
    }
  };

  const handleMemoryGovernanceUpdate = async (patch: {
    memoryGovernanceEnabled?: boolean;
    memoryRecencyDecayEnabled?: boolean;
  }) => {
    if (!ready) {
      return;
    }

    const prevGov = memoryGovernanceEnabled;
    const prevDecay = memoryRecencyDecayEnabled;
    if (patch.memoryGovernanceEnabled !== undefined) {
      setMemoryGovernanceEnabled(patch.memoryGovernanceEnabled);
    }

    if (patch.memoryRecencyDecayEnabled !== undefined) {
      setMemoryRecencyDecayEnabled(patch.memoryRecencyDecayEnabled);
    }

    setGovernanceSaving(true);
    setGovernanceError(null);

    try {
      const payload = await fetchJson<{
        memoryGovernanceEnabled: boolean;
        memoryRecencyDecayEnabled: boolean;
      }>('/api/personalization/memory-governance', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch),
      });
      setMemoryGovernanceEnabled(payload?.memoryGovernanceEnabled !== false);
      setMemoryRecencyDecayEnabled(payload?.memoryRecencyDecayEnabled !== false);
    } catch {
      setMemoryGovernanceEnabled(prevGov);
      setMemoryRecencyDecayEnabled(prevDecay);
      setGovernanceError('Could not save memory governance setting.');
    } finally {
      setGovernanceSaving(false);
    }
  };

  const handleDecisionEngineUpdate = async (patch: {
    contrastiveDecisionEnabled?: boolean;
    generativeDecisionEnabled?: boolean;
  }) => {
    if (!ready) {
      return;
    }

    const prevContrastive = contrastiveDecisionEnabled;
    const prevGenerative = generativeDecisionEnabled;
    if (patch.contrastiveDecisionEnabled !== undefined) {
      setContrastiveDecisionEnabled(patch.contrastiveDecisionEnabled);
    }

    if (patch.generativeDecisionEnabled !== undefined) {
      setGenerativeDecisionEnabled(patch.generativeDecisionEnabled);
    }

    setGovernanceSaving(true);
    setGovernanceError(null);

    try {
      const payload = await fetchJson<{
        contrastiveDecisionEnabled: boolean;
        generativeDecisionEnabled: boolean;
      }>('/api/personalization/decision-engine', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch),
      });
      setContrastiveDecisionEnabled(payload?.contrastiveDecisionEnabled !== false);
      setGenerativeDecisionEnabled(payload?.generativeDecisionEnabled !== false);
    } catch {
      setContrastiveDecisionEnabled(prevContrastive);
      setGenerativeDecisionEnabled(prevGenerative);
      setGovernanceError('Could not save decision engine setting.');
    } finally {
      setGovernanceSaving(false);
    }
  };

  const modelsUnavailable = modelsError != null;
  const showEndpointForm = config != null && !config.locked;

  // One line at a time, so the newest thing wins: a save or an unsaved edit outranks the last
  // test, whose result was for the endpoint as it stood then.
  const endpointStatus = endpointError ? (
    <SettingsStatus tone="error">{endpointError}</SettingsStatus>
  ) : testing ? (
    <SettingsStatus tone="pending">Testing connection…</SettingsStatus>
  ) : saved ? (
    <SettingsStatus tone="success">Saved</SettingsStatus>
  ) : endpointDirty ? (
    <SettingsStatus>Save changes before testing this endpoint.</SettingsStatus>
  ) : preflight && testedConfig === config ? (
    <SettingsStatus tone={preflight.ok ? 'success' : 'error'}>
      {preflight.message ?? (preflight.ok ? 'Connected.' : 'Connection failed.')}
    </SettingsStatus>
  ) : showEndpointForm && !canEditEndpoint ? (
    <SettingsStatus>Changing the endpoint is reserved for an administrator of this Companion.</SettingsStatus>
  ) : null;

  return (
    <SettingsSection
      title="Model"
      description="Point Companion at your inference server, choose a model and set tool and thinking preferences."
    >
      <SettingsGroup
        title="Inference server"
        help={
          config?.locked
            ? 'Managed by Companion Hub or the host environment. Change it there, then test it here. The check runs from the Memory API container.'
            : 'This appliance stores the connection locally. The check runs from the Memory API container.'
        }
      >
        {endpointLoading ? <SettingsLoading>Loading endpoint settings…</SettingsLoading> : null}

        {!endpointLoading && config ? (
          <SettingsRow
            label="Endpoint"
            hint={config.locked ? 'Managed by Companion Hub or the host environment.' : undefined}
            control={
              <code className="font-mono text-xs break-all text-muted-foreground">{config.endpoint}</code>
            }
          />
        ) : null}

        {!endpointLoading && showEndpointForm ? (
          <>
            <SettingsRow
              label="Backend"
              htmlFor="llm-backend"
              hint={selectedBackend.hint}
              control={
                <Select value={preset} onValueChange={(value) => handleBackendChange(value as BackendPreset)}>
                  <Select.Trigger id="llm-backend" className="w-56">
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
              }
            />

            <SettingsRow
              label="Port"
              htmlFor="llm-port"
              control={
                <Input
                  id="llm-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  placeholder={String(selectedBackend.defaultPort)}
                  className="w-28"
                />
              }
            />

            {backend === 'openai_compatible' && (
              <SettingsRow
                label="API path"
                htmlFor="llm-base-path"
                help={
                  <p>
                    Where the server mounts its OpenAI API: <code>/v1</code> for vLLM, llama.cpp and SGLang,{' '}
                    <code>/api/v1</code> for Lemonade.
                  </p>
                }
                control={
                  <Input
                    id="llm-base-path"
                    value={basePath}
                    onChange={(event) => setBasePath(event.target.value)}
                    placeholder={selectedBackend.defaultBasePath}
                    className="w-40"
                  />
                }
              />
            )}

            {backend === 'openai_compatible' && (
              <SettingsRow
                label="API key"
                htmlFor="llm-api-key"
                meta={<span className="text-xs text-muted-foreground">Optional</span>}
                hint={
                  config.apiKeyConfigured
                    ? 'A credential is already available. It is never shown here; leave this blank to keep it.'
                    : 'Leave blank to use the server default. vLLM often expects a bearer token even locally.'
                }
              >
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
                {config.apiKeyConfigured ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="mt-1 h-auto px-0 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => setClearApiKey((current) => !current)}
                  >
                    {clearApiKey ? 'Keep current API key' : 'Remove appliance-saved API key'}
                  </Button>
                ) : null}
                {clearApiKey ? (
                  <SettingsHint className="text-amber-700 dark:text-amber-300">
                    Saving will remove the key stored by this appliance and fall back to any deployment
                    default.
                  </SettingsHint>
                ) : null}
              </SettingsRow>
            )}
          </>
        ) : null}

        {!endpointLoading && config ? (
          <SettingsFooter status={endpointStatus}>
            <Button
              type="button"
              variant="outline"
              disabled={testing || endpointDirty}
              onClick={() => void handleCheckEndpoint()}
              title={endpointDirty ? 'Save endpoint changes before testing them.' : undefined}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {showEndpointForm ? (
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
            ) : null}
          </SettingsFooter>
        ) : null}

        {!endpointLoading && !config && endpointError ? (
          <SettingsRow>
            <SettingsStatus tone="error">{endpointError}</SettingsStatus>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <RecommendedModelCard endpoint={config} canDownload={canEditEndpoint} onSwitched={refetchModels} />

      <SettingsGroup title="Chat model">
        {modelsUnavailable ? (
          <SettingsRow>
            <SettingsNotice tone="error">
              Couldn&apos;t load the available models. Check that the LLM service is reachable on port {port}{' '}
              and try again.
            </SettingsNotice>
          </SettingsRow>
        ) : (
          <>
            <SettingsRow
              label="Active model"
              help={
                <>
                  <p>Each model reports what it can do:</p>
                  <ul>
                    <li className="flex items-center gap-1.5">
                      <Brain className="size-3.5" aria-hidden="true" /> thinking
                    </li>
                    <li className="flex items-center gap-1.5">
                      <Wrench className="size-3.5" aria-hidden="true" /> tools
                    </li>
                    <li className="flex items-center gap-1.5">
                      <Eye className="size-3.5" aria-hidden="true" /> vision
                    </li>
                  </ul>
                </>
              }
            >
              <ModelSelector triggerClassName="w-full" />
            </SettingsRow>

            <SettingsRow
              label="Tools"
              htmlFor="model-tools"
              hint={
                toolsSupported
                  ? 'Let the model call tools to look things up while answering.'
                  : `${selectedModel ?? 'This model'} does not support tools.`
              }
              control={
                <Switch
                  id="model-tools"
                  checked={toolsEnabled}
                  onCheckedChange={toggleTools}
                  disabled={!toolsSupported}
                />
              }
            />

            <SettingsRow
              label="Thinking"
              htmlFor="model-thinking"
              hint={
                thinkingSupported
                  ? 'Let the model reason step by step before it replies. Slower, usually better.'
                  : `${selectedModel ?? 'This model'} does not support thinking.`
              }
              control={
                <Switch
                  id="model-thinking"
                  checked={thinkingEnabled}
                  onCheckedChange={toggleThinking}
                  disabled={!thinkingSupported}
                />
              }
            />
          </>
        )}

        <SettingsRow
          label="Describe images"
          htmlFor="model-image-description"
          hint="Run vision passes on uploads to write titles and captions."
          help="On by default when your chat model understands images and off when it does not, switching with the model. Turning it on for a model that was off requeues undescribed photos that were skipped or failed earlier."
          control={
            <Switch
              id="model-image-description"
              checked={imageDescriptionEnabled}
              onCheckedChange={(checked) => void handleImageDescriptionToggle(checked)}
              disabled={imageDescriptionLoading || imageDescriptionSaving || chatModelSaving || !ready}
            />
          }
        >
          {imageDescriptionError ? (
            <SettingsStatus tone="error">{imageDescriptionError}</SettingsStatus>
          ) : null}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Memory governance and decision engines"
        help="Control governed fact lifecycle, temporal recency weighting and whether fast Contrastive (System 1) and Generative (System 2) decision engines are active."
      >
        <SettingsRow
          label="Governed memory supersession"
          htmlFor="model-memory-governance"
          hint="Classify distilled memories into typed categories, automatically supersede outdated facts and surface conflicting claims."
          control={
            <Switch
              id="model-memory-governance"
              checked={memoryGovernanceEnabled}
              onCheckedChange={(checked) =>
                void handleMemoryGovernanceUpdate({ memoryGovernanceEnabled: checked })
              }
              disabled={governanceLoading || governanceSaving || !ready}
            />
          }
        />

        <SettingsRow
          label="Temporal recency decay"
          htmlFor="model-memory-recency-decay"
          hint="Apply exponential recency weighting during hybrid recall so current state ranks above stale episodes."
          control={
            <Switch
              id="model-memory-recency-decay"
              checked={memoryRecencyDecayEnabled}
              onCheckedChange={(checked) =>
                void handleMemoryGovernanceUpdate({ memoryRecencyDecayEnabled: checked })
              }
              disabled={governanceLoading || governanceSaving || !ready}
            />
          }
        />

        <SettingsRow
          label="Contrastive fast decisions (System 1)"
          htmlFor="model-contrastive-decision"
          hint="Fast embedding-geometry routing and gating with cached action vectors."
          help="Uses sub-10ms embedding-geometry primitives (Noul, Choice, Score and candidate reranking) with cached action vectors for fast routing and gating."
          control={
            <Switch
              id="model-contrastive-decision"
              checked={contrastiveDecisionEnabled}
              onCheckedChange={(checked) =>
                void handleDecisionEngineUpdate({ contrastiveDecisionEnabled: checked })
              }
              disabled={governanceLoading || governanceSaving || !ready}
            />
          }
        />

        <SettingsRow
          label="Generative LLM decisions (System 2)"
          htmlFor="model-generative-decision"
          hint="Use generative LLM evaluation for deliberate reasoning or as a fallback when contrastive confidence margin is low."
          control={
            <Switch
              id="model-generative-decision"
              checked={generativeDecisionEnabled}
              onCheckedChange={(checked) =>
                void handleDecisionEngineUpdate({ generativeDecisionEnabled: checked })
              }
              disabled={governanceLoading || governanceSaving || !ready}
            />
          }
        />

        {governanceError ? (
          <SettingsRow>
            <SettingsStatus tone="error">{governanceError}</SettingsStatus>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </SettingsSection>
  );
}
