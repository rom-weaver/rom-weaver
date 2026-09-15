import type { ImgHTMLAttributes } from "react";

const BrandMark = (props: ImgHTMLAttributes<HTMLImageElement>) => (
  <img alt="" className="brand-mark" height="192" src="/icon-maskable-192.png" width="192" {...props} />
);

export { BrandMark };
