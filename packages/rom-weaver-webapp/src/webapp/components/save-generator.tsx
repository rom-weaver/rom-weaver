import { useEffect, useRef, useState } from "react";
import type { SaveGameDefinition } from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { Notice } from "../../public/react/components/ds/feedback.tsx";

export const SaveGenerator = ({
  disabled,
  onGenerate,
}: {
  disabled: boolean;
  onGenerate: (game: string) => Promise<void>;
}) => {
  const [games, setGames] = useState<SaveGameDefinition[] | null>(null);
  const [game, setGame] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const loadGames = async () => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const { listSaveGames } = await import("../../platform/browser/browser-save-api.ts");
      const result = await listSaveGames(controller.signal);
      if (controller.signal.aborted) return;
      const supported = (result.games ?? []).filter((entry) => result.generationGames?.includes(entry.identity.id));
      setGames(supported);
      setGame(supported[0]?.identity.id ?? "");
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  return (
    <section aria-labelledby="save-generator-title" className="save-editor-source-card save-generator">
      <div className="save-editor-source-head">
        <span className="save-editor-source-kicker mono">Start fresh</span>
        <div>
          <h3 id="save-generator-title">New game save</h3>
          <p>Build a clean save, set its properties, then download it.</p>
        </div>
      </div>
      {games ? (
        <div className="save-generator-form">
          <label className="save-generator-field">
            <span>Game for the new save</span>
            <select
              className="select"
              disabled={disabled || loading}
              onChange={(event) => setGame(event.currentTarget.value)}
              value={game}
            >
              {games.map((entry) => (
                <option key={entry.identity.id} value={entry.identity.id}>
                  {entry.identity.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn slim save-generator-action"
            disabled={disabled || !game}
            onClick={() => void onGenerate(game)}
            type="button"
          >
            Generate save
          </button>
          {games.length ? null : <p className="save-editor-empty">No fresh save generators are available.</p>}
        </div>
      ) : (
        <button
          className="btn slim ghost save-generator-action"
          disabled={disabled || loading}
          onClick={() => void loadGames()}
          type="button"
        >
          {loading ? "Loading games…" : "Create a fresh save"}
        </button>
      )}
      {error ? <Notice level="error">{error}</Notice> : null}
    </section>
  );
};
