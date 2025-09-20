import { Button, Select, cn } from '@ci/shadcn';
import { Brain, Wrench } from '@ci/shadcn/icons';

import { useModel } from '@/hooks';

interface Props {
  withToggles?: boolean;
}

export function ModelSelector({ withToggles = false }: Props) {
  const [
    { selectedModel, thinkingEnabled, toolsEnabled, activeModels, error },
    { selectModel, toggleThinking, toggleTools },
  ] = useModel();

  if (error) {
    return null;
  }

  const selector = (
    <Select value={selectedModel ?? undefined} onValueChange={selectModel}>
      <Select.Trigger className="w-[150px]">
        <Select.Value placeholder="Active model" />
      </Select.Trigger>
      <Select.Content>
        {activeModels.map((model) => (
          <Select.Item key={model.model} value={model.model}>
            {model.model}
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
      <div className="flex flex-row items-center mr-2">
        <Button
          variant="ghost"
          size="icon"
          aria-pressed={toolsEnabled}
          className={cn(toolsEnabled ? 'text-primary' : 'text-muted-foreground')}
          onClick={toggleTools}
        >
          <Wrench />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-pressed={thinkingEnabled}
          className={cn(thinkingEnabled ? 'text-primary' : 'text-muted-foreground')}
          onClick={toggleThinking}
        >
          <Brain />
        </Button>
      </div>

      {selector}
    </div>
  );
}
