import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PendingImage } from './PendingImage';

function imageIn(container: HTMLElement) {
  const img = container.querySelector('img');

  if (!(img instanceof HTMLImageElement)) {
    throw new Error('expected an image');
  }

  return img;
}

describe('PendingImage', () => {
  it('holds an image icon, with the picture hidden, until the file has decoded', () => {
    const { container } = render(<PendingImage src="/static/p/thumb.jpg" />);
    const img = imageIn(container);

    expect(img).toHaveAttribute('src', '/static/p/thumb.jpg');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveClass('opacity-0');
    expect(container.querySelector('svg')).toBeInTheDocument();

    fireEvent.load(img);

    expect(img).toHaveClass('opacity-100');
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('keeps the image icon and drops the picture when the file cannot be shown', () => {
    const onError = vi.fn();
    const { container } = render(<PendingImage src="/static/p/missing.jpg" onError={onError} />);

    fireEvent.error(imageIn(container));

    expect(onError).toHaveBeenCalledOnce();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
