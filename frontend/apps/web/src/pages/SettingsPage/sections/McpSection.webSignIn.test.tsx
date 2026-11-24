import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpSection } from './McpSection';

// McpSection reads useAuth and useCurrentUser from the @/hooks barrel and talks to /api/mcp/*
// through fetchJson.
const h = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  // The web session: a JWT. The native shell holds only a device API key, so there is no JWT
  // there (`authToken` null) while the session is still `authenticated`.
  authToken: 'token' as string | null,
  authenticated: true,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken, authenticated: h.authenticated }, {}],
  useCurrentUser: () => ({ user: { id: 'user-1', isAdmin: true }, loading: false }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  h.authToken = 'token';
  h.authenticated = true;
  h.fetchJson.mockReset();
});

afterEach(() => {
  h.authToken = 'token';
  h.authenticated = true;
});

/**
 * ═══ "FAILED TO LOAD" AND "NOTHING CONFIGURED" AT ONCE ═══
 *
 * A failed load leaves the list empty, and each empty state keyed off the list alone — so a red
 * banner saying the servers could not be read sat above a card saying there were none, and the
 * same for the suggested catalogue.
 */
describe('McpSection load failure', () => {
  it('does not claim there are no servers when the list could not be loaded', async () => {
    h.fetchJson.mockImplementation((url: string) =>
      url === '/api/mcp/servers'
        ? Promise.reject(new Error('network down'))
        : Promise.resolve({ normal: [], highRisk: [] }),
    );

    render(<McpSection />);

    expect(await screen.findByText('Failed to load MCP servers')).toBeInTheDocument();
    expect(screen.queryByText('No MCP servers configured yet.')).not.toBeInTheDocument();
  });

  it('still shows the empty state when the load succeeded and there are none', async () => {
    h.fetchJson.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/mcp/servers' ? [] : { normal: [], highRisk: [] }),
    );

    render(<McpSection />);

    expect(await screen.findByText('No MCP servers configured yet.')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load MCP servers')).not.toBeInTheDocument();
  });

  it('does not claim there are no suggested servers when the catalogue could not be loaded', async () => {
    h.fetchJson.mockImplementation((url: string) =>
      url === '/api/mcp/catalog' ? Promise.reject(new Error('network down')) : Promise.resolve([]),
    );

    render(<McpSection />);
    // Radix tabs activate on mousedown, not click.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Browse suggested MCPs' }), { button: 0 });

    expect(await screen.findByText('Failed to load the suggested MCP catalog')).toBeInTheDocument();
    expect(screen.queryByText('No suggested servers yet.')).not.toBeInTheDocument();
  });
});

/**
 * ═══ A SCREEN THE PHONE CAN NEVER USE ═══
 *
 * Every `/api/mcp/servers` and `/api/mcp/catalog` route is `JwtOrPortalAuthGuard`, deliberately
 * never an API key: a stdio server is arbitrary command execution on the appliance, which a key
 * should never be able to reach. The native shell holds only a device key (no web JWT), so every
 * request could only 401 — and the page said "Failed to load MCP servers" above "No MCP servers
 * configured yet." Say what is true instead, and do not send the requests.
 */
describe('McpSection on the native shell (device key, no web JWT)', () => {
  beforeEach(() => {
    h.authToken = null;
    h.authenticated = true;
    h.fetchJson.mockResolvedValue([]);
  });

  it('says plainly that a web sign-in is needed', () => {
    render(<McpSection />);

    expect(screen.getByText('Needs a web sign-in')).toBeInTheDocument();
    expect(screen.getByText(/can run commands on your appliance/i)).toBeInTheDocument();
  });

  it('does not send requests that can only 401, and shows no load failure or empty state', async () => {
    render(<McpSection />);

    // Let any effect settle before asserting nothing happened.
    await waitFor(() => expect(screen.getByText('Needs a web sign-in')).toBeInTheDocument());

    expect(h.fetchJson).not.toHaveBeenCalled();
    expect(screen.queryByText('Failed to load MCP servers')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load the suggested MCP catalog')).not.toBeInTheDocument();
    expect(screen.queryByText('No MCP servers configured yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('No suggested servers yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SETTINGS_MCP_CREATE' })).not.toBeInTheDocument();
  });

  it('keeps the normal page for a web session', async () => {
    h.authToken = 'token';
    h.fetchJson.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/mcp/servers' ? [] : { normal: [], highRisk: [] }),
    );

    render(<McpSection />);

    expect(await screen.findByText('No MCP servers configured yet.')).toBeInTheDocument();
    expect(screen.queryByText('Needs a web sign-in')).not.toBeInTheDocument();
  });
});
