import { useMemo } from 'react';

import type { KnowledgeCard, Message } from './types';

const CODE_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/gi;
const SOURCE_LABELS: Record<string, string> = {
  tool: 'Tool Result',
  assistant: 'Assistant Output',
  system: 'System Context',
  user: 'User Input',
};

export interface AdditionalKnowledgeEntry {
  id: string;
  title: string;
  sourceLabel: string;
  data: unknown;
  source?: Message['role'];
  rawJson?: string;
}

export function useKnowledgeCards(
  messages: Message[] | null | undefined,
  extras?: AdditionalKnowledgeEntry[],
): KnowledgeCard[] {
  return useMemo(() => {
    const cards: KnowledgeCard[] = [];

    if (extras?.length) {
      for (const extra of extras) {
        const { raw, formatted } = normalizeJson(extra.data, extra.rawJson);

        cards.push({
          id: extra.id,
          messageId: extra.id,
          source: extra.source ?? 'system',
          sourceLabel: extra.sourceLabel,
          title: extra.title,
          rawJson: raw,
          formattedJson: formatted,
          data: extra.data,
        });
      }
    }

    if (!messages || messages.length === 0) {
      return cards;
    }

    const roleCounts = new Map<string, number>();

    for (const message of messages) {
      const segments = extractJsonSegments(message);

      segments.forEach((segment, segmentIndex) => {
        const parsed = tryParseJson(segment);

        if (parsed == null) {
          return;
        }

        const roleKey = message.role ?? 'context';
        const sourceLabel = SOURCE_LABELS[roleKey] ?? 'Context';
        const occurrence = (roleCounts.get(roleKey) ?? 0) + 1;

        roleCounts.set(roleKey, occurrence);

        const fallbackTitle = `${sourceLabel} ${occurrence}`;
        const title = deriveTitle(parsed, fallbackTitle);

        cards.push({
          id: `${message.id}:${segmentIndex}`,
          messageId: message.id,
          source: message.role,
          sourceLabel,
          title,
          rawJson: segment,
          formattedJson: JSON.stringify(parsed, null, 2),
          data: parsed,
        });
      });
    }

    return cards;
  }, [messages, extras]);
}

function extractJsonSegments(message: Message): string[] {
  const content = message.content ?? '';
  const trimmed = content.trim();
  const candidates = new Set<string>();

  if (message.role === 'tool' && trimmed.length > 0) {
    candidates.add(trimmed);
  }

  CODE_FENCE_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = CODE_FENCE_PATTERN.exec(content)) != null) {
    const candidate = match[1]?.trim();

    if (candidate) {
      candidates.add(candidate);
    }
  }

  if (candidates.size === 0 && isLikelyStandaloneJson(trimmed)) {
    candidates.add(trimmed);
  }

  return Array.from(candidates);
}

function isLikelyStandaloneJson(value: string): boolean {
  if (!value) {
    return false;
  }

  const start = value[0];
  const end = value[value.length - 1];

  return (start === '{' && end === '}') || (start === '[' && end === ']');
}

function tryParseJson(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function deriveTitle(data: unknown, fallback: string): string {
  if (data == null) {
    return fallback;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return fallback;
    }

    return `${fallback} (${data.length} items)`;
  }

  if (typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const preferredKeys = ['title', 'name', 'label'];

    for (const key of preferredKeys) {
      const value = record[key];

      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }

    const idValue = record['id'];
    if (typeof idValue === 'string' && idValue.trim().length > 0) {
      return idValue;
    }

    const typeValue = record['type'];
    if (typeof typeValue === 'string' && typeValue.trim().length > 0) {
      return `${typeValue}`;
    }
  }

  return fallback;
}

function normalizeJson(data: unknown, rawOverride?: string): { raw: string; formatted: string } {
  if (rawOverride) {
    try {
      const parsed = JSON.parse(rawOverride);
      const formatted = JSON.stringify(parsed, null, 2);

      return { raw: rawOverride, formatted };
    } catch {
      return { raw: rawOverride, formatted: rawOverride };
    }
  }

  try {
    const formatted = JSON.stringify(data, null, 2);

    return { raw: formatted, formatted };
  } catch {
    const fallback = typeof data === 'string' ? data : String(data);

    return { raw: fallback, formatted: fallback };
  }
}
