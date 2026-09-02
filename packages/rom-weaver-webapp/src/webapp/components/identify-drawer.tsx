import { ScanSearch } from "lucide-react";
import { identifyGoodToolsRevisionLabels, uniqueIdentifyDisplayNames } from "../../presentation/identify-title.ts";
import { abbreviatePlatform } from "../../presentation/platform-abbreviations.ts";
import {
  IDENTIFY_CONDITION_LABEL,
  IDENTIFY_QUALITY_LABEL,
  IDENTIFY_STATUS_MARK,
  identifyComponentEvidenceLabel,
  identifyDumpTagLabel,
  identifyMatchCountLabel,
  identifySourceLabel,
} from "../../presentation/identify-status.ts";
import { ChecksumRow, PendingChecksumRow } from "../../public/react/components/ds/checksum-list.tsx";
import type { ParsedIdentifyLookupResult } from "../../types/identify.ts";
import { Drawer, DrawerReadout } from "../../public/react/components/ds/drawer.tsx";

const unique = (values: Iterable<string>) => [...new Set([...values].map((value) => value.trim()).filter(Boolean))];

/* A value shorter than this pairs two rows per line (ck-half); a longer one
   keeps the full row so it never collides with its neighbour. */
const HALF_ROW_MAX_CHARS = 16;

/** `ck-half` only while the value still fits half a row. Game names run long
 * ("Pokemon - Emerald Version (USA, Europe)"), and a half row wraps them over
 * three lines beside an empty column. */
const halfRowClass = (value: string): string | undefined => (value.length < HALF_ROW_MAX_CHARS ? "ck-half" : undefined);

const EvidenceRow = ({ label, values }: { label: string; values: readonly string[] }) => {
  if (!values.length) return null;
  const value = values.join(" · ");
  return <ChecksumRow className={halfRowClass(value)} copyValue={value} label={label} value={value} />;
};

const IdentifyDrawer = ({
  defaultOpen,
  identification,
  memberPath,
  platformTag,
}: {
  defaultOpen?: boolean;
  identification?: ParsedIdentifyLookupResult;
  /** Archive-relative member path, when the identified ROM came out of a container. */
  memberPath?: string;
  /** Detected system tag (e.g. "PSX · CD") shown on the drawer whether or not a title matched. */
  platformTag?: string;
}) => {
  const matches = identification?.matches ?? [];
  const { condition, database, evidence, hint, platformCandidates, quality, status } = identification ?? {};
  // The system tag alone is worth a drawer, as is a structured condition
  // (database required / unsupported media profile) or a match. A database that
  // answered and held no record still renders, as "Unidentified": the staging
  // card holds this slot with a placeholder, so a drawer that vanished on
  // arrival would shift the card exactly as a late one does. `unavailable` is
  // the exception - the packs never loaded, so there is no lookup to report and
  // the card's own "Title lookup unavailable" note carries it instead.
  if (!(matches.length || condition || platformTag || (status && status !== "unavailable"))) return null;
  const sourceParts = [database?.source ? identifySourceLabel(database.source) : "", database?.packFormat || ""].filter(
    Boolean,
  );
  const componentEvidence =
    evidence &&
    typeof evidence.requiredComponentsMatched === "number" &&
    typeof evidence.requiredComponentsTotal === "number"
      ? identifyComponentEvidenceLabel(evidence.requiredComponentsMatched, evidence.requiredComponentsTotal)
      : "";
  const names = uniqueIdentifyDisplayNames(matches);
  const platforms = unique(matches.map((match) => match.platform));
  const algorithms = unique(matches.map((match) => match.algorithm.toUpperCase()));
  const variants = unique(matches.map((match) => match.variant));
  const sources = unique(
    matches.flatMap(
      (match) => match.provenance?.map((item) => identifySourceLabel(item.sourceName || item.source)) ?? [],
    ),
  );
  const dumpTags = unique(matches.flatMap((match) => match.dumpTags ?? [])).map(identifyDumpTagLabel);
  const regions = unique(matches.map((match) => match.region ?? ""));
  const languages = unique(matches.map((match) => match.language ?? ""));
  const sourceNames = matches.flatMap((match) => [match.name, ...(match.alternateNames ?? [])]);
  const revisions = unique([
    ...matches.map((match) => match.revision ?? ""),
    ...identifyGoodToolsRevisionLabels(sourceNames),
  ]);
  const discs = unique(
    matches.map((match) => (typeof match.discNumber === "number" ? `Disc ${match.discNumber}` : "")),
  );
  const legacyVariant = matches.some((match) => match.legacyVariant);
  const mark = status ? IDENTIFY_STATUS_MARK[status] : undefined;
  // A finished lookup that matched nothing still opens the drawer, on the
  // "Unidentified" readout alone - no "Evidence" head over no rows.
  const hasEvidence = !!(
    matches.length ||
    quality ||
    sourceParts.length ||
    platformCandidates?.length ||
    componentEvidence ||
    evidence?.missing?.length ||
    evidence?.unexpected?.length ||
    memberPath ||
    status === "ambiguous"
  );
  // The matched title's own platform outranks the probe's tag.
  const systemTag = platforms.length ? platforms.map(abbreviatePlatform).join(" · ") : platformTag?.trim();

  return (
    <Drawer
      className="identify-drawer"
      defaultOpen={defaultOpen}
      label="Identify"
      labelIcon={<ScanSearch aria-hidden="true" />}
      readouts={
        <>
          {systemTag ? <DrawerReadout>{systemTag}</DrawerReadout> : null}
          {condition ? (
            <DrawerReadout muted>{IDENTIFY_CONDITION_LABEL[condition]}</DrawerReadout>
          ) : status === "matched" && mark ? (
            <DrawerReadout>{mark.label}</DrawerReadout>
          ) : status === "ambiguous" ? (
            <DrawerReadout muted>{identifyMatchCountLabel(matches.length)}</DrawerReadout>
          ) : status ? (
            <DrawerReadout muted>Unidentified</DrawerReadout>
          ) : null}
        </>
      }
    >
      <div className="identify-drawer-body">
        {condition ? (
          <p className="pdesc identify-drawer-condition">
            <b>{IDENTIFY_CONDITION_LABEL[condition]}.</b>{" "}
            {hint || "The identification data does not support this input."}
          </p>
        ) : null}
        {names.length ? (
          <div className="ck-group identify-drawer-group">
            <div className="ck-group-head">Names</div>
            <div className="ckrows identify-drawer-names">
              {names.map((name) => (
                <ChecksumRow
                  ariaLabel={`Copy name ${name}`}
                  className={["identify-name-row", halfRowClass(name)].filter(Boolean).join(" ")}
                  copyValue={name}
                  key={name}
                  value={name}
                />
              ))}
            </div>
          </div>
        ) : null}
        {!identification && systemTag ? (
          <div className="ckrows">
            <EvidenceRow label="System" values={[systemTag]} />
          </div>
        ) : null}
        {identification && hasEvidence ? (
          <div className="ck-group identify-drawer-group">
            <div className="ck-group-head">Evidence</div>
            <div className="ckrows identify-drawer-evidence">
              {quality ? <EvidenceRow label="Quality" values={[IDENTIFY_QUALITY_LABEL[quality]]} /> : null}
              {sourceParts.length ? <EvidenceRow label="Database" values={[sourceParts.join(" · ")]} /> : null}
              {platformCandidates?.length ? (
                <EvidenceRow
                  label="Platform candidates"
                  values={platformCandidates.map((candidate) =>
                    [candidate.platform, candidate.confidence, candidate.evidence].filter(Boolean).join(" — "),
                  )}
                />
              ) : null}
              {componentEvidence ? (
                <EvidenceRow
                  label="Components"
                  values={[componentEvidence, ...(evidence?.layoutMatched === false ? ["layout differs"] : [])]}
                />
              ) : null}
              {evidence?.missing?.length ? <EvidenceRow label="Missing" values={evidence.missing} /> : null}
              {evidence?.unexpected?.length ? <EvidenceRow label="Unexpected" values={evidence.unexpected} /> : null}
              <EvidenceRow label="Matched by" values={algorithms} />
              <EvidenceRow label="Variant" values={variants} />
              <EvidenceRow label="Platform" values={platforms.map(abbreviatePlatform)} />
              {regions.length ? <EvidenceRow label="Region" values={regions} /> : null}
              {languages.length ? <EvidenceRow label="Language" values={languages} /> : null}
              {revisions.length ? <EvidenceRow label="Revision" values={revisions} /> : null}
              {discs.length ? <EvidenceRow label="Disc" values={discs} /> : null}
              {sources.length ? <EvidenceRow label="Source" values={sources} /> : null}
              {legacyVariant ? <EvidenceRow label="Variant class" values={["Legacy variant"]} /> : null}
              {dumpTags.length ? <EvidenceRow label="Dump status" values={dumpTags} /> : null}
              {memberPath ? <EvidenceRow label="Archive member" values={[memberPath]} /> : null}
              {status === "ambiguous" ? (
                <EvidenceRow label="Candidates" values={[identifyMatchCountLabel(matches.length)]} />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
};

/* Staging form of the Identify drawer. A ROM's title lookup only starts once
   its checksums land, so without this the drawer is simply absent while the
   card stages and then pushes the Checks drawer down when it arrives. The
   placeholder holds that slot, in the same position and with the same head
   height as the resolved drawer. */
const PendingIdentifyDrawer = ({ platformTag }: { platformTag?: string }) => (
  <Drawer
    className="identify-drawer"
    label="Identify"
    labelIcon={<ScanSearch aria-hidden="true" />}
    readouts={
      <>
        {platformTag ? <DrawerReadout>{platformTag}</DrawerReadout> : null}
        <DrawerReadout muted>Identifying…</DrawerReadout>
      </>
    }
  >
    <div className="identify-drawer-body">
      <p className="pdesc">
        Looking this ROM up in the title database. The rows below fill in once its checksums land.
      </p>
      <div className="ckrows identify-drawer-evidence">
        <PendingChecksumRow label="Standard" length={24} />
        <PendingChecksumRow label="Matched by" length={5} />
        <PendingChecksumRow label="Platform" length={5} />
      </div>
    </div>
  </Drawer>
);

export { IdentifyDrawer, PendingIdentifyDrawer };
