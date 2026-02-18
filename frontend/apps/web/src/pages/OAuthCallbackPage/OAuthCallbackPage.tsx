import { useEffect, useRef } from 'react';

import { LoadingPage, usePageTitle } from '@ci/common';
import { useToast } from '@ci/shadcn';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@/hooks';

export function OAuthCallbackPage() {
  usePageTitle('Complete Connection - Companion Intelligence');

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [{ authToken }] = useAuth();

  const initialRequestRef = useRef<boolean>(false);

  // CI Cloud proxy callback params (when OAuth is proxied through CI Cloud)
  const accessToken = searchParams.get('access_token');
  const proxyRefreshToken = searchParams.get('proxy_refresh_token');
  const connectionId = searchParams.get('connectionId');
  const provider = searchParams.get('provider');
  const userProviderId = searchParams.get('user_provider_id');
  const expiresIn = searchParams.get('expires_in');
  const email = searchParams.get('email');

  // Direct OAuth callback params (legacy / when CI Cloud proxy is disabled)
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  // If we're not logged into the application we can't actually complete a connection.
  // This is an unlikely state, but possible.
  if (!authToken) {
    throw new Error('Unauthenticated');
  }

  if (error) {
    throw new Error(error);
  }

  if (errorDescription) {
    throw new Error(errorDescription);
  }

  // Determine flow: cloud proxy (access_token present) vs direct OAuth (code present)
  const isCloudProxyCallback = !!accessToken;

  if (!isCloudProxyCallback && (!code || !state)) {
    throw new Error('Missing OAuth credentials');
  }

  if (isCloudProxyCallback && (!connectionId || !provider || !userProviderId || !proxyRefreshToken)) {
    throw new Error('Missing CI Cloud proxy OAuth credentials');
  }

  useEffect(() => {
    if (!authToken || initialRequestRef.current) {
      return;
    }

    (async () => {
      initialRequestRef.current = true;

      try {
        let response: Response;

        if (isCloudProxyCallback) {
          // CI Cloud proxy flow: tokens already exchanged by CI Cloud
          response = await fetch(`/api/connections/complete-proxy`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              connectionId,
              accessToken,
              proxyRefreshToken,
              expiresIn: expiresIn ? parseInt(expiresIn, 10) : undefined,
              provider,
              userProviderId,
              email: email ?? undefined,
            }),
          });
        } else {
          // Direct OAuth flow: exchange code on the server
          response = await fetch(`/api/connections/complete`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              state,
              code,
            }),
          });
        }

        if (response.ok) {
          toast.success('Created connection');
        } else {
          if (response.status === 409) {
            toast.error('A connection to that account already exists');
          } else {
            toast.error('Failed to create connection');
          }
        }
      } catch (err: unknown) {
        toast.error(String(err));
      } finally {
        navigate('/connections');
      }
    })();
  }, [authToken]);

  return <LoadingPage />;
}
