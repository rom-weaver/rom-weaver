import { abbreviatePlatform } from "../../../../presentation/platform-abbreviations.ts";

const PlatformName = ({ name }: { name: string }) => (
  <span title={name}>
    <span aria-hidden="true">{abbreviatePlatform(name)}</span>
    <span className="sr-only">{name}</span>
  </span>
);

export { PlatformName };
