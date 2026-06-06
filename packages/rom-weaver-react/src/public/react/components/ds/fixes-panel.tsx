import type { ReactNode } from "react";
import { formatByteSize } from "../../../../presentation/workflow-presentation.ts";
import { ChecksumList, ChecksumRow } from "./checksum-list.tsx";

type TrimFixDetails = {
  detected?: boolean;
  mode?: string;
  preservedDownloadPlayCert?: boolean;
  trimmedInputBytes?: number;
};

type FixesPanelProps = {
  defaultOpen?: boolean;
  headerSummary?: string;
  headerValue?: ReactNode;
  label?: ReactNode;
  lead?: ReactNode;
  romInfoText?: string;
  trim?: TrimFixDetails | null;
  trimValue?: ReactNode;
};

const ROM_TYPE_REGEX = /^(.+?)\s+ROM\b/i;

const getRomTypeSummary = (romInfoText: string | undefined) =>
  String(romInfoText || "")
    .match(ROM_TYPE_REGEX)?.[1]
    ?.trim() || "";

const getTrimSummary = (trim: TrimFixDetails | null | undefined) =>
  trim ? (trim.detected ? "trim detected" : "trim not detected") : "trim not checked";

const getFixesSummary = ({
  headerSummary,
  romInfoText,
  trim,
}: {
  headerSummary?: string;
  romInfoText?: string;
  trim?: TrimFixDetails | null;
}) => {
  if (!romInfoText) return getTrimSummary(trim);
  return [getRomTypeSummary(romInfoText), headerSummary, getTrimSummary(trim)].filter(Boolean).join(" · ");
};

const getTrimFixLabel = (trim: TrimFixDetails | null | undefined) => {
  if (!trim) return "Not checked";
  if (!trim?.detected) return "Not detected";
  const details = [
    typeof trim.trimmedInputBytes === "number" ? formatByteSize(trim.trimmedInputBytes) : "",
    trim.mode ? `mode ${trim.mode}` : "",
    trim.preservedDownloadPlayCert ? "download-play cert preserved" : "",
  ].filter(Boolean);
  return details.length ? `Detected (${details.join(" · ")})` : "Detected";
};

const FixesPanel = ({
  defaultOpen = false,
  headerSummary,
  headerValue = "No change",
  label = "Options",
  lead,
  romInfoText,
  trim,
  trimValue,
}: FixesPanelProps) => (
  <ChecksumList
    defaultOpen={defaultOpen}
    label={label}
    lead={lead}
    sublabel={getFixesSummary({ headerSummary, romInfoText, trim })}
  >
    <ChecksumRow label="HEADER" value={headerValue} />
    <ChecksumRow label="TRIM" value={trimValue ?? getTrimFixLabel(trim)} />
  </ChecksumList>
);

export { FixesPanel, type FixesPanelProps, type TrimFixDetails };
