import { Download, FileJson2, Gamepad2, RotateCcw, Save, Search, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  clearPendingTestSave,
  listEmulatorSaves,
  replaceEmulatorSaveSram,
  setEmulatorSavePreview,
  stagePendingTestSave,
  type EmulatorSaveRecord,
} from "../../storage/browser/emulator-saves.ts";
import { readRuntimeOutputBlob } from "../../storage/vfs/runtime-output.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import {
  saveValueFromText,
  saveValueToText,
  type SaveCandidate,
  type SaveDocument,
  type SaveField,
  type SavePreview,
  type SaveRecognition,
  type SaveValue,
} from "../../lib/runtime/save-editor-result.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { join } from "../../public/react/components/ds/cx.ts";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { StepSection } from "../../public/react/components/ds/layout.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { getEmulatorJsCore } from "../../public/react/components/emulatorjs.ts";
import { restartCurrentGameWithSave, useEmulatorSession } from "../../public/react/emulator-session-store.ts";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import { SaveGenerator } from "./save-generator.tsx";

type SaveEditorProps = {
  onSessionChange: (active: boolean) => void;
  onSelectTab?: (tab: string) => void;
  pageDrop?: PageFileDrop | null;
};
type FieldErrors = Record<string, string>;
type FieldGroup = { id: string; title: string; fields: SaveField[] };
type FieldSlot = { id: string; title: string; groups: FieldGroup[] };

const SAVE_SUPPORTED_FILES = [
  { extensions: ["sav", "srm", "eep", "fla", "mpk", "mcr", "mcd"], label: "Raw game saves" },
  { extensions: ["sps", "xps", "gsv"], label: "GameShark SP wrappers" },
  { extensions: ["dsv", "gme", "mem", "vgs"], label: "Emulator and memory card wrappers" },
] as const;
const SAVE_ACCEPT = `${SAVE_SUPPORTED_FILES.flatMap((group) => group.extensions.map((extension) => `.${extension}`)).join(",")},application/octet-stream`;
const GHOST_STEPS = [
  { num: "0x02", title: "Fields" },
  { num: "0x03", title: "Write" },
] as const;
/* Titles for the id segments the Rust handlers emit; anything else is capitalized. */
const GROUP_TITLES: Record<string, string> = {
  equipment: "Equipment",
  hearts: "Health",
  inventory: "Inventory",
  player: "Player",
  progress: "Progress",
  resources: "Resources",
  trainer: "Trainer",
};
const INTEGRITY_STATE: Record<string, { state: "ok" | "warn" | "bad"; label: string }> = {
  invalid: { label: "Integrity invalid", state: "bad" },
  partially_recoverable: { label: "Partially recoverable", state: "bad" },
  unsupported: { label: "Unsupported", state: "bad" },
  valid: { label: "Integrity valid", state: "ok" },
  valid_with_warnings: { label: "Valid with warnings", state: "warn" },
};

const outcomeKind = (recognition?: SaveRecognition): "recognized" | "ambiguous" | "unsupported" | "unknown" => {
  const outcome = recognition?.outcome;
  if (!outcome || typeof outcome !== "object") return recognition?.candidates?.length === 1 ? "recognized" : "unknown";
  if ("recognized" in outcome) return "recognized";
  if ("ambiguous" in outcome) return "ambiguous";
  if ("unsupported" in outcome) return "unsupported";
  return "unknown";
};

const candidateFromRecognition = (recognition?: SaveRecognition): SaveCandidate | undefined => {
  const outcome = recognition?.outcome;
  if (outcome && typeof outcome === "object" && "recognized" in outcome) {
    const value = (outcome as { recognized?: { candidate?: SaveCandidate } }).recognized?.candidate;
    if (value) return value;
  }
  return recognition?.candidates?.length === 1 ? recognition.candidates[0] : undefined;
};

const formatAssignment = (field: SaveField, value: string) => `${field.id}=${value}`;
// A wrapped save (.sps/.xps/.gsv) stays wrapped on output, so the edited file
// keeps the source extension instead of forcing .sav.
const editedSaveName = (name: string) => {
  const extension = /\.([^.]+)$/.exec(name)?.[1] ?? "sav";
  return `${name.replace(/\.[^.]+$/, "")}-edited.${extension}`;
};
const loadSaveApi = () => import("../../platform/browser/browser-save-api.ts");
const titleFor = (segment: string) =>
  GROUP_TITLES[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1).replaceAll("_", " ");
const isReadOnly = (field: SaveField) => !field.editable || field.kind.startsWith("read_only");
const isToggle = (field: SaveField) => field.kind === "boolean" || field.kind === "bitfield_boolean";
const groupCount = (editable: number, total: number) =>
  total > editable ? `${editable} editable · ${total - editable} read-only` : `${editable} editable`;
const formatNumber = (value: number) => value.toLocaleString("en-US");
const displayValue = (value: SaveValue) => {
  const text = saveValueToText(value);
  if (text === "true") return "on";
  if (text === "false") return "off";
  return text;
};

/**
 * Group fields by their id prefix. A `slot_N.group.name` id (Zelda's three
 * files) yields one slot per file with groups inside; `group.name` ids (the
 * Pokémon trainer block) yield a single unnamed slot.
 */
const groupFields = (fields: readonly SaveField[]): FieldSlot[] => {
  const slots = new Map<string, Map<string, SaveField[]>>();
  for (const field of fields) {
    const parts = field.id.split(".");
    const hasSlot = /^slot_\d+$/.test(parts[0] ?? "");
    const slotId = hasSlot ? (parts[0] ?? "") : "";
    const groupId = hasSlot ? (parts[1] ?? "") : (parts[0] ?? "");
    const groups = slots.get(slotId) ?? new Map<string, SaveField[]>();
    const members = groups.get(groupId) ?? [];
    members.push(field);
    groups.set(groupId, members);
    slots.set(slotId, groups);
  }
  return Array.from(slots, ([slotId, groups]) => ({
    groups: Array.from(groups, ([id, members]) => ({ fields: members, id, title: titleFor(id) })),
    id: slotId,
    title: slotId.replace(/^slot_(\d+)$/, "File $1"),
  }));
};

const SaveFieldControl = ({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: SaveField;
  value: SaveValue;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) => {
  const errorId = `save-field-error-${field.id}`;
  const descriptionId = `save-field-description-${field.id}`;
  const describedBy =
    [field.description ? descriptionId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  const text = saveValueToText(value);
  const common = {
    "aria-describedby": describedBy,
    "aria-invalid": error ? ("true" as const) : undefined,
    disabled,
    id: `save-field-${field.id}`,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.value),
  };
  if (field.constraints.choices?.length) {
    return (
      <div aria-label={field.label} className="save-editor-segment" role="radiogroup">
        {field.constraints.choices.map((choice) => (
          <label className={join("save-editor-segment-option", text === choice && "is-on")} key={choice}>
            <input
              checked={text === choice}
              disabled={disabled}
              name={`save-field-${field.id}`}
              onChange={() => onChange(choice)}
              type="radio"
              value={choice}
            />
            <span>{choice}</span>
          </label>
        ))}
      </div>
    );
  }
  if (field.kind === "text") {
    return (
      <span className="save-editor-text">
        <input
          {...common}
          className="input save-editor-control mono"
          maxLength={field.constraints.max_length ?? undefined}
          type="text"
          value={text}
        />
        {field.constraints.max_length === null ? null : (
          <span className="save-editor-range mono">
            {text.length}/{field.constraints.max_length}
          </span>
        )}
      </span>
    );
  }
  const { max, min } = field.constraints;
  return (
    <span className="save-editor-text">
      <input
        {...common}
        className="input save-editor-control save-editor-number mono"
        max={max ?? undefined}
        min={min ?? undefined}
        step={field.step ?? undefined}
        type="number"
        value={text}
      />
      {max === null ? null : (
        <button
          className="btn slim ghost save-editor-max"
          disabled={disabled || text === String(max)}
          onClick={() => onChange(String(max))}
          type="button"
        >
          Max
        </button>
      )}
      {min !== null || max !== null ? (
        <span className="save-editor-range mono">
          {min === null ? "…" : formatNumber(min)} – {max === null ? "…" : formatNumber(max)}
          {field.step && field.step > 1 ? ` · step ${field.step}` : ""}
        </span>
      ) : null}
    </span>
  );
};

const SaveEditor = ({ onSessionChange, onSelectTab, pageDrop }: SaveEditorProps) => {
  const { currentGameId, entries } = useEmulatorSession();
  const testGame = entries.find((entry) => entry.id === currentGameId);
  const [source, setSource] = useState<File | null>(null);
  const [schemaPack, setSchemaPack] = useState<File | null>(null);
  const [schemaRevision, setSchemaRevision] = useState(0);
  const [document, setDocument] = useState<SaveDocument | null>(null);
  const [recognition, setRecognition] = useState<SaveRecognition | undefined>();
  const [saveSize, setSaveSize] = useState<number>();
  const [rawOffset, setRawOffset] = useState(0);
  const [potentialFormat, setPotentialFormat] = useState<string>();
  const [containerName, setContainerName] = useState<string>();
  const [sourceRomSha1, setSourceRomSha1] = useState<string>();
  const [values, setValues] = useState<Record<string, SaveValue>>({});
  const [originalValues, setOriginalValues] = useState<Record<string, SaveValue>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [preview, setPreview] = useState<SavePreview | null>(null);
  const [output, setOutput] = useState<PublicOutput | null>(null);
  const [saves, setSaves] = useState<EmulatorSaveRecord[]>([]);
  const [selectedSaveId, setSelectedSaveId] = useState<string>();
  const [selectedSlot, setSelectedSlot] = useState("");
  const [fieldQuery, setFieldQuery] = useState("");
  const [generated, setGenerated] = useState(false);
  const [originalSram, setOriginalSram] = useState<Uint8Array | null>(null);
  const [replacementSram, setReplacementSram] = useState<Uint8Array | null>(null);
  const [pendingReplacement, setPendingReplacement] = useState(false);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const outputRef = useRef<PublicOutput | null>(null);
  const schemaInputRef = useRef<HTMLInputElement | null>(null);
  const handledDropRef = useRef(0);
  const requestRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const selectSourceRef = useRef<(file: File, romSha1?: string) => void>(() => undefined);

  const startRequest = () => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    return { request: ++requestRef.current, signal: controller.signal };
  };

  const clearOutput = useCallback(() => {
    const previous = outputRef.current;
    outputRef.current = null;
    setOutput(null);
    if (previous) void previous.dispose();
  }, []);
  const resetEditor = useCallback(() => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    requestRef.current += 1;
    clearOutput();
    setSource(null);
    setDocument(null);
    setRecognition(undefined);
    setSaveSize(undefined);
    setRawOffset(0);
    setPotentialFormat(undefined);
    setContainerName(undefined);
    setSourceRomSha1(undefined);
    setValues({});
    setOriginalValues({});
    setErrors({});
    setPreview(null);
    setSelectedSaveId(undefined);
    setSelectedSlot("");
    setFieldQuery("");
    setGenerated(false);
    setOriginalSram(null);
    setReplacementSram(null);
    setPendingReplacement(false);
    setUndoAvailable(false);
    setError("");
  }, [clearOutput]);
  useEffect(() => {
    onSessionChange(Boolean(source || document || output || Object.keys(values).length));
  }, [document, onSessionChange, output, source, values]);
  useEffect(
    () => () => {
      requestAbortRef.current?.abort();
      requestRef.current += 1;
      void outputRef.current?.dispose();
    },
    [],
  );
  useEffect(() => {
    void listEmulatorSaves()
      .then(setSaves)
      .catch(() => setSaves([]));
  }, []);

  const replaceSchemaPack = async (nextSchema: File | null) => {
    const currentSource = source;
    const currentRomSha1 = sourceRomSha1;
    const activeRequest = startRequest();
    setBusy(true);
    setError("");
    try {
      if (nextSchema) {
        const { listSaveGames } = await loadSaveApi();
        await listSaveGames(activeRequest.signal, nextSchema);
      }
      if (activeRequest.request !== requestRef.current) return;
      setSchemaPack(nextSchema);
      setSchemaRevision((revision) => revision + 1);
      if (currentSource) selectSource(currentSource, currentRomSha1, nextSchema);
    } catch (cause) {
      if (activeRequest.request === requestRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (activeRequest.request === requestRef.current) setBusy(false);
    }
  };

  const inspectSelected = async (
    file: File,
    game?: string,
    romSha1?: string,
    activeRequest = startRequest(),
    schema = schemaPack,
  ) => {
    const { request, signal } = activeRequest;
    setBusy(true);
    setError("");
    try {
      const { inspectSave } = await loadSaveApi();
      const result = await inspectSave({ fileName: file.name, game, romSha1, schema, signal, source: file });
      if (request !== requestRef.current) return;
      if (!result.document) throw new Error("Save inspection returned no document.");
      setRecognition(result.recognition);
      setRawOffset(result.rawOffset ?? 0);
      const nextValues = Object.fromEntries(result.document.fields.map((field) => [field.id, field.value]));
      setDocument(result.document);
      setValues(nextValues);
      setOriginalValues(nextValues);
      setPreview(null);
      setSelectedSlot(groupFields(result.document.fields)[0]?.id ?? "");
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  };
  const identifySelected = async (
    file: File,
    romSha1: string | undefined,
    activeRequest: ReturnType<typeof startRequest>,
    schema = schemaPack,
  ) => {
    const { request, signal } = activeRequest;
    setBusy(true);
    setError("");
    try {
      const { identifySave } = await loadSaveApi();
      const result = await identifySave({ fileName: file.name, romSha1, schema, signal, source: file });
      if (request !== requestRef.current) return;
      setRecognition(result.recognition);
      setSaveSize(result.saveSize);
      setPotentialFormat(result.potentialFormat);
      setContainerName(result.containerName);
      const candidate = candidateFromRecognition(result.recognition);
      if (candidate) await inspectSelected(file, candidate.identity.id, romSha1, activeRequest, schema);
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  };
  const selectSource = (file: File, romSha1?: string, schema = schemaPack) => {
    resetEditor();
    setSource(file);
    setSourceRomSha1(romSha1);
    const activeRequest = startRequest();
    void identifySelected(file, romSha1, activeRequest, schema);
  };
  selectSourceRef.current = selectSource;
  const generateSave = async (game: string) => {
    resetEditor();
    const activeRequest = startRequest();
    setBusy(true);
    try {
      const { createSave } = await loadSaveApi();
      const file = await createSave({ game, schema: schemaPack, signal: activeRequest.signal });
      if (activeRequest.request !== requestRef.current) return;
      setSource(file);
      setGenerated(true);
      await inspectSelected(file, game, undefined, activeRequest, schemaPack);
    } catch (cause) {
      if (activeRequest.request === requestRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (activeRequest.request === requestRef.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!(pageDrop && pageDrop.id !== handledDropRef.current)) return;
    handledDropRef.current = pageDrop.id;
    const file = pageDrop.files.find((candidate) => !/\.ppf$/i.test(candidate.name));
    if (file) selectSourceRef.current(file);
  }, [pageDrop]);
  const validateField = (field: SaveField, text: string): string => {
    const numericKind = field.kind === "unsigned_integer" || field.kind === "signed_integer";
    if (numericKind) {
      if (!text.trim()) return "Enter a valid integer in the allowed range.";
      const number = Number(text);
      const minimum = field.constraints.min ?? (field.kind === "signed_integer" ? -Number.MAX_SAFE_INTEGER : 0);
      if (
        !Number.isSafeInteger(number) ||
        number < minimum ||
        number > (field.constraints.max ?? Number.MAX_SAFE_INTEGER)
      ) {
        return "Enter a valid integer in the allowed range.";
      }
    }
    if (field.constraints.max_length !== null && text.length > field.constraints.max_length)
      return "This value is too long.";
    if (field.constraints.choices?.length && !field.constraints.choices.includes(text))
      return "Choose one of the listed values.";
    return "";
  };
  const updateField = (field: SaveField, text: string) => {
    const nextError = validateField(field, text);
    setErrors((current) => ({ ...current, [field.id]: nextError }));
    if (!nextError) setValues((current) => ({ ...current, [field.id]: saveValueFromText(field.kind, text) }));
    clearOutput();
    setPreview(null);
  };
  const isChanged = (field: SaveField) => {
    const value = values[field.id];
    const original = originalValues[field.id] ?? field.value;
    return !!value && saveValueToText(value) !== saveValueToText(original);
  };
  const pendingChanges =
    document?.fields
      .filter((field) => field.editable && isChanged(field))
      .map((field) => ({
        field,
        next: values[field.id] ?? field.value,
        original: originalValues[field.id] ?? field.value,
      })) || [];
  const assignments = pendingChanges.map(({ field, next }) => formatAssignment(field, saveValueToText(next)));
  const hasErrors = Object.values(errors).some(Boolean);
  const previewChanges = async () => {
    if (!(source && document) || assignments.length === 0 || hasErrors) return;
    const { request, signal } = startRequest();
    setBusy(true);
    try {
      const { previewSaveFields } = await loadSaveApi();
      const result = await previewSaveFields({
        assignments,
        fileName: source.name,
        game: document.identity.id,
        outputName: source.name,
        romSha1: sourceRomSha1,
        schema: schemaPack,
        signal,
        source,
      });
      if (request === requestRef.current) setPreview(result.preview || null);
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  };
  const writeEditedSave = async (download = true): Promise<PublicOutput | undefined> => {
    if (!source || (!generated && assignments.length === 0) || hasErrors) return undefined;
    const { request, signal } = startRequest();
    setBusy(true);
    setError("");
    try {
      const { setSaveFields } = await loadSaveApi();
      const result = await setSaveFields({
        create: generated,
        assignments,
        fileName: source.name,
        game: document?.identity.id,
        outputName: editedSaveName(source.name),
        romSha1: sourceRomSha1,
        schema: schemaPack,
        signal,
        source,
      });
      if (request !== requestRef.current) {
        await result.output.dispose();
        return undefined;
      }
      outputRef.current = result.output;
      setOutput(result.output);
      if (download) await result.output.saveAs();
      return result.output;
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
    return undefined;
  };
  const testSave = async () => {
    if (!(source && document && onSelectTab) || hasErrors) return;
    setBusy(true);
    setError("");
    try {
      const currentOutput = output ?? (assignments.length ? await writeEditedSave(false) : undefined);
      if (assignments.length && !currentOutput) return;
      const saveBlob = currentOutput ? await readRuntimeOutputBlob(currentOutput) : source;
      const bytes = new Uint8Array(await saveBlob.arrayBuffer());
      const end = rawOffset + document.save_size;
      if (rawOffset < 0 || end > bytes.byteLength || !Number.isSafeInteger(end)) {
        throw new Error("The edited save no longer contains the expected raw game data.");
      }
      const rawSave = bytes.subarray(rawOffset, end);
      if (canTest && testGame?.checksum) {
        await clearPendingTestSave();
        setEmulatorSavePreview(testGame.checksum, rawSave);
        restartCurrentGameWithSave(testGame.id);
      } else {
        await stagePendingTestSave({
          data: rawSave,
          fileName: source.name,
          gameId: document.identity.id,
          platform: document.platform,
          romSha1: sourceRomSha1,
        });
      }
      onSelectTab("test");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const downloadEditedSave = async () => {
    if (!output) return;
    setBusy(true);
    try {
      await output.saveAs();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const resetField = (field: SaveField) => {
    setValues((current) => ({ ...current, [field.id]: originalValues[field.id] ?? field.value }));
    setErrors((current) => ({ ...current, [field.id]: "" }));
    clearOutput();
    setPreview(null);
  };
  const resetAll = () => {
    setValues({ ...originalValues });
    setErrors({});
    clearOutput();
    setPreview(null);
  };
  const chooseEmulatorSave = (record: EmulatorSaveRecord) => {
    if (!record.sram) return;
    const copy = new Uint8Array(record.sram);
    const romSha1 = /^[0-9a-f]{40}$/i.test(record.gameId) ? record.gameId : undefined;
    selectSource(new File([copy], `${record.label || "emulator"}.sav`, { type: "application/octet-stream" }), romSha1);
    setSelectedSaveId(record.gameId);
    setOriginalSram(copy);
  };
  const replaceSelectedSram = async () => {
    if (!(selectedSaveId && output && originalSram)) return;
    setBusy(true);
    try {
      const file = await output.vfs.getFile?.(output.path);
      let bytes: Uint8Array;
      if (file) {
        bytes = new Uint8Array(await file.arrayBuffer());
      } else {
        const stat = await output.vfs.stat(output.path);
        if (!stat) throw new Error("The edited save output is no longer available.");
        bytes = new Uint8Array(stat.size);
        await output.vfs.read(output.path, bytes);
      }
      const replaced = await replaceEmulatorSaveSram(selectedSaveId, bytes, originalSram);
      setSaves((current) => current.map((record) => (record.gameId === replaced.gameId ? replaced : record)));
      setReplacementSram(bytes);
      setUndoAvailable(true);
      setPendingReplacement(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const undoReplacement = async () => {
    if (!(selectedSaveId && originalSram && replacementSram)) return;
    setBusy(true);
    try {
      const restored = await replaceEmulatorSaveSram(selectedSaveId, originalSram, replacementSram);
      setSaves((current) => current.map((record) => (record.gameId === restored.gameId ? restored : record)));
      setUndoAvailable(false);
      setReplacementSram(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const kind = outcomeKind(recognition);
  const slots = document ? groupFields(document.fields.filter((field) => !(generated && isReadOnly(field)))) : [];
  const hasSlotTabs = slots.length > 1;
  const activeSlot = slots.find((slot) => slot.id === selectedSlot) ?? slots[0];
  const query = fieldQuery.trim().toLowerCase();
  const visibleGroups = (activeSlot?.groups ?? [])
    .map((group) => ({
      ...group,
      fields: group.fields.filter((field) =>
        `${group.title} ${field.label} ${field.id} ${field.description}`.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.fields.length > 0);
  const sramSaves = saves.filter((record) => record.sram);
  const integrity = document ? INTEGRITY_STATE[document.integrity.state] : undefined;
  const testCore = testGame?.core ?? getEmulatorJsCore(testGame?.platform, testGame?.fileName);
  const canTest = Boolean(
    onSelectTab &&
    testGame?.checksum &&
    document &&
    getEmulatorJsCore(document.platform) === testCore &&
    (!sourceRomSha1 || sourceRomSha1 === testGame.checksum),
  );
  let testStatus = "No ROM is loaded in Test. You choose one next.";
  if (testGame && canTest) {
    testStatus = `Tests with ${testGame.fileName}. Make sure it is the game that made this save.`;
  } else if (testGame) {
    testStatus = `${testGame.fileName} does not match this save. You choose another ROM next.`;
  }
  const slotName = (slot: FieldSlot) => {
    const name = slot.groups.flatMap((group) => group.fields).find((field) => field.id.endsWith(".player.name"));
    const text = name ? saveValueToText(name.value).trim() : "";
    return text ? `${slot.title} · ${text}` : slot.title;
  };

  const renderField = (field: SaveField) => {
    const errorText = errors[field.id];
    const changed = isChanged(field);
    const readOnly = isReadOnly(field);
    const controlId = `save-field-${field.id}`;
    return (
      <div className={join("save-editor-field", changed && "is-changed")} key={field.id}>
        <div className="save-editor-field-head">
          <label htmlFor={controlId}>{field.label}</label>
          {field.description ? (
            <span className="save-editor-description" id={`save-field-description-${field.id}`}>
              {field.description}
            </span>
          ) : null}
        </div>
        {readOnly ? (
          <span className="save-editor-readonly">
            <output className="mono" id={controlId}>
              {saveValueToText(field.value)}
            </output>
            <span className="save-editor-tag">read-only</span>
          </span>
        ) : (
          <SaveFieldControl
            disabled={busy}
            error={errorText}
            field={field}
            onChange={(value) => updateField(field, value)}
            value={values[field.id] || field.value}
          />
        )}
        {changed ? (
          <button
            aria-label={`Reset ${field.label}`}
            className="btn slim ghost save-editor-reset"
            disabled={busy}
            onClick={() => resetField(field)}
            type="button"
          >
            <RotateCcw aria-hidden="true" /> Reset
          </button>
        ) : (
          <span />
        )}
        {field.warnings.length ? <span className="save-editor-warning">{field.warnings.join(" ")}</span> : null}
        {errorText ? (
          <span className="save-editor-field-error" id={`save-field-error-${field.id}`} role="alert">
            {errorText}
          </span>
        ) : null}
      </div>
    );
  };
  const renderToggle = (field: SaveField) => {
    const changed = isChanged(field);
    const readOnly = isReadOnly(field);
    const on = saveValueToText(values[field.id] || field.value) === "true";
    return (
      <label
        className={join("save-editor-toggle", on && "is-on", changed && "is-changed")}
        key={field.id}
        title={field.description || undefined}
      >
        <input
          checked={on}
          disabled={busy || readOnly}
          onChange={(event) => updateField(field, String(event.currentTarget.checked))}
          type="checkbox"
        />
        <span aria-hidden="true" className="save-editor-toggle-mark" />
        <span className="save-editor-toggle-label">{field.label}</span>
        <span className="save-editor-toggle-id mono">{field.id.split(".").at(-1)}</span>
      </label>
    );
  };
  const renderGroup = (group: FieldGroup) => {
    const toggles = group.fields.filter(isToggle);
    const rows = group.fields.filter((field) => !isToggle(field));
    const editable = group.fields.filter((field) => !isReadOnly(field)).length;
    const on = toggles.filter((field) => saveValueToText(values[field.id] || field.value) === "true").length;
    return (
      <fieldset aria-label={group.id} className="save-editor-group" key={group.id}>
        <legend className="save-editor-group-head">
          <span className="save-editor-group-title">{group.title}</span>
          <span className="save-editor-group-count mono">
            {toggles.length && !rows.length ? `${on} / ${toggles.length}` : groupCount(editable, group.fields.length)}
          </span>
        </legend>
        {rows.length ? <div className="save-editor-rows">{rows.map(renderField)}</div> : null}
        {toggles.length ? <div className="save-editor-toggles">{toggles.map(renderToggle)}</div> : null}
      </fieldset>
    );
  };

  const fileCard = source ? (
    <div className="cards save-editor-file">
      <FileCard
        meta={
          <>
            <span className="fsize mono">{formatByteSize(source.size)}</span>
            {document ? <span className="meta-fmt mono">{document.save_format_name}</span> : null}
            {containerName ? <span className="meta-fmt mono">{containerName}</span> : null}
            {integrity ? <span className={join("save-editor-pill", integrity.state)}>{integrity.label}</span> : null}
            {selectedSaveId ? <span className="meta-fmt mono">emulator SRAM</span> : null}
          </>
        }
        name={<span className="nm mono">{source.name}</span>}
        onRemove={resetEditor}
        removeLabel="Remove save"
        state={integrity?.state}
      >
        {document ? (
          <p aria-live="polite" className="save-editor-identity">
            <strong>{document.identity.name}</strong>
            <span>{document.platform.toUpperCase()}</span>
            {document.counter ? (
              <span className="mono">
                slot {document.active_slot} · index {document.counter}
              </span>
            ) : (
              <span className="mono">{document.sections.length} checked copies</span>
            )}
          </p>
        ) : null}
        {document?.warnings.map((warning) => (
          <Notice key={warning} level="warn">
            {warning}
          </Notice>
        ))}
        {kind === "ambiguous" ? (
          <div aria-live="polite" className="save-editor-candidates">
            <p className="save-editor-candidates-lead">
              <strong>Choose the game format</strong>
              <span>Two games share this save layout, so the file alone cannot tell which one wrote it.</span>
            </p>
            <div className="save-editor-candidate-list">
              {(recognition?.candidates || []).map((candidate) => (
                <button
                  className="btn slim ghost save-editor-candidate"
                  disabled={busy}
                  key={candidate.identity.id}
                  onClick={() => {
                    setRecognition(undefined);
                    const activeRequest = startRequest();
                    void inspectSelected(source, candidate.identity.id, sourceRomSha1, activeRequest);
                  }}
                  type="button"
                >
                  <span>{candidate.identity.name}</span>
                  <span className="mono">{candidate.identity.family}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {kind === "unsupported" ? (
          <Notice level="warn">
            ROMWeaver does not have an editor for this game. {containerName ? "Raw save size" : "Save size"}:{" "}
            {formatByteSize(saveSize)}
            {containerName ? ` · Container: ${containerName}` : ""}
            {potentialFormat ? ` · Potential format: ${potentialFormat}` : ""}. The original file remains unchanged.
          </Notice>
        ) : null}
      </FileCard>
    </div>
  ) : null;

  const sramList = (
    <div className="drop-tray-row save-editor-stash">
      <span className="drop-tray-label" id="save-editor-emulator-title">
        <Save aria-hidden="true" /> Emulator saves
      </span>
      {sramSaves.length ? (
        <fieldset aria-labelledby="save-editor-emulator-title" className="drop-tray-control save-editor-records">
          {sramSaves.map((record) => (
            <button
              className="save-editor-record"
              disabled={busy}
              key={record.gameId}
              onClick={() => chooseEmulatorSave(record)}
              type="button"
            >
              <span>{record.label}</span>
              <span className="mono">{formatByteSize(record.sram?.byteLength)}</span>
            </button>
          ))}
        </fieldset>
      ) : (
        <div className="drop-tray-control">
          <p className="drop-tray-note">No emulator saves yet. Save a game in Test to open its SRAM here.</p>
        </div>
      )}
    </div>
  );

  const schemaPackRow = (
    <div className="drop-tray-row save-schema-pack">
      <span className="drop-tray-label" id="save-schema-pack-title">
        <FileJson2 aria-hidden="true" /> Save schema pack
      </span>
      <div className="drop-tray-control">
        {schemaPack ? <span className="drop-tray-note mono">{schemaPack.name}</span> : null}
        <button className="btn ghost" disabled={busy} onClick={() => schemaInputRef.current?.click()} type="button">
          {schemaPack ? "Replace schema pack" : "Load schema pack"}
        </button>
        <input
          accept="application/json,.json"
          aria-labelledby="save-schema-pack-title"
          disabled={busy}
          hidden
          id="save-schema-pack-picker"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void replaceSchemaPack(file);
          }}
          ref={schemaInputRef}
          type="file"
        />
        {schemaPack ? (
          <button className="btn ghost" disabled={busy} onClick={() => void replaceSchemaPack(null)} type="button">
            Clear schema pack
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <section className="panel save-editor" id="save-editor-container">
      <UnifiedDropZone
        accept={SAVE_ACCEPT}
        addLabel="Replace the save"
        afterDropZone={
          source ? (
            <>
              {fileCard}
              <div className="drop-tray">{schemaPackRow}</div>
            </>
          ) : (
            <>
              <div className="drop-tray save-editor-sources">
                {sramList}
                <SaveGenerator
                  disabled={busy}
                  key={schemaRevision}
                  onError={setError}
                  onGenerate={generateSave}
                  schema={schemaPack}
                />
                {schemaPackRow}
              </div>
              {error ? <Notice level="error">{error}</Notice> : null}
            </>
          )
        }
        big={!source}
        disabled={busy}
        heroLabel="Drop a game save to edit it"
        heroLabelCoarse="Tap to add a game save"
        info={
          <p>
            Editing runs locally and never changes the file you add. Use a raw game save, not an emulator save state. A
            new Pokémon save needs a save made by the game as its template.
          </p>
        }
        inputId="save-editor-input-picker"
        lead={{ line1: "ui.hero.saveThesis", line2: "ui.hero.saveThesis2", description: "ui.hero.saveDescription" }}
        multiple={false}
        num="0x01"
        onFiles={(files) => {
          const selected = files.at(-1);
          if (selected) selectSource(selected);
        }}
        supported={SAVE_SUPPORTED_FILES}
        title="Save file"
      />
      {source ? (
        <>
          <StepSection
            fault={!!error}
            meta={pendingChanges.length ? `${pendingChanges.length} pending` : undefined}
            num="0x02"
            title="Fields"
            woven={pendingChanges.length > 0}
          >
            {document && activeSlot ? (
              <div className="save-editor-fields">
                <div className="save-editor-toolbar">
                  {hasSlotTabs ? (
                    <div aria-label="Save files" className="save-editor-slots" role="tablist">
                      {slots.map((slot) => (
                        <button
                          aria-selected={slot.id === activeSlot.id}
                          className="save-editor-slot"
                          key={slot.id}
                          onClick={() => setSelectedSlot(slot.id)}
                          role="tab"
                          type="button"
                        >
                          {slotName(slot)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <label className="save-editor-search">
                    <Search aria-hidden="true" />
                    <input
                      aria-label="Find a property"
                      className="input"
                      onChange={(event) => setFieldQuery(event.currentTarget.value)}
                      placeholder="Find a property"
                      type="search"
                      value={fieldQuery}
                    />
                  </label>
                </div>
                {visibleGroups.length ? (
                  visibleGroups.map(renderGroup)
                ) : (
                  <p className="save-editor-empty" role="status">
                    No properties match this search.
                  </p>
                )}
              </div>
            ) : (
              <p className="save-editor-empty">
                {busy ? "Reading the save…" : "Choose a supported save to inspect its fields."}
              </p>
            )}
            {error ? (
              <Notice level="error" onDismiss={() => setError("")}>
                {error}
              </Notice>
            ) : null}
          </StepSection>
          <StepSection num="0x03" title="Write" woven={!!output}>
            {pendingChanges.length ? (
              <ul aria-live="polite" className="save-editor-ledger">
                {pendingChanges.map(({ field, next, original }) => (
                  <li className="save-editor-chip" key={field.id}>
                    <span>{field.label}</span>
                    <span className="mono">
                      {displayValue(original)} → {displayValue(next)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="save-editor-empty">
                {generated
                  ? "The fresh save is ready. Edit its properties or download it."
                  : "No changes yet. Edit a field above to build the edited copy."}
              </p>
            )}
            {preview ? (
              <div aria-live="polite" className="save-editor-preview mono">
                {preview.changes?.length || 0} field changes · integrity {preview.output_valid ? "valid" : "invalid"}
                {preview.touched_sections?.length ? ` · sections ${preview.touched_sections.join(", ")}` : ""}
              </div>
            ) : null}
            <div className="save-editor-run-row">
              {output ? (
                <RunButton
                  disabled={busy}
                  icon={<Download aria-hidden="true" />}
                  onClick={() => void downloadEditedSave()}
                >
                  Download edited copy
                </RunButton>
              ) : (
                <RunButton
                  disabled={!(pendingChanges.length || generated) || busy || hasErrors || !document}
                  icon={<Download aria-hidden="true" />}
                  onClick={() => void writeEditedSave()}
                >
                  Download edited copy
                </RunButton>
              )}
              {onSelectTab ? (
                <button
                  className="btn save-editor-test"
                  disabled={!document || busy || hasErrors}
                  onClick={() => void testSave()}
                  type="button"
                >
                  <Gamepad2 aria-hidden="true" /> {canTest ? "Test save in ROM" : "Choose ROM and test"}
                </button>
              ) : null}
            </div>
            <div className="save-editor-actions">
              <button
                className="btn slim ghost"
                disabled={!pendingChanges.length || busy}
                onClick={resetAll}
                type="button"
              >
                Reset all
              </button>
              <button
                className="btn slim ghost"
                disabled={!pendingChanges.length || busy || hasErrors}
                onClick={() => void previewChanges()}
                type="button"
              >
                Preview changes
              </button>
              {onSelectTab && document ? (
                <p className={join("save-status", canTest ? "is-ready" : "is-waiting")}>{testStatus}</p>
              ) : null}
            </div>
            {selectedSaveId && output ? (
              <div className="save-editor-replace">
                <button
                  className="btn slim ghost"
                  disabled={busy}
                  onClick={() => setPendingReplacement(true)}
                  type="button"
                >
                  Replace selected SRAM
                </button>
                {pendingReplacement ? (
                  <span role="alert">
                    This replaces the stored SRAM.{" "}
                    <button className="btn slim danger" onClick={() => void replaceSelectedSram()} type="button">
                      Confirm
                    </button>
                    <button className="btn slim ghost" onClick={() => setPendingReplacement(false)} type="button">
                      Cancel
                    </button>
                  </span>
                ) : null}
                {undoAvailable ? (
                  <button className="btn slim ghost" onClick={() => void undoReplacement()} type="button">
                    <Undo2 aria-hidden="true" /> Undo replacement
                  </button>
                ) : null}
              </div>
            ) : null}
          </StepSection>
        </>
      ) : (
        <GhostSteps steps={GHOST_STEPS} />
      )}
    </section>
  );
};

export { SaveEditor };
export type { SaveEditorProps };
