import type { JSX } from "preact";

const SwapIcon = ({ className }: { className?: JSX.Signalish<string | undefined> }) => (
  <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
    <path d="M16 4.5 20 8.5l-4 4M20 8.5H7M8 19.5l-4-4 4-4M4 15.5h13" />
  </svg>
);

export { SwapIcon };
