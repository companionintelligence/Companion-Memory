import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ErrorState as MemoryErrorState } from '@/pages/MemoryPage/Components/ErrorState';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ErrorState } from './ErrorState';

const h = vi.hoisted(() => ({ offline: false, replica: { opening: false, failed: false, locked: false } }));

// Hoisted by vitest above the imports, so the mock is in place before either component loads.
vi.mock('@/api/powersync/deviceFallback', () => ({
  useAnswersFromDevice: () => h.offline,
  useReplicaOpenState: () => h.replica,
}));

describe('ErrorState', () => {
  it('says to check the connection by default', () => {
    h.offline = false;
    h.replica = { opening: false, failed: false, locked: false };
    renderWithProviders(<ErrorState />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/Check your connection/)).toBeInTheDocument();
  });

  it('says the view needs the Memory server, and what the phone still has, while the appliance does not answer', () => {
    h.offline = true;
    renderWithProviders(<ErrorState />);

    expect(screen.getByText('Needs the Memory server')).toBeInTheDocument();
    expect(screen.getByText(/What this phone has synced is still here/)).toBeInTheDocument();
  });

  it("blames the phone's own copy, not the server, when that copy could not be opened", () => {
    h.offline = false;
    h.replica = { opening: false, failed: true, locked: false };
    const { unmount } = renderWithProviders(<ErrorState />);

    expect(screen.getByText("Couldn't open this phone's copy")).toBeInTheDocument();
    expect(screen.getByText(/could not be opened, so there is nothing to show offline/)).toBeInTheDocument();
    expect(screen.queryByText('Needs the Memory server')).not.toBeInTheDocument();
    unmount();

    h.replica = { opening: false, failed: true, locked: true };
    renderWithProviders(<ErrorState />);
    expect(screen.getByText(/still held by an earlier session of this app/)).toBeInTheDocument();
    h.replica = { opening: false, failed: false, locked: false };
  });

  it("says the phone's copy is still opening while it is, instead of 'check your connection'", () => {
    h.offline = false;
    h.replica = { opening: true, failed: false, locked: false };
    renderWithProviders(<ErrorState />);

    expect(screen.getByText("Opening this phone's copy")).toBeInTheDocument();
    expect(screen.getByText(/will load once it is open/)).toBeInTheDocument();
    expect(screen.queryByText(/Check your connection/)).not.toBeInTheDocument();
    h.replica = { opening: false, failed: false, locked: false };
  });

  it("the Memory views' wrapper defers to that copy too, but a caller's own words win", () => {
    h.offline = true;
    const { unmount } = renderWithProviders(<MemoryErrorState />);
    expect(screen.getByText(/What this phone has synced is still here/)).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <MemoryErrorState title="Could not load people" description="Your people are still here." />,
    );
    expect(screen.getByText('Could not load people')).toBeInTheDocument();
    expect(screen.getByText('Your people are still here.')).toBeInTheDocument();
    expect(screen.queryByText('Needs the Memory server')).not.toBeInTheDocument();
  });
});
