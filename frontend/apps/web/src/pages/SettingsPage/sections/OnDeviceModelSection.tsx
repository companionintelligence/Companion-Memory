import {
  formatBytes,
  gpuAllowedOn,
  type LocalLlmCapability,
  type LocalLlmMode,
  type LocalLlmModelState,
} from '@ci/common';
import { Badge, Button, Card, Label, Progress, Select, Switch } from '@ci/shadcn';
import { Download, Smartphone, Trash2 } from '@ci/shadcn/icons';

import { useLocalLlmPrefs, useOnDeviceModel } from '@/hooks/useOnDeviceModel';

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
    return <p className="text-muted-foreground text-sm">Checking this device…</p>;
  }

  if (!probe.supported) {
    return (
      <Card>
        <Card.Header>
          <Card.Title>On-device model</Card.Title>
          <Card.Description>
            {probe.availability.reason ?? 'On-device models run in the iOS and Android apps.'}
          </Card.Description>
        </Card.Header>
      </Card>
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
    <div className="flex flex-col gap-4">
      <Card>
        <Card.Header>
          <div className="flex items-start gap-3">
            <div className="bg-muted text-muted-foreground mt-0.5 rounded-md p-2">
              <Smartphone className="h-4 w-4" />
            </div>
            <div className="min-w-0 space-y-1">
              <Card.Title>On-device model</Card.Title>
              <Card.Description>
                A small language model that runs entirely on this phone — no connection needed, and nothing
                you type leaves the device. It is smaller than the model on your Companion, so answers are
                simpler. Models download once from Hugging Face.
              </Card.Description>
            </div>
          </div>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="on-device-mode">When to use it</Label>
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
            <p className="text-muted-foreground text-xs">
              {selectedReady
                ? activeMode.hint
                : 'Download a model below and choose “Use this model” to turn this on.'}
            </p>
          </div>

          {probe.loaded.loaded ? (
            <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <p className="text-sm" role="status">
                <span className="font-medium">
                  {probe.models.find((model) => model.spec.modelId === probe.loaded.modelId)?.spec.label ??
                    'A model'}
                </span>{' '}
                <span className="text-muted-foreground">
                  is loaded
                  {probe.loaded.accelerator ? ` on the ${probe.loaded.accelerator.toUpperCase()}` : ''}.
                </span>
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void actions.unload()}>
                Unload to free memory
              </Button>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Models</Card.Title>
          <Card.Description>
            {probe.availability.totalMemoryBytes
              ? `This device has ${formatBytes(probe.availability.totalMemoryBytes)} of memory. Larger models need more.`
              : 'Larger models need more memory.'}
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
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
        </Card.Content>
      </Card>

      {selected && selectedReady ? (
        <Card>
          <Card.Header>
            <Card.Title>{selected.spec.label} settings</Card.Title>
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            {selected.spec.accelerators.length > 1 ? (
              <div className="grid gap-2">
                <Label htmlFor="on-device-accelerator">Run on</Label>
                <Select
                  value={gpuAllowed ? (prefs.accelerator ?? selected.spec.accelerators[0]) : 'cpu'}
                  onValueChange={(value) => {
                    setPrefs({ accelerator: value as 'cpu' | 'gpu' });
                    // The next render sees the new pref; reload picks it up from storage.
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
                            : `GPU (needs a ${formatBytes(selected.spec.gpuMinDeviceMemoryBytes)} phone)`
                          : 'CPU (slower, reads your memory exactly)'}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {gpuAllowed
                    ? 'If the GPU cannot start this model, it falls back to the CPU on its own.'
                    : `This phone has ${formatBytes(probe.availability.totalMemoryBytes ?? 0)} of memory; ${selected.spec.label} needs at least ${formatBytes(selected.spec.gpuMinDeviceMemoryBytes)} to run on the GPU, so it runs on the CPU.`}
                </p>
              </div>
            ) : null}

            {selected.spec.capabilities.includes('thinking') ? (
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="on-device-thinking">Think before answering</Label>
                  <p className="text-muted-foreground text-xs">
                    Lets the model reason step by step first. Better on hard questions, noticeably slower.
                  </p>
                </div>
                <Switch
                  id="on-device-thinking"
                  checked={prefs.thinking}
                  onCheckedChange={(checked) => setPrefs({ thinking: checked })}
                />
              </div>
            ) : null}

            {selected.spec.capabilities.includes('tools') ? (
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="on-device-tools">Look things up in Memory</Label>
                  <p className="text-muted-foreground text-xs">
                    When your Companion is reachable, the model can search your memory to answer instead of
                    guessing. Offline, it answers without.
                  </p>
                </div>
                <Switch
                  id="on-device-tools"
                  checked={prefs.intentTools}
                  onCheckedChange={(checked) => {
                    setPrefs({ intentTools: checked });
                    queueMicrotask(() => void reloadIfLoaded());
                  }}
                />
              </div>
            ) : null}
          </Card.Content>
        </Card>
      ) : null}
    </div>
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
      className="border-border flex flex-col gap-3 rounded-md border p-3"
      data-testid={`on-device-model-${spec.modelId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">{spec.label}</h4>
            <span className="text-muted-foreground text-xs">{formatBytes(spec.sizeBytes)}</span>
            {selected ? <Badge variant="secondary">{loaded ? 'In use' : 'Selected'}</Badge> : null}
          </div>
          <p className="text-muted-foreground text-xs leading-snug">{spec.description}</p>
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
              {formatBytes(bytes)} of {formatBytes(total)}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : ready ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={onUse} disabled={busy || loaded}>
            {busy ? 'Loading…' : loaded ? 'Loaded' : selected ? 'Load this model' : 'Use this model'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
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
            <Button type="button" size="sm" className="w-fit" onClick={onDownload} disabled={busy}>
              <Download className="h-4 w-4" />
              {status.status === 'error' ? 'Retry download' : `Download ${formatBytes(spec.sizeBytes)}`}
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">{fit.reason}</p>
          )}
        </div>
      )}
    </div>
  );
}
