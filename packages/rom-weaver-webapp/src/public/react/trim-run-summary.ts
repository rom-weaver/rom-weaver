import { TRIM_PLATFORM_SUMMARY } from "./trim-supported-files.ts";
import type { TrimMode } from "../../lib/trim/trim-output-name.ts";

/** What a Trim run will do to the staged input; `pending` until staging has probed it. */
type TrimRunKind = "cartridge" | "pending" | "restore" | "unsupported" | "xiso";

type TrimRunInput = {
  fileName: string;
  mode: TrimMode;
  /** The engine can restore this input's padding (cartridge ROMs; not XISO). */
  restoreAvailable: boolean;
  /** Staging finished and the engine's dry-run plan accepted the input. */
  trimSupported?: boolean;
  /** Engine says the image is an Xbox XISO. */
  xiso: boolean;
};

const getTrimRunKind = ({ mode, restoreAvailable, trimSupported, xiso }: TrimRunInput): TrimRunKind => {
  if (trimSupported === false) return "unsupported";
  if (mode === "restore") return "restore";
  if (xiso) return "xiso";
  if (restoreAvailable) return "cartridge";
  return "pending";
};

/** The visible sentence in the output step: what this run does for this input. */
const describeTrimRun = (input: TrimRunInput): string => {
  const { fileName } = input;
  switch (getTrimRunKind(input)) {
    case "unsupported":
      return `Trim supports ${TRIM_PLATFORM_SUMMARY} images. ${fileName} isn't one of them - use Compress for other files.`;
    case "restore":
      return `Restore pads ${fileName} back to full size. The result is byte-exact only if the ROM carries a revert marker; otherwise the padding is rebuilt as 0xFF.`;
    case "xiso":
      return `Trim rebuilds ${fileName} without its unused space. This can't be restored, so keep the original.`;
    case "cartridge":
      return `Trim removes trailing padding from ${fileName} and adds a 12-byte revert marker, so Restore padding can rebuild the original exactly.`;
    default:
      return "";
  }
};

export { describeTrimRun, getTrimRunKind };
