import { useCallback } from 'react';

import { findLocalLlmModel } from '@ci/common';
import { Select, Toggle, Tooltip, cn, useToast } from '@ci/shadcn';
import { Brain, Eye, Smartphone, Wrench } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { useModel } from '@/hooks';
import { useLocalLlmPrefs } from '@/hooks/useOnDeviceModel';

interface Props {
  withToggles?: boolean;
  visionOnly?: boolean;
  /**
   * `composer` is the compact Cursor-style row inside ChatInput.
   * Default is the standalone toolbar / settings control.
   */
  variant?: 'toolbar' | 'composer';
  /**
   * Width/appearance of the select trigger. Defaults to the compact toolbar
   * width; Settings passes a full-width class so it lines up with the other
   * controls in the section.
   */
  triggerClassName?: string;
}

export function ModelSelector({
  withToggles = false,
  visionOnly = false,
  variant = 'toolbar',
  triggerClassName,
}: Props) {
  const { toast } = useToast();
  const { t } = useTranslation();

  const [
    {
      selectedModel,
      selectedVisionModel,
      thinkingSupported,
      thinkingEnabled,
      toolsSupported,
      toolsEnabled,
      activeModels,
      loading,
      error,
    },
    { selectModel, selectVisionModel, toggleThinking, toggleTools },
  ] = useModel();

  // Where the chat is actually answered. The list below is the appliance's models and
  // nothing else; when the phone's own model answers (`device`), showing an appliance
  // model as "the model" misleads, so the composer names the on-device model instead.
  // `auto` keeps the appliance picker and adds a note that the phone steps in when the
  // appliance cannot be reached. Settings' and Capture's pickers are untouched: they set
  // the appliance preference, which still matters for `auto` and for background work.
  const [{ mode: localMode, modelId: localModelId }] = useLocalLlmPrefs();
  const localLabel = localModelId ? (findLocalLlmModel(localModelId)?.label ?? localModelId) : null;

  const currentModel = visionOnly ? selectedVisionModel : selectedModel;
  const handleSelectModel = visionOnly ? selectVisionModel : selectModel;
  const models = visionOnly ? activeModels.filter((model) => model.vision === true) : activeModels;
  const selectedModelConfig = activeModels.find((model) => model.model === currentModel) ?? null;
  // Keyed off the same flags that drive `disabled`, not off selectedModelConfig:
  // an unknown/not-yet-loaded model leaves `tools` undefined, which disables the
  // toggle but is not `=== false`, so the copy would claim the model is fine.
  const toolsTooltip = t(toolsSupported ? 'MODEL_TOGGLE_TOOLS' : 'MODEL_TOGGLE_TOOLS_UNSUPPORTED');
  const thinkingTooltip = t(
    thinkingSupported ? 'MODEL_TOGGLE_THINKING' : 'MODEL_TOGGLE_THINKING_UNSUPPORTED',
  );

  const handleToggleTools = useCallback(
    (pressed: boolean) => {
      if (pressed && selectedModelConfig?.tools === false) {
        toast.error('Selected model does not support tools.');

        return;
      }

      toggleTools();
    },
    [selectedModelConfig?.tools, toast, toggleTools],
  );

  const handleToggleThinking = useCallback(
    (pressed: boolean) => {
      if (pressed && selectedModelConfig?.thinking === false) {
        toast.error('Selected model does not support thinking.');

        return;
      }

      toggleThinking();
    },
    [selectedModelConfig?.thinking, toast, toggleThinking],
  );

  const isComposer = variant === 'composer';

  if (isComposer && !visionOnly && localMode === 'device') {
    return (
      <Link
        to="/settings/on-device"
        aria-label="Active model"
        data-testid="on-device-model"
        className="text-muted-foreground hover:text-foreground inline-flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2 text-xs"
      >
        <Smartphone className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {localLabel ? `${localLabel} · on this phone` : 'Choose an on-device model'}
        </span>
      </Link>
    );
  }

  const fallbackNote =
    isComposer && !visionOnly && localMode === 'auto' && localLabel ? (
      <Tooltip delayDuration={600}>
        <Tooltip.Content>{`Answers on this phone with ${localLabel} when your Companion can't be reached.`}</Tooltip.Content>
        <Tooltip.Trigger asChild>
          <span className="text-muted-foreground inline-flex shrink-0" data-testid="on-device-fallback">
            <Smartphone className="size-3.5" aria-label={`Falls back to ${localLabel} on this phone`} />
          </span>
        </Tooltip.Trigger>
      </Tooltip>
    ) : null;

  const resolvedTriggerClassName =
    triggerClassName ??
    (isComposer ? 'h-8 min-w-0 flex-1 border-0 bg-transparent shadow-none px-2 text-xs' : 'w-[150px]');

  // Radix Select.Value clones ItemText into the trigger. Nested flex/div
  // children (capability icons) come through empty on iOS WKWebView, so Chat
  // and Settings both showed the placeholder instead of the served model id.
  // Render the id ourselves whenever one is selected.
  const triggerLabel = currentModel
    ? currentModel
    : loading
      ? 'Loading models…'
      : error
        ? "Couldn't load models"
        : // A greyed-out select with no way to act on it: name the state so the
          // Chat empty state's "Open Settings → Model" reads as the fix for it.
          'No model set up';

  const selector = (
    <Select
      value={currentModel ?? undefined}
      onValueChange={handleSelectModel}
      disabled={models.length === 0}
    >
      <Select.Trigger className={cn('min-w-0', resolvedTriggerClassName)} aria-label="Active model">
        <Select.Value placeholder={triggerLabel}>
          <span className="min-w-0 truncate">{triggerLabel}</span>
        </Select.Value>
      </Select.Trigger>
      <Select.Content>
        {models.map((model) => (
          <Select.Item key={model.model} value={model.model} textValue={model.model}>
            <span className="min-w-0 truncate">{model.model}</span>
            <span className="ml-3 flex shrink-0 items-center gap-1 text-muted-foreground">
              {model.thinking === true && <Brain className="size-3.5" aria-label="Supports thinking" />}
              {model.tools === true && <Wrench className="size-3.5" aria-label="Supports tools" />}
              {model.vision === true && <Eye className="size-3.5" aria-label="Supports vision" />}
            </span>
          </Select.Item>
        ))}
      </Select.Content>
    </Select>
  );

  if (!withToggles) {
    return fallbackNote ? (
      <div className="flex min-w-0 flex-row items-center gap-1">
        {selector}
        {fallbackNote}
      </div>
    ) : (
      selector
    );
  }

  return (
    <div className={cn('flex min-w-0 flex-row items-center', isComposer ? 'flex-1 gap-1' : '')}>
      <div className={cn('flex shrink-0 flex-row items-center gap-1', !isComposer && 'mr-2')}>
        <Tooltip delayDuration={600}>
          <Tooltip.Content>{toolsTooltip}</Tooltip.Content>
          {/* A disabled Toggle gets `pointer-events: none`, which would swallow the
              hover — and an unsupported model is exactly when the tooltip has
              something to say. Anchor to a wrapper span so it still opens. */}
          <Tooltip.Trigger asChild>
            <span className="inline-flex">
              <Toggle
                pressed={toolsEnabled}
                onPressedChange={handleToggleTools}
                size="sm"
                variant="outline"
                aria-label={t('MODEL_TOGGLE_TOOLS')}
                disabled={!toolsSupported}
                className={cn(
                  isComposer && 'h-8 w-8 p-0',
                  !toolsSupported ? 'opacity-50 cursor-not-allowed' : '',
                )}
              >
                <Wrench />
              </Toggle>
            </span>
          </Tooltip.Trigger>
        </Tooltip>
        <Tooltip delayDuration={600}>
          <Tooltip.Content>{thinkingTooltip}</Tooltip.Content>
          <Tooltip.Trigger asChild>
            <span className="inline-flex">
              <Toggle
                pressed={thinkingEnabled}
                onPressedChange={handleToggleThinking}
                size="sm"
                variant="outline"
                aria-label={t('MODEL_TOGGLE_THINKING')}
                disabled={!thinkingSupported}
                className={cn(
                  isComposer && 'h-8 w-8 p-0',
                  !thinkingSupported ? 'opacity-50 cursor-not-allowed' : '',
                )}
              >
                <Brain />
              </Toggle>
            </span>
          </Tooltip.Trigger>
        </Tooltip>
      </div>

      {selector}
      {fallbackNote}
    </div>
  );
}
