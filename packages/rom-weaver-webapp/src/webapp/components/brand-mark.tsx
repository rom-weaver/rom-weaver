import type { SVGProps } from "react";

/**
 * The logo is inlined, not an <img> asset, so the accent band can be dyed by
 * `--thread` in CSS (see masthead.css). A per-accent image cannot read a custom
 * property, so its `src` had to be chosen in JS: the prerendered shell shipped
 * the build's default accent, React wanted the stored one, and React does not
 * patch a hydration attribute mismatch - leaving the mark on the wrong dye.
 *
 * The two threads interlace: the cream one passes over the accent one at the
 * left crossing, the accent one over the cream at the right. Painter order
 * alone cannot do that, so the accent thread is drawn twice - once under the
 * cream thread, then again clipped to the right half. Each thread carries a
 * charcoal casing stroke that opens the gap at the crossing it passes under.
 * Keep this geometry in step with src/assets/app/root/logo.svg.
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
      <clipPath id="rom-weaver-mark-right-half">
        <path d="M16 14h18v18H16z" />
      </clipPath>
      <path d="M-1 26.4C10 26.4 12 21.2 16 21.2s6 5.2 17 5.2" id="rom-weaver-mark-thread-back" />
      <path d="M-1 20.2C10 20.2 12 26.4 16 26.4s6-6.2 17-6.2" id="rom-weaver-mark-thread-front" />
    </defs>
    <g clipPath="url(#rom-weaver-mark-cartridge)">
      <path d="M0 0h32v32H0z" fill="#20282d" />
      <use fill="none" href="#rom-weaver-mark-thread-back" stroke="#20282d" strokeWidth="6.6" />
      <use className="brand-mark-band" fill="none" href="#rom-weaver-mark-thread-back" strokeWidth="4.4" />
      <use fill="none" href="#rom-weaver-mark-thread-front" stroke="#20282d" strokeWidth="6.6" />
      <use fill="none" href="#rom-weaver-mark-thread-front" stroke="#f6ecda" strokeWidth="4.4" />
      <g clipPath="url(#rom-weaver-mark-right-half)">
        <use fill="none" href="#rom-weaver-mark-thread-back" stroke="#20282d" strokeWidth="6.6" />
        <use className="brand-mark-band" fill="none" href="#rom-weaver-mark-thread-back" strokeWidth="4.4" />
      </g>
      <circle cx="16" cy="12" fill="#f6ecda" r="7.5" />
      <circle cx="16" cy="12" fill="#20282d" r="2.75" />
    </g>
    <use fill="none" href="#rom-weaver-mark-shell" stroke="#20282d" strokeWidth="2" />
    <use fill="none" href="#rom-weaver-mark-shell" stroke="#f6ecda" strokeWidth="0.75" />
  </svg>
);

export { BrandMark };
