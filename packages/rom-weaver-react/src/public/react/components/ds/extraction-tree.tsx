import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";

/**
 * Nested-extraction view (prototype `.chain` + collapsible "Extract"). When a
 * ROM/patch came from one or more archives, the final extracted file is shown
 * on its own line and the full archive chain (with sizes, ratio, and timings)
 * lives in a collapsible section. A single, non-nested file renders just its
 * name. Shared by every workflow's file card.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

type ExtractionLevel = {
  name: string;
  sizeLabel?: string;
  sizeBytes?: number;
  rawBytes?: string;
  timing?: string;
};

const Size = ({ label, rawBytes }: { label?: string; rawBytes?: string }) =>
  label ? (
    <span className="szv" title={rawBytes}>
      {label}
    </span>
  ) : null;

const Level = ({ level, depth, last }: { level: ExtractionLevel; depth: number; last: boolean }) => (
  <div className={join("lvl", `d${depth}`, last && "last")}>
    {depth > 0 ? <span className="tw">&#9492;</span> : null}
    <span className="fn">{level.name}</span>
    <span className="ldr" />
    <span className="m">
      <span className="msz">
        <Size label={level.sizeLabel} rawBytes={level.rawBytes} />
      </span>
      <span className="mt">{level.timing}</span>
    </span>
  </div>
);

const formatRatio = (first: ExtractionLevel, last: ExtractionLevel) => {
  if (!(first.sizeBytes && last.sizeBytes)) return "";
  const ratio = Math.round((first.sizeBytes / last.sizeBytes) * 100);
  return Number.isFinite(ratio) ? ` (${ratio}%)` : "";
};

const ExtractionTree = ({ levels, timing }: { levels: ExtractionLevel[]; timing?: string }) => {
  if (levels.length === 0) return null;
  const last = levels[levels.length - 1];
  if (!last) return null;

  // Non-nested: just the file name.
  if (levels.length === 1) {
    return (
      <div className="chain">
        <div className="lvl d0 last">
          <span className="fn">{last.name}</span>
        </div>
      </div>
    );
  }

  const first = levels[0];
  const sizeText =
    first?.sizeLabel && last.sizeLabel ? `${first.sizeLabel} → ${last.sizeLabel}${formatRatio(first, last)}` : "";

  return (
    <>
      <div className="chain">
        <div className="lvl d0 last">
          <span className="fn">{last.name}</span>
        </div>
      </div>
      <details className="cks extract-d">
        <summary className="cks-summary">
          <ChevronRight aria-hidden="true" className="chev" />
          <span className="lab">Extract</span>
          {sizeText ? <span className="ext-size">{sizeText}</span> : null}
          <span className="tm">{timing ? <span className="t">{timing}</span> : null}</span>
        </summary>
        <div className="cks-rows">
          <div className="chain">
            {levels.map((level, index) => (
              <Level depth={index} key={`${index}:${level.name}`} last={index === levels.length - 1} level={level} />
            ))}
          </div>
        </div>
      </details>
    </>
  );
};

export { type ExtractionLevel, ExtractionTree };
