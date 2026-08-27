import { useEffect, useRef } from 'react';

import { apiKeyHeaders, buildApiUrl, LoadingPage, usePageTitle } from '@ci/common';
import { useToast } from '@ci/shadcn';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@/hooks';
import { ONBOARDING_OAUTH_RESUME_KEY } from '@/pages/OnboardingPage/constants';

export function OAuthCallbackPage() {
  usePageTitle('Complete Connection - Companion Intelligence');

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [{ authToken, loading: authLoading }] = useAuth();

  const initialRequestRef = useRef<boolean>(false);

  // CI Cloud proxy callback params (when OAuth is proxied through CI Cloud).
  // CI Cloud puts the tokens in the URL FRAGMENT so they never reach the
  // appliance's web server or its access log; the query string is still read
  // as a fallback for a CI Cloud that predates that change. `connectionId` is
  // ours and stays in the query.
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const proxyParam = (name: string) => hashParams.get(name) ?? searchParams.get(name);
  const accessToken = proxyParam('access_token');
  const refreshToken = proxyParam('refresh_token');
  const connectionId = searchParams.get('connectionId');
  const userProviderId = proxyParam('user_provider_id');
  const expiresIn = proxyParam('expires_in');

  // Direct OAuth callback params
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  const isCloudProxyCallback = !!accessToken;

  const returnPath =
    localStorage.getItem(ONBOARDING_OAUTH_RESUME_KEY) != null ? '/onboarding' : '/sources/connect';

  // Handle OAuth errors and missing params
  useEffect(() => {
    if (error || errorDescription) {
      toast.error(errorDescription || error || 'OAuth error');
      navigate(returnPath);

      return;
    }

    if (isCloudProxyCallback && (!connectionId || !userProviderId)) {
      toast.error('Missing OAuth credentials from provider');
      navigate(returnPath);

      return;
    }

    if (!isCloudProxyCallback && (!code || !state)) {
      toast.error('Missing OAuth credentials');
      navigate(returnPath);

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
    returnPath,
  ]);

  // Redirect to login if session was lost during the OAuth redirect.
  if (!authLoading && !authToken) {
    return (
      <Navigate
        to="/login"
        state={{ from: `/oauth/callback?${searchParams.toString()}${window.location.hash}` }}
        replace
      />
    );
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

        const response = await fetch(buildApiUrl(`/api/connections/complete`), {
          method: 'POST',
          headers: {
            ...apiKeyHeaders(),
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
        navigate(returnPath);
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
    returnPath,
  ]);

  return <LoadingPage />;
}
