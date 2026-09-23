import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SaveGameDefinition } from "../../wasm/generated/rom-weaver-rust-types.d.ts";

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
  const [games, setGames] = useState<SaveGameDefinition[] | null>(null);
  const [game, setGame] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const loadGames = async () => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(true);
    try {
      const { listSaveGames } = await import("../../platform/browser/browser-save-api.ts");
      const result = await listSaveGames(controller.signal);
      if (controller.signal.aborted) return;
      const supported = (result.games ?? []).filter((entry) => result.generationGames?.includes(entry.identity.id));
      setGames(supported);
      setGame(supported[0]?.identity.id ?? "");
    } catch (cause) {
      if (!controller.signal.aborted) onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  return (
    <div className="drop-tray-row save-generator">
      <label className="drop-tray-label" htmlFor={games?.length ? "save-generator-game" : undefined}>
        <Sparkles aria-hidden="true" /> New save
      </label>
      <div className="drop-tray-control">
        {games?.length ? (
          <>
            <select
              aria-label="Game for the new save"
              className="select"
              disabled={disabled}
              id="save-generator-game"
              onChange={(event) => setGame(event.currentTarget.value)}
              value={game}
            >
              {games.map((entry) => (
                <option key={entry.identity.id} value={entry.identity.id}>
                  {entry.identity.name}
                </option>
              ))}
            </select>
            <button className="btn" disabled={disabled || !game} onClick={() => void onGenerate(game)} type="button">
              Create save
            </button>
          </>
        ) : games ? (
          <p className="drop-tray-note">No games can generate a fresh save yet.</p>
        ) : (
          <button className="btn ghost" disabled={disabled || loading} onClick={() => void loadGames()} type="button">
            {loading ? "Loading games…" : "Choose a game"}
          </button>
        )}
      </div>
    </div>
  );
};
