import { useCallback, useEffect, useRef, useState } from 'react';

interface ColorWheelProps {
  size?: number;
  value?: number; // hue value 0-360
  onChange?: (hue: number) => void;
  onChangeEnd?: (hue: number) => void;
}

export function ColorWheel({ size = 200, value = 0, onChange, onChangeEnd }: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [currentHue, setCurrentHue] = useState(value);

  // Draw the color wheel
  const drawColorWheel = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const centerX = size / 2;
    const centerY = size / 2;
    const radius = size / 2 - 10; // Leave some margin

    // Clear canvas
    ctx.clearRect(0, 0, size, size);

    // Draw color wheel
    for (let angle = 0; angle < 360; angle += 1) {
      const startAngle = ((angle - 1) * Math.PI) / 180;
      const endAngle = (angle * Math.PI) / 180;

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, startAngle, endAngle);
      ctx.lineWidth = 20;
      ctx.strokeStyle = `hsl(${angle}, 80%, 60%)`;
      ctx.stroke();
    }

    // Draw inner circle (darker background)
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius - 20, 0, 2 * Math.PI);
    ctx.fillStyle = '#1a1a1a';
    ctx.fill();

    // Draw center circle showing selected color
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius - 40, 0, 2 * Math.PI);
    ctx.fillStyle = `hsl(${currentHue}, 80%, 60%)`;
    ctx.fill();

    // Draw selector indicator
    const indicatorAngle = ((currentHue - 90) * Math.PI) / 180; // -90 to start from top
    const indicatorX = centerX + (radius - 10) * Math.cos(indicatorAngle);
    const indicatorY = centerY + (radius - 10) * Math.sin(indicatorAngle);

    ctx.beginPath();
    ctx.arc(indicatorX, indicatorY, 8, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [size, currentHue]);

  // Get hue from mouse position
  const getHueFromPosition = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return 0;
    }

    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const x = clientX - centerX;
    const y = clientY - centerY;

    let angle = (Math.atan2(y, x) * 180) / Math.PI;
    angle += 90; // Adjust so 0° is at the top
    if (angle < 0) {
      angle += 360;
    }

    if (angle >= 360) {
      angle -= 360;
    }

    return Math.round(angle);
  }, []);

  // Handle mouse events
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsDragging(true);
      const hue = getHueFromPosition(e.clientX, e.clientY);
      setCurrentHue(hue);
      onChange?.(hue);
    },
    [getHueFromPosition, onChange],
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) {
        return;
      }

      const hue = getHueFromPosition(e.clientX, e.clientY);
      setCurrentHue(hue);
      onChange?.(hue);
    },
    [isDragging, getHueFromPosition, onChange],
  );

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      onChangeEnd?.(currentHue);
    }
  }, [isDragging, currentHue, onChangeEnd]);

  // Handle touch events for mobile
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      setIsDragging(true);
      const hue = getHueFromPosition(touch.clientX, touch.clientY);
      setCurrentHue(hue);
      onChange?.(hue);
    },
    [getHueFromPosition, onChange],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!isDragging) {
        return;
      }

      e.preventDefault();
      const touch = e.touches[0];
      const hue = getHueFromPosition(touch.clientX, touch.clientY);
      setCurrentHue(hue);
      onChange?.(hue);
    },
    [isDragging, getHueFromPosition, onChange],
  );

  const handleTouchEnd = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      onChangeEnd?.(currentHue);
    }
  }, [isDragging, currentHue, onChangeEnd]);

  // Add global event listeners for mouse move/up
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      document.addEventListener('touchend', handleTouchEnd);

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

  // Update currentHue when value prop changes
  useEffect(() => {
    setCurrentHue(value);
  }, [value]);

  // Redraw when currentHue changes
  useEffect(() => {
    drawColorWheel();
  }, [drawColorWheel]);

  return (
    <div className="flex flex-col items-center gap-4">
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className="cursor-pointer select-none touch-none"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        style={{ touchAction: 'none' }}
      />
      <div className="text-sm text-muted-foreground">Hue: {currentHue}°</div>
    </div>
  );
}
