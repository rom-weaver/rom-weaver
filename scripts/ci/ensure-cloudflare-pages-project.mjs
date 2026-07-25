#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

export async function ensurePagesProject({ accountId, token, project, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: project, production_branch: "main" }),
  });
  const body = await response.json();
  if (body.success) return "created";
  if ((body.errors || []).some((error) => error.code === 8000002 || /already exists/i.test(error.message || ""))) return "exists";
  throw new Error(`unexpected response creating '${project}':\n${JSON.stringify(body, null, 2)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensurePagesProject({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, project: process.env.PROJECT });
    process.stdout.write(`${result === "created" ? "created" : "already exists"} Pages project '${process.env.PROJECT}'\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
