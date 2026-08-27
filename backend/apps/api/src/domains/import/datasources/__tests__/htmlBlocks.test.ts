import { matchingDivCloseIndex } from '../htmlBlocks';

describe('matchingDivCloseIndex', () => {
  it('finds the close of a div with no nested divs', () => {
    const raw = '<div>hello</div>';
    const start = raw.indexOf('>') + 1;

    expect(matchingDivCloseIndex(raw, start)).toBe(raw.indexOf('</div>'));
  });

  it('skips past a nested div of the same tag instead of stopping at its close', () => {
    // The exact Google Voice MMS shape: attachments 2..N each sit in their
    // own sibling div INSIDE the message block. A non-greedy regex stops at
    // the first </div>, right after image 1.
    const raw = '<div class="message">before<div><img src="a-1"/></div> <div><img src="a-2"/></div>after</div>next';
    const start = raw.indexOf('>') + 1;
    const end = matchingDivCloseIndex(raw, start);

    expect(raw.slice(start, end)).toBe('before<div><img src="a-1"/></div> <div><img src="a-2"/></div>after');
    expect(raw.slice(end)).toBe('</div>next');
  });

  it('handles multiple levels of nesting', () => {
    const raw = '<div>a<div>b<div>c</div>d</div>e</div>tail';
    const start = raw.indexOf('>') + 1;
    const end = matchingDivCloseIndex(raw, start);

    expect(raw.slice(start, end)).toBe('a<div>b<div>c</div>d</div>e');
    expect(raw.slice(end)).toBe('</div>tail');
  });

  it('returns the end of the string for unbalanced/truncated markup, not a false early close', () => {
    const raw = '<div>a<div>b';
    const start = raw.indexOf('>') + 1;

    expect(matchingDivCloseIndex(raw, start)).toBe(raw.length);
  });

  it('matches a div tag carrying attributes', () => {
    const raw = '<div class="outer" id="x">a<div class="inner">b</div>c</div>tail';
    const start = raw.indexOf('>') + 1;
    const end = matchingDivCloseIndex(raw, start);

    expect(raw.slice(start, end)).toBe('a<div class="inner">b</div>c');
  });
});
