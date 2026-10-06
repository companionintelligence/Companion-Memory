import type { BaseSyntheticEvent } from 'react';
import { useEffect, useState } from 'react';

import { Alert, Button, Card, Separator } from '@ci/shadcn';
import { AlertCircleIcon } from '@ci/shadcn/icons';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { OidcButton } from '@/components/OidcButton';
import { useAuth } from '@/hooks';
import { hasPendingPortalOidc } from '@/pages/DeviceConnectPage/oidc';

import { LoginForm, type LoginFormData } from './LoginForm';

/**
 * What the `?error=` key from the OIDC callback means to the person reading it.
 * Every key not listed here is a transport or protocol failure ("try again" is
 * the honest advice); the listed ones are admission decisions, where trying
 * again would only produce the same answer.
 */
function oidcErrorMessage(code: string): string {
  switch (code) {
    case 'signup_code_required':
      return 'This Companion Memory already belongs to someone. Ask its owner for an invitation, or sign in with your email and password.';
    case 'account_exists':
    case 'account_linked_elsewhere':
      return 'An account with this email already exists on this Companion Memory. Sign in with your email and password instead.';
    case 'email_unverified':
      return 'Your Companion account email has not been verified yet. Verify it, then sign in again.';
    default:
      return 'Sign in failed. Please try again.';
  }
}

export function LoginPage() {
  const [{ error }, { login }] = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();

  // Safari often reopens `/` → we used to dump that on this page, dropping the
  // Portal PKCE resume that only DeviceConnectPage runs.
  useEffect(() => {
    if (hasPendingPortalOidc()) {
      navigate('/device-connect', { replace: true });
    }
  }, [navigate]);
  const oidcError = searchParams.get('error');

  // Where ProtectedRoute sent us from (e.g. a /shared/<token> deep link). The
  // OIDC sign-in is a full-page navigation that discards router state, so carry
  // the destination through as a query param the callback can return to.
  const from = (location.state as { from?: string } | null)?.from;
  // CI Portal (OIDC) is the primary sign-in path. Email/password is kept behind
  // an opt-in toggle rather than shown as the default, so it isn't the first
  // thing users try where it isn't the configured method.
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  const handleSubmit = async (data: LoginFormData, e?: BaseSyntheticEvent) => {
    e?.preventDefault();

    await login(data.email, data.password);
  };

  return (
    <div className="w-full max-w-sm">
      <Card>
        <Card.Header>
          <Card.Title>Log In</Card.Title>
          <Card.Description>Sign in to access your account</Card.Description>
        </Card.Header>

        <Card.Content>
          {error != null && !showPasswordForm && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircleIcon />
              <Alert.Title>
                {error instanceof Error ? error.message : 'Sign in failed. Please try again.'}
              </Alert.Title>
            </Alert>
          )}
          {oidcError && error == null && (
            <p className="text-destructive mb-4 text-center text-sm">{oidcErrorMessage(oidcError)}</p>
          )}

          <OidcButton label="Sign in with Companion account" redirect={from} />

          {showPasswordForm ? (
            <>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <Separator className="w-full" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card text-muted-foreground px-2">Or</span>
                </div>
              </div>

              <LoginForm onSubmit={handleSubmit} />
            </>
          ) : (
            <Button
              variant="link"
              className="text-muted-foreground mt-2 w-full"
              onClick={() => setShowPasswordForm(true)}
            >
              Sign in with email instead
            </Button>
          )}
        </Card.Content>
      </Card>

      <div className="mt-2 text-center text-sm">
        Don't have an account?{' '}
        <Button variant="link" className="p-0" asChild>
          <Link to="/signup">Sign up</Link>
        </Button>
      </div>
    </div>
  );
}
