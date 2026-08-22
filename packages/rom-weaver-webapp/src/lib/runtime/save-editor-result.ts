import type {
  SaveChangePreview,
  SaveConstraint,
  SaveDocument,
  SaveField,
  SaveFieldKind,
  SaveGameCandidate,
  SaveRecognition,
  SaveValue,
} from "../../wasm/generated/rom-weaver-rust-types.d.ts";

type SaveCandidate = SaveGameCandidate;
type SaveFieldConstraints = SaveConstraint;
type SavePreview = SaveChangePreview;
type SaveEditorResult = {
  recognition?: SaveRecognition;
  document?: SaveDocument;
  preview?: SavePreview;
  field?: SaveField;
  schema?: unknown;
  saveSize?: number;
  potentialFormat?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const readSaveValue = (value: unknown): SaveValue | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.u32 === "number") return { u32: value.u32 };
  if (typeof value.i32 === "number") return { i32: value.i32 };
  if (typeof value.text === "string") return { text: value.text };
  if (typeof value.bool === "boolean") return { bool: value.bool };
  if (typeof value.enum === "string") return { enum: value.enum };
  if (Array.isArray(value.list)) {
    const list = value.list.map(readSaveValue);
    return list.every((item): item is SaveValue => !!item) ? { list } : undefined;
  }
  if (Array.isArray(value.table)) {
    const table = value.table.map((row) => {
      if (!isRecord(row)) return undefined;
      const entries = Object.entries(row).map(([key, item]) => [key, readSaveValue(item)] as const);
      return entries.every(([, item]) => !!item) ? Object.fromEntries(entries) : undefined;
    });
    return table.every((row) => !!row) ? { table: table as Array<Record<string, SaveValue>> } : undefined;
  }
  if (isRecord(value.object)) {
    const entries = Object.entries(value.object).map(([key, item]) => [key, readSaveValue(item)] as const);
    return entries.every(([, item]) => !!item)
      ? { object: Object.fromEntries(entries) as Record<string, SaveValue> }
      : undefined;
  }
  return undefined;
};

const readSaveField = (value: unknown): SaveField | undefined => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    typeof value.kind !== "string"
  )
    return undefined;
  const fieldValue = readSaveValue(value.value);
  if (!fieldValue) return undefined;
  const rawConstraints = isRecord(value.constraints) ? value.constraints : {};
  const constraints: SaveFieldConstraints = {
    min: typeof rawConstraints.min === "number" ? rawConstraints.min : null,
    max: typeof rawConstraints.max === "number" ? rawConstraints.max : null,
    max_length: typeof rawConstraints.max_length === "number" ? rawConstraints.max_length : null,
    choices: Array.isArray(rawConstraints.choices)
      ? rawConstraints.choices.filter((choice): choice is string => typeof choice === "string")
      : [],
  };
  return {
    id: value.id,
    label: value.label,
    section_id: typeof value.section_id === "number" ? value.section_id : 0,
    kind: value.kind as SaveFieldKind,
    value: fieldValue,
    editable: value.editable === true,
    description: typeof value.description === "string" ? value.description : "",
    constraints,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    step: typeof value.step === "number" ? value.step : null,
    encoding: typeof value.encoding === "string" ? value.encoding : null,
  };
};

const readSaveEditorDetails = (details: unknown): Record<string, unknown> | null => {
  if (!isRecord(details)) return null;
  const value = details.save_editor;
  return isRecord(value) ? value : null;
};

const parseSaveEditorResult = (details: unknown): SaveEditorResult => {
  const value = readSaveEditorDetails(details);
  if (!value) throw new Error("Save editor result was missing details.save_editor");
  const fields =
    isRecord(value.document) && Array.isArray(value.document.fields)
      ? value.document.fields.map(readSaveField).filter((field): field is SaveField => !!field)
      : undefined;
  const document =
    fields && isRecord(value.document) ? ({ ...value.document, fields } as unknown as SaveDocument) : undefined;
  const result = isRecord(value.result) ? value.result : undefined;
  const resultFields =
    result && isRecord(result.document) && Array.isArray(result.document.fields)
      ? result.document.fields.map(readSaveField).filter((field): field is SaveField => !!field)
      : undefined;
  const resultDocument =
    resultFields && result && isRecord(result.document)
      ? ({ ...result.document, fields: resultFields } as unknown as SaveDocument)
      : undefined;
  const field = readSaveField(value.field);
  const preview = isRecord(value.preview) ? (value.preview as unknown as SavePreview) : undefined;
  return {
    ...(isRecord(value.recognition) ? { recognition: value.recognition as unknown as SaveRecognition } : {}),
    ...(resultDocument ? { document: resultDocument } : document ? { document } : {}),
    ...(result && isRecord(result.preview) ? { preview: result.preview as unknown as SavePreview } : {}),
    ...(preview && !(result && isRecord(result.preview)) ? { preview } : {}),
    ...(field ? { field } : {}),
    ...(value.schema === undefined ? {} : { schema: value.schema }),
    ...(typeof value.save_size === "number" ? { saveSize: value.save_size } : {}),
    ...(typeof value.potential_format === "string" ? { potentialFormat: value.potential_format } : {}),
  };
};

const saveValueToText = (value: SaveValue): string => {
  if ("u32" in value) return String(value.u32);
  if ("i32" in value) return String(value.i32);
  if ("bool" in value) return String(value.bool);
  if ("enum" in value) return value.enum;
  if ("list" in value || "table" in value || "object" in value) {
    const nested = "list" in value ? value.list : "table" in value ? value.table : value.object;
    return JSON.stringify(nested);
  }
  return value.text;
};

const saveValueFromText = (kind: SaveFieldKind, value: string): SaveValue => {
  if (kind === "boolean" || kind === "bitfield_boolean") return { bool: value === "true" };
  if (kind === "unsigned_integer") return { u32: Number(value) };
  if (kind === "signed_integer") return { i32: Number(value) };
  if (kind === "enum") return { enum: value };
  return { text: value };
};

export type { SaveCandidate, SaveDocument, SaveEditorResult, SaveField, SavePreview, SaveRecognition, SaveValue };
export { parseSaveEditorResult, saveValueFromText, saveValueToText };
