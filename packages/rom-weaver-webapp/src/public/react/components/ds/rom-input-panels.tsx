import type { ReactNode } from "react";
import type { ChecksumVariant, ExtractTiming } from "../../../../types/checksum.ts";
import type { ParsedIdentifyLookupResult } from "../../../../types/identify.ts";
import { DiscSheetsPanel } from "./cue-panel.tsx";
import { IdentifyDrawer } from "../../../../webapp/components/identify-drawer.tsx";
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
  platformTag,
  tracks,
  cue,
  gdi,
  showInfo = true,
  showCue = true,
}: RomInputPanelsProps) => {
  const isDisc = Array.isArray(tracks) && tracks.length > 0;
  const renderInfo = () => {
    if (isDisc) return <DiscTracksPanel timing={info.timing} tracks={tracks} />;
    if (showInfo) return <SourceInfoList {...info} />;
    return null;
  };
  // Shared card drawer order: the disc index sheets, then the single Checks
  // panel. The Files drawer leads above these, rendered by the card row.
  return (
    <>
      {showCue ? <DiscSheetsPanel cueText={cue?.cueText} gdiText={gdi?.gdiText} /> : null}
      {identification || platformTag ? (
        <IdentifyDrawer defaultOpen={identifyDefaultOpen} identification={identification} platformTag={platformTag} />
      ) : null}
      {renderInfo()}
    </>
  );
};

export { RomInputPanels };
