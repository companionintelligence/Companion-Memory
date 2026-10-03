import type { ReactNode } from 'react';

import { getApiBaseUrl } from '@ci/common';
import { Globe } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

/**
 * Whether this session holds only a device API key: the native shell signs in with a keystore
 * key and has no web JWT, so `authToken` is null while the session is still `authenticated`.
 *
 * Routes that manage credentials are deliberately closed to API keys. `/api/keys` and
 * `/api/mcp/*` take a session JWT or a Portal bearer (`JwtOrPortalAuthGuard`) — a key that could
 * mint keys would outlive its own revocation, and an MCP server is command execution on the
 * appliance — and changing an account's email or password takes a session JWT (`JwtAuthGuard`).
 * On such a session the request can only 401, so a screen that exists to call one has nothing to
 * offer: it should say so, not fire the request and report "Failed to load".
 */
export function useNeedsWebSignIn(): boolean {
  const [{ authToken, authenticated }] = useAuth();

  return Boolean(authenticated) && !authToken;
}

interface Props {
  title?: string;
  className?: string;
  /** Why this cannot be done here, and what to do instead. */
  children: ReactNode;
}

/** The plain statement that a screen needs a web sign-in, shown in place of controls that cannot work. */
export function WebSignInRequired({ title = 'Needs a web sign-in', className, children }: Props) {
  // Empty on the web, where the page is already on the server. In the app it is the address to open
  // in a browser, which the person may not remember.
  const server = getApiBaseUrl();

  return (
    <div
      role="note"
      className={`flex items-start gap-3 rounded-md border bg-muted/40 px-4 py-3 text-sm ${className ?? ''}`}
    >
      <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-muted-foreground">{children}</p>
        {server ? (
          <p className="text-xs text-muted-foreground">
            Your Memory server is <span className="break-all font-mono">{server}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
