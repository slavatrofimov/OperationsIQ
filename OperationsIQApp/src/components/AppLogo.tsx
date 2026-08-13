import { useId } from 'react';

export interface AppLogoProps {
  /** Rendered width/height in pixels. Defaults to 32. */
  size?: number;
  className?: string;
}

/**
 * Brand mark for "Operations IQ".
 *
 * A rounded gradient tile holds a stylized time-series signal that dips, then
 * breaks into a confident upward trend, with a bright "insight" node at the
 * inflection point — the moment the data turns into intelligence (IQ). The
 * gradient IDs are salted per-instance so multiple logos on a page never clash.
 */
export function AppLogo({ size = 32, className }: AppLogoProps) {
  const uid = useId();
  const bgId = `operations-iq-bg-${uid}`;
  const lineId = `operations-iq-line-${uid}`;
  const glowId = `operations-iq-glow-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Operations IQ"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={bgId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0F6CBD" />
          <stop offset="55%" stopColor="#5B5FC7" />
          <stop offset="100%" stopColor="#9373E6" />
        </linearGradient>
        <linearGradient id={lineId} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#7FE7FF" />
          <stop offset="100%" stopColor="#FFFFFF" />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="60%" stopColor="#7FE7FF" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#7FE7FF" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Rounded tile */}
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${bgId})`} />

      {/* Faint baseline grid to read as a chart */}
      <g stroke="#FFFFFF" strokeOpacity="0.14" strokeWidth="1">
        <line x1="6" y1="22" x2="26" y2="22" />
        <line x1="6" y1="16" x2="26" y2="16" />
      </g>

      {/* Time-series signal: settle, dip, then trend up */}
      <polyline
        points="5,18 9,15 12,20 16,17 20,21 23,11 27,7"
        fill="none"
        stroke={`url(#${lineId})`}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Insight node at the breakout point */}
      <circle cx="23" cy="11" r="5.5" fill={`url(#${glowId})`} />
      <circle cx="23" cy="11" r="2.1" fill="#FFFFFF" />
    </svg>
  );
}
