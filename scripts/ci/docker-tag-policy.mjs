#!/usr/bin/env node

// Which moving Docker tags a version is allowed to claim.
//
// Read by both jobs in docker-publish.yml: the per-architecture builds need the
// normalized version for their OCI labels, and the publish job needs the whole
// policy to decide the manifest list's tags. One source so a prerelease cannot
// be labelled one way and tagged another.

import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runMain } from "../run-main.mjs";

export function tagPolicy(rawVersion) {
  const version = String(rawVersion ?? "").replace(/^v/, "");
  if (!version) throw new Error("no version given; expected `X.Y.Z` or `vX.Y.Z`");

  // A hyphen is the semver prerelease marker, and it is the only signal the
  // release fan-out has: `latest` and the series tags must never move to an
  // alpha, or `docker pull rom-weaver` serves one.
  const release = !version.includes("-");
  // `0` would float across 0.5 -> 0.6, which semver treats as breaking, so the
  // major series tag only starts at 1.0.0.
  const majorTag = release && version.split(".")[0] !== "0";

  return { version, release, majorTag };
}

export function main(argv = process.argv.slice(2)) {
  const { version, release, majorTag } = tagPolicy(argv[0] ?? process.env.VERSION);
  const lines = [`version=${version}`, `release=${release}`, `major_tag=${majorTag}`];
  process.stdout.write(`${lines.join(" ")}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(() => main());
