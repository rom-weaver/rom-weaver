#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  DOCUMENT_ROUTE_EXCLUDES,
  DOCUMENT_ROUTE_INCLUDES,
} from "../../packages/rom-weaver-webapp/functions/document-routes.js";

const CUSTOM_HOSTS = '{"rom-weaver.com" "beta.rom-weaver.com" "nightly.rom-weaver.com"}';
const ERROR_STATUS_TTL = [{ status_code_range: { from: 300, to: 599 }, value: -1 }];
const cloudflareStringSet = (values) => `{${values.map((value) => JSON.stringify(value)).join(" ")}}`;
const cloudflarePathExpression = () => {
  const exactPaths = DOCUMENT_ROUTE_INCLUDES.filter((path) => !path.endsWith("*"));
  const wildcardPaths = DOCUMENT_ROUTE_INCLUDES.filter((path) => path.endsWith("*")).map((path) =>
    path.slice(0, -1),
  );
  const exactExpression = `http.request.uri.path in ${cloudflareStringSet(exactPaths)}`;
  const wildcardExpressions = wildcardPaths.map((path) => {
    const exclusions = DOCUMENT_ROUTE_EXCLUDES.filter((exclude) =>
      exclude.slice(0, -1).startsWith(path),
    ).map((exclude) => `not starts_with(http.request.uri.path, ${JSON.stringify(exclude.slice(0, -1))})`);
    return [`starts_with(http.request.uri.path, ${JSON.stringify(path)})`, ...exclusions].join(" and ");
  });
  return [exactExpression, ...wildcardExpressions].map((expression) => `(${expression})`).join(" or ");
};

export const CACHE_RULE_DESCRIPTION = "rom-weaver: cache immutable /assets (managed by ci.yml)";
export const CACHE_RULE_EXPRESSION = `(http.host in ${CUSTOM_HOSTS}) and starts_with(http.request.uri.path, "/assets/")`;
export const DOCUMENT_CACHE_RULE_DESCRIPTION =
  "rom-weaver: cache HTML documents (managed by ci.yml)";
export const DOCUMENT_CACHE_RULE_EXPRESSION = `(http.host in ${CUSTOM_HOSTS}) and (${cloudflarePathExpression()})`;
export const DOCUMENT_CACHE_TTL_SECONDS = 5 * 60;

export function cacheRule() {
  return {
    description: CACHE_RULE_DESCRIPTION,
    expression: CACHE_RULE_EXPRESSION,
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: { mode: "respect_origin", status_code_ttl: ERROR_STATUS_TTL },
    },
    enabled: true,
  };
}

export function documentCacheRule() {
  return {
    description: DOCUMENT_CACHE_RULE_DESCRIPTION,
    expression: DOCUMENT_CACHE_RULE_EXPRESSION,
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      browser_ttl: { mode: "respect_origin" },
      edge_ttl: {
        mode: "override_origin",
        default: DOCUMENT_CACHE_TTL_SECONDS,
        status_code_ttl: ERROR_STATUS_TTL,
      },
    },
    enabled: true,
  };
}

export const managedCacheRules = () => [cacheRule(), documentCacheRule()];

const matchesDesiredRule = (rule, desired) =>
  rule.description === desired.description &&
  rule.expression === desired.expression &&
  rule.action === desired.action &&
  rule.enabled === desired.enabled &&
  isDeepStrictEqual(rule.action_parameters, desired.action_parameters);

export async function ensureCacheRule({ zoneId, token, fetchImpl = globalThis.fetch }) {
  if (!zoneId) return "skipped";
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required to manage zone cache rules");

  const api = `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/phases/http_request_cache_settings/entrypoint`;
  const headers = { Authorization: `Bearer ${token}` };
  const read = await fetchImpl(api, { headers });
  if (read.status === 404) return installRules(api, headers, [], fetchImpl);

  const body = await read.json();
  if (read.status !== 200) {
    throw new Error(
      `Cloudflare cache ruleset read returned HTTP ${read.status}\n${JSON.stringify(body, null, 2)}`,
    );
  }
  if (!body.success) {
    throw new Error(
      `Cloudflare cache ruleset read was not successful\n${JSON.stringify(body, null, 2)}`,
    );
  }

  const rules = body.result?.rules || [];
  const desiredRules = managedCacheRules();
  const managedDescriptions = new Set(desiredRules.map((rule) => rule.description));
  const managed = rules.filter((rule) => managedDescriptions.has(rule.description));
  if (
    desiredRules.every((desired) => managed.some((rule) => matchesDesiredRule(rule, desired))) &&
    managed.length === desiredRules.length
  ) {
    return "exists";
  }
  return installRules(api, headers, rules, fetchImpl);
}

async function installRules(api, headers, rules, fetchImpl) {
  const managedDescriptions = new Set(managedCacheRules().map((rule) => rule.description));
  const merged = [
    ...rules.filter((rule) => !managedDescriptions.has(rule.description)),
    ...managedCacheRules(),
  ];
  const response = await fetchImpl(api, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ rules: merged }),
  });
  const body = await response.json();
  if (!body.success) {
    throw new Error(
      `unexpected response installing zone cache rules:\n${JSON.stringify(body, null, 2)}`,
    );
  }
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
        ? "::notice::CLOUDFLARE_ZONE_ID not set; skipping zone cache rules\n"
        : `zone cache rules ${result}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
