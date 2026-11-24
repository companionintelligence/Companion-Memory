import type { ToolResult } from '../../core/types';
import { withAbsoluteItemLinks } from '../absoluteItemLinks';

const BASE = 'https://ci-memory-box.example';

function searchResult(items: unknown[]): ToolResult {
  return { success: true, data: { summary: 'Found 2', totalMatches: 2, truncated: false, items } };
}

describe('withAbsoluteItemLinks', () => {
  it("makes each hit's site-relative link absolute against the public origin", () => {
    const result = withAbsoluteItemLinks(
      searchResult([
        { id: 'f1', type: 'file', link: '/content/c1' },
        { id: 'p1', type: 'place', link: '/places/p1' },
      ]),
      BASE,
    );

    expect((result.data as { items: Array<{ link: string }> }).items.map((item) => item.link)).toEqual([
      `${BASE}/content/c1`,
      `${BASE}/places/p1`,
    ]);
    // The rest of the result is untouched.
    expect(result.data).toMatchObject({ summary: 'Found 2', totalMatches: 2, truncated: false });
  });

  it('does not double the slash when the origin is configured with a trailing one', () => {
    const result = withAbsoluteItemLinks(searchResult([{ link: '/content/c1' }]), `${BASE}/`);

    expect((result.data as { items: Array<{ link: string }> }).items[0].link).toBe(`${BASE}/content/c1`);
  });

  it('leaves hits without a link, absolute links and protocol-relative links alone', () => {
    const items = [
      { id: 'thread' },
      { link: 'https://elsewhere.example/x' },
      { link: '//cdn.example/x' },
      null,
    ];

    expect((withAbsoluteItemLinks(searchResult(items), BASE).data as { items: unknown[] }).items).toEqual(
      items,
    );
  });

  it('returns the result unchanged with no public origin configured', () => {
    const result = searchResult([{ link: '/content/c1' }]);

    expect(withAbsoluteItemLinks(result, '')).toBe(result);
    expect(withAbsoluteItemLinks(result, undefined)).toBe(result);
  });

  it('returns results with no items list, and failures, unchanged', () => {
    const plain: ToolResult = { success: true, data: { people: [] } };
    const failed: ToolResult = { success: false, error: { code: 'X', message: 'no', retryable: false } };

    expect(withAbsoluteItemLinks(plain, BASE)).toBe(plain);
    expect(withAbsoluteItemLinks(failed, BASE)).toBe(failed);
  });
});
