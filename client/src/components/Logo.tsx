interface LogoProps {
  size?: number;
  className?: string;
  showWordmark?: boolean;
}

/* Custom SVG logo: stylized circle with a circuit node — references AI
 * (the circuit), career path (the curve), and a shielding ring (the
 * "proof" in CareerProof AI). */
export function Logo({ size = 28, className = "", showWordmark = true }: LogoProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        aria-label="CareerProof AI logo"
        className="shrink-0"
      >
        <defs>
          <linearGradient id="og" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#22D3EE" />
            <stop offset="1" stopColor="#A78BFA" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="11" stroke="url(#og)" strokeWidth="2.5" fill="none" />
        <path d="M16 5 L16 11" stroke="url(#og)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="16" cy="5" r="2" fill="url(#og)" />
        <circle cx="16" cy="16" r="2.5" fill="url(#og)" />
        <path d="M22 22 L26 26" stroke="url(#og)" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {showWordmark && (
        <span className="font-semibold tracking-tight text-[15px]" data-testid="text-app-name">
          CareerProof AI
        </span>
      )}
    </div>
  );
}
