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
} from "../../../lib/cheats/index.ts";
import {
  describeCheatCodes,
  formatCheatWrite,
  getCheatCodeWrites,
  getCheatCompareLabel,
  splitCheatCodes,
  type CreateCheatCodeEntry,
} from "../create-cheat-codes-model.ts";
import { AddCheatsDialog } from "./cheat-database-section.tsx";
import { CheatGameSearch, getCheatGameSearchStep } from "./cheat-game-search.tsx";
import { FileCard } from "./ds/file-card.tsx";
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
  onValueChange: (value: string) => void;
  /** Reports every split code with whatever the classifier said about it. */
  onEntriesChange: (entries: CreateCheatCodeEntry[]) => void;
  /** Reports whether a classification pass is still in flight. */
  onClassifyingChange: (classifying: boolean) => void;
  /** Reports the cheat system the ROM resolved to, so the run can send it. */
  onSystemChange: (system: CheatManualSystem | undefined) => void;
};

/**
 * A database row's `rawCode` can hold several codes at once ("A+B"), so every
 * membership test works on that row's split codes rather than the whole string.
 * Otherwise a multi-code row is never recognized as staged, and both the picker
 * and the description lookup miss it.
 */
const recordCodes = (record: ClassifiedCheatRecord, system?: string): string[] =>
  splitCheatCodes(record.record.rawCode || "", system);

/** Codes the picker adds are appended to the textarea. */
const appendCodes = (value: string, codes: readonly string[], system?: string): string => {
  const existing = new Set(splitCheatCodes(value, system).map((code) => code.toUpperCase()));
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
  onValueChange,
  onEntriesChange,
  onClassifyingChange,
  onSystemChange,
}: CreateCheatCodesPanelProps) => {
  const [entries, setEntries] = useState<CreateCheatCodeEntry[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
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
    const codes = splitCheatCodes(value, manualSystem);
    const sequence = ++classifySequence.current;
    if (!codes.length) {
      setEntries([]);
      reportEntries.current([]);
      reportClassifying.current(false);
      return;
    }
    if (!manualSystem) {
      const pending = codes.map((code, index) => ({
        code,
        description: "",
        error: "Select an original ROM whose system supports cheat codes.",
        id: `${index}:${code}`,
      }));
      setEntries(pending);
      reportEntries.current(pending);
      reportClassifying.current(false);
      return;
    }
    reportClassifying.current(true);
    void Promise.all(
      codes.map(async (code, index): Promise<CreateCheatCodeEntry> => {
        const id = `${index}:${code}`;
        const description =
          records.find((entry) =>
            recordCodes(entry, manualSystem).some((entryCode) => entryCode.toUpperCase() === code.toUpperCase()),
          )?.record.description || "";
        try {
          const result = await classifyManualCode({
            code,
            description: description || code,
            kind: "auto",
            system: manualSystem as CheatManualSystem,
          });
          return { code, description, id, record: result.record };
        } catch (reason) {
          return {
            code,
            description,
            error: reason instanceof Error ? reason.message : "The code could not be classified.",
            id,
          };
        }
      }),
    ).then((nextEntries) => {
      if (classifySequence.current !== sequence) return;
      setEntries(nextEntries);
      reportEntries.current(nextEntries);
      reportClassifying.current(false);
    });
  }, [classifyManualCode, manualSystem, records, value]);

  const detected = describeCheatCodes(entries);
  // The picker keys "added" by record id, so map the codes in the textarea back
  // onto the database rows that carry them.
  // A row counts as added only once every code it carries is in the textarea.
  const stagedCodes = new Set(splitCheatCodes(value, manualSystem).map((code) => code.toUpperCase()));
  const addedIds = new Set(
    records
      .filter((entry) => {
        const codes = recordCodes(entry, manualSystem);
        return codes.length > 0 && codes.every((code) => stagedCodes.has(code.toUpperCase()));
      })
      .map((entry) => entry.record.id),
  );
  const gameTitle = game?.title || rom?.title || "";
  const searchStep = getCheatGameSearchStep({ alwaysBrowseGames: true, database, rom });

  // Entries mirror the split codes one to one, so the position picks out the
  // card's own code even when the same code is typed twice.
  const removeCode = (position: number) => {
    onValueChange(
      splitCheatCodes(value, manualSystem)
        .filter((_code, index) => index !== position)
        .join("\n"),
    );
  };

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
                  writes.length ? null : <span className="create-cheat-code-blocked">{blocked || "Checking…"}</span>
                }
                key={entry.id}
                meta={
                  <>
                    {entry.description ? <span className="rb mono">{entry.code}</span> : null}
                    {writes.flatMap((write) => {
                      const key = `${write.offset}:${write.value}`;
                      const compareLabel = getCheatCompareLabel(write);
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
                removeLabel={`Remove code ${entry.code}`}
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
            Pick from the cheat database
          </span>
          <small>Choose codes for this game, or type your own below.</small>
        </span>
      </button>

      <label className="create-cheat-codes-input">
        <span>Type codes</span>
        <textarea
          autoCapitalize="characters"
          className="input mono"
          disabled={disabled}
          maxLength={8192}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder="One per line or joined with +"
          rows={3}
          spellCheck={false}
          value={value}
        />
      </label>
      {classificationError ? <p role="alert">{classificationError}</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}

      <AddCheatsDialog
        addedIds={addedIds}
        emptyPrompt={searchStep ? `Choose a ${searchStep} above.` : undefined}
        gamePicker={<CheatGameSearch alwaysBrowseGames database={database} rom={rom} />}
        onAdd={(record) => onValueChange(appendCodes(value, recordCodes(record, manualSystem), manualSystem))}
        onClose={() => setDialogOpen(false)}
        onRemove={(record) => {
          const dropped = new Set(recordCodes(record, manualSystem).map((code) => code.toUpperCase()));
          onValueChange(
            splitCheatCodes(value, manualSystem)
              .filter((code) => !dropped.has(code.toUpperCase()))
              .join("\n"),
          );
        }}
        open={dialogOpen}
        records={records}
        stackCount={entries.length}
        title={gameTitle ? `Add cheats · ${gameTitle}` : "Add cheats"}
      />
    </div>
  );
};

export { CreateCheatCodesPanel };
