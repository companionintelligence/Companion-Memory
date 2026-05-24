import { createHookContext } from '@ci/common';

import { useModalControls } from './useModalControls';

export const { Provider: CaptureModalProvider, useHookContext: useCaptureModal } =
  createHookContext(useModalControls);
