import { useEffect, useRef, useState } from 'react';

import { cn } from '@ci/shadcn';

interface AudioWaveformProps {
  audioStream?: MediaStream;
  isActive?: boolean;
  color?: 'user' | 'companion';
  className?: string;
}

export function AudioWaveform({
  audioStream,
  isActive = false,
  color = 'user',
  className,
}: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);
  const analyserRef = useRef<AnalyserNode | undefined>(undefined);
  const dataArrayRef = useRef<Uint8Array | undefined>(undefined);
  const [isInitialized, setIsInitialized] = useState(false);

  const barCount = 20; // Reduced for compact view
  const minBarHeight = 1;
  const maxBarHeight = 30; // Reduced for compact view

  useEffect(() => {
    if (!audioStream) {
      return;
    }

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(audioStream);
    const analyser = audioContext.createAnalyser();

    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;

    source.connect(analyser);

    analyserRef.current = analyser;
    dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
    setIsInitialized(true);

    return () => {
      audioContext.close();
      setIsInitialized(false);
    };
  }, [audioStream]);

  useEffect(() => {
    if (!isActive || !isInitialized || !canvasRef.current || !analyserRef.current || !dataArrayRef.current) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const analyser = analyserRef.current;
    const dataArray = dataArrayRef.current;

    const draw = () => {
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = canvas.width / barCount;
      const centerY = canvas.height / 2;

      // Use different color schemes for user vs companion
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      if (color === 'user') {
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.8)'); // blue-500
        gradient.addColorStop(1, 'rgba(147, 197, 253, 0.4)'); // blue-300
      } else {
        gradient.addColorStop(0, 'rgba(16, 185, 129, 0.8)'); // emerald-500
        gradient.addColorStop(1, 'rgba(110, 231, 183, 0.4)'); // emerald-300
      }

      ctx.fillStyle = gradient;

      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor((i / barCount) * dataArray.length);
        const value = dataArray[dataIndex] || 0;

        // Normalize the value and apply some smoothing
        const normalizedValue = Math.pow(value / 255, 0.7);
        const barHeight = Math.max(minBarHeight, normalizedValue * maxBarHeight);

        const x = i * barWidth;
        const y = centerY - barHeight / 2;

        ctx.fillRect(x, y, barWidth - 1, barHeight);
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isActive, isInitialized, color, barCount, minBarHeight, maxBarHeight]);

  // Render static bars when not active
  useEffect(() => {
    if (isActive || !canvasRef.current) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const barWidth = canvas.width / barCount;
    const centerY = canvas.height / 2;

    // Static gradient for inactive state
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (color === 'user') {
      gradient.addColorStop(0, 'rgba(59, 130, 246, 0.3)');
      gradient.addColorStop(1, 'rgba(147, 197, 253, 0.1)');
    } else {
      gradient.addColorStop(0, 'rgba(16, 185, 129, 0.3)');
      gradient.addColorStop(1, 'rgba(110, 231, 183, 0.1)');
    }

    ctx.fillStyle = gradient;

    // Draw static bars with random heights for visual appeal
    for (let i = 0; i < barCount; i++) {
      const barHeight = minBarHeight + Math.random() * 8;
      const x = i * barWidth;
      const y = centerY - barHeight / 2;

      ctx.fillRect(x, y, barWidth - 1, barHeight);
    }
  }, [isActive, color, barCount, minBarHeight]);

  return (
    <canvas
      ref={canvasRef}
      width={200}
      height={48}
      className={cn(
        'rounded border w-full',
        color === 'user' ? 'border-blue-200 bg-blue-50/30' : 'border-emerald-200 bg-emerald-50/30',
        className,
      )}
    />
  );
}
