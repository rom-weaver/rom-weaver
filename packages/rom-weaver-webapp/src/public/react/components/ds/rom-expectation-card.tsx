import { Search } from "lucide-react";
import { Fragment } from "react";
import { identifyMatchCountLabel } from "../../../../presentation/identify-status.ts";
import { uniqueIdentifyDisplayNames } from "../../../../presentation/identify-title.ts";
import type { ParsedBundleChecks } from "../../../../types/bundle.ts";
import type { ParsedIdentifyResolution } from "../../../../types/identify.ts";
import { IdentifyDrawer } from "../../../../webapp/components/identify-drawer.tsx";
import type { useUiLocalizer } from "../../settings-context.tsx";
import type { useRomHashLookup } from "../../use-rom-hash-lookup.ts";
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

/** The database's single-component record for a match, when it has exactly one. */
const soleExpectedComponent = (identification: ParsedIdentifyResolution | undefined) => {
  if (identification?.status !== "matched") return undefined;
  const components = identification.matches[0]?.expectedComponents;
  return components?.length === 1 ? components[0] : undefined;
};

/* What the identify data adds beyond the check itself. A multi-track disc
   record has no single expected file, so it contributes nothing here. */
const databaseOnlyChecks = (
  checks: ParsedBundleChecks | undefined,
  identification: ParsedIdentifyResolution | undefined,
): { checksums: Record<string, string>; size?: number } | undefined => {
  const component = soleExpectedComponent(identification);
  if (!component) return undefined;
  const own = checks?.checksums || {};
  const checksums: Record<string, string> = {};
  for (const algorithm of EXPECTED_ROM_CHECK_ORDER) {
    const value = component[algorithm];
    if (value && !own[algorithm]) checksums[algorithm] = value;
  }
  const size = typeof checks?.size === "number" || !component.size ? undefined : component.size;
  if (!(Object.keys(checksums).length || size !== undefined)) return undefined;
  return { checksums, ...(size === undefined ? {} : { size }) };
};

/** Where an expected-ROM check came from; it decides the card's meta line. */
type RomExpectationSource = "bundle" | "manual" | "patch";

const ROM_EXPECTATION_META: Record<RomExpectationSource, string> = {
  bundle: "ROM not included - provide it yourself",
  manual: "Found by checksum - add the ROM to verify it",
  patch: "Expected by a patch - provide this ROM",
};

/* Who asserted the checks, for the merged group's head note. The database name
   follows it, so the note reads "by the bundle · No-Intro". */
const ROM_EXPECTATION_AUTHORITY: Record<RomExpectationSource, string> = {
  bundle: "by the bundle",
  manual: "your checksum",
  patch: "by the patch",
};

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
  const identified = identification?.status === "matched" ? identification.matches[0] : undefined;
  // Several titles share the checksum: the drawer that lists them is the answer,
  // so it opens on arrival instead of hiding behind an untitled card.
  const ambiguous = identification?.status === "ambiguous";
  const database = databaseOnlyChecks(expectation.checks, identification);
  const own = expectation.checks?.checksums || {};
  const title =
    (identified ? uniqueIdentifyDisplayNames([identified])[0] || "" : "") ||
    expectation.name ||
    (ambiguous ? identifyMatchCountLabel(identification?.matches.length ?? 0) : "Expected ROM");
  // The check's own values win over the database's: only one of the two was
  // authored as an expectation, and it is the one the run will verify against.
  const merged = { ...database?.checksums, ...own };
  const mergedSize = expectation.checks?.size ?? database?.size;
  return (
    <div className="cards bundle-rom-expectation" id={id}>
      <FileCard
        meta={<span>{ROM_EXPECTATION_META[expectation.source]}</span>}
        name={<ExtractName fileName={title} />}
        {...(onRemove ? { onRemove } : {})}
        {...(removeLabel ? { removeLabel } : {})}
      >
        {identification ? <IdentifyDrawer defaultOpen={ambiguous} identification={identification} /> : null}
        <ChecksumList defaultOpen label="Checks" sublabel="expected">
          {identified ? (
            <div className="ck-group">
              {/* The head note says who asserted the checks and which database
                  filled in the rest, so nobody reads a hint as a check. */}
              <div className="ck-group-head">
                Expected
                <span className="ck-head-note">
                  {ROM_EXPECTATION_AUTHORITY[expectation.source]}
                  {` · ${identified.database || "identify data"}`}
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

/**
 * Paste a checksum to find the ROM this run needs, without having the file.
 * Shared by the apply and identify pages - one lookup, one wording - so the
 * only difference is where its answer lands. The `hero` variant is the quiet
 * second door of the empty 0x01 hero; `compact` is the refine row 0x02 keeps
 * under an expectation card until a real ROM makes it concrete.
 */
const RomHashSearch = ({
  idPrefix = "rom-weaver-rom",
  lookup,
  localizer,
  variant = "hero",
}: {
  /** Owner-scoped id prefix: the apply and identify panels stay mounted side by side. */
  idPrefix?: string;
  lookup: ReturnType<typeof useRomHashLookup>;
  localizer: ReturnType<typeof useUiLocalizer>;
  variant?: "compact" | "hero";
}) => {
  const inputId = `${idPrefix}-hash`;
  const compact = variant === "compact";
  return (
    <form
      className={compact ? "identify-hash identify-hash--compact" : "identify-hash identify-hash--hero"}
      id={`${inputId}-search`}
      onSubmit={(event) => {
        event.preventDefault();
        void lookup.search();
      }}
    >
      <div className="identify-hash-ask">
        <label className="identify-hash-label" htmlFor={inputId}>
          {localizer.message(compact ? "ui.identify.hashRefine" : "ui.identify.hashLabel")}
        </label>
        {compact ? null : <p className="pdesc identify-hash-hint">{localizer.message("ui.identify.hashHint")}</p>}
      </div>
      <div className="identify-hash-row">
        <input
          aria-invalid={lookup.error ? "true" : undefined}
          autoComplete="off"
          className="input mono identify-hash-input"
          disabled={lookup.busy}
          id={inputId}
          onChange={(event) => lookup.setText(event.currentTarget.value)}
          placeholder="crc32 / md5 / sha1"
          spellCheck={false}
          type="text"
          value={lookup.text}
        />
        {/* A plain primary button, not the run button: this is one control in
            a row, not the step's action, so it MUST NOT take the row's width. */}
        <button
          className={compact ? "btn identify-hash-submit" : "btn primary identify-hash-submit"}
          disabled={lookup.busy || !lookup.text.trim()}
          type="submit"
        >
          <Search aria-hidden="true" />
          {lookup.busy
            ? lookup.stage || localizer.message("ui.identify.hashSearching")
            : localizer.message(compact ? "ui.identify.hashSearchAgain" : "ui.identify.hashSearch")}
        </button>
      </div>
      {lookup.error ? (
        <p className="identify-hash-error" role="alert">
          {lookup.error}
        </p>
      ) : null}
    </form>
  );
};

/* The two validation messages the search shares with the identify page - one
   catalog entry, one wording, wherever a checksum is pasted. */
const ROM_HASH_LOOKUP_MESSAGES = (localizer: ReturnType<typeof useUiLocalizer>) => ({
  invalid: localizer.message("ui.identify.hashInvalid"),
  invalidChars: localizer.message("ui.identify.hashInvalidChars"),
});

export {
  compareRomExpectation,
  databaseOnlyChecks,
  ROM_HASH_LOOKUP_MESSAGES,
  RomExpectationCard,
  RomHashSearch,
  type RomExpectation,
};
