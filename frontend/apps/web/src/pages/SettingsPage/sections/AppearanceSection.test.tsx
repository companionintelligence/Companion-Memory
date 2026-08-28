import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppearanceSection } from './AppearanceSection';

const h = vi.hoisted(() => ({
  isMobile: false as boolean | undefined,
  glowEnabled: true,
  setGlowEnabled: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  useDeviceLayout: () => ({ isMobile: h.isMobile }),
}));

vi.mock('@/components/ThemePicker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ThemePicker')>();

  return {
    ...actual,
    ColorPicker: () => null,
    TexturePicker: () => null,
    useTheme: () => ({
      themeState: { mode: 'dark' as const },
      setTheme: h.setTheme,
    }),
    useBackground: () => ({
      glowEnabled: h.glowEnabled,
      setGlowEnabled: h.setGlowEnabled,
    }),
  };
});

beforeEach(() => {
  h.isMobile = false;
  h.glowEnabled = true;
  h.setGlowEnabled.mockReset();
  h.setTheme.mockReset();
});

describe('AppearanceSection pointer glow', () => {
  it('offers the pointer glow toggle on desktop', () => {
    render(<AppearanceSection />);

    const toggle = screen.getByRole('switch', { name: 'Pointer glow' });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(h.setGlowEnabled).toHaveBeenCalledWith(false);
  });

  it('hides the pointer glow toggle on mobile', () => {
    h.isMobile = true;
    render(<AppearanceSection />);

    expect(screen.queryByRole('switch', { name: 'Pointer glow' })).not.toBeInTheDocument();
  });
});
