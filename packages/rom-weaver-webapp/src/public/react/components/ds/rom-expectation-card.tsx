import { Search } from "lucide-react";
import { Fragment, useState } from "react";
import { identifyDumpTagLabel, identifyMatchCountLabel } from "../../../../presentation/identify-status.ts";
import { uniqueIdentifyDisplayNames } from "../../../../presentation/identify-title.ts";
import type { ParsedBundleChecks } from "../../../../types/bundle.ts";
import type { ExpectedRomTitle } from "../../../../lib/apply/expected-rom-lookup.ts";
import { identifyRecordChecks } from "../../../../lib/identify/identify-record-checks.ts";
import type {
  ParsedIdentifyExpectedComponent,
  ParsedIdentifyResolution,
  ParsedIdentifyTitleMatch,
} from "../../../../types/identify.ts";
import { IdentifyDrawer } from "../../../../webapp/components/identify-drawer.tsx";
import { useUiLocalizer } from "../../settings-context.tsx";
import type { RomLookupMessages, useRomLookup } from "../../use-rom-lookup.ts";
import { ChecksumList, ChecksumRow } from "./checksum-list.tsx";
import { ExtractName } from "./extraction-tree.tsx";
import { FileCard } from "./file-card.tsx";

const EXPECTED_ROM_CHECK_LABELS: Record<string, string> = {
  crc32: "CRC32",
  md5: "MD5",
  sha1: "SHA-1",
  sha256: "SHA-256",
};

const EXPECTED_ROM_CHECK_ORDER = ["crc32", "md5", "sha1", "sha256"] as const;

const expectedCheckLabel = (algorithm: string) => EXPECTED_ROM_CHECK_LABELS[algorithm] || algorithm.toUpperCase();

const orderExpectedAlgorithms = (checksums: Record<string, string>) =>
  [...EXPECTED_ROM_CHECK_ORDER, ...Object.keys(checksums).sort()].filter(
    (algorithm, index, all) => checksums[algorithm] && all.indexOf(algorithm) === index,
  );

/* Rows for one checksum set. BYTES rides directly after CRC32: the two short
   ck-half rows must sit adjacent for the ckrows grid to pair them, matching the
   resolved ROM card. */
const ExpectedCheckRows = ({ checksums, size }: { checksums: Record<string, string>; size?: number }) => {
  const byteValue = typeof size === "number" && Number.isFinite(size) ? String(Math.floor(size)) : "";
  const algorithms = orderExpectedAlgorithms(checksums);
  const bytesRow = byteValue ? <ChecksumRow copyValue={byteValue} label="BYTES" value={byteValue} /> : null;
  return (
    <>
      {algorithms.map((algorithm) => (
        <Fragment key={algorithm}>
          <ChecksumRow label={expectedCheckLabel(algorithm)} value={checksums[algorithm] || ""} />
          {algorithm === "crc32" ? bytesRow : null}
        </Fragment>
      ))}
      {checksums.crc32 ? null : bytesRow}
    </>
  );
};

/* What the identify data adds beyond the check itself. The record is shared
   with the Checks drawer; this only subtracts what the check already asserts,
   so the card never repeats a value it is about to show as its own. */
const databaseOnlyChecks = (
  checks: ParsedBundleChecks | undefined,
  identification: ParsedIdentifyResolution | undefined,
): { checksums: Record<string, string>; size?: number } | undefined => {
  const record = identifyRecordChecks(identification);
  if (!record) return undefined;
  const own = checks?.checksums || {};
  const checksums: Record<string, string> = {};
  for (const algorithm of EXPECTED_ROM_CHECK_ORDER) {
    const value = record.checksums[algorithm];
    if (value && !own[algorithm]) checksums[algorithm] = value;
  }
  const size = typeof checks?.size === "number" || record.size === undefined ? undefined : record.size;
  if (!(Object.keys(checksums).length || size !== undefined)) return undefined;
  return { checksums, ...(size === undefined ? {} : { size }) };
};

/**
 * Where an expected-ROM check came from; it decides the card's meta line.
 * `manual` is a pasted checksum, `name` a title chosen from a name search.
 */
type RomExpectationSource = "bundle" | "manual" | "name" | "patch";

const ROM_EXPECTATION_META: Record<
  RomExpectationSource,
  | "ui.sourceInfo.expectationMetaBundle"
  | "ui.sourceInfo.expectationMetaManual"
  | "ui.sourceInfo.expectationMetaName"
  | "ui.sourceInfo.expectationMetaPatch"
> = {
  bundle: "ui.sourceInfo.expectationMetaBundle",
  manual: "ui.sourceInfo.expectationMetaManual",
  name: "ui.sourceInfo.expectationMetaName",
  patch: "ui.sourceInfo.expectationMetaPatch",
};

/* Who asserted the checks, for the merged group's head note. The database name
   follows it, so the note reads "by the bundle · No-Intro". */
const ROM_EXPECTATION_AUTHORITY: Record<
  RomExpectationSource,
  | "ui.sourceInfo.expectationAuthorityBundle"
  | "ui.sourceInfo.expectationAuthorityManual"
  | "ui.sourceInfo.expectationAuthorityName"
  | "ui.sourceInfo.expectationAuthorityPatch"
> = {
  bundle: "ui.sourceInfo.expectationAuthorityBundle",
  manual: "ui.sourceInfo.expectationAuthorityManual",
  name: "ui.sourceInfo.expectationAuthorityName",
  patch: "ui.sourceInfo.expectationAuthorityPatch",
};

/** The expectation source a search result asserts, by the route that found it. */
const romLookupSource = (foundBy: "checksum" | "name"): RomExpectationSource =>
  foundBy === "name" ? "name" : "manual";

/** What the workflow expects the ROM to be, and where that expectation came from. */
type RomExpectation = {
  checks?: ParsedBundleChecks;
  /** Advisory file name; only a bundle rom entry carries one. */
  name?: string;
  source: RomExpectationSource;
};

/**
 * Compare an expectation against a staged file's computed checks. `undefined`
 * when nothing could be compared - an expectation nobody measured yet is not a
 * verdict.
 */
const compareRomExpectation = (
  expectation: RomExpectation | undefined,
  actual: { checksums?: Record<string, string>; size?: number } | undefined,
): "bad" | "ok" | undefined => {
  const expected = expectation?.checks;
  if (!(expected && actual)) return undefined;
  let compared = 0;
  for (const [algorithm, value] of Object.entries(expected.checksums || {})) {
    const computed = actual.checksums?.[algorithm];
    if (!(value && computed)) continue;
    compared += 1;
    if (computed.trim().toLowerCase() !== value.trim().toLowerCase()) return "bad";
  }
  if (typeof expected.size === "number" && typeof actual.size === "number") {
    compared += 1;
    if (Math.floor(actual.size) !== Math.floor(expected.size)) return "bad";
  }
  return compared ? "ok" : undefined;
};

/**
 * "Provide this ROM" card for a rom check with no ROM behind it yet - a
 * patches-only bundle, a patch that declares its source ROM, or a checksum the
 * user pasted. Styled like the ROM card it becomes once the input lands; only
 * the meta note marks it expected. When the check identifies against the local
 * data the card is titled with that ROM and its ONE Expected group merges the
 * database's checksums and size into the check's own values.
 */
const RomExpectationCard = ({
  expectation,
  id = "rom-weaver-bundle-rom-expectation",
  identification,
  onRemove,
  removeLabel,
}: {
  expectation: RomExpectation;
  /** Owner-scoped element id: the apply and identify panels stay mounted side by side. */
  id?: string;
  identification?: ParsedIdentifyResolution;
  onRemove?: () => void;
  removeLabel?: string;
}) => {
  const localizer = useUiLocalizer();
  const identified = identification?.status === "matched" ? identification.matches[0] : undefined;
  // Several titles share the checksum: the drawer that lists them is the answer,
  // so it opens on arrival instead of hiding behind an untitled card.
  const ambiguous = identification?.status === "ambiguous";
  const database = databaseOnlyChecks(expectation.checks, identification);
  const own = expectation.checks?.checksums || {};
  const title =
    (identification ? uniqueIdentifyDisplayNames(identification.matches)[0] || "" : "") ||
    expectation.name ||
    (ambiguous
      ? identifyMatchCountLabel(identification?.matches.length ?? 0)
      : localizer.message("ui.sourceInfo.expectedRom"));
  // The check's own values win over the database's: only one of the two was
  // authored as an expectation, and it is the one the run will verify against.
  const merged = { ...database?.checksums, ...own };
  const mergedSize = expectation.checks?.size ?? database?.size;
  // An identified title is a display name over the placeholder file name, so
  // the card reads like the ROM card it becomes once the file lands.
  const extractName = identification
    ? { displayName: title, fileName: localizer.message("ui.sourceInfo.expectedRom") }
    : { fileName: title };
  return (
    <div className="cards bundle-rom-expectation" id={id}>
      <FileCard
        meta={<span>{localizer.message(ROM_EXPECTATION_META[expectation.source])}</span>}
        name={<ExtractName {...extractName} />}
        {...(onRemove ? { onRemove } : {})}
        {...(removeLabel ? { removeLabel } : {})}
      >
        {identification ? <IdentifyDrawer defaultOpen={ambiguous} identification={identification} /> : null}
        <ChecksumList
          defaultOpen
          label={localizer.message("ui.checks.title")}
          sublabel={localizer.message("ui.sourceInfo.expected")}
        >
          {identified ? (
            <div className="ck-group">
              {/* The head note says who asserted the checks and which database
                  filled in the rest, so nobody reads a hint as a check. */}
              <div className="ck-group-head">
                {localizer.message("ui.sourceInfo.expected")}
                <span className="ck-head-note">
                  {localizer.message(ROM_EXPECTATION_AUTHORITY[expectation.source])}
                  {` · ${identified.database || localizer.message("ui.sourceInfo.identifyData")}`}
                </span>
              </div>
              <ExpectedCheckRows checksums={merged} size={mergedSize} />
            </div>
          ) : (
            <ExpectedCheckRows checksums={own} size={expectation.checks?.size} />
          )}
        </ChecksumList>
      </FileCard>
    </div>
  );
};

/* One title from a name search, on one platform. The index holds base titles,
   so the platform is what separates two rows with the same name. */
const RomTitleRow = ({ onChoose, title }: { onChoose: () => void; title: ExpectedRomTitle }) => (
  <li className="identify-search-result">
    <button className="identify-search-result-btn" onClick={onChoose} type="button">
      <span className="identify-search-result-name">{title.name}</span>
      <span className="identify-search-result-meta">{title.platform}</span>
    </button>
  </li>
);

const releaseComponentName = (component: ParsedIdentifyExpectedComponent) => {
  if (component.filename) return component.filename;
  if (component.track !== undefined) return `Track ${component.track}`;
  if (component.role) return component.role.replaceAll("_", " ");
  return `Component ${component.ordinal + 1}`;
};

/* Expected checksums stay inside the release's one button. ChecksumRow is a
   button of its own, so using it here would create nested controls. */
const ReleaseChecksums = ({ components }: { components: ParsedIdentifyExpectedComponent[] | undefined }) => {
  const available = (components || [])
    .map((component) => ({
      component,
      checksums: EXPECTED_ROM_CHECK_ORDER.flatMap((algorithm) => {
        const value = component[algorithm];
        return value ? [[expectedCheckLabel(algorithm), value] as const] : [];
      }),
    }))
    .filter(({ checksums }) => checksums.length);
  if (!available.length) return null;
  const hasMultipleComponents = (components?.length || 0) > 1;
  return (
    <span className="identify-search-result-checks">
      {available.map(({ component, checksums }) => (
        <span
          className="identify-search-result-component"
          key={`${component.ordinal}/${component.filename || component.role}`}
        >
          {hasMultipleComponents ? (
            <span className="identify-search-result-component-name">{releaseComponentName(component)}</span>
          ) : null}
          <span className="identify-search-result-checksum-values">
            {checksums.map(([algorithm, value]) => (
              <span className="identify-search-result-checksum" key={algorithm}>
                <span className="identify-search-result-checksum-label">{algorithm}</span>
                <span className="mono">{value}</span>
              </span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
};

/* One release of a chosen title. The name leads; platform, region, revision,
   and dump tags separate releases. The tags are decoded ("Verified dump", not
   "!") so the kind of dump reads as plainly as its checksums, which let the
   user choose the exact dump before this one button selects it. */
const RomVersionRow = ({ match, onChoose }: { match: ParsedIdentifyTitleMatch; onChoose: () => void }) => {
  const dumpKinds = (match.dumpTags || []).filter((tag) => tag.trim()).map(identifyDumpTagLabel);
  const details = [match.platform, match.region, match.revision, ...dumpKinds].filter(Boolean);
  return (
    <li className="identify-search-result">
      <button
        className="identify-search-result-btn identify-search-result-btn--version"
        onClick={onChoose}
        type="button"
      >
        <span className="identify-search-result-name">{match.name}</span>
        {details.length ? <span className="identify-search-result-meta">{details.join(" · ")}</span> : null}
        <ReleaseChecksums components={match.expectedComponents} />
      </button>
    </li>
  );
};

const versionKey = (match: ParsedIdentifyTitleMatch) =>
  `${match.database}/${match.name}/${match.variant}/${match.region || ""}/${match.revision || ""}`;

/**
 * Find the ROM this run needs without having the file: paste a checksum or
 * type a game name into the one box. Shared by the apply and identify pages -
 * one lookup, one wording - so the only difference is where its answer lands.
 * The `hero` variant belongs to empty input steps. The `section` variant is
 * the island beside the empty ROM prompt. The `compact` variant refines an
 * existing expectation. A name search lists titles, then the releases of the
 * chosen title, under the row; a checksum answers directly.
 */
const RomSearch = ({
  idPrefix = "rom-weaver-rom",
  lookup,
  localizer,
  variant = "hero",
}: {
  /** Owner-scoped id prefix: the apply and identify panels stay mounted side by side. */
  idPrefix?: string;
  lookup: ReturnType<typeof useRomLookup>;
  localizer: ReturnType<typeof useUiLocalizer>;
  variant?: "compact" | "hero" | "section";
}) => {
  const [titlePage, setTitlePage] = useState({ titles: lookup.titles, count: 50 });
  const visibleTitleCount = titlePage.titles === lookup.titles ? titlePage.count : 50;
  const inputId = `${idPrefix}-search`;
  const compact = variant === "compact";
  const submitLabel = lookup.busy
    ? lookup.stage || localizer.message("ui.identify.searching")
    : localizer.message(compact ? "ui.identify.searchAgain" : "ui.identify.search");
  const chosen = lookup.title;
  return (
    <form
      aria-busy={lookup.busy || undefined}
      className={`identify-search identify-search--${variant}`}
      id={`${inputId}-form`}
      onSubmit={(event) => {
        event.preventDefault();
        void lookup.search();
      }}
    >
      <label className="identify-search-label" htmlFor={inputId}>
        {localizer.message(compact ? "ui.identify.searchRefine" : "ui.identify.searchDisclosure")}
      </label>
      <div className="identify-search-row">
        <input
          aria-invalid={lookup.error ? "true" : undefined}
          autoComplete="off"
          className="input identify-search-input"
          id={inputId}
          onChange={(event) => lookup.setText(event.currentTarget.value, (event.nativeEvent as InputEvent).isComposing)}
          onCompositionEnd={(event) => lookup.setText(event.currentTarget.value, false)}
          onCompositionStart={(event) => lookup.setText(event.currentTarget.value, true)}
          placeholder={localizer.message("ui.identify.searchPlaceholder")}
          spellCheck={false}
          type="text"
          value={lookup.text}
        />
        {/* A plain primary button, not the run button: this is one control in
            a row, not the step's action, so it MUST NOT take the row's width. */}
        <button
          aria-label={submitLabel}
          className={compact ? "btn identify-search-submit" : "btn primary identify-search-submit"}
          disabled={lookup.busy || !lookup.text.trim()}
          type="submit"
        >
          <Search aria-hidden="true" />
          {/* A phone keeps only the glyph (phone-dock.css); the name stays on the button. */}
          <span className="identify-search-submit-text">{submitLabel}</span>
        </button>
      </div>
      {lookup.busy ? (
        <p aria-live="polite" className="sr-only" role="status">
          {submitLabel}
        </p>
      ) : null}
      {lookup.error ? (
        <p className="identify-search-error" role="alert">
          {lookup.error}
        </p>
      ) : null}
      {chosen ? (
        <div className="identify-search-results-head">
          <p className="identify-search-results-label">
            {localizer.message("ui.identify.versionResults", { platform: chosen.platform, title: chosen.name })}
          </p>
          <button className="btn identify-search-back" onClick={lookup.leaveTitle} type="button">
            {localizer.message("ui.identify.versionsBack")}
          </button>
        </div>
      ) : lookup.titles.length ? (
        <div className="identify-search-results-head">
          <p className="identify-search-results-label">{localizer.message("ui.identify.titleResults")}</p>
        </div>
      ) : null}
      {lookup.versions.length ? (
        <ul aria-label={localizer.message("ui.identify.versionResultsList")} className="identify-search-results">
          {lookup.versions.map((match) => (
            <RomVersionRow key={versionKey(match)} match={match} onChoose={() => lookup.choose(match)} />
          ))}
        </ul>
      ) : null}
      {!chosen && lookup.titles.length ? (
        <ul aria-label={localizer.message("ui.identify.titleResults")} className="identify-search-results">
          {lookup.titles.slice(0, visibleTitleCount).map((title) => (
            <RomTitleRow key={`${title.slug}/${title.name}`} onChoose={() => lookup.chooseTitle(title)} title={title} />
          ))}
        </ul>
      ) : null}
      {!chosen && lookup.titles.length > visibleTitleCount ? (
        <button
          className="btn"
          onClick={() => setTitlePage({ titles: lookup.titles, count: visibleTitleCount + 50 })}
          type="button"
        >
          {localizer.message("ui.tools.more")} ({visibleTitleCount} / {lookup.titles.length})
        </button>
      ) : null}
    </form>
  );
};

/* Every message the lookup reports - one catalog entry per wording, so the
   apply and identify pages cannot drift apart. */
const ROM_LOOKUP_MESSAGES = (localizer: ReturnType<typeof useUiLocalizer>): RomLookupMessages => ({
  failed: localizer.message("ui.identify.searchFailed"),
  hashInvalid: localizer.message("ui.identify.hashInvalid"),
  hashNoMatch: localizer.message("ui.identify.hashNoMatch"),
  hashUnavailable: localizer.message("ui.identify.hashUnavailable"),
  nameNoMatch: localizer.message("ui.identify.nameNoMatch"),
  nameUnavailable: localizer.message("ui.identify.nameUnavailable"),
  tooShort: localizer.message("ui.identify.nameTooShort"),
  versionsNoMatch: localizer.message("ui.identify.versionsNoMatch"),
});

export {
  compareRomExpectation,
  databaseOnlyChecks,
  ROM_LOOKUP_MESSAGES,
  RomExpectationCard,
  romLookupSource,
  RomSearch,
  type RomExpectation,
};
