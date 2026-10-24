import { abbreviatePlatform } from "../../../../presentation/platform-abbreviations.ts";
import { identifyMatchCountLabel } from "../../../../presentation/identify-status.ts";
import type { ParsedIdentifyLookupResult } from "../../../../types/identify.ts";
import { useUiLocalizer } from "../../settings-context.tsx";
import { DrawerReadout } from "./drawer.tsx";

const RomIdentificationReadouts = ({
  identification,
  identifyPending,
  platformTag,
}: {
  identification?: ParsedIdentifyLookupResult;
  identifyPending?: boolean;
  platformTag?: string;
}) => {
  const localizer = useUiLocalizer();
  const matchedPlatforms = [...new Set((identification?.matches ?? []).map((match) => match.platform).filter(Boolean))];
  const systemTag = matchedPlatforms.length ? matchedPlatforms.map(abbreviatePlatform).join(" · ") : platformTag;
  const status = identification?.status;
  const statusLabel = () => {
    if (identifyPending) return localizer.message("ui.identifyDrawer.identifying");
    if (identification?.condition) return localizer.message(`ui.identifyDrawer.condition.${identification.condition}`);
    if (status === "unavailable") return localizer.message("ui.apply.titleLookupUnavailable");
    if (status === "matched") return localizer.message("ui.file.identified");
    if (status === "ambiguous") return identifyMatchCountLabel(identification?.matches.length ?? 0);
    if (status) return localizer.message("ui.identifyDrawer.unidentified");
    return "";
  };
  const label = statusLabel();
  return (
    <>
      {systemTag ? <DrawerReadout>{systemTag}</DrawerReadout> : null}
      {label ? (
        <DrawerReadout muted={identifyPending || !!identification?.condition || status !== "matched"}>
          {label}
        </DrawerReadout>
      ) : null}
    </>
  );
};

export { RomIdentificationReadouts };
