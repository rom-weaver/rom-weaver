import { Download, Gamepad, RotateCcw, Save, Search, Undo2 } from "lucide-react";
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
import type { SaveGameDefinition } from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { ROM_WEAVER_SAVE_FILE_EXTENSIONS } from "../../wasm/generated/rom-weaver-format-metadata.ts";
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
import type { MessageId } from "../../presentation/localization/catalog.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { join } from "../../public/react/components/ds/cx.ts";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { StepSection } from "../../public/react/components/ds/layout.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { WORKFLOW_GUIDES } from "../../public/react/workflow-guides.ts";
import { getEmulatorJsCore } from "../../public/react/components/emulatorjs.ts";
import { restartCurrentGameWithSave, useEmulatorSession } from "../../public/react/emulator-session-store.ts";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import { SaveGenerator } from "./save-generator.tsx";
import { describeAgentSource, useAgentWorkflow } from "../agent/workflow-registry.ts";

type SaveEditorProps = {
  onSessionChange: (active: boolean) => void;
  onSelectTab?: (tab: string) => void;
  pageDrop?: PageFileDrop | null;
};
type FieldErrors = Record<string, string>;
type FieldGroup = { id: string; title: string; fields: SaveField[] };
type FieldSlot = { id: string; title: string; groups: FieldGroup[] };

// Raw and wrapper extensions come from Rust (`RAW_SAVE_FILE_EXTENSIONS`, `SaveContainerKind::file_extensions`).
const SAVE_CONTAINERS = ROM_WEAVER_SAVE_FILE_EXTENSIONS.containers;
const saveContainerExtensions = (isGroup: (id: SaveContainerId) => boolean): string[] =>
  SAVE_CONTAINERS.filter((container) => isGroup(container.id)).flatMap((container) => [...container.extensions]);
type SaveContainerId = (typeof SAVE_CONTAINERS)[number]["id"];
const isGameSharkSpContainer = (id: SaveContainerId): boolean =>
  id === "shark_port_save" || id === "gameshark_sp_snapshot";
const SAVE_SUPPORTED_FILES = [
  { extensions: ROM_WEAVER_SAVE_FILE_EXTENSIONS.raw, labelId: "ui.saves.editor.supported.raw" },
  { extensions: saveContainerExtensions(isGameSharkSpContainer), labelId: "ui.saves.editor.supported.gamesharkSp" },
  {
    extensions: saveContainerExtensions((id) => !isGameSharkSpContainer(id)),
    labelId: "ui.saves.editor.supported.wrappers",
  },
] as const;
const SAVE_ACCEPT = `${SAVE_SUPPORTED_FILES.flatMap((group) => group.extensions.map((extension) => `.${extension}`)).join(",")},application/octet-stream`;
const GHOST_STEPS = [
  { num: "0x02", titleId: "ui.saves.editor.step.fields" },
  { num: "0x03", titleId: "ui.cheats.write" },
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
const INTEGRITY_STATE: Record<string, { state: "ok" | "warn" | "bad"; labelId: MessageId }> = {
  invalid: { labelId: "ui.saves.editor.integrity.invalid", state: "bad" },
  partially_recoverable: { labelId: "ui.saves.editor.integrity.partial", state: "bad" },
  unsupported: { labelId: "ui.runtime.headerUnsupported", state: "bad" },
  valid: { labelId: "ui.saves.editor.integrity.valid", state: "ok" },
  valid_with_warnings: { labelId: "ui.saves.editor.integrity.warnings", state: "warn" },
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
/** The short field id is worth showing only when it adds something the label does not already say. */
const toggleIdHint = (field: SaveField): string => {
  const hint = field.id.split(".").at(-1) ?? "";
  const labelSlug = field.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return hint === labelSlug ? "" : hint;
};

const isToggle = (field: SaveField) => field.kind === "boolean" || field.kind === "bitfield_boolean";
const groupCount = (editable: number, total: number, localizer: Localizer) =>
  total > editable
    ? localizer.message("ui.saves.editor.countMixed", { editable, readOnly: total - editable })
    : localizer.message("ui.saves.editor.countEditable", { editable });
const displayValue = (value: SaveValue, localizer: Localizer) => {
  const text = saveValueToText(value);
  if (text === "true") return localizer.message("ui.patch.on").toLowerCase();
  if (text === "false") return localizer.message("ui.patch.off").toLowerCase();
  return text;
};
/** Display title for a group; ids without a catalog entry keep the capitalized segment. */
const groupTitle = (group: FieldGroup, localizer: Localizer) =>
  Object.hasOwn(GROUP_TITLES, group.id)
    ? localizer.message(`ui.saves.editor.group.${group.id}` as MessageId)
    : group.title;
const slotTitle = (slot: FieldSlot, localizer: Localizer) => {
  const match = /^slot_(\d+)$/.exec(slot.id);
  return match ? localizer.message("ui.saves.editor.file", { n: match[1] }) : slot.title;
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
  localizer,
  onChange,
}: {
  localizer: Localizer;
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
          {localizer.message("ui.saves.editor.max")}
        </button>
      )}
      {min !== null || max !== null ? (
        <span className="save-editor-range mono">
          {min === null ? "…" : min.toLocaleString(localizer.locale)} –{" "}
          {max === null ? "…" : max.toLocaleString(localizer.locale)}
          {field.step && field.step > 1 ? ` · ${localizer.message("ui.saves.editor.step", { step: field.step })}` : ""}
        </span>
      ) : null}
    </span>
  );
};

const SaveEditor = ({ onSessionChange, onSelectTab, pageDrop }: SaveEditorProps) => {
  const localizer = useUiLocalizer();
  const { currentGameId, entries } = useEmulatorSession();
  const testGame = entries.find((entry) => entry.id === currentGameId);
  const [source, setSource] = useState<File | null>(null);
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
  const [profiles, setProfiles] = useState<SaveGameDefinition[] | null>(null);
  const [selectedProfile, setSelectedProfile] = useState("");
  const outputRef = useRef<PublicOutput | null>(null);
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
    setProfiles(null);
    setSelectedProfile("");
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

  const inspectSelected = async (file: File, game?: string, romSha1?: string, activeRequest = startRequest()) => {
    const { request, signal } = activeRequest;
    setBusy(true);
    setError("");
    try {
      const { inspectSave } = await loadSaveApi();
      const result = await inspectSave({ fileName: file.name, game, romSha1, signal, source: file });
      if (request !== requestRef.current) return;
      if (!result.document) throw new Error(localizer.message("ui.saves.editor.noDocument"));
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
  const clearInspection = () => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    requestRef.current += 1;
    clearOutput();
    setDocument(null);
    setRecognition(undefined);
    setRawOffset(0);
    setValues({});
    setOriginalValues({});
    setErrors({});
    setPreview(null);
    setSelectedSlot("");
    setFieldQuery("");
    setGenerated(false);
    setPendingReplacement(false);
    setError("");
  };
  const loadProfiles = async () => {
    if (!source) return;
    const activeRequest = startRequest();
    setBusy(true);
    setError("");
    try {
      const { listSaveGames } = await loadSaveApi();
      const result = await listSaveGames(activeRequest.signal);
      if (activeRequest.request !== requestRef.current) return;
      const normalizedSize = saveSize ?? source.size;
      const matching = (result.games ?? []).filter((game) => game.supported_save_sizes.includes(normalizedSize));
      setProfiles(matching);
      setSelectedProfile(matching.find((game) => game.identity.id === document?.identity.id)?.identity.id ?? "");
    } catch (cause) {
      if (activeRequest.request === requestRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (activeRequest.request === requestRef.current) setBusy(false);
    }
  };
  const openProfile = () => {
    if (!(source && selectedProfile)) return;
    clearInspection();
    const activeRequest = startRequest();
    void inspectSelected(source, selectedProfile, sourceRomSha1, activeRequest);
  };
  const identifySelected = async (
    file: File,
    romSha1: string | undefined,
    activeRequest: ReturnType<typeof startRequest>,
  ) => {
    const { request, signal } = activeRequest;
    setBusy(true);
    setError("");
    try {
      const { identifySave } = await loadSaveApi();
      const result = await identifySave({ fileName: file.name, romSha1, signal, source: file });
      if (request !== requestRef.current) return;
      setRecognition(result.recognition);
      setSaveSize(result.saveSize);
      setPotentialFormat(result.potentialFormat);
      setContainerName(result.containerName);
      const candidate = candidateFromRecognition(result.recognition);
      if (candidate) await inspectSelected(file, candidate.identity.id, romSha1, activeRequest);
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  };
  const selectSource = (file: File, romSha1?: string) => {
    resetEditor();
    setSource(file);
    setSourceRomSha1(romSha1);
    const activeRequest = startRequest();
    void identifySelected(file, romSha1, activeRequest);
  };
  selectSourceRef.current = selectSource;
  const generateSave = async (game: string) => {
    resetEditor();
    const activeRequest = startRequest();
    setBusy(true);
    try {
      const { createSave } = await loadSaveApi();
      const file = await createSave({ game, signal: activeRequest.signal });
      if (activeRequest.request !== requestRef.current) return;
      setSource(file);
      setGenerated(true);
      await inspectSelected(file, game, undefined, activeRequest);
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
    pageDrop.onConsumed?.();
  }, [pageDrop]);
  const validateField = (field: SaveField, text: string): string => {
    const numericKind = field.kind === "unsigned_integer" || field.kind === "signed_integer";
    if (numericKind) {
      if (!text.trim()) return localizer.message("ui.saves.editor.invalidInteger");
      const number = Number(text);
      const minimum = field.constraints.min ?? (field.kind === "signed_integer" ? -Number.MAX_SAFE_INTEGER : 0);
      if (
        !Number.isSafeInteger(number) ||
        number < minimum ||
        number > (field.constraints.max ?? Number.MAX_SAFE_INTEGER)
      ) {
        return localizer.message("ui.saves.editor.invalidInteger");
      }
    }
    if (field.constraints.max_length !== null && text.length > field.constraints.max_length)
      return localizer.message("ui.saves.editor.tooLong");
    if (field.constraints.choices?.length && !field.constraints.choices.includes(text))
      return localizer.message("ui.saves.editor.chooseListed");
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
        throw new Error(localizer.message("ui.saves.editor.rawDataMissing"));
      }
      const rawSave = bytes.subarray(rawOffset, end);
      if (canTest && testGame?.checksum) {
        await clearPendingTestSave("handoff");
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
        if (!stat) throw new Error(localizer.message("ui.saves.editor.outputGone"));
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
        `${group.title} ${groupTitle(group, localizer)} ${field.label} ${field.id} ${field.description}`
          .toLowerCase()
          .includes(query),
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
  let testStatus = localizer.message("ui.saves.editor.testNone");
  if (testGame && canTest) {
    testStatus = localizer.message("ui.saves.editor.testReady", { file: testGame.fileName });
  } else if (testGame) {
    testStatus = localizer.message("ui.saves.editor.testMismatch", { file: testGame.fileName });
  }
  const slotName = (slot: FieldSlot, title = slot.title) => {
    const name = slot.groups.flatMap((group) => group.fields).find((field) => field.id.endsWith(".player.name"));
    const text = name ? saveValueToText(name.value).trim() : "";
    return text ? `${title} · ${text}` : title;
  };

  useAgentWorkflow("save-editor", {
    getState: () => ({
      source: describeAgentSource(source),
      busy,
      error: error || null,
      generated,
      recognition: {
        outcome: kind,
        candidates: (recognition?.candidates ?? []).map((candidate) => ({
          family: candidate.identity.family,
          id: candidate.identity.id,
          name: candidate.identity.name,
        })),
        containerName,
        potentialFormat,
        saveSize,
      },
      document: document
        ? {
            activeSlot: document.active_slot,
            identity: document.identity,
            integrity: document.integrity,
            platform: document.platform,
            saveFormatName: document.save_format_name,
            saveSize: document.save_size,
            warnings: document.warnings,
          }
        : null,
      fields:
        document?.fields.map((field) => ({
          constraints: field.constraints,
          currentValue: saveValueToText(values[field.id] ?? field.value),
          description: field.description,
          editable: field.editable,
          id: field.id,
          kind: field.kind,
          label: field.label,
          originalValue: saveValueToText(originalValues[field.id] ?? field.value),
          step: field.step,
          validationError: errors[field.id] || null,
          warnings: field.warnings,
        })) ?? [],
      slots: slots.map((slot) => ({
        groups: slot.groups.map((group) => ({
          fieldIds: group.fields.map((field) => field.id),
          id: group.id,
          title: group.title,
        })),
        id: slot.id,
        selected: slot.id === activeSlot?.id,
        title: slotName(slot),
      })),
      selection: {
        fieldQuery,
        profileId: selectedProfile || null,
        saveId: selectedSaveId || null,
        slotId: activeSlot?.id ?? null,
      },
      profiles:
        profiles?.map((profile) => ({
          id: profile.identity.id,
          name: profile.identity.name,
          platform: profile.platform,
          supportedSaveSizes: profile.supported_save_sizes,
        })) ?? null,
      emulatorSaves: sramSaves.map((record) => ({
        id: record.gameId,
        label: record.label,
        size: record.sram?.byteLength,
      })),
      pendingChangeCount: pendingChanges.length,
      preview,
      output: output ? { fileName: output.fileName, size: output.size } : null,
      replacement: { pending: pendingReplacement, undoAvailable },
      test: { available: !!onSelectTab, compatible: canTest, status: testStatus },
    }),
    actions: {
      preview: {
        description: "Preview the current field changes.",
        enabled: pendingChanges.length > 0 && !busy && !hasErrors,
        execute: () => void previewChanges(),
      },
      write: {
        description: "Write and download an edited save.",
        enabled: !!document && (pendingChanges.length > 0 || generated) && !busy && !hasErrors && !output,
        execute: () => void writeEditedSave(),
      },
      download: {
        description: "Download the edited save again.",
        enabled: !!output && !busy,
        execute: () => void downloadEditedSave(),
      },
      test: {
        description: "Test the current save with the emulator workflow.",
        enabled: !!onSelectTab && !!document && !busy && !hasErrors,
        execute: () => void testSave(),
      },
      reset: {
        description: "Reset all edited fields.",
        enabled: pendingChanges.length > 0 && !busy,
        execute: resetAll,
      },
      loadProfiles: {
        description: "Load compatible game profiles for the selected save.",
        enabled: !!source && profiles === null && !busy,
        execute: () => void loadProfiles(),
      },
      openProfile: {
        description: "Open the selected game profile.",
        enabled: !!source && !!selectedProfile && !busy,
        execute: openProfile,
      },
      requestSramReplacement: {
        description: "Show the confirmation for replacing the selected emulator SRAM.",
        enabled: !!selectedSaveId && !!output && !pendingReplacement && !busy,
        execute: () => setPendingReplacement(true),
      },
      replaceSram: {
        description: "Confirm replacement of the selected emulator SRAM.",
        enabled: !!selectedSaveId && !!output && !!originalSram && pendingReplacement && !busy,
        execute: () => void replaceSelectedSram(),
      },
      cancelSramReplacement: {
        description: "Cancel the pending emulator SRAM replacement.",
        enabled: pendingReplacement && !busy,
        execute: () => setPendingReplacement(false),
      },
      undoSramReplacement: {
        description: "Undo the last emulator SRAM replacement.",
        enabled: !!selectedSaveId && !!originalSram && !!replacementSram && undoAvailable && !busy,
        execute: () => void undoReplacement(),
      },
      resetEditor: {
        description: "Remove the save and reset the editor.",
        enabled: !!source && !busy,
        execute: resetEditor,
      },
    },
  });

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
            <span className="save-editor-tag">{localizer.message("ui.saves.editor.readOnly")}</span>
          </span>
        ) : (
          <SaveFieldControl
            disabled={busy}
            error={errorText}
            field={field}
            localizer={localizer}
            onChange={(value) => updateField(field, value)}
            value={values[field.id] || field.value}
          />
        )}
        {changed ? (
          <button
            aria-label={localizer.message("ui.saves.editor.resetField", { label: field.label })}
            className="btn slim ghost save-editor-reset"
            disabled={busy}
            onClick={() => resetField(field)}
            type="button"
          >
            <RotateCcw aria-hidden="true" /> {localizer.message("ui.settings.reset")}
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
        {toggleIdHint(field) ? <span className="save-editor-toggle-id mono">{toggleIdHint(field)}</span> : null}
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
          <span className="save-editor-group-title">{groupTitle(group, localizer)}</span>
          <span className="save-editor-group-count mono">
            {toggles.length && !rows.length
              ? `${on} / ${toggles.length}`
              : groupCount(editable, group.fields.length, localizer)}
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
            {integrity ? (
              <span className={join("save-editor-pill", integrity.state)}>{localizer.message(integrity.labelId)}</span>
            ) : null}
            {selectedSaveId ? (
              <span className="meta-fmt mono">{localizer.message("ui.saves.editor.emulatorSram")}</span>
            ) : null}
          </>
        }
        name={<span className="nm mono">{source.name}</span>}
        onRemove={resetEditor}
        removeLabel={localizer.message("ui.saves.editor.removeSave")}
        state={integrity?.state}
      >
        {document ? (
          <p aria-live="polite" className="save-editor-identity">
            <strong>{document.identity.name}</strong>
            <span>{document.platform.toUpperCase()}</span>
            {document.counter ? (
              <span className="mono">
                {localizer.message("ui.saves.editor.slotIndex", {
                  index: document.counter,
                  slot: document.active_slot,
                })}
              </span>
            ) : (
              <span className="mono">
                {localizer.messageCount("ui.saves.editor.checkedCopies", document.sections.length)}
              </span>
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
              <strong>{localizer.message("ui.saves.editor.chooseFormat")}</strong>
              <span>
                {localizer.messageCount("ui.saves.editor.chooseFormatHint", recognition?.candidates?.length ?? 0)}
              </span>
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
            {localizer.message("ui.saves.editor.unidentified")}{" "}
            {localizer.message(containerName ? "ui.saves.editor.rawSaveSize" : "ui.saves.editor.saveSize")}:{" "}
            {formatByteSize(saveSize)}
            {containerName ? ` · ${localizer.message("ui.saves.editor.container", { name: containerName })}` : ""}
            {potentialFormat
              ? ` · ${localizer.message("ui.saves.editor.potentialFormat", { name: potentialFormat })}`
              : ""}
            . {localizer.message("ui.saves.editor.chooseProfileToOpen")}
          </Notice>
        ) : null}
        <div className="drop-tray-row">
          <span className="drop-tray-label">{localizer.message("ui.saves.editor.gameProfile")}</span>
          <div className="drop-tray-control">
            {profiles?.length ? (
              <>
                <select
                  aria-label={localizer.message("ui.saves.editor.gameProfile")}
                  className="select"
                  disabled={busy}
                  onChange={(event) => setSelectedProfile(event.currentTarget.value)}
                  value={selectedProfile}
                >
                  <option value="">{localizer.message("ui.saves.editor.chooseProfile")}</option>
                  {profiles.map((profile) => (
                    <option key={profile.identity.id} value={profile.identity.id}>
                      {profile.identity.name}
                    </option>
                  ))}
                </select>
                <button className="btn ghost" disabled={busy || !selectedProfile} onClick={openProfile} type="button">
                  {localizer.message("ui.saves.editor.openProfile")}
                </button>
              </>
            ) : null}
            {profiles?.length === 0 ? (
              <span className="drop-tray-note">{localizer.message("ui.saves.editor.noProfiles")}</span>
            ) : null}
            {profiles === null ? (
              <button className="btn ghost" disabled={busy} onClick={() => void loadProfiles()} type="button">
                {localizer.message("ui.saves.editor.chooseGameProfile")}
              </button>
            ) : null}
          </div>
        </div>
      </FileCard>
    </div>
  ) : null;

  const sramList = (
    <div className="drop-tray-row save-editor-stash">
      <span className="drop-tray-label" id="save-editor-emulator-title">
        <Save aria-hidden="true" /> {localizer.message("ui.saves.emulator.title")}
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
          <p className="drop-tray-note">{localizer.message("ui.saves.editor.noEmulatorSaves")}</p>
        </div>
      )}
    </div>
  );

  return (
    <section className="panel save-editor" id="save-editor-container">
      <UnifiedDropZone
        accept={SAVE_ACCEPT}
        addLabel={localizer.message("ui.saves.editor.replaceSave")}
        afterDropZone={
          source ? (
            fileCard
          ) : (
            <>
              <div className="drop-tray save-editor-sources">
                {sramList}
                <SaveGenerator disabled={busy} onError={setError} onGenerate={generateSave} />
              </div>
              {error ? <Notice level="error">{error}</Notice> : null}
            </>
          )
        }
        big={!source}
        disabled={busy}
        guide={WORKFLOW_GUIDES.save}
        heroLabel={localizer.message("ui.saves.editor.heroLabel")}
        heroLabelCoarse={localizer.message("ui.saves.editor.heroLabelCoarse")}
        info={<p>{localizer.message("ui.saves.editor.info")}</p>}
        inputId="save-editor-input-picker"
        lead={{ line1: "ui.hero.saveThesis", description: "ui.hero.saveDescription" }}
        multiple={false}
        num="0x01"
        onFiles={(files) => {
          const selected = files.at(-1);
          if (selected) selectSource(selected);
        }}
        supported={SAVE_SUPPORTED_FILES.map((group) => ({
          extensions: group.extensions,
          label: localizer.message(group.labelId),
        }))}
        title={localizer.message("ui.saves.editor.saveFile")}
      />
      {source ? (
        <>
          <StepSection
            fault={!!error}
            meta={
              pendingChanges.length
                ? localizer.message("ui.saves.editor.pending", { count: pendingChanges.length })
                : undefined
            }
            num="0x02"
            title={localizer.message("ui.saves.editor.step.fields")}
            woven={pendingChanges.length > 0}
          >
            {document && activeSlot ? (
              <div className="save-editor-fields">
                <div className="save-editor-toolbar">
                  {hasSlotTabs ? (
                    <div
                      aria-label={localizer.message("ui.saves.editor.saveFiles")}
                      className="save-editor-slots"
                      role="tablist"
                    >
                      {slots.map((slot) => (
                        <button
                          aria-selected={slot.id === activeSlot.id}
                          className="save-editor-slot"
                          key={slot.id}
                          onClick={() => setSelectedSlot(slot.id)}
                          role="tab"
                          type="button"
                        >
                          {slotName(slot, slotTitle(slot, localizer))}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <label className="save-editor-search">
                    <Search aria-hidden="true" />
                    <input
                      aria-label={localizer.message("ui.saves.editor.findProperty")}
                      className="input"
                      onChange={(event) => setFieldQuery(event.currentTarget.value)}
                      placeholder={localizer.message("ui.saves.editor.findProperty")}
                      type="search"
                      value={fieldQuery}
                    />
                  </label>
                </div>
                {visibleGroups.length ? (
                  visibleGroups.map(renderGroup)
                ) : (
                  <p className="save-editor-empty" role="status">
                    {localizer.message("ui.saves.editor.noMatch")}
                  </p>
                )}
              </div>
            ) : (
              <p className="save-editor-empty">
                {busy
                  ? localizer.message("ui.saves.editor.reading")
                  : localizer.message("ui.saves.editor.chooseSupported")}
              </p>
            )}
            {error ? (
              <Notice level="error" onDismiss={() => setError("")}>
                {error}
              </Notice>
            ) : null}
          </StepSection>
          <StepSection num="0x03" title={localizer.message("ui.cheats.write")} woven={!!output}>
            {pendingChanges.length ? (
              <ul aria-live="polite" className="save-editor-ledger">
                {pendingChanges.map(({ field, next, original }) => (
                  <li className="save-editor-chip" key={field.id}>
                    <span>{field.label}</span>
                    <span className="mono">
                      {displayValue(original, localizer)} → {displayValue(next, localizer)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="save-editor-empty">
                {generated
                  ? localizer.message("ui.saves.editor.freshReady")
                  : localizer.message("ui.saves.editor.noChanges")}
              </p>
            )}
            {preview ? (
              <div aria-live="polite" className="save-editor-preview mono">
                {localizer.messageCount("ui.saves.editor.previewChanges", preview.changes?.length || 0, {
                  integrity: localizer.message(
                    preview.output_valid ? "ui.saves.editor.integrityValid" : "ui.saves.editor.integrityInvalid",
                  ),
                })}
                {preview.touched_sections?.length
                  ? ` · ${localizer.message("ui.saves.editor.sections", { sections: preview.touched_sections.join(", ") })}`
                  : ""}
              </div>
            ) : null}
            <div className="save-editor-run-row">
              {output ? (
                <RunButton
                  disabled={busy}
                  icon={<Download aria-hidden="true" />}
                  onClick={() => void downloadEditedSave()}
                >
                  {localizer.message("ui.saves.editor.downloadEdited")}
                </RunButton>
              ) : (
                <RunButton
                  disabled={!(pendingChanges.length || generated) || busy || hasErrors || !document}
                  icon={<Download aria-hidden="true" />}
                  onClick={() => void writeEditedSave()}
                >
                  {localizer.message("ui.saves.editor.downloadEdited")}
                </RunButton>
              )}
              {onSelectTab ? (
                <button
                  className="btn save-editor-test"
                  disabled={!document || busy || hasErrors}
                  onClick={() => void testSave()}
                  type="button"
                >
                  <Gamepad aria-hidden="true" />{" "}
                  {canTest
                    ? localizer.message("ui.saves.editor.testInRom")
                    : localizer.message("ui.saves.editor.chooseRomTest")}
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
                {localizer.message("ui.saves.editor.resetAll")}
              </button>
              <button
                className="btn slim ghost"
                disabled={!pendingChanges.length || busy || hasErrors}
                onClick={() => void previewChanges()}
                type="button"
              >
                {localizer.message("ui.saves.editor.preview")}
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
                  {localizer.message("ui.saves.editor.replaceSram")}
                </button>
                {pendingReplacement ? (
                  <span role="alert">
                    {localizer.message("ui.saves.editor.replaceWarning")}{" "}
                    <button className="btn slim danger" onClick={() => void replaceSelectedSram()} type="button">
                      {localizer.message("ui.saves.editor.confirm")}
                    </button>
                    <button className="btn slim ghost" onClick={() => setPendingReplacement(false)} type="button">
                      {localizer.message("ui.common.cancel")}
                    </button>
                  </span>
                ) : null}
                {undoAvailable ? (
                  <button className="btn slim ghost" onClick={() => void undoReplacement()} type="button">
                    <Undo2 aria-hidden="true" /> {localizer.message("ui.saves.editor.undoReplacement")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </StepSection>
        </>
      ) : (
        <GhostSteps steps={GHOST_STEPS.map((step) => ({ num: step.num, title: localizer.message(step.titleId) }))} />
      )}
    </section>
  );
};

export { SaveEditor };
export type { SaveEditorProps };
