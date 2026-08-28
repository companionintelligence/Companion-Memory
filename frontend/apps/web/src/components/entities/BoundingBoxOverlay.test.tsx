import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { BoundingBoxOverlay } from './BoundingBoxOverlay';

describe('BoundingBoxOverlay', () => {
  it('positions the box in percentages of the frame', () => {
    renderWithProviders(<BoundingBoxOverlay bbox={{ x: 0.25, y: 0.1, w: 0.5, h: 0.4 }} />);

    const box = screen.getByTestId('bounding-box');

    expect(box).toHaveStyle({ left: '25%', top: '10%', width: '50%', height: '40%' });
  });

  it('renders nothing when there is no box', () => {
    renderWithProviders(<BoundingBoxOverlay bbox={null} />);

    expect(screen.queryByTestId('bounding-box')).toBeNull();
  });

  it('clamps a box that runs off the frame instead of stretching the tile', () => {
    // Detectors and importers both emit these; a raw 0.9 + 0.4 would overflow.
    renderWithProviders(<BoundingBoxOverlay bbox={{ x: 0.9, y: -0.2, w: 0.4, h: 1.5 }} />);

    const box = screen.getByTestId('bounding-box');

    expect(box).toHaveStyle({ left: '90%', top: '0%', width: '10%', height: '100%' });
  });

  it('renders nothing for a box with no area left after clamping', () => {
    renderWithProviders(<BoundingBoxOverlay bbox={{ x: 1, y: 0, w: 0.5, h: 0.5 }} />);

    expect(screen.queryByTestId('bounding-box')).toBeNull();
  });

  it('drops a non-finite coordinate rather than emitting NaN% into the style', () => {
    renderWithProviders(<BoundingBoxOverlay bbox={{ x: Number.NaN, y: 0, w: 0.5, h: 0.5 }} />);

    const box = screen.getByTestId('bounding-box');

    expect(box).toHaveStyle({ left: '0%', width: '50%' });
  });

  it('captions the box with its label', () => {
    renderWithProviders(<BoundingBoxOverlay bbox={{ x: 0, y: 0, w: 1, h: 1 }} label="cordless drill" />);

    expect(screen.getByText('cordless drill')).toBeInTheDocument();
  });

  it('gives a labelled box an accessible NAME, not just a visible caption', () => {
    // `role="presentation"` removes an element from the accessibility tree and
    // takes any `aria-label` with it, so a labelled box has to carry a real
    // role or the name it declares is unreachable.
    renderWithProviders(<BoundingBoxOverlay bbox={{ x: 0, y: 0, w: 1, h: 1 }} label="cordless drill" />);

    expect(screen.getByRole('figure', { name: 'cordless drill' })).toBeInTheDocument();
  });

  it('leaves an unlabelled box decorative rather than announcing an unnamed region', () => {
    renderWithProviders(<BoundingBoxOverlay bbox={{ x: 0, y: 0, w: 1, h: 1 }} />);

    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.getByTestId('bounding-box')).toHaveAttribute('role', 'presentation');
  });

  it('treats a whitespace-only label as no label at all', () => {
    renderWithProviders(<BoundingBoxOverlay bbox={{ x: 0, y: 0, w: 1, h: 1 }} label="   " />);

    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.getByTestId('bounding-box')).not.toHaveAttribute('aria-label');
  });
});
