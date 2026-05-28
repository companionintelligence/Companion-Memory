import { useEffect, useRef } from 'react';

import { LoadingPage, usePageTitle } from '@ci/common';
import { useToast } from '@ci/shadcn';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@/hooks';

export function OpenIDCallbackPage() {
  usePageTitle('Complete Connection - Companion Intelligence');

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [{ authToken }] = useAuth();

  const initialRequestRef = useRef<boolean>(false);

  const claimedId = searchParams.get('openid.claimed_id');
  const identity = searchParams.get('openid.identity');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');
  const connectionId = searchParams.get('connection_id');

  // If we're not logged into the application we can't actually complete a connection.
  // This is an unlikely state, but possible.
  if (!authToken) {
    throw new Error('Unauthenticated');
  }

  // We should consider lifting this error into state so that whatever page we might redirect to
  // can pick it up and render it. For now we'd just bubble to the nearest error boundary.
  if (error) {
    throw new Error(error);
  }

  // Can we have an errorDescription without an error?
  // Does this need to be a separate check?
  if (errorDescription) {
    throw new Error(errorDescription);
  }

  // If don't have required OpenID credentials we can't proceed, so just error out.
  if (!claimedId || !identity) {
    throw new Error('Missing OpenID credentials');
  }

  if (!connectionId) {
    throw new Error('Missing Connection ID');
  }

  useEffect(() => {
    if (!authToken || initialRequestRef.current) {
      return;
    }

    (async () => {
      initialRequestRef.current = true;

      try {
        // Forward all OpenID params to our backend, which will perform
        // check_authentication against Steam and create the connection.
        const params = Object.fromEntries(searchParams.entries());

        const response = await fetch(`/api/connections/openid/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ params }),
        });

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
