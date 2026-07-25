/**
 * Guest-path OPFS helpers and assertions shared by the on-device DIAGNOSTIC
 * harnesses (`browser-format-matrix.ts`, `browser-thread-sweep.ts`). Kept free
 * of harness-specific types so the harnesses never import each other.
 */

export const OPFS_GUEST_ROOT = "/work";

/**
 * Structural view of a `runJson` result - avoids importing the harness types.
 * Generic over the event so callers keep their own event type on the terminal
 * event these helpers hand back.
 */
export type GuestRunJsonResult<TEvent = Record<string, unknown>> = {
  error?: unknown;
  events?: readonly TEvent[];
  exitCode?: number;
  ok?: boolean;
  stderr?: string;
};

const TEXT_ENCODER = new TextEncoder();

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, message: string) {
  assert(
    actual.byteLength === expected.byteLength,
    `${message}; length ${actual.byteLength} !== ${expected.byteLength}`,
  );
  for (let index = 0; index < actual.byteLength; index += 1) {
    assert(actual[index] === expected[index], `${message}; byte ${index} ${actual[index]} !== ${expected[index]}`);
  }
}

export function errorMessage(error: unknown) {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorStack(error: unknown) {
  const stack = error && typeof error === "object" ? (error as { stack?: unknown }).stack : undefined;
  if (typeof stack === "string") return stack;
  return "";
}

export function getTerminalEvent<TEvent>(result: GuestRunJsonResult<TEvent>): TEvent {
  // An empty event list means the command died before emitting anything, so the
  // reason is only in `error`/`stderr` - report it rather than the bare shape.
  const context = [
    `exitCode=${result.exitCode}`,
    `ok=${result.ok}`,
    `stderr=${JSON.stringify(result.stderr ?? "")}`,
    `error=${JSON.stringify(errorMessage(result.error))}`,
    `stack=${JSON.stringify(errorStack(result.error))}`,
  ].join(" ");
  assert(Array.isArray(result.events), `runJson result should include events; ${context}`);
  assert(result.events.length > 0, `runJson result should include at least one event; ${context}`);
  const event = result.events.at(-1);
  assert(event, `runJson result should include a terminal event; ${context}`);
  return event;
}

export function assertRunJsonSucceeded<TEvent>(
  result: GuestRunJsonResult<TEvent>,
  options: { command?: string } = {},
): TEvent {
  const event = getTerminalEvent(result);
  const terminal = event as Record<string, unknown>;
  const commandName = options.command ?? "command";
  const failureMessage = [
    `expected ${commandName} to succeed`,
    `exitCode=${result.exitCode}`,
    `ok=${result.ok}`,
    `label=${JSON.stringify(terminal.label ?? "")}`,
    `details=${JSON.stringify(terminal.details ?? null)}`,
    `stderr=${JSON.stringify(result.stderr ?? "")}`,
    `error=${JSON.stringify(errorMessage(result.error))}`,
    `stack=${JSON.stringify(errorStack(result.error))}`,
  ].join(" ");
  assert(result.exitCode === 0, failureMessage);
  assert(result.ok === true, failureMessage);
  assert(terminal.status === "succeeded", failureMessage);
  if (typeof options.command === "string") {
    assert(
      terminal.command === options.command,
      `expected terminal command ${options.command}, got ${String(terminal.command)}`,
    );
  }
  return event;
}

export function toBytes(value: string | Uint8Array | ArrayBuffer) {
  if (typeof value === "string") return TEXT_ENCODER.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("expected string, Uint8Array, or ArrayBuffer");
}

export function joinGuestPath(...parts: string[]) {
  const tokens: string[] = [];
  for (const part of parts) {
    const value = String(part);
    for (const token of value.split("/")) {
      if (token.length > 0) tokens.push(token);
    }
  }
  return `/${tokens.join("/")}`;
}

export function pathBasename(path: string) {
  const normalized = String(path).replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return normalized;
  return normalized.slice(index + 1);
}

export function pathDirname(path: string) {
  const normalized = String(path).replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

function toGuestRelativePath(guestPath: string) {
  const normalized = String(guestPath);
  if (normalized === OPFS_GUEST_ROOT) return "";

  const prefix = `${OPFS_GUEST_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`guest path must start with ${prefix}: ${guestPath}`);
  }

  return normalized.slice(prefix.length);
}

function splitRelativePath(relativePath: string) {
  if (relativePath.length === 0) return [];
  return relativePath.split("/").filter((token) => token.length > 0);
}

async function getOrCreateDirectoryHandle(rootHandle: FileSystemDirectoryHandle, relativeDirectoryPath: string) {
  const segments = splitRelativePath(relativeDirectoryPath);
  let current = rootHandle;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function getGuestFileHandle(
  rootHandle: FileSystemDirectoryHandle,
  guestPath: string,
  { create = false }: { create?: boolean } = {},
) {
  const relativePath = toGuestRelativePath(guestPath);
  const fileName = pathBasename(relativePath);
  const parentPath = pathDirname(relativePath);
  const parentHandle = await getOrCreateDirectoryHandle(rootHandle, parentPath === "/" ? "" : parentPath);
  return parentHandle.getFileHandle(fileName, { create });
}

export async function readGuestFile(rootHandle: FileSystemDirectoryHandle, guestPath: string) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath);
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function writeGuestFile(rootHandle: FileSystemDirectoryHandle, guestPath: string, contents: Uint8Array) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(contents as FileSystemWriteChunkType);
  await writable.close();
}

export async function waitForGuestFile(
  rootHandle: FileSystemDirectoryHandle,
  guestPath: string,
  result: GuestRunJsonResult<unknown>,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const handle = await getGuestFileHandle(rootHandle, guestPath);
      const file = await handle.getFile();
      if (file.size > 0) return;
    } catch {
      // OPFS visibility can lag a completed threaded writer briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`command succeeded without output ${guestPath}; events=${JSON.stringify(result.events)}`);
}

export async function removeFixtureDirectory(rootHandle: FileSystemDirectoryHandle, directoryName: string) {
  try {
    await rootHandle.removeEntry(directoryName, { recursive: true });
  } catch {
    // Best-effort cleanup for browsers that hold transient OPFS locks after worker termination.
  }
}
