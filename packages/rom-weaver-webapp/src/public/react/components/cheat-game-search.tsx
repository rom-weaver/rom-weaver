import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { isSelectableCheat, type CheatRomIdentity, type CheatSystemShard } from "../../../lib/cheats/index.ts";
import { useRomLookup } from "../use-rom-lookup.ts";
import { useUiLocalizer } from "../settings-context.tsx";
import { ROM_LOOKUP_MESSAGES, RomSearch } from "./ds/rom-expectation-card.tsx";
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

/** Browse cheat records that the identification data might not contain. */
const CheatGamePicker = ({ platform, games, value, onChange, unverified }: CheatGamePickerProps) => {
  return (
    <div className="cheat-game-picker">
      <DropdownSelect
        aria-label={`Browse games for ${platform}`}
        className="select"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">Use automatic match</option>
        {games.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {gameLabel(candidate)}
          </option>
        ))}
      </DropdownSelect>
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

const gameWarning = (database: CheatDatabaseRecordsState, inspection = false): string => {
  const { entry, game, match, records, referenceRom } = database;
  if (referenceRom && entry && !game && database.shard) {
    return `The cheat database has no game record for ${referenceRom.title}. Search for another release or browse this system's cheat records below.`;
  }
  if (match.kind === "none" && entry) {
    return `No game in the ${entry.platform} cheat database matches this ROM. Identify the game above. A game you choose by hand may not match this ROM's revision.`;
  }
  if (game && !inspection && hasNoRomCheats(database)) {
    const found = records.length ? "no cheats that can be baked into the ROM" : "no cheats";
    return `The cheat database has ${found} for ${game.title}. If this ROM was matched wrongly, identify a different game above.`;
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
          Selected game: {referenceRom.title}.{" "}
          <button
            className="btn ghost slim"
            onClick={() => {
              lookup.clear();
              setReferenceRom(null);
            }}
            type="button"
          >
            Use automatic match
          </button>
        </p>
      ) : null}
      <RomSearch idPrefix={`rom-weaver-cheat-identify-${id}`} localizer={localizer} lookup={lookup} variant="section" />
    </>
  );
};

/** Reference selections MUST remain separate from the staged ROM's identity. */
export const CheatGameSearch = (input: CheatGameSearchInput) => {
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
            ? `No cheat database covers ${(database.referenceRom ?? rom).platform}. If this ROM was identified wrongly, identify its game or choose a system below.`
            : "The system of this ROM was not identified. Identify its game or choose a system below."}
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
  if (!(step === "game" && entry && shard))
    return (
      <>
        {identify}
        {changeSystem}
      </>
    );
  const warning = gameWarning(database, input.inspection);
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
