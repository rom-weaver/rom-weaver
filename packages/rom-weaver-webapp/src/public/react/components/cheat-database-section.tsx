import { Check, Plus, Search, WandSparkles, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { IdentifyCatalog } from "../../../lib/identify/identify-catalog.ts";
import {
  cheatDelivery,
  filterCheats,
  isSelectableCheat,
  type CheatDatabaseClient,
  type CheatDatabaseIndex,
  type CheatManualOnlySystem,
  type CheatManualSystem,
  type CheatGameMatch,
  type CheatRomIdentity,
  type CheatSystemShard,
  type ClassifiedCheatRecord,
  type DatabaseCheatClassifier,
  type ManualCheatClassifier,
  type ManualCheatKindOverride,
  type ManualCheatResult,
} from "../../../lib/cheats/index.ts";
import { matchGame, useCheatDatabaseRecords } from "./use-cheat-database-records.ts";
import { Drawer, DrawerReadout } from "./ds/drawer.tsx";
import { FileCard } from "./ds/file-card.tsx";
import { StepSection } from "./ds/layout.tsx";
import "./cheat-database-section.css";

type SystemOption = { value: CheatManualSystem; label: string };

/**
 * Systems with no cheat database, where the step still offers manual entry.
 * Each states what its own code scheme delivers.
 */
const MANUAL_ONLY_SYSTEMS: Record<CheatManualOnlySystem, { label: string; copy: string }> = {
  playstation: {
    copy:
      "No cheat database for PlayStation. You can still add Xploder codes by hand; " +
      "their ROM writes bake into the PS-X EXE.",
    label: "PlayStation",
  },
};

/** `owner/repo` for the notice line; the index stores the repository URL. */
const sourceName = (sourceUrl: string): string => {
  try {
    return new URL(sourceUrl).pathname.replace(/^\/+|\/+$/gu, "") || sourceUrl;
  } catch {
    return sourceUrl;
  }
};

/** Rows per page in the add-cheats dialog list. */
const DIALOG_PAGE_SIZE = 8;

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

const deliveryCopy = (record: ClassifiedCheatRecord): { badge: string; short: string; text: string } =>
  cheatDelivery(record) === "rom"
    ? { badge: "ROM cheat", short: "ROM", text: "Baked into output" }
    : { badge: "Unsupported", short: "N/A", text: "Cannot be baked into the ROM" };

export const gameLabel = (game: NonNullable<ReturnType<typeof matchGame>>): string =>
  [game.title, game.regions.join(" / "), game.revisions.join(" / ")].filter(Boolean).join(" · ");

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
        readouts={record.detectedKind ? <DrawerReadout>{record.detectedKind}</DrawerReadout> : undefined}
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
            {record.resolution.type === "unsupported" ? record.resolution.reason : "baked into output"}
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
  defaultSystem: CheatManualSystem;
  systems: SystemOption[];
  classifier: ManualCheatClassifier;
  onAdd: (result: ManualCheatResult) => void;
};

const ManualCodeForm = ({ defaultSystem, systems, classifier, onAdd }: ManualCodeFormProps) => {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("Manual cheat");
  const [system, setSystem] = useState<CheatManualSystem>(defaultSystem);
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
                  setSystem(event.target.value as CheatManualSystem);
                  clearClassification();
                }}
                value={system}
              >
                {systems.map(({ value, label }) => (
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
                Detected {systems.find(({ value }) => value === result.detectedSystem)?.label ?? result.detectedSystem}{" "}
                · {result.detectedType}
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

type AddCheatsDialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  records: ClassifiedCheatRecord[];
  addedIds: ReadonlySet<string>;
  stackCount: number;
  onAdd: (record: ClassifiedCheatRecord) => void;
  onRemove: (record: ClassifiedCheatRecord) => void;
  /** Replaces the list while the shard loads or classifies, or when either failed. */
  status?: { text: string; error?: boolean };
  gamePicker?: ReactNode;
  extras?: ReactNode;
  notices?: ReactNode;
};

/**
 * The cheat picker: one paginated page of the game's cheats at a time, filtered
 * by description or raw code, with the manual-code entry point below the list.
 * Rows added here become cards in the step.
 */
export const AddCheatsDialog = ({
  open,
  onClose,
  title,
  records,
  addedIds,
  stackCount,
  onAdd,
  onRemove,
  status,
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
      // Each open starts on the full list: a search left over from the last
      // visit would hide rows the user never filtered out this time.
      setQuery("");
      setPage(0);
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  const visible = useMemo(() => filterCheats(records, query), [query, records]);
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
            {status ? (
              <p className="cheat-pick-empty" role={status.error ? "alert" : "status"}>
                {status.text}
              </p>
            ) : rows.length ? (
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
                No cheats match this search. Add a code manually below.
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
  /** Test seams: a supplied index skips the identify index fetch. */
  index?: CheatDatabaseIndex;
  catalog?: IdentifyCatalog;
  shard?: CheatSystemShard;
  client?: CheatDatabaseClient;
  classifyManualCode: ManualCheatClassifier;
  classifyDatabaseCheats: DatabaseCheatClassifier;
  onSelectionChange?: (records: ClassifiedCheatRecord[]) => void;
  outputSummary?: { rom: number };
  validationMessage?: string;
  /** Localized step heading. */
  title: ReactNode;
  /** Step number in the apply workflow. */
  num?: string;
  /** Marks the step as finished (the apply run produced its cheat output). */
  woven?: boolean;
};

export const CheatDatabaseSection = ({
  rom,
  index,
  catalog,
  shard: suppliedShard,
  client: suppliedClient,
  classifyManualCode,
  classifyDatabaseCheats,
  onSelectionChange,
  outputSummary,
  validationMessage,
  title,
  num = "0x04",
  woven,
}: CheatDatabaseSectionProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Cards on show. Selection is the subset whose switch is On, so a card can
  // stay in the stack while excluded from the run.
  const [addedIds, setAddedIds] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [manualRecords, setManualRecords] = useState<ClassifiedCheatRecord[]>([]);
  const selectionCallback = useRef(onSelectionChange);
  const previousGameId = useRef<string | undefined>(undefined);
  selectionCallback.current = onSelectionChange;

  const {
    activeIndex,
    classificationError,
    classifying,
    entry,
    game,
    loadError,
    loading,
    manualGameId,
    manualOnlySystem,
    manualSystem,
    match: databaseMatch,
    records: classifiedRecords,
    setManualGameId,
    shard,
  } = useCheatDatabaseRecords({
    ...(catalog ? { catalog } : {}),
    classifyDatabaseCheats,
    ...(suppliedClient ? { client: suppliedClient } : {}),
    ...(index ? { index } : {}),
    rom,
    ...(suppliedShard ? { shard: suppliedShard } : {}),
  });
  const manualOnlyCopy = manualOnlySystem ? MANUAL_ONLY_SYSTEMS[manualOnlySystem].copy : "";
  const identityKey = rom?.key;
  useEffect(() => {
    if (identityKey === "") return;
    setSelectedIds(new Set());
    setAddedIds(new Set());
    setManualRecords([]);
    setManualGameId("");
    selectionCallback.current?.([]);
  }, [identityKey, setManualGameId]);

  const match = databaseMatch;
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
  const records = useMemo(() => [...classifiedRecords, ...manualRecords], [classifiedRecords, manualRecords]);
  // Cards keep the order the user added them in, like the patch stack.
  const cards = useMemo(
    () =>
      [...addedIds].flatMap((id) => {
        const entry = records.find(({ record }) => record.id === id);
        return entry ? [entry] : [];
      }),
    [addedIds, records],
  );
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

  const gameTitle = game?.title || rom?.title || "";
  const databaseCredit = activeIndex ? ` · ${sourceName(activeIndex.sourceUrl)} ${activeIndex.license}` : "";
  const pickerStatus = loadError
    ? { error: true, text: `The cheat database is unavailable. ${loadError}` }
    : classificationError
      ? { error: true, text: classificationError }
      : loading
        ? { text: "Loading this system's cheat database…" }
        : classifying
          ? { text: "Checking cheat delivery types in ROMWeaver…" }
          : undefined;
  const systems: SystemOption[] = [
    ...(activeIndex?.entries ?? []).map((candidate) => ({
      label: candidate.platform,
      value: candidate.cheatSystem as CheatManualSystem,
    })),
    ...Object.entries(MANUAL_ONLY_SYSTEMS).map(([value, { label }]) => ({
      label,
      value: value as CheatManualSystem,
    })),
  ];

  const gamePicker =
    rom && entry && shard && match.kind !== "exact" ? (
      <label className="cheat-game-picker">
        <span>Browse games for {entry.platform}</span>
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
      title={title}
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
        {manualOnlyCopy ? <Plus aria-hidden="true" /> : <Search aria-hidden="true" />}
        <span>
          {manualOnlyCopy ? (
            "Add cheat codes"
          ) : gameTitle ? (
            <>
              Search the cheat database for <b className="hexref mono">{gameTitle}</b>
            </>
          ) : (
            "Search the cheat database"
          )}
        </span>
      </button>
      <p className="cheat-add-note">
        {manualOnlyCopy ? (
          manualOnlyCopy
        ) : (
          <>
            {copy.heading}
            {game ? ` · ${countLabel(game.cheats.length, "database cheat")}` : ""}
            {databaseCredit}
          </>
        )}
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
        </div>
      ) : null}

      <AddCheatsDialog
        addedIds={addedIds}
        extras={
          manualSystem ? (
            <ManualCodeForm
              classifier={classifyManualCode}
              defaultSystem={manualSystem}
              onAdd={addManualRecord}
              systems={systems}
            />
          ) : null
        }
        gamePicker={gamePicker}
        notices={
          <aside className="cheat-notices">
            <p>{manualOnlyCopy || copy.detail}</p>
            <p>Community cheat data can contain errors. A checksum match does not prove that each cheat works.</p>
            <p>ROMWeaver does not upload ROM data or checksums.</p>
            {activeIndex ? (
              <p>
                Database: {sourceName(activeIndex.sourceUrl)} at {activeIndex.sourceRevision} · {activeIndex.license}
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
        status={pickerStatus}
        title={gameTitle && !manualOnlyCopy ? `Add cheats · ${gameTitle}` : "Add cheats"}
      />
    </StepSection>
  );
};
