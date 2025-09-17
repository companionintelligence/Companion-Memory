import { Spinner, cn } from '@ci/shadcn';
import { useEffect, useState } from 'react';

import { useStream } from './useStream';
import { useRecorder } from './useRecorder';

export function Feed() {
  const [{ isActive, videoRef }] = useStream();
  const [{ lastCapture }] = useRecorder();

  const [showShutter, setShowShutter] = useState(false);

  useEffect(() => {
    if (lastCapture && lastCapture.type === 'image/png') {
      setShowShutter(true);

      const timer = setTimeout(() => setShowShutter(false), 50);

      return () => clearTimeout(timer);
    }
  }, [lastCapture]);

  return (
    <div className="w-full h-full relative">
      {!isActive && (
        <div className={cn('w-full h-full absolute inset-0 flex items-center justify-center')}>
          <Spinner size={64} variant="circle" />
        </div>
      )}

      <video
        className={cn('w-full h-full object-contain', isActive && !showShutter ? 'opacity-100' : 'opacity-0')}
        ref={videoRef}
        autoPlay
        playsInline
        muted
      ></video>
    </div>
  );
}
