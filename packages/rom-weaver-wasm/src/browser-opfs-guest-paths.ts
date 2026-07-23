import { PATH_SEPARATOR_REGEX } from "./browser-opfs-constants.ts";
import { assertDirectoryHandle } from "./browser-opfs-runtime-env.ts";
import type { FileSystemDirectoryHandleLike } from "./browser-opfs-runtime-types.ts";
import { normalizeGuestPath } from "./rom-weaver-runtime-utils.ts";

export function normalizeMountHandleMap({ mountHandles }: { mountHandles?: Record<string, unknown> | null }) {
  const normalized: Record<string, FileSystemDirectoryHandleLike> = {};
  if (!mountHandles) return normalized;

  for (const [guestPath, handle] of Object.entries(mountHandles)) {
    const normalizedGuestPath = normalizeGuestPath(guestPath, {
      label: `mountHandles[${guestPath}]`,
    });
    assertDirectoryHandle(handle, `mountHandles[${guestPath}]`);
    // assertDirectoryHandle throws above unless handle structurally matches a directory handle.
    normalized[normalizedGuestPath] = handle as FileSystemDirectoryHandleLike;
  }

  return normalized;
}

export function normalizeWritableRoots({
  workGuestPath,
  writableDirectories,
  inherited,
}: {
  workGuestPath: string;
  writableDirectories?: unknown;
  inherited?: string[];
}) {
  const roots = new Set(inherited ?? [workGuestPath]);
  for (const root of normalizeGuestPathList(writableDirectories, "writableDirectories")) roots.add(root);
  return [...roots].sort((a, b) => a.localeCompare(b));
}

function normalizeGuestPathList(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of guest paths`);
  return value.map((entry) => normalizeGuestPath(String(entry), { label }));
}

export function normalizeKnownInputPaths(value: unknown) {
  return normalizeGuestPathList(value, "knownInputPaths");
}

export function isGuestPathWithinRoots(path: unknown, roots: readonly string[]) {
  const normalizedPath = normalizeGuestPath(path, { label: "guest path" });
  for (const root of roots) {
    if (normalizedPath === root || normalizedPath.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function isGuestPathWithinMount(path: string, mountPath: string) {
  return path === mountPath || path.startsWith(`${mountPath}/`);
}

export function joinGuestPath(...parts: unknown[]) {
  const joined = parts
    .map((part, index) => {
      const value = String(part ?? "");
      if (index === 0) return value.replace(/\/+$/, "");
      return value.replace(/^\/+/, "").replace(/\/+$/, "");
    })
    .filter((part) => part.length > 0)
    .join("/");
  return normalizeGuestPath(joined.startsWith("/") ? joined : `/${joined}`, { label: "guest path" });
}

export function normalizeRelativePathParts(value: unknown, { label = "relative path" }: { label?: string } = {}) {
  const parts = String(value ?? "")
    .replace(/^\/+/, "")
    .split(PATH_SEPARATOR_REGEX)
    .filter((part) => part.length > 0);
  for (const part of parts) {
    if (part === "." || part === ".." || part.includes("\0")) {
      throw new TypeError(`${label} contains an unsafe path segment`);
    }
  }
  return parts;
}

export function normalizeStdin(stdin: unknown) {
  if (stdin === undefined || stdin === null) return new Uint8Array();
  if (typeof stdin === "string") return new TextEncoder().encode(stdin);
  if (stdin instanceof Uint8Array) return stdin;
  if (stdin instanceof ArrayBuffer) return new Uint8Array(stdin);
  throw new TypeError("stdin must be a string, Uint8Array, ArrayBuffer, or undefined");
}
