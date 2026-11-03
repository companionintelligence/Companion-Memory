import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpSection } from './McpSection';

const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'token' }, {}],
  useCurrentUser: () => ({ user: { id: 'user-1', isAdmin: true }, loading: false }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const server = {
  id: 'config-1',
  name: 'Context7',
  slug: 'context7',
  transport: 'http' as const,
  url: 'https://mcp.context7.com/mcp',
  enabled: true,
  // What the API stored for catalog adds before it derived `source` from `catalogSlug`.
  source: 'user_added' as const,
  catalogSlug: 'context7',
  connectionStatus: 'connected' as const,
  discoveredTools: [],
  toolApprovals: [],
};

function mockApi(testConnectionResult: unknown) {
  h.fetchJson.mockImplementation((url: string) => {
    if (url === '/api/mcp/servers') {
      return Promise.resolve([server]);
    }

    if (url === '/api/mcp/catalog') {
      return Promise.resolve({ normal: [], highRisk: [] });
    }

    if (url.endsWith('/test-connection')) {
      return Promise.resolve(testConnectionResult);
    }

    return Promise.resolve(server);
  });
}

async function openEditAndTest() {
  render(<McpSection />);
  fireEvent.click(await screen.findByRole('button', { name: 'SETTINGS_MCP_EDIT_SERVER' }));
  fireEvent.click(await screen.findByRole('button', { name: /test connection/i }));
}

describe('McpSection test connection', () => {
  beforeEach(() => {
    h.fetchJson.mockReset();
  });

  it('shows Connected for the API success shape { success: true, tools }', async () => {
    mockApi({
      success: true,
      tools: [
        { name: 'resolve-library-id', description: 'Resolve' },
        { name: 'get-library-docs', description: 'Docs' },
      ],
    });

    await openEditAndTest();

    expect(await screen.findByText(/Connected — 2 tools found/)).toBeInTheDocument();
    expect(screen.queryByText('Test connection failed')).not.toBeInTheDocument();
  });

  it('shows the error for { success: false, error }', async () => {
    mockApi({ success: false, error: 'connect ECONNREFUSED' });

    await openEditAndTest();

    expect(await screen.findByText('connect ECONNREFUSED')).toBeInTheDocument();
  });

  it('badges a server that carries a catalogSlug as From catalog', async () => {
    mockApi({ success: true, tools: [] });
    render(<McpSection />);

    expect(await screen.findByText('From catalog')).toBeInTheDocument();
  });
});
