import { describe, expect, it } from 'vitest';

import { MAX_ZOOM, MIN_ZOOM, fitTransform, type FitNode } from './fitTransform';

const WIDTH = 1100;
const HEIGHT = 640;

/** Where a node's centre lands on the canvas under a transform. */
function project(node: FitNode, fit: { scale: number; translate: { x: number; y: number } }) {
  return {
    x: node.x * fit.scale + fit.translate.x,
    y: node.y * fit.scale + fit.translate.y,
  };
}

function node(x: number, y: number, name = ''): FitNode {
  return { x, y, name, entity_type: 'PersonType' };
}

describe('fitTransform', () => {
  it('returns null when there is nothing to frame', () => {
    expect(fitTransform([], WIDTH, HEIGHT)).toBeNull();
    expect(fitTransform([{ x: Number.NaN, y: 0 }], WIDTH, HEIGHT)).toBeNull();
  });

  it('centres the cluster on the canvas', () => {
    // The defect this exists for: the simulation leaves a compact cluster sitting
    // low in a 640px canvas with the top third empty.
    const nodes = [node(500, 420), node(560, 470), node(620, 440), node(540, 500)];

    const fit = fitTransform(nodes, WIDTH, HEIGHT);
    if (!fit) {
      throw new Error('expected a fit');
    }

    const projected = nodes.map((n) => project(n, fit));
    const midX = (Math.min(...projected.map((p) => p.x)) + Math.max(...projected.map((p) => p.x))) / 2;
    const midY = (Math.min(...projected.map((p) => p.y)) + Math.max(...projected.map((p) => p.y))) / 2;

    expect(midX).toBeCloseTo(WIDTH / 2, 5);
    expect(midY).toBeCloseTo(HEIGHT / 2, 5);
  });

  it('leaves room for the labels, which only extend to the right', () => {
    const nodes = [node(500, 420, 'Katherine O’Malley'), node(560, 470, 'Brad Reynolds')];

    const fit = fitTransform(nodes, WIDTH, HEIGHT);
    if (!fit) {
      throw new Error('expected a fit');
    }

    const projected = nodes.map((n) => project(n, fit));
    const midX = (Math.min(...projected.map((p) => p.x)) + Math.max(...projected.map((p) => p.x))) / 2;

    expect(midX).toBeLessThan(WIDTH / 2);
  });

  it('keeps every node and its label inside the canvas', () => {
    const nodes = [
      node(200, 100, 'Katherine O’Malley'),
      node(900, 560, 'Brad Reynolds'),
      node(550, 300, 'John Smith'),
    ];

    const fit = fitTransform(nodes, WIDTH, HEIGHT);
    if (!fit) {
      throw new Error('expected a fit');
    }

    for (const n of nodes) {
      const p = project(n, fit);
      const labelPx = (n.name ?? '').length * 6.4;

      expect(p.x - 14 * fit.scale).toBeGreaterThanOrEqual(0);
      expect(p.x + (14 + labelPx) * fit.scale).toBeLessThanOrEqual(WIDTH + 0.001);
      expect(p.y - 14 * fit.scale).toBeGreaterThanOrEqual(0);
      expect(p.y + 14 * fit.scale).toBeLessThanOrEqual(HEIGHT + 0.001);
    }
  });

  it('scales a small cluster up and a sprawling one down', () => {
    const tight = fitTransform([node(500, 300), node(540, 330), node(520, 360)], WIDTH, HEIGHT);
    const sprawling = fitTransform([node(-800, -600), node(1800, 1400), node(500, 300)], WIDTH, HEIGHT);

    if (!tight || !sprawling) {
      throw new Error('expected fits');
    }

    expect(tight.scale).toBeGreaterThan(1);
    expect(sprawling.scale).toBeLessThan(1);
  });

  it('keeps a pinned centre node in the middle, and still fills the canvas', () => {
    // The simulation pins `centerNodeId` to the canvas centre every tick; the fit
    // has to reframe around that rather than re-centre the bounding box on top
    // of it. The lopsided cluster below would otherwise drag the anchor off centre.
    const anchor = { x: WIDTH / 2, y: HEIGHT / 2 };
    const nodes = [
      node(anchor.x, anchor.y, 'John Smith'),
      node(anchor.x + 180, anchor.y + 40),
      node(anchor.x + 240, anchor.y - 60),
      node(anchor.x - 60, anchor.y + 30),
    ];

    const fit = fitTransform(nodes, WIDTH, HEIGHT, anchor);
    if (!fit) {
      throw new Error('expected a fit');
    }

    const projectedAnchor = project(nodes[0], fit);

    expect(projectedAnchor.x).toBeCloseTo(WIDTH / 2, 5);
    expect(projectedAnchor.y).toBeCloseTo(HEIGHT / 2, 5);

    // Still bigger than the unfitted 1:1 view — that is the whole point.
    expect(fit.scale).toBeGreaterThan(1);

    for (const n of nodes) {
      const p = project(n, fit);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(WIDTH);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(HEIGHT);
    }
  });

  it('never leaves the zoom range the wheel handler enforces', () => {
    const single = fitTransform([node(400, 300, 'A')], WIDTH, HEIGHT);
    const enormous = fitTransform([node(-100000, -100000), node(100000, 100000)], WIDTH, HEIGHT);

    if (!single || !enormous) {
      throw new Error('expected fits');
    }

    expect(single.scale).toBeLessThanOrEqual(MAX_ZOOM);
    expect(enormous.scale).toBeGreaterThanOrEqual(MIN_ZOOM);
  });
});
