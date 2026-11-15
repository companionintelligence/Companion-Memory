import { fuseRerankOrder } from '../rerankFusion';

type Item = { id: string };

const key = (item: Item) => item.id;
const head = (...ids: string[]): Item[] => ids.map((id) => ({ id }));
const ids = (items: Item[]) => items.map((item) => item.id);

describe('fuseRerankOrder', () => {
  it('orders by 0.5 * relevance + 0.5 * orderScore, with orderScore 1 first and 0 last', () => {
    // N = 3, so orderScore is 1, 0.5, 0 for A, B, C.
    // final: A = 0.5*0.2 + 0.5*1 = 0.60, B = 0.5*0.9 + 0.5*0.5 = 0.70, C = 0.5*0.5 + 0.5*0 = 0.25.
    const scores = new Map([
      ['A', 0.2],
      ['B', 0.9],
      ['C', 0.5],
    ]);

    expect(ids(fuseRerankOrder(head('A', 'B', 'C'), key, scores))).toEqual(['B', 'A', 'C']);
  });

  it('lets a strongly relevant candidate pass the candidates ranked above it', () => {
    // N = 4: orderScore 1, 2/3, 1/3, 0 for A, B, C, D.
    // A = 0.5*0 + 0.5*1 = 0.50, B = 0.5*0 + 0.5*(2/3) = 0.33, C = 0.5*0 + 0.5*(1/3) = 0.17,
    // D = 0.5*1 + 0.5*0 = 0.50. D ties with A and A is earlier, so A keeps first place.
    const scores = new Map([
      ['A', 0],
      ['B', 0],
      ['C', 0],
      ['D', 1],
    ]);

    expect(ids(fuseRerankOrder(head('A', 'B', 'C', 'D'), key, scores))).toEqual(['A', 'D', 'B', 'C']);
  });

  it('moves only scored candidates, among the slots they already occupy', () => {
    // X has no score and stays at index 1. N = 4: A = 0.55, B = 0.6417, C = 0.45.
    const scores = new Map([
      ['A', 0.1],
      ['B', 0.95],
      ['C', 0.9],
    ]);

    expect(ids(fuseRerankOrder(head('A', 'X', 'B', 'C'), key, scores))).toEqual(['B', 'X', 'A', 'C']);
  });

  it('breaks exact ties by the earlier RRF position', () => {
    // N = 3: A = 0.5*0 + 0.5*1 = 0.5, B = 0.5*0.5 + 0.5*0.5 = 0.5, C = 0.5*0.9 + 0 = 0.45.
    const scores = new Map([
      ['A', 0],
      ['B', 0.5],
      ['C', 0.9],
    ]);

    expect(ids(fuseRerankOrder(head('A', 'B', 'C'), key, scores))).toEqual(['A', 'B', 'C']);
  });

  it('leaves the head unchanged with fewer than two scored candidates', () => {
    expect(ids(fuseRerankOrder(head('A', 'B', 'C'), key, new Map([['C', 1]])))).toEqual(['A', 'B', 'C']);
    expect(ids(fuseRerankOrder(head('A'), key, new Map([['A', 0]])))).toEqual(['A']);
    expect(ids(fuseRerankOrder(head(), key, new Map()))).toEqual([]);
  });

  it('clamps a relevance above 1 to 1, so it cannot outweigh the order it is combined with', () => {
    // N = 3: B has relevance 1.4 (clamped to 1) and orderScore 1, so final = 0.5 + 0.5 = 1.00.
    // A has relevance 2 (clamped to 1) and orderScore 0.5, so final = 0.5 + 0.25 = 0.75.
    // Unclamped, A would be 1.25 and B 1.20, which would put A first.
    const scores = new Map([
      ['B', 1.4],
      ['A', 2],
    ]);

    expect(ids(fuseRerankOrder(head('B', 'A', 'C'), key, scores))).toEqual(['B', 'A', 'C']);
  });

  it('clamps a relevance below 0 to 0', () => {
    // N = 3: A has relevance -1 (clamped to 0) and orderScore 1, so final = 0 + 0.5 = 0.50.
    // B has relevance 0.2 and orderScore 0.5, so final = 0.10 + 0.25 = 0.35.
    // Unclamped, A would be 0.00 and B would move ahead of it.
    const scores = new Map([
      ['A', -1],
      ['B', 0.2],
    ]);

    expect(ids(fuseRerankOrder(head('A', 'B', 'C'), key, scores))).toEqual(['A', 'B', 'C']);
  });

  it('leaves a candidate with a NaN score in its own slot while the scored ones move', () => {
    // N = 4: orderScore A 1, B (unscored), C 1/3, D 0.
    // final: A = 0.5*0.2 + 0.5*1 = 0.60, C = 0.5*0.9 + 0.5*(1/3) = 0.617, D = 0.5*0.1 + 0 = 0.05.
    // Scored slots are 0, 2 and 3, so C takes slot 0 and A slot 2. B stays in slot 1.
    const scores = new Map([
      ['A', 0.2],
      ['B', Number.NaN],
      ['C', 0.9],
      ['D', 0.1],
    ]);

    expect(ids(fuseRerankOrder(head('A', 'B', 'C', 'D'), key, scores))).toEqual(['C', 'B', 'A', 'D']);
  });

  it('does not mutate the input head', () => {
    const input = head('A', 'B', 'C');
    const scores = new Map([
      ['A', 0.2],
      ['B', 0.9],
    ]);

    fuseRerankOrder(input, key, scores);

    expect(ids(input)).toEqual(['A', 'B', 'C']);
  });
});
