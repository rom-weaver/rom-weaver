import type { Localizer } from "../presentation/localization/index.ts";
import type { MessageId } from "../presentation/localization/catalog.ts";
import { getSettingsLabel } from "../presentation/settings.ts";
import { createLogger } from "../lib/logging.ts";
import type { WorkflowTab } from "./components/shell.tsx";
import { searchDocs } from "./docs-search.mjs";
import { SETTINGS_FIELD_METADATA, SETTINGS_PANEL_SECTIONS } from "./settings/settings-metadata.ts";

const logger = createLogger("find-index");

type FindKind = "tool" | "app" | "setting" | "guide";

type FindAction =
  | { type: "view"; view: string }
  | { type: "settings"; fieldId?: string }
  | { type: "status" }
  | { type: "storage" }
  | { type: "logs" }
  | { type: "changelog" }
  | { type: "external"; href: string };

/**
 * One destination Find can reach. `href` is set where the destination is a
 * real URL (tools and guides) so a modified click still opens it normally;
 * `action` is what the palette dispatches for a plain activation.
 */
type FindEntry = {
  action: FindAction;
  /** Short context shown beside the label: a settings section, a guide's title. */
  hint: string;
  href?: string;
  id: string;
  keywords: string;
  kind: FindKind;
  label: string;
};

type FindResult = { entry: FindEntry; score: number };

type FindIndex = {
  /** Shown before the visitor types: every tool, then the app's own surfaces. */
  browse: readonly FindEntry[];
  /** The static entries: tools, settings, app surfaces, project links. */
  entries: readonly FindEntry[];
  /** Guide routes with their prebuilt text, in the shape searchDocs reads. */
  guides: readonly GuideRoute[];
};

type GuideRoute = Parameters<typeof searchDocs>[0][number];

type FindSources = {
  baseHref?: string;
  donateHref?: string;
  githubHref?: string;
  localizer: Localizer;
  tabs: readonly WorkflowTab[];
};

const KIND_ORDER: Record<FindKind, number> = { tool: 0, app: 1, setting: 1, guide: 2 };
const KIND_LIMIT: Record<FindKind, number> = { tool: 4, app: 4, setting: 4, guide: 5 };

// These terms mirror the browser workflows and the CLI spellings. Keep a CLI-
// only command on its guide instead of sending it to a similar browser tool.
const TOOL_FIND_DETAILS: Record<string, { hint: MessageId; keywords: string }> = {
  creator: {
    hint: "ui.hero.createDescription",
    keywords: "create patch patch create make build xdelta xdelta3 vcdiff bdf bsdiff bsdiff40",
  },
  identify: { hint: "ui.hero.identifyDescription", keywords: "identify ROM checksum hash" },
  patcher: {
    hint: "ui.hero.applyDescription",
    keywords: "apply patch apply weave xdelta xdelta3 vcdiff bdf bsdiff bsdiff40",
  },
  bundle: { hint: "ui.find.bundleHint", keywords: "bundle bundle apply saved patch sequence" },
  test: { hint: "ui.hero.testDescription", keywords: "test ROM play emulator" },
  trim: { hint: "ui.hero.trimDescription", keywords: "trim ROM padding" },
};

type CliGuide = { command: string; hint: MessageId; href: string; keywords: string };

const CLI_GUIDES: readonly CliGuide[] = [
  {
    command: "probe / inspect",
    hint: "ui.find.cliIdentifyAndHashHint",
    href: "/docs/identify-and-hash-files",
    keywords: "CLI probe inspect file format platform header",
  },
  {
    command: "checksum",
    hint: "ui.find.cliIdentifyAndHashHint",
    href: "/docs/identify-and-hash-files",
    keywords: "CLI checksum hash algorithm",
  },
  {
    command: "extract",
    hint: "ui.find.cliArchiveHint",
    href: "/docs/work-with-archives",
    keywords: "CLI extract unpack archive",
  },
  {
    command: "compress",
    hint: "ui.find.cliArchiveHint",
    href: "/docs/work-with-archives",
    keywords: "CLI compress pack archive CHD RVZ ZIP 7z",
  },
  { command: "setup", hint: "ui.find.cliSetupHint", href: "/docs/install", keywords: "CLI setup install database" },
  {
    command: "patch validate",
    hint: "ui.find.cliPatchHint",
    href: "/docs/cli-apply",
    keywords: "CLI patch validate check",
  },
  {
    command: "bundle parse",
    hint: "ui.find.cliPatchHint",
    href: "/docs/cli-bundles",
    keywords: "CLI bundle parse",
  },
  {
    command: "trim --untrim / --restore",
    hint: "ui.find.cliTrimRevertHint",
    href: "/docs/cli-trim",
    keywords: "CLI trim untrim restore revert padding",
  },
  {
    command: "command reference",
    hint: "ui.find.cliReferenceHint",
    href: "/docs/cli",
    keywords: "CLI ingest tools plan-extract-batch completions man formats",
  },
];

const createStaticEntries = ({ baseHref, donateHref, githubHref, localizer, tabs }: FindSources): FindEntry[] => {
  const message = (id: MessageId) => localizer.message(id);
  const appBase = new URL(baseHref || "/", "https://rom-weaver.invalid/");
  const appHref = (path: string) => new URL(path.replace(/^\//, ""), appBase).pathname;
  const tools: FindEntry[] = tabs.map((tab) => {
    const details = TOOL_FIND_DETAILS[tab.id];
    return {
      action: { type: "view", view: tab.id },
      hint: details ? message(details.hint) : tab.beta ? message("ui.tools.beta") : "",
      href: tab.href,
      id: `tool:${tab.id}`,
      keywords: `${tab.label} ${tab.id} ${tab.href} ${details?.keywords ?? ""}`,
      kind: "tool",
      label: tab.id === "bundle" ? message("ui.find.bundlesApplyPatch") : tab.label,
    };
  });
  const cliGuides: FindEntry[] = CLI_GUIDES.map(({ command, hint, href, keywords }) => {
    const destination = appHref(href);
    return {
      action: { type: "view", view: "docs" },
      hint: message(hint),
      href: destination,
      id: `guide:cli-${command.replaceAll(" ", "-").replaceAll("/", "")}`,
      keywords,
      kind: "guide",
      label: `rom-weaver ${command}`,
    };
  });
  const app: FindEntry[] = [
    {
      action: { type: "settings" },
      hint: "",
      id: "app:settings",
      keywords: "settings preferences options",
      kind: "app",
      label: message("ui.settings.title"),
    },
    {
      action: { type: "status" },
      hint: message("ui.log.dialogLabel"),
      id: "app:status",
      keywords: "status offline install cache service worker version build environment threads",
      kind: "app",
      label: message("ui.log.tabStatus"),
    },
    {
      action: { type: "storage" },
      hint: message("ui.log.dialogLabel"),
      id: "app:storage",
      keywords: "storage disk space cached files saves opfs quota",
      kind: "app",
      label: message("ui.log.tabStorage"),
    },
    {
      action: { type: "logs" },
      hint: message("ui.log.dialogLabel"),
      id: "app:logs",
      keywords: "logs trace debug console errors",
      kind: "app",
      label: message("ui.log.tabLogs"),
    },
    {
      action: { type: "changelog" },
      hint: message("ui.tools.project"),
      id: "app:changelog",
      keywords: "changelog release notes version whats new update",
      kind: "app",
      label: message("ui.update.whatsNew"),
    },
  ];
  if (githubHref)
    app.push({
      action: { type: "external", href: githubHref },
      hint: message("ui.tools.project"),
      href: githubHref,
      id: "app:github",
      keywords: "github source code repository issues",
      kind: "app",
      label: message("ui.tools.github"),
    });
  if (donateHref)
    app.push({
      action: { type: "external", href: donateHref },
      hint: message("ui.tools.project"),
      href: donateHref,
      id: "app:donate",
      keywords: "support donate sponsor",
      kind: "app",
      label: message("ui.footer.donate"),
    });
  const settings: FindEntry[] = SETTINGS_PANEL_SECTIONS.flatMap((section) =>
    section.fields.map((key) => ({
      action: { type: "settings" as const, fieldId: SETTINGS_FIELD_METADATA[key].id },
      hint: `${message("ui.settings.title")} · ${section.title}`,
      id: `setting:${key}`,
      keywords: `${getSettingsLabel(key, localizer)} ${key} ${section.title}`,
      kind: "setting" as const,
      label: getSettingsLabel(key, localizer),
    })),
  );
  return [...tools, ...app, ...settings, ...cliGuides];
};

/** Static entries as pseudo-routes, so one scorer ranks tools, settings and guides alike. */
const toRoute = (entry: FindEntry): GuideRoute => ({
  description: entry.hint,
  label: entry.kind,
  searchEntries: [{ id: null, label: entry.label, text: entry.keywords }],
  sections: [],
  slug: entry.id,
  title: entry.label,
});

let guidesPromise: Promise<readonly GuideRoute[]> | null = null;

/** The guide metadata and its prebuilt text are two lazy chunks; both load on the first search. */
const loadGuideRoutes = (): Promise<readonly GuideRoute[]> => {
  guidesPromise ??= Promise.all([import("virtual:rom-weaver-docs"), import("virtual:rom-weaver-docs-search")]).then(
    ([{ DOC_ROUTES }, { SEARCH_ENTRIES }]) =>
      DOC_ROUTES.map((route) => ({ ...route, searchEntries: SEARCH_ENTRIES[route.slug] ?? [] })),
    (error) => {
      guidesPromise = null;
      logger.warn("Find guide index failed to load", {
        message: error instanceof Error ? error.message : String(error || ""),
      });
      return [];
    },
  );
  return guidesPromise;
};

const createFindIndex = (sources: FindSources, guides: readonly GuideRoute[] = []): FindIndex => {
  const entries = createStaticEntries(sources);
  const browse = entries.filter((entry) => entry.kind === "tool" || entry.kind === "app");
  return { browse, entries, guides };
};

const guideResult = (match: ReturnType<typeof searchDocs>[number], query: string): FindResult => {
  const highlight = new URLSearchParams({ highlight: query.trim() });
  const anchor = match.entry.id ? `#${match.entry.id}` : "";
  return {
    entry: {
      action: { type: "view", view: "docs" },
      hint: match.route.title,
      href: `/${match.route.slug}?${highlight}${anchor}`,
      id: `guide:${match.route.slug}${anchor}`,
      keywords: "",
      kind: "guide",
      label: match.entry.label,
    },
    score: match.score,
  };
};

/**
 * Rank by kind first - tools, then the app's own surfaces and settings, then
 * guides - and by score inside each kind, capped per kind so a common word
 * in forty guides cannot bury the one tool that matches.
 */
const searchFind = (index: FindIndex, query: string): FindResult[] => {
  if (!query.trim()) return index.browse.map((entry) => ({ entry, score: 1 }));
  const byId = new Map(index.entries.map((entry) => [entry.id, entry]));
  const staticMatches = searchDocs(index.entries.map(toRoute), query, 32).flatMap((match) => {
    const entry = byId.get(match.route.slug);
    return entry ? [{ entry, score: match.score }] : [];
  });
  const guideMatches = searchDocs(index.guides, query, KIND_LIMIT.guide).map((match) => guideResult(match, query));
  const counts: Record<FindKind, number> = { app: 0, guide: 0, setting: 0, tool: 0 };
  return [...staticMatches, ...guideMatches]
    .sort((left, right) => KIND_ORDER[left.entry.kind] - KIND_ORDER[right.entry.kind] || right.score - left.score)
    .filter((result) => {
      const kind = result.entry.kind === "setting" ? "app" : result.entry.kind;
      counts[kind] += 1;
      return counts[kind] <= KIND_LIMIT[kind];
    });
};

export type { FindAction, FindEntry, FindIndex, FindKind, FindResult, FindSources };
export { createFindIndex, loadGuideRoutes, searchFind };
