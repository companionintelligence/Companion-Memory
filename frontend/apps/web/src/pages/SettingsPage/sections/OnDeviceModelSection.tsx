import {
  formatModelBytes,
  gpuAllowedOn,
  type LocalLlmCapability,
  type LocalLlmMode,
  type LocalLlmModelState,
} from '@ci/common';
import { Badge, Button, Progress, Select, Switch } from '@ci/shadcn';
import { Download, Trash2 } from '@ci/shadcn/icons';

import { useLocalLlmPrefs, useOnDeviceModel } from '@/hooks/useOnDeviceModel';

import { SettingsGroup, SettingsRow, SettingsSection, SettingsStatus } from '../kit';

const MODE_OPTIONS: { value: LocalLlmMode; label: string; hint: string }[] = [
  {
    value: 'appliance',
    label: 'Always use my Companion',
    hint: 'Chat runs on your Companion server. The on-device model is not used.',
  },
  {
    value: 'auto',
    label: 'Use my Companion, fall back to this phone',
    hint: 'Chat runs on your Companion server; when it cannot be reached, this phone answers instead.',
  },
  {
    value: 'device',
    label: 'Always answer on this phone',
    hint: 'Nothing about your chat leaves the device, and it works with no connection at all.',
  },
];

const CAPABILITY_LABEL: Record<LocalLlmCapability, string> = {
  thinking: 'Reasoning',
  vision: 'Photos',
  tools: 'Memory lookup',
};

function percent(bytes: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
}

/**
 * Settings → On-device model: download a language model to this phone, load it, and choose when chat
 * uses it. The engine is Google's LiteRT-LM — the same runtime as Google AI Edge Gallery — and the
 * catalog is the ungated subset of Gallery's allowlist.
 */
export function OnDeviceModelSection() {
  const [{ probe, progress, busyModelId, error }, actions] = useOnDeviceModel();
  const [prefs, setPrefs] = useLocalLlmPrefs();

  if (!probe) {
    return <SettingsSection title="On-device model" description="Checking this device…" />;
  }

  if (!probe.supported) {
    return (
      <SettingsSection
        title="On-device model"
        description={probe.availability.reason ?? 'On-device models run in the iOS and Android apps.'}
      />
    );
  }

  const selected = probe.models.find((model) => model.spec.modelId === prefs.modelId);

  // The GPU is withheld on a phone under the model's GPU floor; the native side enforces it, this mirrors it.

  const gpuAllowed = selected ? gpuAllowedOn(selected.spec, probe.availability.totalMemoryBytes) : false;
  const selectedReady = selected?.status.status === 'ready';
  const loadedSelected = probe.loaded.loaded && probe.loaded.modelId === prefs.modelId;
  const activeMode = MODE_OPTIONS.find((option) => option.value === prefs.mode) ?? MODE_OPTIONS[0];

  // Accelerator / thinking changes only take effect on a fresh load, so reload a resident model.
  const reloadIfLoaded = async () => {
    if (loadedSelected && prefs.modelId) {
      await actions.unload();
      await actions.use(prefs.modelId);
    }
  };

  return (
    <SettingsSection
      title="On-device model"
      description="A small language model that runs entirely on this phone, with no connection needed."
      help="Nothing you type leaves the device. It is smaller than the model on your Companion, so answers are simpler. Models download once from Hugging Face."
    >
      <SettingsGroup>
        <SettingsRow
          label="When to use it"
          htmlFor="on-device-mode"
          hint={
            selectedReady
              ? activeMode.hint
              : 'Download a model below and choose “Use this model” to turn this on.'
          }
        >
          <Select
            value={prefs.mode}
            onValueChange={(value) => setPrefs({ mode: value as LocalLlmMode })}
            disabled={!selectedReady && prefs.mode === 'appliance'}
          >
            <Select.Trigger id="on-device-mode" className="w-full">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {MODE_OPTIONS.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.value !== 'appliance' && !selectedReady}
                >
                  {option.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </SettingsRow>

        {probe.loaded.loaded ? (
          <SettingsRow
            label="Loaded model"
            hint={
              <span role="status">
                {probe.models.find((model) => model.spec.modelId === probe.loaded.modelId)?.spec.label ??
                  'A model'}{' '}
                is loaded{probe.loaded.accelerator ? ` on the ${probe.loaded.accelerator.toUpperCase()}` : ''}.
              </span>
            }
            control={
              <Button type="button" variant="outline" onClick={() => void actions.unload()}>
                Unload to free memory
              </Button>
            }
          />
        ) : null}

        {error ? (
          <SettingsRow>
            <SettingsStatus tone="error">{error}</SettingsStatus>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title="Models"
        description={
          probe.availability.totalMemoryBytes
            ? `This device has ${formatModelBytes(probe.availability.totalMemoryBytes)} of memory. Larger models need more.`
            : 'Larger models need more memory.'
        }
      >
        {probe.models.map((model) => (
          <ModelRow
            key={model.spec.modelId}
            model={model}
            live={progress[model.spec.modelId]}
            selected={prefs.modelId === model.spec.modelId}
            loaded={probe.loaded.loaded && probe.loaded.modelId === model.spec.modelId}
            busy={busyModelId === model.spec.modelId}
            onDownload={() => void actions.download(model.spec.modelId)}
            onCancel={() => void actions.cancelDownload(model.spec.modelId)}
            onDelete={() => void actions.remove(model.spec.modelId)}
            onUse={() => void actions.use(model.spec.modelId)}
          />
        ))}
      </SettingsGroup>

      {selected && selectedReady ? (
        <SettingsGroup title={`${selected.spec.label} settings`}>
          {selected.spec.accelerators.length > 1 ? (
            <SettingsRow
              label="Run on"
              htmlFor="on-device-accelerator"
              hint={
                gpuAllowed
                  ? 'If the GPU cannot start this model, it falls back to the CPU on its own.'
                  : `This phone has ${formatModelBytes(probe.availability.totalMemoryBytes ?? 0)} of memory; ${selected.spec.label} needs at least ${formatModelBytes(selected.spec.gpuMinDeviceMemoryBytes)} to run on the GPU, so it runs on the CPU.`
              }
            >
              <Select
                value={gpuAllowed ? (prefs.accelerator ?? selected.spec.accelerators[0]) : 'cpu'}
                onValueChange={(value) => {
                  setPrefs({ accelerator: value as 'cpu' | 'gpu' });
                  queueMicrotask(() => void reloadIfLoaded());
                }}
              >
                <Select.Trigger id="on-device-accelerator" className="w-full">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {selected.spec.accelerators.map((accelerator) => (
                    <Select.Item
                      key={accelerator}
                      value={accelerator}
                      disabled={accelerator === 'gpu' && !gpuAllowed}
                    >
                      {accelerator === 'gpu'
                        ? gpuAllowed
                          ? 'GPU (faster, but can garble numbers and dates from your memory)'
                          : `GPU (needs a ${formatModelBytes(selected.spec.gpuMinDeviceMemoryBytes)} phone)`
                        : 'CPU (slower, reads your memory exactly)'}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </SettingsRow>
          ) : null}

          {selected.spec.capabilities.includes('thinking') ? (
            <SettingsRow
              label="Think before answering"
              htmlFor="on-device-thinking"
              hint="Lets the model reason step by step first. Better on hard questions, noticeably slower."
              control={
                <Switch
                  id="on-device-thinking"
                  checked={prefs.thinking}
                  onCheckedChange={(checked) => setPrefs({ thinking: checked })}
                />
              }
            />
          ) : null}

          {selected.spec.capabilities.includes('tools') ? (
            <SettingsRow
              label="Look things up in Memory"
              htmlFor="on-device-tools"
              hint="When your Companion is reachable, the model can search your memory to answer instead of guessing. Offline, it answers without."
              control={
                <Switch
                  id="on-device-tools"
                  checked={prefs.intentTools}
                  onCheckedChange={(checked) => {
                    setPrefs({ intentTools: checked });
                    queueMicrotask(() => void reloadIfLoaded());
                  }}
                />
              }
            />
          ) : null}
        </SettingsGroup>
      ) : null}
    </SettingsSection>
  );
}

interface ModelRowProps {
  model: LocalLlmModelState;
  live?: { bytesDownloaded: number; totalBytes: number };
  selected: boolean;
  loaded: boolean;
  busy: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onUse: () => void;
}

function ModelRow({
  model,
  live,
  selected,
  loaded,
  busy,
  onDownload,
  onCancel,
  onDelete,
  onUse,
}: ModelRowProps) {
  const { spec, status, fit } = model;
  const downloading = status.status === 'downloading' || Boolean(live);
  const bytes = live?.bytesDownloaded ?? status.bytesDownloaded ?? 0;
  const total = live?.totalBytes ?? status.totalBytes ?? spec.sizeBytes;
  const ready = status.status === 'ready';

  return (
    <div
      data-slot="settings-row"
      className="flex flex-col gap-3 px-5 py-4"
      data-testid={`on-device-model-${spec.modelId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm leading-5 font-medium">{spec.label}</h4>
            <span className="text-muted-foreground text-xs">{formatModelBytes(spec.sizeBytes)}</span>
            {selected ? <Badge variant="secondary">{loaded ? 'In use' : 'Selected'}</Badge> : null}
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">{spec.description}</p>
          {spec.capabilities.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-1">
              {spec.capabilities.map((capability) => (
                <Badge key={capability} variant="outline">
                  {CAPABILITY_LABEL[capability]}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {downloading ? (
        <div className="flex flex-col gap-2">
          <Progress value={percent(bytes, total)} aria-label={`Downloading ${spec.label}`} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              {formatModelBytes(bytes)} of {formatModelBytes(total)}
            </span>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : ready ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={onUse} disabled={busy || loaded}>
            {busy ? 'Loading…' : loaded ? 'Loaded' : selected ? 'Load this model' : 'Use this model'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Delete ${spec.label}`}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {status.status === 'error' && status.error ? (
            <p role="alert" className="text-destructive text-xs">
              {status.error}
            </p>
          ) : null}
          {fit.ok ? (
            <Button type="button" className="w-fit" onClick={onDownload} disabled={busy}>
              <Download className="h-4 w-4" />
              {status.status === 'error' ? 'Retry download' : `Download ${formatModelBytes(spec.sizeBytes)}`}
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">{fit.reason}</p>
          )}
        </div>
      )}
    </div>
  );
}
