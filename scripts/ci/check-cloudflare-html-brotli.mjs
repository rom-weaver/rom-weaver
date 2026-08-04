#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const parseHeaders = (text) => {
  const blocks = text.split(/\r?\n\r?\n/).filter((block) => /^HTTP\/\S+ \d{3}/m.test(block));
  const lastBlock = blocks.at(-1) ?? "";
  const headers = new Map();
  for (const line of lastBlock.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
};

export const assertExactBrotliResponse = ({
  document,
  sidecar,
  documentHeaders,
  sidecarHeaders,
}) => {
  if (documentHeaders.get("content-encoding") !== "br") {
    throw new Error("document response did not use Brotli content encoding");
  }

  const documentLength = Number(documentHeaders.get("content-length"));
  if (!Number.isInteger(documentLength) || documentLength !== document.byteLength) {
    throw new Error(
      `document Content-Length ${documentHeaders.get("content-length") ?? "(missing)"} does not match ${document.byteLength} bytes`,
    );
  }

  const sidecarLength = Number(sidecarHeaders.get("content-length"));
  if (!Number.isInteger(sidecarLength) || sidecarLength !== sidecar.byteLength) {
    throw new Error(
      `sidecar Content-Length ${sidecarHeaders.get("content-length") ?? "(missing)"} does not match ${sidecar.byteLength} bytes`,
    );
  }

  if (!document.equals(sidecar)) {
    throw new Error(
      `document Brotli bytes differ from the sidecar (${document.byteLength} versus ${sidecar.byteLength} bytes)`,
    );
  }
};

const fetchRawResponse = async (url, acceptEncoding, directory, name) => {
  const headerPath = path.join(directory, `${name}.headers`);
  const bodyPath = path.join(directory, `${name}.body`);
  await execFileAsync("curl", [
    "--fail-with-body",
    "--silent",
    "--show-error",
    "--location",
    "--proto",
    "=https",
    "--tlsv1.2",
    "--header",
    `Accept-Encoding: ${acceptEncoding}`,
    "--dump-header",
    headerPath,
    "--output",
    bodyPath,
    url,
  ]);
  return {
    body: await readFile(bodyPath),
    headers: parseHeaders(await readFile(headerPath, "utf8")),
  };
};

export const checkCloudflareHtmlBrotli = async ({ deploymentUrl, tempDirectory = null }) => {
  if (!deploymentUrl) throw new Error("DEPLOYMENT_URL is required");
  const baseUrl = deploymentUrl.replace(/\/+$/, "");
  const directory =
    tempDirectory ?? (await mkdtemp(path.join(os.tmpdir(), "rom-weaver-html-brotli-")));
  try {
    const [document, sidecar] = await Promise.all([
      fetchRawResponse(`${baseUrl}/apply`, "br", directory, "document"),
      fetchRawResponse(`${baseUrl}/apply/index.html.br`, "identity", directory, "sidecar"),
    ]);
    assertExactBrotliResponse({
      document: document.body,
      sidecar: sidecar.body,
      documentHeaders: document.headers,
      sidecarHeaders: sidecar.headers,
    });
    return document.body.byteLength;
  } finally {
    if (tempDirectory === null) await rm(directory, { force: true, recursive: true });
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const bytes = await checkCloudflareHtmlBrotli({ deploymentUrl: process.env.DEPLOYMENT_URL });
    process.stdout.write(`Cloudflare HTML Brotli smoke passed: ${bytes} exact bytes\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
