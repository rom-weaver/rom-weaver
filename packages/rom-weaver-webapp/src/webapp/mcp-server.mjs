import packageInfo from "../../package.json" with { type: "json" };
import { ROM_WEAVER_FORMAT_METADATA } from "../wasm/generated/rom-weaver-format-metadata.ts";
import { DOC_SOURCES } from "./docs-routing.mjs";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const serverInfo = { name: "com.rom-weaver/public", version: packageInfo.version };
const capabilities = { tools: {}, resources: {} };
const tools = [
  {
    name: "search_docs",
    description: "Search rom-weaver documentation titles and return public documentation URLs.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 500 } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_supported_formats",
    description: "Retrieve supported ROM container, compression, archive, and patch format metadata.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
const resources = [
  { uri: "rom-weaver://docs", name: "Documentation index", mimeType: "application/json" },
  { uri: "rom-weaver://formats", name: "Supported formats", mimeType: "application/json" },
];
const docs = DOC_SOURCES.map(({ slug, label }) => ({ title: label, url: `https://rom-weaver.com/${slug}` }));

/** @param {string} origin @param {boolean} [legacy] */
export const createServerCard = (origin, legacy = false) => {
  const endpoint = new URL("/mcp", origin).href;
  const card = {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    ...serverInfo,
    description: "Public rom-weaver documentation search and supported format metadata. ROM files stay local.",
    websiteUrl: "https://rom-weaver.com",
    remotes: [{ type: "streamable-http", url: endpoint, supportedProtocolVersions: PROTOCOL_VERSIONS }],
  };
  if (!legacy) return card;
  // The scanner's older card shape MUST remain available alongside current SEP-2127 discovery.
  const compatibilityCard = { ...card, $schema: undefined };
  return { ...compatibilityCard, serverInfo, capabilities, transport: { type: "streamable-http", endpoint } };
};

/** @param {Request} request @param {"catalog" | "card" | "legacy"} kind */
export const discoveryResponse = (request, kind) => {
  const { origin } = new URL(request.url);
  const isCatalog = kind === "catalog";
  const body = isCatalog
    ? {
        specVersion: "1.0",
        entries: [
          {
            identifier: "urn:air:rom-weaver.com:mcp:public",
            type: "application/mcp-server-card+json",
            url: `${origin}/mcp/server-card`,
          },
        ],
      }
    : createServerCard(origin, kind === "legacy");
  return Response.json(body, {
    headers: {
      "Content-Type": isCatalog ? "application/ai-catalog+json" : "application/mcp-server-card+json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Cache-Control": "public, max-age=3600",
    },
  });
};

/** @param {string | number | null} id @param {number} code @param {string} message @param {number} [status] */
const rpcError = (id, code, message, status = 200) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
/** @param {unknown} value */
const textContent = (value) => [{ type: "text", text: JSON.stringify(value) }];

/** @param {Request} request */
export async function handleMcpRequest(request) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return new Response("Invalid Origin", { status: 403 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const version = request.headers.get("MCP-Protocol-Version");
  if (version && !PROTOCOL_VERSIONS.includes(version))
    return new Response("Unsupported protocol version", { status: 400 });
  const acceptedTypes = (request.headers.get("Accept") ?? "").split(",").flatMap((entry) => {
    const [type = "", ...parameters] = entry.trim().toLowerCase().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const weight = quality === undefined ? 1 : Number(quality.trim().slice(2));
    return Number.isFinite(weight) && weight > 0 && weight <= 1 ? [type.trim()] : [];
  });
  if (!(acceptedTypes.includes("application/json") && acceptedTypes.includes("text/event-stream"))) {
    return new Response("Accept application/json and text/event-stream", { status: 406 });
  }
  if (((request.headers.get("Content-Type") ?? "").split(";")[0] ?? "").trim().toLowerCase() !== "application/json")
    return new Response("Expected application/json", { status: 415 });
  let message;
  try {
    const reader = request.body?.getReader();
    if (!reader) return rpcError(null, -32700, "Missing request body", 400);
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16384) {
          await reader.cancel();
          return new Response("Request too large", { status: 413 });
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    message = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(null, -32600, "Invalid request", 400);
  }
  if (!("id" in message)) {
    if (message.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    return rpcError(null, -32600, "Expected a request id", 400);
  }
  const { id, method, params } = message;
  if (typeof id !== "string" && typeof id !== "number") return rpcError(null, -32600, "Invalid request id", 400);
  let result;
  switch (method) {
    case "initialize":
      if (
        !params ||
        typeof params.protocolVersion !== "string" ||
        typeof params.capabilities !== "object" ||
        params.capabilities === null ||
        Array.isArray(params.capabilities) ||
        typeof params.clientInfo?.name !== "string" ||
        typeof params.clientInfo?.version !== "string"
      ) {
        return rpcError(id, -32602, "Expected protocolVersion, capabilities, and clientInfo with name and version");
      }
      result = {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        serverInfo,
        capabilities,
        instructions:
          "ROM operations run locally through browser WebMCP tools. This endpoint provides public reference data.",
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools };
      break;
    case "resources/list":
      result = { resources };
      break;
    case "resources/read": {
      const resource = resources.find(({ uri }) => uri === params?.uri);
      if (!resource) return rpcError(id, -32602, "Unknown resource URI");
      result = {
        contents: [
          {
            ...resource,
            text: JSON.stringify(resource.uri === "rom-weaver://docs" ? docs : ROM_WEAVER_FORMAT_METADATA),
          },
        ],
      };
      break;
    }
    case "tools/call": {
      const args = params?.arguments === undefined ? {} : params.arguments;
      if (typeof args !== "object" || args === null || Array.isArray(args))
        return rpcError(id, -32602, "Invalid tool arguments");
      if (params?.name === "get_supported_formats") {
        if (Object.keys(args).length) return rpcError(id, -32602, "This tool takes no arguments");
        result = { content: textContent(ROM_WEAVER_FORMAT_METADATA) };
      } else if (params?.name === "search_docs") {
        if (
          typeof args.query !== "string" ||
          args.query.length > 500 ||
          Object.keys(args).some((key) => key !== "query")
        )
          return rpcError(id, -32602, "Expected a query string of at most 500 characters");
        const query = args.query.trim().toLowerCase();
        result = { content: textContent(docs.filter(({ title }) => title.toLowerCase().includes(query)).slice(0, 20)) };
      } else return rpcError(id, -32602, "Unknown tool");
      break;
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: { "Cache-Control": "no-store" } });
}
