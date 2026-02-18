import { useEffect, useRef } from 'react';

import { LoadingPage, usePageTitle } from '@ci/common';
import { useToast } from '@ci/shadcn';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@/hooks';

export function OAuthCallbackPage() {
  usePageTitle('Complete Connection - Companion Intelligence');

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [{ authToken, loading: authLoading }] = useAuth();

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

  // Determine flow: cloud proxy (access_token present) vs direct OAuth (code present)
  const isCloudProxyCallback = !!accessToken;

  // Handle OAuth errors from provider (don't throw - show toast and redirect)
  useEffect(() => {
    if (error || errorDescription) {
      toast.error(errorDescription || error || 'OAuth error');
      navigate('/connections');

      return;
    }

    if (!isCloudProxyCallback && (!code || !state)) {
      toast.error('Missing OAuth credentials');
      navigate('/connections');

      return;
    }

    if (isCloudProxyCallback && (!connectionId || !provider || !userProviderId)) {
      toast.error('Missing OAuth credentials from provider');
      navigate('/connections');

      return;
    }
  }, [
    error,
    errorDescription,
    isCloudProxyCallback,
    code,
    state,
    connectionId,
    provider,
    userProviderId,
    toast,
    navigate,
  ]);

  // Redirect to login if not authenticated (session may have been lost during OAuth redirect).
  // Preserve current URL in state so user can return after login to complete the connection.
  if (!authLoading && !authToken) {
    return <Navigate to="/login" state={{ from: `/oauth/callback?${searchParams.toString()}` }} replace />;
  }

  useEffect(() => {
    if (
      !authToken ||
      initialRequestRef.current ||
      error ||
      errorDescription ||
      (!isCloudProxyCallback && (!code || !state)) ||
      (isCloudProxyCallback && (!connectionId || !provider || !userProviderId))
    ) {
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
              proxyRefreshToken: proxyRefreshToken ?? undefined,
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
  }, [
    authToken,
    error,
    errorDescription,
    isCloudProxyCallback,
    code,
    state,
    connectionId,
    accessToken,
    proxyRefreshToken,
    expiresIn,
    provider,
    userProviderId,
    email,
    toast,
    navigate,
  ]);

  return <LoadingPage />;
}
