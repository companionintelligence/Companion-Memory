import type { BaseSyntheticEvent } from 'react';

import { Button, Card, Separator } from '@ci/shadcn';
import { Link, useSearchParams } from 'react-router-dom';

import { OidcButton } from '@/components/OidcButton';
import { useAuth } from '@/hooks';

import { SignupForm, type SignupFormData } from './SignupForm';

export function SignupPage() {
  const [, { signup }] = useAuth();
  const [searchParams] = useSearchParams();
  const oidcError = searchParams.get('error');

  const handleSubmit = async (data: SignupFormData, e?: BaseSyntheticEvent) => {
    e?.preventDefault();

    await signup(data.name, data.email, data.password, data.signup_code);
  };

  return (
    <div className="w-full max-w-sm">
      <Card>
        <Card.Header>
          <Card.Title>Create an account</Card.Title>
          <Card.Description>Enter your information to create an account</Card.Description>
        </Card.Header>

        <Card.Content>
          <SignupForm onSubmit={handleSubmit} />

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <Separator className="w-full" />
            </div>
            <div className="relative flex justify-center text-xs ">
              <span className="bg-card text-muted-foreground px-2">Or</span>
            </div>
          </div>

          {oidcError && (
            <p className="text-destructive mb-2 text-center text-sm">Sign up failed. Please try again.</p>
          )}

          <OidcButton label="Sign up with CI Portal" variant="outline" />
        </Card.Content>
      </Card>

      <div className="mt-2 text-center text-sm">
        Already have an account?{' '}
        <Button variant="link" className="p-0" asChild>
          <Link to="/login">Log in</Link>
        </Button>
      </div>
    </div>
  );
}
