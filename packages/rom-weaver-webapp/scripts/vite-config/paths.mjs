import path from "node:path";
import process from "node:process";

export const rootDir = process.cwd();
export const repoRoot = path.resolve(rootDir, "../..");
