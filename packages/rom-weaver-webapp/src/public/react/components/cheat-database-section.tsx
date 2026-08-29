import { Check, FileUp, Plus, Search, WandSparkles, X } from "lucide-react";
import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { Drawer, DrawerReadout } from "./ds/drawer.tsx";
import { FileCard } from "./ds/file-card.tsx";
import { StepSection } from "./ds/layout.tsx";
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

/** Rows per page in the add-cheats dialog list. */
const DIALOG_PAGE_SIZE = 8;

const DEFAULT_DATABASE_CREDIT = "libretro-database CC-BY-SA-4.0";

const matchGame = (match: CheatGameMatch) => ("game" in match ? match.game : undefined);

const matchCopy = (match: CheatGameMatch): { heading: string; detail: string } => {
  if (match.kind === "exact") {
    return { heading: "Exact checksum match", detail: "The original ROM checksum matched a known release." };
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

const deliveryCopy = (record: ClassifiedCheatRecord): { badge: string; short: string; text: string } => {
  const delivery = cheatDelivery(record);
  if (delivery === "rom") return { badge: "ROM cheat", short: "ROM", text: "Baked into output" };
  if (delivery === "runtime") return { badge: "RAM cheat", short: "RAM", text: "Emulator cheat file" };
  if (delivery === "requires-parameter") {
    return { badge: "Needs a value", short: "Value", text: "Add a value before selection" };
  }
  return { badge: "Unsupported", short: "N/A", text: "Cannot be selected" };
};

const gameLabel = (game: NonNullable<ReturnType<typeof matchGame>>): string =>
  [game.title, game.regions.join(" / "), game.revisions.join(" / ")].filter(Boolean).join(" · ");

const cheatKindLabel = (record: ClassifiedCheatRecord): string => record.detectedKind || "raw RAM write";

const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type CheatCardProps = {
  record: ClassifiedCheatRecord;
  position: number;
  selected: boolean;
  onToggle: () => void;
  onRemove: () => void;
};

/**
 * One added cheat, shaped like a patch card: the description as the name, an
 * On/Off switch that drives inclusion, the raw code and delivery badges on the
 * meta line, and a details drawer.
 */
const CheatCard = ({ record, position, selected, onToggle, onRemove }: CheatCardProps) => {
  const delivery = deliveryCopy(record);
  const source = record.record;
  const selectable = isSelectableCheat(record);
  return (
    <FileCard
      handle={
        <button
          aria-label={`Cheat ${position}`}
          className="handle phandle"
          disabled
          title="Cheat position"
          type="button"
        >
          <span aria-hidden="true" className="phandle-number mono">
            {position}
          </span>
        </button>
      }
      meta={
        <>
          <label className="patch-enable">
            <input
              aria-label={`Include ${source.description}`}
              checked={selected}
              disabled={!selectable}
              onChange={onToggle}
              type="checkbox"
            />
            <span aria-hidden="true" className="switch-state">
              <b className="on">On</b>
              <b className="off">Off</b>
            </span>
          </label>
          {source.rawCode ? <span className="rb mono">{source.rawCode}</span> : null}
          <span className="rb">{delivery.badge}</span>
        </>
      }
      name={<span className="nm">{source.description}</span>}
      onRemove={onRemove}
      patch
      removeLabel={`Remove ${source.description} from the cheat stack`}
      state="ok"
    >
      <Drawer
        label="Cheat"
        labelIcon={<WandSparkles aria-hidden="true" />}
        readouts={<DrawerReadout>{cheatKindLabel(record)}</DrawerReadout>}
      >
        {source.rawCode ? (
          <div className="ck mono">
            <span className="ck-k">Code</span>
            <span className="ck-v">{source.rawCode}</span>
          </div>
        ) : null}
        <div className="ck">
          <span className="ck-k">Delivery</span>
          <span className="ck-v">
            {record.resolution.type === "unsupported"
              ? record.resolution.reason
              : cheatDelivery(record) === "rom"
                ? "baked into output"
                : "emulator cheat file"}
          </span>
        </div>
        <div className="ck">
          <span className="ck-k">Source</span>
          <span className="ck-v">
            {source.sourceFile} at {source.sourceRevision}
          </span>
        </div>
      </Drawer>
    </FileCard>
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

type AddCheatsDialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  records: ClassifiedCheatRecord[];
  addedIds: ReadonlySet<string>;
  stackCount: number;
  onAdd: (record: ClassifiedCheatRecord) => void;
  onRemove: (record: ClassifiedCheatRecord) => void;
  gamePicker?: ReactNode;
  extras?: ReactNode;
  notices?: ReactNode;
};

/**
 * The cheat picker: one paginated page of the game's cheats at a time, filtered
 * by description or raw code, with the local-file and manual-code entry points
 * below the list. Rows added here become cards in the step.
 */
const AddCheatsDialog = ({
  open,
  onClose,
  title,
  records,
  addedIds,
  stackCount,
  onAdd,
  onRemove,
  gamePicker,
  extras,
  notices,
}: AddCheatsDialogProps) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  const visible = useMemo(() => filterCheats(records, query, "all"), [query, records]);
  const pageCount = Math.max(1, Math.ceil(visible.length / DIALOG_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = visible.slice(currentPage * DIALOG_PAGE_SIZE, currentPage * DIALOG_PAGE_SIZE + DIALOG_PAGE_SIZE);

  return (
    <dialog
      aria-label={title}
      className="dlg cheat-dlg"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      ref={dialogRef}
    >
      {open ? (
        <div className="dlg-frame">
          <header className="dlg-head">
            <h2 className="dlg-title">{title}</h2>
            <button aria-label="Close" className="dlg-x" onClick={onClose} title="Close" type="button">
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="dlg-body">
            {gamePicker}
            <label className="cheat-search">
              <span className="sr-only">Search cheats</span>
              <Search aria-hidden="true" />
              <input
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                placeholder="Search by name or code…"
                type="search"
                value={query}
              />
            </label>
            {rows.length ? (
              <ul className="cheat-pick-list">
                {rows.map((entry) => {
                  const source = entry.record;
                  const delivery = deliveryCopy(entry);
                  const added = addedIds.has(source.id);
                  return (
                    <li className="cheat-pick" key={source.id}>
                      <span className="cheat-pick-text">
                        <span className="cheat-pick-name">{source.description}</span>
                        <span className="cheat-pick-badges">
                          {source.rawCode ? <span className="rb mono">{source.rawCode}</span> : null}
                          <span className="rb">{delivery.short}</span>
                        </span>
                      </span>
                      <button
                        aria-label={`${added ? "Remove" : "Add"} ${source.description}`}
                        className={added ? "cheat-pick-btn is-added" : "cheat-pick-btn"}
                        disabled={!(added || isSelectableCheat(entry))}
                        onClick={() => (added ? onRemove(entry) : onAdd(entry))}
                        type="button"
                      >
                        {added ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
                        {added ? "Remove" : "Add"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="cheat-pick-empty" role="status">
                No cheats match this search. Import a RetroArch .cht file or add a code manually below.
              </p>
            )}
            <div className="cheat-pick-foot">
              <span className="cheat-pick-count">
                {visible.length} of {countLabel(records.length, "cheat")} · {stackCount} in the stack
              </span>
              <span className="cheat-pager">
                <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} type="button">
                  Previous
                </button>
                <span className="mono">
                  {currentPage + 1} / {pageCount}
                </span>
                <button disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)} type="button">
                  Next
                </button>
              </span>
            </div>
            {extras}
            {notices}
          </div>
        </div>
      ) : null}
    </dialog>
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
  /** Step number in the apply workflow. */
  num?: string;
  /** Marks the step as finished (the apply run produced its cheat output). */
  woven?: boolean;
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
  num = "0x04",
  woven,
}: CheatDatabaseSectionProps) => {
  const [loadedShard, setLoadedShard] = useState<CheatSystemShard>();
  const [loadedManifest, setLoadedManifest] = useState<CheatDatabaseManifest>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [manualGameId, setManualGameId] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  // Cards on show. Selection is the subset whose switch is On, so a card can
  // stay in the stack while excluded from the run.
  const [addedIds, setAddedIds] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [classifiedRecords, setClassifiedRecords] = useState<ClassifiedCheatRecord[]>([]);
  const [classificationError, setClassificationError] = useState("");
  const [classifying, setClassifying] = useState(false);
  const [manualRecords, setManualRecords] = useState<ClassifiedCheatRecord[]>([]);
  const selectionCallback = useRef(onSelectionChange);
  const previousGameId = useRef<string | undefined>(undefined);
  selectionCallback.current = onSelectionChange;

  const system = isCheatDatabaseSystem(rom?.system) ? rom.system : undefined;
  const activeManifest = manifest ?? loadedManifest;
  const identityKey = rom?.key;
  useEffect(() => {
    if (identityKey === "") return;
    setSelectedIds(new Set());
    setAddedIds(new Set());
    setManualRecords([]);
    setManualGameId("");
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
      setAddedIds(new Set());
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
  const cards = useMemo(() => records.filter(({ record }) => addedIds.has(record.id)), [addedIds, records]);
  const copy = matchCopy(match);

  const publish = (nextSelected: Set<string>, source = records) => {
    setSelectedIds(nextSelected);
    selectionCallback.current?.(source.filter(({ record }) => nextSelected.has(record.id)));
  };

  const addRecord = (record: ClassifiedCheatRecord) => {
    const id = record.record.id;
    setAddedIds(new Set(addedIds).add(id));
    if (!isSelectableCheat(record)) return;
    publish(new Set(selectedIds).add(id));
  };

  const dropRecord = (record: ClassifiedCheatRecord) => {
    const id = record.record.id;
    const nextAdded = new Set(addedIds);
    nextAdded.delete(id);
    setAddedIds(nextAdded);
    if (!selectedIds.has(id)) return;
    const nextSelected = new Set(selectedIds);
    nextSelected.delete(id);
    publish(nextSelected);
  };

  const toggleRecord = (record: ClassifiedCheatRecord) => {
    const id = record.record.id;
    const nextSelected = new Set(selectedIds);
    if (nextSelected.has(id)) nextSelected.delete(id);
    else nextSelected.add(id);
    publish(nextSelected);
  };

  const addManualRecord = (result: ManualCheatResult) => {
    const id = result.record.record.id;
    const nextRecords = [...manualRecords.filter(({ record }) => record.id !== id), result.record];
    setManualRecords(nextRecords);
    setAddedIds(new Set(addedIds).add(id));
    const nextSelected = new Set(selectedIds);
    if (isSelectableCheat(result.record)) nextSelected.add(id);
    publish(nextSelected, [...classifiedRecords, ...nextRecords]);
  };

  const addImportedRecords = (nextRecords: ClassifiedCheatRecord[]) => {
    const sourceFiles = new Set(nextRecords.map(({ record }) => record.sourceFile));
    const retainedRecords = manualRecords.filter(
      ({ record }) => record.sourceRevision !== "local-import" || !sourceFiles.has(record.sourceFile),
    );
    const mergedRecords = [...retainedRecords, ...nextRecords];
    setManualRecords(mergedRecords);
    // Imported entries land as cards but stay off until the user includes them.
    const nextAdded = new Set(addedIds);
    for (const { record } of nextRecords) nextAdded.add(record.id);
    setAddedIds(nextAdded);
    publish(selectedIds, [...classifiedRecords, ...mergedRecords]);
  };

  const gameTitle = game?.title || rom?.title || "";
  const databaseCredit = activeManifest
    ? `${activeManifest.source} ${activeManifest.license}`
    : DEFAULT_DATABASE_CREDIT;

  const gamePicker =
    rom && system && shard && match.kind !== "exact" ? (
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
    ) : null;

  return (
    <StepSection
      id="rom-weaver-row-cheat-stack"
      meta={
        <>
          <span className="rb mono">{countLabel(cards.length, "cheat")}</span>
          <span className="rb mono muted">optional</span>
        </>
      }
      num={num}
      title="Cheats"
      woven={woven}
    >
      {cards.length ? (
        <div className="cards patch-cards workflow-file-list" id="rom-weaver-list-cheat-stack">
          {cards.map((entry, index) => (
            <CheatCard
              key={entry.record.id}
              onRemove={() => dropRecord(entry)}
              onToggle={() => toggleRecord(entry)}
              position={index + 1}
              record={entry}
              selected={selectedIds.has(entry.record.id)}
            />
          ))}
        </div>
      ) : null}

      <button className="needs-input cheat-add" onClick={() => setDialogOpen(true)} type="button">
        <Search aria-hidden="true" />
        <span>
          {gameTitle ? (
            <>
              Search the cheat database for <b className="hexref mono">{gameTitle}</b>
            </>
          ) : (
            "Search the cheat database"
          )}
        </span>
      </button>
      <p className="cheat-add-note">
        {copy.heading}
        {game ? ` · ${countLabel(game.cheats.length, "database cheat")}` : ""} · {databaseCredit}
      </p>

      {loading ? <p aria-live="polite">Loading this system's cheat database…</p> : null}
      {classifying ? <p aria-live="polite">Checking cheat delivery types in ROMWeaver…</p> : null}
      {classificationError ? <p role="alert">{classificationError}</p> : null}
      {validationMessage ? <p role="alert">{validationMessage}</p> : null}
      {loadError ? (
        <p role="alert">
          The cheat database is unavailable. Offline access starts after this system loads once. {loadError}
        </p>
      ) : null}

      {outputSummary ? (
        <div className="cheat-output-summary" role="status">
          {outputSummary.rom ? (
            <p>ROM output: Contains patches and {countLabel(outputSummary.rom, "baked ROM cheat")}.</p>
          ) : null}
          {outputSummary.runtime ? (
            <p>
              Cheat file: {outputSummary.cheatFileName || "RetroArch .cht"} contains{" "}
              {countLabel(outputSummary.runtime, "RAM or runtime cheat")}.
            </p>
          ) : null}
        </div>
      ) : null}

      <AddCheatsDialog
        addedIds={addedIds}
        extras={
          system ? (
            <>
              <LocalCheatFileForm
                importer={importLocalCheatFile}
                key={`${identityKey ?? "unknown"}:${system}`}
                onImport={addImportedRecords}
                system={system}
              />
              <ManualCodeForm classifier={classifyManualCode} defaultSystem={system} onAdd={addManualRecord} />
            </>
          ) : null
        }
        gamePicker={gamePicker}
        notices={
          <aside className="cheat-notices">
            <p>{copy.detail}</p>
            <p>Community cheat data can contain errors. A checksum match does not prove that each cheat works.</p>
            <p>
              RAM cheats need a compatible RetroArch core or emulator. ROMWeaver does not upload ROM data or checksums.
            </p>
            {activeManifest ? (
              <p>
                Database: {activeManifest.source} at {activeManifest.sourceRevision} · {activeManifest.license}
              </p>
            ) : null}
            <p>Each system becomes available offline after it loads once.</p>
          </aside>
        }
        onAdd={addRecord}
        onClose={() => setDialogOpen(false)}
        onRemove={dropRecord}
        open={dialogOpen}
        records={records}
        stackCount={cards.length}
        title={gameTitle ? `Add cheats · ${gameTitle}` : "Add cheats"}
      />
    </StepSection>
  );
};
