import { BRAND_MARK_SRC } from "virtual:rom-weaver-brand-marks";
import { DEFAULT_ACCENT, useAccent } from "../accent.ts";

// The adjacent brand name supplies the accessible label.
const BrandMark = () => {
  const accent = useAccent();
  const src = BRAND_MARK_SRC[accent] ?? BRAND_MARK_SRC[DEFAULT_ACCENT];
  return <img alt="" className="brand-mark" height={44} src={src} width={44} />;
};

export { BrandMark };
