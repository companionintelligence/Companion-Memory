import { describe, expect, it } from 'vitest';

import { countsLine, deriveChecklist, type FirstSyncInputs, type MemoryTotals } from './firstSync';

const EMPTY: MemoryTotals = {
  communications: 0,
  events: 0,
  content: 0,
  objects: 0,
  browser_activity: 0,
  position: 0,
};

const base: FirstSyncInputs = {
  hasModel: true,
  modelsLoading: false,
  connectionCount: 0,
  unpushedRuns: 0,
  runningImports: 0,
  runningRecords: 0,
  totals: EMPTY,
  indexingItems: 0,
};

const step = (input: FirstSyncInputs, id: 'model' | 'data' | 'memory') =>
  deriveChecklist(input).steps.find((s) => s.id === id)!;

describe('deriveChecklist', () => {
  it('asks for a model, a source and nothing else on a brand-new account', () => {
    const list = deriveChecklist(base);

    expect(step(base, 'data').status).toBe('todo');
    expect(step(base, 'memory').status).toBe('todo');
    expect(list.allDone).toBe(false);
    expect(list.countsLine).toBeNull();
  });

  it('does not call an unanswered model list "no model"', () => {
    expect(step({ ...base, hasModel: false, modelsLoading: true }, 'model').status).toBe('unknown');
    expect(step({ ...base, hasModel: false, modelsLoading: false }, 'model').status).toBe('todo');
  });

  it('does not read unanswered counts as an empty account', () => {
    const unanswered = { ...base, connectionCount: null, totals: null };

    expect(step(unanswered, 'data').status).toBe('unknown');
    expect(step(unanswered, 'memory').status).toBe('unknown');
    expect(deriveChecklist(unanswered).allDone).toBe(false);
  });

  it('flags an import that parsed but was never saved — the gap the wizard leaves', () => {
    const memory = step({ ...base, unpushedRuns: 2 }, 'memory');

    expect(memory.status).toBe('attention');
    expect(memory.title).toBe('2 imports are read but not saved yet');
    // Being unpushed also means a source WAS added.
    expect(step({ ...base, unpushedRuns: 2 }, 'data').status).toBe('done');
  });

  it('uses the singular for one unsaved import', () => {
    expect(step({ ...base, unpushedRuns: 1 }, 'memory').title).toBe('1 import is read but not saved yet');
  });

  it('reports a running import with the records read so far', () => {
    const memory = step({ ...base, runningImports: 1, runningRecords: 12_400 }, 'memory');

    expect(memory.status).toBe('working');
    expect(memory.detail).toContain('12,400 records read so far');
  });

  it('says a connected account is waiting on its first sync while nothing has arrived', () => {
    const input = { ...base, connectionCount: 1 };

    expect(step(input, 'data').status).toBe('done');
    expect(step(input, 'memory')).toMatchObject({ status: 'working', title: 'Waiting for the first sync' });
  });

  it('keeps saying indexing until the search queue drains, then finishes', () => {
    const saved = { ...base, connectionCount: 1, totals: { ...EMPTY, communications: 500 } };

    expect(step({ ...saved, indexingItems: 1_200 }, 'memory')).toMatchObject({
      status: 'working',
      title: 'Still indexing 1,200 items',
    });
    expect(step({ ...saved, indexingItems: 0 }, 'memory').status).toBe('done');
    expect(deriveChecklist({ ...saved, indexingItems: 0 }).allDone).toBe(true);
  });

  it('puts an unsaved import ahead of a running one', () => {
    expect(step({ ...base, unpushedRuns: 1, runningImports: 1 }, 'memory').status).toBe('attention');
  });

  it('counts completed steps', () => {
    const list = deriveChecklist({ ...base, hasModel: false, connectionCount: 1 });

    expect(list.doneCount).toBe(1);
  });
});

describe('countsLine', () => {
  it('is null for an empty or unknown memory', () => {
    expect(countsLine(EMPTY)).toBeNull();
    expect(countsLine(null)).toBeNull();
  });

  it('lists the three biggest kinds, biggest first, with singular/plural and thousands separators', () => {
    expect(
      countsLine({
        communications: 12_400,
        events: 1,
        content: 3_102,
        objects: 7,
        browser_activity: 0,
        position: 0,
      }),
    ).toBe('12,400 messages · 3,102 pieces of content · 7 things');
  });

  it('uses "1 event" not "1 events"', () => {
    expect(countsLine({ ...EMPTY, events: 1 })).toBe('1 event');
  });
});
