import { useId, type SVGProps } from "react";

const PARTS = [
  { fill: "var(--brand-cartridge)", name: "cartridge" },
  { fill: "var(--brand-r)", name: "r" },
  { fill: "var(--thread)", name: "w" },
] as const;

// The W MUST follow CSS during hydration so a stored accent appears on the first paint.
const BrandMark = (props: SVGProps<SVGSVGElement>) => {
  const maskPrefix = useId().replaceAll(":", "");
  return (
    <svg
      aria-hidden="true"
      className="brand-mark"
      viewBox="0 0 1254 1254"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <defs>
        {PARTS.map(({ name }) => (
          <mask
            id={`${maskPrefix}-${name}`}
            key={name}
            height="1254"
            maskUnits="userSpaceOnUse"
            style={{ maskType: "alpha" }}
            width="1254"
            x="0"
            y="0"
          >
            <use href={`/logo.svg#brand-${name}`} />
          </mask>
        ))}
      </defs>
      {PARTS.map(({ fill, name }) => (
        <rect
          className={name === "w" ? "brand-mark-accent" : undefined}
          fill={fill}
          height="1254"
          key={name}
          mask={`url(#${maskPrefix}-${name})`}
          width="1254"
        />
      ))}
    </svg>
  );
};

export { BrandMark };
