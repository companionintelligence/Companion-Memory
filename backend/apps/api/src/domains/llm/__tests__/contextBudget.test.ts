import { TIER_PROFILES } from '@ci/domains/model-routing';

import {
  MAX_INLINE_IMAGE_MESSAGES,
  NUM_CTX_ENV_VAR,
  attachmentStub,
  isContextOverflowError,
  messageBytes,
  parseNumCtx,
  planContextAdmission,
  planInlineAttachments,
  resolveContextBudget,
  toolSequenceGroups,
  type AdmissionCandidate,
} from '../contextBudget';

function candidate(role: string, bytes: number): AdmissionCandidate {
  return { role, bytes };
}

describe('parseNumCtx', () => {
  it('accepts a positive integer', () => {
    expect(parseNumCtx('32768')).toBe(32768);
    expect(parseNumCtx('  65536  ')).toBe(65536);
  });

  it('treats anything that is not a positive integer as absent', () => {
    // A bad value must not become a tiny (or fractional) window by accident.
    expect(parseNumCtx(undefined)).toBeNull();
    expect(parseNumCtx('')).toBeNull();
    expect(parseNumCtx('auto')).toBeNull();
    expect(parseNumCtx('-1')).toBeNull();
    expect(parseNumCtx('0')).toBeNull();
    expect(parseNumCtx('65536.5')).toBeNull();
    expect(parseNumCtx('32k')).toBeNull();
  });
});

describe('resolveContextBudget', () => {
  it('prefers the window CI-Hub computed and exported', () => {
    const budget = resolveContextBudget({ env: { [NUM_CTX_ENV_VAR]: '32768' } });

    expect(budget.maxContextTokens).toBe(32768);
    expect(budget.source).toBe(NUM_CTX_ENV_VAR);
  });

  it('falls back to the tier profile when Hub did not export one', () => {
    const budget = resolveContextBudget({ env: {} });

    expect(budget.maxContextTokens).toBe(TIER_PROFILES.on_device.maxContextTokens);
    expect(budget.source).toBe('tier-profile');
  });

  it('never lets the byte budget exceed the token headroom (tokens <= bytes)', () => {
    // The whole point of the derivation: no bytes-per-token multiplier. A
    // 3x multiplier here would admit 3x the window on CJK or base64 input.
    for (const numCtx of ['4096', '8192', '32768', '65536', '262144']) {
      const budget = resolveContextBudget({ env: { [NUM_CTX_ENV_VAR]: numCtx } });
      const headroom = budget.maxContextTokens - budget.reservedOutputTokens - budget.reservedSystemTokens;

      expect(budget.promptBudgetBytes).toBeLessThanOrEqual(Math.max(headroom, 2048));
    }
  });

  it('leaves room for the answer and the system prompt', () => {
    const budget = resolveContextBudget({ env: { [NUM_CTX_ENV_VAR]: '32768' } });

    expect(budget.reservedOutputTokens).toBeGreaterThan(0);
    expect(budget.reservedSystemTokens).toBeGreaterThan(0);
    expect(budget.promptBudgetBytes).toBeLessThan(budget.maxContextTokens);
  });

  it('halves the prompt budget per shrink level and clamps the level', () => {
    const base = resolveContextBudget({ env: { [NUM_CTX_ENV_VAR]: '65536' } });
    const once = resolveContextBudget({ env: { [NUM_CTX_ENV_VAR]: '65536' }, shrinkLevel: 1 });
    const twice = resolveContextBudget({ env: { [NUM_CTX_ENV_VAR]: '65536' }, shrinkLevel: 2 });
    const absurd = resolveContextBudget({ env: { [NUM_CTX_ENV_VAR]: '65536' }, shrinkLevel: 99 });

    expect(once.promptBudgetBytes).toBe(Math.floor(base.promptBudgetBytes / 2));
    expect(twice.promptBudgetBytes).toBe(Math.floor(base.promptBudgetBytes / 4));
    expect(absurd.promptBudgetBytes).toBe(twice.promptBudgetBytes);
    expect(absurd.shrinkLevel).toBe(2);
  });

  it('keeps a usable floor on an absurdly small configured window', () => {
    const budget = resolveContextBudget({ env: { [NUM_CTX_ENV_VAR]: '512' } });

    expect(budget.promptBudgetBytes).toBe(2048);
  });
});

describe('messageBytes', () => {
  it('counts UTF-8 bytes, not characters', () => {
    // 5 CJK characters are 15 bytes and roughly 5 tokens; a char count would
    // under-count by 3x on exactly the input the multiplier form gets wrong.
    expect(messageBytes('日本語です。'.slice(0, 5))).toBe(15);
    expect(messageBytes('hello')).toBe(5);
  });

  it('counts serialized tool_calls', () => {
    const withTools = messageBytes('hi', [{ function: { name: 'memory.recall', arguments: {} } }]);

    expect(withTools).toBeGreaterThan(messageBytes('hi'));
  });

  it('treats null and undefined content as zero', () => {
    expect(messageBytes(null)).toBe(0);
    expect(messageBytes(undefined)).toBe(0);
  });
});

describe('toolSequenceGroups', () => {
  it('binds each tool result to the assistant turn that called it', () => {
    const groups = toolSequenceGroups(['user', 'assistant', 'tool', 'tool', 'assistant', 'user']);

    expect(groups).toStrictEqual([[0], [1, 2, 3], [4], [5]]);
    expect(groups).toHaveLength(4);
  });

  it('does not lose a leading orphan tool row', () => {
    const groups = toolSequenceGroups(['tool', 'user']);

    expect(groups).toStrictEqual([[0], [1]]);
  });
});

describe('planContextAdmission', () => {
  it('admits the whole thread when it fits', () => {
    const plan = planContextAdmission(
      [candidate('user', 10), candidate('assistant', 10), candidate('user', 10)],
      1000,
    );

    expect(plan.admitted).toStrictEqual([0, 1, 2]);
    expect(plan.admitted).toHaveLength(3);
    expect(plan.dropped).toStrictEqual([]);
    expect(plan.admittedBytes).toBe(30);
    expect(plan.overBudget).toBe(false);
  });

  it('drops oldest history first, newest-first admission', () => {
    const plan = planContextAdmission(
      [
        candidate('user', 100),
        candidate('assistant', 100),
        candidate('user', 100),
        candidate('assistant', 100),
        candidate('user', 100),
      ],
      300,
    );

    // The newest user turn is pinned; the two next-newest fit; the oldest pair drops.
    expect(plan.admitted).toStrictEqual([2, 3, 4]);
    expect(plan.admitted).toHaveLength(3);
    expect(plan.dropped).toStrictEqual([0, 1]);
  });

  it('keeps the newest user turn even when it alone blows the budget', () => {
    // Liveness over budget: a turn that cannot fit its own question is broken,
    // not cheap. The caller is told via overBudget.
    const plan = planContextAdmission([candidate('assistant', 50), candidate('user', 10_000)], 100);

    expect(plan.admitted).toContain(1);
    expect(plan.overBudget).toBe(true);
  });

  it('pins the synthetic prefill assistant prefix even when older than the trim window', () => {
    // ensureActionPrompt PREPENDS the suggestion and
    // extractLeadingAssistantMessages only sees it while it is still leading.
    // Dropping oldest-first would silently disable appendPrefillActionContext.
    const plan = planContextAdmission(
      [
        candidate('assistant', 20), // synthetic prefill
        candidate('user', 500),
        candidate('assistant', 500),
        candidate('user', 30),
      ],
      100,
    );

    expect(plan.admitted).toContain(0);
    expect(plan.admitted).toContain(3);
    expect(plan.dropped).toStrictEqual([1, 2]);
  });

  it('never admits a tool result whose assistant tool_calls fell outside the budget', () => {
    // Both Ollama and the OpenAI-compat backend reject an orphan `tool` role.
    const plan = planContextAdmission(
      [
        candidate('user', 10),
        candidate('assistant', 90), // tool_calls
        candidate('tool', 90), // its result
        candidate('user', 10),
      ],
      100,
    );

    // The scan stops at the first group that does not fit rather than skipping
    // it to squeeze in something older, so history stays a contiguous recent
    // window — and, crucially, the orphaned `tool` row never ships alone.
    expect(plan.admitted).toStrictEqual([3]);
    expect(plan.admitted).toHaveLength(1);
    expect(plan.admitted).not.toContain(2);
  });

  it('admits an affordable tool sequence as one unit', () => {
    const plan = planContextAdmission(
      [candidate('assistant', 20), candidate('tool', 20), candidate('user', 10)],
      100,
    );

    expect(plan.admitted).toStrictEqual([0, 1, 2]);
    expect(plan.admitted).toHaveLength(3);
  });

  it('returns an empty plan for an empty thread', () => {
    const plan = planContextAdmission([], 100);

    expect(plan.admitted).toStrictEqual([]);
    expect(plan.overBudget).toBe(false);
  });

  it('always returns admitted indices in chronological order', () => {
    const plan = planContextAdmission(
      [
        candidate('user', 10),
        candidate('assistant', 10),
        candidate('user', 10),
        candidate('assistant', 10),
        candidate('user', 10),
      ],
      1000,
    );

    expect([...plan.admitted].sort((a, b) => a - b)).toStrictEqual(plan.admitted);
  });
});

describe('planInlineAttachments', () => {
  it('re-sends images only for the newest messages that have them', () => {
    const inline = planInlineAttachments([1, 0, 2, 0, 3]);

    expect(inline).toStrictEqual([false, false, true, false, true]);
    expect(inline).toHaveLength(5);
    expect(inline.filter(Boolean)).toHaveLength(MAX_INLINE_IMAGE_MESSAGES);
  });

  it('inlines nothing when nothing is attached', () => {
    expect(planInlineAttachments([0, 0, 0])).toStrictEqual([false, false, false]);
  });

  it('handles a thread shorter than the cap', () => {
    expect(planInlineAttachments([2])).toStrictEqual([true]);
  });
});

describe('attachmentStub', () => {
  it('says how many attachments were withheld', () => {
    expect(attachmentStub(0)).toBe('');
    expect(attachmentStub(1)).toContain('1 attachment');
    expect(attachmentStub(3)).toContain('3 attachments');
  });
});

describe('isContextOverflowError', () => {
  it.each([
    "This model's maximum context length is 8192 tokens, however you requested 9001",
    'Requested token count exceeds the model context window',
    'context_length_exceeded',
    'prompt is too long: 12000 tokens > 8192',
  ])('classifies %s as an overflow', (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(true);
  });

  it.each(['fetch failed', 'model "qwen3:14b" not found', 'Qwen3-8B is not a multimodal model'])(
    'does not classify %s as an overflow',
    (message) => {
      expect(isContextOverflowError(new Error(message))).toBe(false);
    },
  );

  it('handles a non-Error rejection', () => {
    expect(isContextOverflowError('context length exceeded')).toBe(true);
    expect(isContextOverflowError(null)).toBe(false);
  });
});
