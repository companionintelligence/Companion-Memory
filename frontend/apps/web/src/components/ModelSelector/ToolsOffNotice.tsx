import { useTranslation } from 'react-i18next';

import { useModel } from '@/hooks';
import { useLocalLlmPrefs } from '@/hooks/useOnDeviceModel';

/**
 * Why chat has no tools right now, or `null` when it has them (or it is too soon
 * to say).
 *
 * A turn runs without tools when the wrench is switched off or the selected model
 * has none (`gemma3:1b`, the appliance's default, is one). Silent until the model
 * list has loaded — an unknown model is not a model without tools — and whenever
 * the phone's own model answers, because the appliance's tools are not what that
 * chat uses.
 */
export function useToolsOffReason(): { reason: 'unsupported' | 'switched-off'; model: string } | null {
  const [{ selectedModel, activeModels, toolsSupported, toolsEnabled, loading }] = useModel();
  const [{ mode }] = useLocalLlmPrefs();

  const known = selectedModel != null && activeModels.some((model) => model.model === selectedModel);

  if (mode === 'device' || loading || !known || toolsEnabled) {
    return null;
  }

  return { reason: toolsSupported ? 'switched-off' : 'unsupported', model: selectedModel };
}

/**
 * Says, in words no model can overrule, that this chat cannot look things up or
 * make changes.
 *
 * Such a model answers questions about the person's own data from whatever
 * snapshot it was handed, and a small one will sometimes invent the rest — or
 * claim it did something it had no way to do. The server now tells the model so
 * and refuses plain instructions itself, but a model is a model; this line is the
 * part that is always true, and it sits next to the box the person is typing into.
 */
export function ToolsOffNotice() {
  const { t } = useTranslation();
  const off = useToolsOffReason();

  if (!off) {
    return null;
  }

  return (
    <p role="status" data-testid="tools-off-notice" className="text-muted-foreground px-1.5 text-xs">
      {off.reason === 'switched-off'
        ? t('CHAT_TOOLS_OFF_SWITCHED_OFF')
        : t('CHAT_TOOLS_OFF_UNSUPPORTED', { model: off.model })}
    </p>
  );
}
