#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

export const VENDORED_PATHS = [
  "crates/rom-weaver-containers/libarchive/vendor",
  "crates/rom-weaver-containers/src/nod",
  "crates/rom-weaver-containers/src/xdvdfs",
];

export const vendoredExclusions = () => VENDORED_PATHS.map((path) => `:(exclude)${path}`);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${vendoredExclusions().join("\n")}\n`);
}
