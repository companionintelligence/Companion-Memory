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

  it('keeps the payload out of the DOM entirely until Show code is pressed', () => {
    const { container } = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} reveal />);

    expect(svgOf(container).getAttribute('class')).toContain('blur-md');
    expect(screen.getByRole('button', { name: 'Show code' })).toBeInTheDocument();
    // A blur is a CSS filter, so the plaintext half is the whole gate: if the
    // fallback is rendered, the secret is on the shared screen regardless.
    expect(screen.queryByText(PAYLOAD)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain(PAYLOAD);

    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));

    expect(svgOf(container).getAttribute('class')).not.toContain('blur-md');
    expect(screen.getByText(PAYLOAD)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide code' })).toBeInTheDocument();
  });

  it('does not describe the code by a fallback that is not rendered', () => {
    const { container } = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} reveal />);

    // A dangling aria-describedby is worse than none, and satisfying it with
    // off-screen text would hand the secret to a screen reader.
    expect(svgOf(container).getAttribute('aria-describedby')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));

    const describedBy = svgOf(container).getAttribute('aria-describedby');

    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(describedBy as string)}`)).toHaveTextContent(PAYLOAD);
  });

  it('is not blurred when reveal is left off, and the fallback is the escape hatch', () => {
    const { container } = render(<QrCode value={PAYLOAD} fallback={PAYLOAD} />);

    expect(svgOf(container).getAttribute('class')).not.toContain('blur-md');
    expect(screen.queryByRole('button', { name: 'Show code' })).not.toBeInTheDocument();
    // Nothing to gate here: this is the recovery path for a camera that won't
    // focus, so it is present from first paint.
    expect(screen.getByText(PAYLOAD)).toBeInTheDocument();
  });
});
