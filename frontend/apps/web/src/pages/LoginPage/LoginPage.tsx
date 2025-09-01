import type { BaseSyntheticEvent } from 'react';

import { Card } from '@ci/shadcn';

import { useAuth } from '@/hooks';

import { LoginForm, type LoginFormData } from './LoginForm';

export function LoginPage() {
  const [, { login }] = useAuth();

  const handleSubmit = async (data: LoginFormData, e?: BaseSyntheticEvent) => {
    e?.preventDefault();

    await login(data.email, data.password);
  };

  return (
    <div className="w-full">
      <Card className="mobile-spacing">
        <Card.Header className="text-center">
          <Card.Title className="text-xl">Log In</Card.Title>
          <Card.Description>Enter your information to access your account</Card.Description>
        </Card.Header>

        <Card.Content className="pt-4">
          <LoginForm onSubmit={handleSubmit} />
        </Card.Content>
      </Card>
    </div>
  );
}
