#!/usr/bin/env node

import process from "node:process";
import { MARKDOWN_ROUTES } from "../../packages/rom-weaver-webapp/functions/markdown-routes.js";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const CACHE_RULE_DESCRIPTION = "rom-weaver: cache immutable /assets (managed by ci.yml)";
export const CACHE_RULE_EXPRESSION =
  '(http.host in {"rom-weaver.com" "beta.rom-weaver.com" "nightly.rom-weaver.com"}) and starts_with(http.request.uri.path, "/assets/")';

export const PAGE_CACHE_RULE_DESCRIPTION = "rom-weaver: cache negotiated pages (managed by ci.yml)";
export const PAGE_CACHE_RULE_EXPRESSION = `(http.host in {"rom-weaver.com" "beta.rom-weaver.com" "nightly.rom-weaver.com"}) and http.request.uri.path in {${MARKDOWN_ROUTES.map(
  ({ path }) => path,
)
  .map((path) => JSON.stringify(path))
  .join(" ")}}`;

export function pageCacheRule() {
  return {
    description: PAGE_CACHE_RULE_DESCRIPTION,
    expression: PAGE_CACHE_RULE_EXPRESSION,
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "respect_origin",
        status_code_ttl: [{ status_code_range: { from: 300, to: 599 }, value: -1 }],
      },
      // Browsers MUST revalidate stable page URLs because zone purges cannot clear browser caches.
      // https://developers.cloudflare.com/cache/how-to/cache-rules/settings/#browser-ttl
      browser_ttl: { mode: "respect_origin" },
      // Accept MUST remain unchanged because quality values select the representation.
      // https://developers.cloudflare.com/cache/concepts/vary/
      vary: {
        default: { action: "bypass" },
        headers: { accept: { action: "passthrough" }, "accept-encoding": { action: "normalize" } },
      },
    },
    enabled: true,
  };
}

export function cacheRule() {
  return {
    description: CACHE_RULE_DESCRIPTION,
    expression: CACHE_RULE_EXPRESSION,
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "respect_origin",
        status_code_ttl: [{ status_code_range: { from: 300, to: 599 }, value: -1 }],
      },
    },
    enabled: true,
  };
}

export async function ensureCacheRule({ zoneId, token, fetchImpl = globalThis.fetch, sleep = setTimeout }) {
  if (!zoneId) return "skipped";
  const api = `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/phases/http_request_cache_settings/entrypoint`;
  const headers = { Authorization: `Bearer ${token}` };
  let read;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    read = await fetchImpl(api, { headers, signal: AbortSignal.timeout(30000) });
    if (read.status < 500 || read.status > 599 || attempt === 2) break;
    // Discarding a failed body MUST NOT prevent retrying after an upstream disconnect.
    await read.body?.cancel().catch(() => undefined);
    const delay = 1000 * (attempt + 1);
    process.stderr.write(`Cloudflare cache ruleset read returned HTTP ${read.status}; retrying in ${delay} ms\n`);
    await sleep(delay);
  }
  if (read.status === 404) return installRule(api, headers, [], fetchImpl);
  const body = await read.json();
  if (read.status !== 200)
    throw new Error(`Cloudflare cache ruleset read returned HTTP ${read.status}\n${JSON.stringify(body, null, 2)}`);
  if (!body.success)
    throw new Error(`Cloudflare cache ruleset read was not successful\n${JSON.stringify(body, null, 2)}`);
  const rules = body.result?.rules || [];
  if (
    [cacheRule(), pageCacheRule()].every((desired) =>
      rules.some(
        (rule) =>
          rule.description === desired.description &&
          rule.expression === desired.expression &&
          rule.action === desired.action &&
          rule.enabled === desired.enabled &&
          isDeepStrictEqual(rule.action_parameters, desired.action_parameters),
      ),
    )
  )
    return "exists";
  return installRule(api, headers, rules, fetchImpl);
}

async function installRule(api, headers, rules, fetchImpl) {
  const merged = [
    ...rules.filter((rule) => ![CACHE_RULE_DESCRIPTION, PAGE_CACHE_RULE_DESCRIPTION].includes(rule.description)),
    cacheRule(),
    pageCacheRule(),
  ];
  const response = await fetchImpl(api, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ rules: merged }),
  });
  const body = await response.json();
  if (response.status < 200 || response.status >= 300 || !body.success)
    throw new Error(`unexpected response installing zone cache rule:\n${JSON.stringify(body, null, 2)}`);
  return "installed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensureCacheRule({
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    process.stdout.write(
      result === "skipped"
        ? "::notice::CLOUDFLARE_ZONE_ID not set; skipping zone cache rule\n"
        : `zone cache rule ${result}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
