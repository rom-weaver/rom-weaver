import { useState } from "react";
import type { IdentifyCatalog } from "../../lib/identify/identify-catalog.ts";
import type {
  CheatDatabaseClient,
  CheatDatabaseIndex,
  CheatRomIdentity,
  CheatSystemShard,
} from "../../lib/cheats/index.ts";
import { AddCheatsDialog } from "../../public/react/components/cheat-database-section.tsx";
import { CheatGameSearch } from "../../public/react/components/cheat-game-search.tsx";
import { Notice } from "../../public/react/components/ds/feedback.tsx";
import { useCheatDatabaseRecords } from "../../public/react/components/use-cheat-database-records.ts";

type IdentifyCheatInspectionProps = {
  identity: CheatRomIdentity;
  label?: string;
  index?: CheatDatabaseIndex;
  catalog?: IdentifyCatalog;
  shard?: CheatSystemShard;
  client?: CheatDatabaseClient;
};

const IdentifyCheatInspectionDialog = ({
  identity,
  index,
  catalog,
  shard,
  client,
  onClose,
}: IdentifyCheatInspectionProps & { onClose: () => void }) => {
  const database = useCheatDatabaseRecords({
    rom: identity,
    inspectOnly: true,
    ...(index ? { index } : {}),
    ...(catalog ? { catalog } : {}),
    ...(shard ? { shard } : {}),
    ...(client ? { client } : {}),
  });
  const { game, loadError, loading } = database;
  const records = game?.cheats ?? [];
  const status = loadError
    ? { error: true, text: `The cheat database is unavailable. ${loadError}` }
    : loading
      ? { text: "Loading this system's cheat database…" }
      : undefined;

  return (
    <AddCheatsDialog
      addedIds={new Set()}
      emptyPrompt="No cheat records are available for this game."
      extras={
        <Notice id={`identify-cheat-warning-${identity.key}`} level="warn">
          These records are database evidence only. Compatibility with these exact ROM bytes is not verified here.
        </Notice>
      }
      gamePicker={<CheatGameSearch alwaysBrowseGames database={database} inspection rom={identity} />}
      inspection
      onClose={onClose}
      open
      records={records}
      stackCount={0}
      status={status}
      title={`Cheat database${game?.title ? ` · ${game.title}` : ""}`}
    />
  );
};

/** Read-only cheat database evidence for an identified or checksum-only ROM. */
const IdentifyCheatInspection = (props: IdentifyCheatInspectionProps) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label={props.label ? `View cheats for ${props.label}` : "View cheats"}
        className="btn ghost slim identify-cheat-inspect"
        onClick={() => setOpen(true)}
        type="button"
      >
        View cheats
      </button>
      {open ? <IdentifyCheatInspectionDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
};

export { IdentifyCheatInspection };
