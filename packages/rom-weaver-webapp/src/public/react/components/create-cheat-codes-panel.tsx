import { Search } from "lucide-react";
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
import { AddCheatsDialog, gameLabel } from "./cheat-database-section.tsx";
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

/** Codes the picker and the import path add are appended to the textarea. */
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

  const {
    activeIndex,
    classificationError,
    entry: databaseEntry,
    game,
    loadError,
    manualGameId,
    manualSystem,
    records,
    setManualGameId,
    shard,
  } = useCheatDatabaseRecords({
    classifyDatabaseCheats,
    ...(index ? { index } : {}),
    rom,
    ...(suppliedShard ? { shard: suppliedShard } : {}),
  });

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

  const gamePicker =
    rom && databaseEntry && shard ? (
      <label className="cheat-game-picker">
        <span>Browse games for {databaseEntry.platform}</span>
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
    <div className="create-cheat-codes">
      <label className="create-cheat-codes-input">
        <span>Cheat codes</span>
        <textarea
          autoCapitalize="characters"
          disabled={disabled}
          maxLength={8192}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder="one per line or joined with +"
          rows={4}
          spellCheck={false}
          value={value}
        />
      </label>
      {detected ? (
        <p className="create-cheat-codes-detected" role="status">
          {detected}
        </p>
      ) : null}
      {entries.length ? (
        <ul className="create-cheat-codes-list">
          {entries.map((entry) => {
            const writes = getCheatCodeWrites(entry.record);
            return (
              <li className="create-cheat-code" key={entry.id}>
                <span className="mono create-cheat-code-raw">{entry.code}</span>
                {writes.length ? (
                  <span className="create-cheat-code-writes">
                    {writes.map((write) => (
                      <span className="create-cheat-code-write" key={`${write.offset}:${write.value}`}>
                        <span className="mono">{formatCheatWrite(write)}</span>
                        {getCheatCompareLabel(write) ? (
                          <span className="rb mono">{getCheatCompareLabel(write)}</span>
                        ) : null}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="create-cheat-code-blocked">
                    {entry.error ||
                      (entry.record?.resolution.type === "unsupported" ? entry.record.resolution.reason : "Checking…")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      <button className="needs-input cheat-add" disabled={disabled} onClick={() => setDialogOpen(true)} type="button">
        <Search aria-hidden="true" />
        <span>Pick from the cheat database</span>
      </button>
      {classificationError ? <p role="alert">{classificationError}</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}

      <AddCheatsDialog
        addedIds={addedIds}
        gamePicker={gamePicker}
        notices={
          <aside className="cheat-notices">
            <p>Community cheat data can contain errors. A checksum match does not prove that each cheat works.</p>
            {activeIndex ? (
              <p>
                Database: {activeIndex.sourceUrl} at {activeIndex.sourceRevision} · {activeIndex.license}
              </p>
            ) : null}
          </aside>
        }
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
