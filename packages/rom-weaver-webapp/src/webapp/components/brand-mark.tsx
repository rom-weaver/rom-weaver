import type { SVGProps } from "react";
import logo from "../../assets/app/root/logo.svg?raw";

const PARTS = [
  { fill: "var(--brand-cartridge)", name: "cartridge" },
  { fill: "var(--brand-r)", name: "r" },
  { fill: "var(--thread)", name: "w" },
].map(({ fill, name }) => {
  const group = logo.match(new RegExp(`<g id="brand-${name}" transform="([^"]+)"[^>]*>([\\s\\S]*?)</g>`));
  const paths = [...(group?.[2] ?? "").matchAll(/<path d="([^"]+)"\s*\/>/g)].map((match) => match[1]);
  if (!(group && paths.length)) throw new Error(`Brand mark source is missing the ${name} shape`);
  return { fill, name, paths, transform: group[1] };
});

// Shapes MUST be inline so external SVG references cannot leave the mark unpainted.
const BrandMark = (props: SVGProps<SVGSVGElement>) => (
  <svg aria-hidden="true" className="brand-mark" viewBox="0 0 1254 1254" xmlns="http://www.w3.org/2000/svg" {...props}>
    {PARTS.map(({ fill, name, paths, transform }) => (
      <g className={name === "w" ? "brand-mark-accent" : undefined} fill={fill} key={name} transform={transform}>
        {paths.map((d) => (
          <path d={d} key={d} />
        ))}
      </g>
    ))}
  </svg>
);

export { BrandMark };
