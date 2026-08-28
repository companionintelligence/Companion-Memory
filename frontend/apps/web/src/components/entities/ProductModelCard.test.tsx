import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import type { ProductModelCardDataFragment } from '@/graphql/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { PRODUCT_MODEL_FRAGMENT, ProductModelCard } from './ProductModelCard';

// Cast rather than typed literal: how the card gets at the stock photo is
// being reworked (a resolver field replacing the second content round-trip),
// and none of the assertions below are about the picture.
const makeProduct = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'ProductModelType' as const,
      id: btoa('product:p1'),
      title: 'Makita XPH12Z drill',
      brand: 'Makita',
      manufacturer: 'Makita Corp',
      modelNumber: 'XPH12Z',
      category: 'tools',
      subcategory: null,
      productType: null,
      isDigital: false,
      msrpMinor: 12999,
      currency: 'EUR',
      identityConfidence: 1,
      identifiers: [],
      ...overrides,
    } as unknown as ProductModelCardDataFragment,
    PRODUCT_MODEL_FRAGMENT,
  );

const identifier = (namespace: string, value: string, rawValue: string | null = null) => ({
  __typename: 'ObjectIdentifierType' as const,
  namespace,
  value,
  rawValue,
});

describe('ProductModelCard', () => {
  it('names the model, its maker and its part number', () => {
    renderWithProviders(<ProductModelCard product={makeProduct()} />);

    expect(screen.getByText('Makita XPH12Z drill')).toBeInTheDocument();
    expect(screen.getByText('Makita · XPH12Z')).toBeInTheDocument();
    expect(screen.getByText('Product')).toBeInTheDocument();
  });

  it('falls back to the manufacturer when there is no brand', () => {
    renderWithProviders(<ProductModelCard product={makeProduct({ brand: null })} />);

    expect(screen.getByText('Makita Corp · XPH12Z')).toBeInTheDocument();
  });

  it('says "Catalog model" rather than an empty subtitle when it knows neither', () => {
    renderWithProviders(
      <ProductModelCard product={makeProduct({ brand: null, manufacturer: null, modelNumber: null })} />,
    );

    expect(screen.getByText('Catalog model')).toBeInTheDocument();
  });

  it('formats the MSRP in the catalog currency (minor units), not dollars', () => {
    renderWithProviders(<ProductModelCard product={makeProduct()} />);

    const msrp = screen.getByText(/MSRP/);

    expect(msrp).toHaveTextContent(/129[.,]99/);
    expect(msrp).toHaveTextContent('€');
  });

  it('does not divide a JPY MSRP by 100', () => {
    renderWithProviders(<ProductModelCard product={makeProduct({ msrpMinor: 12999, currency: 'JPY' })} />);

    const msrp = screen.getByText(/MSRP/);

    expect(msrp).toHaveTextContent(/12[.,\u00a0\u202f]?999/);
    expect(msrp).not.toHaveTextContent(/129[.,]99/);
  });

  it('omits the MSRP line entirely when the catalog has no price', () => {
    renderWithProviders(<ProductModelCard product={makeProduct({ msrpMinor: null })} />);

    expect(screen.queryByText(/MSRP/)).toBeNull();
  });

  it('shows the barcode as the one code a shopper recognises', () => {
    renderWithProviders(
      <ProductModelCard
        product={makeProduct({
          identifiers: [identifier('MPN', 'XPH12Z'), identifier('GTIN', '0088381000000', ' 088381000000 ')],
        })}
      />,
    );

    // GTIN wins over MPN, and the RAW form (what is printed on the box) wins
    // over the normalized one — trimmed.
    expect(screen.getByText('GTIN 088381000000')).toBeInTheDocument();
    expect(screen.queryByText('MPN XPH12Z')).toBeNull();
  });

  it('falls back to the manufacturer part when there is no barcode', () => {
    renderWithProviders(
      <ProductModelCard product={makeProduct({ identifiers: [identifier('MPN', 'XPH12Z')] })} />,
    );

    expect(screen.getByText('MPN XPH12Z')).toBeInTheDocument();
  });

  it('falls back to the normalized value when the raw form is blank', () => {
    renderWithProviders(
      <ProductModelCard
        product={makeProduct({ identifiers: [identifier('GTIN', '0088381000000', '  ')] })}
      />,
    );

    expect(screen.getByText('GTIN 0088381000000')).toBeInTheDocument();
  });

  it('flags a model that is only a guess, and stays quiet about a certain one', () => {
    const { unmount } = renderWithProviders(<ProductModelCard product={makeProduct()} />);

    expect(screen.queryByText(/confident/)).toBeNull();

    unmount();

    renderWithProviders(<ProductModelCard product={makeProduct({ identityConfidence: 0.42 })} />);

    expect(screen.getByText('42% confident')).toBeInTheDocument();
  });

  it('calls a digital product what it is', () => {
    renderWithProviders(<ProductModelCard product={makeProduct({ isDigital: true })} />);

    expect(screen.getByText('Digital product')).toBeInTheDocument();
  });

  it('renders no image at all when the model has no picture', () => {
    renderWithProviders(<ProductModelCard product={makeProduct()} />);

    expect(screen.queryByRole('img')).toBeNull();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<ProductModelCard product={makeProduct()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Makita XPH12Z drill'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
