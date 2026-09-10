import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { ScanSearch } from "lucide-react";
import { identifyGoodToolsRevisionLabels, uniqueIdentifyDisplayNames } from "../../presentation/identify-title.ts";
import { abbreviatePlatform } from "../../presentation/platform-abbreviations.ts";
import {
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
  const localizer = useUiLocalizer();
  const matches = identification?.matches ?? [];
  const { condition, database, evidence, hint, platformCandidates, quality, status } = identification ?? {};
  // The system tag alone is worth a drawer, as is a structured condition
  // (database required / unsupported media profile) or a match. A database that
  // answered and held no record still renders, as localizer.message("ui.identifyDrawer.unidentified"): the staging
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
    matches.map((match) =>
      typeof match.discNumber === "number"
        ? localizer.message("ui.identifyDrawer.discNumber", { n: match.discNumber })
        : "",
    ),
  );
  const legacyVariant = matches.some((match) => match.legacyVariant);
  // A finished lookup that matched nothing still opens the drawer, on the
  // localizer.message("ui.identifyDrawer.unidentified") readout alone - no localizer.message("ui.identifyDrawer.evidence") head over no rows.
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
      label={localizer.message("ui.identifyDrawer.identify")}
      labelIcon={<ScanSearch aria-hidden="true" />}
      readouts={
        <>
          {systemTag ? <DrawerReadout>{systemTag}</DrawerReadout> : null}
          {condition ? (
            <DrawerReadout muted>{localizer.message(`ui.identifyDrawer.condition.${condition}`)}</DrawerReadout>
          ) : status === "matched" ? (
            <DrawerReadout>{localizer.message("ui.file.identified")}</DrawerReadout>
          ) : status === "ambiguous" ? (
            <DrawerReadout muted>{identifyMatchCountLabel(matches.length)}</DrawerReadout>
          ) : status ? (
            <DrawerReadout muted>{localizer.message("ui.identifyDrawer.unidentified")}</DrawerReadout>
          ) : null}
        </>
      }
    >
      <div className="identify-drawer-body">
        {condition ? (
          <p className="pdesc identify-drawer-condition">
            <b>{localizer.message(`ui.identifyDrawer.condition.${condition}`)}.</b>{" "}
            {hint || localizer.message("ui.identifyDrawer.unsupported")}
          </p>
        ) : null}
        {names.length ? (
          <div className="ck-group identify-drawer-group">
            <div className="ck-group-head">{localizer.message("ui.identifyDrawer.names")}</div>
            <div className="ckrows identify-drawer-names">
              {names.map((name) => (
                <ChecksumRow
                  ariaLabel={localizer.message("ui.identifyDrawer.copyName", { name })}
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
            <EvidenceRow label={localizer.message("ui.identifyDrawer.system")} values={[systemTag]} />
          </div>
        ) : null}
        {identification && hasEvidence ? (
          <div className="ck-group identify-drawer-group">
            <div className="ck-group-head">{localizer.message("ui.identifyDrawer.evidence")}</div>
            <div className="ckrows identify-drawer-evidence">
              {quality ? (
                <EvidenceRow
                  label={localizer.message("ui.identifyDrawer.quality")}
                  values={[localizer.message(`ui.identifyDrawer.quality.${quality}`)]}
                />
              ) : null}
              {sourceParts.length ? (
                <EvidenceRow
                  label={localizer.message("ui.identifyDrawer.database")}
                  values={[sourceParts.join(" · ")]}
                />
              ) : null}
              {platformCandidates?.length ? (
                <EvidenceRow
                  label={localizer.message("ui.identifyDrawer.platformCandidates")}
                  values={platformCandidates.map((candidate) =>
                    [candidate.platform, candidate.confidence, candidate.evidence].filter(Boolean).join(" — "),
                  )}
                />
              ) : null}
              {componentEvidence ? (
                <EvidenceRow
                  label={localizer.message("ui.identifyDrawer.components")}
                  values={[
                    componentEvidence,
                    ...(evidence?.layoutMatched === false
                      ? [localizer.message("ui.identifyDrawer.layoutDiffers")]
                      : []),
                  ]}
                />
              ) : null}
              {evidence?.missing?.length ? (
                <EvidenceRow label={localizer.message("ui.identifyDrawer.missing")} values={evidence.missing} />
              ) : null}
              {evidence?.unexpected?.length ? (
                <EvidenceRow label={localizer.message("ui.identifyDrawer.unexpected")} values={evidence.unexpected} />
              ) : null}
              <EvidenceRow label={localizer.message("ui.identifyDrawer.matchedBy")} values={algorithms} />
              <EvidenceRow label={localizer.message("ui.identifyDrawer.variant")} values={variants} />
              <EvidenceRow
                label={localizer.message("ui.identifyDrawer.platform")}
                values={platforms.map(abbreviatePlatform)}
              />
              {regions.length ? (
                <EvidenceRow label={localizer.message("ui.identifyDrawer.region")} values={regions} />
              ) : null}
              {languages.length ? (
                <EvidenceRow label={localizer.message("ui.identifyDrawer.language")} values={languages} />
              ) : null}
              {revisions.length ? (
                <EvidenceRow label={localizer.message("ui.identifyDrawer.revision")} values={revisions} />
              ) : null}
              {discs.length ? <EvidenceRow label={localizer.message("ui.identifyDrawer.disc")} values={discs} /> : null}
              {sources.length ? (
                <EvidenceRow label={localizer.message("ui.identifyDrawer.source")} values={sources} />
              ) : null}
              {legacyVariant ? (
                <EvidenceRow
                  label={localizer.message("ui.identifyDrawer.variantClass")}
                  values={[localizer.message("ui.identifyDrawer.legacyVariant")]}
                />
              ) : null}
              {dumpTags.length ? (
                <EvidenceRow label={localizer.message("ui.identifyDrawer.dumpStatus")} values={dumpTags} />
              ) : null}
              {memberPath ? (
                <EvidenceRow label={localizer.message("ui.identifyDrawer.archiveMember")} values={[memberPath]} />
              ) : null}
              {status === "ambiguous" ? (
                <EvidenceRow
                  label={localizer.message("ui.identifyDrawer.candidates")}
                  values={[identifyMatchCountLabel(matches.length)]}
                />
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
const PendingIdentifyDrawer = ({ platformTag }: { platformTag?: string }) => {
  const localizer = useUiLocalizer();
  return (
    <Drawer
      className="identify-drawer"
      label={localizer.message("ui.identifyDrawer.identify")}
      labelIcon={<ScanSearch aria-hidden="true" />}
      readouts={
        <>
          {platformTag ? <DrawerReadout>{platformTag}</DrawerReadout> : null}
          <DrawerReadout muted>{localizer.message("ui.identifyDrawer.identifying")}</DrawerReadout>
        </>
      }
    >
      <div className="identify-drawer-body">
        <p className="pdesc">{localizer.message("ui.identifyDrawer.pending")}</p>
        <div className="ckrows identify-drawer-evidence">
          <PendingChecksumRow label={localizer.message("ui.identifyDrawer.standard")} length={24} />
          <PendingChecksumRow label={localizer.message("ui.identifyDrawer.matchedBy")} length={5} />
          <PendingChecksumRow label={localizer.message("ui.identifyDrawer.platform")} length={5} />
        </div>
      </div>
    </Drawer>
  );
};

export { IdentifyDrawer, PendingIdentifyDrawer };
