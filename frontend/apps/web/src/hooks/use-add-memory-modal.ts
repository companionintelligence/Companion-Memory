import { createHookContext } from '@ci/common';

import { useModalControls } from './use-modal-controls';

export const { Provider: AddMemoryModalProvider, useHookContext: useAddMemoryModal } =
  createHookContext(useModalControls);
