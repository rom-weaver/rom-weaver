import { ScanSearch } from "lucide-react";
import { formatIdentifyTitle } from "../../presentation/identify-title.ts";
import { abbreviatePlatform } from "../../presentation/platform-abbreviations.ts";
import {
  IDENTIFY_STATUS_MARK,
  identifyMatchCountLabel,
  identifyNameHeading,
} from "../../presentation/identify-status.ts";
import { ChecksumRow } from "../../public/react/components/ds/checksum-list.tsx";
import type { ParsedIdentifyLookupResult, ParsedIdentifyTitleMatch } from "../../types/identify.ts";
import { Drawer, DrawerReadout } from "../../public/react/components/ds/drawer.tsx";

const unique = (values: Iterable<string>) => [...new Set([...values].map((value) => value.trim()).filter(Boolean))];

/** Raw dump names that differ from the derived standard names. */
const collectAliases = (matches: readonly ParsedIdentifyTitleMatch[], canonical: readonly string[]) =>
  unique(matches.map((match) => match.name)).filter((name) => !canonical.includes(name));

/* A value shorter than this pairs two rows per line (ck-half); a longer one
   keeps the full row so it never collides with its neighbour. */
const HALF_ROW_MAX_CHARS = 16;

const EvidenceRow = ({ label, values }: { label: string; values: readonly string[] }) => {
  if (!values.length) return null;
  const value = values.join(" · ");
  return (
    <ChecksumRow
      className={value.length < HALF_ROW_MAX_CHARS ? "ck-half" : undefined}
      copyValue={value}
      label={label}
      value={value}
    />
  );
};

const IdentifyDrawer = ({
  identification,
  memberPath,
}: {
  identification: ParsedIdentifyLookupResult;
  /** Archive-relative member path, when the identified ROM came out of a container. */
  memberPath?: string;
}) => {
  const { matches, status } = identification;
  if (!matches.length) return null;
  const canonicalNames = unique(matches.map((match) => formatIdentifyTitle(match.name)));
  const aliases = collectAliases(matches, canonicalNames);
  const platforms = unique(matches.map((match) => match.platform));
  const algorithms = unique(matches.map((match) => match.algorithm.toUpperCase()));
  const variants = unique(matches.map((match) => match.variant));
  const databases = unique(matches.map((match) => match.database));
  const mark = IDENTIFY_STATUS_MARK[status];

  return (
    <Drawer
      className="identify-drawer"
      label="Identify"
      labelIcon={<ScanSearch aria-hidden="true" />}
      readouts={
        status === "matched" ? (
          <DrawerReadout>{mark.label}</DrawerReadout>
        ) : (
          <DrawerReadout muted>{identifyMatchCountLabel(matches.length)}</DrawerReadout>
        )
      }
    >
      <div className="identify-drawer-body">
        <div className="identify-drawer-label">{identifyNameHeading(canonicalNames.length)}</div>
        {canonicalNames.map((name) => (
          <div className="identify-drawer-title" key={name}>
            {name}
          </div>
        ))}
        <div className="ck-group identify-drawer-group">
          <div className="ck-group-head">Names</div>
          <div className="ckrows identify-drawer-aliases">
            {canonicalNames.map((name) => (
              <ChecksumRow
                ariaLabel={`Copy standard name ${name}`}
                className="identify-alias-row ck-half"
                copyValue={name}
                key={name}
                label="Standard"
                value={name}
              />
            ))}
            {aliases.map((name) => (
              <ChecksumRow
                ariaLabel={`Copy alias name ${name}`}
                className="identify-alias-row ck-half"
                copyValue={name}
                key={name}
                label="Alias"
                value={name}
              />
            ))}
          </div>
        </div>
        <div className="ck-group identify-drawer-group">
          <div className="ck-group-head">Evidence</div>
          <div className="ckrows identify-drawer-evidence">
            <EvidenceRow label="Matched by" values={algorithms} />
            <EvidenceRow label="Variant" values={variants} />
            <EvidenceRow label="Platform" values={platforms.map(abbreviatePlatform)} />
            <EvidenceRow label="Source" values={databases} />
            {memberPath ? <EvidenceRow label="Archive member" values={[memberPath]} /> : null}
            {status === "ambiguous" ? (
              <EvidenceRow label="Candidates" values={[identifyMatchCountLabel(matches.length)]} />
            ) : null}
          </div>
        </div>
      </div>
    </Drawer>
  );
};

export { IdentifyDrawer };
