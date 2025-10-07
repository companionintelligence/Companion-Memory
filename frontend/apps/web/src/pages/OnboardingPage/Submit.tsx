import { useEffect, useRef } from 'react';

import { ErrorPage, LoadingPage } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Link, Navigate } from 'react-router-dom';

import { useOnboardService } from './useOnboardService';

export function Submit() {
  const [{ loading, error }, { onboard }] = useOnboardService();

  const onboardSubmitted = useRef<boolean>(false);

  useEffect(() => {
    if (onboardSubmitted.current || !onboard) {
      return;
    }

    onboardSubmitted.current = true;

    onboard();
  }, [onboard]);

  if (!loading) {
    if (error) {
      return (
        <ErrorPage error={error}>
          <Button variant="default" asChild>
            <Link to={'/'}>Go Home</Link>
          </Button>
        </ErrorPage>
      );
    }

    return <Navigate to="/feed" />;
  }

  return (
    <>
      <LoadingPage message="Getting you started..." />
    </>
  );
}
