import type { ReactNode } from "react";
import type { ChecksumVariant, ExtractTiming } from "../../../../types/checksum.ts";
import { DiscSheetsPanel } from "./cue-panel.tsx";
import { FixesPanel, type FixesPanelProps } from "./fixes-panel.tsx";
import {
  type ChecksumPendingGroup,
  type DiscTrackPanelInfo,
  DiscTracksPanel,
  type SourceInfoChecksums,
  SourceInfoList,
  type SourceInfoProgress,
} from "./source-info-list.tsx";

type RomInputInfoPanelProps = {
  bytes?: number;
  checksums?: SourceInfoChecksums | null;
  checksumVariants?: ChecksumVariant[];
  defaultOpen?: boolean;
  extractTiming?: ExtractTiming;
  lead?: ReactNode;
  onToggle?: (open: boolean) => void;
  open?: boolean;
  pending?: ChecksumPendingGroup[];
  progress?: SourceInfoProgress | null;
  timing?: ReactNode;
};

type RomInputPanelsProps = {
  fixes?: Omit<FixesPanelProps, "label">;
  info?: RomInputInfoPanelProps;
  /**
   * Per-track checksums for a multi-track disc. When present, the disc's tracks
   * are listed under one "Tracks" section instead of the single `info` panel.
   */
  tracks?: DiscTrackPanelInfo[];
  cue?: { cueText: string };
  /** A GD-ROM `.gdi` sheet shown as its own section, separate from the cue. */
  gdi?: { gdiText: string };
  showFixes?: boolean;
  showInfo?: boolean;
  showCue?: boolean;
};

const RomInputPanels = ({
  fixes = {},
  info = {},
  tracks,
  cue,
  gdi,
  showFixes = true,
  showInfo = true,
  showCue = true,
}: RomInputPanelsProps) => {
  const isDisc = Array.isArray(tracks) && tracks.length > 0;
  const renderInfo = () => {
    if (isDisc) return <DiscTracksPanel tracks={tracks} />;
    if (showInfo) return <SourceInfoList {...info} />;
    return null;
  };
  // Shared card drawer order: Options first, then the disc index sheets, then
  // the checks (a single "Checks" panel, or "Checks & Tracks" for a disc). The
  // Extract drawer leads above these, rendered by the card row.
  return (
    <>
      {showFixes && !isDisc ? <FixesPanel {...fixes} /> : null}
      {showCue ? <DiscSheetsPanel cueText={cue?.cueText} gdiText={gdi?.gdiText} /> : null}
      {renderInfo()}
    </>
  );
};

export { RomInputPanels };
