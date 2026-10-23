import { useEffect, useRef, useState } from 'react';

import { apiFetch, apiKeyHeaders, LoadingPage, usePageTitle } from '@ci/common';
import { useToast } from '@ci/shadcn';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@/hooks';
import { ONBOARDING_OAUTH_RESUME_KEY } from '@/pages/OnboardingPage/constants';

export function OAuthCallbackPage() {
  usePageTitle('Complete Connection - Companion Memory');

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [{ authToken, loading: authLoading }] = useAuth();

  const initialRequestRef = useRef<boolean>(false);

  // Whether this page is still mounted when its completion request settles. The
  // request waits on CI Portal, and a user who navigates elsewhere meanwhile must
  // not be pulled back to `returnPath` when it does.
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  // CI Cloud proxy callback params (when OAuth is proxied through CI Cloud).
  // CI Cloud puts the tokens in the URL FRAGMENT so they never reach the
  // appliance's web server or its access log; the query string is still read
  // as a fallback for a CI Cloud that predates that change. `connectionId` is
  // ours and stays in the query.
  //
  // Read ONCE, on mount: the fragment is scrubbed from the address bar as the
  // completion request starts (below), and every later render has to see the
  // same callback — re-reading the emptied address bar would turn it into a
  // "direct" callback with no code.
  const [hashParams] = useState(() => new URLSearchParams(window.location.hash.replace(/^#/, '')));
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

  /*
   * A proxied callback is recognised by what only CI Portal sends, not by the
   * access token alone. The server now fetches the access token from CI Portal
   * itself whenever there is a proxy refresh token (CI-Server#2676), so a Portal
   * that stops putting the provider's access token in the fragment still lands
   * here as a proxy callback instead of failing as a direct one. A grant CI
   * Portal holds no refresh token for (one whose token response carries none,
   * Facebook's for instance) still arrives with only an access token, and that
   * is still accepted.
   */
  const isCloudProxyCallback = !!(refreshToken || userProviderId || accessToken);
  const missingParams = isCloudProxyCallback
    ? !connectionId || !userProviderId || (!refreshToken && !accessToken)
    : !code || !state;

  const returnPath =
    localStorage.getItem(ONBOARDING_OAUTH_RESUME_KEY) != null ? '/onboarding' : '/sources/connect';

  // Handle OAuth errors and missing params
  useEffect(() => {
    if (error || errorDescription) {
      toast.error(errorDescription || error || 'OAuth error');
      navigate(returnPath);

      return;
    }

    if (missingParams) {
      toast.error(
        isCloudProxyCallback ? 'Missing OAuth credentials from provider' : 'Missing OAuth credentials',
      );
      navigate(returnPath);

      return;
    }
  }, [error, errorDescription, isCloudProxyCallback, missingParams, toast, navigate, returnPath]);

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

    if (!authToken || initialRequestRef.current || hasError || missingParams) {
      return;
    }

    (async () => {
      initialRequestRef.current = true;

      try {
        // Out of the address bar BEFORE the request, not after it: the server
        // spends the proxy refresh token in the fragment (CI Portal rotates it on
        // use), so a reload while the request is in flight must not find it and
        // post it a second time. The params above were read once, on mount.
        window.history.replaceState(window.history.state, '', window.location.pathname);

        const body = isCloudProxyCallback
          ? {
              flow: 'proxy' as const,
              state: connectionId,
              // Still sent when present, so this page keeps working against a
              // server that predates fetching it; a current server ignores it
              // whenever there is a refresh token to fetch a fresh one with.
              accessToken: accessToken ?? undefined,
              refreshToken: refreshToken ?? undefined,
              expiresIn: expiresIn ? parseInt(expiresIn, 10) : undefined,
              userProviderId,
            }
          : { flow: 'direct' as const, state, code };

        const response = await apiFetch('/api/connections/complete', {
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
        if (mountedRef.current) {
          navigate(returnPath);
        }
      }
    })();
  }, [
    authToken,
    error,
    errorDescription,
    isCloudProxyCallback,
    missingParams,
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
