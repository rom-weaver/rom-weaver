import { Check, Download, Plus, Search, WandSparkles, X } from "lucide-react";
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
import { getCheatPatchStatus, getRomCheats } from "../cheat-patch-export-model.ts";
import { matchGame, useCheatDatabaseRecords } from "./use-cheat-database-records.ts";
import { Drawer, DrawerReadout } from "./ds/drawer.tsx";
import { Notice } from "./ds/feedback.tsx";
import { FileCard } from "./ds/file-card.tsx";
import { InfoPopover } from "./ds/layout.tsx";
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
  /**
   * Bake the ROM cheats that are On into a standalone patch and download it.
   * Resolves with the created file name. Absent when the workflow cannot run
   * one (no ROM staged yet). The system is the one the database lookup routed
   * the ROM to, so the caller does not resolve it a second time.
   */
  onSaveAsPatch?: (records: ClassifiedCheatRecord[], system: CheatManualSystem | undefined) => Promise<string>;
  outputSummary?: { rom: number };
  validationMessage?: string;
  /** Localized card heading. */
  title: ReactNode;
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
  onSaveAsPatch,
  outputSummary,
  validationMessage,
  title,
}: CheatDatabaseSectionProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  // The header switch. Off keeps the cards but publishes an empty selection,
  // so the run bakes nothing and the header-strip guard lets go.
  const [enabled, setEnabled] = useState(true);
  const [savingPatch, setSavingPatch] = useState(false);
  const [patchStatus, setPatchStatus] = useState("");
  const [patchError, setPatchError] = useState("");
  const [databaseQuery, setDatabaseQuery] = useState("");
  const [gameQuery, setGameQuery] = useState("");
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
    setManualEntrySlug,
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
    setManualEntrySlug("");
    setDatabaseQuery("");
    setGameQuery("");
    // A new ROM starts the card On; the switch belongs to the stack the user
    // built for the previous ROM and is gone while no ROM is staged.
    setEnabled(true);
    selectionCallback.current?.([]);
  }, [identityKey, setManualEntrySlug, setManualGameId]);

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
  const selectedRecords = useMemo(
    () => records.filter(({ record }) => selectedIds.has(record.id)),
    [records, selectedIds],
  );
  const selectedRomCheats = useMemo(() => getRomCheats(selectedRecords), [selectedRecords]);

  const publish = (nextSelected: Set<string>, source = records) => {
    setSelectedIds(nextSelected);
    if (enabled) selectionCallback.current?.(source.filter(({ record }) => nextSelected.has(record.id)));
  };

  const toggleEnabled = () => {
    const nextEnabled = !enabled;
    setEnabled(nextEnabled);
    selectionCallback.current?.(nextEnabled ? selectedRecords : []);
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

  const gameOptions = useMemo(() => {
    if (!shard) return [];
    const query = gameQuery.trim().toLocaleLowerCase("en-US");
    if (!query) return shard.games;
    return shard.games.filter((candidate) => gameLabel(candidate).toLocaleLowerCase("en-US").includes(query));
  }, [gameQuery, shard]);

  const databaseOptions = useMemo(() => {
    if (!activeIndex) return [];
    const query = databaseQuery.trim().toLocaleLowerCase("en-US");
    const options = activeIndex.entries.filter((candidate) => {
      if (!query) return true;
      return `${candidate.platform} ${candidate.slug}`.toLocaleLowerCase("en-US").includes(query);
    });
    return options.slice(0, 8);
  }, [activeIndex, databaseQuery]);

  const databasePicker =
    rom && activeIndex && !entry && !rom.platform && !manualOnlySystem ? (
      <div className="cheat-database-picker">
        <label className="cheat-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search cheat databases</span>
          <input
            onChange={(event) => setDatabaseQuery(event.target.value)}
            placeholder="Search cheat databases by system…"
            type="search"
            value={databaseQuery}
          />
        </label>
        {databaseOptions.length ? (
          <div className="cheat-database-options">
            {databaseOptions.map((candidate) => (
              <button
                className="cheat-database-option"
                key={candidate.slug}
                onClick={() => {
                  setManualEntrySlug(candidate.slug);
                  setGameQuery("");
                }}
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
    ) : null;

  const gamePicker =
    rom && entry && shard && match.kind !== "exact" ? (
      <div className="cheat-game-picker">
        <label>
          <span>Search games in {entry.platform}</span>
          <input
            onChange={(event) => setGameQuery(event.target.value)}
            placeholder="Search by game title…"
            type="search"
            value={gameQuery}
          />
        </label>
        <select
          aria-label={`Browse games for ${entry.platform}`}
          onChange={(event) => setManualGameId(event.target.value)}
          value={manualGameId}
        >
          <option value="">Use automatic match</option>
          {gameOptions.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {gameLabel(candidate)}
            </option>
          ))}
        </select>
        {gameOptions.length ? null : (
          <p className="cheat-pick-empty" role="status">
            No games match this search.
          </p>
        )}
        {match.kind === "title" || match.kind === "manual" ? <p className="cheat-pick-empty">{copy.detail}</p> : null}
      </div>
    ) : null;

  // The chips report what the run will bake, so Off counts every card as off.
  const publishedCount = enabled ? selectedRecords.length : 0;
  const offCount = cards.length - publishedCount;
  const status = loading
    ? "Loading this system's cheat database…"
    : classifying
      ? "Checking cheat delivery types in ROMWeaver…"
      : "";
  const loadErrorMessage = loadError
    ? `The cheat database is unavailable. Offline access starts after this system loads once. ${loadError}`
    : "";

  if (!rom) return null;

  return (
    <div className="cheat-card-row" id="rom-weaver-row-cheat-stack">
      <FileCard
        className={enabled ? "cheat-database-card" : "cheat-database-card is-off"}
        menu={
          <label className="patch-enable">
            <input aria-label="Use cheats" checked={enabled} onChange={toggleEnabled} type="checkbox" />
            <span aria-hidden="true" className="switch-state">
              <b className="on">On</b>
              <b className="off">Off</b>
            </span>
          </label>
        }
        meta={
          <>
            {cards.length ? <span className="rb mono">{countLabel(publishedCount, "cheat")}</span> : null}
            {offCount ? <span className="rb mono muted">{`${offCount} off`}</span> : null}
          </>
        }
        name={
          <span className="nmline">
            <span className="nm">{title}</span>
            <InfoPopover title="Cheats">
              <strong>Cheats</strong>
              <ul className="info-list">
                <li>Optional. Cheats that are On are baked into the output ROM after the patches apply.</li>
                <li>Only ROM cheats can be baked; codes that target runtime memory stay unsupported.</li>
                <li>Community cheat data can contain errors. A checksum match does not prove that each cheat works.</li>
                <li>ROMWeaver does not upload ROM data or checksums. Each system works offline after it loads once.</li>
              </ul>
            </InfoPopover>
          </span>
        }
        patch
      >
        <div className="cheat-card-body" hidden={!enabled}>
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

          {cards.length && onSaveAsPatch ? (
            <div className="cheat-actions">
              <button
                className="btn cheat-save-patch"
                disabled={savingPatch || !selectedRomCheats.length}
                onClick={() => {
                  setPatchError("");
                  setPatchStatus("");
                  setSavingPatch(true);
                  void onSaveAsPatch(selectedRecords, manualSystem)
                    .then((fileName) => setPatchStatus(getCheatPatchStatus(fileName, selectedRomCheats.length)))
                    .catch((reason: unknown) =>
                      setPatchError(reason instanceof Error ? reason.message : "The cheat patch could not be created."),
                    )
                    .finally(() => setSavingPatch(false));
                }}
                title={selectedRomCheats.length ? undefined : "Turn on at least one ROM cheat to bake it into a patch."}
                type="button"
              >
                <Download aria-hidden="true" />
                {savingPatch ? "Creating patch…" : "Save as patch"}
              </button>
              {patchStatus ? <p role="status">{patchStatus}</p> : null}
            </div>
          ) : null}

          {databasePicker}
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

          {status ? (
            <p aria-live="polite" className="cheat-status">
              {status}
            </p>
          ) : null}
          {patchError ? (
            <Notice id="rom-weaver-cheat-patch-error" level="error" onDismiss={() => setPatchError("")}>
              {patchError}
            </Notice>
          ) : null}
          {classificationError ? (
            <Notice id="rom-weaver-cheat-classify-error" level="error">
              {classificationError}
            </Notice>
          ) : null}
          {validationMessage ? (
            <Notice id="rom-weaver-cheat-notice-message" level="warn">
              {validationMessage}
            </Notice>
          ) : null}
          {loadErrorMessage ? (
            <Notice id="rom-weaver-cheat-load-error" level="error">
              {loadErrorMessage}
            </Notice>
          ) : null}

          {outputSummary?.rom ? (
            <div className="cheat-output-summary" role="status">
              <p>ROM output: Contains patches and {countLabel(outputSummary.rom, "baked ROM cheat")}.</p>
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
            onAdd={addRecord}
            onClose={() => setDialogOpen(false)}
            onRemove={dropRecord}
            open={dialogOpen}
            records={records}
            stackCount={cards.length}
            status={pickerStatus}
            title={gameTitle && !manualOnlyCopy ? `Add cheats · ${gameTitle}` : "Add cheats"}
          />
        </div>
      </FileCard>
    </div>
  );
};
