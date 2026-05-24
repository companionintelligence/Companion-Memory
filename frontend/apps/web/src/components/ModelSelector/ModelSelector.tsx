import { useCallback } from 'react';

import { Select, Toggle, useToast } from '@ci/shadcn';
import { Brain, Eye, Wrench } from '@ci/shadcn/icons';

import { useModel } from '@/hooks';

interface Props {
  withToggles?: boolean;
  visionOnly?: boolean;
}

export function ModelSelector({ withToggles = false, visionOnly = false }: Props) {
  const { toast } = useToast();

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
      <Select.Trigger className="w-[150px]">
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
        <Toggle
          pressed={toolsEnabled}
          onPressedChange={handleToggleTools}
          size="sm"
          variant="outline"
          aria-label="Toggle tools"
          disabled={!toolsSupported}
          className={!toolsSupported ? 'opacity-50 cursor-not-allowed' : ''}
        >
          <Wrench />
        </Toggle>
        <Toggle
          pressed={thinkingEnabled}
          onPressedChange={handleToggleThinking}
          size="sm"
          variant="outline"
          aria-label="Toggle thinking"
          disabled={!thinkingSupported}
          className={!thinkingSupported ? 'opacity-50 cursor-not-allowed' : ''}
        >
          <Brain />
        </Toggle>
      </div>

      {selector}
    </div>
  );
}
