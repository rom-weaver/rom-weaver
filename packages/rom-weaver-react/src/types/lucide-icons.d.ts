declare module "lucide-react/dist/esm/icons/*.js" {
  import type { LucideProps } from "lucide-react";
  import type { ForwardRefExoticComponent, RefAttributes } from "react";

  const Icon: ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>;

  export default Icon;
}
