import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureWithSystemCamera,
  pickDocuments,
  pickFromUserDevice,
  pickMediaFromLibrary,
  pickPhotosFromLibrary,
} from './pickPhotosFromLibrary';

function clickableInput(): { click: ReturnType<typeof vi.fn>; pendingInput: () => HTMLInputElement } {
  const click = vi.fn();
  const original = document.createElement.bind(document);

  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = original(tag);

    if (tag === 'input') {
      el.click = click;
    }

    return el;
  });

  return {
    click,
    pendingInput: () => document.body.querySelector('input[type="file"]') as HTMLInputElement,
  };
}

describe('pickFromUserDevice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('opens a hidden image file input (PHPicker on iOS, no library permission)', async () => {
    const { click } = clickableInput();
    const pending = pickPhotosFromLibrary({ multiple: false });
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;

    expect(input.accept).toBe('image/*');
    expect(input.multiple).toBe(false);
    expect(click).toHaveBeenCalled();

    input.dispatchEvent(new Event('cancel'));
    await expect(pending).resolves.toEqual([]);
  });

  it('library picker accepts photos and videos', async () => {
    clickableInput();
    const pending = pickMediaFromLibrary({ multiple: true });
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;

    expect(input.accept).toBe('image/*,video/*');
    expect(input.multiple).toBe(true);
    input.dispatchEvent(new Event('cancel'));
    await pending;
  });

  it('document picker does not restrict accept (Files app on iOS)', async () => {
    clickableInput();
    const pending = pickDocuments();
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;

    expect(input.accept).toBe('');
    expect(input.multiple).toBe(true);
    input.dispatchEvent(new Event('cancel'));
    await pending;
  });

  it('system camera capture is single-file with the capture attribute', async () => {
    clickableInput();
    const pending = captureWithSystemCamera('video');
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;

    expect(input.accept).toBe('video/*');
    expect(input.multiple).toBe(false);
    expect(input.getAttribute('capture')).toBe('environment');
    input.dispatchEvent(new Event('cancel'));
    await pending;
  });

  it('resolves the selected files on change', async () => {
    clickableInput();
    const pending = pickFromUserDevice({ accept: 'image/*', multiple: false });
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'shot.jpg', { type: 'image/jpeg' });

    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));

    await expect(pending).resolves.toEqual([file]);
  });
});
