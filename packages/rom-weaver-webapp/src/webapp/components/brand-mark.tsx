import type { SVGProps } from "react";

// The accent MUST follow CSS during hydration so a stored palette appears on the first paint.
const BrandMark = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    className="brand-mark"
    fill="none"
    viewBox="0 0 64 64"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M14 4h8v6h20V4h8a6 6 0 0 1 6 6v44a6 6 0 0 1-6 6h-7v-9h-5v9h-5v-9h-5v9h-5v-9h-5v9h-4a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6ZM12.75 20L22.75 20C24.637548 20 26.24007 20.356283 27.503763 21.015051L27.25 20L31.75 20L35.25 35L39.25 26L43.25 35L46.75 20L51.25 20L45.75 42L41.25 42L39.25 36L37.25 42L30.25 42L22.25 33L17.25 33L17.25 42L12.75 42ZM17.25 24L17.25 29L22.75 29C25.049999 29 26.25 28.1 26.25 26.5C26.25 24.9 25.049999 24 22.75 24ZM29.760334 30.041336C29.07148 31.095697 28.044876 31.885639 26.75 32.299999L31.550354 37.201412L29.760334 30.041336Z"
      fill="currentColor"
      fillRule="evenodd"
    />
    <path
      className="brand-mark-accent"
      fillRule="evenodd"
      d="M12.75 20L22.75 20C27.75 20 30.75 22.5 30.75 26.5C30.75 29.299999 29.25 31.5 26.75 32.299999L36.25 42L30.25 42L22.25 33L17.25 33L17.25 42L12.75 42ZM17.25 24L17.25 29L22.75 29C25.049999 29 26.25 28.1 26.25 26.5C26.25 24.9 25.049999 24 22.75 24Z"
    />
  </svg>
);

export { BrandMark };
