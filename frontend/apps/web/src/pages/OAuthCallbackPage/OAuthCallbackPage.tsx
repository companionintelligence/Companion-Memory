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
  const refreshToken = searchParams.get('refresh_token');
  const connectionId = searchParams.get('connectionId');
  const userProviderId = searchParams.get('user_provider_id');
  const expiresIn = searchParams.get('expires_in');

  // Direct OAuth callback params
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  const isCloudProxyCallback = !!accessToken;

  // Handle OAuth errors and missing params
  useEffect(() => {
    if (error || errorDescription) {
      toast.error(errorDescription || error || 'OAuth error');
      navigate('/connections');

      return;
    }

    if (isCloudProxyCallback && (!connectionId || !userProviderId)) {
      toast.error('Missing OAuth credentials from provider');
      navigate('/connections');

      return;
    }

    if (!isCloudProxyCallback && (!code || !state)) {
      toast.error('Missing OAuth credentials');
      navigate('/connections');

      return;
    }
  }, [
    error,
    errorDescription,
    isCloudProxyCallback,
    connectionId,
    userProviderId,
    code,
    state,
    toast,
    navigate,
  ]);

  // Redirect to login if session was lost during the OAuth redirect.
  if (!authLoading && !authToken) {
    return <Navigate to="/login" state={{ from: `/oauth/callback?${searchParams.toString()}` }} replace />;
  }

  useEffect(() => {
    const hasError = !!(error || errorDescription);
    const missingParams = isCloudProxyCallback ? !connectionId || !userProviderId : !code || !state;

    if (!authToken || initialRequestRef.current || hasError || missingParams) {
      return;
    }

    (async () => {
      initialRequestRef.current = true;

      try {
        const body = isCloudProxyCallback
          ? {
              flow: 'proxy' as const,
              state: connectionId,
              accessToken,
              refreshToken: refreshToken ?? undefined,
              expiresIn: expiresIn ? parseInt(expiresIn, 10) : undefined,
              userProviderId,
            }
          : { flow: 'direct' as const, state, code };

        const response = await fetch(`/api/connections/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          toast.success('Created connection');
        } else {
          if (response.status === 409) {
            toast.error('A connection to that account already exists');
          } else if (response.status === 403) {
            toast.error('Could not use new credentials to access API');
          } else {
            toast.error('Failed to create connection');
          }
        }
      } catch (err: unknown) {
        toast.error(String(err));
      } finally {
        window.history.replaceState(null, '', window.location.pathname);
        navigate('/connections');
      }
    })();
  }, [
    authToken,
    error,
    errorDescription,
    isCloudProxyCallback,
    connectionId,
    accessToken,
    refreshToken,
    expiresIn,
    userProviderId,
    code,
    state,
    toast,
    navigate,
  ]);

  return <LoadingPage />;
}
