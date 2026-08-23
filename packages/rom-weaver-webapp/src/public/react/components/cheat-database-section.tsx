import { ChevronDown, Database, FileUp, Plus, Search } from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  cheatDelivery,
  createCheatDatabaseClient,
  filterCheats,
  isCheatDatabaseSystem,
  isSelectableCheat,
  loadCheatDatabaseManifest,
  matchCheatGame,
  selectManualGame,
  type CheatDatabaseClient,
  type CheatDatabaseManifest,
  type CheatDatabaseSystem,
  type CheatFilter,
  type CheatGameMatch,
  type CheatRomIdentity,
  type CheatSystemShard,
  type ClassifiedCheatRecord,
  type DatabaseCheatClassifier,
  type ManualCheatClassifier,
  type ManualCheatKindOverride,
  type ManualCheatResult,
  type LocalCheatFileImporter,
} from "../../../lib/cheats/index.ts";
import "./cheat-database-section.css";

const SYSTEM_LABELS: Record<CheatDatabaseSystem, string> = {
  nes: "NES",
  snes: "SNES",
  genesis: "Sega Genesis / Mega Drive",
  gameboy: "Game Boy",
  "gameboy-color": "Game Boy Color",
  gameboyadvance: "Game Boy Advance",
};

const MAX_LOCAL_CHT_BYTES = 16 * 1024 * 1024;

const FILTERS: Array<{ id: CheatFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "rom", label: "ROM / baked" },
  { id: "runtime", label: "RAM / runtime" },
  { id: "requires-parameter", label: "Requires value" },
];

const matchGame = (match: CheatGameMatch) => ("game" in match ? match.game : undefined);

const matchCopy = (match: CheatGameMatch): { heading: string; detail: string } => {
  if (match.kind === "exact") {
    return { heading: "Exact ROM revision matched", detail: "The original ROM checksum matched a known release." };
  }
  if (match.kind === "title") {
    return {
      heading: "Game title matched",
      detail: "This ROM revision is unverified. These cheats may target different addresses.",
    };
  }
  if (match.kind === "manual") {
    return {
      heading: "Game selected manually",
      detail: "This ROM revision is unverified. These cheats may target different addresses.",
    };
  }
  if (match.kind === "unsupported-system") {
    return { heading: "Unsupported system", detail: "ROMWeaver does not offer database cheats for this system." };
  }
  if (match.kind === "no-rom") {
    return { heading: "No ROM selected", detail: "Select a ROM to find compatible cheats." };
  }
  return { heading: "No automatic match", detail: "Select a game to browse unverified cheats for this console." };
};

const deliveryCopy = (record: ClassifiedCheatRecord): { badge: string; text: string } => {
  const delivery = cheatDelivery(record);
  if (delivery === "rom") return { badge: "ROM cheat", text: "Baked into output" };
  if (delivery === "runtime") return { badge: "RAM cheat", text: "Requires emulator cheat file" };
  if (delivery === "requires-parameter") return { badge: "Needs a value", text: "Add a value before selection" };
  return { badge: "Unsupported", text: "Cannot be selected" };
};

const gameLabel = (game: NonNullable<ReturnType<typeof matchGame>>): string =>
  [game.title, game.regions.join(" / "), game.revisions.join(" / ")].filter(Boolean).join(" · ");

type CheatRowProps = {
  record: ClassifiedCheatRecord;
  checked: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
};

const CheatRow = ({ record, checked, expanded, onToggle, onExpand }: CheatRowProps) => {
  const delivery = deliveryCopy(record);
  const selectable = isSelectableCheat(record);
  const source = record.record;
  const detailId = `cheat-detail-${source.id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  return (
    <li className="cheat-row">
      <label className="cheat-choice">
        <input checked={checked} disabled={!selectable} onChange={onToggle} type="checkbox" />
        <span className="cheat-summary">
          <span className="cheat-description">{source.description}</span>
          <span className="cheat-delivery">
            <span className={`cheat-badge is-${cheatDelivery(record)}`}>{delivery.badge}</span>
            <span aria-hidden="true">•</span>
            <span>{delivery.text}</span>
          </span>
        </span>
      </label>
      <button
        aria-controls={detailId}
        aria-expanded={expanded}
        className="cheat-detail-toggle"
        onClick={onExpand}
        type="button"
      >
        Details
        <ChevronDown aria-hidden="true" />
      </button>
      {expanded ? (
        <dl className="cheat-details" id={detailId}>
          <div>
            <dt>Description</dt>
            <dd>{source.description}</dd>
          </div>
          {source.rawCode ? (
            <div>
              <dt>Original code</dt>
              <dd className="mono">{source.rawCode}</dd>
            </div>
          ) : null}
          {record.detectedKind ? (
            <div>
              <dt>Device or type</dt>
              <dd>{record.detectedKind}</dd>
            </div>
          ) : null}
          <div>
            <dt>Source</dt>
            <dd>
              {source.sourceFile} at {source.sourceRevision}
            </dd>
          </div>
          <div>
            <dt>Delivery</dt>
            <dd>{record.resolution.type === "unsupported" ? record.resolution.reason : delivery.text}</dd>
          </div>
          {record.resolution.type === "mixed" ? (
            <div>
              <dt>Compatibility</dt>
              <dd>The complete mixed entry goes into the emulator cheat file. ROMWeaver does not split it.</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
};

type ManualCodeFormProps = {
  defaultSystem: CheatDatabaseSystem;
  classifier: ManualCheatClassifier;
  onAdd: (result: ManualCheatResult) => void;
};

const ManualCodeForm = ({ defaultSystem, classifier, onAdd }: ManualCodeFormProps) => {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("Manual cheat");
  const [system, setSystem] = useState<CheatDatabaseSystem>(defaultSystem);
  const [kind, setKind] = useState<ManualCheatKindOverride>("auto");
  const [result, setResult] = useState<ManualCheatResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const classificationSequence = useRef(0);

  const clearClassification = () => {
    classificationSequence.current += 1;
    setResult(undefined);
    setError("");
    setBusy(false);
  };

  useEffect(() => {
    classificationSequence.current += 1;
    setSystem(defaultSystem);
    setResult(undefined);
    setError("");
    setBusy(false);
  }, [defaultSystem]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    const sequence = ++classificationSequence.current;
    setBusy(true);
    setError("");
    setResult(undefined);
    void classifier({ code: code.trim(), description: description.trim() || "Manual cheat", system, kind })
      .then((nextResult) => {
        if (classificationSequence.current === sequence) setResult(nextResult);
      })
      .catch((reason: unknown) => {
        if (classificationSequence.current === sequence) {
          setError(reason instanceof Error ? reason.message : "The code could not be classified.");
        }
      })
      .finally(() => {
        if (classificationSequence.current === sequence) setBusy(false);
      });
  };

  return (
    <div className="manual-cheat">
      <button aria-expanded={open} className="manual-cheat-toggle" onClick={() => setOpen(!open)} type="button">
        <Plus aria-hidden="true" />
        Add code manually
      </button>
      {open ? (
        <form onSubmit={submit}>
          <label>
            <span>Description</span>
            <input
              maxLength={200}
              onChange={(event) => {
                setDescription(event.target.value);
                clearClassification();
              }}
              value={description}
            />
          </label>
          <label>
            <span>Cheat code</span>
            <textarea
              autoCapitalize="characters"
              maxLength={4096}
              onChange={(event) => {
                setCode(event.target.value);
                clearClassification();
              }}
              required
              rows={3}
              value={code}
            />
          </label>
          <div className="manual-cheat-options">
            <label>
              <span>System</span>
              <select
                onChange={(event) => {
                  setSystem(event.target.value as CheatDatabaseSystem);
                  clearClassification();
                }}
                value={system}
              >
                {Object.entries(SYSTEM_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Code type</span>
              <select
                onChange={(event) => {
                  setKind(event.target.value as ManualCheatKindOverride);
                  clearClassification();
                }}
                value={kind}
              >
                <option value="auto">Detect automatically</option>
                <option value="game-genie">Game Genie</option>
                <option value="pro-action-replay">Action Replay / GameShark</option>
                <option value="xploder">Xploder</option>
              </select>
            </label>
          </div>
          <button disabled={busy || !code.trim()} type="submit">
            {busy ? "Checking code…" : "Check code"}
          </button>
          {error ? <p role="alert">{error}</p> : null}
          {result ? (
            <div className="manual-cheat-result" role="status">
              <p>
                Detected {SYSTEM_LABELS[result.detectedSystem]} · {result.detectedType}
              </p>
              <p>{deliveryCopy(result.record).text}</p>
              <button disabled={!isSelectableCheat(result.record)} onClick={() => onAdd(result)} type="button">
                Add this cheat
              </button>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
};

type LocalCheatFileFormProps = {
  importer: LocalCheatFileImporter;
  onImport: (records: ClassifiedCheatRecord[]) => void;
  system: CheatDatabaseSystem;
};

const LocalCheatFileForm = ({ importer, onImport, system }: LocalCheatFileFormProps) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const sequence = useRef(0);

  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    const request = ++sequence.current;
    setError("");
    setStatus("");
    if (file.size > MAX_LOCAL_CHT_BYTES) {
      setError("The cheat file is larger than the 16 MiB import limit.");
      return;
    }
    setBusy(true);
    try {
      const records = await importer({ content: await file.text(), fileName: file.name, system });
      if (sequence.current !== request) return;
      onImport(records);
      setStatus(`Imported ${records.length} cheat${records.length === 1 ? "" : "s"} from ${file.name}.`);
    } catch (reason) {
      if (sequence.current === request) {
        setError(reason instanceof Error ? reason.message : "The cheat file could not be imported.");
      }
    } finally {
      if (sequence.current === request) setBusy(false);
    }
  };

  return (
    <div className="local-cheat-file">
      <label>
        <span>
          <FileUp aria-hidden="true" />
          Import RetroArch .cht
        </span>
        <input accept=".cht,text/plain" disabled={busy} onChange={importFile} type="file" />
      </label>
      <p>ROMWeaver reads and classifies this file locally. Imported entries stay intact.</p>
      {busy ? <p aria-live="polite">Importing cheat file…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}
    </div>
  );
};

export type CheatDatabaseSectionProps = {
  rom: CheatRomIdentity | null;
  manifest?: CheatDatabaseManifest;
  shard?: CheatSystemShard;
  client?: CheatDatabaseClient;
  classifyManualCode: ManualCheatClassifier;
  classifyDatabaseCheats: DatabaseCheatClassifier;
  importLocalCheatFile: LocalCheatFileImporter;
  onSelectionChange?: (records: ClassifiedCheatRecord[]) => void;
  outputSummary?: { rom: number; runtime: number; cheatFileName?: string };
  validationMessage?: string;
};

export const CheatDatabaseSection = ({
  rom,
  manifest,
  shard: suppliedShard,
  client: suppliedClient,
  classifyManualCode,
  classifyDatabaseCheats,
  importLocalCheatFile,
  onSelectionChange,
  outputSummary,
  validationMessage,
}: CheatDatabaseSectionProps) => {
  const [loadedShard, setLoadedShard] = useState<CheatSystemShard>();
  const [loadedManifest, setLoadedManifest] = useState<CheatDatabaseManifest>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CheatFilter>("all");
  const [manualGameId, setManualGameId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [classifiedRecords, setClassifiedRecords] = useState<ClassifiedCheatRecord[]>([]);
  const [classificationError, setClassificationError] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [manualRecords, setManualRecords] = useState<ClassifiedCheatRecord[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const selectionCallback = useRef(onSelectionChange);
  const previousGameId = useRef<string | undefined>(undefined);
  selectionCallback.current = onSelectionChange;

  const system = isCheatDatabaseSystem(rom?.system) ? rom.system : undefined;
  const activeManifest = manifest ?? loadedManifest;
  const identityKey = rom?.key;
  useEffect(() => {
    if (identityKey === "") return;
    setSelectedIds(new Set());
    setManualRecords([]);
    setManualGameId("");
    setQuery("");
    setFilter("all");
    selectionCallback.current?.([]);
  }, [identityKey]);

  useEffect(() => {
    if (manifest || suppliedClient || suppliedShard) return;
    let active = true;
    setLoadError("");
    void loadCheatDatabaseManifest()
      .then((nextManifest) => {
        if (active) setLoadedManifest(nextManifest);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(reason instanceof Error ? reason.message : "The cheat database is unavailable.");
      });
    return () => {
      active = false;
    };
  }, [manifest, suppliedClient, suppliedShard]);

  useEffect(() => {
    if (suppliedShard || !system || !(suppliedClient || activeManifest)) {
      setLoadedShard(undefined);
      return;
    }
    const client = suppliedClient ?? createCheatDatabaseClient(activeManifest as CheatDatabaseManifest);
    let active = true;
    setLoading(true);
    setLoadError("");
    void client
      .loadSystem(system)
      .then((nextShard) => {
        if (active) setLoadedShard(nextShard);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(reason instanceof Error ? reason.message : "The cheat database is unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (!suppliedClient) client.close();
    };
  }, [activeManifest, suppliedClient, suppliedShard, system]);

  const shard = suppliedShard ?? loadedShard;
  const automaticMatch = useMemo(() => matchCheatGame(rom, shard), [rom, shard]);
  const match = manualGameId ? selectManualGame(shard, manualGameId) : automaticMatch;
  const game = matchGame(match);
  const gameId = game?.id;
  useEffect(() => {
    if (previousGameId.current && previousGameId.current !== gameId) {
      setSelectedIds(new Set());
      setManualRecords([]);
      selectionCallback.current?.([]);
    }
    previousGameId.current = gameId;
  }, [gameId]);
  useEffect(() => {
    if (!(game && system)) {
      setClassifiedRecords([]);
      return;
    }
    let active = true;
    setClassifying(true);
    setClassificationError("");
    void classifyDatabaseCheats(game.cheats, system)
      .then((nextRecords) => {
        if (active) setClassifiedRecords(nextRecords);
      })
      .catch((reason: unknown) => {
        if (active) {
          setClassifiedRecords([]);
          setClassificationError(
            reason instanceof Error ? reason.message : "The cheat records could not be classified.",
          );
        }
      })
      .finally(() => {
        if (active) setClassifying(false);
      });
    return () => {
      active = false;
    };
  }, [classifyDatabaseCheats, game, system]);
  const records = useMemo(() => [...classifiedRecords, ...manualRecords], [classifiedRecords, manualRecords]);
  const visibleRecords = useMemo(() => filterCheats(records, query, filter), [filter, query, records]);
  const copy = matchCopy(match);

  const publishSelection = (next: Set<string>, source = records) => {
    setSelectedIds(next);
    selectionCallback.current?.(source.filter(({ record }) => next.has(record.id)));
  };

  const addManualRecord = (result: ManualCheatResult) => {
    const nextRecords = [...manualRecords.filter(({ record }) => record.id !== result.record.record.id), result.record];
    setManualRecords(nextRecords);
    const nextSelected = new Set(selectedIds);
    if (isSelectableCheat(result.record)) nextSelected.add(result.record.record.id);
    publishSelection(nextSelected, [...classifiedRecords, ...nextRecords]);
  };

  const addImportedRecords = (nextRecords: ClassifiedCheatRecord[]) => {
    const sourceFiles = new Set(nextRecords.map(({ record }) => record.sourceFile));
    const retainedRecords = manualRecords.filter(
      ({ record }) => record.sourceRevision !== "local-import" || !sourceFiles.has(record.sourceFile),
    );
    const mergedRecords = [...retainedRecords, ...nextRecords];
    setManualRecords(mergedRecords);
    publishSelection(selectedIds, [...classifiedRecords, ...mergedRecords]);
  };

  return (
    <section aria-labelledby="cheat-database-heading" className="cheat-database-section">
      <header>
        <span aria-hidden="true" className="cheat-database-icon">
          <Database />
        </span>
        <div>
          <h2 id="cheat-database-heading">Cheats</h2>
          <p>ROM cheats change the output ROM. RAM cheats go into a separate emulator cheat file.</p>
        </div>
      </header>

      <div className={`cheat-match is-${match.kind}`} role="status">
        <strong>{game ? gameLabel(game) : copy.heading}</strong>
        {game ? <span>{copy.heading}</span> : null}
        <span>{copy.detail}</span>
        {game ? <span>{game.cheats.length} cheats available</span> : null}
      </div>

      {loading ? <p aria-live="polite">Loading this system's cheat database…</p> : null}
      {classifying ? <p aria-live="polite">Checking cheat delivery types in ROMWeaver…</p> : null}
      {classificationError ? <p role="alert">{classificationError}</p> : null}
      {validationMessage ? <p role="alert">{validationMessage}</p> : null}
      {loadError ? (
        <p role="alert">
          The cheat database is unavailable. Offline access starts after this system loads once. {loadError}
        </p>
      ) : null}

      {rom && system && shard && match.kind !== "exact" ? (
        <label className="cheat-game-picker">
          <span>Browse games for {SYSTEM_LABELS[system]}</span>
          <select onChange={(event) => setManualGameId(event.target.value)} value={manualGameId}>
            <option value="">Use automatic match</option>
            {shard.games.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {gameLabel(candidate)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {game || manualRecords.length ? (
        <>
          <div className="cheat-tools">
            <label className="cheat-search">
              <span className="sr-only">Search cheats</span>
              <Search aria-hidden="true" />
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search cheats…"
                type="search"
                value={query}
              />
            </label>
            <fieldset>
              <legend className="sr-only">Filter cheats by delivery type</legend>
              {FILTERS.map((option) => (
                <label key={option.id}>
                  <input
                    checked={filter === option.id}
                    name="cheat-filter"
                    onChange={() => setFilter(option.id)}
                    type="radio"
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
          </div>

          {!classifying && visibleRecords.length ? (
            <ul className="cheat-list">
              {visibleRecords.map((record) => (
                <CheatRow
                  checked={selectedIds.has(record.record.id)}
                  expanded={expandedIds.has(record.record.id)}
                  key={record.record.id}
                  onExpand={() => {
                    const next = new Set(expandedIds);
                    if (next.has(record.record.id)) next.delete(record.record.id);
                    else next.add(record.record.id);
                    setExpandedIds(next);
                  }}
                  onToggle={() => {
                    const next = new Set(selectedIds);
                    if (next.has(record.record.id)) next.delete(record.record.id);
                    else next.add(record.record.id);
                    publishSelection(next);
                  }}
                  record={record}
                />
              ))}
            </ul>
          ) : classifying ? null : (
            <p role="status">No cheats match this search and filter.</p>
          )}
        </>
      ) : null}

      {system ? (
        <>
          <LocalCheatFileForm
            importer={importLocalCheatFile}
            key={`${identityKey ?? "unknown"}:${system}`}
            onImport={addImportedRecords}
            system={system}
          />
          <ManualCodeForm classifier={classifyManualCode} defaultSystem={system} onAdd={addManualRecord} />
        </>
      ) : null}

      {outputSummary ? (
        <div className="cheat-output-summary" role="status">
          {outputSummary.rom ? (
            <p>
              ROM output: Contains patches and {outputSummary.rom} baked ROM cheat
              {outputSummary.rom === 1 ? "" : "s"}.
            </p>
          ) : null}
          {outputSummary.runtime ? (
            <p>
              Cheat file: {outputSummary.cheatFileName || "RetroArch .cht"} contains {outputSummary.runtime} RAM or
              runtime cheat{outputSummary.runtime === 1 ? "" : "s"}.
            </p>
          ) : null}
        </div>
      ) : null}

      <aside className="cheat-notices">
        <p>Community cheat data can contain errors. A checksum match does not prove that each cheat works.</p>
        <p>RAM cheats need a compatible RetroArch core or emulator. ROMWeaver does not upload ROM data or checksums.</p>
        {activeManifest ? (
          <p>
            Database: {activeManifest.source} at {activeManifest.sourceRevision} · {activeManifest.license}
          </p>
        ) : null}
        <p>Each system becomes available offline after it loads once.</p>
      </aside>
    </section>
  );
};
