/** Foundry's mark: a terminal block with three conductors, neutral, phase and earth. */
export const Mark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="mark">
    <rect x="2.5" y="4" width="19" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M8 4v16" className="mark__n" strokeWidth="2.2" />
    <path d="M12 4v16" className="mark__p" strokeWidth="2.2" />
    <path d="M16 4v16" className="mark__g" strokeWidth="2.2" />
    <path d="M16 6v2M16 11v2M16 16v2" className="mark__y" strokeWidth="2.2" />
  </svg>
);
