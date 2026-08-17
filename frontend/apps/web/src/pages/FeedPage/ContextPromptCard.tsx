import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Card } from '@ci/shadcn';

import {
  SelectorRenderer,
  SelectorShell,
  selectorSubmitsOnSelect,
  type SelectorSpec,
  type SelectorValue,
} from '@/components/selectors';
import { useAuth } from '@/hooks';

type ContextPrompt = {
  id: string;
  selector: SelectorSpec;
};

function hasSelectorValue(value: SelectorValue): boolean {
  if (value == null) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }

  return true;
}

function initialValue(selector: SelectorSpec): SelectorValue {
  if (selector.type === 'intensity_1_5') {
    return selector.min ?? 1;
  }

  return null;
}

export function ContextPromptCard() {
  const [{ authToken }] = useAuth();
  const [prompt, setPrompt] = useState<ContextPrompt | null>(null);
  const [value, setValue] = useState<SelectorValue>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    if (!authToken) {
      return null;
    }

    setError(null);
    try {
      const row = await fetchJson<ContextPrompt | null>('/api/context-prompts/pending', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const next = row ?? null;
      setPrompt(next);
      setValue(next ? initialValue(next.selector) : null);

      return next;
    } catch {
      setPrompt(null);

      return null;
    }
  }, [authToken]);

  useEffect(() => {
    if (!authToken) {
      return;
    }

    let cancelled = false;
    let attempts = 0;

    const poll = async () => {
      setLoading(true);
      const row = await load();
      if (cancelled) {
        return;
      }

      if (row || attempts >= 8) {
        setLoading(false);

        return;
      }

      attempts += 1;
      window.setTimeout(() => {
        void poll();
      }, 2000);
    };

    void poll();

    return () => {
      cancelled = true;
    };
  }, [authToken, load, reloadToken]);

  const respond = async (path: 'respond' | 'skip', response?: SelectorValue) => {
    if (!authToken || !prompt || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await fetchJson(`/api/context-prompts/${prompt.id}/${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          ...(path === 'respond' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: path === 'respond' ? JSON.stringify({ response }) : undefined,
      });
      setPrompt(null);
      setReloadToken((token) => token + 1);
    } catch {
      setError(path === 'respond' ? 'Could not save that answer.' : 'Could not skip that prompt.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (loading || !prompt) {
    return null;
  }

  return (
    <Card className="gap-3 py-3">
      <Card.Content className="px-4">
        <SelectorShell
          prompt={prompt.selector.prompt}
          hint={prompt.selector.hint}
          canSubmit={hasSelectorValue(value)}
          submitting={submitting}
          hideSave={selectorSubmitsOnSelect(prompt.selector.type)}
          onSubmit={() => void respond('respond', value)}
          onSkip={() => void respond('skip')}
        >
          <SelectorRenderer
            spec={prompt.selector}
            value={value}
            onChange={(next) => {
              setValue(next);
              if (selectorSubmitsOnSelect(prompt.selector.type) && hasSelectorValue(next)) {
                void respond('respond', next);
              }
            }}
          />
        </SelectorShell>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </Card.Content>
    </Card>
  );
}
