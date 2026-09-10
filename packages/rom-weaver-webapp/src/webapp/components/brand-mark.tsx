import type { SVGProps } from "react";

/**
 * The logo is inlined, not an <img> asset, so the accent band can be dyed by
 * `--thread` in CSS (see masthead.css). A per-accent image cannot read a custom
 * property, so its `src` had to be chosen in JS: the prerendered shell shipped
 * the build's default accent, React wanted the stored one, and React does not
 * patch a hydration attribute mismatch - leaving the mark on the wrong dye.
 *
 * IDs are namespaced because the inline <defs> live in the page document, not a
 * private SVG document.
 */
const BrandMark = (props: SVGProps<SVGSVGElement>) => (
  <svg aria-hidden="true" className="brand-mark" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" {...props}>
    <defs>
      <clipPath id="rom-weaver-mark-cartridge">
        <path
          d="M6 1h4q1 0 1 1t1 1h8q1 0 1-1t1-1h4a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H6a5 5 0 0 1-5-5V6a5 5 0 0 1 5-5Z"
          id="rom-weaver-mark-shell"
        />
      </clipPath>
    </defs>
    <g clipPath="url(#rom-weaver-mark-cartridge)">
      <path d="M0 0h32v32H0z" fill="#20282d" />
      <circle cx="16" cy="12" fill="#f6ecda" r="7.5" />
      <circle cx="16" cy="12" fill="#20282d" r="2.75" />
      <path d="M0 29c14 0 17-9 32-9" fill="none" stroke="#f6ecda" strokeWidth="5" />
      <path d="M0 20c14 0 17 9 32 9" fill="none" stroke="#20282d" strokeWidth="7" />
      <path className="brand-mark-band" d="M0 20c14 0 17 9 32 9" fill="none" strokeWidth="5" />
    </g>
    <use fill="none" href="#rom-weaver-mark-shell" stroke="#20282d" strokeWidth="2" />
    <use fill="none" href="#rom-weaver-mark-shell" stroke="#f6ecda" strokeWidth="0.75" />
  </svg>
);

export { BrandMark };
