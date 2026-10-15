import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function inside(root, relative, { allowRoot = false } = {}) {
  if (
    typeof relative !== "string" ||
    isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.includes(":") ||
    relative.includes("\0")
  ) {
    throw new Error(`Unsafe relative path: ${relative}`);
  }
  const parts = relative.split("/");
  if (parts.includes("..") || (!allowRoot && (!relative || relative === "."))) {
    throw new Error(`Unsafe relative path: ${relative}`);
  }
  const absolute = resolve(root, relative);
  if (absolute !== resolve(root) && !absolute.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`Path escapes root: ${relative}`);
  }
  let current = resolve(root);
  if (existsSync(current) && lstatSync(current).isSymbolicLink())
    throw new Error(`Refusing symbolic link: ${current}`);
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error(`Refusing symbolic link: ${current}`);
  }
  return absolute;
}

export function files(root, prefix = "") {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`Refusing symbolic link: ${join(root, entry.name)}`);
      if (entry.isDirectory()) return files(join(root, entry.name), relative);
      if (!entry.isFile()) throw new Error(`Unsupported file type: ${relative}`);
      return [relative];
    });
}

export function copy(source, destination) {
  if (!existsSync(source)) throw new Error(`Source does not exist: ${source}`);
  if (lstatSync(source).isDirectory()) files(source);
  else if (!lstatSync(source).isFile()) throw new Error(`Unsupported source type: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

export function differences(expected, actual, preserve = []) {
  const ignored = (path) => preserve.some((name) => path === name || path.startsWith(`${name}/`));
  const expectedFiles = new Set(files(expected).filter((path) => !ignored(path)));
  const actualFiles = new Set(files(actual).filter((path) => !ignored(path)));
  const result = [];
  for (const path of [...new Set([...expectedFiles, ...actualFiles])].sort()) {
    if (!expectedFiles.has(path)) result.push(`unexpected ${path}`);
    else if (!actualFiles.has(path)) result.push(`missing ${path}`);
    else if (!readFileSync(join(expected, path)).equals(readFileSync(join(actual, path))))
      result.push(`changed ${path}`);
  }
  return result;
}
