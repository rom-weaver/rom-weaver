import type { SVGProps } from "react";
import brandMark from "../../../design/icon-masters/brand-mark.svg?raw";

const BRAND_MARK_PATHS = [...brandMark.matchAll(/<path class="([^"]+)"[^>]*d="([^"]+)"\s*\/>/g)].map(
  ([, className, d]) => ({ className, d }),
);

if (BRAND_MARK_PATHS.length !== 2) {
  throw new Error("Brand mark source must contain exactly two paths");
}

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
    {BRAND_MARK_PATHS.map(({ className, d }) => (
      <path className={className} d={d} key={className} />
    ))}
  </svg>
);

export { BrandMark };
