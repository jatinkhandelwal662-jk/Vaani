
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  analyser: AnalyserNode | null;
  isActive: boolean;
  color: string;
  gradientStart?: string;
  gradientEnd?: string;
}

const Visualizer: React.FC<VisualizerProps> = ({ 
  analyser, 
  isActive, 
  color,
  gradientStart = '#6366f1',
  gradientEnd = '#d946ef'
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !analyser || !isActive) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    let animationId: number;

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const width = canvas.width;
      const height = canvas.height;
      const barWidth = (width / (bufferLength / 2.5));
      let x = 0;

      // Draw mirrored background bars for depth
      ctx.globalAlpha = 0.1;
      for (let i = 0; i < bufferLength / 2; i++) {
        const barHeight = (dataArray[i] / 255) * height * 0.8;
        ctx.fillStyle = gradientStart;
        ctx.fillRect(x, height - barHeight - 2, barWidth - 1, 2);
        x += barWidth;
      }
      ctx.globalAlpha = 1.0;

      // Draw active bars with glow
      x = 0;
      for (let i = 0; i < bufferLength / 2; i++) {
        // Boost responsiveness by scaling values
        const magnitude = dataArray[i] / 255;
        const barHeight = magnitude * height * 1.2;

        if (magnitude > 0.1) {
          const gradient = ctx.createLinearGradient(0, height, 0, height - barHeight);
          gradient.addColorStop(0, gradientStart);
          gradient.addColorStop(1, gradientEnd);

          ctx.shadowBlur = 15 * magnitude;
          ctx.shadowColor = gradientEnd;
          ctx.fillStyle = gradient;
          
          const radius = magnitude * 4;
          ctx.beginPath();
          if (ctx.roundRect) {
              ctx.roundRect(x, height - barHeight, barWidth - 1.5, barHeight, [radius, radius, 0, 0]);
          } else {
              ctx.rect(x, height - barHeight, barWidth - 1.5, barHeight);
          }
          ctx.fill();
        }

        x += barWidth;
      }
    };

    draw();

    return () => {
      cancelAnimationFrame(animationId);
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [analyser, isActive, gradientStart, gradientEnd]);

  return (
    <canvas 
      ref={canvasRef} 
      width={1000} 
      height={150} 
      className="w-full h-24 bg-transparent pointer-events-none transition-opacity duration-1000"
    />
  );
};

export default Visualizer;