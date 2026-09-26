import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { isSelectableCheat, type CheatRomIdentity, type CheatSystemShard } from "../../../lib/cheats/index.ts";
import type { CheatDatabaseRecordsState } from "./use-cheat-database-records.ts";
import { DropdownSelect } from "./ds/dropdown-select.tsx";
import { Notice } from "./ds/feedback.tsx";
import "./cheat-database-section.css";

type CheatGame = CheatSystemShard["games"][number];

const gameLabel = (game: CheatGame): string =>
  [game.title, game.regions.join(" / "), game.revisions.join(" / ")].filter(Boolean).join(" · ");

export const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type CheatGamePickerProps = {
  platform: string;
  games: CheatGame[];
  value: string;
  onChange: (gameId: string) => void;
  /** The chosen game matched by title or by hand, not by checksum. */
  unverified?: boolean;
};

/** Searchable game list for a ROM the cheat database did not match by checksum. */
const CheatGamePicker = ({ platform, games, value, onChange, unverified }: CheatGamePickerProps) => {
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    if (!needle) return games;
    return games.filter((candidate) => gameLabel(candidate).toLocaleLowerCase("en-US").includes(needle));
  }, [games, query]);
  return (
    <div className="cheat-game-picker">
      <label>
        <span>Search games in {platform}</span>
        <input
          className="input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by game title…"
          type="search"
          value={query}
        />
      </label>
      <DropdownSelect
        aria-label={`Browse games for ${platform}`}
        className="select"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">Use automatic match</option>
        {options.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {gameLabel(candidate)}
          </option>
        ))}
      </DropdownSelect>
      {options.length ? null : (
        <p className="cheat-pick-empty" role="status">
          No games match this search.
        </p>
      )}
      {unverified ? (
        <p className="cheat-pick-empty">
          This ROM revision is unverified. These cheats may target different addresses.
        </p>
      ) : null}
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
  if (!(database.entry || database.manualOnlySystem)) return "system";
  if (!(database.entry && database.shard)) return undefined;
  if (alwaysBrowseGames || database.match.kind !== "exact" || hasNoRomCheats(database)) return "game";
  return undefined;
};

const SystemSearch = ({ database }: { database: CheatDatabaseRecordsState }) => {
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
        <span className="sr-only">Search cheat databases</span>
        <input
          className="input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search cheat databases by system…"
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
                {countLabel(candidate.games, "game")} · {countLabel(candidate.cheats, "cheat")}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="cheat-pick-empty" role="status">
          No cheat database matches this search.
        </p>
      )}
    </div>
  );
};

const gameWarning = (database: CheatDatabaseRecordsState): string => {
  const { entry, game, match, records } = database;
  if (match.kind === "none" && entry) {
    return `No game in the ${entry.platform} cheat database matches this ROM. Search for the game below. A game you choose by hand may not match this ROM's revision.`;
  }
  if (game && hasNoRomCheats(database)) {
    const found = records.length ? "no cheats that can be baked into the ROM" : "no cheats";
    return `The cheat database has ${found} for ${game.title}. If this ROM was matched wrongly, search for a different game below.`;
  }
  return "";
};

/**
 * The dialog's identify controls: a warning that says why no cheats show, then
 * a system search or a game search that lets the user identify the game by hand.
 */
export const CheatGameSearch = (input: CheatGameSearchInput) => {
  const { rom, database } = input;
  const step = getCheatGameSearchStep(input);
  if (!rom) return null;
  if (step === "system") {
    return (
      <>
        <Notice id="rom-weaver-cheat-system-warning" level="warn">
          {rom.platform
            ? `No cheat database covers ${rom.platform}. If this ROM was identified wrongly, choose its system to search for the game.`
            : "The system of this ROM was not identified. Choose its system to search for the game."}
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
        You chose {entry.platform} by hand.{" "}
        <button className="btn ghost slim" onClick={() => setManualEntrySlug("")} type="button">
          Change system
        </button>
      </p>
    ) : null;
  if (!(step === "game" && entry && shard)) return changeSystem;
  const warning = gameWarning(database);
  return (
    <>
      {warning ? (
        <Notice id="rom-weaver-cheat-game-warning" level="warn">
          {warning}
        </Notice>
      ) : null}
      {changeSystem}
      <CheatGamePicker
        games={shard.games}
        onChange={setManualGameId}
        platform={entry.platform}
        unverified={match.kind === "title" || match.kind === "manual"}
        value={manualGameId}
      />
    </>
  );
};
