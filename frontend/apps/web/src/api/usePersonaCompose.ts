import { useCallback, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

export interface HowYoudDoItStep {
  title: string;
  detail?: string;
  durationMinutes?: number;
}

export interface PersonaEvidence {
  kind: 'dossier' | 'preference' | 'answer' | 'summary' | 'recall' | 'forecast';
  id?: string;
  note: string;
}

export interface HowYoudDoItResult {
  task: {
    title: string;
    goal?: string;
    openQuestions: string[];
    constraints: string[];
  };
  personaBrief: string;
  approach: HowYoudDoItStep[];
  timing?: string;
  people: string[];
  evidence: PersonaEvidence[];
  followUps: string[];
  confidence: number;
  hasSignal: boolean;
}

export interface AboutYouView {
  name: string | null;
  dossier: {
    summary: string;
    tone?: string | null;
    personalityTraits?: string[] | null;
    interactionGuidelines?: string[] | null;
    preferences?: string[] | null;
    challenges?: string[] | null;
    lastUpdatedAt?: string | null;
  } | null;
  preferences: Array<{
    entityId: string;
    name: string;
    type: string;
    category: string | null;
    strength: number;
    relationship: 'PREFERS' | 'DISLIKES';
  }>;
  family: Array<{
    entityId: string;
    name: string;
    relationship: string;
    age?: number;
  }>;
  recentAnswers: Array<{
    id: string;
    question: string | null;
    answer: string;
    answeredAt: string;
  }>;
  /** Wake/sleep/work hours captured during onboarding, when set. */
  schedule: Record<string, unknown> | null;
  /** The autonomy dial ('cautious' | 'balanced' | 'hands_off') from onboarding. */
  trustMode: string | null;
  hasSignal: boolean;
}

function authHeaders(authToken: string | null | undefined): HeadersInit {
  return {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };
}

export async function composeHowYoudDoIt(
  authToken: string | null | undefined,
  task: string,
  options: { includeRecall?: boolean; candidateId?: string } = {},
): Promise<HowYoudDoItResult> {
  const result = await fetchJson<HowYoudDoItResult>('/api/v1/intelligence/how-youd-do-it', {
    method: 'POST',
    headers: authHeaders(authToken),
    body: JSON.stringify({
      task,
      includeRecall: options.includeRecall,
      candidateId: options.candidateId,
    }),
  });

  if (!result) {
    throw new Error("How-you'd-do-it request returned no data");
  }

  return result;
}

export async function applyHowYoudDoIt(
  authToken: string | null | undefined,
  draft: HowYoudDoItResult,
): Promise<{ added: number }> {
  const response = await fetchJson<{ added: number }>('/api/v1/intelligence/how-youd-do-it/apply', {
    method: 'POST',
    headers: authHeaders(authToken),
    body: JSON.stringify({ result: draft }),
  });

  if (!response) {
    throw new Error("Apply how-you'd-do-it returned no data");
  }

  return response;
}

/**
 * `fetchJson` casts the parsed body to its type parameter without validating it, so
 * `AboutYouView` is a claim about the wire, not a guarantee. `AboutYouSection` reads
 * `preferences`/`family`/`recentAnswers` as plain arrays; anything that answers 200 with
 * a body that isn't the agreed shape (version skew, a proxy error page, a test double)
 * would otherwise take the whole page down with `Cannot read properties of undefined`.
 * So parse it here, once, and hand callers the shape the type promises.
 */
export async function fetchAboutYou(authToken: string | null | undefined): Promise<AboutYouView> {
  const result = await fetchJson<Partial<AboutYouView>>('/api/v1/intelligence/about-you', {
    headers: authHeaders(authToken),
  });

  // A body that is not a JSON object at all is a broken response, not an empty
  // profile — surface it as an error the section can offer to retry, rather than
  // quietly rendering "Still thin" and implying Companion knows nothing about you.
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('About-you request returned no data');
  }

  return {
    name: result.name ?? null,
    dossier: result.dossier ?? null,
    preferences: result.preferences ?? [],
    family: result.family ?? [],
    recentAnswers: result.recentAnswers ?? [],
    schedule: result.schedule ?? null,
    trustMode: result.trustMode ?? null,
    hasSignal: result.hasSignal ?? false,
  };
}

export async function submitAboutYouCorrection(
  authToken: string | null | undefined,
  text: string,
): Promise<{ questionId: string; answerId: string }> {
  const result = await fetchJson<{ questionId: string; answerId: string }>(
    '/api/v1/intelligence/about-you/correction',
    {
      method: 'POST',
      headers: authHeaders(authToken),
      body: JSON.stringify({ text }),
    },
  );

  if (!result) {
    throw new Error('About-you correction returned no data');
  }

  return result;
}

/** Hook for Chat / Schedule compose + apply. */
export function usePersonaCompose() {
  const [{ authToken }] = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HowYoudDoItResult | null>(null);

  const compose = useCallback(
    async (task: string, options?: { includeRecall?: boolean; candidateId?: string }) => {
      setLoading(true);
      setError(null);
      try {
        const next = await composeHowYoudDoIt(authToken, task, options);
        setResult(next);

        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not personalize that task.');
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [authToken],
  );

  const apply = useCallback(
    async (value?: HowYoudDoItResult) => {
      const payload = value ?? result;
      if (!payload) {
        throw new Error('Nothing to apply');
      }

      return applyHowYoudDoIt(authToken, payload);
    },
    [authToken, result],
  );

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return [
    { loading, error, result },
    { compose, apply, clear, setResult },
  ] as const;
}
