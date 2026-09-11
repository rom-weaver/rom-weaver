import { useId, type SVGProps } from "react";

// The accent MUST follow CSS during hydration so a stored palette appears on the first paint.
const BrandMark = (props: SVGProps<SVGSVGElement>) => {
  const paintId = useId();

  return (
    <svg
      aria-hidden="true"
      className="brand-mark"
      fill="none"
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <defs>
        <pattern height="64" id={paintId} patternUnits="userSpaceOnUse" width="64">
          <rect fill="currentColor" height="64" width="64" />
          <rect className="brand-mark-accent" height="10" width="32" x="32" />
        </pattern>
      </defs>
      <path
        d="M14 4h8v6h20V4h8a6 6 0 0 1 6 6v44a6 6 0 0 1-6 6h-7v-9h-5v9h-5v-9h-5v9h-5v-9h-5v9h-4a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6Zm2 14 7 25h7l2-6 2 6h7l7-25h-8l-3 14-5-10-5 10-3-14Z"
        fill={`url(#${paintId})`}
        fillRule="evenodd"
      />
    </svg>
  );
};

export { BrandMark };
