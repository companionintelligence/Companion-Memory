import { z } from 'zod/v3';

import { isEchoTitle } from './scanItemQuality';

/**
 * Same phrases as the llm domain's overflow check. Copied here because that
 * file is not on the llm public barrel, and a scan only needs to know that
 * the call did not fit.
 */
export function isScanContextOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  return (
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('context size') ||
    lower.includes('maximum context') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('exceed_context_size') ||
    lower.includes('too many tokens') ||
    (lower.includes('prompt') && lower.includes('too long')) ||
    (lower.includes('exceeds') && lower.includes('token')) ||
    (lower.includes('max_new_tokens') && lower.includes('must be <='))
  );
}

export const CLASSIFY_MARKER = 'Classify each numbered source.';
export const CONSOLIDATE_MARKER = 'Consolidate these candidate actions.';

const decisionSchema = z.object({
  sourceIndex: z.number().int().positive(),
  action: z.enum(['skip', 'candidate']),
  title: z.string().optional(),
  detail: z.string().optional(),
  confidence: z.number().optional(),
});

const itemSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
  confidence: z.number().optional(),
  estimatedMinutes: z.number().optional(),
  sourceIndex: z.number().int().positive().optional(),
});

export interface ScanCandidate {
  sourceIndex: number;
  title: string;
  detail?: string;
  confidence?: number;
  headerLine?: string;
  /** Communication or memory id this candidate was read from. */
  sourceId?: string;
}

export interface ScanTodo {
  title: string;
  detail?: string;
  confidence?: number;
  estimatedMinutes?: number;
  sourceIndex: number;
}

export function decisionResponseSchema(maxItems: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        maxItems,
        items: {
          type: 'object',
          properties: {
            sourceIndex: { type: 'integer' },
            action: { type: 'string', enum: ['skip', 'candidate'] },
            title: { type: 'string', maxLength: 120 },
            detail: { type: 'string', maxLength: 200 },
            confidence: { type: 'number' },
          },
          required: ['sourceIndex', 'action'],
        },
      },
    },
    required: ['decisions'],
  };
}

export function todoResponseSchema(maxItems: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        maxItems,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 120 },
            detail: { type: 'string', maxLength: 200 },
            confidence: { type: 'number' },
            estimatedMinutes: { type: 'number' },
            sourceIndex: { type: 'integer' },
          },
          required: ['title', 'sourceIndex'],
        },
      },
    },
    required: ['items'],
  };
}

export function classifyPrompt(block: string, alreadyTracked: string): string {
  return [
    CLASSIFY_MARKER,
    'Each source is numbered. Return one decision for every index.',
    'action "skip" means nothing remains to do: newsletters, sign-in alerts, security notices, receipts, empty chats, FYI.',
    'action "candidate" is a concrete remaining action. title is a short imperative the person would recognize.',
    'Never use the message type, the timestamp, or a "Subject:" line as the title.',
    'JSON: {"decisions":[{"sourceIndex":1,"action":"skip","title":"optional","detail":"optional","confidence":0.0}]}',
    alreadyTracked,
    '',
    'Sources:',
    block,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function consolidatePrompt(candidates: readonly ScanCandidate[]): string {
  const lines = candidates.map(
    (candidate, index) =>
      `[${index + 1}] source ${candidate.sourceIndex}: ${candidate.title}${candidate.detail ? `\n${candidate.detail}` : ''}`,
  );

  return [
    CONSOLIDATE_MARKER,
    'Drop duplicates. Drop any title that is only a subject line or a message header.',
    'Keep a short imperative title and the source number it came from.',
    'JSON: {"items":[{"title":"string","detail":"optional","confidence":0.0,"estimatedMinutes":30,"sourceIndex":1}]}',
    '',
    ...lines,
  ].join('\n');
}

export interface ClassifyOutcome {
  ok: boolean;
  candidates: ScanCandidate[];
  /** Every source index was either skipped or a candidate. */
  covered: boolean;
}

/**
 * A classify call succeeds only when every source index is accounted for and
 * no candidate title is a copied header. An explicit skip for every index is
 * success with an empty candidate list.
 */
export function interpretClassify(
  content: string,
  sourceCount: number,
  headerLineAt: (sourceIndex: number) => string | undefined,
): ClassifyOutcome {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content || '{}');
  } catch {
    return { ok: false, candidates: [], covered: false };
  }

  const decisions = z.object({ decisions: z.array(z.unknown()) }).safeParse(parsed);

  if (!decisions.success) {
    return { ok: false, candidates: [], covered: false };
  }

  const byIndex = new Map<number, z.infer<typeof decisionSchema>>();

  for (const unknownDecision of decisions.data.decisions) {
    const decision = decisionSchema.safeParse(unknownDecision);

    if (!decision.success) {
      return { ok: false, candidates: [], covered: false };
    }

    if (decision.data.sourceIndex < 1 || decision.data.sourceIndex > sourceCount) {
      return { ok: false, candidates: [], covered: false };
    }

    if (byIndex.has(decision.data.sourceIndex)) {
      return { ok: false, candidates: [], covered: false };
    }

    byIndex.set(decision.data.sourceIndex, decision.data);
  }

  if (byIndex.size !== sourceCount) {
    return { ok: false, candidates: [], covered: false };
  }

  const candidates: ScanCandidate[] = [];

  for (const decision of byIndex.values()) {
    if (decision.action === 'skip') {
      continue;
    }

    const title = decision.title?.trim() ?? '';
    const headerLine = headerLineAt(decision.sourceIndex);

    if (!title || isEchoTitle(title, headerLine)) {
      return { ok: false, candidates: [], covered: true };
    }

    candidates.push({
      sourceIndex: decision.sourceIndex,
      title,
      ...(decision.detail?.trim() ? { detail: decision.detail.trim() } : {}),
      ...(decision.confidence != null ? { confidence: decision.confidence } : {}),
      ...(headerLine ? { headerLine } : {}),
    });
  }

  return { ok: true, candidates, covered: true };
}

export function interpretConsolidate(
  content: string,
  candidates: readonly ScanCandidate[],
): ScanTodo[] | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content || '{}');
  } catch {
    return null;
  }

  const body = z.object({ items: z.array(z.unknown()) }).safeParse(parsed);

  if (!body.success) {
    return null;
  }

  const allowed = new Map(candidates.map((candidate) => [candidate.sourceIndex, candidate]));
  const todos: ScanTodo[] = [];

  for (const unknownItem of body.data.items) {
    const item = itemSchema.safeParse(unknownItem);

    if (!item.success || !item.data.title.trim()) {
      continue;
    }

    const sourceIndex =
      item.data.sourceIndex ?? (candidates.length === 1 ? candidates[0]?.sourceIndex : undefined);
    const source = sourceIndex != null ? allowed.get(sourceIndex) : undefined;

    if (!source) {
      continue;
    }

    if (isEchoTitle(item.data.title, source.headerLine)) {
      continue;
    }

    todos.push({
      title: item.data.title.trim(),
      sourceIndex: source.sourceIndex,
      ...(item.data.detail?.trim() ? { detail: item.data.detail.trim() } : {}),
      ...(item.data.confidence != null ? { confidence: item.data.confidence } : {}),
      ...(item.data.estimatedMinutes != null ? { estimatedMinutes: item.data.estimatedMinutes } : {}),
    });
  }

  return todos;
}
