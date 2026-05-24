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

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

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

  // If don't have required OAuth credentials we can't proceed, so just error out.
  if (!code || !state) {
    throw new Error('Missing OAuth credentials');
  }

  useEffect(() => {
    if (!authToken || initialRequestRef.current) {
      return;
    }

    (async () => {
      initialRequestRef.current = true;

      try {
        const response = await fetch(`/api/connections/complete`, {
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
