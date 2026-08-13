import { ScanSearch } from "lucide-react";
import { uniqueIdentifyTitles } from "../../presentation/identify-title.ts";
import type { ParsedIdentifyLookupResult } from "../../types/identify.ts";
import { Drawer, DrawerReadout } from "../../public/react/components/ds/drawer.tsx";

const IdentifyDrawer = ({ identification }: { identification: ParsedIdentifyLookupResult }) => {
  if (!identification.matches.length) return null;
  const canonicalNames = uniqueIdentifyTitles(identification.matches.map((match) => match.name));
  const aliases = [...new Set(identification.matches.map((match) => match.name.trim()).filter(Boolean))].filter(
    (name) => !canonicalNames.includes(name),
  );
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
        {aliases.length ? (
          <>
            <div className="identify-drawer-label">Aliases</div>
            {aliases.map((alias) => (
              <div className="identify-drawer-alias mono" key={alias}>
                {alias}
              </div>
            ))}
          </>
        ) : null}
        {identification.matches.some((match) => match.platform || match.algorithm) ? (
          <div className="identify-drawer-meta">
            {identification.matches
              .map((match) => [match.platform, match.algorithm.toUpperCase()].filter(Boolean).join(" · "))
              .filter(Boolean)
              .join(" · ")}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
};

export { IdentifyDrawer };
