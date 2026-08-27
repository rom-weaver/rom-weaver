import { Download, RotateCcw, Save as SaveIcon, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  listEmulatorSaves,
  replaceEmulatorSaveSram,
  type EmulatorSaveRecord,
} from "../../storage/browser/emulator-saves.ts";
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
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { StepSection } from "../../public/react/components/ds/layout.tsx";
import type { PageFileDrop } from "../../public/react/public-types.ts";

type SaveEditorProps = { onSessionChange: (active: boolean) => void; pageDrop?: PageFileDrop | null };
type FieldErrors = Record<string, string>;

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
    className: "input save-editor-control",
    disabled,
    id: `save-field-${field.id}`,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange(event.currentTarget.value),
  };
  if (field.kind === "boolean" || field.kind === "bitfield_boolean") {
    return (
      <input
        {...common}
        aria-label={field.label}
        checked={text === "true"}
        className="save-editor-checkbox"
        onChange={(event) => onChange(String(event.currentTarget.checked))}
        type="checkbox"
      />
    );
  }
  if (field.constraints.choices?.length) {
    return (
      <select {...common} className="select save-editor-control" value={text}>
        {field.constraints.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      {...common}
      aria-label={field.label}
      max={field.constraints.max ?? undefined}
      maxLength={field.constraints.max_length ?? undefined}
      min={field.constraints.min ?? undefined}
      step={field.step ?? undefined}
      type={field.kind === "text" || field.kind === "read_only_text" ? "text" : "number"}
      value={text}
    />
  );
};

const SaveEditor = ({ onSessionChange, pageDrop }: SaveEditorProps) => {
  const [source, setSource] = useState<File | null>(null);
  const [document, setDocument] = useState<SaveDocument | null>(null);
  const [recognition, setRecognition] = useState<SaveRecognition | undefined>();
  const [saveSize, setSaveSize] = useState<number>();
  const [potentialFormat, setPotentialFormat] = useState<string>();
  const [sourceRomSha1, setSourceRomSha1] = useState<string>();
  const [values, setValues] = useState<Record<string, SaveValue>>({});
  const [originalValues, setOriginalValues] = useState<Record<string, SaveValue>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [preview, setPreview] = useState<SavePreview | null>(null);
  const [output, setOutput] = useState<PublicOutput | null>(null);
  const [saves, setSaves] = useState<EmulatorSaveRecord[]>([]);
  const [selectedSaveId, setSelectedSaveId] = useState<string>();
  const [originalSram, setOriginalSram] = useState<Uint8Array | null>(null);
  const [replacementSram, setReplacementSram] = useState<Uint8Array | null>(null);
  const [pendingReplacement, setPendingReplacement] = useState(false);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
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
    setPotentialFormat(undefined);
    setSourceRomSha1(undefined);
    setValues({});
    setOriginalValues({});
    setErrors({});
    setPreview(null);
    setSelectedSaveId(undefined);
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

  const inspectSelected = async (file: File, game?: string, romSha1?: string, activeRequest = startRequest()) => {
    const { request, signal } = activeRequest;
    setBusy(true);
    setError("");
    try {
      const { inspectSave } = await loadSaveApi();
      const result = await inspectSave({ fileName: file.name, game, romSha1, signal, source: file });
      if (request !== requestRef.current) return;
      if (!result.document) throw new Error("Save inspection returned no document.");
      setRecognition(result.recognition);
      const nextValues = Object.fromEntries(result.document.fields.map((field) => [field.id, field.value]));
      setDocument(result.document);
      setValues(nextValues);
      setOriginalValues(nextValues);
      setPreview(null);
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
  const assignments =
    document?.fields
      .filter((field) => field.editable)
      .map((field) => {
        const value = values[field.id];
        const original = originalValues[field.id] ?? field.value;
        return value && saveValueToText(value) !== saveValueToText(original)
          ? formatAssignment(field, saveValueToText(value))
          : null;
      })
      .filter((value): value is string => value !== null) || [];
  const pendingChanges =
    document?.fields
      .filter((field) => field.editable)
      .flatMap((field) => {
        const original = originalValues[field.id] ?? field.value;
        const next = values[field.id];
        if (!next || saveValueToText(next) === saveValueToText(original)) return [];
        return [{ field, next, original }];
      }) || [];
  const previewChanges = async () => {
    if (!(source && document) || assignments.length === 0 || Object.values(errors).some(Boolean)) return;
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
  const writeEditedSave = async () => {
    if (!source || assignments.length === 0 || Object.values(errors).some(Boolean)) return;
    const { request, signal } = startRequest();
    setBusy(true);
    setError("");
    try {
      const { setSaveFields } = await loadSaveApi();
      const result = await setSaveFields({
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
        return;
      }
      outputRef.current = result.output;
      setOutput(result.output);
      await result.output.saveAs();
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestRef.current) setBusy(false);
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
  const fieldGroups = document
    ? Array.from(
        document.fields.reduce((groups, field) => {
          const group = field.id.split(".")[0] || "General";
          const fields = groups.get(group) || [];
          fields.push(field);
          groups.set(group, fields);
          return groups;
        }, new Map<string, SaveField[]>()),
      )
    : [];
  const sramSaves = saves.filter((record) => record.sram);

  return (
    <section className="save-editor" id="save-editor-panel">
      <StepSection num="0x01" title="Save file">
        <input
          aria-label="Save file"
          accept=".sav,.srm,.eep,.fla,.sps,.xps,.gsv,application/octet-stream"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) selectSource(file);
          }}
          ref={inputRef}
          type="file"
        />
        <button
          className="btn primary save-editor-pick"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          <SaveIcon aria-hidden="true" /> Choose .sav, .srm, .eep, .fla, .sps, or .gsv
        </button>
        <p className="save-editor-hint">You can also choose SRAM from the saved emulator list below.</p>
        {source ? (
          <p className="save-editor-source mono">
            {source.name} · {formatByteSize(source.size)}
          </p>
        ) : null}
        {document ? (
          <div aria-live="polite" className="save-editor-identity">
            <strong>{document.identity.name}</strong>
            <span>{document.platform.toUpperCase()}</span>
            <span>{document.save_format_name}</span>
            <span>Integrity: {document.integrity.state.replaceAll("_", " ")}</span>
            <span>Active slot: {document.active_slot}</span>
            <span>Save index: {document.counter}</span>
          </div>
        ) : null}
        {kind === "ambiguous" ? (
          <div aria-live="polite" className="save-editor-candidates">
            <strong>Choose the game format</strong>
            {(recognition?.candidates || []).map((candidate) => (
              <button
                className="btn slim ghost"
                disabled={busy}
                key={candidate.identity.id}
                onClick={() => {
                  if (!source) return;
                  setRecognition(undefined);
                  const activeRequest = startRequest();
                  void inspectSelected(source, candidate.identity.id, sourceRomSha1, activeRequest);
                }}
                type="button"
              >
                {candidate.identity.name} ({candidate.identity.family})
              </button>
            ))}
          </div>
        ) : null}
        {kind === "unsupported" ? (
          <Notice level="warn">
            ROMWeaver does not have an editor for this game. Save size: {formatByteSize(saveSize)}
            {potentialFormat ? ` · Potential format: ${potentialFormat}` : ""}. The original file remains unchanged.
          </Notice>
        ) : null}
      </StepSection>
      <StepSection fault={!!error} num="0x02" title="Fields" woven={!!document}>
        {document ? (
          <div className="save-editor-fields">
            {fieldGroups.map(([group, fields]) => (
              <fieldset className="save-editor-field-group" key={group}>
                <legend>{group}</legend>
                {fields.map((field) => {
                  const errorText = errors[field.id];
                  return (
                    <div className="save-editor-field" key={field.id}>
                      <label htmlFor={`save-field-${field.id}`}>{field.label}</label>
                      {field.description ? (
                        <span className="save-editor-description" id={`save-field-description-${field.id}`}>
                          {field.description}
                        </span>
                      ) : null}
                      {field.editable ? (
                        <SaveFieldControl
                          error={errorText}
                          disabled={busy}
                          field={field}
                          onChange={(value) => updateField(field, value)}
                          value={values[field.id] || field.value}
                        />
                      ) : (
                        <output className="save-editor-readonly" id={`save-field-${field.id}`}>
                          {saveValueToText(field.value)}
                        </output>
                      )}
                      {errorText ? (
                        <span className="save-editor-field-error" id={`save-field-error-${field.id}`} role="alert">
                          {errorText}
                        </span>
                      ) : null}
                      {field.editable ? (
                        <button
                          aria-label={`Reset ${field.label}`}
                          className="btn slim ghost"
                          disabled={busy}
                          onClick={() => resetField(field)}
                          type="button"
                        >
                          <RotateCcw aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </fieldset>
            ))}
            {assignments.length ? (
              <p aria-live="polite" className="save-editor-pending">
                {assignments.length} pending {assignments.length === 1 ? "change" : "changes"}
              </p>
            ) : null}
            <div className="save-editor-actions">
              <button
                className="btn slim ghost"
                disabled={!assignments.length || busy}
                onClick={resetAll}
                type="button"
              >
                Reset all
              </button>
              <button
                className="btn slim ghost"
                disabled={!assignments.length || busy}
                onClick={() => void previewChanges()}
                type="button"
              >
                Preview changes
              </button>
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
                  disabled={!assignments.length || busy || Object.values(errors).some(Boolean)}
                  icon={<Download aria-hidden="true" />}
                  onClick={() => void writeEditedSave()}
                >
                  Download edited copy
                </RunButton>
              )}
            </div>
            {pendingChanges.length ? (
              <aside aria-live="polite" className="save-editor-pending">
                <strong>Pending changes</strong>
                <ul>
                  {pendingChanges.map(({ field, next, original }) => (
                    <li key={field.id}>
                      <span>{field.label}</span>
                      <span className="mono">
                        {saveValueToText(original)} → {saveValueToText(next)}
                      </span>
                    </li>
                  ))}
                </ul>
              </aside>
            ) : null}
          </div>
        ) : (
          <p className="save-editor-empty">Choose a supported save to inspect its fields.</p>
        )}
        {preview ? (
          <div aria-live="polite" className="save-editor-preview">
            {preview.changes?.length || 0} field changes · integrity {preview.output_valid ? "valid" : "invalid"}
          </div>
        ) : null}
        {error ? (
          <Notice level="error" onDismiss={() => setError("")}>
            {error}
          </Notice>
        ) : null}
      </StepSection>
      <StepSection num="0x03" title="Emulator SRAM">
        {sramSaves.length ? (
          <div className="save-editor-emulator-list">
            {sramSaves.map((record) => (
              <button
                className="btn slim ghost"
                disabled={busy}
                key={record.gameId}
                onClick={() => chooseEmulatorSave(record)}
                type="button"
              >
                {record.label} · {formatByteSize(record.sram?.byteLength)}
              </button>
            ))}
          </div>
        ) : (
          <p className="save-editor-empty">No stored SRAM records.</p>
        )}
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
      <button className="btn slim ghost save-editor-reset" disabled={busy} onClick={resetEditor} type="button">
        Reset editor
      </button>
    </section>
  );
};

export { SaveEditor };
