import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { isSelectableCheat, type CheatRomIdentity, type CheatSystemShard } from "../../../lib/cheats/index.ts";
import { useRomLookup } from "../use-rom-lookup.ts";
import type { Localizer } from "../../../presentation/localization/index.ts";
import { useUiLocalizer } from "../settings-context.tsx";
import { ROM_LOOKUP_MESSAGES, RomSearch } from "./ds/rom-expectation-card.tsx";
import type { CheatDatabaseRecordsState } from "./use-cheat-database-records.ts";
import { DropdownSelect } from "./ds/dropdown-select.tsx";
import { Notice } from "./ds/feedback.tsx";
import "./cheat-database-section.css";

type CheatGame = CheatSystemShard["games"][number];

const gameLabel = (game: CheatGame): string =>
  [game.title, game.regions.join(" / "), game.revisions.join(" / ")].filter(Boolean).join(" · ");

type CheatGamePickerProps = {
  platform: string;
  games: CheatGame[];
  value: string;
  onChange: (gameId: string) => void;
  /** The chosen game matched by title or by hand, not by checksum. */
  unverified?: boolean;
};

/** Browse cheat records that the identification data might not contain. */
const CheatGamePicker = ({ platform, games, value, onChange, unverified }: CheatGamePickerProps) => {
  const localizer = useUiLocalizer();
  return (
    <div className="cheat-game-picker">
      <DropdownSelect
        aria-label={localizer.message("ui.cheats.browseGames", { platform })}
        className="select"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">{localizer.message("ui.cheats.useAutomatic")}</option>
        {games.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {gameLabel(candidate)}
          </option>
        ))}
      </DropdownSelect>
      {unverified ? <p className="cheat-pick-empty">{localizer.message("ui.cheats.unverified")}</p> : null}
    </div>
  );
};

/**
 * What the add-cheats dialog must ask before it can list cheats: the system,
 * when no database shard covers the ROM, or the game, when the shard has no
 * checksum match or the matched game has no ROM cheats.
 */
export type CheatGameSearchStep = "system" | "game";

type CheatGameSearchInput = {
  rom: CheatRomIdentity | null;
  database: CheatDatabaseRecordsState;
  /** Offer the game list even after an exact checksum match that has ROM cheats. */
  alwaysBrowseGames?: boolean;
  inspection?: boolean;
};

const hasNoRomCheats = (database: CheatDatabaseRecordsState): boolean =>
  !!database.game &&
  !(database.loading || database.classifying || database.classificationError) &&
  !database.records.some(isSelectableCheat);

export const getCheatGameSearchStep = ({
  rom,
  database,
  alwaysBrowseGames,
}: CheatGameSearchInput): CheatGameSearchStep | undefined => {
  if (!(rom && database.activeIndex)) return undefined;
  if (database.referenceRom) return database.entry ? "game" : "system";
  if (!(database.entry || database.manualOnlySystem)) return "system";
  if (!database.entry) return undefined;
  if (alwaysBrowseGames || database.match.kind !== "exact" || hasNoRomCheats(database)) return "game";
  return undefined;
};

const SystemSearch = ({ database }: { database: CheatDatabaseRecordsState }) => {
  const localizer = useUiLocalizer();
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    const entries = database.activeIndex?.entries ?? [];
    const matches = needle
      ? entries.filter((candidate) =>
          `${candidate.platform} ${candidate.slug}`.toLocaleLowerCase("en-US").includes(needle),
        )
      : entries;
    return matches.slice(0, 8);
  }, [database.activeIndex, query]);
  return (
    <div className="cheat-database-picker">
      <label className="cheat-search">
        <Search aria-hidden="true" />
        <span className="sr-only">{localizer.message("ui.cheats.searchDatabases")}</span>
        <input
          className="input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={localizer.message("ui.cheats.searchDatabasesPlaceholder")}
          type="search"
          value={query}
        />
      </label>
      {options.length ? (
        <div className="cheat-database-options">
          {options.map((candidate) => (
            <button
              className="cheat-database-option"
              key={candidate.slug}
              onClick={() => database.setManualEntrySlug(candidate.slug)}
              type="button"
            >
              <span>{candidate.platform}</span>
              <span className="rb mono">
                {localizer.messageCount("ui.cheats.gameCount", candidate.games)} ·{" "}
                {localizer.messageCount("ui.cheats.cheatCount", candidate.cheats)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="cheat-pick-empty" role="status">
          {localizer.message("ui.cheats.noDatabaseMatch")}
        </p>
      )}
    </div>
  );
};

const gameWarning = (database: CheatDatabaseRecordsState, localizer: Localizer, inspection = false): string => {
  const { entry, game, match, records, referenceRom } = database;
  if (referenceRom && entry && !game && database.shard) {
    return localizer.message("ui.cheats.warn.noGameRecord", { title: referenceRom.title });
  }
  if (match.kind === "none" && entry) {
    return localizer.message("ui.cheats.warn.noMatch", { platform: entry.platform });
  }
  if (game && !inspection && hasNoRomCheats(database)) {
    return localizer.message(records.length ? "ui.cheats.warn.noBakeable" : "ui.cheats.warn.noCheats", {
      title: game.title,
    });
  }
  return "";
};

const IdentifyCheatGame = ({ database }: { database: CheatDatabaseRecordsState }) => {
  const localizer = useUiLocalizer();
  const id = useId();
  const lookup = useRomLookup(ROM_LOOKUP_MESSAGES(localizer));
  const { result } = lookup;
  const { referenceRom, setReferenceRom } = database;
  useEffect(() => {
    if (!result) return;
    const match = result.identification.matches[0];
    if (!match) return;
    setReferenceRom({
      key: match.name,
      title: match.name,
      platform: match.platform,
      checksums: result.checks.checksums,
    });
  }, [result, setReferenceRom]);
  return (
    <>
      {referenceRom ? (
        <p className="cheat-pick-empty">
          {localizer.message("ui.cheats.selectedGame", { title: referenceRom.title })}{" "}
          <button
            className="btn ghost slim"
            onClick={() => {
              lookup.clear();
              setReferenceRom(null);
            }}
            type="button"
          >
            {localizer.message("ui.cheats.useAutomatic")}
          </button>
        </p>
      ) : null}
      <RomSearch idPrefix={`rom-weaver-cheat-identify-${id}`} localizer={localizer} lookup={lookup} variant="section" />
    </>
  );
};

/** Reference selections MUST remain separate from the staged ROM's identity. */
export const CheatGameSearch = (input: CheatGameSearchInput) => {
  const localizer = useUiLocalizer();
  const { rom, database } = input;
  const step = getCheatGameSearchStep(input);
  if (!rom) return null;
  const identify = step ? <IdentifyCheatGame key={rom.key} database={database} /> : null;
  if (step === "system") {
    return (
      <>
        {identify}
        <Notice id="rom-weaver-cheat-system-warning" level="warn">
          {(database.referenceRom ?? rom).platform
            ? localizer.message("ui.cheats.warn.noDatabase", { platform: (database.referenceRom ?? rom).platform })
            : localizer.message("ui.cheats.warn.unidentifiedSystem")}
        </Notice>
        <SystemSearch database={database} />
      </>
    );
  }
  const { entry, manualEntrySlug, manualGameId, match, setManualEntrySlug, setManualGameId, shard } = database;
  // A system chosen by hand keeps its way back even when its shard fails to load.
  const changeSystem =
    manualEntrySlug && entry ? (
      <p className="cheat-pick-empty">
        {localizer.message("ui.cheats.choseByHand", { platform: entry.platform })}{" "}
        <button className="btn ghost slim" onClick={() => setManualEntrySlug("")} type="button">
          {localizer.message("ui.cheats.changeSystem")}
        </button>
      </p>
    ) : null;
  if (!(step === "game" && entry && shard))
    return (
      <>
        {identify}
        {changeSystem}
      </>
    );
  const warning = gameWarning(database, localizer, input.inspection);
  return (
    <>
      {identify}
      {warning ? (
        <Notice id="rom-weaver-cheat-game-warning" level="warn">
          {warning}
        </Notice>
      ) : null}
      {changeSystem}
      <CheatGamePicker
        games={shard.games}
        onChange={(gameId) => {
          if (!gameId) database.setReferenceRom(null);
          setManualGameId(gameId);
        }}
        platform={entry.platform}
        unverified={match.kind === "title" || match.kind === "manual"}
        value={manualGameId || (database.referenceRom && database.game ? database.game.id : "")}
      />
    </>
  );
};
