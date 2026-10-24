import { WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CheatDatabaseIndex,
  CheatManualSystem,
  CheatRomIdentity,
  CheatSystemShard,
  ClassifiedCheatRecord,
  DatabaseCheatClassifier,
  ManualCheatClassifier,
  ManualCheatKindOverride,
} from "../../../lib/cheats/index.ts";
import {
  CHEAT_KIND_OPTIONS,
  describeCheatCodes,
  formatCheatWrite,
  getCheatCodeWrites,
  getCheatCompareLabel,
  getClassifiedCheatCodes,
  splitPlainCheatCodes,
  type CreateCheatCodeEntry,
} from "../create-cheat-codes-model.ts";
import { useUiLocalizer } from "../settings-context.tsx";
import { AddCheatsDialog } from "./cheat-database-section.tsx";
import { CheatGameSearch, getCheatGameSearchStep } from "./cheat-game-search.tsx";
import { FileCard } from "./ds/file-card.tsx";
import { DropdownSelect } from "./ds/dropdown-select.tsx";
import { useCheatDatabaseRecords } from "./use-cheat-database-records.ts";
import "./create-cheat-codes-panel.css";

type CreateCheatCodesPanelProps = {
  /** Identity of the original ROM: it supplies the system and the database match. */
  rom: CheatRomIdentity | null;
  /** Supplied by tests and galleries in place of the fetched database index. */
  index?: CheatDatabaseIndex;
  /** Supplied by tests and galleries in place of the fetched database shard. */
  shard?: CheatSystemShard;
  classifyManualCode: ManualCheatClassifier;
  classifyDatabaseCheats: DatabaseCheatClassifier;
  disabled?: boolean;
  /** The raw textarea contents, owned by the create form. */
  value: string;
  kind: ManualCheatKindOverride;
  onValueChange: (value: string) => void;
  onKindChange: (kind: ManualCheatKindOverride) => void;
  /** Reports every split code with whatever the classifier said about it. */
  onEntriesChange: (entries: CreateCheatCodeEntry[]) => void;
  /** Reports whether a classification pass is still in flight. */
  onClassifyingChange: (classifying: boolean) => void;
  /** Reports the cheat system the ROM resolved to, so the run can send it. */
  onSystemChange: (system: CheatManualSystem | undefined) => void;
};

/** Waits for typing to pause before asking the engine to split and classify. */
const SPLIT_DEBOUNCE_MS = 200;

/**
 * A database row's `rawCode` can hold several codes at once ("A+B"), so every
 * membership test works on that row's split codes rather than the whole string.
 * Otherwise a multi-code row is never recognized as staged, and both the picker
 * and the description lookup miss it. The engine splits them; this reads its
 * answer.
 */
const recordCodes = getClassifiedCheatCodes;

/** Codes the picker adds are appended to the textarea. */
const appendCodes = (value: string, typedCodes: readonly string[], codes: readonly string[]): string => {
  const existing = new Set(typedCodes.map((code) => code.toUpperCase()));
  const added: string[] = [];
  for (const code of codes) {
    const normalized = code.toUpperCase();
    if (!code || existing.has(normalized)) continue;
    existing.add(normalized);
    added.push(code);
  }
  if (!added.length) return value;
  const separator = value.trim() ? "\n" : "";
  return `${value.trimEnd()}${separator}${added.join("\n")}`;
};

/**
 * The 0x03 step body in cheat-codes mode: a codes textarea, the classifier's
 * reading of those codes, one row per code showing the ROM writes it resolved
 * to, and the cheat database picker for adding codes without typing them.
 */
const CreateCheatCodesPanel = ({
  rom,
  index,
  shard: suppliedShard,
  classifyManualCode,
  classifyDatabaseCheats,
  disabled,
  value,
  kind,
  onValueChange,
  onKindChange,
  onEntriesChange,
  onClassifyingChange,
  onSystemChange,
}: CreateCheatCodesPanelProps) => {
  const localizer = useUiLocalizer();
  const [entries, setEntries] = useState<CreateCheatCodeEntry[]>([]);
  // The textarea's codes as the engine last split them (with the text they came from);
  // entries mirror them one to one.
  const [engineSplit, setEngineSplit] = useState<{ codes: string[]; value: string }>({ codes: [], value: "" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [kindConflict, setKindConflict] = useState("");
  // Only the newest classification pass may write state; a slower earlier pass
  // would otherwise restore the reading of a code the user already replaced.
  const classifySequence = useRef(0);
  const reportEntries = useRef(onEntriesChange);
  const reportClassifying = useRef(onClassifyingChange);
  const reportSystem = useRef(onSystemChange);
  reportEntries.current = onEntriesChange;
  reportClassifying.current = onClassifyingChange;
  reportSystem.current = onSystemChange;

  const database = useCheatDatabaseRecords({
    classifyDatabaseCheats,
    ...(index ? { index } : {}),
    rom,
    ...(suppliedShard ? { shard: suppliedShard } : {}),
  });
  const { classificationError, game, loadError, manualSystem, records } = database;

  useEffect(() => {
    reportSystem.current(manualSystem);
  }, [manualSystem]);

  useEffect(() => {
    const plainCodes = splitPlainCheatCodes(value);
    const sequence = ++classifySequence.current;
    if (!plainCodes.length) {
      setEngineSplit({ codes: [], value });
      setEntries([]);
      reportEntries.current([]);
      reportClassifying.current(false);
      return;
    }
    if (!manualSystem) {
      // No ROM means no system and no WASM run, so the engine cannot split yet.
      const pending = plainCodes.map((code, index) => ({
        code,
        description: "",
        error: localizer.message("ui.cheats.needRom"),
        id: `${index}:${code}`,
      }));
      setEngineSplit({ codes: plainCodes, value });
      setEntries(pending);
      reportEntries.current(pending);
      reportClassifying.current(false);
      return;
    }
    reportClassifying.current(true);
    const classifyOne = async (code: string, index: number): Promise<CreateCheatCodeEntry> => {
      const id = `${index}:${code}`;
      const description =
        records.find((entry) => recordCodes(entry).some((entryCode) => entryCode.toUpperCase() === code.toUpperCase()))
          ?.record.description || "";
      try {
        const result = await classifyManualCode({
          code,
          description: description || code,
          kind,
          system: manualSystem as CheatManualSystem,
        });
        return { code, description, id, record: result.record };
      } catch (reason) {
        return {
          code,
          description,
          error: reason instanceof Error ? reason.message : localizer.message("ui.cheats.classifyFailed"),
          id,
        };
      }
    };
    const timer = setTimeout(() => {
      void (async () => {
        // The engine splits the whole block: it alone knows the Xploder and GBA pairing rules.
        const codes = await classifyManualCode({
          code: value,
          description: "",
          kind,
          system: manualSystem as CheatManualSystem,
        })
          .then((block) => getClassifiedCheatCodes(block.record))
          .catch(() => plainCodes);
        if (classifySequence.current !== sequence) return;
        const nextEntries = await Promise.all(codes.map(classifyOne));
        if (classifySequence.current !== sequence) return;
        setEngineSplit({ codes, value });
        setEntries(nextEntries);
        reportEntries.current(nextEntries);
        reportClassifying.current(false);
      })();
    }, SPLIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [classifyManualCode, kind, localizer, manualSystem, records, value]);

  // Leaving mid-split must not strand the parent's classifying flag at true.
  useEffect(
    () => () => {
      classifySequence.current += 1;
      reportClassifying.current(false);
    },
    [],
  );

  // While the engine is still splitting freshly typed text, the plain split stands in
  // so membership checks do not flicker.
  const splitSettled = engineSplit.value === value;
  const typedCodes = splitSettled ? engineSplit.codes : splitPlainCheatCodes(value);
  const detected = describeCheatCodes(entries, localizer);
  // The picker keys "added" by record id, so map the codes in the textarea back
  // onto the database rows that carry them.
  // A row counts as added only once every code it carries is in the textarea.
  const stagedCodes = new Set(typedCodes.map((code) => code.toUpperCase()));
  const addedIds = new Set(
    records
      .filter((entry) => {
        const codes = recordCodes(entry);
        return codes.length > 0 && codes.every((code) => stagedCodes.has(code.toUpperCase()));
      })
      .map((entry) => entry.record.id),
  );
  const gameTitle = game?.title || rom?.title || "";
  const searchStep = getCheatGameSearchStep({ alwaysBrowseGames: true, database, rom });

  // Entries mirror the split codes one to one, so the position picks out the
  // card's own code even when the same code is typed twice.
  // Until the engine split settles, card positions and the plain-split codes can disagree
  // (Xploder and GBA pairs), so edits wait for the settled split.
  const removeCode = (position: number) => {
    if (!splitSettled) return;
    onValueChange(typedCodes.filter((_code, index) => index !== position).join("\n"));
  };

  const addPickedRecord = (record: ClassifiedCheatRecord) => {
    if (!splitSettled) return;
    const recordKind = record.record.codeKind ?? record.detectedKind ?? undefined;
    const autoEntriesMatch =
      kind === "auto" && entries.length > 0 && entries.every((entry) => entry.record?.detectedKind === recordKind);
    if (recordKind && value.trim() && kind !== recordKind && !autoEntriesMatch) {
      setKindConflict(localizer.message("ui.cheats.kindConflict"));
      return;
    }
    setKindConflict("");
    if (recordKind && kind !== recordKind) onKindChange(recordKind);
    onValueChange(appendCodes(value, typedCodes, recordCodes(record)));
  };

  const manualSystems = [
    ...(database.activeIndex?.entries ?? []).map((entry) => ({
      label: entry.platform,
      value: entry.cheatSystem as CheatManualSystem,
    })),
    ...(manualSystem && !(database.activeIndex?.entries ?? []).some((entry) => entry.cheatSystem === manualSystem)
      ? [{ label: manualSystem === "playstation" ? "PlayStation" : manualSystem, value: manualSystem }]
      : []),
  ];

  return (
    <div className="create-cheat-codes">
      {detected ? (
        <p className="create-cheat-codes-detected" role="status">
          {detected}
        </p>
      ) : null}
      {entries.length ? (
        <div className="cards workflow-file-list create-cheat-codes-list">
          {entries.map((entry, position) => {
            const writes = getCheatCodeWrites(entry.record);
            const blocked =
              entry.error || (entry.record?.resolution.type === "unsupported" ? entry.record.resolution.reason : "");
            return (
              <FileCard
                className="cheat-card create-cheat-code"
                description={
                  writes.length ? null : (
                    <span className="create-cheat-code-blocked">
                      {blocked || localizer.message("ui.cheats.checking")}
                    </span>
                  )
                }
                key={entry.id}
                meta={
                  <>
                    {entry.description ? <span className="rb mono">{entry.code}</span> : null}
                    {writes.flatMap((write) => {
                      const key = `${write.offset}:${write.value}`;
                      const compareLabel = getCheatCompareLabel(write, localizer);
                      return [
                        <span className="rb mono" key={key}>
                          {formatCheatWrite(write)}
                        </span>,
                        ...(compareLabel
                          ? [
                              <span className="rb mono" key={`${key}:compare`}>
                                {compareLabel}
                              </span>,
                            ]
                          : []),
                      ];
                    })}
                  </>
                }
                name={<span className={entry.description ? "nm" : "nm mono"}>{entry.description || entry.code}</span>}
                onRemove={disabled ? undefined : () => removeCode(position)}
                removeLabel={localizer.message("ui.cheats.removeCode", { code: entry.code })}
                {...(writes.length ? { state: "ok" as const } : blocked ? { state: "warn" as const } : {})}
              />
            );
          })}
        </div>
      ) : null}

      <button className="needs-input cheat-add" disabled={disabled} onClick={() => setDialogOpen(true)} type="button">
        <span className="cheat-add-copy">
          <span className="cheat-add-label">
            <WandSparkles aria-hidden="true" />
            {localizer.message("ui.create.tutorial.pickCheats")}
          </span>
          <small>{localizer.message("ui.cheats.pickHint")}</small>
        </span>
      </button>

      <label className="create-cheat-codes-input" htmlFor="rom-weaver-create-cheat-kind">
        <span>{localizer.message("ui.cheats.codeType")}</span>
        <DropdownSelect
          className="select"
          disabled={disabled}
          id="rom-weaver-create-cheat-kind"
          onChange={(event) => {
            setKindConflict("");
            onKindChange(event.target.value as ManualCheatKindOverride);
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
      <label className="create-cheat-codes-input">
        <span>{localizer.message("ui.cheats.typeCodes")}</span>
        <textarea
          autoCapitalize="characters"
          className="input mono"
          disabled={disabled}
          maxLength={8192}
          onChange={(event) => {
            setKindConflict("");
            onValueChange(event.target.value);
          }}
          placeholder={localizer.message("ui.cheats.codesPlaceholder")}
          rows={3}
          spellCheck={false}
          value={value}
        />
      </label>
      {classificationError ? <p role="alert">{classificationError}</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}
      {kindConflict ? <p role="alert">{kindConflict}</p> : null}

      <AddCheatsDialog
        addedIds={addedIds}
        emptyPrompt={searchStep ? localizer.message(`ui.cheats.choose.${searchStep}`) : undefined}
        gamePicker={<CheatGameSearch alwaysBrowseGames database={database} rom={rom} />}
        manualEntry={
          manualSystem
            ? {
                classifier: classifyManualCode,
                defaultSystem: manualSystem,
                onAdd: (result) => addPickedRecord(result.record),
                systems: manualSystems.filter(({ value }) => value === manualSystem),
              }
            : undefined
        }
        onAdd={addPickedRecord}
        onClose={() => setDialogOpen(false)}
        onRemove={(record) => {
          if (!splitSettled) return;
          const dropped = new Set(recordCodes(record).map((code) => code.toUpperCase()));
          onValueChange(typedCodes.filter((code) => !dropped.has(code.toUpperCase())).join("\n"));
        }}
        open={dialogOpen}
        records={records}
        stackCount={entries.length}
        title={
          gameTitle
            ? localizer.message("ui.cheats.addTitleGame", { title: gameTitle })
            : localizer.message("ui.home.goCheats")
        }
      />
    </div>
  );
};

export { CreateCheatCodesPanel };
