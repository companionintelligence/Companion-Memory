import { useState } from 'react';

import { LoadingPage, usePageTitle } from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { Navigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@/hooks';

type Phase = 'idle' | 'loading' | 'success' | 'error';

export function AppletPairPage() {
  usePageTitle('Authorize Access - Companion Intelligence');

  const [searchParams] = useSearchParams();
  const pairingToken = searchParams.get('token');
  const [{ authToken, loading }] = useAuth();
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (loading) {
    return <LoadingPage />;
  }

  if (!authToken) {
    const returnTo = encodeURIComponent(`/pair?token=${pairingToken ?? ''}`);

    return <Navigate to={`/login?returnTo=${returnTo}`} />;
  }

  if (!pairingToken) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <Card.Header>
            <Card.Title>Invalid Link</Card.Title>
            <Card.Description>This pairing link is missing a token.</Card.Description>
          </Card.Header>
        </Card>
      </div>
    );
  }

  const handleApprove = async () => {
    setPhase('loading');
    setErrorMessage(null);

    try {
      const response = await fetch('/api/pairing/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ pairingToken }),
      });

      if (response.ok) {
        setPhase('success');
      } else {
        const body = await response.json().catch(() => ({}));
        setErrorMessage(body?.message ?? 'Failed to authorize access.');
        setPhase('error');
      }
    } catch {
      setErrorMessage('A network error occurred. Please try again.');
      setPhase('error');
    }
  };

  if (phase === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <Card.Header>
            <Card.Title>Access Authorized</Card.Title>
            <Card.Description>The connection has been approved. You can close this window.</Card.Description>
          </Card.Header>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <Card.Header>
          <Card.Title>Authorize Access</Card.Title>
          <Card.Description>
            A client is requesting access to your Companion Intelligence account. Approve to continue.
          </Card.Description>
        </Card.Header>

        <Card.Content className="space-y-4">
          {phase === 'error' && errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

          <Button className="w-full" onClick={handleApprove} disabled={phase === 'loading'}>
            {phase === 'loading' ? 'Authorizing…' : 'Approve'}
          </Button>
        </Card.Content>
      </Card>
    </div>
  );
}
