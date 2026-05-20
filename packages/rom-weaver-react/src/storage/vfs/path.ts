const DEFAULT_VFS_ROOT = "/workspace";

type AbsoluteVfsPath = string & {
  readonly __absoluteVfsPath: unique symbol;
};

const NUL_BYTE_REGEX = /\0/;

const assertSafePathText = (value: string, label: string) => {
  if (!value) throw new Error(`${label} is required`);
  if (NUL_BYTE_REGEX.test(value)) throw new Error(`${label} cannot contain null bytes`);
  if (value.includes("\\")) throw new Error(`${label} must use POSIX separators`);
};

const normalizePathSegments = (value: string, label: string): string[] => {
  assertSafePathText(value, label);
  return value
    .replace(/\/+/g, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment === "." || segment === "..") throw new Error(`${label} cannot contain relative segments`);
      return segment;
    });
};

const normalizeVfsRoot = (root = DEFAULT_VFS_ROOT): AbsoluteVfsPath => {
  if (typeof root !== "string") throw new Error("VFS root must be a string");
  const segments = normalizePathSegments(root.startsWith("/") ? root : `/${root}`, "VFS root");
  if (!segments.length) throw new Error("VFS root cannot be empty");
  return `/${segments.join("/")}` as AbsoluteVfsPath;
};

const normalizeAbsoluteVfsPath = (filePath: string, root = DEFAULT_VFS_ROOT): AbsoluteVfsPath => {
  const normalizedRoot = normalizeVfsRoot(root);
  if (typeof filePath !== "string" || !filePath.startsWith("/")) throw new Error("VFS paths must be absolute");
  const normalizedPath = `/${normalizePathSegments(filePath, "VFS path").join("/")}` as AbsoluteVfsPath;
  if (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath;
  throw new Error(`VFS path escapes configured root: ${filePath}`);
};

const normalizeRelativeVfsPath = (filePath: string, label = "VFS relative path") => {
  if (typeof filePath !== "string") throw new Error(`${label} must be a string`);
  return normalizePathSegments(filePath.replace(/^\/+/, ""), label).join("/");
};

const joinVfsPath = (root: string, ...segments: string[]): AbsoluteVfsPath => {
  const normalizedRoot = normalizeVfsRoot(root);
  const relativePath = segments
    .filter((segment) => String(segment || "").trim())
    .map((segment) => normalizeRelativeVfsPath(segment, "VFS path segment"))
    .filter(Boolean)
    .join("/");
  return normalizeAbsoluteVfsPath(relativePath ? `${normalizedRoot}/${relativePath}` : normalizedRoot, normalizedRoot);
};

const getVfsRelativePath = (filePath: string, root = DEFAULT_VFS_ROOT) => {
  const normalizedRoot = normalizeVfsRoot(root);
  const normalizedPath = normalizeAbsoluteVfsPath(filePath, normalizedRoot);
  return normalizedPath === normalizedRoot ? "" : normalizedPath.slice(normalizedRoot.length + 1);
};

export type { AbsoluteVfsPath };
export {
  DEFAULT_VFS_ROOT,
  getVfsRelativePath,
  joinVfsPath,
  normalizeAbsoluteVfsPath,
  normalizeRelativeVfsPath,
  normalizeVfsRoot,
};
