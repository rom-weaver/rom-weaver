#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const MARKDOWN_RULE_DESCRIPTION = "rom-weaver: serve Markdown for documentation (managed by ci.yml)";
export const MARKDOWN_RULE_EXPRESSION =
  '(http.host in {"rom-weaver.com" "beta.rom-weaver.com" "nightly.rom-weaver.com"}) and (http.request.uri.path eq "/docs" or starts_with(http.request.uri.path, "/docs/"))';

export function markdownRule() {
  return {
    description: MARKDOWN_RULE_DESCRIPTION,
    expression: MARKDOWN_RULE_EXPRESSION,
    action: "set_config",
    action_parameters: { content_converter: true },
    enabled: true,
  };
}

export async function ensureMarkdownRule({ zoneId, token, fetchImpl = globalThis.fetch }) {
  if (!zoneId) return "skipped";
  const api = `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/phases/http_config_settings/entrypoint`;
  const headers = { Authorization: `Bearer ${token}` };
  const read = await fetchImpl(api, { headers });
  if (read.status === 404) return installRule(api, headers, [], fetchImpl);
  const body = await read.json();
  if (read.status !== 200) {
    throw new Error(`Cloudflare configuration ruleset read returned HTTP ${read.status}\n${JSON.stringify(body, null, 2)}`);
  }
  if (!body.success) {
    throw new Error(`Cloudflare configuration ruleset read was not successful\n${JSON.stringify(body, null, 2)}`);
  }
  const rules = body.result?.rules || [];
  const desired = markdownRule();
  if (
    rules.some(
      (rule) =>
        rule.description === desired.description &&
        rule.expression === desired.expression &&
        rule.action === desired.action &&
        rule.enabled === desired.enabled &&
        isDeepStrictEqual(rule.action_parameters, desired.action_parameters),
    )
  ) {
    return "exists";
  }
  return installRule(api, headers, rules, fetchImpl);
}

async function installRule(api, headers, rules, fetchImpl) {
  const merged = [...rules.filter((rule) => rule.description !== MARKDOWN_RULE_DESCRIPTION), markdownRule()];
  const response = await fetchImpl(api, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ rules: merged }),
  });
  const body = await response.json();
  if (!body.success) {
    throw new Error(`unexpected response installing zone Markdown rule:\n${JSON.stringify(body, null, 2)}`);
  }
  return "installed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensureMarkdownRule({
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    process.stdout.write(
      result === "skipped"
        ? "::notice::CLOUDFLARE_ZONE_ID not set; skipping zone Markdown rule\n"
        : `zone Markdown rule ${result}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
