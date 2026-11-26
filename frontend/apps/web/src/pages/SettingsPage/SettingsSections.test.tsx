import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { SettingsSectionBody } from './SettingsSections';

vi.mock('./sections/SystemStatusSection', () => ({
  SystemStatusSection: () => <h2>System status section</h2>,
}));

describe('SettingsSectionBody', () => {
  it('opens the System status section for /settings/status instead of falling back', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/status']}>
        <SettingsSectionBody section="status" fallbackTo="/settings/appearance" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'System status section' })).toBeInTheDocument();
  });
});
