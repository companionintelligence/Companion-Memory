import { createHookContext } from '@ci/common';

import { useModalControls } from './use-modal-controls';

export const { Provider: CaptureModalProvider, useHookContext: useCaptureModal } =
  createHookContext(useModalControls);
