#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

export const CACHE_RULE_DESCRIPTION = "rom-weaver: cache immutable /assets (managed by ci.yml)";
export const CACHE_RULE_EXPRESSION = '(http.host in {"rom-weaver.com" "beta.rom-weaver.com" "nightly.rom-weaver.com"}) and starts_with(http.request.uri.path, "/assets/")';

export function cacheRule() {
  return { description: CACHE_RULE_DESCRIPTION, expression: CACHE_RULE_EXPRESSION, action: "set_cache_settings", action_parameters: { cache: true, edge_ttl: { mode: "respect_origin" } }, enabled: true };
}

export async function ensureCacheRule({ zoneId, token, fetchImpl = globalThis.fetch }) {
  if (!zoneId) return "skipped";
  const api = `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/phases/http_request_cache_settings/entrypoint`;
  const headers = { Authorization: `Bearer ${token}` };
  const read = await fetchImpl(api, { headers });
  if (read.status === 404) return installRule(api, headers, [], fetchImpl);
  const body = await read.json();
  if (read.status !== 200) throw new Error(`Cloudflare cache ruleset read returned HTTP ${read.status}\n${JSON.stringify(body, null, 2)}`);
  if (!body.success) throw new Error(`Cloudflare cache ruleset read was not successful\n${JSON.stringify(body, null, 2)}`);
  const rules = body.result?.rules || [];
  if (rules.some((rule) => rule.description === CACHE_RULE_DESCRIPTION && rule.expression === CACHE_RULE_EXPRESSION)) return "exists";
  return installRule(api, headers, rules, fetchImpl);
}

async function installRule(api, headers, rules, fetchImpl) {
  const merged = [...rules.filter((rule) => rule.description !== CACHE_RULE_DESCRIPTION), cacheRule()];
  const response = await fetchImpl(api, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ rules: merged }) });
  const body = await response.json();
  if (!body.success) throw new Error(`unexpected response installing zone cache rule:\n${JSON.stringify(body, null, 2)}`);
  return "installed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensureCacheRule({ zoneId: process.env.CLOUDFLARE_ZONE_ID, token: process.env.CLOUDFLARE_API_TOKEN });
    process.stdout.write(result === "skipped" ? "::notice::CLOUDFLARE_ZONE_ID not set; skipping zone cache rule\n" : `zone cache rule ${result}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
