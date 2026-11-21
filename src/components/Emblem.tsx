export function Emblem({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="emblem"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="HD2Lab Aosongkan emblem: a pine sprig with a knot"
    >
      <circle cx="16" cy="16" r="14.6" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.4" />
      <path d="M16 26.5V10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 16.2 9.4 9.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M16 20.4 22.6 13.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M16 12.6 12.6 9.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.75" />
      <circle cx="16" cy="10.4" r="2.5" fill="currentColor" />
      <circle cx="16" cy="10.4" r="1" fill="var(--bg)" />
      <circle cx="9.4" cy="9.8" r="1.5" fill="currentColor" opacity="0.85" />
      <circle cx="22.6" cy="13.6" r="1.5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}
