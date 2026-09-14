import type { SVGProps } from "react";

const BrandMark = (props: SVGProps<SVGSVGElement>) => (
  <svg aria-hidden="true" className="brand-mark" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path
      d="M11 4h10v6h21V4h11a5 5 0 0 1 5 5v46a5 5 0 0 1-5 5h-8v-7h-5v7h-5v-7h-6v7h-5v-7h-5v7h-8a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5Z M16 17h14c4.5 0 7 3.5 7 7s-1.5 5.8-4.5 7l5 8h-6l-7.5-11h5c3 0 3-5 0-5h-7v17h-6Z"
      fill="currentColor"
      fillRule="evenodd"
    />
    <path
      className="brand-mark-accent"
      d="M23 30l8 12 1.8-4h4.6l2 4 3.6-12H51l-7.4 20h-5.5l-2.3-4.3L33.5 50h-5l-5.5-11Z"
    />
  </svg>
);

export { BrandMark };
