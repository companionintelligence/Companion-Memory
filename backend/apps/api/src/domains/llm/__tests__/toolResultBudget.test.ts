/**
 * Guards the bound on tool-result text entering the follow-up prompt.
 *
 * The measured incident this module exists for: knowledge_search returned 25
 * full entity rows (~40KB), the follow-up prompt was silently truncated to the
 * 8192-token window (`n_tokens = 8191, truncated = 1`), and the model had one
 * token of room — the whole turn resolved to the empty-turn fallback.
 */
import { boundToolResultForPrompt, toolResultByteBudget } from '../toolResultBudget';

describe('toolResultByteBudget', () => {
  it('scales with the window between its floor and ceiling', () => {
    expect(toolResultByteBudget(8_192)).toBe(2_048);
    expect(toolResultByteBudget(32_768)).toBe(8_192);
    // Floor: a tiny window still gets a usable result block.
    expect(toolResultByteBudget(1_024)).toBe(2_048);
    // Ceiling: a huge window does not invite a huge result dump.
    expect(toolResultByteBudget(262_144)).toBe(16_384);
    // Absent window: assume the small native default, not the big one.
    expect(toolResultByteBudget(null)).toBe(2_048);
    expect(toolResultByteBudget(undefined)).toBe(2_048);
  });
});

describe('boundToolResultForPrompt', () => {
  it('passes a small result through as valid, equivalent JSON', () => {
    const result = [{ id: '1', title: 'hello' }, { id: '2' }];

    expect(JSON.parse(boundToolResultForPrompt(result, 2_048))).toEqual(result);
  });

  it('caps long string fields and marks the cut', () => {
    const result = [{ id: '1', content: 'x'.repeat(5_000) }];
    const parsed = JSON.parse(boundToolResultForPrompt(result, 2_048)) as Array<{ content: string }>;

    expect(parsed[0].content.length).toBeLessThan(400);
    expect(parsed[0].content.endsWith('…')).toBe(true);
  });

  it('drops trailing array items past the budget and appends an omission marker', () => {
    const result = Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, content: 'y'.repeat(300) }));
    const text = boundToolResultForPrompt(result, 2_048);

    expect(text.length).toBeLessThanOrEqual(2_048);

    const parsed = JSON.parse(text) as unknown[];
    const marker = parsed[parsed.length - 1];

    expect(typeof marker).toBe('string');
    expect(marker).toMatch(/\d+ more results omitted/);
    // The kept items are whole, usable objects.
    expect(parsed.length).toBeGreaterThan(1);
    expect((parsed[0] as { id: string }).id).toBe('0');
  });

  it('keeps every item when the array fits, with no marker', () => {
    const result = Array.from({ length: 3 }, (_, i) => ({ id: `${i}` }));
    const parsed = JSON.parse(boundToolResultForPrompt(result, 2_048)) as unknown[];

    expect(parsed).toEqual(result);
  });

  it('falls back to a truncated first item when even it alone exceeds the budget', () => {
    // Each item alone is bigger than the whole budget — the old code broke
    // out of the keep-loop immediately and returned only the omission
    // marker, handing the model none of the data it asked for.
    const big = {
      id: '1',
      metadata: Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`h${k}`, 'v'.repeat(200)])),
    };
    const parsed = JSON.parse(boundToolResultForPrompt([big, big], 2_048)) as unknown[];

    expect(parsed.some((e) => typeof e === 'object')).toBe(true);
  });

  it('hard-truncates a non-array result that still exceeds the budget', () => {
    // Many short fields: survives the per-string cap, dies at the total cap.
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v'.repeat(20)]));
    const text = boundToolResultForPrompt(wide, 2_048);

    expect(text.length).toBeLessThanOrEqual(2_048);
    expect(text.endsWith('…[truncated]')).toBe(true);
  });

  it('serializes error results untouched', () => {
    const result = { error: 'TOOL_FORBIDDEN: requires full, caller has read' };

    expect(JSON.parse(boundToolResultForPrompt(result, 2_048))).toEqual(result);
  });

  it('keeps an envelope header intact and bounds only its items', () => {
    // The search intents return { summary, totalMatches, truncated, items }.
    // The header is where the match count lives; hard-truncating the object
    // as a whole is exactly what would cut it off.
    const result = {
      summary: 'Showing the top 25 of 342 matches (exact count). Report the total, not the number shown.',
      totalMatches: 342,
      truncated: true,
      limit: 25,
      mode: 'keyword',
      items: Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, content: 'y'.repeat(300) })),
    };
    const text = boundToolResultForPrompt(result, 2_048);

    expect(text.length).toBeLessThanOrEqual(2_048);

    const parsed = JSON.parse(text) as typeof result & { items: unknown[] };

    expect(parsed.summary).toBe(result.summary);
    expect(parsed.totalMatches).toBe(342);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(1);
    expect(parsed.items.length).toBeLessThan(25);
    expect(parsed.items[parsed.items.length - 1]).toMatch(/\d+ more results omitted/);
  });

  it('passes a small envelope through unchanged, items and all', () => {
    const result = {
      summary: '2 matches; all shown.',
      totalMatches: 2,
      truncated: false,
      items: [{ id: 'a' }, { id: 'b' }],
    };

    expect(JSON.parse(boundToolResultForPrompt(result, 2_048))).toEqual(result);
  });

  it('a count-only envelope has no items to trim and survives whole', () => {
    const result = {
      summary: '342 file entries match "rabbit".',
      totalMatches: 342,
      truncated: false,
      limit: 0,
      mode: 'count',
      items: [],
    };

    expect(JSON.parse(boundToolResultForPrompt(result, 2_048))).toEqual(result);
  });

  it('serializes Date fields as ISO strings, not empty objects', () => {
    // Walking a Date's entries flattens it to {} — measured live as
    // `"time": {}` on every search result handed to the model.
    const when = new Date('2026-05-26T20:45:23.786Z');
    const parsed = JSON.parse(boundToolResultForPrompt([{ id: '1', time: when }], 2_048)) as Array<{
      time: string;
    }>;

    expect(parsed[0].time).toBe('2026-05-26T20:45:23.786Z');
  });
});
