import { createHookContext } from '@ci/common';
import { useCallback, useState } from 'react';

type FacingMode = 'environment' | 'user';

function useFacingMode() {
  const [facingMode, setFacingMode] = useState<FacingMode>('environment');

  const swapFacingMode = useCallback(
    () => setFacingMode((current) => (current === 'environment' ? 'user' : 'environment')),
    [setFacingMode],
  );

  return [
    {
      facingMode,
    },
    {
      swapFacingMode,
    },
  ];
}

const { Provider, useHookContext } = createHookContext(useFacingMode);

export { Provider as FacingModeProvider, useHookContext as useFacingMode };
