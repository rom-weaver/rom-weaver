import { Download, Plus, Search, WandSparkles, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { IdentifyCatalog } from "../../../lib/identify/identify-catalog.ts";
import {
  cheatDelivery,
  filterCheats,
  isSelectableCheat,
  type CheatDatabaseClient,
  type CheatDatabaseRecord,
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
import type { Localizer } from "../../../presentation/localization/index.ts";
import { getCheatPatchStatus } from "../cheat-patch-export-model.ts";
import {
  CHEAT_KIND_OPTIONS,
  formatCheatWrite,
  getCheatCodeWrites,
  getCheatCompareLabel,
} from "../create-cheat-codes-model.ts";
import { useUiLocalizer } from "../settings-context.tsx";
import { CheatGameSearch, getCheatGameSearchStep } from "./cheat-game-search.tsx";
import { useCheatDatabaseRecords } from "./use-cheat-database-records.ts";
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

const deliveryCopy = (
  record: ClassifiedCheatRecord,
  localizer: Localizer,
): { badge: string; short: string; text: string } =>
  cheatDelivery(record) === "rom"
    ? {
        badge: localizer.message("ui.cheats.badge.rom"),
        short: localizer.message("ui.step.rom"),
        text: localizer.message("ui.cheats.delivery.rom"),
      }
    : {
        badge: localizer.message("ui.runtime.headerUnsupported"),
        short: localizer.message("ui.cheats.short.unsupported"),
        text: localizer.message("ui.cheats.delivery.unsupported"),
      };

const CHEAT_KIND_LABELS = Object.fromEntries(CHEAT_KIND_OPTIONS.map(({ value, label }) => [value, label])) as Record<
  NonNullable<ClassifiedCheatRecord["detectedKind"]>,
  string
>;

const rawFieldEntries = (record: CheatDatabaseRecord): Array<{ name: string; value: string }> =>
  Array.isArray(record.rawFields)
    ? record.rawFields
    : Object.entries(record.rawFields).map(([name, value]) => ({ name, value }));

const isClassifiedCheat = (record: ClassifiedCheatRecord | CheatDatabaseRecord): record is ClassifiedCheatRecord =>
  "record" in record;

/** Why cheats are off for a ROM whose platform no shard and no decoder covers. */
export const getUnsupportedCheatSystemMessage = (platform: string | undefined, localizer: Localizer): string =>
  platform
    ? localizer.message("ui.cheats.unsupportedSystem", { platform })
    : localizer.message("ui.cheats.unsupportedSystemUnknown");

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
  const localizer = useUiLocalizer();
  const delivery = deliveryCopy(record, localizer);
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
          aria-label={
            canReorder
              ? localizer.message("ui.cheats.positionReorder", { position })
              : localizer.message("ui.cheats.position", { position })
          }
          className="handle phandle"
          disabled={!canReorder}
          title={canReorder ? localizer.message("ui.cheats.reorder") : localizer.message("ui.cheats.positionTitle")}
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
              aria-label={localizer.message("ui.patch.include", { name: source.description })}
              checked={selected}
              disabled={!selectable}
              onChange={onToggle}
              type="checkbox"
            />
            <span aria-hidden="true" className="switch-state">
              <b className="on">{localizer.message("ui.patch.on")}</b>
              <b className="off">{localizer.message("ui.patch.off")}</b>
            </span>
          </label>
          <span className="rb">{delivery.badge}</span>
        </>
      }
      name={<span className="nm">{source.description}</span>}
      menu={
        onSaveAsPatch ? (
          <details className="patch-menu cheat-download-menu">
            <summary
              aria-label={localizer.message("ui.output.downloadFile", { name: source.description })}
              className="rm patch-menu-btn"
            >
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
                {savingPatch
                  ? localizer.message("ui.cheats.creatingPatch")
                  : localizer.message("ui.cheats.saveAsPatch")}
              </button>
            </div>
          </details>
        ) : undefined
      }
      onRemove={onRemove}
      patch
      removeLabel={localizer.message("ui.cheats.removeFromStack", { name: source.description })}
      state="ok"
    >
      <Drawer
        className="cheat-details"
        label={localizer.message("ui.cheats.details")}
        labelIcon={<WandSparkles aria-hidden="true" />}
      >
        {kind ? (
          <div className="ck">
            <span className="ck-k">{localizer.message("ui.output.type")}</span>
            <span className="ck-v">{CHEAT_KIND_LABELS[kind]}</span>
          </div>
        ) : null}
        {source.rawCode ? (
          <div className="ck mono">
            <span className="ck-k">{localizer.message("ui.cheats.code")}</span>
            <span className="ck-v">{source.rawCode}</span>
          </div>
        ) : null}
        <div className="ck">
          <span className="ck-k">{localizer.message("ui.identifyDrawer.source")}</span>
          <span className="ck-v">
            {source.sourceFile === "manual"
              ? localizer.message("ui.cheats.sourceManual")
              : localizer.message("ui.cheats.sourceLibretro")}
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
  const localizer = useUiLocalizer();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState(() => localizer.message("ui.cheats.manualDescription"));
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
    void classifier({
      code: code.trim(),
      description: description.trim() || localizer.message("ui.cheats.manualDescription"),
      system,
      kind,
    })
      .then((nextResult) => {
        if (classificationSequence.current === sequence) setResult(nextResult);
      })
      .catch((reason: unknown) => {
        if (classificationSequence.current === sequence) {
          setError(reason instanceof Error ? reason.message : localizer.message("ui.cheats.classifyFailed"));
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
        {localizer.message("ui.cheats.addManually")}
      </button>
      {open ? (
        <form onSubmit={submit}>
          <label>
            <span>{localizer.message("ui.patch.description")}</span>
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
            <span>{localizer.message("ui.cheats.cheatCode")}</span>
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
              <span>{localizer.message("ui.identifyDrawer.system")}</span>
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
              <span>{localizer.message("ui.cheats.codeType")}</span>
              <DropdownSelect
                className="select"
                id="rom-weaver-manual-cheat-kind"
                onChange={(event) => {
                  setKind(event.target.value as ManualCheatKindOverride);
                  clearClassification();
                }}
                value={kind}
              >
                <option value="auto">{localizer.message("ui.cheats.detectAuto")}</option>
                {CHEAT_KIND_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </DropdownSelect>
            </label>
          </div>
          <div className="manual-cheat-actions">
            <button className="btn primary" disabled={busy || !code.trim()} type="submit">
              {busy ? localizer.message("ui.cheats.checkingCode") : localizer.message("ui.cheats.checkCode")}
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
                {localizer.message("ui.cheats.detected", {
                  system: systems.find(({ value }) => value === result.detectedSystem)?.label ?? result.detectedSystem,
                  type: result.record.detectedKind
                    ? CHEAT_KIND_LABELS[result.record.detectedKind]
                    : result.detectedType,
                })}
              </p>
              <p>{deliveryCopy(result.record, localizer).text}</p>
              <button
                className="btn primary"
                disabled={!isSelectableCheat(result.record)}
                onClick={() => onAdd(result)}
                type="button"
              >
                {localizer.message("ui.cheats.addThis")}
              </button>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
};

const CheatCodeDetails = ({ entry }: { entry: ClassifiedCheatRecord | CheatDatabaseRecord }) => {
  const localizer = useUiLocalizer();
  if (isClassifiedCheat(entry)) {
    const kind = entry.detectedKind ?? entry.record.codeKind;
    return (
      <dl>
        {kind ? (
          <div>
            <dt>{localizer.message("ui.output.type")}</dt>
            <dd>{CHEAT_KIND_LABELS[kind]}</dd>
          </div>
        ) : null}
        {getCheatCodeWrites(entry).map((write) => {
          const compareLabel = getCheatCompareLabel(write, localizer);
          return (
            <div key={`${write.offset}:${write.value}`}>
              <dt>{localizer.message("ui.cheats.write")}</dt>
              <dd className="mono">
                {formatCheatWrite(write)}
                {compareLabel ? ` · ${compareLabel}` : ""}
              </dd>
            </div>
          );
        })}
        {entry.resolution.type === "unsupported" ? (
          <div>
            <dt>{localizer.message("ui.cheats.support")}</dt>
            <dd>{entry.resolution.reason}</dd>
          </div>
        ) : null}
      </dl>
    );
  }
  return (
    <>
      <dl>
        {entry.codeKind ? (
          <div>
            <dt>{localizer.message("ui.output.type")}</dt>
            <dd>{CHEAT_KIND_LABELS[entry.codeKind]}</dd>
          </div>
        ) : null}
        {rawFieldEntries(entry).map(({ name, value }) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd className="mono">{value}</dd>
          </div>
        ))}
      </dl>
      {entry.importWarnings?.length ? (
        <div className="cheat-import-warnings" role="note">
          <strong>{localizer.message("ui.cheats.importWarnings")}</strong>
          <ul>
            {entry.importWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
};

type AddCheatsDialogCommonProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  addedIds: ReadonlySet<string>;
  stackCount: number;
  /** Replaces the list while the shard loads or classifies, or when either failed. */
  status?: { text: string; error?: boolean };
  gamePicker?: ReactNode;
  emptyPrompt?: string;
  extras?: ReactNode;
  manualEntry?: ManualCodeFormProps;
};

type AddCheatsDialogProps = AddCheatsDialogCommonProps &
  (
    | {
        inspection: true;
        records: CheatDatabaseRecord[];
      }
    | {
        inspection?: false;
        records: ClassifiedCheatRecord[];
        onAdd: (record: ClassifiedCheatRecord) => void;
        onRemove: (record: ClassifiedCheatRecord) => void;
      }
  );

/**
 * The cheat picker: one paginated page of the game's cheats at a time, filtered
 * by description or raw code, with the manual-code entry point below the list.
 * Rows added here become cards in the step.
 */
export const AddCheatsDialog = (props: AddCheatsDialogProps) => {
  const { open, onClose, title, addedIds, stackCount, status, gamePicker, emptyPrompt, extras, manualEntry } = props;
  const localizer = useUiLocalizer();
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

  const visible = useMemo(() => {
    if (!props.inspection) return filterCheats(props.records, query);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return props.records;
    return props.records.filter((source) =>
      `${source.description}\n${source.rawCode || ""}`.toLocaleLowerCase().includes(needle),
    );
  }, [props.inspection, props.records, query]);
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
            <button
              aria-label={localizer.message("ui.common.close")}
              className="dlg-x"
              onClick={onClose}
              title={localizer.message("ui.common.close")}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="dlg-body">
            {gamePicker}
            <label className="cheat-search">
              <span className="sr-only">{localizer.message("ui.cheats.search")}</span>
              <Search aria-hidden="true" />
              <input
                className="input"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                placeholder={localizer.message("ui.cheats.searchPlaceholder")}
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
                  const source = isClassifiedCheat(entry) ? entry.record : entry;
                  const classified = isClassifiedCheat(entry) ? entry : null;
                  const delivery = classified ? deliveryCopy(classified, localizer) : null;
                  const added = addedIds.has(source.id);
                  return (
                    <li className={added ? "cheat-pick is-added" : "cheat-pick"} key={source.id}>
                      <div className="cheat-pick-text">
                        <span className="cheat-pick-name">{source.description}</span>
                        <span className="cheat-pick-badges">
                          {source.rawCode ? <span className="rb mono">{source.rawCode}</span> : null}
                          {delivery ? <span className="rb">{delivery.short}</span> : null}
                        </span>
                        <details className="cheat-inspection-details">
                          <summary>{localizer.message("ui.cheats.codeDetails")}</summary>
                          <CheatCodeDetails entry={entry} />
                        </details>
                      </div>
                      {!props.inspection && classified ? (
                        <button
                          aria-label={localizer.message(added ? "ui.compress.removeFile" : "ui.cheats.addNamed", {
                            name: source.description,
                          })}
                          className={added ? "btn slim cheat-pick-btn is-added" : "btn slim cheat-pick-btn"}
                          disabled={!(added || isSelectableCheat(classified))}
                          onClick={() => (added ? props.onRemove(classified) : props.onAdd(classified))}
                          type="button"
                        >
                          {added ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
                          <span className="cheat-pick-btn-label">
                            {added
                              ? localizer.message("ui.common.remove")
                              : localizer.message("ui.patch.addCheckLabel")}
                          </span>
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="cheat-pick-empty" role="status">
                {query
                  ? localizer.message("ui.cheats.noMatch")
                  : (emptyPrompt ?? localizer.message("ui.cheats.noneAvailable"))}
                {props.inspection ? "" : ` ${localizer.message("ui.cheats.addManuallyBelow")}`}
              </p>
            )}
            {props.records.length ? (
              <div className="cheat-pick-foot">
                <span className="cheat-pick-count">
                  {localizer.messageCount("ui.cheats.visibleOfTotal", props.records.length, {
                    visible: visible.length,
                  })}
                  {props.inspection ? "" : ` · ${localizer.message("ui.cheats.inStack", { count: stackCount })}`}
                </span>
                <span className="cheat-pager">
                  <button
                    className="btn ghost slim"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                    type="button"
                  >
                    {localizer.message("ui.cheats.previous")}
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
                    {localizer.message("ui.cheats.next")}
                  </button>
                </span>
              </div>
            ) : null}
            {extras}
            {manualEntry ? <ManualCodeForm {...manualEntry} /> : null}
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
  const localizer = useUiLocalizer();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [savingPatchId, setSavingPatchId] = useState("");
  const savingPatchRef = useRef(false);
  const [patchStatus, setPatchStatus] = useState("");
  const [patchError, setPatchError] = useState("");
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

  const database = useCheatDatabaseRecords({
    ...(catalog ? { catalog } : {}),
    classifyDatabaseCheats,
    ...(suppliedClient ? { client: suppliedClient } : {}),
    ...(index ? { index } : {}),
    rom,
    ...(suppliedShard ? { shard: suppliedShard } : {}),
  });
  const {
    activeIndex,
    classificationError,
    classifying,
    game,
    loadError,
    loading,
    manualSystem,
    records: classifiedRecords,
    setManualGameId,
    setManualEntrySlug,
    unsupportedSystem,
  } = database;
  const identityKey = rom?.key;
  useEffect(() => {
    if (identityKey === "") return;
    setSelectedIds(new Set());
    setAddedIds(new Set());
    positionsRef.current.clear();
    setManualRecords([]);
    setManualGameId("");
    setManualEntrySlug("");
    selectionCallback.current?.([]);
  }, [identityKey, setManualEntrySlug, setManualGameId]);

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
    ? { error: true, text: localizer.message("ui.cheats.unavailable", { error: loadError }) }
    : classificationError
      ? { error: true, text: classificationError }
      : loading
        ? { text: localizer.message("ui.cheats.loading") }
        : classifying
          ? { text: localizer.message("ui.cheats.classifying") }
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

  const searchInput = { database, rom };
  const searchStep = getCheatGameSearchStep(searchInput);

  const status = loading
    ? localizer.message("ui.cheats.loading")
    : classifying
      ? localizer.message("ui.cheats.classifying")
      : "";
  const loadErrorMessage = loadError ? localizer.message("ui.cheats.unavailableOffline", { error: loadError }) : "";

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
                .then((fileName) => setPatchStatus(getCheatPatchStatus(fileName, 1, localizer)))
                .catch((reason: unknown) =>
                  setPatchError(reason instanceof Error ? reason.message : localizer.message("ui.cheats.patchFailed")),
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

      <button
        className="needs-input cheat-add"
        disabled={unsupportedSystem}
        onClick={() => setDialogOpen(true)}
        type="button"
      >
        <span className="cheat-add-copy">
          <span className="cheat-add-label">
            <WandSparkles aria-hidden="true" />
            {localizer.message("ui.apply.tutorial.addCheats")}
          </span>
          <small>
            {unsupportedSystem
              ? getUnsupportedCheatSystemMessage(rom.platform, localizer)
              : localizer.message("ui.cheats.chooseCodes")}
          </small>
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
          <p>{localizer.messageCount("ui.cheats.outputSummary", outputSummary.rom)}</p>
        </div>
      ) : null}

      <AddCheatsDialog
        addedIds={addedIds}
        emptyPrompt={searchStep ? localizer.message(`ui.cheats.choose.${searchStep}`) : undefined}
        gamePicker={
          <>
            {game ? <p className="cheat-pick-empty">{game.title}</p> : null}
            <CheatGameSearch {...searchInput} />
          </>
        }
        manualEntry={
          manualSystem
            ? {
                classifier: classifyManualCode,
                defaultSystem: manualSystem,
                onAdd: addManualRecord,
                systems,
              }
            : undefined
        }
        onAdd={addRecord}
        onClose={() => setDialogOpen(false)}
        onRemove={dropRecord}
        open={dialogOpen}
        records={records}
        stackCount={cards.length}
        status={pickerStatus}
        title={localizer.message("ui.home.goCheats")}
      />
    </div>
  );
  return renderStack ? renderStack({ cards, controls, onOrderChange, renderCard }) : controls;
};
