import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(resolve(process.cwd(), "packages/rom-weaver-webapp/package.json"));
const { parseSync } = require("oxc-parser");
const permitted = {
  "rom-weaver-core": [],
  "rom-weaver-checksum": ["rom-weaver-core"],
  "rom-weaver-patches": ["rom-weaver-core", "rom-weaver-checksum"],
  "rom-weaver-containers": ["rom-weaver-core", "rom-weaver-checksum"],
  "rom-weaver-cli": [
    "rom-weaver-core",
    "rom-weaver-checksum",
    "rom-weaver-patches",
    "rom-weaver-containers",
  ],
};
export function dependencyViolations(metadata) {
  const members = metadata.packages.filter((p) => metadata.workspace_members.includes(p.id));
  const names = new Set(members.map((p) => p.name));
  return members.flatMap((p) => {
    if (!permitted[p.name])
      return [
        `Unclassified workspace package ${p.name}; declare its architecture before adding it.`,
      ];
    return p.dependencies
      .filter((d) => names.has(d.name) && !permitted[p.name].includes(d.name))
      .map(
        (d) =>
          `${p.name} -> ${d.name} (${d.kind ?? "normal"} dependency) violates dependency direction`,
      );
  });
}
const rootOwners = new Map([
  ["storage/browser/browser-large-file-vfs.ts", "Storage facade owns async root access."],
  ["webapp/browser-runtime-diagnostics.ts", "Capability probe only; no synchronous handles."],
  ["workers/protocol/opfs-path.ts", "Shared storage path abstraction."],
  ...[
    "browser-opfs-runner",
    "browser-opfs-wasi-thread-runtime",
    "browser-thread-sweep",
    "browser-archive-stress",
    "browser-format-matrix",
  ].map((name) => [`wasm/${name}.ts`, "Worker runtime or explicitly invoked diagnostic harness."]),
  ["wasm/workers/browser-opfs-proxy-worker.ts", "Dedicated proxy worker owns storage."],
  ["workers/storage/browser-opfs-staging.worker.ts", "Dedicated staging worker owns storage."],
]);
const syncOwners = new Set([
  "wasm/browser-opfs-sync-access.ts",
  "workers/storage/browser-opfs-staging.worker.ts",
]);
// Existing presentation subsets and browser-enriched values MUST remain scoped to these names.
// They are not wire protocol definitions; migrating them requires consumer changes.
const presentationTypes = new Map([
  [
    "lib/cheats/model.ts",
    ["CheatRecord", "CheatWrite", "CheatResolution", "ClassifiedCheatRecord"],
  ],
  ["platform/browser/workflow-runtime-helpers.ts", ["ExtractedFileEntry"]],
  ["public/react/patch-input-basis.ts", ["PatchInputBasis"]],
  ["types/weave.ts", ["WeaveSourceKind"]],
  ["types/identify.ts", ["IdentifyStatus"]],
  ["types/ingest.ts", ["IngestKind"]],
  ["types/logging.ts", ["LogLevel"]],
  ["types/runtime.ts", ["JsonValue", "ProgressEvent"]],
  ["types/workflow-runtime-types.ts", ["JsonValue", "ProgressEvent"]],
]);
const blockingOwners = new Map([
  ["wasm/browser-wasi-thread-protocol.ts", "Bounded synchronous worker coordination."],
  ["wasm/workers/runner-worker-core.ts", "Dedicated runner waits for selection response."],
  ["wasm/workers/browser-wasi-thread-worker.ts", "Dedicated WASI thread startup coordination."],
]);
const fileReaderOwners = new Map([
  ["wasm/browser-opfs-io-adapters.ts", "Dedicated worker Blob-to-WASI synchronous adapter."],
  ["wasm/browser-opfs-virtual-files.ts", "Dedicated worker virtual-Blob capability validation."],
]);
export function browserViolations(path, source, generatedNames = new Set()) {
  const violations = [];
  const parsed = parseSync(path, source);
  if (parsed.errors.length) return [`${path}: parser failed: ${parsed.errors[0].message}`];
  const tree = parsed.program;
  const add = (node, detail) =>
    violations.push(`${path}:${source.slice(0, node.start).split("\n").length}: ${detail}`);
  const atomicsNames = new Set(["Atomics"]);
  const readers = new Set(["FileReaderSync"]);
  const blockingAliases = new Set();
  const discover = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator") {
      if (node.id.type === "Identifier" && node.init?.type === "Identifier") {
        if (atomicsNames.has(node.init.name)) atomicsNames.add(node.id.name);
        if (readers.has(node.init.name)) readers.add(node.id.name);
      }
      if (
        node.id.type === "ObjectPattern" &&
        node.init?.type === "Identifier" &&
        atomicsNames.has(node.init.name)
      ) {
        for (const property of node.id.properties)
          if ((property.key?.name ?? property.key?.value) === "wait" && property.value?.name)
            blockingAliases.add(property.value.name);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(discover);
      else if (value && typeof value === "object") discover(value);
    }
  };
  discover(tree);
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "MemberExpression") {
      const name = node.computed ? node.property.value : node.property.name;
      if (
        name === "wait" &&
        (atomicsNames.has(node.object.name) ||
          (node.object.type === "MemberExpression" &&
            (node.object.property.name ?? node.object.property.value) === "Atomics")) &&
        !blockingOwners.has(path)
      )
        add(
          node,
          "Blocking Atomics.wait belongs to approved dedicated worker coordination modules.",
        );
      if (name === "FileReaderSync" && !fileReaderOwners.has(path))
        add(node, "FileReaderSync belongs to approved dedicated worker Blob adapters.");
      if (name === "createSyncAccessHandle" && !syncOwners.has(path))
        add(node, "Synchronous OPFS handles belong to approved worker handle owners.");
      if (name === "getDirectory" && !rootOwners.has(path))
        add(node, "OPFS root access bypasses the approved storage owners.");
    }
    if (
      ["NewExpression", "CallExpression"].includes(node.type) &&
      readers.has(node.callee.name) &&
      !fileReaderOwners.has(path)
    )
      add(node, "FileReaderSync belongs to approved dedicated worker Blob adapters.");
    if (
      node.type === "CallExpression" &&
      blockingAliases.has(node.callee.name) &&
      !blockingOwners.has(path)
    )
      add(node, "Aliased blocking Atomics.wait belongs to approved worker coordination modules.");
    if (
      ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration"].includes(
        node.type,
      ) &&
      generatedNames.has(node.id.name) &&
      !path.startsWith("wasm/generated/") &&
      !presentationTypes.get(path)?.includes(node.id.name)
    )
      add(node, `Generated protocol type ${node.id.name} must not be redeclared.`);
    if (
      node.type === "NewExpression" &&
      node.callee.name === "URL" &&
      node.arguments?.some(
        (arg) => typeof arg.value === "string" && arg.value.endsWith(".worker.ts"),
      )
    )
      add(node, "Worker entrypoints MUST use ?worker&url imports.");
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(tree);
  return violations;
}
function walkSyntax(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walkSyntax(child, visit));
    else if (value && typeof value === "object") walkSyntax(value, visit);
  }
}

export function mainThreadViolations(modules, roots) {
  const protectedModules = new Set([
    ...syncOwners,
    ...blockingOwners.keys(),
    ...fileReaderOwners.keys(),
    "wasm/rom-weaver-browser-opfs-api.ts",
    "wasm/browser-opfs-runner.ts",
    "wasm/browser-opfs-wasi-thread-runtime.ts",
    "wasm/browser-opfs-proxy-server.ts",
    "wasm/workers/browser-opfs-proxy-worker.ts",
  ]);
  const violations = [];
  const visited = new Set();
  const pending = roots.map((root) => ({ path: root, chain: [root] }));
  while (pending.length) {
    const { path, chain } = pending.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    if (protectedModules.has(path) || path.endsWith(".worker.ts")) {
      violations.push(`Main-thread import reaches worker-only module: ${chain.join(" -> ")}`);
      continue;
    }
    if (!modules.has(path)) {
      violations.push(`Main-thread entry/module not selected: ${path}`);
      continue;
    }
    const parsed = parseSync(path, modules.get(path));
    if (parsed.errors.length) {
      violations.push(`${path}: import graph parser failed: ${parsed.errors[0].message}`);
      continue;
    }
    const addImport = (specifier) => {
      if (typeof specifier !== "string") {
        violations.push(`${path}: nonliteral dynamic import cannot establish thread ownership.`);
        return;
      }
      const [bare, query = ""] = specifier.split("?");
      const params = new URLSearchParams(query);
      // Worker/url/raw imports yield an asset or constructor; their code executes outside this graph.
      if (
        params.has("worker") ||
        params.has("sharedworker") ||
        params.has("url") ||
        params.has("raw")
      )
        return;
      if (/^(?:@\/|~\/|#|src\/|\/src\/)/.test(bare)) {
        violations.push(`${path}: forbidden local path alias ${specifier}; use relative imports.`);
        return;
      }
      if (!bare.startsWith(".")) return;
      const target = posix.normalize(posix.join(posix.dirname(path), bare));
      if (/\.(?:css|json|svg|png|webp|wasm|po)$/.test(target)) return;
      const candidates = [
        target,
        ...[".ts", ".tsx", ".js", ".mjs"].map((extension) => target + extension),
        ...["index.ts", "index.tsx", "index.js"].map((name) => target + "/" + name),
      ];
      const found = candidates.find((candidate) => modules.has(candidate));
      if (!found) {
        violations.push(
          `${path}: unresolved local runtime import ${specifier}; graph cannot claim complete selection.`,
        );
        return;
      }
      pending.push({ path: found, chain: [...chain, found] });
    };
    walkSyntax(parsed.program, (node) => {
      if (node.type === "ImportDeclaration") {
        if (
          node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every((item) => item.importKind === "type"))
        )
          return;
        addImport(node.source.value);
      }
      if (["ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
        if (
          node.exportKind === "type" ||
          (node.specifiers?.length > 0 &&
            node.specifiers.every((item) => item.exportKind === "type"))
        )
          return;
        addImport(node.source.value);
      }
      if (node.type === "ImportExpression") addImport(node.source.value);
      // new URL(..., import.meta.url) is an asset reference, never a runtime import.
    });
  }
  return { checkedMainThreadModules: visited.size, violations };
}

export function rustErrorViolations(path, source) {
  if (path === "crates/rom-weaver-core/src/error.rs" || /\/src\/(?:nod|xdvdfs)\//.test(path))
    return [];
  // Deriving/implementing Error identifies error domains without rejecting state enums named Error.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const aliases = [...stripped.matchAll(/use\s+(?:std|core)::error::Error\s+as\s+(\w+)\s*;/g)].map(
    (match) => match[1],
  );
  const aliasedImpl = aliases.some((alias) => new RegExp(`impl\\s+${alias}\\s+for`).test(stripped));
  return aliasedImpl ||
    /#\[derive\([^\]]*(?:\bError\b)[^\]]*\)\](?:\s*#\[[^\]]*\])*\s*(?:pub(?:\([^)]*\))?\s+)?(?:enum|struct)\s+\w+|impl\s+(?:(?:std::error::|core::error::)Error|Error)\s+for/.test(
      stripped,
    )
    ? [`${path}: competing domain error implementation; use RomWeaverError`]
    : [];
}
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(`${root}/${entry.name}`) : [`${root}/${entry.name}`],
  );
}
export function checkArchitecture(cwd = process.cwd()) {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], {
      cwd,
      encoding: "utf8",
    }),
  );
  const violations = dependencyViolations(metadata);
  const prefix = "packages/rom-weaver-webapp/src/";
  const sources = files(resolve(cwd, prefix)).filter((path) => /\.[cm]?[jt]sx?$/.test(path));
  const modules = new Map(
    sources
      .filter((path) => !path.endsWith(".d.ts"))
      .map((path) => [path.slice(resolve(cwd, prefix).length + 1), readFileSync(path, "utf8")]),
  );
  const html = readFileSync(resolve(cwd, "packages/rom-weaver-webapp/index.html"), "utf8");
  const roots = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["'](?:\.\/|\/)?src\/([^"']+)["'][^>]*>/g),
  ].map((match) => match[1]);
  if (!roots.length) violations.push("No browser document entry selected from index.html.");
  const mainGraph = mainThreadViolations(modules, roots);
  violations.push(...mainGraph.violations);
  const names = new Set();
  for (const path of sources.filter((p) => p.includes("/wasm/generated/"))) {
    const tree = parseSync(path, readFileSync(path, "utf8")).program;
    tree.body.forEach((statement) => {
      const node = statement.declaration ?? statement;
      if (
        ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration"].includes(
          node.type,
        )
      )
        names.add(node.id.name);
    });
  }
  for (const path of sources)
    violations.push(
      ...browserViolations(
        path.slice(resolve(cwd, prefix).length + 1),
        readFileSync(path, "utf8"),
        names,
      ),
    );
  for (const path of files(resolve(cwd, "crates")).filter((p) => /\/src\/.*\.rs$/.test(p)))
    violations.push(...rustErrorViolations(path.slice(cwd.length + 1), readFileSync(path, "utf8")));
  return {
    checkedPackages: metadata.workspace_members.length,
    checkedBrowserModules: sources.length,
    checkedMainThreadModules: mainGraph.checkedMainThreadModules,
    violations,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkArchitecture();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.violations.length ? 1 : 0;
}
