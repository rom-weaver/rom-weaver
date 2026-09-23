import { Download, Plus, Search, WandSparkles, X } from "lucide-react";
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
  type CheatRomIdentity,
  type CheatSystemShard,
  type ClassifiedCheatRecord,
  type DatabaseCheatClassifier,
  type ManualCheatClassifier,
  type ManualCheatKindOverride,
  type ManualCheatResult,
} from "../../../lib/cheats/index.ts";
import { getCheatPatchStatus } from "../cheat-patch-export-model.ts";
import { matchGame, useCheatDatabaseRecords } from "./use-cheat-database-records.ts";
import { Drawer } from "./ds/drawer.tsx";
import { DropdownSelect } from "./ds/dropdown-select.tsx";
import { Notice } from "./ds/feedback.tsx";
import { FileCard } from "./ds/file-card.tsx";
import { reorder, useListReorder } from "./ds/use-list-reorder.ts";
import "./cheat-database-section.css";

type SystemOption = { value: CheatManualSystem; label: string };

const MANUAL_ONLY_SYSTEMS: Record<CheatManualOnlySystem, { label: string }> = {
  playstation: {
    label: "PlayStation",
  },
};

/** Rows per page in the add-cheats dialog list. */
export const DIALOG_PAGE_SIZE = 20;

const deliveryCopy = (record: ClassifiedCheatRecord): { badge: string; short: string; text: string } =>
  cheatDelivery(record) === "rom"
    ? { badge: "ROM cheat", short: "ROM", text: "Baked into output" }
    : { badge: "Unsupported", short: "N/A", text: "Cannot be baked into the ROM" };

const CHEAT_KIND_LABELS: Record<NonNullable<ClassifiedCheatRecord["detectedKind"]>, string> = {
  "game-genie": "Game Genie",
  "pro-action-replay": "Action Replay / GameShark",
  xploder: "Xploder",
};

const gameLabel = (game: NonNullable<ReturnType<typeof matchGame>>): string =>
  [game.title, game.regions.join(" / "), game.revisions.join(" / ")].filter(Boolean).join(" · ");

const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type CheatCardProps = {
  record: ClassifiedCheatRecord;
  position: number;
  selected: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onSaveAsPatch?: () => void;
  savingPatch?: boolean;
  canReorder: boolean;
  handleProps: ReturnType<ReturnType<typeof useListReorder>["handleProps"]>;
  rowProps: ReturnType<ReturnType<typeof useListReorder>["rowProps"]>;
};

type CheatOrderEntry = { id: string; position: number };
export type CheatStackRenderState = {
  cards: ClassifiedCheatRecord[];
  controls: ReactNode;
  onOrderChange: (order: CheatOrderEntry[]) => void;
  renderCard: (
    entry: ClassifiedCheatRecord,
    position: number,
    canReorder: boolean,
    handleProps: CheatCardProps["handleProps"],
    rowProps: CheatCardProps["rowProps"],
  ) => ReactNode;
};

const CheatCard = ({
  record,
  position,
  selected,
  onToggle,
  onRemove,
  onSaveAsPatch,
  savingPatch,
  canReorder,
  handleProps,
  rowProps,
}: CheatCardProps) => {
  const delivery = deliveryCopy(record);
  const source = record.record;
  const selectable = isSelectableCheat(record);
  const kind = record.detectedKind ?? source.codeKind;
  return (
    <FileCard
      className={`cheat-card ${rowProps.className || ""}`}
      rootRef={rowProps.rootRef}
      style={rowProps.style}
      handle={
        <button
          {...handleProps}
          aria-label={canReorder ? `Cheat ${position}. Drag or use arrow keys to reorder.` : `Cheat ${position}`}
          className="handle phandle"
          disabled={!canReorder}
          title={canReorder ? "Reorder cheat" : "Cheat position"}
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
          <span className="rb">{delivery.badge}</span>
        </>
      }
      name={<span className="nm">{source.description}</span>}
      menu={
        onSaveAsPatch ? (
          <details className="patch-menu cheat-download-menu">
            <summary aria-label={`Download ${source.description}`} className="rm patch-menu-btn">
              <Download aria-hidden="true" />
            </summary>
            <div className="patch-menu-list">
              <button
                className="patch-menu-item"
                disabled={savingPatch || !selectable}
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  onSaveAsPatch();
                }}
                type="button"
              >
                <Download aria-hidden="true" />
                {savingPatch ? "Creating patch…" : "Save as patch"}
              </button>
            </div>
          </details>
        ) : undefined
      }
      onRemove={onRemove}
      patch
      removeLabel={`Remove ${source.description} from the cheat stack`}
      state="ok"
    >
      <Drawer className="cheat-details" label="Cheat details" labelIcon={<WandSparkles aria-hidden="true" />}>
        {kind ? (
          <div className="ck">
            <span className="ck-k">Type</span>
            <span className="ck-v">{CHEAT_KIND_LABELS[kind]}</span>
          </div>
        ) : null}
        {source.rawCode ? (
          <div className="ck mono">
            <span className="ck-k">Code</span>
            <span className="ck-v">{source.rawCode}</span>
          </div>
        ) : null}
        <div className="ck">
          <span className="ck-k">Source</span>
          <span className="ck-v">{source.sourceFile === "manual" ? "Manual entry" : "Libretro database"}</span>
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
      <button
        aria-expanded={open}
        className="btn ghost manual-cheat-toggle"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Plus aria-hidden="true" />
        Add code manually
      </button>
      {open ? (
        <form onSubmit={submit}>
          <label>
            <span>Description</span>
            <input
              className="input"
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
              className="input mono"
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
            <label htmlFor="rom-weaver-manual-cheat-system">
              <span>System</span>
              <DropdownSelect
                className="select"
                id="rom-weaver-manual-cheat-system"
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
              </DropdownSelect>
            </label>
            <label htmlFor="rom-weaver-manual-cheat-kind">
              <span>Code type</span>
              <DropdownSelect
                className="select"
                id="rom-weaver-manual-cheat-kind"
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
              </DropdownSelect>
            </label>
          </div>
          <div className="manual-cheat-actions">
            <button className="btn primary" disabled={busy || !code.trim()} type="submit">
              {busy ? "Checking code…" : "Check code"}
            </button>
          </div>
          {error ? (
            <p className="manual-cheat-error" role="alert">
              {error}
            </p>
          ) : null}
          {result ? (
            <div className="manual-cheat-result" role="status">
              <p>
                Detected {systems.find(({ value }) => value === result.detectedSystem)?.label ?? result.detectedSystem}{" "}
                · {result.record.detectedKind ? CHEAT_KIND_LABELS[result.record.detectedKind] : result.detectedType}
              </p>
              <p>{deliveryCopy(result.record).text}</p>
              <button
                className="btn primary"
                disabled={!isSelectableCheat(result.record)}
                onClick={() => onAdd(result)}
                type="button"
              >
                Add this cheat
              </button>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
};

type CheatGamePickerProps = {
  platform: string;
  games: CheatSystemShard["games"];
  value: string;
  onChange: (gameId: string) => void;
  /** The chosen game matched by title or by hand, not by checksum. */
  unverified?: boolean;
};

/** Searchable game list for a ROM the cheat database did not match by checksum. */
export const CheatGamePicker = ({ platform, games, value, onChange, unverified }: CheatGamePickerProps) => {
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
  emptyPrompt?: string;
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
  emptyPrompt,
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
                className="input"
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
                    <li className={added ? "cheat-pick is-added" : "cheat-pick"} key={source.id}>
                      <span className="cheat-pick-text">
                        <span className="cheat-pick-name">{source.description}</span>
                        <span className="cheat-pick-badges">
                          {source.rawCode ? <span className="rb mono">{source.rawCode}</span> : null}
                          <span className="rb">{delivery.short}</span>
                        </span>
                      </span>
                      <button
                        aria-label={`${added ? "Remove" : "Add"} ${source.description}`}
                        className={added ? "btn slim cheat-pick-btn is-added" : "btn slim cheat-pick-btn"}
                        disabled={!(added || isSelectableCheat(entry))}
                        onClick={() => (added ? onRemove(entry) : onAdd(entry))}
                        type="button"
                      >
                        {added ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
                        <span className="cheat-pick-btn-label">{added ? "Remove" : "Add"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="cheat-pick-empty" role="status">
                {query ? "No cheats match this search." : (emptyPrompt ?? "No cheats available.")} Add a code manually
                below.
              </p>
            )}
            {records.length ? (
              <div className="cheat-pick-foot">
                <span className="cheat-pick-count">
                  {visible.length} of {countLabel(records.length, "cheat")} · {stackCount} in the stack
                </span>
                <span className="cheat-pager">
                  <button
                    className="btn ghost slim"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                    type="button"
                  >
                    Previous
                  </button>
                  <span className="mono">
                    {currentPage + 1} / {pageCount}
                  </span>
                  <button
                    className="btn ghost slim"
                    disabled={currentPage >= pageCount - 1}
                    onClick={() => setPage(currentPage + 1)}
                    type="button"
                  >
                    Next
                  </button>
                </span>
              </div>
            ) : null}
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
  onSelectionChange?: (records: ClassifiedCheatRecord[], positions?: number[]) => void;
  /**
   * Bake the ROM cheats that are On into a standalone patch and download it.
   * Resolves with the created file name. Absent when the workflow cannot run
   * one (no ROM staged yet). The system is the one the database lookup routed
   * the ROM to, so the caller does not resolve it a second time.
   */
  onSaveAsPatch?: (records: ClassifiedCheatRecord[], system: CheatManualSystem | undefined) => Promise<string>;
  outputSummary?: { rom: number };
  validationMessage?: string;
  positionOffset?: number;
  renderStack?: (stack: CheatStackRenderState) => ReactNode;
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
  positionOffset = 0,
  renderStack,
}: CheatDatabaseSectionProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [savingPatchId, setSavingPatchId] = useState("");
  const savingPatchRef = useRef(false);
  const [patchStatus, setPatchStatus] = useState("");
  const [patchError, setPatchError] = useState("");
  const [databaseQuery, setDatabaseQuery] = useState("");
  // Cards on show. Selection is the subset whose switch is On, so a card can
  // stay in the stack while excluded from the run.
  const [addedIds, setAddedIds] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [manualRecords, setManualRecords] = useState<ClassifiedCheatRecord[]>([]);
  const positionsRef = useRef(new Map<string, number>());
  const selectionCallback = useRef(onSelectionChange);
  const previousGameId = useRef<string | undefined>(undefined);
  selectionCallback.current = onSelectionChange;
  const emitSelection = (entries: ClassifiedCheatRecord[]) => {
    if (renderStack) {
      selectionCallback.current?.(
        entries,
        entries.map(({ record }) => positionsRef.current.get(record.id) ?? positionOffset),
      );
      return;
    }
    selectionCallback.current?.(entries);
  };

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
  const identityKey = rom?.key;
  useEffect(() => {
    if (identityKey === "") return;
    setSelectedIds(new Set());
    setAddedIds(new Set());
    positionsRef.current.clear();
    setManualRecords([]);
    setManualGameId("");
    setManualEntrySlug("");
    setDatabaseQuery("");
    selectionCallback.current?.([]);
  }, [identityKey, setManualEntrySlug, setManualGameId]);

  const match = databaseMatch;
  const gameId = game?.id;
  useEffect(() => {
    if (previousGameId.current && previousGameId.current !== gameId) {
      setSelectedIds(new Set());
      setAddedIds(new Set());
      positionsRef.current.clear();
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
  const reorderList = useListReorder({
    count: cards.length,
    disabled: cards.length < 2,
    onReorder: (from, to) => {
      const nextIds = reorder([...addedIds], from, to);
      setAddedIds(new Set(nextIds));
      emitSelection(nextIds.flatMap((id) => cards.filter(({ record }) => record.id === id && selectedIds.has(id))));
    },
  });

  const publish = (nextSelected: Set<string>, source = records, nextAdded = addedIds) => {
    setSelectedIds(nextSelected);
    emitSelection(
      [...nextAdded].flatMap((id) => source.filter(({ record }) => record.id === id && nextSelected.has(id))),
    );
  };

  const addRecord = (record: ClassifiedCheatRecord) => {
    const id = record.record.id;
    const nextAdded = new Set(addedIds).add(id);
    setAddedIds(nextAdded);
    if (!isSelectableCheat(record)) return;
    publish(new Set(selectedIds).add(id), records, nextAdded);
  };

  const dropRecord = (record: ClassifiedCheatRecord) => {
    const id = record.record.id;
    const nextAdded = new Set(addedIds);
    nextAdded.delete(id);
    setAddedIds(nextAdded);
    if (!selectedIds.has(id)) return;
    const nextSelected = new Set(selectedIds);
    nextSelected.delete(id);
    publish(nextSelected, records, nextAdded);
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
    const nextAdded = new Set(addedIds).add(id);
    setAddedIds(nextAdded);
    const nextSelected = new Set(selectedIds);
    if (isSelectableCheat(result.record)) nextSelected.add(id);
    publish(nextSelected, [...classifiedRecords, ...nextRecords], nextAdded);
  };

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
            className="input"
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
                onClick={() => setManualEntrySlug(candidate.slug)}
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
      <CheatGamePicker
        games={shard.games}
        onChange={setManualGameId}
        platform={entry.platform}
        unverified={match.kind === "title" || match.kind === "manual"}
        value={manualGameId}
      />
    ) : null;

  const status = loading
    ? "Loading this system's cheat database…"
    : classifying
      ? "Checking cheat delivery types in ROMWeaver…"
      : "";
  const loadErrorMessage = loadError
    ? `The cheat database is unavailable. Offline access starts after this system loads once. ${loadError}`
    : "";

  if (!rom) return null;

  const renderCard: CheatStackRenderState["renderCard"] = (entry, position, canReorder, handleProps, rowProps) => (
    <CheatCard
      canReorder={canReorder}
      handleProps={handleProps}
      key={entry.record.id}
      onRemove={() => dropRecord(entry)}
      onToggle={() => toggleRecord(entry)}
      onSaveAsPatch={
        onSaveAsPatch
          ? () => {
              if (savingPatchRef.current) return;
              savingPatchRef.current = true;
              setPatchError("");
              setPatchStatus("");
              setSavingPatchId(entry.record.id);
              void onSaveAsPatch([entry], manualSystem)
                .then((fileName) => setPatchStatus(getCheatPatchStatus(fileName, 1)))
                .catch((reason: unknown) =>
                  setPatchError(reason instanceof Error ? reason.message : "The cheat patch could not be created."),
                )
                .finally(() => {
                  savingPatchRef.current = false;
                  setSavingPatchId("");
                });
            }
          : undefined
      }
      position={position}
      record={entry}
      rowProps={rowProps}
      savingPatch={!!savingPatchId}
      selected={selectedIds.has(entry.record.id)}
    />
  );
  const onOrderChange = (order: CheatOrderEntry[]) => {
    positionsRef.current = new Map(order.map(({ id, position }) => [id, position]));
    const ids = order.map(({ id }) => id);
    setAddedIds((current) => {
      const previous = [...current];
      return previous.length === ids.length && previous.every((id, index) => id === ids[index])
        ? current
        : new Set(ids);
    });
    emitSelection(ids.flatMap((id) => cards.filter(({ record }) => record.id === id && selectedIds.has(id))));
  };
  const controls = (
    <div className="cheat-card-body" id="rom-weaver-row-cheat-stack">
      {cards.length && !renderStack ? (
        <div
          className="cards patch-cards workflow-file-list"
          id="rom-weaver-list-cheat-stack"
          ref={reorderList.containerRef}
        >
          {cards.map((entry, index) =>
            renderCard(
              entry,
              positionOffset + reorderList.displayIndex(index) + 1,
              cards.length > 1,
              reorderList.handleProps(index),
              reorderList.rowProps(index),
            ),
          )}
        </div>
      ) : null}

      {patchStatus ? <p role="status">{patchStatus}</p> : null}

      <button className="needs-input cheat-add" onClick={() => setDialogOpen(true)} type="button">
        <span className="cheat-add-copy">
          <span className="cheat-add-label">
            <WandSparkles aria-hidden="true" />
            Add cheats to the patch order
          </span>
          <small>Choose codes to bake into the ROM at their place in the list.</small>
        </span>
      </button>

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
        emptyPrompt={databasePicker ? "Choose a system above." : gamePicker ? "Choose a game above." : undefined}
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
        gamePicker={
          <>
            {databasePicker}
            {gamePicker}
          </>
        }
        onAdd={addRecord}
        onClose={() => setDialogOpen(false)}
        onRemove={dropRecord}
        open={dialogOpen}
        records={records}
        stackCount={cards.length}
        status={pickerStatus}
        title="Add cheats"
      />
    </div>
  );
  return renderStack ? renderStack({ cards, controls, onOrderChange, renderCard }) : controls;
};
