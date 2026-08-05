import { Card, Label, Switch } from '@ci/shadcn';
import { Brain, Eye, Wrench } from '@ci/shadcn/icons';

import { ModelSelector } from '@/components/ModelSelector';
import { useModel } from '@/hooks';

/**
 * Account-level LLM settings: which model the assistant runs, plus the tools /
 * thinking preferences that ride with it.
 *
 * This used to live in the actions pane (FeedModal), which was the only place a
 * user could reach it. The selection is held by `useModel` and persisted to
 * localStorage, so it is per-browser rather than per-account.
 *
 * The model list comes from `GET /api/llm/models`, which the API answers from
 * whatever Ollama it is pointed at — so this section needs no change when Ollama
 * moves behind CI-OS-Hub.
 */
export function ModelSection() {
  const [
    { selectedModel, thinkingSupported, thinkingEnabled, toolsSupported, toolsEnabled, error },
    { toggleThinking, toggleTools },
  ] = useModel();

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Model</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose the language model your companion uses, and whether it may use tools or think before
          answering.
        </p>
      </div>

      <Card>
        <Card.Content className="space-y-6 pt-6">
          {error ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t load the available models. Check that the LLM service is reachable and try again.
            </p>
          ) : (
            <>
              <div className="grid gap-2">
                {/* No htmlFor: ModelSelector renders a Radix Select trigger, not
                    a labelable form control. */}
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
        </Card.Content>
      </Card>
    </>
  );
}
