import { ScanSearch } from "lucide-react";
import { uniqueIdentifyTitles } from "../../presentation/identify-title.ts";
import { ChecksumRow } from "../../public/react/components/ds/checksum-list.tsx";
import type { ParsedIdentifyLookupResult } from "../../types/identify.ts";
import { Drawer, DrawerReadout } from "../../public/react/components/ds/drawer.tsx";

const IdentifyDrawer = ({ identification }: { identification: ParsedIdentifyLookupResult }) => {
  if (!identification.matches.length) return null;
  const canonicalNames = uniqueIdentifyTitles(identification.matches.map((match) => match.name));
  const aliases = [...new Set(identification.matches.map((match) => match.name.trim()).filter(Boolean))].filter(
    (name) => !canonicalNames.includes(name),
  );
  const aliasRows = [
    ...canonicalNames.map((name) => ({ label: "Standard", name })),
    ...aliases.map((name) => ({ label: "Alias", name })),
  ];
  const platforms = [...new Set(identification.matches.map((match) => match.platform.trim()).filter(Boolean))];
  const algorithms = [
    ...new Set(identification.matches.map((match) => match.algorithm.trim().toUpperCase()).filter(Boolean)),
  ];
  const matched = identification.status === "matched" && canonicalNames.length === 1;

  return (
    <Drawer
      className="identify-drawer"
      label="Identify"
      labelIcon={<ScanSearch aria-hidden="true" />}
      readouts={
        matched ? <DrawerReadout>Identified</DrawerReadout> : <DrawerReadout muted>Possible matches</DrawerReadout>
      }
    >
      <div className="identify-drawer-body">
        <div className="identify-drawer-label">Standard name</div>
        {canonicalNames.map((name) => (
          <div className="identify-drawer-title" key={name}>
            {name}
          </div>
        ))}
        {aliasRows.length ? (
          <div className="ck-group identify-drawer-group">
            <div className="ck-group-head">Aliases</div>
            <div className="ckrows identify-drawer-aliases">
              {aliasRows.map(({ label, name }) => (
                <ChecksumRow
                  ariaLabel={`Copy ${label.toLowerCase()} name ${name}`}
                  className="identify-alias-row ck-half"
                  copyValue={name}
                  key={`${label}:${name}`}
                  label={label}
                  value={name}
                />
              ))}
            </div>
          </div>
        ) : null}
        {platforms.length || algorithms.length ? (
          <div className="ck-group identify-drawer-group">
            <div className="ck-group-head">Matched by</div>
            <div className="ckrows identify-drawer-evidence">
              {platforms.length ? (
                <ChecksumRow
                  className="ck-half"
                  copyValue={platforms.join(" · ")}
                  label="Platform"
                  value={platforms.join(" · ")}
                />
              ) : null}
              {algorithms.length ? (
                <ChecksumRow
                  className="ck-half"
                  copyValue={algorithms.join(" · ")}
                  label="Method"
                  value={algorithms.join(" · ")}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
};

export { IdentifyDrawer };
