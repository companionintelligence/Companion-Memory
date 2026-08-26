import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QrCode } from './QrCode';

const PAYLOAD = 'https://companion.local/shared/abc123';

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg[viewBox]');

  if (!svg) {
    throw new Error('no QR svg rendered');
  }

  return svg as SVGSVGElement;
}

/** The light plate and dark modules are the two fills qrcode.react emits. */
function fills(container: HTMLElement): string[] {
  return Array.from(svgOf(container).querySelectorAll('path')).map((path) => path.getAttribute('fill') ?? '');
}

describe('QrCode', () => {
  it('renders the fallback payload as selectable text', () => {
    const { container } = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} />);

    expect(screen.getByText(PAYLOAD)).toBeInTheDocument();
    expect(svgOf(container)).toBeInTheDocument();
  });

  it('keeps a light plate and dark modules — never themed, never inverted', () => {
    const { container } = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} />);
    const painted = fills(container);

    expect(painted).toContain('#ffffff');
    expect(painted).toContain('#0a0a0a');
    // No teal on a data module, and no var() that a dark theme could flip.
    expect(painted.some((fill) => fill.includes('var(') || /0f717a|abd4d8/i.test(fill))).toBe(false);
  });

  it('forces level H when the mark is excavated', () => {
    // 'L' would be honoured without a mark; with one it must be overridden,
    // because the excavated centre costs roughly half the correction budget.
    const marked = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} mark level="L" />);
    const plain = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} level="L" />);

    const markedModules = svgOf(marked.container).getAttribute('viewBox');
    const plainModules = svgOf(plain.container).getAttribute('viewBox');

    // A higher correction level needs more modules for the same payload, so the
    // module-space viewBox grows. Same payload, same size — only `level` differs.
    expect(markedModules).not.toBe(plainModules);
    expect(marked.container.querySelector('image')).toBeInTheDocument();
  });

  it('renders the caption above the code', () => {
    render(<QrCode value={PAYLOAD} fallback={PAYLOAD} caption="Scan to open" />);

    expect(screen.getByText('Scan to open')).toBeInTheDocument();
  });

  it('blurs behind a Show code button when reveal is set, but never hides the fallback', () => {
    const { container } = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} reveal />);

    expect(svgOf(container).getAttribute('class')).toContain('blur-md');
    expect(screen.getByRole('button', { name: 'Show code' })).toBeInTheDocument();
    // The escape hatch is not a secret the reveal gates — it is the recovery path.
    expect(screen.getByText(PAYLOAD)).toBeInTheDocument();
  });

  it('unblurs on Show code', () => {
    const { container } = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} reveal />);

    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));

    expect(svgOf(container).getAttribute('class')).not.toContain('blur-md');
    expect(screen.getByRole('button', { name: 'Hide code' })).toBeInTheDocument();
  });

  it('is not blurred when reveal is left off', () => {
    const { container } = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} />);

    expect(svgOf(container).getAttribute('class')).not.toContain('blur-md');
    expect(screen.queryByRole('button', { name: 'Show code' })).not.toBeInTheDocument();
  });
});
