import {
  ScanOperatingPoints,
  cognitiveCap,
  inputTokenBudget,
  packBatch,
  parseParameterBillions,
  sourceLoad,
  startingItems,
} from '../scanBatchPolicy';

describe('scan batch policy', () => {
  it('uses parameter count only as a cold-start cap', () => {
    expect(cognitiveCap(null)).toBe(4);
    expect(cognitiveCap(7)).toBe(4);
    expect(cognitiveCap(14)).toBe(8);
    expect(cognitiveCap(70)).toBe(12);
  });

  it('starts inside a range for the window and never above the cap', () => {
    expect(startingItems(32_000, 4)).toBe(2);
    expect(startingItems(40_000, 4)).toBe(3);
    expect(startingItems(64_000, 8)).toBe(4);
    expect(startingItems(100_000, 12)).toBe(6);
    expect(startingItems(100_000, 4)).toBe(4);
  });

  it('keeps normal input near 30% of the window', () => {
    expect(inputTokenBudget(32_768)).toBe(Math.floor(32_768 * 0.3));
    expect(inputTokenBudget(100_000)).toBe(30_000);
  });

  it('fills a batch with a long thread before the item cap', () => {
    const heavy = sourceLoad(3_600, { longThread: true, attachment: true });
    const sources = [1, 2, 3, 4].map((id) => ({ id: String(id), ...heavy }));
    const batch = packBatch(sources, { maxItems: 12, maxInputTokens: 30_000 });

    expect(batch.length).toBeLessThan(4);
    expect(batch.length).toBeGreaterThan(0);
  });

  it('stops a pile of short notes at the cognitive cap', () => {
    const light = sourceLoad(80);
    const sources = Array.from({ length: 10 }, (_, index) => ({ id: String(index), ...light }));
    const batch = packBatch(sources, { maxItems: 4, maxInputTokens: 30_000 });

    expect(batch).toHaveLength(4);
  });

  it('pins the operating point down after a failure and probes up after clean batches', () => {
    const points = new ScanOperatingPoints();

    expect(points.recommend('inbox:model', 4)).toBe(4);
    expect(points.noteFailed('inbox:model', 4)).toBe(2);
    expect(points.recommend('inbox:model', 4)).toBe(2);
    points.noteClean('inbox:model', 2, 8);
    expect(points.noteClean('inbox:model', 2, 8)).toBe(3);
  });

  it('parses Ollama parameter_size', () => {
    expect(parseParameterBillions('7.6B')).toBeCloseTo(7.6);
    expect(parseParameterBillions('405M')).toBeCloseTo(0.405);
    expect(parseParameterBillions('')).toBeNull();
  });
});
