/**
 * Aurea mark — an arch (the riverside colonnade) struck through by a rising
 * diagonal (the river). Reads at 20px and at 200px, monochrome, inherits color.
 */
export function AureaMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
      data-testid="logo-mark"
    >
      <path
        d="M6 27V14a10 10 0 0 1 20 0v13"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M3 21c6.5 0 9.5-6 13-6s6.5 3 13 3" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function AureaLogo({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-2.5" data-testid="logo">
      <AureaMark className="h-7 w-7 text-primary" />
      <div className="leading-none">
        <div className="font-serif text-base font-semibold tracking-tight">Aurea</div>
        {subtitle ? (
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );
}
