import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import type { SaveGameDefinition } from "../../wasm/generated/rom-weaver-rust-types.d.ts";

type GameChoice = { fileOneId: string | null; id: string; name: string };

const FILE_ONE_SUFFIX = / \(File 1 schema\)$/;

/**
 * One choice per game. The catalog lists a game's File 1 profile as a separate
 * entry named "<game> (File 1 schema)"; fold it into the game it belongs to so
 * the file scope is a choice after the game, not a second game.
 */
const groupGames = (games: SaveGameDefinition[]): GameChoice[] => {
  const fileOne = new Map<string, string>();
  const choices: GameChoice[] = [];
  for (const entry of games) {
    if (FILE_ONE_SUFFIX.test(entry.identity.name))
      fileOne.set(entry.identity.name.replace(FILE_ONE_SUFFIX, ""), entry.identity.id);
    else choices.push({ fileOneId: null, id: entry.identity.id, name: entry.identity.name });
  }
  const grouped = choices.map((choice) => {
    const id = fileOne.get(choice.name) ?? null;
    fileOne.delete(choice.name);
    return { ...choice, fileOneId: id };
  });
  // A File 1 profile with no all-files twin stays reachable under the game's own name.
  for (const [name, id] of fileOne) grouped.push({ fileOneId: null, id, name });
  return grouped;
};

/** The game list comes from the wasm worker, so it loads on request rather than when the page opens. */
export const SaveGenerator = ({
  disabled,
  onError,
  onGenerate,
}: {
  disabled: boolean;
  onError: (message: string) => void;
  onGenerate: (game: string) => Promise<void>;
}) => {
  const localizer = useUiLocalizer();
  const [games, setGames] = useState<GameChoice[] | null>(null);
  const [game, setGame] = useState("");
  const [fileOnly, setFileOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const loadGames = async () => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(true);
    onError("");
    try {
      const { listSaveGames } = await import("../../platform/browser/browser-save-api.ts");
      const result = await listSaveGames(controller.signal);
      if (controller.signal.aborted) return;
      const supported = (result.games ?? []).filter((entry) => result.generationGames?.includes(entry.identity.id));
      const choices = groupGames(supported);
      setGames(choices);
      setGame(choices[0]?.id ?? "");
      setFileOnly(false);
    } catch (cause) {
      if (!controller.signal.aborted) onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const selected = games?.find((entry) => entry.id === game);
  const gameId = fileOnly && selected?.fileOneId ? selected.fileOneId : game;

  return (
    <div className="drop-tray-row save-generator">
      <label className="drop-tray-label" htmlFor={games?.length ? "save-generator-game" : undefined}>
        <Sparkles aria-hidden="true" /> {localizer.message("ui.saves.generator.newSave")}
      </label>
      <div className="drop-tray-control">
        {games?.length ? (
          <>
            <select
              aria-label={localizer.message("ui.saves.generator.gameLabel")}
              className="select"
              disabled={disabled}
              id="save-generator-game"
              onChange={(event) => {
                setGame(event.currentTarget.value);
                setFileOnly(false);
              }}
              value={game}
            >
              {games.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            {selected?.fileOneId ? (
              <select
                aria-label="Files to edit"
                className="select"
                disabled={disabled}
                onChange={(event) => setFileOnly(event.currentTarget.value === "file-1")}
                value={fileOnly ? "file-1" : "all"}
              >
                <option value="all">All files</option>
                <option value="file-1">File 1 only</option>
              </select>
            ) : null}
            <button className="btn" disabled={disabled || !game} onClick={() => void onGenerate(gameId)} type="button">
              {localizer.message("ui.saves.generator.create")}
            </button>
          </>
        ) : games ? (
          <p className="drop-tray-note">{localizer.message("ui.saves.generator.none")}</p>
        ) : (
          <button className="btn ghost" disabled={disabled || loading} onClick={() => void loadGames()} type="button">
            {loading ? localizer.message("ui.saves.generator.loading") : localizer.message("ui.saves.generator.choose")}
          </button>
        )}
      </div>
    </div>
  );
};
