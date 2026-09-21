import type { ReactNode } from "react";
import type { IdentifyRecordChecks } from "../../../../lib/identify/identify-record-checks.ts";
import { abbreviatePlatform } from "../../../../presentation/platform-abbreviations.ts";
import { identifyMatchCountLabel } from "../../../../presentation/identify-status.ts";
import type { ChecksumVariant, ExtractTiming } from "../../../../types/checksum.ts";
import type { ParsedIdentifyLookupResult } from "../../../../types/identify.ts";
import { useRomWeaverSettings, useUiLocalizer } from "../../settings-context.tsx";
import { DiscSheetsPanel } from "./cue-panel.tsx";
import { DrawerReadout } from "./drawer.tsx";
import { IdentifyDrawer, PendingIdentifyDrawer } from "../../../../webapp/components/identify-drawer.tsx";
import {
  type ChecksumPendingGroup,
  type DiscTrackPanelInfo,
  DiscTracksPanel,
  type SourceInfoChecksums,
  type SourceInfoExpectedChecks,
  SourceInfoList,
  type SourceInfoProgress,
  type TrimFixDetails,
} from "./source-info-list.tsx";

type RomInputInfoPanelProps = {
  bytes?: number;
  checksums?: SourceInfoChecksums | null;
  checksumVariants?: ChecksumVariant[];
  /** Identify-record checks that fill the rows the run did not compute. */
  database?: IdentifyRecordChecks;
  defaultOpen?: boolean;
  /** Bundle-expected ROM checks, rendered as an "Expected" group with match marks. */
  expected?: SourceInfoExpectedChecks;
  extractTiming?: ExtractTiming;
  lead?: ReactNode;
  onToggle?: (open: boolean) => void;
  open?: boolean;
  pending?: ChecksumPendingGroup[];
  progress?: SourceInfoProgress | null;
  timing?: ReactNode;
  /** Trim-padding probe; surfaces a "Trim" group in Checks only when detected. */
  trim?: TrimFixDetails | null;
};

type RomInputPanelsProps = {
  info?: RomInputInfoPanelProps;
  identification?: ParsedIdentifyLookupResult;
  /** Open the Identify drawer on arrival (the identify page's product view). */
  identifyDefaultOpen?: boolean;
  /** The file is still staging, so no lookup result exists yet: hold the Identify
   * slot with a placeholder instead of letting the drawer appear late. */
  identifyPending?: boolean;
  /** Detected system tag (e.g. "PSX · CD") for the Identify drawer; shown even without a lookup result. */
  platformTag?: string;
  /**
   * Per-track checksums for a multi-track disc. When present, the disc's tracks
   * are listed under one "Tracks" section instead of the single `info` panel.
   */
  tracks?: DiscTrackPanelInfo[];
  cue?: { cueText: string };
  /** A GD-ROM `.gdi` sheet shown as its own section, separate from the cue. */
  gdi?: { gdiText: string };
  showInfo?: boolean;
  showCue?: boolean;
};

const RomInputPanels = ({
  info = {},
  identification,
  identifyDefaultOpen,
  identifyPending,
  platformTag,
  tracks,
  cue,
  gdi,
  showInfo = true,
  showCue = true,
}: RomInputPanelsProps) => {
  const localizer = useUiLocalizer();
  const { detailedViewEnabled = false } = useRomWeaverSettings();
  const isDisc = Array.isArray(tracks) && tracks.length > 0;
  const matchedPlatforms = [...new Set((identification?.matches ?? []).map((match) => match.platform).filter(Boolean))];
  const systemTag = matchedPlatforms.length ? matchedPlatforms.map(abbreviatePlatform).join(" · ") : platformTag;
  const status = identification?.status;
  const summary = detailedViewEnabled ? undefined : (
    <>
      {systemTag ? <DrawerReadout>{systemTag}</DrawerReadout> : null}
      {identifyPending ? (
        <DrawerReadout muted>{localizer.message("ui.identifyDrawer.identifying")}</DrawerReadout>
      ) : status === "matched" ? (
        <DrawerReadout>{localizer.message("ui.file.identified")}</DrawerReadout>
      ) : status === "ambiguous" ? (
        <DrawerReadout muted>{identifyMatchCountLabel(identification?.matches.length ?? 0)}</DrawerReadout>
      ) : status ? (
        <DrawerReadout muted>{localizer.message("ui.identifyDrawer.unidentified")}</DrawerReadout>
      ) : null}
    </>
  );
  const renderInfo = () => {
    if (isDisc) return <DiscTracksPanel summary={summary} timing={info.timing} tracks={tracks} />;
    if (showInfo) return <SourceInfoList {...info} summary={summary} />;
    return null;
  };
  // Shared card drawer order: the disc index sheets, then the single Checks
  // panel. The Files drawer leads above these, rendered by the card row.
  return (
    <>
      {detailedViewEnabled && showCue ? <DiscSheetsPanel cueText={cue?.cueText} gdiText={gdi?.gdiText} /> : null}
      {detailedViewEnabled && identifyPending ? (
        <PendingIdentifyDrawer platformTag={platformTag} />
      ) : detailedViewEnabled && (identification || platformTag) ? (
        <IdentifyDrawer defaultOpen={identifyDefaultOpen} identification={identification} platformTag={platformTag} />
      ) : null}
      {renderInfo()}
    </>
  );
};

export { RomInputPanels };
