import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MAP_IMAGERY_ATTRIBUTION } from './Map';
import { MapAttribution } from './MapAttribution';

describe('MapAttribution', () => {
  it('keeps required imagery credit in a compact non-overlay footer', () => {
    render(<MapAttribution />);

    const credit = screen.getByTestId('map-attribution');

    expect(credit).toHaveClass('shrink-0', 'text-[8px]');
    expect(credit).toHaveTextContent(`Leaflet | ${MAP_IMAGERY_ATTRIBUTION}`);
    expect(screen.getByRole('link', { name: 'Leaflet' })).toHaveAttribute('href', 'https://leafletjs.com');
  });
});
