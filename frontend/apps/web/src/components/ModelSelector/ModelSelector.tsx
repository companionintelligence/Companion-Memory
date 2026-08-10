import { useCallback } from 'react';

import { Select, Toggle, Tooltip, cn, useToast } from '@ci/shadcn';
import { Brain, Eye, Wrench } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { useModel } from '@/hooks';

interface Props {
  withToggles?: boolean;
  visionOnly?: boolean;
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
  triggerClassName = 'w-[150px]',
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
      error,
    },
    { selectModel, selectVisionModel, toggleThinking, toggleTools },
  ] = useModel();

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

  if (error) {
    return null;
  }

  const selector = (
    <Select value={currentModel ?? undefined} onValueChange={handleSelectModel}>
      <Select.Trigger className={cn(triggerClassName)}>
        <Select.Value placeholder="Active model" />
      </Select.Trigger>
      <Select.Content>
        {models.map((model) => (
          <Select.Item key={model.model} value={model.model}>
            <div className="flex w-full items-center justify-between gap-2">
              <span className="truncate">{model.model}</span>

              <span className="ml-3 flex items-center gap-1 text-muted-foreground">
                {model.thinking === true && <Brain className="size-3.5" aria-label="Supports thinking" />}
                {model.tools === true && <Wrench className="size-3.5" aria-label="Supports tools" />}
                {model.vision === true && <Eye className="size-3.5" aria-label="Supports vision" />}
              </span>
            </div>
          </Select.Item>
        ))}
      </Select.Content>
    </Select>
  );

  if (!withToggles) {
    return selector;
  }

  return (
    <div className="flex flex-row">
      <div className="flex flex-row items-center mr-2 gap-1">
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
                className={!toolsSupported ? 'opacity-50 cursor-not-allowed' : ''}
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
                className={!thinkingSupported ? 'opacity-50 cursor-not-allowed' : ''}
              >
                <Brain />
              </Toggle>
            </span>
          </Tooltip.Trigger>
        </Tooltip>
      </div>

      {selector}
    </div>
  );
}
