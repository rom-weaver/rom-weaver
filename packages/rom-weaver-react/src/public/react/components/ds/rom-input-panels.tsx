import type { ReactNode } from "react";
import { getDiscKind, getDiscKindLabel } from "../../../../lib/input/rom-specific-file-utils.ts";
import type { ChecksumVariant } from "../../../../types/checksum.ts";
import { CuePanel } from "./cue-panel.tsx";
import { FixesPanel, type FixesPanelProps } from "./fixes-panel.tsx";
import {
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
  discType?: string;
  lead?: ReactNode;
  onToggle?: (open: boolean) => void;
  open?: boolean;
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
  // Derive the disc type from the cue sheet so it appears in the source Info
  // panel; an explicit info.discType (e.g. from a non-cue source) wins.
  const discType = info.discType ?? getDiscKindLabel(getDiscKind({ cueText: cue?.cueText })) ?? undefined;
  const isDisc = Array.isArray(tracks) && tracks.length > 0;
  const renderInfo = () => {
    if (isDisc) return <DiscTracksPanel tracks={tracks} />;
    if (showInfo) return <SourceInfoList {...info} discType={discType} />;
    return null;
  };
  // Prototype drawer order: checks/tracks lead, then options, then the sheets.
  return (
    <>
      {renderInfo()}
      {showFixes && !isDisc ? <FixesPanel {...fixes} /> : null}
      {showCue && cue?.cueText ? <CuePanel cueText={cue.cueText} /> : null}
      {showCue && gdi?.gdiText ? <CuePanel cueText={gdi.gdiText} label="GDI" sublabel="gd-rom sheet" /> : null}
    </>
  );
};

export { RomInputPanels };
