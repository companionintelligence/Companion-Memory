import { useCallback } from 'react';

import { useNavigate } from 'react-router-dom';

import { CaptureModal } from '@/components/modals/CaptureModal';

/**
 * A shareable capture entry point. Navigation normally opens this modal from
 * the primary controls, but a real route also makes mobile shortcuts, saved
 * links, and direct Tailscale URLs usable rather than returning a 404.
 */
export default function CapturePage() {
  const navigate = useNavigate();

  const handleClose = useCallback(() => {
    navigate('/memory?view=list', { replace: true });
  }, [navigate]);

  return <CaptureModal open onClose={handleClose} />;
}
